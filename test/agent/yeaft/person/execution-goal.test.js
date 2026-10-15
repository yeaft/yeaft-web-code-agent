import { describe, expect, it } from 'vitest';
import { ExecutionGoal, EXECUTION_GOAL_TOOL, validateExecutionGoal } from '../../../../agent/yeaft/person/execution-goal.js';
import { validateToolArguments } from '../../../../agent/yeaft/person/tool-arguments.js';
import { ExecutionTranscript } from '../../../../agent/yeaft/person/execution-protocol.js';

const active = (extra = {}) => ({ objective: 'Deliver an authorized improvement', acceptance: 'Actual artifact and verification', status: 'active', reason: '', nextStep: 'Read the fixture', sourceRefs: ['trigger:e'], waitFor: [], blocker: null, ...extra });
const context = { sourceRefs: new Set(['trigger:e', 'tool:one']), taskSnapshot: { tasks: [{ id: 'task-one', status: 'running' }], agents: [] } };
describe('Goal lifecycle independent of model end_turn', () => {
  it('keeps active work running at end_turn without another cognitive call or user interaction', () => {
    const goal = new ExecutionGoal();
    expect(goal.update(active(), context).ok).toBe(true);
    expect(goal.endBoundary()).toMatchObject({ continueExecution: true, goal: { status: 'active' } });
    goal.progress('FileRead', { ok: true });
    expect(goal.endBoundary().continueExecution).toBe(true);
  });
  it('does not manufacture endless retries or a fake external blocker when the model will not act', () => {
    const goal = new ExecutionGoal(); goal.update(active(), context);
    goal.endBoundary(); goal.update(active({ nextStep: 'Still read' }), context); goal.progress('Execution.goal', { ok: true });
    goal.progress('catalog.view', { ok: true }); goal.progress('FileRead', { ok: false });
    expect(goal.endBoundary()).toMatchObject({ continueExecution: false, code: 'GOAL_NO_PROGRESS', goal: { status: 'stalled' } });
  });
  it('accepts only exact read refs and owned live wait targets, without accepting success claims as proof', () => {
    const goal = new ExecutionGoal();
    expect(goal.update(active({ sourceRefs: ['invented'] }), context)).toMatchObject({ ok: false, errorEffect: 'none' });
    expect(goal.view()).toBeNull();
    expect(goal.update(active({ status: 'waiting', waitFor: ['foreign'] }), context).ok).toBe(false);
    expect(goal.update(active({ status: 'waiting', waitFor: ['task-one'] }), context).ok).toBe(true);
    expect(goal.update(active({ status: 'waiting', waitFor: ['task-one'] }), { ...context, taskSnapshot: { tasks: [{ id: 'task-one', status: 'completed' }] } }).ok).toBe(false);
    expect(goal.update(active({ status: 'completed', reason: 'Read and verified', sourceRefs: ['tool:one'] }), context)).toMatchObject({ ok: true, authority: 'fallible-model-goal-report-not-acceptance-proof' });
    expect(goal.endBoundary()).toBeNull();
  });
  it('requires a concrete blocker or evidence-backed completion/abandonment, not an execution opportunity', () => {
    expect(() => validateExecutionGoal(active({ status: 'blocked', reason: 'Need next turn' }))).toThrow();
    const blocked = active({ status: 'blocked', reason: 'Source requires credentials', blocker: { kind: 'permission', missing: 'Provider API credential', tried: 'Inspected the public endpoint; authentication required', resumeWhen: 'User supplies access or chooses another source' } });
    expect(validateExecutionGoal(blocked)).toBe(blocked);
    expect(() => validateExecutionGoal(active({ status: 'completed', reason: 'done', sourceRefs: [] }))).toThrow();
    expect(() => validateExecutionGoal(active({ status: 'abandoned', reason: 'unpromising', sourceRefs: [] }))).toThrow();
    expect(() => validateToolArguments(blocked, EXECUTION_GOAL_TOOL.parameters)).not.toThrow();
  });
  it('keeps exactly one current goal in bounded request copies and does not mutate durable original messages', () => {
    const transcript = new ExecutionTranscript([{ role: 'user', content: 'original' }]);
    transcript.setGoal({ ...active(), revision: 1 });
    transcript.setGoal({ ...active({ nextStep: 'Validate the modified file' }), revision: 2 });
    const request = transcript.request({ system: 's', tools: [], maxBytes: 4000 });
    expect(request.messages).toHaveLength(2);
    expect(JSON.parse(request.messages[1].content).executionGoal).toMatchObject({ nextStep: 'Validate the modified file', revision: 2 });
    expect(transcript.initial).toEqual([{ role: 'user', content: 'original' }]);
  });
});
