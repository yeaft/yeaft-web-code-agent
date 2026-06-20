/**
 * persist.js — Conversation message persistence
 *
 * Each message is stored as a .md file with YAML frontmatter in
 * ~/.yeaft/chat/messages/ or ~/.yeaft/sessions/<sessionId>/conversation/messages/. Design: zero JSON, all Markdown.
 *
 * Vocabulary note: the primary on-disk layout uses `sessions/<id>/`. Older
 * installs may still have transcript files under `groups/<id>/`; those are
 * read as a legacy fallback only. Every API surface above the disk layer
 * uses "session" vocabulary.
 *
 * Message format:
 *   ---
 *   id: m0355
 *   role: user
 *   time: 2026-04-09T14:35:00Z
 *   mode: chat
 *   model: claude-sonnet-4-20250514
 *   tokens_est: 230
 *   ---
 *   Message content here...
 *
 * Reference: yeaft-yeaft-core-systems.md §4.1, yeaft-yeaft-brainstorm-v5.1.md
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, statSync } from 'fs';
import { join, basename } from 'path';
import { isPermissionError } from '../init.js';
import { pairSanitize } from '../pair-sanitize.js';
import { countTurns, indexOfNthTurnFromEnd, sliceLastNTurns, stripVpMentionPrefix } from '../turn-utils.js';

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
 * 20 turns is the bootstrap window the user signed off on (2026-05-01).
 * The session-level compactor in `history-compact.js` is the authoritative
 * size limiter once the engine is running; this is just the cold-start
 * replay window after a fresh boot or reconnect.
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
let DEFAULT_RECENT_TURNS = 20;

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
 * truncated history AND no compact summary exists to cover the dropped
 * turns. The user is then losing context with no UX signal otherwise.
 *
 * @param {string} sessionId
 * @param {string} storeDir
 * @param {number} totalTurns      — turns available on disk
 * @param {number} returnedTurns   — turns the load returned
 * @param {boolean} hasCompactSummary
 */
function maybeWarnHistoryTruncated(sessionId, storeDir, totalTurns, returnedTurns, hasCompactSummary) {
  if (!sessionId || !storeDir) return;
  if (returnedTurns >= totalTurns) return;
  if (hasCompactSummary) return;
  const key = `${storeDir}::${sessionId}`;
  if (_truncationWarned.has(key)) return;
  _truncationWarned.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[Yeaft] history for session ${sessionId} truncated to ${returnedTurns} of ${totalTurns} turns (recentTurnsLimit=${DEFAULT_RECENT_TURNS}); ` +
    `no compact summary exists, so older context is dropped. ` +
    `Raise yeaft.recentTurnsLimit in ~/.yeaft/config.json if this is a problem.`
  );
}

// ─── Token estimation ────────────────────────────────────────

/**
 * Whether a permission warning has already been logged for this store instance.
 * Used to avoid spamming the console with repeated warnings.
 */
let _permissionWarned = false;

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
  // Session attribution: when a VP authors an assistant turn (either
  // its own reply or a route_forward injection from another VP), stamp
  // the speaker so the UI can render the message on the correct VP track.
  // For real user messages this is unset.
  if (msg.speakerVpId) fm.push(`speakerVpId: ${msg.speakerVpId}`);
  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    try {
      const b64 = Buffer.from(JSON.stringify(msg.attachments)).toString('base64');
      fm.push(`attachmentsB64: ${b64}`);
    } catch { /* best-effort: attachments are UI metadata, not engine-critical */ }
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
  if (msg.thinkingBlocks && msg.thinkingBlocks.length > 0) {
    fm.push(`thinkingBlocks:`);
    for (const tb of msg.thinkingBlocks) {
      if (!tb || typeof tb.signature !== 'string' || !tb.signature) continue;
      if (tb.redacted) {
        if (typeof tb.data !== 'string') continue;
        const dataB64 = Buffer.from(tb.data, 'utf8').toString('base64');
        const signatureB64 = Buffer.from(tb.signature, 'utf8').toString('base64');
        fm.push(`  - redacted: true`);
        fm.push(`    dataB64: ${dataB64}`);
        fm.push(`    signatureB64: ${signatureB64}`);
      } else {
        if (typeof tb.thinking !== 'string') continue;
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
      case 'turnNumber': msg.turnNumber = parseInt(value, 10); break;
      case 'toolCallId': msg.toolCallId = value; break;
      case 'eventType': msg.eventType = value; break;
      case 'taskId': msg.taskId = value; break;
      case 'taskStatus': msg.taskStatus = value; break;
      case 'isError': msg.isError = value === 'true'; break;
      case 'tokens_est': msg.tokens_est = parseInt(value, 10); break;
      case 'threadId': msg.threadId = value; break;
      case 'sourceThreadId': msg.sourceThreadId = value; break;
      case 'sessionId': msg.sessionId = value; break;
      case 'chatId': msg.chatId = value; break;
      case 'speakerVpId': msg.speakerVpId = value; break;
      case 'attachmentsB64':
        try {
          const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
          if (Array.isArray(parsed)) msg.attachments = parsed;
        } catch { /* best-effort: ignore malformed attachment metadata */ }
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
  if (frontmatter.includes('thinkingBlocks:')) {
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
          if (typeof tb.data === 'string' && typeof tb.signature === 'string' && tb.signature) {
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

// ─── ConversationStore ───────────────────────────────────────

/**
 * ConversationStore — persist and load messages to/from disk.
 *
 * Directory layout:
 *   chat/            — one-to-one chat mode history
 *     index.md
 *     compact.md
 *     messages/
 *     cold/
 *     blobs/
 *   sessions/<sessionId>/conversation/
 *     compact/
 *     messages/
 *     cold/
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
  #compactPath; // ~/.yeaft/chat/compact.md
  #legacyCompactPath;
  #legacyCompactScopedDir;
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
    this.#compactPath = join(this.#chatDir, 'compact.md');
    this.#legacyCompactPath = join(this.#legacyConvDir, 'compact.md');

    this.#chatMsgDir = this.#msgDir;
    this.#chatColdDir = this.#coldDir;
    this.#legacyMsgDir = join(this.#legacyConvDir, 'messages');
    this.#legacyColdDir = join(this.#legacyConvDir, 'cold');

    // Per-(sessionId, vpId) compact summary files live under that session's
    // conversation directory. The legacy ~/.yeaft/conversation/compact directory
    // is read for compatibility.
    this.#legacyCompactScopedDir = join(this.#legacyConvDir, 'compact');
    this.#nextSeq = null;
    this.#nextSeqByThread = new Map();

    // Ensure new chat and session-root directories exist (graceful on permission
    // errors). Per-session conversation directories are created lazily once a
    // sessionId is known. Legacy directories are never created by new versions.
    for (const d of [
      this.#chatDir, join(this.#chatDir, 'blobs'), this.#chatMsgDir, this.#chatColdDir,
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

    const filePath = join(this.#messageDirFor(fullMsg), `${id}.md`);
    try {
      writeFileSync(filePath, serializeMessage(fullMsg), { encoding: 'utf8', mode: 0o644 });
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
   * Move a message from hot (messages/) to cold (cold/).
   *
   * @param {string} id — message id (e.g. "m0355")
   */
  moveToCold(id) {
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
   * Rewrite the compact summary in place.
   *
   * Compact's semantics are "the running summary of everything older than
   * the hot window". Each compact pass already received the previous
   * summary text as input and produced a *new* cumulative summary — so
   * we overwrite, we never append. Appending was the original behaviour
   * (kept around as a diary), but the engine reads the whole file back
   * into `<conversation_summary>` on every turn, so appending grows the
   * per-turn prompt without bound until it defeats compaction itself.
   *
   * @param {string} summary — the new, complete summary to persist
   */
  replaceCompactSummary(summary) {
    if (typeof summary !== 'string' || !summary) return;
    try {
      writeFileSync(this.#compactPath, summary, { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot write compact summary: ${err.code}`);
          _permissionWarned = true;
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Read the compact summary.
   *
   * @returns {string}
   */
  readCompactSummary() {
    if (existsSync(this.#compactPath)) return readFileSync(this.#compactPath, 'utf8');
    if (existsSync(this.#legacyCompactPath)) return readFileSync(this.#legacyCompactPath, 'utf8');
    return '';
  }

  /**
   * Sanitize one id (sessionId or vpId) into a safe filename component.
   * Anything outside `[A-Za-z0-9._-]` collapses to `_`; max 120 chars.
   * For directory path components, use `#safeDirComponent` instead; this
   * helper intentionally preserves historical compact-summary filenames.
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
   * Sanitize a (sessionId, vpId) pair into a safe filename. We accept
   * arbitrary user strings here (sessionIds and vpIds are user-set), so
   * the result is purely a basename — never parsed back.
   *
   * @param {string} sessionId
   * @param {string} vpId
   * @returns {string|null} — full path, or null if either id missing
   */
  #scopedCompactPath(sessionId, vpId) {
    if (!sessionId || !vpId) return null;
    const compactDir = join(this.#sessionConversationDir(sessionId, { create: true }), 'compact');
    return join(compactDir, `${this.#safeIdComponent(vpId)}.md`);
  }

  #legacyScopedCompactPath(sessionId, vpId) {
    if (!sessionId || !vpId) return null;
    return join(this.#legacyCompactScopedDir, `${this.#safeIdComponent(sessionId)}__${this.#safeIdComponent(vpId)}.md`);
  }

  /**
   * Read a per-(sessionId, vpId) compact summary. Returns '' if no summary
   * has been written yet. Falls back to nothing — callers that need the
   * legacy global file should call `readCompactSummary()` explicitly.
   *
   * The (group, vp) scoping was introduced after we noticed the legacy
   * single-file `compact.md` was shared across every group AND every VP
   * in a session — so each new compact would clobber/append on top of
   * unrelated content and every VP read the same merged blob. See
   * `engine.#runOrchestratorCompact`.
   *
   * @param {string} sessionId
   * @param {string} vpId
   * @returns {string}
   */
  readCompactSummaryFor(sessionId, vpId) {
    const path = this.#scopedCompactPath(sessionId, vpId);
    const legacyPath = this.#legacyScopedCompactPath(sessionId, vpId);
    for (const candidate of [path, legacyPath]) {
      if (!candidate || !existsSync(candidate)) continue;
      try { return readFileSync(candidate, 'utf8'); }
      catch { return ''; }
    }
    return '';
  }

  /**
   * Rewrite a per-(sessionId, vpId) compact summary in place. See
   * `replaceCompactSummary` for the rationale — same reason, scoped file.
   *
   * @param {string} sessionId
   * @param {string} vpId
   * @param {string} summary
   */
  replaceCompactSummaryFor(sessionId, vpId, summary) {
    if (typeof summary !== 'string' || !summary) return;
    const path = this.#scopedCompactPath(sessionId, vpId);
    if (!path) return;
    try {
      writeFileSync(path, summary, { encoding: 'utf8', mode: 0o644 });
    } catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot write scoped compact summary: ${err.code}`);
          _permissionWarned = true;
        }
      } else {
        throw err;
      }
    }
  }

  /**
   * Check whether ANY per-(session, vp) compact summary exists for `sessionId`.
   * Used by the history-replay path to decide whether to flag
   * `hasCompactSummary` for the UI without committing to one VP's view.
   *
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasAnyCompactSummaryForSession(sessionId) {
    if (!sessionId) return false;
    const compactDir = join(this.#sessionConversationDir(sessionId), 'compact');
    for (const dir of [compactDir, this.#legacyCompactScopedDir]) {
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (dir === compactDir && f.endsWith('.md')) return true;
          if (dir === this.#legacyCompactScopedDir && f.startsWith(`${this.#safeIdComponent(sessionId)}__`) && f.endsWith('.md')) return true;
        }
      } catch { /* best-effort */ }
    }
    return false;
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
   * Clear all messages (hot + cold + compact).
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
    // Reset compact files in the new chat/group stores. Legacy
    // ~/.yeaft/conversation is intentionally left untouched.
    for (const path of [this.#compactPath]) {
      if (!existsSync(path)) continue;
      try {
        writeFileSync(path, '', { encoding: 'utf8', mode: 0o644 });
      } catch (err) {
        if (!isPermissionError(err)) throw err;
      }
    }
    this.#nextSeq = 1;
    this.updateIndex({ totalMessages: 0, lastMessageId: null });
  }


  // ─── Read API ───────────────────────────────────────────

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
   * Implementation note: filters AFTER reading the most recent files
   * because the on-disk order is global by sequence id. We over-read by
   * loading every hot file and slicing the tail of the FILTERED set so
   * `turnsLimit` reflects "N most recent turns in this group", not "N
   * most recent messages on disk that happen to be in this group". For
   * typical inboxes (≤ a few thousand hot messages) this is cheap; if
   * it ever becomes a hot path we add a per-group on-disk index.
   *
   * @param {string} sessionId — required; null/empty returns []
   * @param {number} [turnsLimit=DEFAULT_RECENT_TURNS]
   * @returns {object[]}
   */
  loadRecentBySession(sessionId, turnsLimit = DEFAULT_RECENT_TURNS) {
    if (!sessionId) return [];
    const all = this.#loadSessionMessages(sessionId);
    const filtered = all.filter(m => m && m.sessionId === sessionId);
    if (turnsLimit === Infinity || turnsLimit < 0) return pairSanitize(filtered);
    const sliced = sliceLastNTurns(filtered, turnsLimit);
    // Warn once per (sessionId, storeDir) when truncation drops turns
    // that no compact summary covers — the user is silently losing
    // older context otherwise. Cheap check: countTurns is O(N) over
    // already-loaded messages; we only run it when the slice actually
    // returned fewer rows than the full filtered set.
    if (sliced.length < filtered.length) {
      const totalTurns = countTurns(filtered);
      const returnedTurns = countTurns(sliced);
      if (returnedTurns < totalTurns) {
        const hasCompact = this.hasAnyCompactSummaryForSession(sessionId);
        maybeWarnHistoryTruncated(sessionId, this.#dir, totalTurns, returnedTurns, hasCompact);
      }
    }
    return pairSanitize(sliced);
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
   * VP-scoped view of group history, used by per-VP post-turn compact.
   *
   * Compact must operate on what the VP actually *saw* in its context,
   * not the union of every VP's tool calls/results — otherwise compact
   * tries to summarize tool transcripts that were never in this VP's
   * prompt window. The rule we settled on (with the user, 2026-06-01):
   *
   *   - User rows (no speakerVpId): KEEP — every VP sees the prompt.
   *   - This VP's own assistant rows + their paired tool rows: KEEP.
   *   - OTHER VPs' assistant rows: KEEP TEXT ONLY (strip toolCalls AND
   *     thinkingBlocks — thinking is VP-private per Anthropic's signed-
   *     block contract and would never appear in another VP's context).
   *   - OTHER VPs' tool result rows (role:'tool'): DROP — they pair with
   *     stripped tool_use ids and would orphan on replay.
   *   - Rows with `_reflection` / `internal` / `systemOnly`: DROP — they
   *     are engine-private and never enter another VP's context.
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
    const out = [];
    for (const m of all) {
      if (!m || m.sessionId !== sessionId) continue;
      if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) continue;
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
          // orphan tool_use ids in the compact input.
          const copy = { ...m };
          delete copy.toolCalls;
          delete copy.thinkingBlocks;
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
    // Note: we don't run `sliceLastNTurns` here. The caller
    // (#runOrchestratorCompact) decides what's "cooling" via
    // `partitionMessages`, and we don't want to pre-truncate before that
    // budget calc sees the full picture.
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
    const hot = this.#loadSessionHotMessages(sessionId);
    const cold = this.#loadSessionColdMessages(sessionId);
    // Cold ids strictly < hot ids by construction → chronological concat.
    const all = [...cold, ...hot];
    const cutoff = Number.isFinite(beforeSeq) ? beforeSeq : Infinity;
    const prefix = all.filter(m => m && m.sessionId === sessionId
      && parseSeqFromId(m.id) < cutoff);
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
  loadVisibleBySession(sessionId, beforeSeq, turnsLimit = DEFAULT_RECENT_TURNS) {
    if (!sessionId || !(turnsLimit > 0)) return { messages: [], oldestSeq: null, hasMore: false };

    const cutoff = Number.isFinite(beforeSeq) ? beforeSeq : Infinity;
    const page = this.#loadVisibleWindowBySession(
      [
        ...this.#sessionMessageDirs('messages', sessionId),
        this.#legacyMsgDir,
        ...this.#sessionMessageDirs('cold', sessionId),
        this.#legacyColdDir,
      ],
      sessionId,
      cutoff,
      turnsLimit
    );

    // Visible history is for UI replay, not LLM context. The visible loader
    // already excludes tool-result rows, so running pairSanitize here can
    // incorrectly treat tool-using assistant replies as orphaned tool arcs and
    // drop/trim VP messages. Strip tool-call metadata instead and keep the
    // user-visible assistant text for the conversation pane.
    const messages = page.messages.map(m => {
      if (m && m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        const { toolCalls, ...rest } = m;
        return { ...rest, toolSummaryCount: toolCalls.length };
      }
      return m;
    });
    const oldestSeq = messages.length ? parseSeqFromId(messages[0].id) : null;

    return {
      messages,
      oldestSeq: Number.isFinite(oldestSeq) ? oldestSeq : null,
      hasMore: page.hasMore,
    };
  }

  /**
   * Load messages strictly after a seq cursor, ordered by seq ascending.
   * Used by the web client to fetch "everything new since my latest known
   * message" when re-entering a session — the delta path.
   *
   * @param {string} sessionId
   * @param {number|null} afterSeq — exclusive lower bound
   * @param {{ limit?: number }} [opts]
   * @returns {{ messages: object[], latestSeq: number|null }}
   */
  loadAfterSeqByGroup(sessionId, afterSeq, opts = {}) {
    if (!sessionId) return { messages: [], latestSeq: null };
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 500;
    const cutoff = Number.isFinite(afterSeq) && afterSeq >= 0 ? afterSeq : null;
    if (cutoff === null) return { messages: [], latestSeq: null };
    const hot = this.#loadSessionHotMessages(sessionId);
    const cold = this.#loadSessionColdMessages(sessionId);
    const all = [...cold, ...hot].sort(compareMessagesBySeq);
    const after = all.filter((m) => {
      if (!m || m.sessionId !== sessionId) return false;
      if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) return false;
      const seq = parseSeqFromId(m.id);
      return Number.isFinite(seq) && seq > cutoff;
    });
    const sliced = pairSanitize(after.slice(0, limit));
    const lastSeq = sliced.length ? parseSeqFromId(sliced[sliced.length - 1].id) : null;
    return { messages: sliced, latestSeq: Number.isFinite(lastSeq) ? lastSeq : null };
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
   * Count hot messages.
   *
   * @returns {number}
   */
  countHot() {
    return this.#countFilesInDirs([this.#chatMsgDir, ...this.#sessionMessageDirs('messages'), this.#legacyMsgDir]);
  }

  /**
   * Count cold messages.
   *
   * @returns {number}
   */
  countCold() {
    return this.#countFilesInDirs([this.#chatColdDir, ...this.#sessionMessageDirs('cold'), this.#legacyColdDir]);
  }

  /**
   * Get total estimated tokens for hot messages.
   *
   * @returns {number}
   */
  hotTokens() {
    const messages = this.loadAll();
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
    // Invalidate cached next-seq — countHot/loadAll will re-scan.
    this.#nextSeq = null;
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
        if (!msg) continue;
        scanned += 1;
        const isOrphan = !msg.sessionId || !keep.has(msg.sessionId);
        if (!isOrphan) continue;
        orphans.push(path);
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
    if (removed > 0) this.#nextSeq = null;
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
        // Preserve original thread id for UI pill; only stamp once.
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

    // Collect source-thread candidate files from both hot + cold dirs.
    const candidates = [];
    for (const dir of [this.#chatColdDir, this.#chatMsgDir, ...this.#sessionMessageDirs('cold'), ...this.#sessionMessageDirs('messages'), this.#legacyColdDir, this.#legacyMsgDir]) {
      if (!existsSync(dir)) continue;
      let files;
      try {
        files = readdirSync(dir).filter(f => f.endsWith('.md'));
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
      for (const f of files) candidates.push(join(dir, f));
    }
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
    // Sort by the "m{NNNN}" basename. For chain-fork, sub-thread ids also
    // restart at m0001 so sorting by basename alone is ambiguous across
    // dirs; but a given source thread stores messages in exactly ONE place
    // (either legacy flat dir OR its sub-dir — see below), so ties never
    // arise. Sorting by (path, seq) is still well-defined.
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
    for (const path of candidates) {
      const fileMatch = path.match(/m(\d+)\.md$/);
      if (!fileMatch) continue;
      const seq = parseInt(fileMatch[1], 10);
      if (seq > cutoffSeq) continue; // do not break — sub-thread dir mixed in may interleave
      let raw;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
      const msg = parseMessage(raw);
      if (!msg || msg.threadId !== sourceId) continue;
      // Mint a fresh per-thread id restarting at m0001 under the target
      // thread's own namespace.
      const nextSeq = this.#getNextThreadSeq(targetId);
      const newId = `m${String(nextSeq).padStart(4, '0')}`;
      const { id: _id, ...rest } = msg;
      const copy = {
        ...rest,
        id: newId,
        threadId: targetId,
        sourceThreadId: msg.sourceThreadId || sourceId,
        time: rest.time || new Date().toISOString(),
        tokens_est: rest.tokens_est || estimateTokens(rest.content || ''),
      };
      const filePath = join(targetDir, `${newId}.md`);
      try {
        writeFileSync(filePath, serializeMessage(copy), { encoding: 'utf8', mode: 0o644 });
        this.#nextSeqByThread.set(targetId, nextSeq + 1);
        copied += 1;
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
    }
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
    // Legacy: messages live in the flat dir stamped with threadId.
    const collected = [];
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

  #messageDirFor(msg) {
    if (msg?.chatId) return join(this.#chatConversationDir(msg.chatId, { create: true }), 'messages');
    if (!msg?.sessionId) return this.#chatMsgDir;
    return join(this.#sessionConversationDir(msg.sessionId, { create: true }), 'messages');
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

  /** Per-chat scoped compact summary path. */
  #scopedChatCompactPath(chatId, vpId) {
    if (!chatId || !vpId) return null;
    const dir = join(this.#chatConversationDir(chatId, { create: true }), 'compact');
    return join(dir, `${this.#safeIdComponent(vpId)}.md`);
  }

  /** Read per-(chatId, vpId) compact summary. */
  readCompactSummaryForChat(chatId, vpId) {
    const p = this.#scopedChatCompactPath(chatId, vpId);
    if (!p || !existsSync(p)) return '';
    try { return readFileSync(p, 'utf8'); } catch { return ''; }
  }

  /** Rewrite per-(chatId, vpId) compact summary. */
  replaceCompactSummaryForChat(chatId, vpId, summary) {
    if (typeof summary !== 'string' || !summary) return;
    const p = this.#scopedChatCompactPath(chatId, vpId);
    if (!p) return;
    try { writeFileSync(p, summary, { encoding: 'utf8', mode: 0o644 }); }
    catch (err) {
      if (isPermissionError(err)) {
        if (!_permissionWarned) {
          console.warn(`[Yeaft] Cannot write scoped chat compact summary: ${err.code}`);
          _permissionWarned = true;
        }
      } else throw err;
    }
  }

  /** Recent messages for a chat — chat mode mirror of loadRecentBySession. */
  loadRecentByChat(chatId, turnsLimit = DEFAULT_RECENT_TURNS) {
    if (!chatId) return [];
    const all = [
      ...this.#chatMessageDirs('messages', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
      ...this.#chatMessageDirs('cold', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
    const filtered = all.filter(m => m && m.chatId === chatId);
    if (turnsLimit === Infinity || turnsLimit < 0) return pairSanitize(filtered);
    return pairSanitize(sliceLastNTurns(filtered, turnsLimit));
  }

  /** VP-scoped chat history — chat-mode mirror of loadSessionHistoryForVp. */
  loadChatHistoryForVp(chatId, vpId) {
    if (!chatId || !vpId) return [];
    const all = [
      ...this.#chatMessageDirs('messages', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
      ...this.#chatMessageDirs('cold', chatId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
    const out = [];
    for (const m of all) {
      if (!m || m.chatId !== chatId) continue;
      if (m._reflection || m.internal || m.systemOnly || m.systemOnlyMessage) continue;
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
    for (const d of [dir, join(dir, 'blobs'), join(dir, 'messages'), join(dir, 'cold'), join(dir, 'compact')]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o755 });
    }
  }

  #sessionConversationDirs() {
    const dirs = [];
    const seen = new Set();
    for (const root of [this.#sessionsDir, this.#legacySessionsDir]) {
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
    if (sessionId) {
      const dirs = [
        join(this.#sessionConversationDir(sessionId), kind),
        join(this.#legacySessionConversationDir(sessionId), kind),
      ];
      return dirs.filter(dir => existsSync(dir));
    }
    return this.#sessionConversationDirs()
      .map(dir => join(dir, kind))
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
      ...this.#loadFromDir(this.#legacyMsgDir, Infinity).filter(m => !m?.sessionId),
      ...this.#loadFromDir(this.#chatMsgDir, Infinity),
    ].sort(compareMessagesBySeq);
  }

  #loadSessionHotMessages(sessionId = null) {
    return [
      ...this.#loadFromDir(this.#legacyMsgDir, Infinity).filter(m => m?.sessionId),
      ...this.#sessionMessageDirs('messages', sessionId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
  }

  #loadSessionColdMessages(sessionId = null) {
    return [
      ...this.#loadFromDir(this.#legacyColdDir, Infinity).filter(m => m?.sessionId),
      ...this.#sessionMessageDirs('cold', sessionId).flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
  }

  #loadSessionMessages(sessionId = null) {
    return [...this.#loadSessionColdMessages(sessionId), ...this.#loadSessionHotMessages(sessionId)].sort(compareMessagesBySeq);
  }

  #loadAllMessages() {
    return [
      ...this.#loadFromDir(this.#legacyColdDir, Infinity),
      ...this.#loadFromDir(this.#legacyMsgDir, Infinity),
      ...this.#loadFromDir(this.#chatColdDir, Infinity),
      ...this.#loadFromDir(this.#chatMsgDir, Infinity),
      ...this.#sessionMessageDirs('cold').flatMap(dir => this.#loadFromDir(dir, Infinity)),
      ...this.#sessionMessageDirs('messages').flatMap(dir => this.#loadFromDir(dir, Infinity)),
    ].sort(compareMessagesBySeq);
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

  #loadVisibleWindowBySession(dirs, sessionId, beforeSeq, turnsLimit) {
    const candidates = [];
    const seen = new Set();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      let files = [];
      try {
        files = readdirSync(dir);
      } catch (err) {
        if (!isPermissionError(err)) throw err;
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const seq = parseSeqFromId(basename(file, '.md'));
        if (!Number.isFinite(seq) || seq >= beforeSeq) continue;
        const path = join(dir, file);
        if (seen.has(path)) continue;
        seen.add(path);
        candidates.push({ seq, path });
      }
    }

    candidates.sort((a, b) => b.seq - a.seq);

    const selected = [];
    const pendingBoundaryTail = [];
    let turnsSeen = 0;
    let openCanonical = null;
    let boundaryCanonical = null;
    let hasMore = false;

    for (const candidate of candidates) {
      let raw = '';
      try {
        raw = readFileSync(candidate.path, 'utf8');
      } catch (err) {
        if (!isPermissionError(err)) throw err;
        continue;
      }
      if (!raw.includes(`sessionId: ${sessionId}`)) continue;
      if (!raw.includes('role: user') && !raw.includes('role: assistant')) continue;

      const parsed = parseMessage(raw);
      if (!parsed || parsed.sessionId !== sessionId) continue;
      if (parsed._reflection || parsed.internal || parsed.systemOnly || parsed.systemOnlyMessage) continue;
      if (parsed.role !== 'user' && parsed.role !== 'assistant') continue;

      if (boundaryCanonical !== null) {
        if (parsed.role !== 'user') {
          pendingBoundaryTail.push(parsed);
          continue;
        }

        const canonical = canonicalUserTurnContent(parsed.content);
        if (canonical !== boundaryCanonical) {
          hasMore = true;
          break;
        }

        if (pendingBoundaryTail.length > 0) {
          selected.push(...pendingBoundaryTail.splice(0));
        }
        selected.push(parsed);
        continue;
      }

      selected.push(parsed);
      if (parsed.role === 'user') {
        const canonical = canonicalUserTurnContent(parsed.content);
        if (canonical != null && canonical !== openCanonical) {
          turnsSeen += 1;
          openCanonical = canonical;
          if (turnsSeen === turnsLimit) boundaryCanonical = canonical;
        }
      }
    }

    return { messages: selected.reverse(), hasMore };
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
      const parsed = parseMessage(raw);
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
