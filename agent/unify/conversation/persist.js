/**
 * persist.js — Conversation message persistence
 *
 * Each message is stored as a .md file with YAML frontmatter in
 * ~/.yeaft/conversation/messages/. Design: zero JSON, all Markdown.
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
 * Reference: yeaft-unify-core-systems.md §4.1, yeaft-unify-brainstorm-v5.1.md
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { isPermissionError } from '../init.js';

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
  if (msg.isError) fm.push(`isError: true`);
  // task-307: every message is stamped with a threadId so multi-thread
  // routing can filter/replay by thread without rescanning JSON blobs.
  // Defaults to 'main' for legacy messages (see migrate-messages-threadid.js).
  fm.push(`threadId: ${msg.threadId || 'main'}`);
  // task-313: when a thread is merged into another, the messages keep
  // their original thread id in `sourceThreadId` so the UI can still
  // render a small "#source" pill next to each bubble.
  if (msg.sourceThreadId) fm.push(`sourceThreadId: ${msg.sourceThreadId}`);

  // Token estimate
  const content = msg.content || '';
  const tokensEst = msg.tokens_est || estimateTokens(content);
  fm.push(`tokens_est: ${tokensEst}`);

  // Tool calls as YAML array (simplified)
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    fm.push(`toolCalls:`);
    for (const tc of msg.toolCalls) {
      fm.push(`  - id: ${tc.id}`);
      fm.push(`    name: ${tc.name}`);
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
      case 'isError': msg.isError = value === 'true'; break;
      case 'tokens_est': msg.tokens_est = parseInt(value, 10); break;
      case 'threadId': msg.threadId = value; break;
      case 'sourceThreadId': msg.sourceThreadId = value; break;
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
          const trimmed = line.trim();
          const ci = trimmed.indexOf(':');
          if (ci === -1) continue;
          const k = trimmed.slice(0, ci).trim();
          const v = trimmed.slice(ci + 1).trim();
          if (k === 'id') tc.id = v;
          if (k === 'name') tc.name = v;
        }
        if (tc.id && tc.name) toolCalls.push(tc);
      }
    }
    if (toolCalls.length > 0) msg.toolCalls = toolCalls;
  }

  return msg;
}

// ─── ConversationStore ───────────────────────────────────────

/**
 * ConversationStore — persist and load messages to/from disk.
 *
 * Directory layout:
 *   conversation/
 *     index.md       — message index with frontmatter
 *     compact.md     — cumulative compact summary
 *     messages/      — hot messages (mNNNN.md)
 *     cold/          — archived messages (moved from messages/)
 *     blobs/         — attachments (never moved)
 */
export class ConversationStore {
  #dir;         // root dir (e.g. ~/.yeaft)
  #convDir;     // ~/.yeaft/conversation
  #msgDir;      // ~/.yeaft/conversation/messages
  #coldDir;     // ~/.yeaft/conversation/cold
  #indexPath;   // ~/.yeaft/conversation/index.md
  #compactPath; // ~/.yeaft/conversation/compact.md
  #nextSeq;     // next message sequence number

  /**
   * @param {string} dir — Yeaft root directory (e.g. ~/.yeaft)
   */
  constructor(dir) {
    this.#dir = dir;
    this.#convDir = join(dir, 'conversation');
    this.#msgDir = join(dir, 'conversation', 'messages');
    this.#coldDir = join(dir, 'conversation', 'cold');
    this.#indexPath = join(dir, 'conversation', 'index.md');
    this.#compactPath = join(dir, 'conversation', 'compact.md');
    this.#nextSeq = null;

    // Ensure directories exist (graceful on permission errors)
    for (const d of [this.#convDir, this.#msgDir, this.#coldDir]) {
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

    const filePath = join(this.#msgDir, `${id}.md`);
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
    const src = join(this.#msgDir, `${id}.md`);
    const dst = join(this.#coldDir, `${id}.md`);
    if (existsSync(src)) {
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
   * Update the compact summary (cumulative).
   *
   * @param {string} summary — new summary to append
   */
  updateCompactSummary(summary) {
    let existing = '';
    if (existsSync(this.#compactPath)) {
      existing = readFileSync(this.#compactPath, 'utf8');
    }

    const date = new Date().toISOString().split('T')[0];
    const entry = `\n## ${date}\n\n${summary}\n`;
    try {
      writeFileSync(this.#compactPath, existing + entry, { encoding: 'utf8', mode: 0o644 });
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
    if (!existsSync(this.#compactPath)) return '';
    return readFileSync(this.#compactPath, 'utf8');
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
    for (const dir of [this.#msgDir, this.#coldDir]) {
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
    // Reset compact
    if (existsSync(this.#compactPath)) {
      try {
        writeFileSync(this.#compactPath, '', { encoding: 'utf8', mode: 0o644 });
      } catch (err) {
        if (!isPermissionError(err)) throw err;
      }
    }
    this.#nextSeq = 1;
    this.updateIndex({ totalMessages: 0, lastMessageId: null });
  }

  // ─── Read API ───────────────────────────────────────────

  /**
   * Load recent hot messages, sorted by id (chronological).
   *
   * @param {number} [limit=50] — max messages to load
   * @returns {object[]} — parsed message objects
   */
  loadRecent(limit = 50) {
    return this.#loadFromDir(this.#msgDir, limit);
  }

  /**
   * Load all hot messages.
   *
   * @returns {object[]}
   */
  loadAll() {
    return this.#loadFromDir(this.#msgDir, Infinity);
  }

  /**
   * Count hot messages.
   *
   * @returns {number}
   */
  countHot() {
    if (!existsSync(this.#msgDir)) return 0;
    return readdirSync(this.#msgDir).filter(f => f.endsWith('.md')).length;
  }

  /**
   * Count cold messages.
   *
   * @returns {number}
   */
  countCold() {
    if (!existsSync(this.#coldDir)) return 0;
    return readdirSync(this.#coldDir).filter(f => f.endsWith('.md')).length;
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
    for (const dir of [this.#msgDir, this.#coldDir]) {
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
    // Collect candidate files from both dirs, then sort by the m-id suffix
    // so chronological order holds across hot/cold boundary.
    const candidates = [];
    for (const dir of [this.#coldDir, this.#msgDir]) {
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
    // Sort by the "m{NNNN}" basename, which is chronological.
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
      if (seq > cutoffSeq) break; // ordered; past the cutoff → done
      let raw;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
      const msg = parseMessage(raw);
      if (!msg || msg.threadId !== sourceId) continue;
      // Strip id/time — append() will mint a fresh sequence id for the
      // copy. Stamp sourceThreadId (only if not already set; for
      // fork-of-fork, keep the original source pill).
      const { id: _id, ...rest } = msg;
      const copy = {
        ...rest,
        threadId: targetId,
        sourceThreadId: msg.sourceThreadId || sourceId,
      };
      try {
        this.append(copy);
        copied += 1;
      } catch (err) {
        if (isPermissionError(err)) continue;
        throw err;
      }
    }
    return copied;
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
    for (const dir of [this.#msgDir, this.#coldDir]) {
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
