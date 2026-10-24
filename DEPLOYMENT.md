# Private-account deployment

## Before upgrading

1. Back up PostgreSQL and verify the backup can be restored. Test the upgrade on
   a separate staging database first. Do not point tests at production.
2. Existing rows with no owner are assigned to user **1**. Existing owned records
   retain their owner. Only a protected owner-setup flow may claim account 1.
3. The application no longer seeds personal debts, rewrites balances, repairs
   categories, or resets fixed flags at startup. Review flags removed by older
   versions manually; their original intent cannot be reconstructed reliably.

## Environment

Set secrets in your deployment platform, never in source control:

```text
DATABASE_URL=postgresql://<migration-user>:<password>@<host>:5432/<database>
NODE_ENV=production
APP_ORIGIN=https://<your-app-domain>
OWNER_SETUP_TOKEN=<cryptographically-random-token-at-least-32-characters>
ALLOW_REGISTRATION=false

# Password-reset and security-notice email (required for self-service reset)
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_SECURE=false            # true for implicit TLS, usually port 465
SMTP_USER=<smtp-user>
SMTP_PASS=<smtp-password>
SMTP_FROM="MyFinanceApp <no-reply@your-domain>"

# Audit and monitoring
AUDIT_HASH_SECRET=<random-secret-at-least-32-characters>
AUDIT_RETENTION_DAYS=365     # 30 to 3650
ALERT_WEBHOOK_URL=<optional Slack/Discord-compatible incoming webhook>
LOG_MONITOR_TOKEN=<random-secret-at-least-32-characters>  # enables /api/monitor/logs for CI checks
LOG_RETENTION_DAYS=30        # stored warnings/errors (app_logs), 1 to 3650
LOG_MEMORY_ENTRIES=5000      # recent lines per instance for the "Everything" view
```

Generate a setup token (and `AUDIT_HASH_SECRET`) locally with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`DATABASE_SSL=true` enables certificate-verified PostgreSQL TLS when your provider
requires it. Use the provider's trusted certificate configuration; do not disable
certificate validation. Private-network database connections can omit this
setting when appropriate to the provider.

`APP_ORIGIN` must exactly match the browser origin, with scheme and port where
applicable and no trailing slash. Cross-origin writes are rejected. In production
session cookies are Secure, HttpOnly and SameSite=Strict, so HTTPS is required.
Configure your hosting proxy to terminate HTTPS and preserve the expected host.
If deployed behind a trusted reverse proxy, set `TRUST_PROXY_HOPS` to the exact
trusted hop count (for example `1` for one proxy). Do not trust arbitrary forwarded
headers. Without the correct setting, all users behind that proxy may share the
same authentication IP rate limit.

The migration connection must own the existing tables, create/alter tables and
roles, and grant the `finance_app_runtime` role to itself. The runtime role must
be `NOLOGIN NOSUPERUSER NOBYPASSRLS`. Each financial database operation starts a
transaction, sets that restricted role, and sets the verified user ID locally.
The role cannot read authentication/session tables or truncate financial tables.
The application fails startup if these protections cannot be installed. The
administrative connection is used only by schema setup and authentication.

## Start and claim the owner account

```powershell
npm ci
npm test
npm start
```

Open the app, choose **First-time setup: create the owner account** under the
sign-in form (or open `/#owner-setup`), and enter your name, email, a password of
12 to 128 characters, and the setup token. The link and token field only appear
until the owner account exists; everyone else sees the normal sign-in form. This
assigns credentials to account 1
without copying its financial data to anyone else. Setup is single-use and
serialized with registration. Remove `OWNER_SETUP_TOKEN` after setup and restart.

Leave registration closed until staging isolation tests and an independent
production security review are complete. Set `ALLOW_REGISTRATION=true` only when
ready. New users receive independent empty budgets and category lists.
Passwords use salted scrypt; session tokens are random, stored hashed, expire
after 10 minutes of inactivity or 12 hours absolutely and are revoked on logout.
Only explicit user interaction (`POST /api/auth/activity`) renews inactivity;
background API requests and `GET /api/auth/me` do not. Browser locking also clears
protected content on idle expiry and synchronizes sign-out across tabs, including
the admin console. Session cookies are nonpersistent. The first migration adding
`sessions.last_activity_at` deletes existing sessions, requiring everyone to sign
in again; subsequent migrations preserve valid sessions. Authentication attempts are limited
in PostgreSQL across processes.

The owner does not register: account 1 already holds the existing data and is
claimed once through Owner setup. Other people register with **Create an
account** only while `ALLOW_REGISTRATION=true`; each starts with an empty,
isolated workspace.

There is not yet email verification, MFA or self-service account deletion. Do not
advertise these capabilities.

## Password reset

- Users choose **Forgot password?** on the sign-in screen. The response is always
  the same, so it does not reveal whether an email is registered.
- When SMTP is configured, the user receives a single-use link that expires in
  30 minutes. The token is placed in the URL fragment, so it is not sent in
  server request logs, and only its hash is stored.
- Completing a reset signs out every session (including support sessions),
  clears login lockouts, and emails a security notice.
- An admin can send the same reset email from the admin console. Admins never
  see or choose the user's password or reset token. Without SMTP the request
  returns 503; configure SMTP before inviting users.

## Audit logs, error logging and monitoring

- Every request receives an `X-Request-Id` (an incoming valid ID is preserved).
  Server errors return `{ error, requestId }`; ask customers for this ID.
- Structured JSON lines (`http.request`, `server.error`, audit events) are
  written to stdout for Railway or another log platform. Error summaries saved
  in the audit table are bounded and redact common secrets, email addresses and
  long numeric values; exception stacks remain available only in restricted
  operator logs.
- The append-only `audit_events` table records successful and failed logins
  (with reason), lockouts, registration, setup, logout, reset requests and
  completions, admin actions, support grants and every support-session request,
  server 5xx errors, and sanitized browser runtime-error summaries. Emails and
  IPs are stored as keyed hashes (`AUDIT_HASH_SECRET`). Browser reports omit
  stacks, page contents and network bodies, redact common secrets and amounts,
  and are rate-limited per account.
- `ALERT_WEBHOOK_URL` receives throttled alerts for server errors and lockouts.
- Audit rows, used/expired reset tokens and expired sessions are purged after
  `AUDIT_RETENTION_DAYS` at startup and daily.
- Every log line is one JSON object with `time`, `level` (`info`/`warn`/`error`),
  `module` or `event`, `message`, and the `requestId`/`route` of the request
  being handled. `log('MODULE', msg)` infers the level from the wording
  ("error", "failed" → error; "unavailable", "could not" → warn); pass a third
  argument to override it. A 5xx response always logs a `route.error` line with
  the real (redacted) reason, even when the client only sees the generic message.
  Lines also go to `logs/app-YYYY-MM-DD.log` (`LOG_DIR` to move,
  `LOG_TO_FILE=false` to disable). Test runs do not write log files.

### Where support sees the logs

- **Admin console → App logs** (`/admin.html`, admin accounts only). Filter by
  level (errors / warnings and errors / everything), time range (15 minutes to 30 days),
  text and request ID; optional 30-second auto-refresh. A **Problems** list
  groups repeated failures by cause with counts, routes, first/last seen and
  example request IDs; click a request ID to see every line from that request.
  The Overview shows app log errors and warnings for the last 24 hours.
- Messages are redacted before storage (emails, money amounts, long numbers,
  passwords/tokens), so support never sees customer financial data. Each view
  is recorded in the audit trail as `admin.logs_viewed`.
- Warnings and errors are stored in the `app_logs` table (all instances, kept
  `LOG_RETENTION_DAYS`, purged daily) and survive restarts. Info lines are kept
  in memory on each instance only (`LOG_MEMORY_ENTRIES`), so "Everything" shows
  info from the instance that answered.
- API: `GET /api/admin/logs?level=warn&since=24h&q=&requestId=&limit=200`
  (admin session) and `GET /api/monitor/logs?since=30m&level=warn` with
  `Authorization: Bearer $LOG_MONITOR_TOKEN` for automation. The monitor
  endpoint is read-only, returns warnings/errors only, answers 404 until the
  token is configured and audits rejected tokens as `monitor.denied`. Its JSON
  includes `status: "ok" | "errors"`, `summary`, `causes` and `entries`.

## Release gate (run before every deploy)

1. `npm run release:check` runs all tests, then `scripts/release-smoke.js`. The
   smoke check boots the app on an in-memory PostgreSQL that starts from the
   oldest production schema with legacy MM/DD/YYYY and unreadable dates, runs
   the migration twice (as a restart would), loads the demo data, imports bank
   CSVs and calls every dashboard, analytics, plan and goals endpoint as the
   owner and the demo user. It then reads the results through
   `/api/admin/logs` and `/api/monitor/logs`, the same APIs support uses, and
   checks that every error the app wrote reached them. **Any 5xx response or
   error-level log line blocks the release** and is listed with its cause and
   request ID.
2. `.github/workflows/release-check.yml` runs the same check on every push and
   pull request. In Railway, enable **Settings → Deploy → Wait for CI** so a
   failing check stops the deploy.
3. After deploying, check the live app and roll back on failure:
   `APP_URL=https://<app> LOG_MONITOR_TOKEN=<token> npm run deploy:check`
   checks `/api/health` and the application logs (`SINCE=30m` default,
   `FAIL_ON=warn` to include warnings) and exits 1 on errors or 5xx responses.
4. `.github/workflows/log-monitor.yml` runs the same check every 30 minutes
   (and on demand) once the repository secrets `APP_URL` and
   `LOG_MONITOR_TOKEN` are set; a failed run emails the repository owners.
5. `npm run logs:scan -- logs/app-2026-10-18.log` (or `railway logs | npm run
   logs:scan -- --since 30m`) scans raw log output from files or stdin.
6. When a customer reports "The request could not be completed", paste the
   `requestId` they were shown into **Admin console → App logs**.

## Admin console

Open `/admin.html` while signed in as an admin (account 1 is the admin). It
provides service health and configuration warnings, user search (account
metadata only, never financial data), password-reset email, unlock, sign out
everywhere, **App logs** (see "Where support sees the logs"), a dedicated
**Error logs** view filterable by time range and request ID, a separate **Audit trail** filterable by event, outcome, user, email or
request ID, support sessions, and an API explorer generated from
`/api/admin/openapi.json` that can send test requests and shows status, latency
and request ID. Customers can never reach admin endpoints.

Use the request ID shown in the Error logs or App logs view to find the matching
entry. Stack traces are only in the hosting provider's restricted stdout logs;
the app does not serve raw operator log files to the browser. Frontend HTML, JavaScript and CSS responses require
revalidation so deployments do not silently reuse stale cached app assets.

## Consent-based support access

Admins cannot view customer data without permission and never use customer
credentials. In **Settings & support**, the customer grants access for 1–72
hours with a reason. Access is read-only by default; the customer may explicitly
allow edits. The customer can revoke access at any time and sees every support
action in their activity list.

From the admin console's Support sessions tab, the admin starts a session from
an active grant (up to 2 hours, never beyond the grant). The customer is emailed.
A banner shows the support session; read-only access is enforced both by the API
and by PostgreSQL read-only transactions. Admin and grant-management endpoints are
blocked during support sessions, each request is audited, and ending, revoking or
expiring the grant stops access immediately.

## Live-data migration rehearsal

Your existing months of data are not copied or re-imported. The upgrade updates
the same database in place and assigns existing rows to account 1. Rehearse it:

1. Take a Railway backup and restore it to a separate staging database.
2. Before upgrading, record counts on staging, for example
   `SELECT date_trunc('month', date::date) m, count(*), sum(amount) FROM transactions GROUP BY 1 ORDER BY 1;`
   plus counts of categories, debts, goals and transactions marked fixed.
3. Deploy this version against staging, complete Owner setup, and rerun the
   queries. Counts and totals must match and every row must have `user_id = 1`.
4. Verify dashboard balances, Upcoming payments and Fixed flags in the browser.
5. Only then back up production and deploy. To roll back, redeploy the previous
   version and restore the backup taken immediately before the upgrade.

## Accounts and transfers

Every import names the account it came from (an existing account, or a new one
with its type and last four digits). This lets the app recognise money moving
between your own accounts, which is shown for information and left out of every
spending and income total (dashboard, analytics, coach, goals and debt plans).

| Situation | How it is counted |
| --- | --- |
| Checking to checking (both yours) | Transfer, not counted |
| Checking to savings, investment or crypto | **Saved** (shown as "Saved this month"), not spending |
| The savings side of that same transfer | Transfer, not counted (so savings is not double counted) |
| Interest earned on savings | Income |
| Card or loan payment, and that card's or loan's statement is also imported | Transfer, not counted (the purchases are counted on the card) |
| Card or loan payment, statement not imported | Counted as a bill |
| Zelle, Venmo, PayPal, Cash App | Money out is spending ("Payments to people"); money in is "Other income", not pay |
| Transfer to an account number we have not seen | The account is added as **Needs review** and its transfers are left out until the user picks its type |
| Account marked "Not my account" | Transfers to it count as spending (or income) |

A user's category correction always wins: setting a row to Transfer or Savings
marks it as a transfer, and any other category makes it count. Cash on hand is the
newest balance of each checking account; savings balances are shown on the
Accounts page.

On upgrade, the migration creates the `accounts` table and new transaction columns
and classifies existing rows once. Older imports have no account; the Accounts
page lists them by import source so the user can assign each one, after which
transfers are re-matched.

## Spending Compass (Pro, Analytics > Spending Compass, `#analytics/compass`)

Compares seven standard categories (groceries, dining, utilities and energy, gas and
charging, shopping, entertainment and subscriptions, out-of-pocket healthcare) with a
typical household, then reads each one like a price chart to suggest realistic savings.
Mortgage, rent, loans, insurance and internet are left out because they are contracted bills.

- **Benchmark source:** U.S. Bureau of Labor Statistics Consumer Expenditure Survey,
  2024 annual means (table in `backend/utils/benchmarks.js`, pulled from the BLS public
  API). The survey publishes one characteristic at a time, so the household-size value is
  scaled by the region and rent/own ratios. Figures are 2024 dollars. To refresh, update
  `CE_2024` and `BENCHMARK_SOURCES` when BLS publishes a new year (usually each September).
- **Household:** size (1 to 12; the survey groups 5 or more), region and rent/own, stored in
  `household_profiles` (row-level isolated like other private tables) and set from the
  card or `PUT /api/analytics/household`. Income is not asked for.
- **Indicators (completed months only):** 3-month vs 12-month average crossover;
  momentum against the same three months last year once 15 months exist (otherwise a
  Theil-Sen 6-month trend, skipped for seasonal bills); a 2-standard-deviation band; months up
  out of the last 6. For everyday categories a year-over-year rise only counts when the recent
  trend agrees.
- **One-offs:** a non-fixed charge of at least $250 and 5 times the category's usual charge is
  listed but left out of the series.
- **Targets:** never below a level the user already reached (25th percentile of the last 12
  months) and never above their median or the typical household; seasonal bills use the same
  months last year.
- **Page layout:** the hero shows the monthly, yearly and 5-year savings plus a plan (now → target per
  category). Next come up to four "What stood out" cards (`moneyFlow.insights`: top saving, unusual month,
  more visits vs pricier visits, purchases under $20, days of work, a recent win). Then a Sankey of the
  last 3 full months (`moneyFlow.flow`: income → fixed bills / everyday / debt minimums not yet imported
  / left over). Its "left over" uses the same transfer rule and window as the typical monthly surplus, so
  it matches the dashboard. A full-width three-set Venn follows (above similar homes, trending up,
  unusual last month) with a "Reading the overlap" list beside it naming each flagged category and its
  signals, strongest first (stacks below the diagram under 900px). Then "Who gets your money": draggable merchant bubbles (`moneyFlow.vendors`: everyday merchants
  over the last 3 full months, grouped with the same `merchantKey` as the Overview, or by the user's
  name when the payee has been renamed; fixed bills,
  transfers and one-offs over max($250, 5× the median purchase) excluded). Size switches between monthly
  spend and visits; colour between change vs the 3 months before (deeper = bigger change) and category
  (deeper = more visits). The layout is a small client-side physics simulation that stops when settled
  and is pre-settled for reduced motion. Next, "Hot and cold months" (`moneyFlow.heatmap`: the top 10
  spending categories × the last 12 full months, fixed bills included, transfers excluded); each row is
  coloured against its own median month, so steady bills stay neutral, and a lede names the hottest
  month and the category that drove it. Then a strip chart per category of the user's own 5th–95th
  percentile range over 12 months
  with last month and the typical household marked. The indicator table sits in a collapsed
  "Technical readings" section.
- **Statistics are honest about their source:** percentiles and spikes (last month above the 95th
  percentile of the prior months and at least $25 over their median) come only from the user's own
  history. The BLS survey publishes means, so the page never claims a household percentile.
  "Purchases × size" splits a change into more visits vs a higher average ticket, comparing with the
  same 3 months last year once 15 months exist.
- **No other users' data is used.** A pooled MyFinance comparison is a later option and should
  be opt-in, anonymised and shown only for groups of at least 50 households.

## Renamed payees (Transactions > Rename)

- Messy bank text such as `SENT 626800I0ARPL Zelle CRISTIANE DE LIMA` can be shown as
  `Cristiane De Lima`. Each **Rename** button on the Transactions page opens a dialog with:
  - the friendly name;
  - the words to match, suggested from the description with leading noise such as SENT/POS/DEBIT dropped;
  - a live count of matching transactions, with samples.
- A rename is a rule (`name_rules`: `pattern`, `name`, private per user with RLS). It matches whole words
  in any description and ignores every token containing a digit, so changing reference codes still
  match. "CRISTIANE DE LIMAS BAKERY" does not match "CRISTIANE DE LIMA". The longest pattern wins, then
  the newest.
- Saving or removing a rule recomputes `transactions.display_name` for all of the user's rows. Imports
  and manual entries set it on insert, so future statements get the name automatically.
- `description` is never changed: category rules, transfer and income detection still read the bank
  text. Lists, upcoming bills, recurring charges, merchants and the Compass bubbles show and group by
  `display_name` when it is set. The Transactions row shows the bank description underneath, and
  search matches either.
- **Renamed payees** on the Transactions filter bar lists every rule with its match count and a Remove
  button. API: `GET/POST /api/transactions/name-rules`, `POST /api/transactions/name-rules/preview`
  (`{pattern}` or `{description}`) and `DELETE /api/transactions/name-rules/{id}`.

## Verify on staging

- An unauthenticated financial API request returns 401.
- Owner setup can be completed only with the configured token and only once.
- Create two accounts. Add different transactions, merchant rules, staging rows,
  loans and goals. Neither account should see or modify the other's records,
  including when requesting known record IDs.
- Each account can use the same category/merchant names independently.
- A missing balance shows unavailable, not a funded forecast. A checked Fixed
  Payment debit creates a last-month template; an unchecked one does not.
- Review categorization previews before approving changes. Fixed flags remain
  unchanged and manual category corrections remain protected.
- Correct a transaction's category and verify its normalized merchant mapping
  is used on a later import. Create and rename a category; delete a test
  category into a replacement and verify its transactions and merchant mappings
  move with it.
- Check goal funding across all active goals together; the same surplus must
  not be assigned in full to every goal.
- A loan marked as not yet included in imported spending reserves its minimum
  payment separately. Existing imported loan payments must not be counted twice.
- Import a checking file and a savings file that both contain the same transfer.
  The transfer appears once under "Saved this month" and the dashboard spending
  and income totals do not include it. A transfer to an unknown account number
  appears on the Accounts page as Needs review until its type is chosen.
- Logout removes access, and another person's subsequent login must not show
  cached data from the previous account.

Automated regressions use embedded PostgreSQL and temporary HTTP servers without
touching the configured live database. Run `npm test`. Browser smoke tests, when
present, also use synthetic data only.

## Removed unsafe legacy routes

`/api/bulk-import/execute-final` returns 410 rather than loading shared financial
fixtures. Use private CSV/PDF imports instead. `/api/categorizations-lite` returns
410 instead of accessing shared SQLite records. `/api/logs` returns 403 because
global logs may contain multiple users' activity; use the admin console's audit
search or restricted deployment logs instead.

Do not expose PostgreSQL or operator logs publicly. Use encrypted backups,
restricted operator access, monitoring, and a retention policy. Account isolation
does not by itself make a public financial product production-certified.
