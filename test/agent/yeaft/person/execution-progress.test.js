import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionProgress } from '../../../../agent/yeaft/person/execution-progress.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';
import { bytes, validateProposal } from '../../../../agent/yeaft/person/contracts.js';
import { createPersonProvider, NATIVE_CONTEXT_UNAVAILABLE_REASON } from '../../../../agent/yeaft/person/provider.js';
import { defaultPersonMinimumRequestBytes } from '../../../../agent/yeaft/person/request-budget.js';
import { createPersonService } from './fixture-adapter.js';
import { config, finalProposal } from './fixtures.js';

const dirs = [], services = [];
const notes = { goal: 'Fix the fixture', findings: [{ summary: 'The fixture uses wall time.', sourceRefs: ['tool:read'] }], nextStep: 'Use trading time.', blocker: '' };
const request = (service, op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
function* tool(index, name, input) {
  yield { type: 'tool_call', id: `tool-${index}`, name, input };
  yield { type: 'stop', stopReason: 'tool_use' };
}
const toolResults = params => params.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
function proposal(version = 0) { const p = finalProposal(version); p.concepts = []; p.state.focusConceptIds = []; p.reply = null; return p; }
async function idle(service) {
  for (let i = 0; i < 300; i++) {
    const snapshot = await request(service, 'snapshot');
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Person did not finish');
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(s => s.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person execution continuity', () => {
  it('validates public sourced working notes without requiring or committing them', () => {
    const validation = { stateVersion: 0, sourceRefs: new Set(['tool:read']), concepts: new Map(), catalog: [] };
    for (const work of [undefined, null, notes]) {
      const p = proposal(); if (work !== undefined) p.work = work;
      expect(validateProposal(p, validation)).toBe(p);
    }
    for (const work of [
      { ...notes, hiddenReasoning: 'no' }, { ...notes, goal: '中'.repeat(334) },
      { ...notes, findings: Array(7).fill(notes.findings[0]) },
      { ...notes, findings: [{ summary: 'guess', sourceRefs: [] }] },
      { ...notes, findings: [{ summary: 'guess', sourceRefs: ['tool:invented'] }] },
      { ...notes, findings: [{ summary: '中'.repeat(201), sourceRefs: ['tool:read'] }] },
    ]) expect(() => validateProposal({ ...proposal(), work }, validation)).toThrow(expect.objectContaining({ code: 'INVALID_PROPOSAL' }));
  });

  it('reports bounded repetitions without preventing legitimate reads or exposing args/output', () => {
    const progress = new ExecutionProgress(); expect(progress.context()).toBeNull();
    for (let i = 0; i < 12; i++) progress.observe(`call-${i}`, { id: 'Bash', args: { command: `read-${i}` } }, { ok: true, output: 'same-secret-output', sourceRef: `tool:${i}` });
    const pattern = progress.context();
    expect(pattern.recent).toHaveLength(8);
    expect(pattern).toMatchObject({ repeatedOutputCount: 8, repeatedRequestCount: 1, review: expect.stringContaining('Never force a write') });
    expect(JSON.stringify(pattern)).not.toContain('same-secret-output'); expect(JSON.stringify(pattern)).not.toContain('read-11');
    progress.observe('changed', { id: 'Bash', args: { command: 'read-11' } }, { ok: true, output: 'new evidence' });
    expect(progress.context()).toMatchObject({ repeatedOutputCount: 1, repeatedRequestCount: 2 });
    progress.observe('failure', { id: 'FileRead', args: {} }, { ok: false, output: 'new evidence' });
    expect(progress.context()).toMatchObject({ repeatedOutputCount: 1, repeatedRequestCount: 1 });
  });

  it('admits working notes as fallible hints, not new evidence, and omits optional context when full', async () => {
    const provider = await createPersonProvider({ config, adapter: {} });
    const input = { provider, selection: provider.defaultSelection,
      snapshot: { person: { id: 'p', soul: 'Honesty.' }, state: { version: 0, summary: 'Old state' }, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'think', text: '' }, previous: { ...proposal(), work: notes } };
    const progress = new ExecutionProgress(); progress.observe('call', { id: 'FileRead', args: {} }, { output: 'text' });
    const context = assembleContext({ ...input, episodeWork: notes, executionPattern: progress.context() });
    expect(JSON.parse(context.messages[0].content).episodeWork).toEqual(notes);
    expect(JSON.parse(context.messages[0].content).previousProposal).not.toHaveProperty('work');
    expect(input.previous.work).toEqual(notes); // The archived proposal is not mutated.
    expect(context.sourceRefs.has('tool:read')).toBe(false);
    expect(context.manifest.contextSources).toMatchObject({ episodeWorkRendered: true, executionPatternRendered: true });
    const baseline = assembleContext(input), body = JSON.parse(baseline.messages[0].content);
    const optionalBytes = bytes({ outputInstructions: body.outputInstructions }) - 1;
    input.snapshot.person.soul += 'x'.repeat(baseline.manifest.contextBudgetBytes - baseline.manifest.contextBytes + optionalBytes);
    const full = assembleContext({ ...input, episodeWork: notes, executionPattern: progress.context() });
    expect(JSON.parse(full.messages[0].content).episodeWork).toBeUndefined();
    expect(full.manifest.contextSources).toMatchObject({ episodeWorkRendered: false, executionPatternRendered: false });
    expect(full.manifest.contextBytes).toBe(full.manifest.contextBudgetBytes);
  });

  it('rejects 32K full-schema readiness and runs a smaller admissible window with one large final cognition', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'person-work-budget-')); dirs.push(dir);
    const smallConfig = { ...config, availableModels: config.availableModels.map(model => ({ ...model, contextWindow: 32768 })) };
    let step = 0, archivedWork;
    const adapter = { async *stream(params) {
      const input = JSON.parse(params.messages[0].content); step++;
      expect(input.previousProposal).toBeNull(); expect(input.episodeWork).toBeUndefined();
      if (params.tools.length) {
        if (step === 1) { yield* tool(step, 'FileRead', { file_path: join(dir, 'evidence.txt') }); return; }
        expect(toolResults(params).at(-1).output).toContain('The fixture uses wall time.');
        yield { type: 'text_delta', text: 'Verified the distinct fixture check.' };
      } else {
        expect(step).toBe(3);
        const result = toolResults(params).at(-1), p = proposal(input.state.version);
        expect(result.output).toContain('The fixture uses wall time.');
        expect(params.messages.some(message => message.role === 'assistant' && message.content === 'Verified the distinct fixture check.')).toBe(true);
        p.activity.summary = 'a'.repeat(1500); p.decision.summary = 'd'.repeat(1000);
        p.decision.selfCheck = 's'.repeat(1000); p.state.summary = 'Finished the distinct check.';
        p.work = { ...notes, findings: Array.from({ length: 6 }, () => ({ summary: '中'.repeat(200), sourceRefs: [result.sourceRef] })) };
        archivedWork = p.work;
        yield { type: 'text_delta', text: JSON.stringify(p) };
      }
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const unavailable = createPersonService({ yeaftDir: dir, workDir: dir, config: smallConfig, nativeFixture: false, adapter, embedding: { enabled: false } }); services.push(unavailable);
    await request(unavailable, 'open');
    expect(await request(unavailable, 'status')).toMatchObject({ modelReady: false, reason: NATIVE_CONTEXT_UNAVAILABLE_REASON });
    await request(unavailable, 'think', { clientMessageId: 'too-small' });
    expect((await idle(unavailable)).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'MODEL_UNAVAILABLE' });
    expect(step).toBe(0);
    await unavailable.close();
    // 80K is genuinely smaller than the normal 100K fixture, but can fit the
    // actual full schemas plus output/envelope and final-cognition reserves.
    const usableConfig = { ...smallConfig, availableModels: smallConfig.availableModels.map(model => ({ ...model, contextWindow: 81920 })) };
    const minimum = await defaultPersonMinimumRequestBytes(usableConfig);
    expect(32768 - 4096 - 1024).toBeLessThan(minimum);
    expect(81920 - 4096 - 1024).toBeGreaterThan(minimum);
    await writeFile(join(dir, 'evidence.txt'), 'The fixture uses wall time.');
    const service = createPersonService({ yeaftDir: dir, workDir: dir, config: usableConfig, nativeFixture: false, adapter, embedding: { enabled: false } }); services.push(service);
    await request(service, 'think', { text: 'x'.repeat(7000), clientMessageId: 'tight-window' });
    const snapshot = await idle(service);
    expect(snapshot.latestEpisode).toMatchObject({ status: 'completed' }); expect(step).toBe(3);
    expect(snapshot.state).not.toHaveProperty('work');
    const traces = (await request(service, 'traces', { limit: 50 })).items;
    const archived = traces.filter(t => t.kind === 'call_output' && t.output?.protocol === 'cognition');
    expect(archived).toHaveLength(1);
    expect(JSON.parse(archived[0].output.text).work).toEqual(archivedWork);
    expect(archivedWork.findings).toHaveLength(6);
  });

  it('keeps real read/edit/check evidence in the continuous transcript and resets execution state for the next episode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'person-execution-progress-')); dirs.push(dir);
    const path = join(dir, 'clock.js');
    const initial = `//${'x'.repeat(12000)}\nconst clock = "wall";\n//${'y'.repeat(12000)}\n`;
    await writeFile(path, initial);
    const finding = 'The clock is wall time; edit this assignment.';
    let step = 0, cognitionCalls = 0, nextCalls = 0, saved, recovery;
    const adapter = { async *stream(params) {
      const input = JSON.parse(params.messages[0].content), results = toolResults(params);
      expect(input.previousProposal).toBeNull();
      expect(input.episodeWork).toBeUndefined(); expect(input.executionPattern).toBeUndefined();
      if (input.state.version === 0) {
        step++;
        if (step === 1) { yield* tool(step, 'FileRead', { file_path: path }); return; }
        if (step === 2) {
          const read = results.at(-1);
          expect(read.truncated).toBe(true); expect(read.output).not.toContain('"wall"');
          recovery = read.recovery.read;
          yield* tool(step, 'Execution__read', { ...recovery.args, offset: 12000 }); return;
        }
        if (step === 3) {
          const recovered = results.at(-1);
          expect(recovered.output).toContain('"wall"');
          expect(recovered.callId).toBe(recovery.args.callId);
          saved = { ...notes, findings: [{ summary: finding, sourceRefs: [recovered.sourceRef] }] };
          yield { type: 'text_delta', text: finding };
          yield* tool(step, 'FileEdit', { file_path: path, old_string: '"wall"', new_string: '"trading"' }); return;
        }
        // No intermediate cognitive state/notes are needed to retain the actual
        // observations, public finding and exact completed edit in this transcript.
        expect(results.find(result => result.id === 'Execution.read').output).toContain('"wall"');
        expect(params.messages.some(message => message.role === 'assistant' && message.content === finding)).toBe(true);
        if (step === 4) {
          expect(results.at(-1).ok).toBe(true);
          yield* tool(step, 'FileRead', { file_path: path, offset: 1, limit: 1 }); return;
        }
        expect(results.at(-1).output).toContain('"trading"');
        expect(results).toHaveLength(4);
        if (params.tools.length) {
          expect(step).toBe(5);
          yield { type: 'text_delta', text: 'Verified the real edit.' };
        } else {
          expect(step).toBe(6); cognitionCalls++;
          const p = proposal(input.state.version); p.state.summary = 'Verified the real edit.'; p.work = saved;
          yield { type: 'text_delta', text: JSON.stringify(p) };
        }
      } else {
        nextCalls++;
        expect(input.state.version).toBe(1); expect(input.state.summary).toBe('Verified the real edit.');
        expect(input.state).not.toHaveProperty('work');
        expect(results).toEqual([]);
        const assistants = params.messages.filter(message => message.role === 'assistant');
        expect(assistants.every(message => !message.toolCalls?.length && message.content === '')).toBe(true);
        if (params.tools.length) expect(assistants).toEqual([]);
        if (!params.tools.length) {
          cognitionCalls++;
          yield { type: 'text_delta', text: JSON.stringify(proposal(input.state.version)) };
        }
      }
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const service = createPersonService({ yeaftDir: dir, workDir: dir, config, nativeFixture: false, adapter, embedding: { enabled: false } }); services.push(service);
    await request(service, 'open'); await request(service, 'think', { text: 'Change wall to trading time in the fixture.', clientMessageId: 'edit' });
    const snapshot = await idle(service);
    expect(snapshot.latestEpisode, `step=${step}; code=${snapshot.latestEpisode.terminalCode}`).toMatchObject({ status: 'completed' });
    expect(snapshot.state.version).toBe(1); expect(snapshot.state).not.toHaveProperty('work');
    expect(step).toBe(6); expect(cognitionCalls).toBe(1);
    expect(await readFile(path, 'utf8')).toBe(initial.replace('"wall"', '"trading"'));
    const traces = (await request(service, 'traces', { limit: 50 })).items;
    const reads = traces.filter(t => t.kind === 'capability_started' && t.capability.id === 'FileRead');
    expect(reads).toHaveLength(2); expect(reads[0].capability.args).toMatchObject({ offset: 1, limit: 1 });
    const raw = traces.find(t => t.kind === 'capability_result' && t.callId === recovery.args.callId);
    expect(raw.result.output).toContain('"wall"'); expect(raw.result.output.length).toBeGreaterThan(24000);
    expect(traces.filter(t => t.kind === 'capability_started' && t.capability.id === 'FileEdit')).toHaveLength(1);
    const cognition = traces.filter(t => t.kind === 'call_output' && t.output.protocol === 'cognition');
    expect(cognition).toHaveLength(1); expect(JSON.parse(cognition[0].output.text).work).toEqual(saved);
    await request(service, 'think', { clientMessageId: 'next' });
    const next = await idle(service);
    expect(next.latestEpisode.status).toBe('completed'); expect(next.state.version).toBe(2);
    expect(nextCalls).toBe(2); expect(cognitionCalls).toBe(2);
  });
});
