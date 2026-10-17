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

export function isIncomeTransaction(tx) {
  if (String(tx.direction).toUpperCase() !== 'CREDIT') return false;
  const text = tx.description || '';
  if (INCOME_CATEGORY.test(String(tx.category || '').trim())) return true;
  if (NOT_INCOME.test(text)) return false;
  const fixed = tx.is_fixed === true || tx.is_fixed === 1 || tx.is_fixed === 'true';
  return fixed || INCOME_TEXT.test(text);
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

// Paychecks already received this month plus those still expected (today onward).
export function projectIncome(transactions, today = new Date()) {
  const streams = detectIncomeStreams(transactions, today);
  const year = today.getFullYear(), month = today.getMonth(), todayDay = today.getDate();
  const monthEnd = Date.UTC(year, month + 1, 0);
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
        dayOfMonth: parseTxDate(tx.date).day, isIncome: true, status: 'processed', cadence: stream.cadence, cadenceLabel: stream.label
      });
    }
    for (const time of nextPayDates(stream, monthEnd)) {
      const date = new Date(time);
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() < todayDay) continue;
      if (received.some(tx => parseTxDate(tx.date).day === date.getUTCDate())) continue;
      items.push({
        key: `income:${stream.key}:${date.getUTCDate()}`, description: stream.name, category: stream.category, amount: stream.amount,
        dayOfMonth: date.getUTCDate(), isIncome: true, status: 'projected', cadence: stream.cadence, cadenceLabel: stream.label
      });
    }
  }
  return { streams, items: items.sort((a, b) => a.dayOfMonth - b.dayOfMonth) };
}
