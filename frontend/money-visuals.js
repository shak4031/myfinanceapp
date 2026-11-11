(() => {
  const palette = ['#7c6ee6', '#1d96b3', '#d48525', '#328c72', '#c45889', '#547cc3'];
  const format = () => globalThis.FinancePro.format;

  function mosaic(items) {
    const { esc, money } = format();
    const rows = items.filter(item => Number.isFinite(item.value) && item.value > 0);
    if (!rows.length) return '<p class="pro-empty">No spending in this period.</p>';
    const tiles = [];
    const sum = list => list.reduce((total, item) => total + item.value, 0);
    function split(list, x, y, w, h) {
      if (list.length === 1) {
        tiles.push({ ...list[0], x, y, w, h });
        return;
      }
      const total = sum(list);
      let index = 1, left = list[0].value;
      while (index < list.length - 1 && Math.abs(left + list[index].value - total / 2) < Math.abs(left - total / 2)) {
        left += list[index++].value;
      }
      const ratio = left / total;
      if (w >= h) {
        split(list.slice(0, index), x, y, w * ratio, h);
        split(list.slice(index), x + w * ratio, y, w * (1 - ratio), h);
      } else {
        split(list.slice(0, index), x, y, w, h * ratio);
        split(list.slice(index), x, y + h * ratio, w, h * (1 - ratio));
      }
    }
    const groups = new Map();
    for (const item of rows) {
      const key = item.category || 'Merchants';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    split([...groups].map(([name, members]) => ({ name, members, value: sum(members) })).sort((a, b) => b.value - a.value), 0, 0, 100, 100);
    const regions = tiles.splice(0);
    for (const group of regions) {
      const members = [...group.members].sort((a, b) => b.value - a.value);
      split(members.map((item, index) => ({ ...item, groupLabel: index === 0 ? group.name : '' })), group.x, group.y, group.w, group.h);
    }
    // Treemap placement is positional; DOM order is largest first so the stacked phone layout reads in rank order.
    tiles.sort((a, b) => b.value - a.value);
    const total = sum(rows);
    const top = Math.max(...rows.map(item => item.value));
    return `<div class="money-mosaic market-heatmap" role="group" aria-label="Merchant spending heatmap grouped by category. Tile area represents share of the displayed merchants.">${tiles.map(item => {
      const label = `${item.name}: ${money(item.value)}, ${(item.value / total * 100).toFixed(1)}% of displayed spending. ${item.detail || ''}`;
      const comparable = !item.isNew && Number.isFinite(item.change);
      const change = comparable ? `${item.change > 0 ? '+' : ''}${(item.change * 100).toFixed(1)}%` : item.isNew ? 'New' : 'No comparison';
      const intensity = comparable ? Math.min(1, Math.abs(item.change)) : 0;
      const tileColor = !comparable || Math.abs(item.change) < .005 ? '#334e68'
        : item.change > 0 ? `hsl(351, ${50 + intensity * 22}%, ${34 + intensity * 8}%)` : `hsl(155, ${45 + intensity * 30}%, ${24 + intensity * 9}%)`;
      return `<div class="money-tile${item.w < 14 || item.h < 14 ? ' is-small' : ''}" tabindex="0" role="img" aria-label="${esc(label)}" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;--tile-color:${tileColor};--tile-share:${(item.value / top * 100).toFixed(1)}%">
        <div class="money-tile-face">${item.groupLabel ? `<span class="market-sector">${esc(item.groupLabel)}</span>` : ''}<span class="merchant-monogram" aria-hidden="true">${esc(item.name.slice(0, 2).toUpperCase())}</span><b>${esc(item.name)}</b><strong>${esc(money(item.value))}</strong><small>${esc(change)}</small></div>
        <span class="money-tile-tip">${esc(label)}</span></div>`;
    }).join('')}</div>
    <div class="market-legend"><span>Less spending</span><i aria-hidden="true"></i><span>More spending</span><small>vs previous period · slate = new / unavailable</small></div>
    <details class="money-exact"><summary>About this view</summary><p>Tile area = money out, not transaction count. Merchants are grouped by category. Color shows the change in monthly average spending, not investment returns or a judgment about a purchase. Percentages describe these displayed merchants, not necessarily all spending. Focus or hover a tile for its full label.</p></details>
    <details class="money-exact"><summary>Exact totals and trends for every displayed merchant</summary><ul class="pro-list is-wrap">${rows.map(item =>
      `<li><div><strong>${esc(item.name)}</strong><small>${esc(item.detail || '')}</small></div><strong>${esc(money(item.value))}</strong></li>`).join('')}</ul></details>`;
  }

  const percent = value => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
  const difference = (value, baseline) => {
    const { money } = format();
    const delta = value - baseline;
    return `${delta >= 0 ? '+' : '-'}${money(Math.abs(delta))}${baseline > 0 ? ` (${percent(delta / baseline)})` : ' (percentage unavailable: zero baseline)'}`;
  };

  function signalEvidence(category, { selectedRange = false, monthsAnalyzed = 0 } = {}) {
    const { money } = format();
    const count = category.series?.length || monthsAnalyzed;
    const reading = (key, available, value, comparison, rule) => ({
      key, status: !available ? 'needs-history' : category.signals.includes(key) ? 'warning' : 'within-range',
      value, comparison, rule
    });
    const benchmark = reading('a', Number.isFinite(category.expected) && category.expected > 0,
      `${money(category.monthly)}/mo`, Number.isFinite(category.expected) && category.expected > 0
        ? `Similar homes ${money(category.expected)}/mo; difference ${difference(category.monthly, category.expected)}.`
        : 'No comparable household benchmark is available.',
      `${selectedRange ? 'Selected-period' : 'Latest 3-month'} average versus the household survey estimate. Warning: more than 10% above.`);
    const cross = category.crossover;
    const momentum = category.momentum;
    const trendAvailable = !!momentum || (!!cross && count >= 6 && !cross.seasonal);
    const trendParts = [];
    if (cross && count >= 6) trendParts.push(`Recent 3-month average ${money(cross.fast)} versus ${cross.slowMonths}-month average ${money(cross.slow)}; ${difference(cross.fast, cross.slow)}${cross.seasonal ? ' (seasonal; not used alone as a warning)' : ''}.`);
    if (momentum) trendParts.push(momentum.basis === 'year-over-year'
      ? `Same-months-last-year change ${percent(momentum.change)}${Number.isFinite(momentum.lastYear) ? `; prior average ${money(momentum.lastYear)}/mo` : ''}${momentum.confirmed === false ? '; not confirmed by the recent trend' : ''}.`
      : `Robust 6-month trend ${percent(momentum.change)} per month.`);
    if (!trendAvailable && category.seasonal) trendParts.push(`${count} completed months available; seasonal comparisons need 15 months for a year-over-year reading.`);
    const trend = reading('b', trendAvailable, trendAvailable ? (category.rising ? 'Rising signal' : 'No rising warning') : 'Insufficient history',
      trendParts.join(' ') || `${count} completed months available. ${category.seasonal ? 'Seasonal categories need 15 months for a year-over-year comparison.' : 'At least 6 months are needed to compare short and long trends.'}`,
      'Warning: confirmed momentum above 10%, or the 3-month average more than 10% above its longer average (non-seasonal). A smaller increase is still shown, not flagged.');
    const range = category.range;
    const band = category.band;
    const unusualAvailable = !!band || (range?.compared >= 5);
    const unusualParts = [];
    if (range) {
      unusualParts.push(`Latest month ${range.month}: ${money(range.latest)}.`);
      if (Number.isFinite(range.priorMedian)) unusualParts.push(`Prior-month median ${money(range.priorMedian)}; difference ${difference(range.latest, range.priorMedian)}.`);
      if (Number.isFinite(range.spikeThreshold)) unusualParts.push(`Prior ${range.compared}-month 95th-percentile threshold ${money(range.spikeThreshold)}.`);
    }
    if (band) unusualParts.push(`Prior-history band ${money(band.lower)} to ${money(band.upper)}; latest ${difference(band.latest, band.center)} versus its mean ${money(band.center)}.`);
    if (!unusualAvailable) unusualParts.push(`Only ${range?.compared || 0} prior months available; at least 5 are needed for a spike test (6 months total), or 7 total for a volatility band.`);
    const unusual = reading('c', unusualAvailable, unusualAvailable ? (category.signals.includes('c') ? 'Unusually high' : 'No high-month warning') : 'Insufficient history',
      unusualParts.join(' '),
      'Warning: latest month above the prior-month 95th percentile and at least $25 above the prior median, or above the prior mean + 2 standard deviations. Large one-off purchases are excluded from these behavioral signals.');
    return [benchmark, trend, unusual];
  }

  function signalTransactions(category) {
    const { esc, money } = format();
    const rows = category.transactions || [];
    if (!rows.length) return '<p class="pro-footnote">No counted transactions are available in this response. Refresh the panel to load its transaction drill-down.</p>';
    const months = new Map();
    for (const row of rows) {
      const month = row.date.slice(0, 7);
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(row);
    }
    return `<details class="money-transaction-branch"><summary>Expand transactions (${rows.length})</summary>
      <p class="pro-footnote">Recorded non-transfer debits in this category group and the analyzed completed months. Month totals marked counted match the behavioral signal series; qualifying one-offs appear separately as excluded. Short/long averages use the windows described above. Select a payment to open its transaction.</p>
      ${[...months].map(([month, items]) => {
        const total = items.filter(row => !row.excludedFromSignals).reduce((sum, row) => sum + row.amount, 0);
        const excluded = items.filter(row => row.excludedFromSignals).reduce((sum, row) => sum + row.amount, 0);
        return `<details class="money-transaction-month"><summary>${esc(month)} &#183; ${esc(money(total))} counted &#183; ${items.length} payments${excluded ? ` &#183; ${esc(money(excluded))} one-offs excluded` : ''}</summary>
          <ul class="money-transaction-list">${items.map(row => `<li><div>${globalThis.transactionLink ? globalThis.transactionLink(row.id, row.description) : `<a href="#transactions/${encodeURIComponent(row.id)}">${esc(row.description)}</a>`}<small>${esc(row.date)} &#183; ${esc(row.category)} &#183; ${row.excludedFromSignals ? 'One-off: excluded from behavioral signals' : 'Counted in behavioral signals'}</small></div><strong>${esc(money(row.amount))}</strong></li>`).join('')}</ul></details>`;
      }).join('')}</details>`;
  }

  function signalNetwork(categories, signalNames, context = {}) {
    const { esc, money } = format();
    if (!categories.length) return '<p class="pro-empty">No category history available for this network.</p>';
    const ordered = [...categories].sort((a, b) => b.signals.length - a.signals.length || b.monthly - a.monthly);
    const evidence = ordered.map(category => signalEvidence(category, context));
    const height = Math.max(380, ordered.length * 72 + 60);
    const hubs = Object.entries(signalNames).map(([key, label], index) => ({ key, label,
      y: 65 + index * (height - 130) / 2, color: palette[index] }));
    const step = (height - 60) / ordered.length;
    const paths = [], nodes = [];
    ordered.forEach((category, index) => {
      const y = 30 + step * (index + 0.5);
      const color = category.signals.length >= 2 ? '#f49eb8' : category.signals.length ? '#f5bd79' : '#72c2ce';
      for (const reading of evidence[index]) {
        const hub = hubs.find(item => item.key === reading.key);
        if (!hub) continue;
        const warning = reading.status === 'warning';
        paths.push(`<path data-money-edge="${reading.key}" data-money-category="${index}" class="money-signal-edge is-${reading.status}" d="M 255 ${hub.y} C 370 ${hub.y},390 ${y},510 ${y}" stroke="${hub.color}" stroke-width="${warning ? 3 : 1}" fill="none" opacity="${warning ? '.9' : '.22'}"${reading.status === 'needs-history' ? ' stroke-dasharray="3 7"' : ''}><title>${esc(`${category.label}: ${signalNames[reading.key]} - ${reading.status}. ${reading.comparison}`)}</title></path>`);
      }
      const label = `${category.label}: ${money(category.monthly)}/mo, ${category.signals.length} warning signals. Select for baselines and deltas.`;
      nodes.push(`<g tabindex="0" role="button" data-money-choice="${index}" aria-label="${esc(label)}" aria-pressed="${index === 0}"><title>${esc(label)}</title><circle cx="520" cy="${y}" r="${9 + category.signals.length * 3}" fill="${color}"/><text x="545" y="${y - 2}" class="money-node-label">${esc(category.label.length > 35 ? `${category.label.slice(0, 32)}...` : category.label)}</text><text x="545" y="${y + 19}" class="money-node-value">${esc(money(category.monthly))}/mo &#183; ${category.signals.length} warning${category.signals.length === 1 ? '' : 's'}</text></g>`);
    });
    const hubMarkup = hubs.map(hub => {
      const readings = evidence.map(items => items.find(item => item.key === hub.key));
      const warnings = readings.filter(item => item.status === 'warning').length;
      const unavailable = readings.filter(item => item.status === 'needs-history').length;
      return `<g role="button" tabindex="0" data-money-branch="${hub.key}" aria-expanded="true" aria-label="Collapse ${esc(hub.label)} chain"><circle cx="240" cy="${hub.y}" r="15" fill="${hub.color}"/><text x="210" y="${hub.y - 5}" text-anchor="end" class="money-node-label">${esc(hub.label)}</text><text x="210" y="${hub.y + 16}" text-anchor="end" class="money-node-value">${warnings} flagged &#183; ${unavailable} unavailable</text></g>`;
    }).join('');
    const details = ordered.map((category, index) => `<section data-money-reading="${index}"${index ? ' hidden' : ''} aria-label="${esc(category.label)} comparison details">
      <h3>${esc(category.label)} <small>${esc(money(category.monthly))}/mo &#183; ${context.selectedRange ? 'selected-period' : 'latest 3-month'} average</small></h3>
      <button type="button" class="btn btn-secondary btn-compact" data-money-focus-category="${index}">Focus this category's chain</button>
      <div class="money-evidence-grid">${evidence[index].map(reading => `<article class="money-evidence is-${reading.status}"><span class="eyebrow">${esc(signalNames[reading.key])}</span><b>${esc(reading.value)}</b><span class="money-reading-status">${reading.key === 'a' && reading.status === 'needs-history' ? 'No comparable survey benchmark' : ({ warning: 'Warning threshold crossed', 'within-range': 'Evaluated - no warning', 'needs-history': 'Not enough comparable history' })[reading.status]}</span><p>${esc(reading.comparison)}</p><small>${esc(reading.rule)}</small></article>`).join('')}</div>
      ${signalTransactions(category)}</section>`).join('');
    return `<div data-money-explorer="signals"><details class="money-exact"><summary>Network guide</summary><p>Compared with ${esc(context.comparedWith || 'the household survey benchmark')}. ${context.monthsAnalyzed || ordered[0].series?.length || 0} completed months available. Short selected ranges can make trend and unusual-month tests unavailable; choose 12 or 24 months above to investigate.</p><p>Select a signal hub to collapse/expand its chain; Focus hides other chains. Bright links = warnings; muted = no warning; dotted = unavailable. Node size = warning count, not spending. Select a category for evidence, then expand its transactions. Reset restores hidden chains.</p></details>
      <div class="money-chain-controls" aria-label="Network chain controls">${hubs.map(hub => `<div><button type="button" data-money-branch="${hub.key}" aria-expanded="true">${esc(hub.label)}</button><button type="button" data-money-focus-branch="${hub.key}">Focus</button></div>`).join('')}<button type="button" data-money-reset>Expand all / reset focus</button></div>
      <p class="money-chain-status" role="status">All chains expanded.</p>
      <div class="money-network-wrap" role="region" aria-label="Category signal relationship network" tabindex="0"><svg class="money-network" viewBox="0 0 880 ${height}" role="group" aria-label="Connections show every category reading, not money transfers. Bright links are warnings, muted links are evaluated without warning, dotted links need history.">${paths.join('')}${hubMarkup}${nodes.join('')}</svg></div>
      <div class="money-choice-list" role="group" aria-label="Inspect a category">${ordered.map((category, index) => `<button type="button" data-money-choice="${index}" aria-pressed="${index === 0}">${esc(category.label)}</button>`).join('')}</div>
      <div class="money-reading" aria-live="polite">${details}</div></div>`;
  }

  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  function monthlyLandscape(history) {
    const { esc, money } = format();
    if (!history?.rows?.length || !history.months?.length) return '<p class="pro-empty">No monthly spending history available.</p>';
    const usual = values => {
      const baseline = median(values) || values.reduce((total, value) => total + value, 0) / values.length;
      return Math.round(baseline * 100) / 100;
    };
    const totals = history.months.map((_, index) => history.rows.reduce((total, row) => total + row.values[index], 0));
    const totalBase = usual(totals);
    const hot = totals.indexOf(Math.max(...totals)), cool = totals.indexOf(Math.min(...totals));
    const lanes = [{ label: 'All shown categories', values: totals }, ...history.rows];
    const width = Math.max(900, 260 + history.months.length * 66), left = 235, right = width - 35;
    const at = index => history.months.length === 1 ? (left + right) / 2 : left + (right - left) * index / (history.months.length - 1);
    const height = 50 + lanes.length * 92;
    const grid = history.months.map((month, index) => `<line x1="${at(index)}" x2="${at(index)}" y1="30" y2="${height}" stroke="#c3dbe5" opacity=".1"/><text x="${at(index)}" y="20" text-anchor="middle" class="money-node-value">${esc(month)}</text>`).join('');
    const terrain = lanes.map((row, rowIndex) => {
      const base = usual(row.values), y = 90 + rowIndex * 92;
      const scale = Math.max(...row.values.map(value => Math.abs(value - base)), base * 0.25, 1);
      const points = row.values.map((value, index) => [at(index), y - (value - base) / scale * 29]);
      const line = points.map(([x, py], index) => `${index ? 'L' : 'M'} ${x} ${py}`).join(' ');
      const area = `${line} L ${at(row.values.length - 1)} ${y} L ${at(0)} ${y} Z`;
      const title = `${row.label}; usual ${money(base)} per month${median(row.values) === 0 ? ' (mean used because median is zero)' : ' (median)'}`;
      const dots = points.map(([x, py], index) => {
        const delta = row.values[index] - base;
        const normal = base > 0 ? Math.abs(delta / base) <= 0.08 : delta === 0;
        const label = `${row.label}, ${history.months[index]}: ${money(row.values[index])}; usual ${money(base)}; difference ${difference(row.values[index], base)}`;
        return `<g role="button" tabindex="0" data-money-choice="${index}" aria-label="${esc(label)}" aria-pressed="${index === hot}"><title>${esc(label)}</title><circle cx="${x}" cy="${py}" r="12" fill="transparent"/><circle cx="${x}" cy="${py}" r="${rowIndex ? 4 : 6}" fill="${normal ? '#b7cbd4' : delta > 0 ? '#fb998c' : '#66d3d0'}"/></g>`;
      }).join('');
      return `<g class="money-terrain-lane"><title>${esc(title)}</title><defs><clipPath id="money-terrain-hot-${rowIndex}"><rect x="${left - 12}" y="${y - 35}" width="${width}" height="35"/></clipPath><clipPath id="money-terrain-cool-${rowIndex}"><rect x="${left - 12}" y="${y}" width="${width}" height="35"/></clipPath></defs>
        <text x="12" y="${y - 10}" class="money-node-label">${esc(row.label.length > 27 ? `${row.label.slice(0, 24)}...` : row.label)}</text>
        <text x="12" y="${y + 12}" class="money-node-value">Usual ${esc(money(base))}${median(row.values) === 0 ? ' (mean)' : ''}</text>
        ${row.fixed ? `<text x="12" y="${y + 31}" class="money-node-value">Fixed payments</text>` : ''}
        <line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="#b7cbd4" stroke-dasharray="4 5" opacity=".35"/>
        <path d="${area}" fill="#fb998c" opacity=".45" clip-path="url(#money-terrain-hot-${rowIndex})"/><path d="${area}" fill="#66d3d0" opacity=".4" clip-path="url(#money-terrain-cool-${rowIndex})"/>
        <path d="${line}" fill="none" stroke="#bfd3df" stroke-width="${rowIndex ? 1.5 : 2.5}"/>${dots}</g>`;
    }).join('');
    const details = history.months.map((month, index) => {
      const ranked = history.rows.map(row => ({ ...row, base: usual(row.values) }))
        .sort((a, b) => Math.abs(b.values[index] - b.base) - Math.abs(a.values[index] - a.base));
      return `<section data-money-reading="${index}"${index === hot ? '' : ' hidden'} aria-label="${esc(month)} spending details"><h3>${esc(month)} <small>${esc(money(totals[index]))} across displayed categories</small></h3>
        <p>Versus a usual total month of ${esc(money(totalBase))}: <b>${esc(difference(totals[index], totalBase))}</b>.</p>
        <ul class="money-month-drivers">${ranked.map(row => `<li><div><b>${esc(row.label)}</b><small>Usual ${esc(money(row.base))}${row.fixed ? ' &#183; fixed payments' : ''}</small></div><strong>${esc(money(row.values[index]))}<small>${esc(difference(row.values[index], row.base))}</small></strong></li>`).join('')}</ul></section>`;
    }).join('');
    return `<div data-money-explorer="months"><div class="money-season-headline"><div><span>Highest-spend month</span><b>${esc(history.months[hot])}</b><strong>${esc(money(totals[hot]))}</strong><small>${esc(difference(totals[hot], totalBase))} vs usual</small></div><div><span>Lowest-spend month</span><b>${esc(history.months[cool])}</b><strong>${esc(money(totals[cool]))}</strong><small>${esc(difference(totals[cool], totalBase))} vs usual</small></div></div>
      <details class="money-exact"><summary>Reading the landscape</summary><div class="money-terrain-guide">
        <ul><li><span class="money-terrain-key is-higher" aria-hidden="true"></span><b>Coral areas:</b> more spending than usual.</li><li><span class="money-terrain-key is-lower" aria-hidden="true"></span><b>Teal areas:</b> less spending than usual.</li><li><span class="money-terrain-key is-baseline" aria-hidden="true"></span><b>Dashed line:</b> the usual amount printed beside each category.</li></ul>
        <p>Select any dot or month below to see exact amounts and differences.</p>
        <p>Each category uses its own vertical scale. Compare changes within a row, not peak heights between rows. Low or zero spending may reflect missing imports, not savings. Rows labeled Fixed payments contain payments marked as fixed bills.</p>
        <p>Totals cover displayed categories only. Usual = median of selected months; when the median is zero, the mean is used instead. All recorded non-transfer payments count, including one-offs and fixed bills. Month comparisons describe recorded data, not a guarantee of complete statements.</p></div></details>
      <div class="money-terrain-wrap" role="region" aria-label="Monthly spending landscape; scroll horizontally for all months" tabindex="0"><svg class="money-terrain" viewBox="0 0 ${width} ${height}" style="min-width:${width}px" role="group" aria-label="Monthly category spending above and below each category's usual month. Points show exact amounts and comparisons.">${grid}${terrain}</svg></div>
      <div class="money-choice-list" role="group" aria-label="Inspect a spending month">${history.months.map((month, index) => `<button type="button" data-money-choice="${index}" aria-pressed="${index === hot}">${esc(month)}</button>`).join('')}</div>
      <div class="money-reading" aria-live="polite">${details}</div></div>`;
  }

  function selectReading(target) {
    const explorer = target.closest('[data-money-explorer]');
    if (!explorer) return;
    const choice = target.dataset.moneyChoice;
    if (explorer.dataset?.moneyFocusCategory !== undefined) {
      explorer.dataset.moneyFocusCategory = choice;
      updateChains(target);
    }
    explorer.querySelectorAll('[data-money-choice]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.moneyChoice === choice)));
    explorer.querySelectorAll('[data-money-reading]').forEach(node => { node.hidden = node.dataset.moneyReading !== choice; });
    explorer.querySelector('.money-reading')?.scrollIntoView?.({ block: 'nearest' });
  }
  function updateChains(target) {
    const explorer = target.closest('[data-money-explorer="signals"]');
    if (!explorer) return;
    let branches = explorer.dataset.moneyBranches ?? 'abc';
    if (target.hasAttribute('data-money-reset')) {
      branches = 'abc';
      delete explorer.dataset.moneyFocusCategory;
    } else if (target.dataset.moneyFocusBranch) {
      branches = target.dataset.moneyFocusBranch;
      delete explorer.dataset.moneyFocusCategory;
    } else if (target.dataset.moneyBranch) {
      const key = target.dataset.moneyBranch;
      branches = branches.includes(key) ? branches.replace(key, '') : `${branches}${key}`;
    } else if (target.dataset.moneyFocusCategory !== undefined) {
      explorer.dataset.moneyFocusCategory = target.dataset.moneyFocusCategory;
      branches = 'abc';
    }
    explorer.dataset.moneyBranches = branches;
    const focus = explorer.dataset.moneyFocusCategory;
    explorer.querySelectorAll('[data-money-edge]').forEach(edge => {
      edge.style.display = branches.includes(edge.dataset.moneyEdge) && (focus === undefined || focus === edge.dataset.moneyCategory) ? '' : 'none';
    });
    explorer.querySelectorAll('[data-money-branch]').forEach(button => {
      const expanded = branches.includes(button.dataset.moneyBranch);
      button.setAttribute('aria-expanded', String(expanded));
      if (button.tagName.toLowerCase() === 'g') button.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} signal chain`);
    });
    explorer.querySelectorAll('.money-network [data-money-choice]').forEach(node => {
      const visible = focus === undefined || node.dataset.moneyChoice === focus;
      node.style.display = visible ? '' : 'none';
    });
    explorer.querySelector('.money-chain-status').textContent = `${branches.length} of 3 signal chains expanded.${focus === undefined ? '' : ' Focused on one category; other category nodes are hidden.'} Use Expand all / reset focus to restore the full map.`;
  }
  globalThis.document?.addEventListener('click', event => {
    const chain = event.target?.closest?.('[data-money-branch], [data-money-focus-branch], [data-money-focus-category], [data-money-reset]');
    if (chain) { updateChains(chain); return; }
    const target = event.target?.closest?.('[data-money-choice]');
    if (target) selectReading(target);
  });
  globalThis.document?.addEventListener('keydown', event => {
    const chain = event.target?.closest?.('g[data-money-branch]');
    if (chain && ['Enter', ' '].includes(event.key)) { event.preventDefault(); updateChains(chain); return; }
    const target = event.target?.closest?.('g[data-money-choice]');
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectReading(target); }
  });

  globalThis.FinanceMoneyVisuals = { mosaic, signalNetwork, signalEvidence, monthlyLandscape };
})();
