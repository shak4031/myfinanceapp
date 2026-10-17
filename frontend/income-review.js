// Income review: lets people confirm which deposits are real pay, so payday forecasts never rely on a wrong guess.
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const money = value => (Number(value) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const day = value => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';
  const BY = {
    you: ['by-you', 'Your choice'],
    category: ['by-category', 'Category'],
    wording: ['by-wording', 'Description'],
    fixed: ['by-fixed', 'Marked fixed'],
    auto: ['by-auto', 'Automatic']
  };

  const dialog = document.createElement('dialog');
  dialog.id = 'income-review';
  dialog.className = 'editor income-review';
  dialog.setAttribute('aria-labelledby', 'income-review-title');
  dialog.innerHTML = `
    <header class="ir-head">
      <div>
        <p class="eyebrow">PAYDAY FORECAST</p>
        <h2 id="income-review-title">What counts as your pay?</h2>
        <p class="muted">We use regular deposits to predict when money lands in Upcoming and your plan. Money from friends, refunds or one-offs can look regular &mdash; switch those to <strong>Not income</strong>.</p>
      </div>
      <button type="button" class="ir-close" data-ir-close aria-label="Close income review">&times;</button>
    </header>
    <div id="income-review-summary" class="ir-summary" aria-live="polite"></div>
    <div id="income-review-body" class="ir-body"></div>
    <p id="income-review-error" class="ir-error" role="alert"></p>
    <footer class="ir-foot"><span class="muted">Changes apply to past deposits and new imports from the same sender.</span><button type="button" class="btn btn-primary" data-ir-close>Done</button></footer>`;
  document.body.appendChild(dialog);

  let sources = [], focusKey = null, changed = false, busy = false;

  const segment = source => {
    const on = role => source.status === role ? ' aria-pressed="true"' : ' aria-pressed="false"';
    return `<div class="ir-seg" role="group" aria-label="Does ${esc(source.name)} count as income?">
      <button type="button" data-ir-role="income"${on('income')}><span aria-hidden="true">💸</span> Income</button>
      <button type="button" data-ir-role="other"${on('other')}>Not income</button>
    </div>`;
  };
  const deposit = tx => `<li class="${tx.counted ? 'is-counted' : ''}">
      <label><input type="checkbox" data-ir-tx="${esc(tx.id)}" ${tx.counted ? 'checked' : ''} aria-label="Count ${esc(tx.description)} on ${esc(day(tx.date))} as income">
      <span class="ir-dep-date">${esc(day(tx.date))}</span>
      <span class="ir-dep-desc">${esc(tx.description)}<small>${esc(tx.category || 'Uncategorized')}${tx.by === 'you' ? ' &middot; your choice' : ''}</small></span>
      <span class="ir-dep-amt">+${money(tx.amount)}</span></label>
    </li>`;
  const card = source => {
    const [byClass, byLabel] = BY[source.by] || BY.auto;
    const cadence = source.regular && source.cadenceLabel ? `<span class="ir-cadence">${esc(source.cadenceLabel)}</span>` : '<span class="ir-cadence is-irregular">Irregular</span>';
    const mixed = source.status === 'mixed' ? `<p class="ir-mixed">${source.counted} of ${source.count} deposits count as income &mdash; pick one to make them consistent.</p>` : '';
    return `<article class="ir-card is-${esc(source.status)}${source.key === focusKey ? ' is-focus' : ''}" data-ir-key="${esc(source.key)}">
      <div class="ir-avatar" aria-hidden="true">${esc(initials(source.name))}</div>
      <div class="ir-main">
        <h3>${esc(source.name)} ${cadence}</h3>
        <p class="ir-meta">avg <strong>${money(source.average)}</strong> &middot; ${source.count} deposit${source.count === 1 ? '' : 's'} &middot; last ${esc(day(source.lastDate))}</p>
        <p class="ir-reason"><span class="ir-by ${byClass}">${byLabel}</span>${esc(source.reason)}</p>
        ${mixed}
      </div>
      <div class="ir-actions">
        ${segment(source)}
        ${source.by === 'you' ? '<button type="button" class="ir-reset" data-ir-role="auto">Reset to automatic</button>' : ''}
      </div>
      <details class="ir-deposits"${source.key === focusKey ? ' open' : ''}>
        <summary>See ${source.transactions.length === source.count ? '' : 'recent '}deposits</summary>
        <ul>${source.transactions.map(deposit).join('')}</ul>
      </details>
    </article>`;
  };

  function render() {
    const counted = sources.filter(source => source.status !== 'other');
    const other = sources.filter(source => source.status === 'other');
    const yours = sources.filter(source => source.by === 'you').length;
    const monthly = counted.filter(source => source.regular && source.expected).reduce((sum, source) => {
      const perMonth = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1 }[source.cadence] || 1;
      return sum + source.expected * perMonth;
    }, 0);
    $('income-review-summary').innerHTML = sources.length ? `
      <span class="ir-chip is-income"><strong>${counted.length}</strong> counted as pay</span>
      <span class="ir-chip"><strong>${other.length}</strong> not counted</span>
      ${monthly ? `<span class="ir-chip is-money">≈ <strong>${money(monthly)}</strong>/mo expected</span>` : ''}
      ${yours ? `<span class="ir-chip is-you"><strong>${yours}</strong> set by you</span>` : ''}` : '';
    const section = (title, hint, list) => list.length ? `<section class="ir-section"><h3 class="ir-section-title">${title}<small>${hint}</small></h3>${list.map(card).join('')}</section>` : '';
    $('income-review-body').innerHTML = sources.length
      ? section('Counted as income', 'Used to forecast paydays', counted) + section('Not counted', 'Repeat deposits we ignore when forecasting', other)
      : '<div class="ir-empty"><span aria-hidden="true">🪙</span><p><strong>No deposits to review yet.</strong> Import a few months of statements and your pay will show up here.</p></div>';
    const focus = focusKey && [...dialog.querySelectorAll('[data-ir-key]')].find(el => el.dataset.irKey === focusKey);
    if (focus) setTimeout(() => focus.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60);
  }

  async function load() {
    $('income-review-error').textContent = '';
    const response = await fetch('/api/transactions/income-sources');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load your deposits.');
    sources = data.sources || [];
    render();
  }

  async function setRole(ids, role) {
    if (busy || !ids.length) return;
    busy = true;
    dialog.classList.add('is-busy');
    try {
      const response = await fetch('/api/transactions/update-income-role', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids.map(Number), income_role: role })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save that change.');
      changed = true;
      await load();
    } catch (error) {
      $('income-review-error').textContent = error.message;
    } finally {
      busy = false;
      dialog.classList.remove('is-busy');
    }
  }

  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.closest('[data-ir-close]')) return dialog.close();
    const button = event.target.closest('[data-ir-role]');
    if (!button) return;
    const source = sources.find(item => item.key === button.closest('[data-ir-key]')?.dataset.irKey);
    if (!source) return;
    const role = button.dataset.irRole === 'auto' ? null : button.dataset.irRole;
    focusKey = source.key;
    setRole(source.ids || source.transactions.map(tx => tx.id), role).then(() => {
      if (window.notify) window.notify(role === null ? `${source.name} is back to automatic detection.` : `${source.name} ${role === 'income' ? 'now counts as income' : 'no longer counts as income'}.`);
    });
  });
  dialog.addEventListener('change', event => {
    const box = event.target.closest('[data-ir-tx]');
    if (!box) return;
    focusKey = box.closest('[data-ir-key]')?.dataset.irKey || focusKey;
    setRole([box.dataset.irTx], box.checked ? 'income' : 'other');
  });
  dialog.addEventListener('close', () => {
    if (!changed) return;
    changed = false;
    window.FinancePlan?.invalidate?.();
    const active = document.querySelector('.view.active')?.id;
    if (active === 'dashboard-view' && typeof window.loadDashboard === 'function') window.loadDashboard();
    if (active === 'transactions-view' && typeof window.loadAllTransactions === 'function') window.loadAllTransactions();
    if ((active === 'payoff-view' || active === 'goals-view') && window.FinancePlan?.refresh) window.FinancePlan.refresh().then(window.FinancePlan.renderAll).catch(() => {});
  });

  async function open(key) {
    focusKey = key || null;
    sources = [];
    $('income-review-summary').innerHTML = '';
    $('income-review-body').innerHTML = '<div class="ir-loading" aria-busy="true"><span></span><span></span><span></span></div>';
    if (!dialog.open) dialog.showModal();
    try { await load(); } catch (error) {
      $('income-review-body').innerHTML = '';
      $('income-review-error').textContent = error.message;
    }
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest?.('[data-income-review], [data-income-key]');
    if (!trigger || dialog.contains(trigger)) return;
    if (trigger.matches('[data-income-key]') && event.target.closest('button:not([data-income-review])')) return;
    event.preventDefault();
    open(trigger.dataset.incomeKey);
  });
  document.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-income-key]')) { event.preventDefault(); open(event.target.dataset.incomeKey); }
  });

  window.FinanceIncome = { open, reload: load };
})();
