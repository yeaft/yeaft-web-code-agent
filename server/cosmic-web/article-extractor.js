import { decodeEntities, parseAttributesLinear, resolveHttpUrl, scanMarkup } from './rss-parser.js';

const discard = new Set('script style noscript svg nav header footer aside form iframe template button'.split(' '));
const rawTags = new Set(['script', 'style', 'iframe']);
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const noise = /(?:^|[\s_-])(?:ad|ads|advert(?:isement|ising)?|sidebar|cookie(?:-banner)?|related-posts|social-share|newsletter|breadcrumbs)(?=$|[\s_-])/i;
const container = new Set(['article', 'main', 'section', 'div', 'body', 'root']);
const blocks = new Set('p div section article main h1 h2 h3 h4 h5 h6 ul ol li pre blockquote table tr br'.split(' '));
const normalize = text => text.replace(/\s+/gu, ' ').trim();
const escapeMd = text => text.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&').replace(/^([0-9]+)\.(?= )/gm, '$1\\.').replace(/^[-+=](?= )/gm, '\\$&');

function tree(html) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  for (const token of scanMarkup(html, { rawTags })) {
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
  return root;
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
  const base = { title: fallbackTitle, url, sourceUrl: url, markdown: '' };
  if (url) {
    const { hostname, pathname } = new URL(url);
    if (['s.weibo.com', 'top.baidu.com', 'search.bilibili.com'].includes(hostname) ||
        ((hostname === 'toutiao.com' || hostname.endsWith('.toutiao.com')) && /^\/(?:trending|hot-event)(?:\/|$)/.test(pathname))) {
      return { ...base, quality: 'search_only' };
    }
  }
  if (!html) return { ...base, quality: 'blocked' };
  const root = tree(html);
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
  const rendered = markdown(best, url).trim().slice(0, 40_000);
  return { ...base, title: (title || heading || fallbackTitle).slice(0, 500), markdown: blockedTitle ? '' : rendered,
    quality: blockedTitle || !rendered ? 'blocked' : text.length < 140 || wall.test(text) ? 'partial' : 'full' };
}
