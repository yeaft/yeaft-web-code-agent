import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonProvider, collectOutput } from '../../../../agent/yeaft/person/provider.js';
import { PersonCapabilities } from '../../../../agent/yeaft/person/capabilities.js';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';
import { AnthropicAdapter } from '../../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../../agent/yeaft/llm/openai-responses.js';
import { createProviderContext } from '../../../../agent/yeaft/llm/provider-state.js';
import fileWrite from '../../../../agent/yeaft/tools/file-write.js';
import { config, finalProposal } from './fixtures.js';

const dirs = [], runtimes = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const text = value => [{ type: 'text_delta', text: value }, { type: 'stop', stopReason: 'end_turn' }];
const tools = (...calls) => [...calls.map(([id, name, input]) => ({ type: 'tool_call', id, name, input })), { type: 'stop', stopReason: 'tool_use' }];
function final(params) {
  const input = JSON.parse(params.messages[0].content), p = finalProposal(input.state.version);
  p.concepts = []; p.state.focusConceptIds = []; p.activity.sourceRefs = [input.trigger.ref]; p.reply = 'Read, edited and verified.';
  return p;
}
async function setup(script, extra = {}) {
  const workDir = await mkdtemp(join(tmpdir(), 'person-loop-')); dirs.push(workDir);
  const traces = []; let openCall = null, openCapability = null;
  const repository = {
    leaseMs: 15000, heartbeat: vi.fn(async () => {}), executionControl: vi.fn(async () => {}), createdCapabilities: async () => [],
    context: async () => ({ person: { id: 'p', name: 'Same Person', soul: 'Be honest. Same Soul.', soulRevision: 1 }, state: { version: 0 }, messages: [], concepts: [] }),
    startCall: async (_episode, data) => { expect(openCall).toBeNull(); expect(openCapability).toBeNull(); openCall = data; traces.push({ kind: 'call_started', ...data }); },
    finalizeCall: async (_episode, data) => { expect(openCall.callId).toBe(data.callId); openCall = null; traces.push({ kind: data.code ? 'call_failed' : 'call_output', ...data }); return true; },
    startCapability: async (_episode, data) => {
      expect(openCall).toBeNull(); expect(openCapability).toBeNull();
      expect(traces.some(t => t.kind === 'call_output' && t.callId === data.modelCallId)).toBe(true);
      expect(traces.some(t => t.kind === 'capability_started' && t.callId === data.callId)).toBe(false);
      openCapability = data; traces.push({ kind: 'capability_started', ...data });
    },
    finalizeCapability: async (_episode, data) => { expect(openCapability.callId).toBe(data.callId); openCapability = null; traces.push({ kind: 'capability_result', ...data }); return true; },
    append: async (_episode, kind, data) => traces.push({ kind, ...data }),
    commit: vi.fn(async (_episode, proposal) => traces.push({ kind: 'committed', proposal })),
    finish: vi.fn(async (_episode, status, code) => traces.push({ kind: 'finished', status, code })),
    ...extra.repository,
  };
  const requests = [];
  const adapter = { async *stream(params) {
    requests.push(structuredClone({ system: params.system, messages: params.messages, tools: params.tools }));
    const events = await script(params, requests.length - 1);
    for (const event of events) yield event;
    yield { type: 'usage', inputTokens: 11, outputTokens: 7 };
  } };
  const provider = await createPersonProvider({ config: extra.config ?? config, adapter: extra.adapter ?? adapter });
  const runtime = new PersonRuntime({ repository, getProvider: async () => provider, workDir, config }); runtimes.push(runtime);
  const episode = { id: 'episode', ownerId: 'alice', createdAt: new Date(), baseStateVersion: 0, kind: 'send', text: 'Read/edit/test authorized fixture.' };
  return { runtime, repository, requests, traces, workDir, episode, start() { runtime.start(episode); return runtime.running.get(episode.id); } };
}
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(runtimes.splice(0).map(r => r.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('Person continuous native execution then one final cognition', () => {
  it('reads, edits, tests real files in order with continuous results and exactly one cognition', async () => {
    const run = await setup((params, index) => {
      expect(params.system).toContain('Same Soul.');
      if (index < 4) expect(params.tools.map(t => t.name)).toEqual(expect.arrayContaining(['Bash', 'FileRead', 'FileEdit', 'Execution__read']));
      if (index === 0) return tools(['read', 'FileRead', { file_path: 'fixture.txt' }]);
      if (index === 1) { expect(JSON.stringify(params.messages)).toContain('before'); return tools(['edit', 'FileEdit', { file_path: 'fixture.txt', old_string: 'before', new_string: 'after' }]); }
      if (index === 2) return tools(['test', 'Bash', { command: "test \"$(cat fixture.txt)\" = after && printf verified" }]);
      if (index === 3) { expect(JSON.stringify(params.messages)).toContain('verified'); return text('Changed fixture; test passed.'); }
      expect(params.tools).toEqual([]); return text(JSON.stringify(final(params)));
    });
    await writeFile(join(run.workDir, 'fixture.txt'), 'before');
    await run.start().promise;
    expect(await readFile(join(run.workDir, 'fixture.txt'), 'utf8')).toBe('after');
    expect(run.repository.finish).not.toHaveBeenCalled(); expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.traces.filter(t => t.kind === 'activity')).toHaveLength(1);
    expect(run.traces.filter(t => t.kind === 'capability_started').map(t => t.capability.id)).toEqual(['FileRead', 'FileEdit', 'Bash']);
    expect(run.requests).toHaveLength(5);
    expect(run.requests[3].messages.filter(m => m.role === 'tool').map(m => m.toolCallId)).toEqual(['read', 'edit', 'test']);
    expect(run.traces.filter(t => t.kind === 'call_output').every(t => t.output.usage.inputTokens === 11)).toBe(true);
  });

  it('delivers native final text before cognition, preserving actual delivery when final cognition fails', async () => {
    const published = [], publishProgress = vi.fn(async (_episode, data) => { published.push(data); return { id: 'delivery' }; });
    const run = await setup((params, index) => index === 0 ? text('Actual work is delivered.') : text('{invalid'), {
      repository: { publishProgress },
    });
    await run.start().promise;
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ reply: 'Actual work is delivered.', final: true });
    expect(run.traces.filter(t => t.kind === 'activity')).toHaveLength(0);
    expect(run.repository.commit).not.toHaveBeenCalled();
    expect(run.repository.finish).toHaveBeenCalledWith(expect.anything(), 'failed', 'INVALID_PROPOSAL');
  });

  it('uses distinct trace IDs for siblings while preserving provider tool-use IDs and actual one-call usage', async () => {
    const run = await setup((params, index) => index === 0
      ? tools(['provider-a', 'FileWrite', { file_path: 'a', content: 'a' }], ['provider-b', 'FileWrite', { file_path: 'b', content: 'b' }])
      : text(params.tools.length ? 'Two files written.' : JSON.stringify(final(params))));
    await run.start().promise;
    const starts = run.traces.filter(t => t.kind === 'capability_started');
    expect(starts).toHaveLength(2); expect(new Set(starts.map(t => t.callId)).size).toBe(2);
    expect(starts[0].modelCallId).toBe(starts[1].modelCallId);
    expect(starts.map(t => t.toolUseId)).toEqual(['provider-a', 'provider-b']);
    expect(starts.map(t => t.toolIndex)).toEqual([0, 1]);
    expect(run.requests[1].messages.filter(m => m.role === 'tool').map(m => m.toolCallId)).toEqual(['provider-a', 'provider-b']);
  });

  it('corrects invalid final refs and malformed JSON without replaying completed edits or adding activity', async () => {
    const run = await setup((params, index) => {
      if (index === 0) return tools(['write-once', 'FileWrite', { file_path: 'once', content: 'once' }]);
      if (index === 1) return text('Written.');
      if (index === 2) { const p = final(params); p.activity.sourceRefs = ['tool:invented']; return text(JSON.stringify(p)); }
      if (index === 3) { expect(JSON.stringify(params.messages)).toContain('activity.sourceRefs'); return text('{broken'); }
      expect(params.tools).toEqual([]); return text(JSON.stringify(final(params)));
    });
    await run.start().promise;
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(1);
    expect(run.traces.filter(t => t.kind === 'proposal_rejected')).toHaveLength(2);
    expect(run.traces.filter(t => t.kind === 'activity')).toHaveLength(1);
  });

  it('rejects schema-invalid input before a side effect and feeds native tool error for safe correction', async () => {
    const run = await setup((params, index) => {
      if (index === 0) return tools(['bad', 'FileWrite', { file_path: 'safe', content: 3 }]);
      if (index === 1) { expect(JSON.stringify(params.messages)).toContain('Nothing executed'); return tools(['good', 'FileWrite', { file_path: 'safe', content: 'correct' }]); }
      return text(params.tools.length ? 'Done.' : JSON.stringify(final(params)));
    });
    await run.start().promise;
    expect(await readFile(join(run.workDir, 'safe'), 'utf8')).toBe('correct');
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(2);
    expect(run.traces.find(t => t.kind === 'capability_result').result).toMatchObject({ ok: false, errorEffect: 'none', code: 'INVALID_TOOL_INPUT' });
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
  });

  it('pauses after provider return before effects, then resumes the same transcript without replay', async () => {
    const entered = deferred(), release = deferred();
    const run = await setup(async (params, index) => {
      if (index === 0) { entered.resolve(); await release.promise; return tools(['paused-write', 'FileWrite', { file_path: 'paused', content: 'ok' }]); }
      return text(params.tools.length ? 'Done.' : JSON.stringify(final(params)));
    });
    const job = run.start(); await entered.promise;
    await run.runtime.control('alice', 'episode', 'pause'); release.resolve();
    for (let i = 0; i < 100 && job.status !== 'paused'; i++) await new Promise(r => setTimeout(r, 5));
    expect(job.status).toBe('paused'); expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(0);
    await run.runtime.control('alice', 'episode', 'resume'); await job.promise;
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(1); expect(run.repository.commit).toHaveBeenCalledTimes(1);
  });

  it('cancel joins the actual native effect and archives its after-result before returning', async () => {
    const entered = deferred(), release = deferred();
    vi.spyOn(fileWrite, 'execute').mockImplementation(async () => { entered.resolve(); await release.promise; return 'actual completed output'; });
    const run = await setup(() => tools(['join', 'FileWrite', { file_path: 'joined', content: 'x' }]));
    run.start(); await entered.promise;
    let cancelled = false; const cancellation = run.runtime.cancel('episode', 'CANCELLED', 'alice').then(() => { cancelled = true; });
    await new Promise(r => setTimeout(r, 20)); expect(cancelled).toBe(false);
    release.resolve(); await cancellation;
    expect(run.traces.find(t => t.kind === 'capability_result').result.output).toBe('actual completed output');
    expect(run.repository.commit).not.toHaveBeenCalled(); expect(run.repository.finish).toHaveBeenCalledWith(expect.anything(), 'cancelled', 'CANCELLED');
  });

  it('continues after a confirmed failing test without replaying its possible effects', async () => {
    const run = await setup((params, index) => {
      if (index === 0) return tools(['failed-test', 'Bash', { command: 'printf failing-test; exit 7' }]);
      if (index === 1) {
        expect(JSON.stringify(params.messages)).toContain('exit_nonzero');
        expect(JSON.stringify(params.messages)).toContain('unknown');
        return tools(['fix', 'FileWrite', { file_path: 'fixed', content: 'actual fix' }]);
      }
      return text(params.tools.length ? 'Failure inspected and fixed.' : JSON.stringify(final(params)));
    });
    await run.start().promise;
    expect(await readFile(join(run.workDir, 'fixed'), 'utf8')).toBe('actual fix');
    expect(run.traces.filter(t => t.kind === 'capability_started').map(t => t.capability.id)).toEqual(['Bash', 'FileWrite']);
    expect(run.repository.finish).not.toHaveBeenCalled();
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
  });

  it('reads historical failed effects as evidence without treating the read itself as unconfirmed execution', async () => {
    const run = await setup((params, index) => {
      if (index === 0) return tools(['inspect-history', 'Execution__read', { episodeId: 'prior', callId: 'original' }]);
      if (index === 1) {
        expect(JSON.stringify(params.messages)).toContain('unknown');
        return text('Inspected historical failure, without replay.');
      }
      return text(JSON.stringify(final(params)));
    }, { repository: { executionRead: async () => ({ id: 'Execution.read', ok: false, code: 'TOOL_FAILED',
      errorEffect: 'unknown', historical: true, authority: 'evidence-only', output: 'Original command failed.',
      callId: 'original', sourceRef: 'tool:prior:original:Bash:hash' }) } });
    await run.start().promise;
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(1);
    expect(run.repository.finish).not.toHaveBeenCalled();
  });

  it('does not lose prior execution receipts when request context is bounded', () => {
    const transcript = new ExecutionTranscript([{ role: 'user', content: 'same trigger' }]);
    for (let i = 0; i < 5; i++) {
      const group = transcript.response({ text: '', toolCalls: [{ id: `use-${i}`, name: 'FileRead', input: { file_path: `${i}` } }] });
      transcript.result(group, `use-${i}`, `trace-${i}`, { id: 'FileRead' }, { output: 'x'.repeat(30000), sourceRef: `tool:source-${i}` });
    }
    const original = JSON.stringify(transcript.groups);
    const request = transcript.request({ system: 'Soul', tools: [], maxBytes: 22000 });
    expect(request.contextBytes).toBeLessThanOrEqual(22000);
    for (let i = 0; i < 5; i++) expect(JSON.stringify(request.messages)).toContain(`trace-${i}`);
    expect(JSON.stringify(transcript.groups)).toBe(original);
    expect(JSON.stringify(request.messages)).toContain('Earlier actual execution groups omitted');
    transcript.response({ text: 'Public results retained.' });
    const reduced = transcript.request({ system: 'Soul', tools: [], maxBytes: 4000 });
    expect(reduced.omittedExecutionGroups).toBeGreaterThan(0);
    const inventory = JSON.parse(reduced.messages.find(message => message.role === 'user' && message.content.includes('omittedEvidenceCapsules')).content);
    expect(inventory.omittedEvidenceCapsules).toBeGreaterThan(0);
    expect(inventory.capsules.length).toBeGreaterThan(0);
  });

  it('keeps Bash and Execution.read simultaneously executable without catalog.view', () => {
    const capabilities = new PersonCapabilities({}, 'alice');
    const defs = capabilities.executionTools();
    expect(defs.map(t => t.name)).toEqual(expect.arrayContaining(['Bash', 'Execution__read']));
    expect(capabilities.executionManifest('Bash')).not.toBeNull(); expect(capabilities.executionManifest('Execution.read')).not.toBeNull();
    expect(capabilities.invocation('Execution__read', { callId: 'trace' })).toEqual({ id: 'Execution.read', args: { callId: 'trace' } });
  });


  it('keeps more than the old call quota in one native episode, with one activity and no catalog preparation', async () => {
    const run = await setup((params, index) => index < 12
      ? tools([`read-${index}`, 'FileRead', { file_path: 'same' }])
      : text(params.tools.length ? 'Twelve actual reads.' : JSON.stringify(final(params))));
    await writeFile(join(run.workDir, 'same'), 'retained finding');
    await run.start().promise;
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(12);
    expect(run.requests).toHaveLength(14);
    expect(run.requests[12].messages.filter(m => m.role === 'tool')).toHaveLength(12);
    expect(run.traces.filter(t => t.kind === 'activity')).toHaveLength(1);
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
  });

  it('corrects a schema-invalid sibling without replaying a preceding completed side effect', async () => {
    const effect = vi.spyOn(fileWrite, 'execute');
    const run = await setup((params, index) => {
      if (index === 0) return [
        ...tools(['completed', 'FileWrite', { file_path: 'only-once', content: 'done' }]).slice(0, -1),
        { type: 'tool_call', id: 'malformed', name: 'FileWrite', input: {} },
        { type: 'stop', stopReason: 'tool_use' },
      ];
      if (index === 1) {
        expect(params.messages.filter(m => m.role === 'tool').map(m => m.toolCallId)).toEqual(['completed', 'malformed']);
        return tools(['corrected', 'FileRead', { file_path: 'only-once' }]);
      }
      return text(params.tools.length ? 'Completed safely.' : JSON.stringify(final(params)));
    });
    await run.start().promise;
    expect(effect).toHaveBeenCalledTimes(1);
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(3);
  });

  it('drains truncated/unknown-tool batches before safe correction, preserving usage with no dispatched sibling', async () => {
    const effect = vi.spyOn(fileWrite, 'execute');
    const run = await setup((params, index) => {
      if (index === 0) return [
        { type: 'tool_call', id: 'must-not-run', name: 'FileWrite', input: { file_path: 'never', content: 'never' } },
        { type: 'stop', stopReason: 'max_tokens' },
      ];
      if (index === 1) return tools(['unknown', 'NotRegistered', {}]);
      return text(params.tools.length ? 'Response corrected before execution.' : JSON.stringify(final(params)));
    });
    await run.start().promise;
    expect(effect).not.toHaveBeenCalled();
    expect(run.traces.filter(t => t.kind === 'call_failed').map(t => t.code)).toEqual(['OUTPUT_TRUNCATED', 'INVALID_TOOL_INPUT']);
    expect(run.traces.filter(t => t.kind === 'call_failed').every(t => t.output.usage.outputTokens === 7)).toBe(true);
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
  });

  it('final next is null-only, even with otherwise valid cognitive fields', async () => {
    const run = await setup((params, index) => {
      if (index === 0) return text('No tools needed.');
      const p = final(params);
      if (index === 1) p.next = { model: 'test/first', effort: null, reason: 'do not dispatch', capability: { id: 'FileWrite', args: { file_path: 'forbidden', content: 'no' } } };
      else expect(JSON.stringify(params.messages)).toContain('Must be null');
      return text(JSON.stringify(p));
    });
    await run.start().promise;
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(0);
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.traces.filter(t => t.kind === 'activity')).toHaveLength(1);
  });

  it('preserves complete Recall records once, with exact read lineage usable by final cognition', async () => {
    const message = { id: 'recalled', revision: 1, role: 'user', content: 'Original user report. '.repeat(600) };
    const run = await setup((params, index) => {
      if (index === 0) return tools(['recall', 'Recall', { kind: 'messages', limit: 1 }]);
      const result = params.messages.find(m => m.role === 'tool');
      expect(JSON.parse(result.content).items).toEqual([message]);
      expect(JSON.parse(result.content).output).toBeUndefined();
      if (index === 1) return text('Recalled the user report.');
      const p = final(params);
      p.concepts = [{ id: 'attributed', expectedRevision: 0, kind: 'claim', statement: 'The user reported this.', epistemicState: 'reported', sourceRefs: ['message:recalled:1'], associations: [] }];
      return text(JSON.stringify(p));
    }, { repository: { recall: async () => ({ items: [message], nextCursor: null }) } });
    await run.start().promise;
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.repository.commit.mock.calls[0][4].get('attributed')).toEqual(['message:recalled:1']);
  });

  it('does not promote tools or generated public findings into user-reported lineage on correction', async () => {
    const run = await setup((params, index) => {
      if (index === 0) return tools(['observation', 'FileRead', { file_path: 'evidence' }]);
      if (index === 1) return text('Public tool observation, not a user report.');
      const p = final(params), result = JSON.parse(params.messages.find(m => m.role === 'tool').content);
      p.concepts = [{ id: 'tool-claim', expectedRevision: 0, kind: 'claim', statement: 'Tool observation.', epistemicState: index === 2 ? 'reported' : 'hypothesis', sourceRefs: [result.sourceRef], associations: [] }];
      return text(JSON.stringify(p));
    });
    await writeFile(join(run.workDir, 'evidence'), 'Observed output');
    await run.start().promise;
    expect(run.traces.filter(t => t.kind === 'proposal_rejected')).toHaveLength(1);
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.traces.filter(t => t.kind === 'capability_started')).toHaveLength(1);
  });

  it('keeps Execution.read original recovery identity, byte positions and full raw size separate from its own trace', () => {
    const transcript = new ExecutionTranscript([]);
    const group = transcript.response({ text: '', toolCalls: [{ id: 'read-use', name: 'Execution__read', input: { callId: 'original' } }] });
    const page = transcript.result(group, 'read-use', 'new-read-trace', { id: 'Execution.read' }, {
      id: 'Execution.read', callId: 'original', output: 'slice', rawBytes: 50000, offset: 4096, nextOffset: 4101, eof: false, ok: true,
    });
    expect(page).toMatchObject({ callId: 'original', executionTraceCallId: 'new-read-trace', rawBytes: 50000, offset: 4096, nextOffset: 4101 });
    expect(page.recovery.read.args.callId).toBe('original');
  });

  it('rejects a small model window during provider readiness rather than dispatching or evicting recovery', async () => {
    const stream = vi.fn();
    await expect(createPersonProvider({ adapter: { stream },
      config: { ...config, availableModels: config.availableModels.map(model => ({ ...model, contextWindow: 32768 })) },
    })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(stream).not.toHaveBeenCalled();
  });

  it.each(['anthropic', 'openai-responses'])('passes native %s wire results continuously and keeps opaque reasoning only in episode RAM', async protocol => {
    const context = createProviderContext({ protocol, model: protocol === 'anthropic' ? 'claude-sonnet-4' : 'gpt-5', providerId: 'fixture', credentialScopeId: 'owned-account' });
    const wire = [], json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body); wire.push(body);
      const index = wire.length - 1;
      if (protocol === 'anthropic') {
        const content = index === 0 ? [
          { type: 'thinking', thinking: 'PRIVATE-REASONING', signature: 'signed' },
          { type: 'tool_use', id: 'native-a', name: 'FileWrite', input: { file_path: 'wire-a', content: 'a' } },
          { type: 'tool_use', id: 'native-b', name: 'FileWrite', input: { file_path: 'wire-b', content: 'b' } },
        ] : [{ type: 'text', text: index === 1 ? 'Two actual files written.' : JSON.stringify(final({ messages: [{ content: body.messages[0].content }] })) }];
        return json({ id: `msg-${index}`, content, stop_reason: index === 0 ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 8 } });
      }
      const output = index === 0 ? [
        { type: 'reasoning', id: 'r', encrypted_content: 'PRIVATE-ENCRYPTED', summary: [] },
        { type: 'function_call', id: 'f1', call_id: 'native-a', name: 'FileWrite', arguments: JSON.stringify({ file_path: 'wire-a', content: 'a' }), status: 'completed' },
        { type: 'function_call', id: 'f2', call_id: 'native-b', name: 'FileWrite', arguments: JSON.stringify({ file_path: 'wire-b', content: 'b' }), status: 'completed' },
      ] : [{ type: 'message', id: `m-${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: index === 1 ? 'Two actual files written.' : JSON.stringify(final({ messages: [{ content: body.input.find(item => item.role === 'user').content[0].text }] })), annotations: [] }] }];
      return json({ id: `response-${index}`, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 8 } });
    }));
    const native = protocol === 'anthropic' ? new AnthropicAdapter({ apiKey: 'fixture' }) : new OpenAIResponsesAdapter({ apiKey: 'fixture' });
    const run = await setup(null, { adapter: { stream: params => native.stream({ ...params, model: context.origin.model, providerContext: context }) } });
    await run.start().promise;
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(await readFile(join(run.workDir, 'wire-a'), 'utf8')).toBe('a');
    expect(await readFile(join(run.workDir, 'wire-b'), 'utf8')).toBe('b');
    expect(JSON.stringify(wire[1])).toContain(protocol === 'anthropic' ? 'PRIVATE-REASONING' : 'PRIVATE-ENCRYPTED');
    expect(JSON.stringify(run.traces)).not.toContain('PRIVATE');
    if (protocol === 'anthropic') {
      const results = wire[1].messages.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content[0].type === 'tool_result');
      expect(results).toHaveLength(1); expect(results[0].content.map(block => block.tool_use_id)).toEqual(['native-a', 'native-b']);
    } else expect(wire[1].input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['native-a', 'native-b']);
  });

  it('collector drains native calls/usage but never executes an incomplete batch or archives hidden thinking', async () => {
    const adapter = { async *stream() {
      yield { type: 'thinking_delta', text: 'hidden' };
      yield { type: 'tool_call', id: 'safe-id', name: 'FileWrite', input: {}, malformed: true };
      yield { type: 'usage', inputTokens: 3, outputTokens: 4 };
      yield { type: 'stop', stopReason: 'tool_use' };
    } };
    await expect(collectOutput(adapter, { tools: [{ name: 'FileWrite' }], signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT', partialOutput: { complete: false, usage: { outputTokens: 4 } } });
  });
});
