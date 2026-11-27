/**
 * Yeaft Cosmos Creations — GalleryReader (image_gallery modality)
 *
 * Parses structured gallery JSON with graceful fallback.
 * Wired to creationsStore.mediaUrl and creationsStore.uploadSources(agentId, creationId, files).
 */
import { useCreationsStore } from '../../../../stores/creations.js';

function makeFrameId() {
  return `frame_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeFrame(raw, idx) {
  const normalized = {
    frameId: raw?.frameId || raw?.id || makeFrameId(),
    title: typeof raw?.title === 'string' ? raw.title : `Frame ${idx + 1}`,
    caption: typeof raw?.caption === 'string' ? raw.caption : '',
    assetId: raw?.assetId || '',
    sourceId: raw?.sourceId || '',
    prompt: typeof raw?.prompt === 'string' ? raw.prompt : '',
    tags: Array.isArray(raw?.tags) ? raw.tags.map((t) => String(t)) : [],
  };
  if (typeof raw?.svgMarkup === 'string' && raw.svgMarkup.length > 0) {
    normalized.svgMarkup = raw.svgMarkup;
  }
  return normalized;
}

function parseGalleryContent(content) {
  const raw = String(content || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.frames)) {
        return { frames: parsed.frames.map((f, i) => normalizeFrame(f, i)) };
      }
    } catch {
      return {
        frames: [normalizeFrame({ title: 'Frame 1', caption: '', prompt: raw }, 0)],
      };
    }
  }
  return { frames: [] };
}

export default {
  name: 'GalleryReader',
  setup() {
    const creationsStore = useCreationsStore();
    return { creationsStore };
  },
  props: {
    node: { type: Object, required: true },
    content: { type: String, default: '' },
    contentLoaded: { type: Boolean, default: true },
    loadedRevId: { type: String, default: null },
    mode: { type: String, default: 'read' },
    agentId: { type: String, default: '' },
    creationId: { type: String, default: '' },
    saving: { type: Boolean, default: false },
    onSaveContent: { type: Function, default: null },
  },
  emits: ['save-content', 'request-ai-edit', 'finalize-node'],
  data() {
    return {
      gallery: parseGalleryContent(this.content),
      editing: false,
      dirty: false,
      editBaseRevId: this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null),
      conflictError: '',
      saveError: '',
      lightboxIndex: -1,
      zoomLevel: 1,
      uploading: false,
    };
  },
  computed: {
    frames() {
      return this.gallery.frames || [];
    },
    lightboxFrame() {
      if (this.lightboxIndex < 0 || this.lightboxIndex >= this.frames.length) return null;
      return this.frames[this.lightboxIndex];
    },
  },
  watch: {
    content(newVal) {
      if (!this.dirty) {
        this.gallery = parseGalleryContent(newVal);
        this.editBaseRevId = this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null);
      }
    },
    'node.id'(newId, oldId) {
      if (oldId) this.syncStoreDirty(false, oldId);
      this.gallery = parseGalleryContent(this.content);
      this.dirty = false;
      this.editing = false;
      this.editBaseRevId = this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null);
      this.conflictError = '';
      this.saveError = '';
      this.lightboxIndex = -1;
      this.zoomLevel = 1;
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onKeyDown);
  },
  beforeUnmount() {
    this._unmounted = true;
    this.syncStoreDirty(false);
    window.removeEventListener('keydown', this.onKeyDown);
  },
  methods: {
    syncStoreDirty(isDirty, nodeId = this.node?.id) {
      if (this.agentId && this.creationId && nodeId) {
        this.creationsStore.setNodeDirty(this.agentId, this.creationId, nodeId, isDirty);
      }
    },
    frameImageUrl(frame) {
      if (!frame) return '';
      if (frame.assetId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'asset', frame.assetId);
      }
      if (frame.sourceId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'source', frame.sourceId);
      }
      return '';
    },
    toggleEditing() {
      if (!this.editing) {
        if (!this.contentLoaded) return;
        if (!this.dirty) {
          this.editBaseRevId = this.loadedRevId;
          this.conflictError = '';
          this.saveError = '';
        }
        this.editing = true;
        this.syncStoreDirty(this.dirty);
        return;
      }
      this.editing = false;
      if (!this.dirty) {
        this.syncStoreDirty(false);
      }
    },
    openLightbox(idx) {
      this.lightboxIndex = idx;
      this.zoomLevel = 1;
    },
    closeLightbox() {
      this.lightboxIndex = -1;
      this.zoomLevel = 1;
    },
    stepLightbox(delta) {
      if (this.frames.length === 0) return;
      this.lightboxIndex = (this.lightboxIndex + delta + this.frames.length) % this.frames.length;
      this.zoomLevel = 1;
    },
    setZoom(level) {
      this.zoomLevel = level;
    },
    onKeyDown(e) {
      if (this.lightboxIndex < 0) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.closeLightbox();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        this.stepLightbox(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        this.stepLightbox(-1);
      }
    },
    canMutate() {
      return Boolean(this.contentLoaded || this.dirty);
    },
    markDirty() {
      if (!this.canMutate()) return;
      if (!this.dirty) {
        this.editBaseRevId = this.loadedRevId;
      }
      this.dirty = true;
      this.syncStoreDirty(true);
    },
    addEmptyFrame() {
      if (!this.canMutate()) return;
      this.markDirty();
      this.gallery.frames.push(normalizeFrame({
        title: `#${this.frames.length + 1}`,
        caption: '',
        prompt: '',
      }, this.frames.length));
      this.editing = true;
    },
    async onUploadImage(e) {
      const files = Array.from(e.target?.files || []);
      if (e.target) e.target.value = '';
      if (!files.length || !this.canMutate()) return;
      const targetAgentId = this.agentId;
      const targetCreationId = this.creationId;
      const targetNodeId = this.node?.id || '';
      if (!targetNodeId) return;
      this.uploading = true;
      try {
        const res = await this.creationsStore.uploadSources(targetAgentId, targetCreationId, files, []);
        if (
          this._unmounted
          || this.agentId !== targetAgentId
          || this.creationId !== targetCreationId
          || this.node?.id !== targetNodeId
          || !this.canMutate()
        ) {
          return;
        }
        const added = Array.isArray(res?.sources) ? res.sources : (res?.source ? [res.source] : []);
        for (const src of added) {
          if (src && src.id) {
            this.markDirty();
            this.gallery.frames.push(normalizeFrame({
              title: (src.name || src.filename || 'Image').replace(/\.[^.]+$/, ''),
              caption: '',
              sourceId: src.id,
            }, this.frames.length));
          }
        }
        if (this.dirty && this.node?.id === targetNodeId) await this.saveGallery();
      } finally {
        this.uploading = false;
      }
    },
    moveFrame(idx, delta) {
      if (!this.canMutate()) return;
      const target = idx + delta;
      if (target < 0 || target >= this.frames.length) return;
      this.markDirty();
      const [item] = this.gallery.frames.splice(idx, 1);
      this.gallery.frames.splice(target, 0, item);
    },
    deleteFrame(idx) {
      if (!this.canMutate()) return;
      this.markDirty();
      this.gallery.frames.splice(idx, 1);
      if (this.lightboxIndex === idx) this.closeLightbox();
      else if (this.lightboxIndex > idx) this.lightboxIndex -= 1;
    },
    async saveGallery() {
      this.conflictError = '';
      this.saveError = '';
      const targetAgentId = this.agentId;
      const targetCreationId = this.creationId;
      const targetNodeId = this.node.id;
      const submittedContent = JSON.stringify({ frames: this.frames }, null, 2);
      const payload = {
        nodeId: targetNodeId,
        content: submittedContent,
        baseRevId: this.editBaseRevId,
      };
      const sameTarget = () => (
        !this._unmounted
        && this.agentId === targetAgentId
        && this.creationId === targetCreationId
        && this.node?.id === targetNodeId
      );
      if (this.onSaveContent) {
        try {
          const res = await this.onSaveContent(payload);
          if (!sameTarget()) return res?.conflict !== true;
          if (res?.conflict === true) {
            this.conflictError = this.$t('creation.interior.conflictDesc');
            return false;
          }
          this.editBaseRevId = res?.node?.currentRevId ?? this.loadedRevId ?? this.editBaseRevId;
          const stillMatchesSubmitted = JSON.stringify({ frames: this.frames }, null, 2) === submittedContent;
          if (stillMatchesSubmitted) {
            this.dirty = false;
            this.syncStoreDirty(false, targetNodeId);
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
      this.dirty = false;
      this.syncStoreDirty(false, targetNodeId);
      return true;
    },
    requestAiRedraw(frame, idx) {
      this.$emit('request-ai-edit', {
        anchor: {
          kind: 'frame',
          nodeId: this.node.id,
          frameId: frame.frameId,
          label: `#${idx + 1} ${frame.title || ''}`.trim(),
        },
      });
    },
  },
  template: `
    <div class="creation-gallery-reader">
      <!-- Top Toolbar -->
      <div class="creation-reader-toolbar">
        <div class="creation-reader-meta">
          <span class="creation-gallery-count">{{ $t('creation.gallery.grid') }} ({{ frames.length }})</span>
          <span v-if="saving" class="creation-reader-saving">{{ $t('creation.interior.saving') }}</span>
        </div>

        <div class="creation-reader-actions">
          <label class="creation-glass-btn creation-upload-label" :class="{ 'is-disabled': uploading || !canMutate() }">
            <input type="file" accept="image/*" multiple hidden :disabled="uploading || !canMutate()" @change="onUploadImage" />
            <span>+ {{ $t('creation.gallery.uploadImage') }}</span>
          </label>

          <button type="button" class="creation-glass-btn" :disabled="!canMutate()" @click="addEmptyFrame">
            + {{ $t('creation.gallery.addFrame') }}
          </button>

          <button
            type="button"
            class="creation-glass-btn"
            :class="{ 'is-active': editing }"
            :disabled="!editing && !contentLoaded"
            @click="toggleEditing"
          >
            ✎ {{ editing ? $t('creation.book.doneEdit') : $t('creation.book.inlineEdit') }}
          </button>

          <button
            v-if="dirty"
            type="button"
            class="creation-glass-btn is-primary"
            :disabled="saving"
            @click="saveGallery"
          >
            {{ $t('creation.interior.save') }}
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

      <!-- Gallery Grid -->
      <div class="creation-gallery-scroll">
        <div v-if="frames.length === 0" class="creation-gallery-empty">
          <p>{{ $t('creation.gallery.emptyGallery') }}</p>
          <div class="creation-book-empty-actions">
            <button type="button" class="creation-glass-btn" @click="addEmptyFrame">
              + {{ $t('creation.gallery.addFrame') }}
            </button>
            <button
              type="button"
              class="creation-glass-btn is-primary"
              @click="$emit('request-ai-edit', { anchor: { kind: 'unit', nodeId: node.id, label: node.title } })"
            >
              ✦ {{ $t('creation.gallery.aiRedrawFrame') }}
            </button>
          </div>
        </div>

        <div v-else class="creation-gallery-grid">
          <article v-for="(frame, idx) in frames" :key="frame.frameId" class="creation-gallery-frame">
            <div class="creation-gallery-media" @click="openLightbox(idx)">
              <img
                v-if="frameImageUrl(frame)"
                :src="frameImageUrl(frame)"
                :alt="frame.title || frame.caption"
                loading="lazy"
                class="creation-gallery-img"
              />
              <div v-else class="creation-gallery-placeholder">
                <span class="creation-gallery-placeholder-prompt">{{ frame.prompt || $t('creation.gallery.captionPlaceholder') }}</span>
              </div>
              <span class="creation-gallery-badge">#{{ idx + 1 }}</span>
            </div>

            <div class="creation-gallery-card-body">
              <template v-if="editing && canMutate()">
                <input
                  v-model="frame.title"
                  class="creation-inline-input"
                  :placeholder="$t('creation.deck.titlePlaceholder')"
                  @input="markDirty"
                />
                <textarea
                  v-model="frame.caption"
                  class="creation-inline-textarea"
                  rows="2"
                  :placeholder="$t('creation.gallery.captionPlaceholder')"
                  @input="markDirty"
                ></textarea>
              </template>
              <template v-else>
                <h3 class="creation-gallery-title">{{ frame.title }}</h3>
                <p v-if="frame.caption" class="creation-gallery-caption">{{ frame.caption }}</p>
              </template>

              <div class="creation-gallery-card-actions">
                <button type="button" class="creation-glass-btn" @click="requestAiRedraw(frame, idx)">
                  ✦ {{ $t('creation.gallery.aiRedrawFrame') }}
                </button>
                <div class="creation-gallery-reorder">
                  <button type="button" class="creation-icon-mini" :disabled="!canMutate() || idx === 0" @click="moveFrame(idx, -1)">↑</button>
                  <button type="button" class="creation-icon-mini" :disabled="!canMutate() || idx === frames.length - 1" @click="moveFrame(idx, 1)">↓</button>
                  <button type="button" class="creation-icon-mini is-danger" :disabled="!canMutate()" @click="deleteFrame(idx)">×</button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>

      <!-- Immersive Lightbox Modal -->
      <div v-if="lightboxFrame" class="creation-gallery-lightbox" role="dialog" aria-modal="true" @click.self="closeLightbox">
        <header class="creation-lightbox-bar">
          <div class="creation-lightbox-info">
            <span class="creation-lightbox-counter">{{ lightboxIndex + 1 }} / {{ frames.length }}</span>
            <span class="creation-lightbox-title">{{ lightboxFrame.title }}</span>
          </div>
          <div class="creation-lightbox-controls">
            <button
              v-for="z in [1, 1.5, 2]"
              :key="z"
              type="button"
              class="creation-glass-btn"
              :class="{ 'is-active': zoomLevel === z }"
              @click="setZoom(z)"
            >
              {{ z }}x
            </button>
            <button type="button" class="creation-glass-btn" @click="requestAiRedraw(lightboxFrame, lightboxIndex)">
              ✦ {{ $t('creation.gallery.aiRedrawFrame') }}
            </button>
            <button type="button" class="creation-glass-btn" @click="closeLightbox">✕</button>
          </div>
        </header>

        <div class="creation-lightbox-stage">
          <button v-if="frames.length > 1" type="button" class="creation-lightbox-nav is-prev" @click="stepLightbox(-1)">‹</button>
          <div class="creation-lightbox-viewport">
            <img
              v-if="frameImageUrl(lightboxFrame)"
              :src="frameImageUrl(lightboxFrame)"
              :alt="lightboxFrame.title"
              class="creation-lightbox-img"
              :style="{ transform: 'scale(' + zoomLevel + ')' }"
            />
            <div v-else class="creation-lightbox-placeholder">
              {{ lightboxFrame.prompt || $t('creation.gallery.captionPlaceholder') }}
            </div>
          </div>
          <button v-if="frames.length > 1" type="button" class="creation-lightbox-nav is-next" @click="stepLightbox(1)">›</button>
        </div>

        <footer v-if="lightboxFrame.caption || lightboxFrame.prompt" class="creation-lightbox-footer">
          <p v-if="lightboxFrame.caption" class="creation-lightbox-caption">{{ lightboxFrame.caption }}</p>
          <p v-if="lightboxFrame.prompt" class="creation-lightbox-prompt">{{ lightboxFrame.prompt }}</p>
        </footer>
      </div>
    </div>
  `,
};
