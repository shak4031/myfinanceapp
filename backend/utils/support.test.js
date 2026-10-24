import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import { setMailTransportForTests } from './mailer.js';
import { grantFixtureAccess } from './paidFixture.js';
import { attemptKeysForEmail } from '../routes/auth.js';
import application from '../app.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 150));

test('audit logging, password reset, admin console and consented support access', async t => {
  const database = new PGlite();
  let lock = Promise.resolve();
  // One PGlite connection: serialize checkouts so concurrent transactions never interleave.
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
  const sent = [];
  setMailTransportForTests({ sendMail: async message => { sent.push(message); } });
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
  for (const path of ['/', '/admin.html', '/refresh.js', '/refresh.css', '/client-errors.js']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path} should be served`);
    assert.match(response.headers.get('cache-control'), /no-cache, must-revalidate/);
  }
  const call = async (path, { method, body, cookie } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const cookieFrom = response => response.headers.get('set-cookie').split(';')[0];
  const password = 'test-only-password-123456';
  try {
    const owner = await call('/api/auth/setup', { body: { name: 'Owner', email: 'owner@example.com', password, setupToken: process.env.OWNER_SETUP_TOKEN } });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.user.role, 'admin');
    const adminCookie = cookieFrom(owner);
    const customer = await call('/api/auth/register', { body: { name: 'Customer', email: 'customer@example.com', password } });
    let customerCookie = cookieFrom(customer);
    sent.length = 0; // Verification mail is separate from the password-reset assertions below.
    await grantFixtureAccess(database, customer.body.user.id);
    assert.equal(customer.body.user.role, 'user');
    assert.equal((await call('/api/goals', { body: { name: 'Customer car', target_amount: 30000, target_date: '2027-01-01' }, cookie: customerCookie })).status, 200);
    assert.equal((await call('/api/goals', { body: { name: 'Owner boat', target_amount: 9000, target_date: '2027-01-01' }, cookie: adminCookie })).status, 200);

    // Failed logins are audited and visible to the admin with a correlation ID.
    const failed = await call('/api/auth/login', { body: { email: 'customer@example.com', password: 'wrong-password-123' } });
    assert.equal(failed.status, 401);
    assert.match(failed.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    await settle();
    assert.equal((await call('/api/admin/overview', { cookie: customerCookie })).status, 403);
    const overview = await call('/api/admin/overview', { cookie: adminCookie });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.stats.failed_logins_24h, 1);
    const audit = await call(`/api/admin/audit?requestId=${failed.headers.get('x-request-id')}`, { cookie: adminCookie });
    assert.equal(audit.body.length, 1);
    assert.equal(audit.body[0].event_type, 'auth.login');
    assert.equal(audit.body[0].detail.reason, 'wrong_password');
    assert.equal(audit.body[0].subject_email, 'customer@example.com');
    assert.equal(JSON.stringify(audit.body).includes('wrong-password-123'), false);
    const clientError = await call('/api/client-errors', {
      body: { name: 'TypeError', message: 'token=super-secret amount=123.45 email owner@example.com', file: 'https://assets.example/app.js?token=ignored', line: 8, column: 3 },
      cookie: customerCookie
    });
    assert.equal(clientError.status, 202);
    await settle();
    const errors = await call(`/api/admin/errors?range=24h&requestId=${clientError.headers.get('x-request-id')}`, { cookie: adminCookie });
    assert.equal(errors.status, 200);
    assert.equal(errors.body.length, 1);
    assert.equal(errors.body[0].event_type, 'client.error');
    assert.equal(errors.body[0].detail.file, 'app.js');
    assert.equal(errors.body[0].detail.line, 8);
    assert.doesNotMatch(errors.body[0].detail.message, /super-secret|123\.45|owner@example\.com/);
    assert.equal((await call('/api/admin/errors', { cookie: customerCookie })).status, 403);
    const errorStats = await call('/api/admin/overview', { cookie: adminCookie });
    assert.equal(errorStats.body.stats.server_errors_24h, 0);
    assert.equal(errorStats.body.stats.browser_errors_24h, 1);
    const byEmail = await call('/api/admin/audit?email=CUSTOMER@example.com&eventType=auth.', { cookie: adminCookie });
    assert.ok(byEmail.body.some(row => row.event_type === 'auth.login' && row.outcome === 'failure'));
    const users = await call('/api/admin/users', { cookie: adminCookie });
    assert.deepEqual(users.body.map(user => user.email), ['owner@example.com', 'customer@example.com']);
    assert.equal(JSON.stringify(users.body).includes('Customer car'), false);
    assert.equal((await call('/api/admin/openapi.json', { cookie: adminCookie })).body.openapi, '3.0.3');

    // Password reset: same response for unknown emails, single-use token, sessions revoked.
    const unknown = await call('/api/auth/password-reset/request', { body: { email: 'nobody@example.com' } });
    assert.equal(unknown.status, 202);
    assert.equal(sent.length, 0);
    const requested = await call('/api/auth/password-reset/request', { body: { email: 'customer@example.com' } });
    assert.equal(requested.status, 202);
    assert.equal(requested.body.message, unknown.body.message);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'customer@example.com');
    const resetToken = sent[0].text.match(/#reset-token=([a-f0-9]{64})/)[1];
    assert.equal((await call('/api/auth/password-reset/confirm', { body: { token: resetToken, password: 'short' } })).status, 400);
    const newPassword = 'brand-new-password-98765';
    assert.equal((await call('/api/auth/password-reset/confirm', { body: { token: resetToken, password: newPassword } })).status, 200);
    assert.equal((await call('/api/auth/password-reset/confirm', { body: { token: resetToken, password: newPassword } })).status, 400);
    assert.equal((await call('/api/goals', { cookie: customerCookie })).status, 401);
    assert.equal((await call('/api/auth/login', { body: { email: 'customer@example.com', password } })).status, 401);
    const relogin = await call('/api/auth/login', { body: { email: 'customer@example.com', password: newPassword } });
    assert.equal(relogin.status, 200);
    customerCookie = cookieFrom(relogin);

    // Signed-in password change: current password required, this device stays signed in, other devices are signed out.
    const otherDevice = cookieFrom(await call('/api/auth/login', { body: { email: 'customer@example.com', password: newPassword } }));
    const changedPassword = 'changed-in-app-password-1';
    assert.equal((await call('/api/auth/password', { body: { currentPassword: newPassword, newPassword: 'short' }, cookie: customerCookie })).status, 400);
    assert.equal((await call('/api/auth/password', { body: { currentPassword: newPassword, newPassword }, cookie: customerCookie })).status, 400);
    const wrongCurrent = await call('/api/auth/password', { body: { currentPassword: 'not-my-password-123', newPassword: changedPassword }, cookie: customerCookie });
    assert.equal(wrongCurrent.status, 401);
    assert.equal((await call('/api/goals', { cookie: customerCookie })).status, 200, 'a wrong current password does not sign you out');
    assert.equal((await call('/api/auth/password', { body: { currentPassword: newPassword, newPassword: changedPassword } })).status, 401);
    const noticesBefore = sent.length;
    const changed = await call('/api/auth/password', { body: { currentPassword: newPassword, newPassword: changedPassword }, cookie: customerCookie });
    assert.equal(changed.status, 200);
    assert.equal((await call('/api/goals', { cookie: customerCookie })).status, 200);
    assert.equal((await call('/api/goals', { cookie: otherDevice })).status, 401);
    assert.equal((await call('/api/auth/login', { body: { email: 'customer@example.com', password: newPassword } })).status, 401);
    assert.equal((await call('/api/auth/login', { body: { email: 'customer@example.com', password: changedPassword } })).status, 200);
    await settle();
    assert.ok(sent.slice(noticesBefore).some(message => message.subject.includes('password was changed')));
    assert.equal((await call('/api/auth/password', { body: { currentPassword: changedPassword, newPassword }, cookie: customerCookie })).status, 200);

    // Admin-initiated reset emails the customer; the admin never receives the token.
    const adminReset = await call('/api/admin/users/2/password-reset', { body: {}, cookie: adminCookie });
    assert.equal(adminReset.status, 200);
    assert.equal(JSON.stringify(adminReset.body).match(/[a-f0-9]{64}/), null);
    assert.equal(sent.at(-1).to, 'customer@example.com');

    // Support access requires the customer's grant.
    assert.equal((await call('/api/admin/support-sessions', { body: { grantId: 1 }, cookie: adminCookie })).status, 404);
    assert.equal((await call('/api/support-access', { body: { accessLevel: 'read', hours: 2, reason: 'x' }, cookie: customerCookie })).status, 400);
    const grant = await call('/api/support-access', { body: { accessLevel: 'read', hours: 2, reason: 'Upcoming payments look wrong' }, cookie: customerCookie });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.accessLevel, 'read');
    assert.equal((await call('/api/admin/support-grants', { cookie: adminCookie })).body[0].id, grant.body.id);
    assert.equal((await call('/api/admin/support-sessions', { body: { grantId: grant.body.id }, cookie: customerCookie })).status, 403);
    const started = await call('/api/admin/support-sessions', { body: { grantId: grant.body.id }, cookie: adminCookie });
    assert.equal(started.status, 200);
    assert.match(started.headers.get('set-cookie'), /finance_support=[a-f0-9]{64}; .*HttpOnly/);
    const supportCookie = `${adminCookie}; ${cookieFrom(started)}`;
    // The support cookie alone is never a usable session.
    assert.equal((await call('/api/goals', { cookie: cookieFrom(started).replace('finance_support', 'finance_session') })).status, 401);
    const me = await call('/api/auth/me', { cookie: supportCookie });
    assert.equal(me.body.user.email, 'customer@example.com');
    assert.equal(me.body.support.actor.email, 'owner@example.com');
    assert.equal(me.body.support.accessLevel, 'read');
    const supportGoals = await call('/api/goals', { cookie: supportCookie });
    assert.deepEqual(supportGoals.body.map(goal => goal.name), ['Customer car']);
    assert.equal((await call('/api/dashboard/summary', { body: { dateFilter: 'current' }, cookie: supportCookie })).status, 200);
    const blockedWrite = await call('/api/goals', { body: { name: 'Sneaky', target_amount: 1 }, cookie: supportCookie });
    assert.equal(blockedWrite.status, 403);
    assert.equal((await call('/api/auth/password', { body: { currentPassword: password, newPassword: 'support-chosen-password' }, cookie: supportCookie })).status, 403);
    assert.equal((await call('/api/admin/overview', { cookie: supportCookie })).status, 403);
    assert.equal((await call('/api/support-access', { cookie: supportCookie })).status, 403);
    await settle();
    const activity = await call('/api/support-access', { cookie: customerCookie });
    assert.ok(activity.body.activity.some(row => row.event_type === 'support.session_started' && row.actor_name === 'Owner'));
    assert.ok(activity.body.activity.some(row => row.event_type === 'support.request' && row.path === '/api/goals' && row.method === 'GET'));
    assert.ok(activity.body.activity.some(row => row.event_type === 'support.request' && row.status === 403));
    assert.ok(sent.some(message => message.subject.includes('Support is viewing')));

    // Revoking ends access immediately; the admin falls back to their own account.
    assert.equal((await call(`/api/support-access/${grant.body.id}`, { method: 'DELETE', cookie: adminCookie })).status, 404);
    assert.equal((await call(`/api/support-access/${grant.body.id}`, { method: 'DELETE', cookie: customerCookie })).status, 200);
    const afterRevoke = await call('/api/goals', { cookie: supportCookie });
    assert.deepEqual(afterRevoke.body.map(goal => goal.name), ['Owner boat']);
    assert.match(afterRevoke.headers.get('set-cookie'), /finance_support=;/);

    // Edit access must be explicitly granted.
    const writeGrant = await call('/api/support-access', { body: { accessLevel: 'write', hours: 1, reason: 'Fix my goal amount' }, cookie: customerCookie });
    const writeSession = await call('/api/admin/support-sessions', { body: { grantId: writeGrant.body.id }, cookie: adminCookie });
    const writeCookie = `${adminCookie}; ${cookieFrom(writeSession)}`;
    assert.equal((await call('/api/goals', { body: { name: 'Support-added fund', target_amount: 500, target_date: '2027-01-01' }, cookie: writeCookie })).status, 200);
    assert.equal((await call('/api/auth/end-support', { body: {}, cookie: writeCookie })).status, 200);
    const customerGoals = await call('/api/goals', { cookie: customerCookie });
    assert.deepEqual(customerGoals.body.map(goal => goal.name).sort(), ['Customer car', 'Support-added fund']);
    assert.equal((await call('/api/goals', { cookie: writeCookie })).body.some(goal => goal.name === 'Support-added fund'), false);

    // Lockouts are audited and can be cleared by the admin.
    for (let i = 0; i < 11; i += 1) await call('/api/auth/login', { body: { email: 'customer@example.com', password: 'wrong-password-123' } });
    assert.equal((await call('/api/auth/login', { body: { email: 'customer@example.com', password: newPassword } })).status, 429);
    await settle();
    assert.ok((await call('/api/admin/audit?eventType=auth.locked', { cookie: adminCookie })).body.length >= 1);
    assert.equal((await call('/api/admin/users/2/unlock', { body: {}, cookie: adminCookie })).status, 200);
    // IP-level counter still applies to this test client, so verify the email key was cleared directly.
    const keys = await database.query('SELECT COUNT(*)::int AS count FROM auth_attempts WHERE key = ANY($1)', [attemptKeysForEmail('customer@example.com')]);
    assert.equal(keys.rows[0].count, 0);

    // Audit rows cannot be altered.
    await assert.rejects(database.query("UPDATE audit_events SET outcome='success'"), /append-only/);
  } finally {
    server.close();
    setMailTransportForTests(null);
    for (const [key, value] of [['OWNER_SETUP_TOKEN', saved.token], ['ALLOW_REGISTRATION', saved.registration], ['APP_ORIGIN', saved.origin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
