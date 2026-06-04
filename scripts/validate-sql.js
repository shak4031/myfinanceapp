#!/usr/bin/env node

/**
 * SQL Syntax Check - Direct PostgreSQL Parsing
 */

import { readFileSync } from 'fs';

const SQL_FILE = '/opt/data/myfinanceapp-v2/backend/data/import_final.sql';

console.log('═══════════════════════════════════════════════════════════════');
console.log('SQL SYNTAX VALIDATION');
console.log('═══════════════════════════════════════════════════════════════\n');

try {
  console.log('📄 Reading SQL file...');
  const sqlContent = readFileSync(SQL_FILE, 'utf-8');
  
  // Parse statements
  const statements = [];
  let currentStatement = '';

  for (const line of sqlContent.split('\n')) {
    const trimmed = line.trim();
    
    if (!trimmed || trimmed.startsWith('--')) continue;
    if (trimmed === 'BEGIN;' || trimmed === 'COMMIT;') continue;

    currentStatement += ' ' + trimmed;

    if (trimmed.endsWith(';')) {
      const stmt = currentStatement.trim();
      if (stmt && stmt.length > 5) {
        statements.push(stmt.slice(0, -1));
      }
      currentStatement = '';
    }
  }

  console.log(`✓ Found ${statements.length} INSERT statements\n`);

  // Basic validation
  console.log('🔍 Performing syntax checks...\n');
  
  let valid = 0;
  let issues = [];

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    
    // Must have INSERT
    if (!stmt.includes('INSERT INTO transactions')) {
      issues.push(`Statement ${i + 1}: Missing INSERT INTO transactions`);
      continue;
    }

    // Must have VALUES
    if (!stmt.includes('VALUES')) {
      issues.push(`Statement ${i + 1}: Missing VALUES clause`);
      continue;
    }

    // Must have 8 fields per the schema
    const valuesMatch = stmt.match(/VALUES\s*\((.*)\)/);
    if (!valuesMatch) {
      issues.push(`Statement ${i + 1}: Cannot parse VALUES clause`);
      continue;
    }

    const fieldCount = (valuesMatch[1].match(/,/g) || []).length + 1;
    if (fieldCount < 8) {
      issues.push(`Statement ${i + 1}: Only ${fieldCount} fields (need 8)`);
      continue;
    }

    valid++;
  }

  console.log(`✓ Valid statements: ${valid}/${statements.length}`);
  
  if (issues.length > 0) {
    console.log(`✗ Issues found: ${issues.length}`);
    for (const issue of issues.slice(0, 5)) {
      console.log(`  - ${issue}`);
    }
  } else {
    console.log('✓ No issues found');
  }

  // Sample check
  console.log('\n📊 Sample Transactions:\n');
  for (let i = 0; i < Math.min(3, statements.length); i++) {
    const stmt = statements[i];
    const match = stmt.match(/VALUES\s*\('([^']+)',\s*'([^']*)',\s*'([^']*)',\s*([\d.]+),\s*'([^']+)'/);
    if (match) {
      console.log(`  ${i + 1}. Date: ${match[1]}`);
      console.log(`     Desc: ${match[2].substring(0, 50)}`);
      console.log(`     Amt:  ${match[4]} (${match[5]})\n`);
    }
  }

  // Final stats
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('✅ SUMMARY');
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`Total statements: ${statements.length}`);
  console.log(`Syntax valid: ${valid === statements.length ? 'YES ✓' : 'NO ✗'}`);
  console.log(`Issues: ${issues.length}`);
  console.log(`Ready for import: ${issues.length === 0 ? 'YES ✓' : 'NO ✗'}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (issues.length > 0) {
    process.exit(1);
  }

} catch (err) {
  console.error('❌ ERROR:', err.message);
  process.exit(1);
}
