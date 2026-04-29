/**
 * memory/recall-v2.js — DESIGN-v2 Part II: scope-based memory recall.
 *
 * Recall under v2 is structurally different from R6: instead of selecting
 * individual entry shards by tag/keyword, we assemble per-scope `memory.md`
 * + `summary.md` for the scopes that are *known* to be relevant from the
 * current turn's context (always-include rules) plus the topic scopes whose
 * summary best matches the user's prompt keywords.
 *
 * Always-include scopes (no LLM):
 *   - user                              (every turn)
 *   - group/<groupId>                   (when groupId is provided)
 *   - vp/<vpId>                         (when vpId is provided AND not a foreign vp)
 *   - feature/<featureId>               (when featureId is provided)
 *
 * Topic scopes:
 *   - Score each topic by simple keyword overlap between the prompt's
 *     extracted keywords (via recall.js → extractKeywords) and the topic's
 *     `summary.md` body. Top-N by score join the bundle.
 *   - This is a heuristic — no LLM call. Topics that the dream pipeline
 *     created already correlate with the conversation's natural language,
 *     so a cheap keyword overlap is a good first cut.
 *
 * What this module deliberately does NOT do:
 *   - No LLM side-query. R6's recall.js does a 3rd-step LLM-select; v2
 *     skips it because the unit of selection is now whole scopes (5 + N
 *     topics) instead of dozens of individual entries.
 *   - No frontmatter parsing. memory.md is markdown; the dream-state tail
 *     marker is stripped before injection (so the LLM doesn't see internal
 *     bookkeeping bytes).
 *   - No write side effects. Pure read.
 *
 * Reference: agent/unify/memory/DESIGN-v2.md §6 (recall surface).
 */

import { join } from 'path';
import { promises as fsp, existsSync } from 'fs';

import {
  DEFAULT_MEMORY_ROOT, scopeDir, readMemory, readSummary,
} from './store-v2.js';
import { extractKeywords } from './keywords.js';

/** Default cap for how many topic scopes recall pulls in. */
export const DEFAULT_TOPIC_LIMIT = 3;

/** Marker block written by dream-v2/state.js — stripped from injection. */
const DREAM_MARKER_RE = /\n*<!-- dream-state -->[\s\S]*?<!-- \/dream-state -->\s*$/;

/**
 * Strip the trailing dream-state marker block (if any) from a memory.md body.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripDreamMarker(body) {
  if (!body || typeof body !== 'string') return '';
  return body.replace(DREAM_MARKER_RE, '').trimEnd();
}

/**
 * List all topic scopes present under <root>/topic/. Returns paths like
 * ['science', 'physics'] (level 1) or ['life', 'parenting'] (level 2).
 *
 * @param {string} root
 * @returns {Promise<string[][]>}
 */
async function listTopicPaths(root) {
  const out = [];
  const topicRoot = join(root, 'topic');
  if (!existsSync(topicRoot)) return out;
  let l1Names;
  try { l1Names = await fsp.readdir(topicRoot, { withFileTypes: true }); }
  catch { return out; }
  for (const e1 of l1Names) {
    if (!e1.isDirectory()) continue;
    if (e1.name.startsWith('.')) continue;
    // Level-1 topic is itself a scope (memory.md may sit at this level).
    out.push([e1.name]);
    // Walk one more level.
    let l2Names;
    try { l2Names = await fsp.readdir(join(topicRoot, e1.name), { withFileTypes: true }); }
    catch { continue; }
    for (const e2 of l2Names) {
      if (!e2.isDirectory()) continue;
      if (e2.name.startsWith('.')) continue;
      out.push([e1.name, e2.name]);
    }
  }
  return out;
}

/**
 * Score a topic by how many of its summary's tokens overlap the prompt's
 * keyword set. Topics with no summary score 0.
 *
 * @param {string} summary
 * @param {Set<string>} keywordSet
 * @returns {number}
 */
function scoreTopic(summary, keywordSet) {
  if (!summary || keywordSet.size === 0) return 0;
  const tokens = (summary.toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) || [])
    .filter(t => t.length > 1);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const t of tokens) {
    if (keywordSet.has(t)) hits += 1;
  }
  return hits;
}

/**
 * @typedef {Object} RecallV2Section
 * @property {string} scope         — human label, e.g. "user", "group/g-eng"
 * @property {string} kind          — 'user' | 'vp' | 'group' | 'feature' | 'topic'
 * @property {string} memory        — memory.md body (dream marker stripped)
 * @property {string} summary       — summary.md body
 */

/**
 * @typedef {Object} RecallV2Result
 * @property {RecallV2Section[]} sections
 * @property {string[]} keywords
 * @property {string} formatted     — ready to splice into the system prompt
 */

/**
 * Build a scope label suitable for the formatted block heading.
 *
 * @param {import('./store-v2.js').Scope} scope
 * @returns {string}
 */
export function scopeLabel(scope) {
  if (scope.kind === 'user') return 'user';
  if (scope.kind === 'topic') return `topic/${(scope.path || []).join('/')}`;
  return `${scope.kind}/${scope.id || ''}`;
}

/**
 * Format the bundle for direct injection into the system prompt.
 *
 * @param {RecallV2Section[]} sections
 * @returns {string}
 */
export function formatRecallV2(sections) {
  if (!sections || sections.length === 0) return '';
  const blocks = [];
  for (const s of sections) {
    const memBlock = s.memory ? s.memory.trim() : '';
    const sumBlock = s.summary ? s.summary.trim() : '';
    if (!memBlock && !sumBlock) continue;
    const parts = [`### ${s.scope}`];
    if (sumBlock) parts.push(`**Summary**\n${sumBlock}`);
    if (memBlock) parts.push(`**Memory**\n${memBlock}`);
    blocks.push(parts.join('\n\n'));
  }
  if (blocks.length === 0) return '';
  return ['## Recalled Memory (v2)', ...blocks].join('\n\n');
}

/**
 * Read one scope's pair (memory.md + summary.md) and translate to a section.
 * Returns null when both files are empty/missing or VP ACL refuses.
 *
 * @param {import('./store-v2.js').Scope} scope
 * @param {{ root: string, currentVpId?: string }} opts
 * @returns {Promise<RecallV2Section|null>}
 */
async function readScopeSection(scope, opts) {
  let memory = '';
  let summary = '';
  try { memory = stripDreamMarker(await readMemory(scope, opts)); }
  catch { return null; } // VP ACL or other → skip silently
  try { summary = await readSummary(scope, opts); } catch { /* */ }
  if (!memory && !summary) return null;
  return {
    scope: scopeLabel(scope),
    kind: scope.kind,
    memory,
    summary,
  };
}

/**
 * Recall v2: assemble per-scope memory.md + summary.md for the current turn.
 *
 * @param {Object} params
 * @param {string} params.prompt                    — the user's turn prompt
 * @param {string} [params.root]                    — memory root (defaults to DEFAULT_MEMORY_ROOT)
 * @param {string} [params.groupId]                 — active group, if any
 * @param {string} [params.vpId]                    — active VP for this turn (NOT used as ACL)
 * @param {string} [params.currentVpId]             — current session's VP, gates vp/<other> reads
 * @param {string} [params.featureId]               — active feature, if any
 * @param {number} [params.topicLimit]              — cap on topic scopes (default DEFAULT_TOPIC_LIMIT)
 * @returns {Promise<RecallV2Result>}
 */
export async function recallV2({
  prompt,
  root = DEFAULT_MEMORY_ROOT,
  groupId,
  vpId,
  currentVpId,
  featureId,
  topicLimit = DEFAULT_TOPIC_LIMIT,
} = {}) {
  const sections = [];
  const opts = { root, currentVpId };
  const keywords = extractKeywords(prompt || '');

  // Always: user.
  const userSec = await readScopeSection({ kind: 'user' }, opts);
  if (userSec) sections.push(userSec);

  // Conditional: group/<groupId>
  if (groupId && typeof groupId === 'string' && groupId !== '_no-group') {
    const sec = await readScopeSection({ kind: 'group', id: groupId }, opts);
    if (sec) sections.push(sec);
  }

  // Conditional: vp/<vpId>
  if (vpId && typeof vpId === 'string') {
    const sec = await readScopeSection({ kind: 'vp', id: vpId }, opts);
    if (sec) sections.push(sec);
  }

  // Conditional: feature/<featureId>
  if (featureId && typeof featureId === 'string') {
    const sec = await readScopeSection({ kind: 'feature', id: featureId }, opts);
    if (sec) sections.push(sec);
  }

  // Topics: rank by keyword overlap on summary.
  if (topicLimit > 0 && keywords.length > 0) {
    const keywordSet = new Set(keywords.map(k => k.toLowerCase()));
    const candidates = [];
    const paths = await listTopicPaths(root);
    for (const path of paths) {
      const scope = { kind: 'topic', path };
      let summary = '';
      try { summary = await readSummary(scope, opts); } catch { /* */ }
      const score = scoreTopic(summary, keywordSet);
      if (score > 0) candidates.push({ scope, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates.slice(0, topicLimit)) {
      const sec = await readScopeSection(c.scope, opts);
      if (sec) sections.push(sec);
    }
  }

  return {
    sections,
    keywords,
    formatted: formatRecallV2(sections),
  };
}
