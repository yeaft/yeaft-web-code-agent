import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionProgress } from '../../../../agent/yeaft/person/execution-progress.js';
import { assembleContext } from '../../../../agent/yeaft/person/runtime.js';
import { bytes, validateProposal } from '../../../../agent/yeaft/person/contracts.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config, finalProposal } from './fixtures.js';

const dirs = [], services = [];
const notes = { goal: 'Fix the fixture', findings: [{ summary: 'The fixture uses wall time.', sourceRefs: ['tool:read'] }], nextStep: 'Use trading time.', blocker: '' };
const request = (service, op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
const use = (p, id, args = {}) => { p.next = { model: 'test/first', effort: null, reason: 'Use verified evidence.', capability: id ? { id, args } : null }; };
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
      episode: { id: 'e', kind: 'think', text: '' } };
    const progress = new ExecutionProgress(); progress.observe('call', { id: 'FileRead', args: {} }, { output: 'text' });
    const context = assembleContext({ ...input, episodeWork: notes, executionPattern: progress.context() });
    expect(JSON.parse(context.messages[0].content).episodeWork).toEqual(notes);
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

  it('keeps findings across cognition/catalog steps, performs a real edit/check, then clears notes for the next episode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'person-execution-progress-')); dirs.push(dir);
    const path = join(dir, 'clock.js');
    const initial = `//${'x'.repeat(12000)}\nconst clock = "wall";\n//${'y'.repeat(12000)}\n`;
    await writeFile(path, initial);
    const seen = []; let step = 0, saved, recovery;
    const adapter = { async *stream(params) {
      const input = JSON.parse(params.messages[0].content), p = proposal(input.state.version); seen.push(input);
      if (input.state.version === 0) {
        step++;
        if (step === 1) use(p, 'catalog.view', { id: 'FileRead' });
        if (step === 2) use(p, 'FileRead', { file_path: path });
        if (step === 3) {
          expect(input.capabilityResult.truncated).toBe(true);
          expect(input.capabilityResult.output).not.toContain('"wall"');
          recovery = input.capabilityResult.recovery.read;
          use(p, 'catalog.view', { id: 'Execution.read' });
        }
        if (step === 4) use(p, recovery.id, { ...recovery.args, offset: 12000 });
        if (step === 5) {
          expect(input.capabilityResult.output).toContain('"wall"');
          saved = { ...notes, findings: [{ summary: 'The clock is wall time; edit this assignment.', sourceRefs: [input.capabilityResult.sourceRef] }] };
          p.work = saved; use(p, null);
        }
        if (step === 6) { expect(input.episodeWork).toEqual(saved); use(p, 'catalog.view', { id: 'FileEdit' }); }
        if (step === 7) {
          expect(input.previousProposal).not.toHaveProperty('work'); expect(input.episodeWork).toEqual(saved);
          use(p, 'FileEdit', { file_path: path, old_string: '"wall"', new_string: '"trading"' });
        }
        if (step === 8) {
          expect(input.capabilityResult.ok).toBe(true); expect(input.episodeWork).toEqual(saved);
          // The FileEdit contract can evict FileRead; reload instead of bypassing eligibility.
          use(p, 'catalog.view', { id: 'FileRead' });
        }
        if (step === 9) use(p, 'FileRead', { file_path: path, offset: 1, limit: 1 });
        if (step === 10) {
          expect(input.capabilityResult.output).toContain('"trading"'); p.work = null; use(p, null);
        }
        if (step === 11) { expect(input.episodeWork).toBeUndefined(); p.state.summary = 'Verified the real edit.'; }
      } else { expect(input.episodeWork).toBeUndefined(); expect(input.executionPattern).toBeUndefined(); }
      yield { type: 'text_delta', text: JSON.stringify(p) }; yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } }); services.push(service);
    await request(service, 'open'); await request(service, 'think', { text: 'Change wall to trading time in the fixture.', clientMessageId: 'edit' });
    const snapshot = await idle(service);
    expect(snapshot.latestEpisode, `step=${step}; code=${snapshot.latestEpisode.terminalCode}`).toMatchObject({ status: 'completed' }); expect(snapshot.state).not.toHaveProperty('work');
    expect(await readFile(path, 'utf8')).toBe(initial.replace('"wall"', '"trading"'));
    expect(seen[7].executionPattern.recent.map(item => item.capability)).toEqual(['FileRead', 'Execution.read', 'FileEdit']);
    const traces = (await request(service, 'traces', { limit: 50 })).items;
    const reads = traces.filter(t => t.kind === 'capability_started' && t.capability.id === 'FileRead');
    expect(reads).toHaveLength(2); expect(reads[0].capability.args).toMatchObject({ offset: 1, limit: 1 });
    await request(service, 'think', { clientMessageId: 'next' }); expect((await idle(service)).latestEpisode.status).toBe('completed');
  });
});
