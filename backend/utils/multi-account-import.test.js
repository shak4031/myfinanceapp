import assert from 'node:assert/strict';
import { configureTestMail, grantFixtureAccess } from './paidFixture.js';
configureTestMail();
import test from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';

test('CSV account detection, reviewed mappings, atomic imports and per-account recovery', async t => {
  const database = new PGlite();
  const queries = [];
  let lock = Promise.resolve();
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    let release;
    const previous = lock;
    lock = new Promise(resolve => { release = resolve; });
    await previous;
    return {
      async query(sql, params) {
        queries.push(sql);
        const results = params?.length ? [await database.query(sql, params)] : await database.exec(sql);
        const result = results.at(-1) || { rows: [] };
        return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
      },
      release
    };
  });
  const client = await pg.Pool.prototype.connect();
  try { await client.query('BEGIN'); await migratePrivateSchema(client); await client.query('COMMIT'); }
  finally { client.release(); }
  const env = Object.fromEntries(['OWNER_SETUP_TOKEN', 'APP_ORIGIN', 'ALLOW_REGISTRATION'].map(key => [key, process.env[key]]));
  process.env.OWNER_SETUP_TOKEN = 'multi-account-import-test-setup-token-long-enough';
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
  const count = async table => (await database.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count;
  const csvData = `Date,Bank RTN,Account Number,Description,Debit,Credit
10/14/2026,031201360,00001111,SAME PURCHASE,15,
10/14/2026,031201360,00002222,SAME PURCHASE,15,
10/15/2026,031201360,00001111,PAYROLL,,100
10/15/2026,031201360,00002222,INTEREST PAYMENT,,2`;
  try {
    const owner = await call('/api/auth/setup', {
      name: 'Owner', email: 'multi-owner@example.test', password: 'test-only-password-123456',
      setupToken: process.env.OWNER_SETUP_TOKEN
    });
    assert.equal(owner.status, 200);
    cookie = owner.headers.get('set-cookie').split(';')[0];
    const ownerCookie = cookie;
    const preview = await call('/api/import/inspect-csv', { csvData, source: 'td.csv' });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.accounts.map(group => group.last4), ['1111', '2222']);
    assert.ok(preview.body.accounts.every(group => !group.needsReview && group.autoCreate));
    assert.equal(await count('accounts'), 0);
    assert.equal(await count('transactions'), 0);
    assert.equal(await count('import_batches'), 0);
    assert.doesNotMatch(JSON.stringify(preview.body), /00001111|00002222/);
    const [checking, savings] = preview.body.accounts;
    const mappings = {
      [checking.key]: { newAccount: { name: 'TD checking', kind: 'checking', institution: 'TD Bank' } },
      [savings.key]: { newAccount: { name: 'TD savings', kind: 'savings', institution: 'TD Bank' } }
    };
    const bad = await call('/api/import/import-csv', {
      csvData, accountMappings: { ...mappings, [savings.key]: { newAccount: { name: '', kind: 'savings' } } }
    });
    assert.equal(bad.status, 400);
    assert.equal(await count('accounts'), 0, 'a failed mapping rolls back earlier account creation');
    const imported = await call('/api/import/import-csv', { csvData, source: 'td.csv', accountMappings: mappings });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.imported, 4);
    assert.equal(imported.body.accounts.length, 2);
    assert.equal(imported.body.batchId, undefined, 'multi-account import exposes each account batch separately');
    const [bankResult, savingsResult] = imported.body.accounts;
    assert.notEqual(bankResult.batchId, savingsResult.batchId);
    assert.notEqual(bankResult.account.id, savingsResult.account.id);
    const transactions = (await database.query('SELECT * FROM transactions ORDER BY id')).rows;
    assert.equal(transactions.filter(row => row.description === 'SAME PURCHASE').length, 2, 'identical purchases in different accounts survive');
    assert.equal(transactions.filter(row => row.account_id === bankResult.account.id).length, 2);
    assert.equal(transactions.filter(row => row.account_id === savingsResult.account.id).length, 2);
    const matched = (await call('/api/import/inspect-csv', { csvData })).body;
    assert.ok(matched.accounts.every(group => !group.needsReview));
    queries.length = 0;
    const options = await call('/api/accounts/import-options');
    assert.equal(options.status, 200);
    assert.equal(options.body.accounts.length, 2);
    assert.ok(queries.every(sql => !/\bFROM transactions\b/i.test(sql)), 'account choices never load transaction history');
    const replay = await call('/api/import/import-csv', { csvData, source: 'td-again.csv' });
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.imported, 0);
    assert.equal(replay.body.duplicates, 4);
    const topLevelFallback = await call('/api/import/import-csv', { csvData, accountId: bankResult.account.id });
    assert.equal(topLevelFallback.status, 200);
    assert.equal(topLevelFallback.body.accounts[1].account.id, savingsResult.account.id, 'one picker never collapses detected accounts');
    const review = await call('/api/import/history/review', { ids: [bankResult.batchId], action: 'undo' });
    assert.equal(review.status, 200);
    const undone = await call('/api/import/history/undo', {
      ids: [bankResult.batchId], acknowledged: true, reviewToken: review.body.reviewToken
    });
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(await count('transactions'), 2, 'undoing one account leaves the other account intact');
    assert.ok((await database.query('SELECT account_id FROM transactions')).rows.every(row => row.account_id === savingsResult.account.id));

    const partialCsv = `${csvData}\n10/16/2026,031201360,,MISSING ACCOUNT,3,`;
    const partial = await call('/api/import/inspect-csv', { csvData: partialCsv });
    assert.equal(partial.body.accounts.at(-1).key, 'unidentified');
    const beforePartial = await count('transactions');
    assert.equal((await call('/api/import/import-csv', { csvData: partialCsv })).status, 422);
    assert.equal(await count('transactions'), beforePartial);
    const explicitMissing = await call('/api/import/import-csv', {
      csvData: partialCsv, accountMappings: { unidentified: { accountId: bankResult.account.id } }
    });
    assert.equal(explicitMissing.status, 200);
    assert.equal(explicitMissing.body.imported, 3);
    assert.equal(explicitMissing.body.accounts.length, 2, 'unidentified rows assigned to a detected account share its batch');

    const batch = await call('/api/import/import-batch', { files: [{ type: 'csv', data: csvData, source: 'td-batch.csv' }] });
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    assert.equal(batch.body.totalDuplicates, 4);
    assert.equal(batch.body.results[0].accounts.length, 2);

    await call('/api/accounts', { name: 'Another card ending 1111', kind: 'credit_card', last4: '1111' });
    const ambiguous = (await call('/api/import/inspect-csv', { csvData })).body;
    assert.equal(ambiguous.accounts[0].needsReview, true);
    assert.equal((await call('/api/import/import-csv', { csvData })).status, 422);
    assert.equal((await call('/api/import/import-csv', {
      csvData, accountMappings: { [checking.key]: { accountId: bankResult.account.id } }
    })).status, 200, 'explicit mapping resolves ambiguity without guessing');

    const collisionCsv = 'Date,Account Number,Description,Debit\n2026-10-22,10007777,SAME SHOP,10\n2026-10-22,20007777,SAME SHOP,10';
    const collision = (await call('/api/import/inspect-csv', { csvData: collisionCsv })).body.accounts;
    assert.equal(collision.length, 2);
    const collisionImport = await call('/api/import/import-csv', { csvData: collisionCsv,
      accountMappings: Object.fromEntries(collision.map((group, index) => [group.key, {
        newAccount: { name: `Separate checking ${index}`, kind: 'checking' }
      }])) });
    assert.equal(collisionImport.status, 200, JSON.stringify(collisionImport.body));
    assert.equal(collisionImport.body.imported, 2);
    const collisionId = collisionImport.body.accounts[0].account.id;
    assert.notEqual(collisionId, collisionImport.body.accounts[1].account.id);
    assert.equal((await call('/api/import/import-csv', { csvData: collisionCsv,
      accountMappings: Object.fromEntries(collision.map(group => [group.key, { accountId: collisionId }]))
    })).status, 422, 'distinct account numbers may not be collapsed into a single account');

    const other = await call('/api/auth/register', { name: 'Other', email: 'multi-other@example.test', password: 'other-test-password-123456' });
    await grantFixtureAccess(database, other.body.user.id);
    assert.equal(other.status, 200);
    cookie = other.headers.get('set-cookie').split(';')[0];
    const privatePreview = (await call('/api/import/inspect-csv', { csvData })).body;
    assert.ok(privatePreview.accounts.every(group => group.matchedAccountId === null), 'other tenants do not see account matches');
    assert.ok(privatePreview.accounts.every(group => group.autoCreate && !group.needsReview));
    assert.equal((await call('/api/import/import-csv', {
      csvData, accountMappings: {
        [checking.key]: { accountId: bankResult.account.id }, [savings.key]: { accountId: savingsResult.account.id }
      }
    })).status, 400);
    const beforeFreshImport = await count('transactions');
    const beforeFreshAccounts = await count('accounts');
    const incomplete = await call('/api/import/import-csv', { csvData: partialCsv, source: 'fresh-partial.csv' });
    assert.equal(incomplete.status, 422);
    assert.equal(incomplete.body.code, 'ACCOUNT_REVIEW_REQUIRED');
    assert.equal(await count('accounts'), beforeFreshAccounts, 'missing identity rolls back automatically created accounts');
    assert.equal(await count('transactions'), beforeFreshImport);
    const fresh = await call('/api/import/import-csv', { csvData, source: 'same-td.csv' });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.imported, 4, 'identical CSV in a new household imports every transaction');
    assert.equal(fresh.body.duplicates, 0);
    assert.equal(fresh.body.accounts.length, 2);
    assert.ok(fresh.body.accounts.every(result => result.account.autoCreated && result.account.kind === 'other'));
    assert.ok(fresh.body.accounts.every(result => ![bankResult.account.id, savingsResult.account.id].includes(result.account.id)));
    assert.equal(await count('transactions'), beforeFreshImport + 4);
    const freshReplay = await call('/api/import/import-csv', { csvData, source: 'same-td-replay.csv' });
    assert.equal(freshReplay.status, 200);
    assert.equal(freshReplay.body.imported, 0);
    assert.equal(freshReplay.body.duplicates, 4, 'duplicates only skip on reimport within the new household');
    assert.equal(await count('accounts'), beforeFreshAccounts + 2, 'reimport reuses the automatically created accounts');
    const typedCsv = 'Date,Account Number,Account Type,Description,Debit,Credit\n2026-10-22,00008888,Savings,SAVED,,50';
    const typed = await call('/api/import/import-csv', { csvData: typedCsv });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    assert.equal(typed.body.account.kind, 'savings');
    assert.equal(typed.body.account.last4, '8888');
    const conflicting = await call('/api/import/inspect-csv', { csvData: typedCsv.replace('Savings', 'Checking') });
    assert.equal(conflicting.body.accounts[0].needsReview, true, 'type conflicts require review rather than creating another account');
    const autoOverlapCsv = 'Date,Account Number,Description,Debit\n2026-10-23,00009999,LEGACY PURCHASE,37';
    await database.query(`INSERT INTO transactions(user_id,date,description,amount,direction,category)
      VALUES($1,'2026-10-23','LEGACY PURCHASE',37,'DEBIT','Shopping')`, [other.body.user.id]);
    const autoOverlapBody = { csvData: autoOverlapCsv, source: 'auto-overlap.csv' };
    const autoOverlap = await call('/api/import/import-csv', autoOverlapBody);
    assert.equal(autoOverlap.status, 409);
    assert.equal(autoOverlap.body.code, 'OVERLAP_REVIEW_REQUIRED');
    const autoReview = await call('/api/import/review-csv-overlaps', autoOverlapBody);
    assert.equal(autoReview.status, 200);
    assert.equal(autoReview.body.rows.length, 1);
    const confirmedAuto = await call('/api/import/import-csv', { ...autoOverlapBody, overlapReview: {
      reviewToken: autoReview.body.reviewToken, acknowledged: true,
      decisions: [{ index: autoReview.body.rows[0].index, transactionId: autoReview.body.rows[0].candidates[0].id }]
    } });
    assert.equal(confirmedAuto.status, 200, JSON.stringify(confirmedAuto.body));
    assert.equal(confirmedAuto.body.assigned, 1, 'auto-created account overlap review survives rolled-back preview account IDs');
    assert.equal(confirmedAuto.body.imported, 0);
    assert.equal(confirmedAuto.body.duplicates, 1);
    const concurrentCsv = 'Date,Account Number,Description,Debit\n2026-10-24,00006666,CONCURRENT FIRST IMPORT,19';
    const beforeConcurrentAccounts = await count('accounts');
    const concurrent = await Promise.all([call('/api/import/import-csv', { csvData: concurrentCsv }),
      call('/api/import/import-csv', { csvData: concurrentCsv })]);
    assert.ok(concurrent.every(result => result.status === 200), JSON.stringify(concurrent.map(result => result.body)));
    assert.equal(concurrent.reduce((sum, result) => sum + result.body.imported, 0), 1);
    assert.equal(concurrent.reduce((sum, result) => sum + result.body.duplicates, 0), 1);
    assert.equal(await count('accounts'), beforeConcurrentAccounts + 1, 'simultaneous first imports create one account, not two');
    cookie = ownerCookie;
  } finally {
    await new Promise(resolve => server.close(resolve));
    await database.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
