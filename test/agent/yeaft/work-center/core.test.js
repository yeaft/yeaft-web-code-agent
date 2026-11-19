import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
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

});
