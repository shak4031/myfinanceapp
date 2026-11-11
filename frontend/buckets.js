// Spending buckets: fixed expenses, discretionary spending and debt payments. Renders the dashboard panel,
// the Categories summary strip and the dedicated Financial Health program.
(function () {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const money = value => `${value < 0 ? '−' : ''}$${Math.round(Math.abs(Number(value) || 0)).toLocaleString('en-US')}`;
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const pct = (value, base) => base > 0 ? Math.round(value / base * 100) : 0;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = key => MONTHS[Number(String(key).slice(5, 7)) - 1] || '';

  const ICONS = {
    fixed: '<path d="M4 11.5 12 5l8 6.5"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>',
    discretionary: '<path d="M6 8h12l-1.2 11.2a1 1 0 0 1-1 .8H8.2a1 1 0 0 1-1-.8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
    debt: '<rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M3 10h18M7 14.5h3"/>',
    left: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>'
  };
  const icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;

  // Guide shares of take-home pay; the health plan scores against the same numbers.
  const BUCKETS = [
    { key: 'fixed', label: 'Fixed expenses', color: '#3a6ea5', guide: 30, hint: 'Bills that repeat at about the same amount: rent, utilities, insurance, phone, subscriptions.' },
    { key: 'discretionary', label: 'Discretionary', color: '#7c3aed', guide: 30, hint: 'What you choose month to month: groceries, dining, shopping, travel and fun.' },
    { key: 'debt', label: 'Debt payments', color: '#c05621', guide: 25, hint: 'Mortgage, auto loans, credit cards, student and other loans, plus interest charges.' }
  ];
  const LEFT = { key: 'left', label: 'Left over', color: '#10b981', guide: 15 };
  const ROUTE_LABELS = { categories: 'Open Categories', analytics: 'Open Analytics', accounts: 'Open Accounts', payoff: 'Open Debt-free plan', goals: 'Open Goals', transactions: 'Open Transactions' };

  const state = { data: null, mode: 'typical', request: 0, error: '' };

  // ---------- Dashboard panel ----------
  function figures(data, mode) {
    if (mode === 'current') {
      const c = data.current;
      const income = num(c.income), spent = num(c.fixed) + num(c.discretionary) + num(c.debt);
      return { income, fixed: num(c.fixed), discretionary: num(c.discretionary), debt: num(c.debt), left: income - spent, items: c.items || {}, current: true };
    }
    const t = data.typical;
    return { income: num(t.income), fixed: num(t.fixed), discretionary: num(t.discretionary), debt: num(t.debt), left: num(t.left), items: t.items || {}, unrecorded: num(t.unrecordedDebt), current: false };
  }

  function splitBar(f) {
    const spent = f.fixed + f.discretionary + f.debt;
    const base = Math.max(f.income, spent, 1);
    const parts = [...BUCKETS.map(b => ({ ...b, value: f[b.key] })), { ...LEFT, value: Math.max(0, f.left) }].filter(p => p.value > 0);
    const segments = parts.map(p => {
      const width = p.value / base * 100;
      const share = pct(p.value, f.income);
      return `<span class="bucket-seg is-${p.key}" style="width:${width.toFixed(2)}%;--seg:${p.color}" title="${esc(p.label)}: ${money(p.value)}${f.income > 0 ? ` (${share}% of income)` : ''}">${width >= 9 && f.income > 0 ? `<b>${share}%</b>` : ''}</span>`;
    }).join('');
    const over = f.income > 0 && f.left < 0;
    return `<div class="bucket-split${over ? ' is-over' : ''}" role="img" aria-label="${esc(parts.map(p => `${p.label} ${money(p.value)}`).join(', '))}">${segments}${over ? `<i class="bucket-income-mark" style="left:${(f.income / base * 100).toFixed(2)}%" aria-hidden="true"></i>` : ''}</div>`;
  }

  function bucketCard(b, f) {
    const value = f[b.key];
    const share = pct(value, f.income);
    const items = (f.items[b.key] || []).slice(0, 3);
    const over = !f.current && f.income > 0 && share > b.guide;
    const fill = f.income > 0 ? Math.min(100, value / f.income * 100) : 0;
    return `<article class="bucket-card is-${b.key}" style="--bucket:${b.color}">
      <header><span class="bucket-icon">${icon(b.key)}</span><div><h3>${esc(b.label)}</h3><p>${esc(b.hint)}</p></div></header>
      <div class="bucket-figure"><strong>${money(value)}</strong><span>${f.current ? 'so far' : '/ mo'}</span>${f.income > 0 ? `<em class="${over ? 'is-over' : ''}">${share}% of income</em>` : ''}</div>
      ${f.income > 0 ? `<div class="bucket-meter" aria-hidden="true"><span style="width:${fill.toFixed(1)}%"></span>${f.current ? '' : `<i style="left:${b.guide}%" title="Guide ${b.guide}%"></i>`}</div>${f.current ? '' : `<small class="bucket-guide">Guide: about ${b.guide}% or less${over ? ` · ${money(value - f.income * b.guide / 100)} above` : ''}</small>`}` : ''}
      ${items.length ? `<ul class="bucket-items">${items.map(item => `<li><span>${esc(item.label)}</span><b>${money(item.amount)}</b></li>`).join('')}</ul>` : '<p class="bucket-none">Nothing recorded here yet.</p>'}
    </article>`;
  }

  function leftCard(f) {
    const share = pct(f.left, f.income);
    const good = f.left >= 0 && (f.current || share >= LEFT.guide);
    return `<article class="bucket-card is-left${f.left < 0 ? ' is-negative' : ''}" style="--bucket:${f.left < 0 ? '#be123c' : LEFT.color}">
      <header><span class="bucket-icon">${icon('left')}</span><div><h3>${f.left < 0 ? 'Overspent' : 'Left over'}</h3><p>${f.left < 0 ? 'More went out than came in.' : 'What is left after every bucket: room to save, invest or pay down debt faster.'}</p></div></header>
      <div class="bucket-figure"><strong>${money(f.left)}</strong><span>${f.current ? 'so far' : '/ mo'}</span>${f.income > 0 ? `<em class="${good ? 'is-good' : 'is-over'}">${share}% of income</em>` : ''}</div>
      ${f.income > 0 && !f.current ? `<div class="bucket-meter" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, share))}%"></span><i style="left:${LEFT.guide}%"></i></div><small class="bucket-guide">Guide: keep ${LEFT.guide}% or more${!good && f.left >= 0 ? ` · ${money(f.income * LEFT.guide / 100 - f.left)} short` : ''}</small>` : ''}
      ${f.unrecorded ? `<p class="bucket-none">Includes ${money(f.unrecorded)} of debt minimums you added but have not imported yet.</p>` : ''}
    </article>`;
  }

  function trend(data) {
    const rows = (data.months || []).filter(row => row.recorded || row.current);
    if (rows.length < 2) return '';
    const top = Math.max(1, ...rows.map(row => Math.max(num(row.income), num(row.fixed) + num(row.discretionary) + num(row.debt))));
    const cols = rows.map(row => {
      const spent = num(row.fixed) + num(row.discretionary) + num(row.debt);
      const stack = BUCKETS.map(b => `<span style="height:${(num(row[b.key]) / top * 100).toFixed(2)}%;background:${b.color}"></span>`).join('');
      const title = `${monthName(row.month)}${row.current ? ' so far' : ''}: income ${money(row.income)}, fixed ${money(row.fixed)}, discretionary ${money(row.discretionary)}, debt ${money(row.debt)}`;
      return `<div class="bucket-col${row.current ? ' is-current' : ''}${num(row.income) < spent ? ' is-over' : ''}" title="${esc(title)}"><div class="bucket-col-bar"><div class="bucket-col-stack">${stack}</div>${num(row.income) > 0 ? `<i class="bucket-col-income" style="bottom:${(num(row.income) / top * 100).toFixed(2)}%"></i>` : ''}</div><small>${row.current ? 'Now' : monthName(row.month)}</small></div>`;
    }).join('');
    return `<div class="bucket-trend"><div class="bucket-trend-head"><h3>Month by month</h3><span><i class="bucket-key-income"></i>Income</span></div><div class="bucket-cols" role="img" aria-label="Spending by bucket for the last ${rows.length} months">${cols}</div></div>`;
  }

  function headline(f, data) {
    if (f.current) {
      const c = data.current;
      return `<p class="bucket-headline"><b>Day ${num(c.day)} of ${num(c.daysInMonth)}.</b> ${money(f.income)} in so far and ${money(f.fixed + f.discretionary + f.debt)} out.</p>`;
    }
    const per100 = value => money(Math.round(value / f.income * 100));
    if (!(f.income > 0)) return '<p class="bucket-headline">No income recorded in these months yet, so shares of income are not shown.</p>';
    return `<p class="bucket-headline">Of every <b>$100</b> you bring home: ${BUCKETS.map(b => `<span class="bucket-chip" style="--bucket:${b.color}"><b>${per100(f[b.key])}</b> ${b.key === 'debt' ? 'debt' : b.label.toLowerCase()}</span>`).join('')}<span class="bucket-chip is-left" style="--bucket:${f.left < 0 ? '#be123c' : LEFT.color}"><b>${per100(Math.abs(f.left))}</b> ${f.left < 0 ? 'overspent' : 'left over'}</span></p>`;
  }

  function render() {
    const root = $('bucket-section');
    if (!root) return;
    const data = state.data;
    const head = (toggle = '') => `<div class="section-head"><div><h2>Where your money goes ${window.FinanceUI.howCalc('Fixed expenses, discretionary spending and debt payments, as a share of your take-home pay.', 'About your spending split')}</h2></div>${toggle}</div>`;
    if (state.error) { root.innerHTML = `${head()}<div class="bucket-empty"><p>${esc(state.error)}</p><button type="button" class="btn btn-secondary" data-bucket-retry>Try again</button></div>`; return; }
    if (!data) { root.innerHTML = `${head()}<div class="bucket-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`; return; }
    const hasCurrent = num(data.current.fixed) + num(data.current.discretionary) + num(data.current.debt) + num(data.current.income) > 0;
    if (!data.typical && !hasCurrent) {
      root.innerHTML = `${head()}<div class="bucket-empty"><p>Import a few months of statements to see how your spending splits into fixed expenses, discretionary spending and debt payments.</p><button type="button" class="btn btn-secondary" onclick="openImportModal('csv')">Import statements</button></div>`;
      return;
    }
    const mode = data.typical ? state.mode : 'current';
    const toggle = `<div class="view-toggle bucket-toggle" role="group" aria-label="Spending period">${[['typical', 'Typical month'], ['current', 'This month']].map(([key, label]) =>
      `<button type="button" data-bucket-mode="${key}" aria-pressed="${mode === key}"${key === 'typical' && !data.typical ? ' disabled' : ''}>${label}</button>`).join('')}</div>`;
    const f = figures(data, mode);
    const basis = mode === 'typical' ? `Average of the last ${data.monthsUsed} complete month${data.monthsUsed === 1 ? '' : 's'}` : 'This month to date';
    root.innerHTML = `${head(toggle)}
      ${headline(f, data)}
      ${splitBar(f)}
      <div class="bucket-grid">${BUCKETS.map(b => bucketCard(b, f)).join('')}${leftCard(f)}</div>
      ${trend(data)}
      <div class="bucket-foot"><span>${esc(basis)}. Transfers between your own accounts are left out. A mortgage counts as a debt payment, not a fixed expense.</span><a href="#financial-health" data-view="financial-health" class="bucket-plan-link">Open your financial health plan ${icon('arrow', 14)}</a></div>`;
  }

  async function load() {
    const root = $('bucket-section');
    if (!root) return;
    const request = ++state.request;
    state.error = '';
    if (!state.data) render();
    try {
      const response = await fetch('/api/dashboard/buckets');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Spending buckets are unavailable right now.');
      if (!data || !Array.isArray(data.months) || !data.current || typeof data.current !== 'object') throw new Error('Spending buckets are unavailable right now.');
      if (request !== state.request) return;
      state.data = data;
    } catch (error) {
      if (request !== state.request) return;
      state.data = null;
      state.error = error.message || 'Spending buckets are unavailable right now.';
    }
    render();
  }

  $('bucket-section')?.addEventListener('click', event => {
    const mode = event.target.closest?.('[data-bucket-mode]');
    if (mode && !mode.disabled) { state.mode = mode.dataset.bucketMode; render(); return; }
    if (event.target.closest?.('[data-bucket-retry]')) load();
  });

  // ---------- Categories summary ----------
  // Bucket totals for the rows the Categories page is showing (rows carry spending_bucket from the server).
  function strip(rows, { label = '' } = {}) {
    const totals = { fixed: 0, discretionary: 0, debt: 0 };
    for (const row of rows || []) {
      if (!Object.prototype.hasOwnProperty.call(totals, row?.spending_bucket)) continue;
      totals[row.spending_bucket] += Math.abs(num(row.amount));
    }
    const total = totals.fixed + totals.discretionary + totals.debt;
    if (!(total > 0)) return '';
    const segs = BUCKETS.filter(b => totals[b.key] > 0).map(b => `<span style="width:${(totals[b.key] / total * 100).toFixed(2)}%;background:${b.color}" title="${esc(b.label)}: ${money(totals[b.key])}"></span>`).join('');
    const chips = BUCKETS.map(b => `<div class="bucket-strip-item" style="--bucket:${b.color}"><span class="bucket-icon">${icon(b.key, 16)}</span><span><small>${esc(b.label)}</small><strong>${money(totals[b.key])}</strong><em>${pct(totals[b.key], total)}% of spending</em></span></div>`).join('');
    return `<div class="bucket-strip-head"><h2>Spending by type</h2>${label ? `<span>${esc(label)}</span>` : ''}</div><div class="bucket-strip-bar" role="img" aria-label="${esc(BUCKETS.map(b => `${b.label} ${money(totals[b.key])}`).join(', '))}">${segs}</div><div class="bucket-strip-items">${chips}</div>`;
  }

  // ---------- Financial health plan ----------
  let healthRequest = 0;
  let healthSaving = false;
  const validHealth = plan => plan && Array.isArray(plan.steps) && plan.steps.length === 12;
  async function readHealth(options) {
    const response = await fetch('/api/plan/health', options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load your financial health plan.');
    if (!validHealth(data)) throw new Error('The financial health plan response is incomplete. Please try again.');
    return data;
  }

  async function loadHealth() {
    const root = $('health-plan-root');
    if (!root || healthSaving) return;
    const run = ++healthRequest;
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = '<div class="panel" role="status">Loading your financial health plan...</div>';
    try {
      const plan = await readHealth();
      if (run !== healthRequest) return;
      root.innerHTML = renderHealth(plan);
    } catch (error) {
      if (run !== healthRequest) return;
      root.innerHTML = `<div class="panel" role="alert"><p>Could not load your financial health plan: ${esc(error.message)}</p><button type="button" class="btn btn-secondary" data-health-action="retry">Try again</button></div>`;
    } finally {
      if (run === healthRequest) root.setAttribute('aria-busy', 'false');
    }
  }

  function reset() {
    healthRequest++;
    healthSaving = false;
    state.request++;
    state.data = null;
    state.error = '';
    state.mode = 'typical';
    const root = $('health-plan-root');
    if (root) { root.innerHTML = ''; root.setAttribute('aria-busy', 'false'); }
    const refresh = $('refresh-health-btn');
    if (refresh) refresh.disabled = false;
  }

  const STATUS = { done: ['Done', 'is-done'], progress: ['In progress', 'is-progress'], todo: ['To do', 'is-todo'] };
  const BAND = { good: 'On target', close: 'Close', over: 'Needs work' };

  function scoreRing(plan) {
    if (plan.score == null) return `<div class="health-ring is-empty"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" class="health-ring-track"/></svg><div><strong>–</strong><span>No score yet</span></div></div>`;
    const c = 2 * Math.PI * 50;
    const score = Math.max(0, Math.min(100, plan.score));
    const ticks = Array.from({ length: 41 }, (_, i) => {
      const a = (i / 40 * 270 - 225) * Math.PI / 180;
      return `<line x1="${60 + 56 * Math.cos(a)}" y1="${60 + 56 * Math.sin(a)}" x2="${60 + 59 * Math.cos(a)}" y2="${60 + 59 * Math.sin(a)}" stroke="${i / 40 * 100 <= score ? 'currentColor' : '#cbd5e1'}" stroke-width="1.5"/>`;
    }).join('');
    const tone = plan.grade?.tone || 'good';
    return `<div class="health-ring is-${esc(tone)}" role="img" aria-label="Health score ${plan.score} out of 100, ${esc(plan.grade?.label || '')}"><svg viewBox="0 0 120 120" aria-hidden="true">${ticks}<circle cx="60" cy="60" r="50" class="health-ring-track" stroke-dasharray="${c * .75} ${c}" transform="rotate(135 60 60)"/><circle cx="60" cy="60" r="50" class="health-ring-fill" stroke-dasharray="${(c * .75 * score / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(135 60 60)"/></svg><div><strong>${plan.score}</strong><span>${esc(plan.grade?.label || '')}</span></div></div>`;
  }

  function targetRows(plan) {
    if (!plan.buckets) return '<p class="health-muted">Import a few months of income and spending to compare your split with the guide.</p>';
    const colors = { fixed: BUCKETS[0].color, discretionary: BUCKETS[1].color, debt: BUCKETS[2].color, save: LEFT.color };
    return `<ul class="health-targets">${plan.buckets.map(row => {
      const share = Number(row.share) || 0;
      const scale = Math.max(60, share + 5, row.target + 10);
      const save = row.key === 'save';
      const note = row.status === 'good' ? BAND.good : save ? `${money(row.change)}/mo short` : `${money(row.change)}/mo over`;
      return `<li class="is-${esc(row.status)}" style="--bucket:${colors[row.key] || '#64748b'}"><div class="health-target-head"><span>${esc(row.label)}</span><b>${share}%</b><em>${save ? 'aim' : 'guide'} ${save ? '≥' : '≤'} ${row.target}%</em><i class="health-chip is-${esc(row.status)}">${esc(note)}</i></div>
        <div class="health-target-bar" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, share / scale * 100)).toFixed(1)}%"></span><i style="left:${(row.target / scale * 100).toFixed(1)}%"></i></div></li>`;
    }).join('')}</ul>`;
  }

  function stepCard(step, plan, openId) {
    const [label, cls] = STATUS[step.status] || STATUS.todo;
    const current = plan.week === step.week && !plan.finished;
    const advanced = ['analytics', 'payoff', 'goals'].includes(step.route) && !window.FinancePro?.isPlusActive?.();
    return `<li><details class="health-step ${cls}${current ? ' is-current' : ''}"${step.id === openId ? ' open' : ''}>
      <summary><span class="health-step-week">W${step.week}</span><span class="health-step-title">${esc(step.title)}${current ? '<em>This week</em>' : ''}</span><span class="health-chip ${cls}">${step.status === 'done' ? icon('check', 12) : ''}${label}</span></summary>
      <div class="health-step-body"><p>${esc(step.summary)}</p><p class="health-step-detail">${esc(step.detail)}</p>
        <div class="health-step-actions"><a href="#${esc(step.route)}" data-view="${esc(step.route)}">${esc(ROUTE_LABELS[step.route] || 'Open')}${advanced ? ' (Pro tool)' : ''} ${icon('arrow', 13)}</a>
        <button type="button" class="health-tick${step.manual ? ' is-on' : ''}" data-health-step="${esc(step.id)}" data-health-done="${step.manual ? 'false' : 'true'}" aria-pressed="${step.manual}">${icon('check', 14)}${step.manual ? 'Marked done' : step.autoStatus === 'done' ? 'Done automatically' : 'Mark done'}</button></div></div>
    </details></li>`;
  }

  function renderHealth(plan) {
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return '';
    const months = [1, 2, 3].map(month => plan.steps.filter(step => step.month === month));
    const openStep = plan.startedAt && !plan.finished
      ? (plan.steps.find(step => step.week === plan.week && step.status !== 'done') || plan.steps.find(step => step.status !== 'done'))
      : plan.steps.find(step => step.status !== 'done');
    const progress = Math.round(plan.completed / plan.steps.length * 100);
    const journey = plan.startedAt
      ? `<div class="health-journey"><div><p class="checkup-kicker">${plan.finished ? '90 DAYS COMPLETE' : `WEEK ${plan.week} OF 12`}</p><strong>${plan.completed} of ${plan.steps.length} steps done</strong><div class="health-progress" role="progressbar" aria-label="Plan progress" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${progress}%"></span></div><small>Started ${esc(plan.startedAt)}.${plan.finished ? ' Check in every quarter, or start a fresh 90 days.' : ''}</small></div><button type="button" class="health-text-btn" data-health-action="reset">${icon('reset', 14)}Start over</button></div>`
      : `<div class="health-journey is-start"><div><p class="checkup-kicker">THE 90-DAY RESET</p><strong>Twelve small steps, one a week.</strong><small>Starting saves today’s numbers as your week-1 baseline, so later steps can show what changed. ${plan.completed} step${plan.completed === 1 ? ' is' : 's are'} already done from your data.</small></div><button type="button" class="btn btn-primary" data-health-action="start">Start my 90 days</button></div>`;
    const focus = plan.focus?.length
      ? `<div class="health-focus"><h4>Where to start</h4><ol>${plan.focus.map(item => `<li>${esc(item.text)}</li>`).join('')}</ol></div>`
      : plan.buckets ? '<div class="health-focus is-good"><h4>Nicely balanced</h4><p>Your split is within every guide. Keep the plan going to lock it in.</p></div>' : '';
    return `<section class="health-plan" aria-labelledby="health-title">
      <header class="health-head"><div><p class="checkup-kicker">YOUR FINANCIAL HEALTH PLAN</p><h2 id="health-title">Know your numbers. Build the foundation. Lock it in.</h2><p>How a typical month splits against a simple guide (fixed ≤ 30%, discretionary ≤ 30%, debt ≤ 25%, saving ≥ 15% of take-home), and a 12-week plan to improve it.</p></div></header>
      <div class="health-top">${scoreRing(plan)}<div class="health-top-body">${targetRows(plan)}${plan.typical ? `<small class="health-muted">Based on ${money(plan.typical.income)} a month take-home, averaged over ${plan.monthsUsed} complete month${plan.monthsUsed === 1 ? '' : 's'}. A guide, not a grade: a high-cost area or a new mortgage can push one bucket up for good reasons.</small>` : ''}</div></div>
      ${focus}
      ${journey}
      <div class="health-months">${months.map((steps, i) => `<section class="health-month"><h3><span>Month ${i + 1}</span>${esc(steps[0]?.monthTitle || '')}</h3><ol>${steps.map(step => stepCard(step, plan, openStep?.id)).join('')}</ol></section>`).join('')}</div>
    </section>`;
  }

  async function changeHealth(body, button) {
    const root = $('health-plan-root');
    if (!root || healthSaving) return;
    healthSaving = true;
    root.setAttribute('aria-busy', 'true');
    const refresh = $('refresh-health-btn');
    if (refresh) refresh.disabled = true;
    root.querySelectorAll('button').forEach(control => { control.disabled = true; });
    if (button) button.disabled = true;
    const run = ++healthRequest;
    try {
      const data = await readHealth({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (run !== healthRequest) return;
      root.innerHTML = renderHealth(data);
      root.querySelector('.health-step[open] summary')?.focus();
    } catch (error) {
      if (run !== healthRequest) return;
      window.notify?.(error.message || 'Could not update your plan.');
    } finally {
      if (button) button.disabled = false;
      if (run === healthRequest) {
        healthSaving = false;
        root.setAttribute('aria-busy', 'false');
        root.querySelectorAll('button').forEach(control => { control.disabled = false; });
        if (refresh) refresh.disabled = false;
      }
    }
  }

  $('refresh-health-btn')?.addEventListener('click', loadHealth);
  $('health-plan-root')?.addEventListener('click', event => {
    const action = event.target.closest?.('[data-health-action]');
    if (action) {
      if (action.dataset.healthAction === 'retry') { loadHealth(); return; }
      if (action.dataset.healthAction === 'reset' && typeof window.confirm === 'function' && !window.confirm('Start the 90-day plan over? Your ticks and baseline will be cleared.')) return;
      changeHealth({ action: action.dataset.healthAction }, action);
      return;
    }
    const tick = event.target.closest?.('[data-health-step]');
    if (tick) changeHealth({ step: tick.dataset.healthStep, done: tick.dataset.healthDone === 'true' }, tick);
  });

  window.FinanceBuckets = { load, render, strip, loadHealth, renderHealth, changeHealth, reset, setMode: mode => { state.mode = mode; render(); }, state };
})();
