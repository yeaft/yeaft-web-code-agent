import { decodeEntities, parseAttributesLinear, resolveHttpUrl, scanMarkup } from './rss-parser.js';
import { createRedactionBudget, redactPrivateTextMask } from './private-redactor.js';

export const ARTICLE_EXTRACTOR_VERSION = 7;

const discard = new Set('script style noscript svg nav header footer aside form iframe template button noembed noframes xmp textarea'.split(' '));
const rawTags = new Set(['script', 'style', 'iframe', 'noembed', 'noframes', 'xmp', 'textarea']);
const rcdataTags = new Set(['title']);
const skipTags = new Set(['template', 'noscript']);
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const noise = /(?:^|[\s_-])(?:ad|ads|advert(?:isement|ising)?|sidebar|cookie(?:-banner)?|related-posts|social-share|newsletter|breadcrumbs)(?=$|[\s_-])/i;
const container = new Set(['article', 'main', 'section', 'div', 'body', 'root']);
const blocks = new Set('p div section article main h1 h2 h3 h4 h5 h6 ul ol li pre blockquote table tr br'.split(' '));
const normalize = text => text.replace(/\s+/gu, ' ').trim();
const escapeMd = text => text.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&').replace(/^([0-9]+)\.(?= )/gm, '$1\\.').replace(/^[-+=](?= )/gm, '\\$&');

function fenceFor(code, minWidth) {
  let width = minWidth;
  for (const [run] of code.matchAll(/`+/g)) width = Math.max(width, run.length + 1);
  return '`'.repeat(width);
}

/**
 * Linear O(N) piece-stream emitter shared by Clean Article display (`preserveLinks: true`) and private AI projection
 * (`preserveLinks: false`):
 * - Appends directly into a single flat `pieces` array (ZERO O(depth × N) array copying).
 * - Passes exact ancestor `linePrefix` string down into `'sep'`/`'pre'` pieces (preserving exact nesting order
 *   for both `blockquote > ul` and `ul > blockquote` without expanding per-line pieces before the 40k output cap).
 * - Trims leading/trailing edges in O(1) amortized via `firstIdx` and tail pops, matching `markdown()` whitespace exactly.
 */
function renderPieces(rootNode, { cutoffSet = new Set(), url = null, preserveLinks = false } = {}) {
  const pieces = [];
  const extractCodeText = preserveLinks ? plain : plainVisible;

  function trimLeadingRange(startIdx) {
    let idx = startIdx;
    while (idx < pieces.length) {
      const p = pieces[idx];
      if (!p || p.kind === 'sep') { pieces[idx] = null; idx++; continue; }
      if (p.kind === 'src') {
        const trimmed = p.text.trimStart();
        if (!trimmed) { pieces[idx] = null; idx++; continue; }
        pieces[idx] = { ...p, text: trimmed };
        break;
      }
      break;
    }
    return idx;
  }

  function trimTrailingRange(minIdx) {
    while (pieces.length > minIdx) {
      const p = pieces[pieces.length - 1];
      if (!p || p.kind === 'sep') { pieces.pop(); continue; }
      if (p.kind === 'src') {
        const trimmed = p.text.trimEnd();
        if (!trimmed) { pieces.pop(); continue; }
        pieces[pieces.length - 1] = { ...p, text: trimmed };
        break;
      }
      break;
    }
  }

  function pushSep(text, linePrefix) {
    pieces.push({ kind: 'sep', text, linePrefix });
  }

  function emit(node, linePrefix) {
    if (typeof node === 'string') {
      const text = node.replace(/\s+/gu, ' ');
      if (!text) return { visible: false, firstIdx: pieces.length };
      const idx = pieces.length;
      pieces.push({ kind: 'src', text });
      return { visible: text.trim().length > 0, firstIdx: idx };
    }
    const { tag, children, attrs } = node;
    if (tag === 'head' || tag === 'title') return { visible: false, firstIdx: pieces.length };
    if (tag === 'br') {
      const idx = pieces.length;
      pushSep('\n', linePrefix);
      return { visible: false, firstIdx: idx };
    }
    const openAtCutoff = cutoffSet.has(node);

    if (tag === 'pre') {
      const code = extractCodeText(node).trimEnd();
      const fence = fenceFor(code, 3);
      const firstIdx = pieces.length;
      pushSep('\n\n', linePrefix);
      pieces.push({ kind: 'syn', md: fence });
      pushSep('\n', linePrefix);
      if (code) pieces.push({ kind: 'pre', text: code, linePrefix });
      if (!openAtCutoff) {
        pushSep('\n', linePrefix);
        pieces.push({ kind: 'syn', md: fence });
        pushSep('\n\n', linePrefix);
      }
      return { visible: true, firstIdx };
    }
    if (tag === 'code') {
      const code = extractCodeText(node).trimEnd().replace(/\n/g, ' ');
      if (!preserveLinks && !code.trim()) return { visible: false, firstIdx: pieces.length };
      const idx = pieces.length;
      pieces.push({ kind: 'code', text: code });
      return { visible: true, firstIdx: idx };
    }
    if (tag === 'ul' || tag === 'ol') {
      const liNodes = children.filter(n => n.tag === 'li');
      const firstIdx = pieces.length;
      pushSep('\n\n', linePrefix);
      let visible = false;
      for (let i = 0; i < liNodes.length; i++) {
        const li = liNodes[i];
        const marker = tag === 'ul' ? '- ' : `${i + 1}. `;
        if (i > 0) pushSep('\n', linePrefix);
        pieces.push({ kind: 'syn', md: marker });
        visible = true;
        const liStart = pieces.length;
        const liOpen = cutoffSet.has(li);
        const childPrefix = linePrefix + ' '.repeat(marker.length);
        let liFirst = liStart;
        let liSetFirst = false;
        for (const child of li.children) {
          const res = emit(child, childPrefix);
          if (!liSetFirst && res.firstIdx < pieces.length) { liFirst = res.firstIdx; liSetFirst = true; }
        }
        trimLeadingRange(liFirst);
        if (!liOpen) trimTrailingRange(liStart);
      }
      if (!openAtCutoff) pushSep('\n\n', linePrefix);
      return { visible, firstIdx };
    }

    const startIdx = pieces.length;
    const isHeading = /^h[1-6]$/.test(tag);
    const isBlockquote = tag === 'blockquote';
    const isEm = tag === 'em' || tag === 'i';
    const isStrong = tag === 'strong' || tag === 'b';
    const link = (tag === 'a' && preserveLinks) ? resolveHttpUrl(attrs?.href, url) : null;
    const isBlock = !isHeading && !isBlockquote && !isEm && !isStrong && tag !== 'a' && blocks.has(tag);

    let openSepIdx = -1;
    let openSynIdx = -1;
    if (isHeading || isBlockquote || isBlock) {
      openSepIdx = pieces.length;
      pushSep('\n\n', linePrefix);
    }
    if (isHeading || isBlockquote || isEm || isStrong || link) {
      openSynIdx = pieces.length;
      pieces.push(null); // Reserve O(1) slot for opening syntax token
    }

    const innerStart = pieces.length;
    const childPrefix = isBlockquote ? `${linePrefix}> ` : linePrefix;
    let visible = false;
    let firstChildIdx = innerStart;
    let hasFirst = false;
    for (const child of children) {
      const res = emit(child, childPrefix);
      if (res.visible) visible = true;
      if (!hasFirst && res.firstIdx < pieces.length) { firstChildIdx = res.firstIdx; hasFirst = true; }
    }
    if (!visible) {
      pieces.length = startIdx;
      return { visible: false, firstIdx: startIdx };
    }

    if (isHeading || isBlockquote || isBlock) {
      trimLeadingRange(firstChildIdx);
      if (!openAtCutoff) trimTrailingRange(innerStart);
    } else if (isEm || isStrong || link) {
      trimLeadingRange(firstChildIdx);
      trimTrailingRange(innerStart);
    }

    if (isHeading) {
      pieces[openSynIdx] = { kind: 'syn', md: `${'#'.repeat(Number(tag[1]))} ` };
      if (!openAtCutoff) pushSep('\n\n', linePrefix);
      return { visible: true, firstIdx: openSepIdx };
    }
    if (isBlockquote) {
      pieces[openSynIdx] = { kind: 'syn', md: '> ' };
      if (!openAtCutoff) pushSep('\n\n', linePrefix);
      return { visible: true, firstIdx: openSepIdx };
    }
    if (isEm) {
      pieces[openSynIdx] = { kind: 'syn', md: '*' };
      if (!openAtCutoff) pieces.push({ kind: 'syn', md: '*' });
      return { visible: true, firstIdx: openSynIdx };
    }
    if (isStrong) {
      pieces[openSynIdx] = { kind: 'syn', md: '**' };
      if (!openAtCutoff) pieces.push({ kind: 'syn', md: '**' });
      return { visible: true, firstIdx: openSynIdx };
    }
    if (link) {
      pieces[openSynIdx] = { kind: 'syn', md: '[' };
      pieces.push({ kind: 'syn', md: `](<${link.replace(/[<>]/g, encodeURIComponent)}>)` });
      return { visible: true, firstIdx: openSynIdx };
    }
    if (isBlock) {
      if (!openAtCutoff) pushSep('\n\n', linePrefix);
      return { visible: true, firstIdx: openSepIdx };
    }
    return { visible: true, firstIdx: firstChildIdx };
  }

  emit(rootNode, '');
  const compact = [];
  for (const p of pieces) if (p) compact.push(p);
  return compact;
}

/**
 * On source truncation (2 MiB, 30k tags, unclosed comment/raw/rcdata/skip/hidden tag), rewind backwards
 * across all non-whitespace content ignoring `'syn'` syntax until a surviving rendered separator or space.
 */
function rewindTrailingTokenInPieces(pieces) {
  const out = pieces.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i];
    if (p.kind === 'syn') {
      out.splice(i, 1);
      continue;
    }
    if (p.kind === 'sep') return out;
    const text = p.text;
    let end = text.length;
    if (end > 0 && /\s/u.test(text[end - 1])) return out;
    while (end > 0 && !/\s/u.test(text[end - 1])) end--;
    if (end > 0) {
      out[i] = { ...p, text: text.slice(0, end) };
      return out;
    }
    out.splice(i, 1);
  }
  return [];
}

/**
 * Redact URLs/credentials over the exact logical text stream (`src`/`code`/`pre`/`sep`, excluding `'syn'` syntax)
 * while keeping surviving `'sep'` placeholders intact even when an inner block becomes empty after redaction.
 */
function redactPrivatePieces(pieces) {
  const logical = [];
  for (const p of pieces) {
    if (p.kind !== 'syn') logical.push(p);
  }
  const joined = logical.map(p => p.text).join('');
  if (!joined) return [];
  const budget = createRedactionBudget();
  const mask = redactPrivateTextMask(joined, budget);

  const out = [];
  let offset = 0;
  let lastKeptContentIdx = -1;
  for (const p of pieces) {
    if (p.kind === 'syn') {
      out.push(p);
      continue;
    }
    const len = p.text.length;
    if (p.kind === 'sep') {
      let anyKept = false;
      for (let k = 0; k < len; k++) {
        if (mask[offset + k]) { anyKept = true; break; }
      }
      offset += len;
      if (anyKept) out.push(p);
      continue;
    }
    let allKept = true;
    let anyKept = false;
    for (let k = 0; k < len; k++) {
      if (mask[offset + k]) anyKept = true;
      else allKept = false;
    }
    if (allKept) {
      out.push(p);
      lastKeptContentIdx = out.length - 1;
    } else if (anyKept) {
      let rebuilt = '';
      for (let k = 0; k < len; k++) {
        if (mask[offset + k]) rebuilt += p.text[k];
      }
      if (rebuilt) {
        out.push({ ...p, text: rebuilt });
        lastKeptContentIdx = out.length - 1;
      }
    }
    offset += len;
  }
  if (lastKeptContentIdx === -1) return [];
  if (budget.exhausted) out.length = lastKeptContentIdx + 1;
  return out;
}

/**
 * Bounded O(maxChars) line-by-line piece formatter:
 * - Expands `linePrefix` incrementally per line ONLY as output budget is consumed (never allocating unbounded
 *   intermediate strings for deeply nested `<blockquote>` or multiline `<pre>`).
 * - Buffers trailing whitespace in `pendingWs` so outer `.trim()` semantics and `exceeded` detection match
 *   `fullRendered.trim().slice(0, maxChars)` and `fullRendered.trim().length > maxChars` exactly.
 */
function formatBoundedPieces(pieces, { maxChars = 40_000, wordBoundary = false } = {}) {
  let out = '';
  let pendingWs = '';
  let lastSafeLen = 0;
  let exceeded = false;

  const appendRaw = (chunk, { isWs = false, canBreakInside = false } = {}) => {
    if (!chunk || exceeded) return;
    if (!out && !pendingWs) {
      const trimmed = chunk.trimStart();
      if (!trimmed) return;
      chunk = trimmed;
      isWs = false;
    }
    if (isWs) {
      if (out.length + pendingWs.length <= maxChars) pendingWs += chunk;
      return;
    }
    // Separate leading/trailing whitespace when flushing non-empty content so trailing spaces at EOF never trigger `exceeded`.
    let leadEnd = 0;
    while (leadEnd < chunk.length && /\s/u.test(chunk[leadEnd])) leadEnd++;
    if (leadEnd === chunk.length) {
      if (out.length + pendingWs.length <= maxChars) pendingWs += chunk;
      return;
    }
    let trailStart = chunk.length;
    while (trailStart > leadEnd && /\s/u.test(chunk[trailStart - 1])) trailStart--;
    const leadWs = pendingWs + chunk.slice(0, leadEnd);
    const core = chunk.slice(leadEnd, trailStart);
    const trailWs = chunk.slice(trailStart);
    pendingWs = '';

    if (out.length + leadWs.length + core.length <= maxChars) {
      if (leadWs) {
        out += leadWs;
        lastSafeLen = out.length;
      }
      out += core;
      if (canBreakInside && /\s/u.test(core)) {
        let ws = core.length - 1;
        while (ws >= 0 && !/\s/u.test(core[ws])) ws--;
        if (ws >= 0) lastSafeLen = out.length - core.length + ws + 1;
      }
      if (trailWs) {
        if (out.length + trailWs.length <= maxChars) pendingWs = trailWs;
        else pendingWs = trailWs.slice(0, Math.max(0, maxChars - out.length + 1));
      }
      return;
    }

    exceeded = true;
    const remaining = maxChars - out.length;
    if (remaining <= 0) return;
    const combined = leadWs + core;
    if (!wordBoundary) {
      out += combined.slice(0, remaining);
      return;
    }
    if (leadWs.length <= remaining) {
      out += leadWs;
      lastSafeLen = out.length;
      const coreBudget = maxChars - out.length;
      if (coreBudget > 0 && canBreakInside) {
        const slice = core.slice(0, coreBudget);
        let ws = slice.length - 1;
        while (ws >= 0 && !/\s/u.test(slice[ws])) ws--;
        if (ws >= 0) {
          out += slice.slice(0, ws + 1);
          lastSafeLen = out.length;
        }
      }
    }
  };

  const appendLinesWithPrefix = (text, prefix, { isSep = false } = {}) => {
    let pos = 0;
    while (pos < text.length && !exceeded) {
      const nl = text.indexOf('\n', pos);
      if (nl === -1) {
        appendRaw(text.slice(pos), { isWs: isSep, canBreakInside: !isSep });
        break;
      }
      if (nl > pos) appendRaw(text.slice(pos, nl), { isWs: isSep, canBreakInside: !isSep });
      appendRaw('\n', { isWs: true });
      if (prefix) appendRaw(prefix, { isWs: !prefix.trim(), canBreakInside: false });
      pos = nl + 1;
    }
  };

  for (const p of pieces) {
    if (exceeded) break;
    if (p.kind === 'src') {
      appendRaw(escapeMd(p.text), { canBreakInside: true });
    } else if (p.kind === 'syn') {
      appendRaw(p.md, { canBreakInside: false });
    } else if (p.kind === 'code') {
      const fence = fenceFor(p.text, 1);
      appendRaw(`${fence} ${p.text} ${fence}`, { canBreakInside: false });
    } else if (p.kind === 'sep') {
      if (p.linePrefix && p.text.includes('\n')) appendLinesWithPrefix(p.text, p.linePrefix, { isSep: true });
      else appendRaw(p.text, { isWs: true });
    } else if (p.kind === 'pre') {
      if (p.linePrefix && p.text.includes('\n')) appendLinesWithPrefix(p.text, p.linePrefix, { isSep: false });
      else appendRaw(p.text, { canBreakInside: true });
    }
  }

  const text = wordBoundary
    ? (exceeded ? out.slice(0, lastSafeLen) : out).trim()
    : out;
  return { text, exceeded };
}

function renderPrivateAiMarkdown(best, openStack, bestWasTruncated, maxChars = 40_000) {
  const cutoffSet = bestWasTruncated ? new Set(openStack) : new Set();
  let pieces = renderPieces(best, { cutoffSet, preserveLinks: false });
  if (bestWasTruncated) pieces = rewindTrailingTokenInPieces(pieces);
  pieces = redactPrivatePieces(pieces);
  return formatBoundedPieces(pieces, { maxChars, wordBoundary: true }).text;
}

function tree(html, scanMeta) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  for (const token of scanMarkup(html, { rawTags, rcdataTags, skipTags, meta: scanMeta })) {
    if (token.type !== 'tag') {
      if (!stack.at(-1).hidden) {
        stack.at(-1).children.push(token.type === 'cdata' ? token.text : decodeEntities(token.text));
      }
      continue;
    }
    const { name: tag, closing: close, attrsText, selfClosing } = token;
    if (close) {
      const at = stack.findLastIndex(n => n.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }
    if ((tag === 'p' || blocks.has(tag)) && stack.at(-1).tag === 'p') stack.pop();
    if (tag === 'li' && stack.at(-1).tag === 'li') stack.pop();
    const attrs = parseAttributesLinear(attrsText);
    const hidden = stack.at(-1).hidden || discard.has(tag) || attrs['aria-hidden'] === 'true' ||
      Object.hasOwn(attrs, 'hidden') || noise.test(`${attrs.id ?? ''} ${attrs.class ?? ''}`);
    const node = { tag, attrs, hidden, children: [] };
    if (!hidden) stack.at(-1).children.push(node);
    if (!voidTags.has(tag) && !selfClosing) {
      if (stack.length >= 128) throw new Error('Article nesting exceeds limit');
      stack.push(node);
    }
  }
  return { root, openStack: stack };
}

function plain(node) {
  return typeof node === 'string' ? node : node.children.map(plain).join('') + (blocks.has(node.tag) ? '\n' : '');
}

function plainVisible(node) {
  if (typeof node === 'string') return node;
  if (node.tag === 'head' || node.tag === 'title') return '';
  return node.children.map(plainVisible).join('') + (blocks.has(node.tag) ? '\n' : '');
}

export function extractCleanArticle(html, sourceUrl, fallbackTitle = '') {
  const url = resolveHttpUrl(sourceUrl);
  const base = { title: fallbackTitle, url, sourceUrl: url, markdown: '', aiMarkdown: '', extractorVersion: ARTICLE_EXTRACTOR_VERSION, truncated: false };
  if (url) {
    const { hostname, pathname } = new URL(url);
    if (['s.weibo.com', 'top.baidu.com', 'search.bilibili.com'].includes(hostname) ||
        ((hostname === 'toutiao.com' || hostname.endsWith('.toutiao.com')) && /^\/(?:trending|hot-event)(?:\/|$)/.test(pathname))) {
      return { ...base, quality: 'search_only' };
    }
  }
  if (!html) return { ...base, quality: 'blocked' };
  const scanMeta = { truncated: false };
  const { root, openStack } = tree(html, scanMeta);
  let best = root, bestScore = -1, title = '', heading = '';
  function measure(node) {
    if (typeof node === 'string') return [normalize(node).length, 0];
    if (node.tag === 'title') { title ||= normalize(plain(node)); return [0, 0]; }
    if (node.tag === 'head') { node.children.filter(n => n.tag === 'title').forEach(measure); return [0, 0]; }
    if (node.tag === 'h1') heading ||= normalize(plain(node));
    let chars = 0, links = 0;
    for (const child of node.children) { const [c, l] = measure(child); chars += c; links += l; }
    if (node.tag === 'a') links = chars;
    const score = (chars - 0.9 * links) * (chars >= 140 && ['article', 'main'].includes(node.tag) ? 2 : 1);
    if (container.has(node.tag) && score > bestScore) { best = node; bestScore = score; }
    return [chars, links];
  }
  measure(root);
  const text = normalize(plain(best));
  const wall = /(?:sign in|log in|subscribe) to (?:read|continue|view)|登录后(?:查看|阅读|继续)|请先登录|verify you are human|access denied|captcha/i;
  const blockedTitle = wall.test(title) || (wall.test(text) && text.length < 500);
  const display = blockedTitle
    ? { text: '', exceeded: false }
    : formatBoundedPieces(renderPieces(best, { url, preserveLinks: true }), { maxChars: 40_000, wordBoundary: false });
  const hiddenOpenAtEof = openStack.some(n => n.hidden || n.tag === 'head' || n.tag === 'title');
  const sourceTruncated = scanMeta.truncated || hiddenOpenAtEof;
  const bestWasTruncated = sourceTruncated && openStack.includes(best);
  const truncated = !blockedTitle && (display.exceeded || sourceTruncated);
  const rendered = display.text;
  const aiMarkdown = blockedTitle ? '' : renderPrivateAiMarkdown(best, openStack, bestWasTruncated, 40_000);
  return { ...base, title: (title || heading || fallbackTitle).slice(0, 500), markdown: blockedTitle ? '' : rendered,
    truncated, aiMarkdown,
    quality: blockedTitle || !rendered ? 'blocked' : text.length < 140 || wall.test(text) ? 'partial' : 'full' };
}
