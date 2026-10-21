// MyFinance Pro on Categories (monthly histograms, stats, spend mix) and Transactions (CSV export).
(() => {
  const $ = id => document.getElementById(id);
  const TRANSFER = /^(?:transfers?|internal transfers?|savings|savings transfer)$/i;
  const MAX_HIST_MONTHS = 24;
  let lastDetail = null, token = 0;

  const monthOf = date => {
    const text = String(date ?? '');
    if (/^\d{4}-\d{2}/.test(text)) return text.slice(0, 7);
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? '' : `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
  };
  const nextMonth = key => {
    const [y, m] = key.split('-').map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  };

  // Months covered by the selected period. "All time" spans the first to the last month with activity.
  function periodMonths(period, transactions) {
    if (Array.isArray(period?.months)) return [...new Set(period.months)].sort();
    const seen = transactions.map(t => monthOf(t.date)).filter(Boolean).sort();
    if (!seen.length) return [];
    const months = [];
    for (let key = seen[0]; key <= seen[seen.length - 1] && months.length < 600; key = nextMonth(key)) months.push(key);
    return months;
  }

  // Pure: per-category monthly series and stats for the selected period. Exposed for tests.
  function categoryStats(transactions, months) {
    const index = new Map(months.map((m, i) => [m, i]));
    const map = new Map();
    let total = 0;
    for (const t of transactions) {
      if (String(t.direction).toUpperCase() !== 'DEBIT') continue;
      const i = index.get(monthOf(t.date));
      if (i == null) continue;
      // The stored transfer decision wins; older data without it falls back to the category name.
      const isTransfer = Object.prototype.hasOwnProperty.call(t, 'transfer_kind') ? t.transfer_kind != null : TRANSFER.test(t.category || '');
      const category = t.category || 'Uncategorized';
      const name = isTransfer && !TRANSFER.test(category) ? 'Transfer' : !isTransfer && TRANSFER.test(category) ? 'Other' : category;
      const amount = Math.abs(Number(t.amount) || 0);
      if (!map.has(name)) map.set(name, { name, series: months.map(() => 0), total: 0, count: 0, transfer: isTransfer });
      const entry = map.get(name);
      entry.series[i] += amount; entry.total += amount; entry.count += 1;
      if (!entry.transfer) total += amount;
    }
    for (const entry of map.values()) {
      const n = entry.series.length || 1, avg = entry.total / n;
      const sd = Math.sqrt(entry.series.reduce((s, v) => s + (v - avg) ** 2, 0) / n);
      const half = Math.floor(n / 2);
      const first = half ? entry.series.slice(0, half).reduce((a, b) => a + b, 0) / half : 0;
      const second = half ? entry.series.slice(n - half).reduce((a, b) => a + b, 0) / half : 0;
      Object.assign(entry, {
        average: avg,
        share: entry.transfer || !total ? null : entry.total / total,
        volatility: avg ? sd / avg : 0,
        trend: n < 2 ? null : first ? (second - first) / first : second > 0 ? 1 : 0
      });
    }
    return { total, categories: map };
  }

  function insightStrip(stats, months, period) {
    const { money, pct, esc } = globalThis.FinancePro.format;
    const { PALETTE } = globalThis.ProCharts;
    const list = [...stats.categories.values()].filter(c => !c.transfer && c.total > 0).sort((a, b) => b.total - a.total);
    const top = list[0];
    const multi = months.length >= 2;
    const rising = multi ? list.filter(c => c.average >= 25 && c.trend != null).sort((a, b) => b.trend - a.trend)[0] : null;
    const volatile = multi ? list.filter(c => c.average >= 25).sort((a, b) => b.volatility - a.volatility)[0] : null;
    const mix = list.slice(0, 7);
    const restTotal = list.slice(7).reduce((s, c) => s + c.total, 0);
    const segments = mix.map((c, i) => `<i style="width:${((c.total / stats.total) * 100).toFixed(2)}%;background:${PALETTE[i]}" title="${esc(c.name)} ${pct(c.share)}"></i>`).join('') +
      (restTotal ? `<i style="width:${((restTotal / stats.total) * 100).toFixed(2)}%;background:${PALETTE[9]}" title="Other categories"></i>` : '');
    const legend = mix.map((c, i) => `<span><i style="background:${PALETTE[i]}"></i>${esc(c.name)} <strong>${pct(c.share)}</strong></span>`).join('');
    return `<details class="category-analytics pro-insight-panel panel pro-added"><summary><span>Explore spending insights <small>Monthly trends, spending mix &amp; category signals</small></span><span class="pro-tag">PRO</span></summary><div class="pro-insight-head"><div><p class="eyebrow">PRO INSIGHTS &middot; ${esc(String(period?.label || 'All time').toUpperCase())}</p><h2>Where your money went</h2></div></div>
      <div class="pro-kpi-row">
        <div><span>Total spend</span><strong>${money(stats.total, true)}</strong><small>${months.length} month${months.length === 1 ? '' : 's'} &middot; transfers excluded</small></div>
        <div><span>Average / month</span><strong>${money(stats.total / (months.length || 1), true)}</strong><small>Across every spending category</small></div>
        <div><span>Largest category</span><strong class="is-name">${top ? esc(top.name) : '&mdash;'}</strong><small>${top ? `${pct(top.share)} of spend` : 'No spending yet'}</small></div>
        <div><span>Fastest rising</span><strong class="is-name">${rising && rising.trend > 0.05 ? esc(rising.name) : '&mdash;'}</strong><small class="${rising && rising.trend > 0.05 ? 'is-up' : ''}">${rising && rising.trend > 0.05 ? `▲ ${pct(rising.trend)} second half vs first` : multi ? 'Nothing is accelerating' : 'Select 2+ months'}</small></div>
        <div><span>Most volatile</span><strong class="is-name">${volatile ? esc(volatile.name) : '&mdash;'}</strong><small>${volatile ? `Swings &plusmn;${pct(volatile.volatility)} month to month` : 'Select 2+ months'}</small></div>
      </div>
      ${list.length ? `<div class="pro-mix"><div class="pro-mix-bar" role="img" aria-label="Spending mix">${segments}</div><div class="pro-mix-legend">${legend}</div></div>` : ''}</details>`;
  }

  function cardExtra(entry, months, signal) {
    const { money, pct } = globalThis.FinancePro.format;
    const { histogram, monthShort } = globalThis.ProCharts;
    if (!entry || !entry.total) return '<span class="pro-cat-extra pro-added"><span class="pro-cat-note">No spending in this period</span></span>';
    const shown = months.slice(-MAX_HIST_MONTHS), series = entry.series.slice(-MAX_HIST_MONTHS);
    const chart = months.length >= 2
      ? `<span class="pro-cat-hist">${histogram(series, shown.map(m => `${monthShort(m)} ${m.slice(0, 4)}`))}<span class="pro-cat-hist-axis"><em>${monthShort(shown[0])} ${shown[0].slice(2, 4)}</em><em>avg ${money(entry.average, true)}</em><em>${monthShort(shown[shown.length - 1])} ${shown[shown.length - 1].slice(2, 4)}</em></span></span>`
      : '';
    const trend = entry.trend == null ? '' : `<span class="${entry.trend > 0.05 ? 'is-up' : entry.trend < -0.05 ? 'is-down' : ''}"><small>Trend</small>${entry.trend > 0.05 ? '▲' : entry.trend < -0.05 ? '▼' : '▬'} ${pct(Math.abs(entry.trend))}</span>`;
    const signalChip = signal && signal !== 'inline' ? `<span class="pro-signal is-${signal}">${signal === 'above' ? 'Running hot vs 3-mo avg' : signal === 'below' ? 'Cooling vs 3-mo avg' : 'New category'}</span>` : '';
    return `<span class="pro-cat-extra pro-added">${chart}<span class="pro-cat-stats">
      <span><small>Avg/mo</small>${money(entry.average, true)}</span>
      <span><small>Share</small>${entry.share == null ? 'Transfer' : pct(entry.share)}</span>${trend}</span>${signalChip}</span>`;
  }

  function renderSwitch(active, on) {
    const panel = document.querySelector('#categories-view .filter-panel');
    if (!panel) return;
    let host = $('category-pro-switch');
    if (!host) {
      host = document.createElement('div');
      host.id = 'category-pro-switch';
      host.className = 'pro-filter-tools';
      panel.appendChild(host);
    }
    host.innerHTML = globalThis.FinancePro.proSwitch('cat-insights', 'Analytics', on);
  }

  async function enhance(detail) {
    const pro = globalThis.FinancePro, view = $('categories-view');
    if (!pro || !view || !detail) return;
    const run = ++token;
    lastDetail = detail;
    await pro.ensureEntitlement();
    if (run !== token) return;
    const active = pro.isActive(), on = active && pro.prefs.get('cat.insights', 'on') === 'on';
    renderSwitch(active, on);
    view.querySelectorAll('.pro-added').forEach(node => node.remove());
    view.classList.toggle('has-pro-insights', on);
    if (!on) return;
    const months = periodMonths(detail.period, detail.transactions || []);
    const stats = categoryStats(detail.transactions || [], months);
    $('category-cards').insertAdjacentHTML('beforebegin', insightStrip(stats, months, detail.period));
    let signals = new Map();
    try { signals = new Map((await pro.getAnalytics()).categories.map(c => [c.name, c.signal])); } catch { /* signals are optional here */ }
    if (run !== token) return;
    $('category-cards').querySelectorAll('.category-card').forEach(card => {
      const name = card.dataset.openCategory;
      if (card.classList.contains('is-inactive')) return;
      card.insertAdjacentHTML('beforeend', cardExtra(stats.categories.get(name), months, signals.get(name)));
    });
  }

  function exportTransactions() {
    const pro = globalThis.FinancePro;
    if (!pro.requirePro('CSV export is part of MyFinance Pro.')) return;
    const period = globalThis.currentTransactionPeriod?.();
    if (Array.isArray(period?.months) && !period.months.length) {
      globalThis.notify('Choose at least one month before exporting.');
      return;
    }
    const months = (period?.months || []).slice().sort();
    const params = new URLSearchParams({ type: 'transactions' });
    const transactionId = globalThis.currentTransactionId?.();
    if (transactionId) params.set('transactionId', transactionId);
    if (months.length) {
      const [y, m] = months[months.length - 1].split('-').map(Number);
      params.set('from', `${months[0]}-01`);
      params.set('to', `${months[months.length - 1]}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`);
    }
    location.href = `/api/analytics/export.csv?${params}`;
  }

  function mountExport() {
    const panel = document.querySelector?.('#transactions-view .filter-panel');
    if (!panel || $('txn-export-csv')?.tagName || typeof panel.appendChild !== 'function') return;
    const button = document.createElement('button');
    button.id = 'txn-export-csv';
    button.type = 'button';
    button.className = 'btn btn-secondary btn-compact pro-export-btn';
    button.addEventListener('click', exportTransactions);
    panel.appendChild(button);
    renderExport();
  }
  function renderExport() {
    const button = $('txn-export-csv');
    if (button?.tagName) button.innerHTML = `${globalThis.FinancePro?.ICONS.export || ''}Export CSV${globalThis.FinancePro?.proTag() || ''}`;
  }

  document.addEventListener('categories:rendered', event => enhance(event.detail));
  document.addEventListener('click', event => {
    const target = event.target?.closest?.('[data-pro-switch="cat-insights"]');
    if (!target) return;
    const pro = globalThis.FinancePro;
    if (!pro.requirePro('Category analytics are part of MyFinance Pro.')) return;
    pro.prefs.set('cat.insights', target.getAttribute('aria-checked') === 'true' ? 'off' : 'on');
    enhance(lastDetail);
  });
  document.addEventListener('pro:entitlement', renderExport);
  mountExport();

  globalThis.FinanceProCategories = { periodMonths, categoryStats, cardExtra, exportTransactions };
})();
