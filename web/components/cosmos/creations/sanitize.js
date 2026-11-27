/**
 * Strict allowlist HTML sanitizer for Cosmos Creations Markdown rendering.
 *
 * Strips dangerous elements (`script`, `iframe`, `object`, `embed`, `svg`, `math`,
 * `style`, `form`, etc.), all `on*` event attributes, and unsafe URL schemes on
 * `href`/`src` before any `v-html` sink.
 */

const BLOCKED_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'style',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'link',
  'meta',
  'base',
  'applet',
  'template',
  'noscript',
  'frame',
  'frameset',
]);

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'span',
  'div',
  'figure',
  'figcaption',
  'details',
  'summary',
  'kbd',
  'abbr',
  'cite',
  'q',
]);

const ALLOWED_ATTRS_BY_TAG = {
  a: new Set(['href', 'title', 'target', 'rel']),
  img: new Set(['src', 'alt', 'title', 'width', 'height', 'loading']),
  th: new Set(['colspan', 'rowspan', 'align']),
  td: new Set(['colspan', 'rowspan', 'align']),
  code: new Set(['class']),
  pre: new Set(['class']),
  span: new Set(['class']),
  div: new Set(['class']),
  ol: new Set(['start']),
  details: new Set(['open']),
  abbr: new Set(['title']),
};

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[ch]);
}

/**
 * Validate a URL for `href` or `src`.
 * Allows `http:`, `https:`, `mailto:` (href only), and safe relative URLs.
 * Rejects `javascript:`, `vbscript:`, `data:`, protocol-relative `//`, etc.
 */
export function isSafeCreationUrl(rawUrl, { allowMailto = false } = {}) {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) return false;
  // Strip control characters and whitespace before scheme inspection
  const normalized = trimmed.replace(/[\u0000-\u001f\u007f\s]+/g, '');
  if (!normalized) return false;
  if (normalized.startsWith('//')) return false;
  if (
    normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.startsWith('#')
  ) {
    return true;
  }
  const schemeMatch = normalized.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) {
    // Relative path without leading slash (e.g. "assets/img.png")
    return true;
  }
  const scheme = schemeMatch[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') return true;
  if (allowMailto && scheme === 'mailto') return true;
  return false;
}

function sanitizeClassValue(raw) {
  return String(raw || '')
    .split(/\s+/)
    .filter((tok) => /^[a-zA-Z0-9_-]+$/.test(tok))
    .join(' ');
}

function sanitizeNode(node, doc) {
  if (!node) return null;
  if (node.nodeType === 3) {
    return doc.createTextNode(node.nodeValue || '');
  }
  if (node.nodeType !== 1) {
    return null;
  }

  const tag = String(node.tagName || '').toLowerCase();
  if (BLOCKED_TAGS.has(tag)) {
    return null;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    const frag = doc.createDocumentFragment();
    for (const child of Array.from(node.childNodes || [])) {
      const cleanChild = sanitizeNode(child, doc);
      if (cleanChild) frag.appendChild(cleanChild);
    }
    return frag;
  }

  const el = doc.createElement(tag);
  const allowedAttrs = ALLOWED_ATTRS_BY_TAG[tag];

  if (allowedAttrs && node.attributes) {
    for (const attr of Array.from(node.attributes)) {
      const name = String(attr.name || '').toLowerCase();
      if (!name || name.startsWith('on') || !allowedAttrs.has(name)) continue;
      const value = String(attr.value ?? '');

      if (name === 'href') {
        if (isSafeCreationUrl(value, { allowMailto: true })) {
          el.setAttribute('href', value.trim());
        }
      } else if (name === 'src') {
        if (isSafeCreationUrl(value, { allowMailto: false })) {
          el.setAttribute('src', value.trim());
        }
      } else if (name === 'class') {
        const cleanClass = sanitizeClassValue(value);
        if (cleanClass) el.setAttribute('class', cleanClass);
      } else if (name === 'target') {
        if (value === '_blank') el.setAttribute('target', '_blank');
      } else if (name === 'rel') {
        el.setAttribute('rel', 'noopener noreferrer');
      } else {
        el.setAttribute(name, value);
      }
    }
  }

  if (tag === 'a' && el.hasAttribute('href')) {
    const href = el.getAttribute('href') || '';
    if (!href.startsWith('#')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }

  for (const child of Array.from(node.childNodes || [])) {
    const cleanChild = sanitizeNode(child, doc);
    if (cleanChild) el.appendChild(cleanChild);
  }

  return el;
}

/**
 * Sanitize HTML string using a strict DOMParser allowlist.
 */
export function sanitizeCreationHtml(html) {
  const input = String(html ?? '');
  if (!input) return '';

  if (typeof DOMParser === 'undefined') {
    return escapeHtml(input);
  }

  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(input, 'text/html');
    const outDoc = parsed.implementation
      ? parsed.implementation.createHTMLDocument('')
      : document;
    const container = outDoc.createElement('div');

    for (const child of Array.from(parsed.body?.childNodes || [])) {
      const cleanChild = sanitizeNode(child, outDoc);
      if (cleanChild) container.appendChild(cleanChild);
    }
    return container.innerHTML;
  } catch {
    return escapeHtml(input);
  }
}
