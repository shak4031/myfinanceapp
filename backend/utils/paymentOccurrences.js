import { createHash } from 'node:crypto';
import { isFixedPayment, sameBill } from './fixedPayments.js';
import { parseTxDate, getCanonicalMerchant } from './normalize.js';
import { currentReadOnly, currentUserId } from './tenant.js';

const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const keyFor = (id, date) => createHash('sha256').update(`${id}:${date}`).digest('hex');
const confirmationDate = row => row.resolved_at ? iso(new Date(row.resolved_at)) : null;

export function reconcilePaymentOccurrences(transactions, stored, today, through) {
  const todayKey = iso(today);
  const month = todayKey.slice(0, 7);
  const debits = transactions.filter(tx => String(tx.direction).toUpperCase() === 'DEBIT' && !tx.is_pending)
    .map(tx => {
      const parsed = parseTxDate(tx.date);
      if (!parsed || new Date(parsed.year, parsed.month, parsed.day).getMonth() !== parsed.month
        || !Number.isFinite(Number(tx.amount)) || Number(tx.amount) <= 0) {
        throw new Error(`Invalid fixed payment data for transaction ${tx.id}`);
      }
      return { ...tx, date: parsed.iso, amount: Number(tx.amount) };
    }).filter(tx => tx.date <= todayKey).sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
  const occurrences = stored.map(row => ({ ...row, template: { ...row.template }, amount: Number(row.amount),
    resolved_at: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at }));
  const cancelled = new Set();
  const groups = [];
  for (const tx of [...debits.filter(isFixedPayment), ...occurrences.map(row => row.template)]) {
    let group = groups.find(group => sameBill(group.template, tx));
    if (!group) { group = { template: tx, payments: [], occurrences: [] }; groups.push(group); }
  }
  for (const group of groups) {
    group.payments = debits.filter(tx => sameBill(group.template, tx));
    group.occurrences = occurrences.filter(row => sameBill(group.template, row.template));
    const fixed = group.payments.filter(isFixedPayment);
    if (!fixed.length && group.payments.length) {
      for (const row of group.occurrences) {
        if (row.status === 'projected' && row.due_date >= todayKey) cancelled.add(row.payment_key);
      }
      group.occurrences = group.occurrences.filter(row => !cancelled.has(row.payment_key));
    }
    // Start after the first observed payment, never invent debt before the bill was observed.
    if (fixed.length) {
      const first = parseTxDate(fixed[0].date);
      for (let target = new Date(first.year, first.month + 1, 1); target <= through; target.setMonth(target.getMonth() + 1)) {
        const prefix = iso(target).slice(0, 7);
        const existing = group.occurrences.find(row => row.due_date.startsWith(prefix));
        const template = fixed.filter(tx => tx.date.slice(0, 7) < prefix).at(-1);
        if (!template) continue;
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
    const assigned = new Set(group.occurrences.map(row => row.matched_transaction_id).filter(id => id != null).map(String));
    for (const tx of group.payments) {
      if (assigned.has(String(tx.id))) continue;
      const candidate = group.occurrences.find(row => row.due_date.slice(0, 7) <= tx.date.slice(0, 7)
        && row.status !== 'ignored' && row.matched_transaction_id == null);
      if (!candidate) continue;
      candidate.status = 'paid';
      candidate.matched_transaction_id = tx.id;
      candidate.amount = tx.amount;
      assigned.add(String(tx.id));
    }
  }
  const retained = occurrences.filter(row => !cancelled.has(row.payment_key));
  const items = retained.filter(row => row.status === 'projected' || (row.status === 'paid'
    && (row.matched_transaction_id ? debits.find(tx => String(tx.id) === String(row.matched_transaction_id))?.date?.slice(0, 7) === month
      : confirmationDate(row)?.slice(0, 7) === month)))
    .map(row => {
      const paid = row.status === 'paid';
      const transaction = paid ? debits.find(tx => String(tx.id) === String(row.matched_transaction_id)) : null;
      const date = paid ? transaction?.date || confirmationDate(row) : row.due_date;
      const mode = [...debits].reverse().find(tx => sameBill(row.template, tx) && ['auto', 'manual'].includes(tx.pay_mode))?.pay_mode;
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
    && groups.some(group => sameBill(group.template, tx)))) {
    items.push({ id: tx.id, date: tx.date, dayOfMonth: Number(tx.date.slice(8, 10)), description: tx.display_name || tx.description,
      category: tx.category || 'Other', amount: tx.amount, isFixed: true, isIncome: false, status: 'processed', payMode: tx.pay_mode || null });
  }
  return { occurrences: retained, items: items.sort((a, b) => a.date.localeCompare(b.date)) };
}

export async function loadFixedPaymentOccurrences(client, today, through) {
  const userId = currentUserId();
  if (!currentReadOnly()) await client.query('SELECT pg_advisory_xact_lock($1,193647)', [userId]);
  const transactions = (await client.query(`SELECT id,date,description,display_name,category,amount,direction,
    account_id,plaid_account_id,is_fixed,pay_mode,is_pending FROM transactions
    WHERE user_id=$1 AND date IS NOT NULL AND date::date <= $2::date`, [userId, iso(today)])).rows;
  const stored = (await client.query('SELECT * FROM fixed_payment_occurrences WHERE user_id=$1', [userId])).rows;
  const result = reconcilePaymentOccurrences(transactions, stored, today, through);
  if (!currentReadOnly()) {
    await client.query(`DELETE FROM fixed_payment_occurrences WHERE user_id=$1 AND status='projected'
      AND due_date >= $2 AND NOT(payment_key=ANY($3::text[]))`,
    [userId, iso(today), result.occurrences.map(row => row.payment_key)]);
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
