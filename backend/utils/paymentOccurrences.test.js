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

test('carryover is limited to last month and recorded payments settle their own month', () => {
  const initial = build([tx(1, '2026-09-05')]);
  assert.deepEqual(initial.items.map(item => item.date), ['2026-10-05', '2026-11-05']);
  assert.ok(initial.items.every(item => item.status === 'projected' && item.isFixed));
  const next = build([tx(1, '2026-09-05'), tx(4, '2026-11-05')], initial.occurrences, new Date(2027, 0, 2));
  assert.deepEqual(next.items.map(item => item.date), ['2026-12-05', '2027-01-05']);
  const deleted = build([], next.occurrences, new Date(2027, 0, 2));
  assert.equal(deleted.items.length, next.items.length, 'snapshots retain outstanding occurrences if history is deleted');
  const late = build([tx(1, '2026-09-05'), tx(2, '2026-11-01', { is_fixed: false, amount: 115 })], initial.occurrences);
  assert.equal(late.occurrences.find(row => row.due_date === '2026-11-05').matched_transaction_id, 2);
  assert.deepEqual(late.items.filter(item => item.status === 'projected').map(item => item.date), ['2026-10-05', '2026-12-01']);
  assert.equal(late.items.filter(item => item.status === 'processed').length, 1);
  assert.equal(late.items.find(item => item.id === 2).amount, 115);
  assert.deepEqual(build([tx(1, '2026-09-05'), tx(2, '2026-11-01', { is_fixed: false, amount: 115 })], late.occurrences).items, late.items);
});

test('paid and ignored confirmations resolve only an occurrence and a later recorded confirmation does not settle two bills', () => {
  const transactions = [tx(1, '2026-09-05')];
  const initial = build(transactions);
  initial.occurrences[0].status = 'paid';
  initial.occurrences[0].resolved_at = new Date('2026-11-02T12:00:00.000Z');
  initial.occurrences[1].status = 'ignored';
  initial.occurrences[1].resolved_at = '2026-11-02T12:00:00.000Z';
  const confirmed = build(transactions, initial.occurrences);
  assert.deepEqual(confirmed.items.filter(item => item.status === 'projected').map(item => item.date), []);
  assert.equal(confirmed.items.find(item => item.confirmedPaid).date, '2026-11-02');
  const synced = build([...transactions, tx(2, '2026-10-21', { is_fixed: false })], confirmed.occurrences, new Date(2026, 10, 4));
  assert.equal(synced.occurrences.find(row => row.due_date === '2026-10-05').matched_transaction_id, 2);
  assert.equal(synced.occurrences.find(row => row.due_date === '2026-11-05').status, 'ignored');
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
  const initial = build([tx(1, '2026-09-05')]);
  const updated = build([tx(1, '2026-09-05'), tx(2, '2026-10-07', { amount: 125 })], initial.occurrences);
  assert.equal(updated.occurrences.find(row => row.due_date === '2026-10-05').status, 'paid');
  assert.equal(updated.occurrences.find(row => row.due_date === '2026-10-05').amount, 125);
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
      VALUES(1,'2026-09-05','UTILITY PAYMENT',100,'DEBIT',TRUE),(2,'2026-09-05','PRIVATE BILL',200,'DEBIT',TRUE)`);
    const first = await run(1, client => loadFixedPaymentOccurrences(client, today, through));
    assert.equal(first.length, 2);
    assert.equal((await run(2, client => client.query('SELECT * FROM fixed_payment_occurrences'))).rows.length, 0);
    assert.equal((await run(1, client => client.query('SELECT * FROM fixed_payment_occurrences'))).rows.length, 2);
    await run(1, client => client.query(`INSERT INTO fixed_payment_occurrences
      (payment_key,due_date,template,amount,status,user_id)
      VALUES('expired','2026-09-05',$1,100,'projected',1)`, [JSON.stringify(tx(1, '2026-08-05'))]));
    await run(1, client => loadFixedPaymentOccurrences(client, today, through));
    assert.equal((await run(1, client => client.query("SELECT * FROM fixed_payment_occurrences WHERE payment_key='expired'"))).rows.length, 0);
    await db.query(`INSERT INTO transactions(id,user_id,date,description,amount,direction,is_fixed)
      VALUES(100,1,'2026-05-11','COMCAST XFINITY',85,'DEBIT',TRUE)`);
    await run(1, client => client.query(`INSERT INTO fixed_payment_occurrences
      (payment_key,due_date,template,amount,status,user_id)
      VALUES('ended','2026-10-11',$1,85,'projected',1)`,
    [JSON.stringify(tx(100, '2026-05-11', { description: 'COMCAST XFINITY', amount: 85 }))]));
    await run(1, client => loadFixedPaymentOccurrences(client, today, through));
    assert.equal((await run(1, client => client.query("SELECT * FROM fixed_payment_occurrences WHERE payment_key='ended'"))).rows.length, 0);
    await run(1, client => client.query(`UPDATE fixed_payment_occurrences SET status='ignored',resolved_at=NOW()
      WHERE payment_key=$1`, [first[0].paymentKey]));
    await migrate();
    const restarted = await run(1, client => loadFixedPaymentOccurrences(client, today, through));
    assert.equal(restarted.length, 1);
    assert.equal(restarted.some(item => item.paymentKey === first[0].paymentKey), false);
    const read = await run(2, client => loadFixedPaymentOccurrences(client, today, through), true);
    assert.equal(read.length, 2);
    assert.ok(read.every(item => item.description !== 'UTILITY'));
    assert.equal((await run(2, client => client.query('SELECT * FROM fixed_payment_occurrences'))).rows.length, 0, 'read-only support never persists previews');
    await assert.rejects(run(1, client => client.query("UPDATE fixed_payment_occurrences SET status='paid'"), true), /read-only/);
  } finally { await db.close(); }
});

test('dashboard load persists corrected Rocket Money matches without changing ledger records', async () => {
  const db = new PGlite();
  const adapter = database => ({ async query(sql, params = []) {
    const result = params.length ? await database.query(sql, params) : (await database.exec(sql)).at(-1);
    return { ...result, rowCount: result.affectedRows ?? result.rows.length };
  } });
  const load = () => withUser(1, () => db.transaction(async database => {
    const client = adapter(database);
    await client.query('SET LOCAL ROLE finance_app_runtime');
    await client.query("SELECT set_config('app.user_id','1',true)");
    return loadFixedPaymentOccurrences(client, new Date(2026, 10, 2), new Date(2026, 11, 2));
  }));
  try {
    await db.transaction(database => migratePrivateSchema(adapter(database)));
    await db.exec(`INSERT INTO transactions(id,user_id,date,description,amount,direction,is_fixed)
      VALUES(1,1,'2026-08-25','ROCKET MONEY PREMIUM',9,'DEBIT',TRUE),
        (2,1,'2026-09-25','ROCKET MONEY PREMIUM',9,'DEBIT',TRUE),
        (3,1,'2026-10-21','ROCKET MONEY PREMIUM',9,'DEBIT',TRUE)`);
    const before = (await db.query('SELECT * FROM transactions ORDER BY id')).rows;
    await db.query(`INSERT INTO fixed_payment_occurrences
      (user_id,payment_key,due_date,template,amount,status,matched_transaction_id)
      VALUES(1,'old','2026-09-25',$1,9,'paid',3),(1,'oct','2026-10-25',$2,9,'projected',NULL)`,
    [JSON.stringify(before[0]), JSON.stringify(before[1])]);
    const result = await load();
    assert.equal(result.some(item => item.status === 'projected' && item.date < '2026-11-01'), false);
    const corrected = (await db.query("SELECT * FROM fixed_payment_occurrences WHERE payment_key='oct'")).rows[0];
    assert.equal(corrected.status, 'paid');
    assert.equal(corrected.matched_transaction_id, 3);
    assert.deepEqual(await load(), result);
    assert.deepEqual((await db.query('SELECT * FROM transactions ORDER BY id')).rows, before);
  } finally { await db.close(); }
});

test('Rocket Money October payment settles October despite an earlier estimated day and legacy misassignment', () => {
  const history = [
    tx(1, '2026-08-25', { description: 'ROCKET MONEY PREMIUM', amount: 9, plaid_account_id: 'checking' }),
    tx(2, '2026-09-25', { description: 'ROCKET MONEY PREMIUM', amount: 9, plaid_account_id: 'checking' }),
    tx(3, '2026-10-21', { description: 'ROCKET MONEY PREMIUM', amount: 9, plaid_account_id: 'checking' })
  ];
  const stored = [
    { payment_key: 'old', due_date: '2026-09-25', template: history[0], amount: 9, status: 'paid', matched_transaction_id: 3, resolved_at: null },
    { payment_key: 'october', due_date: '2026-10-25', template: history[1], amount: 9, status: 'projected', matched_transaction_id: null, resolved_at: null }
  ];
  const result = build(history, stored);
  assert.equal(result.occurrences.find(row => row.payment_key === 'october').matched_transaction_id, 3);
  assert.equal(result.items.some(item => item.status === 'projected' && item.date < '2026-11-01'), false);
  assert.equal(result.items.find(item => item.status === 'projected').date, '2026-11-21');
  const rerun = build(history, result.occurrences);
  assert.deepEqual(rerun.items, result.items, 'saved correction is idempotent');
});

test('saved automatic cross-month matches are reassigned within the window without consuming a current-month payment', () => {
  const history = [tx(1, '2026-08-05'), tx(2, '2026-10-21'), tx(3, '2026-11-01', { is_fixed: false })];
  const stored = [
    { payment_key: 'oct', due_date: '2026-10-05', template: history[0], amount: 100, status: 'paid', matched_transaction_id: 3, resolved_at: null },
    { payment_key: 'nov', due_date: '2026-11-05', template: history[0], amount: 100, status: 'projected', matched_transaction_id: null, resolved_at: null }
  ];
  const result = build(history, stored);
  assert.equal(result.occurrences.find(row => row.payment_key === 'oct').matched_transaction_id, 2);
  assert.equal(result.occurrences.find(row => row.payment_key === 'nov').matched_transaction_id, 3);
  assert.equal(result.items.filter(item => item.status === 'projected' && item.date < '2026-12-01').length, 0);
});

test('Hyundai renamed and unrenamed records settle one bill and repair duplicate saved templates', () => {
  const history = [
    tx(1, '2026-08-27', { description: 'HYUNDAI LEASE ONLINE PMT', display_name: null, amount: 443 }),
    tx(2, '2026-09-24', { description: 'HYUNDAI LEASE ONLINE PMT', display_name: 'Hyundai Lease', amount: 443 }),
    tx(3, '2026-10-22', { description: 'HYUNDAI LEASE ONLINE PMT', display_name: 'Hyundai Lease', amount: 443 })
  ];
  const stored = [
    { payment_key: 'older-name', due_date: '2026-10-07', template: { ...history[0], date: '2026-07-07' }, amount: 443, status: 'projected' },
    { payment_key: 'renamed', due_date: '2026-10-24', template: history[1], amount: 443, status: 'projected' }
  ];
  const result = build(history, stored);
  assert.equal(result.items.some(item => item.date.startsWith('2026-10') && item.status === 'projected'), false);
  assert.equal(result.occurrences.filter(row => row.due_date.startsWith('2026-10')).length, 1);
  assert.equal(result.items.filter(item => item.date.startsWith('2026-11') && item.status === 'projected').length, 1);
  assert.deepEqual(build(history, result.occurrences).items, result.items);
});

test('shortened provider description settles a same-account equal-amount subscription without a Fixed flag or rename', () => {
  const history = [
    tx(1, '2026-09-24', { description: 'VISA DDA PUR AP 469216 GOOGLE CLAUDE BY ANTH 855 836 3987 * CA',
      display_name: 'Google Claude', plaid_account_id: 'same-bank', amount: 21.32 }),
    tx(2, '2026-10-26', { description: 'Claude By Anth', display_name: null, plaid_account_id: 'same-bank',
      amount: 21.32, is_fixed: false, category: 'Other' }),
    tx(3, '2026-09-16', { description: 'PSEG PAYMENT', amount: 90 })
  ];
  const result = build(history);
  const overdue = result.items.filter(item => item.date < '2026-11-01' && item.status === 'projected');
  assert.deepEqual(overdue.map(item => item.description), ['PSEG']);
  assert.equal(result.occurrences.find(row => row.template.id === 1 && row.due_date.startsWith('2026-10')).matched_transaction_id, 2);
  assert.ok(result.items.some(item => item.date === '2026-11-26' && item.status === 'projected'));
});

test('stale fixed flags do not revive ended bills and saved false positives are discarded', () => {
  const ended = tx(1, '2026-05-11', { description: 'COMCAST XFINITY' });
  const stored = [{ payment_key: 'stale', due_date: '2026-10-11', template: ended, amount: 100, status: 'projected' }];
  assert.deepEqual(build([ended], stored).items, []);
  assert.deepEqual(build([ended], stored).occurrences, []);
  assert.deepEqual(build([tx(1, '2026-08-10', { description: 'OLD FIXED FEE' })]).items, []);
});

test('description variants never settle another account, generic merchant or ambiguous bill', () => {
  const original = tx(1, '2026-09-24', { description: 'GOOGLE CLAUDE BY ANTH', display_name: 'Personal subscription',
    plaid_account_id: 'same-bank', amount: 21.32 });
  for (const changes of [
    { plaid_account_id: 'other-bank' }, { description: 'GOOGLE OTHER SUBSCRIPTION' },
    { plaid_account_id: null }
  ]) {
    const result = build([original, tx(2, '2026-10-26', { description: 'CLAUDE BY ANTH', plaid_account_id: 'same-bank',
      amount: 21.32, is_fixed: false, ...changes })]);
    assert.equal(result.items.filter(item => item.date.startsWith('2026-10') && item.status === 'projected').length, 1);
  }
  const ambiguous = build([original,
    { ...original, id: 3, description: 'CLAUDE BY ANTH BUSINESS', display_name: 'Business subscription' },
    tx(2, '2026-10-26', { description: 'CLAUDE BY ANTH', plaid_account_id: 'same-bank', amount: 21.32, is_fixed: false })]);
  assert.equal(ambiguous.items.filter(item => item.date.startsWith('2026-10') && item.status === 'projected').length, 2);
});

test('OLLO Plaid payments settle the correct month despite a changed amount and missing masked reference', () => {
  for (const isFixed of [true, false]) {
    const original = tx(1, '2026-10-06', { description: 'OLLO PAYMENT X1234', display_name: 'OLLO Card',
      account_id: 9, amount: 155, pay_mode: 'auto' });
    const paid = tx(2, '2026-11-05', { description: 'OLLO CC', display_name: 'OLLO Card', account_id: 9,
      amount: 150, is_fixed: isFixed });
    const initial = build([original], [], new Date(2026, 10, 6));
    const result = build([original, paid], initial.occurrences, new Date(2026, 10, 6));
    assert.equal(result.items.filter(item => item.status === 'projected' && item.date.startsWith('2026-11')).length, 0);
    const item = result.items.find(item => item.id === 2);
    assert.equal(item.amount, 150);
    assert.equal(item.date, '2026-11-05');
    assert.equal(item.payMode, 'auto');
    assert.equal(result.items.find(item => item.status === 'projected').amount, 150);
    assert.deepEqual(build([original, paid], result.occurrences, new Date(2026, 10, 6)).items, result.items);
  }
});

test('variable-amount shortened merchant descriptions match only with a verified unique source account', () => {
  const original = tx(1, '2026-10-06', { description: 'GOOGLE CLAUDE BY ANTH', amount: 155, account_id: 9 });
  const paid = tx(2, '2026-11-05', { description: 'CLAUDE BY ANTH', amount: 150, account_id: 9, is_fixed: false });
  const result = build([original, paid], [], new Date(2026, 10, 6));
  assert.equal(result.items.some(item => item.status === 'projected' && item.date.startsWith('2026-11')), false);
  assert.equal(build([original, { ...paid, is_fixed: true }], [], new Date(2026, 10, 6)).items
    .some(item => item.status === 'projected' && item.date.startsWith('2026-11')), false);
  for (const changes of [{ account_id: 10 }, { account_id: null }, { description: 'OTHER SUBSCRIPTION' }]) {
    assert.equal(build([original, { ...paid, ...changes }], [], new Date(2026, 10, 6)).items[0].status, 'projected');
  }
});

test('OLLO mobile-pay history with two September payments settles the shortened November payment', () => {
  const metadata = { account_institution: 'TD Bank', account_last4: '5261', account_kind: 'checking',
    display_name: 'OLLO Card', category: 'Credit Cards', pay_mode: 'auto' };
  for (const crossSource of [false, true]) {
    const source = { account_id: 9 };
    const history = [
      tx(1, '2026-09-03', { ...metadata, ...source, description: 'OLLO CC MOBILE PAY', amount: 250 }),
      tx(2, '2026-09-08', { ...metadata, ...source, description: 'OLLO CC MOBILE PAY', amount: 164 }),
      tx(3, '2026-10-06', { ...metadata, ...source, description: 'OLLO CC MOBILE PAY', amount: 155 }),
      tx(4, '2026-10-09', { account_id: 10, description: 'Interest Charge on Purchases', amount: 104.25,
        category: 'Interest Charges', is_fixed: false })
    ];
    const paid = tx(5, '2026-11-05', { ...metadata,
      ...(crossSource ? { plaid_account_id: 'td-checking-5261' } : source),
      description: 'OLLO CC', amount: 150 });
    const initial = build(history, [], new Date(2026, 10, 4));
    const pending = build([...history, { ...paid, is_pending: true }], initial.occurrences, new Date(2026, 10, 6));
    assert.equal(pending.items.find(item => item.dueDate === '2026-11-06').status, 'projected');
    assert.equal(pending.items.find(item => item.dueDate === '2026-11-06').amount, 155);
    assert.equal(pending.occurrences.some(row => row.matched_transaction_id === paid.id), false);
    const result = build([...history, { ...paid, is_pending: false }], pending.occurrences, new Date(2026, 10, 6));
    assert.equal(result.items.some(item => item.status === 'projected' && item.date.startsWith('2026-11')), false);
    assert.equal(result.occurrences.find(row => row.due_date === '2026-11-06').matched_transaction_id, paid.id);
    assert.equal(result.items.find(item => item.id === paid.id).amount, 150);
    assert.equal(result.items.find(item => item.status === 'projected').amount, 150);
    assert.deepEqual(build([...history, paid], result.occurrences, new Date(2026, 10, 6)).items, result.items);
  }
});

test('CSV and Plaid bill identities require matching institution, source mask and account kind', () => {
  const metadata = { account_institution: 'Example Bank', account_last4: '5261', account_kind: 'checking' };
  const original = tx(1, '2026-10-06', { ...metadata, description: 'OLLO PAYMENT X1234', amount: 155, account_id: 9 });
  const paid = tx(2, '2026-11-05', { ...metadata, description: 'OLLO CC', amount: 150, plaid_account_id: 'plaid-checking' });
  const result = build([original, paid], [], new Date(2026, 10, 6));
  assert.equal(result.items.filter(item => item.date.startsWith('2026-11') && item.status === 'projected').length, 0);
  for (const changes of [{ account_institution: 'Other Bank' }, { account_last4: '9999' }, { account_kind: 'savings' },
    { account_institution: null }, { account_kind: 'unknown' }, { description: 'OLLO PAYMENT X5678' }]) {
    const unmatched = build([original, { ...paid, ...changes }], [], new Date(2026, 10, 6));
    assert.ok(unmatched.items.some(item => item.date.startsWith('2026-11') && item.status === 'projected'));
  }
});

test('a shortened OLLO payee cannot settle either of two differently masked cards', () => {
  const original = tx(1, '2026-10-06', { description: 'OLLO PAYMENT X1234', amount: 155, account_id: 9 });
  const other = { ...original, id: 3, description: 'OLLO PAYMENT X5678', amount: 90 };
  const paid = tx(2, '2026-11-05', { description: 'OLLO CC', amount: 150, account_id: 9 });
  const result = build([original, other, paid], [], new Date(2026, 10, 6));
  assert.equal(result.items.filter(item => item.date.startsWith('2026-11') && item.status === 'projected').length, 2);
});

test('a CSV source identity shared by two different Plaid accounts is ambiguous', () => {
  const metadata = { account_institution: 'Example Bank', account_last4: '5261', account_kind: 'checking' };
  const original = tx(1, '2026-10-06', { ...metadata, description: 'OLLO PAYMENT', account_id: 9, amount: 155 });
  const paid = tx(2, '2026-11-05', { ...metadata, description: 'OLLO CC', plaid_account_id: 'first', amount: 150 });
  const duplicateMask = { ...paid, id: 3, plaid_account_id: 'second' };
  const result = build([original, paid, duplicateMask], [], new Date(2026, 10, 6));
  assert.ok(result.items.some(item => item.status === 'projected' && item.date.startsWith('2026-11')));
});
