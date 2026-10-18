// Money flow signals: compares standard spending categories with similar US households and reads each category's
// monthly series the way a technical analyst reads a price chart (moving-average crossover, momentum, volatility
// bands, support level and up-month breadth) to find specific, realistic ways to spend less.
//
// Benchmarks come from public data only: the U.S. Bureau of Labor Statistics Consumer Expenditure Survey, 2024
// calendar year, mean annual spending per consumer unit (downloaded from the BLS public API, series CXU<item>LB<group>M).
// No other MyFinance user's data is used. A pooled source (opt-in, anonymized, minimum cohort size) can be added later
// as another entry in BENCHMARK_SOURCES without changing the signals.
import { parseTxDate } from './normalize.js';
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
  const byCategory = new Map(), entries = new Map(), oneOffs = new Map();
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
    const series = Array(HISTORY).fill(0), skipped = [];
    for (const entry of list) {
      if (!isFixed(entry.tx) && entry.amount >= Math.max(ONE_OFF_MIN, typical * ONE_OFF_MULTIPLE)) {
        skipped.push({ date: entry.iso, description: entry.tx.description || '', amount: round(entry.amount) });
      } else series[entry.slot] += entry.amount;
    }
    byCategory.set(id, series);
    oneOffs.set(id, skipped.sort((a, b) => b.date.localeCompare(a.date)));
  }
  // A history that starts mid-month makes the first month look artificially cheap, so it is skipped.
  const startIndex = firstIndex + (firstDay > 3 ? 1 : 0);
  const available = Number.isFinite(firstIndex) ? Math.max(0, Math.min(HISTORY, currentIndex - startIndex)) : 0;
  return { byCategory, oneOffs, available, currentIndex };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = index => `${MONTH_NAMES[index % 12]} ${Math.floor(index / 12)}`;

function analyzeCategory(category, series, context) {
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

  return {
    id: category.id, label: category.label, covers: category.covers, seasonal: !!category.seasonal,
    average3: round(avg3), expected, vsTypical: round(vsTypical, 4), benchmarkStatus,
    crossover, momentum, band, upMonths, upWindow: Math.max(0, recent.length - 1),
    support: round(support), normal: round(normal), opportunity,
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

export function buildMoneyFlowSignals({ transactions = [], profile = null, today = new Date() } = {}) {
  const normalized = normalizeProfile(profile);
  const profileSet = !!(normalized && (normalized.size || normalized.region || normalized.housing));
  const { byCategory, oneOffs, available, currentIndex } = monthlySeries(transactions, today);
  const who = profileLabel(normalized);
  const base = { source: SOURCE, profile: normalized, profileSet, comparedWith: who, monthsAnalyzed: available, categories: [], opportunities: [] };
  if (available < 3) return { ...base, status: 'needs-history' };
  const context = { profile: normalized, currentIndex };
  const categories = BENCHMARK_CATEGORIES
    .filter(category => byCategory.has(category.id))
    .map(category => ({ ...analyzeCategory(category, byCategory.get(category.id).slice(-available), context), oneOffs: oneOffs.get(category.id) || [] }))
    .filter(row => row.average3 > 0);
  const opportunities = categories.filter(row => row.opportunity)
    .sort((a, b) => b.opportunity.monthly - a.opportunity.monthly)
    .map(row => ({ id: row.id, label: row.label, monthly: row.opportunity.monthly, annual: row.opportunity.annual, target: row.opportunity.target, message: headline(row, who) }));
  return {
    ...base, status: 'ok', categories, opportunities,
    potentialMonthly: round(sum(opportunities.map(item => item.monthly))),
    potentialAnnual: round(sum(opportunities.map(item => item.annual)))
  };
}
