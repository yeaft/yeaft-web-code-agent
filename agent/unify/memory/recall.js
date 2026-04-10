/**
 * recall.js — 3-step memory recall with fingerprint cache
 *
 * Recall flow (per design doc):
 *   Step 1: Keyword extraction (pure rules, <1ms)
 *   Step 2: Scope + Tags filter (read scopes.md, <5ms) → top 15 candidates
 *   Step 3: LLM select (side-query via adapter.call) → ≤7 most relevant
 *
 * Fingerprint cache:
 *   fingerprint = hash(scope, top 5 keywords, task_id)
 *   Same fingerprint → skip recall, reuse last result
 *
 * Reference: yeaft-unify-core-systems.md §3.2, yeaft-unify-design.md §5.1
 */

import { createHash } from 'crypto';

// ─── Constants ──────────────────────────────────────────────────

/** Max entries returned by recall. */
const MAX_RECALL_RESULTS = 7;

/** Max candidates passed to LLM select (Step 2 → Step 3). */
const MAX_CANDIDATES = 15;

// ─── Step 1: Keyword Extraction (pure rules, <1ms) ──────────────

/** Common stop words to filter out. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'about', 'up', 'it', 'its', 'my', 'me', 'i', 'you',
  'your', 'we', 'our', 'they', 'them', 'their', 'this', 'that', 'what',
  'which', 'who', 'whom', 'these', 'those',
  // Chinese stop words
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
  '着', '没有', '看', '好', '自己', '这', '他', '她', '吗', '呢', '吧',
  '把', '被', '那', '它', '让', '给', '可以', '什么', '怎么', '帮',
  '帮我', '请', '能', '想',
]);

/**
 * Extract keywords from a prompt (pure rules, no LLM).
 *
 * @param {string} prompt
 * @returns {string[]} — keywords sorted by relevance (simple freq)
 */
export function extractKeywords(prompt) {
  if (!prompt || !prompt.trim()) return [];

  // Tokenize: split on whitespace and punctuation (keep CJK chars)
  const tokens = prompt
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));

  // Count frequencies
  const freq = new Map();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) || 0) + 1);
  }

  // Sort by frequency descending, then alphabetically
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);
}

// ─── Fingerprint Cache ──────────────────────────────────────────

/**
 * Compute a recall fingerprint for cache checking.
 *
 * @param {{ scope?: string, keywords: string[], taskId?: string }} params
 * @returns {string} — hex hash
 */
export function computeFingerprint({ scope = '', keywords, taskId = '' }) {
  const top5 = keywords.slice(0, 5).join(',');
  const input = `${scope}|${top5}|${taskId}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// ─── Step 2: Scope + Tags Filter ────────────────────────────────

/**
 * Filter entries by scope and tags (in-memory, no LLM).
 * Uses MemoryStore.findByFilter internally.
 *
 * @param {import('./store.js').MemoryStore} memoryStore
 * @param {{ scope?: string, keywords: string[] }} params
 * @returns {object[]} — top MAX_CANDIDATES entries
 */
function filterCandidates(memoryStore, { scope, keywords }) {
  return memoryStore.findByFilter({
    scope,
    tags: keywords,
    limit: MAX_CANDIDATES,
  });
}

// ─── Step 3: LLM Select ────────────────────────────────────────

/**
 * Use LLM side-query to select the most relevant entries.
 *
 * @param {object} adapter — LLM adapter with .call() method
 * @param {object} config — { model }
 * @param {string} prompt — user's prompt
 * @param {object[]} candidates — entries with frontmatter
 * @returns {Promise<string[]>} — selected entry names
 */
async function llmSelect(adapter, config, prompt, candidates) {
  if (candidates.length <= MAX_RECALL_RESULTS) {
    // No need to filter if already under limit
    return candidates.map(c => c.name);
  }

  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.name}] kind=${c.kind}, scope=${c.scope}, tags=[${(c.tags || []).join(', ')}]`
  ).join('\n');

  const system = `You are a memory retrieval assistant. Given a user's prompt and a list of memory entries, select the most relevant ones (up to ${MAX_RECALL_RESULTS}).
Return ONLY a JSON array of entry names, like: ["entry-name-1", "entry-name-2"]
No explanation, just the JSON array.`;

  const messages = [{
    role: 'user',
    content: `User prompt: "${prompt}"

Memory entries:
${candidateList}

Select the ${MAX_RECALL_RESULTS} most relevant entries. Return a JSON array of entry names.`,
  }];

  try {
    const result = await adapter.call({
      model: config.model,
      system,
      messages,
      maxTokens: 512,
    });

    // Parse the JSON array from the response
    const text = result.text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const names = JSON.parse(jsonMatch[0]);
      return names.filter(n => typeof n === 'string');
    }
  } catch {
    // Fallback: return all candidates if LLM fails
  }

  return candidates.slice(0, MAX_RECALL_RESULTS).map(c => c.name);
}

// ─── Main Recall Function ───────────────────────────────────────

/** @type {Map<string, { entries: object[], timestamp: number }>} */
const _cache = new Map();

/** Cache TTL — 5 minutes. */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Recall relevant memory entries for a given prompt.
 *
 * 3-step process:
 *   1. Extract keywords (rules, <1ms)
 *   2. Scope + Tags filter → top 15 candidates
 *   3. LLM select → ≤7 entries (skipped if ≤7 candidates)
 *
 * Uses fingerprint cache to skip repeat recalls.
 *
 * @param {{ prompt: string, adapter: object, config: object, memoryStore: import('./store.js').MemoryStore, scope?: string, taskId?: string }} params
 * @returns {Promise<{ entries: object[], keywords: string[], fingerprint: string, cached: boolean }>}
 */
export async function recall({ prompt, adapter, config, memoryStore, scope, taskId }) {
  // Step 1: Extract keywords
  const keywords = extractKeywords(prompt);

  if (keywords.length === 0) {
    return { entries: [], keywords: [], fingerprint: '', cached: false };
  }

  // Check fingerprint cache
  const fingerprint = computeFingerprint({ scope, keywords, taskId });

  const cached = _cache.get(fingerprint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { entries: cached.entries, keywords, fingerprint, cached: true };
  }

  // Step 2: Scope + Tags filter
  const candidates = filterCandidates(memoryStore, { scope, keywords });

  if (candidates.length === 0) {
    _cache.set(fingerprint, { entries: [], timestamp: Date.now() });
    return { entries: [], keywords, fingerprint, cached: false };
  }

  // Step 3: LLM select (only if > MAX_RECALL_RESULTS candidates)
  let selectedNames;
  if (candidates.length <= MAX_RECALL_RESULTS) {
    selectedNames = candidates.map(c => c.name);
  } else {
    selectedNames = await llmSelect(adapter, config, prompt, candidates);
  }

  // Load full entries for selected names
  const entries = [];
  for (const name of selectedNames) {
    const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '');
    const entry = memoryStore.readEntry(slug) || memoryStore.readEntry(name);
    if (entry) {
      entries.push(entry);
      // Bump frequency
      memoryStore.bumpFrequency(slug || name);
    }
  }

  // Update cache
  _cache.set(fingerprint, { entries, timestamp: Date.now() });

  return { entries, keywords, fingerprint, cached: false };
}

/**
 * Clear the recall cache. Useful for testing.
 */
export function clearRecallCache() {
  _cache.clear();
}
