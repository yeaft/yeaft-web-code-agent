import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersonRepository } from '../../../../agent/yeaft/person/sqlite-repository.js';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';
import { ExecutionGoal } from '../../../../agent/yeaft/person/execution-goal.js';
import { PersonError } from '../../../../agent/yeaft/person/contracts.js';
import { validateCapabilityArguments } from '../../../../agent/yeaft/person/tool-arguments.js';
import { config, imageConfig, finalProposal, goalInput } from './fixtures.js';

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
async function until(read, predicate) {
  for (let n = 0; n < 350; n++) {
    const value = await read(); if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Boundary was not reached');
}
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

  it('preserves an already dispatched batch effect and skips every overtaken sibling, even across pause/resume', async () => {
    const entered = deferred(), release = deferred(), firstFinished = deferred(), finishRelease = deferred();
    const run = await setup(async (params, index) => {
      if (!index) { entered.resolve(); await release.promise; return tools(['first', 'FileWrite', { file_path: 'first', content: 'preserved' }], ['second', 'FileWrite', { file_path: 'second', content: 'stale' }], ['third', 'FileWrite', { file_path: 'third', content: 'also stale' }]); }
      if (index === 1) {
        expect(result(params, 'first').ok).not.toBe(false);
        for (const id of ['second', 'third']) expect(result(params, id)).toMatchObject({ code: 'INPUT_SUPERSEDED', errorEffect: 'none', replaySafe: true, dispatched: false });
        const freshInput = params.messages.findIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('do-not-run-tail') && !message.content.includes('latestUserInstruction'));
        for (const id of ['first', 'second', 'third']) expect(params.messages.findIndex(message => message.role === 'tool' && message.toolCallId === id)).toBeLessThan(freshInput);
        const ref = result(params, 'first').sourceRef;
        return tools(['goal', 'Execution__goal', goalInput([ref], { kind: 'work', acceptanceChecks: [{ check: 'First effect is retained; second was not dispatched.', sourceRefs: [ref] }] })]);
      }
      return params.tools.length ? text('Retained first effect only.') : final(params);
    });
    const finalize = run.repository.finalizeCapability.bind(run.repository);
    vi.spyOn(run.repository, 'finalizeCapability').mockImplementation(async (episode, data) => {
      const value = await finalize(episode, data);
      if (data.capability.id === 'FileWrite') { firstFinished.resolve(); await finishRelease.promise; }
      return value;
    });
    const job = run.start(); await entered.promise; release.resolve(); await firstFinished.promise;
    await run.runtime.control('alice', run.episode.id, 'pause'); finishRelease.resolve();
    await until(async () => job.status, status => status === 'paused');
    const receipt = await run.send('do-not-run-tail');
    expect(receipt.deliveryState).toBe('queued');
    expect(run.requests).toHaveLength(1);
    await run.runtime.control('alice', run.episode.id, 'resume'); await job.promise;
    expect(await readFile(join(run.dir, 'first'), 'utf8')).toBe('preserved');
    await expect(readFile(join(run.dir, 'second'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run.snapshot()).latestEpisode.status).toBe('completed');
    expect((await run.traces()).filter(t => t.kind === 'capability_started' && t.capability.id === 'FileWrite')).toHaveLength(1);
  });

  it.each([false, true])('checks after asynchronous native preparation at actual dispatch (pause=%s)', async pause => {
    const prepared = deferred(), release = deferred(); let intercepted = false;
    const run = await setup((params, index) => {
      if (!index) return tools(['prepared', 'FileWrite', { file_path: 'prepared', content: 'stale' }], ['sibling', 'FileWrite', { file_path: 'sibling', content: 'stale' }]);
      if (index === 1) {
        for (const id of ['prepared', 'sibling']) expect(result(params, id)).toMatchObject({ code: 'INPUT_SUPERSEDED', errorEffect: 'none', replaySafe: true, dispatched: false });
        expect(latest(params).text).toBe('preparation input');
        return tools(['goal', 'Execution__goal', goalInput([])]);
      }
      return params.tools.length ? text('Reevaluated without stale effects.') : final(params);
    });
    const host = run.runtime.tasks(), context = host.context.bind(host);
    vi.spyOn(host, 'context').mockImplementation(async input => {
      const preparedContext = await context(input);
      // Bootstrap context has no call ID; block the native host's real async
      // preparation, after durable capability admission but before invocation.
      if (input.callId && !intercepted) { intercepted = true; prepared.resolve(); await release.promise; }
      return preparedContext;
    });
    const job = run.start(); await prepared.promise;
    if (pause) await run.runtime.control('alice', run.episode.id, 'pause');
    await run.send('preparation-input', { text: 'preparation input' }); release.resolve();
    if (pause) {
      await until(async () => job.status, status => status === 'paused');
      expect(run.requests).toHaveLength(1);
      await expect(readFile(join(run.dir, 'prepared'))).rejects.toMatchObject({ code: 'ENOENT' });
      await run.runtime.control('alice', run.episode.id, 'resume');
    }
    await job.promise;
    for (const name of ['prepared', 'sibling']) await expect(readFile(join(run.dir, name))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await run.snapshot()).latestEpisode.status).toBe('completed');
    expect((await run.traces()).filter(trace => trace.kind === 'capability_skipped')).toHaveLength(2);
  });

  it.each(['startCall', 'startCapability', 'commit'])('retries the execution loop on a storage %s inbox race without failing the episode', async boundary => {
    let raced = false;
    const run = await setup((params, index) => {
      if (!params.tools.length) return final(params);
      if (index === 0 && boundary !== 'startCall') return tools(['stale', 'FileWrite', { file_path: 'stale', content: 'no' }]);
      const refs = params.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).filter(r => r.sourceRef && r.code !== 'INPUT_SUPERSEDED').map(r => r.sourceRef);
      const goal = goalInput(refs, refs.length ? { acceptanceChecks: [{ check: 'Actual retained effects reconciled.', sourceRefs: refs }] } : {});
      const lastInput = params.messages.findLastIndex(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('sourceRef') && m.content.includes('race'));
      const lastGoal = params.messages.findLastIndex(m => m.role === 'tool' && JSON.parse(m.content).goal?.status === 'completed');
      if (lastGoal < 0 || lastGoal <= lastInput) return tools([`goal-${index}`, 'Execution__goal', goal]);
      return text('Fresh execution closure.');
    });
    const original = run.repository[boundary].bind(run.repository);
    vi.spyOn(run.repository, boundary).mockImplementation(async (...args) => {
      if (!raced) { raced = true; await run.send('race'); }
      return original(...args);
    });
    await run.start().promise;
    expect(raced).toBe(true);
    expect((await run.snapshot()).latestEpisode.status).toBe('completed');
    expect((await run.traces()).filter(t => t.kind === 'activity')).toHaveLength(boundary === 'commit' ? 2 : 1);
    if (boundary !== 'commit') await expect(readFile(join(run.dir, 'stale'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(run.requests.some(params => params.tools.length && latest(params)?.text === 'race')).toBe(true);
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

  it('receives while waiting without cancelling the owned background effect', async () => {
    const reentered = deferred(), release = deferred(); let taskId;
    const run = await setup(async (params, index) => {
      if (!index) return tools(['start', 'Bash', { command: `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)'`, background: true }]);
      if (index === 1) { taskId = result(params, 'start').output.match(/Started background task (\S+)\./)[1]; return tools(['wait', 'Execution__goal', goalInput([], { kind: 'work', status: 'waiting', reason: '', nextStep: 'Wait for owned work', waitFor: [taskId] })]); }
      expect(latest(params).text).toBe('separate question');
      expect(run.runtime.tasks().goalState('alice', run.episode.id).tasks.find(t => t.id === taskId).status).toBe('running');
      reentered.resolve(); await release.promise;
      return text('Will retain owned work.');
    });
    const job = run.start();
    await until(async () => job.phase, phase => phase === 'waiting');
    await run.send('separate-question', { text: 'separate question' }); await reentered.promise;
    expect(run.requests).toHaveLength(3);
    const cancellation = run.runtime.cancel(run.episode.id, 'CANCELLED', 'alice'); release.resolve(); await cancellation;
    expect((await run.snapshot()).latestEpisode.status).toBe('cancelled');
  }, 10000);

  it('fails safely on an unprocessable live image and stops queued remainder rather than dispatching stale work', async () => {
    const entered = deferred(), release = deferred();
    const run = await setup(async () => { entered.resolve(); await release.promise; return tools(['old', 'FileWrite', { file_path: 'old', content: 'no' }]); });
    const job = run.start(); await entered.promise;
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=';
    const imageReceipt = await run.send('image', { files: [{ name: 'image.png', mimeType: 'image/png', data: png }] });
    for (let n = 0; n < 4; n++) await run.send(`remaining-${n}`);
    release.resolve(); await job.promise;
    expect((await run.snapshot()).latestEpisode).toMatchObject({ status: 'failed', terminalCode: 'IMAGE_MODEL' });
    expect((await run.repository.receipt('alice', 'remaining-3')).deliveryState).toBe('stopped');
    // Receipt means delivered to the loop, not successfully interpreted. Even
    // this failed image stays in durable user history with its exact file ref.
    expect((await run.repository.list('alice', 'messages')).items.find(message => message.id === imageReceipt.messageId)).toMatchObject({ deliveryState: 'received', attachments: [{ kind: 'image' }] });
    expect(run.requests).toHaveLength(1);
    await expect(readFile(join(run.dir, 'old'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renders a supported live image without base64 trace duplication and reserves selected-model image tokens', async () => {
    const entered = deferred(), release = deferred();
    const run = await setup(async (params, index) => {
      if (!index) { entered.resolve(); await release.promise; return text('Superseded answer.'); }
      if (index === 1) {
        const imageMessage = params.messages.find(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'));
        expect(params.model).toBe('test/gpt-4o-mini');
        expect(imageMessage.role).toBe('user');
        expect(imageMessage.content.find(block => block.type === 'image').source.data).toBe(png);
        expect(imageMessage.content[0].text).toContain(`message:${receipt.messageId}:2`);
        return tools(['goal-image', 'Execution__goal', goalInput([])]);
      }
      return params.tools.length ? text('Image received.') : final(params);
    }, {
      providers: [{ name: 'test', models: ['first', 'gpt-4o-mini'] }], primaryModel: 'test/first',
      availableModels: [config.availableModels[0], imageConfig.availableModels[0]],
    });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2XcAAAAASUVORK5CYII=';
    const job = run.start(); await entered.promise;
    const receipt = await run.send('image', { files: [{ name: 'image.png', mimeType: 'image/png', data: png }] });
    release.resolve(); await job.promise;
    expect((await run.snapshot()).latestEpisode.status).toBe('completed');
    const traces = await run.traces();
    expect(JSON.stringify(traces)).not.toContain(png);
    expect(traces.find(trace => trace.kind === 'call_started' && trace.callIndex === 1).manifest.imageTokensReserved).toBeGreaterThan(0);
  });

  it('retains exact live user text and refs when old transcript groups retire; permits goal revision only after input', () => {
    const transcript = new ExecutionTranscript([{ role: 'user', content: JSON.stringify({ state: { version: 0 } }) }]);
    const input = { role: 'user', content: JSON.stringify({ id: 'live', text: 'exact live text '.repeat(80), sourceRef: 'message:live:2' }) };
    transcript.userInput([input], ['message:live:2']);
    for (let n = 0; n < 8; n++) transcript.response({ text: 'old response '.repeat(250), toolCalls: [] });
    const request = transcript.request({ system: 'same person', tools: [], maxBytes: 9000 });
    expect(request.omittedExecutionGroups).toBeGreaterThan(0);
    expect(request.messages).toContainEqual(input); expect(request.renderedSourceRefs).toContain('message:live:2');
    expect(() => transcript.request({ system: 'same person', tools: [], maxBytes: 500 })).toThrow();
    const goal = new ExecutionGoal(), refs = new Set();
    const active = goalInput([], { status: 'active', nextStep: 'Do the work' });
    goal.update(active, { sourceRefs: refs });
    expect(goal.update({ ...active, objective: 'Different objective' }, { sourceRefs: refs }).ok).toBe(false);
    goal.emptyEndings = 1; goal.userInput();
    expect(goal.emptyEndings).toBe(0);
    expect(goal.update({ ...active, objective: 'User-revised objective' }, { sourceRefs: refs }).ok).toBe(true);
    expect(goal.progress('Conversation.reply', { sourceRef: 'trace:reply' })).toBeUndefined();
    expect(goal.executionRevision).toBe(0);
    expect(() => validateCapabilityArguments({ id: 'Conversation.reply', args: { messageIds: ['a', 'a'], text: 'reply' } })).toThrow(PersonError);
  });
});
