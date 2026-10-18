import assert from 'node:assert/strict';
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
  const saved = { token: process.env.OWNER_SETUP_TOKEN, origin: process.env.APP_ORIGIN };
  process.env.OWNER_SETUP_TOKEN = 'test-only-setup-token-longer-than-32-characters';
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
    assert.deepEqual(errors.map(entry => entry.message || entry.event), []);
  } finally {
    stop();
    server.close();
    for (const [key, value] of [['OWNER_SETUP_TOKEN', saved.token], ['APP_ORIGIN', saved.origin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
