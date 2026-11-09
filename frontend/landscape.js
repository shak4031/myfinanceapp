/* Existing-data financial relationship map. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  let data = null, selected = 'household', focus = '', zoom = 1, generation = 0;
  const defaultView = () => ({ yaw: -15, pitch: 20, depth: true });
  let view = defaultView(), drag = null, ignoreClickUntil = 0, scrollMode = false;
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
  const nodeRadius = node => {
    if (node.kind === 'household') return 58;
    if (node.kind === 'branch') return 43;
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
    const width = 2200;
    let height = 1900;
    positions.set('household', { x: 1100, y: 950 });
    if (focus) {
      const list = children(focus);
      height = Math.max(1200, 750 + Math.ceil(list.length / 5) * 260);
      positions.set('household', { x: 1100, y: 100 });
      visible.add(focus);
      positions.set(focus, { x: 1100, y: 350 });
      if (!collapsed.has(focus)) list.forEach((node, index) => {
        const tier = Math.floor(index / 5), count = Math.min(5, list.length - tier * 5);
        const angle = count === 1 ? 0 : (index % 5 / (count - 1) - .5) * 2.4;
        const radius = Math.min(840, 660 + tier * 90);
        visible.add(node.id);
        positions.set(node.id, { x: 1100 + Math.sin(angle) * radius, y: 350 + tier * 260 + Math.cos(angle) * 420 });
      });
    } else {
      branches.forEach((branch, index) => {
        if (hidden.has(branch.id)) return;
        const angle = -Math.PI / 2 + index * Math.PI / 4;
        const hub = { x: 1100 + Math.cos(angle) * 510, y: 950 + Math.sin(angle) * 470, z: 0 };
        visible.add(branch.id);
        positions.set(branch.id, hub);
        if (collapsed.has(branch.id)) return;
        const list = children(branch.id).slice(0, 3);
        list.forEach((node, i) => {
          const a = angle + (i - (list.length - 1) / 2) * .65;
          visible.add(node.id);
          positions.set(node.id, { x: hub.x + Math.cos(a) * 300, y: hub.y + Math.sin(a) * 270, z: (i - (list.length - 1) / 2) * 35 });
        });
      });
    }
    if (!focus) {
      const yaw = view.yaw * Math.PI / 180, pitch = view.pitch * Math.PI / 180;
      const project = p => {
        const x = p.x - 1100, y = p.y - 950, z = view.depth ? p.z || 0 : 0;
        const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
        const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
        const ry = y * Math.cos(pitch) - rz * Math.sin(pitch);
        const depth = y * Math.sin(pitch) + rz * Math.cos(pitch);
        const perspective = 3000 / (3000 - depth);
        return { x: rx * perspective, y: ry * perspective, depth, scale: perspective };
      };
      const projected = new Map([...positions].map(([id, p]) => [id, project(p)]));
      const fit = Math.min(1, 860 / Math.max(1, ...[...projected.values()].map(p => Math.abs(p.x))),
        720 / Math.max(1, ...[...projected.values()].map(p => Math.abs(p.y))));
      const screen = p => ({ ...p, x: 1100 + p.x * fit, y: 950 + p.y * fit });
      projected.forEach((p, id) => positions.set(id, screen(p)));
    }
    const platforms = branches.filter(branch => visible.has(branch.id)).map(branch => {
      const points = [positions.get(branch.id), ...children(branch.id).filter(node => visible.has(node.id)).map(node => positions.get(node.id))];
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const x = Math.min(...xs) - 85, y = Math.min(...ys) - 75;
      return `<rect class="landscape-island" data-landscape-leg="${branch.id}" x="${x}" y="${y}" width="${Math.max(...xs) - x + 85}" height="${Math.max(...ys) - y + 100}" rx="70" fill="${branch.color}" stroke="${branch.color}"/>`;
    }).join('');
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
    // Paint farther nodes first; keep text upright and avoid overlapping labels as the camera moves.
    const labelBoxes = [];
    const labelPositions = new Map();
    visibleNodes.forEach(node => {
      const p = positions.get(node.id), radius = nodeRadius(node) * Math.max(.8, Math.min(1.2, p.scale || 1));
      const lines = node.kind === 'household' ? 1 : labelLines(node.label).length + 1;
      const extra = node.kind === 'branch' && !focus && children(node.id).length > 3 && !collapsed.has(node.id);
      const h = (lines + (extra ? 1 : 0)) * 28;
      const candidates = [
        { x: 0, y: radius + 28 }, { x: 0, y: -radius - h },
        { x: 150, y: -h / 2 + 20 }, { x: -150, y: -h / 2 + 20 },
        { x: 0, y: radius + 110 }, { x: 0, y: -radius - h - 85 }
      ];
      for (let distance = 1; distance <= 5; distance++) {
        for (const x of [0, -160, 160, -280, 280]) {
          candidates.push({ x, y: radius + 28 + distance * 65 }, { x, y: -radius - h - distance * 65 });
        }
      }
      const score = offset => {
        const box = { x: p.x + offset.x - 115, y: p.y + offset.y - 20, w: 230, h };
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
    const nodes = visibleNodes.sort((a, b) => (positions.get(a.id).depth || 0) - (positions.get(b.id).depth || 0)).map(node => {
      const p = positions.get(node.id), hub = node.kind === 'branch', home = node.kind === 'household';
      const scale = Math.max(.8, Math.min(1.2, p.scale || 1));
      const radius = nodeRadius(node) * scale;
      const labelPosition = labelPositions.get(node.id);
      const label = home ? ['Your household'] : labelLines(node.label);
      const more = hub && !focus && children(node.id).length > 3 && !collapsed.has(node.id)
        ? `<text y="${label.length * 28 + 28}" class="landscape-more">+${children(node.id).length - 3} more · focus to explore</text>` : '';
      return `<g class="landscape-node${node.kind === 'missing' ? ' is-missing' : ''}${selected === node.id ? ' is-selected' : ''}" transform="translate(${p.x} ${p.y})" role="button" tabindex="0" data-landscape-node="${esc(node.id)}" data-landscape-radius="${nodeRadius(node)}" data-landscape-icon="${home ? 'household' : node.branch}" aria-label="${esc(`${node.label}. ${home ? 'Select a branch to explore.' : value(node)}`)}" aria-pressed="${selected === node.id}">
        <title>${esc(node.label)}${home ? '' : `: ${esc(value(node))}`}</title>${labelPosition.x || Math.abs(labelPosition.y) > radius + 60 ? `<path class="landscape-label-leader" d="M 0 0 L ${labelPosition.x} ${labelPosition.y - 15}" aria-hidden="true"/>` : ''}<circle r="${radius + 7}" class="landscape-halo"/><circle class="landscape-sphere" r="${radius}" fill="${home ? '#153a4a' : node.color || color(node)}"/><circle r="${radius}" fill="url(#landscape-light)" class="landscape-light" aria-hidden="true"/>
        ${node.kind === 'missing' ? '<text y="6" class="landscape-symbol">?</text>' : `<g class="landscape-pictogram" transform="translate(${-radius * .55} ${-radius * .55}) scale(${radius * 1.1 / 24})">${icon(home ? 'household' : node.branch)}</g>`}
        <g transform="translate(${labelPosition.x} ${labelPosition.y})">${label.map((line, i) => `<text y="${i * 28}" class="landscape-label">${esc(line)}</text>`).join('')}
        ${home ? '' : `<text y="${label.length * 28}" class="landscape-value">${esc(value(node))}</text>`}${more}</g></g>`;
    }).join('');
    const bounds = [{ x: 500, y: 450, w: 1200, h: 1000 }, ...labelBoxes, ...[...positions.values()].map(p => ({ x: p.x - 85, y: p.y - 85, w: 170, h: 185 }))];
    const left = Math.min(...bounds.map(b => b.x)) - 45, top = Math.min(...bounds.map(b => b.y)) - 45;
    const sceneWidth = Math.max(...bounds.map(b => b.x + b.w)) - left + 45;
    const sceneHeight = Math.max(...bounds.map(b => b.y + b.h)) - top + 45;
    return `<svg id="landscape-svg" data-yaw="${view.yaw}" data-pitch="${view.pitch}" viewBox="${left} ${top} ${sceneWidth} ${sceneHeight}" style="width:${zoom * 100}%;min-width:${Math.round(1100 * zoom)}px" role="group" aria-label="Financial landscape. Select a node for details.${focus ? ' Scroll to explore this branch.' : ' Focus the map and use arrow keys to rotate.'}"><defs><radialGradient id="landscape-light" cx="30%" cy="25%" r="80%"><stop stop-color="#fff" stop-opacity=".65"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#071e30" stop-opacity=".55"/></radialGradient><marker id="landscape-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#6b8795"/></marker></defs>${platforms}${paths}${nodes}</svg>`;
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
  function rotate(yaw, pitch) {
    view.yaw = (yaw % 360 + 540) % 360 - 180;
    view.pitch = Math.max(-60, Math.min(60, pitch));
  }
  function redrawMap() {
    $('landscape-map').innerHTML = scene();
    $('landscape-angle').textContent = focus ? 'Branch view' : `${Math.round(view.yaw)}° / ${Math.round(view.pitch)}°`;
  }
  function bindRotation() {
    const map = $('landscape-map');
    map.onpointerdown = event => {
      if (focus || scrollMode || event.isPrimary === false || event.button !== 0) return;
      ignoreClickUntil = 0;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch, moved: false };
    };
    map.onpointermove = event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) {
        map.setPointerCapture(event.pointerId);
        map.classList.add('is-rotating');
        map.focus({ preventScroll: true });
        drag.moved = true;
      }
      rotate(drag.yaw + dx * .3, drag.pitch - dy * .25);
      redrawMap();
    };
    const finish = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (drag.moved) {
        ignoreClickUntil = Date.now() + 400;
        if (map.hasPointerCapture(event.pointerId)) map.releasePointerCapture(event.pointerId);
      }
      drag = null;
      map.classList.remove('is-rotating');
    };
    map.onpointerup = finish;
    map.onpointercancel = finish;
    map.onlostpointercapture = finish;
    map.onpointerleave = event => { if (!drag?.moved) finish(event); };
  }
  function render() {
    const root = $('landscape-root');
    if (!root || !data) return;
    const branches = data.nodes.filter(node => node.kind === 'branch');
    root.innerHTML = `<div class="landscape-period"><span>${esc(data.period.from)} &ndash; ${esc(data.period.to)}</span><span>${data.period.months}/3 months recorded</span><details class="landscape-help"><summary>Map guide</summary><p>Each section fans out from its own hub. Tap a section tile to show or hide its leg; choose Explore to see all its items. The overview previews up to 3 items per leg. View options holds rotation, scrolling and recorded-flow controls.</p><p>Item area reflects the absolute amount relative to the largest item with the same measure in that leg. Balances, monthly flows and goal progress use separate scales. Missing amounts have a small unweighted marker; zero remains zero. Depth is decorative, not a financial-health score or share of net worth. Leg sizes are not comparable.</p><p>Solid colored branches show grouping, not money transfers. Recorded flow arrows are optional; details always retain verified connections. Balances have their own as-of dates; missing coverage is not zero. Drag to rotate or use arrow keys on the map; Home resets the camera. Touch users can enable Scroll mode to swipe across the map.</p></details></div>
      <div class="landscape-branch-controls" role="group" aria-label="Show or hide financial sections">${branches.map(branch => `<button type="button" class="landscape-section-toggle${hidden.has(branch.id) ? ' is-hidden' : ''}" style="--branch-color:${branch.color}" data-landscape-action="toggle-leg" data-branch="${branch.id}" aria-pressed="${!hidden.has(branch.id)}" aria-label="Show ${esc(branch.label)} section">${icon(branch.id)}<span><b>${esc(branch.label)}</b><small>${hidden.has(branch.id) ? 'Hidden' : `${branch.count} ${branch.count === 1 ? 'item' : 'items'}`}</small></span><span class="landscape-toggle-mark" aria-hidden="true">${hidden.has(branch.id) ? '+' : '&#10003;'}</span></button>`).join('')}</div>
      <div class="landscape-toolbar" role="group" aria-label="Map controls"><label class="landscape-explore">Explore <select id="landscape-explore" aria-label="Explore a financial section"><option value="">All sections</option>${branches.map(branch => `<option value="${branch.id}"${focus === branch.id ? ' selected' : ''}>${esc(branch.label)}</option>`).join('')}</select></label><button data-landscape-action="reset">Show full landscape</button><div class="landscape-zoom"><button data-landscape-action="zoom-out" aria-label="Zoom out">−</button><span aria-live="polite">${Math.round(zoom * 100)}%</span><button data-landscape-action="zoom-in" aria-label="Zoom in">+</button></div><button data-landscape-action="reload" aria-label="Refresh landscape data">Refresh</button><details class="landscape-view-options"><summary>View options</summary>
      <div class="landscape-toolbar" role="group" aria-label="Perspective controls"><button data-landscape-action="depth" aria-pressed="${!focus && view.depth}">Depth view</button><button data-landscape-action="flat" aria-pressed="${!focus && !view.depth}">Flat view</button><button data-landscape-action="rotate-left" aria-label="Rotate left"${focus ? ' disabled' : ''}>&larr;</button><button data-landscape-action="rotate-right" aria-label="Rotate right"${focus ? ' disabled' : ''}>&rarr;</button><button data-landscape-action="tilt-up" aria-label="Tilt up"${focus ? ' disabled' : ''}>&uarr;</button><button data-landscape-action="tilt-down" aria-label="Tilt down"${focus ? ' disabled' : ''}>&darr;</button><button data-landscape-action="scroll-mode" aria-pressed="${scrollMode}"${focus ? ' disabled' : ''}>Scroll mode</button><span id="landscape-angle" class="landscape-small" role="status">${focus ? 'Branch view' : `${Math.round(view.yaw)}° / ${Math.round(view.pitch)}°`}</span></div>
      <div class="landscape-toolbar"><button data-landscape-action="expand">Expand all branches</button><button data-landscape-action="collapse-all">Collapse all branches</button><button data-landscape-action="flows" aria-pressed="${showFlows}">Recorded flow arrows</button></div></details></div>
      <div class="landscape-workspace"><div id="landscape-map" class="landscape-map${focus || scrollMode ? ' is-scrollable' : ''}" tabindex="0" role="region" aria-label="${focus ? 'Scrollable branch network' : scrollMode ? 'Scrollable financial network. Use arrow keys to rotate.' : 'Rotatable financial network. Drag or use arrow keys to rotate; Home resets the view.'}">${scene()}</div><aside id="landscape-detail" class="landscape-detail" aria-label="Selected financial details" aria-live="polite">${inspector()}</aside></div>
      <details class="landscape-coverage"><summary>Coverage and calculation notes</summary><p>${esc(data.note)}</p><ul><li>${data.coverage.unassignedActivity} activity records have no verified account connection.</li><li>${data.coverage.unknownTransfers} transfers in the period await classification and are excluded from spending/income.</li><li>${data.coverage.pendingExcluded} pending records are excluded from this map.</li><li>${data.coverage.reviewAccounts} accounts need review and are not mapped as confirmed assets.</li></ul><p>Unlinked debt-plan records may overlap accounts. Goal progress is not added to savings. Investment holdings, returns and employer retirement contributions are not provided by this view.</p></details>`;
    bindRotation();
    $('landscape-explore').onchange = event => {
      const branch = event.target.value;
      focus = branch; selected = branch || 'household'; zoom = 1;
      if (branch) { hidden.delete(branch); collapsed.delete(branch); }
      render();
      $('landscape-explore').focus({ preventScroll: true });
    };
    root.onclick = async event => {
      if (Date.now() < ignoreClickUntil && event.target.closest('#landscape-map')) return;
      const button = event.target.closest('[data-landscape-node], [data-landscape-action]');
      if (!button) return;
      if (button.dataset.landscapeNode) {
        selected = button.dataset.landscapeNode;
        const node = data.nodes.find(item => item.id === selected);
        const needsReveal = node?.branch && (hidden.has(node.branch) || collapsed.has(node.branch) || (focus && focus !== node.branch)
          || (!focus && node.kind !== 'branch' && children(node.branch).findIndex(item => item.id === selected) >= 3));
        if (needsReveal) { reveal(selected); render(); return; }
        // Keep the map and scroll position stable while the inspector changes.
        $('landscape-map').innerHTML = scene();
        $('landscape-detail').innerHTML = inspector();
        $('landscape-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const action = button.dataset.landscapeAction, branch = button.dataset.branch;
      const optionsOpen = root.querySelector('.landscape-view-options')?.open;
      if (action === 'reload') { await loadPage(); return; }
      if (action === 'focus') { focus = branch; selected = branch; collapsed.delete(branch); hidden.delete(branch); zoom = 1; }
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
      if (action === 'reset') { focus = ''; selected = 'household'; zoom = 1; collapsed.clear(); hidden.clear(); view = defaultView(); scrollMode = false; showFlows = false; }
      if (action === 'scroll-mode') scrollMode = !scrollMode;
      if (action === 'depth' || action === 'flat') { focus = ''; view = action === 'depth' ? defaultView() : { yaw: 0, pitch: 0, depth: false }; }
      if (!focus && ['rotate-left', 'rotate-right', 'tilt-up', 'tilt-down'].includes(action)) {
        rotate(view.yaw + (action === 'rotate-left' ? -15 : action === 'rotate-right' ? 15 : 0),
          view.pitch + (action === 'tilt-up' ? 10 : action === 'tilt-down' ? -10 : 0));
      }
      if (action === 'zoom-in' || action === 'zoom-out') zoom = Math.max(.6, Math.min(2, Math.round((zoom + (action === 'zoom-in' ? .2 : -.2)) * 10) / 10));
      render();
      if (optionsOpen) root.querySelector('.landscape-view-options').open = true;
      root.querySelector(`[data-landscape-action="${action}"]${branch ? `[data-branch="${branch}"]` : ''}`)?.focus({ preventScroll: true });
    };
    root.onkeydown = event => {
      if (!focus && event.target.id === 'landscape-map' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'Home') view = defaultView();
        else rotate(view.yaw + (event.key === 'ArrowLeft' ? -15 : event.key === 'ArrowRight' ? 15 : 0),
          view.pitch + (event.key === 'ArrowUp' ? 10 : event.key === 'ArrowDown' ? -10 : 0));
        redrawMap();
        root.querySelector('[data-landscape-action="depth"]')?.setAttribute('aria-pressed', String(view.depth));
        root.querySelector('[data-landscape-action="flat"]')?.setAttribute('aria-pressed', String(!view.depth));
        return;
      }
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
    generation++; data = null; selected = 'household'; focus = ''; zoom = 1; collapsed.clear(); hidden.clear(); view = defaultView(); drag = null; ignoreClickUntil = 0; scrollMode = false; showFlows = false;
    const root = $('landscape-root');
    if (root) { root.innerHTML = ''; root.onclick = null; root.onkeydown = null; }
  } };
})();
