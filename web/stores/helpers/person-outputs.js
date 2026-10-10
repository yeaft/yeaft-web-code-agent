/** Output bytes are browser-owned, bounded, read-only and fenced independently of
 * conversation polling. Closing never cancels Agent work or deletes a delivery. */
export const OUTPUT_MAX_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 65536;
const fail = code => Object.assign(new Error(code), { code });
const previewState = () => ({ status: 'idle', text: '', url: '', bytes: 0, totalBytes: 0, error: null, kind: '', blob: null });
export const outputState = () => ({ items: [], nextCursor: null, loaded: false, loading: false, error: null, historyPaged: false, tabs: [], selected: null, preview: previewState() });

export function safeOutputUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\//i.test(value)
    || /[\s\u0000-\u001f\u007f\\]/.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function outputPreviewKind(item) {
  if (item?.kind === 'link') return 'link';
  const mime = String(item?.mimeType || '').split(';')[0].toLowerCase();
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown') return 'markdown';
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || /^(application\/(json|[^;]+\+json|xml|javascript|x-javascript))$/.test(mime)) return 'text';
  return 'binary';
}

/** Static-only srcdoc: empty iframe sandbox is mandatory at the call site. CSP
 * denies network/scripts/forms; allowlisted markup also removes navigation,
 * refresh, embedded frames, event handlers and active attributes. */
export function staticOutputHtml(text) {
  // Template content is inert, including images/frames: parsing must not make
  // a network request before sanitization and CSP have taken effect.
  const template = document.createElement('template');
  template.innerHTML = String(text);
  const doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html');
  const tags = new Set('html head body title style div span p br hr h1 h2 h3 h4 h5 h6 pre code blockquote ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col b strong i em u s del ins small sub sup details summary figure figcaption img a section article header footer main nav aside'.split(' '));
  const attrs = new Set('class id style title lang dir colspan rowspan width height alt open'.split(' '));
  for (const node of [...template.content.querySelectorAll('*')]) {
    if (!tags.has(node.localName)) { node.remove(); continue; }
    for (const attr of [...node.attributes]) {
      if (!attrs.has(attr.name)) node.removeAttribute(attr.name);
    }
  }
  doc.body.append(template.content);
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";
  doc.head.prepend(csp);
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

function mergeItems(previous, next) {
  const seen = new Set();
  return [...next, ...previous].filter(item => item?.id && !seen.has(item.id) && seen.add(item.id));
}

/** request accepts AbortSignal but fencing remains authoritative if transport
 * cannot abort a remote read already in flight. identity includes auth, Agent,
 * person and controller generation. Object URLs never outlive these fences. */
export function createPersonOutputs({ state, request, identity, urls = URL }) {
  let version = 0;
  let listVersion = 0;
  let abort = null;
  let listAbort = null;
  let listIsLatest = false;
  const current = (v, key) => v === version && key === identity();
  function release() {
    version++;
    abort?.abort(); abort = null;
    if (state.preview.url) urls.revokeObjectURL(state.preview.url);
    state.preview = previewState();
  }
  function close() {
    release(); listVersion++;
    listAbort?.abort(); listAbort = null;
    state.loading = false;
  }
  function reset() {
    close();
    Object.assign(state, outputState());
  }
  function snapshot(page) {
    if (!page || !Array.isArray(page.items)) return;
    // An automatic snapshot supersedes an earlier manual latest-page request,
    // even when the pages overlap. Keep older-history requests unless a gap resets
    // their cursor below. Abort is advisory; the version fence is authoritative.
    if (state.loading && listIsLatest) {
      listVersion++;
      listAbort?.abort(); listAbort = null;
      state.loading = false;
    }
    const previous = new Set(state.items.map(item => item.id));
    // Latest-page refreshes must stay connected to the cached contiguous window.
    // More than one page of new deliveries can otherwise strand the missing page
    // behind an exhausted/older cursor. Restart history, but retain the reader.
    if (page.items.length && state.items.length && !page.items.some(item => previous.has(item.id))) {
      listVersion++;
      listAbort?.abort(); listAbort = null;
      state.loading = false;
      state.historyPaged = false;
      state.items = page.items;
      state.nextCursor = page.nextCursor ?? null;
    } else {
      state.items = mergeItems(state.items, page.items);
      if (!state.loaded || !state.historyPaged) state.nextCursor = page.nextCursor ?? null;
    }
    state.loaded = true;
  }
  async function list(more = false) {
    if (state.loading || (more && state.nextCursor == null)) return;
    const key = identity(), v = ++listVersion;
    listIsLatest = !more;
    state.loading = true; state.error = null;
    listAbort = new AbortController();
    const signal = listAbort.signal;
    try {
      const page = await request('outputs', { ...(more ? { cursor: state.nextCursor } : {}), limit: 20 }, { signal });
      if (v !== listVersion || key !== identity()) return;
      if (more) {
        state.items = mergeItems(page.items || [], state.items);
        state.historyPaged = true;
        state.nextCursor = page.nextCursor ?? null;
        state.loaded = true;
      } else {
        state.loading = false; listAbort = null;
        snapshot(page);
      }
    } catch (error) {
      if (v === listVersion && key === identity()) state.error = { code: error.code || 'requestFailed', message: error.message };
    } finally {
      if (v === listVersion && key === identity()) { state.loading = false; listAbort = null; }
    }
  }
  async function select(item) {
    if (item?.id === state.selected?.id && ['ready', 'loading'].includes(state.preview.status)) return;
    release();
    state.selected = item;
    if (!item) return;
    if (!state.tabs.some(tab => tab.item.id === item.id)) state.tabs.push({ item, scrollTop: 0, scrollLeft: 0 });
    const v = version, key = identity();
    const preview = state.preview;
    preview.kind = outputPreviewKind(item);
    preview.totalBytes = Number(item.size) || 0;
    if (item.kind === 'link') {
      if (safeOutputUrl(item.url)) preview.status = 'ready';
      else { preview.status = 'error'; preview.error = { code: 'unsafeUrl' }; }
      return;
    }
    if (preview.totalBytes > OUTPUT_MAX_BYTES) { preview.status = 'error'; preview.error = { code: 'tooLarge' }; return; }
    preview.status = 'loading';
    abort = new AbortController();
    const signal = abort.signal;
    const parts = [];
    let offset = 0;
    let expectedTotal = null;
    try {
      for (;;) {
        if (!current(v, key) || signal.aborted) return;
        const data = await request('output_read', { outputId: item.id, offset, maxBytes: CHUNK_BYTES }, { signal });
        if (!current(v, key) || signal.aborted) return;
        if (data.outputId !== item.id || data.offset !== offset || !Number.isSafeInteger(data.totalBytes) || data.totalBytes < 0
          || typeof data.data !== 'string' || data.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || typeof data.eof !== 'boolean') throw fail('invalidChunk');
        if (data.totalBytes > OUTPUT_MAX_BYTES) throw fail('tooLarge');
        if (expectedTotal !== null && data.totalBytes !== expectedTotal) throw fail('invalidChunk');
        expectedTotal = data.totalBytes;
        const raw = atob(data.data);
        const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
        if (bytes.length > CHUNK_BYTES || data.nextOffset !== offset + bytes.length || data.nextOffset > data.totalBytes
          || (!data.eof && !bytes.length) || (data.eof && data.nextOffset !== data.totalBytes)) throw fail('invalidChunk');
        parts.push(bytes); offset = data.nextOffset;
        preview.bytes = offset; preview.totalBytes = data.totalBytes;
        if (data.eof) break;
      }
      if (!current(v, key)) return;
      const bytes = new Uint8Array(offset);
      let position = 0;
      for (const part of parts) { bytes.set(part, position); position += part.length; }
      // Never create an app-origin executable HTML/SVG URL. Downloads are
      // attachment-only opaque octet-stream Blobs; HTML preview uses srcdoc.
      const mime = preview.kind === 'image' ? item.mimeType : 'application/octet-stream';
      const blob = new Blob([bytes], { type: mime });
      if (['markdown', 'text', 'html'].includes(preview.kind)) preview.text = new TextDecoder().decode(bytes);
      preview.blob = blob;
      preview.url = urls.createObjectURL(blob);
      preview.status = 'ready';
    } catch (error) {
      if (!current(v, key) || signal.aborted) return;
      preview.status = 'error'; preview.text = ''; preview.bytes = 0;
      preview.error = { code: error.code || 'requestFailed', message: error.message };
    }
  }
  function closeTab(id) {
    const index = state.tabs.findIndex(tab => tab.item.id === id);
    if (index < 0) return;
    state.tabs.splice(index, 1);
    if (state.selected?.id === id) return select(state.tabs[Math.min(index, state.tabs.length - 1)]?.item || null);
  }
  return { reset, snapshot, list, select, close, closeTab,
    resume() { if (state.selected && state.preview.status === 'idle') return select(state.selected); },
  };
}
