# PDF statement imports

## Importing a statement

1. Open **Import statements**, choose the account (or create one), and select **PDF**.
2. Upload one original, text-based statement per file, no larger than 12 MB or
   100 pages. Use **Credit card** for card statements, **Checking** or **Savings**
   for deposit accounts.
3. The server detects the document type from its contents, not its filename or a
   manually selected PDF template. A mismatched account type or account ending
   stops the import without saving anything.
4. Review the result: detected type, statement closing date, closing balance,
   purchase APR if available, imported count, duplicates, and warnings.

Required-account validation errors appear inside the dialog. During import an
animated, indeterminate progress bar shows reading and server-processing stages;
it does not claim a percentage the server cannot measure. The final result stays
available when the dialog is closed and reopened. Closing clears an idle PDF
selection, but an active import continues and retains its status. Failed uploads
keep the file selected for retry until the dialog is closed. Requests time out
after two minutes; if connectivity fails or the outcome is unknown, check Accounts
and Transactions before retrying (matching PDF transactions are deduplicated).

The parser reads `New Balance` / `New Statement Balance` for credit cards,
not available credit, a minimum payment, or an example repayment amount.
It captures the **purchase** APR, not the cash advance or balance-transfer APR.
Multiple purchase rates are reported for review instead of silently choosing one.
Statement balance, closing date, minimum payment, due date and credit limit are
saved on the account. Accounts displays the latest statement facts; older imports
cannot overwrite newer statement evidence. Separately entered debt-plan records
are **not** overwritten or automatically created. Review those before forecasting.

## What is checked

- Full dates and yearless dates are validated against the statement period;
  December/January rollover uses the statement's year, not the current year.
- Reference numbers, transaction/posting dates, wrapped descriptions, amounts
  on subsequent lines, currency symbols, negative signs, trailing minus signs,
  parentheses and `CR`/`DR` suffixes are handled. Posting dates are used when both
  dates are printed.
- Card purchases, payments, refunds/reward credits, fees and interest are
  distinguished. Zero-dollar informational rows are not transactions.
- Bank transaction directions come from explicit debit/credit columns,
  deposit/withdrawal sections, signed amounts, or verified running-balance
  changes. Ambiguous directions are rejected rather than guessed.
- All arithmetic reconciliation uses integer cents. Opening balance plus net
  activity must equal closing balance. Recognized summary totals (purchases,
  payments, credits, fees, interest, deposits and withdrawals) must also match.
  A mismatch, conflicting summary, invalid dated row, unreadable amount, or
  missing required balance/date blocks the entire import.
- An explicit zero-activity statement can update account facts without creating
  a fake transaction. A document that merely produces zero parsed rows cannot
  report an ordinary successful import.
- Reimports are scoped to the selected account. Repeated identical legitimate
  PDF rows are retained by occurrence count; uploading the same statement again
  skips those occurrences, including mixed-case interest descriptions.
- Transactions, new account creation, metadata and transfer reconciliation
  commit atomically. Batch imports are all-or-nothing.

Checking-account statement balances participate in spendable cash, even when a
statement has no transactions. Cards, loans and savings never inflate that cash
balance. Newer transaction-level balance evidence still takes precedence over an
older statement.

## Explicit limitations and recovery

No finite text parser can guarantee every issuer's layout. This implementation
does **not** perform OCR or upload statements to external services. Image-only
scans, locked/encrypted PDFs requiring a password, corrupted PDFs, unsupported
layouts, ambiguous columns and unreconciled statements produce actionable errors.
Use an unlocked original downloaded statement or the bank's **CSV/OFX/QFX** export.
Do not bypass reconciliation or count a partial extraction as a complete import.

## API

Authenticated, same-origin `POST /api/import/import-pdf`:

```json
{
  "pdfBase64": "<raw base64, without a data URL prefix>",
  "source": "statement.pdf",
  "accountId": 123
}
```

Alternatively send `newAccount` with `name`, `kind`, optional `last4` and
`institution`. Legacy `statementType` hints are ignored; content detection wins.
Success includes `imported`, `duplicates`, `totalInFile`, `account`, `statement`,
`reconciliation` and `warnings`. Invalid uploads/account choices return 400;
unsupported/unverifiable statements return 422. No account or financial rows are
saved on failure.

For `POST /api/import/import-batch`, each file has `type: "pdf"`, `data` containing
raw base64, optional `source`, and its account choice (or a top-level default).
Each result includes the same statement/reconciliation facts.

## Implementation and tests

- [PDF parser](backend/utils/pdfParser.js): installed `pdf-parse` v2 `PDFParse`
  API; PDF resources are destroyed after extraction.
- [Import routes](backend/routes/import.js): validated decoding, reconciliation,
  account validation, persistence and duplicate handling.
- [Parser fixtures/tests](backend/utils/pdfParser.test.js): synthetic, generated
  real PDFs, multipage extraction, both account types, dates/signs/columns,
  reconciliation and explicit failures.
- [HTTP tests](backend/utils/pdf-import.test.js): isolated embedded PostgreSQL;
  repeated imports, same-day identical purchases, account isolation, rollback,
  historical statements, metadata and spendable balances.

Run `node --test backend\utils\pdfParser.test.js backend\utils\pdf-import.test.js`
or `npm test`. No test needs or changes a live financial database. Customer PDFs
must not be committed as fixtures.
