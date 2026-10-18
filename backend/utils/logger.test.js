import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferLevel, log, onLogEntry, requestContext } from './logger.js';
import { structuredLog } from './audit.js';

test('log levels are inferred from wording so caught route errors are never logged as info', () => {
  assert.equal(inferLevel('Error building insights: column "created_at" does not exist'), 'error');
  assert.equal(inferLevel('Startup failed: DATABASE_URL is required'), 'error');
  assert.equal(inferLevel('Insight analytics unavailable: timeout'), 'warn');
  assert.equal(inferLevel('❌ Missing required fields'), 'warn');
  assert.equal(inferLevel('Parsed 2 transactions, 0 duplicates, 0 skipped, 0 errors'), 'info');
});

test('every log line carries its level, module and the request ID of the request being handled', () => {
  const seen = [];
  const stop = onLogEntry(entry => seen.push(entry));
  try {
    requestContext.run({ requestId: 'req-12345678', route: 'GET /api/dashboard/insights' }, () => {
      log('DASHBOARD', 'Error building insights: boom');
      log('DASHBOARD', 'Error text but an expected user mistake', 'warn');
      structuredLog('error', { event: 'route.error', message: 'boom' });
    });
    log('SERVER', 'listening');
  } finally {
    stop();
  }
  assert.deepEqual(seen.map(entry => [entry.level, entry.module || entry.event, entry.requestId ?? null]), [
    ['error', 'DASHBOARD', 'req-12345678'],
    ['warn', 'DASHBOARD', 'req-12345678'],
    ['error', 'route.error', 'req-12345678'],
    ['info', 'SERVER', null]
  ]);
  assert.equal(seen[0].route, 'GET /api/dashboard/insights');
  assert.match(seen[0].time, /^\d{4}-\d{2}-\d{2}T/);
});
