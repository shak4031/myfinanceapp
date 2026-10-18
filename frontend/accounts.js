/* Accounts: the account picker in the import dialog and the Accounts page (kinds, last four digits, transfers). */
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const json = async (url, method = 'GET', body) => {
    const response = await fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  };
  const toast = message => (typeof notify === 'function' ? notify(message) : console.info(message));
  const IMPORTABLE = ['checking', 'savings', 'credit_card', 'loan', 'investment', 'crypto', 'other'];
  const KIND_HELP = {
    checking: 'Everyday spending account. Its balance is your cash on hand.',
    savings: 'Money moved here counts as saved, not spent.',
    credit_card: 'Card payments from checking are transfers when this card is imported.',
    loan: 'Loan payments from checking are transfers when this loan is imported.',
    investment: 'Brokerage, IRA or 401(k). Money moved here counts as saved.',
    crypto: 'Crypto exchange. Money moved here counts as saved.',
    other: 'Another account of yours. Transfers to it are not counted.',
    external: 'Not mine (for example a family member). Transfers to it count as spending.',
    unknown: 'Not set yet. Transfers to it are left out of totals until you choose.'
  };
  let state = null;
  let kinds = [];
  const kindLabel = kind => kinds.find(item => item.value === kind)?.label || kind;
  const kindOptions = (selected, allowed = kinds.map(item => item.value)) => allowed
    .map(kind => `<option value="${kind}"${kind === selected ? ' selected' : ''}>${escape(kindLabel(kind))}</option>`).join('');
  const describe = account => `${account.name}${account.last4 && !account.name.includes(account.last4) ? ` ••${account.last4}` : ''}`;

  async function load() {
    state = await json('/api/accounts');
    kinds = state.kinds || [];
    const badge = $('accounts-nav-badge');
    if (badge) {
      badge.hidden = !state.needsReview;
      badge.textContent = String(state.needsReview || '');
      badge.title = state.needsReview ? `${state.needsReview} account${state.needsReview === 1 ? '' : 's'} to review` : '';
    }
    return state;
  }

  // ---------- Import dialog ----------
  function fillPicker(selectId) {
    const select = $('import-account-select');
    if (!select || !state) return;
    const usable = state.accounts.filter(account => IMPORTABLE.includes(account.kind));
    const current = selectId ?? select.value;
    select.innerHTML = `<option value="">Choose the account this file is from…</option>`
      + usable.map(account => `<option value="${account.id}">${escape(describe(account))} · ${escape(kindLabel(account.kind))}</option>`).join('')
      + '<option value="new">+ New account…</option>';
    if (current && [...select.options].some(option => option.value === String(current))) select.value = String(current);
    else if (!usable.length) select.value = 'new';
    syncNewFields();
  }
  function syncNewFields() {
    const select = $('import-account-select');
    const fields = $('import-new-account');
    if (!select || !fields) return;
    fields.hidden = select.value !== 'new';
    const kindSelect = $('import-new-kind');
    if (kindSelect && !kindSelect.options.length) kindSelect.innerHTML = kindOptions('checking', IMPORTABLE);
  }
  async function loadPicker() {
    try {
      await load();
      fillPicker();
    } catch (error) {
      const select = $('import-account-select');
      if (select) select.innerHTML = '<option value="new" selected>+ New account…</option>';
      syncNewFields();
    }
  }
  function choice() {
    const select = $('import-account-select');
    const error = message => { toast(message); select?.focus(); return null; };
    if (!select || !select.value) return error('Choose which account this file is from.');
    if (select.value !== 'new') return { accountId: Number(select.value) };
    const name = $('import-new-name').value.trim();
    const kind = $('import-new-kind').value;
    const last4 = $('import-new-last4').value.trim();
    const institution = $('import-new-institution').value.trim();
    if (!name) { $('import-new-name').focus(); return error('Give the new account a name, for example "Chase checking".'); }
    if (last4 && !/^\d{4}$/.test(last4)) { $('import-new-last4').focus(); return error('Last four digits must be exactly 4 numbers.'); }
    return { newAccount: { name, kind, last4: last4 || null, institution: institution || null } };
  }
  // Pre-select the account from the file name (e.g. Chase1180_Activity.csv) or the OFX/QFX account number.
  async function suggestFromFile(file) {
    if (!file) return;
    if (!state) await loadPicker();
    const select = $('import-account-select');
    if (!select || !state) return;
    const candidates = [...String(file.name).matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map(match => match[1]);
    let ofxLast4 = null;
    if (/\.(ofx|qfx|qbo)$/i.test(file.name) && typeof file.text === 'function') {
      try { ofxLast4 = (await file.text()).match(/<ACCTID>\s*[^<\s]*?(\d{4})\s*(?:<|$)/im)?.[1] || null; } catch { /* unreadable */ }
      if (ofxLast4) candidates.unshift(ofxLast4);
    }
    const match = candidates.map(last4 => state.accounts.find(account => account.last4 === last4 && IMPORTABLE.includes(account.kind))).find(Boolean);
    if (match) { select.value = String(match.id); syncNewFields(); return; }
    if (ofxLast4 && !select.value) {
      select.value = 'new';
      syncNewFields();
      if (!$('import-new-last4').value) $('import-new-last4').value = ofxLast4;
    }
  }
  function resultNote(data) {
    const parts = [];
    if (data.account) parts.push(`Saved to <strong>${escape(describe(data.account))}</strong>.`);
    if (data.accountsDiscovered) parts.push(`Found ${data.accountsDiscovered} other account${data.accountsDiscovered === 1 ? '' : 's'} in your transfers. <a href="#accounts" data-view="accounts">Tell us what ${data.accountsDiscovered === 1 ? 'it is' : 'they are'}</a> so transfers stay out of your totals.`);
    return parts.length ? `<div style="font-size: 12px; margin-top: 6px; color: var(--text-secondary);">${parts.join(' ')}</div>` : '';
  }
  async function afterImport(data) {
    await load().catch(() => null);
    fillPicker(data?.account?.id);
    ['import-new-name', 'import-new-last4', 'import-new-institution'].forEach(id => { if ($(id)) $(id).value = ''; });
    if (document.querySelector('#accounts-view.active')) render();
  }

  // ---------- Accounts page ----------
  function accountRow(account) {
    const review = account.status === 'needs_review';
    const range = account.firstDate ? `${account.firstDate} → ${account.lastDate}` : 'No statements imported';
    return `<article class="acct-card${review ? ' acct-review' : ''}" data-account="${account.id}">
      <div class="acct-head">
        <div>
          <h3>${escape(account.name)}${review ? ' <span class="acct-badge warn">Needs review</span>' : ''}</h3>
          <p class="muted">${escape(kindLabel(account.kind))}${account.institution ? ` · ${escape(account.institution)}` : ''}${account.last4 ? ` · ••${escape(account.last4)}` : ''}</p>
        </div>
        ${account.balance != null && account.transactions ? `<div class="acct-balance"><strong>${money(account.balance)}</strong><span class="muted">as of ${escape(account.balanceAsOf || '')}</span></div>` : ''}
      </div>
      ${review ? `<p class="acct-found">We saw this account number in ${account.transfersTo} transfer${account.transfersTo === 1 ? '' : 's'}${account.unknownTotal ? ` totaling ${money(account.unknownTotal)}` : ''}${account.discovered_from ? `, e.g. “${escape(account.discovered_from)}”` : ''}. Those transfers are left out of your totals until you choose what this account is.${account.suggested_kind ? ` It looks like <strong>${escape(kindLabel(account.suggested_kind))}</strong>.` : ''}</p>` : ''}
      <p class="muted acct-stats">${account.transactions} transaction${account.transactions === 1 ? '' : 's'} · ${escape(range)}${account.transfersTo && !review ? ` · ${account.transfersTo} transfer${account.transfersTo === 1 ? '' : 's'} in from other accounts` : ''}</p>
      <div class="acct-form">
        <label>Name<input name="name" maxlength="80" value="${escape(account.name)}"></label>
        <label>Type<select name="kind">${kindOptions(review && account.kind === 'unknown' && account.suggested_kind ? account.suggested_kind : account.kind)}</select></label>
        <label>Last 4<input name="last4" inputmode="numeric" maxlength="4" pattern="\\d{4}" value="${escape(account.last4 || '')}"></label>
        <label>Bank<input name="institution" maxlength="80" value="${escape(account.institution || '')}"></label>
      </div>
      <p class="muted acct-kind-help">${escape(KIND_HELP[review && account.suggested_kind ? account.suggested_kind : account.kind] || '')}</p>
      <div class="acct-actions">
        <button class="btn btn-primary" data-act="save">${review ? 'Confirm' : 'Save'}</button>
        ${review ? '<button class="btn" data-act="external">Not my account</button>' : ''}
        ${account.transactions ? '' : '<button class="btn btn-ghost" data-act="delete">Delete</button>'}
      </div>
    </article>`;
  }
  function render() {
    const root = $('accounts-root');
    if (!root || !state) return;
    const review = state.accounts.filter(account => account.status === 'needs_review');
    const others = state.accounts.filter(account => account.status !== 'needs_review');
    const assignable = state.accounts.filter(account => IMPORTABLE.includes(account.kind));
    const unknown = state.unknownTransfers || { count: 0, total: 0, recent: [] };
    root.innerHTML = `
      <div class="acct-summary">
        <div class="panel"><p class="eyebrow">SAVED THIS MONTH</p><strong>${money(state.savedThisMonth?.amount)}</strong><p class="muted">Moved to savings or investments. Not counted as spending.</p></div>
        <div class="panel"><p class="eyebrow">TRANSFERS NOT COUNTED YET</p><strong>${unknown.count}</strong><p class="muted">${unknown.count ? `${money(unknown.total)} waiting for you to say which account it went to.` : 'Every transfer is matched to an account.'}</p></div>
        <div class="panel"><p class="eyebrow">ACCOUNTS</p><strong>${state.accounts.filter(account => account.kind !== 'external').length}</strong><p class="muted">${review.length ? `${review.length} need${review.length === 1 ? 's' : ''} your review.` : 'All reviewed.'}</p></div>
      </div>
      ${review.length ? `<h2 class="acct-section">Found in your transfers</h2><div class="acct-list">${review.map(accountRow).join('')}</div>` : ''}
      <h2 class="acct-section">Your accounts</h2>
      <div class="acct-list">${others.length ? others.map(accountRow).join('') : '<p class="muted">No accounts yet. Import a statement and choose “New account”, or add one below.</p>'}</div>
      ${state.unassigned?.length ? `<h2 class="acct-section">Imports without an account</h2>
        <p class="muted">These were imported before accounts existed. Assign each file to its account so transfers between your accounts can be matched.</p>
        <div class="acct-list">${state.unassigned.map(group => `<article class="acct-card" data-source="${escape(group.source)}">
          <div class="acct-head"><div><h3>${escape(group.source)}</h3><p class="muted">${group.transactions} transaction${group.transactions === 1 ? '' : 's'}${group.firstDate ? ` · ${escape(group.firstDate)} → ${escape(group.lastDate)}` : ''}</p></div></div>
          <div class="acct-actions"><select data-assign>${'<option value="">Choose account…</option>' + assignable.map(account => `<option value="${account.id}">${escape(describe(account))}</option>`).join('')}</select>
          <button class="btn btn-primary" data-act="assign">Assign</button></div></article>`).join('')}</div>` : ''}
      ${unknown.recent?.length ? `<h2 class="acct-section">Transfers waiting for an account</h2>
        <p class="muted">These look like transfers but we can't tell where the money went. Set the account type above, or change a row's category on the Transactions page (Transfer, Savings, or a spending category).</p>
        <div class="table-container"><table class="acct-table"><thead><tr><th>Date</th><th>Description</th><th>From</th><th style="text-align:right">Amount</th></tr></thead><tbody>
        ${unknown.recent.map(row => `<tr><td>${escape(row.date || '')}</td><td>${escape(row.description)}</td><td>${escape(row.account || 'Not set')}</td><td style="text-align:right">${row.direction === 'CREDIT' ? '+' : '−'}${money(Math.abs(row.amount))}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      <h2 class="acct-section">Add an account</h2>
      <form class="acct-card" id="acct-add-form">
        <div class="acct-form">
          <label>Name<input name="name" maxlength="80" required placeholder="e.g. Ally savings"></label>
          <label>Type<select name="kind">${kindOptions('savings', [...IMPORTABLE, 'external'])}</select></label>
          <label>Last 4<input name="last4" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="4821"></label>
          <label>Bank<input name="institution" maxlength="80" placeholder="Ally"></label>
        </div>
        <div class="acct-actions"><button class="btn btn-primary" type="submit">Add account</button></div>
      </form>
      <details class="panel acct-rules"><summary>How transfers are counted</summary>
        <ul>
          <li><strong>Between your own checking accounts:</strong> shown for information only. Never counted as spending or income.</li>
          <li><strong>To savings, investment or crypto:</strong> counted as <em>Saved</em>, not spending. Moving it back is shown as a withdrawal from savings.</li>
          <li><strong>Credit card and loan payments:</strong> a transfer when that card's or loan's statement is also imported (the purchases are counted there). Otherwise the payment counts as a bill.</li>
          <li><strong>Zelle, Venmo, PayPal, Cash App:</strong> paying a person counts as spending; money from a person is other income, not pay.</li>
          <li><strong>Account we don't recognise:</strong> added here as “Needs review”. Its transfers are left out of totals until you choose.</li>
          <li><strong>Not my account:</strong> transfers to it count as spending (or income when money comes in).</li>
        </ul>
      </details>`;
  }
  async function refreshAll(message) {
    await load();
    render();
    if (message) toast(message);
    window.FinancePlan?.invalidate?.();
  }
  async function loadPage() {
    const root = $('accounts-root');
    if (root && !state) root.innerHTML = '<p class="muted">Loading accounts…</p>';
    await load();
    render();
  }
  const formValues = container => Object.fromEntries([...container.querySelectorAll('input[name], select[name]')].map(field => [field.name, field.value.trim()]));

  document.addEventListener('click', async event => {
    const button = event.target.closest?.('#accounts-root button[data-act]');
    if (!button) return;
    event.preventDefault();
    const card = button.closest('.acct-card');
    button.disabled = true;
    try {
      if (button.dataset.act === 'save') {
        const values = formValues(card.querySelector('.acct-form'));
        await json(`/api/accounts/${card.dataset.account}`, 'PATCH', { ...values, last4: values.last4 || null, institution: values.institution || null });
        await refreshAll('Account saved. Transfers were re-checked.');
      } else if (button.dataset.act === 'external') {
        await json(`/api/accounts/${card.dataset.account}`, 'PATCH', { kind: 'external' });
        await refreshAll('Marked as not your account. Transfers to it now count.');
      } else if (button.dataset.act === 'delete') {
        const ok = window.FinanceUI ? await FinanceUI.confirm('Delete this account? Transfers that pointed to it will be re-checked.') : true;
        if (!ok) return;
        await json(`/api/accounts/${card.dataset.account}`, 'DELETE');
        await refreshAll('Account deleted.');
      } else if (button.dataset.act === 'assign') {
        const accountId = card.querySelector('select[data-assign]').value;
        if (!accountId) { toast('Choose an account first.'); return; }
        const result = await json('/api/accounts/assign', 'POST', { source: card.dataset.source, accountId: Number(accountId) });
        await refreshAll(`${result.assigned ?? 'The'} transaction${result.assigned === 1 ? '' : 's'} assigned. Transfers were re-checked.`);
      }
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'import-account-select') { syncNewFields(); return; }
    const select = event.target.closest?.('#accounts-root .acct-form select[name="kind"]');
    const help = select?.closest('.acct-card')?.querySelector('.acct-kind-help');
    if (help) help.textContent = KIND_HELP[select.value] || '';
  });
  document.addEventListener('submit', async event => {
    if (event.target.id !== 'acct-add-form') return;
    event.preventDefault();
    const values = formValues(event.target);
    try {
      await json('/api/accounts', 'POST', { ...values, last4: values.last4 || null, institution: values.institution || null });
      await refreshAll('Account added. Transfers were re-checked.');
    } catch (error) { toast(error.message); }
  });

  const openImport = window.openImportModal;
  if (typeof openImport === 'function') {
    window.openImportModal = (...args) => {
      const result = openImport(...args);
      loadPicker();
      return result;
    };
  }
  // The PDF reader needs the statement layout; the chosen account's type decides it.
  function pdfStatementType(selected) {
    const kind = selected?.newAccount?.kind || state?.accounts.find(account => account.id === selected?.accountId)?.kind;
    return kind === 'credit_card' || kind === 'loan' ? 'credit-card' : kind === 'savings' ? 'td-savings' : 'td-checking';
  }
  window.FinanceAccounts = { load, loadPage, loadPicker, choice, suggestFromFile, resultNote, afterImport, pdfStatementType, reset: () => { state = null; } };
})();
