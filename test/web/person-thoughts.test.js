import { describe, expect, it } from 'vitest';
import { projectPersonThoughts } from '../../web/stores/helpers/person-thoughts.js';
import { assembleContext, PersonRuntime } from '../../agent/yeaft/person/runtime.js';
import { finalProposal } from '../agent/yeaft/person/fixtures.js';

const provider = {
  catalog: [{ id: 'test/first', efforts: [], contextWindow: 100000, maxOutput: 4096 }],
  catalogRevision: 'catalog-secret', defaultSelection: { model: 'test/first', effort: null },
};
const snapshot = () => ({
  person: { id: 'person-secret', name: 'Person', soul: 'system-secret', soulRevision: 1 },
  state: { version: 0, summary: 'Considering earlier experience.', appraisal: 'Interested.' },
  messages: [{ id: 'message-secret', revision: 1, role: 'user', text: 'I am learning to garden.' }],
  concepts: [{ id: 'concept-secret', revision: 1, statement: 'Gardening may encourage patience.', epistemicState: 'hypothesis' }],
});
const trace = (kind, seq, extra = {}) => ({
  id: `trace-${seq}`, episodeId: 'episode-a', kind, seq,
  createdAt: new Date(Date.UTC(2026, 8, 28, 0, 0, seq)).toISOString(), ...extra,
});
const output = (seq, callId = 'call-a', proposal = finalProposal(), extra = {}) => trace('call_output', seq, {
  callId, output: { text: JSON.stringify(proposal), complete: true, bytes: 100, stopReason: 'end_turn' }, ...extra,
});
const sections = entry => entry.sections.map(section => section.text || section.items?.join('\n') || '').join('\n');
const entryFor = (entries, id) => entries.find(entry => entry.id === id);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

describe('Person thought journal projection', () => {
  it('projects actual runtime request/output/activity/commit traces using the real proposal fixture', async () => {
    const proposal = finalProposal();
    const traces = [];
    const episode = { id: 'episode-a', kind: 'send', text: 'I am learning to garden.', baseStateVersion: 0, budget: { calls: 1, timeoutMs: 1000 } };
    const append = (_episode, kind, data) => { traces.push(trace(kind, traces.length + 1, data)); };
    // The runtime creates the actual trace payloads; only the storage envelope is in-memory.
    const repository = {
      leaseMs: 15000, heartbeat: async () => {}, context: async () => snapshot(), createdCapabilities: async () => [], append,
      startCall: async (e, data) => append(e, 'call_started', data),
      finalizeCall: async (e, data) => { append(e, 'call_output', { ...data, output: { ...data.output, complete: true } }); return true; },
      commit: async (e, p, selection, callId) => append(e, 'committed', { callId, decision: p.decision, stateVersion: 1 }),
      finish: async (e, kind, code) => append(e, kind, { code }),
    };
    append(episode, 'accepted', { trigger: { kind: episode.kind, text: episode.text } });
    const runtime = new PersonRuntime({ repository, getProvider: async () => ({ ...provider, adapter: {
      async *stream() {
        yield { type: 'thinking_delta', text: 'hidden-provider-reasoning' };
        yield { type: 'text_delta', text: JSON.stringify(proposal) };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    } }) });
    await runtime.run(episode, new AbortController());
    expect(traces.map(t => t.kind)).toEqual(['accepted', 'call_started', 'call_output', 'activity', 'committed']);
    const input = freeze([...traces].reverse());
    const entries = projectPersonThoughts(input);
    expect(entries.map(e => e.kind)).toEqual(['input', 'context', 'thought', 'committed']);
    expect(entries.map(e => e.status)).toEqual(['recorded', 'recorded', 'committed', 'committed']);
    expect(entries[0].sections).toEqual([{ label: 'input', text: episode.text }]);
    expect(entries[1].sections).toEqual([
      { label: 'input', text: episode.text },
      { label: 'state_summary', text: 'Considering earlier experience.' },
      { label: 'appraisal', text: 'Interested.' },
      { label: 'user_message', text: 'I am learning to garden.' },
      { label: 'concept_hypothesis', text: 'Gardening may encourage patience.' },
    ]);
    expect(entries[2].sections).toEqual([
      { label: 'activity_summary', text: proposal.activity.summary },
      { label: 'decision_summary', text: proposal.decision.summary },
      { label: 'self_check', text: proposal.decision.selfCheck },
      { label: 'uncertainties', items: proposal.decision.uncertainties },
      { label: 'concept_uncertain', text: proposal.concepts[0].statement },
      { label: 'state_summary', text: proposal.state.summary },
      { label: 'appraisal', text: proposal.state.appraisal },
      { label: 'reply', text: proposal.reply },
    ]);
    expect(entries[3].sections).toEqual([]); // Decision already appears with the output.
    expect(JSON.stringify(entries)).not.toMatch(/hidden-provider-reasoning|system-secret|catalog-secret|person-secret|message-secret|concept-secret/);
    expect(input[0].kind).toBe('committed'); // Sorting did not mutate source order.
  });

  it('keeps intermediate calls candidates and shows the next reason, never model/capability metadata', () => {
    const candidate = finalProposal();
    candidate.next = { model: 'private-model', effort: 'high', reason: 'Recall the earlier experience.', capability: { id: 'Recall', args: { query: 'private-query' } } };
    const entries = projectPersonThoughts([
      trace('committed', 3, { callId: 'second' }), output(2, 'second'), output(1, 'first', candidate),
    ]);
    expect(entries.slice(0, 2).map(e => e.status)).toEqual(['candidate', 'committed']);
    expect(entries[0].sections.at(-1)).toEqual({ label: 'next_reason', text: candidate.next.reason });
    expect(JSON.stringify(entries)).not.toMatch(/private-model|private-query|high/);
  });

  it('matches commit, rejection and call failure by both episode and call, not by episode alone', () => {
    const traces = [
      output(1, 'shared'), output(2, 'shared', finalProposal(), { episodeId: 'episode-b' }),
      output(3, 'other'), output(4, 'shared', finalProposal(), { episodeId: 'episode-c' }),
      trace('committed', 5, { callId: 'shared' }),
      trace('proposal_rejected', 6, { callId: 'shared', episodeId: 'episode-b' }),
      trace('call_failed', 7, { callId: 'shared', episodeId: 'episode-c', output: { text: '', complete: false } }),
    ];
    const entries = projectPersonThoughts(traces.reverse());
    expect([1, 2, 3, 4].map(seq => entryFor(entries, `trace-${seq}`).status)).toEqual(['committed', 'rejected', 'candidate', 'incomplete']);
    expect(entries.filter(e => e.kind === 'rejected')).toHaveLength(0);
  });

  it.each(['think', 'dream'])('keeps an empty %s stimulus visible without inventing user text', kind => {
    const context = assembleContext({ snapshot: snapshot(), episode: { id: 'episode-a', kind, text: '' },
      provider, selection: provider.defaultSelection, remainingCalls: 1 });
    const entries = projectPersonThoughts([
      trace('accepted', 1, { trigger: { kind, text: '' } }),
      trace('call_started', 2, { callId: 'call-a', request: { system: context.system, messages: context.messages } }),
    ]);
    expect(entries[0]).toMatchObject({ kind, status: 'recorded', sections: [] });
    expect(entries[1].sections[0]).toEqual({ label: kind });
    expect(projectPersonThoughts([trace('accepted', 1, { trigger: { kind, text: 'A starting question.' } })])[0].sections)
      .toEqual([{ label: kind, text: 'A starting question.' }]);
  });

  it('keeps truncated structured output in debug when cancellation is followed by a draining call failure', () => {
    const text = '{"activity":{"summary":"Only the beginning';
    const entries = projectPersonThoughts([
      trace('call_failed', 3, { callId: 'call-a', code: 'CANCELLED', output: { text, complete: false, accepted: false,
        usage: { reasoningTokens: 500 }, reasoning: 'provider-secret', raw: 'raw-secret' } }),
      trace('cancelled', 2, { code: 'CANCELLED' }),
    ]);
    expect(entries.map(e => [e.kind, e.status])).toEqual([['cancelled', 'recorded'], ['thought', 'incomplete']]);
    expect(entries[1].sections).toEqual([{ label: 'structured_unavailable' }]);
    expect(JSON.stringify(entries)).not.toMatch(/provider-secret|raw-secret|reasoningTokens/);
  });

  it('does not expose technical fields in truncated, fenced or prefaced JSON output', () => {
    const proposal = finalProposal();
    proposal.activity.sourceRefs = ['message:private-id:1'];
    proposal.next = { model: 'private/provider-model', reason: 'Look again.', effort: 'high' };
    const prefix = JSON.stringify(proposal).slice(0, -1);
    for (const text of [prefix, `\`\`\`json\n${prefix}`, `Here is my proposal:\n${prefix}`]) {
      const entries = projectPersonThoughts([trace('call_failed', 1, { callId: 'a', output: { text, complete: false } })]);
      expect(entries[0]).toMatchObject({ status: 'incomplete', sections: [{ label: 'structured_unavailable' }] });
      expect(JSON.stringify(entries)).not.toMatch(/sourceRefs|private-id|provider-model|baseStateVersion/);
    }
  });

  it.each(['messages', 'concepts'])('includes %s Recall and earlier candidate input at a continuation page boundary', kind => {
    const snap = snapshot();
    const previous = finalProposal();
    previous.state.summary = 'Previous candidate state, not adopted.';
    previous.next = { model: provider.defaultSelection.model, effort: null, reason: 'Recall earlier evidence.', capability: { id: 'Recall', args: { kind } } };
    const capabilityResult = { kind, items: snap[kind] };
    const context = assembleContext({ snapshot: snap, episode: { id: 'episode-a', kind: 'think', text: '' },
      provider, selection: provider.defaultSelection, previous, capabilityResult, remainingCalls: 1 });
    // The assembler intentionally removes recalled records from top-level arrays.
    expect(JSON.parse(context.messages[0].content)[kind]).toEqual([]);
    const entries = projectPersonThoughts([trace('call_started', 2, { callId: 'second', request: { system: context.system, messages: context.messages } })]);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('recorded'); // Recorded input, not accepted state.
    expect(entries[0].sections).toContainEqual({ scope: 'previous_candidate', label: 'state_summary', text: previous.state.summary });
    expect(entries[0].sections.filter(s => s.scope === 'previous_candidate').length).toBeGreaterThan(4);
    expect(entries[0].sections).toContainEqual(kind === 'messages'
      ? { scope: 'recalled', label: 'user_message', text: snap.messages[0].text }
      : { scope: 'recalled', label: 'concept_hypothesis', text: snap.concepts[0].statement });
    expect(JSON.stringify(entries)).not.toMatch(/system-secret|message-secret|concept-secret|test\/first|sourceRefs/);
    const registryInput = JSON.parse(context.messages[0].content);
    registryInput.previousProposal.next.capability.id = 'catalog.view';
    const registryEntries = projectPersonThoughts([trace('call_started', 3, { request: { messages: [{ role: 'user', content: JSON.stringify(registryInput) }] } })]);
    expect(registryEntries[0].sections.some(s => s.scope === 'recalled')).toBe(false);
  });

  it('does not promote a complete but uncommitted proposal on cancellation or budget exhaustion', () => {
    for (const kind of ['cancelled', 'failed', 'interrupted', 'budget_exhausted']) {
      const entries = projectPersonThoughts([output(1), trace(kind, 2, { code: 'diagnostic-only' })]);
      expect(entries[0].status).toBe('candidate');
      expect(entries[1]).toMatchObject({ kind, status: 'recorded', sections: [] });
    }
  });

  it('labels unstructured or incomplete output explicitly, including parseable fragments', () => {
    const entries = projectPersonThoughts([
      trace('call_output', 1, { callId: 'first', output: { text: 'A public but non-JSON answer.', complete: true } }),
      trace('call_output', 2, { callId: 'second', output: { text: JSON.stringify({ reply: 'A fragment.', reasoning: 'secret' }), complete: true } }),
      trace('call_failed', 3, { callId: 'third', output: { text: JSON.stringify(finalProposal()), complete: false, accepted: false } }),
      trace('call_failed', 4, { callId: 'fourth', output: { text: '', availability: 'unavailable' } }),
    ]);
    expect(entries.every(e => e.status === 'incomplete')).toBe(true);
    expect(entries[0].sections).toEqual([{ label: 'unstructured', text: 'A public but non-JSON answer.' }]);
    expect(entries[1].sections).toEqual([{ label: 'incomplete' }, { label: 'reply', text: 'A fragment.' }]);
    expect(entries[2].sections[0]).toEqual({ label: 'incomplete' });
    expect(entries[3].sections).toEqual([{ label: 'unavailable' }]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('labels a rejected complete or invalid JSON proposal as rejected, never accepted', () => {
    for (const text of [JSON.stringify(finalProposal()), 'Not valid JSON']) {
      const entries = projectPersonThoughts([
        trace('call_output', 1, { callId: 'call-a', output: { text, complete: true } }),
        trace('proposal_rejected', 2, { callId: 'call-a', code: 'INVALID_PROPOSAL' }),
        trace('failed', 3, { code: 'INVALID_PROPOSAL' }),
      ]);
      expect(entries.map(e => [e.kind, e.status])).toEqual([['thought', 'rejected'], ['failed', 'recorded']]);
      if (text === 'Not valid JSON') expect(entries[0].sections).toEqual([{ label: 'unstructured', text }]);
    }
  });

  it('keeps activity/decision content on a page missing its output and deduplicates only rendered sections', () => {
    const proposal = finalProposal();
    const activity = trace('activity', 2, { callId: 'call-a', activity: proposal.activity, decision: proposal.decision, disposition: 'proposed-commit' });
    const committed = trace('committed', 3, { callId: 'call-a', decision: proposal.decision });
    expect(projectPersonThoughts([activity])[0]).toMatchObject({ kind: 'activity', status: 'candidate' });
    const page = projectPersonThoughts([committed, activity]);
    expect(page[0]).toMatchObject({ kind: 'activity', status: 'committed' });
    expect(sections(page[0])).toContain(proposal.activity.summary);
    expect(projectPersonThoughts([committed])[0].sections[0]).toEqual({ label: 'decision_summary', text: proposal.decision.summary });
    expect(projectPersonThoughts([activity, output(1), committed]).map(e => e.kind)).toEqual(['thought', 'committed']);
    const fragment = trace('call_output', 1, { callId: 'call-a', output: { text: JSON.stringify({ activity: proposal.activity }), complete: true } });
    const partial = projectPersonThoughts([fragment, activity]);
    expect(partial[1].sections.map(s => s.label)).toEqual(['decision_summary', 'self_check', 'uncertainties']);
    const unstructured = trace('call_output', 1, { callId: 'call-a', output: { text: 'Only a prefix', complete: false } });
    expect(projectPersonThoughts([unstructured, activity])[1].sections[0].label).toBe('activity_summary');
  });

  it('keeps isolated terminal evidence and never infers a missing commit from activity disposition', () => {
    const entries = projectPersonThoughts([
      trace('proposal_rejected', 1, { callId: 'call-a' }),
      trace('committed', 2, { callId: 'call-b', decision: finalProposal().decision }),
      trace('call_failed', 3, { callId: 'call-c' }),
    ]);
    expect(entries.map(e => [e.kind, e.status])).toEqual([['rejected', 'rejected'], ['committed', 'committed'], ['thought', 'incomplete']]);
    expect(projectPersonThoughts([output(1)])[0].status).toBe('candidate');
  });

  it('renders recalled messages and concepts with roles and epistemic labels, omitting registry results', () => {
    const concepts = ['reported', 'hypothesis', 'imagined', 'uncertain', 'fact'].map(epistemicState => ({
      id: 'private-concept-id', statement: `${epistemicState} statement`, epistemicState, sourceRefs: ['private-ref'],
    }));
    const entries = projectPersonThoughts([
      trace('capability_result', 1, { callId: 'call-a', capability: { id: 'Recall', args: { query: 'private-query' } }, result: { kind: 'messages', items: [
        { role: 'user', text: 'A recalled report.', id: 'private-message-id' },
        { role: 'assistant', text: 'A recalled reply.' }, { role: 'system', text: 'private-system' },
      ], nextCursor: 'private-cursor' } }),
      trace('capability_result', 2, { capability: { id: 'Recall' }, result: { kind: 'concepts', items: concepts } }),
      trace('capability_result', 3, { capability: { id: 'catalog.view' }, result: { instructions: 'private-instructions', kind: 'concepts', items: concepts } }),
      trace('capability_result', 4, { capability: { id: 'catalog.search' }, result: { items: [{ description: 'private-description' }] } }),
    ]);
    expect(entries.map(e => e.kind)).toEqual(['memory', 'memory']);
    expect(entries[0].sections).toEqual([{ label: 'user_message', text: 'A recalled report.' }, { label: 'person_message', text: 'A recalled reply.' }]);
    expect(entries[1].sections.map(s => s.label)).toEqual(['concept_reported', 'concept_hypothesis', 'concept_imagined', 'concept_uncertain', 'concept_uncertain']);
    expect(entries.every(e => e.status === 'recorded')).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('private-');
  });

  it.each(['committed', 'cancelled', 'failed', 'budget_exhausted'])('records durable capability publication independently of a later %s thought', terminal => {
    const publication = trace('capability_result', 1, { callId: 'call-a', capability: { id: 'Capability.create', args: {
      code: 'PRIVATE_CODE', tests: [{ input: 'PRIVATE_TEST_INPUT' }], input: 'PRIVATE_INPUT',
    } }, result: { ok: true, published: true, contract: {
      id: 'Script.sum', description: 'Sum a list of numbers.', version: 1, code: 'PRIVATE_CODE', inputSchema: 'PRIVATE_SCHEMA',
    }, evidence: { engine: 'quickjs', testsPassed: 2, testedAt: '2026-10-02T00:00:00Z', tests: 'PRIVATE_TESTS' } } });
    const expected = { kind: 'capability_created', status: 'recorded', sections: [
      { label: 'capability_published' },
      { label: 'capability_name', text: 'Script.sum' },
      { label: 'capability_description', text: 'Sum a list of numbers.' },
      { label: 'capability_version', text: '1' },
      { label: 'capability_tests_passed', text: '2' },
      { label: 'capability_tests_limit' },
    ] };
    expect(projectPersonThoughts(freeze([publication]))[0]).toMatchObject(expected);
    const entries = projectPersonThoughts([trace(terminal, 2, { callId: 'call-a' }), publication, publication]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject(expected);
    expect(JSON.stringify(entries)).not.toMatch(/PRIVATE_|quickjs|testedAt|inputSchema/);
  });

  it('records script invocation status and version, without serializing inputs or even echoed output', () => {
    const entries = projectPersonThoughts(freeze([
      trace('capability_result', 1, { callId: 'call-a', capability: { id: 'Script.sum', args: { input: 'PRIVATE_INPUT' } }, result: {
        ok: true, id: 'Script.sum', version: 3, revision: 'PRIVATE_REVISION', access: 'pure-computation',
        output: { code: 'PRIVATE_CODE', echoedInput: 'PRIVATE_INPUT', nested: ['PRIVATE_OUTPUT'] }, diagnostics: 'PRIVATE_DIAGNOSTICS',
      } }), trace('committed', 2, { callId: 'call-a' }),
    ]));
    expect(entries[0]).toMatchObject({ kind: 'script_executed', status: 'recorded', sections: [
      { label: 'script_succeeded' }, { label: 'capability_name', text: 'Script.sum' }, { label: 'capability_version', text: '3' },
    ] });
    expect(JSON.stringify(entries)).not.toMatch(/PRIVATE_|output|revision|diagnostics/);
  });

  it.each([
    ['Capability.create', 'SCRIPT_TEST_FAILED', 'script_test_failed'],
    ['Script.sum', 'SCRIPT_EXECUTION', 'script_execution_failed'],
    ['Script.sum', 'SCRIPT_TIMEOUT', 'script_timeout'],
    ['Script.sum', 'SCRIPT_OUTPUT', 'script_output_invalid'],
    ['Script.sum', 'SCRIPT_VERSION', 'script_version_unavailable'],
    ['Script.sum', 'SCRIPT_BUSY', 'script_busy'],
    ['Capability.create', 'PRIVATE_PROVIDER_DIAGNOSTICS', 'capability_failure_unknown'],
  ])('shows an isolated %s failure (%s) using only a translated reason', (capabilityId, code, label) => {
    const entries = projectPersonThoughts([trace('capability_failed', 3, { capabilityId, code,
      capability: { id: capabilityId, args: { code: 'PRIVATE_CODE', tests: 'PRIVATE_TESTS' } },
      result: { ok: false, code, message: 'PRIVATE_MESSAGE', details: 'PRIVATE_DETAILS', output: 'PRIVATE_OUTPUT' },
      error: 'PRIVATE_PROVIDER_DIAGNOSTICS',
    })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'capability_failed', status: 'recorded', sections: [
      { label: 'capability_name', text: capabilityId }, { label },
    ] });
    expect(JSON.stringify(entries)).not.toContain('PRIVATE_');
  });

  it.each([
    ['Capability.create', { ok: true, published: true, contract: { id: 'Script.sum', description: 'Sum numbers.', version: 1 }, evidence: { testsPassed: 2 } }, 'capability_published'],
    ['Script.sum', { ok: true, id: 'Script.sum', version: 1, output: 'PRIVATE_OUTPUT', access: 'pure-computation' }, 'script_succeeded'],
    ['Capability.create', { ok: false, code: 'SCRIPT_TEST_FAILED', message: 'PRIVATE_DIAGNOSTICS' }, 'script_test_failed'],
    ['Script.sum', { ok: false, code: 'SCRIPT_TIMEOUT', message: 'PRIVATE_DIAGNOSTICS' }, 'script_timeout'],
  ])('keeps %s outcomes readable when only the continuation page is loaded', (id, capabilityResult, label) => {
    const previous = finalProposal();
    previous.next = { reason: 'Continue after the capability.', capability: { id, args: { code: 'PRIVATE_CODE', tests: 'PRIVATE_TESTS', input: 'PRIVATE_INPUT' } } };
    const value = { previousProposal: previous, capabilityResult };
    const continuation = trace('call_started', 4, { callId: 'second', request: { messages: [{ role: 'user', content: JSON.stringify(value) }] } });
    const page = projectPersonThoughts(freeze([continuation]));
    expect(page[0]).toMatchObject({ kind: 'context', status: 'recorded' });
    expect(page[0].sections).toContainEqual({ label, scope: 'capability_recorded' });
    expect(page[0].sections).toContainEqual({ label: 'capability_name', text: id === 'Capability.create' && capabilityResult.ok ? 'Script.sum' : id, scope: 'capability_recorded' });
    expect(JSON.stringify(page)).not.toContain('PRIVATE_');
    // A later page with commit evidence cannot promote a recorded capability outcome.
    const full = projectPersonThoughts([continuation, trace('committed', 5, { callId: 'second' })]);
    expect(full[0]).toEqual(page[0]);
  });

  it('bounds public capability text and rejects malformed publication evidence without coercing objects', () => {
    const result = { ok: true, published: true, contract: { id: 'Script.sum', description: 'x'.repeat(10000), version: 1 }, evidence: { testsPassed: 0 } };
    const publication = extra => trace('capability_result', 1, { capability: { id: 'Capability.create' }, result: { ...result, ...extra } });
    const entries = projectPersonThoughts([publication({})]);
    expect(entries[0].sections.find(s => s.label === 'capability_description').text).toBe(`${'x'.repeat(600)}…`);
    expect(entries[0].sections).toContainEqual({ label: 'capability_tests_passed', text: '0' });
    for (const extra of [{ ok: false }, { ok: 'true' }, { published: false }, { published: 'true' }, { contract: null }, { contract: { id: 'catalog.view' } }]) {
      expect(projectPersonThoughts([publication(extra)]).some(e => e.kind === 'capability_created')).toBe(false);
    }
    const malformed = projectPersonThoughts([publication({ contract: { id: 'Script.sum', description: {}, version: { value: 'PRIVATE_VERSION' } }, evidence: { testsPassed: -1 } })]);
    expect(malformed[0].sections.map(s => s.label)).toEqual(['capability_published', 'capability_name', 'capability_tests_limit']);
    expect(JSON.stringify(malformed)).not.toContain('PRIVATE_');
    expect(projectPersonThoughts([trace('capability_failed', 2, { capabilityId: 'catalog.view', code: 'SCRIPT_TIMEOUT' })])).toEqual([]);
  });

  it('allowlists parsed request/output content rather than serializing metadata or hidden reasoning', () => {
    const secret = 'NEVER_RENDER';
    const context = assembleContext({ snapshot: snapshot(), episode: { id: 'episode-a', kind: 'think', text: 'Consider patience.' },
      provider, selection: provider.defaultSelection, remainingCalls: 1 });
    const value = JSON.parse(context.messages[0].content);
    Object.assign(value, { models: secret, capabilities: secret, person: secret, budget: secret, sourceRefs: secret,
      previousProposal: { reasoning: secret, sourceRefs: [secret] }, capabilityResult: { text: secret }, contextNotice: secret, reasoning: secret });
    value.messages.push({ role: 'developer', text: secret }, { role: 'system', text: secret });
    const proposal = finalProposal();
    proposal.reasoning = secret; proposal.activity.hiddenReasoning = secret;
    proposal.decision.reasoning = secret; proposal.state.focusConceptIds = [secret];
    proposal.concepts[0].id = secret; proposal.concepts[0].sourceRefs = [secret];
    const entries = projectPersonThoughts([
      trace('call_started', 1, { callId: 'call-a', request: { system: secret, messages: [{ role: 'user', content: JSON.stringify(value) }, { role: 'system', content: secret }], maxTokens: secret }, manifest: secret, reason: secret }),
      output(2, 'call-a', proposal, { effective: secret, requested: secret, manifest: secret, reasoning: secret }),
      trace('call_output', 3, { output: { text: JSON.stringify({ system: secret, reasoning: secret, request: { text: secret } }), reasoning: secret } }),
    ]);
    expect(entries[0].sections.some(s => s.text === 'Consider patience.')).toBe(true);
    expect(entries[1].sections.some(s => s.text === proposal.reply)).toBe(true);
    expect(entries[2]).toMatchObject({ status: 'incomplete', sections: [{ label: 'unstructured' }] });
    expect(JSON.stringify(entries)).not.toContain(secret);
    expect(JSON.stringify(entries)).not.toMatch(/manifest|system-secret|catalog-secret|reasoning|sourceRefs/);
  });

  it('projects the atomic publication trace without a result and deduplicates its later result by call, ID and version', () => {
    const created = trace('capability_created', 1, { callId: 'create-call', capabilityId: 'Script.sum',
      capabilityManifest: { id: 'Script.sum', version: 1, revision: 'private-revision' },
      evidence: { testsPassed: 2, engine: 'quickjs', testedAt: 'private-time' }, code: 'PRIVATE_CODE' });
    const cancelled = trace('cancelled', 2);
    const alone = projectPersonThoughts([cancelled, created]);
    expect(alone.map(e => e.kind)).toEqual(['capability_created', 'cancelled']);
    expect(alone[0].status).toBe('recorded');
    expect(sections(alone[0])).toContain('Script.sum');
    const result = trace('capability_result', 3, { callId: 'create-call',
      capability: { id: 'Capability.create', args: { code: 'PRIVATE_CODE' } },
      result: { ok: true, published: true, contract: { id: 'Script.sum', version: 1, description: 'Sum numbers.' }, evidence: { testsPassed: 2 } } });
    const merged = projectPersonThoughts([result, created, cancelled, created]);
    expect(merged.filter(e => e.kind === 'capability_created')).toHaveLength(1);
    expect(merged[0].id).toBe(created.id);
    expect(sections(merged[0])).toContain('Sum numbers.');
    expect(JSON.stringify(merged)).not.toMatch(/PRIVATE_CODE|private-revision|private-time/);
    expect(projectPersonThoughts([result]).map(e => e.kind)).toEqual(['capability_created']);
    const unrelated = { ...result, id: 'unrelated', callId: 'another-call' };
    expect(projectPersonThoughts([created, unrelated]).filter(e => e.kind === 'capability_created')).toHaveLength(2);
  });

  it('returns HTML as unchanged text, never markup or interpreted content', () => {
    const html = '<img src=x onerror="alert(1)"><script>window.evil = true</script>';
    const proposal = finalProposal(); proposal.reply = html;
    const entries = projectPersonThoughts([
      trace('accepted', 1, { trigger: { kind: 'send', text: html } }), output(2, 'call-a', proposal),
      trace('call_failed', 3, { callId: 'call-b', output: { text: html, complete: false } }),
    ]);
    expect(entries[0].sections[0].text).toBe(html);
    expect(entries[1].sections.at(-1).text).toBe(html);
    expect(entries[2].sections[0].text).toBe(html);
    expect(entries.every(e => e.sections.every(s => !('html' in s)))).toBe(true);
  });

  it('ignores unknown and malformed traces, invalid context JSON and invalid nested fields safely', () => {
    for (const input of [null, undefined, {}, 'not an array', 5]) expect(projectPersonThoughts(input)).toEqual([]);
    const malformed = [null, undefined, [], 1, 'trace', {}, { kind: 'accepted' },
      trace('unknown', 1, { text: 'secret' }), trace('settings', 2, { settings: 'secret' }),
      trace('accepted', 3, { trigger: null }), trace('accepted', 4, { trigger: { kind: 'system', text: 'secret' } }),
      trace('call_started', 5, { request: { messages: [{ role: 'user', content: 'invalid secret' }] } }),
      trace('call_started', 6, { request: { messages: [{ role: 'system', content: '{"state":{"summary":"secret"}}' }] } }),
      trace('call_started', 7, { request: { messages: 'secret' } }),
      trace('capability_result', 8, { capability: { id: 'Recall' }, result: { kind: 'messages', items: [null, 1, { role: 'user', text: {} }] } }),
      trace('activity', 9, { activity: [], decision: { summary: {}, uncertainties: [null, {}] } }),
    ];
    expect(projectPersonThoughts(malformed)).toEqual([]);
    for (const text of ['null', '[]', '123', '"secret"', '{"reply":{}}']) {
      expect(projectPersonThoughts([trace('call_output', 1, { output: { text } })])[0])
        .toMatchObject({ status: 'incomplete', sections: [{ label: 'unstructured' }] });
    }
  });

  it('sorts repository sequences, deduplicates overlapping pages and supplies stable metadata only', () => {
    const first = trace('accepted', 1, { trigger: { kind: 'send', text: 'First' }, createdAt: '2026-09-28T01:00:00Z' });
    const second = trace('accepted', 2, { trigger: { kind: 'send', text: 'Second' }, createdAt: '2026-09-28T00:00:00Z' });
    const entries = projectPersonThoughts(freeze([second, first, { ...first }]));
    expect(entries.map(e => e.id)).toEqual(['trace-1', 'trace-2']);
    expect(Object.keys(entries[0]).sort()).toEqual(['createdAt', 'episodeId', 'id', 'kind', 'sections', 'status']);
    const dated = [{ ...first, seq: undefined }, { ...second, seq: undefined }];
    expect(projectPersonThoughts(dated).map(e => e.id)).toEqual(['trace-2', 'trace-1']);
    expect(projectPersonThoughts([{ ...first, createdAt: 'invalid' }])[0].createdAt).toBeNull();
    expect(projectPersonThoughts([output(1)])[0].callId).toBe('call-a');
  });
});
