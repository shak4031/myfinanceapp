import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import Database from '../db.js';
import transactionsRouter from '../routes/transactions.js';
import categorizationsRouter from '../routes/categorizations.js';
import { importTransactions } from '../routes/import.js';
import { canonicalMerchant, compileRules, classify, preview, saveRule, loadCategorization, applyUpdates } from './categorization.js';

const names = new Set(['Other', 'Shopping', 'Groceries', 'Dining', 'Subscriptions', 'Salary']);
const merchant = (id, pattern, category, priority = 100, extra = {}) =>
  ({ id, pattern, category, priority, match_type: 'merchant', enabled: true, ...extra });

test('merchant matching is literal, bank-prefix normalized, and exact', () => {
  assert.equal(canonicalMerchant(' VISA DDA PUR AP 123456 A+B   Market '), 'A+B MARKET');
  const rules = compileRules([merchant(1, 'A+B MARKET', 'Groceries')]);
  assert.equal(classify({ description: 'A+B Market' }, rules, names).category, 'Groceries');
  assert.equal(classify({ description: 'AAAB Market' }, rules, names).category, 'Other');
  assert.equal(classify({ description: 'A+B Market Annex' }, rules, names).category, 'Other');
});

test('deterministic priority, specificity, id ordering and enabled rules', () => {
  const rules = compileRules([
    merchant(7, 'STORE', 'Groceries', 0),
    { ...merchant(4, 'STORE', 'Shopping', 1), match_type: 'regex' },
    { ...merchant(3, 'MY STORE', 'Dining', 1), match_type: 'regex' },
    { ...merchant(2, 'MY STORE', 'Subscriptions', 1), match_type: 'regex' },
    merchant(1, 'MY STORE', 'Salary', 1000, { enabled: false })
  ]);
  assert.equal(classify({ description: 'MY STORE' }, rules, names).category, 'Subscriptions');
  assert.equal(classify({ description: 'MY STORE' }, compileRules([...rules, merchant(9, 'MY STORE', 'Groceries', 999)]), names).ruleId, 9);
});

test('legacy regex rules reject unsafe, malformed and oversized patterns explicitly', () => {
  for (const pattern of ['(a+)+$', '[', 'a'.repeat(257), '.*', 'a?'.repeat(50) + 'a'.repeat(50), '\\s*\\s*Z']) {
    assert.throws(() => compileRules([{ ...merchant(42, pattern, 'Shopping'), match_type: 'regex' }]),
      error => error.status === 422 && /42/.test(error.message));
  }
  const rules = compileRules([{ ...merchant(7, 'MY\\s*STORE|GROCERY', 'Groceries'), match_type: 'regex' }]);
  assert.equal(classify({ description: 'MY STORE' }, rules, names).category, 'Groceries');
  assert.deepEqual(compileRules([merchant(9, '(', 'Shopping', 1, { enabled: false })]), []);
});

test('conservative fallbacks do not guess Shopping or Salary from debit/deposit', () => {
  for (const transaction of [{ description: 'UNKNOWN', direction: 'DEBIT' }, { description: 'DEPOSIT WELLS FARGO', direction: 'CREDIT' },
    { description: 'PAYROLL', direction: 'DEBIT' }]) {
    assert.equal(classify(transaction, [], names).category, 'Other');
  }
  assert.equal(classify({ description: 'PAYROLL', direction: 'CREDIT' }, [], names).category, 'Salary');
  assert.equal(classify({ description: 'Starbucks' }, [], names).category, 'Dining');
  assert.equal(classify({ description: 'Starbucks' }, [], new Set(['Other'])).category, 'Other');
});

test('preview protects manual corrections for every scope and returns stable suggestions', () => {
  const rules = compileRules([merchant(1, 'MY STORE', 'Groceries')]);
  const transactions = [
    { id: 1, description: 'MY STORE', category: 'Dining', category_corrected: true },
    { id: 2, description: 'MY STORE', category: 'Dining' },
    { id: 3, description: 'MY STORE', category: null },
    { id: 4, description: 'MY STORE', category: 'Other' },
    { id: 5, description: 'MY STORE', category: 'Groceries' }
  ];
  const all = preview(transactions, rules, names, 'all');
  assert.deepEqual(all.suggestions.map(row => row.id), [2, 3, 4]);
  assert.equal(all.unchanged, 2);
  assert.equal(all.suggestions[1].currentCategory, null);
  assert.deepEqual(preview(transactions, rules, names, 'uncategorized').suggestions.map(row => row.id), [3, 4]);
  assert.throws(() => preview(transactions, rules, names, 'bad'), { status: 400 });
});

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    SELECT set_config('app.user_id','1',false);
    CREATE TABLE categories (id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      name TEXT, UNIQUE(user_id,name));
    CREATE TABLE transaction_labels (id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      pattern TEXT, display_label TEXT, category_id INT REFERENCES categories(id), match_type TEXT DEFAULT 'regex',
      priority INT DEFAULT 0, enabled BOOLEAN DEFAULT TRUE, is_fixed BOOLEAN DEFAULT FALSE, UNIQUE(user_id,pattern));
    CREATE TABLE transactions (id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      date TEXT, description TEXT, category TEXT, previous_category TEXT, category_corrected BOOLEAN DEFAULT FALSE,
      correction_timestamp TIMESTAMPTZ, direction TEXT, amount NUMERIC, balance NUMERIC, source TEXT,
      label_id INT REFERENCES transaction_labels(id), is_fixed BOOLEAN DEFAULT FALSE);
    INSERT INTO categories (name) VALUES ('Other'),('Groceries'),('Dining'),('Shopping');
    INSERT INTO categories (user_id,name) VALUES (2,'Foreign');
    INSERT INTO transactions (description,category,is_fixed) VALUES ('MY STORE','Other',TRUE),('MY STORE','Dining',FALSE);
    INSERT INTO transactions (user_id,description,category) VALUES (2,'MY STORE','Foreign');
  `);
  const client = { query: async (sql, params) => {
    const result = await pg.query(sql, params);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } };
  const db = { transaction: callback => pg.transaction(async tx => callback({
    query: async (sql, params) => {
      const result = await tx.query(sql, params);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    }
  })) };
  return { pg, client, db };
}

test('real SQL rule validation and exact matching preserve fixed flags and tenant categories', async () => {
  const { pg, client } = await fixture();
  try {
    await assert.rejects(saveRule(client, { pattern: 'STORE', category: 'Foreign', enabled: true, priority: 1 }), { status: 400 });
    for (const invalid of [{ priority: -1 }, { priority: 1001 }, { priority: 1.1 }, { enabled: 'true' }]) {
      await assert.rejects(saveRule(client, { pattern: 'STORE', category: 'Groceries', priority: 1, enabled: true, ...invalid }), { status: 400 });
    }
    const saved = await saveRule(client, { pattern: 'My Store', category: 'Groceries', enabled: true, priority: 123 });
    await client.query('UPDATE transaction_labels SET is_fixed=TRUE WHERE id=$1', [saved.id]);
    await saveRule(client, { pattern: 'MY STORE', category: 'Dining', enabled: false, priority: 99 }, saved.id);
    const config = await loadCategorization(client);
    assert.equal(config.rules.length, 1);
    assert.equal(config.rules[0].is_fixed, true);
    assert.equal(config.rules[0].match_type, 'merchant');
    assert.equal(config.compiled.length, 0);
    await assert.rejects(saveRule(client, { pattern: 'STORE', category: 'Groceries', enabled: true, priority: 1 }, 999), { status: 404 });
  } finally { await pg.close(); }
});

test('apply is atomic for stale and foreign IDs, validates categories, tracks manual changes without fixed changes', async () => {
  const { pg, client, db } = await fixture();
  try {
    await assert.rejects(applyUpdates(db, [
      { id: 1, category: 'Groceries', expectedCategory: 'Other' },
      { id: 2, category: 'Groceries', expectedCategory: 'stale' }
    ]), { status: 409 });
    assert.equal((await client.query('SELECT category FROM transactions WHERE id=1')).rows[0].category, 'Other');
    await assert.rejects(applyUpdates(db, [{ id: 3, category: 'Groceries', expectedCategory: 'Foreign' }]), { status: 404 });
    await assert.rejects(applyUpdates(db, [{ id: 1, category: 'Foreign', expectedCategory: 'Other' }]), { status: 400 });
    assert.deepEqual(await applyUpdates(db, [{ id: 1, category: 'Groceries', expectedCategory: 'Other' }]), { updated: 1 });
    const row = (await client.query('SELECT * FROM transactions WHERE id=1')).rows[0];
    assert.equal(row.previous_category, 'Other');
    assert.equal(row.category_corrected, true);
    assert.equal(row.is_fixed, true);
    await assert.rejects(applyUpdates(db, [{ id: 1, category: 'Dining', expectedCategory: 'Groceries' }]), { status: 409 });
    assert.deepEqual(await applyUpdates(db, [{ id: 1, category: 'Dining' }], { expected: false, protectCorrections: false }), { updated: 1 });
    assert.equal((await client.query('SELECT previous_category FROM transactions WHERE id=1')).rows[0].previous_category, 'Groceries');
  } finally { await pg.close(); }
});

test('import uses one rule snapshot, user rule category and explicit label flags, never updates prior rows', async () => {
  const { pg, client } = await fixture();
  try {
    const saved = await saveRule(client, { pattern: 'MY STORE', category: 'Groceries', enabled: true, priority: 123 });
    await client.query('UPDATE transaction_labels SET is_fixed=TRUE WHERE id=$1', [saved.id]);
    const config = await loadCategorization(client);
    const make = (description, date = '2026-01-01') => ({ date, description, amount: 5, direction: 'debit' });
    const transactions = [make('MY STORE'), make('UNKNOWN'), make('MY STORE'), make('MY STORE', '2026-01-02')];
    let labelQueries = 0;
    const countedClient = { query: (sql, params) => {
      if (/FROM transaction_labels/.test(sql)) labelQueries++;
      return client.query(sql, params);
    } };
    assert.deepEqual(await importTransactions(countedClient, transactions, config, 'test'), { imported: 3, duplicates: 1, excluded: 0 });
    assert.equal(labelQueries, 0);
    const rows = (await client.query('SELECT * FROM transactions ORDER BY id')).rows;
    assert.equal(rows[0].category, 'Other');
    assert.equal(rows[0].is_fixed, true);
    assert.equal(rows[1].is_fixed, false);
    assert.equal(rows[3].category, 'Groceries');
    assert.equal(rows[3].label_id, saved.id);
    assert.equal(rows[3].is_fixed, true);
    assert.equal(rows[4].category, 'Other');
    assert.equal(rows[4].is_fixed, false);
    assert.equal(rows[5].user_id, 1);
  } finally { await pg.close(); }
});

test('HTTP cleanup is non-destructive, fixed toggles are explicit, legacy learning saves without rewriting', async () => {
  const { pg, client, db } = await fixture();
  const original = Database.prototype.transaction;
  Database.prototype.transaction = db.transaction;
  const app = express();
  app.use(express.json());
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/categorizations', categorizationsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const cleanup = await request('/api/transactions/cleanup-database', {});
    assert.equal(cleanup.status, 409);
    assert.match(cleanup.body.error, /preview/);
    assert.equal((await client.query('SELECT category,is_fixed FROM transactions WHERE id=1')).rows[0].category, 'Other');
    assert.equal((await request('/api/transactions/update-fixed', { id: 1, is_fixed: 'false' })).status, 400);
    assert.equal((await request('/api/transactions/update-fixed', { id: 3, is_fixed: true })).status, 404);
    assert.equal((await request('/api/transactions/update-fixed', { id: 1, is_fixed: true })).status, 200);
    const flags = (await client.query('SELECT is_fixed,category FROM transactions WHERE user_id=1 ORDER BY id')).rows;
    assert.deepEqual(flags, [{ is_fixed: true, category: 'Other' }, { is_fixed: true, category: 'Dining' }]);
    assert.equal((await request('/api/transactions/update-transaction', { id: 1, category: 'Dining', is_fixed: false })).status, 200);
    assert.equal((await client.query('SELECT is_fixed FROM transactions WHERE id=1')).rows[0].is_fixed, true);
    const learned = await request('/api/categorizations/learn-pattern', { keyword: 'MY STORE', suggestedCategory: 'Groceries' });
    assert.equal(learned.status, 200);
    assert.equal(learned.body.updated, 0);
    assert.equal((await client.query('SELECT category FROM transactions WHERE id=1')).rows[0].category, 'Dining');
    assert.equal((await request('/api/transactions/delete-by-id', { id: 3 })).status, 404);
    const response = await fetch(base + '/api/transactions/categorization-rules');
    assert.equal(response.status, 200);
    const listed = await response.json();
    assert.equal(listed.rules[0].pattern, 'MY STORE');
    assert.equal(listed.categories.some(category => category.name === 'Foreign'), false);
    assert.equal((await request('/api/transactions/categorization-rules',
      { pattern: 'MY STORE', category: 'Groceries', priority: '100', enabled: true })).status, 400);
    assert.equal((await request('/api/transactions/categorization-rules/999',
      { pattern: 'MY STORE', category: 'Groceries', priority: 100, enabled: true }, 'PUT')).status, 404);
    const proposed = await request('/api/transactions/categorization-preview', { scope: 'all' });
    assert.equal(proposed.status, 200);
    assert.deepEqual(proposed.body.suggestions.map(row => row.id), [2]);
    const approved = await request('/api/transactions/categorization-apply',
      { updates: [{ id: 2, category: 'Groceries', expectedCategory: 'Dining' }] });
    assert.deepEqual(approved, { status: 200, body: { updated: 1 } });
    assert.equal((await request('/api/transactions/categorization-apply',
      { updates: [{ id: 2, category: 'Shopping', expectedCategory: 'Dining' }] })).status, 409);
    await client.query("INSERT INTO transaction_labels (pattern,match_type) VALUES ('(a+)+$', 'regex')");
    assert.equal((await request('/api/transactions/categorization-preview', { scope: 'all' })).status, 422);
    assert.equal((await fetch(base + '/api/transactions/categorization-rules')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Database.prototype.transaction = original;
    await pg.close();
  }
});
