import { sameBill } from './fixedPayments.js';

// How a debit leaves the account: 'auto' (autopay / recurring pull) or 'manual' (the user must pay it). null = not set.
export const PAY_MODES = ['auto', 'manual'];
export const isPayMode = value => value === null || PAY_MODES.includes(value);
export const normalizePayMode = value => PAY_MODES.includes(value) ? value : null;

// Statement wording that reliably reveals the payment method. Kept in sync with the SQL backfill in schema.js.
const AUTO_HINT = /\b(?:auto\s?-?\s?pay|auto\s?debit|recurring)\b/i;
const MANUAL_HINT = /\b(?:bill\s?pay|online\s+(?:banking\s+)?(?:pmt|payment)|mobile\s+(?:pmt|payment)|web\s+pmt)\b/i;

export function detectPayMode(description = '') {
  const text = String(description ?? '');
  if (AUTO_HINT.test(text)) return 'auto';
  if (MANUAL_HINT.test(text)) return 'manual';
  return null;
}

// New debits inherit the latest explicit pay mode of the same bill, then fall back to statement wording.
export function inheritPayMode(transaction, history) {
  if (String(transaction.direction).toUpperCase() !== 'DEBIT') return null;
  const previous = history.find(row => sameBill(row, transaction));
  return normalizePayMode(previous?.pay_mode) ?? detectPayMode(transaction.description);
}
