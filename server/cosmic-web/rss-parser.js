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

const foreignTags = new Set(['svg', 'math']);
const htmlIntegrationTags = new Set(['foreignobject', 'desc']);
const isEndTagBoundary = ch => ch === '>' || ch === '/' || whitespace.test(ch ?? '');

function scanHtmlTagTail(str, startIdx) {
  let i = startIdx;
  let attrState = 0; // 0=beforeAttr, 1=attrName, 2=afterAttrName, 3=beforeAttrVal, 4=unquotedVal, 5=quotedVal, 6=afterQuotedVal, 7=selfClose
  let quote = null;
  let selfClosing = false;
  while (i < str.length) {
    const c = str[i];
    if (attrState === 5) {
      if (c === quote) { quote = null; attrState = 6; }
      i++;
      continue;
    }
    if (c === '>') {
      selfClosing = attrState === 7;
      break;
    }
    if (attrState === 4) {
      if (whitespace.test(c)) attrState = 0;
      i++;
      continue;
    }
    if (attrState === 3) {
      if (whitespace.test(c)) { i++; continue; }
      if (c === '"' || c === "'") { quote = c; attrState = 5; i++; continue; }
      attrState = 4;
      i++;
      continue;
    }
    if (attrState === 1) {
      if (whitespace.test(c)) attrState = 2;
      else if (c === '=') attrState = 3;
      else if (c === '/') attrState = 7;
      i++;
      continue;
    }
    if (attrState === 2) {
      if (whitespace.test(c)) { i++; continue; }
      if (c === '=') { attrState = 3; i++; continue; }
      if (c === '/') { attrState = 7; i++; continue; }
      attrState = 1;
      i++;
      continue;
    }
    if (attrState === 7) {
      if (whitespace.test(c)) { attrState = 0; i++; continue; }
      if (c === '/') { i++; continue; }
      attrState = 1;
      i++;
      continue;
    }
    if (whitespace.test(c)) { attrState = 0; i++; continue; }
    if (c === '/') { attrState = 7; i++; continue; }
    attrState = 1;
    i++;
  }
  return { end: i, selfClosing };
}

/** HTML5 script data / escaped / double-escaped scanner (§13.2.5.4 & §13.2.5.15–31). Returns index after closing `>`, or -1 at EOF. */
function scanHtmlScriptEnd(str, startIdx) {
  let pos = startIdx;
  let state = 0; // 0 = data, 1 = escaped (<!--), 2 = double-escaped (<script inside <!--)
  while (pos < str.length) {
    if (state === 0) {
      const lt = str.indexOf('<', pos);
      if (lt === -1) return -1;
      if (str.startsWith('<!--', lt)) {
        let dashEnd = lt + 4;
        while (str[dashEnd] === '-') dashEnd++;
        if (str[dashEnd] === '>') { pos = dashEnd + 1; continue; }
        state = 1; pos = dashEnd; continue;
      }
      if (str[lt + 1] === '/' && str.slice(lt + 2, lt + 8).toLowerCase() === 'script' && isEndTagBoundary(str[lt + 8])) {
        const { end } = scanHtmlTagTail(str, lt + 8);
        return end < str.length && str[end] === '>' ? end + 1 : -1;
      }
      pos = lt + 1;
      continue;
    }
    const lt = str.indexOf('<', pos);
    const dd = str.indexOf('--', pos);
    if (lt === -1 && dd === -1) return -1;
    if (dd !== -1 && (lt === -1 || dd < lt)) {
      let endRun = dd + 2;
      while (endRun < str.length && str[endRun] === '-') endRun++;
      if (str[endRun] === '>') { state = 0; pos = endRun + 1; }
      else pos = endRun;
      continue;
    }
    if (state === 1) {
      if (str.slice(lt + 1, lt + 7).toLowerCase() === 'script' && isEndTagBoundary(str[lt + 7])) {
        state = 2; pos = lt + 7; continue;
      }
      if (str[lt + 1] === '/' && str.slice(lt + 2, lt + 8).toLowerCase() === 'script' && isEndTagBoundary(str[lt + 8])) {
        const { end } = scanHtmlTagTail(str, lt + 8);
        return end < str.length && str[end] === '>' ? end + 1 : -1;
      }
    } else if (str[lt + 1] === '/' && str.slice(lt + 2, lt + 8).toLowerCase() === 'script' && isEndTagBoundary(str[lt + 8])) {
      state = 1; pos = lt + 8; continue;
    }
    pos = lt + 1;
  }
  return -1;
}

/** HTML5 comment scanner (§13.2.5.45–50): supports <!-->, <!--->, -->, and --!>. Returns index after closing `>`, or -1 at EOF. */
function scanHtmlCommentEnd(str, startAfterOpen) {
  let cPos = startAfterOpen;
  if (str[cPos] === '>') return cPos + 1;
  if (str[cPos] === '-' && str[cPos + 1] === '>') return cPos + 2;
  while (cPos < str.length) {
    const dash = str.indexOf('--', cPos);
    if (dash === -1) return -1;
    let endRun = dash + 2;
    while (endRun < str.length && str[endRun] === '-') endRun++;
    if (str[endRun] === '>') return endRun + 1;
    if (str[endRun] === '!' && str[endRun + 1] === '>') return endRun + 2;
    cPos = endRun;
  }
  return -1;
}

/** Scan tags once, without retrying malformed tags or searching nested candidates for a terminator. */
export function* scanMarkup(input, { xml = false, rawTags = new Set(), rcdataTags = new Set(), skipTags = new Set(), emitRawOpen = false, meta = null } = {}) {
  const str = boundedMarkup(input, meta);
  let i = 0, tags = 0, raw = null, rcdata = null;
  const skipStack = [];
  const foreignStack = [];
  const updateForeignStack = (name, closing, selfClosing, floor = 0) => {
    if (foreignTags.has(name)) {
      if (!closing && !selfClosing) foreignStack.push({ tag: name, foreign: true });
      else if (closing) {
        const at = foreignStack.findLastIndex(e => e.tag === name);
        if (at >= floor) foreignStack.length = at;
      }
    } else if (htmlIntegrationTags.has(name)) {
      if (!closing && !selfClosing && foreignStack.at(-1)?.foreign) {
        foreignStack.push({ tag: name, foreign: false });
      } else if (closing) {
        const at = foreignStack.findLastIndex(e => e.tag === name);
        if (at >= floor) foreignStack.length = at;
      }
    }
  };
  while (i < str.length) {
    if (raw === 'script' && !xml) {
      const afterScript = scanHtmlScriptEnd(str, i);
      if (afterScript === -1) { if (meta) meta.truncated = true; return; }
      raw = null;
      i = afterScript;
      continue;
    }
    const start = i;
    if (str[i] !== '<') {
      const next = str.indexOf('<', i);
      i = next === -1 ? str.length : next;
      if (!raw && skipStack.length === 0) yield { type: 'text', text: str.slice(start, i) };
      continue;
    }
    i++;
    const activeRaw = raw || rcdata;
    if (activeRaw) {
      const matchesClose = str[i] === '/'
        && str.slice(i + 1, i + 1 + activeRaw.length).toLowerCase() === activeRaw
        && isEndTagBoundary(str[i + 1 + activeRaw.length]);
      if (!matchesClose) {
        if (rcdata && skipStack.length === 0) yield { type: 'text', text: '<' };
        continue;
      }
    }
    if (++tags > MAX_TAGS) { if (meta) meta.truncated = true; return; }
    if (!activeRaw) {
      if (str.startsWith('!--', i)) {
        const afterComment = xml
          ? (() => { const s = str.indexOf('-->', i + 3); return s === -1 ? -1 : s + 3; })()
          : scanHtmlCommentEnd(str, i + 3);
        if (afterComment === -1) { if (meta) meta.truncated = true; return; }
        i = afterComment;
        continue;
      }
      const allowCdata = xml || Boolean(foreignStack.at(-1)?.foreign);
      const delimited = allowCdata && str.startsWith('![CDATA[', i) ? [']]>', 8] : xml && str[i] === '?' ? ['?>', 1] : null;
      if (delimited) {
        const [end, offset] = delimited;
        const stop = str.indexOf(end, i + offset);
        if (stop === -1) { if (meta) meta.truncated = true; return; }
        if (end === ']]>' && skipStack.length === 0) yield { type: 'cdata', text: str.slice(i + offset, stop) };
        i = stop + end.length;
        continue;
      }
      // HTML5 bogus comments (`<?...>`, non-DOCTYPE `<!...>`, `</` followed by non-alpha) consume literally up to `>`.
      if (!xml) {
        if (str[i] === '/' && str[i + 1] === '>') { i += 2; continue; }
        const isBogusComment = str[i] === '?'
          || (str[i] === '!' && !/^!doctype(?=$|[\s>])/i.test(str.slice(i, i + 9)))
          || (str[i] === '/' && i + 1 < str.length && !htmlNameStart.test(str[i + 1]));
        if (isBogusComment) {
          const gt = str.indexOf('>', i);
          if (gt === -1) { if (meta) meta.truncated = true; return; }
          i = gt + 1;
          continue;
        }
      }
    }
    const directive = !activeRaw && str[i] === '!';
    const closing = str[i] === '/';
    if (directive || closing) i++;
    const nameStart = i;
    if (xml || htmlNameStart.test(str[i] ?? '')) {
      while (i < str.length && nameChar.test(str[i])) i++;
    }
    if (!directive && nameStart === i) {
      if (!raw && skipStack.length === 0) yield { type: 'text', text: str.slice(start, i) };
      continue;
    }
    const name = str.slice(nameStart, i).toLowerCase();
    const attrStart = i;
    let selfClosing = false;
    let xmlSelfCloseSlash = -1;
    if (!xml && !directive) {
      const tail = scanHtmlTagTail(str, i);
      i = tail.end;
      selfClosing = tail.selfClosing;
    } else {
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
      selfClosing = str[last] === '/';
      xmlSelfCloseSlash = last;
    }
    if (str[i] !== '>') {
      // Discarded unterminated tag/attribute/directive at EOF truncates the trailing source span.
      if (i >= str.length && meta) meta.truncated = true;
      continue;
    }
    i++;
    if (directive) continue;
    if (raw) { raw = null; continue; }
    if (rcdata) {
      rcdata = null;
      if (skipStack.length === 0) {
        yield { type: 'tag', name, closing: true, selfClosing: false, attrsText: '', text: str.slice(start, i), end: i };
      }
      continue;
    }
    if (skipStack.length > 0) {
      if (!closing && name === 'plaintext') {
        if (meta) meta.truncated = true;
        return;
      }
      if (!closing && (rawTags.has(name) || rcdataTags.has(name) || name === 'title')) { raw = name; continue; }
      if (!xml && (foreignTags.has(name) || htmlIntegrationTags.has(name))) {
        updateForeignStack(name, closing, selfClosing, skipStack.at(-1).foreignDepth);
        continue;
      }
      if (skipTags.has(name)) {
        if (closing) {
          if (skipStack.at(-1).name === name) foreignStack.length = skipStack.pop().foreignDepth;
        } else {
          skipStack.push({ name, foreignDepth: foreignStack.length });
        }
      }
      continue;
    }
    if (!xml && (foreignTags.has(name) || htmlIntegrationTags.has(name))) {
      updateForeignStack(name, closing, selfClosing, 0);
    }
    if (!closing && rawTags.has(name)) { raw = name; if (!emitRawOpen) continue; }
    if (!closing && rcdataTags.has(name)) {
      rcdata = name;
      yield { type: 'tag', name, closing, selfClosing: false, attrsText: str.slice(attrStart, i - 1), text: str.slice(start, i), end: i };
      continue;
    }
    if (!closing && skipTags.has(name)) { skipStack.push({ name, foreignDepth: foreignStack.length }); continue; }
    yield { type: 'tag', name, closing, selfClosing, attrsText: str.slice(attrStart, xml && selfClosing ? xmlSelfCloseSlash : i - 1), text: str.slice(start, i), end: i };
  }
  if ((raw || rcdata || skipStack.length > 0) && meta) meta.truncated = true;
}

const htmlRawTags = new Set(['script', 'style', 'iframe', 'noembed', 'noframes', 'xmp', 'textarea', 'title']);
const htmlSkipTags = new Set(['template', 'noscript']);
const textBreakTags = new Set('p div section article main h1 h2 h3 h4 h5 h6 ul ol li dl dt dd pre blockquote table thead tbody tfoot tr td th caption br hr header footer nav aside figure figcaption address details summary dialog fieldset legend form menu option optgroup'.split(' '));
export function cleanText(text, { dropTruncatedToken = false } = {}) {
  const meta = dropTruncatedToken ? { truncated: false } : null;
  const parts = [];
  let safeCut = { partsLen: 0, tailSlice: null };
  for (const token of scanMarkup(text, { rawTags: htmlRawTags, skipTags: htmlSkipTags, meta })) {
    if (token.type === 'text' || token.type === 'cdata') {
      const decoded = token.type === 'cdata' ? token.text : decodeEntities(token.text);
      if (dropTruncatedToken) {
        let ws = decoded.length - 1;
        while (ws >= 0 && !/\s/u.test(decoded[ws])) ws--;
        if (ws >= 0) safeCut = { partsLen: parts.length, tailSlice: decoded.slice(0, ws + 1) };
      }
      parts.push(decoded);
    } else if (textBreakTags.has(token.name)) {
      // Only genuine block/break tags create word boundaries; inline tags like <wbr>/<span>/<code> never split URLs or tokens.
      parts.push(' ');
      if (dropTruncatedToken) {
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
  for (const token of scanMarkup(html, { rawTags: htmlRawTags, skipTags: htmlSkipTags })) {
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
