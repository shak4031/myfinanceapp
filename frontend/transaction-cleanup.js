(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let selected = new Set(), rows = [], filter = null, offset = 0, total = 0, busy = false, generation = 0;
  const controls = ['cleanup-page-select', 'cleanup-all-select', 'cleanup-clear', 'cleanup-delete', 'cleanup-prev', 'cleanup-next'];
  function status(message, error = false) {
    $('cleanup-status').textContent = message;
    $('cleanup-status').setAttribute('role', error ? 'alert' : 'status');
  }
  function update() {
    $('cleanup-filters').querySelectorAll('input,select,button').forEach(node => { node.disabled = busy; });
    $('cleanup-rows').querySelectorAll('input').forEach(node => {
      node.disabled = busy;
      node.checked = selected.has(Number(node.dataset.cleanupId));
    });
    $('cleanup-page-select').disabled = busy || !rows.length;
    $('cleanup-all-select').disabled = busy || !total;
    $('cleanup-clear').disabled = busy || !selected.size;
    $('cleanup-delete').disabled = busy || !selected.size;
    $('cleanup-delete').textContent = `Delete selected (${selected.size})`;
    $('cleanup-prev').disabled = busy || !filter || offset === 0;
    $('cleanup-next').disabled = busy || !filter || offset + 50 >= total;
  }
  async function request(url, body) {
    const response = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }
  function query(extra = {}) { return `/api/transactions/cleanup?${new URLSearchParams({ ...filter, ...extra })}`; }
  function selectionStatus() {
    status(`${total ? offset + 1 : 0}-${Math.min(offset + rows.length, total)} of ${total} matches. ${selected.size} selected across pages.`);
    update();
  }
  function render() {
    $('cleanup-rows').innerHTML = rows.map(row => `<tr>
      <td><input type="checkbox" data-cleanup-id="${row.id}" aria-label="Select transaction ${row.id}"></td>
      <td>${escape(row.date)}</td><td>${escape(row.created_at ? new Date(row.created_at).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Unavailable')}</td>
      <td>${escape(row.description)} <small>#${row.id}</small></td><td>${escape(row.source || 'Unknown')}</td>
      <td>${escape(row.direction)} ${escape(Number(row.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' }))}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="cleanup-empty"><strong>No matching transactions</strong><small>Try a different date range, source, or description.</small></td></tr>';
    selectionStatus();
  }
  async function load(pageOffset = 0) {
    if (busy || !filter) return;
    busy = true; update();
    const current = generation;
    try {
      const data = await request(query({ offset: pageOffset }));
      if (current !== generation) return;
      rows = data.rows; total = data.total; offset = data.offset;
      render();
    } catch (error) {
      if (current === generation) {
        rows = []; total = 0; $('cleanup-rows').innerHTML = '';
        status(`Could not load cleanup transactions: ${error.message}`, true);
      }
    } finally { if (current === generation) { busy = false; update(); } }
  }
  $('cleanup-filters').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    selected.clear();
    filter = { dateType: $('cleanup-date-type').value, start: $('cleanup-start').value, end: $('cleanup-end').value,
      source: $('cleanup-source').value, search: $('cleanup-search').value };
    load();
  });
  $('cleanup-filters').addEventListener('change', () => {
    if (busy) return;
    filter = null; rows = []; total = 0; selected.clear(); $('cleanup-rows').innerHTML = '';
    status('Filters changed. Find transactions again before selecting.'); update();
  });
  $('cleanup-rows').addEventListener('change', event => {
    const id = Number(event.target.dataset.cleanupId);
    if (busy || !rows.some(row => row.id === id)) return;
    if (event.target.checked) selected.add(id); else selected.delete(id);
    selectionStatus();
  });
  $('cleanup-page-select').addEventListener('click', () => {
    if (busy) return;
    rows.forEach(row => selected.add(row.id)); selectionStatus();
  });
  $('cleanup-clear').addEventListener('click', () => { if (!busy) { selected.clear(); selectionStatus(); } });
  $('cleanup-prev').addEventListener('click', () => load(Math.max(0, offset - 50)));
  $('cleanup-next').addEventListener('click', () => load(offset + 50));
  $('cleanup-all-select').addEventListener('click', async () => {
    if (busy || !filter) return;
    busy = true; update();
    const current = generation;
    try {
      const data = await request(query({ selection: 'all' }));
      if (current !== generation) return;
      selected = new Set(data.ids); selectionStatus();
      status(`${selected.size} matching transactions selected across all pages (maximum 10,000).`);
    } catch (error) { if (current === generation) status(`Could not select all: ${error.message}`, true); }
    finally { if (current === generation) { busy = false; update(); } }
  });
  $('cleanup-delete').addEventListener('click', async () => {
    if (busy || !selected.size) return;
    if (window.importIsBusy?.()) { status('Wait for the current import or recovery to finish.', true); return; }
    busy = true; update();
    const current = generation, ids = [...selected];
    try {
      const accepted = await window.FinanceUI.confirm(`Permanently delete ${ids.length} selected transactions? There is no Undo or Restore. Plaid rows may return on a later sync or reconnection. No bank or saved balance is changed.`,
        { title: 'Delete selected transactions', action: `Delete ${ids.length} transactions` });
      if (current !== generation || !accepted) return;
      const result = await request('/api/transactions/cleanup/delete', { ids, acknowledged: true });
      if (current !== generation) return;
      selected.clear(); rows = []; total = 0; offset = 0; $('cleanup-rows').innerHTML = '';
      window.FinancePlan?.invalidate?.();
      window.FinancePro?.invalidateAnalytics?.();
      window.FinanceReviewTools?.invalidateImports();
      const refreshed = await Promise.allSettled([
        window.loadDashboard?.(), window.loadAllTransactions?.(), window.loadCategories?.(),
        window.FinanceAccounts?.loadPage(), window.FinanceImportHistory?.load(), window.loadTransactionImportReviews?.()
      ]);
      if (current !== generation) return;
      const failed = refreshed.some(item => item.status === 'rejected' || item.value === false);
      status(`Deleted ${result.deleted} transactions. Find transactions again to review remaining rows.${failed ? ' Some views could not refresh; reload the page.' : ' Totals refreshed.'}`, failed);
    } catch (error) {
      if (current === generation) {
        selected.clear(); filter = null; rows = []; total = 0; $('cleanup-rows').innerHTML = '';
        status(`Deletion could not be confirmed: ${error.message} Find transactions again before retrying.`, true);
      }
    } finally { if (current === generation) { busy = false; update(); } }
  });
  window.FinanceTransactionCleanup = { reset() {
    generation++; selected.clear(); rows = []; filter = null; offset = 0; total = 0; busy = false;
    $('cleanup-filters').reset(); $('cleanup-rows').innerHTML = '';
    status('Choose dates and find transactions to begin.'); update();
  } };
  controls.forEach(id => { $(id).disabled = true; });
})();
