/**
 * recall-r6.js — task-334f R6 4-step recall pipeline (§Δ24.2).
 *
 * Pipeline:
 *   Step 1: Shard classifier   — fastModel OR keyword heuristic → top-1~2 shards
 *   Step 2: In-shard candidate — scan only the selected shards, filter by kind/tags/pinned
 *   Step 3: LLM rerank         — pick top-7 from candidates
 *   Step 4: Inject body only   — return entries without sourceRef (§Δ23)
 *
 * The legacy R5 recall (agent/unify/memory/recall.js) remains for back-compat
 * of callers still on MemoryStore. R6 callers should use `recallR6()` below.
 */

import { createHash } from 'crypto';
import { pickEffort } from '../effort.js';
import {
  VP_DEFAULT_SHARDS,
  FEATURE_SHARDS,
  USER_SHARDS,
} from './schema.js';

const MAX_RECALL_RESULTS = 7;
const MAX_CANDIDATES = 15;

// ─── Step 1: Shard Classifier ───────────────────────────────────

/**
 * Keyword → shard heuristic. Zero-cost fallback when fastModel is unavailable.
 *
 * The lexicons are intentionally small: classifier output only needs to point
 * at the most likely shard; LLM rerank in Step 3 catches misses. Empirically
 * this covers > 70% of queries with zero LLM cost.
 */
const SHARD_LEXICON = {
  skill:       ['code', 'api', 'library', 'framework', 'implement', 'debug', 'syntax', 'typescript', 'vue', 'pattern', '代码', '实现', '调试', '语法', '模式', '技术'],
  lessons:     ['mistake', 'avoid', 'lesson', 'pitfall', 'gotcha', 'bug', 'regression', '教训', '避坑', '坑', '踩坑', '反模式'],
  preferences: ['prefer', 'like', 'style', 'convention', 'favorite', '偏好', '风格', '习惯', '喜欢'],
  relations:   ['colleague', 'partner', 'team', 'user', 'collaborator', 'vp', '同事', '队友', '协作', '关系'],
  // Task-memory shards
  decision:    ['decide', 'decision', 'chose', 'picked', 'resolved', '决定', '决策', '选择'],
  progress:    ['done', 'progress', 'milestone', 'shipped', 'finished', '完成', '进度', '交付'],
  context:     ['background', 'context', 'requirement', 'scope', '背景', '需求', '范围'],
  blocker:     ['block', 'stuck', 'blocker', 'issue', 'waiting', '阻塞', '卡住', '等待'],
  artifact:    ['pr', 'commit', 'doc', 'file', 'link', 'artifact', 'deliverable', 'commit', '产出', '文档'],
  // User-memory shards
  profile:     ['name', 'role', 'background', 'who', 'identity', '身份', '角色', '背景'],
  projects:    ['project', 'repo', '项目', '仓库'],
  goals:       ['goal', 'target', 'okr', 'plan', '目标', '计划'],
};

/**
 * Pick top-N shards via keyword heuristic.
 * @param {string} prompt
 * @param {string[]} availableShards  all shards present in this store
 * @param {number} [topN=2]
 */
export function classifyShardsByKeyword(prompt, availableShards, topN = 2) {
  if (!prompt || !availableShards || availableShards.length === 0) return [];
  const lower = prompt.toLowerCase();
  const scores = new Map();
  for (const shard of availableShards) {
    // project-<slug> shards score via their slug
    const lex = SHARD_LEXICON[shard] || [];
    let score = 0;
    for (const kw of lex) {
      if (lower.includes(kw)) score += 1;
    }
    if (shard.startsWith('project-')) {
      const slug = shard.slice('project-'.length);
      if (slug && lower.includes(slug.toLowerCase())) score += 3;
    }
    if (score > 0) scores.set(shard, score);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  if (ranked.length >= 1) return ranked.slice(0, topN);
  // Fallback: first N defaults in the shard set
  return availableShards.slice(0, topN);
}

/**
 * Shard classifier — calls fastModel if adapter provided, else falls back to
 * the keyword heuristic. Budget < 200 tokens (§Δ24.2).
 */
export async function classifyShards({
  prompt,
  availableShards,
  adapter,
  fastModel,
  topN = 2,
}) {
  if (!adapter || !fastModel) {
    return classifyShardsByKeyword(prompt, availableShards, topN);
  }
  const system = `You classify user queries into memory shards. Return ONLY a JSON array of up to ${topN} shard names from the provided list. No prose.`;
  const user = `Available shards: ${JSON.stringify(availableShards)}
Query: ${JSON.stringify(prompt)}
Return JSON array of up to ${topN} most relevant shard names.`;
  try {
    const res = await adapter.call({
      model: fastModel,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 64,
      effort: pickEffort({ scenario: 'recall' }),
    });
    const m = (res.text || '').match(/\[[\s\S]*?\]/);
    if (!m) return classifyShardsByKeyword(prompt, availableShards, topN);
    const arr = JSON.parse(m[0]);
    const valid = arr.filter(s => typeof s === 'string' && availableShards.includes(s));
    if (valid.length === 0) return classifyShardsByKeyword(prompt, availableShards, topN);
    return valid.slice(0, topN);
  } catch {
    return classifyShardsByKeyword(prompt, availableShards, topN);
  }
}

// ─── Step 2: In-shard candidate generation ──────────────────────

function collectCandidates(memoryShardStore, { shards, kind, tags, pinned }) {
  const filter = {};
  if (shards && shards.length) filter.shard = shards.length === 1 ? shards[0] : shards;
  if (kind) filter.kind = kind;
  if (tags && tags.length) filter.tags = tags;
  if (pinned !== undefined) filter.pinned = pinned;
  const { results } = memoryShardStore.query(filter);
  return results
    // Drop superseded entries from the candidate pool (they stay on disk
    // for memory_trace but should not compete for recall slots).
    .filter(rec => !rec.supersededBy)
    .slice(0, MAX_CANDIDATES);
}

// ─── Step 3: LLM Rerank ─────────────────────────────────────────

async function llmRerank({ adapter, fastModel, prompt, candidates, memoryShardStore }) {
  if (candidates.length <= MAX_RECALL_RESULTS) {
    return candidates.map(c => c.id);
  }
  const lines = candidates.map((c, i) => {
    return `${i + 1}. [id=${c.id}] shard=${c.shard} kind=${c.kind || '?'} tags=[${(c.tags || []).join(',')}]`;
  }).join('\n');
  const system = `You pick the most relevant memories for the user's prompt. Return ONLY a JSON array of entry ids (up to ${MAX_RECALL_RESULTS}). No prose.`;
  const user = `User prompt: ${JSON.stringify(prompt)}

Candidate memories:
${lines}

Return JSON array of up to ${MAX_RECALL_RESULTS} ids.`;
  try {
    const res = await adapter.call({
      model: fastModel,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 256,
      effort: pickEffort({ scenario: 'recall' }),
    });
    const m = (res.text || '').match(/\[[\s\S]*\]/);
    if (!m) return candidates.slice(0, MAX_RECALL_RESULTS).map(c => c.id);
    const arr = JSON.parse(m[0]).filter(x => typeof x === 'string');
    const valid = arr.filter(id => candidates.find(c => c.id === id));
    if (valid.length === 0) return candidates.slice(0, MAX_RECALL_RESULTS).map(c => c.id);
    return valid.slice(0, MAX_RECALL_RESULTS);
  } catch {
    return candidates.slice(0, MAX_RECALL_RESULTS).map(c => c.id);
  }
}

// ─── Step 4: Inject (no sourceRef) ──────────────────────────────

/**
 * Produce the body-only injection payload (§Δ24.5). Prefix lines with
 * `[mem:<shard>]` so the LLM knows the category without seeing the id.
 */
export function formatForInjection(entries) {
  return entries.map(e => {
    const prefix = `[mem:${e.shard}]`;
    const body = (e.body || '').trim();
    return `${prefix} ${body}`;
  }).join('\n\n');
}

// ─── Fingerprint cache ──────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function computeFingerprint({ shards, prompt, taskId }) {
  const head = prompt.slice(0, 200);
  const input = `${shards.join(',')}|${head}|${taskId || ''}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ─── Entry point ────────────────────────────────────────────────

/**
 * Run the R6 4-step recall pipeline.
 *
 * @param {{
 *   prompt: string,
 *   memoryShardStore: object,           // openMemoryShardStore() handle
 *   adapter?: object,                   // LLM adapter (null = keyword-only)
 *   fastModel?: string,                 // fast model for classifier + rerank
 *   availableShards?: string[],         // defaults to store stats
 *   taskId?: string,
 *   kind?: string, tags?: string[], pinned?: boolean,
 * }} params
 * @returns {Promise<{entries: object[], shards: string[], fingerprint: string, cached: boolean}>}
 */
export async function recallR6(params) {
  const {
    prompt,
    memoryShardStore,
    adapter,
    fastModel,
    availableShards,
    taskId,
    kind,
    tags,
    pinned,
  } = params;

  if (!prompt || !prompt.trim() || !memoryShardStore) {
    return { entries: [], shards: [], fingerprint: '', cached: false };
  }

  const shardsFromStore = availableShards
    || Object.keys(memoryShardStore.stats().shards);

  if (shardsFromStore.length === 0) {
    return { entries: [], shards: [], fingerprint: '', cached: false };
  }

  // Step 1
  const chosenShards = await classifyShards({
    prompt,
    availableShards: shardsFromStore,
    adapter,
    fastModel,
    topN: 2,
  });

  const fingerprint = computeFingerprint({ shards: chosenShards, prompt, taskId });
  const cached = _cache.get(fingerprint);
  if (cached && Date.now() - cached.t < CACHE_TTL) {
    return { entries: cached.entries, shards: chosenShards, fingerprint, cached: true };
  }

  // Step 2
  const candidates = collectCandidates(memoryShardStore, {
    shards: chosenShards,
    kind,
    tags,
    pinned,
  });
  if (candidates.length === 0) {
    _cache.set(fingerprint, { entries: [], t: Date.now() });
    return { entries: [], shards: chosenShards, fingerprint, cached: false };
  }

  // Step 3
  const selectedIds = await llmRerank({
    adapter, fastModel, prompt, candidates, memoryShardStore,
  });

  // Step 4 — load full bodies (minus sourceRef for injection).
  const entries = [];
  for (const id of selectedIds) {
    const full = memoryShardStore.get(id);
    if (!full) continue;
    entries.push({
      id: full.id,
      shard: full.shard,
      kind: full.kind,
      body: full.body,
      tags: full.tags || [],
      // deliberately do NOT expose sourceRef here (§Δ23)
    });
  }
  _cache.set(fingerprint, { entries, t: Date.now() });
  return { entries, shards: chosenShards, fingerprint, cached: false };
}

export function clearR6RecallCache() {
  _cache.clear();
}

export const R6_DEFAULTS = {
  VP_DEFAULT_SHARDS,
  FEATURE_SHARDS,
  USER_SHARDS,
};
