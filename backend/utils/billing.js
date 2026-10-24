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
      if (pending.status === 'complete') throw failure(409, 'Your checkout is processing. Refresh billing shortly; do not start another subscription.');
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

export async function billingPortal(household) {
  const stripe = stripeClient();
  return administrativeTransaction(async client => {
    const row = (await client.query('SELECT * FROM household_subscriptions WHERE household_id=$1', [household.id])).rows[0];
    if (!row?.stripe_customer_id) throw failure(409, 'No Stripe billing account exists yet.');
    // Cancellation is always at period end, including trials; payment details never enter this app.
    const configuration = await stripe.billingPortal.configurations.create({
      business_profile: { headline: 'Manage your MyFinance household subscription' },
      features: { customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
        invoice_history: { enabled: true }, payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: false } } }
    });
    const session = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id,
      configuration: configuration.id, return_url: `${process.env.APP_ORIGIN}/#settings/billing` });
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
  const plan = item.length === 1 && item[0].quantity === 1
    ? Object.keys(PRICES).find(plan => item[0].price.id === priceId(plan)) : null;
  if (!plan) throw new Error('Unrecognized Stripe subscription price or quantity');
  if (row.stripe_subscription_id && row.stripe_subscription_id !== subscription.id) {
    const old = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    if (!['canceled', 'incomplete_expired'].includes(old.status)) throw new Error('Multiple live subscriptions detected for one household');
    // Do not let a late webhook for a retired subscription replace the current subscription.
    if (['canceled', 'incomplete_expired'].includes(subscription.status)) return;
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
      const sent = await sendSecurityNotice(row, 'Your MyFinance Pro trial ends tomorrow',
        `Hi ${row.name},\n\nYour 15-day Pro trial ends at ${new Date(row.trial_ends_at).toISOString()}.\n`
        + (row.cancel_at_period_end ? 'Your subscription is scheduled to cancel. You will not be charged and access will stop at trial end.'
          : `Your selected ${row.plan === 'basic' ? 'Basic ($9.99)' : 'Pro ($14.99)'} plan will automatically bill in USD monthly per household unless you cancel before that time.`)
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
