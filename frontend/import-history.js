(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let batches = [];
  let busy = false;
  let generation = 0;
  let mode = 'undo', review = null, untracked = 0, loadSequence = 0;
  let loading = false;
  const selectedIds = () => [...$('import-history-list').querySelectorAll('input[data-import-id]:checked')].map(input => Number(input.dataset.importId));
  function clearReview() {
    review = null;
    $('import-history-review').hidden = true;
    $('import-history-impact').textContent = '';
    $('import-history-ack').checked = false;
    $('import-history-commit').disabled = true;
  }
  function updateSelection() {
    const ids = selectedIds();
    const count = batches.filter(batch => ids.includes(batch.id)).reduce((sum, batch) => sum + (mode === 'undo' ? batch.active_rows : batch.backup_rows), 0);
    $('import-history-selection').textContent = ids.length ? `${ids.length} imports selected; ${count} transactions. No changes made yet.` : 'No imports selected.';
    $('import-history-undo').disabled = busy || loading || mode !== 'undo' || !ids.length || !!review;
    $('import-history-restore').disabled = busy || loading || mode !== 'restore' || !ids.length || !!review;
  }
  function controls() {
    for (const id of ['import-history-active', 'import-history-backups', 'import-history-recent', 'import-history-refresh']) $(id).disabled = busy || loading;
    $('import-history-list').querySelectorAll('input[data-import-id]').forEach(input => { input.disabled = busy || loading || !!review; });
    $('import-history-commit').disabled = busy || !review || !$('import-history-ack').checked;
    $('import-history-cancel').disabled = busy;
    updateSelection();
  }
  const status = (message, error = false) => {
    $('import-history-status').textContent = message;
    $('import-history-status').setAttribute('role', error ? 'alert' : 'status');
  };
  async function request(path, body) {
    const response = await fetch(`/api/import/history${path}`, {
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  function render(untracked) {
    const visible = batches.filter(batch => batch.status === (mode === 'undo' ? 'active' : 'undone'));
    $('import-history-list').innerHTML = visible.length ? visible.map(batch => {
      const eligible = mode === 'undo' ? batch.active_rows > 0 || batch.statement_changed : batch.backup_rows > 0 || batch.statement_changed;
      return `<div class="import-history-entry"><label>
      ${eligible ? `<input type="checkbox" data-import-id="${batch.id}"${busy ? ' disabled' : ''}>` : '<span class="import-hint">No changes available - </span>'}
      <strong>${escape(batch.source)}</strong> - ${escape(batch.account_name || 'Unassigned account')}
      <br><span class="import-hint">${escape(new Date(batch.created_at).toLocaleString())} |
      ${batch.status === 'undone' ? `Undone (${batch.backup_rows} backed up)` : `${batch.active_rows} active / ${batch.imported} added; ${batch.duplicates} duplicates skipped`}
      ${batch.legacy ? ' | Older inferred import: transaction-only recovery' : ''}</span>
      </label>${batch.status === 'undone' ? `<p class="import-hint">Not available for Undo. ${batch.undone_at ? `Undone ${escape(new Date(batch.undone_at).toLocaleString())}. ` : ''}Select here only to review Restore.</p>` : ''}</div>`;
    }).join('') : `<p class="import-hint">${mode === 'undo' ? 'No active imports. Previously undone imports are under Undone / Restore backups.' : 'No undone imports or restore backups.'}</p>`;
    if (untracked) $('import-history-list').innerHTML += `<p class="import-hint">${untracked} transactions have no reliable import boundary and are not included. They will not be removed by Undo.</p>`;
    $('import-history-active').setAttribute('aria-pressed', String(mode === 'undo'));
    $('import-history-backups').setAttribute('aria-pressed', String(mode === 'restore'));
    $('import-history-recent-controls').hidden = mode !== 'undo';
    $('import-history-undo').hidden = mode !== 'undo';
    $('import-history-restore').hidden = mode !== 'restore';
    controls();
  }
  async function load() {
    const current = generation;
    const sequence = ++loadSequence;
    clearReview();
    loading = true;
    controls();
    try {
      const data = await request('');
      if (current !== generation || sequence !== loadSequence) return false;
      batches = data.batches;
      untracked = data.untracked;
      render(untracked);
      return true;
    } catch (error) {
      if (current !== generation || sequence !== loadSequence) return false;
      batches = [];
      $('import-history-list').textContent = '';
      controls();
      status(`Import history could not be loaded: ${error.message}`, true);
      return false;
    } finally { if (current === generation && sequence === loadSequence) { loading = false; controls(); } }
  }
  function selectRecent() {
    if (busy || loading) return;
    const count = Number($('import-history-count').value);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      status('Enter a number from 1 to 100.', true);
      return;
    }
    const ids = new Set(batches.filter(batch => batch.status === 'active' && (batch.active_rows > 0 || batch.statement_changed)).slice(0, count).map(batch => batch.id));
    $('import-history-list').querySelectorAll('input[data-import-id]').forEach(input => { input.checked = ids.has(Number(input.dataset.importId)); });
    clearReview();
    controls();
    status(`${ids.size} recent active imports selected. Review the filenames and accounts before undoing.`);
  }
  async function change(action) {
    if (busy || loading) return;
    if (window.importIsBusy?.()) { status('Wait for the current import to finish.', true); return; }
    const ids = selectedIds();
    if (!ids.length) { status('Select at least one import.', true); return; }
    const selected = batches.filter(batch => ids.includes(batch.id));
    if (selected.some(batch => batch.status !== (action === 'undo' ? 'active' : 'undone'))) {
      status(`Select only ${action === 'undo' ? 'active' : 'undone'} imports.`, true);
      return;
    }
    busy = true;
    const current = generation;
    const sequence = loadSequence;
    controls();
    try {
      clearReview();
      status('Validating the selection and checking for conflicts. No changes are being committed.');
      const started = Date.now();
      const data = await request('/review', { ids, action });
      if (current !== generation || sequence !== loadSequence) return;
      review = { ...data, ids, localExpiresAt: Number.isFinite(data.validForMs) ? started + data.validForMs : Date.parse(data.expiresAt) };
      $('import-history-impact').innerHTML = `<p><strong>${action === 'undo' ? 'Remove' : 'Restore'} ${data.affected} transactions across ${data.batches.length} imports.</strong></p>
        <ul>${data.batches.map(batch => `<li>${escape(batch.source)} - ${escape(batch.account_name || 'Unassigned')}: ${action === 'undo' ? batch.active_rows : batch.backup_rows} transactions${batch.statement_changed ? '; verified statement balance/rates/dates will change' : ''}</li>`).join('')}</ul>
        <p>${data.remainingTransactions} active transactions will remain. Spending, income, balances and transfer pairing will be recalculated.</p>
        <p>${action === 'undo' ? 'A backup will be retained. These imports will leave Active imports and appear only under Undone / Restore backups. Skipped duplicates are not removed.' : 'Backed-up rows, original IDs and saved edits will return. These imports will leave Restore backups and return to Active imports.'}</p>
        <p>Accounts, saved rules and debt plans are not deleted. Other transactions are not removed or restored; automatic transfer classification may change.</p>
        ${data.batches.some(batch => batch.legacy) ? '<p><strong>Older inferred import: transaction-only recovery. Previous PDF statement balances cannot be recovered.</strong></p>' : ''}
        <p>Undo is reversible while its backup is retained. Restore may be blocked by replacement imports or deleted references. This is not a full account rollback.</p>
        <p class="import-hint">Validated review expires ${escape(new Date(review.localExpiresAt).toLocaleTimeString())}. Any intervening data changes require a new review.</p>`;
      $('import-history-review').hidden = false;
      $('import-history-commit').textContent = action === 'undo' ? 'Confirm undo' : 'Confirm restore';
      status('Validation passed. Read the impact and check the acknowledgement before confirming. Nothing has changed yet.');
      $('import-history-review').scrollIntoView({ block: 'nearest' });
    } catch (error) {
      if (current === generation) { clearReview(); status(`Validation failed: ${error.message} Nothing was changed.`, true); }
    } finally { busy = false; controls(); }
  }
  async function commit() {
    if (busy || !review || !$('import-history-ack').checked) return;
    if (window.importIsBusy?.()) { status('Wait for the current import to finish.', true); return; }
    const current = generation, pending = review, action = pending.action;
    if (pending.localExpiresAt <= Date.now()) { clearReview(); controls(); status('Review expired. Review the selection again.', true); return; }
    busy = true;
    controls();
    try {
      status('Committing the confirmed recovery...');
      const result = await request(`/${action}`, { ids: pending.ids, reviewToken: pending.reviewToken, acknowledged: true });
      if (current !== generation) return;
      clearReview();
      batches = batches.map(batch => pending.ids.includes(batch.id) ? { ...batch, status: action === 'undo' ? 'undone' : 'active' } : batch);
      render(untracked);
      status(`${action === 'undo' ? 'Undone' : 'Restored'} ${result.batches} imports, ${result.affected} transactions. Refreshing totals...`);
      window.FinancePlan?.invalidate?.();
      window.FinancePro?.invalidateAnalytics?.();
      const results = await Promise.allSettled([load(), window.FinanceAccounts?.loadPage(), window.loadDashboard?.(), window.loadAllTransactions?.(), window.loadCategories?.()]);
      if (current !== generation) return;
      const failed = results.some(result => result.status === 'rejected' || result.value === false);
      status(`${action === 'undo' ? 'Undone' : 'Restored'} ${result.batches} imports, ${result.affected} transactions.${failed ? ' Some views could not refresh; reload the page before continuing.' : ' Totals refreshed.'}`, failed);
    } catch (error) {
      if (current !== generation) return;
      clearReview();
      batches = [];
      $('import-history-list').textContent = '';
      status(`Recovery could not be confirmed: ${error.message} Refresh history before retrying.`, true);
    } finally {
      busy = false;
      controls();
    }
  }
  $('import-history-refresh').addEventListener('click', () => { if (!busy) load(); });
  $('import-history-recent').addEventListener('click', selectRecent);
  $('import-history-undo').addEventListener('click', () => change('undo'));
  $('import-history-restore').addEventListener('click', () => change('restore'));
  $('import-history-commit').addEventListener('click', commit);
  $('import-history-ack').addEventListener('change', controls);
  $('import-history-cancel').addEventListener('click', () => { if (!busy) { clearReview(); controls(); status('Review cancelled. Nothing was changed.'); } });
  $('import-history-list').addEventListener('change', () => { if (!busy) { clearReview(); controls(); } });
  for (const [id, next] of [['import-history-active', 'undo'], ['import-history-backups', 'restore']]) {
    $(id).addEventListener('click', () => { if (!busy) { mode = next; clearReview(); render(untracked); status(''); } });
  }
  $('import-history').addEventListener('toggle', () => { if ($('import-history').open && !busy) load(); });
  window.FinanceImportHistory = { load, isBusy: () => busy, reset() {
    generation++;
    loadSequence++;
    loading = false;
    mode = 'undo';
    batches = [];
    clearReview();
    $('import-history-list').textContent = '';
    status('');
    $('import-history').open = false;
    controls();
  } };
})();
