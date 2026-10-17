// Debt-free program engine: deterministic month-by-month simulation shared by the plan page and the dashboard.
const cents = value => Math.round(value * 100) / 100;
const MAX_MONTHS = 600;

export const DEBT_STRATEGIES = Object.freeze([
  { id: 'avalanche', name: 'Avalanche', pro: false, tagline: 'Highest APR first', detail: 'Mathematically the cheapest: every extra dollar goes to the most expensive debt.' },
  { id: 'snowball', name: 'Snowball', pro: false, tagline: 'Smallest balance first', detail: 'Quick wins. Each payoff frees its minimum to roll into the next debt.' },
  { id: 'interest', name: 'Interest cost', pro: true, tagline: 'Biggest interest bill first', detail: 'Targets the debt charging the most dollars of interest each month.' },
  { id: 'cashflow', name: 'Cash-flow', pro: true, tagline: 'Free up monthly payments', detail: 'Clears debts with the highest minimum for their size, freeing monthly cash fastest.' },
  { id: 'custom', name: 'My order', pro: true, tagline: 'You set the order', detail: 'Pay down debts in your own order. Every minimum is still paid.' }
]);
export const strategyIds = DEBT_STRATEGIES.map(strategy => strategy.id);

const comparators = {
  avalanche: (a, b) => b.apr - a.apr || a.balance - b.balance,
  snowball: (a, b) => a.balance - b.balance || b.apr - a.apr,
  interest: (a, b) => b.balance * b.apr - a.balance * a.apr || b.apr - a.apr,
  cashflow: (a, b) => b.min_payment / b.balance - a.min_payment / a.balance || a.balance - b.balance,
  custom: (a, b) => (a.custom_rank ?? 1e9) - (b.custom_rank ?? 1e9) || b.apr - a.apr
};

export function normalizeDebt(row) {
  const number = value => Math.max(0, Number(value) || 0);
  return {
    id: row.id, name: row.name || row.card_name || 'Debt', debt_type: row.debt_type || 'credit_card',
    balance: cents(number(row.balance)), apr: number(row.apr), min_payment: cents(number(row.min_payment)),
    credit_limit: cents(number(row.credit_limit)), due_day: Number(row.due_date) || null,
    included: row.included !== false, focus: row.focus === true,
    custom_rank: row.custom_rank == null ? null : Number(row.custom_rank),
    payment_in_history: row.payment_in_history !== false
  };
}

// Focus debts always go first (the user's bias); the strategy orders the rest and breaks ties among focus debts.
export function orderDebts(debts, strategy = 'avalanche') {
  const sorted = [...debts].sort((a, b) => (comparators[strategy] || comparators.avalanche)(a, b) || String(a.id).localeCompare(String(b.id)));
  return [...sorted.filter(debt => debt.focus), ...sorted.filter(debt => !debt.focus)];
}

export const monthKey = (start, offset = 0) => {
  const date = new Date(start.getFullYear(), start.getMonth() + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};

export function requiredMinimums(debts) {
  return cents(debts.filter(debt => debt.balance > 0)
    .reduce((sum, debt) => sum + Math.min(debt.min_payment, debt.balance * (1 + debt.apr / 1200)), 0));
}

// Month 1 is the current month. Interest accrues, minimums are paid, then any extra rolls down the order.
export function simulatePayoff(debts, { budget = 0, strategy = 'avalanche', lumpSum = 0, start = new Date(), minimumsOnly = false } = {}) {
  const order = orderDebts(debts.filter(debt => debt.balance > 0), strategy);
  const state = order.map(debt => ({ ...debt, remaining: debt.balance, interest: 0, paidOffMonth: null }));
  const empty = { feasible: true, debtFree: true, months: 0, totalInterest: 0, totalPaid: 0, series: [0], payoffs: [], firstMonth: [], order: [], debtFreeDate: null };
  if (!state.length) return empty;
  const minimums = requiredMinimums(state);
  if (!minimumsOnly && budget + 0.005 < minimums) {
    return { ...empty, feasible: false, debtFree: false, reason: `Your budget is ${cents(minimums - budget).toFixed(2)} below this month's minimum payments.`, minimums };
  }
  let lump = Math.max(0, Number(lumpSum) || 0), totalInterest = 0, totalPaid = 0;
  for (const debt of state) {
    const pay = Math.min(lump, debt.remaining);
    debt.remaining = cents(debt.remaining - pay); lump -= pay; totalPaid += pay;
    if (debt.remaining <= 0.005 && pay > 0) debt.paidOffMonth = 0;
  }
  const series = [cents(state.reduce((sum, debt) => sum + debt.remaining, 0))];
  let firstMonth = [], month = 0;
  while (month < MAX_MONTHS && state.some(debt => debt.remaining > 0.005)) {
    month++;
    const active = state.filter(debt => debt.remaining > 0.005);
    for (const debt of active) {
      const interest = cents(debt.remaining * debt.apr / 1200);
      debt.remaining = cents(debt.remaining + interest); debt.interest += interest; totalInterest += interest;
    }
    const payments = new Map(state.map(debt => [debt.id, { minimum: 0, extra: 0 }]));
    let available = minimumsOnly ? Infinity : budget;
    for (const debt of active) {
      const pay = Math.min(debt.remaining, debt.min_payment);
      debt.remaining = cents(debt.remaining - pay); payments.get(debt.id).minimum = cents(pay);
      if (!minimumsOnly) available -= pay;
      totalPaid += pay;
    }
    if (!minimumsOnly) {
      for (const debt of state) {
        if (available <= 0.005) break;
        const pay = Math.min(available, debt.remaining);
        if (pay <= 0) continue;
        debt.remaining = cents(debt.remaining - pay); available -= pay; totalPaid += pay;
        payments.get(debt.id).extra = cents(payments.get(debt.id).extra + pay);
      }
    }
    for (const debt of state) if (debt.paidOffMonth == null && debt.remaining <= 0.005) { debt.remaining = 0; debt.paidOffMonth = month; }
    if (month === 1) firstMonth = state.map(debt => ({ id: debt.id, ...payments.get(debt.id) }));
    series.push(cents(state.reduce((sum, debt) => sum + debt.remaining, 0)));
  }
  const debtFree = state.every(debt => debt.remaining <= 0.005);
  return {
    feasible: true, debtFree, months: month, totalInterest: cents(totalInterest), totalPaid: cents(totalPaid), series, firstMonth,
    order: state.map(debt => debt.id), debtFreeDate: debtFree ? monthKey(start, Math.max(0, month - 1)) : null,
    reason: debtFree ? '' : 'Payments do not outpace interest within 50 years. Raise the budget or ask lenders about lower rates.',
    payoffs: state.map(debt => ({
      id: debt.id, name: debt.name, month: debt.paidOffMonth, interest: cents(debt.interest),
      date: debt.paidOffMonth == null ? null : monthKey(start, Math.max(0, debt.paidOffMonth - 1))
    }))
  };
}

const summary = result => ({
  feasible: result.feasible, debtFree: result.debtFree, months: result.months, debtFreeDate: result.debtFreeDate,
  totalInterest: result.totalInterest, totalPaid: result.totalPaid, reason: result.reason || ''
});
const money = value => `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const monthsText = months => months >= 24 && months % 12 === 0 ? `${months / 12} years` : `${months} month${months === 1 ? '' : 's'}`;

export function buildDebtPlan({ debts: rows = [], settings = {}, surplus = null, pro = false, now = new Date(), whatIf = null, hasEmergencyGoal = false } = {}) {
  const all = rows.map(normalizeDebt);
  const included = all.filter(debt => debt.included && debt.balance > 0);
  const excluded = all.filter(debt => !debt.included && debt.balance > 0);
  const requested = strategyIds.includes(settings.debt_strategy) ? settings.debt_strategy : 'avalanche';
  const locked = DEBT_STRATEGIES.find(item => item.id === requested)?.pro && !pro;
  const strategy = locked ? 'avalanche' : requested;
  const minimums = requiredMinimums(included);
  const savedBudget = settings.debt_budget == null ? null : Number(settings.debt_budget);
  const budget = cents(savedBudget == null || !Number.isFinite(savedBudget) ? minimums : savedBudget);
  const extra = cents(Math.max(0, budget - minimums));
  const plan = simulatePayoff(included, { budget, strategy, start: now });
  const baseline = simulatePayoff(included, { minimumsOnly: true, start: now });
  const comparison = DEBT_STRATEGIES.filter(item => item.id !== 'custom' || included.some(debt => debt.custom_rank != null) || strategy === 'custom')
    .map(item => {
      const isLocked = item.pro && !pro;
      return { id: item.id, name: item.name, tagline: item.tagline, detail: item.detail, pro: item.pro, locked: isLocked,
        ...(isLocked ? {} : summary(simulatePayoff(included, { budget, strategy: item.id, start: now }))) };
    });
  const viable = comparison.filter(item => !item.locked && item.feasible && item.debtFree);
  const cheapest = viable.reduce((best, item) => !best || item.totalInterest < best.totalInterest - 0.5 ? item : best, null);
  const recommended = cheapest?.id || 'avalanche';

  const totalBalance = cents(included.reduce((sum, debt) => sum + debt.balance, 0));
  const monthlyInterest = cents(included.reduce((sum, debt) => sum + debt.balance * debt.apr / 1200, 0));
  const weightedApr = totalBalance ? cents(included.reduce((sum, debt) => sum + debt.balance * debt.apr, 0) / totalBalance) : 0;

  let suggestion = null;
  if (included.length && surplus > 50 && plan.feasible) {
    const amount = Math.floor(surplus * 0.5 / 25) * 25;
    if (amount >= 25) {
      const boosted = simulatePayoff(included, { budget: budget + amount, strategy, start: now });
      if (boosted.debtFree) suggestion = {
        extra: amount, budget: cents(budget + amount), months: boosted.months, debtFreeDate: boosted.debtFreeDate,
        monthsSaved: plan.debtFree ? plan.months - boosted.months : null, interestSaved: plan.debtFree ? cents(plan.totalInterest - boosted.totalInterest) : null
      };
    }
  }

  let scenario = null;
  if (whatIf && pro && included.length) {
    const scenarioExtra = Math.max(0, Number(whatIf.extra) || 0), lumpSum = Math.max(0, Number(whatIf.lumpSum) || 0);
    const result = simulatePayoff(included, { budget: budget + scenarioExtra, strategy, lumpSum, start: now });
    scenario = {
      extra: scenarioExtra, lumpSum, ...summary(result), series: result.series,
      monthsSaved: plan.debtFree && result.debtFree ? plan.months - result.months : null,
      interestSaved: plan.debtFree && result.debtFree ? cents(plan.totalInterest - result.totalInterest) : null
    };
  }

  const guidance = [];
  const add = (severity, title, detail) => guidance.push({ severity, title, detail });
  if (!included.length) {
    if (all.length) add('info', 'No debts are in the program', 'Include at least one debt to build a debt-free plan.');
  } else {
    if (!plan.feasible) add('danger', 'The budget does not cover the minimums', `Minimums this month total ${money(minimums)}. Missing a minimum adds fees and can hurt your credit. Raise the budget to at least that amount.`);
    for (const debt of included) {
      if (debt.min_payment <= debt.balance * debt.apr / 1200 + 0.005) add('danger', `${debt.name} never shrinks at its minimum`, `Its ${money(debt.min_payment)} minimum barely covers about ${money(debt.balance * debt.apr / 1200)} of monthly interest. Put extra money here first or ask the lender about a hardship rate.`);
    }
    const priciest = [...included].sort((a, b) => b.apr - a.apr)[0];
    if (priciest.apr >= 15) add('warning', `${priciest.name} is your most expensive money`, `At ${priciest.apr}% APR it costs about ${money(priciest.balance * priciest.apr / 1200)} a month in interest. Every extra dollar here is a guaranteed ${priciest.apr}% return, which is hard to beat anywhere else.`);
    const focus = included.filter(debt => debt.focus);
    const avalanche = comparison.find(item => item.id === 'avalanche');
    if (focus.length && plan.debtFree) {
      const pure = simulatePayoff(included.map(debt => ({ ...debt, focus: false })), { budget, strategy: 'avalanche', start: now });
      const cost = cents(plan.totalInterest - pure.totalInterest);
      if (pure.debtFree && cost > 1) add('info', `Your focus on ${focus.map(debt => debt.name).join(' and ')} costs about ${money(cost)}`, `That is the extra interest compared with a pure avalanche${plan.months > pure.months ? `, and ${monthsText(plan.months - pure.months)} longer` : ''}. It is a fair trade if clearing it matters to you, for example to free up a credit line or remove a co-signer.`);
      else if (pure.debtFree) add('success', 'Your focus lines up with the math', 'Putting extra money on your focus debt costs nothing extra compared with the avalanche method.');
    }
    const snowball = comparison.find(item => item.id === 'snowball');
    if (avalanche?.debtFree && snowball?.debtFree && !focus.length) {
      const gap = cents(snowball.totalInterest - avalanche.totalInterest);
      const firstWin = simulatePayoff(included, { budget, strategy: 'snowball', start: now }).payoffs.filter(item => item.month != null).sort((a, b) => a.month - b.month)[0];
      if (gap <= Math.max(75, avalanche.totalInterest * 0.03)) add('success', gap < 1 ? 'Avalanche and snowball cost the same here' : 'Avalanche and snowball are nearly tied', `${gap < 1 ? 'Snowball costs no extra interest' : `Snowball costs only ${money(gap)} more`}${firstWin ? ` and clears ${firstWin.name} in ${monthsText(firstWin.month)}` : ''}. Choose the one that keeps you motivated.`);
      else if (strategy === 'snowball') add('info', `Snowball costs ${money(gap)} more than avalanche`, 'You are paying that for faster early wins. Switch to avalanche any time to keep that money.');
    }
    if (extra === 0 && plan.feasible) add('info', 'You are only paying minimums', `Minimums alone take ${baseline.debtFree ? monthsText(baseline.months) : 'more than 50 years'} and ${baseline.debtFree ? money(baseline.totalInterest) : 'an unknown amount'} in interest. Even a small extra amount shortens that a lot.`);
    if (suggestion?.monthsSaved > 0) add('success', `Adding ${money(suggestion.extra)} a month makes you debt-free ${monthsText(suggestion.monthsSaved)} sooner`, `That is about half of your typical monthly surplus and saves ${money(suggestion.interestSaved)} in interest.`);
    for (const debt of included.filter(item => item.debt_type === 'credit_card' && item.credit_limit > 0)) {
      const utilization = debt.balance / debt.credit_limit;
      if (utilization > 0.3) add('info', `${debt.name} is ${Math.round(utilization * 100)}% of its limit`, `Getting below 30% (${money(debt.credit_limit * 0.3)}) usually helps your credit score.`);
    }
    if (!hasEmergencyGoal && priciest.apr >= 8) add('info', 'Keep a starter emergency fund', 'Hold about $1,000 or one month of bills in savings before going all-in, so a surprise expense does not land back on a card.');
    const cheap = included.filter(debt => debt.apr > 0 && debt.apr < 5);
    if (cheap.length && included.some(debt => debt.apr >= 8)) add('info', 'Low-rate debt can wait', `${cheap.map(debt => debt.name).join(', ')} ${cheap.length === 1 ? 'is' : 'are'} under 5% APR. Clear high-rate debt first; extra payments on cheap debt are the last priority.`);
  }
  if (excluded.length) add('info', `${excluded.length} debt${excluded.length === 1 ? ' is' : 's are'} outside the program`, `Keep paying ${excluded.map(debt => debt.name).join(', ')} at the usual amount. ${excluded.length === 1 ? 'Its minimum is' : 'Their minimums are'} not part of this plan.`);

  const firstMonth = new Map(plan.firstMonth.map(row => [row.id, row]));
  const payoffs = new Map(plan.payoffs.map(row => [row.id, row]));
  const ordered = plan.order;
  const debts = all.map(debt => ({
    ...debt, monthlyInterest: cents(debt.balance * debt.apr / 1200),
    utilization: debt.credit_limit > 0 ? cents(debt.balance / debt.credit_limit * 100) : null,
    rank: ordered.includes(debt.id) ? ordered.indexOf(debt.id) + 1 : null,
    payoffMonth: payoffs.get(debt.id)?.month ?? null, payoffDate: payoffs.get(debt.id)?.date ?? null,
    interestPaid: payoffs.get(debt.id)?.interest ?? null,
    thisMonth: firstMonth.get(debt.id) || { minimum: 0, extra: 0 }
  })).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.balance - a.balance);

  return {
    strategies: DEBT_STRATEGIES.map(item => ({ ...item, locked: item.pro && !pro })),
    strategy, requestedStrategy: requested, strategyLocked: !!locked, recommended, budget, budgetIsSet: savedBudget != null, minimums, extra,
    totals: { balance: totalBalance, monthlyInterest, weightedApr, included: included.length, excluded: excluded.length, count: all.length },
    plan: { ...summary(plan), series: plan.series, payoffs: plan.payoffs },
    baseline: { ...summary(baseline), series: baseline.series },
    comparison, suggestion, scenario, guidance, debts,
    interestSavedVsMinimums: plan.debtFree && baseline.debtFree ? cents(baseline.totalInterest - plan.totalInterest) : null,
    monthsSavedVsMinimums: plan.debtFree && baseline.debtFree ? baseline.months - plan.months : null
  };
}
