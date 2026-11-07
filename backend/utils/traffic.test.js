import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { DEMO_EMAIL, DEMO_PASSWORD } from './demo.js';
import { hashPassword, tokenHash } from './passwords.js';
import { ensureHousehold } from './households.js';
import { recordTraffic, trafficReport } from './traffic.js';
import { purgeExpiredAuditEvents } from './audit.js';
import { readFile } from 'node:fs/promises';

test('traffic counters are aggregate-only, protected, calendar-aligned and use real demo login outcomes', async t => {
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
  const savedOrigin = process.env.APP_ORIGIN;
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, { body, cookie, origin = base } = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const client = await pg.Pool.prototype.connect();
    await client.query('BEGIN');
    await migratePrivateSchema(client);
    const encoded = await hashPassword(DEMO_PASSWORD);
    await client.query("UPDATE users SET email='owner@example.test',password_hash=$1 WHERE id=1", [encoded]);
    const demo = (await client.query("INSERT INTO users(name,email,password_hash,role) VALUES('Demo',$1,$2,'user') RETURNING id", [DEMO_EMAIL, encoded])).rows[0];
    await ensureHousehold(client, demo.id);
    const adminToken = 'a'.repeat(64), demoToken = 'b'.repeat(64);
    await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,1,NOW()+INTERVAL '1 hour'),($2,$3,NOW()+INTERVAL '1 hour')", [tokenHash(adminToken), tokenHash(demoToken), demo.id]);
    await client.query('COMMIT');
    client.release();
    const adminCookie = `finance_session=${adminToken}`, demoCookie = `finance_session=${demoToken}`;
    assert.equal((await call('/api/admin/traffic')).status, 401);
    assert.equal((await call('/api/admin/traffic', { cookie: demoCookie })).status, 403);
    for (const days of ['0', '2', '366', 'invalid']) {
      assert.equal((await call(`/api/admin/traffic?days=${days}`, { cookie: adminCookie })).status, 400);
    }
    assert.equal((await call('/api/public-metrics', { body: { event: 'homepage_view' }, origin: 'https://outside.test' })).status, 403);
    for (const body of [{ event: 'secret' }, { event: 'homepage_view', email: 'private@test' }, [], null]) {
      assert.equal((await call('/api/public-metrics', { body })).status, 400);
    }
    assert.equal((await call('/api/public-metrics', { body: { event: 'homepage_view' } })).status, 202);
    assert.equal((await call('/api/public-metrics', { body: { event: 'signup_click' } })).status, 202);
    await Promise.all(Array.from({ length: 5 }, () => call('/api/public-metrics', { body: { event: 'homepage_view' } })));
    assert.equal((await call('/api/auth/login', { body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } })).status, 200);
    assert.equal((await call('/api/auth/login', { body: { email: DEMO_EMAIL, password: 'wrong-password-value' } })).status, 401);
    await database.query(`INSERT INTO audit_events(event_type,outcome,subject_user_id,created_at)
      VALUES ('auth.register','success',$1,NOW()),('auth.register','failure',$1,NOW()),
      ('auth.register','success',$1,NOW()-INTERVAL '40 days'),('household.invite_accepted','success',$1,NOW())`, [demo.id]);
    await database.query(`INSERT INTO traffic_daily(day,event,count) VALUES
      ((NOW() AT TIME ZONE 'UTC')::date-1,'homepage_view',3),
      ((NOW() AT TIME ZONE 'UTC')::date-400,'homepage_view',99)`);
    const report = await call('/api/admin/traffic?days=7', { cookie: adminCookie });
    assert.equal(report.status, 200);
    assert.deepEqual(report.body.totals, { homepage_views: 9, signup_clicks: 1, demo_logins: 1, registrations: 1 });
    assert.equal(report.body.daily.length, 7);
    assert.deepEqual(report.body.daily[2], {
      day: report.body.daily[2].day, homepage_views: 0, signup_clicks: 0, demo_logins: 0, registrations: 0
    });
    const today = await call('/api/admin/traffic?days=1', { cookie: adminCookie });
    assert.equal(today.body.totals.homepage_views, 6);
    assert.equal((await trafficReport(database, 90, DEMO_EMAIL)).totals.registrations, 2);
    const columns = (await database.query("SELECT column_name FROM information_schema.columns WHERE table_name='traffic_daily' ORDER BY ordinal_position")).rows.map(row => row.column_name);
    assert.deepEqual(columns, ['day', 'event', 'count', 'created_at']);
    await assert.rejects(() => recordTraffic(database, 'unknown'), /Invalid traffic event/);
    await database.exec("SET ROLE finance_app_runtime");
    await assert.rejects(() => database.query('SELECT * FROM traffic_daily'), /permission denied/);
    await database.exec('RESET ROLE');
    for (let i = 0; i < 53; i++) await call('/api/public-metrics', { body: { event: 'signup_click' } });
    assert.equal((await call('/api/public-metrics', { body: { event: 'signup_click' } })).status, 429);
    await purgeExpiredAuditEvents();
    assert.equal((await database.query("SELECT count(*)::int AS count FROM traffic_daily WHERE count=99")).rows[0].count, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (savedOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedOrigin;
    await database.close();
  }
});

test('public reporting sends only an event and omits cookies; all signup entry points are wired', async () => {
  const source = await readFile(new URL('../../frontend/session.js', import.meta.url), 'utf8');
  assert.match(source, /nativeFetch\('\/api\/public-metrics'/);
  assert.match(source, /credentials: 'omit', keepalive: true/);
  assert.match(source, /body: JSON\.stringify\(\{ event \}\)/);
  assert.match(source, /if \(mode === 'login'\) reportTraffic\('homepage_view'\)/);
  assert.match(source, /if \(mode === 'register'\) reportTraffic\('signup_click'\)/);
  const homepage = await readFile(new URL('../../frontend/index.html', import.meta.url), 'utf8');
  assert.match(homepage, /href="\/signup">Try MyFinance free for 15 days/);
  const admin = await readFile(new URL('../../frontend/admin.html', import.meta.url), 'utf8');
  assert.match(admin, /data-tab="traffic"/);
  assert.match(admin, /Counts are events, not unique people/);
});
