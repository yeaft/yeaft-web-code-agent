/**
 * eval/runner.js — Eval harness for Yeaft Unify
 *
 * Runs eval cases against one or more models and produces scored results.
 * Each eval case defines:
 *   - A prompt (what to send)
 *   - Expected behavior (tool calls, output assertions, timing)
 *   - Scoring rubric (pass/fail/score per criterion)
 *
 * Results are deterministic and comparable across models for regression detection.
 *
 * Usage:
 *   import { runEvals, printResults, saveBaseline, compareToBaseline } from './runner.js';
 *   const results = await runEvals({ models: ['claude-sonnet-4-20250514'], suite: 'tools' });
 *   printResults(results);
 */

import { Engine } from '../engine.js';
import { NullTrace } from '../debug-trace.js';
import { buildSystemPrompt } from '../prompts.js';
import { createEmptyRegistry } from '../tools/registry.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── Types ───────────────────────────────────────────────────

/**
 * @typedef {Object} EvalCase
 * @property {string} id — unique identifier (e.g. "tool-use-search-basic")
 * @property {string} suite — group name (e.g. "tools", "memory", "skills")
 * @property {string} description — human-readable description
 * @property {string} prompt — the user prompt to send
 * @property {string} [mode] — 'chat' | 'work' (default: 'chat')
 * @property {object[]} [messages] — prior conversation messages
 * @property {object[]} [tools] — tool definitions to register
 * @property {object} [registryTools] — ToolDef objects to register in ToolRegistry
 * @property {Function} [setupEngine] — custom engine setup hook
 * @property {EvalCriterion[]} criteria — scoring criteria
 */

/**
 * @typedef {Object} EvalCriterion
 * @property {string} id — criterion identifier
 * @property {string} description — what this checks
 * @property {number} weight — importance weight (1-10)
 * @property {(result: EvalRunResult) => CriterionScore} score — scoring function
 */

/**
 * @typedef {Object} CriterionScore
 * @property {boolean} pass — did it pass?
 * @property {number} score — 0.0 to 1.0
 * @property {string} [reason] — explanation
 */

/**
 * @typedef {Object} EvalRunResult
 * @property {string} caseId
 * @property {string} model
 * @property {object[]} events — all engine events
 * @property {string} fullText — concatenated text_delta
 * @property {object[]} toolCalls — tool_call events
 * @property {object[]} toolResults — tool_end events
 * @property {number} turnCount
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} latencyMs
 * @property {string|null} error — error message if failed
 */

/**
 * @typedef {Object} EvalScore
 * @property {string} caseId
 * @property {string} model
 * @property {number} totalScore — weighted average 0-100
 * @property {Record<string, CriterionScore>} criteria
 * @property {EvalRunResult} raw
 */

// ─── Runner ──────────────────────────────────────────────────

/**
 * Run a single eval case against a model adapter.
 *
 * @param {EvalCase} evalCase
 * @param {{ adapter: object, model: string, config?: object }} options
 * @returns {Promise<EvalRunResult>}
 */
export async function runSingleEval(evalCase, { adapter, model, config = {} }) {
  const trace = new NullTrace();
  const engineConfig = { model, maxOutputTokens: 4096, ...config };

  // Build engine — optionally with ToolRegistry
  const engineOpts = { adapter, trace, config: engineConfig };

  if (evalCase.registryTools) {
    const registry = createEmptyRegistry();
    for (const tool of evalCase.registryTools) {
      registry.register(tool);
    }
    engineOpts.toolRegistry = registry;
  }

  const engine = new Engine(engineOpts);

  // Register legacy tools if provided
  if (evalCase.tools) {
    for (const tool of evalCase.tools) {
      engine.registerTool(tool);
    }
  }

  // Custom setup hook
  if (evalCase.setupEngine) {
    evalCase.setupEngine(engine);
  }

  const events = [];
  let fullText = '';
  const toolCalls = [];
  const toolResults = [];
  let turnCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let error = null;

  const startTime = Date.now();

  try {
    for await (const event of engine.query({
      prompt: evalCase.prompt,
      mode: evalCase.mode || 'chat',
      messages: evalCase.messages || [],
    })) {
      events.push(event);

      switch (event.type) {
        case 'text_delta':
          fullText += event.text;
          break;
        case 'tool_call':
          toolCalls.push(event);
          break;
        case 'tool_end':
          toolResults.push(event);
          break;
        case 'turn_start':
          turnCount++;
          break;
        case 'usage':
          inputTokens += event.inputTokens || 0;
          outputTokens += event.outputTokens || 0;
          break;
        case 'error':
          error = event.error?.message || 'Unknown error';
          break;
      }
    }
  } catch (err) {
    error = err.message;
  }

  const latencyMs = Date.now() - startTime;

  return {
    caseId: evalCase.id,
    model,
    events,
    fullText,
    toolCalls,
    toolResults,
    turnCount,
    inputTokens,
    outputTokens,
    latencyMs,
    error,
  };
}

/**
 * Score an eval run against its criteria.
 *
 * @param {EvalCase} evalCase
 * @param {EvalRunResult} runResult
 * @returns {EvalScore}
 */
export function scoreEval(evalCase, runResult) {
  const criteriaResults = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const criterion of evalCase.criteria) {
    const result = criterion.score(runResult);
    criteriaResults[criterion.id] = result;
    weightedSum += result.score * criterion.weight;
    totalWeight += criterion.weight;
  }

  return {
    caseId: evalCase.id,
    model: runResult.model,
    totalScore: totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0,
    criteria: criteriaResults,
    raw: runResult,
  };
}

/**
 * Run multiple eval cases against multiple adapters.
 *
 * @param {{
 *   cases: EvalCase[],
 *   adapters: { name: string, adapter: object, config?: object }[],
 * }} params
 * @returns {Promise<EvalScore[]>}
 */
export async function runEvals({ cases, adapters }) {
  const allScores = [];

  for (const { name: model, adapter, config } of adapters) {
    for (const evalCase of cases) {
      const runResult = await runSingleEval(evalCase, { adapter, model, config });
      const score = scoreEval(evalCase, runResult);
      allScores.push(score);
    }
  }

  return allScores;
}

// ─── Baseline Management ─────────────────────────────────────

/**
 * Save eval scores as a baseline for future comparison.
 *
 * @param {EvalScore[]} scores
 * @param {string} baselineDir — directory to store baselines
 * @param {string} [name] — baseline name (default: timestamp)
 */
export function saveBaseline(scores, baselineDir, name) {
  mkdirSync(baselineDir, { recursive: true });
  const filename = `${name || new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const baseline = {
    timestamp: new Date().toISOString(),
    name: name || 'unnamed',
    scores: scores.map(s => ({
      caseId: s.caseId,
      model: s.model,
      totalScore: s.totalScore,
      criteria: s.criteria,
      // Omit raw to keep baseline files small
    })),
  };
  writeFileSync(join(baselineDir, filename), JSON.stringify(baseline, null, 2));
  return join(baselineDir, filename);
}

/**
 * Load a baseline file.
 *
 * @param {string} path
 * @returns {object}
 */
export function loadBaseline(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Compare current scores against a baseline.
 * Returns a list of regressions (cases where score dropped).
 *
 * @param {EvalScore[]} current
 * @param {object} baseline — loaded baseline object
 * @param {number} [threshold=5] — score drop threshold to flag as regression
 * @returns {{ regressions: object[], improvements: object[], unchanged: object[] }}
 */
export function compareToBaseline(current, baseline, threshold = 5) {
  const baselineMap = new Map();
  for (const s of baseline.scores) {
    baselineMap.set(`${s.model}::${s.caseId}`, s);
  }

  const regressions = [];
  const improvements = [];
  const unchanged = [];

  for (const score of current) {
    const key = `${score.model}::${score.caseId}`;
    const base = baselineMap.get(key);

    if (!base) {
      unchanged.push({ ...score, baseScore: null, delta: null, status: 'new' });
      continue;
    }

    const delta = score.totalScore - base.totalScore;

    if (delta < -threshold) {
      regressions.push({
        caseId: score.caseId,
        model: score.model,
        currentScore: score.totalScore,
        baseScore: base.totalScore,
        delta,
        criteria: score.criteria,
        baseCriteria: base.criteria,
      });
    } else if (delta > threshold) {
      improvements.push({
        caseId: score.caseId,
        model: score.model,
        currentScore: score.totalScore,
        baseScore: base.totalScore,
        delta,
      });
    } else {
      unchanged.push({
        caseId: score.caseId,
        model: score.model,
        currentScore: score.totalScore,
        baseScore: base.totalScore,
        delta,
      });
    }
  }

  return { regressions, improvements, unchanged };
}

// ─── Display ─────────────────────────────────────────────────

/**
 * Print eval results as a formatted table.
 *
 * @param {EvalScore[]} scores
 */
export function printResults(scores) {
  // Group by model
  const byModel = new Map();
  for (const s of scores) {
    if (!byModel.has(s.model)) byModel.set(s.model, []);
    byModel.get(s.model).push(s);
  }

  for (const [model, modelScores] of byModel) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  Model: ${model}`);
    console.log(`${'═'.repeat(60)}`);

    for (const s of modelScores) {
      const icon = s.totalScore >= 80 ? '✅' : s.totalScore >= 50 ? '⚠️' : '❌';
      console.log(`\n  ${icon} ${s.caseId} — ${s.totalScore}/100`);

      for (const [critId, crit] of Object.entries(s.criteria)) {
        const critIcon = crit.pass ? '  ✓' : '  ✗';
        console.log(`    ${critIcon} ${critId}: ${Math.round(crit.score * 100)}%${crit.reason ? ` — ${crit.reason}` : ''}`);
      }
    }

    const avg = Math.round(modelScores.reduce((sum, s) => sum + s.totalScore, 0) / modelScores.length);
    console.log(`\n  Average: ${avg}/100`);
  }
}

/**
 * Print baseline comparison results.
 *
 * @param {{ regressions: object[], improvements: object[], unchanged: object[] }} comparison
 */
export function printComparison(comparison) {
  const { regressions, improvements, unchanged } = comparison;

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Baseline Comparison');
  console.log(`${'═'.repeat(60)}`);

  if (regressions.length > 0) {
    console.log(`\n  🔴 REGRESSIONS (${regressions.length}):`);
    for (const r of regressions) {
      console.log(`    ${r.model} :: ${r.caseId}: ${r.baseScore} → ${r.currentScore} (${r.delta})`);
    }
  }

  if (improvements.length > 0) {
    console.log(`\n  🟢 IMPROVEMENTS (${improvements.length}):`);
    for (const i of improvements) {
      console.log(`    ${i.model} :: ${i.caseId}: ${i.baseScore} → ${i.currentScore} (+${i.delta})`);
    }
  }

  console.log(`\n  ⚪ Unchanged: ${unchanged.length} cases`);

  if (regressions.length > 0) {
    console.log('\n  ⛔ REGRESSION DETECTED — eval failed');
  } else {
    console.log('\n  ✅ No regressions detected');
  }
}

// ─── Criterion Helpers ───────────────────────────────────────

/** Check that no error occurred. */
export const noError = {
  id: 'no-error',
  description: 'No error during execution',
  weight: 10,
  score: (result) => ({
    pass: !result.error,
    score: result.error ? 0 : 1,
    reason: result.error || undefined,
  }),
};

/** Check that response contains expected text. */
export function containsText(text, opts = {}) {
  return {
    id: opts.id || `contains-${text.slice(0, 20)}`,
    description: opts.description || `Response contains "${text}"`,
    weight: opts.weight || 5,
    score: (result) => {
      const found = result.fullText.toLowerCase().includes(text.toLowerCase());
      return { pass: found, score: found ? 1 : 0 };
    },
  };
}

/** Check that a specific tool was called. */
export function toolWasCalled(toolName, opts = {}) {
  return {
    id: opts.id || `tool-called-${toolName}`,
    description: opts.description || `Tool "${toolName}" was called`,
    weight: opts.weight || 8,
    score: (result) => {
      const called = result.toolCalls.some(tc => tc.name === toolName);
      return { pass: called, score: called ? 1 : 0 };
    },
  };
}

/** Check that a tool was called with specific input. */
export function toolCalledWith(toolName, inputMatcher, opts = {}) {
  return {
    id: opts.id || `tool-input-${toolName}`,
    description: opts.description || `Tool "${toolName}" called with correct input`,
    weight: opts.weight || 6,
    score: (result) => {
      const call = result.toolCalls.find(tc => tc.name === toolName);
      if (!call) return { pass: false, score: 0, reason: 'Tool not called' };
      const match = inputMatcher(call.input);
      return { pass: match, score: match ? 1 : 0 };
    },
  };
}

/** Check that a tool was NOT called. */
export function toolNotCalled(toolName, opts = {}) {
  return {
    id: opts.id || `tool-not-called-${toolName}`,
    description: opts.description || `Tool "${toolName}" was NOT called`,
    weight: opts.weight || 5,
    score: (result) => {
      const called = result.toolCalls.some(tc => tc.name === toolName);
      return { pass: !called, score: called ? 0 : 1 };
    },
  };
}

/** Check that a tool succeeded (not error). */
export function toolSucceeded(toolName, opts = {}) {
  return {
    id: opts.id || `tool-success-${toolName}`,
    description: opts.description || `Tool "${toolName}" succeeded`,
    weight: opts.weight || 7,
    score: (result) => {
      const toolResult = result.toolResults.find(tr => tr.name === toolName);
      if (!toolResult) return { pass: false, score: 0, reason: 'Tool not found in results' };
      return { pass: !toolResult.isError, score: toolResult.isError ? 0 : 1, reason: toolResult.isError ? toolResult.output : undefined };
    },
  };
}

/** Check total turn count is within bounds. */
export function turnCountInRange(min, max, opts = {}) {
  return {
    id: opts.id || `turns-${min}-${max}`,
    description: opts.description || `Turn count between ${min} and ${max}`,
    weight: opts.weight || 3,
    score: (result) => {
      const inRange = result.turnCount >= min && result.turnCount <= max;
      return { pass: inRange, score: inRange ? 1 : 0, reason: `${result.turnCount} turns` };
    },
  };
}

/** Check that response does NOT contain text. */
export function doesNotContain(text, opts = {}) {
  return {
    id: opts.id || `not-contains-${text.slice(0, 20)}`,
    description: opts.description || `Response does NOT contain "${text}"`,
    weight: opts.weight || 4,
    score: (result) => {
      const found = result.fullText.toLowerCase().includes(text.toLowerCase());
      return { pass: !found, score: found ? 0 : 1 };
    },
  };
}

/** Check response length is within bounds (characters). */
export function responseLengthInRange(min, max, opts = {}) {
  return {
    id: opts.id || `length-${min}-${max}`,
    description: opts.description || `Response length between ${min} and ${max} chars`,
    weight: opts.weight || 2,
    score: (result) => {
      const len = result.fullText.length;
      const inRange = len >= min && len <= max;
      return { pass: inRange, score: inRange ? 1 : 0, reason: `${len} chars` };
    },
  };
}

/** Custom criterion with arbitrary scoring function. */
export function custom(id, description, weight, scoreFn) {
  return { id, description, weight, score: scoreFn };
}
