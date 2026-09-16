const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const API_PATH = /^\/api(?:\/|$)/i;
const LINE_HASH = /#L(\d+)(?:C\d+)?(?:[-–]L?\d+(?:C\d+)?)?$/i;
const LINE_SUFFIX = /:(\d+)(?::\d+)?(?:[-–]\d+(?::\d+)?)?$/;
const VERSION_BASENAME = /^v?\d+(?:\.\d+){1,}(?:[-+][A-Za-z\d.-]+)?$/i;
const ARCHIVE_EXTENSION = /\.(?:7z|bz2?|gz|rar|tar|tgz|xz|zip|zst)$/i;
const RASTER_IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i;
const KNOWN_EXTENSIONLESS_FILE = /^(?:README|LICENSE|CHANGELOG|CONTRIBUTING|Dockerfile|Makefile)(?:[-_.][A-Za-z\d-]+)?$/i;
// Consume URLs as a whole so their path is never mistaken for a local file.
// Bare paths support Unicode; paths containing spaces belong in inline code or
// Markdown links, where the boundaries are explicit rather than guessed.
const TEXT_TOKEN = /(?<![\p{L}\p{N}\p{M}\p{S}_.@%&+\\/~-])(?:[A-Za-z][A-Za-z\d+.-]*:\d+(?::\d+)?(?:[-–]\d+(?::\d+)?)?(?=$|[\s)\]},;!?，。；（）])|[A-Za-z][A-Za-z\d+.-]*:[^\s<>"'，。；（）]+|\/\/[^\s<>"'，。；（）]+|(?:[A-Za-z]:[\\/]|(?:\.{1,2}|~)?[\\/])?(?:&[A-Za-z][A-Za-z\d]*;|[\p{L}\p{N}\p{M}\p{S}\u00a0_.@%&+-])+(?:[\\/](?:&[A-Za-z][A-Za-z\d]*;|[\p{L}\p{N}\p{M}\p{S}\u00a0_.@%&+-])+)*(?:#L\d+(?:C\d+)?(?:[-–]L?\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:[-–]\d+(?::\d+)?)?)?)/giu;
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

export function resolveMessageFileReference(href, { htmlEncoded = true } = {}) {
  if (typeof href !== 'string') return null;
  let value = htmlEncoded ? decodeHtml(href.trim()) : href.trim();
  if (!value || value.startsWith('#') || value.startsWith('//')) return null;

  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = (url.pathname || '') + url.hash;
      if (url.hostname && url.hostname !== 'localhost') value = `//${url.hostname}${value}`;
      // file:///C:/repo/file.js is a Windows path, not a POSIX /C: directory.
      else if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
    } catch (_) { return null; }
  }
  try { value = decodeURIComponent(value); } catch (_) {}
  if (API_PATH.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;

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

  // A bare filename with a line suffix (main.js:20) also matches URI_SCHEME.
  // Classify only after removing the supported line syntax.
  if (URI_SCHEME.test(value) && !WINDOWS_ABSOLUTE_PATH.test(value)) return null;
  value = value.split(/[?#]/, 1)[0]?.trim() || '';
  if (!value || value.endsWith('/') || !isRecognizableFilePath(value)) return null;
  return { path: value, line: Number.isFinite(line) && line > 0 ? line : null };
}

function decodeHtml(value) {
  if (!value.includes('&')) return value;
  if (typeof document !== 'undefined') {
    // Decode text, never tags. The detached textarea handles the browser's full
    // entity table without rendering active content; decode exactly one layer.
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value.replace(/</g, '&lt;');
    return textarea.value;
  }
  // Non-browser readers preserve unknown entities as one token, never a suffix.
  return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|copy|#\d+|#x[\da-f]+);/gi, entity => {
    const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': '\u00a0', '&copy;': '©' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const hex = entity[2]?.toLowerCase() === 'x';
    const point = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}
const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trimTextToken = value => value.replace(/^[('"`]+/, '').replace(/[.)'"`,;!?]+$/, '');

function collectTextFileReferences(text, references) {
  const decoded = decodeHtml(text || '');
  for (const match of decoded.matchAll(TEXT_TOKEN)) {
    const candidate = trimTextToken(match[0]);
    const reference = resolveMessageFileReference(candidate, { htmlEncoded: false });
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
  const reference = resolveMessageFileReference(value, { htmlEncoded: false });
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
      const reference = resolveMessageFileReference(codeText);
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
  // Collection and decoration must tokenize the same decoded text. Escape all
  // text again when writing HTML so entities cannot split paths or become tags.
  const decoded = decodeHtml(text);
  let result = '';
  let offset = 0;
  for (const match of decoded.matchAll(TEXT_TOKEN)) {
    const candidate = trimTextToken(match[0]);
    const reference = resolveMessageFileReference(candidate, { htmlEncoded: false });
    const resolvedPath = reference && resolved.get(reference.path);
    if (!reference || !resolvedPath) continue;
    const start = match.index + match[0].indexOf(candidate);
    result += escapeAttribute(decoded.slice(offset, start));
    result += `<a href="${escapeAttribute(candidate)}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference">${escapeAttribute(candidate)}</a>`;
    offset = start + candidate.length;
  }
  return offset ? result + escapeAttribute(decoded.slice(offset)) : text;
}

/** Render explicit Markdown links and inline-code file references immediately,
 * using Agent-confirmed canonical paths when available. Ordinary bare paths
 * remain unlinked until confirmed to avoid noisy false positives. */
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
      const resolvedPath = resolved.get(reference.path) || reference.path;
      return `<a href="${escapeAttribute(decodeHtml(href))}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference">${label}</a>`;
    });

  const codeLinks = anchors.replace(/(<pre\b[^>]*>[\s\S]*?<\/pre>|<a\b[^>]*>[\s\S]*?<\/a>)|<code>([^<]+)<\/code>/gi, (match, protectedElement, codeText) => {
    if (protectedElement || !codeText) return match;
    const decoded = decodeHtml(codeText);
    const reference = resolveMessageFileReference(decoded, { htmlEncoded: false });
    if (!reference) return match;
    const resolvedPath = resolved.get(reference.path) || reference.path;
    return `<a href="${escapeAttribute(decoded)}" data-resolved-file-path="${escapeAttribute(resolvedPath)}" class="message-file-reference"><code>${codeText}</code></a>`;
  });

  return codeLinks.replace(PROTECTED_HTML, (match, protectedElement, tag, text) => {
    if (protectedElement || tag) return match;
    return decorateTextFileReferences(text, resolved);
  });
}
