import { Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { administrativeTransaction } from '../db.js';
import { seedUserCategories } from '../utils/schema.js';
import { hashPassword, verifyPassword, tokenHash, validCredentials } from '../utils/passwords.js';
import { withUser } from '../utils/tenant.js';
import { log } from '../utils/logger.js';
import { recordAudit } from '../utils/audit.js';
import { sendPasswordResetEmail, sendSecurityNotice, mailConfigured, appOrigin } from '../utils/mailer.js';
import { isDemoEmail } from '../utils/demo.js';
import { ensureHousehold, invitedHousehold, joinHousehold } from '../utils/households.js';
import { newSecret, encryptSecret, decryptSecret, matchingStep, recoveryCodes, consumeFactor } from '../utils/mfa.js';
import { TRUST_DAYS, rememberBrowser, browserIsTrusted, revokeTrustedBrowsers } from '../utils/trustedBrowsers.js';

const router = Router();
const sessionHours = 12;
const resetMinutes = 30;
export const cookieName = 'finance_session';
export const supportCookieName = 'finance_support';
const production = process.env.NODE_ENV === 'production';
export const trustedCookieName = production ? '__Host-finance_trusted' : 'finance_trusted';
export const cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
const publicUser = row => ({ id: row.id, name: row.name, email: row.email, role: row.role === 'admin' ? 'admin' : 'user', emailVerified: !!row.email_verified_at });
const genericResetMessage = 'If that email belongs to an account, a password reset link has been sent.';
let dummyHash;

// POST endpoints that only read data and are therefore allowed during read-only support access.
const READ_ONLY_POSTS = new Set([
  '/api/import/inspect-csv',
  '/api/transactions', '/api/transactions/categorization-preview',
  '/api/dashboard/summary', '/api/dashboard/upcoming-payments', '/api/dashboard/category-spending',
  '/api/dashboard/category-transactions', '/api/dashboard/category-trends',
  '/api/dashboard/category-transactions-for-month',
  '/api/categorizations/list', '/api/categorizations/category-summary', '/api/categorizations/by-category'
]);

export function readCookie(req, name) {
  const entry = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  const value = entry?.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}

const cookieToken = req => readCookie(req, cookieName);

export function enforceSameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Plaid authenticates this server-to-server endpoint with its signed webhook header.
  if (req.originalUrl?.split('?')[0] === '/api/plaid/webhook') return next();
  const expected = process.env.APP_ORIGIN || (production ? null : `${req.protocol}://${req.get('host')}`);
  if (!expected || req.get('origin') !== expected) return res.status(403).json({ error: 'A same-origin request is required' });
  next();
}

async function loadSession(req, { activity = false } = {}) {
  const token = cookieToken(req);
  if (!token) return null;
  return administrativeTransaction(async client => {
    const owner = (await client.query(`
      SELECT u.id, u.name, u.email, u.role, u.email_verified_at, s.expires_at,
        LEAST(s.last_activity_at + INTERVAL '10 minutes',s.expires_at) AS idle_expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND s.last_activity_at > NOW() - INTERVAL '10 minutes'
        AND s.support_grant_id IS NULL AND u.password_hash IS NOT NULL FOR UPDATE OF s
    `, [tokenHash(token)])).rows[0];
    if (!owner) return null;
    if (activity) {
      const updated = (await client.query(`UPDATE sessions
        SET last_activity_at=GREATEST(last_activity_at,NOW()-($2 * INTERVAL '1 millisecond')) WHERE token_hash=$1
        RETURNING LEAST(last_activity_at + INTERVAL '10 minutes',expires_at) AS idle_expires_at`,
      [tokenHash(token), req.body?.idleMs ?? 0])).rows[0];
      owner.idle_expires_at = updated.idle_expires_at;
    }
    const supportToken = readCookie(req, supportCookieName);
    if (!supportToken || owner.role !== 'admin') return { owner };
    const support = (await client.query(`
      SELECT u.id, u.name, u.email, u.role, u.email_verified_at, g.id AS grant_id, g.access_level, g.expires_at
      FROM sessions s JOIN support_grants g ON g.id = s.support_grant_id JOIN users u ON u.id = g.user_id
      WHERE s.token_hash = $1 AND s.actor_user_id = $2 AND s.user_id = g.user_id AND s.expires_at > NOW()
        AND g.revoked_at IS NULL AND g.expires_at > NOW()
    `, [tokenHash(supportToken), owner.id])).rows[0];
    if (support) await client.query('UPDATE support_grants SET last_used_at = NOW() WHERE id = $1', [support.grant_id]);
    return { owner, support, staleSupport: !support };
  });
}

async function authenticate(req, res, next, activity = false) {
  try {
    const session = await loadSession(req, { activity });
    if (!session) {
      res.clearCookie(cookieName, cookieOptions);
      res.clearCookie(supportCookieName, cookieOptions);
      return res.status(401).json({ error: cookieToken(req) ? 'Your session expired. Please sign in again.' : 'Please sign in' });
    }
    res.set('X-Session-Idle-Expires', new Date(session.owner.idle_expires_at).toISOString());
    res.set('X-Session-Expires', new Date(session.owner.expires_at).toISOString());
    res.set('X-Session-Server-Time', new Date().toISOString());
    if (session.staleSupport) res.clearCookie(supportCookieName, cookieOptions);
    const subject = session.support || session.owner;
    const household = await administrativeTransaction(client => ensureHousehold(client, subject.id));
    req.household = household;
    if (!session.support) {
      req.user = publicUser(session.owner);
      req.user.household = { id: household.id, name: household.name, role: household.role };
      return withUser(household.owner_user_id, next, { loginId: session.owner.id });
    }
    const { support, owner } = session;
    req.user = publicUser(support);
    req.actor = publicUser(owner);
    req.support = { grantId: support.grant_id, accessLevel: support.access_level, actorUserId: owner.id, expiresAt: support.expires_at };
    res.on('finish', () => {
      recordAudit(req, 'support.request', res.statusCode < 400 ? 'success' : 'failure', { status: res.statusCode });
    });
    const path = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
    if (path.startsWith('/api/admin') || path.startsWith('/api/support-access') || path.startsWith('/api/billing') || path.startsWith('/api/household')) {
      return res.status(403).json({ error: 'End the support session to use administration or access-sharing tools' });
    }
    const readOnly = support.access_level !== 'write';
    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || (req.method === 'POST' && (path === '/api/auth/activity' || READ_ONLY_POSTS.has(path)
      || (path === '/api/debts' && !Object.keys(req.body || {}).length)));
    if (readOnly && !isRead) {
      return res.status(403).json({ error: 'This support session is read-only. The customer must grant edit access for changes.' });
    }
    withUser(household.owner_user_id, next, { readOnly, loginId: support.id });
  } catch (error) {
    next(error);
  }
}

export function requireUser(req, res, next) {
  return authenticate(req, res, next);
}

export function requireAdmin(req, res, next) {
  if (req.support || req.user?.role !== 'admin') {
    recordAudit(req, 'admin.denied', 'denied', { status: 403 });
    return res.status(403).json({ error: 'Administrator access is required' });
  }
  next();
}

async function rateLimit(req, email, scope = 'login') {
  return administrativeTransaction(async client => {
    await client.query('DELETE FROM auth_attempts WHERE reset_at < NOW()');
    for (const value of [`${scope}:ip:${req.ip}`, `${scope}:email:${email}`]) {
      const result = await client.query(`
        INSERT INTO auth_attempts (key, attempts, reset_at) VALUES ($1, 1, NOW() + INTERVAL '15 minutes')
        ON CONFLICT (key) DO UPDATE SET attempts = auth_attempts.attempts + 1
        RETURNING attempts
      `, [tokenHash(value)]);
      if (result.rows[0].attempts > 10) return false;
    }
    return true;
  });
}

export function attemptKeysForEmail(email) {
  return ['login', 'reset'].map(scope => tokenHash(`${scope}:email:${String(email).toLowerCase()}`));
}

async function issueSession(client, req, res, user) {
  const previous = cookieToken(req);
  if (previous) await client.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(previous)]);
  await client.query("DELETE FROM sessions WHERE expires_at <= NOW() OR last_activity_at <= NOW() - INTERVAL '10 minutes'");
  const token = randomBytes(32).toString('hex');
  await client.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${sessionHours} hours')`,
    [tokenHash(token), user.id]
  );
  return { token, user: publicUser(user) };
}

function sendSession(res, session) {
  res.cookie(cookieName, session.token, cookieOptions);
  res.clearCookie(supportCookieName, cookieOptions);
  res.json({ success: true, user: session.user });
}

const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

async function sendVerification(client, req, user) {
  if (!mailConfigured()) throw Object.assign(new Error('Email verification delivery is not configured.'), { status: 503 });
  const token = randomBytes(32).toString('hex');
  await client.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [user.id]);
  await client.query("INSERT INTO email_verification_tokens(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '24 hours')",
    [tokenHash(token), user.id]);
  const sent = await sendSecurityNotice(user, 'Verify your MyFinance email',
    `Hi ${user.name},\n\nVerify your email within 24 hours before starting your subscription:\n${appOrigin(req)}/#verify-token=${token}\n\nIf you did not create this login, do not follow the link.`);
  if (!sent) throw Object.assign(new Error('Verification email could not be delivered.'), { status: 503 });
}

router.post('/verify-email', async (req, res, next) => {
  try {
    const token = req.body?.token;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'A valid verification link is required.' });
    if (!await rateLimit(req, tokenHash(token), 'verify')) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    await administrativeTransaction(async client => {
      const row = (await client.query('SELECT user_id FROM email_verification_tokens WHERE token_hash=$1 AND expires_at>NOW() FOR UPDATE',
        [tokenHash(token)])).rows[0];
      if (!row) throw Object.assign(new Error('This verification link expired or was already used.'), { status: 409 });
      await client.query('UPDATE users SET email_verified_at=NOW() WHERE id=$1', [row.user_id]);
      await client.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [row.user_id]);
    });
    res.json({ success: true });
  } catch (error) { next(error); }
});
router.post('/resend-verification', requireUser, async (req, res, next) => {
  try {
    if (req.support) return res.status(403).json({ error: 'End support access to verify your email.' });
    if (!await rateLimit(req, req.user.email, 'verification-email')) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    if (!req.user.emailVerified) await administrativeTransaction(client => sendVerification(client, req, req.user));
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.get('/status', async (req, res, next) => {
  try {
    const result = await administrativeTransaction(client => client.query('SELECT password_hash IS NULL AS needed FROM users WHERE id = 1'));
    res.json({ setupRequired: result.rows[0]?.needed === true, registrationEnabled: process.env.ALLOW_REGISTRATION === 'true' });
  } catch (error) { next(error); }
});

router.get('/me', requireUser, (req, res) => res.json({
  user: req.user,
  support: req.support ? { actor: req.actor, accessLevel: req.support.accessLevel, expiresAt: req.support.expiresAt } : null
}));
// Only explicit user interaction renews inactivity; ordinary requests and polling never do.
router.post('/activity', (req, res, next) => {
  const idleMs = req.body?.idleMs ?? 0;
  if (!Number.isInteger(idleMs) || idleMs < 0 || idleMs > 15000) {
    return res.status(400).json({ error: 'Activity delay must be between 0 and 15000 milliseconds.' });
  }
  return authenticate(req, res, next, true);
},
  (req, res) => res.json({ success: true }));

for (const action of ['setup', 'register']) {
  router.post(`/${action}`, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const { password, name, setupToken } = req.body;
      if (!validCredentials(email, password) || typeof name !== 'string' || !name.trim() || name.length > 100) {
        return res.status(400).json({ error: 'Provide a name, valid email, and a password of 12 to 128 characters' });
      }
      if (isDemoEmail(email)) return res.status(403).json({ error: 'This email is reserved for the public demo.' });
      if (!await rateLimit(req, email)) {
        await recordAudit(req, 'auth.locked', 'denied', { email, status: 429, detail: { action } });
        return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      }
      if (action === 'register' && process.env.ALLOW_REGISTRATION !== 'true') {
        await recordAudit(req, 'auth.register', 'denied', { email, status: 403, detail: { reason: 'registration_closed' } });
        return res.status(403).json({ error: 'Registration is currently closed' });
      }
      if (action === 'register' && !mailConfigured()) return res.status(503).json({ error: 'Registration requires configured verification email delivery.' });
      if (action === 'setup') {
        const expected = process.env.OWNER_SETUP_TOKEN;
        if (!expected || expected.length < 32 || typeof setupToken !== 'string'
            || !timingSafeEqual(Buffer.from(tokenHash(setupToken)), Buffer.from(tokenHash(expected)))) {
          await recordAudit(req, 'auth.setup', 'denied', { email, status: 403, detail: { reason: 'invalid_setup_token' } });
          return res.status(403).json({ error: 'Valid owner setup token required' });
        }
      }
      const encoded = await hashPassword(password);
      const session = await administrativeTransaction(async client => {
        // Serialize setup/registration so only the authenticated owner claims old data.
        await client.query('SELECT pg_advisory_xact_lock(74938120)');
        const owner = (await client.query('SELECT password_hash FROM users WHERE id = 1 FOR UPDATE')).rows[0];
        if (!owner || (action === 'register' && !owner.password_hash) || (action === 'setup' && owner.password_hash)) {
          const error = new Error(action === 'setup' ? 'Owner setup has already been completed' : 'The owner must complete setup first');
          error.status = 409;
          throw error;
        }
        const query = action === 'setup'
          ? "UPDATE users SET name=$1, email=$2, password_hash=$3, role='admin', password_changed_at=NOW() WHERE id=1 RETURNING id,name,email,role"
          : "INSERT INTO users (name,email,password_hash,role,password_changed_at) VALUES ($1,$2,$3,'user',NOW()) RETURNING id,name,email,role";
        const user = (await client.query(query, [name.trim(), email, encoded])).rows[0];
        if (action === 'setup') {
          await client.query('UPDATE users SET email_verified_at=NOW() WHERE id=$1', [user.id]);
          user.email_verified_at = new Date();
        } else await sendVerification(client, req, user);
        await ensureHousehold(client, user.id);
        const issued = await issueSession(client, req, res, user);
        await client.query('SET LOCAL ROLE finance_app_runtime');
        await client.query("SELECT set_config('app.user_id', $1, true)", [String(user.id)]);
        await seedUserCategories(client, user.id);
        return issued;
      });
      await recordAudit(req, `auth.${action}`, 'success', { actorUserId: session.user.id, subjectUserId: session.user.id, email, status: 200 });
      sendSession(res, session);
    } catch (error) {
      if (error.code === '23505' || error.status === 409) {
        await recordAudit(req, `auth.${action}`, 'failure', { email: normalizeEmail(req.body.email), status: 409 });
        return res.status(409).json({ error: error.status === 409 ? error.message : 'This account cannot be registered. Try signing in.' });
      }
      next(error);
    }
  });
}

router.post('/accept-invite', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const { password, name, token } = req.body || {};
    if (isDemoEmail(email)) return res.status(403).json({ error: 'This email is reserved for the public demo.' });
    if (!validCredentials(email, password) || typeof name !== 'string' || !name.trim() || name.length > 100) {
      return res.status(400).json({ error: 'Provide a name, valid email and a password of 12 to 128 characters.' });
    }
    if (!await rateLimit(req, email, 'invite')) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const encoded = await hashPassword(password);
    const session = await administrativeTransaction(async client => {
      const invitation = await invitedHousehold(client, token, email);
      const existing = (await client.query('SELECT id FROM users WHERE lower(email)=$1', [email])).rows[0];
      if (existing) throw Object.assign(new Error('Sign in with your existing login to accept this invitation.'), { status: 409 });
      const user = (await client.query(`INSERT INTO users(name,email,password_hash,role,password_changed_at)
        VALUES($1,$2,$3,'user',NOW()) RETURNING id,name,email,role`, [name.trim(), email, encoded])).rows[0];
      await client.query('UPDATE users SET email_verified_at=NOW() WHERE id=$1', [user.id]);
      user.email_verified_at = new Date();
      await joinHousehold(client, invitation, user.id);
      return issueSession(client, req, res, user);
    });
    await recordAudit(req, 'household.invite_accepted', 'success', { actorUserId: session.user.id, subjectUserId: session.user.id });
    sendSession(res, session);
  } catch (error) { next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;
    if (req.body.trustBrowser !== undefined && typeof req.body.trustBrowser !== 'boolean') {
      return res.status(400).json({ error: 'Trust this browser must be a boolean.' });
    }
    if (!validCredentials(email, password)) {
      await recordAudit(req, 'auth.login', 'failure', { email, status: 401, detail: { reason: 'invalid_format' } });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!await rateLimit(req, email)) {
      await recordAudit(req, 'auth.locked', 'denied', { email, status: 429, detail: { action: 'login' } });
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const row = await administrativeTransaction(async client =>
      (await client.query('SELECT id,name,email,role,password_hash,email_verified_at FROM users WHERE lower(email)=$1', [email])).rows[0]);
    dummyHash ||= await hashPassword('not-a-real-account-password');
    const valid = await verifyPassword(password, row?.password_hash || dummyHash);
    if (!valid || !row?.password_hash) {
      await recordAudit(req, 'auth.login', 'failure', {
        actorUserId: null, subjectUserId: row?.id ?? null, email, status: 401,
        detail: { reason: row ? 'wrong_password' : 'unknown_email' }
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const result = await administrativeTransaction(async client => {
      const current = (await client.query('SELECT id,name,email,role,password_hash,email_verified_at FROM users WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
      if (!current || current.password_hash !== row.password_hash) return { invalid: true };
      const mfa = (await client.query('SELECT * FROM user_mfa WHERE user_id=$1', [row.id])).rows[0];
      let trustedBrowser = null, trustedSignIn = false;
      if (mfa?.enabled_at) {
        const previous = readCookie(req, trustedCookieName);
        if (req.body.code) {
          if (!await consumeFactor(client, mfa, req.body.code)) return { invalid: true };
          if (req.body.trustBrowser === true) trustedBrowser = await rememberBrowser(client, row.id, previous);
        } else {
          if (!await browserIsTrusted(client, row.id, previous)) return { mfaRequired: true };
          trustedBrowser = await rememberBrowser(client, row.id, previous);
          trustedSignIn = true;
        }
      }
      return { session: await issueSession(client, req, res, current), trustedBrowser, trustedSignIn };
    });
    if (result.mfaRequired) return res.json({ mfaRequired: true });
    if (result.invalid) {
      await recordAudit(req, 'auth.login', 'failure', { actorUserId: null, subjectUserId: row.id, status: 401, detail: { reason: 'invalid_credentials_or_factor' } });
      return res.status(401).json({ error: 'Invalid credentials or authenticator/recovery code.' });
    }
    const session = result.session;
    await recordAudit(req, 'auth.login', 'success', { actorUserId: row.id, subjectUserId: row.id, email, status: 200,
      detail: { trustedBrowser: result.trustedSignIn, browserRemembered: !!result.trustedBrowser } });
    if (result.trustedBrowser) res.cookie(trustedCookieName, result.trustedBrowser.token,
      { ...cookieOptions, expires: new Date(result.trustedBrowser.expiresAt) });
    sendSession(res, session);
  } catch (error) {
    if (error.code === 'MFA_KEY_UNAVAILABLE') return res.status(503).json({ error: 'Authenticator verification is temporarily unavailable.' });
    next(error);
  }
});

router.get('/mfa', requireUser, async (req, res, next) => {
  try {
    if (req.support) return res.status(403).json({ error: 'End support access to manage authentication.' });
    const row = await administrativeTransaction(async client =>
      (await client.query('SELECT enabled_at,cardinality(recovery_hashes) AS remaining FROM user_mfa WHERE user_id=$1', [req.user.id])).rows[0]);
    res.json({ enabled: !!row?.enabled_at, recoveryCodesRemaining: row?.enabled_at ? row.remaining : 0 });
  } catch (error) { next(error); }
});

router.get('/mfa/trusted-browsers', requireUser, async (req, res, next) => {
  try {
    if (req.support) return res.status(403).json({ error: 'End support access to manage trusted browsers.' });
    const token = readCookie(req, trustedCookieName);
    const browsers = await administrativeTransaction(async client => (await client.query(`SELECT id::text,created_at,last_used_at,expires_at,
      token_hash=$2 AS current FROM trusted_browsers WHERE user_id=$1 AND expires_at>NOW() ORDER BY created_at DESC`,
    [req.user.id, token ? tokenHash(token) : null])).rows);
    res.json({ trustDays: TRUST_DAYS, browsers });
  } catch (error) { next(error); }
});

router.post('/mfa/revoke-trusted-browsers', requireUser, async (req, res, next) => {
  try {
    if (req.support || isDemoEmail(req.user.email)) return res.status(403).json({ error: 'Trusted browsers cannot be changed in support or demo sessions.' });
    await administrativeTransaction(async client => {
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      await revokeTrustedBrowsers(client, req.user.id);
      await client.query('DELETE FROM sessions WHERE (user_id=$1 OR actor_user_id=$1) AND token_hash<>$2', [req.user.id, tokenHash(cookieToken(req))]);
    });
    res.clearCookie(trustedCookieName, cookieOptions);
    await recordAudit(req, 'auth.trusted_browsers_revoked', 'success', { actorUserId: req.user.id, subjectUserId: req.user.id, status: 200 });
    res.json({ success: true, message: 'All trusted browsers were forgotten and other sessions signed out. Your next sign-in will require MFA.' });
  } catch (error) { next(error); }
});

for (const action of ['enroll', 'confirm', 'disable', 'recovery-codes']) {
  router.post(`/mfa/${action}`, requireUser, async (req, res, next) => {
    try {
      if (req.support || isDemoEmail(req.user.email)) return res.status(403).json({ error: 'Authenticator settings cannot be changed in support or demo sessions.' });
      if (!await rateLimit(req, req.user.email, 'mfa-settings')) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const result = await administrativeTransaction(async client => {
        const user = (await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
        if (typeof req.body?.password !== 'string' || req.body.password.length > 128
          || !await verifyPassword(req.body.password, user?.password_hash)) {
          return { status: 403, error: 'Current password is required.' };
        }
        const mfa = (await client.query('SELECT * FROM user_mfa WHERE user_id=$1', [req.user.id])).rows[0];
        if (action === 'enroll') {
          if (mfa?.enabled_at) return { status: 409, error: 'Authenticator is already enabled.' };
          const secret = newSecret();
          await client.query(`INSERT INTO user_mfa(user_id,pending_ciphertext,pending_expires_at)
            VALUES($1,$2,NOW()+INTERVAL '10 minutes') ON CONFLICT(user_id)
            DO UPDATE SET pending_ciphertext=$2,pending_expires_at=NOW()+INTERVAL '10 minutes'`,
          [req.user.id, encryptSecret(secret, req.user.id)]);
          return { secret, uri: `otpauth://totp/${encodeURIComponent(`MyFinance:${req.user.email}`)}?secret=${secret}&issuer=MyFinance&algorithm=SHA256&digits=6&period=30` };
        }
        if (action === 'confirm') {
          if (mfa?.enabled_at || !mfa?.pending_ciphertext || new Date(mfa.pending_expires_at).getTime() <= Date.now()) {
            return { status: 409, error: 'Enrollment expired or is already enabled. Start again.' };
          }
          const step = matchingStep(decryptSecret(mfa.pending_ciphertext, req.user.id), req.body.code);
          if (step === null) return { status: 403, error: 'Invalid authenticator code. Check the clock on your device.' };
          const recovery = recoveryCodes();
          await client.query(`UPDATE user_mfa SET secret_ciphertext=pending_ciphertext,pending_ciphertext=NULL,
            pending_expires_at=NULL,enabled_at=NOW(),last_step=$2,recovery_hashes=$3 WHERE user_id=$1`,
          [req.user.id, step, recovery.hashes]);
          await client.query('DELETE FROM sessions WHERE (user_id=$1 OR actor_user_id=$1) AND token_hash<>$2', [req.user.id, tokenHash(cookieToken(req))]);
          await revokeTrustedBrowsers(client, req.user.id);
          return { recoveryCodes: recovery.codes };
        }
        if (!await consumeFactor(client, mfa, req.body.code)) return { status: 403, error: 'A valid authenticator or unused recovery code is required.' };
        await revokeTrustedBrowsers(client, req.user.id);
        if (action === 'disable') {
          await client.query('DELETE FROM user_mfa WHERE user_id=$1', [req.user.id]);
          await client.query('DELETE FROM sessions WHERE (user_id=$1 OR actor_user_id=$1) AND token_hash<>$2', [req.user.id, tokenHash(cookieToken(req))]);
          return { success: true };
        }
        const recovery = recoveryCodes();
        await client.query('UPDATE user_mfa SET recovery_hashes=$2 WHERE user_id=$1', [req.user.id, recovery.hashes]);
        return { recoveryCodes: recovery.codes };
      });
      await recordAudit(req, `auth.mfa_${action.replace('-', '_')}`, result.error ? 'failure' : 'success',
        { actorUserId: req.user.id, subjectUserId: req.user.id, status: result.status || 200 });
      if (result.error) return res.status(result.status).json({ error: result.error });
      if (action !== 'enroll') res.clearCookie(trustedCookieName, cookieOptions);
      res.json(result);
    } catch (error) {
      if (error.code === 'MFA_KEY_UNAVAILABLE') return res.status(503).json({ error: 'Authenticator verification is temporarily unavailable.' });
      next(error);
    }
  });
}

router.post('/logout', async (req, res, next) => {
  try {
    const token = cookieToken(req);
    const supportToken = readCookie(req, supportCookieName);
    let userId = null;
    if (token || supportToken) {
      userId = await administrativeTransaction(async client => {
        const row = token ? (await client.query('DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id', [tokenHash(token)])).rows[0] : null;
        if (supportToken) await client.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(supportToken)]);
        // Support sessions die with the administrator's own session.
        if (row) await client.query('DELETE FROM sessions WHERE actor_user_id=$1', [row.user_id]);
        return row?.user_id ?? null;
      });
    }
    if (userId) await recordAudit(req, 'auth.logout', 'success', { actorUserId: userId, subjectUserId: userId, status: 200 });
    res.clearCookie(cookieName, cookieOptions);
    res.clearCookie(supportCookieName, cookieOptions);
    res.json({ success: true });
  } catch (error) {
    log('AUTH', 'Logout could not revoke the session');
    next(error);
  }
});

// Creates a single-use reset token and emails it. Shared by self-service and admin-initiated resets.
export async function issuePasswordReset(req, user, initiatedBy) {
  const token = randomBytes(32).toString('hex');
  await administrativeTransaction(async client => {
    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await client.query(
      'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + make_interval(mins => $3))',
      [tokenHash(token), user.id, resetMinutes]);
  });
  let sent = false;
  try {
    sent = await sendPasswordResetEmail(req, user, token, resetMinutes);
  } catch (error) {
    await recordAudit(req, 'auth.password_reset_email', 'error', { subjectUserId: user.id, detail: { initiatedBy, error: error.code || 'SEND_FAILED' } });
    return false;
  }
  await recordAudit(req, 'auth.password_reset_requested', sent ? 'success' : 'failure', {
    subjectUserId: user.id, email: user.email, detail: { initiatedBy, emailSent: sent, reason: sent ? undefined : 'smtp_not_configured' }
  });
  return sent;
}

router.post('/password-reset/request', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!await rateLimit(req, email, 'reset')) {
      await recordAudit(req, 'auth.locked', 'denied', { email, status: 429, detail: { action: 'password_reset' } });
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const user = await administrativeTransaction(async client =>
      (await client.query('SELECT id,name,email FROM users WHERE lower(email)=$1 AND password_hash IS NOT NULL', [email])).rows[0]);
    if (user && !isDemoEmail(user.email)) await issuePasswordReset(req, user, 'self');
    else if (!user) await recordAudit(req, 'auth.password_reset_requested', 'failure', { email, detail: { reason: 'unknown_email' } });
    // Same response either way so the endpoint cannot be used to discover accounts.
    res.status(202).json({ success: true, message: genericResetMessage });
  } catch (error) { next(error); }
});

router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'Choose a password of 12 to 128 characters' });
    }
    const encoded = await hashPassword(password);
    const user = await administrativeTransaction(async client => {
      const row = (await client.query(`SELECT user_id FROM password_reset_tokens
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW()`, [tokenHash(token)])).rows[0];
      if (!row) return null;
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [row.user_id]);
      const consumed = await client.query(`UPDATE password_reset_tokens SET used_at=NOW()
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() RETURNING user_id`, [tokenHash(token)]);
      if (!consumed.rows.length) return null;
      const updated = (await client.query(
        'UPDATE users SET password_hash=$1, password_changed_at=NOW() WHERE id=$2 RETURNING id,name,email,role',
        [encoded, row.user_id])).rows[0];
      // Sign out everywhere, including any support sessions on the account.
      await client.query('DELETE FROM sessions WHERE user_id=$1 OR actor_user_id=$1', [row.user_id]);
      await revokeTrustedBrowsers(client, row.user_id);
      await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id=$1 AND used_at IS NULL', [row.user_id]);
      await client.query('DELETE FROM auth_attempts WHERE key = ANY($1)', [attemptKeysForEmail(updated.email)]);
      return updated;
    });
    if (!user) {
      await recordAudit(req, 'auth.password_reset_completed', 'failure', { detail: { reason: 'invalid_or_expired_token' }, status: 400 });
      return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    }
    await recordAudit(req, 'auth.password_reset_completed', 'success', { actorUserId: user.id, subjectUserId: user.id, status: 200 });
    res.clearCookie(trustedCookieName, cookieOptions);
    sendSecurityNotice(user, 'Your MyFinanceApp password was changed',
      `Hi ${user.name},\n\nYour password was just changed and all sessions were signed out. If this was not you, contact support immediately.`)
      .catch(() => log('MAIL', 'Password change notice could not be sent'));
    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  } catch (error) { next(error); }
});

// Signed-in password change: confirm the current password, keep this device signed in, sign out everywhere else.
router.post('/password', requireUser, async (req, res, next) => {
  try {
    if (req.support) return res.status(403).json({ error: 'Support sessions cannot change the customer\'s password' });
    if (isDemoEmail(req.user.email)) return res.status(403).json({ error: 'The demo account password cannot be changed' });
    const { currentPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) {
      return res.status(400).json({ error: 'Choose a new password of 12 to 128 characters' });
    }
    if (typeof currentPassword !== 'string' || !currentPassword) return res.status(400).json({ error: 'Enter your current password' });
    if (currentPassword === newPassword) return res.status(400).json({ error: 'Choose a password different from your current one' });
    const email = normalizeEmail(req.user.email);
    if (!await rateLimit(req, email, 'password')) {
      await recordAudit(req, 'auth.locked', 'denied', { email, status: 429, detail: { action: 'password_change' } });
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const row = await administrativeTransaction(async client =>
      (await client.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])).rows[0]);
    if (!await verifyPassword(currentPassword, row?.password_hash)) {
      await recordAudit(req, 'auth.password_changed', 'failure', { actorUserId: req.user.id, subjectUserId: req.user.id, status: 401, detail: { reason: 'wrong_password' } });
      return res.status(401).json({ error: 'Your current password is not correct' });
    }
    const encoded = await hashPassword(newPassword);
    const current = tokenHash(cookieToken(req));
    await administrativeTransaction(async client => {
      const latest = (await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [req.user.id])).rows[0];
      if (latest?.password_hash !== row.password_hash) throw Object.assign(new Error('Password changed. Try again.'), { status: 409 });
      await client.query('UPDATE users SET password_hash=$1, password_changed_at=NOW() WHERE id=$2', [encoded, req.user.id]);
      await revokeTrustedBrowsers(client, req.user.id);
      await client.query('DELETE FROM sessions WHERE (user_id=$1 OR actor_user_id=$1) AND token_hash <> $2', [req.user.id, current]);
      await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id=$1 AND used_at IS NULL', [req.user.id]);
      await client.query('DELETE FROM auth_attempts WHERE key = $1', [tokenHash(`password:email:${email}`)]);
    });
    await recordAudit(req, 'auth.password_changed', 'success', { actorUserId: req.user.id, subjectUserId: req.user.id, status: 200 });
    res.clearCookie(trustedCookieName, cookieOptions);
    sendSecurityNotice(req.user, 'Your MyFinanceApp password was changed',
      `Hi ${req.user.name},\n\nYour password was just changed from a signed-in device, and every other device was signed out. If this was not you, reset your password and contact support immediately.`)
      .catch(() => log('MAIL', 'Password change notice could not be sent'));
    res.json({ success: true, message: 'Password changed. Other devices have been signed out.' });
  } catch (error) { next(error); }
});

router.post('/end-support', async (req, res, next) => {
  try {
    const supportToken = readCookie(req, supportCookieName);
    if (supportToken) {
      const row = await administrativeTransaction(async client =>
        (await client.query('DELETE FROM sessions WHERE token_hash=$1 RETURNING actor_user_id, user_id, support_grant_id', [tokenHash(supportToken)])).rows[0]);
      if (row) await recordAudit(req, 'support.session_ended', 'success', {
        actorUserId: row.actor_user_id, subjectUserId: row.user_id, supportGrantId: row.support_grant_id, status: 200 });
    }
    res.clearCookie(supportCookieName, cookieOptions);
    res.json({ success: true });
  } catch (error) { next(error); }
});

export default router;
