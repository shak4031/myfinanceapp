import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const code = readFileSync(new URL('transaction-duplicates.js', import.meta.url), 'utf8');
const pair = {
  plaid: { id: 10, description: '<Bank payroll>', date: '2026-10-21', amount: 6200, direction: 'CREDIT',
    source: 'plaid', account_name: 'Checking', account_mask: '5237', category: 'Salary' },
  existing: { id: 1, description: 'BANK PAYROLL', display_name: 'My paycheck', date: '2026-10-21',
    amount: 6200, direction: 'CREDIT', source: 'october.csv', account_name: 'Checking', account_mask: '5237', category: 'Salary' },
  revision: 'a'.repeat(64), bulkEligible: true
};
function fixture({ fetchImpl, confirm = true } = {}) {
  const listeners = {}, events = {}, nodes = new Map(), calls = [], refreshed = [];
  const node = name => {
    if (!nodes.has(name)) nodes.set(name, { innerHTML: '', textContent: '', disabled: false,
      attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
    return nodes.get(name);
  };
  const dialog = {
    open: false, style: {}, innerHTML: '', setAttribute() {},
    querySelector: node, querySelectorAll: selector => selector === '[data-duplicates-select]' ? [] : [...nodes.values()],
    addEventListener: (name, fn) => { events[name] = fn; },
    showModal() { this.open = true; }, close() { this.open = false; }
  };
  const context = {
    document: { createElement: () => dialog, body: { appendChild() {} },
      addEventListener: (name, fn) => { listeners[name] = fn; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchImpl) return fetchImpl(url, options, calls.length);
      return { ok: true, json: async () => options?.method === 'POST'
        ? { success: true, keptTransactionId: 1, removedTransactionId: 10, merged: 1 }
        : { rows: [pair], total: 1, offset: 0, limit: 50 } };
    },
    FinanceUI: { confirm: async () => confirm },
    FinancePlan: { invalidate: () => refreshed.push('plan') },
    FinancePro: { invalidateAnalytics: () => refreshed.push('analytics') },
    FinanceReviewTools: { invalidateImports: () => refreshed.push('imports') },
    loadDashboard: async () => refreshed.push('dashboard'),
    loadAllTransactions: async () => refreshed.push('transactions'),
    loadCategories: async () => refreshed.push('categories')
  };
  context.window = context;
  vm.runInNewContext(code, context);
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  const open = async () => {
    listeners.click({ target: { closest: selector => selector === '[data-transaction-duplicates]' ? {} : null } });
    await flush();
  };
  const click = async (attribute, dataset = {}) => {
    const button = { hasAttribute: name => name === attribute, dataset };
    events.click({ target: { closest: () => button } });
    await flush();
  };
  const select = async (index, checked = true) => {
    events.change({ target: { closest: () => ({ dataset: { duplicatesSelect: String(index) }, checked }) } });
    await flush();
  };
  return { context, dialog, node, calls, refreshed, open, click, select, flush };
}

test('duplicate UI opens only on request, escapes descriptions and shows both sources and account masks', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0);
  assert.match(f.dialog.innerHTML, /Nothing|not proven duplicates/);
  await f.open();
  assert.equal(f.dialog.open, true);
  assert.equal(f.calls.length, 1);
  const html = f.node('#duplicates-rows').innerHTML;
  assert.match(html, /&lt;Bank payroll&gt;/);
  assert.match(html, /My paycheck/);
  assert.match(html, /october.csv/);
  assert.match(html, /ending 5237/);
  assert.match(html, /Merge into existing/);
  assert.doesNotMatch(html, /<Bank payroll>/);
  assert.equal(f.node('[data-duplicates-next]').disabled, true);
});

test('declining confirmation never sends a merge request', async () => {
  const f = fixture({ confirm: false });
  await f.open();
  await f.click('data-duplicates-merge', { duplicatesMerge: '0' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.refreshed.length, 0);
});

test('confirmed merge sends the exact reviewed pair and refreshes totals, forecast and analytics', async () => {
  const f = fixture();
  await f.open();
  await f.click('data-duplicates-merge', { duplicatesMerge: '0' });
  const merge = f.calls.find(call => call.options?.method === 'POST');
  assert.equal(merge.url, '/api/import-review/duplicates/merge');
  assert.deepEqual(JSON.parse(merge.options.body), { plaidId: 10, existingId: 1, revision: pair.revision, acknowledged: true });
  assert.deepEqual(f.refreshed, ['plan', 'analytics', 'imports', 'dashboard', 'transactions', 'categories']);
  assert.match(f.node('#duplicates-status').textContent, /Totals and forecasts refreshed/);
});

test('stale merge failures clear choices, display the error and require an explicit reload', async () => {
  const f = fixture({ fetchImpl: async (url, options) => options?.method === 'POST'
    ? { ok: false, status: 409, json: async () => ({ error: 'Match settings changed' }) }
    : { ok: true, json: async () => ({ rows: [pair], total: 1, offset: 0 }) } });
  await f.open();
  await f.click('data-duplicates-merge', { duplicatesMerge: '0' });
  assert.match(f.node('#duplicates-status').textContent, /Match settings changed/);
  assert.equal(f.node('#duplicates-status').attributes.role, 'alert');
  assert.equal(f.node('#duplicates-rows').innerHTML, '');
  await f.click('data-duplicates-merge', { duplicatesMerge: '0' });
  assert.equal(f.calls.length, 2);
  await f.click('data-duplicates-reload');
  assert.equal(f.calls.length, 3);
});

test('reset clears private rows and discards a response from the previous household', async () => {
  let resolve;
  const f = fixture({ fetchImpl: () => new Promise(done => { resolve = done; }) });
  await f.open();
  f.context.FinanceTransactionDuplicates.reset();
  resolve({ ok: true, json: async () => ({ rows: [pair], total: 1, offset: 0 }) });
  await f.flush();
  assert.equal(f.dialog.open, false);
  assert.equal(f.node('#duplicates-rows').innerHTML, '');
  assert.equal(f.node('#duplicates-status').textContent, '');
});

test('the duplicate review entry is in Transactions and its script and household reset are wired', () => {
  const index = readFileSync(new URL('index.html', import.meta.url), 'utf8');
  const start = index.indexOf('<section id="transactions-view"');
  const end = index.indexOf('</section>', start);
  assert.match(index.slice(start, end), /data-transaction-duplicates/);
  assert.match(index, /src="transaction-duplicates\.js\?v=/);
  assert.match(readFileSync(new URL('session.js', import.meta.url), 'utf8'), /FinanceTransactionDuplicates\?\.reset/);
});

test('page selection submits one atomic batch and clear selection prevents a merge', async () => {
  const f = fixture();
  await f.open();
  await f.click('data-duplicates-select-page');
  assert.equal(f.node('[data-duplicates-merge-selected]').textContent, 'Merge selected (1)');
  await f.click('data-duplicates-clear');
  assert.equal(f.node('[data-duplicates-merge-selected]').disabled, true);
  await f.select(0);
  await f.click('data-duplicates-merge-selected');
  const request = f.calls.find(call => call.options?.method === 'POST');
  assert.equal(request.url, '/api/import-review/duplicates/merge-bulk');
  assert.deepEqual(JSON.parse(request.options.body), {
    pairs: [{ plaidId: 10, existingId: 1, revision: pair.revision }], acknowledged: true
  });
  assert.match(f.node('#duplicates-status').textContent, /Merged 1 duplicate pairs/);
  assert.equal(f.refreshed.filter(value => value === 'dashboard').length, 1);
  assert.equal(f.node('[data-duplicates-merge-selected]').disabled, true);
});

test('cross-page selection persists, but conflicting pairs and automatic ambiguous selection are prevented', async () => {
  const second = { ...pair, plaid: { ...pair.plaid, id: 11 }, existing: { ...pair.existing, id: 2 } };
  const ambiguous = { ...pair, plaid: { ...pair.plaid, id: 12 }, bulkEligible: false };
  const f = fixture({ fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('offset=50')
    ? { rows: [second, ambiguous], total: 52, offset: 50 }
    : { rows: [pair], total: 52, offset: 0 } }) });
  await f.open();
  await f.select(0);
  await f.click('data-duplicates-next');
  await f.click('data-duplicates-select-page');
  assert.equal(f.node('[data-duplicates-merge-selected]').textContent, 'Merge selected (2)');
  await f.select(1);
  assert.equal(f.node('[data-duplicates-merge-selected]').textContent, 'Merge selected (2)', 'existing record already selected on the first page');
  await f.click('data-duplicates-reload');
  assert.equal(f.node('[data-duplicates-merge-selected]').textContent, 'Merge selected (0)');
});

test('select all requests globally unambiguous pairs and cancelled bulk confirmation does not merge', async () => {
  const f = fixture({ confirm: false });
  await f.open();
  await f.click('data-duplicates-select-all');
  assert.equal(f.calls[1].url, '/api/import-review/duplicates?selection=all');
  assert.equal(f.node('[data-duplicates-merge-selected]').textContent, 'Merge selected (1)');
  await f.click('data-duplicates-merge-selected');
  assert.equal(f.calls.filter(call => call.options?.method === 'POST').length, 0);
  assert.equal(f.node('[data-duplicates-merge-selected]').textContent, 'Merge selected (1)');
});

test('failed bulk merge clears all selections and requires reviewing again', async () => {
  const f = fixture({ fetchImpl: async (url, options) => options?.method === 'POST'
    ? { ok: false, json: async () => ({ error: 'A selected match changed; nothing merged' }) }
    : { ok: true, json: async () => ({ rows: [pair], total: 1, offset: 0 }) } });
  await f.open();
  await f.click('data-duplicates-select-page');
  await f.click('data-duplicates-merge-selected');
  assert.equal(f.node('[data-duplicates-merge-selected]').disabled, true);
  assert.match(f.node('#duplicates-status').textContent, /nothing merged/);
  assert.equal(f.refreshed.length, 0);
});
