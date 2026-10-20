import { Router } from 'express';
import Database from '../db.js';
import { failure } from '../utils/categorization.js';
import { currentUserId } from '../utils/tenant.js';
import { parseTxDate } from '../utils/normalize.js';
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABELS, accountBalances, reconcileTransfers, savedAmount } from '../utils/transfers.js';

const router = Router();
const db = new Database();
const route = handler => async (req, res, next) => {
  try { await handler(req, res); } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
};
const cents = value => Math.round(value * 100) / 100;
const COLUMNS = 'id, name, kind, institution, last4, status, suggested_kind, discovered_from, statement, created_at, updated_at';

// Validates account fields. `partial` allows PATCH bodies that change only some fields.
export function accountInput(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const out = {};
  if (!partial || input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw failure(400, 'Account name is required (up to 80 characters)');
    out.name = input.name.trim();
  }
  if (!partial || input.kind !== undefined) {
    if (!ACCOUNT_KINDS.includes(input.kind)) throw failure(400, `Account type must be one of: ${ACCOUNT_KINDS.join(', ')}`);
    out.kind = input.kind;
  }
  if (input.last4 !== undefined && input.last4 !== null && input.last4 !== '') {
    if (!/^\d{4}$/.test(String(input.last4))) throw failure(400, 'Last four digits must be exactly 4 numbers');
    out.last4 = String(input.last4);
  } else if (input.last4 !== undefined) out.last4 = null;
  if (input.institution !== undefined && input.institution !== null && input.institution !== '') {
    if (typeof input.institution !== 'string' || input.institution.trim().length > 80) throw failure(400, 'Bank name must be up to 80 characters');
    out.institution = input.institution.trim();
  } else if (input.institution !== undefined) out.institution = null;
  return out;
}

// Every import names the account it came from: an existing account id, or a new account to create.
// A new account whose last four digits match one discovered from transfer wording adopts that account.
export async function resolveImportAccount(client, body) {
  const userId = currentUserId();
  if (body?.accountId != null && body.accountId !== '') {
    const id = Number(body.accountId);
    const account = Number.isSafeInteger(id) ? (await client.query(`SELECT ${COLUMNS} FROM accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId])).rows[0] : null;
    if (!account) throw failure(400, 'That account was not found. Choose one of your accounts.');
    if (account.kind === 'external') throw failure(400, 'That account is marked "not my account". Change its type before importing its statement.');
    return account;
  }
  if (body?.newAccount) {
    const input = accountInput(body.newAccount);
    if (['unknown', 'external'].includes(input.kind)) throw failure(400, 'Choose the type of account this statement is from');
    if (input.last4) {
      const existing = (await client.query(`SELECT ${COLUMNS} FROM accounts WHERE user_id = $1 AND last4 = $2 ORDER BY (kind = 'unknown') DESC, id LIMIT 1`, [userId, input.last4])).rows[0];
      if (existing && (existing.kind === 'unknown' || existing.kind === input.kind)) {
        return (await client.query(`UPDATE accounts SET name = $1, kind = $2, institution = COALESCE($3, institution), status = 'active', updated_at = NOW()
          WHERE id = $4 AND user_id = $5 RETURNING ${COLUMNS}`, [input.name, input.kind, input.institution ?? null, existing.id, userId])).rows[0];
      }
    }
    return (await client.query(`INSERT INTO accounts (user_id, name, kind, institution, last4, status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING ${COLUMNS}`,
      [userId, input.name, input.kind, input.institution ?? null, input.last4 ?? null])).rows[0];
  }
  throw failure(400, 'Choose which account this statement is from (accountId or newAccount is required)');
}

export async function resolveStatementAccount(client, body, statement) {
  if (body?.accountId != null && body.accountId !== '' || body?.newAccount) return resolveImportAccount(client, body);
  const userId = currentUserId();
  const review = message => Object.assign(failure(422, `${message} Choose the account for this PDF and retry. Nothing was imported.`), {
    code: 'ACCOUNT_REVIEW_REQUIRED',
    detectedAccount: { last4: statement.last4, institution: statement.institution, kind: statement.accountKind }
  });
  if (!statement.last4 || statement.identityAmbiguous) throw review('The statement account could not be identified unambiguously.');
  // Serialise automatic account creation for a tenant, including simultaneous first imports.
  await client.query('SELECT pg_advisory_xact_lock(74938121,$1::integer)', [userId]);
  const matches = (await client.query(`SELECT ${COLUMNS} FROM accounts WHERE user_id=$1 AND last4=$2 ORDER BY id FOR UPDATE`, [userId, statement.last4])).rows;
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/bank$/, '');
  const compatible = matches.filter(account => account.kind === 'unknown' || (statement.type === 'credit-card'
    ? account.kind === 'credit_card' : ['checking', 'savings'].includes(account.kind)));
  const kindMatches = statement.accountKind ? compatible.filter(account => account.kind === statement.accountKind || account.kind === 'unknown') : compatible;
  const issuerMatches = statement.institution ? kindMatches.filter(account => !account.institution || normalize(account.institution) === normalize(statement.institution)) : kindMatches;
  if (issuerMatches.length > 1) throw review('Several saved accounts share this statement account ending.');
  const existing = issuerMatches[0];
  if (existing) {
    if (existing.kind !== 'unknown') return existing;
    if (!statement.accountKind) throw review('The statement does not clearly identify checking versus savings.');
    return (await client.query(`UPDATE accounts SET kind=$1, institution=COALESCE(institution,$2), status='active', updated_at=NOW()
      WHERE id=$3 AND user_id=$4 RETURNING ${COLUMNS}`, [statement.accountKind, statement.institution, existing.id, userId])).rows[0];
  }
  if (matches.some(account => account.kind === 'external')) throw review('An account with this ending is marked "not my account".');
  if (matches.length) throw review('The statement account identity conflicts with a saved account.');
  if (!statement.accountKind) throw review('The statement does not clearly identify checking versus savings.');
  const label = ACCOUNT_KIND_LABELS[statement.accountKind];
  const name = `${statement.institution || label} ${statement.institution ? label.toLowerCase() + ' ' : ''}••${statement.last4}`.slice(0, 80);
  return (await client.query(`INSERT INTO accounts (user_id,name,kind,institution,last4,status) VALUES ($1,$2,$3,$4,$5,'active') RETURNING ${COLUMNS}`,
    [userId, name, statement.accountKind, statement.institution, statement.last4])).rows[0];
}

router.get('/', route(async (req, res) => {
  const userId = currentUserId();
  const result = await db.transaction(async client => {
    const accounts = (await client.query(`SELECT ${COLUMNS} FROM accounts WHERE user_id = $1 ORDER BY (status = 'needs_review') DESC, kind, name, id`, [userId])).rows;
    const rows = (await client.query(`SELECT id, date, description, category, amount, direction, balance, account_id, source, transfer_kind, transfer_account_id, created_at
      FROM transactions WHERE user_id = $1`, [userId])).rows;
    return { accounts, rows };
  });
  const { accounts, rows } = result;
  const byId = new Map(accounts.map(account => [account.id, account]));
  const balances = accountBalances(rows, accounts);
  const stats = new Map(accounts.map(account => [account.id, { transactions: 0, firstDate: null, lastDate: null, lastDataAddedAt: null, transfersTo: 0, unknown: 0, unknownTotal: 0 }]));
  const unassigned = new Map();
  const today = new Date();
  const monthPrefix = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  let unknownCount = 0, unknownTotal = 0, savedThisMonth = 0, savedCount = 0;
  const unknownRows = [];
  for (const row of rows) {
    const iso = parseTxDate(row.date)?.iso || null;
    if (row.account_id != null && stats.has(row.account_id)) {
      const entry = stats.get(row.account_id);
      entry.transactions++;
      if (iso && (!entry.firstDate || iso < entry.firstDate)) entry.firstDate = iso;
      if (iso && (!entry.lastDate || iso > entry.lastDate)) entry.lastDate = iso;
      if (row.created_at) {
        const addedAt = new Date(row.created_at).toISOString();
        if (!entry.lastDataAddedAt || addedAt > entry.lastDataAddedAt) entry.lastDataAddedAt = addedAt;
      }
    } else if (row.account_id == null) {
      const key = row.source || 'import';
      if (!unassigned.has(key)) unassigned.set(key, { source: key, transactions: 0, firstDate: null, lastDate: null });
      const entry = unassigned.get(key);
      entry.transactions++;
      if (iso && (!entry.firstDate || iso < entry.firstDate)) entry.firstDate = iso;
      if (iso && (!entry.lastDate || iso > entry.lastDate)) entry.lastDate = iso;
    }
    if (row.transfer_account_id != null && stats.has(row.transfer_account_id)) {
      const entry = stats.get(row.transfer_account_id);
      entry.transfersTo++;
      if (row.transfer_kind === 'unknown') { entry.unknown++; entry.unknownTotal += Math.abs(Number(row.amount)) || 0; }
    }
    if (row.transfer_kind === 'unknown') {
      unknownCount++;
      unknownTotal += Math.abs(Number(row.amount)) || 0;
      unknownRows.push({ id: row.id, date: iso, description: row.description, category: row.category, amount: Number(row.amount),
        direction: row.direction, account: byId.get(row.account_id)?.name || null, transferAccount: byId.get(row.transfer_account_id)?.name || null });
    }
    if (row.transfer_kind === 'savings' && iso?.startsWith(monthPrefix)) {
      savedThisMonth += savedAmount(row, byId.get(row.account_id)?.kind || null);
      savedCount++;
    }
  }
  res.json({
    accounts: accounts.map(account => {
      const entry = stats.get(account.id);
      const balance = balances.get(account.id) || null;
      const statementDate = parseTxDate(account.statement?.closingDate)?.iso || null;
      const dataAsOf = [entry.lastDate, statementDate].filter(Boolean).sort().at(-1) || null;
      return { ...account, kindLabel: ACCOUNT_KIND_LABELS[account.kind], ...entry, unknownTotal: cents(entry.unknownTotal),
        dataAsOf, balance: balance?.balance ?? null, balanceAsOf: balance?.asOf ?? null };
    }),
    unassigned: [...unassigned.values()].sort((a, b) => b.transactions - a.transactions),
    unknownTransfers: { count: unknownCount, total: cents(unknownTotal),
      recent: unknownRows.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 50) },
    savedThisMonth: { amount: cents(savedThisMonth), transfers: savedCount },
    needsReview: accounts.filter(account => account.status === 'needs_review').length,
    kinds: ACCOUNT_KINDS.map(kind => ({ value: kind, label: ACCOUNT_KIND_LABELS[kind] }))
  });
}));

router.post('/', route(async (req, res) => {
  const input = accountInput(req.body);
  const userId = currentUserId();
  const result = await db.transaction(async client => {
    const account = (await client.query(`INSERT INTO accounts (user_id, name, kind, institution, last4, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
      [userId, input.name, input.kind, input.institution ?? null, input.last4 ?? null, input.kind === 'unknown' ? 'needs_review' : 'active'])).rows[0];
    return { account, reconcile: await reconcileTransfers(client, userId) };
  });
  res.status(201).json(result);
}));

router.patch('/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Invalid account id');
  const input = accountInput(req.body, { partial: true });
  if (!Object.keys(input).length) throw failure(400, 'Nothing to update');
  const userId = currentUserId();
  const result = await db.transaction(async client => {
    const sets = [], params = [];
    for (const [key, value] of Object.entries(input)) { params.push(value); sets.push(`${key} = $${params.length}`); }
    // Choosing a type is the review: the account stops asking for attention.
    if (input.kind) sets.push(`status = '${input.kind === 'unknown' ? 'needs_review' : 'active'}'`);
    params.push(id, userId);
    const account = (await client.query(`UPDATE accounts SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING ${COLUMNS}`, params)).rows[0];
    if (!account) throw failure(404, 'Account not found');
    return { account, reconcile: await reconcileTransfers(client, userId) };
  });
  res.json(result);
}));

router.delete('/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw failure(400, 'Invalid account id');
  const userId = currentUserId();
  const result = await db.transaction(async client => {
    const used = Number((await client.query('SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = $1 AND user_id = $2', [id, userId])).rows[0].n);
    if (used) throw failure(409, `This account has ${used} imported transaction${used === 1 ? '' : 's'}. Delete or move them first.`);
    await client.query('UPDATE transactions SET transfer_account_id = NULL, transfer_checked = FALSE WHERE transfer_account_id = $1 AND user_id = $2', [id, userId]);
    const deleted = await client.query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!deleted.rowCount) throw failure(404, 'Account not found');
    return { success: true, reconcile: await reconcileTransfers(client, userId) };
  });
  res.json(result);
}));

// Older imports were not tied to an account; assign everything from one import source at once.
router.post('/assign', route(async (req, res) => {
  const source = typeof req.body?.source === 'string' ? req.body.source : null;
  const accountId = Number(req.body?.accountId);
  if (!source || !Number.isSafeInteger(accountId)) throw failure(400, 'source and accountId are required');
  const userId = currentUserId();
  const result = await db.transaction(async client => {
    const account = (await client.query('SELECT id FROM accounts WHERE id = $1 AND user_id = $2', [accountId, userId])).rows[0];
    if (!account) throw failure(404, 'Account not found');
    const updated = await client.query('UPDATE transactions SET account_id = $1, transfer_checked = FALSE WHERE source = $2 AND account_id IS NULL AND user_id = $3', [accountId, source, userId]);
    return { assigned: updated.rowCount, reconcile: await reconcileTransfers(client, userId) };
  });
  res.json({ success: true, ...result });
}));

export default router;
