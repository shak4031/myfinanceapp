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

const EXCLUSION_PATTERNS = [
  'Online Xfer Transfer from CK x5261',
  'Online Xfer Transfer from CK x5237'
];

function categorize(description) {
  if (!description) return 'Other';
  const desc = description.toUpperCase();

  // Handle exclusions (return null to signal exclusion)
  for (const pattern of EXCLUSION_PATTERNS) {
    if (description.includes(pattern)) {
      return null;
    }
  }

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

        const category = categorize(description);
        if (category === null) {
          log('IMPORT', `⏩ Skipping excluded transaction: ${description}`);
          continue;
        }

        const transaction = {
          date,
          description: description.trim(),
          category,
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

    /**
     * STAGE 1: LOAD INTO STAGING
     */
    const stagingResults = [];
    for (const txn of transactions) {
      try {
        await db.run(
          `INSERT INTO staging_transactions (date, description, amount, direction, balance, source, status) 
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [txn.date, txn.description, txn.amount, txn.direction, txn.balance, txn.source]
        );
        stagingResults.push(txn);
      } catch (err) {
        log('IMPORT', `✗ Staging error: ${err.message}`);
      }
    }

    /**
     * STAGE 2: PROCESS STAGING TO PRODUCTION (with Deduping)
     */
    log('IMPORT', '⚙ Processing staging to production...');
    
    // Deduplication logic: Check main table before moving from staging
    const pendingTransactions = await db.all("SELECT * FROM staging_transactions WHERE status = 'pending'");
    let imported = 0;
    let duplicates = 0;

        for (const st of pendingTransactions) {
          try {
            // Strict Deduplication: date + description + amount + direction + balance
            const existCheck = await db.pool.query(
              `SELECT id FROM transactions 
               WHERE date = $1 AND description = $2 AND amount = $3 AND direction = $4 AND (balance = $5 OR (balance IS NULL AND $5 IS NULL))`,
              [st.date, st.description, st.amount, st.direction, st.balance]
            );
    
            if (existCheck.rows.length > 0) {
              await db.run("UPDATE staging_transactions SET status = 'duplicate' WHERE id = $1", [st.id]);
              duplicates++;
              continue;
            }
    
            // Identify Label (new architectural pattern)
            const labels = await db.all("SELECT * FROM transaction_labels");
            let labelId = null;
            let category = 'Other';
            
            for (const l of labels) {
              const regex = new RegExp(l.pattern, 'i');
              if (regex.test(st.description)) {
                if (l.is_excluded) {
                  await db.run("UPDATE staging_transactions SET status = 'excluded' WHERE id = $1", [st.id]);
                  continue;
                }
                labelId = l.id;
                const catRow = await db.get("SELECT name FROM categories WHERE id = $1", [l.category_id]);
                category = catRow ? catRow.name : 'Other';
                break;
              }
            }

            // CREATIVE EXTRACTION: Auto-create label if none exists
            if (!labelId) {
                log('IMPORT', `Creating new label for: ${st.description}`);
                // Clean description for better labeling (remove dates, IDs, extra spaces)
                const cleanLabel = st.description
                    .replace(/\s+/g, ' ')
                    .replace(/\d{4,}/g, '') // remove large strings of digits
                    .trim();
                
                const catResult = await db.get("SELECT id FROM categories WHERE name = 'Other'");
                const insertLabel = await db.pool.query(
                    "INSERT INTO transaction_labels (pattern, display_label, category_id, is_fixed) VALUES ($1, $2, $3, FALSE) RETURNING id",
                    [cleanLabel, cleanLabel, catResult.id]
                );
                labelId = insertLabel.rows[0].id;
            }
    
            // Insert into Production
            await db.run(
              `INSERT INTO transactions (date, description, label_id, amount, direction, balance, source, user_id, category) 
               VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)`,
              [st.date, st.description, labelId, st.amount, st.direction, st.balance, st.source, category]
            );
    
            await db.run("UPDATE staging_transactions SET status = 'processed' WHERE id = $1", [st.id]);
            imported++;
          } catch (err) {
            log('IMPORT', `✗ Processing error: ${err.message}`);
            await db.run("UPDATE staging_transactions SET status = 'error', error_message = $1 WHERE id = $2", [err.message, st.id]);
          }
        }

    const duration = Date.now() - startTime;

    log('IMPORT', `✅ CSV import complete in ${duration}ms`);
    log('IMPORT', `  Imported: ${imported}`);
    log('IMPORT', `  Duplicates skipped: ${duplicates}`);

    // Get final count
    const countResult = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
    const totalInDb = parseInt(countResult.rows[0].count);

    res.json({
      success: imported > 0 || duplicates > 0,
      imported,
      duplicates,
      total: transactions.length,
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
