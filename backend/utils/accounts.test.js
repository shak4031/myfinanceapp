import assert from 'node:assert/strict';
import { configureTestMail, grantFixtureAccess } from './paidFixture.js';
configureTestMail();
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import auth, { requireUser, enforceSameOrigin } from '../routes/auth.js';
import Database from '../db.js';
import { migratePrivateSchema } from './schema.js';
import application from '../app.js';

test('HTTP account setup, registration, sessions, CSRF and private records work end to end', async t => {
  const database = new PGlite();
  const adapter = {
    async query(sql, params) {
      const results = params?.length ? [await database.query(sql, params)] : await database.exec(sql);
      const result = results[results.length - 1] || { rows: [] };
      return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    },
    release() {}
  };
  t.mock.method(pg.Pool.prototype, 'connect', async () => adapter);
  const oldToken = process.env.OWNER_SETUP_TOKEN;
  const oldRegistration = process.env.ALLOW_REGISTRATION;
  const oldOrigin = process.env.APP_ORIGIN;
  process.env.OWNER_SETUP_TOKEN = 'test-only-setup-token-longer-than-32-characters';
  process.env.ALLOW_REGISTRATION = 'true';
  await adapter.query('BEGIN');
  await migratePrivateSchema(adapter);
  await adapter.query('COMMIT');
  const app = express();
  app.use(express.json());
  app.use(enforceSameOrigin);
  app.use('/auth', auth);
  app.use('/private', requireUser);
  const db = new Database();
  app.get('/private/records', async (req, res, next) => {
    try { res.json(await db.all('SELECT * FROM transactions ORDER BY id')); } catch (error) { next(error); }
  });
  app.post('/private/records', async (req, res, next) => {
    try {
      const result = await db.run("INSERT INTO transactions (date,description,amount,direction,is_fixed) VALUES ((date_trunc('month',CURRENT_DATE)-INTERVAL '1 day')::date::text,$1,100,'DEBIT',true) RETURNING id,user_id", [req.body.description]);
      res.json(result.rows[0]);
    } catch (error) { next(error); }
  });
  app.use('/app', application);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  async function request(path, body, cookie, origin = base) {
    return fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  const account = (email, extra = {}) => ({ name: 'Test Account', email, password: 'test-only-password-123456', ...extra });
  try {
    assert.equal((await request('/private/records')).status, 401);
    assert.equal((await request('/auth/register', account('second@example.com'))).status, 409);
    assert.equal((await request('/auth/setup', account('owner@example.com', { setupToken: 'wrong' }))).status, 403);
    const ownerResponse = await request('/auth/setup', account('owner@example.com', { setupToken: process.env.OWNER_SETUP_TOKEN }));
    assert.equal(ownerResponse.status, 200);
    const ownerCookie = ownerResponse.headers.get('set-cookie').split(';')[0];
    assert.match(ownerResponse.headers.get('set-cookie'), /HttpOnly/);
    assert.match(ownerResponse.headers.get('set-cookie'), /SameSite=Strict/);
    assert.equal((await ownerResponse.json()).user.id, 1);
    await request('/private/records', { description: 'Owner private mortgage' }, ownerCookie);
    const secondResponse = await request('/auth/register', account('second@example.com'));
    assert.equal(secondResponse.status, 200);
    const secondCookie = secondResponse.headers.get('set-cookie').split(';')[0];
    await grantFixtureAccess(database, 2);
    assert.equal((await request('/app/api/license/trial', {}, secondCookie)).status, 409);
    assert.equal((await request('/private/records', undefined, secondCookie)).status, 200);
    assert.deepEqual(await (await request('/private/records', undefined, secondCookie)).json(), []);
    await request('/private/records', { description: 'Second private bill' }, secondCookie);
    const ownerRows = await (await request('/private/records', undefined, ownerCookie)).json();
    assert.equal(ownerRows.length, 1);
    assert.equal(ownerRows[0].description, 'Owner private mortgage');
    const secondRows = await (await request('/private/records', undefined, secondCookie)).json();
    assert.equal(secondRows.length, 1);
    assert.equal(secondRows[0].description, 'Second private bill');
    const goalResponse = await request('/app/api/goals', {
      name: 'Owner college', target_amount: 12000, current_amount: 1000, target_date: '2027-04-01'
    }, ownerCookie);
    assert.equal(goalResponse.status, 200);
    const goalId = (await goalResponse.json()).id;
    assert.ok(goalId);
    const ownerGoals = await request('/app/api/goals', undefined, ownerCookie);
    assert.equal(ownerGoals.status, 200);
    assert.equal((await ownerGoals.json())[0].name, 'Owner college');
    assert.deepEqual(await (await request('/app/api/goals', undefined, secondCookie)).json(), []);
    assert.equal((await request(`/app/api/goals/${goalId}/contribute`, { amount: 100 }, secondCookie)).status, 404);
    const contribution = await request(`/app/api/goals/${goalId}/contribute`, { amount: 100 }, ownerCookie);
    assert.equal((await contribution.json()).current_amount, 1100);
    const debtResponse = await request('/app/api/debts', {
      name: 'Owner car loan', balance: 20000, apr: 6, min_payment: 400, debt_type: 'auto_loan', due_date: '15'
    }, ownerCookie);
    assert.equal(debtResponse.status, 200);
    const debtId = (await debtResponse.json()).id;
    assert.ok(debtId);
    assert.equal((await (await request('/app/api/debts', {}, ownerCookie)).json())[0].debt_type, 'auto_loan');
    assert.deepEqual(await (await request('/app/api/debts', {}, secondCookie)).json(), []);
    const deleteForeign = await fetch(`${base}/app/api/debts/${debtId}`, {
      method: 'DELETE', headers: { Origin: base, Cookie: secondCookie }
    });
    assert.equal(deleteForeign.status, 404);
    const summary = await request('/app/api/dashboard/summary', { dateFilter: 'current' }, secondCookie);
    assert.equal(summary.status, 200);
    assert.equal((await summary.json()).balance, null);
    const upcoming = await request('/app/api/dashboard/upcoming-payments', {}, secondCookie);
    assert.equal(upcoming.status, 200);
    const secondTimeline = await upcoming.json();
    assert.equal(secondTimeline.some(row => /Owner/.test(row.description)), false);
    assert.equal(secondTimeline.length, 1);
    assert.equal((await request('/app/api/transactions/update-fixed', { id: ownerRows[0].id, is_fixed: false, apply_to_all: true }, secondCookie)).status, 404);
    const unflag = await request('/app/api/transactions/update-fixed', { id: secondRows[0].id, is_fixed: false, apply_to_all: true }, secondCookie);
    assert.equal(unflag.status, 200);
    assert.deepEqual(await (await request('/app/api/dashboard/upcoming-payments', {}, secondCookie)).json(), []);
    const ownerTimeline = await (await request('/app/api/dashboard/upcoming-payments', {}, ownerCookie)).json();
    assert.equal(ownerTimeline.length, 1);
    const ruleResponse = await request('/app/api/transactions/categorization-rules', {
      pattern: 'OWNER PRIVATE MORTGAGE', display_label: 'Owner custom rule', category: 'Mortgage', priority: 10, enabled: true
    }, ownerCookie);
    assert.equal(ruleResponse.status, 200);
    const secondRules = await (await request('/app/api/transactions/categorization-rules', undefined, secondCookie)).json();
    assert.equal(secondRules.rules.some(row => row.display_label === 'Owner custom rule'), false);
    const previewResponse = await request('/app/api/transactions/categorization-preview', { scope: 'uncategorized' }, ownerCookie);
    assert.equal(previewResponse.status, 200);
    const suggestions = (await previewResponse.json()).suggestions;
    assert.equal(suggestions.some(row => row.id === ownerRows[0].id && row.suggestedCategory === 'Mortgage'), true);
    const foreignApply = await request('/app/api/transactions/categorization-apply', {
      updates: [{ id: ownerRows[0].id, category: 'Mortgage', expectedCategory: null }]
    }, secondCookie);
    assert.equal(foreignApply.status, 404);
    const approved = await request('/app/api/transactions/categorization-apply', {
      updates: [{ id: ownerRows[0].id, category: 'Mortgage', expectedCategory: null }]
    }, ownerCookie);
    assert.equal(approved.status, 200);
    const changed = await (await request('/private/records', undefined, ownerCookie)).json();
    assert.equal(changed[0].category, 'Mortgage');
    assert.equal(changed[0].is_fixed, true);
    assert.equal((await request('/app/api/bulk-import/execute-final', {}, ownerCookie)).status, 410);
    assert.equal((await request('/app/api/categorizations-lite/transactions', undefined, secondCookie)).status, 410);
    assert.equal((await request('/app/api/logs', undefined, secondCookie)).status, 403);
    assert.equal((await request('/app/api/categories', undefined, secondCookie)).status, 200);
    const guidance = await request('/app/api/goals/funding-analysis', undefined, ownerCookie);
    assert.equal(guidance.status, 200);
    assert.ok(Array.isArray((await guidance.json()).advice));
    assert.equal((await request('/private/records', { description: 'CSRF' }, secondCookie, 'https://wrong.example')).status, 403);
    assert.equal((await request('/auth/login', { email: 'second@example.com', password: 'wrong-password-123456' })).status, 401);
    const login = await request('/auth/login', account('second@example.com'));
    assert.equal(login.status, 200);
    const loginCookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request('/auth/me', undefined, loginCookie)).status, 200);
    assert.equal((await request('/auth/logout', {}, loginCookie)).status, 200);
    assert.equal((await request('/auth/me', undefined, loginCookie)).status, 401);
    assert.equal((await request('/auth/setup', account('third@example.com', { setupToken: process.env.OWNER_SETUP_TOKEN }))).status, 409);
    for (let i = 0; i < 12; i++) await request('/auth/login', account('no-user@example.com'));
    assert.equal((await request('/auth/login', account('no-user@example.com'))).status, 429);
    const sessions = (await database.query('SELECT token_hash FROM sessions')).rows;
    assert.ok(sessions.every(row => /^[a-f0-9]{64}$/.test(row.token_hash) && !ownerCookie.includes(row.token_hash)));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await database.close();
    for (const [key, value] of Object.entries({ OWNER_SETUP_TOKEN: oldToken, ALLOW_REGISTRATION: oldRegistration, APP_ORIGIN: oldOrigin })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
