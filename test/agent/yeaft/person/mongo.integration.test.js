import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { MongoPersonRepository } from '../../../../agent/yeaft/person/repository.js';
import { config, finalProposal } from './fixtures.js';

// Explicit isolated replica-set opt-in. Never point this suite at a production database.
const uri = process.env.PERSON_TEST_MONGO_URI;
const suite = uri ? describe : describe.skip;
suite('Person real MongoDB replica-set integration', () => {
  let MongoClient, inspector;
  const dbName = `person_test_${randomUUID().replaceAll('-', '')}`;
  const services = [], repositories = [];
  const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
  const adapterFor = handler => ({ async *stream(params) {
    const context = JSON.parse(params.messages[0].content);
    params.onEffortDecision?.({ effective: params.effort ?? null, wireMode: 'test-wire' });
    const result = await handler(context, params);
    if (typeof result === 'string') yield { type: 'text_delta', text: result };
    else yield { type: 'text_delta', text: JSON.stringify(result) };
    yield { type: 'usage', inputTokens: 40, outputTokens: 30 };
    yield { type: 'stop', stopReason: 'end_turn' };
  } });
  const create = (namespace, adapter, more = {}) => {
    const service = createPersonService({ uri, dbName, namespace, MongoClient, config, adapter, effortEnabled: true, ...more });
    services.push(service); return service;
  };
  const repo = namespace => {
    const repository = new MongoPersonRepository({ uri, dbName, namespace, MongoClient, leaseMs: 400 });
    repositories.push(repository); return repository;
  };
  const waitIdle = async service => {
    for (let i = 0; i < 200; i++) {
      const snapshot = await call(service, 'snapshot');
      if (!snapshot.busy) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Person did not become idle');
  };
  beforeAll(async () => {
    const module = process.env.PERSON_TEST_MONGO_DRIVER ? pathToFileURL(process.env.PERSON_TEST_MONGO_DRIVER).href : 'mongodb';
    ({ MongoClient } = await import(/* @vite-ignore */ module));
    inspector = new MongoClient(uri); await inspector.connect();
  });
  afterAll(async () => {
    await Promise.all(services.map(s => s.close()));
    await Promise.all(repositories.map(r => r.close()));
    if (inspector) { await inspector.db(dbName).dropDatabase(); await inspector.close(); }
  });

  it('admits real messages asynchronously, chooses models per call, recalls, commits concepts and survives restart', async () => {
    const seen = [];
    const adapter = adapterFor(async (context, params) => {
      seen.push({ context, model: params.model, effort: params.effort });
      const p = finalProposal(context.state.version);
      const n = seen.length;
      if (n === 1) p.next = { model: 'test/second', effort: 'high', reason: 'Discover a way to recall prior experience.', capability: { id: 'catalog.search', args: { query: 'memory', limit: 1 } } };
      if (n === 2) p.next = { model: 'test/first', effort: 'low', reason: 'Inspect the selected Recall manifest.', capability: { id: 'catalog.view', args: { id: context.capabilityResult.items[0].id } } };
      if (n === 3) p.next = { model: 'test/first', effort: 'low', reason: 'Read a small relevant history page.', capability: { id: 'Recall', args: { kind: 'messages', query: 'garden', limit: 2 } } };
      if (n === 4) {
        p.activity.kind = 'associate';
        p.activity.sourceRefs = context.sourceRefs.filter(r => r.startsWith('message:'));
        p.concepts[0].sourceRefs = p.activity.sourceRefs;
        p.concepts.push({ id: 'garden', expectedRevision: 0, kind: 'interest', statement: 'Explore what gardening suggests about patient learning.', epistemicState: 'hypothesis', sourceRefs: p.activity.sourceRefs, associations: [{ targetId: 'curiosity', relation: 'related' }] });
        p.state.focusConceptIds.push('garden');
      }
      return p;
    });
    const service = create('roundtrip', adapter);
    const opened = await call(service, 'open');
    expect((await call(service, 'open')).person.id).toBe(opened.person.id);
    expect((await call(service, 'snapshot')).person.settings).toEqual({ autonomyEnabled: false });
    const accepted = await call(service, 'send', { text: 'I am learning to garden.', clientMessageId: 'message-1' });
    expect(accepted.episodeId).toBeTruthy();
    const duplicate = await call(service, 'send', { text: 'I am learning to garden.', clientMessageId: 'message-1' });
    expect(duplicate).toMatchObject({ duplicate: true, episodeId: accepted.episodeId });
    const snapshot = await waitIdle(service);
    expect(snapshot.state.version).toBe(1); expect(snapshot.concepts).toHaveLength(2);
    expect(snapshot.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(seen.map(s => [s.model, s.effort])).toEqual([['test/first', undefined], ['test/second', 'high'], ['test/first', 'low'], ['test/first', 'low']]);
    expect(seen.map(s => s.context.budget.remainingCalls)).toEqual([4, 3, 2, 1]);
    expect(seen[3].context.capabilityResult.items[0].text).toBe('I am learning to garden.');
    const traces = (await call(service, 'traces', { limit: 50 })).items;
    expect(traces.filter(t => t.kind === 'activity')).toHaveLength(4);
    expect(traces.filter(t => t.kind === 'capability_result').reverse().map(t => t.capability.id)).toEqual(['catalog.search', 'catalog.view', 'Recall']);
    expect(traces[0].kind).toBe('committed');
    expect(traces.find(t => t.kind === 'call_started').request.tools).toEqual([]);
    expect(traces.find(t => t.kind === 'call_output').output).toMatchObject({ complete: true, usage: { inputTokens: 40 } });
    await expect(call(service, 'send', { text: 'different', clientMessageId: 'message-1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await service.close();
    const restarted = create('roundtrip', adapter);
    expect((await call(restarted, 'snapshot')).state.version).toBe(1);
    expect((await call(restarted, 'messages')).items).toHaveLength(2);
    const collection = inspector.db(dbName).collection('person_concept_revisions');
    expect(await collection.countDocuments({ namespace: 'roundtrip' })).toBe(2);
  });

  it('isolates owners/namespaces and paginates every trace without gaps', async () => {
    const service = create('pagination', adapterFor(() => finalProposal()));
    await call(service, 'open');
    const bob = await call(service, 'open', {}, 'bob');
    expect(bob.person.id).not.toBe((await call(service, 'snapshot')).person.id);
    await call(service, 'send', { text: 'private', clientMessageId: 'same-id' }); await waitIdle(service);
    expect((await call(service, 'messages', {}, 'bob')).items).toEqual([]);
    expect((await call(service, 'traces', {}, 'bob')).items).toEqual([]);
    const all = []; let cursor = null;
    do { const result = await call(service, 'traces', { cursor, limit: 2 }); all.push(...result.items); cursor = result.nextCursor; } while (cursor);
    expect(new Set(all.map(t => t.id)).size).toBe(all.length);
    expect(all.map(t => t.seq)).toEqual(Array.from({ length: all.length }, (_, i) => all.length - i));
    const another = create('other-namespace', adapterFor(() => finalProposal()));
    await expect(call(another, 'snapshot')).rejects.toMatchObject({ code: 'NOT_OPEN' });
  });

  it('Think and Dream are distinct explicit triggers, never fake user messages or automatic background calls', async () => {
    let count = 0;
    const service = create('intrinsic', adapterFor(context => {
      count++; const p = finalProposal(context.state.version);
      if (context.state.version) p.concepts[0].expectedRevision = 1;
      p.reply = null;
      if (context.trigger.kind === 'dream') { p.activity.kind = 'imagine'; p.concepts[0].kind = 'scenario'; p.concepts[0].epistemicState = 'imagined'; }
      return p;
    }));
    await call(service, 'open');
    expect((await call(service, 'status')).configured).toBe(true);
    expect(await call(service, 'settings', { autonomyEnabled: false })).toEqual({ settings: { autonomyEnabled: false } });
    await expect(call(service, 'settings', { autonomyEnabled: true })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(call(service, 'settings', { autonomyEnabled: 'false' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(count).toBe(0);
    await call(service, 'think', { text: 'Reconsider what you know.', clientMessageId: 'think' });
    expect((await waitIdle(service)).state.version).toBe(1);
    expect((await call(service, 'messages')).items).toHaveLength(0);
    expect(count).toBe(1);
    await call(service, 'dream', { clientMessageId: 'dream' });
    const snapshot = await waitIdle(service);
    expect(snapshot.state.version).toBe(2); expect(snapshot.concepts[0].epistemicState).toBe('imagined');
    expect(snapshot.person.settings).toEqual({ autonomyEnabled: false });
    expect(snapshot.messages).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(count).toBe(2);
    expect(await inspector.db(dbName).collection('person_concept_revisions').countDocuments({ namespace: 'intrinsic' })).toBe(2);
  });

  it('has durable invalid-output failures, finite calls/timeouts, and secret-free errors', async () => {
    const invalid = create('invalid', adapterFor(() => '{"arbitrary":"not a proposal"}'));
    await call(invalid, 'open'); await call(invalid, 'send', { text: 'hello', clientMessageId: 'invalid' });
    expect((await waitIdle(invalid)).state.version).toBe(0);
    const traces = (await call(invalid, 'traces')).items;
    expect(traces.find(t => t.kind === 'failed').code).toBe('INVALID_PROPOSAL');
    expect(traces.find(t => t.kind === 'call_output').output.text).toBe('{"arbitrary":"not a proposal"}');
    const looping = create('budget', adapterFor(() => { const p = finalProposal(); p.next = { model: 'test/first', effort: null, reason: 'continue', capability: null }; return p; }), { maxCalls: 2 });
    await call(looping, 'open'); await call(looping, 'think', { text: '', clientMessageId: 'loop' }); await waitIdle(looping);
    const budgetTraces = (await call(looping, 'traces')).items;
    expect(budgetTraces.filter(t => t.kind === 'call_started')).toHaveLength(2);
    expect(budgetTraces[0].kind).toBe('budget_exhausted');
    const hanging = create('timeout', adapterFor(() => new Promise(() => {})), { timeoutMs: 150 });
    await call(hanging, 'open'); await call(hanging, 'think', { text: '', clientMessageId: 'hang' }); await waitIdle(hanging);
    expect((await call(hanging, 'traces')).items[0]).toMatchObject({ kind: 'failed', code: 'TIMEOUT' });
    const secret = create('secret', adapterFor(() => { throw new Error('mongodb://admin:password@host API_KEY_SECRET'); }));
    await call(secret, 'open'); await call(secret, 'think', { text: '', clientMessageId: 'secret' }); await waitIdle(secret);
    const serialized = JSON.stringify(await call(secret, 'traces'));
    expect(serialized).not.toContain('password'); expect(serialized).not.toContain('API_KEY_SECRET');
    expect(serialized).toContain('PROVIDER_FAILED');
  });

  it('cancels across service instances and rejects late provider completion', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    let started; const providerStarted = new Promise(resolve => { started = resolve; });
    const a = create('cancel', adapterFor(async () => { started(); await waiting; return finalProposal(); }), { leaseMs: 600 });
    const b = create('cancel', adapterFor(() => finalProposal()));
    await call(a, 'open');
    const admitted = await call(a, 'send', { text: 'cancel me', clientMessageId: 'cancel' });
    await providerStarted;
    await expect(call(b, 'think', { text: '', clientMessageId: 'other' })).rejects.toMatchObject({ code: 'BUSY' });
    expect(await call(b, 'cancel', { episodeId: admitted.episodeId })).toMatchObject({ cancelled: true });
    release(); await a.close();
    expect((await call(b, 'snapshot')).state.version).toBe(0);
    expect((await call(b, 'messages')).items).toHaveLength(1);
    expect((await call(b, 'traces')).items[0].kind).toBe('cancelled');
  });

  it('uses database-time leases, epoch takeover fences and transaction rollback of every state write', async () => {
    const first = repo('fences'), second = repo('fences');
    await first.open('alice');
    const one = await first.admit('alice', { kind: 'think', text: '', clientMessageId: 'one', workerId: 'worker-a', budget: { calls: 1, timeoutMs: 1000 } });
    expect(await second.recover('alice')).toBe(false);
    const leased = await inspector.db(dbName).collection('person_persons').findOne({ namespace: 'fences' });
    expect(leased.leaseUntil).toBeInstanceOf(Date);
    expect(leased.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    await expect(second.admit('alice', { kind: 'think', text: '', clientMessageId: 'premature', workerId: 'worker-b', budget: { calls: 1, timeoutMs: 1000 } })).rejects.toMatchObject({ code: 'BUSY' });
    // No runtime heartbeat: this simulates a crashed process, not a fake repository.
    await new Promise(resolve => setTimeout(resolve, 450));
    await second.recover('alice');
    const two = await second.admit('alice', { kind: 'think', text: '', clientMessageId: 'two', workerId: 'worker-b', budget: { calls: 1, timeoutMs: 1000 } });
    await expect(first.commit(one.episode, finalProposal(), { model: 'test/first', effort: null }, 'old-call')).rejects.toMatchObject({ code: 'STALE' });
    const wrong = finalProposal(); wrong.concepts[0].expectedRevision = 100;
    await expect(second.commit(two.episode, wrong, { model: 'test/first', effort: null }, 'bad-call')).rejects.toMatchObject({ code: 'STALE' });
    const afterRollback = await second.snapshot('alice');
    expect(afterRollback.state.version).toBe(0); expect(afterRollback.busy).toBe(true);
    expect(await inspector.db(dbName).collection('person_state_commits').countDocuments({ namespace: 'fences' })).toBe(0);
    await second.commit(two.episode, finalProposal(), { model: 'test/first', effort: null }, 'good-call');
    expect((await second.snapshot('alice')).state.version).toBe(1);
    expect((await second.list('alice', 'traces', { limit: 50 })).items.some(t => t.kind === 'interrupted')).toBe(true);
  });

  it('serializes concurrent idempotent admission over separate Mongo clients', async () => {
    const a = repo('concurrent'), b = repo('concurrent');
    await Promise.all([a.open('alice'), b.open('alice')]);
    const input = { kind: 'send', text: 'one accepted message', clientMessageId: 'identical', workerId: 'worker-a', budget: { calls: 1, timeoutMs: 1000 } };
    const results = await Promise.all([a.admit('alice', input), b.admit('alice', { ...input, workerId: 'worker-b' })]);
    expect(results[0].episodeId).toBe(results[1].episodeId);
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect((await a.list('alice', 'messages', { limit: 10 })).items).toHaveLength(1);
    await a.cancel('alice');
  });

  it('paginates Recall message records using numeric database cursors', async () => {
    const r = repo('recall-pages'); await r.open('alice');
    for (let i = 0; i < 3; i++) {
      await r.admit('alice', { kind: 'send', text: `history ${i}`, clientMessageId: `history-${i}`, workerId: 'worker', budget: { calls: 1, timeoutMs: 1000 } });
      await r.cancel('alice');
    }
    const capability = new PersonCapabilities(r, 'alice');
    await capability.execute({ id: 'catalog.view', args: { id: 'Recall' } });
    const ids = []; let cursor = null;
    do {
      const result = await capability.execute({ id: 'Recall', args: { kind: 'messages', query: 'history', limit: 1, cursor } });
      ids.push(...result.items.map(m => m.id)); cursor = result.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(3);
  });

  it('fences concurrent admissions from independent OS processes', async () => {
    const children = [0, 1].map(() => fork(new URL('./process-admission.js', import.meta.url), [], {
      env: { ...process.env, PERSON_TEST_DB: dbName }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }));
    try {
      const exited = children.map(child => once(child, 'exit'));
      await Promise.all(children.map(async child => expect((await once(child, 'message'))[0]).toEqual({ ready: true })));
      const results = children.map(child => once(child, 'message'));
      for (const child of children) child.send({ start: true });
      const admitted = (await Promise.all(results)).map(([result]) => result);
      expect(admitted.every(r => !r.error)).toBe(true);
      expect(admitted[0].episodeId).toBe(admitted[1].episodeId);
      expect(admitted.filter(r => !r.duplicate)).toHaveLength(1);
      await Promise.all(exited);
      expect(await inspector.db(dbName).collection('person_messages').countDocuments({ namespace: 'processes' })).toBe(1);
      await repo('processes').cancel('alice');
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  });


  it('uses the real native config/router/Anthropic adapter without creating a Session', async () => {
    const yeaftDir = await mkdtemp(join(tmpdir(), 'person-native-config-'));
    const requests = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const wire = JSON.parse(body); requests.push({ path: req.url, body: wire });
      const content = wire.messages[0].content;
      const context = JSON.parse(typeof content === 'string' ? content : content[0].text);
      const result = JSON.stringify(finalProposal(context.state.version));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
      event('message_start', { message: { id: 'local-test', type: 'message', role: 'assistant', model: 'person-test-model', content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: result } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } });
      event('message_stop', {}); res.end();
    });
    let service;
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      await writeFile(join(yeaftDir, 'config.json'), JSON.stringify({
        providers: [{ name: 'local-test', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'local-test-secret',
          models: [{ id: 'person-test-model', contextWindow: 100000, maxOutput: 4096 }] }], primaryModel: 'local-test/person-test-model',
      }));
      service = createPersonService({ uri, dbName, namespace: 'native-provider', MongoClient, yeaftDir });
      services.push(service);
      expect(await call(service, 'status')).toMatchObject({ storageReady: true, modelReady: true });
      expect(requests).toHaveLength(0);
      await call(service, 'open');
      await call(service, 'send', { text: 'Native roundtrip.', clientMessageId: 'native' });
      const snapshot = await waitIdle(service);
      expect(snapshot.state.version).toBe(1);
      expect(requests).toHaveLength(1); expect(requests[0].path).toBe('/v1/messages');
      expect(requests[0].body.model).toBe('person-test-model');
      expect((await readdir(yeaftDir)).sort()).toEqual(['config.json']);
      const traces = await call(service, 'traces');
      expect(JSON.stringify(traces)).not.toContain('local-test-secret');
      expect(traces.items.find(t => t.kind === 'call_output').effective.effortObserved).toBe(true);
    } finally {
      await service?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(yeaftDir, { recursive: true, force: true });
    }
  });

});
