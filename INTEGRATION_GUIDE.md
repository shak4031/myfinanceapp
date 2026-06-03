# PDF Statement Import - Integration Guide

## Installation & Setup

### Step 1: Install PDF Parsing Dependencies

```bash
cd /opt/data/myfinanceapp-v2
npm install pdfjs-dist pdf-parse
```

### Step 2: Verify Package.json Updated

```json
{
  "dependencies": {
    "pdfjs-dist": "^6.0.0",
    "pdf-parse": "^1.1.1",
    // ... other dependencies
  }
}
```

### Step 3: Verify Backend Files

Files to check/update:
- ✅ `backend/routes/import.js` - Updated with PDF endpoints
- ✅ `backend/utils/pdfParser.js` - New PDF parser module
- ✅ `backend/server.js` - Already uses import router

### Step 4: Update Frontend

Replace the import modal in `frontend/index.html`:
- Find and remove old `CSV_IMPORT_MODAL.html` content
- Insert content from `IMPORT_MODAL_ENHANCED.html`

Or include as separate file:
```html
<!-- In index.html, before closing </body> -->
<iframe src="IMPORT_MODAL_ENHANCED.html" style="display:none;"></iframe>
<!-- Or include the HTML directly -->
```

### Step 5: Database Verification

Ensure transactions table has required columns:

```sql
-- Connect to PostgreSQL on Railway
psql postgresql://user:pass@host:5432/myfinanceapp

-- Check table structure
\d transactions

-- Required columns:
-- - date (DATE)
-- - description (VARCHAR)
-- - category (VARCHAR)
-- - amount (NUMERIC)
-- - direction (VARCHAR - 'debit' or 'credit')
-- - balance (NUMERIC)
-- - user_id (INTEGER)
-- - source (VARCHAR)

-- Add source column if missing
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source VARCHAR(50);
```

### Step 6: Restart Application

```bash
npm run dev
# Server should start on http://localhost:3000
```

### Step 7: Verify Installation

Test endpoints:
```bash
# Test PDF import endpoint
curl http://localhost:3000/api/import/import-pdf -X POST \
  -H "Content-Type: application/json" \
  -d '{"pdfData":"test","source":"td-checking","fileName":"test.pdf"}'

# Should return JSON (will fail with invalid PDF, but confirms endpoint)
```

## Frontend Integration

### Updating Import Button

Make sure your import button calls the updated modal:

```html
<!-- In your dashboard or nav -->
<button onclick="openImportModal()">📥 Import Statements</button>
```

### CSS Requirements

Modal uses inline styles. If you want custom styling, add to your CSS:

```css
/* Optional: Custom styling for import modal */
#importModal {
  z-index: 1000;
  backdrop-filter: blur(5px);
}

#importModal > div {
  max-width: 600px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}
```

### JavaScript Functions Available

After including the modal:

```javascript
// Open the import modal
openImportModal()

// Close the import modal
closeImportModal()

// Switch between tabs
switchTab('csv')  // or 'pdf'

// Trigger import (auto-detects tab)
handleImport()

// Process CSV (called automatically)
handleCSVImport()

// Process PDF (called automatically)
handlePDFImport()
```

## Testing the Implementation

### Test 1: CSV Import (Existing Feature)

1. Create test CSV file `test.csv`:
```csv
Date,Description,Debit,Credit,Balance
06/01/2024,STARBUCKS,5.67,,1234.56
06/02/2024,PAYCHECK,,2500.00,3734.56
```

2. Open Import Modal → CSV tab
3. Select source: "TD Bank - Checking"
4. Choose `test.csv`
5. Click "Import CSV"
6. Verify: "✓ Import Complete!"

### Test 2: PDF Import (New Feature)

1. Obtain a sample PDF statement from your bank
2. Open Import Modal → PDF tab
3. Select source matching your statement type
4. Upload PDF file
5. Click "Import PDF"
6. Watch progress bar fill
7. Verify success message

### Test 3: Batch Import

1. Prepare 3-5 PDF files from different dates
2. Open Import Modal → PDF tab
3. Click file input and select multiple PDFs
4. Watch file list update with all selected files
5. Click "Import PDF"
6. Monitor progress and per-file results
7. Check detailed file results in summary

### Test 4: Duplicate Detection

1. Import same PDF twice
2. Second import should show increased "Duplicates" count
3. No new transactions added to database

### Test 5: Error Handling

1. Try uploading non-PDF file (.txt, .jpg)
2. Should show error: "PDF extraction failed"
3. Try malformed file
4. Should show: "Error processing file"

## Workflow: Daily Statement Import (7-Day Rolling Window)

### Recommended Process

```
Daily (Evening):
1. Download statement PDF from bank
2. Open app → Click "Import Statements"
3. Select PDF tab → Choose statement type
4. Upload PDF file → Click Import
5. Review summary → Check for duplicates
6. Close modal → Dashboard refreshes

Weekly (Sunday):
1. Collect last 7 days of PDFs
2. Open app → Import Statements
3. Select all 7 PDFs at once
4. Review batch summary
5. Check categorization accuracy

Monthly:
1. Archive imported statements
2. Review categorization rules
3. Adjust if needed
4. Plan next month's budget
```

### Automation Possibilities

Future enhancement: Scheduled imports
```bash
# Run daily at 8 AM
0 8 * * * /usr/bin/node /path/to/daily-import.js

# Pulls statements from email/cloud
# Imports automatically
# Sends summary notification
```

## Monitoring & Troubleshooting

### Check Application Logs

```bash
# View recent logs
curl http://localhost:3000/api/logs

# Should show entries like:
# PDF_IMPORT: Extracted 1234 characters from PDF
# PDF_IMPORT: Parsed transaction: STARBUCKS COFFEE (5.67)
# PDF_IMPORT: ✓ Complete: 25 imported, 2 duplicates, 0 errors
```

### Database Verification

```sql
-- Count imported transactions
SELECT COUNT(*) FROM transactions WHERE source IN ('td-checking', 'td-savings', 'credit-card');

-- Check date range
SELECT MIN(date), MAX(date) FROM transactions;

-- Review recent imports
SELECT date, description, amount, direction, source 
FROM transactions 
WHERE source IN ('td-checking', 'td-savings', 'credit-card')
ORDER BY date DESC 
LIMIT 20;

-- Check categorization
SELECT category, COUNT(*) 
FROM transactions 
WHERE source IN ('td-checking', 'td-savings', 'credit-card')
GROUP BY category;
```

### Common Issues & Solutions

**Issue: "PDF extraction failed"**
```
Cause: Invalid or corrupted PDF
Solution: 
  1. Verify PDF opens in Adobe Reader or browser
  2. Try re-downloading from bank's website
  3. Check file isn't password protected
  4. Ensure not a scanned/image-only PDF
```

**Issue: No transactions imported**
```
Cause: PDF format not recognized
Solution:
  1. Verify correct source type selected
  2. Check PDF has standard bank statement format
  3. Review logs at /api/logs for parsing errors
  4. Try with sample PDF from bank's website
```

**Issue: Many duplicates**
```
Cause: Statement already imported
Solution:
  1. Check if date range overlaps previous imports
  2. Verify source is same as previous
  3. Clear duplicates manually if needed
  4. Use separate sources for separate account types
```

**Issue: Slow performance**
```
Cause: Large PDF files or slow database
Solution:
  1. Split batch into smaller groups (max 5 PDFs)
  2. Check database connection status
  3. Verify PostgreSQL is responding
  4. Check available memory (min 512MB)
```

## Performance Tuning

### Database Optimization

```sql
-- Add index for duplicate detection
CREATE INDEX IF NOT EXISTS idx_txn_dedup 
ON transactions(date, description, amount, direction);

-- Add index for source queries
CREATE INDEX IF NOT EXISTS idx_txn_source 
ON transactions(source);

-- Add index for date range queries
CREATE INDEX IF NOT EXISTS idx_txn_date 
ON transactions(date DESC);
```

### Memory Management

```javascript
// In backend/server.js, monitor memory:
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`Memory: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
}, 10000);
```

### Batch Processing Limits

Recommended settings:
- Max files per batch: 10
- Max file size: 10MB
- Max transactions per import: 1000

## Security Considerations

### Input Validation

✅ Already implemented:
- PDF buffer validation
- Base64 decoding safety
- SQL injection prevention (parameterized queries)
- File size checks

### Data Protection

✅ Already implemented:
- User-specific transactions (user_id field)
- Source tracking for audit
- Duplicate detection prevents data loss
- Balance verification possible

### Future Security

Consider:
- Authentication for import endpoints
- Role-based access control
- Encrypted PDF support
- Audit logging for sensitive operations

## Customization

### Adding New Bank Formats

1. Update `PDFParser` in `backend/utils/pdfParser.js`:

```javascript
// Add new parsing method
parseBankNameFormat(parts, transaction) {
  // Implement bank-specific parsing logic
}

// Add to parseTransactionLine
if (statementType === 'bank-name') {
  this.parseBankNameFormat(parts, transaction);
}
```

2. Update import modal:

```html
<!-- Add to source select -->
<option value="bank-name">Bank Name - Checking</option>
```

3. Add categorization rules if needed

### Customizing Categories

Edit `categorizeTransaction()` in `backend/routes/import.js`:

```javascript
function categorizeTransaction(description) {
  const desc = description.toUpperCase();
  
  // Add your custom rules
  if (desc.includes('MY_VENDOR')) return 'my-category';
  
  // ... rest of categorization
}
```

## Advanced Features

### Scheduled Auto-Import

Create `backend/workers/importScheduler.js`:

```javascript
import cron from 'node-cron';

// Run every morning at 8 AM
cron.schedule('0 8 * * *', async () => {
  // Fetch from email/cloud
  // Process PDFs
  // Send summary
});
```

### Receipt Linking

Enhance to attach receipts to transactions:

```javascript
// In transaction import
const receipt = await uploadReceiptFile(pdf);
transaction.receipt_id = receipt.id;
transaction.receipt_url = receipt.url;
```

### Smart Deduplication

Improve duplicate detection:

```javascript
// Fuzzy matching instead of exact
const similarity = calculateSimilarity(desc1, desc2);
if (similarity > 0.85) { /* likely duplicate */ }
```

## Deployment Checklist

- [ ] Install dependencies: `npm install pdfjs-dist pdf-parse`
- [ ] Update `backend/routes/import.js`
- [ ] Add `backend/utils/pdfParser.js`
- [ ] Update frontend modal
- [ ] Test CSV import still works
- [ ] Test single PDF import
- [ ] Test batch PDF import
- [ ] Verify database schema
- [ ] Check logs for errors
- [ ] Monitor performance
- [ ] Document any custom configurations
- [ ] Train users on PDF import workflow
- [ ] Set up daily import routine

## Documentation Files Reference

| File | Purpose |
|------|---------|
| `PDF_IMPORT_GUIDE.md` | Complete technical documentation |
| `IMPORT_MODAL_ENHANCED.html` | Frontend import modal component |
| `backend/utils/pdfParser.js` | PDF parsing engine |
| `backend/routes/import.js` | Import API endpoints |
| `PDF_IMPORT_TESTS.js` | Test suite and examples |
| `INTEGRATION_GUIDE.md` | This file - setup and configuration |

## Quick Reference

### API Endpoints

```
POST /api/import/import-csv      - Single CSV import
POST /api/import/import-pdf      - Single PDF import  
POST /api/import/import-batch    - Multi-file batch import
GET  /api/logs                   - View import logs
```

### Import Status Response

```json
{
  "success": true,
  "imported": 25,
  "duplicates": 2,
  "errors": 1,
  "total": 28
}
```

### Database Schema

```sql
transactions (
  id SERIAL PRIMARY KEY,
  date DATE,
  description VARCHAR(255),
  category VARCHAR(50),
  amount DECIMAL,
  direction VARCHAR(10),
  balance DECIMAL,
  user_id INTEGER,
  source VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
)
```

## Support Resources

- GitHub Issues: Report bugs and feature requests
- Logs: View detailed import logs at `/api/logs`
- Guide: See `PDF_IMPORT_GUIDE.md` for detailed documentation
- Tests: Run `PDF_IMPORT_TESTS.js` for examples

---

**Version:** 1.0.0  
**Last Updated:** June 3, 2024  
**Status:** Production Ready  
**Support:** Full documentation and examples provided
