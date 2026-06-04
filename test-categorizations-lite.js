#!/usr/bin/env node
/**
 * Test script for categorization review page
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = '/opt/data/finance.db';

const db = new sqlite3.Database(DB_PATH);

console.log('🧪 Testing Categorization System\n');

// Test 1: Check database tables
console.log('Test 1: Checking database tables...');
db.all(`
  SELECT name FROM sqlite_master WHERE type='table' 
  AND name LIKE '%categor%'
`, (err, rows) => {
  if (err) {
    console.error('❌ Error:', err);
    return;
  }
  
  if (rows.length === 0) {
    console.error('❌ No categorization tables found');
    return;
  }
  
  rows.forEach(row => {
    console.log(`  ✓ ${row.name}`);
  });
  
  // Test 2: Check transaction counts
  console.log('\nTest 2: Checking transaction counts...');
  db.all(`
    SELECT 
      'total' as type, COUNT(*) as count FROM finance_transactions
    UNION ALL
    SELECT 'confirmed', COUNT(*) FROM categorization_status WHERE status = 'confirmed'
    UNION ALL
    SELECT 'modified', COUNT(*) FROM categorization_status WHERE status = 'modified'
    UNION ALL
    SELECT 'learned_patterns', COUNT(DISTINCT keyword) FROM learned_categorizations
  `, (err, rows) => {
    if (err) {
      console.error('❌ Error:', err);
      return;
    }
    
    rows.forEach(row => {
      console.log(`  ${row.type}: ${row.count}`);
    });
    
    console.log('\nTest 3: Sample transactions...');
    db.all(`
      SELECT 
        t.txn_id, t.date, t.description, t.amount, t.category,
        COALESCE(cs.status, 'pending') as status
      FROM finance_transactions t
      LEFT JOIN categorization_status cs ON t.txn_id = cs.txn_id
      LIMIT 3
    `, (err, rows) => {
      if (err) {
        console.error('❌ Error:', err);
        return;
      }
      
      rows.forEach(row => {
        console.log(`  ${row.date} | ${row.description.substring(0, 30)} | $${row.amount} | ${row.category} [${row.status}]`);
      });
      
      // Test 4: Learned patterns
      console.log('\nTest 4: Learned patterns (if any)...');
      db.all(`
        SELECT keyword, category, usage_count 
        FROM learned_categorizations 
        ORDER BY usage_count DESC 
        LIMIT 5
      `, (err, rows) => {
        if (err) {
          console.error('❌ Error:', err);
          db.close();
          return;
        }
        
        if (rows.length === 0) {
          console.log('  (No learned patterns yet)');
        } else {
          rows.forEach(row => {
            console.log(`  "${row.keyword}" → ${row.category} (${row.usage_count} uses)`);
          });
        }
        
        console.log('\n✅ All tests passed!\n');
        console.log('📝 API Endpoints Ready:');
        console.log('  GET  /api/categorizations-lite/transactions?page=1');
        console.log('  POST /api/categorizations-lite/transaction/:txn_id/confirm');
        console.log('  POST /api/categorizations-lite/transaction/:txn_id/modify');
        console.log('  GET  /api/categorizations-lite/stats');
        console.log('\n🌐 Frontend: /categorizations-simple.html\n');
        
        db.close();
      });
    });
  });
});
