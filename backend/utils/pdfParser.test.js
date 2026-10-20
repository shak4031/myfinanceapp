import assert from 'node:assert/strict';
import test from 'node:test';
import PDFParser, { parseStatementText } from './pdfParser.js';
import { cardLines, bankLines, statementPDF } from './test-fixtures/statements.js';
const card = lines => parseStatementText((lines || cardLines).join('\n'));
const bank = lines => parseStatementText((lines || bankLines).join('\n'));

test('actual multipage PDF extraction uses v2 API and reconciles every transaction in cents', async () => {
  const result = await new PDFParser().parseDocument(statementPDF([cardLines.slice(0, 28), cardLines.slice(28)]));
  assert.equal(result.transactions.length, 6);
  assert.equal(result.statement.type, 'credit-card');
  assert.equal(result.statement.purchaseApr, 24.99);
  assert.equal(result.statement.balance, 110);
  assert.equal(result.statement.minimumPayment, 25);
  assert.equal(result.statement.creditLimit, 500);
  assert.equal(result.statement.last4, '1111');
  assert.equal(result.statement.paymentDueDate, '2026-10-28');
  assert.equal(result.reconciliation.status, 'balanced');
  assert.deepEqual(result.transactions.map(tx => tx.direction), ['DEBIT', 'DEBIT', 'CREDIT', 'CREDIT', 'DEBIT', 'DEBIT']);
  assert.equal(result.transactions[0].date, '2026-09-11', 'use posting date for reconciliation');
  assert.equal(result.transactions[2].categoryHint, 'Transfer');
  assert.ok(result.transactions.every(tx => tx.balance === null), 'statement balance is not fabricated into transaction-level running balances');
});
test('wrapped merchant names and amounts on subsequent lines are retained', () => {
  const result = card(cardLines.map(line => line.includes('00001 09/10') ? line.replace('SAMPLE MARKET 20.00', 'SAMPLE MARKET\nCITY NJ\n20.00') : line));
  assert.equal(result.transactions[0].description, 'SAMPLE MARKET CITY NJ');
  assert.equal(result.transactions.length, 6);
});
test('statement identity reads masked endings, issuer headers and account type without storing full numbers', () => {
  for (const label of ['Account Number: XXXX-XXXX-XXXX-1111', 'Card Number: **** 1111', 'Account ending in 1111', 'Account #: 4000 0000 0000 1111', 'Cardmember Ending in 1111 1 of 4']) {
    const result = card(cardLines.map(line => line.startsWith('Account Number') ? label : line.replace('EXAMPLE CREDIT CARD', 'Credit One Bank CREDIT CARD')));
    assert.equal(result.statement.last4, '1111', label);
    assert.equal(result.statement.institution, 'Credit One');
    assert.equal(result.statement.accountKind, 'credit_card');
    assert.equal(result.statement.identityAmbiguous, false);
    assert.ok(!JSON.stringify(result.statement).includes('4000 0000'));
  }
  assert.equal(bank().statement.accountKind, 'checking');
  assert.equal(bank(bankLines.map(line => line.replace('CHECKING', 'SAVINGS'))).statement.accountKind, 'savings');
  assert.equal(card([...cardLines, 'Account Number Ending 9999']).statement.identityAmbiguous, true);
});
test('years come from the statement period including December/January rollover', () => {
  const result = card(cardLines.map(line => line
    .replace('September 04, 2026 to October 03, 2026', 'December 06, 2026 to January 05, 2027')
    .replace('Statement Closing Date 10/03/26', 'Statement Closing Date 01/05/27')
    .replace(/09\/10/g, '12/28').replace(/09\/11/g, '12/29')
    .replace(/09\/28/g, '01/02').replace(/09\/29/g, '01/03').replace(/10\/03 10\/03/g, '01/05 01/05')));
  assert.equal(result.transactions[0].date, '2026-12-29');
  assert.equal(result.transactions[2].date, '2027-01-02');
});
test('new statement balance and trailing CR / parenthesized credits are understood', () => {
  const result = card(cardLines.map(line => line.replace(/New Balance/g, 'New Statement Balance').replace('-5.00', '($5.00)').replace('$30.00-', '$30.00 CR')));
  assert.equal(result.statement.balance, 110);
  assert.equal(result.transactions[3].direction, 'CREDIT');
});
test('positive amounts in card payment/credit sections are not mistaken for purchases', () => {
  const lines = cardLines.map(line => line.includes('00003 09/28') ? `Payments, Credits, and Adjustments\n${line.replace('$30.00-', '$30.00')}`
    : line.includes('00004 09/29') ? line.replace('-5.00', '5.00')
    : line.includes('MONTHLY FEE') ? `Fees Charged\n${line}` : line);
  assert.equal(card(lines).reconciliation.status, 'balanced');
});
test('purchase APR never substitutes a cash APR and multiple purchase rates need review', () => {
  const missing = card(cardLines.filter(line => !line.startsWith('Purchases 24.99')));
  assert.equal(missing.statement.purchaseApr, null);
  assert.match(missing.warnings[0], /Purchase APR/);
  const multiple = card([...cardLines, 'Purchases 12.99% $0.00 $0.00']);
  assert.equal(multiple.statement.purchaseApr, null);
  assert.match(multiple.warnings[0], /Multiple purchase APRs/);
});
test('bank statements use running balances instead of treating all rows as purchases', async () => {
  const result = await new PDFParser().parseDocument(statementPDF(bankLines));
  assert.equal(result.statement.type, 'bank');
  assert.equal(result.statement.balance, 250);
  assert.equal(result.statement.purchaseApr, null);
  assert.deepEqual(result.transactions.map(tx => tx.direction), ['CREDIT', 'DEBIT']);
  assert.deepEqual(result.transactions.map(tx => tx.balance), [300, 250]);
});
test('bank sections and explicit debit/credit columns work without running balances', () => {
  const sections = bank([...bankLines.slice(0, 7), 'Deposits and Credits', 'Date Description Amount', '09/05 PAYROLL 200.00', 'Withdrawals and Debits', 'Date Description Amount', '09/06 MARKET 50.00']);
  assert.deepEqual(sections.transactions.map(tx => tx.direction), ['CREDIT', 'DEBIT']);
  const columns = bank([...bankLines.slice(0, 7), 'Date Description Debit Credit Balance', '09/05 PAYROLL 0.00 200.00 300.00', '09/06 MARKET 50.00 0.00 250.00']);
  assert.deepEqual(columns.transactions.map(tx => tx.direction), ['CREDIT', 'DEBIT']);
  const noBalance = bank([...bankLines.slice(0, 7), 'Date Description Credit Debit', '09/05 PAYROLL 200.00 0.00', '09/06 MARKET 0.00 50.00']);
  assert.deepEqual(noBalance.transactions.map(tx => tx.direction), ['CREDIT', 'DEBIT']);
});
test('a verified empty statement saves facts but no synthetic transaction', () => {
  const result = card(cardLines.filter(line => !/^\d{2}\/\d{2}|^73793/.test(line)).map(line => line
    .replace('$110.00', '$100.00').replace('$40.00', '$0.00').replace('$30.00', '$0.00')
    .replace('$5.00', '$0.00').replace('$3.00', '$0.00').replace('$2.00', '$0.00')));
  assert.equal(result.transactions.length, 0);
  assert.equal(result.reconciliation.status, 'balanced');
});
test('missing rows, invalid dates, ambiguous amounts and conflicting balances never succeed', () => {
  const cases = [
    cardLines.filter(line => !line.includes('00001 09/10')),
    cardLines.map(line => line.replace('09/11', '02/30')),
    cardLines.map(line => line.replace('SAMPLE MARKET 20.00', 'SAMPLE MARKET')),
    [...cardLines, 'New Balance $999.99'],
    cardLines.filter(line => !line.includes('Previous Balance')),
    cardLines.filter(line => !line.includes('New Balance')),
    cardLines.map(line => line.replace('Purchases + $40.00', 'Purchases + $50.00'))
  ];
  for (const lines of cases) assert.throws(() => card(lines), { status: 422 });
  assert.throws(() => bank([...bankLines.slice(0, 7), 'Date Description Amount', '09/05 PAYROLL 200.00', '09/06 MARKET 50.00']), /could not be distinguished/);
});
test('unreadable PDFs and text are explicit failures, not zero-row success', async () => {
  const parser = new PDFParser();
  await assert.rejects(parser.parseDocument(Buffer.from('not pdf')), { status: 400 });
  await assert.rejects(parser.parseDocument(Buffer.from('%PDF-1.4\nbroken')), { status: 422 });
  await assert.rejects(parser.parseDocument(statementPDF([''])), /no readable statement text/);
  assert.throws(() => parseStatementText(''), { status: 422 });
  assert.throws(() => parseStatementText('An unrelated long document. '.repeat(10)), /could not be identified/);
});
