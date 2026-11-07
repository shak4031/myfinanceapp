/* Deterministic, household-scoped guidance. No prompts or financial data leave this app. */
(() => {
  const { escape: esc, money } = window.FinanceTools;
  const guides = {
    dashboard: ['Your financial overview', 'Check recorded balances and upcoming payments. Forecasts depend on current statements and correctly classified fixed bills and income.', 'accounts'],
    transactions: ['Make your history trustworthy', 'Import statements, review income detection and possible duplicates, correct categories, and add notes to explain important purchases.', 'transaction-review'],
    'transaction-review': ['Review before changing totals', 'Review classified transfers and flagged imports. A possible duplicate is not proof; compare accounts and amounts before merging.', 'transactions'],
    categories: ['Turn spending into a plan', 'Review Other, drill into your largest categories, and set monthly budgets with Pro. Categorization rules can handle recurring merchants.', 'category-admin'],
    'category-admin': ['Teach the app your categories', 'Review matching rules before applying them. Consistent merchant categories make budgets and findings more useful.', 'categories'],
    accounts: ['Keep accounts and sync healthy', 'Check connection status and the last successful sync. Classify accounts so transfers do not distort income and spending.', 'transactions'],
    analytics: ['Investigate the spending drivers', 'Compare category trends, recurring charges and unusual transactions. Spending Compass adds public benchmarks, not private customer data.', 'insights'],
    payoff: ['Build a realistic debt-free plan', 'Keep debt balances, APRs and minimum payments current. Compare strategies without committing money needed for essential bills.', 'goals'],
    goals: ['Give savings a realistic pace', 'Set targets, current savings and future deadlines. Check whether the modeled monthly contribution fits your available surplus.', 'insights'],
    insights: ['Your findings, not a score', 'Start with annualized take-home income, the biggest categories and merchants, and potentially discretionary purchases. Then review how debts and goals fit.', 'categories'],
    settings: ['You control access and guidance', 'Enable or disable this assistant here. Support tickets track case updates; access grants separately control consent to financial records.', 'knowledge-base'],
    subscription: ['Choose the tools you need', 'Basic covers transaction tracking and bank connections. Pro adds analytics, budgets, payoff and savings planning. This assistant does not change your subscription.', 'knowledge-base'],
    tutorials: ['Learn by following a tour', 'Choose a short walkthrough, then try its steps on your own workspace. The knowledge base explains features and common problems.', 'knowledge-base'],
    'knowledge-base': ['Find the right workflow', 'Browse import, categorization, budgeting, debt, savings and support guides. Start with the feature relevant to your next financial decision.', 'tutorials'],
    activity: ['See what changed', 'Review recorded actions when investigating an unexpected change. Ticket updates are in Settings & support.', 'settings'],
    etl: ['Review import warnings', 'Compare flagged bank imports with existing records before choosing how to resolve them.', 'transactions']
  };
  const host = document.createElement('aside');
  host.id = 'finance-assistant';
  host.hidden = true;
  host.setAttribute('aria-label', 'MyFinance assistant');
  document.body.appendChild(host);
  let enabled = false, minimized = false, generation = 0, requestId = 0, userId = null;
  let currentView = 'dashboard', findings = null, errorMessage = '', loadedAt = 0, timer = null;
  const eligible = () => window.FinanceSession.isAuthenticated() && !window.FinanceSession.currentSupport();
  const key = () => `myfinance.assistant.${userId}.enabled`;
  function preferenceStatus(message) {
    const node = document.getElementById('assistant-preference-status');
    if (node) node.textContent = message;
  }
  function syncControl() {
    const node = document.getElementById('assistant-enabled');
    if (node) { node.checked = enabled; node.disabled = !eligible(); }
  }
  function render() {
    syncControl();
    host.hidden = !enabled || !eligible();
    if (host.hidden) { host.innerHTML = ''; return; }
    if (minimized) {
      host.innerHTML = '<button class="btn btn-primary assistant-launcher" data-assistant="expand" aria-expanded="false">MyFinance guide</button>';
      return;
    }
    const guide = guides[currentView] || guides.dashboard;
    const signals = findings?.signals || [];
    // Prioritize the current workflow, while retaining data-health warnings.
    const relevant = [...signals.filter(row => row.route === currentView), ...signals.filter(row => row.route !== currentView)];
    host.innerHTML = `<section class="assistant-panel" aria-labelledby="assistant-title">
      <header><h2 id="assistant-title">MyFinance guide</h2><button class="btn btn-secondary" data-assistant="minimize" aria-label="Minimize assistant">Minimize</button><button class="btn btn-secondary" data-assistant="disable">Turn off</button></header>
      <p class="muted">Private, rule-based guidance. No automatic changes.</p>
      <article><h3>${esc(guide[0])}</h3><p>${esc(guide[1])}</p><a href="#${guide[2]}" data-view="${guide[2]}">Explore this workflow</a></article>
      <div role="status">${errorMessage ? `${esc(errorMessage)} <button class="btn btn-secondary" data-assistant="refresh">Retry</button>` : !findings ? 'Reviewing your workspace...' : ''}</div>
      ${relevant.map(signal => `<article><h3>${esc(signal.title)}</h3><p>${esc(signal.detail)}</p>
        <a class="${signal.action?.startsWith('note:') ? 'transaction-link' : ''}" href="#${signal.action?.startsWith('note:') ? `transactions/${signal.action.slice(5)}` : signal.route}" data-view="${signal.route}" ${signal.action === 'duplicates' ? 'data-transaction-duplicates' : ''} ${signal.action === 'import' ? 'data-assistant-import' : ''}>Review now</a></article>`).join('')}
      <footer><button class="btn btn-secondary" data-assistant="refresh">Refresh guidance</button><a href="#settings" data-view="settings">Assistant settings</a></footer>
    </section>`;
  }
  async function load(force = false) {
    if (!enabled || !eligible() || currentView === 'subscription') return;
    if (!force && findings && Date.now() - loadedAt < 60000) { render(); return; }
    const session = generation, request = ++requestId;
    errorMessage = '';
    render();
    try {
      const response = await fetch('/api/guidance');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to load guidance.');
      if (session !== generation || request !== requestId || !enabled || !eligible()) return;
      findings = data; loadedAt = Date.now();
    } catch (error) {
      if (session !== generation || request !== requestId || !enabled || !eligible()) return;
      findings = null;
      errorMessage = `Guidance unavailable: ${error.message}`;
    }
    render();
  }
  function setEnabled(value) {
    enabled = value;
    generation++; findings = null; loadedAt = 0; errorMessage = '';
    if (timer) clearTimeout(timer);
    try { localStorage.setItem(key(), value ? 'on' : 'off'); preferenceStatus(value ? 'Assistant enabled for this login in this browser.' : 'Assistant disabled.'); }
    catch (error) { preferenceStatus('The browser could not save this preference. It applies only until reload.'); console.warn('Assistant preference could not be saved:', error.name); }
    render();
    if (enabled) load(true);
  }
  function reset() {
    generation++; requestId++; enabled = false; minimized = false; userId = null;
    findings = null; errorMessage = ''; loadedAt = 0;
    if (timer) clearTimeout(timer);
    timer = null; host.hidden = true; host.innerHTML = '';
  }
  function onView(view) {
    if (!eligible()) { reset(); syncControl(); return; }
    const id = window.FinanceSession.currentUser().id;
    if (userId !== id) {
      reset(); userId = id;
      try { enabled = localStorage.getItem(key()) === 'on'; }
      catch (error) { preferenceStatus('Assistant preference storage is unavailable. You can enable it for this session.'); console.warn('Assistant preference could not be read:', error.name); }
    }
    currentView = view; render();
    if (enabled) load();
  }
  function invalidate() {
    loadedAt = 0;
    if (!enabled || !eligible()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; load(true); }, 750);
  }
  document.addEventListener('change', event => {
    if (event.target.id === 'assistant-enabled' && eligible()) setEnabled(event.target.checked);
  });
  host.addEventListener('click', event => {
    if (event.target.closest('[data-assistant-import]')) { event.preventDefault(); window.openImportModal(); return; }
    const action = event.target.closest('[data-assistant]')?.dataset.assistant;
    if (action === 'disable') setEnabled(false);
    else if (action === 'refresh') load(true);
    else if (action === 'minimize' || action === 'expand') {
      minimized = action === 'minimize'; render();
      host.querySelector('button')?.focus();
    }
  });
  host.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !minimized) { minimized = true; render(); host.querySelector('button')?.focus(); }
  });
  window.addEventListener('focus', () => { if (enabled && Date.now() - loadedAt >= 60000) load(true); });
  function renderFindings(data) {
    const period = data.period;
    const list = rows => rows.length ? `<ol>${rows.map(row => `<li><strong>${esc(row.name)}</strong>: ${money(row.amount)} (${row.count} transactions)</li>`).join('')}</ol>` : '<p>No recorded spending in this group.</p>';
    const extras = data.discretionary;
    return `<section class="checkup-findings panel" aria-labelledby="findings-title"><p class="checkup-kicker">SUMMARY OF FINDINGS</p><h2 id="findings-title">What your recorded activity says</h2>
      <p>${period.months ? `${esc(period.from)} through ${esc(period.to)}: ${period.months} recorded completed months.` : 'Import completed-month history to build your summary.'}</p>
      <h3>Estimated annual take-home income: ${data.annualIncome === null ? 'Not enough recognized income' : money(data.annualIncome)}</h3>
      <p>${data.monthlyIncome === null ? 'Review income detection or import payroll history.' : `Based on ${money(data.monthlyIncome)} in recognized monthly income, multiplied by 12. This is not a prediction of gross salary.`}</p>
      ${data.monthlyIncome !== null && data.monthlySpend > data.monthlyIncome ? `<p class="checkup-findings-warning"><strong>Spending exceeds recognized income by ${money(data.monthlySpend - data.monthlyIncome)} per month.</strong> Reduce flexible costs or review missing income before adding new commitments.</p>` : ''}
      <div class="checkup-findings-grid"><div><h3>Largest spending categories</h3>${list(data.categories)}</div><div><h3>Largest spending merchants</h3>${list(data.merchants)}</div></div>
      <h3>${money(extras.total)} in potentially discretionary purchases</h3>
      <p>${extras.share === null ? 'No recorded spending to compare.' : `${extras.share}% of recorded spending; ${money(extras.annualized)} at an annualized pace.`} Dining, shopping and similar purchases deserve a deliberate review, especially when they displace savings or debt payments. Not every purchase in these categories is optional.</p>
      <div class="checkup-findings-grid"><div><h3>Where those purchases went</h3>${list(extras.categories)}</div><div><h3>Merchants driving those purchases</h3>${list(extras.merchants)}</div></div>
      <details><summary>How this summary is calculated</summary><p>${esc(data.methodology)}</p></details>
      <a href="#transactions" data-view="transactions">Review the underlying transactions</a></section>`;
  }
  window.FinanceAssistant = { onView, reset, invalidate, renderFindings };
})();
