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
      close() { this.open = false; this.listeners?.close?.(); }, focus() {}, select() {}, scrollIntoView() {},
      addEventListener(name, listener) { (this.listeners ||= {})[name] = listener; },
      querySelector: selector => node(`${id} ${selector}`), querySelectorAll: () => [],
      getAttribute: () => '', setAttribute() {}, removeAttribute() {}, reset() {}, showModal() { this.open = true; }
    };
    nodes.set(id, element); return element;
  }
  const views = ['dashboard', 'categories', 'category-admin', 'transactions', 'accounts', 'etl', 'payoff', 'goals', 'insights'].map(view => node(`${view}-view`));
  const nav = ['dashboard', 'categories', 'transactions', 'etl', 'payoff', 'goals', 'insights', 'settings'].map(view => {
    const item = node(`nav-${view}`);
    item.dataset.view = view;
    return item;
  });
  node('txn-filter-category').options.push({ value: '' });
  const context = {
    console, URL, URLSearchParams, Date, Number, String, Object, Math, Promise, Set, Map,
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
  for (const file of ['session.js','client-errors.js','ui.js','refresh.js','accounts.js','account.js','admin.js','pro-charts.js','pro-core.js','pro-dashboard.js','pro-categories.js','analytics.js','plan.js','welcome.js','tutorial.js','income-review.js','marketing.js']) new vm.Script(source(file));
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
      { id: 42, category: 'Groceries', date: '2026-10-03', description: 'Market', amount: 42.5, direction: 'DEBIT' },
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
  assert.match(f.node('mtd-dialog-content').innerHTML, /href="#transactions\/42">Market/);
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
test('transaction deep links clear conflicting filters, isolate an ID and survive route replay', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.node('txn-filter-category').value = 'Dining';
  f.node('txn-filter-search').value = 'salary';
  f.node('txn-filter-period').value = 'month:2026-09';
  f.node('txn-filter-fixed').checked = true;
  f.node('txn-filter-paymode').value = 'manual';
  f.context.showView('transactions/1');
  await f.context.loadAllTransactions();
  assert.equal(f.context.location.hash, '#transactions/1');
  assert.equal(f.context.currentTransactionId(), '1');
  assert.equal(f.node('txn-filter-category').value, '');
  assert.equal(f.node('txn-filter-search').value, '');
  assert.equal(f.node('txn-filter-period').value, '');
  assert.equal(f.node('txn-filter-fixed').checked, false);
  assert.equal(f.node('txn-filter-paymode').value, '');
  const html = f.node('full-txn-table').innerHTML;
  assert.match(html, /October market/);
  assert.doesNotMatch(html, /October cafe|September market|October salary/);
  assert.match(f.node('txn-filter-status').textContent, /Transaction #1 .*1 matching transactions/);
  assert.match(f.node('txn-summary').innerHTML, /\$42\.50/);
  assert.doesNotMatch(f.node('txn-summary').innerHTML, /\$1,000/);
  await f.context.resetTransactionFilters();
  assert.equal(f.context.location.hash, '#transactions');
  assert.match(f.node('full-txn-table').innerHTML, /September market/);
  f.context.showView('transactions/1'); // Back/Forward and initial navigation share this route parser.
  await f.context.loadAllTransactions();
  assert.doesNotMatch(f.node('full-txn-table').innerHTML, /October cafe/);
  f.context.showView('transactions');
  await f.context.loadAllTransactions();
  assert.match(f.node('full-txn-table').innerHTML, /October cafe/);
});
test('missing transaction links stay exact and transaction labels are safely escaped', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.context.showView('transactions/999');
  await f.context.loadAllTransactions();
  assert.match(f.node('full-txn-table').innerHTML, /transaction is unavailable/);
  assert.doesNotMatch(f.node('full-txn-table').innerHTML, /October market/);
  assert.equal(f.context.transactionHref('1" onclick="bad'), '');
  assert.equal(f.context.transactionLink(2, '<img>'), '<a class="transaction-link" href="#transactions/2">&lt;img&gt;</a>');
  assert.match(f.context.transferBadge({ transfer_kind: 'unknown' }), /href="#accounts".*Review/);
});
test('transaction links close the containing dialog and open the exact transaction', () => {
  const f = fixture();
  const clicks = [];
  f.context.document.addEventListener = (type, listener) => { if (type === 'click') clicks.push(listener); };
  f.run('refresh.js');
  const dialog = f.node('example-dialog'); dialog.open = true;
  const link = { getAttribute: () => '#transactions/42', closest: () => dialog };
  let prevented = false;
  clicks[0]({
    target: { closest: selector => selector === 'a.transaction-link' ? link : null },
    button: 0, preventDefault() { prevented = true; }
  });
  assert.equal(prevented, true);
  assert.equal(dialog.open, false);
  assert.equal(f.context.location.hash, '#transactions/42');
  dialog.open = true;
  const reviewLink = { dataset: { view: 'accounts' }, closest: () => dialog };
  clicks[0]({
    target: { closest: selector => selector === 'a[data-view]' ? reviewLink : null },
    button: 0, preventDefault() {}
  });
  assert.equal(dialog.open, false);
  assert.equal(f.context.location.hash, '#accounts');
});
test('Accounts explains inferred ownership, separates recipients and links transfer rows', async () => {
  const accounts = [
    { id: 1, name: 'Checking', kind: 'checking', status: 'confirmed', transactions: 2 },
    { id: 2, name: 'Detected <4821>', kind: 'unknown', status: 'needs_review', transfersTo: 1, unknownTotal: 20, transactions: 0 },
    { id: 3, name: 'Family recipient', kind: 'external', status: 'confirmed', transactions: 0 }
  ];
  const f = fixture(async () => response(200, { accounts, kinds: [
    { value: 'checking', label: 'Checking' }, { value: 'external', label: 'Not mine' }, { value: 'unknown', label: 'Unknown' }
  ], unknownTransfers: { count: 1, total: 20, recent: [{ id: 42, description: 'Transfer <4821>', amount: 20 }] } }));
  f.run('refresh.js'); f.run('accounts.js');
  await f.context.FinanceAccounts.loadPage();
  const html = f.node('accounts-root').innerHTML;
  assert.match(html, /Why review detected accounts/);
  assert.match(html, /No bank is connected and no money is moved/);
  assert.match(html, /Yes, confirm my account/);
  assert.match(html, /No, it is not mine/);
  assert.match(html, /Money sent will count as spending/);
  assert.match(html, /Other people &amp; external recipients[\s\S]*Family recipient/);
  assert.match(html, /href="#transactions\/42">Transfer &lt;4821&gt;/);
  assert.match(html, /YOUR CONFIRMED ACCOUNTS<\/p><strong>1/);
  assert.doesNotMatch(html, /<4821>/);
  assert.match(f.context.FinanceAccounts.resultNote({ accountsDiscovered: 1 }), /Review account ownership/);
});
test('account review requires an owned type and the not-mine action saves an external recipient', async () => {
  let account = { id: 2, name: 'Detected 4821', kind: 'unknown', status: 'needs_review', transactions: 0 };
  const changes = [], messages = [];
  const f = fixture(async (url, options = {}) => {
    if (options.method === 'PATCH') {
      const update = JSON.parse(options.body); changes.push(update);
      account = { ...account, ...update, status: 'confirmed' };
    }
    return response(200, { accounts: [account], kinds: [{ value: 'external', label: 'Not yours' }] });
  });
  test('Accounts shows statement balance and purchase APR even without activity rows', async () => {
    const f = fixture(async () => response(200, { accounts: [{
      id: 1, name: 'Example card', kind: 'credit_card', transactions: 0, balance: 110, balanceAsOf: '2026-10-03',
      statement: { type: 'credit-card', closingDate: '2026-10-03', purchaseApr: 24.99, minimumPayment: 25, paymentDueDate: '2026-10-28', creditLimit: 500 }
    }], kinds: [{ value: 'credit_card', label: 'Credit card' }] }));
    f.run('refresh.js'); f.run('accounts.js');
    await f.context.FinanceAccounts.loadPage();
    const html = f.node('accounts-root').innerHTML;
    assert.match(html, /Statement balance.*2026-10-03/);
    assert.match(html, /Purchase APR: 24.99%/);
    assert.match(html, /Minimum payment: \$25\.00.*Due: 2026-10-28.*Credit limit: \$500\.00/);
    assert.match(html, /separately entered debt-plan/);
  });
  function pdfUploadFixture(status, data) {
    const requests = [], notices = [];
    const f = fixture(async (url, options) => { requests.push([url, JSON.parse(options.body)]); return response(status, data); });
    f.run('refresh.js');
    Object.assign(f.context, {
      pendingPdfFile: { name: 'statement.pdf', size: 1024 },
      pdfImportInProgress: false,
      AbortSignal,
      FinanceAccounts: { choice: () => ({ accountId: 1 }), afterImport: async () => {}, resultNote: () => '' },
      FileReader: class { readAsDataURL() { this.result = 'data:application/pdf;base64,JVBERg=='; setTimeout(() => this.onload(), 0); } },
      escapeHtml: f.context.FinanceTools.escape, usd: value => `$${Number(value).toFixed(2)}`,
      notify: message => notices.push(message)
    });
    const html = source('index.html');
    const modalStart = html.indexOf('    function openImportModal()');
    const modalEnd = html.indexOf('    function switchImportTab', modalStart);
    vm.runInContext(html.slice(modalStart, modalEnd), f.context);
    const start = html.indexOf('    async function importPDF()');
    const end = html.indexOf('    // ===========================================', start);
    vm.runInContext(html.slice(start, end), f.context);
    return { ...f, requests, notices };
  }
  test('PDF upload prevents double submits and displays detected statement/reconciliation facts', async () => {
    const f = pdfUploadFixture(200, {
      success: true, imported: 6, duplicates: 0, totalInFile: 6,
      statement: { type: 'credit-card', closingDate: '2026-10-03', balance: 110, purchaseApr: 24.99 },
      reconciliation: { status: 'balanced' }, warnings: ['Check <promotional> rate']
    });
    await Promise.all([f.context.importPDF(), f.context.importPDF()]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0][0], '/api/import/import-pdf');
    assert.deepEqual(f.requests[0][1], { pdfBase64: 'JVBERg==', source: 'statement.pdf', accountId: 1 });
    assert.match(f.node('import-result').innerHTML, /Detected credit card.*2026-10-03/);
    assert.match(f.node('import-result').innerHTML, /Purchase APR: 24.99%/);
    assert.match(f.node('import-result').innerHTML, /Transactions reconcile/);
    assert.match(f.node('import-result').innerHTML, /Check &lt;promotional&gt; rate/);
    assert.equal(f.context.pendingPdfFile, null);
    assert.equal(f.node('pdf-import-btn').disabled, true);
  });
  test('PDF upload failures keep the file for retry and oversized files never reach the API', async () => {
    const f = pdfUploadFixture(422, { success: false, error: 'Transactions do not reconcile. Nothing was imported.' });
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /Nothing was imported/);
    assert.notEqual(f.context.pendingPdfFile, null);
    assert.equal(f.node('pdf-import-btn').disabled, false);
    assert.doesNotMatch(f.node('import-result').innerHTML, /PDF Import Complete/);
    f.context.pendingPdfFile.size = 13 * 1024 * 1024;
    await f.context.importPDF();
    assert.equal(f.requests.length, 1);
    assert.match(f.node('import-result').innerHTML, /12 MB/);
  });
  test('choosing another PDF during upload cannot resubmit or discard the new selection', async () => {
    const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1, warnings: [] });
    const first = f.context.importPDF();
    const next = { name: 'next-statement.pdf', size: 1024 };
    f.context.pendingPdfFile = next;
    f.node('pdf-import-btn').disabled = false; // Selecting a file enables the existing picker.
    await f.context.importPDF();
    await first;
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0][1].source, 'statement.pdf');
    assert.equal(f.context.pendingPdfFile, next);
    assert.equal(f.node('pdf-import-btn').disabled, false);
  });
  test('PDF progress is visible immediately and completion survives closing and reopening', async () => {
    const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1 });
    const running = f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /<progress[^]*Reading statement.pdf/);
    assert.equal(f.node('pdf-import-btn').textContent, 'Importing PDF...');
    f.context.closeImportModal();
    assert.notEqual(f.context.pendingPdfFile, null, 'closing must not cancel an active import');
    await running;
    const result = f.node('import-result').innerHTML;
    f.context.closeImportModal();
    f.context.openImportModal();
    assert.equal(f.node('import-result').style.display, 'block');
    assert.equal(f.node('import-result').innerHTML, result);
    assert.match(result, /PDF Import Complete/);
    assert.equal(f.node('pdf-input').value, '');
  });
  test('closing a failed PDF import clears its file but retains the failure details', async () => {
    const f = pdfUploadFixture(422, { error: 'Nothing was imported. Check the statement.' });
    await f.context.importPDF();
    f.context.closeImportModal();
    assert.equal(f.context.pendingPdfFile, null);
    assert.equal(f.node('pdf-import-btn').disabled, true);
    assert.equal(f.node('pdf-file-list').textContent, '');
    f.context.openImportModal();
    assert.match(f.node('import-result').innerHTML, /Nothing was imported/);
  });
  test('missing account names show an in-dialog error without sending the PDF', async () => {
    const f = pdfUploadFixture(200, {});
    f.run('accounts.js');
    f.node('import-account-select').value = 'new';
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /Give the new account a name/);
    assert.equal(f.node('import-result').style.display, 'block');
    assert.equal(f.requests.length, 0);
    assert.equal(f.notices.length, 0);
  });
  test('account picker failures are visible in the import dialog', async () => {
    const f = pdfUploadFixture(200, {});
    f.run('accounts.js');
    f.context.fetch = async () => response(503, { error: 'Accounts unavailable' });
    await f.context.FinanceAccounts.loadPicker();
    assert.match(f.node('import-result').innerHTML, /Accounts could not be loaded: Accounts unavailable/);
  });
  test('the actual PDF picker cannot replace an in-flight upload', async () => {
    const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1 });
    const file = f.context.pendingPdfFile;
    const running = f.context.importPDF();
    f.context.onPdfSelected({ target: { files: [{ name: 'next.pdf', size: 1024 }] } });
    assert.equal(f.context.pendingPdfFile, file);
    assert.match(f.node('import-result').innerHTML, /already running/);
    await running;
    assert.equal(f.requests.length, 1);
  });
  test('post-import account refresh failures remain visible alongside the saved result', async () => {
    const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1 });
    f.context.FinanceAccounts.afterImport = async () => { throw new Error('Connection lost'); };
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /PDF Import Complete[^]*PDF imported, but account refresh failed: Connection lost/);
  });
  test('unreadable server responses and timeouts explain an unknown PDF outcome', async () => {
    const f = pdfUploadFixture(200, {});
    f.context.fetch = async () => ({ ok: false, status: 502, json: async () => { throw new Error('Unexpected HTML'); } });
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /unreadable response \(502\)[^]*outcome is unknown/);
    f.context.fetch = async () => { const error = new Error('Timed out'); error.name = 'TimeoutError'; throw error; };
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /timed out[^]*may still be processing/);
    assert.equal(f.node('pdf-import-btn').disabled, false);
  });
  f.context.notify = message => messages.push(message);
  f.run('refresh.js'); f.run('accounts.js');
  await f.context.FinanceAccounts.loadPage();
  const fields = [{ name: 'kind', value: '' }];
  const card = { dataset: { account: '2', review: 'true' }, querySelector: selector => selector === '.acct-form'
    ? { querySelectorAll: () => fields } : { focus() {} } };
  const button = { dataset: { act: 'save' }, closest: () => card };
  const event = { target: { closest: selector => selector === '#accounts-root button[data-act]' ? button : null }, preventDefault() {} };
  await f.listeners.get('document:click')(event);
  assert.equal(changes.length, 0);
  assert.match(messages.at(-1), /Choose your account type/);
  button.dataset.act = 'external';
  await f.listeners.get('document:click')(event);
  assert.deepEqual(changes, [{ kind: 'external' }]);
  assert.match(f.node('accounts-root').innerHTML, /Other people &amp; external recipients/);
  assert.match(messages.at(-1), /Money sent counts as spending; money received counts as other income/);
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
test('deposits get an editable income toggle that can un-count a whole sender', async () => {
  const calls = [];
  const transactions = [
    { id: '1', date: '2026-09-26', description: 'ZELLE FROM JANE DOE 8812', amount: 400, direction: 'CREDIT', category: 'Income', counts_as_income: true, income_role: null },
    { id: '2', date: '2026-09-12', description: 'ZELLE FROM JANE DOE 1203', amount: 400, direction: 'CREDIT', category: 'Income', counts_as_income: true, income_role: null },
    { id: '3', date: '2026-09-10', description: 'NETFLIX', amount: 15, direction: 'DEBIT', category: 'Subscriptions', is_fixed: true }
  ];
  const f = fixture(async (url, options = {}) => {
    calls.push([url, options.body ? JSON.parse(options.body) : null]);
    if (url === '/api/categories') return response(200, [{ name: 'Income' }, { name: 'Subscriptions' }]);
    if (url === '/api/dashboard/all-transactions') return response(200, { transactions });
    return response(200, { success: true, updated: 1 });
  });
  f.run('refresh.js');
  await f.context.loadAllTransactions();
  const html = f.node('full-txn-table').innerHTML;
  assert.equal((html.match(/data-income /g) || []).length, 2);
  assert.equal((html.match(/data-fixed /g) || []).length, 1);
  assert.doesNotMatch(html, /disabled title="Only debit/);
  assert.match(html, /Counts as income: ZELLE FROM JANE DOE 8812" checked/);
  assert.deepEqual(f.context.findSimilarTransactions(transactions, transactions[0], { income: false }).map(item => item.transaction.id), ['2']);
  const box = { checked: false, disabled: false, matches: selector => selector === '[data-income]', closest: () => ({ dataset: { transaction: '0' } }) };
  const pending = f.node('full-txn-table').onchange({ target: box });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.node('similar-title').textContent, 'Apply to other deposits from this sender?');
  assert.match(f.node('similar-list').innerHTML, /Income &rarr; Not income/);
  assert.match(f.node('similar-list').innerHTML, /data-similar="0" checked/);
  f.node('similar-list').querySelectorAll = () => [{ checked: true, dataset: { similar: '0' } }];
  await f.node('similar-form').onsubmit({ preventDefault() {} });
  await pending;
  const updates = calls.filter(([url]) => url === '/api/transactions/update-income-role').map(([, body]) => body);
  assert.deepEqual(updates, [{ ids: [1], income_role: 'other' }, { ids: [2], income_role: 'other' }]);
});
test('income review lists sources safely and switches a whole sender off', async () => {
  const calls = [];
  let sources = [
    { key: 'zelle jane doe', name: '<b>Jane</b>', status: 'income', by: 'category', reason: 'Category is Income', regular: true, cadence: 'biweekly', cadenceLabel: 'Every other Fri',
      expected: 400, count: 3, counted: 3, total: 1200, average: 400, lastDate: '2026-09-26', ids: [1, 2, 9],
      transactions: [{ id: 1, date: '2026-09-26', description: 'ZELLE FROM JANE', amount: 400, category: 'Income', counted: true, by: 'category' }] },
    { key: 'acme payroll', name: 'Acme Payroll', status: 'other', by: 'you', reason: 'You marked this as not income', regular: false, count: 4, counted: 0, total: 8000, average: 2000, lastDate: '2026-09-25', ids: [5], transactions: [] }
  ];
  const f = fixture(async (url, options = {}) => {
    calls.push([url, options.body ? JSON.parse(options.body) : null]);
    if (url === '/api/transactions/income-sources') return response(200, { sources });
    return response(200, { success: true, updated: 3 });
  });
  f.run('refresh.js'); f.run('income-review.js');
  const dialog = f.node('body').options.find(child => child.id === 'income-review');
  await f.context.FinanceIncome.open();
  assert.equal(dialog.open, true);
  const body = f.node('income-review-body').innerHTML;
  assert.match(body, /&lt;b&gt;Jane&lt;\/b&gt;/);
  assert.doesNotMatch(body, /<b>Jane/);
  assert.match(body, /Counted as income[\s\S]*Every other Fri[\s\S]*Not counted[\s\S]*Reset to automatic/);
  assert.match(body, /data-ir-role="income" aria-pressed="true"/);
  assert.match(body, /href="#transactions\/1">ZELLE FROM JANE/);
  assert.match(f.node('income-review-summary').innerHTML, /1<\/strong> counted as pay[\s\S]*\/mo expected[\s\S]*set by you/);
  const button = { dataset: { irRole: 'other' }, closest: () => ({ dataset: { irKey: 'zelle jane doe' } }) };
  dialog.listeners.click({ target: { closest: selector => selector === '[data-ir-role]' ? button : null } });
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  const updates = calls.filter(([url]) => url === '/api/transactions/update-income-role').map(([, body]) => body);
  assert.deepEqual(updates, [{ ids: [1, 2, 9], income_role: 'other' }]);
  let invalidated = false;
  f.context.FinancePlan = { invalidate: () => { invalidated = true; } };
  dialog.close();
  assert.equal(invalidated, true);
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
  f.node('body').classList.remove('auth-pending');
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
test('brand mark is a scalable green SVG used on the marketing nav, sign-in and in navigation', () => {
  const html = source('index.html');
  assert.equal((html.match(/class="brand-mark(?: small)?"/g) || []).length, 3);
  assert.equal((html.match(/class="brand-mark-bg"/g) || []).length, 3);
  assert.equal((html.match(/class="brand-mark-line"/g) || []).length, 3);
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
  assert.equal(f.node('auth-token-label').hidden, true, 'the owner token stays hidden until first-run setup is chosen');
  assert.equal(f.node('auth-submit').textContent, 'Sign in');
  assert.equal(f.node('auth-setup').hidden, false);
  f.node('auth-setup').onclick();
  assert.equal(f.node('auth-token-label').hidden, false);
  assert.equal(f.node('auth-token').required, true);
  assert.equal(f.node('auth-setup').hidden, true);
  assert.equal(f.node('auth-switch').hidden, false);
  assert.equal(f.node('auth-switch').textContent, 'Back to sign in');
  f.node('auth-switch').onclick();
  assert.equal(f.node('auth-token-label').hidden, true);
  assert.equal(f.context.lastView, undefined);
});
test('authenticated startup preserves account and exact transaction deep links', async () => {
  for (const route of ['accounts', 'transactions/42']) {
    const f = fixture(async () => response(200, { user: { id: 1, name: 'Test', email: 'test@example.test', role: 'user' } }));
    f.context.location.hash = `#${route}`;
    f.run('session.js');
    await f.context.FinanceSession.start();
    assert.equal(f.context.lastView, route);
  }
});
test('owner setup is never offered once the owner exists, and the admin link stays hidden for regular users', async () => {
  const f = fixture(async url => url.endsWith('/me') ? response(401, {}) : response(200, { setupRequired: false, registrationEnabled: false }));
  f.run('session.js');
  await f.context.FinanceSession.start();
  assert.equal(f.node('auth-token-label').hidden, true);
  assert.equal(f.node('auth-setup').hidden, true);
  const user = fixture(async url => url.endsWith('/me') ? response(200, { user: { id: 7, name: 'Demo', role: 'user' } }) : response(200, {}));
  user.node('nav-admin-item').hidden = true;
  user.run('session.js');
  await user.context.FinanceSession.start();
  assert.equal(user.node('nav-admin-item').hidden, true);
  const admin = fixture(async url => url.endsWith('/me') ? response(200, { user: { id: 1, name: 'Owner', role: 'admin' } }) : response(200, {}));
  admin.run('session.js');
  await admin.context.FinanceSession.start();
  assert.equal(admin.node('nav-admin-item').hidden, false);
  assert.match(source('index.html'), /id="nav-admin-item" hidden/);
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
test('transaction CSV exports preserve the exact-ID filter and drop it after reset', async () => {
  const f = loadPro(async url => response(200, url === '/api/categories' ? categoryData : { transactions: activity }));
  f.context.FinancePro.requirePro = () => true;
  f.context.showView('transactions/1');
  f.context.FinanceProCategories.exportTransactions();
  assert.match(f.context.location.href, /type=transactions&transactionId=1$/);
  await f.context.resetTransactionFilters();
  f.context.FinanceProCategories.exportTransactions();
  assert.equal(f.context.location.href, '/api/analytics/export.csv?type=transactions');
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
test('marketing page explains the app, all prices and exclusive Pro Plus access', () => {
  const html = source('index.html');
  assert.match(html, /your personal money workspace/);
  assert.match(html, /Illustrative preview/);
  assert.match(html, /id="marketing-pricing"/);
  assert.match(html, /\$0<span>\/ month/);
  assert.match(html, /\$4\.99<span>\/ month/);
  assert.match(html, /\$9\.98<span>\/ month total/);
  assert.equal((html.match(/Debt Free &amp; Savings Goals not included/g) || []).length, 2);
  assert.match(html, /Pro alone does not unlock Debt Free or Savings Goals/);
  assert.match(html, /not through online checkout/);
  assert.match(html, /ends automatically with no charge/);
  assert.match(source('marketing.css'), /prefers-reduced-motion/);
});
test('marketing page scrolls, has section navigation and a feature spotlight', () => {
  const html = source('index.html');
  const css = source('marketing.css');
  assert.match(css, /body\.auth-pending \{[^}]*overflow: visible/);
  assert.match(css, /\.marketing-nav \{[^}]*position: sticky/);
  for (const id of ['marketing-spotlight', 'marketing-benefits', 'marketing-pricing', 'marketing-signin']) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, new RegExp(`data-marketing-jump="${id}"`));
  }
  assert.match(html, /<nav class="marketing-links" aria-label="Page sections">/);
  assert.match(html, /Back to top/);
  assert.match(html, /<script src="marketing\.js/);
  assert.doesNotMatch(html, /<a href="#marketing-pricing">/, 'every in-page link is handled without the app router');
});
test('feature spotlight rotates through Free, Pro and Pro Plus features', () => {
  const f = fixture();
  browserBits(f, { reduced: false });
  f.context.document.hidden = false;
  f.run('marketing.js');
  const tour = f.context.FinanceMarketing;
  assert.equal(tour.slides.length, 7);
  assert.deepEqual([...new Set(tour.slides.map(slide => slide.tier))], ['FREE', 'PRO', 'PRO PLUS']);
  assert.ok(new Set(tour.slides.map(slide => slide.effect)).size >= 5, 'slides use varied transitions');
  const stage = f.node('marketing-spotlight-stage');
  assert.match(stage.innerHTML, /mk-fx-rise[\s\S]*Drop<\/span>[\s\S]*Get the story/);
  assert.match(f.node('marketing-spotlight-dots').innerHTML, /Show feature 7 of 7/);
  assert.equal(f.node('marketing-spotlight').classList.contains('is-running'), true);
  const click = target => f.node('marketing-spotlight').listeners.click({ target: { closest: () => target } });
  click({ id: '', dataset: { mkStep: '-1' } });
  assert.equal(tour.current(), 6);
  assert.match(stage.innerHTML, /PRO PLUS[\s\S]*a deadline/);
  click({ id: '', dataset: { mkGo: '3' } });
  assert.match(stage.innerHTML, /mk-fx-flip[\s\S]*repeat charges/);
  assert.doesNotMatch(stage.innerHTML, /subscription/i);
  click({ id: 'marketing-spotlight-toggle', dataset: {} });
  assert.equal(f.node('marketing-spotlight').classList.contains('is-running'), false, 'pause stops rotation');
  f.node('marketing-spotlight-dots').listeners.animationend({ animationName: 'mk-fill' });
  assert.equal(tour.current(), 3, 'a paused tour does not advance');
  click({ id: 'marketing-spotlight-toggle', dataset: {} });
  f.node('marketing-spotlight-dots').listeners.animationend({ animationName: 'mk-fill' });
  assert.equal(tour.current(), 4);
  let scrolled = '';
  f.node('marketing-pricing').scrollIntoView = () => { scrolled = 'pricing'; };
  let prevented = false;
  f.node('auth-screen').listeners.click({ button: 0, preventDefault: () => { prevented = true; }, target: { closest: () => ({ dataset: { marketingJump: 'marketing-pricing' }, hasAttribute: () => false }) } });
  assert.equal(prevented, true);
  assert.equal(scrolled, 'pricing');
});
test('marketing start opens registration only when registration is enabled', async () => {
  for (const registrationEnabled of [true, false]) {
    const f = fixture(async url => url.endsWith('/me') ? response(401, {}) : response(200, { setupRequired: false, registrationEnabled }));
    f.run('session.js');
    await f.context.FinanceSession.start();
    f.node('marketing-start').listeners.click();
    assert.equal(f.node('auth-title').textContent, registrationEnabled ? 'Make room for your next chapter.' : 'Welcome back.');
    assert.equal(f.node('auth-switch').hidden, !registrationEnabled);
  }
});
test('pricing cards let visitors choose a plan that is requested after sign-in', async () => {
  const html = source('index.html');
  for (const plan of ['free', 'pro', 'pro_plus']) assert.match(html, new RegExp(`data-choose-plan="${plan}" aria-pressed="false"`));
  assert.doesNotMatch(html, /Find my next step|>Explore Pro<|Start with Free/);
  assert.match(html, /<a class="marketing-brand"[^>]*><svg class="brand-mark"/, 'the nav uses the same logo as the app');
  assert.match(html, /id="auth-plan"/);
  const storage = new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const visit = signedIn => {
    const calls = [];
    const f = fixture(async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/me')) return signedIn ? response(200, { user: { id: 3, name: 'Sam' } }) : response(401, {});
      if (url === '/api/license/request') return response(200, { tier: 'free', request: { plan: 'pro_plus' } });
      return response(200, { setupRequired: false, registrationEnabled: true });
    });
    f.context.localStorage = localStorage;
    const buttons = ['free', 'pro', 'pro_plus'].map(plan => Object.assign(f.node(`choose-${plan}`), { dataset: { choosePlan: plan }, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } }));
    const all = f.context.document.querySelectorAll;
    f.context.document.querySelectorAll = selector => selector === '[data-choose-plan]' ? buttons : all(selector);
    f.run('session.js');
    return { f, calls, buttons };
  };
  const out = visit(false);
  await out.f.context.FinanceSession.start();
  assert.equal(out.f.node('auth-plan').hidden, true, 'no banner until a plan is chosen');
  out.buttons[2].listeners.click();
  assert.equal(storage.get('myfinance.chosenPlan'), 'pro_plus');
  assert.equal(out.buttons[2].attrs['aria-pressed'], 'true');
  assert.equal(out.buttons[1].attrs['aria-pressed'], 'false');
  assert.match(out.buttons[2].textContent, /Pro Plus selected/);
  assert.equal(out.buttons[1].textContent, 'Choose Pro');
  assert.equal(out.f.node('auth-plan').hidden, false);
  assert.equal(out.f.node('auth-plan-name').textContent, 'Pro Plus');
  assert.match(out.f.node('auth-plan-note').textContent, /administrator to approve\. Nothing is charged here/);
  assert.equal(out.f.node('auth-title').textContent, 'Make room for your next chapter.', 'choosing a plan opens account creation');
  assert.equal(out.calls.some(call => call.url === '/api/license/request'), false, 'nothing is requested while signed out');

  const notes = [];
  const back = visit(true);
  back.f.context.notify = message => notes.push(message);
  await back.f.context.FinanceSession.start();
  const sent = back.calls.find(call => call.url === '/api/license/request');
  assert.equal(sent.options.method, 'POST');
  assert.deepEqual(JSON.parse(sent.options.body), { plan: 'pro_plus' });
  assert.match(notes[0], /Pro Plus request was sent to your MyFinance administrator/);
  assert.equal(storage.has('myfinance.chosenPlan'), false, 'the choice is only sent once');
});
test('the upgrade dialog is a plan picker that requests and cancels plans', async () => {
  const calls = [];
  const f = loadPro(async (url, options = {}) => {
    calls.push({ url, method: options.method });
    if (url === '/api/license/request' && options.method === 'POST') return response(200, { tier: 'free', active: false, request: { plan: JSON.parse(options.body).plan, requestedAt: '2026-10-18T12:00:00Z' }, features: [] });
    if (url === '/api/license/request') return response(200, { tier: 'free', active: false, features: [] });
    return response(200, {});
  });
  const pro = f.context.FinancePro;
  const dialog = f.node('pro-dialog');
  dialog.tagName = 'DIALOG';
  pro.setEntitlement({ tier: 'free', active: false, trialAvailable: false, features: [] });
  pro.requireProPlus('Savings goals');
  assert.match(dialog.innerHTML, /role="radiogroup"/);
  assert.match(dialog.innerHTML, /value="pro_plus" checked/, 'the plan the page needs is preselected');
  assert.match(dialog.innerHTML, /Request Pro Plus/);
  assert.doesNotMatch(dialog.innerHTML, /Start 7-day free trial/, 'the trial is only offered while available');
  pro.openUpgrade('', 'pro', 'pro');
  assert.match(dialog.innerHTML, /value="pro" checked/);
  assert.match(dialog.innerHTML, /Request Pro</);
  await dialog.querySelector('[data-pro-request]').listeners.click({ target: {} });
  assert.deepEqual(calls.at(-1), { url: '/api/license/request', method: 'POST' });
  assert.equal(pro.entitlement().request.plan, 'pro');
  assert.match(pro.planLabel().detail, /Pro requested/);
  assert.match(dialog.innerHTML, /Pro requested \u2713/);
  assert.match(dialog.innerHTML, /Cancel request/);
  await dialog.querySelector('[data-pro-cancel]').listeners.click({ target: {} });
  assert.deepEqual(calls.at(-1), { url: '/api/license/request', method: 'DELETE' });
  assert.equal(pro.entitlement().request, undefined);
  pro.setEntitlement({ tier: 'pro', active: true, plusActive: false, features: [] });
  pro.openUpgrade();
  assert.match(dialog.innerHTML, /value="pro"[^>]*disabled/, 'the current plan cannot be requested again');
  assert.match(dialog.innerHTML, /Your plan/);
  assert.match(dialog.innerHTML, /value="pro_plus" checked/);
});
test('Pro does not unlock Pro Plus; trials and full-access accounts do', () => {
  const f = loadPro();
  const pro = f.context.FinancePro;
  f.node('pro-dialog').tagName = 'DIALOG';
  pro.setEntitlement({ tier: 'pro', active: true, plusActive: false, features: [] });
  assert.equal(pro.requirePro('Budgets'), true);
  assert.equal(pro.requireProPlus('Savings goals'), false);
  assert.equal(f.node('pro-dialog').open, true);
  assert.match(f.node('pro-dialog').innerHTML, /\$9\.98/);
  assert.match(f.node('pro-dialog').innerHTML, /Does not unlock Debt Free or Savings Goals/);
  assert.match(f.node('pro-dialog').innerHTML, /Ask your MyFinance administrator/);
  for (const tier of ['pro_plus', 'trial', 'pro']) {
    pro.setEntitlement({ tier, active: true, plusActive: true, daysLeft: 7, features: [] });
    assert.equal(pro.requireProPlus('Debt free'), true);
    assert.match(pro.planLabel().title, /Pro Plus/);
  }
});
test('direct debt and goals loads show a full-page Pro Plus lock for Free and Pro', async () => {
  for (const tier of ['free', 'pro']) {
    const f = loadPlan(async () => response(402, { code: 'PRO_PLUS_REQUIRED', error: 'Pro Plus required', entitlement: { tier, active: tier === 'pro', plusActive: false } }));
    await f.context.loadPayoffPlan();
    await f.context.loadGoals();
    for (const id of ['plan-debt-root', 'plan-goals-root']) {
      const html = f.node(id).innerHTML;
      assert.match(html, /plus-page-lock/);
      assert.match(html, /\$9\.98\/month total/);
      assert.match(html, /Explore Pro Plus/);
      assert.doesNotMatch(html, /data-act="add-(debt|goal)"/);
    }
    assert.equal(f.context.FinancePlan.state.plan, null);
    assert.equal(f.context.FinancePro.isActive(), tier === 'pro');
    assert.equal(f.context.FinancePro.isPlusActive(), false);
  }
});
test('session request errors preserve the Pro Plus gate for page loaders', async () => {
  const f = fixture(async url => url.endsWith('/me')
    ? response(200, { user: { id: 2, name: 'Customer' } })
    : response(402, { code: 'PRO_PLUS_REQUIRED', error: 'Pro Plus required', entitlement: { plusActive: false } }));
  f.run('session.js');
  await f.context.FinanceSession.start();
  await assert.rejects(f.context.fetch('/api/plan'), error => error.code === 'PRO_PLUS_REQUIRED' && error.status === 402 && error.entitlement.plusActive === false);
});
test('entitlement lookup failures remain errors rather than pretending Free is active', async () => {
  const f = loadPro(async () => response(500, { error: 'License service unavailable' }));
  await assert.rejects(f.context.FinancePro.ensureEntitlement(), /License service unavailable/);
  assert.equal(f.context.FinancePro.entitlement(), null);
});
test('analytics page shows a locked preview without Pro', async () => {
  const f = loadPro(async url => url === '/api/license'
    ? response(200, { tier: 'free', source: 'trial-expired', active: false, trialAvailable: false, features: [] })
    : response(402, { error: 'Pro required', code: 'PRO_REQUIRED' }));
  await f.context.loadAnalyticsPage();
  assert.match(f.node('analytics-content').innerHTML, /Your Pro trial has ended/);
  assert.match(f.node('analytics-actions').innerHTML, /pro-lock/);
});

test('analytics keeps the overview light and renders the Spending Compass on its own tab', async () => {
  const { buildDemoData } = await import('../backend/utils/demo.js');
  const { buildAnalytics } = await import('../backend/utils/analytics.js');
  const { buildMoneyFlowSignals } = await import('../backend/utils/benchmarks.js');
  const now = new Date();
  const demo = buildDemoData(now);
  const payload = JSON.parse(JSON.stringify({
    ...buildAnalytics({ transactions: demo.transactions, budgets: [], latestBalance: 9500, today: now }),
    moneyFlow: buildMoneyFlowSignals({ transactions: demo.transactions, profile: demo.household, today: now })
  }));
  const f = loadPro(async url => url === '/api/license'
    ? response(200, { tier: 'pro', source: 'owner', active: true, features: [] })
    : response(200, payload));
  await f.context.loadAnalyticsPage(true, '');
  const overview = f.node('analytics-content').innerHTML;
  assert.match(overview, /class="pro-tab is-active" aria-current="page">Overview/);
  assert.match(overview, /href="#analytics\/compass" data-view="analytics\/compass"[^>]*>Spending Compass<span class="pro-tab-badge">\$\d[\d,]*\/mo/);
  assert.doesNotMatch(overview, /YOUR COMPASS FOUND|Where your money flows|Technical readings/);
  assert.doesNotMatch(overview, /#tutorials\/compass/);
  assert.equal(f.node('analytics-heading').textContent, 'Your spending, like a market');

  await f.context.loadAnalyticsPage(false, 'compass');
  const html = f.node('analytics-content').innerHTML;
  assert.equal(f.node('analytics-heading').textContent, 'Spending Compass');
  assert.match(html, /class="pro-tab is-active" aria-current="page">Spending Compass/);
  assert.match(html, /class="pro-tab-help" href="#tutorials\/compass">[^<]*How it works/);
  assert.match(html, /Compared with a typical 2-person household in the Northeast that owns its home/);
  assert.doesNotMatch(html, /Monthly spend trend|Category signals/);
  const mf = payload.moneyFlow;
  // Hero: savings now, per year and over five years, with a plan item per opportunity.
  assert.match(html, /YOUR COMPASS FOUND<\/p><strong class="pro-hero-figure">\$\d[\d,]* a month/);
  assert.match(html, /over 5 years/);
  assert.equal((html.match(/<ol class="pro-hero-plan">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length, mf.opportunities.length);
  assert.match(html, /<b>Dining<\/b><small>\$\d[\d,]* &rarr; \$\d[\d,]* a month/);
  // Insight cards, money-flow Sankey, signal Venn and the percentile range strips.
  assert.equal((html.match(/class="pro-insight tone-/g) || []).length, mf.insights.length);
  assert.ok(mf.insights.length >= 2 && mf.insights.length <= 4);
  assert.match(html, /Where your money flows/);
  assert.match(html, /<svg class="pro-sankey"[^>]*aria-label="Money flow: income/);
  assert.match(html, /Of every \$100 you bring home: .*left over/);
  assert.match(html, /<svg class="pro-venn"/);
  assert.match(html, /Above similar homes[\s\S]*Trending up[\s\S]*Unusual last month/);
  // The Venn takes the full row with its overlap spelled out beside it, strongest signals first.
  assert.match(html, /<div class="pro-venn-layout"><svg class="pro-venn" viewBox="0 0 560 446"/);
  const flagged = mf.categories.filter(c => c.benchmarkStatus === 'high' || c.benchmarkStatus === 'above' || c.rising || c.spike || c.band?.position === 'above');
  const readStart = html.indexOf('<div class="pro-venn-read">');
  const reading = html.slice(readStart, html.indexOf('class="pro-card', readStart));
  assert.equal((reading.match(/<li><strong>/g) || []).length, flagged.length);
  assert.match(html, /Reading the overlap/);
  assert.equal((html.match(/class="pro-range-row"/g) || []).length, mf.categories.length);
  assert.match(html, /5th&ndash;95th percentile/);
  // Merchant bubbles (positioned client-side) and the category heatmap.
  assert.match(html, /Who gets your money/);
  assert.equal((html.match(/class="pro-bubble" data-bubble="/g) || []).length, mf.vendors.items.length);
  assert.match(html, /data-bubble-size="spend" aria-pressed="true"[\s\S]*data-bubble-color="change" aria-pressed="true"/);
  assert.match(html, /Your top 5 merchants take <b>\d+%<\/b> of everyday spending/);
  assert.match(html, /one-off purchase/, 'the demo TV is set aside');
  assert.match(html, /Hot and cold months/);
  assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/g).find(b => b.includes('pro-heat-cell')).match(/<tr/g) || []).length, mf.heatmap.rows.length + 1);
  assert.match(html, /<b>[A-Z][a-z]{2} \d{4}<\/b> was your hottest month/);
  assert.match(html, /<details class="pro-mf-details panel"><summary><span>Technical readings/);
  assert.match(html, /Purchases &times; size/);
  assert.match(html, /data-analytics-action="household-save"/);
  assert.match(html, /Consumer Expenditure Survey/);
  assert.doesNotMatch(html, /undefined|NaN|Infinity/);
  // Polished Sankey: labelled blocks with their share of income, one gradient per ribbon, a colour key.
  assert.match(html, /<text[^>]*class="pro-sk-in">Income<\/text>/);
  assert.match(html, /class="pro-sk-in">Fixed bills<\/text><text[^>]*class="pro-sk-in-sub">\$[\d,]+ · \d+%/);
  assert.equal((html.match(/<linearGradient id="pro-sk-g/g) || []).length, (html.match(/class="pro-sk-band"/g) || []).length);
  assert.match(html, /class="pro-sk-legend"/);
  await f.context.loadAnalyticsPage(true);
  assert.match(f.node('analytics-content').innerHTML, /Where your money flows/, 'a reload after saving stays on the Compass');

  // A month that spends more than came in shows the shortfall under income instead of a "left over" block.
  payload.moneyFlow.flow = { ...mf.flow, left: -300, everyday: { ...mf.flow.everyday, total: mf.flow.everyday.total + 300 - mf.flow.left } };
  await f.context.loadAnalyticsPage(true, 'compass');
  const over = f.node('analytics-content').innerHTML;
  assert.match(over, /Overspent \$300\/mo/);
  assert.doesNotMatch(over, /class="pro-sk-in">Left over/);
  assert.doesNotMatch(over, /undefined|NaN|Infinity/);
});

const browserBits = (f, { reduced = true } = {}) => {
  const store = new Map();
  const base = f.context.document.getElementById;
  f.context.document.getElementById = id => {
    const el = base(id);
    el.style.setProperty ||= function (key, value) { this[key] = value; };
    el.getBoundingClientRect ||= () => ({ left: 0, top: 0, width: 800, height: 450 });
    el.contains ||= () => true;
    el.children ||= [];
    return el;
  };
  Object.assign(f.context, {
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) },
    matchMedia: () => ({ matches: reduced }), performance: { now: () => 0 },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}
  });
  return store;
};
test('dashboard welcome greets, ranks insights, escapes text and offers the tour once', async () => {
  const insights = { asOf: '2026-10-15', insights: [
    { id: 'runway', tone: 'danger', icon: 'alert', title: 'Balance dips <below> zero on the 28th', detail: 'Move a payment.', action: { label: 'See upcoming', act: 'upcoming' } },
    { id: 'budget', tone: 'warning', icon: 'gauge', title: 'Dining is over budget', detail: 'x', action: null }
  ], pulse: { balance: 1520.5, lowPoint: { day: 28, amount: -40 }, billsLeft: { count: 3, total: 900 }, nextIncome: { amount: 2450, day: 23, daysAway: 1 }, debtFreeDate: '2028-09',
    safeToSpend: { amount: 1240.5, committed: 280, count: 2, untilDay: 23 }, lastImport: { daysAgo: 9, latestDate: '2026-10-06' } } };
  const f = fixture(async url => url === '/api/dashboard/insights' ? response(200, insights) : response(200, {}));
  const store = browserBits(f);
  f.run('welcome.js');
  await f.context.FinanceWelcome.load();
  const html = f.node('welcome-hero').innerHTML;
  assert.doesNotMatch(html, /welcome-attention|welcome-mood|One thing needs your attention today/);
  assert.match(html, /<\/h1>\s*<\/div>[\s\S]*?<\/div>\s*<section class="welcome-carousel"/);
  assert.match(html, /Balance dips &lt;below&gt; zero/);
  assert.doesNotMatch(html, /<below>/);
  assert.match(html, /Next payday[\s\S]*Tomorrow/);
  assert.match(html, /Lowest point ahead[\s\S]*−\$40/);
  assert.match(html, /Safe to spend[\s\S]*\$1,241[\s\S]*Until payday · the 23rd/);
  assert.match(html, /Last import[\s\S]*9 days ago[\s\S]*Newest transaction Oct 6/);
  assert.match(html, /Take a one-minute tour/);
  assert.match(html, /1 \/ 3/);
  assert.match(html, /<mark class="welcome-hl">28th<\/mark>/);
  assert.match(html, /fx-rise[\s\S]*fx-pop[\s\S]*fx-swipe/);
  const slides = [...html.matchAll(/<article class="welcome-slide[^]*?<\/article>/g)].map(match => match[0]);
  assert.equal(slides.length, 3);
  assert.match(slides[0], /tone-danger[^]*welcome-slide-tone">Action needed<\/span>[^]*Balance dips &lt;below&gt; zero[^]*Move a payment\.[^]*data-welcome-action="0">See upcoming/);
  assert.match(slides[1], /tone-warning[^]*welcome-slide-tone">Heads up<\/span>[^]*Dining is over budget/);
  assert.match(html, /⚠️[\s\S]*🔥/);
  f.context.FinanceWelcome.markTourSeen();
  assert.equal(store.get('mf.tutorials.dashboardSeen'), '1');
  await f.context.FinanceWelcome.load();
  assert.doesNotMatch(f.node('welcome-hero').innerHTML, /Take a one-minute tour/);
});
test('a failed insights load shows a retry in the welcome hero', async () => {
  const f = fixture(async () => response(500, { error: 'Insights offline' }));
  browserBits(f);
  f.run('welcome.js');
  await f.context.FinanceWelcome.load();
  assert.match(f.node('welcome-hero').innerHTML, /Insights offline[\s\S]*data-welcome-retry/);
});
test('tutorial deep links open the right walkthrough and chapter', () => {
  const f = fixture();
  browserBits(f);
  f.run('tutorial.js');
  const tours = f.context.FinanceTutorials;
  assert.equal(tours.list().map(item => item.id).join(), 'debt,goals,dashboard,fixed,categories,transactions,compass');
  tours.open('debt-strategies');
  assert.equal(tours.state.tutorial.id, 'debt');
  assert.equal(tours.state.tutorial.scenes[tours.state.index].id, 'strategy');
  assert.equal(tours.state.playing, false, 'reduced motion never autoplays');
  assert.match(f.node('tut-caption').textContent, /\w/);
  tours.open('debt-dates');
  assert.equal(tours.state.tutorial.scenes[tours.state.index].id, 'dates');
  assert.match(f.node('tut-caption').textContent, /same order|match/i);
  tours.open('goals');
  assert.equal(tours.state.tutorial.id, 'goals');
  assert.equal(tours.state.index, 0);
  tours.go(99);
  assert.equal(tours.state.index, tours.state.tutorial.scenes.length - 1);
  assert.match(f.node('tutorial-root').innerHTML, /All tutorials/);
});
test('spending compass tutorial walks through the plan, money flow, overlapping signals and fairness', () => {
  const f = fixture();
  browserBits(f);
  f.run('tutorial.js');
  const tours = f.context.FinanceTutorials;
  tours.open('compass');
  const tutorial = tours.state.tutorial;
  assert.equal(tutorial.id, 'compass');
  assert.equal(tutorial.cta.view, 'analytics/compass');
  assert.equal(tutorial.scenes.map(scene => scene.id).join(), 'intro,open,household,flow,signals,fair,done');
  tutorial.scenes.forEach((scene, index) => {
    tours.go(index);
    assert.match(f.node('tut-canvas').innerHTML, /\S/, `compass/${scene.id} renders`);
    assert.doesNotMatch(f.node('tut-canvas').innerHTML, /undefined|\[object Object\]/, `compass/${scene.id} has no template leaks`);
  });
  const total = tutorial.scenes.reduce((sum, scene) => sum + Math.max(6500, scene.caption.split(/\s+/).length * 330 + 1800), 0);
  assert.ok(total >= 60000 && total < 120000, `"under 2 minutes" matches the real length (${total} ms)`);
  tours.open('spending-compass');
  assert.equal(tours.state.tutorial.id, 'compass');
  tours.open('compass-signals');
  assert.equal(tours.state.tutorial.scenes[tours.state.index].id, 'signals');
  assert.match(f.node('tut-caption').textContent, /above similar homes[\s\S]*trending up[\s\S]*unusual last month[\s\S]*9 in 10/i);
  assert.match(f.node('tut-canvas').innerHTML, /tm-venn[\s\S]*tm-range-band/);
  tours.open('compass/flow');
  assert.match(f.node('tut-caption').textContent, /fixed bills, everyday spending and what is left over/);
  assert.match(f.node('tut-canvas').innerHTML, /tm-sankey[\s\S]*tm-insight/);
  tours.open('compass/household');
  assert.match(f.node('tut-caption').textContent, /No other MyFinance user's data/);
  tours.open('compass/fair');
  assert.match(f.node('tut-caption').textContent, /\$250[\s\S]*same months last year/);
});
test('fixed, categories and transactions tutorials explain when to use each page', () => {
  const f = fixture();
  browserBits(f);
  f.run('tutorial.js');
  const tours = f.context.FinanceTutorials;
  const ctas = { fixed: 'transactions', categories: 'categories', transactions: 'transactions' };
  for (const [id, view] of Object.entries(ctas)) {
    tours.open(id);
    const tutorial = tours.state.tutorial;
    assert.equal(tutorial.id, id);
    assert.equal(tutorial.cta.view, view);
    assert.deepEqual([tutorial.scenes[0].id, tutorial.scenes.at(-1).id], ['intro', 'done']);
    assert.ok(tutorial.scenes.some(scene => scene.id === 'why'), `${id} has a "which page when" chapter`);
    tutorial.scenes.forEach((scene, index) => {
      tours.go(index);
      assert.match(f.node('tut-canvas').innerHTML, /\S/, `${id}/${scene.id} renders`);
      assert.doesNotMatch(f.node('tut-canvas').innerHTML, /undefined|\[object Object\]/, `${id}/${scene.id} has no template leaks`);
    });
  }
  tours.open('fixed/why');
  assert.match(f.node('tut-caption').textContent, /when money moves[\s\S]*Categories when you care what money is for/);
  tours.open('categories/why');
  assert.match(f.node('tut-caption').textContent, /Categories answer where[\s\S]*Transactions answer what exactly happened/);
  tours.open('transactions/why');
  assert.match(f.node('tut-canvas').innerHTML, /For detail[\s\S]*For patterns[\s\S]*For timing/);
  tours.open('income');
  assert.equal(tours.state.tutorial.id, 'fixed');
  assert.equal(tours.state.tutorial.scenes[tours.state.index].id, 'income');
  tours.open('categorization');
  assert.equal(tours.state.tutorial.id, 'categories');
  const html = source('index.html');
  assert.match(html, /href="#tutorials\/categories"/);
  assert.match(html, /href="#tutorials\/transactions"/);
  assert.match(html, /href="#tutorials\/fixed"/);
});
test('signed-out hash links never reach the app router', () => {
  const f = fixture(); f.run('refresh.js');
  f.context.location.hash = '#marketing-pricing';
  f.listeners.get('hashchange')();
  assert.equal(f.context.location.hash, '#marketing-pricing');
  f.node('body').classList.remove('auth-pending');
  f.context.location.hash = '#transactions';
  f.listeners.get('hashchange')();
  assert.equal(f.context.location.hash, '#transactions');
  f.context.location.hash = '#marketing-pricing';
  f.listeners.get('hashchange')();
  assert.equal(f.context.location.hash, '#dashboard');
});
test('the router keeps a tutorial sub-path and hands it to the player', () => {
  const f = fixture(); f.run('refresh.js');
  const opened = [];
  f.context.FinanceTutorials = { open: sub => opened.push(sub) };
  f.context.showView('tutorials/debt-strategies');
  assert.equal(f.context.location.hash, '#tutorials/debt-strategies');
  assert.equal(opened.join(), 'debt-strategies');
  f.context.showView('payoff/anything');
  assert.equal(f.context.location.hash, '#payoff');
  const tabs = [];
  f.context.loadAnalyticsPage = (force, sub) => tabs.push(sub);
  f.context.showView('analytics/compass');
  assert.equal(f.context.location.hash, '#analytics/compass');
  assert.equal(f.node('current-page').textContent, 'Spending Compass');
  f.context.showView('analytics/unknown');
  assert.equal(f.context.location.hash, '#analytics');
  assert.deepEqual(tabs, ['compass', '']);
});
test('strategy cards explain the dates, the first target and identical orders', async () => {
  const payload = planPayload();
  payload.debtPlan.comparison = [
    { id: 'avalanche', feasible: true, debtFree: true, debtFreeDate: '2028-09', totalInterest: 2900, order: ['1', '2'], firstTarget: '<Visa>' },
    { id: 'snowball', feasible: true, debtFree: true, debtFreeDate: '2028-09', totalInterest: 2900, order: ['1', '2'], firstTarget: '<Visa>' },
    { id: 'interest', locked: true }
  ];
  const f = loadPlan(async () => response(200, payload));
  await f.context.loadPayoffPlan();
  const html = f.node('plan-debt-root').innerHTML;
  assert.match(html, /Using Avalanche/);
  assert.match(html, /Extra goes to <b>&lt;Visa&gt;<\/b> first/);
  assert.match(html, /Avalanche and Snowball<\/b> attack your debts in the same order/);
  assert.match(html, /href="#tutorials\/debt-strategies"/);
});
test('renamed payees show the friendly name, stay searchable and can be renamed from any row', async () => {
  const calls = [];
  const rows = [
    { id: 1, date: '2026-10-03', description: 'SENT 626800I0ARPL Zelle CRISTIANE DE LIMA', display_name: 'Tutor <Cristiane>', amount: 100, direction: 'DEBIT', category: 'Other' },
    { id: 2, date: '2026-09-03', description: 'SENT 51XQ Zelle CRISTIANE DE LIMA', display_name: 'Tutor <Cristiane>', amount: 100, direction: 'DEBIT', category: 'Gifts' },
    { id: 3, date: '2026-10-05', description: 'SENT 77ZZ Zelle SAM PATEL', amount: 40, direction: 'DEBIT', category: 'Other' }
  ];
  const f = fixture(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push([url, options.method || 'GET', body]);
    if (url === '/api/categories') return response(200, categoryData);
    if (url === '/api/dashboard/all-transactions') return response(200, { transactions: rows });
    if (url === '/api/transactions/name-rules/preview') return response(200, body.description
      ? { suggested: 'ZELLE SAM PATEL', current: null, pattern: 'ZELLE SAM PATEL', count: 4, samples: ['SENT 77ZZ Zelle SAM PATEL'] }
      : { pattern: body.pattern.toUpperCase(), count: 4, samples: ['SENT 77ZZ Zelle SAM PATEL'] });
    if (url === '/api/transactions/name-rules') return response(200, { success: true, rule: { id: 9, pattern: 'ZELLE SAM PATEL', name: 'Sam Patel', matches: 4 }, changed: 4 });
    return response(200, {});
  });
  f.run('refresh.js');
  await f.context.loadAllTransactions();
  const html = f.node('full-txn-table').innerHTML;
  assert.match(html, /<strong class="tx-name">Tutor &lt;Cristiane&gt;<\/strong><div class="tx-original" title="Bank description">SENT 626800I0ARPL Zelle CRISTIANE DE LIMA/);
  assert.equal((html.match(/data-rename /g) || []).length, 3, 'every row offers Rename');
  assert.equal(f.context.matchesTransactionSearch(rows[0], 'tutor'), true, 'search finds the friendly name');
  assert.equal(f.context.matchesTransactionSearch(rows[2], 'tutor'), false);
  // Similar-transaction prompts group a renamed payee by its name, not by the leading "SENT".
  assert.deepEqual(f.context.findSimilarTransactions(rows, rows[0], 'Gifts').map(item => item.transaction.id), []);
  assert.deepEqual(f.context.findSimilarTransactions(rows, rows[1], 'Travel').map(item => item.transaction.id), [1]);
  assert.equal(f.context.suggestDisplayName('ZELLE CRISTIANE DE LIMA'), 'Cristiane De Lima');
  assert.equal(f.context.suggestDisplayName('ZELLE TO SAM PATEL'), 'Sam Patel');
  assert.equal(f.context.suggestDisplayName("O'BRIEN & SONS"), "O'Brien & Sons");

  // Rename the newest row (Sam Patel): the dialog suggests words and a name, previews matches, then saves a rule.
  const row = { dataset: { transaction: '0' } };
  f.node('full-txn-table').onclick({ target: { closest: selector => selector === '[data-rename]' ? { closest: () => row } : null } });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.node('rename-original').textContent, 'SENT 77ZZ Zelle SAM PATEL');
  assert.equal(f.node('rename-pattern').value, 'ZELLE SAM PATEL');
  assert.equal(f.node('rename-name').value, 'Sam Patel');
  assert.equal(f.node('rename-remove').hidden, true);
  assert.match(f.node('rename-preview').innerHTML, /Matches 4 transactions<\/strong> now, plus future imports/);
  await f.node('rename-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls.find(([url, method]) => url === '/api/transactions/name-rules' && method === 'POST')[2], { pattern: 'ZELLE SAM PATEL', name: 'Sam Patel' });
});