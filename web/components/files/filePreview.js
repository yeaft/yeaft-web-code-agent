/**
 * filePreview — File preview composable for FilesTab.
 * Manages Markdown preview/rendering, Mermaid diagrams, Office/PDF/Image preview.
 */
import { renderMermaidIn } from '../../utils/markdown.js';
import { isMarkdownFile } from './fileEditor.js';

export function createFilePreview(activeFile, { editorContainer, createEditor, t }) {
  const mdPreviewMode = Vue.ref(true);
  const mdPreviewRef = Vue.ref(null);
  const officePreviewContainer = Vue.ref(null);

  const isActiveMarkdown = Vue.computed(() => {
    const f = activeFile.value;
    return !!(f && isMarkdownFile(f.name));
  });

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

  function switchToMdEdit() {
    mdPreviewMode.value = false;
    Vue.nextTick(() => {
      const file = activeFile.value;
      if (file && editorContainer.value) createEditor(file);
    });
  }

  const renderOfficeLocal = (file) => {
    const container = officePreviewContainer.value;
    if (!container || !file._arrayBuffer) return;
    container.innerHTML = '';
    const ext = ('.' + file.name.split('.').pop()).toLowerCase();

    if (ext === '.docx' && window.docx) {
      window.docx.renderAsync(file._arrayBuffer, container, null, {
        className: 'docx-preview-content',
        inWrapper: true,
        ignoreWidth: false,
        ignoreHeight: true
      }).catch(e => { file.previewError = e.message; });
    } else if (ext === '.xlsx' || ext === '.xls') {
      try {
        const wb = XLSX.read(file._arrayBuffer, { type: 'array' });
        const sheetName = wb.SheetNames[0];
        const html = XLSX.utils.sheet_to_html(wb.Sheets[sheetName], { editable: false });
        container.innerHTML = '<div class="xlsx-sheet-tabs">' +
          wb.SheetNames.map((n, i) => `<button class="xlsx-sheet-tab${i === 0 ? ' active' : ''}" data-idx="${i}">${n}</button>`).join('') +
          '</div><div class="xlsx-table-wrap">' + html + '</div>';
        container.querySelectorAll('.xlsx-sheet-tab').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            const sn = wb.SheetNames[idx];
            const h = XLSX.utils.sheet_to_html(wb.Sheets[sn], { editable: false });
            container.querySelector('.xlsx-table-wrap').innerHTML = h;
            container.querySelectorAll('.xlsx-sheet-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });
      } catch (e) { file.previewError = e.message; }
    } else if (ext === '.pptx' || ext === '.ppt') {
      container.innerHTML = '<div class="preview-unsupported">' + (t ? t('files.pptxNotSupported') : 'PowerPoint preview not supported') + '</div>';
    }
  };

  return {
    mdPreviewMode, mdPreviewRef, officePreviewContainer,
    isActiveMarkdown, mdRenderedHtml,
    initMermaid, renderMermaidBlocks, switchToMdEdit, renderOfficeLocal
  };
}
