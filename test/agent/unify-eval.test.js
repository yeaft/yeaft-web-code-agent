/**
 * test/agent/unify-eval.test.js — Tests for the eval harness itself
 *
 * Validates that:
 *   1. Eval runner collects events correctly
 *   2. Scoring functions work as expected
 *   3. Criterion helpers produce correct pass/fail
 *   4. Baseline save/load/compare works
 *   5. Tool use eval cases score correctly with a MockAdapter
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  runSingleEval,
  scoreEval,
  runEvals,
  saveBaseline,
  loadBaseline,
  compareToBaseline,
  noError,
  containsText,
  toolWasCalled,
  toolCalledWith,
  toolNotCalled,
  toolSucceeded,
  turnCountInRange,
  doesNotContain,
  responseLengthInRange,
  custom,
} from '../../agent/unify/eval/runner.js';
import { defineTool } from '../../agent/unify/tools/types.js';

// ─── Mock Adapter ────────────────────────────────────────────

class MockAdapter {
  constructor() {
    this.responses = [];
    this.callLog = [];
  }
  pushResponse(events) {
    this.responses.push(events);
  }
  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift();
    if (!events) throw new Error('MockAdapter: no more responses');
    for (const event of events) yield event;
  }
  async call(params) {
    this.callLog.push(params);
    return { text: '{}', usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

// ─── Test Helpers ────────────────────────────────────────────

let testDir;

beforeEach(() => {
  testDir = join(tmpdir(), `yeaft-eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
// Eval Runner
// ═══════════════════════════════════════════════════════════════

describe('Eval Runner', () => {
  it('should collect events from a simple query', async () => {
    const adapter = new MockAdapter();
    adapter.pushResponse([
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'usage', inputTokens: 50, outputTokens: 10 },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const result = await runSingleEval(
      { id: 'test-1', suite: 'test', description: 'Test', prompt: 'hi', criteria: [] },
      { adapter, model: 'test-model' },
    );

    expect(result.caseId).toBe('test-1');
    expect(result.model).toBe('test-model');
    expect(result.fullText).toBe('Hello world');
    expect(result.turnCount).toBe(1);
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(10);
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should collect tool calls and results', async () => {
    const adapter = new MockAdapter();
    adapter.pushResponse([
      { type: 'text_delta', text: 'Let me search.' },
      { type: 'tool_call', id: 'tc1', name: 'search', input: { q: 'test' } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'Found results.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const searchTool = defineTool({
      name: 'search',
      description: 'Search',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      modes: ['chat'],
      execute: async (input) => `Results for ${input.q}`,
    });

    const result = await runSingleEval(
      { id: 'test-2', suite: 'test', description: 'Test', prompt: 'search test', criteria: [], registryTools: [searchTool] },
      { adapter, model: 'test-model' },
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('search');
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].output).toBe('Results for test');
    expect(result.toolResults[0].isError).toBe(false);
    expect(result.turnCount).toBe(2);
  });

  it('should capture errors', async () => {
    const adapter = {
      async *stream() { throw new Error('Network failure'); },
    };

    const result = await runSingleEval(
      { id: 'test-err', suite: 'test', description: 'Test', prompt: 'hi', criteria: [] },
      { adapter, model: 'test-model' },
    );

    expect(result.error).toBe('Network failure');
  });
});

// ═══════════════════════════════════════════════════════════════
// Scoring
// ═══════════════════════════════════════════════════════════════

describe('Eval Scoring', () => {
  const mockResult = {
    caseId: 'test',
    model: 'test',
    events: [],
    fullText: 'The capital of France is Paris.',
    toolCalls: [{ id: 'tc1', name: 'search', input: { q: 'France capital' } }],
    toolResults: [{ id: 'tc1', name: 'search', output: 'Paris', isError: false }],
    turnCount: 2,
    inputTokens: 100,
    outputTokens: 20,
    latencyMs: 500,
    error: null,
  };

  it('noError should pass when no error', () => {
    expect(noError.score(mockResult).pass).toBe(true);
    expect(noError.score({ ...mockResult, error: 'oops' }).pass).toBe(false);
  });

  it('containsText should match case-insensitively', () => {
    const criterion = containsText('paris');
    expect(criterion.score(mockResult).pass).toBe(true);
    expect(containsText('Berlin').score(mockResult).pass).toBe(false);
  });

  it('doesNotContain should check absence', () => {
    expect(doesNotContain('Berlin').score(mockResult).pass).toBe(true);
    expect(doesNotContain('Paris').score(mockResult).pass).toBe(false);
  });

  it('toolWasCalled should check tool presence', () => {
    expect(toolWasCalled('search').score(mockResult).pass).toBe(true);
    expect(toolWasCalled('calculator').score(mockResult).pass).toBe(false);
  });

  it('toolNotCalled should check tool absence', () => {
    expect(toolNotCalled('calculator').score(mockResult).pass).toBe(true);
    expect(toolNotCalled('search').score(mockResult).pass).toBe(false);
  });

  it('toolCalledWith should check input', () => {
    const criterion = toolCalledWith('search', (input) => input.q.includes('France'));
    expect(criterion.score(mockResult).pass).toBe(true);

    const wrong = toolCalledWith('search', (input) => input.q.includes('Germany'));
    expect(wrong.score(mockResult).pass).toBe(false);
  });

  it('toolSucceeded should check tool result', () => {
    expect(toolSucceeded('search').score(mockResult).pass).toBe(true);

    const errorResult = { ...mockResult, toolResults: [{ name: 'search', output: 'Error', isError: true }] };
    expect(toolSucceeded('search').score(errorResult).pass).toBe(false);
  });

  it('turnCountInRange should check bounds', () => {
    expect(turnCountInRange(1, 3).score(mockResult).pass).toBe(true);
    expect(turnCountInRange(3, 5).score(mockResult).pass).toBe(false);
  });

  it('responseLengthInRange should check text length', () => {
    expect(responseLengthInRange(10, 100).score(mockResult).pass).toBe(true);
    expect(responseLengthInRange(100, 200).score(mockResult).pass).toBe(false);
  });

  it('custom should allow arbitrary scoring', () => {
    const criterion = custom('test', 'Test', 5, (result) => ({
      pass: result.turnCount === 2,
      score: 1,
    }));
    expect(criterion.score(mockResult).pass).toBe(true);
  });

  it('scoreEval should produce weighted total', () => {
    const evalCase = {
      id: 'test',
      criteria: [
        { id: 'a', weight: 10, score: () => ({ pass: true, score: 1.0 }) },
        { id: 'b', weight: 5, score: () => ({ pass: false, score: 0.0 }) },
      ],
    };

    const result = scoreEval(evalCase, mockResult);
    // Weighted: (1.0*10 + 0.0*5) / 15 = 0.667 → 67
    expect(result.totalScore).toBe(67);
    expect(result.criteria.a.pass).toBe(true);
    expect(result.criteria.b.pass).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// runEvals (multi-model)
// ═══════════════════════════════════════════════════════════════

describe('runEvals', () => {
  it('should run cases across multiple adapters', async () => {
    const adapter1 = new MockAdapter();
    adapter1.pushResponse([
      { type: 'text_delta', text: 'Model A response' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const adapter2 = new MockAdapter();
    adapter2.pushResponse([
      { type: 'text_delta', text: 'Model B response' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const evalCase = {
      id: 'multi-test',
      suite: 'test',
      description: 'Test',
      prompt: 'hello',
      criteria: [noError],
    };

    const scores = await runEvals({
      cases: [evalCase],
      adapters: [
        { name: 'model-a', adapter: adapter1 },
        { name: 'model-b', adapter: adapter2 },
      ],
    });

    expect(scores).toHaveLength(2);
    expect(scores[0].model).toBe('model-a');
    expect(scores[1].model).toBe('model-b');
    expect(scores[0].totalScore).toBe(100);
    expect(scores[1].totalScore).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// Baseline Management
// ═══════════════════════════════════════════════════════════════

describe('Baseline Management', () => {
  it('should save and load a baseline', () => {
    const scores = [
      { caseId: 'test-1', model: 'model-a', totalScore: 85, criteria: { a: { pass: true, score: 1 } }, raw: {} },
      { caseId: 'test-2', model: 'model-a', totalScore: 70, criteria: { a: { pass: true, score: 0.7 } }, raw: {} },
    ];

    const path = saveBaseline(scores, join(testDir, 'baselines'), 'test-baseline');
    expect(existsSync(path)).toBe(true);

    const loaded = loadBaseline(path);
    expect(loaded.name).toBe('test-baseline');
    expect(loaded.scores).toHaveLength(2);
    expect(loaded.scores[0].totalScore).toBe(85);
  });

  it('should detect regressions in comparison', () => {
    const baseline = {
      timestamp: '2026-04-10T00:00:00Z',
      name: 'original',
      scores: [
        { caseId: 'test-1', model: 'model-a', totalScore: 90, criteria: {} },
        { caseId: 'test-2', model: 'model-a', totalScore: 80, criteria: {} },
        { caseId: 'test-3', model: 'model-a', totalScore: 60, criteria: {} },
      ],
    };

    const current = [
      { caseId: 'test-1', model: 'model-a', totalScore: 85, criteria: {} },  // -5, within threshold
      { caseId: 'test-2', model: 'model-a', totalScore: 50, criteria: {} },  // -30, REGRESSION
      { caseId: 'test-3', model: 'model-a', totalScore: 80, criteria: {} },  // +20, improvement
    ];

    const comparison = compareToBaseline(current, baseline, 5);

    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0].caseId).toBe('test-2');
    expect(comparison.regressions[0].delta).toBe(-30);

    expect(comparison.improvements).toHaveLength(1);
    expect(comparison.improvements[0].caseId).toBe('test-3');

    expect(comparison.unchanged).toHaveLength(1);
    expect(comparison.unchanged[0].caseId).toBe('test-1');
  });

  it('should handle new cases not in baseline', () => {
    const baseline = { scores: [{ caseId: 'old', model: 'x', totalScore: 80 }] };
    const current = [{ caseId: 'new-case', model: 'x', totalScore: 90, criteria: {} }];

    const comparison = compareToBaseline(current, baseline);
    expect(comparison.unchanged).toHaveLength(1);
    expect(comparison.unchanged[0].status).toBe('new');
  });
});

// ═══════════════════════════════════════════════════════════════
// Tool Use Cases with MockAdapter
// ═══════════════════════════════════════════════════════════════

describe('Tool Use Eval Cases (MockAdapter)', () => {
  it('should score 100% when model uses correct tool with correct input', async () => {
    const adapter = new MockAdapter();
    adapter.pushResponse([
      { type: 'text_delta', text: 'Let me search for that.' },
      { type: 'tool_call', id: 'tc1', name: 'search', input: { query: 'population of Tokyo' } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: 'Tokyo has about 14 million people.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const searchTool = defineTool({
      name: 'search',
      description: 'Search',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      modes: ['chat'],
      execute: async (input) => `Results for ${input.query}: Tokyo population is 14M`,
    });

    const evalCase = {
      id: 'perfect-tool-use',
      suite: 'test',
      description: 'Test',
      prompt: 'What is the population of Tokyo?',
      registryTools: [searchTool],
      criteria: [
        noError,
        toolWasCalled('search', { weight: 10 }),
        toolCalledWith('search', (input) => input.query.toLowerCase().includes('tokyo'), { weight: 8 }),
      ],
    };

    const result = await runSingleEval(evalCase, { adapter, model: 'test' });
    const score = scoreEval(evalCase, result);

    expect(score.totalScore).toBe(100);
    expect(score.criteria['no-error'].pass).toBe(true);
    expect(score.criteria['tool-called-search'].pass).toBe(true);
  });

  it('should score lower when model skips needed tool', async () => {
    const adapter = new MockAdapter();
    adapter.pushResponse([
      // Model answers directly without using search tool
      { type: 'text_delta', text: 'Tokyo has about 14 million people.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const searchTool = defineTool({
      name: 'search',
      description: 'Search',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      modes: ['chat'],
      execute: async () => 'results',
    });

    const evalCase = {
      id: 'missed-tool-use',
      suite: 'test',
      description: 'Test',
      prompt: 'What is the population of Tokyo?',
      registryTools: [searchTool],
      criteria: [
        noError,
        toolWasCalled('search', { weight: 10 }),
      ],
    };

    const result = await runSingleEval(evalCase, { adapter, model: 'test' });
    const score = scoreEval(evalCase, result);

    // noError passes (weight 10), toolWasCalled fails (weight 10) → 50%
    expect(score.totalScore).toBe(50);
  });

  it('should score 0% for tool-called criteria when wrong tool is used', async () => {
    const adapter = new MockAdapter();
    adapter.pushResponse([
      { type: 'tool_call', id: 'tc1', name: 'calculator', input: { expression: '1+1' } },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    adapter.pushResponse([
      { type: 'text_delta', text: '2' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const searchTool = defineTool({
      name: 'search', description: 'Search',
      parameters: { type: 'object', properties: {} }, modes: ['chat'],
      execute: async () => 'results',
    });
    const calcTool = defineTool({
      name: 'calculator', description: 'Calc',
      parameters: { type: 'object', properties: { expression: { type: 'string' } } }, modes: ['chat'],
      execute: async () => '2',
    });

    const evalCase = {
      id: 'wrong-tool',
      suite: 'test',
      description: 'Test',
      prompt: 'What is the population of Tokyo?',
      registryTools: [searchTool, calcTool],
      criteria: [
        toolWasCalled('search', { weight: 10 }),
        toolNotCalled('calculator', { weight: 5 }),
      ],
    };

    const result = await runSingleEval(evalCase, { adapter, model: 'test' });
    const score = scoreEval(evalCase, result);

    expect(score.criteria['tool-called-search'].pass).toBe(false);
    expect(score.criteria['tool-not-called-calculator'].pass).toBe(false);
    expect(score.totalScore).toBe(0);
  });
});
