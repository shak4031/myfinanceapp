import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialFindings } from './financialFindings.js';

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
  assert.equal(result.monthlySpend, 6100);
  assert.equal(result.discretionary.total, 47000, 'actual extras exceed $45K');
  assert.equal(result.discretionary.annualized, 56400);
  assert.equal(result.discretionary.categories[0].name, 'Dining');
  assert.equal(result.discretionary.categories[0].amount, 32000);
  assert.equal(result.discretionary.merchants[0].name, 'Favorite restaurant');
  assert.equal(result.categories[0].name, 'Dining');
  assert.equal(result.merchants[0].name, 'Favorite restaurant');
  assert.equal(result.signals.find(row => row.id === 'deficit').detail.includes('$100 monthly gap'), true);
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

test('guidance covers sync, imports, Other, unbudgeted categories, duplicate review and notes', () => {
  const transactions = [
    tx('2026-10-01', 6000, 'Salary', { direction: 'CREDIT' }),
    tx('2026-10-02', 5000, 'Housing'),
    tx('2026-11-01', 100, null),
    tx('2026-11-02', 2100, 'Shopping', { id: 42, display_name: 'Large shop' }),
    tx('2026-11-03', 5000, 'Dining', { note: 'Already explained' })
  ];
  const result = buildFinancialFindings({ today, transactions, duplicateCount: 3,
    budgets: [{ category: 'Dining', monthly_amount: 6000 }],
    connections: [{ id: 1, institution_name: 'Test bank', status: 'active', last_sync_at: '2026-11-03T00:00:00Z' },
      { id: 2, institution_name: 'New bank', status: 'active', last_sync_at: null }] });
  const ids = result.signals.map(row => row.id);
  for (const id of ['duplicates', 'sync-1', 'sync-2', 'uncategorized', 'budget-Shopping', 'large']) assert.ok(ids.includes(id), id);
  assert.equal(ids.includes('budget-Dining'), false);
  assert.equal(ids.includes('import'), false);
  assert.match(result.signals.find(row => row.id === 'uncategorized').title, /^1 transactions/);
  assert.equal(result.signals.find(row => row.id === 'large').action, 'note:42');
  assert.equal(buildFinancialFindings({ today, transactions }).signals.some(row => row.id === 'import'), true);
});
