import app from './app.js';
import Database from './db.js';
import { log } from './utils/logger.js';
import { purgeExpiredAuditEvents, structuredLog } from './utils/audit.js';

const db = new Database();

async function purge() {
  try {
    const removed = await purgeExpiredAuditEvents();
    if (removed) log('AUDIT', `Removed ${removed} audit events past the retention period`);
  } catch {
    structuredLog('error', { event: 'audit.purge_failed' });
  }
}

process.on('unhandledRejection', error => structuredLog('error', { event: 'process.unhandled_rejection', name: error?.name, stack: error?.stack }));

try {
  await db.init();
  await purge();
  setInterval(purge, 24 * 60 * 60 * 1000).unref();
  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => log('SERVER', `MyFinanceApp listening on port ${port} with private account sessions`));
} catch (error) {
  log('SERVER', `Startup failed: ${error.message}`);
  process.exitCode = 1;
  await db.close();
}
