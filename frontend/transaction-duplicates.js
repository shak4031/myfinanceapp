(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = row => `${row.direction === 'DEBIT' ? '-' : '+'}${Number(row.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`;
  const dialog = document.createElement('dialog');
  dialog.className = 'editor';
  dialog.style.cssText = 'width:min(1000px,95vw);max-height:90vh;overflow:auto;padding:24px;';
  dialog.setAttribute('aria-labelledby', 'duplicates-title');
  dialog.innerHTML = `
    <h2 id="duplicates-title">Review Plaid / statement duplicates</h2>
    <p class="muted">These are possible matches, not proven duplicates. Compare the bank, account, date and description.
    Merge only if both entries are the same real transaction. The existing statement/manual record and its settings stay;
    the extra Plaid entry is permanently removed and its bank identity is attached to the retained record for future sync.</p>
    <p class="muted">Separate accounts and genuine split deposits must stay separate. Leave uncertain matches unmerged.
    Totals include both entries until you approve a merge. There is no Undo.</p>
    <p id="duplicates-status" role="status" aria-live="polite"></p>
    <div class="table-scroll"><table style="width:100%"><thead><tr>
      <th>Extra Plaid record</th><th>Existing record to keep</th><th>Decision</th>
    </tr></thead><tbody id="duplicates-rows"></tbody></table></div>
    <div style="display:flex;gap:12px;margin-top:16px;">
      <button type="button" class="btn btn-secondary" data-duplicates-prev>Previous</button>
      <button type="button" class="btn btn-secondary" data-duplicates-next>Next</button>
      <button type="button" class="btn btn-secondary" data-duplicates-reload>Refresh matches</button>
      <button type="button" class="btn btn-primary" data-duplicates-close>Done</button>
    </div>`;
  document.body.appendChild(dialog);
  const statusNode = dialog.querySelector('#duplicates-status');
  const body = dialog.querySelector('#duplicates-rows');
  let rows = [], offset = 0, total = 0, busy = false, generation = 0;
  function status(message, error = false) {
    statusNode.textContent = message;
    statusNode.setAttribute('role', error ? 'alert' : 'status');
  }
  function update() {
    dialog.querySelectorAll('button').forEach(button => { button.disabled = busy; });
    dialog.querySelector('[data-duplicates-prev]').disabled = busy || offset === 0;
    dialog.querySelector('[data-duplicates-next]').disabled = busy || offset + 50 >= total;
  }
  async function request(url, data) {
    const response = await fetch(url, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
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
    rows = data.rows; total = data.total; offset = data.offset;
    body.innerHTML = rows.map((pair, index) => `<tr>
      <td style="padding:12px;vertical-align:top">${cell(pair.plaid)}</td>
      <td style="padding:12px;vertical-align:top">${cell(pair.existing)}</td>
      <td><button type="button" class="btn btn-secondary" data-duplicates-merge="${index}">Merge into existing</button></td>
    </tr>`).join('') || '<tr><td colspan="3">No possible Plaid / statement matches on this page.</td></tr>';
    status(`${total ? offset + 1 : 0}-${Math.min(offset + rows.length, total)} of ${total} possible pairs. Nothing is merged automatically.`);
  }
  async function runLoad(pageOffset = 0) {
    if (busy) return;
    busy = true; update();
    const current = generation;
    try { await load(pageOffset); }
    catch (error) {
      if (current === generation) { rows = []; body.innerHTML = ''; status(`Could not load matches: ${error.message}`, true); }
    } finally { if (current === generation) { busy = false; update(); } }
  }
  async function merge(index) {
    if (busy || !rows[index]) return;
    if (window.importIsBusy?.()) { status('Wait for the current import or recovery to finish.', true); return; }
    const pair = rows[index], current = generation;
    busy = true; update();
    try {
      const accepted = await window.FinanceUI.confirm(
        `Confirm these are the same real transaction: Plaid #${pair.plaid.id} (${pair.plaid.date}, ${money(pair.plaid)}) and existing #${pair.existing.id} (${pair.existing.date}, ${money(pair.existing)}). Keep the existing record and its settings; permanently remove only the extra Plaid record. There is no Undo.`,
        { title: 'Merge one duplicate pair', action: 'Merge into existing' });
      if (!accepted || current !== generation) return;
      const result = await request('/api/import-review/duplicates/merge', {
        plaidId: pair.plaid.id, existingId: pair.existing.id, revision: pair.revision, acknowledged: true
      });
      if (current !== generation) return;
      rows = []; body.innerHTML = '';
      status(`Merged into transaction #${result.keptTransactionId}. Refreshing totals...`);
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
      await load(Math.max(0, offset >= total - 1 ? offset - 50 : offset));
      if (current !== generation) return;
      status(`Merged into #${result.keptTransactionId}. ${failed ? 'Some views could not refresh; reload the app.' : 'Totals and forecasts refreshed.'} ${total} possible pairs remain.`, failed);
    } catch (error) {
      if (current === generation) {
        rows = []; body.innerHTML = '';
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
    else if (button.hasAttribute('data-duplicates-reload')) runLoad(0);
    else if (button.hasAttribute('data-duplicates-merge')) merge(Number(button.dataset.duplicatesMerge));
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('keydown', event => {
    if (busy && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-transaction-duplicates]') || busy) return;
    dialog.showModal(); runLoad(0);
  });
  window.FinanceTransactionDuplicates = { reset() {
    generation++; rows = []; offset = 0; total = 0; busy = false; body.innerHTML = ''; status('');
    if (dialog.open) dialog.close();
    update();
  } };
})();
