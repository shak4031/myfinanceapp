import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { hashPassword, tokenHash } from './passwords.js';
import { ensureHousehold } from './households.js';
import { totp, matchingStep, encryptSecret, decryptSecret, newSecret } from './mfa.js';
import { trustedCookieName } from '../routes/auth.js';
import { browserIsTrusted, rememberBrowser } from './trustedBrowsers.js';

test('SHA-256 TOTP RFC vectors, replay window and authenticated secret encryption', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
  for (const [seconds, code] of [[59, '119246'], [1111111109, '084774'], [1111111111, '062674'],
    [1234567890, '819424'], [2000000000, '698825'], [20000000000, '737706']]) {
    assert.equal(totp(secret, Math.floor(seconds / 30)), code);
  }
  assert.equal(matchingStep(secret, '119246', -1, 59000), 1);
  assert.equal(matchingStep(secret, '119246', 1, 59000), null);
  assert.equal(matchingStep(secret, '119246', -1, 120000), null);
  assert.equal(matchingStep(secret, '1234567'), null);
  assert.match(newSecret(), /^[A-Z2-7]{51}[AQ]$/);
  const old = process.env.MFA_ENCRYPTION_KEY;
  try {
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const encrypted = encryptSecret(secret, 1);
    assert.equal(decryptSecret(encrypted, 1), secret);
    assert.notEqual(encryptSecret(secret, 1), encrypted);
    assert.throws(() => decryptSecret(encrypted, 2));
    const parts = encrypted.split(':');
    parts[1] = Buffer.alloc(16).toString('base64');
    assert.throws(() => decryptSecret(parts.join(':'), 1));
    delete process.env.MFA_ENCRYPTION_KEY;
    assert.throws(() => encryptSecret(secret, 1), /MFA_ENCRYPTION_KEY/);
  } finally {
    if (old === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = old;
  }
});

test('optional MFA enrollment, session gating, recovery, reset preservation and management authorization', async t => {
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
  const oldKey = process.env.MFA_ENCRYPTION_KEY, oldOrigin = process.env.APP_ORIGIN;
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const password = 'test-password-only-1234', email = 'owner@example.test';
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, body, cookie) => {
    const response = await fetch(base + '/api/auth' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const cookies = response.headers.getSetCookie();
    return { status: response.status, body: await response.json(),
      cookie: cookies.find(value => value.startsWith('finance_session='))?.split(';')[0],
      trustedCookie: cookies.find(value => value.startsWith(`${trustedCookieName}=`))?.split(';')[0],
      cookies };
  };
  try {
    const client = await pg.Pool.prototype.connect();
    await client.query('BEGIN');
    await migratePrivateSchema(client);
    await client.query('UPDATE users SET email=$1,password_hash=$2 WHERE id=1', [email, await hashPassword(password)]);
    await ensureHousehold(client, 1);
    await client.query("INSERT INTO users(name,email,password_hash) VALUES('Demo','demo@myfinance.app',$1)", [await hashPassword(password)]);
    await client.query('COMMIT');
    client.release();
    const first = await call('/login', { email, password });
    assert.equal(first.status, 200);
    assert.ok(first.cookie?.startsWith('finance_session='));
    const second = await call('/login', { email, password });
    const cookie = first.cookie;
    assert.equal((await call('/mfa')).status, 401);
    assert.equal((await call('/mfa', undefined, cookie)).body.enabled, false);
    assert.equal((await call('/mfa/enroll', { password: 'wrong' }, cookie)).status, 403);
    delete process.env.MFA_ENCRYPTION_KEY;
    assert.equal((await call('/mfa/enroll', { password }, cookie)).status, 503);
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    const enroll = await call('/mfa/enroll', { password }, cookie);
    assert.equal(enroll.status, 200);
    assert.match(enroll.body.uri, /^otpauth:\/\/totp\/MyFinance/);
    const enrollmentUri = new URL(enroll.body.uri);
    assert.equal(enrollmentUri.searchParams.get('algorithm'), 'SHA256');
    assert.equal(enrollmentUri.searchParams.get('digits'), '6');
    assert.equal(enrollmentUri.searchParams.get('period'), '30');
    assert.equal(enrollmentUri.searchParams.get('secret'), enroll.body.secret);
    assert.match(enroll.body.secret, /^[A-Z2-7]{51}[AQ]$/);
    assert.equal((await call('/mfa', undefined, cookie)).body.enabled, false);
    assert.equal((await call('/mfa/confirm', { password, code: 'invalid' }, cookie)).status, 403);
    const expiredSecret = enroll.body.secret;
    await database.query("UPDATE user_mfa SET pending_expires_at=NOW()-INTERVAL '1 second'");
    assert.equal((await call('/mfa/confirm', { password, code: totp(expiredSecret, Math.floor(Date.now() / 30000)) }, cookie)).status, 409);
    const activeEnroll = await call('/mfa/enroll', { password }, cookie);
    const secret = activeEnroll.body.secret;
    const code = totp(secret, Math.floor(Date.now() / 30000));
    const confirmed = await call('/mfa/confirm', { password, code }, cookie);
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.recoveryCodes.length, 10);
    assert.equal((await call('/me', undefined, second.cookie)).status, 401);
    assert.equal((await call('/mfa', undefined, cookie)).body.enabled, true);
    assert.equal((await call('/mfa/enroll', { password }, cookie)).status, 409);
    const grant = (await database.query("INSERT INTO support_grants(user_id,access_level,reason,expires_at) VALUES(2,'read','MFA boundary test',NOW()+INTERVAL '1 hour') RETURNING id")).rows[0];
    const supportToken = 'd'.repeat(64);
    await database.query("INSERT INTO sessions(token_hash,user_id,actor_user_id,support_grant_id,expires_at) VALUES($1,2,1,$2,NOW()+INTERVAL '1 hour')", [tokenHash(supportToken), grant.id]);
    const supportCookie = `${cookie}; finance_support=${supportToken}`;
    assert.equal((await call('/mfa', undefined, supportCookie)).status, 403);
    assert.equal((await call('/mfa/enroll', { password }, supportCookie)).status, 403);
    // No session cookie or access is granted by a password-only MFA challenge.
    const challenge = await call('/login', { email, password });
    assert.deepEqual(challenge.body, { mfaRequired: true });
    assert.equal(challenge.cookie, undefined);
    assert.equal((await call('/me')).status, 401);
    assert.equal((await call('/login', { email, password, code })).status, 401, 'enrollment TOTP cannot be replayed');
    assert.equal((await call('/login', { email, password, code: '000000' })).status, 401);
    delete process.env.MFA_ENCRYPTION_KEY;
    assert.equal((await call('/login', { email, password, code })).status, 503);
    assert.equal((await call('/login', { email, password, code: confirmed.body.recoveryCodes[9] })).status, 200);
    process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    await database.query('DELETE FROM auth_attempts');
    // Allow one fresh time step without waiting for the real clock.
    await database.query('UPDATE user_mfa SET last_step=-1');
    const concurrent = await Promise.all([call('/login', { email, password, code }), call('/login', { email, password, code })]);
    assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 401]);
    const stored = (await database.query('SELECT * FROM user_mfa')).rows[0];
    assert.notEqual(stored.secret_ciphertext, secret);
    assert.equal(stored.pending_ciphertext, null);
    assert.equal(stored.recovery_hashes.includes(confirmed.body.recoveryCodes[0]), false);
    await database.query('DELETE FROM auth_attempts');
    const recovery = await call('/login', { email, password, code: confirmed.body.recoveryCodes[0] });
    assert.equal(recovery.status, 200);
    assert.equal((await call('/login', { email, password, code: confirmed.body.recoveryCodes[0] })).status, 401);
    assert.equal((await call('/login', { email, password, trustBrowser: 'yes' })).status, 400);
    const premature = await call('/login', { email, password, trustBrowser: true });
    assert.equal(premature.body.mfaRequired, true);
    assert.equal(premature.trustedCookie, undefined, 'password alone cannot enroll a trusted browser');
    const remembered = await call('/login', { email, password, code: confirmed.body.recoveryCodes[8], trustBrowser: true });
    assert.equal(remembered.status, 200);
    assert.match(remembered.trustedCookie, new RegExp(`^${trustedCookieName}=[a-f0-9]{64}$`));
    const trustedHeader = remembered.cookies.find(value => value.startsWith(`${trustedCookieName}=`));
    assert.match(trustedHeader, /HttpOnly/);
    assert.match(trustedHeader, /SameSite=Strict/);
    assert.match(trustedHeader, /Path=\//);
    assert.match(trustedHeader, /Expires=/);
    const trustRow = (await database.query('SELECT * FROM trusted_browsers')).rows[0];
    const originalExpiry = new Date(trustRow.expires_at).getTime();
    assert.ok(originalExpiry - Date.now() > 89.99 * 86400000);
    assert.ok(originalExpiry - Date.now() <= 90 * 86400000);
    assert.equal(trustRow.token_hash, tokenHash(remembered.trustedCookie.split('=')[1]));
    const trustedOnly = await call('/me', undefined, remembered.trustedCookie);
    assert.equal(trustedOnly.status, 401, 'trust is not a session');
    assert.equal((await call('/login', { email, password: 'wrong-password-123', trustBrowser: true }, remembered.trustedCookie)).status, 401);
    const reused = await call('/login', { email, password }, remembered.trustedCookie);
    assert.equal(reused.status, 200);
    assert.ok(reused.cookie);
    assert.notEqual(reused.trustedCookie, remembered.trustedCookie, 'rotate cookie on each trusted sign-in');
    const rotated = (await database.query('SELECT * FROM trusted_browsers')).rows[0];
    assert.equal(new Date(rotated.expires_at).getTime(), originalExpiry, 'trust has fixed non-sliding expiry');
    assert.equal(new Date(rotated.created_at).getTime(), new Date(trustRow.created_at).getTime());
    await database.query('DELETE FROM auth_attempts');
    assert.equal((await call('/login', { email, password }, remembered.trustedCookie)).body.mfaRequired, true, 'old cookie is invalidated');
    assert.equal((await call('/login', { email: 'demo@myfinance.app', password }, reused.trustedCookie)).trustedCookie, undefined);
    const list = await call('/mfa/trusted-browsers', undefined, `${reused.cookie}; ${reused.trustedCookie}`);
    assert.equal(list.body.trustDays, 90);
    assert.equal(list.body.browsers[0].current, true);
    assert.equal(JSON.stringify(list.body).includes(rotated.token_hash), false);
    assert.equal((await call('/mfa/trusted-browsers', undefined, supportCookie)).status, 403);
    assert.equal((await call('/mfa/revoke-trusted-browsers', {}, supportCookie)).status, 403);
    const revoked = await call('/mfa/revoke-trusted-browsers', {}, reused.cookie);
    assert.equal(revoked.status, 200);
    assert.equal((await call('/login', { email, password }, reused.trustedCookie)).body.mfaRequired, true);
    assert.equal((await call('/me', undefined, recovery.cookie)).status, 401, 'revocation signs out other sessions');
    assert.equal((await call('/me', undefined, reused.cookie)).status, 200);
    const beforeReset = await call('/login', { email, password, code: confirmed.body.recoveryCodes[7], trustBrowser: true });
    const sessionRow = (await database.query('SELECT created_at,expires_at FROM sessions WHERE token_hash=$1', [tokenHash(beforeReset.cookie.split('=')[1])])).rows[0];
    assert.equal(new Date(sessionRow.expires_at) - new Date(sessionRow.created_at), 12 * 3600000);
    const resetToken = 'c'.repeat(64);
    await database.query("INSERT INTO password_reset_tokens(token_hash,user_id,expires_at) VALUES($1,1,NOW()+INTERVAL '30 minutes')", [tokenHash(resetToken)]);
    assert.equal((await call('/password-reset/confirm', { token: resetToken, password: 'new-password-only-1234' })).status, 200);
    assert.equal((await call('/login', { email, password: 'new-password-only-1234' }, beforeReset.trustedCookie)).body.mfaRequired, true);
    assert.deepEqual((await call('/login', { email, password: 'new-password-only-1234' })).body, { mfaRequired: true });
    const recovered = await call('/login', { email, password: 'new-password-only-1234', code: confirmed.body.recoveryCodes[1] });
    assert.equal(recovered.status, 200);
    // Replacing codes requires both the password and a factor; old codes cease to work.
    await database.query('DELETE FROM auth_attempts');
    assert.equal((await call('/mfa/recovery-codes', { password: 'new-password-only-1234', code: 'invalid' }, recovered.cookie)).status, 403);
    const beforeReplacement = await call('/login', { email, password: 'new-password-only-1234', code: confirmed.body.recoveryCodes[6], trustBrowser: true });
    const replacement = await call('/mfa/recovery-codes', { password: 'new-password-only-1234', code: confirmed.body.recoveryCodes[2] }, recovered.cookie);
    assert.equal(replacement.status, 200);
    assert.equal((await call('/login', { email, password: 'new-password-only-1234' }, beforeReplacement.trustedCookie)).body.mfaRequired, true);
    assert.equal((await call('/login', { email, password: 'new-password-only-1234', code: confirmed.body.recoveryCodes[3] })).status, 401);
    const otherDevice = await call('/login', { email, password: 'new-password-only-1234', code: replacement.body.recoveryCodes[1], trustBrowser: true });
    assert.equal(otherDevice.status, 200);
    await database.query('UPDATE trusted_browsers SET expires_at=NOW()-INTERVAL \'1 second\'');
    assert.equal((await call('/login', { email, password: 'new-password-only-1234' }, otherDevice.trustedCookie)).body.mfaRequired, true);
    assert.equal((await call('/mfa/disable', { password: 'new-password-only-1234', code: replacement.body.recoveryCodes[0] }, recovered.cookie)).status, 200);
    assert.equal((await database.query('SELECT count(*)::int AS count FROM trusted_browsers')).rows[0].count, 0);
    assert.equal((await call('/me', undefined, otherDevice.cookie)).status, 401);
    assert.equal((await call('/login', { email, password: 'new-password-only-1234' })).body.mfaRequired, undefined);
    const demo = await call('/login', { email: 'demo@myfinance.app', password });
    assert.equal((await call('/mfa/enroll', { password }, demo.cookie)).status, 403);
    await database.exec('SET ROLE finance_app_runtime');
    await assert.rejects(() => database.query('SELECT * FROM user_mfa'), /permission denied/);
    await assert.rejects(() => database.query('SELECT * FROM trusted_browsers'), /permission denied/);
    await database.exec('RESET ROLE');
    const audit = (await database.query("SELECT detail::text FROM audit_events WHERE event_type LIKE 'auth.mfa%'")).rows;
    assert.ok(audit.length >= 5);
    assert.equal(JSON.stringify(audit).includes(secret), false);
    // Password changes and admin incident-response revocation must also remove trust.
    await database.query('DELETE FROM auth_attempts');
    const management = await call('/login', { email, password: 'new-password-only-1234' });
    const finalEnrollment = await call('/mfa/enroll', { password: 'new-password-only-1234' }, management.cookie);
    const finalConfirmed = await call('/mfa/confirm', {
      password: 'new-password-only-1234', code: totp(finalEnrollment.body.secret, Math.floor(Date.now() / 30000))
    }, management.cookie);
    const finalCodes = finalConfirmed.body.recoveryCodes;
    const beforeChange = await call('/login', {
      email, password: 'new-password-only-1234', code: finalCodes[0], trustBrowser: true
    });
    assert.equal((await call('/password', {
      currentPassword: 'new-password-only-1234', newPassword: 'changed-password-trust-123'
    }, `${beforeChange.cookie}; ${beforeChange.trustedCookie}`)).status, 200);
    assert.equal((await call('/login', { email, password: 'changed-password-trust-123' }, beforeChange.trustedCookie)).body.mfaRequired, true);
    const beforeLogout = await call('/login', {
      email, password: 'changed-password-trust-123', code: finalCodes[1], trustBrowser: true
    });
    assert.equal((await call('/logout', {}, `${beforeLogout.cookie}; ${beforeLogout.trustedCookie}`)).status, 200);
    const afterLogout = await call('/login', { email, password: 'changed-password-trust-123' }, beforeLogout.trustedCookie);
    assert.equal(afterLogout.status, 200, 'normal sign-out preserves trust');
    const adminRevocation = await fetch(base + '/api/admin/users/1/revoke-sessions', {
      method: 'POST', headers: { Origin: base, Cookie: afterLogout.cookie }
    });
    assert.equal(adminRevocation.status, 200);
    assert.equal((await call('/login', { email, password: 'changed-password-trust-123' }, afterLogout.trustedCookie)).body.mfaRequired, true);
    // Trust is login-bound and per-login storage is capped.
    const capClient = await pg.Pool.prototype.connect();
    await capClient.query('BEGIN');
    await capClient.query('SELECT id FROM users WHERE id=1 FOR UPDATE');
    const capToken = await rememberBrowser(capClient, 1, null);
    assert.equal(await browserIsTrusted(capClient, 2, capToken.token), false);
    for (let i = 0; i < 21; i++) await rememberBrowser(capClient, 1, null);
    assert.equal((await capClient.query('SELECT count(*)::int AS count FROM trusted_browsers WHERE user_id=1')).rows[0].count, 20);
    assert.equal(await browserIsTrusted(capClient, 1, capToken.token), false, 'oldest trust is dropped at the cap');
    await capClient.query('COMMIT');
    capClient.release();
    await database.query('DELETE FROM auth_attempts');
    const unlocked = await call('/login', { email, password: 'changed-password-trust-123', code: finalCodes[2] });
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await call('/mfa/enroll', { password: 'incorrect-password' }, unlocked.cookie)).status, 403);
    }
    assert.equal((await call('/mfa/enroll', { password: 'changed-password-trust-123' }, unlocked.cookie)).status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (oldOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = oldOrigin;
    if (oldKey === undefined) delete process.env.MFA_ENCRYPTION_KEY; else process.env.MFA_ENCRYPTION_KEY = oldKey;
    await database.close();
  }
});
