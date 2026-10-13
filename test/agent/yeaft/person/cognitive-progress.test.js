import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';

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
});
