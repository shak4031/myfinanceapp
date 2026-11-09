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
    split([...rows].sort((a, b) => b.value - a.value), 0, 0, 100, 100);
    const total = sum(rows);
    return `<div class="money-mosaic" role="group" aria-label="Merchant spending mosaic. Tile area represents share of the displayed merchants.">${tiles.map((item, index) => {
      const label = `${item.name}: ${money(item.value)}, ${(item.value / total * 100).toFixed(1)}% of displayed spending. ${item.detail || ''}`;
      return `<div class="money-tile${item.w < 14 || item.h < 14 ? ' is-small' : ''}" tabindex="0" role="img" aria-label="${esc(label)}" style="left:${item.x}%;top:${item.y}%;width:${item.w}%;height:${item.h}%;--tile-color:${palette[index % palette.length]}">
        <div class="money-tile-face"><b>${esc(item.name)}</b><strong>${esc(money(item.value))}</strong><small>${(item.value / total * 100).toFixed(1)}%</small></div>
        <span class="money-tile-tip">${esc(label)}</span></div>`;
    }).join('')}</div>
    <p class="pro-footnote">Tile area = money out, not transaction count. Percentages describe these displayed merchants, not necessarily all spending. Focus or hover a tile for its full label.</p>
    <details class="money-exact"><summary>Exact totals and trends for every displayed merchant</summary><ul class="pro-list is-wrap">${rows.map(item =>
      `<li><div><strong>${esc(item.name)}</strong><small>${esc(item.detail || '')}</small></div><strong>${esc(money(item.value))}</strong></li>`).join('')}</ul></details>`;
  }

  function signalNetwork(categories, signalNames) {
    const { esc, money } = format();
    const active = categories.filter(category => category.signals.length);
    if (!active.length) return '<p class="pro-empty is-good">No category shows a warning signal right now.</p>';
    const height = Math.max(340, active.length * 52 + 40);
    const hubs = Object.entries(signalNames).map(([key, label], index) => ({ key, label,
      y: 50 + index * (Math.min(height, 440) - 100) / 2, color: palette[index] }));
    const step = (height - 60) / active.length;
    const paths = [], nodes = [];
    active.forEach((category, index) => {
      const y = 30 + step * (index + 0.5);
      const color = category.signals.length >= 2 ? '#c45889' : '#1d96b3';
      for (const key of category.signals) {
        const hub = hubs.find(item => item.key === key);
        if (!hub) continue;
        paths.push(`<path d="M 235 ${hub.y} C 360 ${hub.y},390 ${y},510 ${y}" stroke="${hub.color}" stroke-width="2" fill="none" opacity=".55"/>`);
      }
      const label = `${category.label}: ${category.signals.map(key => signalNames[key]).join(' + ')}; ${money(category.monthly)} per month`;
      nodes.push(`<g tabindex="0" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><circle cx="520" cy="${y}" r="${7 + category.signals.length * 3}" fill="${color}"/><text x="545" y="${y - 2}" class="money-node-label">${esc(category.label.length > 35 ? `${category.label.slice(0, 32)}...` : category.label)}</text><text x="545" y="${y + 17}" class="money-node-value">${esc(money(category.monthly))}/mo &#183; ${category.signals.length} signal${category.signals.length === 1 ? '' : 's'}</text></g>`);
    });
    const hubMarkup = hubs.map(hub => `<circle cx="220" cy="${hub.y}" r="15" fill="${hub.color}"/><text x="190" y="${hub.y + 5}" text-anchor="end" class="money-node-label">${esc(hub.label)}</text>`).join('');
    return `<div class="money-network-wrap" role="region" aria-label="Category signal relationship network" tabindex="0"><svg class="money-network" viewBox="0 0 840 ${height}" role="group" aria-label="Connections show which warning signals apply to each category, not money transfers.">${paths.join('')}${hubMarkup}${nodes.join('')}</svg></div>
      <p class="pro-footnote">Each link is one signal, not a payment. Larger category nodes mean more signals agree; link width and position do not measure spending. Exact monthly averages are beside each category.</p>`;
  }

  globalThis.FinanceMoneyVisuals = { mosaic, signalNetwork };
})();
