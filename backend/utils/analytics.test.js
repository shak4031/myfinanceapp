import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAnalytics, merchantKey, merchantGroup, trendSlope, toCsv } from './analytics.js';
import { buildMoneyFlowSignals } from './benchmarks.js';
import { entitlementFromRow } from './license.js';
import { getCanonicalMerchant } from './normalize.js';

const iso = (year, month, day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const today = new Date(2026, 5, 15); // 15 Jun 2026
let nextId = 1;
const tx = (monthOffset, day, amount, category, description, extra = {}) => {
  const date = new Date(2026, 5 + monthOffset, day);
  return { id: String(nextId++), date: iso(date.getFullYear(), date.getMonth(), date.getDate()), amount, direction: 'DEBIT', category, description, is_fixed: false, ...extra };
};

function sampleTransactions() {
  const rows = [];
  for (let offset = -6; offset <= 0; offset++) {
    rows.push(tx(offset, 2, 3000, 'Income', 'ACME PAYROLL DIR DEP', { direction: 'CREDIT' }));
    rows.push(tx(offset, 3, 1500, 'Mortgage', 'PENNYMAC ONLINE PMT', { is_fixed: true }));
    rows.push(tx(offset, 9, 15.49 + (offset === 0 ? 2 : 0), 'Subscriptions', `VISA DDA PUR AP 4${offset + 10}0429 NETFLIX COM 408 * CA`));
    rows.push(tx(offset, 10, 400 + (offset + 6) * 20, 'Groceries', 'DDA PURCHASE SHOPRITE 123'));
    rows.push(tx(offset, 20, 400 + (offset + 6) * 20, 'Groceries', 'DDA PURCHASE SHOPRITE 123'));
    rows.push(tx(offset, 12, 500, 'Transfer', 'ONLINE TRANSFER TO SAVINGS'));
  }
  // History of small coffee charges and one huge one.
  for (let offset = -5; offset <= -1; offset++) rows.push(tx(offset, 5, 6, 'Dining', 'STARBUCKS STORE 1234'));
  rows.push(tx(0, 6, 90, 'Dining', 'STARBUCKS STORE 1234'));
  rows.push(tx(1, 1, 999, 'Dining', 'FUTURE CHARGE'));
  return rows;
}

test('merchantKey ignores bank noise and keeps payment-rail payees', () => {
  assert.equal(merchantKey('VISA DDA PUR AP 420429 NETFLIX COM 408 5403700 * CA'), 'NETFLIX');
  assert.equal(merchantKey('DDA PURCHASE AP 00001000 NETFLIX COM LOS GATOS * CA'), 'NETFLIX');
  assert.equal(merchantKey('ZELLE TO JOHN SMITH'), 'ZELLE JOHN');
  assert.equal(merchantKey('1234 5678'), '');
});

test('trendSlope is relative to the mean and needs three points', () => {
  assert.equal(trendSlope([100, 100]), null);
  assert.equal(trendSlope([100, 100, 100]), 0);
  assert.ok(trendSlope([100, 110, 120, 130]) > 0.08);
  assert.ok(trendSlope([130, 120, 110]) < 0);
});

test('buildAnalytics computes category signals, budgets, KPIs and excludes transfers', () => {
  const result = buildAnalytics({ transactions: sampleTransactions(), budgets: [{ category: 'Groceries', amount: 450 }, { category: 'Travel', amount: 200 }], latestBalance: 5000, today });
  assert.equal(result.months.length, 12);
  assert.equal(result.months.at(-1), '2026-06');
  assert.equal(result.monthsOfHistory, 6);
  const groceries = result.categories.find(c => c.name === 'Groceries');
  assert.equal(groceries.mtd, 520);
  assert.equal(groceries.lastMonthToDate, 500);
  assert.equal(groceries.deltaMtd, 20);
  assert.equal(groceries.deltaPct, 0.04);
  assert.equal(groceries.sma3, 960);
  assert.equal(groceries.series.at(-1), 520);
  assert.ok(groceries.trend > 0, 'groceries are trending up');
  assert.equal(groceries.budget, 450);
  assert.equal(groceries.budgetStatus, 'over');
  assert.ok(groceries.budgetUsed > 1);
  const travel = result.categories.find(c => c.name === 'Travel');
  assert.equal(travel.mtd, 0);
  assert.equal(travel.budgetStatus, 'ok');
  const transfer = result.categories.find(c => c.name === 'Transfer');
  assert.equal(transfer.transfer, true);
  assert.equal(transfer.share, null);
  assert.deepEqual(result.excludedCategories, ['Transfer']);
  const shareTotal = result.categories.filter(c => c.share != null).reduce((total, c) => total + c.share, 0);
  assert.ok(Math.abs(shareTotal - 1) < 0.001);
  assert.equal(result.categories.find(c => c.name === 'Dining').mtd, 90, 'future-dated rows are ignored');
  assert.equal(result.kpis.avgMonthlyIncome, 3000);
  assert.equal(result.kpis.savingsRate, Math.round((3000 - result.kpis.avgMonthlySpend) / 3000 * 10000) / 10000);
  assert.ok(result.kpis.savingsRate > 0.1 && result.kpis.savingsRate < 0.25);
  assert.ok(result.kpis.fixedRatio > 0.55);
  assert.equal(result.forecast.day, 15);
  assert.equal(result.forecast.paceCurrent.length, 15);
  assert.ok(result.forecast.projected >= result.forecast.mtd);
  assert.equal(result.cashflow.months.length, 6);
  assert.equal(result.cashflow.months[0].month, '2026-07');
  assert.equal(result.cashflow.months[0].balance, Math.round((5000 + result.cashflow.months[0].net) * 100) / 100);
});

test('buildAnalytics finds recurring charges, price increases, anomalies and top merchants', () => {
  const result = buildAnalytics({ transactions: sampleTransactions(), today });
  const netflix = result.recurring.find(s => s.merchant === 'NETFLIX');
  assert.ok(netflix, 'Netflix is detected as recurring');
  assert.equal(netflix.fixed, false);
  assert.equal(netflix.likelyBill, false);
  assert.ok(netflix.id, 'the latest charge id is returned so it can be marked fixed');
  assert.equal(netflix.cadence, 'monthly');
  assert.equal(netflix.active, true);
  assert.equal(netflix.priceChange, 2);
  assert.ok(netflix.annualCost > 200);
  assert.ok(!result.recurring.some(s => /SHOPRITE/.test(s.merchant)), 'growing grocery spend is not recurring');
  const coffee = result.anomalies.find(a => a.type === 'charge' && /STARBUCKS/.test(a.merchant));
  assert.ok(coffee, 'a 15x coffee charge is unusual');
  assert.equal(coffee.typical, 6);
  assert.ok(result.merchants.length > 0);
  assert.ok(!result.merchants.some(m => /TRANSFER|SAVINGS/.test(m.merchant)));
});

test('recurring charges flag what is not marked fixed and skip stores and one-off purchases', () => {
  const rows = [];
  for (let offset = -6; offset <= 0; offset++) {
    rows.push(tx(offset, 1, 2184.37, 'Mortgage', 'ROCKET MORTGAGE AUTOPAY', { is_fixed: true }));
    rows.push(tx(offset, 25, 350, 'Credit Card Payment', 'CHASE CREDIT CRD AUTOPAY'));
    rows.push(tx(offset, 12, 412.5, 'Auto Loan', 'TOYOTA FINANCIAL PMT'));
    rows.push(tx(offset, 8, 148, 'Insurance', 'GEICO AUTO INS'));
    rows.push(tx(offset, 14, 89.99, 'Utilities', 'COMCAST CABLE COMM'));
    rows.push(tx(offset, 18, 180 + (offset % 2) * 40, 'Shopping', 'COSTCO WHSE 0123'));
    rows.push(tx(offset, 22, [18, 31.5, 22, 47.25, 26, 39, 33][offset + 6], 'Entertainment', 'AMC THEATRES 0456'));
    rows.push(tx(offset, 9, 15.49, 'Subscriptions', 'NETFLIX.COM'));
  }
  const result = buildAnalytics({ transactions: rows, today });
  const active = new Map(result.recurring.filter(s => s.active).map(s => [s.merchant, s]));
  assert.deepEqual([...active.keys()].sort(), ['CHASE CREDIT CRD', 'COMCAST-XFINITY', 'GEICO AUTO INS', 'NETFLIX', 'ROCKET MONEY', 'TOYOTA FINANCIAL PMT'].sort());
  assert.equal(active.get('ROCKET MONEY').fixed, true, 'a payment marked fixed is reported as fixed');
  const unmarked = [...active.values()].filter(s => !s.fixed);
  assert.deepEqual(unmarked.filter(s => s.likelyBill).map(s => s.merchant).sort(), ['CHASE CREDIT CRD', 'COMCAST-XFINITY', 'GEICO AUTO INS', 'TOYOTA FINANCIAL PMT']);
  assert.deepEqual(unmarked.filter(s => !s.likelyBill).map(s => s.merchant), ['NETFLIX']);
  assert.ok(![...active.keys()].some(name => /COSTCO|AMC/.test(name)), 'varying store and movie spend is not recurring');
});

test('the cash-flow surplus uses the shared typical surplus when it is supplied', () => {
  const typical = { monthlySurplus: 1234.56, monthsUsed: 3 };
  const shared = buildAnalytics({ transactions: sampleTransactions(), today, latestBalance: 5000, typical });
  assert.equal(shared.cashflow.basis, 'typical-surplus');
  assert.equal(shared.cashflow.monthsUsed, 3);
  assert.equal(buildAnalytics({ transactions: sampleTransactions(), today, latestBalance: 5000 }).cashflow.basis, 'recent-averages');
});

test('Rocket payments keep the Rocket Money label', () => {
  assert.equal(getCanonicalMerchant('ROCKET MORTGAGE AUTOPAY 1234'), 'ROCKET MONEY');
  assert.equal(getCanonicalMerchant('ROCKET MONEY PREMIUM'), 'ROCKET MONEY');
});

test('buildAnalytics handles an empty account', () => {
  const result = buildAnalytics({ transactions: [], today });
  assert.equal(result.categories.length, 0);
  assert.equal(result.kpis.savingsRate, null);
  assert.equal(result.cashflow.startBalance, null);
  assert.equal(result.recurring.length, 0);
});

test('toCsv quotes values and neutralises spreadsheet formulas', () => {
  const csv = toCsv([{ a: '=HYPERLINK("x")', b: 'one, two', c: -5 }], [
    { label: 'A', value: r => r.a }, { label: 'B', value: r => r.b }, { label: 'C', value: r => r.c }]);
  assert.equal(csv, 'A,B,C\r\n"\'=HYPERLINK(""x"")","one, two",-5\r\n');
});

test('entitlementFromRow covers owner, license, trial, expiry and revocation', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  assert.equal(entitlementFromRow(1, null, now).tier, 'pro');
  assert.equal(entitlementFromRow(1, null, now).source, 'owner');
  const free = entitlementFromRow(2, null, now);
  assert.equal(free.tier, 'none');
  assert.equal(free.trialAvailable, true);
  const trial = entitlementFromRow(2, { subscription: { status: 'trialing', trial_used: true,
    trial_started_at: '2026-06-06T12:00:00Z', trial_ends_at: '2026-06-21T12:00:00Z' } }, now);
  assert.equal(trial.tier, 'trial');
  assert.equal(trial.daysLeft, 6);
  const expired = entitlementFromRow(2, { trial_started_at: '2026-06-01T12:00:00Z', trial_ends_at: '2026-06-08T12:00:00Z' }, now);
  assert.equal(expired.tier, 'none');
  assert.equal(expired.trialAvailable, false);
  assert.equal(expired.source, 'trial-expired');
  assert.equal(entitlementFromRow(2, { plan: 'basic', granted_at: '2026-06-01T00:00:00Z' }, now).tier, 'basic');
  assert.equal(entitlementFromRow(2, { granted_at: null, revoked_at: '2026-06-02T00:00:00Z', trial_started_at: '2026-01-01T00:00:00Z' }, now).tier, 'none');
});

test('a fixed bill already paid this month is not projected again', () => {
  const analytics = buildAnalytics({ transactions: sampleTransactions(), today });
  const mortgage = analytics.categories.find(category => category.name === 'Mortgage');
  assert.equal(mortgage.mtd, 1500);
  assert.equal(mortgage.projected, 1500);
  assert.equal(mortgage.signal, 'inline');
});

test('merchant identities distinguish first-word and processor collisions and obey explicit rename selections', () => {
  const key = description => merchantGroup({ description });
  assert.notEqual(key('HOME DEPOT #123'), key('HOME GOODS #123'));
  assert.equal(key('HOME DEPOT #123'), key('THE HOME DEPOT #987'));
  assert.notEqual(key('TST PERI PERI 123'), key('TST CHAI CHENAK 123'));
  assert.notEqual(key('ZELLE TO JOHN SMITH'), key('ZELLE TO JOHN JONES'));
  assert.notEqual(key('CREDIT ONE PAYMENT'), key('CAPITAL ONE PAYMENT'));
  assert.equal(merchantGroup({ description: 'Bank variant A', display_name: ' My   Payee ' }),
    merchantGroup({ description: 'Bank variant B', display_name: 'my payee' }));
  assert.notEqual(merchantGroup({ description: 'HOME DEPOT', display_name: 'My project' }), key('HOME DEPOT'),
    'a selected-only rename must not silently rename unchecked payments');
});

test('forecast counts overdue unpaid bills and excludes transfer templates', () => {
  const transactions = [
    tx(-1, 2, 100, 'Utilities', 'BILL ONE', { is_fixed: true }),
    tx(-1, 25, 200, 'Utilities', 'BILL TWO', { is_fixed: true }),
    tx(-1, 20, 900, 'Savings', 'TRANSFER TO SAVINGS', { is_fixed: true, transfer_kind: 'savings' }),
    tx(0, 3, 10, 'Groceries', 'SHOP')
  ];
  const result = buildAnalytics({ transactions, today });
  assert.equal(result.forecast.remainingFixed, 300, 'the unpaid day-2 bill is still owed after its due date');
  assert.equal(result.forecast.projected, Math.round((result.forecast.mtd + 300 + result.forecast.remainingVariable) * 100) / 100);
});

test('Overview and Compass raw totals reconcile to independent ledger calculations across periods', () => {
  let id = 0;
  const transactions = [];
  for (let offset = -24; offset <= 0; offset++) {
    transactions.push(
      tx(offset, 2, 3500.25, 'Salary', 'PAYROLL', { id: ++id, direction: 'CREDIT', transfer_kind: null }),
      tx(offset, 3, 1450.10, 'Mortgage', 'MORTGAGE', { id: ++id, is_fixed: true, transfer_kind: null }),
      tx(offset, 4, 51.27 + Math.abs(offset), 'Shopping', 'HOME DEPOT', { id: ++id, display_name: 'Home Depot', transfer_kind: null }),
      tx(offset, 5, 6.35, 'Dining', 'CAFE', { id: ++id, transfer_kind: null }),
      tx(offset, 6, 200, 'Shopping', 'MOVE MONEY', { id: ++id, transfer_kind: 'internal' })
    );
  }
  const cents = n => Math.round(n * 100);
  const total = (list, direction) => list.filter(t => t.direction === direction && t.transfer_kind === null).reduce((sum, t) => sum + cents(t.amount), 0);
  const overview = buildAnalytics({ transactions, today, latestBalance: 1000 });
  for (const [i, month] of overview.months.entries()) {
    const ledger = transactions.filter(t => t.date.startsWith(month) && t.date <= '2026-06-15');
    assert.equal(cents(overview.series.spend[i]), total(ledger, 'DEBIT'));
    assert.equal(cents(overview.series.income[i]), total(ledger, 'CREDIT'));
    assert.equal(cents(overview.series.fixed[i]) + cents(overview.series.variable[i]), total(ledger, 'DEBIT'));
    assert.equal(overview.categories.filter(c => !c.transfer).reduce((sum, c) => sum + cents(c.series[i]), 0), total(ledger, 'DEBIT'));
  }
  const last3 = transactions.filter(t => t.date >= '2026-03-01' && t.date < '2026-06-01');
  assert.equal(cents(overview.kpis.avgMonthlySpend), Math.round(total(last3, 'DEBIT') / 3));
  assert.equal(cents(overview.kpis.avgMonthlyIncome), Math.round(total(last3, 'CREDIT') / 3));
  const recent = transactions.filter(t => (new Date(2026, 5, 15) - new Date(`${t.date}T00:00:00`)) / 86400000 < 90 && t.date <= '2026-06-15');
  assert.equal(overview.merchants.reduce((sum, m) => sum + cents(m.total), 0), total(recent, 'DEBIT'));
  assert.equal(overview.weekdays.reduce((sum, n) => sum + cents(n), 0), total(recent, 'DEBIT'));
  for (const months of [1, 3, 6, 12, 24]) {
    const from = new Date(2026, 5 - months, 1);
    const lower = iso(from.getFullYear(), from.getMonth(), 1);
    const ledger = transactions.filter(t => t.date >= lower && t.date < '2026-06-01');
    const compass = buildMoneyFlowSignals({ transactions, today, range: { months, endYear: 2026, endMonth: 4 } });
    assert.equal(cents(compass.vendors.totalAmount), total(ledger, 'DEBIT'));
    assert.equal(compass.vendors.items.reduce((sum, m) => sum + cents(m.amount), 0), total(ledger, 'DEBIT'));
    assert.equal(compass.heatmap.rows.reduce((sum, row) => sum + cents(row.total), 0), total(ledger, 'DEBIT'));
    assert.ok(Math.abs(cents(compass.flow.fixed.total + compass.flow.everyday.total) - Math.round(total(ledger, 'DEBIT') / months)) <= 1);
    assert.equal(cents(compass.flow.income), Math.round(total(ledger, 'CREDIT') / months));
    assert.ok(Math.abs(compass.flow.income - compass.flow.fixed.total - compass.flow.everyday.total - compass.flow.debt - compass.flow.left) < 0.02);
  }
});

test('explicit non-transfer rows in a legacy transfer category count consistently and invalid directions are not income', () => {
  const result = buildAnalytics({ transactions: [
    tx(0, 1, 100, 'Savings', 'PAYEE', { transfer_kind: null }),
    tx(0, 2, 500, 'Other', 'UNKNOWN', { direction: 'UNKNOWN' })
  ], today });
  assert.equal(result.kpis.mtdSpend, 100);
  assert.equal(result.categories.find(c => c.name === 'Other').mtd, 100);
  assert.equal(result.series.income.at(-1), 0);
});

test('merchant and weekday windows use exactly 90 calendar dates across the daylight-saving boundary', () => {
  const end = new Date(2026, 11, 15);
  const transactions = [0, 89, 90, 179, 180].map((days, i) => {
    const date = new Date(end.getFullYear(), end.getMonth(), end.getDate() - days);
    return { date: iso(date.getFullYear(), date.getMonth(), date.getDate()), amount: 2 ** i,
      direction: 'DEBIT', description: 'Boundary merchant', display_name: 'Boundary merchant', category: 'Shopping' };
  });
  const data = buildAnalytics({ transactions, today: end });
  assert.equal(data.merchants[0].total, 3);
  assert.equal(data.merchants[0].count, 2);
  assert.equal(data.merchants[0].change, -0.75);
  assert.equal(data.weekdays.reduce((sum, n) => sum + n, 0), 3);
});

test('selected rename identities are shared by recurring charges, merchant totals and unusual-charge detection', () => {
  const subscriptions = Array.from({ length: 6 }, (_, i) => tx(i - 5, 5, 15, 'Subscriptions', `BANK NETWORK ${i}`, {
    display_name: i === 5 ? 'Our Streaming' : ' our   streaming '
  }));
  subscriptions.push(tx(0, 7, 7, 'Subscriptions', 'BANK NETWORK 5'));
  const recurring = buildAnalytics({ transactions: subscriptions, today });
  assert.equal(recurring.recurring.length, 1);
  assert.equal(recurring.recurring[0].merchant, 'Our Streaming');
  assert.equal(recurring.recurring[0].charges, 6, 'unselected payments are not silently renamed or merged');
  assert.equal(recurring.merchants.find(m => m.merchant === 'Our Streaming').total, 45);
  const coffee = Array.from({ length: 6 }, (_, i) => tx(i - 5, 5, i === 5 ? 90 : 6, 'Dining', `BANK COFFEE ${i}`, {
    display_name: 'Our Coffee'
  }));
  const anomaly = buildAnalytics({ transactions: coffee, today }).anomalies.find(a => a.type === 'charge');
  assert.equal(anomaly.merchant, 'Our Coffee');
  assert.equal(anomaly.amount, 90);
  assert.equal(anomaly.typical, 6);
  assert.equal(anomaly.ratio, 15);
});
