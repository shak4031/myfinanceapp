/* Existing-data financial relationship map. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  let data = null, selected = 'household', focus = '', generation = 0;
  let showFlows = false;
  let view = 'overview';
  const collapsed = new Set(), hidden = new Set(), expanded = new Set(), openTransactions = new Set();
  const children = id => data.nodes.filter(node => node.branch === id && node.kind !== 'branch');
  const icons = {
    household: '<path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7"/>',
    income: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V3h8v4M3 12c6 4 12 4 18 0M12 11v6m-2-2 2 2 2-2"/>',
    spending: '<path d="M5 7h14l2 14H3L5 7ZM8 8V6a4 4 0 0 1 8 0v2M9 14h6m-3-3v6"/>',
    debt: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20M6 15h5m5 0h2"/>',
    cash: '<path d="m2 8 10-5 10 5H2Zm2 13h16M6 11v7m6-7v7m6-7v7"/>',
    savings: '<path d="M7 8c-5 0-5 10 0 10v3h3v-3h5v3h3v-5l3-2v-4h-3l-2-4-3 2H7ZM2 9 1 6m7 4h4"/><circle cx="16" cy="11" r=".7"/>',
    investments: '<path d="M3 21V3m0 18h19M7 17l5-6 4 2 5-9m-5 0h5v5"/>',
    retirement: '<path d="M4 20h16M6 20v-6h12v6M5 14h14M8 14V9h8v5M12 9V3m-4 3h8"/><circle cx="12" cy="6" r="3"/>',
    goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m12 12 9-9m-4 0h4v4"/>'
  };
  const icon = id => `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[id] || icons.household}</svg>`;
  const overviewLabels = {
    income: 'Money in', spending: 'Everyday spending', debt: 'Debt & payments', goals: 'Your goals',
    cash: 'Cash & other accounts', savings: 'Savings', investments: 'Investments', retirement: 'Retirement / 401(k)'
  };
  function monthlyPicture() {
    const income = data.nodes.find(node => node.id === 'income').amount;
    const spending = data.nodes.find(node => node.id === 'spending').amount;
    const debt = children('debt').filter(node => node.metric === 'monthly').reduce((sum, node) => sum + node.amount, 0);
    const out = data.period.months ? spending + debt : null;
    return { income, out, remainder: income == null || out == null ? null : Math.round((income - out) * 100) / 100 };
  }
  function overviewCard(id) {
    const branch = data.nodes.find(node => node.id === id);
    const items = children(id).filter(node => node.kind !== 'missing');
    let headline, caption;
    if (['income', 'spending'].includes(id)) {
      headline = branch.amount == null ? 'No history yet' : money(branch.amount);
      caption = 'per recorded month';
    } else if (id === 'debt') {
      headline = data.period.months
        ? money(items.filter(node => node.metric === 'monthly').reduce((sum, node) => sum + node.amount, 0))
        : 'No history yet';
      caption = 'payments per recorded month';
    } else if (id === 'goals') {
      headline = `${items.length} ${items.length === 1 ? 'goal' : 'goals'}`;
      caption = 'planning progress, not extra savings';
    } else {
      const accounts = items.filter(node => node.kind === 'account');
      const known = accounts.filter(node => node.amount != null);
      headline = known.length ? money(known.reduce((sum, node) => sum + node.amount, 0)) : 'Not available';
      caption = known.length ? `${known.length}/${accounts.length} known balances; dates vary` : 'No balance recorded';
    }
    // Keep a debt account visible even when activity groups outnumber accounts.
    const preview = id === 'debt'
      ? [...items.filter(node => node.metric === 'balance'), ...items.filter(node => node.metric !== 'balance')].slice(0, 2)
      : items.slice(0, 2);
    return `<article class="landscape-card" data-landscape-card="${id}" style="--branch-color:${branch.color}">
      <button class="landscape-card-heading" data-landscape-node="${id}" aria-pressed="${selected === id}">${icon(id)}<span>${overviewLabels[id]}</span><span class="landscape-card-open" aria-hidden="true">&#8599;</span></button>
      <p class="landscape-card-total">${esc(headline)}</p><p class="landscape-card-caption">${esc(caption)}</p>
      <ul class="landscape-card-items">${preview.length ? preview.map(node => `<li><button data-landscape-node="${esc(node.id)}" aria-pressed="${selected === node.id}"><span class="landscape-item-name">${esc(node.label)}</span><span class="landscape-item-value">${esc(value(node))}</span></button></li>`).join('')
        : `<li class="landscape-card-empty">${esc(children(id).find(node => node.kind === 'missing')?.label || 'No records yet')}</li>`}</ul>
      <button class="landscape-card-more" data-landscape-node="${id}">${items.length ? `View all ${items.length} ${items.length === 1 ? 'item' : 'items'}` : 'Review coverage'} <span aria-hidden="true">&rarr;</span></button>
    </article>`;
  }
  function overview() {
    const picture = monthlyPicture();
    const figure = amount => amount == null ? 'Not available' : money(amount);
    const gaps = data.nodes.filter(node => node.kind === 'missing').length;
    const missingBalances = data.nodes.filter(node => node.kind === 'account' && node.amount == null).length;
    const root = $('landscape-root');
    root.innerHTML = `<div class="landscape-overview-toolbar"><p><b>Your whole picture, one place.</b> Select any item to see its source and connections.</p><div class="landscape-toolbar"><button data-landscape-action="map">Detailed map</button><button data-landscape-action="reload">Refresh</button></div></div>
      <div class="landscape-one-view" role="region" aria-label="Household financial picture">
        <div class="landscape-row-label"><span>MONTHLY ACTIVITY &amp; PLANS</span><span>${esc(data.period.from)} &ndash; ${esc(data.period.to)} &middot; ${data.period.months}/3 months recorded</span></div>
        <div class="landscape-card-grid landscape-card-grid-top">${['income', 'spending', 'debt', 'goals'].map(overviewCard).join('')}</div>
        <div class="landscape-household">
          <div class="landscape-household-title">${icon('household')}<div><h2>Your household</h2><p>Recorded monthly cash flow</p></div></div>
          <dl class="landscape-cashflow"><div><dt>Money in</dt><dd data-landscape-total="income">${esc(figure(picture.income))}</dd></div><span aria-hidden="true">&minus;</span><div><dt>Spending + debt payments</dt><dd data-landscape-total="out">${esc(figure(picture.out))}</dd></div><span aria-hidden="true">=</span><div><dt>Recorded remainder</dt><dd data-landscape-total="remainder">${esc(figure(picture.remainder))}</dd></div></dl>
          <p class="landscape-remainder-note">Per recorded month. Remainder is not available cash or confirmed savings; missing imports can change it. Transfers excluded.</p>
        </div>
        <div class="landscape-card-grid landscape-card-grid-bottom">${['cash', 'savings', 'investments', 'retirement'].map(overviewCard).join('')}</div>
        <div class="landscape-row-label"><span>ACCOUNTS &amp; BALANCES</span><span>Saved balances, not monthly flows &middot; select an account for its as-of date</span></div>
      </div>
      <p class="landscape-overview-note">Lines group your household information; they do not represent transfers. ${gaps} ${gaps === 1 ? 'section has' : 'sections have'} no records. ${missingBalances} ${missingBalances === 1 ? 'account is' : 'accounts are'} missing a balance. No net worth is calculated.</p>
      <aside id="landscape-detail" class="landscape-detail" aria-label="Selected financial details" aria-live="polite" tabindex="-1"${selected === 'household' ? ' hidden' : ''}>${selected === 'household' ? '' : inspector()}</aside>
      ${coverageNotes()}`;
    root.onclick = async event => {
      const button = event.target.closest('[data-landscape-node], [data-landscape-action]');
      if (!button) return;
      if (button.dataset.landscapeAction === 'reload') { await loadPage(); return; }
      if (button.dataset.landscapeAction === 'map') { view = 'map'; reveal(selected); render(false); return; }
      if (button.dataset.landscapeNode) {
        selected = button.dataset.landscapeNode;
        const detail = $('landscape-detail');
        detail.innerHTML = inspector();
        detail.hidden = false;
        root.querySelectorAll('[data-landscape-node]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.landscapeNode === selected)));
        detail.focus({ preventScroll: true });
        detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
    root.onkeydown = null;
  }
  function coverageNotes() {
    return `<details class="landscape-coverage"><summary>Coverage and calculation notes</summary><p>${esc(data.note)}</p><ul><li>${data.coverage.unassignedActivity} activity records have no verified account connection.</li><li>${data.coverage.unknownTransfers} transfers in the period await classification and are excluded from spending/income.</li><li>${data.coverage.pendingExcluded} pending records are excluded.</li><li>${data.coverage.reviewAccounts} accounts need review and are not mapped as confirmed assets.</li></ul><p>Account subtotals include only known account balances within that section; missing balances are not zero and balance dates can differ. Cash / other accounts can include unspecified account types, not confirmed cash. Debt balances and monthly debt payments are separate measures. Unlinked debt-plan records may overlap accounts and are not added into a balance total. Goal progress is not added to savings. Money in includes refunds and one-off credits, not just salary. Investment holdings, returns and employer retirement contributions are not provided by this view.</p></details>`;
  }
  const illustrations = {
    household: '<path fill="#f3b84b" d="m5 30 27-23 27 23-5 5-22-18-22 18Z"/><path fill="#74bccc" d="M13 31v27h38V31L32 16Z"/><path fill="#fff3d4" d="M27 39h11v19H27ZM18 33h8v9h-8Zm22 0h7v9h-7Z"/><path fill="#df785f" d="M45 10h7v17l-7-6Z"/>',
    income: '<rect x="7" y="24" width="50" height="31" rx="6" fill="#42977e"/><path fill="#f3c35b" d="M23 24v-8h18v8h-5v-4h-8v4Z"/><path fill="#73c9a2" d="M7 29h50v10c-17 8-33 8-50 0Z"/><rect x="28" y="36" width="9" height="11" rx="2" fill="#ffe5a0"/><path fill="#f4b451" d="m32 4 9 10h-6v10h-6V14h-6Z"/>',
    spending: '<path fill="#ed8196" d="M13 21h34l6 36H7Z"/><path d="M22 24V15a9 9 0 0 1 18 0v9" fill="none" stroke="#a64363" stroke-width="5"/><path fill="#f8c46b" d="M41 32h15l4 25H37Z"/><path d="M44 34v-6a5 5 0 0 1 10 0v6" fill="none" stroke="#b48136" stroke-width="3"/><path fill="#fff0eb" d="m25 32 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z"/>',
    debt: '<rect x="5" y="13" width="48" height="34" rx="6" fill="#5978b4" transform="rotate(-8 29 30)"/><rect x="12" y="23" width="48" height="32" rx="6" fill="#eea565"/><path fill="#b85d45" d="M12 30h48v7H12Z"/><rect x="18" y="42" width="10" height="7" rx="2" fill="#ffe1a3"/><path d="M44 43h10m-10 5h6" stroke="#fff4e7" stroke-width="3" stroke-linecap="round"/>',
    cash: '<path fill="#6ba6d0" d="m4 20 28-14 28 14v7H4Z"/><path fill="#a5d6e8" d="M9 29h8v22H9Zm19 0h8v22h-8Zm19 0h8v22h-8Z"/><path fill="#4076a3" d="M5 51h54v7H5Z"/><circle cx="32" cy="18" r="6" fill="#ffe0a2"/><path d="M32 14v8m-2-6h3m-3 4h3" stroke="#b88d3f" stroke-width="1.5"/>',
    savings: '<path fill="#ef97a9" d="M15 22c8-8 29-8 37 4l8 3v15l-9 3-4 10h-8v-9H25v9h-8l-3-11C1 40 4 27 15 22Z"/><path fill="#dd708e" d="m39 22 5-13 9 16Z"/><circle cx="48" cy="31" r="2" fill="#563c59"/><path d="M5 29C-3 29 2 17 7 23m18 0h12" fill="none" stroke="#bc5673" stroke-width="3" stroke-linecap="round"/><circle cx="30" cy="9" r="8" fill="#f3c154"/><path d="M30 4v10m-3-8h5m-5 6h5" stroke="#fff3b8" stroke-width="2"/>',
    investments: '<path fill="#9a83cb" d="M8 37h10v20H8Zm18-12h10v32H26Zm18-14h10v46H44Z"/><path d="m6 29 17-11 10 2L55 4m-11 0h11v11" fill="none" stroke="#4aa88c" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 59h54" stroke="#65538e" stroke-width="3" stroke-linecap="round"/>',
    retirement: '<path fill="#af814f" d="M28 29h8v29h-8Z"/><path fill="#63a487" d="M15 25C3 19 14 4 27 10c6-11 23-4 22 6 16 6 8 25-4 22-7 12-24 8-24-2-8 1-13-5-6-11Z"/><path fill="#f3c662" d="M10 52h15v6H10Zm2-7h11v5H12Zm29 6h14v7H41Zm2-6h10v5H43Z"/><path d="M32 43V23m0 12-9-8m9 2 8-8" stroke="#3b7c63" stroke-width="2.5" fill="none"/>',
    goals: '<path fill="#76b7bf" d="M9 6h5v52H9Z"/><path fill="#ed8a70" d="M14 7h39L43 19l10 12H14Z"/><circle cx="34" cy="19" r="8" fill="#ffdf91"/><circle cx="34" cy="19" r="4" fill="#e88065"/><path fill="#619697" d="M4 57h24v4H4Z"/><path fill="#f5c659" d="m49 39 3 6 7 1-5 4 1 7-6-3-6 3 1-7-5-4 7-1Z"/>'
  };
  const illustration = id => `<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">${illustrations[id] || illustrations.household}</svg>`;
  const nodeRadius = node => {
    if (node.kind === 'household') return 72;
    if (node.kind === 'branch') return 60;
    if (node.amount == null || node.kind === 'missing') return 22;
    const peers = children(node.branch).filter(item => item.metric === node.metric && item.amount != null);
    const largest = Math.max(0, ...peers.map(item => Math.abs(item.amount)));
    return Math.sqrt(22 ** 2 + (largest ? (40 ** 2 - 22 ** 2) * Math.abs(node.amount) / largest : 0));
  };
  function reveal(id) {
    const node = data.nodes.find(item => item.id === id);
    if (node?.branch) {
      hidden.delete(node.branch);
      collapsed.delete(node.branch);
      if (focus && focus !== node.branch) focus = node.branch;
      if (node.kind !== 'branch' && children(node.branch).findIndex(item => item.id === id) >= 3) expanded.add(node.branch);
    }
  }
  const value = node => node.amount == null ? node.kind === 'missing' ? 'Coverage missing' : node.metric === 'monthly' ? 'No completed history' : node.kind === 'branch' ? `${node.count} connections` : 'Balance unavailable'
    : `${money(node.amount)}${node.metric === 'monthly' ? '/mo' : node.metric === 'goal-progress' ? ' tracked' : ' balance'}`;
  const color = node => data.nodes.find(branch => branch.id === node.branch)?.color || '#275e73';
  const labelLines = label => {
    const words = String(label).split(/\s+/), lines = [''];
    for (const token of words) {
      const word = token.length > 21 ? `${token.slice(0, 18)}...` : token;
      if ((lines.at(-1) + ' ' + word).trim().length > 21 && lines.at(-1)) lines.push(word);
      else lines[lines.length - 1] = (lines.at(-1) + ' ' + word).trim();
    }
    return lines.length > 2 ? [lines[0], `${lines[1].slice(0, 18)}...`] : lines;
  };
  function fitLabels() {
    $('landscape-map').querySelectorAll('.landscape-reading text, .landscape-transaction-value').forEach(text => {
      const compact = text.closest('.is-offshoot');
      const limit = text.classList.contains('landscape-transaction-value') ? 60 : compact ? 132 : 156;
      if (text.getComputedTextLength() > limit) {
        text.setAttribute('textLength', limit);
        text.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      }
    });
  }
  function bindPanning() {
    const map = $('landscape-map');
    let drag = null, suppressClick = false;
    map.onpointerdown = event => {
      suppressClick = false;
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moving: false };
    };
    map.onpointermove = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (event.buttons === 0) { finish(event); return; }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moving && Math.hypot(dx, dy) < 5) return;
      if (!drag.moving) {
        drag.moving = true;
        suppressClick = true;
        map.setPointerCapture(event.pointerId);
        map.classList.add('is-panning');
      }
      event.preventDefault();
      map.scrollBy(-dx, -dy);
      drag.x = event.clientX; drag.y = event.clientY;
    };
    const finish = event => {
      if (!drag || drag.id !== event.pointerId) return;
      drag = null;
      map.classList.remove('is-panning');
      if (map.hasPointerCapture(event.pointerId)) map.releasePointerCapture(event.pointerId);
    };
    map.onpointerup = finish;
    map.onpointercancel = finish;
    map.onlostpointercapture = finish;
    map.ondragstart = event => event.preventDefault();
    map.addEventListener('click', event => {
      if (!suppressClick || event.detail === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = false;
    }, true);
  }
  function scene() {
    const branches = data.nodes.filter(node => node.kind === 'branch');
    const positions = new Map(), visible = new Set(['household']);
    const txEdges = [], txNodes = [];
    const layers = [
      { label: 'LONGER-TERM PLANS', ids: ['goals', 'retirement', 'investments'] },
      { label: 'SPENDING, DEBT & SAVINGS', ids: ['spending', 'debt', 'savings'] },
      { label: 'ACCOUNTS · CASH & EVERYDAY BANKING', ids: ['cash'] },
      { label: 'INCOME · WHERE MONEY ENTERS', ids: ['income'] }
    ];
    const gap = 35;
    const activeBranches = layer => layer.ids.map(id => branches.find(branch => branch.id === id))
      .filter(branch => branch && !hidden.has(branch.id) && (!focus || focus === branch.id));
    const itemsFor = branch => collapsed.has(branch.id) ? [] : children(branch.id).slice(0, expanded.has(branch.id) || focus ? undefined : 3);
    const itemWidth = node => openTransactions.has(node.id) && node.transactions?.length ? 350 : 190;
    const widthFor = branch => Math.max(650, itemsFor(branch).reduce((sum, node) => sum + itemWidth(node), 40));
    const sceneWidth = Math.max(1240, ...layers.map(layer => {
      const active = activeBranches(layer);
      return active.reduce((sum, branch) => sum + widthFor(branch), 0) + Math.max(0, active.length - 1) * gap;
    }));
    const blocks = [], routes = [];
    positions.set('household', { x: sceneWidth / 2, y: 70 });
    let layerY = 230;
    for (const layer of layers) {
      const active = activeBranches(layer);
      if (!active.length) continue;
      const spare = (sceneWidth - active.reduce((sum, branch) => sum + widthFor(branch), 0) - (active.length - 1) * gap) / active.length;
      let blockX = 0;
      let layerHeight = 0;
      active.forEach(branch => {
        const width = widthFor(branch) + spare;
        const x = blockX, center = x + width / 2;
        blockX += width + gap;
        visible.add(branch.id);
        positions.set(branch.id, { x: center, y: layerY + 100 });
        const list = itemsFor(branch);
        const extra = list.length ? (width - 40 - list.reduce((sum, node) => sum + itemWidth(node), 0)) / list.length : 0;
        let itemLeft = x + 20;
        const rowY = layerY + 315;
        let rowHeight = 0;
        list.forEach(node => {
          const cellWidth = itemWidth(node) + extra;
          const itemX = itemLeft + cellWidth / 2;
          itemLeft += cellWidth;
          visible.add(node.id);
          positions.set(node.id, { x: itemX, y: rowY });
          const transactions = openTransactions.has(node.id) ? node.transactions || [] : [];
          transactions.forEach((tx, index) => {
            const id = `transaction-${node.id}-${tx.id}`;
            txNodes.push({ id, kind: 'transaction', branch: branch.id, label: tx.label,
              amount: tx.amount, metric: 'transaction', date: tx.date, href: `#transactions/${tx.id}` });
            visible.add(id);
            positions.set(id, { x: itemX + (index % 3 - 1) * 100, y: rowY + 160 + Math.floor(index / 3) * 75 });
            txEdges.push({ source: node.id, target: id, kind: 'structure' });
          });
          rowHeight = Math.max(rowHeight, 200 + Math.ceil(transactions.length / 3) * 75);
        });
        const height = list.length ? rowY + rowHeight - layerY - 55 : 235;
        blocks.push({ id: branch.id, x, y: layerY, w: width, h: height, color: branch.color });
        layerHeight = Math.max(layerHeight, height);
      });
      routes.push(`<text class="landscape-layer-label" x="${sceneWidth / 2}" y="${layerY - 24}">${layer.label}</text>`);
      layerY += layerHeight + 130;
    }
    const allNodes = [...data.nodes, ...txNodes];
    const backbone = [
      ['income', 'cash'], ['cash', 'spending'], ['cash', 'debt'], ['cash', 'savings'],
      ['savings', 'goals'], ['savings', 'retirement'], ['savings', 'investments']
    ].filter(([source, target]) => visible.has(source) && visible.has(target));
    for (const [source, target] of backbone) {
      const a = blocks.find(block => block.id === source), b = blocks.find(block => block.id === target);
      routes.push(`<path class="landscape-route" data-landscape-route="${source}-${target}" d="M ${a.x + a.w / 2} ${a.y} C ${a.x + a.w / 2} ${a.y - 60} ${b.x + b.w / 2} ${b.y + b.h + 60} ${b.x + b.w / 2} ${b.y + b.h}" marker-end="url(#landscape-arrow)"><title>${source} to ${target}: organizational pathway, not a measured transfer</title></path>`);
    }
    const connections = [...data.edges, ...txEdges].filter(edge => edge.source !== 'household'
      && visible.has(edge.source) && visible.has(edge.target) && (edge.kind === 'structure' || showFlows));
    const paths = connections.map(edge => {
      const a = positions.get(edge.source), b = positions.get(edge.target);
      const source = allNodes.find(node => node.id === edge.source);
      const target = allNodes.find(node => node.id === edge.target);
      const related = selected === 'household' || edge.source === selected || edge.target === selected;
      const title = edge.kind === 'structure' ? `${source.label} — ${target.label}: grouped relationship`
        : `${source.label} → ${target.label}: ${money(edge.amount)}/mo recorded ${edge.kind === 'transfer' ? 'transfer' : 'activity'}`;
      const cx = a.x, cy = (a.y + b.y) / 2;
      return `<path class="landscape-edge is-${edge.kind}${source.kind === 'household' ? ' is-trunk' : ''}${target.kind === 'missing' ? ' is-missing' : ''}${related ? '' : ' is-dim'}" data-landscape-source="${esc(edge.source)}" data-landscape-target="${esc(edge.target)}" d="M ${a.x} ${a.y} C ${cx} ${cy} ${(cx + b.x) / 2} ${(cy + b.y) / 2} ${b.x} ${b.y}" stroke="${color(target.kind === 'branch' ? target : target.branch ? target : source)}"${edge.kind === 'structure' ? '' : ' marker-end="url(#landscape-arrow)"'}><title>${esc(title)}</title></path>`;
    }).join('');
    const visibleNodes = allNodes.filter(node => visible.has(node.id));
    const controls = [];
    const nodes = visibleNodes.map(node => {
      const p = positions.get(node.id), hub = node.kind === 'branch', home = node.kind === 'household';
      const transaction = node.kind === 'transaction';
      const offshoot = !home && !hub;
      const radius = transaction ? 36 : offshoot ? 58 : 70;
      const illustrationSize = home ? 60 : hub ? 52 : nodeRadius(node) * 1.1;
      const label = home ? ['Your household'] : labelLines(node.label);
      const total = hub ? children(node.id).length : 0;
      const expansion = hub ? [
        { action: 'collapse', text: collapsed.has(node.id) ? `+ Expand (${total})` : '− Fold block', open: !collapsed.has(node.id) },
        ...(total > 3 && !collapsed.has(node.id) ? [{ action: 'fan', text: expanded.has(node.id) || focus ? '− Show fewer' : `+${total - 3} more`, open: expanded.has(node.id) || !!focus }] : [])
      ] : node.transactions?.length ? [{ action: 'transactions', text: `${openTransactions.has(node.id) ? '− Hide payments' : '+ Payments'} (${node.transactions.length}${node.count > node.transactions.length ? `/${node.count}` : ''})`, open: openTransactions.has(node.id) }] : [];
      const controlWidth = 160;
      expansion.forEach((control, index) => controls.push(`<g class="landscape-expander is-compact" transform="translate(${p.x} ${p.y + 69 + index * 34})" role="button" tabindex="0" data-landscape-action="${control.action}" data-branch="${esc(hub ? node.id : node.branch)}" data-item="${esc(node.id)}" aria-expanded="${control.open}" aria-label="${esc(`${control.text}: ${node.label}`)}"><rect x="${-controlWidth / 2}" y="0" width="${controlWidth}" height="32" rx="16"/><text y="21">${esc(control.text)}</text></g>`));
      const content = transaction
        ? `<circle r="${radius}" class="landscape-hit-area"/><text y="-3" class="landscape-transaction-value">${esc(money(node.amount))}</text><text y="18" class="landscape-transaction-date">${esc(node.date.slice(5))}</text>`
        : `<g class="landscape-illustration" transform="translate(${-illustrationSize / 2} -48) scale(${illustrationSize / 64})">${illustration(home ? 'household' : node.branch)}</g>
          <g class="landscape-reading">${label.map((line, i) => `<text y="${22 + i * 16}" class="landscape-label">${esc(line)}</text>`).join('')}
          ${home ? '' : `<text y="${28 + label.length * 16}" class="landscape-value">${esc(value(node))}</text>`}</g>`;
      return transaction
        ? `<a class="landscape-node is-transaction" transform="translate(${p.x} ${p.y})" href="${node.href}" aria-label="${esc(`${node.label}. ${node.date}. ${money(node.amount)}`)}"><title>${esc(node.label)} · ${esc(node.date)} · ${esc(money(node.amount))}</title>${content}</a>`
        : `<g class="landscape-node${offshoot ? ' is-offshoot' : ''}${node.kind === 'missing' ? ' is-missing' : ''}${selected === node.id ? ' is-selected' : ''}" transform="translate(${p.x} ${p.y})" role="button" tabindex="0" data-landscape-node="${esc(node.id)}" data-landscape-radius="${nodeRadius(node)}" data-landscape-icon="${home ? 'household' : node.branch}"${hub ? ` data-landscape-leg="${node.id}"` : ''} aria-label="${esc(`${node.label}. ${home ? 'Select a branch to explore.' : value(node)}`)}" aria-pressed="${selected === node.id}"><title>${esc(node.label)}${home ? '' : `: ${esc(value(node))}`}</title><circle r="${radius + 7}" class="landscape-halo"/>${content}</g>`;
    }).join('');
    const sceneHeight = layerY - 100;
    const containers = blocks.map(block => `<rect class="landscape-block" data-landscape-block="${block.id}" x="${block.x}" y="${block.y}" width="${block.w}" height="${block.h}" rx="22" fill="${block.color}" stroke="${block.color}"/>`).join('');
    return `<svg id="landscape-svg" width="${sceneWidth}" height="${sceneHeight}" viewBox="-25 -10 ${sceneWidth + 50} ${sceneHeight}" style="width:${sceneWidth}px" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Financial landscape. Read from bottom to top: Income, Accounts, Spending debt and savings, then Longer-term plans. Each block contains its recorded items."><defs><marker id="landscape-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#6b8795"/></marker></defs>${routes.join('')}${containers}${paths}${nodes}${controls.join('')}</svg>`;
  }
  function inspector() {
    const node = data.nodes.find(item => item.id === selected) || data.nodes[0];
    const related = data.edges.filter(edge => edge.kind !== 'structure' && (edge.source === node.id || edge.target === node.id));
    const list = node.kind === 'branch' ? children(node.id) : [];
    return `<h2>${esc(node.label)}</h2>${node.kind === 'household' ? '<p>Select an account, category or branch to explore your connections.</p>' : `<p class="landscape-detail-value">${esc(value(node))}</p>`}
      ${node.note ? `<p>${esc(node.note)}</p>` : ''}
      ${node.source ? `<p class="muted">${esc(node.source)}${node.asOf ? ` · as of ${esc(node.asOf.slice(0, 10))}` : ''}</p>` : ''}
      ${node.metric === 'balance' && node.asOf && Date.now() - Date.parse(node.asOf) > 45 * 86400000 ? '<p class="landscape-warning">This balance is over 45 days old. Update the account before relying on it.</p>' : ''}
      ${node.minimum != null ? `<p>Saved minimum payment: ${esc(money(node.minimum))}/mo</p>` : ''}
      ${node.target != null ? `<p>Goal target: ${esc(money(node.target))}</p>` : ''}
      ${(node.debts || []).map(debt => `<p>Linked debt plan: <b>${esc(debt.label)}</b> · ${debt.balance == null ? 'balance unavailable' : esc(money(debt.balance))}. Saved plan balance, as-of date unavailable; not an additional debt account.</p>`).join('')}
      ${node.kind === 'branch' ? `${view === 'map' ? `<div class="landscape-actions"><button data-landscape-action="focus" data-branch="${node.id}">Focus this branch</button><button data-landscape-action="collapse" data-branch="${node.id}">${collapsed.has(node.id) ? 'Expand' : 'Collapse'} branch</button></div>` : ''}<h3>${node.count ? `All ${node.count} recorded connections` : 'Coverage gap'}</h3><ul class="landscape-detail-list">${list.map(item => `<li><button data-landscape-node="${esc(item.id)}"><b>${esc(item.label)}</b><span>${esc(value(item))}</span></button></li>`).join('')}</ul>` : ''}
      ${related.length ? `<h3>Recorded connections</h3><ul class="landscape-detail-list">${related.map(edge => {
        const outgoing = edge.source === node.id;
        const other = data.nodes.find(n => n.id === (outgoing ? edge.target : edge.source));
        return `<li><button data-landscape-node="${esc(other.id)}">${outgoing ? 'To' : 'From'} ${esc(other.label)}<span>${esc(money(edge.amount))}/mo · ${edge.kind === 'transfer' ? 'transfer, not spending' : 'recorded activity'}</span></button></li>`;
      }).join('')}</ul>` : ''}
      ${node.transactions?.length ? `<h3>Recent recorded transactions</h3><p>${node.count} transactions in the comparison period. Showing the latest ${node.transactions.length}.</p><ul class="landscape-detail-list">${node.transactions.map(tx => `<li><a href="#transactions/${tx.id}" class="transaction-link">${esc(tx.label)}</a><span>${esc(tx.date)} · ${esc(money(tx.amount))}</span></li>`).join('')}</ul>` : ''}
      ${node.href ? `<a class="btn btn-secondary" href="${node.href}">Open ${node.href === '#accounts' ? 'Accounts' : node.href === '#goals' ? 'Goals' : 'Debt-free plan'}</a>` : ''}`;
  }
  function render(preserveViewport = true) {
    const root = $('landscape-root');
    if (!root || !data) return;
    if (view === 'overview') { overview(); return; }
    const previousMap = $('landscape-map');
    const viewport = preserveViewport && previousMap ? { left: previousMap.scrollLeft, top: previousMap.scrollTop } : null;
    const branches = data.nodes.filter(node => node.kind === 'branch');
    root.innerHTML = `<div class="landscape-period"><span>${esc(data.period.from)} &ndash; ${esc(data.period.to)}</span><span>${data.period.months}/3 months recorded</span><details class="landscape-help"><summary>Map guide</summary><p>Read from south to north: Income at the bottom, cash and everyday banking Accounts above it, then Spending, Debt and Savings, and Longer-term plans at the top. Each tinted block contains its own recorded items. Savings, investment, retirement and debt accounts stay in their labeled destination blocks. Scroll upward through the layers or drag the map with the left mouse button. Expand more items or fold a block using its controls. Select an item for details or reveal its recorded payments. Explore isolates a block; Show full landscape restores all layers.</p><p>Illustration size reflects the absolute amount relative to the largest item with the same measure in that block. Balances, monthly flows and goal progress use separate scales. Missing amounts remain unavailable, never zero. This is not a financial-health score or share of net worth. Block sizes are not comparable.</p><p>Dashed upward arrows describe the organization of the landscape, not verified transfers or a required account route. Optional Recorded flow arrows show only verified activity and may cross layers. Details retain those connections. Balances have their own as-of dates; missing coverage is not zero. Payment lists show up to the latest 20 records supplied for each item; the payment control shows displayed and total counts when they differ.</p></details></div>
      <p class="landscape-direction">Read bottom to top: Income &uarr; Accounts &uarr; Spending, debt &amp; savings &uarr; Longer-term plans. Each wide block keeps its items in one row; scroll sideways as it expands. Dashed arrows show organization, not measured transfers.</p>
      <div class="landscape-branch-controls" role="group" aria-label="Show or hide financial sections">${branches.map(branch => `<button type="button" class="landscape-section-toggle${hidden.has(branch.id) ? ' is-hidden' : ''}" style="--branch-color:${branch.color}" data-landscape-action="toggle-leg" data-branch="${branch.id}" aria-pressed="${!hidden.has(branch.id)}" aria-label="Show ${esc(branch.label)} section">${icon(branch.id)}<span><b>${esc(branch.label)}</b><small>${hidden.has(branch.id) ? 'Hidden' : `${branch.count} ${branch.count === 1 ? 'item' : 'items'}`}</small></span><span class="landscape-toggle-mark" aria-hidden="true">${hidden.has(branch.id) ? '+' : '&#10003;'}</span></button>`).join('')}</div>
      <div class="landscape-toolbar" role="group" aria-label="Map controls"><button data-landscape-action="overview">Back to overview</button><label class="landscape-explore">Explore <select id="landscape-explore" aria-label="Explore a financial section"><option value="">All sections</option>${branches.map(branch => `<option value="${branch.id}"${focus === branch.id ? ' selected' : ''}>${esc(branch.label)}</option>`).join('')}</select></label><button data-landscape-action="reset">Show full landscape</button><button data-landscape-action="reload" aria-label="Refresh landscape data">Refresh</button><details class="landscape-view-options"><summary>View options</summary>
      <div class="landscape-toolbar"><button data-landscape-action="expand">Expand all branches</button><button data-landscape-action="collapse-all">Collapse all branches</button><button data-landscape-action="flows" aria-pressed="${showFlows}">Recorded flow arrows</button></div></details></div>
      <div class="landscape-workspace"><div id="landscape-map" class="landscape-map" role="region" tabindex="0" aria-label="Bottom-to-top financial landscape. Scroll upward from Income to explore the layers.">${scene()}</div><aside id="landscape-detail" class="landscape-detail" aria-label="Selected financial details" aria-live="polite">${inspector()}</aside></div>
      <details class="landscape-coverage"><summary>Coverage and calculation notes</summary><p>${esc(data.note)}</p><ul><li>${data.coverage.unassignedActivity} activity records have no verified account connection.</li><li>${data.coverage.unknownTransfers} transfers in the period await classification and are excluded from spending/income.</li><li>${data.coverage.pendingExcluded} pending records are excluded from this map.</li><li>${data.coverage.reviewAccounts} accounts need review and are not mapped as confirmed assets.</li></ul><p>Unlinked debt-plan records may overlap accounts. Goal progress is not added to savings. Investment holdings, returns and employer retirement contributions are not provided by this view.</p></details>`;
    fitLabels();
    bindPanning();
    const map = $('landscape-map');
    map.scrollLeft = viewport ? viewport.left : Math.max(0, (map.scrollWidth - map.clientWidth) / 2);
    map.scrollTop = viewport ? viewport.top : map.scrollHeight - map.clientHeight;
    $('landscape-explore').onchange = event => {
      const branch = event.target.value;
      focus = branch; selected = branch || 'household';
      if (branch) { hidden.delete(branch); collapsed.delete(branch); expanded.add(branch); }
      render(false);
      $('landscape-explore').focus({ preventScroll: true });
    };
    root.onclick = async event => {
      const button = event.target.closest('[data-landscape-node], [data-landscape-action]');
      if (!button) return;
      if (button.dataset.landscapeNode) {
        selected = button.dataset.landscapeNode;
        const node = data.nodes.find(item => item.id === selected);
        const needsReveal = node?.branch && (hidden.has(node.branch) || collapsed.has(node.branch) || (focus && focus !== node.branch)
          || (!expanded.has(node.branch) && !focus && node.kind !== 'branch' && children(node.branch).findIndex(item => item.id === selected) >= 3));
        if (needsReveal) { reveal(selected); render(false); root.querySelector(`[data-landscape-node="${selected}"]`)?.scrollIntoView?.({ block: 'center', inline: 'center' }); return; }
        // Keep the diagram in place while updating the selected item's details.
        $('landscape-map').innerHTML = scene();
        fitLabels();
        $('landscape-detail').innerHTML = inspector();
        $('landscape-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const action = button.dataset.landscapeAction, branch = button.dataset.branch;
      if (action === 'overview') { view = 'overview'; selected = 'household'; render(false); return; }
      const anchor = button.getBoundingClientRect?.();
      const optionsOpen = root.querySelector('.landscape-view-options')?.open;
      if (action === 'reload') { await loadPage(); return; }
      if (action === 'focus') { focus = branch; selected = branch; collapsed.delete(branch); hidden.delete(branch); expanded.add(branch); }
      if (action === 'toggle-leg') {
        if (hidden.has(branch)) hidden.delete(branch);
        else {
          hidden.add(branch);
          if (focus === branch) focus = '';
          if (selected === branch || data.nodes.find(node => node.id === selected)?.branch === branch) selected = 'household';
        }
      }
      if (action === 'flows') showFlows = !showFlows;
      if (action === 'fan') {
        if (expanded.has(branch) || focus) { expanded.delete(branch); focus = ''; }
        else expanded.add(branch);
        collapsed.delete(branch);
      }
      if (action === 'transactions') {
        const id = button.dataset.item;
        if (openTransactions.has(id)) openTransactions.delete(id);
        else openTransactions.add(id);
      }
      if (action === 'collapse') { collapsed.has(branch) ? collapsed.delete(branch) : collapsed.add(branch); selected = branch; }
      if (action === 'collapse-all') branches.forEach(node => collapsed.add(node.id));
      if (action === 'expand') { collapsed.clear(); branches.forEach(node => expanded.add(node.id)); }
      if (action === 'reset') { focus = ''; selected = 'household'; collapsed.clear(); hidden.clear(); expanded.clear(); openTransactions.clear(); showFlows = false; }
      render(!['reset', 'focus'].includes(action));
      if (optionsOpen) root.querySelector('.landscape-view-options').open = true;
      const replacement = root.querySelector(`[data-landscape-action="${action}"]${branch ? `[data-branch="${branch}"]` : ''}${button.dataset.item ? `[data-item="${button.dataset.item}"]` : ''}`);
      if (anchor && button.dataset.item && replacement && ['fan', 'transactions', 'collapse'].includes(action)) {
        const next = replacement.getBoundingClientRect();
        const dx = next.left - anchor.left, dy = next.top - anchor.top;
        $('landscape-map').scrollBy(dx, dy);
      }
      replacement?.focus({ preventScroll: true });
    };
    root.onkeydown = event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('g[data-landscape-node], g[data-landscape-action]')) {
        event.preventDefault();
        const id = event.target.dataset.landscapeNode;
        root.onclick({ target: event.target });
        if (id) root.querySelector(`g[data-landscape-node="${id}"]`)?.focus({ preventScroll: true });
      }
    };
  }
  async function loadPage() {
    const root = $('landscape-root');
    if (!root) return;
    const ticket = ++generation;
    root.innerHTML = '<p role="status">Building your financial landscape...</p>';
    try {
      const response = await fetch('/api/landscape', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Unable to load financial landscape (${response.status})`);
      if (ticket !== generation) return;
      data = result;
      if (!data.nodes.some(node => node.id === selected)) selected = 'household';
      render(false);
    } catch (error) {
      if (ticket !== generation) return;
      root.innerHTML = `<p role="alert">Could not load your financial landscape: ${esc(error.message)}</p><button class="btn btn-secondary" id="landscape-retry">Retry</button>`;
      $('landscape-retry').onclick = loadPage;
    }
  }
  window.FinanceLandscape = { loadPage, reset() {
    generation++; data = null; selected = 'household'; view = 'overview'; focus = ''; collapsed.clear(); hidden.clear(); expanded.clear(); openTransactions.clear(); showFlows = false;
    const root = $('landscape-root');
    if (root) { root.innerHTML = ''; root.onclick = null; root.onkeydown = null; }
  } };
})();
