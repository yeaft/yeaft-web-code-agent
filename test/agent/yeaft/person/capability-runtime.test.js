import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config, finalProposal } from './fixtures.js';

const services = [], directories = [];
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-capability-runtime-')); directories.push(dir); return dir; }
function create(yeaftDir, fn) {
  const adapter = { async *stream(params) {
    const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
    fn(input, p);
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const service = createPersonService({ yeaftDir, config, adapter, embedding: { enabled: false } });
  services.push(service); return service;
}
function use(p, id, args = {}) { p.next = { model: 'test/first', effort: null, reason: 'Use the appropriate prepared ability.', capability: { id, args } }; }
async function idle(service, owner = 'alice') {
  for (let i = 0; i < 200; i++) {
    const snapshot = await call(service, 'snapshot', {}, owner);
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('activity did not finish');
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person capability lifecycle', () => {
  it.each(['send', 'think', 'dream'])('%s can recall directly and finish in exactly two cognitive calls', async kind => {
    const seen = [];
    const service = create(await directory(), (input, p) => {
      seen.push(input);
      expect(input.capabilities.active.find(m => m.id === 'Recall')).toMatchObject({ availability: { layer: 'foundation' } });
      if (!input.capabilityResult) use(p, 'Recall', { kind: 'messages' });
    });
    await call(service, 'open');
    await call(service, kind, { ...(kind === 'dream' ? {} : { text: 'Remember my earlier words.' }), clientMessageId: `direct-${kind}` });
    expect((await idle(service)).latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(2);
    const traces = (await call(service, 'traces', { limit: 50 })).items;
    expect(traces.filter(t => t.kind === 'capability_started').map(t => t.capability.id)).toEqual(['Recall']);
    expect(traces.filter(t => t.kind === 'call_started')).toHaveLength(2);
    expect(traces.find(t => t.kind === 'capability_result').capabilityManifest).toMatchObject({ id: 'Recall', version: 1, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('discovers then uses, restores actual familiarity after restart, and demotes a failed habit', async () => {
    const dir = await directory(), initial = [];
    const first = create(dir, (input, p) => {
      initial.push(input);
      if (!input.capabilityResult) use(p, 'catalog.search', { query: '联想' });
      else if (input.capabilityResult.contracts) use(p, 'Skill.associate');
    });
    await call(first, 'open');
    await call(first, 'dream', { clientMessageId: 'discover' });
    expect((await idle(first)).latestEpisode.status).toBe('completed');
    expect(initial).toHaveLength(3);
    expect(initial[1].capabilities.active.find(c => c.id === 'Skill.associate').availability.layer).toBe('discovered');
    await first.close();

    const restored = [];
    const second = create(dir, (input, p) => {
      restored.push(input);
      if (!input.capabilityResult) use(p, 'Skill.associate', input.trigger.text === 'fail' ? { forbidden: true } : {});
    });
    await call(second, 'open');
    await call(second, 'dream', { clientMessageId: 'reuse' });
    expect((await idle(second)).latestEpisode.status).toBe('completed');
    expect(restored).toHaveLength(2);
    expect(restored[0].capabilities.active.find(c => c.id === 'Skill.associate')).toMatchObject({ availability: { layer: 'familiar', experience: { usefulness: 'not-evaluated', observedSuccesses: 1 } } });
    await call(second, 'think', { text: 'fail', clientMessageId: 'fail-use' });
    expect((await idle(second)).latestEpisode.status).toBe('failed');
    await second.close();

    const afterFailure = [];
    const third = create(dir, input => afterFailure.push(input));
    await call(third, 'open');
    await call(third, 'dream', { clientMessageId: 'check-demoted' });
    expect((await idle(third)).latestEpisode.status).toBe('completed');
    expect(afterFailure[0].capabilities.active.map(c => c.id)).toEqual(['Think', 'Recall', 'Capability.create']);
    await call(third, 'open', {}, 'bob');
    await call(third, 'dream', { clientMessageId: 'bob' }, 'bob');
    await idle(third, 'bob');
    expect(afterFailure[1].capabilities.active.map(c => c.id)).toEqual(['Think', 'Recall', 'Capability.create']);
  });

  it('allows ignoring a familiar method and resting after a technically successful but unhelpful recall', async () => {
    const dir = await directory();
    const train = create(dir, (input, p) => {
      if (!input.capabilityResult) use(p, 'catalog.search', { query: '联想' });
      else if (input.capabilityResult.contracts) use(p, 'Skill.associate');
    });
    await call(train, 'open');
    await call(train, 'dream', { clientMessageId: 'learn-method' });
    expect((await idle(train)).latestEpisode.status).toBe('completed');
    await train.close();

    const seen = [];
    const service = create(dir, (input, p) => {
      seen.push(input);
      expect(input.capabilities.active.find(m => m.id === 'Skill.associate').availability.layer).toBe('familiar');
      if (!input.capabilityResult) use(p, 'Recall', { kind: 'concepts', query: 'missing-experience' });
      else {
        expect(input.capabilityResult.items).toEqual([]);
        p.activity.kind = 'rest'; p.reply = null;
        p.decision.selfCheck = 'Recall executed, but no evidence supports a conclusion; association would not fill this gap.';
        p.decision.uncertainties = ['No relevant prior concept was found.'];
      }
    });
    await call(service, 'think', { text: 'Check whether there is evidence, not just an association.', clientMessageId: 'ignore-habit' });
    const snapshot = await idle(service);
    expect(snapshot.latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(2);
    const traces = (await call(service, 'traces', { limit: 50 })).items.filter(t => t.episodeId === snapshot.latestEpisode.id);
    expect(traces.filter(t => t.kind === 'capability_started').map(t => t.capability.id)).toEqual(['Recall']);
    expect(traces.find(t => t.kind === 'capability_result')).toBeDefined();
    expect(traces.find(t => t.kind === 'activity' && t.activity.kind === 'rest').decision.selfCheck).toContain('no evidence');
    expect(seen[1].capabilities.active.find(m => m.id === 'Skill.associate').availability.experience).toMatchObject({ observedSuccesses: 1, usefulness: 'not-evaluated' });
  });

  it('records a rejected unprepared invocation without manufacturing experience', async () => {
    const dir = await directory();
    const service = create(dir, (_input, p) => use(p, 'Skill.reconsider'));
    await call(service, 'open');
    await call(service, 'think', { text: '', clientMessageId: 'unprepared' });
    expect((await idle(service)).latestEpisode.status).toBe('failed');
    const traces = (await call(service, 'traces', { limit: 50 })).items;
    const failure = traces.find(t => t.kind === 'capability_failed');
    expect(failure).toMatchObject({ capabilityId: 'Skill.reconsider', code: 'UNSUPPORTED' });
    expect(failure).not.toHaveProperty('capabilityManifest');
    await service.close();
    const seen = [];
    const next = create(dir, input => seen.push(input));
    await call(next, 'think', { text: '', clientMessageId: 'after-rejection' });
    expect((await idle(next)).latestEpisode.status).toBe('completed');
    expect(seen[0].capabilities.active.map(c => c.id)).toEqual(['Think', 'Recall', 'Capability.create']);
  });

  it('does not turn inspection into experience or require any prepared ability to be used', async () => {
    const dir = await directory();
    const service = create(dir, (input, p) => {
      if (!input.capabilityResult) use(p, 'catalog.view', { id: 'Skill.reconsider' });
    });
    await call(service, 'open');
    await call(service, 'think', { text: '', clientMessageId: 'inspect-only' });
    expect((await idle(service)).latestEpisode.status).toBe('completed');
    await service.close();
    const seen = [];
    const next = create(dir, input => seen.push(input));
    await call(next, 'open');
    await call(next, 'think', { text: '', clientMessageId: 'simply-rest' });
    expect((await idle(next)).latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0].capabilities.active.map(c => c.id)).toEqual(['Think', 'Recall', 'Capability.create']);
    const traces = (await call(next, 'traces', { limit: 50 })).items;
    const episodeId = (await call(next, 'snapshot')).latestEpisode.id;
    expect(traces.filter(t => t.episodeId === episodeId && t.kind === 'capability_started')).toEqual([]);
  });
});
