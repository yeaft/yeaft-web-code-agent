import { canonicalizeCreationUrl, isSafeCreationUrl, isSafeSameOriginPreviewUrl, sanitizeCreationHtml } from '../cosmos/creations/sanitize.js';
import { openImagePreview } from '../../utils/imagePreview.js';
import { getLocale } from '../../utils/i18n.js';
import { addCanvasContextRef, getCanvasContextRefs, formatTimestampLabel } from '../../utils/canvas-context.js';
import { DOC_WORKFLOW_STATUSES } from '../../utils/creation-categories.js';
import { useCreationsStore } from '../../stores/creations.js';
import SvgPreview from '../files/SvgPreview.js';
import CanvasInlineEditPopover from './CanvasInlineEditPopover.js';
import CanvasReviewPanel from './CanvasReviewPanel.js';

const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg', '.ogv']);
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);
const FALLBACK_DOC_STATUSES = ['draft', 'review', 'final'];

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

export function isBinaryDocument(file) {
  return isCanvasSupportedFile(file) === 'doc'
    && (file.isBinary === true || file.fileType === 'binary' || typeof file.content !== 'string');
}

export function binaryDraftWarning() {
  return getLocale() === 'zh-CN'
    ? '磁盘上的文件已变为二进制文件，无法在此覆盖。你的文本草稿已保留。'
    : 'The file on disk is now binary and cannot be overwritten here. Your draft text is preserved.';
}

function basenameOf(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || raw;
}

/**
 * Resolve a workspace-relative Markdown href/src against `baseFilePath`'s directory.
 * Returns `null` for external/scheme URLs (`http:`, `https:`, `mailto:`, `tel:`,
 * `data:`, `blob:`, `javascript:`, `//`, `#` fragments, absolute `/...`, or empty).
 *
 * @param {string} baseFilePath
 * @param {string} rawHref
 * @returns {string|null}
 */
export function resolveWorkspaceRelativePath(baseFilePath, rawHref) {
  const ref = canonicalizeCreationUrl(rawHref);
  const cleanRef = ref.split(/[?#]/)[0];
  const isRelative = value => value && !value.startsWith('/')
    && !/^[a-z][a-z0-9+.-]*:/i.test(value.replace(/\s+/g, ''));
  if (!isRelative(cleanRef)) return null;

  let decodedRef;
  try {
    // Decode the original path, not the slash-normalized validation form.
    decodedRef = decodeURIComponent(rawHref.trim().split(/[?#]/)[0]);
  } catch {
    return null;
  }
  const canonicalRef = canonicalizeCreationUrl(decodedRef);
  if (!isRelative(canonicalRef)) return null;

  const baseStr = typeof baseFilePath === 'string' ? baseFilePath.trim() : '';
  const drive = /^[A-Za-z]:[\\/]/.test(baseStr);
  const unc = /^(\\\\|\/\/)[^\\/]/.test(baseStr);
  const relativePath = drive || unc ? canonicalRef : decodedRef.trim();
  const baseParts = (drive || unc ? baseStr.replace(/\\/g, '/') : baseStr).split('/').filter(Boolean);
  let root = baseStr.startsWith('/') ? '/' : '';
  if (unc) {
    const [host, share] = baseParts.splice(0, 2);
    if (!host || !share || [host, share].some(part => part === '.' || part === '..')) return null;
    root = `//${host}/${share}/`;
  } else if (drive) {
    root = `${baseParts.shift()}/`;
  }
  baseParts.pop(); // Resolve from the directory containing the Markdown file.

  const resolvedParts = [];
  for (const seg of [...baseParts, ...relativePath.split('/')]) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (resolvedParts.length > 0) {
        resolvedParts.pop();
      } else if (!root) {
        return null;
      }
    } else {
      resolvedParts.push(seg);
    }
  }

  return resolvedParts.length ? root + resolvedParts.join('/') : null;
}

function isSafeMarkdownTarget(rawUrl, options) {
  if (!isSafeCreationUrl(rawUrl, options)) return false;
  // The workspace resolver decodes paths. Reject targets that would become
  // network paths or acquire an unsafe scheme during that same decode.
  try {
    return isSafeCreationUrl(decodeURIComponent(rawUrl.split(/[?#]/)[0] || rawUrl), options);
  } catch {
    return false;
  }
}

function rewriteRelativeMarkdownNodes(cleanHtml, baseFilePath, resolveMediaUrl) {
  if (!cleanHtml || typeof DOMParser === 'undefined') return cleanHtml;
  const doc = new DOMParser().parseFromString(cleanHtml, 'text/html');
  if (!doc?.body) return cleanHtml;

  for (const img of Array.from(doc.body.querySelectorAll('img'))) {
    const rawSrc = img.getAttribute('src') || '';
    if (!isSafeMarkdownTarget(rawSrc)) {
      img.removeAttribute('src');
      continue;
    }
    const resolved = resolveWorkspaceRelativePath(baseFilePath, rawSrc);
    if (!resolved) continue;
    const previewUrl = typeof resolveMediaUrl === 'function' ? (resolveMediaUrl(resolved) || '') : '';
    if (getExtension(resolved) !== '.svg' && isSafeSameOriginPreviewUrl(previewUrl)) {
      img.setAttribute('src', previewUrl);
      img.setAttribute('data-workspace-src', resolved);
      img.setAttribute('loading', 'lazy');
    } else {
      const btn = doc.createElement('button');
      btn.setAttribute('type', 'button');
      btn.setAttribute('class', 'canvas-rel-media-link canvas-rel-img-pending');
      btn.setAttribute('data-workspace-href', resolved);
      btn.setAttribute('data-workspace-src', resolved);
      const label = (img.getAttribute('alt') || '').trim() || basenameOf(resolved);
      btn.textContent = label;
      img.replaceWith(btn);
    }
  }

  for (const link of Array.from(doc.body.querySelectorAll('a'))) {
    const rawHref = link.getAttribute('href') || '';
    if (!isSafeMarkdownTarget(rawHref, { allowMailto: true })) {
      link.removeAttribute('href');
      continue;
    }
    const resolved = resolveWorkspaceRelativePath(baseFilePath, rawHref);
    if (!resolved) continue;
    link.setAttribute('data-workspace-href', resolved);
    link.setAttribute('href', '#');
    link.removeAttribute('target');
    link.removeAttribute('rel');
  }

  return doc.body.innerHTML;
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

/**
 * Map a DOM `<textarea>` LF-normalized character offset back to the exact
 * character index in a raw string that may contain CRLF (`\r\n`) or CR (`\r`).
 *
 * @param {string} rawContent
 * @param {number} normOffset
 * @returns {number}
 */
export function normalizedOffsetToRawOffset(rawContent, normOffset) {
  const raw = String(rawContent ?? '');
  const target = Math.max(0, Number.isFinite(normOffset) ? Math.floor(normOffset) : 0);
  let rawIdx = 0;
  let normIdx = 0;
  while (rawIdx < raw.length && normIdx < target) {
    if (raw[rawIdx] === '\r') {
      rawIdx += raw[rawIdx + 1] === '\n' ? 2 : 1;
    } else {
      rawIdx += 1;
    }
    normIdx += 1;
  }
  return rawIdx;
}

function buildLineOffsets(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\r') {
      if (src[i + 1] === '\n') i += 1;
      starts.push(i + 1);
    } else if (src[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

function findAllNormalizedOccurrences(src, needle) {
  const raw = String(src ?? '');
  const target = String(needle ?? '');
  if (!raw || !target) return [];

  const normSrc = raw.replace(/\r\n|\r/g, '\n');
  const normNeedle = target.replace(/\r\n|\r/g, '\n');
  if (!normNeedle) return [];

  const results = [];
  let pos = 0;
  while (pos <= normSrc.length - normNeedle.length) {
    const idx = normSrc.indexOf(normNeedle, pos);
    if (idx < 0) break;
    const rawStart = normalizedOffsetToRawOffset(raw, idx);
    const rawEnd = normalizedOffsetToRawOffset(raw, idx + normNeedle.length);
    results.push({ rawStart, rawEnd });
    pos = idx + 1;
  }
  return results;
}

function lineRangeFromOffsets(content, startOffset, endOffset) {
  const src = String(content || '');
  if (startOffset < 0 || endOffset <= startOffset) {
    return { lineStart: undefined, lineEnd: undefined };
  }
  const lineStart = src.slice(0, startOffset).split(/\r\n|\r|\n/).length;
  const lineEnd = src.slice(0, Math.max(startOffset, endOffset - 1)).split(/\r\n|\r|\n/).length;
  return { lineStart, lineEnd };
}

function useSafeCreationsStore() {
  try {
    return useCreationsStore();
  } catch {
    return null;
  }
}

/**
 * Exact, unambiguous text replacement with zero blind fallbacks.
 *
 * Mode A: Exact raw offsets (`rawStart`, `rawEnd`) must verify against `originalText`.
 * Mode B: Quote + optional 1-based inclusive `[lineStart..lineEnd]` window;
 *         falls back to global match ONLY when globally unique.
 *
 * @param {string} content
 * @param {{ originalText: string, revisedText: string, rawStart?: number|null, rawEnd?: number|null, lineStart?: number, lineEnd?: number }} anchor
 * @returns {{ applied: boolean, content: string, reason?: 'stale' | 'ambiguous' }}
 */
export function applyTextReplacement(content, anchor) {
  const src = String(content ?? '');
  const orig = String(anchor?.originalText ?? '');
  const rev = String(anchor?.revisedText ?? '');
  if (!orig) {
    return { applied: false, content: src, reason: 'stale' };
  }

  // Mode A: Exact raw offsets provided
  if (Number.isInteger(anchor?.rawStart) && Number.isInteger(anchor?.rawEnd)) {
    const { rawStart, rawEnd } = anchor;
    if (
      rawStart >= 0
      && rawEnd >= rawStart
      && rawEnd <= src.length
      && src.slice(rawStart, rawEnd) === orig
    ) {
      return {
        applied: true,
        content: src.slice(0, rawStart) + rev + src.slice(rawEnd),
      };
    }
    return { applied: false, content: src, reason: 'stale' };
  }

  // Mode B: Quote + optional 1-based inclusive line range
  const occurrences = findAllNormalizedOccurrences(src, orig);
  if (occurrences.length === 0) {
    return { applied: false, content: src, reason: 'stale' };
  }

  const hasLineStart = Number.isInteger(anchor?.lineStart) && anchor.lineStart >= 1;
  if (hasLineStart) {
    const lineStart = anchor.lineStart;
    const lineEnd = Number.isInteger(anchor?.lineEnd) && anchor.lineEnd >= lineStart
      ? anchor.lineEnd
      : lineStart;
    const lineStarts = buildLineOffsets(src);
    const winRawStart = lineStart <= lineStarts.length ? lineStarts[lineStart - 1] : src.length;
    const winRawEnd = lineEnd < lineStarts.length ? lineStarts[lineEnd] : src.length;

    const inWindow = occurrences.filter(occ => occ.rawStart >= winRawStart && occ.rawStart < winRawEnd);
    if (inWindow.length === 1) {
      const match = inWindow[0];
      return {
        applied: true,
        content: src.slice(0, match.rawStart) + rev + src.slice(match.rawEnd),
      };
    }
    if (inWindow.length > 1) {
      return { applied: false, content: src, reason: 'ambiguous' };
    }
  }

  if (occurrences.length === 1) {
    const match = occurrences[0];
    return {
      applied: true,
      content: src.slice(0, match.rawStart) + rev + src.slice(match.rawEnd),
    };
  }

  return { applied: false, content: src, reason: 'ambiguous' };
}

export default {
  name: 'FileCanvasView',
  components: { SvgPreview, CanvasInlineEditPopover, CanvasReviewPanel },
  props: {
    file: { type: Object, required: true },
    routeKey: { type: String, default: '' },
    saving: { type: Boolean, default: false },
    isBinary: { type: Boolean, default: false },
    showHeader: { type: Boolean, default: true },
    showOpenInFiles: { type: Boolean, default: false },
    showPromoteFolder: { type: Boolean, default: false },
    resolveMediaUrl: { type: Function, default: null },
    mediaUrlVersion: { type: Number, default: 0 },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    persistedDocPath: { type: String, default: undefined },
    category: { type: String, default: 'book' },
    docStatus: { type: String, default: 'draft' },
    mediaNav: { type: Object, default: null },
  },
  emits: [
    'update:content',
    'update:doc-status',
    'save',
    'reload-from-disk',
    'overwrite-disk',
    'download',
    'open-in-files',
    'promote-folder',
    'referenced',
    'media-load',
    'media-error',
    'open-relative-link',
    'media-back',
    'media-prev',
    'media-next',
  ],
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

      <div v-else-if="binaryDocument" class="canvas-state" role="status">
        <div class="canvas-binary-notice">
          {{ $t('files.binaryFile') }}
          <button v-if="file.blobUrl" type="button" class="btn-secondary" @click="$emit('download')">
            {{ $t('files.download') }}
          </button>
          <button v-else-if="showOpenInFiles" type="button" class="btn-secondary" @click="$emit('open-in-files')">
            {{ $t('creation.canvas.openInFiles') }}
          </button>
        </div>
      </div>

      <!-- ===================== DOCUMENT CANVAS ===================== -->
      <template v-else-if="canvasKind === 'doc'">
        <div v-if="file?.diskChangedToBinary" class="creation-wb-banner" role="alert"
          style="background: var(--warn-bg); color: var(--text-primary); border-inline-start: 3px solid var(--warn-text)">
          {{ binaryDraftWarning() }}
        </div>
        <div v-else-if="file?.diskChangedOnDisk" class="creation-wb-banner" style="flex-wrap: wrap;
          background: var(--warn-bg); color: var(--text-primary); border-inline-start: 3px solid var(--warn-text)">
          <span role="alert">{{ diskConflictMessage }}</span>
          <div class="canvas-toolbar-group" style="flex-wrap: wrap">
            <button type="button" class="btn-secondary" :disabled="saving || file.probingDisk"
              @click="$emit('reload-from-disk')">{{ reloadFromDiskLabel }}</button>
            <button type="button" class="btn-secondary" :disabled="saving || file.probingDisk || !file.isDirty"
              @click="$emit('overwrite-disk')">{{ overwriteDiskLabel }}</button>
          </div>
        </div>

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
              v-if="isMarkdown && headings.length > 0"
              type="button"
              class="canvas-tool-btn"
              :class="{ active: tocOpen }"
              :aria-pressed="tocOpen"
              @click="tocOpen = !tocOpen"
              :title="$t('creation.canvas.toc')"
            >
              <span>{{ $t('creation.canvas.toc') }}</span>
              <span class="canvas-badge">{{ headings.length }}</span>
            </button>

            <div v-if="creationId && persistedDocKey" class="canvas-popover-wrap" @click.stop>
              <button
                type="button"
                class="canvas-status-pill"
                :class="'is-' + normalizedDocStatus"
                :aria-expanded="statusMenuOpen"
                :title="tr('creation.docStatus.label', 'Status')"
                @click="toggleStatusMenu"
              >{{ docStatusLabel(normalizedDocStatus) }} ▾</button>

              <div v-if="statusMenuOpen" class="canvas-more-menu" role="menu">
                <button
                  v-for="st in workflowStatuses"
                  :key="st"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  :class="{ active: normalizedDocStatus === st }"
                  @click="selectDocStatus(st)"
                >{{ docStatusLabel(st) }}</button>
              </div>
            </div>
          </div>

          <div class="canvas-toolbar-group canvas-toolbar-right">
            <button
              type="button"
              class="canvas-tool-btn canvas-review-trigger"
              :class="{ active: reviewOpen }"
              :aria-pressed="reviewOpen"
              @click="reviewOpen = !reviewOpen"
            >
              <span aria-hidden="true">✦</span>
              <span>{{ tr('creation.canvas.review', 'Review') }}</span>
              <span v-if="openAnnotationCount > 0" class="canvas-badge">{{ openAnnotationCount }}</span>
            </button>

            <button
              v-if="file.isDirty"
              type="button"
              class="canvas-tool-btn canvas-save-btn"
              :disabled="saveBlocked"
              @click="$emit('save')"
              :title="$t('common.save') + ' (Ctrl+S)'"
            >{{ $t('common.save') }}</button>

            <!-- Typography Popover (Aa) -->
            <div class="canvas-popover-wrap" @click.stop>
              <button
                type="button"
                class="canvas-tool-btn"
                :class="{ active: typographyOpen }"
                :aria-expanded="typographyOpen"
                :title="tr('creation.canvas.typography', 'Typography')"
                @click="toggleTypographyMenu"
              >Aa</button>

              <div v-if="typographyOpen" class="canvas-typography-popover" role="dialog" :aria-label="tr('creation.canvas.typography', 'Typography')">
                <div class="canvas-font-controls" role="group">
                  <button
                    type="button"
                    class="canvas-tool-btn canvas-tool-compact"
                    :disabled="docFontSize <= 14"
                    @click="adjustFontSize(-1)"
                    :title="$t('git.zoomOut')"
                  >A−</button>
                  <span class="canvas-zoom-readout">{{ docFontSize }}px</span>
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
            </div>

            <!-- More Actions Menu (···) -->
            <div class="canvas-popover-wrap" @click.stop>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-icon"
                :class="{ active: moreMenuOpen }"
                :aria-expanded="moreMenuOpen"
                :title="tr('creation.canvas.moreActions', 'More actions')"
                :aria-label="tr('creation.canvas.moreActions', 'More actions')"
                @click="toggleMoreMenu"
              >···</button>

              <div v-if="moreMenuOpen" class="canvas-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @mousedown.prevent
                  @click="referenceDocument(); closeAllMenus()"
                >
                  <span aria-hidden="true">✦</span>
                  <span>{{ hasActiveDocSelection ? $t('creation.canvas.quoteToSession') : $t('creation.canvas.referenceFile') }}</span>
                </button>
                <button
                  v-if="showOpenInFiles"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('open-in-files'); closeAllMenus()"
                >{{ $t('creation.canvas.openInFiles') }}</button>
                <button
                  v-if="showPromoteFolder"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('promote-folder'); closeAllMenus()"
                >{{ $t('creation.canvas.promoteFolder') }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Inline replacement undo toast -->
        <div v-if="undoSnapshot" class="canvas-undo-toast" role="status" aria-live="polite">
          <span>{{ undoSnapshot.label }}</span>
          <button
            type="button"
            class="btn-secondary"
            @click="undoLastReplacement"
          >{{ tr('creation.canvas.undoReplace', 'Undo') }}</button>
          <button
            type="button"
            class="canvas-tool-btn canvas-tool-icon"
            :title="$t('common.close')"
            :aria-label="$t('common.close')"
            @click="undoSnapshot = null"
          >×</button>
        </div>

        <div v-if="applyConflictNotice" class="canvas-undo-toast" role="alert">
          <span>{{ applyConflictNotice }}</span>
          <button
            type="button"
            class="canvas-tool-btn canvas-tool-icon"
            :title="$t('common.close')"
            :aria-label="$t('common.close')"
            @click="applyConflictNotice = ''"
          >×</button>
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

          <div class="canvas-doc-scroll" ref="docScrollRef" @scroll="onDocScroll">
            <!-- Inline Quick Edit & Selection Popover (Read & Edit modes) -->
            <CanvasInlineEditPopover
              :visible="activePopoverVisible"
              :top="activePopoverTop"
              :left="activePopoverLeft"
              :selected-text="activePopoverText"
              :full-content="file.content || ''"
              :raw-start="activePopoverRawStart"
              :raw-end="activePopoverRawEnd"
              :ambiguous="activePopoverAmbiguous"
              :can-persist="Boolean(creationId && persistedDocKey)"
              :line-start="activePopoverLineStart"
              :line-end="activePopoverLineEnd"
              :file-path="reviewFilePath"
              :file-name="file.name || ''"
              :agent-id="agentId"
              :creation-id="creationId"
              :category="category"
              :route-key="routeKey"
              @close="closeSelectionPopover"
              @busy-change="popoverLocked = $event"
              @apply-replacement="applyInlineReplacement"
              @quote-to-session="quoteActiveSelection"
              @quick-review="onQuickReview"
            />

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
                :class="{ 'markdown-body': isMarkdown, 'canvas-markdown-body': isMarkdown, 'canvas-txt-content': !isMarkdown }"
                v-html="sanitizedDocHtml"
                @click="onMarkdownClick"
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

          <!-- Multi-Lens Review Panel -->
          <CanvasReviewPanel
            :visible="reviewOpen"
            :agent-id="agentId"
            :creation-id="creationId"
            :file-path="reviewFilePath"
            :persisted-doc-path="persistedDocKey"
            :file-name="file.name || ''"
            :content="file.content || ''"
            :category="category"
            :doc-status="normalizedDocStatus"
            :route-key="routeKey"
            :quick-review-request="quickReviewRequest"
            :reopened-annotation="reopenedAnnotation"
            :apply-annotation-fix="applyReviewAnnotation"
            :stage-annotations-to-session="stageReviewAnnotationsToSession"
            @close="reviewOpen = false"
            @apply-annotation="applyReviewAnnotation"
            @jump-to-line="jumpToLine"
            @send-to-session="sendReviewAnnotationsToSession"
            @update:doc-status="$emit('update:doc-status', $event)"
          />
        </div>
      </template>

      <!-- ===================== IMAGE CANVAS ===================== -->
      <template v-else-if="canvasKind === 'image'">
        <div v-if="showHeader" class="canvas-toolbar" role="toolbar">
          <div class="canvas-toolbar-group">
            <div v-if="mediaNav" class="canvas-media-nav-inline">
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-icon"
                :title="tr('creation.canvas.backToGrid', 'Back to grid')"
                :aria-label="tr('creation.canvas.backToGrid', 'Back to grid')"
                @click="$emit('media-back')"
              >←</button>
              <span class="canvas-media-nav-name" :title="file.name">{{ file.name }}</span>
              <span class="canvas-zoom-readout">{{ (mediaNav.index ?? 0) + 1 }} / {{ mediaNav.total ?? 1 }}</span>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-compact"
                :disabled="(mediaNav.index ?? 0) <= 0"
                @click="$emit('media-prev')"
              >‹</button>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-compact"
                :disabled="(mediaNav.index ?? 0) >= (mediaNav.total ?? 1) - 1"
                @click="$emit('media-next')"
              >›</button>
            </div>

            <button
              v-if="imageZoomMode === 'custom'"
              type="button"
              class="canvas-tool-btn canvas-zoom-readout"
              :title="$t('creation.canvas.fit')"
              @click="setImageFit"
            >{{ Math.round(imageZoom * 100) }}%</button>
          </div>

          <div class="canvas-toolbar-group canvas-toolbar-right">
            <button
              type="button"
              class="canvas-tool-btn canvas-ref-btn"
              @click="referenceImage"
            >
              <span aria-hidden="true">✦</span>
              <span>{{ $t('creation.canvas.referenceFile') }}</span>
            </button>

            <div class="canvas-popover-wrap" @click.stop>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-icon"
                :class="{ active: moreMenuOpen }"
                :aria-expanded="moreMenuOpen"
                :title="tr('creation.canvas.moreActions', 'More actions')"
                :aria-label="tr('creation.canvas.moreActions', 'More actions')"
                @click="toggleMoreMenu"
              >···</button>

              <div v-if="moreMenuOpen" class="canvas-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  :class="{ active: imageZoomMode === 'fit' }"
                  @click="setImageFit(); closeAllMenus()"
                >{{ $t('creation.canvas.fit') }}</button>
                <button
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  :class="{ active: imageZoomMode === 'custom' && imageZoom === 1 }"
                  @click="setImageActualSize(); closeAllMenus()"
                >{{ $t('creation.canvas.actualSize') }}</button>
                <button
                  v-if="!isSvgText && file.blobUrl"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="openLightbox($event.currentTarget); closeAllMenus()"
                >{{ $t('creation.canvas.openLightbox') }}</button>
                <button
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('download'); closeAllMenus()"
                >{{ $t('files.download') }}</button>
                <button
                  v-if="showOpenInFiles"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('open-in-files'); closeAllMenus()"
                >{{ $t('creation.canvas.openInFiles') }}</button>
                <button
                  v-if="showPromoteFolder"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('promote-folder'); closeAllMenus()"
                >{{ $t('creation.canvas.promoteFolder') }}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="canvas-image-stage" @wheel="onImageWheel">
          <div v-if="file.previewError" class="canvas-state canvas-state-error" role="alert">
            <span>{{ file.previewError }}</span>
          </div>
          <div v-else-if="isSvgText" class="canvas-image-svg-wrap" :style="svgZoomStyle" @dblclick="toggleImageFitActual">
            <SvgPreview :key="file.path" :content="file.content || ''" :name="file.name" />
          </div>
          <div v-else-if="!file.blobUrl" class="canvas-state" role="status">
            <span class="spinner-mini" aria-hidden="true"></span>
            <span>{{ $t('files.loadingPreview') }}</span>
          </div>
          <div v-else class="canvas-image-viewport" :class="{ 'is-fit': imageZoomMode === 'fit' }" @dblclick="toggleImageFitActual">
            <div v-if="file.previewLoading" class="canvas-media-loading-overlay" role="status" aria-live="polite">
              <span class="spinner-mini" aria-hidden="true"></span>
              <span>{{ $t('files.loadingPreview') }}</span>
            </div>
            <img
              :key="file.blobUrl"
              :src="file.blobUrl"
              :data-canvas-path="file.path"
              :data-canvas-url="file.blobUrl"
              :alt="file.name"
              class="canvas-image-el"
              :class="{ 'is-fit': imageZoomMode === 'fit' }"
              :style="imageZoomStyle"
              @load="onImageLoad"
              @error="onImageError"
              @click="openLightbox($event.currentTarget)"
            />
          </div>
        </div>
      </template>

      <!-- ===================== VIDEO CANVAS ===================== -->
      <template v-else-if="canvasKind === 'video'">
        <div v-if="showHeader" class="canvas-toolbar" role="toolbar">
          <div class="canvas-toolbar-group">
            <div v-if="mediaNav" class="canvas-media-nav-inline">
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-icon"
                :title="tr('creation.canvas.backToGrid', 'Back to grid')"
                :aria-label="tr('creation.canvas.backToGrid', 'Back to grid')"
                @click="$emit('media-back')"
              >←</button>
              <span class="canvas-media-nav-name" :title="file.name">{{ file.name }}</span>
              <span class="canvas-zoom-readout">{{ (mediaNav.index ?? 0) + 1 }} / {{ mediaNav.total ?? 1 }}</span>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-compact"
                :disabled="(mediaNav.index ?? 0) <= 0"
                @click="$emit('media-prev')"
              >‹</button>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-compact"
                :disabled="(mediaNav.index ?? 0) >= (mediaNav.total ?? 1) - 1"
                @click="$emit('media-next')"
              >›</button>
            </div>
          </div>

          <div class="canvas-toolbar-group canvas-toolbar-right">
            <button
              type="button"
              class="canvas-tool-btn"
              @click="addVideoMarker"
            >+ {{ $t('creation.canvas.addBookmark') }}</button>

            <button
              type="button"
              class="canvas-tool-btn canvas-ref-btn"
              @click="referenceVideoAtCurrentTime"
            >
              <span aria-hidden="true">✦</span>
              <span>{{ $t('creation.canvas.referenceAtTime') }} @ {{ currentTimeLabel }}</span>
            </button>

            <div class="canvas-popover-wrap" @click.stop>
              <button
                type="button"
                class="canvas-tool-btn canvas-tool-icon"
                :class="{ active: moreMenuOpen }"
                :aria-expanded="moreMenuOpen"
                :title="tr('creation.canvas.moreActions', 'More actions')"
                :aria-label="tr('creation.canvas.moreActions', 'More actions')"
                @click="toggleMoreMenu"
              >···</button>

              <div v-if="moreMenuOpen" class="canvas-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('download'); closeAllMenus()"
                >{{ $t('files.download') }}</button>
                <button
                  v-if="showOpenInFiles"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('open-in-files'); closeAllMenus()"
                >{{ $t('creation.canvas.openInFiles') }}</button>
                <button
                  v-if="showPromoteFolder"
                  type="button"
                  role="menuitem"
                  class="canvas-tool-btn"
                  @click="$emit('promote-folder'); closeAllMenus()"
                >{{ $t('creation.canvas.promoteFolder') }}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="canvas-video-stage">
          <div v-if="file.previewError" class="canvas-state canvas-state-error" role="alert">
            <span>{{ file.previewError }}</span>
          </div>
          <div v-else-if="!file.blobUrl" class="canvas-state" role="status">
            <span class="spinner-mini" aria-hidden="true"></span>
            <span>{{ $t('files.loadingPreview') }}</span>
          </div>
          <template v-else>
            <div class="canvas-video-player-wrap">
              <div v-if="file.previewLoading" class="canvas-media-loading-overlay" role="status" aria-live="polite">
                <span class="spinner-mini" aria-hidden="true"></span>
                <span>{{ $t('files.loadingPreview') }}</span>
              </div>
              <video
                ref="videoRef"
                :key="file.blobUrl"
                :src="file.blobUrl"
                :data-canvas-path="file.path"
                :data-canvas-url="file.blobUrl"
                :aria-label="file.name"
                class="canvas-video-el"
                controls
                preload="metadata"
                playsinline
                @timeupdate="onVideoTimeUpdate"
                @loadedmetadata="onVideoLoadedMetadata"
                @loadeddata="onVideoMediaLoad"
                @canplay="onVideoMediaLoad"
                @error="onVideoMediaError"
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
    const tr = (key, fallback, params) => {
      const translated = typeof t === 'function' ? t(key, params) : key;
      if (translated && translated !== key) return translated;
      let text = fallback ?? key;
      if (params && typeof text === 'string') {
        for (const [k, v] of Object.entries(params)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    };

    const creationsStore = useSafeCreationsStore();
    const workflowStatuses = Array.isArray(DOC_WORKFLOW_STATUSES) && DOC_WORKFLOW_STATUSES.length > 0
      ? DOC_WORKFLOW_STATUSES
      : FALLBACK_DOC_STATUSES;
    const normalizedDocStatus = Vue.computed(() => (
      workflowStatuses.includes(props.docStatus) ? props.docStatus : 'draft'
    ));
    const docStatusLabel = (status) => {
      if (status === 'final') return tr('creation.docStatus.final', 'Final');
      if (status === 'review') return tr('creation.docStatus.review', 'In Review');
      return tr('creation.docStatus.draft', 'Draft');
    };

    const isChinese = Vue.computed(() => getLocale() === 'zh-CN');
    const diskConflictMessage = Vue.computed(() => isChinese.value
      ? '磁盘上的文件在你开始编辑后发生了变化。重新加载会丢弃草稿，覆盖则会替换磁盘上的版本。'
      : 'The file on disk changed since you started editing. Reloading discards your draft; overwriting replaces the version on disk.');
    const reloadFromDiskLabel = Vue.computed(() => isChinese.value ? '从磁盘重新加载' : 'Reload from disk');
    const overwriteDiskLabel = Vue.computed(() => isChinese.value ? '覆盖磁盘文件' : 'Overwrite disk');
    const saveBlocked = Vue.computed(() => props.saving || props.file?.diskChangedToBinary
      || props.file?.diskChangedOnDisk || props.file?.probingDisk);
    const canvasKind = Vue.computed(() => isCanvasSupportedFile(props.file));
    const binaryDocument = Vue.computed(() => canvasKind.value === 'doc' && (props.isBinary || isBinaryDocument(props.file)));
    const isMarkdown = Vue.computed(() => MARKDOWN_EXTS.has(getExtension(props.file)));
    const isSvgText = Vue.computed(() => (
      getExtension(props.file) === '.svg'
      && (!props.file?.fileType || props.file.fileType === 'text')
    ));

    // --- Toolbar Popover / Menu state ---
    const statusMenuOpen = Vue.ref(false);
    const typographyOpen = Vue.ref(false);
    const moreMenuOpen = Vue.ref(false);

    const closeAllMenus = () => {
      statusMenuOpen.value = false;
      typographyOpen.value = false;
      moreMenuOpen.value = false;
    };

    const toggleStatusMenu = () => {
      const next = !statusMenuOpen.value;
      closeAllMenus();
      statusMenuOpen.value = next;
    };

    const toggleTypographyMenu = () => {
      const next = !typographyOpen.value;
      closeAllMenus();
      typographyOpen.value = next;
    };

    const toggleMoreMenu = () => {
      const next = !moreMenuOpen.value;
      closeAllMenus();
      moreMenuOpen.value = next;
    };

    const selectDocStatus = (status) => {
      closeAllMenus();
      if (status && status !== normalizedDocStatus.value) {
        emit('update:doc-status', status);
      }
    };

    const onDocumentClick = () => {
      closeAllMenus();
    };

    const onDocumentKeydown = (e) => {
      if (e.key === 'Escape') {
        closeAllMenus();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('click', onDocumentClick);
      document.addEventListener('keydown', onDocumentKeydown);
    }

    // --- Document state ---
    const docMode = Vue.ref('read');
    const tocOpen = Vue.ref(false);
    const reviewOpen = Vue.ref(false);
    const quickReviewRequest = Vue.ref(null);
    const undoSnapshot = Vue.ref(null);
    const applyConflictNotice = Vue.ref('');
    const reopenedAnnotation = Vue.ref(null);
    const popoverLocked = Vue.ref(false);
    const docFontSize = Vue.ref(16);
    const docScrollRef = Vue.ref(null);
    const readerContentRef = Vue.ref(null);
    const editorRef = Vue.ref(null);
    const selectionBar = Vue.reactive({
      visible: false,
      top: 0,
      left: 0,
      text: '',
      rawStart: null,
      rawEnd: null,
      ambiguous: false,
      lineStart: undefined,
      lineEnd: undefined,
    });
    const editorSelection = Vue.reactive({
      visible: false,
      top: 12,
      left: 16,
      text: '',
      rawStart: null,
      rawEnd: null,
      ambiguous: false,
      lineStart: undefined,
      lineEnd: undefined,
    });

    const reviewFilePath = Vue.computed(() => props.file?.relPath || props.file?.path || '');
    const persistedDocKey = Vue.computed(() => (
      props.persistedDocPath !== undefined ? props.persistedDocPath : reviewFilePath.value
    ));

    const openAnnotationCount = Vue.computed(() => {
      if (!props.agentId || !props.creationId || !persistedDocKey.value) return 0;
      if (typeof creationsStore?.getDocReview === 'function') {
        const review = creationsStore.getDocReview(props.agentId, props.creationId, persistedDocKey.value);
        if (review && Array.isArray(review.annotations)) {
          return review.annotations.filter(a => (a.status || 'open') === 'open').length;
        }
      }
      if (typeof creationsStore?.getDocState === 'function') {
        const state = creationsStore.getDocState(props.agentId, props.creationId, persistedDocKey.value);
        if (state && typeof state.openReviewCount === 'number') return state.openReviewCount;
      }
      return 0;
    });

    const wordCount = Vue.computed(() => countWords(props.file?.content || ''));
    const headings = Vue.computed(() => (
      isMarkdown.value ? extractHeadings(props.file?.content || '') : []
    ));

    const sanitizedDocHtml = Vue.computed(() => {
      // Reactive dependency so Markdown re-renders when parent finishes loading workspace previews
      void props.mediaUrlVersion;
      const content = props.file?.content;
      if (binaryDocument.value || typeof content !== 'string' || !content) return '';
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
        const cleanHtml = sanitizeCreationHtml(rawHtml);
        return rewriteRelativeMarkdownNodes(cleanHtml, props.file?.path || '', props.resolveMediaUrl);
      }
      // Plain text (.txt): preserve paragraphs and line breaks safely
      const paragraphs = content
        .split(/\r?\n\r?\n/)
        .map(block => `<p>${escapeHtml(block).replace(/\r?\n/g, '<br>')}</p>`)
        .join('');
      return sanitizeCreationHtml(paragraphs);
    });

    const onMarkdownClick = (event) => {
      const target = event?.target?.closest?.('[data-workspace-href], [data-workspace-src]');
      if (!target) return;
      const targetPath = target.getAttribute('data-workspace-href') || target.getAttribute('data-workspace-src') || '';
      if (!targetPath) return;
      event.preventDefault();
      const kind = isCanvasSupportedFile(targetPath) || 'other';
      emit('open-relative-link', { targetPath, rawHref: targetPath, kind });
    };

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
      selectionBar.rawStart = null;
      selectionBar.rawEnd = null;
      selectionBar.ambiguous = false;
      selectionBar.lineStart = undefined;
      selectionBar.lineEnd = undefined;
    };

    const hideEditorSelection = () => {
      editorSelection.visible = false;
      editorSelection.text = '';
      editorSelection.rawStart = null;
      editorSelection.rawEnd = null;
      editorSelection.ambiguous = false;
      editorSelection.lineStart = undefined;
      editorSelection.lineEnd = undefined;
    };

    const closeSelectionPopover = () => {
      popoverLocked.value = false;
      hideSelectionBar();
      editorSelection.visible = false;
    };

    const onDocScroll = () => {
      if (docMode.value === 'read' && !popoverLocked.value) {
        hideSelectionBar();
      }
    };

    const setDocMode = (mode) => {
      if (binaryDocument.value) return;
      docMode.value = mode;
      hideSelectionBar();
      hideEditorSelection();
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

    const jumpToLine = (lineNumber) => {
      const targetLine = Number(lineNumber);
      if (!Number.isFinite(targetLine) || targetLine < 1) return;
      const lines = String(props.file?.content || '').split(/\r?\n/);
      const targetLineIdx = Math.max(0, Math.min(lines.length - 1, Math.floor(targetLine) - 1));

      if (docMode.value === 'edit') {
        const textarea = editorRef.value;
        if (!textarea) return;
        let offset = 0;
        for (let i = 0; i < targetLineIdx; i += 1) {
          offset += lines[i].length + 1;
        }
        textarea.focus();
        textarea.setSelectionRange(offset, offset + (lines[targetLineIdx]?.length || 0));
        const approxLineHeight = docFontSize.value * 1.75;
        if (docScrollRef.value) {
          docScrollRef.value.scrollTop = Math.max(0, targetLineIdx * approxLineHeight - 48);
        }
        return;
      }

      const scrollEl = docScrollRef.value;
      const container = readerContentRef.value;
      if (!scrollEl || !container) return;
      const probe = (lines[targetLineIdx] || '').replace(/^[#>*\-\d.\s]+/, '').trim().slice(0, 48);
      if (probe) {
        const blocks = container.querySelectorAll('p, li, h1, h2, h3, h4, blockquote, pre');
        for (const block of blocks) {
          if ((block.textContent || '').includes(probe)) {
            block.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
        }
      }
      const ratio = lines.length > 1 ? targetLineIdx / (lines.length - 1) : 0;
      scrollEl.scrollTo?.({
        top: Math.max(0, ratio * Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight)),
        behavior: 'smooth',
      });
    };

    const disambiguateReaderOccurrence = (rawContent, occurrences, container, range) => {
      if (occurrences.length <= 1 || !container || !range || typeof document === 'undefined') {
        return occurrences;
      }
      try {
        const prefixRange = document.createRange();
        prefixRange.setStart(container, 0);
        prefixRange.setEnd(range.startContainer, range.startOffset);
        const domPrefix = prefixRange.toString().replace(/\s+/g, ' ').trim();

        const suffixRange = document.createRange();
        suffixRange.setStart(range.endContainer, range.endOffset);
        suffixRange.setEnd(container, container.childNodes.length);
        const domSuffix = suffixRange.toString().replace(/\s+/g, ' ').trim();

        const prefixProbe = domPrefix.slice(-24).trim();
        const suffixProbe = domSuffix.slice(0, 24).trim();
        const matchPrefix = (occ) => {
          if (!prefixProbe) return false;
          const rawBefore = rawContent.slice(Math.max(0, occ.rawStart - 160), occ.rawStart)
            .replace(/\s+/g, ' ')
            .trim();
          return rawBefore.endsWith(prefixProbe) || rawBefore.includes(prefixProbe);
        };
        const matchSuffix = (occ) => {
          if (!suffixProbe) return false;
          const rawAfter = rawContent.slice(occ.rawEnd, Math.min(rawContent.length, occ.rawEnd + 160))
            .replace(/\s+/g, ' ')
            .trim();
          return rawAfter.startsWith(suffixProbe) || rawAfter.includes(suffixProbe);
        };

        if (prefixProbe && suffixProbe) {
          const both = occurrences.filter(occ => matchPrefix(occ) && matchSuffix(occ));
          if (both.length === 1) return both;
        }
        if (prefixProbe.length >= 4) {
          const byPrefix = occurrences.filter(matchPrefix);
          if (byPrefix.length === 1) return byPrefix;
        }
        if (suffixProbe.length >= 4) {
          const bySuffix = occurrences.filter(matchSuffix);
          if (bySuffix.length === 1) return bySuffix;
        }
      } catch {
        // ignore DOM Range disambiguation errors
      }
      return occurrences;
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
        const top = Math.max(8, rect.top - scrollRect.top + scrollEl.scrollTop - 44);
        const centerX = rect.left - scrollRect.left + rect.width / 2;
        const popW = Math.min(420, Math.max(240, scrollRect.width - 16));
        const left = Math.max(8, Math.min(scrollRect.width - popW - 8, centerX - popW / 2));

        const rawContent = props.file?.content || '';
        const allOccurrences = findAllNormalizedOccurrences(rawContent, text);
        let resolvedText = text;
        let rawStart = null;
        let rawEnd = null;
        let lineStart;
        let lineEnd;
        let ambiguous = false;

        if (allOccurrences.length === 1) {
          const occ = allOccurrences[0];
          rawStart = occ.rawStart;
          rawEnd = occ.rawEnd;
          resolvedText = rawContent.slice(rawStart, rawEnd);
          ({ lineStart, lineEnd } = lineRangeFromOffsets(rawContent, rawStart, rawEnd));
        } else if (allOccurrences.length > 1) {
          const narrowed = disambiguateReaderOccurrence(rawContent, allOccurrences, container, range);
          if (narrowed.length === 1) {
            const occ = narrowed[0];
            rawStart = occ.rawStart;
            rawEnd = occ.rawEnd;
            resolvedText = rawContent.slice(rawStart, rawEnd);
            ({ lineStart, lineEnd } = lineRangeFromOffsets(rawContent, rawStart, rawEnd));
          } else {
            ambiguous = true;
            rawStart = null;
            rawEnd = null;
          }
        } else {
          ({ lineStart, lineEnd } = findLineRangeForSnippet(rawContent, text));
        }

        selectionBar.top = top;
        selectionBar.left = left;
        selectionBar.text = resolvedText;
        selectionBar.rawStart = rawStart;
        selectionBar.rawEnd = rawEnd;
        selectionBar.ambiguous = ambiguous;
        selectionBar.lineStart = lineStart;
        selectionBar.lineEnd = lineEnd;
        selectionBar.visible = true;
      } catch {
        if (!popoverLocked.value) hideSelectionBar();
      }
    };

    const quoteReaderSelection = () => {
      const snippet = selectionBar.text.trim();
      if (!snippet) return;
      const { lineStart, lineEnd } = selectionBar.lineStart
        ? { lineStart: selectionBar.lineStart, lineEnd: selectionBar.lineEnd }
        : findLineRangeForSnippet(props.file?.content || '', snippet);
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

    const quoteActiveSelection = () => {
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
        editorSelection.visible = false;
        emit('referenced', ref);
      }
    };

    const onEditorInput = (event) => {
      if (!binaryDocument.value) emit('update:content', event.target.value);
    };

    const onEditorKeydown = (event) => {
      if (binaryDocument.value) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!saveBlocked.value) emit('save');
      }
    };

    const onEditorSelectionChange = () => {
      const textarea = editorRef.value;
      if (!textarea) return;
      const startNorm = textarea.selectionStart ?? 0;
      const endNorm = textarea.selectionEnd ?? 0;
      if (endNorm <= startNorm) {
        hideEditorSelection();
        return;
      }
      const rawContent = props.file?.content || '';
      const rawStart0 = normalizedOffsetToRawOffset(rawContent, startNorm);
      const rawEnd0 = normalizedOffsetToRawOffset(rawContent, endNorm);
      const rawSlice = rawContent.slice(rawStart0, rawEnd0);
      if (!rawSlice.trim()) {
        hideEditorSelection();
        return;
      }
      const leadingWs = rawSlice.length - rawSlice.trimStart().length;
      const trailingWs = rawSlice.length - rawSlice.trimEnd().length;
      const rawStart = rawStart0 + leadingWs;
      const rawEnd = rawEnd0 - trailingWs;
      const text = rawContent.slice(rawStart, rawEnd);
      if (!text) {
        hideEditorSelection();
        return;
      }
      const { lineStart, lineEnd } = lineRangeFromOffsets(rawContent, rawStart, rawEnd);
      const scrollEl = docScrollRef.value;
      const scrollTop = scrollEl?.scrollTop || 0;
      const width = scrollEl?.clientWidth || 420;
      const popW = Math.min(420, Math.max(240, width - 16));
      editorSelection.text = text;
      editorSelection.rawStart = rawStart;
      editorSelection.rawEnd = rawEnd;
      editorSelection.ambiguous = false;
      editorSelection.lineStart = lineStart;
      editorSelection.lineEnd = lineEnd;
      editorSelection.top = scrollTop + 12;
      editorSelection.left = Math.max(8, Math.min(width - popW - 8, (width - popW) / 2));
      editorSelection.visible = true;
    };

    const activePopoverVisible = Vue.computed(() => (
      (docMode.value === 'read' && selectionBar.visible && !!selectionBar.text)
      || (docMode.value === 'edit' && editorSelection.visible && !!editorSelection.text)
    ));
    const activePopoverTop = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.top : editorSelection.top
    ));
    const activePopoverLeft = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.left : editorSelection.left
    ));
    const activePopoverText = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.text : editorSelection.text
    ));
    const activePopoverRawStart = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.rawStart : editorSelection.rawStart
    ));
    const activePopoverRawEnd = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.rawEnd : editorSelection.rawEnd
    ));
    const activePopoverAmbiguous = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.ambiguous : editorSelection.ambiguous
    ));
    const activePopoverLineStart = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.lineStart : editorSelection.lineStart
    ));
    const activePopoverLineEnd = Vue.computed(() => (
      docMode.value === 'read' ? selectionBar.lineEnd : editorSelection.lineEnd
    ));

    const hasActiveDocSelection = Vue.computed(() => (
      (docMode.value === 'read' && selectionBar.visible && !!selectionBar.text)
      || (docMode.value === 'edit' && !!editorSelection.text)
    ));

    // Invalidate one-shot Undo immediately if content diverges after replacement
    Vue.watch(() => props.file?.content, (newContent) => {
      if (undoSnapshot.value && newContent !== undoSnapshot.value.expectedPostContent) {
        undoSnapshot.value = null;
      }
    });

    const applyContentMutation = (anchor, meta = {}) => {
      if (binaryDocument.value) {
        return { applied: false, reason: 'stale' };
      }
      const prevContent = props.file?.content || '';
      const result = applyTextReplacement(prevContent, anchor);
      if (!result.applied) {
        return { applied: false, reason: result.reason || 'stale' };
      }
      applyConflictNotice.value = '';
      if (result.content !== prevContent) {
        undoSnapshot.value = {
          prevContent,
          expectedPostContent: result.content,
          annotationId: meta.annotationId || null,
          label: meta.label || tr('creation.canvas.replacedNotice', 'Passage replaced'),
        };
        emit('update:content', result.content);
      }
      return { applied: true };
    };

    const applyInlineReplacement = (payload) => {
      if (!payload) return { applied: false, reason: 'stale' };
      const res = applyContentMutation({
        originalText: payload.originalText,
        revisedText: payload.revisedText,
        rawStart: payload.rawStart,
        rawEnd: payload.rawEnd,
        lineStart: payload.lineStart,
        lineEnd: payload.lineEnd,
      });
      if (!res.applied) {
        applyConflictNotice.value = tr(
          'creation.canvas.applyConflict',
          'Document changed since selection; cannot safely apply this replacement.',
        );
      }
      if (typeof window !== 'undefined') {
        window.getSelection?.()?.removeAllRanges?.();
      }
      popoverLocked.value = false;
      hideSelectionBar();
      hideEditorSelection();
      return res;
    };

    const applyReviewAnnotation = (ann) => {
      if (!ann || !ann.suggestedReplacement) {
        return { applied: false, reason: 'stale' };
      }
      return applyContentMutation(
        {
          originalText: ann.quote || '',
          revisedText: ann.suggestedReplacement,
          lineStart: ann.lineStart,
          lineEnd: ann.lineEnd,
        },
        { annotationId: ann.id || null },
      );
    };

    const undoLastReplacement = () => {
      const snap = undoSnapshot.value;
      if (!snap) return;
      if ((props.file?.content || '') !== snap.expectedPostContent) {
        undoSnapshot.value = null;
        return;
      }
      undoSnapshot.value = null;
      emit('update:content', snap.prevContent);
      if (snap.annotationId) {
        if (props.agentId && props.creationId && persistedDocKey.value
          && typeof creationsStore?.resolveReviewAnnotation === 'function') {
          creationsStore.resolveReviewAnnotation(
            props.agentId,
            props.creationId,
            persistedDocKey.value,
            snap.annotationId,
            'open',
          ).catch(() => {});
        }
        reopenedAnnotation.value = {
          id: snap.annotationId,
          nonce: Date.now() + Math.random(),
        };
      }
    };

    const onQuickReview = (payload) => {
      if (!payload || !payload.selectedText) return;
      reviewOpen.value = true;
      quickReviewRequest.value = {
        nonce: Date.now() + Math.random(),
        lensId: payload.lensId,
        selectedText: payload.selectedText,
        lineStart: payload.lineStart,
        lineEnd: payload.lineEnd,
      };
      hideSelectionBar();
      editorSelection.visible = false;
    };

    const MAX_CANVAS_REFS = 6;
    const MAX_REF_SNIPPET_CHARS = 760;

    const stageReviewAnnotationsToSession = (selectedAnnotations) => {
      if (!Array.isArray(selectedAnnotations) || selectedAnnotations.length === 0) {
        return { stagedIds: [], remainingIds: [] };
      }

      const formatItem = (ann, idx) => {
        const loc = ann.lineStart ? `[L${ann.lineStart}] ` : '';
        const title = ann.title ? `${ann.title}: ` : '';
        const detail = ann.comment || ann.quote || '';
        return `${idx + 1}. ${loc}${title}${detail}`.trim().slice(0, MAX_REF_SNIPPET_CHARS);
      };

      // Group annotations into chunks that each fit cleanly under MAX_REF_SNIPPET_CHARS
      const chunks = [];
      let currentChunk = [];
      let currentText = '';

      for (let i = 0; i < selectedAnnotations.length; i += 1) {
        const ann = selectedAnnotations[i];
        if (!ann) continue;
        const line = formatItem(ann, i);
        if (!line) continue;
        if (currentChunk.length === 0) {
          currentChunk = [ann];
          currentText = line;
        } else if (currentText.length + 1 + line.length <= MAX_REF_SNIPPET_CHARS) {
          currentChunk.push(ann);
          currentText = `${currentText}\n${line}`;
        } else {
          chunks.push({ anns: currentChunk, text: currentText });
          currentChunk = [ann];
          currentText = line;
        }
      }
      if (currentChunk.length > 0) {
        chunks.push({ anns: currentChunk, text: currentText });
      }

      const stagedIds = [];
      const remainingIds = [];
      const filePath = props.file?.path || '';
      const fileName = props.file?.name || '';

      for (const chunk of chunks) {
        const existingRefs = getCanvasContextRefs(props.routeKey);
        const alreadyPresent = existingRefs.some(item => (
          item.kind === 'doc'
          && item.filePath === filePath
          && (item.snippet || '') === chunk.text
        ));
        if (!alreadyPresent && existingRefs.length >= MAX_CANVAS_REFS) {
          for (const ann of chunk.anns) {
            if (ann.id) remainingIds.push(ann.id);
          }
          continue;
        }
        const lineNumbers = chunk.anns
          .map(a => Number(a.lineStart))
          .filter(n => Number.isInteger(n) && n > 0);
        const lineStart = lineNumbers.length > 0 ? Math.min(...lineNumbers) : undefined;
        const lineEnd = lineNumbers.length > 0
          ? Math.max(...chunk.anns.map(a => Number(a.lineEnd || a.lineStart)).filter(n => Number.isInteger(n) && n > 0))
          : undefined;
        const ref = addCanvasContextRef(props.routeKey, {
          kind: 'doc',
          filePath,
          fileName,
          snippet: chunk.text,
          ...(lineStart !== undefined ? { lineStart, lineEnd } : {}),
        });
        emit('referenced', ref);
        for (const ann of chunk.anns) {
          if (ann.id) stagedIds.push(ann.id);
        }
      }

      return { stagedIds, remainingIds };
    };

    const sendReviewAnnotationsToSession = (selectedAnnotations) => {
      stageReviewAnnotationsToSession(selectedAnnotations);
    };

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

    const toggleImageFitActual = () => {
      if (imageZoomMode.value === 'fit') {
        setImageActualSize();
      } else {
        setImageFit();
      }
    };

    const zoomImage = (delta) => {
      imageZoomMode.value = 'custom';
      imageZoom.value = Math.max(0.25, Math.min(4, Math.round((imageZoom.value + delta) * 100) / 100));
    };

    const onImageWheel = (event) => {
      if (!event || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      const delta = event.deltaY < 0 ? 0.15 : -0.15;
      zoomImage(delta);
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

    const readMediaEventMeta = (e) => {
      const target = e?.currentTarget;
      const path = target?.dataset?.canvasPath || props.file?.path || '';
      const url = target?.dataset?.canvasUrl || props.file?.blobUrl || '';
      return { path, url };
    };

    const onImageLoad = (e) => {
      emit('media-load', readMediaEventMeta(e));
    };

    const onImageError = (e) => {
      emit('media-error', readMediaEventMeta(e));
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

    const onVideoMediaLoad = (e) => {
      emit('media-load', readMediaEventMeta(e));
    };

    const onVideoMediaError = (e) => {
      emit('media-error', readMediaEventMeta(e));
    };

    const onVideoLoadedMetadata = (e) => {
      const target = e?.currentTarget || videoRef.value;
      if (target) {
        duration.value = Number.isFinite(target.duration) ? target.duration : 0;
        target.playbackRate = playbackRate.value;
      }
      onVideoMediaLoad(e);
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
      closeAllMenus();
      popoverLocked.value = false;
      hideSelectionBar();
      hideEditorSelection();
      undoSnapshot.value = null;
      applyConflictNotice.value = '';
      quickReviewRequest.value = null;
      setImageFit();
      closeLightbox();
      currentTime.value = 0;
      duration.value = 0;
      videoMarkers.value = [];
    });

    const cleanup = () => {
      closeLightbox();
      if (typeof document !== 'undefined') {
        document.removeEventListener('click', onDocumentClick);
        document.removeEventListener('keydown', onDocumentKeydown);
      }
    };

    Vue.onBeforeUnmount(cleanup);
    Vue.onDeactivated?.(closeLightbox);

    return {
      tr,
      workflowStatuses,
      normalizedDocStatus,
      docStatusLabel,
      canvasKind,
      binaryDocument,
      binaryDraftWarning,
      diskConflictMessage,
      reloadFromDiskLabel,
      overwriteDiskLabel,
      saveBlocked,
      isMarkdown,
      isSvgText,
      // Menus
      statusMenuOpen,
      typographyOpen,
      moreMenuOpen,
      closeAllMenus,
      toggleStatusMenu,
      toggleTypographyMenu,
      toggleMoreMenu,
      selectDocStatus,
      // Document
      docMode,
      tocOpen,
      reviewOpen,
      reviewFilePath,
      persistedDocKey,
      quickReviewRequest,
      undoSnapshot,
      applyConflictNotice,
      reopenedAnnotation,
      popoverLocked,
      openAnnotationCount,
      docFontSize,
      docScrollRef,
      readerContentRef,
      editorRef,
      selectionBar,
      activePopoverVisible,
      activePopoverTop,
      activePopoverLeft,
      activePopoverText,
      activePopoverRawStart,
      activePopoverRawEnd,
      activePopoverAmbiguous,
      activePopoverLineStart,
      activePopoverLineEnd,
      wordCount,
      headings,
      sanitizedDocHtml,
      onMarkdownClick,
      hasActiveDocSelection,
      setDocMode,
      adjustFontSize,
      jumpToHeading,
      jumpToLine,
      hideSelectionBar,
      closeSelectionPopover,
      onDocScroll,
      onReaderSelectionChange,
      quoteReaderSelection,
      quoteActiveSelection,
      onEditorInput,
      onEditorKeydown,
      onEditorSelectionChange,
      applyInlineReplacement,
      applyReviewAnnotation,
      undoLastReplacement,
      onQuickReview,
      stageReviewAnnotationsToSession,
      sendReviewAnnotationsToSession,
      referenceDocument,
      // Image
      imageZoomMode,
      imageZoom,
      imageZoomStyle,
      svgZoomStyle,
      setImageFit,
      setImageActualSize,
      toggleImageFitActual,
      zoomImage,
      onImageWheel,
      openLightbox,
      onImageLoad,
      onImageError,
      referenceImage,
      // Video
      videoRef,
      playbackRate,
      currentTimeLabel,
      durationLabel,
      videoMarkers,
      onVideoTimeUpdate,
      onVideoLoadedMetadata,
      onVideoMediaLoad,
      onVideoMediaError,
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
