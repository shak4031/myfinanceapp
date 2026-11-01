import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import { withUser } from './tenant.js';
import { cleanupFilter, cleanupIds, deleteCleanup, listCleanup } from './transactionCleanup.js';

test('bulk cleanup validates dates, filters, and explicit selected IDs', () => {
  const filter = { dateType: 'imported', start: '2026-10-01', end: '2026-10-31' };
  for (const update of [
    { start: '2026-02-30' }, { start: '2026-11-01' }, { dateType: 'invalid' },
    { source: 'invalid' }, { search: ['invalid'] }, { end: undefined }
  ]) assert.throws(() => cleanupFilter({ ...filter, ...update }), { status: 400 });
  for (const ids of [undefined, [], [1, 1], [-1], ['1'], Array.from({ length: 10001 }, (_, i) => i + 1)]) {
    assert.throws(() => cleanupIds(ids), { status: 400 });
  }
  assert.deepEqual(cleanupIds([1, 2]), [1, 2]);
});

test('cleanup filters both date types, paginates, and deletes only owned selections atomically', async () => {
  const pg = new PGlite();
  const client = { async query(sql, params) {
    const results = params?.length ? [await pg.query(sql, params)] : await pg.exec(sql);
    const result = results.at(-1) || { rows: [] };
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } };
  try {
    await migratePrivateSchema(client);
    await pg.exec(`
      SELECT set_config('app.user_id','1',false);
      INSERT INTO users(id,name) VALUES (2,'Other customer');
      INSERT INTO transactions(id,user_id,date,description,amount,direction,source,created_at,plaid_transaction_id)
      VALUES (1,1,'2026-08-01','Test bank purchase',10,'DEBIT','plaid','2026-10-31 23:59:59+00','plaid-1'),
        (2,1,'2026-10-31','Manual purchase',20,'DEBIT','csv','2026-09-01 00:00:00+00',NULL),
        (3,2,'2026-10-31','Another customer',30,'DEBIT','plaid','2026-10-31 12:00:00+00','plaid-3'),
        (4,1,'2026-08-01','Next day import',40,'DEBIT','plaid','2026-11-01 00:00:00+00','plaid-4');
      INSERT INTO transaction_import_reviews(user_id,source,date,description,amount,direction,
        resolution_transaction_id,matched_transaction_id,candidate_transaction_ids)
      VALUES (1,'plaid','2026-08-01','Review',10,'DEBIT',1,2,ARRAY[1,2]);
    `);
    const filter = { dateType: 'imported', start: '2026-10-31', end: '2026-10-31', source: 'plaid' };
    await withUser(1, async () => {
      assert.deepEqual((await listCleanup(client, filter)).rows.map(row => row.id), [1]);
      assert.deepEqual(await listCleanup(client, { ...filter, selection: 'all' }), { ids: [1] });
      assert.deepEqual((await listCleanup(client, { ...filter, dateType: 'transaction', source: 'all' })).rows.map(row => row.id), [2]);
      assert.equal((await listCleanup(client, { ...filter, search: 'BANK' })).total, 1);
      assert.equal((await listCleanup(client, { ...filter, search: '%' })).total, 0);
      assert.equal((await listCleanup(client, { ...filter, offset: '50' })).rows.length, 0);
      await assert.rejects(listCleanup(client, { ...filter, offset: '-1' }), { status: 400 });
      await assert.rejects(deleteCleanup(client, [1], false), { status: 400 });
      for (const ids of [[1, 3], [1, 999]]) {
        await pg.exec('BEGIN');
        await assert.rejects(deleteCleanup(client, ids, true), { status: 409 });
        await pg.exec('ROLLBACK');
        assert.equal((await pg.query('SELECT id FROM transactions WHERE id=1')).rows.length, 1);
      }
      await pg.exec('BEGIN');
      assert.deepEqual(await deleteCleanup(client, [1], true), { success: true, deleted: 1 });
      await pg.exec('COMMIT');
      assert.deepEqual((await pg.query('SELECT id FROM transactions ORDER BY id')).rows.map(row => row.id), [2, 3, 4]);
      const review = (await pg.query('SELECT * FROM transaction_import_reviews')).rows[0];
      assert.equal(review.resolution_transaction_id, null);
      assert.equal(review.matched_transaction_id, 2);
      assert.deepEqual(review.candidate_transaction_ids, [2]);
    });
  } finally { await pg.close(); }
});
