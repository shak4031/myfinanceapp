// Every outflow belongs to one of three buckets: fixed expenses, discretionary spending or debt payments.
// Debt wins over fixed: a mortgage is a fixed bill, but it is reported as a debt payment.
// Transfers between your own accounts are never spending, so a card payment paired with an imported card
// account is left out (the card's purchases are already counted).
import { parseTxDate } from './normalize.js';
import { isTransferRow } from './transfers.js';
import { isFixedPayment } from './fixedPayments.js';
import { classifyInterest, paymentMatcher } from './interest.js';

export const BUCKETS = Object.freeze(['fixed', 'discretionary', 'debt']);
export const BUCKET_LABELS = Object.freeze({ fixed: 'Fixed expenses', discretionary: 'Discretionary', debt: 'Debt payments' });
export const DEBT_TYPE_LABELS = Object.freeze({
  mortgage: 'Mortgage', auto_loan: 'Auto loans', credit_card: 'Credit cards',
  student_loan: 'Student loans', personal_loan: 'Other loans', other: 'Other debt'
});

const DEBT_CATEGORIES = [
  [/\b(mortgage|home\s*loans?|heloc)\b/i, 'mortgage'],
  [/\b(car|auto|vehicle)\s*(loans?|payments?|financ\w*)\b/i, 'auto_loan'],
  [/\bstudent\s*loans?\b/i, 'student_loan'],
  [/\bcredit\s*cards?\b|\bcard\s*payments?\b/i, 'credit_card'],
  [/\bloans?\b|\bdebt\s*payments?\b/i, 'personal_loan']
];
const RENT = /\brent\b/i;
const TOP_ITEMS = 4;

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const pct = (value, income) => income > 0 ? Math.round(value / income * 1000) / 10 : null;
const debtType = type => Object.prototype.hasOwnProperty.call(DEBT_TYPE_LABELS, type) ? type : 'other';
const monthKey = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;

// Matchers for debts the user linked to their payments (Debt-free plan "payment match").
export function debtMatchers(debts = []) {
  return debts.map(debt => ({ type: debtType(debt.debt_type), test: paymentMatcher(debt, debts) })).filter(entry => entry.test);
}

// { bucket, type?, interest? } for a spending row, or null for income and transfers.
export function bucketOf(tx, matchers = []) {
  if (!tx || String(tx.direction).toUpperCase() !== 'DEBIT' || isTransferRow(tx)) return null;
  const interest = classifyInterest(tx);
  if (interest) return { bucket: 'debt', type: debtType(interest.kind), interest: true };
  const matched = matchers.find(entry => entry.test(tx));
  if (matched) return { bucket: 'debt', type: matched.type };
  const category = String(tx.category || '');
  const rule = DEBT_CATEGORIES.find(([pattern]) => pattern.test(category));
  // Rent filed under "Mortgage" is a fixed bill, not a debt.
  if (rule && !(rule[1] === 'mortgage' && RENT.test(String(tx.description || '')))) return { bucket: 'debt', type: rule[1] };
  return { bucket: isFixedPayment(tx) ? 'fixed' : 'discretionary' };
}

function topItems(totals, divisor) {
  const items = [...totals.entries()].map(([label, amount]) => ({ label, amount: amount / divisor })).sort((a, b) => b.amount - a.amount);
  const shown = items.slice(0, TOP_ITEMS);
  const rest = items.slice(TOP_ITEMS).reduce((sum, item) => sum + item.amount, 0);
  if (rest > 0) shown.push({ label: 'Everything else', amount: rest, rest: true });
  return shown.map(item => ({ ...item, amount: round(item.amount) }));
}

// Monthly bucket totals for the last `months` completed months plus this month so far, and a typical month
// (average of the last `average` completed months that have records, the same window as the dashboard surplus).
export function buildSpendingBuckets({ transactions = [], debts = [], now = new Date(), months = 6, average = 3 } = {}) {
  const matchers = debtMatchers(debts);
  const currentIndex = now.getFullYear() * 12 + now.getMonth();
  const rows = Array.from({ length: months + 1 }, (_, i) => {
    const offset = months - i;
    return { offset, month: monthKey(currentIndex - offset), income: 0, fixed: 0, discretionary: 0, debt: 0, interest: 0, cardInterest: 0, recorded: false,
      items: { fixed: new Map(), discretionary: new Map(), debt: new Map() } };
  });
  const byOffset = new Map(rows.map(row => [row.offset, row]));
  for (const tx of transactions) {
    const parsed = parseTxDate(tx.date);
    const amount = Math.abs(Number(tx.amount));
    if (!parsed || !Number.isFinite(amount) || !amount || isTransferRow(tx)) continue;
    const row = byOffset.get(currentIndex - (parsed.year * 12 + parsed.month));
    if (!row) continue;
    row.recorded = true;
    const direction = String(tx.direction).toUpperCase();
    if (direction === 'CREDIT') { row.income += amount; continue; }
    const result = bucketOf(tx, matchers);
    if (!result) continue;
    row[result.bucket] += amount;
    const label = result.bucket === 'debt' ? DEBT_TYPE_LABELS[result.type] : (tx.category || 'Uncategorized');
    row.items[result.bucket].set(label, (row.items[result.bucket].get(label) || 0) + amount);
    if (result.interest) {
      row.interest += amount;
      if (result.type === 'credit_card') row.cardInterest += amount;
    }
  }
  const used = rows.filter(row => row.offset >= 1 && row.offset <= average && row.recorded);
  let typical = null;
  if (used.length) {
    const m = used.length;
    const totals = { fixed: new Map(), discretionary: new Map(), debt: new Map() };
    for (const row of used) for (const bucket of BUCKETS) for (const [label, amount] of row.items[bucket]) totals[bucket].set(label, (totals[bucket].get(label) || 0) + amount);
    const avg = key => used.reduce((sum, row) => sum + row[key], 0) / m;
    // Minimum payments for debts whose payments are not in the imported history, as the dashboard surplus counts them.
    const unrecorded = debts.filter(debt => Number(debt.balance) > 0 && debt.payment_in_history === false && Number(debt.min_payment) > 0);
    const unrecordedTotal = unrecorded.reduce((sum, debt) => sum + Number(debt.min_payment), 0);
    for (const debt of unrecorded) {
      const label = DEBT_TYPE_LABELS[debtType(debt.debt_type)];
      totals.debt.set(label, (totals.debt.get(label) || 0) + Number(debt.min_payment) * m);
    }
    const income = avg('income'), fixed = avg('fixed'), discretionary = avg('discretionary'), debt = avg('debt') + unrecordedTotal;
    const left = income - fixed - discretionary - debt;
    typical = {
      income: round(income), fixed: round(fixed), discretionary: round(discretionary), debt: round(debt), left: round(left),
      unrecordedDebt: round(unrecordedTotal), interest: round(avg('interest')),
      shares: { fixed: pct(fixed, income), discretionary: pct(discretionary, income), debt: pct(debt, income), left: pct(left, income) },
      items: { fixed: topItems(totals.fixed, m), discretionary: topItems(totals.discretionary, m), debt: topItems(totals.debt, m) }
    };
  }
  const current = rows[rows.length - 1];
  return {
    labels: BUCKET_LABELS,
    monthsUsed: used.length,
    typical,
    months: rows.map(row => ({
      month: row.month, current: row.offset === 0, recorded: row.recorded, income: round(row.income),
      fixed: round(row.fixed), discretionary: round(row.discretionary), debt: round(row.debt),
      left: round(row.income - row.fixed - row.discretionary - row.debt), interest: round(row.interest), cardInterest: round(row.cardInterest)
    })),
    current: {
      month: current.month, day: now.getDate(), daysInMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(),
      income: round(current.income), fixed: round(current.fixed), discretionary: round(current.discretionary), debt: round(current.debt),
      items: { fixed: topItems(current.items.fixed, 1), discretionary: topItems(current.items.discretionary, 1), debt: topItems(current.items.debt, 1) }
    }
  };
}
