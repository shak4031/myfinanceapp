# Transaction Categorization Review Page

A simple, clean, single-page application for reviewing and categorizing financial transactions with automatic pattern learning.

## ✨ Features

- **Single Clean Page** - No tabs, no iframes, no complexity
- **Paginated View** - 20 transactions per page, easy navigation
- **Dual Actions** - ✓ Confirm or Change Category for each transaction
- **Auto Learning** - System learns patterns from your corrections
- **Stats Dashboard** - Total, Confirmed, Modified, and Pending counts
- **Dark Theme** - Eye-friendly dark UI that's responsive
- **Fast Loading** - Optimized SQLite backend

## 📋 What It Does

### Confirm Flow
1. Click **✓ Confirm** on a transaction
2. Status changes to "✓ Confirmed" (green)
3. Transaction won't show in pending reviews again

### Modify Flow
1. Click **Change** on a transaction
2. Select a new category from dropdown
3. Click **Save**
4. Status changes to "✎ Modified" (orange)
5. System learns: "This description → This category"

### Pattern Learning
- When you modify a category, keywords are extracted from the description
- Pattern stored in `learned_categorizations` table
- Next import uses learned patterns before auto-categorization
- Confidence increases with each matching correction

## 🗂️ File Structure

```
/opt/data/myfinanceapp-v2/
├── frontend/
│   └── categorizations-simple.html    # Complete frontend (self-contained)
│
└── backend/
    └── routes/
        └── categorizations-lite.js    # SQLite-based API
```

## 🚀 Getting Started

### 1. Ensure Database Tables Exist

```bash
cd /opt/data
python3 << 'EOF'
import sqlite3

conn = sqlite3.connect('finance.db')
cursor = conn.cursor()

# Create categorization_status table
cursor.execute("""
CREATE TABLE IF NOT EXISTS categorization_status (
    txn_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',
    confirmed_at TEXT,
    modified_at TEXT,
    FOREIGN KEY (txn_id) REFERENCES finance_transactions(txn_id)
)
""")

# Create learned_categorizations table
cursor.execute("""
CREATE TABLE IF NOT EXISTS learned_categorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    usage_count INTEGER DEFAULT 1,
    UNIQUE(keyword, category)
)
""")

conn.commit()
conn.close()
print("✓ Database tables created")
EOF
```

### 2. Backend is Already Integrated

The API routes are already added to the Express server:
- `GET /api/categorizations-lite/transactions?page=1`
- `POST /api/categorizations-lite/transaction/:txn_id/confirm`
- `POST /api/categorizations-lite/transaction/:txn_id/modify`
- `GET /api/categorizations-lite/stats`

### 3. Access the Page

Navigate to:
```
http://localhost:3000/categorizations-simple.html
```

## 📊 API Endpoints

### GET /api/categorizations-lite/transactions
Fetches paginated transactions with status

**Query Parameters:**
- `page` - Page number (default: 1)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "txn_id": "...",
      "date": "2026-05-29",
      "description": "...",
      "amount": 100,
      "direction": "debit",
      "auto_category": "Shopping & Online",
      "learned_category": null,
      "status": "pending"
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 425,
    "total_pages": 22
  },
  "stats": {
    "total": 425,
    "confirmed": 0,
    "modified": 0,
    "pending": 425
  },
  "categories": [...]
}
```

### POST /api/categorizations-lite/transaction/:txn_id/confirm
Marks a transaction as confirmed

**Response:**
```json
{
  "success": true,
  "message": "Transaction confirmed"
}
```

### POST /api/categorizations-lite/transaction/:txn_id/modify
Updates category and learns pattern

**Body:**
```json
{
  "category": "Groceries"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Transaction updated and pattern learned"
}
```

### GET /api/categorizations-lite/stats
Gets current statistics

**Response:**
```json
{
  "total": 425,
  "confirmed": 0,
  "modified": 0,
  "pending": 425,
  "learned_patterns": 0
}
```

## 🎨 UI Components

### Stats Bar
Shows at top:
- **Total** - All transactions
- **Confirmed** - ✓ Confirmed (green)
- **Modified** - ✎ Modified (orange)  
- **Pending** - Awaiting review (yellow)

### Transaction Row
Format: Date | Description | Amount | Category | Learned | Status | Actions

### Actions
- **✓ Confirm** - Green button, marks confirmed
- **Change** - Blue button, opens category selector

### Status Badges
- **Pending** - Yellow, shows "Pending"
- **✓ Confirmed** - Green, transaction won't show again
- **✎ Modified** - Orange, user-corrected with learned pattern

## 🛠️ Customization

### Categories
Edit the CATEGORIES list in `categorizations-lite.js`:
```javascript
const CATEGORIES = [
  'Groceries',
  'Dining & Restaurants',
  // ... add more categories
];
```

### Styling
All CSS is in `<style>` tag in the HTML. Key variables:
```css
:root {
  --primary: #4a9eff;
  --success: #51cf66;
  --warning: #ffd93d;
  --bg-primary: #0f1419;
  /* ... more colors ... */
}
```

### Page Size
Change `perPage` in the backend route:
```javascript
const perPage = 20; // Change to 50, 100, etc.
```

## 🧪 Testing

Run the test script:
```bash
cd /opt/data/myfinanceapp-v2
node test-categorizations-lite.js
```

This will:
- ✓ Check database tables exist
- ✓ Show transaction counts
- ✓ Display sample transactions
- ✓ List any learned patterns

## 📱 Mobile Support

The page is fully responsive:
- Tablet: Grid adjusts to 3 columns
- Mobile: Optimized to essential columns with vertical action buttons

## 🔧 Database Schema

### categorization_status
```sql
CREATE TABLE categorization_status (
    txn_id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'pending',  -- 'pending', 'confirmed', 'modified'
    confirmed_at TEXT,
    modified_at TEXT,
    FOREIGN KEY (txn_id) REFERENCES finance_transactions(txn_id)
)
```

### learned_categorizations
```sql
CREATE TABLE learned_categorizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    category TEXT NOT NULL,
    confidence REAL DEFAULT 1.0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    usage_count INTEGER DEFAULT 1,
    UNIQUE(keyword, category)
)
```

## 🚨 Troubleshooting

### Page shows "Loading transactions..." indefinitely
- Check browser console for errors
- Verify API endpoints are running: `GET /api/categorizations-lite/stats`
- Check database file exists: `/opt/data/finance.db`

### API returns empty response
- Verify database tables were created
- Check table names: `categorization_status`, `learned_categorizations`

### Confirm/Change buttons don't work
- Check console for fetch errors
- Verify transaction IDs match between table and HTML
- Check database write permissions

## 📈 Future Enhancements

- [ ] Bulk actions (confirm/change multiple)
- [ ] Filter by status or category
- [ ] Edit learned patterns
- [ ] Export categorizations report
- [ ] Undo recent changes
- [ ] Search/filter descriptions

## 📄 License

Part of MyFinanceApp - same license as main project

---

**Ready to use!** Just navigate to the page and start reviewing transactions.
