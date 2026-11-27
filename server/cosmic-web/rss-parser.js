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

const MAX_MARKUP_BYTES = 2 * 1024 * 1024;
const MAX_TAGS = 30_000;
const MAX_ATTRIBUTES = 128;
const MAX_URL_LENGTH = 4096;
const whitespace = /\s/u;
const htmlNameStart = /[a-z]/i;
const nameChar = /[a-z0-9_:.-]/i;
const attributeEnd = /[\s=<>/"']/u;

function boundedMarkup(value, meta) {
  const str = String(value ?? '');
  const sliced = str.length > MAX_MARKUP_BYTES;
  const input = sliced ? str.slice(0, MAX_MARKUP_BYTES) : str;
  if (Buffer.byteLength(input) <= MAX_MARKUP_BYTES) {
    if (sliced && meta) meta.truncated = true;
    return input;
  }
  if (meta) meta.truncated = true;
  const bytes = Buffer.from(input);
  let end = MAX_MARKUP_BYTES;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.toString('utf8', 0, end);
}

/** Parse just the attribute tail, counting boolean and duplicate attributes toward the cap. */
export function parseAttributesLinear(value, { boundFeedUrls = false } = {}) {
  const str = boundedMarkup(value);
  const attrs = Object.create(null);
  let i = 0;
  for (let count = 0; i < str.length && count < MAX_ATTRIBUTES;) {
    if (attributeEnd.test(str[i])) { i++; continue; }
    const start = i++;
    while (i < str.length && !attributeEnd.test(str[i])) i++;
    const name = str.slice(start, i).toLowerCase();
    count++;
    while (i < str.length && whitespace.test(str[i])) i++;
    let value = '';
    if (str[i] === '=') {
      i++;
      while (i < str.length && whitespace.test(str[i])) i++;
      const quote = str[i] === '"' || str[i] === "'" ? str[i++] : null;
      const start = i;
      while (i < str.length && (quote ? str[i] !== quote : !whitespace.test(str[i]) && str[i] !== '>')) i++;
      if (!boundFeedUrls || (name !== 'xml:base' && name !== 'href') || i - start <= MAX_URL_LENGTH) {
        value = decodeEntities(str.slice(start, i));
      }
      if (quote && i < str.length) i++;
    }
    if (!Object.hasOwn(attrs, name)) attrs[name] = value;
  }
  return attrs;
}

// The source adapters also consume the attribute-only parser.
export { parseAttributesLinear as parseAttributes };

/** Scan tags once, without retrying malformed tags or searching nested candidates for a terminator. */
export function* scanMarkup(input, { xml = false, rawTags = new Set(), emitRawOpen = false, meta = null } = {}) {
  const str = boundedMarkup(input, meta);
  let i = 0, tags = 0, raw = null;
  while (i < str.length) {
    const start = i;
    if (str[i] !== '<') {
      const next = str.indexOf('<', i);
      i = next === -1 ? str.length : next;
      if (!raw) yield { type: 'text', text: str.slice(start, i) };
      continue;
    }
    i++;
    if (raw && (str[i] !== '/' || str.slice(i + 1, i + 1 + raw.length).toLowerCase() !== raw ||
      !(str[i + 1 + raw.length] === '>' || whitespace.test(str[i + 1 + raw.length] ?? '')))) continue;
    if (++tags > MAX_TAGS) { if (meta) meta.truncated = true; return; }
    const delimited = str.startsWith('!--', i) ? ['-->', 3] :
      xml && str.startsWith('![CDATA[', i) ? [']]>', 8] : xml && str[i] === '?' ? ['?>', 1] : null;
    if (delimited) {
      const [end, offset] = delimited;
      const stop = str.indexOf(end, i + offset);
      if (stop === -1) { if (meta) meta.truncated = true; return; }
      if (end === ']]>') yield { type: 'cdata', text: str.slice(i + offset, stop) };
      i = stop + end.length;
      continue;
    }
    const directive = str[i] === '!';
    const closing = str[i] === '/';
    if (directive || closing) i++;
    const nameStart = i;
    if (xml || htmlNameStart.test(str[i] ?? '')) {
      while (i < str.length && nameChar.test(str[i])) i++;
    }
    if (!directive && nameStart === i) {
      if (!raw) yield { type: 'text', text: str.slice(start, i) };
      continue;
    }
    const name = str.slice(nameStart, i).toLowerCase();
    const attrStart = i;
    let quote = null, subset = 0, last = i - 1;
    while (i < str.length) {
      const c = str[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (!subset && (c === '>' || (c === '<' && !directive))) break;
      else if (c === '"' || c === "'") quote = c;
      else if (directive && xml && c === '[') subset++;
      else if (directive && xml && c === ']' && subset) subset--;
      if (!whitespace.test(c)) last = i;
      i++;
    }
    if (str[i] !== '>') continue;
    i++;
    if (directive) continue;
    const selfClosing = str[last] === '/';
    if (raw) { raw = null; continue; }
    if (!closing && rawTags.has(name)) { raw = name; if (!emitRawOpen) continue; }
    yield { type: 'tag', name, closing, selfClosing, attrsText: str.slice(attrStart, xml && selfClosing ? last : i - 1), text: str.slice(start, i), end: i };
  }
}

const textRawTags = new Set(['script', 'style']);
const textBreakTags = new Set('p div section article main h1 h2 h3 h4 h5 h6 ul ol li pre blockquote table tr td th br hr header footer nav aside figure figcaption'.split(' '));
export function cleanText(text, { dropTruncatedToken = false } = {}) {
  const meta = dropTruncatedToken ? { truncated: false } : null;
  const parts = [];
  let safeCut = { partsLen: 0, tailSlice: null };
  for (const token of scanMarkup(text, { rawTags: textRawTags, meta })) {
    if (token.type === 'text') {
      const decoded = decodeEntities(token.text);
      if (dropTruncatedToken) {
        let ws = decoded.length - 1;
        while (ws >= 0 && !/\s/u.test(decoded[ws])) ws--;
        if (ws >= 0) safeCut = { partsLen: parts.length, tailSlice: decoded.slice(0, ws + 1) };
      }
      parts.push(decoded);
    } else {
      parts.push(' ');
      // Only genuine block/break tags create source token boundaries; inline tags like <wbr>/<span>/<code> do not.
      if (dropTruncatedToken && textBreakTags.has(token.name)) {
        safeCut = { partsLen: parts.length, tailSlice: null };
      }
    }
  }
  if (dropTruncatedToken && meta.truncated) {
    const safeParts = parts.slice(0, safeCut.partsLen);
    if (safeCut.tailSlice) safeParts.push(safeCut.tailSlice);
    return safeParts.join('').replace(/\s+/gu, ' ').trim();
  }
  return parts.join('').replace(/\s+/gu, ' ').trim();
}

export function resolveHttpUrl(ref, base) {
  if (typeof ref !== 'string' || ref.length > MAX_URL_LENGTH || !ref.trim()) return null;
  if (typeof base === 'string' && base.length > MAX_URL_LENGTH) base = undefined;
  try {
    const url = new URL(ref.trim(), base);
    const { href } = url;
    return href.length <= MAX_URL_LENGTH && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? href : null;
  } catch { return null; }
}

/** Normalize image references without rewriting signed CDN query strings. The proxy verifies bytes. */
export function normalizeMedia(candidates, base, limit = 3) {
  const result = [], seen = new Set();
  for (const candidate of candidates ?? []) {
    const { url: raw, kind, alt, type, width, height, animated } = typeof candidate === 'string' ? { url: candidate } : candidate ?? {};
    if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) continue;
    const url = resolveHttpUrl(decodeEntities(raw), base);
    if (!url || (typeof type === 'string' && /(?:svg|icon)/i.test(type)) || seen.has(url) || (width != null && Number(width) > 0 && Number(width) <= 1) ||
        (height != null && Number(height) > 0 && Number(height) <= 1)) continue;
    const parsed = new URL(url);
    if (/\.(?:svgz?|ico|mp4|webm|m3u8)(?:$|[!@~])/i.test(parsed.pathname) ||
        /(?:^|[./_\-])(?:avatars?|favicons?|icons?|logos?|tracking|trackers?|pixels?|spacer)(?:[./_\-]|$)/i.test(parsed.hostname + parsed.pathname)) continue;
    const gif = kind === 'gif' || type?.toLowerCase?.() === 'image/gif' || /\.gif(?:$|[!@~])/i.test(parsed.pathname) ||
      /(?:format|fm)[=/,]gif(?:$|[&?/])/i.test(parsed.search) ||
      (animated === true || (/webp/i.test(parsed.pathname + parsed.search) && /(?:anim(?:ated|ation)?=(?:1|true)|animated|animated-webp)/i.test(parsed.pathname + parsed.search)));
    const caption = cleanText(alt).slice(0, 300);
    result.push({ url, kind: gif ? 'gif' : 'image', ...(caption && { alt: caption }) });
    seen.add(url);
    if (result.length >= limit) break;
  }
  return result;
}

export function extractMarkupMedia(html, base, { openGraph = false, limit = 3 } = {}) {
  const metadata = [], images = [];
  for (const token of scanMarkup(html, { rawTags: textRawTags })) {
    if (token.type !== 'tag' || token.closing || !['img', 'meta'].includes(token.name)) continue;
    const a = parseAttributesLinear(token.attrsText);
    if (token.name === 'img' && images.length < 48 && !/\b(?:avatar|icon|logo|tracker|pixel)s?\b/i.test(`${a.class ?? ''} ${a.id ?? ''} ${a.alt ?? ''}`)) {
      images.push({ url: a['data-origin'] || a['data-src'] || a['data-original'] || a.src, alt: a.alt,
        width: a.width ?? /\bwidth\s*:\s*(1)px/i.exec(a.style)?.[1], height: a.height ?? /\bheight\s*:\s*(1)px/i.exec(a.style)?.[1],
        animated: /^(?:1|true)$/i.test(a['data-animated'] ?? '') });
    } else if (openGraph && token.name === 'meta' && metadata.length < 24) {
      const name = (a.property || a.name)?.toLowerCase();
      if (['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(name)) metadata.push({ url: a.content });
      else if (metadata.length && ['og:image:width', 'og:image:height', 'og:image:alt', 'og:image:type', 'twitter:image:alt'].includes(name)) {
        metadata.at(-1)[name.split(':').at(-1)] = a.content;
      }
    }
  }
  return normalizeMedia([...metadata, ...images], base, limit);
}

export function parseTimestamp(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const utc = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const n = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * (Number(text) < 1e11 ? 1000 : 1) : Date.parse(utc);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Tokenize rather than splitting entries at strings that may be inside CDATA. No DTD resolution. */
export function parseFeedXml(xmlText, baseUrl, { sanitizeExcerpt } = {}) {
  const items = [];
  const stack = [];
  const rootBase = resolveHttpUrl(baseUrl) ?? undefined;
  let entry, field;
  function appendField(text, decode = false) {
    if (field.urlLength != null && (field.urlLength += text.length) > MAX_URL_LENGTH) return;
    field.parts.push(decode ? decodeEntities(text) : text);
  }
  for (const token of scanMarkup(xmlText, { xml: true })) {
    if (token.type !== 'tag') {
      if (field) appendField(token.text, token.type !== 'cdata');
      continue;
    }
    const { closing, name, attrsText, selfClosing } = token;
    if (closing) {
      if (stack.at(-1)?.name !== name) continue;
      if (field?.depth === stack.length) {
        const text = field.urlLength > MAX_URL_LENGTH ? '' : field.parts.join('');
        if (field.name === 'link') entry.link ??= resolveHttpUrl(text, field.base);
        else if (!Object.hasOwn(entry.fields, field.name)) { entry.fields[field.name] = text; entry.fieldBases[field.name] = field.base; }
        field = null;
      } else if (field) appendField(token.text);
      if (entry?.depth === stack.length) {
        const f = entry.fields;
        const dropTruncatedToken = typeof sanitizeExcerpt === 'function';
        const title = cleanText(f.title, { dropTruncatedToken });
        const url = entry.link ?? resolveHttpUrl(f.guid, entry.base);
        if (url && title) {
          const rawExcerpt = cleanText(f['content:encoded'] ?? f.description ?? f.summary ?? f.content, { dropTruncatedToken });
          const safeExcerpt = dropTruncatedToken ? sanitizeExcerpt(rawExcerpt) : rawExcerpt;
          items.push({ title, url, publishedAt: parseTimestamp(f.pubdate ?? f.published ?? f.updated ?? f['dc:date']),
            summaryExcerpt: safeExcerpt.replace(/\s+/gu, ' ').trim().slice(0, 1000),
            media: normalizeMedia([...entry.media, ...['content:encoded', 'description', 'summary', 'content']
              .flatMap(name => extractMarkupMedia(f[name], entry.fieldBases[name] ?? entry.base))], entry.base) });
        }
        entry = null;
      }
      stack.pop();
      continue;
    }
    const attrs = parseAttributesLinear(attrsText, { boundFeedUrls: true });
    const parent = stack.at(-1)?.base ?? rootBase;
    const base = resolveHttpUrl(attrs['xml:base'], parent) ?? parent;
    const depth = stack.length + 1;
    if (!entry && !selfClosing && ['item', 'entry'].includes(name)) entry = { depth, base, fields: Object.create(null), fieldBases: Object.create(null), media: [] };
    else if (entry && entry.depth + 1 === depth) {
      if (name === 'link' && attrs.href) {
        if (!attrs.rel || attrs.rel === 'alternate') entry.link ??= resolveHttpUrl(attrs.href, base);
      } else if (!selfClosing) field = { depth, name, base, parts: [], urlLength: name === 'link' || name === 'guid' ? 0 : null };
    } else if (field) appendField(token.text);
    if (entry && entry.media.length < 24) {
      const type = attrs.type?.toLowerCase();
      const image = type?.startsWith('image/');
      if (name === 'media:thumbnail' || (name === 'media:content' && (image || attrs.medium === 'image' || (!type && !attrs.medium))) ||
          ((name === 'enclosure' || (name === 'link' && attrs.rel === 'enclosure')) && image)) {
        entry.media.push({ url: resolveHttpUrl(attrs.url || attrs.href, base), type, alt: attrs.title,
          width: attrs.width, height: attrs.height });
      }
    }
    if (!selfClosing) {
      if (depth > 128) throw new Error('Feed nesting exceeds limit');
      stack.push({ name, base });
    }
    if (items.length >= 200) break;
  }
  return items;
}
