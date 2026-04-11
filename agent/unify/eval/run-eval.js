#!/usr/bin/env node

/**
 * eval/run-eval.js — CLI runner for Yeaft evals
 *
 * Usage:
 *   # Run all evals against default model (requires API key)
 *   node agent/unify/eval/run-eval.js
 *
 *   # Run specific suite
 *   node agent/unify/eval/run-eval.js --suite tools
 *
 *   # Compare multiple models
 *   node agent/unify/eval/run-eval.js --models claude-sonnet-4-20250514,gpt-5
 *
 *   # Save baseline
 *   node agent/unify/eval/run-eval.js --save-baseline initial
 *
 *   # Compare against baseline
 *   node agent/unify/eval/run-eval.js --compare-baseline baselines/initial.json
 *
 *   # Dry run (MockAdapter, no API calls)
 *   node agent/unify/eval/run-eval.js --dry-run
 *
 * Environment:
 *   YEAFT_API_KEY          — Anthropic API key
 *   YEAFT_OPENAI_API_KEY   — OpenAI API key
 */

import { parseArgs } from 'util';
import { join } from 'path';
import { homedir } from 'os';

import { toolUseCases } from './cases/tool-use.js';
import { memoryCases } from './cases/memory.js';
import { skillsCases } from './cases/skills.js';
import { e2eCases } from './cases/e2e.js';
import {
  runEvals,
  printResults,
  printComparison,
  saveBaseline,
  loadBaseline,
  compareToBaseline,
} from './runner.js';

// ─── Parse CLI args ──────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    suite: { type: 'string', short: 's', default: 'all' },
    models: { type: 'string', short: 'm', default: '' },
    'save-baseline': { type: 'string', default: '' },
    'compare-baseline': { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`
Yeaft Eval Runner

Usage:
  node agent/unify/eval/run-eval.js [options]

Options:
  -s, --suite <name>         Run specific suite: tools, memory, skills, e2e, all (default: all)
  -m, --models <list>        Comma-separated model IDs (default: auto-detect from API keys)
  --save-baseline <name>     Save results as named baseline
  --compare-baseline <path>  Compare results against a baseline file
  --dry-run                  Run with MockAdapter (no API calls, for testing the harness)
  -h, --help                 Show this help

Environment:
  YEAFT_API_KEY              Anthropic API key (enables Claude models)
  YEAFT_OPENAI_API_KEY       OpenAI API key (enables GPT models)

Examples:
  # Quick dry run to verify harness works
  node agent/unify/eval/run-eval.js --dry-run

  # Run tool evals against Claude Sonnet
  node agent/unify/eval/run-eval.js --suite tools --models claude-sonnet-4-20250514

  # Full eval, save baseline
  node agent/unify/eval/run-eval.js --save-baseline v0.1.411

  # Check for regressions
  node agent/unify/eval/run-eval.js --compare-baseline baselines/v0.1.411.json
`);
  process.exit(0);
}

// ─── Collect cases ───────────────────────────────────────────

const allCases = {
  tools: toolUseCases,
  memory: memoryCases,
  skills: skillsCases,
  e2e: e2eCases,
};

let cases;
if (args.suite === 'all') {
  cases = [...toolUseCases, ...memoryCases, ...skillsCases, ...e2eCases];
} else if (allCases[args.suite]) {
  cases = allCases[args.suite];
} else {
  console.error(`Unknown suite: ${args.suite}. Available: tools, memory, skills, e2e, all`);
  process.exit(1);
}

console.log(`\nYeaft Eval Runner`);
console.log(`Suite: ${args.suite} (${cases.length} cases)`);

// ─── Build adapters ──────────────────────────────────────────

const adapters = [];

if (args['dry-run']) {
  // MockAdapter that gives simple responses
  console.log('Mode: DRY RUN (MockAdapter)\n');

  class DryRunAdapter {
    async *stream(params) {
      // Check if tools are available
      const hasTools = params.tools && params.tools.length > 0;

      // Simple heuristic: if prompt mentions search/find → call search tool
      const prompt = params.messages[params.messages.length - 1]?.content || '';
      const lp = prompt.toLowerCase();

      if (hasTools && (lp.includes('search') || lp.includes('population') || lp.includes('find'))) {
        const searchTool = params.tools.find(t => t.name === 'search');
        if (searchTool) {
          yield { type: 'text_delta', text: 'Let me search for that. ' };
          yield { type: 'tool_call', id: 'mock-tc-1', name: 'search', input: { query: prompt } };
          yield { type: 'usage', inputTokens: 100, outputTokens: 20 };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
      }

      if (hasTools && (lp.includes('calculate') || lp.includes('math') || /\d+\s*[\+\-\*\/]\s*\d+/.test(lp))) {
        const calcTool = params.tools.find(t => t.name === 'calculator');
        if (calcTool) {
          const expr = prompt.match(/[\d\s\+\-\*\/\(\)]+/)?.[0]?.trim() || '0';
          yield { type: 'text_delta', text: 'Let me calculate. ' };
          yield { type: 'tool_call', id: 'mock-tc-1', name: 'calculator', input: { expression: expr } };
          yield { type: 'usage', inputTokens: 100, outputTokens: 20 };
          yield { type: 'stop', stopReason: 'tool_use' };
          return;
        }
      }

      // Default: just respond with text
      yield { type: 'text_delta', text: `I understand you asked: "${prompt.slice(0, 50)}". ` };
      yield { type: 'text_delta', text: 'Here is my response.' };
      yield { type: 'usage', inputTokens: 100, outputTokens: 15 };
      yield { type: 'stop', stopReason: 'end_turn' };
    }
    async call() {
      return { text: '{}', usage: { inputTokens: 10, outputTokens: 5 } };
    }
  }

  adapters.push({ name: 'dry-run-mock', adapter: new DryRunAdapter() });

} else {
  // Real adapters
  const { createLLMAdapter } = await import('../llm/adapter.js');
  const modelList = args.models
    ? args.models.split(',').map(m => m.trim())
    : [];

  // Auto-detect from API keys if no models specified
  if (modelList.length === 0) {
    if (process.env.YEAFT_API_KEY) modelList.push('claude-sonnet-4-20250514');
    if (process.env.YEAFT_OPENAI_API_KEY) modelList.push('gpt-5');
  }

  if (modelList.length === 0) {
    console.error('\nNo models available. Set YEAFT_API_KEY or YEAFT_OPENAI_API_KEY, or use --dry-run.');
    process.exit(1);
  }

  console.log(`Models: ${modelList.join(', ')}\n`);

  for (const model of modelList) {
    try {
      const config = {
        model,
        apiKey: process.env.YEAFT_API_KEY,
        openaiApiKey: process.env.YEAFT_OPENAI_API_KEY,
      };
      const adapter = await createLLMAdapter(config);
      adapters.push({ name: model, adapter, config });
    } catch (err) {
      console.error(`Failed to create adapter for ${model}: ${err.message}`);
    }
  }
}

if (adapters.length === 0) {
  console.error('No adapters available. Exiting.');
  process.exit(1);
}

// ─── Run evals ───────────────────────────────────────────────

console.log(`Running ${cases.length} eval cases across ${adapters.length} adapter(s)...\n`);

const scores = await runEvals({ cases, adapters });

// ─── Display results ─────────────────────────────────────────

printResults(scores);

// ─── Save baseline if requested ──────────────────────────────

const baselineDir = join(homedir(), '.yeaft', 'eval', 'baselines');

if (args['save-baseline']) {
  const path = saveBaseline(scores, baselineDir, args['save-baseline']);
  console.log(`\nBaseline saved: ${path}`);
}

// ─── Compare to baseline if requested ────────────────────────

if (args['compare-baseline']) {
  try {
    const baseline = loadBaseline(args['compare-baseline']);
    const comparison = compareToBaseline(scores, baseline);
    printComparison(comparison);

    if (comparison.regressions.length > 0) {
      process.exit(1); // Exit with error code for CI
    }
  } catch (err) {
    console.error(`\nFailed to load baseline: ${err.message}`);
    process.exit(1);
  }
}

// ─── Summary ─────────────────────────────────────────────────

const passed = scores.filter(s => s.totalScore >= 80).length;
const total = scores.length;
console.log(`\n${passed}/${total} evals passed (≥80 score)`);
