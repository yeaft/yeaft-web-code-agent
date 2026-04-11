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

import { initYeaftDir } from './init.js';
import { loadConfig, loadMCPConfig } from './config.js';
import { createTrace } from './debug-trace.js';
import { createLLMAdapter } from './llm/adapter.js';
import { ConversationStore } from './conversation/persist.js';
import { MemoryStore } from './memory/store.js';
import { SkillManager, createSkillManager } from './skills.js';
import { MCPManager } from './mcp.js';
import { createEmptyRegistry } from './tools/registry.js';
import { Engine } from './engine.js';
import { join } from 'path';

// Built-in tools
import mcpTools from './tools/mcp-tools.js';
import skillTool from './tools/skill.js';
import enterWorktree from './tools/enter-worktree.js';
import exitWorktree from './tools/exit-worktree.js';

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

  // ─── 1. Load config (determines yeaftDir) ──────────────
  const overrides = { ...configOverrides };
  if (dir) overrides.dir = dir;
  if (model) overrides.model = model;
  if (language) overrides.language = language;
  if (debug !== undefined) overrides.debug = debug;

  const config = loadConfig(overrides);
  const yeaftDir = config.dir;

  // ─── 2. Ensure directory structure ─────────────────────
  initYeaftDir(yeaftDir);

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
  const toolRegistry = createEmptyRegistry();

  // Register built-in tools
  for (const tool of mcpTools) {
    toolRegistry.register(tool);
  }
  toolRegistry.register(skillTool);
  toolRegistry.register(enterWorktree);
  toolRegistry.register(exitWorktree);

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
