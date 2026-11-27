/**
 * CosmosWebOverlay — Cosmic Web 2.0 Interactive HUD, Feathered Translucent Right Drawer,
 * Optical Filament Drag Resize, 3D Semantic Zoom & LOD Dock, AI Web-Researched Magazine
 * Deep Intelligence Report, Media/GIF Lightbox, Authentic Community Reactions & Single-Lens Composer.
 *
 * Composes `CosmosWebReaderModal` and `CosmosWebPrefsModal`.
 * All interactive panels stop pointer/wheel propagation so scrolling never zooms the 3D stage.
 */
import { useCosmicWebStore } from '../../../stores/cosmicWeb.js';
import { renderCosmicWebProse } from '../../../utils/safe-message-markdown.js';
import { getLocale, t } from '../../../utils/i18n.js';
import CosmosWebReaderModal from './CosmosWebReaderModal.js';
import CosmosWebPrefsModal from './CosmosWebPrefsModal.js';

const PERSPECTIVE_CHIPS = [
  { id: 'balanced', labelKey: 'cosmos.web.report.perspectiveBalancedShort' },
  { id: 'engineering', labelKey: 'cosmos.web.report.perspectiveEngineeringShort' },
  { id: 'product', labelKey: 'cosmos.web.report.perspectiveBusinessShort' },
  { id: 'investing', labelKey: 'cosmos.web.report.perspectiveInvestingShort' },
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
        width: m.width || null,
        height: m.height || null,
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
    agentsLive: {
      type: Boolean,
      default: true,
    },
    agentToPlanet: {
      type: Object,
      default: () => ({}),
    },
    isCompact: {
      type: Boolean,
      default: false,
    },
    drawerWidth: {
      type: Number,
      default: 480,
    },
    minDrawerWidth: {
      type: Number,
      default: 360,
    },
    maxDrawerWidth: {
      type: Number,
      default: 960,
    },
    viewportWidth: {
      type: Number,
      default: 1280,
    },
    webZoom: {
      type: Number,
      default: 1.0,
    },
    webLodTier: {
      type: Number,
      default: 1,
    },
  },
  emits: [
    'toast',
    'dispatch-to-planet',
    'escape-solar',
    'drawer-resize',
    'drawer-resize-end',
    'drawer-resize-reset',
    'web-zoom-delta',
    'web-zoom-reset',
  ],
  setup() {
    const webStore = useCosmicWebStore();
    return { webStore };
  },
  data() {
    return {
      searchDraft: '',
      searchTimer: null,
      isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,

      // Onboarding draft
      onboardDomains: [],
      onboardKeywordsInput: '',
      onboardSubmitting: false,

      // Single-lens composer & Agent picker state
      dispatchAgentId: '',
      composerInput: '',
      agentPickerOpen: false,
      activePerspective: 'balanced',

      // Failed media URLs (graceful hide on upstream error)
      failedMediaUrls: {},

      // Keyboard navigation cursor index
      focusedFeedIdx: -1,

      // Optical filament drag resize state
      isDraggingResize: false,
      localDrawerWidth: null,
      _activeResizeDrag: null,
      _lastResizeEvent: null,

      PERSPECTIVE_CHIPS,
    };
  },
  computed: {
    effectiveDrawerWidth() {
      const base = this.localDrawerWidth ?? this.webStore.drawerWidth ?? this.drawerWidth ?? 480;
      const vpCap = Math.max(this.minDrawerWidth, (this.viewportWidth || 1280) - 220);
      const upper = Math.min(this.maxDrawerWidth, vpCap);
      return Math.max(this.minDrawerWidth, Math.min(upper, Math.round(base)));
    },
    overlayStyleVars() {
      return {
        '--cw-drawer-w': `${this.effectiveDrawerWidth}px`,
      };
    },
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
    activeAiBrief() {
      return this.webStore.aiBriefData;
    },
    sourceFootnotes() {
      const items = this.activeCluster?.items || this.activeCluster?.sources || [];
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
      return out.slice(0, 6);
    },
    primarySafeUrl() {
      const candidate = this.webStore.activeArticleUrl
        || this.activeCluster?.primaryUrl
        || this.activeCluster?.url
        || this.sourceFootnotes[0]?.url
        || '';
      return isSafeHttpUrl(candidate) ? candidate : '';
    },
    activeBriefEvidenceCount() {
      if (this.activeAiBrief?.researched !== true) return 0;
      if (this.activeAiBrief?.evidenceCount == null) return 0;
      const n = Number(this.activeAiBrief.evidenceCount);
      return Number.isFinite(n) && n > 0 ? n : 0;
    },
    renderedCleanArticleHtml() {
      const md = this.webStore.articleData?.markdown || this.webStore.articleData?.contentMd || '';
      return md ? renderCosmicWebProse(md) : '';
    },
    activeSelectedItem() {
      const items = Array.isArray(this.activeCluster?.items) ? this.activeCluster.items : [];
      if (!items.length) return null;
      if (this.webStore.activeArticleItemId) {
        const hit = items.find((it) => it && it.id === this.webStore.activeArticleItemId);
        if (hit) return hit;
      }
      return items[0];
    },
    fallbackExcerpt() {
      return String(
        this.activeSelectedItem?.summaryExcerpt
        || this.activeSelectedItem?.summary
        || this.activeCluster?.summaryExcerpt
        || this.activeCluster?.excerpt
        || '',
      ).trim();
    },
    safeReportCitations() {
      const list = this.activeAiBrief?.citations;
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
    effectiveBriefingAgentId() {
      const cand = this.effectiveDispatchAgentId;
      if (cand && this.briefingCapableAgents.some((a) => a.id === cand)) {
        return cand;
      }
      return undefined;
    },
    effectiveFollowUpAgentId() {
      const cand = this.effectiveDispatchAgentId;
      if (cand && this.followUpCapableAgents.some((a) => a.id === cand)) {
        return cand;
      }
      return undefined;
    },
    verifiedMedia() {
      return mergeVerifiedMedia(
        this.activeAiBrief?.media,
        this.activeCluster?.media,
        this.failedMediaUrls,
      );
    },
    communityComments() {
      return mergeCommunityComments(
        this.activeAiBrief?.communityHighlights,
        this.activeCluster?.communityComments,
      );
    },
    reportSections() {
      const secs = this.activeAiBrief?.sections;
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
      const md = this.activeAiBrief?.fullMarkdown || this.activeAiBrief?.markdown || this.activeAiBrief?.rawMarkdown || '';
      return md ? renderCosmicWebProse(md) : '';
    },
    availableAgents() {
      return (this.agents || []).slice().sort((a, b) => Number(Boolean(b?.online)) - Number(Boolean(a?.online)));
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
    selectedAgentObj() {
      return this.availableAgents.find((a) => a && a.id === this.effectiveDispatchAgentId) || null;
    },
    selectedAgentPlanet() {
      const id = this.effectiveDispatchAgentId;
      return (id && this.agentToPlanet?.[id]) ? this.agentToPlanet[id] : 'default';
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
    zoomDisplayLabel() {
      const z = Number.isFinite(this.webZoom) ? this.webZoom.toFixed(1) : '1.0';
      const tier = this.webLodTier >= 3
        ? t('cosmos.web.zoom.tier3')
        : (this.webLodTier === 2 ? t('cosmos.web.zoom.tier2') : t('cosmos.web.zoom.tier1'));
      return `${z}× · ${tier}`;
    },
  },
  watch: {
    drawerWidth(val) {
      if (Number.isFinite(val) && !this.isDraggingResize) {
        this.localDrawerWidth = val;
      }
    },
    visible: {
      immediate: true,
      handler(val, prev) {
        if (val) {
          this.searchDraft = this.webStore?.searchQuery || '';
          this.activePerspective = this.webStore?.prefs?.defaultPerspective || 'balanced';
        } else if (prev === true) {
          this.clearSearchDebounce();
          this.agentPickerOpen = false;
        }
      },
    },
    'webStore.domains': {
      immediate: true,
      handler(list) {
        if (Array.isArray(list) && list.length && this.onboardDomains.length === 0) {
          const builtIns = list.filter((d) => d && !d.isCustom);
          const defaults = builtIns.filter((d) => d.defaultEnabled).map((d) => d.id);
          this.onboardDomains = defaults.length > 0 ? defaults : builtIns.slice(0, 5).map((d) => d.id);
        }
      },
    },
    'webStore.readerClusterId'(id) {
      this.composerInput = '';
      this.agentPickerOpen = false;
      this.failedMediaUrls = {};
      this.activePerspective = this.webStore?.prefs?.defaultPerspective || 'balanced';
      if (id) {
        const idx = this.webStore.feedItems.findIndex((it) => it && it.id === id);
        if (idx >= 0) this.focusedFeedIdx = idx;
      }
    },
    'webStore.sourceSelectionRev'() {
      this.composerInput = '';
      this.failedMediaUrls = {};
    },
    'webStore.lightboxMedia'(media, prev) {
      if (media && !prev) {
        this._lightboxOpener = typeof document !== 'undefined' ? document.activeElement : null;
        window.addEventListener('keydown', this.onLightboxKeydown, true);
        document.addEventListener('focusin', this.onLightboxFocusIn, true);
        this.$nextTick(() => {
          this.$refs.lightboxCloseBtn?.focus?.();
        });
      } else if (!media && prev) {
        window.removeEventListener('keydown', this.onLightboxKeydown, true);
        document.removeEventListener('focusin', this.onLightboxFocusIn, true);
        const opener = this._lightboxOpener;
        this._lightboxOpener = null;
        this.$nextTick(() => {
          if (opener && opener.isConnected && typeof opener.focus === 'function') {
            opener.focus();
          } else if (this.$refs.inlineExpandBtn?.isConnected) {
            this.$refs.inlineExpandBtn.focus();
          } else if (this.$refs.drawerShell?.isConnected) {
            this.$refs.drawerShell.focus();
          }
        });
      }
    },
  },
  mounted() {
    window.addEventListener('keydown', this.handleGlobalKeydown);
    window.addEventListener('online', this.handleOnlineChange);
    window.addEventListener('offline', this.handleOnlineChange);
    window.addEventListener('blur', this.endDrawerResize);
    document.addEventListener('pointerdown', this.handleOutsideAgentPicker);
  },
  beforeUnmount() {
    window.removeEventListener('keydown', this.handleGlobalKeydown);
    window.removeEventListener('keydown', this.onLightboxKeydown, true);
    document.removeEventListener('focusin', this.onLightboxFocusIn, true);
    window.removeEventListener('online', this.handleOnlineChange);
    window.removeEventListener('offline', this.handleOnlineChange);
    window.removeEventListener('blur', this.endDrawerResize);
    document.removeEventListener('pointerdown', this.handleOutsideAgentPicker);
    this.endDrawerResize();
    this.clearSearchDebounce();
  },
  methods: {
    clearSearchDebounce() {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
        this.searchTimer = null;
      }
    },
    handleOnlineChange() {
      this.isOffline = typeof navigator !== 'undefined' ? !navigator.onLine : false;
    },
    handleOutsideAgentPicker(e) {
      if (!this.agentPickerOpen) return;
      const wrap = this.$refs.agentPickerWrap;
      if (wrap && !wrap.contains(e.target)) {
        this.agentPickerOpen = false;
      }
    },
    domainLabel(d) {
      if (!d) return '';
      return getLocale() === 'en'
        ? (d.labelEn || d.nameEn || d.labelZh || d.nameZh || d.name || d.id)
        : (d.labelZh || d.nameZh || d.labelEn || d.nameEn || d.name || d.id);
    },
    domainLabelById(domainId) {
      const d = (this.webStore.domains || []).find((x) => x.id === domainId)
        || this.enabledDomains.find((x) => x.id === domainId);
      return d ? this.domainLabel(d) : (domainId || '');
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
    onLightboxFocusIn(e) {
      if (!this.webStore.lightboxMedia) return;
      const dialog = this.$refs.lightboxDialog;
      if (dialog && e.target && !dialog.contains(e.target)) {
        this.$refs.lightboxCloseBtn?.focus?.();
      }
    },
    onLightboxKeydown(e) {
      if (!this.webStore.lightboxMedia) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.webStore.closeLightbox();
        return;
      }
      if (e.key === 'Tab') {
        const dialog = this.$refs.lightboxDialog;
        if (!dialog) return;
        const focusables = Array.from(
          dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'),
        );
        if (!focusables.length) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    onSearchInput() {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.webStore.setSearchQuery(this.searchDraft);
      }, 240);
    },
    clearSearch() {
      this.searchDraft = '';
      this.clearSearchDebounce();
      this.webStore.setSearchQuery('');
    },
    handleReaderRestoreFocus({ mode } = {}) {
      this.$nextTick(() => {
        if (mode === 'daily' && this.$refs.dailyBriefingBtn?.isConnected) {
          this.$refs.dailyBriefingBtn.focus();
          return;
        }
        if (this.inlineReaderActive && this.$refs.inlineExpandBtn?.isConnected) {
          this.$refs.inlineExpandBtn.focus();
          return;
        }
        if (this.$refs.drawerShell?.isConnected) {
          this.$refs.drawerShell.focus();
        }
      });
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

    // Optical Filament Drag Resize Handle
    detachWindowResizeListeners() {
      window.removeEventListener('pointermove', this.moveDrawerResize);
      window.removeEventListener('pointerup', this.endDrawerResize);
      window.removeEventListener('pointercancel', this.endDrawerResize);
    },
    startDrawerResize(ev) {
      if (this.isCompact || (ev.button !== undefined && ev.button !== 0)) return;
      this.endDrawerResize();
      const handle = this.$refs.resizeHandleRef;
      this._activeResizeDrag = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startWidth: this.effectiveDrawerWidth,
        moved: false,
      };
      try {
        handle?.setPointerCapture?.(ev.pointerId);
      } catch { /* ignore */ }
      window.addEventListener('pointermove', this.moveDrawerResize);
      window.addEventListener('pointerup', this.endDrawerResize);
      window.addEventListener('pointercancel', this.endDrawerResize);
    },
    moveDrawerResize(ev) {
      if (!ev || ev === this._lastResizeEvent) return;
      const drag = this._activeResizeDrag;
      if (!drag || (ev.pointerId != null && drag.pointerId != null && ev.pointerId !== drag.pointerId)) return;
      this._lastResizeEvent = ev;
      const delta = drag.startX - ev.clientX;
      if (!drag.moved) {
        if (Math.abs(delta) < 2) return;
        drag.moved = true;
        this.isDraggingResize = true;
        document.body.style.cursor = 'col-resize';
      }
      const vpCap = Math.max(this.minDrawerWidth, (this.viewportWidth || 1280) - 220);
      const upper = Math.min(this.maxDrawerWidth, vpCap);
      const nextWidth = Math.max(this.minDrawerWidth, Math.min(upper, Math.round(drag.startWidth + delta)));
      this.localDrawerWidth = nextWidth;
      this.webStore.setDrawerWidth(nextWidth, { persist: false });
      this.$emit('drawer-resize', nextWidth);
    },
    endDrawerResize(ev = null) {
      if (ev && ev === this._lastResizeEvent) return;
      const drag = this._activeResizeDrag;
      if (!drag) return;
      if (ev) this._lastResizeEvent = ev;
      this._activeResizeDrag = null;
      this.detachWindowResizeListeners();
      this.isDraggingResize = false;
      document.body.style.cursor = '';
      try {
        if (drag.pointerId != null) {
          this.$refs.resizeHandleRef?.releasePointerCapture?.(drag.pointerId);
        }
      } catch { /* ignore */ }
      if (drag.moved) {
        this.webStore.setDrawerWidth(this.effectiveDrawerWidth, { persist: true });
        this.$emit('drawer-resize-end', this.effectiveDrawerWidth);
      }
    },
    resetDrawerResize() {
      this.endDrawerResize();
      this.localDrawerWidth = 480;
      this.webStore.resetDrawerWidth();
      this.$emit('drawer-resize-reset');
    },
    onResizeHandleKeydown(ev) {
      const step = 24;
      const baseWidth = this.effectiveDrawerWidth;
      if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        const next = Math.min(this.maxDrawerWidth, baseWidth + step);
        this.localDrawerWidth = next;
        this.webStore.setDrawerWidth(next);
        this.$emit('drawer-resize', next);
        this.$emit('drawer-resize-end', next);
      } else if (ev.key === 'ArrowRight') {
        ev.preventDefault();
        const next = Math.max(this.minDrawerWidth, baseWidth - step);
        this.localDrawerWidth = next;
        this.webStore.setDrawerWidth(next);
        this.$emit('drawer-resize', next);
        this.$emit('drawer-resize-end', next);
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        this.resetDrawerResize();
      } else if (ev.key === 'End') {
        ev.preventDefault();
        const vpCap = Math.max(this.minDrawerWidth, (this.viewportWidth || 1280) - 220);
        const next = Math.min(this.maxDrawerWidth, vpCap);
        this.localDrawerWidth = next;
        this.webStore.setDrawerWidth(next);
        this.$emit('drawer-resize', next);
        this.$emit('drawer-resize-end', next);
      }
    },

    // Onboarding
    toggleOnboardDomain(id) {
      const idx = this.onboardDomains.indexOf(id);
      if (idx >= 0) this.onboardDomains.splice(idx, 1);
      else this.onboardDomains.push(id);
    },
    async submitOnboarding(useDefaults = false) {
      if (this.onboardSubmitting || !this.builtInDomains.length) return;
      this.onboardSubmitting = true;
      try {
        const keywords = useDefaults
          ? []
          : String(this.onboardKeywordsInput || '').split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
        const validIds = new Set(this.builtInDomains.map((d) => d.id));
        const defaultCatalogIds = this.builtInDomains.filter((d) => d.defaultEnabled).map((d) => d.id);
        const fallbackDefaults = defaultCatalogIds.length > 0
          ? defaultCatalogIds
          : this.builtInDomains.slice(0, 5).map((d) => d.id);
        const filteredDraft = this.onboardDomains.filter((id) => validIds.has(id));
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
    openStory(item) {
      if (!item?.id) return;
      this.webStore.openClusterReader(item.id, { expanded: false, debounceMs: 150 });
    },
    selectStorySource(src) {
      if (!this.activeCluster?.id || !src?.id) return;
      this.webStore.selectArticleSource(this.activeCluster.id, {
        itemId: src.id,
        url: src.url || null,
        perspective: this.activePerspective,
        agentId: this.effectiveBriefingAgentId,
      });
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
    isSafeCitationUrl(url) {
      return isSafeHttpUrl(url);
    },
    switchPerspective(pId) {
      if (!pId || this.activePerspective === pId || !this.activeCluster?.id) return;
      this.activePerspective = pId;
      this.webStore.generateAiBrief(this.activeCluster.id, {
        perspective: pId,
        agentId: this.effectiveBriefingAgentId,
        research: !this.activeCluster?.isPrivateSource,
        force: true,
      });
    },
    regenerateReport() {
      if (!this.activeCluster?.id) return;
      this.webStore.generateAiBrief(this.activeCluster.id, {
        perspective: this.activePerspective,
        agentId: this.effectiveBriefingAgentId,
        research: !this.activeCluster?.isPrivateSource,
        force: true,
      });
    },
    selectAgent(agentId) {
      this.dispatchAgentId = agentId;
      this.agentPickerOpen = false;
    },
    async submitInlineFollowUp(explicitQuestion = null) {
      const q = String(explicitQuestion ?? this.composerInput ?? '').trim();
      if (!q || !this.activeCluster?.id || this.webStore.followUpLoading) return;
      if (!this.canUseInlineFollowUp) {
        this.$emit('toast', t('cosmos.web.report.upgradeAgentHint'));
        return;
      }
      if (!explicitQuestion) {
        this.composerInput = '';
      }
      await this.webStore.askFollowUp(this.activeCluster.id, q, {
        agentId: this.effectiveFollowUpAgentId,
        perspective: this.activePerspective,
      });
      this.$nextTick(() => {
        const scroller = this.$refs.readerScrollRef;
        if (scroller) {
          scroller.scrollTop = scroller.scrollHeight;
        }
      });
    },
    dispatchFollowUpToPlanet(question) {
      const agentId = this.effectiveDispatchAgentId;
      if (!agentId) {
        this.$emit('toast', t('cosmos.web.dispatch.noAgent'));
        return;
      }
      const title = this.activeCluster?.headline || this.activeCluster?.title || '';
      this.$emit('dispatch-to-planet', {
        agentId,
        planetId: this.agentToPlanet?.[agentId] || null,
        mode: 'fly',
        intent: 'deepdive',
        userNote: '',
        aiFollowUp: String(question || '').trim() || null,
        clusterId: this.activeCluster?.id || null,
        headline: title,
        url: this.primarySafeUrl || null,
        summary: this.activeAiBrief?.tldr || this.activeCluster?.summaryExcerpt || '',
      });
      this.$emit('toast', t('cosmos.web.dispatch.sentFly'));
    },
    submitInlineDispatch(mode = 'fly') {
      const agentId = this.effectiveDispatchAgentId;
      if (!agentId) {
        this.$emit('toast', t('cosmos.web.dispatch.noAgent'));
        return;
      }
      const title = this.activeCluster?.headline || this.activeCluster?.title || '';
      const userNote = String(this.composerInput || '').trim();
      this.$emit('dispatch-to-planet', {
        agentId,
        planetId: this.agentToPlanet?.[agentId] || null,
        mode,
        intent: 'deepdive',
        userNote,
        aiFollowUp: null,
        clusterId: this.activeCluster?.id || null,
        headline: title,
        url: this.primarySafeUrl || null,
        summary: this.activeAiBrief?.tldr || this.activeCluster?.summaryExcerpt || '',
      });
      this.$emit('toast', mode === 'fly'
        ? t('cosmos.web.dispatch.sentFly')
        : t('cosmos.web.dispatch.sentBackground'));
      this.composerInput = '';
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

    // Global Keyboard Shortcuts
    handleGlobalKeydown(e) {
      if (!this.visible) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableElement(e.target)) return;

      const key = e.key;
      if (key === 'Escape') {
        if (this.webStore.lightboxMedia) {
          this.webStore.closeLightbox();
          e.preventDefault();
        } else if (this.agentPickerOpen) {
          this.agentPickerOpen = false;
          e.preventDefault();
        } else if (this.webStore.prefsModalOpen) {
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

      if (this.webStore.prefsModalOpen || this.webStore.dailyBriefingOpen || this.webStore.lightboxMedia) return;

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
        if (e.target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
        const targetId = this.webStore.cursorClusterId || this.webStore.selectedClusterId || items[this.focusedFeedIdx]?.id;
        if (targetId && !this.webStore.readerOpen) {
          e.preventDefault();
          this.webStore.openClusterReader(targetId, { expanded: false });
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
      :class="{
        'is-compact': isCompact,
        'is-drawer-collapsed': webStore.drawerCollapsed,
        'is-drawer-open': !webStore.drawerCollapsed,
      }"
      :style="overlayStyleVars"
      role="region"
      :aria-label="$t('cosmos.web.regionLabel')"
    >
      <!-- Top Floating Atmospheric HUD Bar (Positioned cleanly in left/center starfield) -->
      <header
        class="cw-hud-bar"
        :inert="Boolean(webStore.lightboxMedia)"
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
            ref="dailyBriefingBtn"
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

      <!-- First-Time Interactive Interest Onboarding Card (Supports all 9 Built-in Domains) -->
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
            :disabled="onboardSubmitting || !builtInDomains.length"
            @click="submitOnboarding(false)"
          >{{ onboardSubmitting ? $t('cosmos.web.prefs.saving') : $t('cosmos.web.onboarding.igniteCta') }}</button>
          <button
            type="button"
            class="cw-btn cw-btn-subtle"
            :disabled="onboardSubmitting || !builtInDomains.length"
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

      <!-- 3D Semantic Zoom & LOD Micro-Control Dock (Bottom-Left) -->
      <div
        class="cw-zoom-dock"
        :inert="Boolean(webStore.lightboxMedia)"
        role="group"
        :aria-label="$t('cosmos.web.zoom.dockLabel')"
        @pointerdown.stop
        @wheel.stop
      >
        <button
          type="button"
          class="cw-zoom-btn"
          :title="$t('cosmos.web.zoom.out')"
          :aria-label="$t('cosmos.web.zoom.out')"
          @click="$emit('web-zoom-delta', -0.25)"
        >−</button>
        <span class="cw-zoom-readout">{{ zoomDisplayLabel }}</span>
        <button
          type="button"
          class="cw-zoom-btn"
          :title="$t('cosmos.web.zoom.in')"
          :aria-label="$t('cosmos.web.zoom.in')"
          @click="$emit('web-zoom-delta', 0.25)"
        >+</button>
        <span class="cw-zoom-sep" aria-hidden="true"></span>
        <button
          type="button"
          class="cw-zoom-reset"
          @click="$emit('web-zoom-reset')"
        >{{ $t('cosmos.web.zoom.reset') }}</button>
      </div>

      <!-- Feathered Full-Height Right Intelligence Drawer (Solar-System Aesthetic) -->
      <aside
        v-if="!webStore.drawerCollapsed"
        ref="drawerShell"
        class="cw-drawer"
        :class="{ 'is-resizing': isDraggingResize }"
        :inert="Boolean(webStore.lightboxMedia)"
        role="complementary"
        tabindex="-1"
        :aria-label="$t('cosmos.web.drawer.label')"
        @pointerdown.stop
        @wheel.stop
      >
        <!-- Left-Edge Optical Filament Drag Resize Handle -->
        <div
          v-if="!isCompact"
          ref="resizeHandleRef"
          class="cw-drawer-resize-handle"
          :class="{ 'is-dragging': isDraggingResize }"
          role="separator"
          aria-orientation="vertical"
          tabindex="0"
          :aria-label="$t('cosmos.web.drawer.resize')"
          :title="$t('cosmos.web.drawer.resize')"
          :aria-valuemin="minDrawerWidth"
          :aria-valuemax="maxDrawerWidth"
          :aria-valuenow="effectiveDrawerWidth"
          @pointerdown.stop="startDrawerResize"
          @pointermove="moveDrawerResize"
          @pointerup="endDrawerResize"
          @pointercancel="endDrawerResize"
          @lostpointercapture="endDrawerResize"
          @keydown="onResizeHandleKeydown"
          @dblclick.stop="resetDrawerResize"
        ></div>

        <!-- MODE 1: Inline AI Deep Intelligence Report -->
        <template v-if="inlineReaderActive">
          <div class="cw-drawer-head">
            <button
              type="button"
              class="cw-text-btn"
              @click="webStore.closeClusterReader()"
            >← {{ $t('cosmos.web.reader.backToFeed') }}</button>

            <div class="cw-drawer-header-right">
              <button
                ref="inlineExpandBtn"
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

          <div ref="readerScrollRef" class="cw-drawer-scroll cw-report-body">
            <!-- Grounded Header & Source Footnotes (0ms Immediate) -->
            <div class="cw-report-meta-top">
              <span v-if="activeCluster?.domainId" class="cw-report-domain">
                <span class="cw-dot" :class="'cw-dot-' + (activeCluster?.colorToken || 'cyan')"></span>
                <span>{{ domainLabelById(activeCluster.domainId) }}</span>
              </span>
              <span v-if="activeCluster?.publishedAt" class="cw-report-time">{{ formatTime(activeCluster.publishedAt) }}</span>
              <span v-if="activeCluster?.isPrivateSource" class="cw-verified-tag">
                {{ $t('cosmos.web.report.privateLocalBadge') }}
              </span>
              <span v-else-if="activeBriefEvidenceCount > 0" class="cw-verified-tag">
                ✦ {{ $t('cosmos.web.report.webVerified', { count: activeBriefEvidenceCount }) }}
              </span>
            </div>

            <h2 class="cw-report-headline">{{ activeCluster?.headline || activeCluster?.title || '' }}</h2>

            <!-- Source Switcher & Subtle External Verification Links -->
            <div v-if="sourceFootnotes.length" class="cw-source-footnotes">
              <span class="cw-footnote-label">{{ $t('cosmos.web.report.sourcesLabel') }}</span>
              <template v-for="(src, idx) in sourceFootnotes" :key="src.id">
                <button
                  v-if="sourceFootnotes.length > 1"
                  type="button"
                  class="cw-footnote-switch"
                  :class="{ 'is-active': (webStore.activeArticleItemId || sourceFootnotes[0]?.id) === src.id }"
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
                v-if="activeCluster?.id"
                type="button"
                class="cw-footnote-switch cw-clean-article-toggle"
                :aria-expanded="webStore.cleanArticleOpen"
                @click="webStore.toggleCleanArticle(activeCluster.id)"
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

            <!-- Subtle Perspective Switcher + Regenerate -->
            <div class="cw-perspective-bar">
              <div class="cw-perspective-pills" role="group" :aria-label="$t('cosmos.web.prefs.perspectiveLabel')">
                <button
                  v-for="p in PERSPECTIVE_CHIPS"
                  :key="p.id"
                  type="button"
                  class="cw-persp-btn"
                  :class="{ 'is-active': activePerspective === p.id }"
                  :aria-pressed="activePerspective === p.id"
                  @click="switchPerspective(p.id)"
                >{{ $t(p.labelKey) }}</button>
              </div>
              <button
                type="button"
                class="cw-text-btn cw-regen-btn"
                :disabled="webStore.aiBriefLoading"
                @click="regenerateReport"
              >↻ {{ $t('cosmos.web.ai.regenerate') }}</button>
            </div>

            <!-- Immediate 0ms Stored Excerpt (Shown while AI is loading or unavailable) -->
            <blockquote
              v-if="fallbackExcerpt && (webStore.aiBriefLoading || webStore.aiBriefError || !activeAiBrief)"
              class="cw-pull-quote cw-immediate-excerpt"
            >
              <p>{{ fallbackExcerpt }}</p>
            </blockquote>

            <!-- Atmospheric Researching Shimmer -->
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
                  <button type="button" class="cw-btn cw-btn-primary" @click="regenerateReport">
                    {{ $t('cosmos.web.action.retry') }}
                  </button>
                  <button
                    v-if="activeCluster?.id && !webStore.cleanArticleOpen"
                    type="button"
                    class="cw-btn cw-btn-subtle"
                    @click="webStore.toggleCleanArticle(activeCluster.id)"
                  >{{ $t('cosmos.web.report.readCleanArticle') }}</button>
                </div>
              </div>
            </div>

            <!-- AI Magazine Deep Report Content -->
            <div v-else-if="activeAiBrief" class="cw-magazine-flow">
              <!-- 1. Open Editorial Pull-Quote Lead (tldr) -->
              <blockquote v-if="activeAiBrief.tldr" class="cw-pull-quote">
                <p>{{ activeAiBrief.tldr }}</p>
              </blockquote>

              <!-- 2. Verified Visual Media & GIF Gallery -->
              <section v-if="verifiedMedia.length" class="cw-media-section">
                <div class="cw-media-strip">
                  <button
                    v-for="(m, idx) in verifiedMedia"
                    :key="m.proxyUrl + idx"
                    type="button"
                    class="cw-media-tile"
                    @click="webStore.openLightbox(m)"
                  >
                    <img
                      :src="m.proxyUrl"
                      :alt="m.caption || activeCluster?.headline || ''"
                      loading="lazy"
                      class="cw-media-img"
                      @error="onMediaError(m.proxyUrl)"
                    />
                    <span v-if="m.kind === 'gif'" class="cw-gif-badge">{{ $t('cosmos.web.report.gifBadge') }}</span>
                    <span v-if="m.caption" class="cw-media-caption">{{ m.caption }}</span>
                  </button>
                </div>
              </section>

              <!-- 3. Rich Multi-Section Editorial Body (v2 schema) -->
              <template v-if="reportSections.length">
                <section v-for="(sec, idx) in reportSections" :key="idx" class="cw-editorial-sec">
                  <h3 v-if="sec.heading" class="cw-editorial-h">{{ sec.heading }}</h3>
                  <div v-if="sec.html" class="cw-markdown-prose" v-html="sec.html"></div>
                  <ul v-if="sec.bullets.length" class="cw-bullet-list">
                    <li v-for="(b, bIdx) in sec.bullets" :key="bIdx">{{ b }}</li>
                  </ul>
                </section>
              </template>

              <!-- Smooth v1 Fallback (bullets + impact + fullMarkdown) -->
              <template v-else>
                <section v-if="Array.isArray(activeAiBrief.bullets) && activeAiBrief.bullets.length" class="cw-editorial-sec">
                  <h3 class="cw-editorial-h">{{ $t('cosmos.web.ai.keyPoints') }}</h3>
                  <ul class="cw-bullet-list">
                    <li v-for="(b, idx) in activeAiBrief.bullets" :key="idx">{{ b }}</li>
                  </ul>
                </section>
                <section v-if="activeAiBrief.impact" class="cw-editorial-sec">
                  <h3 class="cw-editorial-h">{{ $t('cosmos.web.ai.impact') }}</h3>
                  <p class="cw-editorial-p">{{ activeAiBrief.impact }}</p>
                </section>
                <div
                  v-if="!activeAiBrief.tldr && renderedAiMarkdownHtml"
                  class="cw-markdown-prose"
                  v-html="renderedAiMarkdownHtml"
                ></div>
              </template>

              <!-- Subtle Verified Web Citations Footnote -->
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

            <!-- Deterministic Media visible even while AI is still researching -->
            <section v-if="webStore.aiBriefLoading && verifiedMedia.length" class="cw-media-section">
              <div class="cw-media-strip">
                <button
                  v-for="(m, idx) in verifiedMedia"
                  :key="m.proxyUrl + idx"
                  type="button"
                  class="cw-media-tile"
                  @click="webStore.openLightbox(m)"
                >
                  <img
                    :src="m.proxyUrl"
                    :alt="m.caption || activeCluster?.headline || ''"
                    loading="lazy"
                    class="cw-media-img"
                    @error="onMediaError(m.proxyUrl)"
                  />
                  <span v-if="m.kind === 'gif'" class="cw-gif-badge">{{ $t('cosmos.web.report.gifBadge') }}</span>
                </button>
              </div>
            </section>

            <!-- 4. Authentic Community Hot Comments (ONLY when real comments exist) -->
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

            <!-- 5. Inline AI Follow-Up Q&A Thread -->
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

            <!-- 6. Whispering Editorial Follow-Up Prompts (NO Pill Bubbles!) -->
            <section v-if="activeAiBrief && Array.isArray(activeAiBrief.followUps) && activeAiBrief.followUps.length" class="cw-whisper-section">
              <h4 class="cw-whisper-heading">{{ $t('cosmos.web.report.followUpTitle') }}</h4>
              <p v-if="agentsLive && !canUseInlineFollowUp" class="cw-inline-hint">{{ $t('cosmos.web.report.upgradeAgentHint') }}</p>
              <ul class="cw-whisper-prompts">
                <li v-for="(q, idx) in activeAiBrief.followUps" :key="idx" class="cw-whisper-item">
                  <button
                    type="button"
                    class="cw-whisper-btn"
                    :disabled="webStore.followUpLoading || !canUseInlineFollowUp"
                    :title="canUseInlineFollowUp ? $t('cosmos.web.report.askAiHint') : $t('cosmos.web.report.upgradeAgentHint')"
                    @click="submitInlineFollowUp(q)"
                  >
                    <span class="cw-whisper-arrow" aria-hidden="true">→</span>
                    <span class="cw-whisper-text">{{ q }}</span>
                  </button>
                  <button
                    type="button"
                    class="cw-whisper-planet-btn"
                    :title="$t('cosmos.web.report.sendToPlanetHint')"
                    :aria-label="$t('cosmos.web.report.sendToPlanetHint')"
                    @click.stop="dispatchFollowUpToPlanet(q)"
                  >☉</button>
                </li>
              </ul>
            </section>
          </div>

          <!-- 7. Sleek Single-Surface Atmospheric Bottom Composer -->
          <div class="cw-drawer-footer">
            <div class="cw-composer-bar">
              <!-- Compact Planet Agent Selector Trigger + Upward Disclosure Popover -->
              <div ref="agentPickerWrap" class="cw-agent-picker-wrap">
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

              <!-- Borderless Single-Line Input -->
              <input
                ref="inlineDispatchInput"
                v-model="composerInput"
                type="text"
                class="cw-composer-input"
                :placeholder="$t('cosmos.web.report.composerPlaceholder')"
                @keydown.enter.prevent="submitInlineFollowUp()"
              />

              <!-- 3 Compact Luminous Controls -->
              <div class="cw-composer-actions">
                <button
                  type="button"
                  class="cw-composer-icon-btn"
                  :disabled="!composerInput.trim() || webStore.followUpLoading || !canUseInlineFollowUp"
                  :title="canUseInlineFollowUp ? $t('cosmos.web.report.askAiHint') : $t('cosmos.web.report.upgradeAgentHint')"
                  :aria-label="canUseInlineFollowUp ? $t('cosmos.web.report.askAiHint') : $t('cosmos.web.report.upgradeAgentHint')"
                  @click="submitInlineFollowUp()"
                >✦</button>
                <button
                  type="button"
                  class="cw-composer-icon-btn"
                  :disabled="!effectiveDispatchAgentId"
                  :title="$t('cosmos.web.report.bgDispatchShort')"
                  :aria-label="$t('cosmos.web.report.bgDispatchShort')"
                  @click="submitInlineDispatch('background')"
                >⇢</button>
                <button
                  type="button"
                  class="cw-send-orb"
                  :disabled="!effectiveDispatchAgentId"
                  :title="$t('cosmos.web.report.flyDispatchShort')"
                  :aria-label="$t('cosmos.web.report.flyDispatchShort')"
                  @click="submitInlineDispatch('fly')"
                >↗</button>
              </div>
            </div>
          </div>
        </template>

        <!-- MODE 2: Intelligence Feed List (Zero Box-in-Box Atmospheric Editorial Rows) -->
        <template v-else>
          <div class="cw-drawer-head">
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

            <!-- Editorial Feed Rows -->
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
                @click="openStory(item)"
                @keydown.enter.self.prevent="openStory(item)"
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

      <!-- Full-Screen Centered Magazine Reader & Daily Briefing Modal -->
      <CosmosWebReaderModal
        :agents="agents"
        :agents-live="agentsLive"
        :agent-to-planet="agentToPlanet"
        @toast="$emit('toast', $event)"
        @dispatch-to-planet="$emit('dispatch-to-planet', $event)"
        @restore-focus="handleReaderRestoreFocus"
      />

      <!-- Domain & Preferences Studio Modal -->
      <CosmosWebPrefsModal
        :agents="agents"
        :agents-live="agentsLive"
        @toast="$emit('toast', $event)"
      />

      <!-- Full-Screen Verified Media & GIF Lightbox -->
      <div
        v-if="webStore.lightboxMedia"
        ref="lightboxDialog"
        class="cw-lightbox"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-label="$t('cosmos.web.report.mediaTitle')"
        @pointerdown.stop
        @wheel.stop
        @click.self="webStore.closeLightbox()"
      >
        <button
          ref="lightboxCloseBtn"
          type="button"
          class="cw-lightbox-close"
          :aria-label="$t('cosmos.web.report.lightboxClose')"
          @click="webStore.closeLightbox()"
        >✕</button>
        <figure class="cw-lightbox-figure">
          <img
            :src="webStore.lightboxMedia.proxyUrl"
            :alt="webStore.lightboxMedia.caption || ''"
            class="cw-lightbox-img"
          />
          <figcaption v-if="webStore.lightboxMedia.caption || webStore.lightboxMedia.sourceName" class="cw-lightbox-caption">
            <span v-if="webStore.lightboxMedia.caption">{{ webStore.lightboxMedia.caption }}</span>
            <span v-if="webStore.lightboxMedia.sourceName" class="cw-lightbox-source">{{ webStore.lightboxMedia.sourceName }}</span>
          </figcaption>
        </figure>
      </div>
    </div>
  `,
};
