import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const context = { FinancePro: { format: { esc, money: value => `$${Number(value).toFixed(2)}` } } };
vm.runInNewContext(readFileSync(new URL('money-visuals.js', import.meta.url), 'utf8'), context);
const { mosaic, signalNetwork, signalEvidence, monthlyLandscape, monthlyHeatmap } = context.FinanceMoneyVisuals;

test('mosaic areas represent exact proportions and retain small merchants and escaped details', () => {
  const html = mosaic([{ name: '<Big>', value: 75, detail: '3 payments' }, { name: 'Small', value: 25 }, { name: 'Empty', value: 0 }]);
  assert.match(html, /width:75%;height:100%/);
  assert.match(html, /width:25%;height:100%/);
  assert.match(html, /&lt;Big&gt;/);
  assert.doesNotMatch(html, /<Big>|NaN|undefined|Empty/);
  assert.match(html, /tabindex="0" role="img"/);
  assert.match(html, /Exact totals and trends/);
  assert.match(html, /75\.0% of displayed spending/);
  assert.match(mosaic([]), /No spending/);
});

test('mosaic does not drop tiny merchants and every rectangle contributes its proportional area', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ name: `Merchant ${i}`, value: i + 1 }));
  const html = mosaic(items);
  const rectangles = [...html.matchAll(/left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%/g)];
  assert.equal(rectangles.length, 60);
  let area = 0;
  for (const [, x, y, w, h] of rectangles) {
    assert.ok(Number(x) >= 0 && Number(y) >= 0 && Number(x) + Number(w) <= 100.000001 && Number(y) + Number(h) <= 100.000001);
    area += Number(w) * Number(h);
  }
  assert.ok(Math.abs(area - 10000) < 0.00001);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('signal network shows only active warning categories and connections', () => {
  const html = signalNetwork([{ label: 'Dining & coffee', monthly: 240, signals: ['a', 'b'] },
    { label: 'Gas', monthly: 70, signals: ['c'] }, { label: 'Clear category', monthly: 50, signals: [] }],
  { a: 'Above similar homes', b: 'Trending up', c: 'Unusual latest month' });
  assert.equal((html.match(/<path /g) || []).length, 3);
  assert.match(html, /Dining &amp; coffee/);
  assert.match(html, /\$240\.00/);
  assert.match(html, /2 warning signals/);
  assert.doesNotMatch(html, /Clear category|money-chain-status|money-signal-edge is-within-range|money-signal-edge is-needs-history/);
  assert.doesNotMatch(html, /NaN|undefined/);
  assert.match(html, /not money transfers/);
  assert.match(signalNetwork([], {}), /No category/);
  const calm = signalNetwork([{ label: 'Clear category', monthly: 50, signals: [] }],
    { a: 'Above similar homes', b: 'Trending up', c: 'Unusual latest month' });
  assert.doesNotMatch(calm, /Clear category|<path |NaN|undefined/);
  assert.match(calm, /No categories have active warning signals/);
});

test('signal evidence includes exact benchmark deltas and distinguishes unsupported history from calm data', () => {
  const category = { label: 'Dining', monthly: 450, expected: 300, signals: ['a'], series: [400, 450, 500],
    range: { month: 'Oct 2026', latest: 500, compared: 2, priorMedian: 425, spikeThreshold: 447.5 } };
  const [benchmark, trend, unusual] = signalEvidence(category, { selectedRange: true });
  assert.equal(benchmark.status, 'warning');
  assert.match(benchmark.comparison, /Similar homes \$300\.00\/mo; difference \+\$150\.00 \(\+50\.0%\)/);
  assert.match(benchmark.rule, /Selected-period/);
  assert.equal(trend.status, 'needs-history');
  assert.match(trend.comparison, /3 completed months.*At least 6 months/);
  assert.equal(unusual.status, 'needs-history');
  assert.match(unusual.comparison, /Prior-month median \$425\.00; difference \+\$75\.00/);
  assert.match(unusual.comparison, /Only 2 prior months/);
  const calm = signalEvidence({ ...category, series: Array(12).fill(400),
    crossover: { fast: 400, slow: 395, slowMonths: 12, state: 'flat' },
    momentum: { basis: 'monthly-trend', change: 0.02, confirmed: true },
    range: { ...category.range, compared: 11 },
    band: { lower: 300, upper: 510, latest: 500, center: 405, position: 'inside' }
  });
  assert.equal(calm[1].status, 'within-range');
  assert.match(calm[1].comparison, /average \$400\.00 versus 12-month average \$395\.00/);
  assert.match(calm[1].comparison, /\+2\.0% per month/);
  assert.equal(calm[2].status, 'within-range');
  assert.match(calm[2].comparison, /band \$300\.00 to \$510\.00/);
});

test('seasonal and unconfirmed trend evidence is not mislabeled as a warning', () => {
  const category = { monthly: 100, expected: 90, signals: [], seasonal: true, series: Array(12).fill(100),
    crossover: { fast: 100, slow: 80, slowMonths: 12, seasonal: true } };
  const trend = signalEvidence(category)[1];
  assert.equal(trend.status, 'needs-history');
  assert.match(trend.comparison, /seasonal; not used alone/);
  const unconfirmed = signalEvidence({ ...category, momentum: { basis: 'year-over-year', change: 0.4, lastYear: 71.43, confirmed: false } })[1];
  assert.equal(unconfirmed.status, 'within-range');
  assert.match(unconfirmed.comparison, /not confirmed by the recent trend/);
});

test('monthly terrain retains every row and month with baselines, deltas and selectable exact readings', () => {
  const html = monthlyLandscape({ months: ['Aug 2026', 'Sep 2026', 'Oct 2026'], rows: [
    { label: 'Dining <out>', values: [100, 200, 300] }, { label: 'Utilities', values: [40, 40, 40], fixed: true }
  ] });
  assert.equal((html.match(/class="money-terrain-lane"/g) || []).length, 3);
  assert.equal((html.match(/data-money-reading="/g) || []).length, 3);
  assert.match(html, /Highest-spend month<\/span><b>Oct 2026/);
  assert.match(html, /Lowest-spend month<\/span><b>Aug 2026/);
  assert.match(html, /Dining &lt;out&gt;/);
  assert.match(html, /usual \$200\.00; difference \+\$100\.00 \(\+50\.0%\)/);
  assert.match(html, /Aug 2026: \$100\.00; usual \$200\.00; difference -\$100\.00 \(-50\.0%\)/);
  assert.match(html, /own vertical scale/);
  assert.match(html, /missing imports/);
  assert.match(html, /Coral areas:<\/b> more spending than usual/);
  assert.match(html, /Teal areas:<\/b> less spending than usual/);
  assert.match(html, /class="money-node-value">Fixed payments<\/text>/);
  assert.match(html, /Select any dot or month below/);
  assert.doesNotMatch(html, /Utilities \*|Warm peaks =|\* Fixed payments/);
  assert.doesNotMatch(html, /<table|NaN|Infinity|undefined/);
});

test('single-month and zero-baseline terrain stay finite and state the mean fallback', () => {
  for (const values of [[0], [75], [0, 0, 90], [0, 0, 0]]) {
    const html = monthlyLandscape({ months: values.map((_, i) => `Month ${i + 1}`), rows: [{ label: 'Sparse', values }] });
    assert.doesNotMatch(html, /NaN|Infinity|undefined/);
    if (values.length > 1 && values.some(Boolean)) assert.match(html, /Usual \$30\.00 \(mean\)/);
    if (values.every(value => !value)) assert.match(html, /percentage unavailable: zero baseline/);
  }
  assert.match(monthlyLandscape(null), /No monthly spending/);
});

test('network and terrain selection works with pointer and keyboard without navigation', () => {
  const listeners = new Map(), choices = [], readings = [];
  for (let i = 0; i < 3; i++) {
    choices.push({ dataset: { moneyChoice: String(i) }, setAttribute(name, value) { this[name] = value; } });
    readings.push({ dataset: { moneyReading: String(i) }, hidden: i !== 0 });
  }
  const explorer = { querySelectorAll: selector => selector === '[data-money-choice]' ? choices : readings, querySelector: () => null };
  choices.forEach(node => { node.closest = () => explorer; });
  const runtime = { FinancePro: context.FinancePro, document: { addEventListener: (name, listener) => listeners.set(name, listener) } };
  vm.runInNewContext(readFileSync(new URL('money-visuals.js', import.meta.url), 'utf8'), runtime);
  listeners.get('click')({ target: { closest: selector => selector === '[data-money-choice]' ? choices[2] : null } });
  assert.deepEqual(readings.map(node => node.hidden), [true, true, false]);
  assert.equal(choices[2]['aria-pressed'], 'true');
  let prevented = false;
  listeners.get('keydown')({ key: 'Enter', target: { closest: selector => selector === 'g[data-money-choice]' ? choices[1] : null }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(readings.map(node => node.hidden), [true, false, true]);
});

test('transaction chain groups counted payments and excluded one-offs by month with safe transaction links', () => {
  const html = signalNetwork([{ label: 'Dining', monthly: 100, signals: ['a'], transactions: [
    { id: 12, date: '2026-10-03', category: 'Restaurants', description: '<Cafe>', amount: 40, excludedFromSignals: false },
    { id: 13, date: '2026-10-04', category: 'Dining', description: 'Banquet', amount: 500, excludedFromSignals: true },
    { id: 14, date: '2026-09-04', category: 'Dining', description: 'Dinner', amount: 25, excludedFromSignals: false }
  ] }], { a: 'Above similar homes', b: 'Trending up', c: 'Unusual latest month' });
  assert.match(html, /Expand transactions \(3\)/);
  assert.match(html, /2026-10 &#183; \$40\.00 counted &#183; 2 payments &#183; \$500\.00 one-offs excluded/);
  assert.match(html, /href="#transactions\/12">&lt;Cafe&gt;/);
  assert.match(html, /2026-09 &#183; \$25\.00 counted/);
  assert.match(html, /data-money-branch="a" aria-expanded="true"/);
  assert.doesNotMatch(html, /money-chain-controls|data-money-focus|data-money-reset/);
  assert.equal((html.match(/data-money-branch=/g) || []).length, 3);
});

test('diagram signal buttons independently hide and restore trees with click and keyboard', () => {
  const listeners = {};
  vm.runInNewContext(readFileSync(new URL('money-visuals.js', import.meta.url), 'utf8'), {
    document: { addEventListener: (name, handler) => { listeners[name] = handler; } }
  });
  const edges = ['a', 'b', 'c'].map(key => ({ dataset: { moneyEdge: key }, style: {} }));
  const nodes = ['a', 'ab', 'c'].map((signals, index) => ({
    dataset: { moneySignals: signals, moneyChoice: String(index) }, style: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; }
  }));
  const readings = nodes.map(node => ({ dataset: { moneyReading: node.dataset.moneyChoice }, hidden: false }));
  const buttons = ['a', 'b', 'c'].map(key => ({
    dataset: { moneyBranch: key }, tagName: 'g', attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    closest() { return explorer; }
  }));
  const status = {};
  const explorer = {
    dataset: {},
    querySelector: () => status,
    querySelectorAll: selector => selector === '[data-money-edge]' ? edges
      : selector === '[data-money-branch]' ? buttons : selector === '[data-money-reading]' ? readings : nodes
  };
  const event = index => ({ target: { closest: () => buttons[index] } });
  listeners.click(event(0));
  assert.equal(edges[0].style.display, 'none');
  assert.equal(edges[1].style.display, '');
  assert.equal(buttons[0].attributes['aria-expanded'], 'false');
  assert.equal(nodes[0].style.display, 'none', 'category with only the hidden signal disappears');
  assert.equal(nodes[1].style.display, '', 'category connected to another visible signal remains');
  assert.equal(readings[0].hidden, true, 'details for disconnected categories are hidden');
  listeners.click(event(0));
  assert.equal(edges[0].style.display, '');
  assert.equal(buttons[0].attributes['aria-expanded'], 'true');
  let prevented = false;
  listeners.keydown({ ...event(1), key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(edges[1].style.display, 'none');
  listeners.keydown({ ...event(1), key: ' ', preventDefault() {} });
  assert.equal(edges[1].style.display, '');
  for (let i = 0; i < 3; i++) listeners.click(event(i));
  assert.equal(nodes[0].style.display, 'none');
  listeners.click(event(2));
  assert.equal(nodes[0].style.display, 'none');
  assert.equal(nodes[2].style.display, '');
});

test('monthly heatmap preserves every category and month with exact totals and relative color bands', () => {
  const html = monthlyHeatmap({ months: ['Jan', 'Feb', 'Mar', 'Apr', 'May'], rows: [
    { label: 'Dining <out>', values: [20, 70, 100, 140, 200] },
    { label: 'Utilities', values: [40, 40, 40, 40, 40], fixed: true }
  ] });
  assert.equal((html.match(/class="money-heat-cell /g) || []).length, 10);
  for (const level of ['much-lower', 'lower', 'usual', 'higher', 'much-higher']) assert.match(html, new RegExp(`is-${level}"`));
  assert.match(html, /Dining &lt;out&gt;/);
  assert.match(html, /Dining &lt;out&gt;, May: \$200\.00; usual \$100\.00; difference \+\$100\.00 \(\+100\.0%\)/);
  assert.match(html, /Fixed payments/);
  assert.match(html, /missing imports/i);
  assert.match(html, /scope="row"/);
  assert.match(html, /scope="col"/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
  for (const values of [[0], [75], [0, 0, 90], [0, 0, 0]]) {
    const sparse = monthlyHeatmap({ months: values.map((_, i) => `Month ${i}`), rows: [{ label: 'Sparse', values }] });
    assert.doesNotMatch(sparse, /NaN|Infinity|undefined/);
    if (values.every(value => !value)) assert.match(sparse, /No baseline/);
  }
  assert.match(monthlyHeatmap(null), /No monthly spending/);
});
