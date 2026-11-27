/**
 * Yeaft Cosmos Creations — BookReader (markdown_doc modality)
 *
 * Comfortable 680px reading column with appearance controls (font size, line height,
 * paper/sepia/night surface), inline light editing, text-selection floating bar
 * (light edit / AI rewrite anchor / capture to Canon), and prev/next chapter navigation.
 */
import { renderMarkdown } from '../../../../utils/markdown.js';
import { sanitizeCreationHtml } from '../sanitize.js';
import { useCreationsStore } from '../../../../stores/creations.js';

const PREFS_STORAGE_KEY = 'yeaft_creation_book_prefs';
const DEFAULT_PREFS = {
  fontSize: 17,
  lineHeight: 1.8,
  surface: 'paper', // 'paper' | 'sepia' | 'night'
};

function isFolderNode(n) {
  if (!n) return false;
  return n.kind === 'folder' || n.nodeType === 'folder' || n.type === 'folder' || n.isFolder === true;
}

function loadReaderPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      fontSize: Math.min(21, Math.max(15, Number(parsed.fontSize) || DEFAULT_PREFS.fontSize)),
      lineHeight: Math.min(2.0, Math.max(1.6, Number(parsed.lineHeight) || DEFAULT_PREFS.lineHeight)),
      surface: ['paper', 'sepia', 'night'].includes(parsed.surface) ? parsed.surface : DEFAULT_PREFS.surface,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function saveReaderPrefs(prefs) {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage quota errors
  }
}

export default {
  name: 'BookReader',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    node: { type: Object, required: true },
    content: { type: String, default: '' },
    contentLoaded: { type: Boolean, default: true },
    loadedRevId: { type: String, default: null },
    nodes: { type: Array, default: () => [] },
    mode: { type: String, default: 'read' },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    revisions: { type: Array, default: () => [] },
    saving: { type: Boolean, default: false },
    onSaveContent: { type: Function, default: null },
  },
  emits: [
    'save-content',
    'select-node',
    'request-ai-edit',
    'capture-canon',
    'finalize-node',
  ],
  data() {
    return {
      prefs: loadReaderPrefs(),
      prefsOpen: false,
      editing: false,
      draftText: this.content || '',
      dirty: false,
      editBaseRevId: null,
      conflictError: '',
      saveError: '',
      selectionBar: {
        visible: false,
        top: 0,
        left: 0,
        quote: '',
      },
      _scrollSaveTimer: null,
    };
  },
  computed: {
    renderedHtml() {
      const text = this.editing ? this.draftText : (this.content || '');
      if (!text.trim()) return '';
      return sanitizeCreationHtml(renderMarkdown(text));
    },
    bookUnits() {
      return (this.nodes || [])
        .filter((n) => n && !isFolderNode(n))
        .sort((a, b) => (a.sortOrder ?? a.position ?? a.order ?? 0) - (b.sortOrder ?? b.position ?? b.order ?? 0));
    },
    currentUnitIndex() {
      return this.bookUnits.findIndex((n) => n.id === this.node?.id);
    },
    prevUnit() {
      if (this.currentUnitIndex <= 0) return null;
      return this.bookUnits[this.currentUnitIndex - 1] || null;
    },
    nextUnit() {
      if (this.currentUnitIndex < 0 || this.currentUnitIndex >= this.bookUnits.length - 1) return null;
      return this.bookUnits[this.currentUnitIndex + 1] || null;
    },
    wordCount() {
      const text = this.editing ? this.draftText : (this.content || '');
      const trimmed = text.trim();
      if (!trimmed) return 0;
      const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) || []).length;
      const words = (trimmed.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
      return cjk + words;
    },
    stageSurfaceClass() {
      if (this.prefs.surface === 'sepia') return 'is-sepia';
      if (this.prefs.surface === 'night') return 'is-night';
      return 'is-paper';
    },
    proseStyle() {
      return {
        fontSize: `${this.prefs.fontSize}px`,
        lineHeight: String(this.prefs.lineHeight),
      };
    },
    scrollStorageKey() {
      if (!this.creationId || !this.node?.id) return '';
      return `yeaft_creation_book_scroll_${this.agentId || 'default'}:${this.creationId}:${this.node.id}`;
    },
  },
  watch: {
    content(newVal) {
      if (!this.editing || !this.dirty) {
        this.draftText = newVal || '';
        this.dirty = false;
        if (this.editing && this.contentLoaded) {
          this.editBaseRevId = this.loadedRevId;
        }
      }
    },
    loadedRevId(newRev) {
      if (this.editing && !this.dirty && this.contentLoaded) {
        this.editBaseRevId = newRev;
      }
    },
    'node.id'(newId, oldId) {
      if (oldId) this.syncStoreDirty(false, oldId);
      this.editing = false;
      this.draftText = this.content || '';
      this.dirty = false;
      this.editBaseRevId = null;
      this.conflictError = '';
      this.saveError = '';
      this.hideSelectionBar();
      this.$nextTick(() => this.restoreScrollPosition());
    },
  },
  mounted() {
    this.restoreScrollPosition();
    document.addEventListener('selectionchange', this.onSelectionChange);
  },
  beforeUnmount() {
    this.syncStoreDirty(false);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    if (this._scrollSaveTimer) clearTimeout(this._scrollSaveTimer);
  },
  methods: {
    syncStoreDirty(isDirty, nodeId = this.node?.id) {
      if (this.agentId && this.creationId && nodeId) {
        this.creationsStore.setNodeDirty(this.agentId, this.creationId, nodeId, isDirty);
      }
    },
    updatePref(key, value) {
      this.prefs = { ...this.prefs, [key]: value };
      saveReaderPrefs(this.prefs);
    },
    stepFontSize(delta) {
      const next = Math.min(21, Math.max(15, this.prefs.fontSize + delta));
      this.updatePref('fontSize', next);
    },
    stepLineHeight(delta) {
      const next = Math.round(Math.min(2.0, Math.max(1.6, this.prefs.lineHeight + delta)) * 10) / 10;
      this.updatePref('lineHeight', next);
    },
    surfaceLabelKey(s) {
      if (s === 'sepia') return 'creation.book.themeSepia';
      if (s === 'night') return 'creation.book.themeNight';
      return 'creation.book.themePaper';
    },
    enterEditMode() {
      if (!this.contentLoaded) return;
      this.hideSelectionBar();
      this.draftText = this.content || '';
      this.editBaseRevId = this.loadedRevId;
      this.conflictError = '';
      this.saveError = '';
      this.editing = true;
      this.dirty = false;
      this.syncStoreDirty(false);
      this.$nextTick(() => {
        this.autoResizeTextarea();
        const ta = this.$refs.editorTextarea;
        if (ta) ta.focus();
      });
    },
    cancelEditMode() {
      this.draftText = this.content || '';
      this.dirty = false;
      this.editBaseRevId = null;
      this.conflictError = '';
      this.saveError = '';
      this.editing = false;
      this.syncStoreDirty(false);
    },
    onEditorInput() {
      this.dirty = this.draftText !== (this.content || '');
      this.syncStoreDirty(this.dirty);
      this.autoResizeTextarea();
    },
    autoResizeTextarea() {
      const ta = this.$refs.editorTextarea;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(360, ta.scrollHeight)}px`;
    },
    async saveEdit(exitAfter = false) {
      this.conflictError = '';
      this.saveError = '';
      const targetAgentId = this.agentId;
      const targetCreationId = this.creationId;
      const targetNodeId = this.node.id;
      const submittedText = this.draftText;
      const payload = {
        nodeId: targetNodeId,
        content: submittedText,
        baseRevId: this.editBaseRevId,
      };
      const sameTarget = () => (
        this.agentId === targetAgentId
        && this.creationId === targetCreationId
        && this.node?.id === targetNodeId
      );
      if (this.onSaveContent) {
        try {
          const res = await this.onSaveContent(payload);
          if (res?.conflict === true) {
            if (sameTarget()) {
              this.conflictError = this.$t('creation.interior.conflictDesc');
            }
            return false;
          }
          const savedRevId = res?.node?.currentRevId ?? (sameTarget() ? this.loadedRevId : null) ?? payload.baseRevId;
          this._lastSavedRevId = savedRevId;
          if (!sameTarget()) return true;
          this.editBaseRevId = savedRevId;
          if (this.draftText === submittedText) {
            this.dirty = false;
            this.syncStoreDirty(false, targetNodeId);
            if (exitAfter) {
              this.editing = false;
            }
          }
          return true;
        } catch (err) {
          if (!sameTarget()) return false;
          if (err?.errorCode === 'revision_conflict') {
            this.conflictError = this.$t('creation.interior.conflictDesc');
          } else {
            this.saveError = err?.message || 'Save failed';
          }
          return false;
        }
      }
      this.$emit('save-content', payload);
      this._lastSavedRevId = this.editBaseRevId;
      this.dirty = false;
      this.syncStoreDirty(false, targetNodeId);
      if (exitAfter) {
        this.editing = false;
      }
      return true;
    },
    async finalizeChapter() {
      if (!this.contentLoaded) return;
      const targetNodeId = this.node.id;
      let baseRevId = this.loadedRevId;
      if (this.editing && this.dirty) {
        this._lastSavedRevId = null;
        const ok = await this.saveEdit(false);
        if (!ok) return;
        baseRevId = this._lastSavedRevId ?? baseRevId;
      }
      this.$emit('finalize-node', { nodeId: targetNodeId, baseRevId });
    },
    async onFinalize() {
      return this.finalizeChapter();
    },
    onProseMouseUp() {
      if (this.editing) return;
      this.$nextTick(() => this.evaluateSelection());
    },
    onSelectionChange() {
      if (this.editing || !this.selectionBar.visible) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        this.hideSelectionBar();
      }
    },
    evaluateSelection() {
      const proseEl = this.$refs.proseBody;
      const scrollEl = this.$refs.scrollContainer;
      if (!proseEl || !scrollEl) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        this.hideSelectionBar();
        return;
      }
      const quote = sel.toString().trim();
      if (!quote || quote.length < 2) {
        this.hideSelectionBar();
        return;
      }
      const range = sel.getRangeAt(0);
      if (!proseEl.contains(range.commonAncestorContainer)) {
        this.hideSelectionBar();
        return;
      }
      const rect = range.getBoundingClientRect();
      const containerRect = scrollEl.getBoundingClientRect();
      const top = Math.max(8, rect.top - containerRect.top + scrollEl.scrollTop - 44);
      const centerX = rect.left - containerRect.left + rect.width / 2;
      const left = Math.max(120, Math.min(containerRect.width - 120, centerX));
      this.selectionBar = {
        visible: true,
        top,
        left,
        quote: quote.slice(0, 600),
      };
    },
    hideSelectionBar() {
      if (this.selectionBar.visible) {
        this.selectionBar = { visible: false, top: 0, left: 0, quote: '' };
      }
    },
    triggerSelectionAiEdit() {
      const quote = this.selectionBar.quote;
      this.hideSelectionBar();
      if (!quote) return;
      const label = quote.length > 32 ? `${quote.slice(0, 32)}…` : quote;
      this.$emit('request-ai-edit', {
        anchor: {
          kind: 'text_selection',
          nodeId: this.node.id,
          quote,
          label,
        },
      });
    },
    triggerSelectionCaptureCanon() {
      const quote = this.selectionBar.quote;
      this.hideSelectionBar();
      if (!quote) return;
      this.$emit('capture-canon', {
        quote,
        nodeId: this.node.id,
        nodeTitle: this.node.title,
      });
    },
    onScroll() {
      const el = this.$refs.scrollContainer;
      const key = this.scrollStorageKey;
      if (!el || !key) return;
      const top = Math.round(el.scrollTop);
      if (this._scrollSaveTimer) clearTimeout(this._scrollSaveTimer);
      this._scrollSaveTimer = setTimeout(() => {
        try {
          localStorage.setItem(key, String(top));
        } catch {
          // ignore
        }
      }, 200);
    },
    restoreScrollPosition() {
      const el = this.$refs.scrollContainer;
      if (!el || !this.scrollStorageKey) return;
      try {
        const saved = Number(localStorage.getItem(this.scrollStorageKey));
        el.scrollTop = Number.isFinite(saved) && saved > 0 ? saved : 0;
      } catch {
        el.scrollTop = 0;
      }
    },
  },
  template: `
    <div class="creation-book-stage" :class="[stageSurfaceClass, { 'is-editing': editing }]">
      <!-- Book Reader Sub-Toolbar -->
      <div class="creation-reader-toolbar">
        <div class="creation-reader-meta">
          <span class="creation-status-pill" :class="'is-' + (node.status || 'draft')">
            {{ $t('creation.status.' + (node.status || 'draft')) }}
          </span>
          <span class="creation-reader-wordcount">{{ $t('creation.inspector.words', { count: wordCount }) }}</span>
          <span v-if="saving" class="creation-reader-saving">{{ $t('creation.interior.saving') }}</span>
        </div>

        <div class="creation-reader-actions">
          <!-- Appearance Popover -->
          <div class="creation-popover-wrap">
            <button
              type="button"
              class="creation-glass-btn"
              :class="{ 'is-active': prefsOpen }"
              :title="$t('creation.book.fontSize')"
              @click="prefsOpen = !prefsOpen"
            >
              Aa
            </button>
            <div v-if="prefsOpen" class="creation-appearance-popover" @click.stop>
              <div class="creation-pref-row">
                <span class="creation-pref-label">{{ $t('creation.book.fontSize') }}</span>
                <div class="creation-pref-stepper">
                  <button type="button" class="creation-icon-mini" :disabled="prefs.fontSize <= 15" @click="stepFontSize(-1)">A-</button>
                  <span class="creation-pref-val">{{ prefs.fontSize }}px</span>
                  <button type="button" class="creation-icon-mini" :disabled="prefs.fontSize >= 21" @click="stepFontSize(1)">A+</button>
                </div>
              </div>
              <div class="creation-pref-row">
                <span class="creation-pref-label">{{ $t('creation.book.lineHeight') }}</span>
                <div class="creation-pref-stepper">
                  <button type="button" class="creation-icon-mini" :disabled="prefs.lineHeight <= 1.6" @click="stepLineHeight(-0.1)">−</button>
                  <span class="creation-pref-val">{{ prefs.lineHeight.toFixed(1) }}</span>
                  <button type="button" class="creation-icon-mini" :disabled="prefs.lineHeight >= 2.0" @click="stepLineHeight(0.1)">+</button>
                </div>
              </div>
              <div class="creation-pref-row">
                <div class="creation-surface-pills">
                  <button
                    v-for="s in ['paper', 'sepia', 'night']"
                    :key="s"
                    type="button"
                    class="creation-glass-btn"
                    :class="{ 'is-primary': prefs.surface === s }"
                    @click="updatePref('surface', s)"
                  >
                    {{ $t(surfaceLabelKey(s)) }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Inline Light Edit / Save Controls -->
          <template v-if="!editing">
            <button type="button" class="creation-glass-btn" :disabled="!contentLoaded" @click="enterEditMode">
              ✎ {{ $t('creation.book.inlineEdit') }}
            </button>
            <button
              type="button"
              class="creation-glass-btn"
              @click="$emit('request-ai-edit', { anchor: { kind: 'unit', nodeId: node.id, label: node.title } })"
            >
              ✦ {{ $t('creation.book.selectionAi') }}
            </button>
          </template>
          <template v-else>
            <button type="button" class="creation-glass-btn is-primary" :disabled="saving" @click="saveEdit(false)">
              {{ $t('creation.interior.save') }}
            </button>
            <button type="button" class="creation-glass-btn" :disabled="saving" @click="saveEdit(true)">
              {{ $t('creation.book.doneEdit') }}
            </button>
            <button type="button" class="creation-glass-btn" @click="cancelEditMode">
              {{ $t('creation.canon.dismiss') }}
            </button>
          </template>

          <button
            v-if="node.status !== 'final'"
            type="button"
            class="creation-glass-btn"
            :disabled="saving || !contentLoaded"
            @click="onFinalize"
          >
            ✓ {{ $t('creation.status.final') }}
          </button>
        </div>
      </div>

      <!-- Conflict / Save Error Banner -->
      <div v-if="conflictError || saveError" class="creation-conflict-banner" role="alert">
        <strong>⚠ {{ conflictError ? $t('creation.interior.conflictTitle') : saveError }}</strong>
        <span v-if="conflictError">{{ conflictError }}</span>
        <button type="button" class="creation-glass-btn" @click="conflictError = ''; saveError = ''">
          {{ $t('creation.canon.dismiss') }}
        </button>
      </div>

      <!-- Reading / Editing Column -->
      <div
        ref="scrollContainer"
        class="creation-book-scroll"
        @scroll="onScroll"
        @click="prefsOpen = false"
      >
        <!-- Text Selection Floating Action Bar -->
        <div
          v-if="selectionBar.visible && !editing"
          class="creation-selection-toolbar"
          :style="{ top: selectionBar.top + 'px', left: selectionBar.left + 'px' }"
          @mousedown.prevent
        >
          <button type="button" class="creation-glass-btn" :disabled="!contentLoaded" @click="enterEditMode">
            ✎ {{ $t('creation.book.selectionEdit') }}
          </button>
          <button type="button" class="creation-glass-btn is-primary" @click="triggerSelectionAiEdit">
            ✦ {{ $t('creation.book.selectionAi') }}
          </button>
          <button type="button" class="creation-glass-btn" @click="triggerSelectionCaptureCanon">
            📌 {{ $t('creation.book.selectionCanon') }}
          </button>
        </div>

        <article class="creation-book-prose">
          <header class="creation-book-header">
            <h1 class="creation-book-title">{{ node.title }}</h1>
            <p v-if="node.summary && !editing" class="creation-book-summary">{{ node.summary }}</p>
          </header>

          <div
            v-if="!editing"
            ref="proseBody"
            class="creation-book-body"
            :style="proseStyle"
            @mouseup="onProseMouseUp"
            @dblclick="enterEditMode"
          >
            <div v-if="renderedHtml" class="markdown-body" v-html="renderedHtml"></div>
            <div v-else class="creation-book-empty">
              <p>{{ $t('creation.book.emptyChapter') }}</p>
              <div class="creation-book-empty-actions">
                <button type="button" class="creation-glass-btn" :disabled="!contentLoaded" @click="enterEditMode">
                  ✎ {{ $t('creation.book.inlineEdit') }}
                </button>
                <button
                  type="button"
                  class="creation-glass-btn is-primary"
                  @click="$emit('request-ai-edit', { anchor: { kind: 'unit', nodeId: node.id, label: node.title } })"
                >
                  ✦ {{ $t('creation.book.askAiToWrite') }}
                </button>
              </div>
            </div>
          </div>

          <div v-else class="creation-book-editor-wrap">
            <textarea
              ref="editorTextarea"
              v-model="draftText"
              class="creation-book-textarea"
              :style="proseStyle"
              :disabled="!contentLoaded && !dirty"
              :placeholder="$t('creation.book.anchorPlaceholder')"
              @input="onEditorInput"
              @keydown.meta.s.prevent="saveEdit(false)"
              @keydown.ctrl.s.prevent="saveEdit(false)"
            ></textarea>
          </div>

          <!-- Prev / Next Chapter Navigation -->
          <footer v-if="prevUnit || nextUnit" class="creation-book-footer">
            <button
              v-if="prevUnit"
              type="button"
              class="creation-glass-btn"
              @click="$emit('select-node', prevUnit.id)"
            >
              ← {{ $t('creation.book.prevChapter') }}: {{ prevUnit.title }}
            </button>
            <span v-else></span>

            <button
              v-if="nextUnit"
              type="button"
              class="creation-glass-btn"
              @click="$emit('select-node', nextUnit.id)"
            >
              {{ $t('creation.book.nextChapter') }}: {{ nextUnit.title }} →
            </button>
          </footer>
        </article>
      </div>
    </div>
  `,
};
