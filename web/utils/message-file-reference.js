const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const API_PATH = /^\/api(?:\/|$)/;
const LINE_HASH = /#L(\d+)(?:C\d+)?$/i;
const LINE_SUFFIX = /:(\d+)(?::\d+)?$/;
const VERSION_BASENAME = /^v?\d+(?:\.\d+){1,}(?:[-+][A-Za-z\d.-]+)?$/i;
const ARCHIVE_EXTENSION = /\.(?:7z|bz2?|gz|rar|tar|tgz|xz|zip|zst)$/i;
const RASTER_IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i;
const KNOWN_EXTENSIONLESS_FILE = /^(?:README|LICENSE|CHANGELOG|CONTRIBUTING|Dockerfile|Makefile)(?:[-_.][A-Za-z\d-]+)?$/i;
const TEXT_TOKEN = /(?:file:\/\/\/|[A-Za-z]:[\\/]|(?:\.{1,2}|~)?[\\/])?[A-Za-z\d_.@+-]+(?:[\\/][A-Za-z\d_.@+-]+)*(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)?/gi;
const PROTECTED_HTML = /(<pre\b[^>]*>[\s\S]*?<\/pre>|<a\b[^>]*>[\s\S]*?<\/a>|<code\b[^>]*>[\s\S]*?<\/code>)|(<[^>]+>)|([^<]+)/gi;

const isRecognizableFilePath = value => {
  const basename = value.split(/[\\/]/).pop() || '';
  if (!basename || ARCHIVE_EXTENSION.test(basename)) return false;
  if (WINDOWS_ABSOLUTE_PATH.test(value) || /^(?:\/|\.\.?[\\/]|~[\\/])/.test(value)) return true;
  if (VERSION_BASENAME.test(basename)) return false;
  if (basename.startsWith('.') && basename.length > 1) return true;
  if (KNOWN_EXTENSIONLESS_FILE.test(basename)) return true;
  return /\.[A-Za-z\d][A-Za-z\d_-]*$/.test(basename);
};

export function resolveMessageFileReference(href) {
  if (typeof href !== 'string') return null;
  let value = href.trim();
  if (!value || value.startsWith('#')) return null;
  try { value = decodeURIComponent(value); } catch (_) {}

  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = url.pathname || '';
      if (url.hostname && url.hostname !== 'localhost') value = `//${url.hostname}${value}`;
    } catch (_) { return null; }
  } else if (URI_SCHEME.test(value) && !WINDOWS_ABSOLUTE_PATH.test(value)) return null;
  if (API_PATH.test(value)) return null;

  let line = null;
  const hashMatch = value.match(LINE_HASH);
  if (hashMatch) {
    line = Number(hashMatch[1]);
    value = value.slice(0, hashMatch.index);
  } else {
    const suffixMatch = value.match(LINE_SUFFIX);
    if (suffixMatch) {
      line = Number(suffixMatch[1]);
      value = value.slice(0, suffixMatch.index);
    }
  }

  value = value.split(/[?#]/, 1)[0]?.trim() || '';
  if (!value || value.endsWith('/') || !isRecognizableFilePath(value)) return null;
  return { path: value, line: Number.isFinite(line) && line > 0 ? line : null };
}

const decodeHtml = value => value
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trimTextToken = value => value.replace(/^[('"`]+/, '').replace(/[.)'"`,;!?]+$/, '');

function collectTextFileReferences(text, references) {
  const decoded = decodeHtml(text || '');
  for (const match of decoded.matchAll(TEXT_TOKEN)) {
    const candidate = trimTextToken(match[0]);
    const reference = resolveMessageFileReference(candidate);
    if (reference) references.add(reference.path);
  }
}

export function resolveMessageImageFileReference(src, workDir = '') {
  if (typeof src !== 'string') return null;
  const value = decodeHtml(src.trim());
  if (!value || /^\/\//.test(value) || /^\/(?:api|assets)(?:\/|$)/i.test(value)) return null;
  if (value.startsWith('/') && !/^file:\/\//i.test(value)) {
    const candidate = value.split(/[?#]/, 1)[0].replaceAll('\\', '/');
    const workspace = String(workDir || '').replaceAll('\\', '/').replace(/\/+$/, '');
    if (!workspace || (candidate !== workspace && !candidate.startsWith(`${workspace}/`))) return null;
  }
  const reference = resolveMessageFileReference(value);
  return reference && RASTER_IMAGE_EXTENSION.test(reference.path) ? reference : null;
}

export function collectMessageImageReferences(html, workDir = '') {
  if (typeof html !== 'string' || !html) return [];
  const references = new Set();
  for (const match of html.matchAll(/<img\b[^>]*?src=(['"])(.*?)\1[^>]*>/gi)) {
    const reference = resolveMessageImageFileReference(match[2], workDir);
    if (reference) references.add(reference.path);
  }
  return [...references];
}

export function collectMessageFileReferences(html, workDir = '') {
  if (typeof html !== 'string' || !html) return [];
  const references = new Set();
  html.replace(PROTECTED_HTML, (_match, protectedElement, tag, text) => {
    if (protectedElement) {
      if (/^<pre\b/i.test(protectedElement)) return '';
      const anchor = protectedElement.match(/^<a\s+[^>]*?href=(['"])(.*?)\1/i);
      if (anchor) {
        const reference = resolveMessageFileReference(anchor[2]);
        if (reference) references.add(reference.path);
        return '';
      }
      const codeText = protectedElement.replace(/^<code\b[^>]*>|<\/code>$/gi, '');
      const reference = resolveMessageFileReference(decodeHtml(codeText));
      if (reference) references.add(reference.path);
      return '';
    }
    if (!tag) collectTextFileReferences(text, references);
    return '';
  });
  for (const path of collectMessageImageReferences(html, workDir)) references.add(path);
  return [...references];
}

function decorateTextFileReferences(text, resolved) {
  return text.replace(TEXT_TOKEN, token => {
    const candidate = trimTextToken(token);
    const leading = token.slice(0, token.indexOf(candidate));
    const trailing = token.slice(token.indexOf(candidate) + candidate.length);
    const reference = resolveMessageFileReference(decodeHtml(candidate));
    const resolvedPath = reference && resolved.get(reference.path);
    if (!reference || !resolvedPath) return token;
    return `${leading}<a href="${escapeAttribute(candidate)}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference">${candidate}</a>${trailing}`;
  });
}

/** Render only Agent-confirmed references as file links. Unconfirmed Markdown
 * file anchors are downgraded to plain text; inline code remains inline code. */
export function decorateMessageFileReferences(html, resolvedReferences = {}, resolvedImageUrls = {}, workDir = '') {
  if (typeof html !== 'string' || !html) return html || '';
  const resolved = resolvedReferences instanceof Map
    ? resolvedReferences
    : new Map(Object.entries(resolvedReferences || {}));
  const imageUrls = resolvedImageUrls instanceof Map
    ? resolvedImageUrls
    : new Map(Object.entries(resolvedImageUrls || {}));
  const images = html.replace(/<img\b([^>]*?)src=(['"])(.*?)\2([^>]*)>/gi,
    (match, before, quote, src, after) => {
      const reference = resolveMessageImageFileReference(src, workDir);
      if (!reference) return match;
      const previewUrl = imageUrls.get(reference.path);
      if (!previewUrl) {
        return `<span class="message-local-image-pending" data-local-image-path="${escapeAttribute(reference.path)}"></span>`;
      }
      return `<img${before}src="${escapeAttribute(previewUrl)}"${after} data-local-image-path="${escapeAttribute(reference.path)}">`;
    });
  const anchors = images.replace(/<a\s+([^>]*?href=(['"])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi,
    (match, _attrs, _quote, href, label) => {
      const reference = resolveMessageFileReference(href);
      if (!reference) return match;
      const resolvedPath = resolved.get(reference.path);
      if (!resolvedPath) return label;
      return `<a href="${escapeAttribute(href)}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference">${label}</a>`;
    });

  const codeLinks = anchors.replace(/(<pre\b[^>]*>[\s\S]*?<\/pre>)|<code>([^<]+)<\/code>/gi, (match, pre, codeText) => {
    if (pre || !codeText) return match;
    const decoded = decodeHtml(codeText);
    const reference = resolveMessageFileReference(decoded);
    const resolvedPath = reference && resolved.get(reference.path);
    if (!reference || !resolvedPath) return match;
    return `<a href="${escapeAttribute(decoded)}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference"><code>${codeText}</code></a>`;
  });

  return codeLinks.replace(PROTECTED_HTML, (match, protectedElement, tag, text) => {
    if (protectedElement || tag) return match;
    return decorateTextFileReferences(text, resolved);
  });
}
