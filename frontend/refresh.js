/* Original, server-local planning and review tools; no external integrations. */
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const money = value => value == null || !Number.isFinite(Number(value)) ? 'Not enough data' : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const fixed = value => value === true || value === 1 || value === 'true';
  const payModeOf = t => (t?.pay_mode === 'auto' || t?.pay_mode === 'manual') ? t.pay_mode : null;
  const PAY_LABEL = { auto: 'Auto-pay', manual: 'Manual' };
  const payLabel = mode => PAY_LABEL[mode] || 'Not set';
  window.payModeOf = payModeOf;
  // Transfers between your own accounts are shown for information and left out of every total.
  const isTransfer = t => t?.transfer_kind != null;
  const TRANSFER_BADGE = {
    internal: ['', 'Transfer · not counted', 'Moved between your own accounts. Not counted as spending or income.'],
    savings: ['saved', 'Saved', 'Moved to or from savings. Counted as saved, not as spending or income.'],
    unknown: ['unknown', 'Transfer · account?', 'Looks like a transfer to an account we do not know yet. Not counted until you set it on the Accounts page.']
  };
  const transferBadge = t => {
    const badge = TRANSFER_BADGE[t?.transfer_kind];
    if (!badge) return '';
    const where = t.transfer_account_name ? ` (${t.transfer_account_name})` : '';
    return t.transfer_kind === 'unknown'
      ? `<a href="#accounts" data-view="accounts" class="tx-transfer-badge ${badge[0]}" title="${escape(badge[2] + where)}">${badge[1]} · Review</a>`
      : `<span class="tx-transfer-badge ${badge[0]}" title="${escape(badge[2] + where)}">${badge[1]}</span>`;
  };
  window.transferBadge = transferBadge;
  const validTransactionId = id => /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id));
  window.transactionHref = id => validTransactionId(id) ? `#transactions/${id}` : '';
  window.transactionLink = (id, label) => {
    const href = window.transactionHref(id);
    return href ? `<a class="transaction-link" href="${href}">${escape(label || 'Transaction')}</a>` : escape(label || 'Transaction');
  };
  let transactionId = '';
  // '' = all; 'unset' = debits with no method yet; 'auto'/'manual' match debits only.
  window.matchesPayModeFilter = (t, filter) => {
    if (!filter) return true;
    if (String(t?.direction).toUpperCase() !== 'DEBIT') return false;
    return filter === 'unset' ? payModeOf(t) === null : payModeOf(t) === filter;
  };
  const monthKey = value => {
    const dateText = String(value ?? '');
    const isoDate = dateText.match(/^(\d{4})-(\d{2})/);
    if (isoDate) return `${isoDate[1]}-${isoDate[2]}`;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  };
  const transactionDate = value => {
    const date = new Date(`${String(value ?? '').slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? new Date(NaN) : date;
  };
  // `month` may be a single "YYYY-MM" key, or an array/Set of keys for multi-month periods.
  window.filterTransactionsByCategoryAndMonth = (transactions, category, month) => {
    const months = month && typeof month !== 'string' ? new Set(month) : null;
    return transactions.filter(transaction => (!category || transaction.category === category) &&
      (months ? months.has(monthKey(transaction.date)) : (!month || monthKey(transaction.date) === month)));
  };
  const periodLabel = month => month ? new Date(`${month}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'All time';
  const shortMonth = key => new Date(`${key}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  window.monthRangePresets = Object.freeze([3, 6, 12, 24].map(months => ({ months, label: `Last ${months} months` })));
  const PERIOD_PRESETS = [...window.monthRangePresets.map(({ months, label }) => [`last-${months}`, label]), ['this-month', 'This month'], ['last-month', 'Last month'], ['this-quarter', 'This quarter'], ['last-quarter', 'Last quarter'], ['ytd', 'Year to date'], ['', 'All time']];
  // Resolves a period spec to the month keys it covers (null = all time) and a human label.
  window.resolvePeriod = (spec = '', custom = [], today = new Date()) => {
    const y = today.getFullYear(), m = today.getMonth(), quarter = Math.floor(m / 3);
    const key = (year, monthIndex) => { const d = new Date(year, monthIndex, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
    const span = (startIndex, count) => Array.from({ length: count }, (_, i) => key(y, startIndex + i));
    if (spec === 'this-month') return { months: span(m, 1), label: periodLabel(key(y, m)) };
    if (spec === 'last-month') return { months: span(m - 1, 1), label: periodLabel(key(y, m - 1)) };
    if (spec === 'this-quarter') return { months: span(quarter * 3, m - quarter * 3 + 1), label: `Q${quarter + 1} ${y} to date` };
    if (spec === 'last-quarter') {
      const start = new Date(y, quarter * 3 - 3, 1);
      return { months: span(quarter * 3 - 3, 3), label: `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}` };
    }
    if (spec === 'ytd') return { months: span(0, m + 1), label: `Year to date ${y}` };
    const rolling = String(spec).match(/^last-(3|6|12|24)$/);
    if (rolling) { const count = Number(rolling[1]); return { months: span(m - count + 1, count), label: `Last ${count} months` }; }
    const year = String(spec).match(/^year:(\d{4})$/);
    if (year) return { months: Array.from({ length: 12 }, (_, i) => `${year[1]}-${String(i + 1).padStart(2, '0')}`), label: year[1] };
    const single = String(spec).match(/^month:(\d{4}-\d{2})$/);
    if (single) return { months: [single[1]], label: periodLabel(single[1]) };
    if (spec === 'custom') {
      const months = [...new Set(custom)].filter(Boolean).sort();
      if (!months.length) return { months: [], label: 'Choose months below' };
      if (months.length === 1) return { months, label: periodLabel(months[0]) };
      return { months, label: months.length <= 3 ? months.map(shortMonth).join(', ') : `${months.length} selected months (${shortMonth(months[0])} – ${shortMonth(months.at(-1))})` };
    }
    return { months: null, label: 'All time' };
  };
  // Shared period selector: quick ranges, per-year options and a multi-select month picker.
  function periodControl(prefix, onChange) {
    const select = $(`${prefix}-period`), picker = $(`${prefix}-months`);
    const custom = new Set();
    let available = new Set();
    if (!select.value) select.value = 'last-3';
    const current = () => window.resolvePeriod(select.value, [...custom]);
    function renderPicker() {
      picker.hidden = select.value !== 'custom';
      if (picker.hidden) return;
      const years = [...new Set([...available].map(month => month.slice(0, 4)))].sort().reverse();
      if (!years.length) years.push(String(new Date().getFullYear()));
      picker.innerHTML = `<div class="month-picker-head"><strong>Choose one or more months</strong><span>${custom.size ? `${custom.size} selected` : 'None selected'}</span><button type="button" class="btn btn-secondary btn-compact" data-clear-months ${custom.size ? '' : 'disabled'}>Clear</button></div>` +
        years.map(year => `<div class="month-picker-year"><button type="button" class="month-picker-year-label" data-pick-year="${year}" title="Select every month with activity in ${year}">${year}</button><div class="month-picker-grid">${MONTH_NAMES.map((name, index) => {
          const month = `${year}-${String(index + 1).padStart(2, '0')}`;
          const has = available.has(month);
          return `<label class="month-chip${has ? '' : ' is-empty'}"><input type="checkbox" value="${month}" ${custom.has(month) ? 'checked' : ''} ${has || custom.has(month) ? '' : 'disabled'}><span>${name}</span></label>`;
        }).join('')}</div></div>`).join('');
    }
    function sync(transactions) {
      available = new Set(transactions.map(transaction => monthKey(transaction.date)).filter(Boolean));
      let value = select.value || '';
      const single = value.match(/^month:(\d{4}-\d{2})$/);
      if (single) { custom.clear(); custom.add(single[1]); value = 'custom'; }
      const years = [...new Set([...available].map(month => month.slice(0, 4)))].sort().reverse();
      select.innerHTML = `<optgroup label="Quick ranges">${PERIOD_PRESETS.map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}</optgroup>` +
        (years.length ? `<optgroup label="Full year">${years.map(year => `<option value="year:${year}">${year}</option>`).join('')}</optgroup>` : '') +
        '<optgroup label="Custom"><option value="custom">Choose months…</option></optgroup>';
      select.value = value;
      renderPicker();
    }
    function reset() { select.value = 'last-3'; custom.clear(); picker.hidden = true; }
    function setMonths(months) { custom.clear(); months.forEach(month => custom.add(month)); select.value = 'custom'; }
    select.onchange = () => { renderPicker(); return onChange(); };
    picker.onchange = event => {
      const box = event.target;
      if (!box || box.type !== 'checkbox') return;
      box.checked ? custom.add(box.value) : custom.delete(box.value);
      renderPicker(); return onChange();
    };
    picker.onclick = event => {
      const target = event.target.closest?.('button');
      if (!target) return;
      if (target.hasAttribute('data-clear-months')) custom.clear();
      else if (target.dataset.pickYear) {
        const months = [...available].filter(month => month.startsWith(target.dataset.pickYear));
        const all = months.every(month => custom.has(month));
        months.forEach(month => all ? custom.delete(month) : custom.add(month));
      } else return;
      renderPicker(); return onChange();
    };
    return { current, sync, reset, setMonths, custom };
  }
  window.matchesTransactionSearch = (transaction, query) => {
    const tokens = String(query || '').toLowerCase().replace(/[$,]/g, '').split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const amount = Math.abs(Number(transaction.amount) || 0).toFixed(2);
    const haystack = `${transaction.display_name || ''} ${transaction.description || ''} ${transaction.category || 'uncategorized'} ${amount}`.toLowerCase();
    return tokens.every(token => haystack.includes(token));
  };
  const highlight = (text, query) => {
    const tokens = String(query || '').trim().split(/\s+/).filter(Boolean).map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!tokens.length) return escape(text);
    return String(text ?? '').split(new RegExp(`(${tokens.join('|')})`, 'gi')).map((part, index) => index % 2 ? `<mark>${escape(part)}</mark>` : escape(part)).join('');
  };
  // Statement noise around the merchant name: bank rails, card networks, web suffixes and filler words.
  const MERCHANT_NOISE = new Set('VISA MASTERCARD DEBIT CREDIT CARD CHECKCARD DDA ACH POS PUR PURCH PURCHASE RECURRING AUTOPAY AUTO PAY BILL BILLPAY MOBILE WEB BANKING PAYMENT PMT ONLINE ELECTRONIC WITHDRAWAL DEPOSIT TRANSFER XFER FROM WWW COM NET ORG INC LLC CORP THE AND APP'.split(' '));
  // Person-to-person rails need the payee too, otherwise every Zelle/Venmo payment would match.
  const PAYMENT_RAILS = new Set(['ZELLE', 'VENMO', 'PAYPAL', 'CASH']);
  const MERCHANT_PROCESSORS = new Set(['TST', 'TOAST', 'SQ', 'SQUARE']);
  window.merchantTokens = description => String(description ?? '').toUpperCase().split(/[^A-Z0-9]+/)
    .filter(token => (token.length > 2 || MERCHANT_PROCESSORS.has(token)) && !/\d/.test(token) && !MERCHANT_NOISE.has(token));
  window.merchantKey = description => {
    let tokens = window.merchantTokens(description);
    if (!tokens.length) return '';
    // A processor serves many unrelated merchants. Keep a conservative multiword identity,
    // including repeated words such as PERI PERI, rather than grouping by TST or SQUARE.
    if (MERCHANT_PROCESSORS.has(tokens[0])) {
      while (MERCHANT_PROCESSORS.has(tokens[0])) tokens.shift();
      return tokens.slice(0, 3).join(' ');
    }
    tokens = [...new Set(tokens)];
    return PAYMENT_RAILS.has(tokens[0]) ? tokens.slice(0, 2).join(' ') : tokens[0];
  };
  const payeeName = t => String(t?.display_name || '').trim().toUpperCase();
  const bankPayeeKey = t => {
    const tokens = window.merchantTokens(t?.description);
    const rail = tokens.findIndex(token => PAYMENT_RAILS.has(token));
    return rail < 0 ? window.merchantKey(t?.description) : tokens.slice(rail).join(' ');
  };
  const samePayee = (a, b) => {
    const aName = payeeName(a), bName = payeeName(b);
    if (aName && bName) return aName === bName;
    const key = bankPayeeKey(a);
    return !!key && key === bankPayeeKey(b);
  };
  // Likely repeats of the same payment: same merchant and direction; amount within 10% (min $1) is flagged as a strong match.
  // `change` is a category name, { isFixed } for the fixed-bill flag, { payMode } for auto-pay/manual, or { income } for counting deposits as pay; rows already in that state are skipped.
  window.findSimilarTransactions = (transactions, source, change) => {
    const byFixed = change && typeof change === 'object' && typeof change.isFixed === 'boolean';
    const byPay = change && typeof change === 'object' && Object.prototype.hasOwnProperty.call(change, 'payMode');
    const byIncome = change && typeof change === 'object' && typeof change.income === 'boolean';
    if (!byFixed && !byPay && !byIncome && typeof change !== 'string') return [];
    const differs = byFixed ? t => fixed(t.is_fixed) !== change.isFixed
      : byPay ? t => payModeOf(t) !== (change.payMode || null)
      : byIncome ? t => !!t.counts_as_income !== change.income
      : t => t.category !== change;
    const amount = Math.abs(Number(source.amount) || 0), direction = String(source.direction).toUpperCase();
    return transactions
      .filter(t => String(t.id) !== String(source.id) && differs(t) && String(t.direction).toUpperCase() === direction && samePayee(source, t))
      .map(transaction => ({ transaction, sameAmount: Math.abs(Math.abs(Number(transaction.amount) || 0) - amount) <= Math.max(1, amount * 0.1) }))
      .sort((a, b) => (b.sameAmount - a.sameAmount) || (transactionDate(b.transaction.date) - transactionDate(a.transaction.date)));
  };
  let categoryRequest = 0, transactionRequest = 0, detailRequest = 0;
  let transactionCache = null, searchTimer = null;
  // Lets optional modules (e.g. Pro analytics) enhance views without coupling to their internals.
  window.emitFinanceEvent = (name, detail) => {
    if (typeof CustomEvent === 'function' && typeof document.dispatchEvent === 'function') document.dispatchEvent(new CustomEvent(name, { detail }));
  };
  const categoryPeriod = periodControl('category-filter', () => window.loadCategories());
  const transactionPeriod = periodControl('txn-filter', () => transactionCache ? renderTransactions() : window.loadAllTransactions());
  window.currentTransactionPeriod = () => transactionPeriod.current();
  window.currentTransactionId = () => transactionId;
  let detailCategory = '';
  const mtdDialog = $('mtd-transactions-dialog');
  const closeMtdDialog = () => mtdDialog.open && mtdDialog.close();
  mtdDialog.querySelector('.mtd-dialog-close').addEventListener('click', closeMtdDialog);
  mtdDialog.querySelector('.mtd-dialog-done').addEventListener('click', closeMtdDialog);
  mtdDialog.addEventListener('close', () => { detailRequest++; });
  const json = async (url, method = 'GET', body) => {
    const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  };
  window.loadEtlStaging = async () => {
    const tbody = $('etl-staging-table');
    tbody.innerHTML = '<tr><td colspan="5">Loading older queued records...</td></tr>';
    try {
      const items = await json('/api/staging/attention');
      if (!Array.isArray(items)) throw new Error('Unexpected response while loading queued records.');
      tbody.innerHTML = items.length ? items.map(item => `<tr>
        <td>${escape(item.date || 'Unknown date')}</td><td>${escape(item.status)}</td>
        <td>${escape(item.description)}${item.error_message ? `<div class="muted">${escape(item.error_message)}</div>` : ''}</td>
        <td>${money(Math.abs(Number(item.amount)))}</td>
        <td><div class="toolbar"><button type="button" class="btn btn-secondary" data-staging-add="${escape(item.id)}">Add anyway</button>
          <button type="button" class="btn btn-secondary" data-staging-dismiss="${escape(item.id)}">Dismiss</button></div></td>
        </tr>`).join('') : '<tr><td colspan="5">No older queued records. Current import results appear in the import dialog, not here.</td></tr>';
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="5" role="alert">Could not load older records: ${escape(error.message)} <button type="button" class="btn btn-secondary" data-staging-retry>Retry</button></td></tr>`;
    }
  };
  const stagingActions = new Set();
  $('etl-staging-table').onclick = async event => {
    const button = event.target.closest('[data-staging-add], [data-staging-dismiss], [data-staging-retry]');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-staging-retry')) return window.loadEtlStaging();
    const adding = button.dataset.stagingAdd != null;
    const id = adding ? button.dataset.stagingAdd : button.dataset.stagingDismiss;
    if (stagingActions.has(id)) return;
    stagingActions.add(id);
    button.disabled = true;
    try {
      if (!await FinanceUI.confirm(adding
        ? 'Add this older record anyway? Duplicate checks are bypassed. Compare it with Transactions first. It will be saved as Other without an account; assign its source under Accounts afterwards.'
        : 'Dismiss this queued copy? Existing transactions will not be deleted.')) return;
      await json(`/api/staging/${adding ? 'force-push' : 'dismiss'}`, 'POST', { id });
      window.FinancePlan?.invalidate?.();
      notify(adding ? 'Record added. Review its category and account assignment.' : 'Queued copy dismissed. Existing transactions were not changed.');
      await window.loadEtlStaging();
    } catch (error) {
      notify(error.message || 'The queued record could not be updated.');
    } finally {
      stagingActions.delete(id);
      button.disabled = false;
    }
  };
  let debts = [], goals = [], rules = [], categories = [], suggestions = [];
  let goalEditing = null;
  window.clearFinanceState = () => { debts = []; goals = []; rules = []; categories = []; suggestions = []; goalEditing = null; debtEditing = null; transactionId = ''; transactionCache = null; categoryPeriod.reset(); transactionPeriod.reset(); categoryRequest++; transactionRequest++; detailRequest++; window.FinancePlan?.invalidate?.(); };
  const reportError = error => {
    const message = error.message || 'Something went wrong. Please try again.';
    const alert = document.querySelector('dialog[open] [role="alert"]');
    if (alert) alert.textContent = message;
    else notify(message);
  };
  // Upcoming payments layout: calendar or list. The choice is remembered; phones default to the list.
  const PAY_VIEW_KEY = 'myfinance.payView';
  window.setPayView = view => {
    let stored = null;
    try { stored = window.localStorage?.getItem(PAY_VIEW_KEY); } catch { /* storage unavailable */ }
    if (view === 'calendar' || view === 'list') { try { window.localStorage?.setItem(PAY_VIEW_KEY, view); } catch { /* storage unavailable */ } }
    else view = stored === 'calendar' || stored === 'list' ? stored
      : (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches ? 'list' : 'calendar');
    const section = $('upcoming-section');
    if (section) section.dataset.payView = view;
    document.querySelectorAll?.('button[data-pay-view]')?.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.payView === view)));
    return view;
  };
  window.removeFixedTemplate = async id => {
    if (!await FinanceUI.confirm('Remove the Fixed flag from this merchant’s matching transactions? This stops its bill projection; no transactions are deleted.')) return;
    try {
      await json('/api/transactions/update-fixed', 'POST', { id, is_fixed: false, apply_to_all: true });
      await loadDashboard(); notify('Fixed flag removed from matching transactions.');
    } catch (error) { reportError(error); }
  };
  function selectImportFile(kind, file) {
    if (!file) return;
    if (window.importIsBusy?.()) {
      window.setImportStatus('progress', 'An import is already running. Import one file at a time; wait for its result before choosing another file.');
      return;
    }
    if (kind === 'csv') pendingCsvFile = file;
    else pendingPdfFile = file;
    $(`${kind}-file-list`).textContent = `${file.name} · ${Math.round(file.size / 1024)} KB`;
    $(`${kind}-import-btn`).disabled = false;
    return true;
  }
  function singleImportFile(files) {
    if (files.length > 1) {
      window.setImportStatus(window.importIsBusy?.() ? 'progress' : 'error', 'Choose one file at a time. No files from this selection were added.');
      return null;
    }
    return files[0];
  }
  window.onCsvSelected = event => { const file = singleImportFile(event.target.files); if (selectImportFile('csv', file)) window.FinanceAccounts?.suggestFromFile(file); };
  window.onPdfSelected = event => { const file = singleImportFile(event.target.files); if (selectImportFile('pdf', file)) window.FinanceAccounts?.suggestFromFile(file); };
  window.handleCsvDrop = event => {
    event.preventDefault();
    const file = singleImportFile(event.dataTransfer.files);
    if (file && (/\.(csv|tsv|txt|ofx|qfx|qbo)$/i.test(file.name) || file.type === 'text/csv') && selectImportFile('csv', file)) window.FinanceAccounts?.suggestFromFile(file);
  };
  window.handlePdfDrop = event => { event.preventDefault(); const file = singleImportFile(event.dataTransfer.files); if (file?.type === 'application/pdf' && selectImportFile('pdf', file)) window.FinanceAccounts?.suggestFromFile(file); };

  // Navigation is explicit: labels can change without breaking the active state.
  // Views may carry a sub-path, e.g. #tutorials/debt opens a specific tutorial and #analytics/compass the Spending Compass.
  window.showView = function(route) {
    if (!FinanceSession.isAuthenticated()) return;
    const titles = { dashboard: 'Dashboard', categories: 'Categories', 'category-admin': 'Manage categories', transactions: 'Transactions', 'transaction-review': 'Transaction troubleshooting', activity: 'Activity log', accounts: 'Accounts', analytics: 'Analytics', etl: 'Legacy import review', payoff: 'Debt-free plan', goals: 'Goals', insights: 'Spending coach', tutorials: 'Tutorials', settings: 'Settings & support' };
    let [view, sub = ''] = String(route || '').split(/\/(.*)/s);
    if (!Object.prototype.hasOwnProperty.call(titles, view)) { view = 'dashboard'; sub = ''; }
    if (view === 'analytics') sub = sub === 'compass' ? sub : '';
    else if (view === 'transactions') {
      if (sub && !validTransactionId(sub)) { notify('Invalid transaction link. Showing all transactions.'); sub = ''; }
      if (sub || transactionId) { clearTransactionFilters(); $('txn-filter-period').value = ''; }
      transactionId = sub;
    } else if (view !== 'tutorials') sub = '';
    const title = view === 'analytics' && sub === 'compass' ? 'Spending Compass' : titles[view];
    document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `${view}-view`));
    const navView = view === 'category-admin' ? 'categories' : view;
    document.querySelectorAll('.nav-btn').forEach(node => {
      const active = node.dataset.view === navView;
      node.classList.toggle('active', active);
      if (active) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });
    $('current-page').textContent = title;
    document.title = `${title} · MyFinance`;
    closeSidebar();
    const hash = `#${view}${sub ? `/${sub}` : ''}`;
    if (location.hash !== hash) history.pushState(null, '', hash);
    document.querySelector('.main-content').scrollTop = 0;
    const loaders = { dashboard: loadDashboard, categories: loadCategories, 'category-admin': loadCategories, transactions: loadAllTransactions, 'transaction-review': () => window.FinanceReviewTools?.loadTransfers(), activity: () => window.FinanceReviewTools?.loadActivity(), accounts: () => window.FinanceAccounts?.loadPage(), analytics: () => window.loadAnalyticsPage?.(false, sub), etl: loadEtlStaging, payoff: loadPayoffPlan, goals: loadGoals, insights: generateInsights, tutorials: () => window.FinanceTutorials?.open(sub) };
    const finish = window.FinancePerformance?.begin('page', view === 'analytics' && sub === 'compass' ? 'compass' : view);
    Promise.resolve(loaders[view]?.()).then(() => finish?.(), error => { finish?.('error'); reportError(error); });
  };
  window.addEventListener('hashchange', () => { if (!document.body.classList.contains('auth-pending')) window.showView(location.hash.slice(1)); });
  document.addEventListener('click', event => {
    const transaction = event.target.closest?.('a.transaction-link');
    if (transaction && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      transaction.closest('dialog[open]')?.close();
      window.showView(transaction.getAttribute('href').slice(1));
      return;
    }
    const link = event.target.closest?.('a[data-view]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    link.closest('dialog[open]')?.close();
    window.showView(link.dataset.view);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('sidebar').classList.contains('open')) {
      closeSidebar();
      $('hamburger-btn').focus();
    }
  });

  const review = document.createElement('div');
  review.className = 'panel plan-card';
  review.innerHTML = `<div><p class="eyebrow">A QUICKER WAY TO KEEP THINGS ORGANIZED</p><h2>Review category suggestions</h2><p class="muted">Start with transactions that need a category. Check the suggestions, adjust any category that looks wrong, then apply them together. Nothing changes until you approve.</p></div>
    <div class="toolbar"><label>Show <select id="review-scope"><option value="uncategorized">Needs a category</option><option value="all">All transactions</option></select></label><button id="preview-button" class="btn btn-primary">Find suggestions</button><button id="approve-button" class="btn btn-secondary" disabled>Apply selected</button><button id="approve-all-button" class="btn btn-secondary" disabled>Apply all suggestions</button></div>
    <p id="review-status" role="status"></p><div id="category-preview" class="table-scroll"></div>
    <details><summary>Saved merchant mappings · manage what the app remembers</summary><p class="muted">Changing a transaction's category creates an exact merchant mapping for future imports. These are literal matches, not regular expressions, so statement text cannot accidentally act as executable pattern syntax.</p>
    <label class="rule-search-label">Find a saved merchant<input id="rule-search" type="search" placeholder="Search merchant or category"></label>
    <div id="merchant-rules" class="table-scroll"></div>
    <form id="rule-form" class="toolbar"><label>Merchant text<input id="rule-pattern" required maxlength="200" placeholder="Merchant as shown on statement"></label><label>Display name (optional)<input id="rule-label" maxlength="100" placeholder="e.g. Local grocery store"></label><label>Category<select id="rule-category" required></select></label><label class="advanced-priority">Priority<input id="rule-priority" type="number" min="0" max="1000" value="100" step="1" required></label><button class="btn btn-primary">Add merchant rule</button></form></details>`;
  $('category-admin-content').appendChild(review);
  const categoryManager = document.createElement('section');
  categoryManager.className = 'panel plan-card category-manager';
  categoryManager.innerHTML = `<div><p class="eyebrow">YOUR CATEGORY LIST</p><h2>Manage categories</h2><p class="muted">Create a category, rename one, or remove one. When removing a category, choose where its transactions and merchant mappings should go.</p></div>
    <form id="category-create-form" class="toolbar"><label>New category name<input id="category-new-name" required maxlength="100" placeholder="e.g. Childcare"></label><button class="btn btn-primary">Create category</button></form>
    <div id="category-manager-list" class="category-manager-list"></div>
    <dialog id="category-delete-dialog" class="editor" aria-labelledby="category-delete-title"><form id="category-delete-form"><h2 id="category-delete-title">Remove category</h2><p id="category-delete-copy" class="muted"></p><label>Move its transactions and merchant mappings to<select id="category-replacement" required></select></label><p id="category-delete-error" role="alert"></p><div class="toolbar"><button type="button" class="btn btn-secondary" id="category-delete-cancel">Cancel</button><button class="btn btn-primary">Move and delete</button></div></form></dialog>`;
  $('category-admin-content').appendChild(categoryManager);
  let deletingCategory = null;
  const categoryOptions = selected => categories.map(category => `<option value="${escape(category.name)}" ${selected === category.name ? 'selected' : ''}>${escape(category.name)}</option>`).join('');
  const categoryArtwork = name => {
    const value = String(name || '').toLowerCase();
    const choices = [
      [/\b(?:credit cards?|debt|loans?|tax(?:es)?|fees?|banking)\b/, '📊', 'finance'],
      [/\b(?:childcare|child care|daycare|family|kids?)\b/, '🧸', 'care'],
      [/\b(?:pets?|pet care|veterinary|vet)\b/, '🐾', 'care'],
      [/\b(?:health(?:care)?|health care|medical|pharmacy|dental|fitness)\b/, '🩺', 'care'],
      [/\b(?:personal care|beauty|salon|grooming)\b/, '🧴', 'care'],
      [/\b(?:grocer(?:y|ies)?|food|markets?)\b/, '🥑', 'fresh'],
      [/\b(?:dining|restaurants?|coffee|cafes?|takeout)\b/, '🍽️', 'fresh'],
      [/\b(?:home|mortgage|rent|housing|household)\b/, '🏡', 'home'],
      [/\b(?:travel|vacations?|flights?|hotels?)\b/, '✈️', 'travel'],
      [/\b(?:transport(?:ation)?|cars?|auto(?:motive)?|gas|gasoline|fuel|ev|parking|tolls?|commut(?:e|ing))\b/, '🚗', 'travel'],
      [/\b(?:salary|income|payroll|wages?)\b/, '💸', 'income'],
      [/\b(?:savings?|goals?|invest(?:ment|ments|ing)?|retirement)\b/, '🌱', 'growth'],
      [/\b(?:transfers?)\b/, '🔁', 'income'],
      [/\b(?:utility|utilities|electric(?:ity)?|water|internet|phone)\b/, '⚡', 'utility'],
      [/\b(?:shop(?:ping)?|cloth(?:es|ing)?|retail)\b/, '🛍️', 'shop'],
      [/\b(?:subscriptions?|entertainment|stream(?:ing)?|movies?|recreation|hobbies)\b/, '🎬', 'play'],
      [/\b(?:education|school|tuition|books?)\b/, '📚', 'home'],
      [/\b(?:gifts?|donations?|charity)\b/, '🎁', 'shop'],
      [/\b(?:insurance)\b/, '🛡️', 'finance']
    ];
    return choices.find(([pattern]) => pattern.test(value))?.slice(1)
      || ['✨', 'other'];
  };
  window.loadCategories = async function() {
    const request = ++categoryRequest;
    $('category-filter-status').textContent = 'Loading category activity...';
    try {
      const [data, activity] = await Promise.all([
        json('/api/transactions/categorization-rules'),
        json('/api/dashboard/all-transactions')
      ]);
      if (request !== categoryRequest) return;
      const finish = window.FinancePerformance?.begin('cpu', 'categories.render');
      rules = data.rules || []; categories = data.categories || [];
      categoryPeriod.sync(activity.transactions || []);
      const period = categoryPeriod.current();
      const filtered = window.filterTransactionsByCategoryAndMonth(activity.transactions || [], '', period.months);
      const counts = new Map();
      const spending = new Map();
      const received = new Map();
      const moved = new Map();
      for (const transaction of filtered) {
        const category = transaction.category || 'Uncategorized';
        counts.set(category, (counts.get(category) || 0) + 1);
        const amount = Math.abs(Number(transaction.amount) || 0);
        if (isTransfer(transaction)) moved.set(category, (moved.get(category) || 0) + amount);
        else if (String(transaction.direction).toUpperCase() === 'DEBIT') spending.set(category, (spending.get(category) || 0) + amount);
        else if (String(transaction.direction).toUpperCase() === 'CREDIT') received.set(category, (received.get(category) || 0) + amount);
      }
      $('category-filter-status').textContent = `${period.label} · ${filtered.length.toLocaleString()} transactions`;
      $('rule-category').innerHTML = categoryOptions('');
      $('category-manager-list').innerHTML = categories.map(category => `<form class="category-manager-row" data-category="${Number(category.id)}">
        <label><span>${escape(category.name)}</span><input data-category-name aria-label="Rename ${escape(category.name)}" maxlength="100" value="${escape(category.name)}"></label>
        <button class="btn btn-secondary" type="submit">Rename</button>
        <button class="btn btn-secondary" type="button" data-delete-category="${Number(category.id)}" ${categories.length < 2 ? 'disabled title="Add another category before deleting this one"' : ''}>Delete</button>
      </form>`).join('');
      const transactionCount = categories.reduce((total, category) => total + (counts.get(category.name) || 0), 0);
      const totalSpend = [...spending.values()].reduce((total, amount) => total + amount, 0);
      const active = categories.filter(category => counts.has(category.name));
      const spendingCategories = active.filter(category => (spending.get(category.name) || 0) > 0)
        .sort((a, b) => spending.get(b.name) - spending.get(a.name) || a.name.localeCompare(b.name));
      const otherCategories = active.filter(category => !(spending.get(category.name) > 0))
        .sort((a, b) => a.name.localeCompare(b.name));
      const inactive = categories.filter(category => !counts.has(category.name)).sort((a, b) => a.name.localeCompare(b.name));
      $('category-overview-summary').innerHTML = `<div><span><small>Total spending</small><strong>${money(totalSpend)}</strong><small>Transfers excluded</small></span></div><div><span><small>Active categories</small><strong>${active.length}<em> / ${categories.length}</em></strong><small>In this period</small></span></div><div><span><small>Transactions</small><strong>${transactionCount.toLocaleString()}</strong><small>Across your categories</small></span></div>`;
      const renderCard = category => {
        const [icon, art] = categoryArtwork(category.name);
        const count = counts.get(category.name) || 0;
        const spent = spending.get(category.name) || 0;
        const incoming = received.get(category.name) || 0;
        const transferred = moved.get(category.name) || 0;
        const amount = spent || incoming || transferred;
        const label = spent ? 'spent' : incoming ? 'received' : transferred ? 'transfer activity' : count ? 'activity' : 'No activity in this period';
        const share = spent && totalSpend ? spent / totalSpend * 100 : 0;
        return `<button class="category-card category-${art}${count ? '' : ' is-inactive'}" type="button" data-open-category="${escape(category.name)}" aria-label="View ${escape(category.name)}, ${count} transaction${count === 1 ? '' : 's'}">
          <span class="category-card-head"><span class="category-card-art" aria-hidden="true"><span>${icon}</span><i></i><b></b></span><strong>${escape(category.name)}</strong><span class="category-card-arrow" aria-hidden="true">↗</span></span>
          <span class="category-card-copy">${count ? `<span class="category-card-total">${money(amount)}</span>` : ''}<small>${label}${count ? ` · ${count.toLocaleString()} transaction${count === 1 ? '' : 's'}` : ''}</small></span>
          ${spent ? `<span class="category-card-share"><span><span>Of total spending</span><strong>${share.toFixed(1)}%</strong></span><span class="category-share-track" aria-hidden="true"><i style="width:${share.toFixed(2)}%"></i></span></span>` : ''}
        </button>`;
      };
      const renderGroup = (list, title, description, id) => list.length ? `<section class="category-group" aria-labelledby="${id}"><div class="category-group-heading"><h2 id="${id}">${title} <span>${list.length}</span></h2><p>${description}</p></div><div class="category-card-grid">${list.map(renderCard).join('')}</div></section>` : '';
      $('category-cards').innerHTML = categories.length
        ? `${renderGroup(spendingCategories, 'Your spending', 'Largest first, so the important things stand out.', 'category-spending-title')}${renderGroup(otherCategories, 'Other money movement', 'Deposits and transfers, separate from spending. Open a category to see the breakdown.', 'category-movement-title')}${inactive.length ? `<details class="category-inactive"><summary>No activity this period <span>${inactive.length}</span></summary><div class="category-card-grid">${inactive.map(renderCard).join('')}</div></details>` : ''}`
        : '<div class="category-empty">Your categories will appear here when they are ready.</div>';
      window.emitFinanceEvent('categories:rendered', { period, transactions: filtered, allTransactions: activity.transactions || [], categories });
      $('category-replacement').innerHTML = categories
        .filter(category => String(category.id) !== String(deletingCategory?.id))
        .map(category => `<option value="${Number(category.id)}">${escape(category.name)}</option>`).join('');
    $('merchant-rules').innerHTML = `<table class="review-table rule-table"><thead><tr><th>Merchant</th><th>Category</th><th>Priority</th><th>Enabled</th><th></th></tr></thead><tbody>${rules.map((rule, index) => `<tr data-rule="${index}" data-rule-search="${escape(`${rule.display_label || ''} ${rule.pattern} ${rule.category || ''}`.toLowerCase())}"><td><strong>${escape(rule.display_label || rule.pattern)}</strong><details class="rule-edit"><summary>Edit merchant name</summary><input data-rule-pattern aria-label="Merchant text" maxlength="256" value="${escape(rule.pattern)}"><label>Display name<input data-rule-label aria-label="Display name" value="${escape(rule.display_label)}"></label></details></td><td><select aria-label="Rule category">${categoryOptions(rule.category)}</select></td><td><details class="rule-edit"><summary>Advanced</summary><input aria-label="Rule priority" type="number" min="0" max="1000" step="1" value="${Number(rule.priority) || 0}"></details></td><td><input aria-label="Rule enabled" type="checkbox" ${fixed(rule.enabled) ? 'checked' : ''}></td><td><button class="btn btn-secondary" data-save-rule="${index}">Save</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No saved merchant mappings yet. Change a transaction category to create one automatically.</td></tr>'}</tbody></table>`;
      finish?.();
    } catch (error) {
      if (request !== categoryRequest) return;
      $('category-filter-status').textContent = `Could not load categories: ${error.message}`;
      $('category-cards').textContent = '';
      $('category-overview-summary').textContent = '';
      reportError(error);
    }
  };
  // `period` is a month/date string, or a resolved `{ months, label }` from a period control.
  window.openCategoryTransactions = async (category, period = window.resolvePeriod('last-3')) => {
    const request = ++detailRequest;
    const resolved = period && typeof period === 'object'
      ? period
      : { months: period ? [monthKey(period)] : null, label: periodLabel(period ? monthKey(period) : '') };
    const months = resolved.months;
    detailCategory = category;
    $('category-dialog-month').value = months && months.length === 1 ? months[0] : '';
    $('mtd-dialog-title').textContent = category;
    $('mtd-dialog-period').textContent = resolved.label;
    $('mtd-dialog-total').textContent = '—';
    $('mtd-dialog-count').textContent = '—';
    $('mtd-dialog-content').innerHTML = '<div class="mtd-dialog-state"><div><strong>Loading transactions…</strong>Please wait while we gather this period’s activity.</div></div>';
    if (!mtdDialog.open) mtdDialog.showModal();
    try {
      const data = await json('/api/dashboard/all-transactions');
      if (request !== detailRequest) return;
      const transactions = window.filterTransactionsByCategoryAndMonth(data.transactions || [], category, months)
        .sort((a, b) => transactionDate(b.date) - transactionDate(a.date));
      const spending = transactions.filter(transaction => String(transaction.direction).toUpperCase() === 'DEBIT' && !isTransfer(transaction))
        .reduce((total, transaction) => total + Math.abs(Number(transaction.amount) || 0), 0);
      $('mtd-dialog-total').textContent = money(spending);
      $('mtd-dialog-count').textContent = transactions.length.toLocaleString();
      $('mtd-dialog-content').innerHTML = transactions.length ? `<div class="mtd-transaction-list">${transactions.map(transaction => {
        const debit = String(transaction.direction).toUpperCase() === 'DEBIT';
        return `<article class="mtd-transaction-row">
          <div><div class="mtd-transaction-description">${window.transactionLink(transaction.id, transaction.display_name || transaction.description)}${transferBadge(transaction)}</div>
            <div class="mtd-transaction-date">${escape(transactionDate(transaction.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</div></div>
          <div class="mtd-transaction-amount ${debit ? 'debit' : 'credit'}">${debit ? '−' : '+'}${money(Math.abs(Number(transaction.amount) || 0))}</div>
        </article>`;
      }).join('')}</div>` : '<div class="mtd-dialog-state"><div><strong>No transactions found</strong>There are no transactions for this category in the selected period.</div></div>';
    } catch (error) {
      if (request !== detailRequest) return;
      $('mtd-dialog-total').textContent = '—';
      $('mtd-dialog-count').textContent = '—';
      $('mtd-dialog-content').innerHTML = `<div class="mtd-dialog-state"><div><strong>Could not load transactions</strong>${escape(error.message || 'Please try again.')}</div></div>`;
    }
  };
  $('category-dialog-month').onchange = () => window.openCategoryTransactions(detailCategory, $('category-dialog-month').value);
  $('category-dialog-all').onclick = () => window.openCategoryTransactions(detailCategory, '');
  $('category-cards').onclick = async event => {
    const card = event.target.closest('[data-open-category]');
    if (!card) return;
    return window.openCategoryTransactions(card.dataset.openCategory, categoryPeriod.current());
  };
  $('category-create-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      await json('/api/categories', 'POST', { name: $('category-new-name').value.trim() });
      $('category-new-name').value = '';
      await loadCategories();
      notify('Category created.');
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
  $('category-manager-list').onsubmit = async event => {
    if (!event.target.matches('[data-category]')) return;
    event.preventDefault();
    const row = event.target;
    const button = row.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await json(`/api/categories/${encodeURIComponent(row.dataset.category)}`, 'PUT', { name: row.querySelector('[data-category-name]').value.trim() });
      await Promise.all([loadCategories(), loadAllTransactions()]);
      notify('Category renamed.');
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
  $('category-manager-list').onclick = event => {
    const button = event.target.closest('[data-delete-category]');
    if (!button) return;
    deletingCategory = categories.find(category => String(category.id) === button.dataset.deleteCategory);
    if (!deletingCategory) return;
    $('category-delete-error').textContent = '';
    $('category-delete-copy').textContent = `Transactions and saved merchant mappings assigned to "${deletingCategory.name}" will move to the category you choose below.`;
    $('category-replacement').innerHTML = categories
      .filter(category => String(category.id) !== String(deletingCategory.id))
      .map(category => `<option value="${Number(category.id)}">${escape(category.name)}</option>`).join('');
    $('category-delete-dialog').showModal();
  };
  $('category-delete-cancel').onclick = () => $('category-delete-dialog').close();
  $('category-delete-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const result = await json(`/api/categories/${encodeURIComponent(deletingCategory.id)}`, 'DELETE', { replacementId: Number($('category-replacement').value) });
      $('category-delete-dialog').close();
      deletingCategory = null;
      await Promise.all([loadCategories(), loadAllTransactions()]);
      notify(`Category deleted. ${result.transactions} transaction${result.transactions === 1 ? '' : 's'} moved.`);
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
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
      $('category-preview').innerHTML = `${warnings.length ? `<div class="coach-note warning" role="status"><strong>Some older rules need repair</strong><p>These rules were skipped so they cannot block other suggestions. Edit or disable them under Saved merchant rules.</p><ul>${warnings.map(rule => `<li>${escape(rule.message)}</li>`).join('')}</ul></div>` : ''}${suggestions.length ? `<table class="review-table"><thead><tr><th><input id="select-suggestions" type="checkbox" aria-label="Select all suggestions"></th><th>Transaction</th><th>Current</th><th>Suggested category</th><th>Match</th></tr></thead><tbody>${suggestions.map((item, index) => `<tr><td><input type="checkbox" data-suggestion="${index}" aria-label="Select ${escape(item.description)}"></td><td><strong>${window.transactionLink(item.id, item.description)}</strong><div class="muted">${escape(item.date || '')}${item.amount == null ? '' : ` · ${money(item.amount)}`}</div></td><td>${escape(item.currentCategory || 'Uncategorized')}</td><td><select data-suggestion-category="${index}" aria-label="Category for ${escape(item.description)}">${categoryOptions(item.suggestedCategory)}</select></td><td><span title="${escape(item.reason)}">${escape(item.reason)}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No changes suggested. Your existing categories are untouched.</p>'}`;
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
    if (confirmAll && !await FinanceUI.confirm(`Apply the selected categories to all ${updates.length} suggested transactions? You can review each suggestion before approving.`)) return;
    $('approve-button').disabled = true; $('approve-all-button').disabled = true;
    $('preview-button').disabled = true;
    try {
      const data = await json('/api/transactions/categorization-apply', 'POST', { updates, learnRules: true });
      $('review-status').textContent = `${data.updated} categories updated${data.rulesSaved ? ` · ${data.rulesSaved} merchant rule${data.rulesSaved === 1 ? '' : 's'} saved for future imports` : ''}${data.rulesSkipped ? ` · ${data.rulesSkipped} conflicting merchant rule${data.rulesSkipped === 1 ? ' was' : 's were'} skipped` : ''}. Find suggestions again to review what remains.`;
      $('category-preview').textContent = ''; suggestions = [];
      await loadCategories();
    } catch (error) { $('review-status').textContent = `${error.message} Preview again if categories changed since this review.`; }
    finally { $('preview-button').disabled = false; $('approve-all-button').disabled = !suggestions.length; }
  }
  $('approve-button').onclick = () => applySuggestions(Array.from($('category-preview').querySelectorAll('[data-suggestion]:checked')));
  $('approve-all-button').onclick = () => applySuggestions(Array.from(suggestions, (_, index) => ({ dataset: { suggestion: String(index) } })), true);

  window.loadAllTransactions = async function() {
    const finish = window.FinancePerformance?.begin('panel', 'transactions.load');
    const table = $('full-txn-table');
    const request = ++transactionRequest;
    table.innerHTML = '<tr><td colspan="5" class="empty-state">Loading transactions...</td></tr>';
    $('txn-pagination').hidden = true;
    $('txn-summary').textContent = '';
    $('txn-filter-status').textContent = 'Loading activity...';
    try {
      const [allCategories, data] = await Promise.all([json('/api/categories'), json('/api/dashboard/all-transactions')]);
      if (request !== transactionRequest) return;
      transactionCache = { allCategories, transactions: data.transactions || [] };
      transactionPeriod.sync(transactionCache.transactions);
      renderTransactions();
    } catch (error) {
      if (request !== transactionRequest) return;
      table.innerHTML = `<tr><td colspan="5" class="empty-state" role="alert">${escape(error.message)}</td></tr>`;
      $('txn-filter-status').textContent = 'Could not load transactions. Change a filter or reopen this page to retry.';
      finish?.('error');
      return;
    }
    finish?.();
  };
  const similarDialog = document.createElement('dialog');
  similarDialog.id = 'similar-dialog'; similarDialog.className = 'editor similar-dialog';
  similarDialog.setAttribute('aria-labelledby', 'similar-title');
  similarDialog.innerHTML = `<form id="similar-form"><p class="eyebrow">MATCHING PAYMENTS FOUND</p><h2 id="similar-title">Update similar transactions?</h2><p id="similar-copy" class="muted"></p>
    <div class="similar-head"><label class="similar-all"><input type="checkbox" id="similar-all">Select all</label><span id="similar-count"></span></div>
    <div id="similar-list" class="similar-list"></div><p id="similar-error" role="alert"></p>
    <label id="similar-remember-label" class="similar-all"><input type="checkbox" id="similar-remember" checked>Remember this category for future imports</label>
    <div class="toolbar"><button type="button" class="btn btn-secondary" id="similar-cancel">Cancel</button><button type="button" class="btn btn-secondary" id="similar-skip">Only this one</button><button class="btn btn-primary" id="similar-apply">Update selected</button></div></form>`;
  document.body.appendChild(similarDialog);
  let similarState = null;
  const similarChecked = () => [...$('similar-list').querySelectorAll('input[data-similar]')].filter(box => box.checked);
  function updateSimilarCount() {
    const total = similarState ? similarState.items.length : 0, count = similarChecked().length;
    $('similar-count').textContent = `${count} of ${total} selected`;
    $('similar-all').checked = total > 0 && count === total;
    const selected = count + (similarState?.categoryReview ? 1 : 0);
    $('similar-apply').textContent = selected ? `Update ${selected} transaction${selected === 1 ? '' : 's'}` : 'Update selected';
    $('similar-apply').disabled = !selected;
  }
  // Category review includes the starting transaction; other edits return only extra updates.
  // `change` is a category name, { isFixed } for the fixed-bill flag, { payMode } for auto-pay/manual, or { income } for deposits.
  function promptSimilarTransactions(source, change, items, query = '') {
    const byPay = typeof change === 'object' && Object.prototype.hasOwnProperty.call(change, 'payMode');
    const byIncome = typeof change === 'object' && Object.prototype.hasOwnProperty.call(change, 'income');
    const byFixed = typeof change === 'object' && !byPay && !byIncome;
    const preselect = byPay || byIncome;
    const categoryReview = typeof change === 'string';
    similarState = { source, change, byFixed, byPay, byIncome, categoryReview, items, updated: 0 };
    $('similar-remember-label').hidden = !categoryReview;
    $('similar-remember').checked = true;
    $('similar-skip').disabled = false;
    $('similar-cancel').hidden = !categoryReview;
    $('similar-cancel').disabled = false;
    const strong = items.filter(item => item.sameAmount).length;
    const incomeLabel = value => value ? 'Income' : 'Not income';
    const action = byIncome ? (change.income ? 'also <strong>count as your income</strong>' : 'also <strong>stop counting as income</strong>')
      : byPay ? (change.payMode ? `also be marked <strong>${payLabel(change.payMode)}</strong>` : 'also have their <strong>payment method cleared</strong>')
      : byFixed ? (change.isFixed ? 'also be marked as <strong>fixed bills</strong>' : 'also <strong>stop being fixed bills</strong>') : `also move to <strong>${escape(change || 'Uncategorized')}</strong>`;
    const fixedLabel = value => value ? 'Fixed bill' : 'Not fixed';
    $('similar-title').textContent = byIncome ? 'Apply to other deposits from this sender?' : byPay ? 'Apply to similar payments?' : byFixed ? (change.isFixed ? 'Mark similar payments as fixed?' : 'Unmark similar payments?') : 'Update similar transactions?';
    const hint = byIncome ? 'All deposits from this sender are preselected so your payday forecast stays consistent. '
      : byPay ? 'All payments to this biller are preselected — they are usually paid the same way. '
      : strong ? `${strong} with about the same amount ${strong === 1 ? 'is' : 'are'} preselected. ` : '';
    $('similar-copy').innerHTML = `Found <strong>${items.length}</strong> other transaction${items.length === 1 ? '' : 's'} from <strong>${escape(source.display_name || window.merchantKey(source.description))}</strong>. ${query ? `Started from your search “${escape(query)}”; also checked the same bank merchant across other transactions. ` : ''}${hint}Choose which should ${action}.`;
    if (categoryReview) $('similar-copy').innerHTML += ' The transaction you started from is included. Nothing changes until you confirm.';
    $('similar-list').innerHTML = items.map(({ transaction, sameAmount }, index) => {
      const debit = String(transaction.direction).toUpperCase() === 'DEBIT';
      const from = byIncome ? incomeLabel(!!transaction.counts_as_income) : byPay ? payLabel(payModeOf(transaction)) : byFixed ? fixedLabel(fixed(transaction.is_fixed)) : escape(transaction.category || 'Uncategorized');
      const to = byIncome ? incomeLabel(change.income) : byPay ? payLabel(change.payMode) : byFixed ? fixedLabel(change.isFixed) : escape(change || 'Uncategorized');
      return `<label class="similar-row${sameAmount || preselect ? ' is-strong' : ''}"><input type="checkbox" data-similar="${index}" ${sameAmount || preselect ? 'checked' : ''}>
        <span class="similar-date">${escape(transactionDate(transaction.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</span>
        <span class="similar-desc">${window.transactionLink(transaction.id, transaction.display_name || transaction.description)}<small>${from} &rarr; ${to}${sameAmount || preselect ? '' : ' &middot; different amount'}</small></span>
        <span class="similar-amt ${debit ? 'amount-debit' : 'amount-credit'}">${debit ? '−' : '+'}${money(Math.abs(transaction.amount))}</span></label>`;
    }).join('');
    $('similar-error').textContent = '';
    updateSimilarCount();
    return new Promise(resolve => { similarState.resolve = resolve; similarDialog.showModal(); });
  }
  similarDialog.addEventListener('close', () => { const state = similarState; similarState = null; state?.resolve?.(state.updated); });
  $('similar-list').onchange = updateSimilarCount;
  $('similar-all').onchange = () => { [...$('similar-list').querySelectorAll('input[data-similar]')].forEach(box => { box.checked = $('similar-all').checked; }); updateSimilarCount(); };
  $('similar-skip').onclick = () => similarState?.categoryReview ? saveSimilar(true) : similarDialog.close();
  $('similar-cancel').onclick = () => { if (!similarState?.saving) similarDialog.close(); };
  $('similar-form').onsubmit = async event => {
    event.preventDefault();
    await saveSimilar();
  };
  async function saveSimilar(onlySource = false) {
    if (!similarState || similarState.saving) return;
    const selected = onlySource ? [] : similarChecked().map(box => similarState.items[Number(box.dataset.similar)].transaction);
    if (similarState.categoryReview) selected.unshift(similarState.source);
    if (!selected.length) return similarDialog.close();
    similarState.saving = true;
    $('similar-skip').disabled = true;
    $('similar-cancel').disabled = true;
    $('similar-apply').disabled = true; $('similar-error').textContent = '';
    try {
      const result = similarState.byIncome
        ? await json('/api/transactions/update-income-role', 'POST', { ids: selected.map(t => Number(t.id)), income_role: similarState.change.income ? 'income' : 'other' })
        : similarState.byPay
        ? await json('/api/transactions/update-pay-mode', 'POST', { ids: selected.map(t => Number(t.id)), pay_mode: similarState.change.payMode || null })
        : similarState.byFixed
        ? await json('/api/transactions/update-fixed-many', 'POST', { ids: selected.map(t => Number(t.id)), is_fixed: similarState.change.isFixed })
        : await json('/api/transactions/categorization-apply', 'POST', {
          updates: selected.map(t => ({ id: Number(t.id), category: similarState.change, expectedCategory: t.category ?? null })),
          learnRules: $('similar-remember').checked, protectCorrections: false
        });
      similarState.updated = Number(result?.updated ?? selected.length);
      similarDialog.close();
    } catch (error) {
      similarState.saving = false;
      $('similar-skip').disabled = false;
      $('similar-cancel').disabled = false;
      $('similar-error').textContent = error.message || 'Could not update these transactions.';
      $('similar-apply').disabled = false;
    }
    similarDialog.addEventListener('cancel', event => { if (similarState?.saving) event.preventDefault(); });
  }
  // Rename rules: a friendly name shown for every past and future transaction containing the chosen words.
  // The bank's own description is kept (and shown underneath) because transfer and income detection rely on it.
  const RAIL_WORDS = new Set(['ZELLE', 'VENMO', 'PAYPAL', 'CASH', 'APP', 'SQUARE', 'SQ', 'TO', 'FROM', 'SENT', 'RECEIVED', 'PAYMENT']);
  window.suggestDisplayName = pattern => {
    const words = String(pattern || '').split(/\s+/).filter(Boolean);
    while (words.length > 1 && RAIL_WORDS.has(words[0].toUpperCase())) words.shift();
    return words.join(' ').toLowerCase().replace(/(^|[\s'&-])([a-z])/g, (_, lead, char) => lead + char.toUpperCase()).slice(0, 80);
  };
  const renameDialog = document.createElement('dialog');
  renameDialog.id = 'rename-dialog'; renameDialog.className = 'editor rename-dialog';
  renameDialog.setAttribute('aria-labelledby', 'rename-title');
  renameDialog.innerHTML = `<form id="rename-form"><p class="eyebrow">CLEAN UP A NAME</p><h2 id="rename-title">Rename this payee</h2>
    <p class="rename-original"><span class="muted">Bank description</span><code id="rename-original"></code></p>
    <label for="rename-name">Show as<input id="rename-name" maxlength="80" required autocomplete="off" placeholder="e.g. Cristiane De Lima"></label>
    <label for="rename-pattern">Match transactions containing these words<input id="rename-pattern" maxlength="256" required autocomplete="off" spellcheck="false">
      <small class="muted">These words, in this order, anywhere in the bank description. Numbers such as reference codes are ignored, so every payment to the same payee matches.</small></label>
    <div id="rename-preview" class="rename-preview" aria-live="polite"></div><p id="rename-error" role="alert"></p>
    <label class="similar-all"><input type="checkbox" id="rename-remember" checked>Remember this name for future imports</label>
    <div class="toolbar"><button type="button" class="btn btn-secondary rename-remove" id="rename-remove" hidden>Remove rename</button><span class="toolbar-spacer"></span><button type="button" class="btn btn-secondary" id="rename-cancel">Cancel</button><button class="btn btn-primary" id="rename-save">Rename</button></div></form>`;
  document.body.appendChild(renameDialog);
  const rulesDialog = document.createElement('dialog');
  rulesDialog.id = 'name-rules-dialog'; rulesDialog.className = 'editor rename-dialog';
  rulesDialog.setAttribute('aria-labelledby', 'name-rules-title');
  rulesDialog.innerHTML = `<div><p class="eyebrow">YOUR NAMES</p><h2 id="name-rules-title">Renamed payees</h2>
    <p class="muted">Saved rules name future matching imports. Existing payments keep the names you selected in the rename review. To rename payments, press <strong>Rename</strong> next to a transaction.</p>
    <div id="name-rules-list" class="name-rules-list"></div><p id="name-rules-error" role="alert"></p>
    <div class="toolbar"><span class="toolbar-spacer"></span><button type="button" class="btn btn-primary" id="name-rules-close">Done</button></div></div>`;
  document.body.appendChild(rulesDialog);
  let renameState = null, renameTimer = null, renameRequest = 0;
  let renameMatches = [];
  const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
  async function previewRename() {
    const request = ++renameRequest, pattern = $('rename-pattern').value;
    renameMatches = [];
    $('rename-save').disabled = true;
    try {
      const result = await json('/api/transactions/name-rules/preview', 'POST', { pattern });
      if (request !== renameRequest) return;
      renameMatches = result.transactions || [];
      $('rename-preview').innerHTML = !result.pattern
        ? '<p class="rename-none">Add at least one word (numbers on their own are ignored).</p>'
        : `<p><strong>Matches ${plural(result.count, 'transaction')}</strong>. Select the payments to rename. Future imports are controlled separately below.</p><label class="similar-all"><input type="checkbox" id="rename-all" checked>Select all</label><div class="similar-list">${renameMatches.map(t => `<label class="similar-row"><input type="checkbox" data-rename-match="${t.id}" checked><span class="similar-date">${escape(transactionDate(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</span><span class="similar-desc">${escape(t.display_name || t.description)}${t.display_name ? `<small>${escape(t.description)}</small>` : ''}</span><span class="similar-amt">${String(t.direction).toUpperCase() === 'CREDIT' ? '+' : '−'}${money(Math.abs(t.amount))}</span></label>`).join('')}</div>`;
      $('rename-save').disabled = !result.pattern || !renameMatches.length;
    } catch (error) { if (request === renameRequest) { renameMatches = []; $('rename-save').disabled = true; $('rename-preview').textContent = error.message; } }
  }
  window.openRenameDialog = async transaction => {
    renameState = { id: null };
    const state = renameState;
    renameMatches = [];
    $('rename-remember').checked = true;
    $('rename-original').textContent = transaction.description || '';
    $('rename-error').textContent = ''; $('rename-preview').textContent = 'Checking matching transactions…';
    $('rename-name').value = transaction.display_name || ''; $('rename-pattern').value = '';
    $('rename-remove').hidden = true; $('rename-title').textContent = 'Rename this payee';
    $('rename-save').disabled = true; $('rename-save').textContent = 'Rename';
    renameDialog.showModal();
    try {
      const result = await json('/api/transactions/name-rules/preview', 'POST', { description: transaction.description || '' });
      if (renameState !== state) return;
      const current = result.current;
      renameState.id = current?.id ?? null;
      const merchant = window.merchantKey(transaction.description);
      const broaden = result.count > 1 && result.suggested === merchant
        && current?.pattern?.includes(result.suggested);
      $('rename-pattern').value = broaden ? result.suggested : current?.pattern || result.suggested || '';
      $('rename-name').value = current?.name || transaction.display_name || window.suggestDisplayName(result.suggested);
      $('rename-remove').hidden = !current;
      $('rename-title').textContent = current ? 'Edit this name' : 'Rename this payee';
      $('rename-save').textContent = current ? 'Save name' : 'Rename';
      $('rename-name').focus(); $('rename-name').select();
      await previewRename();
    } catch (error) { if (renameState === state) $('rename-error').textContent = error.message; }
  };
  renameDialog.addEventListener('close', () => { renameState = null; renameRequest++; clearTimeout(renameTimer); });
  $('rename-pattern').oninput = () => {
    renameRequest++; renameMatches = []; $('rename-save').disabled = true;
    clearTimeout(renameTimer); renameTimer = setTimeout(previewRename, 250);
  };
  $('rename-preview').onchange = event => {
    const boxes = [...$('rename-preview').querySelectorAll('[data-rename-match]')];
    if (event.target.id === 'rename-all') boxes.forEach(box => { box.checked = event.target.checked; });
    const count = boxes.filter(box => box.checked).length;
    $('rename-all').checked = count === boxes.length && count > 0;
    $('rename-save').disabled = !count || !renameMatches.length;
    $('rename-save').textContent = count ? `Rename ${count} payment${count === 1 ? '' : 's'}` : 'Select payments';
  };
  $('rename-cancel').onclick = () => renameDialog.close();
  const afterRename = async message => {
    window.FinancePlan?.invalidate?.();
    window.emitFinanceEvent?.('finance:names-changed', {});
    notify(message);
    if (FinanceSession.isAuthenticated()) await loadAllTransactions();
  };
  $('rename-form').onsubmit = async event => {
    event.preventDefault();
    if (!renameState || renameState.saving) return;
    $('rename-save').disabled = true; $('rename-error').textContent = '';
    try {
      const ids = [...$('rename-preview').querySelectorAll('[data-rename-match]')].filter(box => box.checked).map(box => Number(box.dataset.renameMatch));
      if (!ids.length || !renameMatches.length) throw new Error('Select payments from the current matching preview before saving.');
      const remember = $('rename-remember').checked;
      renameState.saving = true;
      $('rename-cancel').disabled = true;
      const result = await json('/api/transactions/name-rules', 'POST', { pattern: $('rename-pattern').value, name: $('rename-name').value, ids, remember, ...(renameState.id ? { id: renameState.id } : {}) });
      renameDialog.close();
      await afterRename(`Now showing “${result.rule.name}” for ${plural(result.rule.matches, 'transaction')}.${remember ? ' Future imports with these words get the same name.' : ' No future rename rule saved.'}`);
    } catch (error) { if (renameState) renameState.saving = false; $('rename-error').textContent = error.message; $('rename-save').disabled = false; }
    finally { $('rename-cancel').disabled = false; }
  };
  renameDialog.addEventListener('cancel', event => { if (renameState?.saving) event.preventDefault(); });
  $('rename-remove').onclick = async () => {
    if (!renameState?.id) return;
    try {
      const result = await json(`/api/transactions/name-rules/${renameState.id}`, 'DELETE');
      renameDialog.close();
      await afterRename(`Rename removed. ${plural(result.changed, 'transaction')} show the bank description again.`);
    } catch (error) { $('rename-error').textContent = error.message; }
  };
  async function renderNameRules() {
    const list = $('name-rules-list');
    list.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { rules } = await json('/api/transactions/name-rules');
      list.innerHTML = rules.length ? rules.map(rule => `<div class="name-rule-row"><div><strong>${escape(rule.name)}</strong><small>Words: <code>${escape(rule.pattern)}</code> · ${plural(rule.matches, 'transaction')}</small></div>
        <button type="button" class="btn btn-secondary" data-remove-rule="${escape(rule.id)}" aria-label="Remove rename ${escape(rule.name)}">Remove</button></div>`).join('')
        : '<p class="empty-state">No renames yet. Messy names like “SENT 626800I0ARPL Zelle CRISTIANE DE LIMA” can be shown as “Cristiane De Lima”.</p>';
    } catch (error) { list.innerHTML = ''; $('name-rules-error').textContent = error.message; }
  }
  window.openNameRules = () => { $('name-rules-error').textContent = ''; rulesDialog.showModal(); return renderNameRules(); };
  $('name-rules-close').onclick = () => rulesDialog.close();
  $('name-rules-list').onclick = async event => {
    const button = event.target.closest('[data-remove-rule]');
    if (!button) return;
    button.disabled = true;
    try {
      const result = await json(`/api/transactions/name-rules/${button.dataset.removeRule}`, 'DELETE');
      await renderNameRules();
      await afterRename(`Rename removed. ${plural(result.changed, 'transaction')} show the bank description again.`);
    } catch (error) { $('name-rules-error').textContent = error.message; button.disabled = false; }
  };
  document.addEventListener('click', event => { if (event.target.closest?.('[data-name-rules]')) window.openNameRules(); });
  const describe = (transaction, query) => transaction.display_name
    ? `<strong class="tx-name">${highlight(transaction.display_name, query)}</strong><div class="tx-original" title="Bank description">${highlight(transaction.description, query)}</div>`
    : highlight(transaction.description, query);
  const transactionDateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  function renderTransactions(page = 0) {
    const finish = window.FinancePerformance?.begin('cpu', 'transactions.render');
    const table = $('full-txn-table');
    const { allCategories, transactions } = transactionCache;
    {
      const selected = $('txn-filter-category').value;
      const period = transactionPeriod.current();
      const query = String($('txn-filter-search').value || '').trim();
      $('txn-filter-category').innerHTML = '<option value="">All categories</option>' + allCategories.map(c => `<option value="${escape(c.name)}" ${selected === c.name ? 'selected' : ''}>${escape(c.name)}</option>`).join('');
      const rows = window.filterTransactionsByCategoryAndMonth(transactions, selected, period.months)
        .filter(t => !transactionId || String(t.id) === transactionId)
        .filter(t => !$('txn-filter-fixed').checked || (fixed(t.is_fixed) && String(t.direction).toUpperCase() === 'DEBIT'))
        .filter(t => window.matchesPayModeFilter(t, $('txn-filter-paymode').value))
        .filter(t => window.matchesTransactionSearch(t, query))
        .sort((a,b) => transactionDate(b.date) - transactionDate(a.date));
      const total = direction => rows.filter(t => String(t.direction).toUpperCase() === direction && !isTransfer(t)).reduce((sum, t) => sum + Math.abs(Number(t.amount) || 0), 0);
      const transfers = rows.filter(isTransfer).length;
      const income = total('CREDIT'), expenses = total('DEBIT');
      const pageSize = 100, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
      page = Math.max(0, Math.min(page, pageCount - 1));
      const offset = page * pageSize;
      const visibleRows = rows.slice(offset, offset + pageSize);
      const pagination = $('txn-pagination');
      pagination.hidden = rows.length <= pageSize;
      pagination.innerHTML = `<span role="status">${offset + 1}–${offset + visibleRows.length} of ${rows.length.toLocaleString()} transactions · Page ${page + 1} of ${pageCount}</span>
        <button type="button" class="btn btn-secondary btn-compact" data-txn-page="previous" ${page === 0 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn-secondary btn-compact" data-txn-page="next" ${page === pageCount - 1 ? 'disabled' : ''}>Next</button>`;
      pagination.onclick = event => {
        const direction = event.target.closest?.('[data-txn-page]')?.dataset.txnPage;
        if (!direction) return;
        renderTransactions(page + (direction === 'next' ? 1 : -1));
        $('txn-pagination').querySelector(`[data-txn-page="${direction}"]`)?.focus({ preventScroll: true });
        table.scrollIntoView({ block: 'start' });
      };
      $('txn-filter-status').textContent = `${transactionId ? `Transaction #${transactionId} · ` : ''}${period.label}${query ? ` · “${query}”` : ''} · ${rows.length.toLocaleString()} matching transactions${transactionId ? ' · Reset filters to see all activity.' : ''}`;
      $('txn-summary').innerHTML = [['Money in', income, 'income'], ['Money out', expenses, 'expense'], ['Net activity', income - expenses, 'net']].map(([label, value, kind]) =>
        `<div class="metric-card ${kind}"><span class="metric-label">${label}</span><strong class="metric-value">${money(value)}</strong><span class="metric-caption">${query ? 'Search results' : 'Selected filters'}${transfers ? ` · ${transfers} transfer${transfers === 1 ? '' : 's'} not counted` : ''}</span></div>`).join('');
      table.innerHTML = rows.length ? visibleRows.map((transaction, index) => {
        const debit = String(transaction.direction).toUpperCase() === 'DEBIT';
        return `<tr data-transaction="${offset + index}">
          <td>${escape(transactionDateFormat.format(transactionDate(transaction.date)))}</td>
          <td><div class="tx-desc-cell"><div class="tx-desc-text">${window.transactionHref(transaction.id) ? `<a class="transaction-link" href="${window.transactionHref(transaction.id)}">${describe(transaction, query)}</a>` : describe(transaction, query)}${transferBadge(transaction)}${transaction.account_name ? `<div class="muted" style="font-size:11px">${escape(transaction.account_name)}</div>` : ''}</div><button type="button" class="tx-rename" data-rename title="Give this payee a clearer name (applies to similar and future transactions)" aria-label="Rename ${escape(transaction.display_name || transaction.description)}">Rename</button></div></td>
          <td><select data-category aria-label="Category for ${escape(transaction.description)}">
            <option value="">Uncategorized</option>${allCategories.map(category => `<option value="${escape(category.name)}" ${category.name === transaction.category ? 'selected' : ''}>${escape(category.name)}</option>`).join('')}
          </select></td>
          <td style="text-align:center">${debit
            ? `<input data-fixed type="checkbox" aria-label="Fixed bill: ${escape(transaction.description)}" ${fixed(transaction.is_fixed) ? 'checked' : ''}>`
            : `<label class="income-toggle${transaction.income_role ? ' is-set' : ''}" title="${transaction.counts_as_income ? 'Counted as regular income and used to forecast paydays. Untick if this is not your pay.' : 'Not counted as income. Tick if this is regular pay.'}"><input data-income type="checkbox" aria-label="Counts as income: ${escape(transaction.description)}" ${transaction.counts_as_income ? 'checked' : ''}><span>Income</span></label>`}</td>
          <td>${debit ? `<select data-paymode class="paymode-select is-${payModeOf(transaction) || 'unset'}" aria-label="How ${escape(transaction.description)} is paid">
            ${['', 'auto', 'manual'].map(mode => `<option value="${mode}" ${(payModeOf(transaction) || '') === mode ? 'selected' : ''}>${payLabel(mode || null)}</option>`).join('')}
          </select>` : '<span class="paymode-na" title="Money in does not need paying">—</span>'}</td>
          <td class="${debit ? 'amount-debit' : 'amount-credit'}" style="text-align:right">${debit ? '−' : '+'}${money(Math.abs(transaction.amount))}</td>
        </tr>`;
      }).join('') : `<tr><td colspan="6" class="empty-state">${transactionId ? 'This transaction is unavailable or no longer matches these filters. Reset filters to return to all activity.' : 'No transactions match these filters.'}</td></tr>`;
      table.onclick = event => {
        const button = event.target.closest('[data-rename]');
        const row = button?.closest('[data-transaction]');
        if (row) window.openRenameDialog(rows[Number(row.dataset.transaction)]);
      };
      table.onchange = async event => {
        const row = event.target.closest('[data-transaction]');
        if (!row) return;
        const item = rows[Number(row.dataset.transaction)];
        const merchant = window.merchantKey(item.description);
        const candidates = transactions.filter(t => window.matchesTransactionSearch(t, query)
          || (merchant && window.merchantKey(t.description) === merchant));
        event.target.disabled = true;
        try {
          if (event.target.matches('[data-income]')) {
            const income = event.target.checked;
            await json('/api/transactions/update-income-role', 'POST', { ids: [Number(item.id)], income_role: income ? 'income' : 'other' });
            const similar = window.findSimilarTransactions(candidates, item, { income });
            const extra = similar.length ? await promptSimilarTransactions(item, { income }, similar, query) : 0;
            window.FinancePlan?.invalidate?.();
            notify(`${income ? 'Counted as income' : 'No longer counted as income'}: this${extra ? ` and ${extra} other deposit${extra === 1 ? '' : 's'}` : ' deposit only'}. Your payday forecast has been updated.`);
          } else if (event.target.matches('[data-fixed]')) {
            const isFixed = event.target.checked;
            await json('/api/transactions/update-fixed', 'POST', { id: item.id, is_fixed: isFixed, apply_to_all: false });
            const similar = window.findSimilarTransactions(candidates, item, { isFixed });
            const extra = similar.length ? await promptSimilarTransactions(item, { isFixed }, similar, query) : 0;
            const verb = isFixed ? 'Marked as a fixed bill' : 'No longer a fixed bill';
            notify(`${verb}: this${extra ? ` and ${extra} similar transaction${extra === 1 ? '' : 's'}` : ' transaction only'}. Upcoming bills update from your marked debits.`);
          } else if (event.target.matches('[data-paymode]')) {
            const payMode = event.target.value || null;
            await json('/api/transactions/update-pay-mode', 'POST', { ids: [Number(item.id)], pay_mode: payMode });
            const similar = window.findSimilarTransactions(candidates, item, { payMode });
            const extra = similar.length ? await promptSimilarTransactions(item, { payMode }, similar, query) : 0;
            const verb = payMode ? `Set to ${payLabel(payMode)}` : 'Payment method cleared';
            notify(`${verb} for this${extra ? ` and ${extra} similar payment${extra === 1 ? '' : 's'}` : ' payment only'}.`);
          } else {
            const category = event.target.value;
            const similar = window.findSimilarTransactions(candidates, item, category);
            const updated = await promptSimilarTransactions(item, category, similar, query);
            if (updated) notify(`Category set to ${category || 'Uncategorized'} for ${updated} transaction${updated === 1 ? '' : 's'}.`);
          }
        } catch (error) { reportError(error); }
        finally { if (FinanceSession.isAuthenticated()) await loadAllTransactions(); }
      };
    }
    finish?.();
  }
  $('txn-filter-search').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => transactionCache ? renderTransactions() : window.loadAllTransactions(), 120);
  };
  function clearTransactionFilters() {
    clearTimeout(searchTimer);
    transactionId = '';
    $('txn-filter-category').value = '';
    $('txn-filter-search').value = '';
    transactionPeriod.reset();
    $('txn-filter-fixed').checked = false;
    $('txn-filter-paymode').value = '';
  }
  window.resetTransactionFilters = () => {
    clearTransactionFilters();
    if (location.hash.startsWith('#transactions/')) history.pushState(null, '', '#transactions');
    return window.loadAllTransactions();
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
    } catch (error) {
      if (error.code === 'PRO_PLUS_REQUIRED') {
        $('insights-container').innerHTML = '<div class="coach-note"><h3>Put your goals in the bigger picture.</h3><p>This coach combines your spending, debt and savings targets, so it is included with Pro Plus ($9.98/month total). Pro spending insights are available on the Analytics page.</p><button type="button" class="btn btn-primary" id="coach-unlock">Explore Pro Plus</button></div>';
        $('coach-unlock').onclick = () => window.FinancePro?.openUpgrade('Combined debt and savings coaching requires Pro Plus.', 'pro_plus');
      } else $('insights-container').textContent = error.message;
    }
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
  window.closeAddGoalModal = function() { originalCloseGoal(); goalEditing = null; $('goal-kind').value = 'general'; $('goal-notes').value = ''; $('goal-monthly').value = ''; $('goal-day').value = ''; $('goal-included').checked = true; };
  window.openAddGoalModal = function(id = null) {
    closeAddGoalModal();
    $('goal-error').textContent = '';
    goalEditing = id;
    const goal = (window.FinancePlan?.goalRows?.() || goals).find(g => String(g.id) === String(id));
    if (goal) {
      $('goal-name').value = goal.name; $('goal-target').value = goal.target_amount; $('goal-current').value = goal.current_amount;
      $('goal-date').value = goal.target_date?.slice(0,10) || ''; $('goal-priority').value = goal.priority;
      $('goal-icon').value = goal.icon || '🎯';
      const kind = String(goal.notes || '').match(/^\[plan:(general|car|college|emergency)\]\s*/);
      $('goal-kind').value = kind?.[1] || 'general';
      $('goal-notes').value = String(goal.notes || '').replace(/^\[plan:\w+\]\s*/, '');
      $('goal-monthly').value = goal.monthly_contribution ?? '';
      $('goal-day').value = goal.contribution_day ?? '';
      $('goal-included').checked = goal.included !== false;
    }
    $('add-goal-modal').querySelector('h2').textContent = goal ? 'Edit savings goal' : 'A goal worth making room for';
    $('add-goal-modal').querySelector('button[onclick="saveGoal()"]').textContent = goal ? 'Save goal' : 'Create goal';
    $('add-goal-modal').showModal(); $('goal-name').focus();
  };
  window.saveGoal = async function() {
    $('goal-error').textContent = '';
    const target = Number($('goal-target').value), current = Number($('goal-current').value || 0);
    const monthlyText = String($('goal-monthly').value ?? '').trim(), dayText = String($('goal-day').value ?? '').trim();
    const monthly = monthlyText === '' ? null : Number(monthlyText), day = dayText === '' ? null : Number(dayText);
    if (!$('goal-name').value.trim() || target <= 0 || !Number.isFinite(target) || current < 0 || !Number.isFinite(current)) {
      $('goal-error').textContent = 'Enter a name, positive target, and nonnegative current savings.';
      return;
    }
    if (monthly != null && (!Number.isFinite(monthly) || monthly < 0)) { $('goal-error').textContent = 'Enter a monthly amount of $0 or more, or leave it blank for automatic.'; return; }
    if (day != null && (!Number.isInteger(day) || day < 1 || day > 31)) { $('goal-error').textContent = 'Choose a day of the month from 1 to 31, or leave it blank.'; return; }
    const button = $('add-goal-modal').querySelector('button[onclick="saveGoal()"]');
    button.disabled = true;
    try {
      await json(goalEditing == null ? '/api/goals' : `/api/goals/${encodeURIComponent(goalEditing)}`, goalEditing == null ? 'POST' : 'PUT', { name: $('goal-name').value.trim(), target_amount: target, current_amount: current, target_date: $('goal-date').value || null, priority: Number($('goal-priority').value) || 1, icon: $('goal-icon').value, notes: `[plan:${$('goal-kind').value}] ${$('goal-notes').value.trim()}`, monthly_contribution: monthly, contribution_day: day, included: $('goal-included').checked !== false });
      closeAddGoalModal(); await loadGoals(); notify('Goal saved.');
    } catch (error) { reportError(error); }
    finally { button.disabled = false; }
  };
  const dialog = document.createElement('dialog');
  dialog.id = 'debt-dialog'; dialog.className = 'editor';
  dialog.setAttribute('aria-label', 'Debt or loan details');
  dialog.innerHTML = `<form id="debt-form"><h2>Debt or loan details</h2><label>Name<input name="name" required maxlength="100"></label><label>Type<select name="debt_type"><option value="credit_card">Credit card</option><option value="auto_loan">Auto loan</option><option value="student_loan">Student loan</option><option value="personal_loan">Personal loan</option><option value="mortgage">Mortgage</option><option value="other">Other</option></select></label><label>Current balance ($)<input name="balance" type="number" min="0" step=".01" required></label><label>APR (%)<input name="apr" type="number" min="0" max="1000" step=".001" required></label><label>Minimum monthly payment ($)<input name="min_payment" type="number" min="0" step=".01" required></label><label style="display:flex;align-items:center;gap:10px"><input name="payment_in_history" type="checkbox" checked>Monthly payment already included in imported spending</label><p class="muted">Leave checked for existing payments already in your statements. Uncheck for a new loan: its minimum payment is reserved in your savings plan without double-counting existing loans.</p><label style="display:flex;align-items:center;gap:10px"><input name="included" type="checkbox" checked>Include in my debt-free program</label><label>Credit limit ($, optional)<input name="credit_limit" type="number" min="0" step=".01"></label><label>Due day (optional)<input name="due_date" type="number" min="1" max="31" step="1"></label><p id="debt-error" role="alert"></p><div class="toolbar"><button class="btn btn-primary">Save debt</button><button class="btn btn-secondary" type="button" id="debt-cancel">Cancel</button></div></form>`;
  document.body.appendChild(dialog);
  let debtEditing = null;
  $('debt-cancel').onclick = () => dialog.close();
  window.openDebtEditor = function(id = null) {
    debtEditing = id; $('debt-form').reset(); $('debt-error').textContent = '';
    const item = (window.FinancePlan?.debtRows?.() || debts).find(d => String(d.id) === String(id));
    if (item) for (const field of ['name','debt_type','balance','apr','min_payment','credit_limit','due_date']) $('debt-form').elements[field].value = item[field] ?? (field === 'name' ? item.card_name : '');
    $('debt-form').elements.payment_in_history.checked = item ? item.payment_in_history !== false : true; $('debt-form').elements.included.checked = item ? item.included !== false : true;
    dialog.showModal();
  };
  $('debt-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target, button = event.submitter;
    const data = Object.fromEntries(new FormData(form));
    for (const field of ['balance','apr','min_payment','credit_limit']) data[field] = data[field] === '' ? null : Number(data[field]);
    data.due_date = data.due_date || null;
    data.payment_in_history = form.elements.payment_in_history.checked; data.included = form.elements.included.checked;
    button.disabled = true;
    try {
      await json(debtEditing == null ? '/api/debts' : `/api/debts/${encodeURIComponent(debtEditing)}`, debtEditing == null ? 'POST' : 'PUT', data);
      dialog.close(); await loadPayoffPlan(); notify('Debt saved.');
    } catch (error) { $('debt-error').textContent = error.message; }
    finally { button.disabled = false; }
  };
  // Expose pure utilities for lightweight VM regression tests.
  window.FinanceTools = { escape, money, fixed };
})();
