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
after seven days and are revoked on logout. Authentication attempts are limited
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

## Admin console

Open `/admin.html` while signed in as an admin (account 1 is the admin). It
provides service health and configuration warnings, user search (account
metadata only, never financial data), password-reset email, unlock, sign out
everywhere, a dedicated **Error logs** view filterable by time range and request
ID, a separate **Audit trail** filterable by event, outcome, user, email or
request ID, support sessions, and an API explorer generated from
`/api/admin/openapi.json` that can send test requests and shows status, latency
and request ID. Customers can never reach admin endpoints.

Use the request ID shown in the Error logs view to locate the matching entry in
the hosting provider's restricted stdout logs when a server stack trace is
needed. The app deliberately does not provide a browser endpoint for global
operator log files. Frontend HTML, JavaScript and CSS responses require
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
