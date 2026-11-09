import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import Database from '../db.js';
import router from '../routes/landscape.js';
import { buildLandscape } from './landscape.js';
import { migratePrivateSchema } from './schema.js';
import { withUser } from './tenant.js';

const now = new Date('2026-11-09T12:00:00Z');
const account = (id, kind, extra = {}) => ({ id, kind, name: `${kind} ${id}`, status: 'active', ...extra });
const tx = (id, extra = {}) => ({ id, date: '2026-10-10', description: 'Market', category: 'Shopping',
  amount: 100, direction: 'DEBIT', is_pending: false, transfer_kind: null, account_id: 1, ...extra });

test('empty financial landscape keeps all branches and marks gaps without zero balances', () => {
  const result = buildLandscape({ now });
  assert.equal(result.nodes.filter(n => n.kind === 'branch').length, 8);
  assert.equal(result.period.months, 0);
  assert.equal(result.nodes.find(n => n.id === 'missing-investments').amount, null);
  assert.equal(result.nodes.find(n => n.id === 'missing-retirement').amount, null);
  assert.match(result.nodes.find(n => n.id === 'missing-retirement').label, /401\(k\)/);
  assert.equal(result.nodes.find(n => n.id === 'income').amount, null);
  assert.ok(result.edges.every(e => result.nodes.some(n => n.id === e.source) && result.nodes.some(n => n.id === e.target)));
});

test('monthly flows reconcile posted records while transfers, pending and current months do not become spending', () => {
  const result = buildLandscape({ now,
    accounts: [account(1, 'checking'), account(2, 'savings')],
    transactions: [
      tx(1, { direction: 'CREDIT', description: 'PAYROLL', amount: 3000 }),
      tx(2, { date: '2026-09-10', direction: 'CREDIT', description: 'PAYROLL', amount: 3000 }),
      tx(3, { amount: 200 }),
      tx(4, { is_fixed: true, category: 'Utilities', amount: 50 }),
      tx(5, { category: 'Mortgage', amount: 1000 }),
      tx(6, { amount: 500, transfer_kind: 'savings', transfer_account_id: 2, transfer_pair_id: 7 }),
      tx(7, { amount: 500, direction: 'CREDIT', transfer_kind: 'savings', account_id: 2, transfer_account_id: 1, transfer_pair_id: 6 }),
      tx(8, { amount: 900, is_pending: true }),
      tx(9, { amount: 10000, date: '2026-11-05' }),
      tx(10, { amount: 500, transfer_kind: 'unknown' }),
      tx(11, { amount: 30, account_id: null }),
      tx(12, { amount: 99, date: '2026-07-01' })
    ] });
  assert.deepEqual(result.period, { from: '2026-08', to: '2026-10', months: 2 });
  assert.equal(result.nodes.find(n => n.id === 'income').amount, 3000);
  assert.equal(result.nodes.find(n => n.id === 'spending').amount, 140);
  const debtActivity = result.nodes.find(n => n.branch === 'debt' && n.kind === 'activity');
  assert.equal(debtActivity.amount, 500);
  const transfers = result.edges.filter(e => e.kind === 'transfer');
  assert.equal(transfers.length, 1, 'paired sides are counted only once');
  assert.deepEqual(transfers[0], { source: 'account-1', target: 'account-2', kind: 'transfer', amount: 250, count: 1 });
  assert.equal(result.coverage.unknownTransfers, 1);
  assert.equal(result.coverage.pendingExcluded, 1);
  assert.equal(result.coverage.unassignedActivity, 1);
  const shopping = result.nodes.find(n => n.kind === 'activity' && n.label === 'Shopping');
  assert.equal(shopping.count, 2);
  assert.equal(result.edges.find(e => e.source === 'account-1' && e.target === shopping.id).amount, 100,
    'unassigned activity remains in totals without an invented account edge');
});

test('balances retain sources, zero is real, investment/retirement use existing accounts and debt plans do not duplicate linked accounts', () => {
  const result = buildLandscape({ now, accounts: [
    account(1, 'checking'), account(2, 'investment', { name: 'Brokerage' }),
    account(3, 'investment', { name: 'Work retirement' }), account(4, 'credit_card'),
    account(5, 'savings', { statement: { closingDate: '2026-12-01', balance: 900 } }),
    account(6, 'checking', { status: 'needs_review' }),
    account(7, 'external'), account(8, 'checking'), account(9, 'checking'),
    account(10, 'investment', { name: 'Employer 401(k)' }), account(11, 'unknown')
  ], transactions: [
    tx(1, { balance: 450, date: '2026-10-01' }),
    tx(2, { account_id: 8, balance: 900, date: '2026-10-25' })
  ], banks: [
    { linked_account_id: 1, account_id: 'p1', current_balance: 0, iso_currency_code: 'USD', balance_checked_at: new Date('2026-11-08') },
    { linked_account_id: 2, account_id: 'p2', current_balance: 10000, iso_currency_code: 'USD', balance_checked_at: '2026-11-08', subtype: 'brokerage' },
    { linked_account_id: 3, account_id: 'p3', current_balance: 80000, iso_currency_code: 'USD', balance_checked_at: '2026-11-08', subtype: '401k' },
    { linked_account_id: 8, account_id: 'p8', current_balance: 100, iso_currency_code: 'USD', balance_checked_at: '2026-10-01' },
    { linked_account_id: 9, account_id: 'p9', current_balance: 100, iso_currency_code: 'EUR', balance_checked_at: '2026-11-08' }
  ], debts: [
    { id: 1, name: 'Card plan', account_id: 4, balance: 600, min_payment: 50 },
    { id: 2, name: 'Unlinked car loan', balance: 5000 }
  ], goals: [{ id: 1, name: 'Emergency fund', current_amount: 1000, target_amount: 4000 }] });
  const node = id => result.nodes.find(n => n.id === id);
  assert.equal(node('account-1').amount, 0);
  assert.equal(node('account-1').source, 'Plaid current balance (USD)');
  assert.equal(node('account-2').branch, 'investments');
  assert.equal(node('account-3').branch, 'retirement');
  assert.equal(node('account-3').amount, 80000);
  assert.equal(node('account-4').debts[0].balance, 600);
  assert.equal(node('debt-1'), undefined);
  assert.equal(node('debt-2').amount, 5000);
  assert.equal(node('account-5').amount, null);
  assert.equal(node('account-6'), undefined);
  assert.equal(node('account-7'), undefined);
  assert.equal(node('account-8').amount, 900, 'newer recorded evidence beats older Plaid data');
  assert.equal(node('account-9').amount, null, 'non-USD balances are not silently treated as USD');
  assert.equal(node('account-10').branch, 'retirement', 'saved account names classify retirement when no provider subtype exists');
  assert.equal(node('account-11'), undefined, 'unknown ownership/type is not asserted as confirmed cash');
  assert.equal(node('goal-1').metric, 'goal-progress');
  assert.match(node('goal-1').note, /not an additional bank balance/);
  assert.equal(Object.hasOwn(result, 'netWorth'), false);
});

test('transfer pairs aggregate per direction without double counting; current and pending balance evidence are not confused with monthly activity', () => {
  const result = buildLandscape({ now, accounts: [account(1, 'checking'), account(2, 'savings')],
    transactions: [
      tx(1, { amount: 100, transfer_kind: 'internal', transfer_account_id: 2, transfer_pair_id: 2 }),
      tx(2, { amount: 100, direction: 'CREDIT', transfer_kind: 'internal', account_id: 2, transfer_account_id: 1, transfer_pair_id: 1 }),
      tx(3, { amount: 50, transfer_kind: 'savings', transfer_account_id: 2, date: '2026-09-10' }),
      tx(4, { amount: 20, direction: 'CREDIT', transfer_kind: 'internal', transfer_account_id: 2 }),
      tx(5, { balance: 500, date: '2026-11-08', amount: 200 }),
      tx(6, { balance: 9000, date: '2026-11-09', is_pending: true }),
      tx(7, { balance: 30000, date: '2026-11-10' })
    ] });
  assert.deepEqual(result.edges.filter(e => e.kind === 'transfer'), [
    { source: 'account-1', target: 'account-2', kind: 'transfer', amount: 75, count: 2 },
    { source: 'account-2', target: 'account-1', kind: 'transfer', amount: 10, count: 1 }
  ]);
  assert.equal(result.nodes.find(n => n.id === 'account-1').amount, 500);
  assert.equal(result.nodes.find(n => n.id === 'spending').amount, 0);
});

test('ambiguous provider links do not supply balances or invented activity edges; transaction previews are explicitly capped', () => {
  const result = buildLandscape({ now, accounts: [account(1, 'checking')],
    banks: [{ linked_account_id: 1, account_id: 'p1' }, { linked_account_id: 1, account_id: 'p2' }],
    transactions: Array.from({ length: 25 }, (_, i) => tx(i + 1, { account_id: null, plaid_account_id: 'p1' })) });
  const activity = result.nodes.find(n => n.kind === 'activity');
  assert.equal(activity.count, 25);
  assert.equal(activity.transactions.length, 20);
  assert.equal(result.edges.filter(e => e.kind === 'activity').length, 0);
  assert.equal(result.coverage.unassignedActivity, 25);
});

test('monthly branch totals average the original ledger rather than summing rounded category averages', () => {
  const result = buildLandscape({ now, transactions: [
    tx(1, { amount: .01, category: 'A', date: '2026-08-01' }),
    tx(2, { amount: .01, category: 'B', date: '2026-09-01' }),
    tx(3, { amount: .01, category: 'C', date: '2026-10-01' })
  ] });
  assert.equal(result.nodes.find(n => n.id === 'spending').amount, .01);
  assert.equal(result.period.months, 3);
});

test('landscape API is tenant scoped, read only and never exposes provider IDs or credentials', async t => {
  const pg = new PGlite();
  const adapter = database => ({ async query(sql, params = []) {
    const result = params.length ? await database.query(sql, params) : (await database.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } });
  try {
    await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
    await pg.exec(`INSERT INTO users(id,name) VALUES(2,'Private');
      INSERT INTO accounts(id,user_id,name,kind,status) VALUES(1,1,'My checking','checking','active'),(2,2,'Private checking','checking','active');
      INSERT INTO transactions(user_id,date,description,amount,direction,account_id) VALUES
      (1,'2026-10-01','My salary',1000,'CREDIT',1),(2,'2026-10-01','Private salary',9000,'CREDIT',2);
      INSERT INTO credit_cards(user_id,name,balance) VALUES(1,'My debt',200),(2,'Private debt',9000);
      INSERT INTO savings_goals(user_id,name,target_amount) VALUES(1,'My goal',200),(2,'Private goal',9000);
      INSERT INTO plaid_connections(id,user_id,item_id,access_token_ciphertext) VALUES
      (1,1,'shared-provider-item','fixture-secret'),(2,2,'shared-provider-item','fixture-secret');
      INSERT INTO plaid_accounts(user_id,connection_id,account_id,name,linked_account_id,current_balance,iso_currency_code,balance_checked_at) VALUES
      (1,1,'shared-provider-account','My provider',1,100,'USD',NOW()),
      (2,2,'shared-provider-account','Private provider',2,99999,'USD',NOW());
      INSERT INTO transactions(user_id,date,description,amount,direction,plaid_account_id) VALUES
      (1,'2026-10-02','My credit',20,'CREDIT','shared-provider-account'),
      (2,'2026-10-02','Private credit',90,'CREDIT','shared-provider-account');`);
    t.mock.method(Database.prototype, 'transaction', callback => pg.transaction(async tx => {
      const client = adapter(tx);
      await client.query('SET LOCAL ROLE finance_app_runtime');
      await client.query("SELECT set_config('app.user_id','1',true)");
      return callback(client);
    }));
    const app = express();
    app.use((req, res, next) => withUser(1, next));
    app.use('/landscape', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/landscape?userId=2`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const text = await response.text();
      assert.match(text, /My checking/);
      assert.match(text, /My debt/);
      assert.match(text, /My goal/);
      assert.doesNotMatch(text, /Private|fixture-secret|shared-provider|access_token|plaid_account_id|account_id/);
      const graph = JSON.parse(text);
      assert.equal(graph.nodes.find(n => n.id === 'account-1').amount, 100);
      assert.equal(graph.coverage.unassignedActivity, 0);
      assert.equal(graph.edges.filter(e => e.kind === 'activity').length, 2);
    } finally { await new Promise(resolve => server.close(resolve)); }
  } finally { await pg.close(); }
});
