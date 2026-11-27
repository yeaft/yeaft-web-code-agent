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

const MAX_SEARCH_RESPONSE_BYTES = 512 * 1024;

async function readBoundedText(res, signal, maxBytes = MAX_SEARCH_RESPONSE_BYTES) {
  const len = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(len) && len > maxBytes) {
    void res.body?.cancel?.().catch(() => {});
    throw new Error('Search response exceeded byte limit');
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let out = '';
    try {
      while (true) {
        signal?.throwIfAborted?.();
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          throw new Error('Search response exceeded byte limit');
        }
        if (value.byteLength > remaining) {
          out += decoder.decode(value.subarray(0, remaining), { stream: false });
          throw new Error('Search response exceeded byte limit');
        }
        total += value.byteLength;
        out += decoder.decode(value, { stream: true });
      }
      return out + decoder.decode();
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  // Fallback for test stubs returning mock Response without ReadableStream body.
  const text = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error('Search response exceeded byte limit');
  }
  return text;
}

async function readBoundedJson(res, signal, maxBytes = MAX_SEARCH_RESPONSE_BYTES) {
  if (!res.body && typeof res.text !== 'function' && typeof res.json === 'function') {
    const data = await res.json();
    if (Buffer.byteLength(JSON.stringify(data ?? null), 'utf8') > maxBytes) {
      throw new Error('Search response exceeded byte limit');
    }
    return data;
  }
  const text = await readBoundedText(res, signal, maxBytes);
  return JSON.parse(text);
}

async function tryTavily(query, limit, apiKey, signal) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: Math.min(limit, 10), include_answer: true, search_depth: 'basic' }),
  });
  if (!res.ok) return webHttpFailure(res.status);
  const data = await readBoundedJson(res, signal);
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
  if (!res.ok) return webHttpFailure(res.status);
  const data = await readBoundedJson(res, signal);
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
  if (!res.ok) return webHttpFailure(res.status);
  const html = (await readBoundedText(res, signal, 256 * 1024)).slice(0, 256 * 1024);
  const lower = html.toLowerCase();
  const titleStart = lower.indexOf('<title');
  let titleSlice = '';
  if (titleStart !== -1) {
    const gt = html.indexOf('>', titleStart);
    const end = gt === -1 ? -1 : lower.indexOf('</title', gt + 1);
    if (gt !== -1) titleSlice = lower.slice(gt + 1, end === -1 ? Math.min(html.length, gt + 200) : Math.min(end, gt + 200));
  }
  const blocked = lower.includes('anomaly.js')
    || lower.includes('anomaly-modal')
    || lower.includes('challenge-form')
    || lower.includes('unusual traffic')
    || lower.includes('verify you are human')
    || lower.includes("verify that you're a human")
    || lower.includes('verify that you are a human')
    || titleSlice.includes('captcha')
    || titleSlice.includes('access denied');
  const results = ddg ? parseDdgHtml(html, limit) : parseBingHtml(html, limit);
  const noMatches = ddg
    ? (lower.includes('no-results') || lower.includes('no results found for'))
    : (lower.includes('b_no') || lower.includes('there are no results for') || lower.includes('no results found for'));
  if (!blocked && (results.length || noMatches)) return { provider, query, results };
  return {
    error: blocked ? 'HTML search returned a bot challenge' : 'HTML search markup was not recognized; zero matches are not confirmed',
    code: blocked ? 'bot_blocked' : 'unrecognized_response', status: res.status, errorEffect: 'none',
    hint: 'Use a known official URL or another available source. Retrying a rephrased query will not fix a bot challenge or parser mismatch.',
  };
}

/** Linear O(N) attribute extraction for a single opening tag slice (no backtracking). */
function extractAttrValue(tagSlice, attrName) {
  const lower = tagSlice.toLowerCase();
  const needle = `${attrName.toLowerCase()}=`;
  let idx = 0;
  while (idx < lower.length) {
    const found = lower.indexOf(needle, idx);
    if (found === -1) return '';
    if (found > 0 && !/[\s<]/.test(lower[found - 1])) {
      idx = found + needle.length;
      continue;
    }
    let valStart = found + needle.length;
    if (valStart >= tagSlice.length) return '';
    const q = tagSlice[valStart];
    if (q === '"' || q === "'") {
      valStart++;
      const end = tagSlice.indexOf(q, valStart);
      return end === -1 ? '' : tagSlice.slice(valStart, end);
    }
    let end = valStart;
    while (end < tagSlice.length && !/[\s>]/.test(tagSlice[end])) end++;
    return tagSlice.slice(valStart, end);
  }
  return '';
}

/** Linear O(N) scan of DDG lite HTML (<a class="result__a"> and <a class="result__snippet">). */
function parseDdgHtml(html, limit) {
  const results = [];
  const lower = html.toLowerCase();
  const links = [];
  const snippets = [];
  let pos = 0;
  while (pos < html.length && (links.length < limit * 2 || snippets.length < limit * 2)) {
    const lt = lower.indexOf('<a', pos);
    if (lt === -1) break;
    const nextChar = lower[lt + 2];
    if (nextChar && !/[\s>]/.test(nextChar)) {
      pos = lt + 2;
      continue;
    }
    const gt = html.indexOf('>', lt + 2);
    if (gt === -1) break;
    const openTag = html.slice(lt, gt + 1);
    const close = lower.indexOf('</a>', gt + 1);
    if (close === -1) break;
    const inner = html.slice(gt + 1, close);
    const cls = extractAttrValue(openTag, 'class');
    if (cls === 'result__a' || /\bresult__a\b/.test(cls)) {
      const href = extractAttrValue(openTag, 'href');
      if (href) links.push([href, inner]);
    } else if (cls === 'result__snippet' || /\bresult__snippet\b/.test(cls)) {
      snippets.push(inner);
    }
    pos = close + 4;
  }
  for (let i = 0; i < links.length && results.length < limit; i++) {
    const url = decodeDdgUrl(links[i][0]);
    const title = stripTags(links[i][1]).trim();
    const snippet = snippets[i] ? stripTags(snippets[i]).trim() : '';
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

/** Strictly linear O(N) scan of Bing <li class="...b_algo..."> result blocks (no backtracking or suffix rescans). */
function parseBingHtml(html, limit) {
  const results = [];
  const lower = html.toLowerCase();
  let pos = 0;
  let nextCloseLi = lower.indexOf('</li>');
  while (pos < html.length && results.length < limit) {
    const li = lower.indexOf('<li', pos);
    if (li === -1) break;
    const nextChar = lower[li + 3];
    if (nextChar && !/[\s>]/.test(nextChar)) {
      pos = li + 3;
      continue;
    }
    const gt = html.indexOf('>', li + 3);
    if (gt === -1) break;
    const openTag = html.slice(li, gt + 1);
    const cls = extractAttrValue(openTag, 'class');
    if (!/\bb_algo\b/.test(cls)) {
      pos = gt + 1;
      continue;
    }
    while (nextCloseLi !== -1 && nextCloseLi < gt + 1) {
      nextCloseLi = lower.indexOf('</li>', nextCloseLi + 5);
    }
    const blockEnd = nextCloseLi === -1 ? Math.min(html.length, gt + 8192) : Math.min(nextCloseLi, gt + 16384);
    const block = html.slice(gt + 1, blockEnd);
    const blockLower = lower.slice(gt + 1, blockEnd);
    pos = nextCloseLi === -1 ? blockEnd : Math.max(blockEnd, nextCloseLi + 5);

    const h2 = blockLower.indexOf('<h2');
    if (h2 === -1) continue;
    const aStart = blockLower.indexOf('<a', h2);
    if (aStart === -1) continue;
    const aGt = block.indexOf('>', aStart);
    const aClose = aGt === -1 ? -1 : blockLower.indexOf('</a>', aGt + 1);
    if (aGt === -1 || aClose === -1) continue;
    const url = extractAttrValue(block.slice(aStart, aGt + 1), 'href');
    const title = stripTags(block.slice(aGt + 1, aClose)).trim();
    let snippet = '';
    const pStart = blockLower.indexOf('<p', aClose);
    if (pStart !== -1) {
      const pGt = block.indexOf('>', pStart);
      const pClose = pGt === -1 ? -1 : blockLower.indexOf('</p>', pGt + 1);
      if (pGt !== -1 && pClose !== -1) snippet = stripTags(block.slice(pGt + 1, pClose)).trim();
    }
    if (url && title) results.push({ title, url, snippet });
  }
  return results;
}

function stripTags(s) {
  let out = '';
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<') inTag = true;
    else if (ch === '>') inTag = false;
    else if (!inTag) out += ch;
  }
  return out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
