#!/usr/bin/env node
/**
 * scripts/dump-prompt.js — Dump Unify's assembled system prompt for review.
 *
 * Purpose (task-332 F2):
 *   Let a human eyeball the final prompt that Unify sends to the LLM.
 *   Historically the runtime quietly assembled 7 sections from templates,
 *   and nobody could see the result unless they logged it inside the
 *   engine. This script provides a side-channel: invoke buildSystemPrompt
 *   the same way the engine does, print the output, and compare against
 *   the budget in `docs/unify-prompt-token-budget.md`.
 *
 * Red line:
 *   - Read-only. Does not touch ~/.yeaft, does not call any LLM.
 *   - Uses the real `buildSystemPrompt` from agent/unify/prompts.js —
 *     no mock, no copy, no divergence.
 *
 * Usage:
 *   node scripts/dump-prompt.js                          # defaults: mode=unified, language=en
 *   node scripts/dump-prompt.js --mode dream             # dream mode
 *   node scripts/dump-prompt.js --language zh            # zh templates
 *   node scripts/dump-prompt.js --include-memory         # inject sample memory block
 *   node scripts/dump-prompt.js --include-compact        # inject sample compact summary
 *   node scripts/dump-prompt.js --include-skill          # inject sample skill content
 *   node scripts/dump-prompt.js --json                   # machine-readable output
 *   node scripts/dump-prompt.js --budget-check           # exit non-zero if ceilings breached
 *   node scripts/dump-prompt.js --no-prompt              # stats only (no full prompt)
 *
 * The --model flag is accepted for symmetry with PM's task description
 * but currently informational only — prompt shape is model-agnostic at
 * this layer (adapters add model-specific framing later in the pipeline).
 */

import { buildSystemPrompt } from '../agent/unify/prompts.js';

// ─── Ceilings (from docs/unify-prompt-token-budget.md §2) ─────────

const CEILINGS_TOKENS = {
  identity: 1500,
  date: 30,
  mode: 1200,
  toolList: 600,
  toolGuidance: 1000,
  skills: 1500,
  memory: 2000,
  compact: 1500,
  total: 8000,
};

// ─── CLI parsing (hand-rolled — zero deps) ────────────────────────

function parseArgs(argv) {
  const args = {
    mode: 'unified',
    language: 'en',
    model: null,
    includeMemory: false,
    includeCompact: false,
    includeSkill: false,
    json: false,
    budgetCheck: false,
    noPrompt: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        args.help = true; break;
      case '--mode':
        args.mode = argv[++i]; break;
      case '--language':
      case '--lang':
        args.language = argv[++i]; break;
      case '--model':
        args.model = argv[++i]; break;
      case '--include-memory':
        args.includeMemory = true; break;
      case '--include-compact':
        args.includeCompact = true; break;
      case '--include-skill':
        args.includeSkill = true; break;
      case '--json':
        args.json = true; break;
      case '--budget-check':
        args.budgetCheck = true; break;
      case '--no-prompt':
        args.noPrompt = true; break;
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printHelp() {
  console.log(`dump-prompt — print the assembled Unify system prompt

Usage:
  node scripts/dump-prompt.js [flags]

Flags:
  --mode <unified|dream>        Which mode template to include. Default: unified.
  --language <en|zh>            Language section to extract. Default: en.
  --model <name>                Informational; reserved for adapter-layer variations.
  --include-memory              Inject a representative memory block.
  --include-compact             Inject a representative compact summary.
  --include-skill               Inject a representative skill snippet.
  --no-prompt                   Suppress the full prompt body (stats only).
  --json                        Machine-readable output.
  --budget-check                Exit non-zero if any section breaches ceiling.
  -h, --help                    Show this help.

Budget ceilings come from docs/unify-prompt-token-budget.md.
Token counts use the 4-chars-per-token heuristic; exact counts differ by tokenizer.
`);
}

// ─── Fixture blobs (kept small; intentionally representative) ─────

const SAMPLE_MEMORY_INJECTION = `## Memory Index

Available memory files under ~/.yeaft/memory/:
- user-preferences.md — merged user preferences
- by-project/claude-web-chat.md — current project summary
- by-topic/unify-prompts.md — notes on prompt assembly

## User Preferences (excerpt)

- Prefers concise answers, terse CLI, no emojis unless asked.
- Language default: auto-detect (en for English input, zh for Chinese).
- Development workflow: worktree → test → commit → push → tag.

## Project Header (claude-web-chat)

Web-based AI chat with three modes: Chat (Claude CLI), Crew (multi-agent),
Unify (own engine). Tag format v0.1.X. Main branch protected.
`;

const SAMPLE_COMPACT_SUMMARY = `Earlier in this conversation the user asked to audit Unify's prompt
assembly, recover the task-270 spec, write a budget doc, and add a dump
script. The worktree is feat-unify-prompt-f2. No runtime code changes.`;

const SAMPLE_SKILL_CONTENT = `## Skills

### writing-plans
When creating an implementation plan, structure it as Goal / Steps /
Acceptance / Risks. Keep each step atomic and testable.

### tdd
Write the failing test first. Run it. Watch it fail. Write the minimum
code to pass. Refactor. Re-run.`;

// ─── Token accounting (approximate; see budget doc §1) ────────────

/** Approximate token count using the 4-chars-per-token heuristic. */
function approxTokens(s) {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/** Section-level breakdown: re-run buildSystemPrompt with subsets and diff.
 *
 * Note: buildSystemPrompt always emits an identity+date+mode core; there is
 * no "no-mode" variant. We bundle those into a single "core" row and show
 * mode-only delta by diffing the requested mode against the alternate.
 *
 * `compactSummary` is no longer part of the system prompt (DESIGN-PROMPT
 * §4.3 — it now belongs in the messages array head). The param is retained
 * here as a diagnostic input but does not affect system-prompt size; the
 * `compact` row is now reported as 0 chars / 0 tokens.
 */
function measureSections({ mode, language, memoryInjection, compactSummary, skillContent, toolNames }) {
  void compactSummary; // accepted for back-compat with callers; no longer routed into system prompt
  const core = buildSystemPrompt({ language, mode });
  const withTools = buildSystemPrompt({ language, mode, toolNames });
  const withSkill = buildSystemPrompt({ language, mode, toolNames, skillContent });
  const withMemory = buildSystemPrompt({ language, mode, toolNames, skillContent, memoryInjection });
  const full = withMemory; // compactSummary is no longer a system-prompt section

  const altMode = mode === 'dream' ? 'unified' : 'dream';
  const coreAlt = buildSystemPrompt({ language, mode: altMode });
  const modeDeltaVsAlt = core.length - coreAlt.length;

  const toolsDelta = withTools.length - core.length;
  const skillDelta = withSkill.length - withTools.length;
  const memoryDelta = withMemory.length - withSkill.length;
  const compactDelta = 0;

  return {
    core: { chars: core.length, tokens: approxTokens(core), note: 'identity + date + mode template' },
    modeVsAlt: { chars: modeDeltaVsAlt, tokens: approxTokens('x'.repeat(Math.max(0, Math.abs(modeDeltaVsAlt)))), altMode },
    toolsBlock: { chars: toolsDelta, tokens: approxTokens('x'.repeat(Math.max(0, toolsDelta))) },
    skills: { chars: skillDelta, tokens: approxTokens('x'.repeat(Math.max(0, skillDelta))) },
    memory: { chars: memoryDelta, tokens: approxTokens('x'.repeat(Math.max(0, memoryDelta))) },
    compact: { chars: compactDelta, tokens: 0, note: 'moved to messages head — DESIGN-PROMPT §4.3' },
    totalChars: full.length,
    totalTokens: approxTokens(full),
    fullPrompt: full,
  };
}

// ─── Main ─────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  // Representative tool names — approximately the set a loaded Unify
  // session sees after createFullRegistry(). We hardcode the count +
  // names so the dump is reproducible without touching the live
  // registry (keeps the script side-effect-free).
  const toolNames = [
    'AskUser', 'MemoryRead', 'MemoryWrite', 'memory_search', 'memory_query',
    'WebSearch', 'WebFetch', 'HistorySearch', 'Bash', 'FileRead', 'FileWrite',
    'FileEdit', 'Glob', 'Grep', 'ListDir', 'apply_patch', 'Agent',
    'SendMessage', 'WaitAgent', 'CloseAgent', 'ListAgents', 'TaskCreate',
    'TaskUpdate', 'TaskList', 'TaskGet', 'TaskProgress', 'TaskMemory',
    'FollowupTask', 'UpdatePlan', 'SpawnThread', 'SwitchThread',
    'ListThreads', 'AttachThreadToTask', 'SpawnTask', 'ReadThreadSummary',
    'ReadThreadRecent', 'jsRepl', 'jsReplReset', 'NotebookEdit',
    'ImageGeneration', 'ViewImage', 'ToolSearch', 'RequestPermissions',
    'WriteStdin', 'EnterWorktree', 'ExitWorktree', 'Skill',
    'mcp_list_tools', 'mcp_call_tool',
  ];

  const measureInput = {
    mode: args.mode,
    language: args.language,
    toolNames,
    memoryInjection: args.includeMemory ? SAMPLE_MEMORY_INJECTION : undefined,
    compactSummary: args.includeCompact ? SAMPLE_COMPACT_SUMMARY : undefined,
    skillContent: args.includeSkill ? SAMPLE_SKILL_CONTENT : undefined,
  };

  const stats = measureSections(measureInput);

  // Budget check
  const coreCeiling = CEILINGS_TOKENS.identity + CEILINGS_TOKENS.date + CEILINGS_TOKENS.mode;
  const toolsCeiling = CEILINGS_TOKENS.toolList + CEILINGS_TOKENS.toolGuidance;
  const breaches = [];
  if (stats.core.tokens > coreCeiling) {
    breaches.push({ section: 'core (identity+date+mode)', tokens: stats.core.tokens, ceiling: coreCeiling });
  }
  if (stats.toolsBlock.tokens > toolsCeiling) {
    breaches.push({ section: 'tools(list+guidance)', tokens: stats.toolsBlock.tokens, ceiling: toolsCeiling });
  }
  if (stats.skills.tokens > CEILINGS_TOKENS.skills) {
    breaches.push({ section: 'skills', tokens: stats.skills.tokens, ceiling: CEILINGS_TOKENS.skills });
  }
  if (stats.memory.tokens > CEILINGS_TOKENS.memory) {
    breaches.push({ section: 'memory', tokens: stats.memory.tokens, ceiling: CEILINGS_TOKENS.memory });
  }
  if (stats.compact.tokens > CEILINGS_TOKENS.compact) {
    breaches.push({ section: 'compact', tokens: stats.compact.tokens, ceiling: CEILINGS_TOKENS.compact });
  }
  if (stats.totalTokens > CEILINGS_TOKENS.total) {
    breaches.push({ section: 'TOTAL', tokens: stats.totalTokens, ceiling: CEILINGS_TOKENS.total });
  }

  if (args.json) {
    const out = {
      args: {
        mode: args.mode,
        language: args.language,
        model: args.model,
        includeMemory: args.includeMemory,
        includeCompact: args.includeCompact,
        includeSkill: args.includeSkill,
      },
      sections: {
        core: stats.core,
        modeVsAlt: stats.modeVsAlt,
        toolsBlock: stats.toolsBlock,
        skills: stats.skills,
        memory: stats.memory,
        compact: stats.compact,
      },
      total: { chars: stats.totalChars, tokens: stats.totalTokens },
      ceilings: CEILINGS_TOKENS,
      breaches,
      prompt: args.noPrompt ? null : stats.fullPrompt,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    const hr = '─'.repeat(72);
    process.stdout.write(`${hr}\n`);
    process.stdout.write(`Unify System Prompt Dump\n`);
    process.stdout.write(`  mode=${args.mode}  language=${args.language}  model=${args.model || '(n/a)'}\n`);
    process.stdout.write(`  include: memory=${args.includeMemory} compact=${args.includeCompact} skill=${args.includeSkill}\n`);
    process.stdout.write(`${hr}\n\n`);

    if (!args.noPrompt) {
      process.stdout.write(stats.fullPrompt);
      process.stdout.write(`\n\n${hr}\n`);
    }

    process.stdout.write(`Per-section approximate tokens (4 chars/token heuristic):\n`);
    const row = (label, sec, ceiling) => {
      const bar = sec.tokens > ceiling ? '❌' : sec.tokens > ceiling * 0.85 ? '⚠️ ' : '✓ ';
      return `  ${bar} ${label.padEnd(22)} ${String(sec.tokens).padStart(5)} tok / ${ceiling} ceiling\n`;
    };
    process.stdout.write(row('core (id+date+mode)', stats.core, coreCeiling));
    process.stdout.write(`    └ mode delta vs ${stats.modeVsAlt.altMode}: ${stats.modeVsAlt.chars >= 0 ? '+' : ''}${stats.modeVsAlt.chars} chars (${stats.modeVsAlt.tokens} tok)\n`);
    process.stdout.write(row('tools (list+guidance)', stats.toolsBlock, toolsCeiling));
    process.stdout.write(row('skills', stats.skills, CEILINGS_TOKENS.skills));
    process.stdout.write(row('memory', stats.memory, CEILINGS_TOKENS.memory));
    process.stdout.write(row('compact summary', stats.compact, CEILINGS_TOKENS.compact));
    process.stdout.write(`\n  TOTAL                  ${String(stats.totalTokens).padStart(5)} tok / ${CEILINGS_TOKENS.total} ceiling  (${Math.round(stats.totalTokens / CEILINGS_TOKENS.total * 100)}% used)\n`);

    if (breaches.length > 0) {
      process.stdout.write(`\nBUDGET BREACHES:\n`);
      for (const b of breaches) {
        process.stdout.write(`  ❌ ${b.section}: ${b.tokens} > ${b.ceiling}\n`);
      }
    } else {
      process.stdout.write(`\n✓ All sections within budget.\n`);
    }
    process.stdout.write(`${hr}\n`);
  }

  if (args.budgetCheck && breaches.length > 0) {
    process.exit(1);
  }
}

main();
