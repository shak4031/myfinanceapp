// MyFinance Pro on the dashboard: analytics toggle, deltas vs last month, budget progress and a pie view.
(() => {
  const $ = id => document.getElementById(id);
  let token = 0, lastDetail = null;

  const segmented = (view, locked) => `<div class="pro-segmented${locked ? ' is-locked' : ''}" role="group" aria-label="Spending view">
    <button type="button" data-dash-view="cards" aria-pressed="${view === 'cards'}">Cards</button>
    <button type="button" data-dash-view="pie" aria-pressed="${view === 'pie'}">${locked ? globalThis.FinancePro.ICONS.lock : ''}Pie</button></div>`;

  function budgetVisual(category) {
    const { money, esc } = globalThis.FinancePro.format;
    const budget = Number(category.budget);
    if (!Number.isFinite(budget) || budget <= 0) return null;
    const spent = Math.max(0, Number(category.mtd) || 0);
    const remaining = budget - spent;
    const state = remaining < 0 ? 'over' : category.budgetStatus === 'risk' ? 'risk' : 'ok';
    const remainder = remaining < 0 ? `${money(-remaining)} over budget` : remaining === 0 ? 'Budget reached' : `${money(remaining)} left`;
    const description = `${category.name}: ${money(spent)} spent of ${money(budget)} monthly budget. ${remainder}. Projected month-end: ${money(category.projected || 0)}.`;
    return {
      remainder: `<span class="mtd-budget-remainder is-${state} pro-added">${esc(remainder)}</span>`,
      meter: `<span class="mtd-budget-meter is-${state} pro-added" role="meter" aria-label="${esc(category.name)} monthly budget" aria-valuemin="0" aria-valuemax="${budget}" aria-valuenow="${Math.min(spent, budget)}" aria-valuetext="${esc(description)}" title="${esc(description)}"><i aria-hidden="true" style="height:${(Math.min(1, spent / budget) * 100).toFixed(1)}%"></i></span>`
    };
  }

  function summary(analytics) {
    const { money, esc } = globalThis.FinancePro.format;
    const k = analytics.kpis, f = analytics.forecast;
    const budgeted = analytics.categories.filter(c => c.budget);
    const onTrack = budgeted.filter(c => c.budgetStatus === 'ok').length;
    const mover = k.biggestMover;
    const deltaClass = k.mtdDelta > 0 ? 'is-up' : k.mtdDelta < 0 ? 'is-down' : '';
    return `<div class="pro-summary pro-added">
      <div><span>Spent so far</span><strong>${money(k.mtdSpend, true)}</strong><small class="${deltaClass}">${k.mtdDelta > 0 ? '▲' : k.mtdDelta < 0 ? '▼' : ''} ${money(Math.abs(k.mtdDelta), true)} vs same day last month</small></div>
      <div><span>Projected month-end</span><strong>${money(f.projected, true)}</strong><small>Last month ${money(f.lastMonth, true)}</small></div>
      <div><span>Budgets on track</span><strong>${budgeted.length ? `${onTrack}<em>/${budgeted.length}</em>` : '&mdash;'}</strong><small>${budgeted.length ? `${budgeted.length - onTrack} need attention` : '<button type="button" class="link-button" data-pro-budgets>Set your first budget</button>'}</small></div>
      <div><span>Biggest mover</span><strong class="is-name">${mover ? esc(mover.name) : '&mdash;'}</strong><small class="${mover?.deltaMtd > 0 ? 'is-up' : 'is-down'}">${mover ? `${mover.deltaMtd > 0 ? '▲' : '▼'} ${money(Math.abs(mover.deltaMtd), true)} vs last month` : 'Steady month so far'}</small></div>
    </div>`;
  }

  let pieItems = [], pieTotal = 0, pieSelected = null, analyticsByName = new Map();

  function pieDetail() {
    const { money, esc } = globalThis.FinancePro.format;
    const item = pieItems[pieSelected];
    if (!item) {
      const top = pieItems[0];
      return `<div class="pie-detail is-overview"><span class="pie-detail-eyebrow">Spent this month</span><strong class="pie-detail-amount">${money(pieTotal, true)}</strong>
        <p>${pieItems.reduce((sum, entry) => sum + (entry.rest ? entry.rest.length : 1), 0)} categories${top ? ` &middot; most on <b>${esc(top.label)}</b> (${Math.round(top.value / pieTotal * 100)}%)` : ''}</p>
        <p class="pie-detail-hint">Select a slice or category to explore it.</p></div>`;
    }
    const share = Math.round(item.value / pieTotal * 100);
    if (item.rest) {
      return `<div class="pie-detail" style="--pie-color:${item.color}"><span class="pie-detail-eyebrow"><i></i>Smaller categories</span><strong class="pie-detail-amount">${money(item.value, true)}</strong>
        <p>${share}% of spending across ${item.rest.length} categories</p>
        <ul class="pie-detail-rest">${item.rest.map(c => `<li><button type="button" data-pie-category="${esc(c.name)}"><span>${esc(c.name)}</span><strong>${money(c.totalSpending, true)}</strong></button></li>`).join('')}</ul>
        <button type="button" class="pie-detail-close" data-pie-clear aria-label="Back to overview">&times;</button></div>`;
    }
    const count = Number(item.count) || 0;
    const stats = [`<div><span>Share</span><strong>${share}%</strong></div>`, `<div><span>Transactions</span><strong>${count}</strong></div>`];
    if (count) stats.push(`<div><span>Average</span><strong>${money(item.value / count, true)}</strong></div>`);
    const analytics = analyticsByName.get(item.label);
    const budget = Number(analytics?.budget);
    if (budget > 0) {
      const left = budget - item.value;
      stats.push(`<div class="${left < 0 ? 'is-bad' : ''}"><span>Budget</span><strong>${left < 0 ? `${money(-left, true)} over` : `${money(left, true)} left`}</strong></div>`);
    }
    if (Number.isFinite(Number(analytics?.deltaMtd)) && Number(analytics.deltaMtd) !== 0) {
      const delta = Number(analytics.deltaMtd);
      stats.push(`<div class="${delta > 0 ? 'is-bad' : 'is-good'}"><span>vs last month</span><strong>${delta > 0 ? '▲' : '▼'} ${money(Math.abs(delta), true)}</strong></div>`);
    }
    return `<div class="pie-detail" style="--pie-color:${item.color}"><span class="pie-detail-eyebrow"><i></i>#${pieSelected + 1} of ${pieItems.length}</span>
      <h3>${esc(item.label)}</h3><strong class="pie-detail-amount">${money(item.value, true)}</strong>
      <div class="pie-detail-stats">${stats.join('')}</div>
      <button type="button" class="btn btn-primary btn-compact" data-pie-category="${esc(item.label)}">View transactions</button>
      <button type="button" class="pie-detail-close" data-pie-clear aria-label="Back to overview">&times;</button></div>`;
  }

  function selectSlice(index) {
    const root = document.querySelector('#mtd-spending-section .pro-pie');
    if (!root) return;
    pieSelected = index == null || index === pieSelected ? null : index;
    root.classList.toggle('has-selection', pieSelected != null);
    root.querySelectorAll('[data-pie-index]').forEach(node => node.classList.toggle('is-selected', Number(node.dataset.pieIndex) === pieSelected));
    root.querySelectorAll('[data-pie-select]').forEach(node => node.setAttribute('aria-pressed', String(Number(node.dataset.pieSelect) === pieSelected)));
    root.querySelector('.pie-detail-slot').innerHTML = pieDetail();
  }

  let hotIndex = null;
  function hotSlice(index) {
    if (index === hotIndex) return;
    hotIndex = index;
    document.querySelectorAll('#mtd-spending-section .pro-pie [data-pie-index], #mtd-spending-section .pro-pie [data-pie-select]').forEach(node =>
      node.classList.toggle('is-hot', index != null && Number(node.dataset.pieIndex ?? node.dataset.pieSelect) === index));
  }

  function pie(categories) {
    const { PALETTE, pie3d } = globalThis.ProCharts;
    const { money, esc } = globalThis.FinancePro.format;
    const sorted = categories.filter(c => c.totalSpending > 0).sort((a, b) => b.totalSpending - a.totalSpending);
    const shown = sorted.length <= 9 ? 9 : 8;
    pieItems = sorted.slice(0, shown).map((c, i) => ({ label: c.name, value: c.totalSpending, count: c.transactionCount, color: PALETTE[i] }));
    const rest = sorted.slice(shown);
    if (rest.length) pieItems.push({ label: `${rest.length} more`, value: rest.reduce((s, c) => s + c.totalSpending, 0), color: PALETTE[9], rest });
    pieTotal = pieItems.reduce((s, i) => s + i.value, 0);
    pieSelected = null;
    if (!pieTotal) return '<div class="pro-pie pro-added"><p class="muted">No spending yet this month.</p></div>';
    const legend = pieItems.map((item, index) => `<li><button type="button" data-pie-select="${index}" aria-pressed="false"><i style="background:${item.color}"></i><span>${esc(item.label)}</span><strong>${money(item.value, true)}</strong><em>${Math.round((item.value / pieTotal) * 100)}%</em></button></li>`).join('');
    return `<div class="pro-pie pro-added"><div class="pro-pie-stage"><div class="pro-pie-chart">${pie3d(pieItems, { label: 'Month-to-date spending by category. Select a slice for details.' })}</div><div class="pie-detail-slot" aria-live="polite">${pieDetail()}</div></div><ul class="pro-pie-legend">${legend}</ul></div>`;
  }

  async function enhance(detail) {
    const pro = globalThis.FinancePro, section = $('mtd-spending-section');
    if (!pro || !section) return;
    const run = ++token;
    lastDetail = detail;
    await pro.ensureEntitlement();
    if (run !== token || !section.isConnected) return;
    const active = pro.isPlusActive();
    const insights = active && pro.prefs.get('dash.insights', 'on') === 'on';
    const view = active ? pro.prefs.get('dash.view', 'cards') : 'cards';
    const head = section.querySelector('.section-head'), grid = section.querySelector('.mtd-grid');
    section.querySelectorAll('.pro-added').forEach(node => node.remove());
    analyticsByName = new Map();
    grid.hidden = view === 'pie';
    head.insertAdjacentHTML('beforeend', `<div class="pro-toolbar pro-added">${pro.proSwitch('dash-insights', 'Analytics', insights)}${segmented(view, !active)}
      <button type="button" class="btn btn-secondary btn-compact" data-pro-budgets>${active ? '' : pro.ICONS.lock}Budgets</button></div>`);
    if (view === 'pie') grid.insertAdjacentHTML('beforebegin', pie(detail?.categories || []));
    if (!insights) return;
    try {
      const analytics = await pro.getAnalytics();
      if (run !== token || !section.isConnected) return;
      head.insertAdjacentHTML('afterend', summary(analytics));
      const byName = new Map(analytics.categories.map(c => [c.name, c]));
      analyticsByName = byName;
      const slot = section.querySelector('.pie-detail-slot');
      if (slot) slot.innerHTML = pieDetail();
      section.querySelectorAll('.mtd-category-card').forEach(card => {
        const category = byName.get(card.dataset.category);
        const visual = category && budgetVisual(category);
        if (visual) {
          card.querySelector('.mtd-card-body').insertAdjacentHTML('beforeend', visual.remainder);
          card.insertAdjacentHTML('beforeend', visual.meter);
        }
      });
    } catch (error) {
      if (run === token) head.insertAdjacentHTML('afterend', `<p class="pro-inline-error pro-added">Analytics are unavailable right now: ${pro.format.esc(error.message)}</p>`);
    }
  }

  document.addEventListener('mtd:rendered', event => enhance(event.detail));
  const pieTarget = target => target?.closest?.('#mtd-spending-section .pro-pie [data-pie-index], #mtd-spending-section .pro-pie [data-pie-select]');
  const pieIndexOf = node => Number(node.dataset.pieIndex ?? node.dataset.pieSelect);
  document.addEventListener('pointerover', event => { const node = pieTarget(event.target); hotSlice(node ? pieIndexOf(node) : null); });
  document.addEventListener('focusin', event => { const node = pieTarget(event.target); hotSlice(node ? pieIndexOf(node) : null); });
  document.addEventListener('keydown', event => {
    const node = pieTarget(event.target);
    if (node && node.matches('.pie3d-top') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectSlice(pieIndexOf(node)); }
    else if (event.key === 'Escape' && pieSelected != null && event.target?.closest?.('#mtd-spending-section .pro-pie')) selectSlice(null);
  });
  document.addEventListener('click', event => {
    const node = pieTarget(event.target);
    if (node) return selectSlice(pieIndexOf(node));
    if (event.target?.closest?.('#mtd-spending-section .pro-pie [data-pie-clear]')) selectSlice(null);
  });
  document.addEventListener('click', event => {
    const pro = globalThis.FinancePro;
    const target = event.target?.closest?.('[data-pro-switch="dash-insights"], [data-dash-view], [data-pro-budgets], [data-pie-category]');
    if (!pro || !target || !target.closest('#mtd-spending-section, .pro-summary')) return;
    if (target.dataset.pieCategory) {
      const now = new Date();
      return globalThis.openCategoryTransactions?.(target.dataset.pieCategory, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
    }
    if (target.hasAttribute('data-pro-budgets')) return pro.openBudgets();
    if (!pro.requirePro('Dashboard analytics are part of MyFinance Pro.')) return;
    if (target.dataset.dashView) pro.prefs.set('dash.view', target.dataset.dashView);
    else pro.prefs.set('dash.insights', target.getAttribute('aria-checked') === 'true' ? 'off' : 'on');
    enhance(lastDetail);
  });
})();
