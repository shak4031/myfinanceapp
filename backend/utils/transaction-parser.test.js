import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactionCSVParser } from './transaction-parser.js';

test('account-type metadata is per account and does not guess types from transaction wording', () => {
  const csv = `Date,Account Number,Account Type,Description,Amount
2026-10-20,00001111,Checking,PURCHASE,-12
2026-10-20,00002222,Credit Card,PURCHASE,12
2026-10-20,00003333,constructor,SAVINGS DEPOSIT,12`;
  const parsed = new TransactionCSVParser().parse(csv);
  assert.deepEqual(parsed.format.accounts.map(group => group.kind), ['checking', 'credit_card', null]);
  assert.deepEqual(parsed.transactions.map(row => row.direction), ['DEBIT', 'DEBIT', 'CREDIT']);
  const conflicting = new TransactionCSVParser().parse(`${csv}\n2026-10-21,00001111,Savings,INTEREST,2`);
  assert.equal(conflicting.format.accounts[0].kind, null);
  assert.equal(conflicting.format.accounts[0].typeAmbiguous, true);
  assert.doesNotMatch(JSON.stringify(parsed.format), /00001111|00002222|00003333/);
});

// Layouts follow each institution's published CSV download format.
const BANKS = {
  'TD Bank checking': ['checking', `Date,Bank RTN,Account Number,Transaction Type,Description,Debit,Credit,Check Number,Balance
10/09/2026,031201360,1234,ACH DEPOSIT,NORTHWIND TECH PAYROLL,,3586.20,,7500.00
10/14/2026,031201360,1234,DEBIT CARD,NETFLIX.COM,15.49,,,7484.51`],
  'Chase checking': ['checking', `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
CREDIT,10/09/2026,"NORTHWIND TECH PAYROLL PPD ID: 123",3586.20,ACH_CREDIT,7500.00,,
DEBIT,10/14/2026,"NETFLIX.COM",-15.49,DEBIT_CARD,7484.51,,`],
  'Chase credit card': ['credit_card', `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/14/2026,10/15/2026,NETFLIX.COM,Entertainment,Sale,-15.49,
10/12/2026,10/12/2026,Payment Thank You-Mobile,,Payment,350.00,`],
  'Bank of America checking': ['checking', `Description,,Summary Amt.
Beginning balance as of 10/01/2026,,"3,914.00"
Total credits,,"3,586.20"
Total debits,,"-15.49"
Ending balance as of 10/15/2026,,"7,484.71"

Date,Description,Amount,Running Bal.
10/01/2026,Beginning balance as of 10/01/2026,,"3,914.00"
10/09/2026,"NORTHWIND TECH DES:PAYROLL ID:123","3,586.20","7,500.20"
10/14/2026,"NETFLIX.COM","-15.49","7,484.71"`],
  'Bank of America credit card': ['credit_card', `Posted Date,Reference Number,Payee,Address,Amount
10/14/2026,24692166287100012345678,NETFLIX.COM,866-579-7172 CA,-15.49
10/12/2026,24692166287100012345679,PAYMENT - THANK YOU,,350.00`],
  'Discover card': ['credit_card', `Trans. Date,Post Date,Description,Amount,Category
10/14/2026,10/14/2026,NETFLIX.COM,15.49,Services
10/12/2026,10/12/2026,INTERNET PAYMENT - THANK YOU,-350.00,Payments and Credits`],
  'Discover Bank checking': ['checking', `Transaction Date,Transaction Description,Transaction Type,Debit,Credit,Balance
10/09/2026,NORTHWIND TECH PAYROLL,Deposit,,$3586.20,$7500.00
10/14/2026,NETFLIX.COM,Debit Card Purchase,$15.49,,$7484.51`],
  'Capital One card': ['credit_card', `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-10-14,2026-10-15,1234,NETFLIX.COM,Entertainment,15.49,
2026-10-12,2026-10-12,1234,CAPITAL ONE MOBILE PYMT,Payment/Credit,,350.00`],
  'American Express': ['credit_card', `Date,Description,Amount
10/14/2026,NETFLIX.COM,15.49
10/12/2026,AUTOPAY PAYMENT - THANK YOU,-350.00`],
  'Citi card': ['credit_card', `Status,Date,Description,Debit,Credit
Cleared,10/14/2026,NETFLIX.COM,15.49,
Cleared,10/12/2026,ONLINE PAYMENT THANK YOU,,-350.00`],
  'Wells Fargo (no header)': ['checking', `"10/09/2026","3586.20","*","","NORTHWIND TECH PAYROLL"
"10/14/2026","-15.49","*","","NETFLIX.COM"`],
  'US Bank': ['checking', `"Date","Transaction","Name","Memo","Amount"
"2026-10-09","CREDIT","NORTHWIND TECH PAYROLL","Download from usbank.com","3586.20"
"2026-10-14","DEBIT","NETFLIX.COM","Download from usbank.com","-15.49"`],
  'Ally Bank': ['checking', `Date, Time, Amount, Type, Description
2026-10-09, 06:00:00, 3586.20, Deposit, NORTHWIND TECH PAYROLL
2026-10-14, 09:12:00, -15.49, Withdrawal, NETFLIX.COM`],
  'Short dates (M/D/YY)': ['checking', `Date,Description,Amount
10/9/26,NORTHWIND TECH PAYROLL,3586.20
10/14/26,NETFLIX.COM,-15.49`],
};

const parse = (text, accountType) => new TransactionCSVParser().parse(text, 'test', { accountType });

for (const [bank, [accountType, csv]] of Object.entries(BANKS)) {
  test(`imports ${bank} exports with the right dates, signs and descriptions`, () => {
    const result = parse(csv, accountType);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(result.transactions.length, 2);
    const spend = result.transactions.find(t => /NETFLIX/.test(t.description));
    assert.deepEqual([spend.date, spend.direction, spend.amount], ['2026-10-14', 'DEBIT', 15.49]);
    const inflow = result.transactions.find(t => t !== spend);
    assert.equal(inflow.direction, 'CREDIT');
    if (accountType === 'credit_card') {
      assert.equal(inflow.amount, 350);
      assert.equal(inflow.categoryHint, 'Transfer', 'card payments must not count as income');
    } else {
      assert.equal(inflow.amount, 3586.2);
      assert.match(inflow.description, /NORTHWIND/);
      assert.equal(inflow.categoryHint, undefined);
    }
  });
}

test('card statements without a payment row fall back to the account type', () => {
  const positive = parse('Date,Description,Amount\n10/14/2026,NETFLIX.COM,15.49\n10/15/2026,SHELL OIL,42.10', 'credit_card');
  assert.deepEqual(positive.transactions.map(t => t.direction), ['DEBIT', 'DEBIT']);
  const negative = parse('Date,Description,Amount\n10/14/2026,NETFLIX.COM,-15.49\n10/15/2026,SHELL OIL,-42.10', 'credit_card');
  assert.deepEqual(negative.transactions.map(t => t.direction), ['DEBIT', 'DEBIT']);
});

test('handles parentheses, CR/DR markers, semicolons and quoted multiline fields', () => {
  const r = parse('Date;Description;Amount\n2026-10-14;"COFFEE\nSHOP";(4.50)\n2026-10-15;REFUND;12.00 CR', 'checking');
  assert.equal(r.transactions.length, 2);
  assert.deepEqual([r.transactions[0].direction, r.transactions[0].amount], ['DEBIT', 4.5]);
  assert.match(r.transactions[0].description, /COFFEE\s+SHOP/);
  assert.deepEqual([r.transactions[1].direction, r.transactions[1].amount], ['CREDIT', 12]);
});

test('parses OFX/QFX bank and card downloads, including SGML without closing tags', () => {
  const bank = `OFXHEADER:100
DATA:OFXSGML

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261009120000<TRNAMT>3586.20<NAME>NORTHWIND TECH PAYROLL
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261014<TRNAMT>-15.49<NAME>NETFLIX.COM<MEMO>Streaming
</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>7484.51<DTASOF>20261014</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const b = parse(bank);
  assert.equal(b.format.kind, 'ofx');
  assert.deepEqual(b.transactions.map(t => [t.date, t.direction, t.amount]), [
    ['2026-10-09', 'CREDIT', 3586.2], ['2026-10-14', 'DEBIT', 15.49],
  ]);
  assert.equal(b.transactions[1].balance, 7484.51);

  const card = `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261014</DTPOSTED><TRNAMT>-15.49</TRNAMT><NAME>NETFLIX.COM</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261012</DTPOSTED><TRNAMT>350.00</TRNAMT><NAME>PAYMENT RECEIVED</NAME></STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
  const c = parse(card);
  const payment = c.transactions.find(t => t.direction === 'CREDIT');
  assert.equal(payment.categoryHint, 'Transfer');
  assert.equal(c.transactions.find(t => t.direction === 'DEBIT').amount, 15.49);
});

test('files without transactions produce nothing instead of guessing', () => {
  const r = parse('hello world\nthis is not a statement', 'checking');
  assert.equal(r.transactions.length, 0);
});

test('multi-account TD CSV retains account identity and never deduplicates across accounts', () => {
  const result = parse(`Date,Bank RTN,Account Number,Description,Debit,Credit
10/14/2026,031201360,00001111,SAME PURCHASE,15.49,
10/14/2026,031201360,00002222,SAME PURCHASE,15.49,
10/14/2026,031201360,00001111,SAME PURCHASE,15.49,
10/15/2026,031201360,,UNIDENTIFIED PURCHASE,3,`, 'checking');
  assert.equal(result.transactions.length, 3);
  assert.equal(result.duplicates, 1);
  assert.equal(result.format.accountCount, 2);
  assert.deepEqual(result.format.accounts.map(account => account.last4), ['1111', '2222', null]);
  assert.notEqual(result.transactions[0].accountKey, result.transactions[1].accountKey);
  assert.equal(result.transactions[2].accountKey, 'unidentified');
  assert.doesNotMatch(JSON.stringify(result), /00001111|00002222/, 'full account numbers are not returned');
});

test('sign conventions and card hints are resolved separately for each mapped account', () => {
  const csv = `Date,Account Number,Description,Amount
2026-10-14,00001111,DEPOSIT,100
2026-10-15,00001111,DEPOSIT,200
2026-10-14,00002222,SHOP ONE,10
2026-10-15,00002222,SHOP TWO,20`;
  const preliminary = parse(csv);
  const [bank, card] = preliminary.format.accounts;
  const result = new TransactionCSVParser().parse(csv, 'mixed.csv', {
    accountTypes: { [bank.key]: 'savings', [card.key]: 'credit_card' }
  });
  assert.deepEqual(result.transactions.map(row => row.direction), ['CREDIT', 'CREDIT', 'DEBIT', 'DEBIT']);
  assert.equal(result.format.signConvention, 'per-account');
});

test('different full account numbers with the same ending retain separate mapping keys', () => {
  const result = parse('Date,Account Number,Description,Debit\n2026-10-14,10001111,SHOP,10\n2026-10-14,20001111,SHOP,10');
  assert.equal(result.transactions.length, 2);
  assert.equal(result.format.accounts.length, 2);
  assert.notEqual(result.format.accounts[0].key, result.format.accounts[1].key);
});

test('OFX uses its account identity and rejects multi-account files instead of merging them', () => {
  const statement = '<STMTRS><BANKACCTFROM><ACCTID>00001111</BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20261014<TRNAMT>-15<NAME>SHOP</STMTTRN></BANKTRANLIST></STMTRS>';
  const result = parse(`<OFX>${statement}</OFX>`);
  assert.equal(result.format.accounts[0].last4, '1111');
  assert.equal(result.transactions[0].accountKey, result.format.accounts[0].key);
  const multi = parse(`<OFX>${statement}${statement.replace('00001111', '00002222')}</OFX>`);
  assert.equal(multi.transactions.length, 0);
  assert.match(multi.errors[0], /Multi-account OFX/);
});
