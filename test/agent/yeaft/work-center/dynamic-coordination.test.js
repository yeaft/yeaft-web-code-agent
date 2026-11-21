import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkItemCoordinator } from '../../../../agent/yeaft/work-center/coordinator.js';
import { persistWorkItemAttachments, readWorkItemAttachment } from '../../../../agent/yeaft/work-center/attachments.js';
import { AdapterRouter } from '../../../../agent/yeaft/llm/router.js';
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
    vi.unstubAllGlobals();
    try { store?.close(); } catch {}
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    store = null;
    tempDir = null;
  });

  it('requires canonical completion evidence and fits Coordinator attachments before durable dispatch', async () => {
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

    tempDir = mkdtempSync(join(tmpdir(), 'yeaft-coordinator-image-'));
    store = new WorkItemStore(join(tempDir, 'work.db'));
    const item = store.createWorkItem({ title: 'Inspect the attachment', goal: 'Read the evidence',
      acceptanceCriteria: ['Reference preserved'], workDir: tempDir, reuseMemory: false }, { type: 'implement' });
    const root = join(tempDir, 'attachments');
    const png = width => {
      const header = Buffer.from('89504e470d0a1a0a0000000d494844520000000000000010', 'hex');
      header.writeUInt32BE(width, 16);
      return header.toString('base64');
    };
    const attachments = persistWorkItemAttachments([
      { name: 'wide.png', mimeType: 'image/png', data: png(8001) },
      { name: 'small.png', mimeType: 'image/png', data: png(16) },
    ], { root, workItemId: item.id });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text',
      text: JSON.stringify({ reply: 'Evidence noted.', decision: { kind: 'answer', reason: 'Review complete.' } }),
    }] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const coordinator = new WorkItemCoordinator({ store, attachmentRoot: root,
      runtimeProvider: async () => ({ config: { model: 'gateway/claude-opus-4.8' }, adapter: new AdapterRouter({ providers: [{
        name: 'gateway', baseUrl: 'https://example.invalid', protocol: 'anthropic', apiKey: 'fixture', models: ['claude-opus-4.8'],
      }] }) }), registry: { listVps: () => [{ id: 'vp' }] } });
    const detail = store.getWorkItemDetail(item.id);
    await coordinator.message(item.id, { ...detail, text: 'Read both files', attachments, addedAttachments: attachments }).task;
    expect(fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetch.mock.calls[0][1].body).messages[0].content;
    expect(sent.filter(part => part.type === 'image').map(part => part.source.data)).toEqual([png(16)]);
    expect(sent.map(part => part.text || '').join(' ')).toContain('wide.png');
    expect(sent.map(part => part.text || '').join(' ')).toContain('Image not sent: model route image limit');
    const prepared = JSON.parse(store.db.prepare('SELECT request_body FROM coordinator_provider_turns').get().request_body);
    expect(prepared.messages[0].content).toEqual(sent.map(({ cache_control, ...part }) => part));
    expect(readWorkItemAttachment({ ...item, attachments }, attachments[0].id, { root }).data).toBe(png(8001));

    // Seed an old Agent's durable request, then reopen under a new claim.
    const dbPath = join(tempDir, 'work.db');
    let now = Date.now() + 10_000;
    store.close();
    store = new WorkItemStore(dbPath, { now: () => now });
    for (const status of ['prepared', 'responded']) {
      fetch.mockClear();
      const legacy = store.claimStartedCoordinatorTurn(store.beginCoordinatorTurn(
        item.id, 'Recover the comparison', store.getWorkItemDetail(item.id), { addedAttachments: attachments },
      ), 'old-boot', 5_000);
      const request = { model: 'gateway/claude-opus-4.8', system: 'Legacy prompt', maxTokens: 1024,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reference: wide.png' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(8001) } }] }] };
      const old = store.prepareCoordinatorProviderTurn(item.id, legacy.turnId, 1, request, legacy.fence.claim, { id: 'vp', name: 'vp' });
      if (status === 'responded') {
        expect(store.dispatchCoordinatorProviderTurn(old.id, legacy.fence.claim)).toBeTruthy();
        expect(store.respondCoordinatorProviderTurn(old.id, old.requestHash, {
          text: JSON.stringify({ reply: 'Saved answer.', decision: { kind: 'answer', reason: 'Already reviewed.' } }),
        }, legacy.fence.claim)).toBeTruthy();
      }
      now += 70_000;
      store.close();
      store = new WorkItemStore(dbPath, { now: () => now });
      coordinator.store = store;
      const claim = store.claimCoordinatorTurn(item.id, legacy.turnId, 'new-boot');
      const resumed = store.resumeCoordinatorTurn(item.id, legacy.turnId, claim);
      expect(store.loadCoordinatorProviderTurnForRecovery(item.id, legacy.turnId, 1, legacy.fence.claim)).toBeNull();
      if (status === 'responded') expect(store.supersedePreparedCoordinatorRequest(old, request, claim)).toBeNull();
      const result = await coordinator.resume(resumed, { text: 'Recover the comparison', addedAttachments: attachments }).task;
      const after = store.getCoordinatorProviderTurn(old.id);
      expect(result.messages.at(-1), JSON.stringify(result.messages.at(-1))).toMatchObject({ status: 'completed', text: status === 'responded' ? 'Saved answer.' : 'Evidence noted.' });
      expect(after).toMatchObject({ status: status === 'responded' ? 'responded' : 'cancelled', requestBody: request, requestHash: old.requestHash });
      if (status === 'responded') {
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(fetch).toHaveBeenCalledTimes(1);
        const body = JSON.parse(fetch.mock.calls[0][1].body);
        const successor = store.db.prepare('SELECT id FROM coordinator_provider_turns WHERE coordinator_turn_id = ? AND attempt_number = 2').get(legacy.turnId);
        const replacement = store.getCoordinatorProviderTurn(successor.id);
        expect(replacement.status).toBe('responded');
        expect(body.messages[0].content.map(({ cache_control, ...part }) => part)).toEqual(replacement.requestBody.messages[0].content);
        expect(JSON.stringify(body)).not.toContain(png(8001));
      }
    }
  });
});
