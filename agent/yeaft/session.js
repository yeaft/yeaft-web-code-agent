/**
 * session.js — Session orchestrator for Yeaft Yeaft
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
import { flushAgentPerfTrace } from './perf-trace.js';
import { createLLMAdapter } from './llm/adapter.js';
import { withUsageAccounting } from './llm/usage-accounting.js';
import { recordAgentTokenUsage } from '../metrics.js';
import { ConversationStore, setDefaultRecentTurnsLimit } from './conversation/persist.js';
import { SkillManager, createSkillManager } from './skills.js';
import { MCPManager } from './mcp.js';
import { resolveMcpPluginPolicy } from './plugins.js';
import { createFullRegistry } from './tools/index.js';
import { buildMcpFlattenedTools } from './tools/mcp-tools.js';
import { Engine } from './engine.js';
import { ToolUsageStats } from './stats/tool-usage.js';
import { TaskManager } from './tasks/manager.js';
// H2.f.5 removed the old user-facing thread pipeline/dispatcher. The base
// session still exposes a single default Engine; PR #797 adds group VP thread
// engines in web-bridge runtime state, keyed below the session layer.
//
// GC.1 (final): the session opens a SegmentIndex (SQLite FTS5 over
// memory.md) and passes it to the Engine. Engine.#recallMemory routes
// pre-turn recall through sessions/pre-flow.js → memory/preflow.js (the
// previous per-scope file reader recall-v2.js has been deleted).
// The `config.memoryV2` opt-out flag was retired in task-710; wiring is
// unconditional.
//
// When memoryIndex is wired we also open an AmsRegistry. It caches the
// per-Session ActiveMemorySet object and keeps the version-1 ams.json shape for
// disk compatibility. Engine rebuilds prompt-facing Resident entries from
// query-selected canonical content on every turn; persisted segment ids are
// never rehydrated into the prompt.
import { ensureDefaultSessionIfEmpty, migrateRegisteredWorkDirSessions } from './sessions/session-crud.js';
import { seedDefaultVps } from './vp/seed-defaults.js';
import { topUpDefaultVps } from './vp/seed-topup.js';
import { archiveLegacyScopes } from './memory/seed-backfill.js';
// Dream scheduler wiring is intentionally not imported while the runtime path is disabled.
// import { createV2DreamScheduler, bootInitEmptyGroups, bootCatchUpStaleDream } from './dream/session-wiring.js';
import { isWorkCenterEnabled } from './work-center/feature.js';
import { openSegmentIndex } from './memory/index-db.js';
import { syncAll as syncSegmentIndex } from './memory/segment-sync.js';
import { backfillCanonicalContent } from './memory/content-backfill.js';
import { openAmsRegistry } from './memory/ams-registry.js';
import { join } from 'path';
import { existsSync as existsSyncSafe, readFileSync as readFileSyncSafe, mkdirSync as mkdirSyncSafe } from 'fs';

/**
 * @typedef {Object} SessionOptions
 * @property {string} [dir] — Yeaft data directory override (default: ~/.yeaft)
 * @property {string} [workDir] — Session workDir; used only for project-tier assets such as skills/MCP, while Session data stays under the user-level dir
 * @property {string} [model] — Model override
 * @property {string} [language] — Language override ('en' | 'zh')
 * @property {boolean} [debug] — Debug mode override
 * @property {boolean} [skipMCP] — Skip MCP server connections (faster startup)
 * @property {boolean} [skipSkills] — Skip skill loading
 * @property {object[]} [extraTools] — Additional ToolDef objects to register
 * @property {object} [configOverrides] — Additional config overrides
 * @property {Promise<Array>} [managedCliReady] — optional entrypoint-owned CLI setup
 * @property {boolean} [workCenterEnabled] — override Work Center producer-tool registration
 */

/**
 * @typedef {Object} Session
 * @property {Engine} engine — The wired engine, ready for .query()
 * @property {import('./llm/adapter.js').LLMAdapter} adapter — The LLM adapter
 * @property {object} config — Resolved configuration
 * @property {ConversationStore} conversationStore — Conversation persistence
 * @property {SkillManager} skillManager — Skill manager
 * @property {MCPManager} mcpManager — MCP manager
 * @property {import('./tools/registry.js').ToolRegistry} toolRegistry — Tool registry
 * @property {import('./debug-trace.js').DebugTrace|import('./debug-trace.js').NullTrace} trace
 * @property {string} yeaftDir — Resolved data directory path
 * @property {Promise<Array>} managedCliReady — optional CLI setup completion
 * @property {{ skills: number, mcpServers: string[], mcpFailed: object[], tools: number }} status
 * @property {() => Promise<void>} shutdown — Graceful shutdown
 */

/**
 * Eagerly create `<yeaftDir>/stats/` and surface failures as a warn.
 *
 * Returns the resolved path either way — the caller can still pass it
 * to `ToolUsageStats`, which keeps an in-memory counter path even when
 * the disk is read-only.
 *
 * NOTE: this knowledge ("stats lives under `stats/`") belongs inside
 * `ToolUsageStats.init()`. Once that exists, delete this helper and
 * the call site collapses to `await toolStats.init(yeaftDir)`.
 *
 * @param {string} yeaftDir
 * @returns {string} statsDir
 */
function prepareToolStatsDir(yeaftDir) {
  const statsDir = join(yeaftDir, 'stats');
  try {
    mkdirSyncSafe(statsDir, { recursive: true });
  } catch (err) {
    console.warn(
      `[Yeaft] Could not create stats dir ${statsDir}: ${err?.message || err}. ` +
      `Tool-usage counters will live in memory only.`
    );
  }
  return statsDir;
}

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
    workDir,
    model,
    language,
    debug,
    skipMCP = false,
    skipSkills = false,
    extraTools = [],
    configOverrides = {},
    serverMode = false,
    dreamEnabled,
    managedCliReady = null,
    workCenterEnabled = isWorkCenterEnabled(),
  } = options;

  // ─── 1. Determine config + store directories ─────────────
  //        Must happen BEFORE loadConfig so that first-run generates a
  //        default config.json that loadConfig can read. Session data
  //        (metadata/roster/config/messages/memory/tasks) is agent-user data
  //        and stays under configDir (`~/.yeaft`). workDir is only a project
  //        tier for assets such as skills and MCP config.
  const overrides = { ...configOverrides };
  if (dir) overrides.dir = dir;
  if (model) overrides.model = model;
  if (language) overrides.language = language;
  if (debug !== undefined) overrides.debug = debug;

  const sessionWorkDir = typeof workDir === 'string' && workDir.trim() ? workDir.trim() : '';
  const configDir = overrides.dir || process.env.YEAFT_DIR || DEFAULT_YEAFT_DIR;
  const yeaftDir = configDir;
  const configInitResult = initYeaftDir(configDir);
  const storeInitResult = configInitResult;
  overrides.dir = configDir;

  const managedCliInstall = managedCliReady || Promise.resolve([]);

  // Log any warnings from directory initialization.
  const initWarnings = configInitResult.warnings;
  for (const w of initWarnings) {
    console.warn(`[Yeaft] ${w}`);
  }

  // ─── 2. Load config ───────────────────────────────────
  const config = loadConfig(overrides);
  // fix/dream-cadence-and-ui-trigger: tag config so the dream scheduler
  // can decide whether to keep its interval timer alive (server) or
  // unref it (CLI / tests). Non-persisted — set per-session by caller.
  if (serverMode) config.serverMode = true;
  if (typeof dreamEnabled === 'boolean') config.dream.enabled = dreamEnabled;

  // Propagate the (clamped) cold-start replay window to the conversation
  // store. The default is 20 turns; a user wanting more recall after a
  // fresh boot sets `yeaft.recentTurnsLimit` in ~/.yeaft/config.json.
  // Called once per session boot — subsequent boots overwrite the
  // module-level default safely (single-process model).
  if (config?.yeaft?.recentTurnsLimit) {
    setDefaultRecentTurnsLimit(config.yeaft.recentTurnsLimit);
  }

  // ─── 2.1 Migration state check (task-334i) ────────────
  //        If the group-chat feature flag is on but migration has not
  //        completed, warn the user. Do NOT auto-run migration: that is
  //        an explicit action via bin/yeaft-migrate.js.
  try {
    if (config?.features?.yeaftGroupChat === true) {
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
          '[Yeaft] features.yeaftGroupChat=true but storage migration is not complete. ' +
          'Run `yeaft-migrate` before using the new group-chat tree, or unset the flag.',
        );
      }
    }
  } catch { /* never let this warn path block session load */ }

  // ─── 2.2 R6 → v2 auto-migration retired ───────────────
  //         The R6 shard layout is gone — memory writes go through
  //         dream directly. Existing users have already migrated
  //         (state file in ~/.yeaft/.memory-v2-migration.json).

  // ─── 2.3 Project-session migration ─────────────────────
  //         Session data used to be allowed under `<workDir>/.yeaft/sessions`.
  //         It is now user-level only (`~/.yeaft/sessions`). Copy any registered
  //         project-backed sessions into the user root before stores open.
  try {
    const migration = migrateRegisteredWorkDirSessions(configDir);
    if (migration.migrated.length > 0 || migration.errors.length > 0) {
      console.log(
        `[Yeaft] session project-store migration: migrated=${migration.migrated.length} ` +
        `errors=${migration.errors.length}`,
      );
    }
  } catch (err) {
    console.warn(`[Yeaft] session project-store migration failed: ${err?.message || err}`);
  }

  // ─── 2a. Permission pre-check ─────────────────────────
  //         If the data dir is not writable, mark session as read-only.
  //         Persistence (conversation, memory, dream) is skipped in this mode.
  if (!storeInitResult.writable) {
    config._readOnly = true;
    console.warn(`[Yeaft] ${yeaftDir} is not writable — running in read-only mode`);
  }

  // ─── 3. Create trajectory trace ─────────────────────────
  // Debug traces can contain prompts, tool payloads, and provider envelopes.
  // Keep collection opt-in and avoid scanning trace history during Session boot.
  const trace = createTrace({
    enabled: config.debug === true,
    dirPath: yeaftDir,
    textMaxBytes: config.telemetry?.traceTextMaxBytes,
  });

  // ─── 4. Create LLM adapter ────────────────────────────
  const adapter = withUsageAccounting(
    await createLLMAdapter(config),
    recordAgentTokenUsage
  );

  // ─── 5. Create stores ──────────────────────────────────
  const conversationStore = new ConversationStore(yeaftDir);

  // ─── 5-fts. (GC.1) Open SegmentIndex for FTS pre-flow ────
  //     Build a SQLite FTS5 index over per-scope evidence memory.md and
  //     canonical content.md, then pass it to Engine for scope selection.
  //     Engine.#recallMemory uses it via sessions/pre-flow.js →
  //     memory/preflow.js. Disk is the source of
  //     truth; on boot we reconcile disk → index via syncAll. Failure
  //     to open the index is non-fatal: #recallMemory returns an empty
  //     result and the turn proceeds without pre-injected memory.
  let memoryIndex = null;
  if (!config._readOnly) {
    try {
      const indexPath = join(yeaftDir, 'memory', 'index.db');
      memoryIndex = openSegmentIndex(indexPath);
      const memoryRoot = join(yeaftDir, 'memory');
      // One-shot migration to the group-isolated memory layout: move any
      // remaining top-level vp/ feature/ topic/ dirs into .legacy/ before
      // we open the FTS index and re-sync from disk.
      try {
        archiveLegacyScopes(memoryRoot);
      } catch (archiveErr) {
        if (config.debug) {
          console.warn(`[Yeaft] legacy scope archive warning: ${archiveErr?.message || archiveErr}`);
        }
      }
      try {
        backfillCanonicalContent(memoryRoot);
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

  // ─── 5-ams. Session-keyed AMS registry ─────────────────
  //     The registry caches one ActiveMemorySet per sessionId and
  //     retains version-1 metadata for disk compatibility. Prompt state is
  //     rebuilt from selected canonical content each turn; old segment ids are
  //     not rehydrated. Without memoryIndex the registry remains disabled.
  let amsRegistry = null;
  if (memoryIndex && !config._readOnly) {
    try {
      amsRegistry = openAmsRegistry({ yeaftDir, memoryIndex, config });
    } catch (err) {
      console.warn(`[Yeaft] Failed to open AMS registry (adjust disabled): ${err?.message || err}`);
      amsRegistry = null;
    }
  }

  // ─── 5a. (removed 2026-05-13) Feature store init — Feature system retired.

  // ─── 5b. (H2.f.5) user-facing thread store retired. ───

  // ─── 5c. D1 first-boot seed (task-334m) ─────────────────
  //         When no groups exist on disk AND we're not in read-only mode,
  //         seed a default group with roster = all VPs in the library,
  //         defaultVpId = alphabetically first. Idempotent — no-op when
  //         any group already exists. Never throws; failure logs a warning
  //         so session load always succeeds.
  if (!config._readOnly) {
    // task-337: seed the default VPs (steve, linus, martin, kongzi, buffett, omni, …)
    // on a fresh install so the library is never empty. Idempotent — a no-op
    // once the user has any VP on disk. Must run BEFORE ensureDefaultSessionIfEmpty
    // so the default group's roster scan sees the seeded VPs. Must also run
    // before any VpLoader.start() (VpLoader is lazy-started in vp-bridge.js
    // on first subscribe, which happens strictly after loadSession returns).
    try {
      seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    } catch (err) {
      console.warn(`[Yeaft] seedDefaultVps failed: ${err?.message || err}`);
    }
    // VP roster expansion: for existing installs that already had the original
    // 12 VPs before the roster grew, top up the missing ones AND backfill
    // the `area` frontmatter line on legacy role.md files. NEVER overwrites
    // hand-edited VPs and NEVER recreates a VP the user explicitly deleted
    // (tracked via `.seeded-versions.json`). Best-effort — never throws.
    try {
      const result = topUpDefaultVps(join(yeaftDir, 'virtual-persons'));
      if (result.added.length > 0 || result.areaBackfilled.length > 0) {
        console.log(
          `[Yeaft] vp-topup: added=${result.added.length} ` +
          `area-backfilled=${result.areaBackfilled.length} ` +
          `respected-deletes=${result.respectedDeletes.length}`,
        );
      }
      // Top-up is best-effort but per-VP failures are still worth surfacing —
      // otherwise a permission glitch on a single role.md backfill goes
      // invisible. We never throw on them; we just log.
      if (result.errors && result.errors.length > 0) {
        for (const e of result.errors) {
          console.warn(`[Yeaft] vp-topup ${e.code} on ${e.vpId}: ${e.message}`);
        }
      }
    } catch (err) {
      console.warn(`[Yeaft] topUpDefaultVps failed: ${err?.message || err}`);
    }
    // fix-yeaft-session-server-persistence: stop auto-seeding a
    // `grp_default` per agent. Previously every agent that booted with
    // zero sessions would manufacture an empty default group, which on
    // the unified sidebar shows up as a phantom row distinct from the
    // user's real session — and on agent switch it stole the active-
    // session slot. With server-side persistence the user's actual
    // yeaft sessions are now hydrated from the DB; if they have none,
    // the sidebar shows the empty state + "create session" CTA, which
    // is the explicit behaviour the user asked for.

    // 2026-06-09 (VP per-session isolation): `runSummaryBackfill` was
    // removed here. It walked `vp/<id>/` and `group/<id>/` at the memory
    // root, writing `summary.md` files into bare paths the Engine never
    // reads (`engine.#loadLayerASummaries` reads `group/<sid>/vp/<id>/...`
    // — kind:'group-vp'). The backfill therefore generated orphan files
    // on every boot. See `memory/seed-backfill.js` for the historical
    // context. Real seeding happens at create time via
    // `seedSummaryIfMissingSync` from `store.js`, called by vp-crud /
    // group-crud / seed-default — those write to the correct scope dirs.
  }

  // ─── 6. Load skills ────────────────────────────────────
  // User/global runtime assets still come from configDir. workDir, when
  // present, is only a project tier overlay plus the storage root.
  const projectTierRoot = sessionWorkDir || process.cwd();

  let loadedSkillManager;
  if (skipSkills) {
    // Pass the literal user-tier dir (matches the normal branch's tier 2)
    // so any save/remove calls land in the same place users expect. New
    // `SkillManager` API takes literal scan dirs — no auto-suffix of /skills.
    loadedSkillManager = new SkillManager(join(configDir, 'skills'));
    // Don't call .load() — empty skill manager
  } else {
    loadedSkillManager = createSkillManager(configDir, projectTierRoot);
  }
  const skillManager = loadedSkillManager;

  // ─── 7. Connect MCP servers ────────────────────────────
  const rawMcpConfig = loadMCPConfig(configDir, undefined, projectTierRoot);
  const { effective: mcpConfig } = resolveMcpPluginPolicy(rawMcpConfig, config.plugins);
  const mcpManager = new MCPManager();
  let mcpStatus = { connected: [], failed: [] };

  if (!skipMCP && mcpConfig.servers.length > 0) {
    mcpStatus = await mcpManager.connectAll(mcpConfig.servers);
  }

  // ─── 8. Build tool registry ────────────────────────────
  const taskManager = new TaskManager({ yeaftDir });
  const toolRegistry = createFullRegistry();
  if (!workCenterEnabled) toolRegistry.unregister('CreateWorkItem');

  // Register any extra tools from caller
  for (const tool of extraTools) {
    toolRegistry.register(tool);
  }

  // Register flattened MCP tools (one ToolDef per MCP tool, named
  // `mcp__<server>__<tool>` per Claude Code's convention). This replaces
  // the legacy mcp_list_tools / mcp_call_tool meta-tools — the LLM now
  // calls MCP tools directly in a single turn, no discovery dance.
  // Re-built and re-registered on every connect/disconnect via
  // `toolRegistry.replaceMcpTools(mcpManager, buildMcpFlattenedTools)`
  // which is invoked from the MCP web-bridge handlers.
  if (mcpManager.hasServers) {
    const flattened = buildMcpFlattenedTools(mcpManager);
    for (const tool of flattened) {
      toolRegistry.register(tool);
    }
  }

  // ─── 9. Create engine (wires everything) ───────────────
  // Tool-call usage statistics: persisted to <yeaftDir>/stats/tool-usage.json.
  // Loaded synchronously at boot so the first turn already sees prior counts.
  // Threaded into the engine so it can `record` each tool_exec event.
  //
  // 2026-05-16: eagerly create the `stats/` directory at boot. The
  // ToolUsageStats writer does `fsp.mkdir(..., {recursive:true})` lazily
  // inside `#doFlush()` and swallows any mkdir error, which meant an
  // unwritable parent (perm denied, ENOSPC) was silently invisible
  // until the user filed a support ticket. Doing it here surfaces the
  // failure as a console.warn while still leaving the in-memory
  // counter path functional — the engine keeps recording even if the
  // disk is read-only.
  //
  // FOLLOW-UP: this leaks `ToolUsageStats`'s storage layout (its
  // directory name) into the session orchestrator. The right home is
  // a `ToolUsageStats.init()` that owns the mkdir + the warn + a
  // `writesDisabled` flag. Tracking as future work; for now the helper
  // below visually quarantines the leak so the migration is one delete.
  const statsDir = prepareToolStatsDir(yeaftDir);
  const toolStats = new ToolUsageStats({
    path: join(statsDir, 'tool-usage.json'),
  });
  toolStats.loadSync();
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
    toolStats,
    taskManager,
    managedCliReady: managedCliInstall,
  });


  // ─── 9a. Dream runtime temporarily disabled ────────────
  // Message history now supplies turn context. Keep the Dream implementation
  // and persisted data intact, but do not create a scheduler or run boot-time
  // initialization/catch-up while the replacement is evaluated.
  //
  // const partialSession = { yeaftDir, adapter, config, engine, trace };
  // const dreamScheduler = createV2DreamScheduler(partialSession);
  // if (memoryIndex && !config._readOnly) {
  //   bootInitEmptyGroups({ yeaftDir, memoryIndex, dreamScheduler, config }).catch(() => {});
  // }
  // if (!config._readOnly) {
  //   bootCatchUpStaleDream({ yeaftDir, dreamScheduler, config }).catch(() => {});
  // }
  const dreamScheduler = null;

  // H2.f.5 retired the old session-level thread engine registry, input queue,
  // and dispatcher. The session exposes a default `engine`; PR #797 keeps
  // Session VP thread engines in web-bridge runtime state and calls engine.query()
  // directly. Query-time recall happens via memory/preflow.js.

  // ─── 10. Build session ─────────────────────────────────
  const status = {
    skills: skillManager.size,
    mcpServers: mcpStatus.connected,
    mcpFailed: mcpStatus.failed,
    // Project `.mcp.json` servers we couldn't spawn (e.g. SSE/HTTP transport).
    // Surfaced (not silently dropped) so the UI can explain why a configured
    // server isn't available.
    mcpSkipped: mcpConfig.skipped || [],
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
      await trace.close();
    } catch {
      // Trace might not have close() (NullTrace)
    }
    try {
      flushAgentPerfTrace(config);
    } catch {
      // Performance telemetry is best-effort and must not block shutdown.
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
    try {
      if (toolStats && typeof toolStats.flush === 'function') {
        await toolStats.flush();
      }
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
    skillManager,
    mcpManager,
    toolRegistry,
    trace,
    yeaftDir,
    status,
    memoryIndex,
    amsRegistry,
    toolStats,
    taskManager,
    managedCliReady: managedCliInstall,
    shutdown,
    // task-325c: user-initiated abort API. Delegates to web-bridge which
    // owns the single AbortController. Lazy-imported to avoid a hard cycle
    // with web-bridge.js (which already imports this module to call
    // loadSession).
    async abort(opts = {}) {
      const { abortYeaftSession } = await import('./web-bridge.js');
      return abortYeaftSession(opts);
    },
  };
}
