/**
 * CosmosWebOverlay — Interactive Cosmic Web HUD, Onboarding, Intelligence Drawer,
 * Inline Clean Reader, 3D Star Hover Tooltip & Global Keyboard Shortcuts.
 *
 * Composes `CosmosWebReaderModal` and `CosmosWebPrefsModal`.
 * All interactive panels stop pointer/wheel propagation so scrolling never zooms the 3D stage.
 */
import { useCosmicWebStore } from '../../../stores/cosmicWeb.js';
import { renderSafeMessageMarkdown } from '../../../utils/safe-message-markdown.js';
import { getLocale, t } from '../../../utils/i18n.js';
import CosmosWebReaderModal from './CosmosWebReaderModal.js';
import CosmosWebPrefsModal from './CosmosWebPrefsModal.js';

const QUICK_DISPATCH_PRESETS = [
  { id: 'deepdive', labelKey: 'cosmos.web.dispatch.presetDeepDive' },
  { id: 'impact', labelKey: 'cosmos.web.dispatch.presetImpact' },
  { id: 'action', labelKey: 'cosmos.web.dispatch.presetAction' },
];

function isSafeHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isEditableElement(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(el.isContentEditable);
}

export default {
  name: 'CosmosWebOverlay',
  components: {
    CosmosWebReaderModal,
    CosmosWebPrefsModal,
  },
  props: {
    visible: {
      type: Boolean,
      default: false,
    },
    agents: {
      type: Array,
      default: () => [],
    },
    agentToPlanet: {
      type: Object,
      default: () => ({}),
    },
    isCompact: {
      type: Boolean,
      default: false,
    },
  },
  emits: ['toast', 'dispatch-to-planet', 'escape-solar'],
  setup() {
    const webStore = useCosmicWebStore();
    return { webStore };
  },
  data() {
    return {
      searchDraft: '',
      searchTimer: null,
      isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,

      // Onboarding draft (populated from server catalog defaultEnabled domains)
      onboardDomains: [],
      onboardKeywordsInput: '',
      onboardSubmitting: false,

      // Inline reader dispatch state
      dispatchAgentId: '',
      dispatchPresetId: 'deepdive',
      dispatchPrompt: '',
      selectedAiFollowUp: '',

      // Keyboard navigation cursor index
      focusedFeedIdx: -1,

      QUICK_DISPATCH_PRESETS,
    };
  },
  computed: {
    enabledDomains() {
      return this.webStore.enabledDomainList || [];
    },
    builtInDomains() {
      return (this.webStore.domains || []).filter((d) => d && !d.isCustom);
    },
    showOnboarding() {
      return Boolean(this.webStore.bootstrapped && !this.webStore.prefs?.onboarded);
    },
    inlineReaderActive() {
      return Boolean(this.webStore.readerOpen && !this.webStore.readerExpanded);
    },
    activeCluster() {
      return this.webStore.activeCluster;
    },
    activeArticle() {
      return this.webStore.articleData;
    },
    activeAiBrief() {
      return this.webStore.aiBriefData;
    },
    sourceItems() {
      const items = this.activeCluster?.items || this.activeCluster?.sources || [];
      return Array.isArray(items) ? items.filter((s) => s && (s.url || s.sourceName)) : [];
    },
    primarySafeUrl() {
      const candidate = this.webStore.activeArticleUrl
        || this.activeArticle?.url
        || this.activeCluster?.primaryUrl
        || this.activeCluster?.url
        || this.sourceItems[0]?.url
        || '';
      return isSafeHttpUrl(candidate) ? candidate : '';
    },
    isFallbackArticle() {
      const q = this.activeArticle?.quality;
      return q === 'search_only' || q === 'blocked' || q === 'metadata_only';
    },
    renderedArticleHtml() {
      const md = this.activeArticle?.markdown || this.activeArticle?.content || this.activeArticle?.excerpt || '';
      return md ? renderSafeMessageMarkdown(md) : '';
    },
    renderedAiMarkdownHtml() {
      const md = this.activeAiBrief?.fullMarkdown || this.activeAiBrief?.markdown || this.activeAiBrief?.rawMarkdown || '';
      return md ? renderSafeMessageMarkdown(md) : '';
    },
    availableAgents() {
      return (this.agents || []).slice().sort((a, b) => Number(Boolean(b?.online)) - Number(Boolean(a?.online)));
    },
    effectiveDispatchAgentId() {
      if (this.dispatchAgentId) return this.dispatchAgentId;
      if (this.webStore.prefs?.preferredAgentId) return this.webStore.prefs.preferredAgentId;
      const online = this.availableAgents.find((a) => a && a.online);
      return online?.id || this.availableAgents[0]?.id || '';
    },
    activeDomainTitle() {
      const id = this.webStore.activeDomain || 'all';
      if (id === 'all') return t('cosmos.web.filter.all');
      if (id === 'watch') return t('cosmos.web.filter.watch');
      if (id === 'bookmarked') return t('cosmos.web.filter.bookmarked');
      if (id === 'unread') return t('cosmos.web.filter.unread');
      const d = this.enabledDomains.find((x) => x.id === id) || (this.webStore.domains || []).find((x) => x.id === id);
      return d ? this.domainLabel(d) : id;
    },
    hoveredPreview() {
      if (this.webStore.readerExpanded || this.webStore.dailyBriefingOpen || this.webStore.prefsModalOpen) {
        return null;
      }
      return this.webStore.hoveredNodeMeta;
    },
    isActiveClusterBookmarked() {
      return Boolean(this.activeCluster?.isBookmarked ?? this.activeCluster?.bookmarked);
    },
  },
  watch: {
    visible: {
      immediate: true,
      handler(val, prev) {
        if (val) {
          this.webStore?.enterWebBand?.();
          this.searchDraft = this.webStore?.searchQuery || '';
        } else if (prev === true) {
          if (this.searchTimer) {
            clearTimeout(this.searchTimer);
            this.searchTimer = null;
          }
          this.webStore?.leaveWebBand?.();
        }
      },
    },
    'webStore.domains': {
      immediate: true,
      handler(list) {
        if (Array.isArray(list) && list.length && this.onboardDomains.length === 0) {
          const builtIns = list.filter((d) => d && !d.isCustom);
          const defaults = builtIns.filter((d) => d.defaultEnabled).map((d) => d.id);
          this.onboardDomains = defaults.length > 0 ? defaults : builtIns.slice(0, 4).map((d) => d.id);
        }
      },
    },
    'webStore.readerClusterId'(id) {
      this.dispatchPrompt = '';
      this.selectedAiFollowUp = '';
      this.dispatchPresetId = 'deepdive';
      if (id) {
        const idx = this.webStore.feedItems.findIndex((it) => it && it.id === id);
        if (idx >= 0) this.focusedFeedIdx = idx;
      }
    },
  },
  mounted() {
    window.addEventListener('keydown', this.handleGlobalKeydown);
    window.addEventListener('online', this.handleOnlineChange);
    window.addEventListener('offline', this.handleOnlineChange);
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.handleGlobalKeydown);
    window.removeEventListener('online', this.handleOnlineChange);
    window.removeEventListener('offline', this.handleOnlineChange);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  },
  methods: {
    handleOnlineChange() {
      this.isOffline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
    },
    domainLabel(d) {
      if (!d) return '';
      return getLocale() === 'en' ? (d.labelEn || d.nameEn || d.labelZh || d.nameZh || d.name || d.id) : (d.labelZh || d.nameZh || d.labelEn || d.nameEn || d.name || d.id);
    },
    domainLabelById(domainId) {
      const d = (this.webStore.domains || []).find((x) => x.id === domainId)
        || this.enabledDomains.find((x) => x.id === domainId);
      return d ? this.domainLabel(d) : (domainId || '');
    },
    onSearchInput() {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.webStore.setSearchQuery(this.searchDraft);
      }, 240);
    },
    clearSearch() {
      this.searchDraft = '';
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.webStore.setSearchQuery('');
    },
    toggleDrawer() {
      this.webStore.drawerCollapsed = !this.webStore.drawerCollapsed;
    },
    openPrefs() {
      this.webStore.prefsModalOpen = true;
    },
    openDailyBriefing() {
      this.webStore.openDailyBriefing();
    },
    async triggerRefresh() {
      if (this.isOffline) {
        this.$emit('toast', t('cosmos.web.status.offlineHint'));
        return;
      }
      await this.webStore.refreshNow({ domainId: this.webStore.activeDomain, force: true });
      if (!this.webStore.error) {
        this.$emit('toast', t('cosmos.web.status.refreshed'));
      }
    },

    // Onboarding
    toggleOnboardDomain(id) {
      const idx = this.onboardDomains.indexOf(id);
      if (idx >= 0) this.onboardDomains.splice(idx, 1);
      else this.onboardDomains.push(id);
    },
    async submitOnboarding(useDefaults = false) {
      if (this.onboardSubmitting) return;
      this.onboardSubmitting = true;
      try {
        const keywords = useDefaults
          ? []
          : String(this.onboardKeywordsInput || '').split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
        const validIds = new Set(this.builtInDomains.map((d) => d.id));
        const defaultCatalogIds = this.builtInDomains.filter((d) => d.defaultEnabled).map((d) => d.id);
        const fallbackDefaults = defaultCatalogIds.length > 0
          ? defaultCatalogIds
          : (this.builtInDomains.length > 0
            ? this.builtInDomains.slice(0, 4).map((d) => d.id)
            : ['ai', 'tech', 'finance', 'product']);
        const filteredDraft = validIds.size > 0
          ? this.onboardDomains.filter((id) => validIds.has(id))
          : [...this.onboardDomains];
        const domains = useDefaults || filteredDraft.length === 0
          ? fallbackDefaults
          : filteredDraft;
        await this.webStore.completeOnboarding({
          enabledDomains: domains,
          watchKeywords: keywords,
        });
        this.$emit('toast', t('cosmos.web.onboarding.readyToast'));
      } catch (err) {
        this.$emit('toast', err?.message || t('cosmos.web.prefs.saveFailed'));
      } finally {
        this.onboardSubmitting = false;
      }
    },

    // Feed & Reader interactions
    onCardEnter(item) {
      if (!item?.id) return;
      this.webStore.hoveredClusterId = item.id;
      this.webStore.emitPulse({ clusterId: item.id, domainId: item.domainId, count: 4 });
    },
    onCardLeave(item) {
      if (this.webStore.hoveredClusterId === item?.id) {
        this.webStore.hoveredClusterId = null;
      }
    },
    openStory(item, tab = 'article') {
      if (!item?.id) return;
      this.webStore.openClusterReader(item.id, { tab, expanded: false });
    },
    quickDispatchCard(item) {
      if (!item?.id) return;
      const agentId = this.effectiveDispatchAgentId;
      if (!agentId) {
        this.$emit('toast', t('cosmos.web.dispatch.noAgent'));
        return;
      }
      const title = item.headline || item.title || '';
      this.$emit('dispatch-to-planet', {
        agentId,
        planetId: this.agentToPlanet?.[agentId] || null,
        mode: 'fly',
        intent: 'deepdive',
        userNote: '',
        clusterId: item.id,
        headline: title,
        url: isSafeHttpUrl(item.primaryUrl || item.url) ? (item.primaryUrl || item.url) : null,
        summary: item.summaryExcerpt || item.excerpt || '',
      });
      this.$emit('toast', t('cosmos.web.dispatch.sentFly'));
    },
    focusSearch() {
      this.$nextTick(() => {
        this.$refs.searchInputRef?.focus?.();
      });
    },
    switchInlineTab(tab) {
      this.webStore.readerTab = tab;
      if (tab === 'ai' && !this.webStore.aiBriefData && !this.webStore.aiBriefLoading && this.activeCluster?.id) {
        this.webStore.generateAiBrief(this.activeCluster.id, {
          itemId: this.webStore.activeArticleItemId || undefined,
        });
      }
    },
    triggerAiSynthesis() {
      if (!this.activeCluster?.id) return;
      this.webStore.readerTab = 'ai';
      this.webStore.generateAiBrief(this.activeCluster.id, {
        mode: 'synthesize',
        itemId: this.webStore.activeArticleItemId || undefined,
        force: true,
      });
    },
    applyPreset(preset) {
      if (!preset?.id) return;
      this.dispatchPresetId = preset.id;
    },
    applyFollowUp(question) {
      if (!question) return;
      this.selectedAiFollowUp = String(question).trim();
      this.$nextTick(() => {
        this.$refs.inlineDispatchInput?.focus?.();
      });
    },
    clearSelectedAiFollowUp() {
      this.selectedAiFollowUp = '';
    },
    submitInlineDispatch(mode = 'fly') {
      const agentId = this.effectiveDispatchAgentId;
      if (!agentId) {
        this.$emit('toast', t('cosmos.web.dispatch.noAgent'));
        return;
      }
      const title = this.activeCluster?.headline || this.activeCluster?.title || '';
      const userNote = String(this.dispatchPrompt || '').trim();
      this.$emit('dispatch-to-planet', {
        agentId,
        planetId: this.agentToPlanet?.[agentId] || null,
        mode,
        intent: this.dispatchPresetId || 'deepdive',
        userNote,
        aiFollowUp: this.selectedAiFollowUp || null,
        clusterId: this.activeCluster?.id || null,
        headline: title,
        url: this.primarySafeUrl || null,
        summary: this.activeAiBrief?.tldr || this.activeArticle?.excerpt || '',
      });
      this.$emit('toast', mode === 'fly'
        ? t('cosmos.web.dispatch.sentFly')
        : t('cosmos.web.dispatch.sentBackground'));
      this.dispatchPrompt = '';
      this.selectedAiFollowUp = '';
      this.dispatchPresetId = 'deepdive';
    },
    formatTime(ts) {
      if (!ts) return '';
      try {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return '';
        const diffMin = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
        if (diffMin < 1) return t('cosmos.web.time.justNow');
        if (diffMin < 60) return t('cosmos.web.time.minutesAgo', { count: diffMin });
        const diffHr = Math.round(diffMin / 60);
        if (diffHr < 24) return t('cosmos.web.time.hoursAgo', { count: diffHr });
        return d.toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' });
      } catch {
        return '';
      }
    },

    // Global Keyboard Shortcuts (disabled while typing in inputs/textareas/selects)
    handleGlobalKeydown(e) {
      if (!this.visible) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableElement(e.target)) return;

      const key = e.key;
      if (key === 'Escape') {
        if (this.webStore.prefsModalOpen) {
          this.webStore.prefsModalOpen = false;
          e.preventDefault();
        } else if (this.webStore.dailyBriefingOpen) {
          this.webStore.closeDailyBriefing();
          e.preventDefault();
        } else if (this.webStore.readerExpanded) {
          this.webStore.readerExpanded = false;
          e.preventDefault();
        } else if (this.webStore.readerOpen) {
          this.webStore.closeClusterReader();
          e.preventDefault();
        }
        return;
      }

      // Skip navigation shortcuts while modal dialogs are open
      if (this.webStore.prefsModalOpen || this.webStore.dailyBriefingOpen) return;

      const items = this.webStore.feedItems || [];
      if (key === 'j' || key === 'J') {
        if (!items.length) return;
        e.preventDefault();
        this.focusedFeedIdx = Math.min(items.length - 1, this.focusedFeedIdx + 1);
        const item = items[this.focusedFeedIdx];
        if (item) {
          this.webStore.cursorClusterId = item.id;
          if (!this.webStore.readerOpen) this.webStore.selectedClusterId = item.id;
          this.webStore.hoveredClusterId = item.id;
          this.webStore.emitPulse({ clusterId: item.id, domainId: item.domainId, count: 6 });
        }
      } else if (key === 'k' || key === 'K') {
        if (!items.length) return;
        e.preventDefault();
        this.focusedFeedIdx = Math.max(0, this.focusedFeedIdx <= 0 ? 0 : this.focusedFeedIdx - 1);
        const item = items[this.focusedFeedIdx];
        if (item) {
          this.webStore.cursorClusterId = item.id;
          if (!this.webStore.readerOpen) this.webStore.selectedClusterId = item.id;
          this.webStore.hoveredClusterId = item.id;
          this.webStore.emitPulse({ clusterId: item.id, domainId: item.domainId, count: 6 });
        }
      } else if (key === 'Enter') {
        const targetId = this.webStore.cursorClusterId || this.webStore.selectedClusterId || items[this.focusedFeedIdx]?.id;
        if (targetId && !this.webStore.readerOpen) {
          e.preventDefault();
          this.webStore.openClusterReader(targetId, { tab: 'article', expanded: false });
        }
      } else if (key === 's' || key === 'S') {
        const targetId = (this.webStore.readerOpen ? this.webStore.readerClusterId : null)
          || this.webStore.cursorClusterId
          || this.webStore.selectedClusterId
          || items[this.focusedFeedIdx]?.id;
        if (targetId) {
          e.preventDefault();
          this.webStore.toggleBookmark(targetId);
        }
      } else if (key === 'a' || key === 'A') {
        const targetId = (this.webStore.readerOpen ? this.webStore.readerClusterId : null)
          || this.webStore.cursorClusterId
          || this.webStore.selectedClusterId
          || items[this.focusedFeedIdx]?.id;
        if (targetId) {
          e.preventDefault();
          this.webStore.openClusterReader(targetId, { tab: 'ai', expanded: this.webStore.readerExpanded });
        }
      } else if (key === 'e' || key === 'E') {
        if (this.webStore.readerOpen) {
          e.preventDefault();
          this.webStore.readerExpanded = !this.webStore.readerExpanded;
        }
      } else if (key === 'r' || key === 'R') {
        e.preventDefault();
        this.triggerRefresh();
      }
    },
  },
  template: `
    <div
      v-if="visible"
      class="cosmos-web-scope cw-overlay"
      :class="{ 'is-compact': isCompact, 'is-drawer-collapsed': webStore.drawerCollapsed }"
      role="region"
      :aria-label="$t('cosmos.web.regionLabel')"
    >
      <!-- Top Translucent Glass HUD Bar -->
      <header
        class="cw-hud-bar"
        @pointerdown.stop
        @wheel.stop
      >
        <div class="cw-hud-pills" role="tablist" :aria-label="$t('cosmos.web.filter.domainsLabel')">
          <button
            type="button"
            role="tab"
            class="cw-pill"
            :class="{ 'is-active': webStore.activeDomain === 'all' }"
            :aria-selected="webStore.activeDomain === 'all'"
            @click="webStore.selectDomain('all')"
          >
            <span>{{ $t('cosmos.web.filter.all') }}</span>
            <span v-if="webStore.stats.totalClusters" class="cw-pill-count">{{ webStore.stats.totalClusters }}</span>
          </button>

          <button
            v-for="d in enabledDomains"
            :key="d.id"
            type="button"
            role="tab"
            class="cw-pill"
            :class="{ 'is-active': webStore.activeDomain === d.id }"
            :aria-selected="webStore.activeDomain === d.id"
            @click="webStore.selectDomain(d.id)"
          >
            <span class="cw-dot" :class="'cw-dot-' + (d.colorToken || 'cyan')"></span>
            <span>{{ domainLabel(d) }}</span>
            <span v-if="d.unreadCount > 0" class="cw-pill-count">{{ d.unreadCount }}</span>
          </button>

          <span class="cw-hud-divider" aria-hidden="true"></span>

          <button
            type="button"
            role="tab"
            class="cw-pill"
            :class="{ 'is-active': webStore.activeDomain === 'watch' }"
            :aria-selected="webStore.activeDomain === 'watch'"
            @click="webStore.selectDomain('watch')"
          >
            <span class="cw-dot cw-dot-gold"></span>
            <span>{{ $t('cosmos.web.filter.watch') }}</span>
            <span v-if="webStore.stats.watchHitCount > 0" class="cw-pill-count">{{ webStore.stats.watchHitCount }}</span>
          </button>

          <button
            type="button"
            role="tab"
            class="cw-pill"
            :class="{ 'is-active': webStore.activeDomain === 'bookmarked' }"
            :aria-selected="webStore.activeDomain === 'bookmarked'"
            @click="webStore.selectDomain('bookmarked')"
          >
            <span>{{ $t('cosmos.web.filter.bookmarked') }}</span>
            <span v-if="webStore.stats.bookmarkedCount > 0" class="cw-pill-count">{{ webStore.stats.bookmarkedCount }}</span>
          </button>

          <button
            type="button"
            role="tab"
            class="cw-pill"
            :class="{ 'is-active': webStore.activeDomain === 'unread' }"
            :aria-selected="webStore.activeDomain === 'unread'"
            @click="webStore.selectDomain('unread')"
          >
            <span>{{ $t('cosmos.web.filter.unread') }}</span>
            <span v-if="webStore.stats.unreadCount > 0" class="cw-pill-count">{{ webStore.stats.unreadCount }}</span>
          </button>
        </div>

        <div class="cw-hud-controls">
          <div class="cw-search-box">
            <input
              ref="searchInputRef"
              v-model="searchDraft"
              type="search"
              class="cw-search-input"
              :placeholder="$t('cosmos.web.search.placeholder')"
              :aria-label="$t('cosmos.web.search.placeholder')"
              @input="onSearchInput"
              @keydown.esc.stop="clearSearch"
            />
            <button
              v-if="searchDraft"
              type="button"
              class="cw-search-clear"
              :aria-label="$t('cosmos.web.action.clear')"
              @click="clearSearch"
            >×</button>
          </div>

          <button
            type="button"
            class="cw-hud-btn cw-hud-btn-accent"
            @click="openDailyBriefing"
          >{{ $t('cosmos.web.hud.dailyBriefing') }}</button>

          <button
            type="button"
            class="cw-hud-btn"
            :class="{ 'is-spinning': webStore.refreshing }"
            :disabled="webStore.refreshing"
            :title="$t('cosmos.web.hud.refresh')"
            @click="triggerRefresh"
          >
            <span class="cw-refresh-glyph" aria-hidden="true">↻</span>
            <span class="cw-hud-btn-label">{{ $t('cosmos.web.hud.refresh') }}</span>
          </button>

          <button
            type="button"
            class="cw-hud-btn"
            @click="openPrefs"
          >{{ $t('cosmos.web.hud.customize') }}</button>

          <button
            type="button"
            class="cw-hud-btn"
            :aria-pressed="!webStore.drawerCollapsed"
            @click="toggleDrawer"
          >{{ webStore.drawerCollapsed ? $t('cosmos.web.hud.expandDrawer') : $t('cosmos.web.hud.collapseDrawer') }}</button>
        </div>
      </header>

      <!-- Offline / Stale Banner -->
      <div v-if="isOffline" class="cw-status-banner" role="status" aria-live="polite" @pointerdown.stop>
        <span>{{ $t('cosmos.web.status.offlineHint') }}</span>
      </div>

      <!-- First-Time Interactive Interest Onboarding Card -->
      <section
        v-if="showOnboarding"
        class="cw-onboarding-card"
        role="region"
        :aria-label="$t('cosmos.web.onboarding.title')"
        @pointerdown.stop
        @wheel.stop
      >
        <h2 class="cw-onboarding-title">{{ $t('cosmos.web.onboarding.title') }}</h2>
        <p class="cw-onboarding-subtitle">{{ $t('cosmos.web.onboarding.subtitle') }}</p>

        <div class="cw-onboarding-grid">
          <button
            v-for="d in builtInDomains"
            :key="d.id"
            type="button"
            class="cw-onboard-domain"
            :class="['cw-tone-' + (d.colorToken || 'cyan'), { 'is-selected': onboardDomains.includes(d.id) }]"
            :aria-pressed="onboardDomains.includes(d.id)"
            @click="toggleOnboardDomain(d.id)"
          >
            <div class="cw-onboard-domain-head">
              <span class="cw-dot" :class="'cw-dot-' + (d.colorToken || 'cyan')"></span>
              <strong>{{ domainLabel(d) }}</strong>
            </div>
            <div v-if="Array.isArray(d.sources) && d.sources.length" class="cw-onboard-sources">
              <span v-for="s in d.sources.slice(0, 3)" :key="s.id" class="cw-mini-tag">{{ s.name || s.id }}</span>
            </div>
          </button>
        </div>

        <div class="cw-field-group">
          <label class="cw-field-label">{{ $t('cosmos.web.onboarding.keywordsLabel') }}</label>
          <input
            v-model="onboardKeywordsInput"
            type="text"
            class="cw-input"
            :placeholder="$t('cosmos.web.onboarding.keywordsPlaceholder')"
          />
        </div>

        <div class="cw-onboarding-actions">
          <button
            type="button"
            class="cw-btn cw-btn-primary"
            :disabled="onboardSubmitting"
            @click="submitOnboarding(false)"
          >{{ onboardSubmitting ? $t('cosmos.web.prefs.saving') : $t('cosmos.web.onboarding.igniteCta') }}</button>
          <button
            type="button"
            class="cw-btn cw-btn-subtle"
            :disabled="onboardSubmitting"
            @click="submitOnboarding(true)"
          >{{ $t('cosmos.web.onboarding.useDefaultsCta') }}</button>
        </div>
      </section>

      <!-- Floating 3D Star Hover Preview Tooltip -->
      <aside
        v-if="hoveredPreview"
        class="cw-hover-preview"
        aria-live="polite"
      >
        <div class="cw-hover-meta">
          <span v-if="hoveredPreview.domainId" class="cw-badge" :class="'cw-tone-' + (hoveredPreview.colorToken || 'cyan')">
            {{ domainLabelById(hoveredPreview.domainId) }}
          </span>
          <span v-if="hoveredPreview.itemCount">{{ $t('cosmos.web.feed.sourcesCount', { count: hoveredPreview.itemCount }) }}</span>
          <span v-if="hoveredPreview.publishedAt">{{ formatTime(hoveredPreview.publishedAt) }}</span>
        </div>
        <div class="cw-hover-headline">{{ hoveredPreview.headline || hoveredPreview.title || hoveredPreview.labelZh }}</div>
      </aside>

      <!-- Right Translucent Intelligence Drawer (Mobile Bottom Sheet) -->
      <aside
        v-if="!webStore.drawerCollapsed"
        class="cw-drawer"
        role="complementary"
        :aria-label="$t('cosmos.web.drawer.label')"
        @pointerdown.stop
        @wheel.stop
      >
        <!-- MODE 1: Inline Reader inside Drawer -->
        <template v-if="inlineReaderActive">
          <div class="cw-drawer-header">
            <button
              type="button"
              class="cw-text-btn"
              @click="webStore.closeClusterReader()"
            >← {{ $t('cosmos.web.reader.backToFeed') }}</button>

            <div class="cw-drawer-header-right">
              <button
                type="button"
                class="cw-text-btn"
                @click="webStore.readerExpanded = true"
              >{{ $t('cosmos.web.reader.expandCentered') }}</button>
              <button
                type="button"
                class="cw-icon-btn"
                :class="{ 'is-active': isActiveClusterBookmarked }"
                :aria-label="$t('cosmos.web.action.bookmark')"
                @click="activeCluster && webStore.toggleBookmark(activeCluster.id)"
              >{{ isActiveClusterBookmarked ? '★' : '☆' }}</button>
            </div>
          </div>

          <div class="cw-inline-reader-subbar">
            <div class="cw-segmented" role="tablist">
              <button
                type="button"
                role="tab"
                class="cw-seg-btn"
                :class="{ 'is-active': webStore.readerTab === 'article' }"
                :aria-selected="webStore.readerTab === 'article'"
                @click="switchInlineTab('article')"
              >{{ $t('cosmos.web.reader.tabArticle') }}</button>
              <button
                type="button"
                role="tab"
                class="cw-seg-btn"
                :class="{ 'is-active': webStore.readerTab === 'ai' }"
                :aria-selected="webStore.readerTab === 'ai'"
                @click="switchInlineTab('ai')"
              >{{ $t('cosmos.web.reader.tabAi') }}</button>
            </div>
            <a
              v-if="primarySafeUrl"
              :href="primarySafeUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="cw-origin-link"
            >{{ $t('cosmos.web.reader.openOriginal') }} ↗</a>
          </div>

          <div class="cw-drawer-scroll cw-inline-reader-body">
            <h2 class="cw-inline-headline">{{ activeCluster?.headline || activeCluster?.title || '' }}</h2>
            <div class="cw-meta-row">
              <span v-if="activeCluster?.domainId" class="cw-badge" :class="'cw-tone-' + (activeCluster?.colorToken || 'cyan')">
                {{ domainLabelById(activeCluster.domainId) }}
              </span>
              <span v-if="activeCluster?.publishedAt">{{ formatTime(activeCluster.publishedAt) }}</span>
              <span v-if="activeCluster?.heatScore !== undefined">
                {{ $t('cosmos.web.feed.heatLabel', { score: Math.round(activeCluster.heatScore) }) }}
              </span>
            </div>

            <!-- Multi-source switcher pills -->
            <div v-if="sourceItems.length > 1" class="cw-source-pills">
              <button
                v-for="(src, idx) in sourceItems"
                :key="src.id || src.url || idx"
                type="button"
                class="cw-source-pill"
                :class="{ 'is-active': (webStore.activeArticleItemId && src.id) ? webStore.activeArticleItemId === src.id : (webStore.activeArticleUrl || sourceItems[0]?.url) === src.url }"
                @click="activeCluster && webStore.loadArticle(activeCluster.id, { itemId: src.id || null, url: src.url || null })"
              >{{ src.sourceName || src.sourceId || $t('cosmos.web.reader.sourceN', { n: idx + 1 }) }}</button>
            </div>

            <!-- Inline Clean Article Tab -->
            <template v-if="webStore.readerTab === 'article'">
              <div v-if="webStore.articleLoading" class="cw-state-box">
                <div class="cw-spinner" aria-hidden="true"></div>
                <p>{{ $t('cosmos.web.reader.loadingArticle') }}</p>
              </div>
              <div v-else-if="webStore.articleError" class="cw-state-box cw-state-error">
                <p>{{ webStore.articleError }}</p>
                <div class="cw-state-actions">
                  <button
                    type="button"
                    class="cw-btn cw-btn-subtle"
                    @click="activeCluster && webStore.loadArticle(activeCluster.id, { force: true, itemId: webStore.activeArticleItemId || null, url: webStore.activeArticleUrl || null })"
                  >{{ $t('cosmos.web.action.retry') }}</button>
                  <button type="button" class="cw-btn cw-btn-primary" @click="triggerAiSynthesis">
                    {{ $t('cosmos.web.reader.aiSynthesizeCta') }}
                  </button>
                </div>
              </div>
              <template v-else>
                <div v-if="isFallbackArticle" class="cw-fallback-card">
                  <p class="cw-fallback-title">{{ $t('cosmos.web.reader.fallbackTitle') }}</p>
                  <p class="cw-fallback-desc">{{ $t('cosmos.web.reader.fallbackDesc') }}</p>
                  <button type="button" class="cw-btn cw-btn-primary" @click="triggerAiSynthesis">
                    {{ $t('cosmos.web.reader.aiSynthesizeCta') }}
                  </button>
                </div>
                <div v-if="renderedArticleHtml" class="cw-markdown-prose" v-html="renderedArticleHtml"></div>
                <div v-else-if="!isFallbackArticle" class="cw-state-box">
                  <p>{{ $t('cosmos.web.reader.emptyArticle') }}</p>
                  <button type="button" class="cw-btn cw-btn-primary" @click="triggerAiSynthesis">
                    {{ $t('cosmos.web.reader.aiSynthesizeCta') }}
                  </button>
                </div>
              </template>
            </template>

            <!-- Inline AI Brief Tab -->
            <template v-else>
              <div v-if="webStore.aiBriefLoading" class="cw-state-box">
                <div class="cw-spinner" aria-hidden="true"></div>
                <p>{{ $t('cosmos.web.ai.loading') }}</p>
              </div>
              <div v-else-if="webStore.aiBriefError" class="cw-state-box cw-state-error">
                <p>{{ webStore.aiBriefError }}</p>
                <button
                  type="button"
                  class="cw-btn cw-btn-primary"
                  @click="activeCluster && webStore.generateAiBrief(activeCluster.id, { itemId: webStore.activeArticleItemId || undefined, force: true })"
                >{{ $t('cosmos.web.action.retry') }}</button>
              </div>
              <div v-else-if="activeAiBrief" class="cw-ai-card">
                <div v-if="activeAiBrief.tldr" class="cw-ai-tldr">
                  <span class="cw-ai-kicker">{{ $t('cosmos.web.ai.tldr') }}</span>
                  <p>{{ activeAiBrief.tldr }}</p>
                </div>
                <div v-if="Array.isArray(activeAiBrief.bullets) && activeAiBrief.bullets.length" class="cw-ai-block">
                  <h4>{{ $t('cosmos.web.ai.keyPoints') }}</h4>
                  <ul class="cw-bullet-list">
                    <li v-for="(b, idx) in activeAiBrief.bullets" :key="idx">{{ b }}</li>
                  </ul>
                </div>
                <div v-if="activeAiBrief.impact" class="cw-ai-block">
                  <h4>{{ $t('cosmos.web.ai.impact') }}</h4>
                  <p>{{ activeAiBrief.impact }}</p>
                </div>
                <div v-if="!activeAiBrief.tldr && renderedAiMarkdownHtml" class="cw-markdown-prose" v-html="renderedAiMarkdownHtml"></div>
                <div v-if="Array.isArray(activeAiBrief.followUps) && activeAiBrief.followUps.length" class="cw-ai-block">
                  <h4>{{ $t('cosmos.web.ai.followUpsTitle') }}</h4>
                  <div class="cw-chip-group">
                    <button
                      v-for="(q, idx) in activeAiBrief.followUps"
                      :key="idx"
                      type="button"
                      class="cw-chip cw-chip-accent"
                      @click="applyFollowUp(q)"
                    >{{ q }}</button>
                  </div>
                </div>
              </div>
              <div v-else class="cw-state-box">
                <p>{{ $t('cosmos.web.ai.empty') }}</p>
                <button
                  type="button"
                  class="cw-btn cw-btn-primary"
                  @click="activeCluster && webStore.generateAiBrief(activeCluster.id, { itemId: webStore.activeArticleItemId || undefined, force: true })"
                >{{ $t('cosmos.web.ai.generateNow') }}</button>
              </div>
            </template>
          </div>

          <!-- Inline Dispatch-to-Planet Bar -->
          <div class="cw-drawer-footer cw-dispatch-bar cw-dispatch-compact">
            <div class="cw-dispatch-presets">
              <button
                v-for="preset in QUICK_DISPATCH_PRESETS"
                :key="preset.id"
                type="button"
                class="cw-chip"
                :class="{ 'cw-chip-accent': dispatchPresetId === preset.id }"
                :aria-pressed="dispatchPresetId === preset.id"
                @click="applyPreset(preset)"
              >{{ $t(preset.labelKey) }}</button>
            </div>
            <div v-if="selectedAiFollowUp" class="cw-dispatch-followup-pill">
              <span class="cw-chip cw-chip-accent">
                <span>{{ selectedAiFollowUp }}</span>
                <button
                  type="button"
                  class="cw-chip-remove"
                  :aria-label="$t('cosmos.web.action.remove')"
                  @click="clearSelectedAiFollowUp"
                >×</button>
              </span>
            </div>
            <div class="cw-dispatch-compact-row">
              <select
                v-model="dispatchAgentId"
                class="cw-select"
                :aria-label="$t('cosmos.web.dispatch.selectAgent')"
              >
                <option v-if="!availableAgents.length" value="">{{ $t('cosmos.web.dispatch.noAgent') }}</option>
                <option v-for="ag in availableAgents" :key="ag.id" :value="ag.id">
                  {{ ag.name || ag.id }}
                </option>
              </select>
              <input
                ref="inlineDispatchInput"
                v-model="dispatchPrompt"
                type="text"
                class="cw-input"
                :placeholder="$t('cosmos.web.dispatch.inputPlaceholder')"
                @keydown.enter.prevent="submitInlineDispatch('fly')"
              />
            </div>
            <div class="cw-dispatch-actions">
              <button
                type="button"
                class="cw-btn cw-btn-subtle"
                :disabled="!effectiveDispatchAgentId"
                @click="submitInlineDispatch('background')"
              >{{ $t('cosmos.web.dispatch.background') }}</button>
              <button
                type="button"
                class="cw-btn cw-btn-primary"
                :disabled="!effectiveDispatchAgentId"
                @click="submitInlineDispatch('fly')"
              >{{ $t('cosmos.web.dispatch.flyToSolar') }}</button>
            </div>
          </div>
        </template>

        <!-- MODE 2: Intelligence Feed List -->
        <template v-else>
          <div class="cw-drawer-header">
            <div class="cw-drawer-title-group">
              <h2 class="cw-drawer-title">{{ activeDomainTitle }}</h2>
              <span v-if="webStore.feedTotal" class="cw-meta-pill">{{ webStore.feedTotal }}</span>
            </div>
            <div class="cw-drawer-header-right">
              <div class="cw-segmented cw-segmented-sm" role="tablist">
                <button
                  type="button"
                  role="tab"
                  class="cw-seg-btn"
                  :class="{ 'is-active': webStore.sortMode === 'heat' }"
                  :aria-selected="webStore.sortMode === 'heat'"
                  @click="webStore.setSortMode('heat')"
                >{{ $t('cosmos.web.sort.heat') }}</button>
                <button
                  type="button"
                  role="tab"
                  class="cw-seg-btn"
                  :class="{ 'is-active': webStore.sortMode === 'latest' }"
                  :aria-selected="webStore.sortMode === 'latest'"
                  @click="webStore.setSortMode('latest')"
                >{{ $t('cosmos.web.sort.latest') }}</button>
              </div>
              <button
                type="button"
                class="cw-text-btn"
                :title="$t('cosmos.web.action.markAllRead')"
                @click="webStore.markAllRead()"
              >{{ $t('cosmos.web.action.markAllRead') }}</button>
            </div>
          </div>

          <div class="cw-drawer-scroll cw-feed-list" role="list">
            <!-- Loading skeleton -->
            <div v-if="(webStore.loading || webStore.feedLoading) && !webStore.feedItems.length" class="cw-state-box">
              <div class="cw-spinner" aria-hidden="true"></div>
              <p>{{ $t('cosmos.web.feed.loading') }}</p>
            </div>

            <!-- Error state -->
            <div v-else-if="webStore.error && !webStore.feedItems.length" class="cw-state-box cw-state-error">
              <p>{{ webStore.error }}</p>
              <button type="button" class="cw-btn cw-btn-primary" @click="webStore.fetchFeed({ reset: true })">
                {{ $t('cosmos.web.action.retry') }}
              </button>
            </div>

            <!-- Empty state -->
            <div v-else-if="!webStore.feedItems.length" class="cw-state-box">
              <p>{{ $t('cosmos.web.feed.empty') }}</p>
              <div class="cw-state-actions">
                <button
                  v-if="webStore.searchQuery || webStore.activeDomain !== 'all'"
                  type="button"
                  class="cw-btn cw-btn-subtle"
                  @click="clearSearch(); webStore.selectDomain('all')"
                >{{ $t('cosmos.web.feed.resetFilter') }}</button>
                <button type="button" class="cw-btn cw-btn-primary" @click="triggerRefresh">
                  {{ $t('cosmos.web.hud.refresh') }}
                </button>
              </div>
            </div>

            <!-- Feed Cards -->
            <template v-else>
              <article
                v-for="(item, idx) in webStore.feedItems"
                :key="item.id"
                role="listitem"
                tabindex="0"
                class="cw-feed-card"
                :class="{
                  'is-unread': item.unread !== false && !item.isRead,
                  'is-watch-hit': Boolean(item.watchHit),
                  'is-selected': (webStore.cursorClusterId || webStore.selectedClusterId) === item.id || focusedFeedIdx === idx,
                }"
                @mouseenter="onCardEnter(item)"
                @mouseleave="onCardLeave(item)"
                @click="openStory(item, 'article')"
                @keydown.enter.self.prevent="openStory(item, 'article')"
              >
                <div class="cw-card-top">
                  <div class="cw-card-badges">
                    <span class="cw-dot" :class="'cw-dot-' + (item.colorToken || 'cyan')"></span>
                    <span class="cw-card-domain">{{ domainLabelById(item.domainId) }}</span>
                    <span v-if="item.watchHit" class="cw-badge cw-badge-gold">{{ $t('cosmos.web.badge.watchHit') }}</span>
                  </div>
                  <span class="cw-card-time">{{ formatTime(item.publishedAt) }}</span>
                </div>

                <h3 class="cw-card-headline">{{ item.headline || item.title }}</h3>

                <p v-if="item.summaryExcerpt || item.excerpt" class="cw-card-excerpt">{{ item.summaryExcerpt || item.excerpt }}</p>

                <div class="cw-card-bottom">
                  <div class="cw-card-meta">
                    <span v-if="item.sourceNames && item.sourceNames.length" class="cw-card-sources">
                      {{ item.sourceNames.slice(0, 2).join(' · ') }}
                      <template v-if="item.sourceNames.length > 2"> +{{ item.sourceNames.length - 2 }}</template>
                    </span>
                    <span v-if="item.heatScore !== undefined" class="cw-card-heat">
                      {{ Math.round(item.heatScore) }}
                    </span>
                  </div>

                  <div class="cw-card-actions" @click.stop>
                    <button
                      type="button"
                      class="cw-card-act-btn"
                      :class="{ 'is-active': Boolean(item.isBookmarked ?? item.bookmarked) }"
                      :title="$t('cosmos.web.action.bookmark')"
                      :aria-label="$t('cosmos.web.action.bookmark')"
                      @click="webStore.toggleBookmark(item.id)"
                    >{{ (item.isBookmarked ?? item.bookmarked) ? '★' : '☆' }}</button>
                    <button
                      type="button"
                      class="cw-card-act-btn"
                      :title="$t('cosmos.web.reader.tabAi')"
                      @click="openStory(item, 'ai')"
                    >{{ $t('cosmos.web.action.aiBriefShort') }}</button>
                    <button
                      type="button"
                      class="cw-card-act-btn"
                      :title="$t('cosmos.web.action.dispatchShort')"
                      @click="quickDispatchCard(item)"
                    >{{ $t('cosmos.web.action.dispatchShort') }}</button>
                  </div>
                </div>
              </article>

              <!-- Load More -->
              <div v-if="webStore.feedHasMore" class="cw-load-more">
                <button
                  type="button"
                  class="cw-btn cw-btn-subtle"
                  :disabled="webStore.feedLoading"
                  @click="webStore.loadMoreFeed()"
                >{{ webStore.feedLoading ? $t('cosmos.web.feed.loading') : $t('cosmos.web.feed.loadMore') }}</button>
              </div>
            </template>
          </div>
        </template>
      </aside>

      <!-- Full-Screen Centered Reader & Daily Briefing Modal -->
      <CosmosWebReaderModal
        :agents="agents"
        :agent-to-planet="agentToPlanet"
        @toast="$emit('toast', $event)"
        @dispatch-to-planet="$emit('dispatch-to-planet', $event)"
      />

      <!-- Domain & Preferences Studio Modal -->
      <CosmosWebPrefsModal
        :agents="agents"
        @toast="$emit('toast', $event)"
      />
    </div>
  `,
};
