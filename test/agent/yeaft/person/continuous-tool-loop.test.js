import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonRuntime } from '../../../../agent/yeaft/person/runtime.js';
import { createPersonProvider } from '../../../../agent/yeaft/person/provider.js';

import { AnthropicAdapter } from '../../../../agent/yeaft/llm/anthropic.js';
import { OpenAIResponsesAdapter } from '../../../../agent/yeaft/llm/openai-responses.js';
import { createProviderContext } from '../../../../agent/yeaft/llm/provider-state.js';
import fileWrite from '../../../../agent/yeaft/tools/file-write.js';
import { config, finalProposal, goalInput } from './fixtures.js';
import { PERSON_REPLY_INSTRUCTIONS } from '../../../../agent/yeaft/person/reply-guidance.js';

const dirs = [], runtimes = [];

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
  it('carries the same public reply guidance through execution, live delivery and one final cognition', async () => {
    const publishProgress = vi.fn(async (_episode, { reply }) => ({ id: 'public-answer', text: reply }));
    const run = await setup((params, index) => {
      expect(params.system).toContain('Be honest. Same Soul.');
      expect(params.system.split(PERSON_REPLY_INSTRUCTIONS)).toHaveLength(2);
      if (index === 0) return tools(['goal', 'Execution__goal', goalInput([JSON.parse(params.messages[0].content).trigger.ref])]);
      if (index === 1) return text('The new evidence does not change my view. Here is the decisive reason.');
      const p = final(params); p.reply = null;
      expect(params.tools).toEqual([]);
      expect(JSON.stringify(params.messages)).toContain('public-answer');
      return text(JSON.stringify(p));
    }, { repository: { publishProgress } });
    await run.start().promise;
    expect(run.requests).toHaveLength(3);
    expect(run.requests.slice(0, 2).every(request => request.tools.length > 0)).toBe(true);
    expect(publishProgress).toHaveBeenCalledTimes(1);
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.repository.commit.mock.calls[0][1].reply).toBeNull();
  });

  it('enhances once on the selected Person model inside the same loop and accounts the private side call', async () => {
    const enhanced = { status: 'revised', response: '我选 A：你最在意维护成本，而 A 无需自行运维。', issues: ['原稿只有罗列'], evidenceGaps: [] };
    const run = await setup((params, index) => {
      if (index === 0) {
        expect(params.tools.some(tool => tool.name === 'ResponseEnhance')).toBe(true);
        return tools(['enhance', 'ResponseEnhance', { question: '哪个好？', draft: '两者各有优缺点。', evidence: 'A 无需运维，B 需要维护。', preferences: '低维护优先。' }]);
      }
      if (index === 1) {
        expect(params.tools).toEqual([]);
        expect(params.model).toBe('test/second');
        expect(params.system).toContain('smallest complete answer');
        return text(JSON.stringify(enhanced));
      }
      if (index === 2) {
        expect(params.tools.length).toBeGreaterThan(0);
        expect(JSON.stringify(params.messages)).toContain(enhanced.response);
        const observation = params.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content)).find(value => value.id === 'ResponseEnhance');
        return tools(['goal', 'Execution__goal', goalInput([observation.sourceRef], { acceptanceChecks: [{ check: 'Prepared a concise answer using the supplied comparison.', sourceRefs: [observation.sourceRef] }] })]);
      }
      if (params.tools.length) return text(enhanced.response);
      const p = final(params); p.reply = null;
      return text(JSON.stringify(p));
    }, { config: { ...config, primaryModel: 'test/second' } });
    const job = run.start(); await job.promise;
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(run.requests).toHaveLength(5);
    const result = run.traces.find(trace => trace.kind === 'capability_result' && trace.capability.id === 'ResponseEnhance').result;
    expect(result).toMatchObject({ ok: true, modelCall: { model: 'test/second', completed: true, usage: { inputTokens: 11, outputTokens: 7 } } });
    expect(job.models.get('test/second')).toMatchObject({ calls: 5, completedCalls: 5, usage: { inputTokens: 55, outputTokens: 35, totalTokens: 90 } });
    expect(run.traces.filter(trace => trace.kind === 'call_started')).toHaveLength(4);
  });

  it('drains truncated/unknown-tool batches before safe correction, preserving usage with no dispatched sibling', async () => {
    const effect = vi.spyOn(fileWrite, 'execute');
    const run = await setup((params, index) => {
      if (index === 0) return [
        { type: 'tool_call', id: 'must-not-run', name: 'FileWrite', input: { file_path: 'never', content: 'never' } },
        { type: 'stop', stopReason: 'max_tokens' },
      ];
      if (index === 1) return tools(['unknown', 'NotRegistered', {}]);
      if (index === 2) return tools(['goal', 'Execution__goal', goalInput([JSON.parse(params.messages[0].content).trigger.ref])]);
      return text(params.tools.length ? 'Response corrected before execution.' : JSON.stringify(final(params)));
    });
    await run.start().promise;
    expect(effect).not.toHaveBeenCalled();
    expect(run.traces.filter(t => t.kind === 'call_failed').map(t => t.code)).toEqual(['OUTPUT_TRUNCATED', 'INVALID_TOOL_INPUT']);
    expect(run.traces.filter(t => t.kind === 'call_failed').every(t => t.output.usage.outputTokens === 7)).toBe(true);
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
  });

  it.each(['anthropic', 'openai-responses'])('passes native %s wire results continuously and keeps opaque reasoning only in episode RAM', async protocol => {
    const context = createProviderContext({ protocol, model: protocol === 'anthropic' ? 'claude-opus-5-5' : 'gpt-5', providerId: 'fixture', credentialScopeId: 'owned-account' });
    const wire = [], headers = [], json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body); wire.push(body); headers.push(options.headers);
      if (protocol === 'anthropic') for (let i = 0; i < body.messages.length; i++) {
        if (body.messages[i].role !== 'system') continue;
        expect(body.messages[i - 1]?.role).toBe('user');
        expect(body.messages[i + 1]?.role ?? 'assistant').toBe('assistant');
      }
      const index = wire.length - 1;
      const refs = protocol === 'anthropic'
        ? body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result').map(block => JSON.parse(block.content).sourceRef).filter(Boolean)
        : body.input.filter(item => item.type === 'function_call_output').map(item => JSON.parse(item.output).sourceRef).filter(Boolean);
      const goal = goalInput(refs, { kind: 'work', acceptanceChecks: [{ check: 'Both FileWrite results confirm the requested file contents were written.', sourceRefs: refs }] });
      if (protocol === 'anthropic') {
        const content = index === 0 ? [
          { type: 'thinking', thinking: 'PRIVATE-REASONING', signature: 'signed' },
          { type: 'tool_use', id: 'native-a', name: 'FileWrite', input: { file_path: 'wire-a', content: 'a' } },
          { type: 'tool_use', id: 'native-b', name: 'FileWrite', input: { file_path: 'wire-b', content: 'b' } },
        ] : index === 1 ? [{ type: 'redacted_thinking', data: 'PRIVATE-REDACTED' }, { type: 'tool_use', id: 'native-goal', name: 'Execution__goal', input: goal }]
          : [{ type: 'text', text: index === 2 ? 'Two actual files written.' : JSON.stringify(final({ messages: [{ content: body.messages[0].content }] })) }];
        return json({ id: `msg-${index}`, content, stop_reason: index < 2 ? 'tool_use' : 'stop_sequence', usage: { input_tokens: 10, output_tokens: 8 } });
      }
      const output = index === 0 ? [
        { type: 'reasoning', id: 'r', encrypted_content: 'PRIVATE-ENCRYPTED', summary: [] },
        { type: 'function_call', id: 'f1', call_id: 'native-a', name: 'FileWrite', arguments: JSON.stringify({ file_path: 'wire-a', content: 'a' }), status: 'completed' },
        { type: 'function_call', id: 'f2', call_id: 'native-b', name: 'FileWrite', arguments: JSON.stringify({ file_path: 'wire-b', content: 'b' }), status: 'completed' },
      ] : index === 1 ? [{ type: 'function_call', id: 'fg', call_id: 'native-goal', name: 'Execution__goal', arguments: JSON.stringify(goal), status: 'completed' }]
        : [{ type: 'message', id: `m-${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: index === 2 ? 'Two actual files written.' : JSON.stringify(final({ messages: [{ content: body.input.find(item => item.role === 'user').content[0].text }] })), annotations: [] }] }];
      return json({ id: `response-${index}`, status: 'completed', output, usage: { input_tokens: 10, output_tokens: 8 } });
    }));
    const native = protocol === 'anthropic' ? new AnthropicAdapter({ apiKey: 'fixture' }) : new OpenAIResponsesAdapter({ apiKey: 'fixture' });
    const run = await setup(null, { adapter: { stream: params => native.stream({ ...params, model: context.origin.model, providerContext: context }) } });
    await run.start().promise;
    expect(run.repository.commit).toHaveBeenCalledTimes(1);
    expect(wire).toHaveLength(4);
    expect(run.traces.find(trace => trace.kind === 'capability_result' && trace.capability.id === 'Execution.goal').result).toMatchObject({ ok: true, goal: { kind: 'work', status: 'completed' } });
    expect(await readFile(join(run.workDir, 'wire-a'), 'utf8')).toBe('a');
    expect(await readFile(join(run.workDir, 'wire-b'), 'utf8')).toBe('b');
    expect(JSON.stringify(wire[1])).toContain(protocol === 'anthropic' ? 'PRIVATE-REASONING' : 'PRIVATE-ENCRYPTED');
    expect(JSON.stringify(run.traces)).not.toContain('PRIVATE');
    if (protocol === 'anthropic') {
      expect(run.traces.filter(trace => trace.kind === 'call_output').slice(-2).every(trace => trace.output.stopReason === 'stop_sequence')).toBe(true);
      for (const body of wire.slice(1)) {
        expect(body.system).toEqual(wire[0].system);
        expect(body.tools).toEqual(wire[0].tools);
        // Cache markers may move; the signed content itself cannot change.
        const userText = message => typeof message.content === 'string' ? message.content : message.content.map(block => block.text).join('');
        expect(userText(body.messages[0])).toBe(userText(wire[0].messages[0]));
        expect(JSON.stringify(body)).toContain('PRIVATE-REASONING');
      }
      const updates = wire[3].messages.find(message => message.role === 'system');
      expect(updates.content.some(block => block.type === 'tool_removal')).toBe(true);
      expect(updates.content[0].text).toContain('strict JSON');
      expect(headers[3]['anthropic-beta']).toBe('inline-tools-2026-09-15');
      const results = wire[1].messages.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content[0].type === 'tool_result');
      expect(results).toHaveLength(1); expect(results[0].content.map(block => block.tool_use_id)).toEqual(['native-a', 'native-b']);
    } else expect(wire[1].input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['native-a', 'native-b']);
  });

});
