import { normalizeEvidence, normalizeOutputs } from './evidence.js';
import { runMatchesActionIdentity } from './action-identity.js';

const CHECK_STATUSES = new Set(['passed', 'failed', 'deferred', 'not_applicable']);
const INACTIVE = new Set(['closed', 'superseded', 'cancelled']);
const NEGATIVE = new Set(['failed', 'error', 'pending']);
const revision = value => Math.max(1, Number(value) || 1);

export function validGoalChecks(run, criteria) {
  return Array.isArray(run?.acceptanceChecks) && run.acceptanceChecks.length === criteria.length
    && run.acceptanceChecks.every((check, index) => (
      check?.criterion === criteria[index] && CHECK_STATUSES.has(check.status)
      && typeof check.evidence === 'string' && check.evidence.trim()
    ));
}

export function hasContradictoryEvidence(run) {
  return !!run?.error || run?.reviewDecision === 'changes_requested'
    || [...normalizeEvidence(run?.evidence), ...normalizeOutputs(run?.outputs)]
      .some(item => NEGATIVE.has(item.status));
}

/**
 * Read only durable identities, never a model's progress estimate. Older records
 * use Action.contractRevision when the optional execution manifest is absent.
 * A completed Run needs its canonical pointer; failed/waiting Actions use their
 * latest terminal attempt only to report blockers/contradictions, never proof.
 */
export function currentGoalRuns(detail) {
  const runs = Array.isArray(detail?.runs) ? detail.runs : [];
  const result = [];
  for (const action of detail?.actions || []) {
    if (INACTIVE.has(action.status) || action.status === 'running'
        || revision(action.contractRevision) !== revision(detail.revision)) continue;
    const owned = runs.filter(run => run.actionId === action.id
      && (!run.workItemId || run.workItemId === detail.id)
      && (!action.workItemId || action.workItemId === detail.id)
      && runMatchesActionIdentity(run, action)
      && (run.executionManifest?.actionGeneration == null || revision(run.executionManifest.actionGeneration) === revision(action.generation))
      && (!run.executionManifest?.actionSpecHash || run.executionManifest.actionSpecHash === action.specHash)
      && revision(run.executionManifest?.contractRevision ?? action.contractRevision) === revision(detail.revision)
      && revision(run.contextSnapshot?.contract?.revision ?? action.contractRevision) === revision(detail.revision)
      && ['completed', 'failed', 'waiting'].includes(run.status));
    const run = action.status === 'completed'
      ? owned.find(candidate => candidate.id === action.resultRunId && candidate.status === 'completed')
      : ['failed', 'waiting'].includes(action.status)
        ? owned.sort((a, b) => Number(b.endedAt || b.startedAt) - Number(a.endedAt || a.startedAt))[0]
        : null;
    if (run) result.push(run);
  }
  return result;
}

/** Derived, restart-safe projection; no new database state or migrations. */
export function deriveGoalProgress(detail) {
  const contract = Array.isArray(detail?.acceptanceCriteria) ? detail.acceptanceCriteria : [];
  const runs = currentGoalRuns(detail);
  const proof = runs.filter(run => run.status === 'completed' && normalizeEvidence(run.evidence).length > 0
    && !hasContradictoryEvidence(run) && validGoalChecks(run, contract));
  const byId = new Map((detail?.actions || []).map(action => [action.id, action]));
  // Retrying, guiding, or closing an Action is not a correction. Keep historical
  // negative observations until a newer current canonical Run disproves them.
  // These attempts can invalidate proof but can never establish it.
  const observations = (detail?.runs || []).filter(run => {
    const action = byId.get(run.actionId);
    return action && (!run.workItemId || run.workItemId === detail.id)
      && (!action.workItemId || action.workItemId === detail.id)
      && ['completed', 'failed', 'waiting', 'retryable'].includes(run.status)
      && revision(run.executionManifest?.contractRevision ?? action.contractRevision) === revision(detail.revision)
      && revision(run.contextSnapshot?.contract?.revision ?? action.contractRevision) === revision(detail.revision);
  });
  const observedAt = run => Number(run.endedAt || run.startedAt) || 0;
  // Subsequent writes can invalidate earlier tests. A later read-only observation
  // does not invalidate unrelated proof; after a write, re-check the affected
  // contract rather than completing from a pre-change observation.
  // Retiring a writer is not rollback. Include historical attempts, including
  // failed/closed/superseded generations, in the freshness watermark.
  const writes = (detail?.runs || []).filter(run => {
    const action = byId.get(run.actionId);
    return action && (!run.workItemId || run.workItemId === detail.id)
      && action.workspaceMode && action.workspaceMode !== 'read'
      && revision(run.executionManifest?.contractRevision ?? action.contractRevision) === revision(detail.revision);
  });
  // Ending after another writer is insufficient: tests may have run before its
  // mutation. Without a durable ordering at equal timestamps, require a new
  // observation. The writer's own end-to-end proof remains usable.
  const freshProof = proof.filter(run => writes.every(writer => writer.id === run.id
    || (Number(run.startedAt) || observedAt(run)) > observedAt(writer)));
  const contradictions = contract.map((criterion, index) => observations.filter(run => (
    run.acceptanceChecks?.[index]?.criterion === criterion
      && (run.acceptanceChecks[index].status === 'failed'
        || (run.acceptanceChecks[index].status !== 'not_applicable' && hasContradictoryEvidence(run)))
  )));
  const latestContradictionAt = contradictions.map(runs => Math.max(-Infinity, ...runs.map(observedAt)));
  const criteria = contract.map((criterion, index) => {
    // A correction establishes new proof; it never revives an older disproved
    // Run. Overlapping/tied observations cannot establish corrective ordering.
    const passing = freshProof.filter(run => run.acceptanceChecks[index].status === 'passed'
      && (Number(run.startedAt) || observedAt(run)) > latestContradictionAt[index]);
    const conflicts = passing.length ? [] : contradictions[index];
    const evidenceRunIds = passing.map(run => run.id);
    return {
      criterion,
      status: conflicts.length ? 'failed' : evidenceRunIds.length ? 'passed' : 'unmet',
      evidenceRunIds: conflicts.length ? [] : evidenceRunIds,
      ...(conflicts.length ? { conflictingRunIds: conflicts.map(run => run.id) } : {}),
    };
  });
  const target = detail?.deliveryTarget || null;
  const outputKind = { workspace_files: 'file', pull_request: 'pr', merge: 'commit' }[target];
  const deliveryRunIds = freshProof.filter(run => target === 'response'
    ? typeof run.summary === 'string' && run.summary.trim()
      // Summaries are indivisible: do not deliver one whose applicable claims
      // predate a contradiction, even after a different Run corrects it.
      && run.acceptanceChecks.every((check, index) => check.status !== 'failed'
        && (check.status === 'not_applicable'
          || (Number(run.startedAt) || observedAt(run)) > latestContradictionAt[index]))
    : outputKind && normalizeOutputs(run.outputs).some(output => output.kind === outputKind && !NEGATIVE.has(output.status)))
    .map(run => run.id);
  const blockers = (detail?.actions || []).filter(action => ['failed', 'waiting'].includes(action.status))
    .map(action => {
      const run = runs.find(candidate => candidate.actionId === action.id);
      return { actionId: action.id, status: action.status, reason: run?.waitingReason || run?.error || action.brief?.objective || '' };
    });
  return {
    contractRevision: revision(detail?.revision),
    criteria,
    remainingCriteria: criteria.filter(item => item.status !== 'passed').map(item => item.criterion),
    completedCriteriaCount: criteria.filter(item => item.status === 'passed').length,
    totalCriteriaCount: criteria.length,
    evidenceRunIds: [...new Set(criteria.flatMap(item => item.evidenceRunIds))],
    blockers,
    delivery: { target, status: deliveryRunIds.length ? 'passed' : 'unmet', evidenceRunIds: deliveryRunIds },
  };
}
