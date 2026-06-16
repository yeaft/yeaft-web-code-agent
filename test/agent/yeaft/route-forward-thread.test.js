import { afterEach, describe, expect, it } from 'vitest';
import { createCoordinator } from '../../../agent/yeaft/sessions/coordinator.js';
import { createRouter } from '../../../agent/yeaft/routing/router.js';
import routeForwardTool from '../../../agent/yeaft/tools/route-forward.js';
import {
  __testEnqueueForVp,
  __testGetVpThreads,
  __testSeedVpThread,
  __testSetSession,
  __testSetThreadClassifier,
  __testWaitForRoutePromises,
  buildVpQueryOpts,
  visibleInboundThreadId,
} from '../../../agent/yeaft/web-bridge.js';

describe('route_forward thread ownership', () => {
  afterEach(() => {
    __testSetSession(null);
    __testSetThreadClassifier(null);
  });

  function makeCoordinator() {
    const stored = [];
    const delivered = [];
    const group = {
      getMeta() {
        return {
          id: 'session-route-thread',
          roster: ['vp-linus', 'vp-martin'],
          defaultVpId: 'vp-linus',
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
});
