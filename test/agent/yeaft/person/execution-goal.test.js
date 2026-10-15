import { describe, expect, it } from 'vitest';
import { ExecutionGoal, EXECUTION_GOAL_TOOL, pendingGoalTask, validateExecutionGoal } from '../../../../agent/yeaft/person/execution-goal.js';
import { validateToolArguments } from '../../../../agent/yeaft/person/tool-arguments.js';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';

const active = (extra = {}) => ({ objective: 'Deliver an authorized improvement', acceptance: 'Actual artifact and verification', kind: 'work', status: 'active', reason: '', nextStep: 'Read the fixture', sourceRefs: ['trigger:e'], acceptanceChecks: [], waitFor: [], blocker: null, ...extra });
const context = { sourceRefs: new Set(['trigger:e', 'tool:one']), taskState: { tasks: [{ id: 'task-one', status: 'running', currentEpisode: true }], agents: [] } };
const noTasks = { ...context, taskState: { tasks: [], agents: [] } };
describe('Goal lifecycle independent of model end_turn', () => {
  it('requires disposition even when the model never adopted a goal, without quotas or cognitive calls', () => {
    const goal = new ExecutionGoal();
    expect(goal.endBoundary()).toMatchObject({ continueExecution: true, goal: null });
    expect(goal.endBoundary()).toMatchObject({ continueExecution: false, code: 'GOAL_NO_PROGRESS' });
  });
  it('keeps active work running at end_turn, treating a failing test as activity, not completion', () => {
    const goal = new ExecutionGoal(); goal.update(active(), context);
    expect(goal.endBoundary()).toMatchObject({ continueExecution: true, goal: { status: 'active' } });
    goal.progress('Bash', { ok: false, sourceRef: 'tool:one' });
    expect(goal.endBoundary().continueExecution).toBe(true);
    goal.update(active({ nextStep: 'Still read' }), context);
    goal.progress('catalog.view', { ok: true }); goal.progress('FileRead', { ok: false, errorEffect: 'none' });
    expect(goal.endBoundary()).toMatchObject({ continueExecution: false, code: 'GOAL_NO_PROGRESS', goal: { status: 'active' } });
  });
  it('protects the accepted commitment from resting or silent scope/acceptance reduction', () => {
    const goal = new ExecutionGoal(); goal.update(active(), context);
    for (const patch of [{ objective: 'Just read' }, { acceptance: 'No verification' }, { kind: 'answer' }, { status: 'resting', kind: 'exploration', reason: 'Enough' }]) {
      expect(goal.update(active(patch), noTasks).ok).toBe(false);
    }
    expect(goal.view()).toMatchObject({ revision: 1, status: 'active' });
  });
  it('requires actual observation checks for work completion, while an answer needs no gratuitous tool', () => {
    const goal = new ExecutionGoal(); goal.update(active(), noTasks);
    expect(goal.update(active({ status: 'completed', reason: 'Done', acceptanceChecks: [{ check: 'Verified', sourceRefs: ['trigger:e'] }] }), noTasks).ok).toBe(false);
    goal.progress('Bash', { ok: true, sourceRef: 'tool:one' });
    expect(goal.update(active({ status: 'completed', reason: 'Verified the artifact', acceptanceChecks: [{ check: 'Test passed', sourceRefs: ['tool:one'] }] }), noTasks)).toMatchObject({ ok: true, authority: 'fallible-model-goal-report-not-acceptance-proof' });
    expect(goal.endBoundary()).toBeNull();
    expect(new ExecutionGoal().update(active({ kind: 'answer', status: 'completed', reason: 'Answered the question' }), noTasks).ok).toBe(true);
  });
  it('requires verification after actual execution even for an answer and invalidates stale closure after later effects', () => {
    const goal = new ExecutionGoal();
    goal.progress('FileWrite', { ok: true, sourceRef: 'tool:one' });
    const answer = active({ kind: 'answer', status: 'completed', reason: 'Answered' });
    expect(goal.update(answer, noTasks).ok).toBe(false);
    answer.acceptanceChecks = [{ check: 'Observed the actual result', sourceRefs: ['tool:one'] }];
    expect(goal.update(answer, noTasks).ok).toBe(true);
    expect(goal.endBoundary()).toBeNull();
    expect(goal.progress('Bash', { ok: false, sourceRef: 'tool:one' })).toBe(true);
    expect(goal.view()).toMatchObject({ status: 'active', executionRevision: 2, reportedExecutionRevision: 1 });
    expect(goal.endBoundary().continueExecution).toBe(true);
    expect(goal.update({ ...answer, kind: 'exploration' }, noTasks).ok).toBe(false);
    expect(goal.update(answer, noTasks).ok).toBe(true);
    expect(goal.endBoundary()).toBeNull();
  });
  it('checks exact refs, owned pending IDs, ready idle agents, pending effects and host revision transitions', () => {
    const goal = new ExecutionGoal();
    expect(goal.update(active({ sourceRefs: ['invented'] }), context).ok).toBe(false);
    expect(goal.update(active({ status: 'waiting', waitFor: ['foreign'] }), context).ok).toBe(false);
    expect(goal.update(active({ status: 'waiting', waitFor: ['task-one'] }), context).ok).toBe(true);
    expect(goal.resume().goal).toMatchObject({ status: 'active', revision: 2, waitFor: [] });
    const idle = { id: 'agent', status: 'idle' };
    expect(pendingGoalTask(idle)).toBe(false);
    expect(pendingGoalTask({ ...idle, executionPending: true })).toBe(true);
    expect(new ExecutionGoal().update(active({ status: 'waiting', waitFor: ['agent'] }), { ...context, taskState: { tasks: [], agents: [idle] } }).ok).toBe(false);
    expect(new ExecutionGoal().update(active({ kind: 'answer', status: 'completed', reason: 'done' }), context).ok).toBe(false);
    expect(new ExecutionGoal().update(active({ kind: 'answer', status: 'completed', reason: 'done' }), { ...context, taskState: { tasks: [{ ...context.taskState.tasks[0], currentEpisode: false }], agents: [] } }).ok).toBe(true);
  });
  it('requires a structured real blocker, not an execution opportunity, and permits quiet uncommitted rest', () => {
    expect(() => validateExecutionGoal(active({ status: 'blocked', reason: 'Need next turn' }))).toThrow();
    const blocked = active({ status: 'blocked', reason: 'Source requires credentials', blocker: { kind: 'permission', missing: 'Provider API credential', tried: 'Inspected the public endpoint; authentication required', resumeWhen: 'User supplies access or chooses another source' } });
    expect(validateExecutionGoal(blocked)).toBe(blocked);
    expect(() => validateToolArguments(blocked, EXECUTION_GOAL_TOOL.parameters)).not.toThrow();
    expect(new ExecutionGoal().update(active({ kind: 'exploration', status: 'resting', reason: 'No useful new direction' }), noTasks).ok).toBe(true);
  });
  it('keeps one current bounded goal without mutating original messages', () => {
    const transcript = new ExecutionTranscript([{ role: 'user', content: 'original' }]);
    transcript.setGoal({ ...active(), revision: 1 });
    transcript.setGoal({ ...active({ nextStep: 'Validate modified file' }), revision: 2 });
    const request = transcript.request({ system: 's', tools: [], maxBytes: 4000 });
    expect(JSON.parse(request.messages[1].content).executionGoal.revision).toBe(2);
    expect(transcript.initial).toEqual([{ role: 'user', content: 'original' }]);
  });
});
