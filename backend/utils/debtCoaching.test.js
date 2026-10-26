import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePlan } from './moneyPlan.js';
import { normalizeDebt, simulatePayoff } from './payoff.js';

const now = new Date(2026, 9, 20);
const debts = [
  { id: 1, name: 'High-rate card', balance: 10000, apr: 24, min_payment: 300, included: true, payment_in_history: true },
  { id: 2, name: 'Small card', balance: 600, apr: 12, min_payment: 50, included: true, payment_in_history: true }
];
const row = (month, changes) => ({
  id: `${month}-${changes.description}`, date: `2026-${month}-02`, transfer_kind: null,
  direction: 'DEBIT', category: 'Rent', description: 'Rent', amount: 3500, is_fixed: true, ...changes
});
const history = () => ['07', '08', '09'].flatMap(month => [
  row(month, { direction: 'CREDIT', category: 'Salary', description: 'Pay', amount: 6000 }),
  row(month, {}),
  row(month, { category: 'Dining', description: 'Cafe', amount: 500, is_fixed: false })
]);
const inputs = overrides => ({ debts, history: history(), goals: [], recent: [], settings: { debt_budget: 550, goal_budget: 0 }, ...overrides });
const calculate = overrides => computePlan(inputs(overrides), { now, pro: true });

test('coaching reserves existing extra, goal contributions and a cushion once, without changing settings', () => {
  const source = inputs({
    goals: [{ id: 1, name: 'Reserve', target_amount: 10000, current_amount: 0, monthly_contribution: 300, included: true }],
    settings: { debt_budget: 550, goal_budget: 300 }
  });
  const copy = structuredClone(source);
  const p = computePlan(source, { now, pro: true }), c = p.debtPlan.coaching;
  assert.deepEqual(source, copy);
  assert.equal(c.status, 'room-to-accelerate');
  assert.deepEqual([c.surplus, c.currentExtra, c.goalContributions, c.buffer, c.remaining], [2000, 200, 300, 400, 1500]);
  assert.equal(c.supportedExtra, 1100);
  assert.equal(p.debtPlan.suggestion.budget, 1650);
  assert.equal(p.summary.debtExtra, 200, 'suggestion is not a saved payment');
  const expected = simulatePayoff(debts.map(normalizeDebt), { budget: 1650, strategy: 'avalanche', start: now });
  assert.equal(c.suggested.debtFreeDate, expected.debtFreeDate);
  assert.equal(c.suggested.totalInterest, expected.totalInterest);
});

test('a tight or deficit month constrains the average instead of encouraging more debt payments', () => {
  const rows = history();
  rows.find(row => row.date === '2026-09-02' && row.description === 'Pay').amount = 3900;
  const p = calculate({ history: rows }), c = p.debtPlan.coaching;
  assert.ok(c.surplus > 0);
  assert.equal(c.weakestSurplus, -100);
  assert.equal(c.status, 'stabilize');
  assert.equal(c.supportedExtra, 0);
  assert.equal(p.debtPlan.suggestion, null);
  assert.ok(c.scenarios.every(row => !row.supported));
});

test('higher current-month flexible commitments are reserved, while temporary reductions do not inflate headroom', () => {
  const goals = [{ id: 1, name: 'Reserve', target_amount: 10000, monthly_contribution: 300, included: true }];
  const p = calculate({ goals, settings: { debt_budget: 550, goal_budget: 300, flex: { '2026-10': { 'debt-extra': 600, 'goal:1': 500 } } } });
  assert.equal(p.debtPlan.coaching.currentExtra, 600);
  assert.equal(p.debtPlan.coaching.goalContributions, 500);
  assert.equal(p.debtPlan.coaching.supportedExtra, 500);
  const lower = calculate({ goals, settings: { debt_budget: 550, goal_budget: 300, flex: { '2026-10': { 'debt-extra': 0, 'goal:1': 0 } } } });
  assert.equal(lower.debtPlan.coaching.supportedExtra, 1100);
  assert.equal(lower.debtPlan.coaching.currentExtra, 200);
  assert.equal(lower.debtPlan.coaching.goalContributions, 300);
});

test('one or two observed months and months without income cannot support an increase', () => {
  for (const rows of [[], history().filter(row => row.date >= '2026-08-01'), history().filter(row => row.direction === 'CREDIT'), history().filter(row => !(row.date.startsWith('2026-09') && row.direction === 'CREDIT'))]) {
    const p = calculate({ history: rows }), c = p.debtPlan.coaching;
    assert.equal(c.supportedExtra, 0);
    assert.equal(p.debtPlan.suggestion, null);
    assert.ok(c.scenarios.every(row => !row.supported));
    if (!rows.length) assert.equal(c.status, 'needs-history');
  }
});

test('existing commitments that exceed a positive tight-month surplus trigger stabilization', () => {
  const rows = history();
  rows.find(row => row.date === '2026-09-02' && row.description === 'Pay').amount = 4100;
  const c = calculate({ history: rows }).debtPlan.coaching;
  assert.equal(c.weakestSurplus, 100);
  assert.equal(c.tightMonthRemaining, -100);
  assert.equal(c.status, 'stabilize');
  assert.equal(c.supportedExtra, 0);
});

test('allowances round down at the actual $25 boundary rather than exceeding available funding', () => {
  for (const [income, expected] of [[4624.99, 0], [4625, 25], [4649.99, 25], [4650, 50]]) {
    const rows = history().map(row => row.direction === 'CREDIT' ? { ...row, amount: income } : row);
    const c = calculate({ history: rows }).debtPlan.coaching;
    assert.equal(c.supportedExtra, expected);
    if (c.suggested) assert.ok(c.suggested.extra <= c.capacity);
  }
});

test('unrecorded minimums reduce every monthly surplus exactly once', () => {
  const p = calculate({ debts: debts.map(row => ({ ...row, payment_in_history: false })) });
  const c = p.debtPlan.coaching;
  assert.equal(c.unrecordedMinimums, 350);
  assert.equal(c.averageExpenses, 4350);
  assert.equal(c.surplus, 1650);
  assert.equal(c.weakestSurplus, 1650);
  assert.equal(c.buffer, 435);
  assert.equal(c.supportedExtra, 1000);
});

test('spending experiments exclude transfers, fixed bills, essentials and unobserved months', () => {
  const rows = [...history(), ...[
    { category: 'Shopping', description: 'Savings transfer', transfer_kind: 'savings', amount: 9000, is_fixed: false },
    { category: 'Subscriptions', description: 'Fixed service', is_fixed: 'true', amount: 1000 },
    { category: 'Medical shopping', description: 'Essential medical', is_fixed: false, amount: 5000 },
    { category: 'Groceries', description: 'Food', is_fixed: false, amount: 5000 },
    { category: 'Dining', description: 'Future', date: '2026-10-01', is_fixed: false, amount: 9999 },
    { category: 'Dining', description: 'Old', date: '2026-06-01', is_fixed: false, amount: 9999 }
  ].map(changes => row('09', changes))];
  const c = calculate({ history: rows }).debtPlan.coaching;
  assert.equal(c.opportunities.length, 1);
  const opportunity = c.opportunities[0];
  assert.deepEqual([opportunity.category, opportunity.average, opportunity.reduction, opportunity.monthlyTarget, opportunity.count], ['Dining', 500, 50, 450, 3]);
  assert.equal(opportunity.weeklyTarget, 103.85);
  const expected = simulatePayoff(debts.map(normalizeDebt), { budget: 600, strategy: 'avalanche', start: now });
  assert.equal(opportunity.impact.totalInterest, expected.totalInterest);
});

test('funding scenarios and strategy first wins use the actual selected budget, focus and exclusions', () => {
  const modified = debts.map(row => ({ ...row, focus: row.id === 2 }));
  modified.push({ id: 3, name: 'Outside program', balance: 100, apr: 99, min_payment: 10, included: false });
  const p = calculate({ debts: modified }), c = p.debtPlan.coaching;
  for (const scenario of c.scenarios) {
    const expected = simulatePayoff(modified.filter(row => row.included).map(normalizeDebt), {
      budget: p.debtPlan.budget + scenario.extra, strategy: p.debtPlan.strategy, start: now
    });
    assert.equal(scenario.totalInterest, expected.totalInterest);
    assert.equal(scenario.monthsSaved, p.debtPlan.plan.months - expected.months);
  }
  assert.equal(c.strategyTradeoffs.find(row => row.id === 'avalanche').firstWin.name, 'Small card');
  assert.ok(c.strategyTradeoffs.every(row => row.firstWin?.name !== 'Outside program'));
  assert.equal(c.milestones.principalReduction, Math.round((p.debtPlan.plan.series[0] - p.debtPlan.plan.series[3]) * 100) / 100);
  assert.equal(c.milestones.firstWin.rolledMinimum, 50);
});

test('below-minimum and goal-overcommitted plans never suggest another increase', () => {
  const short = calculate({ settings: { debt_budget: 100, goal_budget: 0 } }).debtPlan;
  assert.equal(short.coaching.status, 'minimum-gap');
  assert.equal(short.suggestion, null);
  assert.equal(short.coaching.milestones.principalReduction, null);
  const goal = { id: 1, name: 'Large goal', included: true, target_amount: 100000, monthly_contribution: 2500 };
  const p = calculate({ goals: [goal], settings: { debt_budget: 550, goal_budget: 2500 } });
  assert.equal(p.debtPlan.coaching.status, 'stabilize');
  assert.equal(p.debtPlan.suggestion, null);
});

test('no active debts produces no attack scenarios and no fictitious achievements', () => {
  const c = calculate({ debts: [] }).debtPlan.coaching;
  assert.deepEqual(c.scenarios, []);
  assert.deepEqual(c.opportunities, []);
  assert.equal(c.suggested, null);
  assert.equal(c.milestones.firstWin, null);
  assert.equal(c.milestones.principalReduction, null);
});

test('a debt already clearing this month does not get a pointless higher-budget suggestion', () => {
  const p = calculate({ debts: [{ ...debts[0], balance: 100, apr: 0, min_payment: 100 }], settings: { debt_budget: 100, goal_budget: 0 } });
  assert.equal(p.debtPlan.plan.months, 1);
  assert.equal(p.debtPlan.coaching.suggested, null);
  assert.equal(p.debtPlan.suggestion, null);
  assert.ok(p.debtPlan.coaching.scenarios.every(row => row.monthsSaved === 0 && row.interestSaved === 0));
});
