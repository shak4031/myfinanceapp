import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import application from '../app.js';
import { setMailTransportForTests } from './mailer.js';
import { sendUnverifiedWarnings, deleteUnverifiedAccounts } from './unverifiedAccounts.js';

test('unverified accounts are warned, can still verify, and are deleted after 15 days', async t => {
  const mails = [];
  setMailTransportForTests({ sendMail: async message => { mails.push(message); return { accepted: [message.to] }; } });
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
  const call = async (path, body) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const password = 'test-only-password-123456';
  try {
    await call('/api/auth/setup', { name: 'Owner', email: 'owner@example.test', password, setupToken: process.env.OWNER_SETUP_TOKEN });
    const ids = {};
    for (const name of ['stale', 'verified', 'fresh', 'rescued']) {
      ids[name] = (await call('/api/auth/register', { name, email: `${name}@example.test`, password })).body.user.id;
    }
    assert.match(mails.find(mail => mail.to === 'fresh@example.test').text, /not verified within 15 days of signup are deleted/);
    const now = new Date();
    await database.query("UPDATE users SET created_at=NOW()-INTERVAL '13 days' WHERE id = ANY($1)", [[ids.stale, ids.verified, ids.rescued]]);
    await database.query('UPDATE users SET email_verified_at=NOW() WHERE id=$1', [ids.verified]);
    mails.length = 0;

    assert.equal(await sendUnverifiedWarnings(now), 2, 'only unverified accounts at least 12 days old are warned');
    assert.deepEqual(mails.map(mail => mail.to).sort(), ['rescued@example.test', 'stale@example.test']);
    assert.equal(await sendUnverifiedWarnings(now), 0, 'each account is warned once');
    assert.equal(await deleteUnverifiedAccounts(now), 0, 'nothing is deleted before the notice period ends');

    const token = mails.find(mail => mail.to === 'rescued@example.test').text.match(/#verify-token=([a-f0-9]+)/)[1];
    assert.equal((await call('/api/auth/verify-email', { token })).status, 200, 'the warning link verifies the account');

    const later = new Date(now.getTime() + 3 * 86400000);
    assert.equal(await deleteUnverifiedAccounts(later), 1);
    const remaining = (await database.query('SELECT email FROM users ORDER BY id')).rows.map(row => row.email);
    assert.deepEqual(remaining, ['owner@example.test', 'verified@example.test', 'fresh@example.test', 'rescued@example.test']);
    const audit = (await database.query("SELECT subject_user_id FROM audit_events WHERE event_type='account.unverified_deleted'")).rows;
    assert.deepEqual(audit.map(row => row.subject_user_id), [ids.stale]);
  } finally {
    server.close();
    for (const [key, env] of [['token', 'OWNER_SETUP_TOKEN'], ['registration', 'ALLOW_REGISTRATION'], ['origin', 'APP_ORIGIN']]) {
      if (saved[key] === undefined) delete process.env[env]; else process.env[env] = saved[key];
    }
    setMailTransportForTests(null);
  }
});
