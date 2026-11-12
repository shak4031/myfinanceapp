import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildAnalyticsStatistics } from '../backend/utils/analyticsStatistics.js';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
function fixture() {
  const context = {
    Intl, console, document: { addEventListener() {} },
    FinancePro: { ICONS: { check: '' }, format: { esc: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]),
      money: v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) } }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source('pro-charts.js'), context);
  vm.runInContext(source('analytics.js').replace(/\}\)\(\);\s*$/, 'window.testCards = { forecastCard, cashflowCard, trendCard, statisticsCard, balanceHistoryCard, recurringCard, anomaliesCard }; })();'), context);
  return context;
}

test('market charts retain signed values, exact cents and a visible zero reference', () => {
  const { market } = fixture().ProCharts;
  const html = market({
    series: [{ name: 'Balance', points: [{ x: 0, v: 8080 }, { x: 1, v: 0 }, { x: 2, v: -12098.37 }], area: true, dashed: true, endpoint: true, tone: 'rose' }],
    xMax: 2, pointLabel: x => `Month ${x}`, xTicks: [{ x: 0, label: 'Now' }]
  });
  assert.match(html, /class="market-zero"/);
  assert.match(html, /class="market-line is-projected"/);
  assert.match(html, /-\$12,098\.37/);
  assert.match(html, /Balance: \$0\.00/);
  assert.match(html, /fill="url\(#market-\d+-fill-0\)"/);
  assert.equal((html.match(/class="market-inspect"/g) || []).length, 3);
  assert.match(html, /tabindex="0" role="img" aria-label="Month 2\. Balance: -\$12,098\.37"/);
  assert.match(html, /<summary>Exact chart values<\/summary>/);
  assert.match(html, /<th scope="row">Month 2<\/th><td>-\$12,098\.37<\/td>/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('market charts do not interpolate missing history and use unique escaped SVG resources', () => {
  const { market } = fixture().ProCharts;
  const options = { series: [{ name: '<Income>', tone: 'green', points: [{ x: 0, v: 0 }, { x: 1, v: null }, { x: 2, v: 10.01 }], area: true }], xMax: 2, label: '<Chart>', pointLabel: x => `Month <${x}>` };
  const first = market(options), second = market(options);
  assert.equal((first.match(/class="market-line"/g) || []).length, 2, 'missing values break the line');
  assert.match(first, /&lt;Income&gt;/);
  assert.match(first, /&lt;Chart&gt;/);
  assert.match(first, /Month &lt;2&gt;/);
  assert.doesNotMatch(first, /<Income>|<Chart>|Month <2>/);
  assert.notEqual(first.match(/id="(market-\d+-title)"/)[1], second.match(/id="(market-\d+-title)"/)[1]);
  assert.match(market({ series: [], xMax: 0 }), /No recorded values available/);
  assert.doesNotMatch(market({ series: [{ points: [{ x: 0, v: 0 }], type: 'bars' }], xMax: 0 }), /NaN|Infinity/);
});

test('forecast marks the actual-to-estimate boundary and keeps the supplied projection endpoints only', () => {
  const { testCards } = fixture();
  const html = testCards.forecastCard({ forecast: { daysInMonth: 30, paceCurrent: [0, 100, 250], paceLast: [0, 200, 400, 500], projected: 1800, lastMonth: 2000, mtd: 250, remainingFixed: 900, remainingVariable: 650 } });
  assert.match(html, /span-3 pro-market/);
  assert.match(html, /ESTIMATE STARTS/);
  assert.match(html, /Day 3\. Last month: \$400\.00\. This month: \$250\.00\. Projection: \$250\.00/);
  assert.match(html, /Day 30\. Projection: \$1,800\.00/);
  assert.equal((html.match(/class="market-inspect"/g) || []).length, 5, 'no invented daily forecast samples');
  assert.match(html, /Pacing \$200\.00 below last month/);
});

test('cash-flow possibilities render nested model ranges instead of the old straight-line chart', () => {
  const { testCards } = fixture();
  const statistics = buildAnalyticsStatistics({ today: new Date(2026, 10, 11), startBalance: 8080, monthlyNet: -3363,
    transactions: [5, 6, 7, 8, 9, 10].flatMap((month, i) => [
      { date: `2026-${String(month).padStart(2, '0')}-10`, amount: 100 + i * 100, direction: 'DEBIT' },
      { date: `2026-${String(month).padStart(2, '0')}-10`, amount: 1000, direction: 'CREDIT' }
    ]) });
  const html = testCards.cashflowCard({ statistics });
  assert.match(html, /span-3 pro-market/);
  assert.match(html, /viewBox="0 0 1000 320"/);
  assert.match(html, /Cash-flow possibilities/);
  assert.match(html, /Model ranges, not guarantees/);
  assert.match(html, /Median scenario: -\$12,098\.00/);
  assert.match(html, /class="market-zero"/);
  assert.match(html, /class="market-line is-projected"/);
  assert.equal((html.match(/class="market-band"/g) || []).length, 2);
  assert.match(html, /10th percentile/);
  assert.match(html, /not a promised probability/);
  assert.match(html, /2026-05, 2026-06, 2026-07, 2026-08, 2026-09, 2026-10/);
  const unavailable = testCards.cashflowCard({});
  assert.match(unavailable, /six completed months/);
  assert.match(unavailable, /pro-card panel span-3/);
  assert.doesNotMatch(html, /NaN|Infinity|6-month cash flow/);
});

test('monthly trend has real spending bars, income and a correctly delayed three-month average', () => {
  const { testCards } = fixture();
  const html = testCards.trendCard({ months: ['2026-08', '2026-09', '2026-10', '2026-11'], series: { spend: [100, 200, 300, 600], income: [400, 500, 600, 700] } });
  assert.match(html, /span-3 pro-market/);
  assert.match(html, /viewBox="0 0 1000 320"/);
  assert.equal((html.match(/class="market-volume"/g) || []).length, 4);
  assert.match(html, /2026-08\. Spending: \$100\.00\. Income: \$400\.00/);
  assert.match(html, /2026-10\. Spending: \$300\.00\. 3-month average: \$200\.00\. Income: \$600\.00/);
  assert.match(html, /2026-11\. Spending: \$600\.00\. 3-month average: \$366\.67\. Income: \$700\.00/);
  assert.match(html, /<th scope="row">2026-08<\/th><td>\$100\.00<\/td><td>&mdash;<\/td><td>\$400\.00<\/td>/);
});

test('market charts use full content width with a readable scrolling canvas on smaller screens', () => {
  const css = source('analytics.css');
  assert.match(css, /#analytics-view \{ max-width: none; \}/);
  assert.match(css, /\.pro-card\.span-3 \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /\.pro-market \.pro-chart-scroll \.pro-market-chart \{ min-width: 1000px; \}/);
});

test('statistical charts render prior-only volatility bands, gap-aware averages and transparent insufficient-history states', () => {
  const { testCards } = fixture();
  const statistics = buildAnalyticsStatistics({ today: new Date(2026, 10, 11), transactions: [5, 6, 7, 8, 9, 10].map((month, i) =>
    ({ date: `2026-${String(month).padStart(2, '0')}-10`, amount: 100 + i * 100, direction: 'DEBIT' })) });
  const bands = testCards.statisticsCard({ statistics }, 'volatility');
  assert.match(bands, /class="market-band"/);
  assert.match(bands, /2026-08\. Lower band: \$0\.00\. Upper band: \$400\.00\. Prior average: \$200\.00\. Recorded spending: \$400\.00/);
  assert.match(bands, /excluding the month being compared/);
  const momentum = testCards.statisticsCard({ statistics }, 'momentum');
  assert.match(momentum, /2026-10\. Recorded spending: \$600\.00\. 3-month average: \$500\.00\. 6-month average: \$350\.00/);
  assert.match(momentum, /Missing months remain gaps, not zeros/);
  assert.match(testCards.statisticsCard({}, 'volatility'), /Import at least three consecutive/);
});

test('recorded balance candles show real sampled ranges and dollar drawdown for one account at a time', () => {
  const { testCards } = fixture();
  const statistics = buildAnalyticsStatistics({ today: new Date(2026, 10, 11),
    accounts: [{ id: 1, name: '<Checking>', kind: 'checking', status: 'active' }, { id: 2, name: 'Savings', kind: 'savings', status: 'active' }],
    balances: [
      { id: 1, account_id: 1, date: '2026-08-01', balance: 100 },
      { id: 2, account_id: 1, date: '2026-08-10', balance: 200 },
      { id: 3, account_id: 1, date: '2026-08-20', balance: 50 },
      { id: 4, account_id: 1, date: '2026-09-01', balance: 0 },
      { id: 5, account_id: 1, date: '2026-09-20', balance: -100 }
    ] });
  const html = testCards.balanceHistoryCard({ statistics, asOf: '2026-11-11' });
  assert.equal((html.match(/class="market-candle"/g) || []).length, 2);
  assert.match(html, /2026-08\. First observed close: \$100\.00\. Observed high: \$200\.00\. Observed low: \$50\.00\. Last observed close: \$50\.00/);
  assert.match(html, /2026-09-20\. Below observed peak: -\$300\.00/);
  assert.match(html, /over 45 days old/);
  assert.match(html, /&lt;Checking&gt;/);
  assert.doesNotMatch(html, /<Checking>|NaN|Infinity/);
  assert.match(html, /id="market-balance-account"/);
  assert.match(html, /not market-price candles/);
  const insufficient = testCards.balanceHistoryCard({ statistics: { balances: [{ id: 1, name: 'Checking', points: [], candles: [] }] } });
  assert.match(insufficient, /At least two dated balance samples/);
  assert.doesNotMatch(insufficient, /market-candle/);
});

test('final overview rows pair small merchants with large recurring and large anomalies with small weekly rhythm', () => {
  const script = source('analytics.js'), css = source('analytics.css');
  assert.match(script, /\$\{merchantsCard\(a\)\}\$\{recurringCard\(a\)\}\$\{anomaliesCard\(a\)\}\$\{weekdayCard\(a\)\}/);
  const { testCards } = fixture();
  assert.match(testCards.recurringCard({ recurring: [] }), /id="recurring-payment-card" class="span-2"/);
  assert.match(testCards.anomaliesCard({ anomalies: [] }), /pro-card panel span-2/);
  assert.match(css, /\.pro-grid > section\.span-2 \{ grid-column: span 2/);
  assert.match(css, /\.pro-grid > section\.span-2 \{ grid-column: 1 \/ -1/);
});

test('fixed-history notices explain filter exceptions even when statistical charts cannot yet render', () => {
  const { testCards } = fixture();
  for (const html of [
    testCards.cashflowCard({}), testCards.statisticsCard({}, 'volatility'),
    testCards.statisticsCard({}, 'momentum'), testCards.balanceHistoryCard({})
  ]) {
    assert.match(html, /class="chart-history-note"/);
    assert.match(html, /Date filters do not apply to this chart/);
    assert.match(html, /a shorter filter never shortens the required history/);
  }
  assert.match(testCards.cashflowCard({}), /Fixed history: last 6 completed months/);
  assert.match(testCards.statisticsCard({}, 'volatility'), /Fixed history: last 12 completed months/);
  assert.match(testCards.balanceHistoryCard({}), /Fixed history: last 12 calendar months through today/);
});
