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
import { getThreadStore } from './threads/store.js';
import { createIntentClassifier } from './router/intent-classifier.js';
import { initInputQueueStore } from './input-queue/store.js';
import { createDispatcher } from './pipeline/dispatcher.js';
import { join } from 'path';
import { existsSync as existsSyncSafe, readFileSync as readFileSyncSafe } from 'fs';

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

  // ─── 2.1 Migration state check (task-334i) ────────────
  //        If the group-chat feature flag is on but migration has not
  //        completed, warn the user. Do NOT auto-run migration: that is
  //        an explicit action via bin/yeaft-migrate.js.
  try {
    if (config?.features?.unifyGroupChat === true) {
      const stateFile = join(yeaftDir, '.migration-state.json');
      let completed = false;
      if (existsSyncSafe(stateFile)) {
        try {
          const raw = readFileSyncSafe(stateFile, 'utf8');
          const state = JSON.parse(raw || '{}');
          completed = Boolean(state && state.completedAt);
        } catch { /* malformed state → treat as not completed */ }
      }
      if (!completed) {
        console.warn(
          '[Yeaft] features.unifyGroupChat=true but storage migration is not complete. ' +
          'Run `yeaft-migrate` before using the new group-chat tree, or unset the flag.',
        );
      }
    }
  } catch { /* never let this warn path block session load */ }

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
  //         task-318: forward the Unify autoArchiveIdleDays knob so the
  //         archive pass (owned by task-317) can read it off the store.
  initThreadStore(yeaftDir, {
    readOnly: config._readOnly || false,
    force: true,
    idleArchiveDays: config.unify?.autoArchiveIdleDays ?? 0,
  });

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
    // task-318: concurrent-thread cap (UI-adjustable via Settings).
    maxConcurrent: config.unify?.maxConcurrentThreads ?? null,
  });
  // Seed the main-thread instance so listActive() is non-empty from T=0.
  engineRegistry.ensure(MAIN_THREAD_ID);

  // task-309 Phase 2 router: intent classifier that routes incoming user
  // messages to the right EngineInstance. Shares the same adapter/trace/
  // config as the engines so it can use primaryModel for classification.
  const router = createIntentClassifier({ adapter, trace, config });

  // task-310 Phase 2 integration: wire InputQueue + Dispatcher so the
  // web-bridge can submit `unify_chat` inputs through the unified pipeline
  // (queue → router → engineRegistry → EngineInstance). In read-only mode
  // the queue is memory-only (no disk writes).
  const inputQueue = initInputQueueStore({
    yeaftDir: config._readOnly ? null : yeaftDir,
    force: true,
  });
  const dispatcher = createDispatcher({
    inputQueue,
    router,
    engineRegistry,
    threadStore: getThreadStore(),
    trace,
  });

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
    inputQueue,
    dispatcher,
    adapter,
    config,
    conversationStore,
    memoryStore,
    skillManager,
    mcpManager,
    toolRegistry,
    trace,
    yeaftDir,
    // task-318 rev-1 fix: expose the live ThreadStore handle so callers
    // (web-bridge, message-router via ctx) can invoke setIdleArchiveDays()
    // on the exact instance that's wired into the dispatcher. Without this
    // export the setter was effectively dead code.
    threadStore: getThreadStore(),
    status,
    shutdown,
    // task-325c: user-initiated abort API. Delegates to web-bridge which
    // owns the per-thread AbortController registry (`abortByThread`).
    // Lazy-imported to avoid a hard cycle with web-bridge.js (which already
    // imports this module to call loadSession).
    async abort(opts = {}) {
      const { abortUnifySession } = await import('./web-bridge.js');
      return abortUnifySession(opts);
    },
  };
}
