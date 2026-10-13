import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterRouter } from '../../../../agent/yeaft/llm/router.js';
import { WorkItemStore } from '../../../../agent/yeaft/work-center/store.js';
import { WorkflowController } from '../../../../agent/yeaft/work-center/controller.js';
import { createWorkItemToolRegistry, workItemToolPolicySnapshot, resolveWorkItemWorkDir, WorkItemRunner } from '../../../../agent/yeaft/work-center/runner.js';

describe('Work Center tool policy', () => {
  let workDir;
  let outsideDir;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-policy-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'yeaft-work-center-outside-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('protects attachment-mode tool policy', async () => {
    const attachmentDir = join(outsideDir, 'attachments');
    mkdirSync(attachmentDir);
    const attachmentPath = join(attachmentDir, 'evidence.txt');
    writeFileSync(attachmentPath, 'evidence');
    const ref = 'work-item-attachment://attachment-1/evidence.txt';
    const registry = createWorkItemToolRegistry({
      workDir,
      attachmentFiles: [{ ref, path: attachmentPath, root: attachmentDir }],
      isRunActive: () => true,
    });
    expect(registry.getAllTools().map(tool => tool.name)).not.toContain('Bash');
    await expect(registry.execute('Bash', {
      command: `find ${JSON.stringify(attachmentDir)} -type f -delete`,
      cwd: workDir,
      background: false,
    }, {})).rejects.toThrow(/Unknown tool: Bash/);
    expect(readFileSync(attachmentPath, 'utf8')).toBe('evidence');
    expect(workItemToolPolicySnapshot(workDir, [ref])).toMatchObject({
      allowedToolNames: expect.not.arrayContaining(['Bash']),
      shell: { enabled: false },
    });
    expect(workItemToolPolicySnapshot(workDir, [])).toMatchObject({
      allowedToolNames: expect.arrayContaining(['Bash']),
      shell: { enabled: true },
    });
  });

  it('rejects escapes and pins creation-time workspace identity', async () => {
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: () => true });
    await expect(registry.execute('FileRead', { file_path: '../secret' }, {}))
      .rejects.toThrow(/escapes/);
    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/file.txt\n+++ ../../secret.txt\n@@ -1 +1 @@\n-old\n+new\n',
    }, {})).rejects.toThrow(/escapes/);

    const safe = join(workDir, 'safe');
    mkdirSync(safe);
    symlinkSync(outsideDir, join(safe, 'link'));
    await expect(registry.execute('FileWrite', {
      file_path: join(safe, 'link', 'escaped.txt'), content: 'nope',
    }, {})).rejects.toThrow(/escapes/);

    const writeTarget = join(outsideDir, 'write-target.txt');
    const patchTarget = join(outsideDir, 'patch-target.txt');
    symlinkSync(writeTarget, join(workDir, 'write-link.txt'));
    symlinkSync(patchTarget, join(workDir, 'patch-link.txt'));

    await expect(registry.execute('FileWrite', {
      file_path: 'write-link.txt', content: 'outside',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(writeTarget)).toBe(false);

    await expect(registry.execute('ApplyPatch', {
      patch: '--- a/patch-link.txt\n+++ b/patch-link.txt\n@@ -0,0 +1 @@\n+outside\n',
    }, {})).rejects.toThrow(/symbolic link/);
    expect(existsSync(patchTarget)).toBe(false);

    const projectA = join(workDir, 'project-a');
    const projectB = join(workDir, 'project-b');
    const alias = join(workDir, 'current');
    mkdirSync(projectA);
    mkdirSync(projectB);
    symlinkSync(projectA, alias);
    const workItem = { workDir: alias, workspaceKey: projectA };

    unlinkSync(alias);
    symlinkSync(projectB, alias);

    expect(resolveWorkItemWorkDir(workItem, outsideDir)).toBe(projectA);
    expect(() => resolveWorkItemWorkDir({ workDir: alias, workspaceKey: '' }, outsideDir))
      .toThrow(/canonical workspace identity/);
  });

  it('keeps retry EngineTurns uncommitted and fences post-dispatch stops', async () => {
    const store = new WorkItemStore(join(workDir, 'retry-turn-start-close.db'));
    const controller = new WorkflowController(store, { listAvailableVpIds: () => ['omni'] });
    const oldFetch = globalThis.fetch;
    try {
      const item = controller.create({
        id: 'retry-turn-start-close',
        title: 'Close retry at turn boundary',
        goal: 'Do not persist an un-dispatched continuation or EngineTurn',
        acceptanceCriteria: ['No retry request survives a consumer close'],
        workflowTemplate: 'software-change',
        workDir,
        start: true,
      });
      const claim = store.claimReadyAction('retry-boundary-owner', 60_000);
      let providerDispatches = 0;
      globalThis.fetch = async () => {
        providerDispatches += 1;
        if (providerDispatches === 1) {
          return new Response(
            'event: response.output_text.delta\n' +
            'data: {"type":"response.output_text.delta","delta":"visible Work Center partial"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return new Response(
          'event: response.completed\n' +
          'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{}}}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };
      const router = new AdapterRouter({
        providers: [{
          name: 'retry-provider',
          baseUrl: 'https://retry-provider.example/v1',
          apiKey: 'retry-key',
          protocol: 'openai-responses',
          models: ['retry-model'],
        }],
      });
      const runner = new WorkItemRunner({
        store,
        runtimeProvider: async () => ({
          defaultWorkDir: workDir,
          config: {
            model: 'retry-provider/retry-model',
            maxOutputTokens: 1_024,
            projectDocMaxBytes: 0,
            llmRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
          adapter: router,
        }),
        registry: {
          listVps: () => [{ id: 'omni', name: 'Omni', role: 'developer', traits: [] }],
          getVp: id => id === 'omni'
            ? { id: 'omni', name: 'Omni', role: 'developer', traits: [] }
            : null,
        },
      });

      let retryTurnStartSeen = false;
      await expect(runner.run({
        ...claim,
        ownerBootId: 'retry-boundary-owner',
        signal: new AbortController().signal,
        onEngineEvent: event => {
          if (event.type === 'turn_start' && event.turnNumber === 2) {
            retryTurnStartSeen = true;
            return { stop: true };
          }
          return null;
        },
      })).rejects.toMatchObject({ name: 'WorkCenterEngineStoppedError' });

      expect(retryTurnStartSeen).toBe(true);
      expect(providerDispatches).toBe(1);
      // The first request genuinely crossed fetch and therefore remains the
      // expected uncertain turn. The cancelled retry must not create a second
      // prepared/dispatching row.
      expect(store.db.prepare('SELECT status FROM engine_turns WHERE run_id = ? ORDER BY ordinal')
        .all(claim.run.id)).toEqual([{ status: 'unknown' }]);
      expect(store.db.prepare(`SELECT status FROM engine_turns WHERE run_id = ?
        AND status IN ('prepared', 'dispatching')`).all(claim.run.id)).toEqual([]);

      const postDispatchItem = controller.create({
        id: 'post-dispatch-stop',
        title: 'Stop after provider output',
        goal: 'Do not retry a dispatch whose response stream was observed',
        acceptanceCriteria: ['The dispatched run ends terminally'],
        workflowTemplate: 'software-change',
        workDir,
        start: true,
      });
      const postDispatchClaim = store.claimReadyAction('post-dispatch-owner', 60_000);
      let postDispatchFetches = 0;
      globalThis.fetch = async () => {
        postDispatchFetches += 1;
        return new Response(
          'event: response.output_text.delta\n' +
          'data: {"type":"response.output_text.delta","delta":"visible dispatched output"}\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      };
      await expect(runner.run({
        ...postDispatchClaim,
        ownerBootId: 'post-dispatch-owner',
        signal: new AbortController().signal,
        onEngineEvent: event => event.type === 'text_delta' ? { stop: true } : null,
      })).rejects.toMatchObject({
        name: 'WorkCenterEngineStoppedError',
        retryable: false,
        workItemFailureKind: 'provider_dispatch_unknown',
      });
      expect(postDispatchItem.id).toBe('post-dispatch-stop');
      expect(postDispatchFetches).toBe(1);
      expect(store.db.prepare('SELECT status FROM engine_turns WHERE run_id = ? ORDER BY ordinal')
        .all(postDispatchClaim.run.id)).toEqual([{ status: 'unknown' }]);
      expect(store.getRun(postDispatchClaim.run.id)).toMatchObject({ status: 'dispatch_unknown' });
      expect(store.getAction(postDispatchClaim.action.id)).toMatchObject({ status: 'failed' });
    } finally {
      globalThis.fetch = oldFetch;
      store.close();
    }
  });

  it('rejects a replaced canonical target before snapshots or adapter execution', async () => {
    const projectA = join(workDir, 'runner-canonical-a');
    const movedProjectA = join(workDir, 'runner-moved-a');
    const projectB = join(workDir, 'runner-canonical-b');
    mkdirSync(projectA);
    mkdirSync(projectB);
    renameSync(projectA, movedProjectA);
    symlinkSync(projectB, projectA);
    let adapterStarted = false;
    const setRunExecutionSnapshots = vi.fn();
    const runner = new WorkItemRunner({
      runtimeProvider: async () => ({
        defaultWorkDir: outsideDir,
        config: { model: 'provider/model', maxOutputTokens: 1_024 },
        adapter: {
          async *stream() {
            adapterStarted = true;
            yield { type: 'stop', stopReason: 'end_turn' };
          },
        },
      }),
      store: { isActiveRun: () => true, setRunExecutionSnapshots },
      registry: {
        getVp: () => ({ id: 'omni', name: 'Omni', role: 'developer', persona: '' }),
      },
    });

    await expect(runner.run({
      workItem: { workDir: projectA, workspaceKey: projectA },
      action: { type: 'triage', requiredRole: 'omni', instruction: 'Inspect workspace' },
      run: { id: 'run-replaced', leaseEpoch: 1 },
      signal: new AbortController().signal,
      ownerBootId: 'boot-a',
    })).rejects.toThrow(/canonical workspace identity changed/);
    expect(setRunExecutionSnapshots).not.toHaveBeenCalled();
    expect(adapterStarted).toBe(false);

  });

  it('fences execution after the Run loses its lease', async () => {
    const active = vi.fn().mockReturnValue(false);
    const registry = createWorkItemToolRegistry({ workDir, isRunActive: active });
    await expect(registry.execute('ListDir', { path: '.' }, {}))
      .rejects.toThrow(/lease is no longer active/);
  });
});
