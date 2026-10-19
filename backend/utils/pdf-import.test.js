import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { cardLines, bankLines, statementPDF } from './test-fixtures/statements.js';

test('PDF HTTP imports are atomic, account-scoped, repeatable and persist verified statement facts', async t => {
  const database = new PGlite();
  let lock = Promise.resolve();
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    let release;
    const previous = lock;
    lock = new Promise(resolve => { release = resolve; });
    await previous;
    return {
      async query(sql, params) {
        const results = params?.length ? [await database.query(sql, params)] : await database.exec(sql);
        const result = results.at(-1) || { rows: [] };
        return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
      }, release
    };
  });
  const adapter = await pg.Pool.prototype.connect();
  await adapter.query('BEGIN'); await migratePrivateSchema(adapter); await adapter.query('COMMIT'); adapter.release();
  const env = Object.fromEntries(['OWNER_SETUP_TOKEN', 'APP_ORIGIN', 'ALLOW_REGISTRATION'].map(key => [key, process.env[key]]));
  process.env.OWNER_SETUP_TOKEN = 'test-pdf-setup-token-longer-than-32-characters';
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
  const pdf = lines => statementPDF(lines).toString('base64');
  const cardBody = { pdfBase64: pdf(cardLines), source: 'synthetic-card.pdf', newAccount: { name: 'Example card', kind: 'credit_card', last4: '1111' } };
  const counts = async () => (await database.query('SELECT (SELECT COUNT(*)::int FROM accounts) AS accounts, (SELECT COUNT(*)::int FROM transactions) AS transactions')).rows[0];
  try {
    const owner = await call('/api/auth/setup', { name: 'Test', email: 'pdf@example.test', password: 'test-only-password-123456', setupToken: process.env.OWNER_SETUP_TOKEN });
    assert.equal(owner.status, 200);
    cookie = owner.headers.get('set-cookie').split(';')[0];
    const imported = await call('/api/import/import-pdf', { ...cardBody, statementType: 'td-checking' });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.imported, 6, 'identical legitimate purchases are both imported');
    assert.equal(imported.body.totalInFile, 6);
    assert.equal(imported.body.statement.type, 'credit-card', 'content wins over legacy client hint');
    assert.equal(imported.body.reconciliation.status, 'balanced');
    const accountId = imported.body.account.id;
    const accounts = (await call('/api/accounts')).body.accounts;
    const account = accounts.find(item => item.id === accountId);
    assert.equal(account.balance, 110);
    assert.equal(account.balanceAsOf, '2026-10-03');
    assert.equal(account.statement.purchaseApr, 24.99);
    assert.equal(account.statement.minimumPayment, 25);
    const rows = (await call('/api/dashboard/all-transactions')).body.transactions;
    assert.equal(rows.filter(tx => tx.description === 'SAMPLE MARKET').length, 2);
    assert.equal(rows.find(tx => /AUTOPAY/.test(tx.description)).transfer_kind, 'internal');
    const repeat = await call('/api/import/import-pdf', { pdfBase64: cardBody.pdfBase64, accountId, source: 'renamed-same-file.pdf' });
    assert.equal(repeat.body.imported, 0);
    assert.equal(repeat.body.duplicates, 6);
    const another = await call('/api/import/import-pdf', {
      pdfBase64: pdf(cardLines.map(line => line.replace('0000 1111', '0000 3333'))),
      newAccount: { name: 'Different card', kind: 'credit_card', last4: '3333' }
    });
    assert.equal(another.body.imported, 6, 'same transaction attributes on different accounts are not duplicates');

    const historical = cardLines.map(line => line.replace('September 04, 2026 to October 03, 2026', 'August 04, 2026 to September 03, 2026')
      .replace(/09\//g, '08/').replace(/10\/03/g, '09/03').replace('$100.00', '$90.00').replace(/\$110.00/g, '$100.00'));
    const old = await call('/api/import/import-pdf', { pdfBase64: pdf(historical), accountId });
    assert.equal(old.status, 200, JSON.stringify(old.body));
    const retained = (await call('/api/accounts')).body.accounts.find(item => item.id === accountId);
    assert.equal(retained.statement.closingDate, '2026-10-03');
    assert.equal(retained.balance, 110, 'older statements never overwrite newer metadata');

    const beforeErrors = await counts();
    const malformed = await call('/api/import/import-pdf', { ...cardBody, pdfBase64: pdf(cardLines.filter(line => !line.includes('00001 09/10'))) });
    assert.equal(malformed.status, 422);
    assert.match(malformed.body.error, /do not reconcile/);
    assert.equal((await call('/api/import/import-pdf', { ...cardBody, newAccount: { name: 'Wrong bank kind', kind: 'checking' } })).status, 422);
    assert.equal((await call('/api/import/import-pdf', { pdfBase64: cardBody.pdfBase64, accountId: another.body.account.id })).status, 422);
    assert.equal((await call('/api/import/import-pdf', { pdfBase64: 'bad', accountId })).status, 400);
    assert.equal((await call('/api/import/import-pdf', { pdfBase64: cardBody.pdfBase64 })).status, 400);
    const batch = await call('/api/import/import-batch', { files: [
      { type: 'pdf', data: cardBody.pdfBase64, newAccount: { name: 'Should roll back', kind: 'checking' } },
      { type: 'pdf', data: cardBody.pdfBase64, accountId }
    ] });
    assert.equal(batch.status, 422);
    assert.deepEqual(await counts(), beforeErrors, 'failed imports never leave accounts, transactions or metadata behind');

    const bank = await call('/api/import/import-pdf', { pdfBase64: pdf(bankLines), newAccount: { name: 'Checking', kind: 'checking' } });
    assert.equal(bank.status, 200, JSON.stringify(bank.body));
    assert.equal(bank.body.imported, 2);
    const bankAccount = (await call('/api/accounts')).body.accounts.find(item => item.id === bank.body.account.id);
    assert.equal(bankAccount.last4, '2222');
    assert.equal(bankAccount.balance, 250);
    assert.equal((await call('/api/dashboard/summary', { dateFilter: 'current' })).body.balance, 250, 'card liabilities do not enter spendable cash');
    const noActivity = bankLines.slice(0, 7).map(line => line.replace('2222', '4444').replace('$200.00', '$0.00').replace('$50.00', '$0.00').replace('$250.00', '$100.00'));
    const empty = await call('/api/import/import-pdf', { pdfBase64: pdf(noActivity), newAccount: { name: 'No activity checking', kind: 'checking' } });
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(empty.body.imported, 0);
    assert.equal((await call('/api/accounts')).body.accounts.find(item => item.id === empty.body.account.id).balance, 100);
    assert.equal((await call('/api/dashboard/summary', { dateFilter: 'current' })).body.balance, 350);

    // Opt-in local verification keeps customer PDFs outside the repository and the live database.
    for (const [index, file] of JSON.parse(process.env.PDF_IMPORT_TEST_FILES || '[]').entries()) {
      const payload = { pdfBase64: readFileSync(file.path).toString('base64'), source: `local-statement-${index + 1}.pdf`,
        newAccount: { name: `Local verification ${index + 1}`, kind: file.kind || 'credit_card' } };
      const checked = await call('/api/import/import-pdf', payload);
      assert.equal(checked.status, 200, `Local document ${index + 1} must import`);
      assert.equal(checked.body.totalInFile, file.expectedRows);
      assert.equal(checked.body.imported, file.expectedRows);
      assert.equal(checked.body.reconciliation.status, 'balanced');
      assert.ok(checked.body.statement.purchaseApr > 0);
      const repeated = await call('/api/import/import-pdf', { pdfBase64: payload.pdfBase64, accountId: checked.body.account.id });
      assert.equal(repeated.body.imported, 0);
      assert.equal(repeated.body.duplicates, file.expectedRows);
      const saved = (await call('/api/accounts')).body.accounts.find(item => item.id === checked.body.account.id);
      assert.equal(saved.balance, checked.body.statement.balance);
      assert.equal(saved.statement.purchaseApr, checked.body.statement.purchaseApr);
    }

    const second = await call('/api/auth/register', { name: 'Second', email: 'second-pdf@example.test', password: 'test-only-password-123456' });
    cookie = second.headers.get('set-cookie').split(';')[0];
    assert.deepEqual((await call('/api/accounts')).body.accounts, []);
    assert.equal((await call('/api/import/import-pdf', { pdfBase64: cardBody.pdfBase64, accountId })).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await database.close();
    for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
