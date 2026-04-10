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

// ─── Argument parsing ──────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: 'chat',
    debug: false,
    interactive: false,
    verbose: false,
    model: null,
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
    console.error(`Cannot open debug database at ${dbPath}: ${e.message}`);
    process.exit(1);
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
          console.error('Usage: --trace search <keyword>');
          process.exit(1);
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
        console.error(`Unknown trace command: ${args.trace}`);
        console.error('Available: stats, recent, search <keyword>, tools [name]');
        process.exit(1);
    }
  } finally {
    trace.close();
  }
}

// ─── Dry-run handler ───────────────────────────────────────────

function handleDryRun(args, config) {
  const systemPrompt = buildSystemPrompt(config, args.mode);
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

// ─── System prompt builder (Phase 0: basic) ────────────────────

function buildSystemPrompt(config, mode) {
  const parts = [
    `You are Yeaft, a helpful AI assistant.`,
    `Current mode: ${mode}`,
    `Date: ${new Date().toISOString().split('T')[0]}`,
  ];

  if (mode === 'work') {
    parts.push(
      'You are in work mode. Break tasks into steps, execute them, and report progress.',
    );
  } else if (mode === 'dream') {
    parts.push(
      'You are in dream mode. Reflect on past conversations and consolidate memories.',
    );
  }

  return parts.join('\n\n');
}

// ─── REPL ──────────────────────────────────────────────────────

async function runREPL(config, args) {
  const trace = createTrace({
    enabled: config.debug,
    dbPath: join(config.dir, 'debug.db'),
  });

  let currentMode = args.mode;

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
          handleTraceQuery({ trace: subcmd, traceArg: cmdArgs[1] }, config);
          break;
        }

        case 'memory':
          console.log('Memory status: (not yet implemented — Phase 2)');
          break;

        case 'context':
          console.log(`Context info:`);
          console.log(`  Model: ${config.model}`);
          console.log(`  Mode: ${currentMode}`);
          console.log(`  Max context: ${config.maxContextTokens} tokens`);
          console.log(`  System prompt: ${buildSystemPrompt(config, currentMode).length} chars`);
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
            config.model = cmdArgs[0];
            console.log(`Model switched to: ${config.model}`);
          } else {
            console.log(`Current model: ${config.model}`);
          }
          break;

        case 'quit':
        case 'exit':
        case 'q':
          trace.close();
          rl.close();
          process.exit(0);
          break;

        default:
          console.log(`Unknown command: /${cmd}. Type /help for commands.`);
      }
      rl.prompt();
      return;
    }

    // Regular input → engine.query (Phase 1 stub)
    console.log(`[engine not yet implemented — Phase 1]`);
    console.log(`Would send to ${config.model}: "${input}"`);
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

    // Phase 1 stub
    console.log(`[engine not yet implemented — Phase 1]`);
    console.log(`Would send to ${config.model}: "${args.prompt}"`);
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
  console.log('  --trace <cmd>       Query debug trace');
  console.log('  --dry-run           Show prompt without calling LLM');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
