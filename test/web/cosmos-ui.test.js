// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readUiMode,
  writeUiMode,
  sendYeaftAutoRouteMessage,
  handleYeaftSessionRouted,
  handleYeaftAutoRouteError,
  clearPendingAutoRoutes,
} from '../../web/stores/helpers/yeaft-auto-route.js';
import {
  loadCosmosConstants,
  saveCosmosConstants,
  resolvePlanetAssignments,
  moveOrSwapPlanetBinding,
  scaleBand,
} from '../../web/cosmos/constants.js';
import {
  COSMIC_EVENTS,
  MIN_EVENT_INTERVAL_SEC,
  MAX_EVENT_INTERVAL_SEC,
  createCosmicEventState,
  startCosmicEvent,
  stopCosmicEvent,
  tickCosmicEvents,
  pickRandomEventIndex,
} from '../../web/cosmos/events-controller.js';
import { projectAgentsForCosmos } from '../../web/cosmos/agent-projection.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

describe('Cosmos UI Mode & Auto-Route Store Helper', () => {
  it('defaults to cosmos mode and persists classic/cosmos switches', () => {
    const storage = createMemoryStorage();
    expect(readUiMode(storage)).toBe('cosmos');
    expect(writeUiMode('classic', storage)).toBe('classic');
    expect(readUiMode(storage)).toBe('classic');
    expect(writeUiMode('cosmos', storage)).toBe('cosmos');
    expect(readUiMode(storage)).toBe('cosmos');
  });

  it('sends yeaft_auto_route_send with sanitized attachments, quickSend, and resolves on yeaft_session_routed', async () => {
    const sentFrames = [];
    const store = {
      agents: [{ id: 'ag-1', online: true, capabilities: ['session_auto_route'] }],
      llmConfig: {},
      yeaftAvailableModels: [],
      yeaftProcessingSessions: {},
      sendWsMessage: vi.fn((frame) => {
        sentFrames.push(frame);
        return true;
      }),
    };

    const promise = sendYeaftAutoRouteMessage(store, {
      agentId: 'ag-1',
      text: 'Inspect Cosmos shader perf',
      attachments: [
        { fileId: 'f-1', isImage: true, previewUrl: 'blob:ignored', name: 'shot.png' },
        { fileId: '' },
      ],
      preferredSceneId: 'auto',
      quickSend: { model: 'copilot/gpt-6.2-sol', effort: 'high' },
    });

    expect(sentFrames).toHaveLength(1);
    const frame = sentFrames[0];
    expect(frame.type).toBe('yeaft_auto_route_send');
    expect(frame.agentId).toBe('ag-1');
    expect(frame.attachments).toEqual([{ fileId: 'f-1', isImage: true }]);
    expect(frame.preferredSceneId).toBeUndefined();
    expect(frame.quickSend).toEqual({ model: 'copilot/gpt-6.2-sol', effort: 'high' });

    const handled = handleYeaftSessionRouted(store, {
      ok: true,
      agentId: 'ag-1',
      requestId: frame.requestId,
      clientMessageId: frame.id,
      sessionId: 'sess-42',
      decision: 'created',
      title: 'Cosmos Shader Perf',
    });
    expect(handled).toBe(true);

    const res = await promise;
    expect(res.ok).toBe(true);
    expect(res.sessionId).toBe('sess-42');
    expect(res.decision).toBe('created');
    expect(store.yeaftProcessingSessions['ag-1\u001fsess-42']).toBe(true);
  });

  it('does not mark processing when auto-route directly answered an AskUser prompt', async () => {
    const sentFrames = [];
    const store = {
      agents: [{ id: 'ag-1', online: true, capabilities: ['session_auto_route'] }],
      yeaftProcessingSessions: {},
      sendWsMessage: (f) => { sentFrames.push(f); return true; },
    };

    const promise = sendYeaftAutoRouteMessage(store, { agentId: 'ag-1', text: 'Yes, deploy now' });
    handleYeaftSessionRouted(store, {
      ok: true,
      agentId: 'ag-1',
      requestId: sentFrames[0].requestId,
      sessionId: 'sess-ask',
      decision: 'matched',
      answeredAskUser: true,
    });

    const res = await promise;
    expect(res.ok).toBe(true);
    expect(res.answeredAskUser).toBe(true);
    expect(store.yeaftProcessingSessions['ag-1\u001fsess-ask']).toBeUndefined();
  });

  it('rejects unsupported or offline agents cleanly and handles server error frames + logout cleanup', async () => {
    const store = {
      agents: [
        { id: 'ag-old', online: true, capabilities: ['work_center'] },
        { id: 'ag-off', online: false, capabilities: ['session_auto_route'] },
        { id: 'ag-ok', online: true, capabilities: ['session_auto_route'] },
      ],
      sendWsMessage: vi.fn(() => true),
    };

    const resOld = await sendYeaftAutoRouteMessage(store, { agentId: 'ag-old', text: 'hi' });
    expect(resOld.ok).toBe(false);
    expect(resOld.code).toBe('session_auto_route_unsupported');

    const resOff = await sendYeaftAutoRouteMessage(store, { agentId: 'ag-off', text: 'hi' });
    expect(resOff.ok).toBe(false);
    expect(resOff.code).toBe('agent_unavailable');

    const pErr = sendYeaftAutoRouteMessage(store, { agentId: 'ag-ok', text: 'attach test' });
    const req = store.sendWsMessage.mock.calls[0][0];
    expect(handleYeaftAutoRouteError(store, {
      requestId: req.requestId,
      code: 'invalid_attachment',
      message: 'Attachment expired',
    })).toBe(true);
    const errRes = await pErr;
    expect(errRes.ok).toBe(false);
    expect(errRes.code).toBe('invalid_attachment');

    const pCancel = sendYeaftAutoRouteMessage(store, { agentId: 'ag-ok', text: 'pending on logout' });
    clearPendingAutoRoutes(store, 'logout');
    const cancelRes = await pCancel;
    expect(cancelRes.ok).toBe(false);
    expect(cancelRes.code).toBe('logout');
  });
});

describe('Cosmos Planet Assignments & Constants Persistence', () => {
  it('allocates agents deterministically, moves to empty planets, and swaps occupied orbits', () => {
    const agents = [
      { id: 'mac', name: 'MacBook', online: true },
      { id: 'cloud', name: 'Cloud', online: true },
      { id: 'ci', name: 'CI', online: false },
    ];

    const initial = resolvePlanetAssignments(agents, {});
    expect(initial.agentToPlanet.cloud).toBe('earth');
    expect(initial.agentToPlanet.mac).toBe('saturn');
    expect(initial.agentToPlanet.ci).toBe('jupiter');

    // Move mac to empty mars
    const moved = moveOrSwapPlanetBinding(agents, initial.agentToPlanet, 'mac', 'mars');
    expect(moved.changed).toBe(true);
    expect(moved.swappedWith).toBeNull();
    expect(moved.bindings.mac).toBe('mars');
    expect(moved.bindings.cloud).toBe('earth');

    // Swap mac (mars) with cloud (earth)
    const swapped = moveOrSwapPlanetBinding(agents, moved.bindings, 'mac', 'earth');
    expect(swapped.changed).toBe(true);
    expect(swapped.swappedWith).toBe('cloud');
    expect(swapped.bindings.mac).toBe('earth');
    expect(swapped.bindings.cloud).toBe('mars');
  });

  it('persists and clamps cosmic constants including active flash, preview mode & auto events', () => {
    const storage = createMemoryStorage();
    saveCosmosConstants({
      orbitSpeed: 99,
      starDensity: 0.1,
      activeFlash: false,
      livePreviewMode: '3',
      eventsAutoEnabled: false,
    }, storage);

    const loaded = loadCosmosConstants(storage);
    expect(loaded.orbitSpeed).toBe(2.5);
    expect(loaded.starDensity).toBe(0.35);
    expect(loaded.activeFlash).toBe(false);
    expect(loaded.livePreviewMode).toBe('3');
    expect(loaded.eventsAutoEnabled).toBe(false);

    expect(scaleBand(24)).toBe('web');
    expect(scaleBand(21)).toBe('galaxy');
    expect(scaleBand(13)).toBe('solar');
    expect(scaleBand(7)).toBe('horizon');
  });
});

describe('Cosmos Random-Interval Event Scheduler & Stop Control', () => {
  it('picks random non-repeating events, finishes single-shot into cooldown, and stops immediately on demand', () => {
    const fixedValues = [0.2, 0.5, 0.2, 0.8, 0.4, 0.9, 0.1];
    let i = 0;
    const rng = () => fixedValues[i++ % fixedValues.length];

    for (let k = 0; k < COSMIC_EVENTS.length; k++) {
      expect(pickRandomEventIndex(k, () => k / COSMIC_EVENTS.length)).not.toBe(k);
    }

    const sim = createCosmicEventState({ autoEnabled: true, rng });
    expect(sim.active).toBeNull();

    // Observe an event explicitly
    const act = startCosmicEvent(sim, 'supernova', { observe: true, rng });
    expect(act.def.id).toBe('supernova');
    expect(act.observing).toBe(true);

    // Tick past full duration -> single-shot completes cleanly (never loops infinitely)
    tickCosmicEvents(sim, act.duration + 1, { showCountdown: true, autoEnabled: true, rng });
    expect(sim.active).toBeNull();
    expect(sim.countdown).toBeGreaterThanOrEqual(MIN_EVENT_INTERVAL_SEC);
    expect(sim.countdown).toBeLessThanOrEqual(MAX_EVENT_INTERVAL_SEC);

    // Start again and stop immediately via stop button
    startCosmicEvent(sim, 'blackhole-birth', { observe: true, rng });
    expect(sim.active?.def.id).toBe('blackhole-birth');
    expect(stopCosmicEvent(sim, { rng })).toBe(true);
    expect(sim.active).toBeNull();

    // When autoEnabled is false, ticking down never triggers a new event
    sim.countdown = 1;
    tickCosmicEvents(sim, 10, { showCountdown: true, autoEnabled: false, rng });
    expect(sim.active).toBeNull();
    expect(sim.countdown).toBe(1);
  });
});

describe('Cosmos Real Agent & Session Projection', () => {
  let now;
  beforeEach(() => { now = Date.now(); });

  it('projects waiting AskUser, running, idle and offline states with clean markdown-free snippets', () => {
    const chatStore = {
      agents: [
        { id: 'mac', name: 'MacBook-Pro', online: true, workDir: '/Users/dev/yeaft', capabilities: ['session_auto_route'] },
        { id: 'ci', name: 'Runner', online: false, workDir: '/opt/ci', capabilities: [] },
      ],
      sessionCatalog: [
        {
          catalogKey: 'yeaft:mac:s-ask',
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-ask' },
          title: 'Release Guard',
          workDir: '/Users/dev/yeaft',
          metadataUpdatedAt: new Date(now - 30000).toISOString(),
        },
        {
          catalogKey: 'yeaft:mac:s-run',
          runtimeProvider: 'yeaft',
          routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-run' },
          title: 'Shader Tuning',
          workDir: '/Users/dev/yeaft',
          metadataUpdatedAt: new Date(now - 10000).toISOString(),
        },
      ],
      yeaftConversationIdsByAgent: { mac: 'yeaft_conv_mac' },
      messagesMap: {
        yeaft_conv_mac: [
          {
            type: 'assistant',
            sessionId: 's-run',
            content: 'Adjusted **procedural Earth** shader & `saturn_ring` shadow.',
            timestamp: now - 5000,
          },
          {
            type: 'tool-use',
            sessionId: 's-ask',
            toolName: 'AskUser',
            askAnswered: false,
            toolInput: { questions: [{ question: 'Deploy `v1.0.788` now?' }] },
          },
        ],
      },
      isYeaftSessionProcessing: (sid) => sid === 's-run',
      isYeaftSessionUnread: () => false,
    };

    const projected = projectAgentsForCosmos({ chatStore, sessionsStore: { sessionList: [] }, nowMs: now, isEn: true });
    expect(projected.mac.status).toBe('waiting');
    expect(projected.mac.liveSessions).toHaveLength(2);
    expect(projected.mac.sessions[0].id).toBe('s-ask');
    expect(projected.mac.sessions[0].status).toBe('waiting');
    expect(projected.mac.sessions[0].summary).toContain('Deploy v1.0.788 now?');
    expect(projected.mac.sessions[1].id).toBe('s-run');
    expect(projected.mac.sessions[1].summary).toContain('Adjusted procedural Earth shader');
    expect(projected.ci.status).toBe('offline');
  });
});
