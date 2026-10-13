import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { createPersonService } from './fixture-adapter.js';
import { config, finalProposal } from './fixtures.js';

// Real runtime lifecycle against an isolated SQLite authority, with scripted inference.
describe('Person real SQLite runtime integration', () => {
  let yeaftDir;
  const services = [];
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
    await rm(yeaftDir, { recursive: true, force: true });
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
          expect(context.previousProposal).not.toHaveProperty('next');
          expect(params.messages.flatMap(m => m.toolCalls ?? []).filter(t => t.name === 'FileWrite')).toHaveLength(1);
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
      expect((await call(service, 'turns')).items[0].calls.map(c => c.status)).toEqual(['completed', 'completed', 'failed', 'completed', 'completed']);
    } finally { executions.mockRestore(); }
  });

  it('uses the real native config/router/Anthropic adapter without creating a Session', async () => {
    const yeaftDir = await mkdtemp(join(tmpdir(), 'person-native-config-'));
    const requests = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const wire = JSON.parse(body); requests.push({ path: req.url, body: wire });
      const content = wire.messages[0].content;
      const context = JSON.parse(typeof content === 'string' ? content : content[0].text);
      const cognition = !wire.tools?.length;
      const proposal = finalProposal(context.state.version); proposal.reply = null;
      const result = cognition ? JSON.stringify(proposal) : 'Native catalog inspected.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);
      event('message_start', { message: { id: `local-test-${requests.length}`, type: 'message', role: 'assistant', model: 'person-test-model', content: [], usage: { input_tokens: 20, output_tokens: 0 } } });
      if (requests.length === 1) {
        // Exercise the real Anthropic tool_use parser, not the legacy fixture conversion.
        event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'native-search', name: 'catalog__search', input: {} } });
        event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: 'memory', limit: 1 }) } });
      } else {
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: result } });
      }
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 50 } });
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
      expect(requests).toHaveLength(3);
      expect(requests.every(request => request.path === '/v1/messages' && request.body.model === 'person-test-model')).toBe(true);
      expect(requests.slice(0, 2).every(request => request.body.tools.some(tool => tool.name === 'catalog__search'))).toBe(true);
      expect(requests[1].body.messages.flatMap(message => message.content).find(block => block.type === 'tool_use'))
        .toMatchObject({ id: 'native-search', name: 'catalog__search', input: { query: 'memory', limit: 1 } });
      expect(requests[1].body.messages.flatMap(message => message.content).find(block => block.type === 'tool_result'))
        .toMatchObject({ tool_use_id: 'native-search' });
      expect(requests[2].body.tools ?? []).toEqual([]);
      expect(snapshot.messages.map(message => message.text)).toEqual(['Native roundtrip.', 'Native catalog inspected.']);
      expect((await call(service, 'turns')).items[0].calls.map(modelCall => modelCall.protocol)).toEqual(['native-tools', 'native-tools', 'cognition']);
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
    // This tests cancellation finalization, not lease expiry. Leave enough
    // authority time for a loaded CI host to persist the captured prefix.
    const a = create('cancel-remote', adapter, { leaseMs: 10000, nativeFixture: false });
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
});
