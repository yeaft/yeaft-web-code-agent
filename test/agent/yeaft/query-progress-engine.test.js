import { describe, expect, it } from 'vitest';
import { Engine } from '../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { createBashTool } from '../../../agent/yeaft/tools/bash.js';
import fileReadTool from '../../../agent/yeaft/tools/file-read.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { buildMcpFlattenedTools } from '../../../agent/yeaft/tools/mcp-tools.js';
import discoverTools from '../../../agent/yeaft/tools/discover-tools.js';
import presentResponse from '../../../agent/yeaft/tools/present-response.js';
import { withUsageAccounting } from '../../../agent/yeaft/llm/usage-accounting.js';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { flushAgentPerfTrace } from '../../../agent/yeaft/perf-trace.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(response, deps = {}) {
  const requests = [];
  const rows = [];
  const store = {
    append(row) { const saved = { ...row, id: `m${rows.length + 1}`, seq: rows.length + 1 }; rows.push(saved); return saved; },
    loadRecentBySession() { return []; },
    update(row, patch) { Object.assign(row, patch); return row; },
  };
  const adapter = { async *stream(params) {
    params.onRequestStart?.();
    requests.push(structuredClone({ tools: params.tools, system: params.system, messages: params.messages }));
    yield* response(requests.length, params);
  } };
  const { decorateAdapter = value => value, ...engineDeps } = deps;
  const engine = new Engine({ adapter: decorateAdapter(adapter), trace: new NullTrace(), conversationStore: store,
    config: { model: 'test-model', maxOutputTokens: 1024 }, ...engineDeps });
  return { engine, store, requests, rows };
}
const call = (id, name, input = {}) => ({ type: 'tool_call', id, name, input });
const stop = { type: 'stop', stopReason: 'tool_use' };
async function consume(engine, extra = {}) {
  const events = [];
  for await (const event of engine.query({ prompt: 'modify the RFC, then verify', sessionId: 's', ...extra })) events.push(event);
  return events;
}

describe('query progress Engine boundaries', () => {
  it('pairs the complete batch then reserves one tool-free report; ignores unsolicited report tools', async () => {
    const { engine, requests, rows } = setup(n => n <= 13
      ? [{ type: 'text_delta', text: 'I will edit shortly.' }, call(`a${n}`, 'ReadA'), call(`b${n}`, 'ReadB'), stop]
      : [call('must-not-run', 'Write'), { type: 'stop', stopReason: 'max_tokens' }]);
    let executions = 0;
    for (const name of ['ReadA', 'ReadB']) engine.registerTool({ name, isReadOnly: () => true,
      execute: async () => { executions++; return `unchanged ${name}`; } });
    engine.registerTool({ name: 'Write', execute: async () => { throw Error('report must not execute'); } });
    const events = await consume(engine);
    expect(executions).toBe(26);
    expect(requests).toHaveLength(14);
    expect(requests.at(-1).tools).toBeUndefined();
    expect(events.filter(e => e.type === 'tool_end')).toHaveLength(26);
    expect(rows.filter(r => r.role === 'tool')).toHaveLength(26);
    expect(rows.some(r => r.content.includes('requested task is not confirmed complete'))).toBe(true);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([
      expect.objectContaining({ stopReason: 'no_progress' }),
    ]);
    expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ stage: 'stopped', toolExecutions: 26 });
    // Reminders are model-only, and raw tool output is never replaced in persistence.
    expect(rows.filter(r => r.role === 'tool').every(r => r.content.startsWith('unchanged'))).toBe(true);
    expect(rows.some(r => r.content.startsWith('[system note] Query progress'))).toBe(false);

    const unavailable = setup(n => n <= 12 ? [call(`missing-${n}`, 'Unavailable'), stop]
      : [{ type: 'text_delta', text: 'Tool is unavailable; cannot proceed.' }, { type: 'stop', stopReason: 'end_turn' }]);
    const missingEvents = await consume(unavailable.engine);
    expect(unavailable.requests).toHaveLength(13);
    expect(missingEvents.filter(e => e.type === 'tool_end')).toHaveLength(12);
    expect(missingEvents.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ failedCalls: 12, toolExecutions: 0,
      toolStats: [{ name: 'Unavailable', executions: 0, failedCalls: 12, blockedCalls: 12 }] });
    expect(missingEvents.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'no_progress' })]);
  });

  it('keeps long fresh investigations free of reflection and isolates child accounting', async () => {
    const accounted = [];
    let shared;
    let reflections = 0;
    let folds = 0;
    const { engine, requests, store, rows } = setup(n => [
      { type: 'usage', inputTokens: 10, outputTokens: 1 },
      ...(n <= 35 ? [call(`r${n}`, 'Read', { offset: n }), stop]
        : [{ type: 'text_delta', text: 'verified output' }, { type: 'stop', stopReason: 'end_turn' }]),
    ], { decorateAdapter: adapter => {
      adapter.call = async params => {
        if (params.system === 'child-side-call') return { text: 'child answer', usage: { inputTokens: 7000, outputTokens: 700 } };
        reflections++;
        throw new Error('reflection must not run');
      };
      shared = withUsageAccounting(adapter, value => accounted.push(value));
      return shared;
    } });
    store.foldMessages = () => { folds++; throw new Error('history must not be folded'); };
    const contexts = [];
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async (input, ctx) => {
      contexts.push(ctx);
      if (input.offset === 1) {
        const child = new Engine({ adapter: { async *stream(params) {
          const result = await shared.call({ ...params, system: 'child-side-call' });
          yield { type: 'usage', ...result.usage };
          yield { type: 'text_delta', text: result.text };
          yield { type: 'stop', stopReason: 'end_turn' };
        } }, trace: new NullTrace(), config: { model: 'test-model', maxOutputTokens: 1024 } });
        const childEvents = await consume(child, { isSubAgent: true, threadId: 'child' });
        expect(childEvents.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ modelRequests: 1, inputTokens: 7000, outputTokens: 700 });
      }
      return `page ${input.offset}`;
    } });
    const events = await consume(engine);
    expect(requests).toHaveLength(36);
    expect(reflections).toBe(0);
    expect(folds).toBe(0);
    expect(events.filter(e => e.type === 'reflection')).toEqual([]);
    expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ stage: 'running', modelRequests: 36, inputTokens: 360, outputTokens: 36 });
    expect(requests.at(-1).messages.filter(m => m.role === 'tool')).toHaveLength(35);
    expect(rows.filter(m => m.role === 'tool')).toHaveLength(35);
    expect(accounted).toHaveLength(37); // 36 streams and one child, no maintenance call.
    expect(contexts.every(ctx => ctx.historyBeforeSeq === 1 && typeof ctx.queryTurnId === 'string')).toBe(true);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)[0]).toMatchObject({ stopReason: 'end_turn' });
    expect(events.find(e => e.type === 'turn_close')).toMatchObject({ inputTokens: 360, outputTokens: 36 });
    // The old asynchronous T2 threshold must not produce a late fold or call.
    await consume(engine);
    expect(reflections).toBe(0);
    expect(folds).toBe(0);
  });

  it('compacts tool results under window pressure and retries overflow without replay or durable folding', async () => {
    const { LLMContextError } = await import('../../../agent/yeaft/llm/adapter.js');
    const { estimateMessagesTokens } = await import('../../../agent/yeaft/history-window.js');
    const root = await mkdtemp(join(tmpdir(), 'yeaft-pressure-compact-'));
    const config = { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: 24000,
      yeaftDir: root, archive: { toolResults: false } };
    try {
      let executions = 0;
      let summaryCalls = 0;
      const { engine, requests, rows, store } = setup(n => {
        if (n <= 8) return [call(`large-${n}`, 'Read', { offset: n }), stop];
        if (n === 9) throw new LLMContextError('provider actual context limit');
        return [{ type: 'text_delta', text: 'verified compact recovery' }, { type: 'stop', stopReason: 'end_turn' }];
      }, {
        config,
        decorateAdapter: adapter => { adapter.call = async () => { summaryCalls++; throw Error('no reflection'); }; return adapter; },
      });
      let folds = 0;
      store.foldMessages = () => { folds++; };
      const result = offset => `HEAD page ${offset}\n${'x'.repeat(28000)}\nTAIL page ${offset}`;
      engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async ({ offset }) => { executions++; return result(offset); } });
      const events = await consume(engine);
      expect(executions).toBe(8);
      expect(requests).toHaveLength(10);
      expect(summaryCalls).toBe(0);
      expect(folds).toBe(0);
      expect(events.some(e => e.type === 'reflection')).toBe(false);
      flushAgentPerfTrace(config);
      const traceDir = join(root, 'perf-traces');
      const traceFiles = await readdir(traceDir);
      const traceText = (await Promise.all(traceFiles.map(name => readFile(join(traceDir, name), 'utf8')))).join('\n');
      const compactTraces = traceText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.phase === 'tool_result_compact').map(row => row.detail);
      expect(traceText).not.toContain('HEAD page');
      expect(compactTraces.length).toBeGreaterThan(0);
      expect(compactTraces.at(-1)).toMatchObject({ recoveryAttempt: 1 });
      expect(compactTraces.every(item => item.compactedToolResults > 0 && item.estimatedTokens <= item.contextWindow)).toBe(true);
      expect(estimateMessagesTokens(requests[9].messages)).toBeLessThan(estimateMessagesTokens(requests[8].messages));
      const toolRows = rows.filter(row => row.role === 'tool');
      expect(toolRows).toHaveLength(8);
      expect(toolRows.map(row => row.content)).toEqual(Array.from({ length: 8 }, (_, i) => result(i + 1)));
      expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
    } finally {
      flushAgentPerfTrace(config);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('continues past deeply nested tool JSON without a sampling crash or maintenance call', async () => {
    const deep = '['.repeat(3_000) + '"' + 'x'.repeat(10_000) + '"' + ']'.repeat(3_000);
    let summaryCalls = 0;
    const { engine, requests, rows } = setup(n => n <= 2
      ? [call(`json-${n}`, 'Read', { offset: n }), stop]
      : [{ type: 'text_delta', text: 'continued safely' }, { type: 'stop', stopReason: 'end_turn' }], {
      config: { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: 8000, archive: { toolResults: false } },
      decorateAdapter: adapter => { adapter.call = async () => { summaryCalls++; throw Error('no reflection'); }; return adapter; },
    });
    engine.registerTool({ name: 'Read', isReadOnly: () => true,
      execute: async ({ offset }) => offset === 1 ? deep : 'y'.repeat(15_000) });
    const events = await consume(engine);
    expect(requests).toHaveLength(3);
    expect(summaryCalls).toBe(0);
    expect(rows.find(row => row.role === 'tool').content).toBe(deep);
    expect(events.filter(event => event.type === 'turn_end' && event.terminal))
      .toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
  });

  it.each([24000, 4000])('only consumes async evidence actually delivered after compaction (window %s)', async window => {
    const consumed = [];
    const undelivered = [];
    const evidence = `BACKGROUND_HEAD\n${'e'.repeat(27000)}\nBACKGROUND_TAIL`;
    let run;
    let ackedBeforeDispatch;
    run = setup(n => {
      if (n === 1) return [call('start', 'Start'), stop];
      if (n <= 8) return [call(`read-${n}`, 'Read', { offset: n }), stop];
      if (n === 9) {
        expect(run.engine.notifyAsyncTaskCompleted('owned', evidence, { causalRootId: 'newer-human' })).toBe(true);
        ackedBeforeDispatch = consumed.length;
      }
      return [{ type: 'text_delta', text: 'handled current evidence' }, { type: 'stop', stopReason: 'end_turn' }];
    }, {
      config: { model: 'test-model', maxOutputTokens: 1024, maxContextTokens: window, archive: { toolResults: false } },
    });
    run.engine.setAsyncTaskCoordinator({
      onConsumed: id => consumed.push(id),
      onUndelivered: (id, delivery) => undelivered.push({ id, delivery }),
    });
    run.engine.registerTool({ name: 'Start', execute: async (_input, ctx) => {
      ctx.registerAsyncTask('owned');
      return 'started';
    } });
    let executions = 0;
    run.engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async ({ offset }) => {
      executions++;
      return `HEAD ${offset}\n${'x'.repeat(28000)}\nTAIL ${offset}`;
    } });
    const events = await consume(run.engine, { causalRootId: 'original-human' });
    expect(ackedBeforeDispatch).toBe(0);
    expect(executions).toBe(7);
    const finalRequest = run.requests.at(-1);
    const includesEvidence = finalRequest.messages.some(message => typeof message.content === 'string' && message.content.includes(evidence));
    if (window === 24000) {
      expect(includesEvidence).toBe(true);
      expect(consumed).toEqual(['owned']);
      expect(undelivered).toEqual([]);
    } else {
      expect(includesEvidence).toBe(false);
      expect(consumed).toEqual([]);
      expect(undelivered).toEqual([{ id: 'owned', delivery: expect.objectContaining({ causalRootId: 'original-human' }) }]);
    }
    expect(run.rows.find(row => row.role === 'tool' && row.toolCallId === 'start').content).toContain(evidence);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
  });

  it('never replays an uncertain side effect and retains a result for every rejected tool call', async () => {
    for (const error of ['connection timeout after dispatch', 'schema migration timeout after dispatch',
      'validation request disconnected after dispatch', 'upstream failed after committing operation']) {
      const { engine, requests } = setup(n => n <= 3 ? [call(`w${n}`, 'Send'), stop]
        : [{ type: 'text_delta', text: 'Need to verify delivery state.' }, { type: 'stop', stopReason: 'end_turn' }]);
      let executions = 0;
      engine.registerTool({ name: 'Send', execute: async () => { executions++; throw Error(error); } });
      const events = await consume(engine);
      expect(executions, error).toBe(1);
      expect(events.filter(e => e.type === 'tool_end')).toHaveLength(3);
      expect(events.filter(e => e.type === 'tool_end' && e.suppressed)).toHaveLength(2);
      expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ toolExecutions: 1, failedCalls: 3,
        toolStats: [{ name: 'Send', executions: 1, failedCalls: 3, blockedCalls: 2 }] });
      expect(JSON.stringify(requests.at(-1).messages)).toContain('side effects may already have happened');
    }

    // Exercise the actual MCP -> registry -> thrown-error boundary: its JSON
    // envelope is prefixed with "Error: " by Engine before progress observes it.
    for (const contract of [
      { error: 'upstream failed after committing operation', errorEffect: 'unknown', replaySafe: false },
      { error: 'required property missing', code: 'invalid_arguments', errorEffect: 'none', replaySafe: true },
    ]) {
      let effects = 0;
      const manager = {
        listTools: () => [{ name: 'review__mutate', server: 'review', inputSchema: { type: 'object', properties: {} } }],
        async callTool() { effects++; return { isError: true, content: [{ type: 'text', text: JSON.stringify(contract) }] }; },
      };
      const registry = new ToolRegistry().register(discoverTools).registerAll(buildMcpFlattenedTools(manager));
      const mcp = setup(n => n === 1 ? [call('discover-mcp', 'DiscoverTools', { query: 'mutate' }), stop]
        : n <= 4 ? [call(`mcp-${n}`, 'mcp__review__mutate'), stop]
        : [{ type: 'text_delta', text: 'Reported safe blocker.' }, { type: 'stop', stopReason: 'end_turn' }],
      { toolRegistry: registry });
      const mcpEvents = await consume(mcp.engine);
      expect(effects).toBe(contract.errorEffect === 'unknown' ? 1 : 3);
      expect(mcpEvents.filter(e => e.type === 'tool_end' && e.suppressed)).toHaveLength(contract.errorEffect === 'unknown' ? 2 : 0);
      expect(mcpEvents.filter(e => e.type === 'tool_end' && e.name === 'mcp__review__mutate')).toHaveLength(3);
    }

    // A command may create the missing file before a later step fails. The
    // previously blocked read must execute to verify, but never replay the write.
    let exists = false;
    let readExecutions = 0;
    let writeExecutions = 0;
    const partial = setup(n => n <= 3 || n === 5
      ? [call(`read-${n}`, 'ReadMissing'), stop]
      : n === 4 || n === 6 ? [call(`create-${n}`, 'CreateThenFail'), stop]
        : [{ type: 'text_delta', text: 'Created state verified; write not retried.' }, { type: 'stop', stopReason: 'end_turn' }]);
    partial.engine.registerTool({ name: 'ReadMissing', isReadOnly: () => true, execute: async () => {
      readExecutions++;
      if (!exists) throw Error('ENOENT');
      return 'created content';
    } });
    partial.engine.registerTool({ name: 'CreateThenFail', execute: async () => {
      writeExecutions++;
      exists = true;
      throw Error('connection timeout after creating file');
    } });
    const partialEvents = await consume(partial.engine);
    expect(readExecutions).toBe(4);
    expect(writeExecutions).toBe(1);
    expect(partialEvents.filter(e => e.type === 'tool_end')).toHaveLength(6);
    expect(partial.rows.filter(r => r.role === 'tool').some(r => r.content === 'created content')).toBe(true);
  });

  it('reruns a confirmed nonzero Bash command after a successful repair', async () => {
    let repaired = false;
    let executions = 0;
    const { engine, requests } = setup(n => n === 1 || n === 3
      ? [call(`test-${n}`, 'Bash', { command: 'npm test' }), stop]
      : n === 2 ? [call('repair', 'FileEdit', { path: 'rfc' }), stop]
        : [{ type: 'text_delta', text: 'Tests passed after repair.' }, { type: 'stop', stopReason: 'end_turn' }]);
    engine.registerTool(createBashTool({ runProcessImpl: async () => {
      executions++;
      return { code: repaired ? 0 : 1, stdout: repaired ? 'PASS' : 'FAIL', stderr: '', timedOut: false };
    } }));
    engine.registerTool({ name: 'FileEdit', execute: async () => { repaired = true; return 'file repaired'; } });
    const events = await consume(engine);
    expect(executions).toBe(2);
    expect(requests).toHaveLength(4);
    expect(events.some(e => e.type === 'tool_end' && e.suppressed)).toBe(false);
    expect(events.filter(e => e.type === 'tool_end').at(-1)).toMatchObject({ output: 'PASS' });
  });

  it('treats distinct negative read observations as evidence, not repeated failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yeaft-timeout-schema-validation-forbidden-'));
    try {
      await writeFile(join(dir, 'candidate-20.json'), 'target evidence');
      const { engine, requests, rows } = setup(n => n <= 20
        ? [call(`candidate-${n}`, 'FileRead', { file_path: join(dir, `candidate-${n}.json`) }), stop]
        : [{ type: 'text_delta', text: 'Found target.' }, { type: 'stop', stopReason: 'end_turn' }]);
      engine.registerTool(fileReadTool);
      const events = await consume(engine);
      expect(requests).toHaveLength(21);
      expect(rows.some(row => row.role === 'tool' && row.content.includes('target evidence'))).toBe(true);
      expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({
        stage: 'running', repeatedCalls: 0, failedCalls: 19, stagnantBatches: 0,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('consumes an owned completion accepted during reporting (another task pending: %s)', async remainingTask => {
    let engine;
    let delivered = false;
    const run = setup(n => {
      if (n === 1) return [call('start', 'Start'), stop];
      if (n <= 14) return [call(`read-${n}`, 'Read'), stop];
      if (n === 15) {
        delivered = engine.notifyAsyncTaskCompleted('owned', 'NEW_BACKGROUND_EVIDENCE');
      }
      if (n === 16 && remainingTask) {
        expect(engine.notifyAsyncTaskCompleted('other', 'SECOND_BACKGROUND_EVIDENCE')).toBe(true);
      }
      return [{ type: 'text_delta', text: n === 15 ? 'Paused.' : 'Consumed new evidence.' }, { type: 'stop', stopReason: 'end_turn' }];
    });
    engine = run.engine;
    engine.registerTool({ name: 'Start', execute: async (_input, ctx) => {
      ctx.registerAsyncTask('owned');
      if (remainingTask) ctx.registerAsyncTask('other');
      return 'started';
    } });
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => 'same' });
    const events = await consume(engine);
    expect(delivered).toBe(true);
    expect(run.requests).toHaveLength(remainingTask ? 17 : 16);
    if (remainingTask) expect(JSON.stringify(run.requests[16].messages)).toContain('SECOND_BACKGROUND_EVIDENCE');
    expect(run.requests[14].tools).toBeUndefined();
    expect(run.requests[15].tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(run.requests[15].messages)).toContain('NEW_BACKGROUND_EVIDENCE');
    expect(events.some(e => e.type === 'tool_result_update' && e.taskId === 'owned')).toBe(true);
    expect(events.some(e => e.code === 'no_progress')).toBe(false);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
  });

  it('preserves accepted user input arriving during the reporting stream', async () => {
    let engine;
    let closeAttempts = 0;
    const setupResult = setup(n => {
      if (n <= 13) return [call(`r${n}`, 'Read'), stop];
      if (n === 14) {
        engine.appendUserMessage('Use the existing RFC and apply the edit now.');
        return [{ type: 'text_delta', text: 'Paused investigation.' }, { type: 'stop', stopReason: 'end_turn' }];
      }
      return [{ type: 'text_delta', text: 'New instruction received.' }, { type: 'stop', stopReason: 'end_turn' }];
    });
    engine = setupResult.engine;
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => 'same' });
    const events = await consume(engine, { closePendingUserInput: () => { closeAttempts++; return true; } });
    expect(setupResult.requests).toHaveLength(15);
    expect(JSON.stringify(setupResult.requests.at(-1).messages)).toContain('apply the edit now');
    expect(events.some(e => e.type === 'user_append')).toBe(true);
    expect(events.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ modelRequests: 15, toolExecutions: 13,
      toolStats: [{ name: 'Read', executions: 13, failedCalls: 0, blockedCalls: 0 }] });
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
    expect(closeAttempts).toBe(1);

    // A normal tool-free stream drains input on a different path than reporting.
    let normal;
    let repaired = false;
    let reads = 0;
    normal = setup(n => {
      if (n <= 3 || n === 5) return [call(`permission-${n}`, 'Read'), stop];
      if (n === 4) {
        repaired = true;
        normal.engine.appendUserMessage('Permissions repaired; retry the read.');
      }
      return [{ type: 'text_delta', text: 'acknowledged' }, { type: 'stop', stopReason: 'end_turn' }];
    });
    normal.engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => {
      reads++;
      if (!repaired) throw Error('EACCES');
      return 'verified recovered file';
    } });
    await consume(normal.engine);
    expect(reads).toBe(4);
    expect(normal.rows.some(row => row.content === 'verified recovered file')).toBe(true);

    // An owned async completion is a synchronization boundary even while parked
    // after a tool-free response; it must clear stale read-failure guards.
    repaired = false;
    reads = 0;
    const asyncWork = setup(n => n <= 3 || n === 6 ? [call(`async-read-${n}`, 'Read'), stop]
      : n === 4 ? [call('start-owned', 'Start'), stop]
        : [{ type: 'text_delta', text: 'waiting or finished' }, { type: 'stop', stopReason: 'end_turn' }]);
    asyncWork.engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => {
      reads++;
      if (!repaired) throw Error('EACCES');
      return 'async repaired file';
    } });
    asyncWork.engine.registerTool({ name: 'Start', isReadOnly: () => true, execute: async (_input, ctx) => {
      ctx.registerAsyncTask('owned-result');
      return 'background work started';
    } });
    for await (const event of asyncWork.engine.query({ prompt: 'verify repaired file', sessionId: 's' })) {
      if (event.type === 'async_task_wait_start') {
        repaired = true;
        expect(asyncWork.engine.notifyAsyncTaskCompleted('owned-result', 'permissions repaired')).toBe(true);
      }
    }
    expect(reads).toBe(4);
    expect(asyncWork.rows.some(row => row.content === 'async repaired file')).toBe(true);
  });

  it('honors abort at the report progress yield without publishing a fallback or no-progress error', async () => {
    const controller = new AbortController();
    const { engine, requests, rows } = setup(n => n <= 13 ? [call(`r${n}`, 'Read'), stop]
      : [{ type: 'stop', stopReason: 'end_turn' }]);
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => 'same' });
    const events = [];
    for await (const event of engine.query({ prompt: 'edit RFC', sessionId: 's', signal: controller.signal })) {
      events.push(event);
      if (event.type === 'query_progress' && requests.length === 14) controller.abort();
    }
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'aborted' })]);
    expect(events.some(e => e.code === 'no_progress')).toBe(false);
    expect(rows.some(r => String(r.content).includes('requested task is not confirmed complete'))).toBe(false);

    // Normal calls were already persisted before this new progress yield.
    // Aborting here must still synthesize every skipped tool result.
    const normalAbort = new AbortController();
    let dispatched = 0;
    const normal = setup(() => [call('paired-a', 'Read'), call('paired-b', 'Read'), stop]);
    normal.engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => { dispatched++; return 'not expected'; } });
    const normalEvents = [];
    for await (const event of normal.engine.query({ prompt: 'cancel batch', sessionId: 's', signal: normalAbort.signal })) {
      normalEvents.push(event);
      if (event.type === 'query_progress') normalAbort.abort();
    }
    expect(dispatched).toBe(0);
    expect(normalEvents.filter(e => e.type === 'tool_end')).toHaveLength(2);
    expect(normalEvents.filter(e => e.type === 'query_progress').at(-1)).toMatchObject({ toolExecutions: 0, failedCalls: 0, toolStats: [] });
    expect(normal.rows.filter(row => row.role === 'tool')).toHaveLength(2);
    expect(normalEvents.filter(e => e.type === 'turn_end' && e.terminal)).toEqual([expect.objectContaining({ stopReason: 'aborted' })]);
  });

  it('counts only dispatched executions across parallel sharing, cached reuse and batch skips', async () => {
    let reads = 0;
    let skipped = 0;
    const { engine } = setup(n => n === 1
      ? [call('read-a', 'Read'), call('read-b', 'Read'), stop]
      : n === 2 ? [call('cached-read', 'Read'), stop]
        : n === 3 ? [call('barrier', 'Barrier'), call('skip', 'NeverRun'), stop]
          : [{ type: 'text_delta', text: 'Done.' }, { type: 'stop', stopReason: 'end_turn' }]);
    engine.registerTool({ name: 'Read', isReadOnly: () => true, isConcurrencySafe: () => true, cacheWithinQuery: true,
      execute: async () => { reads++; return 'PRIVATE read result'; } });
    engine.registerTool({ name: 'Barrier', execute: async (_input, ctx) => {
      ctx.requestToolBatchBarrier('PRIVATE barrier reason'); return 'changed state';
    } });
    engine.registerTool({ name: 'NeverRun', execute: async () => { skipped++; return 'unexpected'; } });
    const events = await consume(engine);
    expect(reads).toBe(1);
    expect(skipped).toBe(0);
    const progress = events.filter(e => e.type === 'query_progress').at(-1);
    expect(progress).toMatchObject({ modelRequests: 4, toolExecutions: 2, reusedCalls: 2, failedCalls: 0,
      toolStats: [
        { name: 'Read', executions: 1, failedCalls: 0, blockedCalls: 0 },
        { name: 'Barrier', executions: 1, failedCalls: 0, blockedCalls: 0 },
      ] });
    expect(JSON.stringify(progress)).not.toContain('PRIVATE');

    // Publication executes in the tool batch but acknowledges only after its
    // strict durable write. Correct the failed call, not its successful peers
    // or execution count, and retain the pre-existing replay/loop policy.
    const presentation = summary => ({ title: 'Result', summary, blocks: [{ type: 'markdown', text: summary }] });
    const publication = setup(n => n === 1 ? [
      call('publish-ok', 'PresentResponse', presentation('Delivered first')),
      call('publish-failed', 'PresentResponse', presentation('Storage retry')),
      call('publish-after', 'PresentResponse', presentation('Delivered last')), stop,
    ] : n === 2 ? [call('publish-retry', 'PresentResponse', presentation('Storage retry')), stop]
      : [{ type: 'text_delta', text: 'Delivered safely.' }, { type: 'stop', stopReason: 'end_turn' }]);
    publication.engine.registerTool(presentResponse);
    const append = publication.store.append.bind(publication.store);
    let failOnce = true;
    publication.store.append = row => {
      if (row.presentation?.summary === 'Storage retry' && failOnce) {
        failOnce = false;
        throw new Error('disk unavailable');
      }
      return append(row);
    };
    const publishedEvents = await consume(publication.engine);
    const ends = publishedEvents.filter(event => event.type === 'tool_end');
    expect(ends.map(event => [event.id, event.isError])).toEqual([
      ['publish-ok', false], ['publish-failed', true], ['publish-after', false], ['publish-retry', false],
    ]);
    expect(publishedEvents.filter(event => event.type === 'response_presentation')).toHaveLength(3);
    expect(publication.rows.find(row => row.toolCallId === 'publish-failed')).toMatchObject({ isError: true,
      content: expect.stringContaining('Response publication failed: disk unavailable') });
    expect(publication.requests).toHaveLength(3);
    expect(publishedEvents.filter(event => event.type === 'query_progress').at(-1)).toMatchObject({
      toolExecutions: 4, failedCalls: ends.filter(event => event.isError).length, stagnantBatches: 0,
      toolStats: [{ name: 'PresentResponse', executions: 4, failedCalls: 1, blockedCalls: 0 }],
    });
  });

  it('publishes query-wide usage deltas immediately, retaining cache semantics and retry costs', async () => {
    const { engine } = setup(function* (n) {
      if (n === 1) {
        yield { type: 'usage', inputTokens: 10, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 5 };
        yield { type: 'error', error: 'temporary upstream failure', retryable: true };
      } else if (n === 2) {
        yield { type: 'usage', inputTokens: 100, outputTokens: 2, cacheReadTokens: 80, cacheTokensAreIncludedInInput: true };
        yield call('read', 'Read');
        yield stop;
      } else {
        if (n === 3) engine.appendUserMessage('PRIVATE additional instruction');
        yield { type: 'usage', inputTokens: 20, outputTokens: 0, reportedTokenFields: ['inputTokens'] };
        yield { type: 'usage', inputTokens: 0, outputTokens: 7, reportedTokenFields: ['outputTokens'] };
        yield { type: 'text_delta', text: 'Final answer without tools.' };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
    }, { config: { model: 'test-model', maxOutputTokens: 1024,
      llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } });
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => 'PRIVATE result' });
    const events = await consume(engine);
    expect(events.filter(e => e.type === 'llm_retry')).toHaveLength(1);
    const usageIndexes = events.flatMap((event, index) => event.type === 'usage' ? [index] : []);
    expect(usageIndexes.map(index => events[index + 1])).toEqual([
      expect.objectContaining({ type: 'query_progress', inputTokens: 45, outputTokens: 1, modelRequests: 1 }),
      expect.objectContaining({ type: 'query_progress', inputTokens: 145, outputTokens: 3, modelRequests: 2 }),
      expect.objectContaining({ type: 'query_progress', inputTokens: 165, outputTokens: 3, modelRequests: 3 }),
      expect.objectContaining({ type: 'query_progress', inputTokens: 165, outputTokens: 10, modelRequests: 3 }),
      expect.objectContaining({ type: 'query_progress', inputTokens: 185, outputTokens: 10, modelRequests: 4 }),
      expect.objectContaining({ type: 'query_progress', inputTokens: 185, outputTokens: 17, modelRequests: 4 }),
    ]);
    const progress = events.filter(e => e.type === 'query_progress').at(-1);
    expect(progress).toMatchObject({ inputTokens: 185, outputTokens: 17, toolExecutions: 1,
      toolStats: [{ name: 'Read', executions: 1, failedCalls: 0, blockedCalls: 0 }] });
    expect(events.find(e => e.type === 'turn_close')).toMatchObject({ inputTokens: 185, outputTokens: 17 });
    expect(JSON.stringify(progress)).not.toContain('PRIVATE');

    const unknown = setup(() => [
      { type: 'usage', inputTokens: 0, outputTokens: 0, reportedTokenFields: [], usageIncomplete: true },
      { type: 'usage', inputTokens: 0, outputTokens: 4, reportedTokenFields: ['outputTokens'] },
      { type: 'text_delta', text: 'No input usage was reported.' }, { type: 'stop', stopReason: 'end_turn' },
    ]);
    const unknownEvents = await consume(unknown.engine);
    const unknownProgress = unknownEvents.filter(e => e.type === 'query_progress');
    expect(unknownProgress.every(event => !Object.hasOwn(event, 'inputTokens'))).toBe(true);
    expect(unknownProgress[0]).not.toHaveProperty('outputTokens');
    expect(unknownProgress.at(-1)).toMatchObject({ outputTokens: 4, toolStats: [] });
  });

  it('keeps user abort authoritative without starting a recovery response', async () => {
    const controller = new AbortController();
    const { engine, requests } = setup(n => [call(`r${n}`, 'Read'), stop]);
    let count = 0;
    engine.registerTool({ name: 'Read', isReadOnly: () => true, execute: async () => {
      if (++count === 6) controller.abort();
      return 'same';
    } });
    const events = await consume(engine, { signal: controller.signal });
    expect(requests).toHaveLength(6);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)).toHaveLength(1);
    expect(events.filter(e => e.type === 'turn_end' && e.terminal)[0].stopReason).not.toBe('no_progress');
  });
});
