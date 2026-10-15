import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { administrativeTransaction } from '../db.js';
import { recordAudit, hashIdentifier, auditRetentionDays } from '../utils/audit.js';
import { tokenHash } from '../utils/passwords.js';
import { mailConfigured, sendSecurityNotice } from '../utils/mailer.js';
import { issuePasswordReset, attemptKeysForEmail, supportCookieName, cookieOptions } from './auth.js';
import { openApiSpec } from '../utils/openapi.js';
import { log } from '../utils/logger.js';

const router = Router();
const SUPPORT_SESSION_MINUTES = 120;
const startedAt = Date.now();

const parseId = value => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function loadUser(client, id) {
  return (await client.query('SELECT id,name,email,role FROM users WHERE id=$1 AND password_hash IS NOT NULL', [id])).rows[0];
}

router.get('/openapi.json', (req, res) => res.json(openApiSpec()));

router.get('/overview', async (req, res, next) => {
  try {
    const started = Date.now();
    const stats = await administrativeTransaction(async client => (await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE password_hash IS NOT NULL) AS users,
        (SELECT COUNT(*)::int FROM sessions WHERE expires_at > NOW() AND support_grant_id IS NULL) AS active_sessions,
        (SELECT COUNT(*)::int FROM audit_events WHERE created_at > NOW() - INTERVAL '24 hours'
           AND event_type = 'auth.login' AND outcome = 'failure') AS failed_logins_24h,
        (SELECT COUNT(*)::int FROM audit_events WHERE created_at > NOW() - INTERVAL '24 hours'
           AND event_type = 'auth.locked') AS lockouts_24h,
        (SELECT COUNT(*)::int FROM audit_events WHERE created_at > NOW() - INTERVAL '24 hours'
           AND outcome = 'error') AS errors_24h,
        (SELECT COUNT(*)::int FROM support_grants WHERE revoked_at IS NULL AND expires_at > NOW()) AS active_support_grants
    `)).rows[0]);
    res.json({
      status: 'healthy',
      databaseLatencyMs: Date.now() - started,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
      environment: process.env.NODE_ENV || 'development',
      emailConfigured: mailConfigured(),
      alertWebhookConfigured: Boolean(process.env.ALERT_WEBHOOK_URL),
      registrationEnabled: process.env.ALLOW_REGISTRATION === 'true',
      auditRetentionDays: auditRetentionDays(),
      stats
    });
  } catch (error) { next(error); }
});

// Account metadata only; no financial data is ever returned to administrators.
router.get('/users', async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 100) : '';
    const rows = await administrativeTransaction(async client => (await client.query(`
      SELECT u.id, u.name, u.email, u.role, u.created_at, u.password_changed_at,
        (SELECT MAX(created_at) FROM audit_events a WHERE a.subject_user_id = u.id AND a.event_type='auth.login' AND a.outcome='success') AS last_login,
        (SELECT COUNT(*)::int FROM audit_events a WHERE a.subject_user_id = u.id AND a.event_type='auth.login'
           AND a.outcome='failure' AND a.created_at > NOW() - INTERVAL '24 hours') AS failed_logins_24h,
        (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW() AND s.support_grant_id IS NULL) AS active_sessions,
        (SELECT COUNT(*)::int FROM support_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.expires_at > NOW()) AS active_grants
      FROM users u
      WHERE u.password_hash IS NOT NULL AND ($1 = '' OR lower(u.email) LIKE '%' || $1 || '%' OR lower(u.name) LIKE '%' || $1 || '%')
      ORDER BY u.id LIMIT 200
    `, [q])).rows);
    res.json(rows);
  } catch (error) { next(error); }
});

router.get('/audit', async (req, res, next) => {
  try {
    const filters = [];
    const params = [];
    const add = (sql, value) => { params.push(value); filters.push(sql.replaceAll('?', `$${params.length}`)); };
    const { eventType, outcome, requestId, email } = req.query;
    if (typeof eventType === 'string' && eventType) add('a.event_type LIKE ?', `${eventType.replace(/[%_]/g, '')}%`);
    if (typeof outcome === 'string' && ['success', 'failure', 'denied', 'error'].includes(outcome)) add('a.outcome = ?', outcome);
    if (typeof requestId === 'string' && requestId) add('a.request_id = ?', requestId.slice(0, 64));
    if (typeof email === 'string' && email) add('a.email_hash = ?', hashIdentifier(email));
    const userId = parseId(req.query.userId);
    if (userId) add('(a.subject_user_id = ? OR a.actor_user_id = ?)', userId);
    const beforeId = parseId(req.query.beforeId);
    if (beforeId) add('a.id < ?', beforeId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const rows = await administrativeTransaction(async client => (await client.query(`
      SELECT a.id, a.created_at, a.event_type, a.outcome, a.actor_user_id, actor.email AS actor_email,
        a.subject_user_id, subject.email AS subject_email, a.support_grant_id, a.request_id, a.method, a.path, a.status,
        a.detail, LEFT(a.ip_hash, 12) AS ip_ref
      FROM audit_events a
      LEFT JOIN users actor ON actor.id = a.actor_user_id
      LEFT JOIN users subject ON subject.id = a.subject_user_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY a.id DESC LIMIT ${limit}
    `, params)).rows);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/users/:id/password-reset', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const user = id && await administrativeTransaction(client => loadUser(client, id));
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!mailConfigured()) return res.status(503).json({ error: 'Email (SMTP) is not configured, so a reset link cannot be sent' });
    const sent = await issuePasswordReset(req, user, `admin:${req.user.id}`);
    await recordAudit(req, 'admin.password_reset_sent', sent ? 'success' : 'failure', { subjectUserId: user.id, status: sent ? 200 : 502 });
    if (!sent) return res.status(502).json({ error: 'The reset email could not be delivered. Check SMTP settings and the audit log.' });
    res.json({ success: true, message: `A reset link was emailed to ${user.email}. It expires in 30 minutes.` });
  } catch (error) { next(error); }
});

router.post('/users/:id/revoke-sessions', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const count = id && await administrativeTransaction(async client => {
      if (!await loadUser(client, id)) return null;
      return (await client.query('DELETE FROM sessions WHERE user_id=$1 OR actor_user_id=$1', [id])).rowCount;
    });
    if (count === null || !id) return res.status(404).json({ error: 'User not found' });
    await recordAudit(req, 'admin.sessions_revoked', 'success', { subjectUserId: id, status: 200, detail: { sessions: count } });
    res.json({ success: true, revoked: count });
  } catch (error) { next(error); }
});

router.post('/users/:id/unlock', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const user = id && await administrativeTransaction(async client => {
      const row = await loadUser(client, id);
      if (row) await client.query('DELETE FROM auth_attempts WHERE key = ANY($1)', [attemptKeysForEmail(row.email)]);
      return row;
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    await recordAudit(req, 'admin.account_unlocked', 'success', { subjectUserId: id, status: 200 });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.get('/support-grants', async (req, res, next) => {
  try {
    const rows = await administrativeTransaction(async client => (await client.query(`
      SELECT g.id, g.user_id, u.name, u.email, g.access_level, g.reason, g.created_at, g.expires_at, g.last_used_at
      FROM support_grants g JOIN users u ON u.id = g.user_id
      WHERE g.revoked_at IS NULL AND g.expires_at > NOW() AND g.user_id <> $1
      ORDER BY g.created_at DESC
    `, [req.user.id])).rows);
    res.json(rows);
  } catch (error) { next(error); }
});

router.post('/support-sessions', async (req, res, next) => {
  try {
    const grantId = parseId(req.body?.grantId);
    const token = randomBytes(32).toString('hex');
    const grant = grantId && await administrativeTransaction(async client => {
      const row = (await client.query(`
        SELECT g.*, u.name, u.email FROM support_grants g JOIN users u ON u.id = g.user_id
        WHERE g.id=$1 AND g.revoked_at IS NULL AND g.expires_at > NOW() AND g.user_id <> $2
      `, [grantId, req.user.id])).rows[0];
      if (!row) return null;
      await client.query('DELETE FROM sessions WHERE actor_user_id=$1 AND support_grant_id IS NOT NULL', [req.user.id]);
      await client.query(`
        INSERT INTO sessions (token_hash, user_id, actor_user_id, support_grant_id, expires_at)
        VALUES ($1,$2,$3,$4,LEAST($5::timestamptz, NOW() + make_interval(mins => $6)))
      `, [tokenHash(token), row.user_id, req.user.id, row.id, row.expires_at, SUPPORT_SESSION_MINUTES]);
      return row;
    });
    if (!grant) {
      await recordAudit(req, 'support.session_started', 'denied', { status: 404, detail: { grantId } });
      return res.status(404).json({ error: 'No active support grant was found. Ask the customer to grant access.' });
    }
    await recordAudit(req, 'support.session_started', 'success', {
      subjectUserId: grant.user_id, supportGrantId: grant.id, status: 200, detail: { accessLevel: grant.access_level } });
    sendSecurityNotice(grant, 'Support is viewing your MyFinanceApp account',
      `Hi ${grant.name},\n\n${req.user.name} started a ${grant.access_level === 'write' ? 'read and edit' : 'read-only'} support session using the access you granted. You can revoke access at any time from Settings > Support access.`)
      .catch(() => log('MAIL', 'Support session notice could not be sent'));
    res.cookie(supportCookieName, token, { ...cookieOptions, maxAge: SUPPORT_SESSION_MINUTES * 60000 });
    res.json({ success: true, customer: { id: grant.user_id, name: grant.name }, accessLevel: grant.access_level });
  } catch (error) { next(error); }
});

export default router;
