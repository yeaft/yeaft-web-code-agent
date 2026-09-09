#!/usr/bin/env node
/**
 * cli.js — Yeaft Yeaft CLI entry point
 *
 * Uses loadSession() to wire all subsystems (Engine, ToolRegistry, SkillManager,
 * MCPManager, Dream, StopHooks, Memory) into a single session.
 *
 * Features:
 *   --dry-run "prompt"   — Assemble system prompt + messages, don't call LLM
 *   --trace stats|recent|search <keyword>|tools|compact  — Query/maintain debug trace files
 *   -i / --interactive   — REPL mode with / commands
 *   <prompt>             — One-shot query (Phase 1: engine.query)
 *   --skip-mcp           — Skip MCP server connections (faster startup)
 *   --skip-skills        — Skip skill loading
 *
 * REPL commands:
 *   /history             — Show conversation history
 *   /history [n]         — Show last N messages from conversation
 *   /search <keyword>    — Search conversation history
 *   /compact             — Retired for native Yeaft; inspect history or Memory instead
 *   /tools               — List registered tools
 *   /skills              — List loaded skills
 *   Conversation persistence across REPL sessions
 */

import { createInterface } from 'readline';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { join } from 'path';
import { loadConfig } from './config.js';
import { DebugTrace } from './debug-trace.js';
import { loadSession } from './session.js';
import { listModels, resolveModel, parseModelRef, resolveContextWindow, resolveMaxOutputTokens } from './models.js';
import { buildSystemPrompt } from './prompts.js';
import { searchMessages } from './conversation/search.js';
import { ConversationStore } from './conversation/persist.js';
import { sessionsRoot, snapshotSessions } from './sessions/session-crud.js';
import { loadSessionConfig, resolveSessionConfig } from './sessions/session-config.js';
import { createSession } from './sessions/session-store.js';
import { addOrUpdateManifestSession, withSessionManifestLock } from './sessions/session-manifest.js';
import { validateSessionId } from './sessions/ids.js';
import {
  createJsonlWriter,
  JsonlInput,
  normalizeStreamRoutingIntent,
  normalizeStreamSessionBootstrap,
  runStreamTurn,
  runStreamSessionTurn,
} from './stdio-protocol.js';
import { createCliSessionRunner } from './cli-session-runner.js';
import { emitStreamTaskEvent, taskResultReentryContext } from './tasks/result-delivery.js';
import { TASK_RESULT_DELIVERY, taskResultDeliveryFor } from './tasks/store.js';
import { buildStreamSubAgentFrame } from './sub-agent/public-event.js';
import {
  cleanupManagedCliRuntimePaths,
  ensureManagedCliTools,
  prepareManagedCliToolEnvironment,
  summarizeManagedCliResults,
} from './managed-cli.js';

// ─── Argument parsing ──────────────────────────────────────────

export function parseArgs(argv) {
  const args = {
    debug: false,
    interactive: false,
    verbose: false,
    model: null,
    language: null,
    trace: null,     // 'stats' | 'recent' | 'search' | 'tools' | null
    traceArg: null,  // search keyword or tool name
    dryRun: false,
    skipMCP: false,
    skipSkills: false,
    compactOrphans: false,
    compactOrphansDry: false,
    deleteSession: null,
    sessionId: null,
    workDir: null,
    modelEffort: null,
    inputFormat: 'text',
    outputFormat: 'text',
    print: false,
    prompt: null,
    managedCliReady: Promise.resolve([]),
  };

  const rest = argv.slice(2);
  let i = 0;

  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '-d':
      case '--debug':
        args.debug = true;
        break;
      case '-i':
      case '--interactive':
        args.interactive = true;
        break;
      case '-v':
      case '--verbose':
        args.verbose = true;
        break;
      case '--model':
        args.model = rest[++i] || null;
        break;
      case '--effort':
      case '--model-effort':
        args.modelEffort = rest[++i] || null;
        break;
      case '--session-id':
      case '--resume':
        args.sessionId = rest[++i] || null;
        break;
      case '--cwd':
      case '--work-dir':
        args.workDir = rest[++i] || null;
        break;
      case '--input-format':
        args.inputFormat = rest[++i] || 'text';
        break;
      case '--output-format':
        args.outputFormat = rest[++i] || 'text';
        break;
      case '-p':
      case '--print':
        args.print = true;
        break;
      case '--language':
        args.language = rest[++i] || null;
        break;
      case '--trace':
        args.trace = rest[++i] || 'stats';
        if (['search', 'tools'].includes(args.trace) && i + 1 < rest.length && !rest[i + 1].startsWith('-')) {
          args.traceArg = rest[++i];
        }
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--skip-mcp':
        args.skipMCP = true;
        break;
      case '--skip-skills':
        args.skipSkills = true;
        break;
      case '--compact-orphans':
        args.compactOrphans = true;
        break;
      case '--compact-orphans-dry':
        args.compactOrphansDry = true;
        break;
      case '--delete-group':
        args.deleteSession = rest[++i] || null;
        break;
      default:
        if (!arg.startsWith('-') && !args.prompt) {
          args.prompt = arg;
        }
        break;
    }
    i++;
  }

  return args;
}

// ─── Trace query handler ───────────────────────────────────────

async function handleTraceQuery(args, config) {
  const traceDir = config.dir;
  let trace;
  try {
    trace = new DebugTrace(traceDir);
  } catch (e) {
    throw new Error(`Cannot open debug trace store at ${traceDir}: ${e.message}`);
  }

  try {
    switch (args.trace) {
      case 'stats': {
        const s = await trace.stats();
        console.log('Debug Trace Statistics:');
        console.log(`  Turns:    ${s.turnCount}`);
        console.log(`  Tools:    ${s.toolCount}`);
        console.log(`  Events:   ${s.eventCount}`);
        console.log(`  Disk:     ${(s.dbSizeBytes / 1024).toFixed(1)} KB`);
        break;
      }
      case 'recent': {
        const turns = await trace.queryRecent(20);
        if (turns.length === 0) {
          console.log('No recent turns.');
        } else {
          for (const t of turns) {
            const time = new Date(t.started_at).toLocaleString();
            const tokens = t.input_tokens != null ? `${t.input_tokens}+${t.output_tokens} tokens` : 'pending';
            const model = t.model || 'unknown';
            console.log(`  [${time}] ${model} | ${tokens} | ${t.stop_reason || 'running'}`);
          }
        }
        break;
      }
      case 'search': {
        if (!args.traceArg) {
          throw new Error('Usage: --trace search <keyword>');
        }
        const results = await trace.search(args.traceArg);
        console.log(`Found ${results.length} turns matching "${args.traceArg}":`);
        for (const t of results) {
          const time = new Date(t.started_at).toLocaleString();
          const preview = (t.response_text || '').slice(0, 80);
          console.log(`  [${time}] ${preview}...`);
        }
        break;
      }
      case 'tools': {
        const tools = await trace.queryTools({ name: args.traceArg });
        console.log(`Found ${tools.length} tool calls${args.traceArg ? ` for "${args.traceArg}"` : ''}:`);
        for (const t of tools.slice(0, 20)) {
          const time = new Date(t.created_at).toLocaleString();
          const status = t.is_error ? 'ERROR' : 'OK';
          console.log(`  [${time}] ${t.tool_name} | ${t.duration_ms || '?'}ms | ${status}`);
        }
        break;
      }
      case 'compact': {
        const s = await trace.stats();
        console.log(`Compacting debug trace files (${(s.dbSizeBytes / 1048576).toFixed(1)} MB, ${s.turnCount} turns)...`);
        console.log('This prunes old request folders and may take a moment. Do not interrupt.');
        const { before, after } = await trace.compact();
        const saved = Math.max(0, before - after);
        console.log(`Done. ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(1)} MB (reclaimed ${(saved / 1048576).toFixed(1)} MB).`);
        break;
      }
      default:
        throw new Error(`Unknown trace command: ${args.trace}. Available: stats, recent, search <keyword>, tools [name], compact`);
    }
  } finally {
    await trace.close();
  }
}

// ─── Dry-run handler ───────────────────────────────────────────

function handleDryRun(args, config) {
  const systemPrompt = buildSystemPrompt({ language: config.language });
  const messages = [];

  if (args.prompt) {
    messages.push({ role: 'user', content: args.prompt });
  }

  console.log('=== DRY RUN ===');
  console.log();
  console.log('--- Config ---');
  console.log(`  Model:    ${config.model}`);
  console.log(`  Adapter:  ${config.adapter || 'auto'}`);
  console.log(`  Debug:    ${config.debug}`);
  console.log();
  console.log('--- System Prompt ---');
  console.log(systemPrompt);
  console.log();
  console.log('--- Messages ---');
  for (const msg of messages) {
    console.log(`  [${msg.role}] ${msg.content}`);
  }
  if (messages.length === 0) {
    console.log('  (no messages)');
  }
  console.log();
  console.log('=== END DRY RUN ===');
}

// ─── Maintenance handlers (no LLM session needed) ──────────────

/**
 * One-shot orphan-message sweep. Reads the live group list off disk and
 * deletes every persisted message whose `sessionId` frontmatter is missing
 * or points to a group that no longer exists.
 *
 * Exposed via `--compact-orphans` (delete) and `--compact-orphans-dry`
 * (preview only). Defensive: if the live group list is unreadable, we
 * abort rather than wipe everything.
 */
function handleCompactOrphans(config, { dryRun = false } = {}) {
  const yeaftDir = config.dir;
  let groups;
  try {
    groups = snapshotSessions(yeaftDir);
  } catch (err) {
    console.error(`Cannot read groups directory: ${err.message}`);
    console.error('Refusing to compact orphans without an authoritative live-group list.');
    process.exitCode = 1;
    return;
  }
  const keepGroupIds = (groups || []).map(g => g.id).filter(Boolean);
  const store = new ConversationStore(yeaftDir);
  const result = store.compactOrphans({ keepGroupIds, dryRun });

  console.log(dryRun ? '=== COMPACT ORPHANS (dry run) ===' : '=== COMPACT ORPHANS ===');
  console.log(`  Live groups:   ${keepGroupIds.length}${keepGroupIds.length ? ` (${keepGroupIds.join(', ')})` : ''}`);
  console.log(`  Scanned:       ${result.scanned}`);
  console.log(`  Orphan files:  ${result.orphans.length}`);
  console.log(`  Removed:       ${result.removed}${dryRun ? ' (dry run — no files touched)' : ''}`);
  if (result.orphans.length > 0) {
    const preview = result.orphans.slice(0, 10);
    for (const p of preview) console.log(`    - ${p}`);
    if (result.orphans.length > preview.length) {
      console.log(`    ... and ${result.orphans.length - preview.length} more`);
    }
  }
}

/**
 * One-shot group hard-delete with cascade. Removes the group directory
 * AND every persisted message stamped with that group id. Same semantics
 * as the web-bridge `yeaft_delete_group` op, but reachable from the CLI
 * for scripted maintenance.
 */
function handleDeleteGroup(config, sessionId) {
  const yeaftDir = config.dir;
  // Lazy import to avoid loading the whole groups module on every CLI call.
  // (Static `import` at top is fine too — kept dynamic to mirror the web-bridge
  // pattern and keep the maintenance path self-contained.)
  // eslint-disable-next-line global-require
  return import('./sessions/session-crud.js').then(({ deleteSession }) => {
    let result;
    try {
      result = deleteSession(yeaftDir, sessionId);
    } catch (err) {
      console.error(`Failed to delete group ${sessionId}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    let messagesRemoved = 0;
    try {
      const store = new ConversationStore(yeaftDir);
      messagesRemoved = store.deleteByGroup(sessionId);
    } catch (err) {
      console.warn(`Group dir removed, but cascade failed: ${err.message}`);
    }
    console.log('=== DELETE GROUP ===');
    console.log(`  Group:               ${result.sessionId}`);
    console.log(`  Legacy archives swept: ${result.legacyCleanedUp}`);
    console.log(`  Messages cascaded:   ${messagesRemoved}`);
  });
}

// ─── REPL ──────────────────────────────────────────────────────

async function runREPL(config, args) {
  const workDir = resolve(args.workDir || process.cwd());
  const persisted = args.sessionId ? loadSessionConfig(config.dir, args.sessionId) : {};
  const effectiveConfig = resolveSessionConfig(config, persisted);
  const session = await loadSession({
    dir: config.dir,
    workDir,
    model: args.model || effectiveConfig.model,
    language: args.language || effectiveConfig.language,
    debug: args.debug || effectiveConfig.debug,
    skipMCP: args.skipMCP,
    skipSkills: args.skipSkills,
    configOverrides: effectiveConfig,
    managedCliReady: args.managedCliReady,
  });

  const { engine, conversationStore, trace, skillManager, mcpManager, toolRegistry } = session;
  const sessionRunner = args.sessionId
    ? createCliSessionRunner({ loaded: session, sessionId: args.sessionId, workDir })
    : null;
  if (args.sessionId && !sessionRunner) {
    await session.shutdown();
    throw new Error(`Session not found: ${args.sessionId}`);
  }

  // Load persisted conversation as initial messages. `loadRecent` is now
  // turn-based (one user round-trip = one turn; multi-VP fan-out collapses
  // into one turn). 20 turns is the bootstrap window. Provider requests
  // apply deterministic history-window trimming; persisted history stays
  // authoritative and no LLM conversation summary is generated.
  let conversationMessages = conversationStore.loadRecent().map(m => ({
    role: m.role,
    content: m.content,
    ...(m.toolCallId && { toolCallId: m.toolCallId }),
    ...(m.toolCalls && { toolCalls: m.toolCalls }),
    ...(m.providerState && { providerState: m.providerState }),
    ...(Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length > 0
      ? { thinkingBlocks: m.thinkingBlocks.map(block => ({ ...block })) }
      : {}),
  }));

  const hotCount = conversationStore.countHot();
  const coldCount = conversationStore.countCold();

  console.log(`Yeaft Yeaft REPL (model: ${session.config.model})`);
  console.log(`Conversation: ${hotCount} hot, ${coldCount} cold`);
  console.log(`Tools: ${session.status.tools} | Skills: ${session.status.skills}`);
  if (session.status.mcpServers.length > 0) {
    console.log(`MCP: ${session.status.mcpServers.join(', ')}`);
  }
  if (session.status.mcpFailed.length > 0) {
    console.log(`MCP failed: ${session.status.mcpFailed.map(f => f.name || f).join(', ')}`);
  }
  console.log('Type /help for commands, /quit to exit.');
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `yeaft> `,
  });

  let closeRequested = false;
  let lineQueue = Promise.resolve();
  let shutdownPromise = null;
  let acceptedLineSequence = 0;
  let exitLineSequence = Number.POSITIVE_INFINITY;
  const isExitLine = line => {
    const input = line.trim();
    if (!input.startsWith('/')) return false;
    const [command] = input.slice(1).split(/\s+/);
    return command === 'quit' || command === 'exit' || command === 'q';
  };
  const promptIfOpen = () => {
    if (!closeRequested) rl.prompt();
  };

  rl.prompt();

  const handleLine = async (line, lineSequence) => {
    if (lineSequence > exitLineSequence) return;
    const input = line.trim();
    if (!input) {
      promptIfOpen();
      return;
    }

    // Handle / commands
    if (input.startsWith('/')) {
      const [cmd, ...cmdArgs] = input.slice(1).split(/\s+/);
      switch (cmd) {
        case 'help':
          console.log('Commands:');
          console.log('  /debug                   — Toggle debug mode');
          console.log('  /trace <stats|recent>    — Query debug trace');
          console.log('  /history [n]             — Show last N messages');
          console.log('  /search <keyword>        — Search conversation history');
          console.log('  /compact                 — Retired; native Yeaft keeps transcript + Memory');
          console.log('  /context                 — Show context info');
          console.log('  /dry-run                 — Toggle dry-run mode');
          console.log('  /stats                   — Show session stats');
          console.log('  /model <name>            — Switch model (supports provider/model)');
          console.log('  /models                  — List available models');
          console.log('  /providers               — List configured providers');
          console.log('  /language <en|zh>        — Switch language');
          console.log('  /tools                   — List registered tools');
          console.log('  /skills                  — List loaded skills');
          console.log('  /clear                   — Clear conversation history');
          console.log('  /quit                    — Exit');
          break;

        case 'debug':
          session.config.debug = !session.config.debug;
          console.log(`Debug mode: ${session.config.debug ? 'ON' : 'OFF'}`);
          break;

        case 'trace': {
          const subcmd = cmdArgs[0] || 'stats';
          try {
            await handleTraceQuery({ trace: subcmd, traceArg: cmdArgs[1] }, session.config);
          } catch (e) {
            console.error(`Trace error: ${e.message}`);
          }
          break;
        }

        case 'memory': {
          console.log('Memory commands have been retired. Memory is now managed by Dream V2; use the in-app FTS recall.');
          break;
        }

        case 'history': {
          const limit = parseInt(cmdArgs[0], 10) || 10;
          const messages = conversationStore.loadRecent(limit);
          if (messages.length === 0) {
            console.log('No messages in history.');
          } else {
            console.log(`Last ${messages.length} messages:`);
            for (const m of messages) {
              const time = m.time ? new Date(m.time).toLocaleString() : '?';
              const preview = (m.content || '').slice(0, 100).replace(/\n/g, ' ');
              console.log(`  [${time}] ${m.role}: ${preview}`);
            }
          }
          break;
        }

        case 'search': {
          const keyword = cmdArgs.join(' ');
          if (!keyword) {
            console.log('Usage: /search <keyword>');
          } else {
            const results = searchMessages(session.yeaftDir, keyword, 20);
            if (results.length === 0) {
              console.log(`No messages matching "${keyword}".`);
            } else {
              console.log(`Found ${results.length} messages:`);
              for (const m of results) {
                const time = m.time ? new Date(m.time).toLocaleString() : '?';
                const preview = (m.content || '').slice(0, 100).replace(/\n/g, ' ');
                console.log(`  [${time}] ${m.role}: ${preview}`);
              }
            }
          }
          break;
        }

        case 'compact': {
          console.log('The /compact REPL command is retired. Native Yeaft keeps the transcript authoritative and uses Memory plus a deterministic provider history window.');
          break;
        }

        case 'context':
          console.log(`Context info:`);
          console.log(`  Model: ${session.config.model}`);
          console.log(`  Language: ${session.config.language}`);
          console.log(`  Max context: ${session.config.maxContextTokens} tokens`);
          console.log(`  System prompt: ${buildSystemPrompt({ language: session.config.language }).length} chars`);
          console.log(`  Hot messages: ${conversationStore.countHot()}`);
          console.log(`  Hot tokens: ${conversationStore.hotTokens()}`);
          console.log(`  Cold messages: ${conversationStore.countCold()}`);
          console.log(`  Tools: ${toolRegistry.size}`);
          console.log(`  Skills: ${skillManager.size}`);
          break;

        case 'dry-run':
          handleDryRun({ ...args, prompt: cmdArgs.join(' ') || null }, session.config);
          break;

        case 'stats': {
          const s = await trace.stats();
          console.log(`Session stats:`);
          console.log(`  Debug: ${session.config.debug}`);
          console.log(`  Turns: ${s.turnCount}`);
          console.log(`  Tools: ${s.toolCount}`);
          console.log(`  Hot messages: ${conversationStore.countHot()}`);
          console.log(`  Cold messages: ${conversationStore.countCold()}`);
          console.log(`  Registered tools: ${toolRegistry.size}`);
          console.log(`  Loaded skills: ${skillManager.size}`);
          // 2026-05-13: per-tool call counters. Rendered inline so the
          // REPL gives a one-shot snapshot — the `yeaft-stats` CLI is
          // the dedicated entry for richer rendering / --unused mode.
          if (session.toolStats && typeof session.toolStats.snapshot === 'function') {
            const snap = session.toolStats.snapshot();
            const entries = Object.entries(snap).sort((a, b) => b[1].callCount - a[1].callCount);
            if (entries.length === 0) {
              console.log(`  Tool calls: (none recorded yet)`);
            } else {
              console.log(`  Tool calls (top 10 by count):`);
              for (const [name, rec] of entries.slice(0, 10)) {
                const errPct = rec.callCount > 0 ? ((rec.errorCount / rec.callCount) * 100).toFixed(1) : '0';
                console.log(`    ${name.padEnd(28)}  ${String(rec.callCount).padStart(5)} calls  ${errPct.padStart(5)}% err  p50=${rec.p50Ms}ms p95=${rec.p95Ms}ms`);
              }
            }
          }
          break;
        }

        case 'model':
          if (cmdArgs[0]) {
            try {
              const modelRef = cmdArgs[0];
              const { providerName, modelId } = parseModelRef(modelRef);

              if (providerName) {
                // Full ref: provider/model — update primaryModel
                session.config.model = modelId;
                session.config.primaryModel = modelRef;
              } else {
                // Bare model ID
                session.config.model = modelRef;
              }

              // Re-resolve model info from registry (adapter / baseUrl /
              // thinking metadata). Token limits come from the resolver
              // ladder — models.dev snapshot first, config fallback.
              const newModelInfo = resolveModel(session.config.model);
              if (newModelInfo) {
                session.config.modelInfo = newModelInfo;
              }
              session.config.maxContextTokens = resolveContextWindow(session.config.model, session.config);
              session.config.maxOutputTokens = resolveMaxOutputTokens(session.config.model, session.config);
              const providerStr = providerName ? ` (provider: ${providerName})` : '';
              console.log(`Model switched to: ${session.config.model}${providerStr}`);
              console.log('Note: Model change takes effect on next query.');
            } catch (e) {
              console.error(`Error switching model: ${e.message}`);
            }
          } else {
            const primaryRef = session.config.primaryModel || session.config.model;
            console.log(`Current model: ${primaryRef}`);
            if (session.config.fastModel && session.config.fastModel !== session.config.primaryModel) {
              console.log(`Fast model: ${session.config.fastModel}`);
            }
          }
          break;

        case 'models': {
          const models = listModels();
          // If providers are configured, show provider-based model list
          if (session.config.providers && session.config.providers.length > 0) {
            console.log('Available models (from providers):');
            for (const provider of session.config.providers) {
              console.log(`  [${provider.name}] ${provider.baseUrl}`);
              if (Array.isArray(provider.models)) {
                for (const m of provider.models) {
                  const current = (`${provider.name}/${m}` === session.config.primaryModel) ? ' ← primary' :
                    (`${provider.name}/${m}` === session.config.fastModel) ? ' ← fast' : '';
                  const info = resolveModel(m);
                  const displayName = info ? ` (${info.displayName})` : '';
                  console.log(`    ${provider.name}/${m}${displayName}${current}`);
                }
              }
            }
          } else {
            // Legacy: show registry models
            console.log('Available models (from registry):');
            for (const m of models) {
              const current = m.name === session.config.model ? ' ← current' : '';
              console.log(`  ${m.name} (${m.displayName}) — ${m.adapter}, ${(m.contextWindow / 1000).toFixed(0)}K ctx${current}`);
            }
          }
          break;
        }

        case 'providers': {
          const providers = session.config.providers;
          if (!providers || providers.length === 0) {
            console.log('No providers configured. Using legacy adapter mode.');
            console.log('Add providers to ~/.yeaft/config.json to enable provider routing.');
          } else {
            console.log(`Configured providers (${providers.length}):`);
            for (const p of providers) {
              const protocol = p.protocol || 'openai';
              const modelCount = Array.isArray(p.models) ? p.models.length : 0;
              console.log(`  ${p.name} — ${p.baseUrl} (${protocol}, ${modelCount} models)`);
            }
          }
          break;
        }

        case 'language':
        case 'lang':
          if (cmdArgs[0]) {
            session.config.language = cmdArgs[0];
            console.log(`Language switched to: ${session.config.language}`);
          } else {
            console.log(`Current language: ${session.config.language}`);
          }
          break;

        case 'tools': {
          const names = toolRegistry.names || [];
          if (names.length === 0) {
            console.log('No tools registered.');
          } else {
            console.log(`Registered tools (${names.length}):`);
            for (const name of names) {
              console.log(`  - ${name}`);
            }
          }
          break;
        }

        case 'skills': {
          const skillList = skillManager.list() || [];
          if (skillList.length === 0) {
            console.log('No skills loaded.');
          } else {
            console.log(`Loaded skills (${skillList.length}):`);
            for (const skill of skillList) {
              const desc = skill.description ? ` — ${skill.description}` : '';
              console.log(`  - ${skill.name}${desc}`);
            }
          }
          break;
        }

        case 'clear':
          conversationStore.clear();
          conversationMessages = [];
          console.log('Conversation history cleared (including persisted messages).');
          break;

        case 'quit':
        case 'exit':
        case 'q':
          closeRequested = true;
          rl.close();
          return;

        default:
          console.log(`Unknown command: /${cmd}. Type /help for commands.`);
      }
      promptIfOpen();
      return;
    }

    // Regular input → Session fan-out or legacy single Engine.
    try {
      let responseText = '';
      if (sessionRunner) {
        const outcome = await sessionRunner.run(input, {
          modelEffort: args.modelEffort || session.config.modelEffort || null,
          onEvent: ({ vpId, event }) => {
            if (event.type === 'text_delta') {
              responseText += event.text || '';
              process.stdout.write(`\n[${vpId}] ${event.text || ''}`);
            } else if (event.type === 'tool_start') {
              process.stderr.write(`\n[${vpId}] ${event.name}...\n`);
            } else if (event.type === 'error') {
              process.stderr.write(`\n[${vpId}] Error: ${event.error?.message || event.error}\n`);
            }
          },
        });
        console.log();
        if (outcome.results.some(result => result.error)) process.exitCode = 1;
        promptIfOpen();
        return;
      }

      for await (const event of engine.query({
        prompt: input,
        messages: conversationMessages,
      })) {
        switch (event.type) {
          case 'text_delta':
            responseText += event.text;
            process.stdout.write(event.text);
            break;
          case 'tool_start':
            if (session.config.debug) {
              process.stderr.write(`\n[tool] ${event.name}(${JSON.stringify(event.input)})\n`);
            } else {
              process.stderr.write(`\n⚙ ${event.name}...\n`);
            }
            break;
          case 'tool_end':
            if (session.config.debug) {
              const status = event.isError ? 'ERROR' : 'OK';
              process.stderr.write(`[tool] ${event.name} → ${status}\n`);
            }
            break;
          case 'recall':
            if (session.config.debug) {
              process.stderr.write(`[recall] ${event.entryCount} entries${event.cached ? ' (cached)' : ''}\n`);
            }
            break;
          case 'fallback':
            process.stderr.write(`\n[fallback] ${event.from} → ${event.to}: ${event.reason}\n`);
            break;
          case 'error':
            process.stderr.write(`\nError: ${event.error.message}\n`);
            process.exitCode = 1;
            break;
          case 'turn_start':
            if (session.config.debug && event.turnNumber > 1) {
              process.stderr.write(`\n--- Turn ${event.turnNumber} ---\n`);
            }
            break;
        }
      }
      console.log(); // newline after response

      // Update in-memory conversation for multi-turn context
      // (engine.js already persists to disk via StopHooks when yeaftDir is set)
      conversationMessages.push({ role: 'user', content: input });
      if (responseText) {
        conversationMessages.push({ role: 'assistant', content: responseText });
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    }
    promptIfOpen();
  };

  rl.on('line', line => {
    if (closeRequested) return;
    const lineSequence = ++acceptedLineSequence;
    const exitsRepl = isExitLine(line);
    if (exitsRepl) {
      exitLineSequence = lineSequence;
      closeRequested = true;
    }
    lineQueue = lineQueue.then(() => handleLine(line, lineSequence)).catch(error => {
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    });
    if (exitsRepl) rl.close();
  });

  rl.on('close', () => {
    closeRequested = true;
    if (!shutdownPromise) {
      shutdownPromise = lineQueue.catch(error => {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
      }).then(async () => {
        await sessionRunner?.close();
        await session.shutdown();
        console.log('\nBye!');
      }).catch(error => {
        console.error(`Error: ${error.message}`);
        process.exitCode = 1;
      });
    }
  });
  await new Promise(resolve => rl.once('close', resolve));
  await shutdownPromise;
}

// ─── Structured stdio handler ──────────────────────────────────

function writeStreamProtocolError({ write, sessionId, error }) {
  const turnId = randomUUID();
  const normalized = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
  write({
    type: 'error',
    session_id: sessionId,
    turn_id: turnId,
    thread_id: 'main',
    threadId: 'main',
    error: { name: normalized.name || 'Error', message: normalized.message || String(normalized) },
    retryable: false,
  });
  const result = {
    type: 'result',
    subtype: 'error',
    session_id: sessionId,
    turn_id: turnId,
    thread_id: 'main',
    threadId: 'main',
    stop_reason: 'error',
    is_error: true,
    result: '',
    error: normalized.message || String(normalized),
  };
  write(result);
  return result;
}

async function runStreamJson(config, args) {
  const sessionId = args.sessionId || `session_cli_${randomUUID()}`;
  const validation = validateSessionId(sessionId);
  if (!validation.ok) {
    throw new Error(`Invalid --session-id (${validation.reason})`);
  }
  const workDir = resolve(args.workDir || process.cwd());
  const persisted = args.sessionId ? loadSessionConfig(config.dir, sessionId) : {};
  const effectiveConfig = resolveSessionConfig(config, persisted);
  if (args.model) {
    effectiveConfig.model = args.model;
    effectiveConfig.primaryModel = args.model;
  }
  if (args.modelEffort) effectiveConfig.modelEffort = args.modelEffort;

  const write = createJsonlWriter(process.stdout);
  const input = args.inputFormat === 'stream-json' ? new JsonlInput(process.stdin) : null;
  const originalConsole = { log: console.log, info: console.info, debug: console.debug };
  const writeDiagnostic = (...values) => console.error(...values);
  console.log = writeDiagnostic;
  console.info = writeDiagnostic;
  console.debug = writeDiagnostic;

  const loaded = await loadSession({
    dir: config.dir,
    workDir,
    model: effectiveConfig.model,
    language: args.language || effectiveConfig.language,
    debug: args.debug || effectiveConfig.debug,
    skipMCP: args.skipMCP,
    skipSkills: args.skipSkills,
    configOverrides: {
      ...effectiveConfig,
      ...(effectiveConfig.modelEffort ? { modelEffort: effectiveConfig.modelEffort } : {}),
    },
    managedCliReady: args.managedCliReady,
  });
  const { engine, conversationStore, skillManager, toolRegistry } = loaded;
  const todoState = { value: [] };
  const asyncTaskOwners = new Map();
  const rescuedTaskIds = new Set();
  const pendingTaskRescues = new Set();
  const taskLifecycleWaiters = new Set();
  let sessionRunner = null;
  let taskEventIntakeOpen = true;
  let hadError = false;
  let singleEngineTail = Promise.resolve();
  let streamSessionBootstrapOpen = false;

  const loadStreamHistory = () => conversationStore.loadRecentBySession(sessionId, 20).map(message => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId && { toolCallId: message.toolCallId }),
    ...(message.toolCalls && { toolCalls: message.toolCalls }),
    ...(message.providerState && { providerState: message.providerState }),
    ...(Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0
      ? { thinkingBlocks: message.thinkingBlocks.map(block => ({ ...block })) }
      : {}),
  }));

  // An ad-hoc stream-json conversation has exactly one Engine and no VP roster.
  // Serialize both root turns and late task-result rescues on that same stable
  // process owner so a completion cannot race another query or invent a VP id.
  const runSingleEngineTurn = (turnOptions) => {
    const turn = singleEngineTail.catch(() => {}).then(() => runStreamTurn({
      engine,
      ...turnOptions,
    }));
    singleEngineTail = turn;
    return turn;
  };

  const wakeTaskLifecycleWaiters = () => {
    if (taskLifecycleWaiters.size === 0) return;
    const waiters = Array.from(taskLifecycleWaiters);
    taskLifecycleWaiters.clear();
    for (const resolveWaiter of waiters) resolveWaiter();
  };

  const rescueTaskResult = async (context) => {
    const taskId = context?.task?.id;
    if (!taskId || !context?.content || rescuedTaskIds.has(taskId)) return false;
    if (sessionRunner && !context.vpId) return false;
    rescuedTaskIds.add(taskId);
    try {
      const common = {
        prompt: context.content,
        sessionId,
        workDir,
        model: loaded.config.model,
        modelEffort: loaded.config.modelEffort || null,
        input,
        write,
        taskId,
      };
      const result = sessionRunner
        ? await runStreamSessionTurn({
            runner: sessionRunner,
            ...common,
            internal: true,
            meta: {
              injectedBy: 'task_result',
              routeTargetVpId: context.vpId,
              threadId: context.threadId || 'main',
            },
            routingIntent: { targetVpIds: [context.vpId], explicit: true },
          })
        : await runSingleEngineTurn({
            ...common,
            messages: loadStreamHistory(),
            threadId: context.threadId || 'main',
            userAlreadyPersisted: true,
          });
      hadError ||= result?.is_error === true;
      return true;
    } catch (error) {
      hadError = true;
      writeStreamProtocolError({ write, sessionId, error });
      return false;
    }
  };

  const queueTaskRescue = (context) => {
    if (!taskEventIntakeOpen) return null;
    let rescue;
    rescue = rescueTaskResult(context).finally(() => {
      pendingTaskRescues.delete(rescue);
      wakeTaskLifecycleWaiters();
    });
    pendingTaskRescues.add(rescue);
    wakeTaskLifecycleWaiters();
    return rescue;
  };

  const configureStreamEngine = (targetEngine, vpId = null) => {
    if (!targetEngine) return;
    if (typeof targetEngine.setAsyncTaskCoordinator === 'function') {
      const removeOwner = (taskId, ownerEngine) => {
        const owner = asyncTaskOwners.get(taskId);
        if (!owner || owner.engine !== ownerEngine) return null;
        asyncTaskOwners.delete(taskId);
        return owner;
      };
      targetEngine.setAsyncTaskCoordinator({
        onRegister(taskId, ownerEngine) {
          if (!taskId) return;
          asyncTaskOwners.set(taskId, {
            engine: ownerEngine,
            sessionId,
            vpId: vpId || null,
            threadId: ownerEngine.currentThreadId || 'main',
          });
        },
        onUnregister: removeOwner,
        onConsumed: removeOwner,
        onDeferred(taskId, ownerEngine) {
          const owner = removeOwner(taskId, ownerEngine);
          const task = loaded.taskManager?.getTask?.(sessionId, taskId);
          if (!owner || !task || !['succeeded', 'failed', 'cancelled', 'orphaned'].includes(task.status)) return;
          const context = taskResultReentryContext({ event: 'completed', task }, { sessionId, owner });
          if (context) queueTaskRescue(context);
        },
        onUndelivered(taskId, delivery, ownerEngine) {
          const owner = removeOwner(taskId, ownerEngine);
          if (!owner || rescuedTaskIds.has(taskId)) return;
          queueTaskRescue({
            task: { id: taskId, kind: delivery?.taskKind, status: delivery?.taskStatus },
            sessionId: delivery?.sessionId || owner.sessionId,
            vpId: delivery?.vpId || owner.vpId,
            threadId: delivery?.threadId || owner.threadId,
            content: delivery?.content,
          });
        },
      });
    }
    if (typeof targetEngine.setSubAgentEventSink === 'function') {
      targetEngine.setSubAgentEventSink((agentId, event) => {
        const frame = buildStreamSubAgentFrame({ event, agentId, sessionId, vpId, threadId: targetEngine.currentThreadId });
        if (frame) write(frame);
      });
    }
  };

  configureStreamEngine(engine, null);
  sessionRunner = createCliSessionRunner({ loaded, sessionId, workDir, configureEngine: configureStreamEngine });
  if (sessionRunner) {
    snapshotSessions(loaded.yeaftDir);
    const meta = sessionRunner.meta;
    if (meta) addOrUpdateManifestSession(
      loaded.yeaftDir,
      meta,
      join(sessionsRoot(loaded.yeaftDir), sessionId),
    );
  }
  streamSessionBootstrapOpen = !sessionRunner;

  write({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: loaded.config.model,
    model_effort: loaded.config.modelEffort || null,
    cwd: workDir,
    tools: toolRegistry.names,
    skills: skillManager.list(),
    input_format: args.inputFormat,
    output_format: 'stream-json',
  });

  if (loaded.taskManager && typeof loaded.taskManager.setEventSink === 'function') {
    loaded.taskManager.setEventSink((event) => {
      if (!taskEventIntakeOpen) return;
      const hadExactOwner = asyncTaskOwners.has(event?.task?.id);
      const delivery = emitStreamTaskEvent({ event, asyncTaskOwners, write, sessionId });
      if (delivery.projected && !delivery.delivered && !hadExactOwner && event?.event === 'completed') {
        const context = taskResultReentryContext(event, { sessionId });
        if (context) queueTaskRescue(context);
      }
      wakeTaskLifecycleWaiters();
    });
  }

  const activeModelReentryTasks = () => {
    if (!loaded.taskManager || typeof loaded.taskManager.listActiveTasks !== 'function') return [];
    return loaded.taskManager.listActiveTasks(sessionId).filter(task => (
      taskResultDeliveryFor(task) === TASK_RESULT_DELIVERY.MODEL_REENTRY
    ));
  };

  const drainTaskLifecycle = async () => {
    if (!loaded.taskManager || typeof loaded.taskManager.setEventSink !== 'function') {
      taskEventIntakeOpen = false;
      return;
    }
    // EOF is a lifecycle fence, not permission to abandon model-reentry work.
    // Keep the Session runner and task event sink alive until every owned
    // result-producing task is terminal and every resulting rescue turn has
    // settled. `status_only` tasks remain detached and never hold CLI exit.
    for (;;) {
      if (activeModelReentryTasks().length === 0 && pendingTaskRescues.size === 0) {
        // JavaScript runs this check + close synchronously. No TaskManager
        // completion can interleave between observing the empty sets and
        // detaching the sink, so no late rescue can target a closed runner.
        taskEventIntakeOpen = false;
        loaded.taskManager.setEventSink(null);
        wakeTaskLifecycleWaiters();
        return;
      }
      await new Promise(resolveWaiter => taskLifecycleWaiters.add(resolveWaiter));
    }
  };

  const runPrompt = async (prompt, message = null) => {
    if (streamSessionBootstrapOpen) {
      streamSessionBootstrapOpen = false;
      const bootstrap = normalizeStreamSessionBootstrap(message);
      if (bootstrap) {
        let workspaceKey = '';
        try { workspaceKey = realpathSync(resolve(workDir)); } catch { /* leave empty */ }
        withSessionManifestLock(loaded.yeaftDir, () => {
          sessionRunner = createCliSessionRunner({
            loaded,
            sessionId,
            workDir,
            configureEngine: configureStreamEngine,
          });
          if (sessionRunner) return;
          const handle = createSession(sessionsRoot(loaded.yeaftDir), {
            id: sessionId,
            name: sessionId,
            roster: bootstrap.roster,
            defaultVpId: bootstrap.defaultVpId,
            workDir,
            workspaceKey,
          });
          handle.close();
        });
        if (!sessionRunner) {
          sessionRunner = createCliSessionRunner({
            loaded,
            sessionId,
            workDir,
            configureEngine: configureStreamEngine,
          });
        }
        if (!sessionRunner) throw new Error(`Failed to initialize formal stream-json Session ${sessionId}`);
        const meta = sessionRunner.meta;
        if (meta) addOrUpdateManifestSession(
          loaded.yeaftDir,
          meta,
          join(sessionsRoot(loaded.yeaftDir), sessionId),
        );
      }
    }
    const routingIntent = normalizeStreamRoutingIntent(message);
    if (routingIntent && !sessionRunner) {
      throw new Error('stream-json VP selectors require an existing formal Session with a persisted roster');
    }
    const turnOptions = {
      prompt,
      messages: loadStreamHistory(),
      sessionId,
      workDir,
      model: loaded.config.model,
      modelEffort: loaded.config.modelEffort || null,
      input,
      write,
      getCurrentTodos: () => todoState.value.slice(),
      setCurrentTodos: todos => { todoState.value = Array.isArray(todos) ? todos.slice() : []; },
    };
    return sessionRunner
      ? runStreamSessionTurn({ runner: sessionRunner, routingIntent, ...turnOptions })
      : runSingleEngineTurn(turnOptions);
  };

  const recordResult = (result) => {
    hadError ||= result?.is_error === true;
    return result;
  };
  try {
    if (args.prompt) {
      try {
        recordResult(await runPrompt(args.prompt));
      } catch (error) {
        recordResult(writeStreamProtocolError({ write, sessionId, error }));
      }
    } else if (input) {
      for (;;) {
        const item = await input.nextPrompt();
        if (!item) break;
        try {
          recordResult(await runPrompt(item.prompt, item.message));
        } catch (error) {
          recordResult(writeStreamProtocolError({ write, sessionId, error }));
        }
      }
    } else {
      let prompt = '';
      for await (const chunk of process.stdin) prompt += chunk;
      if (prompt.trim()) {
        try {
          recordResult(await runPrompt(prompt.trim()));
        } catch (error) {
          recordResult(writeStreamProtocolError({ write, sessionId, error }));
        }
      }
    }
  } finally {
    input?.close();
    await drainTaskLifecycle();
    await sessionRunner?.close();
    await loaded.shutdown();
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
  }
  if (hadError) process.exitCode = 1;
}

// ─── One-shot handler ──────────────────────────────────────────

async function runOnce(config, args) {
  if (args.dryRun) {
    handleDryRun(args, config);
    return;
  }

  const workDir = resolve(args.workDir || process.cwd());
  const persisted = args.sessionId ? loadSessionConfig(config.dir, args.sessionId) : {};
  const effectiveConfig = resolveSessionConfig(config, persisted);
  const session = await loadSession({
    dir: config.dir,
    workDir,
    model: args.model || effectiveConfig.model,
    language: args.language || effectiveConfig.language,
    debug: args.debug || effectiveConfig.debug,
    skipMCP: args.skipMCP,
    skipSkills: args.skipSkills,
    configOverrides: effectiveConfig,
    managedCliReady: args.managedCliReady,
  });

  const { engine, conversationStore } = session;
  const sessionRunner = args.sessionId
    ? createCliSessionRunner({ loaded: session, sessionId: args.sessionId, workDir })
    : null;

  try {
    if (args.sessionId && !sessionRunner) {
      throw new Error(`Session not found: ${args.sessionId}`);
    }
    if (sessionRunner) {
      const outcome = await sessionRunner.run(args.prompt, {
        modelEffort: args.modelEffort || session.config.modelEffort || null,
        onEvent: ({ vpId, event }) => {
          if (event.type === 'text_delta') process.stdout.write(`\n[${vpId}] ${event.text || ''}`);
          else if (event.type === 'tool_start') process.stderr.write(`\n[${vpId}] ${event.name}...\n`);
          else if (event.type === 'error') process.stderr.write(`\n[${vpId}] Error: ${event.error?.message || event.error}\n`);
        },
      });
      console.log();
      if (outcome.results.some(result => result.error)) process.exitCode = 1;
      return;
    }
    // Load recent conversation as context
    const priorMessages = conversationStore.loadRecent(20).map(m => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId && { toolCallId: m.toolCallId }),
      ...(m.toolCalls && { toolCalls: m.toolCalls }),
      ...(m.providerState && { providerState: m.providerState }),
      ...(Array.isArray(m.thinkingBlocks) && m.thinkingBlocks.length > 0
        ? { thinkingBlocks: m.thinkingBlocks.map(block => ({ ...block })) }
        : {}),
    }));

    let terminalEngineError = null;
    for await (const event of engine.query({
      prompt: args.prompt,
      messages: priorMessages,
    })) {
      switch (event.type) {
        case 'text_delta':
          process.stdout.write(event.text);
          break;
        case 'tool_start':
          if (args.verbose || args.debug) {
            process.stderr.write(`\n[tool] ${event.name}(${JSON.stringify(event.input)})\n`);
          } else {
            process.stderr.write(`\n⚙ ${event.name}...\n`);
          }
          break;
        case 'tool_end':
          if (args.verbose || args.debug) {
            const status = event.isError ? 'ERROR' : 'OK';
            process.stderr.write(`[tool] ${event.name} → ${status}\n`);
          }
          break;
        case 'recall':
          if (args.verbose || args.debug) {
            process.stderr.write(`[recall] ${event.entryCount} entries${event.cached ? ' (cached)' : ''}\n`);
          }
          break;
        case 'fallback':
          process.stderr.write(`\n[fallback] ${event.from} → ${event.to}: ${event.reason}\n`);
          break;
        case 'error':
          process.stderr.write(`\nError: ${event.error.message}\n`);
          if (!terminalEngineError) {
            terminalEngineError = event.error instanceof Error
              ? event.error
              : new Error(String(event.error?.message || event.error || 'Engine query failed'));
          }
          break;
        case 'turn_start':
          if (args.verbose && event.turnNumber > 1) {
            process.stderr.write(`\n--- Turn ${event.turnNumber} ---\n`);
          }
          break;
      }
    }
    // Final newline after streaming text
    console.log();
    if (terminalEngineError) process.exitCode = 1;
  } finally {
    await sessionRunner?.close();
    await session.shutdown();
  }
}

// ─── Main ──────────────────────────────────────────────────────

function installManagedCliSignalCleanup() {
  if (process.platform === 'win32') return () => {};
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = new Map();
  const dispose = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    handlers.clear();
  };
  for (const signal of signals) {
    const handler = () => {
      cleanupManagedCliRuntimePaths();
      dispose();
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return dispose;
}

async function main() {
  const args = parseArgs(process.argv);

  // Prime the models.dev community catalog so resolveContextWindow /
  // resolveMaxOutputTokens — called synchronously from loadConfig and the
  // engine hot path — can return real per-model limits instead of falling
  // through to DEFAULT. Failure is non-fatal: stale disk cache or DEFAULT
  // keeps the CLI usable offline. Mirrors the prime in agent/index.js.
  try {
    const { fetchModelsDev } = await import('./llm/models-dev.js');
    const dir = args.dir || process.env.YEAFT_DIR || null;
    await fetchModelsDev({ yeaftDir: dir });
  } catch {
    // best-effort; resolver falls back to config / DEFAULT.
  }

  // Load config with CLI overrides (for --trace queries and dry-run, no session needed)
  const config = loadConfig({
    model: args.model,
    language: args.language,
    debug: args.debug || undefined,
  });
  // Handle --trace queries (no LLM needed, no session needed)
  if (args.trace) {
    await handleTraceQuery(args, config);
    return;
  }

  // Handle one-shot maintenance ops (no LLM needed, no session needed)
  if (args.compactOrphans || args.compactOrphansDry) {
    handleCompactOrphans(config, { dryRun: args.compactOrphansDry });
    return;
  }
  if (args.deleteSession) {
    await handleDeleteGroup(config, args.deleteSession);
    return;
  }

  const prepareManagedCli = async () => {
    args.managedCliReady = ensureManagedCliTools({ yeaftDir: config.dir });
    args.managedCliReady.then(results => {
      if (results.some(result => result.status === 'installed')) {
        console.error(`[Yeaft] managed CLI tools: ${summarizeManagedCliResults(results)}`);
      }
    }).catch(error => {
      console.error(`[Yeaft] managed CLI setup failed; using built-in fallbacks: ${error?.message || error}`);
    });
    try {
      await prepareManagedCliToolEnvironment(args.managedCliReady, 'rg', {
        yeaftDir: config.dir,
      });
    } catch (error) {
      console.error(`[Yeaft] managed rg environment setup failed; using built-in fallback: ${error?.message || error}`);
    }
  };

  // Handle interactive mode
  if (args.interactive) {
    await prepareManagedCli();
    await runREPL(config, args);
    return;
  }

  if (args.outputFormat === 'stream-json') {
    if (args.inputFormat !== 'text' && args.inputFormat !== 'stream-json') {
      throw new Error('--input-format must be text or stream-json');
    }
    if (!args.prompt && args.inputFormat !== 'stream-json' && process.stdin.isTTY) {
      throw new Error('stream-json output requires a prompt, piped stdin, or --input-format stream-json');
    }
    await prepareManagedCli();
    await runStreamJson(config, args);
    return;
  }
  if (args.inputFormat === 'stream-json') {
    throw new Error('--input-format stream-json requires --output-format stream-json');
  }

  // Handle prompt (from args or stdin)
  if (args.prompt) {
    await prepareManagedCli();
    await runOnce(config, args);
    return;
  }

  // Read from stdin if piped
  if (!process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    args.prompt = input.trim();
    if (args.prompt) {
      await prepareManagedCli();
      await runOnce(config, args);
      return;
    }
  }

  // No input and not interactive — show help
  console.log('Yeaft Yeaft CLI');
  console.log();
  console.log('Usage:');
  console.log('  node cli.js "your prompt"            — One-shot query');
  console.log('  node cli.js -i                       — Interactive REPL');
  console.log('  node cli.js --dry-run "prompt"        — Show what would be sent');
  console.log('  node cli.js --trace stats             — Debug trace statistics');
  console.log('  node cli.js --trace recent            — Recent turns');
  console.log('  node cli.js --trace search "keyword"  — Search traces');
  console.log('  node cli.js --compact-orphans         — Delete orphan messages (no live group)');
  console.log('  node cli.js --compact-orphans-dry     — Preview orphan sweep, no delete');
  console.log('  node cli.js --delete-group <id>       — Hard delete group + cascade messages');
  console.log();
  console.log('Options:');
  console.log('  -d, --debug           Enable debug tracing');
  console.log('  -i, --interactive     Start REPL');
  console.log('  -v, --verbose         Verbose output');
  console.log('  -p, --print           Run a non-interactive query');
  console.log('  --session-id <id>     Persist and resume a Yeaft Session');
  console.log('  --cwd <dir>           Set the working directory');
  console.log('  --model <name>         Override model');
  console.log('  --effort <level>       Override model effort');
  console.log('  --input-format <fmt>   text or stream-json');
  console.log('  --output-format <fmt>  text or stream-json');
  console.log('  --language <code>      Language: en, zh (default: en)');
  console.log('  --trace <cmd>         Query debug trace');
  console.log('  --dry-run             Show prompt without calling LLM');
  console.log('  --skip-mcp            Skip MCP server connections');
  console.log('  --skip-skills         Skip skill loading');
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const disposeSignalCleanup = installManagedCliSignalCleanup();
  const cleanupManagedCli = () => {
    disposeSignalCleanup();
    cleanupManagedCliRuntimePaths();
  };
  main().catch(err => {
    console.error(err);
    cleanupManagedCli();
    process.exit(1);
  }).finally(cleanupManagedCli);
}
