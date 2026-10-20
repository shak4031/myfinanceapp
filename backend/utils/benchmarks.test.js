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

test('Compass selected periods recompute monthly totals, chart widths and historical quarters', () => {
  const transactions = [
    ...history('Dining', [...Array(12).fill(50), ...Array(6).fill(100), ...Array(3).fill(200), ...Array(3).fill(300)]),
    ...history('Salary', Array(24).fill(2000), { direction: 'CREDIT' })
  ];
  const run = (months, endMonth = 8) => buildMoneyFlowSignals({ transactions, today: TODAY, range: { months, endYear: 2026, endMonth } });
  assert.equal(run(3).categories[0].average3, 300);
  assert.equal(run(6).categories[0].average3, 250);
  assert.equal(run(12).categories[0].average3, 175);
  assert.equal(run(24).categories[0].average3, 112.5);
  for (const months of [3, 6, 12, 24]) {
    const result = run(months);
    assert.equal(result.monthsAnalyzed, months);
    assert.equal(result.flow.months, months);
    assert.equal(result.heatmap.months.length, months);
    assert.equal(result.categories[0].series.length, months);
    assert.equal(result.categories[0].range.months, months);
    assert.equal(result.flow.income, 2000);
    assert.equal(result.flow.everyday.total, result.categories[0].average3);
  }
  const q2 = run(3, 5);
  assert.deepEqual(q2.heatmap.months, ['Apr 2026', 'May 2026', 'Jun 2026']);
  assert.equal(q2.categories[0].average3, 200);
  assert.equal(q2.flow.everyday.total, 200);
  assert.equal(q2.categories[0].range.latest, 200);
  const changedOutsideQuarter = [...transactions, { date: '2026-10-02', amount: 900, category: 'Dining', direction: 'DEBIT' }];
  assert.deepEqual(buildMoneyFlowSignals({ transactions: changedOutsideQuarter, range: { months: 3, endYear: 2026, endMonth: 5 } }).categories, q2.categories);
  const single = run(1);
  assert.equal(single.status, 'needs-history');
  assert.equal(single.flow.everyday.total, 300);
  assert.equal(single.heatmap.months.length, 1);
});

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
  const tx = [...history('Shopping', Array(6).fill(120)), { id: 42, date: '2026-08-15', description: 'BEST BUY TV', amount: 1249.99, direction: 'DEBIT', category: 'Shopping' },
    { date: '2026-08-16', description: 'Transfer to savings', amount: 900, direction: 'DEBIT', category: 'Transfer' }];
  const shopping = buildMoneyFlowSignals({ transactions: tx, today: TODAY }).categories.find(c => c.id === 'shopping');
  assert.deepEqual(shopping.oneOffs, [{ id: 42, date: '2026-08-15', description: 'BEST BUY TV', amount: 1249.99 }]);
  assert.deepEqual(shopping.series.slice(-6), Array(6).fill(120));
});

test('fewer than three completed months reports needs-history', () => {
  const mf = buildMoneyFlowSignals({ transactions: history('Dining', [100, 120]), today: TODAY });
  assert.equal(mf.status, 'needs-history');
  assert.deepEqual(mf.opportunities, []);
  assert.equal(buildMoneyFlowSignals().status, 'needs-history');
});

// Several purchases a month: `plan` is oldest first, ending with September 2026, each entry [count, ticket].
function visits(category, plan) {
  return plan.flatMap(([count, ticket], i) => {
    const d = new Date(2026, 9 - (plan.length - i), 1);
    return Array.from({ length: count }, (_, k) => ({ date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(k + 1).padStart(2, '0')}`, description: `CAFE ${k}`, amount: ticket, direction: 'DEBIT', category }));
  });
}

test('the normal range is your own 5th-95th percentile and a top-5% month is a spike', () => {
  const months = [200, 210, 190, 205, 195, 200, 215, 185, 200, 210, 190, 330];
  const result = buildMoneyFlowSignals({ transactions: history('Groceries', months), today: TODAY });
  const row = result.categories.find(c => c.id === 'groceries');
  assert.equal(row.range.months, 12);
  assert.equal(row.range.latest, 330);
  assert.equal(row.range.month, 'Sep 2026');
  assert.equal(row.range.higherThan, 11);
  assert.equal(row.range.compared, 11);
  assert.ok(row.range.p5 <= row.range.p50 && row.range.p50 <= row.range.p95, JSON.stringify(row.range));
  assert.ok(row.range.p5 >= 185 && row.range.p50 >= 195 && row.range.p50 <= 210);
  assert.equal(row.spike, true);
  const calm = buildMoneyFlowSignals({ transactions: history('Groceries', months.map(() => 200).fill(205, -1)), today: TODAY });
  assert.equal(calm.categories[0].spike, false, 'a small move over the median is not a spike');
  assert.equal(calm.categories[0].range.higherThan, 11);
});

test('the purchases x size split says whether more visits or pricier visits drove a change', () => {
  const steady = [[4, 25], [4, 25], [4, 25]];
  const more = buildMoneyFlowSignals({ transactions: visits('Dining', [...steady, [8, 25], [8, 25], [8, 25]]), today: TODAY }).categories[0].driver;
  assert.equal(more.basis, 'previous-3-months');
  assert.equal(more.cause, 'visits');
  assert.equal(more.visitsThen, 4); assert.equal(more.visitsNow, 8);
  assert.equal(more.ticketThen, 25); assert.equal(more.ticketNow, 25);
  assert.equal(more.change, 100);
  const pricier = buildMoneyFlowSignals({ transactions: visits('Dining', [...steady, [4, 50], [4, 50], [4, 50]]), today: TODAY }).categories[0].driver;
  assert.equal(pricier.cause, 'price');
  const both = buildMoneyFlowSignals({ transactions: visits('Dining', [...steady, [6, 35], [6, 35], [6, 35]]), today: TODAY }).categories[0].driver;
  assert.equal(both.cause, 'both');
  assert.equal(Math.round(both.volume + both.price), both.change, 'volume and price add up to the change');
  const flat = buildMoneyFlowSignals({ transactions: visits('Dining', [...steady, ...steady]), today: TODAY }).categories[0].driver;
  assert.equal(flat.cause, 'steady');
  const yearAgo = buildMoneyFlowSignals({ transactions: visits('Dining', Array.from({ length: 15 }, (_, i) => i >= 12 ? [6, 25] : [4, 25])), today: TODAY }).categories[0].driver;
  assert.equal(yearAgo.basis, 'same-months-last-year');
});

test('the money flow splits income into fixed bills, everyday spending and left over, without transfers', () => {
  const months = [3, 2, 1].map(back => { const d = new Date(2026, 9 - back, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  const transactions = months.flatMap(m => [
    { date: `${m}-01`, description: 'PAYROLL', amount: 5000, direction: 'CREDIT', category: 'Income' },
    { date: `${m}-02`, description: 'MORTGAGE', amount: 2000, direction: 'DEBIT', category: 'Mortgage', is_fixed: true },
    { date: `${m}-03`, description: 'MARKET', amount: 400, direction: 'DEBIT', category: 'Groceries' },
    { date: `${m}-04`, description: 'BISTRO', amount: 300, direction: 'DEBIT', category: 'Dining' },
    { date: `${m}-05`, description: 'TO SAVINGS', amount: 1000, direction: 'DEBIT', category: 'Transfer', transfer_kind: 'savings' },
    ...Array.from({ length: 10 }, (_, k) => ({ date: `${m}-${String(k + 10)}`, description: `STARBUCKS #${k}`, amount: 6, direction: 'DEBIT', category: 'Coffee' }))
  ]);
  const result = buildMoneyFlowSignals({ transactions, today: TODAY, typical: { avgMonthlyExpenses: 2760 + 150 } });
  const { flow, small } = result;
  assert.equal(flow.months, 3);
  assert.equal(flow.income, 5000);
  assert.equal(flow.fixed.total, 2000);
  assert.equal(flow.everyday.total, 760, 'the savings transfer is not spending');
  assert.equal(flow.debt, 150, 'minimums the surplus counts but history does not show');
  assert.equal(flow.left, 2090);
  assert.equal(flow.income, flow.fixed.total + flow.everyday.total + flow.debt + flow.left);
  assert.deepEqual(flow.everyday.items.map(i => i.label), ['Groceries', 'Dining', 'Everything else'], 'items under 3% of income are grouped');
  assert.equal(flow.everyday.items.find(i => i.label === 'Dining').id, 'dining');
  assert.deepEqual({ perMonth: small.perMonth, monthly: small.monthly, annual: small.annual, topMerchant: small.topMerchant }, { perMonth: 10, monthly: 60, annual: 720, topMerchant: 'STARBUCKS' });
  assert.ok(result.insights.length <= 4);
  assert.ok(result.insights.some(i => i.id === 'small'), 'small purchases over $300 a year are worth a card');
});

test('insights lead with the biggest saving and never exceed four cards', () => {
  const profile = { size: 1, region: 'south', housing: 'rent' };
  const transactions = [
    ...visits('Dining', [...Array(9).fill([6, 30]), [12, 40], [12, 40], [14, 40]]),
    ...history('Groceries', [300, 310, 290, 300, 305, 295, 300, 310, 290, 300, 305, 600]),
    ...history('Shopping', [200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 310])
  ];
  const result = buildMoneyFlowSignals({ transactions, profile, today: TODAY });
  assert.ok(result.opportunities.length > 0);
  assert.ok(result.insights.length >= 2 && result.insights.length <= 4, result.insights.map(i => i.id).join());
  assert.equal(result.insights[0].id, 'top-saving');
  assert.equal(new Set(result.insights.map(i => i.id)).size, result.insights.length);
  assert.ok(result.insights.some(i => i.id === 'spike'), 'the September grocery jump is called out');
  for (const insight of result.insights) for (const key of ['figure', 'title', 'detail', 'tone']) assert.ok(insight[key], `${insight.id}.${key}`);
});
test('the heatmap lists every spending category by month, biggest first, without transfers', () => {
  const transactions = [
    ...history('Mortgage', Array(14).fill(2000), { is_fixed: true }),
    ...history('Shopping', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 900, 100, 100, 100]),
    ...history('Transfer', Array(14).fill(5000), { transfer_kind: 'savings' })
  ];
  const { heatmap } = buildMoneyFlowSignals({ transactions, today: TODAY });
  assert.equal(heatmap.months.length, 12);
  assert.equal(heatmap.months[11], 'Sep 2026');
  assert.deepEqual(heatmap.rows.map(r => r.label), ['Mortgage', 'Shopping'], 'transfers are never spending');
  assert.equal(heatmap.rows[0].fixed, true);
  assert.equal(heatmap.rows[1].fixed, false);
  assert.equal(heatmap.rows[1].values[8], 900, 'the June spike sits in its own month column');
  assert.equal(heatmap.rows[1].total, 2000);
});

test('merchant bubbles compare the last three months with the three before and set one-offs aside', () => {
  const day = (back, d) => { const x = new Date(2026, 9 - back, d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
  const transactions = [6, 5, 4, 3, 2, 1].flatMap(back => [
    { date: day(back, 3), description: `SHAKE SHACK ${back}`, amount: back <= 3 ? 60 : 30, direction: 'DEBIT', category: 'Dining' },
    { date: day(back, 4), description: 'POS PURCHASE STARBUCKS #12', amount: 6, direction: 'DEBIT', category: 'Dining' },
    { date: day(back, 5), description: 'STARBUCKS STORE 99', amount: 6, direction: 'DEBIT', category: 'Dining' },
    { date: day(back, 6), description: 'ROCKET MORTGAGE', amount: 2000, direction: 'DEBIT', category: 'Mortgage', is_fixed: true },
    { date: day(back, 7), description: 'TO SAVINGS', amount: 500, direction: 'DEBIT', category: 'Transfer', transfer_kind: 'savings' },
    ...(back === 1 ? [{ date: day(1, 8), description: 'BEST BUY 0042', amount: 1250, direction: 'DEBIT', category: 'Shopping' },
      { date: day(1, 9), description: 'NEW CAFE', amount: 12, direction: 'DEBIT', category: 'Dining' }] : [])
  ]);
  const { vendors } = buildMoneyFlowSignals({ transactions, today: TODAY });
  assert.equal(vendors.months, 3);
  assert.equal(vendors.compareMonths, 3);
  const names = vendors.items.map(v => v.name);
  assert.ok(!names.some(n => /ROCKET|SAVINGS|BEST BUY/.test(n)), `fixed bills, transfers and one-offs stay out: ${names}`);
  assert.deepEqual(vendors.setAside, { count: 1, monthly: 416.67, over: 250 });
  const shack = vendors.items.find(v => v.name.startsWith('SHAKE SHACK'));
  assert.deepEqual({ monthly: shack.monthly, visits: shack.visits, change: shack.change, regular: shack.regular }, { monthly: 60, visits: 1, change: 1, regular: true });
  assert.deepEqual([shack.amount, shack.transactions, shack.monthlyLow, shack.monthlyHigh, shack.swingPct], [180, 3, 60, 60, 0]);
  const coffee = vendors.items.filter(v => v.name.startsWith('STARBUCKS'));
  assert.equal(coffee.length, 1, 'different store numbers are one merchant');
  assert.deepEqual({ visits: coffee[0].visits, ticket: coffee[0].ticket, change: coffee[0].change }, { visits: 2, ticket: 6, change: 0 });
  const cafe = vendors.items.find(v => v.name === 'NEW CAFE');
  assert.equal(cafe.isNew, true);
  assert.equal(cafe.change, null);
  assert.deepEqual([cafe.amount, cafe.transactions, cafe.monthlyLow, cafe.monthlyHigh, cafe.swingPct], [12, 1, 0, 12, 3]);
  assert.equal(vendors.items[0].name.startsWith('SHAKE SHACK'), true, 'biggest monthly spend first');
});

test('merchant spending swing uses monthly high minus low divided by the period average, not the previous period', () => {
  const transactions = [
    ...history('Dining', [90, 90, 90, 30, 90, 60], { description: 'CORNER CAFE' }),
    ...history('Dining', [200, 200, 200, 40, 40, 40], { description: 'STEADY DINER' }),
    ...history('Salary', Array(6).fill(1000), { direction: 'CREDIT' }),
    { date: '2026-09-12', description: 'CORNER CAFE', amount: 30, category: 'Dining', direction: 'DEBIT' }
  ];
  const range = { months: 3, endYear: 2026, endMonth: 8 };
  const data = buildMoneyFlowSignals({ transactions, today: TODAY, range }).vendors;
  const cafe = data.items.find(item => item.name === 'CORNER CAFE');
  assert.deepEqual([cafe.amount, cafe.transactions, cafe.monthly, cafe.monthlyLow, cafe.monthlyHigh, cafe.swingPct], [210, 4, 70, 30, 90, 0.8571]);
  assert.equal(cafe.change, -0.222);
  const steady = data.items.find(item => item.name === 'STEADY DINER');
  assert.equal(steady.swingPct, 0);
  assert.equal(steady.change, -0.8, 'prior-period decline is different from within-period swing');
  const single = buildMoneyFlowSignals({ transactions, today: TODAY, range: { ...range, months: 1 } }).vendors.items.find(item => item.name === 'CORNER CAFE');
  assert.equal(single.swingPct, null, 'one month cannot measure variability');
  assert.deepEqual([single.amount, single.transactions], [90, 2]);
  const quarter = buildMoneyFlowSignals({ transactions, today: TODAY, range: { ...range, endMonth: 5 } }).vendors.items.find(item => item.name === 'CORNER CAFE');
  assert.equal(quarter.swingPct, 0, 'historical range excludes later changes');
});

test('renamed transactions group and display under the name the user chose', () => {
  const day = (back, d) => { const x = new Date(2026, 9 - back, d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
  const transactions = [3, 2, 1].flatMap(back => [
    { date: day(back, 3), description: `SENT ${back}X7Q Zelle CRISTIANE DE LIMA`, amount: 100, direction: 'DEBIT', category: 'Other', display_name: 'Cristiane De Lima' },
    { date: day(back, 4), description: 'VENMO PAYMENT CRISTIANE', amount: 20, direction: 'DEBIT', category: 'Other', display_name: 'Cristiane De Lima' },
    { date: day(back, 5), description: 'ZELLE TO SAM PATEL', amount: 40, direction: 'DEBIT', category: 'Other' }
  ]);
  const { vendors } = buildMoneyFlowSignals({ transactions, today: TODAY });
  const cristiane = vendors.items.filter(v => /CRISTIANE/i.test(v.name));
  assert.deepEqual(cristiane.map(v => [v.name, v.monthly, v.visits]), [['Cristiane De Lima', 120, 2]]);
});