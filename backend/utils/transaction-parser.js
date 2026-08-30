/**
 * BULLETPROOF Transaction Parser
 * Handles CSV parsing with automatic column detection, deduplication, and categorization
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
 * Parse CSV with flexible column detection
 * Handles any CSV format by detecting column names
 */
class TransactionCSVParser {
  constructor() {
    this.transactions = [];
    this.errors = [];
    this.columnMap = {};
  }

  /**
   * Detect CSV columns by looking at header row
   * @param {string} headerRow - First row of CSV
   * @returns {Object} Map of column names to indices
   */
  detectColumns(headerRow) {
    const columns = headerRow.split(',').map(c => c.trim().toLowerCase());
    
    const map = {
      date: columns.findIndex(c => c.includes('date')),
      description: columns.findIndex(c => 
        c.includes('description') || c.includes('memo') || c.includes('narration')
      ),
      amount: columns.findIndex(c => c.includes('amount') || c.includes('debit') || c.includes('credit')),
      debit: columns.findIndex(c => c === 'debit'),
      credit: columns.findIndex(c => c === 'credit'),
      balance: columns.findIndex(c => c.includes('balance') || c.includes('running')),
      txnType: columns.findIndex(c => 
        c.includes('type') || c.includes('transaction') || c.includes('tran type')
      ),
      checkNumber: columns.findIndex(c => c.includes('check')),
      accountNumber: columns.findIndex(c => c.includes('account')),
      rtn: columns.findIndex(c => c.includes('rtn')),
    };

    return map;
  }

  /**
   * Parse a single transaction row
   * @param {string} row - CSV row
   * @param {Object} columnMap - Column mapping
   * @returns {Object|null} Parsed transaction or null if invalid
   */
  parseRow(row, columnMap) {
    try {
      const fields = this.parseCSVRow(row);
      
      if (fields.length < 2) return null;

      // Extract fields using column map
      const date = fields[columnMap.date]?.trim();
      const description = fields[columnMap.description]?.trim();
      let amount = fields[columnMap.amount]?.trim();
      const debit = fields[columnMap.debit]?.trim();
      const credit = fields[columnMap.credit]?.trim();
      const balance = fields[columnMap.balance]?.trim();
      const txnType = fields[columnMap.txnType]?.trim() || 'DEBIT';

      // Validate date
      if (!date || !this.isValidDate(date)) {
        return null;
      }

      // If amount field is empty, use debit/credit fields
      if (!amount) {
        if (debit && debit !== '') {
          amount = debit;
        } else if (credit && credit !== '') {
          amount = credit;
        }
      }

      // Parse amount
      let parsedAmount = this.parseAmount(amount);
      if (parsedAmount === null) {
        return null;
      }

      // Determine transaction direction
      let direction = 'DEBIT';
      if (credit && credit !== '') {
        direction = 'CREDIT';
      } else if (txnType === 'CREDIT') {
        direction = 'CREDIT';
      }

      // Parse balance
      let parsedBalance = balance ? this.parseAmount(balance) : null;

      // Parse description (handle special characters)
      const cleanDescription = this.cleanString(description || 'Unknown');

      // Auto-categorize
      const category = categorizeTransaction(cleanDescription, direction);

      return {
        date,
        description: cleanDescription,
        category,
        amount: Math.abs(parsedAmount), // Store as absolute value
        direction,
        balance: parsedBalance,
        source: 'TD Bank CSV Import',
        type: txnType
      };
    } catch (err) {
      log('PARSER', `Row parse error: ${err.message}`);
      return null;
    }
  }

  /**
   * Parse CSV row handling quoted fields
   */
  parseCSVRow(row) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < row.length; i++) {
      const char = row[i];
      const nextChar = row[i + 1];

      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current);
    return result;
  }

  /**
   * Validate date format (YYYY-MM-DD or MM/DD/YYYY)
   */
  isValidDate(dateStr) {
    // Try YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const d = new Date(dateStr);
      return !isNaN(d.getTime());
    }

    // Try MM/DD/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
      const parts = dateStr.split('/');
      const d = new Date(parts[2], parts[0] - 1, parts[1]);
      return !isNaN(d.getTime());
    }

    return false;
  }

  /**
   * Parse amount, handling currency and negative values
   */
  parseAmount(amountStr) {
    if (!amountStr || amountStr === '') return null;

    // Remove currency symbols and whitespace
    let cleaned = amountStr
      .replace(/[$,]/g, '')
      .replace(/\s/g, '')
      .trim();

    if (cleaned === '' || cleaned === '-') return null;

    const num = parseFloat(cleaned);
    if (isNaN(num)) return null;

    return num;
  }

  /**
   * Clean string: handle special characters, escape quotes
   */
  cleanString(str) {
    if (!str) return '';

    return str
      .replace(/^\s+|\s+$/g, '') // Trim
      .replace(/\s+/g, ' ')       // Normalize spaces
      .substring(0, 500);         // Max length
  }

  /**
   * Parse CSV content and return transactions
   */
  parse(csvContent, sourceFile = 'Unknown') {
    const lines = csvContent.split('\n').map(l => l.trim()).filter(l => l);
    
    if (lines.length < 2) {
      this.errors.push(`CSV has less than 2 lines (${lines.length})`);
      return { transactions: [], errors: this.errors, duplicates: 0 };
    }

    // Detect columns from header
    this.columnMap = this.detectColumns(lines[0]);

    log('PARSER', `Detected columns: ${JSON.stringify(this.columnMap)}`);
    log('PARSER', `Processing ${lines.length - 1} transaction rows from ${sourceFile}`);

    const seenTransactions = new Set();
    let duplicateCount = 0;

    // Parse each row
    for (let i = 1; i < lines.length; i++) {
      const txn = this.parseRow(lines[i], this.columnMap);

      if (txn) {
        // Create a unique key for deduplication
        const dupKey = `${txn.date}|${txn.description}|${txn.amount}|${txn.direction}`;

        if (seenTransactions.has(dupKey)) {
          duplicateCount++;
          log('PARSER', `Duplicate detected: ${txn.description} on ${txn.date}`);
          continue;
        }

        seenTransactions.add(dupKey);
        this.transactions.push(txn);
      } else {
        this.errors.push(`Failed to parse row ${i + 1}: ${lines[i].substring(0, 50)}`);
      }
    }

    log('PARSER', `✓ Parsed ${this.transactions.length} transactions, ${duplicateCount} duplicates within file, ${this.errors.length} errors`);

    return {
      transactions: this.transactions,
      errors: this.errors,
      duplicates: duplicateCount
    };
  }
}

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
