/**
 * web-fetch.js — Fetch web page content.
 *
 * Retrieves the content of a URL, converts HTML to readable text,
 * and returns it for the LLM to process.
 */

import { defineTool } from './types.js';
import {
  attachResearchGuidance, canonicalWebUrl, recordWebResearchCall, setBounded,
  shareWebRequest, webFetchKey, webHttpFailure, webRequestFailure, withWebDeadline,
} from '../web-research.js';

/** Strip HTML tags and normalize whitespace for readability. */
function htmlToText(html) {
  // Remove common site chrome before applying the caller's length budget.
  // Fall back for pages whose only content is navigation; raw/API is untouched.
  const cleaned = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const withoutChrome = cleaned.replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const source = withoutChrome.replace(/<[^>]+>/g, '').trim() ? withoutChrome : cleaned;
  return source
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
- Fetch one authoritative relevant page first; inspect it before fetching alternatives
- Set max_length to the smallest useful content budget. Large pages are truncated; use a more targeted source rather than repeatedly fetching the same URL
- For APIs, the raw response body is returned as-is
- Respects the abort signal for cancellation`,
    zh: `获取并读取网页内容。

获取 URL 内容，去除 HTML 标签，返回可读文本。用于阅读文档、文章或任何网页。

使用指南：
- 提供完整 URL 含协议（https://）
- 先抓取一个最权威、最相关的页面；检查结果后再决定是否抓取备选页面
- 将 max_length 设为满足需要的最小内容预算。大页面会截断；应改用更定向的来源，而不是重复抓取同一 URL
- 对 API 请求，原始响应体原样返回
- 尊重取消信号`
  },
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: {
          en: 'The URL to fetch',
          zh: '要获取的 URL',
        },
      },
      max_length: {
        type: 'number',
        description: {
          en: 'Maximum content length in characters (default: 50000)',
          zh: '最大内容长度，单位字符（默认 50000）',
        },
      },
      polling: {
        type: 'boolean',
        description: {
          en: 'Set true only for user-requested live status polling while waiting for external work. Not for repeatedly reading documents, schemas or static API responses. Does not change response formatting.',
          zh: '仅在用户要求等待外部任务并轮询实时状态时设为 true，不用于重复读取文档、schema 或静态 API 响应；不改变响应格式。',
        },
      },
      raw: {
        type: 'boolean',
        description: {
          en: 'If true, return raw response without HTML stripping (for APIs)',
          zh: '如果为 true，返回原始响应不去除 HTML（用于 API）',
        },
      },
    },
    required: ['url'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  // Success-only reuse and active sharing belong to the query ledger, not Engine's cache.
  duplicateCallPolicy: (input) => input?.polling === true ? 'allow' : 'warn',
  async execute(input, ctx) {
    const { url, max_length = 50000, raw = false, polling = false } = input;
    const research = ctx?.webResearch;
    const signal = ctx?.signal;
    let canonicalUrl;
    try {
      canonicalUrl = canonicalWebUrl(url);
      if (!['http:', 'https:'].includes(new URL(canonicalUrl).protocol)) throw new Error('Only HTTP(S) URLs are supported');
      if (!Number.isInteger(max_length) || max_length < 1) throw new Error('max_length must be a positive integer');
    } catch (error) {
      return JSON.stringify({ error: `Invalid fetch input: ${error.message}`, code: 'invalid_arguments', errorEffect: 'none', hint: 'Provide a full HTTP(S) URL and a positive integer max_length.' });
    }

    try {
      signal?.throwIfAborted();
      const key = webFetchKey(canonicalUrl, { raw, maxLength: max_length });
      const prior = !polling && research?.fetches.get(key);
      if (prior) return attachResearchGuidance(prior, research, {
        reused: true, reuseReason: 'This URL and response mode already succeeded in this query. Use polling:true only for requested live status checks.',
      });
      const output = await shareWebRequest(research, JSON.stringify(['fetch', key, polling]), signal, async () => {
        let result;
        try {
          result = await withWebDeadline(signal, async bounded => {
            const response = await fetch(canonicalUrl, {
              signal: bounded,
              headers: { 'User-Agent': 'Yeaft/1.0 (compatible; bot)', Accept: 'text/html, application/json, text/plain, */*' },
              redirect: 'follow',
            });
            const finalUrl = response.url || canonicalUrl;
            if (!response.ok) return { ...webHttpFailure(response.status, response.statusText), url: finalUrl };
            const contentType = response.headers.get('content-type') || '';
            const body = await response.text();
            const content = raw || contentType.includes('json') || contentType.includes('text/plain') ? body : htmlToText(body);
            return {
              url: finalUrl, status: response.status, contentType,
              contentLength: Math.min(content.length, max_length), truncated: content.length > max_length,
              content: content.slice(0, max_length),
            };
          });
          signal?.throwIfAborted();
        } catch (error) {
          result = { ...webRequestFailure(error, signal), url: canonicalUrl };
        }
        recordWebResearchCall(research);
        const previousAuth = research?.authorizationFailures.get(canonicalUrl);
        if (previousAuth && result.error) {
          result.priorAuthorizationFailure = previousAuth;
          result.hint += ' This same URL previously denied access in this query; check public access before retrying.';
        }
        const output = JSON.stringify(result);
        if (research) {
          if (!result.error) {
            setBounded(research.fetches, key, output);
            research.authorizationFailures.delete(canonicalUrl);
          } else if ([401, 403].includes(result.status)) {
            setBounded(research.authorizationFailures, canonicalUrl, { status: result.status, url: result.url });
          }
        }
        return output;
      });
      return attachResearchGuidance(output, research);
    } catch (error) {
      return attachResearchGuidance({ ...webRequestFailure(error, signal), url: canonicalUrl }, research);
    }
  },
});
