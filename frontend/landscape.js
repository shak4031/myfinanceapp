/* Existing-data financial relationship map. */
(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  let data = null, selected = 'household', focus = '', zoom = 1, generation = 0;
  const defaultView = () => ({ yaw: -15, pitch: 20, depth: true });
  let view = defaultView(), drag = null, ignoreClickUntil = 0, scrollMode = false;
  const collapsed = new Set();
  const children = id => data.nodes.filter(node => node.branch === id && node.kind !== 'branch');
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
    let height = 1280;
    positions.set('household', { x: 800, y: 640 });
    if (focus) {
      const list = children(focus);
      height = Math.max(850, 320 + Math.ceil(list.length / 4) * 145);
      positions.set('household', { x: 110, y: 70 });
      visible.add(focus);
      positions.set(focus, { x: 800, y: 150 });
      if (!collapsed.has(focus)) list.forEach((node, index) => {
        visible.add(node.id);
        positions.set(node.id, { x: 350 + index % 4 * 300, y: 320 + Math.floor(index / 4) * 145 });
      });
    } else {
      branches.forEach((branch, index) => {
        const angle = -Math.PI / 2 + index * Math.PI / 4;
        visible.add(branch.id);
        positions.set(branch.id, { x: 800 + Math.cos(angle) * 300, y: 640 + Math.sin(angle) * 280, z: Math.sin(angle * 2) * 100 });
        if (collapsed.has(branch.id)) return;
        const list = children(branch.id).slice(0, 3);
        list.forEach((node, i) => {
          const a = angle + (i - (list.length - 1) / 2) * 0.245;
          visible.add(node.id);
          positions.set(node.id, { x: 800 + Math.cos(a) * 595, y: 640 + Math.sin(a) * 500, z: Math.sin(a * 2) * 220 + (i - 1) * 80 });
        });
      });
    }
    let orbit = '';
    if (!focus) {
      const yaw = view.yaw * Math.PI / 180, pitch = view.pitch * Math.PI / 180;
      const project = p => {
        const x = p.x - 800, y = p.y - 640, z = view.depth ? p.z || 0 : 0;
        const rx = x * Math.cos(yaw) + z * Math.sin(yaw);
        const rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
        const ry = y * Math.cos(pitch) - rz * Math.sin(pitch);
        const depth = y * Math.sin(pitch) + rz * Math.cos(pitch);
        const perspective = 1800 / (1800 - depth);
        return { x: rx * perspective, y: ry * perspective, depth, scale: perspective };
      };
      const projected = new Map([...positions].map(([id, p]) => [id, project(p)]));
      const fit = Math.min(1, 620 / Math.max(1, ...[...projected.values()].map(p => Math.abs(p.x))),
        470 / Math.max(1, ...[...projected.values()].map(p => Math.abs(p.y))));
      const screen = p => ({ ...p, x: 800 + p.x * fit, y: 600 + p.y * fit });
      projected.forEach((p, id) => positions.set(id, screen(p)));
      const ring = Array.from({ length: 65 }, (_, i) => {
        const angle = i * Math.PI / 32;
        const p = screen(project({ x: 800 + Math.cos(angle) * 595, y: 640 + Math.sin(angle) * 500 }));
        return `${i ? 'L' : 'M'} ${p.x} ${p.y}`;
      }).join(' ');
      orbit = `<path class="landscape-orbit" d="${ring} Z" aria-hidden="true"/>`;
    }
    const connections = data.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target));
    const paths = connections.map(edge => {
      const a = positions.get(edge.source), b = positions.get(edge.target);
      const source = data.nodes.find(node => node.id === edge.source);
      const target = data.nodes.find(node => node.id === edge.target);
      const related = selected === 'household' || edge.source === selected || edge.target === selected;
      const title = edge.kind === 'structure' ? `${source.label} — ${target.label}: grouped relationship`
        : `${source.label} → ${target.label}: ${money(edge.amount)}/mo recorded ${edge.kind === 'transfer' ? 'transfer' : 'activity'}`;
      const bend = edge.kind === 'structure' ? 0 : (b.x - a.x) * .12;
      return `<path class="landscape-edge is-${edge.kind}${related ? '' : ' is-dim'}" d="M ${a.x} ${a.y} Q ${(a.x + b.x) / 2 + bend} ${(a.y + b.y) / 2 - 45} ${b.x} ${b.y}" stroke="${color(target.kind === 'branch' ? target : target.branch ? target : source)}"${edge.kind === 'structure' ? '' : ' marker-end="url(#landscape-arrow)"'}><title>${esc(title)}</title></path>`;
    }).join('');
    const visibleNodes = data.nodes.filter(node => visible.has(node.id));
    // Paint farther nodes first; keep text upright and avoid overlapping labels as the camera moves.
    const labelBoxes = [];
    const labelPositions = new Map();
    visibleNodes.forEach(node => {
      const p = positions.get(node.id), radius = node.kind === 'household' ? 49 : node.kind === 'branch' ? 32 : 19;
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
        const outside = box.x < 5 || box.x + box.w > 1595 || box.y < 5 || box.y + h > height - 5;
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
      const radius = (home ? 49 : hub ? 32 : 19) * scale;
      const labelPosition = labelPositions.get(node.id);
      const label = home ? ['Your household'] : labelLines(node.label);
      const more = hub && !focus && children(node.id).length > 3 && !collapsed.has(node.id)
        ? `<text y="${label.length * 28 + 28}" class="landscape-more">+${children(node.id).length - 3} more · focus to explore</text>` : '';
      return `<g class="landscape-node${node.kind === 'missing' ? ' is-missing' : ''}${selected === node.id ? ' is-selected' : ''}" transform="translate(${p.x} ${p.y})" role="button" tabindex="0" data-landscape-node="${esc(node.id)}" aria-label="${esc(`${node.label}. ${home ? 'Select a branch to explore.' : value(node)}`)}" aria-pressed="${selected === node.id}">
        <title>${esc(node.label)}${home ? '' : `: ${esc(value(node))}`}</title>${labelPosition.x || Math.abs(labelPosition.y) > radius + 60 ? `<path class="landscape-label-leader" d="M 0 0 L ${labelPosition.x} ${labelPosition.y - 15}" aria-hidden="true"/>` : ''}<circle r="${radius + 7}" class="landscape-halo"/><circle class="landscape-sphere" r="${radius}" fill="${home ? '#153a4a' : node.color || color(node)}"/><circle r="${radius}" fill="url(#landscape-light)" class="landscape-light" aria-hidden="true"/>
        <text y="5" class="landscape-symbol">${home ? '&#9672;' : hub ? `${children(node.id).filter(n => n.kind !== 'missing').length}` : node.kind === 'missing' ? '?' : node.kind === 'account' ? '&#9635;' : node.kind === 'goal' ? '&#9671;' : '&#8226;'}</text>
        <g transform="translate(${labelPosition.x} ${labelPosition.y})">${label.map((line, i) => `<text y="${i * 28}" class="landscape-label">${esc(line)}</text>`).join('')}
        ${home ? '' : `<text y="${label.length * 28}" class="landscape-value">${esc(value(node))}</text>`}${more}</g></g>`;
    }).join('');
    return `<svg id="landscape-svg" data-yaw="${view.yaw}" data-pitch="${view.pitch}" viewBox="0 0 1600 ${height}" style="width:${zoom * 100}%;min-width:${Math.round(1280 * zoom)}px" role="group" aria-label="Financial landscape. Select a node for details.${focus ? ' Scroll to explore this branch.' : ' Focus the map and use arrow keys to rotate.'}"><defs><radialGradient id="landscape-light" cx="30%" cy="25%" r="80%"><stop stop-color="#fff" stop-opacity=".65"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#071e30" stop-opacity=".55"/></radialGradient><marker id="landscape-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#6b8795"/></marker></defs>${orbit}${paths}${nodes}</svg>`;
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
    root.innerHTML = `<div class="landscape-period"><span>${esc(data.period.from)} &ndash; ${esc(data.period.to)}</span><span>${data.period.months}/3 months recorded</span><details class="landscape-help"><summary>Map guide</summary><p>Drag to rotate, or focus the map and use arrow keys. Home restores the depth view. Use Flat view for an overhead layout; Focus opens every connection in a branch as a flat grid. On touch screens, enable Scroll mode to swipe across the map instead of rotating. Swipe outside the map to scroll the page.</p><p>Select circles for details. The overview previews up to 3 connections per branch. Zoom and scroll to explore. Circle depth and size are for navigation, not dollars. Dotted lines group records; solid arrows show recorded activity. Missing connections are not guessed. Balances have their own as-of dates; this is not a net-worth total.</p></details></div>
      <div class="landscape-toolbar" role="group" aria-label="Map controls"><button data-landscape-action="reset">Show full landscape</button><button data-landscape-action="expand">Expand all branches</button><button data-landscape-action="collapse-all">Collapse all branches</button><button data-landscape-action="zoom-out" aria-label="Zoom out">−</button><span aria-live="polite">${Math.round(zoom * 100)}%</span><button data-landscape-action="zoom-in" aria-label="Zoom in">+</button><button data-landscape-action="reload">Refresh data</button></div>
      <div class="landscape-toolbar" role="group" aria-label="Perspective controls"><button data-landscape-action="depth" aria-pressed="${!focus && view.depth}">Depth view</button><button data-landscape-action="flat" aria-pressed="${!focus && !view.depth}">Flat view</button><button data-landscape-action="rotate-left" aria-label="Rotate left"${focus ? ' disabled' : ''}>&larr;</button><button data-landscape-action="rotate-right" aria-label="Rotate right"${focus ? ' disabled' : ''}>&rarr;</button><button data-landscape-action="tilt-up" aria-label="Tilt up"${focus ? ' disabled' : ''}>&uarr;</button><button data-landscape-action="tilt-down" aria-label="Tilt down"${focus ? ' disabled' : ''}>&darr;</button><button data-landscape-action="scroll-mode" aria-pressed="${scrollMode}"${focus ? ' disabled' : ''}>Scroll mode</button><span id="landscape-angle" class="landscape-small" role="status">${focus ? 'Branch view' : `${Math.round(view.yaw)}° / ${Math.round(view.pitch)}°`}</span></div>
      <div class="landscape-branch-controls" role="group" aria-label="Financial branches">${branches.map(branch => `<div style="--branch-color:${branch.color}"><button data-landscape-node="${branch.id}" aria-pressed="${selected === branch.id}">${esc(branch.label)}</button><button data-landscape-action="collapse" data-branch="${branch.id}" aria-expanded="${!collapsed.has(branch.id)}" aria-label="${collapsed.has(branch.id) ? 'Expand' : 'Collapse'} ${esc(branch.label)}">${collapsed.has(branch.id) ? '+' : '−'}</button><button data-landscape-action="focus" data-branch="${branch.id}" aria-label="Focus ${esc(branch.label)}">Focus</button></div>`).join('')}</div>
      <div class="landscape-workspace"><div id="landscape-map" class="landscape-map${focus || scrollMode ? ' is-scrollable' : ''}" tabindex="0" role="region" aria-label="${focus ? 'Scrollable branch network' : scrollMode ? 'Scrollable financial network. Use arrow keys to rotate.' : 'Rotatable financial network. Drag or use arrow keys to rotate; Home resets the view.'}">${scene()}</div><aside id="landscape-detail" class="landscape-detail" aria-label="Selected financial details" aria-live="polite">${inspector()}</aside></div>
      <details class="landscape-coverage"><summary>Coverage and calculation notes</summary><p>${esc(data.note)}</p><ul><li>${data.coverage.unassignedActivity} activity records have no verified account connection.</li><li>${data.coverage.unknownTransfers} transfers in the period await classification and are excluded from spending/income.</li><li>${data.coverage.pendingExcluded} pending records are excluded from this map.</li><li>${data.coverage.reviewAccounts} accounts need review and are not mapped as confirmed assets.</li></ul><p>Unlinked debt-plan records may overlap accounts. Goal progress is not added to savings. Investment holdings, returns and employer retirement contributions are not provided by this view.</p></details>`;
    bindRotation();
    root.onclick = async event => {
      if (Date.now() < ignoreClickUntil && event.target.closest('#landscape-map')) return;
      const button = event.target.closest('[data-landscape-node], [data-landscape-action]');
      if (!button) return;
      if (button.dataset.landscapeNode) {
        selected = button.dataset.landscapeNode;
        // Keep the map and scroll position stable while the inspector changes.
        $('landscape-map').innerHTML = scene();
        $('landscape-detail').innerHTML = inspector();
        root.querySelectorAll('.landscape-branch-controls [data-landscape-node]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.landscapeNode === selected)));
        $('landscape-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      const action = button.dataset.landscapeAction, branch = button.dataset.branch;
      if (action === 'reload') { await loadPage(); return; }
      if (action === 'focus') { focus = branch; selected = branch; collapsed.delete(branch); zoom = 1; }
      if (action === 'collapse') { collapsed.has(branch) ? collapsed.delete(branch) : collapsed.add(branch); selected = branch; }
      if (action === 'collapse-all') branches.forEach(node => collapsed.add(node.id));
      if (action === 'expand') collapsed.clear();
      if (action === 'reset') { focus = ''; selected = 'household'; zoom = 1; collapsed.clear(); view = defaultView(); scrollMode = false; }
      if (action === 'scroll-mode') scrollMode = !scrollMode;
      if (action === 'depth' || action === 'flat') { focus = ''; view = action === 'depth' ? defaultView() : { yaw: 0, pitch: 0, depth: false }; }
      if (!focus && ['rotate-left', 'rotate-right', 'tilt-up', 'tilt-down'].includes(action)) {
        rotate(view.yaw + (action === 'rotate-left' ? -15 : action === 'rotate-right' ? 15 : 0),
          view.pitch + (action === 'tilt-up' ? 10 : action === 'tilt-down' ? -10 : 0));
      }
      if (action === 'zoom-in' || action === 'zoom-out') zoom = Math.max(.6, Math.min(2, Math.round((zoom + (action === 'zoom-in' ? .2 : -.2)) * 10) / 10));
      render();
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
    generation++; data = null; selected = 'household'; focus = ''; zoom = 1; collapsed.clear(); view = defaultView(); drag = null; ignoreClickUntil = 0; scrollMode = false;
    const root = $('landscape-root');
    if (root) { root.innerHTML = ''; root.onclick = null; root.onkeydown = null; }
  } };
})();
