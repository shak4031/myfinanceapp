const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const MAX_MONTHS = 720;

export function monthIndex(key) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return Number(match[1]) * 12 + month - 1;
}

export function monthFromIndex(index) {
  return `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
}

export function paymentFor(principal, apr, termMonths) {
  const p = Number(principal), n = Number(termMonths), r = Number(apr) / 1200;
  if (!(p > 0) || !(n > 0)) return 0;
  if (!(r > 0)) return round(p / n);
  return round(p * r / (1 - (1 + r) ** -n));
}

// Runs a loan forward from `balance`, applying `extraFor(monthKey, n)` on top of the scheduled payment.
// `finalIndex` is the last scheduled month; its payment absorbs the cents left over from rounding.
export function runLoan({ balance, apr, payment, startMonth, extraFor = () => 0, maxMonths = MAX_MONTHS, finalIndex = null }) {
  const r = Number(apr) / 1200;
  const start = monthIndex(startMonth);
  let remaining = round(balance);
  let totalInterest = 0, totalPaid = 0;
  const rows = [];
  for (let n = 0; remaining > 0.004 && n < maxMonths; n++) {
    const month = monthFromIndex(start + n);
    const interest = round(remaining * r);
    const scheduled = Math.min(Number(payment), round(remaining + interest));
    if (scheduled <= interest && n === 0 && !(extraFor(month, n) > 0)) {
      return { rows, months: Infinity, totalInterest: Infinity, totalPaid: Infinity, payoffMonth: null, neverPaysOff: true };
    }
    const principalScheduled = round(scheduled - interest);
    const extra = Math.max(0, Math.min(round(extraFor(month, n) || 0), round(remaining - principalScheduled)));
    const principal = round(principalScheduled + extra);
    remaining = round(remaining - principal);
    if (remaining < 0) remaining = 0;
    let finalPrincipal = principal;
    if (n === finalIndex && remaining > 0 && remaining < Math.max(1, Number(payment) * 0.02)) {
      finalPrincipal = round(principal + remaining);
      remaining = 0;
    }
    totalInterest = round(totalInterest + interest);
    totalPaid = round(totalPaid + interest + finalPrincipal);
    rows.push({ month, payment: round(interest + finalPrincipal), interest, principal: finalPrincipal, extra, balance: remaining });
  }
  const neverPaysOff = remaining > 0.004;
  return {
    rows,
    months: neverPaysOff ? Infinity : rows.length,
    totalInterest: neverPaysOff ? Infinity : totalInterest,
    totalPaid: neverPaysOff ? Infinity : totalPaid,
    payoffMonth: neverPaysOff ? null : rows.at(-1)?.month ?? startMonth,
    neverPaysOff
  };
}

export function buildSchedule({ principal, apr, termMonths, firstPaymentMonth, payment }) {
  const scheduled = Number(payment) > 0 ? Number(payment) : paymentFor(principal, apr, termMonths);
  return { payment: scheduled, ...runLoan({ balance: principal, apr, payment: scheduled, startMonth: firstPaymentMonth, finalIndex: Number(termMonths) - 1 }) };
}

export function yearlyRollup(rows) {
  const years = new Map();
  for (const row of rows) {
    const year = row.month.slice(0, 4);
    const item = years.get(year) || { year, interest: 0, principal: 0, paid: 0, endBalance: 0, months: [] };
    item.interest = round(item.interest + row.interest);
    item.principal = round(item.principal + row.principal);
    item.paid = round(item.paid + row.payment);
    item.endBalance = row.balance;
    item.months.push(row);
    years.set(year, item);
  }
  return [...years.values()];
}

// Interest for a specific calendar month from the original schedule, or null when outside it.
export function scheduledInterestFor(loan, month) {
  const first = monthIndex(loan.first_payment_month ?? loan.firstPaymentMonth);
  const target = monthIndex(month);
  const principal = Number(loan.original_amount ?? loan.principal);
  const term = Number(loan.term_months ?? loan.termMonths);
  if (first === null || target === null || !(principal > 0) || !(term > 0) || target < first) return null;
  const schedule = buildSchedule({ principal, apr: loan.apr, termMonths: term, firstPaymentMonth: monthFromIndex(first) });
  return schedule.rows[target - first]?.interest ?? null;
}

function clampNumber(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeMortgageInput(input = {}, now = new Date()) {
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const principal = round(clampNumber(input.principal ?? input.original_amount, 0, 100000000));
  const apr = clampNumber(input.apr, 0, 40);
  const termMonths = Math.round(clampNumber(input.termMonths ?? input.term_months, 0, 600));
  const firstPaymentMonth = monthIndex(input.firstPaymentMonth ?? input.first_payment_month) !== null
    ? String(input.firstPaymentMonth ?? input.first_payment_month) : currentMonth;
  const rawBalance = input.currentBalance ?? input.balance;
  const currentBalance = rawBalance === '' || rawBalance == null ? null : round(clampNumber(rawBalance, 0, 100000000));
  const lumpMonth = monthIndex(input.lumpSumMonth) !== null ? String(input.lumpSumMonth) : currentMonth;
  return {
    principal, apr, termMonths, firstPaymentMonth, currentBalance, currentMonth,
    escrow: round(clampNumber(input.escrow ?? input.escrow_payment, 0, 1000000)),
    extraMonthly: round(clampNumber(input.extraMonthly, 0, 1000000)),
    extraYearly: round(clampNumber(input.extraYearly, 0, 10000000)),
    extraYearlyMonth: Math.round(clampNumber(input.extraYearlyMonth, 1, 12, 12)),
    lumpSum: round(clampNumber(input.lumpSum, 0, 100000000)),
    lumpSumMonth: lumpMonth,
    biweekly: input.biweekly === true || input.biweekly === 'true'
  };
}

export function simulateMortgage(raw, now = new Date()) {
  const input = normalizeMortgageInput(raw, now);
  if (!(input.principal > 0) || !(input.termMonths > 0)) {
    const error = new Error('Enter the original loan amount and term to build a schedule');
    error.status = 400;
    throw error;
  }
  const original = buildSchedule(input);
  const payment = original.payment;
  const first = monthIndex(input.firstPaymentMonth);
  const current = monthIndex(input.currentMonth);
  const elapsed = Math.max(0, Math.min(current - first, original.rows.length));
  const paidRows = original.rows.slice(0, elapsed);
  const scheduledBalance = elapsed ? paidRows.at(-1).balance : input.principal;
  const balance = input.currentBalance ?? scheduledBalance;
  const startMonth = monthFromIndex(Math.max(first, current));
  const thisYear = String(now.getFullYear());

  const finalIndex = input.termMonths - 1 - Math.max(0, current - first);
  const baseline = runLoan({ balance, apr: input.apr, payment, startMonth, finalIndex });
  const yearlyExtraMonth = String(input.extraYearlyMonth).padStart(2, '0');
  const biweeklyExtra = input.biweekly ? round(payment / 12) : 0;
  const scenario = runLoan({
    balance, apr: input.apr, payment, startMonth, finalIndex,
    extraFor: month => input.extraMonthly + biweeklyExtra
      + (input.extraYearly && month.slice(5) === yearlyExtraMonth ? input.extraYearly : 0)
      + (input.lumpSum && month === input.lumpSumMonth ? input.lumpSum : 0)
  });
  const finite = value => Number.isFinite(value) ? value : null;
  const series = [];
  const length = Math.max(baseline.rows.length, scenario.rows.length);
  for (let i = 0; i < length; i += 1) {
    const month = baseline.rows[i]?.month ?? scenario.rows[i]?.month;
    if (i % 12 !== 11 && i !== length - 1 && i !== scenario.rows.length - 1) continue;
    series.push({ month, offset: i + 1, baseline: baseline.rows[i]?.balance ?? 0, scenario: scenario.rows[i]?.balance ?? 0 });
  }
  series.unshift({ month: startMonth, offset: 0, baseline: balance, scenario: balance, start: true });

  return {
    input,
    payment,
    totalPayment: round(payment + input.escrow),
    original: {
      totalInterest: finite(original.totalInterest),
      totalPaid: finite(original.totalPaid),
      payoffMonth: original.payoffMonth,
      years: yearlyRollup(original.rows)
    },
    toDate: {
      months: elapsed,
      interest: round(paidRows.reduce((sum, row) => sum + row.interest, 0)),
      principal: round(paidRows.reduce((sum, row) => sum + row.principal, 0)),
      scheduledBalance
    },
    thisYearInterest: round(original.rows.filter(row => row.month.startsWith(thisYear)).reduce((sum, row) => sum + row.interest, 0)),
    balance,
    baseline: { months: finite(baseline.months), totalInterest: finite(baseline.totalInterest), payoffMonth: baseline.payoffMonth },
    scenario: {
      months: finite(scenario.months),
      totalInterest: finite(scenario.totalInterest),
      payoffMonth: scenario.payoffMonth,
      extraMonthlyTotal: round(input.extraMonthly + biweeklyExtra)
    },
    savings: {
      interest: finite(baseline.totalInterest - scenario.totalInterest) === null ? null : Math.max(0, round(baseline.totalInterest - scenario.totalInterest)),
      months: finite(baseline.months - scenario.months) === null ? null : Math.max(0, baseline.months - scenario.months)
    },
    series
  };
}
