import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { nativeFixtureAdapter } from './fixture-adapter.js';
import { finalProposal } from './fixtures.js';

const input = () => ({ state: { version: 0 }, trigger: { ref: 'trigger:fixture' }, sourceRefs: ['trigger:fixture'] });
const request = () => ({ requestIdentity: { threadId: randomUUID() }, tools: [{ name: 'Execution__goal' }],
  messages: [{ role: 'user', content: JSON.stringify(input()) }] });
const collect = async (adapter, params) => { const events = []; for await (const event of adapter.stream(params)) events.push(event); return events; };

// These are adapter-only checks: runtime goal validation remains real in the
// service suites and native tests must explicitly report their own disposition.
describe('historical native fixture closure', () => {
  it('caches the terminal public end and cognition without rerunning the script or its side effects', async () => {
    const proposal = finalProposal();
    const stream = vi.fn(async function* () {
      yield { type: 'text_delta', text: JSON.stringify(proposal) };
      yield { type: 'usage', inputTokens: 7, outputTokens: 3 };
      yield { type: 'stop', stopReason: 'end_turn' };
    });
    const adapter = nativeFixtureAdapter({ stream }), params = request();
    const terminal = await collect(adapter, params);
    expect(terminal.find(event => event.type === 'tool_call')).toMatchObject({ name: 'Execution__goal', input: {
      kind: 'answer', status: 'completed', sourceRefs: ['trigger:fixture'], acceptanceChecks: [], waitFor: [], blocker: null,
    } });
    expect(terminal.some(event => event.type === 'text_delta')).toBe(false);
    expect(terminal.at(-1)).toEqual({ type: 'stop', stopReason: 'tool_use' });
    const publicEnd = await collect(adapter, params);
    expect(publicEnd.filter(event => event.type === 'text_delta').map(event => event.text)).toEqual([proposal.reply]);
    expect(publicEnd.at(-1)).toEqual({ type: 'stop', stopReason: 'end_turn' });
    const cognition = await collect(adapter, { ...params, tools: [] });
    expect(JSON.parse(cognition.find(event => event.type === 'text_delta').text)).toEqual(proposal);
    expect(cognition.find(event => event.type === 'usage')).toEqual({ type: 'usage', inputTokens: 7, outputTokens: 3 });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('keeps goal results out of legacy capabilityResult and links work checks only to actual execution evidence', async () => {
    const params = request(), sourceRef = 'tool:write:1';
    params.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'write', name: 'FileWrite' }, { id: 'goal', name: 'Execution__goal' }] },
      { role: 'tool', toolCallId: 'write', content: JSON.stringify({ id: 'FileWrite', ok: true, output: 'Written.', sourceRef }) },
      { role: 'tool', toolCallId: 'goal', content: JSON.stringify({ id: 'Execution.goal', ok: true, goal: { status: 'active' } }) });
    const stream = vi.fn(async function* (params) {
      const legacy = JSON.parse(params.messages[0].content);
      expect(legacy.capabilityResult).toMatchObject({ id: 'FileWrite', sourceRef });
      yield { type: 'text_delta', text: JSON.stringify(finalProposal()) };
      yield { type: 'stop', stopReason: 'end_turn' };
    });
    const terminal = await collect(nativeFixtureAdapter({ stream }), params);
    expect(terminal.find(event => event.type === 'tool_call').input).toMatchObject({ kind: 'work', status: 'completed', sourceRefs: [sourceRef],
      acceptanceChecks: [{ check: expect.any(String), sourceRefs: [sourceRef] }] });
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
