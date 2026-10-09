import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config, finalProposal } from './fixtures.js';

const services = [], directories = [];
const request = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
const definition = () => ({ id: 'Script.sum', expectedVersion: 0, description: 'Sum a list of numbers 求和', useWhen: 'Compute a total of supplied finite numbers.', avoidWhen: 'Not for arbitrary-precision financial amounts.', inputDescription: 'Array of finite numbers.', outputDescription: 'Sum, or zero for an empty list.', code: 'return input.reduce((sum, value) => sum + value, 0);', tests: [{ input: [2, 3], expected: 5 }, { input: [], expected: 0 }] });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'person-created-')); directories.push(dir); return dir; }
function create(yeaftDir, fn) {
  const adapter = { async *stream(params) {
    const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
    p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref];
    await fn(input, p);
    yield { type: 'text_delta', text: JSON.stringify(p) };
    yield { type: 'stop', stopReason: 'end_turn' };
  } };
  const service = createPersonService({ yeaftDir, config, adapter, embedding: { enabled: false } });
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
    expect((await idle(service)).latestEpisode.status).toBe('completed');
    const traces = (await request(service, 'traces', { limit: 50 })).items;
    expect(traces.filter(t => t.kind === 'capability_created')).toHaveLength(1);
    expect(traces.find(t => t.kind === 'capability_failed')).toMatchObject({ code: 'SCRIPT_TEST_FAILED' });
  });

  it('keeps an already published ability when a later model call fails, without committing cognition', async () => {
    const dir = await directory();
    const first = create(dir, (input, p) => {
      if (!input.capabilityResult) use(p, 'Capability.create', definition());
      else throw new Error('simulated provider failure after publication');
    });
    await request(first, 'open');
    await request(first, 'think', { text: 'learn', clientMessageId: 'fail-after-publish' });
    const snapshot = await idle(first);
    expect(snapshot.latestEpisode.status).toBe('failed');
    const traces = (await request(first, 'traces', { limit: 50 })).items;
    expect(traces.filter(t => t.kind === 'capability_created')).toHaveLength(1);
    expect(traces.some(t => t.kind === 'committed')).toBe(false);
    await first.close();
    const second = create(dir, (input, p) => {
      if (!input.capabilityResult) use(p, 'catalog.view', { id: 'Script.sum' });
      else expect(input.capabilityResult.definition).toMatchObject({ version: 1, code: definition().code });
    });
    await request(second, 'think', { text: 'inspect saved work', clientMessageId: 'inspect' });
    expect((await idle(second)).latestEpisode.status).toBe('completed');
  });

  it('SQLite preserves arbitrary JSON through creation, invocation, persisted traces and inspection', async () => {
    const dir = await directory();
    const payload = JSON.parse(String.raw`{"\u0000":"value","createdAt":"not a date","updatedAt":"2026-10-01","__proto__":{"endedAt":"unchanged"},"nested":[null,{"leaseUntil":"tomorrow"}]}`);
    const echo = { ...definition(), id: 'Script.echo', code: 'return input;', tests: [{ input: payload, expected: payload }] };
    const first = create(dir, (input, p) => {
      if (!input.capabilityResult) use(p, 'Capability.create', echo);
      else if (input.capabilityResult.published) use(p, echo.id, { input: payload });
      else expect(input.capabilityResult).toMatchObject({ ok: true, output: payload });
    });
    await request(first, 'open');
    await request(first, 'think', { text: 'Save and use an identity transform.', clientMessageId: 'json' });
    expect((await idle(first)).latestEpisode.status).toBe('completed');
    await first.close();
    const second = create(dir, (input, p) => {
      if (!input.capabilityResult) use(p, 'catalog.view', { id: echo.id });
      else expect(input.capabilityResult.definition.tests[0]).toEqual({ input: payload, expected: payload });
    });
    const traces = (await request(second, 'traces', { limit: 50 })).items;
    expect(traces.find(t => t.kind === 'capability_started' && t.capability?.id === 'Capability.create').capability.args.tests).toEqual(echo.tests);
    expect(traces.find(t => t.kind === 'capability_result' && t.capability?.id === echo.id).result.output).toEqual(payload);
    await request(second, 'think', { text: '', clientMessageId: 'inspect-json' });
    expect((await idle(second)).latestEpisode.status).toBe('completed');
    const inspected = (await request(second, 'traces', { limit: 50 })).items.find(t => t.kind === 'capability_result' && t.capability?.id === 'catalog.view');
    expect(inspected.result.definition.tests).toEqual(echo.tests);
  });

  it('cancels script testing without publishing or committing', async () => {
    const dir = await directory();
    const service = create(dir, (input, p) => use(p, 'Capability.create', { ...definition(), code: 'while(true){}' }));
    await request(service, 'open');
    const activity = await request(service, 'think', { text: 'learn', clientMessageId: 'cancel-test' });
    let started = false;
    for (let i = 0; i < 200; i++) {
      const traces = (await request(service, 'traces', { limit: 50 })).items;
      if (traces.some(t => t.kind === 'capability_started')) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    expect(started).toBe(true);
    expect(await request(service, 'cancel', { episodeId: activity.episodeId })).toMatchObject({ cancelled: true });
    await service.close(); // waits for termination of the active script worker
    const second = create(dir, (input, p) => {
      if (!input.capabilityResult) use(p, 'catalog.search', { query: 'Script.sum' });
      else expect(input.capabilityResult.items).toEqual([]);
    });
    const traces = (await request(second, 'traces', { limit: 50 })).items;
    expect(traces.some(t => t.kind === 'capability_created' || t.kind === 'committed')).toBe(false);
    await request(second, 'think', { text: '', clientMessageId: 'after-cancel' });
    expect((await idle(second)).latestEpisode.status).toBe('completed');
  });

  it('discovers saved but unused scripts and version-checks revisions; failed invocation demotes familiarity', async () => {
    const dir = await directory();
    const first = create(dir, (input, p) => { if (!input.capabilityResult) use(p, 'Capability.create', definition()); });
    await request(first, 'open');
    await request(first, 'dream', { clientMessageId: 'create-only' });
    expect((await idle(first)).latestEpisode.status).toBe('completed');
    await first.close();
    const second = create(dir, (input, p) => {
      if (!input.capabilityResult) {
        expect(input.capabilities.active.some(c => c.id === 'Script.sum')).toBe(false);
        use(p, 'catalog.search', { query: '求和' });
      } else if (input.capabilityResult.contracts) {
        expect(input.capabilityResult.contracts[0].id).toBe('Script.sum');
        use(p, 'Script.sum', { input: 'not-an-array' });
      } else expect(input.capabilityResult).toMatchObject({ ok: false, code: 'SCRIPT_EXECUTION' });
    });
    await request(second, 'think', { text: '', clientMessageId: 'discover' });
    expect((await idle(second)).latestEpisode.status).toBe('completed');
    await second.close();
    const third = create(dir, (input, p) => {
      if (!input.capabilityResult) {
        expect(input.capabilities.active.some(c => c.id === 'Script.sum')).toBe(false);
        use(p, 'Capability.create', definition());
      } else if (input.capabilityResult.code === 'SCRIPT_VERSION') use(p, 'Capability.create', { ...definition(), expectedVersion: 1 });
      else expect(input.capabilityResult.contract.version).toBe(2);
    });
    await request(third, 'think', { text: '', clientMessageId: 'revise' });
    expect((await idle(third)).latestEpisode.status).toBe('completed');
  });
});
