// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createFilePreview, createHtmlPreviewDocument } from '../../web/components/files/filePreview.js';
import { createFileEditor, getFileType, getModeForFile, isHtmlFile, isPreviewableTextFile } from '../../web/components/files/fileEditor.js';

let restoreDomSettings;
beforeAll(() => {
  globalThis.Vue = Vue;
  // happy-dom loads resources from detached documents unlike real browsers.
  // Playwright verifies production parsing/rendering network isolation instead.
  const settings = window.happyDOM.settings;
  const previous = {
    disableCSSFileLoading: settings.disableCSSFileLoading,
    disableJavaScriptFileLoading: settings.disableJavaScriptFileLoading,
    handleDisabledFileLoadingAsSuccess: settings.handleDisabledFileLoadingAsSuccess,
  };
  const previousNavigation = settings.navigation.disableChildFrameNavigation;
  Object.assign(settings, { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true });
  settings.navigation.disableChildFrameNavigation = true;
  restoreDomSettings = () => {
    Object.assign(settings, previous);
    settings.navigation.disableChildFrameNavigation = previousNavigation;
  };
});
afterAll(() => { restoreDomSettings(); });
afterEach(() => { vi.useRealTimers(); });

describe('HTML file preview', () => {
  it('recognizes HTML case-insensitively without changing the text read/save contract or Markdown', () => {
    for (const name of ['index.html', 'design.HTM', 'INDEX.HTML']) {
      expect(isHtmlFile(name)).toBe(true);
      expect(isPreviewableTextFile(name)).toBe(true);
      expect(getFileType(name)).toBe('text');
      expect(getModeForFile(name)).toBe('htmlmixed');
    }
    for (const name of ['readme.md', 'readme.MARKDOWN', 'page.mdx']) expect(isPreviewableTextFile(name)).toBe(true);
    for (const name of ['html', 'script.js', 'page.xhtml', 'page.html.js']) expect(isHtmlFile(name)).toBe(false);
  });

  it('keeps inline design and data images but removes navigations and active embedded content', () => {
    const content = `<!doctype html><html lang="zh"><head><base href="https://outside.test/"><meta http-equiv="refresh" content="0;url=/api/delete">
      <link rel="stylesheet" href="/secret.css"><style>h1 { color: red; }</style></head><body style="background: pink"><h1>Preview</h1>
      <img src="data:image/png;base64,AAAA"><script>parent.pwned = true</script><iframe src="/api/private"></iframe>
      <object data="/secret"></object><embed src="/secret"><a href="/api/danger" ping="/api/ping">out</a>
      <a href="#section" target="_top" ping="/api/ping">anchor</a><form action="/api/post"><button>Submit</button></form></body></html>`;
    const result = createHtmlPreviewDocument(content, { background: '#fafaf8', color: '#2c2c2c' });
    const doc = new DOMParser().parseFromString(result, 'text/html');
    expect(doc.documentElement.lang).toBe('zh');
    expect(doc.body.style.background).toBe('pink');
    expect(doc.querySelector('h1').textContent).toBe('Preview');
    expect(doc.querySelector('img').getAttribute('src')).toContain('data:image/png');
    expect(doc.querySelector('script, base, iframe, object, embed, link')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelectorAll('a')[0].hasAttribute('href')).toBe(false);
    expect(doc.querySelectorAll('a')[1].hasAttribute('href')).toBe(false);
    expect(doc.querySelector('a[target], a[ping]')).toBeNull();
    expect(doc.head.firstElementChild.httpEquiv).toBe('Content-Security-Policy');
    expect(doc.head.firstElementChild.content).toContain("default-src 'none'");
    expect(doc.head.firstElementChild.content).toContain("form-action 'none'");
    expect(doc.querySelectorAll('style')[0].textContent).toContain('#fafaf8');
    expect(doc.querySelectorAll('style')[1].textContent).toContain('h1 { color: red; }');
    expect(content).toContain('<script>'); // editing source was never mutated
  });

  it('preserves root design attributes and prevents SVG links and SMIL from changing navigation targets', () => {
    const result = createHtmlPreviewDocument(`<html lang="ar" dir="rtl" class="design" style="font-size: 20px"><body>
      <svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="/private" target="_top"><rect/></a>
      <a href="#safe"><set attributeName="href" to="/private"/><animate attributeName="href" to="/private"/><rect/></a></svg>
      </body></html>`);
    const doc = new DOMParser().parseFromString(result, 'text/html');
    expect(doc.documentElement.lang).toBe('ar');
    expect(doc.documentElement.dir).toBe('rtl');
    expect(doc.documentElement.className).toBe('design');
    expect(doc.documentElement.style.fontSize).toBe('20px');
    expect(doc.querySelector('a').hasAttribute('xlink:href')).toBe(false);
    expect(doc.querySelector('a').hasAttribute('target')).toBe(false);
    expect(doc.querySelectorAll('a')[1].hasAttribute('href')).toBe(false);
    expect(doc.querySelector('set, animate')).toBeNull();
  });

  it('excludes template contents that could activate as declarative Shadow DOM and MathML navigation', () => {
    const result = createHtmlPreviewDocument(`<div><template shadowrootmode="open"><a href="/private">link</a>
      <div><template shadowrootmode="closed"><svg><a href="/private"><set attributeName="href" to="/private"/></a></svg></template></div>
      </template></div><div><template shadowrootmode="closed"><a href="/private">closed</a></template></div>
      <math href="/private"><mtext href="/private">math link</mtext></math>`);
    const doc = new DOMParser().parseFromString(result, 'text/html');
    expect(doc.querySelector('template')).toBeNull();
    expect(result).not.toContain('/private');
    expect(doc.querySelector('math, mtext').hasAttribute('href')).toBe(false);
  });

  it('normalizes fragments, empty/malformed documents, and rejects CSS injection in defaults', () => {
    for (const content of ['', '<h1>Fragment', '<html><body><p>Unclosed']) {
      const result = createHtmlPreviewDocument(content, { background: 'red; } body { display:none', colorScheme: 'dark' });
      expect(result).toMatch(/^<!doctype html>/);
      expect(result).toContain('Content-Security-Policy');
      expect(result).toContain('color-scheme: dark');
      expect(result).not.toContain('display:none');
    }
  });

  it('previews unsaved edits, saves undo state, resets newly active files and follows theme defaults', async () => {
    const scope = Vue.effectScope();
    const activeFile = Vue.ref({ name: 'page.html', content: '<h1>Initial</h1>', isDirty: false });
    const theme = Vue.ref('light');
    const createEditor = vi.fn();
    const destroyEditor = vi.fn();
    const saveCurrentUndoHistory = vi.fn();
    const preview = scope.run(() => createFilePreview(activeFile, {
      editorContainer: Vue.ref(document.createElement('div')), createEditor, destroyEditor,
      saveCurrentUndoHistory, getTheme: () => theme.value,
    }));
    expect(preview.textPreviewMode.value).toBe(true);
    expect(preview.isActiveHtml.value).toBe(true);
    preview.switchToTextEdit();
    await Vue.nextTick();
    expect(createEditor).toHaveBeenCalledWith(activeFile.value);
    activeFile.value.content = '<h1>Unsaved</h1>';
    activeFile.value.isDirty = true;
    preview.switchToTextPreview();
    expect(saveCurrentUndoHistory).toHaveBeenCalledOnce();
    expect(destroyEditor).toHaveBeenCalledOnce();
    expect(preview.htmlPreviewDocument.value).toContain('Unsaved');
    expect(activeFile.value.isDirty).toBe(true);
    theme.value = 'dark';
    expect(preview.htmlPreviewDocument.value).toContain('color-scheme: dark');
    preview.switchToTextEdit();
    await Vue.nextTick();
    // A tab splice may transiently select null before restoring the same file.
    const sameFile = activeFile.value;
    activeFile.value = null;
    activeFile.value = sameFile;
    await Vue.nextTick();
    expect(preview.textPreviewMode.value).toBe(false);
    activeFile.value = { name: 'next.HTM', content: '<h1>Next</h1>' };
    await Vue.nextTick();
    expect(preview.textPreviewMode.value).toBe(true);
    activeFile.value = { name: 'readme.md', content: '# Markdown' };
    await Vue.nextTick();
    expect(preview.isActiveMarkdown.value).toBe(true);
    expect(preview.isActiveHtml.value).toBe(false);
    expect(preview.textPreviewMode.value).toBe(true);
    scope.stop();
  });

  it('ignores delayed editor work after a tab or preview-mode switch', () => {
    vi.useFakeTimers();
    const file = { name: 'page.html', content: 'original' };
    const activeFile = Vue.ref(file);
    const editorContainer = Vue.ref(null);
    let editable = true;
    const editor = createFileEditor({}, {
      activeFile, editorContainer, fontSize: Vue.ref(12), clearFindMarkers: vi.fn(),
      openFindBar: vi.fn(), saveFile: vi.fn(), canCreateEditor: () => editable,
    });
    editor.createEditor(activeFile.value);
    editable = false;
    editorContainer.value = document.createElement('div');
    vi.advanceTimersByTime(100);
    expect(editorContainer.value.children).toHaveLength(0);
    editable = true;
    activeFile.value = { name: 'other.txt', content: 'other' };
    editor.createEditor(file);
    expect(editorContainer.value.children).toHaveLength(0);
    editor.createEditor(activeFile.value);
    expect(editorContainer.value.querySelector('textarea').value).toBe('other');
  });
});
