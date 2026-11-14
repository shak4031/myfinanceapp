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

  let marketId = 0;

  // Tilted 3D pie: front side walls are drawn in a layer beneath the top faces so slices never paint over each other.
  // Interactive parts carry data-pie-index; lifting a slice is a CSS translate along --lx/--ly.
  let pieId = 0;
  function pie3d(items, { label = 'Spending by category', tilt = 0.52, depth = 26 } = {}) {
    const id = `pie3d-${++pieId}`;
    const width = 360, cx = 180, rx = 148, ry = rx * tilt, cy = ry + 18, height = Math.ceil(cy + ry + depth + 22);
    const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
    const shade = (hex, amount) => {
      const value = parseInt(String(hex).replace('#', ''), 16);
      if (!Number.isFinite(value)) return hex;
      const mix = channel => Math.round(amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount);
      return `rgb(${mix(value >> 16 & 255)},${mix(value >> 8 & 255)},${mix(value & 255)})`;
    };
    const at = (angle, drop = 0) => `${n(cx + rx * Math.cos(angle))},${n(cy + ry * Math.sin(angle) + drop)}`;
    const TAU = Math.PI * 2;
    let start = -Math.PI / 2;
    const slices = items.map((item, index) => {
      const sweep = item.value / total * TAU, a0 = start, a1 = start + sweep, mid = a0 + sweep / 2;
      start = a1;
      const share = item.value / total;
      const whole = sweep >= TAU - 1e-6;
      const top = whole
        ? `M${n(cx - rx)},${n(cy)}A${n(rx)},${n(ry)} 0 1 1 ${n(cx + rx)},${n(cy)}A${n(rx)},${n(ry)} 0 1 1 ${n(cx - rx)},${n(cy)}Z`
        : `M${cx},${n(cy)}L${at(a0)}A${n(rx)},${n(ry)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${at(a1)}Z`;
      // Only the part of the rim facing the viewer (sin > 0) is visible.
      const walls = [];
      for (let k = -1; k <= 2; k++) {
        const s = Math.max(a0, k * TAU), e = Math.min(a1, k * TAU + Math.PI);
        if (e - s > 1e-4) walls.push(`M${at(s)}A${n(rx)},${n(ry)} 0 0 1 ${at(e)}L${at(e, depth)}A${n(rx)},${n(ry)} 0 0 0 ${at(s, depth)}Z`);
      }
      const cut = angle => `M${cx},${n(cy)}L${at(angle)}L${at(angle, depth)}L${cx},${n(cy + depth)}Z`;
      const lift = whole ? [0, 0] : [Math.cos(mid) * 12, Math.sin(mid) * 12 * tilt];
      const style = `--lx:${n(lift[0])}px;--ly:${n(lift[1])}px;--delay:${index * 45}ms`;
      const percent = Math.round(share * 100);
      const labelAt = whole ? [cx, cy] : [cx + rx * 0.62 * Math.cos(mid), cy + ry * 0.62 * Math.sin(mid)];
      const flagAt = whole ? [cx, cy - ry * 0.55] : [cx + rx * 0.86 * Math.cos(mid), cy + ry * 0.86 * Math.sin(mid)];
      return { item, index, mid, style, share, percent, top, walls, cuts: whole ? [] : [cut(a0), cut(a1)], labelAt, flagAt };
    });
    const sides = [...slices].sort((a, b) => Math.sin(a.mid) - Math.sin(b.mid)).map(slice => `<g class="pie3d-side" data-pie-index="${slice.index}" style="${slice.style}" aria-hidden="true">
      ${slice.cuts.map(d => `<path class="pie3d-cut" d="${d}" fill="${shade(slice.item.color, -0.42)}"/>`).join('')}
      ${slice.walls.map(d => `<path d="${d}" fill="${shade(slice.item.color, -0.3)}"/><path d="${d}" fill="url(#${id}-wall)"/>`).join('')}</g>`).join('');
    const tops = slices.map(slice => `<g class="pie3d-top" data-pie-index="${slice.index}" style="${slice.style}" role="button" tabindex="0" aria-label="${esc(`${slice.item.label}: ${compact(slice.item.value)}, ${slice.percent}% of spending`)}">
      <path class="pie3d-face" d="${slice.top}" fill="${slice.item.color}" stroke="${shade(slice.item.color, 0.35)}" stroke-width=".8"/>
      <path d="${slice.top}" fill="url(#${id}-gloss)" pointer-events="none"/>
      ${slice.share >= 0.06 ? `<text class="pie3d-pct" x="${n(slice.labelAt[0])}" y="${n(slice.labelAt[1] + 4)}" text-anchor="middle" pointer-events="none">${slice.percent}%</text>` : ''}
      <title>${esc(`${slice.item.label}: ${compact(slice.item.value)} (${slice.percent}%)`)}</title></g>`).join('');
    // Status badges (e.g. over budget) sit above every face so a neighbour never covers them; hidden until flagged.
    const flags = slices.map(slice => `<g class="pie3d-flag" data-pie-index="${slice.index}" style="${slice.style}" aria-hidden="true" pointer-events="none">
      <g transform="translate(${n(slice.flagAt[0])} ${n(slice.flagAt[1])})"><circle class="pie3d-flag-ring" r="9"/><circle r="8"/><text y="4" text-anchor="middle">!</text></g></g>`).join('');
    return `<svg class="pie3d" viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(label)}">
      <defs>
        <radialGradient id="${id}-gloss" cx="38%" cy="22%" r="85%"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".5" stop-color="#fff" stop-opacity=".08"/><stop offset="1" stop-color="#0f172a" stop-opacity=".12"/></radialGradient>
        <linearGradient id="${id}-wall" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#0f172a" stop-opacity=".35"/><stop offset=".45" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#0f172a" stop-opacity=".4"/></linearGradient>
        <radialGradient id="${id}-shadow"><stop offset="0" stop-color="#0f172a" stop-opacity=".28"/><stop offset="1" stop-color="#0f172a" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse cx="${cx}" cy="${n(cy + depth + 8)}" rx="${n(rx * 1.04)}" ry="${n(ry * 0.9)}" fill="url(#${id}-shadow)"/>
      <g class="pie3d-sides">${sides}</g><g class="pie3d-tops">${tops}</g><g class="pie3d-flags">${flags}</g></svg>`;
  }
  function market({ series, bands = [], xMax, xTicks = [], pointLabel = String, width = 1000, height = 320, label = 'Financial chart', boundary = null }) {
    const id = `market-${++marketId}`;
    const pad = { l: 62, r: 82, t: 28, b: 34 };
    const valid = p => Number.isFinite(p.x) && Number.isFinite(p.v);
    const all = series.flatMap(s => s.points.filter(valid).flatMap(p => s.type === 'candles' ? [p.v, p.open, p.low, p.high].filter(Number.isFinite) : [p.v]));
    if (!all.length) return '<p class="pro-empty">No recorded values available for this chart.</p>';
    const top = niceMax(Math.max(...all, 0));
    const bottom = Math.min(...all, 0) < 0 ? -niceMax(-Math.min(...all)) : 0;
    const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
    const x = value => pad.l + value / (xMax || 1) * iw;
    const y = value => pad.t + (top - value) / (top - bottom || 1) * ih;
    const baseline = y(0);
    const colors = { cyan: '#38d9f5', violet: '#ae9bff', amber: '#f6c76a', green: '#50dfb1', rose: '#ff7899', muted: '#8faac5' };
    const tone = s => colors[s.tone] || colors.cyan;
    const exact = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
    const gradients = series.map((s, i) => `<linearGradient id="${id}-fill-${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${tone(s)}" stop-opacity="${s.type === 'bars' ? '.85' : '.32'}"/><stop offset="100%" stop-color="${tone(s)}" stop-opacity="${s.type === 'bars' ? '.18' : '.015'}"/></linearGradient>`).join('');
    const grid = Array.from({ length: 5 }, (_, i) => {
      const v = top - (top - bottom) * i / 4, gy = n(y(v));
      return `<line class="market-grid" x1="${pad.l}" x2="${width - pad.r}" y1="${gy}" y2="${gy}"/><text class="market-axis" x="${pad.l - 10}" y="${gy + 4}" text-anchor="end">${compact(v)}</text>`;
    }).join('') + xTicks.map(t => `<line class="market-grid market-grid-vertical" x1="${n(x(t.x))}" x2="${n(x(t.x))}" y1="${pad.t}" y2="${height - pad.b}"/><text class="market-axis" x="${n(x(t.x))}" y="${height - 12}" text-anchor="middle">${esc(t.label)}</text>`).join('');
    const zero = bottom < 0 ? `<line class="market-zero" x1="${pad.l}" x2="${width - pad.r}" y1="${n(baseline)}" y2="${n(baseline)}"/><text class="market-axis" x="${pad.l - 10}" y="${n(baseline - 5)}" text-anchor="end">$0</text>` : '';
    const split = boundary && boundary.x >= 0 && boundary.x <= xMax ? `<rect class="market-future" x="${n(x(boundary.x))}" y="${pad.t}" width="${n(x(xMax) - x(boundary.x))}" height="${ih}"/><line class="market-boundary" x1="${n(x(boundary.x))}" x2="${n(x(boundary.x))}" y1="${pad.t}" y2="${height - pad.b}"/><text class="market-boundary-label" x="${n(Math.min(width - pad.r - 100, Math.max(pad.l + 4, x(boundary.x) + 8)))}" y="17">${esc(boundary.label)}</text>` : '';
    const ranges = bands.map(band => {
      const lower = series[band.lower], upper = series[band.upper];
      const segments = [];
      let segment = [];
      for (const point of lower.points) {
        const high = upper.points.find(p => p.x === point.x);
        if (valid(point) && high && valid(high)) segment.push({ x: point.x, low: point.v, high: high.v });
        else if (segment.length) { segments.push(segment); segment = []; }
      }
      if (segment.length) segments.push(segment);
      return segments.map(points => `<path class="market-band" d="${points.map((p, i) => `${i ? 'L' : 'M'}${n(x(p.x))},${n(y(p.high))}`).join(' ')} ${[...points].reverse().map(p => `L${n(x(p.x))},${n(y(p.low))}`).join(' ')} Z" fill="${tone(band)}" fill-opacity="${band.opacity ?? .15}"><title>${esc(band.name)}</title></path>`).join('');
    }).join('');
    const lines = series.map((s, i) => {
      const points = s.points.filter(valid);
      if (!points.length || s.hidden) return '';
      if (s.type === 'candles') {
        const bw = Math.min(24, iw / Math.max(points.length, 1) * .35);
        return points.map(p => {
          const color = colors[p.v >= p.open ? 'green' : 'rose'];
          return `<g class="market-candle"><line x1="${n(x(p.x))}" x2="${n(x(p.x))}" y1="${n(y(p.high))}" y2="${n(y(p.low))}" stroke="${color}" stroke-width="2"/><rect x="${n(x(p.x) - bw / 2)}" y="${n(Math.min(y(p.open), y(p.v)))}" width="${bw}" height="${Math.max(2, n(Math.abs(y(p.open) - y(p.v))))}" rx="2" fill="${color}" fill-opacity=".7" stroke="${color}"/></g>`;
        }).join('');
      }
      if (s.type === 'bars') {
        const bw = Math.min(30, iw / Math.max(points.length, 1) * .48);
        return points.map(p => `<rect class="market-volume" x="${n(x(p.x) - bw / 2)}" y="${n(Math.min(y(p.v), baseline))}" width="${n(bw)}" height="${n(Math.abs(y(p.v) - baseline))}" rx="3" fill="url(#${id}-fill-${i})" stroke="${tone(s)}" stroke-opacity=".5"/>`).join('');
      }
      const segments = [];
      let segment = [];
      for (const p of s.points) {
        if (valid(p)) segment.push(p);
        else if (segment.length) { segments.push(segment); segment = []; }
      }
      if (segment.length) segments.push(segment);
      const paths = segments.map(points => {
        const d = points.map((p, index) => `${index ? 'L' : 'M'}${n(x(p.x))},${n(y(p.v))}`).join(' ');
        return `${s.area ? `<path d="${d} L${n(x(points.at(-1).x))},${n(baseline)} L${n(x(points[0].x))},${n(baseline)} Z" fill="url(#${id}-fill-${i})"/>` : ''}<path class="market-line${s.dashed ? ' is-projected' : ''}" d="${d}" stroke="${tone(s)}"/>`;
      }).join('');
      const last = points.at(-1);
      return `${paths}${points.map(p => `<circle class="market-point" cx="${n(x(p.x))}" cy="${n(y(p.v))}" r="${points.length === 1 ? 4 : 2.5}" fill="${tone(s)}"/>`).join('')}${s.endpoint ? `<line class="market-price-guide" x1="${pad.l}" x2="${width - pad.r}" y1="${n(y(last.v))}" y2="${n(y(last.v))}" stroke="${tone(s)}"/><circle class="market-end-halo" cx="${n(x(last.x))}" cy="${n(y(last.v))}" r="9" fill="${tone(s)}"/><circle cx="${n(x(last.x))}" cy="${n(y(last.v))}" r="4" fill="${tone(s)}" stroke="#0c1e35" stroke-width="2"/><rect x="${width - pad.r + 5}" y="${n(y(last.v) - 11)}" width="72" height="22" rx="5" fill="${tone(s)}"/><text class="market-price" x="${width - pad.r + 41}" y="${n(y(last.v) + 4)}" text-anchor="middle">${esc(compact(last.v))}</text>` : ''}`;
    }).join('');
    const positions = [...new Set(series.flatMap(s => s.points.filter(valid).map(p => p.x)))].sort((a, b) => a - b);
    const details = positions.map((position, index) => {
      const entries = series.flatMap(s => {
        const p = s.points.find(p => valid(p) && p.x === position);
        return p ? [{ name: s.name, value: p.v, color: tone(s) }] : [];
      });
      return { position, entries, title: pointLabel(position), index };
    });
    const targets = details.map(({ position, entries, title, index }) => {
      const left = index ? (x(positions[index - 1]) + x(position)) / 2 : pad.l;
      const right = index < positions.length - 1 ? (x(position) + x(positions[index + 1])) / 2 : width - pad.r;
      const tw = Math.min(260, iw), th = 32 + entries.length * 22;
      const tx = Math.max(pad.l, Math.min(width - pad.r - tw, x(position) + 12));
      const description = `${title}. ${entries.map(e => `${e.name}: ${exact(e.value)}`).join('. ')}`;
      return `<g class="market-inspect" tabindex="0" role="img" aria-label="${esc(description)}"><rect class="market-hit" x="${n(left)}" y="${pad.t}" width="${n(right - left)}" height="${ih}"/><g class="market-inspection" pointer-events="none"><line class="market-crosshair" x1="${n(x(position))}" x2="${n(x(position))}" y1="${pad.t}" y2="${height - pad.b}"/><rect class="market-tooltip" x="${n(tx)}" y="${pad.t + 8}" width="${tw}" height="${th}" rx="8"/><text class="market-tooltip-title" x="${n(tx + 12)}" y="${pad.t + 29}">${esc(title)}</text>${entries.map((e, i) => `<text class="market-tooltip-label" x="${n(tx + 12)}" y="${pad.t + 51 + i * 22}" fill="${e.color}">${esc(e.name)}</text><text class="market-tooltip-value" x="${n(tx + tw - 12)}" y="${pad.t + 51 + i * 22}" text-anchor="end">${esc(exact(e.value))}</text>`).join('')}</g></g>`;
    }).join('');
    const table = `<details class="market-data"><summary>Exact chart values</summary><div class="table-scroll"><table><caption>${esc(label)}. Only supplied data points are listed; blank cells have no value.</caption><thead><tr><th scope="col">Period</th>${series.map(s => `<th scope="col">${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${details.map(d => `<tr><th scope="row">${esc(d.title)}</th>${series.map(s => {
      const p = s.points.find(p => valid(p) && p.x === d.position);
      return `<td>${p ? esc(exact(p.v)) : '&mdash;'}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div></details>`;
    return `<div class="market-chart"><svg class="pro-chart pro-market-chart" viewBox="0 0 ${width} ${height}" role="group" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">${esc(label)}</title><desc id="${id}-desc">Hover, tap or tab through data points for exact values. Dashed lines are estimates; lines connect supplied points without inventing intermediate values. Shaded ranges are described in the chart notes.</desc><defs>${gradients}</defs><rect class="market-backdrop" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" rx="4"/>${split}${grid}${zero}${ranges}${lines}${targets}</svg><p class="market-chart-hint">Hover, tap or tab to inspect &middot; USD</p>${table}</div>`;
  }

  window.ProCharts = { PALETTE, bars, plot, market, sparkline, trendLine, donut, pie3d, compact, monthShort, niceMax };
})();
