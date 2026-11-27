import { resolveHttpUrl } from './rss-parser.js';
import { toProxyMediaUrl } from './media-proxy.js';

export const CLUSTER_WINDOW_MS = 48 * 60 * 60 * 1000;
export const CLUSTER_THRESHOLD = 0.42;
const stop = new Set('the an and for of to in is as at on by it a or from that with this are be was has have how what will 最新 今日 新闻 进行 有关 相关 一个 这个 我们 他们 以及 其中 什么 可以 发布'.split(' '));

export function canonicalizeUrl(value) {
  const valid = resolveHttpUrl(value);
  if (!valid) return null;
  const url = new URL(valid);
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.*|spm|from|ref|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return url.href;
}

export function extractTokens(title) {
  const tokens = new Set();
  const parts = String(title).normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]{2,}/gu) ?? [];
  for (const part of parts) {
    if (/^\p{Script=Han}/u.test(part)) {
      const chars = [...part];
      for (let i = 1; i < chars.length; i++) {
        const token = chars[i - 1] + chars[i];
        if (!stop.has(token)) tokens.add(token);
      }
    } else if (!stop.has(part)) tokens.add(part);
  }
  return [...tokens];
}

export function clusterSimilarity(a, b) {
  const left = new Set(a), right = new Set(b);
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap ? overlap / (left.size + right.size - overlap) : 0;
}

export function computeHeatScore({ itemCount, publishedAt, now = Date.now(), hasHotMetric }) {
  const hours = Math.max(0, now - publishedAt) / 3_600_000;
  return Number(((12 + 18 * Math.log2(Math.max(1, itemCount)) + (hasHotMetric ? 5 : 0)) * 2 ** (-hours / 24)).toFixed(4));
}

export function buildGraphProjection({ prefs = {}, clusters, domains, userStates = {}, userId = null, now = Date.now() }) {
  const enabled = new Set(prefs.enabledDomainIds ?? prefs.enabledDomains ?? domains.filter(d => d.defaultEnabled).map(d => d.id));
  const custom = new Set((prefs.customDomains ?? []).filter(d => d.enabled !== false).map(d => d.id));
  const active = new Map([...domains, ...(prefs.customDomains ?? [])].filter(d => enabled.has(d.id) || custom.has(d.id)).map(d => [d.id, d]));
  const hubs = [...active.values()].map(d => ({ ...d, domainId: d.id, id: `hub:${d.id}` }));
  const buckets = new Map([...active.keys()].map(id => [id, []]));
  const rank = (a, b) => Number(!!b.watchHit) - Number(!!a.watchHit) || b.heatScore - a.heatScore || b.publishedAt - a.publishedAt || a.id.localeCompare(b.id);
  for (const c of [...clusters].sort(rank)) {
    const primary = [c.domainId, ...(c.relatedDomains ?? [])].find(id => active.has(id));
    if (primary) buckets.get(primary).push({ c, primary });
  }
  const selected = [];
  for (let i = 0; selected.length < 180; i++) {
    const before = selected.length;
    for (const bucket of buckets.values()) {
      if (bucket[i]) selected.push(bucket[i]);
      if (selected.length === 180) break;
    }
    if (before === selected.length) break;
  }
  const tier = new Map([...selected].sort((a, b) => rank(a.c, b.c)).map(({ c }, i) => [c.id, i < 14 ? 1 : i < 80 ? 2 : 3]));
  const nodes = [], edges = [];
  function edge(node, domainId, kind) {
    edges.push({ id: `${node.id}->hub:${domainId}`, source: node.id, target: `hub:${domainId}`, kind });
  }
  for (const { c, primary } of selected) {
    const state = userStates instanceof Map ? userStates.get(c.id) : userStates[c.id];
    const media = (c.items ?? []).flatMap(item => item.media ?? []).find(m => toProxyMediaUrl(m.url, userId, now));
    const node = { id: `cluster:${c.id}`, clusterId: c.id, domainId: primary, headline: c.headline,
      colorToken: active.get(primary).colorToken, heatScore: c.heatScore, itemCount: c.itemCount ?? c.items?.length ?? 0,
      lodTier: tier.get(c.id), summaryExcerpt: String(c.summaryExcerpt ?? '').trim().slice(0, 180).trimEnd(),
      mediaPreview: media ? { proxyUrl: toProxyMediaUrl(media.url, userId, now), kind: media.kind === 'gif' ? 'gif' : 'image' } : null,
      unread: state?.unread ?? c.unread ?? true, bookmarked: state?.bookmarked ?? c.bookmarked ?? false,
      watchHit: c.watchHit ?? false, publishedAt: c.publishedAt, sourceNames: c.sourceNames ?? [] };
    nodes.push(node);
    edge(node, primary, 'domain');
    const related = new Set([c.domainId, ...(c.relatedDomains ?? [])]);
    const linked = [];
    for (const other of selected) {
      if (other.c.id === c.id) continue;
      const similarity = clusterSimilarity(c.keywords ?? [], other.c.keywords ?? []);
      if (similarity >= CLUSTER_THRESHOLD) {
        linked.push({ c: other.c, similarity });
        if (other.primary !== primary) related.add(other.primary);
      }
    }
    node.relatedClusterIds = linked.sort((a, b) => b.similarity - a.similarity || rank(a.c, b.c)).slice(0, 4).map(entry => entry.c.id);
    for (const id of related) if (id !== primary && active.has(id)) edge(node, id, 'cross');
  }
  return { hubs, nodes, edges };
}
