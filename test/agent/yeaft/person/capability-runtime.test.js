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
  });
});
