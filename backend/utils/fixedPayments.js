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
  // A user's rename groups every payment it names, whatever the bank wrote.
  if (String(tx.display_name ?? '').trim()) return `NAME:${normalizeDescription(String(tx.display_name).toUpperCase())}`;
  const lender = (tx.description || '').match(/\b(?:ollo|capital\s+one|credit\s+one|chase|discover|amex|american\s+express|citicards)\b/i);
  if (lender) return normalizeDescription(lender[0]);
  return normalizeDescription(getCanonicalMerchant(tx.description));
}

function accountKey(tx) {
  // Keep separately masked accounts separate, without using changing ACH references.
  return (tx.description || '').match(/(?:\bx+|\*{2,})\d{2,4}\b/i)?.[0].toUpperCase().replace(/^[X*]+/, '') || '';
}

export function sameBill(a, b) {
  if (a.account_id != null && b.account_id != null && String(a.account_id) !== String(b.account_id)) return false;
  if (accountKey(a) !== accountKey(b)) return false;
  const merchant = merchantKey(a);
  return !!merchant && merchant === merchantKey(b);
}

export function buildUpcomingPayments(transactions, today = new Date(), { through = null } = {}) {
  const year = today.getFullYear();
  const month = today.getMonth();
  const previous = new Date(year, month - 1, 1);
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
  const thisMonth = debits.filter(tx => tx.parsed.year === year && tx.parsed.month === month && tx.parsed.day <= today.getDate());
  const candidates = through ? [...lastMonth, ...thisMonth.filter(isFixedPayment)] : lastMonth;
  candidates.sort((a, b) => b.parsed.iso.localeCompare(a.parsed.iso) || Number(b.id) - Number(a.id));
  const templates = [];
  for (const tx of candidates) {
    if (!templates.some(template => sameBill(template, tx))) templates.push(tx);
  }
  // Pay mode belongs to the bill: use the row's own value, else the newest row of the same bill that has one.
  const withMode = debits.filter(tx => tx.pay_mode === 'auto' || tx.pay_mode === 'manual')
    .sort((a, b) => (b.parsed.year - a.parsed.year) || (b.parsed.month - a.parsed.month) || (b.parsed.day - a.parsed.day) || Number(b.id) - Number(a.id));
  const payModeOf = (tx, template) => (tx.pay_mode === 'auto' || tx.pay_mode === 'manual') ? tx.pay_mode
    : withMode.find(row => sameBill(template, row))?.pay_mode ?? null;
  const timeline = [];
  const paidIds = new Set();
  const end = through || new Date(year, month + 1, 0);
  for (let offset = 0; new Date(year, month + offset, 1) <= end; offset++) {
    const target = new Date(year, month + offset, 1);
    const monthEnd = new Date(year, month + offset + 1, 0).getDate();
    const dateFor = day => `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    for (const template of templates) {
      const paid = offset === 0 ? thisMonth.filter(tx => sameBill(template, tx)) : [];
      if (paid.length) {
        for (const tx of paid) {
          if (paidIds.has(tx.id)) continue;
          paidIds.add(tx.id);
          timeline.push({
            id: tx.id, description: tx.display_name || tx.description, category: template.category || 'Other',
            ...(through ? { isFixed: true } : {}),
            amount: tx.amount, dayOfMonth: tx.parsed.day, ...(through ? { date: dateFor(tx.parsed.day) } : {}),
            isIncome: false, status: 'processed', payMode: payModeOf(tx, template)
          });
        }
      } else {
        const dayOfMonth = Math.min(template.parsed.day, monthEnd);
        if (new Date(target.getFullYear(), target.getMonth(), dayOfMonth) > end) continue;
        timeline.push({
          sourceTransactionId: template.id,
          description: template.display_name || getCanonicalMerchant(template.description), category: template.category || 'Other',
          amount: template.amount, dayOfMonth, ...(through ? { date: dateFor(dayOfMonth) } : {}),
          isIncome: false, status: 'projected', payMode: payModeOf(template, template)
        });
      }
    }
  }
  return timeline.sort((a, b) => through ? a.date.localeCompare(b.date) : a.dayOfMonth - b.dayOfMonth);
}
