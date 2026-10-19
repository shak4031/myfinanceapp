import { PDFParse } from 'pdf-parse';

const MAX_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 100;
const MONEY = /(?:[-+]\s*)?\(?\$?\s*\d[\d,]*\.\d{2}\)?(?:\s*(?:CR|DR)\b|[-+])?/gi;
const DATE = '(?:\\d{1,2}[/-]\\d{1,2}(?:[/-](?:\\d{4}|\\d{2}))?)';
const ROW = new RegExp(`^(?:[A-Z0-9]{8,}\\s+)?(${DATE})(?:\\s+(${DATE}))?\\s+(.+)$`, 'i');
const MONTHS = 'January February March April May June July August September October November December'.split(' ');
const fail = message => Object.assign(new Error(message), { status: 422, code: 'PDF_REVIEW_REQUIRED' });
const cents = value => Math.round(value * 100);
const cash = value => value / 100;
const iso = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
};
function dateValue(value, closingDate) {
  const named = String(value).match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) return iso(Number(named[3]), MONTHS.findIndex(month => month.toLowerCase() === named[1].toLowerCase()) + 1, Number(named[2]));
  const match = String(value).match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/);
  if (!match) return null;
  let year = match[3] ? Number(match[3]) : Number(closingDate?.slice(0, 4));
  if (!year) return null;
  if (year < 100) year += year < 70 ? 2000 : 1900;
  let result = iso(year, Number(match[1]), Number(match[2]));
  if (!match[3] && result && closingDate && result > closingDate) result = iso(year - 1, Number(match[1]), Number(match[2]));
  return result;
}
function amounts(text) {
  return [...text.matchAll(MONEY)].map(match => {
    const token = match[0].trim();
    const number = Number(token.replace(/[^\d.]/g, ''));
    return { value: cents(number) * (/[-(]|CR\b/i.test(token) ? -1 : 1), index: match.index, end: match.index + match[0].length, token };
  });
}
function labeledMoney(lines, pattern, name) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]);
    if (!match) continue;
    const tail = lines[i].slice(match.index + match[0].length);
    if (tail.includes('%')) continue;
    const values = amounts(tail);
    if (values.length) found.push(values[0].value);
    else if (/^[\s:$+-]*$/.test(tail) && /^[-+$\s(]*\d[\d,]*\.\d{2}\)?(?:[-+]|CR|DR)?$/i.test(lines[i + 1] || '')) found.push(amounts(lines[i + 1])[0].value);
  }
  if (new Set(found).size > 1) throw fail(`Conflicting ${name} values were found. Upload one statement per file.`);
  return found.length ? found[0] : null;
}
function metadata(lines) {
  const text = lines.join('\n');
  const card = /credit\s*card\s*statement|(?:new (?:statement )?balance)[\s\S]*minimum payment|annual percentage rate\s*\(APR\)/i.test(text);
  const bank = /(?:checking|savings|deposit) (?:account|statement)|(?:ending|closing) balance|deposits and (?:other )?credits/i.test(text);
  if (!card && !bank) throw fail('This document could not be identified as a credit card or bank statement. Use a text-based statement PDF or your bank’s CSV/OFX export.');
  const type = card ? 'credit-card' : 'bank';
  let closingDate = null, startDate = null;
  const close = text.match(/(?:statement (?:closing|ending) date|closing date|statement date)\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2}))/i);
  if (close) closingDate = dateValue(close[1]);
  const period = text.match(/([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2}))\s*(?:to|through|thru|[-–])\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2}))/i);
  if (period) {
    startDate = dateValue(period[1]);
    const end = dateValue(period[2]);
    if (closingDate && end !== closingDate) throw fail('The statement period and closing date disagree. Review the statement before importing.');
    closingDate ||= end;
  }
  if (!closingDate) throw fail('The statement closing date could not be read. A closing date is required to assign transaction years correctly.');
  const previousBalance = labeledMoney(lines, /(?:previous|beginning|opening) balance\s*:?\s*/i, 'opening balance');
  const balance = labeledMoney(lines, card ? /new (?:statement )?balance\s*:?\s*/i : /(?:ending|closing) (?:daily )?balance\s*:?\s*/i, 'closing balance');
  if (balance == null) throw fail(`The ${card ? '"New Balance" / "New Statement Balance"' : 'ending balance'} could not be read. Nothing was imported.`);
  const aprs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^(?:standard\s+)?purchases?\b/i.test(lines[i])) continue;
    const rate = `${lines[i]} ${lines[i + 1] || ''}`.match(/\b(\d{1,2}(?:\.\d{1,3})?)\s*%/);
    if (rate) aprs.push(Number(rate[1]));
  }
  const warnings = [];
  if (new Set(aprs).size > 1) warnings.push('Multiple purchase APRs were found; no single purchase APR was saved. Review promotional rates on the statement.');
  if (card && !aprs.length) warnings.push('Purchase APR was not readable; no APR was inferred from cash advance or balance transfer rates.');
  const account = text.match(/(?:account (?:number(?: ending)?|ending)|ending in)\s*:?\s*((?:[Xx*•.\d][ \t-]*){4,24})/i);
  const digits = account?.[1].replace(/\D/g, '');
  const due = text.match(/payment due date\s*:?\s*(\d{1,2}[/-]\d{1,2}[/-](?:\d{4}|\d{2}))/i);
  const totals = card ? {
    purchases: labeledMoney(lines, /^\+?\s*purchases\s*\+?\s*/i, 'purchases'),
    payments: labeledMoney(lines, /^[-+]?\s*payments(?!,)\s*[-+]?\s*/i, 'payments'),
    otherCredits: labeledMoney(lines, /^[-+]?\s*other credits\s*[-+]?\s*/i, 'other credits'),
    fees: labeledMoney(lines, /^\+?\s*fees charged\s*\+?\s*/i, 'fees'),
    interest: labeledMoney(lines, /^\+?\s*interest charged\s*\+?\s*/i, 'interest'),
    cashAdvances: labeledMoney(lines, /^\+?\s*cash advances\s*\+?\s*/i, 'cash advances'),
    balanceTransfers: labeledMoney(lines, /^\+?\s*balance transfers\s*\+?\s*/i, 'balance transfers')
  } : {
    deposits: labeledMoney(lines, /^(?:total )?(?:deposits(?: and (?:other )?credits)?|credits)\s*:?\s*/i, 'deposits'),
    withdrawals: labeledMoney(lines, /^(?:total )?(?:withdrawals(?: and (?:other )?debits)?|debits)\s*:?\s*/i, 'withdrawals')
  };
  return {
    type, closingDate, startDate, balance: cash(balance), previousBalance: previousBalance == null ? null : cash(previousBalance),
    purchaseApr: new Set(aprs).size === 1 ? aprs[0] : null, last4: digits?.slice(-4) || null,
    minimumPayment: card ? toCash(labeledMoney(lines, /minimum payment due\s*:?\s*/i, 'minimum payment')) : null,
    creditLimit: card ? toCash(labeledMoney(lines, /^credit limit\s*:?\s*/i, 'credit limit')) : null,
    paymentDueDate: due ? dateValue(due[1]) : null, totals, warnings
  };
}
const toCash = value => value == null ? null : cash(Math.abs(value));

function sectionFor(line) {
  if (/^(?:payments?(?:,?\s+(?:and\s+)?(?:other\s+)?credits)?(?:,?\s+(?:and\s+)?adjustments)?|(?:other )?credits(?: and deposits)?|deposits(?: and (?:other )?credits)?)\s*(?:\(continued\))?\s*$/i.test(line)) return 'CREDIT';
  if (/^(?:purchases(?: and (?:other )?(?:charges|debits))?|transactions|withdrawals(?: and (?:other )?debits)?|electronic (?:payments|withdrawals)|checks paid|fees(?: charged)?|interest charged)\s*(?:\(continued\))?\s*$/i.test(line)) return 'DEBIT';
  return null;
}
function reconcile(transactions, statement) {
  const total = direction => transactions.filter(tx => tx.direction === direction).reduce((sum, tx) => sum + cents(tx.amount), 0);
  const debit = total('DEBIT'), credit = total('CREDIT'), closing = cents(statement.balance);
  if (statement.previousBalance == null) throw fail('The opening/previous balance could not be read, so transaction completeness cannot be verified. Nothing was imported. Try CSV/OFX.');
  const expected = cents(statement.previousBalance) + (statement.type === 'credit-card' ? debit - credit : credit - debit);
  if (expected !== closing) throw fail(`The extracted transactions do not reconcile to the statement closing balance (difference $${cash(Math.abs(expected - closing)).toFixed(2)}). Nothing was imported. Try the original downloaded PDF or CSV/OFX.`);
  const check = (actual, expected, label) => {
    if (expected != null && actual !== Math.abs(expected)) throw fail(`The extracted ${label} do not match the statement summary. Nothing was imported. Try CSV/OFX.`);
  };
  if (statement.type === 'credit-card') {
    const sum = kind => transactions.filter(tx => tx.statementKind === kind).reduce((sum, tx) => sum + cents(tx.amount), 0);
    check(sum('purchase'), statement.totals.purchases, 'purchases');
    check(sum('payment'), statement.totals.payments, 'payments');
    check(sum('credit'), statement.totals.otherCredits, 'credits');
    check(sum('fee'), statement.totals.fees, 'fees');
    check(sum('interest'), statement.totals.interest, 'interest charges');
    check(sum('cash-advance'), statement.totals.cashAdvances, 'cash advances');
    check(sum('balance-transfer'), statement.totals.balanceTransfers, 'balance transfers');
  } else {
    check(credit, statement.totals.deposits, 'deposits');
    check(debit, statement.totals.withdrawals, 'withdrawals');
  }
  return { status: 'balanced', debit: cash(debit), credit: cash(credit), openingBalance: statement.previousBalance, closingBalance: statement.balance };
}

export function parseStatementText(text) {
  const lines = String(text).replace(/\u00a0/g, ' ').replace(/[−–]/g, '-').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.join('').length < 80) throw fail('This PDF has no readable statement text (it may be a scanned image). Download the original text-based statement or import CSV/OFX instead.');
  const statement = metadata(lines);
  const transactions = [];
  let section = null, tableActive = false, hasBalanceColumn = false, creditColumn = false, debitColumn = false, creditFirst = false, cardSection = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextSection = sectionFor(line);
    if (nextSection) { section = nextSection; cardSection = null; }
    if (/^cash advances\s*(?:\(continued\))?$/i.test(line)) { cardSection = 'cash-advance'; section = 'DEBIT'; }
    if (/^balance transfers\s*(?:\(continued\))?$/i.test(line)) { cardSection = 'balance-transfer'; section = 'DEBIT'; }
    if (/\bdate\b/i.test(line) && /\b(?:description|transaction|details)\b/i.test(line)) {
      tableActive = true;
      hasBalanceColumn = /\bbalance\b/i.test(line);
      creditColumn = /\b(?:credit|deposit)s?\b/i.test(line);
      debitColumn = /\b(?:debit|withdrawal)s?\b/i.test(line);
      creditFirst = line.search(/\b(?:credit|deposit)s?\b/i) < line.search(/\b(?:debit|withdrawal)s?\b/i);
      continue;
    }
    const match = line.match(ROW);
    if (!match) continue;
    // Single-date rows need a table/section. Two-date card rows also work when PDF drawing order puts headers last.
    if (!match[2] && !section && !tableActive) continue;
    const date = dateValue(match[2] || match[1], statement.closingDate);
    const minimumDate = statement.startDate || new Date(new Date(`${statement.closingDate}T00:00:00Z`).getTime() - 62 * 86400000).toISOString().slice(0, 10);
    if (!date || date < minimumDate || date > statement.closingDate) throw fail('A transaction date is invalid or outside the statement period. Nothing was imported.');
    let content = match[3], values = amounts(content);
    // Wrapped merchants and amounts may occupy separate PDF text lines.
    for (let extra = 0; !values.length && extra < 5 && i + 1 < lines.length; extra++) {
      const following = lines[i + 1];
      if (ROW.test(following) || sectionFor(following) || /^(?:total|page|--|\d{4} totals|interest charge calculation)/i.test(following)) break;
      content += ` ${following}`; i++;
      values = amounts(content);
    }
    if (!values.length) throw fail('A dated transaction has no readable amount. Nothing was imported; try CSV/OFX.');
    const trailing = values.filter(value => /^[\s$()+\-\d,.]*(?:CR|DR)?\s*$/i.test(content.slice(value.end)));
    let value = trailing[0];
    if (!value) throw fail('A transaction amount is ambiguous. Nothing was imported; try CSV/OFX.');
    const isBank = statement.type === 'bank';
    const balanceValue = isBank && hasBalanceColumn && trailing.length > 1 ? trailing.at(-1).value : null;
    const description = content.slice(0, value.index).trim().replace(/^(?=[A-Z0-9]*\d)[A-Z0-9]{10,}\s+/i, '');
    if (!description || !/[A-Za-z]/.test(description)) throw fail('A transaction description could not be read. Nothing was imported.');
    if (isBank && debitColumn && creditColumn && trailing.length === (hasBalanceColumn ? 3 : 2)) {
      const nonzero = trailing.slice(0, 2).filter(entry => entry.value !== 0);
      if (nonzero.length !== 1) throw fail('A bank row has ambiguous debit and credit amounts. Nothing was imported.');
      value = nonzero[0];
    }
    let direction, amount = Math.abs(value.value);
    const payment = /\bpayment\b.*(?:thank you|mobile app|autopay|received|online)|^payment\s*[-:]/i.test(description) || (section === 'CREDIT' && /\bpayment\b/i.test(description));
    const kind = /interest charge/i.test(description) ? 'interest' : /\bfees?\b/i.test(description) ? 'fee'
      : payment ? 'payment' : value.value < 0 || section === 'CREDIT' ? 'credit'
      : cardSection || (/\bcash advance\b/i.test(description) ? 'cash-advance' : /\bbalance transfer\b/i.test(description) ? 'balance-transfer' : 'purchase');
    if (!isBank) {
      direction = kind === 'payment' || kind === 'credit' ? 'CREDIT' : 'DEBIT';
    } else if (balanceValue != null) {
      direction = null; // Resolve from adjacent balances, not guesses about merchant wording.
    } else if (/CR\b/i.test(value.token)) direction = 'CREDIT';
    else if (/DR\b/i.test(value.token) || value.value < 0) direction = 'DEBIT';
    else if (/^\+/.test(value.token)) direction = 'CREDIT';
    else if (debitColumn && creditColumn && trailing.length === 2 && !hasBalanceColumn) direction = (value === trailing[0]) === creditFirst ? 'CREDIT' : 'DEBIT';
    else if (creditColumn !== debitColumn) direction = creditColumn ? 'CREDIT' : 'DEBIT';
    else if (section) direction = section;
    else throw fail('Bank debit and credit columns could not be distinguished. Nothing was imported; use CSV/OFX.');
    if (amount === 0) continue;
    transactions.push({ date, description, amount: cash(amount), direction, balance: balanceValue == null ? null : cash(balanceValue),
      statementKind: kind, ...(payment && !isBank ? { categoryHint: 'Transfer' } : {}) });
  }
  if (statement.type === 'bank') {
    let previous = statement.previousBalance == null ? null : cents(statement.previousBalance);
    for (const tx of [...transactions].sort((a, b) => a.date.localeCompare(b.date))) {
      if (tx.balance != null) {
        if (previous == null || Math.abs(cents(tx.balance) - previous) !== cents(tx.amount)) throw fail('The bank transaction running balances do not reconcile. Nothing was imported; try CSV/OFX.');
        tx.direction = cents(tx.balance) >= previous ? 'CREDIT' : 'DEBIT';
        previous = cents(tx.balance);
      } else if (previous != null) previous += cents(tx.amount) * (tx.direction === 'CREDIT' ? 1 : -1);
    }
  }
  const reconciliation = reconcile(transactions, statement);
  // A non-empty summary must never become a zero-row "success", even when debits and credits cancel.
  if (!transactions.length && Object.values(statement.totals).some(value => value != null && value !== 0)) throw fail('The summary shows activity but no transactions could be read. Nothing was imported; try CSV/OFX.');
  if (!transactions.length && !Object.values(statement.totals).some(value => value === 0) && !/\bno (?:transactions|activity)\b/i.test(text)) throw fail('No transaction activity or explicit no-activity summary could be verified. Nothing was imported; try CSV/OFX.');
  return { transactions, statement, reconciliation, warnings: statement.warnings, errors: [], fileDuplicates: 0, format: `pdf-${statement.type}` };
}

export default class PDFParser {
  async extractTextFromPDF(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw Object.assign(new Error('Choose a PDF no larger than 12 MB.'), { status: 400 });
    if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Object.assign(new Error('This file is not a valid PDF.'), { status: 400 });
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo();
      if (info.total > MAX_PAGES) throw fail('This PDF exceeds 100 pages. Upload individual statements rather than a combined archive.');
      const result = await parser.getText();
      if (result.text.length > 2_000_000) throw fail('This statement contains too much text. Upload individual statements.');
      return result.text;
    } catch (error) {
      if (error.status) throw error;
      throw fail(error.name === 'PasswordException'
        ? 'This PDF is password-protected. Upload an unlocked statement or a CSV/OFX export.'
        : 'The PDF could not be read. Download the original statement again or use CSV/OFX.');
    } finally {
      await parser.destroy();
    }
  }
  async parseDocument(buffer) {
    return parseStatementText(await this.extractTextFromPDF(buffer));
  }
  async parseStatement(buffer) {
    return (await this.parseDocument(buffer)).transactions;
  }
}
