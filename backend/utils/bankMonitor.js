import { connectionHealth } from './plaidHealth.js';

export async function bankHealthReport(client, { userId = null, connectionId = null, accountId = null } = {}) {
  const rows = (await client.query(`SELECT c.id AS connection_id,c.user_id,c.status,c.created_at,
      c.last_sync_at,c.last_sync_attempt_at,c.last_error_code,c.liabilities_error_code,c.last_webhook_at,c.last_webhook_code,
      u.name AS user_name,u.email AS user_email,a.id AS account_id,a.type,a.subtype,a.linked_account_id,
      (SELECT COUNT(*)::int FROM transactions t WHERE t.user_id=c.user_id AND t.plaid_account_id=a.account_id
        AND t.is_pending=TRUE) AS pending_count,
      (SELECT MIN(t.date) FROM transactions t WHERE t.user_id=c.user_id AND t.plaid_account_id=a.account_id
        AND t.is_pending=TRUE) AS oldest_pending_date,
      (SELECT MAX(t.date) FROM transactions t WHERE t.user_id=c.user_id AND t.plaid_account_id=a.account_id) AS latest_transaction_date,
      (SELECT COUNT(*)::int FROM transaction_import_reviews r WHERE r.user_id=c.user_id
        AND r.plaid_account_id=a.account_id AND r.status='pending') AS review_count
    FROM plaid_connections c JOIN users u ON u.id=c.user_id
    LEFT JOIN plaid_accounts a ON a.connection_id=c.id AND a.user_id=c.user_id
    WHERE ($1::int IS NULL OR c.user_id=$1) AND ($2::int IS NULL OR c.id=$2) AND ($3::int IS NULL OR a.id=$3)
    ORDER BY c.user_id,c.id,a.id LIMIT 501`, [userId, connectionId, accountId])).rows;
  const now = Date.now();
  const accounts = rows.slice(0, 500).map(row => {
    const health = connectionHealth(row, now);
    if (row.oldest_pending_date && Date.parse(`${row.oldest_pending_date}T00:00:00Z`) < now - 7 * 86400e3) {
      health.alarms.push({ severity: 'warning', code: 'AGED_PENDING', since: row.oldest_pending_date,
        message: 'A pending transaction is over seven days old.',
        action: 'Inspect the last successful sync and its modification/removal counts. Pending status is supplied by the bank; do not mark it posted just because it is old.' });
      if (health.severity === 'clear') health.severity = 'warning';
    }
    return {
      userId: row.user_id, userName: row.user_name, userEmail: row.user_email,
      connectionId: row.connection_id, accountId: row.account_id, linkedAccountId: row.linked_account_id,
      type: row.type, subtype: row.subtype, status: row.status,
      lastSyncAt: row.last_sync_at, lastAttemptAt: row.last_sync_attempt_at,
      lastWebhookAt: row.last_webhook_at, lastWebhookCode: row.last_webhook_code,
      latestTransactionDate: row.latest_transaction_date, pendingCount: row.pending_count,
      oldestPendingDate: row.oldest_pending_date, reviewCount: row.review_count, ...health
    };
  });
  const ranks = { critical: 0, major: 1, warning: 2, clear: 3 };
  accounts.sort((a, b) => ranks[a.severity] - ranks[b.severity] || a.userId - b.userId || a.connectionId - b.connectionId);
  return { accounts, truncated: rows.length > 500, generatedAt: new Date(now).toISOString() };
}
