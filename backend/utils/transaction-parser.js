/**
 * Transaction parser
 * Bank-agnostic CSV/OFX parsing with automatic column and sign detection, deduplication and categorization
 */

import { log } from './logger.js';

/**
 * Category matching patterns for intelligent auto-categorization
 */
const CATEGORY_PATTERNS = {
  'Groceries': [
    /whole\s?foods/i, /kroger/i, /safeway/i, /trader\s?joe/i, /sprouts/i,
    /instacart/i, /grocery/i, /food\s?(delivery|network)/i, /harris/i
  ],
  'Utilities': [
    /electric/i, /water\s?(and\s?)?sewer/i, /gas\s?(and\s)?electric/i,
    /verizon/i, /comcast/i, /internet/i, /phone\s?service/i
  ],
  'EV Charging': [
    /chargepoint/i, /tesla\s?(supercharger|charging)/i, /ev\s?charging/i,
    /blink\s?charging/i, /plugshare/i, /electric\s?vehicle\s?charging/i
  ],
  'Gas': [
    /shell|chevron|exxon|bp|mobil|citgo|sunoco/i, /gas\s?station/i, /fuel/i
  ],
  'Dining': [
    /restaurant/i, /cafe|coffee/i, /doordash/i, /uber\s?eats/i, /grubhub/i,
    /mcdonald|burger\s?king|wendy/i, /chipotle/i, /panera/i, /starbucks/i,
    /pizza|sushi/i, /dinner|lunch|breakfast/i
  ],
  'Shopping': [
    /target|walmart|amazon|ebay|best\s?buy|costco/i, /mall|store|retail/i,
    /etsy|shopify/i
  ],
  'Entertainment': [
    /netflix|hulu|disney|spotify|hbo|showtime/i, /movie|cinema|theater/i,
    /game|steam|playstation|xbox/i, /concert|event/i
  ],
  'Healthcare': [
    /pharmacy|walgreens|cvs/i, /doctor|hospital|clinic|medical/i,
    /dental|vision|health\s?care/i
  ],
  'Insurance': [
    /state\s?farm|geico|progressive|allstate/i, /insurance/i, /premium/i
  ],
  'Transportation': [
    /uber|lyft|taxi|parking/i, /metro|transit|bus/i, /car\s?wash/i,
    /toll|ferry/i
  ],
  'Subscriptions': [
    /subscription|membership/i, /monthly\s?fee/i
  ],
  'Transfer': [
    /transfer|xfer|zelle|venmo|paypal\s?(sent|received|transfer)/i,
    /online\s?(transfer|xfer)/i
  ],
  'Payment': [
    /payment|installment/i, /credit\s?card/i, /bill\s?pay/i
  ],
  'Fee': [
    /fee|charge|overdraft|maintenance/i
  ],
  'Income': [
    /salary|paycheck|wage|income|bonus|dividend/i
  ]
};

/**
 * Intelligently categorize a transaction based on its description
 * @param {string} description - Transaction description
 * @param {string} txnType - Transaction type (DEBIT, CREDIT, etc)
 * @returns {string} Category name
 */
function categorizeTransaction(description, txnType) {
  if (!description) return 'Other';

  description = description.toUpperCase();

  // Check patterns in order of priority
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(description)) {
        return category;
      }
    }
  }

  // Direction-based fallback
  if (txnType === 'CREDIT') return 'Income';
  if (txnType === 'DEBIT' || txnType === 'DEBIT') return 'Shopping';

  return 'Other';
}

/**
 * Bank-agnostic statement parser.
 * Reads CSV/TSV exports from any bank or card issuer, plus OFX/QFX/QBO downloads, and returns
 * transactions as { date: 'YYYY-MM-DD', description, amount (positive), direction: DEBIT|CREDIT, balance }.
 */
class TransactionCSVParser {
  constructor() {
    this.reset();
  }

  reset() {
    this.transactions = [];
    this.errors = [];
    this.skipped = 0;
    this.columnMap = {};
    this.format = null;
  }

  // Delimiter that splits the first lines most consistently (comma, semicolon, tab or pipe).
  detectDelimiter(text) {
    const sample = text.split('\n').slice(0, 40).filter(line => line.trim());
    let best = ',', bestScore = -1;
    for (const delimiter of [',', ';', '\t', '|']) {
      const counts = sample.map(line => this.splitRecords(line, delimiter)[0]?.length || 1);
      const multi = counts.filter(count => count > 1);
      if (!multi.length) continue;
      const mode = [...new Set(multi)].sort((a, b) => multi.filter(c => c === b).length - multi.filter(c => c === a).length)[0];
      const score = multi.filter(count => count === mode).length * 10 + mode;
      if (score > bestScore) { best = delimiter; bestScore = score; }
    }
    return best;
  }

  // RFC 4180 records: quoted fields may contain delimiters, doubled quotes and line breaks.
  splitRecords(text, delimiter = ',') {
    const records = [];
    let record = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (inQuotes) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') inQuotes = false;
        else field += char;
      } else if (char === '"' && !field.trim()) { field = ''; inQuotes = true; }
      else if (char === delimiter) { record.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        record.push(field); records.push(record); record = []; field = '';
      } else field += char;
    }
    if (field || record.length) { record.push(field); records.push(record); }
    return records.map(row => row.map(cell => cell.trim())).filter(row => row.some(cell => cell));
  }

  // Back-compat for callers that split a single line.
  parseCSVRow(row) {
    return this.splitRecords(row)[0] || [];
  }

  // Header names vary by bank; each role takes the best-ranked matching column.
  detectColumns(headerRow) {
    const columns = (Array.isArray(headerRow) ? headerRow : this.parseCSVRow(headerRow))
      .map(cell => cell.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' '));
    const pick = (tests, exclude = []) => {
      for (const testFn of tests) {
        const index = columns.findIndex((name, i) => !exclude.includes(i) && testFn(name));
        if (index >= 0) return index;
      }
      return -1;
    };
    const date = pick([
      name => /^(trans(action)?\.? ?date|date|transaction date|txn date)$/.test(name),
      name => /^(posting|posted|post|effective|value|booking) date$/.test(name),
      name => /date/.test(name) && !/time/.test(name)
    ]);
    const debit = pick([name => /^(debits?|withdrawals?|money out|paid out|outflow|charges?|debit amount|withdrawal amount|amount debit|debit \(\$\))$/.test(name)]);
    const credit = pick([name => /^(credits?|deposits?|money in|paid in|inflow|credit amount|deposit amount|amount credit|credit \(\$\))$/.test(name)]);
    const amount = pick([
      name => /^(amount|transaction amount|amt|amount \(\$\)|amount \(usd\)|value|net amount)$/.test(name),
      name => /amount|\bamt\b/.test(name) && !/summary|balance/.test(name)
    ], [debit, credit]);
    const description = pick([
      name => /^(description|transaction description|payee|merchant|merchant name|name|narrative|narration|transaction details)$/.test(name),
      name => /description|payee|merchant/.test(name),
      name => /^(details|memo|notes?|reference)$/.test(name)
    ], [date, amount, debit, credit]);
    const memo = pick([name => /^(memo|notes?|extended description)$/.test(name)], [description]);
    const balance = pick([name => /balance|running bal/.test(name)]);
    // Type-like columns are only used for unambiguous debit/credit words.
    const types = columns.map((name, i) => (/^(type|transaction type|trans(action)? type|tran type|details|transaction|debit\/credit|dr\/cr|cr\/dr|credit\/debit|indicator)$/.test(name) ? i : -1))
      .filter(i => i >= 0 && ![date, amount, debit, credit, description, balance].includes(i));
    return { date, description, memo, amount, debit, credit, balance, types, txnType: types[0] ?? -1, columns };
  }

  isHeader(row) {
    const map = this.detectColumns(row);
    return map.date >= 0 && (map.amount >= 0 || map.debit >= 0 || map.credit >= 0)
      && row.every(cell => !this.parseDate(cell) || /date/i.test(cell));
  }

  // Accepts ISO, M/D/YYYY, M/D/YY, YYYYMMDD, "Oct 14, 2026" and "14 Oct 2026". Day-first only when unambiguous.
  parseDate(value) {
    const s = String(value || '').trim().replace(/^"|"$/g, '');
    if (!s) return null;
    const valid = (year, month, day) => {
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        && year >= 1990 && year <= 2100 ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : null;
    };
    let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/);
    if (match) return valid(+match[1], +match[2], +match[3]);
    match = s.match(/^(\d{4})(\d{2})(\d{2})(?:\d{6})?(?:\.\d+)?(?:\[.*\])?$/);
    if (match) return valid(+match[1], +match[2], +match[3]);
    match = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|\s)/);
    if (match) {
      let year = +match[3];
      if (match[3].length === 2) year += year >= 70 ? 1900 : 2000;
      const first = +match[1], second = +match[2];
      return first > 12 ? valid(year, second, first) : valid(year, first, second);
    }
    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    match = s.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/i);
    if (match && MONTHS.includes(match[1].toLowerCase())) return valid(+match[3], MONTHS.indexOf(match[1].toLowerCase()) + 1, +match[2]);
    match = s.match(/^(\d{1,2})[ -]([a-z]{3})[a-z]*\.?[ -](\d{2}|\d{4})$/i);
    if (match && MONTHS.includes(match[2].toLowerCase())) {
      const year = match[3].length === 2 ? 2000 + +match[3] : +match[3];
      return valid(year, MONTHS.indexOf(match[2].toLowerCase()) + 1, +match[1]);
    }
    return null;
  }

  isValidDate(value) {
    return this.parseDate(value) !== null;
  }

  // Signed number from "$1,234.56", "-15.49", "(15.49)", "15.49 CR", "15.49-" or "USD 15.49".
  parseAmount(value) {
    let s = String(value ?? '').trim();
    if (!s) return null;
    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
    if (/\bCR\.?$/i.test(s)) s = s.replace(/\s*CR\.?$/i, '');
    else if (/\bDR\.?$/i.test(s)) { sign = -sign; s = s.replace(/\s*DR\.?$/i, ''); }
    if (/-$/.test(s)) { sign = -sign; s = s.slice(0, -1); }
    s = s.replace(/^(?:USD|CAD|EUR|GBP)\s*|\s*(?:USD|CAD|EUR|GBP)$/i, '').replace(/[$£€\s,]/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    if (!/^-?\d*\.?\d+$/.test(s)) return null;
    const number = Number(s) * sign;
    return Number.isFinite(number) ? number : null;
  }

  cleanString(str) {
    return String(str || '').replace(/\s+/g, ' ').trim().substring(0, 500);
  }

  // Unambiguous direction words from a bank's own type column.
  typeDirection(value) {
    const s = String(value || '').toLowerCase();
    if (!s) return null;
    if (/\b(debit|dr|withdrawal|purchase|sale|fee|charge)\b|_debit\b|^debit/.test(s) && !/credit|deposit|refund|return/.test(s)) return 'DEBIT';
    if (/\b(credit|cr|deposit|refund|return)\b|_credit\b|^credit/.test(s) && !/debit|withdrawal/.test(s)) return 'CREDIT';
    return null;
  }

  // Columns for files without a header row (e.g. Wells Fargo): inferred from the data itself.
  inferColumns(rows) {
    const width = Math.max(...rows.map(row => row.length));
    const share = test => Array.from({ length: width }, (_, i) => rows.filter(row => test(row[i] ?? '')).length / rows.length);
    const dates = share(cell => this.parseDate(cell) !== null);
    const numbers = share(cell => this.parseAmount(cell) !== null);
    const date = dates.findIndex(value => value >= 0.8);
    const amount = numbers.findIndex((value, i) => i !== date && value >= 0.8);
    const textLength = Array.from({ length: width }, (_, i) => i === date || i === amount ? -1
      : rows.reduce((sum, row) => sum + (this.parseAmount(row[i]) === null ? String(row[i] || '').length : 0), 0));
    const description = textLength.indexOf(Math.max(...textLength));
    return { date, description, memo: -1, amount, debit: -1, credit: -1, balance: -1, types: [], txnType: -1, columns: [] };
  }

  parse(content, sourceFile = 'Unknown', { accountType = null } = {}) {
    this.reset();
    const text = String(content || '').replace(/^\uFEFF/, '');
    if (/<OFX>|OFXHEADER:/i.test(text.slice(0, 4000))) return this.parseOfx(text, accountType);

    const rows = this.splitRecords(text, this.detectDelimiter(text));
    if (rows.length < 1) {
      this.errors.push('The file is empty');
      return this.result();
    }
    // Some banks (e.g. Bank of America) put a summary block above the real header.
    let headerIndex = rows.slice(0, 40).findIndex(row => this.isHeader(row));
    let map;
    if (headerIndex >= 0) map = this.detectColumns(rows[headerIndex]);
    else {
      const dataRows = rows.filter(row => row.some(cell => this.parseDate(cell)));
      map = dataRows.length ? this.inferColumns(dataRows) : null;
      headerIndex = -1;
      if (!map || map.date < 0 || map.amount < 0) {
        this.errors.push('No header row with date and amount (or debit/credit) columns was found');
        return this.result();
      }
    }
    this.columnMap = map;

    const parsed = [];
    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i];
      const date = this.parseDate(row[map.date]);
      if (!date) {
        // Repeated headers, totals and footers are skipped; anything that looks like data is an error.
        if (row.some(cell => this.parseAmount(cell) !== null) && !/total|balance|summary/i.test(row.join(' '))) this.errors.push(`Row ${i + 1}: unreadable date "${String(row[map.date] ?? '').slice(0, 20)}"`);
        else this.skipped++;
        continue;
      }
      const debit = map.debit >= 0 ? this.parseAmount(row[map.debit]) : null;
      const credit = map.credit >= 0 ? this.parseAmount(row[map.credit]) : null;
      const signed = map.amount >= 0 ? this.parseAmount(row[map.amount]) : null;
      let amount = null, direction = null, signedOnly = false;
      if (debit) { amount = Math.abs(debit); direction = 'DEBIT'; }
      else if (credit) { amount = Math.abs(credit); direction = 'CREDIT'; }
      else if (signed) { amount = Math.abs(signed); signedOnly = true; }
      if (!amount) {
        this.skipped++; // e.g. "Beginning balance" rows with no amount
        continue;
      }
      const hint = map.types.map(index => this.typeDirection(row[index])).find(Boolean) || null;
      let description = this.cleanString(row[map.description]);
      const memo = map.memo >= 0 ? this.cleanString(row[map.memo]) : '';
      if (!description) description = memo;
      else if (memo && !/download|usbank|^\d+$/i.test(memo) && !description.toUpperCase().includes(memo.toUpperCase())) description = this.cleanString(`${description} ${memo}`);
      parsed.push({ row: i + 1, date, description: description || 'Unknown', amount: Math.round(amount * 100) / 100, direction, signed, signedOnly, hint,
        balance: map.balance >= 0 ? this.parseAmount(row[map.balance]) : null });
    }

    const signConvention = this.resolveSigns(parsed, accountType);
    for (const item of parsed) {
      if (item.signedOnly) item.direction = item.hint || ((item.signed < 0) === (signConvention === 'negative-is-spending') ? 'DEBIT' : 'CREDIT');
    }
    this.format = {
      kind: 'csv', header: headerIndex >= 0, signConvention: parsed.some(item => item.signedOnly) ? signConvention : 'debit-credit-columns',
      columns: Object.fromEntries(['date', 'description', 'amount', 'debit', 'credit', 'balance'].filter(key => map[key] >= 0).map(key => [key, map.columns[map[key]] ?? `column ${map[key] + 1}`]))
    };
    return this.finish(parsed, accountType, sourceFile);
  }

  // One signed-amount column means different things per issuer: most banks and Chase/BofA cards show spending as
  // negative, while Amex and Discover cards show charges as positive. Payment/deposit rows and the type column decide;
  // otherwise spending is the more common sign.
  resolveSigns(parsed, accountType) {
    const signed = parsed.filter(item => item.signedOnly);
    if (!signed.length) return 'negative-is-spending';
    // Bank accounts always show withdrawals as negative; only card issuers differ. A savings file can be all deposits.
    if (accountType === 'checking' || accountType === 'savings') return 'negative-is-spending';
    let negativeSpending = 0, positiveSpending = 0;
    for (const item of signed) {
      const moneyIn = item.hint === 'CREDIT' || (!item.hint && INFLOW_TEXT.test(item.description));
      const moneyOut = item.hint === 'DEBIT';
      if (moneyIn) item.signed < 0 ? positiveSpending++ : negativeSpending++;
      else if (moneyOut) item.signed < 0 ? negativeSpending++ : positiveSpending++;
    }
    if (negativeSpending !== positiveSpending) return negativeSpending > positiveSpending ? 'negative-is-spending' : 'positive-is-spending';
    const negatives = signed.filter(item => item.signed < 0).length;
    const positives = signed.length - negatives;
    if (negatives !== positives) return negatives > positives ? 'negative-is-spending' : 'positive-is-spending';
    return accountType === 'credit_card' ? 'positive-is-spending' : 'negative-is-spending';
  }

  finish(parsed, accountType, sourceFile) {
    const seen = new Set();
    let duplicates = 0;
    const card = accountType === 'credit_card';
    for (const item of parsed) {
      const key = `${item.date}|${item.description}|${item.amount}|${item.direction}`;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      // A payment received on a card account moves money between your own accounts; it is not income.
      const cardPayment = item.direction === 'CREDIT' && (card ? CARD_PAYMENT_TEXT.test(item.description) : /THANK\s*YOU/i.test(item.description) && /PAYMENT|PYMT/i.test(item.description));
      this.transactions.push({
        date: item.date, description: item.description, category: cardPayment ? 'Transfer' : categorizeTransaction(item.description, item.direction),
        amount: item.amount, direction: item.direction, balance: item.balance ?? null, source: sourceFile, type: item.direction,
        ...(cardPayment ? { categoryHint: 'Transfer' } : {})
      });
    }
    log('PARSER', `Parsed ${this.transactions.length} transactions from ${sourceFile} (${this.format?.kind || 'csv'}, ${this.format?.signConvention || 'n/a'}), ${duplicates} duplicates, ${this.skipped} skipped, ${this.errors.length} errors`);
    return this.result(duplicates);
  }

  result(duplicates = 0) {
    return { transactions: this.transactions, errors: this.errors, duplicates, skipped: this.skipped, format: this.format };
  }

  // OFX/QFX/QBO (Quicken/QuickBooks downloads): a standard format with signed TRNAMT (negative = money out)
  // for bank and credit card accounts alike.
  parseOfx(text, accountType) {
    const tag = (block, name) => (block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'))?.[1] || '').trim();
    const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const isCard = /<CCSTMTRS>/i.test(text) || accountType === 'credit_card';
    const balance = this.parseAmount(tag(text.match(/<LEDGERBAL>[\s\S]*?(?:<\/LEDGERBAL>|$)/i)?.[0] || '', 'BALAMT'));
    const parsed = [];
    const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi) || [];
    blocks.forEach((block, index) => {
      const date = this.parseDate(tag(block, 'DTPOSTED').slice(0, 8)) || this.parseDate(tag(block, 'DTUSER').slice(0, 8));
      const signed = this.parseAmount(tag(block, 'TRNAMT'));
      if (!date || !signed) { this.errors.push(`Transaction ${index + 1}: missing date or amount`); return; }
      const name = decode(tag(block, 'NAME') || tag(block, 'PAYEE'));
      const memo = decode(tag(block, 'MEMO'));
      const description = this.cleanString(name && memo && !name.toUpperCase().includes(memo.toUpperCase()) && memo.length < 80 ? `${name} ${memo}` : name || memo) || 'Unknown';
      parsed.push({ date, description, amount: Math.round(Math.abs(signed) * 100) / 100, direction: signed < 0 ? 'DEBIT' : 'CREDIT', balance: null });
    });
    if (!blocks.length) this.errors.push('No transactions were found in this OFX/QFX file');
    if (parsed.length && balance !== null) parsed.at(-1).balance = balance;
    this.format = { kind: 'ofx', header: true, signConvention: 'negative-is-spending', columns: {} };
    return this.finish(parsed, isCard ? 'credit_card' : accountType, 'OFX Import');
  }
}

const INFLOW_TEXT = /\b(?:payroll|direct dep(?:osit)?|dir dep|salary|deposit|refund|payment\s*-?\s*thank\s*you|thank\s*you|autopay payment|online payment|internet payment|mobile pa?y?me?n?t|pymt|interest (?:paid|earned)|cash ?back|reward)\b/i;
const CARD_PAYMENT_TEXT = /\b(?:payment|pymt|pmt|thank\s*you|autopay|auto\s*pay|ach credit)\b/i;

/**
 * Generate bulletproof SQL INSERT statements
 */
function generateInsertSQL(transactions) {
  const statements = [];
  let errorCount = 0;

  for (const txn of transactions) {
    try {
      // Escape single quotes in strings
      const date = txn.date.replace(/'/g, "''");
      const description = txn.description.replace(/'/g, "''");
      const category = txn.category.replace(/'/g, "''");
      const source = (txn.source || '').replace(/'/g, "''");

      const sql = `INSERT INTO transactions (date, description, category, amount, direction, balance, source, user_id) VALUES ('${date}', '${description}', '${category}', ${txn.amount}, '${txn.direction}', ${txn.balance !== null ? txn.balance : 'NULL'}, '${source}', 1);`;

      statements.push({
        sql,
        transaction: txn,
        valid: true
      });
    } catch (err) {
      errorCount++;
      statements.push({
        sql: null,
        transaction: txn,
        valid: false,
        error: err.message
      });
    }
  }

  return { statements, errorCount };
}

export {
  TransactionCSVParser,
  categorizeTransaction,
  generateInsertSQL
};
