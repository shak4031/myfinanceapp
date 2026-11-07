import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./assistant.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(handler) {
  const listeners = new Map(), storage = new Map(), nodes = new Map();
  const node = () => ({ hidden: false, innerHTML: '', textContent: '', checked: false, disabled: false,
    setAttribute() {}, addEventListener(name, listener) { this[name] = listener; }, querySelector() { return { focus() {} }; } });
  nodes.set('assistant-enabled', node());
  nodes.set('assistant-preference-status', node());
  let host;
  let id = 1, authenticated = true, support = null;
  const calls = [];
  const context = {
    console, Date, Number, String, Math, setTimeout, clearTimeout,
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    FinanceTools: { escape: value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), money: value => `$${value}` },
    FinanceSession: { isAuthenticated: () => authenticated, currentSupport: () => support, currentUser: () => ({ id }) },
    document: {
      createElement: node, body: { appendChild(value) { host = value; } },
      getElementById: key => nodes.get(key),
      addEventListener: (name, listener) => listeners.set(name, listener)
    },
    addEventListener: (name, listener) => listeners.set(`window:${name}`, listener),
    fetch: async url => { calls.push(url); return handler ? handler(url) : { ok: true, json: async () => ({ signals: [{ id: 'other', title: '<Private finding>', detail: 'Only this workspace.', route: 'transactions' }] }) }; }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, storage, nodes, listeners, calls, host: () => host,
    user(value) { id = value; }, signedIn(value) { authenticated = value; }, support(value) { support = value; },
    enable(value) { listeners.get('change')({ target: { id: 'assistant-enabled', checked: value } }); },
    click(action) { host.click({ target: { closest: selector => selector === '[data-assistant]' ? { dataset: { assistant: action } } : null } }); }
  };
}

test('assistant is opt-in, user-keyed, minimizes and disables without retaining financial data', async () => {
  const f = fixture();
  f.context.FinanceAssistant.onView('transactions');
  assert.equal(f.host().hidden, true);
  assert.equal(f.calls.length, 0);
  f.enable(true); await settle();
  assert.equal(f.storage.get('myfinance.assistant.1.enabled'), 'on');
  assert.deepEqual([...f.storage.values()], ['on'], 'only preference, never data');
  assert.equal(f.host().hidden, false);
  assert.match(f.host().innerHTML, /&lt;Private finding&gt;/);
  assert.match(f.host().innerHTML, /Make your history trustworthy/);
  f.click('minimize');
  assert.match(f.host().innerHTML, /assistant-launcher/);
  assert.doesNotMatch(f.host().innerHTML, /Private finding/);
  f.click('expand');
  assert.match(f.host().innerHTML, /Private finding/);
  f.click('disable');
  assert.equal(f.storage.get('myfinance.assistant.1.enabled'), 'off');
  assert.equal(f.host().hidden, true);
  assert.equal(f.host().innerHTML, '');
});

test('session changes discard delayed guidance and support sessions hide the assistant', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.context.FinanceAssistant.onView('dashboard');
  f.enable(true);
  f.context.FinanceAssistant.reset();
  f.user(2); f.context.FinanceAssistant.onView('dashboard');
  finish({ ok: true, json: async () => ({ signals: [{ title: 'Other login confidential data', detail: 'secret', route: 'transactions' }] }) });
  await settle();
  assert.equal(f.host().hidden, true);
  assert.equal(f.host().innerHTML, '');
  assert.equal(f.nodes.get('assistant-enabled').checked, false);
  f.support({ actor: { id: 99 } });
  f.context.FinanceAssistant.onView('settings');
  assert.equal(f.nodes.get('assistant-enabled').disabled, true);
  assert.equal(f.host().hidden, true);
});

test('guidance failures are explicit and retry is offered rather than false reassuring findings', async () => {
  const f = fixture(async () => { throw new Error('Connection failed'); });
  f.context.FinanceAssistant.onView('accounts');
  f.enable(true); await settle();
  assert.match(f.host().innerHTML, /Guidance unavailable: Connection failed/);
  assert.match(f.host().innerHTML, /Retry/);
  f.click('refresh'); await settle();
  assert.equal(f.calls.length, 2);
  assert.match(f.host().innerHTML, /Connection failed/);
});

test('large transaction actions use a transaction deep link and app expertise covers every view', async () => {
  const f = fixture(async () => ({ ok: true, json: async () => ({ signals: [
    { id: 'large', title: 'Large purchase', detail: 'Add a note.', route: 'transactions', action: 'note:42' }
  ] }) }));
  f.context.FinanceAssistant.onView('dashboard'); f.enable(true); await settle();
  assert.match(f.host().innerHTML, /class="transaction-link" href="#transactions\/42"/);
  for (const view of ['dashboard', 'transactions', 'transaction-review', 'categories', 'category-admin', 'accounts', 'analytics', 'payoff', 'goals', 'insights', 'settings', 'subscription', 'tutorials', 'knowledge-base', 'activity', 'etl']) {
    f.context.FinanceAssistant.onView(view);
    assert.match(f.host().innerHTML, /Explore this workflow/);
  }
  f.signedIn(false); f.context.FinanceAssistant.onView('dashboard');
  assert.equal(f.host().hidden, true);
  assert.equal(f.host().innerHTML, '');
});
