import { describe, expect, it } from 'vitest';
import {
  MAINLINE_CONTEXT_HARD_LIMIT_BYTES,
  buildMainlineContextSnapshot,
  buildMainlineProjection,
  hashMainlineSnapshot,
  renderMainlineContextSnapshot,
  validateMainlineContextBudget,
} from '../../../../agent/yeaft/work-center/mainline-projection.js';

function detail(overrides = {}) {
  return {
    id: 'work-1',
    revision: 3,
    planRevision: 2,
    executionSchemaVersion: 2,
    ledgerRevision: 7,
    title: 'Ship deterministic execution',
    goal: 'Derive the mainline without mutating scheduler state',
    acceptanceCriteria: ['Projection is deterministic'],
    actions: [],
    runs: [],
    planConflicts: [],
    ...overrides,
  };
}

describe('Mainline projection', () => {
  it('retains a bounded assignment diagnostic in canonical results', () => {
    const action = {
      id: 'action-1', stageId: 'implement', type: 'implement', sequence: 1,
      generation: 1, specHash: 'hash', status: 'failed', dependsOnStageIds: [], resultRunId: 'run-1',
    };
    const projection = buildMainlineProjection(detail({
      actions: [action],
      runs: [{
        id: 'run-1', actionId: action.id, actionGeneration: 1, actionSpecHash: 'hash',
        status: 'failed', error: 'No eligible VP remained after availability and stage separation checks.', endedAt: 1,
      }],
    }));

    expect(projection.canonicalActionResults[action.id].error)
      .toBe('No eligible VP remained after availability and stage separation checks.');
  });

  it('redacts sensitive Run errors before dependency and sibling model context', () => {
    const dependency = {
      id: 'dependency', stageId: 'research', type: 'research', sequence: 1,
      generation: 1, specHash: 'dependency-hash', status: 'failed', dependsOnStageIds: [], resultRunId: 'run-dependency',
    };
    const sibling = {
      id: 'sibling', stageId: 'test', type: 'test', sequence: 2,
      generation: 1, specHash: 'sibling-hash', status: 'failed', dependsOnStageIds: [], resultRunId: 'run-sibling',
    };
    const current = {
      id: 'current', stageId: 'deliver', type: 'deliver', sequence: 3,
      generation: 1, specHash: 'current-hash', status: 'ready', dependsOnStageIds: ['research'],
    };
    const input = detail({
      actions: [dependency, sibling, current],
      runs: [
        {
          id: 'run-dependency', actionId: dependency.id, actionGeneration: 1,
          actionSpecHash: dependency.specHash, status: 'failed',
          error: 'Authorization: Bearer TOP-SECRET-TOKEN', endedAt: 2,
        },
        {
          id: 'run-sibling', actionId: sibling.id, actionGeneration: 1,
          actionSpecHash: sibling.specHash, status: 'failed',
          error: 'cwd=C:\\Users\\secret\\project token Abcdefghijklmnopqrstuvwxyz1234567890', endedAt: 3,
        },
      ],
    });

    const projection = buildMainlineProjection(input);
    const snapshot = buildMainlineContextSnapshot(input, current).contextSnapshot;
    const serialized = JSON.stringify(snapshot);

    expect(projection.canonicalActionResults[dependency.id].error)
      .toBe('Authorization: ***');
    expect(projection.canonicalActionResults[sibling.id].error)
      .toBe('The Action failed. Sensitive details were omitted.');
    expect(snapshot.directDependencies[0].result.error).toBe('Authorization: ***');
    expect(snapshot.siblingResults[sibling.id].error)
      .toBe('The Action failed. Sensitive details were omitted.');
    expect(serialized).not.toContain('TOP-SECRET-TOKEN');
    expect(serialized).not.toContain('Users\\\\secret');
    expect(serialized).not.toContain('Abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('keeps full results only at their source edge to avoid repeating tokens', () => {
    const source = {
      id: 'source', stageId: 'research', type: 'research', sequence: 1,
      generation: 1, specHash: 'source-hash', status: 'completed', sourceActionIds: [], resultRunId: 'run-source',
    };
    const current = {
      id: 'current', stageId: 'current', type: 'implement', sequence: 2,
      generation: 1, specHash: 'current-hash', status: 'ready', sourceActionIds: [source.id],
    };
    const snapshot = buildMainlineContextSnapshot(detail({
      coordinationMode: 'dynamic',
      actions: [source, current],
      runs: [{
        id: 'run-source', actionId: source.id, actionGeneration: 1,
        actionSpecHash: source.specHash, status: 'completed', summary: 'Reusable source summary',
        evidence: ['specific source evidence'], endedAt: 4,
      }],
    }), current).contextSnapshot;

    expect(snapshot.canonicalCompletedResultsIndex[source.id]).toEqual({
      runId: 'run-source', status: 'completed', endedAt: 4,
    });
    expect(snapshot.sourceResults[0].result).toMatchObject({
      summary: 'Reusable source summary', evidence: ['specific source evidence'],
    });
    expect(snapshot.siblingResults).not.toHaveProperty(source.id);
    expect(JSON.stringify(snapshot).match(/Reusable source summary/g)).toHaveLength(1);
    expect(JSON.stringify(snapshot).match(/specific source evidence/g)).toHaveLength(1);
  });

  it('redacts and bounds failed source results for dynamic model context', () => {
    const source = {
      id: 'source', stageId: 'source', type: 'research', sequence: 1,
      generation: 1, specHash: 'source-hash', status: 'failed', sourceActionIds: [], resultRunId: 'run-source',
    };
    const current = {
      id: 'current', stageId: 'current', type: 'implement', sequence: 2,
      generation: 1, specHash: 'current-hash', status: 'ready', sourceActionIds: [source.id],
    };
    const input = detail({
      coordinationMode: 'dynamic',
      actions: [source, current],
      runs: [{
        id: 'run-source', actionId: source.id, actionGeneration: 1,
        actionSpecHash: source.specHash, status: 'failed',
        error: `Provider failed safely ${'界'.repeat(3_000)}`, endedAt: 4,
      }],
    });

    const snapshot = buildMainlineContextSnapshot(input, current).contextSnapshot;
    const diagnostic = snapshot.sourceResults[0].result.error;

    expect(snapshot).not.toHaveProperty('directDependencies');
    expect(diagnostic).toMatch(/^Provider failed safely /);
    expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThanOrEqual(2_000);
  });

  it('keeps Coordinator conversation out of executor prompts while isolating Action-scoped input', () => {
    const actionA = {
      id: 'action-a', sequence: 1, stageId: 'action-a', type: 'research', status: 'ready',
      generation: 1, specHash: 'action-a-v1', dependsOnStageIds: [],
    };
    const actionB = {
      id: 'action-b', sequence: 2, stageId: 'action-b', type: 'design', status: 'ready',
      generation: 1, specHash: 'action-b-v1', dependsOnStageIds: [],
    };
    const input = detail({
      actions: [actionA, actionB],
      messages: [
        { id: 'legacy', role: 'legacy_instruction', text: 'Already consumed legacy direction', createdAt: 9 },
        { id: 'message-1', role: 'user', text: 'Apply this to every unfinished Action', createdAt: 10 },
        { id: 'message-2', role: 'assistant', text: 'Coordinator internal reply', createdAt: 11 },
      ],
      events: [
        {
          id: 2, type: 'action.input_added', actionId: actionA.id, createdAt: 20,
          data: { text: 'Only Action A may use this' },
        },
        {
          id: 3, type: 'action.guidance_added', actionId: actionB.id, createdAt: 30,
          data: { guidance: 'Only Action B may use this' },
        },
      ],
    });

    const snapshotA = buildMainlineContextSnapshot(input, actionA).contextSnapshot;
    const snapshotB = buildMainlineContextSnapshot(input, actionB).contextSnapshot;

    expect(snapshotA.userContext.workItemMessages).toEqual([]);
    expect(snapshotB.userContext.workItemMessages).toEqual([]);
    expect(JSON.stringify(snapshotA)).not.toContain('Already consumed legacy direction');
    expect(JSON.stringify(snapshotA)).not.toContain('Apply this to every unfinished Action');
    expect(JSON.stringify(snapshotB)).not.toContain('Coordinator internal reply');
    expect(snapshotA.userContext.guidance).toEqual([
      expect.objectContaining({ actionId: actionA.id, text: 'Only Action A may use this' }),
    ]);
    expect(snapshotB.userContext.guidance).toEqual([
      expect.objectContaining({ actionId: actionB.id, text: 'Only Action B may use this' }),
    ]);
    expect(JSON.stringify(snapshotB)).not.toContain('Only Action A may use this');
    expect(JSON.stringify(snapshotA)).not.toContain('Only Action B may use this');
  });

  it('does not carry Action-scoped input across generations', () => {
    const action = {
      id: 'action-a', sequence: 1, stageId: 'action-a', type: 'implement', status: 'ready',
      generation: 2, specHash: 'action-a-v2', dependsOnStageIds: [],
      context: [
        {
          type: 'input', role: 'user', inputId: 'current-input-a',
          summary: 'Current canonical duplicate', attachments: [], evidence: [],
        },
        {
          type: 'input', role: 'user', inputId: 'current-input-b',
          summary: 'Current canonical duplicate', attachments: [], evidence: [],
        },
      ],
    };
    const snapshot = buildMainlineContextSnapshot(detail({
      actions: [action],
      events: [
        {
          id: 1, type: 'action.input_added', actionId: action.id, actionGeneration: 1,
          data: { text: 'Input for the superseded generation' },
        },
        {
          id: 2, type: 'action.input_added', actionId: action.id,
          data: { text: 'Legacy input without a generation' },
        },
        {
          id: 3, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { text: 'Input for the current generation' },
        },
        {
          id: 4, type: 'action.input_added', actionId: action.id, actionGeneration: 1,
          data: { inputId: 'current-input-a', text: 'Current canonical duplicate' },
        },
        {
          id: 5, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { inputId: 'current-input-b', text: 'Current canonical duplicate' },
        },
        {
          id: 6, type: 'action.input_added', actionId: action.id, actionGeneration: 1,
          data: { inputId: 'rebound-only-input', text: 'Rebound event-only input' },
        },
        {
          id: 7, type: 'action.input_rebound', actionId: action.id, actionGeneration: 2,
          data: { sourceEventIds: [6] },
        },
      ],
    }), action).contextSnapshot;

    expect(snapshot.userContext.guidance).toEqual([
      expect.objectContaining({ eventId: 4, inputId: 'current-input-a', text: 'Current canonical duplicate' }),
      expect.objectContaining({ eventId: 5, inputId: 'current-input-b', text: 'Current canonical duplicate' }),
      expect.objectContaining({ eventId: 3, text: 'Input for the current generation' }),
      expect.objectContaining({ eventId: 6, inputId: 'rebound-only-input', text: 'Rebound event-only input' }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('Input for the superseded generation');
    expect(JSON.stringify(snapshot)).not.toContain('Legacy input without a generation');

    const newestFirst = buildMainlineContextSnapshot(detail({
      actions: [action],
      events: [
        {
          id: 8, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { inputId: 'older-large', text: '旧'.repeat(8_000) },
        },
        {
          id: 9, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { inputId: 'latest-correction', text: 'LATEST UTF8 CORRECTION' },
        },
      ],
    }), { ...action, context: [] }).contextSnapshot;
    expect(JSON.stringify(newestFirst)).toContain('LATEST UTF8 CORRECTION');
    expect(JSON.stringify(newestFirst)).not.toContain('旧旧旧');

    const duplicateInputAction = {
      ...action,
      context: [
        {
          type: 'input', role: 'user', inputId: 'duplicate-input',
          summary: 'OLDER DUPLICATE INPUT', attachments: [], evidence: [],
          quote: { role: 'assistant', content: 'OLDER INPUT QUOTE' },
        },
        {
          type: 'input', role: 'user', inputId: 'duplicate-input',
          summary: 'LATEST DUPLICATE INPUT', attachments: [], evidence: [],
        },
      ],
    };
    const duplicateInputSnapshot = buildMainlineContextSnapshot(detail({
      actions: [duplicateInputAction],
      events: [],
      sessionContext: [{ role: 'user', content: 'DUPLICATE INPUT SESSION CONTEXT' }],
    }), duplicateInputAction).contextSnapshot;
    const olderDuplicateInput = duplicateInputSnapshot.userContext.guidance
      .find(value => value.text === 'OLDER DUPLICATE INPUT');
    const latestDuplicateInput = duplicateInputSnapshot.userContext.guidance
      .find(value => value.text === 'LATEST DUPLICATE INPUT');

    expect(olderDuplicateInput).toMatchObject({
      inputId: 'duplicate-input',
      quotedContext: expect.stringContaining('OLDER INPUT QUOTE'),
    });
    expect(latestDuplicateInput).not.toHaveProperty('quotedContext');
    expect(duplicateInputSnapshot.userContext.sessionContext)
      .toEqual([{ role: 'user', vpId: null, text: 'DUPLICATE INPUT SESSION CONTEXT' }]);
    expect(duplicateInputSnapshot.userContext).toMatchObject({ includedCount: 3, omittedCount: 0 });

    const duplicateEventAction = { ...action, context: [] };
    const duplicateEventSnapshot = buildMainlineContextSnapshot(detail({
      actions: [duplicateEventAction],
      events: [
        {
          id: 10, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { text: 'OLDER EVENT INPUT', quote: { role: 'assistant', content: 'OLDER EVENT QUOTE' } },
        },
        {
          id: 10, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: { text: 'LATEST EVENT INPUT' },
        },
      ],
      sessionContext: [{ role: 'user', content: 'DUPLICATE EVENT SESSION CONTEXT' }],
    }), duplicateEventAction).contextSnapshot;
    const olderDuplicateEvent = duplicateEventSnapshot.userContext.guidance
      .find(value => value.text === 'OLDER EVENT INPUT');
    const latestDuplicateEvent = duplicateEventSnapshot.userContext.guidance
      .find(value => value.text === 'LATEST EVENT INPUT');

    expect(olderDuplicateEvent).toMatchObject({
      eventId: 10,
      quotedContext: expect.stringContaining('OLDER EVENT QUOTE'),
    });
    expect(latestDuplicateEvent).not.toHaveProperty('quotedContext');
    expect(duplicateEventSnapshot.userContext.sessionContext)
      .toEqual([{ role: 'user', vpId: null, text: 'DUPLICATE EVENT SESSION CONTEXT' }]);
    expect(duplicateEventSnapshot.userContext).toMatchObject({ includedCount: 3, omittedCount: 0 });

    const ambiguousAction = {
      ...action,
      context: [
        {
          type: 'input', role: 'user', inputId: 'ambiguous-input',
          summary: 'AMBIGUOUS SAME TEXT', attachments: [], evidence: [],
        },
        {
          type: 'input', role: 'user', inputId: 'ambiguous-input',
          summary: 'AMBIGUOUS SAME TEXT', attachments: [], evidence: [],
        },
      ],
    };
    const ambiguousSnapshot = buildMainlineContextSnapshot(detail({
      actions: [ambiguousAction],
      events: [
        {
          id: 11, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: {
            inputId: 'ambiguous-input', text: 'AMBIGUOUS SAME TEXT',
            quote: { role: 'assistant', content: 'DO NOT BORROW QUOTE ONE' },
            attachments: [{ id: 'ambiguous-attachment-one' }],
          },
        },
        {
          id: 12, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
          data: {
            inputId: 'ambiguous-input', text: 'AMBIGUOUS SAME TEXT',
            quote: { role: 'assistant', content: 'DO NOT BORROW QUOTE TWO' },
            attachments: [{ id: 'ambiguous-attachment-two' }],
          },
        },
      ],
    }), ambiguousAction).contextSnapshot;

    expect(ambiguousSnapshot.userContext.guidance).toHaveLength(2);
    expect(ambiguousSnapshot.userContext.guidance.every(value => (
      value.eventId == null
      && value.attachments.length === 0
      && !Object.hasOwn(value, 'quotedContext')
    ))).toBe(true);
    expect(JSON.stringify(ambiguousSnapshot)).not.toContain('DO NOT BORROW');
    expect(JSON.stringify(ambiguousSnapshot)).not.toContain('ambiguous-attachment');
    expect(ambiguousSnapshot.userContext).toMatchObject({ includedCount: 2, omittedCount: 0 });

    const missingIdentitySnapshot = buildMainlineContextSnapshot(detail({
      actions: [duplicateEventAction],
      events: [{
        id: null, type: 'action.input_added', actionId: action.id, actionGeneration: 2,
        data: {
          text: 'UNIDENTIFIED INPUT',
          quote: { role: 'assistant', content: 'OMIT THIS QUOTE' },
          attachments: [{ id: 'omit-this-attachment' }],
        },
      }],
      sessionContext: [{ role: 'user', content: 'MISSING IDENTITY SESSION CONTEXT' }],
    }), duplicateEventAction).contextSnapshot;
    const unidentifiedInput = missingIdentitySnapshot.userContext.guidance
      .find(value => value.text === 'UNIDENTIFIED INPUT');

    expect(unidentifiedInput).toBeDefined();
    expect(unidentifiedInput).toMatchObject({ attachments: [] });
    expect(unidentifiedInput).not.toHaveProperty('quotedContext');
    expect(JSON.stringify(missingIdentitySnapshot)).not.toContain('omit-this-attachment');
    expect(missingIdentitySnapshot.userContext.sessionContext)
      .toEqual([{ role: 'user', vpId: null, text: 'MISSING IDENTITY SESSION CONTEXT' }]);
    expect(missingIdentitySnapshot.userContext).toMatchObject({ includedCount: 2, omittedCount: 0 });

    const budgetAction = {
      ...action,
      context: [
        {
          type: 'input', role: 'user', inputId: 'budget-duplicate',
          summary: `DROP LARGE DUPLICATE ${'旧'.repeat(8_000)}`, attachments: [], evidence: [],
        },
        {
          type: 'input', role: 'user', inputId: 'budget-duplicate',
          summary: 'KEEP QUOTED DUPLICATE', attachments: [], evidence: [],
          quote: { role: 'assistant', content: 'KEEP THIS QUOTE ASSOCIATION' },
        },
        {
          type: 'input', role: 'user', inputId: 'budget-duplicate',
          summary: 'KEEP LATEST DUPLICATE', attachments: [], evidence: [],
        },
      ],
    };
    const budgetBuilt = buildMainlineContextSnapshot(detail({
      actions: [budgetAction],
      events: [],
      sessionContext: [{ role: 'user', content: 'KEEP BUDGET SESSION CONTEXT' }],
    }), budgetAction);
    const budgetGuidance = budgetBuilt.contextSnapshot.userContext.guidance;
    const quotedBudgetInput = budgetGuidance.find(value => value.text === 'KEEP QUOTED DUPLICATE');
    const latestBudgetInput = budgetGuidance.find(value => value.text === 'KEEP LATEST DUPLICATE');

    expect(JSON.stringify(budgetBuilt.contextSnapshot)).not.toContain('DROP LARGE DUPLICATE');
    expect(quotedBudgetInput).toMatchObject({
      inputId: 'budget-duplicate',
      quotedContext: expect.stringContaining('KEEP THIS QUOTE ASSOCIATION'),
    });
    expect(latestBudgetInput).not.toHaveProperty('quotedContext');
    expect(budgetBuilt.contextSnapshot.userContext.sessionContext)
      .toEqual([{ role: 'user', vpId: null, text: 'KEEP BUDGET SESSION CONTEXT' }]);
    expect(budgetBuilt.contextSnapshot.userContext).toMatchObject({ includedCount: 3, omittedCount: 1 });
    expect(budgetBuilt.contextSnapshot.userContext.includedCount
      + budgetBuilt.contextSnapshot.userContext.omittedCount).toBe(4);
    expect(budgetGuidance.every(value => Object.getOwnPropertySymbols(value).length === 0)).toBe(true);
    expect(budgetBuilt.budget.bytes).toBeLessThanOrEqual(MAINLINE_CONTEXT_HARD_LIMIT_BYTES);
  });

  it('reserves final prompt wrapper bytes inside the 64 KiB hard limit', () => {
    const action = { id: 'current', sequence: 1, stageId: 'implement', type: 'implement', status: 'running' };
    const reservedBytes = 12 * 1024;
    const built = buildMainlineContextSnapshot(detail({
      actions: [action],
      sessionContext: Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: `路径\\${index}😀中文`.repeat(500) })),
    }), action, { reservedBytes });

    expect(built.budget.bytes + reservedBytes).toBeLessThanOrEqual(MAINLINE_CONTEXT_HARD_LIMIT_BYTES);
    expect(built.budget.reservedBytes).toBe(reservedBytes);
    expect(built.contextSnapshot.userContext.includedCount + built.contextSnapshot.userContext.omittedCount)
      .toBeLessThanOrEqual(20);
    expect(built.contextSnapshot.userContext.omittedCount).toBeGreaterThanOrEqual(0);
  });




});
