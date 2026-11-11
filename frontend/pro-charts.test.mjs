import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
function fixture() {
  const context = {
    Intl, console, document: { addEventListener() {} },
    FinancePro: { format: { money: v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) } }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source('pro-charts.js'), context);
  vm.runInContext(source('analytics.js').replace(/\}\)\(\);\s*$/, 'window.testCards = { forecastCard, cashflowCard, trendCard }; })();'), context);
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

test('cash-flow scenario keeps negative endpoints, baseline and surplus, with an explicit unavailable state', () => {
  const { testCards } = fixture();
  const cashflow = { startBalance: 8080, basis: 'typical-surplus', monthsUsed: 3,
    months: Array.from({ length: 6 }, (_, i) => ({ month: `2027-0${i + 1}`, balance: 8080 - 3363 * (i + 1), net: -3363 })) };
  const html = testCards.cashflowCard({ cashflow });
  assert.match(html, /span-3 pro-market/);
  assert.match(html, /viewBox="0 0 1000 320"/);
  assert.match(html, /Scenario, not a guarantee/);
  assert.match(html, /2027-06 estimate\. Estimated balance: -\$12,098\.00/);
  assert.match(html, /class="market-zero"/);
  assert.match(html, /class="market-line is-projected"/);
  assert.match(html, /-\$3,363\.00/);
  const unavailable = testCards.cashflowCard({ cashflow: { startBalance: null } });
  assert.match(unavailable, /Import a statement with a running balance/);
  assert.match(unavailable, /pro-card panel span-3/);
  const zero = testCards.cashflowCard({ cashflow: { ...cashflow, startBalance: 0, months: [{ month: '2027-01', balance: 0, net: 0 }] } });
  assert.match(zero, /Estimated balance: \$0\.00/);
  assert.doesNotMatch(zero, /NaN|Infinity/);
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
