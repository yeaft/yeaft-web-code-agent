import { decodeEntities, parseAttributesLinear, resolveHttpUrl, scanMarkup } from './rss-parser.js';
import { createRedactionBudget, redactPrivateTextMask } from './private-redactor.js';

export const ARTICLE_EXTRACTOR_VERSION = 6;

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

function hasVisiblePieces(pieces) {
  for (const p of pieces) {
    if (p.kind === 'syn') {
      if (p.md.trim().length > 0) return true;
    } else if (p.kind === 'code' || p.kind === 'pre' || p.kind === 'src') {
      if (p.text.trim().length > 0) return true;
    }
  }
  return false;
}

/** Trim leading/trailing rendered whitespace (exact mirror of `text.trim()` in `markdown()`). */
function trimPieces(pieces, { start = true, end = true } = {}) {
  const out = pieces.slice();
  if (start) {
    while (out.length) {
      const p = out[0];
      if (p.kind === 'sep') { out.shift(); continue; }
      if (p.kind === 'src') {
        const trimmed = p.text.trimStart();
        if (!trimmed) { out.shift(); continue; }
        out[0] = { ...p, text: trimmed };
        break;
      }
      break;
    }
  }
  if (end) {
    while (out.length) {
      const p = out[out.length - 1];
      if (p.kind === 'sep') { out.pop(); continue; }
      if (p.kind === 'src') {
        const trimmed = p.text.trimEnd();
        if (!trimmed) { out.pop(); continue; }
        out[out.length - 1] = { ...p, text: trimmed };
        break;
      }
      break;
    }
  }
  return out;
}

/**
 * Render `node` into tagged pieces mirroring `markdown(node)` (with `<a href>` stripped):
 * - `{ kind: 'src', text }`  : decoded text leaf (`\s+` collapsed to `' '`)
 * - `{ kind: 'code', text }` : inline `<code>` body (no synthetic spaces in logical token stream)
 * - `{ kind: 'pre', text }`  : `<pre>` body (wrapped with `'syn'` fences + `'sep'` newlines)
 * - `{ kind: 'sep', text }`  : surviving rendered whitespace separator (`'\n'` or `'\n\n'`)
 * - `{ kind: 'syn', md }`    : pure Markdown syntax (`'*'`, `'**'`, `'# '`, `'> '`, `'- '`, `` '```' ``)
 *
 * Edge trimming (`trimPieces`) operates on the actual rendered stream (so nested blocks inside `<em>`/`<strong>`
 * whose edge newlines are stripped by `markdown()`'s `.trim()` never create phantom separators), while surviving
 * `'sep'` placeholders remain intact even when an inner block's text is completely redacted away.
 */
function renderPrivatePieces(node, cutoffSet) {
  if (typeof node === 'string') {
    const text = node.replace(/\s+/gu, ' ');
    return text ? [{ kind: 'src', text }] : [];
  }
  const { tag, children } = node;
  if (tag === 'head' || tag === 'title') return [];
  if (tag === 'br') return [{ kind: 'sep', text: '\n' }];
  const openAtCutoff = cutoffSet.has(node);

  if (tag === 'pre') {
    const code = plain(node).trimEnd();
    const fence = fenceFor(code, 3);
    const pieces = [{ kind: 'sep', text: '\n\n' }, { kind: 'syn', md: fence }, { kind: 'sep', text: '\n' }];
    if (code) pieces.push({ kind: 'pre', text: code });
    if (!openAtCutoff) pieces.push({ kind: 'sep', text: '\n' }, { kind: 'syn', md: fence }, { kind: 'sep', text: '\n\n' });
    return pieces;
  }
  if (tag === 'code') {
    const code = plain(node).trimEnd().replace(/\n/g, ' ');
    if (!code.trim()) return [];
    return [{ kind: 'code', text: code }];
  }
  if (tag === 'ul' || tag === 'ol') {
    const liNodes = children.filter(n => n.tag === 'li');
    const out = [{ kind: 'sep', text: '\n\n' }];
    for (let i = 0; i < liNodes.length; i++) {
      const li = liNodes[i];
      const marker = tag === 'ul' ? '- ' : `${i + 1}. `;
      const liInner = trimPieces(renderPrivatePieces(li, cutoffSet), { start: true, end: !cutoffSet.has(li) });
      if (i > 0) out.push({ kind: 'sep', text: '\n' });
      out.push({ kind: 'syn', md: marker });
      for (const p of liInner) {
        if (p.kind === 'sep' && p.text.includes('\n')) {
          const parts = p.text.split('\n');
          for (let j = 0; j < parts.length; j++) {
            if (j > 0) {
              out.push({ kind: 'sep', text: '\n' });
              out.push({ kind: 'syn', md: ' '.repeat(marker.length) });
            }
            if (parts[j]) out.push({ kind: 'sep', text: parts[j] });
          }
        } else {
          out.push(p);
        }
      }
    }
    if (!openAtCutoff) out.push({ kind: 'sep', text: '\n\n' });
    return out;
  }

  const rawInner = [];
  for (const child of children) {
    for (const p of renderPrivatePieces(child, cutoffSet)) rawInner.push(p);
  }
  if (!hasVisiblePieces(rawInner)) return [];

  if (/^h[1-6]$/.test(tag)) {
    const inner = trimPieces(rawInner, { start: true, end: !openAtCutoff });
    return [
      { kind: 'sep', text: '\n\n' },
      { kind: 'syn', md: `${'#'.repeat(Number(tag[1]))} ` },
      ...inner,
      ...(openAtCutoff ? [] : [{ kind: 'sep', text: '\n\n' }]),
    ];
  }
  if (tag === 'blockquote') {
    const inner = trimPieces(rawInner, { start: true, end: !openAtCutoff });
    const out = [{ kind: 'sep', text: '\n\n' }, { kind: 'syn', md: '> ' }];
    for (const p of inner) {
      if (p.kind === 'sep' && p.text.includes('\n')) {
        const parts = p.text.split('\n');
        for (let j = 0; j < parts.length; j++) {
          if (j > 0) {
            out.push({ kind: 'sep', text: '\n' });
            out.push({ kind: 'syn', md: '> ' });
          }
          if (parts[j]) out.push({ kind: 'sep', text: parts[j] });
        }
      } else {
        out.push(p);
      }
    }
    if (!openAtCutoff) out.push({ kind: 'sep', text: '\n\n' });
    return out;
  }
  if (tag === 'em' || tag === 'i') {
    const inner = trimPieces(rawInner, { start: true, end: true });
    return [{ kind: 'syn', md: '*' }, ...inner, ...(openAtCutoff ? [] : [{ kind: 'syn', md: '*' }])];
  }
  if (tag === 'strong' || tag === 'b') {
    const inner = trimPieces(rawInner, { start: true, end: true });
    return [{ kind: 'syn', md: '**' }, ...inner, ...(openAtCutoff ? [] : [{ kind: 'syn', md: '**' }])];
  }
  if (tag === 'a') {
    // Strip href in private AI projection so markdown never emits ](<url>).
    return rawInner;
  }
  if (blocks.has(tag)) {
    const inner = trimPieces(rawInner, { start: true, end: !openAtCutoff });
    return [
      { kind: 'sep', text: '\n\n' },
      ...inner,
      ...(openAtCutoff ? [] : [{ kind: 'sep', text: '\n\n' }]),
    ];
  }
  return rawInner;
}

/**
 * On source truncation (2 MiB, 30k tags, unclosed comment/raw/skip/hidden tag), rewind backwards
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

function renderPieceMd(p) {
  if (p.kind === 'src') return escapeMd(p.text);
  if (p.kind === 'sep') return p.text;
  if (p.kind === 'syn') return p.md;
  if (p.kind === 'code') {
    const fence = fenceFor(p.text, 1);
    return `${fence} ${p.text} ${fence}`;
  }
  return p.text; // 'pre' body
}

function formatBoundedPieces(pieces, maxChars = 40_000) {
  const full = pieces.map(renderPieceMd).join('').trim();
  if (full.length <= maxChars) return full;
  let out = '';
  let lastSafeLen = 0;
  for (const p of pieces) {
    const chunk = renderPieceMd(p);
    if (!chunk) continue;
    if (p.kind === 'sep') {
      if (out.length + chunk.length <= maxChars) {
        out += chunk;
        lastSafeLen = out.length;
      } else {
        break;
      }
      continue;
    }
    if (p.kind === 'syn') {
      if (out.length + chunk.length <= maxChars) out += chunk;
      else break;
      continue;
    }
    if (out.length + chunk.length <= maxChars) {
      out += chunk;
      if (/\s/u.test(p.text)) {
        let ws = chunk.length - 1;
        while (ws >= 0 && !/\s/u.test(chunk[ws])) ws--;
        if (ws >= 0) lastSafeLen = out.length - chunk.length + ws + 1;
      }
      continue;
    }
    const remaining = maxChars - out.length;
    if (remaining > 0 && p.kind !== 'code') {
      const slice = chunk.slice(0, remaining);
      let ws = slice.length - 1;
      while (ws >= 0 && !/\s/u.test(slice[ws])) ws--;
      if (ws >= 0) {
        out += slice.slice(0, ws + 1);
        lastSafeLen = out.length;
      }
    }
    break;
  }
  return out.slice(0, lastSafeLen).trim();
}

function renderPrivateAiMarkdown(best, openStack, bestWasTruncated, maxChars = 40_000) {
  const cutoffSet = bestWasTruncated ? new Set(openStack) : new Set();
  let pieces = renderPrivatePieces(best, cutoffSet);
  if (bestWasTruncated) pieces = rewindTrailingTokenInPieces(pieces);
  pieces = redactPrivatePieces(pieces);
  return formatBoundedPieces(pieces, maxChars);
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

function markdown(node, url) {
  if (typeof node === 'string') return escapeMd(node.replace(/\s+/gu, ' '));
  const { tag, children, attrs } = node;
  if (['head', 'title'].includes(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'pre' || tag === 'code') {
    const code = plain(node).trimEnd();
    const fence = fenceFor(code, tag === 'pre' ? 3 : 1);
    return tag === 'pre' ? `\n\n${fence}\n${code}\n${fence}\n\n` : `${fence} ${code.replace(/\n/g, ' ')} ${fence}`;
  }
  if (tag === 'ul' || tag === 'ol') {
    const lines = children.filter(n => n.tag === 'li').map((n, i) => {
      const marker = tag === 'ul' ? '- ' : `${i + 1}. `;
      return marker + markdown(n, url).trim().replace(/\n/g, `\n${' '.repeat(marker.length)}`);
    });
    return `\n\n${lines.join('\n')}\n\n`;
  }
  const text = children.map(n => markdown(n, url)).join('');
  if (!text.trim()) return '';
  if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${text.trim()}\n\n`;
  if (tag === 'blockquote') return `\n\n${text.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
  if (tag === 'em' || tag === 'i') return `*${text.trim()}*`;
  if (tag === 'strong' || tag === 'b') return `**${text.trim()}**`;
  if (tag === 'a') {
    const link = resolveHttpUrl(attrs.href, url);
    return link ? `[${text.trim()}](<${link.replace(/[<>]/g, encodeURIComponent)}>)` : text;
  }
  return blocks.has(tag) ? `\n\n${text.trim()}\n\n` : text;
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
  const fullRendered = markdown(best, url).trim();
  const hiddenOpenAtEof = openStack.some(n => n.hidden || n.tag === 'head' || n.tag === 'title');
  const sourceTruncated = scanMeta.truncated || hiddenOpenAtEof;
  const bestWasTruncated = sourceTruncated && openStack.includes(best);
  const truncated = !blockedTitle && (fullRendered.length > 40_000 || sourceTruncated);
  const rendered = fullRendered.slice(0, 40_000);
  const aiMarkdown = blockedTitle ? '' : renderPrivateAiMarkdown(best, openStack, bestWasTruncated, 40_000);
  return { ...base, title: (title || heading || fallbackTitle).slice(0, 500), markdown: blockedTitle ? '' : rendered,
    truncated, aiMarkdown,
    quality: blockedTitle || !rendered ? 'blocked' : text.length < 140 || wall.test(text) ? 'partial' : 'full' };
}
