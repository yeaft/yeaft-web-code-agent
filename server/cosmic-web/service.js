import { createHash, randomUUID } from 'node:crypto';
import { CONFIG } from '../config.js';
import { userDb } from '../db/user-db.js';
import * as db from '../db/cosmic-web-db.js';
import { webClients } from '../context.js';
import { sendToWebClient } from '../ws-utils.js';
import { BUILTIN_DOMAINS, BUILTIN_SOURCES } from './catalog.js';
import { fetchSource } from './sources.js';
import { safeFetch, validateExternalUrl } from './safe-fetch.js';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanText, normalizeMedia, parseTimestamp } from './rss-parser.js';
import { extractCommunityEnrichment, verifyStoredCommunityMedia } from './community-extractor.js';
import { toProxyMediaUrl } from './media-proxy.js';
import { ARTICLE_EXTRACTOR_VERSION, extractCleanArticle } from './article-extractor.js';
import { buildGraphProjection, canonicalizeUrl, CLUSTER_THRESHOLD, CLUSTER_WINDOW_MS, clusterSimilarity, computeHeatScore, extractTokens } from './clusterer.js';
import { clearAllCosmicWebAiRequests, listCapableAgentsForUser, requestCosmicWebAi, validateCosmicWebAiResult } from './ai-bridge.js';

const minute = 60_000;
const refreshTtl = 5 * minute;
const defaultDomains = BUILTIN_DOMAINS.filter(d => d.defaultEnabled).map(d => d.id);
const domainIds = new Set(BUILTIN_DOMAINS.map(d => d.id));
const builtinSourceIds = new Set(BUILTIN_SOURCES.map(s => s.id));
const colors = new Set(BUILTIN_DOMAINS.map(d => d.colorToken));
const error = (status, message) => Object.assign(new Error(message), { status });
const fail = message => { throw error(400, message); };
const lower = value => value.normalize('NFKC').toLowerCase();
const hash = (...args) => createHash('sha256').update(JSON.stringify(args)).digest('hex');
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const trim = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const defaults = () => ({ enabledDomainIds: [...defaultDomains], customDomains: [], watchKeywords: [], muteKeywords: [],
  disabledSources: [], preferredAgentId: '', defaultPerspective: 'balanced', onboarded: false, autoRefreshMinutes: 15 });
const preferred = userId => {
  const stored = db.loadUserPrefs(userId);
  const prefs = { ...defaults(), ...stored };
  const normalizedCustom = prefs.customDomains.map(d => ({ aiRadar: false, ...d }));
  const persistedIds = db.listPersistedUserDomainIds(userId);
  const activeColliding = normalizedCustom.filter(d => domainIds.has(d.id));
  const activeCollidingIds = new Set(activeColliding.map(d => d.id));
  const retiredColliding = persistedIds.filter(id => domainIds.has(id) && !activeCollidingIds.has(id));
  if (!activeColliding.length && !retiredColliding.length) {
    return { ...prefs, customDomains: normalizedCustom };
  }
  // Idempotent migration: remap any active or retired legacy owner-private domain ID that collides with a built-in domain.
  // Reserve built-ins, active custom IDs, AND all persisted domain IDs in cw_sources/cw_items.
  const usedIds = new Set([
    ...domainIds,
    ...persistedIds,
    ...normalizedCustom.filter(d => !domainIds.has(d.id)).map(d => d.id),
  ]);
  const remaps = [];
  const migratedCustom = normalizedCustom.map(d => {
    if (!domainIds.has(d.id)) return d;
    let candidate = `custom-${d.id}`;
    for (let n = 2; usedIds.has(candidate); n++) candidate = `custom-${d.id}-${n}`;
    usedIds.add(candidate);
    remaps.push([d.id, candidate]);
    return { ...d, id: candidate };
  });
  for (const oldId of retiredColliding) {
    let candidate = `retired-${oldId}`;
    for (let n = 2; usedIds.has(candidate); n++) candidate = `retired-${oldId}-${n}`;
    usedIds.add(candidate);
    remaps.push([oldId, candidate]);
  }
  const remappedDisabled = new Set(Array.isArray(prefs.disabledSources) ? prefs.disabledSources : []);
  if (remaps.length) {
    db.cosmicWebTransaction(() => {
      for (const [oldId, newId] of remaps) {
        const existingSources = db.listSourcesForUserDomain(userId, oldId);
        for (const row of existingSources) {
          const newSourceId = row.kind === 'radar'
            ? `radar-${hash(userId, newId)}`
            : `rss-${hash(userId, newId, row.url)}`;
          db.remapUserSource({ userId, oldSourceId: row.id, newSourceId, newDomainId: newId });
          if (remappedDisabled.has(row.id)) {
            remappedDisabled.delete(row.id);
            remappedDisabled.add(newSourceId);
          }
        }
        if (remappedDisabled.has(radarId(oldId))) {
          remappedDisabled.delete(radarId(oldId));
          remappedDisabled.add(radarId(newId));
        }
        // Catch any remaining items/sources referencing oldId directly
        db.migrateCustomDomainId(userId, oldId, newId);
      }
      if (stored || activeColliding.length) {
        const persistedPrefs = { ...prefs, customDomains: migratedCustom, disabledSources: [...remappedDisabled] };
        db.saveUserPrefs(userId, persistedPrefs, Date.now());
      }
    });
    return { ...prefs, customDomains: migratedCustom, disabledSources: [...remappedDisabled] };
  }
  return { ...prefs, customDomains: migratedCustom, disabledSources: [...remappedDisabled] };
};
const publicPrefs = ({ enabledDomainIds, ...prefs }) => ({ ...prefs, enabledDomains: enabledDomainIds });
const radarId = domainId => `radar-${domainId}`;
const publicSourceId = row => row.kind === 'radar' ? radarId(row.domain_id) : row.id;
const itemSourceId = row => row.source_kind === 'radar' ? radarId(row.domain_id) : row.source_id;
const sourceFromRow = row => ({ id: publicSourceId(row), ownerUserId: row.owner_user_id, domainId: row.domain_id, name: row.name,
  url: row.url, kind: row.kind, lastAttemptAt: row.last_attempt_at });

function matches(words, fields) { return words.some(word => fields.some(text => lower(text).includes(lower(word)))); }
function enabledIds(prefs) {
  return new Set([...prefs.enabledDomainIds, ...prefs.customDomains.filter(d => d.enabled).map(d => d.id)]);
}
function toItem(row) {
  return { id: row.id, sourceId: itemSourceId(row), domainId: row.domain_id, sourceName: row.source_name,
    url: row.url, title: row.title, summaryExcerpt: row.summary_excerpt, publishedAt: row.published_at, media: JSON.parse(row.media_json) };
}

export function ingestCosmicWebItems(source, items, now = Date.now()) {
  const ownerUserId = source.ownerUserId ?? null;
  return db.cosmicWebTransaction(() => {
    db.upsertSource({ ...source, ownerUserId });
    const dated = items.filter(i => i.publishedAt >= now - db.RETENTION_MS).sort((a, b) => a.publishedAt - b.publishedAt);
    if (!dated.length) return 0;
    const recent = db.listRecentClusters(ownerUserId, Math.max(now - CLUSTER_WINDOW_MS, dated[0].publishedAt - CLUSTER_WINDOW_MS))
      .map(c => ({ id: c.id, publishedAt: c.published_at, keywords: JSON.parse(c.keywords_json) }));
    let added = 0;
    for (const i of dated) {
      if (db.findItemBySourceUrl(source.id, ownerUserId, i.url)) {
        if (Array.isArray(i.media) && i.media.length) {
          db.backfillItemMedia(source.id, ownerUserId, i.url, i.media);
        }
        continue;
      }
      const keywords = extractTokens(i.title);
      const withinWindow = i.publishedAt >= now - CLUSTER_WINDOW_MS;
      const prior = withinWindow && db.findRecentClusterByUrl(ownerUserId, i.url, now - CLUSTER_WINDOW_MS, now);
      let best = prior && { id: prior.id, publishedAt: prior.published_at };
      if (withinWindow && !best) {
        let score = CLUSTER_THRESHOLD;
        for (const candidate of recent) {
          if (candidate.publishedAt < now - CLUSTER_WINDOW_MS) continue;
          const similarity = clusterSimilarity(keywords, candidate.keywords);
          if (similarity >= score && (!best || similarity > score)) { best = candidate; score = similarity; }
        }
      }
      const id = best?.id ?? randomUUID();
      const cluster = { id, ownerUserId, headline: i.title, summaryExcerpt: i.summaryExcerpt ?? '', keywords, publishedAt: i.publishedAt };
      db.upsertCluster(cluster);
      const candidate = best && recent.find(c => c.id === best.id);
      if (candidate) candidate.publishedAt = Math.max(candidate.publishedAt, i.publishedAt);
      else if (withinWindow) recent.push({ id, keywords, publishedAt: i.publishedAt });
      added += db.insertItem({ ...i, summaryExcerpt: i.summaryExcerpt ?? '', id: randomUUID(), ownerUserId, clusterId: id,
        domainId: source.domainId, sourceId: source.id });
    }
    return added;
  });
}

function listClusters(userId, prefs, now, id) {
  const rows = db.listVisibleClusters(userId, id);
  const states = db.listUserClusterStates(userId);
  const grouped = new Map(rows.map(r => [r.id, []]));
  for (const row of db.listVisibleItems(userId, [...grouped.keys()])) grouped.get(row.cluster_id).push(row);
  const enabled = enabledIds(prefs);
  return rows.flatMap(row => {
    const articles = grouped.get(row.id).filter(item => !prefs.disabledSources.includes(itemSourceId(item)));
    if (!articles.length) return [];
    const isPrivateSource = articles.some(a => a.owner_user_id !== null);
    // Strip untrusted private RSS media URLs from item projections and downstream Agent payloads.
    const items = articles.map(articleRow => (isPrivateSource || articleRow.owner_user_id !== null)
      ? { ...toItem(articleRow), media: [] }
      : toItem(articleRow));
    const keywords = JSON.parse(row.keywords_json);
    const fields = [row.headline, row.summary_excerpt, ...items.map(i => i.title), ...keywords];
    // Owner-private rows belong only to custom domains; never project them into built-in domains.
    const actual = [...new Set(items
      .filter((i, idx) => articles[idx].owner_user_id === null || !domainIds.has(i.domainId))
      .map(i => i.domainId))];
    const custom = prefs.customDomains.filter(d => d.enabled && d.keywords.length && matches(d.keywords, fields)).map(d => d.id);
    const allDomains = [...new Set([...actual, ...custom])];
    if (!allDomains.length) return [];
    const domainId = allDomains.find(d => enabled.has(d)) ?? actual[0] ?? allDomains[0];
    const sourceNames = [...new Set(items.map(i => i.sourceName))];
    const state = states.get(row.id) ?? { unread: true, bookmarked: false };
    const domain = [...BUILTIN_DOMAINS, ...prefs.customDomains].find(d => d.id === domainId);
    return [{ id: row.id, clusterId: row.id, headline: row.headline, summaryExcerpt: row.summary_excerpt,
      primaryUrl: items[0]?.url || '', isPrivateSource,
      keywords, publishedAt: row.published_at, domainId, domainIds: allDomains, relatedDomains: allDomains.filter(d => d !== domainId),
      colorToken: domain?.colorToken ?? 'cyan', itemCount: items.length, items, sourceNames, ...state,
      isRead: !state.unread, isBookmarked: Boolean(state.bookmarked),
      watchHit: matches(prefs.watchKeywords, fields), muted: state.muted || matches(prefs.muteKeywords, fields),
      heatScore: computeHeatScore({ itemCount: sourceNames.length, publishedAt: row.published_at, now,
        hasHotMetric: articles.some(i => i.has_hot_metric) }) }];
  });
}

function keywords(value, label) {
  if (!Array.isArray(value) || value.length > 50 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) fail(`Invalid ${label}`);
  return [...new Set(value.map(v => v.trim()))];
}

export function createCosmicWebService({ fetcher = safeFetch, dnsLookup, now = Date.now, notify = true,
  autoRefresh = () => process.env.NODE_ENV !== 'test' && process.env.COSMIC_WEB_DISABLE_SCHEDULER !== '1',
  isUserActive = id => (CONFIG.skipAuth && id === 'dev-user') || userDb.isActive(id),
  requestAi = requestCosmicWebAi } = {}) {
  const inflight = new Map(), cooling = new Map(), articleInflight = new Map(), aiInflight = new Map();
  const radarCooling = new Map(), radarActive = new Set(), enrichmentInflight = new Map();
  let controller = new AbortController(), timer, initialTimer, schedulerRun;
  let stopping = false;
  const ensureRunning = (signal = controller.signal) => {
    if (stopping || signal.aborted) throw error(503, 'Cosmic Web is stopping');
  };
  const ensureActive = userId => {
    if (!isUserActive(userId)) throw error(403, 'User is no longer active');
  };
  const sourceIsActive = source => !source.ownerUserId || isUserActive(source.ownerUserId);
  // Keep outbound concurrency bounded even when several users refresh at once.
  const queue = [];
  let running = 0;
  function pump() {
    while (running < 6 && queue.length) {
      const next = queue.shift();
      running++;
      Promise.resolve().then(next.run).then(next.resolve, next.reject).finally(() => { running--; pump(); });
    }
  }
  function limit(run) {
    return new Promise((resolve, reject) => { queue.push({ run, resolve, reject }); pump(); });
  }

  function seed() {
    db.cosmicWebTransaction(() => { for (const source of BUILTIN_SOURCES) db.upsertSource(source); });
  }
  function sourcesFor(userId, prefs, domain) {
    const enabled = enabledIds(prefs);
    return [...db.listSources(), ...db.listSources(userId)].filter(s => enabled.has(s.domain_id) && (!domain || s.domain_id === domain) && !prefs.disabledSources.includes(publicSourceId(s)));
  }
  function sourcesVisibleToClient(userId, source) {
    const prefs = preferred(userId);
    return enabledIds(prefs).has(source.domainId) && !prefs.disabledSources.includes(source.id);
  }
  function update(source, signal) {
    if (!notify || signal.aborted) return;
    for (const client of webClients.values()) {
      if (!client.authenticated || !client.userId) continue;
      if (source.ownerUserId !== null ? client.userId !== source.ownerUserId : !sourcesVisibleToClient(client.userId, source)) continue;
      void sendToWebClient(client, { type: 'cosmic_web_updated', domainId: source.domainId, updatedAt: now() }).catch(() => {});
    }
  }
  function refreshSource(row, force) {
    if (row.kind === 'radar') return Promise.resolve({ skipped: true });
    const s = sourceFromRow(row);
    if (inflight.has(s.id)) return inflight.get(s.id);
    if (!force && s.lastAttemptAt != null && now() - s.lastAttemptAt < refreshTtl) return Promise.resolve({ skipped: true });
    const { signal } = controller;
    const task = limit(async () => {
      const canWrite = () => !signal.aborted && sourceIsActive(s) && db.getSource(s.id, s.ownerUserId);
      if (!canWrite()) return { skipped: true };
      let items;
      try {
        items = await fetchSource(s, {
          fetcher, dnsLookup, signal, now: now(),
          // Redact URLs in owner-private RSS excerpts BEFORE clipping to 1,000 chars with a bounded CPU budget (fail-closed).
          sanitizeExcerpt: s.ownerUserId != null ? (raw => stripPrivateUrls(raw, { maxOutputChars: 1000 })) : undefined,
        });
      }
      catch {
        if (!canWrite()) return { skipped: true };
        db.recordSourceRefresh(s.id, s.ownerUserId, now(), 'source_unavailable');
        return { failed: true };
      }
      if (!canWrite()) return { skipped: true };
      const added = ingestCosmicWebItems(s, items, now());
      db.recordSourceRefresh(s.id, s.ownerUserId, now());
      if (added) update(s, signal);
      return { added };
    }).finally(() => { if (inflight.get(s.id) === task) inflight.delete(s.id); });
    inflight.set(s.id, task);
    return task;
  }
  function refreshRows(rows, force = false) { return Promise.all(rows.map(row => refreshSource(row, force))); }
  function swr(userId, prefs) {
    if (stopping || !autoRefresh() || !isUserActive(userId)) return;
    try { seed(); void refreshRows(sourcesFor(userId, prefs)).catch(err => { if (err.status !== 503) console.error('[CosmicWeb] Refresh failed:', err.message); }); }
    catch (err) { console.error('[CosmicWeb] Refresh failed:', err.message); }
  }
  function visibleCluster(userId, id) {
    const value = listClusters(userId, preferred(userId), now(), id)[0];
    if (!value) throw error(404, 'Cluster not found');
    return value;
  }
  const noEnrichment = () => ({ media: [], communityComments: [] });
  const enrichmentSignature = c => hash(c.items.map(item => item.id));
  function cachedEnrichment(c, signature = enrichmentSignature(c)) {
    const cached = db.getEnrichmentCache(c.id, now());
    return cached?.signature === signature ? cached.value : null;
  }
  function enrichment(c, signal) {
    const signature = enrichmentSignature(c);
    const cached = cachedEnrichment(c, signature);
    if (cached) return Promise.resolve(cached);
    const key = hash(c.id, signature);
    if (enrichmentInflight.has(key)) return enrichmentInflight.get(key);
    // Prevent a burst of cluster requests from monopolizing the outbound queue.
    if (enrichmentInflight.size >= 6) return Promise.resolve(noEnrichment());
    const task = extractCommunityEnrichment(c.items, { fetcher: (url, options) => limit(() => fetcher(url, options)), dnsLookup, signal })
      .then(value => {
        if (!signal.aborted) {
          db.setEnrichmentCache(c.id, { signature, value }, now() + 120 * minute);
        }
        return value;
      }).catch(() => noEnrichment()).finally(() => {
        if (enrichmentInflight.get(key) === task) enrichmentInflight.delete(key);
      });
    enrichmentInflight.set(key, task);
    return task;
  }
  function signMediaList(list, userId) {
    if (!Array.isArray(list) || !list.length) return [];
    const ts = now();
    return list
      .map(m => {
        const rawUrl = typeof m === 'string' ? m : m?.url;
        const proxyUrl = toProxyMediaUrl(rawUrl, userId, ts);
        if (!proxyUrl) return null;
        return typeof m === 'string'
          ? { url: rawUrl, kind: /\.gif$/i.test(rawUrl) ? 'gif' : 'image', proxyUrl }
          : { ...m, proxyUrl };
      })
      .filter(Boolean);
  }
  function combineSignals(reqSignal) {
    if (!reqSignal) return controller.signal;
    return AbortSignal.any([controller.signal, reqSignal]);
  }
  function storedClusterMedia(c, userId) {
    // Never proxy untrusted media URLs from user-configured private RSS feeds.
    if (c.isPrivateSource) return [];
    const raw = [];
    const seen = new Set();
    for (const item of c.items ?? []) {
      for (const m of item.media ?? []) {
        const u = typeof m === 'string' ? m : m?.url;
        if (!u || seen.has(u)) continue;
        seen.add(u);
        raw.push({
          url: u,
          kind: m?.kind === 'gif' || /\.gif$/i.test(u) ? 'gif' : 'image',
          ...(m?.caption ? { caption: m.caption } : {}),
          sourceName: m?.sourceName || item.sourceName,
        });
      }
    }
    return signMediaList(raw.slice(0, 8), userId);
  }
  async function cluster(userId, id) {
    const { signal } = controller;
    ensureRunning(signal);
    ensureActive(userId);
    const c = visibleCluster(userId, id);
    const cached = cachedEnrichment(c);
    // Warm community enrichment asynchronously so opening a story never blocks on remote HTTP.
    if (!cached && !c.isPrivateSource) void enrichment(c, signal).catch(() => {});
    const media = cached?.media?.length ? signMediaList(cached.media, userId) : storedClusterMedia(c, userId);
    return { ...c, media, communityComments: cached?.communityComments ?? [] };
  }
  async function clusterCommunity(userId, id, reqSignal) {
    const signal = combineSignals(reqSignal);
    ensureRunning(signal);
    ensureActive(userId);
    const c = visibleCluster(userId, id);
    if (c.isPrivateSource) return { media: storedClusterMedia(c, userId), communityComments: [] };
    const value = await enrichment(c, signal);
    ensureRunning(signal);
    ensureActive(userId);
    const current = visibleCluster(userId, id);
    const valid = enrichmentSignature(c) === enrichmentSignature(current) ? value : noEnrichment();
    const media = valid.media?.length ? signMediaList(valid.media, userId) : storedClusterMedia(current, userId);
    return { media, communityComments: valid.communityComments ?? [] };
  }
  async function quick(task, fallback) {
    const timer = new AbortController();
    try { return await Promise.race([task.catch(() => fallback), delay(350, fallback, { signal: timer.signal })]); }
    finally { timer.abort(); }
  }

  async function briefingEnrichment(c, signal, skipArticleFetch = false) {
    const cached = cachedEnrichment(c);
    if (cached) return cached;
    const fallback = noEnrichment();
    if (!skipArticleFetch) {
      const complete = await quick(enrichment(c, signal), null);
      if (complete) return complete;
    }
    if (!c.items.some(item => item.media.length)) return fallback;
    const verificationSignal = AbortSignal.any([signal, AbortSignal.timeout(150)]);
    return { ...fallback, media: await verifyStoredCommunityMedia(c.items, { dnsLookup, signal: verificationSignal }) };
  }

  function filtered(userId, query = {}, background = true) {
    query ??= {};
    const prefs = preferred(userId);
    if (background) swr(userId, prefs);
    const enabled = enabledIds(prefs);
    const text = trim(query.q, 200);
    const domain = trim(query.domainId ?? query.domain, 80);
    const truthy = v => v === true || v === 'true' || v === '1';
    const bookmarked = truthy(query.bookmarked) || query.filter === 'bookmarked';
    const unread = truthy(query.unread) || query.filter === 'unread';
    const watching = truthy(query.watch) || query.filter === 'watch';
    return listClusters(userId, prefs, now()).filter(c => {
      const ids = [c.domainId, ...c.relatedDomains];
      return (bookmarked || (ids.some(d => enabled.has(d)) && !c.muted)) &&
        (!domain || (ids.includes(domain) && enabled.has(domain))) && (!bookmarked || c.bookmarked) &&
        (!unread || c.unread) && (!watching || c.watchHit) && (!text || matches([text], [c.headline, c.summaryExcerpt,
          JSON.stringify(c.keywords), ...c.items.map(i => i.title)]));
    }).sort((a, b) => (query.sort === 'latest' ? 0 : b.heatScore - a.heatScore) || b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
  }
  const summary = ({ items, ...rest }) => rest;

  // Selection must be an exact match to a scoped, stored cluster item.
  function selectItem(cluster, { itemId, url }) {
    const item = itemId != null ? cluster.items.find(i => i.id === itemId) :
      url != null ? cluster.items.find(i => i.url === url) : cluster.items[0];
    if (!item) throw error(404, 'Article not found');
    return item;
  }

  async function articleRecord(userId, id, options = {}) {
    const { signal } = controller;
    ensureRunning(signal);
    ensureActive(userId);
    const selection = typeof options === 'string' ? { itemId: options } : options;
    const item = selectItem(visibleCluster(userId, id), selection);
    const { force, preserveCacheOnBlocked } = selection;
    const cached = db.getArticleCache(userId, item.id, now());
    if (cached && force !== true && force !== '1') return { item, result: cached };
    let task = articleInflight.get(item.id);
    if (!task) {
      task = limit(async () => {
        ensureRunning(signal);
        let value = extractCleanArticle(null, item.url, item.title);
        if (value.quality !== 'search_only') {
          try {
            const res = await fetcher(item.url, { dnsLookup, signal });
            if (res.status >= 200 && res.status < 300) value = extractCleanArticle(await res.text(), res.url ?? item.url, item.title);
          } catch { /* Use the blocked fallback and a short negative cache. */ }
        }
        ensureRunning(signal);
        return { ...value, itemId: item.id, clusterId: id, summaryExcerpt: item.summaryExcerpt };
      }).finally(() => { if (articleInflight.get(item.id) === task) articleInflight.delete(item.id); });
      articleInflight.set(item.id, task);
    }
    const result = await task;
    ensureRunning(signal);
    ensureActive(userId);
    // Keep a working legacy display cache row intact if a background provenance upgrade hits a transient origin failure.
    if (!preserveCacheOnBlocked || result.quality !== 'blocked' || !cached || cached.quality === 'blocked') {
      db.setArticleCache(userId, item.id, result, now() + (result.quality === 'blocked' ? minute : 24 * 60 * minute));
    }
    return { item, result };
  }
  async function article(userId, id, options = {}) {
    const { item, result } = await articleRecord(userId, id, options);
    const { aiMarkdown: _omitAiMarkdown, ...display } = result;
    return { ...display, sourceUrl: item.url, contentMd: result.markdown };
  }

  function briefingOptions(userId, userRole, body, prefs = preferred(userId), mode = 'brief') {
    if (!object(body)) fail('Invalid briefing options');
    const perspective = body.perspective ?? prefs.defaultPerspective;
    if (!['balanced', 'engineering', 'product', 'investing'].includes(perspective)) fail('Invalid briefing perspective');
    const language = body.language === 'en' ? 'en' : 'zh-CN';
    const available = listCapableAgentsForUser(userId, userRole, mode);
    const explicitAgentId = body.agentId === '' ? null : body.agentId ?? null;
    const agent = explicitAgentId === null ? available.find(a => a.id === prefs.preferredAgentId) ?? available[0] :
      available.find(a => a.id === explicitAgentId);
    if (explicitAgentId !== null && !agent) {
      const legacy = mode !== 'brief' ? listCapableAgentsForUser(userId, userRole, 'brief').find(a => a.id === explicitAgentId) : null;
      if (legacy) throw error(409, 'Selected Agent requires an update to support this Cosmic Web feature');
      throw error(403, 'Agent is not available to this user');
    }
    if (!agent && (mode === 'follow_up' || mode === 'topic_radar')) {
      const legacyAny = listCapableAgentsForUser(userId, userRole, 'brief');
      if (legacyAny.length) throw error(409, 'Online Agents require an update to support this Cosmic Web feature');
    }
    return { perspective, language, explicitAgentId, agent };
  }

  async function ai(userId, userRole, mode, body, payload, signal, options) {
    ensureRunning(signal);
    ensureActive(userId);
    const { perspective, language, explicitAgentId, agent } = options;
    // Version the rendering contract too: old cached Markdown may contain autolinks.
    const key = hash(5, mode, perspective, language, explicitAgentId, payload);
    const cached = db.getAiCache(userId, key, now());
    if (cached && body.force !== true) {
      const media = Array.isArray(cached.media) ? signMediaList(cached.media, userId) : cached.media;
      return { ...cached, ...(media ? { media } : {}), cached: true };
    }
    if (!agent) throw error(503, 'No capable Agent is online');
    const agentId = agent.id;
    const scope = hash(userId, key, agentId);
    let shared = aiInflight.get(scope);
    if (!shared) {
      const taskController = new AbortController();
      const onShutdown = () => taskController.abort();
      controller.signal.addEventListener('abort', onShutdown, { once: true });
      const waiters = new Set();
      const promise = Promise.resolve(requestAi({ userId, userRole, agentId, mode, perspective, language, payload, signal: taskController.signal })).then(result => {
        ensureRunning(taskController.signal);
        ensureActive(userId);
        if (!validateCosmicWebAiResult(result, mode)) throw error(502, 'Agent returned an invalid briefing');
        const enriched = { ...result, agentId, agentName: agent.name, perspective, generatedAt: now() };
        if (mode === 'brief' || mode === 'synthesize' || mode === 'follow_up') {
          const rawMedia = payload.isPrivateSource ? [] : (result.media?.length ? result.media : payload.media ?? []);
          enriched.media = signMediaList(rawMedia, userId);
          if (mode !== 'follow_up') enriched.communityHighlights = result.communityHighlights?.length ? result.communityHighlights : payload.communityComments ?? [];
        }
        db.setAiCache(userId, key, enriched, now() + 6 * 60 * minute);
        return { ...enriched, cached: false };
      }).finally(() => {
        controller.signal.removeEventListener('abort', onShutdown);
        if (aiInflight.get(scope) === shared) aiInflight.delete(scope);
      });
      shared = { promise, taskController, waiters };
      aiInflight.set(scope, shared);
    }
    // Refcount active callers so a shared task cancels only when the final caller leaves.
    return new Promise((resolve, reject) => {
      const token = {};
      const onCallerAbort = () => {
        shared.waiters.delete(token);
        const isShutdown = stopping || controller.signal.aborted;
        const abortErr = isShutdown ? error(503, 'Cosmic Web is stopping') : error(499, 'Cosmic Web request cancelled');
        if (shared.waiters.size === 0) shared.taskController.abort(abortErr);
        reject(abortErr);
      };
      if (signal.aborted) {
        onCallerAbort();
        return;
      }
      shared.waiters.add(token);
      signal.addEventListener('abort', onCallerAbort, { once: true });
      shared.promise.then(
        val => {
          signal.removeEventListener('abort', onCallerAbort);
          shared.waiters.delete(token);
          if (!signal.aborted) resolve(val);
        },
        err => {
          signal.removeEventListener('abort', onCallerAbort);
          shared.waiters.delete(token);
          if (!signal.aborted) reject(err);
        },
      );
    });
  }
  /** Bounded linear-time Markdown link/image/URL stripper for private briefings (keeps Clean Article cache intact). */
  function dropTrailingToken(str) {
    let end = str.length;
    while (end > 0 && !/\s/.test(str[end - 1])) end--;
    return end === str.length ? str : str.slice(0, end);
  }
  function stripBracketedLinks(text, imagesOnly, maxSteps = 200_000) {
    if (imagesOnly ? !text.includes('![') : !text.includes('](')) return text;
    let out = '';
    let i = 0;
    let steps = 0;
    const len = text.length;
    let nextClose = text.indexOf(']');
    while (i < len) {
      if (++steps > maxSteps) return dropTrailingToken(out); // Fail closed: discard unprocessed tail & partial token on budget exhaustion.
      const matchOpen = imagesOnly ? (text[i] === '!' && text[i + 1] === '[') : (text[i] === '[');
      if (matchOpen && nextClose !== -1) {
        const labelStart = imagesOnly ? i + 2 : i + 1;
        while (nextClose !== -1 && nextClose < labelStart) nextClose = text.indexOf(']', nextClose + 1);
        if (nextClose !== -1 && nextClose - labelStart <= 512 && text[nextClose + 1] === '(') {
          let j = nextClose + 2;
          const limit = Math.min(len, nextClose + 2 + 2048);
          while (j < limit && (text[j] === ' ' || text[j] === '\t')) { j++; steps++; }
          let matchedClose = false;
          if (j < limit && text[j] === '<') {
            // Angle-delimited destination (<...>) emitted by extractCleanArticle: scan as a single unit ignoring ')' inside <...>.
            j++;
            while (j < limit && text[j] !== '>' && text[j] !== '\n') {
              if (++steps > maxSteps) return dropTrailingToken(out);
              if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
              j++;
            }
            if (j < limit && text[j] === '>') {
              j++;
              while (j < limit && text[j] !== ')' && text[j] !== '\n') {
                if (++steps > maxSteps) return dropTrailingToken(out);
                if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
                if (text[j] === '"' || text[j] === "'") {
                  const q = text[j++];
                  while (j < limit && text[j] !== q && text[j] !== '\n') {
                    if (++steps > maxSteps) return dropTrailingToken(out);
                    if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
                    j++;
                  }
                  if (j < limit && text[j] === q) j++;
                  continue;
                }
                j++;
              }
              if (j < limit && text[j] === ')') {
                j++;
                matchedClose = true;
              }
            }
          } else {
            let depth = 1;
            while (j < limit && depth > 0) {
              if (++steps > maxSteps) return dropTrailingToken(out);
              if (text[j] === '\\' && j + 1 < limit) { j += 2; continue; }
              if (text[j] === '(') depth++;
              else if (text[j] === ')') depth--;
              j++;
            }
            matchedClose = depth === 0;
          }
          if (matchedClose) {
            out += text.slice(labelStart, nextClose);
            i = j;
            continue;
          }
        }
      }
      out += text[i];
      i++;
    }
    return out;
  }
  // Separate Unicode punctuation (\p{P}, sentence/wrapper boundaries) from Unicode symbols (\p{S}, valid WHATWG host chars like ☃ or 🚀).
  const UNICODE_PUNCT_RE = /\p{P}/u;
  const UNICODE_SYMBOL_RE = /\p{S}/u;
  const isWhatwgDot = code => code === 0x002e || code === 0x3002 || code === 0xff0e || code === 0xff61;
  // Percent-encoded WHATWG host dot separators normalized by Node URL parsing: %2e (.), %e3%80%82 (。), %ef%bc%8e (．), %ef%bd%a1 (｡).
  const PERCENT_WHATWG_DOT_RE = /%(?:2e|e3%80%82|ef%bc%8e|ef%bd%a1)/i;
  function percentWhatwgDotLenAt(str, idx) {
    if (str.charCodeAt(idx) !== 0x25) return 0;
    if (idx + 3 <= str.length && str.charCodeAt(idx + 1) === 0x32 && (str.charCodeAt(idx + 2) | 32) === 0x65) return 3;
    if (idx + 9 <= str.length && str.charCodeAt(idx + 3) === 0x25 && str.charCodeAt(idx + 6) === 0x25) {
      const seq = str.slice(idx, idx + 9).toLowerCase();
      if (seq === '%e3%80%82' || seq === '%ef%bc%8e' || seq === '%ef%bd%a1') return 9;
    }
    return 0;
  }
  function whatwgDotLenAt(str, idx) {
    if (idx >= str.length) return 0;
    return isWhatwgDot(str.charCodeAt(idx)) ? 1 : percentWhatwgDotLenAt(str, idx);
  }
  function codePointAtInfo(str, idx) {
    const cp = str.codePointAt(idx);
    const width = cp > 0xffff ? 2 : 1;
    return { cp, width, ch: width === 2 ? str.slice(idx, idx + 2) : str[idx] };
  }
  function prevCodePointInfo(str, endIdx) {
    if (endIdx >= 2) {
      const lo = str.charCodeAt(endIdx - 1);
      const hi = str.charCodeAt(endIdx - 2);
      if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) {
        return { cp: str.codePointAt(endIdx - 2), width: 2, ch: str.slice(endIdx - 2, endIdx) };
      }
    }
    return { cp: str.charCodeAt(endIdx - 1), width: 1, ch: str[endIdx - 1] };
  }
  const isNonAsciiPunct = (cp, ch) => cp > 127 && UNICODE_PUNCT_RE.test(ch);
  const isNonAsciiSymbol = (cp, ch) => cp > 127 && UNICODE_SYMBOL_RE.test(ch);
  const isBareUrlStop = ch => !ch || /[\s<>"]/.test(ch);
  function trimTrailingUrlPunct(str, start, end, openParens, closeParens, openBrackets, closeBrackets) {
    let j = end;
    while (j > start) {
      const { cp, width, ch: last } = prevCodePointInfo(str, j);
      // Consume contiguous trailing backslash runs in a single linear pass (prevents O(N^2) rescanning).
      if (width === 1 && last === '\\') {
        while (j > start && str[j - 1] === '\\') j--;
        continue;
      }
      const isCloseParen = width === 1 && last === ')';
      const isCloseBracket = width === 1 && last === ']';
      // Trim only prose/Markdown punctuation and unmatched wrappers — never strip Unicode symbols (\p{S}) that can end valid hostnames (e.g. www.☃).
      const isTrimmable = (isCloseParen && closeParens > openParens)
        || (isCloseBracket && closeBrackets > openBrackets)
        || (!isCloseParen && !isCloseBracket && (
          last === '\'' || last === '`' || last === '*' || last === '_' || last === '~'
          || last === '}' || last === '|' || last === '>'
          || last === '.' || last === ',' || last === ';' || last === ':' || last === '!' || last === '?' || isNonAsciiPunct(cp, last)
        ));
      if (!isTrimmable) break;
      // Count preceding backslash run once; if >1 backslashes remain, the next iteration consumes them in O(1) amortized.
      let bs = 0;
      for (let b = j - width - 1; b >= start && str[b] === '\\'; b--) bs++;
      const step = (bs & 1) === 1 ? width + 1 : width;
      if (isCloseParen) closeParens--;
      else if (isCloseBracket) closeBrackets--;
      j -= step;
    }
    return j;
  }
  function isValidSchemeRelativeCandidate(rawCandidate, budget) {
    const normalized = rawCandidate.replace(/\\([\\`*_{}\[\]<>#!|~.\-+=])/g, '$1');
    if (normalized.length <= 2) return false;
    const rest = normalized.slice(2);
    if (!/[/?#:@.[\u3002\uff0e\uff61]/.test(rest) && !PERCENT_WHATWG_DOT_RE.test(rest)) return false;
    if (budget) {
      if (budget.urlChecks >= budget.maxUrlChecks) { budget.exhausted = true; return false; }
      budget.urlChecks++;
    }
    return URL.canParse(`https:${normalized}`);
  }
  function isValidBareWwwCandidate(rawCandidate, budget) {
    const normalized = rawCandidate.replace(/\\([\\`*_{}\[\]<>#!|~.\-+=])/g, '$1');
    if (normalized.length <= 4) return false;
    if (budget) {
      if (budget.urlChecks >= budget.maxUrlChecks) { budget.exhausted = true; return false; }
      budget.urlChecks++;
    }
    const parsed = URL.parse(`https://${normalized}`);
    return Boolean(parsed && ((parsed.hostname.startsWith('www.') && parsed.hostname.length > 4) || parsed.username || parsed.password));
  }
  function matchUrlStartAt(str, offset, identBeforeUnderscores = false, budget = null) {
    const len = str.length;
    const prev = offset > 0 ? str.charCodeAt(offset - 1) : 0;
    const prevIsAlnum = (prev >= 48 && prev <= 57) || (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122);
    const prevIsIdent = prevIsAlnum || (prev === 95 && identBeforeUnderscores);

    const c0 = str.charCodeAt(offset);
    if (!prevIsIdent && ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) {
      // 1. Any RFC 3986 scheme:// (http://, https://, ftp://, s3://, etc.) at exact original-string offset.
      let k = offset + 1;
      const maxSchemeEnd = Math.min(len - 3, offset + 24);
      while (k < maxSchemeEnd) {
        const ch = str.charCodeAt(k);
        if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 43 || ch === 45 || ch === 46) {
          k++;
          continue;
        }
        break;
      }
      if (k + 2 < len && str.charCodeAt(k) === 58 && str.charCodeAt(k + 1) === 47 && str.charCodeAt(k + 2) === 47) {
        return { prefixLen: (k + 3) - offset, minEnd: k + 3 };
      }
      // 2. Bare www.<host> URL using WHATWG dot separators (literal or percent-encoded ., 。, ．, ｡) and WHATWG URL host normalization
      // (covers www.☃, www。例子。中国/..., www%2eexample, www.☃[1], www.☃.example:8080。下一句, bracketed/punctuated adjacent prose, reserved structural cuts, and fail-closed limits).
      const wwwDotLen = offset + 3 < len ? whatwgDotLenAt(str, offset + 3) : 0;
      if (wwwDotLen > 0 && offset + 3 + wwwDotLen < len
        && (c0 | 32) === 119
        && (str.charCodeAt(offset + 1) | 32) === 119
        && (str.charCodeAt(offset + 2) | 32) === 119) {
        const wwwPrefixLen = 3 + wwwDotLen;
        let k = offset + wwwPrefixLen;
        const maxScan = Math.min(len, offset + 2048);
        let openParens = 0, closeParens = 0, openBrackets = 0, closeBrackets = 0;
        let inPath = false;
        let inBrackets = false;
        let atHostStart = -1;
        let seenPortColon = false;
        let portEndCut = false;
        let prevWasCut = false;
        let cutsOverflowed = false;
        const structuralCuts = [];
        const authorityCuts = [];
        const pushAuthCut = (bucket, cap, cut, balanced = false) => {
          if (bucket.length > 0 && bucket[bucket.length - 1].cut === cut) return;
          if (bucket.length < cap) {
            bucket.push(balanced
              ? { cut, openParens: 0, closeParens: 0, openBrackets: 0, closeBrackets: 0 }
              : { cut, openParens, closeParens, openBrackets, closeBrackets });
          } else {
            cutsOverflowed = true;
          }
        };
        while (k < maxScan && !isBareUrlStop(str[k])) {
          if (budget && ++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; return null; }
          if (str[k] === '\\' && k + 1 < maxScan && !isBareUrlStop(str[k + 1])) {
            const esc = str[k + 1];
            const isIpv6Open = !inPath && esc === '[' && k === atHostStart;
            const isIpv6Close = !inPath && esc === ']' && inBrackets;
            const isEscWrapDelim = !isIpv6Open && !isIpv6Close && (
              (esc === ']' && closeBrackets >= openBrackets)
              || esc === '[' || esc === '(' || esc === '{' || esc === '}' || esc === '|'
              || esc === '!' || esc === '*' || esc === '_' || esc === '~' || esc === '`' || esc === '^'
            );
            if (!inPath && seenPortColon && !inBrackets && !portEndCut && esc !== '#') {
              portEndCut = true;
              pushAuthCut(structuralCuts, 16, k);
            }
            if (!inPath && isEscWrapDelim && !prevWasCut) pushAuthCut(authorityCuts, 64, k);
            if (esc === '[') { openBrackets++; if (isIpv6Open) inBrackets = true; }
            else if (esc === ']') { closeBrackets++; if (isIpv6Close) { inBrackets = false; pushAuthCut(structuralCuts, 16, k + 2, true); } }
            else if (esc === '(') openParens++;
            else if (esc === ')') closeParens++;
            else if (esc === '#') { inPath = true; inBrackets = false; }
            prevWasCut = isEscWrapDelim;
            k += 2;
            continue;
          }
          const { cp, width, ch } = codePointAtInfo(str, k);
          const isIpv6Open = !inPath && width === 1 && ch === '[' && k === atHostStart;
          const isIpv6Close = !inPath && width === 1 && ch === ']' && inBrackets;
          if (!inPath) {
            if (width === 1 && (ch === '/' || ch === '?' || ch === '#')) {
              inPath = true;
              inBrackets = false;
              prevWasCut = false;
            } else if (width === 1 && ch === '@') {
              atHostStart = k + 1;
              inBrackets = false;
              seenPortColon = false;
              portEndCut = false;
              prevWasCut = false;
            } else if (width === 1 && ch === ':') {
              if (!inBrackets) {
                if (!seenPortColon) seenPortColon = true;
                else if (!portEndCut) {
                  portEndCut = true;
                  pushAuthCut(structuralCuts, 16, k);
                }
              }
              prevWasCut = false;
            } else {
              if (seenPortColon && !inBrackets && !portEndCut && !(width === 1 && cp >= 48 && cp <= 57)) {
                portEndCut = true;
                pushAuthCut(structuralCuts, 16, k);
              }
              const pctDotLen = (!inBrackets && width === 1 && ch === '%') ? percentWhatwgDotLenAt(str, k) : 0;
              if (pctDotLen > 0) {
                prevWasCut = false;
                k += pctDotLen;
                continue;
              }
              const isAuthDelim = !isIpv6Open && !isIpv6Close && (isNonAsciiPunct(cp, ch) || (width === 1 && (
                ch === ',' || ch === ';' || ch === '!' || ch === '(' || ch === ')' || ch === '[' || ch === '{' || ch === '}'
                || ch === '|' || ch === '^' || ch === '%'
                || (ch === ']' && closeBrackets >= openBrackets)
                || ch === '\'' || ch === '`' || ch === '*' || ch === '_' || ch === '~'
              )));
              if (isAuthDelim) {
                if (!prevWasCut) pushAuthCut(authorityCuts, 64, k);
                prevWasCut = true;
              } else {
                prevWasCut = false;
              }
            }
          }
          if (width === 1) {
            if (ch === '(') openParens++;
            else if (ch === ')') closeParens++;
            else if (ch === '[') { openBrackets++; if (isIpv6Open) inBrackets = true; }
            else if (ch === ']') { closeBrackets++; if (isIpv6Close) { inBrackets = false; pushAuthCut(structuralCuts, 16, k + 1, true); } }
          }
          k += width;
        }
        const trimmedEnd = trimTrailingUrlPunct(str, offset + wwwPrefixLen, k, openParens, closeParens, openBrackets, closeBrackets);
        if (isValidBareWwwCandidate(str.slice(offset, trimmedEnd), budget)) return { prefixLen: wwwPrefixLen, minEnd: trimmedEnd };
        if (budget?.exhausted) return null;
        for (let s = structuralCuts.length - 1; s >= 0; s--) {
          const c = structuralCuts[s];
          if (c.cut <= offset + wwwPrefixLen) continue;
          const prefixEnd = trimTrailingUrlPunct(str, offset + wwwPrefixLen, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
          if (isValidBareWwwCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: wwwPrefixLen, minEnd: prefixEnd };
          if (budget?.exhausted) return null;
        }
        for (const c of authorityCuts) {
          const prefixEnd = trimTrailingUrlPunct(str, offset + wwwPrefixLen, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
          if (isValidBareWwwCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: wwwPrefixLen, minEnd: prefixEnd };
          if (budget?.exhausted) return null;
        }
        // Fail closed if an unresolved bare-www authority exceeds lookahead or cut-tracking capacity before terminating.
        if ((k >= maxScan && k < len && !isBareUrlStop(str[k])) || cutsOverflowed) return { prefixLen: wwwPrefixLen, minEnd: k };
      }
    }

    // 3. Scheme-relative //authority/... URL: allows leading '_' emphasis wrappers (_//user:pass@host:8080_),
    // recognizes literal & percent-encoded WHATWG dot separators and authority/port/IPv6/footnote boundaries,
    // reserves structural IPv6/port cuts independently of heuristic punctuation cuts, scans by full Unicode code point
    // within a shared global CPU/validation budget, snapshots per-cut bracket/paren counts,
    // and fails closed on truncated EOF fragments, lookahead caps, or cut-bucket overflow.
    if (!prevIsAlnum && offset + 3 < len && c0 === 47 && str.charCodeAt(offset + 1) === 47 && prev !== 58 && prev !== 47) {
      const next = str[offset + 2];
      if (next && next !== '/' && !isBareUrlStop(next)) {
        let k = offset + 2;
        const maxScan = Math.min(len, offset + 2048);
        let openParens = 0, closeParens = 0, openBrackets = 0, closeBrackets = 0;
        let seenUrlSignal = false;
        let seenAt = false;
        let atHostStart = offset + 2;
        let seenPath = false;
        let inBrackets = false;
        let seenPortColon = false;
        let hasNonPortAfterColon = false;
        let postAtPortColon = false;
        let postAtPortCut = false;
        let cutsOverflowed = false;
        // 0 = none, 1 = punctuation/wrapper delim, 2 = Unicode symbol (\p{S}) that may be either host char (☃) or adjacent prose marker (📌).
        let prevDelimKind = 0;
        const structuralCuts = [];
        const preAtCuts = [];
        const postAtCuts = [];
        const pushCut = (bucket, cap, cut, balanced = false) => {
          if (bucket.length > 0 && bucket[bucket.length - 1].cut === cut) return;
          if (bucket.length < cap) {
            bucket.push(balanced
              ? { cut, openParens: 0, closeParens: 0, openBrackets: 0, closeBrackets: 0 }
              : { cut, openParens, closeParens, openBrackets, closeBrackets });
          } else {
            cutsOverflowed = true;
          }
        };
        while (k < maxScan && !isBareUrlStop(str[k])) {
          if (budget && ++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; return null; }
          if (str[k] === '\\' && k + 1 < maxScan && !isBareUrlStop(str[k + 1])) {
            const esc = str[k + 1];
            const isIpv6Open = !seenPath && esc === '[' && k === atHostStart;
            const isIpv6Close = !seenPath && esc === ']' && inBrackets;
            if (!seenPath && !inBrackets) {
              if (seenAt && postAtPortColon && !postAtPortCut && esc !== '#') {
                postAtPortCut = true;
                pushCut(structuralCuts, 16, k);
              } else if (!seenAt && seenPortColon && !hasNonPortAfterColon && esc !== '#') {
                pushCut(structuralCuts, 16, k);
                hasNonPortAfterColon = true;
              }
            }
            const isEscWrapDelim = !isIpv6Open && !isIpv6Close && (
              (esc === ']' && closeBrackets >= openBrackets)
              || (!seenPath && (esc === '[' || esc === '(' || esc === '{' || esc === '^'))
              || esc === '}' || esc === '|' || esc === '!' || esc === '*' || esc === '_' || esc === '~' || esc === '`'
            );
            if (isEscWrapDelim) {
              const couldBeComplete = seenUrlSignal && (seenAt || seenPath || !hasNonPortAfterColon);
              if (prevDelimKind !== 1 && couldBeComplete) pushCut(seenAt ? postAtCuts : preAtCuts, 64, k);
              if (esc === '[') openBrackets++;
              else if (esc === ']') { closeBrackets++; inBrackets = false; }
              else if (esc === '(') openParens++;
              else if (esc === ')') closeParens++;
              if (!seenAt && !seenPath && seenPortColon) hasNonPortAfterColon = true;
              prevDelimKind = 1;
            } else {
              if (isIpv6Open) { openBrackets++; inBrackets = true; seenUrlSignal = true; }
              else if (isIpv6Close) { closeBrackets++; inBrackets = false; pushCut(structuralCuts, 16, k + 2, true); }
              else if (esc === '[') openBrackets++;
              else if (esc === ']') closeBrackets++;
              else if (esc === '(') openParens++;
              else if (esc === ')') closeParens++;
              else if (esc === '#') { seenPath = true; seenUrlSignal = true; inBrackets = false; }
              else if (esc === '.') seenUrlSignal = true;
              prevDelimKind = 0;
            }
            k += 2;
            continue;
          }
          const { cp, width, ch } = codePointAtInfo(str, k);
          const isIpv6Open = !seenPath && width === 1 && ch === '[' && k === atHostStart;
          const isIpv6Close = !seenPath && width === 1 && ch === ']' && inBrackets;
          if (!seenPath && !inBrackets) {
            if (seenAt && postAtPortColon && !postAtPortCut
              && !(width === 1 && ((cp >= 48 && cp <= 57) || ch === '/' || ch === '?' || ch === '#'))) {
              postAtPortCut = true;
              pushCut(structuralCuts, 16, k);
            } else if (!seenAt && seenPortColon && !hasNonPortAfterColon
              && !(width === 1 && ((cp >= 48 && cp <= 57) || ch === '/' || ch === '?' || ch === '#' || ch === '@'))) {
              pushCut(structuralCuts, 16, k);
              hasNonPortAfterColon = true;
            }
          }
          const pctDotLen = (!seenPath && !inBrackets && width === 1 && ch === '%') ? percentWhatwgDotLenAt(str, k) : 0;
          if (pctDotLen > 0) {
            seenUrlSignal = true;
            if (!seenAt && seenPortColon) hasNonPortAfterColon = true;
            prevDelimKind = 0;
            k += pctDotLen;
            continue;
          }
          const isPunctDelim = !isIpv6Open && !isIpv6Close && (isNonAsciiPunct(cp, ch) || (width === 1 && (
            ch === ',' || ch === ';' || ch === '!' || ch === ')' || ch === '}' || ch === '|'
            || (ch === ']' && closeBrackets >= openBrackets)
            || (!seenPath && (ch === '[' || ch === '(' || ch === '{' || ch === '^' || ch === '%'))
            || ch === '\'' || ch === '`' || ch === '*' || ch === '_' || ch === '~'
          )));
          const isSymbolDelim = !isIpv6Open && !isIpv6Close && !isPunctDelim && isNonAsciiSymbol(cp, ch);
          if (isPunctDelim) {
            const couldBeComplete = seenUrlSignal && (seenAt || seenPath || !hasNonPortAfterColon);
            if (prevDelimKind !== 1 && couldBeComplete) pushCut(seenAt ? postAtCuts : preAtCuts, 64, k);
            if (isWhatwgDot(cp)) seenUrlSignal = true;
            if (width === 1) {
              if (ch === '(') openParens++;
              else if (ch === ')') closeParens++;
              else if (ch === '[') openBrackets++;
              else if (ch === ']') { closeBrackets++; inBrackets = false; }
            }
            if (!seenAt && !seenPath && seenPortColon) hasNonPortAfterColon = true;
            prevDelimKind = 1;
          } else if (isSymbolDelim) {
            const couldBeComplete = seenUrlSignal && (seenAt || seenPath || !hasNonPortAfterColon);
            if (prevDelimKind === 0 && couldBeComplete) pushCut(seenAt ? postAtCuts : preAtCuts, 64, k);
            if (!seenAt && !seenPath && seenPortColon) hasNonPortAfterColon = true;
            prevDelimKind = 2;
          } else {
            prevDelimKind = 0;
            if (width === 1) {
              if (ch === '@') { seenAt = true; seenUrlSignal = true; atHostStart = k + 1; inBrackets = false; postAtPortColon = false; postAtPortCut = false; }
              else if (ch === '/' || ch === '?' || ch === '#') { seenPath = true; seenUrlSignal = true; inBrackets = false; }
              else if (isIpv6Open) { openBrackets++; inBrackets = true; seenUrlSignal = true; }
              else if (isIpv6Close) { closeBrackets++; inBrackets = false; pushCut(structuralCuts, 16, k + 1, true); }
              else if (ch === '[') openBrackets++;
              else if (ch === ']') closeBrackets++;
              else if (ch === '(') openParens++;
              else if (ch === ')') closeParens++;
              else if (ch === '.') seenUrlSignal = true;
              else if (ch === ':') {
                seenUrlSignal = true;
                if (!inBrackets && !seenPath) {
                  if (seenAt) {
                    if (!postAtPortColon) postAtPortColon = true;
                  } else {
                    if (seenPortColon) hasNonPortAfterColon = true;
                    else seenPortColon = true;
                  }
                }
              }
            }
          }
          k += width;
        }
        const trimmedEnd = trimTrailingUrlPunct(str, offset + 2, k, openParens, closeParens, openBrackets, closeBrackets);
        if (isValidSchemeRelativeCandidate(str.slice(offset, trimmedEnd), budget)) return { prefixLen: 2, minEnd: trimmedEnd };
        if (budget?.exhausted) return null;
        for (let s = structuralCuts.length - 1; s >= 0; s--) {
          const c = structuralCuts[s];
          const prefixEnd = trimTrailingUrlPunct(str, offset + 2, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
          if (isValidSchemeRelativeCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: 2, minEnd: prefixEnd };
          if (budget?.exhausted) return null;
        }
        for (const c of postAtCuts) {
          const prefixEnd = trimTrailingUrlPunct(str, offset + 2, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
          if (isValidSchemeRelativeCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: 2, minEnd: prefixEnd };
          if (budget?.exhausted) return null;
        }
        for (const c of preAtCuts) {
          const prefixEnd = trimTrailingUrlPunct(str, offset + 2, c.cut, c.openParens, c.closeParens, c.openBrackets, c.closeBrackets);
          if (isValidSchemeRelativeCandidate(str.slice(offset, prefixEnd), budget)) return { prefixLen: 2, minEnd: prefixEnd };
          if (budget?.exhausted) return null;
        }
        // Fail closed on any truncated credential-bearing (including digit-only numeric passwords) or unclosed-IPv6
        // authority fragment at EOF, OR any unresolved authority exceeding lookahead or cut-tracking capacity.
        if (k === len && (seenAt || inBrackets || seenPortColon || postAtPortColon)) return { prefixLen: 2, minEnd: k };
        if ((k >= maxScan && k < len && !isBareUrlStop(str[k])) || cutsOverflowed) return { prefixLen: 2, minEnd: k };
      }
    }
    return null;
  }
  function stripPrivateUrls(text, { maxOutputChars = Infinity, maxUrlChecks = 256, maxScanSteps = 128_000 } = {}) {
    if (typeof text !== 'string' || !text) return text;
    const noLinks = stripBracketedLinks(stripBracketedLinks(text, true), false);
    const budget = { urlChecks: 0, scanSteps: 0, maxUrlChecks, maxScanSteps, exhausted: false };
    let out = '';
    let i = 0;
    const len = noLinks.length;
    let nextGt = noLinks.indexOf('>');
    let identBeforeUnderscores = false;
    while (i < len) {
      if (out.length >= maxOutputChars) break;
      if (++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; break; }
      if (noLinks[i] === '<' && matchUrlStartAt(noLinks, i + 1, false, budget)) {
        while (nextGt !== -1 && nextGt <= i) nextGt = noLinks.indexOf('>', nextGt + 1);
        if (nextGt !== -1) { i = nextGt + 1; identBeforeUnderscores = false; continue; }
      }
      if (budget.exhausted) break; // Fail closed: discard unprocessed remainder.
      const match = matchUrlStartAt(noLinks, i, identBeforeUnderscores, budget);
      if (budget.exhausted) break; // Fail closed: discard unprocessed remainder.
      if (match) {
        let j = i + match.prefixLen;
        let openParens = 0, closeParens = 0, openBrackets = 0, closeBrackets = 0;
        // Consume the entire non-whitespace/non-angle/non-quote token by full code point, never trimming inside the validated span.
        while (j < len && !isBareUrlStop(noLinks[j])) {
          if (++budget.scanSteps > budget.maxScanSteps) { budget.exhausted = true; break; }
          if (noLinks[j] === '\\' && j + 1 < len && !isBareUrlStop(noLinks[j + 1])) {
            const esc = noLinks[j + 1];
            if (esc === '[') openBrackets++;
            else if (esc === ']') closeBrackets++;
            else if (esc === '(') openParens++;
            else if (esc === ')') closeParens++;
            j += 2;
            continue;
          }
          const { width, ch } = codePointAtInfo(noLinks, j);
          if (width === 1) {
            if (ch === '(') openParens++;
            else if (ch === ')') closeParens++;
            else if (ch === '[') openBrackets++;
            else if (ch === ']') closeBrackets++;
          }
          j += width;
        }
        if (budget.exhausted) break; // Fail closed: discard partially scanned URL and remainder.
        j = Math.max(match.minEnd, trimTrailingUrlPunct(noLinks, i, j, openParens, closeParens, openBrackets, closeBrackets));
        i = j;
        identBeforeUnderscores = false;
        continue;
      }
      const { width } = codePointAtInfo(noLinks, i);
      if (out.length + width > maxOutputChars) break;
      if (width === 2) {
        identBeforeUnderscores = false;
        out += noLinks.slice(i, i + 2);
      } else {
        const code = noLinks.charCodeAt(i);
        if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          identBeforeUnderscores = true;
        } else if (code !== 95 && code !== 92) {
          identBeforeUnderscores = false;
        }
        out += noLinks[i];
      }
      i += width;
    }
    return out;
  }
  function prioritizeSelectedSources(items, selected, isPrivateSource, max = 12) {
    const ordered = selected ? [selected, ...items.filter(it => it.id !== selected.id)] : items;
    const bounded = ordered.slice(0, max);
    if (!isPrivateSource) return bounded;
    return bounded.map(it => ({ ...it, media: [], summaryExcerpt: stripPrivateUrls(it.summaryExcerpt, { maxOutputChars: 1000 }) }));
  }
  const storyContext = c => ({ headline: c.headline,
    summaryExcerpt: c.isPrivateSource ? stripPrivateUrls(c.summaryExcerpt, { maxOutputChars: 1000 }) : c.summaryExcerpt,
    publishedAt: c.publishedAt, sourceNames: c.sourceNames.slice(0, 4),
    ...(c.isPrivateSource ? { isPrivateSource: true } : {}) });

  async function savePreferences(userId, patch) {
    const { signal } = controller;
    ensureRunning(signal);
    ensureActive(userId);
    if (!object(patch)) fail('Expected preference object');
    const previous = preferred(userId);
    const prefs = { ...previous };
    const domainPatch = patch.enabledDomains ?? patch.enabledDomainIds;
    if (domainPatch !== undefined) {
      if (!Array.isArray(domainPatch) || domainPatch.length > BUILTIN_DOMAINS.length || domainPatch.some(id => !domainIds.has(id))) fail('Invalid enabled domains');
      prefs.enabledDomainIds = [...new Set(domainPatch)];
    }
    const simple = {
      onboarded: value => typeof value === 'boolean',
      disabledSources: value => Array.isArray(value) && value.length <= BUILTIN_SOURCES.length + 20 && value.every(id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)),
      preferredAgentId: value => typeof value === 'string' && value.length <= 128,
      defaultPerspective: value => ['balanced', 'engineering', 'product', 'investing'].includes(value),
      autoRefreshMinutes: value => Number.isInteger(value) && value >= 0 && value <= 120,
    };
    for (const [key, valid] of Object.entries(simple)) {
      if (!Object.hasOwn(patch, key)) continue;
      if (!valid(patch[key])) fail(`Invalid ${key}`);
      prefs[key] = patch[key];
    }
    for (const key of ['watchKeywords', 'muteKeywords']) if (Object.hasOwn(patch, key)) prefs[key] = keywords(patch[key], key);
    if (Object.hasOwn(patch, 'customDomains')) {
      if (!Array.isArray(patch.customDomains) || patch.customDomains.length > 12) fail('At most 12 custom domains are allowed');
      const ids = new Set();
      let count = 0;
      const toValidate = new Set();
      prefs.customDomains = patch.customDomains.map(d => {
        if (!object(d)) fail('Invalid custom domain');
        const id = d.id ?? `custom-${randomUUID()}`;
        const name = trim(d.name ?? d.nameZh ?? d.nameEn, 80);
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || domainIds.has(id) || ids.has(id) || !name) fail('Invalid or duplicate custom domain');
        if (d.enabled != null && typeof d.enabled !== 'boolean') fail('Invalid custom domain enabled state');
        if (Object.hasOwn(d, 'aiRadar') && typeof d.aiRadar !== 'boolean') fail('Invalid custom domain aiRadar state');
        ids.add(id);
        const urls = d.rssUrls ?? [];
        if (!Array.isArray(urls) || (count += urls.length) > 20) fail('At most 20 custom RSS URLs are allowed');
        const rssUrls = urls.map(value => {
          if (typeof value !== 'string' || !value.trim() || value.length > 4096) fail('Invalid custom RSS URL');
          let url;
          try { url = new URL(value); } catch { fail('Invalid custom RSS URL'); }
          url.hash = '';
          toValidate.add(url.href);
          return url.href;
        });
        return { id, name, nameZh: trim(d.nameZh, 80) || name, nameEn: trim(d.nameEn, 80) || name,
          colorToken: colors.has(d.colorToken) ? d.colorToken : 'cyan', icon: trim(d.icon, 8) || '✧', enabled: d.enabled !== false, aiRadar: d.aiRadar === true,
          keywords: keywords(d.keywords ?? d.matchKeywords ?? [], 'custom domain keywords'), rssUrls: [...new Set(rssUrls)] };
      });
      await Promise.all([...toValidate].map(async url => {
        try { await validateExternalUrl(url, { dnsLookup, signal }); }
        catch { throw signal.aborted ? error(503, 'Cosmic Web is stopping') : error(400, 'Custom RSS URL must resolve only to public HTTP(S) addresses'); }
      }));
    }
    ensureRunning(signal);
    ensureActive(userId);
    db.cosmicWebTransaction(() => {
      // Merge disjoint patches made while DNS validation was pending.
      const current = preferred(userId);
      if (domainPatch === undefined) prefs.enabledDomainIds = current.enabledDomainIds;
      for (const k of ['watchKeywords', 'muteKeywords', 'customDomains', ...Object.keys(simple)]) if (!Object.hasOwn(patch, k)) prefs[k] = current[k];
      db.saveUserPrefs(userId, prefs, now());
      if (Object.hasOwn(patch, 'customDomains')) {
        db.deactivateSources(userId);
        for (const d of prefs.customDomains.filter(d => d.enabled)) db.activateRadarSource(radarSource(userId, d));
        for (const d of prefs.customDomains.filter(d => d.enabled)) for (const url of d.rssUrls) {
          db.upsertSource({ id: `rss-${hash(userId, d.id, url)}`, ownerUserId: userId, url, domainId: d.id, name: d.name, kind: 'rss' });
        }
      }
    });
    swr(userId, prefs);
    const clusters = filtered(userId, {}, false);
    return { ...publicPrefs(prefs), ...metadata(userId, prefs, clusters), graph: graphProjection(prefs, clusters, userId) };
  }

  // cw_sources.id is globally unique, so keep storage keys owner-scoped while exposing radar-<domain> over the API.
  function radarSource(userId, domain) {
    return { id: `radar-${hash(userId, domain.id)}`, ownerUserId: userId, domainId: domain.id, name: domain.name,
      url: '', kind: 'radar' };
  }
  const briefKey = (id, itemId, agentId) => hash(4, 'brief-context', id, itemId, agentId);

  function stats(userId, prefs, rows) {
    const states = db.listUserClusterStates(userId);
    const sources = sourcesFor(userId, prefs);
    return { totalClusters: rows.length, unreadCount: rows.filter(c => c.unread).length,
      bookmarkedCount: [...states.values()].filter(s => s.bookmarked).length, watchHitCount: rows.filter(c => c.watchHit).length,
      sourcesHealthy: sources.filter(s => s.last_success_at && !s.last_error).length, sourcesTotal: sources.length,
      lastSyncedAt: sources.reduce((max, s) => Math.max(max, s.last_success_at ?? 0), 0) || null };
  }

  async function refresh(userId, body = {}) {
    const { signal } = controller;
    ensureRunning(signal);
    ensureActive(userId);
    const time = now();
    for (const [id, expires] of cooling) if (expires <= time) cooling.delete(id);
    if (cooling.has(userId)) throw error(429, 'Refresh is limited to once every 20 seconds');
    cooling.set(userId, time + 20_000);
    seed();
    const prefs = preferred(userId);
    const results = await refreshRows(sourcesFor(userId, prefs, trim(body?.domainId, 80)), body?.force !== false);
    ensureRunning(signal);
    ensureActive(userId);
    return { added: results.reduce((sum, r) => sum + (r.added ?? 0), 0), failed: results.filter(r => r.failed).length,
      updatedAt: now(), ...metadata(userId, preferred(userId)) };
  }
  function startScheduler() {
    if (timer || !autoRefresh()) return false;
    if (stopping) {
      controller = new AbortController();
      stopping = false;
    }
    const tick = () => {
      if (stopping || schedulerRun) return;
      try {
        seed();
        db.pruneCosmicWebDb(now());
        const ownerActive = new Map();
        const privateSources = db.listActivePrivateSources().filter(row => {
          const owner = row.owner_user_id;
          if (!ownerActive.has(owner)) ownerActive.set(owner, isUserActive(owner));
          return ownerActive.get(owner);
        });
        const run = refreshRows([...db.listSources(), ...privateSources]);
        schedulerRun = run;
        void run.catch(err => { if (err.status !== 503) console.error('[CosmicWeb] Scheduled refresh failed:', err.message); })
          .finally(() => { if (schedulerRun === run) schedulerRun = undefined; });
      } catch (err) { console.error('[CosmicWeb] Scheduler failed:', err.message); }
    };
    initialTimer = setTimeout(tick, 0);
    initialTimer.unref();
    timer = setInterval(tick, refreshTtl + Math.floor(Math.random() * 25_000));
    timer.unref();
    return true;
  }
  function stopScheduler() {
    stopping = true;
    clearTimeout(initialTimer); clearInterval(timer);
    initialTimer = timer = schedulerRun = undefined;
    controller.abort();
    for (const job of queue.splice(0)) job.reject(error(503, 'Cosmic Web is stopping'));
    inflight.clear(); articleInflight.clear(); aiInflight.clear(); cooling.clear(); enrichmentInflight.clear(); radarCooling.clear(); radarActive.clear();
  }

  function enrichedDomains(userId, prefs, clusters) {
    const privateSources = db.listSources(userId);
    const dbSources = new Map([...db.listSources(), ...privateSources].map(s => [publicSourceId(s), s]));
    const countsByDomain = new Map();
    for (const c of clusters) {
      const seen = new Set([c.domainId, ...c.relatedDomains]);
      for (const dId of seen) {
        const entry = countsByDomain.get(dId) ?? { itemCount: 0, unreadCount: 0 };
        entry.itemCount += 1;
        if (c.unread) entry.unreadCount += 1;
        countsByDomain.set(dId, entry);
      }
    }
    const sources = [...BUILTIN_SOURCES, ...privateSources.map(sourceFromRow)];
    return [...BUILTIN_DOMAINS, ...prefs.customDomains].map(d => {
      const domainSources = sources.filter(s => s.domainId === d.id).map(s => {
        const row = dbSources.get(s.id);
        return {
          ...s,
          enabled: !prefs.disabledSources.includes(s.id),
          lastSuccessAt: row?.last_success_at ?? null,
          lastAttemptAt: row?.last_attempt_at ?? null,
          lastError: row?.last_error ?? null,
          consecutiveErrors: row?.consecutive_errors ?? 0,
        };
      });
      const counts = countsByDomain.get(d.id) ?? { itemCount: 0, unreadCount: 0 };
      return {
        ...d,
        labelZh: d.nameZh,
        labelEn: d.nameEn,
        isCustom: !domainIds.has(d.id),
        itemCount: counts.itemCount,
        unreadCount: counts.unreadCount,
        sources: domainSources,
      };
    });
  }

  function metadata(userId, prefs, clusters = filtered(userId, {}, false)) {
    return { domains: enrichedDomains(userId, prefs, clusters), stats: stats(userId, prefs, clusters) };
  }
  function graphProjection(prefs, clusters, userId) {
    if (!userId) throw new Error('Expected userId for Cosmic Web graph projection');
    return buildGraphProjection({ prefs, clusters, domains: BUILTIN_DOMAINS, userId, now: now() });
  }

  return {
    bootstrap(userId, userRole) {
      const preferences = preferred(userId);
      swr(userId, preferences);
      const capableAgents = listCapableAgentsForUser(userId, userRole, 'brief').map(a => ({ ...a, online: true }));
      const prefsPub = publicPrefs(preferences);
      const clusters = filtered(userId, {}, false);
      const graph = graphProjection(preferences, clusters, userId);
      return {
        ...metadata(userId, preferences, clusters),
        sources: [...BUILTIN_SOURCES, ...db.listSources(userId).map(sourceFromRow)],
        preferences: prefsPub,
        prefs: prefsPub,
        graph,
        agents: capableAgents,
        capableAgents,
      };
    },
    feed(userId, query = {}) {
      const rows = filtered(userId, query);
      const offset = Math.max(0, Math.min(100_000, Number.parseInt(query.offset ?? query.cursor, 10) || 0));
      const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 40));
      const clusters = rows.slice(offset, offset + limit).map(summary);
      return { clusters, total: rows.length, nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
    },
    graph(userId, query) {
      const prefs = preferred(userId);
      return { ...graphProjection(prefs, filtered(userId, query), userId), ...metadata(userId, prefs) };
    },
    cluster, clusterCommunity, article,
    async aiBrief(userId, userRole, id, body = {}, reqSignal) {
      const signal = combineSignals(reqSignal);
      ensureRunning(signal);
      ensureActive(userId);
      const mode = body.mode ?? 'brief';
      if (!['brief', 'synthesize'].includes(mode)) fail('Invalid briefing mode');
      const options = briefingOptions(userId, userRole, body, preferred(userId), mode);
      const c = visibleCluster(userId, id);
      const item = selectItem(c, body);
      const hasTrustedPrivateArticle = rec => rec?.extractorVersion === ARTICLE_EXTRACTOR_VERSION && typeof rec?.truncated === 'boolean';
      const cached = db.getArticleCache(userId, item.id, now());
      const hasTrustedCached = Boolean(cached && (!c.isPrivateSource || hasTrustedPrivateArticle(cached)));
      const articleTask = hasTrustedCached
        ? Promise.resolve(cached)
        : (body.skipArticleFetch === true
          ? Promise.resolve(null)
          : articleRecord(userId, id, { itemId: item.id, force: Boolean(cached), preserveCacheOnBlocked: Boolean(cached) }).then(entry => entry.result));
      const [content, context] = await Promise.all([
        quick(articleTask, hasTrustedCached ? cached : null),
        c.isPrivateSource ? Promise.resolve(noEnrichment()) : briefingEnrichment(c, signal, body.skipArticleFetch === true),
      ]);
      // Never enable outbound web research for owner-private feeds or legacy v1 Agents.
      const allowResearch = !c.isPrivateSource && body.research === true && Boolean(options.agent?.supportsResearch);
      // For private sources, only accept versioned extractor rows with explicit truncation provenance; truncated rows use
      // the source-cutoff-safe aiMarkdown computed before closing Markdown syntax is synthesized, while unversioned legacy
      // rows are re-extracted above or omitted here (never falling back to unversioned private Markdown).
      const trustedPrivateContent = hasTrustedPrivateArticle(content);
      const privateArticleMd = c.isPrivateSource
        ? (trustedPrivateContent
          ? (content.truncated
            ? (typeof content.aiMarkdown === 'string' ? content.aiMarkdown : undefined)
            : content.markdown)
          : undefined)
        : content?.markdown;
      const safeArticleMd = c.isPrivateSource
        ? (privateArticleMd ? stripPrivateUrls(privateArticleMd, { maxOutputChars: 12_000 }) : undefined)
        : privateArticleMd?.slice(0, 12_000);
      const safeExcerpt = c.isPrivateSource ? stripPrivateUrls(item.summaryExcerpt, { maxOutputChars: 1000 }) : item.summaryExcerpt;
      const result = await ai(userId, userRole, mode, body, {
        headline: item.title, sourceUrl: item.url, summaryExcerpt: safeExcerpt,
        isPrivateSource: c.isPrivateSource,
        research: allowResearch,
        articleMarkdown: safeArticleMd, quality: (!c.isPrivateSource || trustedPrivateContent) ? content?.quality : undefined,
        sources: prioritizeSelectedSources(c.items, item, c.isPrivateSource, 12), ...context,
      }, signal, options);
      ensureRunning(signal);
      ensureActive(userId);
      db.setAiCache(userId, briefKey(id, item.id, result.agentId), result.tldr, now() + 6 * 60 * minute);
      return result;
    },
    async followUp(userId, userRole, id, body = {}, reqSignal) {
      const signal = combineSignals(reqSignal);
      ensureRunning(signal);
      ensureActive(userId);
      const options = briefingOptions(userId, userRole, body, preferred(userId), 'follow_up');
      if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 500) fail('Question must be 1–500 characters');
      const c = visibleCluster(userId, id);
      const item = selectItem(c, body);
      const context = c.isPrivateSource ? noEnrichment() : await briefingEnrichment(c, signal);
      const cachedBriefContext = options.agent ? db.getAiCache(userId, briefKey(id, item.id, options.agent.id), now()) : undefined;
      const rawBriefContext = cachedBriefContext || (typeof body.briefContext === 'string' ? body.briefContext.trim() : undefined);
      const allowResearch = !c.isPrivateSource && body.research === true && Boolean(options.agent?.supportsResearch);
      const safeExcerpt = c.isPrivateSource ? stripPrivateUrls(item.summaryExcerpt, { maxOutputChars: 1000 }) : item.summaryExcerpt;
      // Scrub private briefContext BEFORE enforcing the 1,500-char limit so boundary-straddling username-only URLs cannot survive.
      const safeBriefContext = rawBriefContext
        ? (c.isPrivateSource ? (stripPrivateUrls(rawBriefContext, { maxOutputChars: 1500 }).trim() || undefined) : rawBriefContext.slice(0, 1500))
        : undefined;
      return ai(userId, userRole, 'follow_up', body, {
        ...storyContext(c), headline: item.title, sourceUrl: item.url, summaryExcerpt: safeExcerpt,
        isPrivateSource: c.isPrivateSource,
        question: body.question.trim(), research: allowResearch, briefContext: safeBriefContext ?? undefined,
        sources: prioritizeSelectedSources(c.items, item, c.isPrivateSource, 12), ...context,
      }, signal, options);
    },
    async radarScan(userId, userRole, domainId, body = {}, reqSignal) {
      const signal = combineSignals(reqSignal);
      ensureRunning(signal);
      ensureActive(userId);
      const prefs = preferred(userId);
      const domain = prefs.customDomains.find(d => d.id === domainId);
      if (!domain) throw error(404, 'Custom domain not found');
      if (!domain.aiRadar) throw error(400, 'AI Topic Radar is not enabled for this constellation');
      const options = briefingOptions(userId, userRole, body, prefs, 'topic_radar');
      if (!options.agent) throw error(503, 'No capable Agent is online');
      const time = now();
      for (const [id, expires] of radarCooling) if (expires <= time) radarCooling.delete(id);
      if (radarCooling.has(userId) || radarActive.has(userId)) throw error(429, 'Topic Radar is limited to once every 60 seconds');
      radarCooling.set(userId, time + minute);
      radarActive.add(userId);
      try {
        const result = await requestAi({ userId, userRole, agentId: options.agent.id, mode: 'topic_radar', perspective: options.perspective,
          language: options.language, payload: { topic: domain.name, topicName: domain.name, keywords: domain.keywords, research: true }, signal });
        if (!validateCosmicWebAiResult(result, 'topic_radar')) throw error(502, 'Agent returned an invalid radar result');
        ensureRunning(signal);
        ensureActive(userId);
        const seen = new Set();
        const items = (await Promise.all(result.items.map(async row => {
          const url = canonicalizeUrl(row.url), title = cleanText(row.title).slice(0, 500);
          if (!url || !title || seen.has(url)) return null;
          seen.add(url);
          // DNS checks use the same global concurrency bound as source fetching.
          try { await limit(() => validateExternalUrl(url, { dnsLookup, signal, timeoutMs: 5000 })); }
          catch { return null; }
          const media = normalizeMedia([row.mediaUrl]);
          return { url, title, sourceName: cleanText(row.sourceName).slice(0, 150), summaryExcerpt: cleanText(row.summaryExcerpt).slice(0, 1000),
            publishedAt: Math.min(now(), parseTimestamp(row.publishedAt) ?? now()), media };
        }))).filter(Boolean);
        ensureRunning(signal);
        ensureActive(userId);
        const current = preferred(userId);
        const latest = current.customDomains.find(d => d.id === domainId);
        if (!latest || !latest.aiRadar || latest.name !== domain.name || JSON.stringify(latest.keywords) !== JSON.stringify(domain.keywords)) {
          throw error(409, 'Custom domain changed during scan');
        }
        const source = radarSource(userId, latest);
        const scanTime = now();
        const retained = items.filter(item => item.publishedAt >= scanTime - db.RETENTION_MS);
        const added = retained.length ? ingestCosmicWebItems(source, retained, scanTime) : 0;
        if (retained.length) {
          db.recordSourceRefresh(source.id, userId, scanTime);
          if (!latest.enabled) db.disableRadarSource(source.id, userId);
        }
        if (added) update(source, signal);
        const clusters = filtered(userId, {}, false);
        return { added, items: retained.map(item => ({ ...item, sourceId: radarId(domainId), domainId })), ...metadata(userId, current, clusters), graph: graphProjection(current, clusters, userId) };
      } finally { radarActive.delete(userId); }
    },
    async dailyBriefing(userId, userRole, body = {}, reqSignal) {
      const signal = combineSignals(reqSignal);
      ensureRunning(signal);
      ensureActive(userId);
      const prefs = preferred(userId);
      const options = briefingOptions(userId, userRole, body, prefs, 'daily_briefing');
      const time = now();
      const recent = c => c.publishedAt >= time - 24 * 60 * minute;
      const clusters = filtered(userId, {}, false).filter(recent);
      const enabled = enabledIds(prefs);
      const ranked = [...BUILTIN_DOMAINS, ...prefs.customDomains].filter(d => enabled.has(d.id))
        .map(({ id, nameZh, nameEn }) => ({ id, nameZh, nameEn, stories: clusters.filter(c => c.domainIds.includes(id)) }))
        .filter(d => d.stories.length)
        .sort((a, b) => b.stories.length - a.stories.length || b.stories[0].heatScore - a.stories[0].heatScore)
        .slice(0, 8);
      if (!ranked.length) {
        const top = listClusters(userId, prefs, time).filter(c => !c.muted && recent(c))
          .sort((a, b) => b.heatScore - a.heatScore || b.publishedAt - a.publishedAt).slice(0, 8);
        if (top.length) ranked.push({ id: 'top-stories', nameZh: '热门新闻', nameEn: 'Top stories', stories: top });
      }
      const domains = ranked.map(d => ({ ...d, stories: d.stories.slice(0, 8).map(storyContext) }));
      return ai(userId, userRole, 'daily_briefing', body, { date: new Date(time).toISOString().slice(0, 10), domains }, signal, options);
    },
    setClusterState(userId, id, patch) {
      ensureRunning(controller.signal);
      ensureActive(userId);
      if (!object(patch)) fail('Invalid cluster state');
      const unread = patch.unread ?? (typeof patch.read === 'boolean' ? !patch.read : undefined);
      const { bookmarked, muted } = patch;
      const fields = [unread, bookmarked, muted];
      if (fields.every(v => v === undefined) || fields.some(v => v !== undefined && typeof v !== 'boolean')) fail('Invalid cluster state');
      const state = db.saveUserClusterState(userId, id, { unread, bookmarked, muted }, now());
      if (!state) throw error(404, 'Cluster not found');
      return state;
    },
    markAllRead(userId, query = {}) {
      ensureRunning(controller.signal);
      ensureActive(userId);
      const rows = filtered(userId, query, false).filter(c => c.unread);
      db.cosmicWebTransaction(() => { for (const c of rows) db.saveUserClusterState(userId, c.id, { unread: false }, now()); });
      const prefs = preferred(userId);
      const clusters = filtered(userId, {}, false);
      return { updated: rows.length, ...metadata(userId, prefs, clusters), graph: graphProjection(prefs, clusters, userId) };
    },
    getPreferences: userId => publicPrefs(preferred(userId)), savePreferences, refresh, startScheduler, stopScheduler,
  };
}

export const cosmicWebService = createCosmicWebService();
export function startCosmicWebScheduler() { return cosmicWebService.startScheduler(); }
export function stopCosmicWebScheduler() {
  cosmicWebService.stopScheduler();
  clearAllCosmicWebAiRequests();
}
