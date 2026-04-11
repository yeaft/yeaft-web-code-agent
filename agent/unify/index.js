/**
 * index.js — Yeaft Unify module entry point
 *
 * Re-exports all public APIs for external consumption.
 */

export { initYeaftDir, DEFAULT_YEAFT_DIR } from './init.js';
export { loadConfig, parseFrontmatter, loadMCPConfig } from './config.js';
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

// Phase 5: Advanced features
export { KINDS, KIND_PRIORITY, KIND_DESCRIPTIONS, IMPORTANCE_LEVELS, validateEntry, parseScopePath, getAncestorScopes, areScopesRelated } from './memory/types.js';
export { scanEntries, scoreEntry, findStaleEntries, findDuplicateGroups, summarizeScan } from './memory/scan.js';
export { dream, checkDreamGate, readDreamState, writeDreamState, incrementQueryCount } from './memory/dream.js';
export { buildOrientPrompt, buildGatherPrompt, buildMergePrompt, buildPrunePrompt, buildPromotePrompt } from './memory/dream-prompt.js';
export { runStopHooks } from './stop-hooks.js';
export { MCPManager, createMCPManager } from './mcp.js';
export { SkillManager, createSkillManager, parseSkill, serializeSkill } from './skills.js';
export { defineTool } from './tools/types.js';
export { ToolRegistry, createEmptyRegistry } from './tools/registry.js';
export { loadSession } from './session.js';

