import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import Stripe from 'stripe';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { setMailTransportForTests } from './mailer.js';
import { setStripeForTests, sendDueTrialReminders } from './billing.js';

test('32 logins and 24 populated households retain isolation across Stripe subscription lifecycles', { timeout: 240000 }, async t => {
  const started = performance.now();
  const database = new PGlite();
  let lock = Promise.resolve();
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    let release;
    const previous = lock;
    lock = new Promise(resolve => { release = resolve; });
    await previous;
    return {
      async query(sql, params) {
        const results = params?.length ? [await database.query(sql, params)] : await database.exec(sql);
        const result = results.at(-1) || { rows: [] };
        return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
      },
      release
    };
  });
  const migration = await pg.Pool.prototype.connect();
  try {
    await migration.query('BEGIN');
    await migratePrivateSchema(migration);
    await migration.query('COMMIT');
  } finally { migration.release(); }
  const keys = ['OWNER_SETUP_TOKEN', 'ALLOW_REGISTRATION', 'APP_ORIGIN', 'STRIPE_BASIC_PRICE_ID', 'STRIPE_PRO_PRICE_ID', 'STRIPE_WEBHOOK_SECRET'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalTrust = application.get('trust proxy');
  // Model distinct clients behind one trusted proxy without disabling authentication throttling.
  application.set('trust proxy', 1);
  Object.assign(process.env, {
    OWNER_SETUP_TOKEN: 'synthetic-scale-owner-setup-token-at-least-32-chars',
    ALLOW_REGISTRATION: 'true', STRIPE_BASIC_PRICE_ID: 'price_scale_basic',
    STRIPE_PRO_PRICE_ID: 'price_scale_pro', STRIPE_WEBHOOK_SECRET: 'whsec_scale_synthetic_only'
  });
  const mail = [], checkoutRequests = [], portalConfigurations = [], timings = [];
  const customers = new Map(), sessions = new Map(), subscriptions = new Map(), idempotency = new Map();
  const seconds = () => Math.floor(Date.now() / 1000);
  const signatures = new Stripe('sk_test_scale_synthetic_only').webhooks;
  setMailTransportForTests({ sendMail: async message => { mail.push(message); return { accepted: [message.to] }; } });
  setStripeForTests({
    prices: { retrieve: async id => ({
      id, active: true, currency: 'usd', unit_amount: id === process.env.STRIPE_BASIC_PRICE_ID ? 999 : 1499,
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }
    }) },
    customers: { create: async (data, options) => {
      if (!idempotency.has(options.idempotencyKey)) {
        const customer = { id: `cus_scale_${customers.size + 1}`, ...data };
        customers.set(customer.id, customer);
        idempotency.set(options.idempotencyKey, customer);
      }
      return idempotency.get(options.idempotencyKey);
    } },
    subscriptions: { retrieve: async id => {
      assert.ok(subscriptions.has(id), `Known synthetic subscription ${id}`);
      return subscriptions.get(id);
    } },
    checkout: { sessions: {
      create: async (data, options) => {
        if (!idempotency.has(options.idempotencyKey)) {
          const session = { id: `cs_scale_${sessions.size + 1}`, status: 'open', expires_at: seconds() + 1800,
            url: `https://checkout.stripe.com/synthetic-scale-${sessions.size + 1}`, metadata: data.metadata };
          sessions.set(session.id, session);
          checkoutRequests.push({ data, session });
          idempotency.set(options.idempotencyKey, session);
        }
        return idempotency.get(options.idempotencyKey);
      },
      retrieve: async id => {
        assert.ok(sessions.has(id), `Known synthetic checkout ${id}`);
        return sessions.get(id);
      },
      expire: async id => { sessions.get(id).status = 'expired'; }
    } },
    billingPortal: {
      configurations: { create: async data => { portalConfigurations.push(data); return { id: 'bpc_scale' }; } },
      sessions: { create: async data => {
        assert.ok(customers.has(data.customer));
        return { url: `https://billing.stripe.com/synthetic-${data.customer}` };
      } }
    },
    webhooks: signatures
  });
  const server = application.listen(0, '127.0.0.1');
  // PGlite serializes queries; keep idle HTTP sockets alive during CPU-heavy imports.
  server.keepAliveTimeout = 60000;
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, body, user, method) => {
    const before = performance.now();
    const response = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', Origin: base,
        'X-Forwarded-For': `192.0.2.${user?.ip || 250}`, ...(user?.cookie ? { Cookie: user.cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000)
    }).catch(error => { throw new Error(`Scale request failed: ${method || (body === undefined ? 'GET' : 'POST')} ${path} for ${user?.email || 'setup'}`, { cause: error }); });
    const result = { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    timings.push({ path, ms: performance.now() - before, status: response.status });
    return result;
  };
  const expect = (result, status = 200) => {
    assert.equal(result.status, status, JSON.stringify(result.body));
    return result.body;
  };
  const parallel = async (items, run) => {
    for (let i = 0; i < items.length; i += 4) await Promise.all(items.slice(i, i + 4).map(run));
  };
  const credentials = user => ({ name: user.name, email: user.email, password: 'synthetic-scale-password-123456' });
  const token = (email, kind) => {
    const message = mail.find(message => message.to === email && message.text.includes(`#${kind}-token=`));
    assert.ok(message, `Email delivery for ${email}`);
    return message.text.match(new RegExp(`#${kind}-token=([a-f0-9]{64})`))[1];
  };
  const webhook = async (subscription, id, type = 'customer.subscription.updated', valid = true, extra = {}) => {
    const before = performance.now();
    const payload = JSON.stringify({ id, type, data: { object: { id: subscription.id, ...extra } } });
    const signature = signatures.generateTestHeaderString({ payload, secret: valid ? process.env.STRIPE_WEBHOOK_SECRET : 'wrong' });
    const response = await fetch(base + '/api/billing/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'stripe-signature': signature
    }, body: payload, signal: AbortSignal.timeout(30000) });
    const body = await response.text();
    timings.push({ path: '/api/billing/webhook', ms: performance.now() - before, status: response.status });
    assert.equal(response.status, valid ? 200 : 400, body);
  };
  const activate = async (user, status, suffix) => {
    user.subscription.status = status;
    await webhook(user.subscription, `evt_scale_${user.index}_${suffix}`);
  };
  const owners = Array.from({ length: 24 }, (_, index) => ({
    index, ip: index + 1, name: `Scale household ${index}`, email: `owner${index}@scale.test`,
    plan: index % 2 === 0 ? 'basic' : 'pro', accounts: [], imports: []
  }));
  const members = [];
  let foreignChecks = 0;
  try {
    const admin = { ip: 249, name: 'Scale admin', email: 'admin@scale.test' };
    expect(await call('/api/auth/setup', { ...credentials(admin), setupToken: process.env.OWNER_SETUP_TOKEN }, admin));
    await parallel(owners, async owner => {
      const registered = await call('/api/auth/register', credentials(owner), owner);
      owner.id = expect(registered).user.id;
      owner.cookie = registered.cookie;
      assert.equal(expect(await call('/api/license', undefined, owner)).active, false);
      expect(await call('/api/accounts', undefined, owner), 402);
      expect(await call('/api/billing/checkout', { plan: owner.plan, consent: true }, owner), 403);
      expect(await call('/api/auth/verify-email', { token: token(owner.email, 'verify') }, owner));
      expect(await call('/api/billing/checkout', { plan: owner.plan, consent: false }, owner), 400);
      const checkouts = await Promise.all(Array.from({ length: 2 }, () =>
        call('/api/billing/checkout', { plan: owner.plan, consent: true }, owner)));
      checkouts.forEach(result => expect(result));
      owner.checkout = checkoutRequests.find(request => request.data.client_reference_id
        && request.data.customer && customers.get(request.data.customer).email === owner.email);
      assert.ok(owner.checkout);
      assert.equal(owner.checkout.data.line_items[0].price, `price_scale_${owner.plan}`);
      assert.equal(owner.checkout.data.subscription_data.trial_period_days, 15);
      assert.equal(owner.checkout.data.payment_method_collection, 'always');
      expect(await call('/api/billing/checkout', { plan: owner.plan, consent: true }, owner));
      expect(await call('/api/accounts', undefined, owner), 402, 'checkout redirect cannot unlock access');
      owner.subscription = { id: `sub_scale_${owner.index}`, customer: owner.checkout.data.customer,
        status: 'trialing', trial_start: seconds(), trial_end: seconds() + 15 * 86400,
        current_period_end: seconds() + 15 * 86400, cancel_at_period_end: false,
        items: { data: [{ quantity: 1, price: { id: `price_scale_${owner.plan}` } }] } };
      subscriptions.set(owner.subscription.id, owner.subscription);
      owner.checkout.session.status = 'complete';
      owner.checkout.session.subscription = owner.subscription.id;
      await webhook(owner.subscription, `evt_scale_${owner.index}_trial`);
      const license = expect(await call('/api/license', undefined, owner));
      assert.equal(license.tier, 'trial');
      assert.equal(license.plusActive, true, 'every Basic-selected trial includes Pro');
    });
    assert.equal(customers.size, 24);
    assert.equal(checkoutRequests.length, 24, 'concurrent/repeated checkout retains one session per household');
    // Deliberately identical data and account endings exercise tenant AND account dedup boundaries.
    const csv = 'Date,Description,Debit,Credit\n' + Array.from({ length: 500 }, (_, index) =>
      `10/${String(index % 28 + 1).padStart(2, '0')}/2026,SCALE MERCHANT ${String(index).padStart(4, '0')},${(index + 1).toFixed(2)},`).join('\n');
    await parallel(owners, async owner => {
      for (const [kind, last4] of [['checking', '1234'], ['savings', '5678']]) {
        const created = expect(await call('/api/accounts', { name: `${owner.name} ${kind}`, kind, last4 }, owner), 201);
        owner.accounts.push(created.account.id);
        const body = { source: `scale-${kind}.csv`, csvData: csv, accountId: created.account.id };
        const imported = expect(await call('/api/import/import-csv', body, owner));
        assert.equal(imported.imported, 500);
        assert.equal(imported.duplicates, 0);
        if (kind === 'checking') {
          const repeated = expect(await call('/api/import/import-csv', body, owner));
          assert.equal(repeated.imported, 0);
          assert.equal(repeated.duplicates, 500);
        }
      }
      owner.imports = expect(await call('/api/transactions/transfer-review/imports', undefined, owner)).batches.map(batch => batch.id);
      assert.equal(owner.imports.length, 3);
      const rows = expect(await call('/api/transactions', { dateFilter: 'all' }, owner));
      assert.equal(rows.length, 1000);
      assert.ok(rows.every(row => row.user_id === owner.id && owner.accounts.includes(row.account_id)));
      owner.transaction = rows[0].id;
      const goal = expect(await call('/api/goals', { name: `${owner.name} private goal`, target_amount: 10000,
        current_amount: 0, target_date: '2028-12-31' }, owner));
      owner.goal = goal.id;
    });
    const populatedAt = performance.now();
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM transactions')).rows[0].count, 24000);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM accounts')).rows[0].count, 48);
    await parallel(owners.slice(0, 8), async owner => {
      const member = { ip: owner.index + 101, name: `Scale spouse ${owner.index}`, email: `spouse${owner.index}@scale.test`, owner };
      expect(await call('/api/household/invitations', { email: member.email }, owner), 201);
      const joined = await call('/api/auth/accept-invite', { ...credentials(member), token: token(member.email, 'invite') }, member);
      member.id = expect(joined).user.id;
      member.cookie = joined.cookie;
      expect(await call('/api/billing/checkout', { plan: 'pro', consent: true }, member), 403);
      expect(await call('/api/billing/portal', {}, member), 403);
      expect(await call('/api/household/invitations', { email: 'forbidden@scale.test' }, member), 403);
      members.push(member);
    });
    const users = [...owners, ...members];
    // Reauthenticate every login rather than relying solely on registration/invitation cookies.
    await parallel(users, async user => {
      expect(await call('/api/auth/logout', {}, user));
      expect(await call('/api/accounts', undefined, user), 401);
      const signedIn = await call('/api/auth/login', credentials(user), user);
      expect(signedIn);
      user.cookie = signedIn.cookie;
      const tenant = user.owner || user;
      const me = expect(await call('/api/auth/me', undefined, user));
      assert.equal(me.user.household.role, user.owner ? 'member' : 'owner');
      const accounts = expect(await call('/api/accounts', undefined, user)).accounts;
      assert.deepEqual(accounts.map(account => account.id).sort((a, b) => a - b), tenant.accounts);
      assert.ok(accounts.every(account => account.name.startsWith(tenant.name)));
      const rows = expect(await call('/api/transactions', { dateFilter: 'all' }, user));
      assert.equal(rows.length, 1000);
      assert.ok(rows.every(row => row.user_id === tenant.id && tenant.accounts.includes(row.account_id)));
      const goals = expect(await call('/api/goals', undefined, user));
      assert.deepEqual(goals.map(goal => goal.id), [tenant.goal]);
      const batches = expect(await call('/api/transactions/transfer-review/imports', undefined, user)).batches;
      assert.deepEqual(batches.map(batch => batch.id), tenant.imports);
      const page = expect(await call(`/api/transactions/transfer-review?limit=10000&offset=100`, undefined, user));
      assert.equal(page.limit, 100);
      assert.equal(page.rows.length, 100, 'diagnostic response remains bounded at scale');
      assert.equal(page.total, 1000);
      assert.ok(page.rows.every(row => tenant.accounts.includes(accounts.find(account => account.name === row.account_name)?.id)));
      const foreign = owners[(tenant.index + 1) % owners.length];
      expect(await call('/api/transactions/update-fixed', { id: foreign.transaction, is_fixed: true, apply_to_all: false }, user), 404);
      expect(await call(`/api/goals/${foreign.goal}/contribute`, { amount: 100 }, user), 404);
      expect(await call('/api/import/import-csv', { source: 'forged.csv', csvData: csv, accountId: foreign.accounts[0] }, user), 400);
      foreignChecks += 3;
    });
    await Promise.all(users.map(async user => {
      const tenant = user.owner || user;
      const accounts = expect(await call('/api/accounts', undefined, user)).accounts;
      assert.deepEqual(accounts.map(account => account.id).sort((a, b) => a - b), tenant.accounts,
        'a burst from all 32 logins must not mix pooled tenant contexts');
    }));
    await parallel(owners, async owner => {
      for (const foreign of owners.filter(other => other !== owner)) {
        expect(await call(`/api/accounts/${foreign.accounts[0]}`, { name: 'FORBIDDEN CROSS HOUSEHOLD EDIT' }, owner, 'PATCH'), 404);
        expect(await call(`/api/transactions/transfer-review?importId=${foreign.imports[0]}`, undefined, owner), 404);
        foreignChecks += 2;
      }
    });
    // Each spouse may edit their household, without the edit appearing in another household.
    await parallel(members, async member => {
      expect(await call('/api/transactions/update-fixed', { id: member.owner.transaction, is_fixed: true, apply_to_all: false }, member));
      const rows = expect(await call('/api/transactions', { dateFilter: 'all' }, member.owner));
      assert.equal(rows.find(row => row.id === member.owner.transaction).is_fixed, true);
    });
    assert.equal((await database.query("SELECT COUNT(*)::int AS count FROM accounts WHERE name='FORBIDDEN CROSS HOUSEHOLD EDIT'")).rows[0].count, 0);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM transactions WHERE is_fixed=TRUE')).rows[0].count, 8);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM transactions')).rows[0].count, 24000);
    const cancellation = owners.slice(0, 6), continuing = owners.slice(6, 18), trialing = owners.slice(18);
    await parallel(cancellation, async owner => {
      expect(await call('/api/billing/portal', {}, owner));
      owner.subscription.cancel_at_period_end = true;
      await webhook(owner.subscription, `evt_scale_${owner.index}_cancel_scheduled`);
      assert.equal(expect(await call('/api/license', undefined, owner)).tier, 'trial');
      expect(await call('/api/accounts', undefined, owner));
    });
    assert.ok(portalConfigurations.every(config => config.features.subscription_cancel.mode === 'at_period_end'));
    const reminderAt = new Date(Math.min(...owners.map(owner => owner.subscription.trial_end)) * 1000 - 86400000);
    const allDueAt = new Date(Math.max(...owners.map(owner => owner.subscription.trial_end)) * 1000 - 86400000);
    assert.equal(await sendDueTrialReminders(new Date(reminderAt.getTime() - 1)), 0);
    assert.equal(await sendDueTrialReminders(allDueAt), 24);
    assert.equal(await sendDueTrialReminders(allDueAt), 0);
    const reminders = mail.filter(message => message.subject === 'Your MyFinance Pro trial ends tomorrow');
    assert.equal(reminders.length, 24);
    assert.equal(new Set(reminders.map(message => message.to)).size, 24);
    assert.ok(reminders.every(message => owners.some(owner => owner.email === message.to)));
    assert.ok(reminders.filter(message => cancellation.some(owner => owner.email === message.to)).every(message => message.text.includes('You will not be charged')));
    await parallel(cancellation, async owner => {
      owner.subscription.trial_end = seconds() - 60;
      owner.subscription.current_period_end = seconds() - 60;
      await activate(owner, 'canceled', 'trial_ended');
    });
    await parallel(continuing, async owner => {
      owner.subscription.trial_end = seconds() - 60;
      owner.subscription.current_period_end = seconds() + 30 * 86400;
      await activate(owner, 'active', 'paid');
      assert.equal(expect(await call('/api/license', undefined, owner)).tier, owner.plan);
    });
    await parallel(users, async user => {
      const owner = user.owner || user;
      const ended = cancellation.includes(owner);
      assert.equal(expect(await call('/api/license', undefined, user)).active, !ended);
      expect(await call('/api/accounts', undefined, user), ended ? 402 : 200);
      const advanced = trialing.includes(owner) || (!ended && owner.plan === 'pro');
      expect(await call('/api/goals', undefined, user), advanced ? 200 : 402);
      expect(await call('/api/billing', undefined, user));
      expect(await call('/api/household', undefined, user));
    });
    // Failed invoices lock both owner and spouse; replaying an older paid event cannot undo this.
    const failed = continuing[0];
    failed.subscription.status = 'past_due';
    await webhook(failed.subscription, 'evt_scale_failed_invoice', 'invoice.payment_failed', true, { subscription: failed.subscription.id });
    await webhook(failed.subscription, 'evt_scale_late_paid_invoice', 'invoice.paid', true, { subscription: failed.subscription.id });
    for (const user of [failed, ...members.filter(member => member.owner === failed)]) {
      expect(await call('/api/accounts', undefined, user), 402);
      expect(await call('/api/billing', undefined, user));
    }
    await activate(failed, 'active', 'payment_recovered');
    expect(await call('/api/accounts', undefined, failed));
    const expiredPaid = continuing[1];
    expiredPaid.subscription.current_period_end = seconds() - 60;
    await webhook(expiredPaid.subscription, 'evt_scale_active_but_expired');
    expect(await call('/api/accounts', undefined, expiredPaid), 402, 'active Stripe status alone cannot extend an expired paid period');
    expiredPaid.subscription.current_period_end = seconds() + 30 * 86400;
    await webhook(expiredPaid.subscription, 'evt_scale_paid_period_renewed', 'invoice.paid', true, {
      parent: { subscription_details: { subscription: expiredPaid.subscription.id } }
    });
    expect(await call('/api/accounts', undefined, expiredPaid));
    // Invalid signatures, duplicate events and stale payload fields cannot grant a different tier.
    const protectedOwner = continuing[2];
    await webhook(protectedOwner.subscription, 'evt_scale_bad_signature', undefined, false);
    const repeatedEvent = `evt_scale_${protectedOwner.index}_paid`;
    await Promise.all(Array.from({ length: 4 }, () => webhook(protectedOwner.subscription, repeatedEvent)));
    await webhook(protectedOwner.subscription, 'evt_scale_stale_payload', undefined, true, { status: 'canceled', customer: 'cus_unknown' });
    assert.equal(expect(await call('/api/license', undefined, protectedOwner)).tier, protectedOwner.plan);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM stripe_events WHERE id=$1', [repeatedEvent])).rows[0].count, 1);
    const returning = cancellation[0];
    expect(await call('/api/auth/register', { ...credentials(returning), email: ` ${returning.email.toUpperCase()} ` }, returning), 409);
    expect(await call('/api/auth/logout', {}, returning));
    const login = await call('/api/auth/login', credentials(returning), returning);
    expect(login);
    returning.cookie = login.cookie;
    const trialBefore = expect(await call('/api/license', undefined, returning));
    assert.equal(trialBefore.active, false);
    assert.equal(trialBefore.trialAvailable, false);
    expect(await call('/api/billing/checkout', { plan: 'pro', consent: true }, returning));
    const paidCheckout = checkoutRequests.at(-1);
    assert.equal(paidCheckout.data.customer, returning.subscription.customer, 'return uses the same Stripe customer');
    assert.equal(paidCheckout.data.subscription_data.trial_period_days, undefined, 'returning household must pay, not start another trial');
    assert.equal(paidCheckout.data.line_items[0].price, 'price_scale_pro');
    expect(await call('/api/accounts', undefined, returning), 402, 'new checkout alone still cannot grant access');
    const retired = returning.subscription;
    returning.subscription = { id: 'sub_scale_return_paid', customer: retired.customer, status: 'active',
      current_period_end: seconds() + 30 * 86400, cancel_at_period_end: false,
      items: { data: [{ quantity: 1, price: { id: 'price_scale_pro' } }] } };
    subscriptions.set(returning.subscription.id, returning.subscription);
    paidCheckout.session.status = 'complete';
    paidCheckout.session.subscription = returning.subscription.id;
    const checkoutCount = checkoutRequests.length;
    expect(await call('/api/billing/checkout', { plan: 'pro', consent: true }, returning), 409);
    assert.equal(checkoutRequests.length, checkoutCount, 'awaiting a new subscription webhook cannot create a second checkout');
    await webhook(returning.subscription, 'evt_scale_return_paid');
    await webhook(retired, 'evt_scale_late_retired_subscription', 'customer.subscription.deleted');
    const resumed = expect(await call('/api/license', undefined, returning));
    assert.equal(resumed.tier, 'pro');
    assert.equal(resumed.trialAvailable, false);
    const restored = expect(await call('/api/transactions', { dateFilter: 'all' }, returning));
    assert.equal(restored.length, 1000, 'cancellation and resubscription preserve existing data');
    assert.ok(restored.every(row => row.user_id === returning.id));
    assert.equal(expect(await call('/api/license', undefined, members.find(member => member.owner === returning))).tier, 'pro');
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM household_subscriptions')).rows[0].count, 24);
    assert.equal(customers.size, 24);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM transactions')).rows[0].count, 24000);
    assert.deepEqual((await database.query(`SELECT status,COUNT(*)::int AS count FROM household_subscriptions
      GROUP BY status ORDER BY status`)).rows, [
      { status: 'active', count: 13 }, { status: 'canceled', count: 5 }, { status: 'trialing', count: 6 }
    ]);
    const finalCounts = (await database.query('SELECT user_id,COUNT(*)::int AS count FROM transactions GROUP BY user_id')).rows;
    assert.equal(finalCounts.length, 24);
    assert.ok(finalCounts.every(row => row.count === 1000 && owners.some(owner => owner.id === row.user_id)));
    const sorted = timings.map(timing => timing.ms).sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({
      households: 24, logins: users.length, bankAccounts: 48, transactions: 24000,
      csvUploads: 72, duplicateRowsSkipped: 12000, foreignAccessChecks: foreignChecks,
      concurrentReadBurst: users.length, finalPaidHouseholds: 13, finalCanceledHouseholds: 5, finalTrialHouseholds: 6,
      ownerReminders: reminders.length, httpRequests: timings.length,
      provisioningAndImportsMs: Math.round(populatedAt - started),
      durationMs: Math.round(performance.now() - started),
      requestP50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
      requestP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      requestMaxMs: Math.round(sorted.at(-1)),
      environment: 'in-memory PGlite, serialized DB connections, four workflow clients plus 32-login read burst, fake Stripe/SMTP; not a production throughput benchmark'
    }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    application.set('trust proxy', originalTrust);
    setStripeForTests(null);
    setMailTransportForTests(null);
    await database.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
