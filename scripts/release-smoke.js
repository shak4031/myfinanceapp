// Release smoke check: boots the real app against an in-memory PostgreSQL (PGlite) that starts from an
// old-style schema, loads realistic data, calls every read endpoint the UI uses and fails on any 5xx
// response or any error-level log entry. Run with `npm run release:check` before every deploy.
// The verdict comes from the same log APIs support uses (/api/admin/logs and /api/monitor/logs), cross-checked
// against an in-process listener so a log line that never reaches the API also blocks the release.
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

process.env.LOG_QUIET = 'true';
process.env.LOG_TO_FILE = 'false';
process.env.OWNER_SETUP_TOKEN = 'release-smoke-setup-token-longer-than-32-characters';
process.env.ALLOW_REGISTRATION = 'true';
process.env.LOG_MONITOR_TOKEN = 'release-smoke-monitor-token-longer-than-32-characters';
const startedAt = new Date().toISOString();
delete process.env.NODE_ENV;

const { onLogEntry } = await import('../backend/utils/logger.js');
const entries = [];
onLogEntry(entry => entries.push(entry));

const database = new PGlite();
let lock = Promise.resolve();
pg.Pool.prototype.connect = async function connect() {
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
};

const { migratePrivateSchema } = await import('../backend/utils/schema.js');
const { resetDemoAccount, DEMO_EMAIL, DEMO_PASSWORD } = await import('../backend/utils/demo.js');
const { default: app } = await import('../backend/app.js');
const { startLogStore, flushLogStore } = await import('../backend/utils/logStore.js');

async function migrate(extra) {
  const client = await pg.Pool.prototype.connect();
  try {
    await client.query('BEGIN');
    await migratePrivateSchema(client);
    if (extra) await extra(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const failures = [];
const month = new Date().toISOString().slice(0, 7);
const READS = [
  ['GET', '/api/auth/me'], ['GET', '/api/license'],
  ['GET', '/api/dashboard/insights'], ['GET', '/api/dashboard/monthly-cashflow'], ['GET', '/api/dashboard/all-transactions'],
  ['POST', '/api/dashboard/summary', { dateFilter: 'current' }], ['POST', '/api/dashboard/upcoming-payments'],
  ['POST', '/api/dashboard/category-spending', { dateFilter: 'current' }], ['POST', '/api/dashboard/category-trends'],
  ['POST', '/api/dashboard/category-transactions-for-month', { category: 'Groceries', month }],
  ['POST', '/api/categorizations/category-summary'], ['GET', '/api/staging/attention'],
  ['GET', '/api/categories'], ['GET', '/api/budgets'], ['GET', '/api/analytics'], ['GET', '/api/analytics/export'],
  ['GET', '/api/debts'], ['GET', '/api/goals'], ['GET', '/api/goals/funding-analysis'],
  ['GET', '/api/plan'], ['POST', '/api/plan/what-if', { extra: 100 }],
  ['GET', '/api/transactions/income-sources'], ['GET', '/api/transactions/categorization-rules'],
  ['GET', '/api/support-access'], ['GET', '/api/accounts']
];
const CSV_SAMPLES = {
  checking: `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,${usDate(-9)},"NORTHWIND TECH PAYROLL PPD ID: 123",3586.20,ACH_CREDIT,7500.00,,
DEBIT,${usDate(-4)},"NETFLIX.COM",-15.49,DEBIT_CARD,7484.51,,`,
  credit_card: `Date,Description,Amount
${usDate(-3)},WHOLE FOODS MARKET,84.12
${usDate(-6)},AUTOPAY PAYMENT - THANK YOU,-350.00`
};

function usDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.APP_ORIGIN = base;

async function call(method, path, body, cookie) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (response.status >= 500) failures.push(`${method} ${path} -> ${response.status} (requestId ${response.headers.get('x-request-id')})`);
  return { status: response.status, headers: response.headers, text };
}
const cookieOf = response => (response.headers.get('set-cookie') || '').split(';')[0];

try {
  // Oldest production shape: a transactions table created before created_at/user_id existed.
  await database.exec('CREATE TABLE transactions (id SERIAL PRIMARY KEY, date TEXT, description TEXT, amount NUMERIC(14,2), direction TEXT, balance NUMERIC(14,2), source TEXT)');
  await migrate();
  startLogStore({ intervalMs: 60000 });
  const owner = await call('POST', '/api/auth/setup', { name: 'Owner', email: 'owner@example.com', password: 'release-smoke-password-123', setupToken: process.env.OWNER_SETUP_TOKEN });
  if (owner.status !== 200 && owner.status !== 201) throw new Error(`Owner setup failed with ${owner.status}: ${owner.text}`);
  const ownerCookie = cookieOf(owner);

  // Legacy rows (MM/DD/YYYY, a blank date) followed by a restart, as an upgraded production database would see.
  await database.exec(`INSERT INTO transactions (date, description, amount, direction, balance, user_id) VALUES
    ('${usDate(-20)}', 'LEGACY PAYROLL', 2500, 'CREDIT', 4000, 1), ('${usDate(-15)}', 'LEGACY GROCER', 45.10, 'DEBIT', 3954.90, 1),
    ('', 'LEGACY BLANK DATE', 1, 'DEBIT', NULL, 1)`);
  await migrate(client => resetDemoAccount(client));

  const missingAccount = await call('POST', '/api/import/import-csv', { csvData: Object.values(CSV_SAMPLES)[0], source: 'no-account.csv' }, ownerCookie);
  if (missingAccount.status !== 400) failures.push(`CSV import without an account should be rejected, got ${missingAccount.status}`);
  for (const [index, [source, csvData]] of Object.entries(CSV_SAMPLES).entries()) {
    const kind = ['checking', 'savings', 'credit_card'].includes(source) ? source : 'checking';
    const newAccount = { name: `Smoke ${source}`, kind, last4: String(1180 + index).padStart(4, '0') };
    const result = await call('POST', '/api/import/import-csv', { csvData, source, newAccount }, ownerCookie);
    if (result.status !== 200) failures.push(`CSV import (${source}) -> ${result.status}: ${result.text.slice(0, 200)}`);
  }

  const demo = await call('POST', '/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASSWORD });
  const accounts = [['owner', ownerCookie], ['demo', demo.status === 200 ? cookieOf(demo) : null]];
  if (demo.status !== 200) failures.push(`Demo login -> ${demo.status}`);
  let calls = 0;
  for (const [, cookie] of accounts.filter(([, cookie]) => cookie)) {
    for (const [method, path, body] of READS) { await call(method, path, body, cookie); calls++; }
  }
  console.log(`Release smoke: ${calls} endpoint calls across ${accounts.length} accounts`);
  await validateThroughLogApis(ownerCookie);
} catch (error) {
  failures.push(`Smoke run crashed: ${error.stack || error.message}`);
} finally {
  server.close();
}

async function validateThroughLogApis(ownerCookie) {
  await flushLogStore();
  const since = encodeURIComponent(startedAt);
  const admin = await call('GET', `/api/admin/logs?level=warn&since=${since}&limit=1000`, undefined, ownerCookie);
  if (admin.status !== 200) return failures.push(`GET /api/admin/logs -> ${admin.status}: ${admin.text.slice(0, 200)}`);
  const adminLogs = JSON.parse(admin.text);
  if (!adminLogs.coverage.databaseAvailable) failures.push('Admin log viewer could not read stored logs (app_logs)');
  for (const cause of adminLogs.causes.filter(cause => cause.level === 'error')) {
    failures.push(`App logs x${cause.count}: ${cause.source}: ${cause.message}${cause.routes.length ? ` [${cause.routes.join(', ')}]` : ''}`);
  }
  for (const failed of adminLogs.summary.failedRequests) failures.push(`App logs: ${failed.count} failed request(s) on ${failed.route}`);
  const expected = entries.filter(entry => entry.level === 'error').length;
  if (adminLogs.summary.counts.error !== expected) {
    failures.push(`Log API reported ${adminLogs.summary.counts.error} errors but the app wrote ${expected}; logs are not reaching support`);
  }

  const denied = await fetch(`${base}/api/monitor/logs`, { headers: { Authorization: 'Bearer wrong-token' } });
  if (denied.status !== 401) failures.push(`Monitor endpoint accepted a wrong token (status ${denied.status})`);
  const monitor = await fetch(`${base}/api/monitor/logs?since=${since}`, { headers: { Authorization: `Bearer ${process.env.LOG_MONITOR_TOKEN}` } });
  if (monitor.status !== 200) return failures.push(`GET /api/monitor/logs -> ${monitor.status}`);
  const monitored = await monitor.json();
  if (monitored.status !== (adminLogs.summary.counts.error || adminLogs.summary.failedRequests.length ? 'errors' : 'ok')) {
    failures.push(`Monitor endpoint status "${monitored.status}" disagrees with the admin log viewer`);
  }
  console.log(`Log APIs: ${adminLogs.summary.counts.error} errors, ${adminLogs.summary.counts.warn} warnings since ${startedAt}; monitor status ${monitored.status}`);
}

const errors = entries.filter(entry => entry.level === 'error');
const warnings = entries.filter(entry => entry.level === 'warn');
// One failing request logs several lines (route log, route.error, audit, http.request); report each cause once.
const causes = new Map();
for (const entry of errors) {
  if (entry.event === 'http.request' || entry.event === 'server.error') continue;
  const key = `${entry.module || entry.event}: ${entry.message || entry.name || ''}`.trim();
  const where = entry.route || entry.path || '';
  const cause = causes.get(key) || { count: 0, where: new Set() };
  cause.count++;
  if (where) cause.where.add(where);
  causes.set(key, cause);
}
for (const [key, cause] of causes) failures.push(`Error log x${cause.count}: ${key}${cause.where.size ? ` [${[...cause.where].join(', ')}]` : ''}`);
if (errors.length && !causes.size) failures.push(`${errors.length} error-level log entries without a message`);
if (warnings.length) {
  console.log(`Warnings (${warnings.length}, not blocking):`);
  for (const entry of warnings.slice(0, 20)) console.log(`  - ${entry.module || entry.event}: ${entry.message || ''}`);
}
if (failures.length) {
  console.error(`\nRELEASE BLOCKED - ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  x ${failure}`);
  process.exit(1);
}
console.log('Release smoke passed: no 5xx responses and no error-level log entries.');
process.exit(0);
