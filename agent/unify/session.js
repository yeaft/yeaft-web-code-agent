/**
 * session.js — Session orchestrator for Yeaft Unify
 *
 * Single entry point: loadSession(options?) → Session
 *
 * Wires all subsystems together:
 *   initYeaftDir → loadConfig → createTrace → createLLMAdapter →
 *   ConversationStore → SkillManager → MCPManager →
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
import { SkillManager, createSkillManager } from './skills.js';
import { MCPManager } from './mcp.js';
import { createFullRegistry } from './tools/index.js';
import { initFeatureStore } from './tools/feature-tools.js';
import { Engine } from './engine.js';
import { Compactor } from './compact/compactor.js';
// H2.f.5: threads/, pipeline/dispatcher and input-queue retired. The
// session now exposes a single Engine.
//
// GC.1 (final): the session opens a SegmentIndex (SQLite FTS5 over
// memory.md) and passes it to the Engine. Engine.#recallMemory routes
// pre-turn recall through groups/pre-flow.js → memory/preflow.js (the
// previous per-scope file reader recall-v2.js has been deleted).
// The `config.memoryV2` opt-out flag was retired in task-710; wiring is
// unconditional.
//
// GC.1 follow-up: when memoryIndex is wired we also open an
// AmsRegistry. The registry caches per-group ActiveMemorySet
// instances and persists their identity-only state under
// `~/.yeaft/memory/groups/<gid>/ams.json` so a deactivated group
// resumes with the same onDemand/recent membership it had on
// disconnect. Engine.#runQuery uses the registry to populate the
// AMS each turn and to run `memory/adjust.js` post-turn.
import { ensureDefaultGroupIfEmpty } from './groups/group-crud.js';
import { seedDefaultVps } from './vp/seed-defaults.js';
import { runSummaryBackfill } from './memory/seed-backfill.js';
import { createV2DreamScheduler, bootInitEmptyGroups, bootCatchUpStaleDream } from './dream-v2/session-wiring.js';
import { openSegmentIndex } from './memory/index-db.js';
import { syncAll as syncSegmentIndex } from './memory/segment-sync.js';
import { openAmsRegistry } from './memory/ams-registry.js';
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
 * @property {import('./compact/compactor.js').Compactor} compactor — Per-group history compactor
 * @property {import('./llm/adapter.js').LLMAdapter} adapter — The LLM adapter
 * @property {object} config — Resolved configuration
 * @property {ConversationStore} conversationStore — Conversation persistence
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
    serverMode = false,
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
  // fix/dream-cadence-and-ui-trigger: tag config so the dream scheduler
  // can decide whether to keep its interval timer alive (server) or
  // unref it (CLI / tests). Non-persisted — set per-session by caller.
  if (serverMode) config.serverMode = true;

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

  // ─── 2.2 R6 → v2 auto-migration retired ───────────────
  //         The R6 shard layout is gone — memory writes go through
  //         dream-v2 directly. Existing users have already migrated
  //         (state file in ~/.yeaft/.memory-v2-migration.json).

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

  // ─── 5-fts. (GC.1) Open SegmentIndex for FTS pre-flow ────
  //     Build a SQLite FTS5 index over ~/.yeaft/memory/<scope>/memory.md
  //     and pass it to the Engine. Engine.#recallMemory uses it via
  //     groups/pre-flow.js → memory/preflow.js. Disk is the source of
  //     truth; on boot we reconcile disk → index via syncAll. Failure
  //     to open the index is non-fatal: #recallMemory returns an empty
  //     result and the turn proceeds without pre-injected memory.
  let memoryIndex = null;
  if (!config._readOnly) {
    try {
      const indexPath = join(yeaftDir, 'memory', 'index.db');
      memoryIndex = openSegmentIndex(indexPath);
      const memoryRoot = join(yeaftDir, 'memory');
      try {
        syncSegmentIndex(memoryRoot, memoryIndex);
      } catch (syncErr) {
        // Sync is best-effort; an empty / partial index just produces
        // empty recall results, never an error.
        if (config.debug) {
          console.warn(`[Yeaft] FTS index sync warning: ${syncErr?.message || syncErr}`);
        }
      }
    } catch (err) {
      console.warn(`[Yeaft] Failed to open FTS segment index (preflow disabled): ${err?.message || err}`);
      memoryIndex = null;
    }
  }

  // ─── 5-ams. (GC.1 follow-up) Group-keyed AMS registry ────
  //     The registry caches one ActiveMemorySet per groupId and
  //     persists their state to disk so a deactivated group can be
  //     reactivated with the same onDemand/recent membership it had
  //     on disconnect. Without memoryIndex we have nothing to
  //     re-hydrate against, so the registry is left null in that case.
  let amsRegistry = null;
  if (memoryIndex && !config._readOnly) {
    try {
      amsRegistry = openAmsRegistry({ yeaftDir, memoryIndex, config });
    } catch (err) {
      console.warn(`[Yeaft] Failed to open AMS registry (adjust disabled): ${err?.message || err}`);
      amsRegistry = null;
    }
  }

  // ─── 5a. Initialize feature store ──────────────────────
  initFeatureStore(yeaftDir, { readOnly: config._readOnly || false });

  // ─── 5b. (H2.f.5) thread store retired. Single conversation. ───

  // ─── 5c. D1 first-boot seed (task-334m) ─────────────────
  //         When no groups exist on disk AND we're not in read-only mode,
  //         seed a default group with roster = all VPs in the library,
  //         defaultVpId = alphabetically first. Idempotent — no-op when
  //         any group already exists. Never throws; failure logs a warning
  //         so session load always succeeds.
  if (!config._readOnly) {
    // task-337: seed the 12 default VPs (steve, linus, martin, …) on a fresh
    // install so the library is never empty. Idempotent — a no-op once the
    // user has any VP on disk. Must run BEFORE ensureDefaultGroupIfEmpty so
    // the default group's roster scan sees the seeded VPs. Must also run
    // before any VpLoader.start() (VpLoader is lazy-started in vp-bridge.js
    // on first subscribe, which happens strictly after loadSession returns).
    try {
      seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    } catch (err) {
      console.warn(`[Yeaft] seedDefaultVps failed: ${err?.message || err}`);
    }
    try {
      ensureDefaultGroupIfEmpty(yeaftDir, { memoryRoot: join(yeaftDir, 'memory') });
    } catch (err) {
      console.warn(`[Yeaft] ensureDefaultGroupIfEmpty failed: ${err?.message || err}`);
    }

    // task-fix-memory-load: backfill summary.md for VPs / groups created
    // before the create-time seed was added. Without this, an existing
    // user's `grp_claude` and `steve` VP have an empty Layer-A resident
    // summary every turn (memory section in the system prompt is just
    // the `active_scope` header). Idempotent — only writes when missing.
    try {
      runSummaryBackfill({
        yeaftDir,
        libDir: join(yeaftDir, 'virtual-persons'),
        root: join(yeaftDir, 'memory'),
      });
    } catch (err) {
      console.warn(`[Yeaft] runSummaryBackfill failed: ${err?.message || err}`);
    }
  }

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
    memoryIndex,
    amsRegistry,
    toolRegistry,
    skillManager,
    mcpManager,
    yeaftDir,
  });

  // ─── 9a-pre. Create per-group history Compactor ────────
  // Owns the post-turn single-flight + race-guarded compactor that used
  // to live inline in web-bridge.js. Bridge keeps history ownership and
  // wires the WS sink (`unify_history_compacted`) via
  // `compactor.setOnCompacted` from `installUnifyRuntimeBridge`.
  const compactor = new Compactor({
    summarize: ({ system, prompt, maxTokens } = {}) =>
      engine.summarizeForCompact({ system, prompt, maxTokens }),
    getMaxContextTokens: () =>
      typeof config.maxContextTokens === 'number' ? config.maxContextTokens : undefined,
    // Live-read: `config.language` is mutated in place by
    // `engine.setLanguage()` (which broadcastLanguageChange fans out to
    // every per-VP engine). The compactor must see the post-broadcast
    // value, not a boot-time snapshot, so the summary prompt + the
    // "session continued" wrapper render in the user's current locale.
    getLanguage: () =>
      typeof config.language === 'string' ? config.language : undefined,
  });

  // ─── 9a. Create dream scheduler ────────────
  // The legacy R6 dream-scheduler was retired alongside recall-r6;
  // dream-v2 is the only active path (the `config.memoryV2` opt-out
  // flag was retired in task-710 — wiring is unconditional).
  // partialSession lets the v2 scheduler dereference adapter/config/
  // engine/trace lazily — safe because callers attach more fields
  // after this line.
  const partialSession = {
    yeaftDir,
    adapter,
    config,
    engine,
    trace,
  };
  const dreamScheduler = createV2DreamScheduler(partialSession);

  // task-710: kick a dream pass at boot for any group that has user
  // messages but zero memory segments in the FTS index. Without this a
  // freshly opened agent had to wait an hour (or for the nudge counter
  // to cross 50) before the first segment landed and recall could find
  // anything. Fire-and-forget; failure logs at debug only.
  if (memoryIndex && !config._readOnly) {
    bootInitEmptyGroups({
      yeaftDir,
      memoryIndex,
      dreamScheduler,
      config,
    }).catch(() => { /* best-effort boot init */ });
  }

  // fix/dream-cadence-and-ui-trigger: stale-cadence catch-up. If the
  // newest per-group lastDreamAt across all groups is older than
  // DREAM_INTERVAL_HOURS (or absent and there's user traffic), fire a
  // single non-manual tick now. Independent of the interval timer —
  // necessary because production observed 12 days between scheduled
  // ticks (the unref'd interval did not fire reliably on long-lived
  // server processes).
  if (!config._readOnly) {
    bootCatchUpStaleDream({
      yeaftDir,
      dreamScheduler,
      config,
    }).catch(() => { /* best-effort catch-up */ });
  }

  // H2.f.5: thread engine registry, input queue, and dispatcher retired.
  // The session exposes a single `engine`; web-bridge calls engine.query()
  // directly. Memory recall happens via memory/preflow.js (pre-turn) and
  // memory/adjust.js (post-turn).

  // ─── 10. Build session ─────────────────────────────────
  const status = {
    skills: skillManager.size,
    mcpServers: mcpStatus.connected,
    mcpFailed: mcpStatus.failed,
    tools: toolRegistry.size,
  };

  /** Graceful shutdown: disconnect MCP, close trace DB, stop dream scheduler. */
  async function shutdown() {
    try {
      dreamScheduler.shutdown();
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
    try {
      if (memoryIndex) memoryIndex.close();
    } catch {
      // Best-effort cleanup
    }
    try {
      if (amsRegistry) amsRegistry.persistAll();
    } catch {
      // Best-effort cleanup
    }
  }

  return {
    engine,
    adapter,
    config,
    conversationStore,
    dreamScheduler,
    compactor,
    skillManager,
    mcpManager,
    toolRegistry,
    trace,
    yeaftDir,
    status,
    amsRegistry,
    shutdown,
    // task-325c: user-initiated abort API. Delegates to web-bridge which
    // owns the single AbortController. Lazy-imported to avoid a hard cycle
    // with web-bridge.js (which already imports this module to call
    // loadSession).
    async abort(opts = {}) {
      const { abortUnifySession } = await import('./web-bridge.js');
      return abortUnifySession(opts);
    },
  };
}
