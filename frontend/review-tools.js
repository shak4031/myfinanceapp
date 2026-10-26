/* Transaction treatment review and personal activity history. */
(() => {
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const PAGE_SIZE = 50;
  let transferOffset = 0;
  let auditOffset = 0;
  let transferRequest = 0;
  let activityRequest = 0;
  let generation = 0;
  let importsLoaded = false;
  let importsRequest;
  let nextImportBefore = null;
  const imports = new Map();

  async function json(url, method = 'GET', body) {
    const response = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  function handlingLabel(kind) {
    if (kind === 'internal') return 'Internal transfer · excluded';
    if (kind === 'savings') return 'Savings · not spending/income';
    if (kind === 'unknown') return 'Needs review · excluded';
    return 'Counted in totals';
  }

  function rowMarkup(row, categories) {
    const current = row.transfer_kind || 'counted';
    const allowed = categories.filter(name => !/^(?:transfers?|internal transfers?|savings|savings transfer)$/i.test(name));
    const currentCategory = allowed.includes(row.category) ? row.category : allowed.includes('Other') ? 'Other' : allowed[0];
    const categoryOptions = allowed.map(name => `<option value="${escape(name)}"${name === currentCategory ? ' selected' : ''}>${escape(name)}</option>`).join('');
    const actionOptions = [
      ...(current === 'unknown' ? ['<option value="unknown" selected disabled>Needs review — excluded</option>'] : []),
      ...[['counted', 'Count normally'], ['internal', 'Internal transfer'], ['savings', 'Savings transfer']]
        .map(([value, label]) => `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`)
    ].join('');
    const amount = `${String(row.direction).toUpperCase() === 'CREDIT' ? '+' : '−'}${money(Math.abs(Number(row.amount) || 0))}`;
    const source = [row.account_name || 'Account not set', row.source].filter(Boolean).join(' · ');
    const otherAccount = row.transfer_account_name ? ` · ${row.transfer_account_name}` : '';
    return `<tr data-review-row="${Number(row.id)}" data-current-handling="${escape(current)}" data-current-category="${escape(row.category || '')}">
      <td>${escape(row.date || '')}</td>
      <td><strong>${escape(row.description || 'Transaction')}</strong><small>#${Number(row.id)}</small></td>
      <td>${escape(source)}</td>
      <td>${escape(row.category || 'Uncategorized')}</td>
      <td><span class="handling-status handling-${escape(current)}">${escape(handlingLabel(row.transfer_kind))}${escape(otherAccount)}</span></td>
      <td class="review-amount">${escape(amount)}</td>
      <td><div class="review-decision">
        <select data-review-handling aria-label="Correct handling for transaction ${Number(row.id)}">${actionOptions}</select>
        <select data-review-category aria-label="Category if counted" ${current === 'counted' ? '' : 'hidden'}>${categoryOptions}</select>
        <button type="button" class="btn btn-secondary btn-compact" data-review-save>Save</button>
      </div></td>
    </tr>`;
  }

  function updateSaveState(row) {
    const handling = row.querySelector('[data-review-handling]');
    const category = row.querySelector('[data-review-category]');
    const save = row.querySelector('[data-review-save]');
    category.hidden = handling.value !== 'counted';
    const same = handling.value === row.dataset.currentHandling
      && (handling.value !== 'counted' || category.value === row.dataset.currentCategory);
    save.disabled = same || handling.value === 'unknown';
  }

  async function loadImports(append = false) {
    if (importsRequest) return importsRequest;
    const requestGeneration = generation;
    const more = $('transfer-review-import-more');
    more.disabled = true;
    const pending = (async () => {
      const data = await json(`/api/transactions/transfer-review/imports${append ? `?before=${nextImportBefore}` : ''}`);
      if (requestGeneration !== generation) return;
      if (!Array.isArray(data.batches) || (data.nextBefore !== null && !Number.isSafeInteger(data.nextBefore))) {
        throw new Error('The server returned an invalid import list. Reload the page and retry.');
      }
      for (const batch of data.batches) imports.set(String(batch.id), batch);
      const select = $('transfer-review-import');
      const selected = select.value;
      select.innerHTML = '<option value="">Choose an import</option>'
        + [...imports.values()].sort((a, b) => b.id - a.id).map(batch => {
          const date = new Date(batch.created_at).toLocaleDateString();
          const label = `${batch.source || 'Statement'} · ${batch.account_name || 'Account not set'} · ${date}${batch.status === 'undone' ? ' · Undone' : ''}`;
          return `<option value="${batch.id}">${escape(label)}</option>`;
        }).join('')
        + '<option value="untracked">Older transactions without an import</option>';
      select.value = selected;
      nextImportBefore = data.nextBefore;
      more.hidden = nextImportBefore === null;
      importsLoaded = true;
    })();
    importsRequest = pending;
    try { await pending; }
    finally {
      if (importsRequest === pending) importsRequest = null;
      if (requestGeneration === generation) more.disabled = false;
    }
  }

  async function loadTransfers({ refreshImports = false } = {}) {
    const rows = $('transfer-review-rows');
    if (!rows) return;
    const request = ++transferRequest;
    $('transfer-review-error').textContent = '';
    $('transfer-review-pagination').innerHTML = '';
    $('transfer-review-count').textContent = '';
    rows.innerHTML = '<tr><td colspan="7">Loading import choices...</td></tr>';
    rows.setAttribute('aria-busy', 'true');
    try {
      if (!importsLoaded || refreshImports) await loadImports();
      if (request !== transferRequest) return;
      const importId = $('transfer-review-import').value;
      const status = $('transfer-review-filter').value;
      const batch = imports.get(importId);
      $('transfer-review-import-summary').textContent = batch
        ? `${batch.source} · ${batch.account_name || 'Account not set'} · ${Number(batch.imported).toLocaleString()} rows originally imported · ${Number(batch.duplicates).toLocaleString()} duplicates skipped${batch.status === 'undone' ? ' · This import was undone; its transactions are not active.' : ''}${batch.legacy ? ' · Older inferred import; original processing details may be unavailable.' : ''}`
        : importId === 'untracked' ? 'These older transactions have no reliable import boundary. Original import counts are unavailable.'
          : 'Choose a statement to inspect its transactions. No transaction data is loaded until you choose.';
      if (!importId) {
        rows.innerHTML = '<tr><td colspan="7" class="review-empty">Choose an import above to see how its transactions were handled.</td></tr>';
        return;
      }
      rows.innerHTML = '<tr><td colspan="7">Loading transactions...</td></tr>';
      const data = await json(`/api/transactions/transfer-review?importId=${encodeURIComponent(importId)}&status=${encodeURIComponent(status)}&limit=${PAGE_SIZE}&offset=${transferOffset}`);
      if (request !== transferRequest) return;
      rows.innerHTML = data.rows.length ? data.rows.map(row => rowMarkup(row, data.categories)).join('')
        : '<tr><td colspan="7">No transactions match this filter.</td></tr>';
      rows.querySelectorAll('[data-review-row]').forEach(updateSaveState);
      const start = data.total ? data.offset + 1 : 0;
      const end = Math.min(data.offset + data.limit, data.total);
      $('transfer-review-count').textContent = `${start}–${end} of ${data.total.toLocaleString()} transactions`;
      $('transfer-review-pagination').innerHTML = `<button type="button" class="btn btn-secondary btn-compact" data-transfer-page="-1" ${data.offset <= 0 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn-secondary btn-compact" data-transfer-page="1" ${data.offset + data.limit >= data.total ? 'disabled' : ''}>Next</button>`;
    } catch (error) {
      if (request !== transferRequest) return;
      rows.innerHTML = '';
      $('transfer-review-error').textContent = `Transactions could not be loaded: ${error.message}`;
      $('transfer-review-count').textContent = '';
      $('transfer-review-pagination').innerHTML = '';
    } finally {
      if (request === transferRequest) rows.setAttribute('aria-busy', 'false');
    }
  }

  const eventTitle = event => ({
    'import.completed': 'Statement imported',
    'import.failed': 'Import failed',
    'transaction.transfer_reviewed': 'Transfer handling corrected',
    'transaction.reclassified': 'Transaction reclassified',
    'category.created': 'Category created',
    'category.renamed': 'Category renamed',
    'category.deleted': 'Category deleted',
    'account.created': 'Account created',
    'account.updated': 'Account ownership or type changed',
    'account.deleted': 'Account deleted',
    'account.import_assigned': 'Import assigned to an account',
    'import.undo': 'Import undone',
    'import.restore': 'Import restored',
    'auth.login': 'Signed in',
    'auth.logout': 'Signed out',
    'support.request': 'Support access activity'
  })[event.event_type] || String(event.event_type || 'Workspace activity').replace(/[._]/g, ' ');

  function eventDetail(event) {
    const detail = event.detail || {};
    const pieces = [];
    if (detail.fileName) pieces.push(`File: ${detail.fileName}`);
    if (Array.isArray(detail.fileNames) && detail.fileNames.length) pieces.push(`Files: ${detail.fileNames.join(', ')}`);
    if (detail.source) pieces.push(`Source: ${detail.source}`);
    if (detail.account) pieces.push(`Account: ${detail.account}`);
    if (detail.previousAccount && detail.previousAccount !== detail.account) pieces.push(`Renamed from ${detail.previousAccount}`);
    if (detail.previousKind || detail.kind) pieces.push(`${detail.previousKind || 'Unclassified'} → ${detail.kind || 'Unclassified'}`);
    if (detail.assigned) pieces.push(`${detail.assigned} transaction${detail.assigned === 1 ? '' : 's'} assigned`);
    if (Number.isFinite(Number(detail.importedRows))) pieces.push(`${Number(detail.importedRows)} imported`);
    if (Number.isFinite(Number(detail.duplicateRows)) && Number(detail.duplicateRows)) pieces.push(`${Number(detail.duplicateRows)} duplicates`);
    if (detail.transactionId) pieces.push(`Transaction #${detail.transactionId}${detail.date ? ` · ${detail.date}` : ''}`);
    if (Array.isArray(detail.selectedTransactionIds) && detail.selectedTransactionIds.length) {
      pieces.push(`Selected transactions #${detail.selectedTransactionIds.join(', #')}${detail.moreSelectedTransactions ? ` and ${detail.moreSelectedTransactions} more` : ''}`);
    }
    if (detail.previousHandling || detail.handling) pieces.push(`${handlingLabel(detail.previousHandling)} → ${handlingLabel(detail.handling)}`);
    if (detail.previousCategory || (detail.category && (detail.handling || event.event_type === 'category.renamed' || event.event_type === 'transaction.reclassified'))) {
      pieces.push(`${detail.previousCategory || 'Uncategorized'} → ${detail.category || 'Uncategorized'}`);
    } else if (detail.category) pieces.push(`Category: ${detail.category}`);
    if (detail.count) pieces.push(`${detail.count} transaction${detail.count === 1 ? '' : 's'}`);
    if (Array.isArray(detail.categories) && detail.categories.length) pieces.push(`Categories: ${detail.categories.join(', ')}`);
    if (detail.transactionsMoved) pieces.push(`${detail.transactionsMoved} transactions moved`);
    if (detail.replacementCategoryId) pieces.push(`Replacement category #${detail.replacementCategoryId}`);
    if (detail.replacementCategory) pieces.push(`Moved to ${detail.replacementCategory}`);
    if (!pieces.length && event.path) pieces.push(`${event.path}${event.status ? ` · ${event.status}` : ''}`);
    return pieces.join(' · ') || 'No additional details recorded.';
  }

  async function loadActivity() {
    const request = ++activityRequest;
    const root = $('activity-events');
    if (!root) return;
    $('activity-error').textContent = '';
    root.innerHTML = '<p class="muted">Loading activity…</p>';
    try {
      const data = await json(`/api/activity?limit=${PAGE_SIZE}&offset=${auditOffset}`);
      if (request !== activityRequest) return;
      root.innerHTML = data.events.length ? data.events.map(event => {
        const timestamp = new Date(event.created_at);
        const when = Number.isNaN(timestamp.getTime()) ? event.created_at : timestamp.toLocaleString();
        const actor = event.actor_name || (event.actor_user_id ? `User ${event.actor_user_id}` : 'System');
        return `<article class="activity-entry">
          <div class="activity-entry-head"><strong>${escape(eventTitle(event))}</strong><time datetime="${escape(event.created_at)}">${escape(when)}</time></div>
          <p>${escape(eventDetail(event))}</p>
          <small>${escape(actor)} · ${escape(event.outcome || 'recorded')}${event.request_id ? ` · Request ${escape(event.request_id)}` : ''}</small>
        </article>`;
      }).join('') : '<p class="muted">No activity has been recorded yet.</p>';
      $('activity-count').textContent = `${data.total.toLocaleString()} recorded events · newest first`;
      $('activity-pagination').innerHTML = `<button type="button" class="btn btn-secondary btn-compact" data-activity-page="-1" ${data.offset <= 0 ? 'disabled' : ''}>Previous</button>
        <button type="button" class="btn btn-secondary btn-compact" data-activity-page="1" ${data.offset + data.limit >= data.total ? 'disabled' : ''}>Next</button>`;
    } catch (error) {
      if (request !== activityRequest) return;
      root.innerHTML = '';
      $('activity-error').textContent = `Activity could not be loaded: ${error.message}`;
      $('activity-count').textContent = '';
      $('activity-pagination').innerHTML = '';
    }
  }

  function reset() {
    generation++;
    transferRequest++;
    activityRequest++;
    importsLoaded = false;
    importsRequest = null;
    imports.clear();
    nextImportBefore = null;
    transferOffset = 0;
    auditOffset = 0;
  }

  window.FinanceReviewTools = { loadTransfers, loadActivity, reset, invalidateImports: reset };
  $('transfer-review-import')?.addEventListener('change', () => { transferOffset = 0; loadTransfers(); });
  $('transfer-review-import-more')?.addEventListener('click', async () => {
    const requestGeneration = generation;
    $('transfer-review-error').textContent = '';
    try { await loadImports(true); }
    catch (error) {
      if (requestGeneration === generation) $('transfer-review-error').textContent = `Import choices could not be loaded: ${error.message}`;
    }
  });
  $('transfer-review-filter')?.addEventListener('change', () => { transferOffset = 0; loadTransfers(); });
  $('transfer-review-refresh')?.addEventListener('click', () => { transferOffset = 0; loadTransfers({ refreshImports: true }); });
  $('activity-refresh')?.addEventListener('click', loadActivity);
  $('transfer-review-rows')?.addEventListener('change', event => {
    const row = event.target.closest('[data-review-row]');
    if (row && event.target.matches('[data-review-handling], [data-review-category]')) updateSaveState(row);
  });
  $('transfer-review-rows')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-review-save]');
    if (!button) return;
    const requestGeneration = generation;
    const row = button.closest('[data-review-row]');
    const handling = row.querySelector('[data-review-handling]').value;
    button.disabled = true;
    $('transfer-review-error').textContent = '';
    try {
      await json(`/api/transactions/${row.dataset.reviewRow}/transfer-review`, 'POST', {
        handling,
        ...(handling === 'counted' ? { category: row.querySelector('[data-review-category]').value } : {})
      });
      if (requestGeneration !== generation) return;
      await loadTransfers();
    } catch (error) {
      if (requestGeneration !== generation) return;
      $('transfer-review-error').textContent = `Could not update transaction #${row.dataset.reviewRow}: ${error.message}`;
      button.disabled = false;
    }
  });
  $('transfer-review-pagination')?.addEventListener('click', event => {
    const direction = Number(event.target.closest('[data-transfer-page]')?.dataset.transferPage || 0);
    if (!direction) return;
    transferOffset = Math.max(0, transferOffset + direction * PAGE_SIZE);
    loadTransfers();
  });
  $('activity-pagination')?.addEventListener('click', event => {
    const direction = Number(event.target.closest('[data-activity-page]')?.dataset.activityPage || 0);
    if (!direction) return;
    auditOffset = Math.max(0, auditOffset + direction * PAGE_SIZE);
    loadActivity();
  });
})();
