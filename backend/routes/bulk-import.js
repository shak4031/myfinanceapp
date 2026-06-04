import express from 'express';
import { readFileSync } from 'fs';
import { log } from '../utils/logger.js';
import Database from '../db.js';

const router = express.Router();
const db = new Database();

// Execute the full SQL import script
router.post('/import-sql', async (req, res) => {
  try {
    log('IMPORT', 'Starting bulk SQL import from transactions_clean.sql...');
    
    // Read the SQL script from the app directory
    const sqlPath = new URL('../data/transactions_clean.sql', import.meta.url).pathname;
    const sqlScript = readFileSync(sqlPath, 'utf-8');
    
    // Split by semicolon and filter out empty statements
    const statements = sqlScript.split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    log('IMPORT', `Found ${statements.length} SQL statements`);
    
    let executed = 0;
    let errors = 0;
    const errorDetails = [];
    
    // Execute each statement in sequence
    for (const stmt of statements) {
      try {
        const result = await db.pool.query(stmt + ';');
        executed++;
      } catch (err) {
        log('IMPORT', `Error executing statement: ${err.message}`);
        errorDetails.push(`${err.message}`);
        errors++;
      }
    }
    
    // Get final count
    const countResult = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
    const totalCount = parseInt(countResult.rows[0].count);
    
    log('IMPORT', `✓ Import complete: ${executed} executed, ${errors} errors, ${totalCount} total transactions in database`);
    
    res.json({
      success: errors === 0,
      executed,
      errors,
      totalInDatabase: totalCount,
      message: `Import complete: ${executed} statements executed, ${totalCount} transactions in database`
    });
  } catch (err) {
    log('IMPORT', `Import failed: ${err.message}`);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

export default router;
