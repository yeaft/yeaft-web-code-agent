/**
 * Yeaft Cosmos Creations — DeckReader (slide_deck modality)
 *
 * Parses structured slide deck JSON with graceful Markdown/empty fallback.
 * Uses exact CSS classes from web/styles/cosmos/creations.css and i18n keys from web/i18n/creations.js.
 */
import { useCreationsStore } from '../../../../stores/creations.js';

const SLIDE_LAYOUTS = ['title', 'bullets', 'two_column', 'quote', 'image_focus'];

function makeSlideId() {
  return `slide_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeSlide(raw, idx) {
  const layout = SLIDE_LAYOUTS.includes(raw?.layout) ? raw.layout : (idx === 0 ? 'title' : 'bullets');
  return {
    slideId: raw?.slideId || raw?.id || makeSlideId(),
    layout,
    title: typeof raw?.title === 'string' ? raw.title : `Slide ${idx + 1}`,
    subtitle: typeof raw?.subtitle === 'string' ? raw.subtitle : '',
    bullets: Array.isArray(raw?.bullets) ? raw.bullets.map((b) => String(b)) : [],
    body: typeof raw?.body === 'string' ? raw.body : '',
    imageAssetId: raw?.imageAssetId || '',
    imageSourceId: raw?.imageSourceId || '',
    speakerNotes: typeof raw?.speakerNotes === 'string' ? raw.speakerNotes : '',
  };
}

function parseDeckContent(content, fallbackTitle) {
  const raw = String(content || '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
        return {
          theme: parsed.theme || 'minimal',
          slides: parsed.slides.map((s, i) => normalizeSlide(s, i)),
        };
      }
    } catch {
      const chunks = raw.split(/\n---+\n/).map((s) => s.trim()).filter(Boolean);
      if (chunks.length > 0) {
        return {
          theme: 'minimal',
          slides: chunks.map((chunk, idx) => {
            const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
            const heading = (lines[0] || '').replace(/^#+\s*/, '') || `Slide ${idx + 1}`;
            const rest = lines.slice(1);
            const bullets = rest.filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, ''));
            const bodyLines = rest.filter((l) => !/^[-*•]\s+/.test(l));
            return normalizeSlide({
              layout: idx === 0 && bullets.length === 0 ? 'title' : 'bullets',
              title: heading,
              subtitle: idx === 0 ? bodyLines.join(' ') : '',
              bullets,
              body: idx === 0 ? '' : bodyLines.join('\n'),
            }, idx);
          }),
        };
      }
    }
  }
  return {
    theme: 'minimal',
    slides: [
      normalizeSlide({
        layout: 'title',
        title: fallbackTitle || 'Untitled Deck',
        subtitle: '',
        bullets: [],
        body: '',
        speakerNotes: '',
      }, 0),
    ],
  };
}

export default {
  name: 'DeckReader',
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
    const deck = parseDeckContent(this.content, this.node?.title);
    return {
      deck,
      activeIndex: 0,
      editing: false,
      dirty: false,
      editBaseRevId: this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null),
      conflictError: '',
      saveError: '',
      notesOpen: true,
      isFullscreen: false,
      layouts: SLIDE_LAYOUTS,
    };
  },
  computed: {
    slides() {
      return this.deck.slides || [];
    },
    activeSlide() {
      return this.slides[this.activeIndex] || this.slides[0] || null;
    },
    activeSlideImageUrl() {
      const s = this.activeSlide;
      if (!s) return '';
      if (s.imageAssetId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'asset', s.imageAssetId);
      }
      if (s.imageSourceId) {
        return this.creationsStore.mediaUrl(this.agentId, this.creationId, 'source', s.imageSourceId);
      }
      return '';
    },
    bulletsText: {
      get() {
        return (this.activeSlide?.bullets || []).join('\n');
      },
      set(val) {
        if (!this.activeSlide) return;
        this.markDirty();
        this.activeSlide.bullets = String(val || '').split('\n');
      },
    },
  },
  watch: {
    content(newVal) {
      if (!this.dirty) {
        this.deck = parseDeckContent(newVal, this.node?.title);
        this.editBaseRevId = this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null);
        if (this.activeIndex >= this.deck.slides.length) {
          this.activeIndex = Math.max(0, this.deck.slides.length - 1);
        }
      }
    },
    'node.id'(newId, oldId) {
      if (oldId) this.syncStoreDirty(false, oldId);
      this.deck = parseDeckContent(this.content, this.node?.title);
      this.activeIndex = 0;
      this.dirty = false;
      this.editing = false;
      this.editBaseRevId = this.contentLoaded ? this.loadedRevId : (this.loadedRevId ?? this.node?.currentRevId ?? null);
      this.conflictError = '';
      this.saveError = '';
    },
  },
  mounted() {
    window.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  },
  beforeUnmount() {
    this.syncStoreDirty(false);
    window.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
  },
  methods: {
    syncStoreDirty(isDirty, nodeId = this.node?.id) {
      if (this.agentId && this.creationId && nodeId) {
        this.creationsStore.setNodeDirty(this.agentId, this.creationId, nodeId, isDirty);
      }
    },
    onKeyDown(e) {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        if (this.activeIndex < this.slides.length - 1) {
          e.preventDefault();
          this.activeIndex += 1;
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        if (this.activeIndex > 0) {
          e.preventDefault();
          this.activeIndex -= 1;
        }
      }
    },
    onFullscreenChange() {
      this.isFullscreen = Boolean(document.fullscreenElement);
    },
    toggleFullscreen() {
      const stage = this.$refs.stageWrap;
      if (!stage) return;
      if (!document.fullscreenElement) {
        stage.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.().catch(() => {});
      }
    },
    startEditing() {
      if (!this.contentLoaded) return;
      if (!this.editing && !this.dirty) {
        this.editBaseRevId = this.loadedRevId;
        this.conflictError = '';
        this.saveError = '';
      }
      this.editing = true;
      this.syncStoreDirty(true);
    },
    toggleEditing() {
      if (!this.editing) {
        this.startEditing();
        return;
      }
      this.editing = false;
      if (!this.dirty) {
        this.syncStoreDirty(false);
      }
    },
    markDirty() {
      if (!this.contentLoaded) return;
      if (!this.dirty) {
        this.editBaseRevId = this.loadedRevId;
      }
      this.dirty = true;
      this.syncStoreDirty(true);
    },
    addSlide() {
      if (!this.contentLoaded) return;
      this.markDirty();
      const next = normalizeSlide({
        layout: 'bullets',
        title: `#${this.slides.length + 1}`,
        bullets: [''],
      }, this.slides.length);
      this.deck.slides.splice(this.activeIndex + 1, 0, next);
      this.activeIndex += 1;
      this.editing = true;
    },
    deleteSlide(idx) {
      if (this.slides.length <= 1) return;
      this.markDirty();
      this.deck.slides.splice(idx, 1);
      if (this.activeIndex >= this.deck.slides.length) {
        this.activeIndex = this.deck.slides.length - 1;
      }
    },
    moveSlide(idx, delta) {
      const target = idx + delta;
      if (target < 0 || target >= this.slides.length) return;
      this.markDirty();
      const [item] = this.deck.slides.splice(idx, 1);
      this.deck.slides.splice(target, 0, item);
      if (this.activeIndex === idx) this.activeIndex = target;
      else if (this.activeIndex === target) this.activeIndex = idx;
    },
    async saveDeck() {
      this.conflictError = '';
      this.saveError = '';
      const cleanDeck = {
        theme: this.deck.theme || 'minimal',
        slides: this.slides.map((s) => ({
          ...s,
          bullets: (s.bullets || []).map((b) => String(b).trim()).filter(Boolean),
        })),
      };
      const payload = {
        nodeId: this.node.id,
        content: JSON.stringify(cleanDeck, null, 2),
        baseRevId: this.editBaseRevId,
      };
      if (this.onSaveContent) {
        try {
          const res = await this.onSaveContent(payload);
          if (res?.conflict === true) {
            this.conflictError = this.$t('creation.interior.conflictDesc');
            return false;
          }
          this.editBaseRevId = res?.node?.currentRevId ?? this.loadedRevId ?? this.editBaseRevId;
          this.dirty = false;
          this.syncStoreDirty(false, payload.nodeId);
          return true;
        } catch (err) {
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
      this.syncStoreDirty(false, payload.nodeId);
      return true;
    },
    requestAiRemake() {
      const s = this.activeSlide;
      if (!s) return;
      this.$emit('request-ai-edit', {
        anchor: {
          kind: 'slide',
          nodeId: this.node.id,
          slideId: s.slideId,
          label: `#${this.activeIndex + 1} ${s.title || ''}`.trim(),
        },
      });
    },
  },
  template: `
    <div class="creation-deck-reader">
      <!-- Top Toolbar -->
      <div class="creation-reader-toolbar">
        <div class="creation-reader-meta">
          <span class="creation-deck-counter">
            {{ $t('creation.deck.slideOf', { current: activeIndex + 1, total: slides.length }) }}
          </span>
          <span v-if="saving" class="creation-reader-saving">{{ $t('creation.interior.saving') }}</span>
        </div>

        <div class="creation-reader-actions">
          <select
            v-if="activeSlide && editing"
            v-model="activeSlide.layout"
            class="creation-compact-select"
            @change="markDirty"
          >
            <option v-for="l in layouts" :key="l" :value="l">{{ l }}</option>
          </select>

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
            @click="saveDeck"
          >
            {{ $t('creation.interior.save') }}
          </button>

          <button type="button" class="creation-glass-btn" @click="requestAiRemake">
            ✦ {{ $t('creation.deck.aiEditSlide') }}
          </button>

          <button type="button" class="creation-glass-btn" @click="toggleFullscreen">
            {{ isFullscreen ? $t('creation.deck.exitFullscreen') : $t('creation.deck.fullscreen') }}
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

      <!-- Main Deck Workspace -->
      <div class="creation-deck-body">
        <!-- Left Thumbnail Filmstrip -->
        <aside class="creation-deck-strip">
          <div class="creation-deck-filmstrip-list">
            <div
              v-for="(slide, idx) in slides"
              :key="slide.slideId"
              class="creation-deck-thumb"
              :class="{ 'is-active': idx === activeIndex }"
              @click="activeIndex = idx"
            >
              <span class="creation-deck-thumb-num">{{ idx + 1 }}</span>
              <div class="creation-deck-thumb-preview">
                <div class="creation-deck-thumb-title">{{ slide.title || '#' + (idx + 1) }}</div>
                <div class="creation-deck-thumb-meta">{{ slide.layout }}</div>
              </div>
              <div class="creation-deck-thumb-controls" @click.stop>
                <button type="button" class="creation-icon-mini" :disabled="idx === 0" @click="moveSlide(idx, -1)">↑</button>
                <button type="button" class="creation-icon-mini" :disabled="idx === slides.length - 1" @click="moveSlide(idx, 1)">↓</button>
                <button
                  type="button"
                  class="creation-icon-mini is-danger"
                  :disabled="slides.length <= 1"
                  :title="$t('creation.deck.deleteSlide')"
                  @click="deleteSlide(idx)"
                >×</button>
              </div>
            </div>
          </div>

          <button type="button" class="creation-glass-btn" :disabled="!contentLoaded" @click="addSlide">
            + {{ $t('creation.deck.addSlide') }}
          </button>
        </aside>

        <!-- Center Stage + Speaker Notes -->
        <div class="creation-deck-main">
          <div ref="stageWrap" class="creation-deck-stage">
            <div v-if="activeSlide" class="creation-deck-slide" :class="'is-layout-' + activeSlide.layout">
              <template v-if="activeSlide.layout === 'title'">
                <div class="creation-slide-center">
                  <input
                    v-if="editing"
                    v-model="activeSlide.title"
                    class="creation-slide-input is-title"
                    :placeholder="$t('creation.deck.titlePlaceholder')"
                    @input="markDirty"
                  />
                  <h1 v-else class="creation-slide-title" @click="startEditing">{{ activeSlide.title }}</h1>

                  <input
                    v-if="editing"
                    v-model="activeSlide.subtitle"
                    class="creation-slide-input is-subtitle"
                    :placeholder="$t('creation.deck.bulletPlaceholder')"
                    @input="markDirty"
                  />
                  <p v-else-if="activeSlide.subtitle" class="creation-slide-subtitle" @click="startEditing">{{ activeSlide.subtitle }}</p>
                </div>
              </template>

              <template v-else-if="activeSlide.layout === 'quote'">
                <div class="creation-slide-center">
                  <textarea
                    v-if="editing"
                    v-model="activeSlide.body"
                    class="creation-slide-textarea is-quote"
                    :placeholder="$t('creation.deck.bulletPlaceholder')"
                    @input="markDirty"
                  ></textarea>
                  <blockquote v-else class="creation-slide-quote" @click="startEditing">
                    {{ activeSlide.body || activeSlide.title }}
                  </blockquote>
                  <input
                    v-if="editing"
                    v-model="activeSlide.subtitle"
                    class="creation-slide-input is-subtitle"
                    @input="markDirty"
                  />
                  <cite v-else-if="activeSlide.subtitle" class="creation-slide-cite" @click="startEditing">— {{ activeSlide.subtitle }}</cite>
                </div>
              </template>

              <template v-else-if="activeSlide.layout === 'two_column'">
                <input v-if="editing" v-model="activeSlide.title" class="creation-slide-input is-heading" @input="markDirty" />
                <h2 v-else class="creation-slide-heading" @click="startEditing">{{ activeSlide.title }}</h2>
                <div class="creation-slide-two-col">
                  <div class="creation-slide-col">
                    <textarea v-if="editing" v-model="bulletsText" class="creation-slide-textarea" :placeholder="$t('creation.deck.bulletPlaceholder')"></textarea>
                    <ul v-else class="creation-slide-bullets" @click="startEditing">
                      <li v-for="(b, bi) in activeSlide.bullets" :key="bi">{{ b }}</li>
                    </ul>
                  </div>
                  <div class="creation-slide-col">
                    <textarea v-if="editing" v-model="activeSlide.body" class="creation-slide-textarea" @input="markDirty"></textarea>
                    <div v-else class="creation-slide-body" @click="startEditing">
                      <img v-if="activeSlideImageUrl" :src="activeSlideImageUrl" :alt="activeSlide.title" class="creation-slide-img" />
                      <p v-if="activeSlide.body">{{ activeSlide.body }}</p>
                    </div>
                  </div>
                </div>
              </template>

              <template v-else-if="activeSlide.layout === 'image_focus'">
                <input v-if="editing" v-model="activeSlide.title" class="creation-slide-input is-heading" @input="markDirty" />
                <h2 v-else class="creation-slide-heading" @click="startEditing">{{ activeSlide.title }}</h2>
                <div class="creation-slide-image-stage">
                  <img v-if="activeSlideImageUrl" :src="activeSlideImageUrl" :alt="activeSlide.title" class="creation-slide-img-hero" />
                  <div v-else class="creation-slide-img-placeholder">
                    <span>{{ activeSlide.body || $t('creation.deck.emptyDeck') }}</span>
                  </div>
                </div>
                <input v-if="editing" v-model="activeSlide.subtitle" class="creation-slide-input is-caption" @input="markDirty" />
                <p v-else-if="activeSlide.subtitle" class="creation-slide-caption">{{ activeSlide.subtitle }}</p>
              </template>

              <template v-else>
                <input v-if="editing" v-model="activeSlide.title" class="creation-slide-input is-heading" @input="markDirty" />
                <h2 v-else class="creation-slide-heading" @click="startEditing">{{ activeSlide.title }}</h2>
                <textarea v-if="editing" v-model="bulletsText" class="creation-slide-textarea" :placeholder="$t('creation.deck.bulletPlaceholder')"></textarea>
                <ul v-else-if="activeSlide.bullets.length" class="creation-slide-bullets" @click="startEditing">
                  <li v-for="(b, bi) in activeSlide.bullets" :key="bi">{{ b }}</li>
                </ul>
                <p v-else class="creation-slide-body" @click="startEditing">{{ activeSlide.body }}</p>
              </template>
            </div>

            <div class="creation-deck-nav-bar">
              <button type="button" class="creation-glass-btn" :disabled="activeIndex <= 0" @click="activeIndex--">←</button>
              <span>{{ activeIndex + 1 }} / {{ slides.length }}</span>
              <button type="button" class="creation-glass-btn" :disabled="activeIndex >= slides.length - 1" @click="activeIndex++">→</button>
            </div>
          </div>

          <!-- Collapsible Speaker Notes -->
          <div class="creation-deck-notes" :class="{ 'is-collapsed': !notesOpen }">
            <button type="button" class="creation-deck-notes-toggle" @click="notesOpen = !notesOpen">
              <span>{{ $t('creation.deck.speakerNotes') }}</span>
              <span>{{ notesOpen ? '▾' : '▸' }}</span>
            </button>
            <div v-if="notesOpen && activeSlide" class="creation-deck-notes-body">
              <textarea
                v-model="activeSlide.speakerNotes"
                class="creation-deck-notes-input"
                :placeholder="$t('creation.deck.notesPlaceholder')"
                @input="markDirty"
              ></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
