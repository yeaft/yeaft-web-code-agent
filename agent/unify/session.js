/**
 * session.js — Session orchestrator for Yeaft Unify
 *
 * Single entry point: loadSession(options?) → Session
 *
 * Wires all subsystems together:
 *   initYeaftDir → loadConfig → createTrace → createLLMAdapter →
 *   ConversationStore → MemoryStore → SkillManager → MCPManager →
 *   ToolRegistry → Engine → Session
 *
 * The ~/.yeaft/ directory is the agent's persistent workspace.
 * loadSession() loads (or initializes) this workspace and returns
 * a fully wired Session ready for queries.
 */

import { initYeaftDir, DEFAULT_YEAFT_DIR, isWritable } from './init.js';
import { loadConfig, loadMCPConfig } from './config.js';
import { createTrace } from './debug-trace.js';
import { createLLMAdapter } from './llm/adapter.js';
import { ConversationStore } from './conversation/persist.js';
import { MemoryStore } from './memory/store.js';
import { SkillManager, createSkillManager } from './skills.js';
import { MCPManager } from './mcp.js';
import { createFullRegistry } from './tools/index.js';
import { initTaskStore } from './tools/task-tools.js';
import { initThreadStore } from './threads/store.js';
import { Engine } from './engine.js';
import { createThreadEngineRegistry } from './threads/engine-registry.js';
import { MAIN_THREAD_ID } from './threads/store.js';
import { createIntentClassifier } from './router/intent-classifier.js';
import { join } from 'path';

/**
 * @typedef {Object} SessionOptions
 * @property {string} [dir] — Yeaft data directory override (default: ~/.yeaft)
 * @property {string} [model] — Model override
 * @property {string} [language] — Language override ('en' | 'zh')
 * @property {boolean} [debug] — Debug mode override
 * @property {boolean} [skipMCP] — Skip MCP server connections (faster startup)
 * @property {boolean} [skipSkills] — Skip skill loading
 * @property {object[]} [extraTools] — Additional ToolDef objects to register
 * @property {object} [configOverrides] — Additional config overrides
 */

/**
 * @typedef {Object} Session
 * @property {Engine} engine — The wired engine, ready for .query()
 * @property {import('./llm/adapter.js').LLMAdapter} adapter — The LLM adapter
 * @property {object} config — Resolved configuration
 * @property {ConversationStore} conversationStore — Conversation persistence
 * @property {MemoryStore} memoryStore — Memory persistence
 * @property {SkillManager} skillManager — Skill manager
 * @property {MCPManager} mcpManager — MCP manager
 * @property {import('./tools/registry.js').ToolRegistry} toolRegistry — Tool registry
 * @property {import('./debug-trace.js').DebugTrace|import('./debug-trace.js').NullTrace} trace
 * @property {string} yeaftDir — Resolved data directory path
 * @property {{ skills: number, mcpServers: string[], mcpFailed: object[], tools: number }} status
 * @property {() => Promise<void>} shutdown — Graceful shutdown
 */

/**
 * Load (or initialize) a Yeaft session.
 *
 * This is the main entry point for using Yeaft programmatically.
 * It creates the directory structure if needed, loads config, connects
 * to services, registers tools, and returns a ready-to-use Session.
 *
 * @param {SessionOptions} [options={}]
 * @returns {Promise<Session>}
 */
export async function loadSession(options = {}) {
  const {
    dir,
    model,
    language,
    debug,
    skipMCP = false,
    skipSkills = false,
    extraTools = [],
    configOverrides = {},
  } = options;

  // ─── 1. Determine yeaftDir + ensure directory structure ──
  //        Must happen BEFORE loadConfig so that first-run
  //        generates a default config.json that loadConfig can read.
  const overrides = { ...configOverrides };
  if (dir) overrides.dir = dir;
  if (model) overrides.model = model;
  if (language) overrides.language = language;
  if (debug !== undefined) overrides.debug = debug;

  const yeaftDir = overrides.dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const initResult = initYeaftDir(yeaftDir);
  overrides.dir = yeaftDir;

  // Log any warnings from directory initialization
  for (const w of initResult.warnings) {
    console.warn(`[Yeaft] ${w}`);
  }

  // ─── 2. Load config ───────────────────────────────────
  const config = loadConfig(overrides);

  // ─── 2a. Permission pre-check ─────────────────────────
  //         If the data dir is not writable, mark session as read-only.
  //         Persistence (conversation, memory, dream) is skipped in this mode.
  if (!initResult.writable) {
    config._readOnly = true;
    console.warn(`[Yeaft] ${yeaftDir} is not writable — running in read-only mode`);
  }

  // ─── 3. Create debug trace ─────────────────────────────
  const trace = createTrace({
    enabled: config.debug,
    dbPath: join(yeaftDir, 'debug.db'),
  });

  // ─── 4. Create LLM adapter ────────────────────────────
  const adapter = await createLLMAdapter(config);

  // ─── 5. Create stores ──────────────────────────────────
  const conversationStore = new ConversationStore(yeaftDir);
  const memoryStore = new MemoryStore(yeaftDir);

  // ─── 5a. Initialize task store ─────────────────────────
  initTaskStore(yeaftDir, { readOnly: config._readOnly || false });

  // ─── 5b. Initialize thread store (task-299 Phase 1) ────
  //         task-307a: now file-backed under ~/.yeaft/threads/. Passing the
  //         yeaftDir switches on disk persistence; read-only mode is honoured.
  initThreadStore(yeaftDir, { readOnly: config._readOnly || false, force: true });

  // ─── 6. Load skills ────────────────────────────────────
  let skillManager;
  if (skipSkills) {
    skillManager = new SkillManager(yeaftDir);
    // Don't call .load() — empty skill manager
  } else {
    skillManager = createSkillManager(yeaftDir);
  }

  // ─── 7. Connect MCP servers ────────────────────────────
  const mcpConfig = loadMCPConfig(yeaftDir);
  const mcpManager = new MCPManager();
  let mcpStatus = { connected: [], failed: [] };

  if (!skipMCP && mcpConfig.servers.length > 0) {
    mcpStatus = await mcpManager.connectAll(mcpConfig.servers);
  }

  // ─── 8. Build tool registry ────────────────────────────
  const toolRegistry = createFullRegistry();

  // Register any extra tools from caller
  for (const tool of extraTools) {
    toolRegistry.register(tool);
  }

  // ─── 9. Create engine (wires everything) ───────────────
  const engine = new Engine({
    adapter,
    trace,
    config,
    conversationStore,
    memoryStore,
    toolRegistry,
    skillManager,
    mcpManager,
    yeaftDir,
  });

  // task-308 Phase 2: thread-aware engine registry.
  // Each thread gets its own EngineInstance (lazy-created) that owns its
  // messages array and tags all events with the bound threadId. Legacy
  // single-engine callers keep working via `session.engine`; multi-thread
  // callers use `session.engineRegistry.ensure(threadId)`.
  const engineRegistry = createThreadEngineRegistry({
    adapter,
    trace,
    config,
    conversationStore,
    memoryStore,
    toolRegistry,
    skillManager,
    mcpManager,
    yeaftDir,
  });
  // Seed the main-thread instance so listActive() is non-empty from T=0.
  engineRegistry.ensure(MAIN_THREAD_ID);

  // task-309 Phase 2 router: intent classifier that routes incoming user
  // messages to the right EngineInstance. Shares the same adapter/trace/
  // config as the engines so it can use primaryModel for classification.
  const router = createIntentClassifier({ adapter, trace, config });

  // ─── 10. Build session ─────────────────────────────────
  const status = {
    skills: skillManager.size,
    mcpServers: mcpStatus.connected,
    mcpFailed: mcpStatus.failed,
    tools: toolRegistry.size,
  };

  /** Graceful shutdown: disconnect MCP, close trace DB. */
  async function shutdown() {
    try {
      engineRegistry.terminateAll();
    } catch {
      // Best-effort cleanup
    }
    try {
      await mcpManager.disconnectAll();
    } catch {
      // Best-effort cleanup
    }
    try {
      trace.close();
    } catch {
      // Trace might not have close() (NullTrace)
    }
  }

  return {
    engine,
    engineRegistry,
    router,
    adapter,
    config,
    conversationStore,
    memoryStore,
    skillManager,
    mcpManager,
    toolRegistry,
    trace,
    yeaftDir,
    status,
    shutdown,
  };
}
