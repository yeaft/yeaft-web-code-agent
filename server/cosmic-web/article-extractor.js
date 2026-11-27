import { decodeEntities, parseAttributesLinear, resolveHttpUrl, scanMarkup } from './rss-parser.js';
import { createRedactionBudget, redactPrivateTextMask } from './private-redactor.js';

export const ARTICLE_EXTRACTOR_VERSION = 3;

const discard = new Set('script style noscript svg nav header footer aside form iframe template button noembed noframes xmp'.split(' '));
const rawTags = new Set(['script', 'style', 'iframe', 'noembed', 'noframes', 'xmp']);
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const noise = /(?:^|[\s_-])(?:ad|ads|advert(?:isement|ising)?|sidebar|cookie(?:-banner)?|related-posts|social-share|newsletter|breadcrumbs)(?=$|[\s_-])/i;
const container = new Set(['article', 'main', 'section', 'div', 'body', 'root']);
const blocks = new Set('p div section article main h1 h2 h3 h4 h5 h6 ul ol li pre blockquote table tr br'.split(' '));
const normalize = text => text.replace(/\s+/gu, ' ').trim();
const escapeMd = text => text.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&').replace(/^([0-9]+)\.(?= )/gm, '$1\\.').replace(/^[-+=](?= )/gm, '\\$&');

function countSourceChars(node) {
  if (typeof node === 'string') return node.length;
  if (['head', 'title'].includes(node.tag)) return 0;
  const kids = (node.tag === 'ul' || node.tag === 'ol') ? node.children.filter(c => c.tag === 'li') : node.children;
  let total = 0;
  for (const child of kids) total += countSourceChars(child);
  return total;
}

/**
 * Slice a DOM subtree at exact source character offset `limit`, recording the ancestor `openStack`
 * where the cut landed (identical semantics to scanMarkup stopping at `limit`). Non-mutating.
 */
function sliceDomAtSourceOffset(node, limit) {
  let remaining = limit;
  const openStack = [];
  function visit(n) {
    if (typeof n === 'string') {
      if (n.length <= remaining) {
        remaining -= n.length;
        return { node: n, stopped: false };
      }
      const piece = remaining > 0 ? n.slice(0, remaining) : '';
      remaining = 0;
      return { node: piece || null, stopped: true };
    }
    if (['head', 'title'].includes(n.tag)) return { node: null, stopped: false };
    const kids = (n.tag === 'ul' || n.tag === 'ol') ? n.children.filter(c => c.tag === 'li') : n.children;
    const outChildren = [];
    let stopped = false;
    for (const child of kids) {
      const res = visit(child);
      if (res.node != null) outChildren.push(res.node);
      if (res.stopped) { stopped = true; break; }
    }
    const clone = { ...n, children: outChildren };
    if (stopped) openStack.push(clone);
    return { node: clone, stopped };
  }
  const res = visit(node);
  return { node: res.node, openStack };
}

/**
 * Redact URLs/credentials across contiguous inline DOM text runs BEFORE Markdown syntax
 * (like inline `<code>` backticks/spaces or `<a href>`) is synthesized. Non-mutating so Clean Article display stays intact.
 */
function redactDomPrivateUrls(rootNode) {
  const budget = createRedactionBudget();
  const runs = [];
  let currentRun = [];
  const flushRun = () => {
    if (currentRun.length) {
      runs.push({ kind: 'run', slots: currentRun });
      currentRun = [];
    }
  };

  function buildSkeleton(n) {
    if (typeof n === 'string') {
      const slot = { kind: 'leaf', text: n, value: n };
      currentRun.push(slot);
      return slot;
    }
    if (['head', 'title'].includes(n.tag)) return null;
    if (n.tag === 'br') {
      flushRun();
      const slot = { kind: 'br', node: n, discarded: false };
      runs.push(slot);
      return slot;
    }
    if (blocks.has(n.tag) || n.tag === 'ul' || n.tag === 'ol') {
      flushRun();
      const kids = (n.tag === 'ul' || n.tag === 'ol') ? n.children.filter(c => c.tag === 'li') : n.children;
      const childSlots = [];
      for (const child of kids) {
        const built = buildSkeleton(child);
        if (built != null) childSlots.push(built);
      }
      flushRun();
      return { kind: 'elem', node: n, hadChildren: kids.length > 0, children: childSlots };
    }
    const childSlots = [];
    for (const child of n.children) {
      const built = buildSkeleton(child);
      if (built != null) childSlots.push(built);
    }
    return { kind: 'elem', node: n, hadChildren: n.children.length > 0, children: childSlots };
  }

  const skeleton = buildSkeleton(rootNode);
  flushRun();

  for (const entry of runs) {
    if (entry.kind === 'br') {
      if (budget.exhausted) entry.discarded = true;
      continue;
    }
    if (budget.exhausted) {
      for (const slot of entry.slots) slot.value = null;
      continue;
    }
    const joined = entry.slots.map(slot => slot.text).join('');
    if (!joined) continue;
    const mask = redactPrivateTextMask(joined, budget);
    let offset = 0;
    for (const slot of entry.slots) {
      const len = slot.text.length;
      let allKept = true;
      let anyKept = false;
      for (let k = 0; k < len; k++) {
        if (mask[offset + k]) anyKept = true;
        else allKept = false;
      }
      if (allKept) {
        slot.value = slot.text;
      } else if (!anyKept) {
        slot.value = null;
      } else {
        let rebuilt = '';
        for (let k = 0; k < len; k++) {
          if (mask[offset + k]) rebuilt += slot.text[k];
        }
        slot.value = rebuilt || null;
      }
      offset += len;
    }
  }

  function materialize(slot) {
    if (!slot) return null;
    if (slot.kind === 'leaf') return slot.value;
    if (slot.kind === 'br') return slot.discarded ? null : slot.node;
    const { node: orig, hadChildren, children } = slot;
    const outChildren = [];
    for (const child of children) {
      const mat = materialize(child);
      if (mat != null) outChildren.push(mat);
    }
    if (hadChildren && outChildren.length === 0) return null;
    const attrs = orig.tag === 'a' ? {} : orig.attrs;
    return { ...orig, attrs, children: outChildren };
  }

  return materialize(skeleton);
}

/**
 * Render an AI-safe Markdown projection bounded to `maxChars` by cutting ONLY at genuine source DOM
 * boundaries (via `sliceDomAtSourceOffset` + `trimTrailingSourceToken`), never at synthetic Markdown spaces.
 */
function renderBoundedAiMarkdown(node, url, maxChars = 40_000) {
  const rendered = markdown(node, url).trim();
  if (rendered.length <= maxChars) return rendered;
  const totalSource = countSourceChars(node);
  let lo = 0, hi = totalSource - 1, bestMd = '';
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const { node: sliced, openStack } = sliceDomAtSourceOffset(node, mid);
    const trimmed = sliced ? trimTrailingSourceToken(sliced, new Set(openStack)).node : null;
    const candidate = trimmed ? markdown(trimmed, url).trim() : '';
    if (candidate.length <= maxChars) {
      bestMd = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return bestMd;
}

/**
 * Walk backwards from the source cutoff inside `best` BEFORE Markdown syntax is synthesized
 * (preventing inline `<code>` backtick+space, `<pre>` fences, `*`/`**`, or `](<url>)` from
 * splitting or hiding an incomplete trailing source token). Non-mutating so Clean Article display stays intact.
 */
function trimTrailingSourceToken(node, cutoffSet, insidePreOrCode = false) {
  if (typeof node === 'string') {
    let end = node.length;
    if (end === 0) return { node: null, done: false };
    if (/\s/u.test(node[end - 1])) return { node, done: true };
    while (end > 0 && !/\s/u.test(node[end - 1])) end--;
    if (end > 0) return { node: node.slice(0, end), done: true };
    return { node: null, done: false };
  }
  const { tag, children } = node;
  if (['head', 'title'].includes(tag)) return { node: null, done: false };
  const openAtCutoff = cutoffSet.has(node);
  // A completely closed block element (<p>...</p>, <pre>...</pre>, <br>, etc.) cannot join with tokens after it.
  if (!openAtCutoff && blocks.has(tag)) return { node, done: true };
  const isCodeOrPre = insidePreOrCode || tag === 'pre' || tag === 'code';
  // Closed inline elements (including <code>, <em>, <strong>, <a>, <span>) trim trailing whitespace or collapse
  // whitespace-only content in markdown(), so trailing spaces inside them are not reliable token separators.
  const trimsRightEdge = !openAtCutoff;
  const effectiveChildren = (tag === 'ul' || tag === 'ol') ? children.filter(n => n.tag === 'li') : children;
  const kept = effectiveChildren.slice();
  let done = false;
  for (let idx = kept.length - 1; idx >= 0; idx--) {
    const child = kept[idx];
    if (trimsRightEdge && typeof child === 'string') {
      const trimmedRight = child.trimEnd();
      if (!trimmedRight) { kept.splice(idx, 1); continue; }
      let end = trimmedRight.length;
      while (end > 0 && !/\s/u.test(trimmedRight[end - 1])) end--;
      if (end > 0) { kept[idx] = trimmedRight.slice(0, end); done = true; break; }
      kept.splice(idx, 1);
      continue;
    }
    const res = trimTrailingSourceToken(child, cutoffSet, isCodeOrPre);
    if (res.node == null) kept.splice(idx, 1);
    else kept[idx] = res.node;
    if (res.done) { done = true; break; }
  }
  // Drop href on an unclosed <a> at cutoff so an unclosed link never emits ](<url>) or leaks href.
  const attrs = (openAtCutoff && tag === 'a') ? {} : node.attrs;
  if (!kept.length) return { node: null, done: false };
  if (!isCodeOrPre && !plain({ ...node, children: kept }).trim()) return { node: null, done: false };
  return { node: { ...node, attrs, children: kept }, done };
}

function tree(html, scanMeta) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  for (const token of scanMarkup(html, { rawTags, meta: scanMeta })) {
    if (token.type !== 'tag') {
      if (!stack.at(-1).hidden) stack.at(-1).children.push(decodeEntities(token.text));
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
    let width = tag === 'pre' ? 3 : 1;
    for (const [run] of code.matchAll(/`+/g)) width = Math.max(width, run.length + 1);
    const fence = '`'.repeat(width);
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
  const hiddenOpenAtEof = openStack.some(n => n.hidden);
  const sourceTruncated = scanMeta.truncated || hiddenOpenAtEof;
  const bestWasTruncated = sourceTruncated && openStack.includes(best);
  const truncated = !blockedTitle && (fullRendered.length > 40_000 || sourceTruncated);
  const rendered = fullRendered.slice(0, 40_000);
  // Derive a source-DOM-redacted, cutoff-safe AI projection BEFORE Markdown syntax is synthesized
  // (preventing inline <code> backticks/spaces or 40k caps from splitting URLs, while keeping Clean Article display intact).
  let aiMarkdown = '';
  if (!blockedTitle) {
    const sourceSafeBest = bestWasTruncated ? trimTrailingSourceToken(best, new Set(openStack)).node : best;
    const redactedBest = sourceSafeBest ? redactDomPrivateUrls(sourceSafeBest) : null;
    aiMarkdown = redactedBest ? renderBoundedAiMarkdown(redactedBest, url, 40_000) : '';
  }
  return { ...base, title: (title || heading || fallbackTitle).slice(0, 500), markdown: blockedTitle ? '' : rendered,
    truncated, aiMarkdown,
    quality: blockedTitle || !rendered ? 'blocked' : text.length < 140 || wall.test(text) ? 'partial' : 'full' };
}
