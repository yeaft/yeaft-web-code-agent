#!/usr/bin/env node
/**
 * scripts/dump-prompt.js — Dump Yeaft's assembled system prompt for review.
 *
 * Purpose (task-332 F2):
 *   Let a human eyeball the final prompt that Yeaft sends to the LLM.
 *   Historically the runtime quietly assembled 7 sections from templates,
 *   and nobody could see the result unless they logged it inside the
 *   engine. This script provides a side-channel: invoke buildSystemPrompt
 *   the same way the engine does, print the output, and compare against
 *   the budget in `docs/yeaft-prompt-token-budget.md`.
 *
 * Red line:
 *   - Read-only. Does not touch ~/.yeaft, does not call any LLM.
 *   - Uses the real `buildSystemPrompt` from agent/yeaft/prompts.js —
 *     no mock, no copy, no divergence. Conversation history is outside the
 *     system-prompt dump and is bounded separately by history-window.js.
 *
 * Usage:
 *   node scripts/dump-prompt.js                          # defaults: mode=unified, language=en
 *   node scripts/dump-prompt.js --mode dream             # dream mode
 *   node scripts/dump-prompt.js --language zh            # zh templates
 *   node scripts/dump-prompt.js --include-memory         # inject sample memory block
 *   node scripts/dump-prompt.js --include-skill          # inject sample skill content
 *   node scripts/dump-prompt.js --json                   # machine-readable output
 *   node scripts/dump-prompt.js --budget-check           # exit non-zero if ceilings breached
 *   node scripts/dump-prompt.js --no-prompt              # stats only (no full prompt)
 *
 * The --model flag is accepted for symmetry with PM's task description
 * but currently informational only — prompt shape is model-agnostic at
 * this layer (adapters add model-specific framing later in the pipeline).
 */

import { buildSystemPrompt } from '../agent/yeaft/prompts.js';

// ─── Ceilings (from docs/yeaft-prompt-token-budget.md §2) ─────────

const CEILINGS_TOKENS = {
  identity: 1500,
  date: 30,
  mode: 1200,
  skills: 1500,
  memory: 2000,
  total: 8000,
};

// ─── CLI parsing (hand-rolled — zero deps) ────────────────────────

function parseArgs(argv) {
  const args = {
    mode: 'unified',
    language: 'en',
    model: null,
    includeMemory: false,
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
  console.log(`dump-prompt — print the assembled Yeaft system prompt

Usage:
  node scripts/dump-prompt.js [flags]

Flags:
  --mode <unified|dream>        Which mode template to include. Default: unified.
  --language <en|zh>            Language section to extract. Default: en.
  --model <name>                Informational; reserved for adapter-layer variations.
  --include-memory              Inject a representative memory block.
  --include-skill               Inject a representative skill snippet.
  --no-prompt                   Suppress the full prompt body (stats only).
  --json                        Machine-readable output.
  --budget-check                Exit non-zero if any section breaches ceiling.
  -h, --help                    Show this help.

Budget ceilings come from docs/yeaft-prompt-token-budget.md.
Token counts use the 4-chars-per-token heuristic; exact counts differ by tokenizer.
`);
}

// ─── Fixture blobs (kept small; intentionally representative) ─────

const SAMPLE_MEMORY_INJECTION = `## Memory Index

Available memory files under ~/.yeaft/memory/:
- user-preferences.md — merged user preferences
- by-project/claude-web-chat.md — current project summary
- by-topic/yeaft-prompts.md — notes on prompt assembly

## User Preferences (excerpt)

- Prefers concise answers, terse CLI, no emojis unless asked.
- Language default: auto-detect (en for English input, zh for Chinese).
- Development workflow: worktree → test → commit → push → tag.

## Project Header (claude-web-chat)

Web-based AI chat with Chat (Claude CLI) and
Yeaft (own engine). Tag format v1.0.X. Main branch protected.
`;

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
 */
function measureSections({ mode, language, memoryInjection, skillContent }) {
  const core = buildSystemPrompt({ language, mode });
  const withSkill = buildSystemPrompt({ language, mode, skillContent });
  const withMemory = buildSystemPrompt({ language, mode, skillContent, memoryInjection });
  const full = withMemory;

  const altMode = mode === 'dream' ? 'unified' : 'dream';
  const coreAlt = buildSystemPrompt({ language, mode: altMode });
  const modeDeltaVsAlt = core.length - coreAlt.length;

  const skillDelta = withSkill.length - core.length;
  const memoryDelta = withMemory.length - withSkill.length;
  return {
    core: { chars: core.length, tokens: approxTokens(core), note: 'identity + date + mode template' },
    modeVsAlt: { chars: modeDeltaVsAlt, tokens: approxTokens('x'.repeat(Math.max(0, Math.abs(modeDeltaVsAlt)))), altMode },
    skills: { chars: skillDelta, tokens: approxTokens('x'.repeat(Math.max(0, skillDelta))) },
    memory: { chars: memoryDelta, tokens: approxTokens('x'.repeat(Math.max(0, memoryDelta))) },
    totalChars: full.length,
    totalTokens: approxTokens(full),
    fullPrompt: full,
  };
}

// ─── Main ─────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  const measureInput = {
    mode: args.mode,
    language: args.language,
    memoryInjection: args.includeMemory ? SAMPLE_MEMORY_INJECTION : undefined,
    skillContent: args.includeSkill ? SAMPLE_SKILL_CONTENT : undefined,
  };

  const stats = measureSections(measureInput);

  // Budget check
  const coreCeiling = CEILINGS_TOKENS.identity + CEILINGS_TOKENS.date + CEILINGS_TOKENS.mode;
  const breaches = [];
  if (stats.core.tokens > coreCeiling) {
    breaches.push({ section: 'core (identity+date+mode)', tokens: stats.core.tokens, ceiling: coreCeiling });
  }
  if (stats.skills.tokens > CEILINGS_TOKENS.skills) {
    breaches.push({ section: 'skills', tokens: stats.skills.tokens, ceiling: CEILINGS_TOKENS.skills });
  }
  if (stats.memory.tokens > CEILINGS_TOKENS.memory) {
    breaches.push({ section: 'memory', tokens: stats.memory.tokens, ceiling: CEILINGS_TOKENS.memory });
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
        includeSkill: args.includeSkill,
      },
      sections: {
        core: stats.core,
        modeVsAlt: stats.modeVsAlt,
        skills: stats.skills,
        memory: stats.memory,
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
    process.stdout.write(`Yeaft System Prompt Dump\n`);
    process.stdout.write(`  mode=${args.mode}  language=${args.language}  model=${args.model || '(n/a)'}\n`);
    process.stdout.write(`  include: memory=${args.includeMemory} skill=${args.includeSkill}\n`);
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
    process.stdout.write(row('skills', stats.skills, CEILINGS_TOKENS.skills));
    process.stdout.write(row('memory', stats.memory, CEILINGS_TOKENS.memory));
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
