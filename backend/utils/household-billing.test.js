import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import Stripe from 'stripe';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { setMailTransportForTests } from './mailer.js';
import { setStripeForTests, sendDueTrialReminders, syncSubscription } from './billing.js';

test('late canceled subscription events do not block an active paid replacement', async () => {
  const savedPrice = process.env.STRIPE_PRO_PRICE_ID;
  process.env.STRIPE_PRO_PRICE_ID = 'price_retired_test';
  const queries = [], retrieved = [];
  try {
    await syncSubscription({ query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ household_id: 2, stripe_subscription_id: 'sub_current_active' }] };
    } }, { subscriptions: { retrieve: async id => {
      retrieved.push(id);
      assert.equal(id, 'sub_retired');
      return { id, customer: 'cus_existing', status: 'canceled',
        items: { data: [{ quantity: 1, price: { id: 'price_retired_test' } }] } };
    } } }, 'sub_retired');
    assert.deepEqual(retrieved, ['sub_retired']);
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /SELECT/);
  } finally {
    if (savedPrice === undefined) delete process.env.STRIPE_PRO_PRICE_ID;
    else process.env.STRIPE_PRO_PRICE_ID = savedPrice;
  }
});

test('household migration preserves legacy paid access and protects privileged membership tables', async () => {
  const database = new PGlite();
  const client = { query: (sql, params) => params?.length ? database.query(sql, params) : database.exec(sql) };
  try {
    await database.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE,role TEXT,password_hash TEXT);
      INSERT INTO users(id,name,email,role,password_hash) VALUES(1,'Owner','owner@example.test','admin','existing'),
        (2,'Legacy Pro','pro@example.test','user','existing'),(3,'Legacy Plus','plus@example.test','user','existing');
      CREATE TABLE user_licenses(user_id INTEGER PRIMARY KEY REFERENCES users(id),plan TEXT NOT NULL DEFAULT 'pro',
        trial_started_at TIMESTAMPTZ,trial_ends_at TIMESTAMPTZ,granted_at TIMESTAMPTZ,granted_by INTEGER REFERENCES users(id),
        revoked_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO user_licenses(user_id,plan,granted_at) VALUES(2,'pro',NOW()),(3,'pro_plus',NOW());`);
    await database.exec('BEGIN');
    await migratePrivateSchema(client);
    await database.exec('COMMIT');
    assert.deepEqual((await database.query('SELECT plan FROM user_licenses ORDER BY user_id')).rows, [{ plan: 'pro' }, { plan: 'pro' }]);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM households')).rows[0].count, 3);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM users WHERE email_verified_at IS NOT NULL')).rows[0].count, 3);
    await database.query("UPDATE user_licenses SET plan='basic' WHERE user_id=2");
    await database.exec('BEGIN');
    await migratePrivateSchema(client);
    await database.exec('COMMIT');
    assert.equal((await database.query('SELECT plan FROM user_licenses WHERE user_id=2')).rows[0].plan, 'basic', 'migration is one-time and does not overwrite later plan changes');
    await assert.rejects(database.query("UPDATE household_members SET role='member' WHERE user_id=2"), /owner membership/);
    for (const table of ['households', 'household_members', 'household_invitations', 'household_subscriptions', 'stripe_events', 'email_verification_tokens']) {
      await database.exec('BEGIN; SET LOCAL ROLE finance_app_runtime;');
      await assert.rejects(database.query(`SELECT * FROM ${table}`), /permission denied/);
      await database.exec('ROLLBACK');
    }
  } finally { await database.close(); }
});

test('Stripe trial, household invitations, tenant boundaries, removal and email verification', async t => {
  const database = new PGlite();
  let lock = Promise.resolve();
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    let release;
    const previous = lock;
    lock = new Promise(resolve => { release = resolve; });
    await previous;
    return { async query(sql, params) {
      const results = params?.length ? [await database.query(sql, params)] : await database.exec(sql);
      const result = results.at(-1) || { rows: [] };
      return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    }, release };
  });
  const migration = await pg.Pool.prototype.connect();
  await migration.query('BEGIN');
  await migratePrivateSchema(migration);
  await migration.query('COMMIT');
  migration.release();
  const keys = ['OWNER_SETUP_TOKEN', 'ALLOW_REGISTRATION', 'APP_ORIGIN', 'STRIPE_BASIC_PRICE_ID', 'STRIPE_PRO_PRICE_ID', 'STRIPE_WEBHOOK_SECRET'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { OWNER_SETUP_TOKEN: 'synthetic-household-setup-token-at-least-32-chars', ALLOW_REGISTRATION: 'true',
    STRIPE_BASIC_PRICE_ID: 'price_basic', STRIPE_PRO_PRICE_ID: 'price_pro', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_only' });
  const mail = [], checkoutRequests = [], portalRequests = [], portalSessions = [], scheduleCreates = [], scheduleUpdates = [], scheduleReleases = [];
  setMailTransportForTests({ sendMail: async message => { mail.push(message); return { accepted: [message.to] }; } });
  const seconds = () => Math.floor(Date.now() / 1000);
  let subscription = { id: 'sub_household', customer: 'cus_household', status: 'trialing',
    trial_start: seconds(), trial_end: seconds() + 15 * 86400, current_period_end: seconds() + 15 * 86400,
    cancel_at_period_end: false, items: { data: [{ quantity: 1, price: { id: 'price_basic' } }] } };
  let checkoutSession = null;
  let badPrice = false;
  let invoiceStatus = 'open';
  let schedule = null, loseCreateResponse = false, loseUpdateResponse = false;
  const createdSchedules = new Map();
  const signatures = new Stripe('sk_test_synthetic_only').webhooks;
  setStripeForTests({
    prices: { retrieve: async id => ({ id, product: id === 'price_basic' ? 'prod_basic' : 'prod_pro', active: true, currency: 'usd', unit_amount: badPrice ? 1 : id === 'price_basic' ? 999 : 1499,
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } }) },
    customers: { create: async () => ({ id: 'cus_household' }) },
    subscriptions: { retrieve: async () => subscription, update: async (id, data) => {
      assert.equal(id, subscription.id);
      assert.deepEqual(Object.keys(data), ['metadata'], 'keeping Pro never changes price or invoices');
      subscription.metadata = { ...subscription.metadata, ...data.metadata };
      return subscription;
    } },
    subscriptionSchedules: {
      retrieve: async id => { assert.equal(id, schedule.id); return schedule; },
      create: async (data, options) => {
        if (createdSchedules.has(options.idempotencyKey)) return createdSchedules.get(options.idempotencyKey);
        assert.equal(subscription.schedule, undefined, 'never attach a second schedule');
        assert.deepEqual(data, { from_subscription: subscription.id });
        scheduleCreates.push([data, options]);
        schedule = { id: `sub_sched_${scheduleCreates.length}`, subscription: subscription.id, customer: subscription.customer,
          status: 'active', metadata: {}, current_phase: { start_date: seconds() - 100, end_date: subscription.current_period_end },
          phases: [{ start_date: seconds() - 100, end_date: subscription.current_period_end,
            items: [{ price: 'price_pro', quantity: 1 }], default_tax_rates: ['txr_existing'], metadata: { preserved: 'yes' },
            ...(subscription.status === 'trialing' ? { trial_end: subscription.trial_end } : {}) }] };
        subscription.schedule = schedule.id;
        createdSchedules.set(options.idempotencyKey, schedule);
        if (loseCreateResponse) { loseCreateResponse = false; throw new Error('Synthetic lost schedule create response'); }
        return schedule;
      },
      update: async (id, data, options) => {
        assert.equal(id, schedule.id);
        scheduleUpdates.push([data, options]);
        assert.equal(data.end_behavior, 'release', 'schedule must not cancel Basic later');
        assert.equal(data.proration_behavior, 'none');
        assert.equal(data.phases.length, 2);
        assert.equal(data.phases[0].items[0].price, 'price_pro');
        assert.equal(data.phases[0].end_date, subscription.current_period_end);
        assert.deepEqual(data.phases[0].default_tax_rates, ['txr_existing']);
        assert.deepEqual(data.phases[0].metadata, { preserved: 'yes' });
        if (subscription.status === 'trialing') assert.equal(data.phases[0].trial_end, subscription.trial_end, 'current Pro trial must not end early');
        assert.equal(data.phases[1].trial_end, undefined, 'Basic must not restart a trial');
        assert.deepEqual(data.phases[1].duration, { interval: 'month', interval_count: 1 });
        assert.equal(data.phases[1].start_date, subscription.current_period_end);
        assert.equal(data.phases[1].items[0].price, 'price_basic');
        assert.ok(data.phases.every(phase => phase.proration_behavior === 'none'));
        Object.assign(schedule, data);
        if (loseUpdateResponse) { loseUpdateResponse = false; throw new Error('Synthetic lost schedule update response'); }
        return schedule;
      },
      release: async (id, data, options) => {
        assert.equal(id, schedule.id);
        scheduleReleases.push([id, options]);
        schedule.status = 'released';
        schedule.released_subscription = subscription.id;
        schedule.subscription = null;
        delete subscription.schedule;
        return schedule;
      }
    },
    invoices: { retrieve: async () => ({ status: invoiceStatus }) },
    checkout: { sessions: {
      create: async (data, options) => { checkoutRequests.push([data, options]); checkoutSession = {
        id: `cs_${checkoutRequests.length}`, url: 'https://checkout.stripe.com/c/pay/synthetic', expires_at: seconds() + 1800,
        status: 'open', metadata: data.metadata }; return checkoutSession; },
      retrieve: async () => checkoutSession, expire: async () => { checkoutSession.status = 'expired'; }
    } },
    billingPortal: {
      configurations: { create: async data => { portalRequests.push(data); return { id: 'bpc_synthetic' }; } },
      sessions: { create: async data => { portalSessions.push(data); return { url: 'https://billing.stripe.com/p/session/synthetic' }; } }
    },
    webhooks: signatures
  });
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, body, cookie, method) => {
    const response = await fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const credentials = (name, email) => ({ name, email, password: 'synthetic-password-123456' });
  const webhook = async (id, type = 'customer.subscription.updated', signatureValid = true) => {
    const payload = JSON.stringify({ id, type, data: { object: type.startsWith('subscription_schedule.')
      ? { id: schedule.id } : type.startsWith('invoice.')
      ? { id: 'in_upgrade', parent: { subscription_details: { subscription: subscription.id } } }
      : { id: subscription.id } } });
    const signature = signatures.generateTestHeaderString({ payload, secret: signatureValid ? process.env.STRIPE_WEBHOOK_SECRET : 'wrong' });
    const response = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
    return response.status;
  };
  try {
    const admin = await call('/api/auth/setup', { ...credentials('Admin', 'admin@household.test'), setupToken: process.env.OWNER_SETUP_TOKEN });
    assert.equal(admin.status, 200);
    const owner = await call('/api/auth/register', credentials('Owner', 'owner@household.test'));
    assert.equal(owner.status, 200);
    const ownerCookie = owner.cookie;
    const ownerId = owner.body.user.id;
    assert.equal((await call('/api/dashboard/summary', {}, ownerCookie)).body.code, 'SUBSCRIPTION_REQUIRED');
    assert.equal((await call('/api/billing/checkout', { plan: 'basic', consent: true }, ownerCookie)).body.code, 'EMAIL_VERIFICATION_REQUIRED');
    const verification = mail.find(message => message.to === 'owner@household.test').text.match(/#verify-token=([a-f0-9]{64})/)[1];
    assert.equal((await call('/api/auth/verify-email', { token: verification })).status, 200);
    assert.equal((await call('/api/auth/verify-email', { token: verification })).status, 409, 'verification is single use');
    assert.equal((await call('/api/billing/checkout', { plan: 'basic' }, ownerCookie)).status, 400, 'billing consent is required');
    badPrice = true;
    assert.equal((await call('/api/billing/checkout', { plan: 'basic', consent: true }, ownerCookie)).status, 503);
    badPrice = false;
    const checkout = await call('/api/billing/checkout', { plan: 'basic', consent: true }, ownerCookie);
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    assert.equal(checkoutRequests[0][0].subscription_data.trial_period_days, 15);
    assert.equal(checkoutRequests[0][0].payment_method_collection, 'always');
    assert.equal(checkoutRequests[0][0].line_items[0].price, 'price_basic');
    assert.match(checkoutRequests[0][1].idempotencyKey, /household-checkout/);
    assert.equal((await call('/api/billing/checkout', { plan: 'basic', consent: true }, ownerCookie)).status, 200);
    assert.equal(checkoutRequests.length, 1, 'repeat checkout uses the pending session');
    assert.equal((await call('/api/license', undefined, ownerCookie)).body.active, false, 'redirect does not grant access');
    assert.equal(await webhook('evt_invalid', undefined, false), 400);
    assert.equal(await webhook('evt_trial'), 200);
    checkoutSession.status = 'complete';
    checkoutSession.subscription = subscription.id;
    assert.equal(await webhook('evt_trial'), 200, 'webhooks are idempotent');
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM stripe_events WHERE id='evt_trial'")).rows[0].count, 1);
    const trial = await call('/api/license', undefined, ownerCookie);
    assert.equal(trial.body.tier, 'trial');
    assert.equal(trial.body.plusActive, true, 'Basic selection receives Pro for the entire trial');
    assert.equal((await call('/api/analytics', undefined, ownerCookie)).status, 200);
    assert.equal((await call('/api/billing/checkout', { plan: 'pro', consent: true }, ownerCookie)).status, 409);
    assert.equal((await call('/api/billing/portal', {}, ownerCookie)).status, 200);
    assert.equal(portalRequests[0].features.subscription_cancel.mode, 'at_period_end');
    assert.equal((await call('/api/billing/portal', { plan: 'pro' }, ownerCookie)).status, 409, 'trial already includes Pro; upgrade must not end it');

    await database.query(`INSERT INTO transactions(user_id,date,description,amount,direction,category)
      VALUES($1,'2026-10-15','SHARED BILL',25,'DEBIT','Utilities'),(1,'2026-10-15','PRIVATE ADMIN BILL',200,'DEBIT','Other')`, [ownerId]);
    assert.equal((await call('/api/household/invitations', { email: 'spouse@household.test' }, ownerCookie)).status, 201);
    const invitation = mail.find(message => message.to === 'spouse@household.test').text.match(/#invite-token=([a-f0-9]{64})/)[1];
    process.env.ALLOW_REGISTRATION = 'false';
    assert.equal((await call('/api/auth/register', credentials('Blocked', 'blocked@household.test'))).status, 403);
    assert.equal((await call('/api/auth/accept-invite', { ...credentials('Wrong', 'wrong@household.test'), token: invitation })).status, 409);
    const spouse = await call('/api/auth/accept-invite', { ...credentials('Spouse', 'spouse@household.test'), token: invitation });
    assert.equal(spouse.status, 200, JSON.stringify(spouse.body));
    const spouseCookie = spouse.cookie;
    const spouseId = spouse.body.user.id;
    assert.equal((await call('/api/auth/accept-invite', { ...credentials('Spouse', 'spouse@household.test'), token: invitation })).status, 409);
    assert.equal((await call('/api/auth/me', undefined, spouseCookie)).body.user.household.role, 'member');
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'trial');
    assert.equal((await call('/api/billing/checkout', { plan: 'pro', consent: true }, spouseCookie)).status, 403);
    assert.equal((await call('/api/household/invitations', { email: 'attacker@household.test' }, spouseCookie)).status, 403);
    assert.equal((await call('/api/support-access', { reason: 'Grant access', hours: 1 }, spouseCookie)).status, 403);
    const review = await call('/api/transactions/transfer-review?importId=untracked', undefined, spouseCookie);
    assert.ok(review.body.rows.some(row => row.description === 'SHARED BILL'));
    assert.ok(review.body.rows.every(row => row.description !== 'PRIVATE ADMIN BILL'));
    const sharedImport = await call('/api/import/import-csv', { source: 'spouse.csv',
      csvData: 'Date,Description,Debit,Credit\n10/16/2026,SHARED PURCHASE,10,', newAccount: { name: 'Joint checking', kind: 'checking', last4: '1234' } }, spouseCookie);
    assert.equal(sharedImport.status, 200, JSON.stringify(sharedImport.body));
    assert.equal((await database.query("SELECT user_id FROM transactions WHERE description='SHARED PURCHASE'")).rows[0].user_id, ownerId,
      'member inserts use the household tenant, not login identity');
    assert.equal((await call('/api/accounts', undefined, ownerCookie)).body.accounts[0].name, 'Joint checking');

    subscription.items.data[0].price.id = 'price_pro';
    assert.equal(await webhook('evt_trial_selected_pro'), 200);
    const trialDowngrade = { consent: true, effectiveAt: new Date(subscription.trial_end * 1000).toISOString() };
    assert.equal((await call('/api/billing/downgrade', trialDowngrade, ownerCookie)).status, 200);
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'trial', 'Pro remains included until original trial expiry');
    assert.equal(subscription.trial_end, subscription.trial_start + 15 * 86400, 'scheduling never extends or truncates a trial');
    const reminderAt = new Date(subscription.trial_end * 1000 - 86400000);
    assert.equal(await sendDueTrialReminders(new Date(reminderAt.getTime() - 1)), 0);
    assert.equal(await sendDueTrialReminders(reminderAt), 1);
    assert.equal(await sendDueTrialReminders(reminderAt), 0);
    const reminders = mail.filter(message => message.subject === 'Your MyFinance Pro trial ends tomorrow');
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].to, 'owner@household.test');
    assert.match(reminders[0].text, /Basic \(\$9.99\)/);
    assert.equal((await call('/api/billing/downgrade/cancel', {}, ownerCookie)).status, 200);
    subscription.items.data[0].price.id = 'price_basic';
    assert.equal(await webhook('evt_trial_back_to_basic'), 200);
    scheduleCreates.length = 0; scheduleUpdates.length = 0; scheduleReleases.length = 0; createdSchedules.clear();
    delete subscription.metadata;
    subscription = { ...subscription, cancel_at_period_end: true };
    assert.equal(await webhook('evt_trial_cancel'), 200);
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'trial', 'cancel retains trial until its end');
    subscription = { ...subscription, status: 'active', cancel_at_period_end: false, current_period_end: seconds() + 30 * 86400 };
    assert.equal(await webhook('evt_paid_basic'), 200);
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'basic');
    assert.equal((await call('/api/analytics', undefined, spouseCookie)).status, 402);
    assert.equal((await call('/api/accounts', undefined, spouseCookie)).status, 200);
    subscription.items.data[0].id = 'si_household';
    assert.equal((await call('/api/billing/portal', { plan: 'pro' }, spouseCookie)).status, 403);
    assert.equal((await call('/api/billing/portal', { plan: 'basic' }, ownerCookie)).status, 400);
    badPrice = true;
    assert.equal((await call('/api/billing/portal', { plan: 'pro' }, ownerCookie)).status, 503);
    badPrice = false;
    subscription.pending_update = { expires_at: seconds() + 1000 };
    assert.equal((await call('/api/billing/portal', { plan: 'pro' }, ownerCookie)).status, 409);
    subscription.pending_update = null;
    assert.equal((await call('/api/billing/portal', { plan: 'pro' }, ownerCookie)).status, 200);
    const upgrade = portalRequests.at(-1).features.subscription_update;
    assert.equal(upgrade.proration_behavior, 'always_invoice');
    assert.equal(upgrade.billing_cycle_anchor, 'unchanged');
    assert.deepEqual(upgrade.default_allowed_updates, ['price']);
    assert.deepEqual(upgrade.products, [{ product: 'prod_pro', prices: ['price_pro'] }]);
    assert.deepEqual(portalSessions.at(-1).flow_data.subscription_update_confirm,
      { subscription: subscription.id, items: [{ id: 'si_household', price: 'price_pro', quantity: 1 }] });
    assert.equal((await call('/api/license', undefined, ownerCookie)).body.tier, 'basic', 'opening portal grants no Pro access');
    subscription = { ...subscription, latest_invoice: 'in_upgrade', items: { data: [{ quantity: 1, price: { id: 'price_pro' } }] } };
    assert.equal(await webhook('evt_upgrade_unpaid'), 200);
    assert.equal((await call('/api/analytics', undefined, spouseCookie)).status, 402, 'unpaid upgrade cannot unlock Pro');
    subscription.status = 'past_due';
    assert.equal(await webhook('evt_upgrade_failed', 'invoice.payment_failed'), 200);
    subscription.status = 'active';
    assert.equal(await webhook('evt_upgrade_still_unpaid'), 200);
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'basic', 'status recovery cannot bypass unpaid upgrade invoice');
    invoiceStatus = 'paid';
    assert.equal(await webhook('evt_paid_pro', 'invoice.paid'), 200);
    assert.equal((await call('/api/analytics', undefined, spouseCookie)).status, 200);
    const downgrade = { consent: true, effectiveAt: new Date(subscription.current_period_end * 1000).toISOString() };
    assert.equal((await call('/api/billing/downgrade', downgrade, spouseCookie)).status, 403);
    assert.equal((await call('/api/billing/downgrade/cancel', {}, spouseCookie)).status, 403);
    assert.equal((await call('/api/billing/downgrade', { ...downgrade, consent: false }, ownerCookie)).status, 400);
    assert.equal((await call('/api/billing/downgrade', { ...downgrade, effectiveAt: '2020-01-01' }, ownerCookie)).status, 409);
    subscription.cancel_at_period_end = true;
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 409);
    subscription.cancel_at_period_end = false;
    subscription.cancel_at = subscription.current_period_end;
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 409, 'explicit Stripe cancellation conflicts too');
    delete subscription.cancel_at;
    subscription.pending_update = { expires_at: seconds() + 1000 };
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 409);
    subscription.pending_update = null;
    badPrice = true;
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 503);
    badPrice = false;
    schedule = { id: 'sub_sched_external', status: 'active', customer: subscription.customer,
      subscription: subscription.id, metadata: {}, current_phase: { start_date: seconds(), end_date: subscription.current_period_end }, phases: [] };
    subscription.schedule = schedule.id;
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 409, 'external schedules are never overwritten');
    assert.equal((await call('/api/billing/downgrade/cancel', {}, ownerCookie)).status, 409, 'external schedules are never released');
    delete subscription.schedule;
    loseCreateResponse = true;
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 500);
    loseUpdateResponse = true;
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 500);
    const scheduled = await call('/api/billing/downgrade', downgrade, ownerCookie);
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
    assert.deepEqual(scheduled.body.pending_change, { plan: 'basic', effective_at: downgrade.effectiveAt });
    assert.equal(scheduleCreates.length, 1, 'retry reuses the schedule after a lost create response');
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 200);
    assert.equal(scheduleUpdates.length, 1, 'repeat confirmation does not rewrite phases');
    const pendingBilling = (await call('/api/billing', undefined, spouseCookie)).body;
    assert.equal(pendingBilling.owner, false);
    assert.deepEqual(pendingBilling.subscription.pending_change, scheduled.body.pending_change);
    assert.equal(pendingBilling.subscription.plan, 'pro');
    assert.equal(pendingBilling.subscription.schedule_managed, true);
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'pro', 'scheduling never removes Pro');
    assert.equal((await call('/api/billing/portal', {}, ownerCookie)).status, 409, 'portal cannot conflict with a pending schedule');
    assert.equal(await webhook('evt_schedule_updated', 'subscription_schedule.updated'), 200);
    assert.equal((await call('/api/analytics', undefined, spouseCookie)).status, 200, 'schedule webhook retains Pro until actual transition');
    assert.equal((await call('/api/billing/downgrade/cancel', {}, ownerCookie)).status, 200);
    assert.equal((await call('/api/billing/downgrade/cancel', {}, ownerCookie)).status, 200, 'removing a downgrade is retry-safe');
    assert.equal(scheduleReleases.length, 1);
    assert.equal((await call('/api/billing/portal', {}, ownerCookie)).status, 200, 'cancellation portal is available after keeping Pro');
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'pro');
    assert.equal((await call('/api/billing/downgrade', downgrade, ownerCookie)).status, 200);
    assert.equal(scheduleCreates.length, 2, 'a removed downgrade can be scheduled again in the same billing period');
    subscription.items = { data: [{ quantity: 1, price: { id: 'price_basic' } }] };
    subscription.current_period_end += 30 * 86400;
    schedule.current_phase = { start_date: schedule.phases[1].start_date, end_date: subscription.current_period_end };
    assert.equal(await webhook('evt_schedule_transition', 'subscription_schedule.updated'), 200);
    assert.equal((await call('/api/license', undefined, spouseCookie)).body.tier, 'basic');
    assert.equal((await call('/api/analytics', undefined, spouseCookie)).status, 402);
    assert.equal((await call('/api/accounts', undefined, spouseCookie)).status, 200);
    assert.equal((await call('/api/billing', undefined, ownerCookie)).body.subscription.pending_change, null);
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM transactions WHERE description='SHARED PURCHASE'")).rows[0].count, 1,
      'transition to Basic preserves saved household data');
    assert.equal((await call('/api/billing/downgrade/cancel', {}, ownerCookie)).status, 409, 'cannot keep Pro after Basic has taken effect');
    assert.equal((await call('/api/billing/portal', {}, ownerCookie)).status, 200, 'completed Basic phase can open billing without waiting another month');
    assert.equal(subscription.schedule, undefined, 'completed downgrade schedule is released without changing Basic');
    subscription = { ...subscription, status: 'past_due' };
    assert.equal(await webhook('evt_payment_failed'), 200);
    assert.equal((await call('/api/accounts', undefined, spouseCookie)).status, 402, 'unpaid access is locked server-side');
    assert.equal((await call('/api/household', undefined, spouseCookie)).status, 200, 'account controls remain available');
    subscription = { ...subscription, status: 'canceled' };
    assert.equal(await webhook('evt_cancelled'), 200);
    assert.equal((await call(`/api/household/members/${spouseId}`, undefined, ownerCookie, 'DELETE')).status, 200);
    assert.equal((await call('/api/accounts', undefined, spouseCookie)).status, 401, 'removal revokes every session');
    const relogin = await call('/api/auth/login', credentials('Spouse', 'spouse@household.test'));
    assert.equal((await call('/api/license', undefined, relogin.cookie)).body.active, false, 'removed members do not retain household access');
    assert.equal((await call('/api/billing/checkout', { plan: 'pro', consent: true }, ownerCookie)).status, 200);
    assert.equal(checkoutRequests.at(-1)[0].subscription_data.trial_period_days, undefined, 'the household cannot restart its trial');
    checkoutSession.status = 'complete';
    checkoutSession.subscription = 'sub_replacement_waiting_for_webhook';
    const checkoutCount = checkoutRequests.length;
    assert.equal((await call('/api/billing/checkout', { plan: 'pro', consent: true }, ownerCookie)).status, 409);
    assert.equal(checkoutRequests.length, checkoutCount, 'a completed replacement awaiting its webhook cannot create another subscription');
  } finally {
    await new Promise(resolve => server.close(resolve));
    setStripeForTests(null);
    setMailTransportForTests(null);
    await database.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
