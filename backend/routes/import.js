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

    // Parse CSV - handle both Unix (\n) and Windows (\r\n) line endings
    let csvLines = csvData
      .replace(/\r\n/g, '\n') // Convert Windows line endings to Unix
      .trim()
      .split('\n');
    
    log('CSV_IMPORT', `Raw CSV has ${csvLines.length} lines`);
    
    // Parse header with proper CSV handling
    const headerLine = csvLines[0];
    const headers = parseCSVLine(headerLine).map(h => h.toLowerCase());
    log('CSV_IMPORT', `Headers detected: ${headers.join(', ')}`);
    log('CSV_IMPORT', `Processing ${csvLines.length - 1} data rows from ${source}`);

    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    // Parse data rows (skip header)
    for (let i = 1; i < csvLines.length; i++) {
      const row_str = csvLines[i].trim();
      if (!row_str) continue; // Skip empty lines
      
      try {
        // Parse CSV line into columns with proper quote handling
        const cols = parseCSVLine(row_str);
        const row = {};
        
        headers.forEach((header, idx) => {
          row[header] = cols[idx] || '';
        });

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
      total: csvLines.length - 1
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
      // Flexible TD Bank parser - finds columns by pattern matching
      
      // Find date column (looks for 'date' in any form)
      const dateStr = findColumn(row, ['date', 'transaction date', 'posting date']);
      if (!dateStr) return null;
      
      // Find debit/credit columns
      const debit = parseFloat(findColumn(row, ['debit', 'withdrawal']) || 0) || 0;
      const credit = parseFloat(findColumn(row, ['credit', 'deposit']) || 0) || 0;
      
      // Find balance column (various names)
      const balance = parseFloat(
        findColumn(row, ['balance', 'account balance', 'account running balance', 'running balance']) || 0
      ) || 0;
      
      // Find description column
      const description = findColumn(row, ['description', 'memo', 'transaction description', 'details']) || 'Unknown';
      
      const date = formatDate(dateStr);
      if (!date) return null; // Skip if date parsing failed

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
      // Flexible credit card parser
      
      const dateStr = findColumn(row, ['date', 'transaction date', 'posting date']);
      if (!dateStr) return null;
      
      const amount = parseFloat(
        findColumn(row, ['amount', 'charge', 'transaction amount']) || 0
      );
      if (!amount || isNaN(amount)) return null;
      
      const balance = parseFloat(
        findColumn(row, ['balance', 'running balance', 'available balance']) || 0
      ) || 0;
      
      const description = findColumn(row, ['description', 'merchant', 'transaction description', 'details']) || 'Unknown';
      
      const date = formatDate(dateStr);
      if (!date) return null;

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
    return null;
  }
}

// Helper: Parse CSV line handling quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  // Add final field
  result.push(current.trim());
  return result;
}

// Helper: Find a column value by matching against multiple possible names
function findColumn(row, possibleNames) {
  for (const name of possibleNames) {
    // Try exact match first
    if (row[name] !== undefined && row[name] !== '' && row[name] !== null) {
      return row[name];
    }
    
    // Try fuzzy match (partial string match)
    for (const key in row) {
      if (key.includes(name.toLowerCase()) && row[key] !== '' && row[key] !== null) {
        return row[key];
      }
    }
  }
  
  return null;
}

// Convert date from MM/DD/YYYY to YYYY-MM-DD
function formatDate(dateStr) {
  if (!dateStr) return null;
  
  const dateStr_trimmed = dateStr.trim();
  const parts = dateStr_trimmed.split('/');
  
  if (parts.length !== 3) {
    return null; // Invalid date format
  }
  
  const [month, day, year] = parts;
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
