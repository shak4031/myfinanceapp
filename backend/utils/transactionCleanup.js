import { failure, TENANT } from './categorization.js';
import { validateImportedTransaction } from './transactionImport.js';
import { currentUserId } from './tenant.js';
import { reconcileTransfers } from './transfers.js';

export const MAX_CLEANUP_SELECTION = 10000;

export function cleanupFilter(input) {
  if (!['imported', 'transaction'].includes(input.dateType)) throw failure(400, 'Choose a date type');
  const date = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw failure(400, 'Choose valid start and end dates');
    return validateImportedTransaction({ date: value, description: 'Date validation', amount: 1, direction: 'DEBIT' }).date;
  };
  const start = date(input.start), end = date(input.end);
  if (start > end) throw failure(400, 'Start date must not be after end date');
  const source = input.source || 'all';
  if (!['all', 'plaid', 'other'].includes(source)) throw failure(400, 'Choose a valid source');
  const search = input.search ?? '';
  if (typeof search !== 'string' || search.length > 200) throw failure(400, 'Search must be at most 200 characters');
  const params = [start, end, search.trim()];
  // Imported dates use UTC boundaries; bank dates are calendar dates supplied by the institution.
  const dateClause = input.dateType === 'imported'
    ? "created_at >= ($1::date::timestamp AT TIME ZONE 'UTC') AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')"
    : 'date::date >= $1::date AND date::date <= $2::date';
  const sourceClause = source === 'all' ? '' : source === 'plaid'
    ? "AND (plaid_transaction_id IS NOT NULL OR LOWER(source)='plaid')"
    : "AND plaid_transaction_id IS NULL AND LOWER(COALESCE(source,''))<>'plaid'";
  return { where: `${TENANT} AND ${dateClause} ${sourceClause} AND POSITION(LOWER($3) IN LOWER(description)) > 0`, params };
}

export async function listCleanup(client, input) {
  const { where, params } = cleanupFilter(input);
  if (input.selection === 'all') {
    const rows = (await client.query(`SELECT id FROM transactions WHERE ${where} ORDER BY id LIMIT ${MAX_CLEANUP_SELECTION + 1}`, params)).rows;
    if (rows.length > MAX_CLEANUP_SELECTION) throw failure(400, 'More than 10,000 transactions match. Narrow the dates or search before selecting all.');
    return { ids: rows.map(row => row.id) };
  }
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw failure(400, 'Invalid page offset');
  const total = (await client.query(`SELECT COUNT(*)::int AS count FROM transactions WHERE ${where}`, params)).rows[0].count;
  const rows = (await client.query(`SELECT id,date,created_at,description,amount,direction,source
    FROM transactions WHERE ${where} ORDER BY date DESC,id DESC LIMIT 50 OFFSET $4`, [...params, offset])).rows;
  return { rows, total, offset, limit: 50 };
}

export function cleanupIds(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_CLEANUP_SELECTION
    || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw failure(400, 'Select between 1 and 10,000 distinct valid transaction IDs');
  }
  return ids;
}

export async function deleteCleanup(client, ids, acknowledged) {
  cleanupIds(ids);
  if (acknowledged !== true) throw failure(400, 'Confirm permanent deletion before continuing');
  await client.query('SELECT pg_advisory_xact_lock($1::integer, 193647)', [currentUserId()]);
  const rows = (await client.query(`SELECT id FROM transactions WHERE ${TENANT} AND id=ANY($1::integer[]) ORDER BY id FOR UPDATE`, [ids])).rows;
  if (rows.length !== ids.length) throw failure(409, 'Some selected transactions are no longer available. Reload and select again; nothing was deleted.');
  await client.query(`UPDATE transaction_import_reviews SET
    resolution_transaction_id=CASE WHEN resolution_transaction_id=ANY($1::integer[]) THEN NULL ELSE resolution_transaction_id END,
    matched_transaction_id=CASE WHEN matched_transaction_id=ANY($1::integer[]) THEN NULL ELSE matched_transaction_id END,
    candidate_transaction_ids=ARRAY(SELECT id FROM unnest(candidate_transaction_ids) AS id WHERE NOT (id=ANY($1::integer[])))
    WHERE ${TENANT} AND (resolution_transaction_id=ANY($1::integer[]) OR matched_transaction_id=ANY($1::integer[])
      OR candidate_transaction_ids && $1::integer[])`, [ids]);
  const result = await client.query(`DELETE FROM transactions WHERE ${TENANT} AND id=ANY($1::integer[])`, [ids]);
  await reconcileTransfers(client, currentUserId());
  return { success: true, deleted: result.rowCount };
}
