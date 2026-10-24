# Transaction Import System - Documentation

## Overview

MyFinanceApp imports account-scoped CSV/OFX/QFX and PDF statements into PostgreSQL.

## Import history and recovery

Open **Import a statement > Import history & recovery**. **Active imports** contains
Undo candidates; **Undone / Restore backups** contains only Restore candidates.
An undone import cannot be selected for Undo, and duplicate-only imports without
statement changes have no selection control.

Review filenames, account names, timestamps and transaction counts. Select individual
imports or enter a number from 1 to 100 and choose **Select recent**, then **Review undo**.
Selection and review do not commit financial changes. The server validates the exact
operation, including restore and statement conflicts, and returns an impact summary:
affected files/accounts, transaction counts, remaining transaction count and limitations.
Check **I understand this impact and want to proceed**, then **Confirm undo**.
Restore follows the same review, acknowledgement and **Confirm restore** flow.
Cancelling, changing mode, refreshing or changing the selection discards the review.

- Every successful account group in a CSV, PDF, or batch-file import has its own
  persistent batch ID. A multi-account CSV produces one batch per destination
  account, so its accounts can be diagnosed or undone independently.
  Rejected imports leave no transactions, new accounts or batch records.
- Undo saves the current rows in a private, server-side database backup before removing
  them, atomically. Restore preserves IDs, original timestamps, manual categories,
  fixed/payment/income flags and display names. Duplicate rows skipped by the import
  belong to earlier history and are never removed.
- Verified PDF statement facts (balance, APR, due date, etc.) are tracked before and
  after import. Undo/restore checks the account's current statement and rejects
  conflicting changes. Undo newer statement changes first; restore older ones first.
  Multi-selection orders operations automatically and is all-or-nothing.
- Transfer pairing and spending/income classification are recalculated after recovery.
  Accounts, account identity/type edits, merchant rules and manually entered debt
  plans are retained; recovery is not a full-workspace rollback.
- Backups are retained until restored, including across application restarts. A later
  Undo saves a fresh snapshot. There is no automatic expiry. These backups live in
  the same database; they do not replace independent database disaster-recovery backups.
- Restoring an import whose rows were reimported is rejected to prevent double counting.
  Deleted referenced accounts/labels must be addressed by reimporting the original file.
- The startup migration recovers older import boundaries only when rows have a saved
  timestamp and an import-like source. Groups use the exact timestamp, source and
  account. They are explicitly marked **Older inferred import**: timestamps may not
  represent an entire original upload, and previous PDF statement facts were not
  recorded. Such recovery is transaction-only. Rows without a reliable boundary are
  counted as untracked and left untouched.
- History and backups use the same tenant row-level security as transactions.
  Recovery is audited; read-only support sessions cannot undo or restore.

### Current API

- `POST /api/import/inspect-csv`: `csvData` and `source`. Returns masked account
  groups, opaque mapping keys, row counts, and unique saved-account matches.
  This read-only step creates no accounts, transactions, or import batches.
- `GET /api/accounts/import-options`: lightweight account identity/type choices
  for the import UI. Unlike the Accounts overview, it does not read transaction
  history or calculate balances.
- `POST /api/import/import-csv`: `csvData`, `source`, and optional `accountMappings`.
  Accounts detected from the file are matched to saved accounts first. Unmatched,
  ambiguous, or unidentified groups return `422 ACCOUNT_REVIEW_REQUIRED` with
  `detectedAccounts`; nothing is imported. Map each unresolved group by its
  inspection `key` to `{accountId: 123}` or
  `{newAccount: {name: "TD savings", kind: "savings", institution: "TD Bank"}}`.
  The detected last four digits are applied to a new account automatically.
  Legacy `accountId`/`newAccount` are supported for single-account files and
  unidentified rows, but cannot collapse a multi-account file into one account.
- `POST /api/import/import-pdf`: `pdfBase64`, `source`, and optional account choice
  (otherwise the verified PDF identity is used).
- `POST /api/import/import-batch`: per-file account detection/mappings and one batch
  per destination group; the whole request commits atomically.
- `GET /api/import/history`: batch summaries plus an `untracked` transaction count.
  No raw backup transaction data is sent with the history list.
- `POST /api/import/history/review`: `{ "ids": [123, 124], "action": "undo" }`
  (or `"restore"`), 1-100 distinct IDs. Runs the exact recovery path inside a
  savepoint and rolls it back, then saves a private, hashed, single-use review token
  with a five-minute expiry. Financial state is unchanged by review.
- `POST /api/import/history/undo` and `/restore` require
  `{ "ids": [123, 124], "reviewToken": "<from review>", "acknowledged": true }`.
  The server verifies tenant, selection, action, expiry and a fingerprint of the
  financial state under row locks, then revalidates and commits atomically.
  Replayed tokens, intervening edits/imports, stale status, statement changes and
  restore conflicts return HTTP 409. Missing review/acknowledgement returns HTTP 400.
  Tokens are database-backed and work across server instances and restarts.

### Automatic account mapping (including TD multi-account CSVs)

Choose a CSV and click **Import transactions**. The importer reads the account-number
column (for example TD's `Account Number`) and separates the rows by account.
When every group uniquely matches a saved account ending, the import proceeds
without a global account picker. Otherwise **Review account mapping** lets you
choose an existing account or name and create each new account, including its
type. Click **Import transactions** again to confirm. Later imports use those
saved accounts automatically when the endings are unambiguous.

An account's type controls sign interpretation, so each group is parsed using its
own mapped account type. Identical transactions in different accounts are not
deduplicated against each other. All groups save in one database transaction:
invalid mappings or a failed group roll back the whole upload, including new
accounts. Results show imported/duplicate counts per account.

Missing account numbers require an explicit fallback choice; they are never
copied from adjacent rows or inferred from transfer descriptions. Filenames are
not authoritative for CSV mapping. A selected account with a different saved
ending is rejected. Explicitly selecting an existing account without a saved
ending records the detected ending for future matching.

Only last-four endings and opaque grouping keys, never full account numbers,
appear in parser/inspection metadata. Saved identities currently use last-four
digits: multiple saved accounts with the same ending, or different full numbers
in one file with the same ending, require explicit mapping rather than a guess.
Such ambiguities must be reviewed again on later uploads.

Single-account OFX/QFX uses its `ACCTID` for mapping. Multi-account OFX is rejected
instead of merging accounts; export separate OFX files or a multi-account CSV.
PDF matching and statement validation retain their existing behavior.

### Overlap protection for older unassigned history

Repeated rows are matched within the signed-in user's destination account by
date, normalized original description (case and whitespace), direction and amount
at cent precision, including older floating-point amount columns. Existing rows
and their saved edits are retained. Identical transactions in two different
assigned accounts remain independent.

If a row has no same-account match but matches an older transaction with no
account, the upload returns **409 `UNASSIGNED_OVERLAP`**. Nothing in that upload
is committed, including earlier rows, newly created accounts and import batches.
The importer does not guess ownership, silently merge rows or count an ambiguous
match as a successfully skipped duplicate.

Review the older unassigned source in **Accounts**. Source-level assignment is
appropriate only when **every unassigned row from that source belongs to that
account**. Do not bulk-assign a mixed-account export. Resolve its mapping first,
then retry; correctly assigned matching rows will be reported as duplicates.
This safeguard prevents new repeats but does not remove existing duplicates.

### Import-focused troubleshooting

Open **Advanced diagnostics > Transaction troubleshooting**. Import choices
refresh on entry and are invalidated after a successful upload, undo or restore.
Import metadata loads in pages of 30; no transaction rows load until an import
is selected, and its transactions load in pages of 50. Older history without a
reliable import boundary remains available separately. Loading errors are shown
explicitly; use **Refresh** to retry.

### Correcting an overlapping or misassigned CSV import

1. Confirm the affected filenames, timestamps and destination accounts in history.
2. Review and confirm Undo only for the problematic imports. Do not delete older imports just because the
   same filename appears again.
3. Review detected account mappings; correct the account and type for each group.
4. Reimport the corrected exports and review skipped duplicates and totals. Existing
   deduplication compares account, date, direction, amount and normalized description;
   differently worded CSV and PDF rows may still require manual duplicate review.
5. Review **Accounts** for transfer ownership. Card/loan payments on imported accounts
   should be transfers; purchases, fees and interest remain ordinary transactions.
   If the result is worse, undo the replacement before restoring the original import.

### Validation

`npm test` includes synthetic HTTP tests covering atomic undo/restore, statement
conflicts, multi-file boundaries, duplicate protection, legacy migration, row-level
isolation and UI controls. Optional local-only CSV verification is available through
`CSV_RECOVERY_TEST_FILES` (a JSON array of `{path, kind, last4, expectedRows}`; add
`status: 422` for a rejected file), running
`node --test backend/utils/import-history.test.js`. It uses an isolated PGlite
database and never writes to the configured live PostgreSQL database.

## Historical import implementation notes

The sections below describe the earlier SQL-fixture importer, not the current UI/API.
Shared fixture import endpoints are now disabled; use the account-scoped API above.

## Features

✅ **Automatic CSV Column Detection** - Works with any CSV format  
✅ **Intelligent Auto-Categorization** - 13+ transaction categories  
✅ **Deduplication** - Prevents duplicate imports within and across files  
✅ **Special Character Handling** - Properly escapes all SQL strings  
✅ **NULL Value Support** - Handles missing balance fields  
✅ **Detailed Logging** - Every operation is logged  
✅ **Error Recovery** - Graceful failures with clear error messages  
✅ **Batch Processing** - Transaction-level commit/rollback  

## Files Created

### Core Files

1. **`/backend/utils/transaction-parser.js`**
   - `TransactionCSVParser` class for CSV parsing
   - `categorizeTransaction()` for intelligent categorization
   - `generateInsertSQL()` for SQL statement generation
   - Regex patterns for 13+ transaction categories

2. **`/backend/routes/bulk-import.js`**
   - `POST /api/import-sql` - Main import endpoint
   - `POST /api/import-csv` - CSV upload endpoint (future)
   - `GET /api/import-stats` - Statistics and status
   - Comprehensive error handling
   - Detailed operation logging

3. **`/backend/data/import_final.sql`**
   - 188 pre-generated INSERT statements
   - All special characters properly escaped
   - Ready for direct database import
   - Generated from 2 TD Bank CSV files

### Utility Scripts

4. **`/scripts/generate-import.js`**
   - Parses both CSV files
   - Generates SQL import file
   - Creates validation report
   - Deduplicates transactions

5. **`/scripts/validate-sql.js`**
   - Validates SQL syntax
   - Checks field counts
   - Verifies statement structure

## Data Processing

### Input
- `doc_64818b08137d_transactions (4).csv` - 158 lines (157 transactions)
- `doc_7186bb17cca9_transactions (5).csv` - 33 lines (32 transactions)
- **Total: 189 transactions**

### Output
- **188 unique transactions** (1 duplicate within File 1 removed)
- 13 categories auto-assigned
- 169 DEBIT + 19 CREDIT transactions
- Date range: 2026-05-05 to 2026-06-02

### Category Distribution
```
Shopping          : 90
Transfer          : 60
Transportation    :  9
Dining            :  6
Payment           :  6
Groceries         :  4
Income            :  4
Healthcare        :  2
Gas               :  2
Fee               :  2
Insurance         :  1
Entertainment     :  1
Utilities         :  1
```

## Usage

### 1. Using the Pre-Generated SQL File

```bash
# The SQL file is already generated and ready to use
# It contains all 188 transactions with proper formatting

cat /opt/data/myfinanceapp-v2/backend/data/import_final.sql | psql <DATABASE_URL>
```

### 2. Using the API Endpoint

```bash
# Start the server first
cd /opt/data/myfinanceapp-v2
npm start

# Then import via API
curl -X POST http://localhost:3000/api/import-sql

# Response:
{
  "success": true,
  "executed": 188,
  "failed": 0,
  "duplicates": 0,
  "newTransactions": 188,
  "totalInDatabase": 188,
  "duration": "0.45s",
  "message": "Import complete: 188 transactions inserted, 188 new to database"
}
```

### 3. Checking Import Status

```bash
curl http://localhost:3000/api/import-stats

# Response:
{
  "success": true,
  "totalTransactions": 188,
  "categories": {
    "Shopping": 90,
    "Transfer": 60,
    ...
  },
  "directions": {
    "DEBIT": 169,
    "CREDIT": 19
  },
  "dateRange": {
    "earliest": "2026-05-05",
    "latest": "2026-06-02"
  }
}
```

## Database Schema

```sql
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  date TEXT,                    -- YYYY-MM-DD format
  description TEXT,             -- Cleaned, max 500 chars
  category TEXT,                -- Auto-assigned category
  amount REAL,                  -- Absolute value
  direction TEXT,               -- 'DEBIT' or 'CREDIT'
  balance REAL,                 -- Account running balance or NULL
  source TEXT,                  -- 'TD Bank CSV Import'
  user_id INTEGER               -- Always 1 for now
);
```

## Key Implementation Details

### CSV Parsing
- Handles quoted fields with commas
- Detects column positions automatically
- Supports YYYY-MM-DD and MM/DD/YYYY date formats
- Normalizes whitespace in descriptions
- Validates all dates before insertion

### Categorization
Pattern-based categorization using regex:
- Groceries: Whole Foods, Kroger, Instacart, etc.
- Dining: Restaurant, DoorDash, UberEats, Starbucks, etc.
- Shopping: Target, Walmart, Amazon, Best Buy, etc.
- Utilities: Electric, Water, Internet, Verizon, etc.
- Transfer: Zelle, Venmo, PayPal transfers, etc.
- And 8 more categories...

### SQL Safety
- All strings escaped with `''` for single quotes
- NULL values properly handled (not quoted)
- Numeric values unquoted
- Parameterized queries in API endpoint
- Transaction-level commit/rollback

### Error Handling
- File read errors → 500 response
- Database connection errors → 500 response
- Invalid CSV → clear error message
- Duplicate transaction → logged but not failed
- Per-transaction error capture and reporting

## Validation Results

✅ **188/188 INSERT statements** - 100% valid
✅ **All dates validated** - No parsing errors
✅ **All amounts parsed** - Handles decimals and negatives
✅ **All characters escaped** - Ready for SQL execution
✅ **NULL values handled** - For missing balance fields
✅ **Categories assigned** - 13 different categories
✅ **Duplicates removed** - Cross-file deduplication
✅ **Transaction integrity** - ACID compliance

## Logging

Every operation is logged with timestamps and details:

```
[2026-06-04T11:59:30.678Z] [PARSER] Detected columns: {...}
[2026-06-04T11:59:30.679Z] [PARSER] Processing 157 transaction rows
[2026-06-04T11:59:30.682Z] [PARSER] Duplicate detected: ETSY COM...
[2026-06-04T11:59:30.687Z] [PARSER] ✓ Parsed 156 transactions, 1 duplicates
```

## Edge Cases Handled

1. **Duplicate transactions within file** → Detected and logged
2. **Missing balance field** → Stored as NULL
3. **Special characters in description** → Properly escaped
4. **Decimal amounts** → Parsed correctly
5. **Empty debit/credit fields** → Correctly interpreted
6. **Various date formats** → Auto-detected and normalized
7. **Transaction type variations** → DEBIT, CREDIT, XFER, FEE handled
8. **Whitespace normalization** → Multiple spaces condensed

## Performance

- **Parsing**: 189 transactions in ~5ms
- **Categorization**: 189 transactions in ~1ms
- **SQL generation**: 188 statements in ~2ms
- **Database import**: 188 transactions in ~0.5s
- **Total pipeline**: < 1 second

## Testing

```bash
# Generate import file
node scripts/generate-import.js

# Validate SQL syntax
node scripts/validate-sql.js

# Run API tests
curl -X GET http://localhost:3000/api/import-stats
curl -X POST http://localhost:3000/api/import-sql
```

## Future Enhancements

- [ ] PDF statement parsing
- [ ] CSV file upload endpoint
- [ ] Scheduled automatic imports
- [ ] Duplicate detection across multiple accounts
- [ ] Custom category rules per user
- [ ] Transaction matching with credit cards
- [ ] Budget tracking and alerts

## Troubleshooting

### Import fails with "Cannot read SQL file"
- Check file path: `/opt/data/myfinanceapp-v2/backend/data/import_final.sql`
- Verify file permissions: `ls -la backend/data/`
- File should be ~42KB with 188 INSERT statements

### Import partially succeeds
- Check error details in response
- Verify database connection
- Check for duplicate prevention logic
- Review logs for specific error messages

### Categorization seems wrong
- Check regex patterns in `transaction-parser.js`
- Review description parsing (may contain extra spaces)
- Update patterns based on your specific merchant names

---

**Last Updated**: 2026-06-04  
**Status**: ✅ Production Ready  
**Tested**: Yes - All 188 transactions validated
