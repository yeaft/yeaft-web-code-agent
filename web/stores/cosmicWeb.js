/**
 * Cosmic Web Store — Pinia store for Yeaft Cosmos Intelligence Web (Web Band).
 *
 * Manages domain constellations, 3D semantic graph payload, clustered intelligence feed,
 * in-app clean article reader, AI brief / daily star briefing, user preferences, and
 * 3D pulse signaling (`lastPulseEvent`).
 *
 * Uses standard `fetch('/api/cosmic-web/...')` (automatically authenticated via `installAuthFetch()`),
 * with generation fencing and per-channel `AbortController` to ignore stale/aborted responses.
 */

import { getLocale } from '../utils/i18n.js';

const { defineStore } = Pinia;

const FEED_PAGE_SIZE = 30;
const DRAWER_WIDTH_STORAGE_KEY = 'yeaft-cosmos-web-drawer-width-v1';
const DRAWER_WIDTH_DEFAULT = 480;
const DRAWER_WIDTH_MIN = 360;
const DRAWER_WIDTH_MAX = 960;

function clampDrawerWidth(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return DRAWER_WIDTH_DEFAULT;
  return Math.max(DRAWER_WIDTH_MIN, Math.min(DRAWER_WIDTH_MAX, Math.round(n)));
}

function loadPersistedDrawerWidth() {
  try {
    if (typeof localStorage === 'undefined') return DRAWER_WIDTH_DEFAULT;
    const raw = localStorage.getItem(DRAWER_WIDTH_STORAGE_KEY);
    if (!raw) return DRAWER_WIDTH_DEFAULT;
    return clampDrawerWidth(raw);
  } catch {
    return DRAWER_WIDTH_DEFAULT;
  }
}

function savePersistedDrawerWidth(val) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(DRAWER_WIDTH_STORAGE_KEY, String(clampDrawerWidth(val)));
  } catch { /* ignore storage errors */ }
}

let storeGeneration = 0;
let pulseSeq = 0;
let bandSessionSeq = 0;
let readerSessionToken = 0;
let deferredBriefSeq = 0;
let deferredFollowUpSeq = 0;
let deferredArticleSeq = 0;
let bootstrapInflight = null;
let feedRetryInflight = null;
let activeReaderReconcile = null;
let autoBriefTimer = null;
const channelControllers = new Map();
const channelSeq = new Map();
const mutationControllers = new Set();

function clearAutoBriefTimer() {
  if (autoBriefTimer !== null) {
    clearTimeout(autoBriefTimer);
    autoBriefTimer = null;
  }
}

function defaultPrefs() {
  return {
    onboarded: false,
    enabledDomains: ['ai', 'tech', 'finance', 'product', 'sports'],
    disabledSources: [],
    customDomains: [],
    watchKeywords: [],
    muteKeywords: [],
    preferredAgentId: '',
    defaultPerspective: 'balanced',
    autoRefreshMinutes: 15,
  };
}

function defaultStats() {
  return {
    totalClusters: 0,
    unreadCount: 0,
    bookmarkedCount: 0,
    watchHitCount: 0,
    lastSyncedAt: null,
    sourcesHealthy: 0,
    sourcesTotal: 0,
  };
}

function normalizePrefs(raw) {
  const base = defaultPrefs();
  if (!raw || typeof raw !== 'object') return base;
  return {
    onboarded: typeof raw.onboarded === 'boolean' ? raw.onboarded : base.onboarded,
    enabledDomains: Array.isArray(raw.enabledDomains)
      ? raw.enabledDomains
      : (Array.isArray(raw.enabledDomainIds) ? raw.enabledDomainIds : base.enabledDomains),
    disabledSources: Array.isArray(raw.disabledSources) ? raw.disabledSources : base.disabledSources,
    customDomains: Array.isArray(raw.customDomains) ? raw.customDomains : base.customDomains,
    watchKeywords: Array.isArray(raw.watchKeywords) ? raw.watchKeywords : base.watchKeywords,
    muteKeywords: Array.isArray(raw.muteKeywords) ? raw.muteKeywords : base.muteKeywords,
    preferredAgentId: typeof raw.preferredAgentId === 'string' ? raw.preferredAgentId : base.preferredAgentId,
    defaultPerspective: typeof raw.defaultPerspective === 'string' ? raw.defaultPerspective : base.defaultPerspective,
    autoRefreshMinutes: Number.isInteger(raw.autoRefreshMinutes) ? raw.autoRefreshMinutes : base.autoRefreshMinutes,
  };
}

function invalidateChannel(channel) {
  const prev = channelControllers.get(channel);
  if (prev) {
    try { prev.abort(); } catch { /* ignore */ }
    channelControllers.delete(channel);
  }
  channelSeq.set(channel, (channelSeq.get(channel) || 0) + 1);
}

function nextChannelRequest(channel) {
  const prev = channelControllers.get(channel);
  if (prev) {
    try { prev.abort(); } catch { /* ignore */ }
  }
  const controller = new AbortController();
  channelControllers.set(channel, controller);
  const seq = (channelSeq.get(channel) || 0) + 1;
  channelSeq.set(channel, seq);
  return { controller, seq, gen: storeGeneration };
}

function isStaleRequest(channel, seq, gen) {
  return gen !== storeGeneration || channelSeq.get(channel) !== seq;
}

function createMutationRequest() {
  const controller = new AbortController();
  mutationControllers.add(controller);
  const gen = storeGeneration;
  return {
    controller,
    gen,
    release() {
      mutationControllers.delete(controller);
    },
  };
}

function abortAllChannels() {
  for (const ch of channelSeq.keys()) {
    channelSeq.set(ch, (channelSeq.get(ch) || 0) + 1);
  }
  for (const ctrl of channelControllers.values()) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  channelControllers.clear();
  for (const ctrl of mutationControllers.values()) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  mutationControllers.clear();
}

function currentUiLanguage() {
  return getLocale() === 'en' ? 'en' : 'zh-CN';
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  let payload = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    payload = await res.json().catch(() => null);
  } else {
    const text = await res.text().catch(() => '');
    payload = text ? { message: text } : null;
  }
  if (!res.ok) {
    const msg = payload?.error || payload?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload || {};
}

function isAbortError(err) {
  return Boolean(err && (err.name === 'AbortError' || err.code === 20));
}

export const useCosmicWebStore = defineStore('cosmicWeb', {
  state: () => ({
    bootstrapped: false,
    loading: false,
    refreshing: false,
    error: null,

    prefs: defaultPrefs(),
    domains: [],
    graph: null,
    stats: defaultStats(),
    capableAgents: [],

    feedItems: [],
    feedTotal: 0,
    feedHasMore: false,
    feedLoading: false,
    feedLoaded: false,
    feedQueryRev: 0,

    activeDomain: 'all',
    searchQuery: '',
    sortMode: 'heat', // 'heat' | 'latest'

    activeInWebBand: false,
    staleOnReentry: false,

    hoveredClusterId: null,
    cursorClusterId: null,
    selectedClusterId: null,
    readerClusterId: null,
    readerItemId: null,
    sourceSelectionRev: 0,
    focusedDomainId: null,

    activeClusterDetail: null,
    detailLoading: false,

    readerOpen: false,
    readerExpanded: false,
    readerTab: 'ai', // 'ai' (default Cosmic Web 2.0 deep report)

    articleLoading: false,
    articleData: null,
    articleError: null,
    cleanArticleOpen: false,
    readerSelectionMode: 'default',
    activeArticleUrl: null,
    activeArticleItemId: null,
    resolvedSourceItemId: null,
    unpinnedSourceWork: false,

    aiBriefLoading: false,
    aiBriefData: null,
    aiBriefSourceItemId: null,
    aiBriefError: null,

    followUpThread: [],
    followUpLoading: false,
    followUpError: null,

    lightboxMedia: null,
    radarScanningDomainId: null,

    dailyBriefingOpen: false,
    dailyBriefingLoading: false,
    dailyBriefingData: null,
    dailyBriefingError: null,

    prefsModalOpen: false,
    drawerCollapsed: false,
    drawerWidth: loadPersistedDrawerWidth(),

    lastPulseEvent: null,
  }),

  getters: {
    enabledDomainList(state) {
      const enabledSet = new Set(Array.isArray(state.prefs?.enabledDomains) ? state.prefs.enabledDomains : []);
      const builtIn = (state.domains || []).filter((d) => d && !d.isCustom && enabledSet.has(d.id));
      const custom = (state.prefs?.customDomains || [])
        .filter((c) => c && c.enabled !== false)
        .map((c) => ({
          id: c.id,
          labelZh: c.name || c.labelZh || c.id,
          labelEn: c.name || c.labelEn || c.id,
          colorToken: c.colorToken || 'violet',
          isCustom: true,
          aiRadar: Boolean(c.aiRadar),
          unreadCount: Number(state.domains?.find((d) => d.id === c.id)?.unreadCount || 0),
          itemCount: Number(state.domains?.find((d) => d.id === c.id)?.itemCount || 0),
          sources: Array.isArray(c.rssUrls) ? c.rssUrls : [],
        }));
      return [...builtIn, ...custom];
    },

    activeClusterSummary(state) {
      const targetId = state.readerClusterId || (!state.readerOpen ? state.selectedClusterId : null);
      if (!targetId) return null;
      return state.feedItems.find((item) => item && item.id === targetId) || null;
    },

    activeCluster(state) {
      if (state.readerOpen && state.readerClusterId) {
        if (state.activeClusterDetail && state.activeClusterDetail.id === state.readerClusterId) {
          return state.activeClusterDetail;
        }
        return state.feedItems.find((item) => item && item.id === state.readerClusterId) || null;
      }
      return state.activeClusterDetail || this.activeClusterSummary || null;
    },

    hoveredNodeMeta(state) {
      if (!state.hoveredClusterId) return null;
      const fromFeed = state.feedItems.find((i) => i && i.id === state.hoveredClusterId);
      if (fromFeed) return fromFeed;
      const fromGraph = state.graph?.nodes?.find(
        (n) => n && (n.clusterId === state.hoveredClusterId || n.id === state.hoveredClusterId),
      );
      return fromGraph || null;
    },
  },

  actions: {
    emitPulse({ domainId = null, clusterId = null, count = 8 } = {}) {
      pulseSeq += 1;
      this.lastPulseEvent = { seq: pulseSeq, domainId, clusterId, count };
    },

    setDrawerWidth(width, { persist = true } = {}) {
      const clamped = clampDrawerWidth(width);
      this.drawerWidth = clamped;
      if (persist) savePersistedDrawerWidth(clamped);
    },

    resetDrawerWidth() {
      this.setDrawerWidth(DRAWER_WIDTH_DEFAULT);
    },

    openLightbox(mediaItem) {
      if (!mediaItem || (!mediaItem.proxyUrl && !mediaItem.url)) return;
      this.lightboxMedia = mediaItem;
    },

    closeLightbox() {
      this.lightboxMedia = null;
    },

    async bootstrap({ force = false } = {}) {
      if (this.bootstrapped && this.feedLoaded && !force) return;
      if (bootstrapInflight && bootstrapInflight.gen === storeGeneration && !force) {
        return bootstrapInflight.promise;
      }

      const { controller, seq, gen } = nextChannelRequest('bootstrap');
      this.loading = true;
      this.error = null;

      const run = (async () => {
        try {
          const data = await apiJson('/api/cosmic-web/bootstrap', { signal: controller.signal });
          if (isStaleRequest('bootstrap', seq, gen)) return;

          if (data.prefs || data.preferences) {
            this.prefs = normalizePrefs(data.prefs || data.preferences);
          }
          if (Array.isArray(data.domains)) this.domains = data.domains;
          if (data.graph) this.graph = data.graph;
          if (data.stats) this.stats = { ...defaultStats(), ...data.stats };
          if (Array.isArray(data.capableAgents)) this.capableAgents = data.capableAgents;

          this.bootstrapped = true;
          this.loading = false;

          // If bootstrap didn't embed initial feed, fetch it immediately
          if (Array.isArray(data.feedItems)) {
            this.feedItems = data.feedItems;
            this.feedTotal = Number(data.feedTotal ?? data.feedItems.length);
            this.feedHasMore = Boolean(data.feedHasMore ?? (this.feedItems.length < this.feedTotal));
            this.feedLoaded = true;
          } else {
            await this.fetchFeed({ reset: true });
          }
        } catch (err) {
          if (isAbortError(err) || isStaleRequest('bootstrap', seq, gen)) return;
          this.loading = false;
          this.error = err.message || 'Failed to load Cosmic Web';
        } finally {
          if (bootstrapInflight && bootstrapInflight.promise === run) {
            bootstrapInflight = null;
          }
        }
      })();

      bootstrapInflight = { promise: run, gen };
      return run;
    },

    async fetchFeed({ reset = true } = {}) {
      if (reset) this.feedQueryRev += 1;
      const { controller, seq, gen } = nextChannelRequest('feed');
      this.feedLoading = true;
      if (reset) this.error = null;

      const offset = reset ? 0 : this.feedItems.length;
      const params = new URLSearchParams();
      params.set('limit', String(FEED_PAGE_SIZE));
      params.set('offset', String(offset));
      params.set('sort', this.sortMode || 'heat');

      if (this.activeDomain && this.activeDomain !== 'all') {
        if (this.activeDomain === 'watch') params.set('filter', 'watch');
        else if (this.activeDomain === 'bookmarked') params.set('filter', 'bookmarked');
        else if (this.activeDomain === 'unread') params.set('filter', 'unread');
        else params.set('domain', this.activeDomain);
      }
      const q = String(this.searchQuery || '').trim();
      if (q) params.set('q', q);

      try {
        const data = await apiJson(`/api/cosmic-web/feed?${params.toString()}`, {
          signal: controller.signal,
        });
        if (isStaleRequest('feed', seq, gen)) return;

        const items = Array.isArray(data.items) ? data.items : (Array.isArray(data.clusters) ? data.clusters : []);
        if (reset) {
          this.feedItems = items;
        } else {
          const seen = new Set(this.feedItems.map((it) => it.id));
          const merged = this.feedItems.slice();
          for (const it of items) {
            if (it && !seen.has(it.id)) {
              seen.add(it.id);
              merged.push(it);
            }
          }
          this.feedItems = merged;
        }
        this.feedTotal = Number(data.total ?? this.feedItems.length);
        this.feedHasMore = Boolean(data.hasMore ?? (this.feedItems.length < this.feedTotal));
        this.feedLoaded = true;
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('feed', seq, gen)) return;
        this.error = err.message || 'Failed to fetch feed';
      } finally {
        if (!isStaleRequest('feed', seq, gen)) {
          this.feedLoading = false;
        }
      }
    },

    async loadMoreFeed() {
      if (this.feedLoading || !this.feedHasMore) return;
      await this.fetchFeed({ reset: false });
    },

    async fetchGraph() {
      const { controller, seq, gen } = nextChannelRequest('graph');
      try {
        const data = await apiJson('/api/cosmic-web/graph', { signal: controller.signal });
        if (isStaleRequest('graph', seq, gen)) return;
        this.graph = data.graph || data;
        if (Array.isArray(data.domains)) this.domains = data.domains;
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
      } catch (err) {
        if (isAbortError(err)) return;
      }
    },

    async refreshNow({ domainId = null, force = true } = {}) {
      if (this.refreshing) return;
      const { controller, seq, gen } = nextChannelRequest('refresh');
      this.refreshing = true;
      this.error = null;
      try {
        const body = { force: Boolean(force) };
        if (domainId && !['all', 'watch', 'bookmarked', 'unread'].includes(domainId)) {
          body.domainId = domainId;
        }
        const data = await apiJson('/api/cosmic-web/refresh', {
          method: 'POST',
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (isStaleRequest('refresh', seq, gen)) return;
        if (data.graph) this.graph = data.graph;
        if (Array.isArray(data.domains)) this.domains = data.domains;
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
        this.emitPulse({ domainId: body.domainId || null, count: 14 });
        await Promise.all([
          data.graph ? Promise.resolve() : this.fetchGraph(),
          this.fetchFeed({ reset: true }),
        ]);
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('refresh', seq, gen)) return;
        this.error = err.message || 'Refresh failed';
      } finally {
        if (!isStaleRequest('refresh', seq, gen)) {
          this.refreshing = false;
        }
      }
    },

    async selectDomain(domainId) {
      const next = domainId || 'all';
      this.activeDomain = next;
      this.feedQueryRev += 1;
      const isSpecial = ['all', 'watch', 'bookmarked', 'unread'].includes(next);
      this.focusedDomainId = isSpecial ? null : next;
      this.emitPulse({ domainId: this.focusedDomainId, count: isSpecial ? 10 : 12 });
      await this.fetchFeed({ reset: true });
    },

    async setSortMode(mode) {
      const next = mode === 'latest' ? 'latest' : 'heat';
      if (this.sortMode === next) return;
      this.sortMode = next;
      this.feedQueryRev += 1;
      await this.fetchFeed({ reset: true });
    },

    async setSearchQuery(q) {
      this.searchQuery = String(q ?? '');
      this.feedQueryRev += 1;
      await this.fetchFeed({ reset: true });
    },

    async openClusterReader(clusterId, { expanded = false, itemId = null, url = null, debounceMs = 0 } = {}) {
      if (!clusterId) return;

      // Determine session identity strictly from open story + source selection (NOT whether activeClusterDetail has loaded yet)
      // so reopening the same story before its first detail response stays in the same session and keeps deferred actions attached.
      const isNewCluster = !this.readerOpen || this.readerClusterId !== clusterId;
      const nextUrl = url || null;
      const isUrlOnlySelection = !itemId && Boolean(nextUrl);
      const matchedExisting = !isNewCluster && isUrlOnlySelection
        ? (Array.isArray(this.activeClusterDetail?.items)
          ? this.activeClusterDetail.items.find((it) => it && it.url === nextUrl)
          : null)
        : null;
      const nextItemId = itemId || matchedExisting?.id || null;
      const isSourceChange = !isNewCluster && (
        nextItemId !== (this.activeArticleItemId || null)
        || nextUrl !== (this.activeArticleUrl || null)
      );

      // Immediately cancel any pending auto-brief timer and replace detail/community fetches.
      // Only abort source-scoped channels (article, aiBrief, followUp) and bump sourceSelectionRev
      // when actually switching story/source (or later inside reconcileTask if fresh detail confirms pin drift),
      // so reselecting the SAME open story preserves an in-flight follow-up POST or brief for the same pin!
      clearAutoBriefTimer();
      invalidateChannel('detail');
      invalidateChannel('community');

      const capturedGen = storeGeneration;
      const isSameSessionReopen = !isNewCluster && !isSourceChange;
      const prevSameSessionReconcile = isSameSessionReopen
        && activeReaderReconcile
        && activeReaderReconcile.clusterId === clusterId
        && activeReaderReconcile.gen === capturedGen
        && activeReaderReconcile.session === readerSessionToken
        ? activeReaderReconcile
        : null;

      this.detailLoading = false;
      if (!isSameSessionReopen) {
        this.sourceSelectionRev += 1;
        invalidateChannel('article');
        invalidateChannel('aiBrief');
        invalidateChannel('followUp');
        this.articleLoading = false;
        this.aiBriefLoading = false;
        this.followUpLoading = false;
      }

      this.cursorClusterId = clusterId;
      this.selectedClusterId = clusterId;
      this.readerClusterId = clusterId;
      this.readerOpen = true;
      this.readerExpanded = Boolean(expanded);
      this.readerTab = 'ai';
      this.drawerCollapsed = false;
      this.lightboxMedia = null;

      // Unified selection transition: reset transient state on new cluster OR any source change (including reset to default or URL-only)
      const prevEffectiveSourceId = !isSameSessionReopen
        ? null
        : (this.resolvedSourceItemId || this.aiBriefSourceItemId || this.activeArticleItemId || this.activeClusterDetail?.items?.[0]?.id || null);
      if (!isSameSessionReopen) {
        readerSessionToken += 1;
        if (isNewCluster || (this.activeClusterDetail && this.activeClusterDetail.id !== clusterId)) {
          this.activeClusterDetail = null;
        }
        this.articleData = null;
        this.articleError = null;
        this.cleanArticleOpen = false;
        this.readerSelectionMode = itemId ? 'item' : (nextUrl ? 'url' : 'default');
        this.activeArticleUrl = nextUrl;
        this.activeArticleItemId = nextItemId;
        this.readerItemId = nextItemId;
        this.resolvedSourceItemId = nextItemId || null;
        this.unpinnedSourceWork = false;
        this.aiBriefData = null;
        this.aiBriefSourceItemId = null;
        this.aiBriefError = null;
        this.followUpThread = [];
        this.followUpError = null;
      }

      this.emitPulse({ clusterId, count: 10 });

      // Mark read optimistically
      this.markRead(clusterId, true);

      // Reconcile fresh detail + repin + stale invalidation as a single barrier (activeReaderReconcile)
      // so implicit-source UI actions (perspective switches, follow-ups, clean article) during EITHER first-open
      // OR same-cluster reopen defer cleanly until repin & stale invalidation complete.
      let capturedRev = this.sourceSelectionRev;
      const reconcileEntry = {
        clusterId,
        gen: capturedGen,
        session: readerSessionToken,
        promise: null,
        hasDeferredBrief: Boolean(prevSameSessionReconcile?.hasDeferredBrief),
        hasDeferredFollowUp: Boolean(prevSameSessionReconcile?.hasDeferredFollowUp),
        hasDeferredArticle: Boolean(prevSameSessionReconcile?.hasDeferredArticle),
      };
      const reconcileTask = (async () => {
        await this.loadClusterDetail(clusterId);

        if (
          activeReaderReconcile !== reconcileEntry
          || capturedGen !== storeGeneration
          || !this.readerOpen
          || this.readerClusterId !== clusterId
          || this.sourceSelectionRev !== capturedRev
        ) {
          return { ok: false };
        }

        const detail = this.activeClusterDetail;
        // Always re-resolve URL-only selections against fresh detail items so stale IDs from prior cache cannot linger.
        if (isUrlOnlySelection && this.activeArticleUrl && Array.isArray(detail?.items)) {
          const matched = detail.items.find((it) => it && it.url === this.activeArticleUrl);
          const freshId = matched?.id || null;
          if (freshId !== this.activeArticleItemId) {
            this.activeArticleItemId = freshId;
            this.readerItemId = freshId;
          }
        }
        // Pin the concrete resolved item ID separate from user selection intent (default vs explicit item vs URL).
        // Whenever the resolved pin changes — OR any unpinned request ran while detail was still loading —
        // invalidate stale channels and clear stale data before deferred explicit actions wake up.
        const freshEffectiveSourceId = this.activeArticleItemId || (!isUrlOnlySelection ? (detail?.items?.[0]?.id || null) : null);
        this.resolvedSourceItemId = freshEffectiveSourceId;
        const pinChanged = Boolean(prevEffectiveSourceId && freshEffectiveSourceId !== prevEffectiveSourceId);
        const hadUnpinnedWork = Boolean(this.unpinnedSourceWork && freshEffectiveSourceId);
        const retainedArticleDrift = Boolean(
          this.articleData?.itemId
          && freshEffectiveSourceId
          && this.articleData.itemId !== freshEffectiveSourceId,
        );
        let restartCleanArticle = false;
        if (pinChanged || hadUnpinnedWork || retainedArticleDrift) {
          this.unpinnedSourceWork = false;
          this.sourceSelectionRev += 1;
          capturedRev = this.sourceSelectionRev;
          invalidateChannel('article');
          invalidateChannel('aiBrief');
          invalidateChannel('followUp');
          this.articleData = null;
          this.articleError = null;
          if (!reconcileEntry.hasDeferredArticle) this.articleLoading = false;
          this.aiBriefData = null;
          this.aiBriefSourceItemId = null;
          this.aiBriefError = null;
          if (!reconcileEntry.hasDeferredBrief) this.aiBriefLoading = false;
          this.followUpThread = [];
          this.followUpError = null;
          if (!reconcileEntry.hasDeferredFollowUp) this.followUpLoading = false;
          if (this.cleanArticleOpen && !reconcileEntry.hasDeferredArticle) {
            restartCleanArticle = true;
          }
        }
        return { ok: true, detail, capturedRev, restartCleanArticle };
      })().finally(() => {
        if (activeReaderReconcile === reconcileEntry) {
          activeReaderReconcile = null;
        }
      });
      reconcileEntry.promise = reconcileTask;
      activeReaderReconcile = reconcileEntry;

      const reconciled = await reconcileTask;
      if (!reconciled?.ok) return;
      const { detail } = reconciled;
      capturedRev = reconciled.capturedRev;
      if (reconciled.restartCleanArticle && this.cleanArticleOpen && !reconcileEntry.hasDeferredArticle) {
        void this.loadArticle(clusterId, {
          itemId: this.activeArticleItemId || this.resolvedSourceItemId || undefined,
          url: this.activeArticleUrl || undefined,
        });
      }

      if (!detail?.isPrivateSource && !(Array.isArray(detail?.communityComments) && detail.communityComments.length)) {
        void this.loadClusterCommunity(clusterId, capturedRev);
      }

      if (!this.aiBriefData && !this.aiBriefLoading && !reconcileEntry.hasDeferredBrief) {
        const allowResearch = !detail?.isPrivateSource;
        const triggerBrief = () => {
          autoBriefTimer = null;
          if (
            capturedGen !== storeGeneration
            || !this.readerOpen
            || this.readerClusterId !== clusterId
            || this.sourceSelectionRev !== capturedRev
            || this.aiBriefData
            || this.aiBriefLoading
            || reconcileEntry.hasDeferredBrief
          ) return;
          void this.generateAiBrief(clusterId, {
            research: allowResearch,
            itemId: this.activeArticleItemId || this.resolvedSourceItemId || undefined,
            url: this.activeArticleUrl || undefined,
          });
        };
        if (debounceMs > 0) {
          autoBriefTimer = setTimeout(triggerBrief, debounceMs);
        } else {
          triggerBrief();
        }
      }
    },

    async loadClusterCommunity(clusterId, capturedSourceRev = this.sourceSelectionRev) {
      if (!clusterId) return;
      const { controller, seq, gen } = nextChannelRequest('community');
      try {
        const data = await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/community`, {
          signal: controller.signal,
        });
        if (
          isStaleRequest('community', seq, gen)
          || !this.readerOpen
          || this.readerClusterId !== clusterId
          || this.sourceSelectionRev !== capturedSourceRev
          || !this.activeClusterDetail
          || this.activeClusterDetail.id !== clusterId
        ) return;
        this.activeClusterDetail = {
          ...this.activeClusterDetail,
          ...(Array.isArray(data.media) && data.media.length ? { media: data.media } : {}),
          ...(Array.isArray(data.communityComments) ? { communityComments: data.communityComments } : {}),
        };
      } catch {
        // Community enrichment is non-critical; never surface blocking errors.
      }
    },

    async toggleCleanArticle(clusterId, { force = false } = {}) {
      if (!clusterId) return;
      if (this.cleanArticleOpen && !force) {
        this.cleanArticleOpen = false;
        return;
      }
      this.cleanArticleOpen = true;
      if (!this.articleData || force) {
        await this.loadArticle(clusterId, {
          itemId: this.activeArticleItemId || undefined,
          url: this.activeArticleUrl || undefined,
          force,
        });
      }
    },

    async selectArticleSource(clusterId, { itemId = null, url = null, perspective = null, agentId = null } = {}) {
      if (!clusterId) return;
      const nextUrl = url || null;
      const matched = !itemId && nextUrl && Array.isArray(this.activeClusterDetail?.items)
        ? this.activeClusterDetail.items.find((it) => it && it.url === nextUrl)
        : null;
      const resolvedItemId = itemId || matched?.id || null;
      const nextMode = itemId ? 'item' : (nextUrl ? 'url' : 'default');
      // Clicking the already-active source chip in the same open story is a no-op:
      // never cancel pending follow-ups/briefs or clear the thread when the source did not change.
      const sameOpenStory = this.readerOpen && this.readerClusterId === clusterId;
      const currentEffectiveItemId = this.activeArticleItemId || this.resolvedSourceItemId || null;
      const isAlreadySelected = sameOpenStory && (
        (resolvedItemId && resolvedItemId === currentEffectiveItemId)
        || (!resolvedItemId && nextUrl && nextUrl === this.activeArticleUrl)
      );
      if (isAlreadySelected) {
        if (resolvedItemId && !this.activeArticleItemId) {
          this.readerSelectionMode = nextMode;
          this.activeArticleItemId = resolvedItemId;
          this.readerItemId = resolvedItemId;
          this.activeArticleUrl = nextUrl;
        }
        return;
      }

      clearAutoBriefTimer();
      readerSessionToken += 1;
      this.sourceSelectionRev += 1;
      this.readerSelectionMode = nextMode;
      this.readerItemId = resolvedItemId;
      this.activeArticleItemId = resolvedItemId;
      this.activeArticleUrl = nextUrl;
      this.resolvedSourceItemId = resolvedItemId || (!nextUrl ? (this.activeClusterDetail?.items?.[0]?.id || null) : null);
      this.unpinnedSourceWork = false;

      invalidateChannel('article');
      invalidateChannel('aiBrief');
      invalidateChannel('followUp');
      this.articleData = null;
      this.articleLoading = false;
      this.articleError = null;
      this.aiBriefData = null;
      this.aiBriefSourceItemId = null;
      this.aiBriefError = null;
      this.aiBriefLoading = false;
      this.followUpThread = [];
      this.followUpError = null;
      this.followUpLoading = false;

      if (this.cleanArticleOpen) {
        void this.loadArticle(clusterId, {
          itemId: this.activeArticleItemId || this.resolvedSourceItemId || undefined,
          url: this.activeArticleUrl || undefined,
        });
      }

      return this.generateAiBrief(clusterId, {
        research: !this.activeClusterDetail?.isPrivateSource,
        itemId: this.activeArticleItemId || this.resolvedSourceItemId || undefined,
        url: this.activeArticleUrl || undefined,
        perspective: perspective || undefined,
        agentId: agentId || undefined,
      });
    },

    closeClusterReader() {
      clearAutoBriefTimer();
      readerSessionToken += 1;
      this.sourceSelectionRev += 1;
      invalidateChannel('detail');
      invalidateChannel('community');
      invalidateChannel('article');
      invalidateChannel('aiBrief');
      invalidateChannel('followUp');
      this.detailLoading = false;
      this.articleLoading = false;
      this.cleanArticleOpen = false;
      this.aiBriefLoading = false;
      this.followUpLoading = false;
      this.followUpError = null;
      this.lightboxMedia = null;
      this.readerOpen = false;
      this.readerExpanded = false;
      this.readerClusterId = null;
      this.readerItemId = null;
      this.readerSelectionMode = 'default';
      this.activeArticleItemId = null;
      this.activeArticleUrl = null;
      this.resolvedSourceItemId = null;
      this.unpinnedSourceWork = false;
      this.aiBriefSourceItemId = null;
      activeReaderReconcile = null;
    },

    async loadClusterDetail(clusterId) {
      if (!clusterId) return;
      const { controller, seq, gen } = nextChannelRequest('detail');
      const capturedSourceRev = this.sourceSelectionRev;
      this.detailLoading = true;
      try {
        const data = await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}`, {
          signal: controller.signal,
        });
        if (isStaleRequest('detail', seq, gen) || !this.readerOpen || this.readerClusterId !== clusterId) return;
        const clusterObj = data.cluster || data;
        this.activeClusterDetail = clusterObj;
        if (data.aiBrief && !this.aiBriefData && !this.aiBriefLoading && this.sourceSelectionRev === capturedSourceRev) {
          this.aiBriefData = data.aiBrief;
          this.aiBriefSourceItemId = clusterObj?.items?.[0]?.id || null;
        }
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('detail', seq, gen)) return;
      } finally {
        if (!isStaleRequest('detail', seq, gen)) {
          this.detailLoading = false;
        }
      }
    },

    async loadArticle(clusterId, { force = false, url = null, itemId = null } = {}) {
      if (!clusterId) return;
      // Defer implicit-source Clean Article requests across first-open, reopen, and superseded reopens until the latest reconciliation finishes.
      if (!itemId && activeReaderReconcile && activeReaderReconcile.clusterId === clusterId && activeReaderReconcile.gen === storeGeneration) {
        const myGen = storeGeneration;
        const mySession = readerSessionToken;
        const mySeq = ++deferredArticleSeq;
        this.articleLoading = true;
        this.articleError = null;
        while (
          activeReaderReconcile
          && activeReaderReconcile.clusterId === clusterId
          && activeReaderReconcile.gen === myGen
          && activeReaderReconcile.session === mySession
        ) {
          activeReaderReconcile.hasDeferredArticle = true;
          await activeReaderReconcile.promise;
          if (myGen !== storeGeneration || mySession !== readerSessionToken || mySeq !== deferredArticleSeq
            || !this.readerOpen || this.readerClusterId !== clusterId) {
            return;
          }
        }
      }
      const { controller, seq, gen } = nextChannelRequest('article');
      const capturedSourceRev = this.sourceSelectionRev;
      const isCurrentSource = () => (
        !isStaleRequest('article', seq, gen)
        && this.readerOpen
        && this.readerClusterId === clusterId
        && this.sourceSelectionRev === capturedSourceRev
      );
      this.articleLoading = true;
      this.articleError = null;
      try {
        // Pin to the same resolved item ID as brief/follow-up without mutating explicit selection intent.
        const effectiveItemId = itemId || this.activeArticleItemId || this.resolvedSourceItemId || null;
        const effectiveUrl = effectiveItemId ? null : (url || this.activeArticleUrl || null);
        if (!effectiveItemId) this.unpinnedSourceWork = true;

        const params = new URLSearchParams();
        if (force) params.set('force', '1');
        if (effectiveItemId) params.set('itemId', effectiveItemId);
        else if (effectiveUrl) params.set('url', effectiveUrl);
        const qs = params.toString();

        const data = await apiJson(
          `/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/article${qs ? `?${qs}` : ''}`,
          { signal: controller.signal },
        );
        if (!isCurrentSource()) {
          return;
        }
        const article = data.article || data;
        this.articleData = article;
        if (article?.itemId && !this.resolvedSourceItemId) {
          this.resolvedSourceItemId = article.itemId;
        }
      } catch (err) {
        if (isAbortError(err) || !isCurrentSource()) return;
        this.articleError = err.message || 'Failed to load article';
      } finally {
        if (isCurrentSource()) {
          this.articleLoading = false;
        }
      }
    },

    async generateAiBrief(clusterId, { mode = 'brief', agentId = null, perspective = null, force = false, itemId = null, url = null, research = true } = {}) {
      if (!clusterId) return;
      // Defer implicit-source brief generation across first-open, reopen, and superseded reopens until the latest reconciliation finishes,
      // preserving the user's exact perspective and Agent selection.
      if (!itemId && activeReaderReconcile && activeReaderReconcile.clusterId === clusterId && activeReaderReconcile.gen === storeGeneration) {
        const myGen = storeGeneration;
        const mySession = readerSessionToken;
        const mySeq = ++deferredBriefSeq;
        this.aiBriefLoading = true;
        this.aiBriefError = null;
        while (
          activeReaderReconcile
          && activeReaderReconcile.clusterId === clusterId
          && activeReaderReconcile.gen === myGen
          && activeReaderReconcile.session === mySession
        ) {
          activeReaderReconcile.hasDeferredBrief = true;
          await activeReaderReconcile.promise;
          if (myGen !== storeGeneration || mySession !== readerSessionToken || mySeq !== deferredBriefSeq
            || !this.readerOpen || this.readerClusterId !== clusterId) {
            return;
          }
        }
      }
      const { controller, seq, gen } = nextChannelRequest('aiBrief');
      const capturedSourceRev = this.sourceSelectionRev;
      const isCurrentSource = () => (
        !isStaleRequest('aiBrief', seq, gen)
        && this.readerOpen
        && this.readerClusterId === clusterId
        && this.sourceSelectionRev === capturedSourceRev
      );
      this.aiBriefLoading = true;
      this.aiBriefError = null;
      try {
        const effectiveUrl = url || this.activeArticleUrl || undefined;
        const matchedByUrl = !itemId && !this.activeArticleItemId && !this.readerItemId && !this.resolvedSourceItemId && effectiveUrl
          && Array.isArray(this.activeClusterDetail?.items)
          ? this.activeClusterDetail.items.find((it) => it && it.url === effectiveUrl)
          : null;
        const effectiveItemId = itemId || this.activeArticleItemId || this.readerItemId || this.resolvedSourceItemId || matchedByUrl?.id || undefined;
        if (!effectiveItemId) this.unpinnedSourceWork = true;
        const body = {
          mode,
          perspective: perspective || this.prefs.defaultPerspective || 'balanced',
          language: currentUiLanguage(),
          force: Boolean(force),
          research: Boolean(research) && !this.activeClusterDetail?.isPrivateSource,
        };
        if (effectiveItemId) body.itemId = effectiveItemId;
        else if (effectiveUrl) body.url = effectiveUrl;
        const explicitAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
        if (explicitAgentId) body.agentId = explicitAgentId;

        const data = await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/ai-brief`, {
          method: 'POST',
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!isCurrentSource()) {
          return;
        }
        this.aiBriefData = data.brief || data;
        this.aiBriefSourceItemId = effectiveItemId || null;
        if (!this.resolvedSourceItemId && this.aiBriefSourceItemId) {
          this.resolvedSourceItemId = this.aiBriefSourceItemId;
        }
      } catch (err) {
        if (isAbortError(err) || !isCurrentSource()) return;
        this.aiBriefError = err.message || 'Failed to generate AI brief';
      } finally {
        if (isCurrentSource()) {
          this.aiBriefLoading = false;
        }
      }
    },

    async askFollowUp(clusterId, question, { agentId = null, perspective = null, itemId = null, url = null } = {}) {
      const q = String(question || '').trim();
      if (!clusterId || !q) return null;
      // Defer implicit-source follow-ups across first-open, reopen, and superseded reopens until the latest reconciliation finishes
      // so submitted user questions never vanish and never carry stale briefContext from a replaced source!
      if (!itemId && activeReaderReconcile && activeReaderReconcile.clusterId === clusterId && activeReaderReconcile.gen === storeGeneration) {
        // Never overwrite an already-accepted deferred follow-up in the same session.
        if (activeReaderReconcile.session === readerSessionToken && activeReaderReconcile.hasDeferredFollowUp) {
          return null;
        }
        const myGen = storeGeneration;
        const mySession = readerSessionToken;
        const mySeq = ++deferredFollowUpSeq;
        this.followUpLoading = true;
        this.followUpError = null;
        while (
          activeReaderReconcile
          && activeReaderReconcile.clusterId === clusterId
          && activeReaderReconcile.gen === myGen
          && activeReaderReconcile.session === mySession
        ) {
          activeReaderReconcile.hasDeferredFollowUp = true;
          await activeReaderReconcile.promise;
          if (myGen !== storeGeneration || mySession !== readerSessionToken || mySeq !== deferredFollowUpSeq
            || !this.readerOpen || this.readerClusterId !== clusterId) {
            return null;
          }
        }
      }
      const { controller, seq, gen } = nextChannelRequest('followUp');
      const capturedSourceRev = this.sourceSelectionRev;
      const isCurrent = () => (
        !isStaleRequest('followUp', seq, gen)
        && this.readerOpen
        && this.readerClusterId === clusterId
        && this.sourceSelectionRev === capturedSourceRev
      );
      this.followUpLoading = true;
      this.followUpError = null;
      try {
        const effectiveUrl = url || this.activeArticleUrl || undefined;
        const matchedByUrl = !itemId && !this.activeArticleItemId && !this.readerItemId && !this.resolvedSourceItemId && effectiveUrl
          && Array.isArray(this.activeClusterDetail?.items)
          ? this.activeClusterDetail.items.find((it) => it && it.url === effectiveUrl)
          : null;
        const effectiveItemId = itemId || this.activeArticleItemId || this.readerItemId || this.resolvedSourceItemId || matchedByUrl?.id || undefined;
        if (!effectiveItemId) this.unpinnedSourceWork = true;
        const body = {
          question: q,
          perspective: perspective || this.prefs.defaultPerspective || 'balanced',
          language: currentUiLanguage(),
          research: !this.activeClusterDetail?.isPrivateSource,
        };
        if (effectiveItemId) body.itemId = effectiveItemId;
        else if (effectiveUrl) body.url = effectiveUrl;
        if (this.aiBriefData?.tldr) body.briefContext = this.aiBriefData.tldr;
        const explicitAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
        if (explicitAgentId) body.agentId = explicitAgentId;

        const data = await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/follow-up`, {
          method: 'POST',
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!isCurrent()) return null;
        const searchCount = Number(data.searchCount ?? data.webSearchCount ?? 0);
        const evidenceCount = data.evidenceCount != null ? Number(data.evidenceCount) : (data.researched ? searchCount : 0);
        const entry = {
          id: `fu-${Date.now().toString(36)}-${seq}`,
          question: q,
          answer: data.answer || data.markdown || data.text || '',
          bullets: Array.isArray(data.bullets) ? data.bullets.filter(Boolean) : [],
          citations: Array.isArray(data.citations) ? data.citations : [],
          media: Array.isArray(data.media) ? data.media : [],
          agentName: data.agentName || '',
          searchCount,
          evidenceCount,
          webSearchCount: searchCount,
          createdAt: Date.now(),
        };
        this.followUpThread = [...this.followUpThread, entry];
        return entry;
      } catch (err) {
        if (isAbortError(err) || !isCurrent()) return null;
        this.followUpError = err.message || 'Failed to answer follow-up';
        return null;
      } finally {
        if (isCurrent()) {
          this.followUpLoading = false;
        }
      }
    },

    async scanTopicRadar(domainId, { agentId = null } = {}) {
      if (!domainId) return null;
      const { controller, seq, gen } = nextChannelRequest('radarScan');
      this.radarScanningDomainId = domainId;
      try {
        const body = { language: currentUiLanguage() };
        const explicitAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
        if (explicitAgentId) body.agentId = explicitAgentId;

        const data = await apiJson(`/api/cosmic-web/domains/${encodeURIComponent(domainId)}/radar-scan`, {
          method: 'POST',
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (isStaleRequest('radarScan', seq, gen)) return null;
        if (Array.isArray(data.domains)) this.domains = data.domains;
        if (data.graph) this.graph = data.graph;
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
        this.emitPulse({ domainId, count: 16 });
        await Promise.all([
          data.graph ? Promise.resolve() : this.fetchGraph(),
          this.fetchFeed({ reset: true }),
        ]);
        if (isStaleRequest('radarScan', seq, gen)) return null;
        return data;
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('radarScan', seq, gen)) return null;
        throw err;
      } finally {
        if (!isStaleRequest('radarScan', seq, gen) && this.radarScanningDomainId === domainId) {
          this.radarScanningDomainId = null;
        }
      }
    },

    async openDailyBriefing({ agentId = null, perspective = null, force = false } = {}) {
      this.dailyBriefingOpen = true;
      if (this.dailyBriefingData && !force) return;
      const { controller, seq, gen } = nextChannelRequest('dailyBriefing');
      this.dailyBriefingLoading = true;
      this.dailyBriefingError = null;
      try {
        const body = {
          perspective: perspective || this.prefs.defaultPerspective || 'balanced',
          language: currentUiLanguage(),
          force: Boolean(force),
        };
        const explicitAgentId = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
        if (explicitAgentId) body.agentId = explicitAgentId;

        const data = await apiJson('/api/cosmic-web/daily-briefing', {
          method: 'POST',
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (isStaleRequest('dailyBriefing', seq, gen) || !this.dailyBriefingOpen) return;
        this.dailyBriefingData = data.briefing || data;
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('dailyBriefing', seq, gen) || !this.dailyBriefingOpen) return;
        this.dailyBriefingError = err.message || 'Failed to generate daily briefing';
      } finally {
        if (!isStaleRequest('dailyBriefing', seq, gen)) {
          this.dailyBriefingLoading = false;
        }
      }
    },

    closeDailyBriefing() {
      invalidateChannel('dailyBriefing');
      this.dailyBriefingLoading = false;
      this.dailyBriefingOpen = false;
    },

    _patchClusterLocal(clusterId, patch) {
      const idx = this.feedItems.findIndex((it) => it && it.id === clusterId);
      if (idx >= 0) {
        const next = this.feedItems.slice();
        next[idx] = { ...next[idx], ...patch };
        this.feedItems = next;
      }
      if (this.activeClusterDetail && this.activeClusterDetail.id === clusterId) {
        this.activeClusterDetail = { ...this.activeClusterDetail, ...patch };
      }
      if (this.graph && Array.isArray(this.graph.nodes)) {
        for (const n of this.graph.nodes) {
          if (n && (n.clusterId === clusterId || n.id === clusterId)) {
            if (patch.isRead !== undefined) n.unread = !patch.isRead;
            if (patch.unread !== undefined) n.unread = patch.unread;
            if (patch.isBookmarked !== undefined) n.bookmarked = patch.isBookmarked;
            if (patch.bookmarked !== undefined) n.bookmarked = patch.bookmarked;
          }
        }
      }
    },

    async toggleBookmark(clusterId) {
      if (!clusterId) return;
      const { controller, gen, release } = createMutationRequest();
      const existing = this.feedItems.find((it) => it && it.id === clusterId)
        || (this.activeClusterDetail?.id === clusterId ? this.activeClusterDetail : null);
      const prev = Boolean(existing?.isBookmarked ?? existing?.bookmarked);
      const nextVal = !prev;
      this._patchClusterLocal(clusterId, { isBookmarked: nextVal, bookmarked: nextVal });
      this.stats.bookmarkedCount = Math.max(0, Number(this.stats.bookmarkedCount || 0) + (nextVal ? 1 : -1));
      try {
        await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/state`, {
          method: 'PATCH',
          body: JSON.stringify({ bookmarked: nextVal }),
          signal: controller.signal,
        });
        if (gen !== storeGeneration) return;
      } catch {
        if (gen !== storeGeneration) return;
        // Revert on failure
        this._patchClusterLocal(clusterId, { isBookmarked: prev, bookmarked: prev });
        this.stats.bookmarkedCount = Math.max(0, Number(this.stats.bookmarkedCount || 0) + (prev ? 1 : -1));
      } finally {
        release();
      }
    },

    async markRead(clusterId, read = true) {
      if (!clusterId) return;
      const existing = this.feedItems.find((it) => it && it.id === clusterId)
        || (this.activeClusterDetail?.id === clusterId ? this.activeClusterDetail : null);
      const wasRead = Boolean(existing?.isRead ?? (existing?.unread === false));
      if (wasRead === Boolean(read)) return;
      const { controller, gen, release } = createMutationRequest();
      this._patchClusterLocal(clusterId, { isRead: Boolean(read), unread: !read });
      this.stats.unreadCount = Math.max(0, Number(this.stats.unreadCount || 0) + (read ? -1 : 1));
      try {
        await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/state`, {
          method: 'PATCH',
          body: JSON.stringify({ read: Boolean(read) }),
          signal: controller.signal,
        });
        if (gen !== storeGeneration) return;
      } catch {
        if (gen !== storeGeneration) return;
        // Revert on failure
        this._patchClusterLocal(clusterId, { isRead: wasRead, unread: !wasRead });
        this.stats.unreadCount = Math.max(0, Number(this.stats.unreadCount || 0) + (wasRead ? -1 : 1));
      } finally {
        release();
      }
    },

    async muteCluster(clusterId) {
      if (!clusterId) return;
      const { controller, gen, release } = createMutationRequest();
      const prevItems = this.feedItems.slice();
      this.feedItems = this.feedItems.filter((it) => it && it.id !== clusterId);
      if (this.readerClusterId === clusterId || this.selectedClusterId === clusterId) {
        this.closeClusterReader();
        this.selectedClusterId = null;
      }
      if (this.cursorClusterId === clusterId) {
        this.cursorClusterId = null;
      }
      try {
        await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/state`, {
          method: 'PATCH',
          body: JSON.stringify({ muted: true }),
          signal: controller.signal,
        });
        if (gen !== storeGeneration) return;
      } catch {
        if (gen !== storeGeneration) return;
        this.feedItems = prevItems;
      } finally {
        release();
      }
    },

    async markAllRead(domainIdArg = null) {
      const { controller, gen, release } = createMutationRequest();
      const capturedFeedRev = this.feedQueryRev;
      const capturedBandSeq = bandSessionSeq;
      const wasActiveInBand = this.activeInWebBand;
      const active = domainIdArg || this.activeDomain || 'all';
      const isSpecial = ['all', 'watch', 'bookmarked', 'unread'].includes(active);
      const targetDomain = !isSpecial ? active : null;
      const targetFilter = ['watch', 'bookmarked', 'unread'].includes(active) ? active : null;
      const targetQ = String(this.searchQuery || '').trim() || null;

      // Optimistically mark matching currently-displayed items read only (never snapshot-revert over newer queries)
      this.feedItems = this.feedItems.map((it) => {
        if (!it) return it;
        if (
          !targetDomain
          || it.domainId === targetDomain
          || (Array.isArray(it.domainIds) && it.domainIds.includes(targetDomain))
        ) {
          return { ...it, isRead: true, unread: false };
        }
        return it;
      });
      const isAbandoned = () => (
        gen !== storeGeneration
        || controller.signal.aborted
        || capturedBandSeq !== bandSessionSeq
        || (wasActiveInBand && !this.activeInWebBand)
      );
      try {
        const body = {};
        if (targetDomain) body.domainId = targetDomain;
        if (targetFilter) body.filter = targetFilter;
        if (targetQ) body.q = targetQ;

        const data = await apiJson('/api/cosmic-web/mark-all-read', {
          method: 'POST',
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (gen !== storeGeneration) return;
        if (isAbandoned()) {
          this.staleOnReentry = true;
          return;
        }
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
        else if (!targetDomain && !targetFilter && !targetQ) this.stats.unreadCount = 0;
        if (Array.isArray(data.domains)) this.domains = data.domains;
        if (data.graph) this.graph = data.graph;
        await this.fetchFeed({ reset: true });
      } catch {
        if (gen !== storeGeneration) return;
        if (isAbandoned()) {
          this.staleOnReentry = true;
          return;
        }
        if (this.feedQueryRev === capturedFeedRev) {
          await this.fetchFeed({ reset: true });
        }
      } finally {
        release();
      }
    },

    async savePreferences(nextPrefs) {
      const { controller, seq, gen } = nextChannelRequest('savePreferences');
      const merged = normalizePrefs({ ...this.prefs, ...nextPrefs });
      const data = await apiJson('/api/cosmic-web/preferences', {
        method: 'PUT',
        body: JSON.stringify(merged),
        signal: controller.signal,
      });
      if (isStaleRequest('savePreferences', seq, gen)) return null;
      this.prefs = normalizePrefs(data.prefs || data.preferences || merged);
      if (Array.isArray(data.domains)) this.domains = data.domains;
      if (data.graph) this.graph = data.graph;
      if (data.stats) this.stats = { ...this.stats, ...data.stats };
      this.emitPulse({ count: 16 });
      if (isStaleRequest('savePreferences', seq, gen)) return null;
      await Promise.all([
        data.graph ? Promise.resolve() : this.fetchGraph(),
        this.fetchFeed({ reset: true }),
      ]);
      if (isStaleRequest('savePreferences', seq, gen)) return null;
      return this.prefs;
    },

    async completeOnboarding({ enabledDomains, watchKeywords = [], customDomains = [] } = {}) {
      const gen = storeGeneration;
      const next = {
        ...this.prefs,
        onboarded: true,
        enabledDomains: Array.isArray(enabledDomains) && enabledDomains.length > 0
          ? enabledDomains
          : this.prefs.enabledDomains,
        watchKeywords: Array.isArray(watchKeywords) ? watchKeywords : this.prefs.watchKeywords,
        customDomains: Array.isArray(customDomains) ? customDomains : this.prefs.customDomains,
      };
      const saved = await this.savePreferences(next);
      if (gen !== storeGeneration || !saved) return;
      await this.refreshNow({ force: false });
    },

    async handleExternalUpdate(msg) {
      if (!this.activeInWebBand) {
        this.staleOnReentry = true;
        return;
      }
      const domainId = msg?.domainId || null;
      const clusterId = msg?.clusterId || null;
      this.emitPulse({ domainId, clusterId, count: 10 });
      if (!this.bootstrapped) return;
      await Promise.allSettled([
        this.fetchGraph(),
        this.fetchFeed({ reset: true }),
      ]);
    },

    async enterWebBand() {
      this.activeInWebBand = true;
      if (bootstrapInflight && bootstrapInflight.gen === storeGeneration && !this.staleOnReentry) {
        return bootstrapInflight.promise;
      }
      if (!this.bootstrapped || !this.feedLoaded || this.staleOnReentry) {
        const shouldForceBootstrap = !this.bootstrapped || this.staleOnReentry;
        this.staleOnReentry = false;
        if (shouldForceBootstrap) {
          await this.bootstrap({ force: true });
        } else {
          if (feedRetryInflight && feedRetryInflight.gen === storeGeneration) {
            return feedRetryInflight.promise;
          }
          const gen = storeGeneration;
          const promise = this.fetchFeed({ reset: true }).finally(() => {
            if (feedRetryInflight && feedRetryInflight.promise === promise) {
              feedRetryInflight = null;
            }
          });
          feedRetryInflight = { gen, promise };
          await promise;
        }
      }
    },

    leaveWebBand() {
      clearAutoBriefTimer();
      if (this.loading || this.feedLoading || this.refreshing || !this.feedLoaded) {
        this.staleOnReentry = true;
      }
      bandSessionSeq += 1;
      this.sourceSelectionRev += 1;
      this.activeInWebBand = false;
      readerSessionToken += 1;
      bootstrapInflight = null;
      feedRetryInflight = null;
      activeReaderReconcile = null;
      abortAllChannels();
      this.loading = false;
      this.refreshing = false;
      this.feedLoading = false;
      this.detailLoading = false;
      this.articleLoading = false;
      this.cleanArticleOpen = false;
      this.aiBriefLoading = false;
      this.followUpLoading = false;
      this.followUpError = null;
      this.lightboxMedia = null;
      this.radarScanningDomainId = null;
      this.dailyBriefingLoading = false;
      this.hoveredClusterId = null;
      this.readerOpen = false;
      this.readerExpanded = false;
      this.readerClusterId = null;
      this.readerItemId = null;
      this.activeArticleItemId = null;
      this.dailyBriefingOpen = false;
      this.prefsModalOpen = false;
    },

    onLeaveWebBand() {
      this.leaveWebBand();
    },

    reset() {
      clearAutoBriefTimer();
      storeGeneration += 1;
      bandSessionSeq += 1;
      readerSessionToken += 1;
      bootstrapInflight = null;
      feedRetryInflight = null;
      activeReaderReconcile = null;
      abortAllChannels();
      channelSeq.clear();
      this.$reset();
    },
  },
});

if (typeof Pinia !== 'undefined') {
  Pinia.useCosmicWebStore = useCosmicWebStore;
}
