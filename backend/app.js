/* Force redeploy marker: 1780952552331 */
import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'node:crypto';
import auth, { requireUser, requireAdmin, enforceSameOrigin } from './routes/auth.js';
import admin from './routes/admin.js';
import supportAccess from './routes/supportAccess.js';
import { recordAudit, structuredLog } from './utils/audit.js';
import { requestContext } from './utils/logger.js';
import dashboard from './routes/dashboard.js';
import transactions from './routes/transactions.js';
import debts from './routes/debts.js';
import goals from './routes/goals.js';
import importCsv from './routes/import.js';
import bulkImport from './routes/bulk-import.js';
import categories from './routes/categories.js';
import categorizations from './routes/categorizations.js';
import clientErrors from './routes/clientErrors.js';
import license from './routes/license.js';
import budgets from './routes/budgets.js';
import analytics from './routes/analytics.js';
import moneyPlan from './routes/plan.js';
import monitor from './routes/monitor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
function safeErrorMessage(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(password|token|secret|cookie|authorization|amount|balance|description)\s*[:=]\s*[^,;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?:[$€£]\s*)-?\d[\d,]*(?:\.\d{1,2})?/g, '[amount]')
    .replace(/\b[a-f0-9]{40,}\b/gi, '[redacted]')
    .slice(0, 500);
}
if (process.env.TRUST_PROXY_HOPS !== undefined) {
  const hops = Number(process.env.TRUST_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 10');
  app.set('trust proxy', hops);
}

// Middleware
if (process.env.NODE_ENV === 'production') {
  let origin;
  try { origin = new URL(process.env.APP_ORIGIN); } catch { throw new Error('A valid HTTPS APP_ORIGIN is required in production'); }
  if (origin.protocol !== 'https:' || origin.origin !== process.env.APP_ORIGIN) throw new Error('APP_ORIGIN must be an HTTPS origin without a path or trailing slash');
}
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// Every request gets a correlation ID that is returned to the client and stored with logs/audit rows.
app.use((req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = /^[A-Za-z0-9-]{8,64}$/.test(incoming || '') ? incoming : randomUUID();
  res.set('X-Request-Id', req.id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api')) return;
    structuredLog(res.statusCode >= 500 ? 'error' : 'info', {
      event: 'http.request', requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0],
      status: res.statusCode, durationMs: Number((process.hrtime.bigint() - started) / 1000000n),
      user: req.user?.id ?? null, actor: req.support?.actorUserId ?? null
    });
    // Routes that handle their own errors still get an audit record for support follow-up.
    if (res.statusCode >= 500 && !res.locals.errorAudited) {
      recordAudit(req, 'server.error', 'error', { status: res.statusCode, detail: { source: 'route' } });
    }
  });
  requestContext.run({ requestId: req.id, route: `${req.method} ${req.originalUrl.split('?')[0]}` }, next);
});
app.use(bodyParser.json({ limit: '20mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  const json = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 500 && !res.locals.errorAudited) {
      res.locals.errorAudited = true;
      // The client only sees a generic message; the real reason goes to the log, tied to the request ID.
      structuredLog('error', { event: 'route.error', requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0],
        status: res.statusCode, message: safeErrorMessage(typeof body?.error === 'string' ? body.error : 'unknown') });
      recordAudit(req, 'server.error', 'error', {
        status: res.statusCode,
        detail: { source: 'route', ...(typeof body?.error === 'string' ? { message: safeErrorMessage(body.error) } : {}) }
      });
    }
    return json(res.statusCode >= 500
      ? { error: 'The request could not be completed. Please try again.', requestId: req.id }
      : body);
  };
  next();
});
app.use('/api', enforceSameOrigin);

import staging from './routes/staging.js';

// ... existing imports ...

// Routes BEFORE static files
app.use('/api/auth', auth);
// Token-authenticated (not session) so CI and uptime monitors can read redacted error logs.
app.use('/api/monitor', monitor);
app.use('/api', requireUser);
app.use('/api/client-errors', clientErrors);
app.use('/api/support-access', supportAccess);
app.use('/api/admin', requireAdmin, admin);
app.use('/api/dashboard', dashboard);
app.use('/api/transactions', transactions);
app.use('/api/staging', staging);
app.use('/api/dashboard', transactions); // Alias for update-transaction support
app.use('/api/debts', debts);
app.use('/api/goals', goals);
app.use('/api/import', importCsv);
app.use('/api/bulk-import', bulkImport);
app.use('/api/categories', categories);
app.use('/api/categorizations', categorizations);
app.use('/api/license', license);
app.use('/api/budgets', budgets);
app.use('/api/analytics', analytics);
app.use('/api/plan', moneyPlan);
app.use('/api/categorizations-lite', (req, res) => res.status(410).json({ error: 'Use the private categorization tools in the main application' }));
// Global application logs are only available to administrators (/api/admin/logs) and monitors (/api/monitor/logs).
app.use('/api/logs', (req, res) => res.status(403).json({ error: 'Use the admin console App logs tab (/api/admin/logs)' }));
app.get('/api/health', (req, res) => res.json({ status: 'healthy' }));
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// Static files (after API routes)
app.use(express.static(join(__dirname, '../frontend'), {
  setHeaders(res, path) {
    if (/\.(?:html|js|css)$/.test(path)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

// Serve frontend
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(join(__dirname, '../frontend/index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  if (err.code === '25006') {
    // PostgreSQL rejected a write inside a read-only support session.
    return res.status(403).json({ error: 'This support session is read-only.' });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The upload is too large' });
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status >= 500) {
    res.locals.errorAudited = true;
    structuredLog('error', { event: 'server.exception', requestId: req.id, method: req.method, path: req.originalUrl.split('?')[0], status,
      name: err.name, code: err.code, message: typeof err.message === 'string' ? safeErrorMessage(err.message) : undefined, stack: err.stack });
    recordAudit(req, 'server.error', 'error', { status, detail: {
      name: err.name, code: err.code || null, source: 'exception',
      ...(typeof err.message === 'string' ? { message: safeErrorMessage(err.message) } : {})
    } });
  }
  res.status(status).json({ error: status < 500 ? err.message : 'The request could not be completed. Please try again.', requestId: req.id });
});

export default app;
