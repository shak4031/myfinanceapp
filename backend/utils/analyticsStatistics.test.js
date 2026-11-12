import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalyticsStatistics } from './analyticsStatistics.js';
import { buildAnalytics } from './analytics.js';

const today = new Date(2026, 10, 11);
const tx = (month, amount, direction = 'DEBIT', extra = {}) => ({ id: month, date: `2026-${String(month).padStart(2, '0')}-10`, amount, direction, ...extra });
const rows = () => [5, 6, 7, 8, 9, 10].flatMap((month, i) => [tx(month, 100 + i * 100), tx(month, 1000, 'CREDIT')]);
const build = options => buildAnalyticsStatistics({ today, ...options });

test('statistics preserve unknown months, exclude partial/pending/transfers and compute delayed rolling windows', () => {
  const statistics = build({ transactions: [...rows(), tx(11, 99999), tx(10, 99999, 'DEBIT', { is_pending: true }),
    tx(10, 99999, 'DEBIT', { transfer_kind: 'internal' }), tx(10, 'invalid'), tx(10, 99999, 'OTHER')] });
  assert.equal(statistics.observedMonths, 6);
  assert.equal(statistics.points[0].spend, null);
  assert.equal(statistics.points.at(-1).month, '2026-10');
  assert.equal(statistics.points.at(-1).spend, 600);
  assert.equal(statistics.points.at(-1).income, 1000);
  assert.equal(statistics.points.at(-1).mean3, 500);
  assert.equal(statistics.points.at(-1).mean6, 350);
  const august = statistics.points.find(p => p.month === '2026-08');
  assert.equal(august.baseline, 200);
  assert.equal(august.lower, 0);
  assert.equal(august.upper, 400, 'prior [100, 200, 300] sample deviation = 100; current month excluded');
  assert.equal(statistics.points.find(p => p.month === '2026-07').baseline, null);
});

test('gaps reset rolling windows and suppress a fan; credit-only observed months retain true zero spending', () => {
  const transactions = rows().filter(row => !row.date.startsWith('2026-08'));
  const statistics = build({ transactions, startBalance: 0 });
  assert.equal(statistics.points.find(p => p.month === '2026-08').spend, null);
  assert.equal(statistics.points.at(-1).mean3, null);
  assert.equal(statistics.points.at(-1).mean6, null);
  assert.match(statistics.fan.reason, /each of the last 6/);
  const zero = build({ transactions: [tx(10, 1000, 'CREDIT')] });
  assert.equal(zero.points.at(-1).spend, 0);
  assert.equal(zero.points.at(-1).income, 1000);
  assert.match(zero.fan.reason, /starting cash balance/);
});

test('fan enumerates empirical resamples deterministically with ordered widening quantiles and shared surplus', () => {
  const options = { transactions: rows(), startBalance: 0, monthlyNet: -100 };
  const first = build(options).fan, second = build(options).fan;
  assert.deepEqual(first, second);
  assert.equal(first.reason, null);
  assert.equal(first.points.length, 7);
  assert.equal(first.points[0].median, 0);
  assert.equal(first.points[1].median, -100);
  assert.equal(first.points[1].p10, -300);
  assert.equal(first.points[1].p90, 100);
  assert.equal(first.points.at(-1).median, -600);
  assert.equal(first.points.at(-1).month, '2027-05');
  for (const p of first.points) assert.ok(p.p10 <= p.p25 && p.p25 <= p.median && p.median <= p.p75 && p.p75 <= p.p90);
  assert.ok(first.points.at(-1).p90 - first.points.at(-1).p10 > first.points[1].p90 - first.points[1].p10);
  const analytics = buildAnalytics({ today, transactions: rows(), latestBalance: 500, typical: { monthlySurplus: 100, monthsUsed: 3 } });
  assert.equal(analytics.statistics.fan.points.at(-1).median, 1100, 'same central surplus as other planning surfaces');
});

test('flat histories have an honest zero-width range; unrecorded and invalid balances do not produce modeled outcomes', () => {
  const transactions = [5, 6, 7, 8, 9, 10].flatMap(month => [tx(month, 500), tx(month, 1000, 'CREDIT')]);
  const fan = build({ transactions, startBalance: 0, monthlyNet: 0 }).fan;
  assert.equal(fan.reason, null);
  assert.ok(fan.points.every(p => p.p10 === 0 && p.p90 === 0 && p.median === 0));
  for (const startBalance of [null, undefined, '', 'not-a-balance']) {
    assert.equal(build({ transactions, startBalance }).fan.points.length, 0);
  }
});

test('per-account balance samples retain signed/zero values, sampled ranges, same-day convention and peak drawdowns', () => {
  const accounts = [
    { id: 1, name: 'Checking', kind: 'checking', status: 'active' },
    { id: 2, name: 'Savings', kind: 'savings', status: 'active' },
    { id: 3, name: 'Card', kind: 'credit_card', status: 'active' },
    { id: 4, name: 'Review', kind: 'checking', status: 'needs_review' }
  ];
  const balance = (id, date, value, extra = {}) => ({ id, date, balance: value, account_id: 1, ...extra });
  const balances = [
    balance(1, '2026-09-01', 100), balance(2, '2026-09-15', 200), balance(3, '2026-09-30', 50),
    balance(4, '2026-10-01', 0), balance(5, '2026-10-02', -100), balance(6, '2026-10-02', -50),
    balance(7, '2026-10-03', 300), balance(8, '2026-10-03', 999, { is_pending: true }),
    balance(9, '2026-12-01', 9999), balance(10, '2026-10-04', 999, { account_id: null }),
    balance(11, '2026-10-04', 9000, { account_id: 2 }), balance(12, '2026-10-05', 999, { account_id: 3 }),
    balance(13, '2026-10-06', 999, { account_id: 4 }), balance(14, '2026-10-07', null),
    balance(15, '2026-10-08', 'bad'), balance(16, '2025-01-01', 90000)
  ];
  const result = build({ accounts, balances }).balances;
  assert.equal(result.length, 2);
  const checking = result[0];
  assert.deepEqual(checking.points.map(p => p.balance), [100, 200, 50, 0, -50, 300]);
  assert.deepEqual(checking.points.map(p => p.drawdown), [0, 0, -150, -200, -250, 0]);
  assert.equal(checking.maxDrawdown, -250);
  assert.deepEqual(checking.candles[0], { month: '2026-09', open: 100, close: 50, high: 200, low: 50, from: '2026-09-01', to: '2026-09-30', observations: 3 });
  assert.equal(checking.candles[1].low, -50);
  assert.equal(result[1].points[0].balance, 9000, 'different accounts never add into an invented household series');
  assert.equal(result[1].candles.length, 0, 'one observation cannot create a candle');
});

test('statistics windows stay fixed when callers supply a shorter selected date range', () => {
  const options = { transactions: rows(), startBalance: 500, monthlyNet: 100 };
  const full = build(options);
  const short = build({ ...options, from: '2026-10', to: '2026-10', months: 1 });
  assert.deepEqual(short, full);
  assert.equal(short.points.length, 12);
  assert.equal(short.points[0].month, '2025-11');
  assert.equal(short.points.at(-1).month, '2026-10');
  assert.equal(short.fan.trainingMonths.length, 6);
});
