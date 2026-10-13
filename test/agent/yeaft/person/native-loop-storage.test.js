import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { bytes, digest } from '../../../../agent/yeaft/person/contracts.js';
import { finalProposal } from './fixtures.js';

const selection = { model: 'test/native', effort: null };
const admission = () => ({ kind: 'send', text: 'Inspect the current work.', clientMessageId: randomUUID(), workerId: 'worker', budget: { calls: 16 } });
const wire = (id, input = {}, toolId = randomUUID(), more = {}) => ({ id: toolId, name: id.replaceAll('.', '__'), input, ...more });
const invocation = (modelCallId, tool, toolIndex, more = {}) => ({ callId: randomUUID(), modelCallId, toolUseId: tool.id, toolIndex,
  capability: { id: tool.name.replaceAll('__', '.'), args: tool.input }, ...more });
const usage = { accountingVersion: 1, inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1,
  cacheTokensAreIncludedInInput: false };
const rich = summary => ({ summary, phase: 'final', blocks: [{ type: 'markdown', text: summary }] });
const definition = () => ({ id: 'Script.echo', expectedVersion: 0, description: 'Return JSON input.', useWhen: 'A pure identity transformation is useful.',
  avoidWhen: '', inputDescription: 'JSON', outputDescription: 'Unchanged JSON', code: 'return input;', tests: [{ input: { x: 1 }, expected: { x: 1 } }] });
const evidence = () => ({ engine: 'quickjs', testsPassed: 1, testedAt: new Date().toISOString() });

// Managed worker + real temporary SQLite only: never create a Session or use an instance DB.
describe('native tool loop SQLite proof and diagnostics', () => {
  let root, repositories, r, episode;
  const repo = (namespace = 'default') => {
    const repository = new SqlitePersonRepository({ yeaftDir: root, namespace, leaseMs: 60000 });
    repositories.push(repository); return repository;
  };
  const sql = fn => { const db = new DatabaseSync(r.dbPath); try { return fn(db); } finally { db.close(); } };
  const traces = () => sql(db => db.prepare('SELECT record FROM traces WHERE ownerId = ? AND namespace = ? ORDER BY seq').all('alice', 'default').map(row => JSON.parse(row.record)));
  const complete = async (tools = [], more = {}, callIndex = 0) => {
    const callId = randomUUID();
    await r.startCall(episode, { callId, callIndex, requested: selection, manifest: { sourceRefs: [], privateSecret: 'do-not-project' } });
    const output = { text: '', protocol: 'native-tools', toolCalls: tools, usage, stopReason: tools.length ? 'tool_use' : 'end_turn', ...more };
    output.bytes ??= bytes(output.text) + tools.reduce((total, tool) => total + bytes(tool), 0);
    expect(await r.finalizeCall(episode, { callId, output, requestElapsedMs: 25 })).toBe(true);
    return callId;
  };
  const finalize = (started, result = { ok: true, output: 'observed result' }, more = {}) => r.finalizeCapability(episode, {
    callId: started.callId, capability: started.capability, result, ...more });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'person-native-storage-')); repositories = [];
    r = repo(); await r.open('alice'); episode = (await r.admit('alice', admission())).episode;
  });
  afterEach(async () => { await Promise.all(repositories.map(repository => repository.close())); await rm(root, { recursive: true, force: true }); });

  it('persists multiple repeated-name tools under one provider request, with independent readback and usage across reopen', async () => {
    const tools = [wire('Bash', { command: 'first' }, 'provider/id:+中文'), wire('Bash', { command: 'second' }), wire('Execution.read', { callId: 'known' })];
    const parent = await complete(tools, { providerState: { signature: 'hidden-signature' }, continuationState: { reasoning: 'hidden-reasoning' } });
    const started = tools.map((tool, index) => invocation(parent, tool, index));
    const raw = '中😀"\\\n'.repeat(1400);
    for (const [index, item] of started.entries()) {
      await r.startCapability(episode, item);
      expect(await finalize(item, { ok: true, output: index === 0 ? raw : `result-${index}` })).toBe(true);
    }
    const archived = traces().find(trace => trace.kind === 'call_output').output;
    expect(archived).toMatchObject({ protocol: 'native-tools', toolCalls: tools, complete: true, bytes: tools.reduce((n, tool) => n + bytes(tool), 0) });
    expect(JSON.stringify(archived)).not.toMatch(/hidden-signature|hidden-reasoning|providerState|continuationState/);
    await r.close(); r = repo();
    let offset = 0, restored = '';
    do {
      const page = await r.executionRead(episode, { callId: started[0].callId, offset, maxBytes: 499 });
      expect(page).toMatchObject({ modelCallId: parent, toolUseId: tools[0].id, toolIndex: 0, capabilityId: 'Bash', args: tools[0].input, authority: 'evidence-only' });
      restored += page.output; offset = page.nextOffset;
      if (page.eof) break;
    } while (true);
    expect(restored).toBe(raw);
    await expect(r.executionRead(episode, { callId: parent })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await r.finish(episode, 'failed', 'INTERRUPTED');
    const turn = (await r.turns('alice')).items[0];
    expect(turn).toMatchObject({ loopCount: 1, detailsTruncated: false, usage: { inputTokens: 10, outputTokens: 4, inputTotalTokens: 14, totalTokens: 18, reportedCalls: 1, complete: true } });
    expect(turn.calls[0].capabilities.map(item => [item.callId, item.toolUseId, item.id, item.status])).toEqual(started.map(item => [item.callId, item.toolUseId, item.capability.id, 'completed']));
    expect(turn.calls[0]).toMatchObject({ callId: parent, protocol: 'native-tools', elapsedMs: 25 });
    expect(turn.calls[0]).not.toHaveProperty('capability');
    expect(JSON.stringify(turn)).not.toMatch(/do-not-project|first|second|observed result|hidden-/);
    expect(await readdir(root)).toEqual(['person']);
  });

  it('rejects wrong ID/name/input/index/parent, duplicate consumption and trace ID collisions', async () => {
    const tools = [wire('Bash', { command: 'first' }), wire('Bash', { command: 'second' })];
    const parent = await complete(tools), original = invocation(parent, tools[0], 0);
    const other = await complete([wire('Recall', { kind: 'concepts' })], {}, 1);
    for (const forged of [
      { ...original, modelCallId: other }, { ...original, modelCallId: randomUUID() }, { ...original, toolUseId: tools[1].id },
      { ...original, toolIndex: 1 }, { ...original, toolIndex: -1 }, { ...original, toolIndex: 0.5 },
      { ...original, capability: { id: 'FileRead', args: tools[0].input } },
      { ...original, capability: { id: 'Bash', args: { command: 'forged' } } }, { ...original, callId: parent },
    ]) await expect(r.startCapability(episode, forged)).rejects.toMatchObject({ code: 'STALE' });
    await r.startCapability(episode, original); expect(await finalize(original)).toBe(true);
    await expect(r.startCapability(episode, { ...original, callId: randomUUID() })).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.startCall(episode, { callId: original.callId, requested: selection })).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.startCall(episode, { callId: parent, requested: selection })).rejects.toMatchObject({ code: 'STALE' });
    const second = invocation(parent, tools[1], 1);
    await r.startCapability(episode, second); expect(await finalize(second)).toBe(true);
    // Provider IDs are request-local: a later request may reuse them exactly once.
    const reused = wire('Bash', { command: 'third' }, tools[0].id), later = await complete([reused], {}, 2);
    const third = invocation(later, reused, 0); await r.startCapability(episode, third); expect(await finalize(third)).toBe(true);
  });

  it('cannot forge complete call proof via append, failed/partial output or a cognition marker', async () => {
    const tool = wire('Bash', { command: 'never execute' }), callId = randomUUID();
    await expect(r.append(episode, 'call_output', { callId, output: { complete: true, protocol: 'native-tools', toolCalls: [tool] } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await r.startCall(episode, { callId, requested: selection });
    await r.finalizeCall(episode, { callId, code: 'PROVIDER_FAILED', output: { text: 'partial', protocol: 'native-tools', toolCalls: [tool], usage, stopReason: 'tool_use' } });
    expect(traces().find(trace => trace.kind === 'call_failed').output).toMatchObject({ complete: false, accepted: false, toolCalls: [tool], usage });
    await expect(r.startCapability(episode, invocation(callId, tool, 0))).rejects.toMatchObject({ code: 'STALE' });
    // A partial response without an explicit caller error is still not authority.
    const partial = randomUUID(); await r.startCall(episode, { callId: partial, requested: selection });
    await r.finalizeCall(episode, { callId: partial, output: { text: 'partial', complete: false, protocol: 'native-tools', toolCalls: [tool] } });
    expect(traces().find(trace => trace.callId === partial && trace.kind === 'call_failed').output.complete).toBe(false);
    await expect(r.startCapability(episode, invocation(partial, tool, 0))).rejects.toMatchObject({ code: 'STALE' });
    const cognition = randomUUID(); await r.startCall(episode, { callId: cognition, requested: selection });
    await r.finalizeCall(episode, { callId: cognition, output: { text: '{}', protocol: 'cognition' } });
    await expect(r.startCapability(episode, { callId: cognition, capability: { id: 'Bash', args: {} } })).rejects.toMatchObject({ code: 'STALE' });
    const unmarked = randomUUID(); await r.startCall(episode, { callId: unmarked, requested: selection });
    await expect(r.finalizeCall(episode, { callId: unmarked, output: { text: '', toolCalls: [tool] } })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await r.finalizeCall(episode, { callId: unmarked, code: 'INVALID_REQUEST' });
  });

  it('binds multiple presentation and output publications to distinct tools, not their shared model call', async () => {
    const tools = [wire('PresentResponse', rich('First verified response')), wire('PresentResponse', rich('Second verified response')),
      wire('Output.publish', { url: 'https://example.com/one', title: 'One' }), wire('Output.publish', { url: 'https://example.com/two', title: 'Two' })];
    const parent = await complete(tools), started = tools.map((tool, index) => invocation(parent, tool, index));
    const publications = [];
    for (const [index, item] of started.entries()) {
      await r.startCapability(episode, item);
      if (index < 2) {
        const published = await r.savePresentation(episode, { callId: item.callId, args: tools[index].input });
        expect((await r.savePresentation(episode, { callId: item.callId, args: tools[index].input })).id).toBe(published.id);
        await expect(r.savePresentation(episode, { callId: parent, args: tools[index].input })).rejects.toMatchObject({ code: 'STALE' });
        await finalize(item); publications.push(published);
        expect((await r.savePresentation(episode, { callId: item.callId, args: tools[index].input })).id).toBe(published.id);
      } else {
        const args = tools[index].input, record = { kind: 'link', title: args.title, mimeType: null, size: 0, url: args.url };
        await expect(r.checkOutputPublication(episode, { callId: parent, args })).rejects.toMatchObject({ code: 'STALE' });
        expect(await r.checkOutputPublication(episode, { callId: item.callId, args })).toBe(true);
        const published = await r.saveOutput(episode, { callId: item.callId, args, record, data: null });
        await expect(r.saveOutput(episode, { callId: item.callId, args, record, data: null })).rejects.toMatchObject({ code: 'STALE' });
        publications.push(published); await finalize(item);
      }
    }
    expect(new Set(publications.map(item => item.id)).size).toBe(4);
    await r.cancel('alice');
    const snapshot = await r.snapshot('alice');
    expect(snapshot.messages.filter(message => message.presentation).map(message => message.text)).toEqual(['First verified response', 'Second verified response']);
    expect(snapshot.outputs.items.map(item => item.title)).toEqual(['Two', 'One']);
    expect(snapshot.state.version).toBe(0);
  });

  it('revalidates the original started invocation for presentation, output and created capability proof', async () => {
    const def = definition();
    const tools = [wire('PresentResponse', rich('Original')), wire('Output.publish', { url: 'https://example.com/real' }), wire('Capability.create', def)];
    const parent = await complete(tools);
    for (const [index, tool] of tools.entries()) {
      const started = invocation(parent, tool, index); await r.startCapability(episode, started);
      const original = sql(db => JSON.parse(db.prepare('SELECT record FROM episodes WHERE id = ?').get(episode.id).record));
      // Simulate corrupt/tampered slot, including a recomputed hash; original
      // append-only started data and the provider batch must both still agree.
      const forged = structuredClone(original);
      forged.openCapability.toolIndex = (index + 1) % tools.length;
      forged.openCapability.toolUseId = tools[forged.openCapability.toolIndex].id;
      forged.openCapability.invocationHash = digest(forged.openCapability.capability);
      sql(db => db.prepare('UPDATE episodes SET record = ? WHERE id = ?').run(JSON.stringify(forged), episode.id));
      if (index === 0) await expect(r.savePresentation(episode, { callId: started.callId, args: tool.input })).rejects.toMatchObject({ code: 'STALE' });
      if (index === 1) await expect(r.checkOutputPublication(episode, { callId: started.callId, args: tool.input })).rejects.toMatchObject({ code: 'STALE' });
      if (index === 2) await expect(r.saveCreatedCapability(episode, { callId: started.callId, definition: def, evidence: evidence() })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      sql(db => db.prepare('UPDATE episodes SET record = ? WHERE id = ?').run(JSON.stringify(original), episode.id));
      if (index === 2) {
        await expect(r.saveCreatedCapability(episode, { callId: parent, definition: def, evidence: evidence() })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        const created = await r.saveCreatedCapability(episode, { callId: started.callId, definition: def, evidence: evidence() });
        expect(created).toMatchObject({ id: def.id, version: 1, createdCallId: started.callId, createdEpisodeId: episode.id });
      }
      await finalize(started);
    }
    await r.close(); r = repo(); expect((await r.createdCapabilities(episode))[0].id).toBe(def.id);
  });

  it('durably publishes native final text without cadence, survives cognition failure and dedupes final commit', async () => {
    const reply = 'Actual completed result.';
    const parent = await complete([], { text: reply });
    const delivered = await r.publishProgress(episode, { callId: parent, reply, final: true });
    expect(delivered).toMatchObject({ text: reply, replyKind: 'execution-final' });
    expect((await r.publishProgress(episode, { callId: parent, reply, final: true })).id).toBe(delivered.id);
    await r.finish(episode, 'failed', 'INVALID_PROPOSAL');
    expect((await r.snapshot('alice')).messages.at(-1).text).toBe(reply);
    episode = (await r.admit('alice', admission())).episode;
    const second = await complete([], { text: reply });
    await r.publishProgress(episode, { callId: second, reply, final: true });
    const p = finalProposal(episode.baseStateVersion);
    p.reply = reply; p.concepts = []; p.state.focusConceptIds = [];
    const cognition = randomUUID();
    await r.startCall(episode, { callId: cognition, requested: selection });
    await r.finalizeCall(episode, { callId: cognition, output: { text: JSON.stringify(p), protocol: 'cognition', stopReason: 'end_turn' } });
    await r.commit(episode, p, selection, cognition);
    expect((await r.snapshot('alice')).messages.filter(m => m.episodeId === episode.id && m.role === 'assistant')).toHaveLength(1);
  });

  it('drains cancelled provider output and native tool outcome without restoring authority or accepting a second finalize', async () => {
    const tool = wire('Bash', { command: 'running effect' }), parent = await complete([tool]);
    const started = invocation(parent, tool, 0); await r.startCapability(episode, started);
    await r.cancel('alice');
    expect(await finalize(started, { ok: true, output: 'effect completed after cancellation' })).toBe(false);
    expect(await finalize(started)).toBe(false);
    const turn = (await r.turns('alice')).items[0];
    expect(turn.calls[0].capabilities[0]).toMatchObject({ callId: started.callId, modelCallId: parent, afterTerminal: true, accepted: false, terminalCode: 'CANCELLED' });
    const next = (await r.admit('alice', admission())).episode;
    const read = await r.executionRead(next, { episodeId: episode.id, callId: started.callId });
    expect(read).toMatchObject({ output: 'effect completed after cancellation', historical: true, authority: 'evidence-only', accepted: false, modelCallId: parent });
    await expect(r.startCapability(next, { ...started, callId: randomUUID() })).rejects.toMatchObject({ code: 'STALE' });
    const callId = randomUUID(); await r.startCall(next, { callId, requested: selection }); await r.cancel('alice');
    expect(await r.finalizeCall(next, { callId, output: { text: 'late text', protocol: 'native-tools', toolCalls: [tool], usage } })).toBe(false);
    expect(traces().find(trace => trace.callId === callId && trace.kind === 'call_failed')).toMatchObject({ code: 'CANCELLED', output: { complete: false, accepted: false, usage, toolCalls: [tool] } });
  });

  it('scopes native proof to owner/namespace/episode and preserves all parent usage without counting tools twice', async () => {
    const tool = wire('Bash', { command: 'owned' }), parent = await complete([tool]);
    const started = invocation(parent, tool, 0);
    await r.open('bob'); const bob = (await r.admit('bob', admission())).episode;
    await expect(r.startCapability(bob, started)).rejects.toMatchObject({ code: 'STALE' });
    const foreign = repo('foreign'); await foreign.open('alice'); const foreignEpisode = (await foreign.admit('alice', admission())).episode;
    await expect(foreign.startCapability(foreignEpisode, started)).rejects.toMatchObject({ code: 'STALE' });
    await expect(r.startCapability({ ...episode, ownerId: 'bob' }, started)).rejects.toMatchObject({ code: 'STALE' });
    await r.startCapability(episode, started); await finalize(started);
    const cognition = randomUUID(); await r.startCall(episode, { callId: cognition, requested: selection, callIndex: 1 });
    await r.finalizeCall(episode, { callId: cognition, output: { text: '{}', protocol: 'cognition', usage: { accountingVersion: 1, inputTokens: 6, outputTokens: 2 } } });
    await r.finish(episode, 'completed', null);
    const turn = (await r.turns('alice')).items[0];
    expect(turn.usage).toMatchObject({ inputTokens: 16, outputTokens: 6, inputTotalTokens: 20, totalTokens: 26, reportedCalls: 2, complete: true });
    expect(turn.calls.map(call => [call.protocol, call.capabilities.length])).toEqual([['native-tools', 1], ['cognition', 0]]);
    expect(turn.calls[0].capabilities[0].modelCallId).toBe(parent);
    // Explicit scalar SQL projection, not just post-query filtering.
    const { SqlitePersonStore } = await import('../../../../agent/yeaft/person/sqlite-store.js');
    sql(db => {
      const store = Object.create(SqlitePersonStore.prototype); store.namespace = 'default';
      const projected = [];
      store.sql = query => {
        expect(query).not.toMatch(/SELECT\s+record\b/i);
        const statement = db.prepare(query);
        return { get: (...args) => statement.get(...args), all: (...args) => { const rows = statement.all(...args); projected.push(...rows); return rows; } };
      };
      expect(store.turns('alice').items[0]).toEqual(turn);
      expect(JSON.stringify(projected)).not.toMatch(/do-not-project|owned|command|output\.text|capability\.args/);
      expect(projected.some(row => row.metadata?.includes(parent))).toBe(true);
    });
  }, 30000); // Three real workers plus a fresh store import under shared CI load.

});
