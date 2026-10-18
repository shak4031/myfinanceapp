import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import application from '../app.js';

test('MyFinance Pro: owner license, one-time trial, gating, admin grant/revoke, budgets and analytics', async t => {
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
        const result = results[results.length - 1] || { rows: [] };
        return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
      },
      release
    };
  });
  const saved = { token: process.env.OWNER_SETUP_TOKEN, registration: process.env.ALLOW_REGISTRATION, origin: process.env.APP_ORIGIN };
  process.env.OWNER_SETUP_TOKEN = 'test-only-setup-token-longer-than-32-characters';
  process.env.ALLOW_REGISTRATION = 'true';
  const setupClient = await pg.Pool.prototype.connect();
  await setupClient.query('BEGIN');
  await migratePrivateSchema(setupClient);
  await setupClient.query('COMMIT');
  setupClient.release();

  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, { method, body, cookie } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* CSV */ }
    return { status: response.status, headers: response.headers, body: parsed };
  };
  const cookieFrom = response => response.headers.get('set-cookie').split(';')[0];
  const password = 'test-only-password-123456';
  const planningRequests = [
    ['/api/plan'], ['/api/debts'], ['/api/debts', 'POST', {}],
    ['/api/debts/1', 'PUT', { balance: 0 }], ['/api/debts/1', 'DELETE'],
    ['/api/goals'], ['/api/goals/funding-analysis'], ['/api/goals', 'POST', { name: 'Blocked' }],
    ['/api/goals/1', 'PUT', { current_amount: 100 }], ['/api/goals/1', 'DELETE'],
    ['/api/goals/1/contribute', 'POST', { amount: 10 }],
    ['/api/plan/settings', 'PUT', { debt_strategy: 'snowball' }],
    ['/api/plan/flex', 'PUT', { key: 'debt-extra', amount: 0 }],
    ['/api/plan/debt-order', 'PUT', { ids: [1] }],
    ['/api/plan/what-if', 'POST', { extra: 100 }]
  ];
  async function assertPlanningLocked(cookie) {
    for (const [path, method, body] of planningRequests) {
      const result = await call(path, { method, body, cookie });
      assert.equal(result.status, 402, `${method || 'GET'} ${path}`);
      assert.equal(result.body.code, 'PRO_PLUS_REQUIRED');
      assert.equal(result.body.entitlement.plusActive, false);
    }
  }
  try {
    const owner = await call('/api/auth/setup', { body: { name: 'Owner', email: 'owner@example.com', password, setupToken: process.env.OWNER_SETUP_TOKEN } });
    const ownerCookie = cookieFrom(owner);
    const customer = await call('/api/auth/register', { body: { name: 'Customer', email: 'customer@example.com', password } });
    const customerCookie = cookieFrom(customer);
    const customerId = customer.body.user.id;

    // The primary account is always licensed.
    const ownerLicense = await call('/api/license', { cookie: ownerCookie });
    assert.equal(ownerLicense.body.tier, 'pro');
    assert.equal(ownerLicense.body.source, 'owner');
    assert.equal(ownerLicense.body.plan.price, 4.99);
    assert.equal(ownerLicense.body.plusActive, true);
    assert.equal(ownerLicense.body.plusPlan.price, 9.98);
    assert.equal(ownerLicense.body.plusPlan.additionalPrice, 4.99);
    assert.equal(ownerLicense.body.features.some(feature => feature.id === 'planning'), false);
    assert.equal((await call('/api/analytics', { cookie: ownerCookie })).status, 200);

    // Free accounts see the plan but cannot use Pro endpoints.
    const free = await call('/api/license', { cookie: customerCookie });
    assert.equal(free.body.tier, 'free');
    assert.equal(free.body.trialAvailable, true);
    const blocked = await call('/api/analytics', { cookie: customerCookie });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.body.code, 'PRO_REQUIRED');
    assert.equal((await call('/api/budgets', { cookie: customerCookie })).status, 402);
    assert.equal((await call('/api/analytics/export.csv', { cookie: customerCookie })).status, 402);
    await assertPlanningLocked(customerCookie);

    // The 7-day trial can be started exactly once.
    const trial = await call('/api/license/trial', { body: {}, cookie: customerCookie });
    assert.equal(trial.status, 200);
    assert.equal(trial.body.tier, 'trial');
    assert.equal(trial.body.daysLeft, 7);
    assert.equal(trial.body.plusActive, true);
    assert.equal((await call('/api/plan', { cookie: customerCookie })).status, 200);
    assert.equal((await call('/api/debts', { cookie: customerCookie })).status, 200);
    assert.equal((await call('/api/goals', { cookie: customerCookie })).status, 200);
    assert.equal((await call('/api/license/trial', { body: {}, cookie: customerCookie })).status, 409);
    assert.equal((await call('/api/analytics', { cookie: customerCookie })).status, 200);

    // An expired trial locks the features again and cannot be restarted.
    await database.query("UPDATE user_licenses SET trial_ends_at = NOW() - INTERVAL '1 hour' WHERE user_id=$1", [customerId]);
    const expired = await call('/api/license', { cookie: customerCookie });
    assert.equal(expired.body.tier, 'free');
    assert.equal(expired.body.trialAvailable, false);
    assert.equal((await call('/api/analytics', { cookie: customerCookie })).status, 402);
    assert.equal((await call('/api/license/trial', { body: {}, cookie: customerCookie })).status, 409);

    // Only admins grant licenses; the owner cannot be changed.
    await assertPlanningLocked(customerCookie);
    assert.equal((await call(`/api/admin/users/${customerId}/license`, { body: { action: 'grant' }, cookie: customerCookie })).status, 403);
    assert.equal((await call('/api/admin/users/1/license', { body: { action: 'revoke' }, cookie: ownerCookie })).status, 400);
    assert.equal((await call(`/api/admin/users/${customerId}/license`, { body: { action: 'bogus' }, cookie: ownerCookie })).status, 400);
    assert.equal((await call('/api/admin/users/999/license', { body: { action: 'grant' }, cookie: ownerCookie })).status, 404);
    const granted = await call(`/api/admin/users/${customerId}/license`, { body: { action: 'grant' }, cookie: ownerCookie });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.license.tier, 'pro');
    assert.equal(granted.body.license.plusActive, false);
    await assertPlanningLocked(customerCookie);
    assert.equal((await call(`/api/admin/users/${customerId}/license`, { body: { action: 'grant', plan: 'invalid' }, cookie: ownerCookie })).status, 400);
    assert.equal((await call(`/api/admin/users/${customerId}/license`, { body: { action: 'grant', plan: 'pro_plus' }, cookie: customerCookie })).status, 403);
    assert.equal((await call('/api/license', { cookie: customerCookie })).body.source, 'license');
    const users = (await call('/api/admin/users', { cookie: ownerCookie })).body;
    assert.equal(users.find(user => user.id === 1).license.source, 'owner');
    assert.equal(users.find(user => user.id === customerId).license.tier, 'pro');

    // Budgets are validated and private to each account.
    assert.equal((await call('/api/budgets', { method: 'PUT', body: { budgets: [{ category: 'Groceries', amount: -1 }] }, cookie: customerCookie })).status, 400);
    const put = await call('/api/budgets', { method: 'PUT', body: { budgets: [{ category: 'Groceries', amount: 600 }, { category: 'Dining', amount: 0 }] }, cookie: customerCookie });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.budgets, [{ category: 'Groceries', amount: 600 }]);
    assert.deepEqual((await call('/api/budgets', { cookie: ownerCookie })).body.budgets, []);
    await call('/api/budgets', { method: 'PUT', body: { budgets: [{ category: 'Travel', amount: 250 }] }, cookie: ownerCookie });
    assert.deepEqual((await call('/api/budgets', { cookie: customerCookie })).body.budgets, [{ category: 'Groceries', amount: 600 }]);

    // Analytics and export only use the signed-in account's data.
    const day = new Date();
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-01`;
    await database.query("INSERT INTO transactions (user_id,date,description,amount,direction,category) VALUES ($1,$2,'SHOPRITE 12',120,'DEBIT','Groceries'), (1,$2,'OWNER SECRET',999,'DEBIT','Travel')", [customerId, date]);
    const analytics = await call('/api/analytics', { cookie: customerCookie });
    const groceries = analytics.body.categories.find(category => category.name === 'Groceries');
    assert.equal(groceries.mtd, 120);
    assert.equal(groceries.budget, 600);
    assert.equal(analytics.body.categories.some(category => category.name === 'Travel'), false);
    const csv = await call('/api/analytics/export.csv?type=transactions', { cookie: customerCookie });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.body, /SHOPRITE 12/);
    assert.doesNotMatch(csv.body, /OWNER SECRET/);

    const plusGrant = await call(`/api/admin/users/${customerId}/license`, { body: { action: 'grant', plan: 'pro_plus' }, cookie: ownerCookie });
    assert.equal(plusGrant.body.license.tier, 'pro_plus');
    assert.equal(plusGrant.body.license.plusActive, true);
    const plusUsers = (await call('/api/admin/users', { cookie: ownerCookie })).body;
    assert.equal(plusUsers.find(user => user.id === customerId).license.tier, 'pro_plus');
    const goal = await call('/api/goals', { body: { name: 'Emergency fund', target_amount: 1000, monthly_contribution: 100, contribution_day: 15 }, cookie: customerCookie });
    assert.equal(goal.status, 200);
    const debt = await call('/api/debts', { body: { name: 'My card', balance: 500, apr: 20, min_payment: 25 }, cookie: customerCookie });
    assert.equal(debt.status, 200);
    assert.equal((await call('/api/plan', { cookie: customerCookie })).body.pro, true);
    assert.equal((await call('/api/plan/what-if', { body: { extra: 100 }, cookie: customerCookie })).status, 200);
    const plusTimeline = (await call('/api/dashboard/upcoming-payments', { body: {}, cookie: customerCookie })).body;
    assert.ok(plusTimeline.some(item => item.planned), 'Pro Plus includes planning calendar items');

    // Downgrades lock planning immediately without deleting the saved data.
    await call(`/api/admin/users/${customerId}/license`, { body: { action: 'grant', plan: 'pro' }, cookie: ownerCookie });
    await assertPlanningLocked(customerCookie);
    assert.equal((await call('/api/analytics', { cookie: customerCookie })).status, 200);
    const proTimeline = (await call('/api/dashboard/upcoming-payments', { body: {}, cookie: customerCookie })).body;
    assert.equal(proTimeline.some(item => item.planned), false);
    const proPulse = (await call('/api/dashboard/insights', { cookie: customerCookie })).body;
    assert.equal(proPulse.pulse.debtFreeDate, null);
    await call(`/api/admin/users/${customerId}/license`, { body: { action: 'grant', plan: 'pro_plus' }, cookie: ownerCookie });
    assert.equal((await call('/api/goals', { cookie: customerCookie })).body[0].name, 'Emergency fund');
    assert.equal((await call('/api/debts', { cookie: customerCookie })).body[0].name, 'My card');

    // Revocation removes access immediately.
    assert.equal((await call(`/api/admin/users/${customerId}/license`, { body: { action: 'revoke' }, cookie: ownerCookie })).status, 200);
    assert.equal((await call('/api/analytics', { cookie: customerCookie })).status, 402);
    await assertPlanningLocked(customerCookie);
  } finally {
    server.close();
    for (const [key, value] of [['OWNER_SETUP_TOKEN', saved.token], ['ALLOW_REGISTRATION', saved.registration], ['APP_ORIGIN', saved.origin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
