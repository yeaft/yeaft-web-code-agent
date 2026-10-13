import { describe, expect, it } from 'vitest';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';

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
