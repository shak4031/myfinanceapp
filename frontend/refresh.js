/* Original, server-local planning and review tools; no external integrations. */
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const money = value => value == null || !Number.isFinite(Number(value)) ? 'Not enough data' : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const fixed = value => value === true || value === 1 || value === 'true';
  const json = async (url, method = 'GET', body) => {
    const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  };
  let debts = [], goals = [], rules = [], categories = [], suggestions = [];
  let goalEditing = null;
  window.clearFinanceState = () => { debts = []; goals = []; rules = []; categories = []; suggestions = []; goalEditing = null; debtEditing = null; };
  const reportError = error => notify(error.message || 'Something went wrong. Please try again.');
  window.removeFixedTemplate = async id => {
    if (!confirm('Remove the Fixed flag from this merchant’s matching transactions? This stops its bill projection; no transactions are deleted.')) return;
    try {
      await json('/api/transactions/update-fixed', 'POST', { id, is_fixed: false, apply_to_all: true });
      await loadDashboard(); notify('Fixed flag removed from matching transactions.');
    } catch (error) { reportError(error); }
  };
  function selectImportFile(kind, file) {
    if (!file) return;
    if (kind === 'csv') pendingCsvFile = file;
    else pendingPdfFile = file;
    $(`${kind}-file-list`).textContent = `${file.name} · ${Math.round(file.size / 1024)} KB`;
    $(`${kind}-import-btn`).disabled = false;
  }
  window.onCsvSelected = event => selectImportFile('csv', event.target.files[0]);
  window.onPdfSelected = event => selectImportFile('pdf', event.target.files[0]);
  window.handleCsvDrop = event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && (file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv')) selectImportFile('csv', file); };
  window.handlePdfDrop = event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file?.type === 'application/pdf') selectImportFile('pdf', file); };

  // Navigation is explicit: labels can change without breaking the active state.
  window.showView = function(view) {
    if (!FinanceSession.isAuthenticated()) return;
    document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `${view}-view`));
    document.querySelectorAll('.nav-btn').forEach(node => node.classList.toggle('active', node.getAttribute('onclick') === `showView('${view}')`));
    closeSidebar();
    location.hash = view;
    const loaders = { dashboard: loadDashboard, categories: loadCategories, transactions: loadAllTransactions, etl: loadEtlStaging, payoff: loadPayoffPlan, goals: loadGoals, insights: generateInsights };
    Promise.resolve(loaders[view]?.()).catch(reportError);
  };

  const review = document.createElement('div');
  review.className = 'panel plan-card';
  review.innerHTML = `<div><p class="eyebrow">A QUICKER WAY TO KEEP THINGS ORGANIZED</p><h2>Review category suggestions</h2><p class="muted">Start with transactions that need a category. Check the suggestions, adjust any category that looks wrong, then apply them together. Nothing changes until you approve.</p></div>
    <div class="toolbar"><label>Show <select id="review-scope"><option value="uncategorized">Needs a category</option><option value="all">All transactions</option></select></label><button id="preview-button" class="btn btn-primary">Find suggestions</button><button id="approve-button" class="btn btn-secondary" disabled>Apply selected</button><button id="approve-all-button" class="btn btn-secondary" disabled>Apply all suggestions</button></div>
    <label class="remember-merchant"><input id="remember-merchants" type="checkbox"> Remember these exact merchant descriptions for future imports</label>
    <p id="review-status" role="status"></p><div id="category-preview" class="table-scroll"></div>
    <details><summary>Saved merchant rules · manage what the app remembers</summary><p class="muted">Rules apply to future imports. Edit or turn off a rule if the same merchant sometimes belongs in a different category.</p>
    <label class="rule-search-label">Find a saved merchant<input id="rule-search" type="search" placeholder="Search merchant or category"></label>
    <div id="merchant-rules" class="table-scroll"></div>
    <form id="rule-form" class="toolbar"><label>Merchant text<input id="rule-pattern" required maxlength="200" placeholder="Merchant as shown on statement"></label><label>Display name (optional)<input id="rule-label" maxlength="100" placeholder="e.g. Local grocery store"></label><label>Category<select id="rule-category" required></select></label><label class="advanced-priority">Priority<input id="rule-priority" type="number" min="0" max="1000" value="100" step="1" required></label><button class="btn btn-primary">Add merchant rule</button></form></details>`;
  $('categories-view').prepend(review);
  $('cat-fixed-selector').remove();
  const categoryOptions = selected => categories.map(category => `<option value="${escape(category.name)}" ${selected === category.name ? 'selected' : ''}>${escape(category.name)}</option>`).join('');
  window.loadCategories = async function() {
    const [data, summary] = await Promise.all([
      json('/api/transactions/categorization-rules'),
      json('/api/categorizations/category-summary', 'POST')
    ]);
    rules = data.rules || []; categories = data.categories || [];
    const counts = new Map((summary.categories || []).map(item => [item.category, Number(item.count) || 0]));
    $('rule-category').innerHTML = categoryOptions('');
    $('cat-list').innerHTML = '';
    for (const category of categories) {
      const button = document.createElement('button');
      button.className = 'nav-btn';
      button.textContent = `${category.name} · ${counts.get(category.name) || 0}`;
      button.setAttribute('aria-label', `${category.name}, ${counts.get(category.name) || 0} transactions`);
      button.onclick = () => loadCategoryMonths(category.name).catch(reportError);
      $('cat-list').appendChild(button);
    }
    $('merchant-rules').innerHTML = `<table class="review-table rule-table"><thead><tr><th>Merchant</th><th>Category</th><th>Priority</th><th>Enabled</th><th></th></tr></thead><tbody>${rules.map((rule, index) => `<tr data-rule="${index}" data-rule-search="${escape(`${rule.display_label || ''} ${rule.pattern} ${rule.category || ''}`.toLowerCase())}"><td><strong>${escape(rule.display_label || rule.pattern)}</strong><details class="rule-edit"><summary>Edit merchant name</summary><input data-rule-pattern aria-label="Merchant text" maxlength="256" value="${escape(rule.pattern)}"><label>Display name<input data-rule-label aria-label="Display name" value="${escape(rule.display_label)}"></label></details></td><td><select aria-label="Rule category">${categoryOptions(rule.category)}</select></td><td><details class="rule-edit"><summary>Advanced</summary><input aria-label="Rule priority" type="number" min="0" max="1000" step="1" value="${Number(rule.priority) || 0}"></details></td><td><input aria-label="Rule enabled" type="checkbox" ${fixed(rule.enabled) ? 'checked' : ''}></td><td><button class="btn btn-secondary" data-save-rule="${index}">Save</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No saved merchant rules yet. Apply a suggestion and choose “Remember these exact merchant descriptions” to build them.</td></tr>'}</tbody></table>`;
  };
  $('rule-search').oninput = () => {
    const query = $('rule-search').value.trim().toLowerCase();
    $('merchant-rules').querySelectorAll('[data-rule]').forEach(row => { row.hidden = !row.dataset.ruleSearch.includes(query); });
  };
  $('merchant-rules').onclick = async event => {
    const button = event.target.closest('[data-save-rule]');
    if (!button) return;
    const row = button.closest('tr');
    button.disabled = true;
    try {
      const priority = Number(row.querySelector('input[type=number]').value);
      if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new Error('Priority must be a whole number from 0 to 1000.');
      await json(`/api/transactions/categorization-rules/${encodeURIComponent(rules[Number(button.dataset.saveRule)].id)}`, 'PUT', { pattern: row.querySelector('[data-rule-pattern]').value.trim(), display_label: row.querySelector('[data-rule-label]').value.trim(), category: row.querySelector('select').value, priority, enabled: row.querySelector('input[type=checkbox]').checked });
      suggestions = []; $('category-preview').textContent = ''; $('approve-button').disabled = true; $('approve-all-button').disabled = true;
      notify('Rule saved. Preview again to see its effect.');
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
  $('rule-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      await json('/api/transactions/categorization-rules', 'POST', { pattern: $('rule-pattern').value.trim(), display_label: $('rule-label').value.trim(), category: $('rule-category').value, priority: Number($('rule-priority').value), enabled: true });
      suggestions = []; $('category-preview').textContent = ''; $('approve-button').disabled = true; $('approve-all-button').disabled = true;
      event.target.reset(); await loadCategories(); notify('Rule added. Preview before applying.');
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
  $('preview-button').onclick = async () => {
    $('preview-button').disabled = true;
    $('approve-button').disabled = true; $('approve-all-button').disabled = true;
    suggestions = []; $('category-preview').textContent = '';
    try {
      const data = await json('/api/transactions/categorization-preview', 'POST', { scope: $('review-scope').value });
      suggestions = data.suggestions || [];
      const warnings = data.invalidRules || [];
      $('review-status').textContent = `${suggestions.length} suggestions found · ${data.unchanged || 0} already look good or were left unchanged.${warnings.length ? ` ${warnings.length} older rule${warnings.length === 1 ? '' : 's'} need attention; valid suggestions are still available below.` : ''}`;
      $('category-preview').innerHTML = `${warnings.length ? `<div class="coach-note warning" role="status"><strong>Some older rules need repair</strong><p>These rules were skipped so they cannot block other suggestions. Edit or disable them under Saved merchant rules.</p><ul>${warnings.map(rule => `<li>${escape(rule.message)}</li>`).join('')}</ul></div>` : ''}${suggestions.length ? `<table class="review-table"><thead><tr><th><input id="select-suggestions" type="checkbox" aria-label="Select all suggestions"></th><th>Transaction</th><th>Current</th><th>Suggested category</th><th>Match</th></tr></thead><tbody>${suggestions.map((item, index) => `<tr><td><input type="checkbox" data-suggestion="${index}" aria-label="Select ${escape(item.description)}"></td><td><strong>${escape(item.description)}</strong><div class="muted">${escape(item.date || '')}${item.amount == null ? '' : ` · ${money(item.amount)}`}</div></td><td>${escape(item.currentCategory || 'Uncategorized')}</td><td><select data-suggestion-category="${index}" aria-label="Category for ${escape(item.description)}">${categoryOptions(item.suggestedCategory)}</select></td><td><span title="${escape(item.reason)}">${escape(item.reason)}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No changes suggested. Your existing categories are untouched.</p>'}`;
      $('approve-all-button').disabled = !suggestions.length;
    } catch (error) { $('review-status').textContent = error.message; }
    finally { $('preview-button').disabled = false; }
  };
  $('category-preview').onchange = event => {
    if (event.target.id === 'select-suggestions') $('category-preview').querySelectorAll('[data-suggestion]').forEach(node => { node.checked = event.target.checked; });
    $('approve-button').disabled = !$('category-preview').querySelector('[data-suggestion]:checked');
  };
  async function applySuggestions(selected, confirmAll = false) {
    const updates = selected.map(node => {
      const item = suggestions[Number(node.dataset.suggestion)];
      return { id: item.id, category: $('category-preview').querySelector(`[data-suggestion-category="${Number(node.dataset.suggestion)}"]`).value, expectedCategory: item.currentCategory };
    });
    if (!updates.length) return;
    if (confirmAll && !confirm(`Apply the selected categories to all ${updates.length} suggested transactions? You can review each suggestion before approving.`)) return;
    $('approve-button').disabled = true; $('approve-all-button').disabled = true;
    $('preview-button').disabled = true;
    try {
      const data = await json('/api/transactions/categorization-apply', 'POST', { updates, learnRules: $('remember-merchants').checked });
      $('review-status').textContent = `${data.updated} categories updated${data.rulesSaved ? ` · ${data.rulesSaved} merchant rule${data.rulesSaved === 1 ? '' : 's'} saved for future imports` : ''}${data.rulesSkipped ? ` · ${data.rulesSkipped} conflicting merchant rule${data.rulesSkipped === 1 ? ' was' : 's were'} skipped` : ''}. Find suggestions again to review what remains.`;
      $('category-preview').textContent = ''; suggestions = [];
      $('remember-merchants').checked = false;
    } catch (error) { $('review-status').textContent = `${error.message} Preview again if categories changed since this review.`; }
    finally { $('preview-button').disabled = false; $('approve-all-button').disabled = !suggestions.length; }
  }
  $('approve-button').onclick = () => applySuggestions(Array.from($('category-preview').querySelectorAll('[data-suggestion]:checked')));
  $('approve-all-button').onclick = () => applySuggestions(Array.from(suggestions, (_, index) => ({ dataset: { suggestion: String(index) } })), true);

  window.loadAllTransactions = async function() {
    const table = $('full-txn-table');
    try {
      const [allCategories, data] = await Promise.all([json('/api/categories'), json('/api/dashboard/all-transactions')]);
      const selected = $('txn-filter-category').value;
      $('txn-filter-category').innerHTML = '<option value="">All categories</option>' + allCategories.map(c => `<option value="${escape(c.name)}" ${selected === c.name ? 'selected' : ''}>${escape(c.name)}</option>`).join('');
      const rows = (data.transactions || []).filter(t => (!selected || t.category === selected) && (!$('txn-filter-fixed').checked || (fixed(t.is_fixed) && String(t.direction).toUpperCase() === 'DEBIT'))).sort((a,b) => localDate(b.date) - localDate(a.date));
      table.innerHTML = rows.length ? rows.map((t,index) => `<tr data-transaction="${index}"><td style="padding:14px">${escape(t.date)}</td><td>${escape(t.description)}</td><td><select data-category aria-label="Category for ${escape(t.description)}"><option value="">Uncategorized</option>${allCategories.map(c => `<option value="${escape(c.name)}" ${c.name === t.category ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select></td><td style="text-align:center"><input data-fixed type="checkbox" aria-label="Fixed bill: ${escape(t.description)}" ${fixed(t.is_fixed) ? 'checked' : ''} ${String(t.direction).toUpperCase() !== 'DEBIT' ? 'disabled title="Only debit payments can be fixed bills"' : ''}></td><td style="text-align:right">${String(t.direction).toUpperCase() === 'DEBIT' ? '−' : '+'}${money(Math.abs(t.amount))}</td></tr>`).join('') : '<tr><td colspan="5" style="padding:24px">No transactions match these filters.</td></tr>';
      table.onchange = async event => {
        const row = event.target.closest('[data-transaction]');
        if (!row) return;
        const item = rows[Number(row.dataset.transaction)];
        event.target.disabled = true;
        try {
          if (event.target.matches('[data-fixed]')) {
            await json('/api/transactions/update-fixed', 'POST', { id: item.id, is_fixed: event.target.checked, apply_to_all: false });
            notify('Fixed flag saved for this transaction. Upcoming bills update from your marked debits.');
          } else {
            await json('/api/transactions/update-transaction', 'POST', { id: item.id, category: event.target.value, apply_to_all: false });
            notify('Category updated for this transaction only.');
          }
        } catch (error) { reportError(error); }
        finally { if (FinanceSession.isAuthenticated()) await loadAllTransactions(); }
      };
    } catch (error) { table.textContent = error.message; }
  };

  function fundingMarkup(plan) {
    const metrics = [['Average monthly income',plan.avgMonthlyIncome],['Average monthly spending',plan.avgMonthlyExpenses],['Available before goals',plan.monthlySurplus],['All dated goals / month',plan.requiredMonthlySavings],['Left after dated goals',plan.availableAfterGoals]];
    return `<div class="metrics-grid">${metrics.map(([label,value]) => `<div><div class="metric-label">${label}</div><div class="metric-value" style="font-size:23px">${money(value)}</div></div>`).join('')}</div>
      ${plan.additionalDebtPayments > 0 ? `<p class="coach-note">Spending includes ${money(plan.additionalDebtPayments)} per month reserved for loan payments not yet in your imported history. Recorded spending alone averages ${money(plan.recordedAvgMonthlyExpenses)}.</p>` : ''}
      <p class="muted">${escape(plan.basis || 'Based on your imported history.')} ${Number(plan.monthsUsed) || 0} month(s) used. Historical averages are not a guarantee of future income; verify irregular costs and minimum debt payments before committing.</p>
      ${(plan.goals || []).some(goal => goal.requiredMonthly == null && goal.remaining > 0) ? '<p class="coach-note">Goals without a deadline are not included in the monthly requirement. Add dates before treating this plan as affordable.</p>' : ''}
      ${(plan.advice || []).map(item => `<div class="coach-note ${['warning','danger'].includes(item.severity) ? item.severity : ''}"><strong>${escape(item.title)}</strong><p>${escape(item.detail)}</p></div>`).join('')}`;
  }
  window.generateInsights = async function() {
    const button = $('run-insights-btn');
    button.disabled = true; $('insights-container').textContent = 'Reviewing your recorded history and goals…';
    try {
      const plan = await json('/api/goals/funding-analysis');
      $('insights-container').innerHTML = `<p class="eyebrow">A PLAN BUILT FROM YOUR NUMBERS</p><h2>Make the next dollar count</h2>${fundingMarkup(plan)}
        <h3>Where the money goes</h3><p class="muted">Monthly averages across the same analysis period. These are categories to review, not assumptions that every expense is optional.</p>
        <div class="table-scroll"><table class="review-table"><thead><tr><th>Category</th><th>Monthly average</th><th>Period total</th></tr></thead><tbody>${(plan.categorySpending || []).map(c => `<tr><td>${escape(c.category || 'Uncategorized')}</td><td>${money(c.monthlyAverage)}</td><td>${money(c.total)}</td></tr>`).join('') || '<tr><td colspan="3">Import statements to see your spending breakdown.</td></tr>'}</tbody></table></div>
        <div class="coach-note"><strong>Your next move</strong><p>If the combined plan is short, change an amount or deadline rather than pretending the gap will disappear. Review a flexible category, set a realistic cap, and check actual spending next month. Protect essential bills and a starter emergency buffer.</p></div>
        <p class="muted">Local, deterministic guidance—not a generative AI integration, investment recommendation, or professional financial advice. No financial data is sent to third-party AI services.</p>`;
    } catch (error) { $('insights-container').textContent = error.message; }
    finally { button.disabled = false; }
  };

  const kindLabel = document.createElement('label');
  kindLabel.innerHTML = `Plan type<select id="goal-kind"><option value="general">General savings</option><option value="car">Car · six-month plan</option><option value="college">College</option><option value="emergency">Emergency fund</option></select>`;
  $('goal-name').parentElement.before(kindLabel);
  const notesLabel = document.createElement('label');
  notesLabel.innerHTML = 'Notes<textarea id="goal-notes" rows="2" maxlength="2000" placeholder="What matters about this goal?"></textarea>';
  $('goal-icon').parentElement.after(notesLabel);
  $('goal-kind').onchange = () => {
    const kind = $('goal-kind').value;
    const icons = { general:'🎯',car:'🚗',college:'🎓',emergency:'🛡️' };
    $('goal-icon').value = icons[kind];
    if (kind === 'car' && !$('goal-date').value) {
      const date = new Date(); date.setMonth(date.getMonth() + 6);
      $('goal-date').value = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    }
  };
  const originalCloseGoal = closeAddGoalModal;
  window.closeAddGoalModal = function() { originalCloseGoal(); goalEditing = null; $('goal-kind').value = 'general'; $('goal-notes').value = ''; };
  window.openAddGoalModal = function(id = null) {
    closeAddGoalModal();
    goalEditing = id;
    const goal = goals.find(g => String(g.id) === String(id));
    if (goal) {
      $('goal-name').value = goal.name; $('goal-target').value = goal.target_amount; $('goal-current').value = goal.current_amount;
      $('goal-date').value = goal.target_date?.slice(0,10) || ''; $('goal-priority').value = goal.priority;
      $('goal-icon').value = goal.icon || '🎯';
      const kind = String(goal.notes || '').match(/^\[plan:(general|car|college|emergency)\]\s*/);
      $('goal-kind').value = kind?.[1] || 'general';
      $('goal-notes').value = String(goal.notes || '').replace(/^\[plan:\w+\]\s*/, '');
    }
    $('add-goal-modal').querySelector('h2').textContent = goal ? 'Edit savings goal' : 'A goal worth making room for';
    $('add-goal-modal').querySelector('button[onclick="saveGoal()"]').textContent = goal ? 'Save goal' : 'Create goal';
    $('add-goal-modal').style.display = 'flex'; $('goal-name').focus();
  };
  window.saveGoal = async function() {
    const target = Number($('goal-target').value), current = Number($('goal-current').value || 0);
    if (!$('goal-name').value.trim() || target <= 0 || !Number.isFinite(target) || current < 0 || !Number.isFinite(current)) return notify('Enter a name, positive target, and nonnegative current savings.');
    const button = $('add-goal-modal').querySelector('button[onclick="saveGoal()"]');
    button.disabled = true;
    try {
      await json(goalEditing == null ? '/api/goals' : `/api/goals/${encodeURIComponent(goalEditing)}`, goalEditing == null ? 'POST' : 'PUT', { name: $('goal-name').value.trim(), target_amount: target, current_amount: current, target_date: $('goal-date').value || null, priority: Number($('goal-priority').value) || 1, icon: $('goal-icon').value, notes: `[plan:${$('goal-kind').value}] ${$('goal-notes').value.trim()}` });
      closeAddGoalModal(); await loadGoals(); notify('Goal saved.');
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
  window.loadGoals = async function() {
    try {
      const [items, plan] = await Promise.all([json('/api/goals'),json('/api/goals/funding-analysis')]); goals = items;
      $('goals-funding-overview').innerHTML = `<h2>Can your goals work together?</h2><p class="muted">Plan a car in six months, college, and an emergency cushion without counting the same dollar twice.</p>${fundingMarkup(plan)}<p class="muted">Recording savings updates progress only. This app does not move money or connect to your bank.</p>`;
      $('goals-list').innerHTML = goals.map((goal,index) => {
        const progress = Math.min(100, Math.max(0, Number(goal.current_amount) / Number(goal.target_amount) * 100));
        const analysis = (plan.goals || []).find(g => String(g.id) === String(goal.id));
        return `<article class="panel plan-card"><div class="eyebrow">${escape(String(goal.notes || '').match(/^\[plan:(\w+)\]/)?.[1] || 'SAVINGS')} · PRIORITY ${Number(goal.priority) || 1}</div><h2>${escape(goal.icon || '🎯')} ${escape(goal.name)}</h2><div><strong>${money(goal.current_amount)}</strong> <span class="muted">of ${money(goal.target_amount)}</span></div><progress aria-label="Savings progress for ${escape(goal.name)}" value="${progress}" max="100"></progress><p class="muted">${goal.target_date ? `Target ${escape(goal.target_date.slice(0,10))}` : 'No deadline set'}<br>${analysis?.requiredMonthly == null ? 'Set a deadline for a monthly savings requirement.' : `${money(analysis.requiredMonthly)} / month needed · ${escape(analysis.status)}`}</p><p>${escape(String(goal.notes || '').replace(/^\[plan:\w+\]\s*/, ''))}</p><div class="toolbar"><button class="btn btn-primary" data-goal-action="contribute" data-goal="${index}">Record savings</button><button class="btn btn-secondary" data-goal-action="edit" data-goal="${index}">Edit</button><button class="btn btn-secondary" data-goal-action="delete" data-goal="${index}">Delete</button></div></article>`;
      }).join('') || '<div class="panel plan-card"><h3>Your next chapter starts with a goal.</h3><p class="muted">Add your target amount and a realistic deadline to build a shared savings plan.</p></div>';
    } catch (error) { $('goals-list').textContent = error.message; }
  };
  $('goals-list').onclick = async event => {
    const button = event.target.closest('[data-goal-action]');
    if (!button) return;
    const goal = goals[Number(button.dataset.goal)];
    if (button.dataset.goalAction === 'edit') return openAddGoalModal(goal.id);
    button.disabled = true;
    try {
      if (button.dataset.goalAction === 'delete') {
        if (!confirm(`Delete "${goal.name}"?`)) return;
        await json(`/api/goals/${encodeURIComponent(goal.id)}`, 'DELETE');
      } else {
        const amount = prompt('Savings already set aside ($). This records progress; it does not transfer money:');
        if (amount == null) return;
        if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('Enter a positive amount.');
        await json(`/api/goals/${encodeURIComponent(goal.id)}/contribute`, 'POST', { amount: Number(amount) });
      }
      await loadGoals();
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };

  const dialog = document.createElement('dialog');
  dialog.id = 'debt-dialog'; dialog.className = 'editor';
  dialog.innerHTML = `<form id="debt-form"><h2>Debt or loan details</h2><label>Name<input name="name" required maxlength="100"></label><label>Type<select name="debt_type"><option value="credit_card">Credit card</option><option value="auto_loan">Auto loan</option><option value="student_loan">Student loan</option><option value="personal_loan">Personal loan</option><option value="mortgage">Mortgage</option><option value="other">Other</option></select></label><label>Current balance ($)<input name="balance" type="number" min="0" step=".01" required></label><label>APR (%)<input name="apr" type="number" min="0" max="1000" step=".001" required></label><label>Minimum monthly payment ($)<input name="min_payment" type="number" min="0" step=".01" required></label><label style="display:flex;align-items:center;gap:10px"><input name="payment_in_history" type="checkbox" checked>Monthly payment already included in imported spending</label><p class="muted">Leave checked for existing payments already in your statements. Uncheck for a new loan: its minimum payment is reserved in your savings plan without double-counting existing loans.</p><label>Credit limit ($, optional)<input name="credit_limit" type="number" min="0" step=".01"></label><label>Due day (optional)<input name="due_date" type="number" min="1" max="31" step="1"></label><p id="debt-error" role="alert"></p><div class="toolbar"><button class="btn btn-primary">Save debt</button><button class="btn btn-secondary" type="button" id="debt-cancel">Cancel</button></div></form>`;
  document.body.appendChild(dialog);
  let debtEditing = null;
  $('debt-cancel').onclick = () => dialog.close();
  window.openDebtEditor = function(id = null) {
    debtEditing = id; $('debt-form').reset(); $('debt-error').textContent = '';
    const item = debts.find(d => String(d.id) === String(id));
    if (item) for (const field of ['name','debt_type','balance','apr','min_payment','credit_limit','due_date']) $('debt-form').elements[field].value = item[field] ?? (field === 'name' ? item.card_name : '');
    $('debt-form').elements.payment_in_history.checked = item ? item.payment_in_history !== false : true;
    dialog.showModal();
  };
  $('debt-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target, button = event.submitter;
    const data = Object.fromEntries(new FormData(form));
    for (const field of ['balance','apr','min_payment','credit_limit']) data[field] = data[field] === '' ? null : Number(data[field]);
    data.due_date = data.due_date || null;
    data.payment_in_history = form.elements.payment_in_history.checked;
    button.disabled = true;
    try {
      await json(debtEditing == null ? '/api/debts' : `/api/debts/${encodeURIComponent(debtEditing)}`, debtEditing == null ? 'POST' : 'PUT', data);
      dialog.close(); await loadPayoffPlan(); notify('Debt saved.');
    } catch (error) { $('debt-error').textContent = error.message; }
    finally { button.disabled = false; }
  };
  function simulate(items, budget) {
    const active = items.filter(d => d.balance > 0).map(d => ({ ...d, balance: Number(d.balance) })).sort((a,b) => Number(b.apr)-Number(a.apr));
    const months = [];
    for (let index = 0; index < 600 && active.some(d => d.balance > .005); index++) {
      for (const item of active) item.balance += item.balance * Number(item.apr) / 1200;
      let available = budget;
      const minimums = active.map(d => Math.min(d.balance, Number(d.min_payment)));
      if (minimums.reduce((a,b) => a+b,0) > budget + .005) return { months, reason: 'Budget is below minimum payments. Increase it or contact your lenders before using this projection.' };
      active.forEach((d,i) => { d.balance -= minimums[i]; available -= minimums[i]; });
      for (const item of active) { const extra = Math.min(available, item.balance); item.balance -= extra; available -= extra; }
      const balance = active.reduce((sum,d) => sum+d.balance,0);
      months.push(balance);
    }
    return { months, reason: months.at(-1) > .005 ? 'Not paid off within 50 years at this budget. Interest may be outpacing payments.' : '' };
  }
  window.loadPayoffPlan = async function() {
    try {
      debts = (await json('/api/debts')).sort((a,b) => Number(b.apr)-Number(a.apr));
      const total = debts.reduce((sum,d) => sum+Number(d.balance),0);
      const minimum = debts.reduce((sum,d) => sum + (Number(d.balance) > 0 ? Math.min(Number(d.balance) * (1 + Number(d.apr) / 1200),Number(d.min_payment)) : 0),0);
      $('payoff-total-debt').textContent = money(total);
      $('payoff-budget').placeholder = `Minimums ${money(minimum)}`;
      const entered = $('payoff-budget').value !== '';
      const budget = entered ? Number($('payoff-budget').value) : minimum;
      let extra = Math.max(0,budget-minimum);
      $('payoff-schedule-body').innerHTML = debts.map((item,index) => {
        const owed = Number(item.balance) * (1 + Number(item.apr) / 1200);
        const base = Math.min(owed,Number(item.min_payment));
        const added = Math.min(extra,Math.max(0,owed-base)); extra -= added;
        return `<tr><td style="padding:14px">${index+1}</td><td><strong>${escape(item.name || item.card_name)}</strong><div class="muted">${escape(item.debt_type?.replaceAll('_',' ') || 'credit card')} · ${Number(item.apr)}% APR</div><div class="toolbar"><button class="btn btn-secondary" data-debt-edit="${index}">Edit</button><button class="btn btn-secondary" data-debt-delete="${index}">Delete</button></div></td><td style="text-align:right">${money(item.balance)}</td><td style="text-align:right">${budget < minimum ? 'Budget too low' : money(base+added)}</td><td style="text-align:center">${escape(item.due_date || '—')}</td></tr>`;
      }).join('') || '<tr><td colspan="5" style="padding:24px">No debts yet. Add a credit card or loan to build your plan.</td></tr>';
      if (!total) { $('payoff-timeline-chart').textContent = 'No outstanding debt to project.'; return; }
      if (budget <= 0 || !Number.isFinite(budget)) { $('payoff-timeline-chart').textContent = 'Enter a positive monthly budget to estimate repayment.'; return; }
      const result = simulate(debts,budget);
      $('payoff-timeline-chart').innerHTML = `<p class="coach-note">${!entered ? 'Using your recorded minimum payments until you enter a budget. ' : ''}${result.reason ? escape(result.reason) : `Estimated payoff: ${result.months.length} months at ${money(budget)} per month.`}</p>${result.months.filter((_,i) => i < 12 || i === result.months.length-1).map((balance,index) => {
        const month = index < 12 ? index+1 : result.months.length;
        return `<div><div class="toolbar" style="justify-content:space-between"><span>Month ${month}</span><strong>${money(balance)} remaining</strong></div><progress aria-label="Remaining balance month ${month}" value="${Math.min(total,balance)}" max="${total}"></progress></div>`;
      }).join('')}`;
    } catch (error) { $('payoff-schedule-body').textContent = error.message; }
  };
  $('payoff-schedule-body').onclick = async event => {
    const edit = event.target.closest('[data-debt-edit]'), remove = event.target.closest('[data-debt-delete]');
    if (edit) return openDebtEditor(debts[Number(edit.dataset.debtEdit)].id);
    if (!remove) return;
    const debt = debts[Number(remove.dataset.debtDelete)];
    if (!confirm(`Delete "${debt.name || debt.card_name}" from your plan?`)) return;
    remove.disabled = true;
    try { await json(`/api/debts/${encodeURIComponent(debt.id)}`, 'DELETE'); await loadPayoffPlan(); }
    catch (error) { reportError(error); remove.disabled = false; }
  };
  // Expose pure utilities for lightweight VM regression tests.
  window.FinanceTools = { escape, money, fixed, simulate };
})();
