import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { administrativeTransaction } from '../db.js';
import { recordAudit, hashIdentifier, auditRetentionDays } from '../utils/audit.js';
import { tokenHash } from '../utils/passwords.js';
import { mailConfigured, sendSecurityNotice } from '../utils/mailer.js';
import { issuePasswordReset, attemptKeysForEmail, supportCookieName, cookieOptions } from './auth.js';
import { openApiSpec } from '../utils/openapi.js';
import { log } from '../utils/logger.js';
import { queryLogs, parseSince, logRetentionDays } from '../utils/logStore.js';
import { monitorEnabled } from './monitor.js';
import { entitlementFromRow, setLicense, OWNER_USER_ID } from '../utils/license.js';
import { isDemoEmail } from '../utils/demo.js';
import { stripeClient } from '../utils/billing.js';

const router = Router();
const SUPPORT_SESSION_MINUTES = 120;
const startedAt = Date.now();
const endedStripeSubscriptionStatuses = new Set(['canceled', 'incomplete_expired']);

const parseId = value => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function loadUser(client, id) {
  return (await client.query('SELECT id,name,email,role FROM users WHERE id=$1 AND password_hash IS NOT NULL', [id])).rows[0];
}

async function loadDeletionTarget(client, id, lock = false) {
  return (await client.query(`SELECT u.id,u.name,u.email,u.role,m.role AS household_role,m.household_id,
      h.owner_user_id,(SELECT COUNT(*)::int FROM household_members members WHERE members.household_id=m.household_id) AS household_members,
      s.stripe_customer_id,s.stripe_subscription_id,s.checkout_session_id,s.checkout_expires_at
    FROM users u
    LEFT JOIN household_members m ON m.user_id=u.id
    LEFT JOIN households h ON h.id=m.household_id
    LEFT JOIN household_subscriptions s ON s.household_id=m.household_id
    WHERE u.id=$1 AND u.password_hash IS NOT NULL${lock ? ' FOR UPDATE OF u' : ''}`, [id])).rows[0];
}

function deletionConflict(target) {
  if (target.id === OWNER_USER_ID || String(target.role).toLowerCase() === 'admin') return 'Administrator accounts cannot be deleted here.';
  if (isDemoEmail(target.email)) return 'The demo account cannot be deleted.';
  if (target.household_role === 'owner' && Number(target.household_members) > 1) {
    return 'This account owns a household with other members. Remove or transfer household members before deleting it.';
  }
  if (target.household_role === 'owner' && target.checkout_session_id
    && (!target.checkout_expires_at || new Date(target.checkout_expires_at).getTime() > Date.now())) {
    return 'This household has a Stripe checkout in progress. Complete or allow the checkout session to expire before deleting its owner account.';
  }
  return null;
}

async function cancelStripeSubscriptionForDeletion(target) {
  if (target.household_role !== 'owner' || !target.stripe_subscription_id) return null;
  const stripe = stripeClient();
  const subscription = await stripe.subscriptions.retrieve(target.stripe_subscription_id);
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (customerId !== target.stripe_customer_id) {
    return 'The Stripe subscription does not match this household’s billing customer. Resolve the billing record before deleting the account.';
  }
  if (endedStripeSubscriptionStatuses.has(subscription.status)) return false;
  const canceled = await stripe.subscriptions.cancel(subscription.id, { invoice_now: false, prorate: false }, {
    idempotencyKey: `admin-delete-${target.id}-${subscription.id}`
  });
  if (!endedStripeSubscriptionStatuses.has(canceled.status)) {
    return 'Stripe did not confirm that the subscription was canceled. The account was not deleted; refresh and try again.';
  }
  return true;
}

router.get('/openapi.json', (req, res) => res.json(openApiSpec()));

router.get('/overview', async (req, res, next) => {
  try {
    const started = Date.now();
    const stats = await administrativeTransaction(async client => (await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE password_hash IS NOT NULL) AS users,
        (SELECT COUNT(*)::int FROM sessions WHERE expires_at > NOW() AND last_activity_at > NOW() - INTERVAL '10 minutes' AND support_grant_id IS NULL) AS active_sessions,
        (SELECT COUNT(*)::int FROM audit_events WHERE created_at > NOW() - INTERVAL '24 hours'
           AND event_type = 'auth.login' AND outcome = 'failure') AS failed_logins_24h,
        (SELECT COUNT(*)::int FROM audit_events WHERE created_at > NOW() - INTERVAL '24 hours'
           AND event_type = 'auth.locked') AS lockouts_24h,
        (SELECT COUNT(*)::int FROM audit_events WHERE created_at > NOW() - INTERVAL '24 hours'
           AND event_type = 'server.error') AS server_errors_24h,
        (SELECT COUNT(*)::int FROM audit_events WHERE created_at > NOW() - INTERVAL '24 hours'
           AND event_type = 'client.error') AS browser_errors_24h,
        (SELECT COUNT(*)::int FROM support_grants WHERE revoked_at IS NULL AND expires_at > NOW()) AS active_support_grants,
        (SELECT COUNT(*)::int FROM user_licenses WHERE requested_plan IS NOT NULL) AS pending_plan_requests,
        (SELECT COUNT(*)::int FROM app_logs WHERE created_at > NOW() - INTERVAL '24 hours' AND level = 'error'
           AND source NOT IN ('http.request', 'server.error')) AS app_errors_24h,
        (SELECT COUNT(*)::int FROM app_logs WHERE created_at > NOW() - INTERVAL '24 hours' AND level = 'warn') AS app_warnings_24h
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
      logRetentionDays: logRetentionDays(),
      monitorTokenConfigured: monitorEnabled(),
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
        (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > NOW() AND s.last_activity_at > NOW() - INTERVAL '10 minutes' AND s.support_grant_id IS NULL) AS active_sessions,
        (SELECT COUNT(*)::int FROM support_grants g WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.expires_at > NOW()) AS active_grants,
        l.plan AS license_plan, l.granted_at AS license_granted_at, l.revoked_at AS license_revoked_at,
        l.trial_started_at AS license_trial_started_at, l.trial_ends_at AS license_trial_ends_at,
        l.requested_plan AS license_requested_plan, l.requested_at AS license_requested_at,
        h.owner_user_id AS household_owner_id,to_jsonb(subscription) AS subscription
      FROM users u
      LEFT JOIN household_members membership ON membership.user_id=u.id
      LEFT JOIN households h ON h.id=membership.household_id
      LEFT JOIN household_subscriptions subscription ON subscription.household_id=h.id
      LEFT JOIN user_licenses l ON l.user_id = COALESCE(h.owner_user_id,u.id)
      WHERE u.password_hash IS NOT NULL AND ($1 = '' OR lower(u.email) LIKE '%' || $1 || '%' OR lower(u.name) LIKE '%' || $1 || '%')
      ORDER BY (l.requested_plan IS NOT NULL) DESC, u.id LIMIT 200
    `, [q])).rows);
    res.json(rows.map(({ license_plan, license_granted_at, license_revoked_at, license_trial_started_at, license_trial_ends_at, license_requested_plan, license_requested_at, subscription, household_owner_id, ...user }) => {
      const row = license_granted_at || license_revoked_at || license_trial_started_at || license_requested_plan || subscription
        ? { plan: license_plan, granted_at: license_granted_at, revoked_at: license_revoked_at, trial_started_at: license_trial_started_at, trial_ends_at: license_trial_ends_at,
            requested_plan: license_requested_plan, requested_at: license_requested_at, subscription }
        : null;
      const { tier, source, daysLeft, trialEndsAt, plusActive, request } = entitlementFromRow(household_owner_id || user.id, row, new Date(), user.email);
      return { ...user, license: { tier, source, daysLeft, trialEndsAt, plusActive, request } };
    }));
  } catch (error) { next(error); }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'A valid user ID is required' });
    const confirmEmail = typeof req.body?.confirmEmail === 'string' ? req.body.confirmEmail.trim() : '';
    if (!confirmEmail) return res.status(400).json({ error: 'Type the account email to confirm deletion' });

    const target = await administrativeTransaction(client => loadDeletionTarget(client, id));
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (confirmEmail.toLowerCase() !== target.email.toLowerCase()) {
      return res.status(400).json({ error: 'The confirmation email does not match this account' });
    }
    const conflict = deletionConflict(target);
    if (conflict) return res.status(409).json({ error: conflict });
    if (target.household_role === 'owner' && target.stripe_subscription_id
      && req.body?.cancelStripeSubscription !== true) {
      return res.status(409).json({ error: 'Confirm immediate Stripe subscription cancellation to continue deleting this account.' });
    }

    const connections = await administrativeTransaction(async client => (await client.query(
      'SELECT id FROM plaid_connections WHERE user_id=$1', [id]
    )).rows);
    if (connections.length) {
      return res.status(409).json({ error: 'Disconnect this account’s Plaid bank connections in the app before deleting the account.' });
    }

    const deleted = await administrativeTransaction(async client => {
      let current = await loadDeletionTarget(client, id, true);
      if (!current) return null;
      if (current.email.toLowerCase() !== confirmEmail.toLowerCase()) {
        return { conflict: 'The account email changed. Search for the account again and confirm with its current email.' };
      }
      if (current.household_role === 'owner') {
        await client.query('SELECT id FROM households WHERE id=$1 FOR UPDATE', [current.household_id]);
        await client.query('SELECT household_id FROM household_subscriptions WHERE household_id=$1 FOR UPDATE', [current.household_id]);
        current = await loadDeletionTarget(client, id);
      }
      const currentConflict = deletionConflict(current);
      if (currentConflict) return { conflict: currentConflict };
      if (current.household_role === 'owner' && current.stripe_subscription_id
        && req.body?.cancelStripeSubscription !== true) {
        return { conflict: 'Confirm immediate Stripe subscription cancellation to continue deleting this account.' };
      }
      const plaid = await client.query('SELECT 1 FROM plaid_connections WHERE user_id=$1 LIMIT 1', [id]);
      if (plaid.rowCount) return { conflict: 'Disconnect this account’s Plaid bank connections in the app before deleting the account.' };
      const stripeCancellation = await cancelStripeSubscriptionForDeletion(current);
      if (typeof stripeCancellation === 'string') return { conflict: stripeCancellation };

      const counts = {};
      const remove = async (table, sql = `DELETE FROM ${table} WHERE user_id=$1`) => {
        counts[table] = (await client.query(sql, [id])).rowCount;
      };

      await remove('transaction_import_reviews');
      await remove('transactions');
      await remove('transaction_labels');
      await remove('accounts');
      await remove('import_batches');
      await remove('plaid_accounts');
      await remove('plaid_connections');
      await remove('staging_transactions');
      await remove('credit_cards');
      await remove('savings_goals');
      await remove('categories');
      await remove('category_budgets');
      await remove('money_plans');
      await remove('household_profiles');
      await remove('name_rules');
      await remove('import_reviews');
      await client.query('DELETE FROM household_invitations WHERE invited_by=$1', [id]);
      await client.query('DELETE FROM auth_attempts WHERE key = ANY($1)', [attemptKeysForEmail(current.email)]);
      if (current.household_role === 'owner') {
        await client.query('DELETE FROM household_invitations WHERE household_id=$1', [current.household_id]);
        await client.query('DELETE FROM household_subscriptions WHERE household_id=$1', [current.household_id]);
        await client.query('DELETE FROM households WHERE id=$1', [current.household_id]);
      } else {
        await client.query('DELETE FROM household_members WHERE user_id=$1', [id]);
      }
      const result = await client.query('DELETE FROM users WHERE id=$1 AND email=$2 RETURNING id', [id, current.email]);
      if (!result.rowCount) throw new Error('The account changed during deletion.');
      return {
        id: result.rows[0].id, email: current.email, counts,
        stripeSubscriptionCanceled: stripeCancellation
      };
    });

    if (!deleted) return res.status(404).json({ error: 'User not found' });
    if (deleted.conflict) return res.status(409).json({ error: deleted.conflict });
    await recordAudit(req, 'admin.account_deleted', 'success', {
      subjectUserId: deleted.id, status: 200,
      detail: {
        removedRecords: deleted.counts,
        stripeSubscriptionCanceled: deleted.stripeSubscriptionCanceled
      }
    });
    res.json({
      success: true, deleted: true, email: deleted.email,
      stripeSubscriptionCanceled: deleted.stripeSubscriptionCanceled
    });
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

router.get('/errors', async (req, res, next) => {
  try {
    const params = [];
    const filters = ["a.event_type IN ('server.error', 'client.error')"];
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId.trim().slice(0, 64) : '';
    if (requestId) {
      params.push(requestId);
      filters.push(`a.request_id = $${params.length}`);
    }
    const ranges = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
    const range = typeof req.query.range === 'string' && (req.query.range === 'all' || Object.prototype.hasOwnProperty.call(ranges, req.query.range))
      ? req.query.range : '24h';
    const days = ranges[range];
    if (days) {
      params.push(days);
      filters.push(`a.created_at > NOW() - make_interval(days => $${params.length})`);
    }
    const rows = await administrativeTransaction(async client => (await client.query(`
      SELECT a.id, a.created_at, a.event_type, a.actor_user_id, actor.email AS actor_email,
        a.request_id, a.method, a.path, a.status, a.detail
      FROM audit_events a
      LEFT JOIN users actor ON actor.id = a.actor_user_id
      WHERE ${filters.join(' AND ')}
      ORDER BY a.id DESC LIMIT 300
    `, params)).rows);
    res.json(rows);
  } catch (error) { next(error); }
});

router.get('/logs', async (req, res, next) => {
  try {
    const level = ['error', 'warn', 'info'].includes(req.query.level) ? req.query.level : 'warn';
    const since = parseSince(typeof req.query.since === 'string' ? req.query.since : '', '24h');
    const result = await queryLogs({
      level, since,
      q: typeof req.query.q === 'string' ? req.query.q : '',
      requestId: typeof req.query.requestId === 'string' ? req.query.requestId : '',
      limit: Number(req.query.limit) || 200
    });
    // Auto-refresh polls are not audited individually; the first view of each search is.
    if (req.query.refresh !== '1') {
      recordAudit(req, 'admin.logs_viewed', 'success', { status: 200, detail: { level, since: result.since, filtered: Boolean(req.query.q || req.query.requestId) } });
    }
    res.json(result);
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

router.post('/users/:id/license', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const action = req.body?.action;
    const plan = req.body?.plan ?? 'pro';
    if (!['grant', 'revoke'].includes(action)) return res.status(400).json({ error: 'action must be grant or revoke' });
    if (!['basic', 'pro'].includes(plan)) return res.status(400).json({ error: 'plan must be basic or pro' });
    if (id === OWNER_USER_ID) return res.status(400).json({ error: 'The owner account always includes MyFinance Pro' });
    const entitlement = id && await administrativeTransaction(async client => {
      const user = await loadUser(client, id);
      if (!user) return null;
      if (isDemoEmail(user.email)) return { demo: true };
      return setLicense(client, id, action, req.user.id, plan);
    });
    if (!entitlement) return res.status(404).json({ error: 'User not found' });
    if (entitlement.demo) return res.status(400).json({ error: 'The demo account always includes MyFinance Pro' });
    await recordAudit(req, `admin.license_${action === 'grant' ? 'granted' : 'revoked'}`, 'success', { subjectUserId: id, status: 200 });
    res.json({ success: true, license: { tier: entitlement.tier, source: entitlement.source, plusActive: entitlement.plusActive } });
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
