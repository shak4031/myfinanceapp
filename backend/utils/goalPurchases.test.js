import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import { configureTestMail, grantFixtureAccess } from './paidFixture.js';
import { validateGoalPurchase, normalizeGoalPurchase, buildGoalPurchasePayments } from './goalPurchases.js';
import application from '../app.js';

configureTestMail();
const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

test('goal purchase validation separates cash dates from card-payment dates and rejects invalid input', () => {
  const input = { merchant: ' Supplies ', amount: 3500, purchase_date: '2026-11-09', payment_method: 'cash' };
  assert.deepEqual(validateGoalPurchase(input), { ...input, merchant: 'Supplies', payment_date: input.purchase_date });
  assert.equal(validateGoalPurchase({ ...input, payment_method: 'credit', payment_date: '2026-12-05' }).payment_date, '2026-12-05');
  for (const changes of [{ amount: 0 }, { amount: 0.001 }, { amount: 'junk' }, { amount: Infinity }, { merchant: '' },
    { purchase_date: '2026-02-30' }, { purchase_date: '2026-13-01' }, { purchase_date: '2026-00-01' },
    { payment_method: 'other' }, { payment_method: 'credit' },
    { payment_method: 'credit', payment_date: '2026-11-08' }]) {
    assert.throws(() => validateGoalPurchase({ ...input, ...changes }), error => error.status === 400);
  }
});

test('one-time purchase projections keep overdue items, never repeat, and use card-payment dates only', () => {
  const base = { id: 1, goal_id: 5, goal_name: 'Shed', merchant: 'Supplies', amount: '3500.00',
    purchase_date: new Date(2026, 10, 9), payment_date: new Date(2026, 10, 9), payment_method: 'cash', status: 'planned' };
  const cash = normalizeGoalPurchase(base);
  const card = { ...cash, id: 2, payment_method: 'credit', payment_date: '2026-12-05' };
  const rows = [cash, card, { ...cash, id: 3, status: 'recorded' }, { ...cash, id: 4, status: 'cancelled' }];
  const payments = buildGoalPurchasePayments(rows, new Date(2026, 10, 8));
  assert.equal(payments.length, 2);
  assert.deepEqual(payments.map(row => [row.date, row.amount]), [['2026-11-09', 3500], ['2026-12-05', 3500]]);
  assert.ok(payments.every(row => row.oneTime && row.planKind === 'goal-purchase' && row.status === 'projected'));
  const later = buildGoalPurchasePayments(rows, new Date(2026, 11, 15));
  assert.equal(later[0].date, '2026-11-09', 'unresolved old purchases retain their original date, not a new monthly occurrence');
  assert.equal(buildGoalPurchasePayments([card], new Date(2026, 9, 1)).length, 0, 'cash payment outside the horizon is excluded');
});

test('purchase routes persist private plans and feed cash runway independently of savings allocations', async t => {
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
      }, release
    };
  });
  const migrate = async () => {
    const client = await pg.Pool.prototype.connect();
    try { await client.query('BEGIN'); await migratePrivateSchema(client); await client.query('COMMIT'); }
    finally { client.release(); }
  };
  await migrate();
  const saved = { origin: process.env.APP_ORIGIN, setup: process.env.OWNER_SETUP_TOKEN, registration: process.env.ALLOW_REGISTRATION };
  process.env.OWNER_SETUP_TOKEN = 'test-only-goals-setup-token-at-least-32-characters';
  process.env.ALLOW_REGISTRATION = 'true';
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try {
    const owner = await call('/api/auth/setup', { method: 'POST', body: { name: 'Owner', email: 'owner@example.test', password: 'test-only-password-123456', setupToken: process.env.OWNER_SETUP_TOKEN } });
    assert.equal(owner.status, 200);
    const cookie = owner.headers.get('set-cookie').split(';')[0];
    await grantFixtureAccess(database, 1);
    const goal = await call('/api/goals', { method: 'POST', cookie, body: { name: 'Shed', target_amount: 5500, current_amount: 1000, monthly_contribution: 3500, contribution_day: 9 } });
    assert.equal(goal.status, 200);
    const goalId = goal.body.id;
    const settings = await call('/api/plan/settings', { method: 'PUT', cookie, body: { goal_budget: 0 } });
    assert.equal(settings.status, 200);
    const now = new Date();
    const tomorrow = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const later = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 20));
    const input = { merchant: 'Supplies', amount: 3500, purchase_date: tomorrow, payment_method: 'cash' };
    const created = await call(`/api/goals/${goalId}/purchases`, { method: 'POST', cookie, body: input });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const path = `/api/goals/${goalId}/purchases/${created.body.id}`;
    const plan = await call('/api/plan', { cookie });
    assert.equal(plan.body.purchases.length, 1);
    assert.equal(plan.body.goalPlan.allocatedTotal, 0);
    assert.equal(plan.body.goalPlan.goals[0].current, 1000);
    const upcoming = await call('/api/dashboard/upcoming-payments', { method: 'POST', cookie, body: {} });
    assert.equal(upcoming.status, 200);
    const items = upcoming.body.filter(row => row.planKind === 'goal-purchase');
    assert.deepEqual(items.map(row => [row.date, row.amount]), [[tomorrow, 3500]]);
    assert.equal((await call(`/api/goals/${goalId}/purchases`, { method: 'POST', cookie, body: { ...input, amount: 0.001 } })).status, 400);
    assert.equal((await call('/api/goals/999999/purchases', { method: 'POST', cookie, body: input })).status, 404);
    assert.equal((await call(path, { method: 'PUT', cookie, body: { status: 'junk' } })).status, 400);
    assert.equal((await call(path, { method: 'PUT', cookie, body: { ...input, payment_method: 'credit', payment_date: later } })).status, 200);
    const cardForecast = await call('/api/dashboard/upcoming-payments', { method: 'POST', cookie, body: {} });
    assert.deepEqual(cardForecast.body.filter(row => row.planKind === 'goal-purchase').map(row => row.date), [later]);
    await call(`/api/goals/${goalId}`, { method: 'PUT', cookie, body: { included: false } });
    assert.equal((await call('/api/dashboard/upcoming-payments', { method: 'POST', cookie, body: {} })).body.filter(row => row.planKind === 'goal-purchase').length, 1);
    for (const status of ['recorded', 'planned', 'cancelled']) {
      assert.equal((await call(path, { method: 'PUT', cookie, body: { status } })).status, 200);
      const forecast = await call('/api/dashboard/upcoming-payments', { method: 'POST', cookie, body: {} });
      assert.equal(forecast.body.filter(row => row.planKind === 'goal-purchase').length, status === 'planned' ? 1 : 0);
    }
    const other = await call('/api/auth/register', { method: 'POST', body: { name: 'Other', email: 'other@example.test', password: 'test-only-password-123456' } });
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.user.id, 2);
    const otherCookie = other.headers.get('set-cookie').split(';')[0];
    await grantFixtureAccess(database, 2);
    assert.equal((await call('/api/plan', { cookie: otherCookie })).body.purchases.length, 0);
    assert.equal((await call(`/api/goals/${goalId}/purchases`, { method: 'POST', cookie: otherCookie, body: input })).status, 404);
    assert.equal((await call(path, { method: 'PUT', cookie: otherCookie, body: { status: 'planned' } })).status, 404);
    await database.exec("BEGIN; SET LOCAL ROLE finance_app_runtime; SELECT set_config('app.user_id','2',true)");
    assert.equal((await database.query('SELECT * FROM goal_purchases')).rows.length, 0);
    await assert.rejects(database.query(`INSERT INTO goal_purchases(goal_id,merchant,amount,purchase_date,payment_date,payment_method)
      VALUES($1,'Other',1,$2,$2,'cash')`, [goalId, tomorrow]), /foreign key/);
    await database.exec('ROLLBACK');
    await migrate();
    assert.equal((await call('/api/plan', { cookie })).body.purchases.length, 1, 'plans survive a restart migration');
    assert.equal((await call('/api/plan', { cookie })).body.goalPlan.goals[0].current, 1000, 'purchase edits never mutate savings progress');
    await grantFixtureAccess(database, 2, 'basic');
    assert.equal((await call(`/api/goals/${goalId}/purchases`, { method: 'POST', cookie: otherCookie, body: input })).status, 402, 'purchase planning requires Pro');
    assert.equal((await call(`/api/goals/${goalId}`, { method: 'DELETE', cookie })).status, 200);
    assert.equal((await call('/api/plan', { cookie })).body.purchases.length, 0, 'goal deletion cascades to its purchases');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (saved.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved.origin;
    if (saved.setup === undefined) delete process.env.OWNER_SETUP_TOKEN; else process.env.OWNER_SETUP_TOKEN = saved.setup;
    if (saved.registration === undefined) delete process.env.ALLOW_REGISTRATION; else process.env.ALLOW_REGISTRATION = saved.registration;
    await database.close();
  }
});
