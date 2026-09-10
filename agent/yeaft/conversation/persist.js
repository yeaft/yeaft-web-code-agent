/**
 * persist.js — Conversation message persistence
 *
 * Hot conversation messages are stored as JSONL segments with a small JSON index
 * under ~/.yeaft/chat/ or ~/.yeaft/sessions/<sessionId>/conversation/.
 * Older per-message Markdown
 * files are read as a legacy fallback only.
 *
 * Vocabulary note: the primary on-disk layout uses `sessions/<id>/`. Older
 * installs may still have transcript files under `groups/<id>/`; those are
 * read as a legacy fallback only. Every API surface above the disk layer
 * uses "session" vocabulary.
 *
 * Segment format: one JSON object per line, keyed by global monotonic `seq` /
 * `id` (`m0001`, `m0002`, ...).
 *
 * Reference: yeaft-yeaft-core-systems.md §4.1, yeaft-yeaft-brainstorm-v5.1.md
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync, appendFileSync } from 'fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, basename } from 'path';
import { isPermissionError } from '../init.js';
import { writeAtomic } from '../storage/atomic.js';
import { pairSanitize } from '../pair-sanitize.js';
import { sliceLastNTurns, stripVpMentionPrefix } from '../turn-utils.js';
import { isHiddenConversationRow, isVisibleConversationRow } from './internal-control.js';
import {
  findLiteralSearch,
  iterateCanonicalVisibleEntriesNewestFirst,
  normalizeLiteralSearch,
} from './visible-entry.js';
import { markConversationDirty } from './history-index-state.js';

/**
 * Default cold-start "recent window" size, expressed in TURNS (not raw
 * messages). One turn = one user prompt round-trip; multi-VP fan-out
 * collapses N `@vp-X` variants of the same canonical prompt into ONE turn.
 *
 * Why turns and not messages: message-count slicing can cut mid-arc and
 * orphan a `[assistant(toolCalls), tool…]` pair, which 400s the Anthropic /
 * Chat-Completions adapter. Turn-based slicing always cuts at a user-
 * message boundary, which is pair-safe by construction.
 *
 * 10 turns is the default bootstrap window.
 * It is the cold-start replay window after a fresh boot or reconnect. Runtime
 * provider requests apply a separate deterministic history-window transform;
 * no LLM summary is required for recovery.
 *
 * Configurable via `~/.yeaft/config.json` → `yeaft.recentTurnsLimit`.
 * Session boot calls `setDefaultRecentTurnsLimit()` once with the
 * resolved config value; tests can call it directly.
 *
 * NB: this is intentionally `let` (not `const`) and read via
 * `getDefaultRecentTurnsLimit()` from outside this module — ES module
 * named exports ARE live bindings, but callers that snapshot the value
 * at module load (`const cap = DEFAULT_RECENT_TURNS`) would not see
 * runtime overrides. The reader function makes that always-correct.
 */
let DEFAULT_RECENT_TURNS = 10;

// Circuit breaker for newest-to-oldest session scans. This bounds event-loop
// starvation when the newest transcript tail is dense with hidden/internal or
// otherwise non-turn rows and no user boundary is found quickly.
const RECENT_SESSION_SCAN_BASE_CAP = 64;
const RECENT_SESSION_SCAN_PER_TURN_CAP = 4;
const RECENT_SESSION_SCAN_MAX_CAP = 256;
// A normal Engine loop executes at most 30 tools, but parallel VPs can append
// many rows between a call and its result. One extra normal delta page keeps the
// scan bounded while leaving enough room to close a legitimate interleaved arc.
const DELTA_TOOL_PAIR_EXTENSION_CAP = 500;


const SEGMENT_INDEX_FILE = 'index.json';
const SEGMENT_LINEAGE_FILE = 'lineage.json';
const SEGMENT_DIR = 'segments';
const SEGMENT_TARGET_BYTES = 1024 * 1024;
const SEGMENT_FIRST_NAME = '000001.jsonl';

function latestTodoWriteSnapshot(toolCalls) {
  if (!Array.isArray(toolCalls)) return null;
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    if (call?.name === 'TodoWrite' && Array.isArray(call?.input?.todos)) return call.input.todos;
  }
  return null;
}

function emptySegmentIndex() {
  return {
    version: 2,
    streamId: null,
    revision: 0,
    nextSeq: 1,
    totalMessages: 0,
    lastMessageId: null,
    activeSegment: SEGMENT_FIRST_NAME,
    segments: [],
    foldedMessageIds: [],
  };
}

function seqId(seq) {
  return `m${String(seq).padStart(4, '0')}`;
}

function normalizeSegmentRecord(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const seq = Number.isFinite(msg.seq) ? msg.seq : parseSeqFromId(msg.id);
  if (!Number.isFinite(seq)) return null;
  const out = { ...msg, seq, id: msg.id || seqId(seq) };
  return out;
}

function foldedMessageIdsFrom(rows) {
  const ids = new Set();
  for (const row of rows || []) {
    if (!row?._reflection || !Array.isArray(row.foldedMessageIds)) continue;
    for (const id of row.foldedMessageIds) {
      if (typeof id === 'string' && id) ids.add(id);
    }
  }
  return ids;
}

function applyFoldedMessageTombstones(rows, additionalIds = []) {
  const foldedIds = foldedMessageIdsFrom(rows);
  for (const id of additionalIds || []) {
    if (typeof id === 'string' && id) foldedIds.add(id);
  }
  if (foldedIds.size === 0) return rows;
  return rows.filter(row => !foldedIds.has(row?.id));
}

function addScanMetric(stats, key, value = 1) {
  if (!stats || typeof stats !== 'object' || !Number.isFinite(value) || value <= 0) return;
  stats[key] = (Number(stats[key]) || 0) + value;
}

function segmentNameForNumber(n) {
  return `${String(n).padStart(6, '0')}.jsonl`;
}

function nextSegmentName(name) {
  const m = String(name || '').match(/^(\d+)\.jsonl$/);
  const n = m ? parseInt(m[1], 10) + 1 : 1;
  return segmentNameForNumber(n);
}

function parseJsonLine(line) {
  if (!line || !line.trim()) return null;
  try { return normalizeSegmentRecord(JSON.parse(line)); }
  catch { return null; }
}

function parseSegmentOrMarkdown(raw) {
  if (!raw) return null;
  const msg = parseJsonLine(raw);
  if (msg) return msg;
  return parseMessage(raw);
}

/** Read the current default cold-start replay window (turn count). */
export function getDefaultRecentTurnsLimit() {
  return DEFAULT_RECENT_TURNS;
}

// Back-compat re-export for callers that grab a snapshot at module load.
// New code should call `getDefaultRecentTurnsLimit()` so it sees runtime
// overrides applied by `setDefaultRecentTurnsLimit()`.
export { DEFAULT_RECENT_TURNS };

/**
 * Override the default cold-start replay window. Called once per
 * session boot (`session.js`) from the loaded config. Silently ignores
 * unparseable input but emits a `console.warn` so a hand-edited config
 * (`recentTurnsLimit: "twenty"`) doesn't fail open without a signal.
 *
 * @param {number|string} n
 */
export function setDefaultRecentTurnsLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Yeaft] setDefaultRecentTurnsLimit(${JSON.stringify(n)}) ignored — ` +
      `expected a positive number; keeping DEFAULT_RECENT_TURNS=${DEFAULT_RECENT_TURNS}.`
    );
    return;
  }
  DEFAULT_RECENT_TURNS = Math.floor(v);
}

/**
 * Per-session warn-once tracker. Keyed by `${storeDir}::${sessionId}`
 * so a single process running multiple sessions only warns once per
 * session per boot.
 *
 * The Set is module-level (singleton) because the warning is about
 * end-user UX (don't spam the console), not about test isolation. Tests
 * that exercise the warn-once gate call `__resetTruncationWarned()` in
 * their setup to start from a clean slate; without this seam two
 * sequential tests in the same module would observe the gate from the
 * first test silently suppress the second test's warn.
 */
const _truncationWarned = new Set();

/** Test-only: clear the warn-once gate (do not call in production). */
export function __resetTruncationWarned() {
  _truncationWarned.clear();
}

/**
 * Warn (once per session per process) when the cold-start replay window
 * truncates history. The persisted transcript remains available through
 * pagination/search; this warning only describes the model bootstrap window.
 *
 * @param {string} sessionId
 * @param {string} storeDir
 * @param {number} recentTurnsLimit — configured recent-turn window
 */
function maybeWarnHistoryTruncated(sessionId, storeDir, recentTurnsLimit) {
  if (!sessionId || !storeDir) return;
  const key = `${storeDir}::${sessionId}`;
  if (_truncationWarned.has(key)) return;
  _truncationWarned.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[Yeaft] history for session ${sessionId} bootstrapped with ${recentTurnsLimit} recent turns ` +
    `(recentTurnsLimit=${DEFAULT_RECENT_TURNS}); older transcript remains available through history pagination/search. ` +
    `Raise yeaft.recentTurnsLimit in ~/.yeaft/config.json to send more recent context after boot.`
  );
}

// ─── Token estimation ────────────────────────────────────────

/**
 * Whether a permission warning has already been logged for this store instance.
 * Used to avoid spamming the console with repeated warnings.
 */
let _permissionWarned = false;
let _historyIndexMutationWarned = false;

/** Rough token estimation: ~4 chars per token. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Parse the global monotonic sequence number out of a message id of the
 * form `m####`. Returns NaN for malformed ids. Used by the pagination
 * cursor (`loadOlderBySession`) to compare ids numerically without having
 * to trust file-system sort order.
 *
 * @param {string} id
 * @returns {number}
 */
export function parseSeqFromId(id) {
  const m = String(id || '').match(/^m(\d+)$/);
  return m ? parseInt(m[1], 10) : NaN;
}

function compareMessagesBySeq(a, b) {
  const sa = parseSeqFromId(a?.id);
  const sb = parseSeqFromId(b?.id);
  if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
  return String(a?.time || '').localeCompare(String(b?.time || ''));
}

function canonicalUserTurnContent(content) {
  if (typeof content === 'string') return stripVpMentionPrefix(content);
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(part => part && typeof part === 'object' && part.type === 'text')
    .map(part => typeof part.text === 'string' ? part.text : '')
    .join('\n')
    .trim();
  return text ? stripVpMentionPrefix(text) : null;
}

function recentSessionScanCap(turnsLimit) {
  const turns = Number.isFinite(turnsLimit) && turnsLimit > 0 ? Math.ceil(turnsLimit) : DEFAULT_RECENT_TURNS;
  return Math.min(RECENT_SESSION_SCAN_MAX_CAP, RECENT_SESSION_SCAN_BASE_CAP + turns * RECENT_SESSION_SCAN_PER_TURN_CAP);
}

function askUserToolIdentity(row, toolCallId) {
  if (!row || typeof toolCallId !== 'string' || !toolCallId) return null;
  return [
    row.sessionId || '',
    row.speakerVpId || '',
    row.turnId || '',
    row.threadId || 'main',
    toolCallId,
  ].join('\u0000');
}

function parseAskUserResult(toolCall, toolResult) {
  if (!toolCall || toolCall.name !== 'AskUser' || typeof toolCall.id !== 'string' || !toolCall.id
      || !toolResult || toolResult.isError) return null;
  let payload = toolResult.content;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!payload || typeof payload !== 'object') return null;

  const question = typeof toolCall.input?.question === 'string'
    ? toolCall.input.question
    : (typeof payload.question === 'string' ? payload.question : '');
  const options = Array.isArray(toolCall.input?.options)
    ? toolCall.input.options.filter(option => typeof option === 'string')
    : [];
  if (payload.timedOut === true) {
    return {
      toolCallId: toolCall.id,
      status: 'expired',
      question,
      options,
    };
  }
  if (!payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers)) return null;
  return {
    toolCallId: toolCall.id,
    status: 'answered',
    question,
    options,
    answers: payload.answers,
  };
}

const FAILED_RESPONSE_REASONS = new Set(['aborted', 'errored', 'error', 'cancelled', 'canceled']);

function projectedResponseKind(row) {
  if (row?.incomplete === true || FAILED_RESPONSE_REASONS.has(row?.stopReason)) {
    return 'progress';
  }
  if (row?.responseKind === 'progress' || row?.responseKind === 'result') {
    return row.responseKind;
  }
  if (row?.stopReason === 'end_turn') return 'result';
  return null;
}

export function projectVisibleSessionMessages(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const toolResults = new Map();
  for (const row of rows) {
    if (row?.role !== 'tool') continue;
    const identity = askUserToolIdentity(row, row.toolCallId);
    if (identity) toolResults.set(identity, row);
  }

  const visible = [];
  for (const sourceRow of rows) {
    if (!sourceRow || (sourceRow.role !== 'user' && sourceRow.role !== 'assistant')) continue;
    // Public history never owns provider-private continuation payloads.
    const { providerState, thinkingBlocks, ...row } = sourceRow;
    if (!isVisibleConversationRow(row)) continue;
    if (row.role !== 'assistant' || !Array.isArray(row.toolCalls) || row.toolCalls.length === 0) {
      if (row.role === 'assistant' && !row.content && !row.attachments && !row.images
          && !row.todos && !row.askUserResults) continue;
      const responseKind = row.role === 'assistant' ? projectedResponseKind(row) : null;
      visible.push(responseKind && row.responseKind !== responseKind
        ? { ...row, responseKind }
        : row);
      continue;
    }

    const askUserResults = [];
    const visibleToolCalls = [];
    for (const toolCall of row.toolCalls) {
      if (toolCall?.name === 'TodoWrite') continue;
      const identity = askUserToolIdentity(row, toolCall?.id);
      const result = parseAskUserResult(toolCall, identity ? toolResults.get(identity) : null);
      if (result) askUserResults.push(result);
      visibleToolCalls.push(toolCall);
    }
    const { toolCalls, ...rowWithoutToolCalls } = row;
    const responseKind = projectedResponseKind(rowWithoutToolCalls);
    const rest = responseKind && rowWithoutToolCalls.responseKind !== responseKind
      ? { ...rowWithoutToolCalls, responseKind }
      : rowWithoutToolCalls;
    const todos = latestTodoWriteSnapshot(toolCalls);
    const projected = {
      ...rest,
      ...(todos ? { todos } : {}),
      ...(visibleToolCalls.length > 0 ? { toolCalls: visibleToolCalls } : {}),
      ...(askUserResults.length > 0 ? { askUserResults } : {}),
    };
    if (!projected.content && !projected.attachments && !projected.images
        && !projected.todos && !projected.toolCalls && !projected.askUserResults) continue;
    visible.push(projected);
  }
  return visible;
}

// ─── Frontmatter helpers ─────────────────────────────────────

/**
 * Serialize message metadata to YAML frontmatter + body.
 * @param {object} msg
 * @returns {string}
 */
function serializeMessage(msg) {
  const fm = [
    '---',
    `id: ${msg.id}`,
    `role: ${msg.role}`,
    `time: ${msg.time || new Date().toISOString()}`,
  ];

  if (msg.mode) fm.push(`mode: ${msg.mode}`);
  if (msg.model) fm.push(`model: ${msg.model}`);
  if (msg.effort) fm.push(`effort: ${msg.effort}`);
  if (Number.isInteger(msg.llmCallCount) && msg.llmCallCount > 0) fm.push(`llmCallCount: ${msg.llmCallCount}`);
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'totalMs']) {
    if (Number.isFinite(msg[key]) && msg[key] >= 0) fm.push(`${key}: ${Math.round(msg[key])}`);
  }
  if (msg.turnNumber != null) fm.push(`turnNumber: ${msg.turnNumber}`);
  if (msg.toolCallId) fm.push(`toolCallId: ${msg.toolCallId}`);
  if (msg.eventType) fm.push(`eventType: ${msg.eventType}`);
  if (msg.taskId) fm.push(`taskId: ${msg.taskId}`);
  if (msg.taskStatus) fm.push(`taskStatus: ${msg.taskStatus}`);
  if (msg.isError) fm.push(`isError: true`);
  // task-307: every message is stamped with a threadId so multi-thread
  // routing can filter/replay by thread without rescanning JSON blobs.
  // Defaults to 'main' for legacy messages (see migrate-messages-threadid.js).
  fm.push(`threadId: ${msg.threadId || 'main'}`);
  if (msg.turnId) fm.push(`turnId: ${msg.turnId}`);
  if (msg.causalRootId) fm.push(`causalRootId: ${msg.causalRootId}`);
  if (msg.executionOrigin === 'route_forward') fm.push('executionOrigin: route_forward');
  if (msg.imageAssetAnchor) fm.push('imageAssetAnchor: true');
  // task-313: when a thread is merged into another, the messages keep
  // their original thread id in `sourceThreadId` so the UI can still
  // render a small "#source" pill next to each bubble.
  if (msg.sourceThreadId) fm.push(`sourceThreadId: ${msg.sourceThreadId}`);
  // Bug 6: persist sessionId so history replay can stamp messages with the
  // session they originated in. Without this, every replayed message lands
  // in the default session and switching back to the originating session
  // shows an empty pane.
  if (msg.sessionId) fm.push(`sessionId: ${msg.sessionId}`);
  if (msg.chatId) fm.push(`chatId: ${msg.chatId}`);
  if (msg.clientMessageId) fm.push(`clientMessageId: ${msg.clientMessageId}`);
  if (typeof msg.userAuthored === 'boolean') fm.push(`userAuthored: ${msg.userAuthored}`);
  if (msg.incomplete) fm.push('incomplete: true');
  if (msg.stopReason) fm.push(`stopReason: ${msg.stopReason}`);
  if (msg.responseKind === 'progress' || msg.responseKind === 'result') fm.push(`responseKind: ${msg.responseKind}`);
  // Session attribution: when a VP authors an assistant turn (either
  // its own reply or a route_forward injection from another VP), stamp
  // the speaker so the UI can render the message on the correct VP track.
  // For real user messages this is unset.
  if (msg.speakerVpId) fm.push(`speakerVpId: ${msg.speakerVpId}`);
  if (msg.quote && typeof msg.quote === 'object') {
    try {
      const b64 = Buffer.from(JSON.stringify(msg.quote)).toString('base64');
      fm.push(`quoteB64: ${b64}`);
    } catch { /* best-effort: quote metadata is not engine-critical */ }
  }
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    try {
      const b64 = Buffer.from(JSON.stringify(msg.attachments)).toString('base64');
      fm.push(`attachmentsB64: ${b64}`);
    } catch { /* best-effort: attachments are UI metadata, not engine-critical */ }
  }
  if (Array.isArray(msg.images) && msg.images.length > 0) {
    try {
      const b64 = Buffer.from(JSON.stringify(msg.images)).toString('base64');
      fm.push(`imagesB64: ${b64}`);
    } catch { /* best-effort: image display metadata is not engine-critical */ }
  }
  // Internal/synthetic rows must round-trip so refresh/history replay can
  // keep them out of the user-visible conversation. Reflection folding uses
  // `_reflection`; other engine-only rows may use one of the explicit flags.
  if (msg._reflection) fm.push('_reflection: true');
  if (msg.internal) fm.push('internal: true');
  if (msg.systemOnly) fm.push('systemOnly: true');
  if (msg.systemOnlyMessage) fm.push('systemOnlyMessage: true');

  // Token estimate
  const content = msg.content || '';
  const tokensEst = msg.tokens_est || estimateTokens(content);
  fm.push(`tokens_est: ${tokensEst}`);

  // Tool calls as YAML array (simplified)
  // task-fix: persist `input` as base64-encoded JSON so multi-line tool
  // arguments round-trip safely (YAML string escaping is brittle for
  // JSON blobs with newlines / quotes). Paired with the parser below.
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    fm.push(`toolCalls:`);
    for (const tc of msg.toolCalls) {
      fm.push(`  - id: ${tc.id}`);
      fm.push(`    name: ${tc.name}`);
      if (tc.input !== undefined) {
        try {
          const b64 = Buffer.from(JSON.stringify(tc.input)).toString('base64');
          fm.push(`    inputB64: ${b64}`);
        } catch {
          // best-effort: if input isn't JSON-serializable, skip it;
          // restoring a tool_call without input is still better than
          // dropping the whole record.
        }
      }
    }
  }

  // task-327d: persist Anthropic extended-thinking blocks so the next turn
  // can echo them back with their server-signed signature. Both fields are
  // base64'd: thinking is multi-line text, and the signature is opaque
  // bytes that don't need to be human-readable. Without this round-trip
  // the next Anthropic request 400s with "content[].thinking in the
  // thinking mode must be passed back to the API".
  if (msg.providerState) fm.push(`providerStateB64: ${Buffer.from(JSON.stringify(msg.providerState)).toString('base64')}`);
  if (!msg.providerState && msg.thinkingBlocks && msg.thinkingBlocks.length > 0) {
    fm.push(`thinkingBlocks:`);
    for (const tb of msg.thinkingBlocks) {
      if (!tb) continue;
      if (tb.redacted) {
        if (typeof tb.data !== 'string') continue;
        const dataB64 = Buffer.from(tb.data, 'utf8').toString('base64');
        fm.push(`  - redacted: true`);
        fm.push(`    dataB64: ${dataB64}`);
      } else {
        if (typeof tb.thinking !== 'string' || typeof tb.signature !== 'string' || !tb.signature) continue;
        const thinkingB64 = Buffer.from(tb.thinking, 'utf8').toString('base64');
        const signatureB64 = Buffer.from(tb.signature, 'utf8').toString('base64');
        fm.push(`  - thinkingB64: ${thinkingB64}`);
        fm.push(`    signatureB64: ${signatureB64}`);
      }
    }
  }

  fm.push('---');
  fm.push('');
  fm.push(content);

  return fm.join('\n');
}

/**
 * Parse a message .md file into a message object.
 * @param {string} raw — Raw file content
 * @returns {object|null}
 */
export function parseMessage(raw) {
  if (!raw || !raw.startsWith('---')) return null;

  const endIdx = raw.indexOf('\n---', 3);
  if (endIdx === -1) return null;

  const frontmatter = raw.slice(4, endIdx).trim();
  const body = raw.slice(endIdx + 4).trim();

  const msg = { content: body };

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'id': msg.id = value; break;
      case 'role': msg.role = value; break;
      case 'time': msg.time = value; break;
      case 'mode': msg.mode = value; break;
      case 'model': msg.model = value; break;
      case 'effort': msg.effort = value; break;
      case 'llmCallCount': msg.llmCallCount = parseInt(value, 10); break;
      case 'inputTokens': msg.inputTokens = parseInt(value, 10); break;
      case 'outputTokens': msg.outputTokens = parseInt(value, 10); break;
      case 'totalTokens': msg.totalTokens = parseInt(value, 10); break;
      case 'totalMs': msg.totalMs = parseInt(value, 10); break;
      case 'turnNumber': msg.turnNumber = parseInt(value, 10); break;
      case 'toolCallId': msg.toolCallId = value; break;
      case 'eventType': msg.eventType = value; break;
      case 'taskId': msg.taskId = value; break;
      case 'taskStatus': msg.taskStatus = value; break;
      case 'isError': msg.isError = value === 'true'; break;
      case 'tokens_est': msg.tokens_est = parseInt(value, 10); break;
      case 'threadId': msg.threadId = value; break;
      case 'turnId': msg.turnId = value; break;
      case 'causalRootId': msg.causalRootId = value; break;
      case 'executionOrigin':
        if (value === 'route_forward') msg.executionOrigin = value;
        break;
      case 'imageAssetAnchor': msg.imageAssetAnchor = value === 'true'; break;
      case 'sourceThreadId': msg.sourceThreadId = value; break;
      case 'sessionId': msg.sessionId = value; break;
      case 'chatId': msg.chatId = value; break;
      case 'clientMessageId': msg.clientMessageId = value; break;
      case 'userAuthored': msg.userAuthored = value === 'true'; break;
      case 'incomplete': msg.incomplete = value === 'true'; break;
      case 'stopReason': msg.stopReason = value; break;
      case 'responseKind':
        if (value === 'progress' || value === 'result') msg.responseKind = value;
        break;
      case 'speakerVpId': msg.speakerVpId = value; break;
      case 'quoteB64':
        try {
          const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
          if (parsed && typeof parsed === 'object') msg.quote = parsed;
        } catch { /* best-effort: ignore malformed quote metadata */ }
        break;
      case 'attachmentsB64':
        try {
          const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
          if (Array.isArray(parsed)) msg.attachments = parsed;
        } catch { /* best-effort: ignore malformed attachment metadata */ }
        break;
      case 'imagesB64':
        try {
          const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
          if (Array.isArray(parsed)) msg.images = parsed;
        } catch { /* best-effort: ignore malformed image metadata */ }
        break;
      case '_reflection': msg._reflection = value === 'true'; break;
      case 'internal': msg.internal = value === 'true'; break;
      case 'systemOnly': msg.systemOnly = value === 'true'; break;
      case 'systemOnlyMessage': msg.systemOnlyMessage = value === 'true'; break;
      // toolCalls are multi-line YAML — handled separately below
    }
  }

  // task-307: legacy messages written before threadId existed default to 'main'.
  if (!msg.threadId) msg.threadId = 'main';

  // Parse toolCalls if present (simplified multi-line YAML)
  if (frontmatter.includes('toolCalls:')) {
    const toolCalls = [];
    const tcMatch = frontmatter.match(/toolCalls:\n((?:\s+-\s+[\s\S]*?)(?=\n\w|$))/);
    if (tcMatch) {
      const tcBlock = tcMatch[1];
      const entries = tcBlock.split(/\n\s+-\s+/).filter(Boolean);
      for (const entry of entries) {
        const tc = {};
        for (const line of entry.split('\n')) {
          // task-fix: the split regex only strips `\n  - ` between
          // entries, leaving a leading `- ` on the first line of the
          // first entry. Strip it here so `- id: xxx` parses as `id`.
          const trimmed = line.trim().replace(/^-\s+/, '');
          const ci = trimmed.indexOf(':');
          if (ci === -1) continue;
          const k = trimmed.slice(0, ci).trim();
          const v = trimmed.slice(ci + 1).trim();
          if (k === 'id') tc.id = v;
          if (k === 'name') tc.name = v;
          if (k === 'inputB64') {
            try {
              tc.input = JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
            } catch { /* best-effort: leave input undefined */ }
          }
        }
        if (tc.id && tc.name) toolCalls.push(tc);
      }
    }
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
  }

  // task-327d: parse thinkingBlocks (mirror of toolCalls parser above)
  const stateMatch = frontmatter.match(/^providerStateB64: (.+)$/m);
  if (stateMatch) {
    try { msg.providerState = JSON.parse(Buffer.from(stateMatch[1], 'base64').toString('utf8')); } catch { /* legacy invalid row */ }
  }
  if (!msg.providerState && frontmatter.includes('thinkingBlocks:')) {
    const thinkingBlocks = [];
    const tbMatch = frontmatter.match(/thinkingBlocks:\n((?:\s+-\s+[\s\S]*?)(?=\n\w|$))/);
    if (tbMatch) {
      const tbBlock = tbMatch[1];
      const entries = tbBlock.split(/\n\s+-\s+/).filter(Boolean);
      for (const entry of entries) {
        const tb = {};
        for (const line of entry.split('\n')) {
          const trimmed = line.trim().replace(/^-\s+/, '');
          const ci = trimmed.indexOf(':');
          if (ci === -1) continue;
          const k = trimmed.slice(0, ci).trim();
          const v = trimmed.slice(ci + 1).trim();
          if (k === 'thinkingB64') {
            tb.thinking = Buffer.from(v, 'base64').toString('utf8');
          } else if (k === 'dataB64') {
            tb.data = Buffer.from(v, 'base64').toString('utf8');
          } else if (k === 'signatureB64') {
            tb.signature = Buffer.from(v, 'base64').toString('utf8');
          } else if (k === 'redacted') {
            tb.redacted = v === 'true';
          }
        }
        // Both fields required — an unsigned block would 400 on replay.
        if (tb.redacted) {
          if (typeof tb.data === 'string') {
            thinkingBlocks.push(tb);
          }
        } else if (typeof tb.thinking === 'string' && typeof tb.signature === 'string' && tb.signature) {
          thinkingBlocks.push(tb);
        }
      }
    }
    if (thinkingBlocks.length > 0) msg.thinkingBlocks = thinkingBlocks;
  }

  return msg;
}


class SegmentStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.segmentDir = join(rootDir, SEGMENT_DIR);
    this.indexPath = join(rootDir, SEGMENT_INDEX_FILE);
    this.lineagePath = join(rootDir, SEGMENT_LINEAGE_FILE);
    this.index = null;
    this.lineage = null;
  }

  ensure() {
    if (!existsSync(this.rootDir)) mkdirSync(this.rootDir, { recursive: true, mode: 0o755 });
    if (!existsSync(this.segmentDir)) mkdirSync(this.segmentDir, { recursive: true, mode: 0o755 });
  }

  hasData() {
    if (existsSync(this.indexPath)) return true;
    if (!existsSync(this.segmentDir)) return false;
    try { return readdirSync(this.segmentDir).some(f => f.endsWith('.jsonl')); }
    catch (err) { if (isPermissionError(err)) return false; throw err; }
  }

  loadIndex() {
    if (this.index) return this.index;
    let idx = null;
    if (existsSync(this.indexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8') || '{}');
        if (parsed && typeof parsed === 'object') idx = parsed;
      } catch {
        idx = null;
      }
    }
    const indexWasStale = idx && !this.#indexMatchesDisk(idx);
    const normalizedSource = !idx || indexWasStale ? this.#rebuildIndex() : idx;
    this.index = this.#normalizeIndex(normalizedSource);
    this.lineage = this.#resolveLineage(this.index, {
      verifyAnchor: !idx || !normalizedSource?.streamId,
    });
    this.index.streamId = this.lineage.streamId;
    this.index.revision = this.lineage.revision;
    const needsMetadataUpgrade = !normalizedSource?.streamId
      || normalizedSource.streamId !== this.lineage.streamId
      || !Number.isFinite(Number(normalizedSource?.revision))
      || Number(normalizedSource.revision) !== this.lineage.revision;
    if ((!existsSync(this.indexPath) || indexWasStale || needsMetadataUpgrade) && this.hasData()) this.saveIndex();
    return this.index;
  }

  saveIndex() {
    this.ensure();
    writeFileSync(this.indexPath, `${JSON.stringify(this.index || emptySegmentIndex(), null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
  }

  metadata() {
    const idx = this.loadIndex();
    return {
      streamId: idx.streamId,
      revision: Number(idx.revision) || 0,
      headSeq: Math.max(0, (Number(idx.nextSeq) || 1) - 1),
    };
  }

  append(msg) {
    this.ensure();
    const idx = this.loadIndex();
    const establishesAnchor = (Number(idx.totalMessages) || 0) === 0
      && (!Array.isArray(idx.segments) || idx.segments.length === 0);
    let segment = idx.segments[idx.segments.length - 1] || null;
    let active = segment?.file || idx.activeSegment || SEGMENT_FIRST_NAME;
    let activePath = join(this.segmentDir, active);
    const currentSize = existsSync(activePath) ? statSync(activePath).size : 0;
    if (currentSize >= SEGMENT_TARGET_BYTES && segment && segment.count > 0) {
      active = nextSegmentName(active);
      activePath = join(this.segmentDir, active);
      segment = null;
    }
    const line = `${JSON.stringify(msg)}\n`;
    appendFileSync(activePath, line, { encoding: 'utf8', mode: 0o644 });

    const seq = parseSeqFromId(msg.id);
    if (!segment || segment.file !== active) {
      segment = { file: active, firstSeq: seq, lastSeq: seq, count: 0, bytes: 0 };
      idx.segments.push(segment);
    }
    segment.firstSeq = Number.isFinite(segment.firstSeq) ? Math.min(segment.firstSeq, seq) : seq;
    segment.lastSeq = Number.isFinite(segment.lastSeq) ? Math.max(segment.lastSeq, seq) : seq;
    segment.count = (segment.count || 0) + 1;
    segment.bytes = (segment.bytes || currentSize) + Buffer.byteLength(line);
    idx.activeSegment = active;
    idx.totalMessages = (idx.totalMessages || 0) + 1;
    idx.lastMessageId = msg.id || null;
    idx.nextSeq = Math.max(Number(idx.nextSeq) || 1, seq + 1);
    const invalidatesEarlierRows = msg._reflection
      || (Array.isArray(msg.foldedMessageIds) && msg.foldedMessageIds.length > 0);
    // Ordinary appends are recoverable through afterSeq. Only an append that
    // invalidates older visible rows (fold reflection/tombstones) advances the
    // mutation revision and forces the browser to rebuild its snapshot.
    if (invalidatesEarlierRows) {
      idx.revision = (Number(idx.revision) || 0) + 1;
    }
    if (msg._reflection && Array.isArray(msg.foldedMessageIds)) {
      idx.foldedMessageIds = Array.from(new Set([
        ...(Array.isArray(idx.foldedMessageIds) ? idx.foldedMessageIds : []),
        ...msg.foldedMessageIds.filter(id => typeof id === 'string' && id),
      ]));
    }
    this.#persistCurrentLineage({
      revision: idx.revision,
      anchor: establishesAnchor ? this.#lineageAnchorForLine(line) : undefined,
    });
    this.saveIndex();
  }

  readAll({ beforeSeq = Infinity, afterSeq = -Infinity, desc = false, includeCold = false } = {}) {
    if (!this.hasData()) return [];
    const idx = this.loadIndex();
    const segments = (idx.segments || [])
      .filter(seg => this.#segmentMayContain(seg, beforeSeq, afterSeq))
      .slice()
      .sort((a, b) => desc ? (b.lastSeq || 0) - (a.lastSeq || 0) : (a.firstSeq || 0) - (b.firstSeq || 0));
    const out = [];
    for (const seg of segments) {
      const rows = this.#readSegment(seg.file, { beforeSeq, afterSeq, desc, includeCold });
      out.push(...applyFoldedMessageTombstones(rows, idx.foldedMessageIds));
    }
    return desc
      ? out.sort((a, b) => parseSeqFromId(b.id) - parseSeqFromId(a.id))
      : out.sort(compareMessagesBySeq);
  }

  /**
   * Read physical rows without applying reflection tombstones. Session cloning
   * needs the complete durable transcript, including rows hidden by folding.
   */
  readAllRaw({ includeCold = false } = {}) {
    if (!this.hasData()) return [];
    const idx = this.loadIndex();
    return (idx.segments || [])
      .slice()
      .sort((a, b) => (a.firstSeq || 0) - (b.firstSeq || 0))
      .flatMap(segment => this.#readSegment(segment.file, { includeCold }))
      .sort(compareMessagesBySeq);
  }

  *scan({ beforeSeq = Infinity, afterSeq = -Infinity, desc = false, includeCold = false, scanStats = null } = {}) {
    if (!this.hasData()) return;
    const idx = this.loadIndex();
    const segments = (idx.segments || [])
      .filter(seg => this.#segmentMayContain(seg, beforeSeq, afterSeq))
      .slice()
      .sort((a, b) => desc ? (b.lastSeq || 0) - (a.lastSeq || 0) : (a.firstSeq || 0) - (b.firstSeq || 0));
    for (const seg of segments) {
      const rows = this.#readSegment(seg.file, { beforeSeq, afterSeq, desc, includeCold });
      addScanMetric(scanStats, 'segments');
      addScanMetric(scanStats, 'bytes', Number(seg.bytes) || 0);
      addScanMetric(scanStats, 'rows', rows.length);
      yield* applyFoldedMessageTombstones(rows, idx.foldedMessageIds);
    }
  }

  count(kind = 'hot') {
    if (!this.hasData()) return 0;
    if (kind === 'all') {
      const idx = this.loadIndex();
      return Number(idx.totalMessages) || (idx.segments || []).reduce((sum, seg) => sum + (Number(seg.count) || 0), 0);
    }
    const rows = this.readAll({ includeCold: true });
    if (kind === 'cold') return rows.filter(m => m && m.cold === true).length;
    return rows.filter(m => m && m.cold !== true).length;
  }

  replaceAll(rows) {
    this.clear();
    for (const msg of (rows || []).filter(Boolean).sort(compareMessagesBySeq)) this.append(msg);
  }

  updateById(id, updater) {
    if (!id || typeof updater !== 'function' || !this.hasData()) return null;
    const targetSeq = parseSeqFromId(id);
    const idx = this.loadIndex();
    const segment = (idx.segments || []).find((candidate) => {
      const first = Number(candidate.firstSeq);
      const last = Number(candidate.lastSeq);
      return Number.isFinite(targetSeq)
        && Number.isFinite(first)
        && Number.isFinite(last)
        && targetSeq >= first
        && targetSeq <= last;
    });
    if (!segment?.file) return null;

    const path = join(this.segmentDir, segment.file);
    const rows = this.#readSegment(segment.file, { includeCold: true });
    const rowIndex = rows.findIndex(row => row?.id === id);
    if (rowIndex < 0) return null;
    const next = updater({ ...rows[rowIndex] });
    if (!next || typeof next !== 'object') return null;
    const updated = { ...next, id: rows[rowIndex].id };
    rows[rowIndex] = updated;
    const updatesAnchor = rowIndex === 0 && segment.file === idx.segments[0]?.file;

    const body = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
    writeAtomic(path, body);
    segment.bytes = Buffer.byteLength(body);
    idx.revision = (Number(idx.revision) || 0) + 1;
    this.#persistCurrentLineage({
      revision: idx.revision,
      anchor: updatesAnchor ? this.#lineageAnchorForLine(JSON.stringify(updated)) : undefined,
    });
    this.saveIndex();
    return updated;
  }

  markCold(id) {
    return this.updateById(id, msg => ({ ...msg, cold: true }));
  }

  clear() {
    if (existsSync(this.segmentDir)) {
      for (const f of readdirSync(this.segmentDir)) {
        if (f.endsWith('.jsonl')) unlinkSync(join(this.segmentDir, f));
      }
    }
    if (existsSync(this.indexPath)) unlinkSync(this.indexPath);
    this.lineage = { streamId: randomUUID(), revision: 0, anchor: null };
    this.#writeLineage(this.lineage);
    this.index = { ...emptySegmentIndex(), streamId: this.lineage.streamId };
    this.saveIndex();
  }

  #indexMatchesDisk(idx) {
    if (!existsSync(this.segmentDir)) return !(idx?.segments?.length > 0);
    const diskFiles = readdirSync(this.segmentDir).filter(file => file.endsWith('.jsonl')).sort();
    const indexedSegments = Array.isArray(idx?.segments) ? idx.segments : [];
    const indexedFiles = indexedSegments.map(segment => segment?.file).filter(Boolean).sort();
    if (diskFiles.length !== indexedFiles.length
        || diskFiles.some((file, index) => file !== indexedFiles[index])) return false;
    return indexedSegments.every(segment => {
      const path = join(this.segmentDir, segment.file);
      return existsSync(path) && statSync(path).size === Number(segment.bytes);
    });
  }

  #readLineage() {
    if (!existsSync(this.lineagePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.lineagePath, 'utf8') || '{}');
      if (!parsed || typeof parsed !== 'object'
          || typeof parsed.streamId !== 'string' || !parsed.streamId
          || !Number.isFinite(Number(parsed.revision))
          || (parsed.anchor !== null && typeof parsed.anchor !== 'string')) return null;
      return {
        streamId: parsed.streamId,
        revision: Math.max(0, Number(parsed.revision)),
        anchor: parsed.anchor,
      };
    } catch {
      return null;
    }
  }

  #writeLineage(lineage) {
    this.ensure();
    const normalized = {
      version: 1,
      streamId: lineage.streamId,
      revision: Math.max(0, Number(lineage.revision) || 0),
      anchor: typeof lineage.anchor === 'string' ? lineage.anchor : null,
    };
    writeAtomic(this.lineagePath, `${JSON.stringify(normalized, null, 2)}\n`);
    this.lineage = normalized;
    return normalized;
  }

  #currentLineageAnchor() {
    if (!existsSync(this.segmentDir)) return null;
    const files = readdirSync(this.segmentDir).filter(file => file.endsWith('.jsonl')).sort();
    for (const file of files) {
      const path = join(this.segmentDir, file);
      if (!existsSync(path)) continue;
      let raw;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (error) {
        if (isPermissionError(error)) return null;
        throw error;
      }
      for (const line of raw.split('\n')) {
        if (!parseJsonLine(line)) continue;
        return this.#lineageAnchorForLine(line);
      }
    }
    return null;
  }

  #lineageAnchorForLine(line) {
    return createHash('sha256').update(String(line || '').trim()).digest('hex');
  }

  #legacyLineageId(anchor) {
    return `legacy-${createHash('sha256')
      .update(this.rootDir)
      .update('\0')
      .update(anchor || '<empty>')
      .digest('hex')}`;
  }

  #resolveLineage(idx, { verifyAnchor = false } = {}) {
    const persisted = this.#readLineage();
    const anchor = !persisted || verifyAnchor ? this.#currentLineageAnchor() : persisted.anchor;
    if (!persisted) {
      const initialStreamId = anchor ? this.#legacyLineageId(anchor) : randomUUID();
      const indexStreamId = typeof idx?.streamId === 'string' && idx.streamId ? idx.streamId : null;
      // Missing sidecar is a rolling-upgrade boundary. Recompute from the
      // immutable first row for existing data. A truly empty store starts a
      // new random lifetime so delete + same-id recreation cannot collide.
      const streamId = verifyAnchor ? initialStreamId : (indexStreamId || initialStreamId);
      return this.#writeLineage({
        streamId,
        revision: Number.isFinite(Number(idx?.revision)) ? Number(idx.revision) : 0,
        anchor,
      });
    }
    if (persisted.anchor !== anchor) {
      // A reader/writer that predates lineage.json can still clear, recreate,
      // or rewrite the first durable row. The anchor detects that mutation
      // without relying on metadata fields the old index writer discards.
      return this.#writeLineage({ streamId: randomUUID(), revision: 0, anchor });
    }
    const indexRevision = (!idx?.streamId || idx.streamId === persisted.streamId)
      && Number.isFinite(Number(idx?.revision))
      ? Math.max(0, Number(idx.revision))
      : 0;
    const revision = Math.max(persisted.revision, indexRevision);
    if (revision !== persisted.revision) return this.#writeLineage({ ...persisted, revision });
    return persisted;
  }

  #persistCurrentLineage({ revision = null, anchor = undefined } = {}) {
    const current = this.lineage || this.#readLineage() || {
      streamId: this.index?.streamId || this.#legacyLineageId(this.#currentLineageAnchor()),
      revision: Number(this.index?.revision) || 0,
      anchor: this.#currentLineageAnchor(),
    };
    const nextRevision = Number.isFinite(Number(revision)) ? Number(revision) : current.revision;
    const nextAnchor = typeof anchor === 'string' && anchor ? anchor : current.anchor;
    const needsWrite = !this.lineage
      || current.revision !== nextRevision
      || current.anchor !== nextAnchor;
    const next = needsWrite
      ? this.#writeLineage({ ...current, revision: nextRevision, anchor: nextAnchor })
      : current;
    this.lineage = next;
    if (this.index) {
      this.index.streamId = next.streamId;
      this.index.revision = next.revision;
    }
    return next;
  }

  #normalizeIndex(idx) {
    const out = { ...emptySegmentIndex(), ...(idx || {}) };
    out.version = 2;
    out.streamId = typeof out.streamId === 'string' && out.streamId ? out.streamId : null;
    out.revision = Number.isFinite(Number(out.revision)) ? Math.max(0, Number(out.revision)) : 0;
    out.segments = Array.isArray(out.segments) ? out.segments.filter(s => s && s.file) : [];
    out.segments.sort((a, b) => (Number(a.firstSeq) || 0) - (Number(b.firstSeq) || 0));
    const maxSeq = out.segments.reduce((max, seg) => Math.max(max, Number(seg.lastSeq) || 0), 0);
    out.nextSeq = Math.max(Number(out.nextSeq) || 1, maxSeq + 1);
    out.activeSegment = out.activeSegment || out.segments[out.segments.length - 1]?.file || SEGMENT_FIRST_NAME;
    out.totalMessages = Number(out.totalMessages) || out.segments.reduce((sum, seg) => sum + (Number(seg.count) || 0), 0);
    out.foldedMessageIds = Array.isArray(out.foldedMessageIds)
      ? Array.from(new Set(out.foldedMessageIds.filter(id => typeof id === 'string' && id)))
      : [];
    return out;
  }

  #rebuildIndex() {
    const idx = emptySegmentIndex();
    if (!existsSync(this.segmentDir)) return idx;
    const files = readdirSync(this.segmentDir).filter(f => f.endsWith('.jsonl')).sort();
    for (const file of files) {
      const rows = this.#readSegment(file, { includeCold: true });
      if (rows.length === 0) continue;
      const seqs = rows.map(r => parseSeqFromId(r.id)).filter(Number.isFinite);
      const path = join(this.segmentDir, file);
      const seg = {
        file,
        firstSeq: Math.min(...seqs),
        lastSeq: Math.max(...seqs),
        count: rows.length,
        bytes: existsSync(path) ? statSync(path).size : 0,
      };
      idx.segments.push(seg);
      idx.totalMessages += rows.length;
      idx.foldedMessageIds.push(...foldedMessageIdsFrom(rows));
      idx.lastMessageId = rows[rows.length - 1]?.id || idx.lastMessageId;
      idx.nextSeq = Math.max(idx.nextSeq, seg.lastSeq + 1);
      idx.activeSegment = file;
    }
    idx.foldedMessageIds = Array.from(new Set(idx.foldedMessageIds));
    return idx;
  }

  #segmentMayContain(seg, beforeSeq, afterSeq) {
    const first = Number(seg.firstSeq);
    const last = Number(seg.lastSeq);
    if (Number.isFinite(beforeSeq) && Number.isFinite(first) && first >= beforeSeq) return false;
    if (Number.isFinite(afterSeq) && Number.isFinite(last) && last <= afterSeq) return false;
    return true;
  }

  #readSegment(file, { beforeSeq = Infinity, afterSeq = -Infinity, desc = false, includeCold = false } = {}) {
    const path = join(this.segmentDir, file);
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      const msg = parseJsonLine(line);
      if (!msg) continue;
      const seq = parseSeqFromId(msg.id);
      if (Number.isFinite(beforeSeq) && seq >= beforeSeq) continue;
      if (Number.isFinite(afterSeq) && seq <= afterSeq) continue;
      if (!includeCold && msg.cold === true) continue;
      rows.push(msg);
    }
    rows.sort(compareMessagesBySeq);
    return desc ? rows.reverse() : rows;
  }
}

// ─── ConversationStore ───────────────────────────────────────

/**
 * ConversationStore — persist and load messages to/from disk.
 *
 * Directory layout:
 *   chat/            — one-to-one chat mode history
 *     index.json
 *     segments/
 *     blobs/
 *   sessions/<sessionId>/conversation/
 *     index.json
 *     segments/
 *     blobs/
 *
 * Legacy compatibility: ~/.yeaft/conversation is read as an old mixed store,
 * and ~/.yeaft/groups/<sessionId>/conversation is read as an old session
 * transcript store. New writes are split by mode: records with sessionId go to
 * sessions/<sessionId>/conversation/, all others go to chat/.
 */
export class ConversationStore {
  #dir;         // root dir (e.g. ~/.yeaft)
  #chatDir;     // ~/.yeaft/chat
  #sessionsDir; // ~/.yeaft/sessions — primary Session transcript store
  #legacySessionsDir; // ~/.yeaft/groups — read-only legacy Session transcripts
  #legacyConvDir; // ~/.yeaft/conversation (read-only compatibility)
  #convDir;     // default thread dir root: ~/.yeaft/chat
  #msgDir;      // default hot messages dir: ~/.yeaft/chat/messages
  #coldDir;     // default cold messages dir: ~/.yeaft/chat/cold
  #indexPath;   // ~/.yeaft/chat/index.md
  #chatMsgDir;
  #chatColdDir;
  #legacyMsgDir;
  #legacyColdDir;
  #nextSeq;     // next message sequence number across chat/session/legacy
  #nextSeqByThread; // Map<threadId, number> — per-thread counters (task-314)

  /**
   * @param {string} dir — Yeaft root directory (e.g. ~/.yeaft)
   */
  constructor(dir) {
    this.#dir = dir;
    this.#chatDir = join(dir, 'chat');
    this.#sessionsDir = join(dir, 'sessions');
    this.#legacySessionsDir = join(dir, 'groups');
    this.#legacyConvDir = join(dir, 'conversation');

    this.#convDir = this.#chatDir;
    this.#msgDir = join(this.#chatDir, 'messages');
    this.#coldDir = join(this.#chatDir, 'cold');
    this.#indexPath = join(this.#chatDir, 'index.md');

    this.#chatMsgDir = this.#msgDir;
    this.#chatColdDir = this.#coldDir;
    this.#legacyMsgDir = join(this.#legacyConvDir, 'messages');
    this.#legacyColdDir = join(this.#legacyConvDir, 'cold');

    this.#nextSeq = null;
    this.#nextSeqByThread = new Map();

    // Ensure new chat and session-root directories exist (graceful on permission
    // errors). Per-session conversation directories are created lazily once a
    // sessionId is known. Legacy directories are never created by new versions.
    for (const d of [
      this.#chatDir, join(this.#chatDir, 'blobs'), join(this.#chatDir, SEGMENT_DIR), this.#chatMsgDir, this.#chatColdDir,
      this.#sessionsDir,
    ]) {
      try {
        if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 });
      } catch (err) {
        if (isPermissionError(err)) {
          if (!_permissionWarned) {
            console.warn(`[Yeaft] Cannot create directory ${d}: ${err.code} — persistence disabled`);
            _permissionWarned = true;
          }
        } else {
          throw err;
        }
      }
    }
  }

  // ─── Write API ──────────────────────────────────────────

  #markDirty(message, reason, sourceIds = null) {
    const sessionId = message?.sessionId || null;
    try {
      markConversationDirty({
        ownerRoot: this.#dir,
        scopeKind: sessionId ? 'session' : 'chat',
        scopeId: sessionId || message?.chatId || '*',
        reason,
        sourceIds,
      });
    } catch (error) {
      if (!_historyIndexMutationWarned) {
        console.warn(`[Yeaft] Cannot mark conversation index dirty: ${error?.message || error}`);
        _historyIndexMutationWarned = true;
      }
    }
  }

  #markAllDirty(reason) {
    try {
      markConversationDirty({
        ownerRoot: this.#dir,
        scopeKind: 'session',
        scopeId: '*',
        reason,
      });
    } catch (error) {
      if (!_historyIndexMutationWarned) {
        console.warn(`[Yeaft] Cannot mark conversation index dirty: ${error?.message || error}`);
        _historyIndexMutationWarned = true;
      }
    }
  }

  /**
   * Append a single message to the conversation.
   *
   * @param {object} msg — { role, content, mode?, model?, turnNumber?, toolCalls?, toolCallId?, isError? }
   * @returns {object} — the persisted message with id assigned
   */
  append(msg) {
    const seq = this.#getNextSeq();
    const id = `m${String(seq).padStart(4, '0')}`;
    const fullMsg = {
      ...msg,
      id,
      time: msg.time || new Date().toISOString(),
      tokens_est: msg.tokens_est || estimateTokens(msg.content || ''),
    };

    try {
      this.#segmentStoreFor(fullMsg, { create: true }).append(fullMsg);
    } catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot write message ${id}: ${err.code} — message not persisted`);
          _permissionWarned = true;
        }
        return fullMsg; // Return the message but don't persist
      }
      throw err;
    }

    this.#nextSeq = seq + 1;
    if (fullMsg._reflection || (
      (fullMsg.role === 'user' || fullMsg.role === 'assistant')
      && isVisibleConversationRow(fullMsg)
    )) {
      this.#markDirty(fullMsg, fullMsg._reflection ? 'fold' : 'append', [
        fullMsg.id,
        ...(Array.isArray(fullMsg.foldedMessageIds) ? fullMsg.foldedMessageIds : []),
      ]);
    }

    return fullMsg;
  }

  /**
   * Append multiple messages at once.
   *
   * @param {object[]} messages
   * @returns {object[]} — persisted messages with ids
   */
  appendBatch(messages) {
    return messages.map(m => this.append(m));
  }

  /**
   * Replace fields on one persisted message while preserving its id/order.
   * Rewrites only the owning conversation segment set; used for async tool
   * results that complete after their initial tool row was appended.
   *
   * @param {object} message — persisted row returned by append()
   * @param {object} patch — fields to merge into the row
   * @returns {object|null}
   */
  update(message, patch) {
    if (!message?.id || !patch || typeof patch !== 'object') return null;
    try {
      const store = this.#segmentStoreFor(message, { create: false });
      let before = null;
      const updated = store.updateById(message.id, current => {
        before = { ...current };
        return { ...current, ...patch };
      });
      const affectsCanonicalProjection = row => !!row && (
        row._reflection
        || ((row.role === 'user' || row.role === 'assistant')
          && isVisibleConversationRow(row))
      );
      if (updated && (affectsCanonicalProjection(before) || affectsCanonicalProjection(updated))) {
        this.#markDirty(updated, 'update', [message.id]);
      }
      return updated;
    } catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot update message ${message.id}: ${err.code}`);
          _permissionWarned = true;
        }
        return null;
      }
      throw err;
    }
  }

  /**
   * Atomically publish a logical range replacement for tool folding.
   *
   * The original rows stay append-only on disk. A single reflection row owns
   * their ids as tombstones, so readers either observe the complete old arc or
   * the complete reflection — never a half-rewritten tool pair.
   *
   * @param {object[]} messages — persisted rows being folded
   * @param {object} reflection — synthetic `_reflection` user row
   * @returns {object|null}
   */
  foldMessages(messages, reflection) {
    const foldedMessageIds = Array.from(new Set(
      (messages || []).map(message => message?.id).filter(id => typeof id === 'string' && id),
    ));
    if (foldedMessageIds.length === 0 || !reflection || reflection._reflection !== true) return null;
    return this.append({ ...reflection, foldedMessageIds });
  }

  /**
   * Move a message from hot (messages/) to cold (cold/).
   *
   * @param {string} id — message id (e.g. "m0355")
   */
  moveToCold(id) {
    for (const dir of [this.#chatDir, ...this.#sessionConversationDirs({ primaryOnly: true })]) {
      const moved = this.#segmentStoreForConversationDir(dir).markCold(id);
      if (moved) return;
    }
    for (const [hotDir, coldDir] of this.#hotColdDirPairs({ includeLegacy: false })) {
      const src = join(hotDir, `${id}.md`);
      const dst = join(coldDir, `${id}.md`);
      if (!existsSync(src)) continue;
      try {
        renameSync(src, dst);

      } catch (err) {
        if (isPermissionError(err)) {
          if (!_permissionWarned) {
            console.warn(`[Yeaft] Cannot move message ${id} to cold: ${err.code}`);
            _permissionWarned = true;
          }
        } else {
          throw err;
        }
      }
      return;
    }
  }

  /**
   * Move multiple messages to cold.
   *
   * @param {string[]} ids
   */
  moveToColdBatch(ids) {
    for (const id of ids) {
      this.moveToCold(id);
    }
  }

  /**
   * Sanitize one id into a safe directory component.
   * Anything outside `[A-Za-z0-9._-]` collapses to `_`; max 120 chars.
   *
   * @param {string} s
   * @returns {string}
   */
  #safeIdComponent(s) {
    return String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  }

  #safeDirComponent(s) {
    const safe = this.#safeIdComponent(s).replace(/^\.+$/, '_');
    return safe || '_';
  }

  /**
   * Update the conversation index.md with current state.
   *
   * @param {{ totalMessages?: number, lastMessageId?: string }} info
   */
  updateIndex(info = {}) {
    const total = info.totalMessages ?? this.countHot() + this.countCold();
    const lastId = info.lastMessageId ?? null;
    const lastAccessed = new Date().toISOString();

    const content = [
      '---',
      `lastMessageId: ${lastId || 'null'}`,
      `totalMessages: ${total}`,
      `hotMessages: ${this.countHot()}`,
      `coldMessages: ${this.countCold()}`,
      `lastAccessed: ${lastAccessed}`,
      '---',
      '',
      '# Conversation Index',
      '',
      'This file tracks the conversation state for the "one eternal conversation" model.',
    ].join('\n');

    try {
      writeFileSync(this.#indexPath, content, { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot write conversation index: ${err.code}`);
          _permissionWarned = true;
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Clear all persisted transcript messages (hot + cold).
   */
  clear() {
    for (const dir of [this.#chatMsgDir, this.#chatColdDir, ...this.#sessionMessageDirs('messages'), ...this.#sessionMessageDirs('cold')]) {
      if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
          if (file.endsWith('.md')) {
            try {
              unlinkSync(join(dir, file));
            } catch (err) {
              if (!isPermissionError(err)) throw err;
            }
          }
        }
      }
    }
    for (const dir of [this.#chatDir, ...this.#sessionConversationDirs({ primaryOnly: true })]) {
      this.#segmentStoreForConversationDir(dir).clear();
    }
    this.#nextSeq = 1;
    this.updateIndex({ totalMessages: 0, lastMessageId: null });
    this.#markAllDirty('clear');
  }


  // ─── Read API ───────────────────────────────────────────

  /**
   * Return the durable identity of one Session transcript. `streamId`
   * changes on clear/recreate; `revision` changes on append/update/fold.
   * Browser caches use both values to detect non-append mutations before
   * trusting an `afterSeq` delta cursor.
   */
  getSessionHistoryMetadata(sessionId) {
    if (!sessionId) return null;
    const store = this.#segmentStoreForConversationDir(this.#sessionConversationDir(sessionId));
    return store.metadata();
  }

  /**
   * Load recent hot messages, sliced to the last `turnsLimit` TURNS and
   * sorted chronologically.
   *
   * Turn-based (not message-based) slicing is the contract here. A "turn"
   * is one user-prompt round-trip — multi-VP fan-out emits N user
   * messages for the same prompt, all of which collapse into ONE turn.
   * `sliceLastNTurns` cuts at a user-message boundary, so an
   * `[assistant(toolCalls), tool…]` arc is never split across the cut.
   *
   * `pairSanitize` runs as a defensive secondary pass — turn-boundary
   * cuts are already pair-safe, but historical / hand-edited stores may
   * contain orphans, and `pairSanitize` is idempotent.
   *
   * Back-compat: callers that pass `Infinity` (or a negative number) get
   * the full hot history. `0` returns `[]`.
   *
   * @param {number} [turnsLimit=DEFAULT_RECENT_TURNS] — max turns to load
   * @returns {object[]} — parsed message objects
   */
  loadRecent(turnsLimit = DEFAULT_RECENT_TURNS) {
    const all = this.#loadChatMessages();
    if (turnsLimit === Infinity || turnsLimit < 0) return pairSanitize(all);
    return pairSanitize(sliceLastNTurns(all, turnsLimit));
  }

  /**
   * Load all hot messages.
   *
   * @returns {object[]}
   */
  loadAll() {
    return this.#loadAllMessages();
  }

  /**
   * Load recent hot messages stamped with `sessionId`, sliced to the last
   * `turnsLimit` TURNS and sorted chronologically.
   *
   * Group-history-isolation (Bug 7): a message lives in exactly one
   * group. Messages without a `sessionId` frontmatter (legacy / pre-
   * grouping) are NOT returned — they would otherwise leak into every
   * group's stream.
   *
   * Turn-based slicing (2026-05-01): we used to take the last N
   * messages, which can land mid-arc and orphan a tool_use/tool_result
   * pair (the Anthropic / Chat-Completions adapter then 400s on the
   * orphan). Switching to `sliceLastNTurns` always cuts at a user-
   * message boundary — multi-VP `@vp-X` variants of the same canonical
   * prompt collapse into ONE turn, so a fan-out turn is kept whole.
   *
   * `pairSanitize` runs as a belt-and-suspenders second pass: turn-
   * boundary cuts are pair-safe by construction, but if a hand-edited
   * store somehow contains pre-existing orphans we drop them anyway.
   *
   * Implementation note: this walks session files newest-to-oldest and stops
   * once it has the requested turn window plus proof of an older turn. Do not
   * replace this with `#loadSessionMessages()`; that full synchronous parse is
   * exactly what can starve websocket heartbeat on large sessions.
   *
   * @param {string} sessionId — required; null/empty returns []
   * @param {number} [turnsLimit=DEFAULT_RECENT_TURNS]
   * @param {{includeReflections?: boolean, beforeSeq?: number}} [options]
   *   beforeSeq anchors the window before a durable user row (exclusive), so
   *   later queued inputs cannot displace that query's history.
   * @returns {object[]}
   */
  loadRecentBySession(sessionId, turnsLimit = DEFAULT_RECENT_TURNS, { includeReflections = false, beforeSeq = Infinity } = {}) {
    if (!sessionId) return [];
    if (turnsLimit === Infinity || turnsLimit < 0) {
      const all = this.#loadSessionMessages(sessionId);
      const filtered = all.filter(m => m && m.sessionId === sessionId
        && (!Number.isFinite(beforeSeq) || parseSeqFromId(m.id) < beforeSeq)
        && (!isHiddenConversationRow(m) || (includeReflections && m._reflection === true)));
      return pairSanitize(filtered);
    }
    if (!(turnsLimit > 0)) return [];

    const { messages, truncated } = this.#loadRecentSessionWindow(sessionId, turnsLimit, {
      roles: null,
      includeReflections,
      beforeSeq: Number.isFinite(beforeSeq) ? beforeSeq : Infinity,
    });
    if (truncated) {
      maybeWarnHistoryTruncated(sessionId, this.#dir, turnsLimit);
    }
    return pairSanitize(messages);
  }

  /**
   * Provider-only chronological history. UI pages deliberately cap raw rows;
   * that cap is not a turn limit and must not truncate a tool-heavy query's
   * context. Yield between bounded scan batches; never mutate the transcript.
   * Stable user identities, not equal prompt text, define human turns.
   * @returns {Promise<object[]>} Complete past turns before the durable user fence.
   */
  async loadProviderHistoryBySession(sessionId, turnsLimit = 20, { beforeSeq = Infinity } = {}) {
    if (!sessionId || !(turnsLimit > 0)) return [];
    const kept = [];
    const pending = [];
    const identities = new Set();
    let scanned = 0;
    let bytes = 0;
    for (const row of this.#iterateSessionRows(sessionId, { beforeSeq, desc: true })) {
      scanned += 1;
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (scanned > 32768 || bytes > 64 * 1024 * 1024) {
        const error = new Error('Recent history scan limit reached before completing the requested turn window');
        error.code = 'HISTORY_RECENT_SCAN_LIMIT';
        throw error;
      }
      if (scanned % 64 === 0) await new Promise(resolve => setImmediate(resolve));
      if (!row || row.sessionId !== sessionId || isHiddenConversationRow(row)) continue;
      if (row.role === 'user') {
        const identity = row.clientMessageId ? `client:${row.clientMessageId}` : `message:${row.id}`;
        identities.add(identity);
        kept.push(...pending.splice(0), row);
        // The requested oldest user closes the reverse scan. Do not read the
        // previous turn's tool tail just to discover one more user boundary.
        if (identities.size >= turnsLimit) break;
      } else pending.push(row);
    }
    // Pending rows without their opening user are not a complete past turn.
    return pairSanitize(kept.reverse());
  }

  /**
   * Load every hot message stamped with `sessionId`.
   *
   * @param {string} sessionId
   * @returns {object[]}
   */
  loadAllBySession(sessionId) {
    return this.loadRecentBySession(sessionId, Infinity);
  }

  /**
   * Copy the complete durable transcript to a new Session identity.
   *
   * Unlike visible history readers, this includes cold rows, internal rows,
   * reflections, and the rows hidden by reflection tombstones. New persisted
   * message ids are allocated in original order. References that point to a
   * copied persisted message are remapped; external/client/tool identities are
   * intentionally preserved.
   *
   * @returns {{ copiedCount: number, idMap: Map<string, string> }}
   */
  copySession(sourceSessionId, targetSessionId) {
    if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) {
      return { copiedCount: 0, idMap: new Map() };
    }
    const primary = this.#segmentStoreForConversationDir(this.#sessionConversationDir(sourceSessionId));
    const segmentedRows = primary.readAllRaw({ includeCold: true });
    const legacyRows = this.#sessionFileEntries('all', sourceSessionId)
      .map(entry => {
        try { return this.readMessageFile(entry.path); } catch (err) {
          if (isPermissionError(err)) return null;
          throw err;
        }
      })
      .filter(Boolean);
    // Migration can temporarily leave the same durable row in both the legacy
    // markdown layout and the segment store. Preserve legacy-only rows, but let
    // the canonical segment copy win when both contain the same persisted id.
    const rowsById = new Map();
    for (const row of [...legacyRows, ...segmentedRows]) {
      if (row?.sessionId !== sourceSessionId || typeof row.id !== 'string' || !row.id) continue;
      rowsById.set(row.id, row);
    }
    const rows = [...rowsById.values()].sort(compareMessagesBySeq);
    if (rows.length === 0) return { copiedCount: 0, idMap: new Map() };

    const firstSeq = this.#getNextSeq();
    const idMap = new Map(rows.map((row, index) => [
      row.id,
      `m${String(firstSeq + index).padStart(4, '0')}`,
    ]));
    const remapId = id => idMap.get(id) || id;
    const copies = rows.map(row => {
      const copy = { ...row, sessionId: targetSessionId };
      delete copy.id;
      if (idMap.has(row.causalRootId)) copy.causalRootId = remapId(row.causalRootId);
      if (Array.isArray(row.foldedMessageIds)) {
        copy.foldedMessageIds = row.foldedMessageIds.map(remapId);
      }
      if (Array.isArray(row.sourceMessageIds)) {
        copy.sourceMessageIds = row.sourceMessageIds.map(remapId);
      }
      if (row.cold === true) delete copy.cold;
      return copy;
    });
    const written = this.appendBatch(copies);
    for (let index = 0; index < written.length; index += 1) {
      if (rows[index].cold === true) this.moveToCold(written[index].id);
    }

    // append() intentionally treats permission failures as best-effort for live
    // chat. A Session copy cannot: reporting success with a partial transcript
    // would make the new Session irrecoverably incomplete. Verify the target's
    // physical rows before the higher-level CRUD operation commits the clone.
    const target = this.#segmentStoreForConversationDir(this.#sessionConversationDir(targetSessionId));
    const persistedIds = new Set(target.readAllRaw({ includeCold: true }).map(row => row.id));
    const expectedIds = [...idMap.values()];
    if (written.length !== rows.length
        || persistedIds.size !== expectedIds.length
        || expectedIds.some(id => !persistedIds.has(id))) {
      throw new Error(`Session transcript copy incomplete: expected ${rows.length}, persisted ${persistedIds.size}`);
    }
    return { copiedCount: written.length, idMap };
  }

  /**
   * VP-scoped view of Session history, used to build a pair-safe provider
   * snapshot for one VP. It operates on what the VP can actually see, not
   * the union of every VP's tool calls/results.
   *
   * The rule we settled on (with the user, 2026-06-01):
   *
   *   - User rows (no speakerVpId): KEEP — every VP sees the prompt.
   *   - This VP's own assistant rows + their paired tool rows: KEEP.
   *   - OTHER VPs' assistant rows: KEEP TEXT ONLY (strip toolCalls AND
   *     thinkingBlocks — thinking is VP-private per Anthropic's signed-
   *     block contract and would never appear in another VP's context).
   *   - OTHER VPs' tool result rows (role:'tool'): DROP — they pair with
   *     stripped tool_use ids and would orphan on replay.
   *   - Hidden conversation rows (`_reflection`, `internal`, `systemOnly`,
   *     `systemOnlyMessage`, and legacy internal-control content signatures):
   *     DROP — they are engine-private and never enter
   *     visible history or another VP's context.
   *
   * The output is pair-safe by construction for THIS VP's tool arcs and
   * carries only summary-relevant text for the other VPs.
   *
   * @param {string} sessionId
   * @param {string} vpId
   * @returns {object[]}
   */
  loadSessionHistoryForVp(sessionId, vpId) {
    if (!sessionId || !vpId) return [];
    const all = this.#loadSessionMessages(sessionId);
    const foldedIds = foldedMessageIdsFrom(all);
    const out = [];
    for (const m of all) {
      if (!m || m.sessionId !== sessionId || foldedIds.has(m.id)) continue;
      if (m._reflection === true) {
        out.push(m);
        continue;
      }
      if (isHiddenConversationRow(m)) continue;
      if (m.role === 'user') {
        out.push(m);
        continue;
      }
      if (m.role === 'assistant') {
        if (m.speakerVpId === vpId) {
          out.push(m);
        } else {
          // Other VP's assistant text only — drop their toolCalls so the
          // following role:'tool' rows (which we also drop) don't leave
          // orphan tool_use ids in the provider input.
          const copy = { ...m };
          delete copy.toolCalls;
          delete copy.thinkingBlocks;
          delete copy.providerState;
          out.push(copy);
        }
        continue;
      }
      if (m.role === 'tool') {
        // Tool results belong to the assistant turn that emitted the
        // tool_use. Only keep ours; other VPs' results were dropped via
        // their assistant's stripped toolCalls.
        if (m.speakerVpId === vpId) out.push(m);
        continue;
      }
    }
    // Do not truncate here. The provider-request history window owns
    // deterministic budget trimming after this VP-scoped view is built.
    return pairSanitize(out);
  }

  /**
   * Pagination-cursor read: load the page of `turnsLimit` TURNS that ends
   * just before `beforeSeq` (exclusive) for the given `sessionId`. Used by
   * the Yeaft "Load older messages" UI to walk backwards through history
   * one click at a time.
   *
   * Crucially, this scans BOTH hot (`messages/`) and cold (`cold/`) dirs
   * — `#getNextSeq` is global across both, and `moveToCold` is a `rename`
   * that never reseqs, so cold ids are strictly < hot ids and a flat
   * `[...cold, ...hot]` concat is already chronological. Crossing the
   * hot→cold boundary is therefore transparent to the caller.
   *
   * `hasMore` is computed in TURNS (not raw message count). It's true iff
   * the slice we returned still leaves an earlier turn boundary unread in
   * the filtered prefix — i.e. there's at least one more page to fetch.
   *
   * `pairSanitize` runs as a defensive secondary pass. Turn-boundary cuts
   * are already pair-safe, but historical / hand-edited stores may
   * contain orphan tool_use/tool_result pairs.
   *
   * @param {string} sessionId — required; null/empty returns empty result
   * @param {number|null} beforeSeq — exclusive upper bound on message
   *   sequence id. Special cases:
   *   - `null` / `undefined` / non-finite (e.g. `Infinity`, `NaN`) → start
   *     from the newest (no upper bound).
   *   - `0` is a VALID finite cutoff that excludes everything (since seqs
   *     start at 1). Distinct from `null`. A caller writing
   *     `loadOlderBySession(g, store.firstSeq || 0, ...)` will silently get
   *     an empty page — pass `null` if you mean "from newest".
   * @param {number} [turnsLimit=DEFAULT_RECENT_TURNS] — max turns per page
   * @returns {{ messages: object[], oldestSeq: number|null, hasMore: boolean }}
   */
  loadOlderBySession(sessionId, beforeSeq, turnsLimit = DEFAULT_RECENT_TURNS) {
    if (!sessionId) return { messages: [], oldestSeq: null, hasMore: false };
    const cutoff = Number.isFinite(beforeSeq) ? beforeSeq : Infinity;
    const prefix = this.#readSessionRows(sessionId, { beforeSeq: cutoff })
      .filter(m => m && m.sessionId === sessionId && isVisibleConversationRow(m));
    if (prefix.length === 0) return { messages: [], oldestSeq: null, hasMore: false };
    const sliced = pairSanitize(sliceLastNTurns(prefix, turnsLimit));
    // Turn-based hasMore: there's an EARLIER turn boundary we didn't keep.
    // Compare seqs (not object identity) — pairSanitize / sliceLastNTurns
    // return references today, but a future normalization pass that clones
    // rows would silently flip identity-compare to always-true.
    const oldestSlicedSeq = sliced.length ? parseSeqFromId(sliced[0].id) : NaN;
    const oldestPrefixSeq = parseSeqFromId(prefix[0].id);
    const hasMore = sliced.length > 0
      && Number.isFinite(oldestSlicedSeq)
      && Number.isFinite(oldestPrefixSeq)
      && oldestSlicedSeq > oldestPrefixSeq;
    // Defend the cursor at the source: a malformed id surfaces as NaN here
    // and a NaN cursor would round-trip back as a poison `beforeSeq` that
    // degrades to "give me the newest page again".
    const oldestSeq = Number.isFinite(oldestSlicedSeq) ? oldestSlicedSeq : null;
    return { messages: sliced, oldestSeq, hasMore };
  }

  /**
   * Visible UI pagination read for one group. Unlike `loadOlderBySession`, this
   * projects out internal/reflection/system rows BEFORE applying the turn
   * window, so a dense run of hidden metadata cannot force the first screen to
   * scan and materialize the group's entire history in the web bridge.
   *
   * @param {string} sessionId
   * @param {number|null} beforeSeq — exclusive upper bound, or null for newest
   * @param {number} [turnsLimit=DEFAULT_RECENT_TURNS]
   * @returns {{ messages: object[], oldestSeq: number|null, hasMore: boolean }}
   */
  loadVisibleBySession(sessionId, beforeSeq, turnsLimit = DEFAULT_RECENT_TURNS, opts = {}) {
    if (!sessionId || !(turnsLimit > 0)) return { messages: [], oldestSeq: null, hasMore: false };

    const cutoff = Number.isFinite(beforeSeq) ? beforeSeq : Infinity;
    const stopAtSeq = Number.isFinite(opts.stopAtSeq) ? Math.max(1, opts.stopAtSeq) : null;
    const page = this.#loadRecentSessionWindow(sessionId, turnsLimit, {
      beforeSeq: cutoff,
      afterSeq: stopAtSeq === null ? -Infinity : stopAtSeq - 1,
      roles: null,
      visibleOnly: true,
    });
    const messages = projectVisibleSessionMessages(page.messages);
    if (messages.length === 0) {
      const nextBeforeSeq = Number.isFinite(page.nextBeforeSeq) ? page.nextBeforeSeq : null;
      return {
        messages: [],
        oldestSeq: null,
        nextBeforeSeq,
        hasMore: page.truncated && (stopAtSeq === null || nextBeforeSeq > stopAtSeq),
      };
    }

    const oldestSeq = messages.length ? parseSeqFromId(messages[0].id) : null;
    return {
      messages,
      oldestSeq: Number.isFinite(oldestSeq) ? oldestSeq : null,
      nextBeforeSeq: Number.isFinite(page.nextBeforeSeq)
        ? Math.min(page.nextBeforeSeq, oldestSeq)
        : (Number.isFinite(oldestSeq) ? oldestSeq : null),
      hasMore: page.truncated && (stopAtSeq === null || oldestSeq > stopAtSeq),
    };
  }

  /**
   * Load messages strictly after a seq cursor, ordered by seq ascending.
   * Used by the web client to fetch "everything new since my latest known
   * message" when re-entering a session — the delta path.
   *
   * `latestSeq` is the newest seq the client may safely keep as its tail
   * cursor. When no visible rows changed after `afterSeq`, keep the cursor at
   * least at `afterSeq` so an empty delta still completes the in-flight sync
   * without downgrading the client to a cursor-less loaded state. Hidden rows
   * advance the cursor only at pair-safe boundaries; a cursor must never cross
   * an assistant tool call before all of that call's result rows are included.
   * Both row and byte budgets cut only at those safe boundaries. `hasMoreAfter`
   * tells the Web client to keep draining long offline gaps without waiting for
   * another reconnect or Session activation.
   *
   * @param {string} sessionId
   * @param {number|null} afterSeq — exclusive lower bound
   * @param {{ limit?: number, maxBytes?: number }} [opts]
   * @returns {{ messages: object[], latestSeq: number|null, hasMoreAfter: boolean }}
   */
  loadAfterSeqByGroup(sessionId, afterSeq, opts = {}) {
    if (!sessionId) return { messages: [], latestSeq: null, hasMoreAfter: false };
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 500;
    const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : Infinity;
    const cutoff = Number.isFinite(afterSeq) && afterSeq >= 0 ? afterSeq : null;
    if (cutoff === null) return { messages: [], latestSeq: null, hasMoreAfter: false };
    const after = [];
    const pendingToolResultIds = new Set();
    const completedBeforeCursor = new Set();
    const boundaryAssistants = [];
    let boundaryLookbackRows = 0;
    for (const previous of this.#iterateSessionRows(sessionId, { beforeSeq: cutoff + 1, desc: true })) {
      if (!previous || previous.sessionId !== sessionId) continue;
      boundaryLookbackRows += 1;
      if (boundaryLookbackRows > DELTA_TOOL_PAIR_EXTENSION_CAP) break;
      if (isHiddenConversationRow(previous)) continue;
      if (previous.role === 'tool' && typeof previous.toolCallId === 'string') {
        completedBeforeCursor.add(previous.toolCallId);
        continue;
      }
      if (previous.role === 'assistant' && Array.isArray(previous.toolCalls) && previous.toolCalls.length > 0) {
        const pendingIds = previous.toolCalls
          .map(toolCall => toolCall?.id)
          .filter(toolCallId => typeof toolCallId === 'string'
            && toolCallId
            && !completedBeforeCursor.has(toolCallId));
        if (pendingIds.length > 0) boundaryAssistants.push({ message: previous, pendingIds });
        continue;
      }
      if (previous.role === 'user') break;
    }
    boundaryAssistants.sort((a, b) => compareMessagesBySeq(a.message, b.message));
    for (const boundary of boundaryAssistants) {
      after.push(boundary.message);
      for (const toolCallId of boundary.pendingIds) pendingToolResultIds.add(toolCallId);
    }
    const earliestBoundarySeq = boundaryAssistants.length > 0
      ? parseSeqFromId(boundaryAssistants[0].message.id)
      : null;
    let safeCursorSeq = Number.isFinite(earliestBoundarySeq)
      ? Math.max(0, earliestBoundarySeq - 1)
      : cutoff;
    let visibleRows = after.length;
    let visibleBytes = after.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0);
    let stoppedAtBudget = false;
    let extensionRows = 0;
    const deltaRows = this.#iterateSessionRows(sessionId, { afterSeq: cutoff, desc: false });
    while (true) {
      const step = deltaRows.next();
      if (step.done) break;
      const m = step.value;
      if (!m || m.sessionId !== sessionId) continue;
      const seq = parseSeqFromId(m.id);
      const hidden = !isVisibleConversationRow(m);
      if (!hidden) {
        // Keep every outstanding call open across interleaved VP rows. Session
        // persistence is globally sequenced, so a sibling VP may append visible
        // messages between an assistant call and that call's result.
        after.push(m);
        visibleRows += 1;
        visibleBytes += Buffer.byteLength(JSON.stringify(m));
        if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
          for (const toolCall of m.toolCalls) {
            if (typeof toolCall?.id === 'string' && toolCall.id) pendingToolResultIds.add(toolCall.id);
          }
        } else if (m.role === 'tool' && typeof m.toolCallId === 'string') {
          pendingToolResultIds.delete(m.toolCallId);
        }
      }
      if (pendingToolResultIds.size === 0 && Number.isFinite(seq)) {
        safeCursorSeq = seq;
        if (visibleRows >= limit || visibleBytes >= maxBytes) {
          stoppedAtBudget = true;
          break;
        }
      }
      if (visibleRows < limit && visibleBytes < maxBytes) continue;
      extensionRows += 1;
      if (extensionRows >= DELTA_TOOL_PAIR_EXTENSION_CAP) {
        stoppedAtBudget = true;
        break;
      }
    }
    // If the extension cap stopped inside a malformed arc, return only the
    // prefix covered by the safe cursor. Returning later rows with an earlier
    // cursor would make the next delta repeat visible messages unnecessarily.
    const pairSafeRows = pendingToolResultIds.size === 0
      ? after
      : after.filter(message => {
          const seq = parseSeqFromId(message?.id);
          return Number.isFinite(seq) && seq <= safeCursorSeq;
        });
    const sliced = pairSanitize(pairSafeRows);
    let hasMoreAfter = false;
    if (stoppedAtBudget) {
      hasMoreAfter = !deltaRows.next().done;
    } else if (typeof deltaRows.return === 'function') {
      deltaRows.return();
    }
    // Never advance past a row the sanitizer had to drop. A malformed or
    // over-cap tool arc must be retried from its assistant call rather than
    // turning the following result into a permanent orphan on the next page.
    return {
      messages: projectVisibleSessionMessages(sliced),
      latestSeq: safeCursorSeq,
      hasMoreAfter,
    };
  }

  /**
   * Convenience: extract the numeric seq embedded in a message id.
   *
   * @param {string} messageId
   * @returns {number|null}
   */
  getMessageSeqById(messageId) {
    if (!messageId || typeof messageId !== 'string') return null;
    const seq = parseSeqFromId(messageId);
    return Number.isFinite(seq) ? seq : null;
  }

  /**
   * Return every canonical visible entry newest-first. This is the single read
   * model used by JSONL fallback search and the rebuildable SQLite worker.
   *
   * @param {string} sessionId
   * @param {{ scanStats?: object }} [opts]
   * @returns {object[]}
   */
  *iterateCanonicalVisibleEntriesBySession(sessionId, opts = {}) {
    if (!sessionId) return;
    yield* this.#iterateVisibleResponseEntries(sessionId, { scanStats: opts.scanStats });
  }

  loadCanonicalVisibleEntriesBySession(sessionId, opts = {}) {
    return Array.from(this.iterateCanonicalVisibleEntriesBySession(sessionId, opts));
  }

  /**
   * Search user-visible messages inside one Session. The scan is newest-first
   * and stops as soon as one page plus a `hasMore` sentinel is found, so a
   * common recent hit does not materialize the full transcript.
   *
   * @param {string} sessionId
   * @param {string} query
   * @param {{ limit?: number, beforeSeq?: number|null, senderKey?: string, scanStats?: object }} [opts]
   * @returns {{ results: object[], hasMore: boolean, nextBeforeSeq: number|null }}
   */
  searchVisibleBySession(sessionId, query, opts = {}) {
    const needle = normalizeLiteralSearch(typeof query === 'string' ? query.trim() : '');
    const senderKey = typeof opts.senderKey === 'string' ? opts.senderKey : '';
    if (!sessionId || (needle.length < 2 && !senderKey)) return { results: [], hasMore: false, nextBeforeSeq: null };

    const limit = Math.min(50, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 20));
    const beforeSeq = Number.isFinite(opts.beforeSeq) ? opts.beforeSeq : Infinity;
    const results = [];
    let hasMore = false;

    for (const entry of this.#iterateVisibleResponseEntries(sessionId, { beforeSeq, scanStats: opts.scanStats })) {
      const senderMatches = senderKey === 'user'
        ? entry.role === 'user'
        : (senderKey.startsWith('vp:')
          ? entry.role === 'assistant' && entry.speakerVpId === senderKey.slice(3)
          : true);
      if (!senderMatches) continue;
      const text = entry.textParts.join(' ');
      const matchIndex = needle ? findLiteralSearch(text, needle) : 0;
      if (matchIndex < 0) continue;
      if (results.length >= limit) {
        hasMore = true;
        break;
      }
      results.push({
        ...this.#projectVisibleResponseEntry(entry),
        snippet: needle
          ? this.#searchSnippet(text, matchIndex, needle.length)
          : this.#outlineSnippet(text),
      });
    }

    const lastResult = results[results.length - 1] || null;
    return {
      results: results.map(({ _beforeSeq, ...result }) => result),
      hasMore,
      nextBeforeSeq: hasMore && lastResult ? lastResult._beforeSeq : null,
    };
  }

  /**
   * Load a lightweight outline page for one Session. Only user and assistant
   * text metadata is projected; tool payloads, attachments and full message
   * bodies never leave the Agent through this API.
   *
   * @param {string} sessionId
   * @param {{ limit?: number, beforeSeq?: number|null, includeTotal?: boolean, scanStats?: object }} [opts]
   * @returns {{ results: object[], hasMore: boolean, nextBeforeSeq: number|null, totalCount: number|null }}
   */
  loadVisibleOutlineBySession(sessionId, opts = {}) {
    if (!sessionId) return { results: [], hasMore: false, nextBeforeSeq: null, totalCount: 0 };

    const limit = Math.min(100, Math.max(1, Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 50));
    const beforeSeq = Number.isFinite(opts.beforeSeq) ? opts.beforeSeq : Infinity;
    const newestFirst = [];
    let hasMore = false;

    for (const entry of this.#iterateVisibleResponseEntries(sessionId, { beforeSeq, scanStats: opts.scanStats })) {
      if (newestFirst.length >= limit) {
        hasMore = true;
        break;
      }
      const projected = this.#projectVisibleResponseEntry(entry);
      newestFirst.push({
        ...projected,
        snippet: this.#outlineSnippet(entry.textParts.join(' ')),
      });
    }

    let totalCount = null;
    if (opts.includeTotal === true) {
      totalCount = 0;
      for (const _entry of this.#iterateVisibleResponseEntries(sessionId, { scanStats: opts.scanStats })) totalCount += 1;
    }

    const oldestEntry = newestFirst[newestFirst.length - 1] || null;
    const results = newestFirst.reverse().map(({ _beforeSeq, ...entry }) => entry);
    return {
      results,
      hasMore,
      nextBeforeSeq: hasMore && oldestEntry ? oldestEntry._beforeSeq : null,
      totalCount,
    };
  }

  /**
   * Load a bounded visible window around a search hit. This deliberately does
   * not mutate normal older-history cursors: the web client merges the window
   * into its cache solely to mount and focus the requested virtual-list item.
   *
   * @param {string} sessionId
   * @param {number} anchorSeq
   * @param {{ beforeTurns?: number, afterTurns?: number, entryStartSeq?: number,
   *   entryEndSeq?: number, sourceMessageIds?: string[], maxRows?: number,
   *   maxBytes?: number }} [opts]
   * @returns {{ messages: object[], oldestSeq: number|null, hasMoreBefore: boolean }}
   */
  loadVisibleWindowBySession(sessionId, anchorSeq, opts = {}) {
    if (!sessionId || !Number.isFinite(anchorSeq)) {
      return { messages: [], oldestSeq: null, hasMoreBefore: false };
    }

    const beforeTurns = Math.min(10, Math.max(1, Number.isFinite(opts.beforeTurns) ? Math.floor(opts.beforeTurns) : 3));
    const afterTurns = Math.min(10, Math.max(1, Number.isFinite(opts.afterTurns) ? Math.floor(opts.afterTurns) : 3));
    const beforeRaw = this.#loadRecentSessionWindow(sessionId, beforeTurns + 1, {
      beforeSeq: anchorSeq + 1,
      roles: null,
      visibleOnly: true,
    });
    const messages = beforeRaw.messages.slice();
    const seen = new Set(messages.map(message => message?.id).filter(Boolean));
    let followingUserTurns = 0;

    for (const message of this.#iterateSessionRows(sessionId, { afterSeq: anchorSeq, desc: false })) {
      if (!message || message.sessionId !== sessionId || !isVisibleConversationRow(message)) continue;
      if (message.role === 'user') {
        followingUserTurns += 1;
        if (followingUserTurns > afterTurns) break;
      }
      if (message.id && seen.has(message.id)) continue;
      if (message.id) seen.add(message.id);
      messages.push(message);
    }

    const anchorIds = new Set(Array.isArray(opts.sourceMessageIds) ? opts.sourceMessageIds : []);
    const entryStartSeq = Number.isFinite(opts.entryStartSeq) ? opts.entryStartSeq : anchorSeq;
    const entryEndSeq = Number.isFinite(opts.entryEndSeq) ? opts.entryEndSeq : anchorSeq;
    for (const message of this.#iterateSessionRows(sessionId, {
      afterSeq: entryStartSeq - 1,
      beforeSeq: entryEndSeq + 1,
      desc: false,
    })) {
      if (!message?.id || seen.has(message.id)) continue;
      if (anchorIds.size > 0 && !anchorIds.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }

    messages.sort(compareMessagesBySeq);
    const projected = projectVisibleSessionMessages(messages);
    const maxRows = Math.min(500, Math.max(10, Number.isFinite(opts.maxRows) ? Math.floor(opts.maxRows) : 200));
    const maxBytes = Math.min(2 * 1024 * 1024, Math.max(32 * 1024, Number.isFinite(opts.maxBytes) ? Math.floor(opts.maxBytes) : 512 * 1024));
    const projectedById = new Map(projected.map(message => [message?.id, message]));
    const anchorRows = Array.from(anchorIds, id => projectedById.get(id)).filter(Boolean);
    const selected = anchorRows.slice();
    const selectedIds = new Set(selected.map(message => message.id));
    let selectedBytes = selected.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)), 0);
    const candidates = projected
      .filter(message => !selectedIds.has(message?.id))
      .sort((a, b) => Math.abs(parseSeqFromId(a.id) - anchorSeq) - Math.abs(parseSeqFromId(b.id) - anchorSeq));
    for (const message of candidates) {
      if (selected.length >= maxRows) break;
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (selected.length > 0 && selectedBytes + bytes > maxBytes) continue;
      selected.push(message);
      selectedBytes += bytes;
    }
    selected.sort(compareMessagesBySeq);
    const oldestSeq = selected.length > 0 ? parseSeqFromId(selected[0].id) : null;
    return {
      messages: selected,
      oldestSeq: Number.isFinite(oldestSeq) ? oldestSeq : null,
      hasMoreBefore: beforeRaw.truncated || selected.length < projected.length,
      rowCount: selected.length,
      byteCount: selectedBytes,
    };
  }

  /**
   * Count hot messages.
   *
   * @returns {number}
   */
  countHot() {
    let total = this.#countSegmentMessages([this.#chatDir, ...this.#sessionConversationDirs({ primaryOnly: true })]);
    const markdownDirs = [this.#legacyMsgDir];
    if (!this.#segmentStoreForConversationDir(this.#chatDir).hasData()) markdownDirs.push(this.#chatMsgDir);
    for (const dir of this.#sessionConversationDirs()) {
      if (!this.#segmentStoreForConversationDir(dir).hasData()) markdownDirs.push(join(dir, 'messages'));
    }
    return total + this.#countFilesInDirs(markdownDirs);
  }

  /**
   * Count cold messages.
   *
   * @returns {number}
   */
  countCold() {
    return this.#countSegmentMessages([this.#chatDir, ...this.#sessionConversationDirs({ primaryOnly: true })], 'cold')
      + this.#countFilesInDirs([this.#chatColdDir, ...this.#sessionMessageDirs('cold'), this.#legacyColdDir]);
  }

  /**
   * Get total estimated tokens for hot messages.
   *
   * @returns {number}
   */
  hotTokens() {
    const messages = this.#loadHotMessages();
    return messages.reduce((sum, m) => sum + (m.tokens_est || estimateTokens(m.content || '')), 0);
  }

  /**
   * Read the conversation index.
   *
   * @returns {object}
   */
  readIndex() {
    if (!existsSync(this.#indexPath)) {
      return { lastMessageId: null, totalMessages: 0, hotMessages: 0, coldMessages: 0 };
    }
    const raw = readFileSync(this.#indexPath, 'utf8');
    const parsed = parseMessage(raw);
    if (!parsed) {
      return { lastMessageId: null, totalMessages: 0, hotMessages: 0, coldMessages: 0 };
    }
    // Re-parse from frontmatter fields
    return {
      lastMessageId: parsed.id || null,
      totalMessages: parsed.tokens_est || 0, // reuse field parsing
    };
  }

  // ─── Internal ───────────────────────────────────────────

  /**
   * Delete every persisted message stamped with `sessionId`. Scans both hot
   * (`messages/`) and cold (`cold/`) directories and `unlink`s matching
   * files. Messages without a `sessionId` frontmatter are NOT touched —
   * they may be legitimate pre-grouping legacy messages and are handled
   * by `compactOrphans` instead.
   *
   * Used as the cascade step for hard-deleting a group: when the user
   * deletes a group via web-bridge / CLI, the group's persisted message
   * files would otherwise stick around as orphans.
   *
   * Idempotent and safe: missing dirs / unparseable files are skipped.
   * Returns the number of message files removed.
   *
   * @param {string} sessionId
   * @returns {number}
   */
  deleteByGroup(sessionId) {
    if (!sessionId) return 0;
    let removed = 0;
    const primaryDir = this.#sessionConversationDir(sessionId);
    const segmentStore = this.#segmentStoreForConversationDir(primaryDir);
    if (segmentStore.hasData()) {
      removed += segmentStore.count('all');
      segmentStore.clear();
    }
    for (const dir of [this.#chatMsgDir, this.#chatColdDir, ...this.#sessionMessageDirs('messages', sessionId), ...this.#sessionMessageDirs('cold', sessionId)]) {
      if (!existsSync(dir)) continue;
      let files;
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.md'));
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
      for (const file of files) {
        const path = join(dir, file);
        let raw;
        try {
          raw = readFileSync(path, 'utf8');
        } catch (err) {
          if (isPermissionError(err)) continue;
          throw err;
        }
        const msg = parseMessage(raw);
        if (!msg || msg.sessionId !== sessionId) continue;
        try {
          unlinkSync(path);
          removed += 1;
        } catch (err) {
          if (isPermissionError(err)) continue;
          throw err;
        }
      }
    }
    this.#nextSeq = null;
    this.#markDirty({ sessionId }, 'delete-session');
    return removed;
  }

  /**
   * Sweep messages that don't belong to any live group. A message is
   * considered an orphan when its frontmatter `sessionId`:
   *   - is missing entirely (legacy / pre-grouping); OR
   *   - is set to a value not in `keepGroupIds`.
   *
   * One-shot maintenance helper exposed via the CLI (`--compact-orphans`).
   * The caller is responsible for passing the authoritative live-group
   * list — we do NOT auto-discover it here, because a transient failure
   * in group loading (returning an empty list) would otherwise wipe
   * every persisted message. Defensive design: an empty/missing
   * `keepGroupIds` is rejected with a no-op return.
   *
   * @param {{ keepGroupIds: string[], dryRun?: boolean }} opts
   * @returns {{ scanned: number, removed: number, orphans: string[], skipped: boolean }}
   */
  compactOrphans({ keepGroupIds, dryRun = false } = {}) {
    if (!Array.isArray(keepGroupIds)) {
      return { scanned: 0, removed: 0, orphans: [], skipped: true };
    }
    const keep = new Set(keepGroupIds);
    let scanned = 0;
    let removed = 0;
    const orphans = [];

    const scanMsg = (msg, locator) => {
      if (!msg) return false;
      scanned += 1;
      const isOrphan = !msg.sessionId || !keep.has(msg.sessionId);
      if (!isOrphan) return false;
      orphans.push(locator);
      return true;
    };

    for (const dir of [this.#chatDir, ...this.#sessionConversationDirs({ primaryOnly: true })]) {
      const store = this.#segmentStoreForConversationDir(dir);
      if (!store.hasData()) continue;
      const rows = store.readAll({ includeCold: true });
      let keepRows = [];
      let dirty = false;
      for (const msg of rows) {
        const orphan = scanMsg(msg, `${dir}/${SEGMENT_DIR}/${msg.id || 'unknown'}`);
        if (orphan) dirty = true;
        else keepRows.push(msg);
      }
      if (dirty && !dryRun) {
        store.replaceAll(keepRows);
        removed += rows.length - keepRows.length;
      }
    }

    for (const dir of [this.#chatMsgDir, this.#chatColdDir, ...this.#sessionMessageDirs('messages'), ...this.#sessionMessageDirs('cold'), this.#legacyMsgDir, this.#legacyColdDir]) {
      if (!existsSync(dir)) continue;
      let files;
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.md'));
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
      for (const file of files) {
        const path = join(dir, file);
        let raw;
        try {
          raw = readFileSync(path, 'utf8');
        } catch (err) {
          if (isPermissionError(err)) continue;
          throw err;
        }
        const msg = parseMessage(raw);
        if (!scanMsg(msg, path)) continue;
        if (dryRun) continue;
        try {
          unlinkSync(path);
          removed += 1;
        } catch (err) {
          if (isPermissionError(err)) continue;
          throw err;
        }
      }
    }
    if (removed > 0) {
      this.#nextSeq = null;
      this.#markAllDirty('compact-orphans');
    }
    return { scanned, removed, orphans, skipped: false };
  }

  /**
   * Reassign every message in this store whose `threadId === sourceId`
   * to `targetId`. The original thread id is preserved in
   * `sourceThreadId` so the UI can still render a "#source" pill.
   * Scans both hot (`messages/`) and cold (`cold/`) directories.
   *
   * Idempotent: messages already carrying `sourceThreadId` are not
   * overwritten, and messages not on `sourceId` are skipped.
   *
   * @param {string} sourceId
   * @param {string} targetId
   * @returns {number} number of messages rewritten
   */
  reassignThread(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return 0;
    let rewritten = 0;

    for (const dir of [this.#chatDir, ...this.#sessionConversationDirs({ primaryOnly: true })]) {
      const store = this.#segmentStoreForConversationDir(dir);
      if (!store.hasData()) continue;
      const rows = store.readAll();
      let dirty = false;
      for (const msg of rows) {
        if (!msg || msg.threadId !== sourceId) continue;
        if (!msg.sourceThreadId) msg.sourceThreadId = sourceId;
        msg.threadId = targetId;
        rewritten += 1;
        dirty = true;
      }
      if (dirty) {
        store.clear();
        for (const msg of rows) store.append(msg);
      }
    }

    for (const dir of [this.#chatMsgDir, this.#chatColdDir, ...this.#sessionMessageDirs('messages'), ...this.#sessionMessageDirs('cold'), this.#legacyMsgDir, this.#legacyColdDir]) {
      if (!existsSync(dir)) continue;
      let files;
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.md'));
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
      for (const file of files) {
        const path = join(dir, file);
        let raw;
        try {
          raw = readFileSync(path, 'utf8');
        } catch (err) {
          if (isPermissionError(err)) continue;
          throw err;
        }
        const msg = parseMessage(raw);
        if (!msg || msg.threadId !== sourceId) continue;
        if (!msg.sourceThreadId) msg.sourceThreadId = sourceId;
        msg.threadId = targetId;
        try {
          writeFileSync(path, serializeMessage(msg), { encoding: 'utf8', mode: 0o644 });
          rewritten += 1;
        } catch (err) {
          if (isPermissionError(err)) {
            if (!_permissionWarned) {
              console.warn(`[Yeaft] Cannot rewrite message ${file}: ${err.code}`);
              _permissionWarned = true;
            }
            continue;
          }
          throw err;
        }
      }
    }
    if (rewritten > 0) this.#markAllDirty('reassign-thread');
    return rewritten;
  }

  /**
   * Copy every message on `sourceId` whose sequence id is <= `atMessageId`
   * into new message files stamped with `threadId: targetId` and
   * `sourceThreadId: sourceId` (symmetric with reassignThread's pill).
   *
   * Implementation notes:
   *  - Scans both hot (`messages/`) and cold (`cold/`) directories so a
   *    fork off a partially-compacted thread still works.
   *  - Copies are appended via `append()` so they receive fresh globally
   *    unique ids (m{NNNN}) — chronological order is preserved because we
   *    sort by filename before copying.
   *  - The source is NEVER modified. This is the key invariant separating
   *    fork from merge.
   *  - Returns the number of messages copied. `atMessageId` is inclusive.
   *
   * @param {string} sourceId
   * @param {string} targetId
   * @param {string} atMessageId — e.g. "m0007"; copy stops after this id
   * @returns {number} copied count
   */
  copyThreadUpTo(sourceId, targetId, atMessageId) {
    if (!sourceId || !targetId || sourceId === targetId) return 0;
    if (!atMessageId || typeof atMessageId !== 'string') return 0;
    // task-314 (rev-2 feedback): the target (forked) thread owns its own
    // per-thread id namespace restarting at m0001. Source files are never
    // touched, so there is no id-collision across threads (each thread
    // loads from its own directory or by threadId filter on the shared
    // legacy dir).
    const targetDir = this.#threadMsgDir(targetId);
    try {
      if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true, mode: 0o755 });
    } catch (err) {
      if (isPermissionError(err)) return 0;
      throw err;
    }

    // Collect source-thread candidate rows from segmented storage and legacy Markdown dirs.
    const sourceRows = this.#loadAllMessages().filter(m => m && m.threadId === sourceId);
    const candidates = [];
    // Also pick up any already-forked sub-thread dir (chain fork).
    const sourceSubDir = this.#threadMsgDir(sourceId);
    if (existsSync(sourceSubDir)) {
      try {
        for (const f of readdirSync(sourceSubDir).filter(x => x.endsWith('.md'))) {
          candidates.push(join(sourceSubDir, f));
        }
      } catch (err) {
        if (!isPermissionError(err)) throw err;
      }
    }
    sourceRows.sort(compareMessagesBySeq);
    candidates.sort((a, b) => {
      const ma = a.match(/m(\d+)\.md$/);
      const mb = b.match(/m(\d+)\.md$/);
      if (!ma || !mb) return 0;
      return parseInt(ma[1], 10) - parseInt(mb[1], 10);
    });
    const cutoffMatch = atMessageId.match(/^m?(\d+)$/);
    if (!cutoffMatch) return 0;
    const cutoffSeq = parseInt(cutoffMatch[1], 10);

    let copied = 0;
    const copyMsg = (msg) => {
      if (!msg || msg.threadId !== sourceId) return;
      const seq = parseSeqFromId(msg.id);
      if (!Number.isFinite(seq) || seq > cutoffSeq) return;
      const nextSeq = this.#getNextThreadSeq(targetId);
      const newId = `m${String(nextSeq).padStart(4, '0')}`;
      const { id: _id, seq: _seq, ...rest } = msg;
      const copy = {
        ...rest,
        id: newId,
        threadId: targetId,
        sourceThreadId: msg.sourceThreadId || sourceId,
        time: rest.time || new Date().toISOString(),
        tokens_est: rest.tokens_est || estimateTokens(rest.content || ''),
      };
      const filePath = join(targetDir, `${newId}.md`);
      writeFileSync(filePath, serializeMessage(copy), { encoding: 'utf8', mode: 0o644 });
      this.#nextSeqByThread.set(targetId, nextSeq + 1);
      copied += 1;
    };
    for (const msg of sourceRows) {
      try { copyMsg(msg); }
      catch (err) { if (isPermissionError(err)) continue; throw err; }
    }
    for (const path of candidates) {
      try {
        const msg = parseMessage(readFileSync(path, 'utf8'));
        copyMsg(msg);
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
    }
    if (copied > 0) this.#markAllDirty('copy-thread');
    return copied;
  }

  /**
   * Load messages for a specific thread. Reads from the per-thread subdir
   * (created by forkThread via copyThreadUpTo) if present, otherwise
   * filters the legacy flat `messages/` + `cold/` dirs by `threadId`.
   * Results are sorted chronologically by file sequence number.
   *
   * @param {string} threadId
   * @returns {object[]}
   */
  load(threadId) {
    if (!threadId) return [];
    const subDir = this.#threadMsgDir(threadId);
    if (existsSync(subDir)) {
      // Per-thread namespace: just load the whole dir, filtered by
      // threadId for safety (guards against hand-edited files).
      const out = [];
      for (const f of readdirSync(subDir).filter(x => x.endsWith('.md')).sort()) {
        try {
          const raw = readFileSync(join(subDir, f), 'utf8');
          const msg = parseMessage(raw);
          if (msg && msg.threadId === threadId) out.push(msg);
        } catch (err) {
          if (!isPermissionError(err)) throw err;
        }
      }
      return out;
    }
    // Legacy plus segmented root: messages live in the flat/session stores stamped with threadId.
    const collected = this.#loadAllMessages()
      .filter(msg => msg && msg.threadId === threadId)
      .map(msg => ({ msg, f: `${msg.id || ''}.md` }));
    for (const dir of [this.#chatColdDir, this.#chatMsgDir, ...this.#sessionMessageDirs('cold'), ...this.#sessionMessageDirs('messages'), this.#legacyColdDir, this.#legacyMsgDir]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter(x => x.endsWith('.md'))) {
        try {
          const raw = readFileSync(join(dir, f), 'utf8');
          const msg = parseMessage(raw);
          if (msg && msg.threadId === threadId) collected.push({ msg, f });
        } catch (err) {
          if (!isPermissionError(err)) throw err;
        }
      }
    }
    collected.sort((a, b) => {
      const ma = a.f.match(/m(\d+)\.md$/);
      const mb = b.f.match(/m(\d+)\.md$/);
      return (parseInt(ma?.[1] || '0', 10)) - (parseInt(mb?.[1] || '0', 10));
    });
    return collected.map(x => x.msg);
  }

  #chatConversationDir(chatId, { create = false } = {}) {
    const dir = join(this.#dir, 'chats', this.#safeDirComponent(chatId), 'conversation');
    if (create) this.#ensureConversationDirs(dir);
    return dir;
  }

  #chatConversationDirs() {
    const root = join(this.#dir, 'chats');
    if (!existsSync(root)) return [];
    const dirs = [];
    for (const name of readdirSync(root)) {
      if (name.startsWith('.')) continue;
      const chatDir = join(root, name);
      try { if (!statSync(chatDir).isDirectory()) continue; }
      catch (err) { if (isPermissionError(err)) continue; throw err; }
      const conv = join(chatDir, 'conversation');
      if (existsSync(conv)) dirs.push(conv);
    }
    return dirs;
  }

  #chatMessageDirs(kind, chatId = null) {
    if (chatId) {
      const dir = join(this.#chatConversationDir(chatId), kind);
      return existsSync(dir) ? [dir] : [];
    }
    return this.#chatConversationDirs()
      .map(dir => join(dir, kind))
      .filter(dir => existsSync(dir));
  }

  /** Recent messages for a chat — chat mode mirror of loadRecentBySession. */
  loadRecentByChat(chatId, turnsLimit = DEFAULT_RECENT_TURNS) {
    if (!chatId) return [];
    const all = [
      ...this.#readSegmentRows(this.#chatConversationDir(chatId)),
      ...this.#chatMessageDirs('messages', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
      ...this.#chatMessageDirs('cold', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
    const filtered = all.filter(m => m && m.chatId === chatId && !isHiddenConversationRow(m));
    if (turnsLimit === Infinity || turnsLimit < 0) return pairSanitize(filtered);
    return pairSanitize(sliceLastNTurns(filtered, turnsLimit));
  }

  /** VP-scoped chat history — chat-mode mirror of loadSessionHistoryForVp. */
  loadChatHistoryForVp(chatId, vpId) {
    if (!chatId || !vpId) return [];
    const all = [
      ...this.#readSegmentRows(this.#chatConversationDir(chatId)),
      ...this.#chatMessageDirs('messages', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
      ...this.#chatMessageDirs('cold', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
    const out = [];
    for (const m of all) {
      if (!m || m.chatId !== chatId) continue;
      if (isHiddenConversationRow(m)) continue;
      if (m.role === 'user') { out.push(m); continue; }
      if (m.role === 'assistant') {
        // Chat is 1:1 — every assistant row is "ours".
        out.push(m);
        continue;
      }
      if (m.role === 'tool') { out.push(m); continue; }
    }
    return pairSanitize(out);
  }

  #sessionConversationDir(sessionId, { create = false } = {}) {
    const dir = join(this.#sessionsDir, this.#safeDirComponent(sessionId), 'conversation');
    if (create) this.#ensureConversationDirs(dir);
    return dir;
  }

  #legacySessionConversationDir(sessionId) {
    return join(this.#legacySessionsDir, this.#safeDirComponent(sessionId), 'conversation');
  }

  #ensureConversationDirs(dir) {
    for (const d of [dir, join(dir, 'blobs'), join(dir, SEGMENT_DIR), join(dir, 'messages'), join(dir, 'cold')]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 });
    }
  }

  #segmentStoreFor(msg, { create = false } = {}) {
    let dir;
    if (msg?.chatId) dir = this.#chatConversationDir(msg.chatId, { create });
    else if (msg?.sessionId) dir = this.#sessionConversationDir(msg.sessionId, { create });
    else dir = this.#chatDir;
    return new SegmentStore(dir);
  }

  #segmentStoreForConversationDir(dir) {
    return new SegmentStore(dir);
  }


  #sessionConversationDirs({ primaryOnly = false } = {}) {
    const dirs = [];
    const seen = new Set();
    for (const root of (primaryOnly ? [this.#sessionsDir] : [this.#sessionsDir, this.#legacySessionsDir])) {
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        const sessionDir = join(root, name);
        try {
          if (!statSync(sessionDir).isDirectory()) continue;
        } catch (err) {
          if (isPermissionError(err)) continue;
          throw err;
        }
        const conversationDir = join(sessionDir, 'conversation');
        if (!existsSync(conversationDir) || seen.has(conversationDir)) continue;
        seen.add(conversationDir);
        dirs.push(conversationDir);
      }
    }
    return dirs;
  }

  #sessionMessageDirs(kind, sessionId = null) {
    const kinds = kind === 'all' ? ['cold', 'messages'] : [kind];
    if (sessionId) {
      const dirs = [];
      for (const k of kinds) {
        dirs.push(
          join(this.#sessionConversationDir(sessionId), k),
          join(this.#legacySessionConversationDir(sessionId), k),
        );
      }
      return dirs.filter(dir => existsSync(dir));
    }
    return this.#sessionConversationDirs()
      .flatMap(dir => kinds.map(k => join(dir, k)))
      .filter(dir => existsSync(dir));
  }

  #hotColdDirPairs({ includeLegacy = true } = {}) {
    const pairs = [
      [this.#chatMsgDir, this.#chatColdDir],
      ...this.#sessionConversationDirs().map(dir => [join(dir, 'messages'), join(dir, 'cold')]),
    ];
    if (includeLegacy) pairs.push([this.#legacyMsgDir, this.#legacyColdDir]);
    return pairs;
  }

  #loadChatMessages() {
    // Legacy ~/.yeaft/conversation held both chat and group records. For chat
    // mode compatibility, only import legacy records that are not stamped with
    // a sessionId, so group mode cannot bleed into chat.
    return [
      ...this.#readSegmentRows(this.#chatDir).filter(m => !m?.sessionId),
      ...this.#loadFromDir(this.#legacyMsgDir, Infinity).filter(m => !m?.sessionId),
      ...this.#loadFromDir(this.#chatMsgDir, Infinity),
    ].sort(compareMessagesBySeq);
  }

  #loadSessionHotMessages(sessionId = null) {
    if (sessionId) return this.#readSessionRows(sessionId);
    return [
      ...this.#sessionConversationDirs({ primaryOnly: true }).flatMap(dir => this.#readSegmentRows(dir)),
      ...this.#sessionMessageDirs('messages', null).flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
  }

  #loadSessionMessages(sessionId = null) {
    return this.#loadSessionHotMessages(sessionId);
  }

  readMessageFile(path) {
    return parseMessage(readFileSync(path, 'utf8'));
  }

  #loadRecentSessionWindow(sessionId, turnsLimit, {
    beforeSeq = Infinity,
    afterSeq = -Infinity,
    roles = null,
    includeReflections = false,
    visibleOnly = false,
  } = {}) {
    const kept = [];
    const pendingBoundaryRows = [];
    let turnsFromEnd = 0;
    let openCanonical = null;
    let boundaryCanonical = null;
    let truncated = false;
    let parsed = 0;
    let oldestScannedSeq = null;
    let scanCapped = false;
    const scanCap = recentSessionScanCap(turnsLimit);

    const project = (m) => {
      if (roles && !roles.has(m.role)) return null;
      return m;
    };
    const keep = (m) => {
      const projected = project(m);
      if (projected) kept.push(projected);
    };
    const queueBoundaryRow = (m) => {
      const projected = project(m);
      if (projected) pendingBoundaryRows.push(projected);
    };

    // Do not materialize the whole session transcript just to paint or hydrate
    // the recent context window. Large Yeaft sessions can have thousands of
    // markdown rows; parsing all of them is synchronous and can starve websocket
    // heartbeat long enough for the agent to look dead. Walk newest-to-oldest
    // and stop after the requested turn window is complete. Hidden/internal and
    // non-turn rows are not allowed to force an unbounded scan; a hard parse cap
    // conservatively marks the page truncated.
    for (const m of this.#iterateSessionRows(sessionId, { beforeSeq, afterSeq, desc: true })) {
      if (parsed >= scanCap) {
        truncated = true;
        scanCapped = true;
        break;
      }
      parsed += 1;

      if (!m || m.sessionId !== sessionId) continue;
      const scannedSeq = parseSeqFromId(m.id);
      if (Number.isFinite(scannedSeq)) oldestScannedSeq = scannedSeq;

      const boundaryComplete = turnsFromEnd >= turnsLimit;
      const hidden = isHiddenConversationRow(m)
        || (visibleOnly && !isVisibleConversationRow(m));
      if (hidden && !(includeReflections && m._reflection === true)) {
        if (boundaryComplete) {
          truncated = true;
          break;
        }
        continue;
      }

      if (boundaryComplete) {
        if (m.role === 'user') {
          const canonical = canonicalUserTurnContent(m.content);
          if (canonical != null && canonical === boundaryCanonical) {
            kept.push(...pendingBoundaryRows.splice(0));
            keep(m);
            continue;
          }
        } else {
          queueBoundaryRow(m);
          continue;
        }
        truncated = true;
        break;
      }

      if (m.role === 'user') {
        const canonical = canonicalUserTurnContent(m.content);
        if (canonical != null && canonical !== openCanonical) {
          turnsFromEnd += 1;
          openCanonical = canonical;
          if (turnsFromEnd === turnsLimit) boundaryCanonical = canonical;
          if (turnsFromEnd > turnsLimit) {
            truncated = true;
            break;
          }
        }
      }

      keep(m);
    }

    kept.reverse();
    return {
      messages: turnsFromEnd > 0 ? sliceLastNTurns(kept, turnsLimit) : kept,
      truncated,
      nextBeforeSeq: scanCapped
        && pendingBoundaryRows.length === 0
        && Number.isFinite(oldestScannedSeq)
        ? oldestScannedSeq
        : null,
    };
  }

  *#iterateVisibleResponseEntries(sessionId, opts = {}) {
    const beforeSeq = Number.isFinite(opts.beforeSeq) ? opts.beforeSeq : Infinity;
    const rows = this.#iterateSessionRows(sessionId, {
      beforeSeq,
      desc: true,
      scanStats: opts.scanStats,
    });
    yield* iterateCanonicalVisibleEntriesNewestFirst(rows, sessionId);
  }

  #projectVisibleResponseEntry(entry) {
    return {
      entryId: entry.entryId,
      messageId: entry.anchorMessageId,
      ...(entry.clientMessageId ? { clientMessageId: entry.clientMessageId } : {}),
      turnId: entry.turnId,
      seq: entry.anchorSeq,
      entryStartSeq: entry.entryStartSeq,
      role: entry.role,
      speakerVpId: entry.speakerVpId,
      sourceMessageIds: entry.sourceMessageIds,
      timestamp: entry.timestamp,
      _beforeSeq: entry.entryStartSeq,
    };
  }

  #searchSnippet(text, matchIndex, needleLength) {
    const radius = 90;
    const start = Math.max(0, matchIndex - radius);
    const end = Math.min(text.length, matchIndex + needleLength + radius);
    return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  }

  #outlineSnippet(text) {
    const limit = 180;
    return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
  }

  #readSegmentRows(conversationDir, opts = {}) {
    return this.#segmentStoreForConversationDir(conversationDir).readAll(opts);
  }

  *#iterateSessionRows(sessionId, opts = {}) {
    const primaryDir = this.#sessionConversationDir(sessionId);
    const segmentStore = this.#segmentStoreForConversationDir(primaryDir);
    yield* segmentStore.scan({ includeCold: true, ...opts });
    for (const entry of this.#sessionFileEntries('all', sessionId, opts)) {
      try {
        const msg = this.readMessageFile(entry.path);
        addScanMetric(opts.scanStats, 'legacyFiles');
        try { addScanMetric(opts.scanStats, 'bytes', statSync(entry.path).size); } catch {}
        if (msg) {
          addScanMetric(opts.scanStats, 'rows');
          yield msg;
        }
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
    }
  }

  #readSessionRows(sessionId, opts = {}) {
    return Array.from(this.#iterateSessionRows(sessionId, opts)).sort(compareMessagesBySeq);
  }

  #countSegmentMessages(conversationDirs, kind = 'hot') {
    let total = 0;
    for (const dir of conversationDirs) total += this.#segmentStoreForConversationDir(dir).count(kind);
    return total;
  }

  #sessionFileEntries(kind, sessionId, { beforeSeq = Infinity, afterSeq = -Infinity, desc = false } = {}) {
    const entries = [];
    const kindOrder = kind === 'all' ? { cold: 0, messages: 1 } : null;
    for (const dir of this.#sessionMessageDirs(kind, sessionId)) {
      let files;
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.md'));
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
      for (const file of files) {
        const seqMatch = file.match(/^m(\d+)\.md$/);
        const seq = seqMatch ? parseInt(seqMatch[1], 10) : NaN;
        if (!Number.isFinite(seq)) continue;
        if (Number.isFinite(beforeSeq) && seq >= beforeSeq) continue;
        if (Number.isFinite(afterSeq) && seq <= afterSeq) continue;
        const kindRank = kindOrder ? kindOrder[basename(dir)] ?? 0 : 0;
        entries.push({ path: join(dir, file), seq, kindRank });
      }
    }
    entries.sort((a, b) => {
      if (a.seq !== b.seq) return desc ? b.seq - a.seq : a.seq - b.seq;
      return desc ? b.kindRank - a.kindRank : a.kindRank - b.kindRank;
    });
    return entries;
  }

  #loadAllMessages() {
    return [
      ...this.#loadFromDir(this.#legacyColdDir, Infinity),
      ...this.#loadFromDir(this.#legacyMsgDir, Infinity),
      ...this.#loadFromDir(this.#chatColdDir, Infinity),
      ...this.#loadFromDir(this.#chatMsgDir, Infinity),
      ...this.#readSegmentRows(this.#chatDir, { includeCold: true }),
      ...this.#sessionConversationDirs({ primaryOnly: true }).flatMap(dir => this.#readSegmentRows(dir, { includeCold: true })),
      ...this.#sessionMessageDirs('cold').flatMap(dir => this.#loadFromDir(dir, Infinity)),
      ...this.#sessionMessageDirs('messages').flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
  }

  #loadHotMessages() {
    return [
      ...this.#loadFromDir(this.#legacyMsgDir, Infinity),
      ...this.#loadFromDir(this.#chatMsgDir, Infinity),
      ...this.#readSegmentRows(this.#chatDir),
      ...this.#sessionConversationDirs({ primaryOnly: true }).flatMap(dir => this.#readSegmentRows(dir)),
      ...this.#sessionMessageDirs('messages').flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ]
      .filter(m => m && m.cold !== true)
      .sort(compareMessagesBySeq);
  }

  #countFilesInDirs(dirs) {
    let total = 0;
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        total += readdirSync(dir).filter(f => f.endsWith('.md')).length;
      } catch (err) {
        if (!isPermissionError(err)) throw err;
      }
    }
    return total;
  }

  // task-314: per-thread sub-directory for forked threads.
  #threadMsgDir(threadId) {
    return join(this.#convDir, 'threads', threadId, 'messages');
  }

  // task-314: next per-thread sequence number, restarting at 1 for each
  // new thread. Scans the per-thread sub-dir (not the global flat dir).
  #getNextThreadSeq(threadId) {
    const cached = this.#nextSeqByThread.get(threadId);
    if (cached != null) return cached;
    const dir = this.#threadMsgDir(threadId);
    let maxSeq = 0;
    if (existsSync(dir)) {
      try {
        for (const f of readdirSync(dir)) {
          const m = f.match(/^m(\d+)\.md$/);
          if (m) {
            const s = parseInt(m[1], 10);
            if (s > maxSeq) maxSeq = s;
          }
        }
      } catch (err) {
        if (!isPermissionError(err)) throw err;
      }
    }
    const next = maxSeq + 1;
    this.#nextSeqByThread.set(threadId, next);
    return next;
  }

  /**
   * Load messages from a directory, sorted by filename, limited.
   * @param {string} dir
   * @param {number} limit
   * @returns {object[]}
   */
  #loadFromDir(dir, limit) {
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort(); // m0001.md < m0002.md — chronological

    // Take the most recent `limit` files
    const selected = limit < Infinity
      ? files.slice(-limit)
      : files;

    const messages = [];
    for (const file of selected) {
      const raw = readFileSync(join(dir, file), 'utf8');
      const parsed = parseSegmentOrMarkdown(raw);
      if (parsed) messages.push(parsed);
    }

    return messages;
  }

  /**
   * Determine the next sequence number by scanning existing files.
   * @returns {number}
   */
  #getNextSeq() {
    if (this.#nextSeq != null) return this.#nextSeq;

    let maxSeq = 0;
    for (const dir of [this.#chatDir, ...this.#sessionConversationDirs({ primaryOnly: true })]) {
      const store = this.#segmentStoreForConversationDir(dir);
      if (store.hasData()) {
        const idx = store.loadIndex();
        maxSeq = Math.max(maxSeq, (Number(idx.nextSeq) || 1) - 1);
      }
    }
    for (const dir of [this.#chatMsgDir, this.#chatColdDir, ...this.#sessionMessageDirs('messages'), ...this.#sessionMessageDirs('cold'), this.#legacyMsgDir, this.#legacyColdDir]) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        const match = file.match(/^m(\d+)\.md$/);
        if (match) {
          const seq = parseInt(match[1], 10);
          if (seq > maxSeq) maxSeq = seq;
        }
      }
    }

    this.#nextSeq = maxSeq + 1;
    return this.#nextSeq;
  }
}
