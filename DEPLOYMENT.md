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

### Optional authenticator MFA

Set `MFA_ENCRYPTION_KEY` on the application service before users enroll. Generate
a separate 32-byte Base64 key locally:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store it as a protected Railway deployment secret and keep a secure recovery
copy. Do not reuse the Plaid key, commit it, or replace it without re-encrypting
the `user_mfa` secrets. A missing/wrong key prevents enrollment or TOTP
verification on untrusted browsers; there is no automatic password-only fallback.
An explicitly trusted browser can use password plus its valid trust cookie.
Recovery codes remain usable if the encryption key is unavailable, but they do
not repair encrypted secrets. Do not advertise automatic key rotation.

Users enable optional TOTP in **Settings & support** with their current password
and a six-digit authenticator code. Setup uses HMAC-SHA-1, six digits and
30-second periods with random 160-bit secrets for standard TOTP compatibility,
including Google Authenticator and Microsoft Authenticator (Other account).
Users can scan the enrollment QR to import settings automatically, or expand
the manual-key fallback using standard time-based SHA-1 defaults.
The server generates a PNG QR locally from the `otpauth://` URI with
`algorithm=SHA1`; no external QR service receives secrets.
SHA-1 collision attacks against signatures do not directly break HMAC-SHA-1
TOTP. This choice is specific to TOTP; token/recovery hashing stays SHA-256
and secret encryption stays AES-256-GCM.
The QR is returned only in the authenticated, no-store enrollment response and
cleared from the page on confirmation, MFA disable, and session lock/reset.
The QR and manual key contain the same secret; do not screenshot or share them.
On one phone use the manual fallback. This pre-release change assumes
no deployed MFA enrollments; any older development enrollment must be disabled
before upgrading and re-enrolled afterward. Verification uses only the
enrolled SHA-1 configuration, not a try-both-algorithms fallback.
Secrets are AES-256-GCM encrypted with user-ID-associated
data; pending enrollment expires in ten minutes. A one-step clock tolerance is
accepted and used steps cannot be replayed. Confirming enrollment signs out
other devices and support sessions. Ten independent 128-bit recovery codes
are returned once and stored only as SHA-256 hashes; use is atomic and single-use.
Replacing codes or disabling MFA requires the password and a valid factor.
Using a recovery code consumes only that code. Replace the set when running low
or if it may have been exposed: in Settings, provide the password and an
authenticator code or another unused recovery code and choose **Replace recovery
codes**. All old codes are invalidated; securely save the ten new codes.
This does not restore a lost authenticator. Without an authenticator backup,
disable MFA using the password and an unused recovery code, then immediately
enroll the replacement authenticator.
Password reset never removes MFA. There is no email-only MFA reset.
For lost authenticators and recovery codes, an administrator can use **Users >
Reset MFA** after independently verifying the account owner's identity.
The endpoint requires the target email, explicit identity-verification
acknowledgment, the administrator's current password and, if enrolled, the
administrator's own authenticator or unused recovery code. The checkbox is
not proof of identity: operators must establish a recovery-verification policy
and resist social engineering before using this privileged override.
Reset removes active and pending MFA and all old recovery codes, revokes the
target's sessions, support grants and browser trust, and records an audit event.
It attempts a security email and explicitly warns the administrator if delivery
fails. The existing password is not changed; the user can sign in normally and
should immediately enroll MFA again. No automatic re-enrollment requirement or
waiting period is enforced. Protect administrator accounts with MFA. An admin
who loses their own factors cannot bypass the required administrator factor
with this endpoint; another authenticated administrator is needed.
TOTP is not phishing-resistant. The public demo and support sessions cannot
change MFA. Every household member enrolls independently; MFA is not required
globally, and this does not implement passkeys or an independent security audit.

### Trusted browsers (90 days)

After a successful authenticator or recovery-code sign-in, users may explicitly
check **Trust this browser for 90 days**. It is unchecked by default. Password
verification remains mandatory; only the MFA prompt is skipped on that browser.
This uses a random 256-bit token in an HttpOnly, SameSite=Strict, host-only cookie
(`__Host-finance_trusted`, Secure in production). The database stores only its
SHA-256 hash, account binding and timestamps. Tokens rotate at trusted sign-in
without extending the original 90-day expiry. At most twenty records per login
are retained. No device fingerprint or SMS service is used.

Settings lists remembered browsers by timestamps and identifies the current
cookie; **Forget all trusted browsers** revokes their tokens and signs out other
sessions, keeping this session open. Normal logout retains browser trust.
Password changes/resets, MFA confirmation/disable/recovery-code replacement,
and administrator session revocation invalidate trust. Password reset still
preserves MFA. Clearing cookies, expiry or a different browser requires MFA.
Session limits remain ten minutes idle and twelve hours absolute. Never trust
shared/public browsers: possession of the cookie plus password bypasses the
second-factor prompt. This is a convenience/security trade-off, not
hardware-bound or risk-based device recognition.

Set secrets in your deployment platform, never in source control:

```text
DATABASE_URL=postgresql://<migration-user>:<password>@<host>:5432/<database>
NODE_ENV=production
APP_ORIGIN=https://<your-app-domain>
OWNER_SETUP_TOKEN=<cryptographically-random-token-at-least-32-characters>
ALLOW_REGISTRATION=false

# Stripe: USD recurring monthly prices, one subscription per household
STRIPE_SECRET_KEY=<Stripe secret key from the same test/live environment as the prices>
STRIPE_WEBHOOK_SECRET=<signing secret for this deployment's webhook endpoint>
STRIPE_BASIC_PRICE_ID=<active USD 9.99 monthly recurring price>
STRIPE_PRO_PRICE_ID=<active USD 14.99 monthly recurring price>

# Password-reset, security-notice and support-ticket email
SMTP_HOST=<smtp-host>
SMTP_PORT=587
SMTP_SECURE=false            # true for implicit TLS, usually port 465
SMTP_USER=myfinanceapp.support@gmail.com
SMTP_PASS=<smtp-password>
SMTP_FROM="MyFinanceApp <myfinanceapp.support@gmail.com>"

# Optional Plaid connection and transaction sync
PLAID_CLIENT_ID=<Plaid Dashboard client ID>
PLAID_SECRET=<Sandbox secret>
PLAID_ENVIRONMENT=sandbox
PLAID_TOKEN_ENCRYPTION_KEY=<base64-encoded 32-byte key>

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

Generate the Plaid token-encryption key separately:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Plaid is optional. Configure `PLAID_CLIENT_ID`, the matching environment secret,
`PLAID_ENVIRONMENT=sandbox` (or `production` after Plaid production approval),
and the encryption key before enabling bank connections. Never send credentials
or encryption keys to customers or store them in source control. Changing the
encryption key without first re-encrypting stored Plaid access tokens will make
existing connections unusable.

Link tokens specify the public webhook URL
`<APP_ORIGIN>/api/plaid/webhook`; configure the matching HTTPS origin in Plaid
and make that endpoint reachable from Plaid. The endpoint verifies Plaid's
ES256 webhook signature and exact raw request-body hash. Keep the public
application origin stable. For local development, use a Plaid Sandbox-capable
public HTTPS test environment rather than disabling webhook verification.

The Connect bank dialog temporarily closes while Plaid Link is open so the
browser's native modal layer does not obscure Link. It reopens when linking
completes, is cancelled, or fails, showing connection status or errors.

Transactions are requested with up to 365 days of initial history. Webhooks
trigger cursor-based transaction sync, and the server retries missed updates
with a daily catch-up sync. Sync applies additions, modifications, removals and
pending-to-posted replacements atomically with the cursor update. A linked
checking balance is included in the runway only after the user selects it.
Plaid account balances can be institution-cached or delayed; the app shows
their last app-check time and warns users to verify the bank balance before
relying on projections. It does not call a separate paid real-time balance
endpoint.

Scheduled failures record their error and attempt time after rolling back the
failed sync. Transient failures wait at least six hours before a scheduled retry;
invalid items require user attention instead of being retried hourly.
The sync response distinguishes provider-reported changes, newly saved records,
automatically linked exact matches, included duplicate flags and older held records.
Transactions > Review possible duplicates opens a searchable, paginated queue.
Each card states whether the record already counts in totals. Successful decisions
remove the card immediately; repeated submissions of the same decision are
idempotent. A change to an unrelated candidate does not invalidate a still-valid
selected match. Keep both clears the flag without inserting a second copy, and
the decision is respected by the Plaid/statement duplicate list.
Connection details distinguish the last successful check from the latest saved
bank activity date. A successful incremental check cannot prove the institution
has delivered today's payroll; the app does not invent a deposit from a forecast.
The Accounts panel also shows successful Plaid sync and attempt times separately
from saved activity/statement dates. It associates a saved account with Plaid only
when institution (normalized spelling), last four digits and account type identify
one account on each side within the household. Ambiguous or incomplete identities
do not inherit another account's sync time. Verified linked activity contributes
to the card's transaction count, date range and last-added time. Recorded statement
balances and their dates remain unchanged. Manual sync refreshes the Accounts
panel, including zero-change syncs.
Changing `PLAID_ENVIRONMENT` does not convert saved access tokens. An identified
cross-environment token is blocked before remote sync or update-mode Link.
Disconnect that old connection and use Connect bank in the current environment.
Disconnect keeps transaction history. For a known cross-environment token it
removes the local connection only, explicitly reporting that remote revocation
was not performed; manage the old item in its original environment separately.

Transactions support a household-visible plain-text note of up to 500 characters.
Use Add note/Edit note on the transaction row; save an empty note to remove it.
Notes appear beneath the bank description, participate in transaction search,
and are included in transaction CSV exports. They do not rename a merchant or
change bill matching. Plaid modifications preserve notes; duplicate merges retain
both distinct notes and require editing first if their combined length exceeds
500 characters. Audit events record the transaction ID, not note text.
Notes follow the transaction lifecycle: deleting the transaction (including a
provider removal) deletes its note. Do not store credentials or full account
numbers in notes.

Plaid amounts use the same convention across institutions: positive amounts are
money out (DEBIT), negative amounts are money in (CREDIT). The app stores positive
magnitudes and requests `options.include_original_description=true` on every
Transactions Sync page. The original bank description is stored as the transaction
description when nonblank, falling back to Plaid's name, then merchant name.
This preserves available recipient wording for rename rules and analytics.
If the bank only supplies a generic payment-app name, the recipient remains unknown.
Transaction lists, category transaction details and transaction troubleshooting
show the originating account's type, institution, name and masked last four digits.
Plaid account metadata takes precedence for bank-linked rows, including merged
statement rows; unlinked statement/manual records use their assigned account.
Unknown/unassigned accounts are labeled explicitly. Transaction search also
matches this account information (for example `credit card`, an issuer or `5237`).
The Transactions Account dropdown filters by the actual linked account identity,
not name matching, and combines with the date, category and other list filters.
It includes accounts with stored transactions and an unassigned-account option
when applicable. Separate statement and Plaid accounts are not guessed to be the
same account; explicitly merged rows belong to their linked Plaid account.
This describes the account holding the transaction, not the payment recipient;
it does not change transaction amounts, transfer treatment or debt-plan settings.

### Usability and unpaid fixed payments

Startup adds the household-private `fixed_payment_occurrences` table. The dashboard
uses fixed debit history to estimate monthly occurrences starting after the first
observed payment, limited to last calendar month and the next 30-day horizon.
Unpaid estimates retain snapshots if source transactions are deleted, but estimates
older than last month are excluded from display and cash projections and removed
on the next writable dashboard load. Previous-month items
appear in a separate overdue section in both calendar and list views.
These are estimates awaiting confirmation, not proof that a creditor is unpaid.
Posted matching payments resolve their own calendar month's occurrence, even
when paid before its estimated day. A newer month's payment is never assumed to
pay an earlier month. Automatic matches are recalculated on dashboard load to
repair saved oldest-first assignments that left already-paid bills overdue;
explicit paid/ignore choices are preserved. Pending transactions do not resolve
an occurrence. Matching uses the existing bill/merchant and
account rules, not a creditor's invoice or a guaranteed due date.
Renamed and original descriptions are compared independently so a display-name
change does not create a second bill. Amount changes do not prevent matching:
the recorded amount resolves its own month's estimate, and the latest amount
supplies future estimates. Shortened provider descriptions may match only with
a known shared owning account and a single candidate: either an exact payee
with a missing masked reference or at least two distinctive merchant words.
Conflicting masked payees are never matched. CSV/Plaid source accounts require
matching institution, four-digit source mask and known account kind.
Missing source identity and competing payees remain unmatched. Categories and the newer payment's Fixed
flag do not determine whether it settles a bill. Saved duplicate monthly estimates
are consolidated while explicit paid/ignore choices are retained.
New forecasts require a fixed payment within the current or previous two calendar
months. A last-month overdue estimate additionally requires fixed-payment evidence
in the month preceding it. Old fixed flags cannot revive a bill that disappeared
months ago; saved stale automatic estimates are removed on the next writable load.
Recent unpaid estimates survive source deletion within this evidence window.
Mark paid confirms one occurrence without creating a transaction or changing
recorded cash. Ignore removes only one occurrence, not future recurrence.
Removing the Fixed flag from matching transactions stops future projections,
but does not silently discard already overdue occurrences.
A later imported payment for the same month attaches to an unmatched paid
confirmation. Read-only support can preview but not persist or
resolve payments. Paid history and cash projections do not deduct confirmations
again. The history drawer now has 24px of space before the payment legend.

Categories includes a searchable checkbox dropdown with multiple selections.
Search narrows choices; once categories are selected, their combined cards,
totals and detail data remain visible while searching for another category.
Reset clears both search and selection; household/session changes clear private
options and selections.

Public `/about` and `/contact` pages are accessible without signing in. Welcome
and About explain verified protections (household database access rules, password
hashing, HTTPS in production, encrypted Plaid tokens and consented support), without
claiming certification or zero risk. Contact uses myfinanceapp.support@gmail.com
and warns against emailing credentials or financial records. Production HTTPS
and infrastructure controls remain deployment responsibilities.
Updates to merged statement/manual records preserve their existing descriptions
and user display names instead of replacing them with Plaid wording.
This applies to new and modified transactions, including pending-to-posted changes.
Existing unchanged Plaid history is not automatically re-fetched; normal Sync only
returns changes since the saved cursor. Do not delete history or reset cursors just
to refresh descriptions.
This also applies to credit-card purchases, payments and refunds; a credit is not
automatically salary.
Income review excludes money moving between accounts; recognizable bill payments,
refunds and card-payment credits are not automatically treated as pay merely
because a merchant is marked fixed. Explicit income choices still apply to
non-transfer deposits.

On the first startup with the direction fix, a transactional, one-time migration
repairs existing `source='plaid'` transactions and import-review records for every
household, including disconnected banks. It preserves transaction IDs, amounts,
fixed flags and manually corrected categories. Income overrides on corrected
outflows and payment modes on corrected inflows are cleared. Automatic categories,
transfer classifications and pending review candidates are recalculated.
Statement/manual entries and resolved review decisions are not changed.
Back up the database and stop old app instances before deploying this update so
they cannot import with the old convention during migration. Reload the app after
deployment to refresh totals and forecasts; no bank reconnection is required.
If the faulty imports already overlapped statement history, review those existing
duplicates explicitly; the migration does not delete previously accepted records.

For already-imported Plaid / statement duplicates, open **Transactions > Review
Plaid / statement duplicates**. Review each pair's account, date and description.
Same amount and direction within three days only indicate a possible match;
known different account masks are excluded. Posted USD Plaid records are compared
with existing unlinked statement/manual records. Pending records are not merged.
Each merge requires confirmation and rechecks both records and their displayed
settings atomically. The existing record keeps its ID, source, categories, fixed
flag, income decision and payment mode; the extra Plaid row is removed and its
Plaid identity is attached to the retained row. Future sync uses that identity
instead of inserting a second copy. Existing review references follow the retained
record. A stale match, already-linked record, foreign household, or Plaid row with
import restore history cannot be merged. There is no Undo. Leave uncertain matches
and genuine separate deposits unmerged. Totals and forecasts refresh after merging.
This review does not find statement-only or Plaid-only duplicate pairs.

Duplicate review supports individual checkboxes, **Select unambiguous on page**,
**Select all unambiguous (max 500)**, and **Merge selected** with one confirmation.
Selection persists across pages; **Clear selection** or **Refresh matches** clears
it. Select-all includes only globally one-to-one matches, never competing pairs or
Plaid rows with restore history. These are still possible matches, not guaranteed
duplicates: review the selected account/date/description pairs before confirming.
Ambiguous matches may be selected individually, but a transaction may belong to
only one selected pair. A batch contains at most 500 pairs. Larger select-all
requests fail explicitly; select reviewed pages in batches instead.
Bulk merging is atomic: one stale, missing, foreign, or conflicting pair rejects
the entire batch. No partial cleanup is committed. Totals refresh once per batch.
Selections clear on merge completion/failure and household changes.

All imports share server-side value validation, but Plaid uses nonblocking overlap
handling: distinct provider IDs are never deduplicated against each other by
amount. Only unlinked, posted, non-Plaid history with a matching merchant, amount,
direction and date within three days can become a candidate; known different
account masks/types are excluded. A unique candidate links automatically only
with the same day and full description (case/whitespace normalized) and verified
account mask, institution and type. Pending bank records, incomplete account
identity, competing candidates or repeated identical incoming rows do not
auto-merge. Existing categories, names, notes and payment settings are preserved.
Other plausible matches are saved in history and totals with a possible-duplicate
flag; both entries count until merged. Different merchants with equal amounts
do not generate flags. Plaid IDs remain unique per household and replays are
idempotent. On the next successful sync, older held records for that connection
are processed by the same rules even if the provider returns no new changes.
CSV/PDF review flows are unchanged. No heuristic proves identity from incomplete
bank details, so ambiguous cases are not silently deleted.
Disconnecting revokes the Plaid Item and removes its encrypted access token and
account balance settings; already-imported transaction history is retained.

For targeted cleanup, open **Transactions > Bulk transaction cleanup**. Filter
by first-imported/synced date (inclusive UTC calendar days) or bank transaction
date, source, and description. Select individual rows, a page, or all matches
across pages (up to 10,000; narrow larger searches), then confirm permanent
deletion. This deletes only the explicitly selected owned transaction IDs, with
no Undo/Restore backup. It does not alter saved statement or Plaid balances,
disconnect banks, or remove pending import-review records. Plaid IDs are not
suppressed: later sync changes or reconnection may recreate deleted rows.
Disconnect Sandbox banks before cleaning up test data. First-imported dates
reflect row creation, not the last sync time; missing creation dates cannot be
matched by that filter. Use bank dates instead for those records.

Before production, complete Plaid's production approval and review its current
product, pricing, privacy, and consent requirements. Update the app's privacy
notice to explain that users who choose bank connection share account and
transaction data with Plaid and their institution. Do not enable public
connections until the Sandbox flow, data-quality review flow, webhook
reachability, and production environment have been tested end to end.

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
administrative connection is used by schema setup, authentication, membership,
billing/webhooks and audited administration. Financial queries continue to use
the restricted role and household tenant context.

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
ready. The current runtime dependency audit reports 17 advisories, including two
critical advisories. Review and remediate these before public launch; the billing
implementation and passing application tests do not constitute dependency
security clearance. Run `npm audit --omit=dev` against the installed lockfile;
some available fixes require major-version upgrades and separate regression
testing. New users receive independent empty budgets and category lists.
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

New public registrations receive single-use email verification links, valid for
24 hours. Checkout is blocked until verification completes. SMTP is required for
registration, invitations and reminders; existing logins are grandfathered
verified. SMTP connection, greeting and socket timeouts are bounded so an
unresponsive mail server does not hold registration or reminder transactions
indefinitely. Optional authenticator MFA is implemented; self-service account deletion is not.

## Household subscriptions and Stripe rollout

For a structured, step-by-step checklist covering Stripe Dashboard setup, server
environment variables, restart instructions and acceptance tests, see
[the readable HTML guide](./STRIPE_SETUP.html) or
[STRIPE_SETUP.json](./STRIPE_SETUP.json). These are documentation with placeholders,
not a configuration file loaded by the application; enter secrets in your host's
environment settings.

Keep `ALLOW_REGISTRATION=false` throughout staging. This migration creates a
household and owner membership for every existing independent user, without
moving financial records. Both legacy paid tiers become new Pro licenses to
preserve their features. They are not charged or automatically subscribed in
Stripe. Unpaid households must select a plan, verify email and complete Checkout;
old no-card trials do not grant financial access. A previously used trial is
not restarted. Back up the database before migration; do not roll back application
code without a compatible schema/plan migration.

1. Create Stripe test-mode recurring monthly prices: Basic **USD 9.99** and Pro
   **USD 14.99**, quantity one per household. Configure the environment variables
   above. Checkout verifies currency, amount, interval and active status.
2. Register **POST `/api/billing/webhook`** with Stripe for
   `checkout.session.completed`, `checkout.session.expired`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.trial_will_end`,
   `invoice.paid`, `invoice.payment_failed`, `subscription_schedule.created`,
   `subscription_schedule.updated`, `subscription_schedule.released`,
   `subscription_schedule.completed`, `subscription_schedule.canceled` and
   `subscription_schedule.aborted`. The endpoint verifies the raw
   body and Stripe signature; do not proxy-transform it. It does not use browser
   sessions or browser CSRF rules. Events are idempotent, fetch authoritative
   subscription state and fail/retry on processing errors.
3. Test real Stripe **test mode** end to end: hosted Checkout collecting a card,
   Basic-selected trial with Pro access, successful paid conversion to Basic,
   Pro conversion, declined payment, cancellation during trial, cancellation
   at paid-period end, webhook duplicate/reordering, and return from the portal.
   Confirm there is only one subscription/customer per household. No live
   Stripe requests are made by the automated test suite.
4. The app creates a Stripe portal configuration with cancellation at period end,
   payment-method updates and invoices. No card information is stored locally.
   Test your Stripe account's cancellation settings and hosted disclosures before
   launch. Active Basic owners without pending changes or scheduled cancellation
   can use the app's Upgrade to Pro in Stripe button. This opens a targeted
   confirmation flow with immediate prorated invoicing and an unchanged renewal
   date. Pro unlocks only after a verified webhook confirms a paid upgrade
   invoice. Test successful, declined and authentication-required upgrades in
   sandbox. Pro owners (including Pro-selected trials) can explicitly consent in
   app billing to Basic USD 9.99/month starting at the next renewal/trial expiry.
   This uses Stripe subscription schedules because the products are separate;
   do not assume the portal's same-product scheduled downgrade applies.
   Ensure restricted API keys permit schedule create/read/update/release and
   subscription metadata updates. The current Pro phase and original trial end
   are retained, followed by one month of Basic and `end_behavior=release`.
   Neither schedule creation nor phase transition creates prorations.
   Test next-renewal timing, unchanged Pro access beforehand, trial reminder
   Basic pricing, retries after lost responses, duplicate confirmation, member
   rejection, and data preservation at Basic transition. Keep Pro removes the
   scheduled change before the cancellation portal is available; conflicting
   external schedules, cancellation, or payment updates are rejected. Schedule
   events retrieve authoritative live subscription state, not event snapshots.
5. Keep at least one server instance always running. The startup worker checks
   every minute for trial reminders due within 24 hours, using database locks
   across instances. Configure/test SMTP and monitor `billing.reminder_failed`.
   Reminders go to the household owner's app email, not every member or a
   separately edited Stripe receipt email. Downtime can delay reminders; mail
   delivery failures are retried and logged, not treated as success.
6. Verify household invitations and removal with two separate browser profiles,
   plus a third unrelated household for negative isolation tests. Invite links
   expire after 48 hours and membership is capped at ten. Owner removal,
   household transfer and automatic merging of financial data are not supported.
7. Switch to live-mode keys/prices/webhook secret only after staging succeeds
   and billing disclosures, tax obligations, refund/cancellation policies and
   processor requirements have been reviewed. Do not reuse test IDs in live mode.
   Then explicitly enable registration when ready.

Trial duration is 15 days and all trial access is Pro, regardless of selected
post-trial plan. Checkout requires renewal consent and a payment method. A
subscription automatically charges the selected monthly plan unless cancelled.
Cancellation keeps access until trial/paid-period end. Expired, unpaid, paused
or incomplete subscriptions cannot access financial routes, but billing,
membership and authentication remain available. Basic includes core accounts,
imports, transactions and dashboards; Pro adds analytics, budgets, debt planning
and savings goals. Existing manual licenses remain an operator-managed exception.

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

## Numbered support cases

Every signed-in non-demo login, including household members and users without
an active subscription, can open a case in **Settings & support**. A description
of 10-5,000 characters is required; category is optional (up to 80 characters).
Cases receive an `MFA-<id>` number and are saved in PostgreSQL. The user can
refresh their latest 20 cases and see **Open**, **In-Progress**, or **Resolved**.
Older tickets remain stored and available to administrators; the 20-ticket
limit is a history display limit, not deletion. Deleting a login deletes its cases.

The **Support tickets** admin tab filters and pages through cases, advances
statuses Open -> In-Progress -> Resolved, and retries failed email notifications.
New cases are emailed to **myfinanceapp.support@gmail.com**, with the submitter
as Reply-To. SMTP failures do not discard cases: the customer sees an explicit
delivery warning, the administrator sees the failure, and a redacted error is
logged. A retry never resends an already-notified case. Status changes are
visible on the site and do not send additional customer email.

Configure and test SMTP using the support mailbox (for Gmail use its supported
SMTP authentication, such as an app password; never put credentials in source).
The code changes do not transfer ownership or update registrations in Gmail,
GitHub, Railway, Plaid, Stripe or other external services. Update their owner,
contact and notification settings manually, and change deployment SMTP secrets.
Existing database login email addresses are not rewritten by this migration.

Cases contain only customer-entered text; no transactions or account records
are attached automatically. Do not submit passwords, MFA codes or full account
numbers. Opening a case does not grant financial access. Creation, status
changes and notification retries are audited using the ticket ID, not case text.
Demo and support sessions cannot open or read personal cases.

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
