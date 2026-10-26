import assert from 'node:assert/strict';
import { configureTestMail, grantFixtureAccess } from './paidFixture.js';
configureTestMail();
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import { onLogEntry } from './logger.js';
import application from '../app.js';

// Regression: the dashboard returned "The request could not be completed" for databases created before
// transactions.created_at existed, and any unreadable stored date made every date::date query fail.
test('dashboard survives an upgraded legacy database with old-format and unreadable dates', async t => {
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
  const migrate = async () => {
    const client = await pg.Pool.prototype.connect();
    await client.query('BEGIN');
    await migratePrivateSchema(client);
    await client.query('COMMIT');
    client.release();
  };
  const saved = { token: process.env.OWNER_SETUP_TOKEN, origin: process.env.APP_ORIGIN, registration: process.env.ALLOW_REGISTRATION };
  process.env.OWNER_SETUP_TOKEN = 'test-only-setup-token-longer-than-32-characters';
  process.env.ALLOW_REGISTRATION = 'true';
  await database.exec('CREATE TABLE transactions (id SERIAL PRIMARY KEY, date TEXT, description TEXT, amount NUMERIC(14,2), direction TEXT, balance NUMERIC(14,2), source TEXT)');
  await migrate();

  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, { body, cookie } = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const errors = [];
  const stop = onLogEntry(entry => { if (entry.level === 'error') errors.push(entry); });
  try {
    assert.equal((await call('/api/dashboard/spending-history')).status, 401);
    const owner = await call('/api/auth/setup', { body: { name: 'Owner', email: 'owner@example.com', password: 'test-only-password-123456', setupToken: process.env.OWNER_SETUP_TOKEN } });
    const cookie = owner.headers.get('set-cookie').split(';')[0];
    await database.exec(`INSERT INTO transactions (date, description, amount, direction, balance, user_id) VALUES
      ('10/09/2026', 'PAYROLL', 3586.20, 'CREDIT', 7500, 1), ('2026-10-14', 'NETFLIX', 15.49, 'DEBIT', 7484.51, 1),
      ('10/1/26', 'COFFEE', 5, 'DEBIT', NULL, 1), ('', 'BLANK', 1, 'DEBIT', NULL, 1), ('not a date', 'JUNK', 2, 'DEBIT', NULL, 1)`);
    await migrate(); // simulate the next restart, with FORCE row-level security already active

    const dates = (await database.query('SELECT description, date FROM transactions ORDER BY id')).rows;
    assert.deepEqual(dates.map(row => row.date), ['2026-10-09', '2026-10-14', '2026-10-01', null, null]);
    const columns = (await database.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'created_at'")).rows;
    assert.equal(columns.length, 1);

    const insights = await call('/api/dashboard/insights', { cookie });
    assert.equal(insights.status, 200, JSON.stringify(insights.body));
    assert.equal(insights.body.pulse.balance, 7484.51);
    for (const [path, body] of [['/api/dashboard/summary', { dateFilter: 'current' }], ['/api/dashboard/upcoming-payments', {}], ['/api/dashboard/category-trends', {}]]) {
      const result = await call(path, { cookie, body });
      assert.ok(result.status < 500, `${path} -> ${result.status}`);
    }
    const now = new Date();
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 5);
    const priorDate = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-05`;
    await database.query(`INSERT INTO transactions(date,description,amount,direction,category,user_id) VALUES ($1,'HISTORY SAMPLE',125,'DEBIT','History test',1)`, [priorDate]);
    await database.query(`INSERT INTO category_budgets(user_id,category,monthly_amount) VALUES (1,'History test',100)`);
    const history = await call('/api/dashboard/spending-history', { cookie });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.pro, true);
    assert.equal(history.body.months.length, 6);
    const category = history.body.categories.find(item => item.name === 'History test');
    assert.equal(category.series.at(-1).amount, 125);
    assert.equal(category.stats.monthsOverBudget, 1);
    assert.equal(category.stats.budgetComparison, 'current-budget');
    await database.query(`INSERT INTO transactions(date,description,amount,direction,category,is_fixed,user_id)
      VALUES ($1,'ROLLING BILL',40,'DEBIT','Utilities',true,1)`, [`${priorDate.slice(0, 8)}01`]);
    const rolling = await call('/api/dashboard/upcoming-payments', { cookie, body: {} });
    assert.equal(rolling.status, 200);
    const horizonEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30);
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    assert.ok(rolling.body.length > 0);
    assert.ok(rolling.body.every(item => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.date <= iso(horizonEnd)));
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    if (nextMonth <= horizonEnd) assert.ok(rolling.body.some(item => item.date === iso(nextMonth) && item.status === 'projected'));
    const rollingInsights = await call('/api/dashboard/insights', { cookie });
    assert.equal(rollingInsights.body.pulse.horizonDays, 30);
    const monthly = await call('/api/dashboard/category-spending', { cookie, body: { dateFilter: 'current' } });
    assert.equal(monthly.status, 200);
    assert.ok(monthly.body.every(item => Number.isInteger(item.transactionCount)));
    const second = await call('/api/auth/register', { body: { name: 'Free', email: 'history-free@example.test', password: 'test-only-password-123456' } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const freeCookie = second.headers.get('set-cookie').split(';')[0];
    const freeId = (await database.query("SELECT id FROM users WHERE email='history-free@example.test'")).rows[0].id;
    await grantFixtureAccess(database, freeId, 'basic');
    await database.query(`INSERT INTO transactions(date,description,amount,direction,category,user_id) VALUES ($1,'FREE HISTORY',25,'DEBIT','Free dining',$2)`, [priorDate, freeId]);
    await database.query(`INSERT INTO category_budgets(user_id,category,monthly_amount) VALUES ($1,'Free dining',10)`, [freeId]);
    const freeHistory = await call('/api/dashboard/spending-history', { cookie: freeCookie });
    assert.equal(freeHistory.status, 200);
    assert.equal(freeHistory.body.pro, false);
    assert.equal(freeHistory.body.categories.length, 1, 'history is tenant-scoped');
    assert.equal(freeHistory.body.categories[0].name, 'Free dining');
    assert.equal(freeHistory.body.categories[0].series.at(-1).amount, 25);
    assert.equal(freeHistory.body.categories[0].stats, null, 'the API does not send Pro statistics to Free clients');
    assert.deepEqual(errors.map(entry => entry.message || entry.event), []);
  } finally {
    stop();
    server.close();
    for (const [key, value] of [['OWNER_SETUP_TOKEN', saved.token], ['APP_ORIGIN', saved.origin], ['ALLOW_REGISTRATION', saved.registration]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
