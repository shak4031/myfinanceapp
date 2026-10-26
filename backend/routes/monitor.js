// Machine access to application logs for release validation and scheduled monitoring.
// Enabled only when LOG_MONITOR_TOKEN (32+ characters) is set; callers send `Authorization: Bearer <token>`.
// Returns redacted warnings/errors only - never info logs, customer data or anything that changes state.
import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { recordAudit } from '../utils/audit.js';
import { queryLogs, parseSince } from '../utils/logStore.js';

const router = Router();

export function monitorEnabled(env = process.env) {
  return typeof env.LOG_MONITOR_TOKEN === 'string' && env.LOG_MONITOR_TOKEN.length >= 32;
}

function tokenMatches(header) {
  const presented = /^Bearer\s+(.+)$/i.exec(header || '')?.[1]?.trim() || '';
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(process.env.LOG_MONITOR_TOKEN));
}

router.use((req, res, next) => {
  if (!monitorEnabled()) return res.status(404).json({ error: 'Log monitoring is not enabled. Set LOG_MONITOR_TOKEN to turn it on.' });
  if (!tokenMatches(req.get('authorization'))) {
    recordAudit(req, 'monitor.denied', 'denied', { status: 401 });
    return res.status(401).json({ error: 'A valid monitoring token is required' });
  }
  next();
});

router.get('/logs', async (req, res, next) => {
  try {
    const level = req.query.level === 'error' ? 'error' : 'warn';
    const result = await queryLogs({
      level,
      since: parseSince(typeof req.query.since === 'string' ? req.query.since : '', '1h'),
      limit: Math.min(Number(req.query.limit) || 100, 200)
    });
    const errors = result.causes.filter(cause => cause.level === 'error').length + result.summary.failedRequests.length;
    res.json({ status: errors ? 'errors' : 'ok', ...result });
  } catch (error) { next(error); }
});

export default router;
