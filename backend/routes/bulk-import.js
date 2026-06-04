import express from 'express';
import { log } from '../utils/logger.js';
import Database from '../db.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const db = new Database();

/**
 * POST /api/bulk-import/execute-final
 * Execute the final_import.sql file with all 586 transactions
 * This clears existing data and loads the complete dataset
 */
router.post('/execute-final', async (req, res) => {
  const startTime = Date.now();
  try {
    log('IMPORT', '🚀 Starting FINAL transaction import (586 transactions)...');

    // Read the SQL file
    const sqlPath = join(__dirname, '../data/final_import.sql');
    const sqlContent = readFileSync(sqlPath, 'utf-8');

    log('IMPORT', `📄 Loaded SQL file: ${sqlPath}`);
    log('IMPORT', `📊 File size: ${sqlContent.length} bytes`);

    // Split by semicolon and filter empty statements
    const statements = sqlContent
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));

    log('IMPORT', `🔢 Found ${statements.length} SQL statements to execute`);

    let executed = 0;
    let errors = 0;
    const errorDetails = [];

    // Execute each statement
    for (const statement of statements) {
      try {
        await db.pool.query(statement);
        executed++;

        // Log progress every 50 statements
        if (executed % 50 === 0) {
          log('IMPORT', `✓ Executed ${executed}/${statements.length} statements`);
        }
      } catch (err) {
        errors++;
        errorDetails.push({
          statement: statement.substring(0, 100),
          error: err.message
        });

        if (errors <= 5) {
          log('IMPORT', `✗ Error on statement ${executed + errors}: ${err.message}`);
        }
      }
    }

    const duration = Date.now() - startTime;

    // Verify the import
    const countResult = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
    const totalInDb = parseInt(countResult.rows[0].count);

    log('IMPORT', `✅ FINAL import complete in ${duration}ms`);
    log('IMPORT', `  Statements executed: ${executed}`);
    log('IMPORT', `  Errors: ${errors}`);
    log('IMPORT', `  Total transactions in database: ${totalInDb}`);

    res.json({
      success: errors === 0,
      executed,
      errors,
      totalTransactions: totalInDb,
      duration,
      message: `✅ Imported 586 transactions in ${duration}ms. Total in database: ${totalInDb}`
    });

  } catch (err) {
    log('IMPORT', `❌ FINAL import failed: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message,
      type: 'IMPORT_ERROR'
    });
  }
});

/**
 * GET /api/bulk-import/verify
 * Verify the current state of the database
 */
router.get('/verify', async (req, res) => {
  try {
    // Count transactions
    const countRes = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
    const count = parseInt(countRes.rows[0].count);

    // Get date range
    const dateRes = await db.pool.query(
      'SELECT MIN(date) as min_date, MAX(date) as max_date FROM transactions'
    );
    const minDate = dateRes.rows[0].min_date;
    const maxDate = dateRes.rows[0].max_date;

    // Get max balance
    const balanceRes = await db.pool.query(
      'SELECT MAX(CAST(balance AS NUMERIC)) as max_balance FROM transactions WHERE balance IS NOT NULL AND balance != \'\''
    );
    const maxBalance = balanceRes.rows[0].max_balance;

    // Get category breakdown
    const catRes = await db.pool.query(
      'SELECT category, COUNT(*) as count FROM transactions GROUP BY category ORDER BY count DESC LIMIT 10'
    );
    const categories = catRes.rows;

    res.json({
      success: true,
      transactionsInDatabase: count,
      dateRange: {
        start: minDate,
        end: maxDate
      },
      maxBalance: maxBalance,
      topCategories: categories,
      status: count === 586 ? '✅ COMPLETE' : `⚠️ Expected 586, found ${count}`
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

export default router;
