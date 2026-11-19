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
  it('continues an active goal after premature end_turn, modifies/verifies a real file and distills only once', async () => {
    let actualRef;
    const goal = (status, refs = []) => ({ objective: 'Modify and verify the fixture', acceptance: 'File contains after and shell check passes',
      kind: 'work', acceptanceChecks: status === 'completed' ? [{ check: 'Actual file readback and shell validation passed', sourceRefs: refs }] : [],
      status, reason: status === 'completed' ? 'Actual file readback and shell validation passed' : '', nextStep: 'Edit then verify',
      sourceRefs: refs, waitFor: [], blocker: null });
    const run = await setup((params, index) => {
      if (index === 0) return tools(['goal', 'Execution__goal', goal('active')], ['read', 'FileRead', { file_path: 'fixture' }]);
      if (index === 1) return text('I have inspected it; next execution opportunity I can edit it.');
      if (index === 2) {
        expect(params.tools.length).toBeGreaterThan(0);
        expect(params.messages.at(-1).content).toContain('execution-continue');
        return tools(['edit', 'FileEdit', { file_path: 'fixture', old_string: 'before', new_string: 'after' }]);
      }
      if (index === 3) return tools(['verify', 'Bash', { command: 'test "$(cat fixture)" = after && printf CHECKED' }]);
      if (index === 4) {
        actualRef = JSON.parse(params.messages.find(m => m.role === 'tool' && m.toolCallId === 'verify').content).sourceRef;
        return tools(['done', 'Execution__goal', goal('completed', [actualRef])]);
      }
      if (index === 5) return text('Modified and actually verified.');
      expect(params.tools).toEqual([]);
      expect(params.messages.at(-1).content).toContain('"status":"completed"');
      return text(JSON.stringify(final(params)));
    });
    await writeFile(join(run.dir, 'fixture'), 'before'); await run.start();
    const snapshot = await run.idle();
    expect(snapshot.latestEpisode.status).toBe('completed');
    expect(await readFile(join(run.dir, 'fixture'), 'utf8')).toBe('after');
    const records = await traces(run.service);
    expect(records.filter(t => t.kind === 'goal_boundary')).toHaveLength(1);
    expect(records.filter(t => t.kind === 'call_output' && t.output.protocol === 'cognition')).toHaveLength(1);
    expect(records.filter(t => t.kind === 'capability_started' && t.capability.id === 'FileEdit')).toHaveLength(1);
    expect((await call(run.service, 'messages')).items.some(m => m.text.includes('next execution opportunity'))).toBe(false);
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
