import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  importReviewedTransaction, importTransactions, refreshImportReviewCandidates, validateImportedTransaction
} from './transactionImport.js';
import { withUser } from './tenant.js';

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

test('CSV/PDF/Plaid overlaps are held outside calculations and Plaid replays are idempotent', async () => {
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
    CREATE UNIQUE INDEX transactions_user_plaid_transaction_key
      ON transactions (user_id, plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL;
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
      assert.deepEqual(held, { imported: 0, duplicates: 0, needsReview: 1, excluded: 0 });
      const replay = await importTransactions(client, [plaidRecord], config, 'Plaid');
      assert.equal(replay.duplicates, 1);
      assert.equal((await client.query('SELECT id FROM transactions')).rows.length, 2);
      const review = (await client.query('SELECT * FROM transaction_import_reviews WHERE status=$1', ['pending'])).rows[0];
      assert.equal(review.plaid_transaction_id, 'plaid-transaction-1');
      assert.deepEqual(review.candidate_transaction_ids, [1]);

      const repeatedCsvRow = await importTransactions(client, [
        { date: '2026-05-20', description: 'TACO BELL', amount: 15.50, direction: 'DEBIT' }
      ], config, 'checking');
      assert.equal(repeatedCsvRow.imported, 0);
      assert.equal(repeatedCsvRow.needsReview, 1);
      assert.equal((await client.query('SELECT id FROM transactions')).rows.length, 2);
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
