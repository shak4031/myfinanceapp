import { createHash } from 'node:crypto';
import { isFixedPayment, sameBill } from './fixedPayments.js';
import { parseTxDate, getCanonicalMerchant } from './normalize.js';
import { currentReadOnly, currentUserId } from './tenant.js';
import { sameSourceAccount, sourceAccountsCompatible, TRANSACTION_ACCOUNT_FIELDS, TRANSACTION_ACCOUNT_JOINS } from './transactionAccount.js';

const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const keyFor = (id, date) => createHash('sha256').update(`${id}:${date}`).digest('hex');
const confirmationDate = row => row.resolved_at ? iso(new Date(row.resolved_at)) : null;

function accountCompatible(a, b) {
  if (!sourceAccountsCompatible(a, b)) return false;
  const mask = tx => (tx.description || '').match(/(?:\bx+|\*{2,})(\d{2,4})\b/i)?.[1];
  return !mask(a) || !mask(b) || mask(a) === mask(b);
}

function samePayment(a, b) {
  if (!accountCompatible(a, b)) return false;
  if (a.id != null && String(a.id) === String(b.id)) return true;
  const crossSource = (a.account_id != null && a.plaid_account_id == null && b.plaid_account_id != null && b.account_id == null)
    || (b.account_id != null && b.plaid_account_id == null && a.plaid_account_id != null && a.account_id == null);
  if (crossSource) return false;
  // Renames are presentation, not a different bill identity.
  return sameBill(a, b) || sameBill({ ...a, display_name: null }, { ...b, display_name: null });
}

function descriptionVariant(a, b) {
  if (!accountCompatible(a, b) || !sameSourceAccount(a, b)) return false;
  if (sameBill(a, b, { allowMissingMask: true })
    || sameBill({ ...a, display_name: null }, { ...b, display_name: null }, { allowMissingMask: true })) return true;
  const words = tx => new Set(getCanonicalMerchant(tx.description).toUpperCase().split(/[^A-Z]+/)
    .filter(word => word.length >= 3 && !['GOOGLE', 'PAYPAL', 'ONLINE', 'PAYMENT', 'CARD', 'PREMIUM', 'THE', 'AND', 'FOR'].includes(word)));
  const left = words(a), right = words(b);
  return Math.min(left.size, right.size) >= 2
    && ([...left].every(word => right.has(word)) || [...right].every(word => left.has(word)));
}

export function reconcilePaymentOccurrences(transactions, stored, today, through) {
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
  const groups = [];
  for (const tx of [...debits.filter(isFixedPayment), ...occurrences.map(row => row.template)]) {
    let group = groups.find(group => group.templates.some(template => samePayment(template, tx)));
    if (!group) { group = { template: tx, templates: [], payments: [], occurrences: [] }; groups.push(group); }
    group.templates.push(tx);
  }
  // Consolidate changed provider identities only when both groups have a unique partner.
  const partners = group => groups.filter(other => other !== group
    && group.templates.every(left => other.templates.every(right => accountCompatible(left, right)))
    && !group.templates.some(left => isFixedPayment(left)
      && other.templates.some(right => isFixedPayment(right) && left.date.slice(0, 7) === right.date.slice(0, 7)))
    && group.templates.some(left => other.templates.some(right => descriptionVariant(left, right))));
  for (const group of [...groups]) {
    if (!groups.includes(group)) continue;
    const matches = partners(group);
    if (matches.length === 1 && partners(matches[0]).length === 1) {
      group.templates.push(...matches[0].templates);
      groups.splice(groups.indexOf(matches[0]), 1);
    }
  }
  // Amounts vary month to month; identity, verified source and ambiguity decide matches.
  for (const tx of debits) {
    const exact = groups.filter(group => group.templates.some(template => samePayment(template, tx)));
    const matches = exact.length ? exact : groups.filter(group => group.templates.some(template => descriptionVariant(template, tx)));
    if (matches.length === 1) matches[0].payments.push(tx);
  }
  for (const group of groups) {
    group.occurrences = occurrences.filter(row => group.templates.some(template => samePayment(template, row.template)));
    const fixed = group.payments.filter(isFixedPayment);
    const active = fixed.some(tx => tx.date >= recentStart);
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
      const start = new Date(first.year, first.month + 1, 1);
      const lowerBound = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      for (let target = start < lowerBound ? lowerBound : start; target <= through; target.setMonth(target.getMonth() + 1)) {
        const prefix = iso(target).slice(0, 7);
        const existing = group.occurrences.find(row => row.due_date.startsWith(prefix));
        const fixedTemplate = fixed.filter(tx => tx.date.slice(0, 7) < prefix).at(-1);
        if (!fixedTemplate) continue;
        const template = group.payments.filter(tx => tx.date.slice(0, 7) < prefix).at(-1);
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
    const assigned = new Set(group.occurrences.map(row => row.matched_transaction_id).filter(id => id != null).map(String));
    for (const tx of group.payments) {
      if (assigned.has(String(tx.id))) continue;
      const candidate = group.occurrences.find(row => row.due_date.slice(0, 7) === tx.date.slice(0, 7)
        && row.status !== 'ignored' && row.matched_transaction_id == null);
      if (!candidate) continue;
      candidate.status = 'paid';
      candidate.matched_transaction_id = tx.id;
      candidate.amount = tx.amount;
      assigned.add(String(tx.id));
    }
  }
  const retained = occurrences.filter(row => !cancelled.has(row.payment_key));
  const items = retained.filter(row => (row.status === 'projected' && row.due_date <= iso(through)) || (row.status === 'paid'
    && (row.matched_transaction_id ? debits.find(tx => String(tx.id) === String(row.matched_transaction_id))?.date?.slice(0, 7) === month
      : confirmationDate(row)?.slice(0, 7) === month)))
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
    && groups.some(group => group.payments.includes(tx)))) {
    items.push({ id: tx.id, date: tx.date, dayOfMonth: Number(tx.date.slice(8, 10)), description: tx.display_name || tx.description,
      category: tx.category || 'Other', amount: tx.amount, isFixed: true, isIncome: false, status: 'processed', payMode: tx.pay_mode || null });
  }
  return { occurrences: retained, items: items.sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function loadFixedPaymentOccurrences(client, today, through) {
  const userId = currentUserId();
  if (!currentReadOnly()) await client.query('SELECT pg_advisory_xact_lock($1,193647)', [userId]);
  const transactions = (await client.query(`SELECT t.id,t.date,t.description,t.display_name,t.category,t.amount,t.direction,
    t.account_id,t.plaid_account_id,t.is_fixed,t.pay_mode,t.is_pending,${TRANSACTION_ACCOUNT_FIELDS}
    FROM transactions t ${TRANSACTION_ACCOUNT_JOINS}
    WHERE t.user_id=$1 AND t.date IS NOT NULL AND t.date::date <= $2::date`, [userId, iso(today)])).rows;
  const stored = (await client.query('SELECT * FROM fixed_payment_occurrences WHERE user_id=$1', [userId])).rows;
  const result = reconcilePaymentOccurrences(transactions, stored, today, through);
  if (!currentReadOnly()) {
    await client.query(`DELETE FROM fixed_payment_occurrences WHERE user_id=$1 AND status='projected'
      AND NOT(payment_key=ANY($2::text[]))`,
    [userId, result.occurrences.map(row => row.payment_key)]);
  }
  if (!currentReadOnly() && result.occurrences.length) {
    await client.query(`INSERT INTO fixed_payment_occurrences
      (payment_key,due_date,template,amount,status,matched_transaction_id,resolved_at,user_id)
      SELECT payment_key,due_date,template,amount,status,matched_transaction_id,resolved_at,$2
      FROM jsonb_to_recordset($1::jsonb) AS x(payment_key text,due_date text,template jsonb,amount numeric,
        status text,matched_transaction_id integer,resolved_at timestamptz)
      ON CONFLICT(user_id,payment_key) DO UPDATE SET status=EXCLUDED.status,
        matched_transaction_id=EXCLUDED.matched_transaction_id,amount=EXCLUDED.amount,
        template=EXCLUDED.template,due_date=EXCLUDED.due_date`, [JSON.stringify(result.occurrences), userId]);
  }
  return result.items;
}
