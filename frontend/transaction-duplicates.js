(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = row => `${row.direction === 'DEBIT' ? '-' : '+'}${Number(row.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'editor saved-duplicates-dialog';
  dialog.style.cssText = 'width:min(1000px,95vw);max-height:90vh;overflow:auto;padding:24px;';
  dialog.setAttribute('aria-labelledby', 'duplicates-title');
  dialog.innerHTML = `
    <h2 id="duplicates-title">Find duplicates in saved transactions</h2>
    <p class="muted">This scans transactions already saved in your history: bank-connected records versus uploaded statement or manual entries. To review warnings raised during bank import instead, use Review flagged bank imports on Transactions.</p>
    <p class="muted">These are possible matches, not proven duplicates. Compare the bank, account, date and description.
    Merge only if both entries are the same real transaction. The existing statement/manual record and its settings stay;
    the extra Plaid entry is permanently removed and its bank identity is attached to the retained record for future sync.</p>
    <p class="muted">Separate accounts and genuine split deposits must stay separate. Leave uncertain matches unmerged.
    Choose <strong>Keep both — different transactions</strong> when you have verified a pair is not a duplicate.
    That pair will not be suggested again; both records and their totals stay unchanged.
    Totals include both entries until you approve a merge. There is no Undo for a merge.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary" data-duplicates-select-page>Select unambiguous on page</button>
      <button type="button" class="btn btn-secondary" data-duplicates-select-all>Select all unambiguous (max 500)</button>
      <button type="button" class="btn btn-secondary" data-duplicates-clear>Clear selection</button>
      <button type="button" class="btn btn-primary" data-duplicates-merge-selected>Merge selected (0)</button>
    </div>
    <p class="muted">Selections stay across pages. Select-all includes only one-to-one matches, not proof of duplication.
    Review selected pairs before confirming; competing matches must be chosen individually.</p>
    <p id="duplicates-status" role="status" aria-live="polite"></p>
    <div class="table-scroll"><table style="width:100%"><thead><tr>
      <th>Select</th><th>Extra Plaid record</th><th>Existing record to keep</th><th>Decision</th>
    </tr></thead><tbody id="duplicates-rows"></tbody></table></div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:16px;">
      <button type="button" class="btn btn-secondary" data-duplicates-prev>Previous</button>
      <button type="button" class="btn btn-secondary" data-duplicates-next>Next</button>
      <button type="button" class="btn btn-secondary" data-duplicates-reload>Refresh matches</button>
      <button type="button" class="btn btn-primary" data-duplicates-close>Done</button>
    </div>`;
  document.body.appendChild(dialog);
  const statusNode = dialog.querySelector('#duplicates-status');
  const body = dialog.querySelector('#duplicates-rows');
  let rows = [], offset = 0, total = 0, busy = false, generation = 0, countGeneration = 0;
  const selected = new Map();
  const pairKey = pair => `${pair.plaid.id}:${pair.existing.id}`;
  const conflicts = pair => [...selected.values()].some(item => pairKey(item) !== pairKey(pair)
    && (item.plaid.id === pair.plaid.id || item.existing.id === pair.existing.id));
  function status(message, error = false) {
    statusNode.textContent = message;
    statusNode.setAttribute('role', error ? 'alert' : 'status');
  }
  function update() {
    dialog.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    dialog.querySelector('[data-duplicates-prev]').disabled = busy || offset === 0;
    dialog.querySelector('[data-duplicates-next]').disabled = busy || offset + 50 >= total;
    dialog.querySelector('[data-duplicates-select-page]').disabled = busy || !rows.some(pair => pair.bulkEligible);
    dialog.querySelector('[data-duplicates-select-all]').disabled = busy || !total;
    dialog.querySelector('[data-duplicates-clear]').disabled = busy || !selected.size;
    const mergeButton = dialog.querySelector('[data-duplicates-merge-selected]');
    mergeButton.disabled = busy || !selected.size;
    mergeButton.textContent = `Merge selected (${selected.size})`;
    dialog.querySelectorAll('[data-duplicates-select]').forEach(box => {
      const pair = rows[Number(box.dataset.duplicatesSelect)];
      if (!pair) return;
      box.checked = selected.has(pairKey(pair));
      box.disabled = busy || conflicts(pair) || (!box.checked && selected.size >= 500);
    });
  }
  async function request(url, data) {
    const response = await fetch(url, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }
  async function refreshCounts() {
    const importCount = document.getElementById('duplicate-import-count');
    const savedCount = document.getElementById('duplicate-saved-count');
    if (!importCount || !savedCount) return;
    const current = ++countGeneration;
    const counts = [
      { node: importCount, label: 'Bank import reviews', url: '/api/import-review/reviews?offset=0&mode=all' },
      { node: savedCount, label: 'Saved transaction pairs', url: '/api/import-review/duplicates?offset=0' }
    ];
    await Promise.all(counts.map(async ({ node, label, url }) => {
      try {
        const data = await request(url);
        if (!Number.isSafeInteger(data.total) || data.total < 0) throw new Error('Invalid count');
        if (current === countGeneration) node.textContent = `${label}: ${data.total.toLocaleString()}`;
      } catch (error) {
        if (current === countGeneration) node.textContent = `${label}: unavailable (expand to retry)`;
      }
    }));
  }
  const cell = row => `<strong>${esc(row.display_name || row.description)}</strong>
    <p>${esc(row.date)} &middot; ${esc(money(row))}</p>
    <small>${esc(row.description)}<br>${esc(row.source || 'Unknown source')} &middot; #${esc(row.id)}
    ${row.institution ? `<br>${esc(row.institution)}` : ''}
    <br>${esc(row.account_name || 'Account not assigned')}${row.account_mask ? ` &middot; ending ${esc(row.account_mask)}` : ''}
    <br>${esc(row.category || 'Uncategorized')}${row.is_fixed ? ' &middot; Fixed' : ''}
    ${row.pay_mode ? ` &middot; ${esc(row.pay_mode)}` : ''}</small>`;
  async function load(pageOffset = 0) {
    const current = generation;
    const data = await request(`/api/import-review/duplicates?offset=${pageOffset}`);
    if (current !== generation) return;
    if (!data.rows.length && data.total > 0 && data.offset > 0) {
      return load(Math.floor((data.total - 1) / 50) * 50);
    }
    rows = data.rows; total = data.total; offset = data.offset;
    const count = document.getElementById('duplicate-saved-count');
    if (count) count.textContent = `Saved transaction pairs: ${total.toLocaleString()}`;
    for (const pair of rows) {
      if (selected.has(pairKey(pair)) && selected.get(pairKey(pair)).revision !== pair.revision) {
        selected.delete(pairKey(pair));
      }
    }
    body.innerHTML = rows.map((pair, index) => `<tr>
      <td data-label="Select pair"><input type="checkbox" data-duplicates-select="${index}" aria-label="Select Plaid #${pair.plaid.id} and existing #${pair.existing.id}"></td>
      <td data-label="Bank-connected record" style="padding:12px;vertical-align:top">${cell(pair.plaid)}</td>
      <td data-label="Statement or manual record" style="padding:12px;vertical-align:top">${cell(pair.existing)}</td>
      <td data-label="Your decision"><button type="button" class="btn btn-secondary" data-duplicates-merge="${index}">Merge into existing</button>
        <button type="button" class="btn btn-secondary" data-duplicates-separate="${index}">Keep both — different transactions</button></td>
    </tr>`).join('') || '<tr><td colspan="4">No possible Plaid / statement matches on this page.</td></tr>';
    status(`${total ? offset + 1 : 0}-${Math.min(offset + rows.length, total)} of ${total} possible pairs. ${selected.size} selected across pages. Nothing is merged automatically.`);
  }
  async function runLoad(pageOffset = 0) {
    if (busy) return;
    busy = true; update();
    const current = generation;
    try { await load(pageOffset); }
    catch (error) {
      if (current === generation) { selected.clear(); rows = []; body.innerHTML = ''; status(`Could not load matches: ${error.message}`, true); }
    } finally { if (current === generation) { busy = false; update(); } }
  }
  async function selectAll() {
    if (busy) return;
    const current = generation;
    busy = true; update();
    try {
      const data = await request('/api/import-review/duplicates?selection=all');
      if (current !== generation) return;
      selected.clear();
      for (const pair of data.rows) selected.set(pairKey(pair), pair);
      status(`${selected.size} one-to-one pairs selected across all pages. Review them before merging; ambiguous matches were excluded.`);
    } catch (error) {
      if (current === generation) status(`Could not select all: ${error.message}`, true);
    } finally { if (current === generation) { busy = false; update(); } }
  }
  async function keepSeparate(index) {
    const pair = rows[index], current = generation;
    if (busy || !pair) return;
    if (window.importIsBusy?.()) { status('Wait for the current import or recovery to finish.', true); return; }
    busy = true; update();
    let saved = false;
    try {
      const accepted = await window.FinanceUI.confirm(
        `Confirm Plaid #${pair.plaid.id} (${pair.plaid.date}, ${money(pair.plaid)}) and existing #${pair.existing.id} (${pair.existing.date}, ${money(pair.existing)}) are different real transactions. Keep both records and their totals unchanged, and stop suggesting this pair. Other possible matches still need review.`,
        { title: 'Keep different transactions', action: 'Keep both' });
      if (!accepted || current !== generation) return;
      await request('/api/import-review/duplicates/separate', {
        plaidId: pair.plaid.id, existingId: pair.existing.id, revision: pair.revision, acknowledged: true
      });
      if (current !== generation) return;
      saved = true;
      selected.delete(pairKey(pair));
      rows = []; body.innerHTML = '';
      window.FinanceReviewTools?.invalidateImports?.();
      const refreshed = await Promise.allSettled([
        window.loadAllTransactions?.(), window.loadTransactionImportReviews?.()
      ]);
      if (current !== generation) return;
      const failed = refreshed.some(item => item.status === 'rejected' || item.value === false);
      await load(offset);
      if (current !== generation) return;
      refreshCounts();
      status(`Decision saved: kept both transactions. Amounts and totals unchanged. ${total} possible pairs remain.${failed ? ' Some views could not refresh; reload the app.' : ''}`, failed);
    } catch (error) {
      if (current === generation) {
        rows = []; body.innerHTML = '';
        status(`${saved ? 'Both transactions were kept, but review refresh failed' : 'Keep-both decision could not be confirmed'}: ${error.message} Refresh matches before retrying.`, true);
      }
    } finally { if (current === generation) { busy = false; update(); } }
  }
  async function merge(index, bulk = false) {
    const pairs = bulk ? [...selected.values()] : rows[index] ? [rows[index]] : [];
    if (busy || !pairs.length) return;
    if (window.importIsBusy?.()) { status('Wait for the current import or recovery to finish.', true); return; }
    const pair = pairs[0], current = generation;
    busy = true; update();
    try {
      const accepted = await window.FinanceUI.confirm(
        bulk
          ? `Merge ${pairs.length} selected pairs across pages? Confirm every pair is the same real transaction, not separate accounts or split deposits. Keep each existing record and its settings; permanently remove ${pairs.length} extra Plaid records. The entire batch is rejected if any pair changed. There is no Undo.`
          : `Confirm these are the same real transaction: Plaid #${pair.plaid.id} (${pair.plaid.date}, ${money(pair.plaid)}) and existing #${pair.existing.id} (${pair.existing.date}, ${money(pair.existing)}). Keep the existing record and its settings; permanently remove only the extra Plaid record. There is no Undo.`,
        { title: bulk ? 'Merge selected duplicate pairs' : 'Merge one duplicate pair', action: bulk ? `Merge ${pairs.length} pairs` : 'Merge into existing' });
      if (!accepted || current !== generation) return;
      const choices = pairs.map(item => ({
        plaidId: item.plaid.id, existingId: item.existing.id, revision: item.revision
      }));
      const result = await request(`/api/import-review/duplicates/${bulk ? 'merge-bulk' : 'merge'}`,
        bulk ? { pairs: choices, acknowledged: true } : { ...choices[0], acknowledged: true });
      if (current !== generation) return;
      selected.clear(); rows = []; body.innerHTML = '';
      const success = bulk ? `Merged ${result.merged} duplicate pairs.` : `Merged into #${result.keptTransactionId}.`;
      status(`${success} Refreshing totals...`);
      window.FinancePlan?.invalidate?.();
      window.FinancePro?.invalidateAnalytics?.();
      window.FinanceReviewTools?.invalidateImports?.();
      const refreshed = await Promise.allSettled([
        window.loadDashboard?.(), window.loadAllTransactions?.(), window.loadCategories?.(),
        window.loadTransactionImportReviews?.(), window.FinanceAccounts?.loadPage?.(),
        window.FinanceImportHistory?.load?.()
      ]);
      if (current !== generation) return;
      const failed = refreshed.some(item => item.status === 'rejected' || item.value === false);
      await load(0);
      if (current !== generation) return;
      refreshCounts();
      status(`${success} ${failed ? 'Some views could not refresh; reload the app.' : 'Totals and forecasts refreshed.'} ${total} possible pairs remain.`, failed);
    } catch (error) {
      if (current === generation) {
        selected.clear(); rows = []; body.innerHTML = '';
        status(`Merge could not be confirmed: ${error.message} Refresh matches before retrying.`, true);
      }
    } finally { if (current === generation) { busy = false; update(); } }
  }
  dialog.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    if (button.hasAttribute('data-duplicates-close')) dialog.close();
    else if (button.hasAttribute('data-duplicates-prev')) runLoad(Math.max(0, offset - 50));
    else if (button.hasAttribute('data-duplicates-next')) runLoad(offset + 50);
    else if (button.hasAttribute('data-duplicates-reload')) { selected.clear(); runLoad(0); }
    else if (button.hasAttribute('data-duplicates-select-all')) selectAll();
    else if (button.hasAttribute('data-duplicates-select-page')) {
      for (const pair of rows) if (pair.bulkEligible && !conflicts(pair) && selected.size < 500) selected.set(pairKey(pair), pair);
      update(); status(`${selected.size} pairs selected across pages.`);
    }
    else if (button.hasAttribute('data-duplicates-clear')) { selected.clear(); update(); status('Selection cleared.'); }
    else if (button.hasAttribute('data-duplicates-merge-selected')) merge(null, true);
    else if (button.hasAttribute('data-duplicates-merge')) merge(Number(button.dataset.duplicatesMerge));
    else if (button.hasAttribute('data-duplicates-separate')) keepSeparate(Number(button.dataset.duplicatesSeparate));
  });
  dialog.addEventListener('change', event => {
    const box = event.target.closest('[data-duplicates-select]');
    if (!box || busy) return;
    const pair = rows[Number(box.dataset.duplicatesSelect)];
    if (!pair) return;
    if (!box.checked) selected.delete(pairKey(pair));
    else if (!conflicts(pair) && selected.size < 500) selected.set(pairKey(pair), pair);
    update(); status(`${selected.size} pairs selected across pages.`);
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('keydown', event => {
    if (busy && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-duplicate-counts-refresh]')) { refreshCounts(); return; }
    if (!event.target.closest('[data-transaction-duplicates]') || busy) return;
    dialog.showModal(); runLoad(0);
  });
  window.FinanceTransactionDuplicates = { refreshCounts, reset() {
    generation++; countGeneration++; selected.clear(); rows = []; offset = 0; total = 0; busy = false; body.innerHTML = ''; status('');
    const importCount = document.getElementById('duplicate-import-count');
    const savedCount = document.getElementById('duplicate-saved-count');
    if (importCount) importCount.textContent = 'Bank import reviews: loading';
    if (savedCount) savedCount.textContent = 'Saved transaction pairs: loading';
    if (dialog.open) dialog.close();
    update();
  } };
})();
