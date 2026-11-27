/**
 * CosmosWebReaderModal — Full-screen centered Glass Dialog for:
 *  Mode A: Expanded Article & AI Brief Reader (68ch comfortable typography)
 *  Mode B: Daily AI Star Briefing (multi-domain synthesis + clickable story refs)
 *
 * Uses Pinia `useCosmicWebStore`, `renderSafeMessageMarkdown`, and `$t('cosmos.web.*')`.
 */
import { useCosmicWebStore } from '../../../stores/cosmicWeb.js';
import { renderSafeMessageMarkdown } from '../../../utils/safe-message-markdown.js';
import { getLocale, t } from '../../../utils/i18n.js';

const PERSPECTIVE_OPTIONS = [
  { id: 'balanced', labelKey: 'cosmos.web.prefs.perspectiveBalanced' },
  { id: 'engineering', labelKey: 'cosmos.web.prefs.perspectiveEngineering' },
  { id: 'product', labelKey: 'cosmos.web.prefs.perspectiveBusiness' },
  { id: 'investing', labelKey: 'cosmos.web.prefs.perspectiveInvesting' },
];

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

export default {
  name: 'CosmosWebReaderModal',
  props: {
    agents: {
      type: Array,
      default: () => [],
    },
    agentsLive: {
      type: Boolean,
      default: true,
    },
    agentToPlanet: {
      type: Object,
      default: () => ({}),
    },
  },
  emits: ['toast', 'dispatch-to-planet', 'restore-focus'],
  setup() {
    const webStore = useCosmicWebStore();
    return { webStore };
  },
  data() {
    return {
      dispatchAgentId: '',
      dispatchPresetId: 'deepdive',
      dispatchPrompt: '',
      selectedAiFollowUp: '',
      briefPerspective: 'balanced',
      briefAgentId: '',
      copySuccess: false,
      PERSPECTIVE_OPTIONS,
      QUICK_DISPATCH_PRESETS,
    };
  },
  computed: {
    isDailyMode() {
      return Boolean(this.webStore.dailyBriefingOpen);
    },
    isExpandedArticleMode() {
      return Boolean(this.webStore.readerOpen && this.webStore.readerExpanded && !this.webStore.dailyBriefingOpen);
    },
    isOpen() {
      return this.isDailyMode || this.isExpandedArticleMode;
    },
    cluster() {
      return this.webStore.activeCluster;
    },
    article() {
      return this.webStore.articleData;
    },
    aiBrief() {
      return this.webStore.aiBriefData;
    },
    daily() {
      return this.webStore.dailyBriefingData;
    },
    sourceItems() {
      const items = this.cluster?.items || this.cluster?.sources || [];
      return Array.isArray(items) ? items.filter((s) => s && (s.url || s.sourceName)) : [];
    },
    primarySafeUrl() {
      const candidate = this.webStore.activeArticleUrl
        || this.article?.url
        || this.cluster?.primaryUrl
        || this.cluster?.url
        || this.sourceItems[0]?.url
        || '';
      return isSafeHttpUrl(candidate) ? candidate : '';
    },
    isFallbackArticle() {
      const q = this.article?.quality;
      return q === 'search_only' || q === 'blocked' || q === 'metadata_only';
    },
    renderedArticleHtml() {
      const md = this.article?.markdown || this.article?.content || this.article?.excerpt || '';
      if (!md) return '';
      return renderSafeMessageMarkdown(md);
    },
    renderedAiMarkdownHtml() {
      const md = this.aiBrief?.fullMarkdown || this.aiBrief?.markdown || this.aiBrief?.rawMarkdown || '';
      if (!md) return '';
      return renderSafeMessageMarkdown(md);
    },
    dailySignals() {
      if (Array.isArray(this.daily?.signalsToWatch) && this.daily.signalsToWatch.length) return this.daily.signalsToWatch;
      return [];
    },
    briefingCapableAgents() {
      if (!this.agentsLive) return [];
      return (this.agents || []).filter(
        (a) => Boolean(a && a.online && Array.isArray(a.capabilities) && a.capabilities.includes('cosmic_web_briefing')),
      );
    },
    availableAgents() {
      const list = Array.isArray(this.agents) ? this.agents : [];
      return list.slice().sort((a, b) => Number(Boolean(b?.online)) - Number(Boolean(a?.online)));
    },
    effectiveDispatchAgentId() {
      if (this.dispatchAgentId) return this.dispatchAgentId;
      if (this.webStore.prefs?.preferredAgentId) return this.webStore.prefs.preferredAgentId;
      const online = this.availableAgents.find((a) => a && a.online);
      return online?.id || this.availableAgents[0]?.id || '';
    },
    isBookmarked() {
      return Boolean(this.cluster?.isBookmarked ?? this.cluster?.bookmarked);
    },
  },
  watch: {
    briefingCapableAgents(list) {
      if (this.briefAgentId && !list.some((a) => a.id === this.briefAgentId)) {
        this.briefAgentId = '';
      }
    },
    isOpen: {
      immediate: true,
      handler(open, prev) {
        if (open) {
          this._dockRequested = false;
          this._previousActiveElement = typeof document !== 'undefined' ? document.activeElement : null;
          this._lastOpenMode = this.isDailyMode ? 'daily' : 'article';
          this.briefPerspective = this.webStore.prefs?.defaultPerspective || 'balanced';
          const prefAgent = this.webStore.prefs?.preferredAgentId || '';
          this.briefAgentId = this.briefingCapableAgents.some((a) => a.id === prefAgent) ? prefAgent : '';
          this.dispatchAgentId = this.effectiveDispatchAgentId;
          this.attachFocusContainment();
          this.$nextTick(() => {
            this.$refs.modalShell?.focus?.();
          });
        } else {
          this.detachFocusContainment();
          if (prev === true) {
            const prevEl = this._previousActiveElement;
            const closedMode = this._lastOpenMode || 'article';
            const dockRequested = Boolean(this._dockRequested);
            this._previousActiveElement = null;
            this._dockRequested = false;
            this.$nextTick(() => {
              if (dockRequested) {
                this.$emit('restore-focus', { mode: closedMode, reason: 'dock' });
                return;
              }
              const canRestorePrev = Boolean(
                prevEl
                && prevEl !== document.body
                && prevEl !== document.documentElement
                && prevEl.isConnected
                && typeof prevEl.focus === 'function',
              );
              if (canRestorePrev) {
                prevEl.focus();
              } else {
                this.$emit('restore-focus', { mode: closedMode });
              }
            });
          }
        }
      },
    },
    'webStore.readerClusterId'() {
      this.dispatchPrompt = '';
      this.selectedAiFollowUp = '';
      this.dispatchPresetId = 'deepdive';
      this.copySuccess = false;
    },
    'webStore.sourceSelectionRev'() {
      this.selectedAiFollowUp = '';
      this.copySuccess = false;
    },
  },
  beforeUnmount() {
    this.detachFocusContainment();
  },
  methods: {
    domainLabel(domainId) {
      const d = (this.webStore.domains || []).find((x) => x.id === domainId);
      if (!d) return domainId || '';
      return getLocale() === 'en' ? (d.labelEn || d.labelZh || d.id) : (d.labelZh || d.labelEn || d.id);
    },
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
      const root = this.$refs.modalShell;
      if (!root) return;
      if (e.target && !root.contains(e.target)) {
        const focusables = this.getFocusableElements(root);
        if (focusables.length) focusables[0].focus();
        else root.focus();
      }
    },
    handleTabTrap(e) {
      const root = this.$refs.modalShell;
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
    closeModal() {
      if (this.isDailyMode) {
        this.webStore.closeDailyBriefing();
      } else {
        this.webStore.readerExpanded = false;
      }
    },
    closeAllReader() {
      this.webStore.closeDailyBriefing();
      this.webStore.closeClusterReader();
    },
    collapseToDrawer() {
      this._dockRequested = true;
      this.webStore.drawerCollapsed = false;
      this.webStore.readerExpanded = false;
    },
    switchTab(tab) {
      this.webStore.readerTab = tab;
      if (tab === 'ai' && !this.webStore.aiBriefData && !this.webStore.aiBriefLoading && this.cluster?.id) {
        this.webStore.generateAiBrief(this.cluster.id, {
          perspective: this.briefPerspective,
          agentId: this.briefAgentId || undefined,
          itemId: this.webStore.activeArticleItemId || undefined,
        });
      }
    },
    selectSource(src) {
      if (!this.cluster?.id || (!src?.id && !src?.url)) return;
      this.webStore.selectArticleSource(this.cluster.id, {
        itemId: src.id || null,
        url: src.url || null,
        perspective: this.briefPerspective,
        agentId: this.briefAgentId || undefined,
      });
    },
    triggerAiSynthesis() {
      if (!this.cluster?.id) return;
      this.webStore.readerTab = 'ai';
      this.webStore.generateAiBrief(this.cluster.id, {
        mode: 'synthesize',
        perspective: this.briefPerspective,
        agentId: this.briefAgentId || undefined,
        itemId: this.webStore.activeArticleItemId || undefined,
        force: true,
      });
    },
    regenerateAiBrief() {
      if (!this.cluster?.id) return;
      this.webStore.generateAiBrief(this.cluster.id, {
        mode: 'brief',
        perspective: this.briefPerspective,
        agentId: this.briefAgentId || undefined,
        itemId: this.webStore.activeArticleItemId || undefined,
        force: true,
      });
    },
    regenerateDaily() {
      this.webStore.openDailyBriefing({
        agentId: this.briefAgentId || undefined,
        perspective: this.briefPerspective,
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
        this.$refs.dispatchInput?.focus?.();
      });
    },
    clearSelectedAiFollowUp() {
      this.selectedAiFollowUp = '';
    },
    submitDispatch(mode = 'fly') {
      const agentId = this.effectiveDispatchAgentId;
      if (!agentId) {
        this.$emit('toast', t('cosmos.web.dispatch.noAgent'));
        return;
      }
      const title = this.isDailyMode
        ? (this.daily?.headline || t('cosmos.web.daily.title'))
        : (this.cluster?.headline || this.cluster?.title || '');
      const userNote = String(this.dispatchPrompt || '').trim();
      const planetId = this.agentToPlanet?.[agentId] || null;

      this.$emit('dispatch-to-planet', {
        agentId,
        planetId,
        mode, // 'fly' | 'background'
        intent: this.dispatchPresetId || 'deepdive',
        userNote,
        aiFollowUp: this.selectedAiFollowUp || null,
        clusterId: this.isDailyMode ? null : (this.cluster?.id || null),
        headline: title,
        url: this.isDailyMode ? null : (this.primarySafeUrl || null),
        summary: this.isDailyMode
          ? (this.daily?.overview || '')
          : (this.aiBrief?.tldr || this.article?.excerpt || ''),
      });

      this.$emit('toast', mode === 'fly'
        ? t('cosmos.web.dispatch.sentFly')
        : t('cosmos.web.dispatch.sentBackground'));
      this.dispatchPrompt = '';
      this.selectedAiFollowUp = '';
      this.dispatchPresetId = 'deepdive';
      if (mode === 'fly') {
        this.closeAllReader();
      }
    },
    async copyMarkdown() {
      const text = this.webStore.readerTab === 'ai'
        ? (this.aiBrief?.fullMarkdown || this.aiBrief?.markdown || this.aiBrief?.tldr || '')
        : (this.article?.markdown || this.article?.content || this.cluster?.headline || '');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        this.copySuccess = true;
        this.$emit('toast', t('cosmos.web.reader.copied'));
        setTimeout(() => { this.copySuccess = false; }, 1800);
      } catch {
        this.$emit('toast', t('cosmos.web.reader.copyFailed'));
      }
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
  },
  template: `
    <div
      v-if="isOpen"
      class="cw-modal-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="isDailyMode ? (daily?.headline || $t('cosmos.web.daily.title')) : (cluster?.headline || $t('cosmos.web.reader.title'))"
      @pointerdown.stop
      @wheel.stop
      @click.self="closeModal"
      @keydown.esc.stop.prevent="closeModal"
    >
      <div ref="modalShell" class="cw-modal-shell cw-reader-modal" tabindex="-1">
        <!-- Fixed Header -->
        <header class="cw-modal-header">
          <div class="cw-modal-header-left">
            <template v-if="isDailyMode">
              <span class="cw-badge cw-badge-accent">{{ $t('cosmos.web.daily.badge') }}</span>
              <h2 class="cw-modal-title">{{ daily?.headline || $t('cosmos.web.daily.title') }}</h2>
            </template>
            <template v-else>
              <span v-if="cluster?.domainId" class="cw-badge" :class="'cw-tone-' + (cluster?.colorToken || 'cyan')">
                {{ domainLabel(cluster.domainId) }}
              </span>
              <div class="cw-segmented" role="tablist">
                <button
                  type="button"
                  role="tab"
                  class="cw-seg-btn"
                  :class="{ 'is-active': webStore.readerTab === 'article' }"
                  :aria-selected="webStore.readerTab === 'article'"
                  @click="switchTab('article')"
                >{{ $t('cosmos.web.reader.tabArticle') }}</button>
                <button
                  type="button"
                  role="tab"
                  class="cw-seg-btn"
                  :class="{ 'is-active': webStore.readerTab === 'ai' }"
                  :aria-selected="webStore.readerTab === 'ai'"
                  @click="switchTab('ai')"
                >{{ $t('cosmos.web.reader.tabAi') }}</button>
              </div>
            </template>
          </div>

          <div class="cw-modal-header-actions">
            <template v-if="!isDailyMode && cluster">
              <button
                type="button"
                class="cw-icon-btn"
                :class="{ 'is-active': isBookmarked }"
                :title="$t('cosmos.web.action.bookmark')"
                :aria-label="$t('cosmos.web.action.bookmark')"
                @click="webStore.toggleBookmark(cluster.id)"
              >{{ isBookmarked ? '★' : '☆' }}</button>
              <button
                type="button"
                class="cw-text-btn"
                @click="copyMarkdown"
              >{{ copySuccess ? $t('cosmos.web.reader.copied') : $t('cosmos.web.reader.copyMd') }}</button>
              <button
                type="button"
                class="cw-text-btn"
                @click="collapseToDrawer"
              >{{ $t('cosmos.web.reader.dockToDrawer') }}</button>
            </template>
            <button
              type="button"
              class="cw-icon-btn"
              :title="$t('cosmos.web.action.close')"
              :aria-label="$t('cosmos.web.action.close')"
              @click="closeModal"
            >✕</button>
          </div>
        </header>

        <!-- Scrollable Body -->
        <div class="cw-modal-body cw-reader-body">
          <!-- MODE B: Daily AI Star Briefing -->
          <div v-if="isDailyMode" class="cw-reading-column">
            <div class="cw-daily-controls">
              <label class="cw-inline-field">
                <span>{{ $t('cosmos.web.prefs.perspectiveLabel') }}</span>
                <select v-model="briefPerspective" class="cw-select">
                  <option v-for="opt in PERSPECTIVE_OPTIONS" :key="opt.id" :value="opt.id">
                    {{ $t(opt.labelKey) }}
                  </option>
                </select>
              </label>
              <label class="cw-inline-field">
                <span>{{ $t('cosmos.web.prefs.agentLabel') }}</span>
                <select v-model="briefAgentId" class="cw-select">
                  <option value="">{{ $t('cosmos.web.prefs.agentAuto') }}</option>
                  <option v-for="ag in briefingCapableAgents" :key="ag.id" :value="ag.id">
                    {{ ag.name || ag.id }}
                  </option>
                </select>
              </label>
              <button
                type="button"
                class="cw-btn cw-btn-subtle"
                :disabled="webStore.dailyBriefingLoading"
                @click="regenerateDaily"
              >{{ $t('cosmos.web.daily.regenerate') }}</button>
            </div>

            <div v-if="webStore.dailyBriefingLoading" class="cw-state-box">
              <div class="cw-spinner" aria-hidden="true"></div>
              <p>{{ $t('cosmos.web.daily.loading') }}</p>
            </div>

            <div v-else-if="webStore.dailyBriefingError" class="cw-state-box cw-state-error">
              <p>{{ webStore.dailyBriefingError }}</p>
              <button type="button" class="cw-btn cw-btn-primary" @click="regenerateDaily">
                {{ $t('cosmos.web.action.retry') }}
              </button>
            </div>

            <template v-else-if="daily">
              <div v-if="daily.generatedAt || daily.agentName" class="cw-meta-row">
                <span v-if="daily.agentName">{{ $t('cosmos.web.ai.byAgent', { name: daily.agentName }) }}</span>
                <span v-if="daily.generatedAt">{{ formatTime(daily.generatedAt) }}</span>
              </div>

              <p v-if="daily.overview" class="cw-daily-overview">{{ daily.overview }}</p>

              <!-- Multi-domain briefing sections -->
              <section
                v-for="(sec, idx) in (daily.sections || [])"
                :key="sec.id || sec.domain || idx"
                class="cw-brief-section"
              >
                <h3 class="cw-section-heading">
                  <span v-if="sec.colorToken" class="cw-dot" :class="'cw-dot-' + sec.colorToken"></span>
                  {{ sec.domain || sec.title || domainLabel(sec.domainId) }}
                </h3>
                <ul v-if="Array.isArray(sec.bullets) && sec.bullets.length" class="cw-bullet-list">
                  <li v-for="(b, bIdx) in sec.bullets" :key="bIdx">{{ b }}</li>
                </ul>
              </section>

              <!-- Signals to Watch -->
              <section v-if="dailySignals.length" class="cw-brief-section">
                <h3 class="cw-section-heading">{{ $t('cosmos.web.daily.signalsTitle') }}</h3>
                <div class="cw-chip-group">
                  <button
                    v-for="(sig, idx) in dailySignals"
                    :key="idx"
                    type="button"
                    class="cw-chip"
                    @click="applyFollowUp(typeof sig === 'string' ? sig : (sig.label || sig.title))"
                  >{{ typeof sig === 'string' ? sig : (sig.label || sig.title) }}</button>
                </div>
              </section>

              <!-- Follow-up Questions -->
              <section v-if="Array.isArray(daily.followUps) && daily.followUps.length" class="cw-brief-section">
                <h3 class="cw-section-heading">{{ $t('cosmos.web.ai.followUpsTitle') }}</h3>
                <div class="cw-chip-group">
                  <button
                    v-for="(q, idx) in daily.followUps"
                    :key="idx"
                    type="button"
                    class="cw-chip cw-chip-accent"
                    @click="applyFollowUp(q)"
                  >{{ q }}</button>
                </div>
              </section>
            </template>

            <div v-else class="cw-state-box">
              <p>{{ $t('cosmos.web.daily.empty') }}</p>
              <button type="button" class="cw-btn cw-btn-primary" @click="regenerateDaily">
                {{ $t('cosmos.web.daily.generateNow') }}
              </button>
            </div>
          </div>

          <!-- MODE A: Expanded Article & AI Brief Reader -->
          <div v-else class="cw-reading-column">
            <h1 class="cw-article-headline">{{ cluster?.headline || cluster?.title || '' }}</h1>

            <div class="cw-meta-row">
              <span v-if="cluster?.publishedAt">{{ formatTime(cluster.publishedAt) }}</span>
              <span v-if="cluster?.heatScore !== undefined">
                {{ $t('cosmos.web.feed.heatLabel', { score: Math.round(cluster.heatScore) }) }}
              </span>
              <a
                v-if="primarySafeUrl"
                :href="primarySafeUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="cw-origin-link"
              >{{ $t('cosmos.web.reader.openOriginal') }} ↗</a>
            </div>

            <!-- Multi-source switcher chips -->
            <div v-if="sourceItems.length > 1" class="cw-source-pills" role="list">
              <button
                v-for="(src, idx) in sourceItems"
                :key="src.id || src.url || idx"
                type="button"
                class="cw-source-pill"
                :class="{ 'is-active': (webStore.activeArticleItemId && src.id) ? webStore.activeArticleItemId === src.id : (webStore.activeArticleUrl || sourceItems[0]?.url) === src.url }"
                @click="selectSource(src)"
              >{{ src.sourceName || src.sourceId || $t('cosmos.web.reader.sourceN', { n: idx + 1 }) }}</button>
            </div>

            <!-- TAB 1: Clean Article -->
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
                    @click="webStore.loadArticle(cluster.id, { force: true, itemId: webStore.activeArticleItemId || null, url: webStore.activeArticleUrl || null })"
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
                  <div class="cw-state-actions">
                    <button type="button" class="cw-btn cw-btn-primary" @click="triggerAiSynthesis">
                      {{ $t('cosmos.web.reader.aiSynthesizeCta') }}
                    </button>
                    <a
                      v-if="primarySafeUrl"
                      :href="primarySafeUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="cw-btn cw-btn-subtle"
                    >{{ $t('cosmos.web.reader.openOriginal') }} ↗</a>
                  </div>
                </div>

                <div
                  v-if="renderedArticleHtml"
                  class="cw-markdown-prose"
                  v-html="renderedArticleHtml"
                ></div>
                <div v-else-if="!isFallbackArticle" class="cw-state-box">
                  <p>{{ $t('cosmos.web.reader.emptyArticle') }}</p>
                  <button type="button" class="cw-btn cw-btn-primary" @click="triggerAiSynthesis">
                    {{ $t('cosmos.web.reader.aiSynthesizeCta') }}
                  </button>
                </div>
              </template>
            </template>

            <!-- TAB 2: AI Brief -->
            <template v-else>
              <div class="cw-daily-controls">
                <label class="cw-inline-field">
                  <span>{{ $t('cosmos.web.prefs.perspectiveLabel') }}</span>
                  <select v-model="briefPerspective" class="cw-select">
                    <option v-for="opt in PERSPECTIVE_OPTIONS" :key="opt.id" :value="opt.id">
                      {{ $t(opt.labelKey) }}
                    </option>
                  </select>
                </label>
                <label class="cw-inline-field">
                  <span>{{ $t('cosmos.web.prefs.agentLabel') }}</span>
                  <select v-model="briefAgentId" class="cw-select">
                    <option value="">{{ $t('cosmos.web.prefs.agentAuto') }}</option>
                    <option v-for="ag in briefingCapableAgents" :key="ag.id" :value="ag.id">
                      {{ ag.name || ag.id }}
                    </option>
                  </select>
                </label>
                <button
                  type="button"
                  class="cw-btn cw-btn-subtle"
                  :disabled="webStore.aiBriefLoading"
                  @click="regenerateAiBrief"
                >{{ $t('cosmos.web.ai.regenerate') }}</button>
              </div>

              <div v-if="webStore.aiBriefLoading" class="cw-state-box">
                <div class="cw-spinner" aria-hidden="true"></div>
                <p>{{ $t('cosmos.web.ai.loading') }}</p>
              </div>

              <div v-else-if="webStore.aiBriefError" class="cw-state-box cw-state-error">
                <p>{{ webStore.aiBriefError }}</p>
                <button type="button" class="cw-btn cw-btn-primary" @click="regenerateAiBrief">
                  {{ $t('cosmos.web.action.retry') }}
                </button>
              </div>

              <div v-else-if="aiBrief" class="cw-ai-card">
                <div v-if="aiBrief.tldr" class="cw-ai-tldr">
                  <span class="cw-ai-kicker">{{ $t('cosmos.web.ai.tldr') }}</span>
                  <p>{{ aiBrief.tldr }}</p>
                </div>

                <div v-if="Array.isArray(aiBrief.bullets) && aiBrief.bullets.length" class="cw-ai-block">
                  <h4>{{ $t('cosmos.web.ai.keyPoints') }}</h4>
                  <ul class="cw-bullet-list">
                    <li v-for="(b, idx) in aiBrief.bullets" :key="idx">{{ b }}</li>
                  </ul>
                </div>

                <div v-if="aiBrief.impact" class="cw-ai-block">
                  <h4>{{ $t('cosmos.web.ai.impact') }}</h4>
                  <p>{{ aiBrief.impact }}</p>
                </div>

                <div
                  v-if="!aiBrief.tldr && renderedAiMarkdownHtml"
                  class="cw-markdown-prose"
                  v-html="renderedAiMarkdownHtml"
                ></div>

                <div v-if="Array.isArray(aiBrief.followUps) && aiBrief.followUps.length" class="cw-ai-block">
                  <h4>{{ $t('cosmos.web.ai.followUpsTitle') }}</h4>
                  <div class="cw-chip-group">
                    <button
                      v-for="(q, idx) in aiBrief.followUps"
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
                <button type="button" class="cw-btn cw-btn-primary" @click="regenerateAiBrief">
                  {{ $t('cosmos.web.ai.generateNow') }}
                </button>
              </div>
            </template>
          </div>
        </div>

        <!-- Fixed Bottom Interactive Dispatch-to-Planet Bar -->
        <footer class="cw-modal-footer cw-dispatch-bar">
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
          <div class="cw-dispatch-row">
            <select
              v-model="dispatchAgentId"
              class="cw-select cw-dispatch-agent"
              :aria-label="$t('cosmos.web.dispatch.selectAgent')"
            >
              <option v-if="!availableAgents.length" value="">{{ $t('cosmos.web.dispatch.noAgent') }}</option>
              <option v-for="ag in availableAgents" :key="ag.id" :value="ag.id">
                {{ ag.name || ag.id }}{{ ag.online ? '' : ' (' + $t('cosmos.web.status.offline') + ')' }}
              </option>
            </select>
            <input
              ref="dispatchInput"
              v-model="dispatchPrompt"
              type="text"
              class="cw-input cw-dispatch-input"
              :placeholder="$t('cosmos.web.dispatch.inputPlaceholder')"
              @keydown.enter.prevent="submitDispatch('fly')"
            />
            <div class="cw-dispatch-actions">
              <button
                type="button"
                class="cw-btn cw-btn-subtle"
                :disabled="!effectiveDispatchAgentId"
                @click="submitDispatch('background')"
              >{{ $t('cosmos.web.dispatch.background') }}</button>
              <button
                type="button"
                class="cw-btn cw-btn-primary"
                :disabled="!effectiveDispatchAgentId"
                @click="submitDispatch('fly')"
              >{{ $t('cosmos.web.dispatch.flyToSolar') }}</button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  `,
};
