import { parseTxDate } from './normalize.js';

const invalid = message => Object.assign(new Error(message), { status: 400 });
const dateString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function validDate(value, label) {
  const parsed = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseTxDate(value) : null;
  if (!parsed || parsed.year < 1900 || parsed.year > 2200
      || new Date(parsed.year, parsed.month, parsed.day).getMonth() !== parsed.month) {
    throw invalid(`Choose a valid ${label}`);
  }
  return value;
}

export function validateGoalPurchase(input) {
  if (typeof input.merchant !== 'string' || !input.merchant.trim() || input.merchant.length > 150) {
    throw invalid('Enter a merchant or purchase description of up to 150 characters');
  }
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || Math.round(amount * 100) <= 0 || amount > 1e9) throw invalid('Enter a positive purchase amount of at least $0.01');
  if (!['cash', 'credit'].includes(input.payment_method)) throw invalid('Choose cash/debit or credit card');
  const purchase_date = validDate(input.purchase_date, 'purchase date');
  const payment_date = input.payment_method === 'cash' ? purchase_date : validDate(input.payment_date, 'card-payment date');
  if (payment_date < purchase_date) throw invalid('Card-payment date cannot precede the purchase');
  return { merchant: input.merchant.trim(), amount: Math.round(amount * 100) / 100, purchase_date, payment_date, payment_method: input.payment_method };
}

export function normalizeGoalPurchase(row) {
  return { ...row, amount: Number(row.amount),
    purchase_date: row.purchase_date instanceof Date ? dateString(row.purchase_date) : String(row.purchase_date).slice(0, 10),
    payment_date: row.payment_date instanceof Date ? dateString(row.payment_date) : String(row.payment_date).slice(0, 10) };
}

export function buildGoalPurchasePayments(purchases = [], today = new Date(), through = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30)) {
  return purchases.filter(item => item.status === 'planned' && item.payment_date <= dateString(through)).map(item => ({
    key: `goal-purchase:${item.id}`, purchaseId: item.id, goalId: item.goal_id, planKind: 'goal-purchase',
    planned: true, flexible: false, oneTime: true, date: item.payment_date, dayOfMonth: Number(item.payment_date.slice(8)),
    description: `${item.merchant} · ${item.goal_name}`, label: item.merchant, category: 'Planned goal purchase',
    amount: item.amount, isIncome: false, status: 'projected', payMode: 'manual',
    purchaseDate: item.purchase_date, paymentMethod: item.payment_method
  })).sort((a, b) => a.date.localeCompare(b.date) || a.purchaseId - b.purchaseId);
}
