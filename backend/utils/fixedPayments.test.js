import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Database from '../db.js';
import dashboard from '../routes/dashboard.js';
import { buildUpcomingPayments, getFixedBillCategory, isFixedPayment } from './fixedPayments.js';

const today = new Date(2026, 9, 14);
const tx = (id, overrides = {}) => ({
  id, date: '2026-09-20', description: 'PSEG PAYMENT', category: 'Utilities',
  amount: 125.50, direction: 'DEBIT', is_fixed: true, ...overrides
});

test('only the preceding month supplies templates, with the exact last amount and day', () => {
  const result = buildUpcomingPayments([
    tx(1, { date: '2026-08-10', description: 'VERIZON', amount: 80 }),
    tx(2, { date: '2026-09-05', amount: 90 }),
    tx(3),
    tx(4, { date: '2026-10-15', description: 'PENNYMAC', category: 'Mortgage', amount: 1500 })
  ], today);
  assert.deepEqual(result, [{
    description: 'PSEG', category: 'Utilities', amount: 125.50,
    dayOfMonth: 20, isIncome: false, status: 'projected'
  }]);
});

test('paid items match regardless of fixed flag, spacing, case, date or amount', () => {
  const result = buildUpcomingPayments([
    tx(1),
    tx(2, { date: '10/08/2026', description: 'pseg   payment', amount: 140, is_fixed: false })
  ], today);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'processed');
  assert.equal(result[0].amount, 140);
  assert.equal(result[0].dayOfMonth, 8);
});

test('changing credit-card payment references do not create extra bills', () => {
  const result = buildUpcomingPayments([
    tx(1, { description: 'OLLO PAYMENT REF 12345', category: 'Credit Cards' }),
    tx(2, { date: '2026-10-10', description: 'ollo payment REF 67890', category: 'Credit Cards', is_fixed: false })
  ], today);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'processed');
});

test('a label matches otherwise different payment descriptions', () => {
  const result = buildUpcomingPayments([
    tx(1, { description: 'CITY WATER ACH REF 123', label_id: 7 }),
    tx(2, { date: '2026-10-10', description: 'CITY WATER BILL REF 456', label_id: 7, is_fixed: false })
  ], today);
  assert.equal(result[0].status, 'processed');
});

test('separate masked accounts remain separate even with the same label', () => {
  const result = buildUpcomingPayments([
    tx(1, { description: 'OLLO PAYMENT XX1234', label_id: 7, category: 'Credit Cards' }),
    tx(2, { description: 'OLLO PAYMENT XX5678', label_id: 7, category: 'Credit Cards', amount: 50 }),
    tx(3, { date: '2026-10-10', description: 'OLLO PAYMENT **1234', label_id: 7, category: 'Credit Cards' })
  ], today);
  assert.equal(result.filter(item => item.status === 'processed').length, 1);
  assert.equal(result.filter(item => item.status === 'projected').length, 1);
  assert.equal(result.find(item => item.status === 'projected').amount, 50);
});

test('ordinary purchases with corrupted fixed/category flags are excluded', () => {
  for (const description of [
    'VISA DDA PUR AP 123456 TARGET NJ',
    'VISA DDA PUR AP 123456 CHASE CENTER',
    'POS DEBIT GAS STATION',
    'VISA DDA PUR AP 123456 WATER PARK'
  ]) {
    assert.equal(getFixedBillCategory(description), null, description);
    assert.equal(isFixedPayment(tx(1, { description, category: /GAS|WATER/.test(description) ? 'Utilities' : 'Credit Cards' })), false, description);
  }
  assert.deepEqual(buildUpcomingPayments([
    tx(1, { category: 'Groceries', description: 'GROCERY STORE' }),
    tx(2, { direction: 'CREDIT', description: 'PAYROLL', category: 'Salary' }),
    tx(3, { description: 'ALLY TRANSFER', category: 'Savings' }),
    tx(4, { is_fixed: false })
  ], today), []);
  assert.equal(isFixedPayment(tx(5, { description: 'SUNOCO GAS', category: 'Utilities' })), false);
  assert.equal(isFixedPayment(tx(6, { description: 'VISA DDA PUR AP 123456 CHASE CENTER', category: 'Other' })), false);
  assert.equal(isFixedPayment(tx(7, { description: 'TRANSFER TO SAVINGS', category: 'Other' })), false);
  assert.equal(isFixedPayment(tx(8, { description: 'AMAZON STORE CARD PAYMENT', category: 'Shopping' })), true);
});

test('specific required bill descriptions are classified without generic keywords', () => {
  for (const [description, category] of [
    ['PENNYMAC', 'Mortgage'], ['SANTANDER AUTO LOAN', 'Car Loans'],
    ['CAPITAL ONE MOBILE PAY', 'Credit Cards'], ['CHASE CREDIT CARD PAYMENT', 'Credit Cards'],
    ['PSEG PAYMENT', 'Utilities'], ['GAS COMPANY BILL', 'Utilities'],
    ['VERIZON', 'Internet'], ['STATE FARM PREMIUM', 'Insurance']
  ]) {
    assert.equal(getFixedBillCategory(description), category);
  }
  for (const description of ['VISA PURCHASE', 'CHASE ATM WITHDRAWAL', 'GAS STATION', 'ELECTRIC GUITAR', 'RENTAL CAR', 'DISNEY STORE']) {
    assert.equal(getFixedBillCategory(description), null);
  }
});

test('explicitly flagged subscriptions are retained, but are not automatically classified', () => {
  assert.equal(getFixedBillCategory('NETFLIX'), null);
  const result = buildUpcomingPayments([tx(1, { description: 'NETFLIX', category: 'Subscriptions' })], today);
  assert.equal(result.length, 1);
});

test('month-end dates are clamped, including leap years and January rollover', () => {
  assert.equal(buildUpcomingPayments([tx(1, { date: '2026-01-31' })], new Date(2026, 1, 10))[0].dayOfMonth, 28);
  assert.equal(buildUpcomingPayments([tx(1, { date: '2024-01-31' })], new Date(2024, 1, 10))[0].dayOfMonth, 29);
  assert.equal(buildUpcomingPayments([tx(1, { date: '2025-12-31' })], new Date(2026, 0, 10))[0].dayOfMonth, 31);
});

test('overdue unpaid bills remain projected and payments in later months do not settle them', () => {
  const result = buildUpcomingPayments([
    tx(1, { date: '2026-09-03' }),
    tx(2, { date: '2026-11-03' })
  ], today);
  assert.equal(result.length, 1);
  assert.equal(result[0].dayOfMonth, 3);
  assert.equal(result[0].status, 'projected');
});

test('only unpaid amounts reduce balance: 500 -> 374.50 -> 174.50', () => {
  const timeline = buildUpcomingPayments([
    tx(1),
    tx(2, { description: 'PENNYMAC', category: 'Mortgage', amount: 1500 }),
    tx(3, { description: 'VERIZON', amount: 200, date: '2026-09-25' }),
    tx(4, { description: 'PENNYMAC', category: 'Mortgage', amount: 1500, date: '2026-10-02', is_fixed: false })
  ], today);
  let balance = 500;
  const balances = timeline.filter(item => item.status !== 'processed').map(item => {
    balance = Math.round((balance - item.amount) * 100) / 100;
    return balance;
  });
  assert.deepEqual(balances, [374.50, 174.50]);
  assert.equal(timeline.some(item => item.isIncome), false);
  assert.equal(timeline.some(item => item.category === 'Debt Payment'), false);
});

test('invalid payment data surfaces an error instead of a success-shaped fallback', () => {
  assert.throws(() => buildUpcomingPayments([tx(1, { amount: 'invalid' })], today), /Invalid payment amount/);
  assert.throws(() => buildUpcomingPayments([tx(1, { date: 'invalid' })], today), /Invalid payment date/);
  assert.throws(() => buildUpcomingPayments([tx(1, { date: '2026-09-31' })], today), /Invalid payment date/);
});

const html = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');
const dashboardCode = html.slice(html.indexOf('async function loadDashboard()'), html.indexOf('async function drillDownMTD('));

async function renderDashboard(balance, timeline, { ok = true } = {}) {
  const elements = new Map();
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (id === 'mtd-spending-section') return null;
        if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', insertAdjacentHTML() {} });
        return elements.get(id);
      }
    },
    loadCashflowChart() {},
    async fetch(url) {
      if (url.endsWith('/summary')) return { ok: true, json: async () => ({ balance, income: 0, expenses: 0, netCashflow: 0 }) };
      if (url.endsWith('/upcoming-payments')) return { ok, json: async () => timeline };
      if (url.endsWith('/category-spending')) return { json: async () => [] };
      throw new Error(`Unexpected dashboard request: ${url}`);
    }
  });
  await vm.runInContext(`${dashboardCode}\nloadDashboard();`, context);
  return elements;
}

test('frontend script parses and actual dashboard rendering greys paid rows and skips them in the projection', async () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  const elements = await renderDashboard(500, [
    { status: 'processed', dayOfMonth: 1, description: 'Mortgage', category: 'Mortgage', amount: 1500 },
    { status: 'projected', dayOfMonth: 20, description: 'PSEG', category: 'Utilities', amount: 125.50 },
    { status: 'projected', dayOfMonth: 25, description: 'Verizon', category: 'Internet', amount: 200 }
  ]);
  const table = elements.get('dashboard-payments').innerHTML;
  assert.match(table, /opacity: 0\.65/);
  assert.match(table, /Paid/);
  assert.match(table, /\$374\.50/);
  assert.match(table, /\$174\.50/);
  assert.doesNotMatch(table, /AT RISK/);
  assert.match(elements.get('cashflow-safety-badge').innerHTML, /All Bills Fully Funded/);
});

test('frontend distinguishes the first deficit from the minimum balance and handles an already-negative balance', async () => {
  const timeline = [
    { status: 'projected', dayOfMonth: 20, description: 'PSEG', category: 'Utilities', amount: 200 },
    { status: 'projected', dayOfMonth: 25, description: 'Verizon', category: 'Internet', amount: 100 }
  ];
  const elements = await renderDashboard(150, timeline);
  const badge = elements.get('cashflow-safety-badge').innerHTML;
  assert.match(badge, /First shortfall: Day 20/);
  assert.match(badge, /Minimum projected balance: -\$150\.00/);
  assert.match(elements.get('dashboard-payments').innerHTML, /AT RISK/);
  const negative = await renderDashboard(-10, [{ ...timeline[0], status: 'processed' }]);
  assert.match(negative.get('cashflow-safety-badge').innerHTML, /already negative/);
  assert.doesNotMatch(negative.get('cashflow-safety-badge').innerHTML, /Day null/);
});

test('frontend uses currency rounding and does not invent a fractional-cent deficit', async () => {
  const elements = await renderDashboard(0.30, [
    { status: 'projected', dayOfMonth: 20, description: 'Bill A', category: 'Other', amount: 0.10 },
    { status: 'projected', dayOfMonth: 25, description: 'Bill B', category: 'Other', amount: 0.20 }
  ]);
  assert.match(elements.get('cashflow-safety-badge').innerHTML, /All Bills Fully Funded/);
  assert.doesNotMatch(elements.get('dashboard-payments').innerHTML, /AT RISK/);
});

test('frontend does not claim bills are funded when payment data or balance is unavailable', async () => {
  const error = await renderDashboard(500, { error: 'Database unavailable' }, { ok: false });
  assert.match(error.get('dashboard-payments').textContent, /Database unavailable/);
  assert.equal(error.get('cashflow-safety-badge').textContent, 'Projection unavailable');
  const missing = await renderDashboard(null, [
    { status: 'projected', dayOfMonth: 20, description: 'PSEG', category: 'Utilities', amount: 200 }
  ]);
  assert.match(missing.get('cashflow-safety-badge').textContent, /no recorded account balance/);
  assert.doesNotMatch(missing.get('dashboard-payments').innerHTML, /AT RISK/);
  const empty = await renderDashboard(500, []);
  assert.match(empty.get('cashflow-safety-badge').textContent, /No fixed payments/);
});

function responseRecorder() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function routeHandler(path) {
  return dashboard.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
}

test('upcoming endpoint fetches all flags in the relevant months and returns the established array shape', async t => {
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 20);
  const dateString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  t.mock.method(Database.prototype, 'all', async (sql, params) => {
    assert.match(sql, /date::date >= \$2::date/);
    assert.doesNotMatch(sql, /is_fixed = TRUE/);
    assert.equal(params[0], 1);
    assert.equal(params[1], dateString(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
    assert.equal(params[2], dateString(now));
    return [
      tx(1, { date: dateString(previous) }),
      tx(2, { date: dateString(now), is_fixed: false })
    ];
  });
  const response = responseRecorder();
  await routeHandler('/upcoming-payments')({}, response);
  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body));
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].status, 'processed');
});

test('upcoming endpoint reports invalid payment data as an HTTP error', async t => {
  t.mock.method(Database.prototype, 'all', async () => [tx(1, { amount: 'invalid' })]);
  const response = responseRecorder();
  await routeHandler('/upcoming-payments')({}, response);
  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /Invalid payment amount/);
});

test('summary endpoint uses the latest non-null recorded balance and chronological date ordering', async t => {
  t.mock.method(Database.prototype, 'all', async sql => {
    if (sql.includes('SELECT balance')) {
      assert.match(sql, /balance IS NOT NULL/);
      assert.match(sql, /date::date <= CURRENT_DATE/);
      assert.match(sql, /ORDER BY date::date DESC, id DESC/);
      return [{ balance: '500.25' }];
    }
    return [];
  });
  t.mock.method(Database.prototype, 'get', async () => ({ total_income: 0, total_expenses: 0 }));
  const response = responseRecorder();
  await routeHandler('/summary')({ body: { dateFilter: 'current' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.balance, 500.25);
});

test('summary endpoint explicitly reports a missing balance instead of assuming zero', async t => {
  t.mock.method(Database.prototype, 'all', async () => []);
  t.mock.method(Database.prototype, 'get', async () => ({ total_income: 0, total_expenses: 0 }));
  const response = responseRecorder();
  await routeHandler('/summary')({ body: { dateFilter: 'current' } }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.balance, null);
});
