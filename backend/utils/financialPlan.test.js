import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFinancialPlan } from './financialPlan.js';

const today = new Date(2026, 9, 14);
const history = [
  { id: 1, date: '2026-09-01', amount: 10000, direction: 'CREDIT', category: 'Salary' },
  { id: 2, date: '2026-09-02', amount: 8000, direction: 'DEBIT', category: 'Mortgage' },
  { id: 3, date: '2026-09-03', amount: 1000, direction: 'DEBIT', category: 'Dining' },
  { id: 4, date: '2026-10-01', amount: 999999, direction: 'CREDIT' },
  { id: 5, date: '2026-09-04', amount: 3000, direction: 'CREDIT', category: 'Transfer' }
];
test('goals share one real surplus instead of each spending the same surplus', () => {
  const plan = buildFinancialPlan(history, [
    { id: 1, name: 'Car', target_amount: 6000, current_amount: 0, target_date: '2027-04-14', priority: 1 },
    { id: 2, name: 'College', target_amount: 6000, current_amount: 0, target_date: '2027-04-14', priority: 2 }
  ], today);
  assert.equal(plan.avgMonthlyIncome, 10000);
  assert.equal(plan.avgMonthlyExpenses, 9000);
  assert.equal(plan.monthlySurplus, 1000);
  assert.equal(plan.requiredMonthlySavings, 2000);
  assert.equal(plan.availableAfterGoals, -1000);
  assert.equal(plan.goals[0].status, 'on-track');
  assert.equal(plan.goals[1].status, 'shortfall');
  assert.equal(plan.goals[1].allocatedMonthly, 0);
  assert.ok(plan.advice.some(row => row.title.includes('same money')));
});
test('missing history, missing deadlines, overdue and funded goals remain explicit', () => {
  const plan = buildFinancialPlan([], [
    { id: 1, name: 'Car', target_amount: 1000, current_amount: 0, target_date: '2027-04-14', priority: 1 },
    { id: 2, name: 'Reserve', target_amount: 1000, current_amount: 0, priority: 2 },
    { id: 3, name: 'Late', target_amount: 1000, current_amount: 0, target_date: '2026-09-01', priority: 3 },
    { id: 4, name: 'Done', target_amount: 1000, current_amount: 1000, priority: 4 }
  ], today);
  assert.equal(plan.monthlySurplus, null);
  assert.equal(plan.availableAfterGoals, null);
  assert.equal(plan.goals[0].status, 'insufficient-data');
  assert.equal(plan.goals[1].requiredMonthly, null);
  assert.equal(plan.goals[2].status, 'overdue');
  assert.equal(plan.goals[2].requiredMonthly, null);
  assert.equal(plan.goals[3].status, 'funded');
});

test('overdue goal balances are not treated as an immediate monthly bill and excluded goals do not add requirements', () => {
  const plan = buildFinancialPlan(history, [
    { id: 1, name: 'Late', target_amount: 15500, current_amount: 0, target_date: '2026-09-01', priority: 1 },
    { id: 2, name: 'Paused', target_amount: 9000, current_amount: 1000, target_date: '2027-04-14', priority: 2, included: false, monthly_contribution: 200 }
  ], today);
  assert.equal(plan.goals[0].remaining, 15500);
  assert.equal(plan.goals[0].requiredMonthly, null);
  assert.equal(plan.goals[1].requiredMonthly, null);
  assert.equal(plan.requiredMonthlySavings, 0);
  assert.equal(plan.total_remaining, 15500);
  assert.equal(plan.availableAfterGoals, 1000);
});

test('overdue goal with an explicit manual contribution keeps that monthly commitment', () => {
  const plan = buildFinancialPlan(history, [
    { id: 1, name: 'Late but ongoing', target_amount: 2000, current_amount: 500, target_date: '2026-09-01', monthly_contribution: 75 }
  ], today);
  assert.equal(plan.goals[0].status, 'overdue');
  assert.equal(plan.goals[0].requiredMonthly, 75);
  assert.equal(plan.requiredMonthlySavings, 75);
  assert.equal(plan.total_remaining, 1500);
});

test('coaching identifies income increases consumed by spending without claiming a salary increase', () => {
  const plan = buildFinancialPlan([
    { id: 1, date: '2026-08-01', amount: 10000, direction: 'CREDIT' },
    { id: 2, date: '2026-08-02', amount: 9000, direction: 'DEBIT', category: 'Shopping' },
    { id: 3, date: '2026-09-01', amount: 15000, direction: 'CREDIT' },
    { id: 4, date: '2026-09-02', amount: 14000, direction: 'DEBIT', category: 'Shopping' }
  ], [], today);
  assert.equal(plan.savingsRate, 8);
  assert.equal(plan.monthlyHistory.length, 2);
  assert.ok(plan.advice.some(row => row.title.includes('absorbed')));
  assert.ok(plan.advice.some(row => row.detail.includes('does not prove a salary raise')));
});

test('new loan minimums reserve cash without double-counting payments already imported', () => {
  const plan = buildFinancialPlan(history, [], today, [
    { min_payment: 400, payment_in_history: false },
    { min_payment: 1000, payment_in_history: true }
  ]);
  assert.equal(plan.additionalDebtPayments, 400);
  assert.equal(plan.recordedAvgMonthlyExpenses, 9000);
  assert.equal(plan.avgMonthlyExpenses, 9400);
  assert.equal(plan.monthlySurplus, 600);
});
