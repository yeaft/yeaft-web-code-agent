/**
 * filePreview — File preview composable for FilesTab.
 * Manages Markdown and HTML preview/rendering, Mermaid diagrams, Office/PDF/Image preview.
 */
import { renderMermaidIn } from '../../utils/markdown.js';
import { isMarkdownFile, isHtmlFile, isPreviewableTextFile } from './fileEditor.js';

/** Build an inert, network-free document; never insert workspace HTML into the app DOM. */
export function createHtmlPreviewDocument(content, { background = '', color = '', colorScheme = 'light' } = {}) {
  // A document without a browsing context does not execute scripts or fetch
  // resources while parsing. Unlike a template fragment it preserves head/body
  // attributes and styles in full HTML documents.
  const doc = document.implementation.createHTMLDocument('');
  // document.write on this detached document preserves <html> attributes too;
  // assigning documentElement.innerHTML loses them in real browsers.
  doc.open();
  doc.write(content);
  doc.close();
  doc.querySelectorAll('[src], [srcset], [poster], image, use').forEach(node => {
    for (const name of ['src', 'poster', 'href', 'xlink:href']) {
      const value = node.getAttribute(name);
      if (value != null && !value.trim().toLowerCase().startsWith('data:')) node.removeAttribute(name);
    }
    node.removeAttribute('srcset');
  });
  // Templates are inert during this parse but declarative Shadow DOM can become
  // active when srcdoc is parsed. querySelectorAll does not visit template.content;
  // exclude templates entirely rather than serialize uninspected hidden subtrees.
  doc.querySelectorAll('script, base, meta[http-equiv], iframe, frame, frameset, object, embed, link, template, animate, animateMotion, animateTransform, set, discard').forEach(node => node.remove());
  // Sandbox does not block self-navigation. Even fragments in srcdoc can resolve
  // against the app URL (not this document), so disable all link navigation.
  // SVG supports namespaced xlink:href, and SMIL could restore a URL dynamically;
  // remove both link attributes and animation elements for this static preview.
  doc.querySelectorAll('*').forEach(node => {
    // MathML can also make elements into links, not only HTML/SVG <a>.
    for (const attr of [...node.attributes]) {
      if (attr.localName === 'href' || attr.name === 'xlink:href') {
        const isDataImage = node.localName === 'image' && attr.value.trim().toLowerCase().startsWith('data:');
        if (!isDataImage) node.removeAttributeNode(attr);
      }
    }
    node.removeAttribute('target');
    node.removeAttribute('ping');
  });
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const defaults = doc.createElement('style');
  // Theme defaults precede file styles; the file's own visual design remains authoritative.
  const safeColor = value => /^(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/i.test(value) ? value : '';
  defaults.textContent = `:root { color-scheme: ${colorScheme === 'dark' ? 'dark' : 'light'}; } body { background: ${safeColor(background)}; color: ${safeColor(color)}; }`;
  doc.head.prepend(csp, defaults);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

export function createFilePreview(activeFile, { editorContainer, createEditor, destroyEditor = () => {}, saveCurrentUndoHistory = () => {}, getTheme = () => '', t }) {
  const textPreviewMode = Vue.ref(true);
  const mdPreviewRef = Vue.ref(null);
  const officePreviewContainer = Vue.ref(null);

  const isActiveMarkdown = Vue.computed(() => {
    const f = activeFile.value;
    return !!(f && isMarkdownFile(f.name));
  });

  const isActiveHtml = Vue.computed(() => !!activeFile.value && isHtmlFile(activeFile.value.name));
  const isActiveTextPreview = Vue.computed(() => !!activeFile.value && isPreviewableTextFile(activeFile.value.name));
  const htmlPreviewDocument = Vue.computed(() => {
    const theme = getTheme();
    if (!isActiveHtml.value) return '';
    const styles = getComputedStyle(document.documentElement);
    return createHtmlPreviewDocument(activeFile.value.content || '', {
      background: styles.getPropertyValue('--bg-main').trim(),
      color: styles.getPropertyValue('--text-primary').trim(),
      colorScheme: theme === 'dark' ? 'dark' : 'light',
    });
  });

  // Reset after synchronous tab mutations settle. Closing an earlier background
  // tab temporarily changes its index, but must not exit the active file's Edit.
  Vue.watch(activeFile, () => { textPreviewMode.value = true; });

  const mdRenderedHtml = Vue.computed(() => {
    const f = activeFile.value;
    if (!f || !isMarkdownFile(f.name) || f.content == null) return '';
    try {
      if (typeof marked !== 'undefined') {
        return marked.parse(f.content);
      }
    } catch (e) {
      console.error('Markdown parse error:', e);
    }
    return '<pre>' + (f.content || '') + '</pre>';
  });

  function initMermaid() {
    renderMermaidIn(mdPreviewRef.value);
  }

  async function renderMermaidBlocks() {
    await renderMermaidIn(mdPreviewRef.value);
  }

  function switchToTextPreview() {
    if (textPreviewMode.value) return;
    saveCurrentUndoHistory();
    destroyEditor();
    textPreviewMode.value = true;
  }

  function switchToTextEdit() {
    if (!textPreviewMode.value) return;
    textPreviewMode.value = false;
    Vue.nextTick(() => {
      const file = activeFile.value;
      if (file && editorContainer.value) createEditor(file);
    });
  }

  let officeRenderGeneration = 0;
  const fileRenderGenerations = new WeakMap();

  const isSameFile = (left, right) => left === right || (
    typeof Vue.toRaw === 'function' && Vue.toRaw(left) === Vue.toRaw(right)
  );

  const renderOfficeLocal = async (file) => {
    const liveContainer = officePreviewContainer.value;
    if (!liveContainer || !file._arrayBuffer) return false;

    const generation = ++officeRenderGeneration;
    fileRenderGenerations.set(file, generation);
    file.previewLoading = true;
    const ownerDocument = liveContainer.ownerDocument || globalThis.document;
    const attemptContainer = ownerDocument?.createElement
      ? ownerDocument.createElement('div')
      : { innerHTML: '' };
    const ext = ('.' + file.name.split('.').pop()).toLowerCase();
    let workbook = null;
    const isLatestFileRender = () => fileRenderGenerations.get(file) === generation;
    const canCommit = () => generation === officeRenderGeneration
      && isLatestFileRender()
      && isSameFile(activeFile.value, file)
      && officePreviewContainer.value === liveContainer;

    try {
      if (ext === '.docx' && window.docx) {
        await window.docx.renderAsync(file._arrayBuffer, attemptContainer, null, {
          className: 'docx-preview-content',
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: true
        });
      } else if (ext === '.xlsx' || ext === '.xls') {
        workbook = XLSX.read(file._arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const html = XLSX.utils.sheet_to_html(workbook.Sheets[sheetName], { editable: false });
        attemptContainer.innerHTML = '<div class="xlsx-sheet-tabs">' +
          workbook.SheetNames.map((n, i) => `<button class="xlsx-sheet-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${n}</button>`).join('') +
          '</div><div class="xlsx-table-wrap">' + html + '</div>';
      } else if (ext === '.pptx' || ext === '.ppt') {
        attemptContainer.innerHTML = '<div class="preview-unsupported">' + (t ? t('files.pptxNotSupported') : 'PowerPoint preview not supported') + '</div>';
      }

      if (!canCommit()) return false;
      if (typeof liveContainer.replaceChildren === 'function' && attemptContainer.childNodes) {
        liveContainer.replaceChildren(...attemptContainer.childNodes);
      } else {
        liveContainer.innerHTML = attemptContainer.innerHTML;
      }
      if (workbook) {
        liveContainer.querySelectorAll('.xlsx-sheet-tab').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const sheetName = workbook.SheetNames[idx];
            const html = XLSX.utils.sheet_to_html(workbook.Sheets[sheetName], { editable: false });
            liveContainer.querySelector('.xlsx-table-wrap').innerHTML = html;
            liveContainer.querySelectorAll('.xlsx-sheet-tab').forEach(tab => tab.classList.remove('active'));
            btn.classList.add('active');
          });
        });
      }
      return true;
    } catch (e) {
      if (isLatestFileRender()) file.previewError = e.message;
      return false;
    } finally {
      if (isLatestFileRender()) file.previewLoading = false;
    }
  };

  return {
    textPreviewMode, mdPreviewRef, officePreviewContainer,
    isActiveMarkdown, isActiveHtml, isActiveTextPreview, mdRenderedHtml, htmlPreviewDocument,
    initMermaid, renderMermaidBlocks, switchToTextEdit, switchToTextPreview, renderOfficeLocal
  };
}
