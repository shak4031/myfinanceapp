import express from 'express';
import { log } from '../utils/logger.js';
import Database from '../db.js';
import { TransactionCSVParser, categorizeTransaction } from '../utils/transaction-parser.js';
import PDFParser from '../utils/pdfParser.js';
import { normalizeDescription, dedupWhereClause } from '../utils/normalize.js';

const router = express.Router();
const db = new Database();

/**
 * UNIVERSAL IMPORT ENGINE
 * Uses TransactionCSVParser for CSV and PDFParser for PDFs
 * Handles any bank format with fuzzy column detection
 */

// Strict Exclusion List - internal transfers
const EXCLUSION_PATTERNS = [
  'Online Xfer Transfer from CK x5261',
  'Online Xfer Transfer from CK x5237',
  'Online Xfer Transfer to CK x5261',
  'Online Xfer Transfer to CK x5237',
  /x5261/i, /x5237/i
];

function isExcluded(description) {
  if (!description) return false;
  return EXCLUSION_PATTERNS.some(p => {
    if (typeof p === 'string') return description.includes(p);
    return p.test(description);
  });
}

/**
 * POST /api/import/import-csv
 * Universal CSV import using TransactionCSVParser
 */
router.post('/import-csv', async (req, res) => {
  const startTime = Date.now();
  try {
    const { csvData, source } = req.body;
    if (!csvData) return res.status(400).json({ success: false, error: 'No CSV data provided' });

    log('IMPORT', '--- STARTING UNIVERSAL CSV IMPORT ---');

    // Use the bulletproof TransactionCSVParser
    const parser = new TransactionCSVParser();

    // Normalize line endings (handles Windows \r\n)
    const normalizedCsv = csvData.replace(/\r\n/g, '\n');

    // Parse the CSV
    const result = parser.parse(normalizedCsv, source || 'CSV Import');

    log('IMPORT', `Parser result: ${result.transactions.length} parsed, ${result.duplicates} file-duplicates, ${result.errors.length} errors`);

    // Filter excluded transactions
    const validTransactions = result.transactions.filter(t => !isExcluded(t.description));
    const excludedCount = result.transactions.length - validTransactions.length;

    log('IMPORT', `After exclusions: ${validTransactions.length} transactions (${excludedCount} excluded)`);

    // Import into database
    let imported = 0;
    let duplicates = 0;

    for (const t of validTransactions) {
      // NORMALIZED DEDUP: Compare by normalized description to catch whitespace variants
      const normalized = normalizeDescription(t.description);
      const exist = await db.get(
        `SELECT id FROM transactions 
         WHERE date = $1 AND regexp_replace(description, '\\s+', ' ', 'g') = $2 
         AND amount = $3 AND direction = $4`,
        [t.date, normalized, t.amount, t.direction]
      );

      if (exist) {
        duplicates++;
        continue;
      }

      // Find matching label
      let labelId = null;
      let isFixed = false;
      try {
        const labels = await db.all("SELECT id, pattern, is_fixed FROM transaction_labels");
        for (const l of labels) {
          if (new RegExp(l.pattern, 'i').test(t.description)) {
            labelId = l.id;
            isFixed = l.is_fixed === true || l.is_fixed === 1 || l.is_fixed === 'true';
            break;
          }
        }
      } catch (e) { /* labels table might not exist yet */ }

      await db.run(
        `INSERT INTO transactions 
         (date, description, amount, direction, balance, source, user_id, category, label_id, is_fixed) 
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)`,
        [t.date, t.description, t.amount, t.direction, t.balance, source || 'csv_import', t.category, labelId, isFixed]
      );
      imported++;
    }

    const duration = Date.now() - startTime;
    log('IMPORT', `✓ CSV Import complete: ${imported} imported, ${duplicates} DB-duplicates, ${excludedCount} excluded, ${duration}ms`);

    res.json({
      success: true,
      imported,
      duplicates,
      excluded: excludedCount,
      errors: result.errors.length,
      parserDetails: result.errors.slice(0, 5), // First 5 errors for debugging
      totalInFile: result.transactions.length,
      duration
    });

  } catch (err) {
    log('IMPORT', `❌ CSV Import FAILED: ${err.message}`);
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

/**
 * POST /api/import/import-pdf
 * PDF statement import using PDFParser
 */
router.post('/import-pdf', async (req, res) => {
  const startTime = Date.now();
  try {
    const { pdfBase64, statementType, source } = req.body;
    if (!pdfBase64) return res.status(400).json({ success: false, error: 'No PDF data provided' });

    log('IMPORT', '--- STARTING PDF IMPORT ---');

    const parser = new PDFParser();

    // Decode base64 to buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    log('IMPORT', `PDF buffer size: ${pdfBuffer.length} bytes`);

    // Parse the PDF
    const transactions = await parser.parseStatement(pdfBuffer, statementType || 'td-checking');

    log('IMPORT', `PDF parsed: ${transactions.length} transactions found`);

    // Filter excluded
    const validTransactions = transactions.filter(t => !isExcluded(t.description));
    const excludedCount = transactions.length - validTransactions.length;

    // Import into database
    let imported = 0;
    let duplicates = 0;

    for (const t of validTransactions) {
      // Categorize based on description
      const category = categorizeTransaction(t.description, t.direction);

      // NORMALIZED DEDUP: Compare by normalized description to catch whitespace variants
      const normalized = normalizeDescription(t.description);
      const exist = await db.get(
        `SELECT id FROM transactions 
         WHERE date = $1 AND regexp_replace(description, '\\s+', ' ', 'g') = $2 
         AND amount = $3 AND direction = $4`,
        [t.date, normalized, t.amount, t.direction.toUpperCase()]
      );

      if (exist) {
        duplicates++;
        continue;
      }

      await db.run(
        `INSERT INTO transactions 
         (date, description, amount, direction, balance, source, user_id, category, label_id, is_fixed) 
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)`,
        [t.date, t.description, t.amount, t.direction.toUpperCase(), t.balance, source || 'pdf_import', category, null, false]
      );
      imported++;
    }

    const duration = Date.now() - startTime;
    log('IMPORT', `✓ PDF Import complete: ${imported} imported, ${duplicates} DB-duplicates, ${duration}ms`);

    res.json({
      success: true,
      imported,
      duplicates,
      excluded: excludedCount,
      totalInFile: transactions.length,
      duration
    });

  } catch (err) {
    log('IMPORT', `❌ PDF Import FAILED: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/import/import-batch
 * Batch import multiple files (CSV or PDF)
 */
router.post('/import-batch', async (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files provided' });
    }

    log('IMPORT', `--- STARTING BATCH IMPORT (${files.length} files) ---`);

    const results = [];
    let totalImported = 0;
    let totalDuplicates = 0;

    for (const file of files) {
      const { type, data, source } = file;
      let result;

      if (type === 'csv') {
        // Use the CSV import endpoint internally
        const parser = new TransactionCSVParser();
        const normalizedCsv = data.replace(/\r\n/g, '\n');
        const parsed = parser.parse(normalizedCsv, source || 'batch_import');

        let imported = 0, duplicates = 0;
        for (const t of parsed.transactions) {
          if (isExcluded(t.description)) continue;
          // NORMALIZED DEDUP
          const normalized = normalizeDescription(t.description);
          const exist = await db.get(
            `SELECT id FROM transactions 
             WHERE date = $1 AND regexp_replace(description, '\\s+', ' ', 'g') = $2 
             AND amount = $3 AND direction = $4`,
            [t.date, normalized, t.amount, t.direction]
          );
          if (exist) { duplicates++; continue; }

          let labelId = null, isFixed = false;
          try {
            const labels = await db.all("SELECT id, pattern, is_fixed FROM transaction_labels");
            for (const l of labels) {
              if (new RegExp(l.pattern, 'i').test(t.description)) {
                labelId = l.id; isFixed = l.is_fixed === true || l.is_fixed === 1;
                break;
              }
            }
          } catch (e) {}

          const category = categorizeTransaction(t.description, t.direction);
          await db.run(
            `INSERT INTO transactions (date, description, amount, direction, balance, source, user_id, category, label_id, is_fixed) 
             VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)`,
            [t.date, t.description, t.amount, t.direction, t.balance, source || 'batch_import', category, labelId, isFixed]
          );
          imported++;
        }

        result = { type: 'csv', imported, duplicates, fileName: source };
        totalImported += imported;
        totalDuplicates += duplicates;

      } else if (type === 'pdf') {
        const parser = new PDFParser();
        const pdfBuffer = Buffer.from(data, 'base64');
        const transactions = await parser.parseStatement(pdfBuffer, 'td-checking');

        let imported = 0, duplicates = 0;
        for (const t of transactions) {
          if (isExcluded(t.description)) continue;
          // NORMALIZED DEDUP
          const normalized = normalizeDescription(t.description);
          const exist = await db.get(
            `SELECT id FROM transactions 
             WHERE date = $1 AND regexp_replace(description, '\\s+', ' ', 'g') = $2 
             AND amount = $3 AND direction = $4`,
            [t.date, normalized, t.amount, t.direction.toUpperCase()]
          );
          if (exist) { duplicates++; continue; }

          const category = categorizeTransaction(t.description, t.direction);
          await db.run(
            `INSERT INTO transactions (date, description, amount, direction, balance, source, user_id, category, label_id, is_fixed) 
             VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9)`,
            [t.date, t.description, t.amount, t.direction.toUpperCase(), t.balance, source || 'batch_pdf', category, null, false]
          );
          imported++;
        }

        result = { type: 'pdf', imported, duplicates, totalInFile: transactions.length };
        totalImported += imported;
        totalDuplicates += duplicates;
      }

      results.push(result);
      log('IMPORT', `Batch file ${results.length}: ${result.type} → ${result.imported} imported, ${result.duplicates} dupes`);
    }

    log('IMPORT', `✓ Batch complete: ${totalImported} imported total`);
    res.json({ success: true, results, totalImported, totalDuplicates });

  } catch (err) {
    log('IMPORT', `❌ Batch Import FAILED: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
