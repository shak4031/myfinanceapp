import { Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { administrativeTransaction } from '../db.js';
import { seedUserCategories } from '../utils/schema.js';
import { hashPassword, verifyPassword, tokenHash, validCredentials } from '../utils/passwords.js';
import { withUser } from '../utils/tenant.js';
import { log } from '../utils/logger.js';
import { recordAudit } from '../utils/audit.js';
import { sendPasswordResetEmail, sendSecurityNotice } from '../utils/mailer.js';
import { isDemoEmail } from '../utils/demo.js';

const router = Router();
const sessionDays = 7;
const resetMinutes = 30;
export const cookieName = 'finance_session';
export const supportCookieName = 'finance_support';
const production = process.env.NODE_ENV === 'production';
export const cookieOptions = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
const publicUser = row => ({ id: row.id, name: row.name, email: row.email, role: row.role === 'admin' ? 'admin' : 'user' });
const genericResetMessage = 'If that email belongs to an account, a password reset link has been sent.';
let dummyHash;

// POST endpoints that only read data and are therefore allowed during read-only support access.
const READ_ONLY_POSTS = new Set([
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
  const expected = process.env.APP_ORIGIN || (production ? null : `${req.protocol}://${req.get('host')}`);
  if (!expected || req.get('origin') !== expected) return res.status(403).json({ error: 'A same-origin request is required' });
  next();
}

async function loadSession(req) {
  const token = cookieToken(req);
  if (!token) return null;
  return administrativeTransaction(async client => {
    const owner = (await client.query(`
      SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > NOW() AND s.support_grant_id IS NULL AND u.password_hash IS NOT NULL
    `, [tokenHash(token)])).rows[0];
    if (!owner) return null;
    const supportToken = readCookie(req, supportCookieName);
    if (!supportToken || owner.role !== 'admin') return { owner };
    const support = (await client.query(`
      SELECT u.id, u.name, u.email, u.role, g.id AS grant_id, g.access_level, g.expires_at
      FROM sessions s JOIN support_grants g ON g.id = s.support_grant_id JOIN users u ON u.id = g.user_id
      WHERE s.token_hash = $1 AND s.actor_user_id = $2 AND s.user_id = g.user_id AND s.expires_at > NOW()
        AND g.revoked_at IS NULL AND g.expires_at > NOW()
    `, [tokenHash(supportToken), owner.id])).rows[0];
    if (support) await client.query('UPDATE support_grants SET last_used_at = NOW() WHERE id = $1', [support.grant_id]);
    return { owner, support, staleSupport: !support };
  });
}

export async function requireUser(req, res, next) {
  try {
    const session = await loadSession(req);
    if (!session) {
      res.clearCookie(cookieName, cookieOptions);
      res.clearCookie(supportCookieName, cookieOptions);
      return res.status(401).json({ error: cookieToken(req) ? 'Your session expired. Please sign in again.' : 'Please sign in' });
    }
    if (session.staleSupport) res.clearCookie(supportCookieName, cookieOptions);
    if (!session.support) {
      req.user = publicUser(session.owner);
      return withUser(session.owner.id, next);
    }
    const { support, owner } = session;
    req.user = publicUser(support);
    req.actor = publicUser(owner);
    req.support = { grantId: support.grant_id, accessLevel: support.access_level, actorUserId: owner.id, expiresAt: support.expires_at };
    res.on('finish', () => {
      recordAudit(req, 'support.request', res.statusCode < 400 ? 'success' : 'failure', { status: res.statusCode });
    });
    const path = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
    if (path.startsWith('/api/admin') || path.startsWith('/api/support-access')) {
      return res.status(403).json({ error: 'End the support session to use administration or access-sharing tools' });
    }
    const readOnly = support.access_level !== 'write';
    const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || (req.method === 'POST' && (READ_ONLY_POSTS.has(path)
      || (path === '/api/debts' && !Object.keys(req.body || {}).length)));
    if (readOnly && !isRead) {
      return res.status(403).json({ error: 'This support session is read-only. The customer must grant edit access for changes.' });
    }
    withUser(support.id, next, { readOnly });
  } catch (error) {
    next(error);
  }
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
  await client.query('DELETE FROM sessions WHERE expires_at <= NOW()');
  const token = randomBytes(32).toString('hex');
  await client.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')",
    [tokenHash(token), user.id]
  );
  return { token, user: publicUser(user) };
}

function sendSession(res, session) {
  res.cookie(cookieName, session.token, { ...cookieOptions, maxAge: sessionDays * 86400000 });
  res.clearCookie(supportCookieName, cookieOptions);
  res.json({ success: true, user: session.user });
}

const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

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

for (const action of ['setup', 'register']) {
  router.post(`/${action}`, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const { password, name, setupToken } = req.body;
      if (!validCredentials(email, password) || typeof name !== 'string' || !name.trim() || name.length > 100) {
        return res.status(400).json({ error: 'Provide a name, valid email, and a password of 12 to 128 characters' });
      }
      if (!await rateLimit(req, email)) {
        await recordAudit(req, 'auth.locked', 'denied', { email, status: 429, detail: { action } });
        return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      }
      if (action === 'register' && process.env.ALLOW_REGISTRATION !== 'true') {
        await recordAudit(req, 'auth.register', 'denied', { email, status: 403, detail: { reason: 'registration_closed' } });
        return res.status(403).json({ error: 'Registration is currently closed' });
      }
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

router.post('/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;
    if (!validCredentials(email, password)) {
      await recordAudit(req, 'auth.login', 'failure', { email, status: 401, detail: { reason: 'invalid_format' } });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!await rateLimit(req, email)) {
      await recordAudit(req, 'auth.locked', 'denied', { email, status: 429, detail: { action: 'login' } });
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    const row = await administrativeTransaction(async client =>
      (await client.query('SELECT id,name,email,role,password_hash FROM users WHERE lower(email)=$1', [email])).rows[0]);
    dummyHash ||= await hashPassword('not-a-real-account-password');
    const valid = await verifyPassword(password, row?.password_hash || dummyHash);
    if (!valid || !row?.password_hash) {
      await recordAudit(req, 'auth.login', 'failure', {
        actorUserId: null, subjectUserId: row?.id ?? null, email, status: 401,
        detail: { reason: row ? 'wrong_password' : 'unknown_email' }
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const session = await administrativeTransaction(client => issueSession(client, req, res, row));
    await recordAudit(req, 'auth.login', 'success', { actorUserId: row.id, subjectUserId: row.id, email, status: 200 });
    sendSession(res, session);
  } catch (error) { next(error); }
});

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
      const row = (await client.query(`
        UPDATE password_reset_tokens SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING user_id
      `, [tokenHash(token)])).rows[0];
      if (!row) return null;
      const updated = (await client.query(
        'UPDATE users SET password_hash=$1, password_changed_at=NOW() WHERE id=$2 RETURNING id,name,email,role',
        [encoded, row.user_id])).rows[0];
      // Sign out everywhere, including any support sessions on the account.
      await client.query('DELETE FROM sessions WHERE user_id=$1 OR actor_user_id=$1', [row.user_id]);
      await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id=$1 AND used_at IS NULL', [row.user_id]);
      await client.query('DELETE FROM auth_attempts WHERE key = ANY($1)', [attemptKeysForEmail(updated.email)]);
      return updated;
    });
    if (!user) {
      await recordAudit(req, 'auth.password_reset_completed', 'failure', { detail: { reason: 'invalid_or_expired_token' }, status: 400 });
      return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    }
    await recordAudit(req, 'auth.password_reset_completed', 'success', { actorUserId: user.id, subjectUserId: user.id, status: 200 });
    sendSecurityNotice(user, 'Your MyFinanceApp password was changed',
      `Hi ${user.name},\n\nYour password was just changed and all sessions were signed out. If this was not you, contact support immediately.`)
      .catch(() => log('MAIL', 'Password change notice could not be sent'));
    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
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
