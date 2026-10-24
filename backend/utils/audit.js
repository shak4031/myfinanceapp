import { createHash, createHmac } from 'node:crypto';
import { administrativeTransaction } from '../db.js';
import { log, writeEntry } from './logger.js';

const SECRET_KEYS = /pass|token|secret|cookie|authorization|amount|balance|description/i;
const alertTimes = new Map();

// Identifiers are keyed so audit rows can be searched without storing raw email/IP values.
export function hashIdentifier(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  const secret = process.env.AUDIT_HASH_SECRET;
  return secret
    ? createHmac('sha256', secret).update(normalized).digest('hex')
    : createHash('sha256').update(`finance-audit:${normalized}`).digest('hex');
}

export function sanitizeDetail(detail = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(detail || {})) {
    if (SECRET_KEYS.test(key) || value === undefined) continue;
    clean[key] = typeof value === 'string' ? value.slice(0, 500) : value;
  }
  return clean;
}

export function structuredLog(level, payload) {
  writeEntry({ ...payload, level });
}

async function sendAlert(event) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const now = Date.now();
  if (now - (alertTimes.get(event.event_type) || 0) < 60000) return;
  alertTimes.set(event.event_type, now);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `MyFinanceApp ${event.outcome}: ${event.event_type} (request ${event.request_id || 'n/a'})`,
        event: { type: event.event_type, outcome: event.outcome, requestId: event.request_id, status: event.status }
      }),
      signal: AbortSignal.timeout(5000)
    });
  } catch {
    log('ALERT', 'Alert webhook delivery failed');
  }
}

export async function recordAudit(req, eventType, outcome, fields = {}) {
  const event = {
    event_type: eventType,
    outcome,
    actor_user_id: fields.actorUserId ?? req?.support?.actorUserId ?? req?.user?.id ?? null,
    subject_user_id: fields.subjectUserId ?? req?.user?.id ?? null,
    support_grant_id: fields.supportGrantId ?? req?.support?.grantId ?? null,
    request_id: req?.id || null,
    ip_hash: req ? hashIdentifier(req.ip) : null,
    email_hash: fields.email ? hashIdentifier(fields.email) : null,
    method: req?.method || null,
    path: req ? String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300) : null,
    status: fields.status ?? null,
    detail: sanitizeDetail(fields.detail)
  };
  const logDetail = { ...event.detail };
  delete logDetail.fileName;
  delete logDetail.fileNames;
  structuredLog(outcome === 'error' ? 'error' : outcome === 'failure' || outcome === 'denied' ? 'warn' : 'info', {
    event: eventType, outcome, requestId: event.request_id, actor: event.actor_user_id,
    subject: event.subject_user_id, grant: event.support_grant_id, status: event.status, detail: logDetail
  });
  try {
    await administrativeTransaction(client => client.query(`
      INSERT INTO audit_events (event_type,outcome,actor_user_id,subject_user_id,support_grant_id,request_id,
        ip_hash,email_hash,method,path,status,detail)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    `, [event.event_type, event.outcome, event.actor_user_id, event.subject_user_id, event.support_grant_id,
      event.request_id, event.ip_hash, event.email_hash, event.method, event.path, event.status,
      JSON.stringify(event.detail)]));
  } catch {
    // Auditing must never break the user's request; the structured console line above remains.
    structuredLog('error', { event: 'audit.write_failed', requestId: event.request_id });
  }
  if (outcome === 'error' || eventType === 'auth.locked') sendAlert(event);
}

export function auditRetentionDays() {
  const days = Number(process.env.AUDIT_RETENTION_DAYS || 365);
  return Number.isInteger(days) && days >= 30 && days <= 3650 ? days : 365;
}

export async function purgeExpiredAuditEvents() {
  return administrativeTransaction(async client => {
    const result = await client.query(
      'DELETE FROM audit_events WHERE created_at < NOW() - make_interval(days => $1)', [auditRetentionDays()]);
    await client.query('DELETE FROM password_reset_tokens WHERE expires_at < NOW() - INTERVAL \'1 day\'');
    await client.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    return result.rowCount;
  });
}
