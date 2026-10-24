import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import application from '../app.js';
import { migratePrivateSchema } from './schema.js';

test('overlapping CSVs skip assigned rows and stop safely on unassigned legacy matches', async t => {
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
    const legacyOverlap = await call('/api/import/import-csv', {
      csvData: csv(['10/23/2026,00005261,NEW BEFORE LEGACY,12.34,',
        '10/17/2026,00005261,PENNYMAC ONLINE PMT,2280.09,']), source: 'legacy-overlap.csv'
    });
    assert.equal(legacyOverlap.status, 409, 'an exact unassigned match must not become a second payment');
    assert.equal(legacyOverlap.body.code, 'UNASSIGNED_OVERLAP');
    assert.match(legacyOverlap.body.error, /Nothing was imported/);
    assert.deepEqual((await database.query('SELECT * FROM transactions ORDER BY id')).rows, before,
      'the whole upload rolls back, including new rows before the overlap');
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM import_batches')).rows[0].count, batchesBefore);

    const assigned = await call('/api/accounts/assign', { source: legacy.source, accountId });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    const retry = await call('/api/import/import-csv', {
      csvData: csv(['10/17/2026,00005261,PENNYMAC ONLINE PMT,2280.09,',
        '10/23/2026,00005261,NEW BEFORE LEGACY,12.34,']), source: 'legacy-overlap.csv'
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.duplicates, 1);
    assert.equal(retry.body.imported, 1);
    assert.equal((await database.query('SELECT COUNT(*)::int AS count FROM transactions WHERE date::date=$1::date AND amount=2280.09',
      ['2026-10-17'])).rows[0].count, 1);

    const otherAccount = await call('/api/import/import-csv', {
      csvData: csv(['10/15/2026,00007777,PENNYMAC ONLINE PMT,2280.09,']), source: 'other-account.csv',
      newAccount: { name: 'Other checking', kind: 'checking', last4: '7777' }
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
    const otherUser = await call('/api/auth/register', {
      name: 'Other user', email: 'dedup-other@example.test', password: 'other-test-password-123456'
    });
    assert.equal(otherUser.status, 200);
    cookie = otherUser.headers.get('set-cookie').split(';')[0];
    const privateImport = await call('/api/import/import-csv', {
      csvData: csv(['10/15/2026,00005261,PENNYMAC ONLINE PMT,2280.09,']),
      source: 'other-user.csv', newAccount: { name: 'Other user checking', kind: 'checking', last4: '5261' }
    });
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
