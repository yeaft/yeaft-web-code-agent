import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../server/db/cosmic-web-db.js';
import { safeFetch, validateExternalUrl } from '../../server/cosmic-web/safe-fetch.js';
import { createMediaProxy, toProxyMediaUrl } from '../../server/cosmic-web/media-proxy.js';
import { extractCommunityEnrichment } from '../../server/cosmic-web/community-extractor.js';
import { parseFeedXml, resolveHttpUrl } from '../../server/cosmic-web/rss-parser.js';
import { extractCleanArticle } from '../../server/cosmic-web/article-extractor.js';
import { BUILTIN_DOMAINS, BUILTIN_SOURCES } from '../../server/cosmic-web/catalog.js';
import { fetchSource } from '../../server/cosmic-web/sources.js';
import { buildGraphProjection, canonicalizeUrl, clusterSimilarity, computeHeatScore, extractTokens } from '../../server/cosmic-web/clusterer.js';
import { createCosmicWebService, ingestCosmicWebItems, startCosmicWebScheduler, stopCosmicWebScheduler } from '../../server/cosmic-web/service.js';
import { clearAllCosmicWebAiRequests, clearCosmicWebAiRequestsForAgent, handleCosmicWebAiResponse,
  listCapableAgentsForUser, requestCosmicWebAi, validateCosmicWebAiResult } from '../../server/cosmic-web/ai-bridge.js';
import * as encryption from '../../server/encryption.js';
import { agents, webClients } from '../../server/context.js';
vi.mock('../../server/config.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, CONFIG: { ...actual.CONFIG, skipAuth: false } };
});
import { registerCosmicWebRoutes } from '../../server/routes/cosmic-web-routes.js';

// Keep the actual account database isolated too, so deletion exercises real transactions.
vi.hoisted(() => {
  delete process.env.SERVER_DATA_DIR;
  process.env.TEST_DB_PATH = ':memory:';
});
import { userDb } from '../../server/db/user-db.js';
import { runCosmicWebBriefing } from '../../agent/yeaft/cosmic-web-briefing.js';

vi.mock('../../server/database.js', () => ({
  userDb: { getByUsername: name => ['alice', 'bob'].includes(name) ? { id: name, role: 'user' } : undefined },
  sessionDb: {}, yeaftProjectDb: {}, yeaftSessionDb: {}, sessionUiMetadataDb: {},
}));

const { marked } = runInNewContext(readFileSync(new URL('../../web/vendor/marked.min.js', import.meta.url), 'utf8') + ';globalThis');

const NOW = Date.parse('2026-11-27T12:00:00Z');
const HOUR = 3_600_000;
const dns = async () => [{ address: '93.184.216.34', family: 4 }];
const storyResult = { tldr: 'A model was released.', bullets: ['One', 'Two', 'Three'], impact: 'New options.',
  followUps: ['Which licence?', 'What results?'], fullMarkdown: '# Release\n\nA new model.' };
const dailyResult = { headline: 'Daily Brief', overview: 'New releases.', sections: [{ domain: 'AI', bullets: ['One'] }],
  signalsToWatch: [], followUps: [], fullMarkdown: '# Daily Brief' };
const story = `<article><h1>Model release</h1><nav>Hidden navigation</nav><script>secret()</script><style>.secret{}</style>
  <footer>Hidden footer</footer><div class="ad-banner">Advertisement</div><p>${'New AI benchmarks &amp; model results. '.repeat(8)}
  <strong>Important</strong> <em>details</em> <a href="/report">report</a> <a href="javascript:alert(1)">not clickable</a></p>
  <ol><li>First</li><li>Second</li></ol><blockquote>Research team</blockquote><pre><code>if (a &lt; 2) {\n  return 1;\n}</code></pre></article>`;
const rss = `<rss version="2.0"><channel><item><title>中国 AI &amp; Models</title><link>/news?utm_source=rss&amp;x=1</link>
  <pubDate>Fri, 27 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[<p>你好 &amp; English &#x1F680;</p><script>remove()</script>]]></description></item></channel></rss>`;
const response = (text, url, status = 200) => ({ status, url, headers: {}, text: () => text, json: () => JSON.parse(text) });
const source = (id = 'fixture', domainId = 'ai', ownerUserId = null) => ({ id, domainId, ownerUserId, name: id, url: 'https://example.com/feed', kind: 'rss' });
const item = (title, url = 'https://example.com/article', publishedAt = NOW) => ({ title, url, publishedAt, summaryExcerpt: 'Localized 中文摘要' });
let dir, service;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-vitest-'));
  db.resetCosmicWebDbForTest(join(dir, 'cosmic-web.db'));
});
afterEach(() => {
  service?.stopScheduler(); service = undefined;
  stopCosmicWebScheduler(); clearAllCosmicWebAiRequests(); agents.clear(); webClients.clear();
  db.closeCosmicWebDb(); rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

function transport(fn) {
  return vi.fn((url, options, cb) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => cb(fn(url, options)));
    return req;
  });
}
function stream(parts, headers = {}, statusCode = 200) { return Object.assign(Readable.from(parts), { headers, statusCode }); }
function makeService(options = {}) { return service = createCosmicWebService({ now: () => NOW, dnsLookup: dns, autoRefresh: () => false, isUserActive: () => true, ...options }); }
function agent(id, ownerId, caps = ['cosmic_web_briefing', 'cosmic_web_research', 'cosmic_web_follow_up', 'cosmic_web_radar']) {
  const frames = [];
  agents.set(id, { ownerId, name: id, capabilities: caps, encryptOutbound: false, ws: { readyState: 1, send: value => frames.push(JSON.parse(value)) } });
  return frames;
}

describe('safe outbound fetch', () => {
  it.each(['http://127.0.0.1', 'http://2130706433', 'http://10.0.0.1', 'http://169.254.169.254', 'http://100.64.0.1',
    'http://0.0.0.0', 'http://224.0.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fe80::1]',
    'http://[fd00::1]', 'http://[ff01::1]', 'file:///tmp/secret', 'https://x:secret@example.com'])('rejects %s before opening a socket', async url => {
    const requestImpl = vi.fn();
    await expect(safeFetch(url, { requestImpl })).rejects.toThrow();
    expect(requestImpl).not.toHaveBeenCalled();
  });
  it('rejects mixed DNS answers and pins a public answer with original TLS SNI', async () => {
    await expect(validateExternalUrl('https://example.com', { dnsLookup: async () => [...await dns(), { address: '192.168.1.3' }] })).rejects.toThrow('private');
    const lookup = vi.fn(dns);
    const requestImpl = transport((url, opts) => {
      expect(url.hostname).toBe('example.com'); expect(opts.servername).toBe('example.com'); expect(opts.agent).toBe(false);
      const cb = vi.fn(); opts.lookup(url.hostname, { all: true }, cb);
      expect(cb).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
      return stream([Buffer.from('{"value":1}')]);
    });
    const res = await safeFetch('https://example.com', { requestImpl, dnsLookup: lookup });
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true });
    expect(res.json()).toEqual({ value: 1 });
  });
  it('revalidates redirect targets and never contacts an invalid target', async () => {
    const requestImpl = transport(() => stream([], { location: 'http://127.0.0.1/' }, 302));
    await expect(safeFetch('https://example.com', { requestImpl, dnsLookup: dns })).rejects.toThrow('private');
    expect(requestImpl).toHaveBeenCalledTimes(1);
    const loop = transport(() => stream([], { location: '/loop' }, 301));
    await expect(safeFetch('https://example.com', { requestImpl: loop, dnsLookup: dns })).rejects.toThrow('redirect limit');
    expect(loop).toHaveBeenCalledTimes(6);
  });
  it.each([['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]])('bounds %s decompression and wire bytes', async (coding, zip) => {
    const requestImpl = transport(() => stream([zip('x'.repeat(300))], { 'content-encoding': coding }));
    const opts = { requestImpl, dnsLookup: dns };
    expect((await safeFetch('https://example.com', opts)).text()).toHaveLength(300);
    await expect(safeFetch('https://example.com', { ...opts, maxDecompressedBytes: 50 })).rejects.toThrow();
    await expect(safeFetch('https://example.com', { ...opts, maxBytes: 3 })).rejects.toThrow('byte limit');
  });
  it('cancels a pending body read and bounds a stuck DNS lookup', async () => {
    const abort = new AbortController();
    const body = Object.assign(new PassThrough(), { headers: {}, statusCode: 200 });
    const read = safeFetch('https://example.com', { requestImpl: transport(() => body), dnsLookup: dns, signal: abort.signal });
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve)); abort.abort(); await rejected;
    expect(body.destroyed).toBe(true);
    await expect(validateExternalUrl('https://example.com', { timeoutMs: 5, dnsLookup: () => new Promise(() => {}) })).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('feed parsing and source adapters', () => {
  it('parses RSS, Atom and RDF without interpreting XML directives', () => {
    expect(parseFeedXml(rss, 'https://example.com/feed')).toEqual([{ title: '中国 AI & Models', url: 'https://example.com/news?utm_source=rss&x=1',
      publishedAt: NOW - 3 * HOUR, summaryExcerpt: '你好 & English 🚀', media: [] }]);
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://atom.example/">
      <entry><title>测试 &quot;English&quot;</title><link rel="self" href="internal"/><link rel="alternate" href="story"/>
      <updated>2026-11-27T20:00:00+08:00</updated><summary type="html">&lt;b&gt;概要&lt;/b&gt; &amp; news</summary></entry></feed>`;
    expect(parseFeedXml(atom, 'https://example.com')[0]).toEqual({ title: '测试 "English"', url: 'https://atom.example/story', publishedAt: NOW, summaryExcerpt: '概要 & news', media: [] });
    expect(parseFeedXml('<rdf:RDF><item><title>A</title><link>https://example.com/</link><dc:date>2026-11-27T12:00:00Z</dc:date></item></rdf:RDF>')[0].publishedAt).toBe(NOW);
    expect(parseFeedXml('<feed><entry><title>X</title><link href="javascript:alert(1)"/></entry></feed>')).toEqual([]);
  });
  it('ignores a 50,000-character xml:base for a feed with 400 relative links', () => {
    const prefix = 'https://oversized.example/';
    const oversized = prefix.padEnd(49_999, 'x') + '/';
    const links = Array.from({ length: 400 }, (_, i) => `<item><title>Story ${i}</title><link>story-${i}</link></item>`).join('');
    const xml = `<rss xml:base="https://example.com/news/"><channel xml:base="${oversized}">${links}</channel></rss>`;
    const start = performance.now();
    const items = parseFeedXml(xml, 'https://origin.example/feed');
    expect(performance.now() - start).toBeLessThan(100);
    // The normal result cap still applies; all returned links inherit the short parent base.
    expect(items.map(({ url }) => url)).toEqual(Array.from({ length: 200 }, (_, i) => `https://example.com/news/story-${i}`));
  });
  it('bounds raw references, raw xml:base and serialized URL length', () => {
    const base = 'https://example.com/';
    const overlongRef = ' '.repeat(4096) + 'story';
    const encodedRef = 'é'.repeat(680);
    const encodedBase = '&#120;'.repeat(700) + '/'; // short after entity decoding, too long on the wire
    expect(resolveHttpUrl(overlongRef, base)).toBeNull();
    expect(resolveHttpUrl(encodedRef, base)).toBeNull();
    expect(resolveHttpUrl(base.padEnd(4096, 'x'))).toHaveLength(4096);
    const xml = `<feed xml:base="${encodedBase}"><entry><title>Story</title><link href="${overlongRef}"/><link>${encodedRef}</link><link>story</link></entry></feed>`;
    expect(parseFeedXml(xml, base)).toMatchObject([{ url: `${base}story` }]);
  });
  it('bounds long unassigned attributes and repeated unterminated tag starts in both parsers', () => {
    const unassigned = 'a'.repeat(50_000);
    const unfinished = '<entry '.repeat(8_000) + '"unterminated';
    const start = performance.now();
    expect(parseFeedXml(`<feed><entry ${unassigned}><title>A</title><link href="https://example.com/"/></entry>${unfinished}`))
      .toMatchObject([{ title: 'A', url: 'https://example.com/' }]);
    expect(extractCleanArticle(`<main ${unassigned}><script>if (a < b) {}</script><p>Visible</p></main>${unfinished}`, 'https://example.com').markdown)
      .toBe('Visible');
    expect(performance.now() - start).toBeLessThan(100);
  });
  it('normalizes fetched feed, signed CLS and embedded Baidu data', async () => {
    expect(new Set(BUILTIN_SOURCES.map(s => s.id)).size).toBe(51);
    const fetcher = vi.fn(async url => {
      if (url.includes('cls.cn')) {
        const p = new URL(url).searchParams;
        expect(p.get('sign')).toBe('19867da3c25cbadb83e3657c5045892a');
        return response(JSON.stringify({ data: { roll_data: [{ id: 1, title: '电报', ctime: NOW / 1000 }, { id: 2, title: 'Ad', is_ad: 1 }] } }), url);
      }
      if (url.includes('baidu.com')) return response('<!--s-data:{"data":{"cards":[{"content":[{"word":"新闻","rawUrl":"https://top.baidu.com/board?utm_source=t"}]}]}}-->', url);
      return response(rss, url);
    });
    expect((await fetchSource('aihot', { fetcher, now: NOW }))[0]).toMatchObject({ url: 'https://aihot.news/news?x=1', publishedAt: NOW - 3 * HOUR });
    expect((await fetchSource('cls-telegraph', { fetcher, now: NOW }))[0]).toMatchObject({ title: '电报', publishedAt: NOW });
    expect((await fetchSource('baidu', { fetcher, now: NOW }))[0]).toMatchObject({ title: '新闻', url: 'https://top.baidu.com/board', hasHotMetric: true });
  });
});

describe('clean article', () => {
  it('selects article content, removes noisy tags and generates Markdown', () => {
    const result = extractCleanArticle(story, 'https://example.com/post');
    expect(result).toMatchObject({ quality: 'full', title: 'Model release' });
    expect(result.markdown).toContain('**Important** *details* [report](<https://example.com/report>)');
    expect(result.markdown).toContain('1. First\n2. Second'); expect(result.markdown).toContain('> Research team');
    expect(result.markdown).toContain('```\nif (a < 2)'); expect(result.markdown).not.toMatch(/secret|Hidden|Advertisement|javascript:/);
    expect(extractCleanArticle(`<main>${'text '.repeat(9000)}</main>`, 'https://example.com').markdown).toHaveLength(40_000);
  });
  it.each(['https://s.weibo.com/foo', 'https://top.baidu.com/board', 'https://search.bilibili.com/all', 'https://www.toutiao.com/trending/1'])('recognizes search-only %s', url => {
    expect(extractCleanArticle(story, url).quality).toBe('search_only');
  });
  it('differentiates short previews and login walls', () => {
    expect(extractCleanArticle('<p>Short teaser</p>', 'https://example.com').quality).toBe('partial');
    expect(extractCleanArticle('<title>Login</title><p>Please sign in to read</p>', 'https://example.com').quality).toBe('blocked');
  });
});

describe('clustering, isolation and retention', () => {
  it('merges recent same-scope stories, ranks by heat and matches Chinese/English across items', async () => {
    const svc = makeService();
    expect(canonicalizeUrl('https://EXAMPLE.com/news/?z=2&SPM=1&utm_medium=x&from=top#top')).toBe('https://example.com/news?z=2');
    expect(clusterSimilarity(extractTokens('The AI 2026 中国模型'), extractTokens('AI 2026 中国模型'))).toBe(1);
    expect(computeHeatScore({ itemCount: 3, publishedAt: NOW, now: NOW, hasHotMetric: true })).toBeGreaterThan(computeHeatScore({ itemCount: 1, publishedAt: NOW - HOUR, now: NOW }));
    const first = item('中国模型突破 Open Source', 'https://example.com/one', NOW - HOUR);
    ingestCosmicWebItems(source('wire', 'ai'), [first], NOW);
    ingestCosmicWebItems(source('repo', 'tech'), [item('中国模型突破 Open Source 发布详情', 'https://example.com/two')], NOW);
    expect(ingestCosmicWebItems(source('wire', 'ai'), [first], NOW)).toBe(0);
    ingestCosmicWebItems(source('old', 'world'), [item(first.title, 'https://example.com/old', NOW - 49 * HOUR)], NOW);
    await svc.savePreferences('alice', { watchKeywords: ['突破'], customDomains: [{ id: 'models', name: '模型', keywords: ['发布详情'] }] });
    const found = svc.feed('alice', { q: '发布详情', watch: true, domain: 'models' }).clusters;
    expect(found).toHaveLength(1); expect(found[0]).toMatchObject({ watchHit: true, itemCount: 2 });
    expect(svc.feed('alice', { q: 'OPEN SOURCE' }).total).toBe(1);
    expect(svc.feed('alice', { q: '文摘要' }).total).toBe(1);
    expect(db.listVisibleClusters('alice')).toHaveLength(2);
    expect(svc.graph('alice').edges.map(e => e.kind)).toEqual(['domain', 'cross', 'cross']);
    await svc.savePreferences('alice', { muteKeywords: ['中国模型'] });
    expect(svc.feed('alice').total).toBe(0); expect(svc.feed('bob').total).toBe(1);
  });
  it('balances graph hubs and adds cross-edges for shared keywords', () => {
    const common = { headline: 'Story', itemCount: 1, publishedAt: NOW, keywords: ['common'] };
    const clusters = [...Array.from({ length: 190 }, (_, i) => ({ ...common, id: `${i}`, domainId: 'ai', heatScore: i + 3 })),
      { ...common, id: 'tech', domainId: 'tech', heatScore: 1 }, { ...common, id: 'hot', domainId: 'hot', heatScore: 100 }];
    const graph = buildGraphProjection({ prefs: { enabledDomainIds: ['ai', 'tech'] }, clusters, domains: BUILTIN_DOMAINS });
    expect(graph.hubs.map(h => h.domainId)).toEqual(['ai', 'tech']); expect(graph.nodes).toHaveLength(180);
    expect(graph.nodes[1].id).toBe('cluster:tech'); expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'cross', target: 'hub:tech' }));
  });
  it('refreshes private RSS only for its owner, isolates same-story state and disallows cross-scope writes', async () => {
    const mockFetch = vi.fn(async url => response(rss, url));
    const svc = makeService({ fetcher: mockFetch });
    await svc.savePreferences('alice', { enabledDomainIds: [], customDomains: [{ id: 'mine', name: 'Private', rssUrls: ['https://example.com/feed'] }] });
    await svc.savePreferences('bob', { enabledDomainIds: [], customDomains: [{ id: 'mine', name: 'Same id' }] });
    expect((await svc.refresh('alice')).added).toBe(1); expect((await svc.refresh('bob')).added).toBe(0);
    const id = svc.feed('alice').clusters[0].id;
    const itemId = db.listVisibleItems('alice', [id])[0].id;
    expect(svc.feed('bob').total).toBe(0); await expect(svc.cluster('bob', id)).rejects.toThrow('Cluster not found');
    expect(() => svc.setClusterState('bob', id, { bookmarked: true })).toThrow('Cluster not found');
    await expect(svc.article('bob', id, itemId)).rejects.toThrow('Cluster not found');
    expect(svc.setClusterState('alice', id, { bookmarked: true, unread: false })).toEqual({ bookmarked: true, unread: false, muted: false });
    db.setArticleCache('alice', itemId, { markdown: 'private' }, NOW + 1);
    expect(db.getArticleCache('bob', itemId, NOW)).toBeNull();
    db.setAiCache('alice', 'same-key', storyResult, NOW + 1);
    expect(db.getAiCache('bob', 'same-key', NOW)).toBeNull();
    expect(svc.bootstrap('bob').sources.every(s => !s.ownerUserId)).toBe(true);
    expect(svc.getPreferences('bob').customDomains[0].rssUrls).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(() => db.insertItem({ ...item('Invalid scope'), id: 'rogue', clusterId: id, sourceId: 'aihot', domainId: 'ai' })).toThrow('FOREIGN KEY');
  });
  it('opens isolated WAL SQLite and prunes old unbookmarked records and expired caches', () => {
    expect(db.resolveCosmicWebDbPath({ TEST_DB_PATH: `${dir}/other.db` })).toBe(`${dir}/other.db.cosmic-web.db`);
    expect(db.resolveCosmicWebDbPath({ TEST_DB_PATH: `${dir}/another.db` })).toBe(`${dir}/another.db.cosmic-web.db`);
    expect(db.resolveCosmicWebDbPath({ TEST_DB_PATH: ':memory:' })).toBe(':memory:');
    expect(db.resolveCosmicWebDbPath({ TEST_DB_DIR: dir, TEST_DB_PATH: ':memory:' })).toBe(':memory:');
    expect(db.resolveCosmicWebDbPath({ TEST_DB_DIR: 'ignored', TEST_DB_PATH: join(dir, 'main.db') })).toBe(join(dir, 'main.db.cosmic-web.db'));
    expect(db.resolveCosmicWebDbPath({ TEST_DB_DIR: dir })).toBe(join(dir, 'cosmic-web.db'));
    expect(db.resolveCosmicWebDbPath({ COSMIC_WEB_DB_PATH: 'custom.db', SERVER_DATA_DIR: dir })).toBe('custom.db');
    expect(db.resolveCosmicWebDbPath({ SERVER_DATA_DIR: 'server-data', TEST_DB_PATH: ':memory:', TEST_DB_DIR: 'test-data' })).toBe(join('server-data', 'cosmic-web.db'));
    expect(db.getCosmicWebDb().prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(db.getCosmicWebDb().prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    ingestCosmicWebItems(source(), [item('Bookmark'), item('Old item', 'https://example.com/stale')], NOW);
    ingestCosmicWebItems(source('private-old-feed', 'mine', 'alice'), [item('Private stale')], NOW);
    const id = db.listVisibleClusters('alice').find(c => c.headline === 'Bookmark').id;
    db.saveUserClusterState('alice', id, { bookmarked: true }, NOW);
    const itemId = db.listVisibleItems('alice', [id])[0].id;
    db.setArticleCache('alice', itemId, {}, NOW + 1); db.setAiCache('alice', 'old', {}, NOW + 1);
    expect(db.pruneCosmicWebDb(NOW + db.RETENTION_MS + 1)).toEqual({ items: 2, clusters: 2, articles: 1, ai: 1, enrichment: 0 });
    expect(db.listVisibleItems('bob', [id])).toHaveLength(1);
    expect(db.listUserClusterStates('bob').has(id)).toBe(false);
    db.closeCosmicWebDb(); db.closeCosmicWebDb();
  });
});

describe('AI bridge', () => {
  const ask = (userId = 'alice', agentId = 'allowed', userRole = 'user') => requestCosmicWebAi({ userId, userRole, agentId, mode: 'brief', perspective: 'balanced' });
  it('requires owner and capability, and consumes only the original Agent/request pair once', async () => {
    const requests = agent('allowed', 'alice'); agent('foreign', 'bob'); agent('old', 'alice', []); agent('unowned', null);
    expect(listCapableAgentsForUser('alice', 'user').map(a => a.id)).toEqual(['allowed']);
    expect(listCapableAgentsForUser('alice', 'admin').map(a => a.id)).toEqual(['allowed', 'unowned']);
    await expect(ask('alice', 'foreign', 'admin')).rejects.toMatchObject({ status: 403 });
    await expect(ask('alice', 'old')).rejects.toMatchObject({ status: 409 });
    const pending = ask();
    const msg = { type: 'cosmic_web_ai_response', requestId: requests[0].requestId, ok: true, result: storyResult };
    expect(handleCosmicWebAiResponse('foreign', msg)).toBe(false);
    expect(handleCosmicWebAiResponse('allowed', { ...msg, requestId: 'wrong' })).toBe(false);
    expect(handleCosmicWebAiResponse('allowed', msg)).toBe(true); expect(handleCosmicWebAiResponse('allowed', msg)).toBe(false);
    await expect(pending).resolves.toEqual(storyResult);
    const invalid = expect(ask()).rejects.toMatchObject({ status: 502 });
    handleCosmicWebAiResponse('allowed', { ...msg, requestId: requests[1].requestId, result: { tldr: 'missing fields' } });
    await invalid;
  });
  it('clears only the superseded connection and rejects stale replies', async () => {
    const previousFrames = agent('allowed', 'alice');
    const previous = agents.get('allowed');
    const dropped = expect(ask()).rejects.toMatchObject({ status: 503 });
    const currentFrames = agent('allowed', 'alice');
    const live = ask();
    clearCosmicWebAiRequestsForAgent('allowed', previous);
    await dropped;
    expect(handleCosmicWebAiResponse('allowed', { requestId: previousFrames[0].requestId, ok: true, result: storyResult })).toBe(false);
    expect(handleCosmicWebAiResponse('allowed', { requestId: currentFrames[0].requestId, ok: true, result: storyResult })).toBe(true);
    await expect(live).resolves.toEqual(storyResult);
  });
  it.each(['ftp://files.example.com/a', 'ftps://files.example.com/a', 'x+v1.test://host/a', 'https://example.com',
    'www.example.com', 'mailto:a@b.com', 'user@example.com', 'awww.example.com', 'user@host.1', '<a@b.com>',
    '[news](/news)', '![image](/photo.png)', '[news][ref]\n\n[ref]: /news', '\\\\[news](/news)'])
    ('rejects unsafe Markdown (%s) but accepts the link-free Agent fallback', async fullMarkdown => {
      const frames = agent('allowed', 'alice');
      const request = () => requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'allowed', mode: 'daily_briefing' });
      const respond = result => handleCosmicWebAiResponse('allowed', { requestId: frames.at(-1).requestId, ok: true, result });
      const rejected = expect(request()).rejects.toMatchObject({ status: 502 });
      respond({ ...dailyResult, fullMarkdown });
      await rejected;
      const { result } = await runCosmicWebBriefing({ mode: 'daily_briefing', language: 'en', config: { decisionModel: 'test/decision' },
        adapter: { call: async () => ({ text: JSON.stringify({ ...dailyResult, fullMarkdown,
          headline: 'News from HTTPS://example.com', sections: [{ domain: 'AI', bullets: [fullMarkdown] }] }) }) } });
      expect(result.fullMarkdown).not.toBe(fullMarkdown);
      const activeTokens = [];
      marked.walkTokens(marked.lexer(result.fullMarkdown, { gfm: true }), token => {
        if (['link', 'image', 'html'].includes(token.type)) activeTokens.push(token);
      });
      expect(activeTokens).toHaveLength(0);
      const accepted = request();
      expect(respond(result)).toBe(true);
      await expect(accepted).resolves.toEqual(result);
    });
  it.each(['abort', 'clear', 'replace', 'close'])('does not send after %s while encryption is pending', async action => {
    let finishEncryption;
    const encrypt = vi.spyOn(encryption, 'encrypt').mockImplementation(() => new Promise(resolve => { finishEncryption = resolve; }));
    const frames = agent('allowed', 'alice');
    const connection = agents.get('allowed');
    connection.encryptOutbound = true;
    connection.sessionKey = new Uint8Array(32);
    const controller = new AbortController();
    const pending = expect(requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'allowed', mode: 'brief', signal: controller.signal }))
      .rejects.toMatchObject({ status: 503 });
    expect(encrypt).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(0);
    let replacementFrames;
    if (action === 'abort') controller.abort();
    if (action === 'clear') clearCosmicWebAiRequestsForAgent('allowed', connection);
    if (action === 'replace') replacementFrames = agent('allowed', 'alice');
    if (action === 'close') connection.ws.readyState = 3;
    finishEncryption({ n: 'nonce', c: 'ciphertext' });
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    expect(frames).toHaveLength(0);
    if (replacementFrames) expect(replacementFrames).toHaveLength(0);
  });
  it('limits concurrency and rate, times out and clears on disconnect', async () => {
    vi.useFakeTimers(); const requests = agent('allowed', 'alice');
    const timeout = expect(ask()).rejects.toMatchObject({ status: 504 });
    const disconnect = expect(ask()).rejects.toMatchObject({ status: 504 });
    await expect(ask()).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(45_000); await timeout;
    // Both initial requests expired together. Use a fresh request for disconnect cleanup.
    await disconnect;
    const dropped = expect(ask()).rejects.toMatchObject({ status: 503 });
    clearCosmicWebAiRequestsForAgent('allowed'); await dropped;
    for (let i = 0; i < 17; i++) {
      const pending = ask();
      handleCosmicWebAiResponse('allowed', { requestId: requests.at(-1).requestId, ok: true, result: storyResult });
      await pending;
    }
    await expect(ask()).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(600_001);
    const pending = ask(); handleCosmicWebAiResponse('allowed', { requestId: requests.at(-1).requestId, ok: true, result: storyResult });
    await expect(pending).resolves.toEqual(storyResult);
  });
});

describe('REST and scheduler', () => {
  it('authenticates all routes, persists preferences and state, and caches articles and AI by user', async () => {
    const calls = [];
    for (const name of ['alice', 'bob']) {
      const a = `${name}-agent`;
      agent(a, name);
      agents.get(a).ws.send = data => {
        const req = JSON.parse(data); calls.push(req);
        queueMicrotask(() => handleCosmicWebAiResponse(a, { requestId: req.requestId, ok: true, result: req.mode === 'daily_briefing' ? dailyResult : storyResult }));
      };
    }
    const fetcher = vi.fn(async url => response(story, url));
    const svc = makeService({ fetcher });
    const app = express(); app.use(express.json());
    registerCosmicWebRoutes(app, { cosmicWeb: svc, requireSessionAuth(req, res, next) {
      const username = req.get('x-test-user');
      if (!username) return res.sendStatus(401);
      req.user = { username, role: 'user' }; next();
    } });
    ingestCosmicWebItems(source(), [item('中国模型 Open Source')], NOW);
    const { id } = svc.feed('alice').clusters[0];
    const base = '/api/cosmic-web'; const request = supertest(app);
    const authed = (method, path, user = 'alice') => request[method](base + path).set('x-test-user', user);
    const cluster = `/clusters/${id}`;
    const paths = [['get', '/bootstrap'], ['get', '/feed'], ['get', '/graph'], ['get', cluster], ['get', `${cluster}/article`],
      ['post', `${cluster}/ai-brief`], ['post', '/daily-briefing'], ['patch', `${cluster}/state`], ['post', '/mark-all-read'],
      ['get', '/preferences'], ['put', '/preferences'], ['post', '/refresh']];
    for (const [method, path] of paths) await request[method](base + path).expect(401);
    await authed('get', '/feed', 'unknown').expect(401);
    const boot = await authed('get', '/bootstrap').expect('Cache-Control', 'private, no-store').expect(200);
    expect(boot.body.domains).toHaveLength(9); expect(boot.body.agents.map(a => a.id)).toEqual(['alice-agent']);
    expect((await authed('get', `/feed?q=${encodeURIComponent('中国')}`).expect(200)).body.clusters[0].id).toBe(id);
    expect((await authed('get', '/graph').expect(200)).body.nodes[0].clusterId).toBe(id);
    const saved = await authed('put', '/preferences').send({ userId: 'bob', watchKeywords: ['模型'] }).expect(200);
    expect(saved.body).toMatchObject({ preferences: { watchKeywords: ['模型'] }, domains: expect.any(Array), graph: expect.any(Object), stats: { watchHitCount: 1 } });
    expect((await authed('get', '/preferences?userId=bob').expect(200)).body.watchKeywords).toEqual(['模型']);
    expect((await authed('get', '/preferences', 'bob').expect(200)).body.watchKeywords).toEqual([]);
    await authed('put', '/preferences').send({ customDomains: [{ name: 'Blocked', rssUrls: ['http://127.0.0.1/news'] }] }).expect(400);
    await authed('patch', `${cluster}/state`).send({ unread: false, bookmarked: true }).expect(200);
    expect((await authed('get', cluster, 'bob').expect(200)).body).toMatchObject({ unread: true, bookmarked: false });
    expect((await authed('post', '/mark-all-read', 'bob').expect(200)).body.updated).toBe(1);
    expect((await authed('get', `${cluster}/article`).expect(200)).body.quality).toBe('full');
    await authed('get', `${cluster}/article`).expect(200);
    await authed('get', `${cluster}/article?url=https%3A%2F%2Fother.example%2F`).expect(404);
    expect(fetcher.mock.calls.filter(([u]) => u === 'https://example.com/article').length).toBeGreaterThanOrEqual(1);
    const brief = () => authed('post', `${cluster}/ai-brief`).send({ perspective: 'engineering' }).expect(200);
    expect((await brief()).body.cached).toBe(false); expect((await brief()).body.cached).toBe(true);
    expect(calls).toHaveLength(1); expect(calls[0].payload.articleMarkdown).toContain('Important');
    expect((await authed('post', `${cluster}/ai-brief`, 'bob').send({ perspective: 'engineering' }).expect(200)).body.cached).toBe(false);
    await authed('post', '/daily-briefing').send({}).expect(200);
    expect(calls.at(-1).payload.domains[0].stories[0].headline).toBe('中国模型 Open Source');
    const refreshed = await authed('post', '/refresh').expect(200);
    expect(refreshed.body).toMatchObject({ domains: expect.any(Array), stats: expect.any(Object) });
    await authed('post', '/refresh').expect(429);
  });
  it('does not block on a cold article, uses cached Markdown and isolates explicit Agent caches', async () => {
    const pending = [];
    const fetcher = vi.fn(url => new Promise(resolve => pending.push(() => resolve(response(story, url)))));
    const requestAi = vi.fn(async () => storyResult);
    const svc = makeService({ fetcher, requestAi });
    agent('first', 'alice'); agent('second', 'alice');
    await svc.savePreferences('alice', { preferredAgentId: 'offline' });
    const url = 'https://example.com/selected';
    ingestCosmicWebItems(source(), [item('Same story', url)], NOW);
    const { id } = svc.feed('alice').clusters[0];
    const selected = db.listVisibleItems('alice', [id])[0];
    await expect(svc.aiBrief('alice', 'user', id, { url: `${url}/` })).rejects.toMatchObject({ status: 404 });
    await expect(svc.aiBrief('alice', 'user', id, { agentId: 'offline' })).rejects.toMatchObject({ status: 403 });
    await svc.aiBrief('alice', 'user', id, { url, skipArticleFetch: true, research: false });
    expect(fetcher).not.toHaveBeenCalled();
    expect(requestAi.mock.lastCall[0].payload).toMatchObject({ sourceUrl: url, articleMarkdown: undefined, research: false });
    await expect(svc.aiBrief('alice', 'user', id, { itemId: selected.id, language: 'en' })).resolves.toMatchObject({ agentId: 'first', cached: false });
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toBeUndefined();
    const article = svc.article('alice', id, { url });
    expect(pending).toHaveLength(2);
    pending.forEach(finish => finish());
    await expect(article).resolves.toMatchObject({ itemId: selected.id, contentMd: expect.stringContaining('Important') });
    const explicit = agentId => svc.aiBrief('alice', 'user', id, { url, language: 'en', agentId });
    await expect(explicit('first')).resolves.toMatchObject({ agentId: 'first', cached: false });
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('Important');
    await expect(explicit('second')).resolves.toMatchObject({ agentId: 'second', cached: false });
    await expect(explicit('second')).resolves.toMatchObject({ agentId: 'second', cached: true });
    expect(requestAi).toHaveBeenCalledTimes(4);
  });
  it('ranks nonempty daily domains before truncation, and falls back to top stories', async () => {
    const requestAi = vi.fn(async () => dailyResult);
    const svc = makeService({ requestAi });
    agent('allowed', 'alice');
    const customDomains = [{ id: 'empty', name: 'Empty' }, ...Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, name: `Domain ${i}` }))];
    await svc.savePreferences('alice', { enabledDomainIds: [], customDomains });
    for (let i = 0; i < 9; i++) ingestCosmicWebItems(source(`s${i}`, `d${i}`), [item(`News${i}`, `https://example.com/${i}`, NOW - (8 - i) * HOUR)], NOW);
    ingestCosmicWebItems(source('s0', 'd0'), [item('More', 'https://example.com/more', NOW - 9 * HOUR)], NOW);
    const brief = () => svc.dailyBriefing('alice', 'user', { language: 'en' });
    await expect(brief()).resolves.toEqual({ ...dailyResult, agentId: 'allowed', agentName: 'allowed', perspective: 'balanced', generatedAt: NOW, cached: false });
    expect(requestAi.mock.lastCall[0].payload.domains.map(d => d.id)).toEqual(['d0', 'd8', 'd7', 'd6', 'd5', 'd4', 'd3', 'd2']);
    await expect(brief()).resolves.toMatchObject({ cached: true });
    await svc.savePreferences('alice', { customDomains: [] });
    await brief();
    expect(requestAi.mock.lastCall[0].payload.domains).toMatchObject([{ id: 'top-stories', stories: [expect.objectContaining({ headline: 'News8' }), ...Array(7).fill(expect.any(Object))] }]);
  });
  it('marks only the exact filtered feed and returns updated metadata and graph', async () => {
    const svc = makeService();
    const prefs = await svc.savePreferences('alice', { enabledDomains: ['ai', 'tech'], watchKeywords: ['watched'] });
    expect(prefs).toMatchObject({ domains: expect.any(Array), stats: { unreadCount: 0 } });
    for (const [index, [title, domain]] of [['target watched', 'ai'], ['target outside', 'ai'], ['unrelated watched', 'ai'], ['target watched tech', 'tech'], ['target watched unbookmarked', 'ai'], ['target watched already read', 'ai']].entries()) {
      // Separate scopes/sources alone do not prevent similarity merging; seed deterministic clusters.
      const id = `state${index}`;
      db.upsertSource(source(id, domain));
      db.upsertCluster({ id, headline: title, summaryExcerpt: '', keywords: [], publishedAt: NOW });
      db.insertItem({ ...item(title), id, clusterId: id, domainId: domain, sourceId: id });
      if (index !== 4) svc.setClusterState('alice', id, { bookmarked: true, unread: index !== 5 });
    }
    const query = { domain: 'ai', filter: 'bookmarked', bookmarked: true, unread: '1', watch: true, q: 'target' };
    expect(svc.feed('alice', query).clusters.map(c => c.id)).toEqual(['state0']);
    const result = svc.markAllRead('alice', query);
    expect(result).toMatchObject({ updated: 1, stats: { unreadCount: 4 }, domains: expect.any(Array),
      graph: { nodes: expect.arrayContaining([expect.objectContaining({ clusterId: 'state0', unread: false })]) } });
    expect(svc.feed('alice', { unread: true }).clusters.map(c => c.id)).toEqual(['state1', 'state2', 'state3', 'state4']);
    expect(svc.graph('alice')).toMatchObject({ stats: result.stats, domains: result.domains });
  });
  it('purges user preferences as soon as the account becomes pending', () => {
    const owner = userDb.createFull('pending-cleanup-fixture', 'unused').id;
    db.saveUserPrefs(owner, {}, NOW);
    expect(userDb.beginDeletion(owner)).toMatchObject({ status: 'pending' });
    expect(userDb.get(owner).deletion_state).toBe('pending');
    expect(db.loadUserPrefs(owner)).toBeNull();
    expect(userDb.reconcilePendingDeletions()).toBe(1);
  });
  it('purges a pending account, retries failed purge on reconciliation, and fences in-flight writes and polling', async () => {
    const owner = userDb.createFull('deletion-fixture', 'unused').id;
    const direct = userDb.createFull('hard-deletion-fixture', 'unused').id;
    const url = 'https://private.example/feed';
    let allowSWR = false, finishRefresh, finishDns;
    const fetcher = vi.fn(async requested => requested !== url ? response('', requested) : new Promise(resolve => {
      finishRefresh = () => resolve(response(rss, requested));
    }));
    const svc = makeService({ isUserActive: undefined, autoRefresh: () => allowSWR, fetcher,
      dnsLookup: host => host === 'pending.example' ? new Promise(resolve => { finishDns = () => resolve(dns()); }) : dns() });
    const domain = { id: 'private', name: 'Mine', rssUrls: [url] };
    await svc.savePreferences(owner, { enabledDomains: [], customDomains: [domain] });
    const privateSource = db.listSources(owner)[0];
    ingestCosmicWebItems({ ...source(privateSource.id, domain.id, owner), url }, [item('Private article')], NOW);
    ingestCosmicWebItems(source(), [item('Public article')], NOW);
    const id = svc.feed(owner).clusters[0].id;
    const itemId = db.listVisibleItems(owner, [id])[0].id;
    const publicId = db.listVisibleClusters(direct)[0].id;
    const publicItemId = db.listVisibleItems(direct, [publicId])[0].id;
    svc.setClusterState(owner, id, { bookmarked: true });
    db.saveUserClusterState(owner, publicId, { unread: false });
    db.setArticleCache(owner, itemId, { markdown: 'private' }, NOW + 1);
    db.setArticleCache(owner, publicItemId, { markdown: 'public' }, NOW + 1);
    db.setAiCache(owner, 'key', {}, NOW + 1);
    db.saveUserPrefs(direct, {}, NOW);
    expect(userDb.deleteUser(direct)).toBe(true);
    expect(db.loadUserPrefs(direct)).toBeNull();
    const refreshing = expect(svc.refresh(owner)).rejects.toMatchObject({ status: 403 });
    const saving = expect(svc.savePreferences(owner, { customDomains: [{ ...domain, rssUrls: ['https://pending.example/feed'] }] }))
      .rejects.toMatchObject({ status: 403 });
    await vi.waitFor(() => { expect(finishRefresh).toBeTypeOf('function'); expect(finishDns).toBeTypeOf('function'); });
    db.getCosmicWebDb().exec(`CREATE TRIGGER fail_purge BEFORE DELETE ON cw_user_prefs BEGIN SELECT RAISE(ABORT, 'test purge failure'); END`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pendingDeletion = userDb.beginDeletion(owner);
    expect(pendingDeletion).toMatchObject({ status: 'pending' });
    expect(log).toHaveBeenCalledWith('[AccountDeletion] Cosmic Web purge deferred:', 'test purge failure');
    const unaffected = userDb.createFull('other-pending-deletion-fixture', 'unused').id;
    userDb.beginDeletion(unaffected);
    // The same reconciliation pass used at startup must skip the failed purge and finalize other accounts.
    expect(userDb.reconcilePendingDeletions()).toBe(1);
    expect(userDb.get(unaffected)).toBeUndefined();
    expect(userDb.get(owner)).toMatchObject({ deletion_state: 'pending', deletion_id: pendingDeletion.deletionId, password_hash: null, agent_secret: null });
    expect(log).toHaveBeenCalledWith('[AccountDeletion] Finalization deferred:', 'test purge failure');
    expect(userDb.isActive(owner)).toBe(false);
    expect(db.loadUserPrefs(owner)).not.toBeNull();
    finishRefresh(); finishDns();
    await Promise.all([refreshing, saving]);
    // The failing purge left the source enabled and present, but the in-flight write must not land.
    expect(db.listSources(owner)[0].last_attempt_at).toBeNull();
    expect(db.listVisibleItems(owner, db.listVisibleClusters(owner).map(c => c.id))).toHaveLength(2);
    allowSWR = true;
    vi.useFakeTimers();
    expect(svc.startScheduler()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher.mock.calls.filter(([target]) => target === url)).toHaveLength(1);
    db.getCosmicWebDb().exec('DROP TRIGGER fail_purge');
    expect(userDb.reconcilePendingDeletions()).toBe(1);
    expect(userDb.get(owner)).toBeUndefined();
    expect(db.loadUserPrefs(owner)).toBeNull();
    expect(db.listUserClusterStates(owner).size).toBe(0);
    expect(db.getAiCache(owner, 'key', NOW)).toBeNull();
    expect(db.getArticleCache(owner, itemId, NOW)).toBeNull();
    expect(db.getArticleCache(owner, publicItemId, NOW)).toEqual({ markdown: 'public' });
    expect(db.listActivePrivateSources()).toEqual([]);
    expect(db.listVisibleClusters(owner).some(c => c.owner_user_id === owner)).toBe(false);
  });
  it('deduplicates public refresh, isolates failed sources and limits notifications to enabled domains and owners', async () => {
    const messages = Object.fromEntries(['alice', 'bob', 'charlie'].map(id => [id, []]));
    for (const [userId, sent] of Object.entries(messages)) webClients.set(userId, { userId, authenticated: true, encryptOutbound: false,
      ws: { readyState: 1, send: data => sent.push(JSON.parse(data)) } });
    const fetcher = vi.fn(async url => response(rss, url, url.includes('36kr') ? 503 : 200));
    const svc = makeService({ fetcher });
    await svc.savePreferences('alice', { enabledDomainIds: ['ai'], customDomains: [{ id: 'private', name: 'Private', rssUrls: ['https://example.com/feed'] }] });
    await svc.savePreferences('bob', { enabledDomainIds: ['ai'] });
    await svc.savePreferences('charlie', { enabledDomainIds: [] });
    const [a, b] = await Promise.all([svc.refresh('alice'), svc.refresh('bob')]);
    expect(a).toMatchObject({ added: 5, failed: 1 }); expect(b).toMatchObject({ added: 4, failed: 1 });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(messages.alice.some(m => m.domainId === 'private')).toBe(true);
    expect(messages.bob.every(m => m.domainId === 'ai')).toBe(true); expect(messages.charlie).toEqual([]);
  });
  it('serves the cached snapshot immediately and revalidates once per stale source', async () => {
    let time = NOW;
    let allowSWR = false;
    const fetcher = vi.fn(async url => response(rss, url));
    const svc = makeService({ fetcher, now: () => time, autoRefresh: () => allowSWR });
    await svc.savePreferences('alice', { enabledDomains: ['ai'], disabledSources: ['36kr-quick', 'hackernews', 'arxiv-ai', 'huggingface'] });
    await svc.refresh('alice');
    allowSWR = true;
    expect(svc.feed('alice').total).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    expect(fetcher).toHaveBeenCalledTimes(1);
    time += 5 * 60_000;
    expect(svc.feed('alice').total).toBe(1);
    expect(svc.feed('alice').total).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects both cluster state mutations with 503 after scheduler stop', () => {
    const svc = makeService();
    ingestCosmicWebItems(source(), [item('Unread article')], NOW);
    const id = svc.feed('alice').clusters[0].id;
    svc.stopScheduler();
    expect(() => svc.setClusterState('alice', id, { bookmarked: true })).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => svc.markAllRead('alice')).toThrow(expect.objectContaining({ status: 503 }));
    expect(db.listUserClusterStates('alice').size).toBe(0);
  });
  it('aborts pending bridge work without a reply or cache write on scheduler stop', async () => {
    const svc = makeService();
    const frames = agent('allowed', 'alice');
    const pending = expect(svc.dailyBriefing('alice', 'user')).rejects.toMatchObject({ status: 503 });
    expect(frames).toHaveLength(1);
    svc.stopScheduler();
    await pending;
    expect(handleCosmicWebAiResponse('allowed', { requestId: frames[0].requestId, ok: true, result: dailyResult })).toBe(false);
    expect(db.getCosmicWebDb().prepare('SELECT count(*) AS count FROM cw_ai_cache').get().count).toBe(0);
  });
  it('skips default scheduler in tests, starts idempotently and aborts in-flight work on stop', async () => {
    expect(startCosmicWebScheduler()).toBe(false);
    vi.useFakeTimers();
    const signals = [];
    const svc = makeService({ autoRefresh: () => true, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
      signals.push(signal); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    expect(svc.startScheduler()).toBe(true); expect(svc.startScheduler()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(signals.length).toBeGreaterThan(0);
    svc.stopScheduler(); svc.stopScheduler();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    for (const pending of [svc.refresh('alice'), svc.savePreferences('alice', {}), svc.article('alice', 'missing'),
      svc.aiBrief('alice', 'user', 'missing'), svc.dailyBriefing('alice', 'user')]) {
      await expect(pending).rejects.toMatchObject({ status: 503 });
    }
    await vi.advanceTimersByTimeAsync(1); expect(vi.getTimerCount()).toBe(0);
    expect(svc.startScheduler()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals.some(signal => !signal.aborted)).toBe(true);
  });
});

const pngUrl = 'https://images.example/game.png';
const gifUrl = 'https://images.example/replay.gif';
const image = { url: pngUrl, kind: 'image' };
const followResult = { question: 'Why?', answer: 'Because.', bullets: [], media: [image], citations: [], followUps: [], researched: false, searchCount: 0 };
const radarItem = { title: 'Lunar rocket', url: 'https://news.example/story/?utm_source=radar', sourceName: 'Space Desk', summaryExcerpt: 'New coverage', mediaUrl: pngUrl };
const richResult = { ...storyResult, sections: [{ heading: 'Context', body: 'New release.' }], media: [image],
  communityHighlights: [{ platform: 'Hupu', author: 'fan', quote: 'Good defense', sourceUrl: 'https://bbs.hupu.com/123.html' }],
  citations: [{ title: 'Original', url: 'https://news.example/story' }], researched: true, searchCount: 2 };

const withMedia = '<rss><channel><item><title>News</title><link>/story</link>' +
  '<media:content url="/video.mp4" type="video/mp4"/><media:thumbnail url="/pixel.png" width="1"/>' +
  `<media:thumbnail url="${pngUrl}" title="The game"/><enclosure type="image/gif" url="${gifUrl}"/>` +
  '<description><![CDATA[<img src="/game.webp?animated=1" alt="Game replay"><img src="/extra.png">]]></description></item></channel></rss>';
const adapterResponse = (value, url) => response(typeof value === 'string' ? value : JSON.stringify(value), url);
const next = pageProps => `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps } })}</script>`;

describe('2.0 adapters and storage', () => {
  it.each(['espn-nba', 'espn-top', 'nasa', 'nature', 'sciencedaily', 'physorg', 'gcores', 'yystv', 'arxiv-ai', 'huggingface', 'freebuf', 'lobsters', 'ifanr'])('normalizes the %s feed and caps images', async id => {
    const source = BUILTIN_SOURCES.find(s => s.id === id);
    const fetcher = vi.fn(async url => response(withMedia, url));
    const [entry] = await fetchSource(id, { fetcher, now: NOW });
    expect(fetcher.mock.lastCall[0]).toBe(source.url);
    expect(entry.media).toEqual([{ ...image, alt: 'The game' }, { url: gifUrl, kind: 'gif' },
      { url: new URL('/game.webp?animated=1', source.url).href, kind: 'gif', alt: 'Game replay' }]);
  });
  it.each([
    ['hupu-nba', '<div class="t-info"><a href="/123.html"><span class="t-title">NBA trade news</span></a></div>', 'NBA trade news'],
    ['hupu-nba', next({ threads: [{ tid: 123, title: 'Game recap', cover: gifUrl }] }), 'Game recap', gifUrl],
    ['hupu', '<li class="bbs-sl-web-post-body"><a href="/123.html" class="p-title">Trending post</a></li>', 'Trending post'],
    ['reddit-nba', { data: { children: [{ kind: 't3', data: { title: 'Replay', permalink: '/r/nba/comments/abc/replay/',
      media_metadata: { one: { e: 'AnimatedImage', s: { u: 'https://images.example/replay.webp' } } } } }] } }, 'Replay', 'https://images.example/replay.webp'],
    ['dongqiudi', { articles: [{ id: 1, title: 'Scoreline', thumb: pngUrl }] }, 'Scoreline', pngUrl],
    ['douban', { items: [{ id: 1, title: 'Film', pic: { large: pngUrl } }] }, 'Film', pngUrl],
    ['steam', '<tr class="player_count_row"><td>1,000</td><td><a class="gameLink" href="/app/1">Game</a></td></tr>', 'Game'],
    ['bilibili', { data: { list: [{ title: 'Video', bvid: 'BV1234567890', pic: pngUrl }] } }, 'Video', pngUrl],
    ['zhihu', { data: [{ target: { title_area: { text: 'Question' }, link: { url: 'https://www.zhihu.com/question/1' }, image_area: { url: pngUrl } } }] }, 'Question', pngUrl],
    ['sspai', { data: [{ id: 1, title: 'Article', banner: pngUrl }] }, 'Article', pngUrl],
    ['wallstreetcn-quick', { data: { items: [{ title: 'Markets', uri: 'https://wallstreetcn.com/livenews/1', image_uri: pngUrl }] } }, 'Markets', pngUrl],
    ['nowcoder', { data: { result: [{ type: 0, id: 1, title: 'Engineering' }] } }, 'Engineering'],
    ['gelonghui', '<a href="/news/123"><h2>Market news</h2></a>', 'Market news'],
    ['fastbull', '<div class="content-list news-list" data-date="1795780800000"><a data-href="/cn/fastshort/1"><span class="title_name">Flash</span></a></div>', 'Flash'],
    ['coolapk', '<a href="/feed/123" title="Gadget"><img src="https://images.example/game.png"></a>', 'Gadget', pngUrl],
    ['zaobao', '<a href="/news/world/story20261127-10067775">World news</a>', 'World news'],
    ['tencent', { data: { tabs: [{ articleList: [{ title: 'Headlines', link_info: { url: 'https://news.qq.com/story' }, cover: pngUrl }] }] } }, 'Headlines', pngUrl],
    ['ifeng', '<script>var allData = {"hotNews1":[{"url":"https://news.ifeng.com/story","title":"Evening update"}]};</script>', 'Evening update'],
    ['douyin', { data: { word_list: [{ sentence_id: '123', word: 'Trending' }] } }, 'Trending'],
    ['tieba', { data: { bang_topic: { topic_list: [{ topic_name: 'Forum', topic_url: 'https://tieba.baidu.com/topic' }] } } }, 'Forum'],
  ])('maps %s public response shape', async (id, fixture, title, media) => {
    const [entry] = await fetchSource(id, { fetcher: async url => adapterResponse(fixture, url), now: NOW });
    expect(entry.title).toBe(title);
    expect(entry.media.map(m => m.url)).toEqual(media ? [media] : []);
    if (media && ['hupu-nba', 'reddit-nba'].includes(id)) expect(entry.media[0].kind).toBe('gif');
  });
  it('adds media to an existing database and prunes expired enrichment without deleting live stories', async () => {
    const path = join(dir, 'cosmic-web.db');
    ingestCosmicWebItems(source(), [item('Legacy row')], NOW);
    db.getCosmicWebDb().exec('ALTER TABLE cw_items DROP COLUMN media_json; DROP TABLE cw_enrichment_cache;');
    db.closeCosmicWebDb(); db.openCosmicWebDb(path);
    const legacy = db.listVisibleClusters('alice')[0].id;
    expect(db.listVisibleItems('alice', [legacy])[0].media_json).toBe('[]');
    const mediaItem = { ...item('Basketball highlights', 'https://news.example/sports'), media: [image] };
    ingestCosmicWebItems(source('sports-fixture', 'sports'), [mediaItem], NOW);
    const { id } = db.listVisibleClusters('alice').find(c => c.headline === mediaItem.title);
    expect(JSON.parse(db.listVisibleItems('alice', [id])[0].media_json)).toEqual([image]);
    const fetcher = vi.fn(async () => { throw Error('blocked'); });
    const svc = makeService({ fetcher });
    const detail = await svc.cluster('alice', id);
    expect(detail).toMatchObject({ items: [{ media: [image] }], media: [{ ...image, proxyUrl: toProxyMediaUrl(pngUrl, 'alice', NOW) }] });
    await svc.clusterCommunity('alice', id);
    await svc.clusterCommunity('alice', id);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(db.getEnrichmentCache(id, NOW)).not.toBeNull();
    expect(db.pruneCosmicWebDb(NOW + 120 * 60_000)).toMatchObject({ enrichment: 1, clusters: 0 });
    expect(db.getEnrichmentCache(id, NOW)).toBeNull();
  });
});

describe('raster media proxy', () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const fixtures = [['image/png', png], ['image/gif', Buffer.from('GIF89a00')], ['image/webp', Buffer.from('RIFF0000WEBP')],
    ['image/jpeg', Buffer.from('ffd8ff', 'hex')], ['image/avif', Buffer.from('0000ftypavif')], ['image/avif', Buffer.from('0000ftypavis')]];
  it.each(fixtures)('serves %s, strips referers, and reuses a fresh cache entry', async (mime, bytes) => {
    let time = NOW;
    const socket = transport((_url, opts) => {
      expect(opts.headers.referer).toBeUndefined();
      expect(opts.headers.accept).toBe('image/avif,image/webp,image/gif,image/png,image/jpeg,*/*;q=0.5');
      return stream([bytes], { 'content-type': mime });
    });
    const fetcher = vi.fn((url, options) => safeFetch(url, { ...options, requestImpl: socket }));
    const proxy = createMediaProxy({ fetcher, dnsLookup: dns, now: () => time });
    const result = await proxy(pngUrl);
    expect(result).toMatchObject({ body: bytes, headers: { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=3600' } });
    expect(await proxy(`${pngUrl}#fragment`)).toBe(result);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(pngUrl, expect.objectContaining({ timeoutMs: 8000, maxBytes: 6 * 1024 ** 2, maxDecompressedBytes: 6 * 1024 ** 2 }));
    time += 30 * 60_000;
    expect(await proxy(pngUrl)).not.toBe(result);
    expect(socket).toHaveBeenCalledTimes(2);
  });
  it.each(['image/svg+xml', 'text/html', 'image/gif', 'image/png,image/gif'])('rejects disallowed or mismatched %s', async mime => {
    const proxy = createMediaProxy({ fetcher: async () => ({ status: 200, headers: { 'content-type': mime }, bodyBuffer: png }) });
    await expect(proxy(pngUrl)).rejects.toMatchObject({ status: 415 });
  });
  it('blocks private direct and redirected addresses and rejects non-HTTP URLs', async () => {
    const socket = transport(() => stream([], { location: 'http://169.254.169.254/path' }, 302));
    const proxy = createMediaProxy({ dnsLookup: dns, fetcher: (url, options) => safeFetch(url, { ...options, requestImpl: socket }) });
    await expect(proxy('http://127.0.0.1/image')).rejects.toMatchObject({ status: 502 });
    expect(socket).not.toHaveBeenCalled();
    await expect(proxy(pngUrl)).rejects.toMatchObject({ status: 502 });
    expect(socket).toHaveBeenCalledOnce();
    await expect(proxy('data:image/png;base64,abcd')).rejects.toMatchObject({ status: 400 });
    expect(toProxyMediaUrl('javascript:alert(1)')).toBeNull();
  });
  it.each([[49, png], [5, Buffer.concat([png, Buffer.alloc(6 * 1024 ** 2 - png.length)])]])('evicts LRU entries under the item and byte budgets (%i inputs)', async (n, bodyBuffer) => {
    const fetcher = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBuffer }));
    const proxy = createMediaProxy({ fetcher });
    const url = i => `${pngUrl}?i=${i}`;
    for (let i = 0; i < n - 1; i++) await proxy(url(i));
    await proxy(url(0));
    await proxy(url(n - 1));
    await proxy(url(0));
    await proxy(url(1));
    expect(fetcher).toHaveBeenCalledTimes(n + 1);
  });
  it('serves binary on the authenticated route only with a valid user-scoped signature, enforces per-user concurrency, and rejects non-image headers early', async () => {
    const app = express();
    const fetcher = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'image/png' }, bodyBuffer: png }));
    registerCosmicWebRoutes(app, { proxyMedia: createMediaProxy({ fetcher, requireSigned: true }), requireSessionAuth(req, res, next) {
      const username = req.get('x-test-user');
      if (!username) return res.sendStatus(401);
      req.user = { username }; next();
    } });
    // Unauthenticated rejected 401
    await supertest(app).get(toProxyMediaUrl(pngUrl, 'alice')).expect(401);
    // Unsigned URL rejected 403
    await supertest(app).get(toProxyMediaUrl(pngUrl)).set('x-test-user', 'alice').expect(403);
    // URL signed for bob rejected 403 for alice
    await supertest(app).get(toProxyMediaUrl(pngUrl, 'bob')).set('x-test-user', 'alice').expect(403);
    // Expired token rejected 403
    await supertest(app).get(toProxyMediaUrl(pngUrl, 'alice', Date.now() - 4 * 3600_000)).set('x-test-user', 'alice').expect(403);
    expect(fetcher).not.toHaveBeenCalled();

    // Valid user-scoped signed URL serves binary & strips referer
    const res = await supertest(app).get(toProxyMediaUrl(pngUrl, 'alice')).set('x-test-user', 'alice').set('Referer', 'https://private.example/session')
      .expect('Content-Type', 'image/png').expect('X-Content-Type-Options', 'nosniff').expect(200);
    expect(res.body).toEqual(png);
    expect(fetcher.mock.lastCall[1].headers.referer).toBeUndefined();

    // Per-user concurrency isolation: alice hitting 2 slow slots does NOT block bob
    const resolvers = [];
    const slowProxy = createMediaProxy({
      fetcher: () => new Promise(resolve => resolvers.push(() => resolve({ status: 200, headers: { 'content-type': 'image/png' }, bodyBuffer: png }))),
    });
    const a1 = slowProxy('https://images.example/a1.png', { userId: 'alice' });
    const a2 = slowProxy('https://images.example/a2.png', { userId: 'alice' });
    await expect(slowProxy('https://images.example/a3.png', { userId: 'alice' })).rejects.toMatchObject({ status: 429 });
    const b1 = slowProxy('https://images.example/b1.png', { userId: 'bob' });
    await new Promise(r => setImmediate(r));
    resolvers.forEach(fn => fn());
    await expect(Promise.all([a1, a2, b1])).resolves.toHaveLength(3);

    // Early header rejection: HTML content-type rejected before reading body
    let bodyRead = false;
    const htmlStream = new Readable({
      read() { bodyRead = true; this.push(Buffer.from('<html>big page</html>')); this.push(null); },
    });
    htmlStream.headers = { 'content-type': 'text/html; charset=utf-8' };
    htmlStream.statusCode = 200;
    const earlySocket = transport(() => htmlStream);
    const earlyProxy = createMediaProxy({ dnsLookup: dns, fetcher: (u, opts) => safeFetch(u, { ...opts, requestImpl: earlySocket }) });
    await expect(earlyProxy('https://images.example/not-image')).rejects.toMatchObject({ status: 415 });
    expect(bodyRead).toBe(false);
  });
});

describe('deterministic community enrichment', () => {
  it('recovers actual Reddit, HN, V2EX and Hupu replies with verified media candidates', async () => {
    const urls = ['https://old.reddit.com/r/nba/comments/abc/game', 'https://news.ycombinator.com/item?id=1',
      'https://v2ex.com/t/2', 'https://bbs.hupu.com/3.html'];
    const fixture = new Map([
      ['https://www.reddit.com/r/nba/comments/abc.json?limit=8&sort=top', [{}, { data: { children: [
        { kind: 't1', data: { author: 'Fan', body: 'Strong defense', score: 10, permalink: '/r/nba/comments/abc/game/xyz/' } },
        { kind: 't1', data: { author: '[deleted]', body: '[removed]', score: 900 } },
      ] } }]],
      ['https://hn.algolia.com/api/v1/items/1', { children: [{ id: 11, author: 'Tech', text: '<p>Data &amp; results</p>' }] }],
      ['https://www.v2ex.com/api/replies/show.json?topic_id=2', [{ id: 22, member: { username: 'Dev' }, content: 'Useful tip', thanks: 3 }]],
      [urls[0], `<meta property="og:image" content="${pngUrl}"><meta property="og:image:alt" content="The court">
        <img class="avatar" src="/user.jpg"><img width="1" src="/t.jpg"><img src="http://127.0.0.1/private.png">
        <meta name="twitter:image" content="https://images.example/second.png">`],
      [urls[3], next({ detail: { thread: { content: `<img src="${gifUrl}">` }, lights: [
        { author: { puname: '球迷' }, content: '<p>好球！</p>', allLightCount: 30 },
        { isHidden: true, author: { puname: 'hidden' }, content: 'blocked', allLightCount: 100 },
      ] } })],
    ]);
    const fetcher = vi.fn(async (url, opts) => {
      expect(opts.timeoutMs).toBe(5000);
      if (!fixture.has(url)) throw Error('not available');
      return adapterResponse(fixture.get(url), url);
    });
    const got = await extractCommunityEnrichment(urls.map((url, i) => ({ url, sourceName: `Source ${i}`, media: i === 1 ? [{ url: 'https://images.example/feed.webp?animated=1', kind: 'gif' }] : [] })), { fetcher, dnsLookup: dns });
    expect(got.communityComments).toMatchObject([
      { platform: 'Hupu', author: '球迷', quote: '好球！', likes: 30, sourceUrl: urls[3] },
      { platform: 'Reddit', author: 'Fan', quote: 'Strong defense', likes: 10, sourceUrl: 'https://www.reddit.com/r/nba/comments/abc/game/xyz/' },
      { platform: 'V2EX', author: 'Dev', quote: 'Useful tip', likes: 3, sourceUrl: 'https://www.v2ex.com/t/2#r_22' },
      { platform: 'Hacker News', author: 'Tech', quote: 'Data & results', likes: 0, sourceUrl: 'https://news.ycombinator.com/item?id=11' },
    ]);
    expect(got.media).toMatchObject([{ kind: 'gif' }, { url: pngUrl, caption: 'The court', proxyUrl: toProxyMediaUrl(pngUrl) },
      { url: 'https://images.example/second.png' }, { url: gifUrl, kind: 'gif' }]);
  });
  it('handles HTML-only Hupu bright replies, Linux.do and public Bilibili comments', async () => {
    const fetcher = async url => adapterResponse(url.includes('bbs.hupu.com') ? `<h2>这些回帖亮了</h2>
      <div class="post-reply-list-container"><a class="post-reply-list-user-info-top-name">粉丝</a>
      <div class="thread-content-detail"><p>精彩</p><img src="${gifUrl}"></div><span>亮了(<!-- -->12)</span></div>` :
      url.includes('linux.do/t/42.json') ? { post_stream: { posts: [{ post_number: 1, username: 'op', cooked: 'Not a comment' },
        { post_number: 2, username: 'member', cooked: '<p>Reply</p>', actions_summary: [{ id: 2, count: 4 }] }] } } :
      url.includes('web-interface/view') ? { data: { pic: pngUrl, aid: 123 } } :
      url.includes('/x/v2/reply') ? { data: { hots: [{ member: { uname: 'viewer' }, content: { message: 'Great' }, like: 2, rpid: 88 }] } } : '', url);
    const result = await extractCommunityEnrichment(['https://bbs.hupu.com/3.html', 'https://linux.do/t/topic/42', 'https://www.bilibili.com/video/BV1234567890']
      .map(url => ({ url })), { fetcher, dnsLookup: dns });
    expect(result.communityComments.map(c => [c.platform, c.quote, c.likes])).toEqual([['Hupu', '精彩', 12], ['Linux.do', 'Reply', 4], ['Bilibili', 'Great', 2]]);
    expect(result.media.map(m => m.url)).toEqual([gifUrl, pngUrl]);
  });
  it('returns empty lists for inaccessible pages and lookalike domains', async () => {
    const fetcher = vi.fn(async () => { throw Error('timeout'); });
    await expect(extractCommunityEnrichment([{ url: 'https://reddit.com.other.test/r/nba/comments/abc' }], { fetcher, dnsLookup: dns }))
      .resolves.toEqual({ media: [], communityComments: [] });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('2.0 graph and AI contracts', () => {
  it('balances 180 nodes across nine domains and annotates media, LOD and projected links', () => {
    const clusters = BUILTIN_DOMAINS.flatMap(d => Array.from({ length: 25 }, (_, i) => ({ id: `${d.id}-${i}`, domainId: d.id,
      heatScore: 25 - i, watchHit: i === 24, publishedAt: NOW, keywords: ['shared'], itemCount: 1, sourceNames: ['News'],
      summaryExcerpt: '  ' + 'X'.repeat(200), items: [{ media: [image] }] })));
    const graph = buildGraphProjection({ prefs: { enabledDomains: BUILTIN_DOMAINS.map(d => d.id) }, clusters, domains: BUILTIN_DOMAINS });
    expect([1, 2, 3].map(t => graph.nodes.filter(n => n.lodTier === t).length)).toEqual([14, 66, 100]);
    expect(BUILTIN_DOMAINS.map(d => graph.nodes.filter(n => n.domainId === d.id).length)).toEqual(Array(9).fill(20));
    expect(graph.nodes.filter(n => n.watchHit).every(n => n.lodTier === 1)).toBe(true);
    const ids = new Set(graph.nodes.map(n => n.clusterId));
    for (const n of graph.nodes) {
      expect(n).toMatchObject({ summaryExcerpt: 'X'.repeat(180), mediaPreview: { proxyUrl: toProxyMediaUrl(pngUrl), kind: 'image' }, itemCount: 1, sourceNames: ['News'] });
      expect(n.relatedClusterIds).toHaveLength(4);
      expect(n.relatedClusterIds.every(id => id !== n.clusterId && ids.has(id))).toBe(true);
    }
  });
  it.each([['brief', richResult], ['synthesize', storyResult], ['follow_up', followResult], ['topic_radar', { items: [radarItem], searchCount: 1 }]])
    ('validates %s and resolves the correlated bridge request', async (mode, result) => {
      const frames = agent('new', 'alice');
      expect(validateCosmicWebAiResult(result, mode)).toBe(true);
      const pending = requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'new', mode });
      handleCosmicWebAiResponse('new', { requestId: frames[0].requestId, ok: true, result });
      await expect(pending).resolves.toEqual(result);
    });
  it.each([
    ['brief', { ...richResult, media: [{ ...image, url: 'javascript:alert(1)' }] }],
    ['brief', { ...richResult, communityHighlights: [{ ...richResult.communityHighlights[0], sourceUrl: 'data:text/html,x' }] }],
    ['brief', { ...richResult, fullMarkdown: 'a'.repeat(16001) }],
    ['brief', { ...richResult, sections: [] }],
    ['follow_up', { ...followResult, citations: [{ title: 'bad', url: 'file:///tmp/secret' }] }],
    ['topic_radar', { items: [{ ...radarItem, url: 'ftp://example.com' }], searchCount: 1 }],
    ['topic_radar', { items: [{ ...radarItem, mediaUrl: 'data:image/png;base64,x' }], searchCount: 1 }],
  ])('rejects invalid %s output', (mode, result) => expect(validateCosmicWebAiResult(result, mode)).toBe(false));
  it('answers follow-ups with scoped cached briefing context, and ingests owner-private Radar results', async () => {
    let clock = NOW;
    const updates = [];
    const requestAi = vi.fn(async req => req.mode === 'follow_up' ? followResult : req.mode === 'topic_radar' ?
      { items: [radarItem, { ...radarItem, url: 'https://news.example/story#dup' }, { ...radarItem, url: 'http://127.0.0.1/story' }], searchCount: 2 } : storyResult);
    const svc = makeService({ now: () => clock, requestAi, fetcher: async url => response('', url) });
    agent('alice-agent', 'alice'); agent('bob-agent', 'bob');
    for (const userId of ['alice', 'bob']) webClients.set(userId, { userId, authenticated: true, encryptOutbound: false,
      ws: { readyState: 1, send: data => updates.push([userId, JSON.parse(data)]) } });
    const custom = { id: 'space', name: 'Space', keywords: ['rocket'], colorToken: 'teal', aiRadar: true };
    await svc.savePreferences('alice', { customDomains: [custom], enabledDomains: BUILTIN_DOMAINS.map(d => d.id) });
    await svc.savePreferences('bob', { customDomains: [custom] });
    ingestCosmicWebItems(source(), [{ ...item('Question context'), media: [image] }], NOW);
    const id = svc.feed('alice').clusters[0].id;
    const brief = await svc.aiBrief('alice', 'user', id, { research: false });
    expect(brief.media).toMatchObject([{ ...image, proxyUrl: toProxyMediaUrl(pngUrl, 'alice', NOW) }]);
    await expect(svc.followUp('alice', 'user', id, { question: ' ' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.followUp('alice', 'user', id, { question: 'x'.repeat(501) })).rejects.toMatchObject({ status: 400 });
    const app = express(); app.use(express.json());
    registerCosmicWebRoutes(app, { cosmicWeb: svc, requireSessionAuth(req, res, next) {
      if (!req.get('x-test-user')) return res.sendStatus(401);
      req.user = { username: req.get('x-test-user') }; next();
    } });
    const request = supertest(app), api = '/api/cosmic-web';
    await request.post(`${api}/clusters/${id}/follow-up`).expect(401);
    await request.post(`${api}/domains/space/radar-scan`).expect(401);
    const follow = await request.post(`${api}/clusters/${id}/follow-up`).set('x-test-user', 'alice').send({ question: ' Why? ' }).expect(200);
    expect(follow.body).toMatchObject({ answer: 'Because.', media: [{ proxyUrl: toProxyMediaUrl(pngUrl, 'alice', NOW) }] });
    expect(requestAi.mock.lastCall[0]).toMatchObject({ mode: 'follow_up', payload: { briefContext: storyResult.tldr, question: 'Why?' } });
    await expect(svc.radarScan('alice', 'user', 'ai')).rejects.toMatchObject({ status: 404 });
    await request.post(`${api}/domains/space/radar-scan`).set('x-test-user', 'alice').set('Sec-Fetch-Site', 'cross-site').expect(403);
    const radar = await request.post(`${api}/domains/space/radar-scan`).set('x-test-user', 'alice').send({}).expect(200);
    expect(radar.body).toMatchObject({ added: 1, items: [{ url: 'https://news.example/story', sourceName: 'Space Desk' }],
      graph: { nodes: expect.arrayContaining([expect.objectContaining({ domainId: 'space', sourceNames: ['Space Desk'] })]) } });
    expect(radar.body.domains.find(d => d.id === 'space')).toMatchObject({ aiRadar: true, colorToken: 'teal', sources: [{ id: 'radar-space', kind: 'radar' }] });
    expect(requestAi.mock.lastCall[0]).toMatchObject({ mode: 'topic_radar', payload: { topic: 'Space', keywords: ['rocket'] } });
    expect(updates).toEqual([['alice', expect.objectContaining({ type: 'cosmic_web_updated', domainId: 'space' })]]);
    expect(svc.feed('alice', { domainId: 'space' }).total).toBe(1);
    expect(svc.feed('bob', { domainId: 'space' }).total).toBe(0);
    await expect(svc.radarScan('alice', 'user', 'space')).rejects.toMatchObject({ status: 429 });
    expect((await svc.radarScan('bob', 'user', 'space')).added).toBe(1);
    clock += 60_000;
    expect((await svc.radarScan('alice', 'user', 'space')).added).toBe(0);
  });

  it('enforces Blocker #2 (private RSS blocks research), #5 (request abort cancels Agent & frees slot), #7 (aiRadar opt-in), #8 (mixed-version v1/v2 Agent), #9 (legacy sports custom domain migration), and Nit #4 (media backfill)', async () => {
    // Blocker #9: pre-existing custom domain with colliding built-in ID 'sports'
    db.saveUserPrefs('alice', {
      enabledDomainIds: ['ai'],
      customDomains: [{ id: 'sports', name: 'My Hoops', colorToken: 'gold', enabled: true, keywords: ['lakers'], rssUrls: [] }],
      watchKeywords: [], muteKeywords: [], disabledSources: [], preferredAgentId: '', defaultPerspective: 'balanced', onboarded: true, autoRefreshMinutes: 15,
    }, NOW);
    ingestCosmicWebItems(source('rss-legacy-hoops', 'sports', 'alice'), [item('Lakers internal note', 'https://private.example/lakers')], NOW);

    const requestAi = vi.fn(async req => req.mode === 'follow_up' ? followResult : storyResult);
    const svc = makeService({ requestAi });

    // Bootstrap migrates colliding 'sports' custom domain idempotently to 'custom-sports' (zero duplicates)
    const boot = svc.bootstrap('alice', 'user');
    const domainIdList = boot.domains.map(d => d.id);
    expect(new Set(domainIdList).size).toBe(domainIdList.length);
    expect(domainIdList).toContain('sports');
    expect(domainIdList).toContain('custom-sports');
    // Unrelated preference save succeeds (never 400!)
    const saved = await svc.savePreferences('alice', { watchKeywords: ['NBA'] });
    expect(saved.watchKeywords).toEqual(['NBA']);

    // Blocker #7: radarScan rejects when aiRadar is false
    await expect(svc.radarScan('alice', 'user', 'custom-sports')).rejects.toMatchObject({ status: 400 });

    // Blocker #2: owner-private RSS cluster forces research: false & isPrivateSource: true even when caller passes research: true
    agent('v2-agent', 'alice');
    const privCluster = svc.feed('alice', { domainId: 'custom-sports' }).clusters[0];
    expect(privCluster.isPrivateSource).toBe(true);
    await svc.aiBrief('alice', 'user', privCluster.id, { research: true, skipArticleFetch: true });
    expect(requestAi.mock.lastCall[0].payload).toMatchObject({ research: false, isPrivateSource: true });

    // Blocker #8: mixed-version v1 Agent (only cosmic_web_briefing) works for brief (with research=false), rejected 409 for follow_up & topic_radar
    agents.clear();
    agent('v1-agent', 'alice', ['cosmic_web_briefing']);
    ingestCosmicWebItems(source('pub-src', 'ai', null), [item('Public AI news', 'https://public.example/ai')], NOW);
    const pubId = svc.feed('alice', { domainId: 'ai' }).clusters[0].id;
    await svc.aiBrief('alice', 'user', pubId, { research: true, skipArticleFetch: true });
    expect(requestAi.mock.lastCall[0].payload.research).toBe(false);
    await expect(svc.followUp('alice', 'user', pubId, { question: 'More?' })).rejects.toMatchObject({ status: 409 });
    await svc.savePreferences('alice', { customDomains: [{ id: 'custom-sports', name: 'My Hoops', keywords: ['lakers'], aiRadar: true, rssUrls: [] }] });
    await expect(svc.radarScan('alice', 'user', 'custom-sports')).rejects.toMatchObject({ status: 409 });

    // Blocker #5: aborting a caller signal cancels the in-flight bridge request, sends cosmic_web_ai_cancel, and frees the user's concurrency slot
    agents.clear();
    const frames = agent('v2-cancel', 'alice');
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const p1 = requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'v2-cancel', mode: 'brief', signal: ac1.signal });
    const p2 = requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'v2-cancel', mode: 'brief', signal: ac2.signal });
    await new Promise(r => setImmediate(r));
    expect(frames.filter(f => f.type === 'cosmic_web_ai_request')).toHaveLength(2);
    // Abort request 1 -> sends cancel frame & immediately opens slot for request 3 (no 429!)
    ac1.abort(Object.assign(new Error('cancelled'), { status: 499 }));
    await expect(p1).rejects.toMatchObject({ status: 499 });
    expect(frames.some(f => f.type === 'cosmic_web_ai_cancel' && f.requestId === frames[0].requestId)).toBe(true);
    const p3 = requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'v2-cancel', mode: 'brief' });
    await new Promise(r => setImmediate(r));
    const req3 = frames.filter(f => f.type === 'cosmic_web_ai_request').at(-1);
    handleCosmicWebAiResponse('v2-cancel', { requestId: req3.requestId, ok: true, result: storyResult });
    await expect(p3).resolves.toEqual(storyResult);
    ac2.abort(Object.assign(new Error('cancelled'), { status: 499 }));
    await expect(p2).rejects.toMatchObject({ status: 499 });

    // Nit #4: duplicate ingest backfills empty media_json without altering item ID or cluster
    const beforeItems = db.listVisibleItems('alice', [pubId]);
    expect(beforeItems[0].media_json).toBe('[]');
    ingestCosmicWebItems(source('pub-src', 'ai', null), [{ ...item('Public AI news', 'https://public.example/ai'), media: [image] }], NOW);
    const afterItems = db.listVisibleItems('alice', [pubId]);
    expect(afterItems[0].id).toBe(beforeItems[0].id);
    expect(JSON.parse(afterItems[0].media_json)).toEqual([image]);
  });
});
