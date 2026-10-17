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
  for (const file of ['session.js','client-errors.js','ui.js','refresh.js','account.js','admin.js']) new vm.Script(source(file));
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
test('avalanche includes interest, honors budget, and does not mutate debts', () => {
  const f = fixture(); f.run('refresh.js');
  const debts = [{ balance: 100, apr: 12, min_payment: 10 }];
  const plan = f.context.FinanceTools.simulate(debts, 50);
  assert.equal(plan.months.length, 3);
  assert.equal(plan.months[0], 51);
  assert.equal(plan.months.at(-1), 0);
  assert.equal(debts[0].balance, 100);
  assert.match(f.context.FinanceTools.simulate(debts, 5).reason, /below minimum/);
  assert.match(f.context.FinanceTools.simulate([{ balance: 1000, apr: 30, min_payment: 1 }], 1).reason, /50 years/);
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
