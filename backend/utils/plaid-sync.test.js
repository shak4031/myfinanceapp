import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PlaidApi } from 'plaid';
import postgres from 'pg';
import express from 'express';
import { migratePrivateSchema, repairLegacyPlaidDirections, seedUserCategories } from './schema.js';
import { encryptPlaidToken } from './plaid.js';
import { incomeSources, projectIncome } from './income.js';
import plaidRouter, { syncConnection, syncDuePlaidConnections } from '../routes/plaid.js';
import { withUser } from './tenant.js';
import { onLogEntry } from './logger.js';

function adapter(pg) {
  return {
    async query(sql, params = []) {
      const result = params.length ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }
  };
}

test('scheduled Plaid failures persist retry state, isolate connections and stop wrong-environment retries', async t => {
  const pg = new PGlite(), client = adapter(pg);
  const events = [];
  const unsubscribe = onLogEntry(entry => { if (entry.event?.startsWith('plaid.')) events.push(entry); });
  const keys = ['PLAID_ENVIRONMENT', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_TOKEN_ENCRYPTION_KEY', 'APP_ORIGIN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.PLAID_ENVIRONMENT = 'production';
    process.env.APP_ORIGIN = 'https://finance.example.com';
    process.env.PLAID_CLIENT_ID = 'test-client';
    process.env.PLAID_SECRET = 'test-secret';
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
    await client.query(`INSERT INTO plaid_connections(user_id,item_id,access_token_ciphertext,status)
      VALUES(1,'old-sandbox',$1,'connected'),(1,'transient-prod',$2,'connected')`,
    [encryptPlaidToken('access-sandbox-private'), encryptPlaidToken('access-production-private')]);
    t.mock.method(postgres.Pool.prototype, 'connect', async () => ({ ...client, release() {} }));
    let remoteCalls = 0;
    t.mock.method(PlaidApi.prototype, 'accountsGet', async () => ({ data: { accounts: [] } }));
    t.mock.method(PlaidApi.prototype, 'transactionsSync', async () => {
      remoteCalls++;
      throw { response: { status: 400, data: { error_code: 'PRODUCT_NOT_READY', request_id: 'provider-request-123', error_type: 'ITEM_ERROR' } } };
    });
    const messages = [];
    await syncDuePlaidConnections((level, event) => messages.push(event));
    const rows = (await client.query('SELECT status,last_error_code,last_sync_attempt_at FROM plaid_connections ORDER BY id')).rows;
    assert.equal(rows[0].status, 'relink_required');
    assert.equal(rows[0].last_error_code, 'PLAID_ENVIRONMENT_MISMATCH');
    assert.equal(rows[1].status, 'connected');
    assert.equal(rows[1].last_error_code, 'PRODUCT_NOT_READY');
    assert.ok(rows.every(row => row.last_sync_attempt_at));
    assert.equal(remoteCalls, 1, 'wrong-environment token never reaches Plaid');
    assert.equal(messages.length, 2);
    assert.equal(JSON.stringify(messages).includes('private'), false);
    const failures = events.filter(entry => entry.event === 'plaid.sync_failed');
    assert.equal(failures.length, 2);
    assert.equal(failures[0].operation, 'configuration');
    assert.equal(failures[0].connectionId, 1);
    assert.equal(failures[1].operation, 'transactions_fetch');
    assert.equal(failures[1].providerRequestId, 'provider-request-123');
    assert.equal(failures[1].errorCode, 'PRODUCT_NOT_READY');
    assert.equal(JSON.stringify(events).includes('private'), false);
    await client.query(`INSERT INTO users(id,name,email) VALUES(3,'Demo','demo@myfinance.app');
      INSERT INTO plaid_connections(user_id,item_id,access_token_ciphertext,status) VALUES(3,'demo-sandbox','x','connected');`);
    await syncDuePlaidConnections(() => assert.fail('connections should not retry immediately and the demo never syncs'));
    assert.equal(remoteCalls, 1, 'permanent mismatch stops; transient errors respect six-hour backoff');
    assert.equal((await client.query("SELECT last_sync_attempt_at FROM plaid_connections WHERE item_id='demo-sandbox'")).rows[0].last_sync_attempt_at, null);
    await client.query(`INSERT INTO users(id,name) VALUES(2,'Other household');
      INSERT INTO plaid_accounts(connection_id,user_id,account_id,name) VALUES(1,1,'old-account','Old checking');
      INSERT INTO transactions(user_id,date,description,amount,direction,source,plaid_account_id)
        VALUES(1,'2026-10-26','Stored history',500,'DEBIT','plaid','old-account');`);
    t.mock.method(PlaidApi.prototype, 'itemRemove', () => assert.fail('never send a sandbox token to production for removal'));
    t.mock.method(PlaidApi.prototype, 'linkTokenCreate', request => {
      if (request.access_token) assert.fail('update Link cannot convert environments');
      throw { response: { status: 400, data: {
        error_code: 'INVALID_FIELD', error_type: 'INVALID_REQUEST', request_id: 'plaid-request-123'
      } } };
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => withUser(Number(req.headers['x-test-user'] || 1), next));
    app.use('/plaid', plaidRouter);
    app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/plaid`;
    try {
      t.mock.method(PlaidApi.prototype, 'transactionsSync', async () => ({ data: {
        added: [{ transaction_id: 'invalid', account_id: 'checking', date: '2026-11-09', amount: 1.001, name: 'Private merchant' }],
        modified: [], removed: [], next_cursor: 'must-not-save', has_more: false, request_id: 'validation-request-123'
      } }));
      const invalid = await fetch(`${base}/connections/2/sync`, { method: 'POST' });
      assert.equal(invalid.status, 502);
      assert.match((await invalid.json()).error, /invalid transaction amount.*No transaction changes were saved/);
      const failedConnection = (await client.query('SELECT last_error_code,cursor FROM plaid_connections WHERE id=2')).rows[0];
      assert.equal(failedConnection.last_error_code, 'PLAID_INVALID_TRANSACTION_AMOUNT');
      assert.equal(failedConnection.cursor, null);
      const validationEvent = events.filter(entry => entry.event === 'plaid.sync_failed').at(-1);
      assert.equal(validationEvent.operation, 'transactions_validate');
      assert.equal(validationEvent.providerRequestId, 'validation-request-123');
      assert.match(validationEvent.message, /rolled back.*cursor is unchanged/);
      assert.equal(JSON.stringify(validationEvent).includes('Private merchant'), false);
      for (const [path, body] of [['/connections/1/update-link', {}], ['/link-token', { connectionId: 1 }]]) {
        const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        assert.equal(response.status, 409, JSON.stringify(result));
        assert.match(result.error, /Disconnect the old connection/);
      }
      const linkFailure = await fetch(`${base}/link-token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      assert.equal(linkFailure.status, 502);
      assert.match((await linkFailure.json()).error, /could not prepare the secure bank connection/);
      const linkFailureEvent = events.find(entry => entry.event === 'plaid.link_token_failed');
      assert.equal(linkFailureEvent.operation, 'link_token_create');
      assert.equal(linkFailureEvent.errorCode, 'INVALID_FIELD');
      assert.equal(linkFailureEvent.errorType, 'INVALID_REQUEST');
      assert.equal(linkFailureEvent.providerRequestId, 'plaid-request-123');
      assert.equal(JSON.stringify(linkFailureEvent).includes('private'), false);
      assert.equal((await fetch(`${base}/connections/1`, { method: 'DELETE', headers: { 'x-test-user': '2' } })).status, 404);
      const disconnected = await fetch(`${base}/connections/1`, { method: 'DELETE' });
      assert.equal(disconnected.status, 200);
      const result = await disconnected.json();
      assert.equal(result.remoteRevoked, false);
      assert.match(result.message, /remote item was not revoked/);
      assert.equal((await client.query('SELECT id FROM plaid_connections WHERE id=1')).rows.length, 0);
      assert.equal((await client.query('SELECT description FROM transactions')).rows[0].description, 'Stored history');
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally {
    unsubscribe();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await pg.close();
  }
});

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
    assert.deepEqual(reviews[0].candidate_transaction_ids, [], 'distinct Plaid identities and unrelated merchants are no longer candidates');
    assert.deepEqual(reviews[1].candidate_transaction_ids, [], 'review candidates never cross households or compare distinct Plaid identities');
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
    const firstSync = await sync();
    assert.equal(firstSync.pendingReviews, 0, 'new Plaid transactions never wait outside totals');
    assert.equal(firstSync.flaggedReviews, 1, 'possible overlaps are included with flags');
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
    assert.ok(rows.some(row => row.id === review.resolution_transaction_id));
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
    await assert.rejects(sync(), /invalid transaction date/);
    assert.deepEqual((await client.query('SELECT * FROM transactions ORDER BY id')).rows, rows);
    assert.equal((await client.query('SELECT cursor FROM plaid_connections WHERE id=$1', [connection.id])).rows[0].cursor, 'cursor-2',
      'an invalid provider update cannot advance the sync cursor');
    await client.query(`INSERT INTO transaction_import_reviews(user_id,source,date,description,amount,direction,
      plaid_transaction_id,plaid_account_id,status) VALUES
      (1,'plaid','2026-11-04','WELLS FARGO BANK PAYROLL',6594.42,'CREDIT','november-payroll','checking-1','pending')`);
    changes = { added: [], modified: [], removed: [], next_cursor: 'cursor-3', has_more: false };
    const recovered = await sync();
    assert.equal(recovered.released, 1, 'a zero-change sync still releases an older held salary');
    assert.equal(recovered.pendingReviews, 0);
    const salary = (await client.query("SELECT * FROM transactions WHERE plaid_transaction_id='november-payroll'")).rows[0];
    assert.equal(salary.date, '2026-11-04');
    assert.equal(salary.direction, 'CREDIT');
    assert.ok(incomeSources([salary], new Date(2026, 10, 5)).some(row => row.name === 'Wells Fargo Bank'));
    changes = { added: [raw('zero-auth', 0, 'AUTHORIZATION', { pending: true }),
      raw('posted-zero', 0, 'CANCELLED AUTHORIZATION', { pending_transaction_id: 'posted-1' }),
      raw('valid-after-zero', 12.34, 'MARKET')],
    modified: [raw('bill-1', 0, 'VOIDED BILL')], removed: [], next_cursor: 'cursor-4', has_more: false };
    const zeroSync = await sync();
    assert.equal(zeroSync.ignoredZeroAmount, 3);
    assert.equal(zeroSync.imported, 1, 'a zero-dollar authorization cannot block other records');
    const afterZero = (await client.query('SELECT * FROM transactions')).rows;
    assert.ok(afterZero.some(row => row.plaid_transaction_id === 'valid-after-zero'));
    assert.ok(!afterZero.some(row => ['zero-auth', 'posted-zero', 'posted-1', 'bill-1'].includes(row.plaid_transaction_id)),
      'zero updates retire previous amounts and pending records, without saving zero ledger entries');
    assert.equal((await client.query('SELECT cursor FROM plaid_connections WHERE id=$1', [connection.id])).rows[0].cursor, 'cursor-4');
    changes = { ...changes, added: [raw('bad-amount', 1.001, 'MARKET')], modified: [], next_cursor: 'bad-amount-cursor' };
    await assert.rejects(sync(), { code: 'PLAID_INVALID_TRANSACTION_AMOUNT' });
    assert.deepEqual((await client.query('SELECT * FROM transactions')).rows, afterZero);
    assert.equal((await client.query('SELECT cursor FROM plaid_connections WHERE id=$1', [connection.id])).rows[0].cursor, 'cursor-4');
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
