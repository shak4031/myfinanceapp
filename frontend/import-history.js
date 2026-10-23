(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let batches = [];
  let busy = false;
  let generation = 0;
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
    $('import-history-list').innerHTML = batches.length ? batches.map(batch => `<label style="display:block; padding:8px 0; border-bottom:1px solid var(--border);">
      <input type="checkbox" data-import-id="${batch.id}"${busy ? ' disabled' : ''}>
      <strong>${escape(batch.source)}</strong> - ${escape(batch.account_name || 'Unassigned account')}
      <br><span class="import-hint">${escape(new Date(batch.created_at).toLocaleString())} |
      ${batch.status === 'undone' ? `Undone (${batch.backup_rows} backed up)` : `${batch.active_rows} active / ${batch.imported} added; ${batch.duplicates} duplicates skipped`}
      ${batch.legacy ? ' | Older inferred import: transaction-only recovery' : ''}</span>
    </label>`).join('') : '<p class="import-hint">No recoverable imports yet.</p>';
    if (untracked) $('import-history-list').innerHTML += `<p class="import-hint">${untracked} transactions have no reliable import boundary and are not included. They will not be removed by Undo.</p>`;
  }
  async function load() {
    const current = generation;
    try {
      const data = await request('');
      if (current !== generation) return false;
      batches = data.batches;
      render(data.untracked);
      return true;
    } catch (error) {
      if (current !== generation) return false;
      batches = [];
      $('import-history-list').textContent = '';
      status(`Import history could not be loaded: ${error.message}`, true);
      return false;
    }
  }
  function selectRecent() {
    if (busy) return;
    const count = Number($('import-history-count').value);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      status('Enter a number from 1 to 100.', true);
      return;
    }
    const ids = new Set(batches.filter(batch => batch.status === 'active' && (batch.active_rows > 0 || batch.statement_changed)).slice(0, count).map(batch => batch.id));
    $('import-history-list').querySelectorAll('input[data-import-id]').forEach(input => { input.checked = ids.has(Number(input.dataset.importId)); });
    status(`${ids.size} recent active imports selected. Review the filenames and accounts before undoing.`);
  }
  async function change(action) {
    if (busy) return;
    if (window.importIsBusy?.()) { status('Wait for the current import to finish.', true); return; }
    const ids = [...$('import-history-list').querySelectorAll('input[data-import-id]:checked')].map(input => Number(input.dataset.importId));
    if (!ids.length) { status('Select at least one import.', true); return; }
    const selected = batches.filter(batch => ids.includes(batch.id));
    if (selected.some(batch => batch.status !== (action === 'undo' ? 'active' : 'undone'))) {
      status(`Select only ${action === 'undo' ? 'active' : 'undone'} imports.`, true);
      return;
    }
    busy = true;
    const current = generation;
    const controls = ['import-history-undo', 'import-history-restore', 'import-history-recent', 'import-history-refresh', 'csv-import-btn', 'pdf-import-btn'];
    const previous = controls.map(id => [$(id), $(id).disabled]);
    previous.forEach(([node]) => { node.disabled = true; });
    try {
      const count = selected.reduce((sum, batch) => sum + (action === 'undo' ? batch.active_rows : batch.backup_rows), 0);
      const confirmed = await FinanceUI.confirm(`${action === 'undo' ? 'Undo' : 'Restore'} ${selected.length} imports (${count} transactions)?\n${selected.map(batch => `${batch.source} - ${batch.account_name || 'Unassigned'}`).join('\n')}\n${action === 'undo' ? 'A backup is kept so you can restore these transactions. Skipped duplicates and saved rules stay unchanged.' : 'Saved transactions and their categories will be restored. Conflicting reimports will be rejected.'}${selected.some(batch => batch.legacy) ? '\nOlder inferred imports cannot restore previous PDF account balances.' : ''}`,
        { title: action === 'undo' ? 'Undo imports' : 'Restore imports', action: action === 'undo' ? 'Undo imports' : 'Restore imports' });
      if (!confirmed) return;
      if (current !== generation) return;
      status('Updating imports...');
      const result = await request(`/${action}`, { ids });
      if (current !== generation) return;
      status(`${action === 'undo' ? 'Undone' : 'Restored'} ${result.batches} imports, ${result.affected} transactions. Refreshing totals...`);
      window.FinancePlan?.invalidate?.();
      window.FinancePro?.invalidateAnalytics?.();
      const results = await Promise.allSettled([load(), window.FinanceAccounts?.loadPage(), window.loadDashboard?.(), window.loadAllTransactions?.(), window.loadCategories?.()]);
      const failed = results.some(result => result.status === 'rejected' || result.value === false);
      status(`${action === 'undo' ? 'Undone' : 'Restored'} ${result.batches} imports, ${result.affected} transactions.${failed ? ' Some views could not refresh; reload the page before continuing.' : ' Totals refreshed.'}`, failed);
    } catch (error) {
      if (current !== generation) return;
      status(`Recovery could not be confirmed: ${error.message} Refresh history before retrying.`, true);
    } finally {
      busy = false;
      previous.forEach(([node, disabled]) => { node.disabled = disabled; });
      $('import-history-list').querySelectorAll('input[data-import-id]').forEach(input => { input.disabled = false; });
    }
  }
  $('import-history-refresh').addEventListener('click', () => { if (!busy) load(); });
  $('import-history-recent').addEventListener('click', selectRecent);
  $('import-history-undo').addEventListener('click', () => change('undo'));
  $('import-history-restore').addEventListener('click', () => change('restore'));
  $('import-history').addEventListener('toggle', () => { if ($('import-history').open && !busy) load(); });
  window.FinanceImportHistory = { load, isBusy: () => busy, reset() {
    generation++;
    batches = [];
    $('import-history-list').textContent = '';
    status('');
    $('import-history').open = false;
  } };
})();
