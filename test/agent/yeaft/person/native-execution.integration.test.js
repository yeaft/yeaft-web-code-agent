import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config, finalProposal } from './fixtures.js';
import fileWrite from '../../../../agent/yeaft/tools/file-write.js';

const services = [], dirs = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const text = value => [{ type: 'text_delta', text: value }, { type: 'stop', stopReason: 'end_turn' }];
const tools = (...calls) => [...calls.map(([id, name, input]) => ({ type: 'tool_call', id, name, input })), { type: 'stop', stopReason: 'tool_use' }];
const call = (service, op, payload = {}, ownerId = 'alice') => service.request({ ownerId, op, payload });
function final(params) {
  const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
  p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref]; p.reply = 'Actual changes verified.';
  return p;
}
async function until(read, check) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Person did not reach the expected boundary');
}
async function setup(script) {
  const dir = await mkdtemp(join(tmpdir(), 'person-native-sqlite-')); dirs.push(dir);
  let count = 0;
  const adapter = { async *stream(params) {
    for (const event of await script(params, count++)) yield event;
    yield { type: 'usage', inputTokens: 13, outputTokens: 9 };
  } };
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, adapter, embedding: { enabled: false } }); services.push(service);
  await call(service, 'open');
  return { service, dir, start: () => call(service, 'send', { text: 'Read, edit and test the authorized fixture.', clientMessageId: 'native' }),
    idle: () => until(() => call(service, 'snapshot'), value => !value.busy) };
}
async function traces(service) {
  let cursor = null; const items = [];
  do { const page = await call(service, 'traces', { limit: 50, cursor }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return items;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person continuous execution with real SQLite authority', () => {
  it('reads/edits/tests in order, recovers the original tool trace and commits once after all tools', async () => {
    let originalCallId;
    const run = await setup((params, index) => {
      if (index < 5) expect(params.tools.map(t => t.name)).toEqual(expect.arrayContaining(['Bash', 'FileRead', 'FileEdit', 'Execution__read']));
      if (index === 0) return tools(['read', 'FileRead', { file_path: 'fixture' }]);
      if (index === 1) return tools(['edit', 'FileEdit', { file_path: 'fixture', old_string: 'before', new_string: 'after' }]);
      if (index === 2) return tools(['test', 'Bash', { command: 'test "$(cat fixture)" = after && printf VERIFIED' }]);
      if (index === 3) {
        originalCallId = JSON.parse(params.messages.find(m => m.role === 'tool' && m.toolCallId === 'test').content).callId;
        return tools(['recover', 'Execution__read', { callId: originalCallId, maxBytes: 4096 }]);
      }
      if (index === 4) {
        const page = JSON.parse(params.messages.find(m => m.role === 'tool' && m.toolCallId === 'recover').content);
        expect(page).toMatchObject({ callId: originalCallId, output: 'VERIFIED', eof: true, authority: 'evidence-only' });
        expect(page.executionTraceCallId).not.toBe(originalCallId);
        return text('Read, edited and verified the actual file.');
      }
      expect(params.tools).toEqual([]); return text(JSON.stringify(final(params)));
    });
    await writeFile(join(run.dir, 'fixture'), 'before'); await run.start();
    expect((await run.idle()).latestEpisode.status).toBe('completed');
    expect(await readFile(join(run.dir, 'fixture'), 'utf8')).toBe('after');
    const records = await traces(run.service);
    expect(records.filter(t => t.kind === 'capability_started').reverse().map(t => t.capability.id)).toEqual(['FileRead', 'FileEdit', 'Bash', 'Execution.read']);
    expect(records.filter(t => t.kind === 'activity')).toHaveLength(1);
    expect(records.filter(t => t.kind === 'call_output' && t.output.protocol === 'cognition')).toHaveLength(1);
    expect(records.filter(t => t.kind === 'call_output').every(t => t.output.usage.inputTokens === 13)).toBe(true);
    const turn = (await call(run.service, 'turns')).items[0];
    expect(turn.loopCount).toBe(6); expect(turn.calls.flatMap(c => c.capabilities ?? [])).toHaveLength(4);
    await call(run.service, 'open', {}, 'bob');
    expect((await call(run.service, 'traces', {}, 'bob')).items).toEqual([]);
  });

  it('repairs malformed tool input and final provenance/JSON without replaying a completed host effect', async () => {
    const effect = vi.spyOn(fileWrite, 'execute');
    const run = await setup((params, index) => {
      if (index === 0) return [
        ...tools(['once', 'FileWrite', { file_path: 'once', content: 'once' }]).slice(0, -1),
        { type: 'tool_call', id: 'bad', name: 'FileWrite', input: {} }, { type: 'stop', stopReason: 'tool_use' },
      ];
      if (index === 1) return tools(['check', 'FileRead', { file_path: 'once' }]);
      if (index === 2) return text('The single write completed.');
      if (index === 3) { const p = final(params); p.activity.sourceRefs = ['tool:invented']; return text(JSON.stringify(p)); }
      if (index === 4) return text('{malformed');
      return text(JSON.stringify(final(params)));
    });
    await run.start(); expect((await run.idle()).latestEpisode.status).toBe('completed'); expect(effect).toHaveBeenCalledTimes(1);
    const records = await traces(run.service);
    expect(records.filter(t => t.kind === 'proposal_rejected')).toHaveLength(2);
    expect(records.filter(t => t.kind === 'activity')).toHaveLength(1);
    expect(records.find(t => t.kind === 'capability_failed' && t.toolUseId === 'bad').result).toMatchObject({ ok: false, code: 'INVALID_TOOL_INPUT', errorEffect: 'none' });
  });

  it('pauses before native dispatch and resumes with the same provider response, not a replay', async () => {
    const entered = deferred(), release = deferred(); let providerCalls = 0;
    const run = await setup(async (params, index) => {
      providerCalls++;
      if (index === 0) { entered.resolve(); await release.promise; return tools(['pause', 'FileWrite', { file_path: 'paused', content: 'completed' }]); }
      return text(params.tools.length ? 'Completed.' : JSON.stringify(final(params)));
    });
    const { episodeId } = await run.start(); await entered.promise;
    await call(run.service, 'pause', { episodeId }); release.resolve();
    await until(() => call(run.service, 'executions'), value => value.main?.status === 'paused');
    expect((await traces(run.service)).filter(t => t.kind === 'capability_started')).toHaveLength(0);
    await call(run.service, 'resume', { episodeId }); expect((await run.idle()).latestEpisode.status).toBe('completed');
    expect(providerCalls).toBe(3); expect((await traces(run.service)).filter(t => t.kind === 'capability_started')).toHaveLength(1);
  });

  it('cancel waits for a real in-flight effect and archives its actual after-terminal result', async () => {
    const entered = deferred(), release = deferred();
    vi.spyOn(fileWrite, 'execute').mockImplementation(async () => { entered.resolve(); await release.promise; return 'joined actual result'; });
    const run = await setup(() => tools(['joined', 'FileWrite', { file_path: 'joined', content: 'x' }]));
    const { episodeId } = await run.start(); await entered.promise;
    let done = false; const cancellation = call(run.service, 'cancel', { episodeId }).then(() => { done = true; });
    await new Promise(r => setTimeout(r, 20)); expect(done).toBe(false); release.resolve(); await cancellation;
    const records = await traces(run.service), after = records.find(t => t.kind === 'capability_finalized');
    expect(after).toMatchObject({ afterTerminal: true, result: { output: 'joined actual result' }, toolUseId: 'joined' });
    expect(records.filter(t => t.kind === 'activity')).toHaveLength(0);
  });
});
