import app from './app.js';
import Database, { administrativeTransaction } from './db.js';
import { log } from './utils/logger.js';
import { purgeExpiredAuditEvents, structuredLog } from './utils/audit.js';
import { syncDuePlaidConnections } from './routes/plaid.js';
import { demoEnabled, resetDemoAccount, startDemoResets } from './utils/demo.js';
import { startLogStore, purgeExpiredLogs, flushLogStore } from './utils/logStore.js';
import { startTrialReminders } from './utils/billing.js';
import { startUnverifiedCleanup } from './utils/unverifiedAccounts.js';

const db = new Database();

async function purge() {
  try {
    const removed = await purgeExpiredAuditEvents();
    if (removed) log('AUDIT', `Removed ${removed} audit events past the retention period`);
    const logs = await purgeExpiredLogs();
    if (logs) log('LOG_STORE', `Removed ${logs} app log entries past the retention period`);
  } catch {
    structuredLog('error', { event: 'audit.purge_failed' });
  }
}

process.on('unhandledRejection', error => structuredLog('error', { event: 'process.unhandled_rejection', name: error?.name, message: error?.message, stack: error?.stack }));
process.on('uncaughtException', error => {
  structuredLog('error', { event: 'process.uncaught_exception', name: error?.name, message: error?.message, stack: error?.stack });
  process.exitCode = 1;
  flushLogStore().finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 2000).unref();
});

let plaidScanRunning = false;
async function syncPlaid() {
  if (plaidScanRunning) return;
  plaidScanRunning = true;
  try {
    await syncDuePlaidConnections(structuredLog);
  } catch (error) {
    structuredLog('error', { event: 'plaid.scheduled_sync_scan_failed', name: error?.name,
      message: 'Could not scan due bank connections. Check database connectivity and scheduler configuration; no banks were checked by this scan.' });
  } finally {
    plaidScanRunning = false;
  }
}

try {
  await db.init();
  startLogStore();
  startTrialReminders();
  startUnverifiedCleanup();
  await purge();
  setInterval(purge, 24 * 60 * 60 * 1000).unref();
  if (demoEnabled()) {
    await startDemoResets(
      async () => {
        const result = await administrativeTransaction(client => resetDemoAccount(client));
        log('DEMO', `Demo account reset with ${result.transactions} sample transactions`);
      },
      error => structuredLog('error', { event: 'demo.reset_failed', name: error?.name, message: error?.message })
    );
  }
  const port = process.env.PORT || 3000;
  process.once('SIGTERM', () => { flushLogStore().finally(() => process.exit(0)); });
  app.listen(port, '0.0.0.0', () => {
    log('SERVER', `MyFinanceApp listening on port ${port} with private account sessions`);
    syncPlaid();
    setInterval(syncPlaid, 60 * 60 * 1000).unref();
  });
} catch (error) {
  log('SERVER', `Startup failed: ${error.message}`);
  process.exitCode = 1;
  await db.close();
}
