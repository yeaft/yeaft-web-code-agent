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
import { createLLMAdapter } from './llm/adapter.js';
import { ConversationStore, setDefaultRecentTurnsLimit } from './conversation/persist.js';
import { SkillManager, createSkillManager } from './skills.js';
import { MCPManager } from './mcp.js';
import { createFullRegistry } from './tools/index.js';
import { buildMcpFlattenedTools } from './tools/mcp-tools.js';
import { Engine } from './engine.js';
import { Compactor } from './compact/compactor.js';
import { resolveContextWindow } from './models.js';
import { ToolUsageStats } from './stats/tool-usage.js';
// H2.f.5 removed the old user-facing thread pipeline/dispatcher. The base
// session still exposes a single default Engine; PR #797 adds group VP thread
// engines in web-bridge runtime state, keyed below the session layer.
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
import { ensureDefaultSessionIfEmpty } from './sessions/session-crud.js';
import { seedDefaultVps } from './vp/seed-defaults.js';
import { topUpDefaultVps } from './vp/seed-topup.js';
import { archiveLegacyScopes } from './memory/seed-backfill.js';
import { createV2DreamScheduler, bootInitEmptyGroups, bootCatchUpStaleDream } from './dream/session-wiring.js';
import { openSegmentIndex } from './memory/index-db.js';
import { syncAll as syncSegmentIndex } from './memory/segment-sync.js';
import { openAmsRegistry } from './memory/ams-registry.js';
import { join } from 'path';
import { existsSync as existsSyncSafe, readFileSync as readFileSyncSafe, mkdirSync as mkdirSyncSafe } from 'fs';

/**
 * Application-wide default for `Compactor`'s trigger ratio (the
 * "fraction of model context" gate). The user-stated requirement is
 * "model context 的 70%"; this is the canonical literal for it. Lives
 * in session.js (not in compactor.js) because `Compactor` is also used
 * by test fixtures that intentionally skip the ratio injector to
 * exercise the library default (`history-compact.js#DEFAULT_TOKEN_FRACTION`).
 * The two defaults are kept separate on purpose — see the Compactor
 * constructor JSDoc for the boundary.
 */
const DEFAULT_COMPACT_TRIGGER_RATIO = 0.7;

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

  // ─── 2a. Permission pre-check ─────────────────────────
  //         If the data dir is not writable, mark session as read-only.
  //         Persistence (conversation, memory, dream) is skipped in this mode.
  if (!initResult.writable) {
    config._readOnly = true;
    console.warn(`[Yeaft] ${yeaftDir} is not writable — running in read-only mode`);
  }

  // ─── 3. Create trajectory trace ─────────────────────────
  // feat-always-on-trajectory-store: the trace is no longer gated on
  // config.debug. It is a TRAJECTORY STORE: every turn's full
  // (system_prompt, messages, tool_calls, tool_results, response, usage)
  // is persisted to ~/.yeaft/debug.db so it can serve two purposes:
  //   1. Debug panel hydration — user opens "请求日志" and sees prior turns.
  //   2. SFT / RL training data — scripts can later dump JSONL trajectories.
  // Cost is negligible (one insert per turn, WAL mode), and the data only
  // accumulates while the user actually uses the agent. The previous gate
  // silently discarded every turn unless the user had set debug:true in
  // ~/.yeaft/config.json, which nobody ever did — wasting the asset.
  const trace = createTrace({
    enabled: true,
    dbPath: join(yeaftDir, 'debug.db'),
  });
  // Bound disk growth: prune trajectories older than 30 days on session load.
  // Cheap (indexed DELETE), runs once per process start, not per turn. Without
  // this the always-on store grows unbounded — cleanup() existed but had zero
  // call sites before this PR.
  try { trace.cleanup?.(30); } catch (err) {
    console.warn('[Yeaft] trace.cleanup failed:', err?.message || err);
  }

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
  //     The registry caches one ActiveMemorySet per sessionId and
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
  let skillManager;
  if (skipSkills) {
    skillManager = new SkillManager(yeaftDir);
    // Don't call .load() — empty skill manager
  } else {
    // Pass the agent's current working directory as the project tier root.
    // Per-session/per-group workdirs override at tool-execution time via
    // ToolContext.cwd; for the SYSTEM-PROMPT skill set we just use the
    // agent process cwd, which is the common case when an agent is
    // launched inside a project the user wants project-tier skills for.
    const projectTierRoot = process.cwd();
    skillManager = createSkillManager(yeaftDir, projectTierRoot);
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
  });

  // ─── 9a-pre. Create per-group history Compactor ────────
  // Owns the post-turn single-flight + race-guarded compactor that used
  // to live inline in web-bridge.js. Bridge keeps history ownership and
  // wires the WS sink (`yeaft_history_compacted`) via
  // `compactor.setOnCompacted` from `installYeaftRuntimeBridge`.
  const compactor = new Compactor({
    summarize: ({ system, prompt, maxTokens } = {}) =>
      engine.summarizeForCompact({ system, prompt, maxTokens }),
    // Resolve the model's true context window (GPT-5 256K vs Claude 200K
    // etc.) instead of pinning to a flat `config.maxContextTokens`.
    // The 70% threshold then floats with the model in use — the
    // user-stated requirement ("超过 model context 70% 这一个约束").
    getMaxContextTokens: () =>
      resolveContextWindow(
        typeof config.model === 'string' && config.model
          ? config.model
          : (config.primaryModel || ''),
        config
      ),
    // Trigger ratio knob. Defaults to DEFAULT_COMPACT_TRIGGER_RATIO (0.7)
    // per the user directive; a finite number in (0, 1) wins. Anything
    // else (NaN, ≤0, ≥1, missing) falls back to the default so a typo in
    // config.json can't disable compact.
    getTriggerRatio: () => {
      const r = Number(config?.compactTriggerRatio);
      return Number.isFinite(r) && r > 0 && r < 1 ? r : DEFAULT_COMPACT_TRIGGER_RATIO;
    },
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
  // dream is the only active path (the `config.memoryV2` opt-out
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

  // H2.f.5 retired the old session-level thread engine registry, input queue,
  // and dispatcher. The session exposes a default `engine`; PR #797 keeps
  // group VP thread engines in web-bridge runtime state and calls engine.query()
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
    compactor,
    skillManager,
    mcpManager,
    toolRegistry,
    trace,
    yeaftDir,
    status,
    amsRegistry,
    toolStats,
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
