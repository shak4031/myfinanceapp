import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('pro-dashboard.js', import.meta.url), 'utf8');
const money = value => `$${Number(value).toFixed(2)}`;
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function render(category, { insights = 'on', active = true } = {}) {
  const listeners = new Map(), cardMarkup = [], bodyMarkup = [], headMarkup = [];
  const insert = target => (position, html) => target.push(html);
  const body = { insertAdjacentHTML: insert(bodyMarkup) };
  const card = { dataset: { category: category.name }, querySelector: () => body, insertAdjacentHTML: insert(cardMarkup) };
  const grid = { hidden: false };
  let removed = 0;
  const section = {
    isConnected: true,
    querySelector: selector => selector === '.mtd-grid' ? grid : { insertAdjacentHTML: insert(headMarkup) },
    querySelectorAll: selector => selector === '.pro-added' ? [{ remove() { removed++; } }] : [card]
  };
  const pro = {
    ensureEntitlement: async () => {}, isActive: () => active,
    prefs: { get: key => key === 'dash.insights' ? insights : 'cards' },
    format: { money, esc }, proSwitch: () => '', ICONS: { lock: '' },
    getAnalytics: async () => ({
      categories: [category], kpis: { mtdSpend: category.mtd, mtdDelta: 0 }, forecast: {}
    })
  };
  const context = {
    document: { getElementById: () => section, addEventListener: (name, callback) => listeners.set(name, callback) },
    FinancePro: pro
  };
  vm.runInNewContext(source, context);
  await listeners.get('mtd:rendered')({ detail: { categories: [category] } });
  return { card: cardMarkup.join(''), body: bodyMarkup.join(''), head: headMarkup.join(''), removed };
}

for (const [spent, expected, state, height] of [
  [25.5, '$74.50 left', 'ok', '25.5'],
  [100, 'Budget reached', 'ok', '100.0'],
  [140.25, '$40.25 over budget', 'over', '100.0'],
  [0, '$100.00 left', 'ok', '0.0']
]) {
  test(`spending card renders a concise ${state} budget at ${spent}`, async () => {
    const result = await render({ name: 'Dining', mtd: spent, budget: 100, projected: spent, budgetStatus: state });
    assert.ok(result.body.includes(expected));
    assert.match(result.card, /role="meter"/);
    assert.match(result.card, /aria-label="Dining monthly budget"/);
    assert.ok(result.card.includes(`aria-valuenow="${Math.min(100, spent)}"`));
    assert.ok(result.card.includes(`height:${height}%`));
    assert.ok(result.card.includes(`is-${state}`));
    assert.ok(result.card.includes(`${money(spent)} spent of $100.00 monthly budget`));
    assert.doesNotMatch(result.body, /pro-delta|pro-budget-meta|%|vs last month/);
    assert.equal(result.removed, 1);
  });
}

test('forecast risk stays distinct and category labels are escaped in meter attributes', async () => {
  const result = await render({ name: 'Food & "drink"', mtd: 75, budget: 100, projected: 150, budgetStatus: 'risk' });
  assert.match(result.body, /is-risk.*\$25.00 left/);
  assert.match(result.card, /Food &amp; &quot;drink&quot; monthly budget/);
  assert.match(result.card, /Projected month-end: \$150.00/);
});

test('unbudgeted categories do not acquire a misleading empty meter', async () => {
  for (const budget of [null, 0, -1, 'invalid']) {
    const result = await render({ name: 'Travel', mtd: 25, budget });
    assert.equal(result.card, '');
    assert.equal(result.body, '');
  }
});

test('turning analytics off or using a free plan removes enhancements without budget fetches', async () => {
  for (const settings of [{ insights: 'off' }, { active: false }]) {
    const result = await render({ name: 'Travel', mtd: 25, budget: 100 }, settings);
    assert.equal(result.card, '');
    assert.equal(result.body, '');
    assert.equal(result.removed, 1);
    assert.doesNotMatch(result.head, /pro-summary/);
  }
});

test('spending cards retain category drill-down hooks and readable spent context', () => {
  const html = readFileSync(new URL('index.html', import.meta.url), 'utf8');
  assert.match(html, /class="metric-card list-item mtd-category-card" data-category=/);
  assert.match(html, /onclick="window\.openCategoryTransactions\(this\.dataset\.category, this\.dataset\.month\)"/);
  assert.match(html, /<small>spent this month<\/small>/);
});
