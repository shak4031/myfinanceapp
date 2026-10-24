import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { cardLines, statementPDF } from './test-fixtures/statements.js';

test('import recovery preserves exact rows, duplicates, statement facts and tenant boundaries', async t => {
  const database = new PGlite();
  let lock = Promise.resolve();
  let failReconciliation = false;
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    let release;
    const previous = lock;
    lock = new Promise(resolve => { release = resolve; });
    await previous;
    return {
      async query(sql, params) {
        if (failReconciliation && sql.startsWith('INSERT INTO categories')) throw new Error('Synthetic reconciliation failure');
        const results = params?.length ? [await database.query(sql, params)] : await database.exec(sql);
        const result = results.at(-1) || { rows: [] };
        return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
      }, release
    };
  });
  const migrate = async () => {
    const client = await pg.Pool.prototype.connect();
    try { await client.query('BEGIN'); await migratePrivateSchema(client); await client.query('COMMIT'); }
    finally { client.release(); }
  };
  await migrate();
  const env = Object.fromEntries(['OWNER_SETUP_TOKEN', 'APP_ORIGIN', 'ALLOW_REGISTRATION'].map(key => [key, process.env[key]]));
  process.env.OWNER_SETUP_TOKEN = 'test-import-recovery-setup-token-long-enough';
  process.env.ALLOW_REGISTRATION = 'true';
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  let cookie = '';
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const rows = async () => (await database.query('SELECT * FROM transactions ORDER BY id')).rows;
  const history = async () => (await call('/api/import/history')).body;
  const review = (ids, action = 'undo') => call('/api/import/history/review', { ids, action });
  const change = async (ids, action) => {
    const checked = await review(ids, action);
    if (checked.status !== 200) return checked;
    return call(`/api/import/history/${action}`, { ids, reviewToken: checked.body.reviewToken, acknowledged: true });
  };
  const undo = ids => change(ids, 'undo');
  const restore = ids => change(ids, 'restore');
  const csvData = 'Date,Account Number,Description,Debit,Credit\n2026-10-01,00001111,SAMPLE SHOP,10,\n2026-10-02,00001111,PAYMENT RECEIVED -- THANK YOU,,20';
  try {
    const owner = await call('/api/auth/setup', { name: 'Test', email: 'recovery@example.test', password: 'test-only-password-123456', setupToken: process.env.OWNER_SETUP_TOKEN });
    assert.equal(owner.status, 200);
    cookie = owner.headers.get('set-cookie').split(';')[0];
    const ownerCookie = cookie;
    const first = await call('/api/import/import-csv', { csvData, source: 'card.csv', newAccount: { name: 'Test card', kind: 'credit_card', last4: '1111' } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.imported, 2);
    assert.ok(first.body.batchId);
    const accountId = first.body.account.id;
    const firstRows = await rows();
    assert.equal(firstRows.find(row => row.direction === 'CREDIT').transfer_kind, 'internal', 'card payments are not income');
    assert.ok(firstRows.every(row => row.import_batch_id === first.body.batchId));
    assert.equal((await history()).batches[0].statement_changed, false, 'CSV does not claim a statement metadata change');
    const checked = await review([first.body.batchId]);
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.affected, 2);
    assert.equal(checked.body.remainingTransactions, 0);
    assert.deepEqual(await rows(), firstRows, 'validation never commits simulated undo');
    assert.equal((await history()).batches[0].status, 'active');
    assert.equal((await call('/api/import/history/undo', { ids: [first.body.batchId] })).status, 400, 'direct commits without review/acknowledgement are rejected');
    assert.equal((await call('/api/import/history/undo', { ids: [first.body.batchId], acknowledged: true })).status, 400);
    await database.query("UPDATE transactions SET display_name='Changed after review' WHERE direction='DEBIT'");
    assert.equal((await call('/api/import/history/undo', { ids: [first.body.batchId], acknowledged: true, reviewToken: checked.body.reviewToken })).status, 409, 'stale financial state requires a new review');
    await database.query("UPDATE transactions SET display_name=NULL WHERE direction='DEBIT'");
    const expired = await review([first.body.batchId]);
    await database.query("UPDATE import_reviews SET expires_at=NOW()-INTERVAL '1 second'");
    assert.equal((await call('/api/import/history/undo', { ids: [first.body.batchId], acknowledged: true, reviewToken: expired.body.reviewToken })).status, 409);
    const repeated = await call('/api/import/import-csv', { csvData, source: 'repeat.csv', accountId });
    assert.equal(repeated.body.imported, 0);
    assert.equal(repeated.body.duplicates, 2);
    assert.equal((await undo([repeated.body.batchId])).body.affected, 0);
    assert.deepEqual(await rows(), firstRows, 'undoing duplicates never removes earlier rows');
    assert.equal((await restore([repeated.body.batchId])).status, 200);
    const wrongSelection = await review([first.body.batchId]);
    assert.equal((await call('/api/import/history/undo', { ids: [repeated.body.batchId], acknowledged: true, reviewToken: wrongSelection.body.reviewToken })).status, 409);

    const mixed = await call('/api/import/import-csv', { csvData: csvData.replace('00001111,PAYMENT', '00002222,PAYMENT'), source: 'mixed.csv', accountId });
    assert.equal(mixed.status, 422);
    assert.equal(mixed.body.code, 'ACCOUNT_REVIEW_REQUIRED');
    assert.equal(mixed.body.detectedAccounts.length, 2, 'multi-account files need mapping, not separate exports');
    const mismatch = await call('/api/import/import-csv', { csvData: csvData.replaceAll('00001111', '00003333'), accountId });
    assert.equal(mismatch.status, 422);
    assert.match(mismatch.body.error, /not the selected account/);
    const beforeBadNewAccount = (await database.query('SELECT COUNT(*)::int AS count FROM accounts')).rows[0].count;
    const badNewAccount = await call('/api/import/import-csv', { csvData, newAccount: { name: 'Wrong account', kind: 'checking', last4: '9999' } });
    assert.equal(badNewAccount.status, 422);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM accounts')).rows[0].count, beforeBadNewAccount);
    assert.equal((await history()).batches.length, 2, 'rejections do not leave history or accounts');

    await database.query("UPDATE transactions SET category='Gas',category_corrected=TRUE,pay_mode='manual',display_name='My shop',name_override=TRUE WHERE direction='DEBIT'");
    const edited = await rows();
    const commitFailureReview = await review([first.body.batchId]);
    failReconciliation = true;
    assert.equal((await call('/api/import/history/undo', { ids: [first.body.batchId], acknowledged: true, reviewToken: commitFailureReview.body.reviewToken })).status, 500);
    failReconciliation = false;
    assert.deepEqual(await rows(), edited, 'failed recovery rolls back removals and snapshots');
    assert.equal((await history()).batches.find(batch => batch.id === first.body.batchId).status, 'active');
    const successfulReview = await review([first.body.batchId]);
    const confirmedBody = { ids: [first.body.batchId], acknowledged: true, reviewToken: successfulReview.body.reviewToken };
    assert.equal((await call('/api/import/history/undo', confirmedBody)).body.affected, 2);
    assert.equal((await call('/api/import/history/undo', confirmedBody)).status, 409, 'review tokens cannot be replayed');
    assert.equal((await rows()).length, 0);
    assert.equal((await history()).batches.find(batch => batch.id === first.body.batchId).backup_rows, 2);
    assert.equal((await undo([first.body.batchId])).status, 409, 'double undo is rejected');
    await migrate();
    assert.equal((await history()).batches.find(batch => batch.id === first.body.batchId).backup_rows, 2, 'backups survive migration/restart');
    const nextId = (await database.query("SELECT nextval('transactions_id_seq') AS id")).rows[0].id;
    assert.ok(Number(nextId) > Math.max(...edited.map(row => row.id)), 'a restart reserves IDs held in backups');
    assert.equal((await restore([first.body.batchId])).body.affected, 2);
    assert.deepEqual(await rows(), edited, 'restore preserves IDs, timestamps, manual categories, pay mode and names');
    assert.equal((await restore([first.body.batchId])).status, 409);

    await undo([first.body.batchId]);
    const replacement = await call('/api/import/import-csv', { csvData, source: 'replacement.csv', accountId });
    assert.equal(replacement.body.imported, 2);
    assert.equal((await restore([first.body.batchId])).status, 409, 'a replacement import cannot be double-counted');
    await undo([replacement.body.batchId]);
    assert.equal((await restore([first.body.batchId])).status, 200);

    const pdfBase64 = statementPDF(cardLines).toString('base64');
    const partialPdf = await call('/api/import/import-csv', {
      csvData: 'Date,Description,Debit,Credit\n2026-09-10,SAMPLE MARKET,20,',
      source: 'partial.csv', accountId
    });
    assert.equal(partialPdf.body.imported, 1);
    const pdf = await call('/api/import/import-pdf', { pdfBase64, source: 'card.pdf', accountId });
    assert.equal(pdf.status, 200, JSON.stringify(pdf.body));
    const statement = (await database.query('SELECT statement FROM accounts WHERE id=$1', [accountId])).rows[0].statement;
    const savedPdfRows = await rows();
    assert.ok(statement.balance);
    assert.equal((await undo([pdf.body.batchId])).status, 200);
    assert.equal((await database.query('SELECT statement FROM accounts WHERE id=$1', [accountId])).rows[0].statement, null);
    assert.equal((await restore([pdf.body.batchId])).status, 200);
    assert.deepEqual((await database.query('SELECT statement FROM accounts WHERE id=$1', [accountId])).rows[0].statement, statement);
    assert.deepEqual(await rows(), savedPdfRows, 'legitimate repeated PDF purchases across imports survive undo/restore');
    const changedPdf = await call('/api/import/import-pdf', { pdfBase64: statementPDF(cardLines.map(line => line.replace('24.99%', '25.99%'))).toString('base64'), accountId });
    assert.equal(changedPdf.body.imported, 0);
    const beforeConflict = await rows();
    assert.equal((await undo([pdf.body.batchId])).status, 409, 'older statement cannot overwrite newer metadata');
    assert.deepEqual(await rows(), beforeConflict, 'metadata conflicts roll back all changes');
    assert.equal((await undo([pdf.body.batchId, changedPdf.body.batchId])).status, 200, 'multi-undo processes newest statement first');
    assert.equal((await restore([changedPdf.body.batchId])).status, 409, 'restore requires the prior statement state');
    assert.equal((await restore([changedPdf.body.batchId, pdf.body.batchId])).status, 200, 'multi-restore processes oldest statement first');
    assert.equal((await database.query('SELECT statement FROM accounts WHERE id=$1', [accountId])).rows[0].statement.purchaseApr, 25.99);
    assert.equal((await undo([partialPdf.body.batchId, pdf.body.batchId, changedPdf.body.batchId])).status, 200);
    assert.equal((await restore([changedPdf.body.batchId, partialPdf.body.batchId, pdf.body.batchId])).status, 200,
      'original matching occurrences remain restorable when several imports are undone together');

    const batch = await call('/api/import/import-batch', { files: [
      { type: 'csv', source: 'one.csv', data: 'Date,Description,Amount\n2026-10-03,ONE,-5', accountId },
      { type: 'csv', source: 'two.csv', data: 'Date,Description,Amount\n2026-10-04,TWO,-6', accountId }
    ] });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const batchIds = batch.body.results.map(result => result.batchId);
    assert.equal(new Set(batchIds).size, 2, 'each batch file has its own recovery boundary');
    const beforeBatchUndo = await rows();
    assert.equal((await undo(batchIds)).body.affected, 2);
    assert.equal((await restore(batchIds)).body.affected, 2);
    assert.deepEqual(await rows(), beforeBatchUndo);
    assert.equal((await undo([batchIds[0], 999999])).status, 404);
    assert.deepEqual(await rows(), beforeBatchUndo, 'invalid multi-selection is atomic');
    for (const ids of [[], [batchIds[0], batchIds[0]], ['1'], [0], null]) assert.equal((await undo(ids)).status, 400);

    await database.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source,created_at,account_id)
      VALUES (1,'2026-09-01','LEGACY A',1,'DEBIT','old.csv','2026-10-01T12:00:00Z',$1),
      (1,'2026-09-02','LEGACY B',2,'DEBIT','old.csv','2026-10-01T12:00:00Z',$1),
      (1,'2026-09-03','UNKNOWN AGE',3,'DEBIT','old.csv',NULL,$1)`, [accountId]);
    await migrate();
    const recovered = (await history()).batches.filter(batch => batch.source === 'old.csv');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].legacy, true);
    assert.equal(recovered[0].active_rows, 2);
    assert.equal((await history()).untracked, 1, 'undated rows are not guessed into an import');
    await migrate();
    assert.equal((await history()).batches.filter(batch => batch.source === 'old.csv').length, 1, 'legacy recovery is idempotent');
    assert.equal((await undo([recovered[0].id])).body.affected, 2);
    assert.equal((await restore([recovered[0].id])).body.affected, 2);

    // Optional local-only verification: customer files never become repository fixtures.
    for (const file of JSON.parse(process.env.CSV_RECOVERY_TEST_FILES || '[]')) {
      const imported = await call('/api/import/import-csv', {
        csvData: readFileSync(file.path, 'utf8'), source: 'local-verification.csv',
        newAccount: { name: 'Local verification', kind: file.kind, last4: file.last4 }
      });
      assert.equal(imported.status, file.status || 200);
      if (imported.status !== 200) continue;
      assert.equal(imported.body.imported, file.expectedRows);
      const baseline = await rows();
      const removed = await undo([imported.body.batchId]);
      assert.equal(removed.body.affected, file.expectedRows);
      const restored = await restore([imported.body.batchId]);
      assert.equal(restored.body.affected, file.expectedRows);
      assert.deepEqual(await rows(), baseline, 'local CSV rows survive recovery exactly');
    }

    const privateReview = await review([first.body.batchId]);
    cookie = '';
    const other = await call('/api/auth/register', { name: 'Other', email: 'other-recovery@example.test', password: 'other-test-password-123456' });
    assert.equal(other.status, 200);
    cookie = other.headers.get('set-cookie').split(';')[0];
    assert.deepEqual((await history()).batches, []);
    assert.equal((await call('/api/import/history/undo', { ids: [first.body.batchId], acknowledged: true, reviewToken: privateReview.body.reviewToken })).status, 409, 'a review token cannot be used by another tenant');
    assert.equal((await undo([first.body.batchId])).status, 404);
    assert.equal((await restore([first.body.batchId])).status, 404);
    cookie = ownerCookie;
    assert.ok((await history()).batches.length > 0);
    const audit = (await database.query("SELECT event_type FROM audit_events WHERE event_type IN ('import.undo','import.restore')")).rows;
    assert.ok(audit.some(row => row.event_type === 'import.undo'));
    assert.ok(audit.some(row => row.event_type === 'import.restore'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await database.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
