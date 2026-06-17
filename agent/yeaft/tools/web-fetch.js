/**
 * web-fetch.js — Fetch web page content.
 *
 * Retrieves the content of a URL, converts HTML to readable text,
 * and returns it for the LLM to process.
 */

import { defineTool } from './types.js';

/** Strip HTML tags and normalize whitespace for readability. */
function htmlToText(html) {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Replace br/p/div/h tags with newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Normalize whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default defineTool({
  name: 'WebFetch',
  description: {
  en: `Fetch and read the content of a web page.

Retrieves the URL content, strips HTML tags, and returns readable text.
Use this to read documentation, articles, or any web page.

Guidelines:
- Provide the full URL including protocol (https://)
- Large pages will be truncated — use the offset parameter for pagination
- For APIs, the raw response body is returned as-is
- Respects the abort signal for cancellation`,
  zh: `获取并读取网页内容。

获取 URL 内容，去除 HTML 标签，返回可读文本。用于阅读文档、文章或任何网页。

使用指南：
- 提供完整 URL 含协议（https://）
- 大页面会截断——用 offset 参数做分页
- 对 API 请求，原始响应体原样返回
- 尊重取消信号`
},
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      max_length: {
        type: 'number',
        description: 'Maximum content length in characters (default: 50000)',
      },
      raw: {
        type: 'boolean',
        description: 'If true, return raw response without HTML stripping (for APIs)',
      },
    },
    required: ['url'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { url, max_length = 50000, raw = false } = input;
    if (!url) return JSON.stringify({ error: 'url is required' });

    try {
      // Validate URL
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        return JSON.stringify({ error: `Invalid URL: ${url}` });
      }

      // Only allow http(s)
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return JSON.stringify({ error: `Unsupported protocol: ${parsedUrl.protocol}` });
      }

      const response = await fetch(url, {
        signal: ctx?.signal,
        headers: {
          'User-Agent': 'Yeaft/1.0 (compatible; bot)',
          'Accept': 'text/html, application/json, text/plain, */*',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        return JSON.stringify({
          error: `HTTP ${response.status}: ${response.statusText}`,
          url,
        });
      }

      const contentType = response.headers.get('content-type') || '';
      const body = await response.text();

      let content;
      if (raw || contentType.includes('json') || contentType.includes('text/plain')) {
        content = body;
      } else {
        content = htmlToText(body);
      }

      // Truncate if too long
      const truncated = content.length > max_length;
      if (truncated) {
        content = content.slice(0, max_length);
      }

      return JSON.stringify({
        url: response.url, // final URL after redirects
        status: response.status,
        contentType,
        contentLength: content.length,
        truncated,
        content,
      });
    } catch (err) {
      if (err.name === 'AbortError') return JSON.stringify({ error: 'Fetch cancelled' });
      return JSON.stringify({ error: `Fetch failed: ${err.message}`, url });
    }
  },
});
