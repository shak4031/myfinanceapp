import express from 'express';
import { readFileSync } from 'fs';
import { log } from '../utils/logger.js';
import Database from '../db.js';

const router = express.Router();
const db = new Database();

// Execute the full SQL import script
router.post('/import-sql', async (req, res) => {
  try {
    log('IMPORT', 'Executing SQL import script...');
    
    // Read the SQL script
    const sqlPath = '/opt/data/import_transactions.sql';
    const sqlScript = readFileSync(sqlPath, 'utf-8');
    
    // Extract all INSERT statements
    const insertStatements = sqlScript.split('\n')
      .filter(line => line.trim().startsWith('INSERT INTO transactions'))
      .map(line => line.trim());
    
    log('IMPORT', `Found ${insertStatements.length} transaction INSERT statements`);
    
    let imported = 0;
    let errors = 0;
    
    // Execute each INSERT statement
    for (const stmt of insertStatements) {
      try {
        await db.pool.query(stmt);
        imported++;
      } catch (err) {
        // Log but continue - likely duplicate key violations which are expected
        if (!err.message.includes('duplicate key')) {
          log('IMPORT', `Error on statement: ${err.message}`);
          errors++;
        }
      }
    }
    
    // Get final count
    const countResult = await db.pool.query('SELECT COUNT(*) as count FROM transactions');
    const totalCount = countResult.rows[0].count;
    
    log('IMPORT', `✓ Import complete: ${totalCount} total transactions in database`);
    
    res.json({
      success: true,
      imported,
      errors,
      totalInDatabase: totalCount,
      message: `Successfully imported transactions. Total in database: ${totalCount}`
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
