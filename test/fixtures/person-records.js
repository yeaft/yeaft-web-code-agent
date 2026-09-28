// Real PersonRuntime event shapes; inference is scripted, not an external model.
export function personRecords() {
  const proposal = {
    baseStateVersion: 3,
    activity: { kind: 'rethink', summary: 'Maybe the delay came from the final verification step.', sourceRefs: [] },
    decision: { summary: 'Check the timeline before changing the workflow.', selfCheck: 'A repeated guess is not new evidence.', uncertainties: ['The release timeline is incomplete.'] },
    concepts: [{ id: 'release-delay', statement: 'Moving a check earlier might help.', epistemicState: 'hypothesis' }],
    state: { summary: 'Looking for a pattern in recent releases.', appraisal: 'Curious, not certain.' },
    reply: 'Would you like to review the verification step together?', next: null,
  };
  const context = { trigger: { kind: 'think', text: 'Why was yesterday’s release late?' }, state: { summary: 'Remember our release discussion.' },
    messages: [{ role: 'user', text: '<script>not HTML</script>', createdAt: 1 }], concepts: [{ statement: 'One release took longer.', epistemicState: 'reported' }], models: [{ secretCatalogField: 'diagnostic only' }] };
  return [
    { kind: 'accepted', trigger: context.trigger },
    { kind: 'call_started', callId: 'call-1', request: { system: 'PRIVATE SYSTEM PROMPT', messages: [{ role: 'user', content: JSON.stringify(context) }] }, manifest: { contextBytes: 123 }, requested: { model: 'test/model', effort: 'high' } },
    { kind: 'call_output', callId: 'call-1', output: { text: JSON.stringify(proposal), status: 'complete', reasoning: 'HIDDEN REASONING' } },
    { kind: 'activity', callId: 'call-1', activity: proposal.activity, decision: proposal.decision, disposition: 'proposed-commit' },
    { kind: 'committed', callId: 'call-1', stateVersion: 4, parentVersion: 3, decision: proposal.decision },
  ].map((entry, i) => ({ id: `trace-${i}`, episodeId: 'episode-1', seq: i + 1, createdAt: i + 1, ...entry }));
}
