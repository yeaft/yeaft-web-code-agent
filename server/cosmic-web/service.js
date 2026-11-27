import { createHash, randomUUID } from 'node:crypto';
import * as db from '../db/cosmic-web-db.js';
import { webClients } from '../context.js';
import { sendToWebClient } from '../ws-utils.js';
import { BUILTIN_DOMAINS, BUILTIN_SOURCES } from './catalog.js';
import { fetchSource } from './sources.js';
import { safeFetch, validateExternalUrl } from './safe-fetch.js';
import { extractCleanArticle } from './article-extractor.js';
import { buildGraphProjection, CLUSTER_THRESHOLD, CLUSTER_WINDOW_MS, clusterSimilarity, computeHeatScore, extractTokens } from './clusterer.js';
import { clearAllCosmicWebAiRequests, listCapableAgentsForUser, requestCosmicWebAi } from './ai-bridge.js';

const minute = 60_000;
const refreshTtl = 5 * minute;
const defaultDomains = BUILTIN_DOMAINS.filter(d => d.defaultEnabled).map(d => d.id);
const domainIds = new Set(BUILTIN_DOMAINS.map(d => d.id));
const colors = new Set(BUILTIN_DOMAINS.map(d => d.colorToken));
const error = (status, message) => Object.assign(new Error(message), { status });
const fail = message => { throw error(400, message); };
const lower = value => value.normalize('NFKC').toLowerCase();
const hash = (...args) => createHash('sha256').update(JSON.stringify(args)).digest('hex');
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
const trim = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const defaults = () => ({ enabledDomainIds: [...defaultDomains], customDomains: [], watchKeywords: [], muteKeywords: [],
  disabledSources: [], preferredAgentId: '', defaultPerspective: 'balanced', onboarded: false, autoRefreshMinutes: 15 });
const preferred = userId => ({ ...defaults(), ...db.loadUserPrefs(userId) });
const publicPrefs = ({ enabledDomainIds, ...prefs }) => ({ ...prefs, enabledDomains: enabledDomainIds });
const sourceFromRow = row => ({ id: row.id, ownerUserId: row.owner_user_id, domainId: row.domain_id, name: row.name,
  url: row.url, kind: row.kind, lastAttemptAt: row.last_attempt_at });

function matches(words, fields) { return words.some(word => fields.some(text => lower(text).includes(lower(word)))); }
function enabledIds(prefs) {
  return new Set([...prefs.enabledDomainIds, ...prefs.customDomains.filter(d => d.enabled).map(d => d.id)]);
}
function toItem(row) {
  return { id: row.id, sourceId: row.source_id, domainId: row.domain_id, sourceName: row.source_name,
    url: row.url, title: row.title, summaryExcerpt: row.summary_excerpt, publishedAt: row.published_at };
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
      if (db.findItemBySourceUrl(source.id, ownerUserId, i.url)) continue;
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
    const articles = grouped.get(row.id).filter(item => !prefs.disabledSources.includes(item.source_id));
    if (!articles.length) return [];
    const items = articles.map(toItem);
    const keywords = JSON.parse(row.keywords_json);
    const fields = [row.headline, row.summary_excerpt, ...items.map(i => i.title), ...keywords];
    const actual = [...new Set(items.map(i => i.domainId))];
    const custom = prefs.customDomains.filter(d => d.enabled && d.keywords.length && matches(d.keywords, fields)).map(d => d.id);
    const allDomains = [...new Set([...actual, ...custom])];
    const domainId = allDomains.find(d => enabled.has(d)) ?? actual[0];
    const sourceNames = [...new Set(items.map(i => i.sourceName))];
    const state = states.get(row.id) ?? { unread: true, bookmarked: false };
    const domain = [...BUILTIN_DOMAINS, ...prefs.customDomains].find(d => d.id === domainId);
    return [{ id: row.id, clusterId: row.id, headline: row.headline, summaryExcerpt: row.summary_excerpt,
      primaryUrl: items[0]?.url || '',
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
  requestAi = requestCosmicWebAi } = {}) {
  const inflight = new Map(), cooling = new Map(), articleInflight = new Map(), aiInflight = new Map();
  let controller = new AbortController(), generation = 0, timer, initialTimer, schedulerRun;
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
    return [...db.listSources(), ...db.listSources(userId)].filter(s => enabled.has(s.domain_id) && (!domain || s.domain_id === domain) && !prefs.disabledSources.includes(s.id));
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
    const s = sourceFromRow(row);
    if (inflight.has(s.id)) return inflight.get(s.id);
    if (!force && s.lastAttemptAt != null && now() - s.lastAttemptAt < refreshTtl) return Promise.resolve({ skipped: true });
    const { signal } = controller;
    const task = limit(async () => {
      if (signal.aborted || !db.getSource(s.id, s.ownerUserId)) return { skipped: true };
      let items;
      try { items = await fetchSource(s, { fetcher, dnsLookup, signal, now: now() }); }
      catch {
        if (!signal.aborted) db.recordSourceRefresh(s.id, s.ownerUserId, now(), 'source_unavailable');
        return { failed: !signal.aborted };
      }
      if (signal.aborted || !db.getSource(s.id, s.ownerUserId)) return { skipped: true };
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
    if (!autoRefresh()) return;
    try { seed(); void refreshRows(sourcesFor(userId, prefs)).catch(err => console.error('[CosmicWeb] Refresh failed:', err.message)); }
    catch (err) { console.error('[CosmicWeb] Refresh failed:', err.message); }
  }
  function cluster(userId, id) {
    const value = listClusters(userId, preferred(userId), now(), id)[0];
    if (!value) throw error(404, 'Cluster not found');
    return value;
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

  async function article(userId, id, options = {}) {
    const c = cluster(userId, id);
    const { itemId, url, force } = typeof options === 'string' ? { itemId: options } : options;
    // URL selection must be an exact match to a scoped, stored cluster item.
    const item = itemId != null ? c.items.find(i => i.id === itemId) : url != null ? c.items.find(i => i.url === url) : c.items[0];
    if (!item) throw error(404, 'Article not found');
    const cached = db.getArticleCache(userId, item.id, now());
    if (cached && force !== true && force !== '1') return cached;
    if (articleInflight.has(item.id)) return articleInflight.get(item.id);
    const { signal } = controller;
    const task = limit(async () => {
      if (signal.aborted) throw error(503, 'Cosmic Web is stopping');
      let value = extractCleanArticle(null, item.url, item.title);
      if (value.quality !== 'search_only') {
        try {
          const res = await fetcher(item.url, { dnsLookup, signal });
          if (res.status >= 200 && res.status < 300) value = extractCleanArticle(await res.text(), res.url ?? item.url, item.title);
        } catch { /* Use the blocked fallback and a short negative cache. */ }
      }
      if (signal.aborted) throw error(503, 'Cosmic Web is stopping');
      const result = { ...value, itemId: item.id, clusterId: id, summaryExcerpt: item.summaryExcerpt };
      db.setArticleCache(userId, item.id, result, now() + (value.quality === 'blocked' ? minute : 24 * 60 * minute));
      return result;
    }).finally(() => { if (articleInflight.get(item.id) === task) articleInflight.delete(item.id); });
    articleInflight.set(item.id, task);
    return task;
  }

  async function ai(userId, userRole, mode, body, payload) {
    if (!object(body)) fail('Invalid briefing options');
    const prefs = preferred(userId);
    const perspective = body.perspective ?? prefs.defaultPerspective;
    if (!['balanced', 'engineering', 'product', 'investing'].includes(perspective)) fail('Invalid briefing perspective');
    const language = trim(body.language, 30) || 'zh-CN';
    const available = listCapableAgentsForUser(userId, userRole);
    const agentId = body.agentId ?? available.find(a => a.id === prefs.preferredAgentId)?.id ?? available[0]?.id;
    if (body.agentId != null && !available.some(a => a.id === body.agentId)) throw error(403, 'Agent is not available to this user');
    const key = hash(1, mode, perspective, language, payload);
    const cached = db.getAiCache(userId, key, now());
    if (cached && body.force !== true) return { ...cached, cached: true };
    if (!agentId) throw error(503, 'No capable Agent is online');
    if (typeof agentId !== 'string' || !available.some(a => a.id === agentId)) throw error(403, 'Agent is not available to this user');
    const scope = hash(userId, key, agentId);
    if (aiInflight.has(scope)) return aiInflight.get(scope);
    const epoch = generation;
    const agentMeta = available.find(a => a.id === agentId);
    const task = Promise.resolve(requestAi({ userId, userRole, agentId, mode, perspective, language, payload })).then(result => {
      if (epoch !== generation) throw error(503, 'Cosmic Web is stopping');
      const enriched = { ...result, agentId, agentName: agentMeta?.name ?? agentId, perspective, generatedAt: now() };
      db.setAiCache(userId, key, enriched, now() + 6 * 60 * minute);
      return { ...enriched, cached: false };
    }).finally(() => { if (aiInflight.get(scope) === task) aiInflight.delete(scope); });
    aiInflight.set(scope, task);
    return task;
  }
  const storyContext = c => ({ headline: c.headline, summaryExcerpt: c.summaryExcerpt,
    publishedAt: c.publishedAt, sourceNames: c.sourceNames.slice(0, 4) });

  async function savePreferences(userId, patch) {
    if (!object(patch)) fail('Expected preference object');
    const previous = preferred(userId);
    const prefs = { ...previous };
    const domainPatch = patch.enabledDomains ?? patch.enabledDomainIds;
    if (domainPatch !== undefined) {
      if (!Array.isArray(domainPatch) || domainPatch.length > 6 || domainPatch.some(id => !domainIds.has(id))) fail('Invalid enabled domains');
      prefs.enabledDomainIds = [...new Set(domainPatch)];
    }
    const simple = {
      onboarded: value => typeof value === 'boolean',
      disabledSources: value => Array.isArray(value) && value.length <= 43 && value.every(id => typeof id === 'string' && /^[\w-]{1,80}$/.test(id)),
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
          colorToken: colors.has(d.colorToken) ? d.colorToken : 'cyan', icon: trim(d.icon, 8) || '✧', enabled: d.enabled !== false,
          keywords: keywords(d.keywords ?? d.matchKeywords ?? [], 'custom domain keywords'), rssUrls: [...new Set(rssUrls)] };
      });
      const { signal } = controller;
      await Promise.all([...toValidate].map(async url => {
        try { await validateExternalUrl(url, { dnsLookup, signal }); }
        catch { throw signal.aborted ? error(503, 'Cosmic Web is stopping') : error(400, 'Custom RSS URL must resolve only to public HTTP(S) addresses'); }
      }));
      if (signal.aborted) throw error(503, 'Cosmic Web is stopping');
    }
    db.cosmicWebTransaction(() => {
      // Merge disjoint patches made while DNS validation was pending.
      const current = preferred(userId);
      if (domainPatch === undefined) prefs.enabledDomainIds = current.enabledDomainIds;
      for (const k of ['watchKeywords', 'muteKeywords', 'customDomains', ...Object.keys(simple)]) if (!Object.hasOwn(patch, k)) prefs[k] = current[k];
      db.saveUserPrefs(userId, prefs, now());
      if (Object.hasOwn(patch, 'customDomains')) {
        db.deactivateSources(userId);
        for (const d of prefs.customDomains.filter(d => d.enabled)) for (const url of d.rssUrls) {
          db.upsertSource({ id: `rss-${hash(userId, d.id, url)}`, ownerUserId: userId, url, domainId: d.id, name: d.name, kind: 'rss' });
        }
      }
    });
    swr(userId, prefs);
    return publicPrefs(prefs);
  }

  function stats(userId, prefs) {
    const rows = filtered(userId, {}, false);
    const states = db.listUserClusterStates(userId);
    const sources = sourcesFor(userId, prefs);
    return { totalClusters: rows.length, unreadCount: rows.filter(c => c.unread).length,
      bookmarkedCount: [...states.values()].filter(s => s.bookmarked).length, watchHitCount: rows.filter(c => c.watchHit).length,
      sourcesHealthy: sources.filter(s => s.last_success_at && !s.last_error).length, sourcesTotal: sources.length,
      lastSyncedAt: sources.reduce((max, s) => Math.max(max, s.last_success_at ?? 0), 0) || null };
  }

  async function refresh(userId, body = {}) {
    const time = now();
    for (const [id, expires] of cooling) if (expires <= time) cooling.delete(id);
    if (cooling.has(userId)) throw error(429, 'Refresh is limited to once every 20 seconds');
    cooling.set(userId, time + 20_000);
    seed();
    const prefs = preferred(userId);
    const results = await refreshRows(sourcesFor(userId, prefs, trim(body?.domainId, 80)), body?.force !== false);
    return { added: results.reduce((sum, r) => sum + (r.added ?? 0), 0), failed: results.filter(r => r.failed).length, updatedAt: now(), stats: stats(userId, prefs) };
  }
  function startScheduler() {
    if (timer || !autoRefresh()) return false;
    const tick = () => {
      if (schedulerRun) return;
      try {
        seed();
        db.pruneCosmicWebDb(now());
        const run = refreshRows([...db.listSources(), ...db.listActivePrivateSources()]);
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
    clearTimeout(initialTimer); clearInterval(timer);
    initialTimer = timer = schedulerRun = undefined;
    controller.abort(); generation++;
    controller = new AbortController();
    for (const job of queue.splice(0)) job.reject(error(503, 'Cosmic Web is stopping'));
    inflight.clear(); articleInflight.clear(); aiInflight.clear(); cooling.clear();
  }

  function enrichedDomains(userId, prefs) {
    const dbSources = new Map([...db.listSources(), ...db.listSources(userId)].map(s => [s.id, s]));
    const clusters = filtered(userId, {}, false);
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
    return BUILTIN_DOMAINS.map(d => {
      const domainSources = BUILTIN_SOURCES.filter(s => s.domainId === d.id).map(s => {
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
        isCustom: false,
        itemCount: counts.itemCount,
        unreadCount: counts.unreadCount,
        sources: domainSources,
      };
    });
  }

  return {
    bootstrap(userId, userRole) {
      const preferences = preferred(userId);
      swr(userId, preferences);
      const capableAgents = listCapableAgentsForUser(userId, userRole).map(a => ({ ...a, online: true, supportsBriefing: true }));
      const prefsPub = publicPrefs(preferences);
      const domains = enrichedDomains(userId, preferences);
      const graph = buildGraphProjection({ prefs: preferences, clusters: filtered(userId, {}, false), domains: BUILTIN_DOMAINS });
      return {
        domains,
        sources: [...BUILTIN_SOURCES, ...db.listSources(userId).map(sourceFromRow)],
        preferences: prefsPub,
        prefs: prefsPub,
        graph,
        agents: capableAgents,
        capableAgents,
        stats: stats(userId, preferences),
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
      return buildGraphProjection({ prefs, clusters: filtered(userId, query), domains: BUILTIN_DOMAINS });
    },
    cluster, article,
    aiBrief(userId, userRole, id, body = {}) {
      if (!object(body)) fail('Invalid briefing options');
      const c = cluster(userId, id);
      const mode = body.mode ?? 'brief';
      if (!['brief', 'synthesize'].includes(mode)) fail('Invalid briefing mode');
      const item = body.itemId == null ? c.items[0] : c.items.find(i => i.id === body.itemId);
      if (!item) throw error(404, 'Article not found');
      const cached = db.getArticleCache(userId, item.id, now());
      return ai(userId, userRole, mode, body, { headline: c.headline, sourceUrl: item.url,
        articleMarkdown: cached?.markdown?.slice(0, 12_000), quality: cached?.quality, sources: c.items.slice(0, 12) });
    },
    dailyBriefing(userId, userRole, body = {}) {
      const prefs = preferred(userId);
      const clusters = filtered(userId, {}, false).filter(c => c.publishedAt >= now() - 24 * 60 * minute).slice(0, 24);
      const domains = [...BUILTIN_DOMAINS, ...prefs.customDomains].filter(d => enabledIds(prefs).has(d.id));
      return ai(userId, userRole, 'daily_briefing', body, { date: new Date(now()).toISOString().slice(0, 10),
        domains: domains.map(({ id, nameZh, nameEn }) => ({ id, nameZh, nameEn, stories: clusters
          .filter(c => c.domainId === id || c.relatedDomains.includes(id)).slice(0, 8).map(storyContext) })) });
    },
    setClusterState(userId, id, patch) {
      if (!object(patch)) fail('Invalid cluster state');
      const unread = patch.unread ?? (typeof patch.read === 'boolean' ? !patch.read : undefined);
      const { bookmarked, muted } = patch;
      const fields = [unread, bookmarked, muted];
      if (fields.every(v => v === undefined) || fields.some(v => v !== undefined && typeof v !== 'boolean')) fail('Invalid cluster state');
      const state = db.saveUserClusterState(userId, id, { unread, bookmarked, muted }, now());
      if (!state) throw error(404, 'Cluster not found');
      return state;
    },
    markAllRead(userId, query) {
      const rows = filtered(userId, query, false).filter(c => c.unread);
      db.cosmicWebTransaction(() => { for (const c of rows) db.saveUserClusterState(userId, c.id, { unread: false }, now()); });
      return { updated: rows.length, stats: stats(userId, preferred(userId)) };
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
