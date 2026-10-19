// Money flow signals: compares standard spending categories with similar US households and reads each category's
// monthly series the way a technical analyst reads a price chart (moving-average crossover, momentum, volatility
// bands, support level and up-month breadth) to find specific, realistic ways to spend less.
//
// Benchmarks come from public data only: the U.S. Bureau of Labor Statistics Consumer Expenditure Survey, 2024
// calendar year, mean annual spending per consumer unit (downloaded from the BLS public API, series CXU<item>LB<group>M).
// No other MyFinance user's data is used. A pooled source (opt-in, anonymized, minimum cohort size) can be added later
// as another entry in BENCHMARK_SOURCES without changing the signals.
import { parseTxDate } from './normalize.js';
import { merchantGroup, merchantLabel } from './analytics.js';
import { isTransferRow } from './transfers.js';

export const BENCHMARK_SOURCES = Object.freeze({
  'bls-ce-2024': {
    id: 'bls-ce-2024', year: 2024,
    label: 'U.S. Bureau of Labor Statistics, Consumer Expenditure Survey 2024',
    url: 'https://www.bls.gov/cex/'
  }
});
const SOURCE = BENCHMARK_SOURCES['bls-ce-2024'];

// Group codes: all households, household size 1/2/3/4/5+, region, housing tenure.
const GROUPS = ['all', 'size1', 'size2', 'size3', 'size4', 'size5', 'northeast', 'midwest', 'south', 'west', 'own', 'rent'];
// Annual dollars per household, in GROUPS order.
const CE_2024 = {
  FOODHOME: [6224, 3395, 6088, 7597, 8697, 10274, 7165, 5846, 5502, 7112, 6910, 4954],
  FOODAWAY: [3945, 2249, 4070, 4609, 5847, 5331, 4207, 3831, 3501, 4634, 4466, 2981],
  UTILS: [4736, 2978, 4837, 5573, 6180, 6737, 5085, 4376, 4640, 4978, 5649, 3049],
  GASFUEL: [2645, 1346, 2583, 3111, 3818, 4685, 2270, 2580, 2595, 3092, 2999, 1991],
  APPAREL: [2001, 1113, 1994, 2404, 2653, 3358, 2420, 1962, 1759, 2137, 2146, 1732],
  HHFURNSH: [2414, 1472, 2674, 2976, 2971, 2884, 2320, 2436, 2161, 2919, 2975, 1377],
  HKPGSUPP: [877, 495, 971, 1067, 1082, 1197, 962, 957, 799, 877, 1062, 534],
  ENTRTAIN: [3609, 2187, 3933, 4091, 4995, 4416, 3440, 3913, 2999, 4544, 4523, 1918],
  PETS: [880, 502, 1021, 1219, 983, 923, 685, 837, 836, 1151, 1147, 386],
  HEALTH: [6197, 4026, 7228, 6706, 7629, 6819, 6289, 6246, 5870, 6660, 7650, 3510],
  HLTHINSR: [4055, 2482, 4838, 4550, 4864, 4473, 4139, 3939, 3999, 4199, 4990, 2324]
};

// Standard categories only. Contracted bills (mortgage, rent, loans, insurance, internet) are left out: they are
// not comparable across households and are not cut by changing day-to-day habits.
export const BENCHMARK_CATEGORIES = Object.freeze([
  { id: 'groceries', label: 'Groceries', match: /grocer|supermarket/i, items: { FOODHOME: 1 }, covers: 'food and drinks bought at stores' },
  { id: 'dining', label: 'Dining', match: /dining|restaurant|take-?out|fast\s*food|coffee|food\s*away/i, items: { FOODAWAY: 1 }, covers: 'restaurants, take-out and coffee' },
  { id: 'utilities', label: 'Utilities & energy', match: /utilit|electric|energy|power|water|natural\s*gas|heating|propane/i, items: { UTILS: 1 }, seasonal: true, covers: 'electricity, natural gas, heating fuel, water, trash and phone service' },
  { id: 'fuel', label: 'Gas & charging', match: /^gas\b|gasoline|^fuel|ev\s*charg/i, items: { GASFUEL: 1 }, covers: 'gasoline, other motor fuel and vehicle charging' },
  { id: 'shopping', label: 'Shopping', match: /shopping|clothing|apparel|household\s*(?:goods|supplies)/i, items: { APPAREL: 1, HHFURNSH: 1, HKPGSUPP: 1 }, covers: 'clothing, furnishings, appliances and household supplies' },
  { id: 'entertainment', label: 'Entertainment & subscriptions', match: /entertain|subscription|streaming/i, items: { ENTRTAIN: 1, PETS: -1 }, covers: 'events, streaming, hobbies, toys and sports (pets excluded)' },
  { id: 'healthcare', label: 'Healthcare (out of pocket)', match: /health|medical|pharm|doctor|dental/i, items: { HEALTH: 1, HLTHINSR: -1 }, covers: 'doctor visits, prescriptions and medical supplies (insurance premiums excluded)' }
]);

export const REGIONS = Object.freeze(['northeast', 'midwest', 'south', 'west']);
export const HOUSING = Object.freeze(['own', 'rent']);
export const MAX_HOUSEHOLD = 12;

export function normalizeProfile(input) {
  if (!input || typeof input !== 'object') return null;
  const size = Number(input.size ?? input.household_size);
  const region = typeof input.region === 'string' ? input.region.toLowerCase() : null;
  const housing = typeof input.housing === 'string' ? input.housing.toLowerCase() : null;
  return {
    size: Number.isInteger(size) && size >= 1 && size <= MAX_HOUSEHOLD ? size : null,
    region: REGIONS.includes(region) ? region : null,
    housing: HOUSING.includes(housing) ? housing : null
  };
}

const groupValue = (code, group) => CE_2024[code][GROUPS.indexOf(group)];
const sizeGroup = size => !size ? 'all' : `size${Math.min(size, 5)}`;

// The survey publishes one characteristic at a time, so size, region and housing are combined multiplicatively:
// start from the household-size average and scale it by how much the region and housing type differ from all homes.
export function expectedMonthly(categoryId, profile) {
  const category = BENCHMARK_CATEGORIES.find(entry => entry.id === categoryId);
  if (!category) return null;
  const p = normalizeProfile(profile) || {};
  let annual = 0;
  for (const [code, sign] of Object.entries(category.items)) {
    const all = groupValue(code, 'all');
    let value = groupValue(code, sizeGroup(p.size));
    if (p.region) value *= groupValue(code, p.region) / all;
    if (p.housing) value *= groupValue(code, p.housing) / all;
    annual += sign * value;
  }
  return Math.round(Math.max(0, annual) / 12 * 100) / 100;
}

export function profileLabel(profile) {
  const p = normalizeProfile(profile);
  if (!p || (!p.size && !p.region && !p.housing)) return 'the average U.S. household';
  const parts = [p.size ? `${p.size}-person household` : 'household'];
  if (p.region) parts.push(`in the ${p.region[0].toUpperCase()}${p.region.slice(1)}`);
  if (p.housing) parts.push(p.housing === 'own' ? 'that owns its home' : 'that rents');
  return `a typical ${parts.join(' ')}`;
}

export function benchmarkCategoryFor(name) {
  return BENCHMARK_CATEGORIES.find(category => category.match.test(String(name || ''))) || null;
}

const round = (value, places = 2) => value == null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places;
const sum = values => values.reduce((total, value) => total + value, 0);
const mean = values => values.length ? sum(values) / values.length : null;
const stdev = values => {
  const avg = mean(values);
  return values.length > 1 ? Math.sqrt(sum(values.map(value => (value - avg) ** 2)) / (values.length - 1)) : 0;
};
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), position = (sorted.length - 1) * q;
  const low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
};
const median = values => quantile(values, 0.5);

// Theil-Sen slope (median of pairwise slopes): one unusual month cannot fake a trend. Returned as a share of the mean.
export function robustTrend(values) {
  if (values.length < 4) return null;
  const avg = mean(values);
  if (!avg) return null;
  const slopes = [];
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) slopes.push((values[j] - values[i]) / (j - i));
  return median(slopes) / avg;
}

const HISTORY = 24;
// A purchase this far above the category's usual transaction is a one-off (a TV, a trip), not a habit to trend.
const ONE_OFF_MIN = 250, ONE_OFF_MULTIPLE = 5;
const isFixed = tx => tx.is_fixed === true || tx.is_fixed === 1 || tx.is_fixed === 'true';

// Completed months only: the current month is still filling up and would read as a false drop.
function monthlySeries(transactions, today) {
  const currentIndex = today.getFullYear() * 12 + today.getMonth();
  const byCategory = new Map(), visitCounts = new Map(), entries = new Map(), oneOffs = new Map();
  let firstIndex = Infinity, firstDay = 1;
  for (const tx of transactions) {
    const parsed = parseTxDate(tx.date);
    const amount = Math.abs(Number(tx.amount));
    if (!parsed || !Number.isFinite(amount) || !amount) continue;
    const index = parsed.year * 12 + parsed.month;
    if (index < firstIndex || (index === firstIndex && parsed.day < firstDay)) { firstIndex = index; firstDay = parsed.day; }
    if (String(tx.direction).toUpperCase() !== 'DEBIT' || isTransferRow(tx)) continue;
    const category = benchmarkCategoryFor(tx.category);
    const offset = currentIndex - 1 - index;
    if (!category || offset < 0 || offset >= HISTORY) continue;
    if (!entries.has(category.id)) entries.set(category.id, []);
    entries.get(category.id).push({ tx, amount, iso: parsed.iso, slot: HISTORY - 1 - offset });
  }
  for (const [id, list] of entries) {
    const typical = median(list.map(entry => entry.amount));
    const series = Array(HISTORY).fill(0), visits = Array(HISTORY).fill(0), skipped = [];
    for (const entry of list) {
      if (!isFixed(entry.tx) && entry.amount >= Math.max(ONE_OFF_MIN, typical * ONE_OFF_MULTIPLE)) {
        skipped.push({ date: entry.iso, description: entry.tx.description || '', amount: round(entry.amount) });
      } else { series[entry.slot] += entry.amount; visits[entry.slot] += 1; }
    }
    byCategory.set(id, series);
    visitCounts.set(id, visits);
    oneOffs.set(id, skipped.sort((a, b) => b.date.localeCompare(a.date)));
  }
  // A history that starts mid-month makes the first month look artificially cheap, so it is skipped.
  const startIndex = firstIndex + (firstDay > 3 ? 1 : 0);
  const available = Number.isFinite(firstIndex) ? Math.max(0, Math.min(HISTORY, currentIndex - startIndex)) : 0;
  return { byCategory, visitCounts, oneOffs, available, currentIndex };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = index => `${MONTH_NAMES[index % 12]} ${Math.floor(index / 12)}`;

function analyzeCategory(category, series, context, visits = null) {
  const { profile, currentIndex } = context;
  const n = series.length;
  const last = n => series.slice(-n);
  const avg3 = mean(last(3));
  const slowWindow = n >= 12 ? 12 : 6;
  const slow = mean(last(slowWindow));
  const expected = expectedMonthly(category.id, profile);
  const vsTypical = expected ? avg3 / expected - 1 : null;
  const benchmarkStatus = vsTypical == null ? null : vsTypical > 0.25 ? 'high' : vsTypical > 0.1 ? 'above' : vsTypical < -0.15 ? 'below' : 'typical';

  // Moving-average crossover: the 3-month average against the longer-run average. "Crossed" means it moved above
  // (or below) within the last two months, the money-flow version of a golden or death cross.
  const fastPrev = n > 4 ? mean(series.slice(-5, -2)) : null, slowPrev = n > slowWindow + 1 ? mean(series.slice(-slowWindow - 2, -2)) : null;
  const gap = slow ? avg3 / slow - 1 : null;
  const crossover = gap == null ? null : {
    fast: round(avg3), slow: round(slow), slowMonths: slowWindow, gap: round(gap, 4),
    state: gap > 0.1 ? 'above' : gap < -0.1 ? 'below' : 'flat',
    crossed: fastPrev != null && slowPrev != null && gap > 0.1 && fastPrev <= slowPrev * 1.1 ? 'up'
      : fastPrev != null && slowPrev != null && gap < -0.1 && fastPrev >= slowPrev * 0.9 ? 'down' : null
  };

  // Momentum: with 15+ months, compare the last 3 months with the same 3 months a year earlier, which removes
  // seasonality (heating in winter, cooling in summer). Otherwise a robust 6-month trend, skipped for seasonal bills.
  let momentum = null, lastYear = null;
  if (n >= 15) {
    const prior = sum(series.slice(-15, -12));
    if (prior > 0) {
      lastYear = prior / 3;
      momentum = { basis: 'year-over-year', change: round(sum(last(3)) / prior - 1, 4), lastYear: round(lastYear) };
    }
  } else if (!category.seasonal && n >= 6) {
    const trend = robustTrend(last(6));
    if (trend != null) momentum = { basis: 'monthly-trend', change: round(trend, 4) };
  }

  // Volatility band (Bollinger-style): the latest month against the mean +/- 2 standard deviations of the prior 12.
  let band = null;
  if (n >= 7) {
    const window = series.slice(Math.max(0, n - 13), -1), center = mean(window), width = 2 * stdev(window);
    const latest = series[n - 1];
    band = { latest: round(latest), month: monthLabel(currentIndex - 1), center: round(center), upper: round(center + width), lower: round(Math.max(0, center - width)),
      position: latest > center + width ? 'above' : latest < center - width ? 'below' : 'inside' };
  }

  // Breadth: how many of the last 6 months rose over the month before.
  const recent = last(7);
  const upMonths = recent.slice(1).filter((value, index) => value > recent[index]).length;

  // Support: the level you already reached in your cheaper months (25th percentile of the last 12).
  const support = quantile(last(Math.min(12, n)), 0.25);
  const normal = median(last(Math.min(12, n)));
  // A realistic target never asks for less than you have already managed, and never more than typical or your normal.
  // Seasonal bills are held to the same months last year instead, because a summer month cannot match a spring one.
  const ceiling = Math.min(normal, expected && expected > 0 ? Math.max(expected, support) : normal);
  const seasonalTarget = category.seasonal && lastYear != null;
  const target = seasonalTarget ? lastYear : Math.max(support, ceiling);
  // Without a year-over-year view a seasonal bill crossing its average is usually just the season changing.
  const seasonalOnly = !!category.seasonal && n < 15;
  if (crossover && seasonalOnly) crossover.seasonal = true;
  // For everyday categories a year-over-year jump only counts when the recent trend agrees (3-month average above the
  // longer average, or a rising 6-month line); otherwise it is usually a quiet month last year, not a new habit.
  if (momentum?.basis === 'year-over-year') {
    const recentTrend = robustTrend(last(6));
    momentum.confirmed = !!category.seasonal || crossover?.state === 'above' || (recentTrend != null && recentTrend > 0.03);
  } else if (momentum) momentum.confirmed = true;
  const rising = (momentum?.confirmed && momentum.change > 0.1) || (crossover?.state === 'above' && !seasonalOnly);
  const potential = Math.max(0, avg3 - target);
  const monthsAtTarget = seasonalTarget ? null : last(Math.min(12, n)).filter(value => value <= target).length;
  const opportunity = potential >= 10 && (benchmarkStatus === 'high' || benchmarkStatus === 'above' || rising)
    ? { target: round(target), basis: seasonalTarget ? 'same-months-last-year' : 'your-history', monthly: round(potential), annual: round(potential * 12), monthsAtTarget } : null;

  // Your own distribution over the last 12 months: the 5th-95th percentile is the range 9 in 10 of your months fall in.
  // A "spike" is a latest month above the 95th percentile of the months before it.
  const year = last(Math.min(12, n)), prior = year.slice(0, -1), latest = series[n - 1];
  const range = { p5: round(quantile(year, 0.05)), p50: round(quantile(year, 0.5)), p95: round(quantile(year, 0.95)),
    latest: round(latest), month: monthLabel(currentIndex - 1), months: year.length,
    higherThan: prior.filter(value => value < latest).length, compared: prior.length };
  const spike = prior.length >= 5 && latest > quantile(prior, 0.95) && latest - median(prior) >= 25;

  // Price vs volume: was the change driven by more purchases or by pricier ones? Compared with the same three months
  // last year when there is enough history (seasons cancel out), otherwise with the three months before.
  let driver = null;
  const lag = n >= 15 ? 12 : n >= 6 ? 3 : null;
  if (lag && visits) {
    const nowSpend = sum(last(3)), nowCount = sum(visits.slice(-3));
    const thenSpend = sum(series.slice(n - 3 - lag, n - lag)), thenCount = sum(visits.slice(n - 3 - lag, n - lag));
    if (nowCount && thenCount && thenSpend > 0) {
      const visitsNow = nowCount / 3, visitsThen = thenCount / 3, ticketNow = nowSpend / nowCount, ticketThen = thenSpend / thenCount;
      const change = (nowSpend - thenSpend) / 3;
      // Spending = visits x average ticket; split the change into its volume and price parts.
      const volume = (visitsNow - visitsThen) * ticketThen, price = (ticketNow - ticketThen) * visitsNow;
      driver = { basis: lag === 12 ? 'same-months-last-year' : 'previous-3-months', visitsNow: round(visitsNow, 1), visitsThen: round(visitsThen, 1),
        ticketNow: round(ticketNow), ticketThen: round(ticketThen), change: round(change), volume: round(volume), price: round(price),
        cause: Math.abs(change) < Math.max(15, thenSpend / 3 * 0.1) ? 'steady'
          : Math.min(Math.abs(volume), Math.abs(price)) >= 0.4 * Math.max(Math.abs(volume), Math.abs(price)) && Math.sign(volume) === Math.sign(price) ? 'both'
          : Math.abs(volume) >= Math.abs(price) ? 'visits' : 'price' };
    }
  }

  return {
    id: category.id, label: category.label, covers: category.covers, seasonal: !!category.seasonal,
    average3: round(avg3), expected, vsTypical: round(vsTypical, 4), benchmarkStatus,
    crossover, momentum, band, upMonths, upWindow: Math.max(0, recent.length - 1),
    support: round(support), normal: round(normal), opportunity, rising: !!rising, spike, range, driver,
    series: series.map(value => round(value)),
    months: series.map((_, index) => monthLabel(currentIndex - n + index))
  };
}

function headline(row, who) {
  const money = value => `$${Math.round(value).toLocaleString('en-US')}`;
  const parts = [];
  if (row.benchmarkStatus === 'high' || row.benchmarkStatus === 'above') {
    parts.push(`${row.label} averages ${money(row.average3)} a month, ${Math.round(row.vsTypical * 100)}% more than ${who} (${money(row.expected)}).`);
  } else {
    parts.push(`${row.label} averages ${money(row.average3)} a month.`);
  }
  if (row.momentum?.confirmed && row.momentum.change > 0.1) {
    parts.push(row.momentum.basis === 'year-over-year'
      ? `It is up ${Math.round(row.momentum.change * 100)}% on the same three months last year.`
      : `It has been rising about ${Math.round(row.momentum.change * 100)}% a month.`);
  } else if (row.crossover?.crossed === 'up' && !row.crossover.seasonal) {
    parts.push(`Your 3-month average just crossed above your ${row.crossover.slowMonths}-month average.`);
  }
  const o = row.opportunity;
  parts.push(o.basis === 'same-months-last-year'
    ? `Getting back to last year's ${money(o.target)} a month for the same season saves about ${money(o.monthly)} a month (${money(o.annual)} a year).`
    : `Getting back to ${money(o.target)} a month${o.monthsAtTarget ? `, a level you reached in ${o.monthsAtTarget} of the last ${Math.min(12, row.series.length)} months,` : ''} saves about ${money(o.monthly)} a month (${money(o.annual)} a year).`);
  return parts.join(' ');
}

const SMALL_PURCHASE = 20;
const WORKDAYS_PER_MONTH = 21.7;
const merchantName = text => String(text || '').toUpperCase().replace(/[#*].*$|\d.*$/, '').trim().split(/\s+/).slice(0, 2).join(' ') || 'Other';

// Where money went over the last three full months: the same window and transfer rule as the "typical monthly surplus"
// every other page shows, so the "left over" figure here matches the dashboard.
const FLOW_ITEMS = 5, FLOW_MIN_SHARE = 0.03;
function flowGroup(totals, income, months, restLabel) {
  const items = [...totals.entries()].map(([label, amount]) => ({ label, amount: amount / months, id: benchmarkCategoryFor(label)?.id || null }))
    .sort((a, b) => b.amount - a.amount);
  const shown = items.filter((item, index) => index < FLOW_ITEMS && item.amount >= income * FLOW_MIN_SHARE);
  const rest = sum(items.slice(shown.length).map(item => item.amount));
  if (rest >= 1) shown.push({ label: restLabel, amount: rest, id: null, rest: true });
  return { total: round(sum(items.map(item => item.amount))), items: shown.map(item => ({ ...item, amount: round(item.amount) })) };
}

function moneyFlow(transactions, today, typical) {
  const currentIndex = today.getFullYear() * 12 + today.getMonth();
  const months = new Set(), fixedTotals = new Map(), everydayTotals = new Map(), merchants = new Map();
  let income = 0, recorded = 0, smallCount = 0, smallTotal = 0;
  for (const tx of transactions) {
    const parsed = parseTxDate(tx.date);
    const amount = Math.abs(Number(tx.amount));
    if (!parsed || !Number.isFinite(amount) || isTransferRow(tx)) continue;
    const offset = currentIndex - (parsed.year * 12 + parsed.month);
    if (offset < 1 || offset > 3) continue;
    months.add(offset);
    const direction = String(tx.direction).toUpperCase();
    if (direction === 'CREDIT') { income += amount; continue; }
    if (direction !== 'DEBIT') continue;
    recorded += amount;
    const label = tx.category || 'Uncategorized';
    const totals = isFixed(tx) ? fixedTotals : everydayTotals;
    totals.set(label, (totals.get(label) || 0) + amount);
    if (!isFixed(tx) && amount < SMALL_PURCHASE) {
      smallCount += 1; smallTotal += amount;
      const name = merchantName(tx.description);
      merchants.set(name, (merchants.get(name) || 0) + 1);
    }
  }
  const m = months.size;
  if (!m) return { flow: null, small: null };
  const monthlyIncome = income / m;
  // Minimum payments for debts not yet visible in imported history are part of the shared surplus figure.
  const debt = typical?.avgMonthlyExpenses != null ? Math.max(0, round(typical.avgMonthlyExpenses - recorded / m)) : 0;
  const [topMerchant, topCount] = [...merchants.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  return {
    flow: {
      months: m, income: round(monthlyIncome),
      fixed: flowGroup(fixedTotals, monthlyIncome, m, 'Other bills'),
      everyday: flowGroup(everydayTotals, monthlyIncome, m, 'Everything else'),
      debt: debt >= 1 ? debt : 0,
      left: round(monthlyIncome - recorded / m - (debt >= 1 ? debt : 0))
    },
    small: smallCount ? { under: SMALL_PURCHASE, perMonth: round(smallCount / m, 1), monthly: round(smallTotal / m), annual: round(smallTotal / m * 12),
      topMerchant: topMerchant || null, topMerchantPerMonth: topCount ? round(topCount / m, 1) : null } : null
  };
}
// Category x month grid of every spending category (fixed bills included, transfers excluded) for the heatmap.
// Raw monthly totals: the client colours each row against its own median so a steady bill stays neutral.
const HEATMAP_MONTHS = 12, HEATMAP_ROWS = 10;
function categoryHeatmap(transactions, today, available) {
  const currentIndex = today.getFullYear() * 12 + today.getMonth();
  const span = Math.min(HEATMAP_MONTHS, available);
  if (span < 3) return null;
  const rows = new Map();
  for (const tx of transactions) {
    const parsed = parseTxDate(tx.date);
    const amount = Math.abs(Number(tx.amount));
    if (!parsed || !Number.isFinite(amount) || !amount || String(tx.direction).toUpperCase() !== 'DEBIT' || isTransferRow(tx)) continue;
    const offset = currentIndex - (parsed.year * 12 + parsed.month);
    if (offset < 1 || offset > span) continue;
    const label = tx.category || 'Uncategorized';
    if (!rows.has(label)) rows.set(label, { label, values: Array(span).fill(0), fixed: 0, count: 0 });
    const row = rows.get(label);
    row.values[span - offset] += amount;
    row.count += 1;
    if (isFixed(tx)) row.fixed += 1;
  }
  return {
    months: Array.from({ length: span }, (_, i) => monthLabel(currentIndex - span + i)),
    rows: [...rows.values()].map(row => ({ label: row.label, id: benchmarkCategoryFor(row.label)?.id || null, fixed: row.fixed === row.count,
      values: row.values.map(value => round(value)), total: round(sum(row.values)) }))
      .sort((a, b) => b.total - a.total).slice(0, HEATMAP_ROWS)
  };
}

// Everyday merchants (fixed bills and transfers excluded) over the last three full months against the three before.
// One-off purchases are set aside, as in the category signals, so a single TV does not become the biggest bubble.
const VENDOR_LIMIT = 36;
function vendorBubbles(transactions, today) {
  const currentIndex = today.getFullYear() * 12 + today.getMonth();
  const recentMonths = new Set(), priorMonths = new Set(), everyday = [];
  for (const tx of transactions) {
    const parsed = parseTxDate(tx.date);
    const amount = Math.abs(Number(tx.amount));
    if (!parsed || !Number.isFinite(amount) || !amount) continue;
    const offset = currentIndex - (parsed.year * 12 + parsed.month);
    if (offset < 1 || offset > 6) continue;
    (offset <= 3 ? recentMonths : priorMonths).add(offset);
    if (String(tx.direction).toUpperCase() === 'DEBIT' && !isTransferRow(tx) && !isFixed(tx)) everyday.push({ tx, amount, offset, iso: parsed.iso });
  }
  const rm = recentMonths.size, pm = priorMonths.size;
  if (!rm) return null;
  const limit = Math.max(ONE_OFF_MIN, (median(everyday.map(entry => entry.amount)) || 0) * ONE_OFF_MULTIPLE);
  const groups = new Map();
  let setAsideCount = 0, setAsideTotal = 0;
  for (const entry of everyday) {
    const key = merchantGroup(entry.tx);
    if (!key) continue;
    if (entry.amount >= limit) {
      if (entry.offset <= 3) { setAsideCount += 1; setAsideTotal += entry.amount; }
      continue;
    }
    if (!groups.has(key)) groups.set(key, { recent: 0, prior: 0, visits: 0, months: new Set(), categories: new Map(), latest: null });
    const group = groups.get(key);
    if (entry.offset > 3) { group.prior += entry.amount; continue; }
    group.recent += entry.amount;
    group.visits += 1;
    group.months.add(entry.offset);
    const category = entry.tx.category || 'Uncategorized';
    group.categories.set(category, (group.categories.get(category) || 0) + entry.amount);
    if (!group.latest || entry.iso >= group.latest.iso) group.latest = entry;
  }
  const active = [...groups.values()].filter(group => group.recent > 0);
  const total = sum(active.map(group => group.recent));
  const items = active.map(group => {
    const monthly = group.recent / rm;
    return {
      name: merchantLabel(group.latest.tx),
      category: [...group.categories.entries()].sort((a, b) => b[1] - a[1])[0][0],
      monthly: round(monthly), visits: round(group.visits / rm, 1), ticket: round(group.recent / group.visits),
      share: round(group.recent / total, 4), regular: group.months.size === rm && rm >= 2,
      change: pm && group.prior ? round(monthly / (group.prior / pm) - 1, 3) : null,
      isNew: pm > 0 && !group.prior
    };
  }).sort((a, b) => b.monthly - a.monthly).slice(0, VENDOR_LIMIT);
  return { months: rm, compareMonths: pm, total: round(total / rm), items,
    setAside: setAsideCount ? { count: setAsideCount, monthly: round(setAsideTotal / rm), over: round(limit) } : null };
}

// Plain-language discoveries, each with one big figure. Ordered by how actionable they are; at most four are shown.
function buildInsights({ categories, opportunities, flow, small }) {
  const money = value => `$${Math.round(value).toLocaleString('en-US')}`;
  const byId = new Map(categories.map(row => [row.id, row]));
  const insights = [];
  const top = opportunities[0];
  if (top) {
    const row = byId.get(top.id);
    const reached = row.opportunity.monthsAtTarget;
    insights.push({ id: 'top-saving', tone: 'good', figure: `${money(top.annual)}/yr`, title: `Bring ${top.label} back to ${money(top.target)} a month`,
      detail: `${reached ? `You already managed it in ${reached} of the last ${Math.min(12, row.series.length)} months. ` : ''}That is ${money(top.monthly)} a month back in your pocket.` });
  }
  const spike = categories.filter(row => row.spike).sort((a, b) => (b.range.latest - b.range.p50) - (a.range.latest - a.range.p50))[0];
  if (spike) {
    const r = spike.range;
    insights.push({ id: 'spike', tone: 'bad', figure: 'Top 5%', title: `${spike.label} in ${r.month.split(' ')[0]} was unusually high`,
      detail: `${money(r.latest)}, higher than ${r.higherThan} of the ${r.compared} months before it. Your usual range is ${money(r.p5)} to ${money(r.p95)}.` });
  }
  // Only categories the Compass already flags, so the explanation never contradicts the signals.
  const moving = categories.filter(row => row.driver && row.driver.change > 0 && row.driver.cause !== 'steady'
    && (row.rising || row.benchmarkStatus === 'high' || row.benchmarkStatus === 'above')).sort((a, b) => b.driver.change - a.driver.change)[0];
  if (moving) {
    const d = moving.driver, when = d.basis === 'same-months-last-year' ? 'the same months last year' : 'the three months before';
    const visits = `${d.visitsNow.toFixed(1)} purchases a month against ${d.visitsThen.toFixed(1)}`, tickets = `about ${money(d.ticketNow)} each against ${money(d.ticketThen)}`;
    insights.push({
      both: { title: `${moving.label}: more often, and pricier`, detail: `${visits} in ${when}, and ${tickets}. Both levers are worth pulling.` },
      visits: { title: `${moving.label} is up because you go more often`, detail: `${visits} in ${when}, at ${tickets}. Fewer trips is the lever.` },
      price: { title: `${moving.label} costs more per purchase`, detail: `${tickets} in ${when}, and you buy about as often. Trading down, not cutting out, is the lever.` }
    }[d.cause]);
    Object.assign(insights[insights.length - 1], { id: 'driver', tone: 'warn', figure: `+${money(d.change)}/mo` });
  }
  if (small && small.annual >= 300) {
    insights.push({ id: 'small', tone: 'warn', figure: `${money(small.annual)}/yr`, title: `on purchases under ${money(small.under)}`,
      detail: `About ${Math.round(small.perMonth)} small purchases a month add up to ${money(small.monthly)}.${small.topMerchant ? ` Most often at ${small.topMerchant} (${Math.round(small.topMerchantPerMonth)} times a month).` : ''}` });
  }
  const perDay = flow?.income > 0 ? flow.income / WORKDAYS_PER_MONTH : null;
  const heavy = perDay && (byId.get(top?.id) || [...categories].sort((a, b) => b.average3 - a.average3)[0]);
  if (heavy) {
    insights.push({ id: 'work-days', tone: 'info', figure: `${(heavy.average3 / perDay).toFixed(1)} days`, title: `of work pays for ${heavy.label} each month`,
      detail: `Your take-home averages ${money(flow.income)} a month, about ${money(perDay)} for each working day. ${heavy.label} averages ${money(heavy.average3)}.` });
  }
  const win = categories.filter(row => row.range.compared >= 5 && row.range.higherThan === 0 && row.range.latest > 0)
    .sort((a, b) => (b.range.p50 - b.range.latest) - (a.range.p50 - a.range.latest))[0];
  if (win) {
    insights.push({ id: 'win', tone: 'good', figure: `${money(win.range.p50 - win.range.latest)} under`, title: `${win.label} in ${win.range.month.split(' ')[0]} was your lowest in a year`,
      detail: `${money(win.range.latest)} against your usual ${money(win.range.p50)}. Whatever you did, it worked.` });
  }
  return insights.slice(0, 4);
}
export function buildMoneyFlowSignals({ transactions = [], profile = null, today = new Date(), typical = null } = {}) {
  const normalized = normalizeProfile(profile);
  const profileSet = !!(normalized && (normalized.size || normalized.region || normalized.housing));
  const { byCategory, visitCounts, oneOffs, available, currentIndex } = monthlySeries(transactions, today);
  const who = profileLabel(normalized);
  const base = { source: SOURCE, profile: normalized, profileSet, comparedWith: who, monthsAnalyzed: available, categories: [], opportunities: [] };
  if (available < 3) return { ...base, status: 'needs-history' };
  const context = { profile: normalized, currentIndex };
  const categories = BENCHMARK_CATEGORIES
    .filter(category => byCategory.has(category.id))
    .map(category => ({ ...analyzeCategory(category, byCategory.get(category.id).slice(-available), context, visitCounts.get(category.id).slice(-available)), oneOffs: oneOffs.get(category.id) || [] }))
    .filter(row => row.average3 > 0);
  const opportunities = categories.filter(row => row.opportunity)
    .sort((a, b) => b.opportunity.monthly - a.opportunity.monthly)
    .map(row => ({ id: row.id, label: row.label, monthly: row.opportunity.monthly, annual: row.opportunity.annual, target: row.opportunity.target, message: headline(row, who) }));
  const { flow, small } = moneyFlow(transactions, today, typical);
  return {
    ...base, status: 'ok', categories, opportunities, flow, small,
    heatmap: categoryHeatmap(transactions, today, available), vendors: vendorBubbles(transactions, today),
    insights: buildInsights({ categories, opportunities, flow, small }),
    potentialMonthly: round(sum(opportunities.map(item => item.monthly))),
    potentialAnnual: round(sum(opportunities.map(item => item.annual)))
  };
}
