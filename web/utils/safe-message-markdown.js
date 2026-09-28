const escape = text => String(text ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let parser;
let constructor;

/** Read-only message Markdown, independent of Session file/tool actions.
 * Raw HTML is text; images never initiate network requests; only explicit
 * http(s)/mailto links are clickable. No shared renderer or content cache.
 */
export function renderSafeMessageMarkdown(text) {
  const Marked = globalThis.marked?.Marked;
  if (!Marked) return escape(text).replace(/\n/g, '<br>');
  if (constructor !== Marked) {
    constructor = Marked;
    parser = new Marked({ breaks: true, gfm: true, renderer: {
      html(token) { return escape(token.text); },
      image(token) { return escape(token.text); },
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        try {
          const url = new URL(token.href);
          if (['https:', 'http:', 'mailto:'].includes(url.protocol)) return `<a href="${escape(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        } catch { /* Non-URL and local file references remain text. */ }
        return label;
      },
    } });
  }
  try { return parser.parse(String(text ?? '')); }
  catch { return escape(text).replace(/\n/g, '<br>'); }
}
