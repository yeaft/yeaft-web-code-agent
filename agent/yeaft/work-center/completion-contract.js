function normalizeCriteria(value) {
  if (!Array.isArray(value)) return null;
  return value.map(item => String(item).trim()).filter(Boolean);
}

export function normalizeContractPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const patch = {};
  if (typeof value.title === 'string' && value.title.trim()) patch.title = value.title.trim().slice(0, 200);
  if (typeof value.goal === 'string' && value.goal.trim()) patch.goal = value.goal.trim();
  if (Object.hasOwn(value, 'acceptanceCriteria')) {
    const criteria = normalizeCriteria(value.acceptanceCriteria);
    if (!criteria) throw new Error('contractPatch.acceptanceCriteria must be an array');
    patch.acceptanceCriteria = criteria;
  }
  if (Object.hasOwn(value, 'deliveryTarget')) {
    if (!['response', 'workspace_files', 'pull_request', 'merge'].includes(value.deliveryTarget)) {
      throw new Error('contractPatch.deliveryTarget must be response, workspace_files, pull_request, or merge');
    }
    patch.deliveryTarget = value.deliveryTarget;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// Reject even falsy/raw patch fields before normalization can hide an attempted change.
export function assertCoordinatorContractAuthority(value, userOriginated) {
  if (userOriginated === true || !value || typeof value !== 'object') return;
  if (['title', 'goal', 'acceptanceCriteria', 'deliveryTarget'].some(key => Object.hasOwn(value, key))) {
    throw new Error('Automatic Work Center Coordinator contract and delivery target changes are forbidden; refinement requires a user-originated turn');
  }
}

function normalizeAcceptanceChecks(value, criteria) {
  if (!Array.isArray(value) || value.length !== criteria.length) return null;
  const checks = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const criterion = typeof raw.criterion === 'string' ? raw.criterion.trim() : '';
    const status = ['passed', 'failed', 'deferred', 'not_applicable'].includes(raw.status) ? raw.status : '';
    const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim().slice(0, 1_000) : '';
    if (criterion !== criteria[index] || !status || !evidence) return null;
    return { criterion, status, evidence };
  });
  return checks.every(Boolean) ? checks : null;
}

export function validateCompletedResult(result, action, workItem) {
  if (result.outcome !== 'completed') return;
  if (result.evidence.length === 0) {
    result.outcome = 'failed';
    result.error = 'Completed Action requires at least one concrete evidence item';
    return;
  }
  const criteria = result.contractPatch?.acceptanceCriteria
    ?? (Array.isArray(workItem.acceptanceCriteria) ? workItem.acceptanceCriteria : []);
  const checks = normalizeAcceptanceChecks(result.acceptanceChecks, criteria);
  if (!checks) {
    result.outcome = 'failed';
    result.error = 'Completed Action requires one ordered acceptance check with evidence for every acceptance criterion';
    return;
  }
  // Intermediate test Actions validate their own task-specific expected result.
  // Requiring them to prove the entire WorkItem contract makes any DAG with
  // later tests or reviews impossible to complete. Global proof belongs at the
  // delivery boundary or an approved review with no unfinished downstream work.
  const remainingStages = Array.isArray(workItem?.workflowSnapshot?.stages)
    ? workItem.workflowSnapshot.stages.filter(stage => stage?.id !== action.stageId)
    : [];
  const downstream = new Set([action.stageId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const stage of remainingStages) {
      if (downstream.has(stage?.id)) continue;
      if (Array.isArray(stage?.dependsOnStageIds)
          && stage.dependsOnStageIds.some(stageId => downstream.has(stageId))) {
        downstream.add(stage.id);
        expanded = true;
      }
    }
  }
  const hasDownstreamStage = remainingStages.some(stage => downstream.has(stage?.id));
  const hasDeliverStage = remainingStages.some(stage => stage?.type === 'deliver');
  const mustVerify = action.type === 'deliver'
    || (action.type === 'review' && result.reviewDecision === 'approved'
      && !hasDownstreamStage && !hasDeliverStage);
  if (mustVerify && checks.some(check => check.status !== 'passed')) {
    result.outcome = 'failed';
    result.error = `${action.type} Action requires every acceptance check to pass`;
  }
}
