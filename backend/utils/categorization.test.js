import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import Database from '../db.js';
import transactionsRouter from '../routes/transactions.js';
import categoriesRouter from '../routes/categories.js';
import categorizationsRouter from '../routes/categorizations.js';
import { importTransactions } from '../routes/import.js';
import { canonicalMerchant, compileRules, classify, preview, saveRule, loadCategorization, applyUpdates } from './categorization.js';
import { withUser } from './tenant.js';
import { compileNameRules, matchesName, nameKey, resolveName, suggestNamePattern, validateNameRule } from './naming.js';

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
      name TEXT, icon TEXT, color TEXT, UNIQUE(user_id,name));
    CREATE TABLE transaction_labels (id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      pattern TEXT, display_label TEXT, category_id INT REFERENCES categories(id), match_type TEXT DEFAULT 'regex',
      priority INT DEFAULT 0, enabled BOOLEAN DEFAULT TRUE, is_fixed BOOLEAN DEFAULT FALSE, UNIQUE(user_id,pattern));
    CREATE TABLE transactions (id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      date TEXT, description TEXT, category TEXT, previous_category TEXT, category_corrected BOOLEAN DEFAULT FALSE,
      correction_timestamp TIMESTAMPTZ, direction TEXT, amount NUMERIC, balance NUMERIC, source TEXT,
      label_id INT REFERENCES transaction_labels(id), is_fixed BOOLEAN DEFAULT FALSE,
      pay_mode TEXT CHECK (pay_mode IN ('auto','manual')), income_role TEXT CHECK (income_role IN ('income','other')), account_id INT, display_name TEXT, name_override BOOLEAN NOT NULL DEFAULT FALSE, import_batch_id INT);
    CREATE TABLE name_rules (id SERIAL PRIMARY KEY, user_id INT DEFAULT current_setting('app.user_id')::integer,
      pattern TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(user_id,pattern));
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
    const inserted = await client.query("INSERT INTO transactions (description,category) VALUES ('VISA DDA PUR AP 123 LOCAL MARKET','Other') RETURNING id");
    const learned = await applyUpdates(db, [{ id: inserted.rows[0].id, category: 'Groceries', expectedCategory: 'Other' }], { learnRules: true });
    assert.deepEqual(learned, { updated: 1, rulesSaved: 1, rulesSkipped: 0 });
    const savedRule = (await client.query("SELECT pattern,match_type FROM transaction_labels WHERE pattern='LOCAL MARKET'")).rows[0];
    assert.deepEqual(savedRule, { pattern: 'LOCAL MARKET', match_type: 'merchant' });
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
    assert.deepEqual(rows.slice(2).map(row => row.pay_mode), [null, null, null, null]);
  } finally { await pg.close(); }
});

test('import inherits auto-pay/manual from earlier payments to the same bill, else detects it from wording', async () => {
  const { pg, client } = await fixture();
  try {
    await client.query(`INSERT INTO transactions (date,description,amount,direction,category,pay_mode) VALUES
      ('2026-01-05','VISA DDA PUR AP 420429 NETFLIX COM 408 CA',15.49,'DEBIT','Other','auto'),
      ('2026-01-06','ONLINE PMT CITI CARD X1234',300,'DEBIT','Other','manual')`);
    const config = await loadCategorization(client);
    const make = (description, amount = 15.49, direction = 'DEBIT') => ({ date: '2026-02-05', description, amount, direction });
    await importTransactions(client, [
      make('DDA PURCHASE AP 00001000 NETFLIX COM LOS GATOS CA'),
      make('ONLINE PMT CITI CARD X1234', 280),
      make('CITI CARD X9999 PAYMENT', 50),
      make('PSEG AUTOPAY 0001', 120),
      make('BILL PAY VERIZON', 90),
      make('UNKNOWN STORE', 12),
      make('NETFLIX COM REFUND', 15.49, 'CREDIT')
    ], config, 'test');
    const modes = (await client.query("SELECT description,pay_mode FROM transactions WHERE date='2026-02-05' ORDER BY id")).rows.map(row => row.pay_mode);
    assert.deepEqual(modes, ['auto', 'manual', null, 'auto', 'manual', null, null]);
  } finally { await pg.close(); }
});

test('import keeps the user income decision for new deposits from the same sender', async () => {
  const { pg, client } = await fixture();
  try {
    await client.query(`INSERT INTO transactions (date,description,amount,direction,category,income_role) VALUES
      ('2026-01-09','MOBILE DEPOSIT JANE DOE REF 991',150,'CREDIT','Other','other'),
      ('2026-01-10','ETSY PAYOUT 1234',80,'CREDIT','Other','income')`);
    const config = await loadCategorization(client);
    await importTransactions(client, [
      { date: '2026-02-06', description: 'MOBILE DEPOSIT JANE DOE REF 2044', amount: 150, direction: 'CREDIT' },
      { date: '2026-02-06', description: 'ETSY PAYOUT 5678', amount: 95, direction: 'CREDIT' },
      { date: '2026-02-06', description: 'ACME PAYROLL', amount: 2000, direction: 'CREDIT' },
      { date: '2026-02-06', description: 'ETSY PAYOUT 5678', amount: 12, direction: 'DEBIT' }
    ], config, 'test');
    const roles = (await client.query("SELECT income_role FROM transactions WHERE date='2026-02-06' ORDER BY id")).rows.map(row => row.income_role);
    assert.deepEqual(roles, ['other', 'income', null, null]);
  } finally { await pg.close(); }
});

test('rename words ignore reference numbers and case; the most specific rule wins', () => {
  const zelle = 'SENT 626800I0ARPL Zelle CRISTIANE DE LIMA';
  assert.equal(nameKey(zelle), 'SENT ZELLE CRISTIANE DE LIMA');
  assert.equal(suggestNamePattern(zelle), 'ZELLE CRISTIANE DE LIMA');
  assert.equal(suggestNamePattern('VISA DDA PUR AP 420429 TRADER JOE S #552'), 'TRADER JOE S');
  for (const description of [
    'TST* TRIBOS PERI PERI - M METUCHEN NJ',
    'VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ',
    'SQ * TRIBOS PERI PERI METUCHEN NJ'
  ]) assert.equal(suggestNamePattern(description), 'TRIBOS PERI PERI');
  const rules = compileNameRules([{ id: 1, pattern: 'zelle', name: 'Zelle' }, { id: 2, pattern: 'Zelle  Cristiane de Lima', name: 'Cristiane De Lima' }, { id: 3, pattern: '1234', name: 'Numbers only' }]);
  assert.equal(rules.length, 2, 'a pattern of only numbers matches nothing and is skipped');
  assert.equal(resolveName('SENT 77XQ12 ZELLE CRISTIANE DE LIMA', rules).name, 'Cristiane De Lima');
  assert.equal(resolveName('RECEIVED 9 Zelle CRISTIANE DE LIMA', rules).name, 'Cristiane De Lima');
  assert.equal(resolveName('ZELLE TO SAM PATEL', rules).name, 'Zelle');
  assert.equal(resolveName('CRISTIANE DE LIMAS BAKERY', rules), null, 'whole words only');
  assert.equal(matchesName('ZELLE CRISTIANE DE LIMA', ''), false);
  assert.throws(() => validateNameRule({ pattern: '123', name: 'X' }), { status: 400 });
  assert.throws(() => validateNameRule({ pattern: 'ABC', name: ' ' }), { status: 400 });
  assert.throws(() => validateNameRule({ pattern: 'ABC', name: 'x'.repeat(81) }), { status: 400 });
  assert.deepEqual(validateNameRule({ pattern: ' zelle  cristiane ', name: '  Cristiane   De Lima ' }), { pattern: 'ZELLE CRISTIANE', name: 'Cristiane De Lima' });
});

test('rename rules apply to past rows, new imports and manual rows, and can be removed', async () => {
  const { pg, client, db } = await fixture();
  const original = Database.prototype.transaction;
  Database.prototype.transaction = db.transaction;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => withUser(1, next));
  app.use('/api/transactions', transactionsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await client.query(`INSERT INTO transactions (date,description,amount,direction,category) VALUES
      ('2026-01-03','SENT 626800I0ARPL Zelle CRISTIANE DE LIMA',200,'DEBIT','Other'),
      ('2026-02-03','SENT 7Q11ZZ90 Zelle CRISTIANE DE LIMA',200,'DEBIT','Other'),
      ('2026-02-04','ZELLE TO SAM PATEL',50,'DEBIT','Other')`);
    await client.query("INSERT INTO transactions (user_id,date,description,amount,direction) VALUES (2,'2026-02-03','SENT 1 Zelle CRISTIANE DE LIMA',5,'DEBIT')");
    const preview = await request('/api/transactions/name-rules/preview', { description: 'SENT 626800I0ARPL Zelle CRISTIANE DE LIMA' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.suggested, 'ZELLE CRISTIANE DE LIMA');
    assert.equal(preview.body.count, 2, 'other users are invisible');
    assert.equal(preview.body.current, null);
    assert.equal((await request('/api/transactions/name-rules', { pattern: '9999', name: 'Nope' })).status, 400);
    const saved = await request('/api/transactions/name-rules', { pattern: preview.body.suggested, name: 'Cristiane De Lima' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.changed, 2);
    assert.equal(saved.body.rule.matches, 2);
    const names = async () => (await client.query('SELECT description,display_name FROM transactions ORDER BY id')).rows.map(row => row.display_name);
    assert.deepEqual(await names(), [null, null, null, 'Cristiane De Lima', 'Cristiane De Lima', null, null]);
    const config = await loadCategorization(client);
    await importTransactions(client, [{ date: '2026-03-03', description: 'SENT AB12 Zelle CRISTIANE DE LIMA', amount: 200, direction: 'DEBIT' }], config, 'test');
    assert.equal((await client.query("SELECT display_name FROM transactions WHERE date='2026-03-03'")).rows[0].display_name, 'Cristiane De Lima', 'future imports are renamed');
    assert.equal((await request('/api/transactions/insert-manual', { date: '2026-03-04', description: 'Zelle Cristiane de Lima', amount: 10, direction: 'DEBIT', category: 'Other' })).status, 200);
    assert.equal((await client.query("SELECT display_name FROM transactions WHERE date='2026-03-04'")).rows[0].display_name, 'Cristiane De Lima');
    const again = await request('/api/transactions/name-rules/preview', { description: 'SENT 1 Zelle CRISTIANE DE LIMA' });
    assert.deepEqual(again.body.current, { id: saved.body.rule.id, pattern: 'ZELLE CRISTIANE DE LIMA', name: 'Cristiane De Lima' });
    const listed = await request('/api/transactions/name-rules', undefined, 'GET');
    assert.deepEqual(listed.body.rules.map(rule => [rule.name, rule.matches]), [['Cristiane De Lima', 4]]);
    const edited = await request('/api/transactions/name-rules', { id: saved.body.rule.id, pattern: 'ZELLE CRISTIANE DE LIMA', name: 'Cristiane (cleaning)' });
    assert.equal(edited.body.changed, 4);
    assert.equal((await request('/api/transactions/name-rules', { id: 999, pattern: 'X', name: 'Y' })).status, 404);
    assert.equal((await request(`/api/transactions/name-rules/${saved.body.rule.id}`, undefined, 'DELETE')).body.changed, 4);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM transactions WHERE display_name IS NOT NULL')).rows[0].n, 0);
    assert.equal((await request('/api/transactions/name-rules/abc', undefined, 'DELETE')).status, 400);
    assert.equal((await request(`/api/transactions/name-rules/${saved.body.rule.id}`, undefined, 'DELETE')).status, 404);
    await client.query(`INSERT INTO transactions (date,description,amount,direction,category) VALUES
      ('2026-09-23','TST* TRIBOS PERI PERI - M METUCHEN NJ',29.50,'DEBIT','Dining'),
      ('2026-08-10','VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ',94.30,'DEBIT','Dining'),
      ('2026-08-06','VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ',33.94,'DEBIT','Dining'),
      ('2026-08-01','TST CHAI CHENAK NEW BRUNSWICK NJ',29.50,'DEBIT','Shopping')`);
    const narrow = await request('/api/transactions/name-rules', { pattern: 'TST TRIBOS PERI PERI M METUCHEN NJ', name: 'Peri Peri' });
    assert.equal(narrow.body.rule.matches, 1);
    const merchantPreview = await request('/api/transactions/name-rules/preview', { description: 'TST* TRIBOS PERI PERI - M METUCHEN NJ' });
    assert.equal(merchantPreview.body.suggested, 'TRIBOS PERI PERI');
    assert.equal(merchantPreview.body.count, 3);
    const broadened = await request('/api/transactions/name-rules', { id: narrow.body.rule.id, pattern: merchantPreview.body.suggested, name: 'Peri Peri' });
    assert.equal(broadened.body.rule.matches, 3);
    assert.equal((await client.query("SELECT display_name FROM transactions WHERE description LIKE '%CHAI CHENAK%'")).rows[0].display_name, null);
    const periRows = (await client.query("SELECT id,description FROM transactions WHERE user_id=1 AND description LIKE '%TRIBOS%' ORDER BY id")).rows;
    const selectedId = periRows[0].id;
    const selective = await request('/api/transactions/name-rules', { id: narrow.body.rule.id, pattern: 'TRIBOS PERI PERI', name: 'Dinner spot', ids: [selectedId], remember: true });
    assert.equal(selective.status, 200);
    assert.equal(selective.body.rule.matches, 1);
    assert.deepEqual((await client.query("SELECT display_name FROM transactions WHERE description LIKE '%TRIBOS%' ORDER BY id")).rows.map(row => row.display_name), ['Dinner spot', 'Peri Peri', 'Peri Peri']);
    await request('/api/transactions/name-rules', { pattern: 'CHAI CHENAK', name: 'Chai' });
    assert.deepEqual((await client.query("SELECT display_name FROM transactions WHERE description LIKE '%TRIBOS%' ORDER BY id")).rows.map(row => row.display_name), ['Dinner spot', 'Peri Peri', 'Peri Peri'], 'later rule recomputation preserves unchecked rows');
    await importTransactions(client, [{ date: '2026-09-25', description: 'TST TRIBOS PERI PERI METUCHEN NJ', amount: 30, direction: 'DEBIT' }], config, 'test');
    assert.equal((await client.query("SELECT display_name FROM transactions WHERE date='2026-09-25'")).rows[0].display_name, 'Dinner spot');
    const foreign = (await client.query('SELECT id FROM transactions WHERE user_id=2 LIMIT 1')).rows[0].id;
    assert.equal((await request('/api/transactions/name-rules', { pattern: 'TRIBOS PERI PERI', name: 'No', ids: [foreign], remember: false })).status, 409);
    assert.equal((await request('/api/transactions/name-rules', { pattern: 'TRIBOS PERI PERI', name: 'No', ids: [selectedId, selectedId], remember: false })).status, 400);
    const oneTime = await request('/api/transactions/name-rules', { id: narrow.body.rule.id, pattern: 'TRIBOS PERI PERI', name: 'One dinner', ids: [selectedId], remember: false });
    assert.equal(oneTime.status, 200);
    assert.equal((await client.query('SELECT id FROM name_rules WHERE id=$1', [narrow.body.rule.id])).rows.length, 0);
    const labelsBefore = (await client.query('SELECT COUNT(*)::int AS n FROM transaction_labels')).rows[0].n;
    const categoryOnce = await request('/api/transactions/categorization-apply', { updates: [{ id: selectedId, category: 'Shopping', expectedCategory: 'Dining' }], learnRules: false, protectCorrections: false });
    assert.equal(categoryOnce.status, 200);
    assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM transaction_labels')).rows[0].n, labelsBefore);
    const clearOnce = await request('/api/transactions/categorization-apply', { updates: [{ id: selectedId, category: '', expectedCategory: 'Shopping' }], learnRules: false, protectCorrections: false });
    assert.equal(clearOnce.status, 200);
    assert.equal((await client.query('SELECT category FROM transactions WHERE id=$1', [selectedId])).rows[0].category, null);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Database.prototype.transaction = original;
    await pg.close();
  }
});

test('HTTP cleanup is non-destructive, fixed toggles are explicit, legacy learning saves without rewriting', async () => {
  const { pg, client, db } = await fixture();
  const original = Database.prototype.transaction;
  Database.prototype.transaction = db.transaction;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => withUser(1, next));
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/categorizations', categorizationsRouter);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, method = 'POST') => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
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
    assert.equal((await request('/api/transactions/update-fixed-many', { ids: [1, 3], is_fixed: false })).status, 404);
    assert.equal((await request('/api/transactions/update-fixed-many', { ids: ['1'], is_fixed: false })).status, 400);
    assert.equal((await request('/api/transactions/update-fixed-many', { ids: [1, 1], is_fixed: false })).status, 400);
    assert.equal((await client.query('SELECT is_fixed FROM transactions WHERE id=1')).rows[0].is_fixed, true);
    assert.deepEqual(await request('/api/transactions/update-fixed-many', { ids: [1, 2], is_fixed: false }), { status: 200, body: { success: true, updated: 2 } });
    assert.deepEqual((await client.query('SELECT is_fixed FROM transactions WHERE user_id=1 ORDER BY id')).rows.map(row => row.is_fixed), [false, false]);
    assert.equal((await request('/api/transactions/update-fixed-many', { ids: [1, 2], is_fixed: true })).body.updated, 2);
    await client.query("UPDATE transactions SET direction='DEBIT' WHERE id IN (1,3)");
    await client.query("UPDATE transactions SET direction='CREDIT' WHERE id=2");
    assert.equal((await request('/api/transactions/update-pay-mode', { ids: [1], pay_mode: 'sometimes' })).status, 400);
    assert.equal((await request('/api/transactions/update-pay-mode', { ids: [1] })).status, 400);
    assert.equal((await request('/api/transactions/update-pay-mode', { ids: [], pay_mode: 'auto' })).status, 400);
    assert.equal((await request('/api/transactions/update-pay-mode', { ids: [1, 1], pay_mode: 'auto' })).status, 400);
    assert.equal((await request('/api/transactions/update-pay-mode', { ids: [1, 3], pay_mode: 'auto' })).status, 404);
    assert.equal((await request('/api/transactions/update-pay-mode', { ids: [1, 2], pay_mode: 'auto' })).status, 400);
    assert.equal((await client.query('SELECT pay_mode FROM transactions WHERE id=1')).rows[0].pay_mode, null);
    assert.deepEqual(await request('/api/transactions/update-pay-mode', { ids: [1], pay_mode: 'manual' }), { status: 200, body: { success: true, updated: 1 } });
    assert.equal((await client.query('SELECT pay_mode FROM transactions WHERE id=1')).rows[0].pay_mode, 'manual');
    assert.equal((await request('/api/transactions/update-pay-mode', { ids: [1], pay_mode: null })).body.updated, 1);
    assert.equal((await client.query('SELECT pay_mode FROM transactions WHERE id=1')).rows[0].pay_mode, null);
    assert.equal((await client.query('SELECT pay_mode FROM transactions WHERE id=3')).rows[0].pay_mode, null);
    assert.equal((await request('/api/transactions/update-income-role', { ids: [2] })).status, 400, 'role is required');
    assert.equal((await request('/api/transactions/update-income-role', { ids: [2], income_role: 'salary' })).status, 400);
    assert.equal((await request('/api/transactions/update-income-role', { ids: [1], income_role: 'other' })).status, 400, 'debits cannot be income');
    assert.equal((await request('/api/transactions/update-income-role', { ids: [2, 3], income_role: 'other' })).status, 404, 'other users are invisible');
    assert.deepEqual(await request('/api/transactions/update-income-role', { ids: [2], income_role: 'other' }), { status: 200, body: { success: true, updated: 1 } });
    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    // The route uses the server's local date; PGlite's CURRENT_DATE is UTC and can be a day ahead.
    await client.query('UPDATE transactions SET date=$1,amount=150 WHERE id=2', [localToday]);
    const sources = (await request('/api/transactions/income-sources', undefined, 'GET')).body.sources;
    assert.deepEqual(sources.map(source => [source.name, source.status, source.by]), [['My Store', 'other', 'you']]);
    assert.equal((await request('/api/transactions/update-income-role', { ids: [2], income_role: null })).body.updated, 1);
    assert.equal((await client.query('SELECT income_role FROM transactions WHERE id=2')).rows[0].income_role, null);
    await client.query('UPDATE transactions SET direction=NULL WHERE id IN (1,2,3)');
    assert.equal((await request('/api/transactions/update-transaction', { id: 1, category: 'Dining', is_fixed: false })).status, 200);
    assert.equal((await client.query('SELECT is_fixed FROM transactions WHERE id=1')).rows[0].is_fixed, true);
    const mapped = (await client.query("SELECT c.name,l.pattern,l.match_type FROM transaction_labels l JOIN categories c ON c.id=l.category_id WHERE l.pattern='MY STORE'")).rows[0];
    assert.deepEqual(mapped, { name: 'Dining', pattern: 'MY STORE', match_type: 'merchant' });
    assert.equal((await request('/api/transactions/update-transaction', { id: 1, category: '' })).body.rulesDisabled, 1);
    assert.equal((await client.query("SELECT enabled FROM transaction_labels WHERE pattern='MY STORE'")).rows[0].enabled, false);
    assert.equal((await request('/api/transactions/update-transaction', { id: 1, category: 'Dining' })).status, 200);
    const learnedConfig = await loadCategorization(client);
    assert.equal(classify({ description: 'VISA DDA PUR AP 987 MY STORE' }, learnedConfig.compiled, learnedConfig.names).category, 'Dining');
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
    assert.equal((await request('/api/transactions/categorization-apply',
      { updates: [{ id: 2, category: 'Dining', expectedCategory: 'Groceries' }] })).status, 409);
    assert.equal((await request('/api/transactions/categorization-apply',
      { updates: [{ id: 2, category: 'Dining', expectedCategory: 'Groceries' }], protectCorrections: 'no' })).status, 400);
    assert.deepEqual(await request('/api/transactions/categorization-apply',
      { updates: [{ id: 2, category: 'Dining', expectedCategory: 'Groceries' }], protectCorrections: false }), { status: 200, body: { updated: 1 } });
    assert.equal((await request('/api/transactions/categorization-apply',
      { updates: [{ id: 2, category: 'Groceries', expectedCategory: 'Groceries' }], protectCorrections: false })).status, 409);
    assert.equal((await request('/api/transactions/categorization-apply',
      { updates: [{ id: 2, category: 'Groceries', expectedCategory: 'Dining' }], protectCorrections: false })).status, 200);
    await client.query("INSERT INTO transaction_labels (pattern,match_type) VALUES ('(a+)+$', 'regex')");
    await client.query("INSERT INTO transactions (description,category) VALUES ('STARBUCKS','Other')");
    const previewWithLegacyRule = await request('/api/transactions/categorization-preview', { scope: 'all' });
    assert.equal(previewWithLegacyRule.status, 200);
    assert.equal(previewWithLegacyRule.body.invalidRules.length, 1);
    assert.equal(previewWithLegacyRule.body.suggestions.some(row => row.description === 'STARBUCKS' && row.suggestedCategory === 'Dining'), true);
    assert.equal((await fetch(base + '/api/transactions/categorization-rules')).status, 200);
    const created = await request('/api/categories', { name: 'Family' });
    assert.equal(created.status, 201);
    assert.equal((await request('/api/categories', { name: 'Family' })).status, 409);
    const familyId = created.body.category.id;
    await client.query("INSERT INTO transactions (description,category) VALUES ('FAMILY EXPENSE','Family')");
    assert.equal((await request(`/api/categories/${familyId}`, { name: 'Household' }, 'PUT')).status, 200);
    assert.equal((await client.query("SELECT category FROM transactions WHERE description='FAMILY EXPENSE'")).rows[0].category, 'Household');
    await client.query("INSERT INTO categories (name) VALUES ('Remove Me')");
    const removeId = (await client.query("SELECT id FROM categories WHERE name='Remove Me'")).rows[0].id;
    await client.query("INSERT INTO transactions (description,category) VALUES ('OLD CATEGORY EXPENSE','Remove Me')");
    await client.query("INSERT INTO transaction_labels (pattern,category_id,match_type) VALUES ('OLD MERCHANT',$1,'merchant')", [removeId]);
    const deleteResult = await request(`/api/categories/${removeId}`, { replacementId: 2 }, 'DELETE');
    assert.deepEqual(deleteResult, { status: 200, body: { success: true, transactions: 1 } });
    assert.equal((await client.query("SELECT category FROM transactions WHERE description='OLD CATEGORY EXPENSE'")).rows[0].category, 'Groceries');
    assert.equal((await client.query("SELECT category_id FROM transaction_labels WHERE pattern='OLD MERCHANT'")).rows[0].category_id, 2);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM categories WHERE name='Remove Me'")).rows[0].count, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Database.prototype.transaction = original;
    await pg.close();
  }
});
