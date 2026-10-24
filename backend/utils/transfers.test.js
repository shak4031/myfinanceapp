import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import { extractLast4, classifyTransfer, pairTransfers, savedAmount, cashBalance, accountBalances, kindHint, isTransferRow } from './transfers.js';
import application from '../app.js';

const debit = (description, amount = 100, extra = {}) => ({ description, amount, direction: 'DEBIT', ...extra });
const credit = (description, amount = 100, extra = {}) => ({ description, amount, direction: 'CREDIT', ...extra });

test('last four digits come from masks and account words, never from the own account', () => {
  assert.equal(extractLast4('ONLINE TRANSFER TO SAV XXXXXX4821'), '4821');
  assert.equal(extractLast4('Transfer to Checking ...7702 Ref 12345678'), '7702');
  assert.equal(extractLast4('FUNDS TRANSFER TO *3391'), '3391');
  assert.equal(extractLast4('Online Transfer to SAV 4821 Confirmation# 99887766'), '4821');
  assert.equal(extractLast4('TRANSFER FROM CHK XXXX1180 TO SAV XXXX4821', '1180'), '4821');
  assert.equal(extractLast4('POS PURCHASE STORE #1234'), null);
  assert.equal(extractLast4('BEST BUY 00412'), null);
  assert.equal(kindHint('TRANSFER TO MONEY MARKET'), 'savings');
  assert.equal(kindHint('ACH TRANSFER VANGUARD BUY'), 'investment');
});

test('classification separates own-account moves from real spending', () => {
  const checking = { id: 1, kind: 'checking' }, savings = { id: 2, kind: 'savings' };
  const card = { id: 3, kind: 'credit_card' }, unknown = { id: 4, kind: 'unknown' }, external = { id: 5, kind: 'external' };
  const own = { ownAccount: checking };
  assert.equal(classifyTransfer(debit('ONLINE TRANSFER TO SAV XXXX4821'), { ...own, counterpart: savings }), 'savings');
  assert.equal(classifyTransfer(credit('TRANSFER FROM CHK XXXX1180'), { ownAccount: savings, counterpart: checking, paired: true }), 'internal');
  assert.equal(classifyTransfer(debit('TRANSFER TO CHK 2222'), { ...own, counterpart: { id: 6, kind: 'checking' } }), 'internal');
  assert.equal(classifyTransfer(debit('ZELLE TO JORDAN LEE'), own), null, 'paying a person is spending');
  assert.equal(classifyTransfer(credit('ZELLE FROM ALEX RIVERA'), own), null, 'money from a person is not a transfer');
  assert.equal(classifyTransfer(debit('ONLINE TRANSFER TO CHK ...7702'), { ...own, counterpart: unknown }), 'unknown');
  assert.equal(classifyTransfer(debit('TRANSFER TO ACCT 9999'), { ...own, counterpart: external }), null, 'not my account counts');
  // Card payments are only internal when the card statement is imported too.
  assert.equal(classifyTransfer(debit('CHASE CARD ONLINE PAYMENT'), { ...own, counterpart: card, hasRows: () => false }), null);
  assert.equal(classifyTransfer(debit('CHASE CARD ONLINE PAYMENT'), { ...own, counterpart: card, hasRows: () => true }), 'internal');
  assert.equal(classifyTransfer(credit('PAYMENT THANK YOU'), { ownAccount: card }), 'internal');
  assert.equal(classifyTransfer(credit('PAYMENT - MOBILE APP'), { ownAccount: card }), 'internal');
  assert.equal(classifyTransfer(credit('PAYMENT - AUTOPAY'), { ownAccount: card }), 'internal');
  assert.equal(classifyTransfer(debit('CHASE CARD ONLINE PAYMENT'), own), null, 'unknown card payment counts as a bill');
  assert.equal(classifyTransfer(debit('WHOLE FOODS MARKET'), own), null);
  assert.equal(classifyTransfer(debit('ONLINE TRANSFER TO SAVINGS'), own), 'savings', 'savings wording without a number');
  assert.equal(classifyTransfer(debit('ONLINE TRANSFER'), own), 'unknown');
});

test('pairs match opposite sides between different accounts within a few days', () => {
  const accounts = new Map([[1, { id: 1, kind: 'checking', last4: '1180' }], [2, { id: 2, kind: 'savings', last4: '4821' }], [3, { id: 3, kind: 'savings', last4: '5555' }]]);
  const rows = [
    debit('ONLINE TRANSFER TO SAV XXXX4821', 600, { id: 1, account_id: 1, date: '2026-10-20' }),
    credit('TRANSFER FROM CHK XXXX1180', 600, { id: 2, account_id: 2, date: '2026-10-21' }),
    credit('TRANSFER FROM CHK XXXX1180', 600, { id: 3, account_id: 3, date: '2026-10-20' }),
    credit('DEPOSIT', 600, { id: 4, account_id: 2, date: '2026-11-20' })
  ];
  rows.push(
    debit('ONLINE TRANSFER TO CHECKING 3333', 90, { id: 5, account_id: 1, date: '2026-10-20' }),
    credit('TRANSFER FROM CHECKING 1180', 90, { id: 6, account_id: 2, date: '2026-10-21', category: 'Dining', category_corrected: true })
  );
  const pairs = pairTransfers(rows, accounts);
  assert.equal(pairs.get(1).id, 2, 'the masked number picks ••4821 over the closer ••5555 row');
  assert.equal(pairs.has(3), false);
  assert.equal(pairs.has(4), false);
  assert.equal(pairs.has(5), false, 'a manually marked counted transaction must not be paired as an internal transfer');
  assert.equal(pairs.has(6), false);
});

test('saved amounts, cash balance and the shared transfer predicate', () => {
  assert.equal(savedAmount({ transfer_kind: 'savings', amount: 600, direction: 'DEBIT' }, 'checking'), 600);
  assert.equal(savedAmount({ transfer_kind: 'savings', amount: 200, direction: 'DEBIT' }, 'savings'), -200, 'withdrawing from savings');
  assert.equal(savedAmount({ transfer_kind: 'internal', amount: 600, direction: 'DEBIT' }, 'checking'), 0);
  assert.equal(isTransferRow({ transfer_kind: null, category: 'Transfer' }), false, 'stored decision wins over the category');
  assert.equal(isTransferRow({ category: 'Transfer' }), true, 'legacy rows fall back to the category');
  const accounts = new Map([[1, { id: 1, kind: 'checking' }], [2, { id: 2, kind: 'savings' }], [3, { id: 3, kind: 'checking' }]]);
  const balance = cashBalance([
    { account_id: 1, date: '2026-10-01', balance: 500, id: 1 }, { account_id: 1, date: '2026-10-05', balance: 900, id: 2 },
    { account_id: 2, date: '2026-10-06', balance: 9000, id: 3 }, { account_id: 3, date: '2026-10-02', balance: 100, id: 4 },
    { account_id: null, date: '2026-10-07', balance: 77, id: 5 }
  ], accounts, '2026-10-10');
  assert.equal(balance.balance ?? balance, 1000, 'checking accounts only; savings is not spendable cash');
});

test('statement balance evidence respects account kind, effective date and newer running balances', () => {
  const accounts = [
    { id: 1, kind: 'checking', statement: { type: 'bank', balance: 250, closingDate: '2026-09-30' } },
    { id: 2, kind: 'credit_card', statement: { type: 'credit-card', balance: 1000, closingDate: '2026-10-03' } },
    { id: 3, kind: 'savings', statement: { type: 'bank', balance: 5000, closingDate: '2026-09-30' } },
    { id: 4, kind: 'checking', statement: { type: 'bank', balance: 500, closingDate: '2026-11-30' } }
  ];
  const byId = new Map(accounts.map(account => [account.id, account]));
  assert.equal(cashBalance([], byId, '2026-10-19'), 250);
  const rows = [{ account_id: 1, date: '2026-10-05', balance: 300, id: 1 }];
  assert.equal(cashBalance(rows, byId, '2026-10-19'), 300);
  assert.equal(accountBalances(rows, accounts).get(1).balance, 300);
  assert.equal(accountBalances(rows, accounts).get(2).balance, 1000);
});

test('imports require an account and transfers between own accounts never count as spending or income', async t => {
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
        const result = results[results.length - 1] || { rows: [] };
        return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
      },
      release
    };
  });
  const client = await pg.Pool.prototype.connect();
  await client.query('BEGIN');
  await migratePrivateSchema(client);
  await client.query('COMMIT');
  client.release();

  const saved = Object.fromEntries(['OWNER_SETUP_TOKEN', 'APP_ORIGIN'].map(key => [key, process.env[key]]));
  process.env.OWNER_SETUP_TOKEN = 'test-only-setup-token-longer-than-32-characters';
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  let cookie = null;
  const call = async (path, { body, method } = {}) => {
    const response = await fetch(base + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  try {
    const owner = await call('/api/auth/setup', { body: { name: 'Owner', email: 'owner@example.com', password: 'test-only-password-123456', setupToken: process.env.OWNER_SETUP_TOKEN } });
    cookie = owner.headers.get('set-cookie').split(';')[0];
    const createdCategory = await call('/api/categories', { body: { name: 'Audit fixture' } });
    assert.equal(createdCategory.status, 201);

    const now = new Date();
    const day = d => `${String(now.getMonth() + 1).padStart(2, '0')}/${String(Math.min(d, now.getDate())).padStart(2, '0')}/${now.getFullYear()}`;
    const checkingCsv = ['Date,Description,Amount,Balance',
      `${day(1)},NORTHWIND PAYROLL DIR DEP,3000.00,8000.00`,
      `${day(1)},WHOLE FOODS MARKET,-100.00,7900.00`,
      `${day(1)},ONLINE TRANSFER TO SAV XXXXXX4821,-500.00,7400.00`,
      `${day(1)},ZELLE TO JORDAN LEE,-60.00,7340.00`,
      `${day(1)},ONLINE TRANSFER TO CHK ...7702,-250.00,7090.00`,
      `${day(1)},CHASE CARD ONLINE PAYMENT,-400.00,6690.00`].join('\n');

    const missing = await call('/api/import/import-csv', { body: { csvData: checkingCsv, source: 'checking.csv' } });
    assert.equal(missing.status, 400, 'an account must be chosen');

    const imported = await call('/api/import/import-csv', { body: { csvData: checkingCsv, source: 'checking.csv',
      newAccount: { name: 'Everyday checking', kind: 'checking', last4: '1180', institution: 'Demo Bank' } } });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.accountsDiscovered, 2, 'two account numbers in transfers were new');

    const kinds = async () => Object.fromEntries((await call('/api/dashboard/all-transactions')).body.transactions.map(row => [row.description, row.transfer_kind]));
    let accounts = (await call('/api/accounts')).body;
    const checkingUpdate = accounts.accounts.find(account => account.id === imported.body.account.id);
    assert.equal(checkingUpdate.dataAsOf, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
    assert.ok(Number.isFinite(Date.parse(checkingUpdate.lastDataAddedAt)));
    assert.equal(accounts.accounts.find(account => account.last4 === '4821').dataAsOf, null, 'incoming transfer references do not update the recipient data');
    assert.equal(accounts.accounts.find(account => account.last4 === '4821').lastDataAddedAt, null);
    const discovered = accounts.accounts.filter(account => account.status === 'needs_review').map(account => account.last4).sort();
    assert.deepEqual(discovered, ['4821', '7702']);
    assert.equal(accounts.unknownTransfers.count, 2);
    assert.equal(accounts.unknownTransfers.total, 750);
    assert.deepEqual(await kinds(), {
      'NORTHWIND PAYROLL DIR DEP': null, 'WHOLE FOODS MARKET': null, 'ONLINE TRANSFER TO SAV XXXXXX4821': 'unknown',
      'ZELLE TO JORDAN LEE': null, 'ONLINE TRANSFER TO CHK ...7702': 'unknown', 'CHASE CARD ONLINE PAYMENT': null
    });
    const reviewPage = await call('/api/transactions/transfer-review?status=excluded');
    assert.equal(reviewPage.body.total, 2);
    assert.ok(reviewPage.body.rows.every(row => row.transfer_kind === 'unknown'));
    const choices = await call('/api/transactions/transfer-review/imports');
    assert.equal(choices.status, 200);
    const checkingImport = choices.body.batches.find(batch => batch.source === 'checking.csv');
    assert.ok(checkingImport);
    assert.equal(checkingImport.imported, 6);
    assert.equal(checkingImport.account_name, 'Everyday checking');
    assert.equal('backup' in checkingImport, false, 'import choices never load recovery transaction payloads');
    assert.equal('rows' in checkingImport, false, 'import choices are metadata only');
    const scopedPage = await call(`/api/transactions/transfer-review?importId=${checkingImport.id}&status=counted&limit=2&offset=1`);
    assert.equal(scopedPage.status, 200);
    assert.equal(scopedPage.body.total, 4);
    assert.equal(scopedPage.body.rows.length, 2);
    assert.ok(scopedPage.body.rows.every(row => row.source === 'checking.csv' && row.transfer_kind === null));
    for (const invalid of ['0', '-1', '1x', '1.5', '9007199254740992', '']) {
      assert.equal((await call(`/api/transactions/transfer-review?importId=${invalid}`)).status, 400);
      assert.equal((await call(`/api/transactions/transfer-review/imports?before=${invalid}`)).status, 400);
    }
    const zelleRow = (await call('/api/dashboard/all-transactions')).body.transactions.find(row => row.description.startsWith('ZELLE'));
    const madeInternal = await call(`/api/transactions/${zelleRow.id}/transfer-review`, { body: { handling: 'internal' } });
    assert.equal(madeInternal.status, 200);
    assert.equal((await kinds())['ZELLE TO JORDAN LEE'], 'internal');
    const madeCounted = await call(`/api/transactions/${zelleRow.id}/transfer-review`, { body: { handling: 'counted', category: 'Payments to people' } });
    assert.equal(madeCounted.status, 200);
    assert.equal((await kinds())['ZELLE TO JORDAN LEE'], null);
    const activity = await call('/api/activity');
    assert.ok(activity.body.events.some(event => event.event_type === 'category.created'));
    assert.ok(activity.body.events.some(event => event.event_type === 'transaction.transfer_reviewed'));
    const importActivity = activity.body.events.find(event => event.event_type === 'import.completed' && event.detail.fileName === 'checking.csv');
    assert.ok(importActivity, 'activity shows the source file for imports');
    const insights = (await call('/api/dashboard/insights')).body;
    assert.ok(JSON.stringify(insights).includes('accounts-review'), 'the dashboard asks about the discovered accounts');

    // Telling us what the accounts are reclassifies their transfers.
    const savingsId = accounts.accounts.find(account => account.last4 === '4821').id;
    const otherId = accounts.accounts.find(account => account.last4 === '7702').id;
    assert.equal((await call(`/api/accounts/${savingsId}`, { method: 'PATCH', body: { kind: 'savings', name: 'High-yield savings' } })).status, 200);
    assert.equal((await call(`/api/accounts/${otherId}`, { method: 'PATCH', body: { kind: 'checking' } })).status, 200);
    assert.deepEqual(await kinds(), {
      'NORTHWIND PAYROLL DIR DEP': null, 'WHOLE FOODS MARKET': null, 'ONLINE TRANSFER TO SAV XXXXXX4821': 'savings',
      'ZELLE TO JORDAN LEE': null, 'ONLINE TRANSFER TO CHK ...7702': 'internal', 'CHASE CARD ONLINE PAYMENT': null
    });
    const savingsTransfer = (await call('/api/dashboard/all-transactions')).body.transactions.find(row => row.description.startsWith('ONLINE TRANSFER TO SAV'));
    const countedTransfer = await call(`/api/transactions/${savingsTransfer.id}/transfer-review`, { body: { handling: 'counted', category: 'Groceries' } });
    assert.equal(countedTransfer.status, 200);
    assert.equal((await kinds())['ONLINE TRANSFER TO SAV XXXXXX4821'], null, 'a manual counted decision overrides transfer wording');
    const restoredTransfer = await call(`/api/transactions/${savingsTransfer.id}/transfer-review`, { body: { handling: 'savings' } });
    assert.equal(restoredTransfer.status, 200);
    assert.equal((await kinds())['ONLINE TRANSFER TO SAV XXXXXX4821'], 'savings');

    // Importing the savings statement pairs both sides; the savings is counted once.
    const savingsCsv = ['Date,Description,Amount,Balance', `${day(1)},TRANSFER FROM CHK XXXXXX1180,500.00,9500.00`, `${day(1)},INTEREST PAYMENT,12.34,9512.34`].join('\n');
    const second = await call('/api/import/import-csv', { body: { csvData: savingsCsv, source: 'savings.csv', accountId: savingsId } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const checkingOnly = await call(`/api/transactions/transfer-review?importId=${checkingImport.id}`);
    assert.equal(checkingOnly.body.total, 6, 'other imports do not change this import count');
    assert.ok(checkingOnly.body.rows.every(row => row.source === 'checking.csv'));
    const after = await kinds();
    assert.equal(after['TRANSFER FROM CHK XXXXXX1180'], 'internal');
    assert.equal(after['ONLINE TRANSFER TO SAV XXXXXX4821'], 'savings');
    assert.equal(after['INTEREST PAYMENT'], null, 'interest is real income');
    accounts = (await call('/api/accounts')).body;
    const renamedChecking = await call(`/api/accounts/${checkingUpdate.id}`, { method: 'PATCH', body: { name: 'Renamed checking' } });
    assert.equal(renamedChecking.status, 200);
    const afterRename = (await call('/api/accounts')).body.accounts.find(account => account.id === checkingUpdate.id);
    assert.equal(afterRename.dataAsOf, checkingUpdate.dataAsOf);
    assert.equal(afterRename.lastDataAddedAt, checkingUpdate.lastDataAddedAt);
    assert.equal(accounts.savedThisMonth.amount ?? accounts.savedThisMonth, 500);
    assert.equal(accounts.unknownTransfers.count, 0);

    const summary = (await call('/api/dashboard/summary', { body: { dateFilter: 'current' } })).body;
    assert.equal(summary.periodExpenses, 560, 'groceries, Zelle and the card payment; no transfers');
    assert.equal(summary.periodIncome, 3012.34, 'pay and interest; not the money arriving from checking');
    assert.equal(summary.balance, 6690, 'cash on hand is checking only');

    // A user correction wins over detection, through the trigger.
    const zelle = (await call('/api/dashboard/all-transactions')).body.transactions.find(row => row.description.startsWith('ZELLE'));
    assert.equal((await call('/api/dashboard/update-category', { body: { transaction_id: zelle.id, new_category: 'Transfer' } })).status, 200);
    assert.equal((await kinds())['ZELLE TO JORDAN LEE'], 'internal');
    // Large import histories stay bounded; other tenants' metadata/rows are never exposed.
    await database.query("INSERT INTO users(id,name,email) VALUES (2,'Other user','other@example.com')");
    const foreign = (await database.query("INSERT INTO import_batches(user_id,source) VALUES(2,'private.csv') RETURNING id")).rows[0].id;
    await database.query(`INSERT INTO import_batches(user_id,source)
      SELECT 1,'older-' || n || '.csv' FROM generate_series(1,35) n`);
    const large = (await database.query(`INSERT INTO import_batches(user_id,source,imported)
      VALUES(1,'large.csv',105) RETURNING id`)).rows[0].id;
    await database.query(`INSERT INTO transactions(user_id,import_batch_id,date,description,amount,direction,category)
      SELECT 1,$1,'2026-10-22','Large import row ' || n,1,'DEBIT','Other' FROM generate_series(1,105) n`, [large]);
    const bounded = (await call(`/api/transactions/transfer-review?importId=${large}`)).body;
    assert.equal(bounded.rows.length, 50);
    assert.equal(bounded.total, 105);
    const tail = (await call(`/api/transactions/transfer-review?importId=${large}&offset=100`)).body;
    assert.equal(tail.rows.length, 5);
    assert.ok(tail.rows.every(row => !bounded.rows.some(first => first.id === row.id)));
    assert.equal((await call(`/api/transactions/transfer-review?importId=${large}&limit=1000`)).body.rows.length, 100);
    const undone = (await database.query(`INSERT INTO import_batches(user_id,source,status,imported)
      VALUES(1,'undone.csv','undone',5) RETURNING id`)).rows[0].id;
    assert.equal((await call(`/api/transactions/transfer-review?importId=${undone}`)).body.total, 0);
    const firstChoices = (await call('/api/transactions/transfer-review/imports')).body;
    assert.equal(firstChoices.batches.length, 30);
    assert.ok(firstChoices.nextBefore);
    const olderChoices = (await call(`/api/transactions/transfer-review/imports?before=${firstChoices.nextBefore}`)).body;
    assert.ok(olderChoices.batches.length > 0);
    assert.equal(olderChoices.nextBefore, null);
    assert.ok(olderChoices.batches.every(batch => batch.id < firstChoices.nextBefore));
    assert.ok(![...firstChoices.batches, ...olderChoices.batches].some(batch => batch.id === foreign));
    assert.equal((await call(`/api/transactions/transfer-review?importId=${foreign}`)).status, 404);
    assert.equal((await call('/api/transactions/transfer-review?importId=untracked')).body.total, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
