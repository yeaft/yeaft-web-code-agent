import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config, finalProposal } from './fixtures.js';
import { projectPersonConversation } from '../../../../web/utils/person-conversation.js';

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

describe('Person presentation runtime', () => {
  const rich = { title: 'Verified counts', summary: 'Alpha has 2; Beta has 3.', phase: 'final', blocks: [
    { type: 'metrics', items: [{ label: 'Alpha', value: '2' }, { label: 'Beta', value: '3' }] },
  ] };
  const services = [], directories = [];
  const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
  function use(proposal, id, args = {}) { proposal.next = { model: 'test/first', effort: null, reason: 'Deliver verified findings and then integrate.', capability: { id, args } }; }
  async function create(fn) {
    const directory = await mkdtemp(join(tmpdir(), 'person-rich-runtime-')); directories.push(directory);
    const seen = [], adapter = { async *stream(params) {
      const input = JSON.parse(params.messages[0].content), proposal = finalProposal(input.state.version);
      proposal.concepts = []; proposal.state.focusConceptIds = []; proposal.reply = null;
      seen.push(input);
      await fn(input, proposal, seen.length, params.signal);
      yield { type: 'text_delta', text: JSON.stringify(proposal) };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const service = createPersonService({ yeaftDir: directory, config, adapter, embedding: { enabled: false } });
    services.push(service); await call(service, 'open'); return { service, seen, directory };
  }
  async function idle(service) {
    for (let i = 0; i < 200; i++) {
      const snapshot = await call(service, 'snapshot');
      if (!snapshot.busy) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Episode did not finish');
  }
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.close()));
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  describe('Person rich communication through real provider, runtime and projection', () => {
    it('publishes once, commits only on later next:null and keeps a distinct plain reply in the same episode', async () => {
      const { service, seen } = await create((input, proposal, index) => {
        if (index === 1) use(proposal, 'catalog.view', { id: 'PresentResponse' });
        else if (index === 2) {
          expect(input.capabilities.active.find(item => item.id === 'PresentResponse').args.properties.blocks).toBeTruthy();
          use(proposal, 'PresentResponse', rich); proposal.reply = rich.summary;
          proposal.state.summary = 'Candidate only, not committed during delivery.';
        } else if (index === 3) {
          expect(input.capabilityResult).toMatchObject({ published: true, phase: 'final' });
          expect(input.state.version).toBe(0);
          expect(input.feedback.lastReply).toBe(rich.summary);
          use(proposal, 'PresentResponse', rich); // Repeated model delivery is also idempotent.
        } else proposal.reply = 'A separate plain conclusion.';
      });
      await call(service, 'send', { text: 'Compare Alpha and Beta', clientMessageId: 'rich-plain' });
      const snapshot = await idle(service);
      expect(snapshot).toMatchObject({ state: { version: 1 }, latestEpisode: { status: 'completed' } });
      expect(snapshot.messages.filter(m => m.role === 'assistant').map(m => m.text)).toEqual([rich.summary, 'A separate plain conclusion.']);
      const blocks = projectPersonConversation(snapshot.messages);
      expect(blocks.at(-1).parts).toHaveLength(2);
      expect(blocks.at(-1).parts[0].presentation.title).toBe(rich.title);
      expect(blocks.at(-1).parts[1]).not.toHaveProperty('presentation');
      expect(seen).toHaveLength(4);
    });

    it('suppresses a repeated terminal plain summary without suppressing the cognitive commit', async () => {
      const { service } = await create((input, proposal, index) => {
        if (index === 1) use(proposal, 'catalog.view', { id: 'PresentResponse' });
        else if (index === 2) use(proposal, 'PresentResponse', rich);
        else proposal.reply = rich.summary;
      });
      await call(service, 'send', { text: 'Compare counts', clientMessageId: 'summary-once' });
      const snapshot = await idle(service);
      expect(snapshot.state.version).toBe(1);
      expect(snapshot.messages.filter(m => m.role === 'assistant')).toHaveLength(1);
      expect((await call(service, 'traces', { limit: 50 })).items.filter(t => t.kind === 'committed')).toHaveLength(1);
    });

    it.each(['cancel', 'failure'])('retains final-intent rich communication without committing cognition on later %s', async outcome => {
      let ready; const waiting = new Promise(resolve => { ready = resolve; });
      const { service, directory } = await create(async (input, proposal, index, signal) => {
        if (index === 1) use(proposal, 'catalog.view', { id: 'PresentResponse' });
        else if (index === 2) use(proposal, 'PresentResponse', rich);
        else {
          ready();
          if (outcome === 'failure') throw new Error('provider failure after communication');
          await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
        }
      });
      const command = await call(service, 'send', { text: 'Compare counts', clientMessageId: `partial-${outcome}` });
      await waiting;
      if (outcome === 'cancel') {
        expect(await call(service, 'snapshot')).toMatchObject({ busy: true, state: { version: 0 }, latestEpisode: { status: 'running' } });
        await call(service, 'cancel', { episodeId: command.episodeId });
      }
      const snapshot = await idle(service);
      expect(snapshot.latestEpisode.status).toBe(outcome === 'cancel' ? 'cancelled' : 'failed');
      expect(snapshot.state.version).toBe(0);
      expect(snapshot.messages.at(-1)).toMatchObject({ text: rich.summary, presentation: { phase: 'final' } });
      await service.close();
      const reopened = createPersonService({ yeaftDir: directory, embedding: { enabled: false } }); services.push(reopened);
      expect((await call(reopened, 'snapshot')).messages).toEqual(snapshot.messages);
      expect((await call(reopened, 'messages')).items[0].presentation.title).toBe(rich.title);
      expect((await call(reopened, 'search', { query: 'Alpha' })).items.some(m => m.presentation?.title === rich.title)).toBe(true);
      await call(reopened, 'open', {}, 'bob');
      expect((await call(reopened, 'snapshot', {}, 'bob')).messages).toEqual([]);
    });

    it('invalid rich arguments publish nothing and allow the ordinary plain reply path', async () => {
      const { service } = await create((input, proposal, index) => {
        if (index === 1) use(proposal, 'catalog.view', { id: 'PresentResponse' });
        else if (index === 2) use(proposal, 'PresentResponse', { ...rich, blocks: [{ type: 'script', text: 'alert(1)' }] });
        else {
          expect(input.capabilityResult).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
          proposal.reply = 'Alpha has 2; Beta has 3. Plain answer.';
        }
      });
      await call(service, 'send', { text: 'Compare counts', clientMessageId: 'invalid-rich' });
      const snapshot = await idle(service);
      expect(snapshot.latestEpisode.status).toBe('completed');
      expect(snapshot.messages.at(-1)).toMatchObject({ replyKind: 'final', text: 'Alpha has 2; Beta has 3. Plain answer.' });
      expect(snapshot.messages.at(-1)).not.toHaveProperty('presentation');
      expect((await call(service, 'traces', { limit: 50 })).items.filter(t => t.kind === 'presentation_published')).toHaveLength(0);
    });
  });
});
