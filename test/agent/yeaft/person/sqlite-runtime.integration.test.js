import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { DatabaseSync } from 'node:sqlite';

import { config, finalProposal } from './fixtures.js';

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

  // Age only isolated fixture records; production runtime uses authoritative wall time.

  it('replans a truncated proposal once within the output allowance, retaining evidence and never replaying tools', async () => {
    let count = 0, adapterError;
    const executed = vi.spyOn(PersonCapabilities.prototype, 'execute');
    const service = create('truncated-recovery', { async *stream(params) {
      try {
        const context = JSON.parse(params.messages[0].content);
        count++;
        expect(context.budget.maxOutputTokens).toBe(params.maxTokens);
        expect(context.budget).not.toHaveProperty('remainingCalls');
        if (count === 2) {
          yield { type: 'text_delta', text: '{"next":{"capability":{"id":"FileWrite","args":{"content":"truncated-tool-payload-marker' };
          yield { type: 'usage', inputTokens: 50, outputTokens: 4096 };
          yield { type: 'stop', stopReason: 'max_tokens' }; return;
        }
        const p = finalProposal();
        if (count === 1) p.next = { model: 'test/first', effort: null, reason: 'Inspect a contract.', capability: { id: 'catalog.view', args: { id: 'FileWrite' } } };
        else {
          expect(context.outputRecovery).toMatchObject({ code: 'OUTPUT_TRUNCATED', rejectedBeforeExecution: true });
          expect(context.capabilityResult.id).toBe('FileWrite');
          expect(context.previousProposal.next.capability.id).toBe('catalog.view');
          expect(JSON.stringify(context)).not.toContain('truncated-tool-payload-marker');
        }
        yield { type: 'text_delta', text: JSON.stringify(p) };
        yield { type: 'usage', inputTokens: 10, outputTokens: 20 };
        yield { type: 'stop', stopReason: 'end_turn' };
      } catch (error) { adapterError = error; throw error; }
    } }, { maxCalls: 3 });
    try {
      await call(service, 'open'); await call(service, 'send', { text: 'Build a large script.', clientMessageId: 'recover' });
      const snapshot = await waitIdle(service);
      if (adapterError) throw adapterError;
      expect(snapshot.latestEpisode.status).toBe('completed'); expect(snapshot.state.version).toBe(1);
      expect(executed.mock.calls.map(([invocation]) => invocation.id)).toEqual(['catalog.view']);
      const turn = (await call(service, 'turns')).items[0];
      expect(turn.calls).toHaveLength(3);
      expect(turn.calls[1]).toMatchObject({ status: 'failed', code: 'OUTPUT_TRUNCATED', usage: { outputTokens: 4096 } });
      expect(turn.calls[2].selectionOrigin).toBe('output-recovery');
      expect(turn.usage).toMatchObject({ outputTokens: 4136, inputTokens: 70 });
      const traces = (await call(service, 'traces', { limit: 50 })).items;
      expect(traces.filter(t => t.kind === 'call_failed')).toHaveLength(1);
      expect(traces.filter(t => t.kind === 'capability_started')).toHaveLength(1);
      expect(traces.find(t => t.kind === 'call_failed').output).toMatchObject({ complete: false, accepted: false, stopReason: 'max_tokens' });
    } finally { executed.mockRestore(); }
  });

  it('retains a successful host write as recovery evidence and never replays its effects', async () => {
    const file = join(yeaftDir, 'recovery-once.txt');
    let count = 0, adapterError;
    const executions = vi.spyOn(PersonCapabilities.prototype, 'execute');
    const service = create('truncated-after-write', { async *stream(params) {
      try {
        count++;
        const context = JSON.parse(params.messages[0].content), p = finalProposal();
        if (count === 3) {
          yield { type: 'text_delta', text: '{"reply":"rejected-fragment-marker' };
          yield { type: 'usage', outputTokens: 4096 };
          yield { type: 'stop', stopReason: 'max_tokens' }; return;
        }
        if (count <= 2) p.next = { model: 'test/first', effort: null, reason: 'Write once.', capability: count === 1
          ? { id: 'catalog.view', args: { id: 'FileWrite' } }
          : { id: 'FileWrite', args: { file_path: file, content: 'written-once' } } };
        else {
          expect(context.outputRecovery.rejectedBeforeExecution).toBe(true);
          expect(context.capabilityResult).toMatchObject({ id: 'FileWrite', ok: true, sourceRef: expect.stringMatching(/^tool:/) });
          expect(context.sourceRefs).toContain(context.capabilityResult.sourceRef);
          expect(context.previousProposal.next.capability.id).toBe('FileWrite');
          expect(JSON.stringify(context)).not.toContain('rejected-fragment-marker');
          expect(await readFile(file, 'utf8')).toBe('written-once');
        }
        yield { type: 'text_delta', text: JSON.stringify(p) };
        yield { type: 'stop', stopReason: 'end_turn' };
      } catch (error) { adapterError = error; throw error; }
    } }, { maxCalls: 4 });
    try {
      await call(service, 'open'); await call(service, 'send', { text: 'Write and report.', clientMessageId: 'write-recovery' });
      const snapshot = await waitIdle(service);
      if (adapterError) throw adapterError;
      expect(snapshot.latestEpisode.status).toBe('completed');
      expect(executions.mock.calls.map(([invocation]) => invocation.id)).toEqual(['catalog.view', 'FileWrite']);
      expect((await call(service, 'turns')).items[0].calls.map(c => c.status)).toEqual(['completed', 'completed', 'failed', 'completed']);
    } finally { executions.mockRestore(); }
  });

  it('can cancel a recovery without a late commit or additional retry', async () => {
    let count = 0, started;
    const recoveryStarted = new Promise(resolve => { started = resolve; });
    const service = create('truncated-cancel', { async *stream({ signal }) {
      count++;
      if (count === 1) { yield { type: 'text_delta', text: '{' }; yield { type: 'stop', stopReason: 'max_tokens' }; return; }
      started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } });
    await call(service, 'open'); await call(service, 'think', { text: '', clientMessageId: 'cancel-recovery' });
    await recoveryStarted; await call(service, 'cancel');
    const snapshot = await waitIdle(service);
    expect(snapshot.latestEpisode.status).toBe('cancelled'); expect(snapshot.state.version).toBe(0); expect(count).toBe(2);
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
    expect(seen.every(s => !Object.hasOwn(s.context.budget, 'remainingCalls'))).toBe(true);
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

  it('retains consumed output exactly once on remote cancellation without a late state commit', async () => {
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
    const a = create('cancel-remote', adapter, { leaseMs: 1200 });
    const b = create('cancel-remote', adapterFor(() => finalProposal()));
    await call(a, 'open');
    const admitted = await call(a, 'send', { text: 'cancel me', clientMessageId: 'cancel' });
    await providerConsumed;
    await expect(call(b, 'think', { text: '', clientMessageId: 'other' })).rejects.toMatchObject({ code: 'BUSY' });
    expect(await call(b, 'cancel', { episodeId: admitted.episodeId })).toMatchObject({ cancelled: true });
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

afterEach(async () => {
  await Promise.all(turnResources.splice(0).map(resource => resource.close()));
  await Promise.all(turnDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person durable turn metadata', () => {
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
      const executions = await turnRequest(service, 'executions');
      expect(executions.main).toBeNull();
      expect(executions.items[0]).toMatchObject({ id: pending.id, status: 'running', calls: [] });
      expect(db.prepare('SELECT record FROM persons WHERE namespace = ? AND ownerId = ?').get('paging', 'alice').record).toBe(before);
    } finally { db.close(); }
    expect(invoke).not.toHaveBeenCalled();
    await expect(turnRequest(service, 'turns', {}, 'absent')).rejects.toMatchObject({ code: 'NOT_OPEN' });
  });
});
