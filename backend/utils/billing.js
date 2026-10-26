import Stripe from 'stripe';
import { administrativeTransaction } from '../db.js';
import { failure } from './categorization.js';
import { sendSecurityNotice, mailConfigured } from './mailer.js';
import { structuredLog } from './audit.js';

export const PRICES = Object.freeze({ basic: 999, pro: 1499 });
export const BILLING_TRIAL_DAYS = 15;
let testStripe;
let cached;
export function setStripeForTests(value) { testStripe = value; }
export function stripeClient() {
  if (testStripe) return testStripe;
  if (!process.env.STRIPE_SECRET_KEY) throw failure(503, 'Stripe billing is not configured. Contact the administrator.');
  cached ||= new Stripe(process.env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20000 });
  return cached;
}
export function billingConfigured() {
  return Boolean((testStripe || process.env.STRIPE_SECRET_KEY) && process.env.STRIPE_BASIC_PRICE_ID
    && process.env.STRIPE_PRO_PRICE_ID && process.env.STRIPE_WEBHOOK_SECRET && mailConfigured());
}
const priceId = plan => process.env[plan === 'basic' ? 'STRIPE_BASIC_PRICE_ID' : 'STRIPE_PRO_PRICE_ID'];
const timestamp = seconds => seconds ? new Date(seconds * 1000).toISOString() : null;
const objectId = value => typeof value === 'string' ? value : value?.id;
const downgradeTag = 'myfinance_basic_at_renewal';
const periodEnd = subscription => subscription.status === 'trialing' ? subscription.trial_end
  : subscription.current_period_end || subscription.items.data[0]?.current_period_end;
const ownsSchedule = (schedule, subscription) => schedule.metadata?.myfinance_change === downgradeTag
  && schedule.metadata?.subscription_id === subscription.id;
const phaseDiscounts = discounts => discounts.map(value => value.discount
  ? { discount: objectId(value.discount) } : value.promotion_code
    ? { promotion_code: objectId(value.promotion_code) } : { coupon: objectId(value.coupon) });

async function subscriptionSchedule(stripe, subscription) {
  return subscription.schedule ? stripe.subscriptionSchedules.retrieve(objectId(subscription.schedule)) : null;
}
function pendingChange(schedule, subscription) {
  if (!schedule || !ownsSchedule(schedule, subscription) || schedule.status !== 'active' || !schedule.current_phase) return null;
  const phase = schedule.phases.find(phase => phase.start_date > schedule.current_phase.start_date
    && phase.items.length === 1 && objectId(phase.items[0].price) === priceId('basic'));
  return phase ? { plan: 'basic', effective_at: timestamp(phase.start_date) } : null;
}

export async function billingSubscription(household) {
  return administrativeTransaction(async client => {
    const row = (await client.query('SELECT * FROM household_subscriptions WHERE household_id=$1', [household.id])).rows[0];
    if (!row) return null;
    let pending = null, managed = false, renewalEnd = row.current_period_end;
    if (row.stripe_subscription_id && !['canceled', 'incomplete_expired'].includes(row.status)) {
      const stripe = stripeClient();
      const live = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      const schedule = await subscriptionSchedule(stripe, live);
      pending = pendingChange(schedule, live);
      renewalEnd = timestamp(periodEnd(live)) || renewalEnd;
      managed = Boolean(schedule && ['active', 'not_started'].includes(schedule.status)
        && !(ownsSchedule(schedule, live) && !pending && live.items.data[0]?.price.id === priceId('basic')));
    }
    return { status: row.status, plan: row.plan, trial_ends_at: row.trial_ends_at,
      current_period_end: renewalEnd, cancel_at_period_end: row.cancel_at_period_end,
      pending_change: pending, schedule_managed: managed };
  });
}

export async function scheduleDowngrade(household, consent, effectiveAt) {
  if (consent !== true) throw failure(400, 'Confirm Basic at USD 9.99/month starting at your next renewal. Pro continues until then.');
  const stripe = stripeClient();
  return administrativeTransaction(async client => {
    const row = (await client.query('SELECT * FROM household_subscriptions WHERE household_id=$1 FOR UPDATE', [household.id])).rows[0];
    if (!row?.stripe_subscription_id || row.plan !== 'pro' || !['active', 'trialing'].includes(row.status)) {
      throw failure(409, 'An active or trialing Pro subscription is required to schedule Basic.');
    }
    const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    const items = subscription.items.data;
    const end = periodEnd(subscription);
    if (objectId(subscription.customer) !== row.stripe_customer_id || !['active', 'trialing'].includes(subscription.status)
      || subscription.cancel_at_period_end || subscription.cancel_at || subscription.pending_update || subscription.pause_collection
      || items.length !== 1 || items[0].quantity !== 1 || items[0].price.id !== priceId('pro')
      || !end || end <= Math.floor(Date.now() / 1000) || effectiveAt !== timestamp(end)) {
      throw failure(409, 'The subscription or renewal date has changed. Refresh billing before confirming Basic.');
    }
    const basic = await verifiedPrice(stripe, 'basic');
    let schedule = await subscriptionSchedule(stripe, subscription);
    const pending = pendingChange(schedule, subscription);
    if (pending) return { pending_change: pending };
    // Creating from an existing subscription requires a separate API call. A stable
    // key recovers the same schedule if the response or following update was lost.
    const key = `downgrade-${subscription.id}-${end}-${subscription.metadata?.myfinance_released_schedule || 'first'}`;
    if (schedule && !ownsSchedule(schedule, subscription)) {
      try {
        const created = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id }, { idempotencyKey: key });
        if (created.id !== schedule.id) throw failure(409, 'Another Stripe schedule already manages this subscription.');
      } catch (error) {
        if (error.status) throw error;
        throw failure(409, 'Another Stripe schedule already manages this subscription. Resolve it before changing plans.');
      }
    }
    if (!schedule) schedule = await stripe.subscriptionSchedules.create({ from_subscription: subscription.id }, { idempotencyKey: key });
    if (schedule.status !== 'active' || objectId(schedule.subscription) !== subscription.id
      || objectId(schedule.customer) !== row.stripe_customer_id || schedule.phases.length !== 1
      || schedule.current_phase?.end_date !== end) {
      throw failure(409, 'The Stripe schedule has changed. Refresh billing before changing plans.');
    }
    const phase = schedule.phases[0];
    if (phase.items.length !== 1 || objectId(phase.items[0].price) !== priceId('pro') || phase.items[0].quantity !== 1) {
      throw failure(409, 'The current Stripe phase is not a standard Pro subscription.');
    }
    // Preserve migrated phase settings, omitting response-only fields.
    const current = {};
    for (const field of ['start_date', 'end_date', 'application_fee_percent', 'automatic_tax', 'billing_cycle_anchor', 'billing_thresholds',
      'collection_method', 'currency', 'default_payment_method', 'default_tax_rates', 'description', 'discounts',
      'invoice_settings', 'metadata', 'on_behalf_of', 'transfer_data', 'trial_end']) {
      if (phase[field] != null) current[field] = phase[field];
    }
    if (current.default_payment_method) current.default_payment_method = objectId(current.default_payment_method);
    if (current.default_tax_rates) current.default_tax_rates = current.default_tax_rates.map(objectId);
    if (current.discounts) current.discounts = phaseDiscounts(current.discounts);
    current.items = phase.items.map(item => ({ price: objectId(item.price), quantity: item.quantity,
      ...(item.tax_rates?.length ? { tax_rates: item.tax_rates.map(objectId) } : {}),
      ...(item.discounts?.length ? { discounts: phaseDiscounts(item.discounts) } : {}),
      ...(item.billing_thresholds ? { billing_thresholds: item.billing_thresholds } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}) }));
    const updated = await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'release', proration_behavior: 'none',
      metadata: { myfinance_change: downgradeTag, subscription_id: subscription.id,
        household_id: String(household.id), consent: 'basic_usd_999_monthly_next_renewal' },
      phases: [{ ...current, proration_behavior: 'none' },
        { start_date: end, items: [{ price: basic, quantity: 1 }],
          duration: { interval: 'month', interval_count: 1 }, proration_behavior: 'none' }]
    }, { idempotencyKey: `${key}-configure-${schedule.id}` });
    return { pending_change: pendingChange(updated, subscription) };
  });
}

export async function cancelDowngrade(household) {
  const stripe = stripeClient();
  return administrativeTransaction(async client => {
    const row = (await client.query('SELECT * FROM household_subscriptions WHERE household_id=$1 FOR UPDATE', [household.id])).rows[0];
    if (!row?.stripe_subscription_id) throw failure(409, 'No subscription exists.');
    const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    if (objectId(subscription.customer) !== row.stripe_customer_id) throw failure(409, 'The Stripe billing account has changed.');
    const schedule = await subscriptionSchedule(stripe, subscription);
    if (!schedule) return { pending_change: null };
    if (!pendingChange(schedule, subscription) || subscription.items.data[0]?.price.id !== priceId('pro')) {
      throw failure(409, 'This change has already taken effect or is managed elsewhere. Refresh billing.');
    }
    // Retain a retry generation on Stripe before releasing. No price is changed.
    await stripe.subscriptions.update(subscription.id, { metadata: { myfinance_released_schedule: schedule.id } },
      { idempotencyKey: `downgrade-release-marker-${schedule.id}` });
    await stripe.subscriptionSchedules.release(schedule.id, {}, { idempotencyKey: `downgrade-release-${schedule.id}` });
    return { pending_change: null };
  });
}

export async function verifiedPrice(stripe, plan) {
  if (!Object.hasOwn(PRICES, plan)) throw failure(400, 'Choose Basic or Pro.');
  const id = priceId(plan);
  if (!id) throw failure(503, 'The selected Stripe price is not configured.');
  const price = await stripe.prices.retrieve(id);
  if (!price.active || price.currency !== 'usd' || price.unit_amount !== PRICES[plan]
    || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1
    || price.recurring?.usage_type === 'metered') {
    throw failure(503, 'The configured Stripe price does not match the published monthly plan. Contact the administrator.');
  }
  return id;
}

export async function checkout(household, user, plan, consent) {
  if (consent !== true) throw failure(400, 'Acknowledge automatic billing after the trial before continuing.');
  if (!billingConfigured()) throw failure(503, 'Billing and reminder email must be configured before starting a subscription.');
  const stripe = stripeClient();
  const price = await verifiedPrice(stripe, plan);
  return administrativeTransaction(async client => {
    await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [household.id]);
    const existingLicense = (await client.query(`SELECT 1 FROM user_licenses WHERE user_id=$1 AND granted_at IS NOT NULL AND revoked_at IS NULL`,
      [household.owner_user_id])).rows[0];
    if (household.owner_user_id === 1 || existingLicense) throw failure(409, 'Your household already has paid access. Contact support before replacing that access.');
    await client.query('INSERT INTO household_subscriptions(household_id) VALUES($1) ON CONFLICT DO NOTHING', [household.id]);
    let row = (await client.query('SELECT * FROM household_subscriptions WHERE household_id=$1 FOR UPDATE', [household.id])).rows[0];
    if (row.stripe_subscription_id) {
      const live = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      if (!['canceled', 'incomplete_expired'].includes(live.status)) throw failure(409, 'A subscription already exists. Use Manage billing to change or cancel it.');
    }
    if (row.checkout_session_id && new Date(row.checkout_expires_at) > new Date()) {
      const pending = await stripe.checkout.sessions.retrieve(row.checkout_session_id);
      if (pending.status === 'open' && pending.metadata?.plan === plan) return { url: pending.url };
      if (pending.status === 'complete' && (!row.stripe_subscription_id
        || objectId(pending.subscription) !== row.stripe_subscription_id)) {
        throw failure(409, 'Your checkout is processing. Refresh billing shortly; do not start another subscription.');
      }
      if (pending.status === 'open') await stripe.checkout.sessions.expire(pending.id);
    }
    if (!row.stripe_customer_id) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name,
        metadata: { household_id: String(household.id) } }, { idempotencyKey: `household-customer-${household.id}` });
      await client.query('UPDATE household_subscriptions SET stripe_customer_id=$1 WHERE household_id=$2', [customer.id, household.id]);
      row = { ...row, stripe_customer_id: customer.id };
    }
    const legacyTrial = (await client.query('SELECT trial_started_at FROM user_licenses WHERE user_id=$1', [household.owner_user_id])).rows[0]?.trial_started_at;
    const trial = !row.trial_used && !legacyTrial;
    const origin = process.env.APP_ORIGIN;
    if (!origin) throw failure(503, 'The application origin is not configured.');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer: row.stripe_customer_id,
      client_reference_id: String(household.id), line_items: [{ price, quantity: 1 }],
      payment_method_collection: 'always', payment_method_types: ['card'],
      success_url: `${origin}/#settings/billing`, cancel_url: `${origin}/#settings/billing`,
      metadata: { household_id: String(household.id), plan },
      subscription_data: { metadata: { household_id: String(household.id) },
        ...(trial ? { trial_period_days: BILLING_TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : {}) },
      custom_text: { submit: { message: trial
        ? `15 days of Pro, then ${plan === 'basic' ? 'Basic $9.99' : 'Pro $14.99'} USD/month per household automatically unless you cancel before the trial ends. We email the billing owner 24 hours before expiration.`
        : `${plan === 'basic' ? 'Basic $9.99' : 'Pro $14.99'} USD/month per household. Renews automatically until cancelled.` } }
    }, { idempotencyKey: `household-checkout-${household.id}-${plan}-${row.checkout_session_id || 'first'}` });
    await client.query(`UPDATE household_subscriptions SET checkout_session_id=$1,checkout_expires_at=$2,updated_at=NOW()
      WHERE household_id=$3`, [session.id, timestamp(session.expires_at), household.id]);
    return { url: session.url };
  });
}

export async function billingPortal(household, plan) {
  if (plan !== undefined && plan !== 'pro') throw failure(400, 'Only an upgrade to Pro is supported.');
  const stripe = stripeClient();
  return administrativeTransaction(async client => {
    const row = (await client.query('SELECT * FROM household_subscriptions WHERE household_id=$1 FOR UPDATE', [household.id])).rows[0];
    if (!row?.stripe_customer_id) throw failure(409, 'No Stripe billing account exists yet.');
    if (row.stripe_subscription_id) {
      const live = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      if (live.schedule) {
        const schedule = await subscriptionSchedule(stripe, live);
        if (ownsSchedule(schedule, live) && !pendingChange(schedule, live) && live.items.data[0]?.price.id === priceId('basic')) {
          await stripe.subscriptionSchedules.release(schedule.id, {}, { idempotencyKey: `downgrade-complete-release-${schedule.id}` });
        } else throw failure(409, 'A Stripe schedule manages this subscription. Keep Pro to remove the scheduled downgrade before opening billing or cancelling.');
      }
    }
    let update, flow;
    if (plan === 'pro') {
      if (row.plan !== 'basic' || row.status !== 'active' || row.cancel_at_period_end || !row.stripe_subscription_id) {
        throw failure(409, 'An active Basic subscription without scheduled cancellation is required to upgrade.');
      }
      const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      const items = subscription.items.data;
      if (objectId(subscription.customer) !== row.stripe_customer_id || subscription.status !== 'active'
        || subscription.cancel_at_period_end || subscription.cancel_at || subscription.schedule || subscription.pending_update || items.length !== 1
        || items[0].quantity !== 1 || items[0].price.id !== priceId('basic') || !items[0].id) {
        throw failure(409, 'The subscription has changed. Refresh billing before upgrading.');
      }
      const id = await verifiedPrice(stripe, 'pro');
      const product = objectId((await stripe.prices.retrieve(id)).product);
      if (!product) throw failure(503, 'The configured Pro price has no product.');
      update = { enabled: true, default_allowed_updates: ['price'], proration_behavior: 'always_invoice',
        billing_cycle_anchor: 'unchanged', products: [{ product, prices: [id] }] };
      flow = { type: 'subscription_update_confirm',
        subscription_update_confirm: { subscription: subscription.id, items: [{ id: items[0].id, price: id, quantity: 1 }] },
        after_completion: { type: 'redirect', redirect: { return_url: `${process.env.APP_ORIGIN}/#settings/billing` } } };
    }
    // Cancellation is always at period end, including trials; payment details never enter this app.
    const configuration = await stripe.billingPortal.configurations.create({
      business_profile: { headline: 'Manage your MyFinance household subscription' },
      features: { customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
        invoice_history: { enabled: true }, payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: false } },
        ...(update ? { subscription_update: update } : {}) }
    });
    const session = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id,
      configuration: configuration.id, return_url: `${process.env.APP_ORIGIN}/#settings/billing`,
      ...(flow ? { flow_data: flow } : {}) });
    return { url: session.url };
  });
}

export async function syncSubscription(client, stripe, subscriptionId) {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = objectId(subscription.customer);
  const row = (await client.query(`SELECT s.*,h.owner_user_id FROM household_subscriptions s
    JOIN households h ON h.id=s.household_id WHERE s.stripe_customer_id=$1 FOR UPDATE OF s`, [customerId])).rows[0];
  if (!row) return;
  const item = subscription.items.data;
  let plan = item.length === 1 && item[0].quantity === 1
    ? Object.keys(PRICES).find(plan => item[0].price.id === priceId(plan)) : null;
  if (!plan) throw new Error('Unrecognized Stripe subscription price or quantity');
  if (row.plan === 'basic' && ['active', 'past_due', 'unpaid'].includes(row.status)
    && plan === 'pro' && ['active', 'past_due', 'unpaid'].includes(subscription.status)) {
    const invoiceId = objectId(subscription.latest_invoice);
    if (!invoiceId) throw new Error('Stripe upgrade invoice is missing');
    const invoice = await stripe.invoices.retrieve(invoiceId);
    // An active subscription alone is not proof that its upgrade invoice was paid.
    if (invoice.status !== 'paid') plan = 'basic';
  }
  if (row.stripe_subscription_id && row.stripe_subscription_id !== subscription.id) {
    // A retired subscription must not overwrite or block its paid replacement.
    if (['canceled', 'incomplete_expired'].includes(subscription.status)) return;
    const old = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    if (!['canceled', 'incomplete_expired'].includes(old.status)) throw new Error('Multiple live subscriptions detected for one household');
  }
  const trialEnd = timestamp(subscription.trial_end);
  const periodEnd = timestamp(subscription.current_period_end || item[0].current_period_end);
  await client.query(`UPDATE household_subscriptions SET stripe_subscription_id=$1,plan=$2,status=$3,
    trial_started_at=COALESCE(trial_started_at,$4::timestamptz),trial_ends_at=$5,current_period_end=$6,
    cancel_at_period_end=$7,trial_used=(trial_used OR $8),updated_at=NOW() WHERE household_id=$9`,
  [subscription.id, plan, subscription.status, timestamp(subscription.trial_start), trialEnd, periodEnd,
    subscription.cancel_at_period_end === true, !!subscription.trial_start, row.household_id]);
}

export async function handleStripeEvent(event) {
  const stripe = stripeClient();
  return administrativeTransaction(async client => {
    // Serializes webhook processing across instances; fetch current Stripe state, never trust event order.
    await client.query('SELECT pg_advisory_xact_lock(74938125)');
    const duplicate = (await client.query('SELECT id FROM stripe_events WHERE id=$1', [event.id])).rows[0];
    if (duplicate) return;
    let subscriptionId;
    if (event.type.startsWith('customer.subscription.')) subscriptionId = event.data.object.id;
    if (event.type.startsWith('checkout.session.')) subscriptionId = objectId(event.data.object.subscription);
    if (event.type.startsWith('invoice.')) subscriptionId = objectId(event.data.object.subscription
      || event.data.object.parent?.subscription_details?.subscription);
    if (event.type.startsWith('subscription_schedule.')) {
      const schedule = await stripe.subscriptionSchedules.retrieve(event.data.object.id);
      subscriptionId = objectId(schedule.subscription || schedule.released_subscription);
    }
    if (subscriptionId) await syncSubscription(client, stripe, subscriptionId);
    await client.query('INSERT INTO stripe_events(id,event_type) VALUES($1,$2)', [event.id, event.type]);
  });
}

export async function sendDueTrialReminders(now = new Date()) {
  return administrativeTransaction(async client => {
    const due = (await client.query(`SELECT s.*,u.name,u.email FROM household_subscriptions s JOIN households h ON h.id=s.household_id
      JOIN users u ON u.id=h.owner_user_id WHERE s.status='trialing' AND s.reminder_sent_at IS NULL
      AND s.trial_ends_at>$1 AND s.trial_ends_at<=$2 ORDER BY s.trial_ends_at LIMIT 100 FOR UPDATE OF s SKIP LOCKED`,
    [now, new Date(now.getTime() + 86400000)])).rows;
    for (const row of due) {
      let renewalPlan = row.plan;
      if (row.stripe_subscription_id) {
        const stripe = stripeClient();
        const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
        const pending = pendingChange(await subscriptionSchedule(stripe, subscription), subscription);
        if (pending) renewalPlan = pending.plan;
      }
      const sent = await sendSecurityNotice(row, 'Your MyFinance Pro trial ends tomorrow',
        `Hi ${row.name},\n\nYour 15-day Pro trial ends at ${new Date(row.trial_ends_at).toISOString()}.\n`
        + (row.cancel_at_period_end ? 'Your subscription is scheduled to cancel. You will not be charged and access will stop at trial end.'
          : `Your selected ${renewalPlan === 'basic' ? 'Basic ($9.99)' : 'Pro ($14.99)'} plan will automatically bill in USD monthly per household unless you cancel before that time.`)
        + `\nManage or cancel securely from Settings > Billing: ${process.env.APP_ORIGIN}/#settings/billing\n\nNo card numbers are stored in MyFinance.`);
      if (!sent) throw new Error('Trial reminder email is not configured');
      await client.query('UPDATE household_subscriptions SET reminder_sent_at=NOW() WHERE household_id=$1', [row.household_id]);
    }
    return due.length;
  });
}

export function startTrialReminders() {
  const run = () => sendDueTrialReminders().catch(error => structuredLog('error', { event: 'billing.reminder_failed', message: error.message }));
  run();
  return setInterval(run, 60000).unref();
}
