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
  const views = ['dashboard', 'categories', 'category-admin', 'transactions', 'transaction-review', 'activity', 'accounts', 'analytics', 'knowledge-base', 'etl', 'payoff', 'goals', 'insights'].map(view => node(`${view}-view`));
  const nav = ['dashboard', 'categories', 'transactions', 'transaction-review', 'activity', 'accounts', 'analytics', 'knowledge-base', 'etl', 'payoff', 'goals', 'insights', 'settings'].map(view => {
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

function householdFixture(billing = {}, handler) {
  const calls = [];
  const f = fixture(async (url, options = {}) => {
    calls.push({ url, options });
    if (handler) {
      const handled = handler(url, options);
      if (handled) return handled;
    }
    if (url === '/api/billing') return response(200, { owner: true, configured: true, entitlement: { tier: 'none', active: false, plusActive: false, trialAvailable: true }, subscription: null, ...billing });
    if (url === '/api/license') return response(200, billing.entitlement || { tier: 'none', active: false, plusActive: false });
    return response(200, {});
  });
  f.context.FinanceSession = { isAuthenticated: () => true, currentUser: () => ({ emailVerified: true }), currentSupport: () => null };
  const redirects = [];
  f.context.location.assign = url => redirects.push(url);
  f.run('pro-core.js');
  f.run('household.js');
  return { ...f, calls, redirects };
}

test('household billing clearly discloses both plans, trial payment consent and cancellation retention', () => {
  const f = householdFixture();
  const html = f.context.FinanceHousehold.billingMarkup({ owner: true, configured: true, entitlement: { tier: 'trial', active: true, plusActive: true, trialEndsAt: '2026-11-01', trialAvailable: false }, subscription: { status: 'trialing', plan: 'basic', cancel_at_period_end: true, trial_ends_at: '2026-11-01' } });
  assert.match(html, /Basic · USD 9\.99\/month/);
  assert.match(html, /Pro · USD 14\.99\/month/);
  assert.match(html, /Cancellation scheduled. Access continues until/);
  assert.match(html, /Selected renewal plan: <strong>Basic/);
  assert.match(html, /Manage plan or cancel in Stripe/);
  assert.doesNotMatch(html, /card-number|cardNumber|Pro Plus|7-day|no charge/);
  const trial = f.context.FinanceHousehold.billingMarkup({ owner: true, configured: true, entitlement: { trialAvailable: true }, subscription: null }, '<script>oops</script>', 'basic');
  assert.match(trial, /value="basic" checked/);
  assert.match(trial, /15-day trial/);
  assert.match(trial, /selected plan is charged automatically unless cancelled/);
  assert.match(trial, /trial access continues to its end/);
  assert.match(trial, /reminder email 24 hours/);
  assert.match(trial, /&lt;script&gt;oops&lt;\/script&gt;/);
});

test('household checkout needs explicit consent and posts only selected plan before external navigation', async () => {
  const f = householdFixture({}, url => url === '/api/billing/checkout' ? response(200, { url: 'https://checkout.stripe.com/session' }) : null);
  await f.context.FinanceHousehold.openBilling('', 'basic');
  const root = f.node('household-dialog-content');
  const form = root.querySelector('#household-checkout-form');
  root.querySelector('input[name="household-plan"]:checked').value = 'basic';
  root.querySelector('#household-consent').checked = false;
  await form.listeners.submit({ preventDefault() {}, target: form });
  assert.equal(f.calls.some(call => call.url.includes('/checkout')), false);
  assert.match(root.querySelector('.household-error').textContent, /agree/);
  root.querySelector('#household-consent').checked = true;
  await form.listeners.submit({ preventDefault() {}, target: form });
  const sent = f.calls.find(call => call.url === '/api/billing/checkout');
  assert.deepEqual(JSON.parse(sent.options.body), { plan: 'basic', consent: true });
  assert.equal(sent.options.method, 'POST');
  assert.deepEqual(f.redirects, ['https://checkout.stripe.com/session']);
  assert.equal(f.calls.some(call => call.url.startsWith('https:')), false, 'Stripe is navigated to, never fetched');
});
test('Basic owners review a prorated Pro upgrade in Stripe without creating a second subscription', async () => {
  const billing = { entitlement: { tier: 'basic', active: true, plusActive: false },
    subscription: { plan: 'basic', status: 'active', cancel_at_period_end: false } };
  const f = householdFixture(billing, url => url === '/api/billing/portal'
    ? response(200, { url: 'https://billing.stripe.com/p/session/upgrade' }) : null);
  await f.context.FinanceHousehold.openBilling('', 'pro');
  const root = f.node('household-dialog-content');
  assert.match(root.innerHTML, /Upgrade to Pro in Stripe/);
  assert.match(root.innerHTML, /prorated upgrade charge/);
  const button = root.querySelector('[data-household-upgrade]');
  await button.listeners.click({ target: button });
  const sent = f.calls.find(call => call.url === '/api/billing/portal');
  assert.deepEqual(JSON.parse(sent.options.body), { plan: 'pro' });
  assert.equal(f.calls.some(call => call.url === '/api/billing/checkout'), false);
  assert.deepEqual(f.redirects, ['https://billing.stripe.com/p/session/upgrade']);
  for (const data of [{ ...billing, owner: false }, { ...billing, owner: true, subscription: { ...billing.subscription, cancel_at_period_end: true } },
    { ...billing, owner: true, subscription: { ...billing.subscription, status: 'trialing' } }]) {
    assert.doesNotMatch(f.context.FinanceHousehold.billingMarkup(data), /data-household-upgrade/);
  }
});
test('Pro downgrade keeps access until renewal and needs explicit owner consent', async () => {
  const effectiveAt = new Date(Date.now() + 30 * 86400000).toISOString();
  const billing = { entitlement: { tier: 'pro', active: true, plusActive: true },
    subscription: { plan: 'pro', status: 'active', cancel_at_period_end: false, current_period_end: effectiveAt } };
  let scheduled = false;
  const f = householdFixture(billing, url => {
    if (url === '/api/billing/downgrade') { scheduled = true; return response(200, {}); }
    if (url === '/api/billing') return response(200, { owner: true, configured: true, ...billing,
      subscription: { ...billing.subscription, ...(scheduled ? { schedule_managed: true, pending_change: { plan: 'basic', effective_at: effectiveAt } } : {}) } });
    return null;
  });
  await f.context.FinanceHousehold.openBilling();
  const root = f.node('household-dialog-content');
  assert.match(root.innerHTML, /data-household-downgrade/);
  assert.match(root.innerHTML, /9\.99/);
  const button = root.querySelector('[data-household-downgrade]');
  root.querySelector('#household-downgrade-consent').checked = false;
  await button.listeners.click({ target: button });
  assert.equal(f.calls.some(call => call.url === '/api/billing/downgrade'), false);
  root.querySelector('#household-downgrade-consent').checked = true;
  await button.listeners.click({ target: button });
  const sent = f.calls.find(call => call.url === '/api/billing/downgrade');
  assert.ok(sent);
  assert.deepEqual(JSON.parse(sent.options.body), { consent: true, effectiveAt });
  assert.equal(f.context.FinancePro.isPlusActive(), true, 'scheduling does not remove Pro access');
  assert.match(root.innerHTML, /data-household-keep-pro/);
});

test('members and support sessions cannot start checkout or manage billing', async () => {
  for (const support of [false, true]) {
    const f = householdFixture({ owner: support });
    f.context.FinanceSession.currentSupport = () => support ? { id: 1 } : null;
    await f.context.FinanceHousehold.openBilling();
    const root = f.node('household-dialog-content');
    assert.match(root.innerHTML, /Ask your household owner/);
    assert.doesNotMatch(root.innerHTML, /household-checkout-form|data-household-portal|data-resend-verification/);
    const form = root.querySelector('#household-checkout-form');
    await form.listeners.submit({ preventDefault() {}, target: form });
    assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
  }
});

test('billing portal handles cancellation without app payment details and rejects unsafe redirects', async () => {
  const f = householdFixture({ entitlement: { tier: 'trial', active: true, plusActive: true }, subscription: { status: 'trialing', plan: 'pro' } },
    url => url === '/api/billing/portal' ? response(200, { url: 'https://billing.stripe.com/session' }) : null);
  await f.context.FinanceHousehold.openBilling();
  const button = f.node('household-dialog-content').querySelector('[data-household-portal]');
  await button.listeners.click({ target: button });
  assert.deepEqual(f.redirects, ['https://billing.stripe.com/session']);
  assert.deepEqual(JSON.parse(f.calls.find(call => call.url === '/api/billing/portal').options.body), {});
  assert.throws(() => f.context.FinanceHousehold.external('javascript:alert(1)'), /invalid secure redirect/);
  assert.throws(() => f.context.FinanceHousehold.external('http://billing.stripe.com'), /invalid secure redirect/);
});

test('unverified owners receive verification controls and checkout remains blocked', async () => {
  const f = householdFixture();
  f.context.FinanceSession.currentUser = () => ({ emailVerified: false });
  await f.context.FinanceHousehold.openBilling();
  const root = f.node('household-dialog-content');
  assert.match(root.innerHTML, /Verify your email before checkout/);
  assert.match(root.innerHTML, /data-resend-verification/);
  const resend = root.querySelector('[data-resend-verification]');
  await resend.listeners.click({ target: resend });
  assert.equal(f.calls.find(call => call.url === '/api/auth/resend-verification').options.body, '{}');
  assert.match(root.querySelector('.verification-status').textContent, /Verification email sent/);
  const form = root.querySelector('#household-checkout-form');
  root.querySelector('#household-consent').checked = true;
  root.querySelector('input[name="household-plan"]:checked').value = 'pro';
  await form.listeners.submit({ preventDefault() {}, target: form });
  assert.equal(f.calls.some(call => call.url.includes('/checkout')), false);
});

test('subscription routing waits for entitlement and never opens financial pages without access', async () => {
  const f = householdFixture();
  await f.context.showView('dashboard');
  assert.equal(f.context.lastView, 'subscription');
  assert.match(f.node('subscription-view').innerHTML, /Complete the steps below/);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/license', '/api/billing']);
  const basic = householdFixture({ entitlement: { tier: 'basic', active: true, plusActive: false } });
  await basic.context.showView('dashboard');
  assert.equal(basic.context.lastView, 'dashboard');
  await basic.context.showView('goals');
  assert.equal(basic.context.lastView, 'subscription');
  assert.match(basic.node('subscription-view').innerHTML, /included in household Pro/);
  assert.equal(basic.calls.some(call => call.url === '/api/plan'), false);
  await basic.context.showView('knowledge-base');
  assert.equal(basic.context.lastView, 'knowledge-base');
  assert.equal(basic.calls.length, 2, 'Knowledge Base is available without an additional Pro entitlement check');
  const paid = householdFixture({ entitlement: { tier: 'pro', source: 'license', active: true, plusActive: true } });
  await paid.context.showView('goals');
  assert.equal(paid.context.lastView, 'goals');
  assert.equal(paid.calls.length, 1, 'existing paid access does not require billing checkout');
});

test('billing failures and checkout errors remain explicit and retryable', async () => {
  const failed = householdFixture({}, url => url === '/api/billing' ? response(503, { error: 'Billing unavailable' }) : null);
  await failed.context.FinanceHousehold.openBilling();
  assert.match(failed.node('household-dialog-content').innerHTML, /Billing unavailable/);
  assert.match(failed.node('household-dialog-content').innerHTML, /Retry billing/);
  const f = householdFixture({}, url => url === '/api/billing/checkout' ? response(403, { code: 'EMAIL_VERIFICATION_REQUIRED', error: 'Verify your email to continue' }) : null);
  await f.context.FinanceHousehold.openBilling();
  const root = f.node('household-dialog-content'), form = root.querySelector('#household-checkout-form');
  root.querySelector('#household-consent').checked = true;
  root.querySelector('input[name="household-plan"]:checked').value = 'pro';
  await form.listeners.submit({ preventDefault() {}, target: form });
  assert.match(root.querySelector('.household-error').textContent, /Verify your email/);
  assert.equal(form.querySelector('button').disabled, false);
  assert.equal(f.redirects.length, 0);
});

test('verification fragments are cleared before requests and verified without an existing session', async () => {
  const calls = [];
  const f = fixture(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/me') return response(401, {});
    return response(200, { success: true, registrationEnabled: false });
  });
  f.context.location.hash = '#verify-token=email-secret';
  f.context.location.pathname = '/';
  f.context.history.replaceState = () => { f.context.location.hash = ''; };
  f.run('session.js');
  assert.equal(f.context.location.hash, '');
  await f.context.FinanceSession.start();
  const verified = calls.find(call => call.url === '/api/auth/verify-email');
  assert.deepEqual(JSON.parse(verified.options.body), { token: 'email-secret' });
  assert.match(f.node('auth-error').textContent, /Email verified/);
  assert.equal(f.node('auth-switch').hidden, true, 'verification never enables public registration');
  assert.equal(calls.some(call => call.url.includes('email-secret')), false);
});

test('invite fragments allow invited registration while public registration is disabled', async () => {
  const calls = [];
  const f = fixture(async (url, options = {}) => {
    calls.push({ url, options });
    return url === '/api/auth/me' ? response(401, {}) : response(200, { registrationEnabled: false, success: true });
  });
  f.context.location.hash = '#invite-token=invitation-secret';
  f.context.location.pathname = '/';
  f.context.history.replaceState = () => { f.context.location.hash = ''; };
  f.run('session.js');
  assert.equal(f.context.location.hash, '');
  await f.context.FinanceSession.start();
  assert.equal(f.node('auth-title').textContent, 'Join your household.');
  f.node('auth-email').value = 'member@example.test';
  f.node('auth-name').value = 'New member';
  f.node('auth-password').value = 'secure-password';
  await f.node('auth-form').onsubmit({ preventDefault() {} });
  const accepted = calls.find(call => call.url === '/api/auth/accept-invite');
  assert.equal(JSON.parse(accepted.options.body).token, 'invitation-secret');
  assert.equal(f.context.reloaded, true);
  assert.equal(calls.some(call => call.url.includes('invitation-secret') || call.url === '/api/auth/register'), false);
});

test('household members are escaped and only owners receive membership management controls', async () => {
  for (const owner of [true, false]) {
    const f = householdFixture({}, url => url === '/api/household' ? response(200, { id: 1, name: '<Shared>', owner, members: [
      { id: 1, name: 'Owner', email: 'owner@example.test', role: 'owner' },
      { id: 2, name: '<Member>', email: 'member@example.test', role: 'member' }
    ], invitations: [{ id: 3, email: '<invite>@example.test', expires_at: '2026-11-01' }] }) : null);
    await f.context.FinanceHousehold.loadSettings();
    const html = f.node('household-members').innerHTML;
    assert.match(html, /&lt;Shared&gt;/);
    assert.match(html, /&lt;Member&gt;/);
    assert.match(html, /10 members.*48 hours/);
    if (owner) {
      assert.match(html, /household-invite-form/);
      assert.match(html, /data-remove-member="2"/);
      assert.doesNotMatch(html, /data-remove-member="1"/);
      assert.match(html, /data-revoke-invite="3"/);
      const form = f.node('household-members').querySelector('#household-invite-form');
      form.querySelector('input').value = 'new@example.test';
      form.listeners.submit({ preventDefault() {}, target: form });
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(JSON.parse(f.calls.find(call => call.url === '/api/household/invitations').options.body), { email: 'new@example.test' });
    } else assert.doesNotMatch(html, /household-invite-form|data-remove-member|data-revoke-invite/);
  }
});

test('existing users explicitly accept invitations and see data or paid-access rejections', async () => {
  const calls = [];
  const f = fixture(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/me') return response(200, { user: { id: 1, emailVerified: true } });
    return response(409, { error: 'Your existing household has financial data or paid access.' });
  });
  f.context.location.hash = '#invite-token=existing-invite';
  f.context.history.replaceState = () => { f.context.location.hash = ''; };
  f.run('session.js');
  await f.context.FinanceSession.start();
  assert.equal(f.node('auth-submit').textContent, 'Join invited household');
  assert.match(f.node('auth-description').textContent, /no financial data or paid access/);
  assert.equal(calls.some(call => call.url === '/api/household/accept'), false, 'joining needs an explicit action');
  await f.node('auth-form').onsubmit({ preventDefault() {} });
  const accepted = calls.find(call => call.url === '/api/household/accept');
  assert.deepEqual(JSON.parse(accepted.options.body), { token: 'existing-invite' });
  assert.match(f.node('auth-error').textContent, /financial data or paid access/);
  assert.equal(f.context.reloaded, undefined);
  f.node('auth-switch').onclick();
  assert.equal(f.context.reloaded, true, 'a rejected invite does not trap the existing account');
});

test('household owner removes members and revokes invitations via the contracted endpoints', async () => {
  const data = { id: 1, name: 'Home', owner: true, members: [{ id: 1, role: 'owner' }, { id: 2, role: 'member' }], invitations: [{ id: 3, email: 'invite@example.test' }] };
  const f = householdFixture({}, (url, options) => url === '/api/household' ? response(200, data) : null);
  f.context.confirm = () => true;
  const member = f.node('remove-member'), invite = f.node('revoke-invite');
  member.dataset = { removeMember: '2' };
  invite.dataset = { revokeInvite: '3' };
  f.node('household-members').querySelectorAll = selector => selector.includes('data-remove-member') ? [member, invite] : [];
  await f.context.FinanceHousehold.loadSettings();
  member.listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  invite.listeners.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.find(call => call.url === '/api/household/members/2').options.method, 'DELETE');
  assert.equal(f.calls.find(call => call.url === '/api/household/invitations/3').options.method, 'DELETE');
});

test('entitlement service failures block finances and surface a retry rather than suggesting a free plan', async () => {
  const f = householdFixture({}, url => url === '/api/license' ? response(503, { error: '<License unavailable>' }) : null);
  await f.context.showView('dashboard');
  assert.equal(f.context.lastView, 'subscription');
  assert.match(f.node('subscription-view').innerHTML, /&lt;License unavailable&gt;/);
  assert.match(f.node('subscription-view').innerHTML, /data-access-retry/);
  assert.equal(f.calls.some(call => call.url === '/api/billing'), false);
});

test('invalid verification tokens remain explicit errors without unlocking registration', async () => {
  const f = fixture(async url => url === '/api/auth/verify-email' ? response(400, { error: 'Verification link expired. Request a new email.' })
    : url === '/api/auth/me' ? response(401, {}) : response(200, { registrationEnabled: false }));
  f.context.location.hash = '#verify-token=expired-token';
  f.context.history.replaceState = () => { f.context.location.hash = ''; };
  f.run('session.js');
  await f.context.FinanceSession.start();
  assert.match(f.node('auth-error').textContent, /Verification link expired/);
  assert.equal(f.node('auth-switch').hidden, true);
  assert.equal(f.context.location.hash, '');
});

test('successful existing-user invite acceptance drops revoked sessions and requires sign-in', async () => {
  const calls = [];
  const f = fixture(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/me') return response(200, { user: { id: 3, emailVerified: true } });
    return response(200, { success: true, signInRequired: true });
  });
  f.context.location.hash = '#invite-token=existing-member-token';
  f.context.history.replaceState = () => { f.context.location.hash = ''; };
  f.run('session.js');
  await f.context.FinanceSession.start();
  assert.equal(f.context.FinanceSession.isAuthenticated(), true);
  assert.equal(f.context.lastView, undefined, 'invite fragment is handled before workspace routing');
  await f.node('auth-form').onsubmit({ preventDefault() {} });
  assert.equal(f.context.FinanceSession.isAuthenticated(), false);
  assert.equal(f.node('body').classList.contains('auth-pending'), true);
  assert.equal(f.context.reloaded, true);
  assert.equal(f.node('auth-submit').textContent, 'Sign in');
  assert.equal(calls.some(call => call.url === '/api/license' || call.url === '/api/billing'), false);
});

test('register reloads and refreshes /me before unpaid onboarding, ignoring incomplete immediate users', async () => {
  const calls = [];
  let registered = false;
  const f = fixture(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/me') return registered ? response(200, { user: { id: 4, emailVerified: false, household: { id: 8, role: 'owner', name: 'New home' } } }) : response(401, {});
    if (url === '/api/auth/status') return response(200, { registrationEnabled: true });
    if (url === '/api/auth/register') { registered = true; return response(201, { user: { id: 4, emailVerified: false } }); }
    if (url === '/api/license') return response(200, { tier: 'none', active: false, plusActive: false, trialAvailable: true });
    if (url === '/api/billing') return response(200, { owner: true, configured: true, entitlement: { tier: 'none', active: false, trialAvailable: true }, subscription: null });
    throw new Error(`Unexpected request: ${url}`);
  });
  f.run('session.js');
  await f.context.FinanceSession.start();
  f.node('auth-switch').onclick();
  f.node('auth-plan-basic').checked = true;
  f.context.location.hash = '#settings';
  f.node('auth-email').value = 'new@example.test';
  f.node('auth-name').value = 'New owner';
  f.node('auth-password').value = 'secure-password-123';
  await f.node('auth-form').onsubmit({ preventDefault() {} });
  assert.equal(f.context.reloaded, true);
  assert.equal(f.context.location.hash, '#subscription/basic', 'registration always continues to onboarding, not the previous page');
  assert.equal(f.context.FinanceSession.currentUser(), null, 'incomplete registration user is never used for routing');
  f.run('pro-core.js');
  f.run('household.js');
  await f.context.FinanceSession.start();
  assert.equal(f.context.FinanceSession.currentUser().household.role, 'owner');
  assert.equal(f.context.lastView, 'subscription/basic');
  assert.match(f.node('subscription-view').innerHTML, /Verify your email before checkout/);
  assert.match(f.node('subscription-view').innerHTML, /value="basic" checked/);
  assert.match(f.node('subscription-view').innerHTML, /Your selected plan is <strong>Basic/);
  assert.deepEqual(calls.slice(-3).map(call => call.url), ['/api/auth/me', '/api/license', '/api/billing']);
});

test('signed-in checkout wrapper throws verification errors with code and status intact', async () => {
  const f = fixture(async url => url === '/api/auth/me'
    ? response(200, { user: { id: 4, emailVerified: false, household: { role: 'owner' } } })
    : response(403, { code: 'EMAIL_VERIFICATION_REQUIRED', error: 'Verify your email before checkout.' }));
  f.run('session.js');
  await f.context.FinanceSession.start();
  await assert.rejects(f.context.fetch('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: 'basic', consent: true }) }),
    error => error.status === 403 && error.code === 'EMAIL_VERIFICATION_REQUIRED' && /Verify your email/.test(error.message));
  f.run('pro-core.js');
  await assert.rejects(f.context.FinancePro.request('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ plan: 'pro', consent: true }) }),
    error => error.status === 403 && error.code === 'EMAIL_VERIFICATION_REQUIRED');
});

test('signup requires an inline plan and carries either choice without browser storage', async () => {
  const html = source('index.html');
  assert.match(html, /<fieldset class="auth-plan-options" id="auth-plan-options" hidden>/);
  for (const plan of ['basic', 'pro']) {
    const calls = [];
    const f = fixture(async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/me')) return response(401, {});
      if (url.endsWith('/status')) return response(200, { registrationEnabled: true });
      if (url.endsWith('/register')) return response(201, { user: { id: 4 } });
      throw new Error(`Unexpected request: ${url}`);
    });
    f.context.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    f.run('session.js');
    await f.context.FinanceSession.start();
    assert.equal(f.node('auth-plan-options').hidden, true);
    assert.equal(f.node('auth-plan-basic').disabled, true);
    f.node('auth-switch').onclick();
    assert.equal(f.node('auth-screen').classList.contains('is-registering'), true);
    assert.equal(f.node('auth-plan-options').hidden, false);
    assert.equal(f.node('auth-signup-steps').hidden, false);
    assert.equal(f.node('auth-plan-basic').required, true);
    assert.equal(f.node('auth-plan-basic').disabled, false);
    await f.node('auth-form').onsubmit({ preventDefault() {} });
    assert.match(f.node('auth-error').textContent, /Choose Basic or Pro/);
    assert.equal(calls.some(call => call.url.endsWith('/register')), false);
    const input = f.node(`auth-plan-${plan}`);
    input.checked = true;
    input.listeners.change({ target: input });
    assert.equal(f.context.FinanceSession.chosenPlan(), plan);
    f.node('auth-switch').onclick();
    assert.equal(f.node('auth-screen').classList.contains('is-registering'), false);
    assert.equal(input.disabled, true, 'login does not validate hidden plan fields');
    assert.equal(input.required, false);
    f.node('auth-switch').onclick();
    assert.equal(input.checked, true, 'switching between login and signup retains the selection');
    await f.node('auth-form').onsubmit({ preventDefault() {} });
    assert.equal(f.context.location.hash, `#subscription/${plan}`);
    assert.equal(f.context.reloaded, true);
    assert.equal(calls.some(call => call.url === '/api/billing/checkout'), false, 'signup does not silently authorize billing');
  }
});

test('subscription onboarding preserves explicit plan routes and paid households return to finances', async () => {
  const f = householdFixture();
  await f.context.showView('subscription/basic');
  assert.equal(f.context.lastView, 'subscription/basic');
  assert.match(f.node('subscription-view').innerHTML, /value="basic" checked/);
  await f.context.showView('subscription/pro');
  assert.match(f.node('subscription-view').innerHTML, /value="pro" checked/);
  const paid = householdFixture({ entitlement: { tier: 'pro', active: true, plusActive: true } });
  await paid.context.showView('subscription/basic');
  assert.equal(paid.context.lastView, 'dashboard');
});

test('migrated legacy paid licenses retain all advanced features under new Pro', async () => {
  for (const legacy of ['Pro', 'Pro Plus']) {
    const f = householdFixture({ entitlement: { tier: 'pro', source: 'license', active: true, plusActive: true, trialAvailable: false } });
    await f.context.showView('analytics');
    assert.equal(f.context.lastView, 'analytics', legacy);
    assert.equal(f.context.FinancePro.requirePro('Budgets'), true, legacy);
    assert.equal(f.context.FinancePro.requireProPlus('Goals'), true, legacy);
    assert.equal(f.calls.some(call => call.url === '/api/billing'), false, legacy);
  }
});

test('member Settings hides support grants, explains household sharing and skips support requests', async () => {
  const calls = [];
  const f = fixture(async (url, options = {}) => { calls.push({ url, options }); throw new Error('Members must not request support access.'); });
  f.context.FinanceTools = { escape: String };
  f.context.FinanceSession = { isAuthenticated: () => true, currentSupport: () => null, currentUser: () => ({ household: { role: 'member' } }) };
  f.run('account.js');
  f.context.showView('settings');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.node('support-grant-form').hidden, true);
  assert.match(f.node('support-status').textContent, /Only the household owner/);
  assert.match(f.node('support-status').textContent, /members already share access/);
  assert.equal(f.node('support-grants').innerHTML, '');
  assert.equal(f.node('support-activity').innerHTML, '');
  assert.equal(calls.length, 0);
  const actual = [...new Set([...f.context.document.querySelector('.main-content').options])].find(node => node.id === 'settings-view');
  await actual.listeners.submit({ target: { id: 'support-grant-form' }, preventDefault() {} });
  await actual.listeners.click({ target: { dataset: { revoke: '1' } } });
  assert.equal(calls.length, 0, 'hidden support controls also reject synthetic member actions');
  assert.match(actual.innerHTML, /Operators can access operational information and audit metadata/);
  assert.doesNotMatch(actual.innerHTML, /Nobody can see your data without a grant from you/);
});

test('owner Settings retains support access while support sessions cannot manage grants', async () => {
  const calls = [];
  const f = fixture(async (url, options = {}) => { calls.push({ url, options }); return response(200, { grants: [], activity: [] }); });
  let support = null;
  f.context.FinanceTools = { escape: String };
  f.context.FinanceSession = { isAuthenticated: () => true, currentSupport: () => support, currentUser: () => ({ household: { role: 'owner' } }) };
  f.run('account.js');
  f.context.showView('settings');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.node('support-grant-form').hidden, false);
  assert.deepEqual(calls.map(call => call.url), ['/api/support-access']);
  support = { id: 1 };
  f.context.showView('settings');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.node('support-grant-form').hidden, true);
  assert.match(f.node('support-status').textContent, /hidden during a support session/);
  assert.equal(calls.length, 1);
});

test('import history selects recent imports, confirms recovery and refreshes financial views', async () => {
  const batches = [
    { id: 4, source: 'duplicate.csv', status: 'active', active_rows: 0, imported: 0, duplicates: 2, created_at: '2026-10-04' },
    { id: 3, source: '<card>.csv', account_name: 'Card & bank', status: 'active', active_rows: 2, imported: 2, duplicates: 0, created_at: '2026-10-03', legacy: true },
    { id: 2, source: 'bank.csv', status: 'active', active_rows: 3, imported: 3, duplicates: 0, created_at: '2026-10-02' },
    { id: 1, source: 'undone.csv', status: 'undone', backup_rows: 2, created_at: '2026-10-01' }
  ];
  const calls = [];
  const f = fixture(async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/review')) return response(200, { action: 'undo', affected: 5, batches: batches.filter(b => [3, 2].includes(b.id)),
      remainingTransactions: 7, reviewToken: 'verified', validForMs: 300000,
      expiresAt: new Date(Date.now() - 3600000).toISOString() });
    if (options?.method === 'POST') {
      batches.filter(b => [3, 2].includes(b.id)).forEach(b => { b.status = 'undone'; b.backup_rows = b.active_rows; b.active_rows = 0; });
      return response(200, { success: true, batches: 2, affected: 5 });
    }
    return response(200, { batches, untracked: 7 });
  });

  const inputs = batches.map(batch => ({ dataset: { importId: String(batch.id) }, checked: false }));
  f.node('import-history-list').querySelectorAll = selector => selector.includes(':checked') ? inputs.filter(input => input.checked) : inputs;
  let dashboard = 0, transactions = 0, accounts = 0, categories = 0, invalidated = 0;
  f.context.loadDashboard = async () => { dashboard++; };
  f.context.loadAllTransactions = async () => { transactions++; };
  f.context.loadCategories = async () => { categories++; };
  f.context.FinanceAccounts = { loadPage: async () => { accounts++; } };
  f.context.FinancePlan = { invalidate: () => { invalidated++; } };
  f.run('import-history.js');
  await f.context.FinanceImportHistory.load();
  const html = f.node('import-history-list').innerHTML;
  assert.match(html, /&lt;card&gt;\.csv/);
  assert.match(html, /Card &amp; bank/);
  assert.match(html, /7 transactions have no reliable import boundary/);
  assert.match(html, /transaction-only recovery/);
  assert.doesNotMatch(html, /undone\.csv|data-import-id="1"/, 'undone imports cannot be selected for undo');
  assert.doesNotMatch(html, /data-import-id="4"/, 'duplicate-only imports are informational, not selectable');
  f.node('import-history-count').value = '2';
  f.node('import-history-recent').listeners.click();
  assert.deepEqual(inputs.filter(input => input.checked).map(input => input.dataset.importId), ['3', '2'], 'duplicate-only imports do not consume recent selection');
  await f.node('import-history-undo').listeners.click();
  assert.match(f.node('import-history-impact').innerHTML, /Remove 5 transactions across 2 imports/);
  assert.match(f.node('import-history-impact').innerHTML, /Older inferred import/);
  assert.equal(f.node('import-history-commit').disabled, true);
  await f.node('import-history-commit').listeners.click();
  assert.equal(calls.filter(([url]) => url.endsWith('/undo')).length, 0, 'reviewing and unacknowledged commit do not change data');
  f.node('import-history-ack').checked = true;
  f.node('import-history-ack').listeners.change();
  assert.equal(f.node('import-history-commit').disabled, false);
  await f.node('import-history-commit').listeners.click();
  const post = calls.find(([, options]) => options?.method === 'POST');
  assert.equal(post[0], '/api/import/history/review');
  assert.deepEqual(JSON.parse(post[1].body), { ids: [3, 2], action: 'undo' });
  const commit = calls.find(([url]) => url.endsWith('/undo'));
  assert.deepEqual(JSON.parse(commit[1].body), { ids: [3, 2], reviewToken: 'verified', acknowledged: true });
  assert.deepEqual([dashboard, transactions, accounts, categories, invalidated], [1, 1, 1, 1, 1]);
  assert.match(f.node('import-history-status').textContent, /Undone 2 imports, 5 transactions. Totals refreshed/);
  assert.equal(f.context.FinanceImportHistory.isBusy(), false);
  assert.doesNotMatch(f.node('import-history-list').innerHTML, /data-import-id="3"|data-import-id="2"/, 'completed imports disappear from undo choices');
  f.node('import-history-backups').listeners.click();
  assert.match(f.node('import-history-list').innerHTML, /Not available for Undo/);
  assert.equal(f.node('import-history-undo').hidden, true);
  assert.equal(f.node('import-history-restore').hidden, false);
  f.context.FinanceImportHistory.reset();
  assert.equal(f.node('import-history-list').textContent, '');
  assert.equal(f.node('import-history-status').textContent, '');
});

test('import recovery rejects mixed states and surfaces validation failures without committing', async () => {
  let posts = 0;
  const f = fixture(async (url, options) => {
    if (options?.method === 'POST') { posts++; return response(409, { error: 'Undo newer imports first.' }); }
    return response(200, { batches: [
      { id: 1, source: 'one.csv', status: 'active', active_rows: 1, created_at: '2026-10-01' },
      { id: 2, source: 'two.csv', status: 'undone', backup_rows: 1, created_at: '2026-10-02' }
    ], untracked: 0 });
  });

  const inputs = [{ dataset: { importId: '1' }, checked: true }, { dataset: { importId: '2' }, checked: true }];
  f.node('import-history-list').querySelectorAll = selector => selector.includes(':checked') ? inputs.filter(input => input.checked) : inputs;
  f.run('import-history.js');
  await f.context.FinanceImportHistory.load();
  await f.node('import-history-undo').listeners.click();
  assert.match(f.node('import-history-status').textContent, /only active imports/);
  assert.equal(posts, 0);
  inputs[1].checked = false;
  await f.node('import-history-undo').listeners.click();
  assert.equal(posts, 1);
  assert.match(f.node('import-history-status').textContent, /Undo newer imports first/);
  assert.equal(f.node('import-history-undo').disabled, false);
  f.context.importIsBusy = () => true;
  await f.node('import-history-undo').listeners.click();
  assert.equal(posts, 1);
  assert.match(f.node('import-history-status').textContent, /Wait for the current import/);
});

test('transaction review clearly marks excluded rows and renders activity safely', async () => {
  const calls = [];
  const f = fixture(async url => {
    calls.push(url);
    if (url.startsWith('/api/transactions/transfer-review/imports')) return response(200, {
      batches: [{ id: 4, source: '<checking>.csv', account_name: 'Checking', created_at: '2026-10-22', imported: 12, duplicates: 2, status: 'active' }],
      nextBefore: null
    });
    if (url.startsWith('/api/transactions/transfer-review')) return response(200, {
      rows: [{ id: 17, date: '2026-10-22', description: 'TRANSFER <review>', amount: '125.00', direction: 'DEBIT',
        category: 'Transfer', transfer_kind: 'unknown', source: 'checking.csv', account_name: 'Checking', transfer_account_name: null }],
      total: 1, categories: ['Other', 'Transfer', 'Savings'], limit: 50, offset: 0
    });
    return response(200, {
      total: 1, limit: 50, offset: 0,
      events: [{ id: 1, created_at: '2026-10-22T14:00:00.000Z', event_type: 'import.completed', outcome: 'success',
        actor_user_id: 3, actor_name: '<User>', request_id: 'req-123', detail: { fileName: 'checking.csv', importedRows: 12 } }]
    });
  });
  f.run('review-tools.js');
  await f.context.FinanceReviewTools.loadTransfers();
  assert.equal(calls.length, 1, 'opening diagnostics fetches metadata, not workspace transactions');
  assert.match(f.node('transfer-review-rows').innerHTML, /Choose an import/);
  assert.match(f.node('transfer-review-import').innerHTML, /&lt;checking&gt;\.csv/);
  f.node('transfer-review-import').value = '4';
  await f.context.FinanceReviewTools.loadTransfers();
  assert.match(calls.at(-1), /importId=4&status=&limit=50&offset=0/);
  assert.match(f.node('transfer-review-import-summary').textContent, /12 rows originally imported · 2 duplicates skipped/);
  assert.match(f.node('transfer-review-rows').innerHTML, /Needs review · excluded/);
  assert.match(f.node('transfer-review-rows').innerHTML, /&lt;review&gt;/);
  assert.match(f.node('transfer-review-count').textContent, /1 of 1 transactions/);
  await f.context.FinanceReviewTools.loadActivity();
  assert.match(f.node('activity-events').innerHTML, /Statement imported/);
  assert.match(f.node('activity-events').innerHTML, /File: checking\.csv/);
  assert.match(f.node('activity-events').innerHTML, /&lt;User&gt;/);
});

test('advanced diagnostics are separate from everyday navigation', () => {
  const html = source('index.html');
  const main = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)?.[1];
  const advanced = html.match(/<details[^>]*id="advanced-diagnostics-nav"[^>]*>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(main);
  assert.ok(advanced);
  assert.doesNotMatch(main, /data-view="(?:transaction-review|activity)"/);
  assert.match(advanced, /data-view="transaction-review"/);
  assert.match(advanced, /data-view="activity"/);
  assert.match(html, /id="transfer-review-import"/);
  assert.match(html, /id="transfer-review-import-summary"/);
});

test('review import paging is bounded, preserves selection and surfaces failures', async () => {
  const calls = [];
  let fail = false;
  const f = fixture(async url => {
    calls.push(url);
    if (fail) return response(503, { error: 'Unavailable' });
    if (url.endsWith('/imports')) return response(200, {
      batches: [{ id: 32, source: 'latest.csv', created_at: '2026-10-22', imported: 0, duplicates: 8 }], nextBefore: 3
    });
    if (url.includes('/imports?before=3')) return response(200, {
      batches: [{ id: 2, source: 'older.csv', created_at: '2026-10-01', imported: 60, duplicates: 0 }], nextBefore: null
    });
    return response(200, { rows: [], total: 60, limit: 50, offset: url.includes('offset=50') ? 50 : 0, categories: [] });
  });
  f.run('review-tools.js');
  await f.context.FinanceReviewTools.loadTransfers();
  f.node('transfer-review-import').value = '32';
  await f.node('transfer-review-import-more').listeners.click();
  assert.match(f.node('transfer-review-import').innerHTML, /older.csv/);
  assert.equal(f.node('transfer-review-import').value, '32');
  assert.equal(f.node('transfer-review-import-more').hidden, true);
  f.node('transfer-review-import').value = '2';
  await f.context.FinanceReviewTools.loadTransfers();
  f.node('transfer-review-pagination').listeners.click({ target: { closest: () => ({ dataset: { transferPage: '1' } }) } });
  await new Promise(setImmediate);
  assert.match(calls.at(-1), /importId=2.*limit=50&offset=50/);
  f.node('transfer-review-filter').value = 'excluded';
  f.node('transfer-review-filter').listeners.change();
  await new Promise(setImmediate);
  assert.match(calls.at(-1), /importId=2&status=excluded&limit=50&offset=0/);
  fail = true;
  await f.context.FinanceReviewTools.loadTransfers();
  assert.match(f.node('transfer-review-error').textContent, /Unavailable/);
  assert.equal(f.node('transfer-review-pagination').innerHTML, '');
});

test('late review responses cannot overwrite a newer filter or a signed-out workspace', async () => {
  const pending = [];
  const f = fixture(url => url.endsWith('/imports')
    ? Promise.resolve(response(200, { batches: [], nextBefore: null }))
    : new Promise(resolve => pending.push(resolve)));
  f.run('review-tools.js');
  await f.context.FinanceReviewTools.loadTransfers();
  f.node('transfer-review-import').value = 'untracked';
  const first = f.context.FinanceReviewTools.loadTransfers();
  const second = f.context.FinanceReviewTools.loadTransfers();
  pending[1](response(200, { rows: [], total: 2, offset: 0, limit: 50, categories: [] }));
  await second;
  pending[0](response(200, { rows: [], total: 99, offset: 0, limit: 50, categories: [] }));
  await first;
  assert.match(f.node('transfer-review-count').textContent, /of 2 transactions/);
  const last = f.context.FinanceReviewTools.loadTransfers();
  f.context.FinanceReviewTools.reset();
  f.node('transfer-review-rows').innerHTML = '';
  pending[2](response(200, { rows: [{ id: 1, description: 'PRIVATE' }], total: 1, offset: 0, limit: 50, categories: [] }));
  await last;
  assert.equal(f.node('transfer-review-rows').innerHTML, '');
});

test('late import metadata cannot repopulate diagnostics after session lock', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.run('review-tools.js');
  const pending = f.context.FinanceReviewTools.loadTransfers();
  f.context.FinanceReviewTools.reset();
  f.node('transfer-review-import').innerHTML = '';
  f.node('transfer-review-rows').innerHTML = '';
  resolve(response(200, { batches: [{ id: 1, source: 'PRIVATE.csv' }], nextBefore: null }));
  await pending;
  assert.equal(f.node('transfer-review-import').innerHTML, '');
  assert.equal(f.node('transfer-review-rows').innerHTML, '');
});

test('entering troubleshooting refreshes import choices and shows newly completed uploads', async () => {
  let batches = [];
  const f = fixture(async url => response(200, url.includes('/transfer-review/imports')
    ? { batches, nextBefore: null } : { rows: [], total: 0, offset: 0, limit: 50, categories: [] }));
  f.run('review-tools.js');
  f.run('refresh.js');
  f.context.showView('transaction-review');
  await new Promise(setImmediate);
  assert.doesNotMatch(f.node('transfer-review-import').innerHTML, /new-upload/);
  batches = [{ id: 8, source: 'new-upload.csv', account_name: 'Checking', created_at: '2026-10-23', imported: 1, duplicates: 2 }];
  f.context.showView('transactions');
  f.context.showView('transaction-review');
  await new Promise(setImmediate);
  assert.match(f.node('transfer-review-import').innerHTML, /new-upload.csv/);
});

test('troubleshooting import loading failures are explicit and Refresh retries', async () => {
  let fail = true;
  const f = fixture(async () => fail ? response(503, { error: 'Import history unavailable' })
    : response(200, { batches: [{ id: 8, source: 'recovered.csv', created_at: '2026-10-23' }], nextBefore: null }));
  f.run('review-tools.js');
  await f.context.FinanceReviewTools.loadTransfers();
  assert.match(f.node('transfer-review-error').textContent, /Import history unavailable/);
  fail = false;
  f.node('transfer-review-refresh').listeners.click();
  await new Promise(setImmediate);
  assert.match(f.node('transfer-review-import').innerHTML, /recovered.csv/);
  assert.equal(f.node('transfer-review-error').textContent, '');
});

test('completed imports invalidate troubleshooting metadata even when account refresh fails', async () => {
  const f = fixture(async () => response(503, { error: 'Account refresh unavailable' }));
  let invalidated = 0;
  f.context.FinanceReviewTools = { invalidateImports: () => { invalidated++; } };
  f.run('accounts.js');
  await assert.rejects(f.context.FinanceAccounts.afterImport({ imported: 1 }), /Account refresh unavailable/);
  assert.equal(invalidated, 1);
});

test('an old metadata request cannot hide a newly completed upload after invalidation', async () => {
  const pending = [];
  const f = fixture(() => new Promise(resolve => pending.push(resolve)));
  f.run('review-tools.js');
  const old = f.context.FinanceReviewTools.loadTransfers();
  f.context.FinanceReviewTools.invalidateImports();
  const fresh = f.context.FinanceReviewTools.loadTransfers();
  assert.equal(pending.length, 2, 'invalidation starts a fresh metadata request');
  pending[1](response(200, { batches: [{ id: 9, source: 'fresh.csv', created_at: '2026-10-23' }], nextBefore: null }));
  await fresh;
  pending[0](response(200, { batches: [], nextBefore: null }));
  await old;
  assert.match(f.node('transfer-review-import').innerHTML, /fresh.csv/);
});

test('malformed import-list responses are errors, not an empty success', async () => {
  const f = fixture(async () => response(200, { rows: [] }));
  f.run('review-tools.js');
  await f.context.FinanceReviewTools.loadTransfers();
  assert.match(f.node('transfer-review-error').textContent, /invalid import list/);
});

test('CSV overlap review bulk-selects only clear matches and requires complete acknowledged choices', async () => {
  const rows = [
    { index: 0, bulkEligible: true, incoming: { description: '<Bank payment>', date: '2026-10-15', amount: 25, direction: 'DEBIT', accountName: 'Checking', last4: '5261' },
      candidates: [{ id: 10, description: '<Bank payment>', date: '2026-10-15', amount: 25, direction: 'DEBIT', source: '<old>.csv', accountName: null }] },
    { index: 1, bulkEligible: false, incoming: { description: 'Similar payment', date: '2026-10-16', amount: 30, direction: 'DEBIT', accountName: 'Checking' },
      candidates: [{ id: 11, description: 'Payment', date: '2026-10-16', amount: 30, direction: 'DEBIT', source: 'old.csv', accountName: null }] }
  ];
  const f = fixture(async url => url.endsWith('import-options') ? response(200, { accounts: [], kinds: [] })
    : url.endsWith('inspect-csv') ? response(200, { accounts: [] })
      : response(200, { reviewToken: 'review-token', rows }));
  const messages = [];
  f.context.setImportStatus = (kind, text) => messages.push([kind, text]);
  f.run('accounts.js');
  const account = await f.context.FinanceAccounts.prepareCsv('csv', 'file.csv');
  await f.context.FinanceAccounts.reviewCsvOverlaps('csv', 'file.csv', account);
  const root = f.node('csv-overlap-review');
  assert.match(root.innerHTML, /&lt;Bank payment&gt;/);
  assert.match(root.innerHTML, /&lt;old&gt;\.csv/);
  assert.doesNotMatch(root.innerHTML, /<Bank payment>/);
  root.querySelector('[data-overlap-exact]').listeners.click();
  assert.equal(root.querySelector('[name="overlap-0"][value="10"]').checked, true);
  assert.notEqual(root.querySelector('[name="overlap-1"][value="11"]').checked, true);
  const query = root.querySelector;
  let second = null;
  root.querySelector = selector => selector === '[name="overlap-0"]:checked' ? { value: '10' }
    : selector === '[name="overlap-1"]:checked' ? second : query(selector);
  assert.equal(await f.context.FinanceAccounts.prepareCsv('csv', 'file.csv'), null);
  second = { value: 'new' };
  assert.equal(await f.context.FinanceAccounts.prepareCsv('csv', 'file.csv'), null, 'acknowledgement required');
  f.node('csv-overlap-ack').checked = true;
  const confirmed = await f.context.FinanceAccounts.prepareCsv('csv', 'file.csv');
  assert.deepEqual(JSON.parse(JSON.stringify(confirmed.overlapReview)), { reviewToken: 'review-token',
    decisions: [{ index: 0, transactionId: 10 }, { index: 1, transactionId: 'new' }], acknowledged: true });
  root.querySelector('[data-overlap-cancel]').listeners.click();
  assert.equal(root.hidden, true);
  assert.equal((await f.context.FinanceAccounts.prepareCsv('csv', 'file.csv')).overlapReview, undefined);
});

test('an outstanding import history response cannot repopulate a signed-out workspace', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.run('import-history.js');
  const pending = f.context.FinanceImportHistory.load();
  f.context.FinanceImportHistory.reset();
  resolve(response(200, { batches: [{ id: 1, source: 'private.csv', created_at: '2026-10-01' }], untracked: 0 }));
  assert.equal(await pending, false);
  assert.equal(f.node('import-history-list').textContent, '');
  assert.doesNotMatch(f.node('import-history-list').innerHTML, /private.csv/);
});

test('recovery review can be cancelled, expires, and restores only through an acknowledged commit', async () => {
  const calls = [];
  const batch = { id: 7, status: 'undone', source: 'backup.csv', backup_rows: 4, created_at: '2026-10-01' };
  let expired = false;
  const f = fixture(async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/review')) return response(200, { action: 'restore', affected: 4, batches: [batch], remainingTransactions: 8,
      reviewToken: 'restore-reviewed', expiresAt: new Date(Date.now() + (expired ? -1000 : 300000)).toISOString() });
    if (url.endsWith('/restore')) { batch.status = 'active'; batch.active_rows = 4; return response(200, { batches: 1, affected: 4 }); }
    return response(200, { batches: [batch], untracked: 0 });
  });
  const input = { dataset: { importId: '7' }, checked: true };
  f.node('import-history-list').querySelectorAll = () => [input];
  f.run('import-history.js');
  await f.context.FinanceImportHistory.load();
  f.node('import-history-backups').listeners.click();
  await f.node('import-history-restore').listeners.click();
  f.node('import-history-cancel').listeners.click();
  assert.equal(f.node('import-history-review').hidden, true);
  await f.node('import-history-commit').listeners.click();
  assert.equal(calls.filter(([url]) => url.endsWith('/restore')).length, 0);
  expired = true;
  await f.node('import-history-restore').listeners.click();
  f.node('import-history-ack').checked = true;
  await f.node('import-history-commit').listeners.click();
  assert.match(f.node('import-history-status').textContent, /Review expired/);
  assert.equal(calls.filter(([url]) => url.endsWith('/restore')).length, 0);
  expired = false;
  await f.node('import-history-restore').listeners.click();
  f.node('import-history-ack').checked = true;
  await f.node('import-history-commit').listeners.click();
  assert.deepEqual(JSON.parse(calls.find(([url]) => url.endsWith('/restore'))[1].body),
    { ids: [7], reviewToken: 'restore-reviewed', acknowledged: true });
  assert.doesNotMatch(f.node('import-history-list').innerHTML, /data-import-id="7"/, 'restored imports leave restore choices');
});

test('account freshness marks only data older than 45 calendar days and keeps import time separate', async () => {
  const accounts = [
    { id: 1, name: 'Fresh checking', kind: 'checking', dataAsOf: '2026-09-04', lastDataAddedAt: '2026-10-19T10:00:00Z' },
    { id: 2, name: 'Old savings', kind: 'savings', dataAsOf: '2026-09-03', lastDataAddedAt: '2026-10-19T10:00:00Z', updated_at: '2026-10-19T10:00:00Z' },
    { id: 3, name: 'Empty account', kind: 'checking', dataAsOf: null },
    { id: 4, name: 'Recipient', kind: 'external', dataAsOf: '2025-01-01' },
    { id: 5, name: 'Today', kind: 'credit_card', dataAsOf: '2026-10-19' },
    { id: 6, name: 'Future', kind: 'checking', dataAsOf: '2026-10-20' }
  ].map(account => ({ status: 'active', transactions: 0, ...account }));
  const f = fixture(async () => response(200, { accounts, kinds: [] }));
  const RealDate = Date;
  f.context.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [2026, 9, 19, 23, 59])); }
  };
  f.run('accounts.js');
  await f.context.FinanceAccounts.loadPage();
  const cards = [...f.node('accounts-root').innerHTML.matchAll(/<article class="acct-card[^]*?<\/article>/g)].map(match => match[0]);
  const card = id => cards.find(html => html.includes(`data-account="${id}"`));
  assert.match(card(1), /2026-09-04<\/time> \(45 days ago\)/);
  assert.doesNotMatch(card(1), /acct-stale|Stale data/);
  assert.match(card(2), /acct-stale/);
  assert.match(card(2), /46 days ago/);
  assert.match(card(2), /Stale data - over 45 days old/);
  assert.match(card(2), /Transaction data last added: <time datetime="2026-10-19T10:00:00Z"/);
  assert.match(card(2), /Import a recent statement/);
  assert.match(card(3), /Last data update: unavailable/);
  assert.doesNotMatch(card(3), /acct-stale/);
  assert.match(card(4), /External recipient/);
  assert.doesNotMatch(card(4), /acct-stale|Stale data/);
  assert.match(card(5), /\(today\)/);
  assert.doesNotMatch(card(5), /acct-stale/);
  assert.doesNotMatch(card(6), /acct-stale|NaN|Invalid Date/);
});

test('CSV imports use detected accounts without a required global account picker', async () => {
  const calls = [];
  const f = fixture(async (url, options) => {
    calls.push([url, options]);
    return response(200, url === '/api/accounts/import-options' ? { accounts: [], kinds: [] } : {
      accounts: [{ key: 'checking', last4: '1111', needsReview: false, matchedAccountName: 'Checking' },
        { key: 'savings', last4: '2222', needsReview: false, matchedAccountName: 'Savings' }]
    });
  });
  f.run('accounts.js');
  const result = await f.context.FinanceAccounts.prepareCsv('CSV DATA', 'td.csv');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { accountMappings: {} });
  assert.equal(calls.filter(([url]) => url === '/api/import/inspect-csv').length, 1);
  assert.equal(f.node('csv-account-review').hidden, true);
  await f.context.FinanceAccounts.prepareCsv('CSV DATA', 'td.csv');
  assert.equal(calls.length, 2, 'the same file does not need another inspection');
  const html = source('index.html');
  assert.match(html, /id="import-account-picker" class="import-account" hidden/);
  const csv = html.slice(html.indexOf('    async function importCSV()'), html.indexOf('    let pendingPdfFile'));
  assert.doesNotMatch(csv, /FinanceAccounts\.choice/);
  assert.match(csv, /await FinanceAccounts\.prepareCsv/);
});

test('unmatched CSV accounts get a masked one-time review and separate mapping choices', async () => {
  const f = fixture(async url => response(200, url === '/api/accounts/import-options'
    ? { accounts: [{ id: 1, name: '<Checking>', kind: 'checking', last4: '1111' }],
      kinds: [{ value: 'checking', label: 'Checking' }, { value: 'savings', label: 'Savings' }] }
    : { accounts: [{ key: 'bank', last4: '1111', rows: 2, needsReview: true, reason: 'Confirm <account>' },
      { key: 'save', last4: '2222', rows: 3, needsReview: true, reason: 'New account' }] }));
  f.context.setImportStatus = (kind, message) => { f.context.status = [kind, message]; };
  f.run('accounts.js');
  assert.equal(await f.context.FinanceAccounts.prepareCsv('DATA', 'td.csv'), null);
  assert.match(f.node('csv-account-review').innerHTML, /Account ending 1111/);
  assert.match(f.node('csv-account-review').innerHTML, /Confirm &lt;account&gt;/);
  assert.match(f.node('csv-account-review').innerHTML, /&lt;Checking&gt;/);
  assert.equal(await f.context.FinanceAccounts.prepareCsv('DATA', 'td.csv'), null);
  assert.match(f.context.status[1], /each unmatched group/);
  const bank = f.node('csv-account-review').querySelector('[data-csv-account="bank"]');
  bank.querySelector('[data-csv-choice]').value = '1';
  const savings = f.node('csv-account-review').querySelector('[data-csv-account="save"]');
  savings.querySelector('[data-csv-choice]').value = 'new';
  savings.querySelector('[data-csv-name]').value = 'TD savings';
  savings.querySelector('[data-csv-kind]').value = 'savings';
  savings.querySelector('[data-csv-bank]').value = 'TD Bank';
  const result = await f.context.FinanceAccounts.prepareCsv('DATA', 'td.csv');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { accountMappings: {
    bank: { accountId: 1 }, save: { newAccount: { name: 'TD savings', kind: 'savings', last4: '2222', institution: 'TD Bank' } }
  } });
  const note = f.context.FinanceAccounts.resultNote({ accounts: [
    { account: { name: '<Checking>', last4: '1111' }, imported: 2, duplicates: 0 },
    { account: { name: 'Savings', last4: '2222' }, imported: 3, duplicates: 1 }
  ] });
  assert.match(note, /&lt;Checking&gt;/);
  assert.match(note, /3 imported, 1 duplicates skipped/);
});
test('identified new CSV accounts proceed without manual mapping and explain automatic creation', async () => {
  const f = fixture(async url => response(200, url === '/api/accounts/import-options'
    ? { accounts: [], kinds: [] }
    : { accounts: [{ key: 'new-bank', last4: '1111', rows: 2, autoCreate: true, needsReview: false },
      { key: 'new-save', last4: '2222', rows: 3, autoCreate: true, needsReview: false }] }));
  f.run('accounts.js');
  assert.deepEqual(JSON.parse(JSON.stringify(await f.context.FinanceAccounts.prepareCsv('DATA', 'td.csv'))), { accountMappings: {} });
  assert.equal(f.node('csv-account-review').hidden, true);
  const note = f.context.FinanceAccounts.resultNote({ accounts: [
    { account: { name: 'Account 1111', kind: 'other', autoCreated: true }, imported: 2, duplicates: 0 },
    { account: { name: 'Savings 2222', kind: 'savings', autoCreated: true }, imported: 3, duplicates: 0 }
  ] });
  assert.match(note, /Created 2 accounts from the file/);
  assert.match(note, /without a detected type are saved as Other/);
});
test('mixed CSV mapping review distinguishes automatic new accounts from missing identity', async () => {
  const f = fixture(async url => response(200, url === '/api/accounts/import-options'
    ? { accounts: [], kinds: [] }
    : { accounts: [{ key: 'new-bank', last4: '1111', rows: 2, autoCreate: true, needsReview: false },
      { key: 'unidentified', last4: null, rows: 1, needsReview: true, reason: 'No usable account number was found.' }] }));
  f.context.setImportStatus = () => {};
  f.run('accounts.js');
  assert.equal(await f.context.FinanceAccounts.prepareCsv('DATA', 'td.csv'), null);
  const markup = f.node('csv-account-review').innerHTML;
  assert.match(markup, /A new account will be created when you import/);
  assert.match(markup, /Transactions without an account number/);
  assert.doesNotMatch(markup, /Matched to null|data-csv-account="new-bank"/);
});

test('CSV inspection errors are explicit and late inspections cannot survive a session reset', async () => {
  let resolve;
  const f = fixture(url => url === '/api/accounts/import-options' ? Promise.resolve(response(200, { accounts: [], kinds: [] }))
    : new Promise(done => { resolve = done; }));
  f.run('accounts.js');
  const pending = f.context.FinanceAccounts.prepareCsv('PRIVATE DATA', 'private.csv');
  await new Promise(setImmediate);
  f.context.FinanceAccounts.reset();
  resolve(response(200, { accounts: [{ key: 'private', needsReview: true, last4: '1111' }] }));
  assert.equal(await pending, null);
  assert.equal(f.node('csv-account-review').innerHTML, '');
  const failed = fixture(async url => response(url === '/api/accounts/import-options' ? 200 : 422,
    url === '/api/accounts/import-options' ? { accounts: [], kinds: [] } : { error: 'No transactions could be read' }));
  failed.run('accounts.js');
  await assert.rejects(failed.context.FinanceAccounts.prepareCsv('BAD DATA', 'bad.csv'), /No transactions could be read/);
});

test('shared raised surfaces preserve nested spending cards, target states and reduced motion', () => {
  const css = source('refresh.css');
  assert.match(css, /--card-depth: inset 0 1px 0 #fff/);
  assert.match(css, /body \.view \.panel,[^]*?box-shadow: var\(--card-depth\)/);
  assert.match(css, /\.metric-card:not\(\.mtd-category-card\)/);
  assert.match(css, /\.plan-debt:not\(\.is-excluded\):not\(\.is-target\)/);
  for (const surface of ['welcome-pulse-row', 'pro-kpi', 'pay-cal-summary', 'plan-strategy', 'tut-card']) assert.ok(css.includes(`body .view .${surface}`));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^]*?\.plan-goal:hover \{ transform: none/);
});
test('phone analytics wraps metric labels and contains readable charts and tables', () => {
  const css = source('analytics.css');
  assert.match(css, /\.analytics-content > \*, \.pro-card-body > \* \{ min-width: 0/);
  assert.match(css, /\.pro-kpi > span \{ white-space: normal; overflow: visible/);
  assert.match(css, /\.pro-chart-scroll \.pro-chart \{ min-width: 560px/);
  assert.match(css, /\.pro-sankey-wrap \.pro-sankey \{ min-width: 960px/);
  assert.match(css, /@media \(max-width: 359px\)/);
  const script = source('analytics.js');
  assert.match(script, /role="region" aria-label="\$\{label\}" tabindex="0"/);
  assert.match(script, /Swipe sideways to explore/);
  assert.match(source('index.html'), /class="panel transaction-panel" role="region" aria-label="Transaction details" tabindex="0"/);
});

test('all frontend scripts and inline application code parse', () => {
  for (const file of ['session.js','client-errors.js','ui.js','refresh.js','review-tools.js','accounts.js','account.js','admin.js','pro-charts.js','pro-core.js','pro-dashboard.js','pro-categories.js','analytics.js','plan.js','welcome.js','tutorial.js','income-review.js','marketing.js']) new vm.Script(source(file));
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
test('transaction troubleshooting and activity log routes load their matching pages', () => {
  const f = fixture(); let transferLoads = 0, activityLoads = 0;
  f.context.FinanceReviewTools = {
    loadTransfers: () => { transferLoads++; },
    loadActivity: () => { activityLoads++; }
  };
  f.run('refresh.js');
  f.context.showView('transaction-review');
  assert.deepEqual(f.views.filter(view => view.classList.contains('active')).map(view => view.id), ['transaction-review-view']);
  assert.equal(f.node('current-page').textContent, 'Transaction troubleshooting');
  f.context.showView('activity');
  assert.deepEqual(f.views.filter(view => view.classList.contains('active')).map(view => view.id), ['activity-view']);
  assert.equal(f.node('current-page').textContent, 'Activity log');
  assert.deepEqual([transferLoads, activityLoads], [1, 1]);
});
test('Knowledge Base has a direct route and explains both analytics offerings', () => {
  const f = fixture(); f.run('refresh.js');
  f.context.showView('knowledge-base');
  assert.deepEqual(f.views.filter(view => view.classList.contains('active')).map(view => view.id), ['knowledge-base-view']);
  assert.equal(f.node('current-page').textContent, 'Knowledge Base');
  assert.equal(f.context.location.hash, '#knowledge-base');
  const html = source('index.html');
  for (const text of ['Month-end forecast', '6-month cash flow', 'Monthly spend trend', 'Recurring charges not marked fixed', 'Category signals', 'Unusual activity', 'Top merchants', 'Weekly rhythm', 'Where your money flows', 'Where the signals overlap', 'Who gets your money', 'Hot and cold months', 'Your normal range', 'Technical readings']) {
    assert.ok(html.includes(text), `Knowledge Base should explain ${text}`);
  }
});
test('public About and Contact links are visible and the Knowledge Base sits above Tutorials', () => {
  const html = source('index.html');
  const mainNavigation = html.match(/<nav aria-label="Main navigation">([\s\S]*?)<\/nav>/)?.[1] || '';
  assert.ok(mainNavigation.indexOf('Financial Checkup') < mainNavigation.indexOf('Knowledge Base'));
  assert.ok(mainNavigation.indexOf('Knowledge Base') < mainNavigation.indexOf('Tutorials'));
  assert.match(html, /data-marketing-jump="marketing-about">About/);
  assert.match(html, /data-marketing-jump="marketing-contact">Contact/);
  assert.match(html, /id="marketing-about"[\s\S]*?MyFinance is a personal finance workspace/);
  assert.match(html, /id="marketing-contact"[\s\S]*?href="mailto:ashak4031@gmail\.com">ashak4031@gmail\.com/);
  assert.match(html, /Settings &amp; support/);
});
test('Financial Checkup gives a realistic cash-flow and goal assessment with relevant next steps', async () => {
  const plan = {
    monthsUsed: 3, avgMonthlyIncome: 5000, avgMonthlyExpenses: 4700, monthlySurplus: 300,
    requiredMonthlySavings: 450, availableAfterGoals: -150, additionalDebtPayments: 0,
    basis: 'Local calculations from completed months.', total_goals: 1,
    goals: [{ name: '<Emergency fund>', requiredMonthly: 450, allocatedMonthly: 300, monthly_shortfall: 150, remaining: 6000, status: 'shortfall' }],
    categorySpending: [{ category: '<Dining>', monthlyAverage: 400, total: 1200 }]
  };
  const f = fixture(async url => url === '/api/goals/funding-analysis' ? response(200, plan) : response(200, {}));
  f.run('refresh.js');
  const generate = f.context.generateInsights;
  f.context.generateInsights = () => Promise.resolve();
  f.context.showView('insights');
  assert.equal(f.node('current-page').textContent, 'Financial Checkup');
  f.context.generateInsights = generate;
  await generate();
  const html = f.node('insights-container').innerHTML;
  assert.match(html, /Your dated goals need more than this history supports/);
  assert.match(html, /modeled gap of \$150\.00 per month/);
  assert.match(html, /data-view="goals">Review savings goals/);
  assert.match(html, /data-view="analytics">Open Analytics/);
  assert.match(html, /data-view="payoff">Compare payoff scenarios/);
  assert.match(html, /fees, promotional expiry and eligibility/);
  assert.match(html, /&lt;Emergency fund&gt;/);
  assert.match(html, /&lt;Dining&gt;/);
  assert.doesNotMatch(html, /<Emergency fund>|<Dining>/);
  assert.match(html, /not generative AI/);
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
test('account review requires an owned type and the not-mine action saves an external recipient', async t => {
  let account = { id: 2, name: 'Detected 4821', kind: 'unknown', status: 'needs_review', transactions: 0 };
  const changes = [], messages = [];
  const f = fixture(async (url, options = {}) => {
    if (options.method === 'PATCH') {
      const update = JSON.parse(options.body); changes.push(update);
      account = { ...account, ...update, status: 'confirmed' };
    }
    return response(200, { accounts: [account], kinds: [{ value: 'external', label: 'Not yours' }] });
  });
  await t.test('Accounts shows statement balance and purchase APR even without activity rows', async () => {
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
      pdfManualAccount: true,
      AbortSignal,
      crypto: { randomUUID: () => '1f21b779-639a-4206-a9d0-350f08587dcd' },
      FinanceAccounts: { choice: () => ({ accountId: 1 }), prepareCsv: async () => ({ accountMappings: {} }),
        resetCsv() {}, afterImport: async () => {}, resultNote: () => '' },
      FileReader: class { readAsDataURL() { this.result = 'data:application/pdf;base64,JVBERg=='; setTimeout(() => this.onload(), 0); } },
      escapeHtml: f.context.FinanceTools.escape, usd: value => `$${Number(value).toFixed(2)}`,
      notify: message => notices.push(message)
    });
    const html = source('index.html');
    const modalStart = html.indexOf('    function openImportModal(');
    const modalEnd = html.indexOf('    function switchImportTab', modalStart);
    vm.runInContext(html.slice(modalStart, modalEnd), f.context);
    const tabStart = html.indexOf('    function switchImportTab(');
    const tabEnd = html.indexOf('    async function plaidRequest', tabStart);
    vm.runInContext(html.slice(tabStart, tabEnd), f.context);
    const chooseStart = html.indexOf('    function choosePdfAccount()');
    const chooseEnd = html.indexOf('    function onPdfSelected', chooseStart);
    vm.runInContext(html.slice(chooseStart, chooseEnd), f.context);
    const start = html.indexOf('    async function importPDF()');
    const end = html.indexOf('    // ===========================================', start);
    vm.runInContext(html.slice(start, end), f.context);
    const csvStart = html.indexOf('    async function importCSV()');
    const csvEnd = html.indexOf('    let pendingPdfFile', csvStart);
    vm.runInContext(html.slice(csvStart, csvEnd), f.context);
    return { ...f, requests, notices };
  }
  await t.test('PDF results include the support reference returned by the server', async () => {
    const f = pdfUploadFixture(422, { error: 'Nothing was imported.', requestId: 'support-reference-123' });
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /Nothing was imported[^]*Support reference:[^]*support-reference-123/);
  });
  await t.test('CSV and PDF share a one-at-a-time guard and multi-file drops are rejected', async () => {
    const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1 });
    f.context.pendingCsvFile = { name: 'sample.csv', size: 50 };
    const original = f.context.pendingCsvFile;
    const running = f.context.importPDF();
    await f.context.importCSV();
    f.context.handleCsvDrop({ preventDefault() {}, dataTransfer: { files: [{ name: 'replacement.csv', type: 'text/csv' }] } });
    assert.equal(f.context.pendingCsvFile, original);
    assert.match(f.node('import-result').innerHTML, /one file at a time/);
    await running;
    assert.equal(f.requests.length, 1);
    f.context.handlePdfDrop({ preventDefault() {}, dataTransfer: { files: [
      { name: 'one.pdf', type: 'application/pdf' }, { name: 'two.pdf', type: 'application/pdf' }
    ] } });
    assert.equal(f.context.pendingPdfFile, null);
    assert.match(f.node('import-result').innerHTML, /No files from this selection were added/);
  });
  await t.test('CSV double submits are blocked, PDF cannot overlap, and CSV failures have a support reference', async () => {
    const f = pdfUploadFixture(422, { error: 'Bad export.', requestId: 'csv-support-123' });
    f.context.pendingCsvFile = { name: 'sample.csv', size: 50 };
    f.context.FileReader = class {
      readAsText() { this.result = 'Date,Description,Amount'; setTimeout(() => this.onload(), 0); }
    };
    const running = f.context.importCSV();
    await f.context.importCSV();
    await f.context.importPDF();
    await running;
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0][0], '/api/import/import-csv');
    assert.match(f.node('import-result').innerHTML, /Bad export[^]*csv-support-123/);
    assert.equal(f.node('csv-import-btn').disabled, false);
  });
  await t.test('CSV overlap review handles the session fetch wrapper throwing review-required responses', async () => {
    const f = pdfUploadFixture(409, {});
    f.context.pendingCsvFile = { name: 'mixed.csv', size: 50 };
    f.context.FileReader = class {
      readAsText() { this.result = 'synthetic csv'; setTimeout(() => this.onload(), 0); }
    };
    f.context.fetch = async () => { throw Object.assign(new Error('Review overlaps.'), { code: 'OVERLAP_REVIEW_REQUIRED', status: 409 }); };
    let review;
    f.context.FinanceAccounts.reviewCsvOverlaps = async (...args) => { review = args; };
    await f.context.importCSV();
    assert.deepEqual(JSON.parse(JSON.stringify(review)), ['synthetic csv', 'mixed.csv', { accountMappings: {} }]);
    assert.equal(f.node('csv-import-btn').disabled, false);
    assert.equal(f.node('csv-overlap-review').inert, false);
    f.context.FinanceAccounts.reviewCsvOverlaps = async () => { throw new Error('Preview unavailable'); };
    await f.context.importCSV();
    assert.match(f.node('import-result').innerHTML, /Could not load overlap review: Preview unavailable/);
  });
  await t.test('PDF upload prevents double submits and displays detected statement/reconciliation facts', async t => {
    const f = pdfUploadFixture(200, {
      success: true, imported: 6, duplicates: 0, totalInFile: 6,
      statement: { type: 'credit-card', closingDate: '2026-10-03', balance: 110, purchaseApr: 24.99 },
      reconciliation: { status: 'balanced' }, warnings: ['Check <promotional> rate']
    });
    await t.test('PDF auto account mode uploads without requiring account input and reveals manual fallback only on review', async () => {
      const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1 });
      f.context.pdfManualAccount = false;
      f.context.FinanceAccounts.choice = () => { throw new Error('Automatic PDF import must not ask for an account'); };
      await f.context.importPDF();
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0][1].accountId, undefined);
      assert.equal(f.requests[0][1].newAccount, undefined);
      const review = pdfUploadFixture(422, { code: 'ACCOUNT_REVIEW_REQUIRED', error: 'Several accounts match. Choose the account.' });
      review.context.pdfManualAccount = false;
      review.node('import-account-picker').hidden = true;
      await review.context.importPDF();
      assert.equal(review.context.pdfManualAccount, true);
      assert.equal(review.node('import-account-picker').hidden, false);
      assert.match(review.node('import-result').innerHTML, /Several accounts match/);
      assert.equal(review.node('pdf-import-btn').disabled, false);
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
  await t.test('PDF upload failures keep the file for retry and oversized files never reach the API', async () => {
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
  await t.test('choosing another PDF during upload cannot resubmit or discard the new selection', async () => {
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
  await t.test('PDF progress is visible immediately and completion survives closing and reopening', async () => {
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
  await t.test('closing a failed PDF import clears its file but retains the failure details', async () => {
    const f = pdfUploadFixture(422, { error: 'Nothing was imported. Check the statement.' });
    await f.context.importPDF();
    f.context.closeImportModal();
    assert.equal(f.context.pendingPdfFile, null);
    assert.equal(f.node('pdf-import-btn').disabled, true);
    assert.equal(f.node('pdf-file-list').textContent, '');
    f.context.openImportModal();
    assert.match(f.node('import-result').innerHTML, /Nothing was imported/);
  });
  await t.test('missing account names show an in-dialog error without sending the PDF', async () => {
    const f = pdfUploadFixture(200, {});
    f.run('accounts.js');
    f.node('import-account-select').value = 'new';
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /Give the new account a name/);
    assert.equal(f.node('import-result').style.display, 'block');
    assert.equal(f.requests.length, 0);
    assert.equal(f.notices.length, 0);
  });
  await t.test('account picker failures are visible in the import dialog', async () => {
    const f = pdfUploadFixture(200, {});
    f.run('accounts.js');
    f.context.fetch = async () => response(503, { error: 'Accounts unavailable' });
    await f.context.FinanceAccounts.loadPicker();
    assert.match(f.node('import-result').innerHTML, /Accounts could not be loaded: Accounts unavailable/);
  });
  await t.test('the actual PDF picker cannot replace an in-flight upload', async () => {
    const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1 });
    const file = f.context.pendingPdfFile;
    const running = f.context.importPDF();
    f.context.onPdfSelected({ target: { files: [{ name: 'next.pdf', size: 1024 }] } });
    assert.equal(f.context.pendingPdfFile, file);
    assert.match(f.node('import-result').innerHTML, /already running/);
    await running;
    assert.equal(f.requests.length, 1);
  });
  await t.test('post-import account refresh failures remain visible alongside the saved result', async () => {
    const f = pdfUploadFixture(200, { success: true, imported: 1, duplicates: 0, totalInFile: 1 });
    f.context.FinanceAccounts.afterImport = async () => { throw new Error('Connection lost'); };
    await f.context.importPDF();
    assert.match(f.node('import-result').innerHTML, /PDF Import Complete[^]*PDF imported, but account refresh failed: Connection lost/);
  });
  await t.test('unreadable server responses and timeouts explain an unknown PDF outcome', async () => {
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
  const f = fixture(async url => response(200, url === '/api/categories' ? categoryData
    : url.endsWith('categorization-rules') ? { categories: categoryData, rules: [] }
    : { transactions: activity }));
  const RealDate = Date;
  f.context.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [2026, 9, 16, 12])); } };
  return f;
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
  assert.equal(f.node('txn-filter-period').value, 'last-3');
  assert.equal(f.node('txn-filter-fixed').checked, false);
  assert.match(f.node('full-txn-table').innerHTML, /September market/);
  assert.match(f.node('txn-filter-status').textContent, /Last 3 months · 4 matching/);
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
  assert.deepEqual(resolve('last-3', [], '2026-01-16T12:00:00').months, ['2025-11', '2025-12', '2026-01']);
  assert.equal(resolve('last-6', [], '2026-10-16T12:00:00').months.length, 6);
  assert.equal(resolve('last-24', [], '2026-10-16T12:00:00').months.length, 24);
  assert.deepEqual(resolve('custom', [], '2026-10-16T12:00:00').months, []);
  assert.deepEqual(resolve('year:2025', [], '2026-10-16T12:00:00').months.slice(0, 2), ['2025-01', '2025-02']);
  assert.deepEqual(resolve('custom', ['2026-10', '2026-08'], '2026-10-16T12:00:00'), { months: ['2026-08', '2026-10'], label: 'Aug 2026, Oct 2026' });
});
test('three-month defaults exclude older spending, while All time remains an explicit choice', async () => {
  const f = activityFixture(); f.run('refresh.js');
  const old = { ...activity[0], id: 5, date: '2025-01-01', amount: 50000, description: 'Old large purchase' };
  f.context.fetch = async url => response(200, url === '/api/categories' ? categoryData
    : url.endsWith('categorization-rules') ? { categories: categoryData, rules: [] }
    : { transactions: [...activity, old] });
  await f.context.loadAllTransactions();
  await f.context.loadCategories();
  assert.equal(f.node('txn-filter-period').value, 'last-3');
  assert.equal(f.node('category-filter-period').value, 'last-3');
  assert.doesNotMatch(f.node('full-txn-table').innerHTML, /Old large purchase/);
  assert.doesNotMatch(f.node('category-cards').innerHTML, /\$50,062/);
  assert.equal(f.node('txn-filter-period').innerHTML, f.node('category-filter-period').innerHTML);
  for (const n of [3, 6, 12, 24]) assert.match(f.node('txn-filter-period').innerHTML, new RegExp(`value="last-${n}">Last ${n} months`));
  f.node('txn-filter-period').value = '';
  await f.node('txn-filter-period').onchange();
  assert.match(f.node('full-txn-table').innerHTML, /Old large purchase/);
  f.node('txn-filter-period').value = 'custom';
  await f.node('txn-filter-period').onchange();
  assert.match(f.node('full-txn-table').innerHTML, /No transactions match/);
  assert.equal((f.node('txn-summary').innerHTML.match(/\$0\.00/g) || []).length, 3);
});
test('transaction search matches description, category and amount and highlights matches', async () => {
  const f = activityFixture(); f.run('refresh.js');
  f.node('txn-filter-search').value = 'market';
  await f.context.loadAllTransactions();
  let html = f.node('full-txn-table').innerHTML;
  assert.match(html, /October <mark>market<\/mark>/);
  assert.match(html, /September <mark>market<\/mark>/);
  assert.doesNotMatch(html, /October cafe|October salary/);
  assert.match(f.node('txn-filter-status').textContent, /Last 3 months · “market” · 2 matching/);
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
  assert.match(f.node('txn-filter-status').textContent, /Last 3 months · 4 matching/);
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
  assert.deepEqual(f.context.findSimilarTransactions(rows, rows[0], '').map(item => item.transaction.id), ['2', '3', '6', '4']);
  rows[1].is_fixed = true;
  const fixedMatches = f.context.findSimilarTransactions(rows, rows[0], { isFixed: true });
  assert.deepEqual(fixedMatches.map(item => item.transaction.id), ['3', '6', '4']);
  assert.deepEqual(f.context.findSimilarTransactions(rows, rows[0], { isFixed: false }).map(item => item.transaction.id), ['2']);
});
test('processor-prefixed merchants never group unrelated restaurants by TST or Square', () => {
  const f = fixture(); f.run('refresh.js');
  const key = f.context.merchantKey;
  assert.equal(key('TST* TRIBOS PERI PERI - M METUCHEN NJ'), 'TRIBOS PERI PERI');
  assert.equal(key('VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ'), 'TRIBOS PERI PERI');
  assert.equal(key('TOAST* TRIBOS PERI PERI METUCHEN NJ'), 'TRIBOS PERI PERI');
  assert.equal(key('SQ * TRIBOS PERI PERI METUCHEN NJ'), 'TRIBOS PERI PERI');
  assert.equal(key('SQUARE * TRIBOS PERI PERI METUCHEN NJ'), 'TRIBOS PERI PERI');
  assert.equal(key('VISA DDA PUR AP 123456 TST'), '');
  const rows = [
    'TST* TRIBOS PERI PERI - M METUCHEN NJ',
    'VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ',
    'VISA DDA PUR AP 469216 TST CHAI CHENAK NEW BRUNSWICK * NJ',
    'VISA DDA PUR AP 469216 TST SHIR CHAI CO NORTH BRUNSWI * NJ',
    'VISA DDA PUR AP 413746 TST HUNGRY TIGER BELLE MEAD * NJ',
    'VISA DDA PUR AP 413746 TST BAGEL BAZAAR DAYTON * NJ'
  ].map((description, index) => ({ id: index + 1, description, date: '2026-09-01', direction: 'DEBIT', amount: 35, category: 'Shopping' }));
  for (const change of ['Dining', { isFixed: true }, { payMode: 'manual' }, { income: true }]) {
    assert.deepEqual(f.context.findSimilarTransactions(rows, rows[0], change).map(item => item.transaction.id), [2]);
  }
});
for (const renamed of [false, true, 'partial', 'friendly-search']) test(`Peri Peri category correction respects the search and updates only confirmed matches (${renamed || 'original'} payee)`, async () => {
  const calls = [];
  const transactions = [
    { id: 1, date: '2026-09-23', description: 'TST* TRIBOS PERI PERI - M METUCHEN NJ', amount: 35.45 },
    { id: 2, date: '2026-08-10', description: 'VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ', amount: 35.45 },
    { id: 3, date: '2026-07-10', description: 'VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ', amount: 86.84 },
    { id: 4, date: '2026-04-15', description: 'VISA DDA PUR AP 469216 TST CHAI CHENAK NEW BRUNSWICK * NJ', amount: 35.45 },
    { id: 5, date: '2026-03-30', description: 'VISA DDA PUR AP 469216 TST SHIR CHAI CO NORTH BRUNSWI * NJ', amount: 31.18 },
    { id: 6, date: '2026-02-01', description: 'TST TRIBOS GRILL METUCHEN NJ', amount: 35.45 }
  ].map(t => ({ ...t, direction: 'DEBIT', category: 'Shopping', display_name: renamed === true && [1, 2, 3, 6].includes(t.id) ? 'Tribos' : renamed && t.id === 1 ? 'Favorite dinner' : null }));
  const f = fixture(async (url, options = {}) => {
    calls.push([url, options.body ? JSON.parse(options.body) : null]);
    if (url === '/api/categories') return response(200, [{ name: 'Shopping' }, { name: 'Dining' }]);
    if (url === '/api/dashboard/all-transactions') return response(200, { transactions });
    return response(200, { success: true, updated: 1 });
  });
  f.run('refresh.js');
  const query = renamed === 'friendly-search' ? 'Favorite dinner' : 'peri peri';
  f.node('txn-filter-search').value = query;
  await f.context.loadAllTransactions();
  const select = { value: 'Dining', disabled: false, matches: selector => selector === '[data-category]', closest: () => ({ dataset: { transaction: '0' } }) };
  const pending = f.node('full-txn-table').onchange({ target: select });
  await new Promise(resolve => setTimeout(resolve, 0));
  const dialog = f.node('body').options.find(child => child.id === 'similar-dialog');
  assert.equal(dialog.open, true);
  assert.equal(calls.some(([url]) => url === '/api/transactions/categorization-apply' || url === '/api/transactions/update-transaction'), false, 'no category writes before confirmation');
  assert.match(f.node('similar-copy').innerHTML, /Found <strong>2<\/strong> other transactions/);
  assert.ok(f.node('similar-copy').innerHTML.includes(`Started from your search “${query}”`));
  assert.doesNotMatch(f.node('similar-list').innerHTML, /CHAI|GRILL/);
  assert.match(f.node('similar-list').innerHTML, /href="#transactions\/2"/);
  assert.match(f.node('similar-list').innerHTML, /href="#transactions\/3"/);
  assert.match(f.node('similar-list').innerHTML, /data-similar="0" checked/);
  assert.match(f.node('similar-list').innerHTML, /data-similar="1" >/);
  f.node('similar-list').querySelectorAll = () => [{ checked: true, dataset: { similar: '0' } }, { checked: false, dataset: { similar: '1' } }];
  await f.node('similar-form').onsubmit({ preventDefault() {} });
  await pending;
  assert.deepEqual(calls.find(([url]) => url === '/api/transactions/categorization-apply')[1], {
    updates: [{ id: 1, category: 'Dining', expectedCategory: 'Shopping' }, { id: 2, category: 'Dining', expectedCategory: 'Shopping' }], learnRules: true, protectCorrections: false
  });
  assert.equal(f.node('txn-filter-search').value, query);
  assert.equal(dialog.open, false);
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
  assert.deepEqual(apply, { updates: [{ id: 1, category: 'Subscriptions', expectedCategory: 'Entertainment' }, { id: 2, category: 'Subscriptions', expectedCategory: 'Entertainment' }, { id: 3, category: 'Subscriptions', expectedCategory: null }], learnRules: true, protectCorrections: false });
  assert.equal(dialog.open, false);
});
test('pay-mode column, filter and similar-payment prompt mark auto-pay and manual debits', async t => {
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
  await t.test('category review can cancel or change only the starting payment without remembering a rule', async () => {
    const writes = [];
    const transactions = [{ id: 1, date: '2026-09-01', description: 'LOCAL CAFE', amount: 20, direction: 'DEBIT', category: 'Shopping' }];
    const f = fixture(async (url, options = {}) => {
      if (options.method === 'POST') writes.push(JSON.parse(options.body));
      if (url === '/api/categories') return response(200, [{ name: 'Dining' }, { name: 'Shopping' }]);
      if (url === '/api/dashboard/all-transactions') return response(200, { transactions });
      return response(200, { updated: 1 });
    });
    f.run('refresh.js');
    await f.context.loadAllTransactions();
    const select = { value: 'Dining', matches: () => false, closest: () => ({ dataset: { transaction: '0' } }) };
    const pending = f.node('full-txn-table').onchange({ target: select });
    await new Promise(resolve => setTimeout(resolve, 0));
    const dialog = f.node('body').options.find(child => child.id === 'similar-dialog');
    assert.equal(dialog.open, true);
    assert.equal(writes.length, 0);
    f.node('similar-cancel').onclick();
    await pending;
    assert.equal(writes.length, 0);
    const retry = f.node('full-txn-table').onchange({ target: select });
    await new Promise(resolve => setTimeout(resolve, 0));
    f.node('similar-remember').checked = false;
    await f.node('similar-skip').onclick();
    await retry;
    assert.deepEqual(writes, [{ updates: [{ id: 1, category: 'Dining', expectedCategory: 'Shopping' }], learnRules: false, protectCorrections: false }]);
  });
  f.run('refresh.js');
  f.node('txn-filter-period').value = '';
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
test('dashboard rolls across months, includes overdue in cash and keeps paid history out of the main views', async () => {
  const timeline = [
    { date: '2026-11-19', amount: 50, description: 'End day bill' },
    { date: '2026-10-03', amount: 100, description: 'Overdue bill' },
    { date: '2026-10-10', amount: 900, description: 'Paid mortgage', status: 'processed', isFixed: true, id: 42 },
    { date: '2026-10-10', amount: 20, description: 'Unrelated card purchase', status: 'processed', isFixed: false, id: 43 },
    { date: '2026-10-11', amount: 800, description: 'Received paycheck', status: 'processed', isIncome: true },
    { date: '2026-10-12', amount: 100, description: 'Past savings allocation', status: 'processed', planned: true },
    { date: '2026-11-01', amount: 500, description: 'Next month rent' },
    { date: '2026-11-01', amount: 800, description: 'Paycheck', isIncome: true },
    { date: '2026-11-20', amount: 9999, description: 'Outside horizon' },
    { date: '2026-09-30', amount: 9999, description: 'Prior history', status: 'processed' }
  ].map(item => ({ status: 'projected', dayOfMonth: Number(item.date.slice(-2)), ...item }));
  const f = fixture(async url => response(200, url.endsWith('/summary') ? { balance: 1000, income: 2000, expenses: 1000, netCashflow: 1000 }
    : url.endsWith('/upcoming-payments') ? timeline : []));
  const RealDate = Date;
  f.context.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [2026, 9, 20, 12])); } };
  f.context.escapeHtml = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  f.context.usd = value => '$' + Number(value).toFixed(2);
  f.context.transactionLink = (id, name) => `<a href="#transactions/${id}">${name}</a>`;
  f.node('upcoming-section').insertAdjacentHTML = () => {};
  const html = source('index.html');
  vm.runInContext(html.slice(html.indexOf('let dashboardRequest = 0;'), html.indexOf('async function toggleFixed')), f.context);
  await f.context.loadDashboard();
  const markup = f.node('dashboard-payments').innerHTML;
  const history = markup.match(/<details class="pay-history">[^]*?<\/details>/)[0];
  const main = markup.replace(history, '');
  assert.ok(markup.indexOf('<details class="pay-history">') < markup.indexOf('<div class="pay-cal"'));
  assert.ok(markup.indexOf('<details class="pay-history">') < markup.indexOf('<ol class="pay-list" aria-label="Next 30 days'));
  assert.match(main, /Projected balance in 30 days<\/span><strong>\$1,150\.00/);
  assert.match(main, /data-date="2026-10-03"/);
  assert.match(main, /data-date="2026-11-19"/);
  assert.doesNotMatch(main, /data-date="2026-11-20"|Outside horizon|Paid mortgage|Prior history/);
  assert.match(main, /Earlier this month &middot; still pending/);
  assert.match(history, /href="#transactions\/42">Paid mortgage/);
  assert.match(history, /1 paid bill.*\$900\.00/);
  assert.doesNotMatch(history, /Received paycheck|Past savings allocation|Planned|Received|Unrelated card purchase/);
  assert.match(history, /Paid fixed bills this month/);
  assert.match(main, /Next 30 days/);
  assert.match(source('refresh.css'), /#upcoming-section \.pay-history > ol\.pay-list \{ display: block/);
});
test('calculation information controls open readable labeled dialogs with matching content', () => {
  const f = fixture();
  let dialog, focused = false;
  const create = f.context.document.createElement;
  f.context.document.createElement = tag => {
    const element = create(tag);
    if (tag === 'dialog') dialog = element;
    return element;
  };
  f.run('ui.js');
  const markup = f.context.FinanceUI.howCalc('Balance minus <planned> bills.', 'Safe to spend calculation');
  assert.match(markup, /<button[^>]*aria-haspopup="dialog"/);
  assert.match(markup, /data-calculation="Balance minus &lt;planned&gt; bills\."/);
  assert.doesNotMatch(markup, /<details|<summary|>\?</);
  const trigger = {
    dataset: { calculation: 'Balance minus <planned> bills.', calculationTitle: 'Safe to spend calculation' },
    focus() { focused = true; }
  };
  f.listeners.get('document:click')({ target: { closest: () => trigger } });
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /aria|calculation-dialog-1-title/);
  assert.equal(dialog.querySelector('h2').textContent, trigger.dataset.calculationTitle);
  assert.equal(dialog.querySelector('p').textContent, trigger.dataset.calculation);
  dialog.close();
  assert.equal(focused, true);
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
test('category overview ranks spending, separates money movement, and collapses unused categories', async () => {
  const categories = ['Dining', 'Income', 'Groceries', 'Savings', 'Travel', 'Refunds', '<Custom>'].map((name, id) => ({ id: id + 1, name }));
  const transactions = [
    { category: 'Dining', amount: 30, direction: 'DEBIT', date: '2026-10-01', transfer_kind: null },
    { category: 'Groceries', amount: 120, direction: 'DEBIT', date: '2026-10-02', transfer_kind: null },
    { category: 'Income', amount: 2000, direction: 'CREDIT', date: '2026-10-02', transfer_kind: null },
    { category: 'Savings', amount: 500, direction: 'DEBIT', date: '2026-10-02', transfer_kind: 'savings' },
    { category: 'Refunds', amount: 15, direction: 'CREDIT', date: '2026-10-02', transfer_kind: null },
    { category: 'Groceries', amount: 300, direction: 'DEBIT', date: '2026-10-02', transfer_kind: 'internal' }
  ];
  const f = fixture(async url => response(200, url === '/api/transactions/categorization-rules'
    ? { categories, rules: [] } : { transactions }));
  f.run('refresh.js');
  await f.context.loadCategories();
  const html = f.node('category-cards').innerHTML;
  assert.ok(html.indexOf('data-open-category="Groceries"') < html.indexOf('data-open-category="Dining"'));
  assert.match(html, /category-spending-title[\s\S]*\$120\.00[\s\S]*80\.0%[\s\S]*\$30\.00[\s\S]*20\.0%/);
  assert.match(html, /category-movement-title[\s\S]*\$2,000\.00[\s\S]*received[\s\S]*\$15\.00[\s\S]*received[\s\S]*\$500\.00[\s\S]*transfer activity/);
  assert.match(html, /<details class="category-inactive"><summary>No activity this period <span>2<\/span>/);
  assert.match(html, /data-open-category="&lt;Custom&gt;"/);
  assert.doesNotMatch(html, /<Custom>|<details[^>]*\bopen\b/);
  assert.match(f.node('category-overview-summary').innerHTML, /\$150\.00/);
  assert.match(f.node('category-overview-summary').innerHTML, /Active categories<\/small><strong>5<em> \/ 7/);
  assert.match(f.node('category-overview-summary').innerHTML, /Transactions<\/small><strong>6/);
  f.node('category-filter-period').value = 'year:2025';
  await f.node('category-filter-period').onchange();
  assert.match(f.node('category-cards').innerHTML, /No activity this period <span>7<\/span>/);
  assert.doesNotMatch(f.node('category-cards').innerHTML, /<span class="category-card-total">/);
  assert.match(f.node('category-overview-summary').innerHTML, /\$0\.00/);
});
test('category artwork uses meaningful word matches instead of car/care and ev substrings', async () => {
  const expected = [
    ['Healthcare', '🩺'], ['Personal Care', '🧴'], ['Childcare', '🧸'], ['Pet Care', '🐾'],
    ['Credit Card', '📊'], ['Car Insurance', '🚗'], ['EV Charging', '🚗'],
    ['Travel', '✈️'], ['Entertainment', '🎬'], ['Developer Tools', '✨'],
    ['Education', '📚'], ['Utilities', '⚡'], ['Dining', '🍽️'], ['Groceries', '🥑'],
    ['Gifts', '🎁'], ['Savings', '🌱'], ['Transfers', '🔁'], ['Shopping', '🛍️']
  ];
  const f = fixture(async url => response(200, url === '/api/transactions/categorization-rules'
    ? { categories: expected.map(([name], id) => ({ id: id + 1, name })), rules: [] } : { transactions: [] }));
  f.run('refresh.js');
  await f.context.loadCategories();
  const html = f.node('category-cards').innerHTML;
  for (const [name, icon] of expected) {
    const card = html.split(`data-open-category="${name}"`)[1]?.split('</button>')[0];
    assert.ok(card?.includes(`<span>${icon}</span>`), `${name} uses ${icon}`);
  }
  assert.equal((html.match(/<span>🚗<\/span>/g) || []).length, 2);
});
test('category surfaces keep depth, keyboard focus, responsive layout, and reduced-motion support', () => {
  const styles = source('categories.css');
  assert.match(source('index.html'), /href="categories\.css\?v=/);
  assert.match(styles, /#categories-view \.category-card \{[^}]*radial-gradient[^}]*box-shadow: inset/);
  assert.match(styles, /\.category-card:focus-visible \{[^}]*outline:/);
  assert.match(styles, /@media\(max-width: 600px\)[\s\S]*grid-template-columns: minmax\(0,1fr\)/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*transform: none/);
  assert.match(styles, /#categories-view \.pro-cat-extra \{ display: none/);
  assert.match(styles, /#categories-view:has\(\.category-analytics\[open\]\) \.pro-cat-extra \{ display: grid/);
  assert.match(source('pro-categories.js'), /<details class="category-analytics/);
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
test('debt coaching renders real funding math, spending experiments and projected first wins without saving', async () => {
  const { computePlan } = await import('../backend/utils/moneyPlan.js');
  const now = new Date(2026, 9, 20);
  const history = ['07', '08', '09'].flatMap(month => [
    { date: `2026-${month}-01`, amount: 6000, direction: 'CREDIT', category: 'Salary', description: 'Pay', transfer_kind: null },
    { date: `2026-${month}-02`, amount: 3500, direction: 'DEBIT', category: 'Rent', description: 'Rent', is_fixed: true, transfer_kind: null },
    { date: `2026-${month}-03`, amount: 500, direction: 'DEBIT', category: 'Dining <night>', description: 'Cafe', is_fixed: false, transfer_kind: null }
  ]);
  const p = computePlan({
    history, recent: [], goals: [],
    debts: [{ id: 1, name: '<Visa>', balance: 10000, apr: 24, min_payment: 300, payment_in_history: true }],
    settings: { debt_budget: 500, goal_budget: 0 }
  }, { pro: true, now });
  const calls = [];
  const f = loadPlan(async (url, options = {}) => {
    calls.push([url, options.method || 'GET']);
    return response(200, { ...p, pro: true, thisMonth: [] });
  });
  await f.context.loadPayoffPlan();
  const html = f.node('plan-debt-root').innerHTML;
  assert.match(html, /YOUR STARTING POINT/);
  assert.match(html, /Average recorded inflow[\s\S]*\$6,000\.00/);
  assert.match(html, /Remaining before a cushion[\s\S]*\$1,800\.00/);
  assert.match(html, /hold back \$400/);
  assert.match(html, /Find your next extra dollar/);
  assert.match(html, /Dining &lt;night&gt;/);
  assert.doesNotMatch(html, /Dining <night>|<Visa>/);
  assert.match(html, /free up <strong>\$50\.00\/mo/);
  assert.match(html, /about \$104\/week/);
  assert.match(html, /First finish: &lt;Visa&gt;/);
  assert.match(html, /Your next 3 modeled months/);
  assert.match(html, /not a claim that payments have happened/);
  assert.match(html, /lowest modeled interest/);
  assert.match(html, /not a verified emergency-fund balance/);
  assert.deepEqual(calls, [['/api/plan', 'GET']]);
  let opened;
  f.context.openCategoryTransactions = async (...args) => { opened = args; };
  f.node('plan-debt-root').contains = () => true;
  const button = { dataset: { act: 'review-spending', category: 'Dining <night>' }, disabled: false };
  await f.node('plan-debt-root').listeners.click({ target: { closest: () => button } });
  assert.equal(opened[0], 'Dining <night>');
  assert.deepEqual(Array.from(opened[1].months), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(calls, [['/api/plan', 'GET']]);
});
test('a final debt clearing this month shows no false months-saved or next-debt rollover', async () => {
  const { computePlan } = await import('../backend/utils/moneyPlan.js');
  const now = new Date(2026, 9, 20);
  const data = computePlan({
    debts: [{ id: 1, name: 'Last card', balance: 50, apr: 0, min_payment: 25, included: true, payment_in_history: true }],
    goals: [], history: [], recent: [], settings: { debt_budget: 100, goal_budget: 0, flex: {} }
  }, { now, pro: true });
  const f = loadPlan(async () => response(200, { ...data, pro: true }));
  await f.context.loadPayoffPlan();
  const html = f.node('plan-debt-root').innerHTML;
  assert.match(html, /same payoff month/);
  assert.doesNotMatch(html, /0 months sooner/);
  assert.match(html, /modeled payment month 1/);
  assert.match(html, /this last included debt cleared/);
  assert.doesNotMatch(html, /minimum rolls to any remaining debt/);
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
  const months = f.context.resolvePeriod('last-3').months;
  const [year, month] = months.at(-1).split('-').map(Number);
  const end = new Date(year, month, 0).getDate();
  assert.equal(f.context.location.href, `/api/analytics/export.csv?type=transactions&from=${months[0]}-01&to=${months.at(-1)}-${end}`);
});
test('empty custom periods do not widen Pro insights or CSV exports to all time', () => {
  const f = loadPro();
  assert.deepEqual(Array.from(f.context.FinanceProCategories.periodMonths({ months: [] }, activity)), []);
  f.context.FinancePro.requirePro = () => true;
  f.node('txn-filter-period').value = 'custom';
  const messages = [];
  f.context.notify = message => messages.push(message);
  const before = f.context.location.href;
  f.context.FinanceProCategories.exportTransactions();
  assert.equal(f.context.location.href, before);
  assert.match(messages[0], /Choose at least one month/);
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
test('category analytics derive monthly series but never draw card trends below six months', () => {
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
  assert.match(C.cardExtra(dining, months, true), /at least 6 completed months/);
  assert.doesNotMatch(C.cardExtra(dining, months, true), /<svg/);
  const single = C.categoryStats(transactions, ['2026-03']);
  assert.doesNotMatch(C.cardExtra(single.categories.get('Dining'), ['2026-03'], true), /<svg/);
  const six = ['2025-10', '2025-11', '2025-12', ...months];
  const entry = C.categoryStats(transactions, six).categories.get('Dining');
  assert.doesNotMatch(C.cardExtra(entry, six.slice(1), true), /<svg/);
  const chart = C.cardExtra(entry, six, true);
  assert.match(chart, /6-month trend[\s\S]*pro-category-line/);
  assert.match(chart, /Dashed line: monthly average/);
  assert.match(chart, /New spending/);
  assert.doesNotMatch(chart, /<rect|pro-hist|Running hot|Cooling/);
  assert.doesNotMatch(C.cardExtra(entry, six, false), /<svg/);
  const noSpend = C.cardExtra(null, six, true);
  assert.match(noSpend, /No spending/);
  assert.doesNotMatch(noSpend, /<svg|NaN|Infinity/);
});
test('category trend windows expand short selections to six completed months and cap long ones at 24', () => {
  const { FinanceProCategories: C } = loadPro().context;
  const now = new Date(2026, 9, 20);
  const window = months => Array.from(C.trendMonths({ months }, [], now));
  assert.deepEqual(window(['2026-08', '2026-09', '2026-10']), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(window(['2026-10']), window(['2026-09']));
  assert.deepEqual(window(['2026-01']), ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
  assert.deepEqual(window([]), []);
  const long = Array.from(C.periodMonths(null, [{ date: '2023-01-01' }, { date: '2026-09-01' }]));
  const capped = window(long);
  assert.equal(capped.length, 24);
  assert.equal(capped[0], '2024-10');
  assert.equal(capped.at(-1), '2026-09');
  assert.deepEqual(Array.from(C.trendMonths(null, [{ date: '2026-07-01' }, { date: '2026-10-01' }], now)), window(['2026-09']));
});
test('category trend lines use a zero-based scale, monthly values and an average reference', () => {
  const { ProCharts } = loadPro().context;
  const chart = ProCharts.trendLine([100, 100, 100, 100, 100, 100], ['A <b>', 'Feb', 'Mar', 'Apr', 'May', 'Jun']);
  assert.match(chart, /role="img"[\s\S]*A &lt;b&gt;/);
  assert.match(chart, /class="trend-average"/);
  assert.equal((chart.match(/<circle /g) || []).length, 6);
  assert.match(chart, /A &lt;b&gt;: \$100\.00/);
  assert.doesNotMatch(chart, /<rect|NaN|Infinity/);
  assert.doesNotMatch(ProCharts.trendLine([0, 0, 0, 0, 0, 0], ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']), /NaN|Infinity/);
});
test('Pro category insights render as an opt-in disclosure, skip inactive cards, and respect the Analytics switch', async () => {
  const f = loadPro();
  const pro = f.context.FinancePro;
  let enabled = true, removed = 0, analyticsRequests = 0;
  pro.ensureEntitlement = async () => {};
  pro.isActive = () => true;
  pro.isPlusActive = () => true;
  pro.prefs.get = () => enabled ? 'on' : 'off';
  pro.getAnalytics = async () => { analyticsRequests++; return { categories: [] }; };
  const markup = [], activeExtras = [], inactiveExtras = [];
  const cards = [
    { dataset: { openCategory: 'Dining' }, classList: { contains: () => false }, insertAdjacentHTML: (position, html) => activeExtras.push(html) },
    { dataset: { openCategory: 'Travel' }, classList: { contains: () => true }, insertAdjacentHTML: (position, html) => inactiveExtras.push(html) }
  ];
  f.node('categories-view').querySelectorAll = () => [{ remove() { removed++; } }];
  f.node('category-cards').querySelectorAll = () => cards;
  f.node('category-cards').insertAdjacentHTML = (position, html) => markup.push(html);
  const allTransactions = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'].map(month => ({
    category: 'Dining', date: `${month}-05`, amount: 150, direction: 'DEBIT', transfer_kind: null
  }));
  const event = { detail: { period: { label: 'Jan - Feb 2026', months: ['2026-01', '2026-02'] }, allTransactions, transactions: [
    { category: 'Dining', date: '2026-01-05', amount: 100, direction: 'DEBIT', transfer_kind: null },
    { category: 'Dining', date: '2026-02-05', amount: 200, direction: 'DEBIT', transfer_kind: null }
  ] } };
  await f.listeners.get('document:categories:rendered')(event);
  assert.match(markup[0], /^<details class="category-analytics[^>]*><summary>/);
  assert.doesNotMatch(markup[0], /^<details[^>]*\bopen\b/);
  assert.match(markup[0], /Explore spending insights[\s\S]*Spending mix/);
  assert.match(activeExtras[0], /6-month trend[\s\S]*pro-category-line[\s\S]*Trend avg\/mo/);
  assert.match(activeExtras[0], /Sep 25[\s\S]*Feb 26/);
  assert.match(activeExtras[0], /\$150/);
  assert.match(markup[0], /Total spend[\s\S]*\$300/);
  assert.equal(inactiveExtras.length, 0);
  assert.equal(analyticsRequests, 0);
  await f.listeners.get('document:categories:rendered')({ detail: { ...event.detail, allTransactions: allTransactions.filter(tx => !tx.date.startsWith('2025-11')) } });
  assert.match(activeExtras[1], /Missing months are not treated as zero/);
  assert.doesNotMatch(activeExtras[1], /<svg/);
  enabled = false;
  await f.listeners.get('document:categories:rendered')(event);
  assert.equal(removed, 3);
  assert.equal(markup.length, 2);
  assert.equal(analyticsRequests, 0);
  assert.equal(f.node('categories-view').classList.contains('has-pro-insights'), false);
});
test('Pro gating delegates billing to household checkout and trials unlock advanced features', async () => {
  const f = loadPro(async url => url === '/api/license'
    ? response(200, { tier: 'none', source: 'none', active: false, trialAvailable: true })
    : response(200, {}));
  const { FinancePro } = f.context;
  const opened = [];
  f.context.FinanceHousehold = { openBilling: reason => opened.push(reason) };
  await FinancePro.ensureEntitlement();
  assert.equal(FinancePro.isActive(), false);
  assert.equal(f.node('pro-nav-badge').textContent, '');
  assert.match(f.node('pro-nav-badge').innerHTML, /class="pro-lock"/);
  assert.equal(FinancePro.requirePro('Budgets are Pro'), false);
  assert.deepEqual(opened, ['Budgets are Pro']);
  FinancePro.setEntitlement({ tier: 'trial', source: 'trial', active: true, plusActive: true, daysLeft: 3, features: [] });
  assert.equal(FinancePro.requirePro('x'), true);
  assert.equal(f.node('pro-nav-badge').textContent, 'PRO');
  assert.equal(f.node('pro-nav-badge').onclick, null);
});
test('all Pro navigation badges use a clickable lock for Basic and consistent Pro labels during trials', () => {
  const f = loadPro();
  const badges = [f.node('debt-pro-badge'), f.node('goals-pro-badge')];
  f.context.document.querySelectorAll = selector => selector === '.plus-nav-badge' ? badges : [];
  const opened = [];
  f.context.FinanceHousehold = { openBilling: (reason, plan) => opened.push({ reason, plan }) };
  const pro = f.context.FinancePro;
  pro.setEntitlement({ tier: 'basic', active: true, plusActive: false });
  for (const badge of [f.node('pro-nav-badge'), ...badges]) {
    assert.equal(badge.textContent, '');
    assert.match(badge.innerHTML, /class="pro-lock"/);
    let prevented = false;
    let stopped = false;
    badge.onclick({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(prevented && stopped, true);
  }
  assert.equal(opened.length, 3);
  assert.ok(opened.every(call => call.plan === 'pro'));
  assert.match(pro.proTag(), /class="pro-lock"/);
  for (const tier of ['trial', 'pro']) {
    pro.setEntitlement({ tier, active: true, plusActive: true, daysLeft: 5 });
    for (const badge of [f.node('pro-nav-badge'), ...badges]) {
      assert.equal(badge.textContent, 'PRO');
      assert.equal(badge.onclick, null);
    }
    assert.equal(pro.proTag(), '<span class="pro-tag">PRO</span>');
  }
});
test('marketing page explains household pricing, Stripe and trial renewal clearly', () => {
  const html = source('index.html');
  assert.match(html, /your personal money workspace/);
  assert.match(html, /Illustrative preview/);
  assert.match(html, /id="marketing-pricing"/);
  assert.match(html, /\$9\.99<span>USD \/ month per household/);
  assert.match(html, /\$14\.99<span>USD \/ month per household/);
  assert.match(html, /15-day trial/);
  assert.match(html, /Stripe hosted Checkout/);
  assert.match(html, /automatically charged.*unless cancelled/);
  assert.match(html, /trial access continues until its end/);
  assert.doesNotMatch(html, /Pro Plus|PRO PLUS|Start free|data-choose-plan="free"|\$4\.99|\$9\.98/);
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
test('feature spotlight rotates through Basic and Pro features', () => {
  const f = fixture();
  browserBits(f, { reduced: false });
  f.context.document.hidden = false;
  f.run('marketing.js');
  const tour = f.context.FinanceMarketing;
  assert.equal(tour.slides.length, 7);
  assert.deepEqual([...new Set(tour.slides.map(slide => slide.tier))], ['BASIC', 'PRO']);
  assert.ok(new Set(tour.slides.map(slide => slide.effect)).size >= 5, 'slides use varied transitions');
  const stage = f.node('marketing-spotlight-stage');
  assert.match(stage.innerHTML, /mk-fx-rise[\s\S]*Drop<\/span>[\s\S]*Get the story/);
  assert.match(f.node('marketing-spotlight-dots').innerHTML, /Show feature 7 of 7/);
  assert.equal(f.node('marketing-spotlight').classList.contains('is-running'), true);
  const click = target => f.node('marketing-spotlight').listeners.click({ target: { closest: () => target } });
  click({ id: '', dataset: { mkStep: '-1' } });
  assert.equal(tour.current(), 6);
  assert.match(stage.innerHTML, /PRO[\s\S]*a deadline/);
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
test('pricing cards preserve a plan for explicit hosted checkout after sign-in', async () => {
  const html = source('index.html');
  for (const plan of ['basic', 'pro']) assert.match(html, new RegExp(`data-choose-plan="${plan}" aria-pressed="false"`));
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
      return response(200, { setupRequired: false, registrationEnabled: true });
    });
    f.context.localStorage = localStorage;
    const buttons = ['basic', 'pro'].map(plan => Object.assign(f.node(`choose-${plan}`), { dataset: { choosePlan: plan }, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } }));
    const all = f.context.document.querySelectorAll;
    f.context.document.querySelectorAll = selector => selector === '[data-choose-plan]' ? buttons : all(selector);
    f.run('session.js');
    return { f, calls, buttons };
  };
  const out = visit(false);
  await out.f.context.FinanceSession.start();
  assert.equal(out.f.node('auth-plan').hidden, true, 'no banner until a plan is chosen');
  out.buttons[1].listeners.click();
  assert.equal(storage.get('myfinance.chosenPlan'), 'pro');
  assert.equal(out.buttons[1].attrs['aria-pressed'], 'true');
  assert.equal(out.buttons[0].attrs['aria-pressed'], 'false');
  assert.match(out.buttons[1].textContent, /Pro selected/);
  assert.equal(out.buttons[0].textContent, 'Choose Basic');
  assert.equal(out.f.node('auth-plan').hidden, true, 'signup uses inline plan cards instead of a duplicate banner');
  assert.equal(out.f.node('auth-plan-pro').checked, true);
  assert.equal(out.f.node('auth-plan-options').hidden, false);
  assert.equal(out.f.node('auth-plan-name').textContent, 'Pro');
  assert.match(out.f.node('auth-plan-note').textContent, /Stripe hosted Checkout/);
  assert.equal(out.f.node('auth-title').textContent, 'Make room for your next chapter.', 'choosing a plan opens account creation');
  assert.equal(out.calls.some(call => call.url === '/api/license/request'), false, 'nothing is requested while signed out');

  const notes = [];
  const back = visit(true);
  back.f.context.notify = message => notes.push(message);
  await back.f.context.FinanceSession.start();
  assert.equal(back.calls.some(call => call.options.method === 'POST'), false, 'sign-in never silently starts a subscription');
  assert.equal(back.f.context.FinanceSession.chosenPlan(), 'pro');
  assert.equal(notes.length, 0);
});
test('Basic unlocks core finances only; Pro and trials unlock advanced features', () => {
  const f = loadPro();
  const pro = f.context.FinancePro;
  let opened = 0;
  f.context.FinanceHousehold = { openBilling: () => opened++ };
  pro.setEntitlement({ tier: 'basic', active: true, plusActive: false, features: [] });
  assert.equal(pro.isActive(), true);
  assert.equal(pro.requirePro('Budgets'), false);
  assert.equal(pro.requireProPlus('Savings goals'), false);
  assert.equal(opened, 2);
  assert.equal(pro.planLabel().title, 'MyFinance Basic');
  for (const tier of ['trial', 'pro']) {
    pro.setEntitlement({ tier, active: true, plusActive: true, daysLeft: 15, features: [] });
    assert.equal(pro.requireProPlus('Debt free'), true);
    assert.equal(pro.requirePro('Budgets'), true);
    assert.match(pro.planLabel().title, /Pro/);
  }
});
test('direct debt and goals loads show a full-page Pro lock for none and Basic', async () => {
  for (const tier of ['none', 'basic']) {
    const f = loadPlan(async () => response(402, { code: 'PRO_PLUS_REQUIRED', error: 'Pro required', entitlement: { tier, active: tier === 'basic', plusActive: false } }));
    await f.context.loadPayoffPlan();
    await f.context.loadGoals();
    for (const id of ['plan-debt-root', 'plan-goals-root']) {
      const html = f.node(id).innerHTML;
      assert.match(html, /plus-page-lock/);
      assert.match(html, /USD 14\.99\/month per household/);
      assert.match(html, /Explore Pro/);
      assert.doesNotMatch(html, /data-act="add-(debt|goal)"/);
    }
    assert.equal(f.context.FinancePlan.state.plan, null);
    assert.equal(f.context.FinancePro.isActive(), tier === 'basic');
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
    ? response(200, { tier: 'none', source: 'none', active: false, plusActive: false, trialEndsAt: '2026-10-01', trialAvailable: false, features: [] })
    : response(402, { error: 'Pro required', code: 'PRO_REQUIRED' }));
  await f.context.loadAnalyticsPage();
  assert.match(f.node('analytics-content').innerHTML, /Your Pro trial has ended/);
  assert.match(f.node('analytics-actions').innerHTML, /pro-lock/);
});

test('Compass date ranges offer only four month presets and custom dates, update independently and show errors', async () => {
  const { buildDemoData } = await import('../backend/utils/demo.js');
  const { buildAnalytics } = await import('../backend/utils/analytics.js');
  const { buildMoneyFlowSignals } = await import('../backend/utils/benchmarks.js');
  const now = new Date(), demo = buildDemoData(now), calls = [];
  const payload = { ...buildAnalytics({ transactions: demo.transactions, today: now }), moneyFlow: buildMoneyFlowSignals({ transactions: demo.transactions, today: now }) };
  const f = loadPro(async url => {
    calls.push(url);
    if (url === '/api/license') return response(200, { active: true, plusActive: true, features: [] });
    if (url.startsWith('/api/analytics/compass?')) {
      const params = new URL(url, 'http://local').searchParams;
      if (params.get('from') === 'bad') return response(400, { error: 'Choose valid completed months' });
      const [year, month] = params.get('to').split('-').map(Number);
      const [startYear, startMonth] = params.get('from').split('-').map(Number);
      const range = { from: params.get('from'), to: params.get('to'), months: (year - startYear) * 12 + month - startMonth + 1, endYear: year, endMonth: month - 1 };
      return response(200, { ...buildMoneyFlowSignals({ transactions: demo.transactions, today: now, range }), range });
    }
    return response(200, payload);
  });
  await f.context.loadAnalyticsPage(false, 'compass');
  assert.equal((f.node('analytics-content').innerHTML.match(/data-compass-range=/g) || []).length, 7);
  const initial = f.node('analytics-content').innerHTML;
  const selectors = [...initial.matchAll(/<select name="preset">([\s\S]*?)<\/select>/g)];
  assert.equal(selectors.length, 7);
  for (const [, options] of selectors) {
    assert.deepEqual([...options.matchAll(/value="([^"]+)"/g)].map(match => match[1]), ['3', '6', '12', '24', 'custom']);
  }
  assert.equal((initial.match(/<label hidden>Start month/g) || []).length, 7);
  assert.equal((initial.match(/<label hidden>End month/g) || []).length, 7);
  const values = { preset: { value: '6' }, from: { value: '', parentElement: {} }, to: { value: '', parentElement: {} } };
  const form = { dataset: { compassRange: 'heatmap' }, querySelector: selector => values[selector.match(/name="([^"]+)"/)[1]] };
  const event = { preventDefault() {}, target: { name: 'preset', value: '6', closest: () => form } };
  for (const months of [3, 6, 12, 24]) {
    event.target.value = String(months);
    f.listeners.get('document:change')(event);
    const end = now.getFullYear() * 12 + now.getMonth() - 1;
    const key = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
    assert.equal(values.from.value, key(end - months + 1));
    assert.equal(values.to.value, key(end));
    assert.equal(values.from.parentElement.hidden, true);
    assert.equal(values.to.parentElement.hidden, true);
  }
  event.target.value = '6';
  f.listeners.get('document:change')(event);
  assert.match(values.from.value, /^\d{4}-\d{2}$/);
  await f.listeners.get('document:submit')(event);
  let html = f.node('analytics-content').innerHTML;
  const panel = key => html.split(`data-compass-panel="${key}"`)[1].split('data-compass-panel=')[0];
  assert.match(panel('heatmap'), /6 of 6 completed months available/);
  assert.match(panel('flow'), /Last 3 completed months/);
  assert.match(panel('plan'), /Last 3 completed months/);
  assert.equal(calls.filter(url => url.startsWith('/api/analytics/compass?')).length, 1);
  values.preset.value = 'custom';
  event.target.value = values.preset.value;
  f.listeners.get('document:change')(event);
  assert.equal(values.from.parentElement.hidden, false);
  assert.equal(values.to.parentElement.hidden, false);
  values.from.value = `${now.getFullYear() - 1}-04`;
  values.to.value = `${now.getFullYear() - 1}-06`;
  event.target.name = 'from';
  f.listeners.get('document:change')(event);
  assert.equal(values.preset.value, 'custom');
  await f.listeners.get('document:submit')(event);
  html = f.node('analytics-content').innerHTML;
  assert.match(panel('heatmap'), /\d+ of 3 completed months available/);
  assert.match(panel('heatmap'), /<label>Start month/);
  assert.match(panel('heatmap'), /<option value="custom" selected>/);
  assert.match(calls.at(-1), new RegExp(`from=${now.getFullYear() - 1}-04&to=${now.getFullYear() - 1}-06`));
  values.from.value = 'bad';
  await f.listeners.get('document:submit')(event);
  html = f.node('analytics-content').innerHTML;
  assert.match(panel('heatmap'), /Could not update this panel: Choose valid completed months/);
  assert.match(panel('flow'), /Last 3 completed months/);
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
    ? response(200, { tier: 'pro', source: 'owner', active: true, plusActive: true, features: [] })
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
  assert.match(html, /Above similar homes[\s\S]*Trending up[\s\S]*Unusual latest month/);
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
  assert.match(html, /data-bubble-size="spend" aria-pressed="true">Total amount/);
  assert.match(html, /data-bubble-size="transactions" aria-pressed="false">Transactions/);
  assert.match(html, /data-bubble-color="category" aria-pressed="true">Category/);
  assert.match(html, /data-bubble-color="swing" aria-pressed="false">Spending swing %/);
  assert.match(html, /data-bubble-color="change" aria-pressed="false">Vs previous period/);
  assert.doesNotMatch(html, />Visits<\/button>|>Change<\/button>/);
  assert.match(html, /Swing: \(highest &minus; lowest monthly spending\) &divide; monthly average/);
  assert.match(html, /Widest spending swing/);
  assert.match(source('analytics.css'), /\.compass-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
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
  assert.doesNotMatch(html, /fx-pop|fx-swipe|welcome-mascot|welcome-confetti|welcome-aurora/);
  assert.equal((html.match(/class="welcome-insight-icon"/g) || []).length, 3);
  assert.match(html, /class="welcome-pulse-icon" aria-hidden="true"><svg/);
  const slides = [...html.matchAll(/<article class="welcome-slide[^]*?<\/article>/g)].map(match => match[0]);
  assert.equal(slides.length, 3);
  assert.match(slides[0], /tone-danger[^]*welcome-slide-tone">Action needed<\/span>[^]*Balance dips &lt;below&gt; zero[^]*Move a payment\.[^]*data-welcome-action="0">See upcoming/);
  assert.match(slides[1], /tone-warning[^]*welcome-slide-tone">Heads up<\/span>[^]*Dining is over budget/);
  assert.doesNotMatch(html, /⚠️|🔥|👋|👏|welcome-wave/);
  f.context.FinanceWelcome.markTourSeen();
  assert.equal(store.get('mf.tutorials.dashboardSeen'), '1');
  await f.context.FinanceWelcome.load();
  assert.doesNotMatch(f.node('welcome-hero').innerHTML, /Take a one-minute tour/);
});
test('welcome styling pairs a rich insight stage with accessible urgency and reduced motion', () => {
  const css = source('welcome.css');
  assert.match(css, /--welcome-accent: #16705b/);
  assert.match(css, /\.welcome-pulse-row\.is-sky \{[^}]*background: #eff5fb/);
  assert.match(css, /\.welcome-pulse-row\.is-grape \{[^}]*background: #f4f1f8/);
  assert.match(css, /\.welcome-pulse-row \{[^}]*background: #f8faf7/);
  assert.match(css, /\.welcome-slide\.tone-danger \{ --tone: #ffbfc7/);
  assert.match(css, /linear-gradient\(120deg, #152d46, #184c53\)/);
  assert.match(css, /background: #dcbd80; color: #182e40/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[^]*animation: none !important; transition: none !important/);
  assert.doesNotMatch(css, /@keyframes[^]*(?:confetti|aurora|welcome-flip|welcome-wave)/);
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
  assert.equal(tours.list().map(item => item.id).join(), 'debt,goals,dashboard,fixed,categories,transactions,accounts,analytics,compass');
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
test('updated tutorials explain account freshness, real imports, debt coaching and six-month trends', () => {
  const f = fixture();
  browserBits(f);
  f.run('tutorial.js');
  const tours = f.context.FinanceTutorials;
  for (const id of tours.list().map(item => item.id)) {
    tours.open(id);
    const tutorial = tours.state.tutorial;
    for (const [index, scene] of tutorial.scenes.entries()) {
      tours.go(index);
      assert.match(f.node('tut-canvas').innerHTML, /\S/, `${id}/${scene.id} renders`);
      assert.doesNotMatch(f.node('tut-canvas').innerHTML, /undefined|\[object Object\]/);
      assert.doesNotMatch(scene.caption, /New rows wait in Import review|half of your typical/);
    }
  }
  tours.open('accounts/freshness');
  assert.match(f.node('tut-caption').textContent, /45 calendar days[\s\S]*exactly 45 is not[\s\S]*Renaming/);
  tours.open('accounts/ownership');
  assert.match(f.node('tut-caption').textContent, /badge counts references[\s\S]*not stale/);
  tours.open('accounts/refresh');
  assert.match(f.node('tut-caption').textContent, /same saved account[\s\S]*Do not create another account/);
  tours.open('accounts/statements');
  assert.match(f.node('tut-caption').textContent, /not a live bank feed[\s\S]*does not automatically synchronize/);
  tours.open('transactions/import');
  assert.match(f.node('tut-caption').textContent, /Valid new rows save directly[\s\S]*duplicates/);
  tours.open('transactions/import-review');
  assert.match(f.node('tut-caption').textContent, /older queued records[\s\S]*bypasses duplicate checks/);
  tours.open('categories/trends');
  assert.match(f.node('tut-caption').textContent, /six completed months[\s\S]*unfinished current month[\s\S]*Missing months/);
  tours.open('debt/assessment');
  assert.match(f.node('tut-caption').textContent, /three completed months[\s\S]*tighter month[\s\S]*cushion/);
  tours.open('debt/experiments');
  assert.match(f.node('tut-caption').textContent, /independent[\s\S]*actually free up/);
  tours.open('analytics/ranges');
  assert.match(f.node('tut-caption').textContent, /3, 6, 12 and 24[\s\S]*three completed months/);
  tours.open('goals/flex');
  assert.match(f.node('tut-caption').textContent, /does not transfer money[\s\S]*does not automatically record/);
});
test('legacy import review leaves the main menu but remains reachable from Transactions', () => {
  const html = source('index.html');
  assert.doesNotMatch(html, /class="nav-btn" data-view="etl"/);
  assert.match(html, /Older import tools[\s\S]*href="#etl" data-view="etl">Legacy import review/);
  assert.match(html, /href="#tutorials\/accounts">How Accounts works/);
  assert.match(html, /Older queued import records/);
  assert.doesNotMatch(html, /forcePushStaging|dismissStaging|Watch the 1-min tour/);
});
test('legacy queue failures show explicit errors and successful actions refresh only after confirmation', async () => {
  const messages = [], requests = [];
  let fail = true;
  const f = fixture(async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    if (url.endsWith('/attention')) return fail ? response(500, { error: '<Queue offline>' }) : response(200, []);
    return fail ? response(409, { error: 'Already processed' }) : response(200, { success: true });
  });
  f.context.notify = message => messages.push(message);
  f.context.FinanceUI = { confirm: async () => true };
  f.run('refresh.js');
  await f.context.loadEtlStaging();
  assert.match(f.node('etl-staging-table').innerHTML, /Could not load older records: &lt;Queue offline&gt;[\s\S]*Retry/);
  const button = { dataset: { stagingAdd: '7' }, disabled: false, hasAttribute: () => false };
  const click = () => f.node('etl-staging-table').onclick({ target: { closest: () => button } });
  await click();
  assert.deepEqual(messages, ['Already processed']);
  assert.equal(button.disabled, false);
  assert.equal(requests.length, 2, 'failed add never reports success or reloads the queue');
  fail = false;
  await click();
  assert.match(messages[1], /Record added/);
  assert.match(f.node('etl-staging-table').innerHTML, /No older queued records[\s\S]*not here/);
  assert.equal(requests.length, 4);
  f.context.FinanceUI.confirm = async () => false;
  await click();
  assert.equal(requests.length, 4, 'cancel never writes');
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
test('renamed payees show the friendly name, stay searchable and can be renamed from any row', async t => {
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
      : { pattern: body.pattern.toUpperCase(), count: 4, transactions: [{ id: 3, date: '2026-10-05', description: 'SENT 77ZZ Zelle SAM PATEL', amount: 40 }], samples: ['SENT 77ZZ Zelle SAM PATEL'] });
    if (url === '/api/transactions/name-rules') return response(200, { success: true, rule: { id: 9, pattern: 'ZELLE SAM PATEL', name: 'Sam Patel', matches: 4 }, changed: 4 });
    return response(200, {});
  });
  await t.test('editing a narrow processor rename previews cross-bank merchant matches before saving', async () => {
    const calls = [];
    const f = fixture(async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : {};
      calls.push([url, body]);
      if (url === '/api/transactions/name-rules/preview') return response(200, body.description
        ? { suggested: 'TRIBOS PERI PERI', current: { id: 9, pattern: 'TST TRIBOS PERI PERI M METUCHEN NJ', name: 'Peri Peri' }, count: 3 }
        : { pattern: body.pattern, count: 3, transactions: [{ id: 1, date: '2026-09-23', description: 'TST* TRIBOS PERI PERI - M METUCHEN NJ', amount: 29.5 }, { id: 2, date: '2026-08-10', description: 'VISA DDA PUR AP 413746 TST TRIBOS PERI PERI METUCHEN * NJ', amount: 94.3 }], samples: [] });
      if (url === '/api/transactions/name-rules') return response(200, { rule: { name: 'Peri Peri', matches: 3 } });
      if (url === '/api/categories') return response(200, []);
      if (url === '/api/dashboard/all-transactions') return response(200, { transactions: [] });
      return response(200, {});
    });
    f.run('refresh.js');
    await f.context.openRenameDialog({ description: 'TST* TRIBOS PERI PERI - M METUCHEN NJ', display_name: 'Peri Peri' });
    assert.equal(f.node('rename-pattern').value, 'TRIBOS PERI PERI');
    assert.match(f.node('rename-preview').innerHTML, /Matches 3 transactions/);
    assert.match(f.node('rename-preview').innerHTML, /VISA DDA PUR AP/);
    f.node('rename-preview').querySelectorAll = () => [{ checked: true, dataset: { renameMatch: '1' } }, { checked: false, dataset: { renameMatch: '2' } }];
    f.node('rename-remember').checked = false;
    await f.node('rename-form').onsubmit({ preventDefault() {} });
    assert.deepEqual(calls.find(([url]) => url === '/api/transactions/name-rules')[1], { id: 9, pattern: 'TRIBOS PERI PERI', name: 'Peri Peri', ids: [1], remember: false });
  });
  await t.test('rename controls are centered beside multiline descriptions', () => {
    assert.match(source('refresh.css'), /\.tx-desc-cell\s*\{[^}]*align-items:\s*center/);
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
  assert.match(f.node('rename-preview').innerHTML, /Matches 4 transactions<\/strong>/);
  f.node('rename-preview').querySelectorAll = () => [{ checked: true, dataset: { renameMatch: '3' } }];
  await f.node('rename-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(calls.find(([url, method]) => url === '/api/transactions/name-rules' && method === 'POST')[2], { pattern: 'ZELLE SAM PATEL', name: 'Sam Patel', ids: [3], remember: true });
});