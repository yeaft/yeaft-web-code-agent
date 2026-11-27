import { sanitizeCreationHtml } from '../cosmos/creations/sanitize.js';
import { openImagePreview } from '../../utils/imagePreview.js';
import { addCanvasContextRef, formatTimestampLabel } from '../../utils/canvas-context.js';
import SvgPreview from '../files/SvgPreview.js';

const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg', '.ogv']);
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

function getExtension(fileOrName) {
  const raw = typeof fileOrName === 'string'
    ? fileOrName
    : (fileOrName?.name || fileOrName?.path || '');
  const trimmed = String(raw || '').trim();
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * Determine whether a file is supported by FileCanvasView.
 *
 * @param {string|{name?:string,path?:string}} fileOrName
 * @returns {'doc'|'image'|'video'|null}
 */
export function isCanvasSupportedFile(fileOrName) {
  const ext = getExtension(fileOrName);
  if (!ext) return null;
  if (DOC_EXTS.has(ext)) return 'doc';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  })[ch]);
}

function countWords(text) {
  const src = String(text || '').trim();
  if (!src) return 0;
  const cjkMatches = src.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = src
    .replace(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .trim();
  const latinCount = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
  return cjkCount + latinCount;
}

function extractHeadings(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const headings = [];
  let inFence = false;
  let fenceChar = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const ch = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = '';
      }
      continue;
    }
    if (inFence) continue;
    const match = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (match) {
      const text = match[2]
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_~]+/g, '')
        .trim();
      if (text) {
        headings.push({
          index: headings.length,
          level: match[1].length,
          text,
          line: i + 1,
        });
      }
    }
  }
  return headings;
}

function findLineRangeForSnippet(content, snippet) {
  const src = String(content || '');
  const needle = String(snippet || '').trim();
  if (!src || !needle) return { lineStart: undefined, lineEnd: undefined };

  const lines = src.split(/\r?\n/);
  // Direct substring search first
  const directIdx = src.indexOf(needle);
  if (directIdx >= 0) {
    const lineStart = src.slice(0, directIdx).split(/\r?\n/).length;
    const lineSpan = needle.split(/\r?\n/).length;
    return { lineStart, lineEnd: lineStart + lineSpan - 1 };
  }

  // Fallback: match first & last non-empty lines of selection (handles rendered markdown stripping syntax)
  const snippetLines = needle.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (snippetLines.length === 0) return { lineStart: undefined, lineEnd: undefined };

  const firstProbe = snippetLines[0].slice(0, 60);
  const lastProbe = snippetLines[snippetLines.length - 1].slice(0, 60);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(firstProbe)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return { lineStart: undefined, lineEnd: undefined };

  let endIdx = startIdx;
  if (snippetLines.length > 1) {
    for (let i = startIdx; i < lines.length; i += 1) {
      if (lines[i].includes(lastProbe)) {
        endIdx = i;
        break;
      }
    }
  }
  return { lineStart: startIdx + 1, lineEnd: endIdx + 1 };
}

function lineRangeFromOffsets(content, startOffset, endOffset) {
  const src = String(content || '');
  if (startOffset < 0 || endOffset <= startOffset) {
    return { lineStart: undefined, lineEnd: undefined };
  }
  const lineStart = src.slice(0, startOffset).split(/\r?\n/).length;
  const lineEnd = src.slice(0, endOffset).split(/\r?\n/).length;
  return { lineStart, lineEnd };
}

export default {
  name: 'FileCanvasView',
  components: { SvgPreview },
  props: {
    file: { type: Object, required: true },
    routeKey: { type: String, default: '' },
    saving: { type: Boolean, default: false },
    showHeader: { type: Boolean, default: true },
    showOpenInFiles: { type: Boolean, default: false },
    showPromoteFolder: { type: Boolean, default: false },
  },
  emits: ['update:content', 'save', 'download', 'open-in-files', 'promote-folder', 'referenced'],
  template: `
    <div class="file-canvas-view" :class="'canvas-kind-' + (canvasKind || 'unknown')">
      <!-- Loading / Error states -->
      <div v-if="file.loading" class="canvas-state" role="status" aria-live="polite">
        <span class="spinner-mini" aria-hidden="true"></span>
        <span>{{ $t('files.loadingFile') }}</span>
      </div>
      <div v-else-if="file.loadError" class="canvas-state canvas-state-error" role="alert">
        <span>{{ file.loadError }}</span>
      </div>

      <!-- ===================== DOCUMENT CANVAS ===================== -->
      <template v-else-if="canvasKind === 'doc'">
        <div v-if="showHeader" class="canvas-toolbar" role="toolbar">
          <div class="canvas-toolbar-group">
            <div class="canvas-segmented" role="group">
              <button
                type="button"
                class="canvas-seg-btn"
                :class="{ active: docMode === 'read' }"
                :aria-pressed="docMode === 'read'"
                @click="setDocMode('read')"
              >{{ $t('creation.canvas.read') }}</button>
              <button
                type="button"
                class="canvas-seg-btn"
                :class="{ active: docMode === 'edit' }"
                :aria-pressed="docMode === 'edit'"
                @click="setDocMode('edit')"
              >{{ $t('creation.canvas.edit') }}</button>
            </div>

            <button
              v-if="isMarkdown"
              type="button"
              class="canvas-tool-btn"
              :class="{ active: tocOpen }"
              :aria-pressed="tocOpen"
              :disabled="headings.length === 0"
              @click="tocOpen = !tocOpen"
              :title="$t('creation.canvas.toc')"
            >
              <span>{{ $t('creation.canvas.toc') }}</span>
              <span class="canvas-badge">{{ headings.length }}</span>
            </button>

            <div class="canvas-font-controls" role="group">
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-compact"
                :disabled="docFontSize <= 14"
                @click="adjustFontSize(-1)"
                :title="$t('git.zoomOut')"
              >A−</button>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-compact"
                :disabled="docFontSize >= 22"
                @click="adjustFontSize(1)"
                :title="$t('git.zoomIn')"
              >A+</button>
            </div>

            <span class="canvas-word-count">{{ $t('creation.canvas.wordCount', { count: wordCount }) }}</span>
          </div>

          <div class="canvas-toolbar-group canvas-toolbar-right">
            <button
              type="button"
              class="canvas-tool-btn canvas-ref-btn"
              @mousedown.prevent
              @click="referenceDocument"
            >
              <span aria-hidden="true">✦</span>
              <span>{{ hasActiveDocSelection ? $t('creation.canvas.quoteToSession') : $t('creation.canvas.referenceFile') }}</span>
            </button>

            <button
              v-if="file.isDirty"
              type="button"
              class="canvas-tool-btn canvas-save-btn"
              :disabled="saving"
              @click="$emit('save')"
              :title="$t('common.save') + ' (Ctrl+S)'"
            >{{ $t('common.save') }}</button>

            <button
              v-if="showOpenInFiles"
              type="button"
              class="canvas-tool-btn canvas-tool-icon"
              @click="$emit('open-in-files')"
              :title="$t('creation.canvas.openInFiles')"
              :aria-label="$t('creation.canvas.openInFiles')"
            >📂</button>

            <button
              v-if="showPromoteFolder"
              type="button"
              class="canvas-tool-btn canvas-tool-icon"
              @click="$emit('promote-folder')"
              :title="$t('creation.canvas.promoteFolder')"
              :aria-label="$t('creation.canvas.promoteFolder')"
            >✦</button>
          </div>
        </div>

        <div class="canvas-doc-layout">
          <aside v-if="isMarkdown && tocOpen && headings.length > 0" class="canvas-toc-rail" :aria-label="$t('creation.canvas.toc')">
            <div class="canvas-toc-title">{{ $t('creation.canvas.toc') }}</div>
            <nav class="canvas-toc-list">
              <button
                v-for="h in headings"
                :key="h.index"
                type="button"
                class="canvas-toc-item"
                :class="'canvas-toc-level-' + h.level"
                :title="h.text"
                @click="jumpToHeading(h)"
              >{{ h.text }}</button>
            </nav>
          </aside>

          <div class="canvas-doc-scroll" ref="docScrollRef" @scroll="hideSelectionBar">
            <!-- Floating selection quote bar -->
            <div
              v-if="docMode === 'read' && selectionBar.visible"
              class="canvas-selection-bar"
              :style="{ top: selectionBar.top + 'px', left: selectionBar.left + 'px' }"
            >
              <button
                type="button"
                class="canvas-selection-btn"
                @mousedown.prevent
                @click="quoteReaderSelection"
              >✦ {{ $t('creation.canvas.quoteToSession') }}</button>
            </div>

            <!-- Read mode -->
            <article
              v-if="docMode === 'read'"
              class="canvas-doc-page"
              :style="{ fontSize: docFontSize + 'px' }"
              @mouseup="onReaderSelectionChange"
              @keyup="onReaderSelectionChange"
            >
              <div
                ref="readerContentRef"
                class="canvas-doc-content"
                :class="{ 'markdown-body': isMarkdown, 'canvas-txt-content': !isMarkdown }"
                v-html="sanitizedDocHtml"
              ></div>
            </article>

            <!-- Edit mode -->
            <div v-else class="canvas-doc-editor-wrap">
              <textarea
                ref="editorRef"
                class="canvas-doc-editor"
                :style="{ fontSize: docFontSize + 'px' }"
                :value="file.content || ''"
                :placeholder="$t('creation.canvas.docPlaceholder')"
                spellcheck="false"
                @input="onEditorInput"
                @keydown="onEditorKeydown"
                @select="onEditorSelectionChange"
                @mouseup="onEditorSelectionChange"
                @keyup="onEditorSelectionChange"
              ></textarea>
            </div>
          </div>
        </div>
      </template>

      <!-- ===================== IMAGE CANVAS ===================== -->
      <template v-else-if="canvasKind === 'image'">
        <div v-if="showHeader" class="canvas-toolbar" role="toolbar">
          <div class="canvas-toolbar-group">
            <button
              type="button"
              class="canvas-tool-btn canvas-tool-compact"
              :disabled="imageZoom <= 0.25"
              @click="zoomImage(-0.25)"
              :title="$t('message.zoomOut')"
            >−</button>
            <button
              type="button"
              class="canvas-tool-btn"
              :class="{ active: imageZoomMode === 'fit' }"
              @click="setImageFit"
            >{{ $t('creation.canvas.fit') }}</button>
            <button
              type="button"
              class="canvas-tool-btn"
              :class="{ active: imageZoomMode === 'custom' && imageZoom === 1 }"
              @click="setImageActualSize"
            >{{ $t('creation.canvas.actualSize') }}</button>
            <button
              type="button"
              class="canvas-tool-btn canvas-tool-compact"
              :disabled="imageZoom >= 4"
              @click="zoomImage(0.25)"
              :title="$t('message.zoomIn')"
            >+</button>
            <span class="canvas-zoom-readout">{{ imageZoomMode === 'fit' ? $t('creation.canvas.fit') : Math.round(imageZoom * 100) + '%' }}</span>
          </div>

          <div class="canvas-toolbar-group canvas-toolbar-right">
            <button
              v-if="!isSvgText && file.blobUrl"
              type="button"
              class="canvas-tool-btn"
              @click="openLightbox($event.currentTarget)"
            >{{ $t('creation.canvas.openLightbox') }}</button>

            <button
              type="button"
              class="canvas-tool-btn"
              @click="$emit('download')"
            >{{ $t('files.download') }}</button>

            <button
              type="button"
              class="canvas-tool-btn canvas-ref-btn"
              @click="referenceImage"
            >
              <span aria-hidden="true">✦</span>
              <span>{{ $t('creation.canvas.referenceFile') }}</span>
            </button>

            <button
              v-if="showOpenInFiles"
              type="button"
              class="canvas-tool-btn canvas-tool-icon"
              @click="$emit('open-in-files')"
              :title="$t('creation.canvas.openInFiles')"
              :aria-label="$t('creation.canvas.openInFiles')"
            >📂</button>

            <button
              v-if="showPromoteFolder"
              type="button"
              class="canvas-tool-btn canvas-tool-icon"
              @click="$emit('promote-folder')"
              :title="$t('creation.canvas.promoteFolder')"
              :aria-label="$t('creation.canvas.promoteFolder')"
            >✦</button>
          </div>
        </div>

        <div class="canvas-image-stage">
          <div v-if="file.previewError" class="canvas-state canvas-state-error" role="alert">
            <span>{{ file.previewError }}</span>
          </div>
          <div v-else-if="isSvgText" class="canvas-image-svg-wrap" :style="svgZoomStyle">
            <SvgPreview :key="file.path" :content="file.content || ''" :name="file.name" />
          </div>
          <div v-else-if="file.previewLoading || !file.blobUrl" class="canvas-state" role="status">
            <span class="spinner-mini" aria-hidden="true"></span>
            <span>{{ $t('files.loadingPreview') }}</span>
          </div>
          <div v-else class="canvas-image-viewport" :class="{ 'is-fit': imageZoomMode === 'fit' }">
            <img
              :src="file.blobUrl"
              :alt="file.name"
              class="canvas-image-el"
              :class="{ 'is-fit': imageZoomMode === 'fit' }"
              :style="imageZoomStyle"
              @click="openLightbox($event.currentTarget)"
            />
          </div>
        </div>
      </template>

      <!-- ===================== VIDEO CANVAS ===================== -->
      <template v-else-if="canvasKind === 'video'">
        <div v-if="showHeader" class="canvas-toolbar" role="toolbar">
          <div class="canvas-toolbar-group">
            <label class="canvas-rate-wrap">
              <select
                class="canvas-rate-select"
                :value="playbackRate"
                @change="setPlaybackRate(Number($event.target.value))"
                :aria-label="$t('creation.canvas.speed')"
              >
                <option v-for="rate in PLAYBACK_RATES" :key="rate" :value="rate">{{ rate }}x</option>
              </select>
            </label>

            <span class="canvas-timecode">{{ currentTimeLabel }} / {{ durationLabel }}</span>

            <button
              type="button"
              class="canvas-tool-btn"
              @click="addVideoMarker"
            >+ {{ $t('creation.canvas.addBookmark') }}</button>
          </div>

          <div class="canvas-toolbar-group canvas-toolbar-right">
            <button
              type="button"
              class="canvas-tool-btn canvas-ref-btn"
              @click="referenceVideoAtCurrentTime"
            >
              <span aria-hidden="true">✦</span>
              <span>{{ $t('creation.canvas.referenceAtTime') }} @ {{ currentTimeLabel }}</span>
            </button>

            <button
              type="button"
              class="canvas-tool-btn"
              @click="$emit('download')"
            >{{ $t('files.download') }}</button>

            <button
              v-if="showOpenInFiles"
              type="button"
              class="canvas-tool-btn canvas-tool-icon"
              @click="$emit('open-in-files')"
              :title="$t('creation.canvas.openInFiles')"
              :aria-label="$t('creation.canvas.openInFiles')"
            >📂</button>

            <button
              v-if="showPromoteFolder"
              type="button"
              class="canvas-tool-btn canvas-tool-icon"
              @click="$emit('promote-folder')"
              :title="$t('creation.canvas.promoteFolder')"
              :aria-label="$t('creation.canvas.promoteFolder')"
            >✦</button>
          </div>
        </div>

        <div class="canvas-video-stage">
          <div v-if="file.previewError" class="canvas-state canvas-state-error" role="alert">
            <span>{{ file.previewError }}</span>
          </div>
          <div v-else-if="file.previewLoading || !file.blobUrl" class="canvas-state" role="status">
            <span class="spinner-mini" aria-hidden="true"></span>
            <span>{{ $t('files.loadingPreview') }}</span>
          </div>
          <template v-else>
            <div class="canvas-video-player-wrap">
              <video
                ref="videoRef"
                :key="file.blobUrl"
                :src="file.blobUrl"
                :aria-label="file.name"
                class="canvas-video-el"
                controls
                preload="metadata"
                playsinline
                @timeupdate="onVideoTimeUpdate"
                @loadedmetadata="onVideoLoadedMetadata"
                @ratechange="onVideoRateChange"
              ></video>
            </div>

            <div v-if="videoMarkers.length > 0" class="canvas-video-markers">
              <div
                v-for="marker in videoMarkers"
                :key="marker.id"
                class="canvas-video-marker"
              >
                <button
                  type="button"
                  class="canvas-marker-jump"
                  @click="seekToMarker(marker)"
                >
                  <span class="canvas-marker-time">{{ marker.label }}</span>
                </button>
                <button
                  type="button"
                  class="canvas-marker-action"
                  @click="referenceVideoMarker(marker)"
                  :title="$t('creation.canvas.referenceAtTime') + ' @ ' + marker.label"
                  :aria-label="$t('creation.canvas.referenceAtTime') + ' @ ' + marker.label"
                >✦</button>
                <button
                  type="button"
                  class="canvas-marker-action canvas-marker-remove"
                  @click="removeVideoMarker(marker.id)"
                  :title="$t('common.delete')"
                  :aria-label="$t('common.delete')"
                >×</button>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  `,
  setup(props, { emit }) {
    const t = Vue.inject('t', key => key);

    const canvasKind = Vue.computed(() => isCanvasSupportedFile(props.file));
    const isMarkdown = Vue.computed(() => MARKDOWN_EXTS.has(getExtension(props.file)));
    const isSvgText = Vue.computed(() => (
      getExtension(props.file) === '.svg'
      && (!props.file?.fileType || props.file.fileType === 'text')
    ));

    // --- Document state ---
    const docMode = Vue.ref('read');
    const tocOpen = Vue.ref(false);
    const docFontSize = Vue.ref(16);
    const docScrollRef = Vue.ref(null);
    const readerContentRef = Vue.ref(null);
    const editorRef = Vue.ref(null);
    const selectionBar = Vue.reactive({ visible: false, top: 0, left: 0, text: '' });
    const editorSelection = Vue.reactive({ text: '', lineStart: undefined, lineEnd: undefined });

    const wordCount = Vue.computed(() => countWords(props.file?.content || ''));
    const headings = Vue.computed(() => (
      isMarkdown.value ? extractHeadings(props.file?.content || '') : []
    ));

    const sanitizedDocHtml = Vue.computed(() => {
      const content = props.file?.content || '';
      if (!content) return '';
      if (isMarkdown.value) {
        let rawHtml = '';
        try {
          if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
            rawHtml = marked.parse(content);
          } else {
            rawHtml = `<pre>${escapeHtml(content)}</pre>`;
          }
        } catch {
          rawHtml = `<pre>${escapeHtml(content)}</pre>`;
        }
        return sanitizeCreationHtml(rawHtml);
      }
      // Plain text (.txt): preserve paragraphs and line breaks safely
      const paragraphs = content
        .split(/\r?\n\r?\n/)
        .map(block => `<p>${escapeHtml(block).replace(/\r?\n/g, '<br>')}</p>`)
        .join('');
      return sanitizeCreationHtml(paragraphs);
    });

    const assignHeadingAnchors = () => {
      const el = readerContentRef.value;
      if (!el) return;
      const nodes = el.querySelectorAll('h1, h2, h3, h4');
      nodes.forEach((node, index) => {
        node.id = `canvas-h-${index}`;
      });
    };

    Vue.watch([sanitizedDocHtml, docMode], () => {
      if (docMode.value === 'read') {
        Vue.nextTick(assignHeadingAnchors);
      }
    }, { immediate: true });

    const hideSelectionBar = () => {
      selectionBar.visible = false;
      selectionBar.text = '';
    };

    const setDocMode = (mode) => {
      docMode.value = mode;
      hideSelectionBar();
      editorSelection.text = '';
      editorSelection.lineStart = undefined;
      editorSelection.lineEnd = undefined;
      if (mode === 'edit') {
        Vue.nextTick(() => editorRef.value?.focus());
      }
    };

    const adjustFontSize = (delta) => {
      docFontSize.value = Math.max(14, Math.min(22, docFontSize.value + delta));
    };

    const jumpToHeading = (heading) => {
      if (docMode.value === 'read') {
        const container = readerContentRef.value;
        if (!container) return;
        const target = container.querySelector(`#canvas-h-${heading.index}`)
          || container.querySelectorAll('h1, h2, h3, h4')[heading.index];
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const textarea = editorRef.value;
      if (!textarea) return;
      const lines = String(props.file?.content || '').split(/\r?\n/);
      let offset = 0;
      const targetLineIdx = Math.max(0, Math.min(lines.length - 1, heading.line - 1));
      for (let i = 0; i < targetLineIdx; i += 1) {
        offset += lines[i].length + 1;
      }
      textarea.focus();
      textarea.setSelectionRange(offset, offset + (lines[targetLineIdx]?.length || 0));
      const approxLineHeight = docFontSize.value * 1.75;
      if (docScrollRef.value) {
        docScrollRef.value.scrollTop = Math.max(0, targetLineIdx * approxLineHeight - 48);
      }
    };

    const onReaderSelectionChange = () => {
      if (docMode.value !== 'read') return;
      const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
      const container = readerContentRef.value;
      const scrollEl = docScrollRef.value;
      if (!sel || sel.isCollapsed || !container || !scrollEl) {
        hideSelectionBar();
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        hideSelectionBar();
        return;
      }
      const anchorIn = container.contains(sel.anchorNode);
      const focusIn = container.contains(sel.focusNode);
      if (!anchorIn || !focusIn) {
        hideSelectionBar();
        return;
      }
      try {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const scrollRect = scrollEl.getBoundingClientRect();
        const top = Math.max(8, rect.top - scrollRect.top + scrollEl.scrollTop - 40);
        const centerX = rect.left - scrollRect.left + rect.width / 2;
        const left = Math.max(16, Math.min(scrollRect.width - 180, centerX - 72));
        selectionBar.top = top;
        selectionBar.left = left;
        selectionBar.text = text;
        selectionBar.visible = true;
      } catch {
        hideSelectionBar();
      }
    };

    const quoteReaderSelection = () => {
      const snippet = selectionBar.text.trim();
      if (!snippet) return;
      const { lineStart, lineEnd } = findLineRangeForSnippet(props.file?.content || '', snippet);
      const ref = addCanvasContextRef(props.routeKey, {
        kind: 'doc',
        filePath: props.file?.path || '',
        fileName: props.file?.name || '',
        snippet,
        lineStart,
        lineEnd,
      });
      if (typeof window !== 'undefined') {
        window.getSelection?.()?.removeAllRanges?.();
      }
      hideSelectionBar();
      emit('referenced', ref);
    };

    const onEditorInput = (event) => {
      emit('update:content', event.target.value);
    };

    const onEditorKeydown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        emit('save');
      }
    };

    const onEditorSelectionChange = () => {
      const textarea = editorRef.value;
      if (!textarea) return;
      const start = textarea.selectionStart ?? 0;
      const end = textarea.selectionEnd ?? 0;
      if (end <= start) {
        editorSelection.text = '';
        editorSelection.lineStart = undefined;
        editorSelection.lineEnd = undefined;
        return;
      }
      const content = props.file?.content || '';
      const text = content.slice(start, end).trim();
      if (!text) {
        editorSelection.text = '';
        editorSelection.lineStart = undefined;
        editorSelection.lineEnd = undefined;
        return;
      }
      const { lineStart, lineEnd } = lineRangeFromOffsets(content, start, end);
      editorSelection.text = text;
      editorSelection.lineStart = lineStart;
      editorSelection.lineEnd = lineEnd;
    };

    const hasActiveDocSelection = Vue.computed(() => (
      (docMode.value === 'read' && selectionBar.visible && !!selectionBar.text)
      || (docMode.value === 'edit' && !!editorSelection.text)
    ));

    const referenceDocument = () => {
      if (docMode.value === 'read' && selectionBar.visible && selectionBar.text) {
        quoteReaderSelection();
        return;
      }
      if (docMode.value === 'edit' && editorSelection.text) {
        const ref = addCanvasContextRef(props.routeKey, {
          kind: 'doc',
          filePath: props.file?.path || '',
          fileName: props.file?.name || '',
          snippet: editorSelection.text,
          lineStart: editorSelection.lineStart,
          lineEnd: editorSelection.lineEnd,
        });
        emit('referenced', ref);
        return;
      }
      const ref = addCanvasContextRef(props.routeKey, {
        kind: 'doc',
        filePath: props.file?.path || '',
        fileName: props.file?.name || '',
      });
      emit('referenced', ref);
    };

    // --- Image state ---
    const imageZoomMode = Vue.ref('fit'); // 'fit' | 'custom'
    const imageZoom = Vue.ref(1);
    let lightboxController = null;

    const closeLightbox = () => {
      lightboxController?.abort();
      lightboxController = null;
    };

    const setImageFit = () => {
      imageZoomMode.value = 'fit';
      imageZoom.value = 1;
    };

    const setImageActualSize = () => {
      imageZoomMode.value = 'custom';
      imageZoom.value = 1;
    };

    const zoomImage = (delta) => {
      imageZoomMode.value = 'custom';
      imageZoom.value = Math.max(0.25, Math.min(4, Math.round((imageZoom.value + delta) * 100) / 100));
    };

    const imageZoomStyle = Vue.computed(() => (
      imageZoomMode.value === 'fit'
        ? {}
        : { transform: `scale(${imageZoom.value})`, transformOrigin: 'center top' }
    ));

    const svgZoomStyle = Vue.computed(() => (
      imageZoomMode.value === 'fit'
        ? {}
        : { transform: `scale(${imageZoom.value})`, transformOrigin: 'center top' }
    ));

    const openLightbox = (trigger) => {
      if (!props.file?.blobUrl) return;
      closeLightbox();
      lightboxController = new AbortController();
      openImagePreview(props.file.blobUrl, {
        signal: lightboxController.signal,
        alt: props.file.name || t('message.imagePreview'),
        closeLabel: t('common.close'),
        zoomOutLabel: t('message.zoomOut'),
        zoomInLabel: t('message.zoomIn'),
        resetZoomLabel: t('message.resetZoom'),
        trigger,
      });
    };

    const referenceImage = () => {
      const ref = addCanvasContextRef(props.routeKey, {
        kind: 'image',
        filePath: props.file?.path || '',
        fileName: props.file?.name || '',
      });
      emit('referenced', ref);
    };

    // --- Video state ---
    const videoRef = Vue.ref(null);
    const playbackRate = Vue.ref(1);
    const currentTime = Vue.ref(0);
    const duration = Vue.ref(0);
    const videoMarkers = Vue.ref([]);
    let markerSeq = 0;

    const currentTimeLabel = Vue.computed(() => formatTimestampLabel(currentTime.value));
    const durationLabel = Vue.computed(() => formatTimestampLabel(duration.value));

    const onVideoTimeUpdate = () => {
      if (!videoRef.value) return;
      currentTime.value = videoRef.value.currentTime || 0;
    };

    const onVideoLoadedMetadata = () => {
      if (!videoRef.value) return;
      duration.value = Number.isFinite(videoRef.value.duration) ? videoRef.value.duration : 0;
      videoRef.value.playbackRate = playbackRate.value;
    };

    const onVideoRateChange = () => {
      if (!videoRef.value) return;
      playbackRate.value = videoRef.value.playbackRate || 1;
    };

    const setPlaybackRate = (rate) => {
      playbackRate.value = rate;
      if (videoRef.value) {
        videoRef.value.playbackRate = rate;
      }
    };

    const addVideoMarker = () => {
      const sec = Math.max(0, Math.floor(currentTime.value || 0));
      if (videoMarkers.value.some(m => m.timeSec === sec)) return;
      videoMarkers.value = [
        ...videoMarkers.value,
        { id: `marker-${++markerSeq}`, timeSec: sec, label: formatTimestampLabel(sec) },
      ].sort((a, b) => a.timeSec - b.timeSec);
    };

    const seekToMarker = (marker) => {
      if (!videoRef.value) return;
      videoRef.value.currentTime = marker.timeSec;
      currentTime.value = marker.timeSec;
    };

    const removeVideoMarker = (id) => {
      videoMarkers.value = videoMarkers.value.filter(m => m.id !== id);
    };

    const referenceVideoAtCurrentTime = () => {
      const sec = Math.max(0, Math.floor(currentTime.value || 0));
      const label = formatTimestampLabel(sec);
      const ref = addCanvasContextRef(props.routeKey, {
        kind: 'video',
        filePath: props.file?.path || '',
        fileName: props.file?.name || '',
        timestampSec: sec,
        timestampLabel: label,
      });
      emit('referenced', ref);
    };

    const referenceVideoMarker = (marker) => {
      const ref = addCanvasContextRef(props.routeKey, {
        kind: 'video',
        filePath: props.file?.path || '',
        fileName: props.file?.name || '',
        timestampSec: marker.timeSec,
        timestampLabel: marker.label,
      });
      emit('referenced', ref);
    };

    // Reset per-file ephemeral UI state when switching files
    Vue.watch(() => props.file?.path, () => {
      hideSelectionBar();
      editorSelection.text = '';
      editorSelection.lineStart = undefined;
      editorSelection.lineEnd = undefined;
      setImageFit();
      closeLightbox();
      currentTime.value = 0;
      duration.value = 0;
      videoMarkers.value = [];
    });

    Vue.onBeforeUnmount(closeLightbox);
    Vue.onDeactivated?.(closeLightbox);

    return {
      PLAYBACK_RATES,
      canvasKind,
      isMarkdown,
      isSvgText,
      // Document
      docMode,
      tocOpen,
      docFontSize,
      docScrollRef,
      readerContentRef,
      editorRef,
      selectionBar,
      wordCount,
      headings,
      sanitizedDocHtml,
      hasActiveDocSelection,
      setDocMode,
      adjustFontSize,
      jumpToHeading,
      hideSelectionBar,
      onReaderSelectionChange,
      quoteReaderSelection,
      onEditorInput,
      onEditorKeydown,
      onEditorSelectionChange,
      referenceDocument,
      // Image
      imageZoomMode,
      imageZoom,
      imageZoomStyle,
      svgZoomStyle,
      setImageFit,
      setImageActualSize,
      zoomImage,
      openLightbox,
      referenceImage,
      // Video
      videoRef,
      playbackRate,
      currentTimeLabel,
      durationLabel,
      videoMarkers,
      onVideoTimeUpdate,
      onVideoLoadedMetadata,
      onVideoRateChange,
      setPlaybackRate,
      addVideoMarker,
      seekToMarker,
      removeVideoMarker,
      referenceVideoAtCurrentTime,
      referenceVideoMarker,
    };
  },
};
