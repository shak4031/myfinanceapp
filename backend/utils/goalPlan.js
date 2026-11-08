import { parseTxDate } from './normalize.js';
import { monthKey } from './payoff.js';

const cents = value => Math.round(value * 100) / 100;
const MAX_MONTHS = 600;

export function goalFundingDate(start, offset, day) {
  const last = new Date(start.getFullYear(), start.getMonth() + offset + 1, 0).getDate();
  return new Date(start.getFullYear(), start.getMonth() + offset, Math.min(day, last));
}

export function goalFinishDay(start, finishMonth, day) {
  if (finishMonth == null) return null;
  const date = goalFundingDate(start, Math.max(0, finishMonth - 1), day);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const GOAL_STRATEGIES = Object.freeze([
  { id: 'priority', name: 'Priority order', pro: false, tagline: 'Most important first', detail: 'Your #1 goal is funded on schedule first, then the next one.' },
  { id: 'deadline', name: 'Nearest deadline', pro: false, tagline: 'Soonest date first', detail: 'Goals due soonest are funded first so nothing sneaks up on you.' },
  { id: 'balanced', name: 'Balanced', pro: true, tagline: 'Everything moves together', detail: 'The budget is shared in proportion to what each goal needs, so all goals progress at once.' }
]);
export const goalStrategyIds = GOAL_STRATEGIES.map(strategy => strategy.id);

const kindOf = goal => String(goal.notes || '').match(/^\[plan:(\w+)\]/)?.[1]
  || (/emergency|rainy/i.test(goal.name || '') ? 'emergency' : 'general');

export function normalizeGoal(row, now = new Date(), defaultContributionDay = now.getDate()) {
  const target = Math.max(0, Number(row.target_amount) || 0), current = Math.max(0, Number(row.current_amount) || 0);
  const parsed = row.target_date ? parseTxDate(row.target_date) : null;
  const monthIndex = now.getFullYear() * 12 + now.getMonth();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const deadline = parsed ? new Date(parsed.year, parsed.month, parsed.day) : null;
  const fundingDay = Number(row.contribution_day) || defaultContributionDay;
  const paymentInMonth = offset => goalFundingDate(now, offset, fundingDay);
  const firstFundingOffset = paymentInMonth(0) < today ? 1 : 0;
  let fundingSlots = null;
  if (deadline && deadline >= today) {
    fundingSlots = 0;
    for (let offset = firstFundingOffset; offset <= MAX_MONTHS && paymentInMonth(offset) <= deadline; offset++) fundingSlots++;
  }
  return {
    id: row.id, name: row.name, icon: row.icon, color: row.color, notes: row.notes, kind: kindOf(row),
    target: cents(target), current: cents(current), remaining: cents(Math.max(0, target - current)),
    targetDate: parsed ? parsed.iso || row.target_date : null,
    targetMonth: parsed ? (deadline < today ? -1 : parsed.year * 12 + parsed.month - monthIndex) : null,
    priority: Number(row.priority) || 1, included: row.included !== false,
    manual: row.monthly_contribution == null || row.monthly_contribution === '' ? null : cents(Math.max(0, Number(row.monthly_contribution) || 0)),
    contributionDay: Number(row.contribution_day) || null, fundingDay, firstFundingOffset, fundingSlots
  };
}

const orderGoals = (goals, strategy) => [...goals].sort(strategy === 'deadline'
  ? (a, b) => (a.targetMonth ?? 1e9) - (b.targetMonth ?? 1e9) || a.priority - b.priority || a.id - b.id
  : (a, b) => a.priority - b.priority || (a.targetMonth ?? 1e9) - (b.targetMonth ?? 1e9) || a.id - b.id);

// The amount a dated goal needs this month to land on its date (re-evaluated monthly, so shortfalls catch up).
const needed = (goal, month) => goal.targetMonth == null || goal.targetMonth < 0 ? null
  : cents(goal.left / Math.max(1, (goal.fundingSlots ?? goal.targetMonth) - (month - 1 - (goal.firstFundingOffset || 0))));

export function simulateGoals(goals, { budget = 0, strategy = 'priority', start = new Date() } = {}) {
  const state = orderGoals(goals.filter(goal => goal.remaining > 0), strategy).map(goal => ({ ...goal, left: goal.remaining, finishMonth: null, first: 0, firstScheduled: 0 }));
  let month = 0;
  while (month < MAX_MONTHS && state.some(goal => goal.left > 0.005)) {
    month++;
    let pool = budget;
    const give = (goal, amount) => {
      const pay = cents(Math.max(0, Math.min(amount, goal.left, pool)));
      goal.left = cents(goal.left - pay); pool = cents(pool - pay);
      if (month === 1) goal.first = cents(goal.first + pay);
      if (month === 1 + (goal.firstFundingOffset || 0)) goal.firstScheduled = cents(goal.firstScheduled + pay);
    };
    const active = state.filter(goal => goal.left > 0.005 && month > (goal.firstFundingOffset || 0));
    for (const goal of active.filter(item => item.manual != null)) give(goal, goal.manual);
    const automatic = active.filter(goal => goal.manual == null);
    const dated = automatic.filter(goal => goal.targetMonth != null && goal.targetMonth >= 0);
    if (strategy === 'balanced') {
      const weights = automatic.map(goal => needed(goal, month) ?? goal.left / 24);
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const share = pool;
      if (total > 0) automatic.forEach((goal, index) => give(goal, Math.min(weights[index], share * weights[index] / total)));
    } else {
      for (const goal of dated) give(goal, needed(goal, month));
    }
    // Whatever is left goes to goals without a date, in order; any remainder stays as a buffer.
    for (const goal of automatic.filter(item => item.targetMonth == null || item.targetMonth < 0)) give(goal, goal.left);
    for (const goal of state) if (goal.finishMonth == null && goal.left <= 0.005) { goal.left = 0; goal.finishMonth = month; }
    if (pool >= budget - 0.005 && month > 1) break;
  }
  return new Map(state.map(goal => [goal.id, { finishMonth: goal.finishMonth, first: goal.first, firstScheduled: goal.firstScheduled }]));
}

const money = value => `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function buildGoalPlan({ goals: rows = [], settings = {}, available = null, monthlyExpenses = null, pro = false, now = new Date(), highAprDebt = null, defaultContributionDay = now.getDate() } = {}) {
  const all = rows.map(row => normalizeGoal(row, now, defaultContributionDay));
  const included = all.filter(goal => goal.included);
  const requested = goalStrategyIds.includes(settings.goal_strategy) ? settings.goal_strategy : 'priority';
  const locked = GOAL_STRATEGIES.find(item => item.id === requested)?.pro && !pro;
  const strategy = locked ? 'priority' : requested;
  const open = included.filter(goal => goal.remaining > 0);
  const requiredTotal = cents(open.reduce((sum, goal) => sum + (goal.manual ?? (goal.targetMonth == null || goal.targetMonth < 0 ? 0 : goal.remaining / Math.max(1, goal.fundingSlots))), 0));
  const savedBudget = settings.goal_budget == null ? null : Number(settings.goal_budget);
  // By default every spare dollar after bills and the debt-free program is available to goals.
  const defaultBudget = cents(Math.max(0, available == null ? requiredTotal : available));
  const budget = cents(savedBudget != null && Number.isFinite(savedBudget) ? savedBudget : defaultBudget);
  const results = simulateGoals(included, { budget, strategy, start: now });
  const goals = all.map(goal => {
    const result = results.get(goal.id);
    const finishMonth = goal.remaining === 0 ? 0 : result?.finishMonth ?? null;
    const required = goal.remaining === 0 ? 0 : goal.manual ?? (goal.targetMonth == null || goal.targetMonth < 0 ? null : cents(goal.remaining / Math.max(1, goal.fundingSlots)));
    const allocated = goal.included ? result?.first ?? 0 : 0;
    const monthlyAllocation = goal.included ? result?.firstScheduled ?? 0 : 0;
    const deadlineMonthly = goal.remaining === 0 ? 0 : goal.targetMonth == null || goal.targetMonth < 0 ? null
      : cents(goal.remaining / Math.max(1, goal.fundingSlots));
    const requestedMonthly = goal.manual ?? deadlineMonthly;
    const fundingGap = goal.included ? cents(Math.max(0, (requestedMonthly || 0) - monthlyAllocation)) : 0;
    const deadlineGap = goal.included && deadlineMonthly != null ? cents(Math.max(0, deadlineMonthly - monthlyAllocation)) : null;
    const fundingReason = !goal.included ? 'paused' : goal.remaining === 0 ? 'funded'
      : budget === 0 ? (available == null ? 'no-budget' : available <= 0 ? 'no-surplus' : 'no-budget')
      : goal.manual === 0 ? 'zero-request' : goal.firstFundingOffset > 0 ? 'day-passed' : allocated === 0 ? 'budget-used'
      : fundingGap > 0 ? 'partial-budget' : 'allocated';
    const finishDate = finishMonth == null ? null : monthKey(now, Math.max(0, finishMonth - 1));
    const finishDay = goalFinishDay(now, finishMonth, goal.fundingDay);
    const status = !goal.included ? 'paused' : goal.remaining === 0 ? 'funded' : goal.targetMonth != null && goal.targetMonth < 0 ? 'overdue'
      : finishMonth == null ? 'unfunded' : goal.targetMonth == null ? 'no-date' : finishDay <= goal.targetDate ? 'on-track' : 'behind';
    return {
      ...goal, required, allocated, monthlyAllocation, finishMonth, status, deadlineMonthly, requestedMonthly, fundingGap, deadlineGap, fundingReason, finishDay, finishDate,
      nextFundingDay: goalFinishDay(now, goal.firstFundingOffset + 1, goal.fundingDay),
      progress: goal.target > 0 ? cents(Math.min(100, goal.current / goal.target * 100)) : 0,
      gap: ['behind', 'unfunded'].includes(status) && deadlineMonthly != null ? cents(Math.max(0, deadlineMonthly - monthlyAllocation)) : 0
    };
  }).sort((a, b) => (Number(b.included) - Number(a.included)) || (orderGoals([a, b], strategy)[0] === a ? -1 : 1));
  const allocatedTotal = cents(goals.reduce((sum, goal) => sum + goal.allocated, 0));
  const buffer = cents(Math.max(0, budget - allocatedTotal));

  const guidance = [];
  const add = (severity, title, detail) => guidance.push({ severity, title, detail });
  const emergency = all.find(goal => goal.kind === 'emergency');
  if (!emergency) add('warning', 'Start with an emergency fund', `A cushion of three months of spending${monthlyExpenses ? ` (about ${money(monthlyExpenses * 3)})` : ''} keeps surprises off your credit cards. Create it as your #1 goal.`);
  else if (emergency.included && included.some(goal => goal.priority < emergency.priority && goal.remaining > 0) && strategy === 'priority') add('info', 'Consider moving the emergency fund to #1', 'It protects every other goal. Once it is funded, the money rolls into the rest.');
  const behind = goals.filter(goal => ['behind', 'unfunded'].includes(goal.status) && goal.deadlineMonthly != null);
  if (behind.length) {
    const gap = cents(behind.reduce((sum, goal) => sum + goal.gap, 0));
    add('warning', `${behind.length} goal${behind.length === 1 ? ' is' : 's are'} behind schedule`, `${behind.map(goal => `${goal.name}: ${goal.finishDate ? `modeled finish ${goal.finishDate}` : 'no finish at the current allocation'}`).join('; ')}. The deadline pace is short by about ${money(gap)} a month. Review cash flow, move a date, or lower a target; a larger budget does not create money.`);
  }
  const undated = goals.filter(goal => goal.included && goal.status === 'no-date');
  if (undated.length) add('info', 'Give every goal a date', `${undated.map(goal => goal.name).join(', ')} only get${undated.length === 1 ? 's' : ''} what is left over. A date turns a wish into a monthly amount.`);
  if (available != null && available <= 0) add('danger', 'There is no surplus to save from right now', 'Recent spending uses all of your income. Trim a flexible category on the Categories page before committing to goals.');
  else if (available != null && budget > available + 1) add('warning', 'The goals budget is larger than your surplus', `You typically have about ${money(available)} free after bills and the debt-free program. Plans above that rely on savings you do not yet have.`);
  if (buffer >= 25 && open.length) add('success', `${money(buffer)} a month is unassigned`, 'Keep it as a buffer or speed up a goal by setting a monthly amount on it.');
  if (highAprDebt) {
    const nonEssential = goals.filter(goal => goal.included && goal.kind !== 'emergency' && goal.allocated > 0);
    if (nonEssential.length) add('info', `Weigh goals against ${highAprDebt.name} at ${highAprDebt.apr}% APR`, `Savings rarely earn more than 4–5%, while that debt costs ${highAprDebt.apr}%. Consider slowing ${nonEssential[0].name} and sending the difference to the debt-free program.`);
  }

  return {
    strategies: GOAL_STRATEGIES.map(item => ({ ...item, locked: item.pro && !pro })),
    strategy, requestedStrategy: requested, strategyLocked: !!locked,
    budget, budgetIsSet: savedBudget != null, defaultBudget, available, requiredTotal, allocatedTotal, buffer, goals, guidance,
    deadlineTotal: cents(goals.filter(goal => goal.included && goal.remaining > 0).reduce((sum, goal) => sum + (goal.deadlineMonthly || 0), 0)),
    cashflowShortfall: available == null ? null : cents(Math.max(0, -available)),
    unsupportedBudget: available == null ? null : cents(Math.max(0, budget - Math.max(0, available))),
    totals: { target: cents(included.reduce((sum, goal) => sum + goal.target, 0)), saved: cents(included.reduce((sum, goal) => sum + goal.current, 0)), count: all.length, included: included.length }
  };
}
