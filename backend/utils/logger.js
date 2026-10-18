import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AsyncLocalStorage } from 'node:async_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = process.env.LOG_DIR || path.join(__dirname, '../../logs');
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const ERROR_TEXT = /\b(error|exception|failed|failure|crash(?:ed)?)\b/i;
const WARN_TEXT = /\b(could not|unable to|unavailable|denied|warning)\b|❌|⚠/i;
// Tests stay quiet and never write into the app log, so real errors are not buried under fixture noise.
const quiet = () => process.env.LOG_QUIET === 'true' || (Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.SHOW_TEST_LOGS);
const listeners = new Set();
let dirReady = false;

/** Per-request context (request ID, route) attached to every log line written while handling that request. */
export const requestContext = new AsyncLocalStorage();

export const logFileFor = (date = new Date()) => path.join(logsDir, `app-${date.toISOString().slice(0, 10)}.log`);

export function inferLevel(message) {
  const text = String(message ?? '');
  if (ERROR_TEXT.test(text)) return 'error';
  if (WARN_TEXT.test(text)) return 'warn';
  return 'info';
}

/** Subscribe to every log entry (used by the release smoke check). Returns an unsubscribe function. */
export function onLogEntry(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Writes one JSON log line: {time, level, module|event, message, requestId, ...}. */
export function writeEntry(entry) {
  const level = LEVELS.has(entry.level) ? entry.level : 'info';
  const context = requestContext.getStore();
  const record = { time: new Date().toISOString(), ...entry, level, ...(context && !entry.requestId ? { requestId: context.requestId, route: context.route } : {}) };
  for (const listener of listeners) {
    try { listener(record); } catch { /* listeners must never break logging */ }
  }
  if (quiet()) return record;
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line); else console.log(line);
  if (process.env.LOG_TO_FILE !== 'false') {
    try {
      if (!dirReady) { fs.mkdirSync(logsDir, { recursive: true }); dirReady = true; }
      fs.appendFile(logFileFor(), line + '\n', err => { if (err) console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', module: 'LOGGER', message: `Failed to write log file: ${err.message}` })); });
    } catch (err) {
      console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', module: 'LOGGER', message: `Failed to prepare log directory: ${err.message}` }));
    }
  }
  return record;
}

/**
 * log('MODULE', 'message') - level is inferred from the wording unless given explicitly:
 * log('MODULE', 'message', 'warn').
 */
export function log(module, message, level = inferLevel(message)) {
  return writeEntry({ level, module, message: String(message ?? '') });
}

/** Get recent log lines for display in UI */
export function getRecentLogs(lines = 100) {
  try {
    const file = logFileFor();
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').slice(-lines).filter(line => line.trim());
  } catch (err) {
    console.error('[LOGGER] Failed to read logs:', err.message);
    return [];
  }
}

export default { log, getRecentLogs, writeEntry, onLogEntry, inferLevel, requestContext, logFileFor };
