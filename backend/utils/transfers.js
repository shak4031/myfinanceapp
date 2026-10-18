import { parseTxDate } from './normalize.js';
import { getFixedBillCategory } from './fixedPayments.js';

// Money moving between a user's own accounts is informational: it never counts as spending or income.
// transactions.transfer_kind is the single source of truth every total uses:
//   NULL       counts normally (spending or income)
//   'internal' between two of your own accounts (checking <-> checking, card or loan payment for an imported card)
//   'savings'  money set aside: checking -> savings / investment / crypto (shown as "Saved this month")
//   'unknown'  transfer wording, but the other account is not classified yet (informational until the user decides)
export const ACCOUNT_KINDS = ['checking', 'savings', 'credit_card', 'loan', 'investment', 'crypto', 'other', 'external', 'unknown'];
export const ACCOUNT_KIND_LABELS = {
  checking: 'Checking', savings: 'Savings', credit_card: 'Credit card', loan: 'Loan', investment: 'Investment',
  crypto: 'Crypto', other: 'Other account of mine', external: 'Not my account', unknown: 'Not classified yet'
};
export const TRANSFER_KINDS = ['internal', 'savings', 'unknown'];
const SAVINGS_LIKE = new Set(['savings', 'investment', 'crypto']);
const DEBT_KINDS = new Set(['credit_card', 'loan']);
const PAIR_WINDOW_DAYS = 5;
const DAY_MS = 86400000;

// Legacy rows (no transfer_kind column loaded) fall back to the category name.
export const TRANSFER_CATEGORY = /^(?:transfers?|internal transfers?|savings|savings transfer)$/i;
const TRANSFER_CATEGORY_NAME = /^(?:transfers?|internal transfers?)$/i;
const SAVINGS_CATEGORY_NAME = /^(?:savings|savings transfer)$/i;

const P2P = /\b(?:zelle|venmo|cash\s*app|square\s*cash|paypal|apple\s*cash|google\s*pay)\b/i;
const TRANSFER_TEXT = /\b(?:transfer|xfer|trnsfr|tfr|funds\s+trans|online\s+banking\s+trans|move\s+money|internet\s+trans)\w*|\b(?:to|from)\s+(?:sav|savings|chk|checking|share|mmkt)\b/i;
const PAYMENT_TEXT = /\b(?:payment|pymt|pmt|autopay|auto\s*pay|e-?pay(?:ment)?|bill\s*pay|mobile\s+pmt)\b/i;
const CARD_PAYMENT_RECEIVED = /\b(?:payment\s*(?:-\s*)?thank\s*you|thank\s*you\s*(?:for\s*your\s*)?payment|autopay\s+payment|payment\s+received|online\s+payment|mobile\s+payment|electronic\s+payment|ach\s+payment)\b/i;
const HINTS = [
  ['savings', /\b(?:sav|savings?|share|mmkt|money\s*market|high\s*yield)\b/i],
  ['investment', /\b(?:fidelity|vanguard|schwab|robinhood|e\*?trade|wealthfront|betterment|acorns|stash|merrill|ameritrade|webull|brokerage|ira|401\s*k|invest\w*)\b/i],
  ['crypto', /\b(?:coinbase|kraken|gemini|binance|crypto\w*)\b/i],
  ['loan', /\b(?:loan|mortgage|auto\s*fin\w*|student|navient|nelnet|mohela|sallie\s*mae|sofi\s+loan)\b/i],
  ['credit_card', /\b(?:credit\s*(?:card|crd)|crd|card\s*services|cardmember|card\s*pmt|amex|american\s*express|discover|capital\s*one|citi\s*cards?|barclay\w*|synchrony|apple\s*card|chase\s*card|card)\b/i],
  ['checking', /\b(?:chk|chkg|checking|dda)\b/i]
];
const LAST4 = [
  /(?:\bx+|\*+|\.{2,}|…)\s?(\d{4})(?!\d)/gi,
  /\b(?:ending\s+in|acct|account|sav(?:ings?)?|chk|chkg|checking|dda|card|loan|share|mmkt)\b[\s#:.\-]*(?:no\.?\s*)?[x*]*(\d{4})(?!\d)/gi
];

const cents = value => Math.round(value * 100) / 100;
const text = tx => String(tx?.description || '');
const isDebit = tx => String(tx.direction).toUpperCase() === 'DEBIT';

export const isP2P = tx => P2P.test(text(tx));
export const hasTransferWording = tx => !isP2P(tx) && TRANSFER_TEXT.test(text(tx));
export function kindHint(description = '') {
  return HINTS.find(([, pattern]) => pattern.test(description))?.[0] || null;
}
export function hasCardPaymentWording(tx) {
  const description = text(tx);
  if (isP2P(tx)) return false;
  // Generic "online payment" wording only means a card payment when it lands on the card (money in).
  if (!isDebit(tx) && CARD_PAYMENT_RECEIVED.test(description)) return true;
  const hint = kindHint(description);
  return PAYMENT_TEXT.test(description) && (hint === 'credit_card' || hint === 'loan');
}

// Last four digits of the other account, taken from masks like XXXX4821, *4821, ...4821 or "SAV 4821".
export function extractLast4(description = '', exclude = null) {
  for (const pattern of LAST4) {
    for (const match of String(description).matchAll(pattern)) {
      if (match[1] !== exclude) return match[1];
    }
  }
  return null;
}

// Shared predicate for every total: true when the row moves money between your own accounts.
export function isTransferRow(tx) {
  if (tx && Object.prototype.hasOwnProperty.call(tx, 'transfer_kind')) return tx.transfer_kind != null;
  return TRANSFER_CATEGORY.test(String(tx?.category || ''));
}

// How much a 'savings' row added to (or took from) your savings. accountKind is the row's own account kind.
export function savedAmount(tx, accountKind = null) {
  if (tx?.transfer_kind !== 'savings') return 0;
  const amount = Math.abs(Number(tx.amount)) || 0;
  const intoSavings = SAVINGS_LIKE.has(accountKind) ? !isDebit(tx) : isDebit(tx);
  return intoSavings ? amount : -amount;
}

const dayNumber = tx => {
  const parsed = parseTxDate(tx.date);
  return parsed ? Date.UTC(parsed.year, parsed.month, parsed.day) / DAY_MS : null;
};

// Pair the two sides of a transfer between imported accounts: opposite directions, same amount,
// different accounts, within a few days, and at least one side worded as a transfer or payment.
export function pairTransfers(rows, accountsById) {
  const pairs = new Map();
  const byKey = new Map();
  const candidates = [];
  for (const row of rows) {
    if (row.account_id == null || isP2P(row)) continue;
    row._day = dayNumber(row);
    row._amount = cents(Math.abs(Number(row.amount)));
    if (row._day == null || !row._amount) continue;
    const key = `${row._amount}|${isDebit(row) ? 'D' : 'C'}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
    if (hasTransferWording(row) || hasCardPaymentWording(row)) candidates.push(row);
  }
  candidates.sort((a, b) => a._day - b._day || Number(a.id) - Number(b.id));
  for (const row of candidates) {
    if (pairs.has(row.id)) continue;
    const opposite = byKey.get(`${row._amount}|${isDebit(row) ? 'C' : 'D'}`) || [];
    const last4 = extractLast4(text(row), accountsById.get(row.account_id)?.last4);
    let best = null;
    for (const other of opposite) {
      if (pairs.has(other.id) || other.account_id === row.account_id) continue;
      const gap = Math.abs(other._day - row._day);
      if (gap > PAIR_WINDOW_DAYS) continue;
      const otherAccount = accountsById.get(other.account_id);
      // A masked number that names a different account rules the pair out.
      if (last4 && otherAccount?.last4 && otherAccount.last4 !== last4) continue;
      const otherLast4 = extractLast4(text(other), otherAccount?.last4);
      const ownAccount = accountsById.get(row.account_id);
      if (otherLast4 && ownAccount?.last4 && ownAccount.last4 !== otherLast4) continue;
      if (!best || gap < best.gap || (gap === best.gap && Number(other.id) < Number(best.row.id))) best = { row: other, gap };
    }
    if (best) {
      pairs.set(row.id, best.row);
      pairs.set(best.row.id, row);
    }
  }
  return pairs;
}

function fallbackCategory(tx, names) {
  const pick = name => (names.has(name) ? name : null);
  if (isP2P(tx)) return pick(isDebit(tx) ? 'Payments to people' : 'Other income') || pick('Other');
  return (isDebit(tx) && pick(getFixedBillCategory(text(tx)))) || (!isDebit(tx) && pick('Other income')) || pick('Other');
}

// Decide the transfer kind for one row. Pure, so it can be unit tested without a database.
export function classifyTransfer(tx, { ownAccount = null, counterpart = null, paired = false, hasRows = () => false } = {}) {
  if (isP2P(tx)) return null;
  const transferWording = hasTransferWording(tx);
  const paymentWording = hasCardPaymentWording(tx);
  if (!transferWording && !paymentWording && !paired) return null;
  const ownKind = ownAccount?.kind || null;
  const otherKind = counterpart?.kind || null;
  if (otherKind === 'external') return null;
  // A payment received on a card or loan statement always came from one of your accounts.
  if (DEBT_KINDS.has(ownKind)) return 'internal';
  // "PAYMENT THANK YOU" money-in is a card statement row even when no account was chosen (older imports).
  if (!isDebit(tx) && paymentWording && !['checking', 'savings', 'investment', 'crypto'].includes(ownKind)) return 'internal';
  if (SAVINGS_LIKE.has(ownKind)) {
    if (paired) return 'internal';
    if (otherKind && SAVINGS_LIKE.has(otherKind)) return 'internal';
    return 'savings';
  }
  if (DEBT_KINDS.has(otherKind)) return hasRows(counterpart.id) ? 'internal' : null;
  if (SAVINGS_LIKE.has(otherKind)) return 'savings';
  if (otherKind === 'checking' || otherKind === 'other') return 'internal';
  // Card or loan payment whose statement is not imported: it is a real bill payment, so it counts.
  if (paymentWording && !transferWording) return null;
  if (otherKind === 'unknown') return 'unknown';
  const hint = kindHint(text(tx));
  if (hint === 'savings' || hint === 'investment' || hint === 'crypto') return 'savings';
  if (hint === 'checking') return 'internal';
  if (hint === 'credit_card' || hint === 'loan') return null;
  return 'unknown';
}

const GENERIC_NAME = new Set(['credit', 'card', 'checking', 'savings', 'loan', 'account', 'my', 'the', 'joint', 'personal', 'business']);
const accountName = (kind, last4) => `${kind ? ACCOUNT_KIND_LABELS[kind] : 'Account'} ••${last4}`;

// Reconcile every transfer for one user. Idempotent; writes only rows whose classification changed.
// Works in both the migration (owner) and request (row-level security) contexts via explicit user_id filters.
export async function reconcileTransfers(client, userId) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid < 1) throw new Error('reconcileTransfers requires a user id');
  for (const [name, icon, color] of [['Transfer', 'Move', '#89959c'], ['Savings', 'Save', '#369c85'], ['Payments to people', 'People', '#9d8ab8'], ['Other income', 'Income', '#4f9a76']]) {
    await client.query('INSERT INTO categories (user_id, name, icon, color) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, name) DO NOTHING', [uid, name, icon, color]);
  }
  const names = new Set((await client.query('SELECT name FROM categories WHERE user_id = $1', [uid])).rows.map(row => row.name));
  const accounts = (await client.query('SELECT id, name, kind, last4, institution, status FROM accounts WHERE user_id = $1 ORDER BY id', [uid])).rows;
  const accountsById = new Map(accounts.map(account => [account.id, account]));
  const rows = (await client.query(`SELECT id, date, description, amount, direction, category, category_corrected, account_id,
    transfer_kind, transfer_account_id, transfer_pair_id, transfer_checked FROM transactions WHERE user_id = $1 ORDER BY id`, [uid])).rows;
  const rowCounts = new Map();
  for (const row of rows) if (row.account_id != null) rowCounts.set(row.account_id, (rowCounts.get(row.account_id) || 0) + 1);
  const hasRows = id => (rowCounts.get(id) || 0) > 0;
  const pairs = pairTransfers(rows, accountsById);
  let discovered = 0, changed = 0;

  const findByLast4 = (last4, ownId) => accounts.find(account => account.last4 === last4 && account.id !== ownId) || null;
  const findByInstitution = (tx, ownId) => {
    const description = text(tx).toLowerCase();
    const matches = accounts.filter(account => account.id !== ownId && DEBT_KINDS.has(account.kind)
      && [account.institution, account.name].some(value => {
        const word = String(value || '').toLowerCase().split(/\s+/)[0];
        return word.length >= 4 && !GENERIC_NAME.has(word) && description.includes(word);
      }));
    return matches.length === 1 ? matches[0] : null;
  };

  for (const row of rows) {
    const own = row.account_id != null ? accountsById.get(row.account_id) || null : null;
    const pair = pairs.get(row.id) || null;
    const transferish = hasTransferWording(row) || hasCardPaymentWording(row);
    let counterpart = pair ? accountsById.get(pair.account_id) || null : null;
    if (!counterpart && transferish) {
      const last4 = extractLast4(text(row), own?.last4);
      if (last4) {
        counterpart = findByLast4(last4, own?.id);
        if (!counterpart) {
          const suggested = kindHint(text(row));
          const created = (await client.query(`INSERT INTO accounts (user_id, name, kind, last4, status, suggested_kind, discovered_from)
            VALUES ($1,$2,'unknown',$3,'needs_review',$4,$5) RETURNING id, name, kind, last4, institution, status`,
          [uid, accountName(suggested, last4), last4, suggested, text(row).slice(0, 200)])).rows[0];
          accounts.push(created);
          accountsById.set(created.id, created);
          counterpart = created;
          discovered++;
        }
      } else if (hasCardPaymentWording(row)) {
        counterpart = findByInstitution(row, own?.id);
      }
    }
    let kind;
    const category = String(row.category || '');
    if (row.category_corrected) {
      // The user's own category choice always wins over detection.
      kind = TRANSFER_CATEGORY_NAME.test(category) ? 'internal' : SAVINGS_CATEGORY_NAME.test(category) ? 'savings' : null;
    } else {
      kind = classifyTransfer(row, { ownAccount: own, counterpart, paired: !!pair, hasRows });
    }
    let nextCategory = row.category;
    if (!row.category_corrected) {
      if (kind === 'savings' && names.has('Savings')) nextCategory = 'Savings';
      else if ((kind === 'internal' || kind === 'unknown') && names.has('Transfer')) nextCategory = 'Transfer';
      else if (!kind && TRANSFER_CATEGORY.test(category)) nextCategory = fallbackCategory(row, names) || row.category;
    }
    const counterpartId = counterpart?.id ?? null;
    const pairId = pair?.id ?? null;
    if (row.transfer_kind === kind && row.transfer_account_id === counterpartId && row.transfer_pair_id === pairId
      && row.transfer_checked && nextCategory === row.category) continue;
    await client.query(`UPDATE transactions SET transfer_kind=$1, transfer_account_id=$2, transfer_pair_id=$3, transfer_checked=TRUE, category=$4
      WHERE id=$5 AND user_id=$6`, [kind, counterpartId, pairId, nextCategory, row.id, uid]);
    changed++;
  }
  return { changed, discovered, checked: rows.length };
}

// Cash on hand: newest balance per checking account (plus rows not yet assigned to an account).
// Savings, cards and loans are shown on the Accounts page rather than mixed into spendable cash.
export function cashBalance(rows, accountsById = new Map(), todayIso = new Date().toISOString().slice(0, 10)) {
  const newest = new Map();
  for (const row of rows) {
    const iso = parseTxDate(row.date)?.iso;
    const balance = Number(row.balance);
    if (!iso || iso > todayIso || row.balance == null || !Number.isFinite(balance)) continue;
    const account = row.account_id != null ? accountsById.get(row.account_id) : null;
    if (account && account.kind !== 'checking') continue;
    const key = account ? `a${account.id}` : 'unassigned';
    const current = newest.get(key);
    if (!current || iso > current.iso || (iso === current.iso && Number(row.id) > Number(current.id))) newest.set(key, { iso, id: row.id, balance });
  }
  if (!newest.size) return null;
  // Unassigned legacy rows only stand in for cash when no checking account has a balance yet.
  const assigned = [...newest].filter(([key]) => key !== 'unassigned');
  const used = assigned.length ? assigned : [...newest];
  return cents(used.reduce((sum, [, entry]) => sum + entry.balance, 0));
}

// Newest balance for every account, for the Accounts page.
export function accountBalances(rows) {
  const newest = new Map();
  for (const row of rows) {
    if (row.account_id == null || row.balance == null) continue;
    const iso = parseTxDate(row.date)?.iso;
    const balance = Number(row.balance);
    if (!iso || !Number.isFinite(balance)) continue;
    const current = newest.get(row.account_id);
    if (!current || iso > current.iso || (iso === current.iso && Number(row.id) > Number(current.id))) newest.set(row.account_id, { iso, id: row.id, balance });
  }
  return new Map([...newest].map(([id, entry]) => [id, { balance: cents(entry.balance), asOf: entry.iso }]));
}
