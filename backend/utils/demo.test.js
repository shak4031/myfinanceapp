import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import { buildDemoData, resetDemoAccount, msUntilNextReset, DEMO_EMAIL, DEMO_PASSWORD } from './demo.js';
import { entitlementFromRow } from './license.js';
import application from '../app.js';

test('demo data covers a full year with a consistent running balance and realistic patterns', () => {
  const now = new Date('2026-10-17T15:00:00Z');
  const data = buildDemoData(now);
  const dates = data.transactions.map(row => row.date);
  assert.equal(dates[0] >= '2025-10-18', true);
  assert.equal(dates.at(-1) <= '2026-10-17', true);
  assert.equal(new Set(dates.map(date => date.slice(0, 7))).size, 13);
  assert.ok(data.transactions.length > 600);
  assert.deepEqual(buildDemoData(now), data, 'deterministic for the same day');
  let balance = 6850;
  for (const row of data.transactions) {
    balance = Math.round((balance + (row.direction === 'CREDIT' ? row.amount : -row.amount)) * 100) / 100;
    assert.equal(row.balance, balance);
  }
  assert.ok(balance > 0, 'the account never ends overdrawn');
  const fixed = data.transactions.filter(row => row.is_fixed);
  assert.ok(fixed.some(row => row.pay_mode === 'auto') && fixed.some(row => row.pay_mode === 'manual'));
  assert.ok(data.transactions.every(row => row.direction === 'DEBIT' || row.pay_mode === null));
  const netflix = data.transactions.filter(row => row.description === 'NETFLIX.COM').map(row => row.amount);
  assert.equal(netflix[0], 15.49);
  assert.equal(netflix.at(-1), 17.99, 'includes a subscription price increase');
  assert.ok(data.transactions.some(row => row.description.startsWith('ZELLE')));
  assert.ok(msUntilNextReset(new Date('2026-10-17T07:00:00Z')) === 3600000);
  assert.ok(msUntilNextReset(new Date('2026-10-17T09:00:00Z')) === 23 * 3600000);
});

test('demo email is always Pro, even without a license row', () => {
  assert.equal(entitlementFromRow(5, null, new Date(), DEMO_EMAIL).source, 'demo');
  assert.equal(entitlementFromRow(5, { email: 'Demo@MyFinance.app', revoked_at: new Date() }).tier, 'pro');
  assert.equal(entitlementFromRow(5, { email: 'someone@example.com' }).tier, 'free');
});

test('demo account resets cleanly, signs in with the published password and unlocks every page', async t => {
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
  const saved = { origin: process.env.APP_ORIGIN };
  const run = async callback => {
    const client = await pg.Pool.prototype.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } finally { client.release(); }
  };
  await run(client => migratePrivateSchema(client));
  // Another account's data must survive the demo reset untouched.
  await run(async client => {
    await client.query("INSERT INTO users (id,name,email,role,password_hash) VALUES (7,'Other','other@example.com','user','x')");
    await client.query("INSERT INTO transactions (date,description,amount,direction,user_id) VALUES ('2026-10-01','KEEP ME',10,'DEBIT',7)");
  });
  const first = await run(client => resetDemoAccount(client));
  const second = await run(client => resetDemoAccount(client));
  assert.equal(first.userId, second.userId);
  const counts = (await run(client => client.query(`SELECT user_id, COUNT(*)::int AS n FROM transactions GROUP BY user_id ORDER BY user_id`))).rows;
  assert.deepEqual(counts.sort((a, b) => a.user_id - b.user_id), [{ user_id: first.userId, n: second.transactions }, { user_id: 7, n: 1 }].sort((a, b) => a.user_id - b.user_id));

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
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
  };
  try {
    const login = await call('/api/auth/login', { body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const license = await call('/api/license', { cookie });
    assert.deepEqual([license.body.tier, license.body.source, license.body.active], ['pro', 'demo', true]);
    assert.equal((await call('/api/license/trial', { cookie, body: {} })).status, 409);
    const summary = await call('/api/dashboard/summary', { cookie, body: {} });
    assert.equal(summary.status, 200);
    assert.ok(summary.body.balance > 0);
    const transactions = await call('/api/dashboard/all-transactions', { cookie });
    assert.equal(transactions.body.transactions.length, second.transactions);
    assert.ok(!transactions.body.transactions.some(row => row.description === 'KEEP ME'));
    const upcoming = await call('/api/dashboard/upcoming-payments', { cookie, body: {} });
    assert.equal(upcoming.status, 200);
    const analytics = await call('/api/analytics', { cookie });
    assert.equal(analytics.status, 200);
    for (const path of ['/api/budgets', '/api/goals', '/api/debts', '/api/categories']) {
      const response = await call(path, { cookie });
      assert.equal(response.status, 200, path);
    }
    assert.equal((await call('/api/goals', { cookie })).body.length, 3);
    assert.equal((await call('/api/debts', { cookie })).body.length, 3);
  } finally {
    server.close();
    if (saved.origin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved.origin;
  }
});
