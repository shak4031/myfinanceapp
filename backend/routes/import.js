import express from 'express';
import { log } from '../utils/logger.js';
import Database from '../db.js';

const router = express.Router();
const db = new Database();

/**
 * SMART CSV IMPORT FOR WEB UPLOADS
 * Handles TD Bank CSV files with intelligent deduplication and categorization
 */

// Category rules for smart matching
const CATEGORY_RULES = {
  'Groceries': ['GROCERY', 'SAFEWAY', 'WHOLE FOODS', 'TRADER JOE', 'INSTACART', 'WAWA', 'KROGER', 'PUBLIX'],
  'Dining': ['RESTAURANT', 'CAFE', 'CHIPOTLE', 'ROY ROGERS', 'PANERA', 'PIZZA', 'BURGER KING', 'WENDYS', 'SUBWAY', 'PANERA'],
  'Shopping': ['TARGET', 'AMAZON', 'ETSY', 'WALMART', 'COSTCO', 'KOHLS', 'PAYPAL', 'AFFIRM', 'KLARNA'],
  'Entertainment': ['CINEMA', 'NETFLIX', 'SPOTIFY', 'HULU', 'GAME', 'STEAM'],
  'Transportation': ['UBER', 'LYFT', 'TAXI', 'HYUNDAI', 'FORD', 'TESLA', 'LEASE', 'PARKING'],
  'Healthcare': ['PHARMACY', 'DOCTOR', 'HOSPITAL', 'DENTAL', 'CVS', 'WALGREENS', 'MEDICAL'],
  'Utilities': ['ELECTRIC', 'WATER', 'GAS', 'VERIZON', 'COMCAST', 'AMEREN'],
  'Insurance': ['STATE FARM', 'ALLSTATE', 'GEICO', 'INSURANCE'],
  'Subscriptions': ['SUBSCRIPTION', 'NETFLIX', 'HULU', 'SPOTIFY'],
  'Childcare': ['DAYCARE', 'SCHOOL', 'NANNY'],
  'Home': ['MORTGAGE', 'RENT', 'HOME DEPOT', 'LOWES', 'PENNYMAC', 'LEASE'],
  'Taxes': ['TAX', 'IRS'],
};

function categorize(description) {
  if (!description) return 'Other';
  const desc = description.toUpperCase();
  for (const [category, keywords] of Object.entries(CATEGORY_RULES)) {
    for (const keyword of keywords) {
      if (desc.includes(keyword)) {
        return category;
      }
    }
  }
  return 'Other';
}

/**
 * POST /api/import/import-csv
 * Import CSV file uploaded from the web interface
 */
router.post('/import-csv', async (req, res) => {
  const startTime = Date.now();
  try {
    const { csvData, source } = req.body;

    if (!csvData) {
      return res.status(400).json({ success: false, error: 'No CSV data provided' });
    }

    log('IMPORT', '📥 Processing CSV upload...');

    // Parse CSV
    const lines = csvData.trim().split('\n');
    if (lines.length < 2) {
      return res.status(400).json({ success: false, error: 'CSV file is empty or invalid' });
    }

    // Parse header row
    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim());

    log('IMPORT', `Headers detected: ${headers.join(', ')}`);

    // Find column indices with fuzzy matching
    const findColumn = (aliases) => {
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i].toLowerCase();
        for (const alias of aliases) {
          if (h.includes(alias.toLowerCase())) {
            return i;
          }
        }
      }
      return -1;
    };

    const dateCol = findColumn(['date']);
    const descCol = findColumn(['description', 'memo', 'transaction']);
    const debitCol = findColumn(['debit', 'withdrawal']);
    const creditCol = findColumn(['credit', 'deposit']);
    const balanceCol = findColumn(['balance', 'running balance']);

    if (dateCol === -1 || descCol === -1) {
      return res.status(400).json({
        success: false,
        error: 'Could not find Date and Description columns. Please use standard TD Bank CSV format.'
      });
    }

    log('IMPORT', `Column mapping: date=${dateCol}, desc=${descCol}, debit=${debitCol}, credit=${creditCol}, balance=${balanceCol}`);

    // Parse transactions
    const transactions = [];
    const errors = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const cols = line.split(',').map(c => c.trim());

        const date = cols[dateCol];
        const description = cols[descCol];
        const debitStr = debitCol >= 0 ? cols[debitCol] : '';
        const creditStr = creditCol >= 0 ? cols[creditCol] : '';
        const balanceStr = balanceCol >= 0 ? cols[balanceCol] : '';

        // Skip empty rows
        if (!date || !description) continue;

        // Parse amounts
        const debitAmount = debitStr ? parseFloat(debitStr) : 0;
        const creditAmount = creditStr ? parseFloat(creditStr) : 0;

        // Determine direction and amount
        let amount = 0;
        let direction = 'DEBIT';

        if (creditAmount > 0) {
          amount = creditAmount;
          direction = 'CREDIT';
        } else if (debitAmount > 0) {
          amount = debitAmount;
          direction = 'DEBIT';
        } else {
          continue; // Skip transactions with no amount
        }

        // Parse balance
        const balance = balanceStr ? parseFloat(balanceStr) : null;

        // Detect account source from source parameter or description
        let accountSource = 'checking';
        if (source && source.includes('savings')) {
          accountSource = 'savings';
        }

        const transaction = {
          date,
          description: description.trim(),
          category: categorize(description),
          amount,
          direction,
          balance,
          source: accountSource,
          user_id: 1
        };

        transactions.push(transaction);
      } catch (err) {
        errors.push({ line: i, error: err.message });
        if (errors.length <= 5) {
          log('IMPORT', `⚠ Parse error on line ${i}: ${err.message}`);
        }
      }
    }

    log('IMPORT', `✓ Parsed ${transactions.length} transactions from CSV`);

    if (transactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: `No valid transactions found in CSV. Parsed ${errors.length} errors.`,
        sampleErrors: errors.slice(0, 3)
      });
    }

    // Check for duplicates and insert
    let imported = 0;
    let duplicates = 0;
    const insertErrors = [];

    for (const txn of transactions) {
      try {
        // Check if transaction already exists (by date, description, amount)
        const existCheck = await db.pool.query(
          `SELECT id FROM transactions 
           WHERE date = $1 AND description = $2 AND amount = $3 AND direction = $4`,
          [txn.date, txn.description, txn.amount, txn.direction]
        );

        if (existCheck.rows.length > 0) {
          duplicates++;
          continue;
        }

        // Insert new transaction
        const result = await db.pool.query(
          `INSERT INTO transactions (date, description, category, amount, direction, balance, source, user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [txn.date, txn.description, txn.category, txn.amount, txn.direction, txn.balance, txn.source, txn.user_id]
        );

        if (result.rows.length > 0) {
          imported++;
        }
      } catch (err) {
        insertErrors.push({ transaction: txn.description, error: err.message });
        if (insertErrors.length <= 3) {
          log('IMPORT', `✗ Insert error: ${err.message}`);
        }
      }
    }

    const duration = Date.now() - startTime;

    log('IMPORT', `✅ CSV import complete in ${duration}ms`);
    log('IMPORT', `  Imported: ${imported}`);
    log('IMPORT', `  Duplicates skipped: ${duplicates}`);
    log('IMPORT', `  Insert errors: ${insertErrors.length}`);

    // Get final count
    const countResult = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
    const totalInDb = parseInt(countResult.rows[0].count);

    res.json({
      success: imported > 0,
      imported,
      duplicates,
      total: transactions.length,
      errors: insertErrors.length,
      totalInDatabase: totalInDb,
      duration,
      message: `Imported ${imported} new transactions (${duplicates} duplicates skipped). Total in database: ${totalInDb}`
    });

  } catch (err) {
    log('IMPORT', `❌ CSV import failed: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message,
      type: 'CSV_IMPORT_ERROR'
    });
  }
});

/**
 * GET /api/import/status
 * Get import status and statistics
 */
router.get('/status', async (req, res) => {
  try {
    const result = await db.pool.query(
      'SELECT COUNT(*) as total, COUNT(DISTINCT category) as categories FROM transactions'
    );

    const row = result.rows[0];

    res.json({
      success: true,
      transactionsInDatabase: parseInt(row.total),
      uniqueCategories: parseInt(row.categories),
      status: 'ready'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
