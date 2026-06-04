import pg from 'pg';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:BReqJQCdqDnYoydBQXGDjQuPVMjcSeEX@postgres.railway.internal:5432/railway'
});

async function executeImport() {
  try {
    console.log('🚀 Starting transaction import...');

    // Read SQL file
    const sqlPath = path.join(__dirname, 'backend/data/final_import.sql');
    const sqlContent = readFileSync(sqlPath, 'utf-8');
    console.log(`📄 Loaded SQL file: ${sqlContent.length} bytes`);

    // Split by semicolon
    const statements = sqlContent
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));

    console.log(`🔢 Found ${statements.length} statements`);

    let executed = 0;
    let errors = 0;

    // Execute statements
    for (const statement of statements) {
      try {
        await pool.query(statement);
        executed++;

        if (executed % 100 === 0) {
          console.log(`✓ Executed ${executed}/${statements.length}`);
        }
      } catch (err) {
        errors++;
        if (errors <= 3) {
          console.log(`✗ Error: ${err.message}`);
        }
      }
    }

    // Verify
    const countRes = await pool.query('SELECT COUNT(*) as count FROM transactions');
    const count = parseInt(countRes.rows[0].count);

    console.log(`✅ Import complete!`);
    console.log(`   Statements executed: ${executed}`);
    console.log(`   Errors: ${errors}`);
    console.log(`   Total transactions: ${count}`);

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Import failed:', err.message);
    await pool.end();
    process.exit(1);
  }
}

executeImport();
