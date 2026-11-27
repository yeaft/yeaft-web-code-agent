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

function boundedMarkup(value) {
  const input = String(value ?? '').slice(0, MAX_MARKUP_BYTES);
  if (Buffer.byteLength(input) <= MAX_MARKUP_BYTES) return input;
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
export function* scanMarkup(input, { xml = false, rawTags = new Set() } = {}) {
  const str = boundedMarkup(input);
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
    if (++tags > MAX_TAGS) return;
    const delimited = str.startsWith('!--', i) ? ['-->', 3] :
      xml && str.startsWith('![CDATA[', i) ? [']]>', 8] : xml && str[i] === '?' ? ['?>', 1] : null;
    if (delimited) {
      const [end, offset] = delimited;
      const stop = str.indexOf(end, i + offset);
      if (stop === -1) return;
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
    if (!closing && rawTags.has(name)) { raw = name; continue; }
    yield { type: 'tag', name, closing, selfClosing, attrsText: str.slice(attrStart, xml && selfClosing ? last : i - 1), text: str.slice(start, i) };
  }
}

const textRawTags = new Set(['script', 'style']);
export function cleanText(text) {
  const parts = [];
  for (const token of scanMarkup(text, { rawTags: textRawTags })) parts.push(token.type === 'text' ? token.text : ' ');
  return decodeEntities(parts.join('')).replace(/\s+/gu, ' ').trim();
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
        else entry.fields[field.name] ??= text;
        field = null;
      } else if (field) appendField(token.text);
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
    const attrs = parseAttributesLinear(attrsText, { boundFeedUrls: true });
    const parent = stack.at(-1)?.base ?? rootBase;
    const base = resolveHttpUrl(attrs['xml:base'], parent) ?? parent;
    const depth = stack.length + 1;
    if (!entry && !selfClosing && ['item', 'entry'].includes(name)) entry = { depth, base, fields: Object.create(null) };
    else if (entry && entry.depth + 1 === depth) {
      if (name === 'link' && attrs.href) {
        if (!attrs.rel || attrs.rel === 'alternate') entry.link ??= resolveHttpUrl(attrs.href, base);
      } else if (!selfClosing) field = { depth, name, base, parts: [], urlLength: name === 'link' || name === 'guid' ? 0 : null };
    } else if (field) appendField(token.text);
    if (!selfClosing) {
      if (depth > 128) throw new Error('Feed nesting exceeds limit');
      stack.push({ name, base });
    }
    if (items.length >= 200) break;
  }
  return items;
}
