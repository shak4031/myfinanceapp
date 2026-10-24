import express from 'express';
import Database from '../db.js';
import { TransactionCSVParser } from '../utils/transaction-parser.js';
import PDFParser from '../utils/pdfParser.js';
import { normalizeDescription } from '../utils/normalize.js';
import { TENANT, classify, loadCategorization, failure } from '../utils/categorization.js';
import { inheritPayMode } from '../utils/payMode.js';
import { incomeKey } from '../utils/income.js';
import { compileNameRules, loadNameRules, resolveName } from '../utils/naming.js';
import { currentUserId } from '../utils/tenant.js';
import { reconcileTransfers } from '../utils/transfers.js';
import { resolveImportAccount, resolveStatementAccount } from './accounts.js';
import { recordAudit, structuredLog } from '../utils/audit.js';
import { beginImport, finishImport, lockImports, importHistory, reviewImports, commitImports } from '../utils/importHistory.js';

const router = express.Router();
const db = new Database();
const route = handler => async (req, res) => {
  const started = Date.now();
  const format = req.path === '/import-pdf' ? 'pdf' : req.path === '/import-csv' ? 'csv-ofx' : 'batch';
  const diagnostic = { format, fileCount: format === 'batch' && Array.isArray(req.body?.files) ? req.body.files.length : 1 };
  let result, failed;
  const json = res.json.bind(res);
  res.json = body => { result = body; return json({ ...body, requestId: req.id }); };
  req.importStage = 'validation';
  structuredLog('info', { event: 'import.started', requestId: req.id, subject: currentUserId(), ...diagnostic });
  try {
    await handler(req, res);
  } catch (error) {
    failed = error;
    res.status(error.status || 500).json({ success: false, error: error.message,
      ...(error.code === 'ACCOUNT_REVIEW_REQUIRED' ? { code: error.code, detectedAccount: error.detectedAccount } : {}) });
  }
  const status = res.statusCode;
  const rows = result?.results || (result?.success ? [result] : []);
  const detail = {
    ...diagnostic, stage: req.importStage, durationMs: Date.now() - started,
    reason: failed ? ['ACCOUNT_REVIEW_REQUIRED', 'PDF_REVIEW_REQUIRED'].includes(failed.code) ? failed.code : status < 500 ? 'INPUT_REJECTED' : 'PROCESSING_FAILED' : null,
    parsedRows: rows.length ? rows.reduce((sum, row) => sum + (row.totalInFile || 0), 0) : req.importParsedRows || 0,
    importedRows: rows.reduce((sum, row) => sum + (row.imported || 0), 0),
    duplicateRows: rows.reduce((sum, row) => sum + (row.duplicates || 0), 0),
    unreadableRows: rows.reduce((sum, row) => sum + (row.errors || 0), 0),
    warningCount: rows.reduce((sum, row) => sum + (row.warnings?.length || 0), 0),
    committed: !failed && !!result?.success
  };
  structuredLog(failed ? status >= 500 ? 'error' : 'warn' : 'info', {
    event: 'import.result', requestId: req.id, status,
    message: `${format} import ${failed ? 'failed' : 'completed'} at ${detail.stage}; reason=${detail.reason || 'OK'}; files=${detail.fileCount}; parsed=${detail.parsedRows}; imported=${detail.importedRows}; duplicates=${detail.duplicateRows}; unreadable=${detail.unreadableRows}; warnings=${detail.warningCount}; committed=${detail.committed}; durationMs=${detail.durationMs}`
  });
  const fileNames = Array.isArray(req.body?.files)
    ? req.body.files.slice(0, 20).map(file => String(file?.source || '').slice(0, 200)).filter(Boolean)
    : undefined;
  await recordAudit(req, failed ? 'import.failed' : 'import.completed', failed ? status >= 500 ? 'error' : 'failure' : 'success', {
    status, detail: { ...detail, fileName: req.body?.source, fileNames }
  });
};
const stage = (req, name, detail = {}) => {
  req.importStage = name;
  structuredLog('info', { event: 'import.stage', requestId: req.id, subject: currentUserId(), stage: name, message: `Import stage: ${name}`, ...detail });
};

const ACCOUNT_TYPES = new Set(['checking', 'savings', 'credit_card']);
// Parser sign conventions only distinguish cards from deposit accounts.
const PARSER_TYPE = { checking: 'checking', savings: 'savings', credit_card: 'credit_card', loan: 'credit_card', investment: 'savings', crypto: 'savings', other: 'checking', unknown: 'checking' };

async function parseFile({ type, data, source, accountType }) {
  if (typeof data !== 'string' || !data.trim()) throw failure(400, 'File data is required');
  if (type === 'csv' || type === 'ofx') {
    const account = ACCOUNT_TYPES.has(accountType) ? accountType : ACCOUNT_TYPES.has(source) ? source : null;
    const result = new TransactionCSVParser().parse(data, source || 'CSV Import', { accountType: account });
    if (!result.transactions.length) {
      throw failure(422, `No transactions could be read from this file. ${result.errors[0] ? `${result.errors[0]}. ` : ''}Export a CSV with date, description and amount (or debit and credit) columns, or an OFX/QFX file, from your bank's website.`);
    }
    return { transactions: result.transactions, errors: result.errors, fileDuplicates: result.duplicates, skipped: result.skipped, format: result.format };
  }
  if (type === 'pdf') {
    if (data.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) throw failure(400, 'Invalid PDF upload. Choose a PDF no larger than 12 MB.');
    return new PDFParser().parseDocument(Buffer.from(data, 'base64'));
  }
  throw failure(400, 'File type must be csv or pdf');
}

export async function importTransactions(client, transactions, config, source, accountId = null, { preserveOccurrences = false, batchId = null } = {}) {
  let imported = 0, duplicates = 0;
  const occurrences = new Map();
  // One snapshot of bills with a known pay mode, newest first, so repeat payments inherit it.
  const payHistory = (await client.query(`SELECT id,description,label_id,pay_mode FROM transactions
    WHERE ${TENANT} AND pay_mode IS NOT NULL AND UPPER(direction)='DEBIT' ORDER BY date DESC, id DESC LIMIT 2000`)).rows;
  const incomeHistory = (await client.query(`SELECT description,income_role FROM transactions
    WHERE ${TENANT} AND income_role IS NOT NULL AND UPPER(direction)='CREDIT' ORDER BY date DESC, id DESC LIMIT 2000`)).rows
    .map(row => ({ key: incomeKey(row.description), role: row.income_role }));
  const nameRules = compileNameRules(await loadNameRules(client));
  for (const transaction of transactions) {
    const direction = String(transaction.direction).toUpperCase();
    if (!['DEBIT', 'CREDIT'].includes(direction)) throw failure(400, 'Invalid transaction direction');
    // Compare dates by value: older imports stored MM/DD/YYYY text, new ones store ISO dates.
    const description = normalizeDescription(transaction.description);
    const key = JSON.stringify([transaction.date, description, transaction.amount, direction]);
    const occurrence = preserveOccurrences ? occurrences.get(key) || 0 : 0;
    occurrences.set(key, occurrence + 1);
    const existing = (await client.query(`SELECT id FROM transactions WHERE date::date=$1::date
      AND UPPER(BTRIM(regexp_replace(description,'[[:space:]]+',' ','g')))=$2 AND amount=$3 AND direction=$4
      AND account_id IS NOT DISTINCT FROM $5 AND ${TENANT} ORDER BY id LIMIT 1 OFFSET $6`,
    [transaction.date, description, transaction.amount, direction, accountId, occurrence])).rows[0];
    if (existing) { duplicates++; continue; }
    const classified = classify({ ...transaction, direction }, config.compiled, config.names);
    // Parser hints (e.g. a card payment is a transfer) apply unless the user has a rule for this merchant.
    const suggestion = transaction.categoryHint && !classified.ruleId && config.names.has(transaction.categoryHint)
      ? { ...classified, category: transaction.categoryHint } : classified;
    // New records may inherit a user's explicit label flag. Categorization never infers a fixed flag.
    const fixed = suggestion.label?.is_fixed === true;
    const payMode = inheritPayMode({ ...transaction, direction, label_id: suggestion.label?.id ?? null }, payHistory);
    const incomeRole = direction === 'CREDIT' ? incomeHistory.find(row => row.key === incomeKey(transaction.description))?.role ?? null : null;
    await client.query(`INSERT INTO transactions
      (date,description,amount,direction,balance,source,category,label_id,is_fixed,pay_mode,income_role,account_id,display_name,import_batch_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [transaction.date, transaction.description, transaction.amount, direction, transaction.balance,
      source || transaction.source || 'import', suggestion.category, suggestion.label?.id ?? null, fixed, payMode, incomeRole, accountId,
      resolveName(transaction.description, nameRules)?.name ?? null, batchId]);
    imported++;
  }
  return { imported, duplicates, excluded: 0 };
}

// Imports are tied to an account so transfers between your own accounts can be recognised and left out of totals.
async function importInto(client, body, parsed, config, fallbackSource, req) {
  stage(req, 'account-resolution');
  const account = parsed.statement ? await resolveStatementAccount(client, body, parsed.statement) : await resolveImportAccount(client, body);
  validateCsvAccount(parsed, account);
  stage(req, 'saving');
  const source = body.source || fallbackSource || 'import';
  const batchId = await beginImport(client, source, account);
  await saveStatement(client, account, parsed.statement);
  const result = await importTransactions(client, parsed.transactions, config, source, account.id, { preserveOccurrences: !!parsed.statement, batchId });
  await finishImport(client, batchId, result);
  return { ...result, batchId, account: { id: account.id, name: account.name, kind: account.kind, last4: account.last4 } };
}
function validateCsvAccount(parsed, account) {
  if (parsed.format?.accountCount > 1) throw failure(422, 'This CSV contains multiple accounts. Export each account separately and import it into its matching account. Nothing was imported.');
  const last4 = parsed.format?.accountLast4?.[0];
  if (last4 && account.last4 && last4 !== account.last4) throw failure(422, `This CSV is for account ending ${last4}, not the selected account. Choose the matching account. Nothing was imported.`);
}
async function saveStatement(client, account, statement) {
  if (!statement) return;
  const card = statement.type === 'credit-card';
  if ((card && account.kind !== 'credit_card') || (!card && !['checking', 'savings'].includes(account.kind))) {
    throw failure(422, `This PDF was detected as a ${card ? 'credit card' : 'bank'} statement. Choose ${card ? 'a credit card' : 'a checking or savings'} account and retry. Nothing was imported.`);
  }
  if (statement.last4 && account.last4 && statement.last4 !== account.last4) throw failure(422, 'The statement account ending does not match the selected account. Choose the correct account. Nothing was imported.');
  const saved = await client.query(`UPDATE accounts SET statement=$1::jsonb, last4=COALESCE(last4,$2), updated_at=NOW()
    WHERE id=$3 AND user_id=$4 AND (statement IS NULL OR statement->>'closingDate' <= $5) RETURNING id`,
  [JSON.stringify(statement), statement.last4, account.id, currentUserId(), statement.closingDate]);
  if (!saved.rowCount) {
    // Historical statements still import transactions; they must not replace newer balance/rate evidence.
    return;
  }
  account.last4 ||= statement.last4;
}
const pdfDetails = parsed => parsed.statement ? { statement: parsed.statement, reconciliation: parsed.reconciliation, warnings: parsed.warnings } : {};
const summarize = transfers => ({ transfersChecked: transfers.changed, accountsDiscovered: transfers.discovered });
// Fail fast (before parsing) when no account is given, so the user is not left waiting on a large file.
const requireAccountChoice = body => {
  if ((body?.accountId == null || body.accountId === '') && !body?.newAccount) throw failure(400, 'Choose which account this statement is from (accountId or newAccount is required)');
};

router.get('/history', async (req, res, next) => {
  try { res.json(await db.transaction(importHistory)); } catch (error) { next(error); }
});
router.post('/history/review', async (req, res, next) => {
  try { res.json(await db.transaction(client => reviewImports(client, req.body?.ids, req.body?.action))); }
  catch (error) { next(error); }
});
router.post('/history/:action', async (req, res, next) => {
  try {
    if (req.body?.acknowledged !== true) throw failure(400, 'Acknowledge the reviewed impact before confirming.');
    const result = await db.transaction(client => commitImports(client, req.body?.ids, req.params.action, req.body?.reviewToken));
    await recordAudit(req, `import.${req.params.action}`, 'success',
      { detail: { batchCount: result.batches, affectedRows: result.affected } });
    res.json(result);
  } catch (error) {
    await recordAudit(req, 'import.recovery.failed', 'failure',
      { status: error.status || 500, detail: { action: req.params.action } });
    next(error);
  }
});

router.post('/import-csv', route(async (req, res) => {
  const started = Date.now();
  requireAccountChoice(req.body);
  const accountType = req.body.accountType || req.body.newAccount?.kind;
  const result = await db.transaction(async client => {
    await lockImports(client);
    stage(req, 'account-resolution');
    const account = await resolveImportAccount(client, req.body);
    stage(req, 'parsing');
    const parsed = await parseFile({ type: 'csv', data: req.body?.csvData, source: req.body?.source, accountType: PARSER_TYPE[account.kind] || accountType });
    validateCsvAccount(parsed, account);
    req.importParsedRows = parsed.transactions.length;
    stage(req, 'saving', { parsedRows: parsed.transactions.length, unreadableRows: parsed.errors.length });
    const config = await loadCategorization(client);
    const source = req.body.source || 'csv_import';
    const batchId = await beginImport(client, source, account);
    const imported = await importTransactions(client, parsed.transactions, config, source, account.id, { batchId });
    await finishImport(client, batchId, imported);
    stage(req, 'transfer-reconciliation');
    const transfers = await reconcileTransfers(client, currentUserId());
    return { parsed, imported: { ...imported, batchId, account: { id: account.id, name: account.name, kind: account.kind, last4: account.last4 }, ...summarize(transfers) } };
  });
  const { parsed } = result;
  stage(req, 'committed');
  res.json({ success: true, ...result.imported, errors: parsed.errors.length, skipped: parsed.skipped, format: parsed.format,
    parserDetails: parsed.errors.slice(0, 5), totalInFile: parsed.transactions.length, duration: Date.now() - started });
}));
router.post('/import-pdf', route(async (req, res) => {
  const started = Date.now();
  stage(req, 'parsing');
  const parsed = await parseFile({ type: 'pdf', data: req.body?.pdfBase64 });
  req.importParsedRows = parsed.transactions.length;
  stage(req, 'parsed', { parsedRows: parsed.transactions.length, statementType: parsed.statement.type, balanced: parsed.reconciliation.status === 'balanced', warningCount: parsed.warnings.length });
  const result = await db.transaction(async client => {
    await lockImports(client);
    const config = await loadCategorization(client);
    const imported = await importInto(client, req.body, parsed, config, 'pdf_import', req);
    stage(req, 'transfer-reconciliation');
    return { ...imported, ...summarize(await reconcileTransfers(client, currentUserId())) };
  });
  stage(req, 'committed');
  res.json({ success: true, ...result, ...pdfDetails(parsed), totalInFile: parsed.transactions.length, duration: Date.now() - started });
}));
router.post('/import-batch', route(async (req, res) => {
  const files = req.body?.files;
  if (!Array.isArray(files) || !files.length) throw failure(400, 'No files provided');
  // Each file names its own account; a top-level accountId/newAccount applies to files that do not.
  const choices = files.map(file => (file?.accountId != null || file?.newAccount ? file : { ...file, accountId: req.body.accountId, newAccount: req.body.newAccount }));
  choices.forEach((choice, index) => { if (files[index]?.type !== 'pdf') requireAccountChoice(choice); });
  const parsed = [];
  for (const [index, file] of files.entries()) {
    stage(req, 'parsing', { fileIndex: index + 1 });
    const result = await parseFile(file);
    parsed.push(result);
    req.importParsedRows = (req.importParsedRows || 0) + result.transactions.length;
  }
  const results = await db.transaction(async client => {
    await lockImports(client);
    // One rule/category snapshot for the entire import, not one query per transaction.
    const config = await loadCategorization(client);
    const results = [];
    for (let index = 0; index < files.length; index++) {
      const result = await importInto(client, choices[index], parsed[index], config, files[index].source, req);
      results.push({ ...result, type: files[index].type, fileName: files[index].source,
        ...pdfDetails(parsed[index]), totalInFile: parsed[index].transactions.length, errors: parsed[index].errors.length });
    }
    stage(req, 'transfer-reconciliation');
    const transfers = summarize(await reconcileTransfers(client, currentUserId()));
    return results.map(result => ({ ...result, ...transfers }));
  });
  stage(req, 'committed');
  res.json({ success: true, results, totalImported: results.reduce((sum, row) => sum + row.imported, 0),
    totalDuplicates: results.reduce((sum, row) => sum + row.duplicates, 0) });
}));

export default router;
