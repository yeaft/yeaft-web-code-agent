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
let storeGeneration = 0;
let pulseSeq = 0;
let bandSessionSeq = 0;
let bootstrapInflight = null;
let feedRetryInflight = null;
const channelControllers = new Map();
const channelSeq = new Map();
const mutationControllers = new Set();

function defaultPrefs() {
  return {
    onboarded: false,
    enabledDomains: ['ai', 'tech', 'finance', 'product'],
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
    readerTab: 'article', // 'article' | 'ai'

    articleLoading: false,
    articleData: null,
    articleError: null,
    activeArticleUrl: null,
    activeArticleItemId: null,

    aiBriefLoading: false,
    aiBriefData: null,
    aiBriefError: null,

    dailyBriefingOpen: false,
    dailyBriefingLoading: false,
    dailyBriefingData: null,
    dailyBriefingError: null,

    prefsModalOpen: false,
    drawerCollapsed: false,

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

    async openClusterReader(clusterId, { tab = 'article', expanded = false, itemId = null } = {}) {
      if (!clusterId) return;

      // Immediately abort/invalidate any in-flight reader requests from previous story
      this.sourceSelectionRev += 1;
      invalidateChannel('detail');
      invalidateChannel('article');
      invalidateChannel('aiBrief');
      this.detailLoading = false;
      this.articleLoading = false;
      this.aiBriefLoading = false;

      const isNewCluster = this.readerClusterId !== clusterId || this.activeClusterDetail?.id !== clusterId;
      this.cursorClusterId = clusterId;
      this.selectedClusterId = clusterId;
      this.readerClusterId = clusterId;
      this.readerOpen = true;
      this.readerExpanded = Boolean(expanded);
      this.readerTab = tab === 'ai' ? 'ai' : 'article';
      this.drawerCollapsed = false;

      // Reset transient reader state for new cluster
      if (isNewCluster) {
        this.activeClusterDetail = null;
        this.articleData = null;
        this.articleError = null;
        this.activeArticleUrl = null;
        this.activeArticleItemId = itemId || null;
        this.readerItemId = itemId || null;
        this.aiBriefData = null;
        this.aiBriefError = null;
      } else if (itemId) {
        this.activeArticleItemId = itemId;
        this.readerItemId = itemId;
      }

      this.emitPulse({ clusterId, count: 10 });

      // Mark read optimistically
      this.markRead(clusterId, true);

      // Load detail + article in parallel
      const detailTask = this.loadClusterDetail(clusterId);
      const articleTask = this.loadArticle(clusterId, { itemId: this.activeArticleItemId || undefined });

      if (this.readerTab === 'ai') {
        this.generateAiBrief(clusterId, { itemId: this.activeArticleItemId || undefined });
      }
      await Promise.allSettled([detailTask, articleTask]);
    },

    async selectArticleSource(clusterId, { itemId = null, url = null, perspective = null, agentId = null } = {}) {
      if (!clusterId) return;
      this.sourceSelectionRev += 1;
      this.readerItemId = itemId || null;
      this.activeArticleItemId = itemId || null;
      this.activeArticleUrl = url || null;

      invalidateChannel('article');
      invalidateChannel('aiBrief');
      this.articleLoading = false;
      this.articleError = null;
      this.aiBriefData = null;
      this.aiBriefError = null;
      this.aiBriefLoading = false;

      const tasks = [
        this.loadArticle(clusterId, { itemId: this.activeArticleItemId, url: this.activeArticleUrl }),
      ];
      if (this.readerTab === 'ai') {
        tasks.push(
          this.generateAiBrief(clusterId, {
            itemId: this.activeArticleItemId || undefined,
            perspective: perspective || undefined,
            agentId: agentId || undefined,
          }),
        );
      }
      await Promise.allSettled(tasks);
    },

    closeClusterReader() {
      this.sourceSelectionRev += 1;
      invalidateChannel('detail');
      invalidateChannel('article');
      invalidateChannel('aiBrief');
      this.detailLoading = false;
      this.articleLoading = false;
      this.aiBriefLoading = false;
      this.readerOpen = false;
      this.readerExpanded = false;
      this.readerClusterId = null;
      this.readerItemId = null;
      this.activeArticleItemId = null;
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
        this.activeClusterDetail = data.cluster || data;
        if (data.aiBrief && !this.aiBriefData && this.sourceSelectionRev === capturedSourceRev) {
          this.aiBriefData = data.aiBrief;
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
      const { controller, seq, gen } = nextChannelRequest('article');
      const capturedSourceRev = this.sourceSelectionRev;
      const isCurrentSource = () => (
        !isStaleRequest('article', seq, gen)
        && this.readerOpen
        && this.readerClusterId === clusterId
        && this.sourceSelectionRev === capturedSourceRev
      );
      const targetItemId = itemId || null;
      this.articleLoading = true;
      this.articleError = null;
      this.activeArticleUrl = url || null;
      this.activeArticleItemId = targetItemId;
      this.readerItemId = targetItemId;

      const params = new URLSearchParams();
      if (force) params.set('force', '1');
      if (targetItemId) params.set('itemId', targetItemId);
      if (url) params.set('url', url);
      const qs = params.toString();

      try {
        const data = await apiJson(
          `/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/article${qs ? `?${qs}` : ''}`,
          { signal: controller.signal },
        );
        if (!isCurrentSource()) {
          return;
        }
        const article = data.article || data;
        this.articleData = article;
        if (article?.itemId && !this.activeArticleItemId) {
          this.activeArticleItemId = article.itemId;
          this.readerItemId = article.itemId;
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

    async generateAiBrief(clusterId, { mode = 'brief', agentId = null, perspective = null, force = false, itemId = null } = {}) {
      if (!clusterId) return;
      const { controller, seq, gen } = nextChannelRequest('aiBrief');
      const capturedSourceRev = this.sourceSelectionRev;
      const isCurrentSource = () => (
        !isStaleRequest('aiBrief', seq, gen)
        && this.readerOpen
        && this.readerClusterId === clusterId
        && this.sourceSelectionRev === capturedSourceRev
      );
      const effectiveItemId = itemId || this.activeArticleItemId || this.readerItemId || undefined;
      this.aiBriefLoading = true;
      this.aiBriefError = null;
      try {
        const body = {
          mode,
          perspective: perspective || this.prefs.defaultPerspective || 'balanced',
          language: currentUiLanguage(),
          force: Boolean(force),
        };
        if (effectiveItemId) body.itemId = effectiveItemId;
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
      } catch (err) {
        if (isAbortError(err) || !isCurrentSource()) return;
        this.aiBriefError = err.message || 'Failed to generate AI brief';
      } finally {
        if (isCurrentSource()) {
          this.aiBriefLoading = false;
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
      if (this.loading || this.feedLoading || this.refreshing || !this.feedLoaded) {
        this.staleOnReentry = true;
      }
      bandSessionSeq += 1;
      this.sourceSelectionRev += 1;
      this.activeInWebBand = false;
      bootstrapInflight = null;
      feedRetryInflight = null;
      abortAllChannels();
      this.loading = false;
      this.refreshing = false;
      this.feedLoading = false;
      this.detailLoading = false;
      this.articleLoading = false;
      this.aiBriefLoading = false;
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
      storeGeneration += 1;
      bandSessionSeq += 1;
      bootstrapInflight = null;
      feedRetryInflight = null;
      abortAllChannels();
      channelSeq.clear();
      this.$reset();
    },
  },
});

if (typeof Pinia !== 'undefined') {
  Pinia.useCosmicWebStore = useCosmicWebStore;
}
