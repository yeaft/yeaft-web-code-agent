import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { DatabaseSync } from 'node:sqlite';
import { collectOutput, createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { callUsage } from '../../../../agent/yeaft/person/turn-diagnostics.js';
import { config, imageConfig, finalProposal } from './fixtures.js';

// Real runtime lifecycle against an isolated SQLite authority, with scripted inference.
describe('Person real SQLite runtime integration', () => {
  let yeaftDir;
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
    const service = createPersonService({ yeaftDir, namespace, config, adapter, embedding: { enabled: false }, effortEnabled: true, ...more });
    services.push(service); return service;
  };
  const repo = (namespace, leaseMs = 10_000) => {
    // Only expiry tests use a short lease. Unrelated commit/cancel tests
    // must not lose ownership merely because a shared CI host pauses for 400ms.
    const repository = new SqlitePersonRepository({ yeaftDir, namespace, leaseMs });
    repositories.push(repository); return repository;
  };
  const sql = (r, fn) => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };
  const records = (r, table) => sql(r, db => db.prepare(`SELECT record FROM ${table} WHERE namespace = ?`).all(r.namespace).map(row => JSON.parse(row.record)));
  const insert = (r, table, record, columns) => sql(r, db => {
    const scope = r.scope('alice'), row = { ...record, ...scope };
    db.prepare(`INSERT INTO ${table} (namespace, ownerId, personId, ${Object.keys(columns).join(', ')}, record) VALUES (?, ?, ?, ${Object.keys(columns).map(() => '?').join(', ')}, ?)`)
      .run(scope.namespace, scope.ownerId, scope.personId, ...Object.values(columns), JSON.stringify(row));
  });
  const finalize = async (r, episode, callId) => {
    await r.startCall(episode, { callId, requested: { model: 'test/first', effort: null } });
    await r.finalizeCall(episode, { callId, output: { text: '{}' } });
  };
  const waitIdle = async service => {
    for (let i = 0; i < 200; i++) {
      const snapshot = await call(service, 'snapshot');
      if (!snapshot.busy) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Person did not become idle');
  };
  beforeAll(async () => { yeaftDir = await mkdtemp(join(tmpdir(), 'person-sqlite-runtime-')); });
  afterAll(async () => {
    await Promise.all(services.map(s => s.close()));
    await Promise.all(repositories.map(r => r.close()));
    await rm(yeaftDir, { recursive: true, force: true });
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
    expect((await call(service, 'snapshot')).person.settings).toEqual({ autonomyEnabled: false, defaultModel: null });
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
    expect(records(repo('roundtrip'), 'concept_revisions')).toHaveLength(2);
  });

  it.each(['send', 'think'])('%s persists image/text files and owner candidates across restart, resolves receipts without replay', async op => {
    const namespace = `files-${op}`, seen = [];
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=';
    const files = [{ name: 'pixel.png', mimeType: 'image/png', data: png },
      { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('SQLite durable UTF-8 附件').toString('base64') }];
    const native = imageConfig;
    const adapter = adapterFor((context, params) => {
      seen.push(params);
      expect(context.trigger.attachments[1]).toMatchObject({ content: 'SQLite durable UTF-8 附件', trust: 'untrusted-user-content' });
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
    const stored = records(repo(namespace), 'attachments');
    expect(stored).toHaveLength(2);
    expect(stored.find(f => f.kind === 'image').data).toBe(png);
    expect(stored.find(f => f.kind === 'text').data).toBe(files[1].data);
  });

  it('receipt is read-only even for expired SQLite leases', async () => {
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
    insert(r, 'messages', { id: 'original-report', revision: 1, seq: 1, role: 'user', text: 'An earlier user report.' },
      { id: 'original-report', seq: 1, revision: 1, text: 'An earlier user report.' });
    // Neither the focused nor recent bootstrap window includes c00 (more than 24 concepts).
    for (let i = 0; i < 30; i++) {
      const record = { id: `c${String(i).padStart(2, '0')}`, revision: 1, kind: 'claim', epistemicState: i === 0 ? 'reported' : 'uncertain', statement: `Old concept ${i}`,
        reportedSourceRefs: i === 0 ? ['message:original-report:1'] : [], sourceRefs: [], associations: [], updatedAt: new Date(1000 + i) };
      insert(r, 'concepts', record, { id: record.id, revision: 1, updatedAt: 1000 + i, statement: record.statement });
    }
    sql(r, db => db.prepare("UPDATE persons SET record = json_set(record, '$.messageSeq', 1) WHERE namespace = ?").run(r.namespace));
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
    expect(await call(service, 'settings', { autonomyEnabled: false })).toEqual({ settings: { autonomyEnabled: false, defaultModel: null },
      person: expect.objectContaining({ name: 'Digital Person', settings: { autonomyEnabled: false, defaultModel: null } }) });
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
    expect(snapshot.person.settings).toEqual({ autonomyEnabled: false, defaultModel: null });
    expect(snapshot.messages).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(count).toBe(2);
    expect(records(repo('intrinsic'), 'concept_revisions')).toHaveLength(2);
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
    const secret = create('secret', adapterFor(() => { throw new Error('https://admin:password@host API_KEY_SECRET'); }));
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
    const r = repo('terminal-right'); await r.open('alice');
    const admit = id => r.admit('alice', { kind: 'think', text: '', clientMessageId: id, workerId: 'original', budget: { calls: 1, timeoutMs: 1000 } });
    const start = (episode, callId) => r.startCall(episode, { callId, requested: { model: 'test/first', effort: null }, effective: { model: 'test/first', effort: null } });
    // Simulate persisted crash deadlines, not CI scheduling: live drain assertions
    // must not lose their right while unrelated worker/SQLite requests are queued.
    const expire = episodeId => sql(r, db => {
      const scope = r.scope('alice'), expired = '2000-01-01T00:00:00.000Z';
      if (episodeId) db.prepare("UPDATE episodes SET callFinalizeUntil = ?, record = json_set(record, '$.callFinalizeUntil', ?) WHERE namespace = ? AND ownerId = ? AND personId = ? AND id = ?")
        .run(Date.parse(expired), expired, scope.namespace, scope.ownerId, scope.personId, episodeId);
      else db.prepare("UPDATE persons SET record = json_set(record, '$.leaseUntil', ?) WHERE namespace = ? AND ownerId = ? AND personId = ?")
        .run(expired, scope.namespace, scope.ownerId, scope.personId);
    });
    const one = await admit('one'); await start(one.episode, 'one-call'); await r.cancel('alice');
    const terminal = { callId: 'one-call', output: { text: 'consumed prefix', observedBytes: 15 }, code: 'CANCELLED' };
    expect(await r.finalizeCall({ ...one.episode, workerId: 'imposter' }, terminal)).toBe(false);
    await expect(r.finalizeCall(one.episode, { ...terminal, output: { text: 'x'.repeat(65537) } })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' });
    const two = await admit('two'); // A new state owner does not erase the old call's bounded trace-only right.
    await Promise.all([r.finalizeCall(one.episode, terminal), r.finalizeCall(one.episode, terminal)]);
    await expect(r.append(one.episode, 'activity', {})).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.commit(one.episode, finalProposal(), { model: 'test/first', effort: null }, 'one-call')).rejects.toMatchObject({ code: 'STALE' });
    await start(two.episode, 'two-call');
    expire();
    await r.recover('alice'); // Crashed worker had a started call; no output can be reconstructed.
    expect(await r.finalizeCall(two.episode, { ...terminal, callId: 'two-call' })).toBe(false);
    const three = await admit('three'); await start(three.episode, 'three-call'); await r.cancel('alice');
    expire(three.episode.id);
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

  it('uses durable leases, epoch takeover fences and atomic rollback of every state write', async () => {
    const first = repo('fences', 400), second = repo('fences', 400);
    await first.open('alice');
    const one = await first.admit('alice', { kind: 'think', text: '', clientMessageId: 'one', workerId: 'worker-a', budget: { calls: 1, timeoutMs: 1000 } });
    expect(await second.recover('alice')).toBe(false);
    const leased = await first.getPerson('alice');
    expect(leased.leaseUntil).toBeInstanceOf(Date);
    expect(leased.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    await expect(second.admit('alice', { kind: 'think', text: '', clientMessageId: 'premature', workerId: 'worker-b', budget: { calls: 1, timeoutMs: 1000 } })).rejects.toMatchObject({ code: 'BUSY' });
    // No runtime heartbeat: this simulates a crashed process, not a fake repository.
    await new Promise(resolve => setTimeout(resolve, 450));
    await second.recover('alice');
    const two = await second.admit('alice', { kind: 'think', text: '', clientMessageId: 'two', workerId: 'worker-b', budget: { calls: 1, timeoutMs: 1000 } });
    await expect(first.commit(one.episode, finalProposal(), { model: 'test/first', effort: null }, 'old-call')).rejects.toMatchObject({ code: 'STALE' });
    await finalize(second, two.episode, 'bad-call');
    const wrong = finalProposal(); wrong.concepts[0].expectedRevision = 100;
    await expect(second.commit(two.episode, wrong, { model: 'test/first', effort: null }, 'bad-call')).rejects.toMatchObject({ code: 'STALE' });
    const afterRollback = await second.snapshot('alice');
    expect(afterRollback.state.version).toBe(0); expect(afterRollback.busy).toBe(true);
    expect(records(second, 'state_commits')).toHaveLength(0);
    await finalize(second, two.episode, 'good-call');
    await second.commit(two.episode, finalProposal(), { model: 'test/first', effort: null }, 'good-call');
    expect((await second.snapshot('alice')).state.version).toBe(1);
    expect((await second.list('alice', 'traces', { limit: 50 })).items.some(t => t.kind === 'interrupted')).toBe(true);
  });

  it('serializes concurrent idempotent admission over separate SQLite workers', async () => {
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
    const children = [0, 1].map(() => fork(new URL('./sqlite-process-admission.js', import.meta.url), [], {
      env: { ...process.env, PERSON_SQLITE_TEST_DIR: yeaftDir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
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
      expect(records(repo('processes'), 'messages')).toHaveLength(1);
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
      service = createPersonService({ namespace: 'native-provider', yeaftDir, embedding: { enabled: false } });
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
      const storedFiles = await readdir(join(yeaftDir, 'person'));
      expect(storedFiles).toContain('person.db');
      expect(storedFiles.some(name => /^storage-[a-f0-9]+\.json$/.test(name))).toBe(true);
      expect(storedFiles).not.toContain('models');
      const traces = await call(service, 'traces');
      expect(JSON.stringify(traces)).not.toContain('local-test-secret');
      expect(traces.items.find(t => t.kind === 'call_output').effective.effortObserved).toBe(true);
    } finally {
      await service?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await rm(yeaftDir, { recursive: true, force: true });
    }
  });

});

const turnResources = [], turnDirs = [];
const turnRequest = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
async function turnSetup(namespace = 'diagnostics', adapter) {
  const dir = await mkdtemp(join(tmpdir(), 'person-turns-')); turnDirs.push(dir);
  const repository = new SqlitePersonRepository({ yeaftDir: dir, namespace, leaseMs: 10000 });
  const service = createPersonService({ yeaftDir: dir, namespace, config, adapter, embedding: { enabled: false }, effortEnabled: true });
  turnResources.push(repository, service);
  await turnRequest(service, 'open');
  return { dir, repository, service };
}
async function turnAdmit(repository, id, ownerId = 'alice') {
  return (await repository.admit(ownerId, { kind: 'think', text: 'private trigger', clientMessageId: id, workerId: 'worker', budget: { calls: 16, timeoutMs: 120000 } })).episode;
}
async function turnStart(repository, episode, callId, index = 0, model = 'test/first') {
  await repository.startCall(episode, { callId, callIndex: index, requested: { model, effort: 'high' }, effective: { model, effort: null },
    selectionOrigin: index ? 'person' : 'bootstrap', reason: 'configured-default',
    manifest: { contextBytes: 500, contextBudgetBytes: 1000, outputTokensReserved: 4096, private: 'manifest-secret' },
    request: { system: 'system-secret', messages: [{ content: 'raw-secret' }] } });
}
const turnOutput = (usage) => ({ text: 'output-secret', usage: usage ? { accountingVersion: 1, ...usage } : usage });
async function turnIdle(service) {
  for (let i = 0; i < 200; i++) {
    const result = await turnRequest(service, 'turns');
    if (result.items[0]?.status !== 'running') return result.items[0];
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('runtime did not finish');
}
afterEach(async () => {
  await Promise.all(turnResources.splice(0).map(resource => resource.close()));
  await Promise.all(turnDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person additive provider usage', () => {
  const consume = async (events, more = {}) => collectOutput({ async *stream() { yield* events; } }, { signal: new AbortController().signal, ...more }, () => {});
  const stop = { type: 'stop', stopReason: 'end_turn' };
  it('adds Anthropic input/turnStart and output deltas with uncached input plus caches; reasoning is a subset', async () => {
    const result = await consume([
      { type: 'usage', inputTokens: 12, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 8 },
      { type: 'usage', inputTokens: 0, outputTokens: 9, reasoningTokens: 4 },
      { type: 'usage', inputTokens: 0, outputTokens: 5, reasoningTokens: 2 }, stop,
    ], { usageCacheIncluded: false });
    expect(result.usage).toEqual({ accountingVersion: 1, inputTokens: 12, outputTokens: 15, reasoningTokens: 6, cacheReadTokens: 30, cacheWriteTokens: 8, cacheTokensAreIncludedInInput: false });
    expect(callUsage(result.usage, true)).toMatchObject({ inputTotalTokens: 50, totalTokens: 65, complete: true });
  });
  it.each(['anthropic', 'openai-responses'])('consumes actual %s adapter events and configured cache semantics', async protocol => {
    const id = protocol === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4.1';
    const provider = await createPersonProvider({ config: {
      providers: [{ name: 'native', protocol, models: [id], baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only' }],
      availableModels: [{ id, ref: `native/${id}`, contextWindow: 128000, maxOutput: 4096 }],
    } });
    const events = protocol === 'anthropic' ? [
      ['message_start', { message: { id: 'msg-test', usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 8 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{}' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } }],
      ['message_stop', {}],
    ] : [['response.completed', { response: { id: 'resp-test', status: 'completed', output: [], usage: { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 4 } } } }]];
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
    try {
      const result = await collectOutput(provider.adapter, { model: provider.defaultSelection.model, system: 'test', messages: [{ role: 'user', content: 'test' }], maxTokens: 4096,
        signal: new AbortController().signal, usageCacheIncluded: provider.catalog[0].usageCacheIncluded }, () => {});
      expect(result.usage.cacheTokensAreIncludedInInput).toBe(protocol !== 'anthropic');
      expect(callUsage(result.usage, true)).toMatchObject({ inputTokens: protocol === 'anthropic' ? 12 : 50, outputTokens: 10, inputTotalTokens: 50, totalTokens: 60, complete: true });
    } finally { fetch.mockRestore(); }
  });
  it.each(['anthropic', 'openai-responses'])('keeps missing %s usage unknown for SSE and JSON instead of inventing zero totals', async protocol => {
    const id = protocol === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4.1';
    const provider = await createPersonProvider({ config: {
      providers: [{ name: 'native', protocol, models: [id], baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only' }],
      availableModels: [{ id, ref: `native/${id}`, contextWindow: 128000, maxOutput: 4096 }],
    } });
    for (const transport of ['sse', 'json']) for (const usage of [undefined, { input_tokens: 5 }, { output_tokens: 2 }, { input_tokens: 0, output_tokens: 0 }]) {
      const complete = usage?.input_tokens === 0 && usage?.output_tokens === 0;
      const body = protocol === 'anthropic' ? { id: 'msg', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage }
        : { id: 'resp', status: 'completed', output: [], usage };
      const events = protocol === 'anthropic' ? [
        ['message_start', { message: { id: 'msg', usage } }],
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: usage === undefined ? undefined : { output_tokens: usage.output_tokens } }],
        ['message_stop', {}],
      ] : [['response.completed', { response: body }]];
      const response = transport === 'json' ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
        : new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      try {
        const result = await collectOutput(provider.adapter, { model: provider.defaultSelection.model, system: 'test', messages: [{ role: 'user', content: 'test' }], maxTokens: 4096,
          signal: new AbortController().signal, usageCacheIncluded: provider.catalog[0].usageCacheIncluded }, () => {});
        expect(callUsage(result.usage, true)).toMatchObject({ totalTokens: complete ? 0 : null, complete });
      } finally { fetch.mockRestore(); }
    }
  });

  it('preserves the OpenAI inclusion flag across events without counting caches or reasoning twice', async () => {
    const result = await consume([
      { type: 'usage', inputTokens: 50, outputTokens: 10, reasoningTokens: 4, cacheReadTokens: 30, cacheTokensAreIncludedInInput: true },
      { type: 'usage', inputTokens: 0, outputTokens: 5 }, stop,
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 50, outputTokens: 15, reasoningTokens: 4, cacheTokensAreIncludedInInput: true });
    expect(callUsage(result.usage, true)).toMatchObject({ inputTotalTokens: 50, totalTokens: 65, complete: true });
  });
  it('retains additive usage before provider failure and marks partial totals incomplete', async () => {
    const error = await consume([
      { type: 'usage', inputTokens: 15, outputTokens: 0, cacheReadTokens: 5, cacheTokensAreIncludedInInput: false },
      { type: 'usage', inputTokens: 0, outputTokens: 7 }, { type: 'error', error: new Error('secret') },
    ]).catch(error => error);
    expect(error.code).toBe('PROVIDER_FAILED');
    expect(callUsage(error.partialOutput.usage, false)).toMatchObject({ inputTokens: 15, outputTokens: 7, totalTokens: 27, complete: false });
  });
  it('does not invent legacy cache totals or missing usage, and rejects nonnumeric token data', () => {
    expect(callUsage({ accountingVersion: 1, inputTokens: 20, outputTokens: 5, cacheReadTokens: 8 }, true)).toMatchObject({ inputTokens: 20, inputTotalTokens: null, totalTokens: null, complete: false });
    expect(callUsage({ inputTokens: 0, outputTokens: 9 }, true)).toMatchObject({ totalTokens: null, complete: false });
    expect(callUsage(null, true)).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, reportedCalls: 0, missingCalls: 1, complete: false });
    expect(callUsage({ inputTokens: '20', outputTokens: -1 }, true).reportedCalls).toBe(0);
  });
});

describe('Person durable turn metadata', () => {
  it('returns complete mixed-model calls independently of raw trace pagination and survives reopening', async () => {
    const { dir, repository, service } = await turnSetup();
    const episode = await turnAdmit(repository, 'mixed');
    await turnStart(repository, episode, 'one');
    await repository.finalizeCall(episode, { callId: 'one', effective: { effort: 'low', effortObserved: true },
      output: turnOutput({ inputTokens: 10, outputTokens: 8, reasoningTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 5, cacheTokensAreIncludedInInput: false }) });
    const capability = { id: 'Recall', args: { query: 'tool-args-secret' } };
    await repository.startCapability(episode, { callId: 'one', capability });
    await repository.finalizeCapability(episode, { callId: 'one', capability, result: { items: [{ text: 'tool-result-secret' }] } });
    await turnStart(repository, episode, 'two', 1, 'test/second');
    await repository.finalizeCall(episode, { callId: 'two', output: turnOutput({ inputTokens: 50, outputTokens: 7, cacheReadTokens: 20, cacheTokensAreIncludedInInput: true }) });
    for (let i = 0; i < 30; i++) await repository.append(episode, 'activity', { summary: 'activity-secret' });
    await repository.finish(episode, 'completed', null);
    expect((await turnRequest(service, 'traces', { limit: 20 })).items.some(item => item.kind === 'call_started')).toBe(false);
    const result = await turnRequest(service, 'turns');
    expect(result.nextCursor).toBeNull();
    const turn = result.items[0];
    expect(turn).toMatchObject({ id: episode.id, seq: 1, kind: 'think', status: 'completed', terminalCode: null,
      budget: { calls: 16, timeoutMs: 120000 }, models: ['test/first', 'test/second'],
      usage: { inputTokens: 60, outputTokens: 15, reasoningTokens: 2, cacheReadTokens: 50, cacheWriteTokens: 5, inputTotalTokens: 95, totalTokens: 110, reportedCalls: 2, missingCalls: 0, complete: true } });
    expect(turn.calls).toHaveLength(2);
    expect(turn.calls[0]).toMatchObject({ callId: 'one', index: 1, status: 'completed', requested: { model: 'test/first', effort: 'high' },
      dispatched: { model: 'test/first' }, effective: { model: null, effort: 'low' }, selectionOrigin: 'bootstrap',
      contextBytes: 500, contextBudgetBytes: 1000, outputTokensReserved: 4096, capability: { id: 'Recall', status: 'completed', code: null } });
    expect(turn.calls[1]).toMatchObject({ index: 2, dispatched: { model: 'test/second' }, effective: { model: null, effort: null } });
    expect(typeof turn.createdAt).toBe('string'); expect(typeof turn.endedAt).toBe('string');
    expect(JSON.stringify(result)).not.toMatch(/secret|private trigger|ownerId|namespace|personId|system|arguments/);
    await service.close(); await repository.close();
    const reopened = createPersonService({ yeaftDir: dir, namespace: 'diagnostics', config, embedding: { enabled: false } }); turnResources.push(reopened);
    expect(await turnRequest(reopened, 'turns')).toEqual(result);
  });

  it('does not mark legacy overwritten Anthropic output deltas as exact usage', async () => {
    const { repository, service } = await turnSetup(); const episode = await turnAdmit(repository, 'legacy');
    await turnStart(repository, episode, 'old');
    await repository.finalizeCall(episode, { callId: 'old', output: { text: 'old', usage: { inputTokens: 0, outputTokens: 9 } } });
    await repository.finish(episode, 'completed', null);
    const turn = (await turnRequest(service, 'turns')).items[0];
    expect(turn.usage).toMatchObject({ totalTokens: null, complete: false });
    expect(turn.calls[0].usage).toMatchObject({ inputTokens: 0, outputTokens: 9, totalTokens: null, complete: false });
  });

  it('includes zero-call accepted turns, running calls and partial failed/cancelled/missing provider usage', async () => {
    const { repository, service } = await turnSetup();
    const episode = await turnAdmit(repository, 'pending');
    let turn = (await turnRequest(service, 'turns')).items[0];
    expect(turn).toMatchObject({ status: 'running', calls: [], models: [], usage: { reportedCalls: 0, missingCalls: 0, complete: false, totalTokens: 0 } });
    await turnStart(repository, episode, 'missing');
    turn = (await turnRequest(service, 'turns')).items[0];
    expect(turn.calls[0]).toMatchObject({ status: 'running', endedAt: null, usage: { missingCalls: 1, complete: false, totalTokens: null } });
    await repository.finalizeCall(episode, { callId: 'missing', output: turnOutput(null) });
    await turnStart(repository, episode, 'partial', 1);
    await repository.finalizeCall(episode, { callId: 'partial', code: 'PROVIDER_FAILED', output: turnOutput({ inputTokens: 9, outputTokens: 2, cacheReadTokens: 4, cacheTokensAreIncludedInInput: false }) });
    await repository.finish(episode, 'failed', 'PROVIDER_FAILED');
    turn = (await turnRequest(service, 'turns')).items[0];
    expect(turn).toMatchObject({ status: 'failed', terminalCode: 'PROVIDER_FAILED', usage: { inputTokens: 9, outputTokens: 2, reportedCalls: 1, missingCalls: 1, totalTokens: null, complete: false } });
    expect(turn.calls[1]).toMatchObject({ status: 'failed', code: 'PROVIDER_FAILED', usage: { inputTotalTokens: 13, totalTokens: 15, complete: false } });
    const cancelled = await turnAdmit(repository, 'cancelled'); await turnStart(repository, cancelled, 'cancel');
    await repository.cancel('alice', cancelled.id);
    await repository.finalizeCall(cancelled, { callId: 'cancel', output: turnOutput({ inputTokens: 6, outputTokens: 3 }) });
    turn = (await turnRequest(service, 'turns')).items[0];
    expect(turn.calls[0]).toMatchObject({ status: 'cancelled', code: 'CANCELLED', usage: { inputTokens: 6, outputTokens: 3, complete: false } });
  });

  it('projects running, failed and after-terminal capability results without raw arguments or output', async () => {
    const { repository, service } = await turnSetup();
    const episode = await turnAdmit(repository, 'tools');
    await turnStart(repository, episode, 'tool-call');
    await repository.finalizeCall(episode, { callId: 'tool-call', output: turnOutput({ inputTokens: 3, outputTokens: 2 }) });
    const capability = { id: 'Recall', args: { query: 'tool-secret' } };
    await repository.startCapability(episode, { callId: 'tool-call', capability });
    expect((await turnRequest(service, 'turns')).items[0].calls[0].capability).toEqual({ id: 'Recall', status: 'running', code: null });
    await repository.finalizeCapability(episode, { callId: 'tool-call', capability, result: { ok: false, code: 'UNSUPPORTED', error: 'tool-secret' } });
    expect((await turnRequest(service, 'turns')).items[0].calls[0].capability).toEqual({ id: 'Recall', status: 'failed', code: 'UNSUPPORTED' });
    await turnStart(repository, episode, 'late-call', 1);
    await repository.finalizeCall(episode, { callId: 'late-call', output: turnOutput({ inputTokens: 3, outputTokens: 2 }) });
    await repository.startCapability(episode, { callId: 'late-call', capability });
    await repository.cancel('alice', episode.id);
    await repository.finalizeCapability(episode, { callId: 'late-call', capability, result: { ok: true, text: 'tool-secret' } });
    const result = await turnRequest(service, 'turns');
    expect(result.items[0]).toMatchObject({ status: 'cancelled', terminalCode: 'CANCELLED' });
    expect(result.items[0].calls[1].capability).toEqual({ id: 'Recall', status: 'completed', code: 'CANCELLED' });
    expect(JSON.stringify(result)).not.toContain('tool-secret');
  });

  it('pages exclusive numeric watermarks, isolates owner/namespace, and does not recover expired leases or dispatch providers', async () => {
    const invoke = vi.fn();
    const { dir, repository, service } = await turnSetup('paging', { stream: invoke });
    for (let i = 1; i <= 23; i++) { const episode = await turnAdmit(repository, `turn-${i}`); await repository.finish(episode, 'failed', 'PROVIDER_FAILED'); }
    await repository.open('bob');
    const bob = await turnAdmit(repository, 'bob', 'bob'); await repository.finish(bob, 'failed', 'PROVIDER_FAILED');
    const foreign = new SqlitePersonRepository({ yeaftDir: dir, namespace: 'foreign', leaseMs: 10000 }); turnResources.push(foreign);
    await foreign.open('alice'); const other = await turnAdmit(foreign, 'foreign'); await foreign.finish(other, 'failed', 'PROVIDER_FAILED');
    const first = await turnRequest(service, 'turns');
    expect(first.items.map(item => item.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 23 - i));
    expect(first.nextCursor).toBe(4);
    const second = await turnRequest(service, 'turns', { cursor: first.nextCursor });
    expect(second.items.map(item => item.seq)).toEqual([3, 2, 1]); expect(second.nextCursor).toBeNull();
    expect((await turnRequest(service, 'turns', {}, 'bob')).items.map(item => item.id)).toEqual([bob.id]);
    expect(first.items.some(item => item.id === other.id)).toBe(false);
    const pending = await turnAdmit(repository, 'expired');
    const db = new DatabaseSync(repository.dbPath);
    try {
      const values = repository.scope('alice');
      db.prepare("UPDATE persons SET record = json_set(record, '$.leaseUntil', '2000-01-01T00:00:00.000Z') WHERE namespace = ? AND ownerId = ? AND personId = ?").run(values.namespace, values.ownerId, values.personId);
      const before = db.prepare('SELECT record FROM persons WHERE namespace = ? AND ownerId = ?').get('paging', 'alice').record;
      expect((await turnRequest(service, 'turns')).items[0]).toMatchObject({ id: pending.id, status: 'running', calls: [] });
      expect(db.prepare('SELECT record FROM persons WHERE namespace = ? AND ownerId = ?').get('paging', 'alice').record).toBe(before);
    } finally { db.close(); }
    expect(invoke).not.toHaveBeenCalled();
    await expect(turnRequest(service, 'turns', {}, 'absent')).rejects.toMatchObject({ code: 'NOT_OPEN' });
  });

  it.each([{ cursor: '2' }, { cursor: 0 }, { cursor: -1 }, { cursor: 1.5 }, { cursor: Number.MAX_SAFE_INTEGER + 1 }, { limit: 21 }, { limit: 0 }, { limit: null }, { ownerId: 'bob' }])('validates pages before repository work: %j', async payload => {
    const { service, repository } = await turnSetup();
    await expect(turnRequest(service, 'turns', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    if (!Object.hasOwn(payload, 'ownerId')) await expect(repository.turns('alice', payload)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('records usage and model changes through a real multi-loop runtime', async () => {
    let calls = 0;
    const adapter = { async *stream(params) {
      const context = JSON.parse(params.messages[0].content), proposal = finalProposal(context.state.version);
      proposal.concepts = []; proposal.state.focusConceptIds = [];
      calls++;
      params.onEffortDecision?.({ effective: calls === 1 ? null : 'low', model: 'untrusted-model', wireMode: 'test' });
      if (calls === 1) proposal.next = { model: 'test/second', effort: 'high', reason: 'Try another model.', capability: { id: 'catalog.view', args: { id: 'Recall' } } };
      yield { type: 'text_delta', text: JSON.stringify(proposal) };
      yield { type: 'usage', inputTokens: 20, outputTokens: 10, cacheReadTokens: 8, cacheTokensAreIncludedInInput: true };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const { service } = await turnSetup('runtime', adapter);
    await turnRequest(service, 'send', { text: 'hello', clientMessageId: 'runtime' });
    const turn = await turnIdle(service);
    expect(turn).toMatchObject({ status: 'completed', models: ['test/first', 'test/second'], usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, complete: true } });
    expect(turn.calls.map(call => call.index)).toEqual([1, 2]);
    expect(turn.calls[0].capability).toEqual({ id: 'catalog.view', status: 'completed', code: null });
    expect(turn.calls[1]).toMatchObject({ selectionOrigin: 'person', requested: { effort: 'high' }, effective: { model: null, effort: 'low' } });
    expect(calls).toBe(2);
  });
});
