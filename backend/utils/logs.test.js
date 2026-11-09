import assert from 'node:assert/strict';
import { configureTestMail } from './paidFixture.js';
configureTestMail();
import { test } from 'node:test';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { migratePrivateSchema } from './schema.js';
import { log, writeEntry } from './logger.js';
import { redactLogText, groupCauses, parseSince, queryLogs, startLogStore, stopLogStore, flushLogStore, toStoredEntry } from './logStore.js';
import application from '../app.js';

test('log text is redacted before support staff can see it', () => {
  const text = redactLogText('Import for jane.doe@example.com failed: amount $1,249.99 and -84.12 on card 4111111111111111 password=hunter2 Bearer abc.def token: xyz');
  assert.doesNotMatch(text, /jane|1,249|84\.12|4111|hunter2|abc\.def|xyz/);
  assert.match(text, /\[email\].*\[amount\].*\[amount\].*\[number\].*password=\[redacted\].*Bearer \[redacted\].*token=\[redacted\]/);
  assert.equal(redactLogText('relation "app_logs" does not exist\nat line 3'), 'relation "app_logs" does not exist at line 3');
});

test('causes group repeated problems and skip request echoes', () => {
  const entry = (level, source, message, time, extra = {}) => ({ level, source, message, time, route: 'GET /api/x', requestId: `r-${time}`, ...extra });
  const causes = groupCauses([
    entry('error', 'DASHBOARD', 'Query failed for user 12', '2026-10-01T00:00:01Z'),
    entry('error', 'DASHBOARD', 'Query failed for user 99', '2026-10-01T00:00:03Z'),
    entry('error', 'http.request', 'GET /api/x -> 500', '2026-10-01T00:00:03Z'),
    entry('warn', 'IMPORT', 'Could not read row', '2026-10-01T00:00:02Z'),
    entry('info', 'APP', 'started', '2026-10-01T00:00:00Z')
  ]);
  assert.deepEqual(causes.map(cause => [cause.level, cause.source, cause.count]), [['error', 'DASHBOARD', 2], ['warn', 'IMPORT', 1]]);
  assert.equal(causes[0].first, '2026-10-01T00:00:01Z');
  assert.equal(causes[0].last, '2026-10-01T00:00:03Z');
  assert.deepEqual(causes[0].requestIds, ['r-2026-10-01T00:00:01Z', 'r-2026-10-01T00:00:03Z']);
});

test('since accepts relative and ISO values and rejects junk', () => {
  assert.ok(Math.abs(parseSince('30m').getTime() - (Date.now() - 30 * 60e3)) < 1000);
  assert.equal(parseSince('2026-10-01T00:00:00Z').toISOString(), '2026-10-01T00:00:00.000Z');
  assert.throws(() => parseSince('yesterday-ish'), error => error.status === 400);
});

test('in-memory query filters by level, text and request', async () => {
  const since = new Date(Date.now() - 1000);
  const marker = `probe-${Date.now().toString(36)}`;
  log('LOG_TEST', `${marker} informational`, 'info');
  log('LOG_TEST', `${marker} could not finish`, 'warn');
  log('LOG_TEST', `${marker} exploded`, 'error');
  const warnings = await queryLogs({ level: 'warn', since, q: marker, includeDatabase: false });
  assert.deepEqual(warnings.entries.map(entry => entry.level).sort(), ['error', 'warn']);
  assert.deepEqual(warnings.summary.counts, { error: 1, warn: 1, info: 0 });
  const everything = await queryLogs({ level: 'info', since, q: marker, includeDatabase: false });
  assert.equal(everything.total, 3);
  const errors = await queryLogs({ level: 'error', since, q: marker, includeDatabase: false });
  assert.equal(errors.causes[0].message, `${marker} exploded`);
});

test('operational detail is allowlisted and grouped per affected connection', async () => {
  const entry = toStoredEntry({ event: 'plaid.sync_failed', level: 'error', userId: 7, connectionId: 8,
    errorCode: 'ITEM_LOGIN_REQUIRED', providerRequestId: 'provider-123', access_token: 'never-store',
    detail: { message: 'Bank authentication failed', secret: 'never-store', amount: 123 } });
  assert.deepEqual(entry.detail, { userId: 7, connectionId: 8, errorCode: 'ITEM_LOGIN_REQUIRED', providerRequestId: 'provider-123' });
  assert.equal(toStoredEntry({ event: 'plaid.sync_completed', ignoredZeroAmount: 2 }).detail.ignoredZeroAmount, 2);
  assert.equal(toStoredEntry({ event: 'plaid.sync_completed', ignoredZeroAmount: -1 }).detail.ignoredZeroAmount, undefined);
  assert.equal(entry.message, 'Bank authentication failed');
  assert.equal(groupCauses([entry, { ...entry, detail: { ...entry.detail, connectionId: 9 } }]).length, 2);
  writeEntry({ event: 'plaid.sync_completed', level: 'info', userId: 7, connectionId: 8, message: 'Checked with no changes' });
  writeEntry({ event: 'plaid.sync_completed', level: 'info', userId: 9, connectionId: 10, message: 'Other customer' });
  const result = await queryLogs({ level: 'info', userId: 7, connectionId: 8, includeDatabase: false });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].message, 'Checked with no changes');
});

test('support can view logs in the admin console API; monitoring needs its token', async t => {
  const database = new PGlite();
  let lock = Promise.resolve();
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    let release;
    const previous = lock;
    lock = new Promise(resolve => { release = resolve; });
    await previous;
    return {
      async query(sql, params) {
        const results = params?.length ? [await database.query(sql, params)] : await database.exec(sql);
        const result = results[results.length - 1] || { rows: [] };
        return { ...result, rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
      },
      release
    };
  });
  const client = await pg.Pool.prototype.connect();
  await client.query('BEGIN');
  await migratePrivateSchema(client);
  await client.query('COMMIT');
  client.release();

  const saved = Object.fromEntries(['OWNER_SETUP_TOKEN', 'APP_ORIGIN', 'ALLOW_REGISTRATION', 'LOG_MONITOR_TOKEN'].map(key => [key, process.env[key]]));
  process.env.OWNER_SETUP_TOKEN = 'test-only-setup-token-longer-than-32-characters';
  process.env.ALLOW_REGISTRATION = 'true';
  delete process.env.LOG_MONITOR_TOKEN;
  const server = application.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = base;
  const call = async (path, { body, cookie, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const account = email => ({ name: 'Test Account', email, password: 'test-only-password-123456' });
  startLogStore({ intervalMs: 60000 });
  try {
    const owner = await call('/api/auth/setup', { body: { ...account('owner@example.com'), setupToken: process.env.OWNER_SETUP_TOKEN } });
    const ownerCookie = owner.headers.get('set-cookie').split(';')[0];
    const member = await call('/api/auth/register', { body: account('member@example.com') });
    const memberCookie = member.headers.get('set-cookie').split(';')[0];

    const since = new Date(Date.now() - 1000).toISOString();
    const marker = `support-probe-${Date.now().toString(36)}`;
    log('LOG_TEST', `${marker} failed for member@example.com paying $1,249.99`, 'error');
    await flushLogStore();
    const stored = (await database.query('SELECT level, source, message FROM app_logs WHERE message LIKE $1', [`%${marker}%`])).rows;
    assert.deepEqual(stored, [{ level: 'error', source: 'LOG_TEST', message: `${marker} failed for [email] paying [amount]` }]);

    const viewed = await call(`/api/admin/logs?level=warn&since=${encodeURIComponent(since)}&q=${marker}`, { cookie: ownerCookie });
    assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
    assert.equal(viewed.body.coverage.databaseAvailable, true);
    assert.equal(viewed.body.summary.counts.error, 1);
    assert.equal(viewed.body.causes[0].message, `${marker} failed for [email] paying [amount]`);
    assert.equal((await call('/api/admin/logs?since=whenever', { cookie: ownerCookie })).status, 400);
    assert.equal((await call('/api/admin/logs', { cookie: memberCookie })).status, 403);
    assert.equal((await call('/api/admin/logs')).status, 401);
    await database.exec(`INSERT INTO plaid_connections(id,user_id,item_id,access_token_ciphertext,last_sync_at,last_error_code,status)
      VALUES(11,1,'private-item','private-cipher','2026-11-06T12:00:00Z','ITEM_LOGIN_REQUIRED','relink_required'),
        (12,2,'other-private-item','other-private-cipher',NOW(),NULL,'connected');
      INSERT INTO plaid_accounts(id,connection_id,user_id,account_id,name,type,subtype)
        VALUES(21,11,1,'private-bank-id','Private bank name','depository','checking'),
        (22,12,2,'other-bank-id','Other private bank','depository','checking');
      INSERT INTO transactions(user_id,date,description,amount,direction,source,plaid_account_id,is_pending)
        VALUES(1,'2026-11-01','Private merchant',99,'DEBIT','plaid','private-bank-id',TRUE)`);
    writeEntry({ event: 'plaid.sync_completed', level: 'info', userId: 1, connectionId: 11,
      added: 0, modified: 0, removed: 0, message: 'Successful check with no changes' });
    writeEntry({ event: 'plaid.sync_failed', level: 'warn', userId: 2, connectionId: 12,
      errorCode: 'PRODUCT_NOT_READY', message: 'Other bank needs time' });
    await flushLogStore();
    const persistedInfo = (await database.query("SELECT detail FROM app_logs WHERE source='plaid.sync_completed' AND detail->>'connectionId'='11'")).rows;
    assert.equal(persistedInfo.length, 1, 'successful zero-change checks survive restarts');
    const scoped = await call('/api/admin/logs?level=info&userId=1&connectionId=11', { cookie: ownerCookie });
    assert.equal(scoped.body.total, 1);
    assert.equal(scoped.body.entries[0].detail.added, 0);
    const health = await call('/api/admin/bank-health?userId=1&accountId=21', { cookie: ownerCookie });
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.accounts.length, 1);
    assert.equal(health.body.accounts[0].severity, 'critical');
    assert.equal(health.body.accounts[0].pendingCount, 1);
    assert.equal(health.body.accounts[0].connectionId, 11);
    assert.doesNotMatch(JSON.stringify(health.body), /private-item|private-cipher|private-bank-id|Private merchant|Private bank name|current_balance/);
    assert.equal((await call('/api/admin/bank-health', { cookie: memberCookie })).status, 403);
    assert.equal((await call('/api/admin/bank-health')).status, 401);
    assert.equal((await call('/api/admin/bank-health?userId=-1', { cookie: ownerCookie })).status, 400);
    assert.equal((await call('/api/admin/logs?connectionId=bad', { cookie: ownerCookie })).status, 400);
    const overview = await call('/api/admin/overview', { cookie: ownerCookie });
    assert.ok(overview.body.stats.app_errors_24h >= 1);
    assert.equal(overview.body.monitorTokenConfigured, false);

    assert.equal((await call('/api/monitor/logs')).status, 404, 'monitoring is off until a token is configured');
    process.env.LOG_MONITOR_TOKEN = 'test-only-monitor-token-longer-than-32-characters';
    assert.equal((await call('/api/monitor/logs')).status, 401);
    assert.equal((await call('/api/monitor/logs', { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await call('/api/monitor/logs', { cookie: ownerCookie })).status, 401, 'a browser session is not a monitoring token');
    const monitored = await call(`/api/monitor/logs?since=${encodeURIComponent(since)}`, { headers: { Authorization: `Bearer ${process.env.LOG_MONITOR_TOKEN}` } });
    assert.equal(monitored.status, 200);
    assert.equal(monitored.body.status, 'errors');
    assert.ok(monitored.body.causes.some(cause => cause.message.startsWith(marker)));
    assert.ok(monitored.body.entries.every(entry => entry.level !== 'info'));
  } finally {
    await stopLogStore();
    server.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
