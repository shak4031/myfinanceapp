import { parseTxDate } from './normalize.js';
import { scheduledInterestFor } from './amortization.js';

export const INTEREST_KINDS = {
  credit_card: 'Credit cards',
  auto_loan: 'Auto',
  student_loan: 'Student loans',
  personal_loan: 'Loans',
  mortgage: 'Mortgage',
  other: 'Other'
};
export const INTEREST_KIND_KEYS = Object.keys(INTEREST_KINDS);

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const POSITIVE = [
  /\binterest\s+(charges?|charged|chg|chrg)\b/,
  /\bpurchase\s+interest\b/,
  /\binterest\s+(on|for)\s+(purchases?|cash|balances?|advances?)\b/,
  /\bcash\s+advance\s+interest\b/,
  /\bbalance\s+transfer\s+interest\b/,
  /\bfinance\s+charges?\b/,
  /\bperiodic\s+(interest|finance|rate)\b/,
  /\binterest\s+assessed\b/,
  /\b(loan|mortgage)\s+interest\b/,
  /\binterest\s+paid\b/,
  /^\s*interest\s*$/
];
const NEGATIVE = /\b(earned|dividends?|interest\s+(checking|savings|income|credit|earned)|high[\s-]*yield|refund|reversal|reversed|waived?|waiver|credit\s+adj(ustment)?|rebate)\b/;
const PLAID_INTEREST = /^BANK_FEES_INTEREST_CHARGE$|^LOAN_PAYMENTS_.*INTEREST/;

export function kindFromDebtType(type) {
  return INTEREST_KIND_KEYS.includes(type) ? type : 'other';
}

export function inferInterestKind(row) {
  const text = String(row.description || '').toLowerCase();
  if (/\b(mortgage|home\s*loan|heloc|escrow)\b/.test(text)) return 'mortgage';
  if (/\b(auto|vehicle|car)\b/.test(text)) return 'auto_loan';
  if (/\b(student|navient|nelnet|sallie|mohela|aidvantage|edfinancial)\b/.test(text)) return 'student_loan';
  if (/\bloan\b/.test(text)) return 'personal_loan';
  const subtype = String(row.plaid_subtype || '').toLowerCase();
  const type = String(row.plaid_type || '').toLowerCase();
  if (subtype === 'mortgage' || subtype === 'home equity') return 'mortgage';
  if (subtype === 'auto') return 'auto_loan';
  if (subtype === 'student') return 'student_loan';
  if (subtype === 'credit card' || subtype === 'paypal' || type === 'credit') return 'credit_card';
  if (type === 'loan') return 'personal_loan';
  if (row.account_kind === 'credit_card') return 'credit_card';
  if (row.account_kind === 'loan') return 'personal_loan';
  if (/\b(interest\s+(charge|chg)|finance\s+charge|purchase|cash\s+advance|balance\s+transfer)/.test(text)) return 'credit_card';
  return 'other';
}

export function isInterestCharge(row) {
  if (String(row.direction || '').toUpperCase() !== 'DEBIT') return false;
  const text = String(row.description || '').toLowerCase().replace(/\s+/g, ' ');
  if (NEGATIVE.test(text)) return false;
  if (PLAID_INTEREST.test(String(row.plaid_category || '').toUpperCase())) return true;
  return POSITIVE.some(pattern => pattern.test(text));
}

// Returns { kind, source } for interest transactions, or null.
export function classifyInterest(row) {
  if (row.interest_override === true) {
    return INTEREST_KIND_KEYS.includes(row.interest_kind) ? { kind: row.interest_kind, source: 'manual' } : null;
  }
  if (!isInterestCharge(row)) return null;
  return { kind: inferInterestKind(row), source: 'detected' };
}

function monthOf(date) {
  const parsed = parseTxDate(date);
  if (!parsed) return null;
  return `${parsed.year}-${String(parsed.month + 1).padStart(2, '0')}`;
}

function isoDate(date) {
  return parseTxDate(date)?.iso ?? String(date || '');
}

export function monthKeys(now, count) {
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

export function paymentMatcher(debt, debts) {
  const match = String(debt.payment_match || '').trim().toLowerCase();
  if (match) return row => String(row.description || '').toLowerCase().includes(match);
  if (debt.debt_type === 'mortgage' && debts.filter(item => item.debt_type === 'mortgage').length === 1) {
    return row => String(row.category || '').toLowerCase() === 'mortgage';
  }
  if (debt.debt_type === 'credit_card' && debts.filter(item => item.debt_type === 'credit_card').length === 1) {
    return row => ['credit card', 'credit cards'].includes(String(row.category || '').toLowerCase());
  }
  return null;
}

function estimateInterest(debt, row, month) {
  const amount = Number(row.amount) || 0;
  const cap = Math.max(0, amount - (Number(debt.escrow_payment) || 0));
  const scheduled = scheduledInterestFor(debt, month);
  const interest = scheduled ?? (Number(debt.balance) || 0) * (Number(debt.apr) || 0) / 1200;
  return round(Math.min(cap, Math.max(0, interest)));
}

export function buildInterestSummary({ transactions = [], debts = [], now = new Date(), months = 12 } = {}) {
  const keys = monthKeys(now, months);
  const keySet = new Set(keys);
  const blank = () => Object.fromEntries(INTEREST_KIND_KEYS.map(kind => [kind, 0]));
  const byMonth = new Map(keys.map(key => [key, { month: key, total: 0, estimated: 0, byKind: blank() }]));
  const charges = [];
  const explicitKindMonths = new Set();

  for (const row of transactions) {
    const result = classifyInterest(row);
    if (!result) continue;
    const month = monthOf(row.date);
    if (!keySet.has(month)) continue;
    explicitKindMonths.add(`${result.kind}:${month}`);
    charges.push({
      id: row.id, date: isoDate(row.date), month, description: row.display_name || row.description,
      amount: round(row.amount), kind: result.kind, source: result.source, category: row.category || null
    });
  }

  const hints = [];
  // Card statements (imported or synced) list the actual interest charged, so cards only need help when none are visible.
  const hasCardStatements = charges.some(charge => charge.kind === 'credit_card')
    || transactions.some(row => keySet.has(monthOf(row.date)) && inferInterestKind({ ...row, description: '' }) === 'credit_card');
  // Card interest is estimated from the carried balance only in months without a detected card interest charge.
  const interestDebts = debts.filter(debt => debt.debt_type && Number(debt.apr) > 0
    && (debt.debt_type !== 'credit_card' || Number(debt.balance) > 0));
  for (const debt of interestDebts) {
    const matcher = paymentMatcher(debt, debts);
    const kind = kindFromDebtType(debt.debt_type);
    const hasSchedule = kind !== 'credit_card' && Number(debt.balance) > 0 && scheduledInterestFor(debt, keys.at(-1)) !== null;
    if (!matcher && !hasSchedule) {
      if (kind === 'credit_card') {
        if (!hasCardStatements) hints.push({ debtId: debt.id, name: debt.name, kind, action: 'accounts',
          message: `Import or connect ${debt.name} statements so its interest charges are counted.` });
      } else {
        hints.push({ debtId: debt.id, name: debt.name, kind, action: 'payoff', message: `Tell us how ${debt.name} payments appear so we can estimate its interest.` });
      }
      continue;
    }
    const paidMonths = new Set();
    for (const row of matcher ? transactions : []) {
      if (String(row.direction || '').toUpperCase() !== 'DEBIT' || classifyInterest(row)) continue;
      const month = monthOf(row.date);
      if (!keySet.has(month) || explicitKindMonths.has(`${kind}:${month}`) || !matcher(row)) continue;
      const amount = estimateInterest(debt, row, month);
      if (!(amount > 0)) continue;
      paidMonths.add(month);
      charges.push({
        id: row.id, date: isoDate(row.date), month,
        description: `${debt.name} · ${kind === 'credit_card' ? 'interest on carried balance' : 'interest in payment'}`,
        amount, kind, source: 'estimated', category: row.category || null, paymentAmount: round(row.amount), debtId: debt.id
      });
    }
    if (!hasSchedule) continue;
    // Loan statements carry terms but no payment lines, so months without a matched payment use the amortization schedule.
    for (const month of keys) {
      if (paidMonths.has(month) || explicitKindMonths.has(`${kind}:${month}`)) continue;
      const amount = scheduledInterestFor(debt, month);
      if (!(amount > 0)) continue;
      charges.push({
        id: `schedule-${debt.id}-${month}`, date: `${month}-01`, month,
        description: `${debt.name} · scheduled interest`, amount: round(amount), kind, source: 'estimated',
        category: null, debtId: debt.id, scheduled: true
      });
    }
  }

  for (const charge of charges) {
    const bucket = byMonth.get(charge.month);
    bucket.byKind[charge.kind] = round(bucket.byKind[charge.kind] + charge.amount);
    bucket.total = round(bucket.total + charge.amount);
    if (charge.source === 'estimated') bucket.estimated = round(bucket.estimated + charge.amount);
  }

  const series = [...byMonth.values()];
  const totals = blank();
  for (const bucket of series) for (const kind of INTEREST_KIND_KEYS) totals[kind] = round(totals[kind] + bucket.byKind[kind]);
  const total = round(series.reduce((sum, bucket) => sum + bucket.total, 0));
  const estimated = round(series.reduce((sum, bucket) => sum + bucket.estimated, 0));
  const year = String(now.getFullYear());
  const thisMonth = keys.at(-1);
  const activeMonths = series.findIndex(bucket => bucket.total > 0);

  return {
    kinds: INTEREST_KINDS,
    months: series,
    totals,
    total,
    estimated,
    yearToDate: round(series.filter(bucket => bucket.month.startsWith(year)).reduce((sum, bucket) => sum + bucket.total, 0)),
    thisMonth: byMonth.get(thisMonth)?.total ?? 0,
    lastMonth: byMonth.get(keys.at(-2))?.total ?? 0,
    monthlyAverage: activeMonths < 0 ? 0 : round(total / (series.length - activeMonths)),
    annualized: activeMonths < 0 ? 0 : round(total / (series.length - activeMonths) * 12),
    charges: charges.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount),
    hints
  };
}
