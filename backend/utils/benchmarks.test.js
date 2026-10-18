import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMoneyFlowSignals, expectedMonthly, normalizeProfile, benchmarkCategoryFor, profileLabel, robustTrend } from './benchmarks.js';

const TODAY = new Date(2026, 9, 20); // October 2026, so September 2026 is the latest completed month.

// One debit per month for each category; `amounts` is oldest first and ends with September 2026.
function history(category, amounts, extra = {}) {
  return amounts.map((amount, i) => {
    const back = amounts.length - i;
    const d = new Date(2026, 9 - back, 2);
    return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-02`, description: `${category.toUpperCase()} ${i}`, amount, direction: 'DEBIT', category, ...extra };
  });
}

test('typical spending scales with household size, region and housing', () => {
  const all = expectedMonthly('groceries', null);
  const single = expectedMonthly('groceries', { size: 1 });
  const five = expectedMonthly('groceries', { size: 5 });
  assert.ok(single < all && all < five, `${single} < ${all} < ${five}`);
  assert.equal(expectedMonthly('groceries', { size: 9 }), five, 'the survey caps at 5 or more people');
  assert.notEqual(expectedMonthly('dining', { size: 2, region: 'northeast' }), expectedMonthly('dining', { size: 2, region: 'south' }));
  assert.notEqual(expectedMonthly('dining', { size: 2, housing: 'own' }), expectedMonthly('dining', { size: 2, housing: 'rent' }));
  assert.equal(expectedMonthly('mortgage', null), null);
});

test('profiles are validated and labelled; only standard categories match', () => {
  assert.deepEqual(normalizeProfile({ size: 13, region: 'Mars', housing: 'boat' }), { size: null, region: null, housing: null });
  assert.deepEqual(normalizeProfile({ household_size: 4, region: 'WEST', housing: 'Rent' }), { size: 4, region: 'west', housing: 'rent' });
  assert.equal(profileLabel(null), 'the average U.S. household');
  assert.equal(profileLabel({ size: 5, region: 'south', housing: 'own' }), 'a typical 5-person household in the South that owns its home');
  assert.equal(benchmarkCategoryFor('Dining Out').id, 'dining');
  assert.equal(benchmarkCategoryFor('Utilities').id, 'utilities');
  assert.equal(benchmarkCategoryFor('Gas').id, 'fuel');
  for (const name of ['Mortgage', 'Rent', 'Car Loan', 'Insurance', 'Internet', 'Pottery club']) assert.equal(benchmarkCategoryFor(name), null, name);
});

test('robust trend ignores a single spike', () => {
  assert.ok(robustTrend([100, 110, 120, 130, 140, 150]) > 0.05);
  assert.ok(Math.abs(robustTrend([100, 100, 100, 900, 100, 100])) < 0.01);
  assert.equal(robustTrend([1, 2]), null);
});

test('dining well above a typical household and rising becomes a savings opportunity', () => {
  const profile = { size: 2, region: 'northeast', housing: 'own' };
  const typical = expectedMonthly('dining', profile);
  const amounts = [...Array(12).fill(typical * 0.9), ...[1.3, 1.4, 1.5, 1.5, 1.6, 1.6].map(x => typical * x)];
  const mf = buildMoneyFlowSignals({ transactions: history('Dining', amounts), profile, today: TODAY });
  assert.equal(mf.status, 'ok');
  assert.equal(mf.profileSet, true);
  const dining = mf.categories.find(c => c.id === 'dining');
  assert.equal(dining.benchmarkStatus, 'high');
  assert.equal(dining.momentum.basis, 'year-over-year');
  assert.equal(dining.crossover.state, 'above');
  assert.ok(dining.opportunity.monthly > 0);
  assert.ok(dining.opportunity.target <= dining.normal && dining.opportunity.target >= dining.support);
  assert.match(mf.opportunities[0].message, /Dining averages .* more than a typical 2-person household/);
  assert.ok(Math.abs(mf.potentialAnnual - mf.potentialMonthly * 12) < 1);
});

test('seasonal bills are compared with the same months last year', () => {
  const season = [300, 280, 250, 220, 260, 330, 380, 400, 340, 280, 260, 300];
  const amounts = [...season, ...season.map(v => v * 1.25)].slice(-16);
  const mf = buildMoneyFlowSignals({ transactions: history('Utilities', amounts), profile: null, today: TODAY });
  const utilities = mf.categories.find(c => c.id === 'utilities');
  assert.equal(utilities.momentum.basis, 'year-over-year');
  assert.ok(Math.abs(utilities.momentum.change - 0.25) < 0.001);
  assert.equal(utilities.opportunity.basis, 'same-months-last-year');
  assert.equal(utilities.opportunity.target, utilities.momentum.lastYear);
  assert.equal(mf.comparedWith, 'the average U.S. household');
});

test('a seasonal bill with under 15 months is not flagged just because the season turned', () => {
  const typical = expectedMonthly('utilities', { size: 1 });
  const amounts = [0.6, 0.58, 0.55, 0.57, 0.6, 0.95, 1, 1.05].map(x => typical * x);
  const mf = buildMoneyFlowSignals({ transactions: history('Utilities', amounts), profile: { size: 1 }, today: TODAY });
  const utilities = mf.categories.find(c => c.id === 'utilities');
  assert.equal(utilities.momentum, null);
  assert.equal(utilities.crossover.state, 'above');
  assert.equal(utilities.crossover.seasonal, true);
  assert.equal(utilities.benchmarkStatus, 'typical');
  assert.equal(mf.opportunities.length, 0);
});

test('a year-over-year jump that the recent trend does not confirm is not called rising', () => {
  const amounts = [100, 100, 100, ...Array(12).fill(400)];
  const mf = buildMoneyFlowSignals({ transactions: history('Shopping', amounts), profile: null, today: TODAY });
  const shopping = mf.categories.find(c => c.id === 'shopping');
  assert.ok(shopping.momentum.change > 1);
  assert.equal(shopping.momentum.confirmed, false);
  assert.equal(shopping.opportunity, null);
});

test('one-off purchases and transfers are left out of the series', () => {
  const tx = [...history('Shopping', Array(6).fill(120)), { date: '2026-08-15', description: 'BEST BUY TV', amount: 1249.99, direction: 'DEBIT', category: 'Shopping' },
    { date: '2026-08-16', description: 'Transfer to savings', amount: 900, direction: 'DEBIT', category: 'Transfer' }];
  const shopping = buildMoneyFlowSignals({ transactions: tx, today: TODAY }).categories.find(c => c.id === 'shopping');
  assert.deepEqual(shopping.oneOffs, [{ date: '2026-08-15', description: 'BEST BUY TV', amount: 1249.99 }]);
  assert.deepEqual(shopping.series.slice(-6), Array(6).fill(120));
});

test('fewer than three completed months reports needs-history', () => {
  const mf = buildMoneyFlowSignals({ transactions: history('Dining', [100, 120]), today: TODAY });
  assert.equal(mf.status, 'needs-history');
  assert.deepEqual(mf.opportunities, []);
  assert.equal(buildMoneyFlowSignals().status, 'needs-history');
});
