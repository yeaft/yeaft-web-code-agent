import { afterEach, describe, expect, it, vi } from 'vitest';
import webFetch from '../../../../agent/yeaft/tools/web-fetch.js';
import webSearch from '../../../../agent/yeaft/tools/web-search.js';
import {
  createWebResearchState, findPriorSearch, recordSearch, setBounded,
  WEB_REQUEST_TIMEOUT_MS,
} from '../../../../agent/yeaft/web-research.js';
import { normalizePresentation, PRESENTATION_SCHEMA } from '../../../../agent/yeaft/response-presentation.js';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { ToolRegistry } from '../../../../agent/yeaft/tools/registry.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const text = (body, status = 200) => new Response(body, {
  status, headers: { 'content-type': 'text/plain' },
});
const context = (state = createWebResearchState()) => ({
  webResearch: state,
  config: { search: { searchApiUrl: 'https://search.test/query', disableHtmlFallback: true } },
});
const runSearch = async (query, ctx, input = {}) => JSON.parse(await webSearch.execute({ query, ...input }, ctx));
const runFetch = async (url, ctx, input = {}) => JSON.parse(await webFetch.execute({ url, ...input }, ctx));

// Fail closed if a test forgets to install a stub: no external network is used.
vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request'); }));
});

describe('query-local web evidence', () => {
  it('shares active evidence across Engine loops, not across user queries', async () => {
    const fetch = vi.fn(async () => text('verified content'));
    vi.stubGlobal('fetch', fetch);
    const registry = new ToolRegistry();
    registry.register(webFetch);
    const contexts = [];
    const originalExecute = registry.get('WebFetch').execute;
    registry.get('WebFetch').execute = (input, ctx) => {
      contexts.push(ctx);
      return originalExecute(input, ctx);
    };
    const responses = [];
    const call = id => ({ type: 'tool_call', id, name: 'WebFetch', input: { url: 'https://docs.test/engine' } });
    const batch = calls => [...calls, { type: 'stop', stopReason: 'tool_use' }];
    responses.push(batch([call('first'), call('concurrent')]), batch([call('later-loop')]), [
      { type: 'text_delta', text: 'Verified answer' }, { type: 'stop', stopReason: 'end_turn' },
    ], batch([call('next-query')]), [
      { type: 'text_delta', text: 'Fresh verification' }, { type: 'stop', stopReason: 'end_turn' },
    ]);
    const engine = new Engine({
      adapter: { async *stream() { yield* responses.shift(); } }, trace: new NullTrace(),
      config: { model: 'test-model', maxOutputTokens: 1024 }, toolRegistry: registry,
    });
    const first = [];
    for await (const event of engine.query({ prompt: 'Verify the official page' })) first.push(event);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.filter(event => event.type === 'tool_end' && !event.isError)).toHaveLength(3);
    expect(contexts[1].webResearch).toBe(contexts[0].webResearch);
    expect(contexts[2].webResearch).toBe(contexts[0].webResearch);
    expect(contexts[0].parentEngineDeps).not.toHaveProperty('webResearch');
    for await (const _event of engine.query({ prompt: 'Verify again in a fresh turn' })) { /* drain */ }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(contexts[3].webResearch).not.toBe(contexts[0].webResearch);
  });

  it('shares concurrent exact searches, reuses success with a smaller limit, and isolates queries', async () => {
    let release;
    const fetch = vi.fn(() => new Promise(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    const first = runSearch('  C++ site:docs.test -old "API Guide"  ', ctx);
    const concurrent = runSearch('C++ site:docs.test -old "API Guide"', ctx);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(json({ results: [{ title: 'A' }, { title: 'B' }] }));
    expect((await first).results).toHaveLength(2);
    expect((await concurrent).results).toHaveLength(2);
    expect(ctx.webResearch.inFlight.size).toBe(0);
    const reuse = await runSearch('C++ site:docs.test -old "API Guide"', ctx, { limit: 1 });
    expect(reuse).toMatchObject({ reused: true, results: [{ title: 'A' }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(json({ results: [] }));
    await runSearch('C++ site:docs.test -old "API Guide"', context());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(webSearch.cacheWithinQuery).toBe(false);
  });

  it('never conflates punctuation, case, operators, quoted whitespace, or near matches', async () => {
    const fetch = vi.fn(async url => json({ results: [{ title: new URL(url).searchParams.get('q') }] }));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    const queries = ['C++', 'C', 'c', 'site:docs.test API', 'site docs.test API', 'API -old', 'API old', '"API Guide"', 'API Guide', '"API  Guide"', 'a very specific station exit A', 'a very specific station exit B'];
    for (const query of queries) {
      const result = await runSearch(query, ctx);
      expect(result.reused).toBeUndefined();
      expect(result.results[0].title).toBe(query);
    }
    expect(fetch).toHaveBeenCalledTimes(queries.length);
    expect((await runSearch('a very specific station exit C', ctx)).relatedPriorQuery).toBe('a very specific station exit B');
  });

  it('requests a larger search limit afresh and accepts authoritative empty results', async () => {
    const fetch = vi.fn(async () => json({ results: [] }));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    expect(await runSearch('no matches', ctx, { limit: 1 })).toMatchObject({ results: [] });
    await runSearch('no matches', ctx, { limit: 5 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await runSearch('no matches', ctx, { limit: 5 })).reused).toBe(true);
  });

  it('retries shared transient search errors rather than freezing them in either cache', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(text('unavailable', 503)).mockResolvedValueOnce(json({ results: [] }));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    const [failed, alsoFailed] = await Promise.all([runSearch('retry', ctx), runSearch('retry', ctx)]);
    expect(failed).toMatchObject({ code: 'search_unavailable', status: 503, errorEffect: 'none', failures: [{ provider: 'generic', code: 'http_error', status: 503 }] });
    expect(alsoFailed).toEqual(failed);
    expect(failed.hint).toContain('official URL');
    expect(ctx.webResearch.searches).toHaveLength(0);
    expect((await runSearch('retry', ctx)).results).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reuses canonical fetch successes only for the same mode and budget; polling stays live', async () => {
    const fetch = vi.fn(async () => text('fresh data'));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    await Promise.all([runFetch('https://docs.test/page#a', ctx), runFetch('https://docs.test/page#b', ctx)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await runFetch('https://docs.test/page', ctx)).reused).toBe(true);
    await runFetch('https://docs.test/page', ctx, { max_length: 4 });
    await runFetch('https://docs.test/page', ctx, { raw: true });
    await runFetch('https://docs.test/page', ctx, { polling: true });
    await runFetch('https://docs.test/page', ctx, { polling: true });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(webFetch.cacheWithinQuery).toBe(false);
    expect(webFetch.duplicateCallPolicy({})).toBe('warn');
    expect(webFetch.duplicateCallPolicy({ polling: true })).toBe('allow');
  });

  it('preserves 403/404/503 failures, does not block the host, and retries the same URL', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(text('forbidden', 403))
      .mockResolvedValueOnce(text('public page'))
      .mockResolvedValueOnce(text('missing', 404))
      .mockResolvedValueOnce(text('temporary', 503))
      .mockResolvedValueOnce(text('recovered'));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    const forbidden = await runFetch('https://docs.test/private', ctx);
    expect(forbidden).toMatchObject({ error: 'HTTP 403: ', code: 'http_error', status: 403, errorEffect: 'none' });
    expect(forbidden.hint).toContain('Other URLs');
    expect(await runFetch('https://docs.test/public', ctx)).toMatchObject({ status: 200, content: 'public page' });
    const missing = await runFetch('https://docs.test/private', ctx);
    expect(missing).toMatchObject({ code: 'http_error', status: 404, priorAuthorizationFailure: { status: 403 } });
    expect(missing.hint).toContain('official site index');
    expect(await runFetch('https://docs.test/private', ctx)).toMatchObject({ code: 'http_error', status: 503 });
    expect(await runFetch('https://docs.test/private', ctx)).toMatchObject({ status: 200, content: 'recovered' });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(ctx.webResearch.authorizationFailures.size).toBe(0);
  });

  it('bounds ledger memory and gives advisory guidance without blocking further research', async () => {
    const state = createWebResearchState();
    for (let i = 0; i < 80; i += 1) {
      recordSearch(state, `query ${i}`, 5, '{"results":[]}');
      setBounded(state.fetches, `url ${i}`, '{}');
      setBounded(state.authorizationFailures, `private ${i}`, { status: 403 });
    }
    expect(state.searches).toHaveLength(64);
    expect(state.fetches.size).toBe(64);
    expect(state.authorizationFailures.size).toBe(64);
    expect(findPriorSearch(state, 'query 0')).toBeNull();
    const fetch = vi.fn(async () => text('verified body'));
    vi.stubGlobal('fetch', fetch);
    const ctx = context(state);
    for (let i = 0; i < 5; i += 1) {
      const result = await runFetch(`https://docs.test/${i}`, ctx);
      expect(Boolean(result.researchGuidance)).toBe(i >= 3);
      expect(result.error).toBeUndefined();
      if (result.researchGuidance) expect(result.researchGuidance.length).toBeLessThan(400);
    }
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe('web backend failure boundaries', () => {
  it('accepts explicit HTML no-results but does not call bot challenges or unknown markup zero matches', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(text('<div class="no-results">No results found for this query</div>'))
      .mockResolvedValueOnce(text('<form id="challenge-form" action="anomaly.js">human check</form>'))
      .mockResolvedValueOnce(text('<li class="b_no">There are no results for this query</li>'))
      .mockResolvedValueOnce(text('<html><div>unrecognized page</div></html>'))
      .mockResolvedValueOnce(text('Forbidden', 403));
    vi.stubGlobal('fetch', fetch);
    expect(await runSearch('absent', {})).toMatchObject({ provider: 'duckduckgo-html', results: [] });
    expect(await runSearch('other absent', {})).toMatchObject({ provider: 'bing-html', results: [] });
    const unknown = await runSearch('unknown', {});
    expect(unknown).toMatchObject({ code: 'search_unavailable', status: 403, failures: [{ code: 'unrecognized_response', status: 200 }, { code: 'http_error', status: 403 }] });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('reports bot blocking and malformed JSON as failures, then permits a later retry', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(text('<form id="challenge-form">captcha</form>'))
      .mockResolvedValueOnce(text('<title>Access denied</title>'))
      .mockResolvedValueOnce(json({ error: 'bad endpoint' }))
      .mockResolvedValueOnce(text('{bad json'))
      .mockResolvedValueOnce(json({ results: [] }));
    vi.stubGlobal('fetch', fetch);
    const html = await runSearch('blocked', {});
    expect(html.failures.map(item => item.code)).toEqual(['bot_blocked', 'bot_blocked']);
    const ctx = context();
    expect((await runSearch('retry malformed', ctx)).failures[0].code).toBe('invalid_response');
    expect((await runSearch('retry malformed', ctx)).failures[0].code).toBe('invalid_response');
    expect((await runSearch('retry malformed', ctx)).results).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('cancellation during Tavily stops generic and HTML fallback and permits a later same-query retry', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementationOnce(async (_url, options) => {
      expect(options.signal).not.toBe(controller.signal);
      controller.abort(new Error('caller cancelled'));
      return new Promise(() => {}); // Also bounds a non-cooperative backend.
    }).mockResolvedValue(json({ results: [] }));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    ctx.config.search = { ...ctx.config.search, tavilyApiKey: 'stub-only', disableHtmlFallback: false };
    const cancelled = await runSearch('cancel and retry', { ...ctx, signal: controller.signal });
    expect(cancelled).toMatchObject({ code: 'cancelled', errorEffect: 'none' });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(ctx.webResearch.inFlight.size).toBe(0));
    expect((await runSearch('cancel and retry', ctx)).provider).toBe('tavily');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('cancellation in DDG does not start Bing, and pre-cancelled calls never use cache or network', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); });
    vi.stubGlobal('fetch', fetch);
    expect(await runSearch('cancel html', { signal: controller.signal })).toMatchObject({ code: 'cancelled' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const ctx = context();
    recordSearch(ctx.webResearch, 'cached', 5, '{"results":[]}');
    expect(await runSearch('cached', { ...ctx, signal: controller.signal })).toMatchObject({ code: 'cancelled' });
    expect(await runFetch('https://docs.test/cached', { ...ctx, signal: controller.signal })).toMatchObject({ code: 'cancelled' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a cancelled shared waiter stops promptly without cancelling the original fetch', async () => {
    let release;
    const fetch = vi.fn(() => new Promise(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    const first = runFetch('https://docs.test/shared', ctx);
    const controller = new AbortController();
    const second = runFetch('https://docs.test/shared', { ...ctx, signal: controller.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await second).toMatchObject({ code: 'cancelled', errorEffect: 'none' });
    release(text('completed'));
    expect(await first).toMatchObject({ status: 200, content: 'completed' });
    expect((await runFetch('https://docs.test/shared', ctx)).reused).toBe(true);
  });

  it('a cancelled fetch owner is not cached or shared with a later retry', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementationOnce(async () => {
      controller.abort(new Error('caller cancelled'));
      return new Promise(() => {});
    }).mockResolvedValueOnce(text('retried successfully'));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    expect(await runFetch('https://docs.test/cancel', { ...ctx, signal: controller.signal })).toMatchObject({ code: 'cancelled', errorEffect: 'none' });
    expect(ctx.webResearch.fetches.size).toBe(0);
    expect(await runFetch('https://docs.test/cancel', ctx)).toMatchObject({ status: 200, content: 'retried successfully' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deadline bounds search fetch and response body, continuing only non-cancelled fallback', async () => {
    vi.useFakeTimers();
    const signals = [];
    const fetch = vi.fn()
      .mockImplementationOnce((_url, options) => { signals.push(options.signal); return new Promise(() => {}); })
      .mockImplementationOnce(async (_url, options) => {
        signals.push(options.signal);
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      })
      .mockResolvedValueOnce(text('<a class="result__a" href="https://official.test/">Official</a>'));
    vi.stubGlobal('fetch', fetch);
    const pending = runSearch('deadlines', { config: { search: { tavilyApiKey: 'stub', searchApiUrl: 'https://search.test/' } } });
    await vi.advanceTimersByTimeAsync(WEB_REQUEST_TIMEOUT_MS * 2 + 1);
    expect(await pending).toMatchObject({ provider: 'duckduckgo-html', results: [{ title: 'Official' }] });
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('fetch body deadline is a retryable timeout, not a cached partial success', async () => {
    vi.useFakeTimers();
    let signal;
    const fetch = vi.fn().mockImplementationOnce(async (_url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) };
    }).mockResolvedValueOnce(text('recovered'));
    vi.stubGlobal('fetch', fetch);
    const ctx = context();
    const pending = runFetch('https://docs.test/slow', ctx);
    await vi.advanceTimersByTimeAsync(WEB_REQUEST_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ code: 'timeout', errorEffect: 'none' });
    expect(signal.aborted).toBe(true);
    expect(ctx.webResearch.fetches.size).toBe(0);
    expect(await runFetch('https://docs.test/slow', ctx)).toMatchObject({ status: 200, content: 'recovered' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('provider-specific map schema', () => {
  const presentation = embed => ({ summary: 'Verified location', blocks: [{ type: 'map', points: [{ label: 'Point', latitude: 39.9, longitude: 116.4 }], embed }] });
  it('makes OSM URL optional/runtime-generated while Google requires an official pb-only URL', () => {
    const mapSchema = PRESENTATION_SCHEMA.properties.blocks.items.anyOf.find(item => item.properties.type.enum[0] === 'map');
    expect(mapSchema.properties.embed.anyOf.map(item => item.required)).toEqual([['provider'], ['provider', 'url']]);
    expect(normalizePresentation(presentation({ provider: 'openstreetmap' })).blocks[0].embed).toEqual({ provider: 'openstreetmap' });
    const url = 'https://www.google.com/maps/embed?pb=!1m1!1d1';
    expect(normalizePresentation(presentation({ provider: 'google', url })).blocks[0].embed).toEqual({ provider: 'google', url });
    expect(() => normalizePresentation(presentation({ provider: 'google' }))).toThrow(/url.*required/);
    expect(() => normalizePresentation(presentation({ provider: 'google', url: 'https://www.google.com/maps/embed?key=secret' }))).toThrow(/official/);
    expect(() => normalizePresentation(presentation({ provider: 'google', url: 'https://www.google.com/' }))).toThrow(/official/);
  });

  it('accepts valid legacy OSM URLs as provider-only but rejects arbitrary/credential-bearing embeds', () => {
    const url = 'https://www.openstreetmap.org/export/embed.html?bbox=116,39,117,40&layer=mapnik&marker=39.9,116.4';
    expect(normalizePresentation(presentation({ provider: 'openstreetmap', url })).blocks[0].embed).toEqual({ provider: 'openstreetmap' });
    for (const invalid of ['https://www.openstreetmap.org/', url.replace('www.openstreetmap.org', 'evil.test'), url + '&url=https://evil.test', url.replace('https://', 'https://user:password@'), url.replace('116,39,117,40', 'bad')]) {
      expect(() => normalizePresentation(presentation({ provider: 'openstreetmap', url: invalid }))).toThrow();
    }
  });
});
