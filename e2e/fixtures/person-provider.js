// Scripted inference only; uses the production adapter protocol and transcript.
// Person execution supplies native schemas, then tools:[] for final cognition.
export const personInput = params => JSON.parse(params.messages[0].content);
const allToolResults = params => params.messages.filter(message => message.role === 'tool')
  .map(message => ({ toolUseId: message.toolCallId, ...JSON.parse(message.content) }));
// Goal reports and evidence recovery are protocol bookkeeping, not another
// publication, script result, spawn, or other operation in the fixture's script.
export const personToolResults = params => allToolResults(params)
  .filter(result => !['Execution.goal', 'Execution.read'].includes(result.id) && !result.id?.startsWith('catalog.'));
export const personCognition = params => params.tools.length === 0;
export const personToolCall = (id, name, input = {}) => ({ type: 'tool_call', id, name: name.replaceAll('.', '__'), input });
export const personStop = hasTools => ({ type: 'stop', stopReason: hasTools ? 'tool_use' : 'end_turn' });

/** Scripted model's explicit goal milestone. Complete only AFTER the scenario
 * has checked actual semantic results. This is a native tool call, not a runtime
 * adapter: rejected reports fail the fixture, and acceptance uses observed refs.
 * Tools such as Recall/Script return no sourceRef; read their real durable trace
 * rather than inventing provenance or blessing the trigger as execution proof. */
export function personGoal(params, { objective, acceptance, check, status = 'completed', waitFor = [] }) {
  const results = allToolResults(params);
  const report = results.findLast(result => result.id === 'Execution.goal');
  if (report && (report.ok !== true || !report.goal)) throw new Error(`Execution.goal rejected: ${report.output}`);
  if (report?.goal.status === status) {
    if (report.goal.objective !== objective || report.goal.acceptance !== acceptance) throw new Error('Execution.goal commitment changed unexpectedly');
    return null;
  }
  const operations = personToolResults(params);
  const evidenceReads = results.filter(result => result.id === 'Execution.read');
  if (evidenceReads.some(result => result.ok !== true)) throw new Error('Actual execution evidence recovery failed');
  const observations = results.filter(result => result.sourceRef && result.errorEffect !== 'none');
  if (status === 'completed' && !observations.length && operations.length) {
    const operation = operations.at(-1);
    const args = operation.recovery?.read?.args ?? (operation.executionTraceCallId ? { callId: operation.executionTraceCallId } : null);
    if (!args) throw new Error('Missing actual execution evidence recovery identity');
    return personToolCall('goal-evidence', 'Execution.read', args);
  }
  const sourceRefs = observations.slice(-4).map(result => result.sourceRef);
  if (status === 'completed' && (!check || !sourceRefs.length)) throw new Error('Completion requires checked actual tool observations');
  return personToolCall(`goal-${status}`, 'Execution.goal', {
    objective, acceptance, kind: 'work', status,
    reason: status === 'completed' ? check : '',
    nextStep: status === 'waiting' ? 'Collect the owned task result after it stops, then verify acceptance.'
      : status === 'active' ? 'Perform the scoped authorized work and verify the actual results.' : '',
    sourceRefs, acceptanceChecks: status === 'completed' ? [{ check, sourceRefs }] : [], waitFor, blocker: null,
  });
}
