/**
 * web-search.js — Web search tool.
 *
 * Strategy (in order):
 *   1. Tavily API (default; configured via ~/.yeaft/config.json → search.tavilyApiKey)
 *   2. Generic searchApiUrl (legacy; user-supplied JSON-returning endpoint)
 *   3. HTML-scrape fallback: DuckDuckGo lite then Bing
 *      (works on residential IPs; cloud IPs are usually flagged as bots)
 *
 * Config shape in ~/.yeaft/config.json:
 *   {
 *     "search": {
 *       "tavilyApiKey": "tvly-...",
 *       "searchApiUrl": "https://...",   // optional, alternative JSON endpoint
 *       "disableHtmlFallback": false      // optional, opt-out of scraping
 *     }
 *   }
 *
 * The result is JSON-stringified so the LLM can parse it. We intentionally
 * keep the output shape consistent across providers: { provider, query,
 * answer?, results: [{title, url, snippet}] }.
 */

import { defineTool } from './types.js';
import {
  attachResearchGuidance, findPriorSearch, findRelatedSearch, normalizeSearchQuery,
  recordSearch, recordWebResearchCall, shareWebRequest, webHttpFailure,
  webRequestFailure, withWebDeadline,
} from '../web-research.js';

export default defineTool({
  name: 'WebSearch',
  description: {
    en: `Search the web for current information.

Use this when you need up-to-date information that may not be in your training data.
Returns search results with titles, URLs, and snippets.

Guidelines:
- Use one specific, targeted query with the smallest useful result limit; inspect it before trying alternatives
- Include the current year for time-sensitive queries
- Fetch the most authoritative relevant result first. Add another source only when the claim is consequential, disputed, stale, or not established by the first source`,
    zh: `搜索网页获取最新信息。

当你需要训练数据中可能没有的最新信息时使用。返回搜索结果，含标题、URL 和摘要。

使用指南：
- 先执行一个具体、定向的查询，并使用满足需要的最小结果数；检查结果后再决定是否尝试其他查询
- 时间敏感的查询要包含当前年份
- 优先抓取最权威、最相关的结果。只有结论影响重大、存在争议、可能过时，或首个来源不能证明时才增加来源`
  },
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: {
          en: 'The search query',
          zh: '搜索查询词',
        },
      },
      limit: {
        type: 'number',
        description: {
          en: 'Maximum number of results (default: 5)',
          zh: '最多返回结果数（默认 5）',
        },
      },
    },
    required: ['query'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  // The ledger caches successes only; Engine's general cache would freeze errors.
  async execute(input, ctx) {
    const query = normalizeSearchQuery(input.query);
    const limit = input.limit ?? 5;
    if (typeof input.query !== 'string' || !query || !Number.isInteger(limit) || limit < 1) {
      return JSON.stringify({ error: 'query must be non-empty text and limit a positive integer', code: 'invalid_arguments', errorEffect: 'none', hint: 'Supply a targeted query and a positive integer result limit.' });
    }

    const research = ctx?.webResearch;
    const signal = ctx?.signal;
    try {
      signal?.throwIfAborted();
      const prior = findPriorSearch(research, query, limit);
      if (prior) {
        const data = JSON.parse(prior.output);
        return attachResearchGuidance({ ...data, results: data.results.slice(0, limit) }, research, {
          reused: true, priorQuery: prior.query,
          reuseReason: 'This exact trimmed query already succeeded with at least the requested limit in this query.',
        });
      }
      const related = findRelatedSearch(research, query);
      const output = await shareWebRequest(research, JSON.stringify(['search', query, limit]), signal, async () => {
        const result = await searchWeb(query, limit, ctx);
        recordWebResearchCall(research);
        const output = JSON.stringify(result);
        if (!result.error) recordSearch(research, query, limit, output);
        return output;
      });
      return attachResearchGuidance(output, research, related ? {
        relatedPriorQuery: related.query,
        convergenceHint: 'A similar query already completed. Use this result for the specific unresolved fact; semantic variants are not interchangeable.',
      } : {});
    } catch (error) {
      return attachResearchGuidance(webRequestFailure(error, signal), research);
    }
  },
});

async function searchWeb(query, limit, ctx) {
  const search = ctx?.config?.search || {};
  const signal = ctx?.signal;
  const failures = [];
  const backends = [];
  if (search.tavilyApiKey) backends.push(['tavily', bounded => tryTavily(query, limit, search.tavilyApiKey, bounded)]);
  const genericUrl = search.searchApiUrl || ctx?.config?.searchApiUrl;
  if (genericUrl) backends.push(['generic', bounded => tryGenericApi(query, limit, genericUrl, bounded)]);
  if (!search.disableHtmlFallback) {
    backends.push(['duckduckgo-html', bounded => tryHtmlScrape(query, limit, 'duckduckgo-html', bounded)]);
    backends.push(['bing-html', bounded => tryHtmlScrape(query, limit, 'bing-html', bounded)]);
  }
  for (const [provider, work] of backends) {
    signal?.throwIfAborted();
    try {
      const result = await withWebDeadline(signal, work);
      signal?.throwIfAborted();
      if (!result.error) return result;
      failures.push({ provider, ...result });
    } catch (error) {
      const failure = webRequestFailure(error, signal);
      // Cancellation is terminal: never start the next backend.
      if (failure.code === 'cancelled') return { ...failure, query, failures };
      failures.push({ provider, ...failure });
    }
  }
  const last = failures.at(-1);
  return {
    error: 'No web search backend succeeded.', code: 'search_unavailable', errorEffect: 'none', query,
    ...(last?.status ? { status: last.status } : {}),
    attempted: failures.map(failure => `${failure.provider}: ${failure.error}`), failures,
    hint: 'Inspect backend failures: HTML search may be bot-blocked or its markup may have changed. Use a known official URL with WebFetch or another available source; verify an already configured search endpoint if applicable. Rephrasing alone will not fix access failures.',
  };
}

// ─── Backend implementations ────────────────────────────────────────

async function tryTavily(query, limit, apiKey, signal) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: Math.min(limit, 10), include_answer: true, search_depth: 'basic' }),
  });
  if (!res.ok) return webHttpFailure(res.status, res.statusText);
  const data = await res.json();
  if (!Array.isArray(data?.results) || data.error) return invalidSearchResponse();
  return {
    provider: 'tavily', query, answer: data.answer || null,
    results: data.results.slice(0, limit).map(r => ({ title: r.title, url: r.url, snippet: r.content, score: r.score })),
  };
}

async function tryGenericApi(query, limit, urlStr, signal) {
  const url = new URL(urlStr);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url.toString(), { signal, headers: { 'User-Agent': 'Yeaft/1.0', Accept: 'application/json' } });
  if (!res.ok) return webHttpFailure(res.status, res.statusText);
  const data = await res.json();
  if (!Array.isArray(data?.results) || data.error) return invalidSearchResponse();
  return { ...data, provider: 'generic', query, results: data.results.slice(0, limit) };
}

function invalidSearchResponse() {
  return { error: 'Search endpoint did not return a results array', code: 'invalid_response', errorEffect: 'none', hint: 'Verify the configured endpoint returns a JSON object with results: [], including for no matches.' };
}

/** Zero matches need an explicit no-results marker, not an empty parser output. */
async function tryHtmlScrape(query, limit, provider, signal) {
  const ddg = provider === 'duckduckgo-html';
  const endpoint = ddg ? 'https://html.duckduckgo.com/html/?q=' : 'https://www.bing.com/search?q=';
  const res = await fetch(endpoint + encodeURIComponent(query), {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) return webHttpFailure(res.status, res.statusText);
  const html = await res.text();
  const blocked = /anomaly\.js|anomaly-modal|challenge-form|verify (?:that )?you(?:'re| are) (?:a )?human|unusual traffic|<title[^>]*>[^<]*(?:captcha|access denied)/i.test(html);
  const results = ddg ? parseDdgHtml(html, limit) : parseBingHtml(html, limit);
  const noMatches = ddg ? /class=["'][^"']*\bno-results\b|No results found for/i.test(html)
    : /class=["'][^"']*\bb_no\b|There are no results for|No results found for/i.test(html);
  if (!blocked && (results.length || noMatches)) return { provider, query, results };
  return {
    error: blocked ? 'HTML search returned a bot challenge' : 'HTML search markup was not recognized; zero matches are not confirmed',
    code: blocked ? 'bot_blocked' : 'unrecognized_response', status: res.status, errorEffect: 'none',
    hint: 'Use a known official URL or another available source. Retrying a rephrased query will not fix a bot challenge or parser mismatch.',
  };
}

/**
 * Parse DDG lite HTML. Each result is wrapped in
 *   <a class="result__a" href="…">title</a>
 *   <a class="result__snippet">snippet</a>
 * Hash classes are not used here, so plain regex is fine.
 */
function parseDdgHtml(html, limit) {
  const results = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < links.length && results.length < limit; i++) {
    const url = decodeDdgUrl(links[i][1]);
    const title = stripTags(links[i][2]).trim();
    const snippet = snippets[i] ? stripTags(snippets[i][1]).trim() : '';
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

/**
 * DDG often wraps outbound URLs in `/l/?uddg=…` redirects. Unwrap.
 */
function decodeDdgUrl(href) {
  try {
    if (href.startsWith('//')) href = 'https:' + href;
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return href;
  }
}

/**
 * Parse Bing search HTML. Result blocks: <li class="b_algo"> with
 * <h2><a href="…">title</a></h2> and <p>snippet</p>. The class names
 * have been stable for years; if Bing rotates them this will fail
 * gracefully (no results extracted) and we'll surface the error upstream.
 */
function parseBingHtml(html, limit) {
  const results = [];
  const blockRe = /<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  for (const m of html.matchAll(blockRe)) {
    if (results.length >= limit) break;
    const block = m[1];
    const linkM = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    const url = linkM[1];
    const title = stripTags(linkM[2]).trim();
    const pM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = pM ? stripTags(pM[1]).trim() : '';
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
