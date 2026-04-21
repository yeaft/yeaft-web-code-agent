/**
 * dream-extract.js — R6 §Δ26 Phase A: Extract memories from conversation.
 *
 * Reads un-ingested messages from the group coordinator JSONL log,
 * calls the LLM to extract memory-worthy candidates, then deduplicates
 * each candidate against the existing shard store before writing.
 *
 * Watermark: tracks the last-ingested message id in a JSON file
 * at `<memoryDir>/extract-watermark.json`.
 *
 * Dedup classification per candidate:
 *   - is_duplicate → skip (already exists)
 *   - is_update    → supersede old entry with new
 *   - is_new       → write fresh entry
 */

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { writeAtomic } from '../storage/index.js';
import { pickEffort } from '../effort.js';
import { classifyUserMemoryShard } from './user-memory-store.js';

// ─── Watermark ────────────────────────────────────────────────

const WATERMARK_FILE = 'extract-watermark.json';

/**
 * Read the extract watermark (last processed message id).
 * @param {string} memoryDir
 * @returns {{ lastMsgId: string|null, lastTs: string|null }}
 */
export function readWatermark(memoryDir) {
  const p = join(memoryDir, WATERMARK_FILE);
  if (!existsSync(p)) return { lastMsgId: null, lastTs: null };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { lastMsgId: null, lastTs: null };
  }
}

/**
 * Write the extract watermark.
 * @param {string} memoryDir
 * @param {{ lastMsgId: string, lastTs: string }} wm
 */
export function writeWatermark(memoryDir, wm) {
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
  writeAtomic(join(memoryDir, WATERMARK_FILE), JSON.stringify(wm, null, 2));
}

// ─── Message Collection ───────────────────────────────────────

/**
 * Collect messages from the group log that are newer than the watermark.
 *
 * @param {import('../groups/group-store.js').GroupHandle} group
 * @param {{ lastMsgId: string|null }} watermark
 * @param {{ maxMessages?: number }} [opts]
 * @returns {{ messages: object[], lastMsg: object|null }}
 */
export function collectNewMessages(group, watermark, opts = {}) {
  const max = opts.maxMessages || 200;
  const messages = [];
  let pastWatermark = !watermark.lastMsgId; // if no watermark, take all
  let lastMsg = null;

  for (const msg of group.streamMessages()) {
    if (!pastWatermark) {
      if (msg.id === watermark.lastMsgId) {
        pastWatermark = true;
      }
      continue;
    }
    // Only include user and assistant messages (skip system/meta)
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push(msg);
      lastMsg = msg;
    }
    if (messages.length >= max) break;
  }

  return { messages, lastMsg };
}

// ─── LLM Extraction ──────────────────────────────────────────

/**
 * Build the extraction prompt for dream-extract.
 * Reuses the pattern from extract.js but outputs R6-compatible entries.
 */
function buildDreamExtractionPrompt(messages) {
  const conversation = messages.map(m => {
    const prefix = m.role === 'user' ? 'User' : 'Assistant';
    const text = typeof m.text === 'string' ? m.text : String(m.text || '');
    return `[${prefix}]: ${text}`;
  }).join('\n\n');

  return `Analyze the following conversation and extract any information worth saving to long-term memory.

For each memory, provide:
- **body**: 1-3 sentences describing the memory (concise, factual)
- **kind**: One of: fact, preference, skill, lesson, context, relation
- **tags**: Relevant keywords as a string array
- **importance**: "high", "normal", or "low"

Memory kinds:
- fact: Objective facts about the user or their work
- preference: User preferences (coding style, tools, habits)
- skill: Techniques or patterns the user uses or is learning
- lesson: Lessons learned, pitfalls, debugging insights
- context: Current project context, OKRs, deadlines
- relation: People, teams, roles the user mentions

Do NOT extract:
- Specific code snippets (too large, become stale)
- Temporary debugging info
- Trivial greetings or small talk
- Information already obviously known (like "user asked me a question")

Return a JSON array. If nothing is worth remembering, return [].

Conversation:
${conversation}`;
}

/**
 * Call LLM to extract memory candidates from messages.
 *
 * @param {{ messages: object[], adapter: object, config: object }} params
 * @returns {Promise<object[]>} — extracted candidates
 */
export async function extractCandidates({ messages, adapter, config }) {
  if (!messages || messages.length === 0) return [];

  const system = 'You are a memory extraction assistant. Analyze conversations and extract important facts, preferences, and lessons. Return ONLY a valid JSON array, no other text.';
  const prompt = buildDreamExtractionPrompt(messages);

  try {
    const result = await adapter.call({
      model: config.model || config.primaryModel || 'default',
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
      effort: pickEffort({ scenario: 'consolidate' }),
    });

    const text = (result.text || '').trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const entries = JSON.parse(jsonMatch[0]);
    return entries
      .filter(e => e && typeof e === 'object' && e.body)
      .map(e => ({
        body: String(e.body).slice(0, 500),
        kind: ['fact', 'preference', 'skill', 'lesson', 'context', 'relation'].includes(e.kind) ? e.kind : 'fact',
        tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
        importance: ['high', 'normal', 'low'].includes(e.importance) ? e.importance : 'normal',
      }));
  } catch {
    return [];
  }
}

// ─── Dedup / Similarity ──────────────────────────────────────

/**
 * Classify a candidate against existing shard entries.
 *
 * Simple heuristic (no LLM): normalized text overlap.
 *   - Exact body match → is_duplicate
 *   - >60% word overlap with existing → is_update (supersede)
 *   - Otherwise → is_new
 *
 * @param {object} candidate — { body, kind, tags }
 * @param {object[]} existingEntries — thin entries with body loaded
 * @returns {{ action: 'is_duplicate'|'is_update'|'is_new', matchId?: string }}
 */
export function classifyCandidate(candidate, existingEntries) {
  if (!candidate || !candidate.body) return { action: 'is_new' };
  if (!existingEntries || existingEntries.length === 0) return { action: 'is_new' };

  const candWords = normalizeWords(candidate.body);
  if (candWords.size === 0) return { action: 'is_new' };

  let bestOverlap = 0;
  let bestId = null;

  for (const entry of existingEntries) {
    const entryBody = entry.body || '';
    if (!entryBody) continue;

    // Exact match
    if (entryBody.trim().toLowerCase() === candidate.body.trim().toLowerCase()) {
      return { action: 'is_duplicate', matchId: entry.id };
    }

    // Word overlap
    const entryWords = normalizeWords(entryBody);
    if (entryWords.size === 0) continue;
    let overlap = 0;
    for (const w of candWords) {
      if (entryWords.has(w)) overlap++;
    }
    const ratio = overlap / Math.max(candWords.size, entryWords.size);
    if (ratio > bestOverlap) {
      bestOverlap = ratio;
      bestId = entry.id;
    }
  }

  if (bestOverlap > 0.6 && bestId) {
    return { action: 'is_update', matchId: bestId };
  }
  return { action: 'is_new' };
}

function normalizeWords(text) {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2)
  );
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Run dream extract: read new messages, LLM extract, dedup, write.
 *
 * @param {{
 *   group: import('../groups/group-store.js').GroupHandle,
 *   shardStore: object,
 *   adapter: object,
 *   config: object,
 *   memoryDir: string,
 *   onPhase?: (phase: string, data: any) => void,
 *   maxMessages?: number,
 * }} opts
 * @returns {Promise<DreamExtractResult>}
 */
export async function dreamExtract(opts) {
  const { group, shardStore, adapter, config, memoryDir, onPhase, maxMessages } = opts;

  const result = {
    messagesRead: 0,
    candidatesExtracted: 0,
    written: 0,
    updated: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  if (!group || !shardStore || !adapter) {
    return result;
  }

  try {
    // 1. Read watermark + collect new messages
    onPhase?.('collect', 'starting');
    const wm = readWatermark(memoryDir);
    const { messages, lastMsg } = collectNewMessages(group, wm, { maxMessages });
    result.messagesRead = messages.length;
    onPhase?.('collect', { count: messages.length });

    if (messages.length === 0) return result;

    // 2. LLM extraction
    onPhase?.('extract', 'starting');
    const candidates = await extractCandidates({ messages, adapter, config });
    result.candidatesExtracted = candidates.length;
    onPhase?.('extract', { count: candidates.length });

    if (candidates.length === 0) {
      // Still advance watermark — we read the messages, just nothing to extract
      if (lastMsg) {
        writeWatermark(memoryDir, { lastMsgId: lastMsg.id, lastTs: lastMsg.ts || new Date().toISOString() });
      }
      return result;
    }

    // 3. Load existing entries for dedup comparison
    const existingByBody = loadExistingBodies(shardStore);

    // 4. Dedup + write each candidate
    onPhase?.('dedup', 'starting');
    for (const candidate of candidates) {
      try {
        const classification = classifyCandidate(candidate, existingByBody);

        switch (classification.action) {
          case 'is_duplicate':
            result.duplicatesSkipped++;
            break;

          case 'is_update': {
            // Supersede old entry
            const shard = classifyUserMemoryShard(candidate.body, candidate.tags);
            const newId = `de-${randomUUID().slice(0, 12)}`;
            shardStore.supersede({
              newEntry: {
                id: newId,
                shard,
                kind: candidate.kind || 'fact',
                body: candidate.body,
                tags: candidate.tags || [],
                sourceRef: { hint: 'dream-extract' },
                authoredBy: 'dream:extract',
              },
              oldIds: [classification.matchId],
            });
            result.updated++;
            break;
          }

          case 'is_new':
          default: {
            const shard = classifyUserMemoryShard(candidate.body, candidate.tags);
            const newId = `de-${randomUUID().slice(0, 12)}`;
            shardStore.put({
              id: newId,
              shard,
              kind: candidate.kind || 'fact',
              body: candidate.body,
              tags: candidate.tags || [],
              sourceRef: { hint: 'dream-extract' },
              authoredBy: 'dream:extract',
            });
            result.written++;
            break;
          }
        }
      } catch (err) {
        result.errors.push(`write candidate: ${err.message}`);
      }
    }
    onPhase?.('dedup', { written: result.written, updated: result.updated, skipped: result.duplicatesSkipped });

    // 5. Advance watermark
    if (lastMsg) {
      writeWatermark(memoryDir, { lastMsgId: lastMsg.id, lastTs: lastMsg.ts || new Date().toISOString() });
    }

  } catch (err) {
    result.errors.push(err.message);
  }

  return result;
}

/**
 * Load all existing entry bodies (for dedup comparison).
 * Returns array of { id, body } objects.
 */
function loadExistingBodies(shardStore) {
  const entries = [];
  try {
    const st = shardStore.stats();
    for (const shardName of Object.keys(st.shards)) {
      const { results } = shardStore.query({ shard: shardName });
      for (const rec of results) {
        if (rec.supersededBy) continue;
        const full = shardStore.get(rec.id);
        if (full && full.body) {
          entries.push({ id: rec.id, body: full.body });
        }
      }
    }
  } catch { /* best effort */ }
  return entries;
}

/**
 * @typedef {Object} DreamExtractResult
 * @property {number} messagesRead
 * @property {number} candidatesExtracted
 * @property {number} written
 * @property {number} updated
 * @property {number} duplicatesSkipped
 * @property {string[]} errors
 */
