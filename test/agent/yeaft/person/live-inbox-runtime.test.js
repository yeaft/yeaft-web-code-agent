import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { config, finalProposal, goalInput } from './fixtures.js';

const resources = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const text = value => [{ type: 'text_delta', text: value }, { type: 'stop', stopReason: 'end_turn' }];
const tools = (...calls) => [...calls.map(([id, name, input]) => ({ type: 'tool_call', id, name, input })), { type: 'stop', stopReason: 'tool_use' }];
const result = (params, id) => JSON.parse(params.messages.find(m => m.role === 'tool' && m.toolCallId === id).content);
const latest = params => JSON.parse(params.messages[0].content).latestUserInstruction;
const final = params => {
  const proposal = finalProposal(JSON.parse(params.messages[0].content).state.version);
  proposal.concepts = []; proposal.state.focusConceptIds = []; proposal.reply = null;
  return text(JSON.stringify(proposal));
};

async function setup(script, providerConfig = config) {
  const dir = await mkdtemp(join(tmpdir(), 'person-live-runtime-'));
  const repository = new SqlitePersonRepository({ yeaftDir: dir, leaseMs: 10000 });
  const requests = [];
  const provider = await createPersonProvider({ config: providerConfig, adapter: { async *stream(params) {
    requests.push(params);
    for (const event of await script(params, requests.length - 1)) yield event;
  } } });
  const runtime = new PersonRuntime({ repository, getProvider: async () => provider, workDir: dir, yeaftDir: dir, config });
  resources.push({ dir, runtime, repository });
  await repository.open('alice');
  const send = (id, more = {}) => repository.admit('alice', { kind: 'send', text: id, clientMessageId: id, workerId: runtime.workerId, budget: { calls: null }, ...more });
  const admitted = await send('initial');
  return { dir, repository, runtime, requests, episode: admitted.episode, send,
    start() { runtime.start(admitted.episode); return runtime.running.get(admitted.episode.id); },
    async traces() { return (await repository.list('alice', 'traces', { limit: 50 })).items; },
    async snapshot() { return repository.snapshot('alice'); },
  };
}
afterEach(async () => {
  for (const { dir, runtime, repository } of resources.splice(0)) { await runtime.close(); await repository.close(); await rm(dir, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

describe('live input in the single continuous Person execution loop', () => {
  it('receives mid-model text and full attachments as exact user records, preventing the old write/publication', async () => {
    const entered = deferred(), release = deferred(); let incoming;
    const run = await setup(async (params, index) => {
      if (index === 0) { entered.resolve(); await release.promise; return tools(['stale', 'FileWrite', { file_path: 'stale', content: 'forbidden' }]); }
      if (index === 1) {
        const record = latest(params);
        expect(record).toMatchObject({ id: incoming.messageId, text: 'Do not write. Answer this instead.', deliveryState: 'received', revision: 2 });
        const message = params.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('sourceRef') && m.content.includes('exact attachment body'));
        const content = JSON.parse(message.content);
        expect(content.sourceRef).toBe(`message:${incoming.messageId}:2`);
        expect(content.attachments[0].content).toBe('exact attachment body');
        expect(result(params, 'stale')).toMatchObject({ ok: false, code: 'INPUT_SUPERSEDED', errorEffect: 'none', replaySafe: true, dispatched: false });
        expect(result(params, 'stale').recovery).toBeUndefined();
        return tools(['reply', 'Conversation__reply', { messageIds: [record.id], text: 'The separate question is answered.' }], ['goal', 'Execution__goal', goalInput([content.sourceRef])]);
      }
      return params.tools.length ? text('Updated response.') : final(params);
    });
    const job = run.start(); await entered.promise;
    incoming = await run.send('fresh', { text: 'Do not write. Answer this instead.', files: [{ name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('exact attachment body').toString('base64') }] });
    release.resolve(); await job.promise;
    await expect(readFile(join(run.dir, 'stale'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run.snapshot()).latestEpisode.status).toBe('completed');
    const traces = await run.traces();
    expect(traces.some(t => t.kind === 'capability_started' && t.toolUseId === 'stale')).toBe(false);
    expect(traces.find(t => t.kind === 'capability_skipped')).toMatchObject({ toolUseId: 'stale', code: 'INPUT_SUPERSEDED' });
    const messages = (await run.repository.list('alice', 'messages')).items;
    expect(messages.find(m => m.replyKind === 'message-reply')).toMatchObject({ text: 'The separate question is answered.', replyToMessageIds: [incoming.messageId] });
    expect(run.episode.inboxVersion).toBeGreaterThan(0);
  });

  it('abandons interrupted final cognition and reenters tools, without publishing or committing its stale proposal', async () => {
    const cognition = deferred(), release = deferred(); let received = false;
    const run = await setup(async (params, index) => {
      if (!index) return tools(['goal', 'Execution__goal', goalInput([])]);
      if (index === 1) return text('First answer.');
      if (index === 2) { expect(params.tools).toEqual([]); cognition.resolve(); await release.promise; const p = finalProposal(); p.reply = 'STALE COGNITIVE REPLY'; return text(JSON.stringify(p)); }
      if (index === 3) { received = true; expect(params.tools.length).toBeGreaterThan(0); expect(latest(params).text).toBe('new command'); expect(JSON.stringify(params.messages)).not.toContain('final-cognition'); return tools(['goal-new', 'Execution__goal', goalInput([])]); }
      return params.tools.length ? text('Fresh answer.') : final(params);
    });
    const job = run.start(); await cognition.promise; await run.send('new-command', { text: 'new command' }); release.resolve(); await job.promise;
    expect(received).toBe(true);
    const snapshot = await run.snapshot(); expect(snapshot.state.version).toBe(1); expect(snapshot.latestEpisode.status).toBe('completed');
    const traces = await run.traces(); expect(traces.filter(t => t.kind === 'activity')).toHaveLength(1);
    expect((await run.repository.list('alice', 'messages')).items.some(m => m.text === 'STALE COGNITIVE REPLY')).toBe(false);
  });

});
