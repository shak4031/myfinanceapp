# MyFinanceApp v2 - Documentation Index

## Private accounts and controlled planning

This version replaces the shared demo login with email/password accounts and
server-side sessions. All financial API calls require authentication. PostgreSQL
row-level security isolates transactions, import staging, merchant rules,
categories, debts, and goals; account identity never comes from a request body.
Existing records remain assigned to owner account **1**. New users receive
categories only, never the owner's transactions, debts, rules, or goals.

Before deploying, back up the database and follow the private-account setup in
[DEPLOYMENT.md](./DEPLOYMENT.md). Public registration is off by default. Startup
requires a migration-capable PostgreSQL connection; migration fails rather than
starting with isolation disabled. Production requires HTTPS and `APP_ORIGIN`.

The main application retains bill projections, debt payoff, goals, CSV/PDF
imports, and category drill-downs, with an original light sidebar/card layout.
Spending coaching uses local, evidence-based calculations: no financial records
are sent to an external AI service. It is budgeting guidance, not a licensed
adviser's financial, tax, or investment advice.

Goal planning includes competing car, college, emergency, and other savings
targets. Dated goals share one observed monthly surplus in priority order;
missing history and missing deadlines are explicit. Contributions record savings
progress and do not initiate bank transfers. Forecasts use imported records, not
gross annual salary, and cannot account for obligations you have not entered.
For a new loan not yet in imported spending, uncheck **Monthly payment already
included in imported spending** so its minimum payment is reserved separately.
Check it again once that obligation is represented in the imported history.

Changing a transaction's category automatically saves a normalized, literal
merchant mapping for future imports; setting it to Uncategorized disables that
merchant mapping. It never rewrites other transactions or Fixed Payment flags.
Category management supports creating, renaming, and deleting categories;
deletion requires choosing a replacement and moves existing transactions and
merchant mappings to it. Categorization suggestions can also be reviewed and
applied together, and invalid legacy rules are skipped with a repair warning.
Startup no longer repairs or resets personal categories, balances, or fixed
flags. Legacy shared SQL-fixture imports, SQLite categorization, and web access
to global server logs are disabled because they cannot safely serve private
accounts.

Account support: users reset forgotten passwords by email (SMTP required).
Failed logins, lockouts, admin actions and server errors are written to an
append-only audit log with request IDs. Admins use `/admin.html` for health,
user support, audit/error search and an API explorer. Customers can grant
time-limited, revocable support access (read-only by default) in **Settings &
support**; admins never see customer data otherwise. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for required environment variables.

Run `npm test` for focused regressions, including embedded PostgreSQL isolation
tests and HTTP account/session flows. Tests do not connect to your live database.

## 📚 Available Documentation

### For Users
- **[QUICK_START.md](./QUICK_START.md)** - Get started in 5 minutes
  - What's fixed
  - How to use each feature
  - Mobile tips
  - Troubleshooting

### For Developers
- **[REBUILD_NOTES.md](./REBUILD_NOTES.md)** - Complete technical reference
  - Detailed explanation of each fix
  - Code locations and implementation
  - Database schema
  - API endpoints
  - Future enhancements

- **[COMPLETION_SUMMARY.md](./COMPLETION_SUMMARY.md)** - Implementation guide
  - Executive summary
  - File manifest
  - Design system reference
  - Feature details with code samples
  - Deployment instructions

- **[VERIFICATION_CHECKLIST.md](./VERIFICATION_CHECKLIST.md)** - Quality assurance
  - Complete checklist of all features
  - Testing status
  - Performance metrics
  - Security review
  - Sign-off

---

## 🚀 Quick Navigation

### I want to...

**Understand what was rebuilt:**
→ Start with [QUICK_START.md](./QUICK_START.md)

**Use the app:**
→ Read [QUICK_START.md](./QUICK_START.md) "Getting Started" section

**Deploy the app:**
→ See [COMPLETION_SUMMARY.md](./COMPLETION_SUMMARY.md) "Deployment Instructions"

**Understand the code:**
→ Check [REBUILD_NOTES.md](./REBUILD_NOTES.md) + code locations

**Know what's fixed:**
→ Review [VERIFICATION_CHECKLIST.md](./VERIFICATION_CHECKLIST.md)

**See the design system:**
→ [COMPLETION_SUMMARY.md](./COMPLETION_SUMMARY.md) "Design System" section

**Get API documentation:**
→ [REBUILD_NOTES.md](./REBUILD_NOTES.md) "API Endpoints" section

---

## 📊 The 6 Critical Issues - All Fixed ✅

| Issue | Status | Read More |
|-------|--------|-----------|
| Date Filtering Broken | ✅ Fixed | [REBUILD_NOTES.md#1](./REBUILD_NOTES.md#1) |
| Missing Categories | ✅ Fixed | [REBUILD_NOTES.md#2](./REBUILD_NOTES.md#2) |
| DIY UI/UX Design | ✅ Rebuilt | [REBUILD_NOTES.md#3](./REBUILD_NOTES.md#3) |
| Non-Interactive Categories | ✅ Interactive | [REBUILD_NOTES.md#4](./REBUILD_NOTES.md#4) |
| Basic Payment Cards | ✅ Smart Cascade | [REBUILD_NOTES.md#5](./REBUILD_NOTES.md#5) |
| Mobile File Upload Issues | ✅ Enhanced | [REBUILD_NOTES.md#6](./REBUILD_NOTES.md#6) |

---

## 📁 Source Code

### Frontend
- `/frontend/index.html` - Single-file responsive web app (43KB, 1,433 lines)

### Backend
- `/backend/server.js` - Express server entry point
- `/backend/db.js` - PostgreSQL database manager
- `/backend/routes/dashboard.js` - Dashboard endpoints with date filtering
- `/backend/routes/transactions.js` - Transaction queries with category support
- `/backend/routes/debts.js` - Credit card endpoints
- `/backend/routes/goals.js` - Savings goals endpoints
- `/backend/routes/import.js` - CSV/PDF import handling
- `/backend/routes/auth.js` - Authentication (session-based)
- `/backend/routes/logs.js` - System logging
- `/backend/utils/logger.js` - Logging utility
- `/backend/utils/pdfParser.js` - PDF statement parser

### Configuration
- `package.json` - Dependencies (Express, PostgreSQL client, PDF parser)
- `railway.json` - Railway deployment config

---

## 🎯 Features at a Glance

### Dashboard Tab ✅
- 4 summary metrics (income, expenses, net cashflow, balance)
- Date filtering (Current Month, Last Month, YTD, All Time)
- Upcoming payments with smart balance cascade
- Spending by category (top 8 with icons)
- Recent transactions (last 15)

#### Upcoming fixed payments

- The current month's schedule uses fixed **debit** payments from the immediately
  preceding calendar month, not older historical transactions.
- Each bill uses its most recent payment day and amount from that month. A day
  that does not exist in the current month is moved to the month's final day.
- Payments matched in the current month appear greyed out as **Paid**, even if
  the imported payment is missing its fixed flag or has a different amount.
  Matching uses the merchant/label and distinguishes masked account numbers.
- Only unpaid bills reduce the latest recorded account balance. Unrecorded bills
  with past due days remain in the projection and are labelled overdue.
  Assumed payroll deposits and optional debt-payoff-plan payments are not added.
- The **Fixed Payment flag is authoritative** for debit transactions: the app
  does not reject your selection because of its category or merchant name.
  Unflagged transactions do not create bill templates; credits do not create
  payments. Startup and auto-categorization never turn your choices on or off.
- Use the transaction's Fixed Bill checkbox to manage recurring bills. New bills
  need a payment in the previous month before they can supply a monthly template.
  The projection is based on imported records, not verified bank due dates; keep
  imports up to date. Missing balance/payment data is shown explicitly, never as
  a fully funded result.

Run focused regression tests with `node --test backend\utils\fixedPayments.test.js`.

### Categories Tab ✅ (NEW)
- Grid view of all 24 categories
- Clickable drill-down to category details
- 4 key metrics per category
- Complete transaction history per category
- Back button to return to overview

### Debt Payoff Tab ✅
- Credit card list with balances
- APR and credit limit display
- Progress bar toward payoff
- Color-coded status indicators

### Savings Goals Tab ✅
- Goal list with targets
- Current vs. target amounts
- Progress bars
- Deadline display

### File Import ✅
- CSV upload from banks
- PDF statement support
- Drag-and-drop interface
- Bank/source selector
- Preview before import
- Auto-refresh after success

---

## 🎨 Design Details

### Color Palette
```
Primary:   #4a9eff (Professional Blue)
Success:   #51cf66 (Income Green)
Danger:    #ff6b6b (Expense Red)
Warning:   #ffd93d (Caution Yellow)
```

### Responsive Breakpoints
- Mobile: < 768px (single column)
- Tablet: 768px - 1024px (2 columns)
- Desktop: > 1024px (full layout)

### Features
- Dark mode (default)
- Light mode (auto-detect or manual)
- Smooth transitions (0.2s)
- Card-based layouts
- Touch-friendly (44px+ buttons)
- Mobile-first design

---

## 💾 Database

### Tables
- `users` - User accounts
- `transactions` - Bank transactions with categories
- `categories` - 24-category taxonomy
- `credit_cards` - Credit card accounts
- `savings_goals` - Financial goals

### Sample Data
- 1 test user (Shak)
- 25 sample transactions
- 24 categories with icons/colors
- 3 credit cards with balances
- 3 savings goals

---

## 🔌 API Summary

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/dashboard/summary` | Get metrics with date filter |
| POST | `/api/dashboard/upcoming-payments` | Get payment cascade |
| POST | `/api/transactions` | Get transactions |
| POST | `/api/debts` | Get credit cards |
| POST | `/api/goals` | Get savings goals |
| POST | `/api/import/import-csv` | Import CSV file |
| GET | `/api/logs` | Get system logs |

---

## 📱 Device Support

### Tested On
- iPhone (iOS 15+)
- Android (Chrome, Samsung Internet)
- iPad/Tablets
- Desktop (Chrome, Firefox, Safari, Edge)

### Works With
- File picker on all platforms
- Drag-and-drop (desktop, tablets)
- Native file access on mobile
- Touch events on mobile
- Responsive at all widths

---

## 🚀 Deployment

### Requirements
- Node.js 20.19+
- PostgreSQL 14+
- npm 9.2+

### Quick Deploy
```bash
# Install dependencies
npm install

# Set environment
export DATABASE_URL="postgresql://..."
export PORT=3000

# Start server
npm start
```

### Railway (Recommended)
- Automatic DATABASE_URL injection
- Zero-config deployment
- PostgreSQL included
- SSL enabled

See [COMPLETION_SUMMARY.md](./COMPLETION_SUMMARY.md#-deployment-instructions) for details.

---

## 🐛 Troubleshooting

### Common Issues
- **Date filter not updating?** → Refresh page, check filter is active
- **Categories not showing?** → Import transactions first, try "All Time" filter
- **File upload failing?** → Check file format (CSV/PDF), browser permissions
- **Payments not cascading?** → Refresh page, check account balance exists

See [QUICK_START.md](./QUICK_START.md#-troubleshooting) for more help.

---

## ✨ What's Next

### Phase 2 (Future)
- Budget tracking per category
- Spending trends and charts
- Monthly comparison reports

### Phase 3 (Future)
- Recurring transaction detection
- Bill payment reminders
- AI-powered auto-categorization

### Phase 4 (Future)
- Plaid API integration
- Multi-account support
- Email statements

See [REBUILD_NOTES.md](./REBUILD_NOTES.md#-future-enhancements) for full roadmap.

---

## 📝 Key Files to Review

### If you want to understand...

**The UI redesign:**
→ `/frontend/index.html` lines 10-570 (CSS)

**Date filtering:**
→ `/backend/routes/dashboard.js` (getDateRange function)
→ `/backend/routes/transactions.js` (date range queries)

**Payment cascade:**
→ `/backend/routes/dashboard.js` (upcoming-payments endpoint)

**Categories:**
→ `/backend/db.js` (categories table + seed)
→ `/frontend/index.html` (categoryIcons object)

**File upload:**
→ `/frontend/index.html` (import modal + handlers)
→ `/backend/routes/import.js` (CSV/PDF processing)

---

## 📞 Quick Help

### I'm a user and want to:
1. **Get started** → [QUICK_START.md](./QUICK_START.md)
2. **Use categories** → [QUICK_START.md#explore-categories](./QUICK_START.md)
3. **Track payments** → [QUICK_START.md#monitor-your-cash-flow](./QUICK_START.md)
4. **Fix an issue** → [QUICK_START.md#-troubleshooting](./QUICK_START.md)

### I'm a developer and want to:
1. **Understand the rebuild** → [REBUILD_NOTES.md](./REBUILD_NOTES.md)
2. **Deploy the app** → [COMPLETION_SUMMARY.md#-deployment-instructions](./COMPLETION_SUMMARY.md)
3. **Review code** → See source code locations in each doc
4. **Add features** → [REBUILD_NOTES.md#-future-enhancements](./REBUILD_NOTES.md)

---

## ✅ Verification

All 6 critical issues have been completely fixed:

1. ✅ **Date Filtering** - Works for Current Month, Last Month, YTD, All Time
2. ✅ **Categories** - 24 comprehensive categories added with drill-down
3. ✅ **Professional UI** - Modern design matching Stripe/Linear/Vercel
4. ✅ **Interactive Categories** - Click to see all transactions + metrics
5. ✅ **Smart Payments** - Balance cascade with status indicators
6. ✅ **Mobile Upload** - Drag-and-drop, file picker, error handling

See [VERIFICATION_CHECKLIST.md](./VERIFICATION_CHECKLIST.md) for complete verification.

---

## 📊 Project Stats

| Metric | Value |
|--------|-------|
| Frontend Size | 43KB |
| Total Lines of Code | 2,834 |
| Backend Routes | 7 |
| Database Tables | 5 |
| Categories | 24 |
| Documentation Pages | 4 |
| Issues Fixed | 6/6 |
| Status | ✅ Production Ready |

---

**Last Updated:** June 3, 2026  
**Status:** ✅ Complete & Production Ready  
**User:** Shak4031

---

## 📖 Document Map

```
Documentation/
├── QUICK_START.md ...................... User guide (7KB)
├── REBUILD_NOTES.md ................... Technical reference (16KB)
├── COMPLETION_SUMMARY.md .............. Implementation guide (16KB)
├── VERIFICATION_CHECKLIST.md .......... QA checklist (12KB)
└── README.md .......................... This file

Source Code/
├── frontend/
│   └── index.html ..................... Complete web app (43KB)
├── backend/
│   ├── server.js ...................... Entry point
│   ├── db.js .......................... Database manager
│   └── routes/
│       ├── dashboard.js ............... Dashboard endpoints
│       ├── transactions.js ............ Transaction queries
│       ├── debts.js ................... Credit card endpoints
│       ├── goals.js ................... Goals endpoints
│       ├── import.js .................. File import handling
│       ├── auth.js .................... Authentication
│       └── logs.js .................... System logging
└── Configuration Files/
    ├── package.json ................... Dependencies
    └── railway.json ................... Deployment config
```

---

**Ready to deploy and start using MyFinanceApp v2! 🚀**
