import { bytes, fail, object, text } from './contracts.js';

/** Public goal bookkeeping, not reasoning, authorization or proof of acceptance.
 * Stable commitments belong to an episode, not an individual model turn. */
export const EXECUTION_GOAL_TOOL = {
  name: 'Execution__goal',
  description: 'Report a public goal at meaningful milestones and ALWAYS before ending execution, not between every tool. kind: work for implementation/research, answer for a direct conversational answer, exploration for uncommitted discovery. Keep objective/acceptance/kind stable while unresolved; change routes via nextStep. completed work/exploration requires acceptanceChecks linked to actual tool observations; refs/ok alone never prove semantic success. blocked requires a concrete external missing resource/permission/information or risk and what was tried; another execution opportunity is NOT a blocker. waiting requires exact owned pending task/agent IDs. abandoned requires evidence why the route should stop. resting is only uncommitted exploration, never an escape from accepted work. Availability and goal selection never grant side-effect authority. sourceRefs must be exact supplied refs.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      objective: { type: 'string', minLength: 1, maxLength: 1000 },
      acceptance: { type: 'string', minLength: 1, maxLength: 1000 },
      kind: { type: 'string', enum: ['work', 'answer', 'exploration'] },
      status: { type: 'string', enum: ['active', 'completed', 'blocked', 'waiting', 'abandoned', 'resting'] },
      reason: { type: 'string', maxLength: 1000 },
      nextStep: { type: 'string', maxLength: 1000 },
      sourceRefs: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 512 } },
      acceptanceChecks: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false,
        properties: { check: { type: 'string', minLength: 1, maxLength: 600 }, sourceRefs: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 512 } } }, required: ['check', 'sourceRefs'] } },
      waitFor: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 128 } },
      blocker: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['permission', 'information', 'resource', 'risk'] },
          missing: { type: 'string', minLength: 1, maxLength: 1000 }, tried: { type: 'string', minLength: 1, maxLength: 1000 },
          resumeWhen: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['kind', 'missing', 'tried', 'resumeWhen'] }] },
    },
    required: ['objective', 'acceptance', 'kind', 'status', 'reason', 'nextStep', 'sourceRefs', 'acceptanceChecks', 'waitFor', 'blocker'],
  },
};

export function validateExecutionGoal(value) {
  const keys = Object.keys(EXECUTION_GOAL_TOOL.parameters.properties);
  object(value, keys, keys);
  text(value.objective, 1000); text(value.acceptance, 1000);
  text(value.reason, 1000, true); text(value.nextStep, 1000, true);
  if (!['work', 'answer', 'exploration'].includes(value.kind) || !EXECUTION_GOAL_TOOL.parameters.properties.status.enum.includes(value.status)) fail('INVALID_REQUEST');
  for (const [key, count, length] of [['sourceRefs', 12, 512], ['waitFor', 8, 128]]) {
    if (!Array.isArray(value[key]) || value[key].length > count || new Set(value[key]).size !== value[key].length) fail('INVALID_REQUEST');
    value[key].forEach(item => text(item, length));
  }
  if (!Array.isArray(value.acceptanceChecks) || value.acceptanceChecks.length > 8) fail('INVALID_REQUEST');
  for (const check of value.acceptanceChecks) {
    object(check, ['check', 'sourceRefs']); text(check.check, 600);
    if (!Array.isArray(check.sourceRefs) || !check.sourceRefs.length || check.sourceRefs.length > 4) fail('INVALID_REQUEST');
    check.sourceRefs.forEach(ref => text(ref, 512));
  }
  if (bytes(value) > 8192) fail('INVALID_REQUEST');
  if (value.status === 'active' && !value.nextStep.trim()) fail('INVALID_REQUEST');
  if (['completed', 'blocked', 'abandoned', 'resting'].includes(value.status) && !value.reason.trim()) fail('INVALID_REQUEST');
  if (value.status === 'completed' && value.kind !== 'answer' && !value.acceptanceChecks.length) fail('INVALID_REQUEST');
  if (value.status === 'abandoned' && !value.sourceRefs.length) fail('INVALID_REQUEST');
  if (value.status === 'resting' && value.kind !== 'exploration') fail('INVALID_REQUEST');
  if (value.status === 'waiting' && !value.waitFor.length) fail('INVALID_REQUEST');
  if (value.status !== 'waiting' && value.waitFor.length) fail('INVALID_REQUEST');
  if (value.status === 'blocked') {
    object(value.blocker, ['kind', 'missing', 'tried', 'resumeWhen']);
    if (!['permission', 'information', 'resource', 'risk'].includes(value.blocker.kind)) fail('INVALID_REQUEST');
    for (const key of ['missing', 'tried', 'resumeWhen']) text(value.blocker[key], 1000);
  } else if (value.blocker !== null) fail('INVALID_REQUEST');
  return value;
}

const closed = new Set(['completed', 'blocked', 'abandoned', 'resting']);
export const pendingGoalTask = record => Boolean(record && (record.executionPending === true || !['completed', 'succeeded', 'failed', 'cancelled', 'closed', 'abandoned', 'orphaned', 'idle'].includes(record.status)));

export class ExecutionGoal {
  constructor() { this.current = null; this.revision = 0; this.emptyEndings = 0; this.observations = new Map(); }
  update(value, { sourceRefs, taskState = { tasks: [], agents: [] } } = {}) {
    validateExecutionGoal(value);
    const refs = [...value.sourceRefs, ...value.acceptanceChecks.flatMap(check => check.sourceRefs)];
    if (refs.some(ref => !sourceRefs.has(ref))) return this.rejected('Use only exact sourceRefs already supplied in this episode.');
    const previous = this.current;
    if (previous && !closed.has(previous.status)) {
      if (['objective', 'acceptance', 'kind'].some(key => value[key] !== previous[key])) return this.rejected('The unresolved commitment is stable. Keep objective, acceptance and kind; change routes using nextStep. Explicitly close the old goal before selecting a new one.');
      if (value.status === 'resting') return this.rejected('An accepted commitment cannot become resting. Complete it, report a real blocker or evidence-based abandonment.');
    }
    if (value.status === 'completed' && value.kind !== 'answer') {
      if (value.acceptanceChecks.some(check => check.sourceRefs.some(ref => !this.observations.has(ref)))) return this.rejected('Acceptance checks need actual tool observations from this execution, not trigger/history/concept refs. Explain how those observations satisfy acceptance; existence alone is not proof.');
    }
    if (value.status === 'abandoned' && !value.sourceRefs.some(ref => this.observations.has(ref))) return this.rejected('Abandonment needs an actual observation supporting the decision, not only an earlier intention.');
    const tasks = [...taskState.tasks, ...taskState.agents];
    if (value.status === 'waiting' && value.waitFor.some(id => !tasks.some(task => task.id === id && pendingGoalTask(task)))) return this.rejected('waitFor must identify existing owned pending tasks/agents. Already ready, invented or foreign IDs are not wait conditions. Collect actual results and continue.');
    if (closed.has(value.status) && tasks.some(task => task.currentEpisode && pendingGoalTask(task))) return this.rejected('This episode still owns pending effects. Wait for and collect them, or explicitly stop/join them before terminal closure.');
    return this.transition(value);
  }
  transition(value) {
    this.current = structuredClone(value); this.revision++;
    return { id: 'Execution.goal', ok: true, goal: this.view(), authority: 'fallible-model-goal-report-not-acceptance-proof', notice: 'Host verifies identity, origin and lifecycle, not semantic truth. Continue active tools; do not report between every tool. Goal reports grant no authority.' };
  }
  rejected(output) { return { id: 'Execution.goal', ok: false, code: 'INVALID_TOOL_INPUT', errorEffect: 'none', replaySafe: true, output }; }
  view() { return this.current ? { ...structuredClone(this.current), revision: this.revision } : null; }
  resume() { return this.transition({ ...this.current, status: 'active', waitFor: [], nextStep: 'Collect the actual awaited results, then continue the goal. Missing records are not proof of success.' }); }
  /** Detect repeated empty refusal only. This is not a tool quota, useful-progress
   * detector or a fake external blocker. Runtime persists failure, not completion. */
  endBoundary(taskState = { tasks: [], agents: [] }) {
    const pending = [...taskState.tasks, ...taskState.agents].filter(task => task.currentEpisode && pendingGoalTask(task));
    if (this.current && closed.has(this.current.status) && !pending.length) return null;
    this.emptyEndings++;
    if (this.emptyEndings > 1) return { continueExecution: false, goal: this.view(), code: 'GOAL_NO_PROGRESS' };
    return { continueExecution: true, goal: this.view(), pendingEffects: pending.map(task => task.id), instruction: 'Execution cannot close without a valid goal disposition. Use Execution__goal at this boundary (not cognitive JSON). Keep unfinished commitments active and take the next feasible authorized action. For a direct answer, report kind:answer completed; for uncommitted exploration without worthwhile action, report kind:exploration resting. Work completion needs actual acceptance observations; blocked needs a specific external impediment, not another execution opportunity. Collect/join pending effects. Do not ask the user merely to continue.' };
  }
  progress(id, result) {
    if (id === 'Execution.goal' || id.startsWith('catalog.')) return;
    // A failing test is also real execution evidence. Rejected arguments are not.
    if (result?.errorEffect !== 'none') this.emptyEndings = 0;
    if (result?.sourceRef && result?.errorEffect !== 'none') this.observations.set(result.sourceRef, { capability: id, ok: result.ok !== false });
  }
}
