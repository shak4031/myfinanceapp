import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionHealth, plaidFailureDetails, plaidRecovery } from './plaidHealth.js';

const now = Date.parse('2026-11-09T15:00:00Z');
const connection = { status: 'connected', created_at: '2026-11-01T12:00:00Z',
  last_sync_at: '2026-11-09T12:00:00Z', last_sync_attempt_at: '2026-11-09T12:00:00Z' };

test('bank health measures checks, not transaction dates, and respects exact stale threshold', () => {
  assert.equal(connectionHealth(connection, now).severity, 'clear');
  const atThreshold = { ...connection, last_sync_at: new Date(now - 26 * 3600e3).toISOString() };
  assert.equal(connectionHealth(atThreshold, now).severity, 'clear');
  assert.equal(connectionHealth(atThreshold, now + 1).alarms[0].code, 'SYNC_STALE');
  assert.equal(connectionHealth({ ...connection, last_sync_at: null }, now).alarms[0].code, 'NEVER_SYNCED');
});

test('relink, partial failure and backoff states are distinct', () => {
  const relink = connectionHealth({ ...connection, status: 'relink_required', last_error_code: 'ITEM_LOGIN_REQUIRED' }, now);
  assert.equal(relink.severity, 'critical');
  assert.equal(relink.nextEligibleAt, null);
  assert.match(relink.alarms[0].action, /owner.*repair or reconnect/);
  const failed = connectionHealth({ ...connection, last_sync_at: null, last_error_code: 'PRODUCT_NOT_READY' }, now);
  assert.equal(failed.severity, 'major');
  assert.equal(failed.nextEligibleAt, '2026-11-09T18:00:00.000Z');
  assert.equal(connectionHealth({ ...connection, liabilities_error_code: 'MORTGAGE_DATA_UNAVAILABLE' }, now).severity, 'warning');
});

test('Plaid diagnostics expose only safe metadata, never request configs or payloads', () => {
  const details = plaidFailureDetails({ response: { status: 400, data: {
    error_code: 'ITEM_LOGIN_REQUIRED', error_type: 'ITEM_ERROR', request_id: 'provider-123',
    error_message: 'Private customer data', access_token: 'private-secret'
  }, config: { headers: { secret: 'private-secret' } } } });
  assert.deepEqual(details, { errorCode: 'ITEM_LOGIN_REQUIRED', errorType: 'ITEM_ERROR', providerRequestId: 'provider-123', status: 400 });
  assert.equal(plaidFailureDetails({ code: 'bad\npayload' }).errorCode, 'SYNC_FAILED');
  assert.match(plaidRecovery('PLAID_ENVIRONMENT_MISMATCH'), /PLAID_ENVIRONMENT/);
  assert.equal(plaidFailureDetails({ code: 'PLAID_INVALID_TRANSACTION_AMOUNT', providerRequestId: 'request-456' }).providerRequestId, 'request-456');
  assert.match(plaidRecovery('PLAID_INVALID_TRANSACTION_AMOUNT'), /rolled back.*cursor is unchanged/);
  assert.match(plaidRecovery('PLAID_INVALID_TRANSACTION_AMOUNT'), /Reconnecting is not required/);
});
