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

  function compassReadings(mf) {
    const { money, esc } = pro().format;
    const momentum = c => c.momentum
      ? `${arrow(c.momentum.change)}<small>${c.momentum.basis === 'year-over-year' ? 'vs same months last year' : 'per month, 6 months'}${c.momentum.confirmed === false && c.momentum.change > 0.1 ? ' &middot; not confirmed by recent trend' : ''}</small>`
      : `<span class="pro-move is-flat">&mdash;</span><small>${c.seasonal ? 'seasonal: needs 15 months' : 'needs 6 months'}</small>`;
    const cross = c => !c.crossover ? '&mdash;'
      : `${money(c.crossover.fast, true)} / ${money(c.crossover.slow, true)}<small>${c.crossover.crossed === 'up' ? '<span class="pro-move is-bad">crossed above</span>' : c.crossover.crossed === 'down' ? '<span class="pro-move is-good">crossed below</span>' : c.crossover.state === 'above' ? 'fast above slow' : c.crossover.state === 'below' ? 'fast below slow' : 'flat'}${c.crossover.seasonal ? ' &middot; seasonal' : ''}</small>`;
    const band = c => !c.band ? '&mdash;'
      : `<span class="pro-signal ${c.band.position === 'above' ? 'is-above' : c.band.position === 'below' ? 'is-below' : 'is-inline'}">${c.band.position === 'inside' ? 'Normal' : c.band.position === 'above' ? 'Breakout' : 'Unusually low'}</span><small>${esc(c.band.month)}: ${money(c.band.latest, true)} (${money(c.band.lower, true)}&ndash;${money(c.band.upper, true)})</small>`;
    const rows = mf.categories.map(c => {
      const [label, cls] = MF_STATUS[c.benchmarkStatus] || ['&mdash;', 'is-inline'];
      return `<tr><th scope="row"><span>${esc(c.label)}</span><small>${esc(c.covers)}</small></th>
        <td class="num"><strong>${money(c.average3, true)}</strong><small>3-month average</small></td>
        <td class="num">${money(c.expected, true)}<small>${c.vsTypical == null ? '' : `${c.vsTypical >= 0 ? '+' : ''}${Math.round(c.vsTypical * 100)}%`}</small></td>
        <td class="num"><span class="pro-signal ${cls}">${label}</span></td>
        <td class="num">${momentum(c)}</td><td class="num">${cross(c)}</td><td class="num">${band(c)}</td>
        <td class="num">${c.upMonths} of ${c.upWindow}<small>months up</small></td></tr>`;
    }).join('');
    const table = `<div class="table-scroll"><table class="pro-table pro-mf-table"><thead><tr><th scope="col">Category</th><th scope="col" class="num">You</th><th scope="col" class="num">Typical</th><th scope="col" class="num">Compared</th><th scope="col" class="num">Momentum</th><th scope="col" class="num">3-mo / ${mf.categories[0]?.crossover?.slowMonths || 12}-mo avg</th><th scope="col" class="num">Band</th><th scope="col" class="num">Breadth</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const oneOffs = mf.categories.flatMap(c => c.oneOffs.map(o => ({ ...o, label: c.label })));
    const oneOffNote = oneOffs.length ? `<p class="pro-footnote">Set aside as one-off purchases: ${oneOffs.slice(0, 5).map(o => `${esc(o.description)} ${money(o.amount, true)} (${dateShort(o.date)}, ${esc(o.label)})`).join('; ')}${oneOffs.length > 5 ? ` and ${oneOffs.length - 5} more` : ''}.</p>` : '';
    return card(`Category readings${how(MF_HOW)}`, 'Each category read like a price chart: where it sits against typical, which way it is moving and whether this month broke out of its normal range', `${table}${oneOffNote}`);
  }

  function compassPage(a) {
    const { money, esc } = pro().format;
    const mf = a.moneyFlow;
    if (!mf) return '<p class="pro-empty panel">The Spending Compass is not available yet. Try again in a moment.</p>';
    const comparison = card('Your comparison', `Compared with ${esc(mf.comparedWith)}`,
      `<div class="pro-mf-household">${householdChips(mf)}</div>
      <button type="button" class="btn btn-secondary btn-compact" data-analytics-action="household-edit">${mf.profileSet ? 'Edit household' : 'Set your household'}</button>${householdForm(mf)}
      ${mf.profileSet ? '' : '<p class="pro-mf-hint">Add your household size, region and whether you rent or own for a fair comparison. Until then you are compared with the average U.S. household.</p>'}
      <p class="pro-footnote">Typical spending: <a href="${esc(mf.source.url)}" target="_blank" rel="noopener noreferrer">${esc(mf.source.label)}</a>, in ${mf.source.year} dollars. No other MyFinance user's data is used.</p>`);
    if (mf.status !== 'ok' || !mf.categories.length) {
      return `<div class="pro-compass"><div class="pro-compass-top">${card('Where you could save', '', '<p class="pro-empty">Import at least 3 full months of spending in standard categories (groceries, dining, utilities, gas, shopping, entertainment, healthcare) to see your compass.</p>')}${comparison}</div></div>`;
    }
    const opps = mf.opportunities.map(o => `<li><div><strong>${esc(o.label)}</strong><p>${esc(o.message)}</p></div><div class="num"><strong class="is-good">${money(o.monthly, true)}</strong><small>a month</small></div></li>`).join('');
    const savings = mf.opportunities.length
      ? `<div class="pro-mf-total"><span>Realistic savings found</span><strong>${money(mf.potentialMonthly, true)} a month</strong><small>${money(mf.potentialAnnual, true)} a year, using levels you have already reached</small></div><ol class="pro-mf-opps">${opps}</ol>`
      : `<p class="pro-empty is-good">${pro().ICONS.check} No category is both above typical and rising. Nothing to cut right now.</p>`;
    return `<div class="pro-compass"><div class="pro-compass-top">${card('Where you could save', 'Categories that are above similar households or trending up, with a target you have already hit', savings)}${comparison}</div>${compassReadings(mf)}</div>
      <p class="pro-footnote">Mortgage, rent, loans, insurance and internet are left out because they are contracted bills. Survey figures are a guide, not a rule, and this is not financial advice.</p>`;
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
    return `<nav class="pro-tabs" aria-label="Analytics pages">${link('overview', 'analytics', 'Overview')}${link('compass', 'analytics/compass', 'Spending Compass', found > 0 ? `<span class="pro-tab-badge">${money(found, true)}/mo</span>` : '')}</nav>`;
  }

  function render(a) {
    const { esc } = pro().format;
    if (tab === 'compass') {
      $('analytics-content').innerHTML = `${tabs(a)}${compassPage(a)}`;
      return;
    }
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
    const target = event.target?.closest?.('#analytics-view [data-analytics-action], #analytics-view [data-sort], #analytics-view [data-open]');
    if (!target || !pro()) return;
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