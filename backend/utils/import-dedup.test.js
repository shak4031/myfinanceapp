import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';
import { findOverlaps } from './importOverlap.js';
import { withUser } from './tenant.js';

test('overlap review enforces candidate, row and link limits without silently truncating', async () => {
  const transaction = { date: '2026-10-15', amount: 25, direction: 'DEBIT', description: 'SHOP', accountKey: 'checking' };
  const account = new Map([['checking', { id: 1, name: 'Checking', kind: 'checking', last4: '5261' }]]);
  const candidate = { ...transaction, account_id: null };
  let candidates = [{ ...candidate, id: 1 }];
  const client = { query: async () => ({ rows: candidates }) };
  const find = count => withUser(1, () => findOverlaps(client, Array.from({ length: count }, () => ({ ...transaction })), account, {}));
  const boundary = await find(500);
  assert.equal(boundary.length, 500);
  assert.ok(boundary.every(row => !row.bulkEligible), 'shared candidates are never bulk eligible');
  await assert.rejects(find(501), /smaller date range/);
  candidates = Array.from({ length: 1000 }, (_, index) => ({ ...candidate, id: index + 1 }));
  assert.equal((await find(2)).reduce((sum, row) => sum + row.candidates.length, 0), 2000);
  candidates.push({ ...candidate, id: 1001 });
  await assert.rejects(find(2), /smaller date range/);
  candidates = Array.from({ length: 2001 }, (_, index) => ({ ...candidate, id: index + 1 }));
  await assert.rejects(find(1), /smaller date range/);
});

test('CSV overlaps are reviewed atomically, preserving edits and isolating accounts', async t => {
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
      },
      release
    };
  });
  const client = await pg.Pool.prototype.connect();
  try { await client.query('BEGIN'); await migratePrivateSchema(client); await client.query('COMMIT'); }
  finally { client.release(); }
  const env = Object.fromEntries(['OWNER_SETUP_TOKEN', 'APP_ORIGIN', 'ALLOW_REGISTRATION'].map(key => [key, process.env[key]]));
  process.env.OWNER_SETUP_TOKEN = 'dedup-regression-test-setup-token-long-enough';
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
  const csv = lines => 'Date,Account Number,Description,Debit,Credit\n' + lines.join('\n');
  try {
    const owner = await call('/api/auth/setup', { name: 'Dedup test', email: 'dedup@example.test',
      password: 'test-only-password-123456', setupToken: process.env.OWNER_SETUP_TOKEN });
    cookie = owner.headers.get('set-cookie').split(';')[0];
    const original = await call('/api/import/import-csv', {
      csvData: csv(['10/15/2026,00005261,PENNYMAC ONLINE PMT,2280.09,',
        '10/16/2026,00005261,COFFEE SHOP,4.37,']),
      source: 'october-original.csv', newAccount: { name: 'Checking', kind: 'checking', last4: '5261' }
    });
    assert.equal(original.status, 200, JSON.stringify(original.body));
    const accountId = original.body.account.id;
    await database.query(`UPDATE transactions SET is_fixed=TRUE,pay_mode='manual',category_corrected=TRUE,
      category='Mortgage',display_name='PENNYMAC' WHERE description='PENNYMAC ONLINE PMT'`);
    const originalRows = (await database.query('SELECT * FROM transactions ORDER BY id')).rows;
    const overlap = await call('/api/import/import-csv', {
      csvData: csv(['10/15/2026,00005261," pennymac   online pmt ",2280.09,',
        '10/16/2026,00005261,COFFEE SHOP,4.37,',
        '10/22/2026,00005261,NEW PURCHASE,19.99,']), source: 'october-overlap.csv'
    });
    assert.equal(overlap.status, 200, JSON.stringify(overlap.body));
    assert.equal(overlap.body.imported, 1);
    assert.equal(overlap.body.duplicates, 2);
    assert.equal(overlap.body.accounts[0].duplicates, 2);
    assert.deepEqual((await database.query('SELECT * FROM transactions WHERE id=ANY($1::int[]) ORDER BY id',
      [originalRows.map(row => row.id)])).rows, originalRows, 'duplicate skips preserve manual classifications and flags');
    const listed = (await call('/api/transactions/transfer-review/imports')).body;
    const listedBatch = listed.batches.find(batch => batch.id === overlap.body.batchId);
    assert.ok(listedBatch, 'the completed upload appears in troubleshooting immediately');
    assert.equal(listedBatch.duplicates, 2);
    const page = (await call(`/api/transactions/transfer-review?importId=${overlap.body.batchId}`)).body;
    assert.equal(page.rows.length, 1, 'only newly inserted rows belong to the new import');

    const legacy = (await database.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source,
      category,is_fixed,pay_mode,display_name) VALUES(1,'10/17/2026','PENNYMAC   ONLINE PMT',2280.09,'DEBIT',
      'old-checking.csv','Mortgage',TRUE,'manual','PENNYMAC') RETURNING *`)).rows[0];
    const before = (await database.query('SELECT * FROM transactions ORDER BY id')).rows;
    const batchesBefore = (await database.query('SELECT COUNT(*)::int AS count FROM import_batches')).rows[0].count;
    const legacyBody = {
      csvData: csv(['10/23/2026,00005261,NEW BEFORE LEGACY,12.34,',
        '10/17/2026,00005261,PENNYMAC ONLINE PMT,2280.09,']), source: 'legacy-overlap.csv'
    };
    const legacyOverlap = await call('/api/import/import-csv', legacyBody);
    assert.equal(legacyOverlap.status, 409, 'an exact unassigned match must not become a second payment');
    assert.equal(legacyOverlap.body.code, 'OVERLAP_REVIEW_REQUIRED');
    assert.match(legacyOverlap.body.error, /Nothing was imported/);
    assert.deepEqual((await database.query('SELECT * FROM transactions ORDER BY id')).rows, before,
      'the whole upload rolls back, including new rows before the overlap');
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM import_batches')).rows[0].count, batchesBefore);

    const review = await call('/api/import/review-csv-overlaps', legacyBody);
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.rows.length, 1);
    assert.equal(review.body.rows[0].bulkEligible, true);
    assert.equal(review.body.rows[0].candidates[0].id, legacy.id);
    assert.deepEqual((await database.query('SELECT * FROM transactions ORDER BY id')).rows, before, 'preview changes nothing');
    const confirmation = { reviewToken: review.body.reviewToken,
      decisions: [{ index: review.body.rows[0].index, transactionId: legacy.id }], acknowledged: true };
    const unacknowledged = await call('/api/import/import-csv', { ...legacyBody,
      overlapReview: { ...confirmation, acknowledged: false } });
    assert.equal(unacknowledged.status, 400);
    const tampered = await call('/api/import/import-csv', { ...legacyBody, source: 'different.csv', overlapReview: confirmation });
    assert.equal(tampered.status, 409);
    const retry = await call('/api/import/import-csv', { ...legacyBody, overlapReview: confirmation });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.duplicates, 1);
    assert.equal(retry.body.imported, 1);
    assert.equal(retry.body.assigned, 1);
    const retained = (await database.query('SELECT * FROM transactions WHERE id=$1', [legacy.id])).rows[0];
    for (const field of ['category', 'is_fixed', 'pay_mode', 'display_name', 'source', 'import_batch_id', 'description']) {
      assert.deepEqual(retained[field], legacy[field], `${field} survives overlap confirmation`);
    }
    assert.equal(retained.account_id, accountId);
    assert.equal((await call('/api/import/import-csv', { ...legacyBody, overlapReview: confirmation })).status, 409, 'review token is single-use');
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM transactions WHERE date::date=$1::date AND amount=2280.09',
      ['2026-10-17'])).rows[0].count, 1);

    const similarBody = { csvData: csv(['10/15/2026,00005261,PENNYMAC PAYMENT,2280.09,']), source: 'similar.csv' };
    assert.equal((await call('/api/import/import-csv', similarBody)).body.code, 'OVERLAP_REVIEW_REQUIRED');
    const similarReview = (await call('/api/import/review-csv-overlaps', similarBody)).body;
    assert.equal(similarReview.rows[0].bulkEligible, false, 'similar descriptions cannot be bulk-confirmed');
    await database.query("UPDATE transactions SET display_name='Updated while reviewing' WHERE id=$1", [originalRows[0].id]);
    const stale = await call('/api/import/import-csv', { ...similarBody, overlapReview: {
      reviewToken: similarReview.reviewToken, decisions: [{ index: 0, transactionId: originalRows[0].id }], acknowledged: true } });
    assert.equal(stale.body.code, 'OVERLAP_REVIEW_REQUIRED', 'saved edits invalidate the review');
    const fresh = (await call('/api/import/review-csv-overlaps', similarBody)).body;
    const similarDone = await call('/api/import/import-csv', { ...similarBody, overlapReview: {
      reviewToken: fresh.reviewToken, decisions: [{ index: 0, transactionId: originalRows[0].id }], acknowledged: true } });
    assert.equal(similarDone.status, 200, JSON.stringify(similarDone.body));
    assert.equal(similarDone.body.imported, 0);
    assert.equal(similarDone.body.duplicates, 1);

    const ambiguous = (await database.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source)
      VALUES(1,'2026-10-25','SHOP PURCHASE',20,'DEBIT','legacy-mixed.csv'),
            (1,'2026-10-25','SHOP PURCHASE',20,'DEBIT','legacy-second.csv') RETURNING id`)).rows;
    const ambiguousBody = { csvData: csv(['10/25/2026,00005261,SHOP PURCHASE,20,',
      '10/25/2026,00007777,SHOP PURCHASE,20,']), source: 'ambiguous.csv',
    accountMappings: {} };
    // Establish the second account before reviewing a shared legacy candidate.
    const second = await call('/api/accounts', { name: 'Second', kind: 'checking', last4: '7777' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const ambiguousReview = (await call('/api/import/review-csv-overlaps', ambiguousBody)).body;
    assert.equal(ambiguousReview.rows.length, 2);
    assert.ok(ambiguousReview.rows.every(row => !row.bulkEligible && row.candidates.length === 2));
    const choices = ambiguousReview.rows.map(row => ({ index: row.index, transactionId: ambiguous[0].id }));
    const badChoice = await call('/api/import/import-csv', { ...ambiguousBody, overlapReview: {
      reviewToken: ambiguousReview.reviewToken, decisions: choices, acknowledged: true } });
    assert.equal(badChoice.status, 400, 'one old row cannot be consumed twice');
    assert.ok((await database.query('SELECT account_id FROM transactions WHERE id=ANY($1::int[])',
      [ambiguous.map(row => row.id)])).rows.every(row => row.account_id === null), 'failed review rolls back partial assignment');
    choices[1].transactionId = 'new';
    const distinct = await call('/api/import/import-csv', { ...ambiguousBody, overlapReview: {
      reviewToken: ambiguousReview.reviewToken, decisions: choices, acknowledged: true } });
    assert.equal(distinct.status, 200, JSON.stringify(distinct.body));
    assert.equal(distinct.body.imported, 1);
    assert.equal(distinct.body.assigned, 1);
    assert.equal(distinct.body.duplicates, 1);

    const newAccountLegacy = (await database.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source)
      VALUES(1,'2026-10-26','LEGACY SAVINGS',42,'CREDIT','mixed-legacy.csv') RETURNING id`)).rows[0];
    const newAccountBody = { csvData: csv(['10/26/2026,00008888,LEGACY SAVINGS,,42']),
      source: 'savings.csv', newAccount: { name: 'New savings', kind: 'savings', last4: '8888' } };
    const accountCount = (await database.query('SELECT COUNT(*)::int AS count FROM accounts')).rows[0].count;
    assert.equal((await call('/api/import/import-csv', newAccountBody)).body.code, 'OVERLAP_REVIEW_REQUIRED');
    const newAccountReview = await call('/api/import/review-csv-overlaps', newAccountBody);
    assert.equal(newAccountReview.status, 200, JSON.stringify(newAccountReview.body));
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM accounts')).rows[0].count, accountCount,
      'previewing a new destination does not create an account');
    await database.query("UPDATE import_reviews SET expires_at=NOW()-INTERVAL '1 second'");
    const expired = await call('/api/import/import-csv', { ...newAccountBody, overlapReview: {
      reviewToken: newAccountReview.body.reviewToken, decisions: [{ index: 0, transactionId: newAccountLegacy.id }], acknowledged: true } });
    assert.equal(expired.body.code, 'OVERLAP_REVIEW_REQUIRED');
    const renewed = (await call('/api/import/review-csv-overlaps', newAccountBody)).body;
    const newAccountDone = await call('/api/import/import-csv', { ...newAccountBody, overlapReview: {
      reviewToken: renewed.reviewToken, decisions: [{ index: 0, transactionId: newAccountLegacy.id }], acknowledged: true } });
    assert.equal(newAccountDone.status, 200, JSON.stringify(newAccountDone.body));
    assert.equal(newAccountDone.body.assigned, 1);
    assert.equal(newAccountDone.body.imported, 0);
    assert.equal(newAccountDone.body.duplicates, 1);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM accounts')).rows[0].count, accountCount + 1);

    const otherAccount = await call('/api/import/import-csv', {
      csvData: csv(['10/15/2026,00007777,PENNYMAC ONLINE PMT,2280.09,']), source: 'other-account.csv'
    });
    assert.equal(otherAccount.body.imported, 1, 'assigned transactions in another account remain independent');
    const simultaneous = await Promise.all([1, 2].map(index => call('/api/import/import-csv', {
      csvData: csv(['10/24/2026,00005261,CONCURRENT PAYMENT,25.17,']), source: `simultaneous-${index}.csv`
    })));
    assert.ok(simultaneous.every(result => result.status === 200));
    assert.deepEqual(simultaneous.map(result => result.body.imported).sort(), [0, 1]);
    assert.deepEqual(simultaneous.map(result => result.body.duplicates).sort(), [0, 1]);

    await database.exec('ALTER TABLE transactions ALTER COLUMN amount TYPE REAL USING amount::real');
    const realColumn = await call('/api/import/import-csv', {
      csvData: csv(['10/15/2026,00005261,PENNYMAC ONLINE PMT,2280.09,',
        '10/16/2026,00005261,COFFEE SHOP,4.37,']), source: 'legacy-real-column.csv'
    });
    assert.equal(realColumn.status, 200, JSON.stringify(realColumn.body));
    assert.equal(realColumn.body.imported, 0);
    assert.equal(realColumn.body.duplicates, 2, 'legacy floating-point money columns compare at cent precision');

    await database.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source)
      VALUES(1,'2026-10-15','PENNYMAC ONLINE PMT',2280.09,'DEBIT','private-legacy.csv')`);
    const privateBody = { csvData: csv(['10/15/2026,00005261,PENNYMAC ONLINE PMT,2280.09,']),
      source: 'other-user.csv', newAccount: { name: 'Other user checking', kind: 'checking', last4: '5261' } };
    const privateReview = (await call('/api/import/review-csv-overlaps', privateBody)).body;
    const otherUser = await call('/api/auth/register', {
      name: 'Other user', email: 'dedup-other@example.test', password: 'other-test-password-123456'
    });
    assert.equal(otherUser.status, 200);
    cookie = otherUser.headers.get('set-cookie').split(';')[0];
    const stolenReview = await call('/api/import/import-csv', { ...privateBody,
      overlapReview: { reviewToken: privateReview.reviewToken, decisions: [], acknowledged: true } });
    assert.equal(stolenReview.status, 409, 'review tokens are bound to the signed-in user');
    const privateImport = await call('/api/import/import-csv', privateBody);
    assert.equal(privateImport.status, 200);
    assert.equal(privateImport.body.imported, 1, 'another user cannot match the first user history');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await database.close();
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
