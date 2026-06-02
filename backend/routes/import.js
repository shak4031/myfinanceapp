import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';

const router = Router();
const db = new Database();

// CSV Import endpoint
router.post('/import-csv', async (req, res) => {
  try {
    log('CSV_IMPORT', 'Starting CSV import');
    
    const { csvData, source } = req.body; // source: 'td-checking', 'td-savings', 'credit-card'
    
    if (!csvData || !source) {
      log('CSV_IMPORT', '❌ Missing csvData or source');
      return res.status(400).json({ 
        success: false, 
        error: 'csvData and source required' 
      });
    }

    // Parse CSV
    const lines = csvData.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    
    log('CSV_IMPORT', `Processing ${lines.length - 1} records from ${source}`);

    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    // Process each row
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};
      
      headers.forEach((header, idx) => {
        row[header] = values[idx];
      });

      try {
        // Parse the row based on source type
        const transaction = parseTransaction(row, source);
        
        if (!transaction) {
          log('CSV_IMPORT', `⚠️ Skipped invalid row ${i}`);
          continue;
        }

        // Check for duplicates using date + description + amount + direction
        const duplicate = await db.get(
          `SELECT id FROM transactions 
           WHERE date = $1 AND description = $2 AND amount = $3 AND direction = $4`,
          [transaction.date, transaction.description, transaction.amount, transaction.direction]
        );

        if (duplicate) {
          log('CSV_IMPORT', `Duplicate found: ${transaction.description} (${transaction.date})`);
          duplicates++;
          continue;
        }

        // Insert transaction
        await db.run(
          `INSERT INTO transactions (date, description, category, amount, direction, balance, user_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            transaction.date,
            transaction.description,
            transaction.category,
            transaction.amount,
            transaction.direction,
            transaction.balance,
            1, // user_id
            source
          ]
        );

        imported++;
        log('CSV_IMPORT', `✓ Imported: ${transaction.description} (${transaction.amount})`);

      } catch (err) {
        errors++;
        log('CSV_IMPORT', `❌ Error processing row ${i}: ${err.message}`);
      }
    }

    log('CSV_IMPORT', `✓ Complete: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);
    
    res.json({
      success: true,
      imported,
      duplicates,
      errors,
      total: lines.length - 1
    });

  } catch (err) {
    log('CSV_IMPORT', `❌ Import failed: ${err.message}`);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// Parse transaction from CSV row based on source
function parseTransaction(row, source) {
  try {
    if (source === 'td-checking' || source === 'td-savings') {
      // TD Bank CSV format: Date, Debit, Credit, Balance, Description
      // Example: 05/29/2026, 85.32, , 994.08, WHOLE FOODS
      
      const date = formatDate(row.date); // Convert 05/29/2026 to 2026-05-29
      const debit = parseFloat(row.debit) || 0;
      const credit = parseFloat(row.credit) || 0;
      const balance = parseFloat(row.balance) || 0;
      const description = row.description || 'Unknown';

      // Determine direction and amount
      let direction = 'debit';
      let amount = debit;

      if (credit > 0) {
        direction = 'credit';
        amount = credit;
      }

      return {
        date,
        description,
        category: categorizeTransaction(description),
        amount,
        direction,
        balance
      };

    } else if (source === 'credit-card') {
      // Credit Card CSV format: Transaction Date, Description, Amount, Running Balance
      // Example: 05/29/2026, WHOLE FOODS MARKET, 85.32, 3245.67
      
      const date = formatDate(row['transaction date'] || row.date);
      const amount = parseFloat(row.amount);
      const balance = parseFloat(row['running balance'] || row.balance) || 0;
      const description = row.description || 'Unknown';

      return {
        date,
        description,
        category: categorizeTransaction(description),
        amount,
        direction: 'debit', // Credit card purchases are debits
        balance
      };
    }

    return null;

  } catch (err) {
    log('CSV_IMPORT', `Parse error: ${err.message}`);
    return null;
  }
}

// Convert date from MM/DD/YYYY to YYYY-MM-DD
function formatDate(dateStr) {
  if (!dateStr) return null;
  
  const [month, day, year] = dateStr.split('/');
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// Auto-categorize transactions
function categorizeTransaction(description) {
  const desc = description.toUpperCase();

  if (desc.includes('PAYCHECK') || desc.includes('DEPOSIT')) return 'income';
  if (desc.includes('WHOLE FOODS') || desc.includes('COSTCO') || desc.includes('KROGER') || desc.includes('SAFEWAY')) return 'groceries';
  if (desc.includes('ELECTRIC') || desc.includes('GAS') || desc.includes('WATER')) return 'utilities';
  if (desc.includes('CHIPOTLE') || desc.includes('STARBUCKS') || desc.includes('RESTAURANT')) return 'dining';
  if (desc.includes('TARGET') || desc.includes('WALMART') || desc.includes('AMAZON')) return 'shopping';
  if (desc.includes('NETFLIX') || desc.includes('HULU') || desc.includes('SPOTIFY')) return 'entertainment';
  if (desc.includes('GAS STATION') || desc.includes('SHELL') || desc.includes('CHEVRON')) return 'transportation';
  if (desc.includes('CREDIT CARD') || desc.includes('PAYMENT')) return 'credit-card-payment';

  return 'other';
}

export default router;
