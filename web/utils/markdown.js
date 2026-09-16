/**
 * Shared Markdown rendering utilities
 */
import { t } from './i18n.js';
import { mathExtensions } from './markdown-math.js';

let _configured = false;
let _mermaidInitializedTheme = null;
let _mermaidRenderSeq = 0;

function safeDownloadFilename(base, ext) {
  const cleanBase = String(base || 'mermaid-diagram')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'mermaid-diagram';
  return `${cleanBase}.${ext}`;
}

function decodeHtmlEntities(html) {
  if (typeof document === 'undefined') {
    return String(html || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  const textarea = document.createElement('textarea');
  textarea.innerHTML = String(html || '');
  return textarea.value;
}

function mermaidSourceAttribute(lang, codeHtml) {
  if (lang !== 'mermaid') return '';
  return ` data-mermaid-source="${encodeURIComponent(decodeHtmlEntities(codeHtml))}"`;
}

function readMermaidSource(codeEl) {
  const encoded = codeEl?.dataset?.mermaidSource;
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return '';
  }
}

function downloadUrl(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getSvgDimensions(svgEl) {
  const parseSize = (value) => {
    const num = Number.parseFloat(String(value || '').replace('px', ''));
    return Number.isFinite(num) && num > 0 ? num : null;
  };
  const width = parseSize(svgEl.getAttribute('width'));
  const height = parseSize(svgEl.getAttribute('height'));
  if (width && height) return { width, height };

  const viewBox = svgEl.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/\s+/).map(Number.parseFloat);
    if (parts.length === 4 && parts.every((part) => Number.isFinite(part)) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }

  const rect = svgEl.getBoundingClientRect?.();
  if (rect?.width && rect?.height) return { width: rect.width, height: rect.height };
  return { width: 1200, height: 800 };
}

function getCssVariable(name, fallback) {
  if (typeof getComputedStyle === 'undefined' || typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function forceSvgDimensions(svgEl, width, height) {
  svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svgEl.setAttribute('width', String(width));
  svgEl.setAttribute('height', String(height));
  if (!svgEl.getAttribute('viewBox')) {
    svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
}

async function exportMermaidImageWithHtmlToImage(svgEl, format, width, height) {
  if (!window.htmlToImage) return false;
  const filename = safeDownloadFilename('mermaid-diagram', format === 'jpg' ? 'jpg' : 'png');
  const options = {
    backgroundColor: getCssVariable('--bg-main', 'white'),
    height,
    pixelRatio: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
    // Do not copy the live auto margins into the fixed-size export canvas.
    style: { margin: '0' },
    width,
  };
  const dataUrl = format === 'jpg'
    ? await window.htmlToImage.toJpeg(svgEl, { ...options, quality: 0.92 })
    : await window.htmlToImage.toPng(svgEl, options);
  downloadUrl(dataUrl, filename);
  return true;
}

async function exportMermaidImage(renderedEl, format) {
  const svgEl = renderedEl.querySelector('svg');
  if (!svgEl) throw new Error('No Mermaid SVG found');

  const { width, height } = getSvgDimensions(svgEl);
  try {
    if (await exportMermaidImageWithHtmlToImage(svgEl, format, width, height)) return;
  } catch (error) {
    console.warn('Mermaid html-to-image export failed, falling back:', error);
  }

  const clonedSvg = svgEl.cloneNode(true);
  forceSvgDimensions(clonedSvg, width, height);

  const svgText = new XMLSerializer().serializeToString(clonedSvg);
  const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    const loaded = new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Failed to load Mermaid SVG for export'));
    });
    image.src = svgUrl;
    await loaded;

    const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.scale(scale, scale);
    if (format === 'jpg') {
      ctx.fillStyle = getCssVariable('--bg-main', 'white');
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(image, 0, 0, width, height);

    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Failed to export Mermaid image')), mime, 0.92);
    });
    downloadBlob(blob, safeDownloadFilename('mermaid-diagram', format === 'jpg' ? 'jpg' : 'png'));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function exportMermaidMarkdown(code) {
  const content = `\`\`\`mermaid\n${String(code || '').trim()}\n\`\`\`\n`;
  downloadBlob(new Blob([content], { type: 'text/markdown;charset=utf-8' }), safeDownloadFilename('mermaid-diagram', 'md'));
}

function createMermaidExportControls(renderedEl, code) {
  const controls = document.createElement('div');
  controls.className = 'mermaid-export-controls';
  controls.setAttribute('aria-label', t('mermaid.export'));

  const items = [
    { label: t('mermaid.exportMd'), action: () => exportMermaidMarkdown(code) },
    { label: t('mermaid.exportPng'), action: () => exportMermaidImage(renderedEl, 'png') },
    { label: t('mermaid.exportJpg'), action: () => exportMermaidImage(renderedEl, 'jpg') },
  ];
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mermaid-export-btn';
    button.textContent = item.label;
    button.title = item.label;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await item.action();
      } catch (error) {
        console.warn('Mermaid export failed:', error);
      }
    });
    controls.appendChild(button);
  }

  return controls;
}

export function configureMarked() {
  if (_configured || typeof marked === 'undefined') return;
  marked.setOptions({
    highlight: (code, lang) => {
      if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch {}
      }
      return code;
    },
    breaks: true,
    gfm: true
  });
  marked.use?.({ extensions: mathExtensions() });
  _configured = true;
}

export function addCodeBlockCopyButtons(html) {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    (match, attrs, code) => {
      const langMatch = attrs.match(/class="language-(\w+)"/);
      const lang = langMatch ? langMatch[1] : '';
      const sourceAttr = mermaidSourceAttribute(lang, code);
      return `<div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${lang}</span>
          <button class="code-copy-btn" onclick="window.copyCodeBlock(this)" title="Copy">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
          </button>
        </div>
        <pre><code${attrs}${sourceAttr}>${code}</code></pre>
      </div>`;
    });
}

export function wrapTables(html) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g,
    (match) => `<div class="table-scroll-wrapper">${match}</div>`);
}

export function initMermaid() {
  if (typeof mermaid === 'undefined') return false;
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
  if (_mermaidInitializedTheme === theme) return true;
  try {
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict' });
    _mermaidInitializedTheme = theme;
    return true;
  } catch (e) {
    console.error('Mermaid init error:', e);
    return false;
  }
}

export async function renderMermaidIn(container) {
  if (!container || !initMermaid()) return;
  const codeBlocks = container.querySelectorAll('pre code.language-mermaid:not([data-mermaid-error])');
  for (const codeEl of codeBlocks) {
    const pre = codeEl.closest('pre');
    if (!pre || pre.dataset.mermaidRendered === 'true') continue;
    const wrapper = pre.closest('.code-block-wrapper');
    const code = readMermaidSource(codeEl) || codeEl.textContent || '';
    if (!code.trim()) continue;
    pre.dataset.mermaidRendered = 'true';
    try {
      const id = `mermaid-${Date.now()}-${_mermaidRenderSeq++}`;
      const { svg } = await mermaid.render(id, code);
      const div = document.createElement('div');
      div.className = 'mermaid-rendered';
      div.innerHTML = svg;
      div.dataset.mermaidSource = code;
      div.appendChild(createMermaidExportControls(div, code));
      (wrapper || pre).replaceWith(div);
    } catch (e) {
      pre.dataset.mermaidRendered = 'false';
      codeEl.dataset.mermaidError = 'true';
      console.warn('Mermaid render error:', e);
    }
  }
}

export function simpleMarkdownFallback(text) {
  if (!text || typeof text !== 'string') return '';
  const escape = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const trimmed = code.trim();
      const sourceAttr = lang === 'mermaid' ? ` data-mermaid-source="${encodeURIComponent(trimmed)}"` : '';
      return `<div class="code-block-wrapper"><pre><code class="language-${lang}"${sourceAttr}>${escape(trimmed)}</code></pre></div>`;
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\n/g, '<br>');
}

/**
 * Strip ROUTE/TASKS blocks from raw role text.
 *
 * task-328 — extracted as a dedicated export so consumers can strip
 * structural routing blocks before piping content through markdown rendering. Behaviour:
 *
 *   1. Closed ROUTE / TASKS blocks — tolerate END variants
 *      (END_ROUTE / END ROUTE / END-ROUTE / ENDROUTE / END / END:).
 *   2. Streaming / unclosed ROUTE/TASKS — strip ONLY up to a structural
 *      cutoff (blank line + `---` or `<kanban|recent-routes|task-context>`)
 *      OR end-of-string. Bounded: post-ROUTE prose in its own paragraph
 *      survives.
 *
 * Returns the cleaned string (trimmed). Pure and side-effect free.
 */
export function stripRouteBlocks(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text;
  out = out.replace(/---\s*ROUTE\s*---[\s\S]*?---\s*(?:END[_ \-]?ROUTE|ENDROUTE|END)\s*:?\s*---/gi, '').trim();
  out = out.replace(/---\s*TASKS\s*---[\s\S]*?---\s*(?:END[_ \-]?TASKS|ENDTASKS|END)\s*:?\s*---/gi, '').trim();
  out = out.replace(
    /---\s*ROUTE\s*---[\s\S]*?(?=\n[ \t]*\n+(?:---(?!\s*ROUTE)|<(?:kanban|recent-routes|task-context)\b)|$)/gi,
    ''
  ).trim();
  out = out.replace(
    /---\s*TASKS\s*---[\s\S]*?(?=\n[ \t]*\n+(?:---(?!\s*TASKS)|<(?:kanban|recent-routes|task-context)\b)|$)/gi,
    ''
  ).trim();
  return out;
}

/**
 * Render markdown text to HTML.
 * Strips ROUTE/TASKS blocks (complete and partial/streaming),
 * uses marked.js with code highlighting,
 * falls back to simple regex-based rendering.
 * Results are cached by input text to avoid repeated parsing.
 */
const _mdCache = new Map();
const _MD_CACHE_MAX = 2000;

export function renderMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  // task-328: defensive strip. Other callers (Chat / Yeaft) and streaming
  // bursts may still arrive with raw ROUTE/TASKS markers. The strip is
  // bounded so post-ROUTE prose is preserved.
  text = stripRouteBlocks(text);
  if (!text) return '';

  const cached = _mdCache.get(text);
  if (cached !== undefined) return cached;

  configureMarked();

  let html;
  if (typeof marked !== 'undefined') {
    try {
      html = wrapTables(addCodeBlockCopyButtons(marked.parse(text)));
    } catch (e) {
      console.error('Markdown parsing error:', e);
    }
  }
  if (!html) html = simpleMarkdownFallback(text);

  // Evict oldest entries when cache is full
  if (_mdCache.size >= _MD_CACHE_MAX) {
    const firstKey = _mdCache.keys().next().value;
    _mdCache.delete(firstKey);
  }
  _mdCache.set(text, html);
  return html;
}

/**
 * Clear the markdown render cache (for testing or conversation switch).
 */
export function clearMarkdownCache() {
  _mdCache.clear();
}

export function resetMermaidForTests() {
  _mermaidInitializedTheme = null;
  _mermaidRenderSeq = 0;
}
