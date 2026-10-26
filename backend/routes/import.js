import express from 'express';
import Database from '../db.js';
import { TransactionCSVParser } from '../utils/transaction-parser.js';
import PDFParser from '../utils/pdfParser.js';
import { failure } from '../utils/categorization.js';
import { importTransactions, loadImportCategorization } from '../utils/transactionImport.js';

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

export { importTransactions };

router.post('/import-csv', route(async (req, res) => {
  const started = Date.now();
  const parsed = await parseFile({ type: 'csv', data: req.body?.csvData, source: req.body?.source });
  const result = await db.transaction(async client => {
    const config = await loadImportCategorization(client);
    return importTransactions(client, parsed.transactions, config, req.body.source || 'csv_import');
  });
  res.json({ success: true, ...result, errors: parsed.errors.length,
    parserDetails: parsed.errors.slice(0, 5), totalInFile: parsed.transactions.length, duration: Date.now() - started });
}));
router.post('/import-pdf', route(async (req, res) => {
  const started = Date.now();
  const parsed = await parseFile({ type: 'pdf', data: req.body?.pdfBase64, statementType: req.body?.statementType });
  const result = await db.transaction(async client => {
    const config = await loadImportCategorization(client);
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
    const config = await loadImportCategorization(client);
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
