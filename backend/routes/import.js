import { Router } from 'express';
import Database from '../db.js';
import { log } from '../utils/logger.js';
import PDFParser from '../utils/pdfParser.js';

const router = Router();
const db = new Database();
const pdfParser = new PDFParser();

// ============================================
// CSV Import endpoint (existing)
// ============================================
router.post('/import-csv', async (req, res) => {
  try {
    log('CSV_IMPORT', 'Starting CSV import');
    
    const { csvData, source } = req.body;
    
    if (!csvData || !source) {
      log('CSV_IMPORT', '❌ Missing csvData or source');
      return res.status(400).json({ 
        success: false, 
        error: 'csvData and source required' 
      });
    }

    let csvLines = csvData
      .replace(/\r\n/g, '\n')
      .trim()
      .split('\n');
    
    log('CSV_IMPORT', `Raw CSV has ${csvLines.length} lines`);
    
    const headerLine = csvLines[0];
    const headers = parseCSVLine(headerLine).map(h => h.toLowerCase());
    log('CSV_IMPORT', `Headers detected: ${headers.join(', ')}`);
    log('CSV_IMPORT', `Processing ${csvLines.length - 1} data rows from ${source}`);

    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    for (let i = 1; i < csvLines.length; i++) {
      const row_str = csvLines[i].trim();
      if (!row_str) continue;
      
      try {
        const cols = parseCSVLine(row_str);
        const row = {};
        
        headers.forEach((header, idx) => {
          row[header] = cols[idx] || '';
        });

        const transaction = parseTransaction(row, source);
        
        if (!transaction) {
          log('CSV_IMPORT', `⚠️ Skipped invalid row ${i}`);
          continue;
        }

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
            1,
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

// ============================================
// PDF Import endpoint (NEW)
// ============================================
router.post('/import-pdf', async (req, res) => {
  try {
    log('PDF_IMPORT', 'Starting PDF import');

    const { pdfData, source, fileName } = req.body;

    if (!pdfData || !source) {
      log('PDF_IMPORT', '❌ Missing pdfData or source');
      return res.status(400).json({
        success: false,
        error: 'pdfData and source required'
      });
    }

    // Convert base64 to Buffer if necessary
    let pdfBuffer;
    if (typeof pdfData === 'string') {
      // Remove data URI prefix if present
      const base64Data = pdfData.replace(/^data:application\/pdf;base64,/, '');
      pdfBuffer = Buffer.from(base64Data, 'base64');
    } else {
      pdfBuffer = pdfData;
    }

    log('PDF_IMPORT', `Processing PDF: ${fileName || 'unknown'} (${pdfBuffer.length} bytes)`);

    // Parse PDF
    let transactions = [];
    try {
      transactions = await pdfParser.parseStatement(pdfBuffer, source);
      log('PDF_IMPORT', `✓ Extracted ${transactions.length} transactions from PDF`);
    } catch (err) {
      log('PDF_IMPORT', `❌ PDF parsing failed: ${err.message}`);
      return res.status(400).json({
        success: false,
        error: `PDF parsing failed: ${err.message}`
      });
    }

    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    // Process each transaction
    for (const transaction of transactions) {
      try {
        // Enrich transaction with categorization
        const enrichedTx = {
          ...transaction,
          category: categorizeTransaction(transaction.description),
          balance: transaction.balance || 0,
          source: source,
          user_id: 1
        };

        // Check for duplicates
        const duplicate = await db.get(
          `SELECT id FROM transactions 
           WHERE date = $1 AND description = $2 AND amount = $3 AND direction = $4`,
          [enrichedTx.date, enrichedTx.description, enrichedTx.amount, enrichedTx.direction]
        );

        if (duplicate) {
          log('PDF_IMPORT', `Duplicate found: ${enrichedTx.description} (${enrichedTx.date})`);
          duplicates++;
          continue;
        }

        // Insert transaction
        await db.run(
          `INSERT INTO transactions (date, description, category, amount, direction, balance, user_id, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            enrichedTx.date,
            enrichedTx.description,
            enrichedTx.category,
            enrichedTx.amount,
            enrichedTx.direction,
            enrichedTx.balance,
            enrichedTx.user_id,
            enrichedTx.source
          ]
        );

        imported++;
        log('PDF_IMPORT', `✓ Imported: ${enrichedTx.description} (${enrichedTx.amount})`);

      } catch (err) {
        errors++;
        log('PDF_IMPORT', `❌ Error importing transaction: ${err.message}`);
      }
    }

    log('PDF_IMPORT', `✓ Complete: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);

    res.json({
      success: true,
      imported,
      duplicates,
      errors,
      total: transactions.length,
      fileName: fileName || 'unknown'
    });

  } catch (err) {
    log('PDF_IMPORT', `❌ PDF import failed: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================
// Multi-file batch import endpoint
// ============================================
router.post('/import-batch', async (req, res) => {
  try {
    log('BATCH_IMPORT', 'Starting batch import');

    const { files } = req.body; // Array of {pdfData, source, fileName}

    if (!files || !Array.isArray(files) || files.length === 0) {
      log('BATCH_IMPORT', '❌ Missing files array');
      return res.status(400).json({
        success: false,
        error: 'files array required'
      });
    }

    const results = [];
    let totalImported = 0;
    let totalDuplicates = 0;
    let totalErrors = 0;

    for (const file of files) {
      try {
        const { pdfData, source, fileName } = file;

        let pdfBuffer;
        if (typeof pdfData === 'string') {
          const base64Data = pdfData.replace(/^data:application\/pdf;base64,/, '');
          pdfBuffer = Buffer.from(base64Data, 'base64');
        } else {
          pdfBuffer = pdfData;
        }

        let transactions = await pdfParser.parseStatement(pdfBuffer, source);

        let imported = 0;
        let duplicates = 0;
        let errors = 0;

        for (const transaction of transactions) {
          try {
            const enrichedTx = {
              ...transaction,
              category: categorizeTransaction(transaction.description),
              balance: transaction.balance || 0,
              source: source,
              user_id: 1
            };

            const duplicate = await db.get(
              `SELECT id FROM transactions 
               WHERE date = $1 AND description = $2 AND amount = $3 AND direction = $4`,
              [enrichedTx.date, enrichedTx.description, enrichedTx.amount, enrichedTx.direction]
            );

            if (duplicate) {
              duplicates++;
              continue;
            }

            await db.run(
              `INSERT INTO transactions (date, description, category, amount, direction, balance, user_id, source)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                enrichedTx.date,
                enrichedTx.description,
                enrichedTx.category,
                enrichedTx.amount,
                enrichedTx.direction,
                enrichedTx.balance,
                enrichedTx.user_id,
                enrichedTx.source
              ]
            );

            imported++;
          } catch (err) {
            errors++;
          }
        }

        results.push({
          fileName,
          source,
          imported,
          duplicates,
          errors,
          total: transactions.length
        });

        totalImported += imported;
        totalDuplicates += duplicates;
        totalErrors += errors;

      } catch (err) {
        log('BATCH_IMPORT', `❌ Error processing file: ${err.message}`);
        results.push({
          fileName: file.fileName,
          error: err.message
        });
      }
    }

    log('BATCH_IMPORT', `✓ Batch complete: ${totalImported} imported, ${totalDuplicates} duplicates, ${totalErrors} errors`);

    res.json({
      success: true,
      totalImported,
      totalDuplicates,
      totalErrors,
      fileResults: results
    });

  } catch (err) {
    log('BATCH_IMPORT', `❌ Batch import failed: ${err.message}`);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ============================================
// Helper Functions
// ============================================

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  result.push(current.trim());
  return result;
}

function parseTransaction(row, source) {
  try {
    if (source === 'td-checking' || source === 'td-savings') {
      const dateStr = findColumn(row, ['date', 'transaction date', 'posting date']);
      if (!dateStr) return null;
      
      const debit = parseFloat(findColumn(row, ['debit', 'withdrawal']) || 0) || 0;
      const credit = parseFloat(findColumn(row, ['credit', 'deposit']) || 0) || 0;
      
      const balance = parseFloat(
        findColumn(row, ['balance', 'account balance', 'account running balance', 'running balance']) || 0
      ) || 0;
      
      const description = findColumn(row, ['description', 'memo', 'transaction description', 'details']) || 'Unknown';
      
      const date = formatDate(dateStr);
      if (!date) return null;

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
        direction: 'debit',
        balance
      };
    }

    return null;

  } catch (err) {
    return null;
  }
}

function findColumn(row, possibleNames) {
  for (const name of possibleNames) {
    if (row[name] !== undefined && row[name] !== '' && row[name] !== null) {
      return row[name];
    }
    
    for (const key in row) {
      if (key.includes(name.toLowerCase()) && row[key] !== '' && row[key] !== null) {
        return row[key];
      }
    }
  }
  
  return null;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  
  const dateStr_trimmed = dateStr.trim();
  const parts = dateStr_trimmed.split('/');
  
  if (parts.length !== 3) {
    return null;
  }
  
  const [month, day, year] = parts;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

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
