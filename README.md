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

## Demo account

The server creates a showcase account on start-up: `demo@myfinance.app` /
`password1234`. It holds a year of generated sample data (income, fixed bills
with auto-pay/manual modes, budgets, goals, debts and categorization rules) and
always includes MyFinance Pro Plus. Its data is rebuilt on every deploy and nightly
at 08:00 UTC, so changes made during a demo never persist. Admins cannot grant
or revoke its license, and password-reset emails are never sent for it. Set
`DEMO_ACCOUNT=false` to disable it.

## Responsive workspace and activity filters

PDF uploads detect card versus bank statements and reconcile transactions before
committing. Card imports capture New Balance and purchase APR, with latest
statement facts visible on Accounts. See the [PDF import guide](PDF_IMPORT_GUIDE.md)
for validation, supported patterns, failure recovery, API examples and tests.

The finance workspace uses a shared navy navigation rail, emerald actions,
high-contrast typography, and white panels. Navigation remains available on every
finance view; on phones, open the menu in the upper left. Browser Back/Forward
and direct links also work, including the category management view. The admin
console includes links back to each finance view. The legacy transaction viewer
now redirects to the authenticated workspace rather than showing a separate demo.

Transactions and Categories both offer an **Activity month** calendar. An empty
month means **All time**. Transaction month, category, and fixed-bill filters
combine; visible totals always use the same filtered rows. **Reset filters**
clears all three. Category counts and spending totals use the selected month,
and opening a category carries that month into its floating detail panel.
The detail panel has its own calendar and **All time** action. Dashboard
month-to-date cards continue to open the specific month shown on the dashboard.

Month-to-date spending cards emphasize the category and amount spent. With Pro
analytics enabled, budgeted categories show a single remaining or over-budget
amount and a right-side vertical budget meter, rather than repeated budget totals
and percentages. Over-budget cards use explicit text and a striped red meter;
screen readers receive the spent, budget and forecast amounts. Budget editing,
the analytics toggle and category transaction drill-down remain available.

Category details, imports, goal/debt editors, confirmations, and savings entry
use centered, viewport-constrained floating dialogs with dimmed backdrops.
Dialogs retain keyboard focus, close with Escape or their close/cancel controls,
and scroll internally when needed. On smaller screens, content stacks and wide
data tables scroll within their panels rather than widening the whole page.

Run `node --test frontend/frontend.test.mjs` for focused navigation, dialog,
calendar-filter, filtered-summary, and request-order regressions.

### Actionable alerts and account review

The welcome greeting is followed directly by the rotating insight carousel.
**Action needed** and **Heads up** messages include the flagged item's details
and action within their slides, without a separate badge or duplicate alert list.
Unknown-transfer badges link to Accounts for review.
Transaction descriptions in account transfers, category details, income review,
category suggestions, and unusual-charge alerts link to `#transactions/<id>`.
Opening one clears conflicting filters and shows only that transaction, including
its filtered totals and exact-ID CSV export. The link works on reload and with browser Back/Forward.
**Reset filters** removes the exact-transaction filter and restores all activity.

Accounts separates confirmed accounts from external recipients and explains
references inferred from statement descriptions. Review does not connect a bank
or move money. **Yes, confirm my account** requires an account type.
**No, it is not mine** saves an external recipient: outgoing transfers count as
spending and incoming transfers as other income, not regular pay. Change the
type later to correct the choice. Unreviewed transfers remain excluded from
spending and income; account-type-specific savings and loan rules are unchanged.

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
- **Welcome hero** instead of a bar chart: a greeting, a one-line status headline and
  rotating insight cards (over-budget categories, bills due soon, manual payments,
  balance dipping below a safe level before payday, debt-free progress, goal status,
  price increases and Pro tips). Cards rotate every 7 seconds, pause on hover/focus,
  can be paused, swiped or stepped with the arrow keys, and respect reduced motion.
  The hero is a light aurora card whose glow follows the active insight's mood; each
  insight has an emoji mascot, highlights its key figures (amounts, %, dates) with a
  marker swipe, and enters with a different animation (rise, pop, swipe, flip, word
  cascade, zoom). The stage resizes smoothly to each message, so there's no empty space.
- **Today at a glance**: colourful stat bubbles for balance, next payday, bills left, lowest projected point and
  debt-free month. Insights come from `GET /api/dashboard/insights`
  (rules in `backend/utils/insights.js`).
- The cash-flow history chart is still available in a collapsed drawer below the
  upcoming payments and only loads when opened.
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
- **Income is projected too.** Credits categorised as Salary/Income are treated as
  fixed automatically; the pay cadence (weekly, biweekly on a weekday, semi-monthly
  or monthly) is detected from the last months of deposits, and expected paychecks
  are added to the running balance. Debt-free-plan and goal contributions appear as
  violet **Flexible** cards that can be adjusted or skipped for a single month.
- **You decide what counts as pay.** Regular deposits (even Zelle or Venmo money
  from a friend) can look like a paycheck. Each deposit in Transactions has an
  **Income** toggle under *Fixed / Income*, and **Review income** (Transactions
  header, the Upcoming "Income still coming" tile, any income card, or the Goals
  money-flow panel) lists every repeat sender with its cadence, why it was counted,
  and an *Income / Not income* switch. Your choice beats automatic detection, is
  offered for the sender's other deposits, sticks to future imports from the same
  sender, and can be reset to automatic at any time.
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

### Plans and the public login page

The signed-out login page doubles as the public marketing page: a benefit-led
introduction, illustrative progress preview, Free / Pro / Pro Plus comparison,
and the existing sign-in, registration and password-recovery forms.

The page scrolls normally while signed out and has a sticky top bar (Features,
Free vs Pro, Pricing, Sign in) plus links back to sign-in and to the top after
pricing. In-page links scroll without touching the app's hash router. Above the
sign-in card, a "7 quick wins" feature spotlight (`frontend/marketing.js`)
rotates through Free, Pro and Pro Plus capabilities with varied entrance
effects. It has dots, arrows and a pause button, pauses on hover or focus and
in background tabs, and does not auto-rotate when reduced motion is preferred.

Prices are USD per month:
- **Free ($0):** imports, transactions, category review and the everyday dashboard.
- **Pro ($4.99):** Free plus budgets, analytics, charts, forecasts, subscription
  radar, unusual-charge signals and CSV exports. Does **not** unlock Debt Free
  or Savings Goals.
- **Pro Plus ($9.98 total):** Pro plus $4.99 for Debt Free and Savings Goals,
  including all strategies and what-if tools.

The optional, one-time seven-day trial includes **Pro Plus**, ends automatically
and never charges. It is never started for you: account holders start it
themselves from the in-app plan dialog. Owner and demo accounts retain full Pro
Plus access. Existing Pro grants remain Pro-only; there is no automatic upgrade.
Paid access is administrator-managed, not a payment subscription integration or
online checkout.

#### Choosing a plan

Each pricing card has a **Choose Free / Choose Pro / Choose Pro Plus** button.
The selected card is highlighted, the choice is remembered in the browser
(`localStorage` key `myfinance.chosenPlan`), and the sign-in card shows a
"Your plan" summary with options to change or clear it. After the visitor signs
in or creates an account, a Pro or Pro Plus choice is sent once as a plan
request; Free just clears the choice. The account stays on its current plan
until an administrator approves the request.

Signed-in users pick Pro or Pro Plus in the plan dialog (sidebar plan chip or any
locked feature), then select **Request Pro** / **Request Pro Plus**. A pending
request is shown on the chip and in the dialog, where it can be cancelled.
Support sessions cannot request plans.

- `POST /api/license/request` with `{ "plan": "pro" | "pro_plus" }` saves the
  request (409 if the account already has that plan or is the owner/demo account).
- `DELETE /api/license/request` cancels it.
- Both return the entitlement; a pending request appears as
  `request: { plan, requestedAt }`.

Admins see a "Plan requests to review" count on the overview, and requesting
users are listed first on the users page with a "Wants Pro Plus" tag and an
**Approve … request** button. Granting any plan clears the request. The users
page also offers Grant Pro, Grant Pro Plus, Change to Pro and Revoke paid access.
The license API accepts `action: "grant"` with `plan: "pro"` (default) or
`"pro_plus"`; revocation uses `action: "revoke"`.

The entitlement response uses `active` for Pro access and `plusActive` for
planning access. All debt, goal and plan API operations enforce Pro Plus on the
server and return HTTP 402 with `PRO_PLUS_REQUIRED` otherwise. The corresponding
pages show a locked explanation and plan comparison. Losing access preserves
saved budgets, debts, goals and settings, but removes planning extras from the
dashboard calendar until access returns. Base income/bill tracking stays available.

### Debt-free plan tab (Pro Plus only)
- Include or exclude any loan, card or other debt; star one as your focus
- Strategies: **Avalanche** (highest APR first), **Snowball** (smallest balance first),
  **Interest cost**, **Cash-flow** (free up payments fastest) and **My order**
- APR-driven guidance, a suggested extra payment, and a debt-free date chart vs. minimums only
- Pro Plus what-if simulator (extra per month and lump sums)
- Each month's minimums and extra payment land on the dashboard calendar; the extra is flexible
- **How the strategy dates work:** every strategy is simulated month by month at your
  current monthly debt budget. Each card shows the resulting debt-free month, the total
  interest and which debt receives the extra first. When two strategies pay your debts
  in the same order (common when your highest-APR debt is also your smallest), their
  results are identical; the page says so and switching shows a confirmation.

### Tutorials tab
- Short animated walkthroughs for the **Debt-free plan**, **Savings goals**, the
  **Dashboard**, **Fixed bills & income**, **Categories** and **Transactions**, with
  chapters, a progress bar, full screen, keyboard controls (Space/K, ←/→, F) and
  optional voice narration using the browser's speech engine.
- The Fixed, Categories and Transactions tours each end with a "which page when?"
  comparison: Transactions for detail (one charge), Categories for patterns (what
  money is for) and Fixed bills & income for timing (when money moves).
- Deep links such as `#tutorials/debt-strategies`, `#tutorials/income` or
  `#tutorials/which-page` open a specific chapter; they are linked from the
  Debt-free plan ("Watch the 1-min tour", "How it works"), Goals, Categories,
  Transactions, the dashboard welcome ("Tour") and Settings.
- Scenes are HTML/CSS on a scalable 16:9 canvas, so they stay sharp at every screen
  size and need no video hosting. Edit them in `frontend/tutorial.js`.

### Goals tab (Pro Plus only)
- Money-flow view: income streams, monthly surplus, debt extra, goal budget, unassigned
- Priority order, nearest deadline, balanced funding and what-ifs
- Per-goal monthly contribution, contribution day, include toggle, status and timeline

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
| GET | `/api/dashboard/insights` | Welcome insights and today's pulse |
| POST | `/api/transactions` | Get transactions |
| GET | `/api/transactions/income-sources` | Repeat deposit senders and whether each counts as income |
| POST | `/api/transactions/update-income-role` | Mark deposits `income`, `other`, or `null` (automatic) |
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
