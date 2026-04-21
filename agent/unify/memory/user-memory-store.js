/**
 * user-memory-store.js — R6 §Δ29 User-memory store + dream + profile builder.
 *
 * Wraps the R6 shard-store (task-334f) with user-specific semantics:
 *   - 5 shards: profile / preferences / projects / goals / relations
 *   - Storage path: ~/.yeaft/user/memory/
 *   - UserDreamJob: reuses dream-shard.js compact framework
 *   - buildUserProfile(): top-N recall for SEMI-DYNAMIC injection
 *
 * Hard constraints:
 *   - No VP/task memory imports (user memory is orthogonal)
 *   - Never throws from public API — best-effort with console.warn fallback
 */

import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { openMemoryShardStore } from './shard-store.js';
import { USER_SHARDS } from './schema.js';
import { scanShards, runCompactJob } from './dream-shard.js';
import { pickEffort } from '../effort.js';

/** Default storage root for user memory. */
export const USER_MEMORY_DIR = join(homedir(), '.yeaft', 'user', 'memory');

/** Maximum entries to include in the user_profile prompt segment. */
const PROFILE_TOP_N = 5;

/** Shard priority for profile builder recall (most → least relevant). */
const PROFILE_RECALL_SHARDS = ['profile', 'preferences', 'goals'];

// ─── Lazy singleton ───────────────────────────────────────────

/** @type {ReturnType<typeof openMemoryShardStore> | null} */
let _store = null;

/**
 * Get (or lazily create) the process-singleton user-memory shard store.
 * Returns null on failure (missing dir, permissions, etc.) — caller must
 * handle null gracefully.
 *
 * @param {{ dir?: string }} [opts]
 * @returns {ReturnType<typeof openMemoryShardStore> | null}
 */
export function getUserMemoryStore(opts = {}) {
  if (_store) return _store;
  try {
    const dir = opts.dir || USER_MEMORY_DIR;
    _store = openMemoryShardStore(dir, 'user');
    return _store;
  } catch (err) {
    console.warn('[user-memory-store] failed to open store:', err.message);
    return null;
  }
}

/**
 * Close and reset the singleton. Used by tests.
 */
export function _resetUserMemoryStoreForTest() {
  if (_store) {
    try { _store.close(); } catch { /* ignore */ }
  }
  _store = null;
}

/**
 * Open a fresh (non-singleton) user-memory store at an arbitrary dir.
 * Useful for tests that want isolation.
 */
export function openUserMemoryStore(dir) {
  return openMemoryShardStore(dir, 'user');
}

// ─── Write / Remove ──────────────────────────────────────────

/**
 * Classify user-memory text into a shard based on simple heuristics.
 * Falls back to 'profile' when uncertain.
 *
 * @param {string} text
 * @param {string[]} [tags]
 * @returns {string}
 */
export function classifyUserMemoryShard(text, tags) {
  const lower = (text || '').toLowerCase();
  const tagSet = new Set((tags || []).map(t => t.toLowerCase()));

  // Explicit tag hints
  if (tagSet.has('goal') || tagSet.has('goals')) return 'goals';
  if (tagSet.has('project') || tagSet.has('projects')) return 'projects';
  if (tagSet.has('preference') || tagSet.has('preferences')) return 'preferences';
  if (tagSet.has('relation') || tagSet.has('relations')) return 'relations';
  if (tagSet.has('profile')) return 'profile';

  // Keyword heuristics
  if (/\b(goal|objective|target|aim|aspir|want to|plan to|hope to)\b/i.test(lower)) return 'goals';
  if (/\b(project|repo|codebase|app|application|product)\b/i.test(lower)) return 'projects';
  if (/\b(prefer|like|dislike|style|format|tone|language|dark mode|theme)\b/i.test(lower)) return 'preferences';
  if (/\b(colleague|friend|team|manager|report|partner|contact|person)\b/i.test(lower)) return 'relations';

  return 'profile';
}

/**
 * Ingest a user-memory write. Returns the entryId on success, null on failure.
 *
 * @param {object} store — user-memory shard store
 * @param {{ text: string, tags?: string[], sourceRef?: object }} params
 * @returns {string|null} entryId
 */
export function writeUserMemory(store, { text, tags, sourceRef }) {
  if (!store || !text || typeof text !== 'string' || !text.trim()) return null;
  try {
    const shard = classifyUserMemoryShard(text, tags);
    const id = `um-${randomUUID().slice(0, 12)}`;
    const entry = {
      id,
      shard,
      kind: 'preference', // user-memory entries are preference-kind (no sourceRef required)
      body: text.trim(),
      tags: Array.isArray(tags) ? tags.slice() : [],
      authoredBy: 'user:self',
    };
    store.put(entry);
    return id;
  } catch (err) {
    console.warn('[user-memory-store] write failed:', err.message);
    return null;
  }
}

/**
 * Remove a user-memory entry by id. Returns true on success.
 *
 * @param {object} store
 * @param {string} entryId
 * @returns {boolean}
 */
export function removeUserMemory(store, entryId) {
  if (!store || !entryId) return false;
  try {
    store.remove(entryId);
    return true;
  } catch (err) {
    console.warn('[user-memory-store] remove failed:', err.message);
    return false;
  }
}

// ─── Profile Builder ─────────────────────────────────────────

/**
 * Build the `user_profile` text segment for SEMI-DYNAMIC prompt injection.
 * Reads top-N entries from profile/preferences/goals shards and formats
 * them as a compact bullet list.
 *
 * @param {object} [store] — user-memory shard store (uses singleton if omitted)
 * @param {{ maxEntries?: number }} [opts]
 * @returns {string} — empty string if no user-memory exists
 */
export function buildUserProfile(store, opts = {}) {
  const s = store || getUserMemoryStore();
  if (!s) return '';

  const max = opts.maxEntries || PROFILE_TOP_N;
  const lines = [];

  try {
    for (const shardName of PROFILE_RECALL_SHARDS) {
      if (lines.length >= max) break;
      const { results } = s.query({ shard: shardName });
      // Filter out superseded entries
      const live = results.filter(r => !r.supersededBy);
      // Take most recent first (results are already ordered by storage)
      for (const rec of live) {
        if (lines.length >= max) break;
        const full = s.get(rec.id);
        if (!full || !full.body) continue;
        const body = full.body.trim();
        if (!body) continue;
        lines.push(`- ${body}`);
      }
    }
  } catch (err) {
    console.warn('[user-memory-store] buildUserProfile failed:', err.message);
    return '';
  }

  return lines.join('\n');
}

// ─── Dream Job ───────────────────────────────────────────────

/**
 * Run user-memory dream maintenance: extract phase + compact.
 * Extract reads conversation messages since the last watermark, uses LLM to
 * identify user-relevant facts, then writes them to the appropriate shards.
 * Compact phase reclaims superseded/removed tombstones (unchanged from 334g).
 *
 * @param {{
 *   store?: object,
 *   conversationStore?: object,
 *   adapter?: object,
 *   config?: object,
 *   onPhase?: (phase: string, data: any) => void,
 * }} [opts]
 * @returns {Promise<{ extract: object|null, scan: object, compact: object } | null>}
 */
export async function runUserDreamJob(opts = {}) {
  const store = 'store' in opts ? opts.store : getUserMemoryStore();
  if (!store) return null;

  let extractResult = null;

  try {
    // ── Phase 1: Extract (LLM) ─────────────────────────────
    if (opts.conversationStore && opts.adapter && opts.config) {
      opts.onPhase?.('extract', 'starting');
      try {
        extractResult = await dreamExtract({
          store,
          conversationStore: opts.conversationStore,
          adapter: opts.adapter,
          config: opts.config,
        });
        opts.onPhase?.('extract', extractResult);
      } catch (err) {
        console.warn('[user-memory-store] extract phase failed:', err.message);
        extractResult = { error: err.message, extracted: 0 };
      }
    }

    // ── Phase 2: Compact ───────────────────────────────────
    const scan = scanShards(store);
    const compact = runCompactJob({
      shardStore: store,
      shardNames: scan.needsCompaction,
      onCompact: opts.onPhase
        ? (shard, r) => opts.onPhase('compact', { shard, ...r })
        : undefined,
    });
    return {
      extract: extractResult,
      scan: { totalEntries: scan.totalEntries, totalBytes: scan.totalBytes },
      compact,
    };
  } catch (err) {
    console.warn('[user-memory-store] dream job failed:', err.message);
    return null;
  }
}

// ─── Watermark ──────────────────────────────────────────────

/**
 * Watermark format (shared with 334-w7b):
 *   { lastMessageId: string, lastMessageTs: number, updatedAt: string }
 *
 * Stored at <storeDir>/.watermark.json (alongside shard files).
 */

const WATERMARK_FILE = '.watermark.json';

/**
 * Read the extract watermark for a user-memory store.
 * Returns null if no watermark exists yet.
 *
 * @param {string} dir — store directory (e.g. ~/.yeaft/user/memory)
 * @returns {{ lastMessageId: string, lastMessageTs: number, updatedAt: string } | null}
 */
export function readWatermark(dir) {
  try {
    const p = join(dir, WATERMARK_FILE);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write the extract watermark.
 *
 * @param {string} dir
 * @param {{ lastMessageId: string, lastMessageTs: number }} wm
 */
export function writeWatermark(dir, wm) {
  try {
    const p = join(dir, WATERMARK_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({
      lastMessageId: wm.lastMessageId,
      lastMessageTs: wm.lastMessageTs,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.warn('[user-memory-store] writeWatermark failed:', err.message);
  }
}

// ─── Extract Phase ──────────────────────────────────────────

/** Max messages to process in a single extract pass. */
const EXTRACT_MAX_MESSAGES = 50;

/** Min messages required to trigger an extract. */
const EXTRACT_MIN_MESSAGES = 3;

/**
 * Build the user-memory extraction prompt.
 * Tailored for user-relevant facts (not VP/task memory).
 *
 * @param {object[]} messages
 * @returns {string}
 */
export function buildUserExtractPrompt(messages) {
  const conversation = messages.map(m => {
    const prefix = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
    return `[${prefix}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
  }).join('\n\n');

  return `Analyze the following conversation and extract facts about THE USER that are worth remembering long-term.

Focus on these categories:
- **profile**: Name, job title, company, location, background, expertise areas
- **preferences**: Coding style, tool preferences, language preferences, communication style
- **projects**: Projects they work on, tech stacks, repositories, products
- **goals**: Current goals, objectives, what they're trying to achieve
- **relations**: Team members, colleagues, managers, collaborators mentioned

For each fact, provide:
- **shard**: One of: profile, preferences, projects, goals, relations
- **body**: 1-2 sentences describing the fact clearly
- **tags**: 1-3 keyword tags as an array

Do NOT extract:
- Specific code snippets or technical instructions
- Temporary debugging context
- Facts about the assistant (only about the user)
- Information already implied by the conversation being about coding

Return a JSON array. If nothing about the user is worth remembering, return [].

Conversation:
${conversation}`;
}

/**
 * Extract user-relevant facts from conversation messages and write to user-memory shards.
 *
 * @param {{
 *   store: object,
 *   conversationStore: object,
 *   adapter: object,
 *   config: object,
 *   dir?: string,
 * }} params
 * @returns {Promise<{ extracted: number, skipped: number, watermark: object|null }>}
 */
export async function dreamExtract({ store, conversationStore, adapter, config, dir }) {
  const storeDir = dir || USER_MEMORY_DIR;
  const wm = readWatermark(storeDir);

  // Load all messages and filter to those after watermark
  const allMessages = conversationStore.loadAll();
  let newMessages;

  if (wm && wm.lastMessageId) {
    const idx = allMessages.findIndex(m => m.id === wm.lastMessageId);
    newMessages = idx >= 0 ? allMessages.slice(idx + 1) : allMessages;
  } else {
    // No watermark — process all messages (first run)
    newMessages = allMessages;
  }

  // Filter to user + assistant messages only (skip system)
  newMessages = newMessages.filter(m => m.role === 'user' || m.role === 'assistant');

  if (newMessages.length < EXTRACT_MIN_MESSAGES) {
    return { extracted: 0, skipped: 0, watermark: wm };
  }

  // Cap to prevent huge LLM calls
  const batch = newMessages.slice(-EXTRACT_MAX_MESSAGES);

  // LLM extraction call
  const system = 'You are a user profile extraction assistant. Analyze conversations and extract facts about the user. Return ONLY a valid JSON array, no other text.';
  const prompt = buildUserExtractPrompt(batch);

  let candidates = [];
  try {
    const result = await adapter.call({
      model: config.model || config.primaryModel || 'default',
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
      effort: pickEffort({ scenario: 'dream' }),
    });

    const text = result.text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      candidates = JSON.parse(jsonMatch[0]);
    }
  } catch {
    return { extracted: 0, skipped: 0, watermark: wm, error: 'llm_failed' };
  }

  if (!Array.isArray(candidates)) {
    return { extracted: 0, skipped: 0, watermark: wm };
  }

  // Validate and write candidates
  let extracted = 0;
  let skipped = 0;

  for (const c of candidates) {
    if (!c || typeof c !== 'object' || !c.body) { skipped++; continue; }

    // Use classifyUserMemoryShard if shard not provided or invalid
    const shard = USER_SHARDS.includes(c.shard)
      ? c.shard
      : classifyUserMemoryShard(c.body, c.tags);

    const id = writeUserMemory(store, {
      text: c.body,
      tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
      sourceRef: { origin: 'dream-extract' },
    });

    if (id) {
      extracted++;
    } else {
      skipped++;
    }
  }

  // Update watermark to last processed message
  const lastMsg = batch[batch.length - 1];
  if (lastMsg) {
    const newWm = {
      lastMessageId: lastMsg.id || '',
      lastMessageTs: lastMsg.ts || Date.now(),
    };
    writeWatermark(storeDir, newWm);
    return { extracted, skipped, watermark: newWm };
  }

  return { extracted, skipped, watermark: wm };
}
