import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = name => readFileSync(new URL(name, import.meta.url), 'utf8');
function fixture(fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) })) {
  const nodes = new Map();
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(['auth-pending']);
    const element = {
      id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
      style: {}, dataset: {}, parentElement: { before() {}, after() {} },
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle() {} },
      appendChild() {}, prepend() {}, before() {}, after() {}, remove() {}, close() {}, focus() {},
      querySelector: selector => node(`${id} ${selector}`), querySelectorAll: () => [],
      getAttribute: () => '', setAttribute() {}, reset() {}, showModal() {}
    };
    nodes.set(id, element); return element;
  }
  const context = {
    console, URL, Date, Number, String, Object, Math, Promise, Set, Map,
    fetch: fetchImpl, setTimeout, clearTimeout,
    location: { href: 'http://local.test/', origin: 'http://local.test', hash: '', reload() { context.reloaded = true; } },
    document: { getElementById: node, createElement: tag => node(`new-${tag}-${nodes.size}`), querySelector: node, querySelectorAll: () => [], body: node('body') },
    notify() {}, closeSidebar() {}, closeAddGoalModal() {}, openAddGoalModal() {},
    loadDashboard() {}, loadAllTransactions() {}, loadCategories() {}, loadEtlStaging() {}, loadGoals() {}, loadPayoffPlan() {}, generateInsights() {},
    showView(view) { context.lastView = view; }, FormData, FinanceSession: { isAuthenticated: () => true }
  };
  context.window = context;
  vm.createContext(context);
  return { context, node, run: file => vm.runInContext(source(file), context) };
}
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

test('all frontend scripts and inline application code parse', () => {
  for (const file of ['session.js','refresh.js','account.js','admin.js']) new vm.Script(source(file));
  for (const html of ['index.html','admin.html']) for (const match of source(html).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('categories overview is focused and category administration has its own page', () => {
  const html = source('index.html');
  const overview = html.match(/<section id="categories-view"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(overview, /category-cards/);
  assert.match(overview, /showView\('category-admin'\)/);
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
