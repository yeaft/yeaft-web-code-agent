import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { DYNAMIC_COORDINATION_MODE, DYNAMIC_EXECUTION_SCHEMA_VERSION, normalizeDynamicCompletion, resolveDynamicActionPolicySnapshot } from '../../../../agent/yeaft/work-center/dynamic-coordination.js';

function workItem(overrides = {}) {
  return {
    id: 'work-item-1',
    coordinationMode: DYNAMIC_COORDINATION_MODE,
    executionSchemaVersion: DYNAMIC_EXECUTION_SCHEMA_VERSION,
    title: 'Ship a durable dynamic loop',
    goal: 'Let the Coordinator create only currently justified Actions',
    acceptanceCriteria: ['Actions are dynamic', 'Completion is evidence-backed'],
    deliveryTarget: 'workspace_files',
    workflowSnapshot: resolveDynamicActionPolicySnapshot({}, 'software-change'),
    ...overrides,
  };
}

describe('Work Center dynamic coordination contract', () => {
  let tempDir;
  let store;

  afterEach(() => {
    try { store?.close(); } catch {}
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    store = null;
    tempDir = null;
  });

  it('requires canonical owned Run evidence for every completion criterion', () => {
    const completion = normalizeDynamicCompletion({
      summary: 'The Coordinator verified the durable result.',
      acceptanceResults: [
        { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: ['run-research'] },
        { criterion: 'Completion is evidence-backed', status: 'passed', evidenceRunIds: ['run-test'] },
      ],
      evidenceRunIds: ['run-research', 'run-test'],
      residualRisks: [],
    }, workItem().acceptanceCriteria);
    expect(completion.evidenceRunIds).toEqual(['run-research', 'run-test']);

    expect(() => normalizeDynamicCompletion({
      summary: 'Incomplete',
      acceptanceResults: [
        { criterion: 'Actions are dynamic', status: 'passed', evidenceRunIds: ['run-research'] },
        { criterion: 'Completion is evidence-backed', status: 'deferred', evidenceRunIds: ['run-test'] },
      ],
      evidenceRunIds: ['run-research', 'run-test'],
    }, workItem().acceptanceCriteria)).toThrow(/every criterion to pass/);
  });
});
