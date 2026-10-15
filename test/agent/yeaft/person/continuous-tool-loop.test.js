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
    const context = createProviderContext({ protocol, model: protocol === 'anthropic' ? 'claude-sonnet-4' : 'gpt-5', providerId: 'fixture', credentialScopeId: 'owned-account' });
    const wire = [], json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body); wire.push(body);
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
        ] : index === 1 ? [{ type: 'tool_use', id: 'native-goal', name: 'Execution__goal', input: goal }]
          : [{ type: 'text', text: index === 2 ? 'Two actual files written.' : JSON.stringify(final({ messages: [{ content: body.messages[0].content }] })) }];
        return json({ id: `msg-${index}`, content, stop_reason: index < 2 ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 8 } });
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
      const results = wire[1].messages.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content[0].type === 'tool_result');
      expect(results).toHaveLength(1); expect(results[0].content.map(block => block.tool_use_id)).toEqual(['native-a', 'native-b']);
    } else expect(wire[1].input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['native-a', 'native-b']);
  });

});
