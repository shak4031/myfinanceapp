// Scans MyFinance logs for errors and exits 1 when any are found, so it can gate a release or a cron alert.
//   node scripts/scan-logs.js                       -> today's logs/app-YYYY-MM-DD.log
//   node scripts/scan-logs.js logs/*.log --since 24h
//   railway logs | node scripts/scan-logs.js --since 2h --fail-on warn
// Understands the JSON lines written by backend/utils/logger.js and the older "[time] [MODULE] message" format.
import fs from 'fs';
import path from 'path';
import { inferLevel, logFileFor } from '../backend/utils/logger.js';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
};
const since = parseSince(option('--since'));
const failOn = option('--fail-on') === 'warn' ? new Set(['error', 'warn']) : new Set(['error']);

function parseSince(value) {
  if (!value) return null;
  const relative = /^(\d+)\s*([mhd])$/i.exec(value);
  if (relative) return new Date(Date.now() - Number(relative[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[relative[2].toLowerCase()]);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--since must be like 30m, 24h, 7d or an ISO time (got ${value})`);
  return date;
}

function parseLine(line) {
  const start = line.indexOf('{');
  if (start !== -1) {
    try {
      const entry = JSON.parse(line.slice(start));
      if (entry && typeof entry === 'object' && (entry.level || entry.time)) return entry;
    } catch { /* not JSON */ }
  }
  const legacy = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(?:\[(\w+)\s*\]\s*)?(.*)$/.exec(line);
  if (!legacy) return /\S/.test(line) ? { level: inferLevel(line), message: line.trim() } : null;
  const level = (legacy[3] || '').toLowerCase();
  return { time: legacy[1], module: legacy[2].trim(), message: legacy[4], level: ['error', 'warn', 'warning'].includes(level) ? level.replace('warning', 'warn') : inferLevel(legacy[4]) };
}

async function readInputs() {
  if (args.length) return args.map(file => ({ name: file, text: fs.readFileSync(file, 'utf8') }));
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return [{ name: 'stdin', text }];
  }
  const today = logFileFor();
  if (!fs.existsSync(today)) {
    console.log(`No log file at ${path.relative(process.cwd(), today)} - nothing to scan.`);
    return [];
  }
  return [{ name: path.relative(process.cwd(), today), text: fs.readFileSync(today, 'utf8') }];
}

const inputs = await readInputs();
const causes = new Map();
const failedRequests = new Map();
let scanned = 0;
for (const { text } of inputs) {
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (since && entry.time && new Date(entry.time) < since) continue;
    scanned++;
    if (entry.event === 'http.request' && entry.status >= 500) {
      const key = `${entry.method} ${entry.path}`;
      failedRequests.set(key, (failedRequests.get(key) || 0) + 1);
    }
    if (!failOn.has(entry.level) || entry.event === 'http.request' || entry.event === 'server.error') continue;
    const key = `[${entry.level}] ${entry.module || entry.event || 'log'}: ${(entry.message || entry.name || '').replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, '<id>').slice(0, 300)}`;
    const cause = causes.get(key) || { count: 0, first: entry.time, last: entry.time, requestIds: [] };
    cause.count++;
    cause.last = entry.time || cause.last;
    if (entry.requestId && cause.requestIds.length < 3) cause.requestIds.push(entry.requestId);
    causes.set(key, cause);
  }
}

console.log(`Scanned ${scanned} log entries from ${inputs.map(input => input.name).join(', ') || 'no input'}${since ? ` since ${since.toISOString()}` : ''}.`);
if (failedRequests.size) {
  console.log('\nFailed requests (5xx):');
  for (const [route, count] of [...failedRequests].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${route}`);
}
if (!causes.size) {
  console.log(`No ${[...failOn].join('/')} entries found.`);
  process.exit(failedRequests.size ? 1 : 0);
}
console.log(`\n${causes.size} distinct problem(s):`);
for (const [key, cause] of [...causes].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${String(cause.count).padStart(5)}x ${key}`);
  if (cause.first) console.log(`         first ${cause.first}  last ${cause.last}${cause.requestIds.length ? `  requestId ${cause.requestIds.join(', ')}` : ''}`);
}
process.exit(1);
