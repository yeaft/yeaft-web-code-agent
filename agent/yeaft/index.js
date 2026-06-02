/**
 * index.js — Yeaft Yeaft module entry point
 *
 * Re-exports all public APIs for external consumption.
 */

export { initYeaftDir, DEFAULT_YEAFT_DIR, isWritable, isPermissionError } from './init.js';
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
export { AdapterRouter } from './llm/router.js';
export { MODEL_REGISTRY, resolveModel, listModels, isKnownModel, getProviderForModel, parseModelRef } from './models.js';
export { buildSystemPrompt, SUPPORTED_LANGUAGES } from './prompts.js';
export { Engine } from './engine.js';
export { ConversationStore, parseMessage, estimateTokens } from './conversation/persist.js';
export { searchMessages } from './conversation/search.js';

// Phase 5: Advanced features
export { runStopHooks } from './stop-hooks.js';
export { MCPManager, createMCPManager } from './mcp.js';
export { SkillManager, createSkillManager, parseSkill, serializeSkill } from './skills.js';
export { defineTool } from './tools/types.js';
export { ToolRegistry, createEmptyRegistry } from './tools/registry.js';
export { createFullRegistry, allTools } from './tools/index.js';
export { loadSession } from './session.js';

