import { getCanonicalMerchant, parseTxDate } from './normalize.js';
import { buildUpcomingPayments, isFixedPayment } from './fixedPayments.js';
import { TRANSFER_CATEGORY, isTransferRow } from './transfers.js';

// Money moved between your own accounts is not spending or income (see utils/transfers.js).
export { TRANSFER_CATEGORY };
const MERCHANT_NOISE = new Set('VISA MASTERCARD DEBIT CREDIT CARD CHECKCARD DDA ACH POS PUR PURCH PURCHASE RECURRING AUTOPAY PAYMENT PMT ONLINE ELECTRONIC WITHDRAWAL DEPOSIT TRANSFER XFER FROM WWW COM NET ORG INC LLC CORP THE AND APP'.split(' '));
const PAYMENT_RAILS = new Set(['ZELLE', 'VENMO', 'PAYPAL', 'CASH']);
const MERCHANT_PROCESSORS = new Set(['TST', 'TOAST', 'SQ', 'SQUARE']);
const GROUP_NOISE = new Set('VISA MASTERCARD DEBIT CHECKCARD DDA ACH POS PUR PURCH PURCHASE RECURRING AUTOPAY PMT ONLINE ELECTRONIC WITHDRAWAL DEPOSIT TRANSFER XFER FROM WWW COM NET ORG INC LLC CORP THE APP SENT RECEIVED TO STORE AP REF'.split(' '));
const DAY_MS = 86400000;
const HISTORY_MONTHS = 12;

const round = (value, places = 2) => value == null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places;
const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => values.length ? sum(values) / values.length : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stdev = values => {
  const avg = mean(values);
  return values.length > 1 ? Math.sqrt(sum(values.map(value => (value - avg) ** 2)) / (values.length - 1)) : 0;
};
const monthKey = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const daysAgo = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() - days);

export function merchantKey(description) {
  const tokens = [...new Set(String(description ?? '').toUpperCase().split(/[^A-Z0-9]+/)
    .filter(token => token.length > 2 && !/\d/.test(token) && !MERCHANT_NOISE.has(token)))];
  if (!tokens.length) return '';
  return PAYMENT_RAILS.has(tokens[0]) ? tokens.slice(0, 2).join(' ') : tokens[0];
}

// A user's rename (transactions.display_name, see utils/naming.js) decides both grouping and the label shown.
const renamed = tx => String(tx?.display_name ?? '').replace(/\s+/g, ' ').trim();
export function merchantGroup(tx) {
  if (renamed(tx)) return `NAME:${renamed(tx).toUpperCase()}`;
  const description = String(tx?.description || '');
  const rail = description.search(/\b(?:ZELLE|VENMO|PAYPAL|CASH APP)\b/i);
  const source = rail >= 0 ? description.slice(rail) : getCanonicalMerchant(description);
  const tokens = String(source).toUpperCase().split(/[^A-Z0-9]+/)
    .filter(token => token && !/\d/.test(token) && !GROUP_NOISE.has(token));
  // Processor names and the first word of a payee are not a merchant identity.
  if (MERCHANT_PROCESSORS.has(tokens[0])) {
    while (MERCHANT_PROCESSORS.has(tokens[0])) tokens.shift();
    return tokens.slice(0, 3).join(' ');
  }
  return tokens.join(' ') || description.trim().toUpperCase() || 'UNKNOWN';
}
export const merchantLabel = tx => renamed(tx) || getCanonicalMerchant(tx?.description) || merchantKey(tx?.description) || 'Unknown merchant';

// Least-squares slope relative to the mean: +0.05 means spending rises ~5% per month.
export function trendSlope(values) {
  if (values.length < 3) return null;
  const avg = mean(values);
  if (!avg) return null;
  const xMean = (values.length - 1) / 2;
  const numerator = sum(values.map((value, x) => (x - xMean) * (value - avg)));
  const denominator = sum(values.map((_, x) => (x - xMean) ** 2));
  return numerator / denominator / avg;
}

function normalize(transactions, today) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return transactions.map(tx => {
    const parsed = parseTxDate(tx.date);
    const amount = Math.abs(Number(tx.amount));
    if (!parsed || !Number.isFinite(amount) || amount === 0) return null;
    const date = new Date(parsed.year, parsed.month, parsed.day);
    if (date > end) return null;
    const transfer = isTransferRow(tx);
    // Transfers are grouped under a transfer category so they can be listed but never counted.
    const category = transfer ? (TRANSFER_CATEGORY.test(tx.category || '') ? tx.category : 'Transfer')
      : TRANSFER_CATEGORY.test(tx.category || '') ? 'Other' : tx.category || 'Other';
    const direction = String(tx.direction).toUpperCase();
    if (!['DEBIT', 'CREDIT'].includes(direction)) return null;
    return {
      id: tx.id, description: tx.description || '', amount, date, iso: parsed.iso, category,
      monthIndex: parsed.year * 12 + parsed.month, day: parsed.day,
      debit: direction === 'DEBIT',
      fixed: isFixedPayment(tx),
      transfer, merchant: merchantGroup(tx), raw: tx
    };
  }).filter(Boolean);
}

function buildCategories(rows, context, budgets) {
  const { currentIndex, firstIndex, day, daysInMonth, elapsed } = context;
  const byCategory = new Map();
  for (const tx of rows) {
    if (!tx.debit || tx.monthIndex < currentIndex - (HISTORY_MONTHS - 1)) continue;
    if (!byCategory.has(tx.category)) byCategory.set(tx.category, { series: Array(HISTORY_MONTHS).fill(0), fixedSeries: Array(HISTORY_MONTHS).fill(0), lastMonthToDate: 0, count: 0 });
    const entry = byCategory.get(tx.category);
    entry.series[tx.monthIndex - currentIndex + HISTORY_MONTHS - 1] += tx.amount;
    if (tx.fixed) entry.fixedSeries[tx.monthIndex - currentIndex + HISTORY_MONTHS - 1] += tx.amount;
    if (tx.monthIndex === currentIndex) entry.count++;
    if (tx.monthIndex === currentIndex - 1 && tx.day <= day) entry.lastMonthToDate += tx.amount;
  }
  for (const budget of budgets) {
    if (!byCategory.has(budget.category)) byCategory.set(budget.category, { series: Array(HISTORY_MONTHS).fill(0), fixedSeries: Array(HISTORY_MONTHS).fill(0), lastMonthToDate: 0, count: 0 });
  }
  // Months before the account's first transaction are unknown, not zero.
  const available = Math.max(0, Math.min(HISTORY_MONTHS - 1, currentIndex - firstIndex));
  const completed = series => series.slice(HISTORY_MONTHS - 1 - available, HISTORY_MONTHS - 1);
  const totalMtd = sum([...byCategory].filter(([name]) => !TRANSFER_CATEGORY.test(name)).map(([, entry]) => entry.series[HISTORY_MONTHS - 1]));
  const total3 = sum([...byCategory].filter(([name]) => !TRANSFER_CATEGORY.test(name)).map(([, entry]) => sum(completed(entry.series).slice(-3))));
  const budgetMap = new Map(budgets.map(budget => [budget.category, budget.amount]));
  return [...byCategory].map(([name, entry]) => {
    const history = completed(entry.series);
    const mtd = entry.series[HISTORY_MONTHS - 1];
    const sma3 = history.length ? mean(history.slice(-3)) : null;
    const sma6 = history.length ? mean(history.slice(-6)) : null;
    // Fixed bills arrive once a month: only the unpaid remainder is still to come. Flexible spending accrues with time.
    const fixedHistory = completed(entry.fixedSeries), fixedMtd = entry.fixedSeries[HISTORY_MONTHS - 1];
    const fixedTypical = fixedHistory.length ? mean(fixedHistory.slice(-3)) : 0;
    const variableMtd = mtd - fixedMtd;
    const variableSma3 = sma3 == null ? null : Math.max(0, sma3 - fixedTypical);
    // Flexible spending accrues with time, but never beyond what is typically still left to spend this month.
    const variablePace = variableSma3 == null ? (variableMtd / day) * (daysInMonth - day) : Math.min(variableSma3 * (1 - elapsed), Math.max(0, variableSma3 - variableMtd));
    const remainingPace = Math.max(0, fixedTypical - fixedMtd) + variablePace;
    const projected = Math.max(mtd, mtd + remainingPace);
    const recent = history.slice(-6);
    const avg = mean(recent);
    const deltaMtd = mtd - entry.lastMonthToDate;
    const transfer = TRANSFER_CATEGORY.test(name);
    let signal = 'new';
    if (sma3) signal = projected > sma3 * 1.15 ? 'above' : projected < sma3 * 0.85 ? 'below' : 'inline';
    const budget = budgetMap.get(name) ?? null;
    return {
      name, transfer, count: entry.count,
      series: entry.series.map(value => round(value)),
      months: entry.series.map((_, index) => monthKey(currentIndex - (HISTORY_MONTHS - 1) + index)),
      mtd: round(mtd), lastMonthToDate: round(entry.lastMonthToDate), lastMonth: round(entry.series[HISTORY_MONTHS - 2]),
      deltaMtd: round(deltaMtd), deltaPct: entry.lastMonthToDate > 0 ? round(deltaMtd / entry.lastMonthToDate, 4) : null,
      sma3: round(sma3), sma6: round(sma6), projected: round(projected),
      share: !transfer && totalMtd > 0 ? round(mtd / totalMtd, 4) : null,
      share3m: !transfer && total3 > 0 ? round(sum(history.slice(-3)) / total3, 4) : null,
      volatility: avg ? round(stdev(recent) / avg, 4) : null,
      trend: round(trendSlope(recent), 4), signal,
      budget, budgetUsed: budget ? round(mtd / budget, 4) : null, budgetProjected: budget ? round(projected / budget, 4) : null,
      budgetStatus: !budget ? null : mtd > budget ? 'over' : projected > budget ? 'risk' : 'ok'
    };
  }).sort((a, b) => b.mtd - a.mtd || b.sma3 - a.sma3 || a.name.localeCompare(b.name));
}

function monthlyTotals(rows, context, predicate) {
  const { currentIndex } = context;
  const series = Array(HISTORY_MONTHS).fill(0);
  for (const tx of rows) {
    const index = tx.monthIndex - currentIndex + HISTORY_MONTHS - 1;
    if (index >= 0 && index < HISTORY_MONTHS && !tx.transfer && predicate(tx)) series[index] += tx.amount;
  }
  return series;
}

function buildAnomalies(rows, categories, context) {
  const anomalies = [];
  const cutoff = context.end.getTime() - 60 * DAY_MS;
  const byMerchant = new Map();
  for (const tx of rows) {
    if (!tx.debit || tx.transfer || !tx.merchant) continue;
    if (!byMerchant.has(tx.merchant)) byMerchant.set(tx.merchant, []);
    byMerchant.get(tx.merchant).push(tx);
  }
  for (const list of byMerchant.values()) {
    list.sort((a, b) => a.date - b.date);
    list.forEach((tx, index) => {
      if (tx.date.getTime() < cutoff || tx.amount < 25) return;
      const typical = median(list.slice(0, index).map(prior => prior.amount));
      if (index >= 3 && typical > 0 && tx.amount >= typical * 3) {
        anomalies.push({
          type: 'charge', id: tx.id, date: tx.iso, merchant: merchantLabel(tx.raw), description: tx.description,
          category: tx.category, amount: round(tx.amount), typical: round(typical), ratio: round(tx.amount / typical, 1)
        });
      }
    });
  }
  for (const category of categories) {
    if (category.transfer) continue;
    const history = category.series.slice(0, -1).slice(-6).filter((_, index, all) => all.length - index <= context.available);
    if (history.length < 3) continue;
    const avg = mean(history), spread = stdev(history);
    if (category.projected > 50 && category.projected > avg * 1.25 && category.projected > avg + 2 * spread) {
      anomalies.push({
        type: 'category', category: category.name, amount: category.projected, typical: round(avg),
        ratio: avg ? round(category.projected / avg, 1) : null
      });
    }
  }
  return anomalies.sort((a, b) => (b.ratio || 0) - (a.ratio || 0)).slice(0, 12);
}

const CADENCES = [
  { id: 'weekly', min: 6, max: 8, perYear: 52, maxCv: 0.1 },
  { id: 'monthly', min: 26, max: 35, perYear: 12, maxCv: 0.35 },
  { id: 'quarterly', min: 85, max: 95, perYear: 4, maxCv: 0.35 },
  { id: 'annual', min: 350, max: 380, perYear: 1, maxCv: 0.35 }
];

// Everyday shopping and income can repeat at a steady price, but they are habits, not recurring payments.
const HABIT_CATEGORY = /grocer|\bgas\b|fuel|dining|restaurant|shopping|salary|income|payroll/i;
const HABIT_DESCRIPTION = /COSTCO\s+(?:WHOLESALE|WHSE)|E-?ZPASS|REPLENISH/i;
// Payments that are usually bills: a hint to mark them fixed, never a reason to hide them.
const BILL_CATEGORY = /mortgage|\brent\b|loan|credit\s*card|debt|insurance|utilit|internet|phone|wireless|cable|\btax/i;
const BILL_DESCRIPTION = /MORTGAGE|\bLOANS?\b|STUDENT|NELNET|NAVIENT|SALLIE|FINANCIAL\s+(?:AUTOPAY|PMT)|AUTO\s+FINANCE|CARD\s+(?:ONLINE\s+)?(?:PAYMENT|PMT)|CREDIT\s*(?:CARD|CRD)|CRD\s+EPAY|INSURANCE|\bINS\b|GEICO|PROGRESSIVE|ALLSTATE|STATE\s*FARM|ELECTRIC|\bWATER\b|\bPSEG\b|COMCAST|XFINITY|VERIZON|T-MOBILE|AT&T|SPECTRUM|\bRENT\b|\bIRS\b/i;

export function isRecurringCandidate(tx) {
  return !HABIT_CATEGORY.test(tx.category || '') && !HABIT_DESCRIPTION.test(tx.description || '');
}

export function looksLikeBill(tx) {
  return BILL_CATEGORY.test(tx.category || '') || BILL_DESCRIPTION.test(tx.description || '');
}

// A recurring payment charges the same price again and again (allowing occasional price steps); habits vary every time.
function steadyPrice(amounts) {
  if (amounts.length < 2) return true;
  const repeats = amounts.slice(1).filter((amount, index) => Math.abs(amount - amounts[index]) <= Math.max(0.01, amounts[index] * 0.01)).length;
  return repeats / (amounts.length - 1) >= 0.6;
}

// Every steady, regularly scheduled charge. `fixed` says whether the user already marked it as a fixed payment.
function buildRecurring(rows, context) {
  const since = context.end.getTime() - 400 * DAY_MS;
  const groups = new Map();
  for (const tx of rows) {
    if (!tx.debit || tx.transfer || !tx.merchant || tx.date.getTime() < since || !isRecurringCandidate(tx)) continue;
    if (!groups.has(tx.merchant)) groups.set(tx.merchant, []);
    groups.get(tx.merchant).push(tx);
  }
  const recurring = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.date - b.date);
    const intervals = list.slice(1).map((tx, index) => Math.round((tx.date - list[index].date) / DAY_MS));
    const interval = median(intervals);
    const cadence = interval != null && CADENCES.find(option => interval >= option.min && interval <= option.max);
    if (!cadence || list.length < (cadence.id === 'annual' ? 2 : 3)) continue;
    const amounts = list.map(tx => tx.amount);
    const typical = median(amounts);
    if (stdev(amounts) / mean(amounts) > cadence.maxCv || !steadyPrice(amounts)) continue;
    // Most gaps must follow the cadence, otherwise it is a habit (e.g. groceries), not a recurring payment.
    const regular = intervals.filter(gap => gap >= cadence.min * 0.8 && gap <= cadence.max * 1.2).length;
    if (regular / intervals.length < 0.6) continue;
    const latest = list[list.length - 1];
    const previous = median(list.slice(Math.max(0, list.length - 4), -1).map(tx => tx.amount));
    const change = previous ? latest.amount - previous : 0;
    const daysSince = Math.round((context.end - latest.date) / DAY_MS);
    recurring.push({
      id: latest.id, merchant: merchantLabel(latest.raw), category: latest.category,
      fixed: list.some(tx => tx.fixed), likelyBill: list.some(looksLikeBill),
      cadence: cadence.id, charges: list.length, amount: round(latest.amount), typical: round(typical),
      annualCost: round(latest.amount * cadence.perYear), monthlyCost: round(latest.amount * cadence.perYear / 12),
      lastDate: latest.iso, nextDate: isoDay(new Date(latest.date.getTime() + interval * DAY_MS)),
      active: daysSince <= interval * 1.6 + 3,
      priceChange: Math.abs(change) >= Math.max(0.5, previous * 0.02) ? round(change) : 0,
      priceChangePct: previous && Math.abs(change) >= Math.max(0.5, previous * 0.02) ? round(change / previous, 4) : 0
    });
  }
  return recurring.sort((a, b) => b.active - a.active || b.annualCost - a.annualCost);
}

function buildMerchants(rows, context) {
  const recentStart = daysAgo(context.end, 89), priorStart = daysAgo(context.end, 179);
  const groups = new Map();
  for (const tx of rows) {
    if (!tx.debit || tx.transfer || !tx.merchant) continue;
    if (tx.date < priorStart) continue;
    if (!groups.has(tx.merchant)) groups.set(tx.merchant, { recent: 0, prior: 0, count: 0, latest: tx });
    const group = groups.get(tx.merchant);
    if (tx.date >= recentStart) {
      group.recent += tx.amount;
      group.count++;
      if (tx.date >= group.latest.date) group.latest = tx;
    } else group.prior += tx.amount;
  }
  const total = sum([...groups.values()].map(group => group.recent));
  return [...groups.values()].filter(group => group.count).map(group => ({
    merchant: merchantLabel(group.latest.raw), category: group.latest.category,
    total: round(group.recent), count: group.count, average: round(group.recent / group.count),
    share: total ? round(group.recent / total, 4) : null, lastDate: group.latest.iso,
    change: group.prior ? round((group.recent - group.prior) / group.prior, 4) : null
  })).sort((a, b) => b.total - a.total).slice(0, 10);
}

export function buildAnalytics({ transactions = [], budgets = [], latestBalance = null, today = new Date(), typical = null } = {}) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const rows = normalize(transactions, end);
  const currentIndex = end.getFullYear() * 12 + end.getMonth();
  const firstIndex = rows.length ? Math.min(...rows.map(tx => tx.monthIndex)) : currentIndex;
  const day = end.getDate();
  const daysInMonth = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
  const available = Math.max(0, Math.min(HISTORY_MONTHS - 1, currentIndex - firstIndex));
  const context = { end, currentIndex, firstIndex, day, daysInMonth, elapsed: day / daysInMonth, available };
  const months = Array.from({ length: HISTORY_MONTHS }, (_, index) => monthKey(currentIndex - (HISTORY_MONTHS - 1) + index));
  const categories = buildCategories(rows, context, budgets);

  const spend = monthlyTotals(rows, context, tx => tx.debit);
  const income = monthlyTotals(rows, context, tx => !tx.debit);
  const fixed = monthlyTotals(rows, context, tx => tx.debit && tx.fixed);
  const variable = spend.map((value, index) => value - fixed[index]);
  const recentCompleted = series => series.slice(HISTORY_MONTHS - 1 - Math.min(3, available), HISTORY_MONTHS - 1);
  const avgSpend = mean(recentCompleted(spend)), avgIncome = mean(recentCompleted(income));
  const avgFixed = mean(recentCompleted(fixed)), avgVariable = mean(recentCompleted(variable));
  const mtdSpend = spend[HISTORY_MONTHS - 1];
  const lastMonthToDate = sum(rows.filter(tx => tx.debit && !tx.transfer && tx.monthIndex === currentIndex - 1 && tx.day <= day).map(tx => tx.amount));
  const movers = categories.filter(category => !category.transfer && (category.mtd || category.lastMonthToDate));
  const biggestMover = movers.sort((a, b) => Math.abs(b.deltaMtd) - Math.abs(a.deltaMtd))[0] || null;

  const upcoming = buildUpcomingPayments(rows.filter(tx => !tx.transfer).map(tx => ({ ...tx.raw, amount: tx.amount })), end);
  const remainingFixed = sum(upcoming.filter(item => item.status === 'projected').map(item => item.amount));
  const variableMtd = variable[HISTORY_MONTHS - 1];
  const remainingVariable = avgVariable != null ? avgVariable * (1 - context.elapsed) : (variableMtd / day) * (daysInMonth - day);
  const projectedTotal = mtdSpend + remainingFixed + Math.max(0, remainingVariable);
  const pace = { current: Array(daysInMonth).fill(0), last: Array(new Date(end.getFullYear(), end.getMonth(), 0).getDate()).fill(0) };
  for (const tx of rows) {
    if (!tx.debit || tx.transfer) continue;
    if (tx.monthIndex === currentIndex) pace.current[tx.day - 1] += tx.amount;
    if (tx.monthIndex === currentIndex - 1) pace.last[tx.day - 1] += tx.amount;
  }
  const cumulative = values => values.reduce((list, value) => [...list, round((list.at(-1) || 0) + value)], []);

  const monthlyFixedPlan = fixed[HISTORY_MONTHS - 2] || avgFixed || 0;
  const monthlyIncome = avgIncome || 0, monthlyVariable = avgVariable || 0;
  // Use the shared typical surplus so Analytics, the dashboard and the planner agree on one number.
  const surplus = typical?.monthlySurplus;
  const monthlyNet = Number.isFinite(surplus) ? surplus : monthlyIncome - monthlyFixedPlan - monthlyVariable;
  let balance = latestBalance == null ? null : Number(latestBalance);
  const cashflow = Array.from({ length: 6 }, (_, index) => {
    const net = monthlyNet;
    if (balance != null) balance += net;
    return {
      month: monthKey(currentIndex + 1 + index), income: round(monthlyIncome), fixed: round(monthlyFixedPlan),
      variable: round(monthlyVariable), net: round(net), balance: round(balance)
    };
  });

  return {
    generatedAt: new Date().toISOString(), asOf: isoDay(end), months, monthsOfHistory: available,
    excludedCategories: [...new Set(rows.filter(tx => tx.transfer).map(tx => tx.category))],
    kpis: {
      mtdSpend: round(mtdSpend), lastMonthToDate: round(lastMonthToDate),
      mtdDelta: round(mtdSpend - lastMonthToDate), mtdDeltaPct: lastMonthToDate ? round((mtdSpend - lastMonthToDate) / lastMonthToDate, 4) : null,
      avgMonthlySpend: round(avgSpend), avgMonthlyIncome: round(avgIncome),
      savingsRate: avgIncome ? round((avgIncome - avgSpend) / avgIncome, 4) : null,
      fixedRatio: avgSpend ? round(avgFixed / avgSpend, 4) : null,
      dailyBurn: round(mtdSpend / day), daysLeft: daysInMonth - day,
      biggestMover: biggestMover && { name: biggestMover.name, deltaMtd: biggestMover.deltaMtd, deltaPct: biggestMover.deltaPct }
    },
    series: { spend: spend.map(v => round(v)), income: income.map(v => round(v)), fixed: fixed.map(v => round(v)), variable: variable.map(v => round(v)) },
    categories,
    forecast: {
      mtd: round(mtdSpend), remainingFixed: round(remainingFixed), remainingVariable: round(Math.max(0, remainingVariable)),
      projected: round(projectedTotal), lastMonth: round(spend[HISTORY_MONTHS - 2]), average: round(avgSpend),
      day, daysInMonth, paceCurrent: cumulative(pace.current).slice(0, day), paceLast: cumulative(pace.last)
    },
    cashflow: { startBalance: latestBalance == null ? null : round(Number(latestBalance)), months: cashflow,
      basis: Number.isFinite(surplus) ? 'typical-surplus' : 'recent-averages', monthsUsed: typical?.monthsUsed ?? null },
    anomalies: buildAnomalies(rows, categories, context),
    recurring: buildRecurring(rows, context),
    merchants: buildMerchants(rows, context),
    weekdays: [0, 1, 2, 3, 4, 5, 6].map(weekday => round(sum(rows
      .filter(tx => tx.debit && !tx.transfer && tx.date >= daysAgo(end, 89) && tx.date.getDay() === weekday)
      .map(tx => tx.amount))))
  };
}

const CSV_FORMULA = /^[=+\-@\t\r]/;
export function toCsv(rows, columns) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && CSV_FORMULA.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(column => cell(column.label)).join(','), ...rows.map(row => columns.map(column => cell(column.value(row))).join(','))].join('\r\n') + '\r\n';
}
