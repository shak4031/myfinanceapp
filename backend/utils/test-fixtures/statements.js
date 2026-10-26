// Synthetic statements only: no customer documents or account data.
export const cardLines = [
  'EXAMPLE CREDIT CARD STATEMENT',
  'Account Number 4000 0000 0000 1111',
  'September 04, 2026 to October 03, 2026',
  'Previous Balance $100.00',
  'Payments - $30.00',
  'Other Credits - $5.00',
  'Purchases + $40.00',
  'Balance Transfers + $0.00',
  'Cash Advances + $0.00',
  'Fees Charged + $3.00',
  'Interest Charged + $2.00',
  'New Balance $110.00',
  'Credit Limit $500.00',
  'Statement Closing Date 10/03/26',
  'Minimum Payment Due $25.00',
  'Payment Due Date 10/28/26',
  '73793000000000001 09/10 09/11 SAMPLE MARKET 20.00',
  '73793000000000002 09/10 09/11 SAMPLE MARKET 20.00',
  '73793000000000003 09/28 09/28 PAYMENT - AUTOPAY $30.00-',
  '73793000000000004 09/29 09/29 REWARD CREDIT -5.00',
  '10/03 10/03 MONTHLY FEE 3.00',
  '10/03 10/03 Interest Charge on Purchases 2.00',
  '10/03 10/03 Interest Charge on Cash Advances 0.00',
  'Total interest charged in 2026 $42.00',
  'New Balance: $110.00',
  'TRANSACTIONS',
  'Payments, Credits, and Adjustments',
  'Reference Number Trans Date Post Date Description of Transaction or Credit Amount',
  'INTEREST CHARGE CALCULATION',
  'Purchases 24.99%(v) $100.00 $2.00',
  'Cash Advances 29.99%(v) $0.00 $0.00'
];
export const bankLines = [
  'EXAMPLE BANK CHECKING STATEMENT',
  'Account Number Ending 2222',
  '09/01/2026 through 09/30/2026',
  'Beginning Balance $100.00',
  'Deposits and Credits $200.00',
  'Withdrawals and Debits $50.00',
  'Ending Balance $250.00',
  'Date Description Amount Balance',
  '09/05 PAYROLL DEPOSIT 200.00 300.00',
  '09/06 SAMPLE MARKET 50.00 250.00'
];

export function statementPDF(pages) {
  if (typeof pages[0] === 'string') pages = [pages];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  for (const lines of pages) {
    const stream = `BT /F1 9 Tf 36 756 Td 12 TL\n${lines.map(line => `(${line.replace(/[\\()]/g, '\\$&')}) Tj T*`).join('\n')}\nET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
