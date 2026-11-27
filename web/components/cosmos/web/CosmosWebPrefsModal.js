/**
 * CosmosWebPrefsModal — Domain & Intelligence Preferences Studio Modal.
 *
 * Fixed-shell modal (fixed header, scrollable middle body, fixed footer with Save / Cancel)
 * with 4 tabs:
 *  1. Built-in Domains & Sources (toggle domains + expand per-source toggles + health badges)
 *  2. Custom Constellations (CRUD personal domains with color swatches, keywords & RSS/Atom URLs)
 *  3. Watch & Mute Keywords (global gold highlights & instant noise filter)
 *  4. AI Briefing & Skill Settings (preferred Agent with capability badge, perspective, SKILL.md tip)
 */
import { useCosmicWebStore } from '../../../stores/cosmicWeb.js';
import { getLocale, t } from '../../../utils/i18n.js';

const COLOR_SWATCHES = ['cyan', 'mint', 'gold', 'violet', 'rose', 'amber'];

const PERSPECTIVE_OPTIONS = [
  { id: 'balanced', labelKey: 'cosmos.web.prefs.perspectiveBalanced' },
  { id: 'engineering', labelKey: 'cosmos.web.prefs.perspectiveEngineering' },
  { id: 'product', labelKey: 'cosmos.web.prefs.perspectiveBusiness' },
  { id: 'investing', labelKey: 'cosmos.web.prefs.perspectiveInvesting' },
];

const PREF_TABS = [
  { id: 'domains', labelKey: 'cosmos.web.prefs.tabDomains' },
  { id: 'custom', labelKey: 'cosmos.web.prefs.tabCustom' },
  { id: 'keywords', labelKey: 'cosmos.web.prefs.tabKeywords' },
  { id: 'ai', labelKey: 'cosmos.web.prefs.tabAi' },
];

function isValidFeedUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function cloneJson(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export default {
  name: 'CosmosWebPrefsModal',
  props: {
    agents: {
      type: Array,
      default: () => [],
    },
    agentsLive: {
      type: Boolean,
      default: true,
    },
  },
  emits: ['toast'],
  setup() {
    const webStore = useCosmicWebStore();
    return { webStore };
  },
  data() {
    return {
      activeTab: 'domains',
      saving: false,
      saveError: null,
      expandedDomains: {},

      // Local editable draft
      draft: {
        enabledDomains: [],
        disabledSources: [],
        customDomains: [],
        watchKeywords: [],
        muteKeywords: [],
        preferredAgentId: '',
        defaultPerspective: 'balanced',
      },

      // Custom domain editor state
      editingCustomId: null,
      customForm: {
        name: '',
        colorToken: 'violet',
        keywordInput: '',
        keywords: [],
        rssInput: '',
        rssUrls: [],
      },
      customFormError: null,

      // Keyword tab inputs
      watchInput: '',
      muteInput: '',

      COLOR_SWATCHES,
      PERSPECTIVE_OPTIONS,
      PREF_TABS,
    };
  },
  computed: {
    isOpen() {
      return Boolean(this.webStore.prefsModalOpen);
    },
    builtInDomains() {
      return (this.webStore.domains || []).filter((d) => d && !d.isCustom);
    },
    briefingCapableAgents() {
      if (!this.agentsLive) return [];
      return (this.agents || []).filter(
        (a) => Boolean(a && a.online && Array.isArray(a.capabilities) && a.capabilities.includes('cosmic_web_briefing')),
      );
    },
    savedOfflinePreferredAgent() {
      const savedId = typeof this.webStore.prefs?.preferredAgentId === 'string'
        ? this.webStore.prefs.preferredAgentId
        : '';
      if (!savedId) return null;
      if (this.briefingCapableAgents.some((a) => a.id === savedId)) return null;
      const matched = (this.agents || []).find((a) => a && a.id === savedId);
      return {
        id: savedId,
        name: matched?.name || savedId,
      };
    },
  },
  watch: {
    briefingCapableAgents(list) {
      if (this.draft.preferredAgentId && !list.some((a) => a.id === this.draft.preferredAgentId)) {
        this.draft.preferredAgentId = '';
      }
    },
    isOpen: {
      immediate: true,
      handler(open, prev) {
        if (open) {
          this._previousActiveElement = typeof document !== 'undefined' ? document.activeElement : null;
          this.initDraftFromStore();
          this.attachFocusContainment();
          this.$nextTick(() => {
            this.$refs.prefsShell?.focus?.();
          });
        } else {
          this.detachFocusContainment();
          if (prev === true) {
            const prevEl = this._previousActiveElement;
            this._previousActiveElement = null;
            if (prevEl && typeof prevEl.focus === 'function') {
              this.$nextTick(() => {
                if (prevEl.isConnected) {
                  prevEl.focus();
                }
              });
            }
          }
        }
      },
    },
  },
  beforeUnmount() {
    this.detachFocusContainment();
  },
  methods: {
    attachFocusContainment() {
      if (typeof document === 'undefined' || this._focusTrapBound) return;
      document.addEventListener('keydown', this.handleModalKeydown, true);
      document.addEventListener('focusin', this.handleModalFocusIn, true);
      this._focusTrapBound = true;
    },
    detachFocusContainment() {
      if (typeof document === 'undefined' || !this._focusTrapBound) return;
      document.removeEventListener('keydown', this.handleModalKeydown, true);
      document.removeEventListener('focusin', this.handleModalFocusIn, true);
      this._focusTrapBound = false;
    },
    getFocusableElements(root) {
      if (!root) return [];
      return Array.from(
        root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true');
    },
    handleModalKeydown(e) {
      if (!this.isOpen) return;
      if (e.key === 'Tab') {
        this.handleTabTrap(e);
      }
    },
    handleModalFocusIn(e) {
      if (!this.isOpen) return;
      const root = this.$refs.prefsShell;
      if (!root) return;
      if (e.target && !root.contains(e.target)) {
        const focusables = this.getFocusableElements(root);
        if (focusables.length) focusables[0].focus();
        else root.focus();
      }
    },
    handleTabTrap(e) {
      const root = this.$refs.prefsShell;
      if (!root) return;
      const focusables = this.getFocusableElements(root);
      if (!focusables.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === root || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !root.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    },
    initDraftFromStore() {
      const p = this.webStore.prefs || {};
      this.draft = {
        enabledDomains: Array.isArray(p.enabledDomains) ? [...p.enabledDomains] : [],
        disabledSources: Array.isArray(p.disabledSources) ? [...p.disabledSources] : [],
        customDomains: Array.isArray(p.customDomains) ? cloneJson(p.customDomains) : [],
        watchKeywords: Array.isArray(p.watchKeywords) ? [...p.watchKeywords] : [],
        muteKeywords: Array.isArray(p.muteKeywords) ? [...p.muteKeywords] : [],
        preferredAgentId: (
          typeof p.preferredAgentId === 'string'
          && this.briefingCapableAgents.some((a) => a.id === p.preferredAgentId)
        ) ? p.preferredAgentId : '',
        defaultPerspective: p.defaultPerspective || 'balanced',
      };
      this.saveError = null;
      this.resetCustomForm();
    },
    close() {
      if (this.saving) return;
      this.webStore.prefsModalOpen = false;
    },
    domainLabel(d) {
      if (!d) return '';
      return getLocale() === 'en' ? (d.labelEn || d.nameEn || d.labelZh || d.nameZh || d.id) : (d.labelZh || d.nameZh || d.labelEn || d.nameEn || d.id);
    },
    isDomainEnabled(domainId) {
      return this.draft.enabledDomains.includes(domainId);
    },
    toggleDomain(domainId) {
      const idx = this.draft.enabledDomains.indexOf(domainId);
      if (idx >= 0) {
        this.draft.enabledDomains.splice(idx, 1);
      } else {
        this.draft.enabledDomains.push(domainId);
      }
    },
    toggleExpandDomain(domainId) {
      this.expandedDomains[domainId] = !this.expandedDomains[domainId];
    },
    isSourceEnabled(sourceId) {
      return !this.draft.disabledSources.includes(sourceId);
    },
    toggleSource(sourceId) {
      const idx = this.draft.disabledSources.indexOf(sourceId);
      if (idx >= 0) {
        this.draft.disabledSources.splice(idx, 1);
      } else {
        this.draft.disabledSources.push(sourceId);
      }
    },
    formatSyncTime(ts) {
      if (!ts) return t('cosmos.web.prefs.neverSynced');
      try {
        const diffMin = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
        if (diffMin < 1) return t('cosmos.web.time.justNow');
        if (diffMin < 60) return t('cosmos.web.time.minutesAgo', { count: diffMin });
        const diffHr = Math.round(diffMin / 60);
        return t('cosmos.web.time.hoursAgo', { count: diffHr });
      } catch {
        return '';
      }
    },

    // Custom domain CRUD
    resetCustomForm() {
      this.editingCustomId = null;
      this.customForm = {
        name: '',
        colorToken: 'violet',
        keywordInput: '',
        keywords: [],
        rssInput: '',
        rssUrls: [],
      };
      this.customFormError = null;
    },
    editCustomDomain(cd) {
      this.editingCustomId = cd.id;
      this.customForm = {
        name: cd.name || '',
        colorToken: cd.colorToken || 'violet',
        keywordInput: '',
        keywords: Array.isArray(cd.keywords) ? [...cd.keywords] : [],
        rssInput: '',
        rssUrls: Array.isArray(cd.rssUrls) ? [...cd.rssUrls] : [],
      };
      this.customFormError = null;
    },
    deleteCustomDomain(id) {
      this.draft.customDomains = this.draft.customDomains.filter((c) => c.id !== id);
      if (this.editingCustomId === id) this.resetCustomForm();
    },
    addCustomKeyword() {
      const val = String(this.customForm.keywordInput || '').trim();
      if (!val) return;
      if (!this.customForm.keywords.includes(val)) {
        this.customForm.keywords.push(val);
      }
      this.customForm.keywordInput = '';
    },
    removeCustomKeyword(kw) {
      this.customForm.keywords = this.customForm.keywords.filter((x) => x !== kw);
    },
    addCustomRss() {
      const val = String(this.customForm.rssInput || '').trim();
      if (!val) return;
      if (!isValidFeedUrl(val)) {
        this.customFormError = t('cosmos.web.prefs.invalidUrl');
        return;
      }
      if (!this.customForm.rssUrls.includes(val)) {
        this.customForm.rssUrls.push(val);
      }
      this.customForm.rssInput = '';
      this.customFormError = null;
    },
    removeCustomRss(url) {
      this.customForm.rssUrls = this.customForm.rssUrls.filter((x) => x !== url);
    },
    commitCustomDomain() {
      const name = String(this.customForm.name || '').trim();
      if (!name) {
        this.customFormError = t('cosmos.web.prefs.customNameRequired');
        return;
      }
      // Auto-commit pending keyword or RSS input if user typed without pressing Add
      if (this.customForm.keywordInput.trim()) this.addCustomKeyword();
      if (this.customForm.rssInput.trim()) {
        if (!isValidFeedUrl(this.customForm.rssInput.trim())) {
          this.customFormError = t('cosmos.web.prefs.invalidUrl');
          return;
        }
        this.addCustomRss();
      }
      if (this.customForm.keywords.length === 0 && this.customForm.rssUrls.length === 0) {
        this.customFormError = t('cosmos.web.prefs.customSourceOrKeywordRequired');
        return;
      }

      const id = this.editingCustomId || `custom-${Date.now().toString(36)}`;
      const entry = {
        id,
        name,
        colorToken: this.customForm.colorToken || 'violet',
        keywords: [...this.customForm.keywords],
        rssUrls: [...this.customForm.rssUrls],
      };

      const idx = this.draft.customDomains.findIndex((c) => c.id === id);
      if (idx >= 0) {
        this.draft.customDomains.splice(idx, 1, entry);
      } else {
        this.draft.customDomains.push(entry);
      }
      this.resetCustomForm();
    },

    // Global watch & mute keywords
    addWatchKeyword() {
      const parts = String(this.watchInput || '').split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
      for (const kw of parts) {
        if (!this.draft.watchKeywords.includes(kw)) {
          this.draft.watchKeywords.push(kw);
        }
      }
      this.watchInput = '';
    },
    removeWatchKeyword(kw) {
      this.draft.watchKeywords = this.draft.watchKeywords.filter((x) => x !== kw);
    },
    addMuteKeyword() {
      const parts = String(this.muteInput || '').split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
      for (const kw of parts) {
        if (!this.draft.muteKeywords.includes(kw)) {
          this.draft.muteKeywords.push(kw);
        }
      }
      this.muteInput = '';
    },
    removeMuteKeyword(kw) {
      this.draft.muteKeywords = this.draft.muteKeywords.filter((x) => x !== kw);
    },

    async saveAll() {
      if (this.saving) return;
      this.saving = true;
      this.saveError = null;
      try {
        await this.webStore.savePreferences({
          ...this.draft,
          onboarded: true,
        });
        this.$emit('toast', t('cosmos.web.prefs.saved'));
        this.webStore.prefsModalOpen = false;
      } catch (err) {
        this.saveError = err?.message || t('cosmos.web.prefs.saveFailed');
      } finally {
        this.saving = false;
      }
    },
  },
  template: `
    <div
      v-if="isOpen"
      class="cw-modal-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="$t('cosmos.web.prefs.title')"
      @pointerdown.stop
      @wheel.stop
      @click.self="close"
      @keydown.esc.stop.prevent="close"
    >
      <div ref="prefsShell" class="cw-modal-shell cw-prefs-modal" tabindex="-1">
        <!-- Fixed Header -->
        <header class="cw-modal-header">
          <div class="cw-modal-header-left">
            <h2 class="cw-modal-title">{{ $t('cosmos.web.prefs.title') }}</h2>
          </div>
          <div class="cw-modal-header-actions">
            <button
              type="button"
              class="cw-icon-btn"
              :aria-label="$t('cosmos.web.action.close')"
              :title="$t('cosmos.web.action.close')"
              @click="close"
            >✕</button>
          </div>
        </header>

        <!-- Fixed Tab Strip -->
        <nav class="cw-prefs-tabs" role="tablist" :aria-label="$t('cosmos.web.prefs.title')">
          <button
            v-for="tab in PREF_TABS"
            :key="tab.id"
            type="button"
            role="tab"
            class="cw-tab-btn"
            :class="{ 'is-active': activeTab === tab.id }"
            :aria-selected="activeTab === tab.id"
            @click="activeTab = tab.id"
          >{{ $t(tab.labelKey) }}</button>
        </nav>

        <!-- Scrollable Body -->
        <div class="cw-modal-body cw-prefs-body">
          <!-- TAB 1: Built-in Domains & Sources -->
          <div v-if="activeTab === 'domains'" class="cw-prefs-section">
            <p class="cw-prefs-hint">{{ $t('cosmos.web.prefs.domainsHint') }}</p>
            <div v-if="!builtInDomains.length" class="cw-state-box">
              <p>{{ $t('cosmos.web.prefs.noDomains') }}</p>
            </div>
            <div v-else class="cw-domain-list">
              <div
                v-for="d in builtInDomains"
                :key="d.id"
                class="cw-domain-row"
                :class="{ 'is-enabled': isDomainEnabled(d.id) }"
              >
                <div class="cw-domain-row-head">
                  <label class="cw-toggle-label">
                    <input
                      type="checkbox"
                      class="cw-checkbox"
                      :checked="isDomainEnabled(d.id)"
                      @change="toggleDomain(d.id)"
                    />
                    <span class="cw-dot" :class="'cw-dot-' + (d.colorToken || 'cyan')"></span>
                    <span class="cw-domain-name">{{ domainLabel(d) }}</span>
                  </label>
                  <div class="cw-domain-row-meta">
                    <span v-if="Array.isArray(d.sources)" class="cw-meta-pill">
                      {{ $t('cosmos.web.prefs.sourceCount', { count: d.sources.length }) }}
                    </span>
                    <button
                      v-if="Array.isArray(d.sources) && d.sources.length"
                      type="button"
                      class="cw-text-btn"
                      :aria-expanded="Boolean(expandedDomains[d.id])"
                      @click="toggleExpandDomain(d.id)"
                    >{{ expandedDomains[d.id] ? $t('cosmos.web.action.collapse') : $t('cosmos.web.prefs.manageSources') }}</button>
                  </div>
                </div>

                <!-- Per-source toggles + health badges -->
                <div v-if="expandedDomains[d.id] && Array.isArray(d.sources)" class="cw-source-grid">
                  <label
                    v-for="src in d.sources"
                    :key="src.id"
                    class="cw-source-item"
                    :class="{ 'is-error': Boolean(src.lastError) }"
                  >
                    <input
                      type="checkbox"
                      class="cw-checkbox"
                      :checked="isSourceEnabled(src.id)"
                      @change="toggleSource(src.id)"
                    />
                    <span class="cw-source-main">
                      <span class="cw-source-name">{{ src.name || src.id }}</span>
                      <span class="cw-source-health">
                        <span v-if="src.lastError" class="cw-health-err">{{ $t('cosmos.web.prefs.sourceError') }}</span>
                        <span v-else class="cw-health-ok">{{ formatSyncTime(src.lastSuccessAt || src.lastSyncedAt) }}</span>
                        <span v-if="src.itemCount !== undefined">· {{ src.itemCount }}</span>
                      </span>
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- TAB 2: Custom Constellations -->
          <div v-else-if="activeTab === 'custom'" class="cw-prefs-section">
            <p class="cw-prefs-hint">{{ $t('cosmos.web.prefs.customHint') }}</p>

            <!-- Existing custom domains -->
            <div v-if="draft.customDomains.length" class="cw-custom-list">
              <div v-for="cd in draft.customDomains" :key="cd.id" class="cw-custom-card">
                <div class="cw-custom-card-head">
                  <span class="cw-dot" :class="'cw-dot-' + (cd.colorToken || 'violet')"></span>
                  <strong class="cw-custom-name">{{ cd.name }}</strong>
                  <div class="cw-custom-actions">
                    <button type="button" class="cw-text-btn" @click="editCustomDomain(cd)">
                      {{ $t('cosmos.web.action.edit') }}
                    </button>
                    <button type="button" class="cw-text-btn cw-danger-text" @click="deleteCustomDomain(cd.id)">
                      {{ $t('cosmos.web.action.delete') }}
                    </button>
                  </div>
                </div>
                <div class="cw-chip-group">
                  <span v-for="kw in (cd.keywords || [])" :key="kw" class="cw-chip">{{ kw }}</span>
                  <span v-for="url in (cd.rssUrls || [])" :key="url" class="cw-chip cw-chip-url">{{ url }}</span>
                </div>
              </div>
            </div>

            <!-- Create / Edit Custom Domain Form -->
            <div class="cw-custom-editor">
              <h3 class="cw-section-heading">
                {{ editingCustomId ? $t('cosmos.web.prefs.editCustomTitle') : $t('cosmos.web.prefs.newCustomTitle') }}
              </h3>

              <div class="cw-field-group">
                <label class="cw-field-label">{{ $t('cosmos.web.prefs.customNameLabel') }}</label>
                <input
                  v-model="customForm.name"
                  type="text"
                  class="cw-input"
                  :placeholder="$t('cosmos.web.prefs.customNamePlaceholder')"
                />
              </div>

              <div class="cw-field-group">
                <label class="cw-field-label">{{ $t('cosmos.web.prefs.colorLabel') }}</label>
                <div class="cw-swatch-row" role="radiogroup">
                  <button
                    v-for="sw in COLOR_SWATCHES"
                    :key="sw"
                    type="button"
                    role="radio"
                    class="cw-swatch-btn"
                    :class="['cw-dot-' + sw, { 'is-selected': customForm.colorToken === sw }]"
                    :aria-checked="customForm.colorToken === sw"
                    :aria-label="sw"
                    @click="customForm.colorToken = sw"
                  ></button>
                </div>
              </div>

              <div class="cw-field-group">
                <label class="cw-field-label">{{ $t('cosmos.web.prefs.customKeywordsLabel') }}</label>
                <div class="cw-input-row">
                  <input
                    v-model="customForm.keywordInput"
                    type="text"
                    class="cw-input"
                    :placeholder="$t('cosmos.web.prefs.keywordPlaceholder')"
                    @keydown.enter.prevent="addCustomKeyword"
                  />
                  <button type="button" class="cw-btn cw-btn-subtle" @click="addCustomKeyword">
                    {{ $t('cosmos.web.action.add') }}
                  </button>
                </div>
                <div v-if="customForm.keywords.length" class="cw-chip-group">
                  <span v-for="kw in customForm.keywords" :key="kw" class="cw-chip">
                    {{ kw }}
                    <button
                      type="button"
                      class="cw-chip-remove"
                      :aria-label="$t('cosmos.web.action.remove')"
                      @click="removeCustomKeyword(kw)"
                    >×</button>
                  </span>
                </div>
              </div>

              <div class="cw-field-group">
                <label class="cw-field-label">{{ $t('cosmos.web.prefs.customRssLabel') }}</label>
                <div class="cw-input-row">
                  <input
                    v-model="customForm.rssInput"
                    type="url"
                    class="cw-input"
                    :placeholder="$t('cosmos.web.prefs.rssPlaceholder')"
                    @keydown.enter.prevent="addCustomRss"
                  />
                  <button type="button" class="cw-btn cw-btn-subtle" @click="addCustomRss">
                    {{ $t('cosmos.web.action.add') }}
                  </button>
                </div>
                <div v-if="customForm.rssUrls.length" class="cw-chip-group">
                  <span v-for="u in customForm.rssUrls" :key="u" class="cw-chip cw-chip-url">
                    {{ u }}
                    <button
                      type="button"
                      class="cw-chip-remove"
                      :aria-label="$t('cosmos.web.action.remove')"
                      @click="removeCustomRss(u)"
                    >×</button>
                  </span>
                </div>
              </div>

              <p v-if="customFormError" class="cw-inline-error">{{ customFormError }}</p>

              <div class="cw-editor-actions">
                <button type="button" class="cw-btn cw-btn-primary" @click="commitCustomDomain">
                  {{ editingCustomId ? $t('cosmos.web.prefs.updateCustomBtn') : $t('cosmos.web.prefs.addCustomBtn') }}
                </button>
                <button v-if="editingCustomId" type="button" class="cw-btn cw-btn-subtle" @click="resetCustomForm">
                  {{ $t('cosmos.web.action.cancel') }}
                </button>
              </div>
            </div>
          </div>

          <!-- TAB 3: Watch & Mute Keywords -->
          <div v-else-if="activeTab === 'keywords'" class="cw-prefs-section">
            <div class="cw-field-group">
              <h3 class="cw-section-heading">{{ $t('cosmos.web.prefs.watchTitle') }}</h3>
              <p class="cw-prefs-hint">{{ $t('cosmos.web.prefs.watchHint') }}</p>
              <div class="cw-input-row">
                <input
                  v-model="watchInput"
                  type="text"
                  class="cw-input"
                  :placeholder="$t('cosmos.web.prefs.watchPlaceholder')"
                  @keydown.enter.prevent="addWatchKeyword"
                />
                <button type="button" class="cw-btn cw-btn-subtle" @click="addWatchKeyword">
                  {{ $t('cosmos.web.action.add') }}
                </button>
              </div>
              <div v-if="draft.watchKeywords.length" class="cw-chip-group">
                <span v-for="kw in draft.watchKeywords" :key="kw" class="cw-chip cw-chip-gold">
                  {{ kw }}
                  <button
                    type="button"
                    class="cw-chip-remove"
                    :aria-label="$t('cosmos.web.action.remove')"
                    @click="removeWatchKeyword(kw)"
                  >×</button>
                </span>
              </div>
            </div>

            <div class="cw-field-group">
              <h3 class="cw-section-heading">{{ $t('cosmos.web.prefs.muteTitle') }}</h3>
              <p class="cw-prefs-hint">{{ $t('cosmos.web.prefs.muteHint') }}</p>
              <div class="cw-input-row">
                <input
                  v-model="muteInput"
                  type="text"
                  class="cw-input"
                  :placeholder="$t('cosmos.web.prefs.mutePlaceholder')"
                  @keydown.enter.prevent="addMuteKeyword"
                />
                <button type="button" class="cw-btn cw-btn-subtle" @click="addMuteKeyword">
                  {{ $t('cosmos.web.action.add') }}
                </button>
              </div>
              <div v-if="draft.muteKeywords.length" class="cw-chip-group">
                <span v-for="kw in draft.muteKeywords" :key="kw" class="cw-chip cw-chip-muted">
                  {{ kw }}
                  <button
                    type="button"
                    class="cw-chip-remove"
                    :aria-label="$t('cosmos.web.action.remove')"
                    @click="removeMuteKeyword(kw)"
                  >×</button>
                </span>
              </div>
            </div>
          </div>

          <!-- TAB 4: AI Briefing & Skill Settings -->
          <div v-else class="cw-prefs-section">
            <div class="cw-field-group">
              <label class="cw-field-label">{{ $t('cosmos.web.prefs.agentLabel') }}</label>
              <p class="cw-prefs-hint">{{ $t('cosmos.web.prefs.agentHint') }}</p>
              <div class="cw-agent-radio-list" role="radiogroup">
                <label class="cw-agent-radio-item" :class="{ 'is-selected': !draft.preferredAgentId }">
                  <input
                    v-model="draft.preferredAgentId"
                    type="radio"
                    value=""
                  />
                  <span class="cw-agent-radio-title">{{ $t('cosmos.web.prefs.agentAuto') }}</span>
                </label>
                <label
                  v-for="ag in briefingCapableAgents"
                  :key="ag.id"
                  class="cw-agent-radio-item"
                  :class="{ 'is-selected': draft.preferredAgentId === ag.id }"
                >
                  <input
                    v-model="draft.preferredAgentId"
                    type="radio"
                    :value="ag.id"
                  />
                  <span class="cw-status-dot is-online"></span>
                  <span class="cw-agent-radio-title">{{ ag.name || ag.id }}</span>
                  <span class="cw-badge cw-badge-mint">
                    {{ $t('cosmos.web.prefs.briefingCapable') }}
                  </span>
                </label>
                <div
                  v-if="savedOfflinePreferredAgent"
                  class="cw-agent-radio-item"
                  role="note"
                >
                  <span class="cw-status-dot"></span>
                  <span class="cw-agent-radio-title">{{ savedOfflinePreferredAgent.name }}</span>
                  <span class="cw-badge">
                    {{ $t('cosmos.web.status.offline') }}
                  </span>
                </div>
              </div>
            </div>

            <div class="cw-field-group">
              <label class="cw-field-label">{{ $t('cosmos.web.prefs.perspectiveLabel') }}</label>
              <div class="cw-perspective-grid" role="radiogroup">
                <label
                  v-for="opt in PERSPECTIVE_OPTIONS"
                  :key="opt.id"
                  class="cw-perspective-card"
                  :class="{ 'is-selected': draft.defaultPerspective === opt.id }"
                >
                  <input
                    v-model="draft.defaultPerspective"
                    type="radio"
                    :value="opt.id"
                  />
                  <span>{{ $t(opt.labelKey) }}</span>
                </label>
              </div>
            </div>

            <div class="cw-skill-tip">
              <h4 class="cw-skill-tip-title">{{ $t('cosmos.web.prefs.skillTipTitle') }}</h4>
              <p class="cw-skill-tip-desc">{{ $t('cosmos.web.prefs.skillTipDesc') }}</p>
              <code class="cw-code-path">~/.yeaft/skills/cosmic-web/SKILL.md</code>
            </div>
          </div>

          <p v-if="saveError" class="cw-inline-error">{{ saveError }}</p>
        </div>

        <!-- Fixed Footer -->
        <footer class="cw-modal-footer cw-prefs-footer">
          <button type="button" class="cw-btn cw-btn-subtle" :disabled="saving" @click="close">
            {{ $t('cosmos.web.action.cancel') }}
          </button>
          <button type="button" class="cw-btn cw-btn-primary" :disabled="saving" @click="saveAll">
            {{ saving ? $t('cosmos.web.prefs.saving') : $t('cosmos.web.action.save') }}
          </button>
        </footer>
      </div>
    </div>
  `,
};
