import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialFindings } from './financialFindings.js';
import { detectIncomeStreams } from './income.js';

const today = new Date(2026, 10, 6, 12);
const tx = (date, amount, category, extra = {}) => ({ date, amount, category, direction: 'DEBIT', description: category, transfer_kind: null, ...extra });

test('findings measure income, actual extras, annualized pace and spending drivers', () => {
  const transactions = [];
  for (let month = 1; month <= 10; month++) {
    const date = `2026-${String(month).padStart(2, '0')}-15`;
    transactions.push(tx(date, 6000, 'Salary', { direction: 'CREDIT', description: 'Employer Payroll' }),
      tx(date, 3200, 'Dining', { display_name: 'Favorite restaurant' }),
      tx(date, 1500, 'Shopping', { display_name: 'Favorite shop' }),
      tx(date, 1400, 'Housing'));
  }
  const result = buildFinancialFindings({ transactions, today });
  assert.equal(result.period.months, 10);
  assert.equal(result.monthlyIncome, 6000);
  assert.equal(result.annualIncome, 72000);
  assert.equal(result.incomeEstimate.basis, 'paycheck-cadence');
  assert.equal(result.monthlySpend, 6100);
  assert.equal(result.discretionary.total, 47000, 'actual extras exceed $45K');
  assert.equal(result.discretionary.annualized, 56400);
  assert.equal(result.discretionary.categories[0].name, 'Dining');
  assert.equal(result.discretionary.categories[0].amount, 32000);
  assert.equal(result.discretionary.merchants[0].name, 'Favorite restaurant');
  assert.equal(result.categories[0].name, 'Dining');
  assert.equal(result.merchants[0].name, 'Favorite restaurant');
  assert.equal(result.monthlySpend - result.monthlyIncome, 100);
  assert.equal(Object.hasOwn(result, 'signals'), false);
  assert.match(result.methodology, /not gross salary/);
});

test('pending, transfers, invalid/future dates and non-pay credits do not inflate findings', () => {
  const result = buildFinancialFindings({ today, transactions: [
    tx('2026-09-12', 100, 'Dining'),
    tx('2026-09-12', 5000, 'Salary', { direction: 'CREDIT', income_role: 'other' }),
    tx('2026-09-12', 7000, 'Salary', { direction: 'CREDIT', transfer_kind: 'internal' }),
    tx('2026-09-12', 3000, 'Shopping', { is_pending: true }),
    tx('2026-09-13', 2000, 'Other', { direction: 'CREDIT', income_role: 'income' }),
    tx('2026-09-13', 9000, 'Refund', { direction: 'CREDIT' }),
    tx('2026-11-10', 9999, 'Shopping'),
    tx('2026-02-31', 9999, 'Shopping'),
    tx('bad-date', 9999, 'Shopping'),
    tx('2025-01-01', 9999, 'Shopping')
  ] });
  assert.equal(result.period.months, 1);
  assert.equal(result.totalSpend, 100);
  assert.equal(result.annualIncome, 24000);
  assert.equal(result.discretionary.total, 100);
  assert.equal(result.discretionary.annualized, 1200);
  assert.equal(buildFinancialFindings({ today }).annualIncome, null);
});

test('biweekly pay is annualized from 26 paychecks, not diluted by months missing payroll', () => {
  const transactions = [];
  for (let month = 0; month < 10; month++) {
    transactions.push(tx(new Date(2026, month, 5), 1000, 'Shopping'));
  }
  for (let i = 0; i < 10; i++) {
    const date = new Date(2026, 6, 1 + i * 14);
    transactions.push(tx(date, 6600, 'Salary', {
      direction: 'CREDIT', description: i === 9 ? 'WELLS FARGO BANK PAYROLL' : 'Wells Fargo Pay'
    }));
  }
  const result = buildFinancialFindings({ transactions, today });
  assert.equal(result.incomeEstimate.streams.length, 1, 'payroll description aliases stay one source');
  assert.equal(result.incomeEstimate.streams[0].cadence, 'biweekly');
  assert.equal(result.incomeEstimate.streams[0].paychecksPerYear, 26);
  assert.equal(result.annualIncome, 171600);
  assert.equal(result.monthlyIncome, 14300);
  assert.equal(result.incomeEstimate.streams[0].amount, 6600);
  assert.equal(result.period.months, 10);
  assert.notEqual(result.monthlyIncome, 6600 * 9 / 10, 'spending months must not dilute current pay');
});

test('weekly, twice-monthly and monthly schedules use their own annual paycheck counts', () => {
  for (const [cadence, dates, count] of [
    ['weekly', ['2026-10-21', '2026-10-28', '2026-11-04'], 52],
    ['semimonthly', ['2026-09-15', '2026-10-01', '2026-10-15', '2026-11-01'], 24],
    ['monthly', ['2026-09-01', '2026-10-01', '2026-11-01'], 12]
  ]) {
    const result = buildFinancialFindings({ today, transactions: dates.map(date =>
      tx(date, 1000, 'Salary', { description: 'Employer Payroll', direction: 'CREDIT' })) });
    assert.equal(result.incomeEstimate.streams[0].cadence, cadence);
    assert.equal(result.annualIncome, 1000 * count);
    assert.equal(result.monthlyIncome, Math.round(1000 * count / 12 * 100) / 100);
  }
});

test('active-source estimates use recent typical pay, honor overrides, and ignore stale jobs', () => {
  const transactions = [
    tx('2026-08-12', 3000, 'Salary', { direction: 'CREDIT', description: 'Old job Payroll' }),
    tx('2026-08-26', 3000, 'Salary', { direction: 'CREDIT', description: 'Old job Payroll' }),
    ...['2026-10-07', '2026-10-21', '2026-11-04'].map((date, i) =>
      tx(date, [6669.61, 6669.61, 6594.42][i], 'Salary', { direction: 'CREDIT', description: 'Wells Fargo Pay' })),
    ...['2026-10-21', '2026-11-04'].map(date =>
      tx(date, 9000, 'Salary', { direction: 'CREDIT', description: 'Excluded Pay', income_role: 'other' }))
  ];
  const result = buildFinancialFindings({ transactions, today });
  assert.equal(result.incomeEstimate.streams.length, 1);
  assert.equal(result.incomeEstimate.streams[0].amount, 6669.61);
  assert.equal(result.annualIncome, 173409.86);
  assert.equal(result.monthlyIncome, 14450.82);
  assert.equal(detectIncomeStreams(transactions, today).length, 1);
});

test('unscheduled historical income excludes months with spending only and labels the fallback', () => {
  const result = buildFinancialFindings({ today, transactions: [
    tx('2026-01-03', 100, 'Dining'),
    tx('2026-09-12', 4000, 'Salary', { direction: 'CREDIT' }),
    tx('2026-10-24', 6000, 'Salary', { direction: 'CREDIT' })
  ] });
  assert.equal(result.incomeEstimate.basis, 'recorded-income-months');
  assert.equal(result.incomeEstimate.incomeMonths, 2);
  assert.equal(result.observedMonthlyIncome, 5000);
  assert.equal(result.monthlyIncome, 5000);
  assert.equal(result.annualIncome, 60000);
});
