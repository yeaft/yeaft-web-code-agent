import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinator } from '../../../agent/yeaft/sessions/coordinator.js';
import {
  bindRepoApprovalCapability,
  consumeRepoApprovalCapability,
  createRouter,
  REPO_APPROVAL_TTL_MS,
} from '../../../agent/yeaft/routing/router.js';
import { createLoopGuard, MAX_CHAIN_DEPTH } from '../../../agent/yeaft/routing/loop-guard.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { Engine } from '../../../agent/yeaft/engine.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import ctx from '../../../agent/context.js';
import { createCliSessionRunner, createCliVpEngine } from '../../../agent/yeaft/cli-session-runner.js';
import {
  normalizeStreamRoutingIntent,
  runStreamSessionTurn,
} from '../../../agent/yeaft/stdio-protocol.js';
import routeForwardTool from '../../../agent/yeaft/tools/route-forward.js';
import {
  __testDrainVpDrivers,
  __testEnqueueForVp,
  __testGetVpThreads,
  __testResetVpState,
  __testSeedVpThread,
  __testSetVpThreadEngine,
  __testSetSession,
  __testSetThreadClassifier,
  __testWaitForRoutePromises,
  buildVpQueryOpts,
  handleYeaftAbortTurn,
  visibleInboundThreadId,
  __testHooks,
} from '../../../agent/yeaft/web-bridge.js';

describe('route_forward thread ownership', () => {
  const originalConfig = ctx.CONFIG;

  it('describes route_forward as the required multi-VP hand-off tool', () => {
    expect(routeForwardTool.description.en).toContain('required hand-off mechanism');
    expect(routeForwardTool.description.en).toContain('VP-authored @mentions');
    expect(routeForwardTool.description.en).toContain('call RouteForward');
    expect(routeForwardTool.description.en).toContain('same session');
  });

  it('allows 30 causedBy hops and rejects the 31st', () => {
    const guard = createLoopGuard();
    const allowed = Array.from({ length: MAX_CHAIN_DEPTH }, (_, i) => `msg-${i}`);
    const blocked = [...allowed, 'msg-overflow'];

    expect(MAX_CHAIN_DEPTH).toBe(30);
    expect(guard.check({
      sessionId: 'session-route-depth',
      targetVpId: 'vp-martin',
      chain: allowed,
    })).toEqual({ ok: true });
    expect(guard.check({
      sessionId: 'session-route-depth',
      targetVpId: 'vp-martin',
      chain: blocked,
    })).toEqual({
      ok: false,
      reason: 'chain_depth_exceeded',
      detail: { depth: 31, limit: 30 },
    });
    expect(routeForwardTool.description.en).toContain('deeper than 30 hops');
    expect(routeForwardTool.description.zh).toContain('超过 30 跳');
  });

  afterEach(async () => {
    await __testResetVpState();
    __testSetSession(null);
    __testSetThreadClassifier(null);
    ctx.CONFIG = originalConfig;
  });

  function makeCoordinator({
    roster = ['vp-linus', 'vp-martin'],
    defaultVpId = roster[0],
  } = {}) {
    const stored = [];
    const delivered = [];
    const group = {
      getMeta() {
        return {
          id: 'session-route-thread',
          roster,
          defaultVpId,
        };
      },
      appendMessage(record) {
        const msg = {
          id: `msg-${stored.length + 1}`,
          ts: '2026-06-12T00:00:00.000Z',
          ...record,
        };
        stored.push(msg);
        return msg;
      },
    };
    const coordinator = createCoordinator(group, {
      deliver(vpId, envelope) {
        delivered.push({ vpId, envelope });
      },
    });
    return { coordinator, stored, delivered };
  }

  async function startBlockedApprovalTurn() {
    const sessionId = 'session-route-thread';
    const vpId = 'linus';
    const reviewedHead = 'e'.repeat(40);
    const reviewedSnapshot = 'f'.repeat(40);
    const { coordinator, delivered } = makeCoordinator({
      roster: [vpId, 'martin'],
      defaultVpId: vpId,
    });
    const router = createRouter({ coordinator });
    expect(router.forward({
      from: 'martin',
      to: vpId,
      text: 'APPROVE exact repository landing tuple',
      repoApproval: {
        repository: 'acme/repo',
        pr: 1677,
        baseBranch: 'main',
        baseSha: '1'.repeat(40),
        reviewedHead,
        reviewedSnapshot,
      },
    }).ok).toBe(true);
    const envelope = delivered[0].envelope;
    let probeContext = null;
    let releaseProbe;
    const blocked = new Promise(resolve => { releaseProbe = resolve; });
    let adapterCalls = 0;
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'probe_blocked_approval',
      description: 'hold an approval turn open',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, toolCtx) => {
        probeContext = toolCtx;
        await blocked;
        return 'released';
      },
    });
    __testSetSession({
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true },
      conversationStore: {
        append: record => record,
        loadRecentBySession: () => [],
      },
      toolRegistry,
      trace: new NullTrace(),
      adapter: {
        async *stream() {
          if (adapterCalls++ === 0) {
            yield { type: 'tool_call', id: 'probe-blocked-1', name: 'probe_blocked_approval', input: {} };
            yield { type: 'stop', stopReason: 'tool_use' };
          } else {
            yield { type: 'stop', stopReason: 'end_turn' };
          }
        },
        async call() { return { text: '', usage: {} }; },
      },
    });
    __testEnqueueForVp(sessionId, vpId, envelope);
    await __testWaitForRoutePromises(envelope.msg.id);
    await vi.waitFor(() => expect(probeContext).not.toBeNull());
    const expected = {
      sessionId,
      recipientVpId: vpId,
      turnId: probeContext.turnId,
      repository: 'github.com/acme/repo',
      pr: 1677,
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
      reviewedHead,
      reviewedSnapshot,
    };
    return {
      sessionId,
      vpId,
      envelope,
      expected,
      releaseProbe,
    };
  }

  it('delivers user text with unknown @ tokens to the default VP', () => {
    const { coordinator, stored, delivered } = makeCoordinator();

    const result = coordinator.ingest({
      from: 'user',
      role: 'user',
      text: 'send updates to example@company.com and keep @nobody in the sample',
    });

    expect(result).toMatchObject({
      dispatched: ['vp-linus'],
      fallback: 'vp-linus',
      errors: [],
    });
    expect(stored[0].mentions).toEqual(['nobody']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      vpId: 'vp-linus',
      envelope: { trigger: 'fallback' },
    });
  });

  it('stamps the sender thread on synthetic route_forward messages', () => {
    const { coordinator, stored, delivered } = makeCoordinator();
    const router = createRouter({ coordinator });

    const result = router.forward({
      from: 'vp-linus',
      to: 'vp-martin',
      text: 'please review this PR',
      reason: 'review',
      inboundEnvelope: {
        sessionId: 'session-route-thread',
        vpId: 'vp-linus',
        threadId: 'thr-source',
        msg: { id: 'msg-user-1', from: 'user', meta: {} },
      },
      sourceThreadId: 'thr-source',
    });

    expect(result.ok).toBe(true);
    expect(result.dispatched).toEqual(['vp-martin']);
    expect(stored).toHaveLength(1);
    expect(stored[0].internal).toBe(true);
    expect(stored[0].meta).toMatchObject({
      injectedBy: 'route_forward',
      senderVpId: 'vp-linus',
      sourceThreadId: 'thr-source',
    });
    expect(delivered[0].envelope.msg.meta.sourceThreadId).toBe('thr-source');
  });

  it('rejects repository approval issuance from non-stock reviewer identities', () => {
    const { coordinator, delivered } = makeCoordinator();
    const router = createRouter({ coordinator });
    const repoApproval = {
      repository: 'acme/repo',
      pr: 1677,
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
      reviewedHead: 'a'.repeat(40),
      reviewedSnapshot: 'b'.repeat(40),
    };

    expect(router.forward({
      from: 'vp-linus',
      to: 'vp-martin',
      text: 'self-asserted approval',
      repoApproval,
    })).toMatchObject({ ok: false, error: 'repo_approval_issuer_forbidden' });
    expect(router.forward({
      from: 'vp-martin',
      to: 'vp-linus',
      text: 'mutable-role lookalike approval',
      repoApproval,
    })).toMatchObject({ ok: false, error: 'repo_approval_issuer_forbidden' });
    expect(delivered).toHaveLength(0);
  });

  it('carries an opaque one-time repository approval only in the target envelope', () => {
    const { coordinator, stored, delivered } = makeCoordinator({
      roster: ['linus', 'martin'],
      defaultVpId: 'linus',
    });
    let nowMs = 1_000;
    const router = createRouter({ coordinator, now: () => nowMs });
    const reviewedHead = 'a'.repeat(40);
    const reviewedSnapshot = 'b'.repeat(40);

    const result = router.forward({
      from: 'vp-martin',
      to: 'vp-linus',
      text: 'APPROVE exact repository landing tuple',
      repoApproval: {
        repository: 'Acme/Repo.git',
        pr: 1677,
        baseBranch: 'main',
        baseSha: '1'.repeat(40),
        reviewedHead,
        reviewedSnapshot,
      },
    });

    expect(result).toMatchObject({ ok: true, dispatched: ['linus'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]._repoApproval).toBeUndefined();
    expect(JSON.stringify(stored[0])).not.toContain('repoApproval');
    const capability = delivered[0].envelope._repoApproval;
    expect(capability).toBeTruthy();
    expect(JSON.stringify(capability)).toBe('{}');
    expect(bindRepoApprovalCapability(capability, {
      sessionId: 'session-route-thread',
      recipientVpId: 'linus',
      turnId: 'turn-approved',
    }, { now: () => nowMs })).toBe(true);
    expect(consumeRepoApprovalCapability({}, {
      sessionId: 'session-route-thread',
      recipientVpId: 'vp-linus',
      repository: 'acme/repo',
      pr: 1677,
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
      reviewedHead,
      reviewedSnapshot,
    })).toBeNull();
    expect(consumeRepoApprovalCapability(capability, {
      sessionId: 'session-route-thread',
      recipientVpId: 'linus',
      turnId: 'turn-approved',
      repository: 'github.com/acme/repo',
      pr: 1677,
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
      reviewedHead,
      reviewedSnapshot,
    }, { now: () => nowMs })).toMatchObject({
      issuerVpId: 'martin',
      recipientVpId: 'linus',
      repository: 'github.com/acme/repo',
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
    });
    expect(consumeRepoApprovalCapability(capability, {
      sessionId: 'session-route-thread',
      recipientVpId: 'vp-linus',
      repository: 'acme/repo',
      pr: 1677,
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
      reviewedHead,
      reviewedSnapshot,
    })).toBeNull();
  });

  it('expires repository approvals and consumes wrong-turn attempts', () => {
    const { coordinator, delivered } = makeCoordinator({
      roster: ['linus', 'martin'],
      defaultVpId: 'linus',
    });
    let nowMs = 5_000;
    const router = createRouter({ coordinator, now: () => nowMs });
    const reviewedHead = 'c'.repeat(40);
    const reviewedSnapshot = 'd'.repeat(40);
    const expected = {
      sessionId: 'session-route-thread',
      recipientVpId: 'linus',
      repository: 'github.com/acme/repo',
      pr: 1677,
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
      reviewedHead,
      reviewedSnapshot,
    };

    const issue = () => {
      expect(router.forward({
        from: 'vp-martin',
        to: 'vp-linus',
        text: 'APPROVE exact repository landing tuple',
        repoApproval: {
          repository: 'acme/repo',
          pr: 1677,
          baseBranch: 'main',
          baseSha: '1'.repeat(40),
          reviewedHead,
          reviewedSnapshot,
        },
      }).ok).toBe(true);
      return delivered.at(-1).envelope._repoApproval;
    };

    const wrongTurnCapability = issue();
    expect(bindRepoApprovalCapability(wrongTurnCapability, {
      sessionId: expected.sessionId,
      recipientVpId: expected.recipientVpId,
      turnId: 'turn-approved',
    }, { now: () => nowMs })).toBe(true);
    expect(consumeRepoApprovalCapability(wrongTurnCapability, {
      ...expected,
      turnId: 'turn-wrong',
    }, { now: () => nowMs })).toBeNull();
    expect(consumeRepoApprovalCapability(wrongTurnCapability, {
      ...expected,
      turnId: 'turn-approved',
    }, { now: () => nowMs })).toBeNull();

    const wrongBaseBranchCapability = issue();
    expect(bindRepoApprovalCapability(wrongBaseBranchCapability, {
      sessionId: expected.sessionId,
      recipientVpId: expected.recipientVpId,
      turnId: 'turn-wrong-base-branch',
    }, { now: () => nowMs })).toBe(true);
    expect(consumeRepoApprovalCapability(wrongBaseBranchCapability, {
      ...expected,
      turnId: 'turn-wrong-base-branch',
      baseBranch: 'release',
    }, { now: () => nowMs })).toBeNull();

    const wrongBaseShaCapability = issue();
    expect(bindRepoApprovalCapability(wrongBaseShaCapability, {
      sessionId: expected.sessionId,
      recipientVpId: expected.recipientVpId,
      turnId: 'turn-wrong-base-sha',
    }, { now: () => nowMs })).toBe(true);
    expect(consumeRepoApprovalCapability(wrongBaseShaCapability, {
      ...expected,
      turnId: 'turn-wrong-base-sha',
      baseSha: '2'.repeat(40),
    }, { now: () => nowMs })).toBeNull();

    const expiredCapability = issue();
    expect(bindRepoApprovalCapability(expiredCapability, {
      sessionId: expected.sessionId,
      recipientVpId: expected.recipientVpId,
      turnId: 'turn-expired',
    }, { now: () => nowMs })).toBe(true);
    nowMs += REPO_APPROVAL_TTL_MS + 1;
    expect(consumeRepoApprovalCapability(expiredCapability, {
      ...expected,
      turnId: 'turn-expired',
    }, { now: () => nowMs })).toBeNull();
  });

  it('uses sourceThreadId for visible route_forward rows', () => {
    const envelope = {
      msg: {
        meta: {
          injectedBy: 'route_forward',
          sourceThreadId: '  thr-source  ',
        },
      },
    };

    expect(visibleInboundThreadId(envelope, 'thr-target')).toBe('thr-source');
    expect(visibleInboundThreadId({ msg: { meta: {} } }, 'thr-target')).toBe('thr-target');
  });

  it('persists related route_forward rows under the source thread while queuing target work', async () => {
    const persisted = [];
    const sessionId = 'session-route-thread-related';
    const targetVpId = 'vp-martin';
    __testSetSession({
      config: {},
      conversationStore: {
        append(record) {
          persisted.push(record);
          return { id: `persisted-${persisted.length}`, ...record };
        },
      },
    });
    __testSeedVpThread({
      sessionId,
      vpId: targetVpId,
      threadId: 'thr-target',
      status: 'typing',
    });
    __testSetVpThreadEngine({
      sessionId,
      vpId: targetVpId,
      threadId: 'thr-target',
      engine: { wakeForPendingUserMessage: () => true },
    });
    __testSetThreadClassifier(async () => ({
      decision: 'related',
      targetThreadId: 'thr-target',
      title: 'target work',
    }));

    const envelope = {
      sessionId,
      vpId: targetVpId,
      threadId: 'thr-target',
      trigger: 'mention',
      msg: {
        id: 'msg-forward-related',
        from: 'vp-linus',
        role: 'assistant',
        text: '@vp-martin please review this PR',
        meta: {
          injectedBy: 'route_forward',
          senderVpId: 'vp-linus',
          sourceThreadId: 'thr-source',
        },
      },
    };

    __testEnqueueForVp(sessionId, targetVpId, envelope);
    await __testWaitForRoutePromises('msg-forward-related');

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: 'assistant',
      speakerVpId: 'vp-linus',
      threadId: 'thr-source',
      sessionId,
    });
    const targetThread = __testGetVpThreads(sessionId, targetVpId)
      .find(thread => thread.threadId === 'thr-target');
    expect(targetThread?.pendingQueries).toHaveLength(1);
  });

  it('runs approval envelopes as dedicated exact-turn executions and revokes them on completion', async () => {
    const sessionId = 'session-route-thread';
    const vpId = 'linus';
    const reviewedHead = 'e'.repeat(40);
    const reviewedSnapshot = 'f'.repeat(40);
    const { coordinator, delivered } = makeCoordinator({
      roster: [vpId, 'martin'],
      defaultVpId: vpId,
    });
    const router = createRouter({ coordinator });
    expect(router.forward({
      from: 'martin',
      to: vpId,
      text: 'APPROVE exact repository landing tuple',
      repoApproval: {
        repository: 'acme/repo',
        pr: 1677,
        baseBranch: 'main',
        baseSha: '1'.repeat(40),
        reviewedHead,
        reviewedSnapshot,
      },
    }).ok).toBe(true);
    const envelope = delivered[0].envelope;
    let probeContext = null;
    let adapterCalls = 0;
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'probe_approval_context',
      description: 'capture approval context',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, toolCtx) => {
        probeContext = toolCtx;
        return 'observed';
      },
    });
    const classifier = vi.fn(async () => ({
      decision: 'related',
      targetThreadId: 'thr-running',
      title: 'running work',
    }));
    __testSetSession({
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true },
      conversationStore: {
        append: record => record,
        loadRecentBySession: () => [],
      },
      toolRegistry,
      trace: new NullTrace(),
      adapter: {
        async *stream() {
          if (adapterCalls++ === 0) {
            yield { type: 'tool_call', id: 'probe-approval-1', name: 'probe_approval_context', input: {} };
            yield { type: 'stop', stopReason: 'tool_use' };
          } else {
            yield { type: 'stop', stopReason: 'end_turn' };
          }
        },
        async call() { return { text: '', usage: {} }; },
      },
    });
    __testSeedVpThread({ sessionId, vpId, threadId: 'thr-running', status: 'typing' });
    __testSetVpThreadEngine({
      sessionId,
      vpId,
      threadId: 'thr-running',
      engine: { wakeForPendingUserMessage: () => true },
    });
    __testSetThreadClassifier(classifier);

    __testEnqueueForVp(sessionId, vpId, envelope);
    await __testWaitForRoutePromises(envelope.msg.id);
    await __testDrainVpDrivers();

    expect(classifier).not.toHaveBeenCalled();
    expect(probeContext?.inboundEnvelope).toBe(envelope);
    expect(probeContext?.turnId).toEqual(expect.any(String));
    expect(probeContext.turnId).not.toBe('');
    const threads = __testGetVpThreads(sessionId, vpId);
    expect(threads).toHaveLength(2);
    expect(threads.find(thread => thread.threadId === 'thr-running')?.pendingQueries).toHaveLength(0);
    expect(consumeRepoApprovalCapability(envelope._repoApproval, {
      sessionId,
      recipientVpId: vpId,
      turnId: probeContext.turnId,
      repository: 'github.com/acme/repo',
      pr: 1677,
      baseBranch: 'main',
      baseSha: '1'.repeat(40),
      reviewedHead,
      reviewedSnapshot,
    })).toBeNull();
  });

  it('revokes an unconsumed approval when its exact turn is aborted', async () => {
    const runtime = await startBlockedApprovalTurn();

    handleYeaftAbortTurn({
      sessionId: runtime.sessionId,
      vpId: runtime.vpId,
      turnId: runtime.expected.turnId,
    });
    expect(consumeRepoApprovalCapability(runtime.envelope._repoApproval, runtime.expected)).toBeNull();

    runtime.releaseProbe();
    await __testDrainVpDrivers();
  });

  it('revokes an unconsumed approval when the recipient receives later user input', async () => {
    const runtime = await startBlockedApprovalTurn();
    __testSetThreadClassifier(async () => ({
      decision: 'related',
      targetThreadId: runtime.expected.turnId.split(':')[0],
      title: 'approval work',
    }));
    const laterMessageId = 'msg-later-user-input';

    __testEnqueueForVp(runtime.sessionId, runtime.vpId, {
      sessionId: runtime.sessionId,
      trigger: 'fallback',
      msg: {
        id: laterMessageId,
        from: 'user',
        role: 'user',
        text: 'Do something else instead.',
        meta: {},
      },
    });
    await __testWaitForRoutePromises(laterMessageId);
    expect(consumeRepoApprovalCapability(runtime.envelope._repoApproval, runtime.expected)).toBeNull();

    runtime.releaseProbe();
    handleYeaftAbortTurn({ sessionId: runtime.sessionId, vpId: runtime.vpId });
    await __testDrainVpDrivers();
  });

  it('wakes a running thread when user input arrives during a background-task wait', async () => {
    const persisted = [];
    const sessionId = 'session-user-append-wake';
    const vpId = 'vp-linus';
    const wakeForPendingUserMessage = vi.fn(() => true);
    __testSetSession({
      config: {},
      conversationStore: {
        append(record) {
          persisted.push(record);
          return { id: `persisted-${persisted.length}`, ...record };
        },
      },
    });
    __testSeedVpThread({ sessionId, vpId, threadId: 'thr-running', status: 'tool' });
    __testSetVpThreadEngine({
      sessionId,
      vpId,
      threadId: 'thr-running',
      engine: { wakeForPendingUserMessage },
    });
    __testSetThreadClassifier(async () => ({
      decision: 'related',
      targetThreadId: 'thr-running',
      title: 'background work',
    }));

    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: {
        id: 'msg-user-during-task',
        from: 'user',
        role: 'user',
        text: 'please answer this while the task keeps running',
        meta: {},
      },
    });
    await __testWaitForRoutePromises('msg-user-during-task');

    expect(wakeForPendingUserMessage).toHaveBeenCalledTimes(1);
    expect(__testGetVpThreads(sessionId, vpId)[0].pendingQueries).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: 'user',
      sessionId,
      threadId: 'thr-running',
    });
  });

  it('starts a new turn when thread classification fails', async () => {
    const sessionId = 'session-classifier-failure';
    const vpId = 'vp-linus';
    const persisted = [];
    __testSetSession({
      config: { _readOnly: true },
      conversationStore: {
        append(record) {
          persisted.push(record);
          return record;
        },
        loadRecentBySession: () => [],
      },
      toolRegistry: new ToolRegistry(),
      trace: new NullTrace(),
      adapter: {
        async *stream() { yield { type: 'stop', stopReason: 'end_turn' }; },
        async call() { return { text: '', usage: {} }; },
      },
    });
    __testSeedVpThread({ sessionId, vpId, threadId: 'thr-running', status: 'typing' });
    __testSetThreadClassifier(async () => {
      throw new Error('classifier provider unavailable');
    });

    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: {
        id: 'msg-classifier-failure',
        from: 'user',
        role: 'user',
        text: 'do not drop this request',
        meta: {},
      },
    });
    await __testWaitForRoutePromises('msg-classifier-failure');

    const threads = __testGetVpThreads(sessionId, vpId);
    expect(threads).toHaveLength(2);
    expect(threads.find(thread => thread.threadId === 'thr-running')?.pendingQueries).toHaveLength(0);
    expect(persisted).toContainEqual(expect.objectContaining({
      role: 'user',
      sessionId,
      content: 'do not drop this request',
    }));
  });

  it('falls back to a normal queued turn when a stale thread has no running engine', async () => {
    const sessionId = 'session-stale-thread';
    const vpId = 'vp-linus';
    __testSetSession({
      config: { _readOnly: true },
      conversationStore: {
        append: record => record,
        loadRecentBySession: () => [],
      },
      toolRegistry: new ToolRegistry(),
      trace: new NullTrace(),
      adapter: {
        async *stream() { yield { type: 'stop', stopReason: 'end_turn' }; },
        async call() { return { text: '', usage: {} }; },
      },
    });
    __testSeedVpThread({ sessionId, vpId, threadId: 'thr-stale', status: 'tool' });
    __testSetThreadClassifier(async () => ({
      decision: 'related',
      targetThreadId: 'thr-stale',
      title: 'stale work',
    }));

    __testEnqueueForVp(sessionId, vpId, {
      sessionId,
      trigger: 'fallback',
      msg: { id: 'msg-stale-fallback', from: 'user', role: 'user', text: 'new input', meta: {} },
    });
    await __testWaitForRoutePromises('msg-stale-fallback');

    const stale = __testGetVpThreads(sessionId, vpId).find(thread => thread.threadId === 'thr-stale');
    expect(stale?.pendingQueries).toHaveLength(0);
  });

  it('loads distinct VP souls from the active Agent instance into provider requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-web-vp-souls-'));
    try {
      const souls = {
        'vp-linus': 'LINUS_INSTANCE_SOUL: simplify the system and prove every claim.',
        'vp-martin': 'MARTIN_INSTANCE_SOUL: protect architecture boundaries and review independently.',
      };
      for (const [vpId, soul] of Object.entries(souls)) {
        const vpDir = join(root, 'virtual-persons', vpId);
        mkdirSync(vpDir, { recursive: true });
        writeFileSync(join(vpDir, 'role.md'), [
          '---',
          `id: ${vpId}`,
          `name: ${vpId === 'vp-linus' ? 'Linus' : 'Martin'}`,
          '---',
          soul,
        ].join('\n'));
      }
      ctx.CONFIG = { yeaftDir: root };

      const providerCalls = [];
      for (const vpId of Object.keys(souls)) {
        const engine = new Engine({
          adapter: {
            async *stream(request) {
              providerCalls.push({ vpId, system: request.system });
              yield { type: 'text_delta', text: 'ok' };
              yield { type: 'stop', stopReason: 'end_turn' };
            },
          },
          trace: new NullTrace(),
          config: { model: 'test-model', maxOutputTokens: 1024 },
        });
        const queryOpts = buildVpQueryOpts({ vpId, sessionId: 'session-soul-proof' });
        for await (const _event of engine.query({ prompt: 'state your operating principles', ...queryOpts })) {
          // drain
        }
      }

      expect(providerCalls).toHaveLength(2);
      expect(providerCalls[0].system).toContain(souls['vp-linus']);
      expect(providerCalls[0].system).not.toContain(souls['vp-martin']);
      expect(providerCalls[1].system).toContain(souls['vp-martin']);
      expect(providerCalls[1].system).not.toContain(souls['vp-linus']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('selects the first configured VP when no explicit or default VP is available', () => {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-web-vp-fallback-'));
    try {
      const vpDir = join(root, 'virtual-persons', 'vp-instance-fallback');
      mkdirSync(vpDir, { recursive: true });
      writeFileSync(join(vpDir, 'role.md'), [
        '---',
        'id: vp-instance-fallback',
        'name: Instance Fallback',
        '---',
        'INSTANCE_FALLBACK_SOUL',
      ].join('\n'));
      ctx.CONFIG = { yeaftDir: root };
      __testSetSession({ config: {} });

      expect(buildVpQueryOpts({ sessionId: 'session-soul-fallback' })).toEqual(expect.objectContaining({
        senderVpId: 'vp-instance-fallback',
        vpPersona: expect.objectContaining({
          vpId: 'vp-instance-fallback',
          persona: 'INSTANCE_FALLBACK_SOUL',
        }),
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes the active engine thread id into the route_forward tool context', async () => {
    const { coordinator, stored } = makeCoordinator();
    const queryOpts = buildVpQueryOpts({
      vpId: 'vp-linus',
      sessionId: 'session-route-thread',
      sessionCoordinator: coordinator,
      envelope: {
        sessionId: 'session-route-thread',
        vpId: 'vp-linus',
        threadId: 'thr-source',
        msg: { id: 'msg-user-1', from: 'user', meta: {} },
      },
      threadId: 'thr-source',
    });

    const output = await routeForwardTool.execute(
      { to: 'vp-martin', text: 'please review this PR', reason: 'review' },
      queryOpts,
    );

    expect(JSON.parse(output)).toMatchObject({ ok: true, dispatched: ['vp-martin'] });
    expect(stored[0].meta.sourceThreadId).toBe('thr-source');
  });

  it('preserves route_forward internal provenance when rescuing pending queries', () => {
    const envelope = __testHooks.buildPendingRescueEnvelope({
      sessionId: 'session-route-thread',
      taskId: null,
      threadId: 'thr-target',
      followUpId: 'followup-route-forward',
      replayText: '@vp-martin please review this PR',
      replayParts: null,
      leftover: {
        internal: true,
        injectedBy: 'route_forward',
        senderVpId: 'vp-linus',
        sourceThreadId: 'thr-source',
      },
    });

    expect(envelope).toMatchObject({
      sessionId: 'session-route-thread',
      trigger: 'pending_rescue',
      msg: {
        id: 'followup-route-forward',
        from: 'vp-linus',
        role: 'assistant',
        text: '@vp-martin please review this PR',
        meta: {
          rescuedFrom: 'pendingQueries',
          threadId: 'thr-target',
          injectedBy: 'route_forward',
          senderVpId: 'vp-linus',
          sourceThreadId: 'thr-source',
        },
      },
    });
  });

  function createStreamSessionFixture(roster = ['vp-linus', 'vp-martin']) {
    const root = mkdtempSync(join(tmpdir(), 'yeaft-stream-session-'));
    const sessionId = `session_stream_${Math.random().toString(36).slice(2)}`;
    const sessionDir = join(root, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: sessionId,
      name: 'stream-json routing fixture',
      roster,
      defaultVpId: roster[0] || null,
      announcement: '',
      workDir: '',
      createdAt: new Date().toISOString(),
    }));
    const rows = [];
    const calls = [];
    const runner = createCliSessionRunner({
      loaded: {
        yeaftDir: root,
        config: {},
        conversationStore: {
          append: row => { rows.push(row); return row; },
          loadSessionHistoryForVp: () => rows.slice(),
        },
      },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          calls.push({ vpId, options });
          yield { type: 'turn_open', turnId: `turn-${vpId}`, threadId: 'main', vpId };
          yield { type: 'turn_end', stopReason: 'end_turn', terminal: true, threadId: 'main' };
          yield { type: 'turn_close', turnId: `turn-${vpId}`, threadId: 'main' };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });
    return {
      root,
      sessionId,
      sessionMetaPath: join(sessionDir, 'session.json'),
      rows,
      calls,
      runner,
      async close() {
        await runner.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it('returns a terminal stream-json error when a formal Session dispatches no VP', async () => {
    const fixture = createStreamSessionFixture([]);
    try {
      const write = vi.fn();
      const result = await runStreamSessionTurn({
        runner: fixture.runner,
        prompt: 'there is no Session member to run this turn',
        sessionId: fixture.sessionId,
        write,
      });

      expect(result).toMatchObject({
        subtype: 'error',
        stop_reason: 'error',
        is_error: true,
        dispatched_vp_ids: [],
      });
      expect(result.error).toContain('no_default_vp');
      expect(write.mock.calls.map(([event]) => event.type)).toEqual(['error', 'result']);
      expect(fixture.calls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it('dispatches every structured target VP without rewriting the user prompt', async () => {
    const fixture = createStreamSessionFixture();
    try {
      const sessionMetaBefore = readFileSync(fixture.sessionMetaPath, 'utf8');
      const result = await runStreamSessionTurn({
        runner: fixture.runner,
        prompt: 'plain prompt without mentions',
        sessionId: fixture.sessionId,
        write: vi.fn(),
        routingIntent: normalizeStreamRoutingIntent({
          targetVps: ['vp-linus', 'vp-martin'],
        }),
      });

      expect(result).toMatchObject({
        subtype: 'success',
        is_error: false,
        dispatched_vp_ids: ['vp-linus', 'vp-martin'],
      });
      expect(fixture.calls.map(call => call.vpId).sort()).toEqual(['vp-linus', 'vp-martin']);
      expect(fixture.calls.every(call => call.options.prompt === 'plain prompt without mentions')).toBe(true);
      expect(readFileSync(fixture.sessionMetaPath, 'utf8')).toBe(sessionMetaBefore);
    } finally {
      await fixture.close();
    }
  });

  it('keeps formal Session membership immutable and rejects non-member stream targets', async () => {
    const fixture = createStreamSessionFixture();
    try {
      const sessionMetaBefore = readFileSync(fixture.sessionMetaPath, 'utf8');
      await runStreamSessionTurn({
        runner: fixture.runner,
        prompt: 'capture the canonical router',
        sessionId: fixture.sessionId,
        write: vi.fn(),
        routingIntent: normalizeStreamRoutingIntent({ targetVpId: 'vp-linus' }),
      });
      const rowCountBeforeRejectedTurn = fixture.rows.length;
      const write = vi.fn();
      const result = await runStreamSessionTurn({
        runner: fixture.runner,
        prompt: 'do not expand membership',
        sessionId: fixture.sessionId,
        write,
        routingIntent: normalizeStreamRoutingIntent({
          targetVpId: 'intruder',
          roster: ['intruder'],
          vps: ['intruder'],
          defaultVpId: 'intruder',
        }),
      });

      expect(result).toMatchObject({
        subtype: 'error',
        stop_reason: 'error',
        is_error: true,
        dispatched_vp_ids: [],
      });
      expect(result.error).toContain('not in roster');
      expect(fixture.rows).toHaveLength(rowCountBeforeRejectedTurn);
      expect(readFileSync(fixture.sessionMetaPath, 'utf8')).toBe(sessionMetaBefore);

      const nonMemberForward = fixture.calls[0].options.router.forward({
        from: 'vp-linus',
        to: 'intruder',
        text: 'attempt to bypass the canonical roster',
        inboundEnvelope: fixture.calls[0].options.inboundEnvelope,
      });
      expect(nonMemberForward).toMatchObject({ ok: false, error: 'target_not_in_roster' });
      expect(readFileSync(fixture.sessionMetaPath, 'utf8')).toBe(sessionMetaBefore);
    } finally {
      await fixture.close();
    }
  });

  it('keeps explicit user @mentions visible and preserves CLI Session routing boundaries', async () => {
    const envelope = __testHooks.buildPendingRescueEnvelope({
      sessionId: 'session-route-thread',
      taskId: null,
      threadId: 'thr-target',
      followUpId: 'followup-user-mention',
      replayText: '@vp-martin please review this PR',
      replayParts: null,
      leftover: {
        internal: false,
      },
    });

    expect(envelope).toMatchObject({
      sessionId: 'session-route-thread',
      trigger: 'pending_rescue',
      msg: {
        id: 'followup-user-mention',
        from: 'user',
        role: 'user',
        text: '@vp-martin please review this PR',
        meta: {
          rescuedFrom: 'pendingQueries',
          threadId: 'thr-target',
        },
      },
    });
    expect(envelope.msg.meta.injectedBy).toBeUndefined();
    expect(envelope.msg.meta.senderVpId).toBeUndefined();
    expect(envelope.msg.meta.sourceThreadId).toBeUndefined();

  {
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const root = mkdtempSync(join(tmpdir(), 'yeaft-cli-session-'));
    const sessionId = 'session_cli_fanout';
    const sessionDir = join(root, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: sessionId,
      name: 'CLI fan-out',
      roster: ['vp-linus', 'vp-martin'],
      defaultVpId: 'vp-linus',
      announcement: '',
      workDir: '',
      createdAt: new Date().toISOString(),
    }));
    const rows = [];
    const conversationStore = {
      append: vi.fn(row => { rows.push(row); return row; }),
      loadSessionHistoryForVp: vi.fn(() => rows.slice()),
    };
    const starts = [];
    const engineOptions = [];
    const managedCliReady = Promise.resolve([{ name: 'rg', status: 'available' }]);
    const firstLinus = deferred();
    const firstMartin = deferred();
    let linusCalls = 0;
    const toolRegistry = new ToolRegistry();
    let receivedManagedCliReady = null;
    let receivedTurnId = null;
    toolRegistry.register({
      name: 'probe_managed_cli',
      description: 'probe managed CLI context',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        receivedManagedCliReady = ctx.managedCliReady;
        receivedTurnId = ctx.turnId;
        return 'ready';
      },
    });
    let adapterCalls = 0;
    const adapter = {
      async *stream() {
        if (adapterCalls++ === 0) {
          yield { type: 'tool_call', id: 'probe-1', name: 'probe_managed_cli', input: {} };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
      async call() { return { text: '', usage: {} }; },
    };
    const productionEngine = createCliVpEngine({
      yeaftDir: root,
      config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true },
      adapter,
      trace: new NullTrace(),
      toolRegistry,
      managedCliReady,
    }, sessionId, 'vp-proof');
    for await (const _event of productionEngine.query({
      prompt: 'probe',
      sessionId,
      workDir: root,
      vpTurnId: 'turn-proof',
      userAlreadyPersisted: true,
    })) {}
    expect(receivedManagedCliReady).toBe(managedCliReady);
    expect(receivedTurnId).toBe('turn-proof');

    const engineFactory = vi.fn((_loaded, _sessionId, vpId) => {
      engineOptions.push({ vpId, managedCliReady: _loaded.managedCliReady });
      return {
        async *query(options) {
          starts.push({ vpId, options });
          if (vpId === 'vp-linus' && linusCalls++ === 0) await firstLinus.promise;
          if (vpId === 'vp-martin') await firstMartin.promise;
          yield { type: 'text_delta', text: vpId };
        },
        abort: () => true,
      };
    });
    const runner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore, managedCliReady },
      sessionId,
      engineFactory,
      personaFactory: vpId => ({ vpId }),
    });

    const broadcast = runner.run('@all inspect this');
    await vi.waitFor(() => {
      expect(starts.map(item => item.vpId).sort()).toEqual(['vp-linus', 'vp-martin']);
    });
    expect(conversationStore.append).toHaveBeenCalledTimes(1);
    expect(starts.every(item => item.options.userAlreadyPersisted === true)).toBe(true);
    expect(engineOptions).toHaveLength(2);
    expect(engineOptions.every(item => item.managedCliReady === managedCliReady)).toBe(true);
    expect(engineFactory.mock.calls.every(([loaded]) => loaded.managedCliReady === managedCliReady)).toBe(true);

    const secondLinusTurn = runner.run('@vp-linus follow up');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(starts.filter(item => item.vpId === 'vp-linus')).toHaveLength(1);

    firstLinus.resolve();
    firstMartin.resolve();
    const [broadcastResult, secondResult] = await Promise.all([broadcast, secondLinusTurn]);
    expect(broadcastResult.report.dispatched.sort()).toEqual(['vp-linus', 'vp-martin']);
    expect(secondResult.report.dispatched).toEqual(['vp-linus']);
    expect(conversationStore.append).toHaveBeenCalledTimes(2);

    const error = new Error('CLI Session Engine failed');
    const errorEvents = [];
    const errorRunner = createCliSessionRunner({
      loaded: { yeaftDir: root, config: {}, conversationStore, managedCliReady },
      sessionId,
      engineFactory: () => ({
        async *query() {
          yield { type: 'error', error, retryable: false };
          yield { type: 'turn_end', stopReason: 'error', terminal: true };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });
    const errorOutcome = await errorRunner.run('@vp-linus fail', {
      onEvent: ({ event }) => errorEvents.push(event),
    });
    expect(errorEvents).toContainEqual(expect.objectContaining({ type: 'turn_end', terminal: true }));
    expect(errorOutcome.results).toEqual([
      expect.objectContaining({ vpId: 'vp-linus', error }),
    ]);
    await errorRunner.close();

    await runner.close();
  }

  {
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const root = mkdtempSync(join(tmpdir(), 'yeaft-cli-context-'));
    const sessionId = 'session_cli_context';
    const sessionDir = join(root, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      id: sessionId,
      name: 'CLI turn context',
      roster: ['linus', 'martin'],
      defaultVpId: 'linus',
      announcement: '',
      workDir: '',
      createdAt: new Date().toISOString(),
    }));
    const rows = [];
    const firstGate = deferred();
    let linusCalls = 0;
    let martinCalls = 0;
    const runner = createCliSessionRunner({
      loaded: {
        yeaftDir: root,
        config: {},
        conversationStore: {
          append: row => { rows.push(row); return row; },
          loadSessionHistoryForVp: () => rows.slice(),
        },
      },
      sessionId,
      engineFactory: (_loaded, _sessionId, vpId) => ({
        async *query(options) {
          if (vpId === 'linus' && linusCalls++ === 0) {
            await firstGate.promise;
            yield { type: 'text_delta', text: 'linus-first' };
            options.router.forward({
              from: 'linus',
              to: 'martin',
              text: 'review first',
              inboundEnvelope: options.inboundEnvelope,
            });
            return;
          }
          if (vpId === 'martin' && martinCalls++ === 0) {
            yield { type: 'text_delta', text: 'martin-second' };
            return;
          }
          yield { type: 'text_delta', text: 'martin-forwarded' };
        },
        abort: () => true,
      }),
      personaFactory: vpId => ({ vpId }),
    });
    const firstEvents = [];
    const secondEvents = [];
    const first = runner.run('@linus first', {
      onEvent: ({ vpId, event }) => firstEvents.push(`${vpId}:${event.text || event.type}`),
    });
    await vi.waitFor(() => expect(linusCalls).toBe(1));
    const second = runner.run('@martin second', {
      onEvent: ({ vpId, event }) => secondEvents.push(`${vpId}:${event.text || event.type}`),
    });
    await vi.waitFor(() => expect(secondEvents).toContain('martin:martin-second'));
    firstGate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstEvents).toEqual([
      'linus:linus-first',
      'martin:martin-forwarded',
      'linus:martin-forwarded',
    ]);
    expect(secondEvents).toEqual(['martin:martin-second']);
    expect(firstResult.results.map(item => item.vpId)).toEqual(['linus', 'martin', 'linus']);
    expect(secondResult.results.map(item => item.vpId)).toEqual(['martin']);
    await runner.close();
  }

  {
    const fakeRunner = eventsByVp => ({
      async run(_prompt, options) {
        for (const [vpId, events] of Object.entries(eventsByVp)) {
          for (const event of events) await options.onEvent({ vpId, event });
        }
        return { report: { dispatched: Object.keys(eventsByVp) }, results: [] };
      },
    });
    const invoke = eventsByVp => runStreamSessionTurn({
      runner: fakeRunner(eventsByVp),
      prompt: 'inspect',
      sessionId: 'session-stdio',
      write: vi.fn(),
    });

    const aborted = await invoke({
      linus: [
        { type: 'turn_open', turnId: 'turn-linus' },
        { type: 'turn_end', stopReason: 'aborted' },
      ],
    });
    expect(aborted).toMatchObject({ subtype: 'success', stop_reason: 'aborted', is_error: false });
    expect(aborted.vp_results).toEqual([
      expect.objectContaining({ vp_id: 'linus', turn_id: 'turn-linus', stop_reason: 'aborted' }),
    ]);

    const mixed = await invoke({
      linus: [{ type: 'turn_end', stopReason: 'end_turn' }],
      martin: [{ type: 'turn_end', stopReason: 'aborted' }],
    });
    expect(mixed).toMatchObject({ subtype: 'success', stop_reason: 'end_turn', is_error: false });
    expect(mixed.vp_results.map(item => item.stop_reason)).toEqual(['end_turn', 'aborted']);

    const errored = await invoke({
      linus: [{ type: 'turn_end', stopReason: 'error' }],
      martin: [{ type: 'turn_end', stopReason: 'aborted' }],
    });
    expect(errored).toMatchObject({ subtype: 'error', stop_reason: 'error', is_error: true });

    const write = vi.fn();
    const input = { waitForAnswer: vi.fn(async () => ({ answer: 'yes' })) };
    await runStreamSessionTurn({
      runner: {
        async run(_prompt, options) {
          await options.askUser(
            { question: 'Proceed?', options: ['yes', 'no'] },
            'martin',
            'turn-martin',
          );
          return { report: { dispatched: ['martin'] }, results: [] };
        },
      },
      prompt: 'ask',
      sessionId: 'session-stdio',
      input,
      write,
    });
    const askEvents = write.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === 'ask_user');
    expect(askEvents).toEqual([
      expect.objectContaining({ subtype: 'request', vp_id: 'martin', turn_id: 'turn-martin' }),
      expect.objectContaining({ subtype: 'response', vp_id: 'martin', turn_id: 'turn-martin' }),
    ]);
  }
  });
});