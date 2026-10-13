import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config, finalProposal } from './fixtures.js';

const services = [], directories = [];
const adapterErrors = new WeakMap();
const request = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const definition = () => ({ id: 'Script.sum', expectedVersion: 0, description: 'Sum a list of numbers 求和', useWhen: 'Compute a total of supplied finite numbers.', avoidWhen: 'Not for arbitrary-precision financial amounts.', inputDescription: 'Array of finite numbers.', outputDescription: 'Sum, or zero for an empty list.', code: 'return input.reduce((sum, value) => sum + value, 0);', tests: [{ input: [2, 3], expected: 5 }, { input: [], expected: 0 }] });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-created-')); directories.push(dir); return dir; }
function create(yeaftDir, fn) {
  const errors = [];
  const adapter = { async *stream(params) {
    const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
    try { await fn(input, p); }
    catch (error) { errors.push({ stack: error.stack, actual: error.actual, expected: error.expected, capabilityResult: input.capabilityResult }); throw error; }
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const service = createPersonService({ yeaftDir, config, adapter, embedding: { enabled: false } });
  adapterErrors.set(service, errors);
  services.push(service); return service;
}
const use = (p, id, args = {}) => { p.next = { model: 'test/first', effort: null, reason: 'Build or reuse a tested method.', capability: { id, args } }; };
async function idle(service, owner = 'alice') {
  for (let i = 0; i < 500; i++) {
    const snapshot = await request(service, 'snapshot', {}, owner);
    if (!snapshot.busy) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('activity did not finish');
}
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person creates, tests, persists and reuses abilities', () => {
  it('publishes only after real tests, invokes a new input and restores familiarity after restart without recoding', async () => {
    const dir = await directory(), seen = [];
    const first = create(dir, (input, p) => {
      seen.push(input);
      if (!input.capabilityResult) {
        expect(input.capabilities.active.find(c => c.id === 'Capability.create').availability.layer).toBe('foundation');
        use(p, 'Capability.create', definition());
      } else if (input.capabilityResult.published) {
        expect(input.capabilityResult.evidence).toMatchObject({ engine: 'quickjs', testsPassed: 2 });
        expect(input.capabilities.active.find(c => c.id === 'Script.sum')).toMatchObject({ access: 'pure-computation', version: 1 });
        use(p, 'Script.sum', { input: [10, 30, -2] });
      } else {
        expect(input.capabilityResult).toMatchObject({ ok: true, output: 38, version: 1 });
        p.reply = '38';
      }
    });
    await request(first, 'open');
    await request(first, 'send', { text: 'Create a reusable sum method and total [10,30,-2].', clientMessageId: 'learn' });
    expect((await idle(first)).latestEpisode.status).toBe('completed');
    expect(seen).toHaveLength(3);
    const traces = (await request(first, 'traces', { limit: 50 })).items;
    expect(traces.find(t => t.kind === 'capability_created')).toBeDefined();
    await first.close();

    const restored = [];
    const second = create(dir, (input, p) => {
      restored.push(input);
      if (input.trigger.text === 'other-person') {
        expect(input.capabilities.active.some(c => c.id === 'Script.sum')).toBe(false);
        if (!input.capabilityResult) use(p, 'catalog.search', { query: 'Script.sum' });
        else expect(input.capabilityResult.items).toEqual([]);
      } else if (!input.capabilityResult) {
        expect(input.capabilities.active.find(c => c.id === 'Script.sum').availability.layer).toBe('familiar');
        use(p, 'Script.sum', { input: [9, 6] });
      } else expect(input.capabilityResult.output).toBe(15);
    });
    await request(second, 'think', { text: 'reuse', clientMessageId: 'reuse' });
    expect((await idle(second)).latestEpisode.status).toBe('completed');
    expect(restored).toHaveLength(2);
    await request(second, 'open', {}, 'bob');
    await request(second, 'think', { text: 'other-person', clientMessageId: 'bob' }, 'bob');
    expect((await idle(second, 'bob')).latestEpisode.status).toBe('completed');
  });

  it('returns failed-test diagnostics for repair without publishing the bad script', async () => {
    const dir = await directory(); let calls = 0;
    const service = create(dir, (input, p) => {
      calls++;
      if (calls === 1) use(p, 'Capability.create', { ...definition(), code: 'return 0;' });
      else if (calls === 2) {
        expect(input.capabilityResult).toMatchObject({ ok: false, code: 'SCRIPT_TEST_FAILED', failedTest: 0, actual: 0 });
        expect(input.capabilities.active.some(c => c.id === 'Script.sum')).toBe(false);
        use(p, 'Capability.create', definition());
      } else expect(input.capabilityResult).toMatchObject({ ok: true, published: true, contract: { version: 1 } });
    });
    await request(service, 'open');
    await request(service, 'think', { text: 'learn', clientMessageId: 'repair' });
    const snapshot = await idle(service);
    const traces = (await request(service, 'traces', { limit: 50 })).items;
    expect(snapshot.latestEpisode.status, JSON.stringify({ episode: snapshot.latestEpisode, adapterErrors: adapterErrors.get(service), traces: traces.map(({ request, ...trace }) => trace) }, null, 2)).toBe('completed');
    expect(traces.filter(t => t.kind === 'capability_created')).toHaveLength(1);
    expect(traces.find(t => t.kind === 'capability_failed')).toMatchObject({ code: 'SCRIPT_TEST_FAILED' });
  });
});
