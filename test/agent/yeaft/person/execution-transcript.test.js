import { describe, expect, it } from 'vitest';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';
import { bytes, digest } from '../../../../agent/yeaft/person/contracts.js';
import { createProviderContext, createProviderState, replayProviderState } from '../../../../agent/yeaft/llm/provider-state.js';

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

  it('never accumulates unbounded request receipts, and keeps the most recent complete parallel tool group exact', () => {
    const transcript = new ExecutionTranscript(initial);
    for (let i = 0; i < 1000; i++) call(transcript, 'Bash', { command: `verify ${i}` }, { ok: true, output: `verified ${i}`, replaySafe: false });
    const latest = transcript.response({ text: 'Checking the final two files.', toolCalls: [
      { id: 'last-a', name: 'FileRead', input: { file_path: 'a' } }, { id: 'last-b', name: 'FileRead', input: { file_path: 'b' } },
    ] });
    transcript.result(latest, 'last-a', 'trace-a', { id: 'FileRead', args: { file_path: 'a' } }, { output: 'file a', replaySafe: true });
    transcript.result(latest, 'last-b', 'trace-b', { id: 'FileRead', args: { file_path: 'b' } }, { output: 'file b', replaySafe: true });
    const final = request(transcript, 9000, [{ name: 'FileRead' }]), inventory = evidence(final.messages);
    expect(inventory.capsules.length).toBeLessThanOrEqual(16);
    expect(inventory.omittedEvidenceCapsules).toBeGreaterThan(900);
    expect(final.contextBytes).toBeLessThanOrEqual(9000);
    expect(final.messages.slice(-3)).toEqual(latest.messages);
    assertPaired(final.messages);
  });

  it('keeps public native final findings after corrective instructions/outputs retire their original group', () => {
    const transcript = new ExecutionTranscript(initial);
    reads(transcript, 12);
    const findings = 'Observed result: generated report has 42 rows; the external API could not be verified.';
    transcript.response({ text: findings });
    transcript.instruct('Distill this result.');
    reads(transcript, 8);
    transcript.response({ text: 'Correction attempt.' });
    transcript.instruct('Correct JSON only.');
    const final = request(transcript, 5000);
    expect(evidence(final.messages).capsules.some(item => item.kind === 'native-public-findings' && item.findings.preview === findings)).toBe(true);
    assertPaired(final.messages);
  });

  it('capsules bound huge Unicode/escaped arguments and raw previews while retaining write target and command', () => {
    const transcript = new ExecutionTranscript(initial);
    const output = 'HEAD verified artifact\n' + '中😀\"\\\n'.repeat(3000) + '\nTAIL 17 checks passed';
    call(transcript, 'FileWrite', { file_path: 'actual-artifact.txt', content: '中😀\"\\\n'.repeat(4000) },
      { ok: true, output, rawBytes: bytes(output), sha256: digest(output), replaySafe: false });
    reads(transcript, 30);
    transcript.response({ text: 'Final native answer.' });
    const capsule = evidence(request(transcript, 7000).messages).capsules.find(item => item.capability === 'FileWrite');
    expect(bytes(capsule)).toBeLessThanOrEqual(4096);
    expect(capsule.invocation).toMatchObject({ args: null, argsTruncated: true, target: { file_path: 'actual-artifact.txt' } });
    expect(capsule.output).toMatchObject({ rawBytes: bytes(output), truncated: true });
    expect(capsule.output.preview).toContain('HEAD verified artifact');
    expect(capsule.output.preview).toContain('TAIL 17 checks passed');
    expect(capsule.output.preview).not.toContain('\ufffd');
    const raw = Buffer.from(output), { start, end } = capsule.output.hiddenRange;
    expect(capsule.output.preview).toBe(raw.subarray(0, start).toString() + '\n[omitted]\n' + raw.subarray(end).toString());
  });

  it('capsules degrade oversized metadata without failing completed effects or changing observed publication identities', () => {
    const transcript = new ExecutionTranscript(initial);
    const result = { ok: false, code: 'CHECK_FAILED', errorEffect: 'unknown', terminal: false, replaySafe: false,
      output: 'HEAD: wrote actual-artifact.txt\n' + 'large observation\n'.repeat(300) + 'TAIL: checks failed; no rollback confirmed',
      sourceRef: 'tool:actual-source', source: { details: 'source'.repeat(1000) }, episodeId: 'episode',
      accepted: { detail: 'accepted'.repeat(1000) }, afterTerminal: { detail: 'terminal'.repeat(1000) },
      outputAvailability: { detail: 'availability'.repeat(35) },
      id: 'actual-output-19', messageId: 'actual-message-20', outputId: 'actual-output-19', publicationId: 'actual-pub-21',
      published: true, kind: 'artifact', title: 'title'.repeat(1000), url: 'url'.repeat(1000), summary: 'summary'.repeat(1000) };
    const group = call(transcript, 'FileWrite', { file_path: 'actual-artifact.txt', content: 'escaped中\"\\\n'.repeat(4000) }, result);
    expect(bytes(group.receipts[0])).toBeLessThanOrEqual(4096);
    expect(group.receipts[0]).toMatchObject({ ok: false, code: 'CHECK_FAILED', errorEffect: 'unknown', terminal: false,
      replaySafe: false, sourceRef: 'tool:actual-source', publication: { id: 'actual-output-19', messageId: 'actual-message-20',
        outputId: 'actual-output-19', publicationId: 'actual-pub-21', published: true } });
    expect(group.receipts[0].output.preview).toContain('HEAD: wrote actual-artifact.txt');
    expect(group.receipts[0].output.preview).toContain('no rollback confirmed');
    reads(transcript, 50);
    transcript.response({ text: 'Public findings: the artifact exists but checks failed.' });
    const capsule = evidence(request(transcript, 9000).messages).capsules.find(item => item.capability === 'FileWrite');
    expect(capsule).toEqual(group.receipts[0]);
    expect(capsule).not.toHaveProperty('completed');
  });

  it('reports only actually rendered Recall pages and refs, not retired records or arbitrary output strings', () => {
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
  });

  it('fails closed if the newest complete group cannot fit without editing it', () => {
    const transcript = new ExecutionTranscript(initial);
    const latest = call(transcript, 'FileRead', { file_path: 'huge' }, { output: 'x'.repeat(20000), replaySafe: true });
    const before = structuredClone(latest);
    expect(() => request(transcript, 1000)).toThrow(expect.objectContaining({ code: 'CONTEXT_LIMIT' }));
    expect(latest).toEqual(before);
  });
});

const identity = { instanceScope: 'test-instance', ownerScope: 'test-owner', sessionId: 'person', vpId: 'person', threadId: 'episode' };
function native(protocol, text, input = {}) {
  const context = createProviderContext({ protocol, model: 'test-native', providerId: protocol, staticApiKey: 'test-key' });
  const toolCalls = [{ id: 'native-use', name: 'FileWrite', input }];
  const items = protocol === 'anthropic' ? [
    { type: 'thinking', thinking: 'opaque internal bytes', signature: 'signature-test' },
    { type: 'text', text }, { type: 'tool_use', id: 'native-use', name: 'FileWrite', input },
  ] : [
    { type: 'reasoning', encrypted_content: 'encrypted-test-opaque' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    { type: 'function_call', call_id: 'native-use', name: 'FileWrite', arguments: JSON.stringify(input) },
  ];
  const continuationState = createProviderState({ context, identity, items, responseId: 'response-native' });
  return { context, items, output: { text, toolCalls, continuationState } };
}

describe('ExecutionTranscript single native wire budget and opaque fences', () => {
  it.each(['anthropic', 'openai-responses'])('counts %s native public projection once, retains opaque state and all replay fences', protocol => {
    const text = 'Actual public findings. '.repeat(1200), input = { file_path: 'artifact', content: 'actual code'.repeat(500) };
    const value = native(protocol, text, input), transcript = new ExecutionTranscript(initial);
    const group = transcript.response(value.output);
    transcript.result(group, 'native-use', 'trace-native', { id: 'FileWrite', args: input }, { output: 'write confirmed', replaySafe: false });
    const singleWire = bytes(value.items) + bytes(group.messages[1]) + bytes(initial) + 400;
    const final = request(transcript, singleWire);
    expect(final.omittedExecutionGroups).toBe(0);
    expect(final.contextBytes).toBeLessThan(singleWire);
    const assistant = final.messages.find(message => message.role === 'assistant');
    expect(assistant).toEqual(group.messages[0]);
    expect(replayProviderState(assistant, value.context, identity)).toEqual(value.items);
    expect(final.opaqueReasoningBytes).toBeGreaterThan(0);
    if (protocol === 'anthropic') {
      expect(() => replayProviderState(assistant, value.context, { ...identity, ownerScope: 'different-owner' })).toThrow(/owner changed/);
    } else expect(replayProviderState(assistant, value.context, { ...identity, ownerScope: 'different-owner' })).toBe(null);
    // Runtime's archive strips opaque state while preserving the public projection.
    const archive = final.messages.map(({ providerState, ...message }) => message);
    expect(JSON.stringify(archive)).not.toContain('encrypted-test-opaque');
    expect(JSON.stringify(archive)).not.toContain('signature-test');
    expect(archive.find(message => message.role === 'assistant').content).toBe(text);
  });

  it('retire whole groups to bound cumulative opaque reasoning independently of a generous wire budget', () => {
    const transcript = new ExecutionTranscript(initial);
    for (let i = 0; i < 3; i++) {
      const value = native('anthropic', `public finding ${i}`);
      value.items[0].thinking = 'opaque'.repeat(400000);
      value.output.continuationState = createProviderState({ context: value.context, identity, items: value.items });
      const group = transcript.response(value.output);
      transcript.result(group, 'native-use', `trace-${i}`, { id: 'FileWrite', args: {} }, { output: 'confirmed', replaySafe: false });
    }
    const before = structuredClone(transcript.groups), final = request(transcript, 10 * 1024 * 1024);
    expect(final.omittedExecutionGroups).toBe(2);
    expect(final.opaqueReasoningBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(transcript.groups).toEqual(before);
    expect(evidence(final.messages).capsules.some(item => item.kind === 'native-public-findings')).toBe(true);
    assertPaired(final.messages);
  });
});
