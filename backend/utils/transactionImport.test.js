import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  importReviewedTransaction, importTransactions, refreshImportReviewCandidates, validateImportedTransaction
} from './transactionImport.js';
import { withUser } from './tenant.js';
import { migratePrivateSchema } from './schema.js';
import { releaseHeldPlaidReviews } from './transactionImport.js';
import { isIncomeTransaction } from './income.js';

test('transaction imports strictly validate calendar dates, direction, amount, and description', () => {
  assert.equal(validateImportedTransaction({
    date: '05/20/2026', description: '  Local   Market ', amount: 12.34, direction: 'debit'
  }).date, '2026-05-20');
  for (const transaction of [
    { date: '2026-02-30', description: 'Shop', amount: 1, direction: 'DEBIT' },
    { date: '2026-01-01', description: 'Shop', amount: 1.001, direction: 'DEBIT' },
    { date: '2026-01-01', description: 'Shop', amount: -1, direction: 'DEBIT' },
    { date: '2026-01-01', description: 'Shop', amount: 1, direction: 'TRANSFER' },
    { date: '2026-01-01', description: ' ', amount: 1, direction: 'DEBIT' }
  ]) assert.throws(() => validateImportedTransaction(transaction), { status: 400 });
});

test('Plaid overlaps are included with flags, file overlaps stay held, and replays are idempotent', async () => {
  const pg = new PGlite();
  await pg.exec(`
    SELECT set_config('app.user_id','1',false);
    CREATE TABLE categories (id SERIAL PRIMARY KEY, user_id INT, name TEXT UNIQUE);
    CREATE TABLE transaction_labels (
      id SERIAL PRIMARY KEY, user_id INT, pattern TEXT, category_id INT, display_label TEXT,
      is_fixed BOOLEAN DEFAULT FALSE, is_excluded BOOLEAN DEFAULT FALSE, match_type TEXT DEFAULT 'merchant',
      enabled BOOLEAN DEFAULT TRUE, priority INT DEFAULT 0
    );
    CREATE TABLE transactions (
      id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      date TEXT NOT NULL, description TEXT NOT NULL, amount NUMERIC(14,2) NOT NULL, direction TEXT NOT NULL,
      balance NUMERIC(14,2), source TEXT, category TEXT, label_id INT, is_fixed BOOLEAN DEFAULT FALSE,
      plaid_transaction_id TEXT, plaid_account_id TEXT, is_pending BOOLEAN DEFAULT FALSE,
      category_corrected BOOLEAN DEFAULT FALSE, display_name TEXT,account_id INT
    );
    CREATE UNIQUE INDEX transactions_user_plaid_transaction_key
      ON transactions (user_id, plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL;
    CREATE TABLE transaction_import_reviews (
      id SERIAL PRIMARY KEY, source TEXT NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL, direction TEXT NOT NULL, balance NUMERIC(14,2), category TEXT,
      plaid_transaction_id TEXT, plaid_account_id TEXT, is_pending BOOLEAN DEFAULT FALSE,
      candidate_transaction_ids INTEGER[] NOT NULL DEFAULT '{}', status TEXT DEFAULT 'pending',
      user_id INTEGER NOT NULL,resolution_transaction_id INTEGER,matched_transaction_id INTEGER,resolved_at TIMESTAMPTZ
    );
    CREATE TABLE accounts(id SERIAL PRIMARY KEY,user_id INT,last4 TEXT,institution TEXT,kind TEXT);
    CREATE TABLE plaid_accounts(id SERIAL PRIMARY KEY,user_id INT,account_id TEXT,connection_id INT,mask TEXT,subtype TEXT,type TEXT,iso_currency_code TEXT);
    CREATE TABLE plaid_connections(id SERIAL PRIMARY KEY,user_id INT,institution_name TEXT);
    CREATE UNIQUE INDEX import_reviews_user_plaid_transaction_key
      ON transaction_import_reviews (user_id, plaid_transaction_id)
      WHERE plaid_transaction_id IS NOT NULL AND status='pending';
  `);
  const client = {
    query: async (sql, params) => {
      const result = await pg.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }
  };
  const config = { compiled: [], names: new Set(['Other']) };
  try {
    await withUser(1, async () => {
      const initial = await importTransactions(client, [
        { date: '2026-05-20', description: 'TACO BELL', amount: 15.50, direction: 'DEBIT' },
        { date: '2026-05-22', description: 'Electric utility', amount: 82.10, direction: 'DEBIT' }
      ], config, 'checking');
      assert.equal(initial.imported, 2);

      const plaidRecord = {
        date: '2026-05-21', description: 'TACO BELL #1234', amount: 15.50, direction: 'DEBIT',
        plaidTransactionId: 'plaid-transaction-1', plaidAccountId: 'plaid-account-1'
      };
      const held = await importTransactions(client, [plaidRecord], config, 'Plaid');
      assert.deepEqual(held, { imported: 1, duplicates: 0, needsReview: 1, excluded: 0 });
      const replay = await importTransactions(client, [plaidRecord], config, 'Plaid');
      assert.equal(replay.duplicates, 1);
      assert.equal((await client.query('SELECT id FROM transactions')).rows.length, 3);
      const review = (await client.query('SELECT * FROM transaction_import_reviews WHERE status=$1', ['pending'])).rows[0];
      assert.equal(review.plaid_transaction_id, 'plaid-transaction-1');
      assert.deepEqual(review.candidate_transaction_ids, [1]);
      assert.ok(review.resolution_transaction_id);

      const repeatedCsvRow = await importTransactions(client, [
        { date: '2026-05-20', description: 'TACO BELL', amount: 15.50, direction: 'DEBIT' }
      ], config, 'checking');
      assert.equal(repeatedCsvRow.imported, 0);
      assert.equal(repeatedCsvRow.needsReview, 1);
      assert.equal((await client.query('SELECT id FROM transactions')).rows.length, 3);
    });
  } finally {
    await pg.close();
  }
});

test('a review refreshes newly appeared matches before allowing a separate import', async () => {
  const pg = new PGlite();
  await pg.exec(`
    SELECT set_config('app.user_id','1',false);
    CREATE TABLE categories (id SERIAL PRIMARY KEY, user_id INT, name TEXT UNIQUE);
    CREATE TABLE transaction_labels (
      id SERIAL PRIMARY KEY, user_id INT, pattern TEXT, category_id INT, display_label TEXT,
      is_fixed BOOLEAN DEFAULT FALSE, is_excluded BOOLEAN DEFAULT FALSE, match_type TEXT DEFAULT 'merchant',
      enabled BOOLEAN DEFAULT TRUE, priority INT DEFAULT 0
    );
    CREATE TABLE transactions (
      id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      date TEXT NOT NULL, description TEXT NOT NULL, amount NUMERIC(14,2) NOT NULL, direction TEXT NOT NULL,
      balance NUMERIC(14,2), source TEXT, category TEXT, label_id INT, is_fixed BOOLEAN DEFAULT FALSE,
      plaid_transaction_id TEXT, plaid_account_id TEXT, is_pending BOOLEAN DEFAULT FALSE,
      category_corrected BOOLEAN DEFAULT FALSE, display_name TEXT
    );
    CREATE TABLE transaction_import_reviews (
      id SERIAL PRIMARY KEY, source TEXT NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL, direction TEXT NOT NULL, balance NUMERIC(14,2), category TEXT,
      plaid_transaction_id TEXT, plaid_account_id TEXT, is_pending BOOLEAN DEFAULT FALSE,
      candidate_transaction_ids INTEGER[] NOT NULL DEFAULT '{}', status TEXT DEFAULT 'pending',
      user_id INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX import_reviews_user_plaid_transaction_key
      ON transaction_import_reviews (user_id, plaid_transaction_id)
      WHERE plaid_transaction_id IS NOT NULL AND status='pending';
  `);
  const client = {
    query: async (sql, params) => {
      const result = await pg.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }
  };
  const config = { compiled: [], names: new Set(['Other']) };
  try {
    await withUser(1, async () => {
      const incoming = {
        date: '2026-05-20', description: 'Local Market', amount: 24.75, direction: 'DEBIT'
      };
      await importTransactions(client, [incoming], config, 'manual');
      await importTransactions(client, [incoming, incoming], config, 'checking');
      const reviews = (await client.query(
        'SELECT * FROM transaction_import_reviews ORDER BY id'
      )).rows;
      assert.equal(reviews.length, 2);
      assert.deepEqual(reviews[1].candidate_transaction_ids, [1]);

      const firstId = await importReviewedTransaction(client, reviews[0], config);
      assert.equal(await refreshImportReviewCandidates(client, reviews[1]), true);
      const refreshed = (await client.query(
        'SELECT candidate_transaction_ids FROM transaction_import_reviews WHERE id=$1', [reviews[1].id]
      )).rows[0];
      assert.deepEqual(refreshed.candidate_transaction_ids, [1, firstId].sort((a, b) => a - b));
      assert.equal((await client.query('SELECT id FROM transactions')).rows.length, 2);
    });

  } finally {
    await pg.close();
  }
});

test('Plaid matching links only verified unique exact matches and never suppresses unrelated salary or real payments', async () => {
  const pg = new PGlite();
  const adapter = database => ({ async query(sql, params = []) {
    const result = params.length ? await database.query(sql, params) : (await database.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } });
  await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
  const client = adapter(pg);
  await client.query("SELECT set_config('app.user_id','1',false)");
  await client.query(`INSERT INTO users(id,name) VALUES(2,'Private household');
        INSERT INTO accounts(id,user_id,name,kind,last4,institution) VALUES
          (1,1,'Checking','checking','1234','Example Bank'),(2,1,'Other checking','checking','9999','Example Bank');
        INSERT INTO plaid_connections(id,user_id,item_id,access_token_ciphertext,institution_name,status)
          VALUES(1,1,'bank','unused','Example Bank','connected');
        INSERT INTO plaid_accounts(connection_id,user_id,account_id,name,mask,type,subtype,iso_currency_code)
          VALUES(1,1,'checking','Checking','1234','depository','checking','USD');`);
  const config = { compiled: [], names: new Set(['Other']) };
  const incoming = (id, description, amount, extra = {}) => ({
    date: '2026-11-04', description, amount, direction: 'DEBIT',
    plaidTransactionId: id, plaidAccountId: 'checking', ...extra
  });
  const statement = (description, amount, account = 1, date = '2026-11-04', user = 1) =>
    client.query(`INSERT INTO transactions(user_id,date,description,amount,direction,source,account_id,category,note)
      VALUES($1,$2,$3,$4,'DEBIT','statement.csv',$5,'Other','Receipt note') RETURNING id`, [user, date, description, amount, account]);
  const run = rows => withUser(1, () => importTransactions(client, rows, config, 'plaid'));
  try {
    const original = (await statement('EXACT MERCHANT REFERENCE 123', 45)).rows[0].id;
    const matched = await run([incoming('exact', 'exact merchant reference 123', 45)]);
    assert.equal(matched.autoMatched, 1);
    assert.equal(matched.imported, 0);
    assert.equal((await client.query("SELECT id,note FROM transactions WHERE plaid_transaction_id='exact'")).rows[0].id, original);
    assert.equal((await client.query("SELECT note FROM transactions WHERE id=$1", [original])).rows[0].note, 'Receipt note');
    assert.equal((await run([incoming('exact', 'exact merchant reference 123', 45)])).duplicates, 1);

    await statement('DIFFERENT UTILITY PAYMENT', 6594.42);
    await run([incoming('salary', 'WELLS FARGO BANK PAYROLL', 6594.42, { direction: 'CREDIT' })]);
    const salary = (await client.query("SELECT * FROM transactions WHERE plaid_transaction_id='salary'")).rows[0];
    assert.equal(salary.date, '2026-11-04');
    assert.equal(isIncomeTransaction(salary), true, 'November 4 payroll reaches income calculations immediately');
    assert.equal((await client.query("SELECT id FROM transaction_import_reviews WHERE plaid_transaction_id='salary'")).rows.length, 0);
    await statement('ZELLE ANOTHER PERSON', 500);
    assert.equal((await run([incoming('amazon', 'AMZ_STORECRD_PMT PAYMENT', 500)])).needsReview, 0, 'unrelated merchants are not compared on amount alone');

    await statement('MARKET REFERENCE 555', 22);
    const repeated = await run([incoming('real-1', 'MARKET REFERENCE 555', 22), incoming('real-2', 'MARKET REFERENCE 555', 22)]);
    assert.equal(repeated.imported, 2, 'distinct provider identities in the same batch stay distinct');
    assert.equal(repeated.autoMatched, undefined);
    assert.equal(repeated.needsReview, 2);
    assert.equal((await run([incoming('real-3', 'MARKET REFERENCE 555', 22)])).imported, 1);

    await statement('CAFE SAME AMOUNT', 30, 2);
    assert.equal((await run([incoming('other-account', 'CAFE SAME AMOUNT', 30)])).needsReview, 0, 'known different accounts never match');
    await statement('FOREIGN RECORD', 31, null, '2026-11-04', 2);
    assert.equal((await run([incoming('foreign', 'FOREIGN RECORD', 31)])).needsReview, 0, 'foreign households never match');
    await statement('RECURRING BILL', 32, 1, '2026-10-04');
    assert.equal((await run([incoming('recurring', 'RECURRING BILL', 32)])).needsReview, 0, 'an earlier monthly payment is not a duplicate');
    await statement('SHIFTED PURCHASE', 33, 1, '2026-11-03');
    assert.equal((await run([incoming('shifted', 'SHIFTED PURCHASE', 33)])).imported, 1, 'date shifts are flagged, not automatically collapsed');
    await statement('UNKNOWN ACCOUNT PURCHASE', 34, null);
    assert.equal((await run([incoming('unknown-account', 'UNKNOWN ACCOUNT PURCHASE', 34)])).needsReview, 1);
    await statement('PENDING PURCHASE', 35);
    assert.equal((await run([incoming('pending', 'PENDING PURCHASE', 35, { isPending: true })])).imported, 1);
    await client.query(`INSERT INTO transaction_import_reviews(user_id,source,date,description,amount,direction,
          plaid_transaction_id,plaid_account_id,status) VALUES
          (1,'plaid','2026-11-04','LEGACY SALARY PAYROLL',7000,'CREDIT','legacy-salary','checking','pending'),
          (1,'plaid','2026-11-04','EXACT MERCHANT REFERENCE 123',45,'DEBIT','exact','checking','pending')`);
    await withUser(1, () => releaseHeldPlaidReviews(client, 1, config));
    assert.ok((await client.query("SELECT id FROM transactions WHERE plaid_transaction_id='legacy-salary'")).rows[0]);
    assert.equal((await client.query("SELECT status FROM transaction_import_reviews WHERE plaid_transaction_id='legacy-salary'")).rows[0].status, 'imported');
    assert.equal((await client.query("SELECT status FROM transaction_import_reviews WHERE plaid_transaction_id='exact'")).rows[0].status, 'duplicate',
      'an older unresolved review of an already-linked identity clears without a second ledger insert');
    await withUser(1, () => releaseHeldPlaidReviews(client, 1, config));
    assert.equal((await client.query("SELECT id FROM transactions WHERE plaid_transaction_id='legacy-salary'")).rows.length, 1);
  } finally { await pg.close(); }
});
