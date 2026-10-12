/** Shared, bounded user-visible response contract for native Sessions and Persons.
 * Contains no executable markup, filesystem access or network requests. Runtime
 * owns identity/phase; summary remains useful without the rich client.
 */
const str = (maxLength = 2000) => ({ type: 'string', maxLength });
const arr = (items, maxItems, minItems = 1) => ({ type: 'array', items, minItems, maxItems });
const obj = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const block = (type, properties, required) => obj({ type: { type: 'string', enum: [type] }, title: str(160), ...properties }, ['type', ...required]);
export const PRESENTATION_SCHEMA = obj({
  title: str(160),
  summary: str(8000),
  phase: { type: 'string', enum: ['progress', 'final'] },
  blocks: arr({ anyOf: [
    block('markdown', { text: str(12000) }, ['text']),
    block('cards', { items: arr(obj({ title: str(160), text: str(2000), label: str(80), image: obj({ url: str(2000), alt: str(240), fit: { type: 'string', enum: ['cover', 'contain'] } }, ['url', 'alt']), url: str(2000) }, ['title', 'text']), 8) }, ['items']),
    block('metrics', { items: arr(obj({ label: str(120), value: str(120), detail: str(240) }, ['label', 'value']), 8) }, ['items']),
    block('table', { columns: arr(str(120), 8), rows: arr(arr(str(1000), 8, 1), 50) }, ['columns', 'rows']),
    block('chart', { style: { type: 'string', enum: ['bar', 'line'] }, unit: str(60), series: arr(obj({ label: str(120), values: arr({ type: 'number' }, 40) }, ['label', 'values']), 4), labels: arr(str(120), 40) }, ['style', 'series', 'labels']),
    block('timeline', { items: arr(obj({ label: str(120), title: str(160), text: str(2000) }, ['label', 'title', 'text']), 16) }, ['items']),
    block('diagram', { nodes: arr(obj({ id: str(40), label: str(160) }, ['id', 'label']), 12), edges: arr(obj({ from: str(40), to: str(40), label: str(120) }, ['from', 'to']), 24, 0) }, ['nodes', 'edges']),
    block('image', { url: str(2000), alt: str(240), caption: str(1000) }, ['url', 'alt']),
    block('link', { url: str(2000), text: str(1000) }, ['url', 'text']),
    block('map', { points: arr(obj({ label: str(160), latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, detail: str(1000) }, ['label', 'latitude', 'longitude']), 20), embed: obj({ provider: { type: 'string', enum: ['openstreetmap', 'google'] }, url: str(2000) }, ['provider']) }, ['points']),
  ] }, 12),
}, ['summary', 'blocks']);

export const PRESENT_RESPONSE_DESCRIPTION = `Publish a rich user-visible response inside this turn: cards, metrics, comparison tables, bar/line charts, timelines, relationship diagrams, images, artifact links or maps. Cards may include an optional image {url,alt,fit:cover|contain} and source/action url; use contain for weather icons or team logos and cover for photography. Optional: use normal text for simple answers. Supply a self-contained summary for copying, search, model history and older clients; do not repeat the whole rich answer afterwards. Use only verified data, mark uncertainty, and never fabricate chart values or coordinates. No HTML/JavaScript, arbitrary SVG, styling or executable content. Image/link URLs must be credential-free HTTP(S); images load automatically in the reader’s browser without a referrer. Links open in the owning in-app browser by default; the reader can explicitly choose a new tab. Maps default to offline coordinate sketches. Set map.embed={provider:openstreetmap} for the dedicated OSM street-map embed, or {provider:google,url} with a verified official https://www.google.com/maps/embed?pb=... share URL (not a homepage or API-key URL). Embed availability depends on the reader's network; coordinates remain available. Never invent routes, ETAs, weather or scores; attach verified image sources and dated data. phase=progress continues work; phase=final is a delivery intent, not proof of task success. Runtime still owns persistence, cancellation and turn termination. Validation failure publishes nothing; correct the payload or answer in text.`;

function check(value, schema, path) {
  if (schema.anyOf) {
    const candidate = schema.anyOf.find(s => value?.type === s.properties.type.enum[0]);
    if (!candidate) throw new Error(`${path}: unsupported block type`);
    return check(value, candidate, path);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected object`);
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path}.${key}: unknown field`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) check(item, schema.properties[key], `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw new Error(`${path}: invalid item count`);
    value.forEach((item, i) => check(item, schema.items, `${path}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength) throw new Error(`${path}: expected non-empty bounded text`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: unsupported value`);
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12 || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path}: invalid finite number`);
  }
}

/** Return a canonical JSON-only snapshot; rejects rather than partially publishing. */
export function normalizePresentation(input) {
  check(input, PRESENTATION_SCHEMA, 'response');
  const encoded = JSON.stringify(input);
  if (new TextEncoder().encode(encoded).length > 49152) throw new Error('response: exceeds 48 KiB');
  const value = JSON.parse(encoded);
  for (const b of value.blocks) {
    if (b.type === 'table' && b.rows.some(row => row.length !== b.columns.length)) throw new Error('table: every row must match the columns');
    if (b.type === 'chart' && b.series.some(series => series.values.length !== b.labels.length)) throw new Error('chart: values must match labels');
    if (b.type === 'diagram') {
      const ids = new Set(b.nodes.map(n => n.id));
      if (ids.size !== b.nodes.length || b.edges.some(e => !ids.has(e.from) || !ids.has(e.to))) throw new Error('diagram: unique nodes and existing edge endpoints required');
    }
    if (b.type === 'image' || b.type === 'link') b.url = safePresentationUrl(b.url);
    if (b.type === 'cards') for (const item of b.items) {
      if (item.image) item.image.url = safePresentationUrl(item.image.url);
      if (item.url) item.url = safePresentationUrl(item.url);
    }
    if (b.type === 'map' && b.embed) b.embed = normalizeMapEmbed(b.embed);
  }
  const canonical = { version: 1, title: value.title || '', summary: value.summary, phase: value.phase || 'final', blocks: value.blocks };
  if (new TextEncoder().encode(JSON.stringify(canonical)).length > 49152) throw new Error('response: exceeds 48 KiB');
  return canonical;
}

/** External URLs are metadata only. Never fetch server-side or accept credentials. */
export function safePresentationUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('response: invalid URL');
  let url;
  try { url = new URL(value); } catch { throw new Error('response: invalid absolute URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('response: unsafe URL');
  // Canonical URLs are encoded, so input length alone is not a safe bound.
  // Persisted snapshots must pass exactly the same limits on replay.
  if (url.href.length > 2000) throw new Error('response: URL exceeds 2000 characters');
  return url.href;
}

/** Only official map share embeds are allowed. API keys/configuration never enter transcripts. */
export function normalizeMapEmbed(embed) {
  if (embed?.provider === 'openstreetmap' && embed.url === undefined) return { provider: 'openstreetmap' };
  if (embed?.provider === 'google') {
    const url = new URL(safePresentationUrl(embed.url));
    const params = [...url.searchParams];
    if (url.origin === 'https://www.google.com' && url.pathname === '/maps/embed' && !url.hash
      && params.length === 1 && params[0][0] === 'pb' && /^![^\s\u0000-\u001f\u007f]+$/.test(params[0][1])) {
      return { provider: 'google', url: url.href };
    }
  }
  throw new Error('map: use generated openstreetmap embed or an official Google Maps share embed URL (pb only, no API key)');
}
