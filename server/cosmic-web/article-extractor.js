import { decodeEntities, parseAttributesLinear, resolveHttpUrl, scanMarkup } from './rss-parser.js';

export const ARTICLE_EXTRACTOR_VERSION = 2;

const discard = new Set('script style noscript svg nav header footer aside form iframe template button'.split(' '));
const rawTags = new Set(['script', 'style', 'iframe']);
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const noise = /(?:^|[\s_-])(?:ad|ads|advert(?:isement|ising)?|sidebar|cookie(?:-banner)?|related-posts|social-share|newsletter|breadcrumbs)(?=$|[\s_-])/i;
const container = new Set(['article', 'main', 'section', 'div', 'body', 'root']);
const blocks = new Set('p div section article main h1 h2 h3 h4 h5 h6 ul ol li pre blockquote table tr br'.split(' '));
const normalize = text => text.replace(/\s+/gu, ' ').trim();
const escapeMd = text => text.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&').replace(/^([0-9]+)\.(?= )/gm, '$1\\.').replace(/^[-+=](?= )/gm, '\\$&');

function dropTrailingToken(str) {
  let end = str.length;
  while (end > 0 && !/\s/u.test(str[end - 1])) end--;
  return end === str.length ? str : str.slice(0, end);
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

function plain(node, cutoffSet = null) {
  return typeof node === 'string'
    ? node
    : node.children.map(child => plain(child, cutoffSet)).join('') + (blocks.has(node.tag) && !cutoffSet?.has(node) ? '\n' : '');
}

function markdown(node, url, cutoffSet = null) {
  if (typeof node === 'string') return escapeMd(node.replace(/\s+/gu, ' '));
  const { tag, children, attrs } = node;
  const openAtCutoff = Boolean(cutoffSet?.has(node));
  if (['head', 'title'].includes(tag)) return '';
  if (tag === 'br') return '\n';
  if (tag === 'pre' || tag === 'code') {
    const raw = plain(node, cutoffSet);
    const code = openAtCutoff ? raw : raw.trimEnd();
    if (openAtCutoff && !code) return '';
    let width = tag === 'pre' ? 3 : 1;
    for (const [run] of code.matchAll(/`+/g)) width = Math.max(width, run.length + 1);
    const fence = '`'.repeat(width);
    if (openAtCutoff) {
      // Omit closing fence/backtick when source markup was cut inside <pre>/<code> so trailing token drops remove the cut source token.
      return tag === 'pre' ? `\n\n${fence}\n${code}` : `${fence} ${code.replace(/\n/g, ' ')}`;
    }
    return tag === 'pre' ? `\n\n${fence}\n${code}\n${fence}\n\n` : `${fence} ${code.replace(/\n/g, ' ')} ${fence}`;
  }
  if (tag === 'ul' || tag === 'ol') {
    const lines = children.filter(n => n.tag === 'li').map((n, i) => {
      const marker = tag === 'ul' ? '- ' : `${i + 1}. `;
      const inner = markdown(n, url, cutoffSet);
      const body = cutoffSet?.has(n) ? inner.trimStart() : inner.trim();
      return marker + body.replace(/\n/g, `\n${' '.repeat(marker.length)}`);
    });
    return openAtCutoff ? `\n\n${lines.join('\n')}` : `\n\n${lines.join('\n')}\n\n`;
  }
  const text = children.map(n => markdown(n, url, cutoffSet)).join('');
  if (!text.trim()) return '';
  const body = openAtCutoff ? text.trimStart() : text.trim();
  if (/^h[1-6]$/.test(tag)) return openAtCutoff ? `\n\n${'#'.repeat(Number(tag[1]))} ${body}` : `\n\n${'#'.repeat(Number(tag[1]))} ${body}\n\n`;
  if (tag === 'blockquote') return openAtCutoff ? `\n\n${body.split('\n').map(line => `> ${line}`).join('\n')}` : `\n\n${body.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
  if (tag === 'em' || tag === 'i') return openAtCutoff ? `*${body}` : `*${body}*`;
  if (tag === 'strong' || tag === 'b') return openAtCutoff ? `**${body}` : `**${body}**`;
  if (tag === 'a') {
    if (openAtCutoff) return text;
    const link = resolveHttpUrl(attrs.href, url);
    return link ? `[${body}](<${link.replace(/[<>]/g, encodeURIComponent)}>)` : text;
  }
  return blocks.has(tag) ? (openAtCutoff ? `\n\n${body}` : `\n\n${body}\n\n`) : text;
}

export function extractCleanArticle(html, sourceUrl, fallbackTitle = '') {
  const url = resolveHttpUrl(sourceUrl);
  const base = { title: fallbackTitle, url, sourceUrl: url, markdown: '', extractorVersion: ARTICLE_EXTRACTOR_VERSION, truncated: false };
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
  const bestWasTruncated = scanMeta.truncated && openStack.includes(best);
  const truncated = !blockedTitle && (fullRendered.length > 40_000 || scanMeta.truncated);
  const rendered = fullRendered.slice(0, 40_000);
  // Derive a source-cutoff-safe AI projection before closing Markdown syntax is synthesized (keeping Clean Article display intact).
  let aiMarkdown;
  if (truncated) {
    const aiSource = bestWasTruncated ? markdown(best, url, new Set(openStack)).trimStart() : fullRendered;
    aiMarkdown = (bestWasTruncated || aiSource.length > 40_000) ? dropTrailingToken(aiSource.slice(0, 40_000)) : rendered;
  }
  return { ...base, title: (title || heading || fallbackTitle).slice(0, 500), markdown: blockedTitle ? '' : rendered,
    truncated, ...(truncated ? { aiMarkdown } : {}),
    quality: blockedTitle || !rendered ? 'blocked' : text.length < 140 || wall.test(text) ? 'partial' : 'full' };
}
