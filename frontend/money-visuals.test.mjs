import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const context = { FinancePro: { format: { esc, money: value => `$${Number(value).toFixed(2)}` } } };
vm.runInNewContext(readFileSync(new URL('money-visuals.js', import.meta.url), 'utf8'), context);
const { mosaic, signalNetwork } = context.FinanceMoneyVisuals;

test('mosaic areas represent exact proportions and retain small merchants and escaped details', () => {
  const html = mosaic([{ name: '<Big>', value: 75, detail: '3 payments' }, { name: 'Small', value: 25 }, { name: 'Empty', value: 0 }]);
  assert.match(html, /width:75%;height:100%/);
  assert.match(html, /width:25%;height:100%/);
  assert.match(html, /&lt;Big&gt;/);
  assert.doesNotMatch(html, /<Big>|NaN|undefined|Empty/);
  assert.match(html, /tabindex="0" role="img"/);
  assert.match(html, /Exact totals and trends/);
  assert.match(html, /75\.0% of displayed spending/);
  assert.match(mosaic([]), /No spending/);
});

test('mosaic does not drop tiny merchants and every rectangle contributes its proportional area', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ name: `Merchant ${i}`, value: i + 1 }));
  const html = mosaic(items);
  const rectangles = [...html.matchAll(/left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%/g)];
  assert.equal(rectangles.length, 60);
  let area = 0;
  for (const [, x, y, w, h] of rectangles) {
    assert.ok(Number(x) >= 0 && Number(y) >= 0 && Number(x) + Number(w) <= 100.000001 && Number(y) + Number(h) <= 100.000001);
    area += Number(w) * Number(h);
  }
  assert.ok(Math.abs(area - 10000) < 0.00001);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('signal network uses one link per real signal, keeps exact spending, and handles empty data', () => {
  const html = signalNetwork([{ label: 'Dining & coffee', monthly: 240, signals: ['a', 'b'] },
    { label: 'Gas', monthly: 70, signals: ['c'] }, { label: 'Clear category', monthly: 50, signals: [] }],
  { a: 'Above similar homes', b: 'Trending up', c: 'Unusual latest month' });
  assert.equal((html.match(/<path /g) || []).length, 3);
  assert.match(html, /Dining &amp; coffee/);
  assert.match(html, /\$240\.00/);
  assert.match(html, /2 signals/);
  assert.doesNotMatch(html, /Clear category|NaN|undefined/);
  assert.match(html, /not money transfers/);
  assert.match(signalNetwork([], {}), /No category/);
});
