// MyFinance Pro: plan state, upgrade/trial dialog, lock badges and the budget editor.
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
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (response.status === 402) {
      if (data?.entitlement) setEntitlement(data.entitlement);
      const error = new Error(data?.error || 'This feature is part of MyFinance Pro');
      error.code = 'PRO_REQUIRED';
      throw error;
    }
    if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
    return data;
  }

  function setEntitlement(entitlement) {
    state.entitlement = entitlement;
    document.body?.classList?.toggle('has-pro', !!entitlement?.active);
    renderPlanChrome();
    globalThis.emitFinanceEvent?.('pro:entitlement', entitlement);
  }
  function ensureEntitlement(force = false) {
    if (!force && state.entitlement) return Promise.resolve(state.entitlement);
    if (!force && state.entitlementPromise) return state.entitlementPromise;
    state.entitlementPromise = request('/api/license')
      .then(entitlement => { setEntitlement(entitlement); return entitlement; })
      .catch(() => { setEntitlement({ tier: 'free', active: false, trialAvailable: false, plan: { name: 'MyFinance Pro', price: 4.99 }, features: [] }); return state.entitlement; })
      .finally(() => { state.entitlementPromise = null; });
    return state.entitlementPromise;
  }
  const isActive = () => !!state.entitlement?.active;

  function getAnalytics(force = false) {
    if (!force && state.analytics && Date.now() - state.analyticsAt < 15000) return Promise.resolve(state.analytics);
    if (!force && state.analyticsPromise) return state.analyticsPromise;
    state.analyticsPromise = request('/api/analytics')
      .then(data => { state.analytics = data; state.analyticsAt = Date.now(); return data; })
      .finally(() => { state.analyticsPromise = null; });
    return state.analyticsPromise;
  }
  const invalidateAnalytics = () => { state.analytics = null; state.analyticsAt = 0; };

  function planLabel(entitlement = state.entitlement) {
    if (!entitlement) return { tone: 'free', title: 'Free plan', detail: 'Unlock Pro' };
    if (entitlement.tier === 'pro') return { tone: 'pro', title: 'MyFinance Pro', detail: entitlement.source === 'owner' ? 'Owner license' : entitlement.source === 'demo' ? 'Demo license' : 'Active' };
    if (entitlement.tier === 'trial') return { tone: 'trial', title: 'Pro trial', detail: `${entitlement.daysLeft} day${entitlement.daysLeft === 1 ? '' : 's'} left` };
    return { tone: 'free', title: 'Free plan', detail: entitlement.trialAvailable ? 'Try Pro free for 7 days' : 'Upgrade to Pro' };
  }

  function renderPlanChrome() {
    const label = planLabel();
    const badge = $('pro-nav-badge');
    if (badge) {
      badge.className = `pro-nav-badge is-${label.tone}`;
      badge.innerHTML = label.tone === 'free' ? `${ICONS.lock}PRO` : label.tone === 'trial' ? `TRIAL &middot; ${state.entitlement.daysLeft}D` : 'PRO';
    }
    const bottom = document.querySelector?.('.sidebar-bottom');
    if (!bottom || typeof bottom.insertBefore !== 'function') return;
    let chip = $('plan-chip');
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'plan-chip';
      chip.type = 'button';
      chip.addEventListener('click', () => openUpgrade());
      bottom.insertBefore(chip, bottom.firstChild);
    }
    chip.className = `plan-chip is-${label.tone}`;
    chip.innerHTML = `<span class="plan-chip-icon">${label.tone === 'free' ? ICONS.lock : ICONS.spark}</span><span><strong>${esc(label.title)}</strong><small>${esc(label.detail)}</small></span>`;
  }

  // A small "PRO"/lock tag for controls that need the paid plan.
  const proTag = () => isActive() ? '<span class="pro-tag">PRO</span>' : `<span class="pro-tag is-locked">${ICONS.lock}PRO</span>`;
  const proSwitch = (id, label, on) => `<button type="button" class="pro-switch${isActive() ? '' : ' is-locked'}" role="switch" aria-checked="${on && isActive() ? 'true' : 'false'}" data-pro-switch="${esc(id)}"><span class="pro-switch-track" aria-hidden="true"><span></span></span><span>${esc(label)}</span>${proTag()}</button>`;

  function dialogShell(id, className, labelledBy) {
    let dialog = $(id);
    if (dialog && dialog.tagName) return dialog;
    dialog = document.createElement('dialog');
    dialog.id = id;
    dialog.className = `editor ${className}`;
    dialog.setAttribute('aria-labelledby', labelledBy);
    document.body.appendChild(dialog);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    return dialog;
  }

  function openUpgrade(reason = '') {
    const entitlement = state.entitlement || {};
    const dialog = dialogShell('pro-dialog', 'pro-dialog', 'pro-dialog-title');
    const plan = entitlement.plan || { name: 'MyFinance Pro', price: 4.99 };
    const supportSession = !!globalThis.FinanceSession?.currentSupport?.();
    let status = '', action = '';
    if (entitlement.tier === 'pro') {
      status = `<p class="pro-status is-pro">${ICONS.check}<span>Pro is active on this account${entitlement.source === 'owner' ? ' (owner license)' : entitlement.source === 'demo' ? ' (demo account)' : ''}. Every insight is unlocked.</span></p>`;
      action = '<button type="button" class="btn btn-primary" data-pro-close>Explore analytics</button>';
    } else if (entitlement.tier === 'trial') {
      status = `<p class="pro-status is-trial">${ICONS.spark}<span>Your free trial is active &middot; <strong>${entitlement.daysLeft} day${entitlement.daysLeft === 1 ? '' : 's'} left</strong>. Ask your MyFinance administrator to keep Pro after it ends.</span></p>`;
      action = '<button type="button" class="btn btn-primary" data-pro-close>Keep exploring</button>';
    } else if (entitlement.trialAvailable && !supportSession) {
      status = '<p class="pro-status">No card needed. Your 7-day trial starts now and ends on its own &mdash; nothing is charged.</p>';
      action = '<button type="button" class="btn btn-primary" data-pro-trial>Start 7-day free trial</button>';
    } else {
      const ended = entitlement.trialEndsAt ? ` on ${new Date(entitlement.trialEndsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}` : '';
      status = `<p class="pro-status is-locked">${ICONS.lock}<span>${entitlement.source === 'trial-expired' ? `Your free trial ended${esc(ended)}.` : 'Pro is not active on this account.'} Ask your MyFinance administrator to upgrade you to Pro.</span></p>`;
      action = '<button type="button" class="btn btn-primary" data-pro-close>Got it</button>';
    }
    const features = (entitlement.features?.length ? entitlement.features : []).map(feature =>
      `<li><span class="pro-feature-icon">${ICONS[feature.id] || ICONS.spark}</span><span><strong>${esc(feature.title)}</strong><small>${esc(feature.text)}</small></span></li>`).join('');
    dialog.innerHTML = `<div class="pro-hero"><span class="pro-hero-mark">${ICONS.spark}</span><p class="eyebrow">MYFINANCE PRO</p>
      <h2 id="pro-dialog-title">See your money the way a trader sees a market</h2>
      ${reason ? `<p class="pro-reason">${esc(reason)}</p>` : ''}
      <div class="pro-price"><strong>$${Number(plan.price || 4.99).toFixed(2)}</strong><span>/ month</span><em>${esc(plan.name || 'MyFinance Pro')}</em></div></div>
      <ul class="pro-feature-grid">${features}</ul>
      <div class="pro-dialog-foot">${status}<div class="pro-actions"><button type="button" class="btn btn-secondary" data-pro-close>Not now</button>${action}</div></div>`;
    dialog.querySelectorAll('[data-pro-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.querySelector('[data-pro-trial]')?.addEventListener('click', async event => {
      event.target.disabled = true;
      try {
        setEntitlement(await request('/api/license/trial', { method: 'POST', body: '{}' }));
        invalidateAnalytics();
        dialog.close();
        globalThis.notify?.('Your 7-day MyFinance Pro trial has started. Enjoy the insights!');
        refreshCurrentView();
      } catch (error) {
        event.target.disabled = false;
        globalThis.notify?.(error.message);
        await ensureEntitlement(true);
        openUpgrade(reason);
      }
    });
    if (!dialog.open) dialog.showModal();
    return false;
  }

  // Returns true when Pro is active; otherwise explains the feature and offers the trial.
  function requirePro(reason) {
    if (isActive()) return true;
    openUpgrade(reason);
    return false;
  }

  function refreshCurrentView() {
    const view = location.hash.slice(1) || 'dashboard';
    globalThis.showView?.(view);
  }

  async function openBudgets() {
    if (!requirePro('Budgets are part of MyFinance Pro.')) return;
    const dialog = dialogShell('budget-dialog', 'budget-dialog', 'budget-dialog-title');
    dialog.innerHTML = '<div class="budget-loading">Loading your categories&hellip;</div>';
    if (!dialog.open) dialog.showModal();
    try {
      const [analytics, categoryList] = await Promise.all([getAnalytics(), request('/api/categories').catch(() => [])]);
      const stats = new Map(analytics.categories.map(category => [category.name, category]));
      const names = [...new Set([...analytics.categories.filter(c => !c.transfer).map(c => c.name), ...(Array.isArray(categoryList) ? categoryList : []).map(c => c.name)])]
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
      dialog.querySelector('[data-budget-cancel]').addEventListener('click', () => dialog.close());
      dialog.querySelector('form').addEventListener('submit', async event => {
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
        } catch (error) {
          $('budget-error').textContent = error.message;
          submit.disabled = false;
        }
      });
    } catch (error) {
      dialog.innerHTML = `<div class="budget-loading">${esc(error.message)}</div>`;
    }
  }

  // Start loading the plan as soon as the signed-in workspace appears.
  const baseShowView = globalThis.showView;
  if (typeof baseShowView === 'function') {
    globalThis.showView = function(view) {
      baseShowView(view);
      if (globalThis.FinanceSession?.isAuthenticated?.() && !state.entitlement) ensureEntitlement();
    };
  }

  globalThis.FinancePro = {
    ensureEntitlement, isActive, entitlement: () => state.entitlement, setEntitlement, getAnalytics, invalidateAnalytics,
    openUpgrade, requirePro, openBudgets, proTag, proSwitch, prefs, request, refreshCurrentView,
    format: { esc, money, pct }, ICONS, planLabel
  };
})();
