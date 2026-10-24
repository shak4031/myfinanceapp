import { createHash, randomBytes } from 'node:crypto';
import { currentUserId } from './tenant.js';
import { failure } from './categorization.js';
import { normalizeDescription, parseTxDate, extractMerchantCore } from './normalize.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inputHash = body => hash([body.csvData, body.source, body.accountId, body.newAccount, body.accountMappings]);
const reviewRequired = () => Object.assign(failure(409, 'Review possible overlaps before importing. Nothing was imported.'),
  { code: 'OVERLAP_REVIEW_REQUIRED' });

function similar(left, right) {
  const words = value => new Set(normalizeDescription(extractMerchantCore(value)).match(/[A-Z0-9]+/g) || []);
  const a = words(left), b = words(right);
  const shared = [...a].filter(word => word.length > 2 && b.has(word)).length;
  return shared > 0 && shared / Math.max(1, Math.min(a.size, b.size)) >= 0.5;
}

export async function findOverlaps(client, transactions, accounts, body) {
  const incoming = transactions.map((row, index) => ({ ...row, index, accountId: accounts.get(row.accountKey).id }));
  // Fetch only same-day, same-cent-value candidates for this file, not the user's history.
  const candidates = (await client.query(`SELECT t.* FROM transactions t
    WHERE t.user_id=$2 AND EXISTS (
      SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS i(date text,amount numeric,direction text,"accountId" integer)
      WHERE t.date::date=i.date::date AND ROUND(t.amount::numeric,2)=i.amount
      AND UPPER(BTRIM(t.direction))=UPPER(i.direction)
      AND (t.account_id IS NULL OR t.account_id=i."accountId"))
    ORDER BY t.id LIMIT 2001 FOR UPDATE`,
  [JSON.stringify(incoming), currentUserId()])).rows;
  if (candidates.length > 2000) throw failure(422, 'Too many possible overlaps to review safely. Export a smaller date range; nothing was imported.');
  const valueKey = row => JSON.stringify([parseTxDate(row.date)?.iso, Math.round(Number(row.amount) * 100), row.direction.trim().toUpperCase()]);
  const byValue = new Map();
  for (const candidate of candidates) {
    const key = valueKey(candidate);
    if (!byValue.has(key)) byValue.set(key, []);
    byValue.get(key).push(candidate);
  }
  const rows = [];
  let links = 0;
  for (const row of incoming) {
    const matches = (byValue.get(valueKey(row)) || []).filter(candidate =>
      candidate.account_id === null || candidate.account_id === row.accountId);
    if (matches.some(candidate => candidate.account_id === row.accountId
      && normalizeDescription(candidate.description) === normalizeDescription(row.description))) continue;
    const possible = matches.filter(candidate => normalizeDescription(candidate.description) === normalizeDescription(row.description)
      || similar(candidate.description, row.description));
    if (!possible.length) continue;
    const account = accounts.get(row.accountKey);
    const choice = body.accountMappings?.[row.accountKey] || (accounts.size === 1 || row.accountKey === 'unidentified' ? body : {});
    rows.push({ index: row.index, incoming: { date: row.date, description: row.description, amount: row.amount,
      direction: row.direction, accountName: account.name, accountKind: account.kind, last4: account.last4,
      accountId: choice.newAccount ? null : account.id },
    candidates: possible.map(candidate => ({ id: candidate.id, date: candidate.date, description: candidate.description,
      amount: candidate.amount, direction: candidate.direction, source: candidate.source,
      accountName: candidate.account_id === null ? null : account.name,
      exact: normalizeDescription(candidate.description) === normalizeDescription(row.description) })),
    snapshot: possible });
    links += possible.length;
    if (rows.length > 500 || links > 2000) {
      throw failure(422, 'Too many overlaps need review. Export a smaller date range; nothing was imported.');
    }
  }
  const uses = new Map();
  for (const row of rows) for (const candidate of row.candidates) uses.set(candidate.id, (uses.get(candidate.id) || 0) + 1);
  for (const row of rows) row.bulkEligible = row.candidates.length === 1 && row.candidates[0].exact && uses.get(row.candidates[0].id) === 1;
  return rows;
}

export async function saveOverlapReview(client, body, rows) {
  const reviewToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60000);
  await client.query('DELETE FROM import_reviews WHERE expires_at<=NOW()');
  await client.query('INSERT INTO import_reviews(token_hash,payload,expires_at) VALUES($1,$2::jsonb,$3)',
    [hash(reviewToken), JSON.stringify({ action: 'csv-overlap', input: inputHash(body), revision: hash(rows) }), expiresAt]);
  return { reviewToken, expiresAt: expiresAt.toISOString(), rows: rows.map(({ snapshot, ...row }) => row) };
}

export async function applyOverlapReview(client, body, rows, accounts, transactions) {
  const confirmation = body.overlapReview;
  if (!confirmation) {
    if (rows.length) throw reviewRequired();
    return { transactions, assigned: 0, duplicates: new Map() };
  }
  if (confirmation.acknowledged !== true || typeof confirmation.reviewToken !== 'string'
    || !Array.isArray(confirmation.decisions)) throw failure(400, 'Review and acknowledge every overlap before confirming.');
  const stored = (await client.query(`SELECT payload FROM import_reviews
    WHERE token_hash=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE`,
  [hash(confirmation.reviewToken), currentUserId()])).rows[0]?.payload;
  if (!stored || stored.action !== 'csv-overlap' || stored.input !== inputHash(body) || stored.revision !== hash(rows)) {
    throw reviewRequired();
  }
  if (confirmation.decisions.some(choice => !choice || !Number.isSafeInteger(choice.index))) throw failure(400, 'Invalid overlap choices.');
  const decisions = new Map(confirmation.decisions.map(choice => [choice.index, choice.transactionId]));
  if (decisions.size !== rows.length || confirmation.decisions.length !== rows.length) throw failure(400, 'Choose an action for every overlap.');
  const retained = new Set(), skipped = new Set(), duplicates = new Map();
  let assigned = 0;
  for (const row of rows) {
    const id = decisions.get(row.index);
    if (id === 'new') {
      transactions[row.index] = { ...transactions[row.index], overlapReviewedNew: true };
      continue;
    }
    if (!Number.isSafeInteger(id) || !row.candidates.some(candidate => candidate.id === id) || retained.has(id)) {
      throw failure(400, 'Each existing transaction can match only one incoming row. Review your overlap choices.');
    }
    retained.add(id);
    skipped.add(row.index);
    const account = accounts.get(transactions[row.index].accountKey);
    const updated = await client.query(`UPDATE transactions SET account_id=$1,transfer_checked=FALSE
      WHERE id=$2 AND user_id=$3 AND account_id IS NULL`, [account.id, id, currentUserId()]);
    assigned += updated.rowCount;
    duplicates.set(account.id, (duplicates.get(account.id) || 0) + 1);
  }
  await client.query('DELETE FROM import_reviews WHERE token_hash=$1 AND user_id=$2', [hash(confirmation.reviewToken), currentUserId()]);
  return { transactions: transactions.filter((row, index) => !skipped.has(index)), assigned, duplicates };
}
