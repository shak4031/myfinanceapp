import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, paymentFor, scheduledInterestFor, simulateMortgage, yearlyRollup } from './amortization.js';

test('paymentFor matches the standard amortization formula', () => {
  assert.equal(paymentFor(300000, 6, 360), 1798.65);
  assert.equal(paymentFor(12000, 0, 12), 1000);
  assert.equal(paymentFor(0, 6, 360), 0);
});

test('buildSchedule pays off on schedule and rolls up by year', () => {
  const schedule = buildSchedule({ principal: 300000, apr: 6, termMonths: 360, firstPaymentMonth: '2024-01' });
  assert.equal(schedule.rows.length, 360);
  assert.equal(schedule.rows[0].interest, 1500);
  assert.equal(schedule.rows[0].principal, 298.65);
  assert.equal(schedule.rows.at(-1).balance, 0);
  assert.equal(schedule.payoffMonth, '2053-12');
  assert.ok(Math.abs(schedule.totalInterest - 347514) < 50);
  const years = yearlyRollup(schedule.rows);
  assert.equal(years.length, 30);
  assert.equal(years[0].months.length, 12);
  assert.equal(scheduledInterestFor({ original_amount: 300000, apr: 6, term_months: 360, first_payment_month: '2024-01' }, '2024-01'), 1500);
  assert.equal(scheduledInterestFor({ original_amount: 300000, apr: 6, term_months: 360, first_payment_month: '2024-01' }, '2023-12'), null);
});

test('simulateMortgage compares baseline and extra payments from today', () => {
  const now = new Date(2026, 0, 15);
  const base = simulateMortgage({ principal: 300000, apr: 6, termMonths: 360, firstPaymentMonth: '2024-01' }, now);
  assert.equal(base.toDate.months, 24);
  assert.equal(base.balance, base.toDate.scheduledBalance);
  assert.equal(base.baseline.months, 336);
  assert.equal(base.savings.interest, 0);
  const extra = simulateMortgage({ principal: 300000, apr: 6, termMonths: 360, firstPaymentMonth: '2024-01', extraMonthly: 200 }, now);
  assert.ok(extra.scenario.months < extra.baseline.months);
  assert.ok(extra.savings.interest > 50000);
  assert.ok(extra.savings.months > 60);
  const biweekly = simulateMortgage({ principal: 300000, apr: 6, termMonths: 360, firstPaymentMonth: '2024-01', biweekly: true }, now);
  assert.equal(biweekly.scenario.extraMonthlyTotal, 149.89);
  const lump = simulateMortgage({ principal: 300000, apr: 6, termMonths: 360, firstPaymentMonth: '2024-01', lumpSum: 20000, lumpSumMonth: '2026-01' }, now);
  assert.ok(lump.savings.interest > 0);
  const overrideBalance = simulateMortgage({ principal: 300000, apr: 6, termMonths: 360, firstPaymentMonth: '2024-01', currentBalance: 250000 }, now);
  assert.equal(overrideBalance.balance, 250000);
  assert.ok(overrideBalance.baseline.months < base.baseline.months);
  assert.equal(base.series[0].baseline, base.balance);
});

test('simulateMortgage rejects missing loan terms', () => {
  assert.throws(() => simulateMortgage({ apr: 6 }), /original loan amount/);
});
