import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectIncomeStreams, projectIncome, isIncomeTransaction, incomeSources, threePaycheckMonths } from './income.js';
import { buildDebtPlan, simulatePayoff, normalizeDebt } from './payoff.js';
import { buildGoalPlan } from './goalPlan.js';
import { buildPlanPayments, computePlan } from './moneyPlan.js';

const DAY = 864e5;
const paychecks = (first, step, until, extra = {}) => {
  const rows = [];
  for (let time = Date.parse(`${first}T00:00:00Z`); time <= Date.parse(`${until}T00:00:00Z`); time += step * DAY) {
    rows.push({ id: rows.length + 1, date: new Date(time).toISOString().slice(0, 10), description: 'ACME CORP PAYROLL DIR DEP 0042', amount: 2400, direction: 'CREDIT', category: 'Salary', ...extra });
  }
  return rows;
};
const debts = [
  { id: 1, name: 'Visa', balance: 4000, apr: 24.99, min_payment: 100, due_date: '25', debt_type: 'credit_card', credit_limit: 8000, payment_in_history: true },
  { id: 2, name: 'Car', balance: 12000, apr: 6, min_payment: 400, due_date: '12', debt_type: 'auto_loan', payment_in_history: true },
  { id: 3, name: 'Store card', balance: 600, apr: 19, min_payment: 35, due_date: '5', debt_type: 'credit_card', credit_limit: 1000, payment_in_history: false }
];

test('income detection finds biweekly Thursday pay and projects only the paychecks still to come', () => {
  const today = new Date('2026-10-15T12:00:00Z');
  const rows = paychecks('2026-04-02', 14, '2026-10-15');
  const [stream] = detectIncomeStreams(rows, today);
  assert.deepEqual([stream.cadence, stream.weekday, stream.label, stream.amount], ['biweekly', 4, 'Every other Thursday', 2400]);
  const { items } = projectIncome(rows, today);
  assert.deepEqual(items.map(item => [item.dayOfMonth, item.status, item.isIncome]), [[1, 'processed', true], [15, 'processed', true], [29, 'projected', true]]);
  const bonus = threePaycheckMonths([stream], today);
  assert.deepEqual(bonus.map(month => month.month), ['2026-10', '2027-04', '2027-09']);
  assert.deepEqual(bonus[0].dates, ['2026-10-01', '2026-10-15', '2026-10-29']);
  assert.equal(bonus[0].extra, 2400);
  assert.deepEqual(threePaycheckMonths([{ ...stream, cadence: 'semimonthly' }], today), []);
});

test('income detection recognizes weekly, semimonthly and monthly pay and ignores transfers and refunds', () => {
  const today = new Date('2026-10-10T12:00:00Z');
  assert.equal(detectIncomeStreams(paychecks('2026-06-05', 7, '2026-10-09'), today)[0].cadence, 'weekly');
  const monthly = ['05', '06', '07', '08', '09', '10'].map((month, i) => ({ id: i, date: `2026-${month}-01`, description: 'STATE OF NJ PAYROLL', amount: 5100, direction: 'CREDIT', category: 'Salary' }));
  assert.equal(detectIncomeStreams(monthly, today)[0].cadence, 'monthly');
  assert.equal(projectIncome(monthly, today).items.find(item => item.status === 'projected'), undefined, 'next monthly check is in November');
  const semi = ['05', '06', '07', '08', '09'].flatMap((month, i) => [1, 15].map(day => ({ id: `${i}-${day}`, date: `2026-${month}-${String(day).padStart(2, '0')}`, description: 'GLOBEX PAYROLL', amount: 2000, direction: 'CREDIT', category: 'Salary' })));
  assert.equal(detectIncomeStreams(semi, today)[0].cadence, 'semimonthly');
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'ZELLE FROM JOHN', category: 'Other' }), false);
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'ZELLE FROM CLIENT', category: 'Salary' }), true, 'an explicit Salary category wins');
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'AMAZON REFUND', category: 'Shopping' }), false);
  assert.equal(isIncomeTransaction({ direction: 'DEBIT', description: 'ACME PAYROLL', category: 'Salary' }), false);
  const stale = paychecks('2026-01-01', 14, '2026-06-01');
  assert.equal(detectIncomeStreams(stale, today).length, 0, 'a job that stopped paying is not projected');
});

test('rolling income uses actual dates and includes future paychecks through day 30 without repeating received pay', () => {
  const now = new Date(2026, 9, 20);
  const { items } = projectIncome(paychecks('2026-04-02', 14, '2026-10-15'), now, { through: new Date(2026, 10, 19) });
  assert.deepEqual(items.map(item => [item.date, item.status]), [
    ['2026-10-01', 'processed'], ['2026-10-15', 'processed'],
    ['2026-10-29', 'projected'], ['2026-11-12', 'projected']
  ]);
  assert.equal(new Set(items.map(item => item.key || item.id)).size, items.length);
  const endDay = projectIncome(paychecks('2026-04-02', 14, '2026-10-15'), new Date(2026, 9, 13), { through: new Date(2026, 10, 12) });
  assert.ok(endDay.items.some(item => item.date === '2026-11-12'));
});

test('a user override beats income detection, and the review groups deposits by sender with a reason', () => {
  const today = new Date('2026-10-15T12:00:00Z');
  const pay = paychecks('2026-04-02', 14, '2026-10-15');
  // Someone reimbursing the user every two weeks, filed under Income: detection would call it pay.
  const friend = paychecks('2026-04-03', 14, '2026-10-15').map(row => ({ ...row, id: `f${row.id}`, description: 'MOBILE DEPOSIT JANE DOE', amount: 150, category: 'Income' }));
  const misc = ['2026-08-01', '2026-09-01', '2026-10-01'].map((date, i) => ({ id: `m${i}`, date, description: 'ETSY PAYOUT', amount: 80, direction: 'CREDIT', category: 'Other' }));
  assert.equal(detectIncomeStreams([...pay, ...friend], today).length, 2);
  const corrected = friend.map(row => ({ ...row, income_role: 'other' }));
  assert.deepEqual(detectIncomeStreams([...pay, ...corrected], today).map(stream => stream.key), ['ACME CORP PAYROLL']);
  assert.equal(projectIncome([...pay, ...corrected], today).items.every(item => item.description !== 'Mobile Jane Doe'), true);
  assert.equal(isIncomeTransaction({ direction: 'CREDIT', description: 'ETSY PAYOUT', income_role: 'income' }), true);
  assert.equal(isIncomeTransaction({ direction: 'DEBIT', description: 'ETSY', income_role: 'income' }), false, 'money out is never income');

  const sources = incomeSources([...pay, ...corrected, ...misc], today);
  assert.deepEqual(sources.map(source => [source.name, source.status, source.by, source.regular]), [
    ['Acme Corp Payroll', 'income', 'category', true],
    ['Mobile Jane Doe', 'other', 'you', false],
    ['Etsy Payout', 'other', 'auto', false]
  ]);
  assert.equal(sources[0].cadenceLabel, 'Every other Thursday');
  assert.equal(sources[1].reason, 'You marked this as not income');
  assert.equal(sources[0].transactions[0].date, '2026-10-15', 'newest deposit first');
  assert.equal(incomeSources([{ id: 1, date: '2026-10-01', description: 'AMAZON REFUND', amount: 9, direction: 'CREDIT' }], today).length, 0, 'one-off deposits are not listed');
});

test('payoff simulation charges interest, rolls freed minimums forward and never mutates input', () => {
  const input = debts.map(normalizeDebt);
  const copy = structuredClone(input);
  const minimumsOnly = simulatePayoff(input, { minimumsOnly: true, start: new Date('2026-10-01') });
  const avalanche = simulatePayoff(input, { budget: 1035, strategy: 'avalanche', start: new Date('2026-10-01') });
  const snowball = simulatePayoff(input, { budget: 1035, strategy: 'snowball', start: new Date('2026-10-01') });
  assert.deepEqual(input, copy);
  assert.ok(avalanche.months < minimumsOnly.months && avalanche.totalInterest < minimumsOnly.totalInterest);
  assert.ok(avalanche.totalInterest <= snowball.totalInterest);
  assert.equal(avalanche.order[0], 1, 'highest APR first');
  assert.equal(snowball.order[0], 3, 'smallest balance first');
  assert.equal(simulatePayoff(input, { budget: 100, start: new Date('2026-10-01') }).feasible, false);
});

test('debt plan honours focus and exclusions and locks Pro strategies for free accounts', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const focused = buildDebtPlan({ debts: debts.map(debt => ({ ...debt, focus: debt.id === 2 })), settings: { debt_budget: 1035 }, surplus: 900, now });
  assert.equal(focused.debts[0].id, 2);
  assert.ok(focused.guidance.some(item => /focus on Car costs/.test(item.title)));
  const locked = buildDebtPlan({ debts, settings: { debt_strategy: 'interest', debt_budget: 1035 }, now, pro: false });
  assert.deepEqual([locked.strategy, locked.strategyLocked], ['avalanche', true]);
  assert.ok(locked.comparison.find(item => item.id === 'interest').locked && locked.comparison.find(item => item.id === 'interest').totalInterest === undefined);
  const pro = buildDebtPlan({ debts, settings: { debt_strategy: 'interest', debt_budget: 1035 }, now, pro: true, whatIf: { extra: 200, lumpSum: 1000 } });
  assert.equal(pro.strategy, 'interest');
  assert.ok(pro.scenario.monthsSaved > 0 && pro.scenario.interestSaved > 0);
  const excluded = buildDebtPlan({ debts: debts.map(debt => ({ ...debt, included: debt.id !== 2 })), settings: {}, now });
  assert.equal(excluded.totals.included, 2);
  assert.equal(excluded.minimums, 135);
  assert.equal(excluded.debts.find(debt => debt.id === 2).rank, null);
  const short = buildDebtPlan({ debts, settings: { debt_budget: 200 }, now });
  assert.equal(short.guidance[0].severity, 'danger');
});

test('goal plan funds dated goals on schedule, flags goals that fall behind and gives leftovers to undated goals', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const goals = [
    { id: 1, name: 'Emergency fund', target_amount: 10000, current_amount: 2000, priority: 1, target_date: '2027-06-01' },
    { id: 2, name: 'Vacation', target_amount: 3000, current_amount: 0, priority: 2 },
    { id: 3, name: 'Car', target_amount: 5000, current_amount: 500, priority: 3, target_date: '2027-03-01' },
    { id: 4, name: 'Paused', target_amount: 1000, current_amount: 0, priority: 4, included: false }
  ];
  const tight = buildGoalPlan({ goals, available: 1100, now });
  const byId = Object.fromEntries(tight.goals.map(goal => [goal.id, goal]));
  assert.deepEqual([byId[1].status, byId[1].allocated], ['on-track', 1000]);
  assert.equal(byId[3].status, 'behind');
  assert.equal(byId[4].status, 'paused');
  assert.ok(tight.guidance.some(item => /behind schedule/.test(item.title)));
  const roomy = buildGoalPlan({ goals, available: 3000, now });
  assert.ok(roomy.goals.find(goal => goal.id === 2).allocated > 0, 'leftover money reaches the undated goal');
  const manual = buildGoalPlan({ goals: goals.map(goal => goal.id === 3 ? { ...goal, monthly_contribution: 50 } : goal), available: 3000, now });
  assert.equal(manual.goals.find(goal => goal.id === 3).allocated, 50);
  const locked = buildGoalPlan({ goals, settings: { goal_strategy: 'balanced' }, available: 1000, now });
  assert.deepEqual([locked.strategy, locked.strategyLocked], ['priority', true]);
  assert.ok(buildGoalPlan({ goals: [goals[1]], available: 500, now }).guidance.some(item => /emergency fund/i.test(item.title)));
});

test('goal plan does not treat an expired date as due this month but preserves an explicit monthly commitment', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const overdue = { id: 21, name: 'Long-term goal', target_amount: 15500, current_amount: 0, target_date: '2026-10-01' };
  const automatic = buildGoalPlan({ goals: [overdue], available: 500, now });
  assert.equal(automatic.requiredTotal, 0);
  assert.equal(automatic.goals[0].status, 'overdue');
  assert.equal(automatic.goals[0].required, null);
  assert.equal(automatic.goals[0].remaining, 15500);

  const manual = buildGoalPlan({ goals: [{ ...overdue, monthly_contribution: 100 }], available: 500, now });
  assert.equal(manual.goals[0].status, 'overdue');
  assert.equal(manual.goals[0].required, 100);
  assert.equal(manual.requiredTotal, 100);
});

test('the monthly plan feeds flexible debt and goal entries into the payment calendar with per-month overrides', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const history = ['07', '08', '09'].flatMap(month => [
    { id: `i${month}`, date: `2026-${month}-01`, description: 'PAYROLL', category: 'Salary', direction: 'CREDIT', amount: 6000 },
    { id: `e${month}`, date: `2026-${month}-03`, description: 'RENT', category: 'Mortgage', direction: 'DEBIT', amount: 3500 }
  ]);
  const inputs = {
    debts, history, recent: paychecks('2026-04-02', 14, '2026-10-15'),
    goals: [{ id: 9, name: 'Emergency fund', target_amount: 5000, current_amount: 1000, priority: 1, target_date: '2027-08-01' }],
    settings: { debt_strategy: 'avalanche', debt_budget: 1235, goal_strategy: 'priority', goal_budget: null, flex: { '2026-10': { 'goal:9': 120 } } }
  };
  const plan = computePlan(inputs, { now });
  assert.equal(plan.debtPlan.extra, 700);
  assert.equal(plan.summary.available, plan.summary.monthlySurplus - 700);
  const items = buildPlanPayments(plan, now);
  const extra = items.find(item => item.key === 'debt-extra');
  assert.deepEqual([extra.flexible, extra.amount, extra.dayOfMonth, extra.status], [true, 700, 25, 'projected']);
  assert.match(extra.description, /Visa/);
  const store = items.find(item => item.key === 'debt-min:3');
  assert.deepEqual([store.flexible, store.amount, store.status], [false, 35, 'processed'], 'minimums missing from history are added; the 5th is already past');
  const goal = items.find(item => item.key === 'goal:9');
  assert.deepEqual([goal.amount, goal.adjusted, goal.dayOfMonth], [120, true, 1], 'override wins; contributions default to the first payday');
  assert.equal(plan.income.streams[0].label, 'Every other Thursday');
});
