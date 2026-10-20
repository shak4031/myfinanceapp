import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights, projectRunway } from './insights.js';

const today = new Date(2026, 9, 14); // Wed, Oct 14 2026
const bill = (description, amount, dayOfMonth, extra = {}) => ({ description, category: 'Bills', amount, dayOfMonth, isIncome: false, status: 'projected', payMode: null, ...extra });
const pay = (amount, dayOfMonth, extra = {}) => ({ description: 'ACME PAYROLL', amount, dayOfMonth, isIncome: true, status: 'projected', cadenceLabel: 'Every other Thursday', ...extra });

test('projectRunway walks the month with income landing before same-day bills', () => {
  const runway = projectRunway(500, [bill('Rent', 900, 15), pay(1200, 15), bill('Old', 50, 3, { status: 'processed' })], today);
  assert.equal(runway.shortfall, null);
  assert.equal(runway.end, 800);
  assert.equal(runway.ahead.length, 2);
});

test('dated runway agrees with the rolling dashboard across month boundaries and includes overdue bills', () => {
  const now = new Date(2026, 9, 30);
  const upcoming = [
    bill('Next month rent', 900, 1, { date: '2026-11-01' }),
    bill('Paid bill', 999, 20, { date: '2026-10-20', status: 'processed' }),
    pay(1200, 1, { date: '2026-11-01' }),
    bill('Overdue utility', 100, 3, { date: '2026-10-03' }),
    bill('Phone', 50, 31, { date: '2026-10-31' })
  ];
  const runway = projectRunway(500, upcoming, now);
  assert.equal(runway.end, 650);
  assert.equal(runway.low.amount, 350);
  assert.deepEqual(runway.ahead.map(item => item.description), ['Overdue utility', 'Phone', 'ACME PAYROLL', 'Next month rent']);
  const result = buildInsights({ today: now, balance: 500, upcoming });
  assert.deepEqual(result.pulse.safeToSpend, { amount: 350, committed: 150, count: 2, untilDay: 1, untilDate: '2026-11-01' });
  assert.equal(result.pulse.nextIncome.daysAway, 2);
  assert.equal(result.pulse.nextIncome.date, '2026-11-01');
  assert.equal(result.pulse.lowPoint.date, '2026-10-31');
  assert.equal(result.pulse.billsLeft.total, 1050);
  assert.match(result.insights.find(item => item.id === 'covered').title, /next 30 days/);
});

test('a projected shortfall is the first, most urgent insight', () => {
  const result = buildInsights({ today, balance: 300, upcoming: [bill('Rent', 900, 20), pay(1500, 22), bill('Power', 80, 15, { payMode: 'auto' })] });
  assert.equal(result.insights[0].id, 'shortfall');
  assert.equal(result.insights[0].tone, 'danger');
  assert.match(result.insights[0].title, /20th|Tue/);
  assert.match(result.insights[0].detail, /−\$680/);
  assert.equal(result.pulse.lowPoint.amount, -680);
  assert.equal(result.pulse.nextIncome.daysAway, 8);
});

test('bills due soon call out manual payments and payday is announced', () => {
  const result = buildInsights({ today, balance: 5000, upcoming: [bill('City Water', 60, 15, { payMode: 'manual' }), pay(2100, 15), bill('Gym', 40, 28, { payMode: 'manual' })] });
  const ids = result.insights.map(item => item.id);
  assert.ok(ids.includes('covered'));
  const due = result.insights.find(item => item.id === 'due-soon');
  assert.equal(due.title, 'City Water is due tomorrow');
  assert.match(due.detail, /manual payment/);
  assert.equal(due.tone, 'warning');
  assert.ok(ids.includes('manual'));
  assert.equal(result.insights.find(item => item.id === 'payday').title, 'Payday is tomorrow');
  assert.equal(result.pulse.billsLeft.count, 2);
});

test('safe to spend subtracts everything due before the next paycheck, and only that', () => {
  const result = buildInsights({ today, balance: 1000, upcoming: [bill('Power', 80, 15), bill('Visa extra', 200, 20, { planned: true, flexible: true }), pay(2100, 22), bill('Rent', 900, 28)] });
  assert.deepEqual(result.pulse.safeToSpend, { amount: 720, committed: 280, count: 2, untilDay: 22 });
  const noPay = buildInsights({ today, balance: 500, upcoming: [bill('Rent', 450, 28), bill('Gym', 60, 30)] });
  assert.deepEqual(noPay.pulse.safeToSpend, { amount: -10, committed: 510, count: 2, untilDay: null });
  assert.equal(buildInsights({ today, balance: null, upcoming: [] }).pulse.safeToSpend, null);
  const tight = buildInsights({ today, balance: 300, upcoming: [bill('Rent', 300, 16), pay(2100, 22)] });
  assert.equal(tight.insights.find(item => item.id === 'safe-to-spend').tone, 'warning');
});

test('a stale import is nudged after a week, and not before', () => {
  const at = days => new Date(today.getFullYear(), today.getMonth(), today.getDate() - days, 9).toISOString();
  const fresh = buildInsights({ today, balance: 1000, lastImport: { at: at(3), latestDate: '2026-10-10' } });
  assert.equal(fresh.insights.some(item => item.id === 'import-stale'), false);
  assert.equal(fresh.pulse.lastImport.daysAgo, 3);
  const stale = buildInsights({ today, balance: 1000, lastImport: { at: at(9), latestDate: '2026-10-02' } });
  const nudge = stale.insights.find(item => item.id === 'import-stale');
  assert.equal(nudge.title, 'Your last import was 9 days ago');
  assert.match(nudge.detail, /Oct 2/);
  assert.equal(nudge.action.act, 'import');
  assert.equal(buildInsights({ today, balance: 1000, lastImport: { at: at(20) } }).insights.find(item => item.id === 'import-stale').tone, 'warning');
  assert.equal(buildInsights({ today, hasData: false, lastImport: null }).insights.some(item => item.id === 'import-stale'), false);
});

test('an upcoming three-paycheck month suggests where the extra paycheck should go', () => {
  const stream = { key: 'ACME', name: 'Acme Corp Payroll', cadence: 'biweekly', intervalDays: 14, amount: 2400, lastDate: '2026-10-08' };
  const plan = { debtPlan: { debts: [{ name: 'Visa', apr: 24.99, balance: 4000, included: true }, { name: 'Car', apr: 6, balance: 9000, included: true }] } };
  const result = buildInsights({ today, balance: 5000, incomeStreams: [stream], plan });
  const bonus = result.insights.find(item => item.id === 'three-paychecks');
  assert.equal(bonus.title, 'December 2026 has three paychecks');
  assert.match(bonus.detail, /3rd, 17th and 31st/);
  assert.match(bonus.detail, /\$2,400 more/);
  assert.match(bonus.detail, /Visa \(24\.99% APR\)/);
  assert.equal(bonus.action.view, 'payoff');
  const far = { ...stream, lastDate: '2026-10-13' }; // next three-paycheck month is March 2027
  assert.equal(buildInsights({ today, balance: 5000, incomeStreams: [far] }).insights.some(item => item.id === 'three-paychecks'), false);
});

test('free users get a Pro teaser; Pro users get budget and trend signals', () => {
  const free = buildInsights({ today, balance: 1000, upcoming: [] });
  assert.equal(free.insights.at(-1).tone, 'pro');
  const analytics = {
    categories: [
      { name: 'Dining', mtd: 420, budget: 300, budgetUsed: 1.4, budgetStatus: 'over', deltaPct: 0.5, deltaMtd: 140 },
      { name: 'Groceries', mtd: 380, budget: 500, projected: 640, budgetProjected: 1.28, budgetStatus: 'risk', deltaPct: 0.3, deltaMtd: 90 },
      { name: 'Transfers', transfer: true, mtd: 5000, budgetStatus: 'over', budgetUsed: 9 }
    ],
    anomalies: [{ type: 'charge', id: 42, merchant: 'BEST BUY', amount: 899, ratio: 6.2, date: '2026-10-09' }],
    recurring: [{ merchant: 'Netflix', active: true, amount: 22.99, priceChange: 3, priceChangePct: 0.15, annualCost: 275.88 }],
    forecast: { projected: 4200 }, kpis: { avgMonthlySpend: 3000 }
  };
  const result = buildInsights({ today, balance: 1000, upcoming: [], analytics, pro: true });
  const ids = result.insights.map(item => item.id);
  assert.equal(ids[0], 'over:Dining');
  assert.ok(!ids.includes('over:Transfers'));
  assert.ok(ids.includes('risk:Groceries'));
  assert.ok(ids.includes('mover:Groceries'));
  assert.ok(ids.includes('anomaly') && ids.includes('price-hike') && ids.includes('forecast'));
  assert.deepEqual(result.insights.find(item => item.id === 'anomaly').action, { label: 'Review transaction', view: 'transactions/42' });
  assert.ok(!ids.includes('pro'));
  assert.match(result.insights.find(item => item.id === 'price-hike').detail, /\$36 a year/);
});

test('debt and goal plans surface progress, and an empty account is guided to import', () => {
  const plan = {
    debtPlan: {
      strategy: 'avalanche', strategies: [{ id: 'avalanche', name: 'Avalanche' }], budget: 900, minimums: 600,
      plan: { feasible: true, debtFree: true, debtFreeDate: '2028-03' },
      debts: [{ name: 'Visa', included: true, balance: 4000, thisMonth: { extra: 300 } }]
    },
    goalPlan: { goals: [{ name: 'Vacation', status: 'behind', gap: 120, target: 3000, remaining: 2000, targetDate: '2027-06-01', included: true }] }
  };
  const result = buildInsights({ today, balance: 2000, upcoming: [], plan });
  const debt = result.insights.find(item => item.id === 'debt-free');
  assert.equal(debt.title, 'Debt-free by March 2028');
  assert.match(debt.detail, /\$300 goes to Visa/);
  assert.deepEqual(debt.action, { label: 'Open debt-free plan', view: 'payoff' });
  assert.match(result.insights.find(item => item.id === 'goal-behind').detail, /\$120 more a month/);
  assert.equal(result.pulse.debtFreeDate, '2028-03');

  const empty = buildInsights({ today, balance: null, upcoming: [], hasData: false });
  assert.equal(empty.insights[0].id, 'import');
  assert.ok(!empty.insights.some(item => item.tone === 'pro'));
});
