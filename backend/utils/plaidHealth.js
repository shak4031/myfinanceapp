const HOUR = 60 * 60 * 1000;

export function plaidRecovery(code) {
  if (code === 'PLAID_ENVIRONMENT_MISMATCH') return 'Check PLAID_ENVIRONMENT. Disconnect the old-environment connection and reconnect in the correct environment; saved transactions are kept.';
  if (['ITEM_LOGIN_REQUIRED', 'INVALID_ACCESS_TOKEN', 'ITEM_NOT_FOUND', 'ITEM_ERROR'].includes(code)) return 'Ask the account owner to repair or reconnect this bank in Accounts. Automatic sync cannot repair bank authentication.';
  if (code === 'PRODUCT_NOT_READY') return 'Plaid is still preparing transactions. Retry after the six-hour backoff; check the Plaid dashboard if this persists.';
  if (code === 'INSTITUTION_DOWN' || code === 'INSTITUTION_NOT_RESPONDING') return 'The institution is unavailable. Check Plaid institution status and retry after the backoff.';
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(code)) return 'The Plaid request timed out or the network failed. Check outbound connectivity and Plaid status; the cursor is unchanged, so retry can safely resume.';
  if (code === 'MORTGAGE_DATA_UNAVAILABLE') return 'Transactions may still be current. Ask the owner to enable mortgage access or import a mortgage statement.';
  return 'Inspect the account event timeline and provider request ID. Check server configuration and Plaid dashboard, then ask the owner to retry sync in Accounts.';
}

export function connectionHealth(row, now = Date.now()) {
  const alarms = [];
  const alarm = (severity, code, message, at, action) => alarms.push({ severity, code, message, since: at || row.created_at, action: action || plaidRecovery(code) });
  if (row.status !== 'connected') {
    alarm('critical', row.last_error_code || 'RELINK_REQUIRED', 'Bank connection requires attention; automatic sync is stopped.', row.last_sync_attempt_at);
  } else if (row.last_error_code) {
    alarm('major', row.last_error_code, 'The latest transaction sync failed; the last successful check is unchanged.', row.last_sync_attempt_at);
  }
  const last = row.last_sync_at ? new Date(row.last_sync_at).getTime() : new Date(row.created_at).getTime();
  if (!row.last_sync_at || now - last > 26 * HOUR) {
    alarm('warning', row.last_sync_at ? 'SYNC_STALE' : 'NEVER_SYNCED',
      row.last_sync_at ? 'No successful transaction check in over 26 hours.' : 'No successful transaction check recorded.',
      row.last_sync_at, 'Check recent attempts and scheduler logs. A quiet transaction feed is not proof of failure; use the last successful check, not the newest transaction date.');
  }
  if (row.liabilities_error_code) alarm('warning', row.liabilities_error_code, 'Mortgage details are unavailable; this does not by itself mean transaction sync failed.', row.last_sync_attempt_at);
  const lastAttempt = row.last_sync_attempt_at ? new Date(row.last_sync_attempt_at).getTime() : 0;
  const nextDue = row.status === 'connected'
    ? new Date(Math.max(row.last_sync_at ? last + 24 * HOUR : 0, lastAttempt ? lastAttempt + 6 * HOUR : 0, now)).toISOString() : null;
  return { alarms, severity: alarms[0]?.severity || 'clear', nextEligibleAt: nextDue };
}

// Only known operational metadata is exposed. Never serialize Plaid's Axios response/config.
export function plaidFailureDetails(error) {
  const data = error?.response?.data;
  const code = data?.error_code || data?.error?.error_code || error?.code;
  const safe = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
  return {
    errorCode: safe(code) || 'SYNC_FAILED',
    errorType: safe(data?.error_type),
    providerRequestId: safe(data?.request_id),
    status: Number.isInteger(error?.response?.status) ? error.response.status : undefined
  };
}
