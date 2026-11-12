import { parseTxDate } from './normalize.js';
import { isTransferRow } from './transfers.js';

const round = value => Math.round(value * 100) / 100;
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const deviation = values => {
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
};
const monthKey = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const percentile = (sorted, p) => {
  const index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
};

function balanceStatistics(balances, accounts, from, to) {
  return accounts.filter(account => account.status === 'active' && ['checking', 'savings'].includes(account.kind)).map(account => {
    const daily = new Map();
    for (const row of balances) {
      const date = parseTxDate(row.date)?.iso;
      if (row.account_id !== account.id || row.is_pending || !date || date < from || date > to || !finite(row.balance)) continue;
      // Same-day records have no intraday timestamps: use the existing highest-ID closing-balance convention.
      if (!daily.has(date) || Number(row.id) > Number(daily.get(date).id)) daily.set(date, { id: row.id, balance: Number(row.balance) });
    }
    let peak = -Infinity;
    const points = [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, row]) => {
      peak = Math.max(peak, row.balance);
      return { date, balance: round(row.balance), peak: round(peak), drawdown: round(row.balance - peak) };
    });
    const grouped = new Map();
    for (const point of points) {
      const month = point.date.slice(0, 7);
      if (!grouped.has(month)) grouped.set(month, []);
      grouped.get(month).push(point);
    }
    const candles = [...grouped].filter(([, values]) => values.length >= 2).map(([month, values]) => ({
      month, open: values[0].balance, close: values.at(-1).balance,
      high: Math.max(...values.map(p => p.balance)), low: Math.min(...values.map(p => p.balance)),
      from: values[0].date, to: values.at(-1).date, observations: values.length
    }));
    return { id: account.id, name: account.name, points, candles, maxDrawdown: points.length ? Math.min(...points.map(p => p.drawdown)) : null };
  });
}

export function buildAnalyticsStatistics({ transactions = [], balances = [], accounts = [], today = new Date(), startBalance = null, monthlyNet = null, sharedSurplus = false }) {
  const current = today.getFullYear() * 12 + today.getMonth();
  const asOf = `${monthKey(current)}-${String(today.getDate()).padStart(2, '0')}`;
  const months = Array.from({ length: 12 }, (_, i) => ({ month: monthKey(current - 12 + i), spend: null, income: null }));
  const byMonth = new Map(months.map(month => [month.month, month]));
  for (const tx of transactions) {
    const date = parseTxDate(tx.date)?.iso, month = byMonth.get(date?.slice(0, 7));
    const direction = String(tx.direction).toUpperCase();
    if (!month || tx.is_pending || isTransferRow(tx) || !finite(tx.amount) || Number(tx.amount) === 0 || !['DEBIT', 'CREDIT'].includes(direction)) continue;
    if (month.spend === null) { month.spend = 0; month.income = 0; }
    month[direction === 'DEBIT' ? 'spend' : 'income'] += Math.abs(Number(tx.amount));
  }
  const points = months.map((month, i) => {
    const window = size => months.slice(Math.max(0, i - size + 1), i + 1);
    const rolling = size => {
      const values = window(size);
      return values.length === size && values.every(m => m.spend !== null) ? round(average(values.map(m => m.spend))) : null;
    };
    const prior = [];
    for (let j = i - 1; j >= Math.max(0, i - 6) && months[j].spend !== null; j--) prior.unshift(months[j]);
    const validPrior = prior.length >= 3;
    const mean = validPrior ? average(prior.map(m => m.spend)) : null;
    const sigma = validPrior ? deviation(prior.map(m => m.spend)) : null;
    return { month: month.month, spend: month.spend === null ? null : round(month.spend),
      income: month.income === null ? null : round(month.income),
      mean3: rolling(3), mean6: rolling(6), baseline: mean === null ? null : round(mean),
      lower: mean === null ? null : round(Math.max(0, mean - 2 * sigma)),
      upper: mean === null ? null : round(mean + 2 * sigma) };
  });
  const training = months.slice(-6);
  const ready = training.every(m => m.spend !== null);
  const fan = { samples: ready ? training.length : 0, basis: sharedSurplus ? 'typical-surplus' : 'recent-averages', trainingMonths: training.filter(m => m.spend !== null).map(m => m.month),
    points: [], reason: !finite(startBalance) ? 'A recorded starting cash balance is needed.'
      : !ready ? 'Import activity for each of the last 6 completed months to build a scenario range.' : null };
  if (!fan.reason) {
    const nets = training.map(m => m.income - m.spend);
    const mean = average(nets), center = finite(monthlyNet) ? Number(monthlyNet) : mean;
    let outcomes = [Number(startBalance)];
    fan.points.push({ month: 'Recorded balance', p10: round(outcomes[0]), p25: round(outcomes[0]), median: round(outcomes[0]), p75: round(outcomes[0]), p90: round(outcomes[0]) });
    for (let step = 1; step <= 6; step++) {
      // Enumerate all six-month resamples: deterministic, with no Monte Carlo noise or invented probability of success.
      outcomes = outcomes.flatMap(balance => nets.map(net => balance + center + net - mean)).sort((a, b) => a - b);
      fan.points.push({ month: monthKey(current + step), p10: round(percentile(outcomes, .1)), p25: round(percentile(outcomes, .25)),
        median: round(percentile(outcomes, .5)), p75: round(percentile(outcomes, .75)), p90: round(percentile(outcomes, .9)) });
    }
  }
  return { points, observedMonths: points.filter(p => p.spend !== null).length, fan,
    balances: balanceStatistics(balances, accounts, `${monthKey(current - 11)}-01`, asOf) };
}
