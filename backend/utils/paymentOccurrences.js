import { createHash } from 'node:crypto';
import { billTypesCompatible, createBillMatcher, getFixedBillCategory, isFixedPayment, sameBill } from './fixedPayments.js';
import { parseTxDate, getCanonicalMerchant } from './normalize.js';
import { currentReadOnly, currentUserId } from './tenant.js';
import { sameSourceAccount, sourceAccountsCompatible, TRANSACTION_ACCOUNT_FIELDS, TRANSACTION_ACCOUNT_JOINS } from './transactionAccount.js';

const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const keyFor = (id, date) => createHash('sha256').update(`${id}:${date}`).digest('hex');
const confirmationDate = row => row.resolved_at ? iso(new Date(row.resolved_at)) : null;

function accountCompatible(a, b) {
  if (!sourceAccountsCompatible(a, b)) return false;
  if (!billTypesCompatible(a, b)) return false;
  const mask = tx => (tx.description || '').match(/(?:\bx+|\*{2,})(\d{2,4})\b/i)?.[1];
  return !mask(a) || !mask(b) || mask(a) === mask(b);
}

export function samePayment(a, b, matchesBill = sameBill) {
  if (!accountCompatible(a, b)) return false;
  if (a.id != null && String(a.id) === String(b.id)) return true;
  const crossSource = (a.account_id != null && a.plaid_account_id == null && b.plaid_account_id != null && b.account_id == null)
    || (b.account_id != null && b.plaid_account_id == null && a.plaid_account_id != null && a.account_id == null);
  if (crossSource) return false;
  // Renames are presentation, not a different bill identity.
  return matchesBill(a, b) || matchesBill(a, b, { ignoreDisplayName: true });
}

const merchantWords = tx => new Set(getCanonicalMerchant(tx.description).toUpperCase().split(/[^A-Z]+/)
  .filter(word => word.length >= 3 && !['GOOGLE', 'PAYPAL', 'ONLINE', 'PAYMENT', 'CARD', 'PREMIUM', 'THE', 'AND', 'FOR'].includes(word)));

function descriptionVariant(a, b, matchesBill, words) {
  if (!accountCompatible(a, b) || !sameSourceAccount(a, b)) return false;
  if (matchesBill(a, b, { allowMissingMask: true })
    || matchesBill(a, b, { allowMissingMask: true, ignoreDisplayName: true })) return true;
  const left = words(a), right = words(b);
  return Math.min(left.size, right.size) >= 2
    && ([...left].every(word => right.has(word)) || [...right].every(word => left.has(word)));
}

export function reconcilePaymentOccurrences(transactions, stored, today, through, estimates = []) {
  const matchesBill = createBillMatcher();
  const matchesPayment = (a, b) => samePayment(a, b, matchesBill);
  const wordCache = new WeakMap();
  const words = tx => {
    if (!wordCache.has(tx)) wordCache.set(tx, merchantWords(tx));
    return wordCache.get(tx);
  };
  const matchesVariant = (a, b) => descriptionVariant(a, b, matchesBill, words);
  const todayKey = iso(today);
  const month = todayKey.slice(0, 7);
  const previousMonthStart = iso(new Date(today.getFullYear(), today.getMonth() - 1, 1));
  const recentStart = iso(new Date(today.getFullYear(), today.getMonth() - 2, 1));
  const debits = transactions.filter(tx => String(tx.direction).toUpperCase() === 'DEBIT' && !tx.is_pending)
    .map(tx => {
      const parsed = parseTxDate(tx.date);
      if (!parsed || new Date(parsed.year, parsed.month, parsed.day).getMonth() !== parsed.month
        || !Number.isFinite(Number(tx.amount)) || Number(tx.amount) <= 0) {
        throw new Error(`Invalid fixed payment data for transaction ${tx.id}`);
      }
      return { ...tx, date: parsed.iso, amount: Number(tx.amount) };
    }).filter(tx => tx.date <= todayKey).sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
  const occurrences = stored.filter(row => row.due_date >= previousMonthStart).map(row => ({ ...row,
    template: { ...row.template, ...debits.find(tx => String(tx.id) === String(row.template.id)) }, amount: Number(row.amount),
    resolved_at: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at }));
  // Rebuild automatic matches: legacy oldest-first assignments could consume a
  // payment from a different month and leave its actual month's bill unpaid.
  for (const row of occurrences) {
    if (row.matched_transaction_id != null && debits.some(tx => String(tx.id) === String(row.matched_transaction_id))) {
      row.matched_transaction_id = null;
      if (!row.resolved_at) {
        row.status = 'projected';
        row.amount = Number(row.template.amount);
      }
    }
  }
  const cancelled = new Set();
  const estimatedRows = new Set();
  const estimatedItems = [];
  const groups = [];
  for (const tx of [...debits.filter(isFixedPayment), ...occurrences.map(row => row.template)]) {
    let group = groups.find(group => group.templates.some(template => matchesPayment(template, tx)));
    if (!group) { group = { template: tx, templates: [], payments: [], occurrences: [] }; groups.push(group); }
    group.templates.push(tx);
  }
  // Consolidate changed provider identities only when both groups have a unique partner.
  const partners = group => groups.filter(other => other !== group
    && group.templates.every(left => other.templates.every(right => accountCompatible(left, right)))
    && !group.templates.some(left => isFixedPayment(left)
      && other.templates.some(right => isFixedPayment(right) && left.date.slice(0, 7) === right.date.slice(0, 7)))
    && group.templates.some(left => other.templates.some(right => matchesVariant(left, right))));
  for (const group of [...groups]) {
    if (!groups.includes(group)) continue;
    const matches = partners(group);
    if (matches.length === 1 && partners(matches[0]).length === 1) {
      group.templates.push(...matches[0].templates);
      groups.splice(groups.indexOf(matches[0]), 1);
    }
  }
  // Dates, amounts and flags do not affect identity. Compare repeated historical
  // identities once, but retain every payment and the same-ID shortcut.
  for (const group of groups) {
    const identities = new Map();
    group.templatesById = new Map();
    for (const template of group.templates) {
      const signature = JSON.stringify([template.description, template.display_name,
        template.account_id, template.plaid_account_id, template.account_institution,
        template.account_last4, template.account_kind]);
      if (!identities.has(signature)) identities.set(signature, template);
      if (template.id != null) {
        const id = String(template.id);
        if (!group.templatesById.has(id)) group.templatesById.set(id, []);
        group.templatesById.get(id).push(template);
      }
    }
    group.identities = [...identities.values()];
  }
  const groupMatches = (group, tx) =>
    (tx.id != null && group.templatesById.get(String(tx.id))?.some(template => matchesPayment(template, tx)))
    || group.identities.some(template => matchesPayment(template, tx));
  // Amounts vary month to month; identity, verified source and ambiguity decide matches.
  for (const tx of debits) {
    const exact = groups.filter(group => groupMatches(group, tx));
    const matches = exact.length ? exact : groups.filter(group => group.identities.some(template => matchesVariant(template, tx)));
    if (matches.length === 1) matches[0].payments.push(tx);
  }
  const estimateGroups = new Map();
  const activeGroups = new Set();
  for (const estimate of estimates) {
    const matches = groups.filter(group => groupMatches(group, estimate.template));
    if (matches.length > 1 || (matches.length && estimateGroups.has(matches[0]))) {
      throw new Error('A fixed payment estimate matches more than one bill. Review its transactions.');
    }
    if (matches.length) estimateGroups.set(matches[0], estimate);
  }
  for (const group of groups) {
    const estimate = estimateGroups.get(group);
    group.occurrences = occurrences.filter(row => groupMatches(group, row.template));
    const fixed = group.payments.filter(isFixedPayment);
    const active = fixed.some(tx => tx.date >= recentStart);
    if (active) activeGroups.add(group);
    const recentEvidence = active || group.occurrences.some(row => row.template.date >= recentStart);
    if (!recentEvidence) {
      for (const row of group.occurrences) {
        if (row.status === 'projected' && !row.resolved_at) cancelled.add(row.payment_key);
      }
      group.occurrences = group.occurrences.filter(row => !cancelled.has(row.payment_key));
    }
    if (!fixed.length && group.payments.length) {
      for (const row of group.occurrences) {
        if (row.status === 'projected' && row.due_date >= todayKey) cancelled.add(row.payment_key);
      }
      group.occurrences = group.occurrences.filter(row => !cancelled.has(row.payment_key));
    }
    // Start after the first observed payment, never invent debt before the bill was observed.
    if (active) {
      const first = parseTxDate(fixed[0].date);
      const firstMonth = fixed[0].date.slice(0, 7);
      const start = new Date(first.year, first.month + (estimate && estimate.effective_month <= firstMonth ? 0 : 1), 1);
      const lowerBound = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      for (let target = start < lowerBound ? lowerBound : start; target <= through; target.setMonth(target.getMonth() + 1)) {
        const prefix = iso(target).slice(0, 7);
        const existing = group.occurrences.find(row => row.due_date.startsWith(prefix));
        const fixedTemplate = fixed.filter(tx => tx.date.slice(0, 7) < prefix).at(-1)
          || (estimate && prefix >= estimate.effective_month ? fixed.find(tx => tx.date.startsWith(prefix)) : null);
        if (!fixedTemplate) continue;
        const template = group.payments.filter(tx => tx.date.slice(0, 7) < prefix).at(-1) || fixedTemplate;
        const targetPreviousMonth = iso(new Date(target.getFullYear(), target.getMonth() - 1, 1)).slice(0, 7);
        if (prefix < month && fixedTemplate.date.slice(0, 7) !== targetPreviousMonth) continue;
        const day = Math.min(parseTxDate(template.date).day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate());
        const date = iso(new Date(target.getFullYear(), target.getMonth(), day));
        if (date > iso(through)) continue;
        if (existing) {
          if (existing.status === 'projected' && existing.due_date >= todayKey && date >= todayKey) {
            existing.template = { ...template };
            existing.amount = template.amount;
            existing.due_date = date;
          }
          continue;
        }
        const row = {
          payment_key: keyFor(fixed[0].id, date), due_date: date, template: { ...template },
          amount: template.amount, status: 'projected', matched_transaction_id: null, resolved_at: null
        };
        group.occurrences.push(row);
        occurrences.push(row);
      }
    }
    group.occurrences.sort((a, b) => a.due_date.localeCompare(b.due_date));
    const monthly = new Map();
    for (const row of [...group.occurrences].sort((a, b) => Number(!!b.resolved_at) - Number(!!a.resolved_at))) {
      const prefix = row.due_date.slice(0, 7);
      if (monthly.has(prefix) && !row.resolved_at && row.status === 'projected') cancelled.add(row.payment_key);
      else if (!monthly.has(prefix)) monthly.set(prefix, row);
    }
    group.occurrences = group.occurrences.filter(row => !cancelled.has(row.payment_key));
    for (const row of group.occurrences) {
      const prefix = row.due_date.slice(0, 7);
      if (estimate && prefix >= estimate.effective_month) row.estimated_amount = Number(estimate.monthly_amount);
      if (row.estimated_amount == null) continue;
      estimatedRows.add(row);
      const expectedCents = Math.round(Number(row.estimated_amount) * 100);
      if (!Number.isSafeInteger(expectedCents) || expectedCents <= 0) throw new Error('Invalid fixed payment estimate');
      const payments = group.payments.filter(tx => tx.date.startsWith(prefix));
      const paidCents = payments.reduce((sum, tx) => sum + Math.round(tx.amount * 100), 0);
      const remainingCents = Math.max(0, expectedCents - paidCents);
      const approximatelyComplete = remainingCents > 0 && paidCents * 10 >= expectedCents * 9;
      if (!row.resolved_at) row.status = remainingCents === 0 || approximatelyComplete ? 'paid' : 'projected';
      row.matched_transaction_id = null;
      row.amount = expectedCents / 100;
      const common = {
        paymentKey: row.payment_key, dueDate: row.due_date,
        description: row.template.display_name || getCanonicalMerchant(row.template.description),
        category: row.template.category || 'Other', isFixed: true, isIncome: false,
        payMode: row.template.pay_mode || null, estimatedAmount: expectedCents / 100,
        paidAmount: paidCents / 100, remainingAmount: remainingCents / 100
      };
      if (prefix === month) {
        for (const tx of payments) {
          estimatedItems.push({ ...common, id: tx.id, date: tx.date, dayOfMonth: Number(tx.date.slice(8, 10)),
            amount: tx.amount, status: 'processed',
            approximatelyComplete: approximatelyComplete && tx === payments.at(-1) && !row.resolved_at });
        }
      }
      if (row.status === 'projected' && row.due_date <= iso(through)) {
        estimatedItems.push({ ...common, date: row.due_date, dayOfMonth: Number(row.due_date.slice(8, 10)),
          amount: remainingCents / 100, status: 'projected',
          ...(debits.some(tx => String(tx.id) === String(row.template.id) && isFixedPayment(tx))
            ? { sourceTransactionId: row.template.id } : {}) });
      } else if (row.status === 'paid' && row.resolved_at && confirmationDate(row)?.slice(0, 7) === month) {
        const date = confirmationDate(row);
        estimatedItems.push({ ...common, date, dayOfMonth: Number(date.slice(8, 10)),
          amount: remainingCents / 100, status: 'processed', confirmedPaid: true });
      }
    }
    const assigned = new Set(group.occurrences.map(row => row.matched_transaction_id).filter(id => id != null).map(String));
    for (const tx of group.payments) {
      if (assigned.has(String(tx.id))) continue;
      const candidate = group.occurrences.find(row => row.due_date.slice(0, 7) === tx.date.slice(0, 7)
        && !estimatedRows.has(row) && row.status !== 'ignored' && row.matched_transaction_id == null);
      if (!candidate) continue;
      candidate.status = 'paid';
      candidate.matched_transaction_id = tx.id;
      candidate.amount = tx.amount;
      assigned.add(String(tx.id));
    }
  }
  const retained = occurrences.filter(row => !cancelled.has(row.payment_key));
  const items = retained.filter(row => !estimatedRows.has(row) && ((row.status === 'projected' && row.due_date <= iso(through)) || (row.status === 'paid'
    && (row.matched_transaction_id ? debits.find(tx => String(tx.id) === String(row.matched_transaction_id))?.date?.slice(0, 7) === month
      : confirmationDate(row)?.slice(0, 7) === month))))
    .map(row => {
      const paid = row.status === 'paid';
      const transaction = paid ? debits.find(tx => String(tx.id) === String(row.matched_transaction_id)) : null;
      const date = paid ? transaction?.date || confirmationDate(row) : row.due_date;
      const group = groups.find(group => group.occurrences.includes(row));
      const mode = [...(group?.payments || [])].reverse().find(tx => ['auto', 'manual'].includes(tx.pay_mode))?.pay_mode;
      return {
        paymentKey: row.payment_key, dueDate: row.due_date, date, dayOfMonth: Number(date.slice(8, 10)),
        ...(!paid && debits.some(tx => String(tx.id) === String(row.template.id) && isFixedPayment(tx))
          ? { sourceTransactionId: row.template.id } : {}),
        ...(transaction ? { id: transaction.id } : {}), confirmedPaid: paid && !transaction,
        description: row.template.display_name || getCanonicalMerchant(row.template.description),
        category: row.template.category || 'Other', amount: row.amount,
        isFixed: true, isIncome: false, status: paid ? 'processed' : 'projected', payMode: mode || row.template.pay_mode || null
      };
    });
  const matched = new Set(occurrences.map(row => row.matched_transaction_id).filter(id => id != null).map(String));
  for (const tx of debits.filter(tx => tx.date.startsWith(month) && !matched.has(String(tx.id))
    && !estimatedItems.some(item => item.id != null && String(item.id) === String(tx.id))
    && groups.some(group => activeGroups.has(group) && group.payments.includes(tx)))) {
    items.push({ id: tx.id, date: tx.date, dayOfMonth: Number(tx.date.slice(8, 10)), description: tx.display_name || tx.description,
      category: tx.category || 'Other', amount: tx.amount, isFixed: true, isIncome: false, status: 'processed', payMode: tx.pay_mode || null,
      ...(isFixedPayment(tx) ? { estimateTransactionId: tx.id } : {}) });
  }
  const finalItems = [...items, ...estimatedItems];
  matchPendingBankTransactions(finalItems, transactions, retained, groups, {
    todayKey,
    identityMatch: (group, tx) => groupMatches(group, tx) || group.identities.some(template => matchesVariant(template, tx))
  });
  return { occurrences: retained, items: finalItems.sort((a, b) => a.date.localeCompare(b.date)) };
}

const PENDING_MATCH_DAYS = 10;
const PENDING_COVERS_RATIO = 0.9;
const dayNumber = key => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 86400000;
const billCategoryOf = tx => {
  const detected = getFixedBillCategory(tx.display_name || '') || getFixedBillCategory(tx.description || '');
  const own = String(tx.category || '').trim();
  return (detected || (own && !/^(other|uncategorized|transfer)$/i.test(own) ? own : '')).toLowerCase();
};

// A pending bank debit is already in the bank's available balance but is not a
// settled payment. Link it to the unpaid bill it most likely represents so the
// projection does not subtract the same money twice; the bill stays unpaid
// until the posted transaction arrives.
function matchPendingBankTransactions(items, transactions, occurrences, groups, { todayKey, identityMatch }) {
  // Only debits on an account counted in the projected cash balance can already be reflected in it.
  const pending = transactions.filter(tx => tx.is_pending && String(tx.direction).toUpperCase() === 'DEBIT'
    && (tx.plaid_account_id == null || tx.account_in_balance === true))
    .map(tx => ({ ...tx, date: parseTxDate(tx.date)?.iso, amount: Number(tx.amount) }))
    .filter(tx => tx.date && tx.date <= todayKey && Number.isFinite(tx.amount) && tx.amount > 0);
  if (!pending.length) return;
  const rowByKey = new Map(occurrences.map(row => [row.payment_key, row]));
  const candidates = [];
  for (const item of items) {
    if (item.status !== 'projected' || !item.paymentKey || !(Number(item.amount) > 0)) continue;
    const row = rowByKey.get(item.paymentKey);
    if (!row) continue;
    const group = groups.find(entry => entry.occurrences.includes(row));
    const expected = Number(item.amount);
    const category = billCategoryOf(row.template);
    for (const tx of pending) {
      const days = Math.abs(dayNumber(tx.date) - dayNumber(item.date));
      if (days > PENDING_MATCH_DAYS) continue;
      const identity = !!group && identityMatch(group, tx);
      const ratio = tx.amount / expected;
      // Without a merchant match, require the same bill type and a near-identical amount.
      if (!identity && !(category && billCategoryOf(tx) === category && ratio >= PENDING_COVERS_RATIO && ratio <= 1 / PENDING_COVERS_RATIO)) continue;
      candidates.push({ item, tx, score: [identity ? 0 : 1, Math.abs(1 - ratio), days] });
    }
  }
  candidates.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2]);
  const usedItems = new Set(), usedTx = new Set();
  for (const { item, tx } of candidates) {
    if (usedItems.has(item) || usedTx.has(String(tx.id))) continue;
    usedItems.add(item);
    usedTx.add(String(tx.id));
    const expected = Number(item.amount);
    item.pendingTransaction = { id: tx.id, date: tx.date, amount: tx.amount,
      description: tx.display_name || tx.description };
    if (tx.amount >= expected * PENDING_COVERS_RATIO) {
      item.status = 'pending';
      item.expectedAmount = expected;
      item.amount = tx.amount;
    } else {
      item.amount = Math.round((expected - tx.amount) * 100) / 100;
    }
  }
}

export async function loadFixedPaymentOccurrences(client, today, through) {
  const userId = currentUserId();
  if (!currentReadOnly()) await client.query('SELECT pg_advisory_xact_lock($1,193647)', [userId]);
  const transactions = (await client.query(`SELECT t.id,t.date,t.description,t.display_name,t.category,t.amount,t.direction,
    t.account_id,t.plaid_account_id,t.is_fixed,t.pay_mode,t.is_pending,
    (pa.use_for_cashflow AND pa.type='depository') AS account_in_balance,${TRANSACTION_ACCOUNT_FIELDS}
    FROM transactions t ${TRANSACTION_ACCOUNT_JOINS}
    WHERE t.user_id=$1 AND t.date IS NOT NULL AND t.date::date <= $2::date`, [userId, iso(today)])).rows;
  const stored = (await client.query('SELECT * FROM fixed_payment_occurrences WHERE user_id=$1', [userId])).rows;
  const estimates = (await client.query('SELECT * FROM fixed_payment_estimates WHERE user_id=$1', [userId])).rows;
  const result = reconcilePaymentOccurrences(transactions, stored, today, through, estimates);
  if (!currentReadOnly()) {
    await client.query(`DELETE FROM fixed_payment_occurrences WHERE user_id=$1 AND status='projected'
      AND NOT(payment_key=ANY($2::text[]))`,
    [userId, result.occurrences.map(row => row.payment_key)]);
  }
  if (!currentReadOnly() && result.occurrences.length) {
    await client.query(`INSERT INTO fixed_payment_occurrences
      (payment_key,due_date,template,amount,status,matched_transaction_id,resolved_at,estimated_amount,user_id)
      SELECT payment_key,due_date,template,amount,status,matched_transaction_id,resolved_at,estimated_amount,$2
      FROM jsonb_to_recordset($1::jsonb) AS x(payment_key text,due_date text,template jsonb,amount numeric,
        status text,matched_transaction_id integer,resolved_at timestamptz,estimated_amount numeric)
      ON CONFLICT(user_id,payment_key) DO UPDATE SET status=EXCLUDED.status,
        matched_transaction_id=EXCLUDED.matched_transaction_id,amount=EXCLUDED.amount,
        template=EXCLUDED.template,due_date=EXCLUDED.due_date,estimated_amount=EXCLUDED.estimated_amount`, [JSON.stringify(result.occurrences), userId]);
  }
  return result.items;
}
