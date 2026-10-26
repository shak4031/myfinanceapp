/* Shared entitlement and Pro feature helpers. Billing is handled by Stripe. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const money = (value, round = false) => value == null || !Number.isFinite(Number(value)) ? '&mdash;' : (round ? whole : currency).format(Number(value));
  const pct = (value, digits = 0) => value == null || !Number.isFinite(value) ? '&mdash;' : `${(value * 100).toFixed(digits)}%`;
  const prefs = {
    get(key, fallback) { try { return globalThis.localStorage?.getItem(`myfinance.pro.${key}`) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { globalThis.localStorage?.setItem(`myfinance.pro.${key}`, value); } catch { /* private mode */ } }
  };
  const ICONS = {
    lock: '<svg class="pro-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>',
    insights: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/></svg>',
    budgets: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    charts: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9h9a9 9 0 1 1-9-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/></svg>',
    forecast: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18"/><path d="M5 16l4-4 3 3 6-7"/><path d="M18 8h3v3" stroke-dasharray="2 2"/></svg>',
    subscriptions: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/></svg>',
    anomalies: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.5"/></svg>',
    export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>'
  };
  const state = { entitlement: null, entitlementPromise: null, analytics: null, analyticsAt: 0, analyticsPromise: null };
  async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json();
    if (!response.ok) {
      if (data?.entitlement) setEntitlement(data.entitlement);
      throw Object.assign(new Error(data?.error || `Request failed (${response.status})`), { code: data?.code, status: response.status, entitlement: data?.entitlement });
    }
    return data;
  }
  const isActive = () => !!state.entitlement?.active;
  const isPlusActive = () => !!state.entitlement?.plusActive;
  function planLabel(entitlement = state.entitlement) {
    if (!entitlement) return { tone: 'free', title: 'Choose a household plan', detail: 'Basic or Pro' };
    if (entitlement.tier === 'trial') return { tone: 'trial', title: 'Pro trial', detail: entitlement.daysLeft == null ? '15-day trial' : `${entitlement.daysLeft} days left` };
    if (entitlement.active) return { tone: 'pro', title: entitlement.plusActive ? 'MyFinance Pro' : 'MyFinance Basic', detail: 'Household access active' };
    return { tone: 'free', title: 'Choose a household plan', detail: 'Basic or Pro' };
  }
  function setEntitlement(entitlement) {
    state.entitlement = entitlement;
    document.body?.classList?.toggle('has-pro', !!entitlement?.plusActive);
    document.body?.classList?.toggle('has-pro-plus', !!entitlement?.plusActive);
    const label = planLabel();
    function renderBadge(node) {
      if (!node) return;
      node.textContent = isPlusActive() ? 'PRO' : '';
      if (!isPlusActive()) node.innerHTML = ICONS.lock;
      node.setAttribute('aria-label', isPlusActive() ? 'Pro feature' : 'Pro feature locked. View upgrade options');
      node.setAttribute('title', isPlusActive() ? 'Included in Pro' : 'View Pro upgrade options');
      node.onclick = isPlusActive() ? null : event => {
        event.preventDefault();
        event.stopPropagation();
        openUpgrade();
      };
    }
    document.querySelectorAll?.('.plus-nav-badge').forEach(renderBadge);
    const badge = $('pro-nav-badge');
    renderBadge(badge);
    const bottom = document.querySelector?.('.sidebar-bottom');
    if (bottom && typeof bottom.insertBefore === 'function') {
      let chip = $('plan-chip');
      if (!chip) {
        chip = document.createElement('button');
        chip.id = 'plan-chip';
        chip.type = 'button';
        chip.addEventListener('click', () => openUpgrade());
        bottom.insertBefore(chip, bottom.firstChild);
      }
      chip.className = `plan-chip is-${label.tone}`;
      chip.innerHTML = `<span><strong>${esc(label.title)}</strong><small>${esc(label.detail)}</small></span>`;
    }
    globalThis.emitFinanceEvent?.('pro:entitlement', entitlement);
  }
  function ensureEntitlement(force = false) {
    if (!force && state.entitlement) return Promise.resolve(state.entitlement);
    if (!force && state.entitlementPromise) return state.entitlementPromise;
    state.entitlementPromise = request('/api/license').then(data => { setEntitlement(data); return data; }).finally(() => { state.entitlementPromise = null; });
    return state.entitlementPromise;
  }
  function getAnalytics(force = false) {
    if (!isPlusActive()) return Promise.reject(new Error('Analytics requires household Pro access.'));
    if (!force && state.analytics && Date.now() - state.analyticsAt < 15000) return Promise.resolve(state.analytics);
    if (!force && state.analyticsPromise) return state.analyticsPromise;
    state.analyticsPromise = request('/api/analytics').then(data => { state.analytics = data; state.analyticsAt = Date.now(); return data; }).finally(() => { state.analyticsPromise = null; });
    return state.analyticsPromise;
  }
  const invalidateAnalytics = () => { state.analytics = null; state.analyticsAt = 0; };
  const openUpgrade = (reason = '', requiredPlan = 'pro', picked = '') => globalThis.FinanceHousehold?.openBilling(reason, picked || requiredPlan);
  function requirePro(reason) {
    if (isPlusActive()) return true;
    openUpgrade(reason);
    return false;
  }
  const proTag = () => isPlusActive() ? '<span class="pro-tag">PRO</span>'
    : `<span class="pro-tag is-locked" aria-label="Pro feature locked" title="View Pro upgrade options">${ICONS.lock}</span>`;
  const proSwitch = (id, label, on) => `<button type="button" class="pro-switch${isPlusActive() ? '' : ' is-locked'}" role="switch" aria-checked="${!!on && isPlusActive()}" data-pro-switch="${esc(id)}"><span class="pro-switch-track" aria-hidden="true"><span></span></span><span>${esc(label)}</span>${proTag()}</button>`;
  function refreshCurrentView() { globalThis.showView?.(location.hash.slice(1) || 'dashboard'); }
  async function openBudgets() {
    if (!requirePro('Budgets are included in Pro.')) return;
    let dialog = $('budget-dialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'budget-dialog';
      dialog.className = 'editor budget-dialog';
      dialog.setAttribute('aria-labelledby', 'budget-dialog-title');
      document.body.appendChild(dialog);
    }
    dialog.innerHTML = '<p>Loading budgets…</p>';
    if (!dialog.open) dialog.showModal();
    try {
      const [analytics, categories] = await Promise.all([getAnalytics(), request('/api/categories')]);
      const stats = new Map(analytics.categories.map(category => [category.name, category]));
      const names = [...new Set([...analytics.categories.filter(c => !c.transfer).map(c => c.name), ...(Array.isArray(categories) ? categories : []).map(c => c.name)])]
        .filter(name => name && !/^(?:income|salary|transfers?|savings)$/i.test(name))
        .sort((a, b) => (stats.get(b)?.sma3 || 0) - (stats.get(a)?.sma3 || 0) || a.localeCompare(b));
      const rows = names.map(name => {
        const stat = stats.get(name) || {};
        return `<div class="budget-row"><span class="budget-name"><strong>${esc(name)}</strong><small>3-mo avg ${money(stat.sma3, true)} &middot; this month ${money(stat.mtd || 0, true)}</small></span>
          ${stat.sma3 ? `<button type="button" class="link-button" data-use-average="${Math.ceil(stat.sma3 / 10) * 10}">Use average</button>` : '<span></span>'}
          <label class="budget-input"><span>$</span><input type="number" inputmode="decimal" min="0" step="10" placeholder="No budget" aria-label="Monthly budget for ${esc(name)}" data-budget-category="${esc(name)}" value="${stat.budget ?? ''}"></label></div>`;
      }).join('');
      dialog.innerHTML = `<form method="dialog" class="budget-form"><div class="budget-head"><div><p class="eyebrow">MYFINANCE PRO &middot; BUDGETS</p><h2 id="budget-dialog-title">Monthly budgets</h2>
        <p class="muted">Set a monthly limit for the categories you want to watch. Progress and projected month-end appear on your dashboard. Leave blank for no budget.</p></div>
        <div class="budget-total"><small>Total budgeted</small><strong id="budget-total">$0</strong></div></div>
        <div class="budget-list">${rows || '<p class="muted">Import transactions to start budgeting.</p>'}</div>
        <p id="budget-error" role="alert"></p>
        <div class="pro-actions"><button type="button" class="btn btn-secondary" data-budget-cancel>Cancel</button><button type="submit" class="btn btn-primary">Save budgets</button></div></form>`;
      const inputs = [...dialog.querySelectorAll('[data-budget-category]')];
      const updateTotal = () => { $('budget-total').innerHTML = money(inputs.reduce((sum, input) => sum + (Number(input.value) || 0), 0), true); };
      updateTotal();
      dialog.querySelector('.budget-list').addEventListener('input', updateTotal);
      dialog.querySelectorAll('[data-use-average]').forEach(button => button.addEventListener('click', () => {
        button.closest('.budget-row').querySelector('input').value = button.dataset.useAverage;
        updateTotal();
      }));
      dialog.querySelector('[data-budget-cancel]').onclick = () => dialog.close();
      dialog.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const submit = event.target.querySelector('[type=submit]');
        submit.disabled = true;
        try {
          const budgets = inputs.map(input => ({ category: input.dataset.budgetCategory, amount: Number(input.value) || 0 })).filter(b => b.amount > 0);
          await request('/api/budgets', { method: 'PUT', body: JSON.stringify({ budgets }) });
          invalidateAnalytics();
          dialog.close();
          globalThis.notify?.(`Saved ${budgets.length} budget${budgets.length === 1 ? '' : 's'}.`);
          refreshCurrentView();
        } catch (error) { $('budget-error').textContent = error.message; }
        finally { submit.disabled = false; }
      };
    } catch (error) {
      dialog.innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" data-budget-close class="btn btn-secondary">Close</button>`;
      dialog.querySelector('[data-budget-close]').onclick = () => dialog.close();
    }
  }
  globalThis.FinancePro = { ensureEntitlement, isActive, isPlusActive, entitlement: () => state.entitlement, setEntitlement, getAnalytics, invalidateAnalytics,
    openUpgrade, requirePro, requireProPlus: requirePro, openBudgets, proTag, proSwitch, prefs, request, refreshCurrentView, format: { esc, money, pct }, ICONS, planLabel };
})();
