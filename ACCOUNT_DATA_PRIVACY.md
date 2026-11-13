# Account data privacy and isolation

This describes the controls implemented in the application, not a security
certification or a guarantee that a particular hosting environment is configured
correctly.

The public [technical security whitepaper](frontend/security.html), served at
`/security`, explains the cryptographic parameters, data flows, TLS boundaries
and deployment-dependent storage protections. It is linked from the homepage.

## What is separated

Each **household** has a private workspace. Household members use separate
logins and passwords and can view/edit that household's financial records.
Only the household owner can invite/remove members, manage billing or grant
operator support access. Imported bank accounts are not separate tenants.
Transfer reconciliation can match transactions between accounts within the
household. A different household gains no access by knowing record IDs.

The server derives the login identity from a validated session and resolves its
current household membership in privileged storage. A household's immutable
tenant key is its original owner's user ID; existing financial `user_id` values
remain intact during migration. Client-supplied user/household IDs never select
the financial tenant. `AsyncLocalStorage` preserves the verified household
context and distinct login identity across asynchronous work.
Financial database operations recheck membership and run
inside a transaction with `SET LOCAL ROLE finance_app_runtime` and a
transaction-local `app.user_id` set to the household tenant key. The transaction-local setting prevents identity
from leaking to the next request when a pooled connection is reused.

The runtime role is `NOLOGIN`, `NOSUPERUSER`, and `NOBYPASSRLS`. PostgreSQL
row-level security uses both `USING` (visible rows) and `WITH CHECK` (written
rows), matching each row's `user_id` to that context. Policies are enabled and
forced on the private tables, including transactions, accounts, import batches
and recovery reviews, categories, merchant/name rules, staging, debts, budgets,
goals, and planning profiles. Missing context exposes no private rows and cannot
create private records. Composite foreign keys also prevent linking a transaction
to another household's account, import, or merchant label.

Authentication, administration, and audit storage use a separate privileged
transaction path. They are not protected by the financial runtime role's
policies; their routes must enforce authorization and subject-user filters.
The customer activity endpoint filters by the authenticated workspace.
Administrators have access to operational information and audit metadata such
as account identity, import filenames, and recorded change details.

Implementation: [tenant context](backend/utils/tenant.js),
[database transactions](backend/db.js), [schema and policies](backend/utils/schema.js),
[authentication](backend/routes/auth.js), and [customer activity](backend/routes/activity.js).

## Sign-in and session guard rails

- Optional TOTP MFA is available per login in Settings & support. Enrollment
  requires the current password and proof of a six-digit authenticator code.
  An enrolled user's password alone never issues a sign-in session: an untrusted
  browser must supply a factor, while an explicitly trusted browser must also
  present its valid trust cookie.
  Pending secrets expire after ten minutes and are AES-256-GCM encrypted using
  the separately configured `MFA_ENCRYPTION_KEY`, bound to the login ID.
  Codes use HMAC-SHA-1 with random 160-bit secrets, 30-second periods and a
  one-period clock tolerance. The authenticated enrollment response includes
  a locally server-generated PNG QR encoding the setup URI; no external QR
  service is used. Scanning imports standard SHA-1 TOTP settings in compatible
  apps such as Google Authenticator and Microsoft Authenticator.
  Manual fallback uses time-based SHA-1 defaults. QR and key contain
  the same private secret and are cleared on confirmation and session reset.
  Successful time steps cannot be reused.
- Ten single-use recovery codes are shown on enrollment/replacement and stored
  as SHA-256 hashes. Disabling MFA or replacing recovery codes requires both
  the current password and an authenticator/unused recovery code. Enrollment
  and disabling revoke other sessions. Password resets preserve MFA.
  MFA changes are unavailable in demo/support sessions. There is no email-only
  MFA reset. Administrators can disable MFA for account recovery after
  independently verifying the owner, confirming the target email and
  reauthenticating with their password and own factor if enrolled. This audited
  override deletes MFA and recovery codes, revokes sessions, support access and
  browser trust, and attempts a security email (delivery failures are surfaced).
  Password-only login then works until the user voluntarily re-enrolls MFA.
  This makes administrator security and identity-verification procedures part
  of the MFA recovery trust boundary; save separate recovery codes securely.
- After MFA verification, users can explicitly trust a personal browser for
  ninety days (unchecked by default). A random token is stored in an HttpOnly,
  SameSite=Strict, host-only cookie, Secure in production; only its SHA-256 hash
  and account/timestamps are stored server-side. It rotates on sign-in without
  extending expiry and is not a hardware identity or financial-data session.
  Passwords remain required, and ten-minute idle/twelve-hour sessions are unchanged.
  Settings can forget all browsers and sign out other sessions. Normal logout
  preserves trust; password changes/resets, MFA changes and administrator
  session revocation remove it. Cookie theft plus password theft can bypass
  the MFA prompt, so shared/public browsers must never be trusted.

- Passwords are stored as salted scrypt hashes, not recoverable plaintext.
  New passwords must be 12 to 128 characters.
- New public registrations must verify their email before Stripe Checkout.
  Verification links are hashed, single-use and expire after 24 hours. Existing
  logins are grandfathered verified by the migration; this is not retrospective
  proof that those historical addresses were verified.
- Email invitations are owner-only, hashed, email-bound, single-use and expire
  after 48 hours. Possession of the invitation plus a matching email is required
  to create a new member login even when public registration is closed.
  A household supports ten members/pending invitations, with invitation throttling.
  Existing logins with financial history or paid access cannot silently merge
  households. Removing a member revokes sessions; subsequent financial requests
  recheck membership. An already-authorized read in flight may finish.
- Random 256-bit session tokens are stored as SHA-256 hashes in the database.
  Cookies are HttpOnly and SameSite=Strict, and Secure in production.
- Sessions expire after 10 minutes without user interaction, with a separate
  12-hour absolute expiry. Background requests do not extend inactivity.
- Login/reset attempts are limited by hashed email/IP keys. Password reset
  links expire after 30 minutes, and a completed reset revokes existing sessions.
- State-changing API requests must come from the configured application origin.
  Production requires an HTTPS `APP_ORIGIN` and sends HSTS and anti-framing headers.
- Session expiry/sign-out hides confidential views. Diagnostics discard stale
  responses and clear cached import metadata when the session locks.
- API responses use `Cache-Control: no-store`. This does not eliminate all
  browser, operating-system, or infrastructure copies.

Implementation: [passwords](backend/utils/passwords.js),
[authentication](backend/routes/auth.js), [HTTP controls](backend/app.js),
[browser session](frontend/session.js), and [session guard](frontend/session-guard.js).

## Billing and household permissions

Basic is USD $4.99/month per household; Pro is USD $7.99/month. New accounts
receive 15 days of Pro at registration, managed by the app without a card or
Stripe trial configuration. Without a subscription, access expires automatically
and no charge occurs. After verifying email and consenting to billing, the owner
can subscribe through Stripe-hosted Checkout. This charges immediately, ends any
remaining free trial and renews monthly until cancelled. Existing Stripe-managed
trials retain their original terms. Paid access comes from signed webhooks and
current subscription state, never a success redirect.

Trial eligibility is persisted per household. Cancelling and signing in again,
or resubscribing under the same account, does not grant a second trial. Registering
the same normalized email again is rejected. This is not person-level anti-abuse:
the app cannot identify someone creating an unrelated account with a different
email address, and does not currently prevent that person receiving another
household trial.

Card details stay with Stripe; this app stores customer/subscription IDs,
plan/status and timestamps, not PAN/CVC. Billing owner name/email are sent to
Stripe; financial transactions and bank statements are not. Stripe is an
external payment processor, so financial privacy does not mean zero third-party
processing of billing information.

Only the owner can open Checkout or the Stripe billing portal. All members share
the household entitlement. Cancelled trials retain Pro until their end; access
then locks unless there is active paid access. Account controls and sign-in
remain available. Legacy paid licenses retain Pro without being charged or
automatically moved to Stripe. A background worker emails only the household
owner when 24 hours remain. Deployment uptime and SMTP delivery are necessary
for timely receipt; database-backed markers prevent routine duplicate sends,
but a crash between email delivery and commit can cause a repeat.

Membership, authentication, invitation tokens and subscriptions are privileged
metadata, not financial runtime tables. The runtime role has no grants on them.
Audit events distinguish the acting login from the subject household.

Implementation: [households](backend/utils/households.js),
[membership routes](backend/routes/household.js), [billing](backend/utils/billing.js),
[Stripe webhook and access gate](backend/routes/billing.js).

## Support and administrator access

Support tickets are private to the submitting login, not shared household
financial records. Administrators can read submitted case descriptions and
update statuses with a required customer-visible progress or resolution message;
timestamped messages are retained in ticket history and shown to the submitting
login with the latest 20 cases. Cases are retained
until the login is deleted. Opening a case sends its description, optional
category and contact email to myfinanceapp.support@gmail.com via configured
SMTP. No bank records are attached automatically; users are warned not to
include credentials or full account numbers. Case text is not added to audit
logs. Opening a ticket does not grant financial access.

An administrator's normal financial requests use their own workspace, not a
customer's. The in-app support workflow requires the customer to create a grant
with a duration of 1 to 72 hours and read or write access. Case details stay in
the ticket card; new grants record a standard consent purpose rather than ask
for the same problem description again. Ticket events are not shown in grant
activity. Read-only
is the default. Grants expire and can be revoked; revocation removes associated
support sessions. Each support request records the actor, subject workspace,
grant, outcome, and request ID. Read-only support is enforced both at the route
layer and by a PostgreSQL read-only transaction.

Financial Checkup findings use the runtime connection and household row-level
security, never administrative queries or a browser-provided target user ID.
No bank tokens are included in findings responses. Results cover only the
signed-in user's intentionally shared household workspace, not unrelated
customers. Session lock clears financial views and the session fetch wrapper
discards responses after account changes. Findings are unavailable during support
sessions and are not sent to an external AI service.

This is **not** a promise that nobody else can access the data. Authorized
database/hosting operators retain infrastructure-level access, and the server
uses a privileged database connection for migrations and administrative tasks.
Administrative account recovery and access to backups/logs are also part of the
trust boundary. The data is not end-to-end encrypted with user-held keys.

Implementation: [support grants](backend/routes/supportAccess.js),
[support tickets](backend/routes/supportTickets.js),
[session authorization](backend/routes/auth.js), [admin operations](backend/routes/admin.js),
and [audit recording](backend/utils/audit.js).

## Storage, transport, and retention boundaries

Statements are processed on the application server. This import-based workflow
does not require bank credentials, connect to a bank, or initiate money movement.
The Financial Checkup is computed locally by the application, not by sending
records to an external AI service. Hosting, database, and configured email
providers still process the data needed for their roles.

Financial records and import-recovery backups are not encrypted at the field
level by this application. Database volume encryption, backup encryption,
retention, physical access controls, and secrets management depend on deployment.
Database TLS with certificate validation is enabled when `DATABASE_SSL=true`;
it is not enabled unconditionally by the code. Browser HTTPS depends on the
deployment's actual TLS endpoint, not just the `APP_ORIGIN` setting.

Undoing an import is not permanent erasure: its transaction rows are retained
in the import batch's recovery backup so they can be restored. Audit events may
retain filenames and change metadata. An operator must include recovery data,
audit/log retention, and infrastructure backups in any deletion/retention policy.
Do not claim zero-knowledge storage, universal encryption at rest, mandatory or phishing-resistant MFA, or
independent compliance certification based on these controls alone.

## Advanced diagnostics and performance

The administrator's **Traffic** tab shows UTC calendar-day homepage views,
signup-intent clicks, successful demo logins and public registrations. Views
count signed-out homepage loads after successful account-status checks, not
unique visitors. Signup clicks include the registration switch and enabled
public start/plan buttons. They are not completed registrations or paid
subscriptions. Invited members are excluded from public-registration totals.

Only day/event/count aggregates are stored for views/clicks; reporting omits
cookies and accepts no email, referrer, full URL or financial payload.
IP-derived abuse-limit keys are transient in memory, not stored in counters.
Authentication audits retain their separate identity metadata. Counters are
purged after 365 calendar days by audit maintenance; sign-in/registration
coverage depends on audit retention. The panel does not attribute visits to
Reddit, reconstruct visits before deployment, or measure distinct demo testers.
Repeated clicks, JavaScript-capable bots, blocked scripts, failed requests and
rate limits affect counts.

Open **Advanced diagnostics** in the navigation for Transaction troubleshooting
and Activity log. Troubleshooting first loads at most 30 import metadata entries,
with cursor-based loading of older imports; it does not fetch transaction data
until an import is chosen. Each request returns 50 transactions, filtered by import
and handling status on the server. Import metadata omits recovery backups.
Original imported/duplicate counts are historical processing counts, not a claim
about today's active transaction count. Undone imports have no active rows.
Older untracked transactions have an explicit fallback selection.

Composite indexes support per-user import lookup and date-ordered transaction
pages. Count queries and offset pagination are limited to the selected import
in this UI, but very large individual imports can still incur counting/deep-page
costs. Activity is separately paged at 50 events. Existing API callers that omit
`importId` retain the prior bounded workspace review behavior.

## Verification and deployment responsibilities

`npm test` includes embedded PostgreSQL policy tests, cross-user reads/writes and
reference checks, session/support tests, and HTTP/frontend import-review tests.
These test the implementation without using the live database; they do not
verify the production host, TLS termination, operator privileges, or backups.

Before making customer-facing security guarantees, confirm production HTTPS,
database TLS, encrypted disks/backups, least-privilege operator access, SMTP
configuration, retention/deletion procedures, and the deployed schema/runtime
role. See [deployment guidance](DEPLOYMENT.md).
