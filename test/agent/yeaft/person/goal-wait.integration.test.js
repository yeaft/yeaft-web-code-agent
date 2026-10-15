import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonService } from '../../../../agent/yeaft/person/service.js';
import { config, finalProposal } from './fixtures.js';

const resources = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const text = value => [{ type: 'text_delta', text: value }, { type: 'stop', stopReason: 'end_turn' }];
const tool = (id, name, input) => [{ type: 'tool_call', id, name, input }, { type: 'stop', stopReason: 'tool_use' }];
const goal = (status, patch = {}) => ({ objective: 'Collect background work and verify the artifact', acceptance: 'Actual shell result and artifact verified', kind: 'work', status,
  reason: '', nextStep: 'Collect the background result', sourceRefs: [], acceptanceChecks: [], waitFor: [], blocker: null, ...patch });
async function until(read, test) {
  for (let i = 0; i < 300; i++) { const value = await read(); if (test(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Expected boundary not reached');
}
async function setup(script) {
  const dir = await mkdtemp(join(tmpdir(), 'person-goal-wait-'));
  let index = 0;
  const service = createPersonService({ yeaftDir: dir, workDir: dir, config, embedding: { enabled: false }, adapter: {
    async *stream(params) { for (const event of await script(params, index++, dir)) yield event; },
  } });
  resources.push({ service, dir });
  const request = (op, payload = {}) => service.request({ ownerId: 'alice', op, payload });
  await request('open');
  return { dir, request };
}
afterEach(async () => { for (const { service, dir } of resources.splice(0)) { await service.close(); await rm(dir, { recursive: true, force: true }); } });

it('honors pending wait immediately without model polling, pauses safely, then collects results without replay', async () => {
  const waiting = deferred(), releaseWaiting = deferred();
  let calls = 0, taskId, resultRef;
  const run = await setup(async (params, index, dir) => {
    calls++;
    const results = params.messages.filter(m => m.role === 'tool').map(m => ({ toolId: m.toolCallId, ...JSON.parse(m.content) }));
    if (index === 0) return [...tool('accept', 'Execution__goal', goal('active')).slice(0, -1), ...tool('start', 'Bash', {
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("const fs=require('fs'); const p='release'; const t=setInterval(()=>{if(fs.existsSync(p)){clearInterval(t);fs.writeFileSync('artifact','verified');console.log('BACKGROUND VERIFIED')}},25)")}`, background: true,
    })];
    if (index === 1) {
      taskId = results.find(r => r.toolId === 'start').output.match(/Started background task (\S+)\./)[1];
      waiting.resolve(); await releaseWaiting.promise;
      return tool('wait', 'Execution__goal', goal('waiting', { waitFor: [taskId] }));
    }
    if (index === 2) {
      expect(params.messages.at(-1).content).toContain('execution-results-ready');
      expect(await readFile(join(dir, 'artifact'), 'utf8')).toBe('verified');
      return tool('collect', 'ReadTaskLog', { taskId, offset: 0 });
    }
    if (index === 3) {
      const result = results.find(r => r.toolId === 'collect'); resultRef = result.sourceRef;
      expect(result.output).toContain('BACKGROUND VERIFIED');
      return tool('complete', 'Execution__goal', goal('completed', { reason: 'Actual result collected and artifact read back', sourceRefs: [resultRef], acceptanceChecks: [{ check: 'Background result collected and artifact verified', sourceRefs: [resultRef] }] }));
    }
    if (index === 4) return text('Verified background work.');
    expect(params.tools).toEqual([]);
    const p = finalProposal(JSON.parse(params.messages[0].content).state.version); p.concepts = []; p.state.focusConceptIds = []; p.reply = null;
    return text(JSON.stringify(p));
  });
  const admitted = await run.request('send', { text: 'Run and collect the authorized local fixture.', clientMessageId: 'wait' });
  await waiting.promise; releaseWaiting.resolve();
  await until(() => run.request('executions'), state => state.main?.phase === 'waiting');
  await new Promise(resolve => setTimeout(resolve, 40)); expect(calls).toBe(2);
  await run.request('pause', { episodeId: admitted.episodeId });
  await until(() => run.request('executions'), state => state.main?.status === 'paused');
  const { writeFile } = await import('node:fs/promises'); await writeFile(join(run.dir, 'release'), 'go');
  await new Promise(resolve => setTimeout(resolve, 80)); expect(calls).toBe(2);
  await run.request('resume', { episodeId: admitted.episodeId });
  const snapshot = await until(() => run.request('snapshot'), state => !state.busy);
  expect(snapshot.latestEpisode).toMatchObject({ status: 'completed' });
  expect(calls).toBe(6);
  const records = (await run.request('traces', { limit: 50 })).items;
  expect(records.filter(r => r.kind === 'capability_started' && r.capability.id === 'Bash')).toHaveLength(1);
  expect(records.filter(r => r.kind === 'activity')).toHaveLength(1);
  expect(records.find(r => r.kind === 'execution_goal' && r.goal.status === 'active')?.goal.revision).toBe(3);
}, 10000);

it('rejects answer-as-work closure and reopens a same-batch terminal report before later effects', async () => {
  let firstRef, checkedRef;
  const closure = (refs = []) => goal('completed', { kind: 'answer', reason: 'Verified actual artifact',
    sourceRefs: refs, acceptanceChecks: refs.map(ref => ({ check: 'Observed actual file contents', sourceRefs: [ref] })) });
  const run = await setup((params, index) => {
    const result = id => JSON.parse(params.messages.find(m => m.role === 'tool' && m.toolCallId === id).content);
    if (index === 0) return tool('write', 'FileWrite', { file_path: 'artifact', content: 'before' });
    if (index === 1) { firstRef = result('write').sourceRef; return tool('bypass', 'Execution__goal', closure()); }
    if (index === 2) {
      expect(result('bypass')).toMatchObject({ ok: false, code: 'INVALID_TOOL_INPUT' });
      return [...tool('closed', 'Execution__goal', closure([firstRef])).slice(0, -1), ...tool('later', 'FileEdit', { file_path: 'artifact', old_string: 'before', new_string: 'after' })];
    }
    if (index === 3) return text('Old completion should not close the later edit.');
    if (index === 4) {
      expect(params.messages.at(-1).content).toContain('execution-continue');
      return tool('check', 'FileRead', { file_path: 'artifact' });
    }
    if (index === 5) { checkedRef = result('check').sourceRef; return tool('verified', 'Execution__goal', closure([checkedRef])); }
    if (index === 6) return text('Artifact read back and verified after the last edit.');
    expect(params.tools).toEqual([]);
    const p = finalProposal(JSON.parse(params.messages[0].content).state.version); p.concepts = []; p.state.focusConceptIds = []; p.reply = null;
    return text(JSON.stringify(p));
  });
  await run.request('send', { text: 'Write, edit and verify the authorized artifact.', clientMessageId: 'stale-closure' });
  expect((await until(() => run.request('snapshot'), state => !state.busy)).latestEpisode.status).toBe('completed');
  expect(await readFile(join(run.dir, 'artifact'), 'utf8')).toBe('after');
  const records = (await run.request('traces', { limit: 50 })).items;
  expect(records.filter(r => r.kind === 'goal_boundary')).toHaveLength(1);
  expect(records.some(r => r.kind === 'execution_goal' && r.origin === 'host-subsequent-execution' && r.goal.status === 'active')).toBe(true);
  expect(records.filter(r => r.kind === 'activity')).toHaveLength(1);
});

it('cancels a host wait, joins background effects and never reenters the model', async () => {
  let calls = 0;
  const run = await setup((params, index) => {
    calls++;
    if (!index) return tool('start', 'Bash', { command: `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)'`, background: true });
    const taskId = JSON.parse(params.messages.find(m => m.role === 'tool' && m.toolCallId === 'start').content).output.match(/Started background task (\S+)\./)[1];
    return tool('wait', 'Execution__goal', goal('waiting', { waitFor: [taskId] }));
  });
  const admitted = await run.request('send', { text: 'Wait for authorized local work.', clientMessageId: 'cancel-wait' });
  await until(() => run.request('executions'), state => state.main?.phase === 'waiting');
  await run.request('cancel', { episodeId: admitted.episodeId });
  expect((await run.request('snapshot')).latestEpisode.status).toBe('cancelled');
  await new Promise(resolve => setTimeout(resolve, 30)); expect(calls).toBe(2);
  expect((await run.request('tasks')).tasks.every(item => !['running', 'pending'].includes(item.status))).toBe(true);
}, 10000);
