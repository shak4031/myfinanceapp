import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketOf, buildSpendingBuckets, debtMatchers } from './spendingBuckets.js';

const NOW = new Date(2026, 6, 10);
const debit = (fields) => ({ direction: 'DEBIT', amount: 100, description: 'X', ...fields });

test('bucketOf sorts spending into fixed, discretionary and debt payments', () => {
  assert.deepEqual(bucketOf(debit({ category: 'Mortgage', is_fixed: true })), { bucket: 'debt', type: 'mortgage' }, 'a mortgage is debt even when fixed');
  assert.deepEqual(bucketOf(debit({ category: 'Car Loans', is_fixed: true })), { bucket: 'debt', type: 'auto_loan' });
  assert.deepEqual(bucketOf(debit({ category: 'Credit Cards' })), { bucket: 'debt', type: 'credit_card' });
  assert.deepEqual(bucketOf(debit({ category: 'Student Loans' })), { bucket: 'debt', type: 'student_loan' });
  assert.deepEqual(bucketOf(debit({ category: 'Personal Loan' })), { bucket: 'debt', type: 'personal_loan' });
  assert.deepEqual(bucketOf(debit({ category: 'Mortgage', description: 'MONTHLY RENT PORTAL', is_fixed: true })), { bucket: 'fixed' }, 'rent is a fixed bill');
  assert.deepEqual(bucketOf(debit({ category: 'Utilities', is_fixed: true })), { bucket: 'fixed' });
  assert.deepEqual(bucketOf(debit({ category: 'Dining' })), { bucket: 'discretionary' });
  assert.equal(bucketOf({ ...debit({ category: 'Income' }), direction: 'CREDIT' }), null, 'income is not spending');
  assert.equal(bucketOf(debit({ category: 'Credit Cards', transfer_kind: 'internal' })), null, 'a card payment paired with an imported card is a transfer');
  const interest = bucketOf(debit({ category: 'Fees', description: 'INTEREST CHARGE ON PURCHASES' }));
  assert.equal(interest.bucket, 'debt');
  assert.equal(interest.interest, true);
});

test('payment-match debts claim their payments for the debt bucket', () => {
  const matchers = debtMatchers([{ name: 'Truck', debt_type: 'auto_loan', payment_match: 'ally pmt' }]);
  assert.deepEqual(bucketOf(debit({ description: 'ALLY PMT 0423', category: 'Bills', is_fixed: true }), matchers), { bucket: 'debt', type: 'auto_loan' });
  assert.deepEqual(bucketOf(debit({ description: 'NETFLIX', category: 'Bills', is_fixed: true }), matchers), { bucket: 'fixed' });
});

test('a typical month averages the last three complete months and adds unrecorded minimums', () => {
  const transactions = [];
  for (const month of ['2026-04', '2026-05', '2026-06']) {
    transactions.push(
      { date: `${month}-01`, description: 'PAYROLL', amount: 6000, direction: 'CREDIT', category: 'Salary' },
      debit({ date: `${month}-02`, category: 'Mortgage', amount: 1800, is_fixed: true }),
      debit({ date: `${month}-03`, category: 'Utilities', amount: 300, is_fixed: true }),
      debit({ date: `${month}-04`, category: 'Groceries', amount: 600 }),
      debit({ date: `${month}-05`, category: 'Dining', amount: 300 }),
      debit({ date: `${month}-06`, category: 'Savings', amount: 500, transfer_kind: 'savings' })
    );
  }
  transactions.push(debit({ date: '2026-07-03', category: 'Dining', amount: 75 }), debit({ date: '2025-01-01', category: 'Dining', amount: 9999 }));
  const debts = [{ name: 'Visa', debt_type: 'credit_card', balance: 2000, min_payment: 60, payment_in_history: false }];
  const result = buildSpendingBuckets({ transactions, debts, now: NOW });
  assert.equal(result.monthsUsed, 3);
  const { typical } = result;
  assert.deepEqual([typical.income, typical.fixed, typical.discretionary, typical.debt, typical.left], [6000, 300, 900, 1860, 2940]);
  assert.equal(typical.unrecordedDebt, 60);
  assert.deepEqual(typical.shares, { fixed: 5, discretionary: 15, debt: 31, left: 49 });
  assert.deepEqual(typical.items.debt.map(item => [item.label, item.amount]), [['Mortgage', 1800], ['Credit cards', 60]]);
  assert.deepEqual(typical.items.discretionary.map(item => item.label), ['Groceries', 'Dining']);
  assert.equal(result.months.length, 7);
  assert.equal(result.months.at(-1).current, true);
  assert.equal(result.months.at(-1).discretionary, 75);
  assert.equal(result.months[0].recorded, false);
  assert.equal(result.current.discretionary, 75);
  assert.equal(result.current.daysInMonth, 31);
  assert.equal(result.current.day, 10);
});

test('with no history there is no typical month', () => {
  const result = buildSpendingBuckets({ transactions: [], now: NOW });
  assert.equal(result.typical, null);
  assert.equal(result.monthsUsed, 0);
  assert.equal(result.months.every(row => row.recorded === false), true);
});
