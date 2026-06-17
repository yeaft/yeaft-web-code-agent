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

export default defineTool({
  name: 'WebSearch',
  description: {
    en: `Search the web for current information.

Use this when you need up-to-date information that may not be in your training data.
Returns search results with titles, URLs, and snippets.

Guidelines:
- Use specific, targeted search queries
- Include the current year for time-sensitive queries
- Combine with WebFetch to read full page content from results`,
    zh: `搜索网页获取最新信息。

当你需要训练数据中可能没有的最新信息时使用。返回搜索结果，含标题、URL 和摘要。

使用指南：
- 使用具体、有针对性的搜索关键词
- 时间敏感的查询要包含当前年份
- 配合 WebFetch 读取搜索结果中的完整页面内容`
  },
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 5)',
      },
    },
    required: ['query'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { query, limit = 5 } = input;
    if (!query || typeof query !== 'string') {
      return JSON.stringify({ error: 'query is required' });
    }

    const search = ctx?.config?.search || {};
    const signal = ctx?.signal;
    const errors = [];

    // Backend preference set in YeaftSettings → Search tab. When the
    // user picks `playwright` we'd normally call the playwright-service;
    // that service is not yet shipped (next PR), so the preference is
    // recorded for forward-compat and we transparently fall through to
    // Tavily / HTML scrape. Once the service lands we'll insert a
    // tryPlaywright backend here ahead of Tavily.
    // Anything other than 'playwright' is treated as 'tavily'.

    // 1. Tavily — default, fast, structured.
    if (search.tavilyApiKey) {
      const r = await tryTavily(query, limit, search.tavilyApiKey, signal);
      if (r.ok) return JSON.stringify(r.data, null, 2);
      errors.push(`tavily: ${r.error}`);
    }

    // 2. Generic JSON endpoint (legacy escape hatch — SearXNG, custom proxy, etc).
    const genericUrl = search.searchApiUrl || ctx?.config?.searchApiUrl;
    if (genericUrl) {
      const r = await tryGenericApi(query, limit, genericUrl, signal);
      if (r.ok) return JSON.stringify(r.data, null, 2);
      errors.push(`searchApiUrl: ${r.error}`);
    }

    // 3. HTML-scrape fallback. Often blocked on cloud IPs; useful for
    //    self-hosted / residential setups with no API key.
    if (!search.disableHtmlFallback) {
      const r = await tryHtmlScrape(query, limit, signal);
      if (r.ok) return JSON.stringify(r.data, null, 2);
      errors.push(`html: ${r.error}`);
    }

    return JSON.stringify({
      error: 'No web search backend succeeded.',
      attempted: errors,
      hint: 'Set search.tavilyApiKey in ~/.yeaft/config.json (free tier: https://tavily.com).',
    });
  },
});

// ─── Backend implementations ────────────────────────────────────────

async function tryTavily(query, limit, apiKey, signal) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.max(1, Math.min(limit, 10)),
        include_answer: true,
        search_depth: 'basic',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `${res.status} ${res.statusText} ${text.slice(0, 200)}` };
    }
    const data = await res.json();
    return {
      ok: true,
      data: {
        provider: 'tavily',
        query,
        answer: data.answer || null,
        results: (data.results || []).slice(0, limit).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content,
          score: r.score,
        })),
      },
    };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'cancelled' };
    return { ok: false, error: err.message || String(err) };
  }
}

async function tryGenericApi(query, limit, urlStr, signal) {
  try {
    const url = new URL(urlStr);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url.toString(), {
      signal,
      headers: { 'User-Agent': 'Yeaft/1.0', Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` };
    const data = await res.json();
    return { ok: true, data: { provider: 'generic', query, ...data } };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'cancelled' };
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * HTML-scrape fallback. Tries DuckDuckGo's lite HTML endpoint first
 * (smaller markup, but more aggressive bot detection on cloud IPs),
 * then Bing. We intentionally keep the regex-based parsers minimal —
 * they break less than full DOM selectors when sites tweak markup.
 */
async function tryHtmlScrape(query, limit, signal) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const headers = { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9' };

  try {
    const ddg = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal, headers });
    if (ddg.ok) {
      const html = await ddg.text();
      const results = parseDdgHtml(html, limit);
      if (results.length) return { ok: true, data: { provider: 'duckduckgo-html', query, results } };
    }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'cancelled' };
  }

  try {
    const bing = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, { signal, headers });
    if (bing.ok) {
      const html = await bing.text();
      const results = parseBingHtml(html, limit);
      if (results.length) return { ok: true, data: { provider: 'bing-html', query, results } };
    }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, error: 'cancelled' };
  }

  return { ok: false, error: 'all HTML scrape backends returned 0 results (likely bot-blocked)' };
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
