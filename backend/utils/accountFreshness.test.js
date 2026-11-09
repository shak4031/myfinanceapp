import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import Database from '../db.js';
import accountsRouter from '../routes/accounts.js';
import { migratePrivateSchema } from './schema.js';
import { withUser } from './tenant.js';

test('Accounts includes verified Plaid activity and sync timestamps without refreshing recorded balances or guessing identities', async t => {
  const pg = new PGlite();
  const adapter = database => ({ async query(sql, params = []) {
    const result = params.length ? await database.query(sql, params) : (await database.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } });
  await pg.transaction(tx => migratePrivateSchema(adapter(tx)));
  await pg.exec(`
    INSERT INTO users(id,name) VALUES(2,'Private household');
    INSERT INTO accounts(id,user_id,name,kind,last4,institution,status) VALUES
      (1,1,'Checking','checking','5237','TD Bank','active'),
      (2,1,'Other institution','checking','5237','Other Bank','active'),
      (3,1,'Savings','savings','5237','TD Bank','active'),
      (4,1,'No mask','checking',NULL,'TD Bank','active'),
      (5,1,'Duplicate A','checking','1111','TD Bank','active'),
      (6,1,'Duplicate B','checking','1111','TD Bank','active'),
      (7,2,'Private','checking','5237','TD Bank','active'),
      (8,1,'No activity','checking','2222','TD Bank','active'),
      (9,1,'Duplicate connection','checking','3333','TD Bank','active');
    INSERT INTO plaid_connections(id,user_id,item_id,access_token_ciphertext,institution_name,status,last_sync_at,last_sync_attempt_at) VALUES
      (1,1,'current','unused','TD Bank','connected','2026-11-05T13:00:00Z','2026-11-05T13:00:00Z'),
      (2,2,'private','unused','TD Bank','connected','2026-11-06T13:00:00Z','2026-11-06T13:00:00Z'),
      (3,1,'other-item','unused','TD Bank','connected','2026-11-04T13:00:00Z','2026-11-04T13:00:00Z');
    INSERT INTO plaid_accounts(connection_id,user_id,account_id,name,mask,type,subtype) VALUES
      (1,1,'checking','Bank checking','5237','depository','checking'),
      (1,1,'ambiguous','Ambiguous checking','1111','depository','checking'),
      (1,1,'empty','Empty checking','2222','depository','checking'),
      (1,1,'duplicate1','Duplicate checking','3333','depository','checking'),
      (3,1,'duplicate2','Duplicate checking','3333','depository','checking'),
      (2,2,'checking','Private collision','5237','depository','checking');
    INSERT INTO transactions(user_id,date,description,amount,direction,balance,source,account_id,plaid_account_id,created_at) VALUES
      (1,'2026-10-23','Statement',10,'DEBIT',7332.75,'statement.csv',1,NULL,'2026-10-26T23:11:00Z'),
      (1,'2026-11-04','PAYROLL',6594.42,'CREDIT',NULL,'plaid',NULL,'checking','2026-11-05T13:00:00Z'),
      (2,'2026-11-06','Private activity',100,'CREDIT',NULL,'plaid',7,'checking','2026-11-06T13:00:00Z');
  `);
  t.mock.method(Database.prototype, 'transaction', callback => pg.transaction(async tx => {
    const client = adapter(tx);
    await client.query('SET LOCAL ROLE finance_app_runtime');
    await client.query("SELECT set_config('app.user_id','1',true)");
    return callback(client);
  }));
  const app = express();
  app.use((req, res, next) => withUser(1, next));
  app.use('/accounts', accountsRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const load = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/accounts`);
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  try {
    const result = await load();
    const checking = result.accounts.find(row => row.id === 1);
    assert.equal(checking.plaid.connectionId, 1, 'only a uniquely verified bank connection supplies a sync target');
    assert.equal(new Date(checking.plaid.lastSyncAt).toISOString(), '2026-11-05T13:00:00.000Z');
    assert.equal(checking.dataAsOf, '2026-11-04');
    assert.equal(checking.lastDataAddedAt, '2026-11-05T13:00:00.000Z');
    assert.equal(checking.transactions, 2);
    assert.equal(Number(checking.balance), 7332.75);
    assert.equal(checking.balanceAsOf, '2026-10-23', 'sync does not re-date a recorded statement balance');
    assert.equal(result.unassigned.some(row => row.source === 'plaid'), false);
    assert.equal(result.accounts.some(row => row.id === 7), false);
    for (const id of [2, 3, 4, 5, 6, 9]) assert.equal(result.accounts.find(row => row.id === id).plaid, null,
      'different institutions/types, missing identity, duplicate accounts and duplicate connections never inherit a sync timestamp');
    assert.equal(result.accounts.find(row => row.id === 8).dataAsOf, null);
    assert.ok(result.accounts.find(row => row.id === 8).plaid.lastSyncAt, 'zero-transaction accounts still show completed checks');
    await pg.exec(`UPDATE plaid_connections SET last_sync_at='2026-11-05T14:00:00Z',
      last_sync_attempt_at='2026-11-05T14:00:00Z' WHERE id=1`);
    const afterEmptySync = (await load()).accounts.find(row => row.id === 1);
    assert.equal(new Date(afterEmptySync.plaid.lastSyncAt).toISOString(), '2026-11-05T14:00:00.000Z');
    assert.equal(afterEmptySync.dataAsOf, checking.dataAsOf);
    await pg.exec(`UPDATE plaid_connections SET last_sync_attempt_at='2026-11-05T15:00:00Z',
      status='relink_required',last_error_code='ITEM_LOGIN_REQUIRED' WHERE id=1`);
    const failed = (await load()).accounts.find(row => row.id === 1);
    assert.equal(new Date(failed.plaid.lastSyncAt).toISOString(), '2026-11-05T14:00:00.000Z');
    assert.equal(new Date(failed.plaid.lastAttemptAt).toISOString(), '2026-11-05T15:00:00.000Z');
    assert.equal(failed.plaid.lastErrorCode, 'ITEM_LOGIN_REQUIRED');
  } finally { await new Promise(resolve => server.close(resolve)); await pg.close(); }
});
