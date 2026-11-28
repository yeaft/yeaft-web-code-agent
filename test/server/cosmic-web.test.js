import { createHash } from 'node:crypto';
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
import { extractMarkupMedia, parseFeedXml, resolveHttpUrl } from '../../server/cosmic-web/rss-parser.js';
import { ARTICLE_EXTRACTOR_VERSION, extractCleanArticle } from '../../server/cosmic-web/article-extractor.js';
import { BUILTIN_DOMAINS, BUILTIN_SOURCES } from '../../server/cosmic-web/catalog.js';
import { fetchSource } from '../../server/cosmic-web/sources.js';
import { buildGraphProjection, canonicalizeUrl, clusterSimilarity, computeHeatScore, extractTokens } from '../../server/cosmic-web/clusterer.js';
import { createCosmicWebService, ingestCosmicWebItems, PRIVATE_BRIEF_CONTEXT_VERSION, startCosmicWebScheduler, stopCosmicWebScheduler } from '../../server/cosmic-web/service.js';
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
function agent(id, ownerId, caps = ['cosmic_web_briefing', 'cosmic_web_research', 'cosmic_web_follow_up', 'cosmic_web_radar', 'cosmic_web_cancel']) {
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
    db.getCosmicWebDb().exec('ALTER TABLE cw_items DROP COLUMN media_json; ALTER TABLE cw_items DROP COLUMN excerpt_version; ALTER TABLE cw_clusters DROP COLUMN excerpt_version; DROP TABLE cw_enrichment_cache;');
    db.closeCosmicWebDb(); db.openCosmicWebDb(path);
    const legacy = db.listVisibleClusters('alice')[0];
    expect(legacy.excerpt_version).toBe(0);
    expect(db.listVisibleItems('alice', [legacy.id])[0]).toMatchObject({ media_json: '[]', excerpt_version: 0 });
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

    // CW2-02: 6 simultaneous valid gallery images queue cleanly and ALL resolve (no spurious 429),
    // while exceeding the per-user queue cap (3 active + 8 queued = 11) rejects 429 without blocking bob.
    const resolvers = [];
    const slowProxy = createMediaProxy({
      fetcher: () => new Promise(resolve => resolvers.push(() => resolve({ status: 200, headers: { 'content-type': 'image/png' }, bodyBuffer: png }))),
    });
    const gallery = Array.from({ length: 6 }, (_, i) => slowProxy(`https://images.example/g${i}.png`, { userId: 'alice' }));
    await new Promise(r => setImmediate(r));
    expect(resolvers).toHaveLength(3); // 3 active, 3 queued
    // Fill remaining 5 queue slots (total 11 for alice), then 12th rejects 429 while bob still passes
    const extra = Array.from({ length: 5 }, (_, i) => slowProxy(`https://images.example/e${i}.png`, { userId: 'alice' }));
    await expect(slowProxy('https://images.example/overflow.png', { userId: 'alice' })).rejects.toMatchObject({ status: 429 });
    const b1 = slowProxy('https://images.example/b1.png', { userId: 'bob' });
    // Drain all queued waves
    while (resolvers.length) {
      const batch = resolvers.splice(0);
      batch.forEach(fn => fn());
      await new Promise(r => setImmediate(r));
    }
    await expect(Promise.all([...gallery, ...extra, b1])).resolves.toHaveLength(12);

    // CW2-02: aborting caller 1 on a shared in-flight URL must NOT fail caller 2
    let finishShared;
    const sharedProxy = createMediaProxy({
      fetcher: (_u, opts) => new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        finishShared = () => resolve({ status: 200, headers: { 'content-type': 'image/png' }, bodyBuffer: png });
      }),
    });
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const w1 = sharedProxy('https://images.example/shared.png', { userId: 'alice', signal: ac1.signal });
    const w2 = sharedProxy('https://images.example/shared.png', { userId: 'bob', signal: ac2.signal });
    await new Promise(r => setImmediate(r));
    ac1.abort();
    await expect(w1).rejects.toMatchObject({ status: 499 });
    finishShared();
    await expect(w2).resolves.toMatchObject({ body: png });

    // CW2-01: Early header rejection rejects BOTH unsupported AND missing Content-Type before reading body
    for (const badHeaders of [{ 'content-type': 'text/html; charset=utf-8' }, {}]) {
      let bodyRead = false;
      const badStream = new Readable({
        read() { bodyRead = true; this.push(Buffer.from('<html>big page</html>')); this.push(null); },
      });
      badStream.headers = badHeaders;
      badStream.statusCode = 200;
      const earlySocket = transport(() => badStream);
      const earlyProxy = createMediaProxy({ dnsLookup: dns, fetcher: (u, opts) => safeFetch(u, { ...opts, requestImpl: earlySocket }) });
      await expect(earlyProxy('https://images.example/not-image')).rejects.toMatchObject({ status: 415 });
      expect(bodyRead).toBe(false);
    }
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

    // CW2-02: markAllRead returns signed graph media URLs bound to userId
    const marked = svc.markAllRead('alice', {});
    const pubNode = marked.graph.nodes.find(n => n.clusterId === pubId);
    expect(pubNode?.mediaPreview?.proxyUrl).toContain('&sig=');

    // CW2-01 & Round 3–11 Blocker: private RSS feed media and ALL embedded prose URL forms (alphanumeric sentinels so escapeMd can never mask a leak!)
    const secretMediaUrl = 'https://private.example/secret-token-img.png';
    const unicodePad = '\u0130'.repeat(120);
    const excerptSecretUrl = "https://files.example/o'brien-summary(v1).png?token=EXCERPTSECRET99";
    const unicodeSecretUrl = 'https://files.example/u0130.pdf?token=UNICODEDRIFTSECRET99';
    const wwwSecretUrl = 'www.private.example/sheet(1).pdf?token=WWWSECRET99';
    const schemeRelSecretUrl = '//cdn.private.example/att(1).png?token=SCHEMERELSECRET99';
    const ipv6RelSecretUrl = '(//[2001:db8::1]/vault/a.pdf?token=IPV6RELSECRET99)';
    const singleHostRelSecretUrl = '//intranet/files/doc.pdf?token=SINGLEHOSTSECRET99';
    const userinfoRelSecretUrl = '//user:pass@intranet:8080/doc?token=USERINFORELSECRET99';
    const boldUserinfoPortUrl = '//user:BOLDPORTPASS99@intranet:8080';
    const emUserinfoPortUrl = '//user:EMPORTPASS99@intranet:8443';
    const typoQuotePortUrl = '//user:TYPOQUOTEPASS99@intranet:8080';
    const cjkPeriodPortUrl = '//user:CJKPERIODPASS99@intranet:8080';
    const cjkBracketPortUrl = '//user:CJKBRACKETPASS99@intranet:8443';
    const enDashHttpUrl = 'https://files.example/report\u2013draft.pdf?token=ENDASHSECRET99';
    const enDashRelUrl = '//intranet/report\u2013draft.pdf?token=RELENDASHSECRET99';
    const cjkQueryUrl = 'https://files.example/doc?title=总结，草案&token=CJKQUERYSECRET99';
    const userinfoUnicodeProseUrl = '//user:USERINFODASHPASS99\u2013key@intranet:8080';
    const proseAtUrl = '//user:PROSEATPASS99@intranet:8080';
    const leadingPunctUserUrl = '//\u2013user:LEADPUNCTPASS99@intranet:8080';
    const comma70UserUrl = `//user:${'a,'.repeat(70)}COMMA70PASS99@intranet:8080`;
    const emojiPortUrl = '//user:PINEMOJIPASS99@intranet:8080';
    const bracketPortUrl = '//user:BRACKETPASS99@intranet:8080';
    const bracketProsePortUrl = '//user:BRACKETPROSE99@intranet:8080';
    const bracePortUrl = '//user:BRACEPASS99@intranet:8080';
    const pipePortUrl = '//user:PIPEPASS99@intranet:8080';
    const wrappedIpv6PortUrl = '//user:IPV6WRAPPASS99@[2001:db8::1]:8443';
    const wrappedIpv6NoPortUrl = '//user:IPV6NOPORT99@[2001:db8::1]';
    const underscoreRelUrl = '//user:UNDERSCOREPASS99@intranet:8080';
    const underscoreHttpUrl = 'https://files.example/u?token=UNDERHTTP99';
    const idnWwwUrl = 'www.例子.中国/a?token=IDNWWWSECRET99';
    const ideoDotWwwUrl = 'www\u3002例子\u3002中国/a?token=IDEODOTSECRET99';
    const snowmanWwwUrl = 'www.\u2603.example/a?token=SNOWMANSECRET99';
    const snowmanPortWwwUrl = 'www.\u2603.example:8080\u3002下一句';
    const bareSnowmanWwwUrl = 'www.\u2603';
    const ideoSnowmanWwwUrl = 'www\u3002\u2603';
    const rocketWwwUrl = 'www.\ud83d\ude80';
    const bracketSnowmanWwwUrl = '[www.\u2603]下一句';
    const fwQuerySnowmanWwwUrl = 'www.\u2603\uff1f下一句';
    const snowmanRelUrl = '//user:SNOWHOST99@\u2603';
    const snowmanRelQueryUrl = '//user:SNOWHOSTQ99@\u2603\uff1f下一句';
    const snowmanRelBracketUrl = '[//user:SNOWHOSTB99@\u2603]下一句';
    const snowmanHttpUrl = 'https://user:SNOWHTTP99@\u2603';
    const fwDotWwwUrl = 'www\uff0efiles\uff0eexample/doc?token=FWDOTSECRET99';
    const footnotePortSnowmanUrl = '//user:REVIEWPASS99@\u2603:8080[1]';
    const footnoteNoPortSnowmanUrl = '//user:REVIEWNOPORT99@\u2603[1]';
    const footnoteBareWwwSnowmanUrl = 'www.\u2603[1]';
    const footnoteIpv6Url = '//user:IPV6FOOTNOTE99@[2001:db8::1][1]';
    const footnoteIpv6PortUrl = '//user:IPV6PORTFOOT99@[2001:db8::1]:8080[1]';
    const unmatchedBrkIpv6Url = '//]user:UNMATCHEDBRK99@[2001:db8::1][1]';
    const portProseUrl = '//user:PORTPROSE99@intranet:8080下一句';
    const portParenUrl = '//user:PORTPAREN99@\u2603:8080(note)';
    const portBraceUrl = '//user:PORTBRACE99@\u2603:8080{1}';
    const ideoRelHost1 = '//privateidn1\u3002example';
    const ideoRelHost2 = '//privateidn2\uff0eexample';
    const ideoRelHost3 = '//privateidn3\uff61example';
    const ideoRelHost4 = '//privateidn4\u3002example\uff1f下一句';
    const ideoRelHost5 = '//privateidn5\u3002example[1]';
    const privItemWithImg = {
      ...item('Private img note', 'https://private.example/img-note'),
      summaryExcerpt: `${unicodePad} Private brief note visit www. visit www.\u3002 visit www.[1] //foo:bar[1] //注释\u3002 with ${excerptSecretUrl}, ${unicodeSecretUrl}, ${wwwSecretUrl}, ${schemeRelSecretUrl}, ${ipv6RelSecretUrl}, ${singleHostRelSecretUrl}, ${userinfoRelSecretUrl}, **${boldUserinfoPortUrl}**, “${typoQuotePortUrl}”, 请看${cjkPeriodPortUrl}。以及【${cjkBracketPortUrl}】, 请看${userinfoUnicodeProseUrl}。下一句 请看${proseAtUrl}。通知@ops:值班 ${leadingPunctUserUrl} 请看${comma70UserUrl}。下一句 ${emojiPortUrl}📌下一句 [${bracketPortUrl}] [${bracketProsePortUrl}]下一句 {${bracePortUrl}} |${pipePortUrl}| [${wrappedIpv6PortUrl}] [${wrappedIpv6NoPortUrl}]下一句 _${underscoreRelUrl}_ _${underscoreHttpUrl}_ _${idnWwwUrl}_ ${ideoDotWwwUrl} ${snowmanWwwUrl} ${snowmanPortWwwUrl} ${bareSnowmanWwwUrl} (${bareSnowmanWwwUrl}) ${ideoSnowmanWwwUrl} ${rocketWwwUrl} ${bracketSnowmanWwwUrl} ${fwQuerySnowmanWwwUrl} ${snowmanRelUrl} ${snowmanRelQueryUrl} ${snowmanRelBracketUrl} ${snowmanHttpUrl} ${fwDotWwwUrl} ${footnotePortSnowmanUrl} next ${footnoteNoPortSnowmanUrl} next ${footnoteBareWwwSnowmanUrl} next ${footnoteIpv6Url} next ${footnoteIpv6PortUrl} next ${unmatchedBrkIpv6Url} next ${portProseUrl} ${portParenUrl} next ${portBraceUrl} next ${ideoRelHost1} ${ideoRelHost2} ${ideoRelHost3} ${ideoRelHost4} ${ideoRelHost5} next foo_www.keepme ${enDashHttpUrl}, ${enDashRelUrl}, and ${cjkQueryUrl} //user:9876543210`,
      media: [{ url: secretMediaUrl, kind: 'image' }],
      excerptVersion: db.PRIVATE_EXCERPT_VERSION,
    };
    ingestCosmicWebItems(source('rss-priv-img', 'custom-sports', 'alice'), [privItemWithImg], NOW);
    const privBoot = svc.bootstrap('alice', 'user');
    const privNode = privBoot.graph.nodes.find(n => n.headline === 'Private img note');
    expect(privNode?.mediaPreview).toBeNull();
    expect(JSON.stringify(privBoot.graph)).not.toContain(secretMediaUrl);
    expect(JSON.stringify(svc.feed('alice', { domainId: 'custom-sports' }))).not.toContain(secretMediaUrl);
    const privDet = await svc.cluster('alice', privNode.clusterId);
    expect(privDet.media).toEqual([]);
    expect(JSON.stringify(privDet)).not.toContain(secretMediaUrl);
    // Round 6–22 Blocker #1/#2/#3: REAL extractCleanArticle -> aiBrief path with WHATWG bare www (ideographic dots, standalone symbol hosts, port+prose), >2048-char lookahead userinfo, truncated numeric password at EOF, wrapped portless IPv6, underscore-wrapped URLs, identifier preservation, and linear/bounded stress checks
    const privItemId = privDet.items[0].id;
    const angleParenUrl = 'https://files.example/report)v2.pdf?token=ANGLEPARENSECRET99';
    const parenSecretUrl = 'https://files.example/chart(v2).png?token=PRIVATESENTINEL99';
    const aposSecretUrl = "https://files.example/team's-deck.pdf?token=APOSSECRET99";
    const overlongPassUrl = `//user:${'a'.repeat(2100)}OVERLONGPASS99@intranet:8080/secret`;
    const overlongUserUrl = `//${'u'.repeat(2100)}OVERLONGUSER99@intranet:8080/secret`;
    const extractedPrivate = extractCleanArticle(
      `<article><h1>Private Memo</h1><p>${unicodePad} Quarterly notes visit www. visit www.\u3002 visit www.[1] // keep prose comment, //\u2013note: kept, //foo:bar[1], //注释\u3002, foo_www.keepme, <a href="${angleParenUrl}">Attachment</a>, bare ${parenSecretUrl}, (${parenSecretUrl}), ${aposSecretUrl}, ${unicodeSecretUrl}, ${wwwSecretUrl}, ${schemeRelSecretUrl}, ${ipv6RelSecretUrl}, ${singleHostRelSecretUrl}, ${userinfoRelSecretUrl}, <strong>${boldUserinfoPortUrl}</strong>, <em>${emUserinfoPortUrl}</em>, “${typoQuotePortUrl}”, 请看${cjkPeriodPortUrl}。以及【${cjkBracketPortUrl}】, 请看${userinfoUnicodeProseUrl}。下一句 请看${proseAtUrl}。通知@ops:值班 ${leadingPunctUserUrl} 请看${comma70UserUrl}。下一句 ${emojiPortUrl}📌下一句 [${bracketPortUrl}] [${bracketProsePortUrl}]下一句 {${bracePortUrl}} |${pipePortUrl}| [${wrappedIpv6PortUrl}] [${wrappedIpv6NoPortUrl}]下一句 _${underscoreRelUrl}_ _${underscoreHttpUrl}_ _${idnWwwUrl}_ ${ideoDotWwwUrl} ${snowmanWwwUrl} ${snowmanPortWwwUrl} ${bareSnowmanWwwUrl} (${bareSnowmanWwwUrl}) ${ideoSnowmanWwwUrl} ${rocketWwwUrl} ${bracketSnowmanWwwUrl} ${fwQuerySnowmanWwwUrl} ${snowmanRelUrl} ${snowmanRelQueryUrl} ${snowmanRelBracketUrl} ${snowmanHttpUrl} ${fwDotWwwUrl} ${footnotePortSnowmanUrl} next ${footnoteNoPortSnowmanUrl} next ${footnoteBareWwwSnowmanUrl} next ${footnoteIpv6Url} next ${footnoteIpv6PortUrl} next ${unmatchedBrkIpv6Url} next ${portProseUrl} ${portParenUrl} next ${portBraceUrl} next ${ideoRelHost1} ${ideoRelHost2} ${ideoRelHost3} ${ideoRelHost4} ${ideoRelHost5} next ${overlongPassUrl} ${overlongUserUrl} ${enDashHttpUrl}, ${enDashRelUrl}, and ${cjkQueryUrl}.</p></article>`,
      'https://private.example/img-note',
      'Private img note',
    );
    expect(extractedPrivate.markdown).toContain(`(<${angleParenUrl}>)`);
    expect(extractedPrivate.markdown).toContain('//\\[2001:db8::1\\]/vault/a.pdf?token=IPV6RELSECRET99');
    expect(extractedPrivate.markdown).toContain('//user:REVIEWPASS99@\u2603:8080\\[1\\] next');
    expect(extractedPrivate.markdown).toContain('www.\u2603\\[1\\] next');
    expect(extractedPrivate.markdown).toContain('//user:IPV6FOOTNOTE99@\\[2001:db8::1\\]\\[1\\] next');
    expect(extractedPrivate.markdown).toContain(`\\[${bracketPortUrl}\\]`);
    expect(extractedPrivate.markdown).toContain(`\\[${bracketProsePortUrl}\\]下一句`);
    expect(extractedPrivate.markdown).toContain('\\[//user:IPV6NOPORT99@\\[2001:db8::1\\]\\]下一句');
    expect(extractedPrivate.markdown).toContain(`\\_${underscoreRelUrl}\\_`);
    expect(extractedPrivate.markdown).toContain(`\\_${idnWwwUrl}\\_`);
    expect(extractedPrivate.markdown).toContain(ideoDotWwwUrl);
    expect(extractedPrivate.markdown).toContain(snowmanWwwUrl);
    expect(extractedPrivate.markdown).toContain(bareSnowmanWwwUrl);
    expect(extractedPrivate.markdown).toContain(overlongPassUrl);
    expect(extractedPrivate.markdown).toContain(`**${boldUserinfoPortUrl}**`);
    expect(extractedPrivate.markdown).toContain(`*${emUserinfoPortUrl}*`);
    expect(extractedPrivate.markdown).toContain(`“${typoQuotePortUrl}”`);
    expect(extractedPrivate.markdown).toContain(`${cjkPeriodPortUrl}。`);
    expect(extractedPrivate.markdown).toContain(`${userinfoUnicodeProseUrl}。下一句`);
    expect(extractedPrivate.markdown).toContain(`${proseAtUrl}。通知@ops:值班`);
    expect(extractedPrivate.markdown).toContain(leadingPunctUserUrl);
    expect(extractedPrivate.markdown).toContain(`${comma70UserUrl}。下一句`);
    expect(extractedPrivate.markdown).toContain(`${emojiPortUrl}📌下一句`);
    expect(extractedPrivate.markdown).toContain('report\u2013draft.pdf?token=ENDASHSECRET99');
    db.setArticleCache('alice', privItemId, {
      ...extractedPrivate, itemId: privItemId, clusterId: privNode.clusterId, summaryExcerpt: privItemWithImg.summaryExcerpt,
    }, NOW + HOUR);
    const cleanPrivateArt = await svc.article('alice', privNode.clusterId, { itemId: privItemId });
    expect(cleanPrivateArt.markdown).toContain('ANGLEPARENSECRET99');
    await svc.aiBrief('alice', 'user', privNode.clusterId, { research: true, force: true });
    const privBriefJson = JSON.stringify(requestAi.mock.lastCall[0].payload);
    for (const secret of [secretMediaUrl, 'PRIVATESENTINEL99', 'ANGLEPARENSECRET99', 'APOSSECRET99', 'UNICODEDRIFTSECRET99',
      'WWWSECRET99', 'SCHEMERELSECRET99', 'IPV6RELSECRET99', 'SINGLEHOSTSECRET99', 'USERINFORELSECRET99',
      'BOLDPORTPASS99', 'EMPORTPASS99', 'TYPOQUOTEPASS99', 'CJKPERIODPASS99', 'CJKBRACKETPASS99',
      'USERINFODASHPASS99', 'PROSEATPASS99', 'LEADPUNCTPASS99', 'COMMA70PASS99', 'PINEMOJIPASS99',
      'BRACKETPASS99', 'BRACKETPROSE99', 'BRACEPASS99', 'PIPEPASS99', 'IPV6WRAPPASS99',
      'IPV6NOPORT99', 'UNDERSCOREPASS99', 'UNDERHTTP99', 'IDNWWWSECRET99', 'IDEODOTSECRET99',
      'SNOWMANSECRET99', 'SNOWHOST99', 'SNOWHOSTQ99', 'SNOWHOSTB99', 'SNOWHTTP99', '\u2603', '\ud83d\ude80',
      'REVIEWPASS99', 'REVIEWNOPORT99', 'IPV6FOOTNOTE99', 'IPV6PORTFOOT99', 'UNMATCHEDBRK99',
      'PORTPROSE99', 'PORTPAREN99', 'PORTBRACE99',
      'privateidn1', 'privateidn2', 'privateidn3', 'privateidn4', 'privateidn5',
      'OVERLONGPASS99', 'OVERLONGUSER99', 'FWDOTSECRET99', '9876543210',
      'ENDASHSECRET99', 'RELENDASHSECRET99', 'CJKQUERYSECRET99', 'EXCERPTSECRET99']) {
      expect(privBriefJson).not.toContain(secret);
    }
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('Attachment');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('visit www.');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('visit www.\u3002');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('visit www.\\[1\\]');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('// keep prose comment');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('//\u2013note: kept');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('//foo:bar\\[1\\]');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('//注释\u3002');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('foo\\_www.keepme');
    // Round 20–23 Blocker #1/#2/#3 & Nit: Real private RSS ingestion normalizes entities ONCE (never double-decoding after the 1,000-char clip),
    // redacts BEFORE 1,000-char clip, bounds CPU fail-closed on a ~1.8 MiB adversarial dense-invalid-authority payload,
    // proves URL-check budget exhaustion discards a nearby harmless tail marker while output stays well under 1,000 chars,
    // and uncached followUp scrubs request briefContext BEFORE enforcing the 1,500-char limit (even for username-only userinfo).
    const pad982 = 'x'.repeat(982);
    const pad973 = 'x'.repeat(973);
    const dosPayload = `${'//a.b:bad,c,d,e,f,g,h '.repeat(80_000)} //user:DOSTAIL99@intranet:8080`;
    const budgetExhaustPayload = `${'//intranet/p '.repeat(270)} HARMLESSBUDGETMARKER99 //user:BUDGETSECRET99@intranet:8080`;
    const boundaryRss = `<rss><channel>
      <item><title>Boundary RSS Memo</title><link>https://private.example/boundary</link><description>${pad982} //user:CLIPPASS99@intranet:8080 trailing</description></item>
      <item><title>Adversarial Dense RSS</title><link>https://private.example/dos</link><description>${dosPayload}</description></item>
      <item><title>Budget Exhaustion RSS</title><link>https://private.example/budget</link><description>${budgetExhaustPayload}</description></item>
      <item><title>Double Escaped Cdata Payload</title><link>https://private.example/double-entity</link><description><![CDATA[${pad973} &amp;#47;&amp;#47;CDATAENTITY99@intranet:8080/api]]></description></item>
      <item><title>Plain Xml Encoded Slashes</title><link>https://private.example/xml-entity</link><description>${pad973} &amp;#47;&amp;#47;XMLENTITYSECRET99@intranet:8080/api</description></item>
      <item><title>Single Numeric Reference Feed</title><link>https://private.example/cdata-entity</link><description><![CDATA[${pad973} &#47;&#47;SINGLECDATASECRET99@intranet:8080/api]]></description></item>
    </channel></rss>`;
    const rssSvc = makeService({
      fetcher: async () => ({ status: 200, url: 'https://private.example/boundary.xml', text: async () => boundaryRss }),
      requestAi,
    });
    await rssSvc.savePreferences('grace', {
      enabledDomainIds: [],
      customDomains: [{ id: 'priv-clip', name: 'Priv Clip', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: ['https://private.example/boundary.xml'] }],
    });
    const tDos0 = performance.now();
    await rssSvc.refresh('grace', { domainId: 'priv-clip', force: true });
    expect(performance.now() - tDos0).toBeLessThan(250);
    const graceFeed = rssSvc.feed('grace', { domainId: 'priv-clip' });
    expect(graceFeed.clusters).toHaveLength(6);
    const boundaryCluster = graceFeed.clusters.find(c => c.headline === 'Boundary RSS Memo');
    const dosCluster = graceFeed.clusters.find(c => c.headline === 'Adversarial Dense RSS');
    const budgetCluster = graceFeed.clusters.find(c => c.headline === 'Budget Exhaustion RSS');
    const doubleEntityCluster = graceFeed.clusters.find(c => c.headline === 'Double Escaped Cdata Payload');
    const xmlEntityCluster = graceFeed.clusters.find(c => c.headline === 'Plain Xml Encoded Slashes');
    const singleCdataCluster = graceFeed.clusters.find(c => c.headline === 'Single Numeric Reference Feed');
    expect(boundaryCluster.summaryExcerpt).not.toContain('CLIPPASS99');
    expect(dosCluster.summaryExcerpt).not.toContain('DOSTAIL99');
    // No second cleanText() pass on RSS rows: double-encoded &amp;#47; inside CDATA stays literal &#47; (never decoded into // after clipping),
    // while genuine XML-escaped and single-encoded CDATA entities decode to // BEFORE scrubbing and clipping.
    expect(doubleEntityCluster.summaryExcerpt).not.toContain('//CDATAENTITY99');
    expect(doubleEntityCluster.summaryExcerpt).toContain('&#47;&#47;');
    expect(xmlEntityCluster.summaryExcerpt).not.toContain('XMLENTITYSECRET99');
    expect(singleCdataCluster.summaryExcerpt).not.toContain('SINGLECDATASECRET99');
    // Output after 256 redactions is only ~256 spaces (<< 1,000), proving URL-check budget exhaustion (not maxOutputChars) discarded the tail.
    expect(budgetCluster.summaryExcerpt.length).toBeLessThan(400);
    expect(budgetCluster.summaryExcerpt).not.toContain('HARMLESSBUDGETMARKER99');
    expect(budgetCluster.summaryExcerpt).not.toContain('BUDGETSECRET99');
    agents.set('v2-grace', { ownerId: 'grace', name: 'v2-grace', capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up'], encryptOutbound: false, ws: { readyState: 1, send: () => {} } });
    // Unauthenticated client-supplied briefContext (even claiming current version) MUST be rejected on private sources,
    // while server-owned briefContext straddling 1,500 chars MUST scrub before clipping.
    const boundaryBriefContext = `${'x'.repeat(1490)} //USERONLYCTXSECRET99@intranet:8080/api`;
    await rssSvc.followUp('grace', 'user', boundaryCluster.id, {
      question: 'Unauthenticated client echo?', briefContext: boundaryBriefContext, briefContextVersion: PRIVATE_BRIEF_CONTEXT_VERSION, research: true,
    });
    expect(requestAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    const boundaryDet = await rssSvc.cluster('grace', boundaryCluster.id);
    const boundaryBriefKey = createHash('sha256').update(JSON.stringify([5, 'brief-context', PRIVATE_BRIEF_CONTEXT_VERSION, boundaryCluster.id, boundaryDet.items[0].id, 'v2-grace'])).digest('hex');
    db.setAiCache('grace', boundaryBriefKey, boundaryBriefContext, NOW + HOUR);
    await rssSvc.followUp('grace', 'user', boundaryCluster.id, {
      question: 'Server-cached boundary follow-up?', research: true,
    });
    const cachedBoundaryFuPayload = requestAi.mock.lastCall[0].payload;
    expect(cachedBoundaryFuPayload.briefContext.length).toBeLessThanOrEqual(1500);
    expect(JSON.stringify(cachedBoundaryFuPayload)).not.toContain('USERONLYCTXSECRET99');
    expect(JSON.stringify(cachedBoundaryFuPayload)).not.toContain('CLIPPASS99');
    await rssSvc.aiBrief('grace', 'user', boundaryCluster.id, { skipArticleFetch: true, research: true });
    expect(JSON.stringify(requestAi.mock.lastCall[0].payload)).not.toContain('CLIPPASS99');
    await rssSvc.followUp('grace', 'user', boundaryCluster.id, { question: 'Summary?', research: true });
    expect(JSON.stringify(requestAi.mock.lastCall[0].payload)).not.toContain('CLIPPASS99');
    // Round 19 Blocker #3: 39,000-backslash run after URL must redact linearly (< 150ms, never quadratic)
    const bsPayload = `KeepBS https://files.example/a?token=BSSTRESS99${'\\'.repeat(39_000)}]`;
    db.setArticleCache('alice', privItemId, {
      title: 'Backslash stress', markdown: bsPayload, aiMarkdown: bsPayload,
      extractorVersion: ARTICLE_EXTRACTOR_VERSION, truncated: false,
      quality: 'full', itemId: privItemId, clusterId: privNode.clusterId, summaryExcerpt: 'Stress',
    }, NOW + HOUR);
    const tBs0 = performance.now();
    await svc.aiBrief('alice', 'user', privNode.clusterId, { research: true, force: true });
    expect(performance.now() - tBs0).toBeLessThan(150);
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('KeepBS');
    expect(JSON.stringify(requestAi.mock.lastCall[0].payload)).not.toContain('BSSTRESS99');
    // Round 6–23: followUp redacts all alphanumeric sentinels directly in summaryExcerpt (including footnotes after symbol/IPv6/port authorities, WHATWG dot scheme-relative hosts, truncated numeric password at EOF & WHATWG bare www)
    await svc.followUp('alice', 'user', privNode.clusterId, { question: 'Any updates?', research: true });
    const privFuJson = JSON.stringify(requestAi.mock.lastCall[0].payload);
    for (const secret of [secretMediaUrl, 'EXCERPTSECRET99', 'UNICODEDRIFTSECRET99', 'WWWSECRET99',
      'SCHEMERELSECRET99', 'IPV6RELSECRET99', 'SINGLEHOSTSECRET99', 'USERINFORELSECRET99',
      'BOLDPORTPASS99', 'TYPOQUOTEPASS99', 'CJKPERIODPASS99', 'CJKBRACKETPASS99',
      'USERINFODASHPASS99', 'PROSEATPASS99', 'LEADPUNCTPASS99', 'COMMA70PASS99', 'PINEMOJIPASS99',
      'BRACKETPASS99', 'BRACKETPROSE99', 'BRACEPASS99', 'PIPEPASS99', 'IPV6WRAPPASS99',
      'IPV6NOPORT99', 'UNDERSCOREPASS99', 'UNDERHTTP99', 'IDNWWWSECRET99', 'IDEODOTSECRET99',
      'SNOWMANSECRET99', 'SNOWHOST99', 'SNOWHOSTQ99', 'SNOWHOSTB99', 'SNOWHTTP99', '\u2603', '\ud83d\ude80',
      'REVIEWPASS99', 'REVIEWNOPORT99', 'IPV6FOOTNOTE99', 'IPV6PORTFOOT99', 'UNMATCHEDBRK99',
      'PORTPROSE99', 'PORTPAREN99', 'PORTBRACE99',
      'privateidn1', 'privateidn2', 'privateidn3', 'privateidn4', 'privateidn5',
      'FWDOTSECRET99', '9876543210',
      'ENDASHSECRET99', 'RELENDASHSECRET99', 'CJKQUERYSECRET99']) {
      expect(privFuJson).not.toContain(secret);
    }
    expect(requestAi.mock.lastCall[0].payload.summaryExcerpt).toContain('foo_www.keepme');
    expect(requestAi.mock.lastCall[0].payload.summaryExcerpt).toContain('visit www.');
    expect(requestAi.mock.lastCall[0].payload.summaryExcerpt).toContain('visit www.\u3002');
    expect(requestAi.mock.lastCall[0].payload.summaryExcerpt).toContain('visit www.[1]');
    expect(requestAi.mock.lastCall[0].payload.summaryExcerpt).toContain('//foo:bar[1]');
    expect(requestAi.mock.lastCall[0].payload.summaryExcerpt).toContain('//注释\u3002');

    // Round 24 (PR #2032 Round 3) Blocker #1/#2/#3 isolated regressions:
    // (1) post-@ 64-cut saturation before IPv6 close & non-IPv6 host+footnote (raw & Markdown-escaped),
    // (2) percent-encoded WHATWG dot separators in portless/pathless // and bare-www hosts (with footnotes & prose guards),
    // (3) Clean Article 40,000-char cap (fresh & legacy cache) + >2 MiB HTML cap truncating username-only //USER before @host
    //     while keeping the Clean Article display/cache contract intact.
    const r3OverflowRaw = `//u@:bad,${'a,'.repeat(66)}IPV6CUTOVF99@[2001:db8::1][1] next //u@:bad,${'a,'.repeat(66)}HOSTCUTOVF99@\u2603[1] next www.:bad,${'a,'.repeat(66)}WWWCUTOVF99@[2001:db8::1][1] next`;
    const r3PctDotsRaw = 'Keep //50%增长 visit www%2e visit www%2e[1] //pcthost1%2eexample //pcthost2%2Eexample //pcthost3%e3%80%82example //pcthost4%ef%bc%8eexample //pcthost5%ef%bd%a1example //pcthost6%2eexample[1] next //pcthost7%e3%80%82example[1] next //pcthost8%ef%bc%8eexample\uff1f下一句 //pcthost9%ef%bd%a1example(note) next www%2epctwww1.example www%e3%80%82pctwww2[1] next';
    const r3ArticleHtml = `<article><p>https://cdn.example/${'a'.repeat(39_950)} Keep safe prose //TRUNCUSERONLY99@intranet:8080/secret</p></article>`;
    const r3Rss = `<rss><channel>
      <item><title>R3 Cut Overflow Memo</title><link>https://private.example/r3-overflow</link><description>${r3OverflowRaw}</description></item>
      <item><title>R3 Percent Dot Memo</title><link>https://private.example/r3-pctdot</link><description>${r3PctDotsRaw}</description></item>
      <item><title>R3 Extractor Truncation Memo</title><link>https://private.example/r3-trunc</link><description>Short summary</description></item>
    </channel></rss>`;
    const r3Svc = makeService({
      fetcher: async url => {
        if (url.endsWith('.xml')) return { status: 200, url, text: async () => r3Rss };
        if (url.endsWith('/r3-trunc')) return { status: 200, url, text: async () => r3ArticleHtml };
        return { status: 200, url, text: async () => `<article><p>${r3OverflowRaw} ${r3PctDotsRaw}</p></article>` };
      },
      requestAi,
    });
    await r3Svc.savePreferences('heidi', {
      enabledDomainIds: [],
      customDomains: [{ id: 'priv-r3', name: 'Priv R3', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: ['https://private.example/r3.xml'] }],
    });
    await r3Svc.refresh('heidi', { domainId: 'priv-r3', force: true });
    const heidiFeed = r3Svc.feed('heidi', { domainId: 'priv-r3' });
    expect(heidiFeed.clusters).toHaveLength(3);
    const r3OverflowCluster = heidiFeed.clusters.find(c => c.headline === 'R3 Cut Overflow Memo');
    const r3PctCluster = heidiFeed.clusters.find(c => c.headline === 'R3 Percent Dot Memo');
    const r3TruncCluster = heidiFeed.clusters.find(c => c.headline === 'R3 Extractor Truncation Memo');
    for (const secret of ['IPV6CUTOVF99', 'HOSTCUTOVF99', 'WWWCUTOVF99']) {
      expect(r3OverflowCluster.summaryExcerpt).not.toContain(secret);
    }
    for (const secret of ['pcthost1', 'pcthost2', 'pcthost3', 'pcthost4', 'pcthost5', 'pcthost6', 'pcthost7', 'pcthost8', 'pcthost9', 'pctwww1', 'pctwww2']) {
      expect(r3PctCluster.summaryExcerpt).not.toContain(secret);
    }
    expect(r3PctCluster.summaryExcerpt).toContain('//50%增长');
    expect(r3PctCluster.summaryExcerpt).toContain('visit www%2e');
    expect(r3PctCluster.summaryExcerpt).toContain('visit www%2e[1]');
    agents.set('v2-heidi', { ownerId: 'heidi', name: 'v2-heidi', capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up'], encryptOutbound: false, ws: { readyState: 1, send: () => {} } });
    // Defense-in-depth scrubbing of server-owned followUp briefContext + Markdown-escaped article extraction -> aiBrief for Blocker #1 & #2
    const r3OverflowDet = await r3Svc.cluster('heidi', r3OverflowCluster.id);
    const r3OverflowBriefKey = createHash('sha256').update(JSON.stringify([5, 'brief-context', PRIVATE_BRIEF_CONTEXT_VERSION, r3OverflowCluster.id, r3OverflowDet.items[0].id, 'v2-heidi'])).digest('hex');
    db.setAiCache('heidi', r3OverflowBriefKey, `${r3OverflowRaw} ${r3PctDotsRaw}`, NOW + HOUR);
    await r3Svc.followUp('heidi', 'user', r3OverflowCluster.id, {
      question: 'Check overflow?', research: true,
    });
    const r3OverflowFuJson = JSON.stringify(requestAi.mock.lastCall[0].payload);
    for (const secret of ['IPV6CUTOVF99', 'HOSTCUTOVF99', 'WWWCUTOVF99', 'pcthost1', 'pcthost2', 'pcthost3', 'pcthost4', 'pcthost5', 'pcthost6', 'pcthost7', 'pcthost8', 'pcthost9', 'pctwww1', 'pctwww2']) {
      expect(r3OverflowFuJson).not.toContain(secret);
    }
    expect(requestAi.mock.lastCall[0].payload.briefContext).toContain('//50%增长');
    expect(requestAi.mock.lastCall[0].payload.briefContext).toContain('visit www%2e');
    expect(requestAi.mock.lastCall[0].payload.briefContext).toContain('visit www%2e[1]');
    await r3Svc.aiBrief('heidi', 'user', r3OverflowCluster.id, { research: true });
    const r3OverflowBriefJson = JSON.stringify(requestAi.mock.lastCall[0].payload);
    for (const secret of ['IPV6CUTOVF99', 'HOSTCUTOVF99', 'WWWCUTOVF99', 'pcthost1', 'pcthost2', 'pcthost3', 'pcthost4', 'pcthost5', 'pcthost6', 'pcthost7', 'pcthost8', 'pcthost9', 'pctwww1', 'pctwww2']) {
      expect(r3OverflowBriefJson).not.toContain(secret);
    }
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('//50%增长');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('visit www%2e');
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('visit www%2e\\[1\\]');
    // Blocker #3: Clean Article preserves exact 40,000-char display/cache contract while aiBrief omits the truncated username-only //TRUNCUSER fragment
    const cleanTrunc = await r3Svc.article('heidi', r3TruncCluster.id);
    expect(cleanTrunc.markdown).toHaveLength(40_000);
    expect(cleanTrunc.truncated).toBe(true);
    expect(cleanTrunc.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
    expect(cleanTrunc.aiMarkdown).toBeUndefined();
    expect(cleanTrunc.markdown).toContain('//TRUNCUSER');
    await r3Svc.aiBrief('heidi', 'user', r3TruncCluster.id, { research: true });
    const r3TruncBriefPayload = requestAi.mock.lastCall[0].payload;
    expect(r3TruncBriefPayload.articleMarkdown).toContain('Keep safe prose');
    expect(JSON.stringify(r3TruncBriefPayload)).not.toContain('TRUNCUSER');
    expect(JSON.stringify(r3TruncBriefPayload)).not.toContain('cdn.example');
    // >2 MiB HTML markup cap yields <40k markdown with truncated: true -> aiBrief still drops the truncated trailing token
    const r3TruncItemId = cleanTrunc.itemId;
    const bigHtmlExtracted = extractCleanArticle(
      `<script>${'x'.repeat(2_097_112)}</script><p>Safe //BIGHTMLTRUNC99@intranet:8080</p>`,
      'https://private.example/r3-big',
    );
    expect(bigHtmlExtracted.truncated).toBe(true);
    expect(bigHtmlExtracted.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
    expect(bigHtmlExtracted.markdown).toContain('//BIGHTMLTRUNC');
    expect(bigHtmlExtracted.markdown.length).toBeLessThan(40_000);
    db.setArticleCache('heidi', r3TruncItemId, {
      ...bigHtmlExtracted, itemId: r3TruncItemId, clusterId: r3TruncCluster.id, summaryExcerpt: 'Big',
    }, NOW + HOUR);
    await r3Svc.aiBrief('heidi', 'user', r3TruncCluster.id, { research: true, force: true });
    expect(requestAi.mock.lastCall[0].payload.articleMarkdown).toContain('Safe');
    expect(JSON.stringify(requestAi.mock.lastCall[0].payload)).not.toContain('BIGHTMLTRUNC');

    // Round 25 (PR #2032 Round 4) Blocker #1 & #2 isolated end-to-end regressions:
    // (1) 2 MiB scan cap & MAX_TAGS cap cutting inside <pre> / <code> / nested wrappers (where markdown() appends closing fences/backticks):
    //     Clean Article display keeps full closing fences intact, while aiBrief -> real Agent runCosmicWebBriefing model prompt NEVER receives the cut username fragment.
    // (2) Unversioned legacy article_cache rows (both short <40k byte-capped rows and 40k rows) without extractorVersion/truncated provenance:
    //     Clean Article display reads them intact, while private aiBrief re-extracts (upgrading cache when live) or omits them (when skipArticleFetch or offline, without clobbering legacy display cache).
    const r4PreHtml = `<script>${'x'.repeat(2_097_070)}</script><article><p>Safe pre intro.</p><pre>const preVal = //PRETRUNCUSER99@intranet:8080</pre></article>`;
    const r4CodeHtml = `<script>${'x'.repeat(2_097_062)}</script><article><p>Safe inline code <code>const codeVal = //CODETRUNCUSER99@intranet:8080</code></p></article>`;
    const r4NestedHtml = `<script>${'x'.repeat(2_097_048)}</script><article><p>Safe nested <a href="https://intranet.local/doc"><code>//LINKCODETRUNC99@intranet:8080</code></a></p></article>`;
    const r4BqPreHtml = `<script>${'x'.repeat(2_097_062)}</script><article><blockquote><p>Safe quote.</p><pre>const q = //BQPRETRUNC99@intranet:8080</pre></blockquote></article>`;
    const r4TagCapHtml = `<article><p>Safe tag cap.</p>${'<span></span>'.repeat(14_998)}<pre>const t = //TAGCAPTRUNC99<span>@intranet:8080</span></pre></article>`;
    const r4RssTagCapDesc = `<![CDATA[${'<span></span>'.repeat(15_000)}Safe rss tags //RSSTAGCAP99<span>@intranet:8080</span>]]>`;
    const r4Rss = `<rss><channel>
      <item><title>Preformatted Fenced Document</title><link>https://private.example/r4-pre</link><description>Pre summary</description></item>
      <item><title>Inline Backtick Snippet</title><link>https://private.example/r4-code</link><description>Code summary</description></item>
      <item><title>Legacy Cached Briefing</title><link>https://private.example/r4-legacy</link><description>Legacy summary</description></item>
      <item><title>Dense Tag Description</title><link>https://private.example/r4-rsstag</link><description>${r4RssTagCapDesc}</description></item>
    </channel></rss>`;
    let r4LegacyFetchMode = 'live';
    let r4LegacyFetchCount = 0;
    const r4CapturedPrompts = [];
    const r4AgentAi = vi.fn(async ({ mode, perspective, language, payload }) => {
      const adapter = {
        async call(req) {
          r4CapturedPrompts.push(JSON.stringify(req));
          return { text: JSON.stringify({ tldr: 'ok', bullets: ['one', 'two'], impact: 'ok', followUps: ['q1', 'q2'] }) };
        },
      };
      const { result } = await runCosmicWebBriefing({
        mode, perspective, language, payload,
        config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
        adapter,
      });
      return result;
    });
    const r4Svc = makeService({
      fetcher: async url => {
        if (url.endsWith('.xml')) return { status: 200, url, text: async () => r4Rss };
        if (url.endsWith('/r4-pre')) return { status: 200, url, text: async () => r4PreHtml };
        if (url.endsWith('/r4-code')) return { status: 200, url, text: async () => r4CodeHtml };
        if (url.endsWith('/r4-legacy')) {
          r4LegacyFetchCount++;
          if (r4LegacyFetchMode === 'offline') return { status: 503, url, text: async () => 'unavailable' };
          return { status: 200, url, text: async () => r4PreHtml };
        }
        return { status: 200, url, text: async () => '<article><p>ok</p></article>' };
      },
      requestAi: r4AgentAi,
    });
    await r4Svc.savePreferences('ivan', {
      enabledDomainIds: [],
      customDomains: [{ id: 'priv-r4', name: 'Priv R4', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: ['https://private.example/r4.xml'] }],
    });
    await r4Svc.refresh('ivan', { domainId: 'priv-r4', force: true });
    const ivanFeed = r4Svc.feed('ivan', { domainId: 'priv-r4' });
    expect(ivanFeed.clusters).toHaveLength(4);
    const r4PreCluster = ivanFeed.clusters.find(c => c.headline === 'Preformatted Fenced Document');
    const r4CodeCluster = ivanFeed.clusters.find(c => c.headline === 'Inline Backtick Snippet');
    const r4LegacyCluster = ivanFeed.clusters.find(c => c.headline === 'Legacy Cached Briefing');
    const r4RssTagCluster = ivanFeed.clusters.find(c => c.headline === 'Dense Tag Description');
    // Private RSS CDATA >30,000-tag cap drops truncated trailing token before scrubbing
    expect(r4RssTagCluster.summaryExcerpt).toContain('Safe rss tags');
    expect(r4RssTagCluster.summaryExcerpt).not.toContain('RSSTAGCAP99');
    agents.set('v2-ivan', { ownerId: 'ivan', name: 'v2-ivan', capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up'], encryptOutbound: false, ws: { readyState: 1, send: () => {} } });

    // (1a) <pre> cut by 2 MiB scan cap: Clean Article display keeps closing fence + raw text, while aiBrief -> Agent prompt drops //PRETRUNCUSER
    const r4PreArt = await r4Svc.article('ivan', r4PreCluster.id);
    expect(r4PreArt.truncated).toBe(true);
    expect(r4PreArt.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
    expect(r4PreArt.aiMarkdown).toBeUndefined();
    expect(r4PreArt.markdown).toContain('```\nconst preVal = //PRETRUNCUSER');
    expect(r4PreArt.markdown.endsWith('\n```')).toBe(true);
    await r4Svc.aiBrief('ivan', 'user', r4PreCluster.id, { research: true });
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toContain('Safe pre intro.');
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toContain('const preVal =');
    expect(JSON.stringify(r4AgentAi.mock.lastCall[0].payload)).not.toContain('PRETRUNCUSER');
    expect(r4CapturedPrompts.at(-1)).toContain('Safe pre intro.');
    expect(r4CapturedPrompts.at(-1)).not.toContain('PRETRUNCUSER');

    // (1b) <code> cut by 2 MiB scan cap: Clean Article display keeps closing backtick + raw text, while aiBrief -> Agent prompt drops //CODETRUNCUSER
    const r4CodeArt = await r4Svc.article('ivan', r4CodeCluster.id);
    expect(r4CodeArt.truncated).toBe(true);
    expect(r4CodeArt.markdown).toContain('` const codeVal = //CODETRUNCUSER');
    expect(r4CodeArt.markdown.endsWith(' `')).toBe(true);
    await r4Svc.aiBrief('ivan', 'user', r4CodeCluster.id, { research: true });
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toContain('Safe inline code');
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toContain('const codeVal =');
    expect(JSON.stringify(r4AgentAi.mock.lastCall[0].payload)).not.toContain('CODETRUNCUSER');
    expect(r4CapturedPrompts.at(-1)).toContain('Safe inline code');
    expect(r4CapturedPrompts.at(-1)).not.toContain('CODETRUNCUSER');

    // (1c) Nested <a><code>, <blockquote><pre>, and MAX_TAGS (30,000) cap inside <pre>
    for (const [html, safeText, secretFrag] of [
      [r4NestedHtml, 'Safe nested', 'LINKCODETRUNC'],
      [r4BqPreHtml, 'Safe quote.', 'BQPRETRUNC'],
      [r4TagCapHtml, 'Safe tag cap.', 'TAGCAPTRUNC'],
    ]) {
      const ext = extractCleanArticle(html, 'https://private.example/r4-nested');
      expect(ext.truncated).toBe(true);
      expect(ext.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
      expect(ext.markdown).toContain(secretFrag);
      expect(ext.aiMarkdown).toContain(safeText);
      expect(ext.aiMarkdown).not.toContain(secretFrag);
      expect(ext.aiMarkdown).not.toContain('intranet.local');
    }

    // (2a) Unversioned SHORT (<40k) legacy cache row (no extractorVersion, no truncated flag):
    // Clean Article display reads it intact; skipArticleFetch omits it from AI; offline origin omits it without clobbering legacy display cache; live origin re-extracts & upgrades safely.
    const r4LegacyClusterDetail = await r4Svc.cluster('ivan', r4LegacyCluster.id);
    const r4LegacyItemId = r4LegacyClusterDetail.items[0].id;
    const shortLegacyMd = 'Safe legacy short\n\n```\nconst u = //LEGACYSHORTUSER\n```';
    db.setArticleCache('ivan', r4LegacyItemId, {
      title: 'Legacy short byte-capped cache',
      markdown: shortLegacyMd,
      quality: 'full', itemId: r4LegacyItemId, clusterId: r4LegacyCluster.id, summaryExcerpt: 'Legacy short',
    }, NOW + HOUR);
    // Clean Article display still serves legacy cache row intact without refetching
    const legacyDisplayBefore = await r4Svc.article('ivan', r4LegacyCluster.id);
    expect(legacyDisplayBefore.markdown).toBe(shortLegacyMd);
    expect(r4LegacyFetchCount).toBe(0);
    // Private aiBrief with skipArticleFetch omits unversioned legacy private Markdown completely
    await r4Svc.aiBrief('ivan', 'user', r4LegacyCluster.id, { skipArticleFetch: true, research: true, force: true });
    expect(r4LegacyFetchCount).toBe(0);
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toBeUndefined();
    expect(JSON.stringify(r4AgentAi.mock.lastCall[0].payload)).not.toContain('LEGACYSHORTUSER');
    expect(r4CapturedPrompts.at(-1)).not.toContain('LEGACYSHORTUSER');
    // Private aiBrief when origin is offline attempts re-extract, omits unversioned legacy Markdown on failure, AND preserves legacy display cache
    r4LegacyFetchMode = 'offline';
    await r4Svc.aiBrief('ivan', 'user', r4LegacyCluster.id, { research: true, force: true });
    expect(r4LegacyFetchCount).toBe(1);
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toBeUndefined();
    expect(JSON.stringify(r4AgentAi.mock.lastCall[0].payload)).not.toContain('LEGACYSHORTUSER');
    expect(r4CapturedPrompts.at(-1)).not.toContain('LEGACYSHORTUSER');
    const legacyDisplayAfterOffline = await r4Svc.article('ivan', r4LegacyCluster.id);
    expect(legacyDisplayAfterOffline.markdown).toBe(shortLegacyMd);
    expect(r4LegacyFetchCount).toBe(1);
    // Private aiBrief when origin is live re-extracts with v2 provenance, upgrades cache, keeps safe prose, and leaks NEITHER legacy NOR fresh truncated username fragment
    r4LegacyFetchMode = 'live';
    await r4Svc.aiBrief('ivan', 'user', r4LegacyCluster.id, { research: true, force: true });
    expect(r4LegacyFetchCount).toBe(2);
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toContain('Safe pre intro.');
    expect(JSON.stringify(r4AgentAi.mock.lastCall[0].payload)).not.toContain('LEGACYSHORTUSER');
    expect(JSON.stringify(r4AgentAi.mock.lastCall[0].payload)).not.toContain('PRETRUNCUSER');
    expect(r4CapturedPrompts.at(-1)).toContain('Safe pre intro.');
    expect(r4CapturedPrompts.at(-1)).not.toContain('LEGACYSHORTUSER');
    expect(r4CapturedPrompts.at(-1)).not.toContain('PRETRUNCUSER');
    // Legacy 40,000-char cache row without extractorVersion is also omitted under skipArticleFetch (and display reads remain intact)
    const legacy40kMd = `https://cdn.example/${'a'.repeat(39_950)} Legacy safe //LEGACYTRUNCUSER`;
    expect(legacy40kMd).toHaveLength(40_000);
    db.setArticleCache('ivan', r4LegacyItemId, {
      title: 'Legacy 40k cache',
      markdown: legacy40kMd,
      quality: 'full', itemId: r4LegacyItemId, clusterId: r4LegacyCluster.id, summaryExcerpt: 'Legacy 40k',
    }, NOW + HOUR);
    expect((await r4Svc.article('ivan', r4LegacyCluster.id)).markdown).toBe(legacy40kMd);
    await r4Svc.aiBrief('ivan', 'user', r4LegacyCluster.id, { skipArticleFetch: true, research: true, force: true });
    expect(r4AgentAi.mock.lastCall[0].payload.articleMarkdown).toBeUndefined();
    expect(JSON.stringify(r4AgentAi.mock.lastCall[0].payload)).not.toContain('LEGACYTRUNCUSER');
    expect(r4CapturedPrompts.at(-1)).not.toContain('LEGACYTRUNCUSER');
    // Public source legacy unversioned cache row is still reused directly by aiBrief without forcing an article refetch
    const pubDetailForLegacy = await svc.cluster('alice', pubId);
    const pubLegacyItemId = pubDetailForLegacy.items[0].id;
    db.setArticleCache('alice', pubLegacyItemId, {
      title: 'Public legacy cache', markdown: 'Public legacy article body',
      quality: 'full', itemId: pubLegacyItemId, clusterId: pubId, summaryExcerpt: 'Public legacy',
    }, NOW + HOUR);
    const pubLegacyReqAi = vi.fn(async () => storyResult);
    const pubLegacySvc = makeService({
      fetcher: async () => ({ status: 200, url: 'https://public.example/ai', text: async () => '<article><p>refetched-public-body</p></article>' }),
      requestAi: pubLegacyReqAi,
    });
    await pubLegacySvc.aiBrief('alice', 'user', pubId, { force: true });
    expect(pubLegacyReqAi.mock.lastCall[0].payload.articleMarkdown).toBe('Public legacy article body');

    // Round 26 (PR #2032 Round 5) Blocker #1/#2/#3 isolated end-to-end regressions:
    // (1) Inline `<code>` opening syntax splitting a source token across 2 MiB, 30,000-tag, and 40,000-char caps (Clean Article display unchanged),
    // (2) Private RSS CDATA inline soft-break `<wbr>` / `<span>` inside the last token at the 30,000-tag cap and unterminated comment cutoff,
    // (3) Legacy unversioned private RSS excerpts (<1,000 chars) persisted before excerpt_version: display stays intact, AI omits both item & cluster
    //     excerpts before refresh (aiBrief / followUp / dailyBriefing), and refresh upgrades both item & cluster rows to clean sanitized v2 excerpts.
    const r5SplitCodeByteHtml = `<script>${'x'.repeat(2_097_073)}</script><article><p>Safe inline split //SPLITCODE<code>USER99@intranet:8080</code></p></article>`;
    const r5SplitCodeTagHtml = `<article><p>Safe tag split</p>${'<span></span>'.repeat(14_997)}<p>Keep //TAGSPLIT<code>USER99<span>@intranet:8080</span></code></p></article>`;
    const r5SplitCode40kHtml = `<article><p>${'x'.repeat(39_965)} Safe40k //CAP40SPLIT<code>USER99@intranet:8080</code></p></article>`;
    const r5WbrTagRssDesc = `<![CDATA[${'<span></span>'.repeat(14_999)}Safe wbr rss //WBRTRUNC<wbr>USER99<span>@intranet:8080</span>]]>`;
    const r5WbrCommentRssDesc = `<![CDATA[Safe cmt rss //CMTWBRTRUNC<wbr>USER99<!-- unterminated]]>`;
    const r5FeedUrl = 'https://private.example/r5.xml';
    let r5FeedPhase = 'initial';
    const r5RssInitial = `<rss><channel>
      <item><title>Split Inline Code Article</title><link>https://private.example/r5-split-code</link><description>Split summary</description></item>
      <item><title>Soft Break Tag Cap Feed</title><link>https://private.example/r5-wbr-tag</link><description>${r5WbrTagRssDesc}</description></item>
      <item><title>Unterminated Comment Cutoff</title><link>https://private.example/r5-wbr-cmt</link><description>${r5WbrCommentRssDesc}</description></item>
    </channel></rss>`;
    const r5RssUpgraded = `<rss><channel>
      <item><title>Legacy Persisted Private Memo</title><link>https://private.example/r5-legacy-excerpt</link><description>Refreshed clean excerpt //user:CLEANPASS99@intranet:8080 trailing</description></item>
    </channel></rss>`;
    const r5Prompts = [];
    const r5AgentAi = vi.fn(async ({ mode, perspective, language, payload }) => {
      const adapter = {
        async call(req) {
          r5Prompts.push(JSON.stringify(req));
          if (mode === 'follow_up') {
            return { text: JSON.stringify({ question: 'q', answer: 'ok', bullets: ['one'], followUps: ['q1'] }) };
          }
          if (mode === 'daily_briefing') {
            return { text: JSON.stringify({ headline: 'ok', overview: 'ok', sections: [{ domain: 'priv-r5', bullets: ['ok'] }], signalsToWatch: ['s1'], followUps: ['q1', 'q2'] }) };
          }
          return { text: JSON.stringify({ tldr: 'ok', bullets: ['one', 'two'], impact: 'ok', followUps: ['q1', 'q2'] }) };
        },
      };
      const { result } = await runCosmicWebBriefing({
        mode, perspective, language, payload,
        config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
        adapter,
      });
      return result;
    });
    const r5Svc = makeService({
      fetcher: async url => {
        if (url === r5FeedUrl) return { status: 200, url, text: async () => r5FeedPhase === 'initial' ? r5RssInitial : r5RssUpgraded };
        if (url.endsWith('/r5-split-code')) return { status: 200, url, text: async () => r5SplitCodeByteHtml };
        return { status: 200, url, text: async () => '<article><p>ok</p></article>' };
      },
      requestAi: r5AgentAi,
    });
    await r5Svc.savePreferences('judy', {
      enabledDomainIds: [],
      customDomains: [{ id: 'priv-r5', name: 'Priv R5', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: [r5FeedUrl] }],
    });
    await r5Svc.refresh('judy', { domainId: 'priv-r5', force: true });
    agents.set('v2-judy', { ownerId: 'judy', name: 'v2-judy', capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up'], encryptOutbound: false, ws: { readyState: 1, send: () => {} } });
    const judyFeed = r5Svc.feed('judy', { domainId: 'priv-r5' });
    const r5SplitCluster = judyFeed.clusters.find(c => c.headline === 'Split Inline Code Article');
    const r5WbrTagCluster = judyFeed.clusters.find(c => c.headline === 'Soft Break Tag Cap Feed');
    const r5WbrCmtCluster = judyFeed.clusters.find(c => c.headline === 'Unterminated Comment Cutoff');

    // (1a) 2 MiB cap splitting `//SPLITCODE<code>USER99@intranet`: display keeps `` //SPLITCODE` USER ``, AI & model prompt drop BOTH `SPLITCODE` and `USER`
    const r5SplitArt = await r5Svc.article('judy', r5SplitCluster.id);
    expect(r5SplitArt.truncated).toBe(true);
    expect(r5SplitArt.markdown).toContain('//SPLITCODE` USER');
    await r5Svc.aiBrief('judy', 'user', r5SplitCluster.id, { research: true });
    expect(r5AgentAi.mock.lastCall[0].payload.articleMarkdown).toContain('Safe inline split');
    expect(JSON.stringify(r5AgentAi.mock.lastCall[0].payload)).not.toContain('SPLITCODE');
    expect(JSON.stringify(r5AgentAi.mock.lastCall[0].payload)).not.toContain('USER');
    expect(r5Prompts.at(-1)).toContain('Safe inline split');
    expect(r5Prompts.at(-1)).not.toContain('SPLITCODE');
    expect(r5Prompts.at(-1)).not.toContain('USER');

    // (1b) 30,000-tag cap & 40,000-char cap splitting `<code>` inside source token
    const r5TagExt = extractCleanArticle(r5SplitCodeTagHtml, 'https://private.example/r5-tag');
    expect(r5TagExt.truncated).toBe(true);
    expect(r5TagExt.markdown).toContain('//TAGSPLIT` USER99');
    expect(r5TagExt.aiMarkdown).toContain('Keep');
    expect(r5TagExt.aiMarkdown).not.toContain('TAGSPLIT');
    expect(r5TagExt.aiMarkdown).not.toContain('USER99');
    const r5Cap40Ext = extractCleanArticle(r5SplitCode40kHtml, 'https://private.example/r5-40k');
    expect(r5Cap40Ext.truncated).toBe(true);
    expect(r5Cap40Ext.markdown).toHaveLength(40_000);
    expect(r5Cap40Ext.markdown).toContain('//CAP40SPLIT`');
    expect(r5Cap40Ext.aiMarkdown).toContain('Safe40k');
    expect(r5Cap40Ext.aiMarkdown).not.toContain('CAP40SPLIT');
    expect(r5Cap40Ext.aiMarkdown).not.toContain('USER');

    // (2) Private RSS CDATA `<wbr>` inside last token at 30,000-tag cap and unterminated comment cutoff -> neither fragment stored nor sent to model
    expect(r5WbrTagCluster.summaryExcerpt).toContain('Safe wbr rss');
    expect(r5WbrTagCluster.summaryExcerpt).not.toContain('WBRTRUNC');
    expect(r5WbrTagCluster.summaryExcerpt).not.toContain('USER99');
    expect(r5WbrCmtCluster.summaryExcerpt).toContain('Safe cmt rss');
    expect(r5WbrCmtCluster.summaryExcerpt).not.toContain('CMTWBRTRUNC');
    expect(r5WbrCmtCluster.summaryExcerpt).not.toContain('USER99');
    await r5Svc.aiBrief('judy', 'user', r5WbrTagCluster.id, { skipArticleFetch: true, research: true });
    expect(r5Prompts.at(-1)).toContain('Safe wbr rss');
    expect(r5Prompts.at(-1)).not.toContain('WBRTRUNC');
    expect(r5Prompts.at(-1)).not.toContain('USER99');

    // (3) Legacy unversioned private RSS excerpt (<1,000 chars, persisted with excerpt_version = 0 as from old post-cap entity-decoding path):
    //     display keeps showing it; AI (aiBrief / followUp / dailyBriefing) omits both item & cluster excerpts before refresh;
    //     successful refresh upgrades BOTH item & cluster rows to clean sanitized v2 excerpts.
    const r5PrivateSrc = db.listSources('judy').find(s => s.url === r5FeedUrl);
    const legacyPostDecodeExcerpt = 'Legacy short prose //LEGACYCLIPUSER99';
    ingestCosmicWebItems(
      { id: r5PrivateSrc.id, ownerUserId: 'judy', domainId: r5PrivateSrc.domain_id, name: r5PrivateSrc.name, url: r5FeedUrl, kind: 'rss' },
      [{ title: 'Legacy Persisted Private Memo', url: 'https://private.example/r5-legacy-excerpt', summaryExcerpt: legacyPostDecodeExcerpt, publishedAt: NOW, media: [] }],
      NOW,
    );
    const legacyPrivBefore = r5Svc.feed('judy', { domainId: 'priv-r5' }).clusters.find(c => c.headline === 'Legacy Persisted Private Memo');
    // Display behavior unchanged before refresh
    expect(legacyPrivBefore.summaryExcerpt).toBe(legacyPostDecodeExcerpt);
    expect((await r5Svc.cluster('judy', legacyPrivBefore.id)).summaryExcerpt).toBe(legacyPostDecodeExcerpt);
    expect(legacyPrivBefore.excerptVersion).toBeUndefined();
    // AI omits both item and cluster unversioned legacy private excerpts (aiBrief, followUp, dailyBriefing)
    await r5Svc.aiBrief('judy', 'user', legacyPrivBefore.id, { skipArticleFetch: true, research: true });
    expect(r5AgentAi.mock.lastCall[0].payload.summaryExcerpt).toBe('');
    expect(JSON.stringify(r5AgentAi.mock.lastCall[0].payload)).not.toContain('LEGACYCLIPUSER99');
    expect(r5Prompts.at(-1)).not.toContain('LEGACYCLIPUSER99');
    await r5Svc.followUp('judy', 'user', legacyPrivBefore.id, { question: 'What happened?', research: true });
    expect(r5AgentAi.mock.lastCall[0].payload.summaryExcerpt).toBe('');
    expect(JSON.stringify(r5AgentAi.mock.lastCall[0].payload)).not.toContain('LEGACYCLIPUSER99');
    expect(r5Prompts.at(-1)).not.toContain('LEGACYCLIPUSER99');
    await r5Svc.dailyBriefing('judy', 'user', { force: true });
    expect(JSON.stringify(r5AgentAi.mock.lastCall[0].payload)).not.toContain('LEGACYCLIPUSER99');
    expect(r5Prompts.at(-1)).not.toContain('LEGACYCLIPUSER99');
    // Refreshing the private RSS source upgrades BOTH cw_items and cw_clusters in place to sanitized v2 excerpts
    r5FeedPhase = 'upgraded';
    const r5SvcRefresh = makeService({
      fetcher: async url => {
        if (url === r5FeedUrl) return { status: 200, url, text: async () => r5RssUpgraded };
        return { status: 200, url, text: async () => '<article><p>ok</p></article>' };
      },
      requestAi: r5AgentAi,
      now: () => NOW + 25_000,
    });
    await r5SvcRefresh.refresh('judy', { domainId: 'priv-r5', force: true });
    const legacyPrivAfter = r5SvcRefresh.feed('judy', { domainId: 'priv-r5' }).clusters.find(c => c.headline === 'Legacy Persisted Private Memo');
    expect(legacyPrivAfter.summaryExcerpt).toContain('Refreshed clean excerpt');
    expect(legacyPrivAfter.summaryExcerpt).not.toContain('LEGACYCLIPUSER99');
    expect(legacyPrivAfter.summaryExcerpt).not.toContain('CLEANPASS99');
    await r5SvcRefresh.aiBrief('judy', 'user', legacyPrivAfter.id, { skipArticleFetch: true, research: true, force: true });
    expect(r5AgentAi.mock.lastCall[0].payload.summaryExcerpt).toContain('Refreshed clean excerpt');
    expect(r5Prompts.at(-1)).toContain('Refreshed clean excerpt');
    expect(r5Prompts.at(-1)).not.toContain('LEGACYCLIPUSER99');
    expect(r5Prompts.at(-1)).not.toContain('CLEANPASS99');
    await r5SvcRefresh.dailyBriefing('judy', 'user', { force: true });
    expect(r5Prompts.at(-1)).toContain('Refreshed clean excerpt');
    expect(r5Prompts.at(-1)).not.toContain('LEGACYCLIPUSER99');
    expect(r5Prompts.at(-1)).not.toContain('CLEANPASS99');

    // Round 27 (PR #2032 Round 6) Blocker #1/#2/#3/#4 isolated end-to-end regressions:
    // (1) 40,000-char AI cap cutting inside authority right after `<code>//USER</code>`: Clean Article display stays 40k intact,
    //     while source-boundary DOM slicing removes BOTH `<code>//CODECLOSEUSER</code>` AND `@intranet` before reaching the real Agent model prompt.
    // (2) scanMarkup unfinished quoted attribute & unclosed raw `<script>` at EOF in private RSS CDATA with `<wbr>` inside trailing token:
    //     marks truncated so cleanText rewinds across `<wbr>`, storing clean excerpt_version=2 with ZERO fragments in DB or model prompt.
    // (3) Private follow-ups reject pre-upgrade brief-context cache rows (`hash(4, 'brief-context', ...)`) AND unversioned client-echoed `body.briefContext`,
    //     while accepting fresh v2 `aiBrief` cache + `briefContextVersion: 2`.
    // (4) Topic Radar scrubs `summaryExcerpt` BEFORE clipping to 1,000 chars and certifies `excerptVersion: 2` when `excerptProvenance: true`;
    //     legacy Radar responses lacking `excerptVersion: 2` are persisted as `excerpt_version = 0` and omitted from subsequent private AI prompts.
    const r6CodeClose40kHtml = `<article><p>https://cdn.example/${'a'.repeat(39_940)} Safe40kClose <code>//CODECLOSEUSER99</code>@intranet:8080/secret</p></article>`;
    const r6UnfinishedAttrRss = `<rss><channel>
      <item><title>Code Close 40k Article</title><link>https://private.example/r6-code-close</link><description>Close summary</description></item>
      <item><title>Unfinished Quoted Attr Feed</title><link>https://private.example/r6-attr-eof</link><description><![CDATA[Safe attr prose //ATTRTRUNC<wbr>USER99<span title="unclosed@intranet:8080]]></description></item>
      <item><title>Unclosed Script Eof Feed</title><link>https://private.example/r6-script-eof</link><description><![CDATA[Safe script prose //SCRIPTTRUNC<wbr>USER99<script>var x = "@intranet:8080";]]></description></item>
    </channel></rss>`;
    const r6Prompts = [];
    const r6AgentAi = vi.fn(async ({ mode, perspective, language, payload }) => {
      if (mode === 'topic_radar') {
        const searchUrl = 'https://radar.example/fresh-story';
        const longRadarExcerpt = `${'r'.repeat(982)} Safe radar //RADARCLIPUSER99@intranet:8080/api`;
        const WebSearch = vi.fn().mockResolvedValue({ results: [{ url: searchUrl, title: 'Fresh Radar Story', snippet: 'Radar snippet' }] });
        const radarAdapter = {
          captureStream: vi.fn()
            .mockImplementationOnce(async function* () { yield { type: 'tool_call', id: 'tc1', name: 'WebSearch', input: { query: 'radar', limit: 5 } }; })
            .mockImplementationOnce(async function* () {}),
          call: vi.fn().mockResolvedValue({
            text: JSON.stringify({
              items: [{ title: 'Fresh Radar Story', url: searchUrl, sourceName: 'RadarWire', summaryExcerpt: longRadarExcerpt }],
              searchCount: 1,
            }),
          }),
        };
        const { result } = await runCosmicWebBriefing({
          mode, perspective, language, payload,
          config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
          adapter: radarAdapter, toolExecutors: { WebSearch },
        });
        return result;
      }
      const adapter = {
        async call(req) {
          r6Prompts.push(JSON.stringify(req));
          if (mode === 'follow_up') {
            return { text: JSON.stringify({ question: 'q', answer: 'ok', bullets: ['one'], followUps: ['q1'] }) };
          }
          return { text: JSON.stringify({ tldr: 'Fresh v2 private TLDR', bullets: ['one', 'two'], impact: 'ok', followUps: ['q1', 'q2'] }) };
        },
      };
      const { result } = await runCosmicWebBriefing({
        mode, perspective, language, payload,
        config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
        adapter,
      });
      return result;
    });
    const r6FeedUrl = 'https://private.example/r6.xml';
    const r6Svc = makeService({
      fetcher: async url => {
        if (url === r6FeedUrl) return { status: 200, url, text: async () => r6UnfinishedAttrRss };
        if (url.endsWith('/r6-code-close')) return { status: 200, url, text: async () => r6CodeClose40kHtml };
        return { status: 200, url, text: async () => '<article><p>ok</p></article>' };
      },
      requestAi: r6AgentAi,
      now: () => NOW + 60_000,
    });
    await r6Svc.savePreferences('kate', {
      enabledDomainIds: [],
      customDomains: [
        { id: 'priv-r6', name: 'Priv R6', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: [r6FeedUrl] },
        { id: 'radar-r6', name: 'Radar R6', colorToken: 'gold', enabled: true, keywords: ['radar'], aiRadar: true, rssUrls: [] },
      ],
    });
    await r6Svc.refresh('kate', { domainId: 'priv-r6', force: true });
    agents.set('v2-kate', {
      ownerId: 'kate', name: 'v2-kate',
      capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up', 'cosmic_web_radar', 'cosmic_web_research'],
      encryptOutbound: false, ws: { readyState: 1, send: () => {} },
    });
    const kateFeed = r6Svc.feed('kate', { domainId: 'priv-r6' });
    const r6CodeCloseCluster = kateFeed.clusters.find(c => c.headline === 'Code Close 40k Article');
    const r6AttrCluster = kateFeed.clusters.find(c => c.headline === 'Unfinished Quoted Attr Feed');
    const r6ScriptCluster = kateFeed.clusters.find(c => c.headline === 'Unclosed Script Eof Feed');

    // (1) 40,000-char cap cutting in authority after `<code>//CODECLOSEUSER99</code>`
    const r6CodeCloseArt = await r6Svc.article('kate', r6CodeCloseCluster.id);
    expect(r6CodeCloseArt.markdown).toHaveLength(40_000);
    expect(r6CodeCloseArt.truncated).toBe(true);
    expect(r6CodeCloseArt.markdown).toContain('` //CODECLOSEUSER99 `@');
    await r6Svc.aiBrief('kate', 'user', r6CodeCloseCluster.id, { research: true });
    expect(r6AgentAi.mock.lastCall[0].payload.articleMarkdown).toContain('Safe40kClose');
    expect(JSON.stringify(r6AgentAi.mock.lastCall[0].payload)).not.toContain('CODECLOSEUSER99');
    expect(r6Prompts.at(-1)).toContain('Safe40kClose');
    expect(r6Prompts.at(-1)).not.toContain('CODECLOSEUSER99');

    // (2) Private RSS unfinished quoted attribute & unclosed `<script>` at EOF with `<wbr>` inside trailing token
    expect(r6AttrCluster.summaryExcerpt).toBe('Safe attr prose');
    expect(r6AttrCluster.summaryExcerpt).not.toContain('ATTRTRUNC');
    expect(r6AttrCluster.summaryExcerpt).not.toContain('USER99');
    expect(r6ScriptCluster.summaryExcerpt).toBe('Safe script prose');
    expect(r6ScriptCluster.summaryExcerpt).not.toContain('SCRIPTTRUNC');
    expect(r6ScriptCluster.summaryExcerpt).not.toContain('USER99');
    await r6Svc.aiBrief('kate', 'user', r6AttrCluster.id, { skipArticleFetch: true, research: true });
    expect(r6Prompts.at(-1)).toContain('Safe attr prose');
    expect(r6Prompts.at(-1)).not.toContain('ATTRTRUNC');
    expect(r6Prompts.at(-1)).not.toContain('USER99');

    // (3) Pre-upgrade brief-context cache row (`hash(4, 'brief-context', ...)`) AND unversioned client-echoed `body.briefContext`
    //     are BOTH rejected on private follow-up; fresh v2 `aiBrief` returns `briefContextVersion: 2` and writes versioned cache key.
    const legacyBriefKey = createHash('sha256').update(JSON.stringify([4, 'brief-context', r6ScriptCluster.id, r6CodeCloseArt.itemId, 'v2-kate'])).digest('hex');
    const scriptDet = await r6Svc.cluster('kate', r6ScriptCluster.id);
    const scriptItemId = scriptDet.items[0].id;
    const legacyScriptBriefKey = createHash('sha256').update(JSON.stringify([4, 'brief-context', r6ScriptCluster.id, scriptItemId, 'v2-kate'])).digest('hex');
    db.setAiCache('kate', legacyBriefKey, 'Pre-upgrade TLDR //LEGACYTLDRCACHE99', NOW + HOUR);
    db.setAiCache('kate', legacyScriptBriefKey, 'Pre-upgrade TLDR //LEGACYTLDRCACHE99', NOW + HOUR);
    // Unversioned client-echoed briefContext + legacy cached TLDR must BOTH be omitted
    await r6Svc.followUp('kate', 'user', r6ScriptCluster.id, {
      question: 'Follow up before v2 brief?',
      briefContext: 'Unversioned client echo //LEGACYCLIENTECHO99',
      research: true,
    });
    expect(r6AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    expect(r6Prompts.at(-1)).not.toContain('LEGACYTLDRCACHE99');
    expect(r6Prompts.at(-1)).not.toContain('LEGACYCLIENTECHO99');
    // Fresh v2 aiBrief returns briefContextVersion: 2 and stores under v2 key -> subsequent follow-up gets fresh v2 TLDR
    const freshV2Brief = await r6Svc.aiBrief('kate', 'user', r6ScriptCluster.id, { skipArticleFetch: true, research: true });
    expect(freshV2Brief.briefContextVersion).toBe(PRIVATE_BRIEF_CONTEXT_VERSION);
    await r6Svc.followUp('kate', 'user', r6ScriptCluster.id, { question: 'Follow up after v2 brief?', research: true });
    expect(r6AgentAi.mock.lastCall[0].payload.briefContext).toBe('Fresh v2 private TLDR');
    expect(r6Prompts.at(-1)).toContain('Fresh v2 private TLDR');
    expect(r6Prompts.at(-1)).not.toContain('LEGACYTLDRCACHE99');

    // (4a) Real Radar Agent (`topic_radar`) scrubs BEFORE clipping to 1,000 chars and certifies `excerptVersion: 2`
    const radarRes = await r6Svc.radarScan('kate', 'user', 'radar-r6');
    expect(radarRes.added).toBe(1);
    const radarCluster = r6Svc.feed('kate', { domainId: 'radar-r6' }).clusters.find(c => c.headline === 'Fresh Radar Story');
    expect(radarCluster.summaryExcerpt).toContain('Safe radar');
    expect(radarCluster.summaryExcerpt).not.toContain('RADARCLIPUSER99');
    await r6Svc.aiBrief('kate', 'user', radarCluster.id, { skipArticleFetch: true, research: true });
    expect(r6Prompts.at(-1)).toContain('Safe radar');
    expect(r6Prompts.at(-1)).not.toContain('RADARCLIPUSER99');

    // (4b) Legacy Radar Agent response WITHOUT `excerptVersion: 2` (pre-clipped username fragment) is persisted with `excerpt_version = 0`
    //      so display keeps working while subsequent briefing Agent omits the uncertified Radar excerpt!
    const legacyRadarReqAi = vi.fn(async req => {
      if (req.mode === 'topic_radar') {
        return {
          items: [{
            title: 'Legacy Radar Uncertified Story',
            url: 'https://radar.example/legacy-radar-story',
            sourceName: 'OldRadar',
            summaryExcerpt: 'Legacy radar display //LEGACYRADARUSER99',
          }],
          searchCount: 1,
        };
      }
      return r6AgentAi(req);
    });
    const legacyRadarSvc = makeService({
      requestAi: legacyRadarReqAi,
      now: () => NOW + 180_000,
    });
    const legacyRadarRes = await legacyRadarSvc.radarScan('kate', 'user', 'radar-r6');
    expect(legacyRadarRes.added).toBe(1);
    const legacyRadarCluster = legacyRadarSvc.feed('kate', { domainId: 'radar-r6' }).clusters.find(c => c.headline === 'Legacy Radar Uncertified Story');
    expect(legacyRadarCluster.summaryExcerpt).toBe('Legacy radar display');
    expect(legacyRadarCluster.summaryExcerpt).not.toContain('LEGACYRADARUSER99');
    await legacyRadarSvc.aiBrief('kate', 'user', legacyRadarCluster.id, { skipArticleFetch: true, research: true });
    expect(r6Prompts.at(-1)).not.toContain('Legacy radar display');
    expect(r6Prompts.at(-1)).not.toContain('LEGACYRADARUSER99');

    // Round 28 (PR #2032 Round 7) Blocker #1/#2/#3/#4 isolated end-to-end regressions:
    // (1) Complete URL split by inline `<code>` BEFORE the 40k cutoff (and in short non-truncated articles, plus unclosed hidden `<noscript>`):
    //     Clean Article display remains intact (40,000 chars / inline code preserved), while DOM-redacted `aiMarkdown` omits all credential markers
    //     before reaching the real Agent model prompt; cached v2 (`extractorVersion: 2`) rows are rejected for private AI.
    // (2) RSS `cleanText` no longer inserts synthetic spaces on inline tags (`<wbr>`/`<code>`) AND treats `<iframe>`/`<noscript>` as raw discarded elements:
    //     complete `<wbr>`-split authorities and unclosed `<iframe>` at EOF leave ZERO credential fragments in SQLite or model prompts.
    // (3) Private `followUp` rejects client-claimed `briefContextVersion` without a valid server-minted HMAC `briefContextToken`, rejects cross-item/cluster/user/tampered/expired tokens,
    //     accepts genuine `briefContextToken` across Agent switch / cache eviction, scrubs >400-char TLDR BEFORE clipping in real Agent `brief`, and omits context from uncertified legacy Agents.
    // (4) Topic Radar redacts `WebSearch` evidence BEFORE the 1,500-char snippet cap and fails closed on upstream-truncated ambiguous tokens before the Radar model sees or quotes them,
    //     and Server rejects old `excerptVersion: 2` Radar outputs (persisting as `0` and omitting from subsequent private AI prompts).
    const r7Inline40kHtml = `<article><p>https://cdn.example/${'a'.repeat(39_890)} SafeR7Inline40k <code>//R7INLINE40KUSER99</code>@intranet:8080/secret after ${'b'.repeat(90)}</p></article>`;
    const r7ShortInlineHtml = `<article><p>Short non-truncated private memo with enough prose for full quality. See <code>//R7SHORTCODE99</code>@intranet:8080/api and <a href="https://intranet.internal/doc?tok=R7HREF99"><em>//R7LINKEM99</em>@intranet:8080</a> and www.<code>r7subsecret</code>.example/x end.</p></article>`;
    const r7NoscriptEofHtml = `<article><p>Safe noscript lead <code>//R7NOSCRIPT99</code><wbr><noscript>@intranet:8080`;
    const r7FeedRss = `<rss><channel>
      <item><title>Alpha 40k Code Boundary</title><link>https://private.example/r7-inline-40k</link><description>Inline 40k desc</description></item>
      <item><title>Beta Compact Private Memo</title><link>https://private.example/r7-short-inline</link><description>Short inline desc</description></item>
      <item><title>Gamma Hidden Noscript Tail</title><link>https://private.example/r7-noscript-eof</link><description>Noscript eof desc</description></item>
      <item><title>Delta Complete Wbr Split</title><link>https://private.example/r7-wbr-complete</link><description><![CDATA[Safe wbr complete //R7WBRFULL99<wbr>@intranet:8080/api and <code>//R7RSSCODE99</code>@intranet:8080/x tail]]></description></item>
      <item><title>Epsilon Unclosed Iframe Feed</title><link>https://private.example/r7-iframe-eof</link><description><![CDATA[Safe iframe prose //R7IFRAMETRUNC<wbr>USER99<iframe src="https://x">@intranet:8080]]></description></item>
    </channel></rss>`;
    const r7Prompts = [];
    const r7RadarSearchUrl = 'https://radar.example/r7-search-1500';
    const r7RadarUpstreamUrl = 'https://radar.example/r7-search-upstream';
    const r7AgentAi = vi.fn(async ({ mode, perspective, language, payload }) => {
      if (mode === 'topic_radar') {
        const WebSearch = vi.fn().mockResolvedValue({
          provider: 'generic',
          results: [
            { url: r7RadarSearchUrl, title: 'R7 1500 Snippet Story', snippet: `${'s'.repeat(1474)} SafeR7Search //R7SEARCH1500USER99@intranet:8080/api` },
            { url: r7RadarUpstreamUrl, title: 'R7 Upstream Trunc Story', snippet: 'SafeR7Upstream //R7UPSTREAM99... end //R7UPSTREAMEOF99' },
          ],
        });
        const radarAdapter = {
          captureStream: vi.fn()
            .mockImplementationOnce(async function* () { yield { type: 'tool_call', id: 'r7tc1', name: 'WebSearch', input: { query: 'r7 radar', limit: 5 } }; })
            .mockImplementationOnce(async function* () {}),
          call: vi.fn().mockImplementation(async req => {
            r7Prompts.push(JSON.stringify(req));
            const toolMsg = req.messages.find(m => m.role === 'tool')?.content ?? '';
            const parsedTool = JSON.parse(toolMsg.replace(/^<untrusted_web_result>\n|\n<\/untrusted_web_result>$/g, ''));
            return {
              text: JSON.stringify({
                items: parsedTool.results.map(r => ({
                  title: r.title, url: r.url, sourceName: 'R7Wire', summaryExcerpt: r.snippet.slice(-120),
                })),
                searchCount: 1,
              }),
            };
          }),
        };
        const { result } = await runCosmicWebBriefing({
          mode, perspective, language, payload,
          config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
          adapter: radarAdapter, toolExecutors: { WebSearch },
        });
        return result;
      }
      const adapter = {
        async call(req) {
          r7Prompts.push(JSON.stringify(req));
          if (mode === 'follow_up') {
            return { text: JSON.stringify({ question: 'q', answer: 'ok', bullets: ['one'], followUps: ['q1'] }) };
          }
          // Return a >400-char TLDR with a credential split across the 400-char cap (Blocker #3)
          return {
            text: JSON.stringify({
              tldr: `${'t'.repeat(374)} SafeR7Tldr //R7TLDR400CLIP99@intranet:8080/api`,
              bullets: ['Safe bullet one', 'Safe bullet two'],
              impact: 'Safe impact',
              followUps: ['q1', 'q2'],
            }),
          };
        },
      };
      const { result } = await runCosmicWebBriefing({
        mode, perspective, language, payload,
        config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
        adapter,
      });
      return result;
    });
    const r7FeedUrl = 'https://private.example/r7.xml';
    let r7Clock = NOW + 240_000;
    const r7Svc = makeService({
      fetcher: async url => {
        if (url === r7FeedUrl) return { status: 200, url, text: async () => r7FeedRss };
        if (url.endsWith('/r7-inline-40k')) return { status: 200, url, text: async () => r7Inline40kHtml };
        if (url.endsWith('/r7-short-inline')) return { status: 200, url, text: async () => r7ShortInlineHtml };
        if (url.endsWith('/r7-noscript-eof')) return { status: 200, url, text: async () => r7NoscriptEofHtml };
        return { status: 200, url, text: async () => '<article><p>ok</p></article>' };
      },
      requestAi: r7AgentAi,
      now: () => r7Clock,
    });
    await r7Svc.savePreferences('leo', {
      enabledDomainIds: [],
      customDomains: [
        { id: 'priv-r7', name: 'Priv R7', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: [r7FeedUrl] },
        { id: 'radar-r7', name: 'Radar R7', colorToken: 'gold', enabled: true, keywords: ['r7'], aiRadar: true, rssUrls: [] },
      ],
    });
    await r7Svc.refresh('leo', { domainId: 'priv-r7', force: true });
    agents.set('v3-leo-a', {
      ownerId: 'leo', name: 'v3-leo-a',
      capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up', 'cosmic_web_radar', 'cosmic_web_research'],
      encryptOutbound: false, ws: { readyState: 1, send: () => {} },
    });
    agents.set('v3-leo-b', {
      ownerId: 'leo', name: 'v3-leo-b',
      capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up'],
      encryptOutbound: false, ws: { readyState: 1, send: () => {} },
    });
    const leoFeed = r7Svc.feed('leo', { domainId: 'priv-r7' });
    const r7Inline40kCluster = leoFeed.clusters.find(c => c.headline === 'Alpha 40k Code Boundary');
    const r7ShortInlineCluster = leoFeed.clusters.find(c => c.headline === 'Beta Compact Private Memo');
    const r7NoscriptCluster = leoFeed.clusters.find(c => c.headline === 'Gamma Hidden Noscript Tail');
    const r7WbrCluster = leoFeed.clusters.find(c => c.headline === 'Delta Complete Wbr Split');
    const r7IframeCluster = leoFeed.clusters.find(c => c.headline === 'Epsilon Unclosed Iframe Feed');

    // (1a) Complete inline-code URL BEFORE 40k cutoff: Clean Article stays exact 40,000 chars intact, while real Agent prompt omits credential
    const r7Inline40kArt = await r7Svc.article('leo', r7Inline40kCluster.id);
    expect(r7Inline40kArt.markdown).toHaveLength(40_000);
    expect(r7Inline40kArt.truncated).toBe(true);
    expect(r7Inline40kArt.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
    expect(r7Inline40kArt.markdown).toContain('` //R7INLINE40KUSER99 `@intranet:8080/secret');
    expect(r7Inline40kArt.aiMarkdown).toBeUndefined();
    await r7Svc.aiBrief('leo', 'user', r7Inline40kCluster.id, { research: true });
    expect(r7Prompts.at(-1)).toContain('SafeR7Inline40k');
    expect(r7Prompts.at(-1)).not.toContain('R7INLINE40KUSER99');
    expect(r7Prompts.at(-1)).not.toContain('cdn.example');

    // (1b) Short non-truncated private article (`truncated: false`) with inline `<code>` / `<a><em>` / `www.<code>`:
    //      Clean Article display preserves inline code & link, while private AI prompt uses DOM-redacted aiMarkdown
    const r7ShortArt = await r7Svc.article('leo', r7ShortInlineCluster.id);
    expect(r7ShortArt.truncated).toBe(false);
    expect(r7ShortArt.markdown).toContain('` //R7SHORTCODE99 `@intranet:8080/api');
    expect(r7ShortArt.markdown).toContain('R7HREF99');
    await r7Svc.aiBrief('leo', 'user', r7ShortInlineCluster.id, { research: true });
    expect(r7Prompts.at(-1)).toContain('Short non-truncated private memo');
    for (const secret of ['R7SHORTCODE99', 'R7HREF99', 'R7LINKEM99', 'r7subsecret']) {
      expect(r7Prompts.at(-1)).not.toContain(secret);
    }

    // (1c) Unclosed hidden `<noscript>` at EOF after `<code>//R7NOSCRIPT99</code><wbr>`: rewinds across `<wbr>` & `<code>`
    await r7Svc.aiBrief('leo', 'user', r7NoscriptCluster.id, { research: true });
    expect(r7Prompts.at(-1)).toContain('Safe noscript lead');
    expect(r7Prompts.at(-1)).not.toContain('R7NOSCRIPT99');

    // (1d) Pre-upgrade v2 article cache (`extractorVersion: 2`, no DOM-redacted `aiMarkdown`) is NOT trusted by private `aiBrief`
    db.setArticleCache('leo', r7ShortArt.itemId, {
      title: 'Old v2', markdown: 'Old v2 ` //OLDV2CODE99 `@intranet:8080', extractorVersion: 2, truncated: false,
      quality: 'full', itemId: r7ShortArt.itemId, clusterId: r7ShortInlineCluster.id, summaryExcerpt: 'Old',
    }, r7Clock + HOUR);
    await r7Svc.aiBrief('leo', 'user', r7ShortInlineCluster.id, { skipArticleFetch: true, research: true, force: true });
    expect(r7AgentAi.mock.lastCall[0].payload.articleMarkdown).toBeUndefined();
    expect(r7Prompts.at(-1)).not.toContain('OLDV2CODE99');

    // (2a) Complete RSS authority split by `<wbr>` and `<code>`: redacted cleanly before persisting as trusted v3
    expect(r7WbrCluster.summaryExcerpt).toContain('Safe wbr complete');
    expect(r7WbrCluster.summaryExcerpt).not.toContain('R7WBRFULL99');
    expect(r7WbrCluster.summaryExcerpt).not.toContain('R7RSSCODE99');
    await r7Svc.aiBrief('leo', 'user', r7WbrCluster.id, { skipArticleFetch: true, research: true });
    expect(r7Prompts.at(-1)).toContain('Safe wbr complete');
    expect(r7Prompts.at(-1)).not.toContain('R7WBRFULL99');
    expect(r7Prompts.at(-1)).not.toContain('R7RSSCODE99');

    // (2b) Unclosed `<iframe>` at EOF in RSS CDATA with `<wbr>`: triggers `meta.truncated` rewind across `<wbr>`
    expect(r7IframeCluster.summaryExcerpt).toBe('Safe iframe prose');
    expect(r7IframeCluster.summaryExcerpt).not.toContain('R7IFRAMETRUNC');
    expect(r7IframeCluster.summaryExcerpt).not.toContain('USER99');
    await r7Svc.aiBrief('leo', 'user', r7IframeCluster.id, { skipArticleFetch: true, research: true });
    expect(r7Prompts.at(-1)).toContain('Safe iframe prose');
    expect(r7Prompts.at(-1)).not.toContain('R7IFRAMETRUNC');

    // (3a) Private followUp rejects version-only client echo (even claiming current PRIVATE_BRIEF_CONTEXT_VERSION)
    await r7Svc.followUp('leo', 'user', r7WbrCluster.id, {
      question: 'Version only?',
      briefContext: 'Forged v3 client text //FORGEDV3ECHO99',
      briefContextVersion: PRIVATE_BRIEF_CONTEXT_VERSION,
      agentId: 'v3-leo-b',
      research: true,
    });
    expect(r7AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    expect(r7Prompts.at(-1)).not.toContain('FORGEDV3ECHO99');

    // (3b) Fresh v3 `aiBrief` scrubs >400-char TLDR BEFORE clipping, emits certified `briefContextVersion: 3` + HMAC `briefContextToken`,
    //      and authenticated token works across Agent switch while rejecting tampered, cross-cluster, and expired tokens!
    const r7CertBrief = await r7Svc.aiBrief('leo', 'user', r7WbrCluster.id, { skipArticleFetch: true, agentId: 'v3-leo-a', research: true, force: true });
    expect(r7CertBrief.briefContextVersion).toBe(PRIVATE_BRIEF_CONTEXT_VERSION);
    expect(typeof r7CertBrief.briefContextToken).toBe('string');
    expect(r7CertBrief.tldr).toContain('SafeR7Tldr');
    expect(r7CertBrief.tldr).not.toContain('R7TLDR400');
    // Server-cached followUp on same Agent (`v3-leo-a`) receives scrubbed TLDR
    await r7Svc.followUp('leo', 'user', r7WbrCluster.id, { question: 'Same agent cached?', agentId: 'v3-leo-a', research: true });
    expect(r7AgentAi.mock.lastCall[0].payload.briefContext).toContain('SafeR7Tldr');
    expect(r7Prompts.at(-1)).not.toContain('R7TLDR400');
    // Different Agent (`v3-leo-b`, cache miss) with genuine source-bound `briefContextToken` -> ACCEPTED
    await r7Svc.followUp('leo', 'user', r7WbrCluster.id, {
      question: 'Different agent with valid token?',
      briefContext: r7CertBrief.tldr,
      briefContextToken: r7CertBrief.briefContextToken,
      agentId: 'v3-leo-b',
      research: true,
    });
    expect(r7AgentAi.mock.lastCall[0].payload.briefContext).toContain('SafeR7Tldr');
    expect(r7Prompts.at(-1)).not.toContain('R7TLDR400');
    // Tampered briefContext with original token -> REJECTED
    await r7Svc.followUp('leo', 'user', r7WbrCluster.id, {
      question: 'Tampered text?',
      briefContext: `${r7CertBrief.tldr} //TAMPERED99`,
      briefContextToken: r7CertBrief.briefContextToken,
      agentId: 'v3-leo-b',
      research: true,
    });
    expect(r7AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    expect(r7Prompts.at(-1)).not.toContain('TAMPERED99');
    // Cross-cluster replay of valid token onto `r7IframeCluster` -> REJECTED
    await r7Svc.followUp('leo', 'user', r7IframeCluster.id, {
      question: 'Cross-cluster replay?',
      briefContext: r7CertBrief.tldr,
      briefContextToken: r7CertBrief.briefContextToken,
      agentId: 'v3-leo-b',
      research: true,
    });
    expect(r7AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    // Expired token -> REJECTED
    r7Clock += 7 * HOUR;
    await r7Svc.followUp('leo', 'user', r7WbrCluster.id, {
      question: 'Expired token?',
      briefContext: r7CertBrief.tldr,
      briefContextToken: r7CertBrief.briefContextToken,
      agentId: 'v3-leo-b',
      research: true,
    });
    expect(r7AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    r7Clock -= 7 * HOUR;

    // (3c) Legacy Agent returning private TLDR WITHOUT `briefContextVersion: 3` (pre-clipped fragment):
    //      Server does NOT cache `briefKey` and does NOT mint `briefContextToken` -> subsequent followUp omits context!
    const legacyTldrReqAi = vi.fn(async req => {
      if (req.mode === 'brief') {
        return {
          tldr: `${'z'.repeat(380)} //LEGACYTLDR400CLIP99`,
          sections: [{ heading: 'H', body: 'Body' }],
          bullets: ['b1', 'b2'], impact: 'ok', media: [], communityHighlights: [], citations: [],
          followUps: ['q1', 'q2'], researched: false, searchCount: 0, evidenceCount: 0, fullMarkdown: 'Safe md',
        };
      }
      return r7AgentAi(req);
    });
    const legacyTldrSvc = makeService({ requestAi: legacyTldrReqAi, now: () => r7Clock + 10_000 });
    const legacyBriefRes = await legacyTldrSvc.aiBrief('leo', 'user', r7IframeCluster.id, { skipArticleFetch: true, agentId: 'v3-leo-b', research: true, force: true });
    expect(legacyBriefRes.briefContextToken).toBeUndefined();
    expect(legacyBriefRes.briefContextVersion).toBeUndefined();
    await legacyTldrSvc.followUp('leo', 'user', r7IframeCluster.id, {
      question: 'Follow up after legacy agent brief?',
      briefContext: legacyBriefRes.tldr,
      agentId: 'v3-leo-b',
      research: true,
    });
    expect(r7AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    expect(r7Prompts.at(-1)).not.toContain('LEGACYTLDR400CLIP99');

    // (4a) Real Radar Agent (`topic_radar`) + `radarScan()` + subsequent `aiBrief()`:
    //      WebSearch 1,500-char snippet boundary AND upstream-truncated ambiguous tokens are redacted BEFORE Radar model sees or quotes them!
    const r7RadarRes = await r7Svc.radarScan('leo', 'user', 'radar-r7');
    expect(r7RadarRes.added).toBe(2);
    const r7Radar1500Cluster = r7Svc.feed('leo', { domainId: 'radar-r7' }).clusters.find(c => c.headline === 'R7 1500 Snippet Story');
    const r7RadarUpCluster = r7Svc.feed('leo', { domainId: 'radar-r7' }).clusters.find(c => c.headline === 'R7 Upstream Trunc Story');
    expect(r7Radar1500Cluster.summaryExcerpt).toContain('SafeR7Search');
    expect(r7Radar1500Cluster.summaryExcerpt).not.toContain('R7SEARCH1500');
    expect(r7RadarUpCluster.summaryExcerpt).toContain('SafeR7Upstream');
    expect(r7RadarUpCluster.summaryExcerpt).not.toContain('R7UPSTREAM99');
    expect(r7RadarUpCluster.summaryExcerpt).not.toContain('R7UPSTREAMEOF99');
    await r7Svc.aiBrief('leo', 'user', r7Radar1500Cluster.id, { skipArticleFetch: true, agentId: 'v3-leo-a', research: true });
    expect(r7Prompts.at(-1)).toContain('SafeR7Search');
    expect(r7Prompts.at(-1)).not.toContain('R7SEARCH1500');
    await r7Svc.aiBrief('leo', 'user', r7RadarUpCluster.id, { skipArticleFetch: true, agentId: 'v3-leo-a', research: true });
    expect(r7Prompts.at(-1)).toContain('SafeR7Upstream');
    expect(r7Prompts.at(-1)).not.toContain('R7UPSTREAM99');
    expect(r7Prompts.at(-1)).not.toContain('R7UPSTREAMEOF99');

    // (4b) Old `excerptVersion: 2` Radar Agent response (from pre-Round-7 Agent) is persisted as `0` and omitted from private AI prompts!
    const oldV2RadarReqAi = vi.fn(async req => {
      if (req.mode === 'topic_radar') {
        return {
          items: [{
            title: 'Old V2 Radar Story',
            url: 'https://radar.example/old-v2-radar',
            sourceName: 'V2Radar',
            summaryExcerpt: 'Old v2 radar //OLDV2RADAR1500CLIP99',
          }],
          searchCount: 1,
          excerptVersion: 2,
        };
      }
      return r7AgentAi(req);
    });
    const oldV2RadarSvc = makeService({ requestAi: oldV2RadarReqAi, now: () => r7Clock + 120_000 });
    await oldV2RadarSvc.radarScan('leo', 'user', 'radar-r7');
    const oldV2RadarCluster = oldV2RadarSvc.feed('leo', { domainId: 'radar-r7' }).clusters.find(c => c.headline === 'Old V2 Radar Story');
    expect(oldV2RadarCluster.summaryExcerpt).toBe('Old v2 radar');
    expect(oldV2RadarCluster.summaryExcerpt).not.toContain('OLDV2RADAR1500CLIP99');
    await oldV2RadarSvc.aiBrief('leo', 'user', oldV2RadarCluster.id, { skipArticleFetch: true, agentId: 'v3-leo-a', research: true });
    expect(r7Prompts.at(-1)).not.toContain('Old v2 radar');
    expect(r7Prompts.at(-1)).not.toContain('OLDV2RADAR1500CLIP99');

    // Round 29 (PR #2032 Round 8) Blocker #1/#2/#3 isolated end-to-end regressions:
    // (1) Empty/whitespace/`<br>`-only blocks (`<p></p>`, `<p>  </p>`, `<div><br></div>`, `<span> </span>`, `<em> </em>`),
    //     nested block in `<code>`, and edge-trimmed spaces in `<code>`/`<em>` no longer split DOM redaction runs;
    //     Clean Article display remains intact while real Agent model prompt receives ZERO credential markers; v3 caches are rejected.
    // (2) Nesting-aware discarded container skipping (`<template><template></template>discarded </template>`, `<noscript>`, `<template><script>...</script></template>`, unclosed nested `<template>`):
    //     persists clean v4 excerpt with ZERO markers or discarded text and invalidates pre-fix v3 DB excerpts.
    // (3) Attached balanced abbreviation markers (`//TLDRMARKER(…) next fact.`, `//RADARMARKER[…] next fact.`, `//RADARMARKER[...] next fact.`)
    //     in private TLDR -> cross-Agent HMAC followUp AND real Radar WebSearch -> SQLite -> subsequent private aiBrief; rejects old v3 provenance.
    const r8EmptyBlocksHtml = '<article>Safe r8 article <code>//R8ARTICLEMARKER99</code><p></p>@intranet:8080/api and <code>//R8WSP99</code><p>   </p>@intranet:8080/x and <code>//R8DIVBR99</code><div><br></div>@intranet:8080/y and <code><p>//R8CODEP99</p></code>@intranet:8080/z and <code>//R8CODESP99 </code>@intranet:8080/w and <em>//R8EMTRAIL99 </em><code>@intranet:8080/q</code> end.</article>';
    const r8FeedRss = `<rss><channel>
      <item><title>Zeta Empty Block Article</title><link>https://private.example/r8-empty-blocks</link><description>Empty block desc</description></item>
      <item><title>Eta Nested Template Feed</title><link>https://private.example/r8-nested-template</link><description><![CDATA[Safe RSS //R8RSSMARKER99<wbr><template><template></template>discarded </template>@intranet:8080/api and //R8TSMARKER99<wbr><template><script>var s = "</template>";</script>discarded </template>@intranet:8080/b after.]]></description></item>
      <item><title>Theta Unclosed Nested Template</title><link>https://private.example/r8-unclosed-template</link><description><![CDATA[Safe unclosed //R8UNCLOSEDTPL99<wbr><template><template></template>@intranet:8080]]></description></item>
    </channel></rss>`;
    const r8Prompts = [];
    const r8RadarUrl = 'https://radar.example/r8-abbr';
    const r8AgentAi = vi.fn(async ({ mode, perspective, language, payload }) => {
      if (mode === 'topic_radar') {
        const WebSearch = vi.fn().mockResolvedValue({
          provider: 'generic',
          results: [{ url: r8RadarUrl, title: 'R8 Abbr Radar Story', snippet: 'SafeR8Radar //R8RADARMARKER99[…] //R8RADARBRK99[...] //R8RADARPAR99(…) next fact.' }],
        });
        const radarAdapter = {
          captureStream: vi.fn()
            .mockImplementationOnce(async function* () { yield { type: 'tool_call', id: 'r8tc1', name: 'WebSearch', input: { query: 'r8 abbr', limit: 5 } }; })
            .mockImplementationOnce(async function* () {}),
          call: vi.fn().mockImplementation(async req => {
            r8Prompts.push(JSON.stringify(req));
            const toolMsg = req.messages.find(m => m.role === 'tool')?.content ?? '';
            const parsedTool = JSON.parse(toolMsg.replace(/^<untrusted_web_result>\n|\n<\/untrusted_web_result>$/g, ''));
            return {
              text: JSON.stringify({
                items: parsedTool.results.map(r => ({
                  title: r.title, url: r.url, sourceName: 'R8Wire', summaryExcerpt: r.snippet,
                })),
                searchCount: 1,
              }),
            };
          }),
        };
        const { result } = await runCosmicWebBriefing({
          mode, perspective, language, payload,
          config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
          adapter: radarAdapter, toolExecutors: { WebSearch },
        });
        return result;
      }
      const adapter = {
        async call(req) {
          r8Prompts.push(JSON.stringify(req));
          if (mode === 'follow_up') {
            return { text: JSON.stringify({ question: 'q', answer: 'ok', bullets: ['one'], followUps: ['q1'] }) };
          }
          return {
            text: JSON.stringify({
              tldr: 'SafeR8Tldr //R8TLDRPAR99(…) //R8TLDRBRK99[…] //R8TLDRDOT99[...] next fact.',
              bullets: ['Safe bullet one', 'Safe bullet two'],
              impact: 'Safe impact',
              followUps: ['q1', 'q2'],
            }),
          };
        },
      };
      const { result } = await runCosmicWebBriefing({
        mode, perspective, language, payload,
        config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
        adapter,
      });
      return result;
    });
    const r8FeedUrl = 'https://private.example/r8.xml';
    const r8Clock = NOW + 400_000;
    const r8Svc = makeService({
      fetcher: async url => {
        if (url === r8FeedUrl) return { status: 200, url, text: async () => r8FeedRss };
        if (url.endsWith('/r8-empty-blocks')) return { status: 200, url, text: async () => r8EmptyBlocksHtml };
        return { status: 200, url, text: async () => '<article><p>ok</p></article>' };
      },
      requestAi: r8AgentAi,
      now: () => r8Clock,
    });
    await r8Svc.savePreferences('maya', {
      enabledDomainIds: [],
      customDomains: [
        { id: 'priv-r8', name: 'Priv R8', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: [r8FeedUrl] },
        { id: 'radar-r8', name: 'Radar R8', colorToken: 'gold', enabled: true, keywords: ['r8'], aiRadar: true, rssUrls: [] },
      ],
    });
    await r8Svc.refresh('maya', { domainId: 'priv-r8', force: true });
    agents.set('v4-maya-a', {
      ownerId: 'maya', name: 'v4-maya-a',
      capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up', 'cosmic_web_radar', 'cosmic_web_research'],
      encryptOutbound: false, ws: { readyState: 1, send: () => {} },
    });
    agents.set('v4-maya-b', {
      ownerId: 'maya', name: 'v4-maya-b',
      capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up'],
      encryptOutbound: false, ws: { readyState: 1, send: () => {} },
    });
    const mayaFeed = r8Svc.feed('maya', { domainId: 'priv-r8' });
    const r8ArticleCluster = mayaFeed.clusters.find(c => c.headline === 'Zeta Empty Block Article');
    const r8TplCluster = mayaFeed.clusters.find(c => c.headline === 'Eta Nested Template Feed');
    const r8UnclosedTplCluster = mayaFeed.clusters.find(c => c.headline === 'Theta Unclosed Nested Template');

    // (1a) Non-truncated article with empty `<p></p>` / `<p>  </p>` / `<div><br></div>` / `<code><p>...</p></code>` / trailing spaces:
    //      Clean Article display keeps original Markdown while real Agent model prompt receives ZERO credential markers
    const r8DisplayArt = await r8Svc.article('maya', r8ArticleCluster.id);
    expect(r8DisplayArt.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
    expect(r8DisplayArt.markdown).toContain('` //R8ARTICLEMARKER99 `@intranet:8080/api');
    await r8Svc.aiBrief('maya', 'user', r8ArticleCluster.id, { agentId: 'v4-maya-a', research: true });
    expect(r8Prompts.at(-1)).toContain('Safe r8 article');
    for (const secret of ['R8ARTICLEMARKER99', 'R8WSP99', 'R8DIVBR99', 'R8CODEP99', 'R8CODESP99', 'R8EMTRAIL99']) {
      expect(r8Prompts.at(-1)).not.toContain(secret);
    }
    // (1b) Pre-fix v3 (`extractorVersion: 3`) cached article row is NOT trusted by private `aiBrief`
    db.setArticleCache('maya', r8DisplayArt.itemId, {
      title: 'Old v3', markdown: 'Old v3 ` //OLDV3EMPTY99 `@intranet:8080', aiMarkdown: 'Old v3 ` //OLDV3EMPTY99 `@intranet:8080',
      extractorVersion: 3, truncated: false, quality: 'full', itemId: r8DisplayArt.itemId, clusterId: r8ArticleCluster.id, summaryExcerpt: 'Old',
    }, r8Clock + HOUR);
    await r8Svc.aiBrief('maya', 'user', r8ArticleCluster.id, { skipArticleFetch: true, agentId: 'v4-maya-a', research: true, force: true });
    expect(r8AgentAi.mock.lastCall[0].payload.articleMarkdown).toBeUndefined();
    expect(r8Prompts.at(-1)).not.toContain('OLDV3EMPTY99');

    // (2a) Nested `<template><template></template>discarded </template>` and `<template><script>...</script></template>`:
    //      persisted clean as v4 with ZERO markers or discarded text, and clean in model prompt
    expect(r8TplCluster.summaryExcerpt).toContain('Safe RSS');
    expect(r8TplCluster.summaryExcerpt).toContain('after.');
    expect(r8TplCluster.summaryExcerpt).not.toContain('R8RSSMARKER99');
    expect(r8TplCluster.summaryExcerpt).not.toContain('R8TSMARKER99');
    expect(r8TplCluster.summaryExcerpt).not.toContain('discarded');
    expect(r8UnclosedTplCluster.summaryExcerpt).toBe('Safe unclosed');
    expect(r8UnclosedTplCluster.summaryExcerpt).not.toContain('R8UNCLOSEDTPL99');
    await r8Svc.aiBrief('maya', 'user', r8TplCluster.id, { skipArticleFetch: true, agentId: 'v4-maya-a', research: true });
    expect(r8Prompts.at(-1)).toContain('Safe RSS');
    expect(r8Prompts.at(-1)).not.toContain('R8RSSMARKER99');
    expect(r8Prompts.at(-1)).not.toContain('R8TSMARKER99');
    expect(r8Prompts.at(-1)).not.toContain('discarded');

    // (3a) Private TLDR with attached balanced abbreviation markers (`(…)`, `[…]`, `[...]`) followed by prose:
    //      scrubbed BEFORE HMAC certification and absent in cross-Agent authenticated follow-up model prompt
    const r8Brief = await r8Svc.aiBrief('maya', 'user', r8TplCluster.id, { skipArticleFetch: true, agentId: 'v4-maya-a', research: true, force: true });
    expect(r8Brief.briefContextVersion).toBe(PRIVATE_BRIEF_CONTEXT_VERSION);
    expect(typeof r8Brief.briefContextToken).toBe('string');
    expect(r8Brief.tldr).toContain('SafeR8Tldr');
    expect(r8Brief.tldr).toContain('next fact.');
    for (const secret of ['R8TLDRPAR99', 'R8TLDRBRK99', 'R8TLDRDOT99']) {
      expect(r8Brief.tldr).not.toContain(secret);
    }
    await r8Svc.followUp('maya', 'user', r8TplCluster.id, {
      question: 'Cross agent follow-up?',
      briefContext: r8Brief.tldr,
      briefContextToken: r8Brief.briefContextToken,
      agentId: 'v4-maya-b',
      research: true,
    });
    expect(r8Prompts.at(-1)).toContain('SafeR8Tldr');
    expect(r8Prompts.at(-1)).toContain('next fact.');
    for (const secret of ['R8TLDRPAR99', 'R8TLDRBRK99', 'R8TLDRDOT99']) {
      expect(r8Prompts.at(-1)).not.toContain(secret);
    }

    // (3b) Real generic WebSearch Radar result with attached balanced abbreviation markers (`[…]`, `[...]`, `(…)`):
    //      stripped BEFORE Radar model sees it, absent from v4 DB excerpt and subsequent private briefing model prompt
    const r8RadarRes = await r8Svc.radarScan('maya', 'user', 'radar-r8');
    expect(r8RadarRes.added).toBe(1);
    const r8RadarCluster = r8Svc.feed('maya', { domainId: 'radar-r8' }).clusters.find(c => c.headline === 'R8 Abbr Radar Story');
    expect(r8RadarCluster.summaryExcerpt).toContain('SafeR8Radar');
    expect(r8RadarCluster.summaryExcerpt).toContain('next fact.');
    for (const secret of ['R8RADARMARKER99', 'R8RADARBRK99', 'R8RADARPAR99']) {
      expect(r8RadarCluster.summaryExcerpt).not.toContain(secret);
    }
    await r8Svc.aiBrief('maya', 'user', r8RadarCluster.id, { skipArticleFetch: true, agentId: 'v4-maya-a', research: true });
    expect(r8Prompts.at(-1)).toContain('SafeR8Radar');
    for (const secret of ['R8RADARMARKER99', 'R8RADARBRK99', 'R8RADARPAR99']) {
      expect(r8Prompts.at(-1)).not.toContain(secret);
    }

    // (3c) Old v3 (`excerptVersion: 3`) Radar output and old v3 (`briefContextVersion: 3`) private brief output are rejected/omitted!
    const oldV3ReqAi = vi.fn(async req => {
      if (req.mode === 'topic_radar') {
        return {
          items: [{ title: 'Old V3 Radar Story', url: 'https://radar.example/old-v3-radar', sourceName: 'V3Radar', summaryExcerpt: 'Old v3 radar display' }],
          searchCount: 1,
          excerptVersion: 3,
        };
      }
      if (req.mode === 'brief') {
        return {
          tldr: 'Old v3 uncertified TLDR //OLDV3TLDR99(…) next',
          sections: [{ heading: 'H', body: 'Body' }],
          bullets: ['b1', 'b2'], impact: 'ok', media: [], communityHighlights: [], citations: [],
          followUps: ['q1', 'q2'], researched: false, searchCount: 0, evidenceCount: 0, fullMarkdown: 'Safe md',
          briefContextVersion: 3,
        };
      }
      return r8AgentAi(req);
    });
    const oldV3Svc = makeService({ requestAi: oldV3ReqAi, now: () => r8Clock + 120_000 });
    await oldV3Svc.radarScan('maya', 'user', 'radar-r8');
    const oldV3RadarCluster = oldV3Svc.feed('maya', { domainId: 'radar-r8' }).clusters.find(c => c.headline === 'Old V3 Radar Story');
    expect(oldV3RadarCluster.summaryExcerpt).toBe('Old v3 radar display');
    await oldV3Svc.aiBrief('maya', 'user', oldV3RadarCluster.id, { skipArticleFetch: true, agentId: 'v4-maya-a', research: true });
    expect(oldV3ReqAi.mock.lastCall[0].payload.summaryExcerpt).toBe('');
    const oldV3BriefRes = await oldV3Svc.aiBrief('maya', 'user', r8UnclosedTplCluster.id, { skipArticleFetch: true, agentId: 'v4-maya-b', research: true, force: true });
    expect(oldV3BriefRes.briefContextToken).toBeUndefined();
    expect(oldV3BriefRes.briefContextVersion).toBeUndefined();
    await oldV3Svc.followUp('maya', 'user', r8UnclosedTplCluster.id, {
      question: 'Follow up after old v3 brief?',
      briefContext: oldV3BriefRes.tldr,
      agentId: 'v4-maya-b',
      research: true,
    });
    expect(r8AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    expect(r8Prompts.at(-1)).not.toContain('OLDV3TLDR99');

    // Round 30 (PR #2032 Round 9) Blocker #1/#2/#3 isolated end-to-end regressions:
    // (1) Nested blocks inside `<em>`/`<strong>` (`<em><p>//R9ARTFIXTURE</p></em><code>@intranet:8080/a</code>` and unfinished `<script>` truncation)
    //     derive redaction & cutoff boundaries from surviving rendered whitespace, preserving separators when inner blocks empty after redaction; v4 caches rejected.
    // (2) Foreign-content `<svg><![CDATA[ > </template> ]]></svg>` inside `<template>` in XML-escaped RSS description AND `<textarea>` inside `<template>` for media extraction
    //     never prematurely exit `skipStack`; pre-fix v4 RSS/Radar excerpts are omitted until upgraded to v5.
    // (3) Spaced balanced ellipses (`//R9BRIEFFIX[. . .] next fact.`) and >16-space padded abbreviation markers (`//R9RADAR17[                 ...] next fact.`)
    //     are caught within shared scan budget (failing closed on budget exhaustion); HMAC binds exact server-scrubbed `tldr` returned to client; v4 provenance rejected.
    const r9NestedEmHtml = '<article>Safe r9 em <em><p>//R9ARTFIXTURE99</p></em><code>@intranet:8080/a</code> and <strong><div><p>//R9STRFIX99</p></div></strong><code>@intranet:8080/b</code> and <em><p>KeepParaA</p><p>https://only.secret.internal/x</p><p>KeepParaB</p></em> end.</article>';
    const r9EmScriptTruncHtml = '<article>Safe r9 trunc <em><p>//R9EMTRUNC99</p></em><script>unclosed';
    const r9FeedRss = `<rss><channel>
      <item><title>Iota Nested Em Block Article</title><link>https://private.example/r9-nested-em</link><description>Nested em desc</description></item>
      <item><title>Kappa Em Script Trunc Article</title><link>https://private.example/r9-em-trunc</link><description>Em trunc desc</description></item>
      <item><title>Lambda Svg Cdata Template Feed</title><link>https://private.example/r9-svg-cdata</link><description>Safe r9 svg //R9SVGFIX99&lt;wbr&gt;&lt;template&gt;&lt;svg&gt;&lt;![CDATA[ &gt; &lt;/template&gt; ]]&gt;&lt;/svg&gt;discarded &lt;/template&gt;@intranet:8080/api end.</description></item>
    </channel></rss>`;
    // Also verify `extractMarkupMedia` shares RCDATA `<textarea>` & SVG CDATA handling inside `<template>`
    const r9MediaCheck = extractMarkupMedia(
      '<template><textarea></template><img src="https://secret.example/textarea-leak.png"></textarea></template><template><svg><![CDATA[ > </template> ]]></svg><img src="https://secret.example/svg-leak.png"></template><img src="https://public.example/r9-ok.png">',
      'https://public.example/',
    );
    expect(r9MediaCheck.map(m => m.url)).toEqual(['https://public.example/r9-ok.png']);

    const r9Prompts = [];
    const r9RadarUrl = 'https://radar.example/r9-spaced';
    const r9AgentAi = vi.fn(async ({ mode, perspective, language, payload }) => {
      if (mode === 'topic_radar') {
        const WebSearch = vi.fn().mockResolvedValue({
          provider: 'generic',
          results: [{
            url: r9RadarUrl,
            title: 'R9 Spaced Ellipsis Story',
            snippet: `SafeR9Radar //R9RADAR17[${' '.repeat(17)}...] //R9RADARSP[. . .] //50%增长 next fact.`,
          }],
        });
        const radarAdapter = {
          captureStream: vi.fn()
            .mockImplementationOnce(async function* () { yield { type: 'tool_call', id: 'r9tc1', name: 'WebSearch', input: { query: 'r9 spaced', limit: 5 } }; })
            .mockImplementationOnce(async function* () {}),
          call: vi.fn().mockImplementation(async req => {
            r9Prompts.push(JSON.stringify(req));
            const toolMsg = req.messages.find(m => m.role === 'tool')?.content ?? '';
            const parsedTool = JSON.parse(toolMsg.replace(/^<untrusted_web_result>\n|\n<\/untrusted_web_result>$/g, ''));
            return {
              text: JSON.stringify({
                items: parsedTool.results.map(r => ({
                  title: r.title, url: r.url, sourceName: 'R9Wire', summaryExcerpt: r.snippet,
                })),
                searchCount: 1,
              }),
            };
          }),
        };
        const { result } = await runCosmicWebBriefing({
          mode, perspective, language, payload,
          config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
          adapter: radarAdapter, toolExecutors: { WebSearch },
        });
        return result;
      }
      const adapter = {
        async call(req) {
          r9Prompts.push(JSON.stringify(req));
          if (mode === 'follow_up') {
            return { text: JSON.stringify({ question: 'q', answer: 'ok', bullets: ['one'], followUps: ['q1'] }) };
          }
          return {
            text: JSON.stringify({
              tldr: `SafeR9Tldr //R9BRIEFFIX[. . .] //R9BRIEFPAD[${' '.repeat(17)}...] //50%增长 next fact.`,
              bullets: ['Safe bullet one', 'Safe bullet two'],
              impact: 'Safe impact',
              followUps: ['q1', 'q2'],
            }),
          };
        },
      };
      const { result } = await runCosmicWebBriefing({
        mode, perspective, language, payload,
        config: { fastModel: 'test/fast', defaultModel: 'test/fast' },
        adapter,
      });
      return result;
    });
    const r9FeedUrl = 'https://private.example/r9.xml';
    const r9Clock = NOW + 600_000;
    const r9Svc = makeService({
      fetcher: async url => {
        if (url === r9FeedUrl) return { status: 200, url, text: async () => r9FeedRss };
        if (url.endsWith('/r9-nested-em')) return { status: 200, url, text: async () => r9NestedEmHtml };
        if (url.endsWith('/r9-em-trunc')) return { status: 200, url, text: async () => r9EmScriptTruncHtml };
        return { status: 200, url, text: async () => '<article><p>ok</p></article>' };
      },
      requestAi: r9AgentAi,
      now: () => r9Clock,
    });
    await r9Svc.savePreferences('nina', {
      enabledDomainIds: [],
      customDomains: [
        { id: 'priv-r9', name: 'Priv R9', colorToken: 'cyan', enabled: true, keywords: [], rssUrls: [r9FeedUrl] },
        { id: 'radar-r9', name: 'Radar R9', colorToken: 'gold', enabled: true, keywords: ['r9'], aiRadar: true, rssUrls: [] },
      ],
    });
    await r9Svc.refresh('nina', { domainId: 'priv-r9', force: true });
    agents.set('v5-nina-a', {
      ownerId: 'nina', name: 'v5-nina-a',
      capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up', 'cosmic_web_radar', 'cosmic_web_research'],
      encryptOutbound: false, ws: { readyState: 1, send: () => {} },
    });
    agents.set('v5-nina-b', {
      ownerId: 'nina', name: 'v5-nina-b',
      capabilities: ['cosmic_web_briefing', 'cosmic_web_follow_up'],
      encryptOutbound: false, ws: { readyState: 1, send: () => {} },
    });
    const ninaFeed = r9Svc.feed('nina', { domainId: 'priv-r9' });
    const r9EmCluster = ninaFeed.clusters.find(c => c.headline === 'Iota Nested Em Block Article');
    const r9EmTruncCluster = ninaFeed.clusters.find(c => c.headline === 'Kappa Em Script Trunc Article');
    const r9SvgCluster = ninaFeed.clusters.find(c => c.headline === 'Lambda Svg Cdata Template Feed');

    // (1a) `<em><p>//R9ARTFIXTURE99</p></em><code>@intranet:8080/a</code>` & nested redacted block separator preservation
    const r9DisplayArt = await r9Svc.article('nina', r9EmCluster.id);
    expect(r9DisplayArt.extractorVersion).toBe(ARTICLE_EXTRACTOR_VERSION);
    await r9Svc.aiBrief('nina', 'user', r9EmCluster.id, { agentId: 'v5-nina-a', research: true });
    const r9EmPrompt = r9Prompts.at(-1);
    expect(r9EmPrompt).toContain('Safe r9 em');
    expect(r9EmPrompt).toContain('KeepParaA');
    expect(r9EmPrompt).toContain('KeepParaB');
    expect(r9EmPrompt).not.toContain('KeepParaAKeepParaB');
    expect(r9EmPrompt).not.toContain('R9ARTFIXTURE99');
    expect(r9EmPrompt).not.toContain('R9STRFIX99');
    expect(r9EmPrompt).not.toContain('only.secret.internal');
    // (1b) `<em><p>//R9EMTRUNC99</p></em><script>unclosed` rewinds trailing marker
    await r9Svc.aiBrief('nina', 'user', r9EmTruncCluster.id, { agentId: 'v5-nina-a', research: true });
    expect(r9Prompts.at(-1)).toContain('Safe r9 trunc');
    expect(r9Prompts.at(-1)).not.toContain('R9EMTRUNC99');
    // (1c) Pre-fix v4 (`extractorVersion: 4`) cached article row is rejected by private `aiBrief`
    db.setArticleCache('nina', r9DisplayArt.itemId, {
      title: 'Old v4', markdown: 'Old v4 *//OLDV4EM99* ` @intranet:8080 `', aiMarkdown: 'Old v4 *//OLDV4EM99* ` @intranet:8080 `',
      extractorVersion: 4, truncated: false, quality: 'full', itemId: r9DisplayArt.itemId, clusterId: r9EmCluster.id, summaryExcerpt: 'Old',
    }, r9Clock + HOUR);
    await r9Svc.aiBrief('nina', 'user', r9EmCluster.id, { skipArticleFetch: true, agentId: 'v5-nina-a', research: true, force: true });
    expect(r9AgentAi.mock.lastCall[0].payload.articleMarkdown).toBeUndefined();
    expect(r9Prompts.at(-1)).not.toContain('OLDV4EM99');

    // (2) XML-escaped SVG CDATA inside `<template>` never prematurely exits `skipStack`
    expect(r9SvgCluster.summaryExcerpt).toContain('Safe r9 svg');
    expect(r9SvgCluster.summaryExcerpt).toContain('end.');
    expect(r9SvgCluster.summaryExcerpt).not.toContain('R9SVGFIX99');
    expect(r9SvgCluster.summaryExcerpt).not.toContain('discarded');
    await r9Svc.aiBrief('nina', 'user', r9SvgCluster.id, { skipArticleFetch: true, agentId: 'v5-nina-a', research: true });
    expect(r9Prompts.at(-1)).toContain('Safe r9 svg');
    expect(r9Prompts.at(-1)).not.toContain('R9SVGFIX99');
    expect(r9Prompts.at(-1)).not.toContain('discarded');

    // (3a) Spaced balanced ellipses (`[. . .]`, `[17 spaces...]`) in private TLDR -> cross-Agent HMAC followUp, preserving `//50%增长`
    const r9Brief = await r9Svc.aiBrief('nina', 'user', r9SvgCluster.id, { skipArticleFetch: true, agentId: 'v5-nina-a', research: true, force: true });
    expect(r9Brief.briefContextVersion).toBe(PRIVATE_BRIEF_CONTEXT_VERSION);
    expect(typeof r9Brief.briefContextToken).toBe('string');
    expect(r9Brief.tldr).toContain('SafeR9Tldr');
    expect(r9Brief.tldr).toContain('//50%增长');
    expect(r9Brief.tldr).not.toContain('R9BRIEFFIX');
    expect(r9Brief.tldr).not.toContain('R9BRIEFPAD');
    await r9Svc.followUp('nina', 'user', r9SvgCluster.id, {
      question: 'Follow up with v5 token?',
      briefContext: r9Brief.tldr,
      briefContextToken: r9Brief.briefContextToken,
      agentId: 'v5-nina-b',
      research: true,
    });
    expect(r9Prompts.at(-1)).toContain('SafeR9Tldr');
    expect(r9Prompts.at(-1)).toContain('//50%增长');
    expect(r9Prompts.at(-1)).not.toContain('R9BRIEFFIX');
    expect(r9Prompts.at(-1)).not.toContain('R9BRIEFPAD');

    // (3b) Real Radar WebSearch with 17-space padded bracketed ellipsis & spaced dots -> stripped before Radar model & v5 DB
    const r9RadarRes = await r9Svc.radarScan('nina', 'user', 'radar-r9');
    expect(r9RadarRes.added).toBe(1);
    const r9RadarCluster = r9Svc.feed('nina', { domainId: 'radar-r9' }).clusters.find(c => c.headline === 'R9 Spaced Ellipsis Story');
    expect(r9RadarCluster.summaryExcerpt).toContain('SafeR9Radar');
    expect(r9RadarCluster.summaryExcerpt).toContain('//50%增长');
    expect(r9RadarCluster.summaryExcerpt).not.toContain('R9RADAR17');
    expect(r9RadarCluster.summaryExcerpt).not.toContain('R9RADARSP');
    await r9Svc.aiBrief('nina', 'user', r9RadarCluster.id, { skipArticleFetch: true, agentId: 'v5-nina-a', research: true });
    expect(r9Prompts.at(-1)).toContain('SafeR9Radar');
    expect(r9Prompts.at(-1)).not.toContain('R9RADAR17');
    expect(r9Prompts.at(-1)).not.toContain('R9RADARSP');

    // (3c) Server binds HMAC strictly to exact server-scrubbed `tldr` returned to client (rejecting raw un-scrubbed TLDR)
    const serverScrubReqAi = vi.fn(async req => {
      if (req.mode === 'brief') {
        return {
          tldr: 'ServerScrubOk //SERVERCAUGHT99[. . .] tail',
          sections: [{ heading: 'H', body: 'Body' }],
          bullets: ['b1', 'b2'], impact: 'ok', media: [], communityHighlights: [], citations: [],
          followUps: ['q1', 'q2'], researched: false, searchCount: 0, evidenceCount: 0, fullMarkdown: 'Safe md',
          briefContextVersion: PRIVATE_BRIEF_CONTEXT_VERSION,
        };
      }
      return r9AgentAi(req);
    });
    const serverScrubSvc = makeService({ requestAi: serverScrubReqAi, now: () => r9Clock + 60_000 });
    const serverScrubBrief = await serverScrubSvc.aiBrief('nina', 'user', r9EmTruncCluster.id, { skipArticleFetch: true, agentId: 'v5-nina-a', research: true, force: true });
    expect(serverScrubBrief.tldr).not.toContain('SERVERCAUGHT99');
    expect(serverScrubBrief.tldr).toContain('ServerScrubOk');
    // Replaying raw un-scrubbed text with the minted token MUST fail HMAC verification
    await serverScrubSvc.followUp('nina', 'user', r9EmTruncCluster.id, {
      question: 'Raw text with scrubbed token?',
      briefContext: 'ServerScrubOk //SERVERCAUGHT99[. . .] tail',
      briefContextToken: serverScrubBrief.briefContextToken,
      agentId: 'v5-nina-b',
      research: true,
    });
    expect(r9AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();
    // Replaying the exact returned scrubbed `tldr` with its token MUST succeed
    await serverScrubSvc.followUp('nina', 'user', r9EmTruncCluster.id, {
      question: 'Scrubbed text with scrubbed token?',
      briefContext: serverScrubBrief.tldr,
      briefContextToken: serverScrubBrief.briefContextToken,
      agentId: 'v5-nina-b',
      research: true,
    });
    expect(r9AgentAi.mock.lastCall[0].payload.briefContext).toBe(serverScrubBrief.tldr);

    // (3d) Old v4 (`excerptVersion: 4`, `briefContextVersion: 4`) provenance is rejected/omitted!
    const oldV4ReqAi = vi.fn(async req => {
      if (req.mode === 'topic_radar') {
        return {
          items: [{ title: 'Old V4 Radar Story', url: 'https://radar.example/old-v4-radar', sourceName: 'V4Radar', summaryExcerpt: 'Old v4 radar display' }],
          searchCount: 1,
          excerptVersion: 4,
        };
      }
      if (req.mode === 'brief') {
        return {
          tldr: 'Old v4 uncertified TLDR //OLDV4TLDR99[. . .] next',
          sections: [{ heading: 'H', body: 'Body' }],
          bullets: ['b1', 'b2'], impact: 'ok', media: [], communityHighlights: [], citations: [],
          followUps: ['q1', 'q2'], researched: false, searchCount: 0, evidenceCount: 0, fullMarkdown: 'Safe md',
          briefContextVersion: 4,
        };
      }
      return r9AgentAi(req);
    });
    const oldV4Svc = makeService({ requestAi: oldV4ReqAi, now: () => r9Clock + 180_000 });
    await oldV4Svc.radarScan('nina', 'user', 'radar-r9');
    const oldV4RadarCluster = oldV4Svc.feed('nina', { domainId: 'radar-r9' }).clusters.find(c => c.headline === 'Old V4 Radar Story');
    await oldV4Svc.aiBrief('nina', 'user', oldV4RadarCluster.id, { skipArticleFetch: true, agentId: 'v5-nina-a', research: true });
    expect(oldV4ReqAi.mock.lastCall[0].payload.summaryExcerpt).toBe('');
    const oldV4BriefRes = await oldV4Svc.aiBrief('nina', 'user', r9EmTruncCluster.id, { skipArticleFetch: true, agentId: 'v5-nina-b', research: true, force: true });
    expect(oldV4BriefRes.briefContextToken).toBeUndefined();
    expect(oldV4BriefRes.briefContextVersion).toBeUndefined();
    await oldV4Svc.followUp('nina', 'user', r9EmTruncCluster.id, {
      question: 'Follow up after old v4 brief?',
      briefContext: oldV4BriefRes.tldr,
      agentId: 'v5-nina-b',
      research: true,
    });
    expect(r9AgentAi.mock.lastCall[0].payload.briefContext).toBeUndefined();

    // Mixed public/private dailyBriefing carries per-story isPrivateSource: true on private stories (enabling Agent defense-in-depth) while keeping public stories clean.
    const mixedDailyReqAi = vi.fn(async () => dailyResult);
    const mixedDailySvc = makeService({ requestAi: mixedDailyReqAi });
    await mixedDailySvc.dailyBriefing('alice', 'user', { force: true });
    const dailyDomains = mixedDailyReqAi.mock.lastCall[0].payload.domains;
    const privDailyDomain = dailyDomains.find(d => d.id === 'custom-sports');
    const pubDailyDomain = dailyDomains.find(d => d.id === 'ai');
    const privDailyStory = privDailyDomain?.stories.find(s => s.headline === 'Private img note');
    const pubDailyStory = pubDailyDomain?.stories.find(s => s.headline === 'Public AI news');
    expect(privDailyStory?.isPrivateSource).toBe(true);
    expect(privDailyStory?.summaryExcerpt).not.toContain('REVIEWPASS99');
    expect(privDailyStory?.summaryExcerpt).not.toContain('privateidn1');
    expect(pubDailyStory?.isPrivateSource).toBeUndefined();

    // CW2-05 & Round 3 Blocker #1: legacy v1 Agent (no cosmic_web_cancel) retains remote slot accounting after caller abort,
    // defers subsequent requests, AND hands off freed slots when awakened waiters hit the rate boundary (never hanging).
    agents.clear();
    const v1Frames = agent('legacy-v1', 'alice', ['cosmic_web_briefing']);
    const lac1 = new AbortController();
    const lac2 = new AbortController();
    const lp1 = requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'legacy-v1', mode: 'brief', signal: lac1.signal });
    const lp2 = requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'legacy-v1', mode: 'brief', signal: lac2.signal });
    await new Promise(r => setImmediate(r));
    expect(v1Frames).toHaveLength(2);
    lac1.abort(Object.assign(new Error('cancelled'), { status: 499 }));
    await expect(lp1).rejects.toMatchObject({ status: 499 });
    expect(v1Frames.some(f => f.type === 'cosmic_web_ai_cancel')).toBe(false);
    // Start 3rd request while both legacy slots are still occupied -> must NOT send 3rd frame yet
    const lp3 = requestCosmicWebAi({ userId: 'alice', userRole: 'user', agentId: 'legacy-v1', mode: 'brief' });
    await new Promise(r => setImmediate(r));
    expect(v1Frames).toHaveLength(2);
    // Legacy Agent finishes abandoned request 1 -> silently discarded & wakes deferred request 3!
    handleCosmicWebAiResponse('legacy-v1', { requestId: v1Frames[0].requestId, ok: true, result: storyResult });
    await new Promise(r => setImmediate(r));
    expect(v1Frames).toHaveLength(3);
    handleCosmicWebAiResponse('legacy-v1', { requestId: v1Frames[2].requestId, ok: true, result: storyResult });
    await expect(lp3).resolves.toEqual(storyResult);
    handleCosmicWebAiResponse('legacy-v1', { requestId: v1Frames[1].requestId, ok: true, result: storyResult });
    await expect(lp2).resolves.toEqual(storyResult);

    // Round 3 Blocker #1: multiple legacy waiters at the 20/10min rate boundary must ALL settle cleanly via slot handoff (zero hangs).
    const rateFrames = agent('legacy-rate', 'dave', ['cosmic_web_briefing']);
    for (let i = 0; i < 17; i++) {
      const p = requestCosmicWebAi({ userId: 'dave', userRole: 'user', agentId: 'legacy-rate', mode: 'brief' });
      await new Promise(r => setImmediate(r));
      handleCosmicWebAiResponse('legacy-rate', { requestId: rateFrames.at(-1).requestId, ok: true, result: storyResult });
      await expect(p).resolves.toEqual(storyResult);
    }
    // Consume tokens #18 and #19 and abandon both remote slots
    const dac1 = new AbortController();
    const dac2 = new AbortController();
    const dp18 = requestCosmicWebAi({ userId: 'dave', userRole: 'user', agentId: 'legacy-rate', mode: 'brief', signal: dac1.signal });
    const dp19 = requestCosmicWebAi({ userId: 'dave', userRole: 'user', agentId: 'legacy-rate', mode: 'brief', signal: dac2.signal });
    await new Promise(r => setImmediate(r));
    const req18 = rateFrames.at(-2).requestId;
    const req19 = rateFrames.at(-1).requestId;
    dac1.abort(Object.assign(new Error('cancelled'), { status: 499 }));
    dac2.abort(Object.assign(new Error('cancelled'), { status: 499 }));
    await expect(dp18).rejects.toMatchObject({ status: 499 });
    await expect(dp19).rejects.toMatchObject({ status: 499 });
    // Queue 3 waiters while dave is at 19/20 (only 1 token remains)
    const w1 = requestCosmicWebAi({ userId: 'dave', userRole: 'user', agentId: 'legacy-rate', mode: 'brief' });
    const w2 = requestCosmicWebAi({ userId: 'dave', userRole: 'user', agentId: 'legacy-rate', mode: 'brief' });
    const w3 = requestCosmicWebAi({ userId: 'dave', userRole: 'user', agentId: 'legacy-rate', mode: 'brief' });
    // Finishing req18 wakes w1 (consumes token #20 and dispatches)
    handleCosmicWebAiResponse('legacy-rate', { requestId: req18, ok: true, result: storyResult });
    await new Promise(r => setImmediate(r));
    const req20 = rateFrames.at(-1).requestId;
    // Finishing req19 wakes w2 -> hits 429 -> MUST hand off freed slot to w3 -> w3 ALSO rejects 429 cleanly!
    handleCosmicWebAiResponse('legacy-rate', { requestId: req19, ok: true, result: storyResult });
    await expect(w2).rejects.toMatchObject({ status: 429 });
    await expect(w3).rejects.toMatchObject({ status: 429 });
    handleCosmicWebAiResponse('legacy-rate', { requestId: req20, ok: true, result: storyResult });
    await expect(w1).resolves.toEqual(storyResult);

    // CW2-08: legacy colliding custom domain migration preserves RSS source IDs, disabledSources, and avoids duplicate re-ingest
    const feedUrl = 'https://feeds.example.com/hoops.xml';
    const legacySrcId = `rss-${createHash('sha256').update(JSON.stringify(['bob', 'sports', feedUrl])).digest('hex')}`;
    db.saveUserPrefs('bob', {
      enabledDomainIds: ['ai'],
      customDomains: [{ id: 'sports', name: 'Bob Hoops', colorToken: 'gold', enabled: true, keywords: [], rssUrls: [feedUrl] }],
      watchKeywords: [], muteKeywords: [], disabledSources: [legacySrcId], preferredAgentId: '', defaultPerspective: 'balanced', onboarded: true, autoRefreshMinutes: 15,
    }, NOW);
    ingestCosmicWebItems({ id: legacySrcId, ownerUserId: 'bob', domainId: 'sports', name: 'Bob Hoops', url: feedUrl, kind: 'rss' }, [item('Hidden hoops story', 'https://hoops.example/1')], NOW);
    const bobBoot = svc.bootstrap('bob', 'user');
    const migratedCustom = bobBoot.preferences.customDomains[0];
    expect(migratedCustom.id).toBe('custom-sports');
    const expectedNewSrcId = `rss-${createHash('sha256').update(JSON.stringify(['bob', 'custom-sports', feedUrl])).digest('hex')}`;
    expect(bobBoot.preferences.disabledSources).toContain(expectedNewSrcId);
    // Full preferences save keeps the migrated source disabled & hidden
    await svc.savePreferences('bob', { ...bobBoot.preferences });
    expect(svc.feed('bob', { domainId: 'custom-sports' }).total).toBe(0);
    // Re-ingesting the same feed URL under migrated source ID produces 0 duplicates
    const reAdded = ingestCosmicWebItems({ id: expectedNewSrcId, ownerUserId: 'bob', domainId: 'custom-sports', name: 'Bob Hoops', url: feedUrl, kind: 'rss' }, [item('Hidden hoops story', 'https://hoops.example/1')], NOW);
    expect(reAdded).toBe(0);

    // Round 3 Blocker #3: retired custom-sports domain with overlapping feed + article URL must NOT cause UNIQUE collision during sports migration
    const overlapUrl = 'https://feeds.example.com/overlap.xml';
    const overlapArticle = 'https://overlap.example/story-1';
    const retiredSrcId = `rss-${createHash('sha256').update(JSON.stringify(['carol', 'custom-sports', overlapUrl])).digest('hex')}`;
    const activeLegacySrcId = `rss-${createHash('sha256').update(JSON.stringify(['carol', 'sports', overlapUrl])).digest('hex')}`;
    ingestCosmicWebItems({ id: retiredSrcId, ownerUserId: 'carol', domainId: 'custom-sports', name: 'Retired Hoops', url: overlapUrl, kind: 'rss' }, [item('Shared hoops headline', overlapArticle)], NOW);
    ingestCosmicWebItems({ id: activeLegacySrcId, ownerUserId: 'carol', domainId: 'sports', name: 'Carol Hoops', url: overlapUrl, kind: 'rss' }, [item('Shared hoops headline', overlapArticle)], NOW);
    db.saveUserPrefs('carol', {
      enabledDomainIds: ['ai'],
      customDomains: [{ id: 'sports', name: 'Carol Hoops', colorToken: 'gold', enabled: true, keywords: [], rssUrls: [overlapUrl] }],
      watchKeywords: [], muteKeywords: [], disabledSources: [], preferredAgentId: '', defaultPerspective: 'balanced', onboarded: true, autoRefreshMinutes: 15,
    }, NOW);
    const carolBoot = svc.bootstrap('carol', 'user');
    expect(carolBoot.preferences.customDomains[0].id).toBe('custom-sports-2');
    expect(svc.feed('carol', { domainId: 'custom-sports-2' }).total).toBe(1);
    await expect(svc.savePreferences('carol', { ...carolBoot.preferences })).resolves.toBeTruthy();

    // Round 4 Blocker #3: retired legacy custom domain 'sports' (persisted rows only, absent from current prefs.customDomains)
    // must migrate to retired-sports and NEVER resurrect when the user enables built-in Sports.
    const erinFeed = 'https://feeds.example.com/erin-retired-hoops.xml';
    const erinLegacySrc = `rss-${createHash('sha256').update(JSON.stringify(['erin', 'sports', erinFeed])).digest('hex')}`;
    ingestCosmicWebItems({ id: erinLegacySrc, ownerUserId: 'erin', domainId: 'sports', name: 'Erin Retired Hoops', url: erinFeed, kind: 'rss' }, [item('Retired private hoops leak', 'https://retired.example/1')], NOW);
    db.saveUserPrefs('erin', {
      enabledDomainIds: ['sports'], customDomains: [], watchKeywords: [], muteKeywords: [],
      disabledSources: [], preferredAgentId: '', defaultPerspective: 'balanced', onboarded: true, autoRefreshMinutes: 15,
    }, NOW);
    const erinBoot = svc.bootstrap('erin', 'user');
    expect(JSON.stringify(erinBoot.graph)).not.toContain('Retired private hoops leak');
    expect(svc.feed('erin', { domainId: 'sports' }).clusters.some(c => c.headline === 'Retired private hoops leak')).toBe(false);
    expect(db.listPersistedUserDomainIds('erin')).toContain('retired-sports');
    expect(db.listPersistedUserDomainIds('erin')).not.toContain('sports');

    // Round 4 Blocker #4: followUp & aiBrief send selected item's OWN summaryExcerpt AND include selected item in bounded sources even beyond index 12.
    const manyClusterId = 'cluster-14-sources';
    db.upsertCluster({ id: manyClusterId, ownerUserId: null, headline: 'Cluster Head 0', summaryExcerpt: 'Cluster Excerpt 0', keywords: ['nba'], publishedAt: NOW });
    let last14Id = '';
    for (let i = 0; i < 14; i++) {
      const sid = `pub-many-${i}`;
      db.upsertSource({ id: sid, ownerUserId: null, domainId: 'ai', name: `Wire ${i}`, url: `https://wire${i}.example/feed`, kind: 'rss' });
      const iid = `many-item-${i}`;
      last14Id = iid;
      db.insertItem({
        id: iid, ownerUserId: null, clusterId: manyClusterId, sourceId: sid, domainId: 'ai',
        url: `https://wire${i}.example/story`, title: `Headline ${i}`, summaryExcerpt: `Excerpt from source ${i}`,
        publishedAt: NOW - i * 1000, hasHotMetric: false, media: [], sourceName: `Wire ${i}`,
      });
    }
    agents.clear();
    agent('v2-many', 'alice', ['cosmic_web_briefing', 'cosmic_web_research', 'cosmic_web_follow_up', 'cosmic_web_radar', 'cosmic_web_cancel']);
    await svc.aiBrief('alice', 'user', manyClusterId, { itemId: last14Id, skipArticleFetch: true });
    const brief14Payload = requestAi.mock.lastCall[0].payload;
    expect(brief14Payload.headline).toBe('Headline 13');
    expect(brief14Payload.summaryExcerpt).toBe('Excerpt from source 13');
    expect(brief14Payload.sources[0].id).toBe(last14Id);
    expect(brief14Payload.sources).toHaveLength(12);
    await svc.followUp('alice', 'user', manyClusterId, { itemId: last14Id, question: 'What did Wire 13 report?' });
    const fuPayload = requestAi.mock.lastCall[0].payload;
    expect(fuPayload.headline).toBe('Headline 13');
    expect(fuPayload.sourceUrl).toBe('https://wire13.example/story');
    expect(fuPayload.summaryExcerpt).toBe('Excerpt from source 13');
    expect(fuPayload.sources[0].id).toBe(last14Id);
    expect(fuPayload.sources).toHaveLength(12);

    // Round 4 Blocker #1 + Nit 1 (fake timers): late-dispatched legacy requests reaching caller deadline reject caller (504)
    // while retaining remote slot accounting until reply/remote deadline; per-user waiter cap (4) spans across Agents.
    vi.useFakeTimers();
    try {
      agents.clear();
      const ftFramesA = agent('legacy-ft-a', 'frank', ['cosmic_web_briefing']);
      const ftFramesB = agent('legacy-ft-b', 'frank', ['cosmic_web_briefing']);
      // Fill both slots on Agent A and abandon them at t=0
      const a1 = new AbortController(), a2 = new AbortController();
      const pA1 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-a', mode: 'brief', signal: a1.signal });
      const pA2 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-a', mode: 'brief', signal: a2.signal });
      await Promise.resolve();
      a1.abort(Object.assign(new Error('c'), { status: 499 }));
      a2.abort(Object.assign(new Error('c'), { status: 499 }));
      await expect(pA1).rejects.toMatchObject({ status: 499 });
      await expect(pA2).rejects.toMatchObject({ status: 499 });
      // Fill both slots on Agent B and abandon them too (for cross-Agent waiter cap test)
      const b1 = new AbortController(), b2 = new AbortController();
      const pB1 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-b', mode: 'brief', signal: b1.signal });
      const pB2 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-b', mode: 'brief', signal: b2.signal });
      await Promise.resolve();
      b1.abort(Object.assign(new Error('c'), { status: 499 }));
      b2.abort(Object.assign(new Error('c'), { status: 499 }));
      await expect(pB1).rejects.toMatchObject({ status: 499 });
      await expect(pB2).rejects.toMatchObject({ status: 499 });

      // Queue 2 waiters on Agent A + 2 waiters on Agent B = 4 total for frank -> 5th waiter on Agent B rejects 429
      const qa1 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-a', mode: 'brief' });
      const qa2 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-a', mode: 'brief' });
      const qb1 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-b', mode: 'brief' });
      const qb2 = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-b', mode: 'brief' });
      await expect(requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-b', mode: 'brief' }))
        .rejects.toMatchObject({ status: 429 });
      // Clean up Agent B waiters via disconnect
      agents.delete('legacy-ft-b');
      clearCosmicWebAiRequestsForAgent('legacy-ft-b');
      await expect(qb1).rejects.toMatchObject({ status: 503 });
      await expect(qb2).rejects.toMatchObject({ status: 503 });

      // Advance 50s -> both abandoned slots on Agent A finish -> qa1 and qa2 dispatch late with only 25s caller deadline left!
      vi.advanceTimersByTime(50_000);
      handleCosmicWebAiResponse('legacy-ft-a', { requestId: ftFramesA[0].requestId, ok: true, result: storyResult });
      handleCosmicWebAiResponse('legacy-ft-a', { requestId: ftFramesA[1].requestId, ok: true, result: storyResult });
      await Promise.resolve();
      await Promise.resolve();
      expect(ftFramesA).toHaveLength(4);
      // Advance 26s (total 76s > 75s caller deadline, but only 26s since dispatch < 75s remote deadline)
      vi.advanceTimersByTime(26_000);
      await expect(qa1).rejects.toMatchObject({ status: 504 });
      await expect(qa2).rejects.toMatchObject({ status: 504 });
      // Both remote slots on legacy-ft-a are STILL occupied -> a new request MUST wait, NOT send a 5th frame!
      const lateReq = requestCosmicWebAi({ userId: 'frank', userRole: 'user', agentId: 'legacy-ft-a', mode: 'brief' });
      await Promise.resolve();
      expect(ftFramesA).toHaveLength(4);
      // Once remote qa1 actually replies -> slot frees -> lateReq dispatches cleanly!
      handleCosmicWebAiResponse('legacy-ft-a', { requestId: ftFramesA[2].requestId, ok: true, result: storyResult });
      await Promise.resolve();
      await Promise.resolve();
      expect(ftFramesA).toHaveLength(5);
      handleCosmicWebAiResponse('legacy-ft-a', { requestId: ftFramesA[4].requestId, ok: true, result: storyResult });
      await expect(lateReq).resolves.toEqual(storyResult);
      // Advance past dispatch-based remote deadline for qa2 so no timers leak
      vi.advanceTimersByTime(75_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
