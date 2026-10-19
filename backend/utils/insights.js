// Welcome-screen insights: short, actionable messages ranked by urgency.
import { threePaycheckMonths } from './income.js';

const cents = value => Math.round(value * 100) / 100;
const money = value => `$${Math.abs(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const signedMoney = value => `${value < 0 ? '−' : ''}${money(value)}`;
const pct = value => `${Math.round(Math.abs(value) * 100)}%`;
const RANK = { danger: 0, warning: 1, info: 2, success: 2, pro: 3 };
const MAX_INSIGHTS = 8;
const DAY_MS = 86400000;
const STALE_IMPORT_DAYS = 7;
const sumAmounts = items => cents(items.reduce((sum, item) => sum + Number(item.amount || 0), 0));
const shortDate = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const dateFor = (today, day) => new Date(today.getFullYear(), today.getMonth(), day);
const dayLabel = (today, day) => {
  const diff = day - today.getDate();
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const date = dateFor(today, day);
  return diff > 1 && diff < 7
    ? date.toLocaleDateString('en-US', { weekday: 'long' })
    : date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};
const monthLabel = key => {
  if (!key) return '';
  const [year, month] = String(key).split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};
const nameOf = item => item.label || item.description || item.category || 'A payment';
const listNames = items => {
  const names = items.slice(0, 3).map(nameOf);
  const more = items.length - names.length;
  return `${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

// Walks the rest of the month from today's balance. Same-day income lands before same-day bills.
export function projectRunway(balance, upcoming, today) {
  const todayDay = today.getDate();
  const ahead = upcoming.filter(item => item.status !== 'processed' && item.dayOfMonth >= todayDay)
    .sort((a, b) => a.dayOfMonth - b.dayOfMonth || Number(b.isIncome) - Number(a.isIncome));
  if (balance == null || !Number.isFinite(Number(balance))) return { ahead, low: null, shortfall: null, end: null };
  let running = Number(balance), low = { amount: running, day: todayDay, item: null }, shortfall = null;
  for (const item of ahead) {
    running = cents(running + (item.isIncome ? 1 : -1) * Number(item.amount || 0));
    if (running < low.amount) low = { amount: running, day: item.dayOfMonth, item };
    if (running < 0 && !shortfall) shortfall = { amount: running, day: item.dayOfMonth, item };
  }
  return { ahead, low, shortfall, end: running };
}

// Balance minus every bill and planned payment due before the next paycheck (or month end if none is expected).
export function safeToSpend(balance, runway, today) {
  if (balance == null || !Number.isFinite(Number(balance))) return null;
  const nextPayday = runway.ahead.find(item => item.isIncome && item.dayOfMonth > today.getDate()) || null;
  const committed = runway.ahead.filter(item => !item.isIncome && (!nextPayday || item.dayOfMonth < nextPayday.dayOfMonth));
  return {
    amount: cents(Number(balance) - sumAmounts(committed)), committed: sumAmounts(committed), count: committed.length,
    untilDay: nextPayday ? nextPayday.dayOfMonth : null
  };
}

export function buildInsights({ today = new Date(), balance = null, upcoming = [], plan = null, analytics = null, pro = false, hasData = true, incomeStreams = [], lastImport = null, accounts = null } = {}) {
  const insights = [];
  const add = (insight, weight = 0) => insights.push({ ...insight, weight });
  const todayDay = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const runway = projectRunway(balance, upcoming, today);
  const outflows = runway.ahead.filter(item => !item.isIncome);
  const bills = outflows.filter(item => !item.planned);
  const nextIncome = runway.ahead.find(item => item.isIncome) || null;
  const safe = safeToSpend(balance, runway, today);
  const midnight = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const importAge = lastImport?.at ? Math.max(0, Math.round((midnight(today) - midnight(new Date(lastImport.at))) / DAY_MS)) : null;

  if (!hasData) {
    add({ id: 'import', tone: 'info', icon: 'upload', title: 'Import a statement to get started',
      detail: 'Upload a CSV or PDF from your bank. MyFinance learns your bills, paydays and spending, then this space fills with personal insights.',
      action: { label: 'Import statements', act: 'import' } });
  }

  // Cash runway
  if (runway.shortfall) {
    const { day, amount, item } = runway.shortfall;
    const flexible = outflows.filter(entry => entry.flexible && entry.dayOfMonth <= day);
    add({ id: 'shortfall', tone: 'danger', icon: 'alert', title: `You could run short ${dayLabel(today, day)}`,
      detail: `After ${nameOf(item)} on the ${ordinal(day)}, your projected balance drops to ${signedMoney(amount)}.${flexible.length ? ` Trimming a flexible plan payment (${listNames(flexible)}) would help.` : ' Move money in or shift a payment before then.'}`,
      action: { label: 'Review the calendar', act: 'upcoming' } }, -day);
  } else if (runway.low && outflows.length && runway.low.amount < 250 && runway.low.item) {
    add({ id: 'tight', tone: 'warning', icon: 'alert', title: `Things get tight around the ${ordinal(runway.low.day)}`,
      detail: `Your balance is projected to dip to ${money(runway.low.amount)} after ${nameOf(runway.low.item)}. Hold off on extras until ${nextIncome ? `payday on the ${ordinal(nextIncome.dayOfMonth)}` : 'it clears'}.`,
      action: { label: 'Review the calendar', act: 'upcoming' } });
  } else if (runway.low && bills.length) {
    add({ id: 'covered', tone: 'success', icon: 'shield', title: 'Your bills are covered this month',
      detail: `${bills.length} bill${bills.length === 1 ? '' : 's'} totaling ${money(bills.reduce((sum, item) => sum + Number(item.amount), 0))} still to go. Your lowest projected balance is ${money(runway.low.amount)}${runway.low.item ? ` on the ${ordinal(runway.low.day)}` : ''}.`,
      action: { label: 'See upcoming payments', act: 'upcoming' } });
  }

  if (safe && safe.amount <= 0 && !runway.shortfall) {
    add({ id: 'safe-to-spend', tone: 'warning', icon: 'alert', title: 'Nothing is safe to spend before payday',
      detail: `Bills and planned payments of ${money(safe.committed)} are due ${safe.untilDay ? `before the ${ordinal(safe.untilDay)}` : 'before month end'}, which uses your whole balance. Hold off on extras until then.`,
      action: { label: 'Review the calendar', act: 'upcoming' } });
  }

  // Stale data quietly breaks every projection, so nudge a re-import after a week.
  if (hasData && importAge != null && importAge >= STALE_IMPORT_DAYS) {
    add({ id: 'import-stale', tone: importAge >= 14 ? 'warning' : 'info', icon: 'upload', title: `Your last import was ${importAge} days ago`,
      detail: `${lastImport.latestDate ? `Your newest transaction is from ${shortDate(lastImport.latestDate)}. ` : ''}Import your latest statement so your balance, bills and plan stay accurate.`,
      action: { label: 'Import statements', act: 'import' } }, -importAge);
  }

  // Account tracker: transfers to an account we have not classified stay out of totals until the user decides.
  const review = accounts?.accountsToReview || [];
  const unknown = accounts?.unknownTransfers || { count: 0, total: 0 };
  if (review.length || unknown.count) {
    const names = review.map(account => ({ description: account.last4 ? `••${account.last4}` : account.name }));
    add({ id: 'accounts-review', tone: 'warning', icon: 'search',
      title: review.length === 1 ? `Is ${names[0].description} one of your accounts?` : review.length ? `Are ${listNames(names)} your accounts?` : `${unknown.count} transfer${unknown.count === 1 ? '' : 's'} need${unknown.count === 1 ? 's' : ''} an account`,
      detail: `${unknown.count ? `${unknown.count} transfer${unknown.count === 1 ? '' : 's'} totaling ${money(unknown.total)} ${unknown.count === 1 ? 'is' : 'are'} left out of your spending and income until you say what kind of account ${review.length === 1 ? 'it is' : 'they go to'}. ` : ''}Mark ${review.length === 1 ? 'it' : 'each one'} as savings, checking, a card, or not yours so your totals stay accurate.`,
      action: { label: 'Review accounts', view: 'accounts' } }, -unknown.count);
  }
  const saved = accounts?.savedThisMonth;
  if (saved && saved.amount > 0) {
    add({ id: 'saved', tone: 'success', icon: 'cash', title: `You've set aside ${money(saved.amount)} this month`,
      detail: `Money moved to savings or investments across ${saved.transfers} transfer${saved.transfers === 1 ? '' : 's'}. It counts toward your savings, not your spending.`,
      action: { label: 'See accounts', view: 'accounts' } });
  }

  // Bills due in the next three days, manual ones first.
  const soon = bills.filter(item => item.dayOfMonth - todayDay <= 3)
    .sort((a, b) => Number(b.payMode === 'manual') - Number(a.payMode === 'manual') || a.dayOfMonth - b.dayOfMonth);
  if (soon.length) {
    const manual = soon.filter(item => item.payMode === 'manual');
    const first = soon[0];
    const total = soon.reduce((sum, item) => sum + Number(item.amount), 0);
    add(soon.length === 1
      ? { id: 'due-soon', tone: manual.length ? 'warning' : 'info', icon: 'calendar',
        title: `${nameOf(first)} is due ${dayLabel(today, first.dayOfMonth)}`,
        detail: `${money(first.amount)}${first.payMode === 'manual' ? ' and it is a manual payment, so you need to pay it yourself.' : first.payMode === 'auto' ? ' goes out automatically.' : '. Mark it auto-pay or manual on the Transactions page so you know whether to act.'}`,
        action: { label: 'See upcoming payments', act: 'upcoming' } }
      : { id: 'due-soon', tone: manual.length ? 'warning' : 'info', icon: 'calendar',
        title: `${soon.length} payments due in the next 3 days`,
        detail: `${money(total)} in total: ${listNames(soon)}.${manual.length ? ` ${manual.length} ${manual.length === 1 ? 'needs' : 'need'} you to pay manually.` : ''}`,
        action: { label: 'See upcoming payments', act: 'upcoming' } });
  }
  const laterManual = bills.filter(item => item.payMode === 'manual' && item.dayOfMonth - todayDay > 3);
  if (laterManual.length) {
    add({ id: 'manual', tone: 'info', icon: 'hand', title: `${laterManual.length} manual payment${laterManual.length === 1 ? '' : 's'} later this month`,
      detail: `${listNames(laterManual)}. These won't pay themselves. Set a reminder or switch them to auto-pay with your provider.`,
      action: { label: 'See upcoming payments', act: 'upcoming' } });
  }

  // Payday
  if (nextIncome) {
    const away = nextIncome.dayOfMonth - todayDay;
    add({ id: 'payday', tone: 'success', icon: 'cash', title: away === 0 ? 'Payday is today' : `Payday ${away === 1 ? 'is tomorrow' : `in ${away} days`}`,
      detail: `Expect about ${money(nextIncome.amount)} from ${nextIncome.description || 'your employer'} ${dayLabel(today, nextIncome.dayOfMonth)}${nextIncome.cadenceLabel ? ` (${String(nextIncome.cadenceLabel).toLowerCase()})` : ''}.`,
      action: { label: 'See upcoming payments', act: 'upcoming' } });
  }

  // Debt-free program
  const debtPlan = plan?.debtPlan;

  // Three-paycheck months: a biweekly paycheck the regular budget doesn't depend on.
  const bonus = threePaycheckMonths(incomeStreams, today, 12)[0];
  const monthsAway = bonus ? (Number(bonus.month.slice(0, 4)) - today.getFullYear()) * 12 + Number(bonus.month.slice(5, 7)) - 1 - today.getMonth() : null;
  if (bonus && monthsAway <= 2) {
    const priciest = (debtPlan?.debts || []).filter(debt => debt.included && debt.balance > 0).sort((a, b) => (b.apr || 0) - (a.apr || 0))[0];
    const goal = (plan?.goalPlan?.goals || []).find(item => item.included && item.status !== 'funded');
    const where = priciest ? `Sending it to ${priciest.name}${priciest.apr ? ` (${priciest.apr}% APR)` : ''} cuts interest the most.`
      : goal ? `Adding it to ${goal.name} moves that goal forward without touching your budget.`
        : 'Put it toward high-interest debt or an emergency fund before it blends into everyday spending.';
    const days = bonus.dates.map(date => Number(date.slice(8, 10)));
    add({ id: 'three-paychecks', tone: 'success', icon: 'cash', title: `${monthsAway === 0 ? 'This month' : monthLabel(bonus.month)} has three paychecks`,
      detail: `${bonus.name} pays on the ${days.slice(0, -1).map(ordinal).join(', ')} and ${ordinal(days.at(-1))}, about ${money(bonus.extra)} more than a usual month. ${where}`,
      action: priciest ? { label: 'Open debt-free plan', view: 'payoff' } : goal ? { label: 'Open goals', view: 'goals' } : { label: 'See upcoming payments', act: 'upcoming' } });
  }
  if (debtPlan?.debts?.some(debt => debt.included && debt.balance > 0)) {
    const result = debtPlan.plan;
    const strategy = debtPlan.strategies?.find(item => item.id === debtPlan.strategy)?.name || 'Your';
    if (result && !result.feasible) {
      add({ id: 'debt-budget', tone: 'danger', icon: 'alert', title: 'Your debt budget is below the minimums',
        detail: `Minimum payments this month total ${money(debtPlan.minimums)}. Raise the budget so nothing is missed.`,
        action: { label: 'Open debt-free plan', view: 'payoff' } });
    } else if (result?.debtFree) {
      const target = debtPlan.debts.find(debt => debt.thisMonth?.extra > 0);
      add({ id: 'debt-free', tone: 'success', icon: 'flag', title: `Debt-free by ${monthLabel(result.debtFreeDate)}`,
        detail: `${strategy} plan at ${money(debtPlan.budget)}/mo.${target ? ` This month's extra ${money(target.thisMonth.extra)} goes to ${target.name}.` : ' Add a little extra each month to get there sooner.'}`,
        action: { label: 'Open debt-free plan', view: 'payoff' } });
    }
  }

  // Goals
  const goals = plan?.goalPlan?.goals || [];
  const behind = goals.filter(goal => goal.status === 'behind' || goal.status === 'overdue').sort((a, b) => (b.gap || 0) - (a.gap || 0))[0];
  if (behind) {
    add({ id: 'goal-behind', tone: 'warning', icon: 'target', title: `${behind.name} is falling behind`,
      detail: behind.status === 'overdue' ? `Its target date has passed with ${money(behind.remaining)} to go. Pick a new date to get back on track.`
        : `It needs about ${money(behind.gap)} more a month to reach ${money(behind.target)}${behind.targetDate ? ` by ${new Date(`${behind.targetDate}T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}` : ''}.`,
      action: { label: 'Open goals', view: 'goals' } });
  } else {
    const close = goals.filter(goal => goal.included && goal.status !== 'funded' && goal.progress >= 75).sort((a, b) => b.progress - a.progress)[0];
    if (close) add({ id: 'goal-close', tone: 'success', icon: 'target', title: `${close.name} is ${Math.round(close.progress)}% funded`,
      detail: `Only ${money(close.remaining)} to go${close.finishDate ? `, on track for ${monthLabel(close.finishDate)}` : ''}. Keep it up.`,
      action: { label: 'Open goals', view: 'goals' } });
  }

  // Pro spending signals
  if (pro && analytics) {
    const daysLeft = daysInMonth - todayDay;
    const spending = (analytics.categories || []).filter(category => !category.transfer);
    const over = spending.filter(category => category.budgetStatus === 'over').sort((a, b) => (b.budgetUsed || 0) - (a.budgetUsed || 0));
    for (const category of over.slice(0, 2)) {
      add({ id: `over:${category.name}`, tone: 'danger', icon: 'gauge', title: `You're over budget on ${category.name}`,
        detail: `${money(category.mtd)} spent of ${money(category.budget)} (${pct(category.budgetUsed)}) with ${daysLeft} day${daysLeft === 1 ? '' : 's'} left in the month.`,
        action: { label: 'Review categories', view: 'categories' } });
    }
    const risk = spending.filter(category => category.budgetStatus === 'risk').sort((a, b) => (b.budgetProjected || 0) - (a.budgetProjected || 0))[0];
    if (risk) add({ id: `risk:${risk.name}`, tone: 'warning', icon: 'gauge', title: `${risk.name} is on pace to go over budget`,
      detail: `${money(risk.mtd)} so far; at this pace you'll reach about ${money(risk.projected)} against a ${money(risk.budget)} budget.`,
      action: { label: 'Review categories', view: 'categories' } });
    const mover = spending.filter(category => category.deltaPct != null && category.deltaPct >= 0.25 && category.deltaMtd >= 50 && category.budgetStatus !== 'over')
      .sort((a, b) => b.deltaMtd - a.deltaMtd)[0];
    if (mover) add({ id: `mover:${mover.name}`, tone: 'info', icon: 'trend', title: `${mover.name} is up ${pct(mover.deltaPct)} vs last month`,
      detail: `${money(mover.mtd)} so far, ${money(mover.deltaMtd)} more than at this point last month.`,
      action: { label: 'Open analytics', view: 'analytics' } });
    const anomaly = (analytics.anomalies || []).find(item => item.type === 'charge');
    if (anomaly) add({ id: 'anomaly', tone: 'warning', icon: 'search', title: 'An unusual charge stood out',
      detail: `${anomaly.merchant || anomaly.description || anomaly.category || 'A charge'} for ${money(anomaly.amount)}${anomaly.date ? ` on ${new Date(`${anomaly.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}${anomaly.ratio ? `, about ${anomaly.ratio}× what you usually pay there` : ''}. Worth a second look.`,
      action: anomaly.id != null ? { label: 'Review transaction', view: `transactions/${anomaly.id}` } : { label: 'Open analytics', view: 'analytics' } });
    const hike = (analytics.recurring || []).find(item => item.active && !item.likelyBill && item.priceChange > 0);
    if (hike) add({ id: 'price-hike', tone: 'info', icon: 'repeat', title: `${hike.merchant} raised its price`,
      detail: `Now ${money(hike.amount)}, up ${money(hike.priceChange)} (${pct(hike.priceChangePct)}). That adds about ${money(hike.amount ? hike.priceChange * hike.annualCost / hike.amount : 0)} a year.`,
      action: { label: 'Open analytics', view: 'analytics' } });
    const forecast = analytics.forecast, average = analytics.kpis?.avgMonthlySpend;
    if (forecast?.projected && average && forecast.projected > average * 1.1 && todayDay >= 5) {
      add({ id: 'forecast', tone: 'warning', icon: 'trend', title: `On pace to spend ${money(forecast.projected)} this month`,
        detail: `That is ${pct(forecast.projected / average - 1)} above your ${money(average)} monthly average. Easing up on everyday spending now has the biggest effect.`,
        action: { label: 'Open analytics', view: 'analytics' } });
    }
  } else if (!pro && hasData) {
    add({ id: 'pro', tone: 'pro', icon: 'spark', title: 'Catch overspending before it happens',
      detail: 'MyFinance Pro adds budgets, month-end forecasts, price-hike alerts and unusual-charge detection right here.',
      action: { label: 'Try Pro free for 7 days', act: 'pro' } });
  }

  if (!insights.length) {
    add({ id: 'calm', tone: 'success', icon: 'shield', title: 'All quiet on your accounts',
      detail: 'No bills are due soon and nothing needs your attention. Enjoy it.', action: null });
  }

  const ranked = insights.map((insight, index) => ({ insight, index }))
    .sort((a, b) => RANK[a.insight.tone] - RANK[b.insight.tone] || a.insight.weight - b.insight.weight || a.index - b.index)
    .slice(0, MAX_INSIGHTS)
    .map(({ insight: { weight, ...insight } }) => insight);

  return {
    asOf: today.toISOString().slice(0, 10),
    insights: ranked,
    pulse: {
      balance: balance == null ? null : cents(Number(balance)),
      lowPoint: runway.low && outflows.length ? { amount: runway.low.amount, day: runway.low.day } : null,
      billsLeft: { count: bills.length, total: cents(bills.reduce((sum, item) => sum + Number(item.amount || 0), 0)) },
      safeToSpend: safe,
      lastImport: importAge == null ? null : { daysAgo: importAge, latestDate: lastImport.latestDate || null },
      savedThisMonth: accounts?.savedThisMonth?.amount ?? null,
      nextIncome: nextIncome ? { amount: cents(Number(nextIncome.amount)), day: nextIncome.dayOfMonth, daysAway: nextIncome.dayOfMonth - todayDay, description: nextIncome.description || '' } : null,
      debtFreeDate: debtPlan?.plan?.debtFree ? debtPlan.plan.debtFreeDate : null
    }
  };
}

function ordinal(day) {
  return `${day}${day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th')}`;
}
