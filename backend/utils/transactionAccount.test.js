import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import Database from '../db.js';
import dashboardRouter from '../routes/dashboard.js';
import transactionsRouter from '../routes/transactions.js';
import analyticsRouter from '../routes/analytics.js';
import { migratePrivateSchema } from './schema.js';
import { withUser } from './tenant.js';

test('transaction APIs resolve Plaid bank/card accounts, merged records and statement accounts without cross-tenant leaks', async t => {
  const pg = new PGlite();
  const adapter = db => ({ async query(sql, params = []) {
    const result = params.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } });
  await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
  await pg.exec(`
    INSERT INTO users(id,name) VALUES(2,'Second household');
    INSERT INTO accounts(id,user_id,name,kind,last4,institution) VALUES
      (1,1,'Statement checking','checking','1234','Statement bank'),
      (2,1,'Statement card','credit_card','4321','Statement issuer'),
      (3,2,'Private checking','checking','9999','Private bank');
    INSERT INTO plaid_connections(id,user_id,item_id,access_token_ciphertext,institution_name,status) VALUES
      (1,1,'item-1','unused','Example bank','connected'),
      (2,1,'item-2','unused','Example card issuer','connected'),
      (3,2,'item-3','unused','Private bank','connected');
    INSERT INTO plaid_accounts(connection_id,user_id,account_id,name,mask,type,subtype) VALUES
      (1,1,'checking','Main checking','1234','depository','checking'),
      (1,1,'savings','Rainy day','0001','depository','savings'),
      (2,1,'card','Rewards card','4321','credit','credit card'),
      (3,2,'foreign','Private card','9999','credit','credit card'),
      (3,2,'card','Foreign collision','9876','credit','credit card');
    INSERT INTO transactions(id,user_id,date,description,amount,direction,source,account_id,plaid_account_id) VALUES
      (1,1,'2026-11-01','Bank transaction',25,'DEBIT','plaid',NULL,'checking'),
      (2,1,'2026-11-01','Card purchase',25,'DEBIT','plaid',NULL,'card'),
      (3,1,'2026-11-01','Merged card',25,'DEBIT','statement.csv',2,'card'),
      (4,1,'2026-11-01','Statement transaction',25,'DEBIT','statement.csv',1,NULL),
      (5,1,'2026-11-01','Unknown transaction',25,'DEBIT','manual',NULL,NULL),
      (6,1,'2026-11-01','Savings deposit',25,'CREDIT','plaid',NULL,'savings'),
      (7,1,'2026-11-01','Missing account metadata',25,'DEBIT','plaid',NULL,'foreign'),
      (8,2,'2026-11-01','Private transaction',25,'DEBIT','plaid',NULL,'foreign');
  `);
  t.mock.method(Database.prototype, 'transaction', callback => pg.transaction(async tx => {
    const client = adapter(tx);
    await client.query('SET LOCAL ROLE finance_app_runtime');
    await client.query("SELECT set_config('app.user_id',$1,true)", ['1']);
    return callback(client);
  }));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 1 }; withUser(1, next); });
  app.use('/dashboard', dashboardRouter);
  app.use('/transactions', transactionsRouter);
  app.use('/analytics', analyticsRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const saveNote = (id, note) => fetch(`${base}/transactions/${id}/note`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note })
    });
    const saved = await saveNote(1, '  Replacement part for the office\nKeep receipt.  ');
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).note, 'Replacement part for the office\nKeep receipt.');
    assert.equal((await saveNote(8, 'must not cross households')).status, 404);
    assert.equal((await saveNote(1, 'x'.repeat(501))).status, 400);
    assert.equal((await saveNote(1, null)).status, 400);
    assert.equal((await saveNote(1, '\u0000')).status, 400);
    assert.equal((await saveNote('invalid', 'test')).status, 400);
    for (const [path, key] of [['/dashboard/all-transactions', 'transactions'], ['/transactions/transfer-review?importId=untracked', 'rows']]) {
      const response = await fetch(base + path);
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      const rows = data[key];
      assert.equal(rows.length, 7, 'joins never multiply rows or expose another household');
      const byId = new Map(rows.map(row => [Number(row.id), row]));
      const identity = id => {
        const row = byId.get(id);
        return [row.account_name, row.account_kind, row.account_institution, row.account_last4];
      };
      assert.deepEqual(identity(1), ['Main checking', 'checking', 'Example bank', '1234']);
      assert.deepEqual(identity(2), ['Rewards card', 'credit_card', 'Example card issuer', '4321']);
      assert.deepEqual(identity(3), identity(2), 'merged records retain their originating Plaid account metadata');
      assert.deepEqual(identity(4), ['Statement checking', 'checking', 'Statement bank', '1234']);
      assert.deepEqual(identity(5), [null, null, null, null]);
      assert.deepEqual(identity(6), ['Rainy day', 'savings', 'Example bank', '0001']);
      assert.deepEqual(identity(7), [null, null, null, null], 'foreign metadata never fills an unknown account');
      assert.equal(byId.get(2).direction, 'DEBIT');
      assert.match(byId.get(2).account_key, /^plaid:\d+$/);
      assert.equal(byId.get(3).account_key, byId.get(2).account_key);
      assert.notEqual(byId.get(1).account_key, byId.get(2).account_key);
      assert.equal(byId.get(4).account_key, 'account:1');
      assert.equal(byId.get(5).account_key, 'unassigned');
      assert.equal(byId.get(7).account_key, 'unassigned');
      if (key === 'transactions') assert.equal(byId.get(1).note, 'Replacement part for the office\nKeep receipt.');
    }
    assert.equal((await saveNote(1, '=SUM(1,2)\nReceipt "saved"')).status, 200);
    const exported = await fetch(`${base}/analytics/export.csv?transactionId=1`);
    const csv = await exported.text();
    assert.equal(exported.status, 200, csv);
    assert.match(csv, /Transfer \(not counted\),Note\r\n/);
    assert.ok(csv.includes(`"'=SUM(1,2)\nReceipt ""saved"""`), 'notes use CSV quoting and formula-injection protection');
    assert.equal((await saveNote(1, '')).status, 200);
    assert.equal((await pg.query('SELECT note FROM transactions WHERE id=1')).rows[0].note, '');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pg.close();
  }
});
