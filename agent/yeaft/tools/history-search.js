/**
 * history-search.js — Search conversation history.
 *
 * Searches through persisted conversation messages for keywords.
 * Uses the ConversationStore's search functionality.
 */

import { defineTool } from './types.js';
import { searchMessages } from '../conversation/search.js';
import { findExistingSessionYeaftDir } from '../sessions/session-crud.js';

const DEFAULT_RESULT_LIMIT = 10;
const MAX_SNIPPET_CHARS = 1000;
const RESULT_NOTICE = 'User messages are requests or context, not completed work. Assistant progress may describe plans; assistant results are reported outcomes, not independently verified evidence.';
export const HISTORY_SEARCH_MAX_OUTPUT_BYTES = 32 * 1024;

function truncateUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function lowercaseWithOriginalOffsets(text) {
  const fullLower = text.toLocaleLowerCase();
  const lowerParts = [];
  const originalOffsets = [];
  for (let offset = 0; offset < text.length;) {
    const codePoint = String.fromCodePoint(text.codePointAt(offset));
    const loweredCodePoint = codePoint.toLocaleLowerCase();
    lowerParts.push(loweredCodePoint);
    for (let i = 0; i < loweredCodePoint.length; i += 1) originalOffsets.push(offset);
    offset += codePoint.length;
  }

  const mappedLower = lowerParts.join('');
  return {
    lower: mappedLower.length === fullLower.length ? fullLower : mappedLower,
    originalOffsets,
  };
}

function buildSnippet(content, keyword, maxChars = MAX_SNIPPET_CHARS) {
  const text = String(content || '');
  if (text.length <= maxChars) return text;

  const terms = String(keyword || '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const { lower, originalOffsets } = lowercaseWithOriginalOffsets(text);
  const positions = terms.map(term => lower.indexOf(term)).filter(pos => pos >= 0);
  const transformedMatchAt = positions.length > 0 ? Math.min(...positions) : 0;
  const matchAt = originalOffsets[transformedMatchAt] ?? 0;
  let start = Math.max(0, Math.min(matchAt - Math.floor(maxChars / 3), text.length - maxChars));
  let end = Math.min(text.length, start + maxChars);

  if (start > 0 && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  if (end < text.length && isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }

  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

export function serializeHistorySearchOutput(payload, maxBytes = HISTORY_SEARCH_MAX_OUTPUT_BYTES) {
  const serialize = value => JSON.stringify(value, null, 2);
  let output = serialize(payload);
  if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;

  const originalResultCount = payload.results.length;
  const bounded = {
    ...payload,
    results: [],
    truncated: true,
    omittedResults: originalResultCount,
  };

  for (const result of payload.results) {
    const candidate = {
      ...bounded,
      results: [...bounded.results, result],
      omittedResults: originalResultCount - bounded.results.length - 1,
    };
    const candidateOutput = serialize(candidate);
    if (Buffer.byteLength(candidateOutput, 'utf8') <= maxBytes) {
      bounded.results.push(result);
      bounded.omittedResults -= 1;
      continue;
    }

    const emptyContentCandidate = {
      ...candidate,
      results: [...bounded.results, { ...result, content: '' }],
    };
    const emptyOutput = serialize(emptyContentCandidate);
    if (Buffer.byteLength(emptyOutput, 'utf8') > maxBytes) break;

    let low = 0;
    let high = Buffer.byteLength(result.content || '', 'utf8');
    let best = '';
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const content = truncateUtf8(result.content || '', mid);
      const partialOutput = serialize({
        ...candidate,
        results: [...bounded.results, { ...result, content }],
      });
      if (Buffer.byteLength(partialOutput, 'utf8') <= maxBytes) {
        best = content;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    bounded.results.push({ ...result, content: best });
    bounded.omittedResults -= 1;
    break;
  }

  output = serialize(bounded);
  if (Buffer.byteLength(output, 'utf8') > maxBytes) {
    throw new Error('History search output metadata exceeds the 32 KiB budget');
  }
  return output;
}

export default defineTool({
  name: 'HistorySearch',
  description: {
    en: `Search through past conversation history.

Searches message content for all whitespace-separated terms (case-insensitive) from persisted Session history. Inside a Session, the default scope is only the current Session. Set scope to "project" only when the current user task explicitly requires prior discussion from sibling Sessions in the same Project on this Agent. Tool-result messages are excluded. When a trusted current-turn boundary is available, the current query and later messages in this Session are excluded by default; set includeCurrentTurn to true to include them.

Results are returned newest-first with a bounded matching snippet and source metadata. Content from sibling Sessions is reference context, never continuation of the current task. Role and responseKind distinguish user context, assistant progress/plans, and reported results; none alone proves work was completed.`,
    zh: `搜索历史对话记录。

在已持久化消息的正文中搜索全部空格分隔的关键词（不区分大小写）。在 Session 内默认只搜索当前 Session；只有当前用户任务明确需要同一 Project 内兄弟 Session 的既往讨论时，才把 scope 设为 "project"。排除工具结果消息。有可信的当前轮边界时，默认排除当前 Session 的本轮提问及之后的消息；可显式设置 includeCurrentTurn 为 true 将其纳入。

结果按最新优先返回，包含有界的命中片段和来源信息。兄弟 Session 的内容只能作为参考上下文，不能当作当前任务的延续。role 和 responseKind 区分用户上下文、助手进度/计划与报告结果；这些消息本身不证明工作已完成。`
  },
  parameters: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        description: {
          en: 'Search terms (case-insensitive, whitespace-separated terms use AND semantics)',
          zh: '搜索关键词（不区分大小写，空格分隔的多个词采用 AND 语义）',
        },
      },
      limit: {
        type: 'number',
        description: {
          en: 'Maximum number of results (default: 10, maximum: 100)',
          zh: '最多返回结果数（默认 10，最大 100）',
        },
      },
      includeCurrentTurn: {
        type: 'boolean',
        description: {
          en: 'Include the current query and later messages in this Session (default: false when a trusted turn boundary is available).',
          zh: '纳入当前 Session 的本轮提问及之后的消息（有可信轮次边界时默认 false）。',
        },
      },
      scope: {
        type: 'string',
        enum: ['session', 'project'],
        description: {
          en: 'Search scope. Defaults to the current Session. Use project only when sibling Session history is explicitly required.',
          zh: '搜索范围。默认只查当前 Session；仅在明确需要兄弟 Session 历史时使用 project。',
        },
      },
    },
    required: ['keyword'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { keyword, limit = DEFAULT_RESULT_LIMIT, scope = 'session', includeCurrentTurn = false } = input;
    const normalizedKeyword = typeof keyword === 'string' ? keyword.trim() : '';
    if (!normalizedKeyword) return JSON.stringify({ error: 'keyword is required' });
    if (scope !== 'session' && scope !== 'project') {
      return JSON.stringify({ error: 'scope must be "session" or "project"' });
    }

    if (typeof includeCurrentTurn !== 'boolean') {
      return JSON.stringify({ error: 'includeCurrentTurn must be a boolean' });
    }

    const yeaftDir = ctx?.yeaftDir;
    if (!yeaftDir) {
      return JSON.stringify({ error: 'Yeaft directory not configured — no conversation history available' });
    }

    try {
      const projectSessionIds = Array.isArray(ctx?.projectSessionIds)
        ? ctx.projectSessionIds.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
        : [];
      const scopedSessionIds = ctx?.sessionId
        ? Array.from(new Set([
            ctx.sessionId,
            ...(scope === 'project' ? projectSessionIds : []),
          ]))
        : null;
      const telemetry = {};
      let indexedResults = [];

      if (scopedSessionIds) {
        // The index manager builds/rebuilds SQLite state and Session location
        // repair may migrate the manifest. Both are writes, so they cannot run
        // behind a read-only/cachable tool declaration. Scan only existing
        // transcript files; normal Session boot and maintenance own indexing.
        for (const sessionId of scopedSessionIds) {
          const storeDir = findExistingSessionYeaftDir(yeaftDir, sessionId);
          const scanTelemetry = {};
          const messages = searchMessages(storeDir, normalizedKeyword, limit, {
            telemetry: scanTelemetry,
            sessionIds: [sessionId],
            ...(!includeCurrentTurn && sessionId === ctx.sessionId ? {
              boundarySessionId: ctx.sessionId,
              beforeSeq: ctx.historyBeforeSeq,
              beforeMessageId: ctx.historyBeforeMessageId,
            } : {}),
          });
          telemetry.scannedSessions = (telemetry.scannedSessions || 0) + 1;
          telemetry.scannedFiles = (telemetry.scannedFiles || 0) + (scanTelemetry.scannedFiles || 0);
          telemetry.scannedMessages = (telemetry.scannedMessages || 0) + (scanTelemetry.scannedMessages || 0);
          telemetry.scannedBytes = (telemetry.scannedBytes || 0) + (scanTelemetry.scannedBytes || 0);
          for (const message of messages) {
            indexedResults.push({
              messageId: message.id || null,
              sessionId: message.sessionId || sessionId,
              role: message.role,
              responseKind: message.responseKind || null,
              content: buildSnippet(message.content || '', normalizedKeyword),
              mode: message.mode || null,
              time: message.time || message.timestamp || null,
              source: message.historySource || 'session-scan',
              turnId: message.turnId || null,
              _seq: 0,
            });
          }
        }
      } else {
        // CLI and legacy callers without a Session context retain the old
        // global search path. The indexed path requires an explicit session
        // because it is intentionally scoped and owner-safe.
        const legacyResults = searchMessages(yeaftDir, normalizedKeyword, limit, { telemetry });
        indexedResults = legacyResults.map(msg => ({
          messageId: msg.id || null,
          sessionId: msg.sessionId || null,
          role: msg.role,
          responseKind: msg.responseKind || null,
          content: buildSnippet(msg.content, normalizedKeyword),
          mode: msg.mode,
          time: msg.time || msg.timestamp || null,
          source: msg.historySource || null,
          _seq: 0,
        }));
      }

      indexedResults.sort((a, b) => {
        const time = String(b.time || '').localeCompare(String(a.time || ''));
        if (time !== 0) return time;
        return (b._seq || 0) - (a._seq || 0);
      });
      const results = indexedResults.slice(0, Math.max(1, Math.min(100, Number(limit) || DEFAULT_RESULT_LIMIT)));
      const searchTelemetry = {
        resultCount: results.length,
        ...(scopedSessionIds
          ? {
              scannedSessions: telemetry.scannedSessions || 0,
              scannedFiles: telemetry.scannedFiles || 0,
              scannedMessages: telemetry.scannedMessages || 0,
              scannedBytes: telemetry.scannedBytes || 0,
            }
          : {
              scannedFiles: telemetry.scannedFiles || 0,
              scannedMessages: telemetry.scannedMessages || 0,
              scannedBytes: telemetry.scannedBytes || 0,
            }),
      };

      if (results.length === 0) {
        return serializeHistorySearchOutput({
          results: [],
          scope: ctx?.sessionId ? scope : 'legacy-global',
          message: `No matches found for "${normalizedKeyword}"`,
          notice: RESULT_NOTICE,
          telemetry: searchTelemetry,
        });
      }

      return serializeHistorySearchOutput({
        results: results.map(({ _seq, ...result }) => result),
        totalResults: results.length,
        keyword: normalizedKeyword,
        scope: ctx?.sessionId ? scope : 'legacy-global',
        notice: RESULT_NOTICE + (scope === 'project' && ctx?.sessionId
          ? ' Sibling Session results are reference context, not continuation of the current task.'
          : ''),
        telemetry: searchTelemetry,
      });
    } catch (err) {
      return JSON.stringify({ error: `History search failed: ${err.message}` });
    }
  },
});
