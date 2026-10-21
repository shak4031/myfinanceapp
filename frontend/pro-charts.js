// Dependency-free SVG charts for MyFinance Pro. Every chart scales with its container via viewBox.
(() => {
  const PALETTE = ['#10b981', '#38bdf8', '#818cf8', '#f59e0b', '#fb7185', '#fb923c', '#2dd4bf', '#a78bfa', '#f472b6', '#94a3b8'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const n = value => Math.round(value * 10) / 10;
  const niceMax = value => {
    if (!(value > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(value)), unit = value / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
  };
  const compact = value => {
    const abs = Math.abs(value), sign = value < 0 ? '-' : '';
    if (abs >= 1e6) return `${sign}$${n(abs / 1e6)}m`;
    if (abs >= 1e3) return `${sign}$${abs >= 1e5 ? Math.round(abs / 1e3) : n(abs / 1e3)}k`;
    return `${sign}$${Math.round(abs)}`;
  };
  const monthShort = key => {
    const [year, month] = String(key).split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'short' });
  };

  // Monthly bars with optional overlay lines (e.g. a moving average).
  function bars({ labels, values, lines = [], width = 640, height = 230, label = 'Chart', highlightLast = true }) {
    const pad = { l: 50, r: 14, t: 16, b: 30 };
    const all = [...values, ...lines.flatMap(line => line.values.filter(v => v != null))];
    const max = niceMax(Math.max(...all, 0));
    const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b, step = iw / Math.max(1, values.length);
    const bw = Math.min(36, step * 0.6);
    const y = v => pad.t + ih - (Math.max(0, v) / max) * ih;
    const cx = i => pad.l + step * i + step / 2;
    const grid = [0, 1, 2, 3, 4].map(i => {
      const v = (max / 4) * i, gy = n(y(v));
      return `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${gy}" y2="${gy}"/><text class="axis" x="${pad.l - 8}" y="${gy + 4}" text-anchor="end">${compact(v)}</text>`;
    }).join('');
    const rects = values.map((v, i) => {
      const top = y(v), h = Math.max(v > 0 ? 2 : 0, pad.t + ih - top);
      return `<rect class="bar${highlightLast && i === values.length - 1 ? ' is-current' : ''}" x="${n(cx(i) - bw / 2)}" y="${n(pad.t + ih - h)}" width="${n(bw)}" height="${n(h)}" rx="5"><title>${esc(labels[i])}: ${compact(v)}</title></rect>`;
    }).join('');
    const overlays = lines.map(line => {
      const points = line.values.map((v, i) => v == null ? null : `${n(cx(i))},${n(y(v))}`).filter(Boolean);
      return points.length > 1 ? `<polyline class="line ${line.className || ''}" points="${points.join(' ')}"/>` : '';
    }).join('');
    const ticks = labels.map((text, i) => `<text class="axis" x="${n(cx(i))}" y="${height - 9}" text-anchor="middle">${esc(text)}</text>`).join('');
    return `<svg class="pro-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${grid}${rects}${overlays}${ticks}</svg>`;
  }

  // Line plot over an index domain. Series: { points: [{x, v}], className, dashed, area }.
  function plot({ series, xMax, xTicks = [], width = 640, height = 230, label = 'Chart' }) {
    const pad = { l: 56, r: 16, t: 16, b: 30 };
    const all = series.flatMap(s => s.points.map(p => p.v)).filter(Number.isFinite);
    const top = niceMax(Math.max(...all, 0)), bottom = Math.min(0, ...all) < 0 ? -niceMax(-Math.min(...all)) : 0;
    const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
    const x = value => pad.l + (xMax ? value / xMax : 0) * iw;
    const y = value => pad.t + ((top - value) / (top - bottom || 1)) * ih;
    const grid = [0, 1, 2, 3, 4].map(i => {
      const v = top - ((top - bottom) / 4) * i, gy = n(y(v));
      return `<line class="grid${Math.abs(v) < 1e-9 ? ' zero' : ''}" x1="${pad.l}" x2="${width - pad.r}" y1="${gy}" y2="${gy}"/><text class="axis" x="${pad.l - 8}" y="${gy + 4}" text-anchor="end">${compact(v)}</text>`;
    }).join('');
    const lines = series.map(s => {
      if (!s.points.length) return '';
      const coords = s.points.map(p => `${n(x(p.x))},${n(y(p.v))}`).join(' ');
      const first = s.points[0], last = s.points[s.points.length - 1];
      const area = s.area ? `<polygon class="area ${s.className || ''}" points="${n(x(first.x))},${n(y(Math.max(bottom, 0)))} ${coords} ${n(x(last.x))},${n(y(Math.max(bottom, 0)))}"/>` : '';
      const dot = s.dot ? `<circle class="dot ${s.className || ''}" cx="${n(x(last.x))}" cy="${n(y(last.v))}" r="4.5"/>` : '';
      return `${area}<polyline class="line ${s.className || ''}${s.dashed ? ' dashed' : ''}" points="${coords}"/>${dot}`;
    }).join('');
    const ticks = xTicks.map(t => `<text class="axis" x="${n(x(t.x))}" y="${height - 9}" text-anchor="middle">${esc(t.label)}</text>`).join('');
    return `<svg class="pro-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${grid}${lines}${ticks}</svg>`;
  }

  function sparkline(values, { width = 120, height = 34, className = '' } = {}) {
    const max = Math.max(...values), min = Math.min(...values), range = max - min || 1;
    const step = width / Math.max(1, values.length - 1);
    const points = values.map((v, i) => `${n(i * step)},${n(height - 3 - ((v - min) / range) * (height - 6))}`);
    const last = points[points.length - 1]?.split(',') || [0, height];
    return `<svg class="pro-spark ${className}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,${height} ${points.join(' ')} ${width},${height}"/><polyline points="${points.join(' ')}"/><circle cx="${last[0]}" cy="${last[1]}" r="2.6"/></svg>`;
  }

  function trendLine(values, labels, { width = 280, height = 88 } = {}) {
    const max = niceMax(Math.max(...values, 0)), avg = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const x = i => 6 + i * (width - 12) / Math.max(1, values.length - 1);
    const y = v => height - 6 - (v / max) * (height - 14);
    const points = values.map((v, i) => `${n(x(i))},${n(y(v))}`).join(' ');
    const dots = values.map((v, i) => {
      return `<circle cx="${n(x(i))}" cy="${n(y(v))}" r="${i === values.length - 1 ? 4 : 2.5}"><title>${esc(labels[i])}: ${esc(Number(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' }))}</title></circle>`;
    }).join('');
    return `<svg class="pro-category-line" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(`Monthly spending trend, ${labels[0]} to ${labels[labels.length - 1]}. Dashed line: monthly average ${compact(avg)}.`)}"><title>${esc(labels.map((label, i) => `${label}: ${compact(values[i])}`).join('; '))}</title><line class="trend-average" x1="6" x2="${width - 6}" y1="${n(y(avg))}" y2="${n(y(avg))}"/><polyline points="${points}"/>${dots}</svg>`;
  }

  // Donut built from stroked circle segments, with a small gap between slices.
  function donut(items, { size = 240, thickness = 30, centerLabel = '', centerValue = '' } = {}) {
    const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
    const r = (size - thickness) / 2, c = 2 * Math.PI * r;
    let offset = 0;
    const segments = items.map((item, i) => {
      const length = (item.value / total) * c, gap = items.length > 1 ? Math.min(2.5, length / 3) : 0;
      const segment = `<circle class="slice" data-slice="${i}" cx="${size / 2}" cy="${size / 2}" r="${n(r)}" stroke="${item.color}" stroke-width="${thickness}" stroke-dasharray="${n(Math.max(0, length - gap))} ${n(c)}" stroke-dashoffset="${n(-offset)}"><title>${esc(item.label)}: ${compact(item.value)} (${Math.round((item.value / total) * 100)}%)</title></circle>`;
      offset += length;
      return segment;
    }).join('');
    return `<svg class="pro-donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="Spending by category"><g transform="rotate(-90 ${size / 2} ${size / 2})"><circle class="track" cx="${size / 2}" cy="${size / 2}" r="${n(r)}" stroke-width="${thickness}"/>${segments}</g><text class="donut-label" x="50%" y="46%" text-anchor="middle">${esc(centerLabel)}</text><text class="donut-value" x="50%" y="58%" text-anchor="middle">${esc(centerValue)}</text></svg>`;
  }

  window.ProCharts = { PALETTE, bars, plot, sparkline, trendLine, donut, compact, monthShort, niceMax };
})();
