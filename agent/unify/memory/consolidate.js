/**
 * consolidate.js — Consolidate = compact + extract (one LLM call)
 *
 * Triggered when hot_tokens > MESSAGE_TOKEN_BUDGET.
 * One LLM call does two things simultaneously:
 *   1. Generate compact summary → append to compact.md ("short-term memory")
 *   2. Extract memory entries → write to entries/ ("long-term memory")
 *
 * After consolidation:
 *   - Processed messages moved from messages/ to cold/
 *   - index.md + scopes.md updated
 *
 * Reference: yeaft-unify-core-systems.md §3.1, §4.2
 *            yeaft-unify-design.md §6.1
 */

import { extractMemories } from './extract.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default MESSAGE_TOKEN_BUDGET (context * 4%, default ~8192). */
export const DEFAULT_MESSAGE_TOKEN_BUDGET = 8192;

/** After compact, keep this fraction of the budget. */
export const COMPACT_KEEP_RATIO = 0.4;

/** Minimum messages to keep hot (newest). */
const MIN_KEEP_MESSAGES = 3;

// ─── Consolidate ────────────────────────────────────────────────

/**
 * Check if consolidation should be triggered.
 *
 * @param {import('../conversation/persist.js').ConversationStore} conversationStore
 * @param {number} [budget] — MESSAGE_TOKEN_BUDGET
 * @returns {boolean}
 */
export function shouldConsolidate(conversationStore, budget = DEFAULT_MESSAGE_TOKEN_BUDGET) {
  const hotTokens = conversationStore.hotTokens();
  return hotTokens > budget;
}

/**
 * Determine which messages to archive (move to cold).
 * Strategy: from oldest, accumulate tokens until remaining ≤ budget * 40%.
 * Always keep at least MIN_KEEP_MESSAGES.
 *
 * @param {object[]} messages — all hot messages, sorted chronologically
 * @param {number} budget — MESSAGE_TOKEN_BUDGET
 * @returns {{ toArchive: object[], toKeep: object[] }}
 */
export function partitionMessages(messages, budget = DEFAULT_MESSAGE_TOKEN_BUDGET) {
  if (messages.length <= MIN_KEEP_MESSAGES) {
    return { toArchive: [], toKeep: messages };
  }

  const keepBudget = Math.floor(budget * COMPACT_KEEP_RATIO);

  // Work backwards from newest: accumulate tokens until we hit keepBudget
  let keepTokens = 0;
  let keepStart = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = messages[i].tokens_est || 0;
    if (keepTokens + msgTokens > keepBudget && (messages.length - i) >= MIN_KEEP_MESSAGES) {
      keepStart = i + 1;
      break;
    }
    keepTokens += msgTokens;
    if (i === 0) keepStart = 0;
  }

  // Ensure at least MIN_KEEP_MESSAGES are kept
  keepStart = Math.min(keepStart, messages.length - MIN_KEEP_MESSAGES);
  keepStart = Math.max(keepStart, 0);

  return {
    toArchive: messages.slice(0, keepStart),
    toKeep: messages.slice(keepStart),
  };
}

/**
 * Generate a compact summary of messages.
 *
 * @param {object[]} messages — messages to summarize
 * @param {object} adapter — LLM adapter with .call()
 * @param {object} config — { model }
 * @returns {Promise<string>} — compact summary text
 */
async function generateSummary(messages, adapter, config) {
  const conversation = messages.map(m => {
    const prefix = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
    return `[${prefix}]: ${(m.content || '').slice(0, 500)}`;
  }).join('\n\n');

  const system = 'You are a conversation summarizer. Summarize the conversation concisely in 2-3 paragraphs, preserving key decisions, facts, and context. Write in the same language as the conversation.';

  try {
    const result = await adapter.call({
      model: config.model,
      system,
      messages: [{ role: 'user', content: `Summarize this conversation:\n\n${conversation}` }],
      maxTokens: 1024,
    });
    return result.text.trim();
  } catch {
    // Fallback: simple concatenation of first/last messages
    const first = messages[0]?.content?.slice(0, 200) || '';
    const last = messages[messages.length - 1]?.content?.slice(0, 200) || '';
    return `[Auto-summary failed] Started with: ${first}... Ended with: ${last}`;
  }
}

/**
 * Run the full Consolidate pipeline.
 *
 * 1. Partition messages (what to archive vs keep)
 * 2. Generate compact summary (LLM call)
 * 3. Extract memory entries (LLM call)
 * 4. Move archived messages to cold/
 * 5. Update compact.md, index.md, scopes.md
 *
 * @param {{
 *   conversationStore: import('../conversation/persist.js').ConversationStore,
 *   memoryStore: import('./store.js').MemoryStore,
 *   adapter: object,
 *   config: object,
 *   budget?: number
 * }} params
 * @returns {Promise<{ compactSummary: string, extractedEntries: string[], archivedCount: number }>}
 */
export async function consolidate({ conversationStore, memoryStore, adapter, config, budget = DEFAULT_MESSAGE_TOKEN_BUDGET }) {
  // Load all hot messages
  const messages = conversationStore.loadAll();

  if (messages.length <= MIN_KEEP_MESSAGES) {
    return { compactSummary: '', extractedEntries: [], archivedCount: 0 };
  }

  // Step 1: Partition
  const { toArchive, toKeep } = partitionMessages(messages, budget);

  if (toArchive.length === 0) {
    return { compactSummary: '', extractedEntries: [], archivedCount: 0 };
  }

  // Step 2: Generate compact summary
  const compactSummary = await generateSummary(toArchive, adapter, config);

  // Step 3: Extract memory entries
  const extracted = await extractMemories({ messages: toArchive, adapter, config });

  // Step 4: Move archived messages to cold
  const archiveIds = toArchive.map(m => m.id).filter(Boolean);
  conversationStore.moveToColdBatch(archiveIds);

  // Step 5a: Update compact.md
  if (compactSummary) {
    conversationStore.updateCompactSummary(compactSummary);
  }

  // Step 5b: Write extracted memory entries
  const entryNames = [];
  for (const entry of extracted) {
    const slug = memoryStore.writeEntry(entry);
    entryNames.push(slug);
  }

  // Step 5c: Update index.md
  const lastMsg = toKeep[toKeep.length - 1];
  conversationStore.updateIndex({
    lastMessageId: lastMsg?.id || null,
  });

  // Step 5d: Rebuild scopes.md
  if (entryNames.length > 0) {
    memoryStore.rebuildScopes();
  }

  return {
    compactSummary,
    extractedEntries: entryNames,
    archivedCount: archiveIds.length,
  };
}
