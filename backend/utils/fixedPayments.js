import { getCanonicalMerchant, normalizeDescription, parseTxDate } from './normalize.js';

export const FIXED_BILL_RULES = [
  { pattern: '\\b(?:pennymac|mortgage|rent\\s+payment)\\b', category: 'Mortgage' },
  { pattern: '\\b(?:hyundai|santander|auto\\s+loan|car\\s+(?:payment|lease)|loan\\s+payment)\\b', category: 'Car Loans' },
  { pattern: '\\b(?:ollo|credit\\s+card|payment\\s+thank\\s+you)\\b|\\b(?:capital\\s+one|credit\\s+one|chase|discover|amex|american\\s+express|amazon\\s+store\\s+card)\\b.*\\b(?:payment|pmt|autopay|mobile\\s+pay)\\b', category: 'Credit Cards' },
  { pattern: '\\b(?:pseg|public\\s+service|pepco|eversource|constellation|coned|utilities|utility|electric\\s+bill|water\\s+bill|gas\\s+(?:co|company|bill))\\b', category: 'Utilities' },
  { pattern: '\\b(?:verizon|comcast|xfinity|fios|t-mobile|at&t)\\b', category: 'Internet' },
  { pattern: '\\b(?:state\\s+farm|geico|allstate|progressive|liberty\\s+mutual|insurance\\s+(?:payment|premium))\\b', category: 'Insurance' }
];

const VARIABLE_PURCHASES = /\b(?:target|walmart|instacart|wawa|shoprite|starbucks|chipotle|doordash|grubhub|chargepoint|electrify\s+america|shell|chevron|exxon|sunoco|citgo|gas\s+station)\b|\b(?:trader\s+joe|whole\s+foods|uber\s+eats)\b/i;
const CARD_PURCHASE = /\b(?:visa\s+dda\s+(?:pur|ref)|dda\s+(?:purchase|pur|ref)|pos\s+(?:debit|purchase|pur)|check\s+card|debit\s+card)\b/i;

export function getFixedBillCategory(description = '') {
  if (VARIABLE_PURCHASES.test(description)) return null;
  const rule = FIXED_BILL_RULES.find(({ pattern }) => new RegExp(pattern, 'i').test(description));
  // Card-network purchases are not loan/credit-card repayments.
  if (rule && CARD_PURCHASE.test(description) && ['Mortgage', 'Car Loans', 'Credit Cards'].includes(rule.category)) {
    return null;
  }
  return rule?.category || null;
}

export function isFixedPayment(tx) {
  const fixed = tx.is_fixed === true || tx.is_fixed === 1 || tx.is_fixed === 'true' || tx.is_fixed === '1';
  return fixed && String(tx.direction).toUpperCase() === 'DEBIT';
}

function merchantKey(tx) {
  const lender = (tx.description || '').match(/\b(?:ollo|capital\s+one|credit\s+one|chase|discover|amex|american\s+express|citicards)\b/i);
  if (lender) return normalizeDescription(lender[0]);
  return normalizeDescription(getCanonicalMerchant(tx.description));
}

function accountKey(tx) {
  // Keep separately masked accounts separate, without using changing ACH references.
  return (tx.description || '').match(/(?:\bx+|\*{2,})\d{2,4}\b/i)?.[0].toUpperCase().replace(/^[X*]+/, '') || '';
}

function sameBill(a, b) {
  if (accountKey(a) !== accountKey(b)) return false;
  return (a.label_id != null && b.label_id != null && String(a.label_id) === String(b.label_id))
    || merchantKey(a) === merchantKey(b);
}

export function buildUpcomingPayments(transactions, today = new Date()) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const previous = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month + 1, 0).getDate();
  const debits = transactions
    .filter(tx => String(tx.direction).toUpperCase() === 'DEBIT')
    .map(tx => ({ ...tx, parsed: parseTxDate(tx.date), amount: Number(tx.amount) }))
    .filter(tx => {
      if (!tx.parsed || new Date(tx.parsed.year, tx.parsed.month, tx.parsed.day).getMonth() !== tx.parsed.month) {
        throw new Error(`Invalid payment date for transaction ${tx.id}`);
      }
      if (!Number.isFinite(tx.amount) || tx.amount <= 0) throw new Error(`Invalid payment amount for transaction ${tx.id}`);
      return true;
    });
  const lastMonth = debits.filter(tx => tx.parsed.year === previous.getFullYear() && tx.parsed.month === previous.getMonth() && isFixedPayment(tx));
  lastMonth.sort((a, b) => b.parsed.day - a.parsed.day || Number(b.id) - Number(a.id));
  const templates = [];
  for (const tx of lastMonth) {
    if (!templates.some(template => sameBill(template, tx))) templates.push(tx);
  }
  const thisMonth = debits.filter(tx => tx.parsed.year === year && tx.parsed.month === month && tx.parsed.day <= today.getDate());
  const timeline = [];
  const paidIds = new Set();
  for (const template of templates) {
    const paid = thisMonth.filter(tx => sameBill(template, tx));
    if (paid.length) {
      for (const tx of paid) {
        if (paidIds.has(tx.id)) continue;
        paidIds.add(tx.id);
        timeline.push({
          id: tx.id, description: tx.description, category: template.category || 'Other',
          amount: tx.amount, dayOfMonth: tx.parsed.day, isIncome: false, status: 'processed'
        });
      }
    } else {
      timeline.push({
        sourceTransactionId: template.id,
        description: getCanonicalMerchant(template.description), category: template.category || 'Other',
        amount: template.amount, dayOfMonth: Math.min(template.parsed.day, monthEnd),
        isIncome: false, status: 'projected'
      });
    }
  }
  return timeline.sort((a, b) => a.dayOfMonth - b.dayOfMonth);
}
