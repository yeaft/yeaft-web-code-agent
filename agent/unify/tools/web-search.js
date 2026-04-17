/**
 * web-search.js — Web search tool.
 *
 * Delegates to an external search API or LLM-based web search.
 * Supports configurable search providers via Yeaft config.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'WebSearch',
  description: `Search the web for current information.

Use this when you need up-to-date information that may not be in your training data.
Returns search results with titles, URLs, and snippets.

Guidelines:
- Use specific, targeted search queries
- Include the current year for time-sensitive queries
- Combine with WebFetch to read full page content from results`,
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
    if (!query) return JSON.stringify({ error: 'query is required' });

    try {
      // Check if adapter supports web search natively (some LLM providers have built-in search)
      const adapter = ctx?.adapter;
      if (adapter && typeof adapter.webSearch === 'function') {
        const results = await adapter.webSearch(query, limit);
        return JSON.stringify(results, null, 2);
      }

      // Check config for search API endpoint
      const searchUrl = ctx?.config?.searchApiUrl;
      if (searchUrl) {
        const url = new URL(searchUrl);
        url.searchParams.set('q', query);
        url.searchParams.set('limit', String(limit));

        const response = await fetch(url.toString(), {
          signal: ctx?.signal,
          headers: { 'User-Agent': 'Yeaft/1.0' },
        });

        if (!response.ok) {
          return JSON.stringify({ error: `Search API returned ${response.status}: ${response.statusText}` });
        }

        const data = await response.json();
        return JSON.stringify(data, null, 2);
      }

      // Fallback: no search provider configured
      return JSON.stringify({
        error: 'No web search provider configured.',
        hint: 'Configure searchApiUrl in ~/.yeaft/config.json or use an LLM provider with built-in search.',
      });
    } catch (err) {
      if (err.name === 'AbortError') return JSON.stringify({ error: 'Search cancelled' });
      return JSON.stringify({ error: `Web search failed: ${err.message}` });
    }
  },
});
