import { createHash } from 'node:crypto';
import { failure } from './categorization.js';
import { currentUserId } from './tenant.js';
import { reconcileTransfers } from './transfers.js';

const FIELDS = ['id', 'date', 'description', 'amount', 'direction', 'source', 'category', 'is_fixed',
  'pay_mode', 'income_role', 'account_id', 'plaid_transaction_id', 'plaid_account_id', 'is_pending',
  'display_name', 'name_override', 'category_corrected', 'import_batch_id', 'balance'];
const snapshot = alias => `jsonb_build_object(${FIELDS.map(field => `'${field}',${alias}.${field}`).join(',')},
  'account_name',${alias === 'p' ? 'pa.name' : 'a.name'},
  'institution',${alias === 'p' ? 'pc.institution_name' : 'a.institution'},
  'account_mask',${alias === 'p' ? 'pa.mask' : 'a.last4'})`;
const MATCH = `FROM transactions p
  JOIN transactions e ON e.user_id=p.user_id AND e.id<>p.id
    AND e.source IS DISTINCT FROM 'plaid' AND e.plaid_transaction_id IS NULL
    AND e.amount=p.amount AND e.direction=p.direction
    AND e.date::date BETWEEN p.date::date - 3 AND p.date::date + 3
    AND NOT e.is_pending
  LEFT JOIN plaid_accounts pa ON pa.user_id=p.user_id AND pa.account_id=p.plaid_account_id
  LEFT JOIN plaid_connections pc ON pc.user_id=pa.user_id AND pc.id=pa.connection_id
  LEFT JOIN accounts a ON a.user_id=e.user_id AND a.id=e.account_id
  WHERE p.user_id=$1 AND p.source='plaid' AND p.plaid_transaction_id IS NOT NULL AND NOT p.is_pending
    AND (pa.iso_currency_code IS NULL OR pa.iso_currency_code='USD')
    AND (pa.mask IS NULL OR a.last4 IS NULL OR pa.mask=a.last4)`;
const revision = pair => createHash('sha256').update(JSON.stringify([pair.plaid, pair.existing])).digest('hex');

export async function listTransactionDuplicates(client, input = {}) {
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw failure(400, 'Invalid duplicate review page');
  const total = (await client.query(`SELECT COUNT(*)::int AS count ${MATCH}`, [currentUserId()])).rows[0].count;
  const rows = (await client.query(`SELECT ${snapshot('p')} AS plaid,${snapshot('e')} AS existing
    ${MATCH} ORDER BY p.date DESC,p.id,e.id LIMIT 50 OFFSET $2`, [currentUserId(), offset])).rows;
  return { rows: rows.map(pair => ({ ...pair, revision: revision(pair) })), total, offset, limit: 50 };
}

export async function mergeTransactionDuplicate(client, input) {
  if (!input || input.acknowledged !== true
    || !Number.isSafeInteger(input.plaidId) || input.plaidId < 1
    || !Number.isSafeInteger(input.existingId) || input.existingId < 1
    || input.plaidId === input.existingId || typeof input.revision !== 'string'
    || !/^[a-f0-9]{64}$/.test(input.revision)) {
    throw failure(400, 'Review and confirm one Plaid transaction and its existing match before merging');
  }
  const userId = currentUserId();
  await client.query('SELECT pg_advisory_xact_lock($1::integer,193647)', [userId]);
  const locked = (await client.query(`SELECT id FROM transactions
    WHERE user_id=$1 AND id=ANY($2::integer[]) ORDER BY id FOR UPDATE`,
  [userId, [input.plaidId, input.existingId]])).rows;
  if (locked.length !== 2) throw failure(409, 'The selected transactions are no longer available. Refresh duplicate review; nothing was merged.');
  const pair = (await client.query(`SELECT ${snapshot('p')} AS plaid,${snapshot('e')} AS existing
    ${MATCH} AND p.id=$2 AND e.id=$3`, [userId, input.plaidId, input.existingId])).rows[0];
  if (!pair || revision(pair) !== input.revision) {
    throw failure(409, 'The selected match or its settings changed. Refresh duplicate review before confirming; nothing was merged.');
  }
  if (pair.plaid.import_batch_id !== null) {
    throw failure(409, 'This Plaid record belongs to an import with restore history. Review that import before merging; nothing was merged.');
  }
  const keepId = input.existingId, removeId = input.plaidId;
  await client.query(`UPDATE transaction_import_reviews SET
      resolution_transaction_id=CASE WHEN resolution_transaction_id=$2 THEN $3 ELSE resolution_transaction_id END,
      matched_transaction_id=CASE WHEN matched_transaction_id=$2 THEN $3 ELSE matched_transaction_id END,
      candidate_transaction_ids=ARRAY(SELECT DISTINCT CASE WHEN id=$2 THEN $3 ELSE id END
        FROM unnest(candidate_transaction_ids) id)
    WHERE user_id=$1 AND (resolution_transaction_id=$2 OR matched_transaction_id=$2
      OR candidate_transaction_ids @> ARRAY[$2]::integer[])`, [userId, removeId, keepId]);
  await client.query(`UPDATE transactions SET transfer_pair_id=$3
    WHERE user_id=$1 AND transfer_pair_id=$2`, [userId, removeId, keepId]);
  // Release the unique Plaid identity before attaching it to the retained statement record.
  await client.query('DELETE FROM transactions WHERE user_id=$1 AND id=$2', [userId, removeId]);
  await client.query(`UPDATE transactions SET plaid_transaction_id=$3,plaid_account_id=$4,is_pending=FALSE
    WHERE user_id=$1 AND id=$2`, [userId, keepId, pair.plaid.plaid_transaction_id, pair.plaid.plaid_account_id]);
  await reconcileTransfers(client, userId);
  return { success: true, keptTransactionId: keepId, removedTransactionId: removeId };
}
