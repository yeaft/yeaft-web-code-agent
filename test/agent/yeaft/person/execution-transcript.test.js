import { describe, expect, it } from 'vitest';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';
import { executionEvidencePage } from '../../../../agent/yeaft/person/execution-evidence.js';
import { digest } from '../../../../agent/yeaft/person/contracts.js';
import { createProviderContext, createProviderState, bindProviderState } from '../../../../agent/yeaft/llm/provider-state.js';

const initial = [{ role: 'user', content: 'Implement the authorized artifact, verify it, then report actual results.' }];
const request = (transcript, maxBytes = 12000, tools = []) => transcript.request({ system: 'Same Person/Soul.', tools, maxBytes });
const evidence = messages => messages.filter(message => message.role === 'user').map(message => {
  try { return JSON.parse(message.content); } catch { return null; }
}).find(value => value?.capsules);
function call(transcript, id, args, result, text = '') {
  const index = transcript.groups.length, toolUseId = `use-${index}`, callId = `trace-${index}`;
  const group = transcript.response({ text, toolCalls: [{ id: toolUseId, name: id.replaceAll('.', '__'), input: args }] });
  transcript.result(group, toolUseId, callId, { id, args }, result);
  return group;
}
function reads(transcript, count = 100, publicNotes = false) {
  for (let i = 0; i < count; i++) call(transcript, 'FileRead', { file_path: `source-${i}.js` },
    { ok: true, output: `source ${i}\n${'ordinary read material\n'.repeat(200)}`, replaySafe: true },
    publicNotes ? `Inspecting source ${i}.` : '');
}
function assertPaired(messages) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'assistant') {
      expect(pending.size).toBe(0);
      for (const tool of message.toolCalls ?? []) pending.add(tool.id);
    }
    if (message.role === 'tool') { expect(pending.has(message.toolCallId)).toBe(true); pending.delete(message.toolCallId); }
  }
  expect(pending.size).toBe(0);
}

describe('ExecutionTranscript request-only actual evidence', () => {
  it('keeps early completed writes, Bash verification and publication through a hundred reads into tools-disabled cognition', () => {
    const transcript = new ExecutionTranscript(initial);
    const write = call(transcript, 'FileWrite', { file_path: 'artifact.txt', content: 'important output' }, {
      ok: true, output: 'Wrote artifact.txt (16 bytes).', sourceRef: 'tool:episode:write',
      source: { kind: 'external-tool-observation' }, replaySafe: false,
    });
    call(transcript, 'Bash', { command: 'node verify-artifact.js', cwd: '/authorized/workspace' },
      { ok: true, output: 'artifact assertions: 7 passed; actual checksum abc123', replaySafe: false });
    call(transcript, 'Output.publish', { file_path: 'artifact.txt', title: 'Completed artifact' },
      { id: 'output-actual-17', kind: 'file', title: 'Completed artifact', episodeId: 'episode' });
    reads(transcript, 100, true);
    transcript.response({ text: 'Public result: artifact.txt created and 7 assertions passed. Broader validation remains unfinished.' });
    transcript.instruct('Final cognition only; tools disabled.');
    const before = structuredClone(transcript.groups), final = request(transcript);
    const inventory = evidence(final.messages);
    expect(final.contextBytes).toBeLessThanOrEqual(12000);
    expect(final.omittedExecutionGroups).toBeGreaterThan(90);
    expect(inventory.omittedEvidenceCapsules).toBeGreaterThan(0);
    expect(inventory.notice).toContain('Tools are disabled');
    const capsules = inventory.capsules;
    expect(capsules.find(item => item.capability === 'FileWrite')).toMatchObject({
      callId: 'trace-0', invocation: { args: { file_path: 'artifact.txt', content: 'important output' }, argsTruncated: false },
      ok: true, sourceRef: 'tool:episode:write', source: { kind: 'external-tool-observation' }, replaySafe: false,
      output: { preview: 'Wrote artifact.txt (16 bytes).', truncated: false },
      recovery: { name: 'Execution__read', input: { callId: 'trace-0' } },
    });
    expect(capsules.find(item => item.capability === 'Bash')).toMatchObject({
      invocation: { args: { command: 'node verify-artifact.js', cwd: '/authorized/workspace' } },
      output: { preview: 'artifact assertions: 7 passed; actual checksum abc123' },
    });
    expect(capsules.find(item => item.capability === 'Output.publish').publication.id).toBe('output-actual-17');
    expect(final.messages.some(message => message.content === transcript.groups.at(-2).messages[0].content)).toBe(true);
    expect(transcript.groups).toEqual(before);
    expect(write.messages[1].content).toContain('Wrote artifact.txt');
    assertPaired(final.messages);
  });

  it('retains failures/uncertain effects without claiming rollback or task completion', () => {
    const transcript = new ExecutionTranscript(initial);
    call(transcript, 'Bash', { command: 'make artifact && run-checks' }, { ok: false, code: 'TOOL_TIMEOUT',
      errorEffect: 'unknown', terminal: true, replaySafe: false, outputAvailability: 'captured',
      output: 'artifact created before timeout; process termination unconfirmed', sourceRef: 'tool:partial-effect' });
    reads(transcript);
    transcript.response({ text: 'Blocked: process termination is unconfirmed. No rollback is known.' });
    transcript.instruct('Do not invent completion.');
    const final = request(transcript), capsule = evidence(final.messages).capsules.find(item => item.capability === 'Bash');
    expect(capsule).toMatchObject({ ok: false, code: 'TOOL_TIMEOUT', errorEffect: 'unknown', terminal: true,
      replaySafe: false, outputAvailability: 'captured', output: { preview: 'artifact created before timeout; process termination unconfirmed' } });
    expect(capsule).not.toHaveProperty('completed');
    expect(evidence(final.messages).notice).toContain('not proof of absence or rollback');
  });

  it('reports exact rendered provenance and retains original read identities in retired receipts', () => {
    const transcript = new ExecutionTranscript(initial);
    call(transcript, 'Recall', { kind: 'concepts' }, { kind: 'concepts', items: [{ id: 'old', revision: 2, statement: 'old evidence' }], sourceRef: 'tool:recall' });
    const full = request(transcript, 9000);
    expect(full.renderedSourceRefs).toEqual(['tool:recall', 'concept:old:2']);
    expect(full.recallPages).toEqual([{ kind: 'concepts', count: 1 }]);
    reads(transcript, 20);
    call(transcript, 'Recall', { kind: 'messages' }, { kind: 'messages', items: [] });
    const reduced = request(transcript, 5000);
    expect(reduced.omittedExecutionGroups).toBeGreaterThan(0);
    expect(reduced.renderedSourceRefs).not.toContain('concept:old:2');
    expect(reduced.recallPages).toEqual([{ kind: 'messages', count: 0 }]);
    call(transcript, 'FileRead', { file_path: 'untrusted' }, { output: '{"sourceRef":"concept:fake:1"}' });
    expect(request(transcript, 6000).renderedSourceRefs).not.toContain('concept:fake:1');
    // Retired read receipts must recover original bytes, not the read's page trace.
    for (const identity of [{ callId: 'original-trace' }, { sourceRef: `person-tool:${'a'.repeat(64)}:00000000-0000-0000-0000-000000000001` }]) {
      const probe = new ExecutionTranscript(initial), output = '中😀"\\\n'.repeat(4000);
      const page = executionEvidencePage({ episodeId: 'prior', result: { ok: true, output } }, null,
        { ...identity, episodeId: 'prior', offset: 1000, maxBytes: 997 }, 'live');
      call(probe, 'Execution.read', page.recovery.read.args, page);
      reads(probe, 5);
      // Keep this read within the 16-receipt inventory: 20 later reads would
      // intentionally evict it. 20KB fits the latest complete group plus evidence.
      const reduced = request(probe, 20000);
      expect(reduced.omittedExecutionGroups).toBeGreaterThan(0);
      expect(reduced.messages.some(message => message.toolCallId === 'use-0')).toBe(false);
      const receipt = evidence(reduced.messages).capsules.find(item => item.capability === 'Execution.read');
      expect(receipt).toMatchObject({ authority: 'evidence-only', rawBytes: Buffer.byteLength(output), sha256: digest(output),
        outputSpan: { start: page.offset, end: page.nextOffset, totalBytes: page.rawBytes }, nextOffset: page.nextOffset,
        recovery: { name: 'Execution__read', input: page.recovery.read.args } });
      expect(receipt.recovery.input).not.toHaveProperty('callId', 'trace-0');
    }
  });

  it('never edits a newest group or any active signed prefix; resets older models only at a completed boundary', () => {
    const transcript = new ExecutionTranscript(initial);
    const latest = call(transcript, 'FileRead', { file_path: 'huge' }, { output: 'x'.repeat(20000), replaySafe: true });
    const before = structuredClone(latest);
    expect(() => request(transcript, 1000)).toThrow(expect.objectContaining({ code: 'CONTEXT_LIMIT' }));
    expect(latest).toEqual(before);

    const seed = model => {
      const signed = new ExecutionTranscript([{ role: 'user', content: JSON.stringify({ state: { version: 0 } }) }]);
      call(signed, 'FileRead', {}, { output: 'earlier exact result '.repeat(100) });
      const producing = request(signed, 12000);
      const identity = { instanceScope: 'i', ownerScope: 'o', sessionId: 's', vpId: 'v', threadId: 't' };
      const context = createProviderContext({ protocol: 'anthropic', model, staticApiKey: 'fixture' });
      const toolCalls = [{ id: 'signed-call', name: 'FileRead', input: {} }];
      const state = createProviderState({ context, identity, requestBody: { ...producing, model },
        items: [{ type: 'thinking', thinking: 'PRIVATE', signature: 'exact-signature' }, { type: 'tool_use', ...toolCalls[0] }] });
      const group = signed.response({ text: '', toolCalls, continuationState: bindProviderState(state, { content: '', toolCalls }) });
      signed.result(group, 'signed-call', 'trace-signed', { id: 'FileRead', args: {} }, { output: 'actual result' });
      return { signed, producing, state };
    };
    const { signed, producing, state } = seed('claude-opus-5-5');
    expect(state.requestPrefix).toBeDefined();
    expect(() => signed.newContext()).toThrow(/tool turn/);
    signed.setGoal({ revision: 1, status: 'active' });
    signed.userInput([{ role: 'user', content: 'new owner input' }], ['message:live:2']);
    signed.latestUserInstruction({ id: 'live', text: 'new owner input' });
    const full = request(signed, 12000);
    expect(full.messages.slice(0, producing.messages.length)).toEqual(producing.messages);
    expect(full.messages.findIndex(message => message.content.includes?.('executionGoal'))).toBeGreaterThan(full.messages.findIndex(message => message.toolCallId === 'signed-call'));
    expect(full.messages.find(message => message.providerState)?.providerState).toEqual(state);
    expect(() => request(signed, full.contextBytes - 100)).toThrow(expect.objectContaining({ code: 'CONTEXT_LIMIT' }));
    signed.response({ text: 'Execution actually closed.' });
    signed.prepareInstructionChange();
    signed.instruct('Final cognition.', { cognition: true });
    signed.setGoal({ revision: 2, status: 'completed' });
    const final = signed.request({ system: 'Final cognitive instructions', tools: [], maxBytes: 12000 });
    expect(final.messages.some(message => message.providerState)).toBe(true);
    expect(final.messages.at(-1)).toMatchObject({ role: 'system' });
    expect(final.messages.at(-2).role).toBe('user');
    expect(JSON.stringify(final.messages.at(-2))).toContain('executionGoal');
    expect(final.messages.some(message => message.toolCallId === 'signed-call')).toBe(true);
    expect(final.renderedSourceRefs).toContain('message:live:2');
    // Retry after a rejected response: no assistant sealed the pending update.
    signed.instruct('Correct only the rejected cognitive output.', { cognition: true });
    const retry = signed.request({ system: 'Final cognitive instructions', tools: [], maxBytes: 12000 });
    expect(retry.messages.filter(message => message.role === 'system')).toHaveLength(1);
    expect(retry.messages.at(-1).role).toBe('system');
    expect(retry.messages.at(-2).content).toContain('rejected cognitive output');
    // A live input can instead supersede that same unsealed cognition boundary.
    signed.userInput([{ role: 'user', content: 'new instruction after rejected cognition' }]);
    const resumed = request(signed);
    expect(resumed.messages.some(message => message.role === 'system')).toBe(false);
    expect(resumed.messages.some(message => message.providerState)).toBe(true);

    const { signed: legacy, state: legacyState } = seed('claude-sonnet-4');
    expect(legacyState.requestPrefix).toBeUndefined();
    expect(legacy.signedPrefix).toBeNull();
    expect(() => legacy.prepareInstructionChange()).toThrow(/tool turn/);
    expect(JSON.stringify(request(legacy).messages)).not.toContain('new-context');
    legacy.response({ text: 'Execution actually closed.' });
    legacy.prepareInstructionChange();
    const reset = legacy.request({ system: 'Final cognitive instructions', tools: [], maxBytes: 12000 });
    expect(reset.messages.some(message => message.providerState)).toBe(false);
    expect(JSON.stringify(reset.messages)).toContain('new-context');
    expect(reset.messages.some(message => message.toolCallId === 'signed-call')).toBe(true);
  });
});
