import { sessionMessageQuotePrompt } from '../session-message-quote.js';
import { isDynamicWorkItem } from './execution-mode.js';
import { renderSessionContextSnapshot } from './session-context.js';

export const BUILT_IN_ACTION_TYPES = Object.freeze([
  'triage',
  'research',
  'design',
  'diagnose',
  'implement',
  'migrate',
  'test',
  'review',
  'integrate',
  'document',
  'operate',
  'deliver',
  'write',
  'create_vp',
  'custom',
]);
const STAGE_TYPES = new Set(BUILT_IN_ACTION_TYPES);
const ASSIGNMENT_MODES = new Set(['auto', 'pool', 'fixed', 'planned']);
const MODEL_MODES = new Set(['inherit', 'primary', 'fast', 'specific', 'tag']);
const MODEL_EFFORTS = new Set(['medium', 'high', 'xhigh']);
const WORKSPACE_MODES = new Set(['shared', 'read', 'isolated-write', 'integrate']);
const ACTION_CONTEXT_QUOTE_MAX_BYTES = 8 * 1024;

export const DEFAULT_WORK_CENTER_MODEL_TAGS = Object.freeze({
  fast: 'gpt-5.6-luna',
  balanced: 'gpt-5.6-sol',
  ultimate: 'gpt-6-astra',
});

const ULTIMATE_ACTION_TYPES = new Set(['triage', 'research', 'design', 'diagnose', 'review']);
const FAST_ACTION_TYPES = new Set(['document', 'deliver', 'write']);

function normalizeModelTags(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : DEFAULT_WORK_CENTER_MODEL_TAGS;
  return Object.fromEntries(Object.entries(source)
    .map(([tag, model]) => [canonicalActionId(tag), typeof model === 'string' ? model.trim() : ''])
    .filter(([tag, model]) => tag && model));
}

function defaultActionModelTag(type) {
  if (ULTIMATE_ACTION_TYPES.has(type)) return { tag: 'ultimate', effort: 'xhigh' };
  if (FAST_ACTION_TYPES.has(type)) return { tag: 'fast', effort: 'medium' };
  return { tag: 'balanced', effort: 'high' };
}

const DEFAULT_STAGE_INSTRUCTIONS = Object.freeze({
  triage: 'Turn the request into an executable contract. Inspect relevant repository facts before deciding the flow. Classify the WorkItem, identify constraints, risks, dependencies, and missing acceptance criteria, then plan only the Actions needed for this task. Do not implement. If the goal or acceptance criteria must change, submit a contractPatch and explain why.',
  research: 'Answer the Action objective with verifiable evidence. Search the repository and, when needed, authoritative external sources. Separate observed facts from inference, record unresolved uncertainty, and produce a concise conclusion that a later Action can use.',
  design: 'Design the smallest maintainable solution that satisfies the WorkItem contract. Inspect existing architecture and conventions, define data flow and boundaries, consider failure and compatibility cases, and leave concrete implementation guidance. Do not add abstraction without a demonstrated need.',
  diagnose: 'Reproduce or otherwise establish the reported behavior, trace it to a root cause, and distinguish evidence from hypotheses. Identify the smallest safe correction and the regression tests that would prove it. Do not stop at the visible symptom.',
  implement: 'Implement the Action objective in the supplied work directory using the smallest correct diff. Follow repository conventions, preserve compatibility, handle relevant boundary conditions, and add or update focused tests. Run the checks needed to prove the change. Use prior Action and review findings; do not approve your own work.',
  migrate: 'Execute the required migration without losing existing semantics or data. Define compatibility and rollback boundaries, make the operation repeatable or safely fenced, validate representative legacy data, and provide evidence for both upgraded and already-current states.',
  test: 'Verify the current result against every applicable acceptance criterion. Run focused tests first, then the broader checks justified by the risk. Cover failure, compatibility, and boundary cases, report exact reproducible evidence, and do not hide skipped or inconclusive checks.',
  review: 'Review the implementation and evidence independently against the WorkItem contract and repository rules. Prioritize correctness, security, data loss, compatibility, and missing tests over style preferences. Return approved or changes_requested with concrete, actionable findings and evidence.',
  integrate: 'Integrate only completed isolated Action branches. Stop on any merge conflict instead of guessing, inspect the combined tree, run focused consistency checks, and leave a clean integrated result for downstream verification.',
  document: 'Update the user or maintainer documentation required by the Action objective. Keep terminology and examples consistent with actual behavior, cover compatibility or operational consequences, and verify links, commands, and bilingual requirements where applicable.',
  operate: 'Perform the operational change with explicit preconditions, safety fences, observability, and rollback handling. Verify the live or simulated postcondition from authoritative state, avoid destructive shortcuts, and record the exact evidence needed for handoff.',
  deliver: 'Deliver only an approved result using the repository release policy. Recheck the reviewed commit and remote state, run required final verification on the immutable delivery tree, publish only the requested artifacts, and report commit, tag, deployment, and residual-risk evidence.',
  write: 'Produce the requested written deliverable for its intended audience. Use the available evidence, preserve required terminology and structure, avoid unsupported claims, and verify the result against every acceptance criterion.',
  create_vp: 'Create a persistent specialist VP only when it is itself an explicitly requested deliverable. A missing skill label is not a reason to expand roles: prefer an existing VP with a task-specific brief, and request human help for unavailable tools or authorization. Author a narrow role, traits, and persona with the CreateWorkItemVp tool, then report the new VP id as evidence. Do not clone an existing VP or create a generic replacement.',
  custom: 'Complete the Action objective using repository facts and the WorkItem contract. State the approach, handle relevant risks and boundary conditions, produce the requested artifact or change, verify the result, and return concrete evidence plus any residual uncertainty.',
});

const DEFAULT_ACTION_BRIEFS = Object.freeze({
  triage: ['Turn the request into a precise, executable Work Item contract and plan.', 'Inspect the relevant facts, resolve scope and risks, then select the smallest reliable Action sequence.', 'A frozen Work Item type, validated contract, and executable Action plan.'],
  research: ['Resolve the question or uncertainty named by this Action with verifiable evidence.', 'Inspect repository facts and authoritative sources, separating observations from inference.', 'A concise evidence-backed conclusion that the next Action can use.'],
  design: ['Define the smallest maintainable solution for this Action.', 'Inspect existing architecture, data flow, compatibility constraints, and failure boundaries.', 'Concrete implementation guidance with explicit trade-offs and risks.'],
  diagnose: ['Establish the root cause of the reported behavior.', 'Reproduce the behavior, trace the responsible path, and distinguish evidence from hypotheses.', 'A proven root cause, minimal correction, and regression-test plan.'],
  implement: ['Implement the required change with the smallest correct diff.', 'Follow repository conventions, handle relevant boundaries, and add focused tests while making the change.', 'A maintainable implementation with focused verification evidence.'],
  migrate: ['Move existing data or behavior to the required shape without losing semantics.', 'Fence compatibility and rollback boundaries, then validate legacy and already-current states.', 'A repeatable or safely fenced migration with representative evidence.'],
  test: ['Verify the current result against the Work Item acceptance criteria.', 'Run focused checks first, then broader risk-appropriate tests including failure and compatibility cases.', 'Reproducible pass/fail evidence for every applicable acceptance criterion.'],
  review: ['Review the current result independently against the Work Item contract.', 'Prioritize correctness, security, data loss, compatibility, and missing tests over style preferences.', 'An approval or concrete change request supported by evidence.'],
  integrate: ['Combine the completed isolated Action branches into one verified result.', 'Merge only declared dependency commits, stop on conflicts, and inspect the combined tree.', 'A clean integrated result ready for test and review.'],
  document: ['Update the documentation required by this Action.', 'Align terminology and examples with actual behavior and verify links, commands, and language requirements.', 'Accurate, usable documentation that matches the delivered behavior.'],
  operate: ['Perform the requested operational change safely.', 'Check preconditions, apply safety fences, preserve rollback options, and verify authoritative state.', 'A verified operational postcondition with handoff and rollback evidence.'],
  deliver: ['Deliver the approved Work Item result using repository release policy.', 'Recheck immutable reviewed state, run final gates, and publish only the requested artifacts.', 'A traceable delivery with commit, artifact, deployment, and residual-risk evidence.'],
  write: ['Produce the written deliverable requested by this Action.', 'Use available evidence, the intended audience, and the required terminology and structure.', 'A complete written artifact verified against the acceptance criteria.'],
  create_vp: ['Create the persistent specialist VP explicitly requested as this Work Item deliverable.', 'Have the assigned existing VP author a narrow persistent role and persona with the dedicated VP creation tool.', 'A new Agent-local VP whose identity and capability can be selected by later Actions.'],
  custom: ['Complete the domain-specific objective defined for this Action.', 'Use repository facts, handle relevant risks and boundaries, and verify the produced result.', 'The requested artifact or change with concrete evidence and residual uncertainty.'],
});

function defaultActionBrief(type) {
  const [objective, approach, expectedOutcome] = DEFAULT_ACTION_BRIEFS[STAGE_TYPES.has(type) ? type : 'custom'];
  return { objective, approach, expectedOutcome };
}

function hasCompleteActionBrief(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && ['objective', 'approach', 'expectedOutcome'].every(key => (
      typeof value[key] === 'string' && value[key].trim()
    ));
}

export function normalizeActionBrief(value, type) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = defaultActionBrief(type);
  return Object.fromEntries(Object.keys(defaults).map(key => [
    key,
    typeof source[key] === 'string' && source[key].trim()
      ? source[key].trim().slice(0, 2_000)
      : defaults[key],
  ]));
}

export function taskSpecificActionBrief(value, type) {
  if (!hasCompleteActionBrief(value)) return null;
  const brief = normalizeActionBrief(value, type);
  const defaults = defaultActionBrief(type);
  return Object.keys(defaults).every(key => brief[key] !== defaults[key]) ? brief : null;
}

const DEFAULT_SOFTWARE_CHANGE_STAGES = Object.freeze([
  {
    id: 'triage', name: 'Triage', type: 'triage',
    assignmentPolicy: { mode: 'auto', capability: 'triage', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
    modelPolicy: { mode: 'tag', tag: 'ultimate', effort: 'xhigh' },
    maxAttempts: 2,
  },
  {
    id: 'implement', name: 'Implement', type: 'implement',
    assignmentPolicy: { mode: 'auto', capability: 'implement', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
    modelPolicy: { mode: 'tag', tag: 'balanced', effort: 'high' },
    maxAttempts: 2,
  },
  {
    id: 'review', name: 'Review', type: 'review',
    assignmentPolicy: { mode: 'auto', capability: 'review', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: ['implement'] },
    modelPolicy: { mode: 'tag', tag: 'ultimate', effort: 'xhigh' },
    maxAttempts: 2,
    changesRequestedStageId: 'implement',
  },
  {
    id: 'deliver', name: 'Deliver', type: 'deliver',
    assignmentPolicy: { mode: 'auto', capability: 'deliver', candidateVpIds: [], fixedVpId: null, separateFromStageTypes: [] },
    modelPolicy: { mode: 'tag', tag: 'fast', effort: 'medium' },
    maxAttempts: 2,
  },
]);

export const RUN_OUTCOMES = Object.freeze([
  'completed',
  'waiting',
  'retryable',
  'failed',
]);

export function canonicalActionId(value, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

export function canonicalExplicitActionId(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Work Center ${field} contains an empty Action reference`);
  }
  const id = canonicalActionId(value);
  if (!id) {
    throw new Error(`Work Center ${field} contains an invalid Action reference: ${value}`);
  }
  return id;
}

export function canonicalExplicitActionIds(value, field) {
  if (!Array.isArray(value)) {
    throw new Error(`Work Center ${field} must be an array of Action references`);
  }
  return [...new Set(value.map(item => canonicalExplicitActionId(item, field)))];
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))];
}

export function normalizeAssignmentPolicy(value, stageType = 'custom') {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = ASSIGNMENT_MODES.has(source.mode) ? source.mode : 'auto';
  const fixedVpId = typeof source.fixedVpId === 'string' && source.fixedVpId.trim()
    ? source.fixedVpId.trim()
    : null;
  const candidateVpIds = uniqueStrings(source.candidateVpIds);
  if (mode === 'fixed' && !fixedVpId) throw new Error('Fixed Work Center assignment requires fixedVpId');
  if (['pool', 'planned'].includes(mode) && candidateVpIds.length === 0) {
    throw new Error('Work Center VP candidate list cannot be empty');
  }
  return {
    mode,
    capability: canonicalActionId(source.capability, stageType),
    candidateVpIds,
    fixedVpId,
    assignmentReason: typeof source.assignmentReason === 'string'
      ? source.assignmentReason.trim().slice(0, 1_000)
      : '',
    separateFromStageTypes: uniqueStrings(source.separateFromStageTypes),
  };
}

export function normalizeModelPolicy(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const mode = MODEL_MODES.has(source.mode) ? source.mode : 'inherit';
  const model = typeof source.model === 'string' && source.model.trim() ? source.model.trim() : null;
  const tag = typeof source.tag === 'string' && source.tag.trim()
    ? canonicalActionId(source.tag)
    : null;
  const effort = MODEL_EFFORTS.has(source.effort) ? source.effort : null;
  if (mode === 'specific' && !model) throw new Error('Specific Work Center model policy requires a model');
  if (mode === 'tag' && !tag) throw new Error('Tagged Work Center model policy requires a tag');
  return { mode, model, tag, effort };
}

export function defaultActionModelPolicy(type, fallback = null) {
  if (fallback) return normalizeModelPolicy(fallback);
  return normalizeModelPolicy({ mode: 'tag', ...defaultActionModelTag(type) });
}

export function normalizeActionModelPolicies(value, fallback = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries([...STAGE_TYPES].map(type => [
    type,
    normalizeModelPolicy(Object.hasOwn(source, type)
      ? { ...defaultActionModelPolicy(type, fallback), ...source[type] }
      : defaultActionModelPolicy(type, fallback)),
  ]));
}

export function defaultWorkCenterStageInstruction(type) {
  return DEFAULT_STAGE_INSTRUCTIONS[STAGE_TYPES.has(type) ? type : 'custom'];
}

export function defaultWorkCenterStageInstructions() {
  return { ...DEFAULT_STAGE_INSTRUCTIONS };
}

function normalizeGlobalInstructions(value) {
  return typeof value === 'string' ? value.trim().slice(0, 20_000) : '';
}

function generatedActionType(value) {
  return canonicalActionId(value, 'custom').slice(0, 64);
}

export function normalizeWorkflowDefinition(value, index = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Work Center workflow must be an object');
  }
  const id = canonicalActionId(value.id, `workflow-${index + 1}`);
  const name = String(value.name || id).trim() || id;
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    throw new Error(`Work Center workflow "${id}" requires at least one stage`);
  }
  const planningMode = value.planningMode === 'ai' ? 'ai' : 'static';
  const executionMode = value.executionMode === 'graph' ? 'graph' : 'linear';
  const seen = new Set();
  const stages = value.stages.map((rawStage, stageIndex) => {
    const source = rawStage && typeof rawStage === 'object' ? rawStage : {};
    const type = planningMode === 'ai'
      ? generatedActionType(source.type)
      : (STAGE_TYPES.has(source.type) ? source.type : 'custom');
    const stageId = canonicalActionId(source.id, `${type}-${stageIndex + 1}`);
    if (seen.has(stageId)) throw new Error(`Duplicate Work Center stage id: ${stageId}`);
    seen.add(stageId);
    const stage = {
      id: stageId,
      name: String(source.name || stageId).trim() || stageId,
      type,
      ...normalizeActionBrief(source, type),
      instruction: typeof source.instruction === 'string' && source.instruction.trim()
        ? source.instruction.trim()
        : defaultWorkCenterStageInstruction(type),
      assignmentPolicy: normalizeAssignmentPolicy(source.assignmentPolicy, type),
      modelPolicy: normalizeModelPolicy(source.modelPolicy),
      dependsOnStageIds: uniqueStrings(source.dependsOnStageIds),
      workspaceMode: WORKSPACE_MODES.has(source.workspaceMode) ? source.workspaceMode : 'shared',
      maxAttempts: Math.min(Math.max(Number(source.maxAttempts) || 2, 1), 5),
    };
    if (type === 'review') {
      stage.changesRequestedStageId = canonicalActionId(source.changesRequestedStageId, 'implement');
    }
    return stage;
  });
  for (const [stageIndex, stage] of stages.entries()) {
    if (stage.type !== 'review') continue;
    const targetIndex = stages.findIndex(candidate => candidate.id === stage.changesRequestedStageId);
    if (targetIndex === -1) {
      throw new Error(`Review stage "${stage.id}" points to missing stage "${stage.changesRequestedStageId}"`);
    }
    const target = stages[targetIndex];
    if (targetIndex >= stageIndex || target.type === 'review' || target.type === 'deliver') {
      throw new Error(`Review stage "${stage.id}" must return to an earlier editable stage`);
    }
  }
  return {
    version: 1,
    id,
    name,
    planningMode,
    executionMode,
    workItemType: typeof value.workItemType === 'string' && value.workItemType.trim()
      ? canonicalActionId(value.workItemType, 'general')
      : null,
    globalInstructions: normalizeGlobalInstructions(value.globalInstructions),
    modelPolicy: normalizeModelPolicy(value.modelPolicy),
    actionModelPolicies: normalizeActionModelPolicies(value.actionModelPolicies, value.modelPolicy),
    actionInstructions: normalizeActionInstructions(value.actionInstructions),
    actionTemplates: Array.isArray(value.actionTemplates)
      ? value.actionTemplates.map(template => normalizeWorkflowDefinition(template))
      : [],
    stages,
  };
}

export function normalizeActionInstructions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries([...STAGE_TYPES].map(type => [
    type,
    typeof source[type] === 'string' && source[type].trim()
      ? source[type].trim()
      : defaultWorkCenterStageInstruction(type),
  ]));
}

export function defaultWorkCenterSettings() {
  return {
    version: 1,
    revision: 1,
    defaultWorkflowId: 'software-change',
    startImmediately: true,
    maxConcurrentActions: 3,
    defaultWorkDir: '',
    globalInstructions: '',
    modelTags: { ...DEFAULT_WORK_CENTER_MODEL_TAGS },
    modelPolicy: normalizeModelPolicy({ mode: 'tag', tag: 'balanced', effort: 'high' }),
    coordinatorModelPolicy: normalizeModelPolicy({ mode: 'tag', tag: 'ultimate', effort: 'xhigh' }),
    actionModelPolicies: normalizeActionModelPolicies(),
    actionInstructions: normalizeActionInstructions(),
    workflows: [normalizeWorkflowDefinition({
      id: 'software-change',
      name: 'Software change',
      stages: DEFAULT_SOFTWARE_CHANGE_STAGES,
    })],
  };
}

export function normalizeWorkCenterSettings(value) {
  const defaults = defaultWorkCenterSettings();
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const workflows = Array.isArray(source.workflows) && source.workflows.length > 0
    ? source.workflows.map(normalizeWorkflowDefinition)
    : defaults.workflows;
  const workflowIds = new Set();
  for (const workflow of workflows) {
    if (workflowIds.has(workflow.id)) throw new Error(`Duplicate Work Center workflow id: ${workflow.id}`);
    workflowIds.add(workflow.id);
  }
  const defaultWorkflowId = workflowIds.has(source.defaultWorkflowId)
    ? source.defaultWorkflowId
    : workflows[0].id;
  const defaultWorkflow = workflows.find(workflow => workflow.id === defaultWorkflowId) || workflows[0];
  const migratedInstructions = Object.fromEntries(defaultWorkflow.stages.map(stage => [stage.type, stage.instruction]));
  const migratedModelPolicy = defaultWorkflow.stages.find(stage => stage.type === 'triage')?.modelPolicy
    || defaultWorkflow.stages[0]?.modelPolicy;
  const revision = Number.isInteger(source.revision) && source.revision > 0 ? source.revision : 1;
  return {
    version: 1,
    revision,
    defaultWorkflowId,
    startImmediately: source.startImmediately !== false,
    maxConcurrentActions: Math.min(Math.max(Number(source.maxConcurrentActions) || 3, 1), 12),
    defaultWorkDir: typeof source.defaultWorkDir === 'string' ? source.defaultWorkDir.trim() : '',
    globalInstructions: normalizeGlobalInstructions(source.globalInstructions),
    modelTags: normalizeModelTags(source.modelTags),
    modelPolicy: normalizeModelPolicy(source.modelPolicy || migratedModelPolicy),
    coordinatorModelPolicy: normalizeModelPolicy(
      source.coordinatorModelPolicy || { ...(source.modelPolicy || migratedModelPolicy), effort: 'high' },
    ),
    actionModelPolicies: normalizeActionModelPolicies(source.actionModelPolicies, source.modelPolicy || migratedModelPolicy),
    actionInstructions: normalizeActionInstructions(source.actionInstructions || migratedInstructions),
    workflows,
  };
}

export function listWorkItemTypeTemplates(settings) {
  const normalized = normalizeWorkCenterSettings(settings);
  return normalized.workflows.map(workflow => ({
    id: workflow.workItemType || workflow.id,
    name: workflow.name,
    actionCount: workflow.stages.length,
  }));
}

export const MAX_INITIAL_PLAN_ACTIONS = 8;
export const MAX_WORK_ITEM_ACTIONS = 64;

export function generatedActionGraphRules(options = {}) {
  const maxActions = Math.min(
    Math.max(Number(options.maxActions) || MAX_INITIAL_PLAN_ACTIONS, 1),
    MAX_WORK_ITEM_ACTIONS,
  );
  const concurrency = Number.isInteger(Number(options.maxConcurrentActions))
    ? Math.min(Math.max(Number(options.maxConcurrentActions), 1), 12)
    : null;
  const concurrencyRule = concurrency
    ? ` The scheduler can run up to ${concurrency} Actions concurrently.`
    : '';
  return `Always submit the smallest reliable graph of 1 to ${maxActions} task-specific Actions; never omit Actions or copy template brief text. Every graph must end in exactly one final acceptance gate: normally one deliver Action, or one terminal review when no delivery operation is required. The final gate must be the unique graph sink and every other Action must be its transitive dependency, so final acceptance cannot run before required evidence.${concurrencyRule} Before submitting, compare each pair of Actions and add a dependency only when one consumes a concrete result or side effect of the other; ordering by narrative, phase name, or list position is not a dependency. Split independent analysis, verification, and repository changes into sibling Actions so the scheduler can use concurrency. Use workspaceMode read only for Actions guaranteed not to mutate files, Git state, services, or external systems; use isolated-write for independent Git changes, integrate for an integrate Action that combines isolated-write dependencies, and shared for serial side effects. An Action with type integrate must use workspaceMode integrate, and type integrate is only valid when combining isolated-write Actions. If any Action uses isolated-write, add exactly one Action with type integrate and workspaceMode integrate; it must depend directly on every isolated-write Action, and all later Actions must consume those writes through the integration Action. Non-Git or dirty workspaces are serialized automatically; do not fake parallelism by marking a mutating Action as read. Every review Action must depend directly or transitively on the editable non-review, non-deliver Action it reviews, so the scheduler cannot claim the Review before that result exists. Set changesRequestedActionId to a non-empty dependency ancestor Action id, or omit the property to use the nearest eligible dependency ancestor; never send null or an empty string. Every generated Action must state objective, approach, expectedOutcome, capability, dependencies, and workspaceMode. The objective, approach, and expectedOutcome must be specific to this WorkItem and that Action: describe the concrete work, the repository-aware execution method, and the verifiable result that will guide the executor. Generic Action-type boilerplate is invalid. Add only Actions required by this task. Do not copy a generic workflow.`;
}

export function resolvePlanningWorkflowSnapshot(settings, requestedWorkItemType = null) {
  const normalized = normalizeWorkCenterSettings(settings);
  const requestedType = typeof requestedWorkItemType === 'string'
    && requestedWorkItemType.trim()
    && requestedWorkItemType.trim().toLowerCase() !== 'auto'
    ? canonicalActionId(requestedWorkItemType, '').slice(0, 64)
    : '';
  const actionTemplates = normalized.workflows.map(workflow => normalizeWorkflowDefinition({
    ...workflow,
    workItemType: workflow.workItemType || workflow.id,
  }));
  const catalog = actionTemplates
    .map(template => `${template.workItemType}: ${template.name} (${template.stages.map(stage => stage.type).join(' -> ')})`)
    .join('\n');
  const typeInstruction = requestedType
    ? `The user explicitly selected workItemType "${requestedType}". Keep that exact type.`
    : 'Infer one specific workItemType from the contract.';
  const triageInstruction = `${normalized.actionInstructions.triage}\n\n${typeInstruction}\nReference workflow catalog:\n${catalog || '(none)'}\nUse the catalog only to understand established task categories and sequencing patterns. ${generatedActionGraphRules({
    maxConcurrentActions: normalized.maxConcurrentActions,
  })}`;
  return normalizeWorkflowDefinition({
    id: 'ai-planned',
    name: 'AI planned',
    planningMode: 'ai',
    workItemType: requestedType || null,
    globalInstructions: normalized.globalInstructions,
    modelPolicy: normalized.modelPolicy,
    actionModelPolicies: normalized.actionModelPolicies,
    actionInstructions: normalized.actionInstructions,
    actionTemplates,
    stages: [{
      id: 'triage',
      name: 'Triage',
      type: 'triage',
      ...defaultActionBrief('triage'),
      instruction: triageInstruction,
      assignmentPolicy: {
        mode: 'auto', capability: 'triage', candidateVpIds: [], fixedVpId: null,
        separateFromStageTypes: [],
      },
      modelPolicy: normalized.actionModelPolicies.triage,
      maxAttempts: 2,
    }],
  });
}

export function resolveWorkflowSnapshot(settings, workflowId, stageOverrides = {}) {
  const normalized = normalizeWorkCenterSettings(settings);
  const id = workflowId || normalized.defaultWorkflowId;
  const workflow = normalized.workflows.find(item => item.id === id);
  if (!workflow) throw new Error(`Unsupported Work Center workflow: ${id}`);
  const overrides = stageOverrides && typeof stageOverrides === 'object' && !Array.isArray(stageOverrides)
    ? stageOverrides
    : {};
  return normalizeWorkflowDefinition({
    ...workflow,
    stages: workflow.stages.map(stage => {
      const override = overrides[stage.id];
      if (!override || typeof override !== 'object' || Array.isArray(override)) return stage;
      return {
        ...stage,
        assignmentPolicy: override.assignmentPolicy
          ? { ...stage.assignmentPolicy, ...override.assignmentPolicy }
          : stage.assignmentPolicy,
        modelPolicy: override.modelPolicy
          ? { ...stage.modelPolicy, ...override.modelPolicy }
          : stage.modelPolicy,
      };
    }),
  });
}

export function validateGeneratedCompletionGate(stages) {
  const deliverStages = stages.filter(stage => stage.type === 'deliver');
  if (deliverStages.length > 1) {
    throw new Error('AI-planned graph requires exactly one final acceptance gate; multiple deliver Actions are not allowed');
  }
  const dependents = new Map(stages.map(stage => [stage.id, []]));
  for (const stage of stages) {
    for (const dependencyId of stage.dependsOnStageIds || []) {
      dependents.get(dependencyId)?.push(stage.id);
    }
  }
  const sinks = stages.filter(stage => (dependents.get(stage.id) || []).length === 0);
  const gate = deliverStages[0]
    || (sinks.length === 1 && sinks[0].type === 'review' ? sinks[0] : null);
  if (!gate) {
    throw new Error('AI-planned graph requires one final deliver Action or one terminal review Action');
  }
  if (sinks.length !== 1 || sinks[0].id !== gate.id) {
    throw new Error(`AI-planned final acceptance gate "${gate.id}" must be the unique graph sink`);
  }
  const byId = new Map(stages.map(stage => [stage.id, stage]));
  const ancestors = new Set();
  const visit = stageId => {
    if (ancestors.has(stageId)) return;
    ancestors.add(stageId);
    for (const dependencyId of byId.get(stageId)?.dependsOnStageIds || []) visit(dependencyId);
  };
  visit(gate.id);
  const uncovered = stages.filter(stage => !ancestors.has(stage.id)).map(stage => stage.id);
  if (uncovered.length > 0) {
    throw new Error(`AI-planned final acceptance gate "${gate.id}" does not cover Actions: ${uncovered.join(', ')}`);
  }
}

export function applyGeneratedPlan(workItem, rawPlan, options = {}) {
  const source = workflowFrom(workItem);
  const forceGraph = options.forceGraph !== false;
  if (source.planningMode !== 'ai') return source;
  if (!rawPlan || typeof rawPlan !== 'object' || Array.isArray(rawPlan)) {
    throw new Error('AI-planned triage requires a structured plan');
  }
  if (typeof rawPlan.workItemType !== 'string' || !rawPlan.workItemType.trim()) {
    throw new Error('AI-planned triage requires a specific workItemType');
  }
  const workItemType = canonicalActionId(rawPlan.workItemType, '').slice(0, 64);
  if (!workItemType) throw new Error('AI-planned triage requires a valid workItemType');
  if (source.workItemType && workItemType !== source.workItemType) {
    throw new Error(`AI-planned triage must keep the selected workItemType "${source.workItemType}"`);
  }
  const reservedStageIds = new Set((options.reservedStageIds || [])
    .map(id => String(id || '').trim()).filter(Boolean));
  const maxActions = Math.min(
    Math.max(Number(options.maxActions) || MAX_INITIAL_PLAN_ACTIONS, 1),
    MAX_WORK_ITEM_ACTIONS,
  );
  if (!Array.isArray(rawPlan.actions) || rawPlan.actions.length < 1
      || rawPlan.actions.length > maxActions) {
    throw new Error(maxActions === MAX_INITIAL_PLAN_ACTIONS
      ? 'AI-planned triage requires between 1 and 8 task-specific Actions'
      : `AI-planned graph requires between 1 and ${maxActions} task-specific Actions`);
  }
  const availableVpIds = Array.isArray(options.availableVpIds)
    ? new Set(options.availableVpIds.map(id => String(id || '').trim()).filter(Boolean))
    : null;
  const seen = new Set(['triage']);
  let previousGeneratedId = null;
  const generated = rawPlan.actions.map((rawAction, index) => {
    const input = rawAction && typeof rawAction === 'object' && !Array.isArray(rawAction) ? rawAction : {};
    const type = generatedActionType(input.type);
    if (type === 'triage') throw new Error('AI-planned Actions cannot add another triage Action');
    if (type === 'create_vp') {
      throw new Error('create_vp Actions can only be created by the dynamic WorkItem Coordinator');
    }
    const id = canonicalActionId(input.id, `${type}-${index + 1}`);
    if (seen.has(id)) throw new Error(`Duplicate AI-planned Action id: ${id}`);
    if (reservedStageIds.has(id)) {
      throw new Error(`AI-planned Action id reuses historical stage identity: ${id}`);
    }
    seen.add(id);
    const objective = typeof input.objective === 'string' ? input.objective.trim().slice(0, 2_000) : '';
    if (!objective) throw new Error(`AI-planned Action "${id}" requires a task-specific objective`);
    const approach = typeof input.approach === 'string' ? input.approach.trim().slice(0, 2_000) : '';
    if (!approach) throw new Error(`AI-planned Action "${id}" requires a task-specific approach`);
    const expectedOutcome = typeof input.expectedOutcome === 'string'
      ? input.expectedOutcome.trim().slice(0, 2_000)
      : '';
    if (!expectedOutcome) {
      throw new Error(`AI-planned Action "${id}" requires a task-specific expectedOutcome`);
    }
    const defaults = defaultActionBrief(type);
    if (objective === defaults.objective || approach === defaults.approach
      || expectedOutcome === defaults.expectedOutcome) {
      throw new Error(`AI-planned Action "${id}" must not reuse generic Action-type brief text`);
    }
    const actionInstruction = Object.hasOwn(source.actionInstructions, type)
      ? source.actionInstructions[type]
      : source.actionInstructions.custom;
    const candidateVpIds = uniqueStrings(input.candidateVpIds);
    if (candidateVpIds.length > 0 && availableVpIds) {
      const unavailable = candidateVpIds.find(vpId => !availableVpIds.has(vpId));
      if (unavailable) throw new Error(`AI-planned Action "${id}" references unavailable VP "${unavailable}"`);
    }
    const assignmentReason = typeof input.assignmentReason === 'string'
      ? input.assignmentReason.trim().slice(0, 1_000)
      : '';
    if (candidateVpIds.length > 0 && !assignmentReason) {
      throw new Error(`AI-planned Action "${id}" requires an assignmentReason`);
    }
    const stage = {
      id,
      name: String(input.name || id).trim().slice(0, 120) || id,
      type,
      objective,
      approach,
      expectedOutcome,
      instruction: actionInstruction,
      assignmentPolicy: candidateVpIds.length > 0 ? {
        mode: 'planned',
        capability: canonicalActionId(input.capability, type),
        candidateVpIds,
        fixedVpId: null,
        assignmentReason,
        separateFromStageTypes: uniqueStrings(input.separateFromActionTypes),
      } : {
        mode: 'auto',
        capability: canonicalActionId(input.capability, type),
        candidateVpIds: [],
        fixedVpId: null,
        assignmentReason: '',
        separateFromStageTypes: uniqueStrings(input.separateFromActionTypes),
      },
      modelPolicy: source.actionModelPolicies[type] || source.actionModelPolicies.custom,
      dependsOnStageIds: Object.hasOwn(input, 'dependsOnActionIds')
        ? canonicalExplicitActionIds(
          input.dependsOnActionIds,
          `Action "${id}" dependencies`,
        )
        : (previousGeneratedId ? [previousGeneratedId] : []),
      workspaceMode: WORKSPACE_MODES.has(input.workspaceMode) ? input.workspaceMode : 'shared',
      maxAttempts: Math.min(Math.max(Number(input.maxAttempts) || 2, 1), 5),
    };
    previousGeneratedId = id;
    if (type === 'review' && Object.hasOwn(input, 'changesRequestedActionId')) {
      stage.changesRequestedStageId = canonicalExplicitActionId(
        input.changesRequestedActionId,
        `Action "${id}" review target`,
      );
    }
    return stage;
  });
  const generatedById = new Map(generated.map(stage => [stage.id, stage]));
  const dependencyAncestors = stage => {
    const ancestors = new Set();
    const visit = stageId => {
      if (ancestors.has(stageId)) return;
      ancestors.add(stageId);
      for (const dependencyId of generatedById.get(stageId)?.dependsOnStageIds || []) visit(dependencyId);
    };
    for (const dependencyId of stage.dependsOnStageIds) visit(dependencyId);
    return ancestors;
  };
  for (const [index, stage] of generated.entries()) {
    if (stage.type !== 'review') continue;
    const ancestors = dependencyAncestors(stage);
    const candidates = generated.slice(0, index)
      .filter(candidate => (
        candidate.type !== 'review'
        && candidate.type !== 'deliver'
        && ancestors.has(candidate.id)
      ));
    if (Object.prototype.hasOwnProperty.call(stage, 'changesRequestedStageId')) {
      const requested = generatedById.get(stage.changesRequestedStageId);
      if (!requested || requested.type === 'review' || requested.type === 'deliver') {
        throw new Error(`AI-planned review Action "${stage.id}" points to an invalid return Action`);
      }
      if (!ancestors.has(requested.id)) {
        throw new Error(`AI-planned review Action "${stage.id}" review target "${requested.id}" must be a dependency ancestor`);
      }
      stage.changesRequestedStageId = requested.id;
    } else {
      stage.changesRequestedStageId = candidates.at(-1)?.id || '';
    }
    if (!stage.changesRequestedStageId) {
      throw new Error(`AI-planned review Action "${stage.id}" requires an editable dependency ancestor`);
    }
    const returnTarget = generatedById.get(stage.changesRequestedStageId);
    stage.assignmentPolicy = {
      ...stage.assignmentPolicy,
      separateFromStageTypes: uniqueStrings([
        ...(stage.assignmentPolicy.separateFromStageTypes || []),
        returnTarget.type,
      ]),
    };
  }
  const hasIsolatedWrites = generated.some(stage => stage.workspaceMode === 'isolated-write');
  const integrationStages = generated.filter(stage => stage.workspaceMode === 'integrate');
  if (hasIsolatedWrites && integrationStages.length !== 1) {
    throw new Error('AI-planned isolated-write Actions require exactly one integration Action');
  }
  for (const [index, stage] of generated.entries()) {
    for (const dependencyId of stage.dependsOnStageIds) {
      if (!generated.slice(0, index).some(candidate => candidate.id === dependencyId)) {
        throw new Error(`AI-planned Action "${stage.id}" has a missing, self, or future dependency "${dependencyId}"`);
      }
    }
    const isolatedDependencies = stage.dependsOnStageIds
      .map(id => generated.find(candidate => candidate.id === id))
      .filter(candidate => candidate?.workspaceMode === 'isolated-write');
    if (stage.workspaceMode === 'integrate' && (stage.type !== 'integrate' || isolatedDependencies.length === 0)) {
      throw new Error(`AI-planned integration Action "${stage.id}" must depend on isolated-write Actions`);
    }
    if (stage.workspaceMode === 'integrate') {
      const required = generated.filter(candidate => candidate.workspaceMode === 'isolated-write').map(candidate => candidate.id);
      if (required.some(id => !stage.dependsOnStageIds.includes(id))) {
        throw new Error(`AI-planned integration Action "${stage.id}" must depend on every isolated-write Action`);
      }
    }
    if (stage.type === 'integrate' && stage.workspaceMode !== 'integrate') {
      throw new Error(`AI-planned integrate Action "${stage.id}" requires integration workspace mode`);
    }
    if (stage.workspaceMode !== 'integrate' && isolatedDependencies.length > 0) {
      throw new Error(`AI-planned Action "${stage.id}" must consume isolated writes through integration`);
    }
  }
  validateGeneratedCompletionGate(generated);
  return normalizeWorkflowDefinition({
    ...source,
    executionMode: forceGraph ? 'graph' : source.executionMode,
    workItemType,
    stages: [source.stages[0], ...generated],
  });
}

const LEGACY_SOFTWARE_CHANGE_VPS = Object.freeze({
  triage: 'omni',
  implement: 'linus',
  review: 'martin',
  deliver: 'linus',
});

function workflowFrom(source = 'software-change') {
  if (source && typeof source === 'object' && source.workflowSnapshot?.stages) {
    return normalizeWorkflowDefinition(source.workflowSnapshot);
  }
  if (source && typeof source === 'object' && source.stages) return normalizeWorkflowDefinition(source);
  const settings = defaultWorkCenterSettings();
  const workflow = resolveWorkflowSnapshot(settings, typeof source === 'string' ? source : 'software-change');
  // Existing WorkItems did not persist a workflow snapshot. Preserve their
  // historical deterministic assignments; only newly created WorkItems use
  // pool selection. This avoids silently changing in-flight durable work.
  return {
    ...workflow,
    stages: workflow.stages.map(stage => ({
      ...stage,
      assignmentPolicy: {
        ...stage.assignmentPolicy,
        mode: 'fixed',
        fixedVpId: LEGACY_SOFTWARE_CHANGE_VPS[stage.type],
      },
    })),
  };
}

export function getWorkflowSteps(source = 'software-change') {
  return workflowFrom(source).stages;
}

export function getStep(source, stageIdOrType) {
  return getWorkflowSteps(source).find(stage => stage.id === stageIdOrType)
    || getWorkflowSteps(source).find(stage => stage.type === stageIdOrType)
    || null;
}

export function getNextStep(source, stageIdOrType, result = {}) {
  const steps = getWorkflowSteps(source);
  const index = steps.findIndex(stage => stage.id === stageIdOrType)
    !== -1
    ? steps.findIndex(stage => stage.id === stageIdOrType)
    : steps.findIndex(stage => stage.type === stageIdOrType);
  if (index === -1) throw new Error(`Work Center stage ${stageIdOrType} is not in the workflow snapshot`);
  const current = steps[index];
  if (current.type === 'review') {
    if (result.reviewDecision === 'changes_requested') {
      return steps.find(stage => stage.id === current.changesRequestedStageId) || null;
    }
    if (result.reviewDecision !== 'approved') {
      throw new Error('Completed review requires approved or changes_requested');
    }
  }
  return steps[index + 1] || null;
}

function renderContext(context = []) {
  if (!Array.isArray(context) || context.length === 0) return '';
  const blocks = context.map(entry => {
    const evidence = Array.isArray(entry.evidence) && entry.evidence.length > 0
      ? `\nEvidence:\n${entry.evidence.map(item => {
          const status = item.status ? ` [${item.status}]` : '';
          const ref = item.ref ? ` (${item.ref})` : '';
          return `- ${item.kind}: ${item.label}${status}${ref}`;
        }).join('\n')}`
      : '';
    const decision = entry.reviewDecision ? `\nReview decision: ${entry.reviewDecision}` : '';
    const waitingReason = entry.waitingReason ? `\nWaiting reason: ${entry.waitingReason}` : '';
    const answer = entry.answer ? `\nUser answer: ${entry.answer}` : '';
    const quote = entry.quote
      ? sessionMessageQuotePrompt(entry.quote, { maxBytes: ACTION_CONTEXT_QUOTE_MAX_BYTES })
      : '';
    const source = entry.sourceTitle ? ` from ${entry.sourceTitle}` : '';
    return `### ${entry.type}${source} (${entry.vpId || entry.role || 'unknown VP'})\n${entry.summary || '(no summary)'}${decision}${waitingReason}${answer}${quote}${evidence}`;
  });
  return `\n\nReusable Work Center context and prior Action results:\n${blocks.join('\n\n')}`;
}

export function actionInstruction(stage, workItem, context = [], sessionContextBlock = renderSessionContextSnapshot(workItem?.sessionContext)) {
  const criteria = (workItem.acceptanceCriteria || []).map(item => `- ${item}`).join('\n') || '- No explicit criteria';
  const common = `WorkItem: ${workItem.title}\nGoal: ${workItem.goal}\nAcceptance criteria:\n${criteria}${sessionContextBlock}${renderContext(context)}`;
  const policy = stage.instruction || defaultWorkCenterStageInstruction(stage.type);
  const brief = normalizeActionBrief(stage.brief || stage, stage.type);
  const contract = `Action type: ${stage.type}\nWhat to do:\n${brief.objective}\n\nHow to do it:\n${brief.approach}\n\nExpected result:\n${brief.expectedOutcome}`;
  const dynamicRules = isDynamicWorkItem(workItem)
    ? `\n\nGoal-driven execution: complete this useful unit end to end, including local tools and risk-appropriate tests. Do not invent research/design/test/review/delivery stages or create roles to work around missing skills. Keep the user contract unchanged; report real tool or authorization blockers. Delivery target: ${workItem.deliveryTarget || 'unconfirmed'}. For response delivery put the substantive result/report in summary with evidence and acceptance checks; no artificial file, PR, or packaging Action is needed.${stage.brief?.goalRefs ? `\nCurrent goal references: ${JSON.stringify(stage.brief.goalRefs)}` : ''}${stage.brief?.rationale ? `\nWhy this Action: ${stage.brief.rationale}` : ''}`
    : '';
  return `${common}\n\n${policy}\n\n${contract}${dynamicRules}`;
}

export function withoutActionInputContext(context, preserveInputIds = []) {
  const preserved = new Set((Array.isArray(preserveInputIds) ? preserveInputIds : []).filter(Boolean));
  return (Array.isArray(context) ? context : []).filter(entry => (
    entry?.type !== 'input' || (entry.inputId && preserved.has(entry.inputId))
  ));
}

export function canonicalActionInstruction(workItem, action, context = action?.context || []) {
  const workflowSnapshot = workItem?.workflowSnapshot || null;
  const workflowStage = (Array.isArray(workflowSnapshot?.stages) ? workflowSnapshot.stages : [])
    .find(stage => stage?.id === action?.stageId)
    || (Array.isArray(workflowSnapshot?.stages) ? workflowSnapshot.stages : [])
      .find(stage => stage?.type === action?.type)
    || null;
  const actionInstructions = workflowSnapshot?.actionInstructions;
  const policyInstruction = actionInstructions && Object.hasOwn(actionInstructions, action?.type)
    ? actionInstructions[action.type]
    : actionInstructions?.custom;
  const stage = {
    ...(workflowStage || {}),
    id: action?.stageId || workflowStage?.id || action?.type,
    type: action?.type || workflowStage?.type || 'custom',
    instruction: workflowStage?.instruction || policyInstruction || '',
    brief: action?.brief || workflowStage?.brief || workflowStage || null,
    assignmentPolicy: action?.assignmentPolicy,
    modelPolicy: action?.modelPolicy,
    dependsOnStageIds: action?.dependsOnStageIds,
    workspaceMode: action?.workspaceMode,
    changesRequestedStageId: action?.changesRequestedStageId,
    maxAttempts: action?.maxAttempts,
  };
  return actionInstruction(stage, workItem, context);
}

export function actionForStage(stage, workItem, context = []) {
  return {
    type: stage.type,
    stageId: stage.id,
    assignmentPolicy: stage.assignmentPolicy,
    modelPolicy: stage.modelPolicy,
    dependsOnStageIds: stage.dependsOnStageIds || [],
    workspaceMode: stage.workspaceMode || 'shared',
    changesRequestedStageId: stage.changesRequestedStageId || null,
    // Storage compatibility for databases created before assignment policies.
    requiredRole: stage.assignmentPolicy.mode === 'fixed' ? stage.assignmentPolicy.fixedVpId : '',
    brief: normalizeActionBrief(stage, stage.type),
    context,
    instruction: actionInstruction(stage, workItem, context),
    maxAttempts: stage.maxAttempts,
  };
}

export function initialActionFor(workItem) {
  const stage = getWorkflowSteps(workItem)[0];
  return actionForStage(stage, workItem, []);
}

export function actionContextFromRuns(runs = []) {
  return runs
    .filter(run => run && run.summary)
    .map(run => ({
      type: run.actionType || 'action',
      vpId: run.vpSnapshot?.id || null,
      role: run.roleSnapshot?.id || null,
      summary: run.summary,
      evidence: Array.isArray(run.evidence) ? run.evidence : [],
      reviewDecision: run.reviewDecision || null,
    }));
}
