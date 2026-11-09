# MyFinanceApp Logging & Troubleshooting Endpoints

## Current admin console

Sign in as an administrator and open **Bank monitoring** for the bank event console.
Select a customer user ID and/or bank account, then filter severity. **View events**
scopes the timeline to that bank connection. A connection-level failure affects all
its bank accounts; the console labels bank account record IDs and linked app account
IDs separately. No balances, transaction descriptions, provider account IDs or
credentials are returned. Customer names/emails identify the support account.

- **Critical:** authentication/environment attention; automatic sync is stopped.
- **Major:** latest transaction check failed. Read its failed stage and recovery steps.
- **Warning:** no successful check in over 26 hours, never synced, mortgage details
  unavailable, or a pending transaction older than seven days.
- **Clear:** no current alarm, not a guarantee of current bank activity.

Alarms reflect current state and clear automatically on recovery. There is no
manual acknowledgement workflow. Retained events remain searchable after recovery.
Optional 30-second refresh runs only while the monitoring tab is visible.
Shared connection alarms can appear on several bank account rows.

Compare **last successful check**, **latest attempt**, **last webhook**, and
**latest activity date**. Newest transaction date alone cannot establish a stalled
sync. Scheduled scans run hourly; connections become eligible 24 hours after a
success and six hours after an attempt. Webhooks and owner-initiated checks can
run sooner. Relink-required connections need owner action. Plaid calls time out
after 30 seconds; the initial scheduled scan starts after the HTTP listener.

Use **App logs** for customer/connection filtering, grouped causes, failed stages,
error codes, duration, imported/modified/removed/review counts, app request IDs and
Plaid request IDs. Provider responses/configs and financial payloads are not
stored in diagnostic metadata. Match a Plaid request ID in the Plaid dashboard;
match an app request ID in the application log timeline.

If Plaid shows successful `/transactions/sync` requests but a failed webhook
delivery, inspect the app's sync event: a provider HTTP 200 does not mean the app
saved the batch. `PLAID_INVALID_TRANSACTION_AMOUNT`, `..._DATE`, `..._DESCRIPTION`
and `..._RECORD` identify local validation failures at `transactions_validate`.
Transaction writes are rolled back and the cursor is unchanged. Invalid provider
records return HTTP 502 rather than blaming the caller with HTTP 400. Use the
provider request ID to investigate; do not reconnect merely for validation errors.
Zero-dollar authorizations are omitted explicitly, with an `ignoredZeroAmount`
count in successful sync events/results. A zero-dollar modification or replacement
also retires its previous bank-owned amount; linked statement history is preserved.
Users can run **Sync now** from **Accounts**, with progress and results next to the
account, or from the bank connection in the import dialog.

| Endpoint | Purpose |
|----------|---------|
| `/api/admin/bank-health?userId=1&accountId=21` | Admin-only current bank-account health; max 500 rows, explicit truncation |
| `/api/admin/logs?level=info&since=7d&userId=1&connectionId=11` | Admin-only retained sync event timeline |
| `/api/admin/logs?level=warn&since=24h` | Warnings/errors grouped by cause and affected connection |
| `/api/monitor/logs` | Automated monitoring; requires configured monitor bearer token |
| `/api/health` | Liveness, not account sync health |

`accountId` means the internal `plaid_accounts.id`, not a provider ID or linked app
account ID. Sync events use `connectionId`, because Plaid checks the whole bank
connection. Health and log ID filters reject invalid IDs.

All Plaid lifecycle events (including zero-change successes), warnings and errors
are persisted across instances/restarts for `LOG_RETENTION_DAYS` (default 30).
Other info events are held in this instance's bounded live buffer. Log searches
consider up to the newest 5,000 stored matches and return up to 1,000 entries.
History and webhook timestamps begin with this deployment; old discarded
metadata cannot be reconstructed. Database-read failures display a coverage warning.
Apply the normal startup schema migration when deploying these changes.

## Legacy endpoint reference (obsolete)

**Do not use the `/api/logs*` examples below.** Global legacy log access is disabled
with HTTP 403; use the authenticated admin endpoints above. The remainder is kept
only as historical documentation and does not describe the current API.

All endpoints are accessible at: `https://myfinanceapp-production.up.railway.app`

## Quick Reference

| Endpoint | Purpose | Usage |
|----------|---------|-------|
| `/api/logs` | Get recent logs | Quick diagnosis |
| `/api/logs/errors` | Get only errors | Find problems |
| `/api/logs/imports` | Get CSV import logs | Debug imports |
| `/api/health` | Health check | System status |
| `/api/logs/summary` | Activity summary | Overview |
| `/api/logs/search?q=X` | Search logs | Find specific event |
| `/api/logs/filter?module=X` | Filter by module | Module-specific logs |
| `/api/logs/file?date=YYYY-MM-DD` | Get logs by date | Historical logs |
| `/api/logs/list` | List all log files | Available logs |
| `/api/logs/clear?days=7` | Clear old logs | Cleanup |

---

## Detailed Endpoints

### 1. Get Recent Logs
```
GET /api/logs?lines=100
```
**Returns:** Last N lines of logs

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/logs?lines=50
```

**Response:**
```json
{
  "success": true,
  "logs": [
    "[2026-06-03T06:11:02.117Z] [CSV_IMPORT] Starting CSV import",
    "[2026-06-03T06:11:02.118Z] [CSV_IMPORT] Processing 504 records"
  ],
  "total": 2,
  "timestamp": "2026-06-03T06:13:37.500Z"
}
```

---

### 2. Get Error Logs Only
```
GET /api/logs/errors?lines=100
```
**Returns:** Only error lines (contains ❌, ERROR, error)

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/logs/errors?lines=20
```

**Best for:** Finding what went wrong

---

### 3. Get CSV Import Logs
```
GET /api/logs/imports?lines=500
```
**Returns:** Only [CSV_IMPORT] module logs

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/logs/imports?lines=100
```

**Best for:** Debugging CSV uploads

---

### 4. Health Check
```
GET /api/health
```
**Returns:** System health, uptime, database status, memory

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/health
```

**Response:**
```json
{
  "success": true,
  "status": "healthy",
  "uptime": "125 minutes",
  "database": {
    "connected": true,
    "transactionCount": 425
  },
  "memory": {
    "heapUsed": "45.23 MB",
    "heapTotal": "120.50 MB"
  }
}
```

---

### 5. Activity Summary
```
GET /api/logs/summary
```
**Returns:** Summary of recent activity (errors, warnings, modules)

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/logs/summary
```

**Response:**
```json
{
  "success": true,
  "summary": {
    "totalLogs": 250,
    "errors": 5,
    "warnings": 12,
    "success": 180,
    "modules": {
      "CSV_IMPORT": 45,
      "API": 120,
      "DASHBOARD": 85
    }
  },
  "database": {
    "transactions": 425,
    "users": 2
  }
}
```

---

### 6. Search Logs
```
GET /api/logs/search?q=query&lines=200
```
**Returns:** Logs matching the search query

**Examples:**
```bash
# Search for failures
curl https://myfinanceapp-production.up.railway.app/api/logs/search?q=failed

# Search for a specific transaction
curl https://myfinanceapp-production.up.railway.app/api/logs/search?q=amazon

# Search for database errors
curl https://myfinanceapp-production.up.railway.app/api/logs/search?q=database&lines=50
```

---

### 7. Filter by Module
```
GET /api/logs/filter?module=CSV_IMPORT&lines=200
```
**Returns:** Logs from a specific module

**Available modules:**
- `CSV_IMPORT` - CSV upload and parsing
- `API` - API requests
- `DASHBOARD` - Dashboard operations
- `LOGS_API` - Logging system
- `SERVER` - Server startup/status
- `DATABASE` - DB operations
- `AUTH` - Authentication

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/logs/filter?module=CSV_IMPORT&lines=100
```

---

### 8. Get Logs by Date
```
GET /api/logs/file?date=2026-06-03&lines=500
```
**Returns:** Logs from a specific date file

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/logs/file?date=2026-06-03
```

---

### 9. List All Log Files
```
GET /api/logs/list
```
**Returns:** All available log files with sizes and dates

**Example:**
```bash
curl https://myfinanceapp-production.up.railway.app/api/logs/list
```

**Response:**
```json
{
  "success": true,
  "files": [
    {
      "file": "app-2026-06-03.log",
      "size": "245.67 KB",
      "modified": "2026-06-03T06:13:37.500Z"
    },
    {
      "file": "app-2026-06-02.log",
      "size": "128.45 KB",
      "modified": "2026-06-02T23:59:59.000Z"
    }
  ],
  "total": 2
}
```

---

### 10. Clear Old Log Files
```
POST /api/logs/clear?days=7
```
**Deletes:** Log files older than N days

**Example:**
```bash
curl -X POST https://myfinanceapp-production.up.railway.app/api/logs/clear?days=7
```

---

## Troubleshooting Scenarios

### Scenario 1: CSV Import Failed
```bash
# Check import logs
curl https://myfinanceapp-production.up.railway.app/api/logs/imports?lines=100

# Search for the error
curl https://myfinanceapp-production.up.railway.app/api/logs/search?q=Skipped
```

### Scenario 2: Dashboard Not Loading
```bash
# Check recent errors
curl https://myfinanceapp-production.up.railway.app/api/logs/errors

# Filter by dashboard module
curl https://myfinanceapp-production.up.railway.app/api/logs/filter?module=DASHBOARD
```

### Scenario 3: Database Connection Issues
```bash
# Health check
curl https://myfinanceapp-production.up.railway.app/api/health

# Search database logs
curl https://myfinanceapp-production.up.railway.app/api/logs/search?q=database
```

### Scenario 4: General App Issues
```bash
# Get summary
curl https://myfinanceapp-production.up.railway.app/api/logs/summary

# Check last 100 errors
curl https://myfinanceapp-production.up.railway.app/api/logs/errors?lines=100
```

---

## Log Format

All logs follow this format:
```
[TIMESTAMP] [MODULE] MESSAGE
```

**Example:**
```
[2026-06-03T06:11:02.117Z] [CSV_IMPORT] Starting CSV import
[2026-06-03T06:11:02.118Z] [CSV_IMPORT] Processing 504 records from td-checking
[2026-06-03T06:11:02.150Z] [CSV_IMPORT] ✓ Complete: 245 imported, 12 duplicates, 2 errors
```

**Status Indicators:**
- ✓ Success
- ❌ Error/Failure
- ⚠️ Warning
- 📊 Info
- 🚀 Startup
- 🗑️ Cleanup

---

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `lines is not defined` | Variable naming bug | Deploy latest (commit 5ad8a4f) |
| `Parse error: Cannot read properties` | CSV column mismatch | Check CSV headers match expected format |
| `Cannot find module` | Missing dependency | Run `npm install` |
| `Database connection failed` | PostgreSQL not accessible | Check Railway PostgreSQL service status |
| `Duplicate entry` | Transaction already imported | Normal - system prevents duplicates |

---

## Real-Time Monitoring

To monitor logs in real-time while importing:

```bash
# In one terminal, start a loop that fetches logs every 2 seconds
watch -n 2 'curl -s https://myfinanceapp-production.up.railway.app/api/logs/imports?lines=20 | jq ".logs[-5:]"'

# In another terminal, trigger the import
# Then watch the logs appear in real-time
```

---

## Persistent Log Storage

Logs are stored in `/logs/app-YYYY-MM-DD.log` on the Railway container.

- Each day gets a new file
- Logs persist across deployments (stored in Railway persistent volume)
- Max 2000 lines kept in memory at once
- Files can be up to several MB each

---

## Tips for Troubleshooting

1. **Always start with `/api/health`** - Tells you if the app is even running
2. **Use `/api/logs/errors`** - Quickly see what's broken
3. **Search before scrolling** - Use `/api/logs/search?q=` to find events
4. **Check module logs** - Use `/api/logs/filter?module=` for specific components
5. **Compare timestamps** - Logs are timestamped to correlate events
6. **Check database stats** - Use `/api/logs/summary` to see transactions imported

---

## Integration with External Tools

All endpoints return JSON, so they work with:
- `jq` for parsing
- `curl` for shell scripting
- Monitoring services (Datadog, New Relic, etc.)
- Custom dashboards
- Slack webhooks for alerts
