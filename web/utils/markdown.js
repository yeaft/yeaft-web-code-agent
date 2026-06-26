/**
 * Shared Markdown rendering utilities
 */

let _configured = false;
let _mermaidInitializedTheme = null;
let _mermaidRenderSeq = 0;

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
  _configured = true;
}

export function addCodeBlockCopyButtons(html) {
  return html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
    (match, attrs, code) => {
      const langMatch = attrs.match(/class="language-(\w+)"/);
      const lang = langMatch ? langMatch[1] : '';
      return `<div class="code-block-wrapper">
        <div class="code-block-header">
          <span class="code-lang">${lang}</span>
          <button class="code-copy-btn" onclick="window.copyCodeBlock(this)" title="Copy">
            <svg viewBox="0 0 24 24" width="14" height="14">
              <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
          </button>
        </div>
        <pre><code${attrs}>${code}</code></pre>
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
    const code = codeEl.textContent || '';
    if (!code.trim()) continue;
    pre.dataset.mermaidRendered = 'true';
    try {
      const id = `mermaid-${Date.now()}-${_mermaidRenderSeq++}`;
      const { svg } = await mermaid.render(id, code);
      const div = document.createElement('div');
      div.className = 'mermaid-rendered';
      div.innerHTML = svg;
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
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<div class="code-block-wrapper"><pre><code class="language-${lang}">${escape(code.trim())}</code></pre></div>`)
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
