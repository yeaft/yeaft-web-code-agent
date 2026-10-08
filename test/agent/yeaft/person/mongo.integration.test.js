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
import { config, imageConfig, finalProposal } from './fixtures.js';

// Explicit isolated replica-set opt-in. Never point this suite at a production database.
const uri = process.env.PERSON_TEST_MONGO_URI;
const suite = uri ? describe : describe.skip;
suite('Person real MongoDB replica-set integration', () => {
  let MongoClient, inspector;
  const dbName = `person_test_${randomUUID().replaceAll('-', '')}`;
  const services = [], repositories = [];
  const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
  const adapterFor = handler => ({ async *stream(params) {
    const content = params.messages[0].content;
    const context = JSON.parse(Array.isArray(content) ? content[0].text : content);
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
  const repo = (namespace, leaseMs = 10_000) => {
    // Only expiry tests use a short lease. Unrelated transaction/cancel tests
    // must not lose ownership merely because a shared CI host pauses for 400ms.
    const repository = new MongoPersonRepository({ uri, dbName, namespace, MongoClient, leaseMs });
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
    expect(seen.map(s => s.context.budget.remainingCalls)).toEqual([16, 15, 14, 13]);
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

  it.each(['send', 'think'])('%s persists image/text files and owner candidates across restart, resolves receipts without replay', async op => {
    const namespace = `files-${op}`, seen = [];
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=';
    const files = [{ name: 'pixel.png', mimeType: 'image/png', data: png },
      { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('Mongo durable UTF-8 附件').toString('base64') }];
    const native = imageConfig;
    const adapter = adapterFor((context, params) => {
      seen.push(params);
      expect(context.trigger.attachments[1]).toMatchObject({ content: 'Mongo durable UTF-8 附件', trust: 'untrusted-user-content' });
      expect(params.messages[0].content.find(part => part.type === 'image').source.data).toBe(png);
      expect(params.model).toBe('test/gpt-4.1-mini');
      const p = finalProposal(context.state.version); p.concepts = []; p.state.focusConceptIds = []; return p;
    });
    const s = create(namespace, adapter, { config: native });
    await call(s, 'open'); await call(s, 'settings', { modelCandidates: ['test/gpt-4.1-mini'] });
    const request = { clientMessageId: 'files', text: '', files };
    const accepted = await call(s, op, request);
    expect(await call(s, op, request)).toMatchObject({ duplicate: true, episodeId: accepted.episodeId });
    const snapshot = await waitIdle(s);
    expect(snapshot.latestEpisode.status).toBe('completed');
    expect(snapshot.messages.find(m => m.role === 'user').attachments).toHaveLength(2);
    expect(JSON.stringify(await call(s, 'messages'))).not.toContain(png);
    expect(JSON.stringify(await call(s, 'traces'))).not.toContain(png);
    await s.close();
    const restarted = create(namespace, adapter, { config: native });
    const receipt = await call(restarted, 'receipt', { clientMessageId: 'files' });
    expect(receipt).toMatchObject({ found: true, episodeId: accepted.episodeId, status: 'completed', kind: op, text: '', attachments: [{ name: 'pixel.png' }, { name: 'notes.md' }] });
    expect(JSON.stringify(receipt)).not.toContain(png);
    expect((await call(restarted, 'status')).modelCandidates).toEqual(['test/gpt-4.1-mini']);
    expect(await call(restarted, op, structuredClone(request))).toMatchObject({ duplicate: true, episodeId: accepted.episodeId });
    await expect(call(restarted, op, { ...request, files: [files[0]] })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(call(restarted, 'receipt', { clientMessageId: 'files', requestHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await call(restarted, 'receipt', { clientMessageId: 'files' }, 'bob')).toEqual({ found: false, clientMessageId: 'files' });
    expect(await repo(`${namespace}-other`).receipt('alice', 'files')).toEqual({ found: false, clientMessageId: 'files' });
    expect(seen).toHaveLength(1);
    const stored = await inspector.db(dbName).collection('person_attachments').find({ namespace, ownerId: 'alice' }).toArray();
    expect(stored).toHaveLength(2);
    expect(stored.find(f => f.kind === 'image').data).toBe(png);
    expect(stored.find(f => f.kind === 'text').data).toBe(files[1].data);
  });

  it('receipt is read-only even for expired Mongo leases', async () => {
    const r = repo('receipt-expired', 300); await r.open('alice');
    const { episode } = await r.admit('alice', { kind: 'think', text: '', clientMessageId: 'one', workerId: 'crashed', budget: { calls: 1, timeoutMs: 1000 } });
    const before = await r.getPerson('alice');
    await r.close();
    await new Promise(resolve => setTimeout(resolve, 350));
    const restarted = repo('receipt-expired');
    expect(await restarted.receipt('alice', 'one', episode.requestHash)).toMatchObject({ found: true, status: 'running', episodeId: episode.id });
    expect(await restarted.getPerson('alice')).toEqual(before);
    expect((await restarted.list('alice', 'traces', { limit: 50 })).items).toHaveLength(1);
    await restarted.recover('alice');
    expect(await restarted.receipt('alice', 'one')).toMatchObject({ status: 'interrupted' });
  });

  it('retains previously read concept revisions and reported provenance across Recall pages without pretending to render them again', async () => {
    const seen = [];
    const service = create('concept-read-set', adapterFor(context => {
      seen.push(context);
      const p = finalProposal(context.state.version);
      const n = seen.length;
      if (n === 1) p.next = { model: 'test/first', effort: null, reason: 'Inspect Recall.', capability: { id: 'catalog.view', args: { id: 'Recall' } } };
      if (n === 2) p.next = { model: 'test/first', effort: null, reason: 'Read the oldest concepts.', capability: { id: 'Recall', args: { kind: 'concepts', limit: 2 } } };
      if (n >= 3) {
        p.concepts = [{ ...p.concepts[0], id: 'c00', expectedRevision: 1, epistemicState: 'reported', sourceRefs: ['concept:c00:1'], statement: 'Revised after reading more.' }];
        p.state.focusConceptIds = ['c00'];
      }
      if (n === 3) p.next = { model: 'test/first', effort: null, reason: 'Read the next page.', capability: { id: 'Recall', args: { kind: 'concepts', limit: 2, cursor: context.capabilityResult.nextCursor } } };
      return p;
    }));
    const r = repo('concept-read-set'); await r.open('alice');
    await inspector.db(dbName).collection('person_messages').insertOne(r.doc(r.scope('alice'), {
      id: 'original-report', revision: 1, seq: 1, role: 'user', text: 'An earlier user report.',
    }));
    // Neither the focused nor recent bootstrap window includes c00 (more than 24 concepts).
    await inspector.db(dbName).collection('person_concepts').insertMany(Array.from({ length: 30 }, (_, i) => r.doc(r.scope('alice'), {
      id: `c${String(i).padStart(2, '0')}`, revision: 1, kind: 'claim', epistemicState: i === 0 ? 'reported' : 'uncertain', statement: `Old concept ${i}`,
      reportedSourceRefs: i === 0 ? ['message:original-report:1'] : [],
      sourceRefs: [], associations: [], updatedAt: new Date(1000 + i),
    })));
    await inspector.db(dbName).collection('person_persons').updateOne(r.scope('alice'), { $set: { messageSeq: 1 } });
    await call(service, 'think', { text: '', clientMessageId: 'pages' });
    const snapshot = await waitIdle(service);
    expect(snapshot.state.version).toBe(1);
    expect(snapshot.concepts[0]).toMatchObject({ id: 'c00', revision: 2, reportedSourceRefs: ['message:original-report:1'] });
    expect(seen).toHaveLength(4);
    expect(seen[3].concepts.some(c => c.id === 'c00')).toBe(false);
    expect(seen[3].capabilityResult.items.map(c => c.id)).toEqual(['c02', 'c03']);
    expect(seen[3].previousProposal.concepts[0].id).toBe('c00');
    const finalCall = (await call(service, 'traces', { limit: 50 })).items.find(t => t.kind === 'call_started');
    expect(finalCall.manifest.inputDependencyRefs).toContain('concept:c00:1');
    expect(finalCall.manifest.renderedSourceRefs).not.toContain('concept:c00:1');
  });

  it('does not promote self-generated imagination or assistant text into reports and preserves real report lineage', async () => {
    let mode = 'imagine';
    const service = create('reported-lineage', adapterFor(context => {
      const p = finalProposal(context.state.version);
      const old = context.concepts.find(c => c.id === 'curiosity');
      p.concepts[0].expectedRevision = old?.revision ?? 0;
      p.concepts[0].epistemicState = mode === 'imagine' ? 'imagined' : 'reported';
      if (mode === 'self' || mode === 'revise') p.concepts[0].sourceRefs = [`concept:curiosity:${old.revision}`];
      if (mode === 'assistant') p.concepts[0].sourceRefs = context.messages.filter(m => m.role === 'assistant').map(m => `message:${m.id}:${m.revision}`);
      if (mode === 'trigger') p.concepts[0].sourceRefs = [context.trigger.ref];
      if (mode === 'user') p.concepts[0].sourceRefs = context.messages.filter(m => m.role === 'user').map(m => `message:${m.id}:${m.revision}`);
      return p;
    }));
    await call(service, 'open');
    await call(service, 'think', { text: '', clientMessageId: 'imagine' });
    expect((await waitIdle(service)).state.version).toBe(1);
    for (const attempt of ['self', 'assistant', 'trigger']) {
      mode = attempt;
      await call(service, 'dream', { clientMessageId: `dream-${attempt}` });
      const snapshot = await waitIdle(service);
      expect(snapshot.state.version).toBe(1); expect(snapshot.latestEpisode.terminalCode).toBe('INVALID_PROPOSAL');
    }
    mode = 'trigger';
    await call(service, 'think', { text: 'I observed a blue bird.', clientMessageId: 'real-report' });
    const reported = await waitIdle(service);
    expect(reported.state.version).toBe(2);
    const roots = reported.concepts[0].reportedSourceRefs;
    expect(roots).toEqual([`trigger:${reported.latestEpisode.id}`]);
    mode = 'revise';
    await call(service, 'dream', { clientMessageId: 'preserve-report' });
    const revised = await waitIdle(service);
    expect(revised.state.version).toBe(3);
    expect(revised.concepts[0]).toMatchObject({ revision: 3, epistemicState: 'reported', sourceRefs: ['concept:curiosity:2'], reportedSourceRefs: roots });
    mode = 'user';
    await call(service, 'send', { text: 'I observed the bird again.', clientMessageId: 'user-report' });
    const userReport = await waitIdle(service);
    expect(userReport.state.version).toBe(4);
    expect(userReport.concepts[0].reportedSourceRefs).toEqual([`message:${userReport.messages.find(m => m.role === 'user').id}:1`]);
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
    expect(await call(service, 'settings', { autonomyEnabled: false })).toEqual({ settings: { autonomyEnabled: false },
      person: expect.objectContaining({ name: 'Digital Person', settings: { autonomyEnabled: false } }) });
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

  it.each(['local', 'remote'])('retains consumed output exactly once on %s cancellation without a late state commit', async mode => {
    let release, consumed, aborted;
    const waiting = new Promise(resolve => { release = resolve; });
    const providerConsumed = new Promise(resolve => { consumed = resolve; });
    const providerAborted = new Promise(resolve => { aborted = resolve; });
    const adapter = { async *stream(params) {
      params.signal.addEventListener('abort', aborted, { once: true });
      yield { type: 'text_delta', text: '{"partial":"已读取"' };
      consumed(); await waiting; // Deliberately ignore abort; late provider output must not win.
      yield { type: 'text_delta', text: JSON.stringify(finalProposal()) };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const a = create(`cancel-${mode}`, adapter, { leaseMs: 1200 });
    const b = create(`cancel-${mode}`, adapterFor(() => finalProposal()));
    await call(a, 'open');
    const admitted = await call(a, 'send', { text: 'cancel me', clientMessageId: 'cancel' });
    await providerConsumed;
    await expect(call(b, 'think', { text: '', clientMessageId: 'other' })).rejects.toMatchObject({ code: 'BUSY' });
    expect(await call(mode === 'local' ? a : b, 'cancel', { episodeId: admitted.episodeId })).toMatchObject({ cancelled: true });
    await providerAborted; // Remote cancellation must be observed by the running worker heartbeat.
    await a.close();
    release(); await new Promise(resolve => setImmediate(resolve));
    const snapshot = await call(b, 'snapshot');
    expect(snapshot.state.version).toBe(0);
    expect(snapshot.latestEpisode).toMatchObject({ status: 'cancelled', terminalCode: 'CANCELLED' });
    expect((await call(b, 'messages')).items).toHaveLength(1);
    const traces = (await call(b, 'traces')).items;
    expect(traces.filter(t => t.kind === 'call_started')).toHaveLength(1);
    const terminal = traces.filter(t => ['call_failed', 'call_output'].includes(t.kind));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ kind: 'call_failed', code: 'CANCELLED', output: {
      text: '{"partial":"已读取"', retainedBytes: Buffer.byteLength('{"partial":"已读取"'), complete: false, accepted: false, availability: 'captured',
    } });
    expect(traces.some(t => ['committed', 'activity'].includes(t.kind))).toBe(false);
  });

  it('bounds the cancelled-call drain right and makes crash/takeover output explicitly unavailable', async () => {
    const r = repo('terminal-right', 400); await r.open('alice');
    const admit = id => r.admit('alice', { kind: 'think', text: '', clientMessageId: id, workerId: 'original', budget: { calls: 1, timeoutMs: 1000 } });
    const start = (episode, callId) => r.startCall(episode, { callId, requested: { model: 'test/first', effort: null }, effective: { model: 'test/first', effort: null } });
    const one = await admit('one'); await start(one.episode, 'one-call'); await r.cancel('alice');
    const terminal = { callId: 'one-call', output: { text: 'consumed prefix', observedBytes: 15 }, code: 'CANCELLED' };
    expect(await r.finalizeCall({ ...one.episode, workerId: 'imposter' }, terminal)).toBe(false);
    await expect(r.finalizeCall(one.episode, { ...terminal, output: { text: 'x'.repeat(65537) } })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    const two = await admit('two'); // A new state owner does not erase the old call's bounded trace-only right.
    await Promise.all([r.finalizeCall(one.episode, terminal), r.finalizeCall(one.episode, terminal)]);
    await expect(r.append(one.episode, 'activity', {})).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.commit(one.episode, finalProposal(), { model: 'test/first', effort: null }, 'one-call')).rejects.toMatchObject({ code: 'STALE' });
    await start(two.episode, 'two-call');
    await new Promise(resolve => setTimeout(resolve, 450));
    await r.recover('alice'); // Crashed worker had a started call; no output can be reconstructed.
    expect(await r.finalizeCall(two.episode, { ...terminal, callId: 'two-call' })).toBe(false);
    const three = await admit('three'); await start(three.episode, 'three-call'); await r.cancel('alice');
    await new Promise(resolve => setTimeout(resolve, 450));
    await r.recover('alice'); // A cancelled worker can crash before its drain finalizer too.
    expect(await r.finalizeCall(three.episode, { ...terminal, callId: 'three-call' })).toBe(false);
    const traces = (await r.list('alice', 'traces', { limit: 50 })).items;
    const terminals = traces.filter(t => t.kind === 'call_failed');
    expect(terminals).toHaveLength(3);
    expect(terminals.find(t => t.callId === 'one-call').output).toMatchObject({ text: 'consumed prefix', availability: 'captured' });
    for (const callId of ['two-call', 'three-call']) expect(terminals.find(t => t.callId === callId).output).toMatchObject({ availability: 'unavailable', observedBytes: null, complete: false });
    expect((await r.snapshot('alice')).state.version).toBe(0);
  });

  it('records a completed-but-cancelled output as rejected without committing it', async () => {
    const r = repo('cancel-completed'); await r.open('alice');
    const admitted = await r.admit('alice', { kind: 'think', text: '', clientMessageId: 'one', workerId: 'worker', budget: { calls: 1, timeoutMs: 1000 } });
    await r.startCall(admitted.episode, { callId: 'call', requested: { model: 'test/first', effort: null }, effective: { model: 'test/first', effort: null } });
    // Provider completion raced with distributed cancel before its output transaction.
    const text = JSON.stringify(finalProposal());
    await r.cancel('alice');
    expect(await r.finalizeCall(admitted.episode, { callId: 'call', output: { text, bytes: Buffer.byteLength(text), stopReason: 'end_turn' } })).toBe(false);
    expect(await r.finalizeCall(admitted.episode, { callId: 'call', output: { text: 'late rewrite' } })).toBe(false);
    const terminal = (await r.list('alice', 'traces', { limit: 50 })).items.filter(t => t.kind === 'call_failed');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ code: 'CANCELLED', output: { text, complete: false, accepted: false, availability: 'captured', stopReason: 'end_turn' } });
    expect((await r.snapshot('alice')).state.version).toBe(0);
  });

  it('uses database-time leases, epoch takeover fences and transaction rollback of every state write', async () => {
    const first = repo('fences', 400), second = repo('fences', 400);
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
      expect((await readdir(yeaftDir)).sort()).toEqual(['config.json', 'person']);
      // Only the backend binding marker is local; Mongo mode creates no SQLite authority or index.
      expect(await readdir(join(yeaftDir, 'person'))).toEqual([expect.stringMatching(/^storage-[a-f0-9]+\.json$/)]);
      const traces = await call(service, 'traces');
      expect(JSON.stringify(traces)).not.toContain('local-test-secret');
      expect(traces.items.find(t => t.kind === 'call_output').effective.effortObserved).toBe(true);
    } finally {
      await service?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(yeaftDir, { recursive: true, force: true });
    }
  });

});
