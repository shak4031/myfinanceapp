// Support-facing application log store.
// - Every log entry (except debug) is kept in a bounded in-memory buffer for live viewing.
// - Warnings and errors are also written in batches to the app_logs table, so they survive restarts and are
//   visible across instances.
// Messages are redacted before they are stored: support staff see what failed, never customer money or secrets.
import { administrativeTransaction } from '../db.js';
import { INSTANCE_ID, onLogEntry } from './logger.js';

const MEMORY_LIMIT = Math.min(Math.max(Number(process.env.LOG_MEMORY_ENTRIES) || 5000, 100), 50000);
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
const PERSISTED = new Set(['warn', 'error']);
// Lines that repeat information already reported by a more specific error line.
const ECHO_EVENTS = new Set(['http.request', 'server.error']);
const memory = [];
let pending = [];
let persisting = false;
let flushTimer = null;
let flushing = Promise.resolve();

export function redactLogText(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\b(password|passwd|token|secret|cookie|authorization|api[_-]?key|setup[_-]?token)\b\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/[$€£]\s*-?\d[\d,]*(?:\.\d+)?/g, '[amount]')
    .replace(/(?<![\w.])-?\d[\d,]*\.\d{2}(?![\d.])/g, '[amount]')
    .replace(/\b\d{9,}\b/g, '[number]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .slice(0, 1000);
}

export function toStoredEntry(record) {
  const fromRequest = record.event === 'http.request'
    ? `${record.method} ${record.path} -> ${record.status} in ${record.durationMs} ms` : '';
  return {
    id: String(record.id || `${INSTANCE_ID}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    time: record.time || new Date().toISOString(),
    level: LEVEL_RANK[record.level] !== undefined ? record.level : 'info',
    source: String(record.module || record.event || 'app').slice(0, 80),
    message: redactLogText(record.message || fromRequest || record.name || record.outcome || ''),
    requestId: record.requestId ? String(record.requestId).slice(0, 64) : null,
    route: (record.route || (record.method && record.path ? `${record.method} ${record.path}` : null))?.slice(0, 200) || null,
    status: Number.isInteger(record.status) ? record.status : null,
    instance: INSTANCE_ID
  };
}

onLogEntry(record => {
  if (record.level === 'debug') return;
  const entry = toStoredEntry(record);
  memory.push(entry);
  if (memory.length > MEMORY_LIMIT) memory.splice(0, memory.length - MEMORY_LIMIT);
  if (persisting && PERSISTED.has(entry.level)) {
    pending.push(entry);
    if (pending.length > 5000) pending.splice(0, pending.length - 5000);
  }
});

async function writeBatch(batch) {
  const column = key => batch.map(entry => entry[key]);
  await administrativeTransaction(client => client.query(`
    INSERT INTO app_logs (entry_id, created_at, level, source, message, request_id, route, status, instance)
    SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[])
    ON CONFLICT (entry_id) DO NOTHING`,
  [column('id'), column('time'), column('level'), column('source'), column('message'), column('requestId'), column('route'), column('status'), column('instance')]));
}

/** Writes queued warnings/errors to the database. Failures go to stderr only, never back into the log. */
export function flushLogStore() {
  flushing = flushing.then(async () => {
    while (pending.length) {
      const batch = pending.splice(0, 500);
      try {
        await writeBatch(batch);
      } catch (error) {
        console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', module: 'LOG_STORE', message: `Could not persist ${batch.length} log entries: ${error.message}` }));
        return;
      }
    }
  });
  return flushing;
}

export function startLogStore({ intervalMs = 2000 } = {}) {
  if (persisting) return;
  persisting = true;
  pending.push(...memory.filter(entry => PERSISTED.has(entry.level)));
  flushTimer = setInterval(() => { flushLogStore(); }, intervalMs);
  flushTimer.unref();
}

export async function stopLogStore() {
  persisting = false;
  clearInterval(flushTimer);
  await flushLogStore();
}

export function logRetentionDays() {
  const days = Number(process.env.LOG_RETENTION_DAYS || 30);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : 30;
}

export async function purgeExpiredLogs() {
  return administrativeTransaction(async client => (await client.query(
    'DELETE FROM app_logs WHERE created_at < NOW() - make_interval(days => $1)', [logRetentionDays()])).rowCount);
}

/** Accepts 15m, 24h, 7d or an ISO timestamp. */
export function parseSince(value, fallback = '24h') {
  const text = String(value || fallback).trim();
  const relative = /^(\d{1,5})\s*([mhd])$/i.exec(text);
  if (relative) return new Date(Date.now() - Number(relative[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[relative[2].toLowerCase()]);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    const error = new Error('since must look like 30m, 24h, 7d or an ISO time');
    error.status = 400;
    throw error;
  }
  return date;
}

const causeKey = entry => `${entry.source}: ${entry.message
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
  .replace(/\b\d+\b/g, '#')}`;

/** Groups warnings/errors into distinct problems, newest first within equal counts. */
export function groupCauses(entries) {
  const causes = new Map();
  for (const entry of entries) {
    if (!PERSISTED.has(entry.level) || ECHO_EVENTS.has(entry.source)) continue;
    const key = `${entry.level}|${causeKey(entry)}`;
    const cause = causes.get(key) || { level: entry.level, source: entry.source, message: entry.message, count: 0, first: entry.time, last: entry.time, routes: new Set(), requestIds: [] };
    cause.count++;
    if (entry.time < cause.first) cause.first = entry.time;
    if (entry.time > cause.last) cause.last = entry.time;
    if (entry.route) cause.routes.add(entry.route);
    if (entry.requestId && cause.requestIds.length < 5 && !cause.requestIds.includes(entry.requestId)) cause.requestIds.push(entry.requestId);
    causes.set(key, cause);
  }
  return [...causes.values()]
    .map(cause => ({ ...cause, routes: [...cause.routes].slice(0, 5) }))
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.count - a.count || (b.last > a.last ? 1 : -1));
}

function summarize(entries) {
  const counts = { error: 0, warn: 0, info: 0 };
  const failedRoutes = new Map();
  for (const entry of entries) {
    if (counts[entry.level] !== undefined) counts[entry.level]++;
    if (entry.source === 'http.request' && entry.status >= 500 && entry.route) failedRoutes.set(entry.route, (failedRoutes.get(entry.route) || 0) + 1);
  }
  return { counts, failedRequests: [...failedRoutes].map(([route, count]) => ({ route, count })).sort((a, b) => b.count - a.count) };
}

/**
 * Reads logs from memory (all levels, this instance) and the database (warnings/errors, all instances).
 * level is the minimum level: 'error', 'warn' or 'info'.
 */
export async function queryLogs({ level = 'warn', since = new Date(Date.now() - 86400e3), q = '', requestId = '', limit = 200, includeDatabase = true } = {}) {
  const minimum = LEVEL_RANK[level] ?? LEVEL_RANK.warn;
  const sinceIso = since.toISOString();
  const needle = String(q || '').trim().toLowerCase().slice(0, 200);
  const request = String(requestId || '').trim().slice(0, 64);
  const matches = entry => LEVEL_RANK[entry.level] >= minimum && entry.time >= sinceIso
    && (!request || entry.requestId === request)
    && (!needle || `${entry.source} ${entry.message} ${entry.route || ''}`.toLowerCase().includes(needle));
  const merged = new Map(memory.filter(matches).map(entry => [entry.id, entry]));
  let databaseAvailable = includeDatabase;
  if (includeDatabase) {
    try {
      const params = [sinceIso, minimum >= LEVEL_RANK.error ? ['error'] : ['warn', 'error']];
      const filters = ['created_at >= $1', 'level = ANY($2)'];
      if (request) { params.push(request); filters.push(`request_id = $${params.length}`); }
      if (needle) { params.push(`%${needle.replace(/[%_\\]/g, '')}%`); filters.push(`lower(source || ' ' || message || ' ' || COALESCE(route, '')) LIKE $${params.length}`); }
      const rows = await administrativeTransaction(async client => (await client.query(`
        SELECT entry_id, created_at, level, source, message, request_id, route, status, instance
        FROM app_logs WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT 5000`, params)).rows);
      for (const row of rows) {
        if (merged.has(row.entry_id)) continue;
        merged.set(row.entry_id, {
          id: row.entry_id, time: new Date(row.created_at).toISOString(), level: row.level, source: row.source, message: row.message,
          requestId: row.request_id, route: row.route, status: row.status, instance: row.instance
        });
      }
    } catch {
      databaseAvailable = false;
    }
  }
  const all = [...merged.values()].sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return {
    since: sinceIso,
    generatedAt: new Date().toISOString(),
    level: Object.keys(LEVEL_RANK).find(key => LEVEL_RANK[key] === minimum),
    summary: summarize(all),
    causes: groupCauses(all),
    entries: all.slice(0, cap),
    total: all.length,
    coverage: {
      instance: INSTANCE_ID,
      memoryFrom: memory[0]?.time || null,
      persisted: persisting,
      databaseAvailable,
      note: 'Info entries come from this server instance only; warnings and errors are stored for all instances.'
    }
  };
}
