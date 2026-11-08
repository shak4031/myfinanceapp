import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEALTH_STEP_IDS, applyHealthChange, buildHealthPlan, healthGrade, healthScore, normalizeHealthState } from './healthPlan.js';

const NOW = new Date(2026, 6, 10);
const typical = (shares, income = 5000) => ({
  income, fixed: income * shares.fixed / 100, discretionary: income * shares.discretionary / 100, debt: income * shares.debt / 100,
  left: income * shares.left / 100, unrecordedDebt: 0, interest: 0, shares,
  items: { fixed: [{ label: 'Utilities', amount: 300 }], discretionary: [{ label: 'Dining', amount: 900 }, { label: 'Shopping', amount: 600 }], debt: [{ label: 'Mortgage', amount: 1200 }] }
});
const months = (rows) => rows.map((row, i) => ({ month: `2026-0${i + 1}`, current: i === rows.length - 1, recorded: true, income: 5000, fixed: 0, discretionary: 0, debt: 0, interest: 0, cardInterest: 0, ...row }));
const buckets = (shares, extra = {}) => ({ monthsUsed: 3, typical: typical(shares), months: months([{}, {}, {}, {}, {}, {}, {}]), ...extra });

test('the score gives 25 points per measure and fades past each target', () => {
  assert.equal(healthScore({ fixed: 30, discretionary: 30, debt: 25, left: 15 }), 100);
  assert.equal(healthScore({ fixed: 40, discretionary: 30, debt: 25, left: 15 }), 88, 'half a measure lost 10 points past target');
  assert.equal(healthScore({ fixed: 60, discretionary: 60, debt: 60, left: -20 }), 0);
  assert.equal(healthScore(null), null);
  assert.equal(healthGrade(90).label, 'Strong');
  assert.equal(healthGrade(70).label, 'Steady');
  assert.equal(healthGrade(50).label, 'Stretched');
  assert.equal(healthGrade(10).label, 'Under pressure');
});

test('the plan compares each bucket with its target and suggests the biggest fixes first', () => {
  const plan = buildHealthPlan({ buckets: buckets({ fixed: 28, discretionary: 42, debt: 27, left: 3 }), now: NOW });
  assert.deepEqual(plan.buckets.map(row => [row.key, row.status]), [['fixed', 'good'], ['discretionary', 'over'], ['debt', 'close'], ['save', 'over']]);
  assert.equal(plan.buckets.find(row => row.key === 'discretionary').change, 600);
  assert.equal(plan.buckets.find(row => row.key === 'save').change, 600);
  assert.deepEqual(plan.focus.map(item => item.key), ['discretionary', 'save', 'debt']);
  assert.match(plan.focus[0].text, /Dining and Shopping/);
  assert.equal(plan.steps.length, 12);
  assert.deepEqual(plan.steps.map(step => step.id), HEALTH_STEP_IDS);
  assert.deepEqual([...new Set(plan.steps.map(step => step.monthTitle))], ['Know your numbers', 'Build the foundation', 'Lock it in']);
  assert.equal(plan.steps.find(step => step.id === 'review').status, 'done');
  assert.equal(plan.startedAt, null);
  assert.equal(plan.week, null);
});

test('steps are checked against the household data', () => {
  const plan = buildHealthPlan({
    buckets: buckets({ fixed: 30, discretionary: 30, debt: 20, left: 20 }),
    debts: [{ name: 'Visa', debt_type: 'credit_card', balance: 3000, apr: 24.9, min_payment: 90 }],
    goals: [{ name: 'Trip', target_amount: 3000, current_amount: 0, target_date: '2027-07-01' }, { name: 'House', target_amount: 60000, target_date: '2030-07-01' }],
    assets: { cash: 2000, savings: 1500, investments: 0, hasInvestment: false },
    savedMonthly: 600, settings: { debt_budget: 200 }, now: NOW
  });
  const status = Object.fromEntries(plan.steps.map(step => [step.id, step.status]));
  assert.equal(status.automate, 'done', '600 is 12% of take-home');
  assert.equal(status.debt, 'done', '110 above the minimum');
  assert.equal(status.emergency, 'progress', 'past $1,000 but short of three months');
  assert.equal(status.invest, 'todo');
  assert.equal(status.goals, 'done');
  assert.equal(status.cards, 'progress', 'no interest charged, but a balance is listed');
  assert.equal(status.ahead, 'progress');
  const netWorth = plan.steps.find(step => step.id === 'net-worth');
  assert.equal(netWorth.netWorth, 500);
  assert.match(plan.steps.find(step => step.id === 'goals').detail, /Trip needs about \$250 a month/);
});

test('card interest keeps the cards step open', () => {
  const data = buckets({ fixed: 30, discretionary: 30, debt: 25, left: 15 }, { months: months([{}, {}, {}, {}, { cardInterest: 40 }, { cardInterest: 35 }, {}]) });
  const plan = buildHealthPlan({ buckets: data, now: NOW });
  const cards = plan.steps.find(step => step.id === 'cards');
  assert.equal(cards.status, 'todo');
  assert.match(cards.detail, /\$75 in card interest/);
});

test('without income the plan still lists every step and does not score', () => {
  const plan = buildHealthPlan({ buckets: { monthsUsed: 0, typical: null, months: [] }, now: NOW });
  assert.equal(plan.score, null);
  assert.equal(plan.buckets, null);
  assert.deepEqual(plan.focus, []);
  assert.equal(plan.steps.length, 12);
  assert.ok(plan.steps.every(step => step.detail));
  const noIncome = buildHealthPlan({ buckets: { monthsUsed: 3, typical: { ...typical({ fixed: 0, discretionary: 0, debt: 0, left: 0 }), income: 0 }, months: [] }, now: NOW });
  assert.equal(noIncome.typical, null);
  assert.equal(noIncome.steps.find(step => step.id === 'review').status, 'progress');
});

test('starting, ticking and resetting the plan', () => {
  const t = typical({ fixed: 30, discretionary: 40, debt: 20, left: 10 });
  const started = applyHealthChange(null, { action: 'start' }, { typical: t, now: NOW });
  assert.equal(started.startedAt, '2026-07-10');
  assert.equal(started.baseline.discretionary, 2000);
  const ticked = applyHealthChange(started, { step: 'invest', done: true });
  assert.deepEqual(ticked.done, { invest: true });
  assert.deepEqual(applyHealthChange(ticked, { step: 'invest', done: false }).done, {});
  assert.deepEqual(applyHealthChange(ticked, { action: 'reset' }), { startedAt: null, done: {}, baseline: null });
  for (const bad of [{}, { step: 'nope', done: true }, { step: 'invest', done: 'yes' }, { action: 'explode' }]) {
    assert.throws(() => applyHealthChange(started, bad), error => error.status === 400);
  }
  assert.deepEqual(normalizeHealthState({ startedAt: 'yesterday', done: { invest: true, hack: true }, baseline: { income: 'x' } }), { startedAt: null, done: { invest: true }, baseline: null });

  const later = new Date(2026, 7, 21);
  const plan = buildHealthPlan({
    buckets: buckets({ fixed: 30, discretionary: 40, debt: 20, left: 10 }, { months: months([{}, {}, {}, {}, { discretionary: 1700 }, { discretionary: 1700 }, {}]) }),
    state: ticked, now: later
  });
  assert.equal(plan.week, 7);
  assert.equal(plan.finished, false);
  const invest = plan.steps.find(step => step.id === 'invest');
  assert.deepEqual([invest.status, invest.autoStatus, invest.manual], ['done', 'todo', true]);
  assert.equal(plan.steps.find(step => step.id === 'cut').status, 'done', 'discretionary fell more than 10% from the baseline');
  assert.match(plan.steps.find(step => step.id === 'recheck').detail, /down \$300/);
  const done = buildHealthPlan({ buckets: buckets({ fixed: 30, discretionary: 30, debt: 25, left: 15 }), state: ticked, now: new Date(2026, 9, 10) });
  assert.equal(done.week, 12);
  assert.equal(done.finished, true);
});
