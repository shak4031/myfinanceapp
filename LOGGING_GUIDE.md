# MyFinanceApp Logging & Troubleshooting Endpoints

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
