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
    ensureEntitlement: async () => {}, isActive: () => active, isPlusActive: () => active,
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

test('turning analytics off or using Basic removes enhancements without budget fetches', async () => {
  for (const settings of [{ insights: 'off' }, { active: false }]) {
    const result = await render({ name: 'Travel', mtd: 25, budget: 100 }, settings);
    assert.equal(result.card, '');
    assert.equal(result.body, '');
    assert.equal(result.removed, 1);
    assert.doesNotMatch(result.head, /pro-summary/);
  }
});

test('pie view renders a selectable 3D pie with an overview panel, linked legend and grouped small categories', async () => {
  const listeners = new Map(), inserted = [];
  const grid = { hidden: false, insertAdjacentHTML: (position, html) => inserted.push(html) };
  const legend = { innerHTML: '' }, slot = { innerHTML: '' };
  const node = (index, kind) => {
    const classes = new Set([kind]), attrs = { 'aria-label': `Cat ${index}` };
    return { dataset: { pieIndex: String(index) }, classes, attrs, getAttribute: name => attrs[name], setAttribute: (name, value) => { attrs[name] = value; },
      classList: { contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } };
  };
  const nodes = Array.from({ length: 9 }, (_, i) => [node(i, 'pie3d-top'), node(i, 'pie3d-flag')]).flat();
  const root = { querySelector: selector => selector === '.pro-pie-legend' ? legend : selector === '.pie-detail-slot' ? slot : null,
    querySelectorAll: selector => selector === '.pie3d [data-pie-index]' ? nodes : [] };
  const section = { isConnected: true, querySelector: selector => selector === '.mtd-grid' ? grid : selector === '.pro-pie' ? root : { insertAdjacentHTML() {} }, querySelectorAll: () => [] };
  const context = {
    document: { getElementById: () => section, addEventListener: (name, callback) => listeners.set(name, callback) },
    window: {},
    FinancePro: { ensureEntitlement: async () => {}, isPlusActive: () => true, prefs: { get: key => key === 'dash.view' ? 'pie' : 'off' },
      format: { money, esc }, proSwitch: () => '', ICONS: { lock: '' },
      getAnalytics: async () => ({ categories: [
        { name: 'Cat 0', budget: 100, mtd: 110, budgetStatus: 'over' },
        { name: 'Cat 1', budget: 120, mtd: 100, budgetStatus: 'risk' },
        { name: 'Cat 2', budget: 500, mtd: 90, budgetStatus: 'ok' },
        { name: 'Cat 10', budget: 5, mtd: 10, budgetStatus: 'over' }] }) }
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('pro-charts.js', import.meta.url), 'utf8'), context);
  context.ProCharts = context.window.ProCharts;
  vm.runInContext(source, context);
  const categories = Array.from({ length: 11 }, (_, i) => ({ name: `Cat ${i}`, totalSpending: 110 - i * 10, transactionCount: 2 }));
  await listeners.get('mtd:rendered')({ detail: { categories } });
  const html = inserted.join('');
  assert.equal(grid.hidden, true);
  assert.equal((html.match(/class="pie3d-top"/g) || []).length, 9, 'eight categories plus one grouped slice');
  assert.equal((html.match(/data-pie-select="/g) || []).length, 9);
  assert.match(html, /3 more/);
  assert.match(html, /Spent this month<\/span><strong class="pie-detail-amount">\$660\.00/);
  assert.match(html, /11 categories &middot; most on <b>Cat 0<\/b>/);
  assert.match(html, /aria-live="polite"/);
  // Budget status arrives with analytics, even with the Analytics summary switched off.
  const flagged = state => nodes.filter(n => n.classes.has(state)).map(n => `${n.classes.has('pie3d-top') ? 'top' : 'flag'}${n.dataset.pieIndex}`);
  assert.deepEqual(flagged('is-over'), ['top0', 'flag0', 'top8', 'flag8'], 'over-budget slices and the group holding one are flagged');
  assert.deepEqual(flagged('is-risk'), ['top1', 'flag1']);
  assert.equal(nodes[0].attrs['aria-label'], 'Cat 0, over budget');
  assert.match(legend.innerHTML, /class="is-over" data-pie-select="0"[^>]*title="\$110\.00 of \$100\.00 budget · \$10\.00 over"/);
  assert.match(legend.innerHTML, /<b class="pie-flag is-over">Over budget<\/b>/);
  assert.match(legend.innerHTML, /<b class="pie-flag is-risk">Near limit<\/b>/);
  assert.match(legend.innerHTML, /<b class="pie-flag is-over">1 over<\/b>/);
  assert.match(legend.innerHTML, /pie-legend-meter is-ok"[^>]*><i style="width:18\.0%">/);
  assert.match(slot.innerHTML, /data-pie-jump="0"><span>Cat 0<\/span><strong>\$10\.00 over[\s\S]*data-pie-jump="8"><span>Cat 10<\/span><strong>\$5\.00 over[\s\S]*class="is-risk" data-pie-jump="1"><span>Cat 1<\/span><strong>\$20\.00 left/,
    'the overview lists over-budget categories first, then those near their limit');
});

test('spending cards retain category drill-down hooks and readable spent context', () => {
  const html = readFileSync(new URL('index.html', import.meta.url), 'utf8');
  assert.match(html, /class="metric-card list-item mtd-category-card" data-category=/);
  assert.match(html, /onclick="window\.openCategoryTransactions\(this\.dataset\.category, this\.dataset\.month\)"/);
  assert.match(html, /<small>spent this month<\/small>/);
});

test('card colors alternate at the wrapper level and retain depth and reduced-motion support', () => {
  const styles = readFileSync(new URL('spending-history.css', import.meta.url), 'utf8');
  const base = readFileSync(new URL('refresh.css', import.meta.url), 'utf8');
  for (let index = 2; index <= 6; index++) {
    assert.ok(styles.includes(`.mtd-grid > .mtd-card-wrap:nth-child(6n+${index})`));
  }
  assert.doesNotMatch(base, /\.mtd-category-card:nth-child\(6n/);
  assert.match(styles, /body \.mtd-card-wrap \.mtd-category-card[^}]*var\(--mtd-tint\)/);
  assert.match(styles, /\.mtd-card-wrap \{[^}]*box-shadow:/);
  assert.match(styles, /prefers-reduced-motion: reduce[^]*transform: none/);
});
