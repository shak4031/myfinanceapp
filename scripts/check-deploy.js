// Post-deploy / scheduled check against a running MyFinance server.
//   APP_URL=https://your-app.up.railway.app LOG_MONITOR_TOKEN=... npm run deploy:check
// Optional: SINCE=30m (how far back to look), FAIL_ON=warn (also fail on warnings).
// Exits 1 if the server is unhealthy or its application logs contain errors or failed (5xx) requests.
const base = (process.env.APP_URL || '').replace(/\/+$/, '');
const token = process.env.LOG_MONITOR_TOKEN || '';
const since = process.env.SINCE || '30m';
const failOnWarn = process.env.FAIL_ON === 'warn';

if (!base || !token) {
  console.error('Set APP_URL (for example https://your-app.up.railway.app) and LOG_MONITOR_TOKEN.');
  process.exit(2);
}

async function get(path, headers = {}) {
  const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body, text };
}

const problems = [];
try {
  const health = await get('/api/health');
  if (health.status !== 200) problems.push(`/api/health -> ${health.status}: ${health.text.slice(0, 200)}`);

  const logs = await get(`/api/monitor/logs?since=${encodeURIComponent(since)}&limit=50`, { Authorization: `Bearer ${token}` });
  if (logs.status === 404) problems.push('/api/monitor/logs is not enabled on the server: set LOG_MONITOR_TOKEN (32+ characters) in its environment');
  else if (logs.status === 401) problems.push('/api/monitor/logs rejected the token: LOG_MONITOR_TOKEN differs from the server value');
  else if (logs.status !== 200 || !logs.body) problems.push(`/api/monitor/logs -> ${logs.status}: ${logs.text.slice(0, 200)}`);
  else {
    const { summary, causes, coverage } = logs.body;
    console.log(`Logs since ${logs.body.since}: ${summary.counts.error} errors, ${summary.counts.warn} warnings (instance ${coverage.instance})`);
    if (!coverage.databaseAvailable) problems.push('Server could not read its stored logs (app_logs); only one instance was checked');
    for (const cause of causes) {
      const line = `${cause.level.toUpperCase()} x${cause.count} ${cause.source}: ${cause.message}${cause.routes.length ? ` [${cause.routes.join(', ')}]` : ''} (last ${cause.last}; requests ${cause.requestIds.join(', ') || '-'})`;
      if (cause.level === 'error' || failOnWarn) problems.push(line);
      else console.log(`  warning: ${line}`);
    }
    for (const failed of summary.failedRequests) problems.push(`${failed.count} failed (5xx) request(s) on ${failed.route}`);
  }
} catch (error) {
  problems.push(`Could not reach ${base}: ${error.message}`);
}

if (problems.length) {
  console.error(`\nDEPLOY CHECK FAILED - ${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  x ${problem}`);
  console.error('Open Admin console > App logs and click a request ID for the full trail.');
  process.exit(1);
}
console.log('Deploy check passed: healthy, no errors in the application logs.');
