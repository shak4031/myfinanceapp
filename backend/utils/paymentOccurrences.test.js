import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { reconcilePaymentOccurrences, loadFixedPaymentOccurrences } from './paymentOccurrences.js';
import { migratePrivateSchema } from './schema.js';
import { withUser } from './tenant.js';

const tx = (id, date, extra = {}) => ({ id, date, description: 'UTILITY PAYMENT', category: 'Utilities',
  amount: 100, direction: 'DEBIT', is_fixed: true, ...extra });
const build = (transactions, stored = [], today = new Date(2026, 10, 2)) =>
  reconcilePaymentOccurrences(transactions, stored, today, new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30));

test('unpaid monthly occurrences survive rollovers, missing template data and late payments without double counting', () => {
  const initial = build([tx(1, '2026-08-05')]);
  assert.deepEqual(initial.items.map(item => item.date), ['2026-09-05', '2026-10-05', '2026-11-05']);
  assert.ok(initial.items.every(item => item.status === 'projected' && item.isFixed));
  const next = build([tx(1, '2026-08-05')], initial.occurrences, new Date(2027, 0, 2));
  assert.deepEqual(next.items.map(item => item.date), ['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05', '2027-01-05']);
  const deleted = build([], next.occurrences, new Date(2027, 0, 2));
  assert.equal(deleted.items.length, next.items.length, 'snapshots retain outstanding occurrences if history is deleted');
  const late = build([tx(1, '2026-08-05'), tx(2, '2026-11-01', { is_fixed: false, amount: 115 })], initial.occurrences);
  assert.equal(late.occurrences.find(row => row.due_date === '2026-09-05').matched_transaction_id, 2);
  assert.deepEqual(late.items.filter(item => item.status === 'projected').map(item => item.date), ['2026-10-05', '2026-11-05']);
  assert.equal(late.items.filter(item => item.status === 'processed').length, 1);
  assert.equal(late.items.find(item => item.id === 2).amount, 115);
  assert.deepEqual(build([tx(1, '2026-08-05'), tx(2, '2026-11-01', { is_fixed: false, amount: 115 })], late.occurrences).items, late.items);
});

test('paid and ignored confirmations resolve only an occurrence and a later recorded confirmation does not settle two bills', () => {
  const transactions = [tx(1, '2026-08-05')];
  const initial = build(transactions);
  initial.occurrences[0].status = 'ignored';
  initial.occurrences[0].resolved_at = '2026-11-02T12:00:00.000Z';
  initial.occurrences[1].status = 'paid';
  initial.occurrences[1].resolved_at = new Date('2026-11-02T12:00:00.000Z');
  const confirmed = build(transactions, initial.occurrences);
  assert.deepEqual(confirmed.items.filter(item => item.status === 'projected').map(item => item.date), ['2026-11-05']);
  assert.equal(confirmed.items.find(item => item.confirmedPaid).date, '2026-11-02');
  const synced = build([...transactions, tx(2, '2026-11-03', { is_fixed: false })], confirmed.occurrences, new Date(2026, 10, 4));
  assert.equal(synced.occurrences.find(row => row.due_date === '2026-10-05').matched_transaction_id, 2);
  assert.equal(synced.occurrences.find(row => row.due_date === '2026-11-05').status, 'projected');
});

test('tracking handles leap years, future payments, pending records and owning Plaid accounts', () => {
  assert.equal(build([tx(1, '2024-01-31')], [], new Date(2024, 1, 5)).items[0].date, '2024-02-29');
  const result = build([tx(1, '2026-10-05', { plaid_account_id: 'checking' }),
    tx(2, '2026-11-01', { plaid_account_id: 'other', is_fixed: false }),
    tx(3, '2026-11-01', { plaid_account_id: 'checking', is_pending: true })]);
  assert.equal(result.items[0].status, 'projected');
  assert.throws(() => build([tx(1, 'bad date')]), /Invalid fixed payment data/);
  assert.throws(() => build([tx(1, '2026-10-05', { amount: 'bad' })]), /Invalid fixed payment data/);
});

test('unflagging the recurring bill stops future forecasts but does not silently clear overdue occurrences', () => {
  const initial = build([tx(1, '2026-09-05')]);
  const result = build([tx(1, '2026-09-05', { is_fixed: false })], initial.occurrences);
  assert.deepEqual(result.items.filter(item => item.status === 'projected').map(item => item.date), ['2026-10-05']);
});

test('new recorded bill amounts and dates update future estimates, never the unpaid earlier invoice', () => {
  const initial = build([tx(1, '2026-08-05')]);
  const updated = build([tx(1, '2026-08-05'), tx(2, '2026-10-07', { amount: 125 })], initial.occurrences);
  assert.equal(updated.occurrences.find(row => row.due_date === '2026-09-05').status, 'paid');
  assert.equal(updated.occurrences.find(row => row.due_date === '2026-10-05').amount, 100);
  const future = updated.occurrences.find(row => row.due_date === '2026-11-07');
  assert.equal(future.amount, 125);
  assert.equal(future.template.id, 2);
});

test('database tracking persists through restarts and is household isolated, including read-only support', async () => {
  const db = new PGlite();
  const adapter = database => ({ async query(sql, params = []) {
    const result = params.length ? await database.query(sql, params) : (await database.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } });
  const migrate = () => db.transaction(database => migratePrivateSchema(adapter(database)));
  const run = (id, callback, readOnly = false) => withUser(id, () => db.transaction(async database => {
    const client = adapter(database);
    if (readOnly) await client.query('SET TRANSACTION READ ONLY');
    await client.query('SET LOCAL ROLE finance_app_runtime');
    await client.query("SELECT set_config('app.user_id',$1,true)", [String(id)]);
    return callback(client);
  }), { readOnly });
  const today = new Date(2026, 10, 2), through = new Date(2026, 11, 2);
  try {
    await migrate();
    await db.exec(`INSERT INTO users(id,name) VALUES (2,'Other household');
      INSERT INTO transactions(user_id,date,description,amount,direction,is_fixed)
      VALUES(1,'2026-08-05','UTILITY PAYMENT',100,'DEBIT',TRUE),(2,'2026-08-05','PRIVATE BILL',200,'DEBIT',TRUE)`);
    const first = await run(1, client => loadFixedPaymentOccurrences(client, today, through));
    assert.equal(first.length, 3);
    assert.equal((await run(2, client => client.query('SELECT * FROM fixed_payment_occurrences'))).rows.length, 0);
    assert.equal((await run(1, client => client.query('SELECT * FROM fixed_payment_occurrences'))).rows.length, 3);
    await run(1, client => client.query(`UPDATE fixed_payment_occurrences SET status='ignored',resolved_at=NOW()
      WHERE payment_key=$1`, [first[0].paymentKey]));
    await migrate();
    const restarted = await run(1, client => loadFixedPaymentOccurrences(client, today, through));
    assert.equal(restarted.length, 2);
    assert.equal(restarted.some(item => item.paymentKey === first[0].paymentKey), false);
    const read = await run(2, client => loadFixedPaymentOccurrences(client, today, through), true);
    assert.equal(read.length, 3);
    assert.ok(read.every(item => item.description !== 'UTILITY'));
    assert.equal((await run(2, client => client.query('SELECT * FROM fixed_payment_occurrences'))).rows.length, 0, 'read-only support never persists previews');
    await assert.rejects(run(1, client => client.query("UPDATE fixed_payment_occurrences SET status='paid'"), true), /read-only/);
  } finally { await db.close(); }
});
