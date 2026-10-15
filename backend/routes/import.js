import express from 'express';
import Database from '../db.js';
import { TransactionCSVParser } from '../utils/transaction-parser.js';
import PDFParser from '../utils/pdfParser.js';
import { normalizeDescription } from '../utils/normalize.js';
import { TENANT, classify, loadCategorization, failure } from '../utils/categorization.js';

const router = express.Router();
const db = new Database();
const route = handler => async (req, res) => {
  try { await handler(req, res); } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message });
  }
};

async function parseFile({ type, data, source, statementType }) {
  if (typeof data !== 'string' || !data.trim()) throw failure(400, 'File data is required');
  if (type === 'csv') {
    const result = new TransactionCSVParser().parse(data.replace(/\r\n/g, '\n'), source || 'CSV Import');
    return { transactions: result.transactions, errors: result.errors, fileDuplicates: result.duplicates };
  }
  if (type === 'pdf') {
    return { transactions: await new PDFParser().parseStatement(Buffer.from(data, 'base64'), statementType || 'td-checking'), errors: [], fileDuplicates: 0 };
  }
  throw failure(400, 'File type must be csv or pdf');
}

export async function importTransactions(client, transactions, config, source) {
  let imported = 0, duplicates = 0;
  for (const transaction of transactions) {
    const direction = String(transaction.direction).toUpperCase();
    if (!['DEBIT', 'CREDIT'].includes(direction)) throw failure(400, 'Invalid transaction direction');
    const existing = (await client.query(`SELECT id FROM transactions WHERE date=$1
      AND regexp_replace(description,'[[:space:]]+',' ','g')=$2 AND amount=$3 AND direction=$4 AND ${TENANT}`,
    [transaction.date, normalizeDescription(transaction.description), transaction.amount, direction])).rows[0];
    if (existing) { duplicates++; continue; }
    const suggestion = classify({ ...transaction, direction }, config.compiled, config.names);
    // New records may inherit a user's explicit label flag. Categorization never infers a fixed flag.
    const fixed = suggestion.label?.is_fixed === true;
    await client.query(`INSERT INTO transactions
      (date,description,amount,direction,balance,source,category,label_id,is_fixed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [transaction.date, transaction.description, transaction.amount, direction, transaction.balance,
      source || transaction.source || 'import', suggestion.category, suggestion.label?.id ?? null, fixed]);
    imported++;
  }
  return { imported, duplicates, excluded: 0 };
}

router.post('/import-csv', route(async (req, res) => {
  const started = Date.now();
  const parsed = await parseFile({ type: 'csv', data: req.body?.csvData, source: req.body?.source });
  const result = await db.transaction(async client => {
    const config = await loadCategorization(client);
    return importTransactions(client, parsed.transactions, config, req.body.source || 'csv_import');
  });
  res.json({ success: true, ...result, errors: parsed.errors.length,
    parserDetails: parsed.errors.slice(0, 5), totalInFile: parsed.transactions.length, duration: Date.now() - started });
}));
router.post('/import-pdf', route(async (req, res) => {
  const started = Date.now();
  const parsed = await parseFile({ type: 'pdf', data: req.body?.pdfBase64, statementType: req.body?.statementType });
  const result = await db.transaction(async client => {
    const config = await loadCategorization(client);
    return importTransactions(client, parsed.transactions, config, req.body.source || 'pdf_import');
  });
  res.json({ success: true, ...result, totalInFile: parsed.transactions.length, duration: Date.now() - started });
}));
router.post('/import-batch', route(async (req, res) => {
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length) throw failure(400, 'No files provided');
  const parsed = [];
  for (const file of files) parsed.push(await parseFile(file));
  const results = await db.transaction(async client => {
    // One rule/category snapshot for the entire import, not one query per transaction.
    const config = await loadCategorization(client);
    const results = [];
    for (let index = 0; index < files.length; index++) {
      const result = await importTransactions(client, parsed[index].transactions, config, files[index].source);
      results.push({ ...result, type: files[index].type, fileName: files[index].source,
        totalInFile: parsed[index].transactions.length, errors: parsed[index].errors.length });
    }
    return results;
  });
  res.json({ success: true, results, totalImported: results.reduce((sum, row) => sum + row.imported, 0),
    totalDuplicates: results.reduce((sum, row) => sum + row.duplicates, 0) });
}));

export default router;
