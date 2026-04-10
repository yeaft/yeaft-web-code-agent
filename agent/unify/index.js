/**
 * index.js — Yeaft Unify module entry point
 *
 * Re-exports all public APIs for external consumption.
 */

export { initYeaftDir, DEFAULT_YEAFT_DIR } from './init.js';
export { loadConfig, parseFrontmatter } from './config.js';
export { DebugTrace, NullTrace, createTrace } from './debug-trace.js';
export {
  LLMAdapter,
  LLMRateLimitError,
  LLMAuthError,
  LLMContextError,
  LLMServerError,
  LLMAbortError,
  createLLMAdapter,
} from './llm/adapter.js';
export { MODEL_REGISTRY, resolveModel, listModels, isKnownModel } from './models.js';
export { buildSystemPrompt, SUPPORTED_LANGUAGES } from './prompts.js';
export { Engine } from './engine.js';
export { ConversationStore, parseMessage, estimateTokens } from './conversation/persist.js';
export { searchMessages } from './conversation/search.js';
export { MemoryStore, parseEntry, serializeEntry, MEMORY_KINDS } from './memory/store.js';
export { recall, extractKeywords, computeFingerprint, clearRecallCache } from './memory/recall.js';
export { extractMemories } from './memory/extract.js';
export { consolidate, shouldConsolidate } from './memory/consolidate.js';
