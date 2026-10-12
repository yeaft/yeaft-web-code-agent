/** Browser-only defensive projection of the v1 response contract. Never executes markup or fetches data. */
const text = (value, max = 2000) => typeof value === 'string' && value.length <= max && !!value.trim();
const list = (value, max, min = 1) => Array.isArray(value) && value.length >= min && value.length <= max;
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12;
const optional = (value, max) => value === undefined || text(value, max);

export function safeResponseUrl(value) {
  if (!text(value, 2000) || /[\u0000-\u0020\u007f]/.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2000 ? url.href : '';
  } catch { return ''; }
}

function validBlock(b) {
  if (!b || typeof b !== 'object' || !optional(b.title, 160)) return false;
  switch (b.type) {
    case 'markdown': return text(b.text, 12000);
    case 'cards': return list(b.items, 8) && b.items.every(i => i && text(i.title, 160) && text(i.text) && optional(i.label, 80));
    case 'metrics': return list(b.items, 8) && b.items.every(i => i && text(i.label, 120) && text(i.value, 120) && optional(i.detail, 240));
    case 'table': return list(b.columns, 8) && b.columns.every(c => text(c, 120)) && list(b.rows, 50) && b.rows.every(r => list(r, 8) && r.length === b.columns.length && r.every(c => text(c, 1000)));
    case 'chart': return ['bar', 'line'].includes(b.style) && optional(b.unit, 60) && list(b.labels, 40) && b.labels.every(l => text(l, 120)) && list(b.series, 4) && b.series.every(s => s && text(s.label, 120) && list(s.values, 40) && s.values.length === b.labels.length && s.values.every(finite));
    case 'timeline': return list(b.items, 16) && b.items.every(i => i && text(i.label, 120) && text(i.title, 160) && text(i.text));
    case 'diagram': {
      if (!list(b.nodes, 12) || !list(b.edges, 24, 0) || !b.nodes.every(n => n && text(n.id, 40) && text(n.label, 160))) return false;
      const ids = new Set(b.nodes.map(n => n.id));
      return ids.size === b.nodes.length && b.edges.every(e => e && ids.has(e.from) && ids.has(e.to) && optional(e.label, 120));
    }
    case 'image': return !!safeResponseUrl(b.url) && text(b.alt, 240) && optional(b.caption, 1000);
    case 'link': return !!safeResponseUrl(b.url) && text(b.text, 1000);
    case 'map': return list(b.points, 20) && b.points.every(p => p && text(p.label, 160) && finite(p.latitude) && Math.abs(p.latitude) <= 90 && finite(p.longitude) && Math.abs(p.longitude) <= 180 && optional(p.detail, 1000));
    default: return false;
  }
}

/** Preserve summary even if a newer/invalid presentation cannot be drawn; reject invalid blocks independently. */
export function projectPresentation(input, fallbackText = '') {
  const summary = text(input?.summary, 8000) ? input.summary : typeof fallbackText === 'string' && fallbackText.trim() ? fallbackText : typeof input?.summary === 'string' ? input.summary.slice(0, 8000) : '';
  const title = text(input?.title, 160) ? input.title : '';
  const base = { title, summary, phase: input?.phase === 'progress' ? 'progress' : 'final', blocks: [], invalid: true };
  if (input?.version !== 1 || !text(input.summary, 8000) || !list(input.blocks, 12)) return base;
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).length > 49152) return base;
    return { ...base, invalid: false, blocks: input.blocks.map(b => {
      if (!validBlock(b)) return { type: 'unsupported' };
      const result = { ...b, url: b.url ? safeResponseUrl(b.url) : undefined };
      if (b.type === 'cards') result.items = b.items.map(item => ({ ...item,
        image: item.image && safeResponseUrl(item.image.url) && text(item.image.alt, 240)
          && (item.image.fit === undefined || ['cover', 'contain'].includes(item.image.fit))
          ? { url: safeResponseUrl(item.image.url), alt: item.image.alt, fit: item.image.fit || 'cover' } : undefined,
        url: item.url ? safeResponseUrl(item.url) : undefined,
      }));
      if (b.type === 'map') result.embed = safeResponseMapEmbed(b.embed) || undefined;
      return result;
    }) };
  } catch { return base; }
}

export function chartGeometry(block) {
  const values = block.series.flatMap(s => s.values);
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const range = max - min || 1;
  const y = value => 204 - (value - min) / range * 168;
  const step = 496 / block.labels.length;
  const zero = y(0);
  return {
    zero, min, max,
    ticks: [min, min + (max - min) / 2, max].map(value => ({ value, y: y(value) })),
    labels: block.labels.map((label, i) => ({ label, x: 64 + (i + 0.5) * step, show: block.labels.length <= 8 || i % Math.ceil(block.labels.length / 6) === 0 })),
    series: block.series.map((s, si) => {
      const points = s.values.map((value, i) => {
        const width = step * 0.7 / block.series.length;
        return { value, x: 64 + (i + 0.5) * step, y: y(value), barX: 64 + i * step + step * 0.15 + si * width, barY: Math.min(zero, y(value)), width: width * 0.9, height: Math.abs(y(value) - zero) };
      });
      return { label: s.label, points, path: points.map(p => `${p.x},${p.y}`).join(' ') };
    }),
  };
}

export function diagramGeometry(block) {
  const nodes = block.nodes.map((n, i) => ({ ...n, x: 100 + i % 3 * 190, y: 46 + Math.floor(i / 3) * 112 }));
  const byId = new Map(nodes.map(n => [n.id, n]));
  return { nodes, height: Math.ceil(nodes.length / 3) * 112,
    edges: block.edges.map(e => {
      const from = byId.get(e.from), to = byId.get(e.to);
      const dx = to.x - from.x, dy = to.y - from.y, distance = Math.hypot(dx, dy) || 1;
      const offset = Math.min(dx ? 84 / Math.abs(dx) : Infinity, dy ? 26 / Math.abs(dy) : Infinity);
      const self = from.id === to.id;
      const x1 = self ? from.x - 24 : from.x + dx * offset;
      const y1 = self ? from.y - 24 : from.y + dy * offset;
      const x2 = self ? from.x + 24 : to.x - dx * offset;
      const y2 = self ? from.y - 24 : to.y - dy * offset;
      return { ...e, x1, y1, x2, y2, loop: self ? `M ${x1} ${y1} C ${x1 - 32} ${y1 - 28}, ${x2 + 32} ${y2 - 28}, ${x2} ${y2}` : '',
        arrow: self ? `${x2},${y2} ${x2 + 1},${y2 - 10} ${x2 + 9},${y2 - 5}` : `${x2},${y2} ${x2 - dx / distance * 9 + dy / distance * 5},${y2 - dy / distance * 9 - dx / distance * 5} ${x2 - dx / distance * 9 - dy / distance * 5},${y2 - dy / distance * 9 + dx / distance * 5}` };
    }),
  };
}

/** Equirectangular coordinate sketch with real extents; intentionally not a basemap or navigation map. */
export function mapGeometry(block) {
  const lats = block.points.map(p => p.latitude), lngs = block.points.map(p => p.longitude);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const latSpan = Math.max(0.02, Math.max(...lats) - Math.min(...lats)) * 1.35;
  const lngSpan = Math.max(0.02, Math.max(...lngs) - Math.min(...lngs)) * 1.35;
  const south = Math.max(-90, centerLat - latSpan / 2), north = Math.min(90, centerLat + latSpan / 2);
  const west = Math.max(-180, centerLng - lngSpan / 2), east = Math.min(180, centerLng + lngSpan / 2);
  return { south, north, west, east, points: block.points.map((p, i) => ({ ...p, number: i + 1,
    x: 60 + (p.longitude - west) / (east - west) * 480,
    y: 236 - (p.latitude - south) / (north - south) * 192,
  })) };
}

/** Convert marked tokens into a small non-executable tree. HTML and images stay literal text. */
export function responseMarkdown(source) {
  try {
    if (!globalThis.marked?.lexer) return [{ tag: 'p', text: source }];
    let remaining = 1500;
    const convert = (tokens, depth = 0) => (tokens || []).slice(0, 1500).map(token => {
      if (--remaining < 0 || depth > 12) throw new Error('Markdown token budget exceeded');
      const children = () => convert(token.tokens || [], depth + 1);
      switch (token.type) {
        case 'space': return { tag: 'span', text: '' };
        case 'heading': return { tag: `h${Math.min(6, Math.max(3, token.depth + 2))}`, children: children() };
        case 'paragraph': return { tag: 'p', children: children() };
        case 'text': return token.tokens ? { tag: 'span', children: children() } : { tag: 'span', text: token.text };
        case 'strong': return { tag: 'strong', children: children() };
        case 'em': return { tag: 'em', children: children() };
        case 'del': return { tag: 'del', children: children() };
        case 'codespan': return { tag: 'code', text: token.text };
        case 'code': return { tag: 'pre', children: [{ tag: 'code', text: token.text }] };
        case 'blockquote': return { tag: 'blockquote', children: children() };
        case 'br': return { tag: 'br' };
        case 'hr': return { tag: 'hr' };
        case 'escape': return { tag: 'span', text: token.text };
        case 'link': return { tag: safeResponseUrl(token.href) ? 'a' : 'span', href: safeResponseUrl(token.href), children: children() };
        case 'list': return { tag: token.ordered ? 'ol' : 'ul', children: token.items.map(i => ({ tag: 'li', children: convert(i.tokens, depth + 1) })) };
        case 'table': return { tag: 'div', className: 'response-table-scroll', children: [{ tag: 'table', children: [
          { tag: 'thead', children: [{ tag: 'tr', children: token.header.map(c => ({ tag: 'th', children: convert(c.tokens, depth + 1) })) }] },
          { tag: 'tbody', children: token.rows.map(row => ({ tag: 'tr', children: row.map(c => ({ tag: 'td', children: convert(c.tokens, depth + 1) })) })) },
        ] }] };
        default: return { tag: 'span', text: token.raw || token.text || '' };
      }
    });
    return convert(globalThis.marked.lexer(source));
  } catch { return [{ tag: 'p', text: source }]; }
}

/** Defense-in-depth for persisted, replayed data; never accept an arbitrary frame URL. */
export function safeResponseMapEmbed(embed) {
  if (!embed || typeof embed !== 'object' || Array.isArray(embed)
    || Object.keys(embed).some(key => !['provider', 'url'].includes(key))) return null;
  if (embed.provider === 'openstreetmap' && embed.url === undefined) return { provider: 'openstreetmap' };
  if (embed.provider !== 'google' || !safeResponseUrl(embed.url)) return null;
  const url = new URL(safeResponseUrl(embed.url));
  const params = [...url.searchParams];
  return url.origin === 'https://www.google.com' && url.pathname === '/maps/embed' && !url.hash
    && params.length === 1 && params[0][0] === 'pb' && /^![^\s\u0000-\u001f\u007f]+$/.test(params[0][1])
    ? { provider: 'google', url: url.href } : null;
}

/** Generated official OSM embed: one selected marker; all coordinates stay in the list. */
export function mapEmbedUrl(block, pointIndex = 0) {
  const embed = safeResponseMapEmbed(block?.embed);
  if (!embed || !validBlock(block)) return '';
  if (embed.provider === 'google') return embed.url;
  const point = block.points[pointIndex] || block.points[0];
  // OSM tiles use Web Mercator: show a supported region, but never alter the actual marker.
  const latitude = Math.max(-85, Math.min(85, point.latitude));
  const west = Math.max(-180, point.longitude - 0.025), east = Math.min(180, point.longitude + 0.025);
  const south = Math.max(-85.0511, latitude - 0.015), north = Math.min(85.0511, latitude + 0.015);
  const params = new URLSearchParams({ bbox: [west, south, east, north].join(','), layer: 'mapnik',
    marker: `${point.latitude},${point.longitude}` });
  return `https://www.openstreetmap.org/export/embed.html?${params}`;
}

/** Provider pages are links, not frame targets; normal clicks stay in the owning browser. */
export function mapProviderUrl(block, pointIndex = 0) {
  if (!validBlock(block)) return '';
  const point = block.points[pointIndex] || block.points[0];
  const coords = `${point.latitude},${point.longitude}`;
  if (block.embed?.provider === 'google') return `https://www.google.com/maps/search/?${new URLSearchParams({ api: '1', query: coords })}`;
  return `https://www.openstreetmap.org/?${new URLSearchParams({ mlat: String(point.latitude), mlon: String(point.longitude) })}#map=15/${point.latitude}/${point.longitude}`;
}

/** Directions are calculated by Google, not by the assistant. No app geolocation permission. */
export function mapDirectionsUrl(point) {
  if (!point || !finite(point.latitude) || Math.abs(point.latitude) > 90
    || !finite(point.longitude) || Math.abs(point.longitude) > 180) return '';
  return `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', destination: `${point.latitude},${point.longitude}` })}`;
}
