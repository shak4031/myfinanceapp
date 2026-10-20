// Historical context stays on demand, leaving the spending cards easy to scan.
(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = value => value == null ? 'No data' : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const monthLabel = month => new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1).toLocaleDateString('en-US', { month: 'short' });
  let cache = null, pending = null, generation = 0, active = null, popup = null, openTimer = null, closeTimer = null, suppressed = null, proState = null;

  function renderCategory(category, pro) {
    const points = category.series;
    const max = Math.max(1, ...points.map(point => point.amount || 0), category.stats?.budget || 0);
    const bars = points.map(point => {
      const height = point.amount == null ? 0 : point.amount / max * 100;
      const over = category.stats?.budget != null && point.amount > category.stats.budget;
      return `<li class="${point.amount == null ? 'is-missing' : ''}${over ? ' is-over' : ''}">
        <strong>${esc(money(point.amount))}</strong><span class="history-bar-track"><i style="height:${height.toFixed(2)}%" aria-hidden="true"></i></span>
        <span>${esc(monthLabel(point.month))}<span class="visually-hidden"> ${esc(point.month.slice(0, 4))}</span></span></li>`;
    }).join('');
    const stats = category.stats;
    return `<div class="history-average"><span>Monthly average</span><strong>${esc(money(category.average))}</strong><small>${category.observedMonths} of 6 months with imported history</small></div>
      <ol class="history-chart" aria-label="Monthly spending in the last six completed months">${bars}</ol>
      ${pro && stats ? `<dl class="history-stats">
        <div><dt>Highest month</dt><dd>${stats.highest ? `${esc(money(stats.highest.amount))} <small>${esc(monthLabel(stats.highest.month))}</small>` : 'No data'}</dd></div>
        <div><dt>Lowest month</dt><dd>${stats.lowest ? `${esc(money(stats.lowest.amount))} <small>${esc(monthLabel(stats.lowest.month))}</small>` : 'No data'}</dd></div>
        <div><dt>Last month vs prior</dt><dd>${stats.changePct == null ? 'Not enough history' : `${stats.changePct > 0 ? '+' : ''}${stats.changePct}%`}</dd></div>
        <div><dt>Transactions in period</dt><dd>${stats.transactionCount}</dd></div>
      </dl>
      <div class="history-budget">${stats.budget == null ? 'Set a budget to compare your monthly pattern.' : `<strong>${stats.monthsOverBudget} of ${category.observedMonths} months</strong> above your current ${esc(money(stats.budget))} monthly budget.<small>Comparison uses today's budget, not historical budget settings.</small>`}</div>`
      : '<div class="history-upgrade"><span>Go deeper with Pro</span><p>See budget consistency, high and low months, and month-to-month change.</p><button type="button" data-history-upgrade>Explore Pro</button></div>'}
      <p class="history-footnote">Based on imported transactions; missing statements can understate totals. The current partial month is excluded.</p>`;
  }

  function panel() {
    if (popup?.isConnected) return popup;
    popup = document.createElement('section');
    popup.id = 'spending-history-preview';
    popup.className = 'spending-history-preview';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'false');
    popup.setAttribute('aria-labelledby', 'spending-history-title');
    popup.hidden = true;
    document.body.appendChild(popup);
    return popup;
  }
  function position() {
    if (!active?.isConnected || !popup || popup.hidden) return;
    popup.style.maxHeight = '';
    const rect = active.getBoundingClientRect(), box = popup.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = window.innerHeight;
    let left = Math.max(12, Math.min(rect.left, width - box.width - 12));
    const below = rect.bottom + 10;
    let top;
    if (width >= 640 && rect.right + box.width + 22 <= width) {
      left = rect.right + 10;
      top = Math.max(12, Math.min(rect.top, height - box.height - 12));
    } else if (width >= 640 && rect.left - box.width >= 22) {
      left = rect.left - box.width - 10;
      top = Math.max(12, Math.min(rect.top, height - box.height - 12));
    } else if (below + box.height <= height - 12) top = below;
    else if (rect.top - box.height >= 22) top = rect.top - box.height - 10;
    else if (width >= 640 && Math.max(height - below - 12, rect.top - 22) >= 220) {
      const useBelow = height - below - 12 >= rect.top - 22;
      const available = useBelow ? height - below - 12 : rect.top - 22;
      popup.style.maxHeight = `${available}px`;
      top = useBelow ? below : 12;
    } else top = Math.max(12, height - box.height - 12);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }
  function setExpanded(value) {
    active?.querySelector('.mtd-history-trigger')?.setAttribute('aria-expanded', String(value));
    const card = active?.querySelector('.mtd-category-card');
    if (value) card?.setAttribute('aria-describedby', 'spending-history-title');
    else card?.removeAttribute('aria-describedby');
  }
  function dismiss({ suppress = false, restoreFocus = false } = {}) {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    if (suppress) suppressed = active;
    setExpanded(false);
    if (popup) popup.hidden = true;
    const trigger = active?.querySelector('.mtd-history-trigger');
    active = null;
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }
  function reset() {
    generation++;
    cache = null; pending = null; suppressed = null;
    dismiss();
    popup?.remove(); popup = null;
  }
  async function load() {
    if (cache) return cache;
    if (pending) return pending;
    const run = generation;
    const request = (async () => {
      const response = await fetch('/api/dashboard/spending-history');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `History could not be loaded (${response.status}).`);
      if (run === generation) cache = data;
      return data;
    })();
    pending = request;
    try { return await request; } finally { if (pending === request) pending = null; }
  }
  async function show(wrapper) {
    if (!wrapper || suppressed === wrapper) return;
    clearTimeout(closeTimer);
    if (active !== wrapper) { setExpanded(false); active = wrapper; }
    const name = wrapper.querySelector('.mtd-category-card')?.dataset.category;
    if (!name) return;
    const root = panel();
    const header = `<header><div><span class="history-eyebrow">6 completed months</span><h3 id="spending-history-title">${esc(name)}</h3></div><button type="button" class="history-close" data-history-close aria-label="Close spending history">&times;</button></header>`;
    const keepFocus = root.contains(document.activeElement);
    root.innerHTML = `${header}<div class="history-content" role="status"><progress aria-label="Loading category history"></progress><p>Loading your spending pattern...</p></div>`;
    root.hidden = false; setExpanded(true); position();
    if (keepFocus) root.querySelector('[data-history-close]')?.focus();
    const run = generation;
    try {
      const data = await load();
      if (run !== generation || active !== wrapper || root.hidden) return;
      const category = data.categories.find(item => item.name === name);
      const restoreFocus = root.contains(document.activeElement);
      root.innerHTML = header + (category ? renderCategory(category, data.pro) : '<p class="history-empty">No completed-month history for this category yet. Import earlier statements to see your pattern.</p>');
      if (restoreFocus) root.querySelector('[data-history-close]')?.focus();
    } catch (error) {
      if (run !== generation || active !== wrapper || root.hidden) return;
      const restoreFocus = root.contains(document.activeElement);
      root.innerHTML = `${header}<div class="history-empty" role="alert"><p>${esc(error.message)}</p><button type="button" data-history-retry>Try again</button></div>`;
      if (restoreFocus) root.querySelector('[data-history-close]')?.focus();
    }
    position();
  }
  const wrapperFor = target => target?.closest?.('#mtd-spending-section .mtd-card-wrap');
  const inside = target => !!(active?.contains(target) || popup?.contains(target));
  function delayedClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!inside(document.activeElement) && !active?.matches(':hover') && !popup?.matches(':hover')) dismiss();
    }, 180);
  }
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch' || document.documentElement.clientWidth < 640) return;
    if (popup?.contains(event.target)) { clearTimeout(closeTimer); return; }
    const wrapper = wrapperFor(event.target);
    if (!wrapper || wrapper.contains(event.relatedTarget)) return;
    clearTimeout(openTimer); clearTimeout(closeTimer);
    openTimer = setTimeout(() => show(wrapper), 260);
  });
  document.addEventListener('pointerout', event => {
    const wrapper = wrapperFor(event.target);
    if (wrapper && !wrapper.contains(event.relatedTarget)) {
      clearTimeout(openTimer);
      if (suppressed === wrapper) suppressed = null;
      if (!inside(event.relatedTarget)) delayedClose();
    } else if (popup?.contains(event.target) && !popup.contains(event.relatedTarget) && !inside(event.relatedTarget)) delayedClose();
  });
  document.addEventListener('focusin', event => {
    if (popup?.contains(event.target)) { clearTimeout(closeTimer); return; }
    const wrapper = wrapperFor(event.target);
    if (wrapper && event.target.matches?.(':focus-visible')) show(wrapper);
    else if (!inside(event.target)) dismiss();
  });
  document.addEventListener('focusout', event => {
    if (suppressed?.contains(event.target) && !suppressed.contains(event.relatedTarget)) suppressed = null;
    if (inside(event.target) && !inside(event.relatedTarget)) {
      delayedClose();
    }
  });
  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-spending-history]');
    if (trigger) {
      event.preventDefault();
      clearTimeout(openTimer);
      const wrapper = wrapperFor(trigger);
      suppressed = null;
      show(wrapper);
      if (event.detail === 0) popup?.querySelector('[data-history-close]')?.focus();
      return;
    }
    if (event.target.closest?.('[data-history-close]')) return dismiss({ suppress: true, restoreFocus: true });
    if (event.target.closest?.('[data-history-retry]')) { cache = null; return show(active); }
    if (event.target.closest?.('[data-history-upgrade]')) {
      dismiss({ suppress: true });
      return window.FinancePro?.requirePro('Pro adds budget consistency and deeper statistics to your spending history.');
    }
    if (!inside(event.target) || event.target.closest?.('.mtd-category-card')) dismiss({ suppress: true });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); dismiss({ suppress: true, restoreFocus: popup?.contains(document.activeElement) }); }
  });
  document.addEventListener('mtd:rendered', reset);
  document.addEventListener('pro:entitlement', event => {
    const next = !!event.detail?.active;
    if (proState !== null && proState !== next) reset();
    proState = next;
  });
  window.addEventListener('resize', position);
  window.addEventListener('hashchange', dismiss);
  window.addEventListener('scroll', event => { if (active && !popup?.contains(event.target)) dismiss(); }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) dismiss(); });
  window.FinanceSpendingHistory = { reset, renderCategory };
})();
