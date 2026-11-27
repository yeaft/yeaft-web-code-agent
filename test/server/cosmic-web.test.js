import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import express from 'express';
import supertest from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../server/db/cosmic-web-db.js';
import { safeFetch, validateExternalUrl } from '../../server/cosmic-web/safe-fetch.js';
import { parseFeedXml } from '../../server/cosmic-web/rss-parser.js';
import { extractCleanArticle } from '../../server/cosmic-web/article-extractor.js';
import { BUILTIN_DOMAINS, BUILTIN_SOURCES } from '../../server/cosmic-web/catalog.js';
import { fetchSource } from '../../server/cosmic-web/sources.js';
import { buildGraphProjection, canonicalizeUrl, clusterSimilarity, computeHeatScore, extractTokens } from '../../server/cosmic-web/clusterer.js';
import { createCosmicWebService, ingestCosmicWebItems, startCosmicWebScheduler, stopCosmicWebScheduler } from '../../server/cosmic-web/service.js';
import { clearAllCosmicWebAiRequests, clearCosmicWebAiRequestsForAgent, handleCosmicWebAiResponse,
  listCapableAgentsForUser, requestCosmicWebAi } from '../../server/cosmic-web/ai-bridge.js';
import { agents, webClients } from '../../server/context.js';
vi.mock('../../server/config.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, CONFIG: { ...actual.CONFIG, skipAuth: false } };
});
import { registerCosmicWebRoutes } from '../../server/routes/cosmic-web-routes.js';

vi.mock('../../server/database.js', () => ({
  userDb: { getByUsername: name => ['alice', 'bob'].includes(name) ? { id: name, role: 'user' } : undefined },
  sessionDb: {}, yeaftProjectDb: {}, yeaftSessionDb: {}, sessionUiMetadataDb: {},
}));

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
function makeService(options = {}) { return service = createCosmicWebService({ now: () => NOW, dnsLookup: dns, autoRefresh: () => false, ...options }); }
function agent(id, ownerId, caps = ['cosmic_web_briefing']) {
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
      publishedAt: NOW - 3 * HOUR, summaryExcerpt: '你好 & English 🚀' }]);
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://atom.example/">
      <entry><title>测试 &quot;English&quot;</title><link rel="self" href="internal"/><link rel="alternate" href="story"/>
      <updated>2026-11-27T20:00:00+08:00</updated><summary type="html">&lt;b&gt;概要&lt;/b&gt; &amp; news</summary></entry></feed>`;
    expect(parseFeedXml(atom, 'https://example.com')[0]).toEqual({ title: '测试 "English"', url: 'https://atom.example/story', publishedAt: NOW, summaryExcerpt: '概要 & news' });
    expect(parseFeedXml('<rdf:RDF><item><title>A</title><link>https://example.com/</link><dc:date>2026-11-27T12:00:00Z</dc:date></item></rdf:RDF>')[0].publishedAt).toBe(NOW);
    expect(parseFeedXml('<feed><entry><title>X</title><link href="javascript:alert(1)"/></entry></feed>')).toEqual([]);
  });
  it('normalizes fetched feed, signed CLS and embedded Baidu data', async () => {
    expect(BUILTIN_SOURCES).toHaveLength(23);
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
    const clusters = [...Array.from({ length: 90 }, (_, i) => ({ ...common, id: `${i}`, domainId: 'ai', heatScore: i + 3 })),
      { ...common, id: 'tech', domainId: 'tech', heatScore: 1 }, { ...common, id: 'hot', domainId: 'hot', heatScore: 100 }];
    const graph = buildGraphProjection({ prefs: { enabledDomainIds: ['ai', 'tech'] }, clusters, domains: BUILTIN_DOMAINS });
    expect(graph.hubs.map(h => h.domainId)).toEqual(['ai', 'tech']); expect(graph.nodes).toHaveLength(72);
    expect(graph.nodes[1].id).toBe('cluster:tech'); expect(graph.edges).toContainEqual(expect.objectContaining({ kind: 'cross', target: 'hub:tech' }));
  });
  it('refreshes private RSS only for its owner, isolates same-story state and disallows cross-scope writes', async () => {
    const mockFetch = vi.fn(async url => response(rss, url));
    const svc = makeService({ fetcher: mockFetch });
    await svc.savePreferences('alice', { enabledDomainIds: [], customDomains: [{ id: 'mine', name: 'Private', rssUrls: ['https://example.com/feed'] }] });
    await svc.savePreferences('bob', { enabledDomainIds: [], customDomains: [{ id: 'mine', name: 'Same id' }] });
    expect((await svc.refresh('alice')).added).toBe(1); expect((await svc.refresh('bob')).added).toBe(0);
    const id = svc.feed('alice').clusters[0].id;
    const itemId = svc.cluster('alice', id).items[0].id;
    expect(svc.feed('bob').total).toBe(0); expect(() => svc.cluster('bob', id)).toThrow('Cluster not found');
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
    expect(db.resolveCosmicWebDbPath({ TEST_DB_PATH: `${dir}/other.db` })).toBe(join(dir, 'cosmic-web.db'));
    expect(db.resolveCosmicWebDbPath({ COSMIC_WEB_DB_PATH: 'custom.db', SERVER_DATA_DIR: dir })).toBe('custom.db');
    expect(db.resolveCosmicWebDbPath({ SERVER_DATA_DIR: 'server-data', TEST_DB_DIR: 'test-data' })).toBe(join('server-data', 'cosmic-web.db'));
    expect(db.getCosmicWebDb().prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(db.getCosmicWebDb().prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    ingestCosmicWebItems(source(), [item('Bookmark'), item('Old item', 'https://example.com/stale')], NOW);
    ingestCosmicWebItems(source('private-old-feed', 'mine', 'alice'), [item('Private stale')], NOW);
    const id = db.listVisibleClusters('alice').find(c => c.headline === 'Bookmark').id;
    db.saveUserClusterState('alice', id, { bookmarked: true }, NOW);
    const itemId = db.listVisibleItems('alice', [id])[0].id;
    db.setArticleCache('alice', itemId, {}, NOW + 1); db.setAiCache('alice', 'old', {}, NOW + 1);
    expect(db.pruneCosmicWebDb(NOW + db.RETENTION_MS + 1)).toEqual({ items: 2, clusters: 2, articles: 1, ai: 1 });
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
  it('limits concurrency and rate, times out and clears on disconnect', async () => {
    vi.useFakeTimers(); const requests = agent('allowed', 'alice');
    const timeout = expect(ask()).rejects.toMatchObject({ status: 504 });
    const disconnect = expect(ask()).rejects.toMatchObject({ status: 504 });
    await expect(ask()).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(15_000); await timeout;
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
    expect(boot.body.domains).toHaveLength(6); expect(boot.body.agents.map(a => a.id)).toEqual(['alice-agent']);
    expect((await authed('get', `/feed?q=${encodeURIComponent('中国')}`).expect(200)).body.clusters[0].id).toBe(id);
    expect((await authed('get', '/graph').expect(200)).body.nodes[0].clusterId).toBe(id);
    await authed('put', '/preferences').send({ userId: 'bob', watchKeywords: ['模型'] }).expect(200);
    expect((await authed('get', '/preferences?userId=bob').expect(200)).body.watchKeywords).toEqual(['模型']);
    expect((await authed('get', '/preferences', 'bob').expect(200)).body.watchKeywords).toEqual([]);
    await authed('put', '/preferences').send({ customDomains: [{ name: 'Blocked', rssUrls: ['http://127.0.0.1/news'] }] }).expect(400);
    await authed('patch', `${cluster}/state`).send({ unread: false, bookmarked: true }).expect(200);
    expect((await authed('get', cluster, 'bob').expect(200)).body).toMatchObject({ unread: true, bookmarked: false });
    expect((await authed('post', '/mark-all-read', 'bob').expect(200)).body.updated).toBe(1);
    expect((await authed('get', `${cluster}/article`).expect(200)).body.quality).toBe('full');
    await authed('get', `${cluster}/article`).expect(200);
    await authed('get', `${cluster}/article?url=https%3A%2F%2Fother.example%2F`).expect(404);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const brief = () => authed('post', `${cluster}/ai-brief`).send({ perspective: 'engineering' }).expect(200);
    expect((await brief()).body.cached).toBe(false); expect((await brief()).body.cached).toBe(true);
    expect(calls).toHaveLength(1); expect(calls[0].payload.articleMarkdown).toContain('Important');
    expect((await authed('post', `${cluster}/ai-brief`, 'bob').send({ perspective: 'engineering' }).expect(200)).body.cached).toBe(false);
    await authed('post', '/daily-briefing').send({}).expect(200);
    expect(calls.at(-1).payload.domains[0].stories[0].headline).toBe('中国模型 Open Source');
    await authed('post', '/refresh').expect(200);
    await authed('post', '/refresh').expect(429);
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
    expect(a).toMatchObject({ added: 3, failed: 1 }); expect(b).toMatchObject({ added: 2, failed: 1 });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(messages.alice.some(m => m.domainId === 'private')).toBe(true);
    expect(messages.bob.every(m => m.domainId === 'ai')).toBe(true); expect(messages.charlie).toEqual([]);
  });
  it('serves the cached snapshot immediately and revalidates once per stale source', async () => {
    let time = NOW;
    let allowSWR = false;
    const fetcher = vi.fn(async url => response(rss, url));
    const svc = makeService({ fetcher, now: () => time, autoRefresh: () => allowSWR });
    await svc.savePreferences('alice', { enabledDomains: ['ai'], disabledSources: ['36kr-quick', 'hackernews'] });
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
    await vi.advanceTimersByTimeAsync(1); expect(vi.getTimerCount()).toBe(0);
  });
});
