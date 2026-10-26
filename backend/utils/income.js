import { parseTxDate } from './normalize.js';

// Pay-cycle detection: salary-like credits are grouped by employer, their spacing tells us the cadence,
// and the cadence projects the paychecks still to come this month. Salary is always treated as fixed income.
const DAY_MS = 86400000;
const INCOME_CATEGORY = /^(?:salary|payroll|paycheck|wages|income)$/i;
const INCOME_TEXT = /\b(?:payroll|dir(?:ect)?\.?\s*dep(?:osit)?|salary|paycheck|pay\s*check|net\s*pay|wages)\b/i;
const NOT_INCOME = /\b(?:zelle|venmo|cash\s*app|paypal|refund|reversal|interest|transfer|xfer|tax\s*ref|irs)\b/i;
const NOISE = /\b(?:dir(?:ect)?|dep(?:osit)?|ppd|ccd|id|co|entry|descr|ach|credit|cr|web|pmt|ref|trn|orig|ind|name)\b/gi;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const cents = value => Math.round(value * 100) / 100;
const utc = parsed => Date.UTC(parsed.year, parsed.month, parsed.day);
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// income_role is the user's override: 'income' always counts, 'other' never does, NULL lets detection decide.
export const isIncomeRole = value => value === null || value === 'income' || value === 'other';

// Whether a deposit counts as pay, and a plain-language reason the income review can show.
export function incomeReason(tx) {
  if (String(tx.direction).toUpperCase() !== 'CREDIT') return { counted: false, by: 'direction', reason: 'Money out' };
  if (tx.income_role === 'income') return { counted: true, by: 'you', reason: 'You marked this as income' };
  if (tx.income_role === 'other') return { counted: false, by: 'you', reason: 'You marked this as not income' };
  const text = tx.description || '';
  const category = String(tx.category || '').trim();
  if (INCOME_CATEGORY.test(category)) return { counted: true, by: 'category', reason: `Category is ${category}` };
  if (NOT_INCOME.test(text)) return { counted: false, by: 'wording', reason: 'Looks like a transfer, refund or interest' };
  if (tx.is_fixed === true || tx.is_fixed === 1 || tx.is_fixed === 'true') return { counted: true, by: 'fixed', reason: 'Marked as fixed' };
  if (INCOME_TEXT.test(text)) return { counted: true, by: 'wording', reason: 'Payroll wording in the description' };
  return { counted: false, by: 'auto', reason: 'Not recognised as pay' };
}

export function isIncomeTransaction(tx) {
  return incomeReason(tx).counted;
}

// Employer key without reference numbers, masked accounts or ACH boilerplate.
export function incomeKey(description = '') {
  const words = String(description).toUpperCase()
    .replace(/(?:\bX+|\*{2,})\d+\b/g, ' ').replace(/[^A-Z&\s]/g, ' ').replace(NOISE, ' ')
    .split(/\s+/).filter(word => word.length > 1);
  return words.slice(0, 3).join(' ') || 'INCOME';
}

const titleCase = text => text.toLowerCase().replace(/\b[a-z]/g, char => char.toUpperCase());

function classify(dates) {
  const gaps = dates.slice(1).map((time, index) => Math.round((time - dates[index]) / DAY_MS));
  const typical = median(gaps);
  const weekdays = dates.map(time => new Date(time).getUTCDay());
  const lastWeekday = weekdays.at(-1);
  const sameWeekday = weekdays.filter(day => day === lastWeekday).length / weekdays.length;
  const steady = limit => gaps.filter(gap => Math.abs(gap - typical) <= limit).length / gaps.length >= 0.7;
  if (typical >= 6 && typical <= 8 && steady(1)) return { cadence: 'weekly', intervalDays: 7 };
  if (typical >= 13 && typical <= 15 && sameWeekday >= 0.7 && steady(2)) return { cadence: 'biweekly', intervalDays: 14 };
  if (typical >= 12 && typical <= 18) return { cadence: 'semimonthly', intervalDays: 15 };
  if (typical >= 26 && typical <= 35) return { cadence: 'monthly', intervalDays: 30 };
  return null;
}

export function describeCadence(stream) {
  const day = WEEKDAYS[stream.weekday];
  if (stream.cadence === 'weekly') return `Every ${day}`;
  if (stream.cadence === 'biweekly') return `Every other ${day}`;
  if (stream.cadence === 'semimonthly') return 'Twice a month';
  return 'Monthly';
}

export function detectIncomeStreams(transactions, today = new Date()) {
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const groups = new Map();
  for (const tx of transactions) {
    if (!isIncomeTransaction(tx)) continue;
    const parsed = parseTxDate(tx.date);
    const amount = Number(tx.amount);
    if (!parsed || !Number.isFinite(amount) || amount <= 0) continue;
    const time = utc(parsed);
    if (time > now || now - time > 200 * DAY_MS) continue;
    const key = incomeKey(tx.description);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ time, amount, day: parsed.day, category: tx.category, description: tx.description });
  }
  const streams = [];
  for (const [key, rows] of groups) {
    // Split deposits on the same day (e.g. bonus + salary) count as one pay date.
    const byDate = new Map();
    for (const row of rows) byDate.set(row.time, { ...row, amount: (byDate.get(row.time)?.amount || 0) + row.amount });
    const dated = [...byDate.values()].sort((a, b) => a.time - b.time);
    if (dated.length < 2) continue;
    const kind = classify(dated.map(row => row.time));
    if (!kind) continue;
    const last = dated.at(-1);
    if (now - last.time > kind.intervalDays * 2 * DAY_MS + 5 * DAY_MS) continue; // the job or pay schedule changed
    const recent = dated.slice(-3).map(row => row.amount);
    const daysOfMonth = [...new Set(dated.slice(-6).map(row => row.day))];
    const stream = {
      key, name: titleCase(key), category: last.category || 'Salary', cadence: kind.cadence, intervalDays: kind.intervalDays,
      weekday: new Date(last.time).getUTCDay(), amount: cents(median(recent)), lastDate: new Date(last.time).toISOString().slice(0, 10),
      occurrences: dated.length,
      monthDays: kind.cadence === 'semimonthly' ? semimonthlyDays(dated) : kind.cadence === 'monthly' ? [last.day] : daysOfMonth
    };
    stream.label = describeCadence(stream);
    streams.push(stream);
  }
  return streams.sort((a, b) => b.amount - a.amount);
}

// Deposits grouped by sender for the income review: everything counted as pay, anything the user
// has overridden, and other repeating deposits that might be pay the rules missed.
export function incomeSources(transactions, today = new Date()) {
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const streams = new Map(detectIncomeStreams(transactions, today).map(stream => [stream.key, stream]));
  const groups = new Map();
  for (const tx of transactions) {
    if (String(tx.direction).toUpperCase() !== 'CREDIT') continue;
    const parsed = parseTxDate(tx.date);
    const amount = Number(tx.amount);
    if (!parsed || !Number.isFinite(amount) || amount <= 0) continue;
    const time = utc(parsed);
    if (time > now || now - time > 400 * DAY_MS) continue;
    const key = incomeKey(tx.description);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: tx.id, time, date: new Date(time).toISOString().slice(0, 10), description: tx.description, amount: cents(amount),
      category: tx.category || null, income_role: tx.income_role ?? null, ...incomeReason(tx) });
  }
  const sources = [];
  for (const [key, rows] of groups) {
    rows.sort((a, b) => b.time - a.time || String(b.id).localeCompare(String(a.id)));
    const counted = rows.filter(row => row.counted).length;
    const overridden = rows.some(row => row.income_role);
    if (!counted && !overridden && rows.length < 3) continue;
    const stream = streams.get(key);
    const total = cents(rows.reduce((sum, row) => sum + row.amount, 0));
    sources.push({
      key, name: titleCase(key), status: counted === rows.length ? 'income' : counted ? 'mixed' : 'other',
      by: rows[0].by, reason: rows[0].reason, regular: !!stream, cadence: stream?.cadence || null, cadenceLabel: stream?.label || null,
      expected: stream?.amount ?? null, count: rows.length, counted, total, average: cents(total / rows.length), lastDate: rows[0].date,
      ids: rows.map(row => row.id),
      transactions: rows.slice(0, 24).map(({ time, ...row }) => row)
    });
  }
  const rank = source => (source.status === 'other' ? 2 : 0) + (source.regular ? 0 : 1);
  return sources.sort((a, b) => rank(a) - rank(b) || b.total - a.total).slice(0, 40);
}

function semimonthlyDays(dated) {
  const early = dated.filter(row => row.day <= 15).map(row => row.day);
  const late = dated.filter(row => row.day > 15).map(row => row.day);
  return [early.length ? Math.round(median(early)) : 1, late.length ? Math.round(median(late)) : 31];
}

// Expected pay dates from the last deposit up to (and including) `until`.
export function nextPayDates(stream, until) {
  const dates = [];
  const last = Date.parse(`${stream.lastDate}T00:00:00Z`);
  if (stream.cadence === 'weekly' || stream.cadence === 'biweekly') {
    for (let time = last + stream.intervalDays * DAY_MS; time <= until; time += stream.intervalDays * DAY_MS) dates.push(time);
    return dates;
  }
  const start = new Date(last);
  for (let offset = 0; offset < 24; offset++) {
    const year = start.getUTCFullYear(), month = start.getUTCMonth() + offset;
    const monthEnd = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (const day of stream.monthDays) {
      const time = Date.UTC(year, month, Math.min(day, monthEnd));
      if (time > last && time <= until) dates.push(time);
    }
    if (Date.UTC(year, month, 1) > until) break;
  }
  return dates.sort((a, b) => a - b);
}

// Calendar months (this one onward) in which a biweekly stream pays three times instead of the usual two.
export function threePaycheckMonths(streams = [], today = new Date(), monthsAhead = 12) {
  const from = Date.UTC(today.getFullYear(), today.getMonth(), 1);
  const until = Date.UTC(today.getFullYear(), today.getMonth() + monthsAhead, 0);
  const months = [];
  for (const stream of streams) {
    if (stream.cadence !== 'biweekly' || !stream.lastDate) continue;
    const last = Date.parse(`${stream.lastDate}T00:00:00Z`);
    const dates = [];
    // Walk back to the start of this month so paychecks already received still count toward it.
    for (let time = last; time >= from; time -= stream.intervalDays * DAY_MS) dates.push(time);
    dates.push(...nextPayDates(stream, until));
    const byMonth = new Map();
    for (const time of dates) {
      if (time < from || time > until) continue;
      const key = new Date(time).toISOString().slice(0, 7);
      byMonth.set(key, [...(byMonth.get(key) || []), new Date(time).toISOString().slice(0, 10)]);
    }
    for (const [month, days] of byMonth) {
      if (days.length >= 3) months.push({ month, key: stream.key, name: stream.name, amount: stream.amount, dates: days.sort(), extra: cents(stream.amount * (days.length - 2)) });
    }
  }
  return months.sort((a, b) => a.month.localeCompare(b.month) || b.extra - a.extra);
}

// Paychecks already received this month plus those still expected (today onward).
export function projectIncome(transactions, today = new Date(), { through = null } = {}) {
  const streams = detectIncomeStreams(transactions, today);
  const year = today.getFullYear(), month = today.getMonth(), todayDay = today.getDate();
  const monthEnd = through ? Date.UTC(through.getFullYear(), through.getMonth(), through.getDate()) : Date.UTC(year, month + 1, 0);
  const items = [];
  for (const stream of streams) {
    const received = transactions.filter(tx => {
      if (!isIncomeTransaction(tx) || incomeKey(tx.description) !== stream.key) return false;
      const parsed = parseTxDate(tx.date);
      return parsed && parsed.year === year && parsed.month === month && parsed.day <= todayDay;
    });
    for (const tx of received) {
      items.push({
        id: tx.id, description: tx.description, category: tx.category || stream.category, amount: cents(Number(tx.amount)),
        ...(through ? { date: parseTxDate(tx.date).iso } : {}),
        dayOfMonth: parseTxDate(tx.date).day, isIncome: true, status: 'processed', cadence: stream.cadence, cadenceLabel: stream.label, incomeKey: stream.key
      });
    }
    for (const time of nextPayDates(stream, monthEnd)) {
      const date = new Date(time);
      const iso = date.toISOString().slice(0, 10);
      if (time < Date.UTC(year, month, todayDay)) continue;
      if (received.some(tx => parseTxDate(tx.date).iso === iso)) continue;
      items.push({
        key: `income:${stream.key}:${through ? iso : date.getUTCDate()}`, description: stream.name, category: stream.category, amount: stream.amount,
        ...(through ? { date: iso } : {}),
        dayOfMonth: date.getUTCDate(), isIncome: true, status: 'projected', cadence: stream.cadence, cadenceLabel: stream.label, incomeKey: stream.key
      });
    }
  }
  return { streams, items: items.sort((a, b) => through ? a.date.localeCompare(b.date) : a.dayOfMonth - b.dayOfMonth) };
}
