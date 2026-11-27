/**
 * CosmosWebReaderModal — Full-screen centered Cosmic Glass Magazine Dialog for:
 *  Mode A: Expanded AI Web-Researched Deep Intelligence Report (68ch comfortable typography)
 *  Mode B: Daily AI Star Briefing (multi-domain synthesis + signals + whispering prompts)
 *
 * Uses Pinia `useCosmicWebStore`, `renderSafeMessageMarkdown`, and `$t('cosmos.web.*')`.
 */
import { useCosmicWebStore } from '../../../stores/cosmicWeb.js';
import { renderCosmicWebProse } from '../../../utils/safe-message-markdown.js';
import { getLocale, t } from '../../../utils/i18n.js';

const PERSPECTIVE_OPTIONS = [
  { id: 'balanced', labelKey: 'cosmos.web.prefs.perspectiveBalanced', shortKey: 'cosmos.web.report.perspectiveBalancedShort' },
  { id: 'engineering', labelKey: 'cosmos.web.prefs.perspectiveEngineering', shortKey: 'cosmos.web.report.perspectiveEngineeringShort' },
  { id: 'product', labelKey: 'cosmos.web.prefs.perspectiveBusiness', shortKey: 'cosmos.web.report.perspectiveBusinessShort' },
  { id: 'investing', labelKey: 'cosmos.web.prefs.perspectiveInvesting', shortKey: 'cosmos.web.report.perspectiveInvestingShort' },
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

function mergeVerifiedMedia(aiMedia, clusterMedia, failedSet) {
  const seen = new Set();
  const out = [];
  for (const list of [aiMedia, clusterMedia]) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const src = typeof m.proxyUrl === 'string' && m.proxyUrl.trim() ? m.proxyUrl.trim() : '';
      if (!src || seen.has(src) || (failedSet && failedSet[src])) continue;
      seen.add(src);
      out.push({
        proxyUrl: src,
        kind: m.kind === 'gif' ? 'gif' : 'image',
        caption: typeof m.caption === 'string' ? m.caption : '',
        sourceName: typeof m.sourceName === 'string' ? m.sourceName : '',
      });
    }
  }
  return out;
}

function mergeCommunityComments(aiComments, clusterComments) {
  const seen = new Set();
  const out = [];
  for (const list of [aiComments, clusterComments]) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const text = String(c.text || c.body || c.quote || '').trim();
      if (!text) continue;
      const key = `${c.platform || ''}:${text.slice(0, 48)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        platform: c.platform || c.source || '',
        author: c.author || c.user || '',
        votes: c.votes ?? c.likes ?? c.score ?? null,
        votesLabel: c.votesLabel || '',
        text,
      });
    }
  }
  return out;
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
      composerInput: '',
      agentPickerOpen: false,
      briefPerspective: 'balanced',
      briefAgentId: '',
      copySuccess: false,
      failedMediaUrls: {},
      PERSPECTIVE_OPTIONS,
    };
  },
  computed: {
    isDailyMode() {
      return Boolean(this.webStore.dailyBriefingOpen);
    },
    isExpandedReportMode() {
      return Boolean(this.webStore.readerOpen && this.webStore.readerExpanded && !this.webStore.dailyBriefingOpen);
    },
    isOpen() {
      return this.isDailyMode || this.isExpandedReportMode;
    },
    cluster() {
      return this.webStore.activeCluster;
    },
    aiBrief() {
      return this.webStore.aiBriefData;
    },
    daily() {
      return this.webStore.dailyBriefingData;
    },
    sourceFootnotes() {
      const items = this.cluster?.items || this.cluster?.sources || [];
      if (!Array.isArray(items)) return [];
      const seen = new Set();
      const out = [];
      for (const s of items) {
        if (!s) continue;
        const name = s.sourceName || s.sourceId || '';
        const url = isSafeHttpUrl(s.url) ? s.url : '';
        if (!name && !url) continue;
        const key = `${name}:${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: s.id || key, name: name || url, url });
      }
      return out.slice(0, 8);
    },
    primarySafeUrl() {
      const candidate = this.webStore.activeArticleUrl
        || this.cluster?.primaryUrl
        || this.cluster?.url
        || this.sourceFootnotes[0]?.url
        || '';
      return isSafeHttpUrl(candidate) ? candidate : '';
    },
    activeBriefEvidenceCount() {
      if (this.aiBrief?.researched !== true) return 0;
      if (this.aiBrief?.evidenceCount == null) return 0;
      const n = Number(this.aiBrief.evidenceCount);
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    renderedCleanArticleHtml() {
      const md = this.webStore.articleData?.markdown || this.webStore.articleData?.contentMd || '';
      return md ? renderCosmicWebProse(md) : '';
    },
    activeSelectedItem() {
      const items = Array.isArray(this.cluster?.items) ? this.cluster.items : [];
      if (!items.length) return null;
      if (this.webStore.activeArticleItemId) {
        const hit = items.find((it) => it && it.id === this.webStore.activeArticleItemId);
        if (hit) return hit;
      }
      if (this.webStore.activeArticleUrl) {
        const byUrl = items.find((it) => it && it.url === this.webStore.activeArticleUrl);
        if (byUrl) return byUrl;
      }
      return items[0];
    },
    fallbackExcerpt() {
      return String(
        this.activeSelectedItem?.summaryExcerpt
        || this.activeSelectedItem?.summary
        || this.cluster?.summaryExcerpt
        || this.cluster?.excerpt
        || '',
      ).trim();
    },
    safeReportCitations() {
      const list = this.aiBrief?.citations;
      if (!Array.isArray(list) || !list.length) return [];
      const seen = new Set();
      const out = [];
      for (const c of list) {
        if (!c || !isSafeHttpUrl(c.url)) continue;
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        out.push({
          url: c.url,
          label: c.title || c.sourceName || c.source || c.url,
        });
      }
      return out.slice(0, 6);
    },
    verifiedMedia() {
      return mergeVerifiedMedia(
        this.aiBrief?.media,
        this.cluster?.media,
        this.failedMediaUrls,
      );
    },
    communityComments() {
      return mergeCommunityComments(
        this.aiBrief?.communityHighlights,
        this.cluster?.communityComments,
      );
    },
    reportSections() {
      const secs = this.aiBrief?.sections;
      if (!Array.isArray(secs) || !secs.length) return [];
      return secs
        .filter((s) => s && (s.heading || s.title || s.body || s.content || (Array.isArray(s.bullets) && s.bullets.length)))
        .map((s) => ({
          heading: s.heading || s.title || '',
          html: (s.body || s.content) ? renderCosmicWebProse(String(s.body || s.content)) : '',
          bullets: Array.isArray(s.bullets) ? s.bullets.filter(Boolean) : [],
        }));
    },
    renderedAiMarkdownHtml() {
      const md = this.aiBrief?.fullMarkdown || this.aiBrief?.markdown || this.aiBrief?.rawMarkdown || '';
      return md ? renderCosmicWebProse(md) : '';
    },
    dailySignals() {
      return Array.isArray(this.daily?.signalsToWatch) && this.daily.signalsToWatch.length
        ? this.daily.signalsToWatch
        : [];
    },
    briefingCapableAgents() {
      if (!this.agentsLive) return [];
      return (this.agents || []).filter(
        (a) => Boolean(a && a.online && Array.isArray(a.capabilities) && a.capabilities.includes('cosmic_web_briefing')),
      );
    },
    followUpCapableAgents() {
      if (!this.agentsLive) return [];
      return (this.agents || []).filter(
        (a) => Boolean(a && a.online && Array.isArray(a.capabilities) && a.capabilities.includes('cosmic_web_follow_up')),
      );
    },
    canUseInlineFollowUp() {
      if (!this.agentsLive) return true;
      return this.followUpCapableAgents.length > 0;
    },
    availableAgents() {
      const list = Array.isArray(this.agents) ? this.agents : [];
      return list.slice().sort((a, b) => Number(Boolean(b?.online)) - Number(Boolean(a?.online)));
    },
    effectiveDispatchAgentId() {
      if (this.dispatchAgentId && this.availableAgents.some((a) => a && a.id === this.dispatchAgentId)) {
        return this.dispatchAgentId;
      }
      if (this.webStore.prefs?.preferredAgentId && this.availableAgents.some((a) => a && a.id === this.webStore.prefs.preferredAgentId)) {
        return this.webStore.prefs.preferredAgentId;
      }
      const online = this.availableAgents.find((a) => a && a.online);
      return online?.id || this.availableAgents[0]?.id || '';
    },
    effectiveBriefingAgentId() {
      const cand = this.briefAgentId || this.effectiveDispatchAgentId;
      if (cand && this.briefingCapableAgents.some((a) => a.id === cand)) {
        return cand;
      }
      return undefined;
    },
    effectiveFollowUpAgentId() {
      const cand = this.briefAgentId || this.effectiveDispatchAgentId;
      if (cand && this.followUpCapableAgents.some((a) => a.id === cand)) {
        return cand;
      }
      return undefined;
    },
    selectedAgentObj() {
      return this.availableAgents.find((a) => a && a.id === this.effectiveDispatchAgentId) || null;
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
          this._lastOpenMode = this.isDailyMode ? 'daily' : 'report';
          this.briefPerspective = this.webStore.prefs?.defaultPerspective || 'balanced';
          const prefAgent = this.webStore.prefs?.preferredAgentId || '';
          this.briefAgentId = this.briefingCapableAgents.some((a) => a.id === prefAgent) ? prefAgent : '';
          this.dispatchAgentId = this.effectiveDispatchAgentId;
          this.agentPickerOpen = false;
          this.attachFocusContainment();
          this.$nextTick(() => {
            this.$refs.modalShell?.focus?.();
          });
        } else {
          this.detachFocusContainment();
          this.agentPickerOpen = false;
          if (prev === true) {
            const prevEl = this._previousActiveElement;
            const closedMode = this._lastOpenMode || 'report';
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
      this.composerInput = '';
      this.agentPickerOpen = false;
      this.copySuccess = false;
      this.failedMediaUrls = {};
    },
    'webStore.sourceSelectionRev'() {
      this.composerInput = '';
      this.failedMediaUrls = {};
    },
  },
  mounted() {
    document.addEventListener('pointerdown', this.handleOutsideAgentPicker);
  },
  beforeUnmount() {
    this.detachFocusContainment();
    document.removeEventListener('pointerdown', this.handleOutsideAgentPicker);
  },
  methods: {
    handleOutsideAgentPicker(e) {
      if (!this.agentPickerOpen) return;
      const wrap = this.$refs.modalAgentPickerWrap;
      if (wrap && !wrap.contains(e.target)) {
        this.agentPickerOpen = false;
      }
    },
    domainLabel(domainId) {
      const d = (this.webStore.domains || []).find((x) => x.id === domainId);
      if (!d) return domainId || '';
      return getLocale() === 'en' ? (d.labelEn || d.labelZh || d.id) : (d.labelZh || d.labelEn || d.id);
    },
    agentPlanetClass(agentId) {
      const p = (agentId && this.agentToPlanet?.[agentId]) ? this.agentToPlanet[agentId] : 'default';
      return `is-${p}`;
    },
    isAgentBriefingCapable(ag) {
      return Boolean(ag && ag.online && Array.isArray(ag.capabilities) && ag.capabilities.includes('cosmic_web_briefing'));
    },
    onMediaError(url) {
      if (!url) return;
      this.failedMediaUrls = { ...this.failedMediaUrls, [url]: true };
    },
    renderFollowUpHtml(text) {
      return text ? renderCosmicWebProse(String(text)) : '';
    },
    selectStorySource(src) {
      if (!this.cluster?.id || !src?.id) return;
      this.webStore.selectArticleSource(this.cluster.id, {
        itemId: src.id,
        url: src.url || null,
        perspective: this.briefPerspective,
        agentId: this.effectiveBriefingAgentId,
      });
    },
    onBackdropEsc() {
      if (this.webStore.lightboxMedia) return;
      this.closeModal();
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
      if (!this.isOpen || this.webStore.lightboxMedia) return;
      if (e.key === 'Tab') {
        this.handleTabTrap(e);
      }
    },
    handleModalFocusIn(e) {
      if (!this.isOpen || this.webStore.lightboxMedia) return;
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
    switchPerspective(pId) {
      if (!pId || this.briefPerspective === pId || !this.cluster?.id) return;
      this.briefPerspective = pId;
      this.regenerateAiBrief();
    },
    isSafeCitationUrl(url) {
      return isSafeHttpUrl(url);
    },
    regenerateAiBrief() {
      if (!this.cluster?.id) return;
      this.webStore.generateAiBrief(this.cluster.id, {
        mode: 'brief',
        perspective: this.briefPerspective,
        agentId: this.effectiveBriefingAgentId,
        research: !this.cluster?.isPrivateSource,
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
    selectAgent(agentId) {
      this.dispatchAgentId = agentId;
      this.agentPickerOpen = false;
    },
    async submitModalFollowUp(explicitQuestion = null) {
      const q = String(explicitQuestion ?? this.composerInput ?? '').trim();
      if (!q) return;
      if (this.isDailyMode) {
        this.dispatchPromptToPlanet(q, 'fly');
        return;
      }
      if (!this.cluster?.id || this.webStore.followUpLoading) return;
      if (!this.canUseInlineFollowUp) {
        this.$emit('toast', t('cosmos.web.report.upgradeAgentHint'));
        return;
      }
      if (!explicitQuestion) this.composerInput = '';
      await this.webStore.askFollowUp(this.cluster.id, q, {
        agentId: this.effectiveFollowUpAgentId,
        perspective: this.briefPerspective,
      });
      this.$nextTick(() => {
        const scroller = this.$refs.modalBodyRef;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    },
    dispatchPromptToPlanet(question, mode = 'fly') {
      const agentId = this.effectiveDispatchAgentId;
      if (!agentId) {
        this.$emit('toast', t('cosmos.web.dispatch.noAgent'));
        return;
      }
      const title = this.isDailyMode
        ? (this.daily?.headline || t('cosmos.web.daily.title'))
        : (this.cluster?.headline || this.cluster?.title || '');
      this.$emit('dispatch-to-planet', {
        agentId,
        planetId: this.agentToPlanet?.[agentId] || null,
        mode,
        intent: 'deepdive',
        userNote: '',
        aiFollowUp: String(question || '').trim() || null,
        clusterId: this.isDailyMode ? null : (this.cluster?.id || null),
        headline: title,
        url: this.isDailyMode ? null : (this.primarySafeUrl || null),
        summary: this.isDailyMode
          ? (this.daily?.overview || '')
          : (this.aiBrief?.tldr || this.cluster?.summaryExcerpt || ''),
      });
      this.$emit('toast', mode === 'fly'
        ? t('cosmos.web.dispatch.sentFly')
        : t('cosmos.web.dispatch.sentBackground'));
      if (mode === 'fly') {
        this.closeAllReader();
      }
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
      const userNote = String(this.composerInput || '').trim();
      this.$emit('dispatch-to-planet', {
        agentId,
        planetId: this.agentToPlanet?.[agentId] || null,
        mode,
        intent: 'deepdive',
        userNote,
        aiFollowUp: null,
        clusterId: this.isDailyMode ? null : (this.cluster?.id || null),
        headline: title,
        url: this.isDailyMode ? null : (this.primarySafeUrl || null),
        summary: this.isDailyMode
          ? (this.daily?.overview || '')
          : (this.aiBrief?.tldr || this.cluster?.summaryExcerpt || ''),
      });
      this.$emit('toast', mode === 'fly'
        ? t('cosmos.web.dispatch.sentFly')
        : t('cosmos.web.dispatch.sentBackground'));
      this.composerInput = '';
      if (mode === 'fly') {
        this.closeAllReader();
      }
    },
    async copyMarkdown() {
      const parts = [];
      if (this.cluster?.headline) parts.push(`# ${this.cluster.headline}`);
      if (this.aiBrief?.tldr) parts.push(`> ${this.aiBrief.tldr}`);
      if (this.reportSections.length) {
        for (const s of this.aiBrief.sections || []) {
          if (s.heading) parts.push(`## ${s.heading}`);
          if (s.body) parts.push(s.body);
          if (Array.isArray(s.bullets) && s.bullets.length) {
            parts.push(s.bullets.map((b) => `- ${b}`).join('\n'));
          }
        }
      } else if (this.aiBrief?.fullMarkdown || this.aiBrief?.markdown) {
        parts.push(this.aiBrief.fullMarkdown || this.aiBrief.markdown);
      } else if (Array.isArray(this.aiBrief?.bullets)) {
        parts.push(this.aiBrief.bullets.map((b) => `- ${b}`).join('\n'));
      }
      const text = parts.join('\n\n').trim();
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
      :inert="Boolean(webStore.lightboxMedia)"
      role="dialog"
      aria-modal="true"
      :aria-label="isDailyMode ? (daily?.headline || $t('cosmos.web.daily.title')) : (cluster?.headline || $t('cosmos.web.report.badge'))"
      @pointerdown.stop
      @wheel.stop
      @click.self="closeModal"
      @keydown.esc.stop.prevent="onBackdropEsc"
    >
      <div ref="modalShell" class="cw-modal-shell cw-reader-modal" tabindex="-1">
        <!-- Fixed Weightless Header -->
        <header class="cw-modal-header">
          <div class="cw-modal-header-left">
            <template v-if="isDailyMode">
              <span class="cw-badge cw-badge-accent">{{ $t('cosmos.web.daily.badge') }}</span>
              <h2 class="cw-modal-title">{{ daily?.headline || $t('cosmos.web.daily.title') }}</h2>
            </template>
            <template v-else>
              <span v-if="cluster?.domainId" class="cw-report-domain">
                <span class="cw-dot" :class="'cw-dot-' + (cluster?.colorToken || 'cyan')"></span>
                <span>{{ domainLabel(cluster.domainId) }}</span>
              </span>
              <span class="cw-badge cw-badge-accent">{{ $t('cosmos.web.report.badge') }}</span>
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

        <!-- Scrollable Magazine Body -->
        <div ref="modalBodyRef" class="cw-modal-body cw-reader-body">
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

            <div v-if="webStore.dailyBriefingLoading" class="cw-shimmer-block">
              <p class="cw-shimmer-label">
                <span class="cw-spinner cw-spinner-sm" aria-hidden="true"></span>
                <span>{{ $t('cosmos.web.daily.loading') }}</span>
              </p>
              <div class="cw-shimmer-line is-wide"></div>
              <div class="cw-shimmer-line is-mid"></div>
              <div class="cw-shimmer-line is-short"></div>
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

              <blockquote v-if="daily.overview" class="cw-pull-quote cw-daily-overview">
                <p>{{ daily.overview }}</p>
              </blockquote>

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

              <section v-if="dailySignals.length" class="cw-whisper-section">
                <h4 class="cw-whisper-heading">{{ $t('cosmos.web.daily.signalsTitle') }}</h4>
                <ul class="cw-whisper-prompts">
                  <li v-for="(sig, idx) in dailySignals" :key="idx" class="cw-whisper-item">
                    <button
                      type="button"
                      class="cw-whisper-btn"
                      @click="dispatchPromptToPlanet(typeof sig === 'string' ? sig : (sig.label || sig.title))"
                    >
                      <span class="cw-whisper-arrow" aria-hidden="true">→</span>
                      <span class="cw-whisper-text">{{ typeof sig === 'string' ? sig : (sig.label || sig.title) }}</span>
                    </button>
                  </li>
                </ul>
              </section>

              <section v-if="Array.isArray(daily.followUps) && daily.followUps.length" class="cw-whisper-section">
                <h4 class="cw-whisper-heading">{{ $t('cosmos.web.report.followUpTitle') }}</h4>
                <ul class="cw-whisper-prompts">
                  <li v-for="(q, idx) in daily.followUps" :key="idx" class="cw-whisper-item">
                    <button
                      type="button"
                      class="cw-whisper-btn"
                      @click="dispatchPromptToPlanet(q)"
                    >
                      <span class="cw-whisper-arrow" aria-hidden="true">→</span>
                      <span class="cw-whisper-text">{{ q }}</span>
                    </button>
                  </li>
                </ul>
              </section>
            </template>

            <div v-else class="cw-state-box">
              <p>{{ $t('cosmos.web.daily.empty') }}</p>
              <button type="button" class="cw-btn cw-btn-primary" @click="regenerateDaily">
                {{ $t('cosmos.web.daily.generateNow') }}
              </button>
            </div>
          </div>

          <!-- MODE A: Expanded AI Web-Researched Magazine Deep Report -->
          <div v-else class="cw-reading-column">
            <h1 class="cw-article-headline">{{ cluster?.headline || cluster?.title || '' }}</h1>

            <div class="cw-report-meta-top">
              <span v-if="cluster?.publishedAt" class="cw-report-time">{{ formatTime(cluster.publishedAt) }}</span>
              <span v-if="cluster?.heatScore !== undefined" class="cw-report-time">
                {{ $t('cosmos.web.feed.heatLabel', { score: Math.round(cluster.heatScore) }) }}
              </span>
              <span v-if="cluster?.isPrivateSource" class="cw-verified-tag">
                {{ $t('cosmos.web.report.privateLocalBadge') }}
              </span>
              <span v-else-if="activeBriefEvidenceCount > 0" class="cw-verified-tag">
                ✦ {{ $t('cosmos.web.report.webVerified', { count: activeBriefEvidenceCount }) }}
              </span>
            </div>

            <!-- Source Switcher & Subtle External Footnotes -->
            <div v-if="sourceFootnotes.length" class="cw-source-footnotes">
              <span class="cw-footnote-label">{{ $t('cosmos.web.report.sourcesLabel') }}</span>
              <template v-for="(src, idx) in sourceFootnotes" :key="src.id">
                <button
                  v-if="sourceFootnotes.length > 1"
                  type="button"
                  class="cw-footnote-switch"
                  :class="{ 'is-active': (activeSelectedItem?.id || sourceFootnotes[0]?.id) === src.id }"
                  @click="selectStorySource(src)"
                >{{ src.name }}</button>
                <span v-else-if="!src.url" class="cw-footnote-text">{{ src.name }}</span>
                <a
                  v-if="src.url"
                  :href="src.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="cw-footnote-link"
                  :aria-label="src.name"
                >{{ sourceFootnotes.length > 1 ? '↗' : (src.name + ' ↗') }}</a>
                <span v-if="idx < sourceFootnotes.length - 1" class="cw-footnote-dot" aria-hidden="true">·</span>
              </template>
              <button
                v-if="cluster?.id"
                type="button"
                class="cw-footnote-switch cw-clean-article-toggle"
                :aria-expanded="webStore.cleanArticleOpen"
                @click="webStore.toggleCleanArticle(cluster.id)"
              >{{ webStore.cleanArticleOpen ? $t('cosmos.web.report.hideCleanArticle') : $t('cosmos.web.report.readCleanArticle') }}</button>
            </div>

            <!-- Optional On-Demand Clean Extracted Article (Independent of AI / Offline Safe) -->
            <section v-if="webStore.cleanArticleOpen" class="cw-clean-article-panel">
              <div v-if="webStore.articleLoading" class="cw-shimmer-label" role="status" aria-live="polite">
                <span class="cw-spinner cw-spinner-sm" aria-hidden="true"></span>
                <span>{{ $t('cosmos.web.report.cleanArticleLoading') }}</span>
              </div>
              <p v-else-if="webStore.articleError" class="cw-inline-error">{{ webStore.articleError }}</p>
              <div v-else-if="renderedCleanArticleHtml" class="cw-markdown-prose" v-html="renderedCleanArticleHtml"></div>
              <p v-else-if="fallbackExcerpt" class="cw-markdown-prose">{{ fallbackExcerpt }}</p>
            </section>

            <!-- Perspective Switcher + Regenerate -->
            <div class="cw-perspective-bar">
              <div class="cw-perspective-pills" role="group" :aria-label="$t('cosmos.web.prefs.perspectiveLabel')">
                <button
                  v-for="opt in PERSPECTIVE_OPTIONS"
                  :key="opt.id"
                  type="button"
                  class="cw-persp-btn"
                  :class="{ 'is-active': briefPerspective === opt.id }"
                  :aria-pressed="briefPerspective === opt.id"
                  @click="switchPerspective(opt.id)"
                >{{ $t(opt.shortKey) }}</button>
              </div>
              <button
                type="button"
                class="cw-text-btn cw-regen-btn"
                :disabled="webStore.aiBriefLoading"
                @click="regenerateAiBrief"
              >↻ {{ $t('cosmos.web.ai.regenerate') }}</button>
            </div>

            <!-- Immediate 0ms Stored Excerpt (Shown while AI is loading or unavailable) -->
            <blockquote
              v-if="fallbackExcerpt && (webStore.aiBriefLoading || webStore.aiBriefError || !aiBrief)"
              class="cw-pull-quote cw-immediate-excerpt"
            >
              <p>{{ fallbackExcerpt }}</p>
            </blockquote>

            <!-- Loading Shimmer -->
            <div v-if="webStore.aiBriefLoading" class="cw-shimmer-block" role="status" aria-live="polite">
              <p class="cw-shimmer-label">
                <span class="cw-spinner cw-spinner-sm" aria-hidden="true"></span>
                <span>{{ $t('cosmos.web.report.researching') }}</span>
              </p>
              <div class="cw-shimmer-line is-wide"></div>
              <div class="cw-shimmer-line is-mid"></div>
              <div class="cw-shimmer-line is-short"></div>
            </div>

            <!-- Graceful Non-AI Digest + Error / Retry -->
            <div v-else-if="webStore.aiBriefError" class="cw-magazine-flow">
              <div class="cw-state-box cw-state-error">
                <p>{{ agentsLive && !briefingCapableAgents.length ? $t('cosmos.web.report.offlineHint') : webStore.aiBriefError }}</p>
                <div class="cw-state-actions">
                  <button type="button" class="cw-btn cw-btn-primary" @click="regenerateAiBrief">
                    {{ $t('cosmos.web.action.retry') }}
                  </button>
                  <button
                    v-if="cluster?.id && !webStore.cleanArticleOpen"
                    type="button"
                    class="cw-btn cw-btn-subtle"
                    @click="webStore.toggleCleanArticle(cluster.id)"
                  >{{ $t('cosmos.web.report.readCleanArticle') }}</button>
                </div>
              </div>
            </div>

            <!-- Magazine Editorial Flow -->
            <div v-else-if="aiBrief" class="cw-magazine-flow">
              <blockquote v-if="aiBrief.tldr" class="cw-pull-quote">
                <p>{{ aiBrief.tldr }}</p>
              </blockquote>

              <section v-if="verifiedMedia.length" class="cw-media-section">
                <div class="cw-media-strip cw-media-strip-wide">
                  <button
                    v-for="(m, idx) in verifiedMedia"
                    :key="m.proxyUrl + idx"
                    type="button"
                    class="cw-media-tile"
                    @click="webStore.openLightbox(m)"
                  >
                    <img
                      :src="m.proxyUrl"
                      :alt="m.caption || cluster?.headline || ''"
                      loading="lazy"
                      class="cw-media-img"
                      @error="onMediaError(m.proxyUrl)"
                    />
                    <span v-if="m.kind === 'gif'" class="cw-gif-badge">{{ $t('cosmos.web.report.gifBadge') }}</span>
                    <span v-if="m.caption" class="cw-media-caption">{{ m.caption }}</span>
                  </button>
                </div>
              </section>

              <template v-if="reportSections.length">
                <section v-for="(sec, idx) in reportSections" :key="idx" class="cw-editorial-sec">
                  <h3 v-if="sec.heading" class="cw-editorial-h">{{ sec.heading }}</h3>
                  <div v-if="sec.html" class="cw-markdown-prose" v-html="sec.html"></div>
                  <ul v-if="sec.bullets.length" class="cw-bullet-list">
                    <li v-for="(b, bIdx) in sec.bullets" :key="bIdx">{{ b }}</li>
                  </ul>
                </section>
              </template>

              <template v-else>
                <section v-if="Array.isArray(aiBrief.bullets) && aiBrief.bullets.length" class="cw-editorial-sec">
                  <h3 class="cw-editorial-h">{{ $t('cosmos.web.ai.keyPoints') }}</h3>
                  <ul class="cw-bullet-list">
                    <li v-for="(b, idx) in aiBrief.bullets" :key="idx">{{ b }}</li>
                  </ul>
                </section>
                <section v-if="aiBrief.impact" class="cw-editorial-sec">
                  <h3 class="cw-editorial-h">{{ $t('cosmos.web.ai.impact') }}</h3>
                  <p class="cw-editorial-p">{{ aiBrief.impact }}</p>
                </section>
                <div
                  v-if="!aiBrief.tldr && renderedAiMarkdownHtml"
                  class="cw-markdown-prose"
                  v-html="renderedAiMarkdownHtml"
                ></div>
              </template>

              <div v-if="safeReportCitations.length" class="cw-source-footnotes cw-report-citations">
                <span class="cw-footnote-label">{{ $t('cosmos.web.report.sourcesLabel') }}</span>
                <template v-for="(cit, cIdx) in safeReportCitations" :key="cit.url">
                  <a
                    :href="cit.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="cw-footnote-link"
                  >{{ cit.label }} ↗</a>
                  <span v-if="cIdx < safeReportCitations.length - 1" class="cw-footnote-dot" aria-hidden="true">·</span>
                </template>
              </div>
            </div>

            <!-- Deterministic Media while AI loading -->
            <section v-if="webStore.aiBriefLoading && verifiedMedia.length" class="cw-media-section">
              <div class="cw-media-strip cw-media-strip-wide">
                <button
                  v-for="(m, idx) in verifiedMedia"
                  :key="m.proxyUrl + idx"
                  type="button"
                  class="cw-media-tile"
                  @click="webStore.openLightbox(m)"
                >
                  <img
                    :src="m.proxyUrl"
                    :alt="m.caption || cluster?.headline || ''"
                    loading="lazy"
                    class="cw-media-img"
                    @error="onMediaError(m.proxyUrl)"
                  />
                  <span v-if="m.kind === 'gif'" class="cw-gif-badge">{{ $t('cosmos.web.report.gifBadge') }}</span>
                </button>
              </div>
            </section>

            <!-- Authentic Community Hot Comments -->
            <section v-if="communityComments.length" class="cw-comments-section">
              <h3 class="cw-editorial-h">{{ $t('cosmos.web.report.commentsTitle') }}</h3>
              <div class="cw-comments-list">
                <article v-for="(cm, idx) in communityComments" :key="idx" class="cw-comment-card">
                  <div class="cw-comment-head">
                    <span v-if="cm.platform" class="cw-comment-platform">{{ cm.platform }}</span>
                    <span v-if="cm.author" class="cw-comment-author">{{ cm.author }}</span>
                    <span v-if="cm.votesLabel || cm.votes" class="cw-comment-votes">{{ cm.votesLabel || cm.votes }}</span>
                  </div>
                  <p class="cw-comment-text">{{ cm.text }}</p>
                </article>
              </div>
            </section>

            <!-- Inline Follow-Up Q&A Thread -->
            <section v-if="webStore.followUpThread.length || webStore.followUpLoading || webStore.followUpError" class="cw-followups-thread">
              <article v-for="fu in webStore.followUpThread" :key="fu.id" class="cw-followup-entry">
                <div class="cw-followup-q">{{ fu.question }}</div>
                <div class="cw-markdown-prose cw-followup-a" v-html="renderFollowUpHtml(fu.answer)"></div>
                <ul v-if="fu.bullets && fu.bullets.length" class="cw-bullet-list">
                  <li v-for="(b, bIdx) in fu.bullets" :key="bIdx">{{ b }}</li>
                </ul>
                <div v-if="fu.media && fu.media.length" class="cw-media-strip cw-media-strip-sm">
                  <button
                    v-for="(m, mIdx) in fu.media"
                    :key="mIdx"
                    v-show="m && m.proxyUrl && !failedMediaUrls[m.proxyUrl]"
                    type="button"
                    class="cw-media-tile"
                    @click="webStore.openLightbox(m)"
                  >
                    <img
                      :src="m.proxyUrl"
                      :alt="m.caption || ''"
                      loading="lazy"
                      class="cw-media-img"
                      @error="onMediaError(m.proxyUrl)"
                    />
                  </button>
                </div>
                <div v-if="fu.citations && fu.citations.length" class="cw-source-footnotes">
                  <template v-for="(c, cIdx) in fu.citations.slice(0, 4)" :key="cIdx">
                    <a
                      v-if="c && isSafeCitationUrl(c.url)"
                      :href="c.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="cw-footnote-link"
                    >{{ c.title || c.sourceName || c.source || c.url }} ↗</a>
                  </template>
                </div>
              </article>

              <div v-if="webStore.followUpLoading" class="cw-shimmer-label">
                <span class="cw-spinner cw-spinner-sm" aria-hidden="true"></span>
                <span>{{ $t('cosmos.web.report.followUpLoading') }}</span>
              </div>
              <p v-if="webStore.followUpError" class="cw-inline-error">{{ webStore.followUpError }}</p>
            </section>

            <!-- Whispering Editorial Follow-Up Prompts -->
            <section v-if="aiBrief && Array.isArray(aiBrief.followUps) && aiBrief.followUps.length" class="cw-whisper-section">
              <h4 class="cw-whisper-heading">{{ $t('cosmos.web.report.followUpTitle') }}</h4>
              <p v-if="agentsLive && !canUseInlineFollowUp" class="cw-inline-hint">{{ $t('cosmos.web.report.upgradeAgentHint') }}</p>
              <ul class="cw-whisper-prompts">
                <li v-for="(q, idx) in aiBrief.followUps" :key="idx" class="cw-whisper-item">
                  <button
                    type="button"
                    class="cw-whisper-btn"
                    :disabled="webStore.followUpLoading || !canUseInlineFollowUp"
                    :title="canUseInlineFollowUp ? $t('cosmos.web.report.askAiHint') : $t('cosmos.web.report.upgradeAgentHint')"
                    @click="submitModalFollowUp(q)"
                  >
                    <span class="cw-whisper-arrow" aria-hidden="true">→</span>
                    <span class="cw-whisper-text">{{ q }}</span>
                  </button>
                  <button
                    type="button"
                    class="cw-whisper-planet-btn"
                    :title="$t('cosmos.web.report.sendToPlanetHint')"
                    :aria-label="$t('cosmos.web.report.sendToPlanetHint')"
                    @click.stop="dispatchPromptToPlanet(q, 'fly')"
                  >☉</button>
                </li>
              </ul>
            </section>
          </div>
        </div>

        <!-- Fixed Single-Surface Atmospheric Bottom Composer -->
        <footer class="cw-modal-footer">
          <div class="cw-composer-bar">
            <div ref="modalAgentPickerWrap" class="cw-agent-picker-wrap">
              <button
                type="button"
                class="cw-agent-trigger"
                :aria-expanded="agentPickerOpen"
                :title="$t('cosmos.web.report.agentPickerTitle')"
                @click="agentPickerOpen = !agentPickerOpen"
              >
                <span class="cw-planet-orb" :class="agentPlanetClass(effectiveDispatchAgentId)"></span>
                <span class="cw-agent-trigger-name">
                  {{ selectedAgentObj ? (selectedAgentObj.name || selectedAgentObj.id) : $t('cosmos.web.report.noAgentShort') }}
                </span>
                <span v-if="selectedAgentObj && !selectedAgentObj.online" class="cw-agent-offline-dot" :title="$t('cosmos.web.status.offline')"></span>
              </button>

              <div v-if="agentPickerOpen" class="cw-agent-popover" role="region" :aria-label="$t('cosmos.web.report.agentPickerTitle')">
                <div v-if="!availableAgents.length" class="cw-agent-popover-empty">
                  {{ $t('cosmos.web.dispatch.noAgent') }}
                </div>
                <button
                  v-for="ag in availableAgents"
                  :key="ag.id"
                  type="button"
                  class="cw-agent-option"
                  :class="{ 'is-selected': ag.id === effectiveDispatchAgentId }"
                  :aria-pressed="ag.id === effectiveDispatchAgentId"
                  @click="selectAgent(ag.id)"
                >
                  <span class="cw-planet-orb" :class="agentPlanetClass(ag.id)"></span>
                  <span class="cw-agent-option-name">{{ ag.name || ag.id }}</span>
                  <span class="cw-status-dot" :class="{ 'is-online': ag.online }"></span>
                  <span v-if="isAgentBriefingCapable(ag)" class="cw-agent-cap-tag">AI</span>
                </button>
              </div>
            </div>

            <input
              ref="dispatchInput"
              v-model="composerInput"
              type="text"
              class="cw-composer-input"
              :placeholder="$t('cosmos.web.report.composerPlaceholder')"
              @keydown.enter.prevent="submitModalFollowUp()"
            />

            <div class="cw-composer-actions">
              <button
                v-if="!isDailyMode"
                type="button"
                class="cw-composer-icon-btn"
                :disabled="!composerInput.trim() || webStore.followUpLoading || !canUseInlineFollowUp"
                :title="canUseInlineFollowUp ? $t('cosmos.web.report.askAiHint') : $t('cosmos.web.report.upgradeAgentHint')"
                :aria-label="canUseInlineFollowUp ? $t('cosmos.web.report.askAiHint') : $t('cosmos.web.report.upgradeAgentHint')"
                @click="submitModalFollowUp()"
              >✦</button>
              <button
                type="button"
                class="cw-composer-icon-btn"
                :disabled="!effectiveDispatchAgentId"
                :title="$t('cosmos.web.report.bgDispatchShort')"
                :aria-label="$t('cosmos.web.report.bgDispatchShort')"
                @click="submitDispatch('background')"
              >⇢</button>
              <button
                type="button"
                class="cw-send-orb"
                :disabled="!effectiveDispatchAgentId"
                :title="$t('cosmos.web.report.flyDispatchShort')"
                :aria-label="$t('cosmos.web.report.flyDispatchShort')"
                @click="submitDispatch('fly')"
              >↗</button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  `,
};
