#!/usr/bin/env node
/**
 * cli.js — Yeaft Unify CLI entry point
 *
 * Uses loadSession() to wire all subsystems (Engine, ToolRegistry, SkillManager,
 * MCPManager, Dream, StopHooks, Memory) into a single session.
 *
 * Features:
 *   --dry-run "prompt"   — Assemble system prompt + messages, don't call LLM
 *   --trace stats|recent|search <keyword>  — Query debug.db
 *   -i / --interactive   — REPL mode with / commands
 *   <prompt>             — One-shot query (Phase 1: engine.query)
 *   --skip-mcp           — Skip MCP server connections (faster startup)
 *   --skip-skills        — Skip skill loading
 *
 * REPL commands:
 *   /memory              — Show memory status or manage entries
 *   /history [n]         — Show last N messages from conversation
 *   /search <keyword>    — Search conversation history
 *   /compact             — Trigger manual consolidation
 *   /tools               — List registered tools
 *   /skills              — List loaded skills
 *   Conversation persistence across REPL sessions
 */

import { createInterface } from 'readline';
import { join } from 'path';
import { loadConfig } from './config.js';
import { DebugTrace } from './debug-trace.js';
import { loadSession } from './session.js';
import { listModels, resolveModel, parseModelRef } from './models.js';
import { buildSystemPrompt } from './prompts.js';
import { searchMessages } from './conversation/search.js';
import { consolidate } from './memory/consolidate.js';

// ─── Argument parsing ──────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: 'chat',
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
    prompt: null,
  };

  const rest = argv.slice(2);
  let i = 0;

  while (i < rest.length) {
    const arg = rest[i];
    switch (arg) {
      case '-m':
      case '--mode':
        args.mode = rest[++i] || 'chat';
        break;
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

function handleTraceQuery(args, config) {
  const dbPath = join(config.dir, 'debug.db');
  let trace;
  try {
    trace = new DebugTrace(dbPath);
  } catch (e) {
    throw new Error(`Cannot open debug database at ${dbPath}: ${e.message}`);
  }

  try {
    switch (args.trace) {
      case 'stats': {
        const s = trace.stats();
        console.log('Debug Trace Statistics:');
        console.log(`  Turns:    ${s.turnCount}`);
        console.log(`  Tools:    ${s.toolCount}`);
        console.log(`  Events:   ${s.eventCount}`);
        console.log(`  DB Size:  ${(s.dbSizeBytes / 1024).toFixed(1)} KB`);
        break;
      }
      case 'recent': {
        const turns = trace.queryRecent(20);
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
        const results = trace.search(args.traceArg);
        console.log(`Found ${results.length} turns matching "${args.traceArg}":`);
        for (const t of results) {
          const time = new Date(t.started_at).toLocaleString();
          const preview = (t.response_text || '').slice(0, 80);
          console.log(`  [${time}] ${preview}...`);
        }
        break;
      }
      case 'tools': {
        const tools = trace.queryTools({ name: args.traceArg });
        console.log(`Found ${tools.length} tool calls${args.traceArg ? ` for "${args.traceArg}"` : ''}:`);
        for (const t of tools.slice(0, 20)) {
          const time = new Date(t.created_at).toLocaleString();
          const status = t.is_error ? 'ERROR' : 'OK';
          console.log(`  [${time}] ${t.tool_name} | ${t.duration_ms || '?'}ms | ${status}`);
        }
        break;
      }
      default:
        throw new Error(`Unknown trace command: ${args.trace}. Available: stats, recent, search <keyword>, tools [name]`);
    }
  } finally {
    trace.close();
  }
}

// ─── Dry-run handler ───────────────────────────────────────────

function handleDryRun(args, config) {
  const systemPrompt = buildSystemPrompt({ language: config.language, mode: args.mode });
  const messages = [];

  if (args.prompt) {
    messages.push({ role: 'user', content: args.prompt });
  }

  console.log('=== DRY RUN ===');
  console.log();
  console.log('--- Config ---');
  console.log(`  Model:    ${config.model}`);
  console.log(`  Adapter:  ${config.adapter || 'auto'}`);
  console.log(`  Mode:     ${args.mode}`);
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

// ─── REPL ──────────────────────────────────────────────────────

async function runREPL(config, args) {
  // Use loadSession() to wire all subsystems
  const session = await loadSession({
    model: args.model || config.model,
    language: args.language || config.language,
    debug: args.debug || config.debug,
    skipMCP: args.skipMCP,
    skipSkills: args.skipSkills,
  });

  const { engine, conversationStore, memoryStore, trace, skillManager, mcpManager, toolRegistry } = session;
  let currentMode = args.mode;

  // Load persisted conversation as initial messages
  let conversationMessages = conversationStore.loadRecent(50).map(m => ({
    role: m.role,
    content: m.content,
    ...(m.toolCallId && { toolCallId: m.toolCallId }),
    ...(m.toolCalls && { toolCalls: m.toolCalls }),
  }));

  const hotCount = conversationStore.countHot();
  const coldCount = conversationStore.countCold();
  const memStats = memoryStore.stats();

  console.log(`Yeaft Unify REPL (model: ${session.config.model}, mode: ${currentMode})`);
  console.log(`Conversation: ${hotCount} hot, ${coldCount} cold | Memory: ${memStats.entryCount} entries`);
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
    prompt: `yeaft:${currentMode}> `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Handle / commands
    if (input.startsWith('/')) {
      const [cmd, ...cmdArgs] = input.slice(1).split(/\s+/);
      switch (cmd) {
        case 'help':
          console.log('Commands:');
          console.log('  /mode <chat|work|dream>  — Switch mode');
          console.log('  /debug                   — Toggle debug mode');
          console.log('  /trace <stats|recent>    — Query debug trace');
          console.log('  /memory [add|clear|stats] — Memory management');
          console.log('  /history [n]             — Show last N messages');
          console.log('  /search <keyword>        — Search conversation history');
          console.log('  /compact                 — Trigger consolidation');
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

        case 'mode':
          if (cmdArgs[0]) {
            currentMode = cmdArgs[0];
            rl.setPrompt(`yeaft:${currentMode}> `);
            console.log(`Mode switched to: ${currentMode}`);
          } else {
            console.log(`Current mode: ${currentMode}`);
          }
          break;

        case 'debug':
          session.config.debug = !session.config.debug;
          console.log(`Debug mode: ${session.config.debug ? 'ON' : 'OFF'}`);
          break;

        case 'trace': {
          const subcmd = cmdArgs[0] || 'stats';
          try {
            handleTraceQuery({ trace: subcmd, traceArg: cmdArgs[1] }, session.config);
          } catch (e) {
            console.error(`Trace error: ${e.message}`);
          }
          break;
        }

        case 'memory': {
          const subcmd = cmdArgs[0];
          if (subcmd === 'add') {
            // /memory add <section> <entry text>
            const section = cmdArgs[1];
            const entryText = cmdArgs.slice(2).join(' ');
            if (!section || !entryText) {
              console.log('Usage: /memory add <section> <entry text>');
            } else {
              memoryStore.addToSection(section, `- ${entryText}`);
              console.log(`Added to MEMORY.md [${section}]: ${entryText}`);
            }
          } else if (subcmd === 'clear') {
            memoryStore.clear();
            console.log('All memory cleared.');
          } else if (subcmd === 'stats') {
            const s = memoryStore.stats();
            console.log('Memory stats:');
            console.log(`  Entries: ${s.entryCount}`);
            console.log(`  Scopes: ${s.scopes.join(', ') || '(none)'}`);
            console.log(`  Kinds:  ${Object.entries(s.kinds).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
          } else if (subcmd === 'search') {
            const keyword = cmdArgs.slice(1).join(' ');
            if (!keyword) {
              console.log('Usage: /memory search <keyword>');
            } else {
              const results = memoryStore.search(keyword);
              if (results.length === 0) {
                console.log(`No memory entries matching "${keyword}".`);
              } else {
                console.log(`Found ${results.length} entries:`);
                for (const e of results) {
                  console.log(`  [${e.kind}] ${e.name} (scope: ${e.scope})`);
                  console.log(`    ${(e.content || '').slice(0, 100)}`);
                }
              }
            }
          } else {
            // Default: show MEMORY.md content
            const profile = memoryStore.readProfile();
            const s = memoryStore.stats();
            if (profile) {
              console.log('--- MEMORY.md ---');
              console.log(profile.slice(0, 1000));
              if (profile.length > 1000) console.log('... (truncated)');
            } else {
              console.log('MEMORY.md is empty.');
            }
            console.log(`\nEntries: ${s.entryCount} | Scopes: ${s.scopes.length}`);
          }
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
          try {
            const budget = session.config.messageTokenBudget || 8192;
            const hotTokens = conversationStore.hotTokens();
            console.log(`Hot tokens: ${hotTokens} / budget: ${budget}`);

            if (hotTokens <= 0) {
              console.log('No messages to compact.');
              break;
            }

            console.log('Running consolidation...');
            const result = await consolidate({
              conversationStore,
              memoryStore,
              adapter: session.adapter,
              config: session.config,
              budget: Math.min(budget, hotTokens), // force trigger
            });
            console.log(`Consolidation complete:`);
            console.log(`  Archived: ${result.archivedCount} messages`);
            console.log(`  Extracted: ${result.extractedEntries.length} memory entries`);
            if (result.compactSummary) {
              console.log(`  Summary: ${result.compactSummary.slice(0, 200)}...`);
            }
          } catch (e) {
            console.error(`Consolidation error: ${e.message}`);
          }
          break;
        }

        case 'context':
          console.log(`Context info:`);
          console.log(`  Model: ${session.config.model}`);
          console.log(`  Mode: ${currentMode}`);
          console.log(`  Language: ${session.config.language}`);
          console.log(`  Max context: ${session.config.maxContextTokens} tokens`);
          console.log(`  System prompt: ${buildSystemPrompt({ language: session.config.language, mode: currentMode }).length} chars`);
          console.log(`  Hot messages: ${conversationStore.countHot()}`);
          console.log(`  Hot tokens: ${conversationStore.hotTokens()}`);
          console.log(`  Cold messages: ${conversationStore.countCold()}`);
          console.log(`  Memory entries: ${memoryStore.stats().entryCount}`);
          console.log(`  Tools: ${toolRegistry.size}`);
          console.log(`  Skills: ${skillManager.size}`);
          break;

        case 'dry-run':
          handleDryRun({ ...args, mode: currentMode, prompt: cmdArgs.join(' ') || null }, session.config);
          break;

        case 'stats': {
          const s = trace.stats();
          console.log(`Session stats:`);
          console.log(`  Mode: ${currentMode}`);
          console.log(`  Debug: ${session.config.debug}`);
          console.log(`  Turns: ${s.turnCount}`);
          console.log(`  Tools: ${s.toolCount}`);
          console.log(`  Hot messages: ${conversationStore.countHot()}`);
          console.log(`  Cold messages: ${conversationStore.countCold()}`);
          console.log(`  Memory entries: ${memoryStore.stats().entryCount}`);
          console.log(`  Registered tools: ${toolRegistry.size}`);
          console.log(`  Loaded skills: ${skillManager.size}`);
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

              // Re-resolve model info from registry
              const newModelInfo = resolveModel(session.config.model);
              if (newModelInfo) {
                session.config.maxContextTokens = newModelInfo.contextWindow;
                session.config.maxOutputTokens = newModelInfo.maxOutputTokens;
                session.config.modelInfo = newModelInfo;
              }
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
          rl.close(); // close handler does shutdown + process.exit()
          return; // don't call rl.prompt() below

        default:
          console.log(`Unknown command: /${cmd}. Type /help for commands.`);
      }
      rl.prompt();
      return;
    }

    // Regular input → engine.query
    try {
      let responseText = '';

      for await (const event of engine.query({
        prompt: input,
        mode: currentMode,
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
          case 'consolidate':
            if (session.config.debug) {
              process.stderr.write(`[consolidate] archived=${event.archivedCount}, extracted=${event.extractedCount}\n`);
            } else {
              process.stderr.write(`[compact] Memory consolidated\n`);
            }
            break;
          case 'dream_triggered':
            if (session.config.debug) {
              process.stderr.write(`[dream] Dream cycle triggered (background)\n`);
            }
            break;
          case 'fallback':
            process.stderr.write(`\n[fallback] ${event.from} → ${event.to}: ${event.reason}\n`);
            break;
          case 'error':
            process.stderr.write(`\nError: ${event.error.message}\n`);
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
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await session.shutdown();
    console.log('\nBye!');
    process.exit(0);
  });
}

// ─── One-shot handler ──────────────────────────────────────────

async function runOnce(config, args) {
  if (args.dryRun) {
    handleDryRun(args, config);
    return;
  }

  // Use loadSession() to wire all subsystems
  const session = await loadSession({
    model: args.model || config.model,
    language: args.language || config.language,
    debug: args.debug || config.debug,
    skipMCP: args.skipMCP,
    skipSkills: args.skipSkills,
  });

  const { engine, conversationStore } = session;

  try {
    // Load recent conversation as context
    const priorMessages = conversationStore.loadRecent(20).map(m => ({
      role: m.role,
      content: m.content,
      ...(m.toolCallId && { toolCallId: m.toolCallId }),
      ...(m.toolCalls && { toolCalls: m.toolCalls }),
    }));

    for await (const event of engine.query({
      prompt: args.prompt,
      mode: args.mode,
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
        case 'consolidate':
          if (args.verbose || args.debug) {
            process.stderr.write(`[consolidate] archived=${event.archivedCount}, extracted=${event.extractedCount}\n`);
          }
          break;
        case 'dream_triggered':
          if (args.verbose || args.debug) {
            process.stderr.write(`[dream] Dream cycle triggered (background)\n`);
          }
          break;
        case 'fallback':
          process.stderr.write(`\n[fallback] ${event.from} → ${event.to}: ${event.reason}\n`);
          break;
        case 'error':
          process.stderr.write(`\nError: ${event.error.message}\n`);
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
  } finally {
    await session.shutdown();
  }
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // Load config with CLI overrides (for --trace queries and dry-run, no session needed)
  const config = loadConfig({
    model: args.model,
    language: args.language,
    debug: args.debug || undefined,
  });

  // Handle --trace queries (no LLM needed, no session needed)
  if (args.trace) {
    handleTraceQuery(args, config);
    return;
  }

  // Handle interactive mode
  if (args.interactive) {
    await runREPL(config, args);
    return;
  }

  // Handle prompt (from args or stdin)
  if (args.prompt) {
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
      await runOnce(config, args);
      return;
    }
  }

  // No input and not interactive — show help
  console.log('Yeaft Unify CLI');
  console.log();
  console.log('Usage:');
  console.log('  node cli.js "your prompt"            — One-shot query');
  console.log('  node cli.js -i                       — Interactive REPL');
  console.log('  node cli.js --dry-run "prompt"        — Show what would be sent');
  console.log('  node cli.js --trace stats             — Debug trace statistics');
  console.log('  node cli.js --trace recent            — Recent turns');
  console.log('  node cli.js --trace search "keyword"  — Search traces');
  console.log();
  console.log('Options:');
  console.log('  -m, --mode <mode>     Mode: chat, work, dream (default: chat)');
  console.log('  -d, --debug           Enable debug tracing');
  console.log('  -i, --interactive     Start REPL');
  console.log('  -v, --verbose         Verbose output');
  console.log('  --model <name>        Override model');
  console.log('  --language <code>     Language: en, zh (default: en)');
  console.log('  --trace <cmd>         Query debug trace');
  console.log('  --dry-run             Show prompt without calling LLM');
  console.log('  --skip-mcp            Skip MCP server connections');
  console.log('  --skip-skills         Skip skill loading');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
