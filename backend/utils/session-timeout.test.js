import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { tokenHash } from './passwords.js';

test('sessions enforce ten-minute inactivity, explicit renewal, absolute expiry and rollout revocation', async t => {
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
  await database.exec(`CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE,role TEXT);
    INSERT INTO users(id,name) VALUES(1,'Owner');
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('old-session',1,NOW()+INTERVAL '7 days');`);
  const migrate = async () => {
    const client = await pg.Pool.prototype.connect();
    try { await client.query('BEGIN'); await migratePrivateSchema(client); await client.query('COMMIT'); }
    finally { client.release(); }
  };
  await migrate();
  assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM sessions')).rows[0].count, 0, 'rollout revokes legacy sessions');
  const saved = Object.fromEntries(['OWNER_SETUP_TOKEN', 'APP_ORIGIN'].map(key => [key, process.env[key]]));
  process.env.OWNER_SETUP_TOKEN = 'test-session-setup-token-longer-than-32-characters';
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  let cookie = '';
  const call = async (path, body, origin = base) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const credentials = { email: 'timeout@example.test', password: 'timeout-test-password-123456' };
  let hash;
  const login = async () => {
    cookie = '';
    const response = await call('/api/auth/login', credentials);
    assert.equal(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.doesNotMatch(setCookie.split('finance_support')[0], /Max-Age=604800|Expires=/i, 'login cookie is not persistent');
    cookie = setCookie.split(';')[0];
    hash = tokenHash(cookie.split('=')[1]);
    return response;
  };
  const age = seconds => database.query("UPDATE sessions SET last_activity_at=NOW()-($1 * INTERVAL '1 second') WHERE token_hash=$2", [seconds, hash]);
  const session = async () => (await database.query('SELECT * FROM sessions WHERE token_hash=$1', [hash])).rows[0];
  try {
    const setup = await call('/api/auth/setup', { ...credentials, name: 'Owner', setupToken: process.env.OWNER_SETUP_TOKEN });
    assert.equal(setup.status, 200);
    await login();
    const initial = await session();
    assert.ok(initial.expires_at - initial.created_at <= 12 * 3600000 + 1000);
    await age(599);
    const beforePoll = await session();
    const allowed = await call('/api/auth/me');
    assert.equal(allowed.status, 200, 'just below ten minutes remains valid');
    assert.ok(Date.parse(allowed.headers.get('x-session-idle-expires')) <= Date.now() + 1100);
    await call('/api/accounts');
    assert.equal(+(await session()).last_activity_at, +beforePoll.last_activity_at, 'API polling and session checks never renew inactivity');
    const renewed = await call('/api/auth/activity', {});
    assert.equal(renewed.status, 200);
    assert.ok(Date.parse(renewed.headers.get('x-session-idle-expires')) > Date.now() + 590000);
    await age(60);
    const delayed = await call('/api/auth/activity', { idleMs: 14000 });
    assert.equal(delayed.status, 200);
    const ageMs = Date.now() - +(await session()).last_activity_at;
    assert.ok(ageMs >= 14000 && ageMs < 15500, 'batched activity retains the time of the actual interaction');
    for (const idleMs of [-1, 15001, '0', 0.1]) assert.equal((await call('/api/auth/activity', { idleMs })).status, 400);
    await age(600);
    assert.equal((await call('/api/auth/me')).status, 401, 'exact ten minute boundary is expired');
    assert.equal((await call('/api/auth/activity', {})).status, 401, 'expired cookies cannot be revived');
    assert.equal((await call('/api/accounts')).status, 401, 'financial APIs enforce idle expiry');
    await login();
    const beforeOrigin = await session();
    assert.equal((await call('/api/auth/activity', {}, 'https://other.example')).status, 403);
    assert.equal(+(await session()).last_activity_at, +beforeOrigin.last_activity_at, 'cross-origin activity cannot renew');
    await database.query("UPDATE sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1", [hash]);
    assert.equal((await call('/api/auth/activity', {})).status, 401, 'activity cannot bypass absolute expiry');
    await login();
    await migrate();
    assert.equal((await call('/api/auth/me')).status, 200, 'later restarts preserve valid new-policy sessions');
    assert.equal((await call('/api/auth/logout', {})).status, 200);
    assert.equal((await call('/api/auth/me')).status, 401, 'revoked cookies cannot be replayed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await database.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
