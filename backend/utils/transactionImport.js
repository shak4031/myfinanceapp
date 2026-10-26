import { currentUserId } from './tenant.js';
import { classify, loadCategorization, failure, TENANT } from './categorization.js';

const MAX_AMOUNT = 999999999999.99;
const DAY_MS = 24 * 60 * 60 * 1000;

export function validateImportedTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') throw failure(400, 'Invalid transaction record');
  const rawDate = String(transaction.date ?? '').trim();
  let year, month, day;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawDate);
  if (match) [, year, month, day] = match.map((value, index) => index ? Number(value) : value);
  else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDate);
    if (match) [, month, day, year] = match.map((value, index) => index ? Number(value) : value);
  }
  const parsedDate = match && new Date(Date.UTC(year, month - 1, day));
  if (!parsedDate || year < 1900 || year > 2100
    || parsedDate.getUTCFullYear() !== year || parsedDate.getUTCMonth() !== month - 1
    || parsedDate.getUTCDate() !== day) throw failure(400, `Invalid transaction date: ${rawDate}`);

  const amount = Number(transaction.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT
    || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) {
    throw failure(400, 'Transaction amount must be a positive value with no more than two decimal places');
  }
  const direction = String(transaction.direction ?? '').toUpperCase();
  if (!['DEBIT', 'CREDIT'].includes(direction)) throw failure(400, 'Invalid transaction direction');
  const description = String(transaction.description ?? '').replace(/\s+/g, ' ').trim();
  if (!description || description.length > 500) throw failure(400, 'Transaction description must be between 1 and 500 characters');
  const balance = transaction.balance == null || transaction.balance === '' ? null : Number(transaction.balance);
  if (balance !== null && (!Number.isFinite(balance) || Math.abs(balance) > MAX_AMOUNT
    || Math.abs(balance * 100 - Math.round(balance * 100)) > 0.00001)) {
    throw failure(400, 'Transaction balance must be a valid value with no more than two decimal places');
  }
  return {
    ...transaction,
    date: parsedDate.toISOString().slice(0, 10),
    amount: Math.round(amount * 100) / 100,
    balance: balance === null ? null : Math.round(balance * 100) / 100,
    direction,
    description
  };
}

function dayDistance(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

function isPossibleMatch(incoming, existing) {
  if (incoming.direction !== existing.direction || Number(incoming.amount) !== Number(existing.amount)) return false;
  const days = dayDistance(incoming.date, existing.date);
  return Number.isFinite(days) && days <= 3;
}

async function findCandidateTransactions(client, transaction) {
  const start = new Date(Date.parse(`${transaction.date}T00:00:00Z`) - 3 * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(Date.parse(`${transaction.date}T00:00:00Z`) + 3 * DAY_MS).toISOString().slice(0, 10);
  const rows = (await client.query(`SELECT id, date, description, amount, direction FROM transactions
    WHERE ${TENANT} AND date >= $1 AND date <= $2 AND amount = $3 AND UPPER(direction) = $4
      AND ($5::text IS NULL OR plaid_transaction_id IS DISTINCT FROM $5)`,
  [start, end, transaction.amount, transaction.direction, transaction.plaidTransactionId ?? null])).rows;
  return rows.filter(row => isPossibleMatch(transaction, row));
}

async function insertTransaction(client, transaction, config, source, plaid = {}, manualCategory = null) {
  let suggestion = null;
  if (manualCategory !== null) {
    const category = (await client.query(`SELECT name FROM categories WHERE ${TENANT} AND name=$1`, [manualCategory])).rows[0];
    if (!category) throw failure(409, 'The selected category no longer exists; review the transaction and choose a current category');
  } else {
    suggestion = classify(transaction, config.compiled, config.names);
  }
  const fixed = suggestion?.label?.is_fixed === true;
  const category = manualCategory ?? suggestion.category;
  const row = (await client.query(`INSERT INTO transactions
    (date,description,amount,direction,balance,source,category,label_id,is_fixed,
      plaid_transaction_id,plaid_account_id,is_pending,category_corrected,display_name)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
  [transaction.date, transaction.description, transaction.amount, transaction.direction, transaction.balance,
    source, category, suggestion?.label?.id ?? null, fixed,
    plaid.transactionId ?? null, plaid.accountId ?? null, plaid.isPending === true, manualCategory !== null,
    transaction.displayName ?? null])).rows[0];
  return row.id;
}

export async function importTransactions(client, transactions, config, source, plaid = {}) {
  const userId = currentUserId();
  await client.query('SELECT pg_advisory_xact_lock($1::integer, 193647)', [userId]);
  let imported = 0;
  let duplicates = 0;
  let needsReview = 0;
  for (const raw of transactions) {
    const transaction = validateImportedTransaction(raw);
    const transactionId = raw.plaidTransactionId ?? plaid.transactionId;
    const accountId = raw.plaidAccountId ?? plaid.accountId;
    const isPending = raw.isPending ?? plaid.isPending === true;
    const manualCategory = raw.manualCategory ?? null;
    if (transactionId) {
      const existing = (await client.query(`SELECT id FROM transactions
        WHERE ${TENANT} AND plaid_transaction_id = $1`,
      [transactionId])).rows[0];
      if (existing) { duplicates++; continue; }
      const reviewed = (await client.query(`SELECT id FROM transaction_import_reviews
        WHERE ${TENANT} AND plaid_transaction_id = $1 AND status IN ('pending','duplicate','imported')`,
      [transactionId])).rows[0];
      if (reviewed) { duplicates++; continue; }
    }
    const candidates = await findCandidateTransactions(client, {
      ...transaction,
      plaidTransactionId: transactionId
    });
    if (candidates.length) {
      const review = await client.query(`INSERT INTO transaction_import_reviews
        (source,date,description,amount,direction,balance,category,plaid_transaction_id,plaid_account_id,
          is_pending,candidate_transaction_ids,user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (user_id, plaid_transaction_id)
          WHERE plaid_transaction_id IS NOT NULL AND status = 'pending' DO NOTHING
        RETURNING id`,
      [source, transaction.date, transaction.description, transaction.amount, transaction.direction,
        transaction.balance, manualCategory, transactionId ?? null, accountId ?? null, isPending,
        candidates.map(row => row.id), userId]);
      if (review.rowCount) needsReview++;
      else duplicates++;
      continue;
    }
    await insertTransaction(client, transaction, config, source, {
      transactionId, accountId, isPending
    }, manualCategory);
    imported++;
  }
  return { imported, duplicates, needsReview, excluded: 0 };
}

export async function importReviewedTransaction(client, review, config) {
  const userId = currentUserId();
  await client.query('SELECT pg_advisory_xact_lock($1::integer, 193647)', [userId]);
  const transaction = validateImportedTransaction(review);
  if (review.plaid_transaction_id) {
    const alreadyImported = (await client.query(`SELECT id FROM transactions
      WHERE ${TENANT} AND plaid_transaction_id = $1`,
    [review.plaid_transaction_id])).rows[0];
    if (alreadyImported) throw failure(409, 'This connected transaction is already in your transaction history');
  }
  return insertTransaction(client, transaction, config, review.source, {
    transactionId: review.plaid_transaction_id,
    accountId: review.plaid_account_id,
    isPending: review.is_pending
  }, review.category);
}

export async function loadImportCategorization(client) {
  return loadCategorization(client);
}

export async function findTransactionCandidates(client, transaction) {
  const validated = validateImportedTransaction(transaction);
  return findCandidateTransactions(client, validated);
}

export async function refreshImportReviewCandidates(client, review) {
  const candidates = await findTransactionCandidates(client, review);
  const candidateIds = candidates.map(row => Number(row.id)).sort((a, b) => a - b);
  const storedIds = (review.candidate_transaction_ids || []).map(Number).sort((a, b) => a - b);
  if (candidateIds.length === storedIds.length
    && candidateIds.every((id, index) => id === storedIds[index])) return false;
  await client.query(`UPDATE transaction_import_reviews SET candidate_transaction_ids=$2
    WHERE id=$1 AND ${TENANT}`, [review.id, candidateIds]);
  return true;
}
