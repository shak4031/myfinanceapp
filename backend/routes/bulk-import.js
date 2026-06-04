import express from 'express';
import { readFileSync } from 'fs';
import { log } from '../utils/logger.js';
import Database from '../db.js';

const router = express.Router();
const db = new Database();

/**
 * BULLETPROOF TRANSACTION IMPORT ENDPOINT
 * Handles SQL script execution with comprehensive error logging and recovery
 */

// Import transactions from SQL file
router.post('/import-sql', async (req, res) => {
  const startTime = Date.now();
  try {
    log('IMPORT', '🚀 Starting bulletproof transaction import...');
    
    // Read the SQL script from app directory
    const sqlPath = new URL('../data/import_final.sql', import.meta.url).pathname;
    log('IMPORT', `Reading SQL file: ${sqlPath}`);
    
    const sqlScript = readFileSync(sqlPath, 'utf-8');
    log('IMPORT', `✓ SQL file loaded: ${sqlScript.length} bytes`);
    
    // Parse individual statements (split by semicolon, preserve formatting)
    const statements = sqlScript
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    log('IMPORT', `Parsed ${statements.length} SQL statements`);
    
    let executed = 0;
    let errors = 0;
    const errorLog = [];
    const successStatements = [];
    
    // Execute each statement with detailed error handling
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        // Add semicolon if missing
        const fullStmt = stmt.endsWith(';') ? stmt : stmt + ';';
        
        const result = await db.pool.query(fullStmt);
        executed++;
        
        // Log DELETE and INSERT summary, not each one
        if (i === 0) {
          log('IMPORT', `✓ Statement 1: ${stmt.substring(0, 50)}... (${result.rowCount} rows affected)`);
        } else if (i === 1) {
          log('IMPORT', `✓ Statements 2-${statements.length}: INSERT statements executing...`);
        }
        
        successStatements.push(i);
      } catch (err) {
        errors++;
        const errorMsg = err.message || String(err);
        errorLog.push({
          statement: i + 1,
          error: errorMsg,
          preview: stmt.substring(0, 100)
        });
        
        // Log first few errors, then suppress
        if (errors <= 5) {
          log('IMPORT', `✗ Error on statement ${i + 1}: ${errorMsg}`);
        }
      }
    }
    
    if (errors > 5) {
      log('IMPORT', `✗ ${errors - 5} additional errors (suppressed logging)`);
    }
    
    // Get final count of transactions in database
    let totalInDatabase = 0;
    try {
      const countResult = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
      totalInDatabase = parseInt(countResult.rows[0].count, 10);
    } catch (countErr) {
      log('IMPORT', `⚠ Could not get transaction count: ${countErr.message}`);
    }
    
    const duration = Date.now() - startTime;
    const successRate = ((executed - errors) / executed * 100).toFixed(1);
    
    log('IMPORT', `✅ Import complete in ${duration}ms`);
    log('IMPORT', `  Statements executed: ${executed}`);
    log('IMPORT', `  Errors: ${errors}`);
    log('IMPORT', `  Success rate: ${successRate}%`);
    log('IMPORT', `  Total transactions in database: ${totalInDatabase}`);
    
    // Return response
    res.json({
      success: errors === 0,
      executed,
      errors,
      successRate: parseFloat(successRate),
      totalInDatabase,
      duration,
      message: errors === 0 
        ? `✅ All ${executed} statements executed successfully. ${totalInDatabase} transactions now in database.`
        : `⚠ ${executed} statements executed with ${errors} errors. ${totalInDatabase} transactions in database.`,
      errorSummary: errors > 0 ? {
        totalErrors: errors,
        sampleErrors: errorLog.slice(0, 3)
      } : null
    });
    
  } catch (err) {
    log('IMPORT', `❌ FATAL ERROR: ${err.message}`);
    log('IMPORT', `Stack: ${err.stack}`);
    
    res.status(500).json({ 
      success: false,
      error: err.message,
      type: 'FATAL_ERROR'
    });
  }
});

/**
 * CSV Upload Import - For web-based file uploads
 */
router.post('/import-csv', async (req, res) => {
  try {
    log('IMPORT', 'CSV upload requested');
    
    // This would handle multipart/form-data file uploads
    // For now, return a helpful message
    res.json({
      success: false,
      message: 'CSV file upload: implementation needed',
      instructions: 'Use POST /api/bulk-import/import-sql for immediate import'
    });
  } catch (err) {
    log('IMPORT', `CSV import error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Get import status/stats
 */
router.get('/status', async (req, res) => {
  try {
    const result = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
    const count = parseInt(result.rows[0].count, 10);
    
    res.json({
      success: true,
      transactionsInDatabase: count,
      lastImport: 'See /api/logs for import history'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
