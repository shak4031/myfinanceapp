import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInterestSummary, classifyInterest, inferInterestKind, isInterestCharge } from './interest.js';

const debit = (description, extra = {}) => ({ description, direction: 'DEBIT', amount: 10, date: '2026-03-05', ...extra });

test('detects card and loan interest charges but not earned interest', () => {
  for (const text of ['INTEREST CHARGE ON PURCHASES', 'Purchase Interest Charge', 'FINANCE CHARGE', 'Cash advance interest',
    'Interest charged on balance transfers', 'INTEREST', 'Periodic finance charge', 'Mortgage interest']) {
    assert.equal(isInterestCharge(debit(text)), true, text);
  }
  for (const text of ['Interest earned', 'Dividend interest', 'Interest charge reversal', 'Finance charge waived',
    'High-yield savings interest', 'Amazon purchase', 'Interest savings transfer']) {
    assert.equal(isInterestCharge(debit(text)), false, text);
  }
  assert.equal(isInterestCharge({ description: 'INTEREST CHARGE', direction: 'CREDIT' }), false);
  assert.equal(isInterestCharge(debit('CHASE CARD ACTIVITY', { plaid_category: 'BANK_FEES_INTEREST_CHARGE' })), true);
});

test('infers interest kind from description, Plaid subtype, then account kind', () => {
  assert.equal(inferInterestKind(debit('Auto loan interest')), 'auto_loan');
  assert.equal(inferInterestKind(debit('Mortgage interest')), 'mortgage');
  assert.equal(inferInterestKind(debit('Nelnet interest')), 'student_loan');
  assert.equal(inferInterestKind(debit('INTEREST', { plaid_subtype: 'auto', plaid_type: 'loan' })), 'auto_loan');
  assert.equal(inferInterestKind(debit('INTEREST', { plaid_type: 'credit', plaid_subtype: 'credit card' })), 'credit_card');
  assert.equal(inferInterestKind(debit('INTEREST', { account_kind: 'loan' })), 'personal_loan');
  assert.equal(inferInterestKind(debit('INTEREST CHARGE ON PURCHASES')), 'credit_card');
  assert.equal(inferInterestKind(debit('INTEREST')), 'other');
});

test('manual overrides win over detection', () => {
  assert.deepEqual(classifyInterest(debit('Amazon', { interest_override: true, interest_kind: 'auto_loan' })), { kind: 'auto_loan', source: 'manual' });
  assert.equal(classifyInterest(debit('INTEREST CHARGE', { interest_override: true, interest_kind: null })), null);
  assert.deepEqual(classifyInterest(debit('INTEREST CHARGE')), { kind: 'credit_card', source: 'detected' });
});

test('buildInterestSummary totals by month and kind and estimates loan interest without double counting', () => {
  const now = new Date(2026, 2, 20);
  const transactions = [
    { id: 1, date: '2026-03-03', description: 'INTEREST CHARGE ON PURCHASES', amount: 42.17, direction: 'DEBIT' },
    { id: 2, date: '02/03/2026', description: 'INTEREST CHARGE ON PURCHASES', amount: 38.5, direction: 'DEBIT' },
    { id: 3, date: '2026-03-01', description: 'ROCKET MORTGAGE PMT', amount: 2200, direction: 'DEBIT', category: 'Mortgage' },
    { id: 4, date: '2026-02-01', description: 'ROCKET MORTGAGE PMT', amount: 2200, direction: 'DEBIT', category: 'Mortgage' },
    { id: 5, date: '2026-02-12', description: 'TOYOTA FIN PMT', amount: 412, direction: 'DEBIT' },
    { id: 6, date: '2026-02-28', description: 'Toyota auto loan interest', amount: 70, direction: 'DEBIT' },
    { id: 7, date: '2026-03-12', description: 'TOYOTA FIN PMT', amount: 412, direction: 'DEBIT' },
    { id: 8, date: '2025-01-03', description: 'INTEREST CHARGE', amount: 99, direction: 'DEBIT' }
  ];
  const debts = [
    { id: 10, name: 'Home', debt_type: 'mortgage', balance: 290000, apr: 6, escrow_payment: 400 },
    { id: 11, name: 'Toyota', debt_type: 'auto_loan', balance: 12000, apr: 6, payment_match: 'toyota fin' },
    { id: 12, name: 'Student', debt_type: 'student_loan', balance: 9000, apr: 4 }
  ];
  const summary = buildInterestSummary({ transactions, debts, now, months: 12 });
  const march = summary.months.at(-1);
  const feb = summary.months.at(-2);
  assert.equal(march.month, '2026-03');
  assert.equal(march.byKind.credit_card, 42.17);
  assert.equal(march.byKind.mortgage, 1450);
  assert.equal(march.byKind.auto_loan, 60);
  assert.equal(feb.byKind.auto_loan, 70);
  assert.equal(feb.byKind.credit_card, 38.5);
  assert.equal(summary.totals.mortgage, 2900);
  assert.equal(summary.thisMonth, 1552.17);
  assert.equal(summary.estimated, 2960);
  assert.equal(summary.charges.find(row => row.id === 7).source, 'estimated');
  assert.equal(summary.charges.some(row => row.id === 5), false);
  assert.equal(summary.charges.some(row => row.id === 8), false);
  assert.equal(summary.hints.length, 1);
  assert.equal(summary.hints[0].debtId, 12);
  assert.equal(summary.yearToDate, summary.total);
});

test('estimated interest uses the amortization schedule and is capped at the payment minus escrow', () => {
  const now = new Date(2024, 0, 20);
  const debts = [{ id: 1, name: 'Home', debt_type: 'mortgage', balance: 1, apr: 6, original_amount: 300000, term_months: 360,
    first_payment_month: '2024-01', escrow_payment: 0, payment_match: 'mortgage pmt' }];
  const summary = buildInterestSummary({ now, debts, months: 3, transactions: [
    { id: 1, date: '2024-01-01', description: 'MORTGAGE PMT', amount: 1798.65, direction: 'DEBIT' },
    { id: 2, date: '2024-01-02', description: 'MORTGAGE PMT partial', amount: 100, direction: 'DEBIT' }
  ] });
  assert.equal(summary.charges.find(row => row.id === 1).amount, 1500);
  assert.equal(summary.charges.find(row => row.id === 2).amount, 100);
});
