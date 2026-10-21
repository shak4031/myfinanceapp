// Debt-free program, savings goals and the flexible plan items shown on the dashboard calendar.
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const money = (value, digits = 0) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return `${number < 0 ? '−' : ''}$${Math.abs(number).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  };
  const cents = value => money(value, 2);
  const monthDate = key => { const [year, month] = String(key || '').split('-').map(Number); return year && month ? new Date(year, month - 1, 1) : null; };
  const monthLabel = (key, style = 'short') => monthDate(key)?.toLocaleDateString('en-US', { month: style, year: 'numeric' }) || '—';
  const duration = months => {
    if (months == null) return '—';
    if (months < 12) return `${months} month${months === 1 ? '' : 's'}`;
    const years = Math.floor(months / 12), rest = months % 12;
    return `${years} yr${years === 1 ? '' : 's'}${rest ? ` ${rest} mo` : ''}`;
  };
  const ordinal = day => `${day}${day % 100 >= 11 && day % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th')}`;
  const icon = (name, size = 16) => {
    const paths = {
      lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
      star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
      edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
      up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
      spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
      flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>', piggy: '<path d="M4 11a7 6 0 0 1 13-3h2v4l-2 1v3h-3v2h-3v-2H8v2H5v-3a6 6 0 0 1-1-4Z"/><circle cx="14.5" cy="10.5" r=".8"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>', check: '<path d="m5 12 5 5 9-10"/>',
      alert: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17v.5"/>', bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
      play: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5Z" fill="currentColor"/>'
    };
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
  };
  const DEBT_TYPES = { credit_card: 'Credit card', auto_loan: 'Auto loan', student_loan: 'Student loan', personal_loan: 'Personal loan', mortgage: 'Mortgage', other: 'Other debt' };
  const GOAL_STATUS = {
    funded: ['good', 'Funded'], 'on-track': ['good', 'On track'], behind: ['warn', 'Behind'], 'no-date': ['neutral', 'No date'],
    unfunded: ['bad', 'Not funded'], overdue: ['bad', 'Past due'], paused: ['muted', 'Paused']
  };
  const KIND_LABEL = { general: 'Savings', car: 'Car', college: 'College', emergency: 'Emergency fund' };

  const state = { plan: null, pending: null, whatIf: { extra: 0, lumpSum: 0, result: null }, goalWhatIf: {} };
  let plusAccess = false;
  const isPro = () => state.plan ? !!state.plan.pro : !!window.FinancePro?.isPlusActive?.();
  // Older rows store a word ("Save") instead of an emoji.
  const LEGACY_ICONS = { save: '🛡️', play: '✈️', car: '🚗', home: '🏠', house: '🏠', school: '🎓', education: '🎓', travel: '✈️', tech: '💻', gift: '🎁' };
  const goalIcon = value => {
    const text = String(value || '').trim();
    if (!text) return '🎯';
    return /^[\x20-\x7e]+$/.test(text) ? LEGACY_ICONS[text.toLowerCase()] || '🎯' : text;
  };
  const notifyUser = message => (window.notify || (() => {}))(message);

  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { code: data.code, status: response.status, entitlement: data.entitlement });
    return data;
  }
  const unlock = reason => window.FinancePro?.requireProPlus ? window.FinancePro.requireProPlus(reason) : false;
  function reportFailure(error) {
    if (error.code === 'PRO_REQUIRED' || error.code === 'PRO_PLUS_REQUIRED') return unlock(error.message);
    notifyUser(error.message || 'Something went wrong');
  }

  async function refresh() {
    state.pending ||= api('/api/plan').finally(() => { state.pending = null; });
    state.plan = await state.pending;
    return state.plan;
  }
  async function mutate(request) {
    try {
      state.plan = await request;
      resetScenarios();
      renderAll();
      return state.plan;
    } catch (error) { reportFailure(error); return null; }
  }
  // A saved change makes any open what-if stale.
  function resetScenarios() { state.whatIf = { extra: 0, lumpSum: 0, result: null }; state.goalWhatIf = {}; }
  function renderAll() {
    if ($('plan-debt-root')) renderDebt();
    if ($('plan-goals-root')) renderGoals();
  }

  // ---------- shared pieces ----------
  const guidanceList = items => items.length ? `<ul class="plan-guidance">${items.map(item => `
    <li class="tone-${esc(item.severity)}"><span class="plan-guidance-icon">${icon(item.severity === 'success' ? 'check' : item.severity === 'info' ? 'info' : 'alert')}</span>
      <div><strong>${esc(item.title)}</strong><p>${esc(item.detail)}</p></div></li>`).join('')}</ul>`
    : '<p class="plan-quiet">Nothing needs your attention right now.</p>';
  const proBadge = () => `<span class="plan-pro-tag">${icon('lock', 11)}PRO PLUS</span>`;
  const strategyCards = (list, active, kind, numbers = () => '') => `<div class="plan-strategies" role="radiogroup" aria-label="${kind === 'debt' ? 'Payoff strategy' : 'Goal strategy'}">${list.map(item => `
    <button type="button" class="plan-strategy${item.id === active ? ' is-active' : ''}${item.locked ? ' is-locked' : ''}" role="radio" aria-checked="${item.id === active}" data-act="${kind}-strategy" data-id="${esc(item.id)}">
      <span class="plan-strategy-head"><strong>${esc(item.name)}</strong><span class="plan-strategy-badges">${item.locked ? proBadge() : `${item.recommended ? '<span class="plan-reco">Recommended</span>' : ''}${item.id === active ? `<span class="plan-check" title="Selected">${icon('check', 14)}</span>` : ''}`}</span></span>
      <span class="plan-strategy-tag">${esc(item.tagline)}</span>
      ${numbers(item)}
    </button>`).join('')}</div>`;
  const toggle = (act, id, on, label) => `<button type="button" class="plan-switch${on ? ' is-on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="${act}" data-id="${esc(id)}"><span></span></button>`;
  const lockedTeaser = (title, text, reason) => `<div class="plan-locked">
    <div class="plan-locked-art" aria-hidden="true"><span></span><span></span><span></span></div>
    <div><p class="plan-eyebrow">${icon('lock', 12)} MYFINANCE PRO PLUS</p><h3>${esc(title)}</h3><p>${esc(text)}</p>
    <button type="button" class="btn btn-primary" data-act="unlock" data-reason="${esc(reason)}">Unlock with Pro Plus</button></div></div>`;

  // ---------- debt-free program ----------
  function impactText(result) {
    if (!result.feasible) return 'Cover minimums before adding extra.';
    if (!result.debtFree) return 'Not paid off within the 50-year model.';
    const timing = result.monthsSaved == null ? '' : result.monthsSaved === 0 ? ' · same payoff month'
      : ` · ${result.monthsSaved} month${result.monthsSaved === 1 ? '' : 's'} sooner`;
    return `${monthLabel(result.debtFreeDate)}${timing}${result.interestSaved > 0 ? ` · ${money(result.interestSaved)} less interest` : ''}`;
  }

  function debtAssessment(p) {
    const c = p.debtPlan.coaching;
    if (!c) return '';
    const messages = {
      'needs-history': ['Start with a clear picture', 'Import completed-month statements before committing to an extra payment. Unknown affordability is not spare cash.'],
      'minimum-gap': ['Protect the minimums first', 'Your debt budget does not cover all minimum payments. Review essential bills and contact lenders about hardship options before accelerating any one debt.'],
      stabilize: ['Build breathing room before speed', 'A tighter observed month or your current allocations leave a shortfall. Keep essential bills current, review the spending below, and avoid committing more until cash flow stabilizes.'],
      'review-history': ['A promising start, not a commitment yet', 'We need three observed completed months with inflows and outflows to suggest an increase. Missing statements or irregular deposits can make the average look stronger than it is.'],
      'room-to-accelerate': ['There may be room to move the date', `After goals, existing extra payments and an illustrative cushion, the model leaves up to ${money(c.supportedExtra)}/mo for review. Verify available cash and your emergency reserve before applying it.`],
      'protect-buffer': ['Consistency is the next win', 'There is no supported increase after the tighter month and planning cushion. Stay with a manageable payment; test one spending change before raising it.']
    };
    const [title, detail] = messages[c.status];
    const line = (label, value) => `<div><dt>${label}</dt><dd>${value == null ? 'Unknown' : cents(value)}</dd></div>`;
    return `<section class="panel plan-card plan-assessment">
      <header class="plan-card-head"><div><p class="plan-eyebrow">YOUR STARTING POINT</p><h3>${esc(title)}</h3><p>${esc(detail)}</p></div></header>
      <dl class="plan-cash-ledger">
        ${line('Average recorded inflow / month', c.averageIncome)}${line('Average spending, including reserved minimums', c.averageExpenses)}
        ${line('Typical monthly surplus', c.surplus)}${line('Reserved extra debt payment', c.currentExtra)}
        ${line('Reserved savings goals', c.goalContributions)}${line('Remaining before a cushion', c.remaining)}
      </dl>
      <details class="plan-analysis-details"><summary>How much can this history support?</summary>
        <p>Uses ${c.monthsUsed} of the last 3 completed months with records. These are recorded inflows, not verified recurring salary. Transfers are excluded. Three observed months do not prove all statements are imported.</p>
        ${c.months.length ? `<ul class="plan-history-months">${c.months.map(row => `<li><span>${monthLabel(row.month)}</span><span>In ${money(row.income)} · out ${money(row.expenses)}</span><strong class="${row.surplus < 0 ? 'is-bad' : ''}">${cents(row.surplus)} left</strong></li>`).join('')}</ul>` : ''}
        <p>Reserved minimums not in imported spending: ${money(c.unrecordedMinimums)}/mo. We use the lower of average surplus and the tightest observed month (${c.weakestSurplus == null ? 'unknown' : money(c.weakestSurplus)}), subtract goals and existing extra payments, then hold back ${c.buffer == null ? 'an unknown amount' : money(c.buffer)}: the greater of $100 or 10% of spending. This is a conservative planning rule, not a verified emergency-fund balance or a guarantee of affordability.</p>
        <p>For debt extras and each savings goal, we reserve the higher of the long-term allocation and this month's flexible amount. A temporary reduction does not create permanent headroom. Scenarios still compare against your long-term debt budget.</p>
        <p>Review missing accounts, irregular income, annual bills and minimum-payment settings. Check the dashboard runway before moving money. The app never sends a payment.</p>
        <p>If minimums are difficult, consider <a href="https://www.consumerfinance.gov/ask-cfpb/what-is-credit-counseling-en-1451/">credit counseling</a>. Learn about <a href="https://www.consumerfinance.gov/an-essential-guide-to-building-an-emergency-fund/">building an emergency reserve</a> from the CFPB.</p>
      </details>
    </section>`;
  }

  function spendingAttack(p) {
    const c = p.debtPlan.coaching;
    if (!c) return '';
    return `<section class="panel plan-card">
      <header class="plan-card-head"><div><h3>Find your next extra dollar</h3><p>Choose one manageable experiment, not an overhaul. These are possibilities to review, not money already available.</p></div></header>
      ${c.opportunities.length ? `<div class="plan-spending-options">${c.opportunities.map(row => `<article class="plan-spending-option">
        <header><strong>${esc(row.category)}</strong><button type="button" class="link-btn" data-act="review-spending" data-category="${esc(row.category)}">Review activity</button></header>
        <p>Observed ${money(row.average)}/mo · ${row.count} purchases. Try 10% less: free up <strong>${cents(row.reduction)}/mo</strong>.</p>
        <p>Trial ceiling: ${money(row.monthlyTarget)}/month (about ${money(row.weeklyTarget)}/week).</p>
        <p class="plan-impact">${esc(impactText(row.impact))}</p>
        <small>If sustained and paid above your current debt budget. Review essentials and miscategorized charges first; categories do not tell us what you can comfortably give up.</small>
      </article>`).join('')}</div>` : '<p class="plan-quiet">No clear discretionary category to suggest from these records. Review recurring services or lender rates; essentials are not assumed to be cuttable.</p>'}
      <details class="plan-analysis-details"><summary>What would a small monthly increase change?</summary>
        <p>Independent scenarios above your current budget, not amounts to add together. They do not assume any spending experiment succeeds.</p>
        <div class="plan-scenario-grid">${c.scenarios.map(row => `<article><strong>+${money(row.extra)}/mo</strong><p>${esc(impactText(row))}</p><small>${row.supported ? 'Within the history-based allowance; verify cash first.' : 'Requires a new funding source or more complete history.'}</small></article>`).join('')}</div>
      </details>
      <p class="plan-quiet">For the next 30 days: choose one category, set its weekly ceiling, and review what actually remains each payday. Only redirect money after essentials, minimums and your reserve are covered. A smaller repeatable step beats an ambitious payment you need to borrow back.</p>
    </section>`;
  }

  function debtMilestones(p) {
    const c = p.debtPlan.coaching;
    if (!c) return '';
    const m = c.milestones, d = p.debtPlan;
    const target = d.debts.find(row => row.rank === 1);
    return `<section class="panel plan-card">
      <header class="plan-card-head"><div><h3>Make the next step visible</h3><p>Projected checkpoints, not a claim that payments have happened.</p></div></header>
      <ol class="plan-next-steps">
        <li><strong>This month: keep every minimum covered</strong><p>${money(d.minimums)} across included debts.${target && d.plan.feasible ? ` Direct ${money(d.extra)} extra to ${esc(target.name)} first, then the next debt if it clears.` : ''} Verify due dates and available cash before paying.</p></li>
        <li><strong>Your next ${m.months || 3} modeled months</strong><p>${m.principalReduction == null ? 'Set a budget covering minimums to see a checkpoint.' : `${money(m.principalReduction)} ${m.principalReduction < 0 ? 'more balance: interest currently outpaces payments' : 'less principal owed'}, assuming no new charges.`}</p></li>
        <li><strong>${m.firstWin ? `First finish: ${esc(m.firstWin.name)}` : 'Build toward your first payoff'}</strong><p>${m.firstWin ? `${monthLabel(m.firstWin.date)} · modeled payment month ${m.firstWin.month}. ${d.totals.included > 1 ? `Its ${money(m.firstWin.rolledMinimum)}/mo minimum rolls to any remaining debt; it is not new spending money.` : 'With this last included debt cleared, review your reserve and next goal before spending the freed payment.'}` : 'The current model has no payoff checkpoint yet. Review the budget and lender options.'}</p></li>
      </ol>
      <p class="plan-quiet">Weekly check-in: acknowledge the action you completed, compare actual spending with your trial ceiling, and adjust without blame. Update balances and rates from statements so the next projection reflects reality.</p>
    </section>`;
  }

  function chart(debtPlan) {
    const charts = window.ProCharts;
    const plan = debtPlan.plan, baseline = debtPlan.baseline, scenario = state.whatIf.result;
    if (!charts || !plan.series || plan.series.length < 2) return '';
    const longest = Math.max(plan.series.length, scenario?.series?.length || 0) - 1;
    const xMax = Math.max(6, Math.min(baseline.series.length - 1, Math.ceil(longest * 1.5)), longest);
    const points = series => series.slice(0, xMax + 1).map((v, x) => ({ x, v }));
    const now = new Date();
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(xMax * f)).map(x => ({
      x, label: new Date(now.getFullYear(), now.getMonth() + x, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).replace(' ', " '")
    }));
    const series = [{ points: points(baseline.series), className: 'plan-baseline', dashed: true }];
    if (plan.feasible) series.push({ points: points(plan.series), className: 'plan-line', area: true, dot: true });
    if (scenario?.series) series.push({ points: points(scenario.series), className: 'plan-scenario', dot: true });
    const room = $('plan-debt-root')?.clientWidth || 1040;
    const width = Math.round(Math.max(340, Math.min(1040, room - 48)));
    return `<figure class="plan-chart">${charts.plot({ series, xMax, xTicks: width < 560 ? xTicks.filter((_, i) => i % 2 === 0) : xTicks, width, height: width < 560 ? 220 : 250, label: 'Remaining debt by month' })}
      <figcaption><span class="key key-plan">Your plan</span><span class="key key-base">Minimums only</span>${scenario ? '<span class="key key-scenario">What-if</span>' : ''}</figcaption></figure>`;
  }

  function debtHero(p) {
    const d = p.debtPlan, plan = d.plan, active = d.strategies.find(item => item.id === d.strategy);
    const headline = !plan.feasible ? 'Budget too low' : plan.debtFree ? monthLabel(plan.debtFreeDate, 'long') : 'Not within 50 years';
    const sub = !plan.feasible ? esc(plan.reason) : plan.debtFree
      ? `${duration(plan.months)} from now · ${money(plan.totalInterest)} interest · ${esc(active?.name || '')}`
      : esc(plan.reason);
    const saved = d.interestSavedVsMinimums > 0 ? `<span class="plan-pill good">${icon('bolt', 13)}Saves ${money(d.interestSavedVsMinimums)}${d.monthsSavedVsMinimums > 0 ? ` and ${duration(d.monthsSavedVsMinimums)}` : ''} vs. minimums</span>` : '';
    const stat = (label, value, note = '') => `<div class="plan-stat"><span>${label}</span><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;
    return `<section class="panel plan-hero${plan.feasible && plan.debtFree ? '' : ' is-warning'}">
      <div class="plan-hero-top">
        <div class="plan-hero-main">
          <p class="plan-eyebrow">${icon('flag', 12)} DEBT-FREE DATE</p>
          <h2>${headline}</h2>
          <p class="plan-hero-sub">${sub}</p>
          ${saved}
        </div>
        <div class="plan-stats is-quad">
          ${stat('In the program', money(d.totals.balance), `${d.totals.included} of ${d.totals.count} debt${d.totals.count === 1 ? '' : 's'}`)}
          ${stat('Interest this month', money(d.totals.monthlyInterest), 'Accrues at today\'s balances')}
          ${stat('Weighted APR', `${Number(d.totals.weightedApr).toFixed(1)}%`, 'Across included debts')}
          ${stat('Monthly budget', money(d.budget), `${money(d.minimums)} minimums + ${money(d.extra)} extra`)}
        </div>
      </div>
      ${chart(d)}
    </section>`;
  }

  function budgetPanel(p) {
    const d = p.debtPlan, surplus = p.summary.monthlySurplus;
    const max = Math.ceil(Math.max(d.minimums * 3, d.budget * 1.5, d.minimums + 1500) / 50) * 50;
    const suggestion = d.suggestion && d.suggestion.budget > d.budget ? `<button type="button" class="plan-suggest" data-act="apply-budget" data-amount="${d.suggestion.budget}">
        ${icon('spark', 15)}<span><strong>Add ${money(d.suggestion.extra)}/mo</strong> → debt-free ${monthLabel(d.suggestion.debtFreeDate)}${d.suggestion.interestSaved > 0 ? `, save ${money(d.suggestion.interestSaved)}` : ''}</span><em>Apply</em></button>` : '';
    return `<section class="panel plan-card plan-budget">
      <header class="plan-card-head"><div><h3>Monthly amount for debt</h3><p>Minimums are fixed. Everything above them is your flexible extra payment.</p></div>
        ${d.budgetIsSet ? '<button type="button" class="btn btn-secondary btn-sm" data-act="reset-budget">Minimums only</button>' : ''}</header>
      <div class="plan-budget-row">
        <label class="plan-money-input"><span>$</span><input id="plan-debt-budget" type="number" inputmode="decimal" min="0" step="25" value="${Math.round(d.budget * 100) / 100}" aria-label="Monthly debt budget"></label>
        <input id="plan-debt-range" class="plan-range" type="range" min="${Math.floor(d.minimums)}" max="${max}" step="25" value="${Math.min(max, d.budget)}" aria-label="Adjust monthly debt budget">
      </div>
      <div class="plan-split" aria-hidden="true"><span class="is-min" style="flex:${Math.max(1, d.minimums)}"></span><span class="is-extra" style="flex:${Math.max(0, d.extra)}"></span></div>
      <div class="plan-split-legend"><span class="is-min">Minimums ${money(d.minimums)}</span><span class="is-extra">Extra ${money(d.extra)}</span>${surplus != null ? `<span class="is-surplus">Typical surplus ${money(surplus)}/mo</span>` : ''}</div>
      ${suggestion}
      ${suggestion ? '<p class="plan-quiet">This increase uses the history-based allowance after goals and a planning cushion. Applying changes the plan only; verify cash, emergency savings and due dates first.</p>' : ''}
    </section>`;
  }

  function debtCards(p) {
    const d = p.debtPlan, pro = isPro();
    const ordered = [...d.debts].sort((a, b) => Number(b.included) - Number(a.included) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.balance - a.balance);
    const ranked = ordered.filter(item => item.included && item.balance > 0);
    if (!ordered.length) return `<div class="panel plan-empty">${icon('flag', 30)}<h3>List what you owe to see your way out</h3>
      <p>Add credit cards, car loans, student loans or anything else you are paying down. The planner compares strategies, shows the interest each one costs and puts the payments on your calendar.</p>
      <button type="button" class="btn btn-primary" data-act="add-debt">${icon('plus', 15)} Add your first debt</button></div>`;
    return `<div class="plan-debts">${ordered.map(item => {
      const index = ranked.indexOf(item), aprTone = item.apr >= 20 ? 'hot' : item.apr >= 10 ? 'warm' : 'cool';
      const util = item.credit_limit > 0 ? Math.min(100, Math.round(item.balance / item.credit_limit * 100)) : null;
      const isTarget = index === 0 && d.plan.feasible;
      const thisMonth = item.thisMonth || { minimum: 0, extra: 0 };
      return `<article class="plan-debt${item.included ? '' : ' is-excluded'}${isTarget ? ' is-target' : ''}${item.balance <= 0 ? ' is-paid' : ''}">
        <header>
          <span class="plan-rank" title="${item.included ? 'Payoff order' : 'Not in the program'}">${item.included && index >= 0 ? index + 1 : '—'}</span>
          <div class="plan-debt-name"><strong>${esc(item.name)}</strong><small>${esc(DEBT_TYPES[item.debt_type] || 'Debt')}${item.due_day ? ` · due on the ${ordinal(item.due_day)}` : ''}</small></div>
          <button type="button" class="plan-focus${item.focus ? ' is-on' : ''}" data-act="toggle-focus" data-id="${esc(item.id)}" aria-pressed="${item.focus}" title="${item.focus ? 'Focus debt: paid down first' : 'Pay this one down first'}" aria-label="Focus on ${esc(item.name)}">${icon('star', 17)}</button>
          ${toggle('toggle-debt', item.id, item.included, `Include ${item.name} in the debt-free program`)}
        </header>
        <div class="plan-debt-body">
          <div class="plan-debt-balance"><span>Balance</span><strong>${cents(item.balance)}</strong></div>
          <span class="plan-apr tone-${aprTone}">${Number(item.apr).toFixed(item.apr % 1 ? 2 : 0)}% APR</span>
        </div>
        <dl class="plan-debt-facts">
          <div><dt>Minimum</dt><dd>${cents(item.min_payment)}</dd></div>
          <div><dt>Interest / mo</dt><dd>${cents(item.monthlyInterest)}</dd></div>
          <div><dt>${item.included ? 'Paid off' : 'Status'}</dt><dd>${item.balance <= 0 ? 'Paid off' : !item.included ? 'Paying as usual' : item.payoffDate ? monthLabel(item.payoffDate) : '—'}</dd></div>
        </dl>
        ${util == null ? '' : `<div class="plan-util${util > 30 ? ' is-high' : ''}"><span style="width:${util}%"></span><small>${util}% of ${money(item.credit_limit)} limit</small></div>`}
        <footer>
          <span class="plan-debt-month">${item.included && item.balance > 0 ? `This month <strong>${cents(thisMonth.minimum + thisMonth.extra)}</strong>${thisMonth.extra > 0 ? `<em>+${cents(thisMonth.extra)} extra</em>` : ''}` : item.included ? '' : 'Excluded from the plan'}</span>
          <span class="plan-debt-actions">
            ${pro && item.included && index >= 0 && ranked.length > 1 ? `<button type="button" class="plan-icon-btn" data-act="move-debt" data-dir="-1" data-id="${esc(item.id)}" aria-label="Move ${esc(item.name)} earlier" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button><button type="button" class="plan-icon-btn" data-act="move-debt" data-dir="1" data-id="${esc(item.id)}" aria-label="Move ${esc(item.name)} later" ${index === ranked.length - 1 ? 'disabled' : ''}>${icon('down')}</button>` : ''}
            <button type="button" class="plan-icon-btn" data-act="edit-debt" data-id="${esc(item.id)}" aria-label="Edit ${esc(item.name)}">${icon('edit')}</button>
            <button type="button" class="plan-icon-btn is-danger" data-act="delete-debt" data-id="${esc(item.id)}" aria-label="Delete ${esc(item.name)}">${icon('trash')}</button>
          </span>
        </footer>
      </article>`;
    }).join('')}</div>`;
  }

  function whatIfPanel(p) {
    const d = p.debtPlan;
    if (!d.debts.some(item => item.included && item.balance > 0)) return '';
    if (!isPro()) return `<section class="panel plan-card">${lockedTeaser('Simulate before you commit', 'Try a raise, a bonus or a tax refund and instantly see the new debt-free date and the interest it saves, drawn right on your chart. Reorder debts by hand with My order.', 'What-if simulations are part of MyFinance Pro Plus')}</section>`;
    const { extra, lumpSum } = state.whatIf;
    return `<section class="panel plan-card plan-whatif">
      <header class="plan-card-head"><div><h3>${icon('spark', 16)} What if…</h3><p>Nothing is saved. Try amounts to see how fast they move the date.</p></div>
        <button type="button" class="btn btn-secondary btn-sm" data-act="whatif-clear">Clear</button></header>
      <div class="plan-whatif-inputs">
        <label>Extra each month <output id="plan-whatif-extra-out">${money(extra)}</output><input id="plan-whatif-extra" class="plan-range" type="range" min="0" max="2000" step="25" value="${extra}"></label>
        <label>One-time payment now<span class="plan-money-input"><span>$</span><input id="plan-whatif-lump" type="number" min="0" step="100" value="${lumpSum || ''}" placeholder="0"></span></label>
      </div>
      <div class="plan-whatif-result" aria-live="polite">${whatIfResult()}</div>
    </section>`;
  }
  function whatIfResult() {
    const { result } = state.whatIf;
    if (!result) return '<p class="plan-quiet">Move the slider or enter a one-time amount.</p>';
    if (!result.debtFree) return `<p>${esc(result.reason || 'This scenario does not finish within 50 years.')}</p>`;
    return `<div><span>Debt-free</span><strong>${monthLabel(result.debtFreeDate)}</strong></div>
      <div><span>Time saved</span><strong>${result.monthsSaved > 0 ? duration(result.monthsSaved) : '—'}</strong></div>
      <div><span>Interest cut</span><strong class="is-good">${result.interestSaved > 0 ? money(result.interestSaved) : '—'}</strong></div>`;
  }
  // Updates the chart and result in place so a slider being dragged keeps its pointer.
  function paintWhatIf() {
    const root = $('plan-debt-root');
    const result = root?.querySelector('.plan-whatif-result'), figure = root?.querySelector('.plan-chart');
    if (result) result.innerHTML = whatIfResult();
    if (figure && state.plan) figure.outerHTML = chart(state.plan.debtPlan);
  }

  function monthPanel(p) {
    const items = (p.thisMonth || []).filter(item => item.planKind === 'debt-extra' || item.planKind === 'debt-min');
    const d = p.debtPlan;
    if (!d.debts.some(item => item.included && item.balance > 0)) return '';
    const today = new Date();
    return `<section class="panel plan-card plan-month">
      <header class="plan-card-head"><div><h3>This month on your calendar</h3><p>The extra payment is flexible. Lower it in a tight month without changing the long-term plan.</p></div></header>
      ${items.length ? `<ul class="plan-month-list">${items.map(item => `<li class="${item.flexible ? 'is-flex' : ''}${item.status === 'processed' ? ' is-past' : ''}">
        <span class="plan-month-day"><small>${today.toLocaleDateString('en-US', { month: 'short' })}</small><strong>${item.dayOfMonth}</strong></span>
        <span class="plan-month-name">${esc(item.description)}${item.adjusted ? '<em>Adjusted this month</em>' : ''}</span>
        <strong class="plan-month-amt">${cents(item.amount)}</strong>
        ${item.flexible ? `<button type="button" class="btn btn-secondary btn-sm" data-act="flex" data-key="${esc(item.key)}">Adjust</button>` : '<span class="plan-month-fixed">Fixed</span>'}
      </li>`).join('')}</ul>` : `<p class="plan-quiet">Your recorded payments already cover the minimums. ${d.extra > 0 ? '' : 'Add an extra amount above to put it on the calendar.'}</p>`}
    </section>`;
  }

  function renderDebt() {
    const root = $('plan-debt-root');
    const p = state.plan;
    if (!root || !p) return;
    const d = p.debtPlan;
    const strategies = d.strategies.map(item => ({ ...item, ...(d.comparison.find(entry => entry.id === item.id) || {}), recommended: item.id === d.recommended && !item.locked }));
    const numbers = item => item.locked ? '<span class="plan-strategy-meta">Unlock to compare</span>'
      : item.feasible === undefined ? '<span class="plan-strategy-meta">Set your own order</span>'
      : !item.feasible ? '<span class="plan-strategy-meta">Budget below minimums</span>'
      : `<span class="plan-strategy-meta"><b>${item.debtFree ? monthLabel(item.debtFreeDate) : '50+ yrs'}</b><i>${money(item.totalInterest)} interest</i></span>
        ${item.firstTarget ? `<span class="plan-strategy-first">Extra goes to <b>${esc(item.firstTarget)}</b> first</span>` : ''}
        ${strategyTradeoff(item)}`;
    function strategyTradeoff(item) {
      const row = d.coaching?.strategyTradeoffs.find(row => row.id === item.id);
      if (!row) return '';
      return `<span class="plan-strategy-first">${row.firstWin ? `First finish: ${esc(row.firstWin.name)} · ${monthLabel(row.firstWin.date)}` : 'No first payoff in the model'}</span>
        ${row.interestDifference == null || row.interestDifference === 0 ? '' : `<span class="plan-strategy-first">${money(Math.abs(row.interestDifference))} ${row.interestDifference > 0 ? 'more' : 'less'} interest than your selected plan</span>`}`;
    }
    const hasDebts = d.debts.length > 0;
    const sameOrder = (a, b) => a.order?.length && a.order.join('|') === b.order?.join('|');
    const compared = strategies.filter(item => !item.locked && item.feasible);
    const twins = compared.filter(item => compared.some(other => other.id !== item.id && sameOrder(item, other)));
    const active = strategies.find(item => item.id === d.strategy);
    const tieNote = twins.length > 1 && twins.some(item => item.id === d.strategy)
      ? `<p class="plan-strategy-note">${icon('info', 14)}<span><b>${esc(twins.map(item => item.name).join(', ').replace(/, ([^,]*)$/, ' and $1'))}</b> attack your debts in the same order with these balances and rates, so their dates and interest match. Switching between them changes nothing today; it will once your balances or rates diverge.</span></p>` : '';
    const strategyIntro = `Each card compares the same ${money(d.budget)}/mo budget. Recommended means lowest modeled interest among available strategies, not a judgment about what will motivate you. Compare the first finish as well as the final date: snowball may offer an earlier win at a higher interest cost. Every funded strategy covers all minimums and rolls freed payments forward. A starred debt overrides the order.`;
    root.innerHTML = `${hasDebts ? debtHero(p) : ''}
      ${hasDebts ? debtAssessment(p) : ''}
      ${d.strategyLocked ? `<p class="plan-banner">${icon('lock', 14)} Your saved strategy needs MyFinance Pro Plus, so the plan is using Avalanche. <button type="button" class="link-btn" data-act="unlock" data-reason="Advanced payoff strategies are part of MyFinance Pro Plus">Renew Pro Plus</button></p>` : ''}
      ${hasDebts ? `<section class="panel plan-card"><header class="plan-card-head"><div><h3>Choose your strategy${active ? ` <span class="plan-strategy-current">Using ${esc(active.name)}</span>` : ''}</h3><p>${strategyIntro}</p></div><a class="plan-help-link" href="#tutorials/debt-strategies" title="How strategies work">${icon('play', 13)} How it works</a></header>${strategyCards(strategies, d.strategy, 'debt', numbers)}${active ? `<p class="plan-quiet">${esc(active.detail)}</p>` : ''}${tieNote}</section>` : ''}
      <div class="plan-columns">
        <div class="plan-col-main">
          ${hasDebts ? budgetPanel(p) : ''}
          ${hasDebts ? spendingAttack(p) : ''}
          <section class="plan-section-head"><div><h3>Your debts</h3><p>Switch a debt off to keep paying it as usual outside the program.</p></div><button type="button" class="btn btn-primary" data-act="add-debt">${icon('plus', 15)} Add debt or loan</button></section>
          ${debtCards(p)}
        </div>
        <aside class="plan-col-side">
          ${hasDebts ? debtMilestones(p) : ''}
          ${hasDebts ? `<section class="panel plan-card"><header class="plan-card-head"><div><h3>Guidance</h3><p>Based on your rates, balances and recent cash flow.</p></div></header>${guidanceList(d.guidance)}</section>` : ''}
          ${whatIfPanel(p)}
          ${monthPanel(p)}
        </aside>
      </div>
      <p class="plan-footnote">Estimates assume monthly compounding, no new charges and on-time payments. Lender calculations may differ. This is planning guidance, not financial advice.</p>`;
  }

  // ---------- savings goals ----------
  function moneyFlow(p) {
    const s = p.summary, g = p.goalPlan;
    const streams = p.income?.streams || [];
    const surplus = s.monthlySurplus;
    const debtExtra = s.debtExtra || 0, goals = g.allocatedTotal || 0;
    const free = surplus == null ? 0 : Math.max(0, surplus - debtExtra - goals);
    const over = surplus != null && debtExtra + goals > surplus + 1;
    const total = Math.max(surplus || 0, debtExtra + goals + free, 1);
    const segment = (cls, value, label) => value > 0 ? `<span class="${cls}" style="width:${(value / total * 100).toFixed(2)}%" title="${esc(label)}: ${money(value)}"></span>` : '';
    return `<section class="panel plan-hero plan-flow">
      <div class="plan-hero-top">
        <div class="plan-hero-main">
          <p class="plan-eyebrow">${icon('piggy', 12)} WHERE YOUR SURPLUS GOES</p>
          <h2>${surplus == null ? 'Import a few months' : `${money(surplus)}<small>/mo</small>`}</h2>
          <p class="plan-hero-sub">${surplus == null ? 'We need at least one complete month of history to size your plan.' : `Typical income ${money(s.avgMonthlyIncome)} minus spending ${money(s.avgMonthlyExpenses)}, from the last ${s.monthsUsed} month${s.monthsUsed === 1 ? '' : 's'}.`}</p>
          ${streams.length ? `<div class="plan-income-streams">${streams.map(item => `<span class="plan-pill income">${esc(item.name)} · ${esc(item.label)} · ${money(item.amount)}</span>`).join('')}<button type="button" class="plan-pill plan-pill-link" data-income-review>Not right? Review income</button></div>` : `<div class="plan-income-streams"><button type="button" class="plan-pill plan-pill-link" data-income-review>Choose which deposits are your pay</button></div>`}
        </div>
        <div class="plan-stats">
          <div class="plan-stat"><span>Debt-free extra</span><strong>${money(debtExtra)}</strong><small>Above minimums</small></div>
          <div class="plan-stat"><span>Goals this month</span><strong>${money(goals)}</strong><small>Budget ${money(g.budget)}</small></div>
          <div class="plan-stat"><span>Unassigned</span><strong class="${over ? 'is-bad' : ''}">${over ? money(surplus - debtExtra - goals) : money(free)}</strong><small>${over ? 'Plan exceeds your surplus' : 'Your buffer'}</small></div>
        </div>
      </div>
      <div class="plan-flowbar${over ? ' is-over' : ''}" role="img" aria-label="Surplus split: debt extra ${money(debtExtra)}, goals ${money(goals)}, unassigned ${money(free)}">${segment('is-debt', debtExtra, 'Debt-free extra')}${segment('is-goals', goals, 'Goals')}${segment('is-free', free, 'Unassigned')}</div>
      <div class="plan-split-legend"><span class="is-debt">Debt-free program</span><span class="is-goals">Savings goals</span><span class="is-free">Unassigned buffer</span></div>
    </section>`;
  }

  function goalCard(goal, pro) {
    const [tone, label] = GOAL_STATUS[goal.status] || ['neutral', goal.status];
    const whatIf = state.goalWhatIf[goal.id];
    const target = goal.targetDate ? monthLabel(goal.targetDate.slice(0, 7)) : 'No date';
    const finish = goal.status === 'funded' ? 'Done' : goal.finishDate ? monthLabel(goal.finishDate) : 'Not funded';
    const ring = 2 * Math.PI * 26, filled = ring * Math.min(100, goal.progress) / 100;
    return `<article class="plan-goal tone-${tone}${goal.included ? '' : ' is-excluded'}">
      <header>
        <span class="plan-goal-ring" style="--goal:${esc(goal.color || '#047857')}"><svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="26"/><circle class="fill" cx="30" cy="30" r="26" stroke-dasharray="${filled.toFixed(1)} ${ring.toFixed(1)}"/></svg><span>${esc(goalIcon(goal.icon))}</span></span>
        <div class="plan-goal-name"><small>${esc(KIND_LABEL[goal.kind] || 'Savings')} · #${goal.priority}</small><strong>${esc(goal.name)}</strong></div>
        ${toggle('toggle-goal', goal.id, goal.included, `Include ${goal.name} in the plan`)}
      </header>
      <div class="plan-goal-amounts"><strong>${money(goal.current)}</strong><span>of ${money(goal.target)}</span><span class="plan-status tone-${tone}">${label}</span></div>
      <div class="plan-progress"><span style="width:${Math.min(100, goal.progress)}%"></span></div>
      <dl class="plan-debt-facts">
        <div><dt>This month</dt><dd>${goal.included ? cents(goal.allocated) : '—'}${goal.manual != null ? ' <em>fixed</em>' : ''}</dd></div>
        <div><dt>Target</dt><dd>${target}</dd></div>
        <div><dt>On pace for</dt><dd class="${goal.status === 'behind' || goal.status === 'unfunded' ? 'is-bad' : ''}">${goal.included ? finish : '—'}</dd></div>
      </dl>
      ${goal.gap > 0 ? `<p class="plan-goal-gap">${icon('alert', 13)} Needs ${cents(goal.required)}/mo to land on time, ${cents(goal.gap)} more than it gets.</p>` : ''}
      ${goal.included && goal.remaining > 0 ? (pro ? `<label class="plan-goal-whatif">${icon('spark', 13)} Try <span class="plan-money-input sm"><span>$</span><input type="number" min="1" step="25" data-goal-whatif="${esc(goal.id)}" value="${whatIf?.monthly || ''}" placeholder="${Math.round(goal.required || goal.allocated || 100)}" aria-label="Try a monthly amount for ${esc(goal.name)}"></span>/mo
        <output>${whatIf?.result ? (whatIf.result.finishDate ? `→ ${monthLabel(whatIf.result.finishDate)} ${whatIf.result.onTime ? '<b class="is-good">on time</b>' : '<b class="is-bad">late</b>'}` : '→ not reached') : ''}</output></label>`
        : '<button type="button" class="plan-goal-whatif is-locked" data-act="unlock" data-reason="Goal what-if simulations are part of MyFinance Pro Plus">' + icon('lock', 12) + ' Try a different monthly amount</button>') : ''}
      <footer>
        ${goal.remaining > 0 ? `<button type="button" class="btn btn-secondary btn-sm" data-act="contribute-goal" data-id="${esc(goal.id)}">Record savings</button>` : '<span class="plan-pill good">' + icon('check', 13) + 'Fully funded</span>'}
        <span class="plan-debt-actions">
          <button type="button" class="plan-icon-btn" data-act="edit-goal" data-id="${esc(goal.id)}" aria-label="Edit ${esc(goal.name)}">${icon('edit')}</button>
          <button type="button" class="plan-icon-btn is-danger" data-act="delete-goal" data-id="${esc(goal.id)}" aria-label="Delete ${esc(goal.name)}">${icon('trash')}</button>
        </span>
      </footer>
    </article>`;
  }

  function timeline(goals) {
    const open = goals.filter(goal => goal.included && goal.remaining > 0);
    if (!open.length) return '';
    const horizon = Math.min(120, Math.max(12, ...open.map(goal => Math.max(goal.finishMonth || 0, goal.targetMonth || 0))));
    const now = new Date();
    const ticks = [0, 0.5, 1].map(f => Math.round(horizon * f)).map(offset => `<span style="left:${offset / horizon * 100}%">${new Date(now.getFullYear(), now.getMonth() + offset, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}</span>`).join('');
    return `<section class="panel plan-card plan-timeline">
      <header class="plan-card-head"><div><h3>Timeline</h3><p>Bars end when each goal is funded. The marker is your target date.</p></div></header>
      <div class="plan-gantt">${open.map(goal => {
        const width = goal.finishMonth == null ? 100 : Math.max(2, Math.min(100, goal.finishMonth / horizon * 100));
        const [tone] = GOAL_STATUS[goal.status] || ['neutral'];
        return `<div class="plan-gantt-row"><span class="plan-gantt-name">${esc(goalIcon(goal.icon))} ${esc(goal.name)}</span>
          <span class="plan-gantt-track"><span class="plan-gantt-bar tone-${tone}${goal.finishMonth == null ? ' is-open' : ''}" style="width:${width}%"></span>
          ${goal.targetMonth != null && goal.targetMonth >= 0 && goal.targetMonth <= horizon ? `<span class="plan-gantt-target" style="left:${Math.max(0, goal.targetMonth) / horizon * 100}%" title="Target ${esc(monthLabel(goal.targetDate?.slice(0, 7)))}"></span>` : ''}</span></div>`;
      }).join('')}<div class="plan-gantt-axis">${ticks}</div></div>
    </section>`;
  }

  function renderGoals() {
    const root = $('plan-goals-root');
    const p = state.plan;
    if (!root || !p) return;
    const g = p.goalPlan, pro = isPro();
    const strategies = g.strategies.map(item => ({ ...item }));
    root.innerHTML = `${moneyFlow(p)}
      ${g.strategyLocked ? `<p class="plan-banner">${icon('lock', 14)} Balanced funding needs MyFinance Pro Plus, so goals use Priority order. <button type="button" class="link-btn" data-act="unlock" data-reason="Balanced goal funding is part of MyFinance Pro Plus">Renew Pro Plus</button></p>` : ''}
      <section class="panel plan-card">
        <header class="plan-card-head"><div><h3>How goals share the budget</h3><p>Goals with a fixed monthly amount always get it first.</p></div></header>
        ${strategyCards(strategies, g.strategy, 'goal')}
        <div class="plan-budget-row plan-goal-budget">
          <label class="plan-field">Monthly goals budget<span class="plan-money-input"><span>$</span><input id="plan-goal-budget" type="number" min="0" step="25" value="${Math.round(g.budget * 100) / 100}"></span></label>
          <p>${g.budgetIsSet ? `Default is everything left after bills and the debt-free program (${money(g.defaultBudget)}). <button type="button" class="link-btn" data-act="reset-goal-budget">Use default</button>` : 'Using everything left after bills and the debt-free program. Type an amount to cap it.'}
            Dated goals need ${money(g.requiredTotal)}/mo to stay on schedule.</p>
        </div>
      </section>
      <div class="plan-columns">
        <div class="plan-col-main">
          <section class="plan-section-head"><div><h3>Your goals</h3><p>Pause a goal to keep it without funding it.</p></div><button type="button" class="btn btn-primary" data-act="add-goal">${icon('plus', 15)} New goal</button></section>
          ${g.goals.length ? `<div class="plan-goals">${g.goals.map(goal => goalCard(goal, pro)).join('')}</div>` : `<div class="panel plan-empty">${icon('piggy', 30)}<h3>Your next chapter starts with a goal</h3><p>An emergency fund, a car, a trip. Add a target and a date and the planner tells you what to set aside each month and puts it on your calendar.</p><button type="button" class="btn btn-primary" data-act="add-goal">${icon('plus', 15)} Create a goal</button></div>`}
        </div>
        <aside class="plan-col-side">
          <section class="panel plan-card"><header class="plan-card-head"><div><h3>Guidance</h3><p>How your goals fit with your cash flow and debt.</p></div></header>${guidanceList(g.guidance)}</section>
          ${timeline(g.goals)}
        </aside>
      </div>
      <p class="plan-footnote">Recording savings updates progress only. MyFinance never moves money or connects to your bank.</p>`;
  }

  // ---------- loaders ----------
  async function load(rootId, render) {
    const root = $(rootId);
    if (root && !state.plan) root.innerHTML = '<div class="panel plan-loading"><span></span><span></span><span></span></div>';
    try { await refresh(); render(); }
    catch (error) {
      if (error.code === 'PRO_PLUS_REQUIRED') {
        state.plan = null;
        if (error.entitlement) window.FinancePro?.setEntitlement(error.entitlement);
        if (root) root.innerHTML = `<section class="panel plan-empty plus-page-lock"><p class="plan-eyebrow">${icon('lock')} PRO PLUS</p><h2>${rootId === 'plan-debt-root' ? 'Less debt. More breathing room.' : 'Give your next chapter a plan.'}</h2><p>${rootId === 'plan-debt-root' ? 'Compare payoff strategies, see your estimated debt-free date and test the impact of extra payments.' : 'Turn an emergency fund, a home or a big life moment into monthly savings targets you can track.'}</p><p>Only with <strong>Pro Plus: $9.98/month total</strong>.<br>Everything in Pro, plus these planning tools for $4.99 more/month.</p><button type="button" class="btn btn-primary" data-act="unlock" data-reason="Debt Free and Savings Goals are exclusive to Pro Plus.">Explore Pro Plus</button><p class="muted">Pro alone does not unlock this page. Existing plans stay saved when access ends.</p></section>`;
        return;
      }
      if (root) root.innerHTML = `<div class="panel plan-empty"><h3>Could not load your plan</h3><p>${esc(error.message)}</p><button type="button" class="btn btn-secondary" data-act="retry">Try again</button></div>`;
    }
  }
  window.loadPayoffPlan = () => load('plan-debt-root', renderDebt);
  window.loadGoals = () => load('plan-goals-root', renderGoals);

  const findDebt = id => state.plan?.debtPlan.debts.find(item => String(item.id) === String(id));
  const findGoal = id => state.plan?.goalPlan.goals.find(item => String(item.id) === String(id));
  const confirmAction = (message, action) => window.FinanceUI?.confirm ? window.FinanceUI.confirm(message, { action }) : Promise.resolve(window.confirm(message));

  async function handleAction(button) {
    const { act, id } = button.dataset;
    switch (act) {
      case 'retry': return renderAfter(refresh());
      case 'unlock': return unlock(button.dataset.reason || 'This is part of MyFinance Pro Plus');
      case 'add-debt': return window.openDebtEditor?.();
      case 'edit-debt': return window.openDebtEditor?.(id);
      case 'add-goal': return window.openAddGoalModal?.();
      case 'edit-goal': return window.openAddGoalModal?.(id);
      case 'flex': return openFlex(button.dataset.key);
      case 'review-spending': {
        const months = state.plan.debtPlan.coaching.months.map(row => row.month);
        try {
          return await window.openCategoryTransactions(button.dataset.category, { months, label: 'Debt plan review · observed completed months' });
        } catch (error) { reportFailure(error); return; }
      }
      case 'debt-strategy': case 'goal-strategy': {
        const list = act === 'debt-strategy' ? state.plan.debtPlan.strategies : state.plan.goalPlan.strategies;
        const choice = list.find(item => item.id === id);
        if (choice?.locked) return unlock(`${choice.name} is part of MyFinance Pro Plus`);
        if (choice?.id === (act === 'debt-strategy' ? state.plan.debtPlan.strategy : state.plan.goalPlan.strategy)) return;
        if (id === 'custom' && !state.plan.debtPlan.debts.some(debt => debt.custom_rank != null)) {
          const ids = rankedDebts().map(debt => debt.id);
          return mutate(api('/api/plan/debt-order', 'PUT', { ids }));
        }
        const before = act === 'debt-strategy' ? state.plan.debtPlan.plan : null;
        const saved = await mutate(api('/api/plan/settings', 'PUT', { [act === 'debt-strategy' ? 'debt_strategy' : 'goal_strategy']: id }));
        if (saved && choice) {
          const after = act === 'debt-strategy' ? saved.debtPlan.plan : null;
          const same = before && after && before.debtFreeDate === after.debtFreeDate && Math.abs((before.totalInterest || 0) - (after.totalInterest || 0)) < 1;
          notifyUser(same ? `Switched to ${choice.name}. Same payoff order as before, so your dates don't change.` : `Switched to ${choice.name}. Your plan and calendar are updated.`);
        }
        return saved;
      }
      case 'apply-budget': return mutate(api('/api/plan/settings', 'PUT', { debt_budget: Number(button.dataset.amount) }));
      case 'reset-budget': return mutate(api('/api/plan/settings', 'PUT', { debt_budget: null }));
      case 'reset-goal-budget': return mutate(api('/api/plan/settings', 'PUT', { goal_budget: null }));
      case 'toggle-debt': { const debt = findDebt(id); return debt && mutateThenReload(api(`/api/debts/${encodeURIComponent(id)}`, 'PUT', { included: !debt.included })); }
      case 'toggle-focus': { const debt = findDebt(id); return debt && mutateThenReload(api(`/api/debts/${encodeURIComponent(id)}`, 'PUT', { focus: !debt.focus })); }
      case 'toggle-goal': { const goal = findGoal(id); return goal && mutateThenReload(api(`/api/goals/${encodeURIComponent(id)}`, 'PUT', { included: !goal.included })); }
      case 'move-debt': {
        if (!unlock('Setting your own payoff order is part of MyFinance Pro Plus')) return;
        const ids = rankedDebts().map(debt => debt.id);
        const from = ids.findIndex(value => String(value) === String(id)), to = from + Number(button.dataset.dir);
        if (from < 0 || to < 0 || to >= ids.length) return;
        [ids[from], ids[to]] = [ids[to], ids[from]];
        return mutate(api('/api/plan/debt-order', 'PUT', { ids }));
      }
      case 'delete-debt': {
        const debt = findDebt(id);
        if (!debt || !await confirmAction(`Delete "${debt.name}" from your plan?`, 'Delete debt')) return;
        return mutateThenReload(api(`/api/debts/${encodeURIComponent(id)}`, 'DELETE'));
      }
      case 'delete-goal': {
        const goal = findGoal(id);
        if (!goal || !await confirmAction(`Delete "${goal.name}"?`, 'Delete goal')) return;
        return mutateThenReload(api(`/api/goals/${encodeURIComponent(id)}`, 'DELETE'));
      }
      case 'contribute-goal': {
        const amount = window.FinanceUI?.amount ? await window.FinanceUI.amount('Enter savings already set aside. This records progress; it does not transfer money.') : window.prompt('Amount saved');
        if (amount == null) return;
        if (!(Number(amount) > 0)) return notifyUser('Enter a positive amount.');
        await mutateThenReload(api(`/api/goals/${encodeURIComponent(id)}/contribute`, 'POST', { amount: Number(amount) }));
        return notifyUser('Savings recorded.');
      }
      case 'whatif-clear': state.whatIf = { extra: 0, lumpSum: 0, result: null }; return renderDebt();
    }
  }
  const rankedDebts = () => state.plan.debtPlan.debts.filter(debt => debt.included && debt.balance > 0).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  async function renderAfter(promise) { try { await promise; renderAll(); } catch (error) { reportFailure(error); } }
  async function mutateThenReload(request) {
    try { await request; state.plan = await api('/api/plan'); resetScenarios(); renderAll(); }
    catch (error) { reportFailure(error); }
  }

  let whatIfTimer = null;
  function scheduleWhatIf() {
    clearTimeout(whatIfTimer);
    whatIfTimer = setTimeout(async () => {
      const { extra, lumpSum } = state.whatIf;
      if (!extra && !lumpSum) { state.whatIf.result = null; paintWhatIf(); return; }
      try {
        const data = await api('/api/plan/what-if', 'POST', { extra, lumpSum });
        if (state.whatIf.extra !== extra || state.whatIf.lumpSum !== lumpSum) return;
        state.whatIf.result = data.debt;
        paintWhatIf();
      } catch (error) { reportFailure(error); }
    }, 300);
  }
  const goalTimers = {};
  function scheduleGoalWhatIf(id, monthly) {
    clearTimeout(goalTimers[id]);
    goalTimers[id] = setTimeout(async () => {
      if (!(monthly > 0)) { delete state.goalWhatIf[id]; return; }
      try {
        const data = await api('/api/plan/what-if', 'POST', { goalId: id, goalMonthly: monthly });
        state.goalWhatIf[id] = { monthly, result: data.goal };
        const output = document.querySelector(`[data-goal-whatif="${CSS.escape(String(id))}"]`)?.closest('label')?.querySelector('output');
        if (output) output.innerHTML = data.goal.finishDate ? `→ ${monthLabel(data.goal.finishDate)} ${data.goal.onTime ? '<b class="is-good">on time</b>' : '<b class="is-bad">late</b>'}` : '→ not reached';
      } catch (error) { reportFailure(error); }
    }, 350);
  }

  function bind(root) {
    if (!root || root.dataset.planBound) return;
    root.dataset.planBound = '1';
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-act]');
      if (!button || !root.contains(button) || button.disabled) return;
      button.disabled = true;
      try { await handleAction(button); } finally { button.disabled = false; }
    });
    root.addEventListener('input', event => {
      const target = event.target;
      if (target.id === 'plan-debt-range') { $('plan-debt-budget').value = target.value; }
      else if (target.id === 'plan-whatif-extra') { state.whatIf.extra = Number(target.value) || 0; $('plan-whatif-extra-out').textContent = money(state.whatIf.extra); scheduleWhatIf(); }
      else if (target.id === 'plan-whatif-lump') { state.whatIf.lumpSum = Math.max(0, Number(target.value) || 0); scheduleWhatIf(); }
      else if (target.dataset.goalWhatif) scheduleGoalWhatIf(target.dataset.goalWhatif, Number(target.value));
    });
    root.addEventListener('change', event => {
      const target = event.target;
      if (target.id === 'plan-debt-budget' || target.id === 'plan-debt-range') {
        const value = Number(target.value);
        if (!Number.isFinite(value) || value < 0) return notifyUser('Enter a valid monthly amount.');
        mutate(api('/api/plan/settings', 'PUT', { debt_budget: value }));
      } else if (target.id === 'plan-goal-budget') {
        const value = target.value === '' ? null : Number(target.value);
        if (value != null && (!Number.isFinite(value) || value < 0)) return notifyUser('Enter a valid monthly amount.');
        mutate(api('/api/plan/settings', 'PUT', { goal_budget: value }));
      }
    });
  }
  bind($('plan-debt-root'));
  bind($('plan-goals-root'));

  // ---------- flexible amounts (dashboard calendar + plan pages) ----------
  let flexDialog = null, flexItem = null;
  function ensureFlexDialog() {
    if (flexDialog) return flexDialog;
    flexDialog = document.createElement('dialog');
    flexDialog.id = 'plan-flex-dialog';
    flexDialog.className = 'floating-dialog plan-flex-dialog';
    flexDialog.setAttribute('aria-labelledby', 'plan-flex-title');
    flexDialog.innerHTML = `<form method="dialog" class="floating-dialog-body plan-flex-form">
      <header><div><p class="plan-eyebrow">FLEXIBLE THIS MONTH</p><h2 id="plan-flex-title"></h2></div><button type="button" class="dialog-close" data-flex="cancel" aria-label="Close">&times;</button></header>
      <p id="plan-flex-text" class="plan-flex-text"></p>
      <label class="plan-field">Amount this month<span class="plan-money-input"><span>$</span><input id="plan-flex-amount" type="number" min="0" step="5" required></span></label>
      <div class="plan-flex-quick" id="plan-flex-quick"></div>
      <p id="plan-flex-error" role="alert"></p>
      <footer><button type="button" class="btn btn-secondary" data-flex="reset">Reset to plan</button><button type="submit" class="btn btn-primary" data-flex="save">Save for this month</button></footer>
    </form>`;
    document.body.appendChild(flexDialog);
    flexDialog.addEventListener('click', event => {
      const quick = event.target.closest('[data-flex-quick]');
      if (quick) { $('plan-flex-amount').value = quick.dataset.flexQuick; return; }
      const action = event.target.closest('[data-flex]')?.dataset.flex;
      if (action === 'cancel') flexDialog.close();
      if (action === 'reset') saveFlex(null);
      if (event.target === flexDialog) flexDialog.close();
    });
    flexDialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const value = Number($('plan-flex-amount').value);
      if ($('plan-flex-amount').value === '' || !Number.isFinite(value) || value < 0) { $('plan-flex-error').textContent = 'Enter an amount of $0 or more.'; return; }
      saveFlex(value);
    });
    return flexDialog;
  }
  async function openFlex(key) {
    try {
      if (!state.plan) await refresh();
      const item = (state.plan.thisMonth || []).find(entry => entry.key === key && entry.flexible);
      if (!item) return notifyUser('This plan item is no longer on the calendar.');
      flexItem = item;
      const dialog = ensureFlexDialog();
      $('plan-flex-title').textContent = item.description;
      $('plan-flex-text').textContent = item.planKind === 'debt-extra'
        ? `The plan sets aside ${cents(item.defaultAmount)} above your minimums. If money is needed elsewhere this month, lower it here. Minimum payments stay untouched and next month returns to the plan.`
        : `The plan sets aside ${cents(item.defaultAmount)} for this goal. Skip or shrink it in a tight month; next month returns to the plan.`;
      $('plan-flex-amount').value = item.amount;
      $('plan-flex-error').textContent = '';
      const quick = [item.defaultAmount, Math.round(item.defaultAmount / 2), 0].filter((value, index, all) => all.indexOf(value) === index);
      $('plan-flex-quick').innerHTML = quick.map(value => `<button type="button" class="plan-pill" data-flex-quick="${value}">${value === item.defaultAmount ? 'Plan ' : value === 0 ? 'Skip · ' : 'Half · '}${money(value)}</button>`).join('');
      dialog.querySelector('[data-flex="reset"]').hidden = !item.adjusted;
      dialog.showModal();
      $('plan-flex-amount').focus();
    } catch (error) { reportFailure(error); }
  }
  async function saveFlex(amount) {
    if (!flexItem) return;
    const button = flexDialog.querySelector('[data-flex="save"]');
    button.disabled = true;
    try {
      state.plan = await api('/api/plan/flex', 'PUT', { key: flexItem.key, amount });
      flexDialog.close();
      renderAll();
      notifyUser(amount == null ? 'Back to the planned amount.' : `Set to ${cents(amount)} for this month.`);
      if ($('dashboard-view')?.classList.contains('active') && typeof window.loadDashboard === 'function') window.loadDashboard();
    } catch (error) { $('plan-flex-error').textContent = error.message; }
    finally { button.disabled = false; }
  }
  document.addEventListener('click', event => {
    const card = event.target.closest?.('[data-flex-key]');
    if (!card || event.target.closest('button:not([data-flex-key])')) return;
    openFlex(card.dataset.flexKey);
  });
  document.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-flex-key]')) { event.preventDefault(); openFlex(event.target.dataset.flexKey); }
  });
  // A trial or upgrade changes which strategies the server unlocks.
  document.addEventListener('pro:entitlement', event => {
    const next = !!event.detail?.plusActive;
    if (next === plusAccess) return;
    plusAccess = next;
    if (!next) state.plan = null;
    if ($('payoff-view')?.classList.contains('active')) window.loadPayoffPlan();
    else if ($('goals-view')?.classList.contains('active')) window.loadGoals();
  });
  let resizeTimer = null;
  window.addEventListener?.('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const figure = $('plan-debt-root')?.querySelector('.plan-chart');
      if (figure && state.plan) figure.outerHTML = chart(state.plan.debtPlan);
    }, 200);
  });

  // Rows for the existing debt and goal editors, so they edit what the planner shows.
  window.FinancePlan = {
    state, refresh, renderAll, openFlex, money, duration, monthLabel,
    debtRows: () => (state.plan?.debtPlan.debts || []).map(item => ({ ...item, due_date: item.due_day })),
    goalRows: () => (state.plan?.goalPlan.goals || []).map(goal => ({
      id: goal.id, name: goal.name, target_amount: goal.target, current_amount: goal.current, target_date: goal.targetDate, priority: goal.priority,
      icon: goalIcon(goal.icon), notes: goal.notes, included: goal.included, monthly_contribution: goal.manual, contribution_day: goal.contributionDay
    })),
    invalidate: () => { state.plan = null; resetScenarios(); }
  };
})();
