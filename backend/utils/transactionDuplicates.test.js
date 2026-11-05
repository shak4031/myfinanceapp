import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { PlaidApi } from 'plaid';
import Database from '../db.js';
import reviewRouter from '../routes/import-review.js';
import dashboardRouter from '../routes/dashboard.js';
import { syncConnection } from '../routes/plaid.js';
import { encryptPlaidToken } from './plaid.js';
import { migratePrivateSchema, seedUserCategories } from './schema.js';
import { listTransactionDuplicates, mergeTransactionDuplicate, mergeTransactionDuplicates } from './transactionDuplicates.js';
import { detectIncomeStreams, incomeSources } from './income.js';
import { withUser, currentUserId } from './tenant.js';

const adapter = pg => ({ async query(sql, params = []) {
  const result = params.length ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
} });
async function fixture() {
  const pg = new PGlite(), client = adapter(pg);
  await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
  await client.query("INSERT INTO users(id,name) VALUES(2,'Second household')");
  await seedUserCategories(client, 1);
  await seedUserCategories(client, 2);
  await client.query(`
    INSERT INTO accounts(id,user_id,name,kind,last4) VALUES
      (1,1,'Payroll checking','checking','5237'),(2,1,'Other checking','checking','9999');
    INSERT INTO plaid_connections(id,user_id,item_id,access_token_ciphertext,status)
      VALUES(1,1,'item-1','unused','connected'),(2,2,'item-2','unused','connected');
    INSERT INTO plaid_accounts(connection_id,user_id,account_id,name,mask,type,iso_currency_code)
      VALUES(1,1,'bank-1','Payroll checking','5237','depository','USD'),
        (2,2,'foreign-bank','Foreign checking','5237','depository','USD');
    INSERT INTO transactions(id,user_id,date,description,amount,direction,source,category,account_id,is_fixed,pay_mode,income_role,display_name,name_override,category_corrected) VALUES
      (1,1,'2026-10-07','WELLS FARGO BANK PAYROLL',6200,'CREDIT','october.csv','Salary',1,TRUE,NULL,'income','My pay',TRUE,TRUE),
      (2,1,'2026-10-21','WELLS FARGO BANK PAYROLL',6200,'CREDIT','october.csv','Salary',1,TRUE,NULL,'income','My pay',TRUE,TRUE),
      (3,1,'2026-10-22','HYUNDAI LEASE ONLINE PMT',443,'DEBIT','october.csv','Car Loans',1,TRUE,'auto',NULL,'My car',TRUE,TRUE),
      (4,1,'2026-10-21','SEPARATE ACCOUNT PAYROLL',6200,'CREDIT','other.csv','Salary',2,FALSE,NULL,NULL,NULL,FALSE,FALSE),
      (5,2,'2026-10-21','FOREIGN HOUSEHOLD PAYROLL',6200,'CREDIT','foreign.csv','Salary',NULL,FALSE,NULL,NULL,NULL,FALSE,FALSE);
    INSERT INTO transactions(id,user_id,date,description,amount,direction,source,category,plaid_transaction_id,plaid_account_id,is_fixed) VALUES
      (10,1,'2026-10-07','WELLS FARGO BANK PAYROLL',6200,'CREDIT','plaid','Salary','pay-1','bank-1',FALSE),
      (11,1,'2026-10-21','WELLS FARGO BANK PAYROLL',6200,'CREDIT','plaid','Salary','pay-2','bank-1',FALSE),
      (12,1,'2026-10-22','HYUNDAI LEASE DEALS',443,'DEBIT','plaid','Other','car-1','bank-1',FALSE),
      (13,2,'2026-10-21','FOREIGN PLAID PAYROLL',6200,'CREDIT','plaid','Salary','foreign-pay','foreign-bank',FALSE);
    UPDATE transactions SET transfer_checked=TRUE;
  `);
  const run = (userId, callback) => withUser(userId, () => pg.transaction(async tx => {
    const tenant = adapter(tx);
    await tenant.query('SET LOCAL ROLE finance_app_runtime');
    await tenant.query("SELECT set_config('app.user_id',$1,true)", [String(userId)]);
    return callback(tenant);
  }));
  const list = (userId = 1, input) => run(userId, tenant => listTransactionDuplicates(tenant, input));
  const merge = (pair, extra = {}, userId = 1) => run(userId, tenant => mergeTransactionDuplicate(tenant, {
    plaidId: pair.plaid.id, existingId: pair.existing.id, revision: pair.revision, acknowledged: true, ...extra
  }));
  return { pg, client, run, list, merge };
}

test('review only proposes posted cross-source matches in the same household and compatible account', async () => {
  const f = await fixture();
  try {
    const page = await f.list();
    assert.equal(page.total, 3);
    assert.deepEqual(page.rows.map(pair => [pair.plaid.id, pair.existing.id]), [[12, 3], [11, 2], [10, 1]]);
    assert.equal(page.rows[0].existing.account_mask, '5237');
    assert.equal(page.rows[0].plaid.account_name, 'Payroll checking');
    assert.equal(page.rows[0].existing.display_name, 'My car');
    assert.equal(page.rows[0].revision.length, 64);
    assert.deepEqual((await f.list(2)).rows.map(pair => [pair.plaid.id, pair.existing.id]), [[13, 5]]);
    await f.client.query("UPDATE transactions SET is_pending=TRUE WHERE id=12");
    assert.equal((await f.list()).total, 2);
    await f.client.query("UPDATE transactions SET is_pending=FALSE, date='2026-10-26' WHERE id=12");
    assert.equal((await f.list()).total, 2, 'matches more than three days apart are excluded');
    await f.client.query("UPDATE transactions SET date='2026-10-25' WHERE id=12");
    assert.equal((await f.list()).total, 3, 'the three-day boundary is included');
    await f.client.query("UPDATE transactions SET plaid_transaction_id='already-linked' WHERE id=3");
    assert.equal((await f.list()).total, 2);
    await f.client.query("UPDATE plaid_accounts SET iso_currency_code='CAD' WHERE user_id=1");
    assert.equal((await f.list()).total, 0, 'foreign currency is not compared to USD statement history');
    await assert.rejects(f.list(1, { offset: -1 }), { status: 400 });
    await assert.rejects(f.list(1, { offset: 'bad' }), { status: 400 });
  } finally { await f.pg.close(); }
});

test('duplicate merges preserve both notes and reject overflow instead of silently losing comments', async () => {
  const f = await fixture();
  try {
    await f.client.query("UPDATE transactions SET note='Statement receipt' WHERE id=1");
    await f.client.query("UPDATE transactions SET note='Bank context' WHERE id=10");
    const pair = (await f.list()).rows.find(pair => pair.plaid.id === 10);
    await f.merge(pair);
    assert.equal((await f.client.query('SELECT note FROM transactions WHERE id=1')).rows[0].note, 'Statement receipt\nBank context');
    await f.client.query('UPDATE transactions SET note=$1 WHERE id=2', ['x'.repeat(500)]);
    await f.client.query("UPDATE transactions SET note='extra' WHERE id=11");
    const overflow = (await f.list()).rows.find(pair => pair.plaid.id === 11);
    await assert.rejects(() => f.merge(overflow), /Combined notes exceed 500/);
    assert.equal((await f.client.query('SELECT id FROM transactions WHERE id IN (2,11)')).rows.length, 2);
  } finally { await f.pg.close(); }
});
test('confirmed payroll and bill merges fix double counting, retain edits and redirect references', async () => {
  const f = await fixture();
  try {
    await f.client.query(`INSERT INTO transaction_import_reviews(user_id,source,date,description,amount,direction,
      status,resolution_transaction_id,matched_transaction_id,candidate_transaction_ids)
      VALUES(1,'plaid','2026-10-22','HYUNDAI',443,'DEBIT','imported',12,12,'{12,3}');
      UPDATE transactions SET transfer_pair_id=12 WHERE id=1`);
    const settings = (await f.client.query('SELECT * FROM transactions WHERE id=3')).rows[0];
    const page = await f.list();
    const before = (await f.client.query("SELECT * FROM transactions WHERE id IN(1,2,10,11)")).rows;
    const today = new Date(2026, 9, 23);
    assert.equal(detectIncomeStreams(before, today)[0].amount, 12400, 'before merging, each paycheck is counted twice');
    for (const pair of page.rows) await f.merge(pair);
    const kept = (await f.client.query('SELECT * FROM transactions WHERE id=3')).rows[0];
    const { plaid_transaction_id, plaid_account_id, ...rest } = kept;
    const { plaid_transaction_id: oldToken, plaid_account_id: oldAccount, ...oldSettings } = settings;
    assert.deepEqual(rest, oldSettings, 'source, ID, date, amount, category, name and payment choices are preserved');
    assert.equal(plaid_transaction_id, 'car-1');
    assert.equal(plaid_account_id, 'bank-1');
    const review = (await f.client.query('SELECT * FROM transaction_import_reviews')).rows[0];
    assert.equal(review.status, 'imported');
    assert.equal(review.resolution_transaction_id, 3);
    assert.equal(review.matched_transaction_id, 3);
    assert.deepEqual(review.candidate_transaction_ids, [3]);
    assert.equal((await f.client.query('SELECT transfer_pair_id FROM transactions WHERE id=1')).rows[0].transfer_pair_id, null,
      'transfer relationships are recalculated rather than retaining a deleted identity');
    assert.equal((await f.list()).total, 0);
    const after = (await f.client.query('SELECT * FROM transactions WHERE id IN(1,2)')).rows;
    assert.equal(detectIncomeStreams(after, today)[0].amount, 6200);
    assert.equal(Number(after.reduce((sum, row) => sum + Number(row.amount), 0)), 12400);
    assert.equal(incomeSources(after, today)[0].expected * 26 / 12, 6200 * 26 / 12);
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE user_id=2')).rows[0].count, 2);
  } finally { await f.pg.close(); }
});

test('merging a duplicate payment preserves the oldest settlement and reopens a double-settled occurrence', async () => {
  const f = await fixture();
  try {
    const template = (await f.client.query('SELECT * FROM transactions WHERE id=3')).rows[0];
    for (const [key, date, matched] of [['first', '2026-09-22', 12], ['second', '2026-10-22', 3]]) {
      await f.client.query(`INSERT INTO fixed_payment_occurrences
        (user_id,payment_key,due_date,template,amount,status,matched_transaction_id)
        VALUES(1,$1,$2,$3,443,'paid',$4)`, [key, date, JSON.stringify(template), matched]);
    }
    const pair = (await f.list()).rows.find(pair => pair.plaid.id === 12);
    await f.merge(pair);
    const rows = (await f.client.query('SELECT * FROM fixed_payment_occurrences ORDER BY due_date')).rows;
    assert.equal(rows[0].matched_transaction_id, 3);
    assert.equal(rows[0].status, 'paid');
    assert.equal(rows[1].matched_transaction_id, null);
    assert.equal(rows[1].status, 'projected');
  } finally { await f.pg.close(); }
});

test('stale, mismatched, already merged and foreign pairs fail without modifying either record', async () => {
  const f = await fixture();
  try {
    const pair = (await f.list()).rows[0];
    await assert.rejects(f.merge(pair, { acknowledged: false }), { status: 400 });
    await assert.rejects(f.merge(pair, { plaidId: pair.existing.id }), { status: 400 });
    await assert.rejects(f.merge(pair, { revision: 'invalid' }), { status: 400 });
    await assert.rejects(f.merge(pair, {}, 2), { status: 409 });
    await f.client.query("UPDATE transactions SET pay_mode='manual' WHERE id=3");
    await assert.rejects(f.merge(pair), { status: 409 });
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE id IN(3,12)')).rows[0].count, 2);
    const refreshed = (await f.list()).rows[0];
    await f.merge(refreshed);
    await assert.rejects(f.merge(refreshed), { status: 409 });
    const payroll = (await f.list()).rows[0];
    await assert.rejects(f.merge(payroll, { existingId: 4 }), { status: 409 });
    await assert.rejects(f.merge(payroll, { existingId: 5 }), { status: 409 });
    await f.client.query("UPDATE transactions SET plaid_transaction_id='another-bank-tx' WHERE id=$1", [payroll.existing.id]);
    await assert.rejects(f.merge(payroll), { status: 409 });
  } finally { await f.pg.close(); }
});

test('ambiguous repeated amounts require individual choices and never merge multiple bank transactions into one', async () => {
  const f = await fixture();
  try {
    await f.client.query(`INSERT INTO transactions(id,user_id,date,description,amount,direction,source,category,
      plaid_transaction_id,plaid_account_id) VALUES
      (14,1,'2026-10-21','ANOTHER REAL PAYCHECK',6200,'CREDIT','plaid','Salary','pay-3','bank-1')`);
    const page = await f.list();
    assert.equal(page.rows.filter(pair => pair.existing.id === 2).length, 2, 'ambiguous pairs are presented, not automatically removed');
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE id IN(2,11,14)')).rows[0].count, 3);
    await f.merge(page.rows.find(pair => pair.plaid.id === 11));
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE id=14')).rows[0].count, 1);
    await assert.rejects(f.merge(page.rows.find(pair => pair.plaid.id === 14)), { status: 409 });
    assert.equal((await f.list()).rows.some(pair => pair.existing.id === 2), false);
  } finally { await f.pg.close(); }
});

test('duplicate review pagination does not silently truncate matches', async () => {
  const f = await fixture();
  try {
    await f.client.query(`INSERT INTO transactions(id,user_id,date,description,amount,direction,source,plaid_transaction_id,plaid_account_id)
      SELECT 100+i,1,'2026-10-01','BANK PURCHASE',1000+i,'DEBIT','plaid','pagination-'||i,'bank-1'
      FROM generate_series(1,51) i;
      INSERT INTO transactions(id,user_id,date,description,amount,direction,source)
      SELECT 200+i,1,'2026-10-01','STATEMENT PURCHASE',1000+i,'DEBIT','statement.csv'
      FROM generate_series(1,51) i`);
    const first = await f.list();
    const second = await f.list(1, { offset: 50 });
    assert.equal(first.total, 54);
    assert.equal(first.rows.length, 50);
    assert.equal(second.rows.length, 4);
    assert.equal(new Set([...first.rows, ...second.rows].map(pair => pair.plaid.id)).size, 54);
  } finally { await f.pg.close(); }
});

test('a merge failure rolls back reference updates, deletion and bank identity reassignment', async () => {
  const f = await fixture();
  try {
    const pair = (await f.list()).rows[0];
    const before = (await f.client.query('SELECT * FROM transactions ORDER BY id')).rows;
    await f.client.query(`CREATE FUNCTION reject_duplicate_merge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=3 AND NEW.plaid_transaction_id IS NOT NULL THEN RAISE EXCEPTION 'simulated merge failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_duplicate_merge BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION reject_duplicate_merge()`);
    await assert.rejects(f.merge(pair), /simulated merge failure/);
    assert.deepEqual((await f.client.query('SELECT * FROM transactions ORDER BY id')).rows, before);
  } finally { await f.pg.close(); }
});

test('subsequent Plaid sync updates the kept statement row rather than recreating the deleted duplicate', async t => {
  const f = await fixture();
  const envNames = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENVIRONMENT', 'PLAID_TOKEN_ENCRYPTION_KEY'];
  const previous = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  try {
    process.env.PLAID_CLIENT_ID = 'test-client';
    process.env.PLAID_SECRET = 'test-secret';
    process.env.PLAID_ENVIRONMENT = 'sandbox';
    process.env.PLAID_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    await f.client.query('UPDATE plaid_connections SET access_token_ciphertext=$1 WHERE id=1', [encryptPlaidToken('test-access')]);
    await f.client.query("UPDATE transactions SET note='Payroll clarification' WHERE id=2");
    const pair = (await f.list()).rows.find(item => item.plaid.id === 11);
    await f.merge(pair);
    t.mock.method(PlaidApi.prototype, 'transactionsSync', async () => ({ data: {
      added: [{ transaction_id: 'pay-2', account_id: 'bank-1', date: '2026-10-21', amount: -6300,
        name: 'Wells Fargo', original_description: 'UPDATED PLAID PAYROLL DESCRIPTION', pending: false }],
      modified: [], removed: [], next_cursor: 'after-merge', has_more: false
    } }));
    t.mock.method(PlaidApi.prototype, 'accountsGet', async () => ({ data: { accounts: [{
      account_id: 'bank-1', name: 'Checking', mask: '5237', type: 'depository', subtype: 'checking',
      balances: { current: 361.86, iso_currency_code: 'USD' }
    }] } }));
    await f.run(1, client => syncConnection(client, 1));
    const rows = (await f.client.query("SELECT * FROM transactions WHERE plaid_transaction_id='pay-2'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 2);
    assert.equal(Number(rows[0].amount), 6300);
    assert.equal(rows[0].source, 'october.csv');
    assert.equal(rows[0].description, 'WELLS FARGO BANK PAYROLL', 'sync preserves the retained statement description');
    assert.equal(rows[0].income_role, 'income');
    assert.equal(rows[0].display_name, 'My pay');
    assert.equal(rows[0].category_corrected, true);
    assert.equal(rows[0].note, 'Payroll clarification', 'sync preserves transaction-specific notes after a merge');
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE id=11')).rows[0].count, 0);
  } finally {
    for (const key of envNames) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    await f.pg.close();
  }
});

test('duplicate HTTP endpoints list only tenant matches and reject invalid merge requests', async t => {
  const f = await fixture();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => withUser(1, next));
  app.use('/api/import-review', reviewRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  t.mock.method(Database.prototype, 'transaction', callback => f.run(1, callback));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/import-review`;
  try {
    const response = await fetch(`${base}/duplicates`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 3);
    const invalid = await fetch(`${base}/duplicates/merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledged: false })
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Review and confirm/);
    const invalidBulk = await fetch(`${base}/duplicates/merge-bulk`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairs: [], acknowledged: true })
    });
    assert.equal(invalidBulk.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); await f.pg.close(); }
});

test('review decisions clear immediately, accept still-valid selections, remain idempotent and preserve keep-both decisions', async t => {
  const f = await fixture();
  await f.client.query(`INSERT INTO transaction_import_reviews(user_id,source,date,description,amount,direction,
    plaid_transaction_id,plaid_account_id,candidate_transaction_ids,resolution_transaction_id) VALUES
    (1,'plaid','2026-10-21','WELLS FARGO BANK PAYROLL',6200,'CREDIT','pay-2','bank-1','{2}',11),
    (1,'plaid','2026-10-22','HYUNDAI LEASE DEALS',443,'DEBIT','car-1','bank-1','{3}',12);
    INSERT INTO transactions(id,user_id,date,description,amount,direction,source)
    VALUES(14,1,'2026-10-22','WELLS FARGO BANK PAYROLL',6200,'CREDIT','another-statement.csv');
    UPDATE transactions SET note='Bank note' WHERE id=11;
    UPDATE transactions SET note='Receipt note' WHERE id=2;`);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => withUser(Number(req.headers['x-test-user'] || 1), next));
  app.use('/reviews', reviewRouter);
  app.use('/dashboard', dashboardRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  t.mock.method(Database.prototype, 'transaction', callback => f.run(currentUserId(), callback));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/reviews`;
  const resolve = (id, body, user = 1) => fetch(`${base}/reviews/${id}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) }, body: JSON.stringify(body)
  });
  try {
    const initial = await (await fetch(`${base}/reviews?mode=flagged`)).json();
    assert.equal(initial.total, 2);
    const [salary, car] = initial.reviews;
    const activityUrl = `http://127.0.0.1:${server.address().port}/dashboard/all-transactions`;
    const activity = await (await fetch(activityUrl)).json();
    assert.equal(activity.transactions.find(row => row.id === '11').possible_duplicate, true);
    assert.equal(activity.transactions.find(row => row.id === '11').counts_as_income, true, 'flagged payroll still counts as income');
    assert.equal((await resolve(salary.id, { action: 'duplicate', matchTransactionId: 2 }, 2)).status, 404);
    const merged = await resolve(salary.id, { action: 'duplicate', matchTransactionId: 2 });
    assert.equal(merged.status, 200, await merged.text());
    assert.equal((await (await fetch(`${base}/reviews`)).json()).total, 1, 'resolved row no longer appears on first attempt');
    assert.equal((await f.client.query('SELECT note FROM transactions WHERE id=2')).rows[0].note, 'Receipt note\nBank note');
    assert.equal((await resolve(salary.id, { action: 'duplicate', matchTransactionId: 2 })).status, 200, 'double-click or network retry is idempotent');
    assert.equal((await resolve(car.id, { action: 'import' })).status, 200);
    assert.equal((await resolve(car.id, { action: 'import' })).status, 200);
    assert.equal((await (await fetch(`${base}/reviews`)).json()).total, 0);
    assert.ok((await f.client.query('SELECT id FROM transactions WHERE id=12')).rows[0], 'keep both never inserts a second copy');
    assert.equal((await f.list()).rows.some(pair => pair.plaid.id === 12), false, 'keep both does not reappear in the other duplicate queue');
    assert.equal((await resolve(car.id, { action: 'duplicate', matchTransactionId: 3 })).status, 409);

    await f.client.query(`INSERT INTO transaction_import_reviews(user_id,source,date,description,amount,direction)
      SELECT 1,'manual','2026-11-04','Page test ' || n,10,'DEBIT' FROM generate_series(1,27) n`);
    const page1 = await (await fetch(`${base}/reviews?search=Page%20test`)).json();
    const page2 = await (await fetch(`${base}/reviews?search=Page%20test&offset=25`)).json();
    assert.equal(page1.total, 27);
    assert.equal(page1.reviews.length, 25);
    assert.equal(page2.reviews.length, 2);
    assert.equal((await fetch(`${base}/reviews?offset=-1`)).status, 400);
    assert.equal((await fetch(`${base}/reviews?mode=invalid`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); await f.pg.close(); }
});

const choice = pair => ({ plaidId: pair.plaid.id, existingId: pair.existing.id, revision: pair.revision });

test('bulk merge cleans multiple pairs atomically and retains bank identities and user settings', async () => {
  const f = await fixture();
  try {
    const rows = (await f.list()).rows;
    assert.ok(rows.every(pair => pair.bulkEligible));
    const result = await f.run(1, client => mergeTransactionDuplicates(client, { acknowledged: true, pairs: rows.map(choice) }));
    assert.equal(result.merged, 3);
    assert.equal(result.results.length, 3);
    assert.equal((await f.list()).total, 0);
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE id IN(10,11,12)')).rows[0].count, 0);
    const kept = (await f.client.query('SELECT * FROM transactions WHERE id=3')).rows[0];
    assert.equal(kept.pay_mode, 'auto');
    assert.equal(kept.display_name, 'My car');
    assert.equal(kept.plaid_transaction_id, 'car-1');
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE user_id=2')).rows[0].count, 2);
  } finally { await f.pg.close(); }
});

test('a stale or foreign pair rolls back earlier pairs in the entire bulk batch', async () => {
  const f = await fixture();
  try {
    const pairs = (await f.list()).rows.map(choice);
    await f.client.query("UPDATE transactions SET display_name='Changed after review' WHERE id=$1", [pairs[2].existingId]);
    const before = (await f.client.query('SELECT * FROM transactions ORDER BY id')).rows;
    await assert.rejects(f.run(1, client => mergeTransactionDuplicates(client, { acknowledged: true, pairs })), { status: 409 });
    assert.deepEqual((await f.client.query('SELECT * FROM transactions ORDER BY id')).rows, before);
    const foreign = choice((await f.list(2)).rows[0]);
    const own = choice((await f.list()).rows[0]);
    await assert.rejects(f.run(1, client => mergeTransactionDuplicates(client, {
      acknowledged: true, pairs: [own, foreign]
    })), { status: 409 });
    assert.deepEqual((await f.client.query('SELECT * FROM transactions ORDER BY id')).rows, before);
  } finally { await f.pg.close(); }
});

test('bulk selection excludes ambiguous matches globally even when their competitor is on another page', async () => {
  const f = await fixture();
  try {
    await f.client.query(`INSERT INTO transactions(id,user_id,date,description,amount,direction,source,plaid_transaction_id,plaid_account_id)
      VALUES(14,1,'2026-10-21','ANOTHER DEPOSIT',6200,'CREDIT','plaid','pay-3','bank-1')`);
    const all = await f.list(1, { selection: 'all' });
    assert.equal(all.rows.length, 2);
    assert.deepEqual(all.rows.map(pair => pair.plaid.id), [12, 10]);
    assert.ok((await f.list()).rows.filter(pair => pair.existing.id === 2).every(pair => !pair.bulkEligible));
    const ambiguous = (await f.list()).rows.filter(pair => pair.existing.id === 2);
    await assert.rejects(f.run(1, client => mergeTransactionDuplicates(client, {
      acknowledged: true, pairs: ambiguous.map(choice)
    })), { status: 400 });
    assert.equal((await f.client.query('SELECT COUNT(*)::int AS count FROM transactions WHERE id IN(2,11,14)')).rows[0].count, 3);
  } finally { await f.pg.close(); }
});

test('bulk boundaries and repeated transaction selections reject invalid input before writing', async () => {
  const valid = { plaidId: 10, existingId: 1, revision: 'a'.repeat(64) };
  const client = { query() { throw new Error('Invalid input must not reach database'); } };
  for (const input of [
    {}, { acknowledged: true, pairs: [] }, { acknowledged: false, pairs: [valid] },
    { acknowledged: true, pairs: [valid, valid] },
    { acknowledged: true, pairs: Array.from({ length: 501 }, (_, i) => ({ ...valid, plaidId: 1000 + i, existingId: 2000 + i })) },
    { acknowledged: true, pairs: [{ ...valid, existingId: '1' }] }
  ]) await assert.rejects(mergeTransactionDuplicates(client, input), { status: 400 });
});

test('select-all honors the 500-pair boundary without silently truncating', async () => {
  const f = await fixture();
  try {
    await f.client.query(`INSERT INTO transactions(id,user_id,date,description,amount,direction,source,plaid_transaction_id,plaid_account_id)
      SELECT 1000+i,1,'2026-09-01','BANK PURCHASE',10000+i,'DEBIT','plaid','limit-'||i,'bank-1'
      FROM generate_series(1,497) i;
      INSERT INTO transactions(id,user_id,date,description,amount,direction,source)
      SELECT 2000+i,1,'2026-09-01','STATEMENT PURCHASE',10000+i,'DEBIT','statement.csv'
      FROM generate_series(1,497) i`);
    assert.equal((await f.list(1, { selection: 'all' })).rows.length, 500);
    await f.client.query(`INSERT INTO transactions(id,user_id,date,description,amount,direction,source,plaid_transaction_id,plaid_account_id)
      VALUES(4000,1,'2026-09-01','BANK',20000,'DEBIT','plaid','limit-extra','bank-1');
      INSERT INTO transactions(id,user_id,date,description,amount,direction,source)
      VALUES(4001,1,'2026-09-01','STATEMENT',20000,'DEBIT','statement.csv')`);
    await assert.rejects(f.list(1, { selection: 'all' }), { status: 422 });
    assert.equal((await f.list()).rows.length, 50, 'page selection remains available for oversized histories');
    const selected = [];
    for (let offset = 0; offset < 500; offset += 50) selected.push(...(await f.list(1, { offset })).rows.map(choice));
    const result = await f.run(1, client => mergeTransactionDuplicates(client, { acknowledged: true, pairs: selected }));
    assert.equal(result.merged, 500, 'the maximum supported batch is actually merged, not merely accepted');
    assert.equal((await f.list()).total, 1);
  } finally { await f.pg.close(); }
});
