// MyFinance Pro analytics: the Overview tab (KPIs, forecast, cash flow, trends, category signals, recurring charges and more)
// and the Spending Compass tab (household benchmarks and chart-style signals with realistic savings).
(() => {
  const $ = id => document.getElementById(id);
  let request = 0, sortKey = 'mtd', sortDir = -1, current = null, tab = 'overview';
  const recurringFilters = { status: 'active', kind: 'all', search: '' };
  let compassPeriod = null;
  const panelFlow = () => compassPeriod?.data || current?.moneyFlow;
  const monthKey = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
  const lastCompleteMonth = () => { const d = new Date(); return d.getFullYear() * 12 + d.getMonth() - 1; };
  function rangeControls() {
    const { esc } = pro().format;
    const state = compassPeriod;
    const end = lastCompleteMonth();
    const preset = state?.preset || '3';
    const option = (value, label) => `<option value="${value}"${preset === value ? ' selected' : ''}>${label}</option>`;
    return `<form class="compass-range" data-compass-range="all" aria-label="Spending Compass date range">
      <label>Time period<select name="preset">${window.monthRangePresets.map(({ months, label }) => option(String(months), label)).join('')}${option('custom', 'Choose months…')}</select></label>
      <label${preset === 'custom' ? '' : ' hidden'}>Start month<input type="month" name="from" required min="1900-01" max="${monthKey(end)}" value="${esc(state?.from || monthKey(end - 2))}"></label>
      <label${preset === 'custom' ? '' : ' hidden'}>End month<input type="month" name="to" required min="1900-01" max="${monthKey(end)}" value="${esc(state?.to || monthKey(end))}"></label>
      <button type="submit" class="btn btn-secondary btn-compact">Apply</button>
      <p class="compass-range-status" role="status">${state?.error ? esc(state.error) : state?.loading ? 'Updating all Compass sections…' : state?.data ? `${esc(state.from)} through ${esc(state.to)} · ${state.data.monthsAnalyzed} of ${state.data.range.months} completed months available. Missing statements can understate totals.` : 'Last 3 completed months · missing statements can understate totals.'} This period controls every section on Spending Compass.</p></form>`;
  }
  function compassPanel(key, title, renderer, base) {
    const finish = globalThis.FinancePerformance?.begin('cpu', `compass.${key}`);
    const state = compassPeriod;
    const mf = state?.data || base;
    const body = state && !state.data ? `<p class="pro-empty panel">${pro().format.esc(state.error || 'Loading the selected history…')}</p>`
      : ['signals', 'range', 'readings'].includes(key) && !mf.categories.length ? '' : renderer(mf);
    const html = `<section class="compass-panel span-3" data-compass-panel="${key}" aria-label="${title}">${body || '<p class="pro-empty panel">Not enough imported activity for this panel in the selected period.</p>'}</section>`;
    finish?.();
    return html;
  }
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
  const scrollRegion = (label, body, className = 'table-scroll') => `<p class="pro-scroll-hint">Swipe sideways to explore the full ${label.toLowerCase()}.</p><div class="${className}" role="region" aria-label="${label}" tabindex="0">${body}</div>`;
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
    const lock = pro().isPlusActive() ? '' : ICONS.lock;
    actions.innerHTML = `<button type="button" class="btn btn-secondary" data-analytics-action="budgets">${lock || ICONS.budgets}Budgets</button>
      <button type="button" class="btn btn-secondary" data-analytics-action="export-categories">${lock || ICONS.export}Category report</button>
      <button type="button" class="btn btn-primary" data-analytics-action="export-transactions">${lock || ICONS.export}Export transactions</button>`;
  }

  function lockedPreview(entitlement) {
    const { ICONS, format: { esc } } = pro();
    const { bars, sparkline } = charts();
    const demo = [1820, 2140, 1960, 2310, 2050, 2480, 2290, 2620, 2410, 2380, 2710, 2560];
    const label = entitlement.trialAvailable ? 'Explore the 15-day Pro trial' : 'See plans';
    const features = (entitlement.features || []).map(f => `<li>${ICONS[f.id] || ICONS.spark}<span><strong>${esc(f.title)}</strong>${esc(f.text)}</span></li>`).join('');
    return `<div class="pro-locked">
      <div class="pro-locked-preview" aria-hidden="true">
        <div class="pro-kpis">${['Spent this month', 'Projected month-end', 'Savings rate', 'Daily burn'].map((t, i) => `<div class="pro-kpi"><span>${t}</span><strong>${['$2,184', '$2,730', '18%', '$73'][i]}</strong>${sparkline(demo.slice(i, i + 8))}</div>`).join('')}</div>
        <div class="pro-grid">${card('Monthly spend', '', bars({ labels: 'JFMAMJJASOND'.split(''), values: demo, lines: [{ values: demo.map((_, i) => i < 2 ? null : (demo[i] + demo[i - 1] + demo[i - 2]) / 3), className: 'sma' }] }))}${card('Category signals', '', '<div class="pro-skeleton"></div><div class="pro-skeleton"></div><div class="pro-skeleton"></div>')}</div>
      </div>
      <div class="pro-locked-cta panel">
        <span class="pro-hero-mark">${ICONS.lock}</span>
        <p class="eyebrow">MYFINANCE PRO &middot; USD 14.99/MONTH PER HOUSEHOLD</p>
        <h2>${entitlement.trialEndsAt && !entitlement.active ? 'Your Pro trial has ended' : 'Unlock the full picture'}</h2>
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
      ${scrollRegion('Month-end forecast chart', plot({ series: [{ points: last, className: 'muted-line' }, { points: current, className: 'primary', area: true, dot: true }, { points: projection, className: 'primary', dashed: true }], xMax, xTicks: ticks, label: 'Month-end forecast' }), 'pro-chart-scroll')}
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
    const body = `${scrollRegion('Projected balance chart', plot({ series: [{ points, className: end >= c.startBalance ? 'primary' : 'danger', area: true, dot: true }], xMax: c.months.length, xTicks: ticks, width: 380, height: 220, label: 'Projected balance' }), 'pro-chart-scroll')}
      <div class="pro-mini-stats"><div><span>Balance today</span><strong>${money(c.startBalance, true)}</strong></div><div><span>In 6 months</span><strong class="${end < 0 ? 'is-bad' : ''}">${money(end, true)}</strong></div><div><span>${c.basis === 'typical-surplus' ? 'Typical surplus' : 'Net / month'}${netNote}</span><strong class="${net < 0 ? 'is-bad' : 'is-good'}">${net >= 0 ? '+' : ''}${money(net, true)}</strong></div><div><span>Lowest point</span><strong class="${low < 0 ? 'is-bad' : ''}">${money(low, true)}</strong></div></div>`;
    return card('6-month cash flow', 'Projected balance if your typical surplus continues each month', body);
  }

  function trendCard(a) {
    const s = a.series, { bars, monthShort } = charts();
    const sma3 = s.spend.map((_, i) => i < 2 ? null : (s.spend[i] + s.spend[i - 1] + s.spend[i - 2]) / 3);
    const body = `${scrollRegion('Monthly spending chart', bars({ labels: a.months.map(monthShort), values: s.spend, lines: [{ values: sma3, className: 'sma' }, { values: s.income, className: 'income' }], label: 'Monthly spending' }), 'pro-chart-scroll')}
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
      rows.length ? scrollRegion('Category signals table', `<table class="pro-table" id="pro-signals-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`) : '<p class="pro-empty">Import a few months of transactions to see category signals.</p>', 'span-3');
  }

  function recurringCard(a) {
    const { money, esc } = pro().format;
    const all = a.recurring || [];
    const unmarked = all.filter(s => !s.fixed);
    const fixedCount = all.filter(s => s.fixed && s.active).length;
    const active = unmarked.filter(s => s.active);
    const monthly = active.reduce((sum, s) => sum + s.monthlyCost, 0);
    const increases = active.filter(s => s.priceChangePct > 0.02);
    const shown = unmarked.filter(s => (recurringFilters.status === 'all' || (recurringFilters.status === 'active' ? s.active : !s.active))
      && (recurringFilters.kind === 'all' || (recurringFilters.kind === 'bill' ? s.likelyBill : !s.likelyBill))
      && `${s.merchant} ${s.category}`.toLowerCase().includes(recurringFilters.search.trim().toLowerCase()));
    const list = shown.map(s => `<li class="${s.active ? '' : 'is-inactive'}"><div><strong>${esc(s.merchant)}</strong><small>${esc(s.cadence)} &middot; ${esc(s.category)} &middot; ${s.active ? `next ${dateShort(s.nextDate)}` : 'stopped'}${s.likelyBill ? ' &middot; looks like a bill' : ''}</small></div>
      <div class="num"><strong>${money(s.amount)}</strong>${s.priceChangePct > 0.02 ? `<small class="pro-move is-bad">▲ ${Math.round(s.priceChangePct * 100)}% price increase</small>` : `<small>${money(s.annualCost, true)} / yr</small>`}${s.active && s.id != null ? `<button type="button" class="btn btn-secondary btn-compact" data-analytics-action="mark-fixed" data-id="${esc(s.id)}" data-merchant="${esc(s.merchant)}" title="Mark every ${esc(s.merchant)} charge as a fixed payment, including future imports">Mark fixed</button>` : ''}</div></li>`).join('');
    const note = fixedCount ? `<p class="muted">${fixedCount} other recurring payment${fixedCount === 1 ? ' is' : 's are'} already marked fixed and on your bill calendar.</p>` : '';
    const option = (value, label, selected) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
    const body = `<p class="eyebrow">SPOT THE REPEAT · BUILD YOUR BILL CALENDAR</p><div class="pro-mini-stats"><div><span>Not marked fixed${how('Charges from the same merchant at a steady price on a regular schedule (weekly, monthly, quarterly or yearly) where none of the charges is marked as a fixed payment. Groceries, gas, dining, shopping and transfers between your own accounts are left out. Mark real bills as fixed so they appear on your bill calendar and month-end forecast; review the rest and cancel what you no longer use.')}</span><strong>${active.length}</strong></div><div><span>Per month</span><strong>${money(monthly, true)}</strong></div><div><span>Per year</span><strong>${money(monthly * 12, true)}</strong></div><div><span>Price increases</span><strong class="${increases.length ? 'is-bad' : ''}">${increases.length}</strong></div></div>
      <p class="recurring-scope">Totals cover all active candidates, regardless of the filters below. Stopped payments are historical patterns, not upcoming bills.</p>
      <div class="recurring-filters"><label>Payment status<select data-recurring-filter="status">${option('active', 'Active payments', recurringFilters.status)}${option('stopped', 'Stopped patterns', recurringFilters.status)}${option('all', 'All patterns', recurringFilters.status)}</select></label>
        <label>Payment type<select data-recurring-filter="kind">${option('all', 'All types', recurringFilters.kind)}${option('bill', 'Likely bills', recurringFilters.kind)}${option('other', 'Other recurring charges', recurringFilters.kind)}</select></label>
        <label class="recurring-search">Find a payment<input type="search" data-recurring-filter="search" placeholder="Merchant or category" value="${esc(recurringFilters.search)}"></label></div>
      <p class="recurring-count" role="status">${shown.length} of ${unmarked.length} unmarked patterns shown · no list cutoff</p>
      ${list ? `<ul class="pro-list is-scroll recurring-candidates">${list}</ul>` : `<p class="pro-empty">${unmarked.length ? 'No payments match these filters. Try All patterns or a different search.' : all.length ? 'Every recurring charge is already marked fixed.' : 'No recurring charges detected yet.'}</p>`}${note}`;
    return `<section id="recurring-payment-card" aria-label="Recurring payment candidates">${card('Recurring charges not marked fixed', 'A familiar rhythm? Turn real recurring bills into fixed payments, so your calendar can do the remembering.', body, 'recurring-discovery')}</section>`;
  }

  function anomaliesCard(a) {
    const { money, esc } = pro().format;
    const ratio = x => x.ratio == null ? `Above the usual ${money(x.typical, true)}` : `${x.ratio.toFixed(1)}&times; the usual ${money(x.typical, true)}`;
    const list = a.anomalies.slice(0, 8).map(x => x.type === 'charge'
      ? `<li><div><strong>${window.transactionLink(x.id, x.merchant)}</strong><small>${dateShort(x.date)} &middot; ${esc(x.category)}</small></div><div class="num"><strong>${money(x.amount)}</strong><small class="pro-move is-bad">${x.ratio.toFixed(1)}&times; the usual ${money(x.typical, true)}</small></div></li>`
      : `<li><div><strong>${esc(x.category)}</strong><small>Category on pace for an unusual month</small></div><div class="num"><strong>${money(x.amount, true)}</strong><small class="pro-move is-bad">${ratio(x)}</small></div></li>`).join('');
    return card('Unusual activity', 'Charges and categories well outside your normal pattern', list ? `<ul class="pro-list is-wrap">${list}</ul>` : `<p class="pro-empty is-good">${pro().ICONS.check} Nothing unusual. Your spending is within its normal range.</p>`);
  }

  function merchantsCard(a) {
    const { money, pct } = pro().format;
    const items = a.merchants.map(m => ({
      name: m.merchant, value: m.total,
      detail: `${m.count} payments; average ${money(m.average)}; ${pct(m.share)} of all spending${m.change == null ? '' : `; ${Math.abs(m.change * 100).toFixed(0)}% ${m.change >= 0 ? 'more' : 'less'} than the previous period`}`
    }));
    return card(`Top merchants${how('Last 90 days. Larger tiles mean more money out, not more transactions.')}`, '',
      globalThis.FinanceMoneyVisuals.mosaic(items), 'pro-merchants');
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
        <p class="pro-hero-sub">This view needs at least 3 full months of spending in standard categories (groceries, dining, utilities, gas, shopping, entertainment, healthcare). Try a wider period or import more statements.</p>${household}</div></section>`;
    }
    const plan = mf.opportunities.length
      ? `<ol class="pro-hero-plan">${mf.opportunities.map(o => {
        const c = mf.categories.find(row => row.id === o.id);
        return `<li><span><b>${esc(shortLabel(o.label))}</b><small>${money(c?.average3 ?? o.target + o.monthly, true)} &rarr; ${money(o.target, true)} a month</small></span><strong>${money(o.monthly, true)}<small>/mo</small></strong></li>`;
      }).join('')}</ol>`
      : `<p class="pro-hero-clear">${pro().ICONS.check} No supported savings target found in the selected history. This does not mean every expense is necessary or affordable.</p>`;
    const figure = mf.opportunities.length ? `${money(mf.potentialMonthly, true)} a month` : 'On course';
    const sub = mf.opportunities.length
      ? `${money(mf.potentialAnnual, true)} a year &middot; ${money(mf.potentialAnnual * 5, true)} over 5 years, by returning to levels you have already reached.`
      : 'No category meets the evidence and minimum-savings criteria for this estimate.';
    return `<section class="pro-compass-hero panel"><div class="pro-hero-main"><p class="pro-hero-eyebrow">YOUR COMPASS FOUND</p><strong class="pro-hero-figure">${figure}</strong><p class="pro-hero-sub">${sub}</p>${household}</div>
      <div class="pro-hero-side"><p class="pro-hero-eyebrow">YOUR PLAN</p>${plan}</div></section>`;
  }

  function compassInsights(mf) {
    const { esc } = pro().format;
    if (!mf.insights?.length) return '';
    return `<section class="pro-insights" aria-label="What stood out">${mf.insights.map(i => `<article class="pro-insight tone-${esc(i.tone)}" data-insight="${esc(i.id)}">
      <strong>${esc(i.figure)}</strong><h3>${esc(i.title)}</h3><p>${esc(i.detail)}</p></article>`).join('')}</section>`;
  }

  // Sankey diagram: income on the left, fixed / discretionary / debt payments / left over in the middle, categories on the right.
  function flowSankey(mf) {
    const { money, esc } = pro().format;
    const f = mf.flow;
    if (!f || !(f.income > 0)) return card('Where your money flows', '', '<p class="pro-empty">Import a few months of income and spending to see where your money goes.</p>');
    const byId = new Map(mf.categories.map(c => [c.id, c]));
    // Income and the four groups are labelled blocks; categories are thin bars with labels that never collide.
    const W = 960, TOP = 30, BASE_H = 380, SRC_W = 132, MID_X = 340, MID_W = 168, DST_X = 720, DST_W = 10;
    const GAP = 16, MIN_BLOCK = 50, SLOT = 22, CHILD_GAP = 6, GROUP_GAP = 16, INCOME = '#059669';
    const shortfall = Math.max(0, -f.left);
    const middle = [
      { key: 'fixed', label: 'Fixed expenses', value: f.fixed.total, color: '#3a6ea5', children: f.fixed.items },
      { key: 'discretionary', label: 'Discretionary', value: f.discretionary.total, color: '#7c3aed', children: f.discretionary.items },
      { key: 'debt', label: 'Debt payments', value: f.debt.total, color: '#c05621', children: f.debt.items },
      { key: 'left', label: 'Left over', value: Math.max(0, f.left), color: '#10b981', children: [] }
    ].filter(node => node.value > 0);
    const total = middle.reduce((s, n) => s + n.value, 0);
    const scale = (BASE_H - GAP * (middle.length - 1)) / total;
    const pct = value => `${Math.round(value / f.income * 100)}%`;
    const fx = value => value.toFixed(1);
    let defs = '', bands = '', nodes = '', labels = '', gradient = 0;
    const band = (x0, a0, a1, x2, b0, b1, from, to, title, source = '', target = '', amount = 0) => {
      const id = `pro-sk-g${gradient++}`, mx = (x0 + x2) / 2;
      defs += `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x0}" y1="0" x2="${x2}" y2="0"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
      bands += `<path class="pro-sk-band"${source ? ` data-flow-source="${source}" data-flow-target="${target}" data-flow-amount="${amount}"` : ''} d="M${x0} ${fx(a0)}C${mx} ${fx(a0)} ${mx} ${fx(b0)} ${x2} ${fx(b0)}L${x2} ${fx(b1)}C${mx} ${fx(b1)} ${mx} ${fx(a1)} ${x0} ${fx(a1)}Z" fill="url(#${id})"><title>${esc(title)}</title></path>`;
    };
    const block = (x, y, w, h, color, name, value, title) => {
      nodes += `<rect class="pro-sk-block" x="${x}" y="${fx(y)}" width="${w}" height="${fx(h)}" rx="8" fill="${color}"><title>${esc(title)}</title></rect>`;
      labels += `<text x="${x + 14}" y="${fx(y + 23)}" class="pro-sk-in">${esc(name)}</text><text x="${x + 14}" y="${fx(y + 40)}" class="pro-sk-in-sub">${value}</text>`;
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
    let y = 0, incomeSource = 0, shortfallSource = incomeH, rightY = 0;
    for (const node of middle) {
      const h = node.value * scale, bh = Math.max(h, MIN_BLOCK), inset = (bh - h) / 2;
      const name = node.title || node.label;
      // The shortfall is not tied to particular purchases; share it across groups
      // rather than implying the last group alone was funded beyond income.
      const incomeAmount = node.value * f.income / total;
      const incomePart = incomeAmount * scale;
      band(SRC_W, incomeSource, incomeSource + incomePart, MID_X, y + inset, y + inset + incomePart, INCOME, node.color,
        `Income share toward ${name}: ${money(incomeAmount, true)} a month`, 'income', node.key, incomeAmount);
      incomeSource += incomePart;
      if (shortfall > 0) {
        const shortfallAmount = node.value - incomeAmount, shortfallPart = h - incomePart;
        band(SRC_W, shortfallSource, shortfallSource + shortfallPart, MID_X, y + inset + incomePart, y + inset + h, '#e11d48', node.color,
          `Spending beyond income, proportional share of ${name}: ${money(shortfallAmount, true)} a month`, 'shortfall', node.key, shortfallAmount);
        shortfallSource += shortfallPart;
      }
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
      y += bh + GAP;
    }
    const H = Math.ceil(Math.max(y - GAP, rightY - GROUP_GAP, bottom)) + TOP + 4;
    const heads = [[0, 'MONEY IN'], [MID_X, 'WHERE IT GOES'], [DST_X, 'BY CATEGORY · SHARE OF INCOME']]
      .map(([x, text]) => `<text x="${x}" y="12" class="pro-sk-head">${text}</text>`).join('');
    const svg = `${heads}<g transform="translate(0 ${TOP})">${bands}${nodes}${labels}</g>`;
    const svgEl = `${scrollRegion('Money flow chart', `<svg class="pro-sankey" viewBox="0 0 ${W} ${H}" role="img" aria-label="Money flow: income ${money(f.income, true)} a month to fixed expenses ${money(f.fixed.total, true)}, discretionary ${money(f.discretionary.total, true)}, debt payments ${money(f.debt.total, true)} and left over ${money(f.left, true)}"><defs>${defs}</defs>${svg}</svg>`, 'pro-sankey-wrap')}<p class="pro-sk-legend"><span><i style="background:${TONE_COLORS.act}"></i>Act on it</span><span><i style="background:${TONE_COLORS.watch}"></i>Worth watching</span></p>`;
    return card(`Where your money flows${how(`Monthly average of ${mf.range ? `the available completed months from ${mf.range.from} through ${mf.range.to}` : `the last ${f.months} full month${f.months === 1 ? '' : 's'}`}. Transfers between your own accounts are left out. ${mf.range ? 'This historical view uses recorded activity only, not current debt minimums or the dashboard forecast.' : '"Left over" is the same typical monthly surplus your dashboard shows.'} Debt payments are mortgage, auto, card, student and other loan payments plus interest charges (a mortgage counts here even though it is also a fixed bill)${f.debt.unrecorded ? ', including minimums for debts you added but have not imported yet' : ''}. Fixed expenses are other payments marked as fixed; everything else is discretionary. Red and amber ribbons are categories the Compass flags.`)}`,
      '', `${shortfall > 0 ? '<p class="pro-footnote">Income and the shortfall are shared proportionally across all spending groups. This illustration does not identify which payments used savings or borrowing.</p>' : ''}${svgEl}`, 'span-3');
  }

  const SIGNAL_NAMES = { a: 'Above similar homes', b: 'Trending up', c: 'Unusual latest month' };
  function signalConnections(mf) {
    const { esc } = pro().format;
    const placed = {}, clear = [];
    for (const c of mf.categories) {
      const key = `${isAbove(c) ? 'a' : ''}${c.rising ? 'b' : ''}${isUnusual(c) ? 'c' : ''}`;
      if (!key) clear.push(shortLabel(c.label)); else (placed[key] ||= []).push(c);
    }
    const svg = globalThis.FinanceMoneyVisuals.signalNetwork(mf.categories.map(c => ({
      ...c, monthly: c.average3,
      signals: [isAbove(c) && 'a', c.rising && 'b', isUnusual(c) && 'c'].filter(Boolean)
    })), SIGNAL_NAMES, { comparedWith: mf.comparedWith, selectedRange: !!mf.range, monthsAnalyzed: mf.monthsAnalyzed });
    const groups = [3, 2, 1].map(count => ({ count, items: Object.entries(placed).filter(([key]) => key.length === count).flatMap(([key, list]) => list.map(c => ({ c, key }))) })).filter(g => g.items.length);
    const heading = { 3: ['All three signals', 'Act now', 'act'], 2: ['Two signals agree', 'Worth changing', 'act'], 1: ['One signal', 'Keep an eye on it', 'watch'] };
    const side = `<div class="pro-venn-read"><h4>Reading the overlap</h4>${groups.length ? groups.map(({ count, items }) => `<div class="pro-venn-group tone-${heading[count][2]}"><p class="pro-venn-group-head"><b>${heading[count][0]}</b><span>${heading[count][1]}</span></p><ul>${items.map(({ c, key }) => `<li><strong>${esc(shortLabel(c.label))}</strong><span>${[...key].map(k => SIGNAL_NAMES[k]).join(' + ')}</span></li>`).join('')}</ul></div>`).join('') : '<p class="pro-empty">No category shows a warning signal right now.</p>'}
      ${clear.length ? `<p class="pro-venn-clear"><b>No active warning (some readings may need more history):</b> ${clear.map(esc).join(', ')}</p>` : ''}</div>`;
    return card(`Where the signals overlap${how(`Above similar homes: your ${mf.range ? 'selected-period' : '3-month'} average is more than 10% over the U.S. Bureau of Labor Statistics figure for households like yours. Trend indicators retain their 3/6/12-month windows within the selected history. The latest selected month is compared with earlier months in that history. Short ranges may not support all signals.`)}`,
      '', `<div class="pro-signal-network">${svg}<details class="money-exact"><summary>Read every warning and remaining category</summary>${side}</details></div>`, 'span-3');
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
        <div class="pro-range-track" role="img" aria-label="${esc(c.label)}: latest selected month ${money(r.latest, true)}; your usual range ${money(r.p5, true)} to ${money(r.p95, true)}; median ${money(r.p50, true)}${c.expected ? `; similar households ${money(c.expected, true)}` : ''}">
          <span class="pro-range-band" style="left:${at(r.p5)};width:calc(${at(r.p95)} - ${at(r.p5)})"></span>
          <span class="pro-range-median" style="left:${at(r.p50)}"></span>
          ${months.map(v => `<i style="left:${at(v)}"></i>`).join('')}
          ${c.expected ? `<span class="pro-range-typical" style="left:${at(c.expected)}" title="Similar households: ${money(c.expected, true)}"></span>` : ''}
          <span class="pro-range-latest ${t}" style="left:${at(r.latest)}" title="${esc(r.month)}: ${money(r.latest, true)}"></span>
        </div>
        <div class="pro-range-note"><b class="${t}">${esc(rank)}</b><small>Usual ${money(r.p5, true)}&ndash;${money(r.p95, true)}${c.expected ? ` &middot; similar homes ${money(c.expected, true)}` : ''}</small></div></li>`;
    }).join('');
    const legend = '<div class="pro-range-legend"><span><i class="is-band"></i>Your usual range (5th&ndash;95th percentile)</span><span><i class="is-median"></i>Your median</span><span><i class="is-dot"></i>Each month</span><span><i class="is-latest"></i>Latest selected month</span><span><i class="is-typical"></i>Similar households</span></div>';
    return card(`Your normal range${how(`Each row uses ${mf.range ? 'the selected completed months' : 'the last 12 full months'} of that category, scaled to itself. The shaded bar runs from your 5th to your 95th percentile month. The diamond is what similar households spend. Large one-off purchases are set aside.`)}`,
      '', `${legend}<ul class="pro-range-list">${rows}</ul>`, 'span-3');
  }

  const compact = value => value >= 9950 ? `$${(value / 1000).toFixed(0)}k` : value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${Math.round(value)}`;

  function spendHeatmap(mf) {
    const hm = mf.heatmap;
    if (!hm?.rows?.length) return '';
    return card(`Hot and cold months${how('Recorded non-transfer spending, including fixed bills and one-off purchases. Each landscape has its own vertical scale and a dashed usual-month baseline: the median, or the mean when the median is zero. Peaks are above usual; valleys are below. Missing imports can look like low spending. Select a month or point for exact amounts and dollar/percentage differences.')}`,
      '',
      globalThis.FinanceMoneyVisuals.monthlyLandscape(hm), 'span-3');
  }

  // Merchant bubbles: size and colour switch between attributes; the field itself is a small physics simulation (mountBubbles).
  let bubbleSize = 'spend', bubbleColor = 'category', field = null;
  const CATEGORY_RGB = ['167,139,250', '56,189,248', '251,191,36', '52,211,153', '244,114,182', '251,146,60', '129,140,248', '45,212,191', '250,204,21', '248,113,113'];
  const changeText = item => item.isNew ? 'New' : item.change == null ? '' : Math.abs(item.change) < 0.05 ? 'Steady' : `${item.change > 0 ? '+' : '&minus;'}${Math.abs(item.change) > 2 ? '200%+' : `${Math.round(Math.abs(item.change) * 100)}%`}`;
  const climb = item => item.change == null ? 0 : item.monthly - item.monthly / (1 + item.change);
  const swingText = item => item.swingPct == null ? 'Needs 2 months' : `${Math.round(item.swingPct * 100)}% swing`;

  function vendorField(mf) {
    const { money, esc } = pro().format;
    const v = mf.vendors;
    if (!v?.items?.length) return '';
    const top5 = v.items.slice(0, 5).reduce((s, i) => s + (i.share || 0), 0);
    const widest = [...v.items].filter(item => item.swingPct != null).sort((a, b) => b.swingPct - a.swingPct)[0];
    const seg = (kind, value, label, active) => `<button type="button" data-bubble-${kind}="${value}" aria-pressed="${active}">${label}</button>`;
    const controls = `<div class="pro-bubble-controls">
      <div class="pro-seg" role="group" aria-label="Bubble size"><span>Size</span>${seg('size', 'spend', 'Total amount', bubbleSize === 'spend')}${seg('size', 'transactions', 'Transactions', bubbleSize === 'transactions')}</div>
      <div class="pro-seg" role="group" aria-label="Bubble colour"><span>Colour</span>${seg('color', 'category', 'Category', bubbleColor === 'category')}${seg('color', 'swing', 'Spending swing %', bubbleColor === 'swing')}${seg('color', 'change', 'Vs previous period', bubbleColor === 'change')}</div></div>`;
    const said = item => `${esc(item.name)}: ${money(item.amount)} money out, ${item.transactions} payment${item.transactions === 1 ? '' : 's'}, ${money(item.monthly)} a month; ${swingText(item)}; monthly low ${money(item.monthlyLow)}, high ${money(item.monthlyHigh)}`;
    const bubbles = v.items.map((item, i) => `<button type="button" class="pro-bubble" data-bubble="${i}" aria-label="${said(item)}"><b>${esc(item.name)}</b><small></small></button>`).join('');
    const lede = `Your top 5 merchants take <b>${Math.round(top5 * 100)}%</b> of spending.${widest && widest.swingPct > 0 ? ` Widest spending swing: <b>${esc(widest.name)}</b>, ${Math.round(widest.swingPct * 100)}% (${money(widest.monthlyLow, true)}&ndash;${money(widest.monthlyHigh, true)} per month).` : ''} Tap a bubble to see exact totals and counted transactions.`;
    const aside = `<details class="money-exact"><summary>Period and coverage</summary><p>All non-transfer payments count, including fixed bills and large purchases. Credits are shown separately, not deducted from spending. Showing ${v.items.length} of ${v.merchantCount ?? v.items.length} merchants. Compare with Transactions using these exact months; its “Last 3 months” includes the current month, while Compass uses completed months.</p></details>`;
    return card(`Who gets your money${how(`Your ${v.items.length} biggest merchants over ${v.months} completed months. All non-transfer debits count, including fixed bills and large purchases. Renamed payments with the same chosen name are combined. Credits are shown separately. Size shows total money out or actual payment count, not store visits. Category uses one colour per category. Spending swing % is (highest monthly spend minus lowest monthly spend) divided by average monthly spend across the selected period. At least 2 months are needed. Vs previous period compares monthly average spend with the preceding period (${v.compareMonths} comparison months available); red is more and green is less. Drag bubbles to rearrange them.`)}`,
      `${mf.range ? `${esc(mf.range.from)} through ${esc(mf.range.to)}` : `Last ${v.months} completed months`} &middot; ${money(v.totalAmount ?? v.total * v.months)} money out &middot; ${money(v.total)} a month`,
      `${controls}<div class="pro-bubbles" id="pro-bubbles" role="group" aria-label="Merchant bubbles">${bubbles}</div>
       <div class="pro-bubble-detail" id="pro-bubble-detail" aria-live="polite">${lede}</div><div class="pro-bubble-legend" id="pro-bubble-legend"></div>${aside}`, 'span-3');
  }

  function bubbleDetail(item) {
    const { money, esc } = pro().format;
    const change = item.isNew ? 'new in the selected period' : item.change == null ? '' : Math.abs(item.change) < 0.05 ? 'about the same as the preceding comparison period'
      : `${item.change > 0 ? 'up' : 'down'} ${money(Math.abs(climb(item)), true)} a month (${Math.abs(item.change) > 2 ? 'more than tripled' : `${Math.round(Math.abs(item.change) * 100)}%`}) on the preceding comparison period`;
    const credits = item.creditTransactions ? ` &middot; ${money(item.credits)} money in (${item.creditTransactions} credit${item.creditTransactions === 1 ? '' : 's'}) &middot; ${money(item.net)} net outflow` : '';
    const ledger = item.entries?.length ? `<details class="pro-vendor-ledger"><summary>View counted transactions (${item.entries.length})</summary><ul class="pro-list is-wrap">${item.entries.map(entry => `<li><div>${window.transactionLink(entry.id, entry.description)}<small>${esc(entry.date)} &middot; ${entry.direction === 'DEBIT' ? 'Money out' : 'Money in'}</small></div><strong>${money(entry.amount)}</strong></li>`).join('')}</ul></details>` : '';
    return `<p><b>${esc(item.name)}</b> &middot; ${esc(item.category)} &middot; <b>${money(item.amount)}</b> money out &middot; ${item.transactions} payment${item.transactions === 1 ? '' : 's'} at ${money(item.ticket)} on average${credits} &middot; ${money(item.monthly)}/month &middot; monthly low ${money(item.monthlyLow)}, high ${money(item.monthlyHigh)} &middot; ${swingText(item)}${change ? ` &middot; ${change}` : ''}${item.regular ? ' &middot; payments every month' : ''}</p>${ledger}`;
  }

  function stopField() {
    if (!field) return;
    globalThis.cancelAnimationFrame?.(field.raf);
    field.observer?.disconnect();
    field = null;
  }

  function mountBubbles(v) {
    const finish = globalThis.FinancePerformance?.begin('cpu', 'compass.bubble-layout');
    const el = $('pro-bubbles');
    if (!el?.isConnected || !v?.items?.length || typeof globalThis.requestAnimationFrame !== 'function') return stopField();
    const kept = field?.el === el ? field.nodes : null, keptW = field?.w;
    stopField();
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    const values = v.items.map(item => Math.max(bubbleSize === 'transactions' ? item.transactions : item.amount, 0.01));
    const total = values.reduce((s, x) => s + x, 0);
    const maxR = Math.min(w, h) * 0.2, minR = w < 500 ? 10 : 13;
    const categories = [...new Set(v.items.map(item => item.category))];
    const buttons = [...el.querySelectorAll('.pro-bubble')];
    const nodes = buttons.map((b, i) => {
      const item = v.items[i];
      const r = Math.min(maxR, Math.max(minR, Math.sqrt(values[i] / total * w * h * 0.5 / Math.PI)));
      let rgb = '148,163,184', k = 0.2;
      if (bubbleColor === 'category') { rgb = CATEGORY_RGB[categories.indexOf(item.category) % CATEGORY_RGB.length]; k = 0.6; }
      else if (bubbleColor === 'swing') { rgb = item.swingPct == null ? '148,163,184' : '167,139,250'; k = item.swingPct == null ? 0.2 : Math.min(1, 0.2 + item.swingPct / 2 * 0.8); }
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
      b.querySelector('small').innerHTML = bubbleColor === 'change' ? changeText(item) : bubbleColor === 'swing' ? swingText(item) : bubbleSize === 'transactions' ? `${item.transactions} txn` : compact(item.amount);
      const old = kept?.[i], angle = i * 2.4, dist = 12 * Math.sqrt(i + 1) * (w / 400);
      return { i, b, r, x: old ? old.x / (keptW || w) * w : w / 2 + Math.cos(angle) * dist, y: old ? old.y : h / 2 + Math.sin(angle) * dist * 0.6, vx: 0, vy: 0 };
    });
    const legend = $('pro-bubble-legend');
    if (legend) legend.innerHTML = bubbleColor === 'category'
      ? categories.map((c, i) => `<span><i style="--rgb:${CATEGORY_RGB[i % CATEGORY_RGB.length]}"></i>${pro().format.esc(c)}</span>`).join('')
      : bubbleColor === 'swing' ? '<span><i style="--rgb:167,139,250"></i>Deeper violet = larger high-to-low swing relative to average monthly spend (scale caps at 200%)</span><span><i style="--rgb:148,163,184"></i>Needs 2 months</span>'
      : `<span><i style="--rgb:244,63,94"></i>Higher monthly average</span><span><i style="--rgb:34,197,94"></i>Lower monthly average</span><span><i style="--rgb:56,189,248"></i>New in this period</span><span><i style="--rgb:148,163,184"></i>Steady / no comparison</span><span class="pro-bubble-note">Compared with the preceding period (${v.months} selected months; ${v.compareMonths} comparison months available). Deeper colour = larger percentage change.</span>`;
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
    finish?.();
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
        <td class="num"><strong>${money(c.average3, true)}</strong><small>${mf.range ? 'Selected-period' : '3-month'} average</small></td>
        <td class="num">${money(c.expected, true)}<small>${c.vsTypical == null ? '' : `${c.vsTypical >= 0 ? '+' : ''}${Math.round(c.vsTypical * 100)}%`}</small></td>
        <td class="num"><span class="pro-signal ${cls}">${label}</span></td>
        <td class="num">${momentum(c)}</td><td class="num">${cross(c)}</td><td class="num">${band(c)}</td>
        <td class="num">${c.upMonths} of ${c.upWindow}<small>months up</small></td><td class="num">${driver(c)}</td></tr>`;
    }).join('');
    const table = scrollRegion('Technical readings table', `<table class="pro-table pro-mf-table"><thead><tr><th scope="col">Category</th><th scope="col" class="num">You</th><th scope="col" class="num">Typical</th><th scope="col" class="num">Compared</th><th scope="col" class="num">Momentum</th><th scope="col" class="num">3-mo / ${mf.categories[0]?.crossover?.slowMonths || 12}-mo avg</th><th scope="col" class="num">Band</th><th scope="col" class="num">Breadth</th><th scope="col" class="num">Purchases &times; size</th></tr></thead><tbody>${rows}</tbody></table>`);
    const oneOffs = mf.categories.flatMap(c => c.oneOffs.map(o => ({ ...o, label: c.label })));
    const oneOffNote = oneOffs.length ? `<p class="pro-footnote">Set aside as one-off purchases: ${oneOffs.slice(0, 5).map(o => `${window.transactionLink(o.id, o.description)} ${money(o.amount, true)} (${dateShort(o.date)}, ${esc(o.label)})`).join('; ')}${oneOffs.length > 5 ? ` and ${oneOffs.length - 5} more` : ''}.</p>` : '';
    return `<details class="pro-mf-details panel"><summary><span>Technical readings</span><small>Moving averages, momentum, volatility bands and breadth for each category</small></summary>
      <div class="pro-mf-details-body"><p class="pro-footnote">${MF_HOW}</p>${table}${oneOffNote}</div></details>`;
  }

  function compassPage(a) {
    const { esc } = pro().format;
    const mf = a.moneyFlow;
    if (!mf) return '<p class="pro-empty panel">The Spending Compass is not available yet. Try again in a moment.</p>';
    const source = `<p class="pro-footnote">Similar-household figures: <a href="${esc(mf.source.url)}" target="_blank" rel="noopener noreferrer">${esc(mf.source.label)}</a>, in ${mf.source.year} dollars. No other MyFinance user's data is used. Mortgage, rent, loans, insurance and internet are not compared because they are contracted bills. Survey figures are a guide, not a rule, and this is not financial advice.</p>`;
    return `<div class="pro-compass">${rangeControls()}${compassPanel('plan', 'Compass plan and headline', m => compassHero(m) + compassInsights(m), mf)}
      <div class="pro-grid pro-compass-grid">${[
        ['flow', 'Where your money flows', flowSankey], ['signals', 'Where the signals overlap', signalConnections],
        ['vendors', 'Who gets your money', vendorField], ['heatmap', 'Hot and cold months', spendHeatmap],
        ['range', 'Your normal range', rangeStrips], ['readings', 'Technical readings', compassReadings]
      ].map(([key, title, renderer]) => compassPanel(key, title, renderer, mf)).join('')}</div>${source}</div>`;
  }

  const HEADERS = {
    overview: ['MYFINANCE PRO &middot; FOLLOW THE CLUES', 'Your money, under the magnifying glass', 'Spot the patterns, meet your spending habits, and find the little changes that make room for what matters.'],
    compass: ['MYFINANCE PRO &middot; SPENDING COMPASS', 'Spending Compass', 'How your everyday spending compares with similar households, which way each category is heading, and where you could realistically save.']
  };

  // ---------- interest paid ----------
  const INTEREST_COLORS = { credit_card: '#e11d48', auto_loan: '#f59e0b', student_loan: '#6366f1', personal_loan: '#0ea5e9', mortgage: '#0f9f6e', other: '#94a3b8' };
  const interestState = { data: null, loading: false, error: '', showAll: false, run: 0 };
  const monthShort = key => new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1).toLocaleDateString('en-US', { month: 'short' });

  function interestChart(d) {
    const { money, esc } = pro().format;
    const months = d.months;
    const max = Math.max(...months.map(m => m.total), 1);
    const step = 10 ** Math.floor(Math.log10(max));
    const top = Math.ceil(max / step * 2) / 2 * step;
    const W = 640, H = 210, pad = { l: 48, r: 8, t: 12, b: 26 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const slot = iw / months.length, bw = Math.min(30, slot * 0.62);
    const y = v => pad.t + ih - v / top * ih;
    const grid = [0, 0.5, 1].map(f => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(top * f).toFixed(1)}" y2="${y(top * f).toFixed(1)}"/><text x="${pad.l - 8}" y="${(y(top * f) + 4).toFixed(1)}" text-anchor="end">${esc(money(top * f, true))}</text>`).join('');
    const kinds = Object.keys(d.kinds);
    const bars = months.map((m, i) => {
      const x = pad.l + slot * i + (slot - bw) / 2;
      let base = pad.t + ih;
      const parts = kinds.filter(kind => m.byKind[kind] > 0).map(kind => {
        const h = m.byKind[kind] / top * ih;
        base -= h;
        return `<rect x="${x.toFixed(1)}" y="${base.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, 0.5).toFixed(1)}" fill="${INTEREST_COLORS[kind]}"/>`;
      }).join('');
      const tip = `${monthShort(m.month)} ${m.month.slice(0, 4)}: ${money(m.total)}${kinds.filter(kind => m.byKind[kind] > 0).map(kind => `\n${d.kinds[kind]} ${money(m.byKind[kind])}`).join('')}${m.estimated ? `\n(${money(m.estimated)} estimated)` : ''}`;
      return `<g class="pro-int-bar${i === months.length - 1 ? ' is-current' : ''}"><title>${esc(tip)}</title><rect class="hit" x="${(pad.l + slot * i).toFixed(1)}" y="${pad.t}" width="${slot.toFixed(1)}" height="${ih}"/>${parts}
        <text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(monthShort(m.month))}</text></g>`;
    }).join('');
    return `<svg class="pro-int-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Interest paid by month, ${months.map(m => `${monthShort(m.month)} ${money(m.total)}`).join(', ')}`)}"><g class="grid">${grid}</g>${bars}</svg>`;
  }

  function interestBody(d) {
    const { money, esc } = pro().format;
    const kinds = Object.keys(d.kinds).filter(kind => d.totals[kind] > 0).sort((a, b) => d.totals[b] - d.totals[a]);
    const hints = d.hints.length ? `<ul class="pro-int-hints">${d.hints.map(hint => `<li><span class="dot" style="--c:${INTEREST_COLORS[hint.kind]}"></span><span>${esc(hint.message)}</span>${hint.action === 'accounts'
      ? '<a href="#accounts" data-view="accounts" class="btn btn-secondary btn-compact">Add statements</a>'
      : '<a href="#payoff" class="btn btn-secondary btn-compact">Set up</a>'}</li>`).join('')}</ul>` : '';
    if (!d.total) {
      return `<div class="pro-int-empty"><span class="pro-int-empty-icon">%</span><div><strong>No interest found in the last ${d.months.length} months</strong>
        <p>We look for interest and finance charges on card statements and synced accounts, and estimate the interest inside loan and mortgage payments and on carried credit card balances. Import a credit card statement or connect your bank to start tracking.</p></div></div>${hints}`;
    }
    const share = kind => d.total ? Math.round(d.totals[kind] / d.total * 100) : 0;
    const charges = d.charges.slice(0, interestState.showAll ? 60 : 6);
    const kindOptions = selected => Object.entries(d.kinds).map(([key, label]) => `<option value="${key}"${key === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const row = charge => `<li class="pro-int-row is-${charge.source}">
        <span class="dot" style="--c:${INTEREST_COLORS[charge.kind]}"></span>
        <div><strong>${esc(charge.description)}</strong><small>${dateShort(charge.date)}${charge.source === 'estimated' ? (charge.scheduled ? ' · from your loan schedule' : ` · from a ${money(charge.paymentAmount, false)} payment`) : charge.source === 'manual' ? ' · tagged by you' : ''}${charge.category ? ` · ${esc(charge.category)}` : ''}</small></div>
        ${charge.source === 'estimated' ? '<span class="pro-int-badge">Estimated</span>'
          : `<select class="pro-int-kind" data-interest-id="${esc(charge.id)}" aria-label="Interest type for ${esc(charge.description)}">${kindOptions(charge.kind)}</select>
             <button type="button" class="pro-int-remove" data-analytics-action="${charge.source === 'manual' ? 'interest-auto' : 'interest-not'}" data-id="${esc(charge.id)}" title="${charge.source === 'manual' ? 'Undo your tag and use automatic detection' : 'This is not interest'}" aria-label="${charge.source === 'manual' ? 'Reset to automatic' : 'Not interest'}">${charge.source === 'manual' ? '↺' : '×'}</button>`}
        <span class="num">${money(charge.amount, false)}</span></li>`;
    return `<div class="pro-int-kpis">
        <div class="is-lead"><span>Last ${d.months.length} months</span><strong>${money(d.total, true)}</strong><small>${d.estimated ? `incl. ${money(d.estimated, true)} estimated` : 'from your statements'}</small></div>
        <div><span>This month</span><strong>${money(d.thisMonth, true)}</strong><small>${money(d.lastMonth, true)} last month</small></div>
        <div><span>Monthly average</span><strong>${money(d.monthlyAverage, true)}</strong><small>≈ ${money(d.annualized, true)} a year</small></div>
        <div><span>${new Date().getFullYear()} so far</span><strong>${money(d.yearToDate, true)}</strong><small>year to date</small></div>
      </div>
      <div class="pro-int-grid">
        <figure class="pro-int-figure">${interestChart(d)}</figure>
        <ul class="pro-int-breakdown">${kinds.map(kind => `<li><span class="dot" style="--c:${INTEREST_COLORS[kind]}"></span><span class="label">${esc(d.kinds[kind])}</span><strong>${money(d.totals[kind], true)}</strong><span class="bar"><i style="width:${share(kind)}%;background:${INTEREST_COLORS[kind]}"></i></span><small>${share(kind)}% · ${money(d.totals[kind] / d.months.length, true)}/mo</small></li>`).join('')}</ul>
      </div>
      ${hints}
      <details class="pro-int-review"${interestState.showAll || interestState.reviewOpen ? ' open' : ''}><summary>Review interest charges <span>${d.charges.length}</span></summary>
        <p class="pro-int-help">Charges are detected from their wording and your bank's category. Change the type, or mark anything that isn't interest. Estimated rows come from loan payments and your loan's rate.</p>
        <ul class="pro-int-list">${charges.map(row).join('')}</ul>
        ${d.charges.length > 6 ? `<button type="button" class="link-btn pro-int-more" data-analytics-action="interest-more">${interestState.showAll ? 'Show fewer' : `Show all ${d.charges.length}`}</button>` : ''}
      </details>`;
  }

  function interestCard() {
    const { esc } = pro().format;
    const body = interestState.error ? `<p class="pro-empty">Could not load interest: ${esc(interestState.error)} <button type="button" class="btn btn-secondary btn-compact" data-analytics-action="interest-retry">Try again</button></p>`
      : interestState.data ? interestBody(interestState.data) : '<div class="pro-loading"><span></span><span></span><span></span></div>';
    return `<article class="pro-card panel span-3 pro-interest" id="pro-interest"><header><div><h2>Interest you paid</h2><p>Credit card, auto, loan and mortgage interest, found on your statements or estimated from loan payments and card balances</p></div></header><div class="pro-card-body">${body}</div></article>`;
  }

  function paintInterest() {
    const node = $('pro-interest');
    if (!node) return;
    const review = node.querySelector('.pro-int-review');
    if (review) interestState.reviewOpen = review.open;
    node.outerHTML = interestCard();
  }

  async function loadInterest(force = false) {
    if (interestState.data && !force) return paintInterest();
    const run = ++interestState.run;
    interestState.error = '';
    try {
      const data = await pro().request('/api/analytics/interest');
      if (run !== interestState.run) return;
      if (!data || !Array.isArray(data.months) || !data.kinds || !Array.isArray(data.charges)) throw new Error('Unexpected response');
      interestState.data = { hints: [], totals: {}, ...data };
    } catch (error) {
      if (run !== interestState.run) return;
      interestState.error = error.message;
    }
    paintInterest();
  }

  async function setInterestKind(id, kind, control) {
    if (control) control.disabled = true;
    try {
      await pro().request(`/api/analytics/interest/transactions/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ kind }) });
      await loadInterest(true);
      globalThis.notify?.(kind === null ? 'Marked as not interest.' : kind === 'auto' ? 'Back to automatic detection.' : 'Interest type updated.');
    } catch (error) {
      if (control) control.disabled = false;
      globalThis.alert?.(`Could not update this charge: ${error.message}`);
    }
  }

  function renderHeader() {
    const [eyebrow, heading, intro] = HEADERS[tab];
    if ($('analytics-eyebrow')) $('analytics-eyebrow').innerHTML = eyebrow;
    if ($('analytics-heading')) $('analytics-heading').textContent = heading;
    if ($('analytics-intro')) $('analytics-intro').textContent = intro;
  }

  function tabs(a) {
    const { money } = pro().format;
    const found = compassPeriod?.data?.potentialMonthly ?? a?.moneyFlow?.potentialMonthly;
    const link = (id, route, label, extra = '') => `<a href="#${route}" data-view="${route}" class="pro-tab${tab === id ? ' is-active' : ''}"${tab === id ? ' aria-current="page"' : ''}>${label}${extra}</a>`;
    const help = `<a class="pro-tab-help" href="#tutorials/${tab === 'compass' ? 'compass' : 'analytics'}">&#9654; How it works</a>`;
    return `<nav class="pro-tabs" aria-label="Analytics pages">${link('overview', 'analytics', 'Overview')}${link('compass', 'analytics/compass', 'Spending Compass', found > 0 ? `<span class="pro-tab-badge">${money(found, true)}/mo</span>` : '')}${help}</nav>`;
  }

  function render(a) {
    const finish = globalThis.FinancePerformance?.begin('cpu', `analytics.${tab}.render`);
    const { esc } = pro().format;
    if (tab === 'compass') {
      $('analytics-content').innerHTML = `${tabs(a)}${compassPage(a)}`;
      mountBubbles(panelFlow()?.vendors);
      finish?.();
      return;
    }
    stopField();
    const thin = a.monthsOfHistory < 3 ? '<p class="pro-banner">Insights sharpen with history. Import at least 3 months of statements for reliable moving averages and signals.</p>' : '';
    const footnote = `<details class="money-exact"><summary>Data and estimates</summary><p>As of ${dateShort(a.asOf)}. Spending excludes transfers between your own accounts${a.excludedCategories?.length ? ` (${a.excludedCategories.map(esc).join(', ')})` : ''}. Projections are estimates based on your history, not financial advice.</p></details>`;
    $('analytics-content').innerHTML = `${tabs(a)}${thin}${kpis(a)}<div class="pro-grid">${forecastCard(a)}${cashflowCard(a)}${trendCard(a)}${recurringCard(a)}${interestCard()}${signalsTable(a)}${anomaliesCard(a)}${merchantsCard(a)}${weekdayCard(a)}</div>${footnote}`;
    if (!interestState.data && !interestState.error) loadInterest();
    finish?.();
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
    if (!entitlement.plusActive) { compassPeriod = null; stopField(); content.innerHTML = lockedPreview(entitlement); return; }
    try {
      interestState.data = null; interestState.error = '';
      current = await pro().getAnalytics(force);
      if (compassPeriod && (force || compassPeriod.stale)) {
        const state = compassPeriod;
        try {
          const url = `/api/analytics/compass?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`;
          const data = await pro().request(url);
          if (compassPeriod === state) { state.data = data; state.error = ''; state.stale = false; state.loading = false; }
        } catch (error) {
          if (compassPeriod === state) {
            state.loading = false;
            state.error = `Could not refresh this period: ${error.message}.${state.data ? ' Previous result shown.' : ' No readings shown; try Apply to retry.'}`;
          }
        }
      }
      if (run === request) render(current);
    } catch (error) {
      if (run !== request) return;
      if (['PRO_REQUIRED', 'PRO_PLUS_REQUIRED', 'SUBSCRIPTION_REQUIRED'].includes(error.code)) return globalThis.loadAnalyticsPage();
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
      return mountBubbles(panelFlow()?.vendors);
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
    if (action === 'interest-retry') { interestState.error = ''; interestState.data = null; paintInterest(); return loadInterest(true); }
    if (action === 'interest-more') { interestState.showAll = !interestState.showAll; return paintInterest(); }
    if (action === 'interest-not') return setInterestKind(target.dataset.id, null, target);
    if (action === 'interest-auto') return setInterestKind(target.dataset.id, 'auto', target);
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
  document.addEventListener('change', event => {
    if (event.target?.dataset?.interestId && event.target.closest?.('#analytics-view')) {
      return setInterestKind(event.target.dataset.interestId, event.target.value, event.target);
    }
    if (event.target?.dataset?.recurringFilter && current) {
      if (event.target.dataset.recurringFilter !== 'search') updateRecurringFilter(event.target);
      return;
    }
    const form = event.target?.closest?.('[data-compass-range]');
    if (!form) return;
    if (event.target.name !== 'preset') return;
    const preset = event.target.value;
    for (const name of ['from', 'to']) {
      form.querySelector(`[name="${name}"]`).parentElement.hidden = preset !== 'custom';
    }
    if (preset === 'custom') return;
    const end = lastCompleteMonth(), start = end - Number(preset) + 1;
    form.querySelector('[name="from"]').value = monthKey(start);
    form.querySelector('[name="to"]').value = monthKey(end);
  });
  function updateRecurringFilter(target) {
    const key = target.dataset.recurringFilter;
    if (!Object.hasOwn(recurringFilters, key)) return;
    recurringFilters[key] = target.value;
    const host = $('recurring-payment-card');
    if (!host) return;
    const start = target.selectionStart, end = target.selectionEnd;
    host.outerHTML = recurringCard(current);
    const replacement = document.querySelector(`#recurring-payment-card [data-recurring-filter="${key}"]`);
    replacement?.focus({ preventScroll: true });
    if (key === 'search' && start !== null) replacement?.setSelectionRange(start, end);
  }
  document.addEventListener('input', event => {
    if (event.target?.dataset?.recurringFilter === 'search' && current) updateRecurringFilter(event.target);
  });
  document.addEventListener('submit', async event => {
    const form = event.target?.closest?.('[data-compass-range]');
    if (!form || !current) return;
    event.preventDefault();
    const finish = globalThis.FinancePerformance?.begin('panel', 'compass.all.load');
    const preset = form.querySelector('[name="preset"]').value;
    const from = form.querySelector('[name="from"]').value, to = form.querySelector('[name="to"]').value;
    const state = { preset, from, to, loading: true, data: panelFlow() };
    compassPeriod = state;
    render(current);
    try {
      const data = await pro().request(`/api/analytics/compass?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (compassPeriod !== state) return;
      state.data = data; state.loading = false;
      finish?.();
    } catch (error) {
      if (compassPeriod !== state) return;
      const previous = state.data.range;
      state.error = `Could not update Spending Compass: ${error.message}. Previous results shown for ${previous?.from || 'the last ' + (previous?.months || 3) + ' completed months'}${previous?.to ? ' through ' + previous.to : ''}.`;
      state.loading = false;
      finish?.('error');
    }
    if (tab === 'compass') render(current);
  });
  document.addEventListener('pro:entitlement', event => {
    if (event.detail && !event.detail.plusActive) { compassPeriod = null; current = null; recurringFilters.status = 'active'; recurringFilters.kind = 'all'; recurringFilters.search = ''; stopField(); }
  });
  document.addEventListener('finance:analytics-invalidated', () => {
    request++;
    if (compassPeriod) compassPeriod = { ...compassPeriod, stale: true, loading: false };
  });
})();
