import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PlaidApi } from 'plaid';
import { migratePrivateSchema, repairLegacyPlaidDirections, seedUserCategories } from './schema.js';
import { encryptPlaidToken } from './plaid.js';
import { incomeSources, projectIncome } from './income.js';
import { syncConnection } from '../routes/plaid.js';
import { withUser } from './tenant.js';

function adapter(pg) {
  return {
    async query(sql, params = []) {
      const result = params.length ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }
  };
}

test('startup repairs legacy Plaid data for all households exactly once and preserves unrelated records', async () => {
  const pg = new PGlite();
  const client = adapter(pg);
  const migrate = () => pg.transaction(tx => migratePrivateSchema(adapter(tx)));
  try {
    await migrate();
    await client.query("INSERT INTO users(id,name) VALUES (2,'Second household')");
    await seedUserCategories(client, 1);
    await seedUserCategories(client, 2);
    await client.query("DELETE FROM app_migrations WHERE id='plaid-transaction-directions-v1'");
    await client.query(`
      INSERT INTO transactions(id,user_id,date,description,amount,direction,source,category,is_fixed,income_role,pay_mode,category_corrected) VALUES
        (1,1,'2026-10-01','PENNYMAC',2325.69,'CREDIT','plaid','Mortgage',TRUE,'income',NULL,TRUE),
        (2,1,'2026-10-01','ACME PAYROLL',3000,'DEBIT','plaid','Other',FALSE,NULL,'manual',FALSE),
        (3,2,'2026-10-01','STATE FARM',574.25,'CREDIT','plaid','Insurance',TRUE,'other',NULL,TRUE),
        (4,2,'2026-10-01','GLOBEX PAYROLL',2000,'DEBIT','plaid','Other',FALSE,NULL,NULL,FALSE),
        (5,1,'2026-10-01','CSV MORTGAGE',2325.69,'DEBIT','checking.csv','Mortgage',TRUE,NULL,'auto',TRUE),
        (6,1,'2026-10-01','MANUAL PAYROLL',1000,'CREDIT','manual','Salary',FALSE,'income',NULL,TRUE);
      UPDATE transactions SET plaid_transaction_id='linked-statement' WHERE id=5;
      INSERT INTO transaction_import_reviews(id,user_id,source,date,description,amount,direction,plaid_transaction_id,candidate_transaction_ids,status) VALUES
        (1,1,'plaid','2026-10-01','PENNYMAC',2325.69,'CREDIT','review-1','{6}','pending'),
        (2,2,'plaid','2026-10-01','STATE FARM',574.25,'CREDIT','review-2','{1}','pending'),
        (3,1,'statement.csv','2026-10-01','CSV REVIEW',100,'DEBIT',NULL,'{}','pending'),
        (4,1,'plaid','2026-10-01','RESOLVED BILL',100,'CREDIT','review-4','{}','duplicate');
      SELECT set_config('app.user_id','2',false);
    `);
    await client.query("INSERT INTO app_migrations(id) VALUES('plaid-transaction-directions-v1')");
    await migrate();
    await client.query("DELETE FROM app_migrations WHERE id='plaid-transaction-directions-v1'");
    const untouched = (await client.query('SELECT * FROM transactions WHERE id IN (5,6) ORDER BY id')).rows;
    await migrate();
    const rows = (await client.query('SELECT * FROM transactions ORDER BY id')).rows;
    assert.deepEqual(rows.map(row => row.direction), ['DEBIT', 'CREDIT', 'DEBIT', 'CREDIT', 'DEBIT', 'CREDIT']);
    assert.deepEqual(rows.map(row => row.category), ['Mortgage', 'Salary', 'Insurance', 'Salary', 'Mortgage', 'Salary']);
    assert.equal(rows[0].is_fixed, true);
    assert.equal(rows[2].is_fixed, true);
    assert.equal(rows[0].income_role, null);
    assert.equal(rows[2].income_role, null);
    assert.equal(rows[1].pay_mode, null);
    assert.deepEqual(rows.slice(4), untouched, 'statement/manual records, including linked statement rows, are untouched');
    const reviews = (await client.query('SELECT * FROM transaction_import_reviews ORDER BY id')).rows;
    assert.deepEqual(reviews.map(row => row.direction), ['DEBIT', 'DEBIT', 'DEBIT', 'DEBIT']);
    assert.deepEqual(reviews[0].candidate_transaction_ids, [1, 5]);
    assert.deepEqual(reviews[1].candidate_transaction_ids, [3], 'review candidates never cross households');
    assert.equal(reviews[3].status, 'duplicate', 'explicit review resolutions are preserved');
    assert.equal((await client.query("SELECT current_setting('app.user_id') AS id")).rows[0].id, '2');
    assert.deepEqual(incomeSources(rows, new Date(2026, 9, 20)).map(source => source.name),
      ['Acme Payroll', 'Globex Payroll', 'Manual Payroll']);
    await migrate();
    assert.deepEqual((await client.query('SELECT * FROM transactions ORDER BY id')).rows, rows);
    assert.deepEqual((await client.query('SELECT * FROM transaction_import_reviews ORDER BY id')).rows, reviews);
    assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM app_migrations WHERE id='plaid-transaction-directions-v1'")).rows[0].count, 1);
    const newTransaction = (await client.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source,transfer_checked)
      VALUES(1,'2026-10-02','NEW BANK PURCHASE',20,'DEBIT','plaid',TRUE) RETURNING id`, [])).rows[0];
    await migrate();
    assert.equal((await client.query('SELECT direction FROM transactions WHERE id=$1', [newTransaction.id])).rows[0].direction,
      'DEBIT', 'later startups never flip transactions imported by the corrected mapping');
  } finally {
    await pg.close();
  }
});

test('Plaid sync uses normalized directions for additions, modifications, reviews, and pending replacements', async () => {
  const pg = new PGlite();
  const client = adapter(pg);
  const envNames = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENVIRONMENT', 'PLAID_TOKEN_ENCRYPTION_KEY'];
  const previousEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  const originalSync = PlaidApi.prototype.transactionsSync;
  const originalAccounts = PlaidApi.prototype.accountsGet;
  const raw = (id, amount, name, extra = {}) => ({
    transaction_id: id, account_id: 'checking-1', date: '2026-10-01', amount, name, pending: false, ...extra
  });
  let changes = {
    added: [raw('bill-1', 500, 'MORTGAGE'), raw('pay-1', -3000, 'ACME PAYROLL'),
      raw('pending-1', 50, 'UTILITY', { pending: true }), raw('overlap-1', 100, 'STATEMENT BILL'),
      raw('adjustment-1', -25, 'ACME PAYROLL'),
      raw('venmo-1', 120, 'Venmo', { original_description: 'VENMO RECIPIENT ONE' })],
    modified: [], removed: [], next_cursor: 'cursor-1', has_more: false
  };
  try {
    process.env.PLAID_CLIENT_ID = 'test-client';
    process.env.PLAID_SECRET = 'test-secret';
    process.env.PLAID_ENVIRONMENT = 'sandbox';
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
    await seedUserCategories(client, 1);
    await client.query(`INSERT INTO transaction_labels(user_id,pattern,match_type,is_fixed,enabled)
      VALUES(1,'MORTGAGE','merchant',TRUE,TRUE)`);
    await client.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source,category)
      VALUES(1,'2026-10-01','STATEMENT BILL',100,'DEBIT','checking.csv','Other')`);
    const connection = (await client.query(`INSERT INTO plaid_connections(user_id,item_id,access_token_ciphertext,status)
      VALUES(1,'item-1',$1,'connected') RETURNING id`, [encryptPlaidToken('test-access')])).rows[0];
    PlaidApi.prototype.transactionsSync = async request => {
      assert.equal(request.access_token, 'test-access');
      assert.deepEqual(request.options, { include_original_description: true });
      return { data: changes };
    };
    PlaidApi.prototype.accountsGet = async () => ({ data: { accounts: [{
      account_id: 'checking-1', name: 'Checking', type: 'depository', subtype: 'checking',
      balances: { current: 2000, available: 1900, iso_currency_code: 'USD' }
    }] } });
    const sync = () => withUser(1, () => pg.transaction(async tx => {
      const tenant = adapter(tx);
      await tenant.query("SET LOCAL ROLE finance_app_runtime");
      await tenant.query("SELECT set_config('app.user_id',$1,true)", ['1']);
      return syncConnection(tenant, connection.id);
    }));
    await sync();
    let rows = (await client.query('SELECT * FROM transactions ORDER BY id')).rows;
    const bill = rows.find(row => row.plaid_transaction_id === 'bill-1');
    const paycheck = rows.find(row => row.plaid_transaction_id === 'pay-1');
    assert.equal(bill.direction, 'DEBIT');
    assert.equal(bill.is_fixed, true);
    assert.equal(paycheck.direction, 'CREDIT');
    assert.equal(paycheck.category, 'Salary');
    assert.equal(rows.find(row => row.plaid_transaction_id === 'venmo-1').description, 'VENMO RECIPIENT ONE');
    assert.deepEqual(incomeSources(rows, new Date(2026, 9, 20)).map(source => source.name), ['Acme Payroll']);
    const review = (await client.query("SELECT * FROM transaction_import_reviews WHERE plaid_transaction_id='overlap-1'")).rows[0];
    assert.equal(review.direction, 'DEBIT');
    assert.deepEqual(review.candidate_transaction_ids, [rows[0].id]);
    const pendingId = rows.find(row => row.plaid_transaction_id === 'pending-1').id;
    changes = {
      added: [raw('posted-1', 55, 'UTILITY', { pending_transaction_id: 'pending-1', original_description: 'UTILITY ONLINE PMT' }),
        raw('pay-2', -3000, 'ACME PAYROLL', { date: '2026-10-15' })],
      modified: [raw('bill-1', 525, 'MORTGAGE'), raw('overlap-1', -100, 'REFUND', { original_description: 'BANK REFUND DETAILS' }),
        raw('adjustment-1', 25, 'ACME PAYROLL'),
        raw('venmo-1', 120, 'Venmo', { original_description: 'VENMO RECIPIENT ONE UPDATED' })],
      removed: [{ transaction_id: 'pending-1' }], next_cursor: 'cursor-2', has_more: false
    };
    await sync();
    rows = (await client.query('SELECT * FROM transactions ORDER BY id')).rows;
    const posted = rows.find(row => row.plaid_transaction_id === 'posted-1');
    assert.equal(posted.id, pendingId, 'posting retains the existing transaction identity');
    assert.equal(posted.direction, 'DEBIT');
    assert.equal(Number(posted.amount), 55);
    assert.equal(posted.is_pending, false);
    assert.equal(posted.description, 'UTILITY ONLINE PMT');
    assert.equal(rows.find(row => row.plaid_transaction_id === 'venmo-1').description, 'VENMO RECIPIENT ONE UPDATED');
    assert.equal(Number(rows.find(row => row.id === bill.id).amount), 525);
    assert.equal(rows.find(row => row.id === bill.id).direction, 'DEBIT');
    const adjustment = rows.find(row => row.plaid_transaction_id === 'adjustment-1');
    assert.equal(adjustment.direction, 'DEBIT');
    assert.equal(adjustment.category, 'Other', 'automatic Salary classification is removed when an adjustment becomes money out');
    const updatedReview = (await client.query('SELECT * FROM transaction_import_reviews WHERE id=$1', [review.id])).rows[0];
    assert.equal(updatedReview.direction, 'CREDIT');
    assert.equal(updatedReview.description, 'BANK REFUND DETAILS');
    assert.deepEqual(updatedReview.candidate_transaction_ids, [], 'changed directions invalidate stale overlap candidates');
    assert.equal((await client.query('SELECT cursor FROM plaid_connections WHERE id=$1', [connection.id])).rows[0].cursor, 'cursor-2');
    const forecast = projectIncome(rows, new Date(2026, 9, 20), { through: new Date(2026, 10, 5) });
    assert.ok(forecast.items.some(item => item.status === 'projected' && item.amount === 3000));
    assert.ok(forecast.items.every(item => item.incomeKey === 'ACME PAYROLL'));
    changes = { added: [], modified: [], removed: [], next_cursor: 'cursor-2', has_more: false };
    await sync();
    assert.deepEqual((await client.query('SELECT * FROM transactions ORDER BY id')).rows, rows, 'replays do not duplicate transactions');
    changes = { ...changes, modified: [raw('bill-1', 525, 'MORTGAGE', { date: '2026-02-30' })], next_cursor: 'invalid-cursor' };
    await assert.rejects(sync(), /Invalid transaction date/);
    assert.deepEqual((await client.query('SELECT * FROM transactions ORDER BY id')).rows, rows);
    assert.equal((await client.query('SELECT cursor FROM plaid_connections WHERE id=$1', [connection.id])).rows[0].cursor, 'cursor-2',
      'an invalid provider update cannot advance the sync cursor');
  } finally {
    PlaidApi.prototype.transactionsSync = originalSync;
    PlaidApi.prototype.accountsGet = originalAccounts;
    for (const key of envNames) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await pg.close();
  }
});

test('a failed legacy repair rolls back directions and its migration marker together', async () => {
  const pg = new PGlite();
  const client = adapter(pg);
  try {
    await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
    await client.query("DELETE FROM app_migrations WHERE id='plaid-transaction-directions-v1'");
    await client.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source)
      VALUES(1,'2026-10-01','BILL',100,'CREDIT','plaid');
      INSERT INTO transaction_import_reviews(user_id,source,date,description,amount,direction,status)
      VALUES(1,'plaid','invalid-date','LEGACY BILL',100,'CREDIT','pending')`);
    await assert.rejects(pg.transaction(tx => repairLegacyPlaidDirections(adapter(tx))), /Invalid transaction date/);
    assert.equal((await client.query('SELECT direction FROM transactions')).rows[0].direction, 'CREDIT');
    assert.equal((await client.query('SELECT direction FROM transaction_import_reviews')).rows[0].direction, 'CREDIT');
    assert.equal((await client.query("SELECT COUNT(*)::int AS count FROM app_migrations WHERE id='plaid-transaction-directions-v1'")).rows[0].count, 0);
  } finally {
    await pg.close();
  }
});
