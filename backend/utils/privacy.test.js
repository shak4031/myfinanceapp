import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema, seedUserCategories, PRIVATE_TABLES } from './schema.js';
import { withUser, currentUserId } from './tenant.js';
import { hashPassword, verifyPassword, tokenHash, validCredentials } from './passwords.js';

test('tenant context fails closed and stays isolated across asynchronous requests', async () => {
  assert.throws(currentUserId, /authenticated/);
  assert.throws(() => withUser(0, () => {}), /valid/);
  const observed = await Promise.all([1, 2, 3].map(id => withUser(id, async () => {
    await new Promise(resolve => setTimeout(resolve, 4 - id));
    return currentUserId();
  })));
  assert.deepEqual(observed, [1, 2, 3]);
  assert.throws(currentUserId, /authenticated/);
});

test('password hashing uses random salts, verifies correctly and session tokens are hashed', async () => {
  const a = await hashPassword('safe-password-for-test');
  const b = await hashPassword('safe-password-for-test');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('safe-password-for-test', a), true);
  assert.equal(await verifyPassword('wrong-password-for-test', a), false);
  assert.equal(await verifyPassword('safe-password-for-test', 'broken'), false);
  assert.equal(validCredentials('user@example.com', 'a-long-password'), true);
  assert.equal(validCredentials('user@example.com', 'short'), false);
  assert.equal(validCredentials('invalid', 'a-long-password'), false);
  assert.equal(tokenHash('token').length, 64);
  assert.notEqual(tokenHash('token'), 'token');
});

test('real PostgreSQL row-level policies isolate reads, writes, references and missing contexts', async () => {
  const db = new PGlite();
  const client = { query: (sql, params) => params?.length ? db.query(sql, params) : db.exec(sql) };
  try {
    await client.query('BEGIN');
    await migratePrivateSchema(client);
    await client.query("INSERT INTO users (id,name,email) VALUES (2,'Second','second@example.com')");
    await client.query('COMMIT');
    async function asUser(id, operation) {
      await db.exec('BEGIN; SET LOCAL ROLE finance_app_runtime');
      try {
        if (id) await db.query("SELECT set_config('app.user_id',$1,true)", [String(id)]);
        const result = await operation();
        await db.exec('COMMIT');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }
    await asUser(1, () => seedUserCategories({ query: (sql, params) => db.query(sql, params) }, 1));
    await asUser(2, () => seedUserCategories({ query: (sql, params) => db.query(sql, params) }, 2));
    let ownerCategory, ownerLabel, ownerTransaction;
    await asUser(1, async () => {
      ownerCategory = (await db.query("SELECT id FROM categories WHERE name='Other'")).rows[0].id;
      ownerLabel = (await db.query("INSERT INTO transaction_labels (pattern,category_id,is_fixed) VALUES ('PRIVATE MERCHANT',$1,true) RETURNING id", [ownerCategory])).rows[0].id;
      ownerTransaction = (await db.query("INSERT INTO transactions (date,description,amount,direction,label_id,is_fixed) VALUES ('2026-09-20','PRIVATE MERCHANT',100,'DEBIT',$1,true) RETURNING id", [ownerLabel])).rows[0].id;
      await db.query("INSERT INTO savings_goals (name,target_amount) VALUES ('Owner college',10000)");
      await db.query("INSERT INTO credit_cards (name,balance) VALUES ('Owner loan',1000)");
      await db.query("INSERT INTO staging_transactions (description) VALUES ('Owner import')");
    });

    await test('upgrading legacy shared records preserves flags and assigns unowned data only to the owner', async () => {
      const db = new PGlite();
      const client = { query: (sql, params) => params?.length ? db.query(sql, params) : db.exec(sql) };
      try {
        await db.exec(`
          CREATE TABLE users (id SERIAL PRIMARY KEY,name TEXT,email TEXT UNIQUE,role TEXT DEFAULT 'admin');
          INSERT INTO users (id,name,email) VALUES (1,'Existing Owner','owner@example.com');
          CREATE TABLE categories (id SERIAL PRIMARY KEY,name TEXT UNIQUE,icon TEXT,color TEXT);
          INSERT INTO categories (id,name) VALUES (1,'Shopping');
          CREATE TABLE transaction_labels (id SERIAL PRIMARY KEY,pattern TEXT UNIQUE,display_label TEXT,
            category_id INTEGER REFERENCES categories(id),is_fixed BOOLEAN DEFAULT FALSE,is_excluded BOOLEAN DEFAULT FALSE);
          INSERT INTO transaction_labels (id,pattern,category_id,is_fixed) VALUES (1,'TARGET',1,TRUE);
          CREATE TABLE transactions (id SERIAL PRIMARY KEY,date TEXT,description TEXT,label_id INTEGER REFERENCES transaction_labels(id),
            amount REAL,direction TEXT,balance REAL,source TEXT,user_id INTEGER REFERENCES users(id),
            category TEXT,is_fixed BOOLEAN DEFAULT FALSE);
          INSERT INTO transactions VALUES (1,'2026-09-20','TARGET',1,100,'DEBIT',900,'import',1,'Shopping',TRUE);
          CREATE TABLE savings_goals (id SERIAL PRIMARY KEY,name TEXT,target REAL,current REAL,deadline TEXT);
          INSERT INTO savings_goals VALUES (1,'Existing college goal',10000,1200,'2027-04-01');
        `);
        await client.query('BEGIN');
        await migratePrivateSchema(client);
        await client.query('COMMIT');
        await db.exec("BEGIN; SET LOCAL ROLE finance_app_runtime; SELECT set_config('app.user_id','1',true)");
        const transaction = (await db.query('SELECT * FROM transactions')).rows[0];
        assert.equal(transaction.is_fixed, true);
        assert.equal(transaction.category, 'Shopping');
        assert.equal(transaction.balance, 900);
        assert.equal((await db.query('SELECT * FROM transaction_labels')).rows[0].is_fixed, true);
        const goal = (await db.query('SELECT * FROM savings_goals')).rows[0];
        assert.equal(goal.user_id, 1);
        assert.equal(goal.target_amount, 10000);
        assert.equal(goal.current_amount, 1200);
        await db.exec('COMMIT');
      } finally { await db.close(); }
    });
    await asUser(2, async () => {
      for (const table of ['transactions', 'transaction_labels', 'credit_cards', 'savings_goals', 'staging_transactions']) {
        assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0, table);
        assert.equal((await db.query(`UPDATE ${table} SET user_id=user_id RETURNING id`)).rows.length, 0, table);
        assert.equal((await db.query(`DELETE FROM ${table} RETURNING id`)).rows.length, 0, table);
      }
      assert.equal((await db.query('SELECT * FROM transactions WHERE id=$1', [ownerTransaction])).rows.length, 0);
      assert.equal((await db.query("INSERT INTO transactions (date,description,amount,direction) VALUES ('2026-09-20','Second only',200,'DEBIT') RETURNING user_id")).rows[0].user_id, 2);
      // The same merchant pattern is independently controllable in each account.
      await db.query("INSERT INTO transaction_labels (pattern,is_fixed) VALUES ('PRIVATE MERCHANT',false)");
    });
    await assert.rejects(asUser(2, () => db.query("INSERT INTO transactions (user_id,date,amount,direction) VALUES (1,'2026-09-20',99,'DEBIT')")), /row-level security/);
    await assert.rejects(asUser(2, () => db.query("INSERT INTO transaction_labels (pattern,category_id) VALUES ('FOREIGN CATEGORY',$1)", [ownerCategory])), /foreign key/);
    await assert.rejects(asUser(2, () => db.query("INSERT INTO transactions (date,amount,direction,label_id) VALUES ('2026-09-20',99,'DEBIT',$1)", [ownerLabel])), /foreign key/);
    await assert.rejects(asUser(2, () => db.query("UPDATE transactions SET user_id=1 WHERE description='Second only'")), /row-level security/);
    await asUser(null, async () => {
      for (const table of PRIVATE_TABLES) assert.equal((await db.query(`SELECT * FROM ${table}`)).rows.length, 0, table);
    });
    await assert.rejects(asUser(null, () => db.query("INSERT INTO transactions (date,amount,direction) VALUES ('2026-09-20',1,'DEBIT')")), /row-level security|not-null/);
    await assert.rejects(asUser(2, () => db.query('SELECT password_hash FROM users')), /permission denied/);
    await assert.rejects(asUser(2, () => db.query('SELECT * FROM sessions')), /permission denied/);
    await assert.rejects(asUser(2, () => db.query('TRUNCATE transactions')), /permission denied/);
    await asUser(1, async () => {
      assert.equal((await db.query('SELECT amount FROM transactions')).rows.length, 1);
      assert.equal((await db.query('SELECT is_fixed FROM transaction_labels')).rows[0].is_fixed, true);
    });
    // Startup migration must remain repeatable without changing private flags/balances.
    await client.query('BEGIN');
    await migratePrivateSchema(client);
    await client.query('COMMIT');
    await asUser(1, async () => assert.equal((await db.query('SELECT is_fixed FROM transactions')).rows[0].is_fixed, true));
  } finally {
    await db.close();
  }
});
