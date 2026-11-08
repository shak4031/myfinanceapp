// The financial health plan: how a typical month splits across fixed, discretionary and debt against simple
// guideline targets, plus a 12-week reset (know your numbers, build the foundation, lock it in) where each step
// is checked against the household's own data when possible and can always be ticked off by hand.
import { BUCKET_LABELS } from './spendingBuckets.js';

// Shares of take-home pay. Mortgage counts as debt here, so fixed costs exclude it.
export const HEALTH_TARGETS = Object.freeze({ fixed: 30, discretionary: 30, debt: 25, save: 15 });
export const PLAN_WEEKS = 12;
const STARTER_FUND = 1000;
const MONTHS = ['Know your numbers', 'Build the foundation', 'Lock it in'];

const STEPS = [
  { id: 'review', week: 1, title: 'Review where it goes', summary: 'Sort every expense into fixed, discretionary and debt payments, and find your monthly average and savings rate.' },
  { id: 'cut', week: 2, title: 'Cut the leaks', summary: 'Rank expenses largest first and trim 10–30%: unused subscriptions, rideshare, eating out, shopping, and compare insurance quotes.' },
  { id: 'automate', week: 3, title: 'Automate saving', summary: 'Use a high-yield savings account and move at least 10% of take-home on payday, for example 5% saving and 5% investing.' },
  { id: 'debt', week: 4, title: 'Tackle card debt', summary: 'List your card balances, add $50–$100 a month to payments, and call to ask for a lower rate.' },
  { id: 'emergency', week: 5, title: 'Build an emergency fund', summary: 'Reach $1,000 first, then work up to 3–6 months of expenses in high-yield savings.' },
  { id: 'invest', week: 6, title: 'Start investing', summary: 'Open a brokerage account and buy a low-cost S&P 500 index fund on a regular schedule.' },
  { id: 'income', week: 7, title: 'Raise your income', summary: 'Ask for a raise, look at other roles, start a side hustle or learn a high-income skill.' },
  { id: 'goals', week: 8, title: 'Set a goal with a number', summary: 'Write down a savings goal with an amount and a monthly target, and tell someone about it.' },
  { id: 'cards', week: 9, title: 'Use cards on your terms', summary: 'Only use a credit card you can pay in full every month. If you can’t, set it aside.' },
  { id: 'net-worth', week: 10, title: 'Know your net worth', summary: 'Add up what you own, subtract what you owe, and check it monthly or quarterly.' },
  { id: 'recheck', week: 11, title: 'Re-check your spending', summary: 'Compare the last 2 months with week 1 and patch any new leaks.' },
  { id: 'ahead', week: 12, title: 'Look ahead', summary: 'Set 1-, 5- and 10-year goals, break them into monthly amounts, and schedule a quarterly check-in.' }
];
export const HEALTH_STEP_IDS = Object.freeze(STEPS.map(step => step.id));

const round = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const money = value => `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const finite = value => value != null && value !== '' && Number.isFinite(Number(value));

export function normalizeHealthState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const startedAt = typeof state.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(state.startedAt) ? state.startedAt : null;
  const done = {};
  for (const id of HEALTH_STEP_IDS) if (state.done?.[id] === true) done[id] = true;
  const b = state.baseline;
  const baseline = b && typeof b === 'object' && ['income', 'fixed', 'discretionary', 'debt'].every(key => finite(b[key]))
    ? { income: Number(b.income), fixed: Number(b.fixed), discretionary: Number(b.discretionary), debt: Number(b.debt) } : null;
  return { startedAt, done, baseline };
}

// 0–100: each of the four measures is worth 25 points and loses them gradually past its target.
export function healthScore(shares, targets = HEALTH_TARGETS) {
  if (!shares || shares.left == null) return null;
  const within = (value, target, span) => Math.max(0, Math.min(1, 1 - Math.max(0, value - target) / span));
  const points = within(shares.fixed, targets.fixed, 20) + within(shares.discretionary, targets.discretionary, 20)
    + within(shares.debt, targets.debt, 20) + within(targets.save, shares.left, 15);
  return Math.round(points * 25);
}

export function healthGrade(score) {
  if (score == null) return null;
  if (score >= 85) return { label: 'Strong', tone: 'good' };
  if (score >= 65) return { label: 'Steady', tone: 'good' };
  if (score >= 40) return { label: 'Stretched', tone: 'watch' };
  return { label: 'Under pressure', tone: 'bad' };
}

function bucketRows(typical, targets) {
  const status = (share, target, higherIsBetter = false) => {
    const gap = higherIsBetter ? target - share : share - target;
    return gap <= 0 ? 'good' : gap <= 5 ? 'close' : 'over';
  };
  const rows = ['fixed', 'discretionary', 'debt'].map(key => {
    const share = typical.shares[key];
    const gap = Math.max(0, share - targets[key]);
    return { key, label: BUCKET_LABELS[key], amount: typical[key], share, target: targets[key], status: status(share, targets[key]),
      change: round(gap / 100 * typical.income), items: typical.items[key] };
  });
  const share = typical.shares.left;
  rows.push({ key: 'save', label: 'Left to save', amount: typical.left, share, target: targets.save, status: status(share, targets.save, true),
    change: round(Math.max(0, targets.save - share) / 100 * typical.income), items: [] });
  return rows;
}

function focusFor(rows) {
  const text = {
    discretionary: row => `Trim discretionary spending by about ${money(row.change)} a month to get to ${row.target}% of take-home. Start with ${row.items.filter(item => !item.rest).slice(0, 2).map(item => item.label).join(' and ') || 'your largest categories'}.`,
    fixed: row => `Fixed costs take ${row.share}% of take-home. Compare insurance quotes and renegotiate phone, internet and subscriptions to free up about ${money(row.change)} a month.`,
    debt: row => `Debt payments take ${row.share}% of take-home. Put any extra toward the highest-rate balance first; every payoff frees its payment for good.`,
    save: row => `Aim to keep about ${money(row.change)} more a month so at least ${row.target}% of take-home goes to savings and investing.`
  };
  return rows.filter(row => row.status !== 'good' && row.change > 0)
    .sort((a, b) => b.change - a.change).slice(0, 3)
    .map(row => ({ key: row.key, text: text[row.key](row) }));
}

const recentAverage = (months, key, count) => {
  const done = months.filter(row => !row.current && row.recorded).slice(-count);
  return done.length ? done.reduce((sum, row) => sum + row[key], 0) / done.length : null;
};

function buildSteps({ buckets, debts, goals, assets, savedMonthly, settings, state, now }) {
  const typical = buckets.typical;
  const income = typical?.income || 0;
  const expenses = typical ? typical.fixed + typical.discretionary + typical.debt : 0;
  const active = debts.filter(debt => Number(debt.balance) > 0 && debt.included !== false);
  const cards = active.filter(debt => (debt.debt_type || 'credit_card') === 'credit_card');
  const goalRows = goals.filter(goal => Number(goal.target_amount) > 0);
  const step = {};

  step.review = buckets.monthsUsed >= 3 && typical
    ? { status: 'done', detail: `A typical month: ${money(typical.fixed)} fixed, ${money(typical.discretionary)} discretionary and ${money(typical.debt)} debt payments, keeping ${typical.shares.left ?? 0}% of take-home.` }
    : { status: buckets.monthsUsed ? 'progress' : 'todo', detail: `${buckets.monthsUsed} of 3 complete months imported. Import the rest of your statements to finish your numbers.` };

  const top = (typical?.items.discretionary || []).filter(item => !item.rest).slice(0, 3);
  const recentDiscretionary = recentAverage(buckets.months, 'discretionary', 2);
  const trimmed = state.baseline && recentDiscretionary != null && state.baseline.discretionary > 0
    && recentDiscretionary <= state.baseline.discretionary * 0.9;
  step.cut = typical
    ? { status: trimmed ? 'done' : 'todo', detail: `${top.length ? `Biggest discretionary categories: ${top.map(item => `${item.label} ${money(item.amount)}`).join(', ')}. ` : ''}A 10–30% trim is ${money(typical.discretionary * 0.1)}–${money(typical.discretionary * 0.3)} a month.` }
    : { status: 'todo', detail: 'Import a few months of spending to see where to trim.' };

  const rate = income > 0 ? savedMonthly / income * 100 : null;
  step.automate = {
    status: rate != null && rate >= 10 ? 'done' : savedMonthly > 0 ? 'progress' : 'todo',
    detail: income > 0
      ? `You move about ${money(savedMonthly)} a month into savings (${Math.max(0, Math.round(rate))}% of take-home). 10% is ${money(income * 0.1)} a month.`
      : 'Transfers into a savings account are counted here once income is imported.'
  };

  const extra = settings?.debt_budget != null ? Number(settings.debt_budget) - active.reduce((sum, debt) => sum + (Number(debt.min_payment) || 0), 0) : 0;
  const worst = [...cards].sort((a, b) => Number(b.apr) - Number(a.apr))[0];
  step.debt = !cards.length
    ? { status: 'done', detail: 'No credit card balances in your Debt-free plan. If you carry one, add it there.' }
    : { status: extra >= 50 ? 'done' : 'todo', detail: `${cards.length} card balance${cards.length === 1 ? '' : 's'} totaling ${money(cards.reduce((sum, debt) => sum + Number(debt.balance), 0))}. Add $50–$100 a month to ${worst.name || 'the highest-rate card'}${Number(worst.apr) > 0 ? ` (${Number(worst.apr)}% APR)` : ''} and ask the issuer for a lower rate.` };

  const fund = assets.savings;
  const threeMonths = expenses * 3;
  step.emergency = {
    status: threeMonths > 0 && fund >= threeMonths ? 'done' : fund >= STARTER_FUND ? 'progress' : 'todo',
    detail: `${money(fund)} in savings. ${fund >= STARTER_FUND ? 'Starter $1,000 reached. ' : `${money(STARTER_FUND - fund)} to go for the $1,000 starter fund. `}${threeMonths > 0 ? `Three months of expenses is ${money(threeMonths)}; six is ${money(threeMonths * 2)}.` : ''}`
  };

  step.invest = assets.hasInvestment
    ? { status: 'done', detail: `An investment account is linked${assets.investments > 0 ? ` (${money(assets.investments)})` : ''}. Keep contributions steady and simple.` }
    : { status: 'todo', detail: 'No investment account found yet. Add one under Accounts once it is open so it counts toward your net worth.' };

  const recentIncome = recentAverage(buckets.months, 'income', 3);
  const earlier = buckets.months.filter(row => !row.current && row.recorded).slice(-6, -3);
  const earlierIncome = earlier.length ? earlier.reduce((sum, row) => sum + row.income, 0) / earlier.length : null;
  const change = recentIncome != null && earlierIncome > 0 ? Math.round((recentIncome / earlierIncome - 1) * 100) : null;
  step.income = {
    status: 'todo',
    detail: recentIncome != null
      ? `Take-home averaged ${money(recentIncome)} a month${change != null ? `, ${change === 0 ? 'level with' : `${Math.abs(change)}% ${change > 0 ? 'above' : 'below'}`} the 3 months before` : ''}. Even ${money(Math.max(100, recentIncome * 0.05))} more a month adds up.`
      : 'Import a few months of paychecks to track your income trend.'
  };

  const dated = goalRows.filter(goal => /^\d{4}-\d{2}/.test(String(goal.target_date || '')));
  const sample = dated[0];
  const monthsTo = goal => {
    const [year, month] = String(goal.target_date).split('-').map(Number);
    return Math.max(1, (year - now.getFullYear()) * 12 + (month - 1 - now.getMonth()));
  };
  step.goals = dated.length
    ? { status: 'done', detail: `${dated.length} dated goal${dated.length === 1 ? '' : 's'}. ${sample.name} needs about ${money(Math.max(0, Number(sample.target_amount) - Number(sample.current_amount || 0)) / monthsTo(sample))} a month to arrive on time.` }
    : { status: goalRows.length ? 'progress' : 'todo', detail: goalRows.length ? 'Add a target date to a goal so it gets a monthly amount.' : 'For example, $7,000 over 12 months is about $583 a month.' };

  const cardInterest = buckets.months.filter(row => !row.current).slice(-2).reduce((sum, row) => sum + row.cardInterest, 0);
  const hasHistory = buckets.months.filter(row => !row.current && row.recorded).length >= 2;
  step.cards = cardInterest > 0
    ? { status: 'todo', detail: `You paid ${money(cardInterest)} in card interest over the last 2 months. Paying in full each month brings that to $0.` }
    : cards.length
      ? { status: 'progress', detail: 'No card interest recorded in the last 2 months, but a card balance is still listed in your Debt-free plan.' }
      : { status: hasHistory ? 'done' : 'todo', detail: hasHistory ? 'No card interest in the last 2 months. Keep paying in full.' : 'Import card statements to check for interest charges.' };

  const owed = active.reduce((sum, debt) => sum + Number(debt.balance), 0);
  const owned = assets.cash + assets.savings + assets.investments;
  const known = owned > 0 || owed > 0;
  step['net-worth'] = {
    status: known ? 'done' : 'todo', netWorth: known ? round(owned - owed) : null,
    detail: known ? `${money(owned)} in tracked accounts minus ${money(owed)} in debts: about ${owned - owed < 0 ? '-' : ''}${money(Math.abs(owned - owed))}. MyFinance updates this as you import.` : 'Import account balances and add your debts to see your net worth.'
  };

  const recent = recentAverage(buckets.months, 'discretionary', 2);
  step.recheck = state.baseline && recent != null
    ? { status: 'todo', detail: `Discretionary spending averaged ${money(recent)} over the last 2 months, against ${money(state.baseline.discretionary)} when you started (${recent <= state.baseline.discretionary ? 'down' : 'up'} ${money(Math.abs(recent - state.baseline.discretionary))}).` }
    : { status: 'todo', detail: 'Start the plan to save your week-1 numbers; this step compares against them.' };

  const horizon = goal => { const m = monthsTo(goal); return m <= 12 ? '1-year' : m <= 60 ? '5-year' : '10-year'; };
  const horizons = new Set(dated.map(horizon));
  step.ahead = {
    status: horizons.size >= 3 ? 'done' : horizons.size ? 'progress' : 'todo',
    detail: horizons.size ? `You have ${[...horizons].sort().join(', ')} goals. ${horizons.size < 3 ? `Add a ${['1-year', '5-year', '10-year'].filter(item => !horizons.has(item)).join(' and ')} goal.` : 'Check in every quarter.'}` : 'Add goals at 1, 5 and 10 years out.'
  };

  const routes = { review: 'categories', cut: 'analytics', automate: 'accounts', debt: 'payoff', emergency: 'goals', invest: 'accounts', income: 'transactions', goals: 'goals', cards: 'payoff', 'net-worth': 'accounts', recheck: 'categories', ahead: 'goals' };
  return STEPS.map(base => {
    const auto = step[base.id];
    const manual = state.done[base.id] === true;
    return { ...base, month: Math.ceil(base.week / 4), monthTitle: MONTHS[Math.ceil(base.week / 4) - 1], route: routes[base.id],
      status: manual ? 'done' : auto.status, autoStatus: auto.status, manual, detail: auto.detail, ...(auto.netWorth !== undefined ? { netWorth: auto.netWorth } : {}) };
  });
}

export function buildHealthPlan({ buckets, debts = [], goals = [], assets = {}, savedMonthly = 0, settings = null, state = null, now = new Date() } = {}) {
  const plan = normalizeHealthState(state);
  const safeAssets = { cash: Number(assets.cash) || 0, savings: Number(assets.savings) || 0, investments: Number(assets.investments) || 0, hasInvestment: !!assets.hasInvestment };
  const typical = buckets?.typical?.income > 0 ? buckets.typical : null;
  const rows = typical ? bucketRows(typical, HEALTH_TARGETS) : null;
  const score = typical ? healthScore(typical.shares) : null;
  const steps = buildSteps({ buckets: { ...buckets, typical }, debts, goals, assets: safeAssets, savedMonthly: Number(savedMonthly) || 0, settings, state: plan, now });
  let week = null, finished = false;
  if (plan.startedAt) {
    const [y, m, d] = plan.startedAt.split('-').map(Number);
    const days = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
    week = Math.max(1, Math.min(PLAN_WEEKS, Math.floor(days / 7) + 1));
    finished = days >= PLAN_WEEKS * 7;
  }
  return {
    targets: HEALTH_TARGETS, monthsUsed: buckets?.monthsUsed || 0, typical,
    score, grade: healthGrade(score), buckets: rows, focus: rows ? focusFor(rows) : [],
    startedAt: plan.startedAt, week, finished, baseline: plan.baseline,
    completed: steps.filter(item => item.status === 'done').length, steps
  };
}

// Applies a change from the client to the saved plan state. Throws on invalid input.
export function applyHealthChange(raw, change, { typical = null, now = new Date() } = {}) {
  const state = normalizeHealthState(raw);
  if (change?.action === 'start') {
    return { ...state, startedAt: isoDay(now),
      baseline: typical ? { income: typical.income, fixed: typical.fixed, discretionary: typical.discretionary, debt: typical.debt } : null };
  }
  if (change?.action === 'reset') return { startedAt: null, done: {}, baseline: null };
  if (typeof change?.step === 'string' && HEALTH_STEP_IDS.includes(change.step) && typeof change.done === 'boolean') {
    const done = { ...state.done };
    if (change.done) done[change.step] = true; else delete done[change.step];
    return { ...state, done };
  }
  throw Object.assign(new Error('Choose a valid plan change'), { status: 400 });
}
