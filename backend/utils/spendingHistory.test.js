import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpendingHistory } from './spendingHistory.js';

const today = new Date(2026, 0, 19);
const tx = (date, amount, extra = {}) => ({ date, amount, direction: 'DEBIT', category: 'Dining', transfer_kind: null, ...extra });
test('history covers exactly six completed months across year boundaries and counts each debit', () => {
  const data = buildSpendingHistory({ today, pro: true, budgets: [{ category: 'Dining', amount: 100 }],
    transactions: [tx('2025-07-01', 60), tx('2025-07-02', 50), tx('2025-09-01', 40), tx('2025-11-01', 80), tx('2025-12-01', 120), tx('2026-01-01', 999)] });
  assert.deepEqual(data.months, ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12']);
  const category = data.categories[0];
  assert.deepEqual(category.series.map(p => p.amount), [110, 0, 40, 0, 80, 120]);
  assert.equal(category.series[0].transactions, 2);
  assert.equal(category.stats.transactionCount, 5);
  assert.equal(category.average, 58.33);
  assert.equal(category.stats.monthsOverBudget, 2);
  assert.equal(category.stats.budgetComparison, 'current-budget');
  assert.equal(category.stats.changePct, 50);
  assert.deepEqual(category.stats.highest, { month: '2025-12', amount: 120 });
});
test('months before imported history are unknown and excluded from averages and budget comparisons', () => {
  const category = buildSpendingHistory({ today, pro: true, budgets: [{ category: 'Dining', amount: 50 }],
    transactions: [tx('2025-11-01', 100), tx('2025-12-01', 0)] }).categories[0];
  assert.deepEqual(category.series.map(p => p.amount), [null, null, null, null, 100, 0]);
  assert.equal(category.average, 50);
  assert.equal(category.observedMonths, 2);
  assert.equal(category.stats.monthsOverBudget, 1);
  assert.equal(category.stats.changePct, -100);
});
test('Free responses contain the basic history but no paid statistics or budget-only categories', () => {
  const data = buildSpendingHistory({ today, transactions: [tx('2025-12-01', 50)], budgets: [{ category: 'Secret budget', amount: 100 }] });
  assert.equal(data.pro, false);
  assert.equal(data.categories.length, 1);
  assert.equal(data.categories[0].stats, null);
  assert.doesNotMatch(JSON.stringify(data), /Secret budget|monthsOverBudget/);
});
test('transfers, credits, invalid dates and future transactions never inflate historical spending', () => {
  const category = buildSpendingHistory({ today, pro: true, transactions: [
    tx('2025-12-01', 10.10), tx('2025-12-02', 20.20), tx('2025-12-03', 500, { transfer_kind: 'internal' }),
    tx('2025-12-04', 500, { category: 'Transfer', transfer_kind: undefined }), tx('2025-12-05', 500, { direction: 'CREDIT' }),
    tx('bad date', 500), tx('2026-02-01', 999), tx('2025-12-01', 'invalid')
  ] }).categories[0];
  assert.equal(category.series.at(-1).amount, 30.3);
  assert.equal(category.stats.transactionCount, 2);
  assert.equal(category.stats.changePct, null);
});
test('new categories have zero observed months until completed history is imported', () => {
  const category = buildSpendingHistory({ today, pro: true, transactions: [tx('2026-01-01', 50)] }).categories[0];
  assert.equal(category.average, null);
  assert.equal(category.observedMonths, 0);
  assert.equal(category.stats.highest, null);
  assert.ok(category.series.every(p => p.amount === null));
});
