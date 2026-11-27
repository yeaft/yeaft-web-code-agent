const entities = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', laquo: '«', raquo: '»',
  times: '×', euro: '€', pound: '£', yen: '¥', cent: '¢', eacute: 'é', aacute: 'á',
};
export function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi, (raw, name) => {
    if (name[0] !== '#') return Object.hasOwn(entities, name) ? entities[name] : raw;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

export function parseAttributes(tag) {
  const attrs = Object.create(null);
  for (const [, name, d, s, bare] of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[name.toLowerCase()] = decodeEntities(d ?? s ?? bare);
  }
  return attrs;
}

export function cleanText(text) {
  return decodeEntities(String(text ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')).replace(/\s+/gu, ' ').trim();
}

export function resolveHttpUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const utc = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const n = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * (Number(text) < 1e11 ? 1000 : 1) : Date.parse(utc);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Tokenize rather than splitting entries at strings that may be inside CDATA. No DTD resolution. */
export function parseFeedXml(xmlText, baseUrl) {
  const items = [];
  const stack = [];
  let entry, field;
  for (const [token] of xmlText.matchAll(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!(?:[^>"']|"[^"]*"|'[^']*')*>|<\/?[\w:.-]+(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g)) {
    if (token.startsWith('<![')) { if (field) field.text += token.slice(9, -3); continue; }
    if (/^<[!?]/.test(token)) continue;
    const tag = /^<(\/?)([\w:.-]+)([\s\S]*?)>$/.exec(token);
    if (!tag) { if (field) field.text += decodeEntities(token); continue; }
    const [, closing, rawName, attrsText] = tag;
    const name = rawName.toLowerCase();
    if (closing) {
      if (stack.at(-1)?.name !== name) continue;
      if (field?.depth === stack.length) {
        if (field.name === 'link') entry.link ??= resolveHttpUrl(field.text, field.base);
        else entry.fields[field.name] ??= field.text;
        field = null;
      } else if (field) field.text += token;
      if (entry?.depth === stack.length) {
        const f = entry.fields;
        const title = cleanText(f.title);
        const url = entry.link ?? resolveHttpUrl(f.guid, entry.base);
        if (url && title) items.push({ title, url, publishedAt: parseTimestamp(f.pubdate ?? f.published ?? f.updated ?? f['dc:date']),
          summaryExcerpt: cleanText(f['content:encoded'] ?? f.description ?? f.summary ?? f.content).slice(0, 1000) });
        entry = null;
      }
      stack.pop();
      continue;
    }
    const attrs = parseAttributes(attrsText.replace(/\/$/, ''));
    const parent = stack.at(-1)?.base ?? baseUrl;
    const base = resolveHttpUrl(attrs['xml:base'], parent) ?? parent;
    const depth = stack.length + 1;
    const selfClosing = /\/\s*>$/.test(token);
    if (!entry && !selfClosing && ['item', 'entry'].includes(name)) entry = { depth, base, fields: Object.create(null) };
    else if (entry && entry.depth + 1 === depth) {
      if (name === 'link' && attrs.href) {
        if (!attrs.rel || attrs.rel === 'alternate') entry.link ??= resolveHttpUrl(attrs.href, base);
      } else if (!selfClosing) field = { depth, name, base, text: '' };
    } else if (field) field.text += token;
    if (!selfClosing) {
      if (depth > 128) throw new Error('Feed nesting exceeds limit');
      stack.push({ name, base });
    }
    if (items.length >= 200) break;
  }
  return items;
}
