import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { assembleContext, executionReceipt } from '../../../../agent/yeaft/person/runtime.js';
import { bytes, PROPOSAL_INSTRUCTIONS, validateProposal } from '../../../../agent/yeaft/person/contracts.js';
import { stateView } from '../../../../agent/yeaft/person/inspection.js';
import { config, finalProposal } from './fixtures.js';

const directories = [], services = [];
const continuation = { goal: 'Check the analysis', nextStep: 'Read the remaining result and compare it', status: 'waiting', condition: 'Task result is available; verify current authorization first' };
const request = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const proposal = version => { const p = finalProposal(version); p.concepts = []; p.state.focusConceptIds = []; p.reply = null; return p; };
const use = (p, id, args = {}) => { p.next = { model: 'test/first', effort: null, reason: 'Advance the existing investigation.', capability: id ? { id, args } : null }; };
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-cognitive-progress-')); directories.push(dir); return dir; }
function create(yeaftDir, handler, more = {}) {
  const adapter = { async *stream(params) {
    const input = JSON.parse(params.messages[0].content);
    const p = await handler(input, proposal(input.state.version), params);
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const service = createPersonService({ yeaftDir, workDir: yeaftDir, config, adapter, embedding: { enabled: false }, ...more });
  services.push(service); return service;
}
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
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person cognitive progress', () => {
  it('accepts optional continuation without making memory executable or requiring busywork', () => {
    const validation = { stateVersion: 0, sourceRefs: new Set(), concepts: new Map(), catalog: [] };
    for (const value of [undefined, null, continuation]) {
      const p = proposal(0);
      if (value !== undefined) p.state.continuation = value;
      expect(validateProposal(p, validation)).toBe(p);
    }
    expect(PROPOSAL_INSTRUCTIONS).toContain('promises are not progress');
    expect(PROPOSAL_INSTRUCTIONS).toContain('No compulsory tools/novelty');
    expect(PROPOSAL_INSTRUCTIONS).toContain('newer cancellation/prohibitions win');
    expect(PROPOSAL_INSTRUCTIONS).toContain('Do not claim you will automatically follow up');
    expect(stateView({ ...proposal(0).state, continuation: { ...continuation, private: 'omit' } }).continuation).toEqual(continuation);
    expect(stateView({ continuation: null }).continuation).toBeNull();
  });

  it.each([
    { ...continuation, status: 'execute' }, { ...continuation, condition: '' },
    { ...continuation, goal: '中'.repeat(334) }, { ...continuation, nextStep: 42 },
    { ...continuation, command: 'not permitted' }, [], 'plan',
  ])('rejects malformed or oversized continuation: %j', value => {
    const p = proposal(0); p.state.continuation = value;
    expect(() => validateProposal(p, { stateVersion: 0, sourceRefs: new Set(), concepts: new Map(), catalog: [] })).toThrow(expect.objectContaining({ code: 'INVALID_PROPOSAL' }));
  });

  it('persists a committed continuation across restart, preserves omission, clears explicitly, and isolates owners', async () => {
    const dir = await directory();
    const first = create(dir, (_input, p) => { p.state.continuation = continuation; return p; });
    await request(first, 'open'); await request(first, 'think', { clientMessageId: 'accept' });
    expect((await idle(first)).state.continuation).toEqual(continuation);
    await first.close();
    const seen = [];
    const second = create(dir, (input, p) => {
      seen.push(input);
      if (input.trigger.text === 'clear') p.state.continuation = null;
      return p;
    });
    await request(second, 'think', { clientMessageId: 'carry' });
    expect((await idle(second)).state.continuation).toEqual(continuation);
    expect(seen[0].state.continuation).toEqual(continuation);
    expect(seen[0].previousProposal).toBeNull();
    expect(seen[0].episodeProgress).toBeUndefined();
    await request(second, 'open', {}, 'bob');
    expect((await request(second, 'snapshot', {}, 'bob')).state).not.toHaveProperty('continuation');
    await request(second, 'think', { clientMessageId: 'clear', text: 'clear' });
    expect((await idle(second)).state.continuation).toBeNull();
    await request(second, 'think', { clientMessageId: 'after-clear' });
    expect((await idle(second)).state.continuation).toBeNull();
    expect(seen[2].state.continuation).toBeNull();
  });

  it.each(['failure', 'cancel'])('does not commit a candidate continuation after %s', async terminal => {
    const dir = await directory();
    const initial = create(dir, (_input, p) => { p.state.continuation = continuation; return p; });
    await request(initial, 'open'); await request(initial, 'think', { clientMessageId: 'initial' });
    await idle(initial); await initial.close();
    let entered;
    const gate = new Promise(resolve => { entered = resolve; });
    const service = create(dir, async (input, p, params) => {
      p.state.continuation = { ...continuation, nextStep: 'Candidate must not survive' };
      if (!input.previousProposal) { use(p, null); return p; }
      entered();
      if (terminal === 'failure') throw new Error('provider failed');
      if (terminal === 'cancel') await new Promise((resolve, reject) => {
        if (params.signal.aborted) reject(params.signal.reason);
        else params.signal.addEventListener('abort', () => reject(params.signal.reason), { once: true });
      });
      return p;
    });
    await request(service, 'think', { clientMessageId: terminal });
    if (terminal === 'cancel') { await gate; await request(service, 'cancel'); }
    const snapshot = await idle(service);
    expect(snapshot.latestEpisode.status).toBe({ failure: 'failed', cancel: 'cancelled' }[terminal]);
    expect(snapshot.state.continuation).toEqual(continuation);
    expect(snapshot.state.version).toBe(1);
  });

  it('carries real multi-tool results through a cognitive check to an artifact and reusable finding', async () => {
    const dir = await directory(), seen = [];
    await writeFile(join(dir, 'alpha.txt'), 'alpha: 3'); await writeFile(join(dir, 'beta.txt'), 'beta: 7');
    const service = create(dir, (input, p) => {
      seen.push(input);
      const step = seen.length;
      if (step === 1) use(p, 'catalog.view', { id: 'FileRead' });
      if (step === 2) use(p, 'FileRead', { file_path: join(dir, 'alpha.txt') });
      if (step === 3) {
        expect(input.episodeProgress).toBeUndefined(); // Current result is not duplicated.
        expect(input.capabilityResult.output).toContain('alpha: 3');
        use(p, 'FileRead', { file_path: join(dir, 'beta.txt') });
      }
      if (step === 4) {
        expect(input.episodeProgress.items).toHaveLength(1);
        expect(input.episodeProgress.items[0].preview).toContain('alpha: 3');
        expect(input.capabilityResult.output).toContain('beta: 7');
        use(p, null); // A genuinely different check does not erase execution evidence.
      }
      if (step === 5) {
        expect(input.capabilityResult).toBeNull();
        expect(input.episodeProgress.items.map(item => item.capability)).toEqual(['FileRead', 'FileRead']);
        use(p, 'catalog.view', { id: 'FileWrite' });
      }
      if (step === 6) {
        const receipts = input.episodeProgress.items;
        expect(receipts[0].preview).toContain('alpha: 3'); expect(receipts[1].preview).toContain('beta: 7');
        use(p, 'FileWrite', { file_path: join(dir, 'finding.md'), content: 'Total: 10; compare both independent inputs before aggregating.' });
      }
      if (step === 7) {
        expect(input.capabilityResult.ok).toBe(true);
        p.concepts = [{ id: 'cross-check', expectedRevision: 0, kind: 'method', statement: 'Compare independent inputs before aggregation; retain their provenance.', epistemicState: 'hypothesis', sourceRefs: input.episodeProgress.items.map(item => item.sourceRef), associations: [] }];
        p.state.focusConceptIds = ['cross-check']; p.state.continuation = null;
        p.activity.summary = 'Compared two results and saved a reusable validation method.';
      }
      return p;
    });
    await request(service, 'open');
    await request(service, 'think', { text: 'Compare the fixture inputs and save a finding.', clientMessageId: 'integrate' });
    expect((await idle(service)).latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(7);
    expect(await readFile(join(dir, 'finding.md'), 'utf8')).toContain('Total: 10');
    expect((await request(service, 'inspect', { section: 'memory' })).items[0].id).toBe('cross-check');
    const traces = (await request(service, 'traces', { limit: 50 })).items;
    const last = traces.filter(t => t.kind === 'call_started').at(0);
    expect(last.manifest.contextSources.episodeExecutions).toBe(2);
    expect(last.manifest.renderedSourceRefs).toEqual(expect.arrayContaining(seen[6].episodeProgress.items.map(item => item.sourceRef)));
  });

  it('allows Dream to distill a hypothesis privately and then rest without redundant concepts or tools', async () => {
    const seen = [];
    const service = create(await directory(), (input, p) => {
      seen.push(input);
      if (input.state.version === 0 && !input.previousProposal) { use(p, null); return p; }
      if (input.state.version === 0) {
        p.activity.kind = 'associate';
        p.activity.summary = 'Turned an analogy into a falsifiable question.';
        p.concepts = [{ id: 'queue-hypothesis', expectedRevision: 0, kind: 'question', statement: 'Could arrival variance, not average volume, explain the queue? Compare equal-volume windows.', epistemicState: 'hypothesis', sourceRefs: [input.trigger.ref], associations: [] }];
        p.state.focusConceptIds = ['queue-hypothesis'];
      } else { p.activity.kind = 'rest'; p.activity.summary = 'No new evidence warrants a revision.'; }
      return p;
    });
    await request(service, 'open'); await request(service, 'dream', { clientMessageId: 'derive' });
    expect((await idle(service)).latestEpisode.status).toBe('completed');
    await request(service, 'dream', { clientMessageId: 'rest' }); await idle(service);
    expect(seen).toHaveLength(3);
    expect((await request(service, 'messages')).items).toHaveLength(0);
    const concepts = (await request(service, 'inspect', { section: 'memory' })).items;
    expect(concepts).toHaveLength(1); expect(concepts[0].revision).toBe(1);
  });

  it('bounds JSON/Unicode receipts, retains failure semantics and admits history without displacing mandatory results', async () => {
    const raw = { ok: false, output: '\u0000中文😀'.repeat(4000), code: 'TOOL_FAILED', errorEffect: 'unknown', replaySafe: false, outputAvailability: 'captured', sourceRef: 'tool:earlier' };
    const receipt = executionReceipt('call', 'FileWrite', raw);
    expect(bytes(receipt)).toBeLessThanOrEqual(4096);
    expect(receipt).toMatchObject({ ok: false, code: 'TOOL_FAILED', errorEffect: 'unknown', replaySafe: false, truncated: true });
    expect(receipt.preview).not.toContain('\ufffd'); expect(raw.output.length).toBeGreaterThan(receipt.preview.length);
    const provider = await createPersonProvider({ config, adapter: {} });
    const input = { provider, selection: provider.defaultSelection, remainingCalls: 1,
      snapshot: { person: { id: 'p', soul: 'Honesty.' }, state: { version: 0 }, messages: [], concepts: [] },
      episode: { id: 'e', kind: 'think', text: '' }, capabilityResult: { ok: true, sourceRef: 'tool:current', output: 'Current result' },
      dependencyRefs: ['tool:earlier'] };
    const episodeProgress = Array.from({ length: 10 }, (_, i) => ({ ...receipt, callId: String(i) }));
    const assembled = assembleContext({ ...input, episodeProgress });
    const body = JSON.parse(assembled.messages[0].content);
    expect(bytes(body.episodeProgress)).toBeLessThanOrEqual(8192);
    expect(body.episodeProgress.omitted).toBeGreaterThan(0);
    expect(body.episodeProgress.items.at(-1).callId).toBe('9');
    expect(body.capabilityResult).toEqual(input.capabilityResult);
    expect(assembled.sourceRefs.has('tool:earlier')).toBe(true);
    expect(assembled.sources.get('tool:current').reportedSourceRefs).toEqual([]);
    const baseline = assembleContext(input);
    input.snapshot.person.soul += 'x'.repeat(baseline.manifest.contextBudgetBytes - baseline.manifest.contextBytes);
    const full = assembleContext({ ...input, episodeProgress });
    expect(JSON.parse(full.messages[0].content).episodeProgress).toBeUndefined();
    expect(full.manifest.contextSources.omittedEpisodeExecutions).toBe(10);
  });
});
