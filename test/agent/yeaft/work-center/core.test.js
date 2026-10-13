import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';
import { buildMainlineContextSnapshot } from '../../../../agent/yeaft/work-center/mainline-projection.js';

function createInput(overrides = {}) {
  return {
    title: 'Fix final TODO state',
    goal: 'Ensure the final TODO state reflects the real turn outcome',
    acceptanceCriteria: ['Completed work is completed', 'Waiting work is waiting'],
    workflowTemplate: 'software-change',
    workDir: '/tmp',
    start: true,
    ...overrides,
  };
}

function withWorkCenterFixture(run) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-case-'));
  const fixtureStore = new WorkItemStore(join(fixtureDir, 'work-center.db'), { now: () => 1_000 });
  const fixtureController = new WorkflowController(fixtureStore);
  try {
    return run({ store: fixtureStore, controller: fixtureController });
  } finally {
    fixtureStore.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function completed(type) {
  return {
    outcome: 'completed',
    summary: `${type} complete`,
    evidence: [`${type}-evidence`],
    acceptanceChecks: createInput().acceptanceCriteria.map(criterion => ({
      criterion,
      status: 'passed',
      evidence: `${type}-evidence`,
    })),
  };
}

describe('Work Center core', () => {
  let dir;
  let now;
  let store;
  let controller;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-'));
    now = 1_000;
    store = new WorkItemStore(join(dir, 'work-center.db'), { now: () => now });
    controller = new WorkflowController(store);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries Actions after an interrupted Bash without bypassing other unknown side effects', () => {
    const bashItem = controller.create(createInput({ id: 'bash-retry', workDir: dir }));
    const bashClaim = store.claimReadyAction('bash-owner', 5_000);
    expect(bashClaim?.workItem.id).toBe(bashItem.id);
    expect(store.createAndClaimOperation({
      workItemId: bashItem.id,
      actionId: bashClaim.action.id,
      runId: bashClaim.run.id,
      operationType: 'Bash',
      idempotencyKey: 'interrupted-bash',
      replayPolicy: 'never_automatic',
    }, 'bash-owner', bashClaim.run.leaseEpoch, false)).not.toBeNull();
    expect(store.interruptRun(
      bashClaim.run.id, 'bash-owner', bashClaim.run.leaseEpoch, 'simulated interruption',
    )).toBe(true);
    expect(store.getOperationByKey('interrupted-bash')).toMatchObject({
      effectStatus: 'pending', executionStatus: 'running',
    });
    store.recoverOperations();
    expect(store.getOperationByKey('interrupted-bash')).toMatchObject({
      effectStatus: 'unknown', executionStatus: 'hazardous_orphan',
    });
    expect(store.claimReadyAction('bash-retry-owner', 5_000)).toMatchObject({
      workItem: { id: bashItem.id },
    });

    const externalItem = controller.create(createInput({
      id: 'external-effect-fence', workDir: join(dir, 'external-effect-fence'),
    }));
    const externalClaim = store.claimReadyAction('external-owner', 5_000);
    expect(externalClaim?.workItem.id).toBe(externalItem.id);
    expect(store.createAndClaimOperation({
      workItemId: externalItem.id,
      actionId: externalClaim.action.id,
      runId: externalClaim.run.id,
      operationType: 'external-publish',
      idempotencyKey: 'unknown-external-effect',
      replayPolicy: 'never_automatic',
    }, 'external-owner', externalClaim.run.leaseEpoch, false)).not.toBeNull();
    expect(store.interruptRun(
      externalClaim.run.id, 'external-owner', externalClaim.run.leaseEpoch, 'simulated interruption',
    )).toBe(true);
    expect(store.claimReadyAction('must-remain-fenced', 5_000)).toBeNull();
  });

  it.each([
    ['dirty repository', true],
    ['non-Git directory', false],
  ])('keeps %s isolation fallback serialized across WorkItems', async (_label, initializeGit) => {
    const workspace = mkdtempSync(join(tmpdir(), 'yeaft-workspace-fallback-'));
    try {
      if (initializeGit) {
        const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
        git(['init']);
        git(['config', 'user.name', 'Test']);
        git(['config', 'user.email', 'test@example.com']);
        writeFileSync(join(workspace, 'base.txt'), 'base\n');
        git(['add', '.']);
        git(['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'dirty.txt'), 'dirty\n');
      }
      const action = id => ({
        id: `${id}-action`, type: 'implement', stageId: 'write', workspaceMode: 'isolated-write',
      });
      store.createWorkItem(createInput({ id: 'first-fallback', workDir: workspace }), action('first'));
      store.createWorkItem(createInput({ id: 'second-fallback', workDir: workspace }), action('second'));
      const first = store.claimReadyAction('boot-a', 5_000);
      const runner = new WorkItemRunner({ store, actionWorktreeRoot: join(dir, 'worktrees') });
      const prepared = await runner.prepare({ ...first, ownerBootId: 'boot-a' });
      expect(prepared.action).toMatchObject({ workspaceMode: 'shared', workspace: null });
      expect(store.getAction(first.action.id).workspaceMode).toBe('shared');
      expect(store.claimReadyAction('boot-a', 5_000)).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('serializes canonical workspace writers across WorkItems while allowing unrelated work', () => {
    const alias = join(dir, 'workspace-alias');
    symlinkSync(dir, alias);
    const createWriter = (id, workDir) => store.createWorkItem(createInput({ id, workDir }), {
      id: `${id}-action`, type: 'implement', workspaceMode: 'shared',
    });
    const first = createWriter('writer-first', dir);
    const blocked = createWriter('writer-alias', alias);
    const independent = createWriter('writer-other', join(dir, 'unrelated'));
    expect(first.workspaceKey).toBe(blocked.workspaceKey);
    const claim = store.claimReadyAction('owner-first', 5_000);
    expect(claim.workItem.id).toBe(first.id);
    expect(store.claimReadyAction('owner-other', 5_000).workItem.id).toBe(independent.id);
    expect(store.claimReadyAction('owner-blocked', 5_000)).toBeNull();
    controller.cancel(first.id);
    expect(store.claimReadyAction('owner-released', 5_000).workItem.id).toBe(blocked.id);
  });

  it('makes terminal Run evidence and active Run identity immutable at the database boundary', () => {
    controller.create(createInput());
    const first = store.claimReadyAction('owner', 5_000);
    store.deferRun(first.run.id, 'owner', first.run.leaseEpoch, 'workspace busy');
    const second = store.claimReadyAction('owner', 5_000);
    expect(second.run).toMatchObject({ actionGeneration: first.action.generation,
      actionSpecHash: first.action.specHash, actionAttempt: 2 });
    expect(() => store.db.prepare('UPDATE runs SET response = ? WHERE id = ?')
      .run('late rewrite', first.run.id)).toThrow(/terminal Run result is immutable/);
    expect(() => store.db.prepare('UPDATE runs SET acceptance_checks = ? WHERE id = ?')
      .run('[{"criterion":"rewritten"}]', first.run.id)).toThrow(/terminal Run result is immutable/);
    expect(() => store.db.prepare('UPDATE runs SET outputs = ? WHERE id = ?')
      .run('[{"kind":"file","label":"late","ref":"late.md"}]', first.run.id))
      .toThrow(/terminal Run result is immutable/);
    expect(() => store.db.prepare('UPDATE runs SET action_id = ? WHERE id = ?')
      .run('different-action', second.run.id)).toThrow(/Run identity is immutable/);
  });

  it('claims a ready Action exactly once and fences stale terminal submissions', () => {
    controller.create(createInput());
    const first = store.claimReadyAction('boot-a', 5_000);
    expect(store.claimReadyAction('boot-b', 5_000)).toBeNull();
    expect(() => controller.submit(first.run.id, 'boot-b', first.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
  });

  it.each([
    completed('triage'),
    { outcome: 'waiting', summary: 'Need input', evidence: [], waitingReason: 'Provide input' },
    { outcome: 'failed', summary: 'Failed', evidence: [], error: 'broken' },
  ])('increments the v2 ledger for $outcome Runs and fences canonical results', result => {
    withWorkCenterFixture(({ store, controller }) => {
      const item = controller.create(createInput());
      const claim = store.claimReadyAction('boot-a', 5_000);
      expect(claim.action.workItemId).toBe(item.id);
      const generation = claim.action.generation;

      controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, result);

      const detail = store.getWorkItemDetail(item.id);
      expect(detail.ledgerRevision).toBe(1);
      expect(store.getAction(claim.action.id)).toMatchObject({
        generation,
        resultRunId: result.outcome === 'completed' ? claim.run.id : null,
      });
      expect(store.finalizeRun(claim.run.id, 'boot-a', claim.run.leaseEpoch, result, () => {
        throw new Error('stale terminal callback must not run');
      })).toBeNull();
      expect(store.getWorkItem(item.id).ledgerRevision).toBe(1);
    });
  });

  it('rejects late EngineTurn responses after cancellation or lease expiry', () => {
    const prepareDispatchedTurn = (suffix, leaseMs = 5_000) => {
      const item = controller.create(createInput({ title: `Fence late response ${suffix}` }));
      const claim = store.claimReadyAction(`boot-${suffix}`, leaseMs);
      controller.input(item.id, {
        text: `Input ${suffix}`,
        actionId: claim.action.id,
        revision: store.getWorkItem(item.id).revision,
        generation: claim.action.generation,
      });
      const inputs = store.listPendingActionInputs(
        claim.action.id, claim.run.id, `boot-${suffix}`, claim.run.leaseEpoch,
      );
      const turn = store.prepareEngineTurn(
        claim.action.id, claim.run.id, `boot-${suffix}`, claim.run.leaseEpoch,
        inputs, { requestBody: { messages: [`Input ${suffix}`] } },
      );
      expect(store.claimEngineTurn(turn.id, `boot-${suffix}`, claim.run.leaseEpoch))
        .toMatchObject({ status: 'dispatching' });
      return { item, claim, turn };
    };

    const cancelled = prepareDispatchedTurn('cancelled');
    controller.cancel(cancelled.item.id);
    expect(store.consumeEngineTurn(
      cancelled.turn.id, 'boot-cancelled', cancelled.claim.run.leaseEpoch,
      { responseText: 'late cancelled response', stopReason: 'end_turn' },
    )).toBe(false);
    expect(store.failEngineTurn(
      cancelled.turn.id, 'boot-cancelled', cancelled.claim.run.leaseEpoch,
      new Error('late cancelled failure'),
    )).toEqual({ allowRetry: false, status: 'stale' });
    expect(store.getEngineTurn(cancelled.turn.id)).toMatchObject({ status: 'dispatching', response: null });
    expect(store.db.prepare(`SELECT consumed_at FROM pending_action_inputs
      WHERE action_id = ?`).get(cancelled.claim.action.id).consumed_at).toBeNull();

    const expired = prepareDispatchedTurn('expired', 50);
    now += 51;
    expect(store.isActiveRun(expired.claim.run.id, 'boot-expired', expired.claim.run.leaseEpoch)).toBe(false);
    expect(store.consumeEngineTurn(
      expired.turn.id, 'boot-expired', expired.claim.run.leaseEpoch,
      { responseText: 'late expired response', stopReason: 'end_turn' },
    )).toBe(false);
    expect(store.failEngineTurn(
      expired.turn.id, 'boot-expired', expired.claim.run.leaseEpoch,
      new Error('late expired failure'),
    )).toEqual({ allowRetry: false, status: 'stale' });
    expect(store.getEngineTurn(expired.turn.id)).toMatchObject({ status: 'dispatching', response: null });
  });

  it('cancels the Run atomically, rejects late writes, and resumes with a new Action identity', () => {
    const item = controller.create(createInput());
    const originalAction = store.getAction(item.currentActionId);
    const retainedAttachment = {
      id: 'retained-input-file',
      name: 'retained-input.txt',
      mimeType: 'text/plain',
      size: 23,
      isImage: false,
    };
    controller.input(item.id, {
      text: 'Keep this accepted constraint after a manual stop',
      actionId: originalAction.id,
      revision: item.revision,
      generation: originalAction.generation,
      addedAttachmentCount: 1,
      addedAttachments: [retainedAttachment],
      attachments: [retainedAttachment],
    });
    const acceptedAction = store.getAction(originalAction.id);
    const claim = store.claimReadyAction('boot-a', 5_000);
    controller.input(item.id, {
      text: 'Keep this accepted constraint after a manual stop',
      actionId: originalAction.id,
      revision: store.getWorkItem(item.id).revision,
      generation: acceptedAction.generation,
    });
    const runningInput = controller.input(item.id, {
      text: 'DROP UNCONSUMED INPUT AFTER STOP',
      actionId: originalAction.id,
      revision: store.getWorkItem(item.id).revision,
      generation: acceptedAction.generation,
    });
    const pendingRows = store.db.prepare(`SELECT p.*, e.data FROM pending_action_inputs p
      JOIN events e ON e.id = p.event_id WHERE p.action_id = ? ORDER BY p.event_id`).all(originalAction.id);
    const pendingEvents = pendingRows.map(row => JSON.parse(row.data));
    expect(pendingEvents).toEqual([
      expect.objectContaining({
        text: 'Keep this accepted constraint after a manual stop',
        inputId: expect.any(String),
      }),
      expect.objectContaining({
        text: 'DROP UNCONSUMED INPUT AFTER STOP',
        inputId: expect.any(String),
      }),
    ]);
    expect(pendingEvents[0].inputId).not.toBe(pendingEvents[1].inputId);
    expect(pendingRows.every(row => row.consumed_at == null && row.superseded_at == null)).toBe(true);
    const cancelled = controller.cancel(item.id);
    expect(cancelled.status).toBe('cancelled');
    expect(store.getRun(claim.run.id)).toMatchObject({ status: 'cancelled', endedAt: now });
    expect(store.getAction(originalAction.id).leaseEpoch).toBeGreaterThan(claim.run.leaseEpoch);
    expect(store.isActiveRun(claim.run.id, 'boot-a', claim.run.leaseEpoch)).toBe(false);
    expect(store.renewLease(claim.run.id, 'boot-a', claim.run.leaseEpoch, 5_000)).toBe(false);
    expect(() => controller.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage')))
      .toThrow(/stale|cancelled|expired|finished/i);
    expect(store.recoverInterruptedRuns('new-boot')).toBe(0);
    expect(store.db.prepare(`SELECT COUNT(*) AS count FROM pending_action_inputs
      WHERE action_id = ? AND consumed_at IS NULL AND superseded_at = ?`)
      .get(originalAction.id, now).count).toBe(2);
    const cancelledRevision = store.getWorkItem(item.id).revision;
    expect(cancelledRevision).toBe(runningInput.revision);
    expect(() => controller.resume(item.id, { revision: cancelledRevision + 1 }))
      .toThrow(/changed before it was resumed/i);

    const resumed = controller.resume(item.id, { revision: cancelledRevision });
    const resumedAction = resumed.actions.find(action => action.id === originalAction.id);
    expect(resumed).toMatchObject({ status: 'ready', currentActionId: originalAction.id });
    expect(resumedAction).toMatchObject({
      status: 'ready',
      generation: acceptedAction.generation + 1,
      attempt: 0,
      currentRunId: null,
      resultRunId: null,
    });
    expect(resumedAction.identityHistory).toContainEqual({
      generation: acceptedAction.generation + 1,
      specHash: acceptedAction.specHash,
    });
    const resumedInputs = resumedAction.context.filter(entry => entry.type === 'input');
    expect(resumedInputs).toEqual([
      expect.objectContaining({
        summary: 'Keep this accepted constraint after a manual stop',
        inputId: expect.any(String),
        attachments: [expect.objectContaining({ id: retainedAttachment.id, name: retainedAttachment.name })],
      }),
    ]);
    expect(JSON.stringify(resumedAction.context)).not.toContain('DROP UNCONSUMED INPUT AFTER STOP');
    expect(resumed.events.find(event => event.type === 'work_item.resumed')).toMatchObject({
      actionId: originalAction.id,
      actionGeneration: acceptedAction.generation + 1,
    });
    const resumedMainline = buildMainlineContextSnapshot(resumed, resumedAction).contextSnapshot;
    expect(JSON.stringify(resumedMainline)).toContain('Keep this accepted constraint after a manual stop');
    expect(JSON.stringify(resumedMainline)).not.toContain('DROP UNCONSUMED INPUT AFTER STOP');
    const resumedClaim = store.claimReadyAction('boot-b', 5_000);
    expect(resumedClaim).toMatchObject({
      action: { id: originalAction.id, generation: acceptedAction.generation + 1 },
      run: { actionGeneration: acceptedAction.generation + 1 },
    });
    expect(resumedClaim.run.actionSpecHash).toBe(resumedAction.specHash);
    expect(() => controller.resume(item.id, { revision: cancelledRevision }))
      .toThrow(/cannot be resumed/i);
  });

  it('rolls back every finalization write when the transaction faults', () => {
    const faultDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-fault-'));
    const faultStore = new WorkItemStore(join(faultDir, 'work-center.db'), {
      now: () => now,
      onTransitionStep(step) {
        if (step === 'after_run_update') throw new Error('simulated crash');
      },
    });
    const faultController = new WorkflowController(faultStore);
    faultController.create(createInput());
    const claim = faultStore.claimReadyAction('boot-a', 5_000);
    expect(() => faultController.submit(claim.run.id, 'boot-a', claim.run.leaseEpoch, completed('triage')))
      .toThrow(/simulated crash/);
    expect(faultStore.getRun(claim.run.id).status).toBe('running');
    expect(faultStore.getAction(claim.action.id).status).toBe('running');
    expect(faultStore.getWorkItem(claim.workItem.id).status).toBe('running');
    faultStore.close();
    rmSync(faultDir, { recursive: true, force: true });
  });

  it('atomically rolls back final progress when interruption transition faults', () => {
    const faultDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-interrupt-fault-'));
    const faultStore = new WorkItemStore(join(faultDir, 'work-center.db'), {
      now: () => now,
      onTransitionStep(step) {
        if (step === 'after_interrupt_run_update') throw new Error('simulated interruption crash');
      },
    });
    const faultController = new WorkflowController(faultStore);
    faultController.create(createInput());
    const claim = faultStore.claimReadyAction('boot-a', 5_000);
    faultStore.updateRunProgress(claim.run.id, 'boot-a', claim.run.leaseEpoch, {
      response: 'older durable progress', loopCount: 1, toolCount: 1, checkpoint: null,
    });

    expect(() => faultStore.interruptRun(
      claim.run.id,
      'boot-a',
      claim.run.leaseEpoch,
      'watcher stopped',
      {
        response: 'new final progress',
        loopCount: 2,
        toolCount: 2,
        checkpoint: {
          version: 1,
          toolEvents: [{ name: 'FileEdit', status: 'completed', resource: 'important.js' }],
        },
      },
    )).toThrow(/simulated interruption crash/);
    expect(faultStore.getRun(claim.run.id)).toMatchObject({
      status: 'running',
      response: 'older durable progress',
      loopCount: 1,
      toolCount: 1,
      checkpoint: null,
    });
    expect(faultStore.getAction(claim.action.id).status).toBe('running');
    expect(faultStore.getWorkItem(claim.workItem.id).status).toBe('running');
    faultStore.close();
    rmSync(faultDir, { recursive: true, force: true });
  });
});
