// MyFinance Pro analytics: the Overview tab (KPIs, forecast, cash flow, trends, category signals, recurring charges and more)
// and the Spending Compass tab (household benchmarks and chart-style signals with realistic savings).
(() => {
  const $ = id => document.getElementById(id);
  let request = 0, sortKey = 'mtd', sortDir = -1, current = null, tab = 'overview';
  const pro = () => globalThis.FinancePro;
  const charts = () => globalThis.ProCharts;
  const dateShort = iso => iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '&mdash;';
  const arrow = (value, upIsBad = true) => {
    if (value == null || Math.abs(value) < 0.005) return '<span class="pro-move is-flat">▬ flat</span>';
    const up = value > 0;
    const text = Math.abs(value) > 5 ? '>500' : Math.abs(Math.round(value * 100));
    return `<span class="pro-move ${up === upIsBad ? 'is-bad' : 'is-good'}">${up ? '▲' : '▼'} ${text}%</span>`;
  };
  const card = (title, subtitle, body, extra = '') => `<article class="pro-card panel ${extra}"><header><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div></header><div class="pro-card-body">${body}</div></article>`;
  const how = text => globalThis.FinanceUI?.howCalc?.(text) || '';
  const KPI_NOTES = [
    'Everything spent since the 1st of this month, transfers between your own accounts excluded, compared with the same day last month.',
    'Spent so far, plus bills still due this month, plus your average flexible spending for the days left.',
    'Average monthly spending over the last 3 full months, transfers excluded.',
    'Average income minus average spending, as a share of income, over the last 3 full months.',
    'Share of your average monthly spending that goes to bills marked as fixed.',
    'Spent this month divided by the days so far this month.'
  ];

  function renderActions() {
    const actions = $('analytics-actions');
    if (!actions) return;
    const { ICONS } = pro();
    const lock = pro().isActive() ? '' : ICONS.lock;
    actions.innerHTML = `<button type="button" class="btn btn-secondary" data-analytics-action="budgets">${lock || ICONS.budgets}Budgets</button>
      <button type="button" class="btn btn-secondary" data-analytics-action="export-categories">${lock || ICONS.export}Category report</button>
      <button type="button" class="btn btn-primary" data-analytics-action="export-transactions">${lock || ICONS.export}Export transactions</button>`;
  }

  function lockedPreview(entitlement) {
    const { ICONS, format: { esc } } = pro();
    const { bars, sparkline } = charts();
    const demo = [1820, 2140, 1960, 2310, 2050, 2480, 2290, 2620, 2410, 2380, 2710, 2560];
    const label = entitlement.trialAvailable ? 'Start your free 7-day trial' : 'See plans';
    const features = (entitlement.features || []).map(f => `<li>${ICONS[f.id] || ICONS.spark}<span><strong>${esc(f.title)}</strong>${esc(f.text)}</span></li>`).join('');
    return `<div class="pro-locked">
      <div class="pro-locked-preview" aria-hidden="true">
        <div class="pro-kpis">${['Spent this month', 'Projected month-end', 'Savings rate', 'Daily burn'].map((t, i) => `<div class="pro-kpi"><span>${t}</span><strong>${['$2,184', '$2,730', '18%', '$73'][i]}</strong>${sparkline(demo.slice(i, i + 8))}</div>`).join('')}</div>
        <div class="pro-grid">${card('Monthly spend', '', bars({ labels: 'JFMAMJJASOND'.split(''), values: demo, lines: [{ values: demo.map((_, i) => i < 2 ? null : (demo[i] + demo[i - 1] + demo[i - 2]) / 3), className: 'sma' }] }))}${card('Category signals', '', '<div class="pro-skeleton"></div><div class="pro-skeleton"></div><div class="pro-skeleton"></div>')}</div>
      </div>
      <div class="pro-locked-cta panel">
        <span class="pro-hero-mark">${ICONS.lock}</span>
        <p class="eyebrow">MYFINANCE PRO &middot; $4.99/MONTH</p>
        <h2>${entitlement.source === 'trial-expired' ? 'Your Pro trial has ended' : 'Unlock the full picture'}</h2>
        <p class="muted">Moving averages, budgets, forecasts and signals for every category &mdash; the insights that turn transactions into decisions.</p>
        <ul class="pro-locked-features">${features}</ul>
        <button type="button" class="btn btn-primary" data-analytics-action="upgrade">${label}</button>
      </div></div>`;
  }

  function kpis(a) {
    const { money, pct } = pro().format;
    const { sparkline } = charts();
    const k = a.kpis, s = a.series;
    const tiles = [
      ['Spent this month', money(k.mtdSpend, true), `${arrow(k.mtdDeltaPct)} vs same day last month`, sparkline(a.forecast.paceCurrent.length > 1 ? a.forecast.paceCurrent : [0, k.mtdSpend])],
      ['Projected', money(a.forecast.projected, true), `Month-end &middot; last month ${money(a.forecast.lastMonth, true)}`, sparkline(s.spend)],
      ['Avg monthly', money(k.avgMonthlySpend, true), `Spend · income ${money(k.avgMonthlyIncome, true)} / mo`, sparkline(s.spend)],
      ['Savings rate', pct(k.savingsRate), k.savingsRate == null ? 'Add income to measure' : k.savingsRate >= 0.2 ? 'Healthy cushion' : k.savingsRate >= 0 ? 'Room to improve' : 'Spending exceeds income', sparkline(s.income.map((v, i) => v - s.spend[i]))],
      ['Fixed vs flexible', pct(k.fixedRatio), 'of spend is fixed bills', sparkline(s.fixed)],
      ['Daily burn', money(k.dailyBurn, true), `${k.daysLeft} day${k.daysLeft === 1 ? '' : 's'} left this month`, sparkline(s.variable)]
    ];
    return `<div class="pro-kpis">${tiles.map(([label, value, note, spark], index) => `<div class="pro-kpi"><span>${label}${how(KPI_NOTES[index])}</span><strong>${value}</strong><small>${note}</small>${spark}</div>`).join('')}</div>`;
  }

  function forecastCard(a) {
    const { money } = pro().format;
    const f = a.forecast, { plot } = charts();
    const xMax = Math.max(f.daysInMonth, f.paceLast.length);
    const current = f.paceCurrent.map((v, i) => ({ x: i + 1, v }));
    const last = f.paceLast.map((v, i) => ({ x: i + 1, v }));
    const projection = current.length ? [current[current.length - 1], { x: f.daysInMonth, v: f.projected }] : [];
    const ticks = [1, 8, 15, 22, f.daysInMonth].map(x => ({ x, label: `Day ${x}` }));
    const verdict = f.projected > f.lastMonth * 1.05 ? `<span class="pro-move is-bad">Pacing ${money(f.projected - f.lastMonth, true)} above last month</span>`
      : f.projected < f.lastMonth * 0.95 ? `<span class="pro-move is-good">Pacing ${money(f.lastMonth - f.projected, true)} below last month</span>` : '<span class="pro-move is-flat">In line with last month</span>';
    const body = `<div class="pro-forecast-head"><div><span>Projected</span><strong>${money(f.projected, true)}</strong></div><div><span>Spent</span><strong>${money(f.mtd, true)}</strong></div><div><span>Bills still due</span><strong>${money(f.remainingFixed, true)}</strong></div><div><span>Expected flexible</span><strong>${money(f.remainingVariable, true)}</strong></div></div>
      ${plot({ series: [{ points: last, className: 'muted-line' }, { points: current, className: 'primary', area: true, dot: true }, { points: projection, className: 'primary', dashed: true }], xMax, xTicks: ticks, label: 'Month-end forecast' })}
      <div class="pro-legend"><span class="primary">This month</span><span class="primary dashed">Projection</span><span class="muted-line">Last month</span>${verdict}</div>`;
    return card('Month-end forecast', 'Spending pace this month against last month, with bills still due', body, 'span-2');
  }

  function cashflowCard(a) {
    const { money } = pro().format;
    const c = a.cashflow, { plot } = charts();
    if (c.startBalance == null) return card('6-month cash flow', 'Projected balance from your recurring income and spending', '<p class="pro-empty">Import a statement with a running balance to project your cash flow.</p>');
    const points = [{ x: 0, v: c.startBalance }, ...c.months.map((m, i) => ({ x: i + 1, v: m.balance }))];
    const ticks = [{ x: 0, label: 'Now' }, ...c.months.map((m, i) => ({ x: i + 1, label: charts().monthShort(m.month) }))];
    const low = Math.min(...points.map(p => p.v)), end = points[points.length - 1].v;
    const net = c.months[0]?.net || 0;
    const basis = c.monthsUsed ? `the last ${c.monthsUsed} full month${c.monthsUsed === 1 ? '' : 's'}` : 'recent months';
    const netNote = c.basis === 'typical-surplus'
      ? how(`Your typical monthly surplus: average income minus average spending over ${basis}, transfers excluded. It is the same number your dashboard, Debt and Goals pages use.`)
      : how('Average income minus last month\'s bills and your average flexible spending.');
    const body = `${plot({ series: [{ points, className: end >= c.startBalance ? 'primary' : 'danger', area: true, dot: true }], xMax: c.months.length, xTicks: ticks, width: 380, height: 220, label: 'Projected balance' })}
      <div class="pro-mini-stats"><div><span>Balance today</span><strong>${money(c.startBalance, true)}</strong></div><div><span>In 6 months</span><strong class="${end < 0 ? 'is-bad' : ''}">${money(end, true)}</strong></div><div><span>${c.basis === 'typical-surplus' ? 'Typical surplus' : 'Net / month'}${netNote}</span><strong class="${net < 0 ? 'is-bad' : 'is-good'}">${net >= 0 ? '+' : ''}${money(net, true)}</strong></div><div><span>Lowest point</span><strong class="${low < 0 ? 'is-bad' : ''}">${money(low, true)}</strong></div></div>`;
    return card('6-month cash flow', 'Projected balance if your typical surplus continues each month', body);
  }

  function trendCard(a) {
    const s = a.series, { bars, monthShort } = charts();
    const sma3 = s.spend.map((_, i) => i < 2 ? null : (s.spend[i] + s.spend[i - 1] + s.spend[i - 2]) / 3);
    const body = `${bars({ labels: a.months.map(monthShort), values: s.spend, lines: [{ values: sma3, className: 'sma' }, { values: s.income, className: 'income' }], label: 'Monthly spending' })}
      <div class="pro-legend"><span class="bar">Spending</span><span class="sma">3-month moving average</span><span class="income">Income</span></div>`;
    return card('Monthly spend trend', 'Twelve months of spending with a 3-month moving average', body, 'span-2');
  }

  const SIGNAL_TEXT = { above: 'Running hot', below: 'Cooling', inline: 'In line', new: 'New' };
  const COLUMNS = [
    ['name', 'Category'], ['mtd', 'This month'], ['deltaPct', 'vs last mo.'], ['sma3', '3-mo avg'], ['sma6', '6-mo avg'],
    ['share', 'Share'], ['trend', 'Trend / mo'], ['volatility', 'Volatility'], ['signal', 'Signal']
  ];

  function signalsTable(a) {
    const { money, pct, esc } = pro().format;
    const { sparkline } = charts();
    const rows = a.categories.filter(c => !c.transfer && (c.mtd || c.sma6)).slice().sort((x, y) => {
      const l = x[sortKey], r = y[sortKey];
      if (typeof l === 'string' || typeof r === 'string') return String(l).localeCompare(String(r)) * sortDir;
      return ((l ?? -Infinity) - (r ?? -Infinity)) * sortDir;
    });
    const head = COLUMNS.map(([key, label]) => `<th scope="col"${key === 'name' ? '' : ' class="num"'} aria-sort="${sortKey === key ? (sortDir < 0 ? 'descending' : 'ascending') : 'none'}"><button type="button" data-sort="${key}">${label}${sortKey === key ? (sortDir < 0 ? ' ↓' : ' ↑') : ''}</button></th>`).join('');
    const body = rows.map(c => `<tr>
      <th scope="row"><button type="button" class="pro-cat-link" data-open="${esc(c.name)}"><span>${esc(c.name)}</span>${sparkline(c.series, { width: 84, height: 24, className: c.trend > 0.03 ? 'is-up' : c.trend < -0.03 ? 'is-down' : '' })}</button></th>
      <td class="num"><strong>${money(c.mtd, true)}</strong>${c.budget ? `<small class="pro-budget-chip is-${c.budgetStatus}">${Math.round(c.budgetUsed * 100)}% of budget</small>` : ''}</td>
      <td class="num">${c.lastMonthToDate ? arrow(c.deltaPct) : c.mtd ? '<span class="pro-move is-flat">new</span>' : '<span class="pro-move is-flat">&mdash;</span>'}</td>
      <td class="num">${money(c.sma3, true)}</td><td class="num">${money(c.sma6, true)}</td>
      <td class="num"><span class="pro-share"><i style="width:${Math.min(100, (c.share || 0) * 100).toFixed(1)}%"></i></span>${pct(c.share)}</td>
      <td class="num">${c.trend == null ? '&mdash;' : arrow(c.trend)}</td>
      <td class="num">${c.volatility == null ? '&mdash;' : `<span class="pro-vol" title="Month-to-month variation">${c.volatility < 0.25 ? 'Low' : c.volatility < 0.6 ? 'Medium' : 'High'}</span>`}</td>
      <td class="num"><span class="pro-signal is-${c.signal}">${SIGNAL_TEXT[c.signal] || c.signal}</span></td></tr>`).join('');
    return card('Category signals', 'Each category against its own moving averages. "Running hot" means the projected month is 15%+ above the 3-month average.',
      rows.length ? `<div class="table-scroll"><table class="pro-table" id="pro-signals-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : '<p class="pro-empty">Import a few months of transactions to see category signals.</p>', 'span-3');
  }

  function recurringCard(a) {
    const { money, esc } = pro().format;
    const all = a.recurring || [];
    const unmarked = all.filter(s => !s.fixed);
    const fixedCount = all.filter(s => s.fixed && s.active).length;
    const active = unmarked.filter(s => s.active);
    const monthly = active.reduce((sum, s) => sum + s.monthlyCost, 0);
    const increases = active.filter(s => s.priceChangePct > 0.02);
    const list = unmarked.slice(0, 12).map(s => `<li class="${s.active ? '' : 'is-inactive'}"><div><strong>${esc(s.merchant)}</strong><small>${esc(s.cadence)} &middot; ${esc(s.category)} &middot; ${s.active ? `next ${dateShort(s.nextDate)}` : 'stopped'}${s.likelyBill ? ' &middot; looks like a bill' : ''}</small></div>
      <div class="num"><strong>${money(s.amount)}</strong>${s.priceChangePct > 0.02 ? `<small class="pro-move is-bad">▲ ${Math.round(s.priceChangePct * 100)}% price increase</small>` : `<small>${money(s.annualCost, true)} / yr</small>`}${s.active && s.id != null ? `<button type="button" class="btn btn-secondary btn-compact" data-analytics-action="mark-fixed" data-id="${esc(s.id)}" data-merchant="${esc(s.merchant)}" title="Mark every ${esc(s.merchant)} charge as a fixed payment, including future imports">Mark fixed</button>` : ''}</div></li>`).join('');
    const note = fixedCount ? `<p class="muted">${fixedCount} other recurring payment${fixedCount === 1 ? ' is' : 's are'} already marked fixed and on your bill calendar.</p>` : '';
    const body = `<div class="pro-mini-stats"><div><span>Not marked fixed${how('Charges from the same merchant at a steady price on a regular schedule (weekly, monthly, quarterly or yearly) where none of the charges is marked as a fixed payment. Groceries, gas, dining, shopping and transfers between your own accounts are left out. Mark real bills as fixed so they appear on your bill calendar and month-end forecast; review the rest and cancel what you no longer use.')}</span><strong>${active.length}</strong></div><div><span>Per month</span><strong>${money(monthly, true)}</strong></div><div><span>Per year</span><strong>${money(monthly * 12, true)}</strong></div><div><span>Price increases</span><strong class="${increases.length ? 'is-bad' : ''}">${increases.length}</strong></div></div>
      ${list ? `<ul class="pro-list is-scroll">${list}</ul>` : `<p class="pro-empty">${all.length ? 'Every recurring charge is already marked fixed.' : 'No recurring charges detected yet.'}</p>`}${note}`;
    return card('Recurring charges not marked fixed', 'Payments that repeat on a schedule but are not marked as fixed bills. Mark the real bills fixed; review the rest.', body);
  }

  function anomaliesCard(a) {
    const { money, esc } = pro().format;
    const list = a.anomalies.slice(0, 8).map(x => x.type === 'charge'
      ? `<li><div><strong>${esc(x.merchant)}</strong><small>${dateShort(x.date)} &middot; ${esc(x.category)}</small></div><div class="num"><strong>${money(x.amount)}</strong><small class="pro-move is-bad">${x.ratio.toFixed(1)}&times; the usual ${money(x.typical, true)}</small></div></li>`
      : `<li><div><strong>${esc(x.category)}</strong><small>Category on pace for an unusual month</small></div><div class="num"><strong>${money(x.amount, true)}</strong><small class="pro-move is-bad">${x.ratio.toFixed(1)}&times; the usual ${money(x.typical, true)}</small></div></li>`).join('');
    return card('Unusual activity', 'Charges and categories well outside your normal pattern', list ? `<ul class="pro-list is-wrap">${list}</ul>` : `<p class="pro-empty is-good">${pro().ICONS.check} Nothing unusual. Your spending is within its normal range.</p>`);
  }

  function merchantsCard(a) {
    const { money, pct, esc } = pro().format;
    const max = Math.max(...a.merchants.map(m => m.total), 1);
    const list = a.merchants.map((m, i) => `<li><span class="pro-rank">${i + 1}</span><div class="pro-merchant"><div><strong>${esc(m.merchant)}</strong><small>${m.count} visit${m.count === 1 ? '' : 's'} &middot; avg ${money(m.average, true)} &middot; ${pct(m.share)} of spend</small></div><span class="pro-share"><i style="width:${((m.total / max) * 100).toFixed(1)}%"></i></span></div><div class="num"><strong>${money(m.total, true)}</strong>${m.change == null ? '' : arrow(m.change)}</div></li>`).join('');
    return card('Top merchants', 'Where the last 90 days of spending went', list ? `<ol class="pro-list is-scroll is-tall">${list}</ol>` : '<p class="pro-empty">No merchant spending in the last 90 days.</p>');
  }

  function weekdayCard(a) {
    const { money, pct } = pro().format;
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const longNames = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    const max = Math.max(...a.weekdays, 1), peak = a.weekdays.indexOf(Math.max(...a.weekdays));
    const bars = a.weekdays.map((v, i) => `<div class="pro-weekday${i === peak && v > 0 ? ' is-peak' : ''}"><span style="height:${Math.max(3, (v / max) * 100).toFixed(1)}%" title="${names[i]}: ${money(v, true)}"></span><small>${names[i]}</small></div>`).join('');
    const note = a.weekdays[peak] > 0 ? `${longNames[peak]} are your biggest spending day (${money(a.weekdays[peak], true)} in 90 days).` : 'Not enough recent activity yet.';
    const total = a.weekdays.reduce((s, v) => s + v, 0);
    if (!total) return card('Weekly rhythm', note, `<div class="pro-weekdays">${bars}</div>`);
    const weekend = a.weekdays[0] + a.weekdays[6];
    const quiet = a.weekdays.indexOf(Math.min(...a.weekdays));
    const stats = [
      ['Weekdays (Mon&ndash;Fri)', `${money(total - weekend, true)} &middot; ${pct((total - weekend) / total)}`],
      ['Weekends', `${money(weekend, true)} &middot; ${pct(weekend / total)}`],
      ['Average week', money(total / (90 / 7), true)],
      ['Quietest day', longNames[quiet].slice(0, -1)]
    ].map(([k, v]) => `<li><span>${k}</span><strong>${v}</strong></li>`).join('');
    return card('Weekly rhythm', note, `<div class="pro-weekdays">${bars}</div><ul class="pro-weekday-table">${stats}</ul>`);
  }

  const REGION_NAMES = { northeast: 'Northeast', midwest: 'Midwest', south: 'South', west: 'West' };
  const MF_STATUS = { high: ['High', 'is-above'], above: ['Above', 'is-above'], typical: ['Typical', 'is-inline'], below: ['Below', 'is-below'] };
  const MF_HOW = 'Typical spending comes from the U.S. Bureau of Labor Statistics Consumer Expenditure Survey (2024), adjusted for your household size, region and whether you rent or own. No other MyFinance user\'s data is used. Each category is then read like a price chart, using completed months only: the 3-month average against the 12-month average (a crossover means the trend has turned), momentum against the same three months last year (which cancels out seasons), a volatility band of 2 standard deviations around your normal month, and how many of the last 6 months went up. Large one-off purchases (at least $250 and 5 times your usual charge in that category) are set aside so they do not look like a habit. Savings targets are levels you have already reached: your cheaper months, the typical household, or for seasonal bills the same months last year.';

  function householdForm(mf) {
    const p = mf.profile || {};
    const sizes = Array.from({ length: 8 }, (_, i) => i + 1).map(n => `<option value="${n}"${p.size === n ? ' selected' : ''}>${n}${n === 8 ? '+' : ''} ${n === 1 ? 'person' : 'people'}</option>`).join('');
    const regions = Object.entries(REGION_NAMES).map(([value, label]) => `<option value="${value}"${p.region === value ? ' selected' : ''}>${label}</option>`).join('');
    return `<form class="pro-mf-form" id="pro-mf-household" hidden>
      <label>Household size<select name="size"><option value="">Not set</option>${sizes}</select></label>
      <label>Region<select name="region"><option value="">Not set</option>${regions}</select></label>
      <label>Home<select name="housing"><option value="">Not set</option><option value="own"${p.housing === 'own' ? ' selected' : ''}>Own</option><option value="rent"${p.housing === 'rent' ? ' selected' : ''}>Rent</option></select></label>
      <div class="pro-mf-form-actions"><button type="button" class="btn btn-secondary btn-compact" data-analytics-action="household-cancel">Cancel</button><button type="button" class="btn btn-primary btn-compact" data-analytics-action="household-save">Save household</button></div>
    </form>`;
  }

  function householdChips(mf) {
    const { esc } = pro().format;
    const p = mf.profile || {};
    if (!mf.profileSet) return '<span class="pro-mf-chip is-empty">Household not set</span>';
    return [p.size ? `${p.size}${p.size >= 8 ? '+' : ''} ${p.size === 1 ? 'person' : 'people'}` : null, p.region ? REGION_NAMES[p.region] : null, p.housing ? (p.housing === 'own' ? 'Own home' : 'Rent') : null]
      .filter(Boolean).map(t => `<span class="pro-mf-chip">${esc(t)}</span>`).join('');
  }

  const shortLabel = label => String(label).split(/ [&(]/)[0];
  const isAbove = c => c.benchmarkStatus === 'high' || c.benchmarkStatus === 'above';
  const isUnusual = c => !!c.spike || c.band?.position === 'above';
  // One colour language across the page: act now (red), worth watching (amber), on track (neutral).
  const tone = c => !c ? null : [isAbove(c), c.rising, isUnusual(c)].filter(Boolean).length >= 2 || c.opportunity ? 'act' : isAbove(c) || c.rising || isUnusual(c) ? 'watch' : 'ok';
  const TONE_COLORS = { act: '#e11d48', watch: '#f59e0b', ok: '#8b5cf6' };

  function compassHero(mf) {
    const { money, esc } = pro().format;
    const household = `<div class="pro-hero-household"><span>Compared with ${esc(mf.comparedWith)}</span>${householdChips(mf)}
      <button type="button" class="btn btn-secondary btn-compact" data-analytics-action="household-edit">${mf.profileSet ? 'Edit household' : 'Set your household'}</button></div>${householdForm(mf)}
      ${mf.profileSet ? '' : '<p class="pro-mf-hint">Add your household size, region and whether you rent or own for a fair comparison. Until then you are compared with the average U.S. household.</p>'}`;
    if (mf.status !== 'ok' || !mf.categories.length) {
      return `<section class="pro-compass-hero panel"><div class="pro-hero-main"><p class="pro-hero-eyebrow">SPENDING COMPASS</p><strong class="pro-hero-figure is-small">Your compass needs a little more history</strong>
        <p class="pro-hero-sub">Import at least 3 full months of spending in standard categories (groceries, dining, utilities, gas, shopping, entertainment, healthcare) to see your compass.</p>${household}</div></section>`;
    }
    const plan = mf.opportunities.length
      ? `<ol class="pro-hero-plan">${mf.opportunities.map(o => {
        const c = mf.categories.find(row => row.id === o.id);
        return `<li><span><b>${esc(shortLabel(o.label))}</b><small>${money(c?.average3 ?? o.target + o.monthly, true)} &rarr; ${money(o.target, true)} a month</small></span><strong>${money(o.monthly, true)}<small>/mo</small></strong></li>`;
      }).join('')}</ol>`
      : `<p class="pro-hero-clear">${pro().ICONS.check} No category is both above typical and rising. Nothing to cut right now.</p>`;
    const figure = mf.opportunities.length ? `${money(mf.potentialMonthly, true)} a month` : 'On course';
    const sub = mf.opportunities.length
      ? `${money(mf.potentialAnnual, true)} a year &middot; ${money(mf.potentialAnnual * 5, true)} over 5 years, by returning to levels you have already reached.`
      : 'Your everyday spending is in line with similar households and holding steady.';
    return `<section class="pro-compass-hero panel"><div class="pro-hero-main"><p class="pro-hero-eyebrow">YOUR COMPASS FOUND</p><strong class="pro-hero-figure">${figure}</strong><p class="pro-hero-sub">${sub}</p>${household}</div>
      <div class="pro-hero-side"><p class="pro-hero-eyebrow">YOUR PLAN</p>${plan}</div></section>`;
  }

  function compassInsights(mf) {
    const { esc } = pro().format;
    if (!mf.insights?.length) return '';
    return `<section class="pro-insights" aria-label="What stood out">${mf.insights.map(i => `<article class="pro-insight tone-${esc(i.tone)}" data-insight="${esc(i.id)}">
      <strong>${esc(i.figure)}</strong><h3>${esc(i.title)}</h3><p>${esc(i.detail)}</p></article>`).join('')}</section>`;
  }

  // Sankey diagram: income on the left, fixed bills / everyday spending / left over in the middle, categories on the right.
  function flowSankey(mf) {
    const { money, esc } = pro().format;
    const f = mf.flow;
    if (!f || !(f.income > 0)) return card('Where your money flows', '', '<p class="pro-empty">Import a few months of income and spending to see where your money goes.</p>');
    const byId = new Map(mf.categories.map(c => [c.id, c]));
    // Income and the four groups are labelled blocks; categories are thin bars with labels that never collide.
    const W = 960, TOP = 30, BASE_H = 380, SRC_W = 132, MID_X = 340, MID_W = 168, DST_X = 720, DST_W = 10;
    const GAP = 16, MIN_BLOCK = 30, SLOT = 22, CHILD_GAP = 6, GROUP_GAP = 16, INCOME = '#059669';
    const shortfall = Math.max(0, -f.left);
    const middle = [
      { key: 'fixed', label: 'Fixed bills', value: f.fixed.total, color: '#475569', children: f.fixed.items },
      { key: 'everyday', label: 'Everyday spending', value: f.everyday.total, color: '#7c3aed', children: f.everyday.items },
      { key: 'debt', label: 'Debt minimums', title: 'Debt minimums not yet imported', value: f.debt, color: '#334155', children: [] },
      { key: 'left', label: 'Left over', value: Math.max(0, f.left), color: '#10b981', children: [] }
    ].filter(node => node.value > 0);
    const total = Math.max(f.income + shortfall, middle.reduce((s, n) => s + n.value, 0));
    const scale = (BASE_H - GAP * (middle.length - 1)) / total;
    const pct = value => `${Math.round(value / f.income * 100)}%`;
    const fx = value => value.toFixed(1);
    let defs = '', bands = '', nodes = '', labels = '', gradient = 0;
    const band = (x0, a0, a1, x2, b0, b1, from, to, title) => {
      const id = `pro-sk-g${gradient++}`, mx = (x0 + x2) / 2;
      defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x2}" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
      bands += `<path class="pro-sk-band" d="M${x0} ${fx(a0)}C${mx} ${fx(a0)} ${mx} ${fx(b0)} ${x2} ${fx(b0)}L${x2} ${fx(b1)}C${mx} ${fx(b1)} ${mx} ${fx(a1)} ${x0} ${fx(a1)}Z" fill="url(#${id})"><title>${esc(title)}</title></path>`;
    };
    const block = (x, y, w, h, color, name, value, title) => {
      nodes += `<rect class="pro-sk-block" x="${x}" y="${fx(y)}" width="${w}" height="${fx(h)}" rx="8" fill="${color}"><title>${esc(title)}</title></rect>`;
      labels += h >= 46
        ? `<text x="${x + 14}" y="${fx(y + 23)}" class="pro-sk-in">${esc(name)}</text><text x="${x + 14}" y="${fx(y + 40)}" class="pro-sk-in-sub">${value}</text>`
        : `<text x="${x + 14}" y="${fx(y + h / 2 + 4.5)}" class="pro-sk-in">${esc(name)}<tspan class="pro-sk-in-sub" dx="6">${value}</tspan></text>`;
    };
    const incomeH = f.income * scale;
    block(0, 0, SRC_W, incomeH, INCOME, 'Income', `${money(f.income, true)}/mo`, `Income ${money(f.income, true)} a month`);
    let bottom = incomeH;
    if (shortfall) {
      const sh = shortfall * scale;
      nodes += `<rect x="0" y="${fx(incomeH)}" width="${SRC_W}" height="${fx(Math.max(sh, 2))}" rx="4" fill="#e11d48"><title>Spent more than came in: ${money(shortfall, true)} a month</title></rect>`;
      labels += `<text x="0" y="${fx(incomeH + sh + 18)}" class="pro-sk-label is-bad">Overspent ${money(shortfall, true)}/mo</text>`;
      bottom = incomeH + sh + 24;
    }
    let y = 0, source = 0, rightY = 0;
    for (const node of middle) {
      const h = node.value * scale, bh = Math.max(h, MIN_BLOCK), inset = (bh - h) / 2;
      const name = node.title || node.label;
      band(SRC_W, source, source + h, MID_X, y + inset, y + inset + h, INCOME, node.color, `${name}: ${money(node.value, true)} a month (${pct(node.value)} of income)`);
      block(MID_X, y, MID_W, bh, node.color, node.label, `${money(node.value, true)} · ${pct(node.value)}`, `${name}: ${money(node.value, true)} a month (${pct(node.value)} of income)`);
      const kids = node.children.map(child => ({ child, h: child.amount * scale, slot: Math.max(child.amount * scale, SLOT) }));
      const span = kids.reduce((s, k) => s + k.slot, 0) + CHILD_GAP * Math.max(0, kids.length - 1);
      let cy = Math.max(rightY, y + bh / 2 - span / 2), offset = y + inset;
      for (const kid of kids) {
        const t = tone(kid.child.id ? byId.get(kid.child.id) : null);
        const color = t && t !== 'ok' ? TONE_COLORS[t] : node.color;
        const ny = cy + (kid.slot - kid.h) / 2;
        band(MID_X + MID_W, offset, offset + kid.h, DST_X, ny, ny + kid.h, node.color, color, `${kid.child.label}: ${money(kid.child.amount, true)} a month (${pct(kid.child.amount)} of income)`);
        nodes += `<rect x="${DST_X}" y="${fx(ny)}" width="${DST_W}" height="${fx(Math.max(kid.h, 2))}" rx="3" fill="${color}"/>`;
        labels += `<text x="${DST_X + DST_W + 10}" y="${fx(cy + kid.slot / 2 + 4.5)}" class="pro-sk-label${t === 'act' ? ' is-bad' : ''}">${esc(shortLabel(kid.child.label))}<tspan class="pro-sk-value" dx="7">${money(kid.child.amount, true)}</tspan><tspan class="pro-sk-pct" dx="6">${pct(kid.child.amount)}</tspan></text>`;
        offset += kid.h; cy += kid.slot + CHILD_GAP;
      }
      if (kids.length) rightY = cy - CHILD_GAP + GROUP_GAP;
      source += h; y += bh + GAP;
    }
    const H = Math.ceil(Math.max(y - GAP, rightY - GROUP_GAP, bottom)) + TOP + 4;
    const heads = [[0, 'MONEY IN'], [MID_X, 'WHERE IT GOES'], [DST_X, 'BY CATEGORY · SHARE OF INCOME']]
      .map(([x, text]) => `<text x="${x}" y="12" class="pro-sk-head">${text}</text>`).join('');
    const svg = `${heads}<g transform="translate(0 ${TOP})">${bands}${nodes}${labels}</g>`;
    const per100 = value => money(Math.round(value / f.income * 100), true);
    const split = [['fixed bills', f.fixed.total], ['everyday spending', f.everyday.total], ['debt not yet imported', f.debt]]
      .filter(([, v]) => v > 0).map(([k, v]) => `<b>${per100(v)}</b> ${k}`);
    split.push(f.left >= 0 ? `<b class="tone-good">${per100(f.left)}</b> left over` : `<b class="tone-bad">${per100(-f.left)}</b> more than came in`);
    const svgEl = `<div class="pro-sankey-wrap"><svg class="pro-sankey" viewBox="0 0 ${W} ${H}" role="img" aria-label="Money flow: income ${money(f.income, true)} a month to fixed bills ${money(f.fixed.total, true)}, everyday spending ${money(f.everyday.total, true)} and left over ${money(f.left, true)}"><defs>${defs}</defs>${svg}</svg></div><p class="pro-sk-legend"><span><i style="background:${TONE_COLORS.act}"></i>Act on it</span><span><i style="background:${TONE_COLORS.watch}"></i>Worth watching</span><span class="pro-sk-hint">Hover a ribbon for the exact amount</span></p>`;
    return card(`Where your money flows${how(`Monthly average of the last ${f.months} full month${f.months === 1 ? '' : 's'}. Transfers between your own accounts are left out, so "left over" is the same typical monthly surplus your dashboard shows. Fixed bills are payments marked as fixed; everything else is everyday spending. Red and amber ribbons are categories the Compass flags.`)}`,
      `Of every $100 you bring home: ${split.join(' &middot; ')}`, svgEl, 'span-3');
  }

  // Three-set Venn diagram: the categories where several independent signals agree are the ones worth acting on.
  const SIGNAL_NAMES = { a: 'Above similar homes', b: 'Trending up', c: 'Unusual last month' };
  function signalVenn(mf) {
    const { esc } = pro().format;
    const regions = { a: [128, 140], b: [432, 140], c: [280, 372], ab: [280, 96], ac: [192, 262], bc: [368, 262], abc: [280, 200] };
    const MAX_NAMES = { a: 5, b: 5, c: 4, ab: 2, ac: 3, bc: 3, abc: 3 };
    const placed = {}, clear = [];
    for (const c of mf.categories) {
      const key = `${isAbove(c) ? 'a' : ''}${c.rising ? 'b' : ''}${isUnusual(c) ? 'c' : ''}`;
      if (!key) clear.push(shortLabel(c.label)); else (placed[key] ||= []).push(c);
    }
    const names = Object.entries(placed).map(([key, list]) => {
      const [x, y0] = regions[key];
      const shown = list.slice(0, MAX_NAMES[key]), more = list.length - shown.length;
      const lines = shown.map(c => shortLabel(c.label)).concat(more ? [`+${more} more`] : []);
      const start = y0 - (lines.length - 1) * 10 + (key === 'abc' ? 12 : 0);
      return lines.map((label, i) => `<text x="${x}" y="${start + i * 20}" class="pro-venn-name${key.length >= 2 ? ' is-act' : ''}${more && i === lines.length - 1 ? ' is-more' : ''}" text-anchor="middle">${esc(label)}</text>`).join('');
    }).join('');
    const svg = `<svg class="pro-venn" viewBox="0 0 560 446" role="img" aria-label="Signals overlap: ${Object.entries(placed).map(([k, l]) => `${l.map(c => shortLabel(c.label)).join(', ')} in ${k.length} signal${k.length === 1 ? '' : 's'}`).join('; ') || 'no category flagged'}">
      <circle cx="200" cy="165" r="140" class="pro-venn-a"/><circle cx="360" cy="165" r="140" class="pro-venn-b"/><circle cx="280" cy="285" r="140" class="pro-venn-c"/>
      <text x="64" y="16" class="pro-venn-set">${SIGNAL_NAMES.a}</text><text x="496" y="16" class="pro-venn-set" text-anchor="end">${SIGNAL_NAMES.b}</text><text x="280" y="442" class="pro-venn-set" text-anchor="middle">${SIGNAL_NAMES.c}</text>
      ${placed.abc ? '<text x="280" y="178" class="pro-venn-tag" text-anchor="middle">ACT NOW</text>' : ''}${names}</svg>`;
    // The same overlap in words, strongest first, so nothing depends on reading small text inside the circles.
    const groups = [3, 2, 1].map(count => ({ count, items: Object.entries(placed).filter(([key]) => key.length === count).flatMap(([key, list]) => list.map(c => ({ c, key }))) })).filter(g => g.items.length);
    const heading = { 3: ['All three signals', 'Act now', 'act'], 2: ['Two signals agree', 'Worth changing', 'act'], 1: ['One signal', 'Keep an eye on it', 'watch'] };
    const side = `<div class="pro-venn-read"><h4>Reading the overlap</h4>${groups.length ? groups.map(({ count, items }) => `<div class="pro-venn-group tone-${heading[count][2]}"><p class="pro-venn-group-head"><b>${heading[count][0]}</b><span>${heading[count][1]}</span></p><ul>${items.map(({ c, key }) => `<li><strong>${esc(shortLabel(c.label))}</strong><span>${[...key].map(k => SIGNAL_NAMES[k]).join(' + ')}</span></li>`).join('')}</ul></div>`).join('') : '<p class="pro-empty">No category shows a warning signal right now.</p>'}
      ${clear.length ? `<p class="pro-venn-clear">${pro().ICONS.check} <b>On track:</b> ${clear.map(esc).join(', ')}</p>` : ''}</div>`;
    return card(`Where the signals overlap${how('Above similar homes: your 3-month average is more than 10% over the U.S. Bureau of Labor Statistics figure for households like yours. Trending up: up more than 10% on the same months last year (confirmed by the recent trend), or the 3-month average clearly above the 12-month average. Unusual last month: last month was above the 95th percentile of the months before it, or above its 2-standard-deviation band. One signal is worth watching; where two or three overlap, the habit is real and worth changing.')}`,
      'One signal is worth watching. Where circles overlap, act.', `<div class="pro-venn-layout">${svg}${side}</div>`, 'span-3');
  }

  // Strip plot per category: your 5th-95th percentile range, your median, every month as a dot, last month and the typical home.
  function rangeStrips(mf) {
    const { money, esc } = pro().format;
    const rows = mf.categories.map(c => {
      const r = c.range, months = c.series.slice(-r.months);
      const max = Math.max(r.p95, r.latest, c.expected || 0, ...months) * 1.08 || 1;
      const at = value => `${Math.min(100, Math.max(0, value / max * 100)).toFixed(1)}%`;
      const t = c.spike ? 'tone-bad' : r.latest > r.p50 ? 'tone-warn' : 'tone-good';
      const rank = r.compared ? (r.higherThan === r.compared ? `Highest in ${r.compared + 1} months` : r.higherThan === 0 ? `Lowest in ${r.compared + 1} months` : `Above ${r.higherThan} of ${r.compared} prior months`) : '';
      return `<li class="pro-range-row">
        <div class="pro-range-name"><b>${esc(shortLabel(c.label))}</b><small>${esc(r.month.split(' ')[0])}: ${money(r.latest, true)}</small></div>
        <div class="pro-range-track" role="img" aria-label="${esc(c.label)}: last month ${money(r.latest, true)}; your usual range ${money(r.p5, true)} to ${money(r.p95, true)}; median ${money(r.p50, true)}${c.expected ? `; similar households ${money(c.expected, true)}` : ''}">
          <span class="pro-range-band" style="left:${at(r.p5)};width:calc(${at(r.p95)} - ${at(r.p5)})"></span>
          <span class="pro-range-median" style="left:${at(r.p50)}"></span>
          ${months.map(v => `<i style="left:${at(v)}"></i>`).join('')}
          ${c.expected ? `<span class="pro-range-typical" style="left:${at(c.expected)}" title="Similar households: ${money(c.expected, true)}"></span>` : ''}
          <span class="pro-range-latest ${t}" style="left:${at(r.latest)}" title="${esc(r.month)}: ${money(r.latest, true)}"></span>
        </div>
        <div class="pro-range-note"><b class="${t}">${esc(rank)}</b><small>Usual ${money(r.p5, true)}&ndash;${money(r.p95, true)}${c.expected ? ` &middot; similar homes ${money(c.expected, true)}` : ''}</small></div></li>`;
    }).join('');
    const legend = '<div class="pro-range-legend"><span><i class="is-band"></i>Your usual range (5th&ndash;95th percentile)</span><span><i class="is-median"></i>Your median</span><span><i class="is-dot"></i>Each month</span><span><i class="is-latest"></i>Last month</span><span><i class="is-typical"></i>Similar households</span></div>';
    return card(`Your normal range${how('Each row uses the last 12 full months of that category, scaled to itself. The shaded bar runs from your 5th to your 95th percentile month, so 9 in 10 of your months fall inside it. A last month beyond the right edge of the bar is a top-5% month. The diamond is what similar households spend, from the U.S. Bureau of Labor Statistics. Large one-off purchases are set aside.')}`,
      'Where last month landed against your own history and against similar households', `${legend}<ul class="pro-range-list">${rows}</ul>`, 'span-3');
  }

  // Category x month heatmap. Each row is coloured against its own median month, so a steady bill stays neutral and
  // only real swings light up: red runs hot, green runs cool.
  const heatColor = (value, base) => {
    const dev = base > 0 ? value / base - 1 : 0;
    if (Math.abs(dev) < 0.08) return { bg: 'transparent', k: 0, dev };
    const k = Math.min(1, Math.abs(dev) / 0.6);
    return { bg: `rgba(${dev > 0 ? '225,29,72' : '16,185,129'},${(0.12 + 0.78 * k).toFixed(2)})`, k, dev };
  };
  const compact = value => value >= 9950 ? `$${(value / 1000).toFixed(0)}k` : value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${Math.round(value)}`;
  const middle = values => { const s = [...values].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

  function spendHeatmap(mf) {
    const { money, esc } = pro().format;
    const hm = mf.heatmap;
    if (!hm?.rows?.length) return '';
    const usual = values => { const m = middle(values); return m > 0 ? m : values.reduce((s, v) => s + v, 0) / values.length; };
    const totals = hm.months.map((_, i) => hm.rows.reduce((s, row) => s + row.values[i], 0));
    const cell = (label, month, value, base) => {
      const c = heatColor(value, base);
      const note = c.k ? `${Math.round(Math.abs(c.dev) * 100)}% ${c.dev > 0 ? 'above' : 'below'} your usual ${money(base, true)}` : 'about usual';
      return `<td class="pro-heat-cell${c.k > 0.55 ? ' is-strong' : ''}" style="background:${c.bg}" title="${esc(label)}, ${esc(month)}: ${money(value, true)} (${note})">${value ? compact(value) : '&middot;'}</td>`;
    };
    const head = `<tr><th scope="col">Category</th>${hm.months.map(m => `<th scope="col">${esc(m.split(' ')[0])}<small>${esc(m.split(' ')[1].slice(2))}</small></th>`).join('')}<th scope="col" class="num">Usual</th></tr>`;
    const body = hm.rows.map(row => {
      const base = usual(row.values);
      return `<tr><th scope="row">${esc(shortLabel(row.label))}${row.fixed ? '<small>fixed</small>' : ''}</th>${row.values.map((v, i) => cell(row.label, hm.months[i], v, base)).join('')}<td class="num">${money(base, true)}</td></tr>`;
    }).join('');
    const totalBase = usual(totals);
    const foot = `<tr class="pro-heat-total"><th scope="row">All shown</th>${totals.map((v, i) => cell('All shown', hm.months[i], v, totalBase)).join('')}<td class="num">${money(totalBase, true)}</td></tr>`;
    // The takeaway: the hottest month and the category that drove most of it.
    const hot = totals.reduce((best, v, i) => v > totals[best] ? i : best, 0);
    const driver = hm.rows.map(row => ({ row, extra: row.values[hot] - usual(row.values) })).sort((a, b) => b.extra - a.extra)[0];
    const lede = totals[hot] > totalBase * 1.08 && driver?.extra > 0
      ? `<p class="pro-heat-lede"><b>${esc(hm.months[hot])}</b> was your hottest month: ${money(totals[hot], true)}, ${money(totals[hot] - totalBase, true)} over your usual month. <b>${esc(shortLabel(driver.row.label))}</b> drove ${money(driver.extra, true)} of it.</p>`
      : '<p class="pro-heat-lede">No month ran far above your usual. Look along each row for categories that keep running warm.</p>';
    const legend = '<div class="pro-heat-legend"><span>Cooler than usual</span><i style="background:rgba(16,185,129,.9)"></i><i style="background:rgba(16,185,129,.4)"></i><i class="is-neutral"></i><i style="background:rgba(225,29,72,.4)"></i><i style="background:rgba(225,29,72,.9)"></i><span>Hotter than usual</span></div>';
    return card(`Hot and cold months${how('Every spending category (transfers between your own accounts excluded), month by month. Each row is coloured against its own median month, so steady bills stay neutral and a category only lights up when it swings: within 8% of usual is blank, and colour deepens up to 60% above or below. "Usual" is that median month. Hover a cell for the exact figure.')}`,
      'Each row against its own usual month. Red runs hot, green runs cool.',
      `${lede}<div class="table-scroll"><table class="pro-heatmap"><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>${legend}`, 'span-3');
  }

  // Merchant bubbles: size and colour switch between attributes; the field itself is a small physics simulation (mountBubbles).
  let bubbleSize = 'spend', bubbleColor = 'change', field = null;
  const CATEGORY_RGB = ['167,139,250', '56,189,248', '251,191,36', '52,211,153', '244,114,182', '251,146,60', '129,140,248', '45,212,191', '250,204,21', '248,113,113'];
  const changeText = item => item.isNew ? 'New' : item.change == null ? '' : Math.abs(item.change) < 0.05 ? 'Steady' : `${item.change > 0 ? '+' : '&minus;'}${Math.abs(item.change) > 2 ? '200%+' : `${Math.round(Math.abs(item.change) * 100)}%`}`;
  const climb = item => item.change == null ? 0 : item.monthly - item.monthly / (1 + item.change);

  function vendorField(mf) {
    const { money, esc } = pro().format;
    const v = mf.vendors;
    if (!v?.items?.length) return '';
    const top5 = v.items.slice(0, 5).reduce((s, i) => s + (i.share || 0), 0);
    const climber = [...v.items].sort((a, b) => climb(b) - climb(a))[0];
    const seg = (kind, value, label, active) => `<button type="button" data-bubble-${kind}="${value}" aria-pressed="${active}">${label}</button>`;
    const controls = `<div class="pro-bubble-controls">
      <div class="pro-seg" role="group" aria-label="Bubble size"><span>Size</span>${seg('size', 'spend', 'Monthly spend', bubbleSize === 'spend')}${seg('size', 'visits', 'Visits', bubbleSize === 'visits')}</div>
      <div class="pro-seg" role="group" aria-label="Bubble colour"><span>Colour</span>${seg('color', 'change', 'Change', bubbleColor === 'change')}${seg('color', 'category', 'Category', bubbleColor === 'category')}</div></div>`;
    const said = item => `${esc(item.name)}: ${money(item.monthly, true)} a month, ${item.visits} visit${item.visits === 1 ? '' : 's'} a month${item.isNew ? ', new' : item.change == null ? '' : Math.abs(item.change) < 0.05 ? ', steady' : `, ${item.change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(item.change) * 100)}%`}`;
    const bubbles = v.items.map((item, i) => `<button type="button" class="pro-bubble" data-bubble="${i}" aria-label="${said(item)}"><b>${esc(item.name)}</b><small></small></button>`).join('');
    const lede = `Your top 5 merchants take <b>${Math.round(top5 * 100)}%</b> of everyday spending.${climber && climb(climber) >= 10 ? ` Biggest climber: <b>${esc(climber.name)}</b>, up ${money(climb(climber), true)} a month.` : ''} Tap a bubble for its story.`;
    const aside = v.setAside ? `<p class="pro-footnote">${v.setAside.count} one-off purchase${v.setAside.count === 1 ? '' : 's'} over ${money(v.setAside.over, true)} set aside so a single big buy does not swamp the picture.</p>` : '';
    return card(`Who gets your money${how(`Your ${v.items.length} biggest everyday merchants over the last ${v.months} full months (fixed bills and transfers between your own accounts excluded). Size is the monthly average spend or the number of visits a month. In Change colours, red is spending more than the ${v.compareMonths || 3} months before and green is spending less; the deeper the colour, the bigger the change. In Category colours, the deeper the colour, the more often you go. Drag bubbles to rearrange them.`)}`,
      `Last ${v.months} months &middot; ${money(v.total, true)} a month across everyday merchants. Drag them around.`,
      `${controls}<div class="pro-bubbles" id="pro-bubbles" role="group" aria-label="Merchant bubbles">${bubbles}</div>
       <p class="pro-bubble-detail" id="pro-bubble-detail" aria-live="polite">${lede}</p><div class="pro-bubble-legend" id="pro-bubble-legend"></div>${aside}`, 'span-3');
  }

  function bubbleDetail(item) {
    const { money, esc } = pro().format;
    const change = item.isNew ? 'new in the last 3 months' : item.change == null ? '' : Math.abs(item.change) < 0.05 ? 'about the same as the 3 months before'
      : `${item.change > 0 ? 'up' : 'down'} ${money(Math.abs(climb(item)), true)} a month (${Math.abs(item.change) > 2 ? 'more than tripled' : `${Math.round(Math.abs(item.change) * 100)}%`}) on the 3 months before`;
    return `<b>${esc(item.name)}</b> &middot; ${esc(item.category)} &middot; <b>${money(item.monthly, true)}</b> a month (${money(item.monthly * 12, true)} a year) &middot; ${item.visits} visit${item.visits === 1 ? '' : 's'} a month at about ${money(item.ticket, true)}${change ? ` &middot; ${change}` : ''}${item.regular ? ' &middot; every month' : ''}`;
  }

  function stopField() {
    if (!field) return;
    globalThis.cancelAnimationFrame?.(field.raf);
    field.observer?.disconnect();
    field = null;
  }

  function mountBubbles(v) {
    const el = $('pro-bubbles');
    if (!el?.isConnected || !v?.items?.length || typeof globalThis.requestAnimationFrame !== 'function') return stopField();
    const kept = field?.el === el ? field.nodes : null, keptW = field?.w;
    stopField();
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    const values = v.items.map(item => Math.max(bubbleSize === 'visits' ? item.visits : item.monthly, 0.01));
    const total = values.reduce((s, x) => s + x, 0);
    const maxR = Math.min(w, h) * 0.2, minR = w < 500 ? 10 : 13;
    const categories = [...new Set(v.items.map(item => item.category))];
    const buttons = [...el.querySelectorAll('.pro-bubble')];
    const nodes = buttons.map((b, i) => {
      const item = v.items[i];
      const r = Math.min(maxR, Math.max(minR, Math.sqrt(values[i] / total * w * h * 0.5 / Math.PI)));
      let rgb = '148,163,184', k = 0.2;
      if (bubbleColor === 'category') { rgb = CATEGORY_RGB[categories.indexOf(item.category) % CATEGORY_RGB.length]; k = Math.min(1, 0.2 + item.visits / 8); }
      else if (item.isNew) { rgb = '56,189,248'; k = 0.6; }
      else if (item.change != null && Math.abs(item.change) >= 0.05) { rgb = item.change > 0 ? '244,63,94' : '34,197,94'; k = Math.min(1, 0.25 + Math.abs(item.change) / 0.6); }
      b.style.setProperty('--r', r.toFixed(1));
      b.style.setProperty('--rgb', rgb);
      b.style.setProperty('--k', k.toFixed(2));
      b.style.setProperty('--i', i);
      b.classList.toggle('is-tiny', r < 26);
      // Shrink the font until the longest word fits the bubble's inner width (about 0.74em per bold uppercase character).
      const longest = Math.max(...item.name.split(/\s+/).map(word => word.length));
      b.style.setProperty('--fit', Math.max(0.5, Math.min(1, (r * 1.6) / (0.74 * longest * (r * 0.22 + 4)))).toFixed(2));
      b.querySelector('small').innerHTML = bubbleColor === 'change' ? changeText(item) : bubbleSize === 'visits' ? `${item.visits}&times;/mo` : compact(item.monthly);
      const old = kept?.[i], angle = i * 2.4, dist = 12 * Math.sqrt(i + 1) * (w / 400);
      return { i, b, r, x: old ? old.x / (keptW || w) * w : w / 2 + Math.cos(angle) * dist, y: old ? old.y : h / 2 + Math.sin(angle) * dist * 0.6, vx: 0, vy: 0 };
    });
    const legend = $('pro-bubble-legend');
    if (legend) legend.innerHTML = bubbleColor === 'category'
      ? `${categories.map((c, i) => `<span><i style="--rgb:${CATEGORY_RGB[i % CATEGORY_RGB.length]}"></i>${pro().format.esc(c)}</span>`).join('')}<span class="pro-bubble-note">Deeper colour = more visits</span>`
      : '<span><i style="--rgb:244,63,94"></i>Spending more</span><span><i style="--rgb:34,197,94"></i>Spending less</span><span><i style="--rgb:56,189,248"></i>New</span><span><i style="--rgb:148,163,184"></i>Steady</span><span class="pro-bubble-note">Deeper colour = bigger change</span>';
    field = { el, w, h, nodes, raf: 0, drag: null, frames: 0, v };
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !kept) for (let t = 0; t < 300; t++) stepField(field);
    drawField(field);
    kickField();
    if (typeof globalThis.ResizeObserver === 'function') {
      field.observer = new ResizeObserver(() => { if (field?.el === el && Math.abs(el.clientWidth - field.w) > 8) mountBubbles(v); });
      field.observer.observe(el);
    }
    if (!el.dataset.bound) bindField(el);
  }

  function stepField(f) {
    const { nodes, w, h, drag } = f;
    let moved = 0;
    for (const n of nodes) {
      if (drag?.node === n) continue;
      n.vx = (n.vx + (w / 2 - n.x) * 0.0025) * 0.84;
      n.vy = (n.vy + (h / 2 - n.y) * 0.006) * 0.84;
      n.x += n.vx; n.y += n.vy;
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
        const p = nodes[a], q = nodes[b];
        const dx = q.x - p.x, dy = q.y - p.y, min = p.r + q.r + 3, d = Math.hypot(dx, dy) || 0.01;
        if (d >= min) continue;
        const push = (min - d) / d, wp = drag?.node === p ? 0 : drag?.node === q ? 1 : 0.5, wq = 1 - wp;
        p.x -= dx * push * wp; p.y -= dy * push * wp; q.x += dx * push * wq; q.y += dy * push * wq;
      }
      for (const n of nodes) {
        const x = Math.min(w - n.r, Math.max(n.r, n.x)), y = Math.min(h - n.r, Math.max(n.r, n.y));
        if (x !== n.x) n.vx *= -0.4;
        if (y !== n.y) n.vy *= -0.4;
        n.x = x; n.y = y;
      }
    }
    for (const n of nodes) { moved += Math.abs(n.x - (n.px ?? n.x)) + Math.abs(n.y - (n.py ?? n.y)); n.px = n.x; n.py = n.y; }
    return moved;
  }

  function drawField(f) {
    for (const n of f.nodes) n.b.style.transform = `translate(${(n.x - n.r).toFixed(1)}px, ${(n.y - n.r).toFixed(1)}px)`;
  }

  function kickField() {
    const f = field;
    if (!f || f.raf) return;
    const frame = () => {
      f.raf = 0;
      if (field !== f || !f.el.isConnected) return stopField();
      const moved = stepField(f);
      drawField(f);
      if (f.drag || moved > 0.3) f.raf = globalThis.requestAnimationFrame(frame);
    };
    f.raf = globalThis.requestAnimationFrame(frame);
  }

  function selectBubble(i) {
    const f = field;
    if (!f) return;
    f.nodes.forEach(n => n.b.classList.toggle('is-selected', n.i === i));
    const detail = $('pro-bubble-detail');
    if (detail) detail.innerHTML = bubbleDetail(f.v.items[i]);
  }

  function bindField(el) {
    el.dataset.bound = '1';
    el.addEventListener('pointerdown', event => {
      const b = event.target.closest?.('.pro-bubble');
      const node = b && field?.nodes.find(n => n.b === b);
      if (!node || event.button > 0) return;
      const rect = el.getBoundingClientRect();
      field.drag = { node, ox: event.clientX - rect.left - node.x, oy: event.clientY - rect.top - node.y, sx: event.clientX, sy: event.clientY, moved: false };
      b.setPointerCapture?.(event.pointerId);
      b.classList.add('is-dragging');
      kickField();
    });
    el.addEventListener('pointermove', event => {
      const drag = field?.drag;
      if (!drag) return;
      const rect = el.getBoundingClientRect(), n = drag.node;
      const x = event.clientX - rect.left - drag.ox, y = event.clientY - rect.top - drag.oy;
      n.vx = x - n.x; n.vy = y - n.y; n.x = x; n.y = y;
      if (Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) > 4) drag.moved = true;
      kickField();
    });
    const release = () => {
      const drag = field?.drag;
      if (!drag) return;
      drag.node.b.classList.remove('is-dragging');
      field.drag = null;
      field.dragged = drag.moved;
      kickField();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('click', event => {
      const b = event.target.closest?.('.pro-bubble');
      if (!b || !field) return;
      if (field.dragged) { field.dragged = false; return; }
      selectBubble(Number(b.dataset.bubble));
    });
  }

  function compassReadings(mf) {
    const { money, esc } = pro().format;
    const momentum = c => c.momentum
      ? `${arrow(c.momentum.change)}<small>${c.momentum.basis === 'year-over-year' ? 'vs same months last year' : 'per month, 6 months'}${c.momentum.confirmed === false && c.momentum.change > 0.1 ? ' &middot; not confirmed by recent trend' : ''}</small>`
      : `<span class="pro-move is-flat">&mdash;</span><small>${c.seasonal ? 'seasonal: needs 15 months' : 'needs 6 months'}</small>`;
    const cross = c => !c.crossover ? '&mdash;'
      : `${money(c.crossover.fast, true)} / ${money(c.crossover.slow, true)}<small>${c.crossover.crossed === 'up' ? '<span class="pro-move is-bad">crossed above</span>' : c.crossover.crossed === 'down' ? '<span class="pro-move is-good">crossed below</span>' : c.crossover.state === 'above' ? 'fast above slow' : c.crossover.state === 'below' ? 'fast below slow' : 'flat'}${c.crossover.seasonal ? ' &middot; seasonal' : ''}</small>`;
    const band = c => !c.band ? '&mdash;'
      : `<span class="pro-signal ${c.band.position === 'above' ? 'is-above' : c.band.position === 'below' ? 'is-below' : 'is-inline'}">${c.band.position === 'inside' ? 'Normal' : c.band.position === 'above' ? 'Breakout' : 'Unusually low'}</span><small>${esc(c.band.month)}: ${money(c.band.latest, true)} (${money(c.band.lower, true)}&ndash;${money(c.band.upper, true)})</small>`;
    const driver = c => !c.driver ? '&mdash;'
      : `${c.driver.visitsNow.toFixed(1)} &times; ${money(c.driver.ticketNow, true)}<small>was ${c.driver.visitsThen.toFixed(1)} &times; ${money(c.driver.ticketThen, true)}</small>`;
    const rows = mf.categories.map(c => {
      const [label, cls] = MF_STATUS[c.benchmarkStatus] || ['&mdash;', 'is-inline'];
      return `<tr><th scope="row"><span>${esc(c.label)}</span><small>${esc(c.covers)}</small></th>
        <td class="num"><strong>${money(c.average3, true)}</strong><small>3-month average</small></td>
        <td class="num">${money(c.expected, true)}<small>${c.vsTypical == null ? '' : `${c.vsTypical >= 0 ? '+' : ''}${Math.round(c.vsTypical * 100)}%`}</small></td>
        <td class="num"><span class="pro-signal ${cls}">${label}</span></td>
        <td class="num">${momentum(c)}</td><td class="num">${cross(c)}</td><td class="num">${band(c)}</td>
        <td class="num">${c.upMonths} of ${c.upWindow}<small>months up</small></td><td class="num">${driver(c)}</td></tr>`;
    }).join('');
    const table = `<div class="table-scroll"><table class="pro-table pro-mf-table"><thead><tr><th scope="col">Category</th><th scope="col" class="num">You</th><th scope="col" class="num">Typical</th><th scope="col" class="num">Compared</th><th scope="col" class="num">Momentum</th><th scope="col" class="num">3-mo / ${mf.categories[0]?.crossover?.slowMonths || 12}-mo avg</th><th scope="col" class="num">Band</th><th scope="col" class="num">Breadth</th><th scope="col" class="num">Purchases &times; size</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const oneOffs = mf.categories.flatMap(c => c.oneOffs.map(o => ({ ...o, label: c.label })));
    const oneOffNote = oneOffs.length ? `<p class="pro-footnote">Set aside as one-off purchases: ${oneOffs.slice(0, 5).map(o => `${esc(o.description)} ${money(o.amount, true)} (${dateShort(o.date)}, ${esc(o.label)})`).join('; ')}${oneOffs.length > 5 ? ` and ${oneOffs.length - 5} more` : ''}.</p>` : '';
    return `<details class="pro-mf-details panel"><summary><span>Technical readings</span><small>Moving averages, momentum, volatility bands and breadth for each category</small></summary>
      <div class="pro-mf-details-body"><p class="pro-footnote">${MF_HOW}</p>${table}${oneOffNote}</div></details>`;
  }

  function compassPage(a) {
    const { esc } = pro().format;
    const mf = a.moneyFlow;
    if (!mf) return '<p class="pro-empty panel">The Spending Compass is not available yet. Try again in a moment.</p>';
    const source = `<p class="pro-footnote">Similar-household figures: <a href="${esc(mf.source.url)}" target="_blank" rel="noopener noreferrer">${esc(mf.source.label)}</a>, in ${mf.source.year} dollars. No other MyFinance user's data is used. Mortgage, rent, loans, insurance and internet are not compared because they are contracted bills. Survey figures are a guide, not a rule, and this is not financial advice.</p>`;
    if (mf.status !== 'ok' || !mf.categories.length) return `<div class="pro-compass">${compassHero(mf)}${source}</div>`;
    return `<div class="pro-compass">${compassHero(mf)}${compassInsights(mf)}
      <div class="pro-grid pro-compass-grid">${flowSankey(mf)}${signalVenn(mf)}${vendorField(mf)}${spendHeatmap(mf)}${rangeStrips(mf)}</div>
      ${compassReadings(mf)}${source}</div>`;
  }

  const HEADERS = {
    overview: ['MYFINANCE PRO &middot; ANALYTICS', 'Your spending, like a market', 'Trends, moving averages, forecasts and signals across every category, so you can act before the month gets away from you.'],
    compass: ['MYFINANCE PRO &middot; SPENDING COMPASS', 'Spending Compass', 'How your everyday spending compares with similar households, which way each category is heading, and where you could realistically save.']
  };

  function renderHeader() {
    const [eyebrow, heading, intro] = HEADERS[tab];
    if ($('analytics-eyebrow')) $('analytics-eyebrow').innerHTML = eyebrow;
    if ($('analytics-heading')) $('analytics-heading').textContent = heading;
    if ($('analytics-intro')) $('analytics-intro').textContent = intro;
  }

  function tabs(a) {
    const { money } = pro().format;
    const found = a?.moneyFlow?.potentialMonthly;
    const link = (id, route, label, extra = '') => `<a href="#${route}" data-view="${route}" class="pro-tab${tab === id ? ' is-active' : ''}"${tab === id ? ' aria-current="page"' : ''}>${label}${extra}</a>`;
    const help = tab === 'compass' ? '<a class="pro-tab-help" href="#tutorials/compass">&#9654; How it works</a>' : '';
    return `<nav class="pro-tabs" aria-label="Analytics pages">${link('overview', 'analytics', 'Overview')}${link('compass', 'analytics/compass', 'Spending Compass', found > 0 ? `<span class="pro-tab-badge">${money(found, true)}/mo</span>` : '')}${help}</nav>`;
  }

  function render(a) {
    const { esc } = pro().format;
    if (tab === 'compass') {
      $('analytics-content').innerHTML = `${tabs(a)}${compassPage(a)}`;
      mountBubbles(a.moneyFlow?.vendors);
      return;
    }
    stopField();
    const thin = a.monthsOfHistory < 3 ? '<p class="pro-banner">Insights sharpen with history. Import at least 3 months of statements for reliable moving averages and signals.</p>' : '';
    const footnote = `<p class="pro-footnote">As of ${dateShort(a.asOf)}. Spending excludes transfers between your own accounts${a.excludedCategories?.length ? ` (${a.excludedCategories.map(esc).join(', ')})` : ''}. Projections are estimates based on your history, not financial advice.</p>`;
    $('analytics-content').innerHTML = `${tabs(a)}${thin}${kpis(a)}<div class="pro-grid">${forecastCard(a)}${cashflowCard(a)}${trendCard(a)}${recurringCard(a)}${signalsTable(a)}${anomaliesCard(a)}${merchantsCard(a)}${weekdayCard(a)}</div>${footnote}`;
  }

  // `sub` comes from the route (#analytics or #analytics/compass); reloads after a save keep the current tab.
  globalThis.loadAnalyticsPage = async function(force = false, sub) {
    const content = $('analytics-content');
    if (!content || !pro()) return;
    if (sub !== undefined) tab = sub === 'compass' ? 'compass' : 'overview';
    renderHeader();
    const run = ++request;
    content.innerHTML = '<div class="pro-loading"><span></span><span></span><span></span></div>';
    const entitlement = await pro().ensureEntitlement();
    if (run !== request) return;
    renderActions();
    if (!entitlement.active) { content.innerHTML = lockedPreview(entitlement); return; }
    try {
      current = await pro().getAnalytics(force);
      if (run === request) render(current);
    } catch (error) {
      if (run !== request) return;
      if (error.code === 'PRO_REQUIRED') return globalThis.loadAnalyticsPage();
      content.innerHTML = `<div class="pro-empty panel">Could not load analytics: ${pro().format.esc(error.message)} <button type="button" class="btn btn-secondary btn-compact" data-analytics-action="retry">Try again</button></div>`;
    }
  };

  async function saveHousehold(button) {
    const form = $('pro-mf-household');
    if (!form) return;
    const value = name => form.querySelector(`[name="${name}"]`)?.value || null;
    button.disabled = true;
    try {
      await pro().request('/api/analytics/household', { method: 'PUT', body: JSON.stringify({ size: value('size') ? Number(value('size')) : null, region: value('region'), housing: value('housing') }) });
      pro().invalidateAnalytics();
      await globalThis.loadAnalyticsPage(true);
    } catch (error) {
      button.disabled = false;
      globalThis.alert?.(`Could not save your household: ${error.message}`);
    }
  }

  async function markFixed(button) {
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await pro().request('/api/transactions/update-fixed', { method: 'POST', body: JSON.stringify({ id: Number(button.dataset.id), is_fixed: true, apply_to_all: true }) });
      pro().invalidateAnalytics();
      await globalThis.loadAnalyticsPage(true);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Mark fixed';
      globalThis.alert?.(`Could not mark ${button.dataset.merchant || 'this charge'} as fixed: ${error.message}`);
    }
  }

  document.addEventListener('click', event => {
    const target = event.target?.closest?.('#analytics-view [data-analytics-action], #analytics-view [data-sort], #analytics-view [data-open], #analytics-view [data-bubble-size], #analytics-view [data-bubble-color]');
    if (!target || !pro()) return;
    if (target.dataset.bubbleSize || target.dataset.bubbleColor) {
      if (target.dataset.bubbleSize) bubbleSize = target.dataset.bubbleSize;
      if (target.dataset.bubbleColor) bubbleColor = target.dataset.bubbleColor;
      target.parentElement?.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === target)));
      return mountBubbles(current?.moneyFlow?.vendors);
    }
    if (target.dataset.sort) {
      sortDir = sortKey === target.dataset.sort ? -sortDir : target.dataset.sort === 'name' ? 1 : -1;
      sortKey = target.dataset.sort;
      if (current) render(current);
      return;
    }
    if (target.dataset.open) {
      const now = new Date();
      return globalThis.openCategoryTransactions?.(target.dataset.open, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
    }
    const action = target.dataset.analyticsAction;
    if (action === 'retry') return globalThis.loadAnalyticsPage(true);
    if (action === 'upgrade') return pro().openUpgrade();
    if (action === 'budgets') return pro().openBudgets();
    if (action === 'mark-fixed') return markFixed(target);
    if (action === 'household-edit' || action === 'household-cancel') {
      const form = $('pro-mf-household');
      if (form) form.hidden = action === 'household-cancel';
      return;
    }
    if (action === 'household-save') return saveHousehold(target);
    if (!pro().requirePro('CSV export is part of MyFinance Pro.')) return;
    if (action === 'export-transactions') location.href = '/api/analytics/export.csv?type=transactions';
    if (action === 'export-categories') location.href = '/api/analytics/export.csv?type=categories';
  });
})();
