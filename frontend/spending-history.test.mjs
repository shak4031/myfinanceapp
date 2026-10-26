import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('spending-history.js', import.meta.url), 'utf8');
const category = {
  name: 'Dining & drinks', average: 75, observedMonths: 3,
  series: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) => ({ month, amount: i < 3 ? null : [0, 100, 125][i - 3], transactions: 2 })),
  stats: { highest: { month: '2026-09', amount: 125 }, lowest: { month: '2026-07', amount: 0 }, changePct: 25, transactionCount: 6, budget: 100, monthsOverBudget: 1 }
};
function fixture(fetchImpl = async () => ({ ok: true, json: async () => ({ pro: true, categories: [category] }) })) {
  const listeners = new Map(), windows = new Map(), popups = [];
  const trigger = { setAttribute() {}, focus() {}, matches: () => true, contains: node => node === trigger };
  const card = { dataset: { category: category.name }, setAttribute() {}, removeAttribute() {}, matches: () => true, closest: () => wrapper };
  const wrapper = {
    isConnected: true, querySelector: selector => selector === '.mtd-history-trigger' ? trigger : card,
    contains: node => node === trigger || node === card, getBoundingClientRect: () => ({ left: 50, bottom: 200, top: 50 }), matches: () => false
  };
  trigger.closest = selector => ['[data-spending-history]', '.mtd-history-trigger'].includes(selector) ? trigger : selector.includes('.mtd-card-wrap') ? wrapper : null;
  const body = { appendChild(node) { node.isConnected = true; popups.push(node); } };
  const context = {
    console, setTimeout, clearTimeout, fetch: fetchImpl, innerHeight: 900,
    document: {
      body, documentElement: { clientWidth: 1000 }, activeElement: null,
      addEventListener: (name, handler) => listeners.set(name, handler),
      createElement: () => ({
        style: {}, hidden: false, innerHTML: '', setAttribute() {}, contains: () => false,
        getBoundingClientRect: () => ({ width: 430, height: 500 }),
        remove() { this.isConnected = false; }, querySelector: () => null
      })
    }, addEventListener: (name, handler) => windows.set(name, handler)
  };
  context.window = context;
  vm.runInNewContext(code, context);
  const click = () => listeners.get('click')({ target: trigger, detail: 1, preventDefault() {} });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  return { context, listeners, popups, wrapper, trigger, card, click, flush };
}
test('historical preview is lazy, readable and clearly labels current-budget comparisons', () => {
  const f = fixture();
  const html = f.context.FinanceSpendingHistory.renderCategory(category, true);
  assert.match(html, /Monthly average[^]*\$75/);
  assert.equal((html.match(/history-bar-track/g) || []).length, 6);
  assert.match(html, /is-missing/);
  assert.match(html, /1 of 3 months[^]*current \$100 monthly budget/);
  assert.match(html, /not historical budget settings/);
  assert.match(html, /Transactions in period[^]*6/);
  assert.match(html, /current partial month is excluded/);
  assert.equal(f.popups.length, 0);
});
test('Free history offers Pro without exposing paid statistics', () => {
  const f = fixture();
  const html = f.context.FinanceSpendingHistory.renderCategory({ ...category, stats: null }, false);
  assert.match(html, /Explore Pro/);
  assert.doesNotMatch(html, /Highest month|Lowest month|1 of 3 months/);
});
test('history requests coalesce and remain cached until the dashboard refreshes', async () => {
  let requests = 0, resolve;
  const f = fixture(() => { requests++; return new Promise(done => { resolve = done; }); });
  f.click(); f.click();
  assert.equal(requests, 1);
  resolve({ ok: true, json: async () => ({ pro: true, categories: [category] }) });
  await f.flush();
  assert.match(f.popups[0].innerHTML, /Monthly average/);
  f.click(); await f.flush();
  assert.equal(requests, 1);
  f.listeners.get('mtd:rendered')();
  f.click();
  assert.equal(requests, 2);
  resolve({ ok: true, json: async () => ({ pro: true, categories: [category] }) });
  await f.flush();
});
test('reset discards in-flight history and removes private popup data', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  f.click();
  const old = f.popups[0];
  f.context.FinanceSpendingHistory.reset();
  resolve({ ok: true, json: async () => ({ pro: true, categories: [category] }) });
  await f.flush();
  assert.equal(old.isConnected, false);
  assert.doesNotMatch(old.innerHTML, /Monthly average/);
});
test('history load errors are explicit and retry succeeds without a stale error', async () => {
  let requests = 0;
  const f = fixture(async () => ++requests === 1
    ? { ok: false, status: 503, json: async () => ({ error: '<Unavailable>' }) }
    : { ok: true, json: async () => ({ pro: true, categories: [category] }) });
  f.click(); await f.flush();
  assert.match(f.popups[0].innerHTML, /&lt;Unavailable&gt;[^]*Try again/);
  const retry = { closest: selector => selector === '[data-history-retry]' ? retry : null };
  f.listeners.get('click')({ target: retry });
  await f.flush();
  assert.match(f.popups[0].innerHTML, /Monthly average/);
});
test('keyboard focus opens history and Escape suppresses reopening until explicitly requested', async () => {
  const f = fixture();
  f.card.closest = () => null;
  f.listeners.get('focusin')({ target: f.card });
  assert.equal(f.popups.length, 0, 'focusing the spending amount does not open history');
  f.listeners.get('focusin')({ target: f.trigger });
  await f.flush();
  assert.equal(f.popups[0].hidden, false);
  f.listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(f.popups[0].hidden, true);
  f.listeners.get('focusin')({ target: f.trigger });
  assert.equal(f.popups[0].hidden, true);
  f.click(); await f.flush();
  assert.equal(f.popups[0].hidden, false);
});
test('hovering the card body never loads history, only the footer triggers it', async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return { ok: true, json: async () => ({ pro: true, categories: [category] }) }; });
  f.card.closest = () => null;
  f.listeners.get('pointerover')({ target: f.card, pointerType: 'mouse', relatedTarget: null });
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(requests, 0);
  f.listeners.get('pointerover')({ target: f.trigger, pointerType: 'mouse', relatedTarget: f.card });
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(requests, 1);
  f.context.FinanceSpendingHistory.reset();
});
test('card markup keeps transaction counts visible and history controls outside the drill-down button', () => {
  const html = readFileSync(new URL('index.html', import.meta.url), 'utf8');
  assert.match(html, /mtd-card-count">\$\{Number\(cat.transactionCount\)/);
  assert.match(html, /<\/button>\s*<button[^>]*class="mtd-history-trigger"/);
  assert.match(html, /aria-label="Six-month spending history for/);
  assert.match(html, /spending-history.js\?v=/);
});
