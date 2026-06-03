import * as pdfParseModule from 'pdf-parse';
const pdfParse = pdfParseModule.default || pdfParseModule;
import { log } from './logger.js';

/**
 * PDF Parser for Bank Statements
 * Handles TD Bank, credit card, and other bank statement formats
 */
class PDFParser {
  constructor() {
    this.patterns = {
      // Date patterns: MM/DD/YYYY, DD/MM/YYYY, etc.
      date: /(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}-\d{1,2}-\d{4})/g,
      
      // Amount patterns: $1,234.56 or 1,234.56 or 1234.56
      amount: /(\$?\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g,
      
      // Transaction markers
      debit: /(?:debit|withdrawal|charge|expense)/i,
      credit: /(?:credit|deposit|payment|income)/i,
      
      // Common bank transaction keywords
      transactionKeywords: /^(TD|DEBIT|CREDIT|CHECK|ACH|TRANSFER|WIRE|PAYMENT|DEPOSIT|WITHDRAWAL)/i
    };
  }

  /**
   * Extract text from PDF buffer
   */
  async extractTextFromPDF(pdfBuffer) {
    try {
      const data = await pdfParse(pdfBuffer);
      return data.text;
    } catch (err) {
      log('PDF_PARSER', `❌ Error extracting PDF text: ${err.message}`);
      throw new Error(`PDF extraction failed: ${err.message}`);
    }
  }

  /**
   * Parse bank statement PDF into transactions
   * Supports TD Bank checking, TD Bank savings, credit card statements
   */
  async parseStatement(pdfBuffer, statementType = 'td-checking') {
    try {
      const text = await this.extractTextFromPDF(pdfBuffer);
      log('PDF_PARSER', `Extracted ${text.length} characters from PDF`);

      const transactions = [];
      const lines = text.split('\n').filter(line => line.trim());

      // Process each line to find transactions
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Skip empty lines and headers
        if (!line || this.isHeaderLine(line)) continue;

        const transaction = this.parseTransactionLine(line, statementType);
        if (transaction) {
          transactions.push(transaction);
          log('PDF_PARSER', `Parsed transaction: ${transaction.description} (${transaction.amount})`);
        }
      }

      log('PDF_PARSER', `✓ Extracted ${transactions.length} transactions from PDF`);
      return transactions;

    } catch (err) {
      log('PDF_PARSER', `❌ Error parsing statement: ${err.message}`);
      throw err;
    }
  }

  /**
   * Detect if a line is a header/footer/metadata
   */
  isHeaderLine(line) {
    const headerPatterns = [
      /^Transaction|Date|Description|Amount|Balance/i,
      /^Statement of|Account Number|Page \d+|Total/i,
      /^Period|Opening Balance|Closing Balance/i,
      /^--- --- ---/,
      /^\s*$/
    ];

    return headerPatterns.some(pattern => pattern.test(line));
  }

  /**
   * Parse a single transaction line
   * Handles various formats:
   * - Date | Description | Debit | Credit
   * - Date | Description | Amount (with direction)
   * - Date | Amount | Description | Balance
   */
  parseTransactionLine(line, statementType) {
    try {
      // Skip if line doesn't contain essential transaction markers
      if (!this.looksLikeTransaction(line)) return null;

      const transaction = {
        date: null,
        description: null,
        amount: null,
        direction: null,
        balance: null
      };

      // Extract date
      const dateMatch = line.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      if (dateMatch) {
        transaction.date = this.formatDate(dateMatch[1]);
      } else {
        // Try DD-MM-YYYY format
        const dateMatch2 = line.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
        if (dateMatch2) {
          transaction.date = `${dateMatch2[3]}-${dateMatch2[2]}-${dateMatch2[1]}`;
        }
      }

      if (!transaction.date) return null;

      // Split by common delimiters
      const parts = this.smartSplit(line);
      log('PDF_PARSER', `Line parts: ${JSON.stringify(parts.slice(0, 5))}`);

      // Extract based on statement type
      if (statementType === 'td-checking' || statementType === 'td-savings') {
        this.parseTDBankFormat(parts, transaction);
      } else if (statementType === 'credit-card') {
        this.parseCreditCardFormat(parts, transaction);
      }

      // Validate transaction
      if (transaction.date && transaction.description && transaction.amount) {
        return transaction;
      }

      return null;

    } catch (err) {
      log('PDF_PARSER', `⚠️ Error parsing line "${line}": ${err.message}`);
      return null;
    }
  }

  /**
   * Check if line looks like a transaction (has date and amount)
   */
  looksLikeTransaction(line) {
    const hasDate = /\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}-\d{1,2}-\d{4}/.test(line);
    const hasAmount = /\$?\d+\.\d{2}|\d+,\d{3}/.test(line);
    return hasDate && hasAmount;
  }

  /**
   * Smart split that respects quoted fields and decimal amounts
   */
  smartSplit(line) {
    // Replace multiple spaces with single space for splitting
    const normalized = line.replace(/\s{2,}/g, '|').trim();
    return normalized.split('|').map(s => s.trim());
  }

  /**
   * Parse TD Bank statement format
   * Format: Date | Description | Debit | Credit | Balance
   */
  parseTDBankFormat(parts, transaction) {
    // Find amounts in the line
    const amounts = this.extractAmounts(parts.join(' '));
    
    if (amounts.length === 0) return;

    // Last part might be balance
    const lastAmount = amounts[amounts.length - 1];
    const secondLastAmount = amounts[amounts.length - 2];

    // Try to identify debit vs credit
    let debitAmount = null;
    let creditAmount = null;

    // If we have multiple amounts, try to identify which is debit/credit
    if (amounts.length >= 2) {
      // Look for pattern in original line
      const lineUpper = parts.join(' ').toUpperCase();
      
      if (lineUpper.includes('DEBIT') || lineUpper.includes('WITHDRAWAL')) {
        debitAmount = secondLastAmount || amounts[0];
        transaction.direction = 'debit';
      } else if (lineUpper.includes('CREDIT') || lineUpper.includes('DEPOSIT')) {
        creditAmount = secondLastAmount || amounts[0];
        transaction.direction = 'credit';
      } else {
        // Default: treat as debit
        debitAmount = secondLastAmount || amounts[0];
        transaction.direction = 'debit';
      }

      transaction.amount = debitAmount || creditAmount;
      transaction.balance = lastAmount;
    } else if (amounts.length === 1) {
      transaction.amount = amounts[0];
      transaction.direction = 'debit';
    }

    // Extract description (everything between date and amounts)
    transaction.description = this.extractDescription(parts);
  }

  /**
   * Parse credit card statement format
   * Format: Date | Merchant | Amount | Balance
   */
  parseCreditCardFormat(parts, transaction) {
    const amounts = this.extractAmounts(parts.join(' '));

    if (amounts.length === 0) return;

    // For credit card, usually all transactions are debits (charges)
    transaction.amount = amounts[0];
    transaction.direction = 'debit';
    
    if (amounts.length > 1) {
      transaction.balance = amounts[1];
    }

    transaction.description = this.extractDescription(parts);
  }

  /**
   * Extract all amounts from text
   */
  extractAmounts(text) {
    const amountPattern = /\$?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
    const matches = [];
    let match;

    while ((match = amountPattern.exec(text)) !== null) {
      const amount = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 0) {
        matches.push(amount);
      }
    }

    return matches;
  }

  /**
   * Extract description from transaction line parts
   */
  extractDescription(parts) {
    // Filter out dates and amounts
    const description = parts
      .filter(part => {
        // Skip dates
        if (/\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}-\d{1,2}-\d{4}/.test(part)) return false;
        // Skip amounts
        if (/^\$?\d+[\d,]*\.?\d*$/.test(part)) return false;
        // Skip empty
        if (!part.trim()) return false;
        return true;
      })
      .join(' ')
      .substring(0, 100); // Limit length

    return description || 'Unknown Transaction';
  }

  /**
   * Format date from MM/DD/YYYY to YYYY-MM-DD
   */
  formatDate(dateStr) {
    if (!dateStr) return null;

    const parts = dateStr.split('/');
    if (parts.length !== 3) return null;

    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  /**
   * Parse structured table from PDF (for more reliable parsing)
   * Looks for lines with consistent column alignment
   */
  parseStructuredTable(text) {
    const lines = text.split('\n');
    const transactions = [];
    let headerLine = null;

    // Find header line (contains Date, Amount, Description, etc.)
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const line = lines[i].toLowerCase();
      if ((line.includes('date') || line.includes('transaction')) &&
          (line.includes('amount') || line.includes('debit') || line.includes('credit'))) {
        headerLine = i;
        break;
      }
    }

    if (headerLine === null) return transactions;

    // Parse data rows after header
    for (let i = headerLine + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const transaction = this.parseTransactionLine(line, 'td-checking');
      if (transaction) {
        transactions.push(transaction);
      }
    }

    return transactions;
  }
}

export default PDFParser;
