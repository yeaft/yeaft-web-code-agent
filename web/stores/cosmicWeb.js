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

const { defineStore } = Pinia;

const FEED_PAGE_SIZE = 30;
let storeGeneration = 0;
let pulseSeq = 0;
const channelControllers = new Map();
const channelSeq = new Map();

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
    ...base,
    ...raw,
    enabledDomains: Array.isArray(raw.enabledDomains) ? raw.enabledDomains : base.enabledDomains,
    disabledSources: Array.isArray(raw.disabledSources) ? raw.disabledSources : base.disabledSources,
    customDomains: Array.isArray(raw.customDomains) ? raw.customDomains : base.customDomains,
    watchKeywords: Array.isArray(raw.watchKeywords) ? raw.watchKeywords : base.watchKeywords,
    muteKeywords: Array.isArray(raw.muteKeywords) ? raw.muteKeywords : base.muteKeywords,
  };
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

function abortAllChannels() {
  for (const ctrl of channelControllers.values()) {
    try { ctrl.abort(); } catch { /* ignore */ }
  }
  channelControllers.clear();
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

    activeDomain: 'all',
    searchQuery: '',
    sortMode: 'heat', // 'heat' | 'latest'

    hoveredClusterId: null,
    selectedClusterId: null,
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
      const enabledSet = new Set(state.prefs?.enabledDomains || []);
      const builtIn = (state.domains || []).filter((d) => !d.isCustom && (enabledSet.size === 0 || enabledSet.has(d.id)));
      const custom = (state.prefs?.customDomains || []).map((c) => ({
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
      if (!state.selectedClusterId) return null;
      return state.feedItems.find((item) => item && item.id === state.selectedClusterId) || null;
    },

    activeCluster(state) {
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
      if (this.bootstrapped && !force) return;
      const { controller, seq, gen } = nextChannelRequest('bootstrap');
      this.loading = true;
      this.error = null;
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
        } else {
          await this.fetchFeed({ reset: true });
        }
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('bootstrap', seq, gen)) return;
        this.loading = false;
        this.error = err.message || 'Failed to load Cosmic Web';
      }
    },

    async fetchFeed({ reset = true } = {}) {
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
      const isSpecial = ['all', 'watch', 'bookmarked', 'unread'].includes(next);
      this.focusedDomainId = isSpecial ? null : next;
      this.emitPulse({ domainId: this.focusedDomainId, count: isSpecial ? 10 : 12 });
      await this.fetchFeed({ reset: true });
    },

    async setSortMode(mode) {
      const next = mode === 'latest' ? 'latest' : 'heat';
      if (this.sortMode === next) return;
      this.sortMode = next;
      await this.fetchFeed({ reset: true });
    },

    async setSearchQuery(q) {
      this.searchQuery = String(q ?? '');
      await this.fetchFeed({ reset: true });
    },

    async openClusterReader(clusterId, { tab = 'article', expanded = false } = {}) {
      if (!clusterId) return;
      this.selectedClusterId = clusterId;
      this.readerOpen = true;
      this.readerExpanded = Boolean(expanded);
      this.readerTab = tab === 'ai' ? 'ai' : 'article';
      this.drawerCollapsed = false;

      // Reset transient reader state for new cluster
      if (this.activeClusterDetail?.id !== clusterId) {
        this.activeClusterDetail = null;
        this.articleData = null;
        this.articleError = null;
        this.activeArticleUrl = null;
        this.aiBriefData = null;
        this.aiBriefError = null;
      }

      this.emitPulse({ clusterId, count: 10 });

      // Mark read optimistically
      this.markRead(clusterId, true);

      // Load detail + article in parallel
      const detailTask = this.loadClusterDetail(clusterId);
      const articleTask = this.loadArticle(clusterId);

      if (this.readerTab === 'ai') {
        this.generateAiBrief(clusterId);
      }
      await Promise.allSettled([detailTask, articleTask]);
    },

    closeClusterReader() {
      this.readerOpen = false;
      this.readerExpanded = false;
    },

    async loadClusterDetail(clusterId) {
      const { controller, seq, gen } = nextChannelRequest('detail');
      this.detailLoading = true;
      try {
        const data = await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}`, {
          signal: controller.signal,
        });
        if (isStaleRequest('detail', seq, gen)) return;
        this.activeClusterDetail = data.cluster || data;
        if (data.aiBrief && !this.aiBriefData) {
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

    async loadArticle(clusterId, { force = false, url = null } = {}) {
      if (!clusterId) return;
      const { controller, seq, gen } = nextChannelRequest('article');
      this.articleLoading = true;
      this.articleError = null;
      this.activeArticleUrl = url || null;

      const params = new URLSearchParams();
      if (force) params.set('force', '1');
      if (url) params.set('url', url);
      const qs = params.toString();

      try {
        const data = await apiJson(
          `/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/article${qs ? `?${qs}` : ''}`,
          { signal: controller.signal },
        );
        if (isStaleRequest('article', seq, gen)) return;
        this.articleData = data.article || data;
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('article', seq, gen)) return;
        this.articleError = err.message || 'Failed to load article';
      } finally {
        if (!isStaleRequest('article', seq, gen)) {
          this.articleLoading = false;
        }
      }
    },

    async generateAiBrief(clusterId, { mode = 'brief', agentId = null, perspective = null, force = false } = {}) {
      if (!clusterId) return;
      const { controller, seq, gen } = nextChannelRequest('aiBrief');
      this.aiBriefLoading = true;
      this.aiBriefError = null;
      try {
        const data = await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/ai-brief`, {
          method: 'POST',
          body: JSON.stringify({
            mode,
            agentId: agentId || this.prefs.preferredAgentId || undefined,
            perspective: perspective || this.prefs.defaultPerspective || 'balanced',
            force: Boolean(force),
          }),
          signal: controller.signal,
        });
        if (isStaleRequest('aiBrief', seq, gen)) return;
        this.aiBriefData = data.brief || data;
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('aiBrief', seq, gen)) return;
        this.aiBriefError = err.message || 'Failed to generate AI brief';
      } finally {
        if (!isStaleRequest('aiBrief', seq, gen)) {
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
        const data = await apiJson('/api/cosmic-web/daily-briefing', {
          method: 'POST',
          body: JSON.stringify({
            agentId: agentId || this.prefs.preferredAgentId || undefined,
            perspective: perspective || this.prefs.defaultPerspective || 'balanced',
            force: Boolean(force),
          }),
          signal: controller.signal,
        });
        if (isStaleRequest('dailyBriefing', seq, gen)) return;
        this.dailyBriefingData = data.briefing || data;
      } catch (err) {
        if (isAbortError(err) || isStaleRequest('dailyBriefing', seq, gen)) return;
        this.dailyBriefingError = err.message || 'Failed to generate daily briefing';
      } finally {
        if (!isStaleRequest('dailyBriefing', seq, gen)) {
          this.dailyBriefingLoading = false;
        }
      }
    },

    closeDailyBriefing() {
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
      const existing = this.feedItems.find((it) => it.id === clusterId) || this.activeClusterDetail;
      const prev = Boolean(existing?.isBookmarked ?? existing?.bookmarked);
      const nextVal = !prev;
      this._patchClusterLocal(clusterId, { isBookmarked: nextVal, bookmarked: nextVal });
      this.stats.bookmarkedCount = Math.max(0, Number(this.stats.bookmarkedCount || 0) + (nextVal ? 1 : -1));
      try {
        await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/state`, {
          method: 'PATCH',
          body: JSON.stringify({ bookmarked: nextVal }),
        });
      } catch {
        // Revert on failure
        this._patchClusterLocal(clusterId, { isBookmarked: prev, bookmarked: prev });
        this.stats.bookmarkedCount = Math.max(0, Number(this.stats.bookmarkedCount || 0) + (prev ? 1 : -1));
      }
    },

    async markRead(clusterId, read = true) {
      if (!clusterId) return;
      const existing = this.feedItems.find((it) => it.id === clusterId) || this.activeClusterDetail;
      const wasRead = Boolean(existing?.isRead ?? (existing?.unread === false));
      if (wasRead === Boolean(read)) return;
      this._patchClusterLocal(clusterId, { isRead: Boolean(read), unread: !read });
      this.stats.unreadCount = Math.max(0, Number(this.stats.unreadCount || 0) + (read ? -1 : 1));
      try {
        await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/state`, {
          method: 'PATCH',
          body: JSON.stringify({ read: Boolean(read) }),
        });
      } catch {
        // Revert on failure
        this._patchClusterLocal(clusterId, { isRead: wasRead, unread: !wasRead });
        this.stats.unreadCount = Math.max(0, Number(this.stats.unreadCount || 0) + (wasRead ? -1 : 1));
      }
    },

    async muteCluster(clusterId) {
      if (!clusterId) return;
      const prevItems = this.feedItems.slice();
      this.feedItems = this.feedItems.filter((it) => it && it.id !== clusterId);
      if (this.selectedClusterId === clusterId) {
        this.closeClusterReader();
        this.selectedClusterId = null;
      }
      try {
        await apiJson(`/api/cosmic-web/clusters/${encodeURIComponent(clusterId)}/state`, {
          method: 'PATCH',
          body: JSON.stringify({ muted: true }),
        });
      } catch {
        this.feedItems = prevItems;
      }
    },

    async markAllRead(domainId = null) {
      const targetDomain = domainId && !['all', 'watch', 'bookmarked', 'unread'].includes(domainId)
        ? domainId
        : null;
      const prevItems = this.feedItems.slice();
      this.feedItems = this.feedItems.map((it) => {
        if (!it) return it;
        if (!targetDomain || it.domainId === targetDomain || (Array.isArray(it.domainIds) && it.domainIds.includes(targetDomain))) {
          return { ...it, isRead: true, unread: false };
        }
        return it;
      });
      try {
        const data = await apiJson('/api/cosmic-web/mark-all-read', {
          method: 'POST',
          body: JSON.stringify({ domainId: targetDomain }),
        });
        if (data.stats) this.stats = { ...this.stats, ...data.stats };
        else if (!targetDomain) this.stats.unreadCount = 0;
        if (Array.isArray(data.domains)) this.domains = data.domains;
      } catch {
        this.feedItems = prevItems;
      }
    },

    async savePreferences(nextPrefs) {
      const merged = normalizePrefs({ ...this.prefs, ...nextPrefs });
      const data = await apiJson('/api/cosmic-web/preferences', {
        method: 'PUT',
        body: JSON.stringify(merged),
      });
      this.prefs = normalizePrefs(data.prefs || data.preferences || merged);
      if (Array.isArray(data.domains)) this.domains = data.domains;
      if (data.graph) this.graph = data.graph;
      if (data.stats) this.stats = { ...this.stats, ...data.stats };
      this.emitPulse({ count: 16 });
      await Promise.all([
        data.graph ? Promise.resolve() : this.fetchGraph(),
        this.fetchFeed({ reset: true }),
      ]);
      return this.prefs;
    },

    async completeOnboarding({ enabledDomains, watchKeywords = [], customDomains = [] } = {}) {
      const next = {
        ...this.prefs,
        onboarded: true,
        enabledDomains: Array.isArray(enabledDomains) && enabledDomains.length > 0
          ? enabledDomains
          : this.prefs.enabledDomains,
        watchKeywords: Array.isArray(watchKeywords) ? watchKeywords : this.prefs.watchKeywords,
        customDomains: Array.isArray(customDomains) ? customDomains : this.prefs.customDomains,
      };
      await this.savePreferences(next);
      await this.refreshNow({ force: false });
    },

    async handleExternalUpdate(msg) {
      const domainId = msg?.domainId || null;
      const clusterId = msg?.clusterId || null;
      this.emitPulse({ domainId, clusterId, count: 10 });
      if (!this.bootstrapped) return;
      await Promise.allSettled([
        this.fetchGraph(),
        this.fetchFeed({ reset: true }),
      ]);
    },

    onLeaveWebBand() {
      abortAllChannels();
      this.hoveredClusterId = null;
      this.readerOpen = false;
      this.readerExpanded = false;
      this.dailyBriefingOpen = false;
      this.prefsModalOpen = false;
    },

    reset() {
      storeGeneration += 1;
      abortAllChannels();
      channelSeq.clear();
      this.$reset();
    },
  },
});

if (typeof Pinia !== 'undefined') {
  Pinia.useCosmicWebStore = useCosmicWebStore;
}
