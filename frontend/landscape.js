/* Existing-data financial relationship map. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  let data = null, selected = 'household', focus = '', page = 0, generation = 0;
  const pageSize = 8;
  let showFlows = false;
  const collapsed = new Set(), hidden = new Set();
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
      if (!focus && node.kind !== 'branch' && children(node.branch).findIndex(item => item.id === id) >= 3) focus = node.branch;
      if (focus && node.kind !== 'branch') page = Math.floor(children(node.branch).findIndex(item => item.id === id) / pageSize);
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
  function scene() {
    const branches = data.nodes.filter(node => node.kind === 'branch');
    const positions = new Map(), visible = new Set(['household']);
    const width = 1800, height = 1150;
    positions.set('household', { x: 900, y: 575 });
    if (focus) {
      const list = children(focus);
      page = Math.max(0, Math.min(page, Math.ceil(list.length / pageSize) - 1));
      positions.set('household', { x: 900, y: 90 });
      visible.add(focus);
      positions.set(focus, { x: 900, y: 310 });
      if (!collapsed.has(focus)) list.slice(page * pageSize, (page + 1) * pageSize).forEach((node, index, shown) => {
        const tier = Math.floor(index / 4), count = Math.min(4, shown.length - tier * 4);
        const angle = count === 1 ? 0 : (index % 4 / (count - 1) - .5) * 2.2;
        visible.add(node.id);
        positions.set(node.id, { x: 900 + Math.sin(angle) * 650, y: 470 + tier * 310 + Math.cos(angle) * 180 });
      });
    } else {
      branches.forEach((branch, index) => {
        if (hidden.has(branch.id)) return;
        const angle = -Math.PI / 2 + index * Math.PI / 4;
        const hub = { x: 900 + Math.cos(angle) * 475, y: 575 + Math.sin(angle) * 290 };
        visible.add(branch.id);
        positions.set(branch.id, hub);
        if (collapsed.has(branch.id)) return;
        const list = children(branch.id).slice(0, 3);
        list.forEach((node, i) => {
          const a = angle + (i - (list.length - 1) / 2) * .65;
          visible.add(node.id);
          positions.set(node.id, { x: hub.x + Math.cos(a) * 200, y: hub.y + Math.sin(a) * 155 });
        });
      });
    }
    const connections = data.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target) && (edge.kind === 'structure' || showFlows));
    const paths = connections.map(edge => {
      const a = positions.get(edge.source), b = positions.get(edge.target);
      const source = data.nodes.find(node => node.id === edge.source);
      const target = data.nodes.find(node => node.id === edge.target);
      const related = selected === 'household' || edge.source === selected || edge.target === selected;
      const title = edge.kind === 'structure' ? `${source.label} — ${target.label}: grouped relationship`
        : `${source.label} → ${target.label}: ${money(edge.amount)}/mo recorded ${edge.kind === 'transfer' ? 'transfer' : 'activity'}`;
      const bend = edge.kind === 'structure' ? 0 : (b.x - a.x) * .12;
      return `<path class="landscape-edge is-${edge.kind}${source.kind === 'household' ? ' is-trunk' : ''}${target.kind === 'missing' ? ' is-missing' : ''}${related ? '' : ' is-dim'}" data-landscape-source="${esc(edge.source)}" data-landscape-target="${esc(edge.target)}" d="M ${a.x} ${a.y} Q ${(a.x + b.x) / 2 + bend} ${(a.y + b.y) / 2 - (edge.kind === 'structure' ? 0 : 45)} ${b.x} ${b.y}" stroke="${color(target.kind === 'branch' ? target : target.branch ? target : source)}"${edge.kind === 'structure' ? '' : ' marker-end="url(#landscape-arrow)"'}><title>${esc(title)}</title></path>`;
    }).join('');
    const visibleNodes = data.nodes.filter(node => visible.has(node.id));
    const labeledNodes = visibleNodes.filter(node => focus || ['household', 'branch'].includes(node.kind));
    const labelBoxes = [];
    const labelPositions = new Map();
    labeledNodes.forEach(node => {
      const p = positions.get(node.id), radius = nodeRadius(node);
      const lines = node.kind === 'household' ? 1 : labelLines(node.label).length + 1;
      const extra = node.kind === 'branch' && !focus && children(node.id).length > 3 && !collapsed.has(node.id);
      const h = (lines + (extra ? 1 : 0)) * 36;
      const candidates = [
        { x: 0, y: radius + 32 }, { x: 0, y: -radius - h },
        { x: 150, y: -h / 2 + 20 }, { x: -150, y: -h / 2 + 20 },
        { x: 0, y: radius + 110 }, { x: 0, y: -radius - h - 85 }
      ];
      for (let distance = 1; distance <= 5; distance++) {
        for (const x of [0, -160, 160, -280, 280]) {
          candidates.push({ x, y: radius + 32 + distance * 65 }, { x, y: -radius - h - distance * 65 });
        }
      }
      const score = offset => {
        const box = { x: p.x + offset.x - 145, y: p.y + offset.y - 26, w: 290, h };
        const overlaps = labelBoxes.reduce((sum, b) => sum + Math.max(0, Math.min(box.x + box.w, b.x + b.w) - Math.max(box.x, b.x)) * Math.max(0, Math.min(box.y + h, b.y + b.h) - Math.max(box.y, b.y)), 0);
        const outside = box.x < 5 || box.x + box.w > width - 5 || box.y < 5 || box.y + h > height - 5;
        const onNode = visibleNodes.some(other => other !== node && (() => {
          const q = positions.get(other.id);
          return q.x > box.x - 25 && q.x < box.x + box.w + 25 && q.y > box.y - 25 && q.y < box.y + h + 25;
        })());
        return { box, penalty: overlaps * 1000 + (outside ? 1e9 : 0) + (onNode ? 10000 : 0) };
      };
      const best = candidates.map(offset => ({ offset, ...score(offset) })).sort((a, b) => a.penalty - b.penalty)[0];
      labelBoxes.push(best.box);
      labelPositions.set(node.id, best.offset);
    });
    const nodes = visibleNodes.map(node => {
      const p = positions.get(node.id), hub = node.kind === 'branch', home = node.kind === 'household';
      const radius = nodeRadius(node);
      const labelPosition = labelPositions.get(node.id);
      const label = home ? ['Your household'] : labelLines(node.label);
      const more = hub && !focus && children(node.id).length > 3 && !collapsed.has(node.id)
        ? `<text y="${label.length * 36 + 32}" class="landscape-more">+${children(node.id).length - 3} more · explore</text>` : '';
      return `<g class="landscape-node${node.kind === 'missing' ? ' is-missing' : ''}${selected === node.id ? ' is-selected' : ''}" transform="translate(${p.x} ${p.y})" role="button" tabindex="0" data-landscape-node="${esc(node.id)}" data-landscape-radius="${radius}" data-landscape-icon="${home ? 'household' : node.branch}"${hub ? ` data-landscape-leg="${node.id}"` : ''} aria-label="${esc(`${node.label}. ${home ? 'Select a branch to explore.' : value(node)}`)}" aria-pressed="${selected === node.id}">
        <title>${esc(node.label)}${home ? '' : `: ${esc(value(node))}`}</title>${labelPosition && (labelPosition.x || Math.abs(labelPosition.y) > radius + 60) ? `<path class="landscape-label-leader" d="M 0 0 L ${labelPosition.x} ${labelPosition.y - 15}" aria-hidden="true"/>` : ''}<circle r="${radius + 8}" class="landscape-halo"/>
        ${node.kind === 'missing' ? `<circle r="${radius}" class="landscape-missing-marker"/><text y="6" class="landscape-symbol">?</text>` : home || hub
          ? `<g class="landscape-illustration" transform="translate(${-radius} ${-radius}) scale(${radius * 2 / 64})">${illustration(home ? 'household' : node.branch)}</g>`
          : `<circle r="${radius}" fill="${color(node)}" fill-opacity=".12"/><g class="landscape-pictogram" style="color:${color(node)}" transform="translate(${-radius * .6} ${-radius * .6}) scale(${radius * 1.2 / 24})">${icon(node.branch)}</g>`}
        ${labelPosition ? `<g transform="translate(${labelPosition.x} ${labelPosition.y})">${label.map((line, i) => `<text y="${i * 36}" class="landscape-label">${esc(line)}</text>`).join('')}
        ${home ? '' : `<text y="${label.length * 36}" class="landscape-value">${esc(value(node))}</text>`}${more}</g>` : ''}</g>`;
    }).join('');
    const bounds = [...labelBoxes, ...[...positions.values()].map(p => ({ x: p.x - 85, y: p.y - 85, w: 170, h: 185 }))];
    const left = Math.min(...bounds.map(b => b.x)) - 45, top = Math.min(...bounds.map(b => b.y)) - 45;
    const sceneWidth = Math.max(...bounds.map(b => b.x + b.w)) - left + 45;
    const sceneHeight = Math.max(...bounds.map(b => b.y + b.h)) - top + 45;
    return `<svg id="landscape-svg" viewBox="${left} ${top} ${sceneWidth} ${sceneHeight}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Financial landscape. Select an illustration or item for details. Explore a section for labeled items."><defs><marker id="landscape-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#6b8795"/></marker></defs>${paths}${nodes}</svg>`;
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
      ${node.kind === 'branch' ? `<div class="landscape-actions"><button data-landscape-action="focus" data-branch="${node.id}">Focus this branch</button><button data-landscape-action="collapse" data-branch="${node.id}">${collapsed.has(node.id) ? 'Expand' : 'Collapse'} branch</button></div><h3>${node.count ? `All ${node.count} recorded connections` : 'Coverage gap'}</h3><ul class="landscape-detail-list">${list.map(item => `<li><button data-landscape-node="${esc(item.id)}"><b>${esc(item.label)}</b><span>${esc(value(item))}</span></button></li>`).join('')}</ul>` : ''}
      ${related.length ? `<h3>Recorded connections</h3><ul class="landscape-detail-list">${related.map(edge => {
        const outgoing = edge.source === node.id;
        const other = data.nodes.find(n => n.id === (outgoing ? edge.target : edge.source));
        return `<li><button data-landscape-node="${esc(other.id)}">${outgoing ? 'To' : 'From'} ${esc(other.label)}<span>${esc(money(edge.amount))}/mo · ${edge.kind === 'transfer' ? 'transfer, not spending' : 'recorded activity'}</span></button></li>`;
      }).join('')}</ul>` : ''}
      ${node.transactions?.length ? `<h3>Recent recorded transactions</h3><p>${node.count} transactions in the comparison period. Showing the latest ${node.transactions.length}.</p><ul class="landscape-detail-list">${node.transactions.map(tx => `<li><a href="#transactions/${tx.id}" class="transaction-link">${esc(tx.label)}</a><span>${esc(tx.date)} · ${esc(money(tx.amount))}</span></li>`).join('')}</ul>` : ''}
      ${node.href ? `<a class="btn btn-secondary" href="${node.href}">Open ${node.href === '#accounts' ? 'Accounts' : node.href === '#goals' ? 'Goals' : 'Debt-free plan'}</a>` : ''}`;
  }
  function render() {
    const root = $('landscape-root');
    if (!root || !data) return;
    const branches = data.nodes.filter(node => node.kind === 'branch');
    const pageCount = focus ? Math.max(1, Math.ceil(children(focus).length / pageSize)) : 1;
    page = Math.max(0, Math.min(page, pageCount - 1));
    root.innerHTML = `<div class="landscape-period"><span>${esc(data.period.from)} &ndash; ${esc(data.period.to)}</span><span>${data.period.months}/3 months recorded</span><details class="landscape-help"><summary>Map guide</summary><p>Each illustrated section has its own fan-out. Tap a section tile to show or hide its leg. The overview previews up to 3 items per leg; select an item for its name and amount, or use Explore for labeled items, 8 at a time. Every item is also available in the details list.</p><p>Item area reflects the absolute amount relative to the largest item with the same measure in that leg. Balances, monthly flows and goal progress use separate scales. Missing amounts have a small unweighted marker; zero remains zero. This is not a financial-health score or share of net worth. Leg sizes are not comparable.</p><p>Colored branches show grouping, not money transfers. Recorded flow arrows are optional; details always retain verified connections. Balances have their own as-of dates; missing coverage is not zero.</p></details></div>
      <div class="landscape-branch-controls" role="group" aria-label="Show or hide financial sections">${branches.map(branch => `<button type="button" class="landscape-section-toggle${hidden.has(branch.id) ? ' is-hidden' : ''}" style="--branch-color:${branch.color}" data-landscape-action="toggle-leg" data-branch="${branch.id}" aria-pressed="${!hidden.has(branch.id)}" aria-label="Show ${esc(branch.label)} section">${icon(branch.id)}<span><b>${esc(branch.label)}</b><small>${hidden.has(branch.id) ? 'Hidden' : `${branch.count} ${branch.count === 1 ? 'item' : 'items'}`}</small></span><span class="landscape-toggle-mark" aria-hidden="true">${hidden.has(branch.id) ? '+' : '&#10003;'}</span></button>`).join('')}</div>
      <div class="landscape-toolbar" role="group" aria-label="Map controls"><label class="landscape-explore">Explore <select id="landscape-explore" aria-label="Explore a financial section"><option value="">All sections</option>${branches.map(branch => `<option value="${branch.id}"${focus === branch.id ? ' selected' : ''}>${esc(branch.label)}</option>`).join('')}</select></label><button data-landscape-action="reset">Show full landscape</button><button data-landscape-action="reload" aria-label="Refresh landscape data">Refresh</button><details class="landscape-view-options"><summary>View options</summary>
      <div class="landscape-toolbar"><button data-landscape-action="expand">Expand all branches</button><button data-landscape-action="collapse-all">Collapse all branches</button><button data-landscape-action="flows" aria-pressed="${showFlows}">Recorded flow arrows</button></div></details></div>
      ${focus && pageCount > 1 ? `<div class="landscape-pagination" role="group" aria-label="Section items"><button data-landscape-action="previous-page"${page === 0 ? ' disabled' : ''}>Previous</button><span role="status">Items ${page * pageSize + 1}&ndash;${Math.min((page + 1) * pageSize, children(focus).length)} of ${children(focus).length}</span><button data-landscape-action="next-page"${page === pageCount - 1 ? ' disabled' : ''}>Next</button></div>` : ''}
      <div class="landscape-workspace"><div id="landscape-map" class="landscape-map" role="region" aria-label="Financial network, fitted to show all visible legs">${scene()}</div><aside id="landscape-detail" class="landscape-detail" aria-label="Selected financial details" aria-live="polite">${inspector()}</aside></div>
      <details class="landscape-coverage"><summary>Coverage and calculation notes</summary><p>${esc(data.note)}</p><ul><li>${data.coverage.unassignedActivity} activity records have no verified account connection.</li><li>${data.coverage.unknownTransfers} transfers in the period await classification and are excluded from spending/income.</li><li>${data.coverage.pendingExcluded} pending records are excluded from this map.</li><li>${data.coverage.reviewAccounts} accounts need review and are not mapped as confirmed assets.</li></ul><p>Unlinked debt-plan records may overlap accounts. Goal progress is not added to savings. Investment holdings, returns and employer retirement contributions are not provided by this view.</p></details>`;
    $('landscape-explore').onchange = event => {
      const branch = event.target.value;
      focus = branch; selected = branch || 'household'; page = 0;
      if (branch) { hidden.delete(branch); collapsed.delete(branch); }
      render();
      $('landscape-explore').focus({ preventScroll: true });
    };
    root.onclick = async event => {
      const button = event.target.closest('[data-landscape-node], [data-landscape-action]');
      if (!button) return;
      if (button.dataset.landscapeNode) {
        selected = button.dataset.landscapeNode;
        const node = data.nodes.find(item => item.id === selected);
        const needsReveal = node?.branch && (hidden.has(node.branch) || collapsed.has(node.branch) || (focus && focus !== node.branch)
          || (!focus && node.kind !== 'branch' && children(node.branch).findIndex(item => item.id === selected) >= 3)
          || (focus && node.kind !== 'branch' && Math.floor(children(node.branch).findIndex(item => item.id === selected) / pageSize) !== page));
        if (needsReveal) { reveal(selected); render(); return; }
        // Keep the diagram in place while updating the selected item's details.
        $('landscape-map').innerHTML = scene();
        $('landscape-detail').innerHTML = inspector();
        $('landscape-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const action = button.dataset.landscapeAction, branch = button.dataset.branch;
      const optionsOpen = root.querySelector('.landscape-view-options')?.open;
      if (action === 'reload') { await loadPage(); return; }
      if (action === 'focus') { focus = branch; selected = branch; collapsed.delete(branch); hidden.delete(branch); page = 0; }
      if (action === 'toggle-leg') {
        if (hidden.has(branch)) hidden.delete(branch);
        else {
          hidden.add(branch);
          if (focus === branch) focus = '';
          if (selected === branch || data.nodes.find(node => node.id === selected)?.branch === branch) selected = 'household';
        }
      }
      if (action === 'flows') showFlows = !showFlows;
      if (action === 'collapse') { collapsed.has(branch) ? collapsed.delete(branch) : collapsed.add(branch); selected = branch; }
      if (action === 'collapse-all') branches.forEach(node => collapsed.add(node.id));
      if (action === 'expand') collapsed.clear();
      if (action === 'reset') { focus = ''; selected = 'household'; page = 0; collapsed.clear(); hidden.clear(); showFlows = false; }
      if (action === 'previous-page' || action === 'next-page') {
        page = Math.max(0, Math.min(pageCount - 1, page + (action === 'next-page' ? 1 : -1)));
        selected = focus;
      }
      render();
      if (optionsOpen) root.querySelector('.landscape-view-options').open = true;
      root.querySelector(`[data-landscape-action="${action}"]${branch ? `[data-branch="${branch}"]` : ''}`)?.focus({ preventScroll: true });
    };
    root.onkeydown = event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('g[data-landscape-node]')) {
        event.preventDefault();
        const id = event.target.dataset.landscapeNode;
        root.onclick({ target: event.target });
        root.querySelector(`g[data-landscape-node="${id}"]`)?.focus({ preventScroll: true });
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
      render();
    } catch (error) {
      if (ticket !== generation) return;
      root.innerHTML = `<p role="alert">Could not load your financial landscape: ${esc(error.message)}</p><button class="btn btn-secondary" id="landscape-retry">Retry</button>`;
      $('landscape-retry').onclick = loadPage;
    }
  }
  window.FinanceLandscape = { loadPage, reset() {
    generation++; data = null; selected = 'household'; focus = ''; page = 0; collapsed.clear(); hidden.clear(); showFlows = false;
    const root = $('landscape-root');
    if (root) { root.innerHTML = ''; root.onclick = null; root.onkeydown = null; }
  } };
})();
