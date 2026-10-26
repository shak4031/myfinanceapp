import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUpcomingPayments, isFixedPayment } from './fixedPayments.js';
import { detectPayMode, inheritPayMode } from './payMode.js';

const today = new Date(2026, 9, 14);
const tx = (id, changes = {}) => ({
  id, date: '2026-09-20', description: 'PSEG PAYMENT', category: 'Utilities',
  amount: 125.50, direction: 'DEBIT', is_fixed: true, ...changes
});

test('the user fixed flag is authoritative regardless of category or merchant', () => {
  for (const description of ['TARGET', 'NETFLIX', 'TRANSFER TO SAVINGS', 'GAS STATION', 'VISA DDA PUR CHASE CENTER', 'CUSTOM COLLEGE FEE']) {
    for (const category of ['Shopping', 'Groceries', 'Savings', 'Credit Cards', 'Other']) {
      assert.equal(isFixedPayment(tx(1, { description, category })), true);
      assert.equal(isFixedPayment(tx(1, { description, category, is_fixed: false })), false);
    }
  }
  assert.equal(isFixedPayment(tx(1, { direction: 'CREDIT' })), false);
  assert.equal(isFixedPayment(tx(1, { is_fixed: 'true' })), true);
  assert.equal(isFixedPayment(tx(1, { is_fixed: '1' })), true);
});

test('last month flagged debit supplies its exact amount and payment day, not older bills', () => {
  const result = buildUpcomingPayments([
    tx(1, { date: '2026-08-10', description: 'VERIZON' }),
    tx(2, { date: '2026-09-05', amount: 90 }),
    tx(3),
    tx(4, { date: '2026-09-15', description: 'PENNYMAC', is_fixed: false }),
    tx(5, { date: '2026-10-15', description: 'NEW BILL' })
  ], today);
  assert.deepEqual(result, [{
    sourceTransactionId: 3, description: 'PSEG', category: 'Utilities',
    amount: 125.50, dayOfMonth: 20, isIncome: false, status: 'projected', payMode: null
  }]);
});

test('statement wording reveals auto-pay or manual payments; anything else stays unset', () => {
  for (const text of ['PSEG AUTOPAY 0001', 'Verizon Auto-Pay', 'AUTO PAY CHASE', 'GEICO AUTO DEBIT', 'NETFLIX RECURRING']) assert.equal(detectPayMode(text), 'auto', text);
  for (const text of ['BILL PAY VERIZON', 'BILLPAY PSEG', 'ONLINE PMT CITI', 'Online Banking Payment to CRD 1234', 'MOBILE PAYMENT AMEX', 'WEB PMT OLLO']) assert.equal(detectPayMode(text), 'manual', text);
  for (const text of ['AUTOMOTIVE PARTS', 'NETFLIX COM', 'ZELLE TO JOHN', '', null]) assert.equal(detectPayMode(text), null, String(text));
});

test('a new debit inherits the newest explicit pay mode of the same bill, never for credits', () => {
  const history = [
    { description: 'PSEG PAYMENT', pay_mode: 'manual' },
    { description: 'PSEG PAYMENT AUTOPAY', pay_mode: 'auto' },
    { description: 'OLLO PAYMENT X1234', pay_mode: 'auto' }
  ];
  assert.equal(inheritPayMode({ description: 'PSEG   PAYMENT', direction: 'debit' }, history), 'manual');
  assert.equal(inheritPayMode({ description: 'OLLO PAYMENT X1234', direction: 'DEBIT' }, history), 'auto');
  assert.equal(inheritPayMode({ description: 'OLLO PAYMENT X5678', direction: 'DEBIT' }, history), null);
  assert.equal(inheritPayMode({ description: 'PSEG PAYMENT', direction: 'CREDIT' }, history), null);
  assert.equal(inheritPayMode({ description: 'NEW GYM AUTOPAY', direction: 'DEBIT' }, history), 'auto');
});

test('upcoming bills carry their own pay mode, or the newest one set on another payment of the same bill', () => {
  const result = buildUpcomingPayments([
    tx(1, { date: '2026-08-20', is_fixed: false, pay_mode: 'auto' }),
    tx(2),
    tx(3, { description: 'VERIZON', date: '2026-09-12', pay_mode: 'manual' }),
    tx(4, { description: 'OLLO PAYMENT', date: '2026-09-25' })
  ], today);
  assert.deepEqual(Object.fromEntries(result.map(row => [row.description, row.payMode])), { PSEG: 'auto', VERIZON: 'manual', OLLO: null });
});

test('a flagged shopping transaction enters the schedule and unflagging removes it', () => {
  const transaction = tx(1, { description: 'TARGET', category: 'Shopping' });
  assert.equal(buildUpcomingPayments([transaction], today).length, 1);
  assert.deepEqual(buildUpcomingPayments([{ ...transaction, is_fixed: false }], today), []);
});

test('payments already made match despite missing flag, changed amount or description spacing', () => {
  const result = buildUpcomingPayments([
    tx(1),
    tx(2, { date: '10/08/2026', description: 'pseg   payment', amount: 140, is_fixed: false })
  ], today);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'processed');
  assert.equal(result[0].amount, 140);
});

test('credit-card references can change without adding extra bills', () => {
  const result = buildUpcomingPayments([
    tx(1, { description: 'OLLO PAYMENT REF 12345' }),
    tx(2, { date: '2026-10-10', description: 'ollo PAYMENT REF 67890', is_fixed: false })
  ], today);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'processed');
});

test('separate accounts do not pay one another even with the same merchant label', () => {
  const result = buildUpcomingPayments([
    tx(1, { description: 'OLLO PAYMENT X1234', label_id: 7 }),
    tx(2, { description: 'OLLO PAYMENT XX5678', label_id: 7, amount: 50 }),
    tx(3, { date: '2026-10-10', description: 'OLLO PAYMENT **1234', label_id: 7 })
  ], today);
  assert.equal(result.filter(row => row.status === 'processed').length, 1);
  assert.equal(result.filter(row => row.status === 'projected').length, 1);
  assert.equal(result.find(row => row.status === 'projected').amount, 50);
});

test('a shared category label cannot turn unrelated card purchases into paid fixed bills', () => {
  const result = buildUpcomingPayments([
    tx(1, { description: 'SANTANDER AUTO PAYMENT', category: 'Car Loans', label_id: 7 }),
    tx(2, { date: '2026-10-10', description: 'SANTANDER AUTO PAYMENT', amount: 450, is_fixed: false, label_id: 7 }),
    ...['GOFUNDME', 'HUNGRY TIGER', 'CHESS', 'AFTERPAY', 'CAR WASH', 'SCHOOL', 'WAWA'].map((merchant, i) =>
      tx(i + 3, { date: '2026-10-10', description: `VISA DDA PUR AP 123456 ${merchant}`, category: 'Car Loans', label_id: 7, is_fixed: false }))
  ], today, { through: new Date(2026, 10, 13) });
  assert.deepEqual(result.filter(row => row.status === 'processed').map(row => row.id), [2]);
  assert.equal(result.find(row => row.id === 2).isFixed, true);
  assert.equal(result.filter(row => row.status === 'projected').length, 0);
});

test('same merchant on another source account does not settle a fixed bill', () => {
  const result = buildUpcomingPayments([
    tx(1, { account_id: 1 }),
    tx(2, { account_id: 2, date: '2026-10-10', is_fixed: false })
  ], today);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'projected');
});

test('month end clamps correctly across leap years and January rollover', () => {
  assert.equal(buildUpcomingPayments([tx(1, { date: '2026-01-31' })], new Date(2026, 1, 10))[0].dayOfMonth, 28);
  assert.equal(buildUpcomingPayments([tx(1, { date: '2024-01-31' })], new Date(2024, 1, 10))[0].dayOfMonth, 29);
  assert.equal(buildUpcomingPayments([tx(1, { date: '2025-12-31' })], new Date(2026, 0, 10))[0].dayOfMonth, 31);
});

test('overdue unpaid bills still reduce the projection and no payroll or payoff amount is invented', () => {
  const result = buildUpcomingPayments([
    tx(1, { date: '2026-09-03' }),
    tx(2, { description: 'VERIZON', amount: 200, date: '2026-09-25' }),
    tx(3, { direction: 'CREDIT', description: 'PAYROLL', amount: 5000 }),
    tx(4, { date: '2026-11-03' })
  ], today);
  assert.equal(result.length, 2);
  assert.equal(result[0].dayOfMonth, 3);
  const balance = result.reduce((sum, row) => row.status === 'projected' ? Math.round((sum - row.amount) * 100) / 100 : sum, 500);
  assert.equal(balance, 174.50);
});

test('invalid payment data produces an explicit error', () => {
  assert.throws(() => buildUpcomingPayments([tx(1, { amount: 'invalid' })], today), /Invalid payment amount/);
  assert.throws(() => buildUpcomingPayments([tx(1, { date: 'invalid' })], today), /Invalid payment date/);
  assert.throws(() => buildUpcomingPayments([tx(1, { date: '2026-09-31' })], today), /Invalid payment date/);
});

test('rolling payments retain overdue bills and paid history, then recur across the 30-day boundary', () => {
  const now = new Date(2026, 9, 20);
  const through = new Date(2026, 10, 19);
  const result = buildUpcomingPayments([
    tx(1, { date: '2026-09-03', description: 'VERIZON', amount: 80 }),
    tx(2, { date: '2026-09-18', amount: 125 }),
    tx(3, { date: '2026-10-18', amount: 140, is_fixed: false }),
    tx(4, { date: '2026-09-20', description: 'NETFLIX', amount: 20 }),
    tx(5, { date: '2026-09-25', description: 'GEICO', amount: 100 })
  ], now, { through });
  assert.deepEqual(result.map(item => [item.date, item.status]), [
    ['2026-10-03', 'projected'], ['2026-10-18', 'processed'],
    ['2026-10-20', 'projected'], ['2026-10-25', 'projected'],
    ['2026-11-03', 'projected'], ['2026-11-18', 'projected']
  ]);
  assert.equal(result.filter(item => item.status !== 'processed').reduce((balance, item) => balance - item.amount, 1000), 595);
  assert.ok(result.every(item => item.date <= '2026-11-19'));
});

test('rolling horizon includes its last day but not day 31 and carries newly flagged current bills', () => {
  const result = buildUpcomingPayments([
    tx(1, { date: '2026-10-19' }),
    tx(2, { date: '2026-09-20', description: 'VERIZON' })
  ], new Date(2026, 9, 20), { through: new Date(2026, 10, 19) });
  assert.ok(result.some(item => item.date === '2026-11-19' && item.status === 'projected'));
  assert.ok(result.some(item => item.date === '2026-10-19' && item.status === 'processed'));
  assert.ok(!result.some(item => item.date === '2026-11-20'));
});

test('rolling dates cross December and clamp February while keeping distinct monthly occurrences', () => {
  const december = buildUpcomingPayments([tx(1, { date: '2026-11-03' })], new Date(2026, 11, 20), { through: new Date(2027, 0, 19) });
  assert.deepEqual(december.map(item => item.date), ['2026-12-03', '2027-01-03']);
  for (const [year, last] of [[2027, '28'], [2028, '29']]) {
    const result = buildUpcomingPayments([tx(1, { date: `${year}-01-31` })], new Date(year, 1, 20), { through: new Date(year, 2, 22) });
    assert.deepEqual(result.map(item => item.date), [`${year}-02-${last}`]);
  }
});
