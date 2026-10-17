import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
function fixture(fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  const nodes = new Map();
  const listeners = new Map();
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(['auth-pending']);
    const element = {
      id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, options: [],
      style: {}, dataset: {}, parentElement: { before() {}, after() {} },
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
        toggle(c, force) { const active = force === undefined ? !classes.has(c) : force; active ? classes.add(c) : classes.delete(c); return active; }
      },
      appendChild(child) { this.options.push(child); }, prepend() {}, before() {}, after() {}, remove() {},
      close() { this.open = false; this.listeners?.close?.(); }, focus() {},
      addEventListener(name, listener) { (this.listeners ||= {})[name] = listener; },
      querySelector: selector => node(`${id} ${selector}`), querySelectorAll: () => [],
      getAttribute: () => '', setAttribute() {}, removeAttribute() {}, reset() {}, showModal() { this.open = true; }
    };
    nodes.set(id, element); return element;
  }
  const views = ['dashboard', 'categories', 'category-admin', 'transactions', 'etl', 'payoff', 'goals', 'insights'].map(view => node(`${view}-view`));
  const nav = ['dashboard', 'categories', 'transactions', 'etl', 'payoff', 'goals', 'insights', 'settings'].map(view => {
    const item = node(`nav-${view}`);
    item.dataset.view = view;
    return item;
  });
  node('txn-filter-category').options.push({ value: '' });
  const context = {
    console, URL, Date, Number, String, Object, Math, Promise, Set, Map,
    fetch: fetchImpl, setTimeout, clearTimeout, addEventListener: (name, listener) => listeners.set(name, listener),
    location: { href: 'http://local.test/', origin: 'http://local.test', hash: '', reload() { context.reloaded = true; } },
    history: { pushState(state, unused, hash) { context.location.hash = hash; } },
    document: {
      getElementById: node, createElement: tag => node(`new-${tag}-${nodes.size}`), querySelector: node,
      querySelectorAll: selector => selector === '.view' ? views : selector === '.nav-btn' ? nav : [], body: node('body'),
      addEventListener: (name, listener) => listeners.set(`document:${name}`, listener)
    },
    notify() {}, closeSidebar() {}, closeAddGoalModal() {}, openAddGoalModal() {},
    loadDashboard() {}, loadAllTransactions() {}, loadCategories() {}, loadEtlStaging() {}, loadGoals() {}, loadPayoffPlan() {}, generateInsights() {},
    showView(view) { context.lastView = view; }, FormData, FinanceSession: { isAuthenticated: () => true }
  };
  context.window = context;
  vm.createContext(context);
  return { context, node, views, listeners, run: file => vm.runInContext(source(file), context) };
}
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test('all frontend scripts and inline application code parse', () => {
  for (const file of ['session.js','client-errors.js','ui.js','refresh.js','account.js','admin.js','pro-charts.js','pro-core.js','pro-dashboard.js','pro-categories.js','analytics.js','plan.js']) new vm.Script(source(file));
  for (const html of ['index.html','admin.html','transactions.html']) for (const match of source(html).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('only one navigation implementation switches to exactly one active view', () => {
  const html = source('index.html');
  assert.doesNotMatch(html, /function showView|showView\s*=/);
  const f = fixture(); f.run('refresh.js');
  f.context.showView('category-admin');
  assert.deepEqual(f.views.filter(view => view.classList.contains('active')).map(view => view.id), ['category-admin-view']);
  f.context.showView('categories');
  assert.deepEqual(f.views.filter(view => view.classList.contains('active')).map(view => view.id), ['categories-view']);
});
test('dashboard category drill-down opens a dialog with only matching category and month transactions', async () => {
  const f = fixture(async url => url === '/api/dashboard/all-transactions'
    ? response(200, { transactions: [
      { category: 'Groceries', date: '2026-10-03', description: 'Market', amount: 42.5, direction: 'DEBIT' },
      { category: 'Dining', date: '2026-10-04', description: 'Cafe', amount: 15, direction: 'DEBIT' },
      { category: 'Groceries', date: '2026-09-30', description: 'Earlier market', amount: 20, direction: 'DEBIT' }
    ] })
    : response(200, {}));
  f.run('refresh.js');
  await f.context.openCategoryTransactions('Groceries', '2026-10-01');
  assert.equal(f.node('mtd-transactions-dialog').open, true);
  assert.equal(f.node('mtd-dialog-title').textContent, 'Groceries');
  assert.equal(f.node('mtd-dialog-period').textContent, 'October 2026');
  assert.equal(f.node('mtd-dialog-total').textContent, '$42.50');
  assert.equal(f.node('mtd-dialog-count').textContent, '1');
  assert.match(f.node('mtd-dialog-content').innerHTML, /Market/);
  assert.doesNotMatch(f.node('mtd-dialog-content').innerHTML, /Cafe|Earlier market/);
  assert.notEqual(f.context.location.hash, 'transactions');
  assert.deepEqual(f.views.filter(view => view.classList.contains('active')).map(view => view.id), []);
});
test('transaction category/month filter excludes other categories and months', () => {
  const f = fixture(); f.run('refresh.js');
  const transactions = [
    { category: 'Groceries', date: '2026-10-03' },
    { category: 'Dining', date: '2026-10-04' },
    { category: 'Groceries', date: '2026-09-30' }
  ];
  assert.deepEqual(
    f.context.filterTransactionsByCategoryAndMonth(transactions, 'Groceries', '2026-10'),
    [transactions[0]]
  );
});
const activity = [
  { id: 1, category: 'Groceries', date: '2026-10-01T00:00:00.000Z', description: 'October market', amount: 42.5, direction: 'DEBIT', is_fixed: true },
  { id: 2, category: 'Dining', date: '2026-10-31', description: 'October cafe', amount: 15, direction: 'DEBIT', is_fixed: false },
  { id: 3, category: 'Groceries', date: '2026-09-30', description: 'September market', amount: 20, direction: 'DEBIT', is_fixed: true },
  { id: 4, category: 'Income', date: '2026-10-15', description: 'October salary', amount: 1000, direction: 'CREDIT', is_fixed: true }
];
const categoryData = [{ id: 1, name: 'Groceries' }, { id: 2, name: 'Dining' }, { id: 3, name: 'Income' }];
function activityFixture() {
  return fixture(async url => response(200, url === '/api/categories' ? categoryData
    : url.endsWith('categorization-rules') ? { categories: categoryData, rules: [] }
    : { transactions: activity }));
}
test('active transaction renderer applies month to rows and all summary amounts', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.node('txn-filter-period').value = 'month:2026-10';
  await f.context.loadAllTransactions();
  const html = f.node('full-txn-table').innerHTML;
  assert.match(html, /October market/);
  assert.match(html, /October cafe/);
  assert.match(html, /October salary/);
  assert.doesNotMatch(html, /September market/);
  assert.match(f.node('txn-summary').innerHTML, /\$1,000\.00/);
  assert.match(f.node('txn-summary').innerHTML, /\$57\.50/);
  assert.match(f.node('txn-summary').innerHTML, /\$942\.50/);
  assert.match(f.node('txn-filter-status').textContent, /October 2026 · 3 matching/);
  assert.doesNotMatch(source('index.html'), /async function loadAllTransactions/);
});
test('transaction month, category and fixed debit filters compose and reset together', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.node('txn-filter-period').value = 'month:2026-10';
  f.node('txn-filter-category').value = 'Groceries';
  f.node('txn-filter-fixed').checked = true;
  await f.context.loadAllTransactions();
  assert.match(f.node('full-txn-table').innerHTML, /October market/);
  assert.doesNotMatch(f.node('full-txn-table').innerHTML, /October cafe|September market|October salary/);
  f.node('txn-filter-category').value = '';
  await f.context.loadAllTransactions();
  assert.doesNotMatch(f.node('full-txn-table').innerHTML, /October salary/);
  await f.context.resetTransactionFilters();
  assert.equal(f.node('txn-filter-period').value, '');
  assert.equal(f.node('txn-filter-fixed').checked, false);
  assert.match(f.node('full-txn-table').innerHTML, /September market/);
  assert.match(f.node('txn-filter-status').textContent, /All time · 4 matching/);
});
test('empty transaction periods have zero summaries and an explicit empty state', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.node('txn-filter-period').value = 'month:2025-01';
  await f.context.loadAllTransactions();
  assert.match(f.node('full-txn-table').innerHTML, /No transactions match/);
  assert.equal((f.node('txn-summary').innerHTML.match(/\$0\.00/g) || []).length, 3);
  assert.match(f.node('txn-filter-status').textContent, /0 matching/);
});
test('out-of-order transaction responses cannot overwrite newer results', async () => {
  let finish;
  let calls = 0;
  const f = fixture(async url => {
    if (url === '/api/categories') return response(200, categoryData);
    if (++calls === 1) return new Promise(resolve => { finish = resolve; });
    return response(200, { transactions: [activity[1]] });
  });
  f.run('refresh.js');
  const old = f.context.loadAllTransactions();
  await f.context.loadAllTransactions();
  finish(response(200, { transactions: [activity[0]] }));
  await old;
  assert.match(f.node('full-txn-table').innerHTML, /October cafe/);
  assert.doesNotMatch(f.node('full-txn-table').innerHTML, /October market/);
});
test('category month filters card counts and spending, and is inherited by the floating detail', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.node('category-filter-period').value = 'month:2026-10';
  await f.context.loadCategories();
  assert.match(f.node('category-cards').innerHTML, /\$42\.50/);
  assert.doesNotMatch(f.node('category-cards').innerHTML, /\$62\.50/);
  assert.match(f.node('category-filter-status').textContent, /October 2026 · 3 transactions/);
  await f.node('category-cards').onclick({ target: { closest: () => ({ dataset: { openCategory: 'Groceries' } }) } });
  assert.equal(f.node('category-dialog-month').value, '2026-10');
  assert.equal(f.node('mtd-dialog-total').textContent, '$42.50');
  assert.equal(f.node('mtd-dialog-count').textContent, '1');
  f.node('category-dialog-month').value = '2026-09';
  await f.node('category-dialog-month').onchange();
  assert.equal(f.node('mtd-dialog-total').textContent, '$20.00');
  await f.node('category-dialog-all').onclick();
  assert.equal(f.node('mtd-dialog-period').textContent, 'All time');
  assert.equal(f.node('mtd-dialog-total').textContent, '$62.50');
  assert.equal(f.node('mtd-dialog-count').textContent, '2');
});
test('period presets resolve quarters, year to date, full years and multi-month selections', () => {
  const f = fixture(); f.run('refresh.js');
  const resolve = (spec, custom, date) => JSON.parse(JSON.stringify(f.context.resolvePeriod(spec, custom, new Date(date))));
  assert.deepEqual(resolve('', [], '2026-10-16T12:00:00'), { months: null, label: 'All time' });
  assert.deepEqual(resolve('this-month', [], '2026-10-16T12:00:00').months, ['2026-10']);
  assert.deepEqual(resolve('last-month', [], '2026-01-10T12:00:00'), { months: ['2025-12'], label: 'December 2025' });
  assert.deepEqual(resolve('last-quarter', [], '2026-10-16T12:00:00'), { months: ['2026-07', '2026-08', '2026-09'], label: 'Q3 2026' });
  assert.deepEqual(resolve('last-quarter', [], '2026-02-01T12:00:00'), { months: ['2025-10', '2025-11', '2025-12'], label: 'Q4 2025' });
  assert.deepEqual(resolve('this-quarter', [], '2026-11-05T12:00:00').months, ['2026-10', '2026-11']);
  assert.equal(resolve('ytd', [], '2026-10-16T12:00:00').months.length, 10);
  assert.equal(resolve('last-12', [], '2026-10-16T12:00:00').months[0], '2025-11');
  assert.deepEqual(resolve('year:2025', [], '2026-10-16T12:00:00').months.slice(0, 2), ['2025-01', '2025-02']);
  assert.deepEqual(resolve('custom', ['2026-10', '2026-08'], '2026-10-16T12:00:00'), { months: ['2026-08', '2026-10'], label: 'Aug 2026, Oct 2026' });
});
test('transaction search matches description, category and amount and highlights matches', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.node('txn-filter-search').value = 'market';
  await f.context.loadAllTransactions();
  let html = f.node('full-txn-table').innerHTML;
  assert.match(html, /October <mark>market<\/mark>/);
  assert.match(html, /September <mark>market<\/mark>/);
  assert.doesNotMatch(html, /October cafe|October salary/);
  assert.match(f.node('txn-filter-status').textContent, /All time · “market” · 2 matching/);
  f.node('txn-filter-search').value = 'october $1,000';
  await f.context.loadAllTransactions();
  html = f.node('full-txn-table').innerHTML;
  assert.match(html, /October salary/);
  assert.doesNotMatch(html, /October market|October cafe/);
  f.node('txn-filter-search').value = 'dining';
  await f.context.loadAllTransactions();
  assert.match(f.node('full-txn-table').innerHTML, /October cafe/);
  await f.context.resetTransactionFilters();
  assert.equal(f.node('txn-filter-search').value, '');
  assert.match(f.node('txn-filter-status').textContent, /All time · 4 matching/);
});
test('similar-payment matcher normalizes statement noise with regex and weighs amount', () => {
  const f = fixture(); f.run('refresh.js');
  const key = f.context.merchantKey;
  assert.equal(key('VISA DDA PUR AP 420429 NETFLIX COM 408 5403700 * CA'), 'NETFLIX');
  assert.equal(key('DDA PURCHASE AP 00001000 NETFLIX COM LOS GATOS * CA'), 'NETFLIX');
  assert.equal(key('VISA DDA PUR AP 490641 NETFLIX COM NETFLIX COM * CA'), 'NETFLIX');
  assert.equal(key('ZELLE TO JOHN SMITH 12345'), 'ZELLE JOHN');
  assert.equal(key('BILL PAY PSEG ELECTRIC'), 'PSEG');
  assert.equal(key('ONLINE PMT COMCAST XFINITY'), 'COMCAST');
  assert.equal(key('AUTO PAY GEICO'), key('GEICO AUTO'));
  assert.notEqual(key('ZELLE TO MARY JONES'), key('ZELLE TO JOHN SMITH'));
  const rows = [
    { id: '1', date: '2026-09-29', description: 'VISA DDA PUR AP 420429 NETFLIX COM 408 5403700 * CA', amount: 28.78, direction: 'DEBIT', category: 'Entertainment' },
    { id: '2', date: '2026-08-31', description: 'VISA DDA PUR AP 490641 NETFLIX COM NETFLIX COM * CA', amount: 28.78, direction: 'DEBIT', category: 'Entertainment' },
    { id: '3', date: '2026-07-28', description: 'DDA PURCHASE AP 00001000 NETFLIX COM LOS GATOS * CA', amount: 28.78, direction: 'DEBIT', category: 'Shopping' },
    { id: '4', date: '2025-01-28', description: 'DDA PURCHASE AP 00001000 NETFLIX COM LOS GATOS * CA', amount: 15.49, direction: 'DEBIT', category: 'Shopping' },
    { id: '5', date: '2026-06-28', description: 'NETFLIX COM REFUND', amount: 28.78, direction: 'CREDIT', category: 'Shopping' },
    { id: '6', date: '2026-06-28', description: 'NETFLIX COM', amount: 28.78, direction: 'DEBIT', category: 'Subscriptions' },
    { id: '7', date: '2026-06-01', description: 'SPOTIFY USA', amount: 28.78, direction: 'DEBIT', category: 'Shopping' }
  ];
  const similar = f.context.findSimilarTransactions(rows, rows[0], 'Subscriptions');
  assert.deepEqual(similar.map(item => [item.transaction.id, item.sameAmount]), [['2', true], ['3', true], ['4', false]]);
  assert.equal(f.context.findSimilarTransactions(rows, rows[0], '').length, 0);
  rows[1].is_fixed = true;
  const fixedMatches = f.context.findSimilarTransactions(rows, rows[0], { isFixed: true });
  assert.deepEqual(fixedMatches.map(item => item.transaction.id), ['3', '6', '4']);
  assert.deepEqual(f.context.findSimilarTransactions(rows, rows[0], { isFixed: false }).map(item => item.transaction.id), ['2']);
});
test('marking a fixed bill offers similar payments and flags only the confirmed ones', async () => {
  const calls = [];
  const transactions = [
    { id: '1', date: '2026-09-29', description: 'VISA DDA PUR AP 420429 NETFLIX COM 408 5403700 * CA', amount: 28.78, direction: 'DEBIT', category: 'Subscriptions', is_fixed: false },
    { id: '2', date: '2026-08-31', description: 'VISA DDA PUR AP 490641 NETFLIX COM NETFLIX COM * CA', amount: 28.78, direction: 'DEBIT', category: 'Subscriptions', is_fixed: false },
    { id: '3', date: '2026-04-20', description: 'VISA DDA PUR AP 490641 NETFLIX COM NETFLIX COM * CA', amount: 15.49, direction: 'DEBIT', category: 'Subscriptions', is_fixed: false }
  ];
  const f = fixture(async (url, options = {}) => {
    calls.push([url, options.body ? JSON.parse(options.body) : null]);
    if (url === '/api/categories') return response(200, [{ name: 'Subscriptions' }]);
    if (url === '/api/dashboard/all-transactions') return response(200, { transactions });
    return response(200, { success: true, updated: 2 });
  });
  f.run('refresh.js');
  await f.context.loadAllTransactions();
  const box = { checked: true, disabled: false, matches: selector => selector === '[data-fixed]', closest: () => ({ dataset: { transaction: '0' } }) };
  const pending = f.node('full-txn-table').onchange({ target: box });
  await new Promise(resolve => setTimeout(resolve, 0));
  const dialog = f.node('body').options.find(child => child.id === 'similar-dialog');
  assert.equal(dialog.open, true);
  assert.equal(f.node('similar-title').textContent, 'Mark similar payments as fixed?');
  assert.match(f.node('similar-list').innerHTML, /Not fixed &rarr; Fixed bill/);
  assert.match(f.node('similar-list').innerHTML, /data-similar="1" >/);
  f.node('similar-list').querySelectorAll = () => [{ checked: true, dataset: { similar: '0' } }, { checked: true, dataset: { similar: '1' } }];
  await f.node('similar-form').onsubmit({ preventDefault() {} });
  await pending;
  assert.deepEqual(calls.find(([url]) => url === '/api/transactions/update-fixed')[1], { id: '1', is_fixed: true, apply_to_all: false });
  assert.deepEqual(calls.find(([url]) => url === '/api/transactions/update-fixed-many')[1], { ids: [2, 3], is_fixed: true });
  assert.equal(dialog.open, false);
});
test('changing a category offers similar payments and applies only the confirmed ones', async () => {
  const calls = [];
  const transactions = [
    { id: '1', date: '2026-09-29', description: 'VISA DDA PUR AP 420429 NETFLIX COM 408 5403700 * CA', amount: 28.78, direction: 'DEBIT', category: 'Entertainment' },
    { id: '2', date: '2026-08-31', description: 'VISA DDA PUR AP 490641 NETFLIX COM NETFLIX COM * CA', amount: 28.78, direction: 'DEBIT', category: 'Entertainment' },
    { id: '3', date: '2026-07-28', description: 'DDA PURCHASE AP 00001000 NETFLIX COM LOS GATOS * CA', amount: 28.78, direction: 'DEBIT', category: null }
  ];
  const f = fixture(async (url, options = {}) => {
    calls.push([url, options.body ? JSON.parse(options.body) : null]);
    if (url === '/api/categories') return response(200, [{ name: 'Subscriptions' }, { name: 'Entertainment' }]);
    if (url === '/api/dashboard/all-transactions') return response(200, { transactions });
    if (url === '/api/transactions/categorization-apply') return response(200, { updated: 2 });
    return response(200, { success: true });
  });
  f.run('refresh.js');
  await f.context.loadAllTransactions();
  const select = { value: 'Subscriptions', disabled: false, matches: selector => selector === '[data-category]', closest: () => ({ dataset: { transaction: '0' } }) };
  const pending = f.node('full-txn-table').onchange({ target: select });
  await new Promise(resolve => setTimeout(resolve, 0));
  const dialog = f.node('body').options.find(child => child.id === 'similar-dialog');
  assert.equal(dialog.open, true);
  assert.match(f.node('similar-list').innerHTML, /data-similar="0" checked/);
  assert.match(f.node('similar-list').innerHTML, /Uncategorized &rarr; Subscriptions/);
  const boxes = [{ checked: true, dataset: { similar: '0' } }, { checked: true, dataset: { similar: '1' } }];
  f.node('similar-list').querySelectorAll = () => boxes;
  await f.node('similar-form').onsubmit({ preventDefault() {} });
  await pending;
  const apply = calls.find(([url]) => url === '/api/transactions/categorization-apply')[1];
  assert.deepEqual(apply, { updates: [{ id: 2, category: 'Subscriptions', expectedCategory: 'Entertainment' }, { id: 3, category: 'Subscriptions', expectedCategory: null }], learnRules: true, protectCorrections: false });
  assert.equal(dialog.open, false);
});
test('pay-mode column, filter and similar-payment prompt mark auto-pay and manual debits', async () => {
  const calls = [];
  const transactions = [
    { id: '1', date: '2026-09-29', description: 'VISA DDA PUR AP 420429 NETFLIX COM 408 5403700 * CA', amount: 28.78, direction: 'DEBIT', category: 'Subscriptions', pay_mode: null },
    { id: '2', date: '2026-08-31', description: 'VISA DDA PUR AP 490641 NETFLIX COM NETFLIX COM * CA', amount: 28.78, direction: 'DEBIT', category: 'Subscriptions', pay_mode: 'manual' },
    { id: '3', date: '2026-07-28', description: 'DDA PURCHASE AP 00001000 NETFLIX COM LOS GATOS * CA', amount: 28.78, direction: 'DEBIT', category: 'Subscriptions', pay_mode: 'auto' },
    { id: '4', date: '2026-07-15', description: 'PAYROLL ACME', amount: 2000, direction: 'CREDIT', category: 'Salary', pay_mode: null }
  ];
  const f = fixture(async (url, options = {}) => {
    calls.push([url, options.body ? JSON.parse(options.body) : null]);
    if (url === '/api/categories') return response(200, [{ name: 'Subscriptions' }, { name: 'Salary' }]);
    if (url === '/api/dashboard/all-transactions') return response(200, { transactions });
    return response(200, { success: true, updated: 1 });
  });
  f.run('refresh.js');
  await f.context.loadAllTransactions();
  const html = f.node('full-txn-table').innerHTML;
  assert.equal((html.match(/data-paymode/g) || []).length, 3);
  assert.match(html, /paymode-select is-manual[\s\S]*value="manual" selected/);
  assert.match(html, /paymode-na/);
  for (const [filter, expected] of [['auto', ['3']], ['manual', ['2']], ['unset', ['1']], ['', ['1', '2', '3', '4']]]) {
    assert.deepEqual(transactions.filter(t => f.context.matchesPayModeFilter(t, filter)).map(t => t.id), expected, filter);
  }
  f.node('txn-filter-paymode').value = 'manual';
  await f.context.loadAllTransactions();
  assert.match(f.node('txn-filter-status').textContent, /1 matching/);
  await f.context.resetTransactionFilters();
  assert.equal(f.node('txn-filter-paymode').value, '');
  assert.deepEqual(f.context.findSimilarTransactions(transactions, transactions[0], { payMode: 'auto' }).map(item => item.transaction.id), ['2']);
  const select = { value: 'auto', disabled: false, matches: selector => selector === '[data-paymode]', closest: () => ({ dataset: { transaction: '0' } }) };
  const pending = f.node('full-txn-table').onchange({ target: select });
  await new Promise(resolve => setTimeout(resolve, 0));
  const dialog = f.node('body').options.find(child => child.id === 'similar-dialog');
  assert.equal(dialog.open, true);
  assert.equal(f.node('similar-title').textContent, 'Apply to similar payments?');
  assert.match(f.node('similar-list').innerHTML, /Manual &rarr; Auto-pay/);
  assert.match(f.node('similar-list').innerHTML, /data-similar="0" checked/);
  f.node('similar-list').querySelectorAll = () => [{ checked: true, dataset: { similar: '0' } }];
  await f.node('similar-form').onsubmit({ preventDefault() {} });
  await pending;
  const updates = calls.filter(([url]) => url === '/api/transactions/update-pay-mode').map(([, body]) => body);
  assert.deepEqual(updates, [{ ids: [1], pay_mode: 'auto' }, { ids: [2], pay_mode: 'auto' }]);
  assert.equal(dialog.open, false);
});
test('upcoming payments switch between calendar and list views and remember the choice', () => {
  const f = fixture(); f.run('refresh.js');
  const buttons = ['calendar', 'list'].map(view => ({ dataset: { payView: view }, pressed: null, setAttribute(name, value) { this.pressed = value; } }));
  const query = f.context.document.querySelectorAll;
  f.context.document.querySelectorAll = selector => selector === 'button[data-pay-view]' ? buttons : query(selector);
  const section = f.node('upcoming-section');
  assert.equal(f.context.setPayView(), 'calendar', 'works without localStorage or matchMedia');
  assert.equal(section.dataset.payView, 'calendar');
  const store = new Map();
  f.context.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  f.context.matchMedia = () => ({ matches: true });
  assert.equal(f.context.setPayView(), 'list', 'phones default to the list');
  f.context.setPayView('calendar');
  assert.deepEqual(buttons.map(button => button.pressed), ['true', 'false']);
  assert.equal(f.context.setPayView(), 'calendar', 'stored choice wins over the screen-size default');
  f.context.setPayView('list');
  assert.equal(section.dataset.payView, 'list');
  assert.deepEqual(buttons.map(button => button.pressed), ['false', 'true']);
  const html = source('index.html');
  assert.match(html, /data-pay-view="calendar"[^>]*onclick="setPayView\('calendar'\)"/);
  assert.match(html, /data-pay-view="list"[^>]*onclick="setPayView\('list'\)"/);
});
test('categories support multi-month selection and full-year options, inherited by the detail dialog', async () => {
  const f = activityFixture(); f.run('refresh.js');
  await f.context.loadCategories();
  assert.match(f.node('category-filter-period').innerHTML, /value="year:2026"/);
  assert.match(f.node('category-filter-period').innerHTML, /Last quarter/);
  f.node('category-filter-period').value = 'custom';
  await f.node('category-filter-period').onchange();
  assert.equal(f.node('category-filter-months').hidden, false);
  assert.match(f.node('category-filter-months').innerHTML, /value="2026-09"/);
  await f.node('category-filter-months').onchange({ target: { type: 'checkbox', value: '2026-09', checked: true } });
  assert.match(f.node('category-filter-status').textContent, /September 2026 · 1 transactions/);
  await f.node('category-filter-months').onchange({ target: { type: 'checkbox', value: '2026-10', checked: true } });
  assert.match(f.node('category-filter-status').textContent, /Sep 2026, Oct 2026 · 4 transactions/);
  assert.match(f.node('category-cards').innerHTML, /\$62\.50/);
  await f.node('category-cards').onclick({ target: { closest: () => ({ dataset: { openCategory: 'Groceries' } }) } });
  assert.equal(f.node('mtd-dialog-period').textContent, 'Sep 2026, Oct 2026');
  assert.equal(f.node('category-dialog-month').value, '');
  assert.equal(f.node('mtd-dialog-total').textContent, '$62.50');
  f.node('category-filter-period').value = 'year:2025';
  await f.node('category-filter-period').onchange();
  assert.equal(f.node('category-filter-months').hidden, true);
  assert.match(f.node('category-filter-status').textContent, /2025 · 0 transactions/);
});
test('category load failure clears stale results and reports the error', async () => {
  const f = fixture(async () => response(500, { error: 'Service unavailable' }));
  f.run('refresh.js');
  f.node('category-cards').textContent = 'Old results';
  await f.context.loadCategories();
  assert.equal(f.node('category-cards').textContent, '');
  assert.match(f.node('category-filter-status').textContent, /Could not load categories: Service unavailable/);
});
test('a closed category dialog discards a late transaction response', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.run('refresh.js');
  const pending = f.context.openCategoryTransactions('Groceries', '2026-10');
  f.node('mtd-transactions-dialog').close();
  finish(response(200, { transactions: activity }));
  await pending;
  assert.equal(f.node('mtd-transactions-dialog').open, false);
  assert.equal(f.node('mtd-dialog-count').textContent, '—');
});
test('goal validation and save errors are visible inside the floating editor', async () => {
  const f = fixture(async () => response(500, { error: 'Unable to save this goal' }));
  f.run('refresh.js');
  await f.context.saveGoal();
  assert.match(f.node('goal-error').textContent, /positive target/);
  f.node('goal-name').value = 'Emergency fund';
  f.node('goal-target').value = '5000';
  f.context.document.querySelector = selector => selector === 'dialog[open] [role="alert"]' ? f.node('goal-error') : f.node(selector);
  await f.context.saveGoal();
  assert.equal(f.node('goal-error').textContent, 'Unable to save this goal');
});
test('hash navigation updates the view, breadcrumb and active parent navigation', () => {
  const f = fixture(); f.run('refresh.js');
  f.context.location.hash = '#transactions';
  f.listeners.get('hashchange')();
  assert.equal(f.node('current-page').textContent, 'Transactions');
  assert.equal(f.node('nav-transactions').classList.contains('active'), true);
  f.context.showView('category-admin');
  assert.equal(f.node('nav-categories').classList.contains('active'), true);
  assert.equal(f.node('nav-transactions').classList.contains('active'), false);
  assert.equal(f.context.location.hash, '#category-admin');
  f.context.showView('unknown-page');
  assert.equal(f.node('current-page').textContent, 'Dashboard');
});
test('import and goal editors use native floating dialogs with their controls inside', () => {
  const html = source('index.html');
  for (const [id, control] of [['import-modal', 'csv-import-btn'], ['add-goal-modal', 'goal-name']]) {
    const dialog = html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?<\\/dialog>`))?.[0] || '';
    assert.match(dialog, /aria-labelledby=/);
    assert.ok(dialog.includes(`id="${control}"`));
  }
  assert.match(source('refresh.css'), /body dialog\s*\{[^}]*inset:\s*0;[^}]*margin:\s*auto;/);
  assert.match(source('transactions.html'), /url=\/#transactions/);
});
test('floating confirmations return explicit acceptance or cancellation', async () => {
  const f = fixture(); f.run('ui.js');
  const cancelled = f.context.FinanceUI.confirm('Delete this item?');
  let dialog = f.node('body').options.at(-1);
  assert.equal(dialog.open, true);
  dialog.querySelector('.btn-secondary').onclick();
  assert.equal(await cancelled, false);
  const accepted = f.context.FinanceUI.confirm('Delete this item?');
  dialog = f.node('body').options.at(-1);
  dialog.returnValue = 'confirm';
  dialog.close();
  assert.equal(await accepted, true);
});
test('savings amount dialog returns input only on confirmation and cancels to null', async () => {
  const f = fixture(); f.run('ui.js');
  const accepted = f.context.FinanceUI.amount('Record progress, not a transfer.');
  let dialog = f.node('body').options.at(-1);
  assert.match(dialog.innerHTML, /min="0.01" step="0.01" required/);
  dialog.querySelector('input').value = '125.50';
  dialog.returnValue = 'confirm';
  dialog.close();
  assert.equal(await accepted, '125.50');
  const cancelled = f.context.FinanceUI.amount('Record progress, not a transfer.');
  dialog = f.node('body').options.at(-1);
  dialog.close();
  assert.equal(await cancelled, null);
});
test('Escape closes only the topmost floating dialog', () => {
  const f = fixture(); f.run('ui.js');
  const first = f.node('first-dialog'), last = f.node('last-dialog');
  first.open = last.open = true;
  f.context.document.querySelectorAll = () => [first, last];
  let prevented = false;
  f.listeners.get('document:keydown')({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(last.open, false);
  assert.equal(first.open, true);
  assert.equal(prevented, true);
});
test('browser error reports are same-origin, redacted, and deduplicated', () => {
  const requests = [];
  const f = fixture(async (url, options) => { requests.push([url, options]); return { ok: true }; });
  f.run('client-errors.js');
  const event = {
    error: new Error('private stack must not be sent'),
    message: 'token=private123 amount=$123.45 ashak@example.com',
    filename: 'http://local.test/refresh.js?session=secret', lineno: 9, colno: 4
  };
  f.listeners.get('error')(event);
  f.listeners.get('error')(event);
  f.listeners.get('error')({ ...event, filename: 'https://third-party.test/tracker.js' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], '/api/client-errors');
  const report = JSON.parse(requests[0][1].body);
  assert.equal(report.file, 'refresh.js');
  assert.equal(report.line, 9);
  assert.doesNotMatch(JSON.stringify(report), /private123|123\.45|ashak@example\.com|private stack|session=secret/);
});
test('brand mark is a scalable green SVG used on sign-in and in navigation', () => {
  const html = source('index.html');
  assert.equal((html.match(/class="brand-mark(?: small)?"/g) || []).length, 2);
  assert.equal((html.match(/class="brand-mark-bg"/g) || []).length, 2);
  assert.equal((html.match(/class="brand-mark-line"/g) || []).length, 2);
  assert.match(html, /aria-label="MyFinance mark"/);
  assert.match(source('refresh.css'), /\.brand-mark-bg\s*\{\s*fill:\s*#226452/);
});
test('categories overview is focused and category administration has its own page', () => {
  const html = source('index.html');
  const overview = html.match(/<section id="categories-view"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(overview, /category-cards/);
  assert.match(overview, /showView\('category-admin'\)/);
  assert.match(overview, /id="category-filter-period"/);
  assert.match(overview, /id="category-filter-months"/);
  assert.doesNotMatch(overview, /Review category suggestions|category-manager-list|merchant-rules|txn-list/);
  assert.match(html, /id="category-admin-view"/);
  assert.match(source('refresh.js'), /Saved merchant mappings/);
  assert.match(source('refresh.css'), /\.category-card/);
});
test('forgot-password mode asks only for email and posts a reset request', async () => {
  const requests = [];
  const f = fixture(async (url, options = {}) => {
    requests.push([url, options.body]);
    if (url.endsWith('/me')) return response(401, {});
    if (url.endsWith('/status')) return response(200, { setupRequired: false, registrationEnabled: false });
    return response(202, { message: 'If that email belongs to an account, a password reset link has been sent.' });
  });
  f.run('session.js');
  await f.context.FinanceSession.start();
  assert.equal(f.node('auth-forgot').hidden, false);
  f.node('auth-forgot').onclick();
  assert.equal(f.node('auth-password-label').hidden, true);
  assert.equal(f.node('auth-password').required, false);
  assert.equal(f.node('auth-name-label').hidden, true);
  assert.equal(f.node('auth-switch').hidden, false);
  f.node('auth-email').value = ' person@example.com ';
  await f.node('auth-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(requests.at(-1), ['/api/auth/password-reset/request', JSON.stringify({ email: 'person@example.com' })]);
  assert.match(f.node('auth-description').textContent, /reset link has been sent/);
  assert.equal(f.node('auth-password-label').hidden, false);
});
test('support sessions show a banner and hide admin navigation', async () => {
  const f = fixture(async url => url.endsWith('/me') ? response(200, {
    user: { id: 2, name: 'Customer', role: 'user' },
    support: { actor: { id: 1, name: 'Owner' }, accessLevel: 'read', expiresAt: '2030-01-01T00:00:00Z' }
  }) : response(200, {}));
  const prepended = [];
  f.context.document.body.prepend = node => prepended.push(node);
  f.run('session.js');
  await f.context.FinanceSession.start();
  assert.equal(f.node('auth-description').textContent, '');
  assert.equal(prepended.length, 1);
  assert.equal(f.context.lastView, 'dashboard');
  assert.equal(f.context.FinanceSession.currentSupport().accessLevel, 'read');
  assert.equal(f.context.FinanceSession.currentUser().name, 'Customer');
});
test('money, fixed flag, and HTML escaping handle untrusted and missing values', () => {
  const f = fixture(); f.run('refresh.js');
  const tools = f.context.FinanceTools;
  assert.equal(tools.money(null), 'Not enough data');
  assert.equal(tools.money(0), '$0.00');
  assert.equal(tools.fixed('false'), false);
  assert.equal(tools.fixed('true'), true);
  assert.equal(tools.escape(`"><img onerror='x'>&`), '&quot;&gt;&lt;img onerror=&#39;x&#39;&gt;&amp;');
});
test('the planner owns debt math: the client simulator is gone', () => {
  const f = fixture(); f.run('refresh.js');
  assert.equal(f.context.FinanceTools.simulate, undefined);
  assert.doesNotMatch(source('index.html'), /function generateTimelineChart|async function loadPayoffPlan|payoff-schedule-body/);
});
const planPayload = (overrides = {}) => ({
  month: '2026-10', pro: false,
  summary: { avgMonthlyIncome: 6000, avgMonthlyExpenses: 4800, monthlySurplus: 1200, savingsRate: 0.2, monthsUsed: 3, debtExtra: 400, goalBudget: 800, available: 800, unassigned: 100 },
  income: { streams: [{ name: 'ACME PAYROLL', label: 'Every other Thursday', amount: 2450 }] },
  debtPlan: {
    strategies: [
      { id: 'avalanche', name: 'Avalanche', tagline: 'Highest APR first', pro: false, locked: false },
      { id: 'snowball', name: 'Snowball', tagline: 'Smallest balance first', pro: false, locked: false },
      { id: 'interest', name: 'Interest cost', tagline: 'Biggest interest bill first', pro: true, locked: true }
    ],
    strategy: 'avalanche', recommended: 'avalanche', strategyLocked: false, budget: 1117.66, budgetIsSet: true, minimums: 717.66, extra: 400,
    totals: { balance: 18000, monthlyInterest: 210, weightedApr: 14.2, included: 2, excluded: 0, count: 2 },
    plan: { feasible: true, debtFree: true, months: 24, debtFreeDate: '2028-09', totalInterest: 2900, series: [18000, 17000, 0] },
    baseline: { series: [18000, 17800, 17600, 17400] },
    comparison: [
      { id: 'avalanche', feasible: true, debtFree: true, debtFreeDate: '2028-09', totalInterest: 2900 },
      { id: 'snowball', feasible: true, debtFree: true, debtFreeDate: '2028-10', totalInterest: 3100 },
      { id: 'interest', locked: true }
    ],
    suggestion: { extra: 250, budget: 1367.66, debtFreeDate: '2028-03', interestSaved: 400 },
    guidance: [{ severity: 'warning', title: '<Card> is your most expensive money', detail: 'x' }],
    debts: [
      { id: 1, name: '<Visa>', debt_type: 'credit_card', balance: 6000, apr: 24.99, min_payment: 180, credit_limit: 10000, due_day: 3, included: true, focus: false, rank: 1, monthlyInterest: 125, payoffDate: '2027-06', thisMonth: { minimum: 180, extra: 400 } },
      { id: 2, name: 'Car loan', debt_type: 'auto_loan', balance: 12000, apr: 6.5, min_payment: 420, credit_limit: 0, due_day: 15, included: false, focus: false, rank: null, monthlyInterest: 65, thisMonth: { minimum: 0, extra: 0 } }
    ],
    interestSavedVsMinimums: 5200, monthsSavedVsMinimums: 40
  },
  goalPlan: {
    strategies: [
      { id: 'priority', name: 'Priority order', tagline: 'Most important first', locked: false },
      { id: 'balanced', name: 'Balanced', tagline: 'Everything moves together', pro: true, locked: true }
    ],
    strategy: 'priority', strategyLocked: false, budget: 800, budgetIsSet: false, defaultBudget: 800, requiredTotal: 650, allocatedTotal: 700, guidance: [],
    goals: [{ id: 7, name: 'Emergency <fund>', icon: '🛡️', kind: 'emergency', priority: 1, target: 10000, current: 2500, remaining: 7500, targetDate: '2027-06-01', targetMonth: 9, included: true, manual: null, contributionDay: null, required: 833.33, allocated: 700, finishMonth: 11, finishDate: '2027-08', status: 'behind', progress: 25, gap: 133.33 }]
  },
  thisMonth: [{ key: 'debt-extra', planKind: 'debt-extra', flexible: true, description: 'Extra payment · <Visa>', amount: 400, defaultAmount: 400, dayOfMonth: 3, status: 'projected' }],
  flex: {}, settings: {}, ...overrides
});
const loadPlan = (fetchImpl) => {
  const f = fixture(fetchImpl);
  for (const file of ['refresh.js', 'pro-charts.js', 'pro-core.js', 'plan.js']) f.run(file);
  return f;
};
test('debt-free page renders strategies, escaped debts, Pro locks and calendar items', async () => {
  const requests = [];
  const f = loadPlan(async (url, options = {}) => { requests.push([url, options.method || 'GET', options.body]); return response(200, planPayload()); });
  await f.context.loadPayoffPlan();
  const html = f.node('plan-debt-root').innerHTML;
  assert.match(html, /September 2028/);
  assert.match(html, /data-act="debt-strategy" data-id="interest"[\s\S]*?plan-pro-tag/);
  assert.match(html, /Recommended/);
  assert.match(html, /&lt;Visa&gt;/);
  assert.doesNotMatch(html, /<Visa>/);
  assert.match(html, /Paying as usual/);
  assert.match(html, /Add \$250\/mo/);
  assert.match(html, /Unlock with Pro/);
  assert.match(html, /data-act="flex" data-key="debt-extra"/);
  assert.match(html, /class="pro-chart"/);
  assert.equal(requests[0][0], '/api/plan');
  const rows = f.context.FinancePlan.debtRows();
  assert.equal(rows[0].due_date, 3);
});
test('goals page shows the surplus split, status and pay cadence', async () => {
  const f = loadPlan(async () => response(200, planPayload()));
  await f.context.loadGoals();
  const html = f.node('plan-goals-root').innerHTML;
  assert.match(html, /Every other Thursday/);
  assert.match(html, /Emergency &lt;fund&gt;/);
  assert.match(html, /Behind/);
  assert.match(html, /Needs \$833\.33\/mo/);
  assert.match(html, /plan-flowbar/);
  assert.match(html, /plan-gantt-row/);
  const row = f.context.FinancePlan.goalRows()[0];
  assert.equal(row.target_amount, 10000);
  assert.equal(row.target_date, '2027-06-01');
});
test('a failed plan load shows a retry instead of stale numbers', async () => {
  const f = loadPlan(async () => response(500, { error: 'Plan offline' }));
  await f.context.loadPayoffPlan();
  assert.match(f.node('plan-debt-root').innerHTML, /Plan offline[\s\S]*data-act="retry"/);
});
test('the dashboard calendar adds income, flexible plan items and the paycheck summary', () => {
  const html = source('index.html');
  assert.match(html, /runningBalance \+ \(item\.isIncome \? item\.amount : -item\.amount\)/);
  assert.match(html, /data-flex-key=/);
  assert.match(html, /Income still coming/);
  assert.match(html, /<script src="plan\.js\?v=/);
  assert.match(html, /id="goal-monthly"[\s\S]*id="goal-day"[\s\S]*id="goal-included"/);
});
test('financial loads are blocked until a verified session', async () => {
  const requests = [];
  const f = fixture(async url => { requests.push(url); return url.endsWith('/me') ? response(401,{}) : response(200,{ setupRequired: true, registrationEnabled: false }); });
  f.run('session.js');
  await assert.rejects(f.context.fetch('/api/goals'), /sign in/);
  assert.equal(requests.length, 0);
  await f.context.FinanceSession.start();
  assert.deepEqual(requests, ['/api/auth/me','/api/auth/status']);
  assert.equal(f.node('auth-token-label').hidden, false);
  assert.equal(f.node('auth-switch').hidden, true);
  assert.equal(f.context.lastView, undefined);
});
test('registration disabled stays hidden and valid user opens only requested view', async () => {
  const f = fixture(async url => url.endsWith('/me') ? response(200,{ user:{ id:1,name:'<owner>' } }) : response(200,{}));
  f.context.location.hash = '#goals';
  f.run('session.js');
  await f.context.FinanceSession.start();
  assert.equal(f.context.lastView, 'goals');
  assert.equal(f.node('account-name').textContent, '<owner>');
  assert.equal(f.node('body').classList.contains('auth-pending'), false);
  await assert.rejects(f.context.fetch('https://third-party.test/api'), /same-origin/);
});
test('401 clears protected markup and rejects pending body from former session', async () => {
  let finishBody;
  const f = fixture(async url => {
    if (url.endsWith('/me')) return response(200,{ user:{ id:1,name:'Alice' } });
    if (url.endsWith('/slow')) return { ok:true, status:200, json: () => new Promise(resolve => { finishBody = resolve; }) };
    return response(401,{});
  });
  f.node('.app-container').innerHTML = 'CLEAN WORKSPACE';
  f.run('session.js'); await f.context.FinanceSession.start();
  f.node('.app-container').innerHTML = 'ALICE PRIVATE TRANSACTIONS';
  const slow = await f.context.fetch('/api/slow');
  const pending = slow.json();
  await assert.rejects(f.context.fetch('/api/expired'), /session ended/);
  finishBody({ transactions:['ALICE PRIVATE TRANSACTIONS'] });
  await assert.rejects(pending, /Response discarded/);
  assert.equal(f.node('.app-container').innerHTML, 'CLEAN WORKSPACE');
  assert.equal(f.context.FinanceSession.isAuthenticated(), false);
  assert.equal(f.node('body').classList.contains('auth-pending'), true);
});
test('successful logout clears protected markup before reload', async () => {
  const f = fixture(async url => response(200,url.endsWith('/me') ? { user:{ id:1,name:'Alice' } } : {}));
  f.node('.app-container').innerHTML = 'CLEAN';
  f.run('session.js'); await f.context.FinanceSession.start();
  f.node('.app-container').innerHTML = 'PRIVATE';
  await f.context.FinanceSession.logout();
  assert.equal(f.node('.app-container').innerHTML, 'CLEAN');
  assert.equal(f.context.reloaded, true);
  assert.equal(f.context.FinanceSession.isAuthenticated(), false);
});
const loadPro = (fetchImpl) => {
  const f = fixture(fetchImpl);
  for (const file of ['refresh.js', 'pro-charts.js', 'pro-core.js', 'pro-dashboard.js', 'pro-categories.js', 'analytics.js']) f.run(file);
  return f;
};
test('Pro scripts load without a browser and expose their APIs', () => {
  const f = loadPro();
  assert.equal(typeof f.context.FinancePro.openUpgrade, 'function');
  assert.equal(typeof f.context.loadAnalyticsPage, 'function');
  assert.equal(typeof f.context.ProCharts.donut, 'function');
});
test('Pro chart helpers produce scalable SVG', () => {
  const { ProCharts } = loadPro().context;
  assert.equal(ProCharts.niceMax(1234), 2000);
  assert.equal(ProCharts.compact(15400), '$15.4k');
  assert.equal(ProCharts.compact(154000), '$154k');
  const bars = ProCharts.bars({ labels: ['Jan', 'Feb'], values: [100, 250], lines: [{ values: [null, 175], className: 'sma' }] });
  assert.match(bars, /viewBox="0 0 640 230"/);
  assert.equal((bars.match(/<rect class="bar/g) || []).length, 2);
  const donut = ProCharts.donut([{ label: 'A <b>', value: 60, color: '#000' }, { label: 'B', value: 40, color: '#fff' }], { centerValue: '$100' });
  assert.equal((donut.match(/class="slice"/g) || []).length, 2);
  assert.match(donut, /A &lt;b&gt;: \$60 \(60%\)/);
});
test('category analytics derive monthly series and only show a histogram for 2+ months', () => {
  const { FinanceProCategories: C } = loadPro().context;
  const transactions = [
    { category: 'Dining', date: '2026-01-05', amount: 100, direction: 'DEBIT' },
    { category: 'Dining', date: '2026-03-05', amount: 300, direction: 'DEBIT' },
    { category: 'Groceries', date: '2026-03-07', amount: 100, direction: 'DEBIT' },
    { category: 'Transfers', date: '2026-03-08', amount: 900, direction: 'DEBIT' },
    { category: 'Salary', date: '2026-03-09', amount: 5000, direction: 'CREDIT' }
  ];
  const months = C.periodMonths({ months: null }, transactions);
  assert.deepEqual([...months], ['2026-01', '2026-02', '2026-03']);
  const stats = C.categoryStats(transactions, months);
  assert.equal(stats.total, 500);
  const dining = stats.categories.get('Dining');
  assert.deepEqual([...dining.series], [100, 0, 300]);
  assert.equal(dining.share, 0.8);
  assert.equal(stats.categories.get('Transfers').share, null);
  assert.match(C.cardExtra(dining, months, 'above'), /pro-hist/);
  const single = C.categoryStats(transactions, ['2026-03']);
  assert.doesNotMatch(C.cardExtra(single.categories.get('Dining'), ['2026-03'], 'inline'), /pro-hist/);
});
test('Pro gating opens the upgrade dialog for free accounts and offers the one-time trial', async () => {
  const f = loadPro(async url => url === '/api/license'
    ? response(200, { tier: 'free', source: 'none', active: false, trialAvailable: true, plan: { name: 'MyFinance Pro', price: 4.99 }, features: [{ id: 'insights', title: 'Insights', text: 'x' }] })
    : response(200, {}));
  const { FinancePro } = f.context;
  f.node('pro-dialog').tagName = 'DIALOG';
  await FinancePro.ensureEntitlement();
  assert.equal(FinancePro.isActive(), false);
  assert.match(f.node('pro-nav-badge').innerHTML, /pro-lock/);
  assert.equal(FinancePro.requirePro('Budgets are Pro'), false);
  const dialog = f.node('pro-dialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /Start 7-day free trial/);
  assert.match(dialog.innerHTML, /\$4\.99/);
  FinancePro.setEntitlement({ tier: 'trial', source: 'trial', active: true, daysLeft: 3, features: [] });
  assert.equal(FinancePro.requirePro('x'), true);
  assert.match(f.node('pro-nav-badge').innerHTML, /TRIAL/);
});
test('analytics page shows a locked preview without Pro', async () => {
  const f = loadPro(async url => url === '/api/license'
    ? response(200, { tier: 'free', source: 'trial-expired', active: false, trialAvailable: false, features: [] })
    : response(402, { error: 'Pro required', code: 'PRO_REQUIRED' }));
  await f.context.loadAnalyticsPage();
  assert.match(f.node('analytics-content').innerHTML, /Your Pro trial has ended/);
  assert.match(f.node('analytics-actions').innerHTML, /pro-lock/);
});
