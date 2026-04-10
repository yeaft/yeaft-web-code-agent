#!/usr/bin/env node
/**
 * cli.js — Yeaft Unify CLI entry point
 *
 * Features:
 *   --dry-run "prompt"   — Assemble system prompt + messages, don't call LLM
 *   --trace stats|recent|search <keyword>  — Query debug.db
 *   -i / --interactive   — REPL mode with / commands
 *   <prompt>             — One-shot query (Phase 1: engine.query)
 */

import { createInterface } from 'readline';
import { join } from 'path';
import { initYeaftDir } from './init.js';
import { loadConfig } from './config.js';
import { DebugTrace, NullTrace, createTrace } from './debug-trace.js';
import { createLLMAdapter } from './llm/adapter.js';
import { Engine } from './engine.js';
import { listModels, resolveModel } from './models.js';
import { buildSystemPrompt } from './prompts.js';

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
  const trace = createTrace({
    enabled: config.debug,
    dbPath: join(config.dir, 'debug.db'),
  });

  let adapter;
  let engine;
  let currentMode = args.mode;
  let conversationMessages = []; // persistent conversation for REPL

  // Lazy adapter creation (don't fail on start if no API key for --trace-only usage)
  async function ensureEngine() {
    if (!engine) {
      adapter = await createLLMAdapter(config);
      engine = new Engine({ adapter, trace, config });
    }
    return engine;
  }

  console.log(`Yeaft Unify REPL (model: ${config.model}, mode: ${currentMode})`);
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
          console.log('  /memory                  — Show memory status');
          console.log('  /context                 — Show context info');
          console.log('  /dry-run                 — Toggle dry-run mode');
          console.log('  /stats                   — Show session stats');
          console.log('  /model <name>            — Switch model');
          console.log('  /models                  — List available models');
          console.log('  /language <en|zh>        — Switch language');
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
          config.debug = !config.debug;
          console.log(`Debug mode: ${config.debug ? 'ON' : 'OFF'}`);
          break;

        case 'trace': {
          const subcmd = cmdArgs[0] || 'stats';
          try {
            handleTraceQuery({ trace: subcmd, traceArg: cmdArgs[1] }, config);
          } catch (e) {
            console.error(`Trace error: ${e.message}`);
          }
          break;
        }

        case 'memory':
          console.log('Memory status: (not yet implemented — Phase 2)');
          break;

        case 'context':
          console.log(`Context info:`);
          console.log(`  Model: ${config.model}`);
          console.log(`  Mode: ${currentMode}`);
          console.log(`  Language: ${config.language}`);
          console.log(`  Max context: ${config.maxContextTokens} tokens`);
          console.log(`  System prompt: ${buildSystemPrompt({ language: config.language, mode: currentMode }).length} chars`);
          break;

        case 'dry-run':
          handleDryRun({ ...args, mode: currentMode, prompt: cmdArgs.join(' ') || null }, config);
          break;

        case 'stats': {
          const s = trace.stats();
          console.log(`Session stats:`);
          console.log(`  Mode: ${currentMode}`);
          console.log(`  Debug: ${config.debug}`);
          console.log(`  Turns: ${s.turnCount}`);
          console.log(`  Tools: ${s.toolCount}`);
          break;
        }

        case 'model':
          if (cmdArgs[0]) {
            try {
              config.model = cmdArgs[0];
              // Re-resolve adapter and baseUrl from model registry
              const newModelInfo = resolveModel(config.model);
              if (newModelInfo) {
                config.adapter = newModelInfo.adapter === 'anthropic' ? 'anthropic' : 'openai';
                config.baseUrl = newModelInfo.baseUrl;
                config.maxContextTokens = newModelInfo.contextWindow;
                config.maxOutputTokens = newModelInfo.maxOutputTokens;
                config.modelInfo = newModelInfo;
              }
              engine = null; // Force re-creation with new model + adapter
              console.log(`Model switched to: ${config.model} (adapter: ${config.adapter})`);
            } catch (e) {
              console.error(`Error switching model: ${e.message}`);
            }
          } else {
            console.log(`Current model: ${config.model} (adapter: ${config.adapter})`);
          }
          break;

        case 'models': {
          const models = listModels();
          console.log('Available models:');
          for (const m of models) {
            const current = m.name === config.model ? ' ← current' : '';
            console.log(`  ${m.name} (${m.displayName}) — ${m.adapter}, ${(m.contextWindow / 1000).toFixed(0)}K ctx${current}`);
          }
          break;
        }

        case 'language':
        case 'lang':
          if (cmdArgs[0]) {
            config.language = cmdArgs[0];
            console.log(`Language switched to: ${config.language}`);
          } else {
            console.log(`Current language: ${config.language}`);
          }
          break;

        case 'clear':
          conversationMessages = [];
          console.log('Conversation history cleared.');
          break;

        case 'quit':
        case 'exit':
        case 'q':
          rl.close(); // close handler does trace.close() + process.exit()
          return; // don't call rl.prompt() below

        default:
          console.log(`Unknown command: /${cmd}. Type /help for commands.`);
      }
      rl.prompt();
      return;
    }

    // Regular input → engine.query
    try {
      const eng = await ensureEngine();
      let responseText = '';

      for await (const event of eng.query({
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
            if (config.debug) {
              process.stderr.write(`\n[tool] ${event.name}(${JSON.stringify(event.input)})\n`);
            }
            break;
          case 'tool_end':
            if (config.debug) {
              const status = event.isError ? 'ERROR' : 'OK';
              process.stderr.write(`[tool] ${event.name} → ${status}\n`);
            }
            break;
          case 'error':
            process.stderr.write(`\nError: ${event.error.message}\n`);
            break;
          case 'turn_start':
            if (config.debug && event.turnNumber > 1) {
              process.stderr.write(`\n--- Turn ${event.turnNumber} ---\n`);
            }
            break;
        }
      }
      console.log(); // newline after response

      // Save both user and assistant messages for multi-turn context
      conversationMessages.push({ role: 'user', content: input });
      if (responseText) {
        conversationMessages.push({ role: 'assistant', content: responseText });
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    trace.close();
    console.log('\nBye!');
    process.exit(0);
  });
}

// ─── One-shot handler ──────────────────────────────────────────

async function runOnce(config, args) {
  const trace = createTrace({
    enabled: config.debug,
    dbPath: join(config.dir, 'debug.db'),
  });

  try {
    if (args.dryRun) {
      handleDryRun(args, config);
      return;
    }

    const adapter = await createLLMAdapter(config);
    const engine = new Engine({ adapter, trace, config });

    for await (const event of engine.query({ prompt: args.prompt, mode: args.mode })) {
      switch (event.type) {
        case 'text_delta':
          process.stdout.write(event.text);
          break;
        case 'tool_start':
          if (args.verbose) {
            process.stderr.write(`\n[tool] ${event.name}(${JSON.stringify(event.input)})\n`);
          }
          break;
        case 'tool_end':
          if (args.verbose) {
            const status = event.isError ? 'ERROR' : 'OK';
            process.stderr.write(`[tool] ${event.name} → ${status}\n`);
          }
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
    trace.close();
  }
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);

  // Load config with CLI overrides
  const config = loadConfig({
    model: args.model,
    language: args.language,
    debug: args.debug || undefined,
  });

  // Initialize directory structure
  initYeaftDir(config.dir);

  // Handle --trace queries (no LLM needed)
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
  console.log('  node cli.js "your prompt"          — One-shot query');
  console.log('  node cli.js -i                     — Interactive REPL');
  console.log('  node cli.js --dry-run "prompt"      — Show what would be sent');
  console.log('  node cli.js --trace stats           — Debug trace statistics');
  console.log('  node cli.js --trace recent           — Recent turns');
  console.log('  node cli.js --trace search "keyword" — Search traces');
  console.log();
  console.log('Options:');
  console.log('  -m, --mode <mode>   Mode: chat, work, dream (default: chat)');
  console.log('  -d, --debug         Enable debug tracing');
  console.log('  -i, --interactive   Start REPL');
  console.log('  -v, --verbose       Verbose output');
  console.log('  --model <name>      Override model');
  console.log('  --language <code>   Language: en, zh (default: en)');
  console.log('  --trace <cmd>       Query debug trace');
  console.log('  --dry-run           Show prompt without calling LLM');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
