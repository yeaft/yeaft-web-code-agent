// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as Vue from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import {
  readUiMode,
  writeUiMode,
  sendYeaftAutoRouteMessage,
  handleYeaftSessionRouted,
  handleYeaftAutoRouteError,
  clearPendingAutoRoutes,
} from '../../web/stores/helpers/yeaft-auto-route.js';
import {
  PLANETS,
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
  EVENT_DISTANT_MIN_SCALE,
  EVENT_DISTANT_MAX_SCALE,
  createCosmicEventState,
  startCosmicEvent,
  focusActiveCosmicEvent,
  unfocusCosmicEvent,
  stopCosmicEvent,
  tickCosmicEvents,
  scrubCosmicEvent,
  pickRandomEventIndex,
  pickRandomDistantLocation,
  getEventScreenPosition,
  computeEventFrame,
  getEventLens,
  getEventAmbient,
  getEventShockWave,
  getSolarTelescopeTransform,
  formatEventDistance,
  formatEventPhysicalDistance,
} from '../../web/cosmos/events-controller.js';
import {
  projectAgentsForCosmos,
  buildCosmosProjectSessionTree,
  filterCosmosSessions,
} from '../../web/cosmos/agent-projection.js';
import { acceptSessionDiscoveryResponse } from '../../web/stores/helpers/session-discovery.js';
import { sidebarSessionCatalogRows } from '../../web/stores/helpers/sidebar-session-catalog.js';
import { clampFixedMenuCoordinates } from '../../web/utils/fixed-menu-position.js';
import { bakeProceduralWebGLTextures } from '../../web/cosmos/gpu-texture-baker.js';
import { createCosmosEngine } from '../../web/cosmos/gl-engine.js';
import { computeSolarProjectionLayout } from '../../web/cosmos/stage-loop.js';
import {
  COSMOS_TEXTURE_MANIFEST,
  requestCosmosTextureGroup,
  uploadImageToWebGLTexture,
  getLoadedCosmosImage,
  __resetCosmosTextureCacheForTests,
} from '../../web/cosmos/texture-loader.js';

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
      cosmosDelivery: true,
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
    expect(frame.cosmosDelivery).toBe(true);
    expect(frame).not.toHaveProperty('_knowledgeSessionIds');
    expect(frame.attachments).toEqual([{ fileId: 'f-1', isImage: true }]);
    expect(frame.preferredSceneId).toBeUndefined();
    expect(frame.quickSend).toEqual({ model: 'copilot/gpt-6.2-sol', effort: 'high', maxOutputTokens: null });

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

    const pRejected = sendYeaftAutoRouteMessage(store, { agentId: 'ag-ok', text: 'Follow up' });
    handleYeaftSessionRouted(store, { ok: false, requestId: store.sendWsMessage.mock.lastCall[0].requestId,
      code: 'invalid_quick_send', error: 'Invalid model' });
    expect(await pRejected).toMatchObject({ ok: false, code: 'invalid_quick_send' });

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
    // Default autoZoom is false so spontaneous random events emerge gently in distant space
    expect(loadCosmosConstants(storage).eventsAutoZoom).toBe(false);
    saveCosmosConstants({
      orbitSpeed: 99,
      starDensity: 0.1,
      activeFlash: false,
      livePreviewMode: '3',
      eventsAutoEnabled: false,
      eventsAutoZoom: true,
    }, storage);

    const loaded = loadCosmosConstants(storage);
    expect(loaded.orbitSpeed).toBe(2.5);
    expect(loaded.starDensity).toBe(0.35);
    expect(loaded.activeFlash).toBe(false);
    expect(loaded.livePreviewMode).toBe('3');
    expect(loaded.eventsAutoEnabled).toBe(false);
    expect(loaded.eventsAutoZoom).toBe(true);

    saveCosmosConstants({ eventsAutoZoom: false }, storage);
    expect(loadCosmosConstants(storage).eventsAutoZoom).toBe(false);

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

  it('spawns events at peripheral 3D deep-sky coordinates, slews in on observe, returns to Solar System after completion, and respects autoZoom off', () => {
    // 1. Peripheral coordinates never overlap the central Solar System center (0.5, 0.5)
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const seenSectors = new Set();
    let prevSector = null;
    for (let i = 0; i < 40; i++) {
      const loc = pickRandomDistantLocation(prevSector, rng);
      expect(loc.sector).not.toBe(prevSector);
      seenSectors.add(loc.sector);
      const radialDist = Math.hypot(loc.x - 0.5, loc.y - 0.5);
      expect(radialDist).toBeGreaterThanOrEqual(0.28);
      expect(loc.distantScale).toBeGreaterThanOrEqual(EVENT_DISTANT_MIN_SCALE);
      expect(loc.distantScale).toBeLessThanOrEqual(EVENT_DISTANT_MAX_SCALE);
      expect(loc.distanceLy).toBeGreaterThanOrEqual(160);
      prevSector = loc.sector;
    }
    expect(seenSectors.size).toBeGreaterThanOrEqual(6);
    expect(formatEventDistance(420, false)).toBe('420 光年');
    expect(formatEventDistance(2400, true)).toBe('2.4k ly');

    // 2. When autoZoom is OFF, scheduled trigger unfolds in place at distant scale (no camera hijack)
    const simOff = createCosmicEventState({ autoEnabled: true, autoZoom: false, rng });
    simOff.countdown = 0.5;
    tickCosmicEvents(simOff, 1.0, { showCountdown: true, autoEnabled: true, autoZoom: false, rng });
    expect(simOff.active).not.toBeNull();
    expect(simOff.active.observing).toBe(false);
    expect(simOff.focusProgress).toBe(0);
    const distantPos = getEventScreenPosition(simOff, 1440, 900, 0);
    expect(distantPos.isDistant).toBe(true);
    expect(distantPos.scale).toBeCloseTo(simOff.active.location.distantScale, 3);
    expect(getSolarTelescopeTransform(simOff, 1440, 900).active).toBe(false);

    // Clicking the distant beacon focuses in -> camera slews to center and Solar System recedes
    focusActiveCosmicEvent(simOff);
    expect(simOff.active.observing).toBe(true);
    for (let f = 0; f < 40; f++) {
      tickCosmicEvents(simOff, 0.05, { showCountdown: true, autoEnabled: true, autoZoom: false, rng });
    }
    expect(simOff.focusProgress).toBeGreaterThan(0.92);
    const focusedPos = getEventScreenPosition(simOff, 1440, 900, 0);
    expect(focusedPos.isDistant).toBe(false);
    expect(Math.abs(focusedPos.x - 720)).toBeLessThan(20);
    expect(Math.abs(focusedPos.y - 450)).toBeLessThan(20);
    expect(focusedPos.scale).toBeGreaterThan(1.2);
    const zoomedSolar = getSolarTelescopeTransform(simOff, 1440, 900);
    expect(zoomedSolar.active).toBe(true);
    expect(zoomedSolar.alphaMul).toBeLessThan(0.1);

    // Unfocusing keeps the distant event playing while camera glides smoothly back to Solar System
    expect(unfocusCosmicEvent(simOff)).toBe(true);
    expect(simOff.active).not.toBeNull();
    expect(simOff.active.observing).toBe(false);
    for (let f = 0; f < 60; f++) {
      tickCosmicEvents(simOff, 0.05, { showCountdown: true, autoEnabled: true, autoZoom: false, rng });
    }
    expect(simOff.focusProgress).toBeLessThan(0.05);
    expect(Math.abs(simOff.camYawOffset)).toBeLessThan(0.05);

    // 3. When autoZoom is ON, scheduled trigger slews in automatically and returns automatically on finish
    const simOn = createCosmicEventState({ autoEnabled: true, autoZoom: true, rng });
    simOn.countdown = 0.5;
    tickCosmicEvents(simOn, 1.0, { showCountdown: true, autoEnabled: true, autoZoom: true, canAutoZoom: true, rng });
    expect(simOn.active?.observing).toBe(true);
    for (let f = 0; f < 25; f++) {
      tickCosmicEvents(simOn, 0.05, { showCountdown: true, autoEnabled: true, autoZoom: true, rng });
    }
    expect(simOn.focusProgress).toBeGreaterThan(0.85);
    // Advance past end of event -> active clears and camera smoothly returns to Solar System
    tickCosmicEvents(simOn, simOn.active.duration + 1, { showCountdown: true, autoEnabled: true, autoZoom: true, rng });
    expect(simOn.active).toBeNull();
    for (let f = 0; f < 80; f++) {
      tickCosmicEvents(simOn, 0.05, { showCountdown: true, autoEnabled: true, autoZoom: true, rng });
    }
    expect(simOn.focusProgress).toBe(0);
    expect(getSolarTelescopeTransform(simOn, 1440, 900).active).toBe(false);

    // 4. When user has drawer/quick composer open (canAutoZoom=false), even with autoZoom ON do not hijack camera
    const simBusy = createCosmicEventState({ autoEnabled: true, autoZoom: true, rng });
    simBusy.countdown = 0.5;
    tickCosmicEvents(simBusy, 1.0, { showCountdown: true, autoEnabled: true, autoZoom: true, canAutoZoom: false, rng });
    expect(simBusy.active).not.toBeNull();
    expect(simBusy.active.observing).toBe(false);

    // 5. Portal avoidance keeps distant event & beacon clear of corner portals, and shockwave respects visibilityAlpha
    const simPortal = createCosmicEventState({ autoEnabled: true, autoZoom: false, rng });
    startCosmicEvent(simPortal, 'supernova', { observe: false, rng });
    simPortal.active.location = { sector: 'nw', x: 0.14, y: 0.16, depth: 0.5, distantScale: 0.32, yaw: 0.34, pitch: -0.22, distanceLy: 1200 };
    simPortal.active.elapsed = simPortal.active.duration * 0.45;
    const portalPt = { x: 0.14 * 1440, y: 0.16 * 900 };
    const nudged = getEventScreenPosition(simPortal, 1440, 900, 0, [portalPt]);
    expect(Math.hypot(nudged.restX - portalPt.x, nudged.restY - portalPt.y)).toBeGreaterThanOrEqual(115);

    const distantShock = getEventShockWave(simPortal, 1440, 900, 0, [portalPt], 1.0);
    const hiddenShock = getEventShockWave(simPortal, 1440, 900, 0, [portalPt], 0.0);
    expect(distantShock[3]).toBeGreaterThan(0);
    expect(hiddenShock).toEqual([0, 0, 0, 0]);

    // 6. Strict inverse-distance scaling (apparentRadius ∝ 1 / distance) & timeline scrubbing
    const simInv = createCosmicEventState({ autoEnabled: true, autoZoom: false, rng });
    startCosmicEvent(simInv, 'blackhole-birth', { observe: false, rng });
    simInv.active.elapsed = simInv.active.duration * 0.5;
    simInv.active.location = { sector: 'ne', x: 0.82, y: 0.24, depth: 0.2, distantScale: 0.40, yaw: -0.4, pitch: -0.2, distanceLy: 1260 };
    const nearFrame = computeEventFrame(simInv, 1440, 900, 0, null, 1.0);
    simInv.active.location = { sector: 'ne', x: 0.82, y: 0.24, depth: 0.8, distantScale: 0.20, yaw: -0.4, pitch: -0.2, distanceLy: 2520 };
    const farFrame = computeEventFrame(simInv, 1440, 900, 0, null, 1.0);
    expect(farFrame.effDist / nearFrame.effDist).toBeCloseTo(2.0, 4);
    expect(farFrame.eventRadiusPx / nearFrame.eventRadiusPx).toBeCloseTo(0.5, 4);
    expect(farFrame.layer).toBe('deep');

    // Telescoping in at 2x zoom doubles apparent radius and engages gravitational lensing
    simInv.focusProgress = 1.0;
    simInv.fovZoom = 1.0;
    const obs1x = computeEventFrame(simInv, 1440, 900, 0, null, 1.0);
    simInv.fovZoom = 2.0;
    const obs2x = computeEventFrame(simInv, 1440, 900, 0, null, 1.0);
    expect(obs2x.eventRadiusPx / obs1x.eventRadiusPx).toBeCloseTo(2.0, 4);
    expect(obs2x.layer).toBe('local');
    const lens = getEventLens(obs2x, 1440, 900);
    expect(lens[3]).toBeGreaterThan(0.5);
    const ambient = getEventAmbient(obs2x);
    expect(ambient[3]).toBeGreaterThan(0.1);
    expect(formatEventPhysicalDistance(simInv.active.def, 1.0, true)).toMatch(/ly$/);

    scrubCosmicEvent(simInv, 0.75);
    expect(simInv.active.elapsed / simInv.active.duration).toBeCloseTo(0.75, 3);
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

describe('Cosmos Component & WebGL Review Regressions', () => {
  let wrapper = null;

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it('scopes Quick Composer models per target Agent, fetches llm_config, and guards planet switch during in-flight routing', async () => {
    vi.stubGlobal('Vue', Vue);
    const sendWsMessage = vi.fn(() => true);
    let resolveRoute;
    const sendYeaftAutoRouteMessageMock = vi.fn(() => new Promise((resolve) => { resolveRoute = resolve; }));

    const store = Vue.reactive({
      currentAgent: 'ag-mac',
      yeaftModel: 'copilot/mac-only-model',
      yeaftModelEffort: 'high',
      yeaftAvailableModels: [{ id: 'copilot/mac-only-model', label: 'mac-only', provider: 'copilot', effortOptions: ['high'] }],
      llmConfig: {},
      sendWsMessage,
      sendYeaftAutoRouteMessage: sendYeaftAutoRouteMessageMock,
    });
    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => store,
      useSessionsStore: () => ({}),
      useVpStore: () => ({}),
    });

    const { default: CosmosQuickComposer } = await import('../../web/components/cosmos/CosmosQuickComposer.js');

    const cloudAgent = { id: 'ag-cloud', name: 'Cloud-Linux', online: true, liveSessions: [], sessions: [] };
    const macAgent = { id: 'ag-mac', name: 'MacBook-Pro', online: true, liveSessions: [], sessions: [] };

    wrapper = mount(CosmosQuickComposer, {
      props: { agent: cloudAgent, planetId: 'saturn' },
      global: {
        config: { globalProperties: { $t: (k) => k } },
        stubs: { ChatInput: true },
      },
    });

    // Must request target agent's LLM config and NOT bleed ag-mac's model
    expect(sendWsMessage).toHaveBeenCalledWith({ type: 'get_llm_config', agentId: 'ag-cloud' });
    expect(wrapper.vm.selectedModel).toBe('');
    expect(wrapper.vm.modelRows).toEqual([]);

    // Start auto-route send on ag-cloud -> quickSend must be null (no cross-agent model override)
    const sendPromise = wrapper.vm.handleQuickSend('Deploy worker');
    expect(sendYeaftAutoRouteMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'ag-cloud',
      quickSend: null,
      cosmosDelivery: true,
    }));
    expect(wrapper.vm.routing).toBe(true);

    // Switch planet to ag-mac while ag-cloud's auto-route is still in flight
    await wrapper.setProps({ agent: macAgent, planetId: 'earth' });
    await flushPromises();
    expect(wrapper.vm.routing).toBe(false);
    expect(wrapper.vm.statusBanner).toBeNull();
    expect(wrapper.vm.selectedModel).toBe('copilot/mac-only-model');

    // Now resolve the stale ag-cloud route: must NOT overwrite ag-mac's statusBanner
    // and MUST emit 'routed' with the original captured ag-cloud / saturn identity.
    resolveRoute({ ok: true, sessionId: 'sess-cloud-1', decision: 'created', title: 'Worker Deploy' });
    await sendPromise;
    await flushPromises();

    expect(wrapper.vm.statusBanner).toBeNull();
    const routed = wrapper.emitted('routed');
    expect(routed).toHaveLength(1);
    expect(routed[0][0]).toMatchObject({ agentId: 'ag-cloud', planetId: 'saturn' });

    const supplement = wrapper.vm.handleQuickSend('Also check mobile');
    expect(sendYeaftAutoRouteMessageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      agentId: 'ag-mac', quickSend: null,
    }));
    resolveRoute({ ok: true, sessionId: 'sess-mac-1', decision: 'matched', delivery: 'appended' });
    expect(await supplement).toBe(true);
    expect(wrapper.vm.statusBanner.text).toBe('cosmos.quick.routedAppended');

    wrapper.vm.selectModel('copilot/mac-only-model', 'high');
    const explicit = wrapper.vm.handleQuickSend('Run it with this model');
    expect(sendYeaftAutoRouteMessageMock).toHaveBeenLastCalledWith(expect.objectContaining({
      quickSend: { model: 'copilot/mac-only-model', effort: null },
    }));
    resolveRoute({ ok: false, code: 'invalid_quick_send', error: 'Invalid model' });
    expect(await explicit).toBe(false);
    expect(wrapper.vm.statusBanner.error).toBe(true);
    expect(wrapper.emitted('routed')).toHaveLength(2);
  });

  it('wires CosmosConversationDrawer search/outline to real store APIs and enforces agent-scoped session lookup', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Vue', Vue);

    const outlineState = Vue.reactive({ results: [{ messageId: 'm-1', preview: 'hello' }], loading: false, hasMore: false, error: null });
    const searchYeaftHistory = vi.fn(() => true);
    const loadYeaftHistoryWindow = vi.fn();
    const revealLease = { token: 'lease-1' };
    const beginYeaftHistoryReveal = vi.fn(() => revealLease);
    const revealYeaftHistoryResult = vi.fn().mockResolvedValue({ messageId: 'm-1', found: true });
    const finishYeaftHistoryReveal = vi.fn();
    const sendYeaftSessionMessage = vi.fn(() => true);

    const store = Vue.reactive({
      currentView: 'yeaft',
      currentAgent: 'ag-earth',
      yeaftActiveSessionFilter: 'sess-shared',
      yeaftAvailableModels: [],
      yeaftModel: '',
      yeaftModelEffort: '',
      yeaftHistorySearchState: { query: '', senderKey: 'user', loading: false, results: [], hasMore: false },
      workbenchExpanded: false,
      getYeaftHistoryOutlineState: vi.fn(() => outlineState),
      searchYeaftHistory,
      loadYeaftHistoryWindow,
      beginYeaftHistoryReveal,
      revealYeaftHistoryResult,
      finishYeaftHistoryReveal,
      sendYeaftSessionMessage,
      hasCapability: (cap) => cap === 'session_history_window_prefetch',
    });

    const sessionById = vi.fn((sid, agentId) => (
      sid === 'sess-shared' && agentId === 'ag-earth'
        ? { id: 'sess-shared', name: 'Earth Session', agentId: 'ag-earth', roster: [{ id: 'vp-1' }] }
        : null
    ));

    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => store,
      useSessionsStore: () => ({ activeSessionId: 'sess-shared', sessionById }),
      useVpStore: () => ({}),
    });

    const { default: CosmosConversationDrawer } = await import('../../web/components/cosmos/CosmosConversationDrawer.js');

    const revealMessage = vi.fn(() => true);
    wrapper = mount(CosmosConversationDrawer, {
      props: {
        agent: { id: 'ag-earth', name: 'Earth', online: true, sessions: [] },
        planetId: 'earth',
        allAgents: [],
      },
      global: {
        config: { globalProperties: { $t: (k) => k } },
        stubs: {
          MessageList: { template: '<div />', methods: { revealMessage } },
          ChatInput: true,
          SessionSceneSelect: true,
          WorkbenchPanel: true,
          YeaftConversationOutline: { template: '<div />', methods: { focus() {}, restoreOlderScroll() {} } },
        },
      },
    });

    // Strict (agentId, sessionId) scoping: every sessionById call must pass 'ag-earth'
    expect(wrapper.vm.activeGroup?.id).toBe('sess-shared');
    expect(sessionById.mock.calls.every(([, ag]) => ag === 'ag-earth')).toBe(true);
    expect(wrapper.vm.historyOutlineState.results).toHaveLength(1);
    expect(wrapper.vm.sendYeaftMessage('fixture')).toBe(true);
    expect(sendYeaftSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      groupId: 'sess-shared', text: 'fixture', cosmosDelivery: true,
    }));

    // Toggle search opens outline via store.searchYeaftHistory('', { senderKey: 'user' })
    wrapper.vm.toggleSearch();
    expect(wrapper.vm.searchOpen).toBe(true);
    expect(searchYeaftHistory).toHaveBeenCalledWith('', { senderKey: 'user' });

    // Debounced query search
    wrapper.vm.onSearchQuery('shader');
    vi.advanceTimersByTime(230);
    expect(searchYeaftHistory).toHaveBeenCalledWith('shader', { senderKey: 'user' });

    // Preview & select use real prefetch + revealOutlineResult single-object API
    const item = { messageId: 'm-1', seq: 1 };
    wrapper.vm.onSearchPreview(item);
    expect(loadYeaftHistoryWindow).toHaveBeenCalledWith(item);

    await wrapper.vm.onSearchSelect(item);
    expect(beginYeaftHistoryReveal).toHaveBeenCalledWith(item);
    expect(revealYeaftHistoryResult).toHaveBeenCalledWith(item, revealLease);
    expect(revealMessage).toHaveBeenCalled();
    expect(finishYeaftHistoryReveal).toHaveBeenCalledWith(revealLease);
  });

  it('bakes WebGL 1 POT-safe procedural textures and handles webglcontextlost / webglcontextrestored cleanly', () => {
    const texCalls = [];
    const wrapCalls = [];
    let currentTex = null;
    let lost = false;
    let drawArraysCount = 0;
    const uploadedImages = [];

    const fakeGl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
      ARRAY_BUFFER: 5, STATIC_DRAW: 6, DYNAMIC_DRAW: 7, FLOAT: 8, TRIANGLES: 9, POINTS: 10,
      TEXTURE_2D: 11, TEXTURE0: 12, RGBA: 13, UNSIGNED_BYTE: 14, LINEAR: 15,
      TEXTURE_MIN_FILTER: 16, TEXTURE_MAG_FILTER: 17, TEXTURE_WRAP_S: 18, TEXTURE_WRAP_T: 19,
      REPEAT: 20, CLAMP_TO_EDGE: 21, FRAMEBUFFER: 22, COLOR_ATTACHMENT0: 23,
      BLEND: 24, ONE: 25, ONE_MINUS_SRC_ALPHA: 26, RENDERER: 27, UNPACK_FLIP_Y_WEBGL: 28,
      createShader: () => ({}),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      getShaderInfoLog: () => '',
      deleteShader: () => {},
      createProgram: () => ({}),
      attachShader: () => {},
      linkProgram: () => {},
      getProgramParameter: () => true,
      getProgramInfoLog: () => '',
      deleteProgram: () => {},
      getAttribLocation: () => 0,
      getUniformLocation: () => ({}),
      createBuffer: () => ({}),
      bindBuffer: () => {},
      bufferData: () => {},
      deleteBuffer: () => {},
      createFramebuffer: () => ({}),
      bindFramebuffer: () => {},
      framebufferTexture2D: () => {},
      deleteFramebuffer: () => {},
      createTexture: () => { currentTex = { w: 0, h: 0 }; texCalls.push(currentTex); return currentTex; },
      bindTexture: (_t, tex) => { currentTex = tex; },
      deleteTexture: () => {},
      pixelStorei: () => {},
      texImage2D: (...args) => {
        if (args.length === 6 && args[5] && typeof args[5] === 'object') {
          uploadedImages.push(args[5]);
        } else if (typeof args[3] === 'number' && typeof args[4] === 'number' && currentTex) {
          currentTex.w = args[3];
          currentTex.h = args[4];
        }
      },
      texParameteri: (_t, pname, param) => {
        if ((pname === 18 || pname === 19) && currentTex) {
          wrapCalls.push({ w: currentTex.w, h: currentTex.h, param });
        }
      },
      useProgram: () => {},
      enable: () => {},
      disable: () => {},
      blendFunc: () => {},
      enableVertexAttribArray: () => {},
      disableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      viewport: () => {},
      activeTexture: () => {},
      uniform1i: () => {},
      uniform1f: () => {},
      uniform2f: () => {},
      uniform3f: () => {},
      uniform4f: () => {},
      drawArrays: () => { drawArraysCount += 1; },
      getParameter: () => 'Mock GPU',
      getExtension: () => null,
      isContextLost: () => lost,
    };

    const baked = bakeProceduralWebGLTextures(fakeGl, {}, 1.0);
    expect(Object.keys(baked)).toHaveLength(15);
    const isPot = (n) => n > 0 && (n & (n - 1)) === 0;
    for (const c of wrapCalls) {
      if (c.param === fakeGl.REPEAT) {
        expect(isPot(c.w) && isPot(c.h)).toBe(true);
      }
    }

    const listeners = {};
    const glCanvas = {
      width: 0, height: 0, clientWidth: 640, clientHeight: 360,
      getContext: (kind) => (kind === 'webgl' ? fakeGl : null),
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      removeEventListener: (ev, fn) => { if (listeners[ev] === fn) delete listeners[ev]; },
    };
    const hudCanvas = {
      width: 0, height: 0,
      getContext: () => ({ setTransform: () => {}, clearRect: () => {} }),
    };

    // Seed cached real earth_day & milky images so we can verify restore re-uploads them
    __resetCosmosTextureCacheForTests();
    const seededImgs = [];
    class SeedImage {
      constructor() { this.naturalWidth = 1024; this.naturalHeight = 512; seededImgs.push(this); }
      set src(v) { this._src = v; }
      get src() { return this._src; }
    }
    const unsubSeed = requestCosmosTextureGroup('solar', null, { ImageCtor: SeedImage });
    for (const im of seededImgs) {
      if (im.src.endsWith('earth_day.webp') || im.src.endsWith('eso_milky_way.webp')) im.onload();
    }
    unsubSeed();

    const drawsBeforeEngine = drawArraysCount;
    const engine = createCosmosEngine(glCanvas, hudCanvas);
    expect(engine.isWebGL).toBe(true);
    // Boot must NOT run 15-FBO procedural texture bake or pre-compile cosmic event shaders
    expect(drawArraysCount).toBe(drawsBeforeEngine);
    expect(engine.getCompiledEventShaderCount()).toBe(0);
    expect(engine.areRealTexturesReady()).toBe(true);
    expect(uploadedImages.length).toBeGreaterThanOrEqual(2);
    expect(typeof listeners.webglcontextlost).toBe('function');
    expect(typeof listeners.webglcontextrestored).toBe('function');

    // Simulate GPU context loss: preventDefault() must be called, real-ready flag cleared, GL draws skipped
    const lostEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    lost = true;
    listeners.webglcontextlost(lostEvent);
    expect(lostEvent.defaultPrevented).toBe(true);
    expect(engine.areRealTexturesReady()).toBe(false);

    const drawsBeforeLost = drawArraysCount;
    const uploadsBeforeRestore = uploadedImages.length;
    const hudDraw = vi.fn();
    engine.renderFrame({ hudDraw });
    expect(drawArraysCount).toBe(drawsBeforeLost);
    expect(hudDraw).toHaveBeenCalledTimes(1);

    // Simulate GPU context restored: cached real NASA/ESO textures re-upload immediately, and GL resumes cleanly
    lost = false;
    listeners.webglcontextrestored();
    expect(uploadedImages.length).toBeGreaterThanOrEqual(uploadsBeforeRestore + 2);
    expect(engine.areRealTexturesReady()).toBe(true);

    // Render one frame with an active deep-space event -> resumes GL draws & lazily compiles ONLY that 1 event shader
    const hudAfterRestore = vi.fn();
    engine.renderFrame({
      time: 1, realTime: 1, scaleLog: 13,
      parallax: { x: 0, y: 0 }, camRot: { x: 0, y: 0 }, warp: 0, fovZoom: 1,
      shockWave: [0, 0, 0, 0], eventLens: [0, 0, 0, 0], eventAmbient: [0, 0, 0, 0],
      skyBright: 1, starDensity: 1,
      bhParams: { x: 0, y: 0, radius: 0.017, strength: 0.9 },
      galParams: { x: 0.4, y: -0.35, radius: 0.09, alpha: 0.7, tilt: 0.5 },
      webParams: { x: -0.4, y: -0.35, radius: 0.08, alpha: 0.5 },
      particleData: null, particleCount: 0,
      eventDraw: {
        id: 'supernova', eventType: 0, layer: 'deep',
        x: 500, y: 120, eventRadiusPx: 64, quadRadiusPx: 156, sunRadiusPx: 22,
        progress: 0.45, elapsed: 9.0, alpha: 0.9, obsBlend: 0, distNorm: 4.5, angle: 0.2, seed: 0.4,
      },
      eventParticleData: null, eventParticleCount: 0,
      solarBodies: [], solarAlpha: 1,
      hudDraw: hudAfterRestore,
    });
    expect(drawArraysCount).toBeGreaterThan(drawsBeforeLost);
    expect(engine.getCompiledEventShaderCount()).toBe(1);
    expect(hudAfterRestore).toHaveBeenCalledWith(expect.anything(), expect.any(Number), expect.any(Number), { eventRenderedInGL: true });

    engine.destroy();
    __resetCosmosTextureCacheForTests();
    expect(listeners.webglcontextlost).toBeUndefined();
    expect(listeners.webglcontextrestored).toBeUndefined();
  });

  it('aborts transient drags cleanly on pointercancel without opening Quick Composer or closing an open drawer', async () => {
    vi.stubGlobal('Vue', Vue);
    const store = Vue.reactive({
      agents: [{ id: 'ag-earth', name: 'MacBook', online: true, capabilities: ['session_auto_route'] }],
      sessionCatalog: [],
      yeaftConversationIdsByAgent: {},
      messagesMap: {},
      workbenchExpanded: false,
      isYeaftSessionProcessing: () => false,
      isYeaftSessionUnread: () => false,
      setUiMode: vi.fn(),
    });
    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => store,
      useSessionsStore: () => ({ sessionList: [] }),
      useVpStore: () => ({}),
    });

    const { default: CosmosPage } = await import('../../web/components/cosmos/CosmosPage.js');
    wrapper = mount(CosmosPage, {
      global: {
        config: { globalProperties: { $t: (k) => k } },
        stubs: {
          CosmosQuickComposer: true,
          CosmosConversationDrawer: true,
          CosmosConstantsPopover: true,
          CosmosEventsOverlay: true,
          SettingsPanel: true,
          AgentSettingsPanel: true,
          SessionCreateModal: true,
        },
      },
    });

    // Deep-sky portals (Galaxy, Cosmic Web, Event Horizon) must render pure visual hit targets with zero visible text overlay
    const portalButtons = wrapper.findAll('.cosmos-sky-anomaly');
    expect(portalButtons).toHaveLength(3);
    expect(wrapper.findAll('.cosmos-sky-anomaly-label')).toHaveLength(0);
    for (const btn of portalButtons) {
      expect(btn.text().trim()).toBe('');
      expect(btn.attributes('aria-label')).toBeTruthy();
    }

    // Touch down on planet then cancel -> must NOT open Quick Auto-Route Composer
    wrapper.vm.onPlanetPointerDown('earth', { pointerType: 'touch', pointerId: 1, button: 0, clientX: 100, clientY: 200 });
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: 1 }));
    await flushPromises();
    expect(wrapper.vm.quickAgentId).toBeNull();
    expect(wrapper.vm.dragActive).toBe(false);

    // Touch down on canvas while drawer is open: unrelated pointercancel must leave active orbit intact
    wrapper.vm.drawerOpen = true;
    wrapper.vm.drawerAgentId = 'ag-earth';
    wrapper.vm.onCanvasPointerDown({ pointerType: 'mouse', pointerId: 2, button: 0, clientX: 50, clientY: 50 });
    expect(wrapper.vm.camOrbiting).toBe(true);
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: 99 }));
    await flushPromises();
    expect(wrapper.vm.camOrbiting).toBe(true);
    expect(wrapper.vm.drawerOpen).toBe(true);

    // Matching pointercancel aborts camOrbiting cleanly without dismissing the drawer
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'mouse', pointerId: 2 }));
    await flushPromises();
    expect(wrapper.vm.camOrbiting).toBe(false);
    expect(wrapper.vm.drawerOpen).toBe(true);

    // Unrelated pointercancel during active planet drag must leave planet drag intact so matching pointerup still commits
    wrapper.vm.drawerOpen = false;
    wrapper.vm.onPlanetPointerDown('earth', { pointerType: 'mouse', pointerId: 3, button: 0, clientX: 120, clientY: 220 });
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: 100 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'mouse', pointerId: 3 }));
    await flushPromises();
    expect(wrapper.vm.quickAgentId).toBe('ag-earth');

    // Missing HUD 2D context after acquiring WebGL must release the unused WebGL context before 2D fallback
    const loseContext = vi.fn();
    const glNoHud = {
      getParameter: () => 'Mock GPU',
      getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
    };
    const fallbackNoHud = createCosmosEngine(
      { width: 0, height: 0, clientWidth: 640, clientHeight: 360, getContext: (k) => (k === 'webgl' ? glNoHud : null) },
      { width: 0, height: 0, getContext: () => null },
      { renderQuality: 'high' },
    );
    expect(fallbackNoHud.mode).toBe('2d');
    expect(loseContext).toHaveBeenCalledTimes(1);
    fallbackNoHud.destroy();
  });

  it('copies every web source directory in Dockerfile Stage 1 and ships all 18 Cosmos WebP assets', () => {
    const repoRoot = resolve(process.cwd());
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf-8');
    const webDir = join(repoRoot, 'web');
    const ignored = new Set(['node_modules', 'dist', 'vendor']);
    const sourceDirs = readdirSync(webDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !ignored.has(d.name))
      .map((d) => d.name);

    expect(sourceDirs).toContain('cosmos');
    expect(sourceDirs).toContain('assets');
    for (const dir of sourceDirs) {
      const pattern = new RegExp(`COPY\\s+web/${dir}\\s+\\./${dir}/`);
      expect(dockerfile, `Dockerfile Stage 1 must COPY web/${dir}`).toMatch(pattern);
    }

    expect(COSMOS_TEXTURE_MANIFEST).toHaveLength(18);
    for (const spec of COSMOS_TEXTURE_MANIFEST) {
      const fullPath = join(webDir, 'assets', 'cosmos', spec.file);
      expect(existsSync(fullPath), `Missing cosmos texture: ${spec.file}`).toBe(true);
      expect(statSync(fullPath).size).toBeGreaterThan(500);
    }
  });

  it('loads Solar textures eagerly, defers Galaxy/Web textures lazily, and uploads safely on WebGL 1', () => {
    __resetCosmosTextureCacheForTests();
    const created = [];
    class FakeImage {
      constructor() {
        this.naturalWidth = 1024;
        this.naturalHeight = 512;
        this._src = '';
        created.push(this);
      }
      set src(v) { this._src = v; }
      get src() { return this._src; }
    }

    const ready = [];
    const unsub = requestCosmosTextureGroup('solar', (k) => ready.push(k), { ImageCtor: FakeImage });
    expect(created).toHaveLength(15);
    expect(created.some((im) => im.src.includes('galaxy_m51.webp'))).toBe(false);
    expect(created.some((im) => im.src.includes('cosmic_web_field.webp'))).toBe(false);

    // Trigger load for earth_day and verify cache reuse + error tolerance on another image
    const earthImg = created.find((im) => im.src.endsWith('earth_day.webp'));
    earthImg.onload();
    expect(ready).toContain('earth_day');
    expect(getLoadedCosmosImage('earth_day')).toBe(earthImg);

    const marsImg = created.find((im) => im.src.endsWith('mars.webp'));
    marsImg.onerror();
    expect(getLoadedCosmosImage('mars')).toBeNull();

    // WebGL 1 NPOT image must clamp instead of using REPEAT
    const params = [];
    const mockGl1 = {
      TEXTURE_2D: 1, RGBA: 2, UNSIGNED_BYTE: 3, LINEAR: 4, LINEAR_MIPMAP_LINEAR: 5,
      TEXTURE_MIN_FILTER: 6, TEXTURE_MAG_FILTER: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9,
      REPEAT: 10, CLAMP_TO_EDGE: 11, UNPACK_FLIP_Y_WEBGL: 12,
      bindTexture: () => {},
      pixelStorei: () => {},
      texImage2D: () => {},
      generateMipmap: vi.fn(),
      texParameteri: (_t, p, v) => params.push([p, v]),
    };
    uploadImageToWebGLTexture(mockGl1, {}, { naturalWidth: 1024, naturalHeight: 820 }, { wrapS: true, wrapT: true });
    expect(mockGl1.generateMipmap).not.toHaveBeenCalled();
    expect(params).toContainEqual([mockGl1.TEXTURE_WRAP_S, mockGl1.CLAMP_TO_EDGE]);
    expect(params).toContainEqual([mockGl1.TEXTURE_WRAP_T, mockGl1.CLAMP_TO_EDGE]);

    unsub();
    __resetCosmosTextureCacheForTests();
  });

  it('keeps all 8 planets inside a 390x844 portrait phone viewport and supports 2D fallback / software GL routing', () => {
    const mobile = computeSolarProjectionLayout(390, 844);
    expect(mobile.isPortrait).toBe(true);
    expect(mobile.isCompact).toBe(true);
    expect(mobile.tilt).toBeGreaterThan(0.6);

    for (const p of PLANETS) {
      for (let deg = 0; deg < 360; deg += 15) {
        const rad = (deg * Math.PI) / 180;
        const ux = Math.cos(rad) * p.orbitR;
        const uz = Math.sin(rad) * p.orbitR;
        const persp = 1.0 / (1.0 - uz * 0.26);
        const sx = mobile.cx + ux * mobile.span * persp;
        expect(sx, `${p.id} at ${deg}deg clipped portrait viewport`).toBeGreaterThanOrEqual(8);
        expect(sx, `${p.id} at ${deg}deg clipped portrait viewport`).toBeLessThanOrEqual(382);
      }
    }

    const desktop = computeSolarProjectionLayout(1440, 900);
    expect(desktop.isPortrait).toBe(false);
    expect(desktop.span).toBeGreaterThan(700);

    // 2D Eco mode renders all 4 scales cleanly without requesting WebGL
    const stubCtx2d = () => ({
      setTransform: () => {}, clearRect: () => {}, fillRect: () => {},
      save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {}, scale: () => {},
      beginPath: () => {}, arc: () => {}, ellipse: () => {}, rect: () => {}, clip: () => {},
      fill: () => {}, stroke: () => {}, moveTo: () => {}, lineTo: () => {}, drawImage: () => {},
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
    });
    const getContext = vi.fn((kind) => (kind === '2d' ? stubCtx2d() : null));
    const glCanvas = { width: 0, height: 0, clientWidth: 390, clientHeight: 844, getContext };
    const hudCanvas = { width: 0, height: 0, getContext: () => stubCtx2d() };

    const eng2d = createCosmosEngine(glCanvas, hudCanvas, { renderQuality: 'lite', isMobile: true });
    expect(eng2d.mode).toBe('2d');
    expect(eng2d.isWebGL).toBe(false);
    expect(getContext).toHaveBeenCalledWith('2d');
    expect(getContext).not.toHaveBeenCalledWith('webgl2');

    // Render across Solar, Galaxy, Cosmic Web, and Event Horizon scales cleanly
    const hudDraw = vi.fn();
    eng2d.renderFrame({
      time: 1, realTime: 1, scaleLog: 13,
      parallax: { x: 0, y: 0 }, camRot: { x: 0, y: 0 }, warp: 0.2,
      skyBright: 1.05, starDensity: 1.18,
      bhParams: { x: 0, y: 0, radius: 0.16, strength: 0.9 },
      galParams: { x: 0, y: 0, radius: 0.8, alpha: 0.9, tilt: 0.54 },
      webParams: { x: 0, y: 0, radius: 1.0, alpha: 0.9 },
      solarAlpha: 1,
      solarBodies: [
        { bodyType: 0, texKey: 'sun', screenX: 195, screenY: 400, radiusPx: 24, camZ: 0, spin: 0.1, oblate: 1, lightDir: [0, 0, 1], atmo: [1, 0.7, 0.3], highlight: 0 },
        { bodyType: 6, texKey: 'saturn', screenX: 280, screenY: 460, radiusPx: 20, camZ: 0.2, spin: 0.4, oblate: 0.9, lightDir: [-0.7, 0.2, 0.6], atmo: [0.9, 0.8, 0.6], highlight: 0.5 },
      ],
      hudDraw,
    });
    expect(hudDraw).toHaveBeenCalledTimes(1);
    eng2d.destroy();

    // Persisted renderQuality clamping
    const storage = createMemoryStorage();
    saveCosmosConstants({ renderQuality: 'lite' }, storage);
    expect(loadCosmosConstants(storage).renderQuality).toBe('lite');
    saveCosmosConstants({ renderQuality: 'invalid-mode' }, storage);
    expect(loadCosmosConstants(storage).renderQuality).toBe('auto');
  });

  it('projects nested Project hierarchy, builds collapsible folder trees, and searches sessions across agents', () => {
    const now = Date.now();
    const projects = [
      {
        id: 'proj-root',
        name: 'Yeaft',
        parentId: null,
        sortOrder: 0,
        members: [{ agentId: 'mac', sessionId: 's-1' }],
      },
      {
        id: 'proj-child',
        name: 'Cosmos',
        parentId: 'proj-root',
        sortOrder: 1,
        members: [{ agentId: 'mac', sessionId: 's-2' }],
      },
      {
        id: 'proj-cloud',
        name: 'Infra',
        parentId: null,
        sortOrder: 2,
        members: [{ agentId: 'cloud', sessionId: 's-3' }],
      },
    ];
    const chatStore = {
      currentAgent: 'mac',
      agents: [
        { id: 'mac', name: 'MacBook', online: true, workDir: '/dev/yeaft', capabilities: ['session_auto_route'] },
        { id: 'cloud', name: 'CloudBox', online: true, workDir: '/srv/infra', capabilities: ['session_auto_route'] },
      ],
      sessionProjects: projects,
      sessionCatalog: [
        { catalogKey: 'yeaft:mac:s-1', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-1' }, title: 'Yeaft-Agent', metadataUpdatedAt: now - 1000 },
        { catalogKey: 'yeaft:mac:s-2', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-2' }, title: 'Shader-Lab', metadataUpdatedAt: now - 2000 },
        { catalogKey: 'yeaft:mac:s-free', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-free' }, title: 'Scratchpad', metadataUpdatedAt: now - 3000 },
        { catalogKey: 'yeaft:cloud:s-3', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'cloud', sessionId: 's-3' }, title: 'Nginx-TLS', metadataUpdatedAt: now - 4000 },
      ],
      yeaftConversationIdsByAgent: {},
      messagesMap: {},
      isYeaftSessionProcessing: (sid) => sid === 's-2',
      isYeaftSessionUnread: () => false,
    };

    const projected = projectAgentsForCosmos({ chatStore, sessionsStore: { sessionList: [] }, nowMs: now, isEn: true });
    expect(projected.mac.sessions.find((s) => s.id === 's-1')?.projectPath).toBe('Yeaft');
    expect(projected.mac.sessions.find((s) => s.id === 's-2')?.projectPath).toBe('Yeaft / Cosmos');
    expect(projected.mac.sessions.find((s) => s.id === 's-free')?.projectPath).toBe('');

    const treeExpanded = buildCosmosProjectSessionTree(projects, projected.mac.sessions);
    expect(treeExpanded.hasFolders).toBe(true);
    // Folders containing only sessions on other planets (Infra) are omitted for this planet
    expect(treeExpanded.items.map((i) => `${i.kind}:${i.kind === 'folder' ? `${i.project.name}@${i.depth}(${i.count})` : `${i.session.id}@${i.depth}`}`)).toEqual([
      'folder:Yeaft@0(2)',
      'folder:Cosmos@1(1)',
      'session:s-2@2',
      'session:s-1@1',
      'session:s-free@0',
    ]);
    expect(treeExpanded.items.at(-1)?.groupStart).toBe(true);

    const treeCollapsed = buildCosmosProjectSessionTree(projects, projected.mac.sessions, new Set(['proj-root']));
    expect(treeCollapsed.items.map((i) => i.key)).toEqual(['folder:proj-root', 'yeaft:mac:s-free']);

    // Multi-token search matches across Project path and title on a single Agent scope
    expect(filterCosmosSessions([projected.mac], 'yeaft cosmos').map((h) => h.session.id)).toEqual(['s-2']);
    expect(filterCosmosSessions([projected.mac], 'infra')).toEqual([]);
    expect(filterCosmosSessions([projected.mac], 'scratch').map((h) => h.session.id)).toEqual(['s-free']);

    // Hidden native session exclusion + restore + same-sessionId isolation across Agents:
    // When server catalog is authoritative, a hidden session kept in live sessionsStore MUST NOT be resurrected,
    // while the same session ID on another Agent stays visible, and restoring it brings it back.
    const authChatStore = {
      ...chatStore,
      sessionCatalogLoaded: true,
      sessionCatalogProtocolSupported: true,
      sessionCatalog: [
        { catalogKey: 'yeaft:mac:s-1', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-1' }, title: 'Visible-Mac', metadataUpdatedAt: now - 1000 },
        { catalogKey: 'yeaft:cloud:s-hidden', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'cloud', sessionId: 's-hidden' }, title: 'Cloud-Same-Id', metadataUpdatedAt: now - 1500 },
      ],
      hiddenSessionCatalog: [
        { catalogKey: 'yeaft:mac:s-hidden', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-hidden' }, title: 'Secret-Hidden', hidden: true },
      ],
    };
    const liveSessionsStore = {
      sessionList: [
        { id: 's-1', agentId: 'mac', name: 'Visible-Mac', updatedAt: now - 500 },
        { id: 's-hidden', agentId: 'mac', name: 'Secret-Hidden', updatedAt: now - 100 },
        { id: 's-hidden', agentId: 'cloud', name: 'Cloud-Same-Id', updatedAt: now - 1500 },
      ],
    };
    const projectedHidden = projectAgentsForCosmos({ chatStore: authChatStore, sessionsStore: liveSessionsStore, nowMs: now, isEn: true });
    expect(projectedHidden.mac.sessions.map((s) => s.id)).toEqual(['s-1']);
    expect(projectedHidden.cloud.sessions.map((s) => s.id)).toEqual(['s-hidden']);
    expect(filterCosmosSessions([projectedHidden.mac], 'secret')).toEqual([]);

    // Restore s-hidden back into visible catalog -> reappears cleanly
    const restoredChatStore = {
      ...authChatStore,
      hiddenSessionCatalog: [],
      sessionCatalog: [
        ...authChatStore.sessionCatalog,
        { catalogKey: 'yeaft:mac:s-hidden', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-hidden' }, title: 'Secret-Hidden', hidden: false },
      ],
    };
    const projectedRestored = projectAgentsForCosmos({ chatStore: restoredChatStore, sessionsStore: liveSessionsStore, nowMs: now, isEn: true });
    expect(projectedRestored.mac.sessions.map((s) => s.id)).toContain('s-hidden');

    // Legacy single-Agent fallback via production sidebarSessionCatalogRows adapter:
    // sidebarSessionCatalog is array-valued even for legacy servers and drops ownerless rows (agentId == null),
    // yet Cosmos must still project an unambiguous single-Agent ownerless legacy row ONLY after
    // legacy readiness + auth checks pass — never while hydration is pending, failed, or auth is stale.
    const singleLegacyStore = {
      agents: [{ id: 'mac', name: 'MacBook', online: true, workDir: '/dev/yeaft', capabilities: [] }],
      currentAgent: 'mac',
      conversations: [],
      sessionCatalog: [],
      sidebarLegacySessionCatalog: [
        { catalogKey: 'yeaft:mac:s-retained', runtimeProvider: 'yeaft', routeRef: { runtimeProvider: 'yeaft', agentId: 'mac', sessionId: 's-retained' }, title: 'Retained-Read-Model' },
      ],
      hiddenSessionCatalog: [],
      sessionProjects: [],
      sessionCatalogLoaded: false,
      sessionCatalogProtocolSupported: false,
      sidebarSessionCatalogLoading: false,
      _hasHandledAgentList: true,
      _hasHandledYeaftSessionHydrate: true,
      yeaftSessionHydrateError: null,
      yeaftConversationIdsByAgent: {},
      messagesMap: {},
      isYeaftSessionProcessing: () => false,
      isYeaftSessionUnread: () => false,
    };
    const legacySessions = [
      { id: 's-ownerless', agentId: null, name: 'Legacy-Ownerless', updatedAt: now - 200 },
      { id: 's-stamped', agentId: 'mac', name: 'Legacy-Stamped', updatedAt: now - 300 },
      { id: 's-legacy-hidden', agentId: null, name: 'Legacy-Hidden', hidden: true, updatedAt: now - 100 },
    ];

    // Pending legacy hydration: must return only retained read model, never unaccepted sessionsStore rows
    const pendingLegacyStore = { ...singleLegacyStore, _hasHandledYeaftSessionHydrate: false, sidebarSessionCatalogLoading: true };
    pendingLegacyStore.sidebarSessionCatalog = sidebarSessionCatalogRows(pendingLegacyStore, legacySessions);
    const pendingProjected = projectAgentsForCosmos({ chatStore: pendingLegacyStore, sessionsStore: { sessionList: legacySessions }, nowMs: now, isEn: true });
    expect(pendingProjected.mac.sessions.map((s) => s.id)).toEqual(['s-retained']);

    // Failed legacy hydration: must hold the visibility fence closed
    const failedLegacyStore = { ...singleLegacyStore, yeaftSessionHydrateError: 'hydrate_failed', sidebarSessionCatalogLoading: true };
    failedLegacyStore.sidebarSessionCatalog = sidebarSessionCatalogRows(failedLegacyStore, legacySessions);
    const failedProjected = projectAgentsForCosmos({ chatStore: failedLegacyStore, sessionsStore: { sessionList: legacySessions }, nowMs: now, isEn: true });
    expect(failedProjected.mac.sessions.map((s) => s.id)).toEqual(['s-retained']);

    // Stale auth identity (sidebarSessionCatalog empty + loading true): must not leak cached sessions
    const staleAuthLegacyStore = { ...singleLegacyStore, sidebarSessionCatalog: [], sidebarSessionCatalogLoading: true };
    const staleAuthProjected = projectAgentsForCosmos({ chatStore: staleAuthLegacyStore, sessionsStore: { sessionList: legacySessions }, nowMs: now, isEn: true });
    expect(staleAuthProjected.mac.sessions).toEqual([]);

    // Accepted single-Agent legacy hydration: production adapter keeps s-stamped, Cosmos adds unambiguous s-ownerless
    singleLegacyStore.sidebarSessionCatalog = sidebarSessionCatalogRows(singleLegacyStore, legacySessions);
    expect(singleLegacyStore.sidebarSessionCatalog.map((r) => r.routeRef.sessionId)).toEqual(['s-stamped']);
    const legacySingleProjected = projectAgentsForCosmos({
      chatStore: singleLegacyStore,
      sessionsStore: { sessionList: legacySessions },
      nowMs: now,
      isEn: true,
    });
    expect(legacySingleProjected.mac.sessions.map((s) => s.id).sort()).toEqual(['s-ownerless', 's-stamped']);

    // Multi-Agent legacy store must NOT guess an owner for an ownerless row
    const multiLegacyStore = {
      ...singleLegacyStore,
      agents: [
        { id: 'mac', name: 'MacBook', online: true, workDir: '/dev/yeaft', capabilities: [] },
        { id: 'cloud', name: 'Cloud', online: true, workDir: '/srv', capabilities: [] },
      ],
    };
    multiLegacyStore.sidebarSessionCatalog = sidebarSessionCatalogRows(multiLegacyStore, legacySessions);
    const legacyMultiProjected = projectAgentsForCosmos({
      chatStore: multiLegacyStore,
      sessionsStore: { sessionList: legacySessions },
      nowMs: now,
      isEn: true,
    });
    expect(legacyMultiProjected.mac.sessions.map((s) => s.id)).toEqual(['s-stamped']);
    expect(legacyMultiProjected.cloud.sessions).toEqual([]);
  });

  it('mounts real WorkbenchPanel bound to chatStore.workbenchExpanded (no ownerRoute shadowing) and runs Project tree + FTS session search', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Vue', Vue);

    const sentFrames = [];
    const mockWs = {};
    const store = Vue.reactive({
      ws: mockWs,
      connectionState: 'connected',
      sessionDiscoverySupported: true,
      workbenchRouteProtocolSupported: true,
      currentView: 'yeaft',
      currentAgent: 'ag-earth',
      yeaftActiveSessionFilter: 'sess-1',
      activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'ag-earth', sessionId: 'sess-1' },
      effectiveWorkDir: '/workspace/yeaft',
      yeaftAvailableModels: [],
      yeaftModel: '',
      yeaftModelEffort: '',
      yeaftHistorySearchState: { query: '', senderKey: 'user', loading: false, results: [], hasMore: false },
      workbenchExpanded: false,
      workbenchMaximized: false,
      yeaftTurnDeleteHistoryBySession: {},
      agents: [
        {
          id: 'ag-earth',
          name: 'Earth-Mac',
          online: true,
          capabilities: ['session_discovery', 'workbench_session_routes', 'terminal', 'file_editor'],
        },
        {
          id: 'ag-saturn',
          name: 'Saturn-Cloud',
          online: true,
          capabilities: ['session_discovery', 'workbench_session_routes', 'terminal', 'file_editor'],
        },
      ],
      sessionProjects: [
        {
          id: 'p-yeaft',
          name: 'Yeaft',
          parentId: null,
          sortOrder: 0,
          members: [
            { agentId: 'ag-earth', sessionId: 'sess-1' },
            { agentId: 'ag-earth', sessionId: 'sess-2' },
          ],
        },
      ],
      hasAgentCapability: (aid, cap) => aid === 'ag-earth' && ['session_discovery', 'workbench_session_routes', 'terminal', 'file_editor'].includes(cap),
      toggleWorkbench() {
        this.workbenchExpanded = !this.workbenchExpanded;
        if (!this.workbenchExpanded) this.workbenchMaximized = false;
      },
      toggleWorkbenchMaximized() {
        this.workbenchMaximized = !this.workbenchMaximized;
      },
      rememberWorkbenchPanelState: vi.fn(),
      restoreWorkbenchPanelState: vi.fn(),
      workbenchPanelWidthForRoute: vi.fn(() => null),
      sendWsMessage: vi.fn((frame) => {
        sentFrames.push(frame);
        return true;
      }),
      getYeaftHistoryOutlineState: () => ({ results: [], loading: false, hasMore: false, error: null }),
    });

    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => store,
      useSessionsStore: () => ({
        activeSessionId: 'sess-1',
        sessionById: (sid, aid) => (aid === 'ag-earth' && sid === 'sess-1'
          ? { id: 'sess-1', name: 'Yeaft-Agent', agentId: 'ag-earth', workDir: '/workspace/yeaft', roster: [] }
          : null),
      }),
      useVpStore: () => ({}),
    });

    const { default: CosmosConversationDrawer } = await import('../../web/components/cosmos/CosmosConversationDrawer.js');

    const earthAgent = {
      id: 'ag-earth',
      name: 'Earth-Mac',
      online: true,
      sessions: [
        { id: 'sess-1', agentId: 'ag-earth', runtimeProvider: 'yeaft', catalogKey: 'yeaft:ag-earth:sess-1', title: 'Yeaft-Agent', status: 'running', updatedLabel: 'now', projectId: 'p-yeaft', projectName: 'Yeaft', projectPath: 'Yeaft', summary: 'working' },
        { id: 'sess-shared', agentId: 'ag-earth', runtimeProvider: 'claude-code', catalogKey: 'chat:sess-shared', title: 'Collision CLI Chat', status: 'done', updatedLabel: '1h', projectId: null, projectName: '', projectPath: '', summary: 'cli session' },
        { id: 'sess-shared', agentId: 'ag-earth', runtimeProvider: 'yeaft', catalogKey: 'yeaft:ag-earth:sess-shared', title: 'Collision Native Yeaft', status: 'done', updatedLabel: '2h', projectId: 'p-yeaft', projectName: 'Yeaft', projectPath: 'Yeaft', summary: 'native session' },
        { id: 'sess-2', agentId: 'ag-earth', runtimeProvider: 'yeaft', catalogKey: 'yeaft:ag-earth:sess-2', title: 'Hidden-FTS-Hit', status: 'done', updatedLabel: '3h', projectId: 'p-yeaft', projectName: 'Yeaft', projectPath: 'Yeaft', summary: 'unrelated summary' },
      ],
    };
    const saturnAgent = {
      id: 'ag-saturn',
      name: 'Saturn-Cloud',
      online: true,
      sessions: [
        { id: 'sess-shared', agentId: 'ag-saturn', runtimeProvider: 'yeaft', catalogKey: 'yeaft:ag-saturn:sess-shared', title: 'Saturn-Collision-Only', status: 'done', updatedLabel: '4h', projectId: null, projectName: '', projectPath: '', summary: 'saturn only' },
      ],
    };

    wrapper = mount(CosmosConversationDrawer, {
      props: {
        agent: earthAgent,
        planetId: 'earth',
        allAgents: [earthAgent, saturnAgent],
        agentToPlanet: { 'ag-earth': 'earth', 'ag-saturn': 'saturn' },
      },
      global: {
        config: { globalProperties: { $t: (k) => k } },
        stubs: {
          MessageList: true,
          ChatInput: true,
          SessionSceneSelect: true,
          YeaftConversationOutline: true,
          WorkbenchCapabilityHost: true,
          BrowserPanel: true,
          NavigationIcon: true,
        },
      },
    });

    // 1. Header displays Project chip for the active session
    expect(wrapper.find('.cosmos-drawer-project-chip').text()).toContain('Yeaft');

    // 2. Real WorkbenchPanel MUST become visible when store.workbenchExpanded flips to true
    //    (regression guard: passing :owner-route previously shadowed workbenchExpanded to false!)
    expect(wrapper.find('.workbench-content').attributes('style')).toContain('display: none');
    await wrapper.find('button[aria-label="cosmos.panel.workbench"]').trigger('click');
    await flushPromises();
    expect(store.workbenchExpanded).toBe(true);
    expect(wrapper.find('.cosmos-workbench-host').attributes('style') || '').not.toContain('display: none');
    expect(wrapper.find('.workbench-content').attributes('style') || '').not.toContain('display: none');
    expect(wrapper.findAll('.workbench-capability-card').length).toBeGreaterThanOrEqual(4);

    // Clicking WorkbenchPanel's own close button collapses chatStore.workbenchExpanded
    // Regression: open launcher then collapse Workbench via keyboard shortcut (toggleWorkbench)
    // must clear launcher state without restoring focus and MUST NOT consume the next Escape.
    wrapper.unmount();
    wrapper = mount(CosmosConversationDrawer, {
      attachTo: document.body,
      props: {
        agent: earthAgent,
        planetId: 'earth',
        allAgents: [earthAgent, saturnAgent],
        agentToPlanet: { 'ag-earth': 'earth', 'ag-saturn': 'saturn' },
      },
      global: {
        config: { globalProperties: { $t: (k) => k } },
        stubs: {
          MessageList: true,
          ChatInput: true,
          SessionSceneSelect: true,
          YeaftConversationOutline: true,
          WorkbenchCapabilityHost: true,
          BrowserPanel: true,
          NavigationIcon: true,
        },
      },
    });
    await wrapper.find('.workbench-add-btn').trigger('click');
    await flushPromises();
    expect(wrapper.find('.workbench-add-menu').exists()).toBe(true);
    // Simulate Alt+W keyboard collapse while launcher is open
    store.toggleWorkbench();
    await flushPromises();
    expect(store.workbenchExpanded).toBe(false);
    expect(wrapper.find('.workbench-add-menu').exists()).toBe(false);
    const escAfterCollapse = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    document.dispatchEvent(escAfterCollapse);
    expect(escAfterCollapse.defaultPrevented).toBe(false);

    // Re-open Workbench: even if an ancestor hides it via v-show (display:none) without collapsing
    // workbenchExpanded, fallback Escape must NOT consume the key for the invisible menu.
    store.toggleWorkbench();
    await flushPromises();
    await wrapper.find('.workbench-add-btn').trigger('click');
    await flushPromises();
    const hostEl = wrapper.find('.cosmos-workbench-host').element;
    hostEl.style.display = 'none';
    const escWhileAncestorHidden = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    document.dispatchEvent(escWhileAncestorHidden);
    expect(escWhileAncestorHidden.defaultPrevented).toBe(false);
    hostEl.style.display = '';
    await flushPromises();

    // When the menu IS rendered and visible (even with focus on document.body), fallback Escape consumes it.
    document.body.focus();
    const escWhileVisible = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    document.dispatchEvent(escWhileVisible);
    await flushPromises();
    expect(escWhileVisible.defaultPrevented).toBe(true);
    expect(wrapper.find('.workbench-add-menu').exists()).toBe(false);

    await wrapper.find('.workbench-panel-close').trigger('click');
    await flushPromises();
    expect(store.workbenchExpanded).toBe(false);

    // 3. Open ☰ switcher -> shows current planet's Project tree ONLY (never cross-planet)
    await wrapper.find('button[aria-label="cosmos.panel.history"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.cosmos-history-folder-name').text()).toBe('Yeaft');
    expect(wrapper.find('.cosmos-history-drawer').text()).not.toContain('Saturn-Collision-Only');

    // 4. Local mixed-provider collision keeps BOTH CLI and native Yeaft rows, never cross-planet,
    //    and FTS joins ONLY onto the native Yeaft row and emits native Yeaft route on click.
    const input = wrapper.find('.cosmos-history-search-input');
    await input.setValue('Collision');
    vi.advanceTimersByTime(250);
    await flushPromises();

    const discoveryReqs1 = sentFrames.filter((f) => f.type === 'session_discovery_request');
    expect(discoveryReqs1).toHaveLength(1);
    expect(discoveryReqs1[0].agentId).toBe('ag-earth');
    expect(discoveryReqs1.some((f) => f.agentId === 'ag-saturn')).toBe(false);

    acceptSessionDiscoveryResponse(store, {
      requestId: discoveryReqs1[0].requestId,
      agentId: 'ag-earth',
      op: 'search',
      ok: true,
      data: {
        indexedAt: Date.now(),
        results: [{ sessionId: 'sess-shared', snippet: 'Native Yeaft transcript match' }],
      },
    });
    await flushPromises();

    const collisionHits = wrapper.findAll('.cosmos-history-search-hit');
    expect(collisionHits).toHaveLength(2);
    const cliHit = collisionHits.find((el) => el.text().includes('Collision CLI Chat'));
    const yeaftHit = collisionHits.find((el) => el.text().includes('Collision Native Yeaft'));
    expect(cliHit).toBeDefined();
    expect(yeaftHit).toBeDefined();
    expect(cliHit.text()).not.toContain('Native Yeaft transcript match');
    expect(yeaftHit.text()).toContain('Native Yeaft transcript match');
    expect(wrapper.find('.cosmos-history-drawer').text()).not.toContain('Saturn-Collision-Only');

    // 5. Turn deletion epoch change immediately clears stale FTS snippet, aborts obsolete in-flight
    //    discovery response, and dispatches a fresh request for the active query.
    await input.setValue('quantum-flux');
    vi.advanceTimersByTime(250);
    await flushPromises();
    const firstQuantumReq = sentFrames.filter((f) => f.type === 'session_discovery_request').at(-1);
    acceptSessionDiscoveryResponse(store, {
      requestId: firstQuantumReq.requestId,
      agentId: 'ag-earth',
      op: 'search',
      ok: true,
      data: {
        indexedAt: Date.now(),
        results: [{ sessionId: 'sess-2', snippet: 'Pre-deletion snippet' }],
      },
    });
    await flushPromises();
    expect(wrapper.find('.cosmos-history-snippet').text()).toContain('Pre-deletion snippet');

    // Trigger a second search + simulate turn deletion before its response arrives
    store.yeaftTurnDeleteHistoryBySession = {
      'ag-earth\u001fsess-2': { agentId: 'ag-earth', sessionId: 'sess-2', epoch: 1 },
    };
    await flushPromises();
    // Stale pre-deletion snippet is cleared immediately
    expect(wrapper.findAll('.cosmos-history-snippet')).toHaveLength(0);
    vi.advanceTimersByTime(10);
    await flushPromises();
    const postDeleteReq = sentFrames.filter((f) => f.type === 'session_discovery_request').at(-1);
    expect(postDeleteReq.requestId).not.toBe(firstQuantumReq.requestId);

    // Trigger another deletion while postDeleteReq is in flight -> postDeleteReq must be aborted/ignored
    store.yeaftTurnDeleteHistoryBySession = {
      'ag-earth\u001fsess-2': { agentId: 'ag-earth', sessionId: 'sess-2', epoch: 2 },
    };
    await flushPromises();
    acceptSessionDiscoveryResponse(store, {
      requestId: postDeleteReq.requestId,
      agentId: 'ag-earth',
      op: 'search',
      ok: true,
      data: { indexedAt: Date.now(), results: [{ sessionId: 'sess-2', snippet: 'Stale delayed snippet' }] },
    });
    await flushPromises();
    expect(wrapper.find('.cosmos-history-drawer').text()).not.toContain('Stale delayed snippet');

    vi.advanceTimersByTime(10);
    await flushPromises();
    const freshReq = sentFrames.filter((f) => f.type === 'session_discovery_request').at(-1);
    acceptSessionDiscoveryResponse(store, {
      requestId: freshReq.requestId,
      agentId: 'ag-earth',
      op: 'search',
      ok: true,
      data: { indexedAt: Date.now(), results: [{ sessionId: 'sess-2', snippet: 'Fresh post-delete match' }] },
    });
    await flushPromises();
    expect(wrapper.find('.cosmos-history-snippet').text()).toContain('Fresh post-delete match');

    // Verify clicking the native FTS hit selects the native Yeaft session on ag-earth
    await wrapper.find('.cosmos-history-search-hit').trigger('click');
    const selected = wrapper.emitted('select-session');
    expect(selected.at(-1)[0]).toMatchObject({
      agentId: 'ag-earth',
      session: expect.objectContaining({ id: 'sess-2', runtimeProvider: 'yeaft' }),
    });

    // Verify user-bubble CSS keeps outer .message.user transparent and workbench host overrides light-theme tokens
    const convCss = readFileSync(join(resolve(process.cwd()), 'web', 'styles', 'cosmos', 'conversation.css'), 'utf-8');
    expect(convCss).toMatch(/\.cosmos-drawer\s+\.message\.user[\s\S]*?background:\s*transparent\s*!important/);
    expect(convCss).toMatch(/\.cosmos-workbench-host[\s\S]*?--bg-workbench:/);
    expect(convCss).toMatch(/\.cosmos-workbench-host\s+\.resize-handle/);
  });

  it('validates Cmd+K against live Agents, respects defaultPrevented on Escape, and computes containing-block-relative menu coordinates', async () => {
    vi.stubGlobal('Vue', Vue);
    const enterYeaft = vi.fn();
    const toggleWorkbench = vi.fn(function () {
      this.workbenchExpanded = !this.workbenchExpanded;
      if (!this.workbenchExpanded) this.workbenchMaximized = false;
    });
    const store = Vue.reactive({
      agents: [
        { id: 'ag-removed', name: 'Old-Mac', online: true, workDir: '/old', capabilities: [] },
        { id: 'ag-live', name: 'Live-Linux', online: true, workDir: '/live', capabilities: [] },
      ],
      currentAgent: 'ag-removed',
      sessionCatalog: [],
      yeaftConversationIdsByAgent: {},
      messagesMap: {},
      workbenchExpanded: false,
      workbenchMaximized: false,
      isYeaftSessionProcessing: () => false,
      isYeaftSessionUnread: () => false,
      enterYeaft,
      toggleWorkbench,
      setUiMode: vi.fn(),
    });
    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => store,
      useSessionsStore: () => ({ sessionList: [] }),
      useVpStore: () => ({}),
    });

    const { default: CosmosPage } = await import('../../web/components/cosmos/CosmosPage.js');
    wrapper = mount(CosmosPage, {
      global: {
        config: { globalProperties: { $t: (k) => k } },
        stubs: {
          CosmosQuickComposer: true,
          CosmosConversationDrawer: { template: '<div />', methods: { openSessionSwitcher() {}, closeSessionSwitcher() {}, isHistoryOpen: () => false } },
          CosmosConstantsPopover: true,
          CosmosEventsOverlay: true,
          SettingsPanel: true,
          AgentSettingsPanel: true,
          SessionCreateModal: true,
        },
      },
    });

    // Open drawer for ag-removed, close it, then remove ag-removed from inventory -> Cmd+K must fall back to ag-live
    wrapper.vm.drawerOpen = true;
    wrapper.vm.drawerAgentId = 'ag-removed';
    wrapper.vm.closeDrawer();
    store.agents = [{ id: 'ag-live', name: 'Live-Linux', online: true, workDir: '/live', capabilities: [] }];
    store.currentAgent = 'ag-removed';
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.vm.drawerOpen).toBe(true);
    expect(wrapper.vm.drawerAgent?.id).toBe('ag-live');
    expect(enterYeaft).not.toHaveBeenCalledWith('ag-removed');

    // Escape already consumed by a child menu (defaultPrevented=true) must NOT collapse Workbench
    store.workbenchExpanded = true;
    const consumedEsc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    consumedEsc.preventDefault();
    window.dispatchEvent(consumedEsc);
    await flushPromises();
    expect(store.workbenchExpanded).toBe(true);

    // Subsequent unhandled Escape DOES collapse Workbench cleanly
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await flushPromises();
    expect(store.workbenchExpanded).toBe(false);

    // If all agents disappear, Cmd+K must leave drawer closed and not call enterYeaft
    wrapper.vm.closeDrawer();
    enterYeaft.mockClear();
    store.agents = [];
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.vm.drawerOpen).toBe(false);
    expect(enterYeaft).not.toHaveBeenCalled();

    // Containing-block-relative menu coordinates & maxHeight constraint under a short backdrop-filter ancestor
    const host = document.createElement('div');
    host.style.backdropFilter = 'blur(28px)';
    host.getBoundingClientRect = () => ({ left: 952, top: 52, width: 488, height: 220, right: 1440, bottom: 272 });
    const menu = document.createElement('div');
    host.appendChild(menu);
    document.body.appendChild(host);
    try {
      const pos = clampFixedMenuCoordinates(menu, { viewportX: 1350, viewportY: 100, width: 200, height: 360, margin: 8, maxHeightCap: 420 });
      // Clamped inside host's 488px width (488 - 200 - 8 = 280) and constrained maxHeight (220 - 16 = 204)
      expect(pos.x).toBe(280);
      expect(pos.y).toBe(8);
      expect(pos.maxHeight).toBe(204);
    } finally {
      host.remove();
    }
  });

  it('localizes Quick Composer scenes via yeaft.session.scene.*, filters by agent capability, and renders unified upward tuning across Quick Composer & Drawer', async () => {
    vi.stubGlobal('Vue', Vue);
    const { default: zhCN } = await import('../../web/i18n/zh-CN.js');
    const { default: en } = await import('../../web/i18n/en.js');
    const { zhCN: cosmosZh, en: cosmosEn } = await import('../../web/i18n/cosmos.js');
    const zhDict = { ...zhCN, ...cosmosZh };
    const enDict = { ...en, ...cosmosEn };
    const tZh = (k) => zhDict[k] ?? k;
    const tEn = (k) => enDict[k] ?? k;

    const updateYeaftSessionScene = vi.fn().mockResolvedValue({ ok: true });
    const switchYeaftModel = vi.fn().mockResolvedValue({ ok: true });
    const store = Vue.reactive({
      currentView: 'yeaft',
      currentAgent: 'ag-earth',
      connectionState: 'connected',
      yeaftActiveSessionFilter: 'sess-1',
      yeaftModel: 'copilot/gemini-4-neon',
      yeaftModelEffort: 'medium',
      yeaftAvailableModels: [
        { id: 'copilot/gemini-4-neon', label: 'gemini-4-neon', provider: 'copilot', effortOptions: ['medium', 'high', 'xhigh'] },
      ],
      llmConfig: {
        'ag-saturn': {
          agentConfig: {
            primaryModel: 'copilot/gpt-6.2-sol',
            defaultEffort: 'xhigh',
            availableModels: [
              { id: 'copilot/gpt-6.2-sol', label: 'gpt-6.2-sol', provider: 'copilot', effortOptions: ['medium', 'xhigh', 'max'] },
            ],
          },
        },
      },
      yeaftHistorySearchState: { query: '', senderKey: 'user', loading: false, results: [], hasMore: false },
      workbenchExpanded: false,
      activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'ag-earth', sessionId: 'sess-1' },
      sessionProjects: [],
      hasAgentCapability: (agentId, cap) => {
        if (agentId === 'ag-earth') return cap === 'session_scenes' || cap === 'session_scene_frontend';
        return cap === 'session_scenes';
      },
      sendWsMessage: vi.fn(() => true),
      sendYeaftAutoRouteMessage: vi.fn().mockResolvedValue({ ok: true, sessionId: 'sess-1', decision: 'matched' }),
      updateYeaftSessionScene,
      switchYeaftModel,
    });
    const sessionRow = Vue.reactive({
      id: 'sess-1',
      name: 'Cosmos UI',
      agentId: 'ag-earth',
      sceneId: 'general',
      roster: [{ id: 'vp-1' }],
    });
    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => store,
      useSessionsStore: () => ({
        activeSessionId: 'sess-1',
        sessionById: (sid, aid) => (sid === 'sess-1' && aid === 'ag-earth' ? sessionRow : null),
      }),
      useVpStore: () => ({}),
    });

    const { default: CosmosQuickComposer } = await import('../../web/components/cosmos/CosmosQuickComposer.js');
    const { default: CosmosComposerTuning } = await import('../../web/components/cosmos/CosmosComposerTuning.js');
    const { default: CosmosConversationDrawer } = await import('../../web/components/cosmos/CosmosConversationDrawer.js');

    // 1. Quick Composer localized zh-CN scenes (no raw English IDs) + capability filter
    wrapper = mount(CosmosQuickComposer, {
      props: { agent: { id: 'ag-earth', name: 'Earth', online: true, liveSessions: [], sessions: [] }, planetId: 'earth' },
      global: {
        config: { globalProperties: { $t: tZh } },
        stubs: {
          ChatInput: { template: '<div><slot name="actions-start" /><slot name="actions-end-before" /></div>' },
        },
      },
    });
    const labelsZh = wrapper.vm.sceneOptions.map((o) => o.label);
    expect(labelsZh).toContain('AI 自动');
    expect(labelsZh).toContain('不指定场景');
    expect(labelsZh).toContain('软件开发');
    expect(labelsZh).toContain('前端开发');
    expect(labelsZh).toContain('内容创作');
    expect(labelsZh).toContain('投资');
    expect(labelsZh).not.toContain('short-video');
    expect(labelsZh).not.toContain('software');
    expect(labelsZh).not.toContain('视频剪辑'); // excluded when capability not advertised

    // Open unified tuning popover, verify scene chips + Escape closes ONLY popover
    const trigger = wrapper.find('.cosmos-tune-trigger');
    expect(trigger.exists()).toBe(true);
    await trigger.trigger('click');
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(true);
    const chipTexts = wrapper.findAll('.cosmos-tune-chip').map((c) => c.text());
    expect(chipTexts).toContain('前端开发');
    expect(chipTexts).toContain('内容创作');
    await wrapper.findAll('.cosmos-tune-chip').find((c) => c.text() === '前端开发').trigger('click');
    expect(wrapper.vm.selectedScene).toBe('frontend');
    expect(trigger.text()).toContain('前端开发');

    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    wrapper.find('.cosmos-tune').element.dispatchEvent(escEvent);
    await flushPromises();
    expect(escEvent.defaultPrevented).toBe(true);
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(false);
    expect(wrapper.emitted('close')).toBeUndefined();
    wrapper.unmount();

    // 2. Quick Composer EN localization check
    wrapper = mount(CosmosQuickComposer, {
      props: { agent: { id: 'ag-earth', name: 'Earth', online: true, liveSessions: [], sessions: [] }, planetId: 'earth' },
      global: {
        config: { globalProperties: { $t: tEn } },
        stubs: {
          ChatInput: { template: '<div><slot name="actions-start" /><slot name="actions-end-before" /></div>' },
        },
      },
    });
    const labelsEn = wrapper.vm.sceneOptions.map((o) => o.label);
    expect(labelsEn).toContain('AI Auto');
    expect(labelsEn).toContain('Software');
    expect(labelsEn).toContain('Frontend');
    expect(labelsEn).toContain('Content creation');
    wrapper.unmount();

    // 3. Drawer uses per-agent llmConfig fallback, unified tuning popover updates session scene,
    //    and closes popover when Workbench opens
    wrapper = mount(CosmosConversationDrawer, {
      props: {
        agent: { id: 'ag-earth', name: 'Earth', online: true, sessions: [{ id: 'sess-1', agentId: 'ag-earth', runtimeProvider: 'yeaft', title: 'Cosmos UI', status: 'idle', updatedLabel: 'now' }] },
        planetId: 'earth',
      },
      global: {
        config: { globalProperties: { $t: tZh } },
        stubs: {
          MessageList: true,
          WorkbenchPanel: true,
          YeaftConversationOutline: true,
          ChatInput: { template: '<div><slot name="actions-start" :in-action-menu="false" /><slot name="actions-end-before" /></div>' },
        },
      },
    });
    const drawerTrigger = wrapper.find('.cosmos-tune-trigger');
    expect(drawerTrigger.text()).toContain('gemini-4-neon');
    await drawerTrigger.trigger('click');
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(true);
    const frontendChip = wrapper.findAll('.cosmos-tune-chip').find((c) => c.text() === '前端开发');
    expect(frontendChip).toBeTruthy();
    await frontendChip.trigger('click');
    await flushPromises();
    expect(updateYeaftSessionScene).toHaveBeenCalledWith('sess-1', 'frontend', 'ag-earth');

    // Opening Workbench must cleanly close the open tuning popover
    store.workbenchExpanded = true;
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(false);
    wrapper.unmount();

    // 4. CosmosComposerTuning emits open-llm-config and closes immediately on Configure click
    wrapper = mount(CosmosComposerTuning, {
      props: {
        modelRows: [{ modelRef: 'copilot/gemini-4-neon', label: 'gemini-4-neon', model: { id: 'copilot/gemini-4-neon', provider: 'copilot' } }],
        activeModel: 'copilot/gemini-4-neon',
        activeModelLabel: 'gemini-4-neon',
        effortOptions: ['medium', 'high'],
        activeEffort: 'medium',
      },
      global: { config: { globalProperties: { $t: tZh } } },
    });
    await wrapper.find('.cosmos-tune-trigger').trigger('click');
    await wrapper.find('.cosmos-tune-config-link').trigger('click');
    expect(wrapper.emitted('open-llm-config')).toHaveLength(1);
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(false);
    wrapper.unmount();

    // 5. CSS preserves .attachment-item.has-error visual distinction in Cosmos composers
    const composerCss = readFileSync(resolve(process.cwd(), 'web/styles/cosmos/composer.css'), 'utf8');
    expect(composerCss).toMatch(/\.cosmos-composer-surface\s+\.attachment-item\.has-error\b/);
    expect(composerCss).toMatch(/\.cosmos-composer-surface\s+\.attachment-item\.has-error\s+\.attachment-status\b/);
  });

  it('enforces Quick Composer session_scenes gating, Drawer pending-model race safety, Workbench inertness, ARIA radiogroup keyboard nav & deferred scene races', async () => {
    vi.stubGlobal('Vue', Vue);
    const { default: zhCN } = await import('../../web/i18n/zh-CN.js');
    const { zhCN: cosmosZh } = await import('../../web/i18n/cosmos.js');
    const zhDict = { ...zhCN, ...cosmosZh };
    const tZh = (k) => zhDict[k] ?? k;

    // 1. Quick Composer: auto-route-only agent (no session_scenes) never renders or sends explicit scene;
    //    capability loss after selecting a scene resets and revalidates to 'auto' at send time.
    const capState = Vue.reactive({ hasScenes: false, hasFrontend: true });
    const sendAutoRoute = vi.fn().mockResolvedValue({ ok: true, sessionId: 'sess-1', decision: 'matched' });
    const quickStore = Vue.reactive({
      currentAgent: 'ag-earth',
      yeaftModel: 'copilot/gemini-4-neon',
      yeaftModelEffort: 'medium',
      yeaftAvailableModels: [
        { id: 'copilot/gemini-4-neon', label: 'gemini-4-neon', provider: 'copilot', effortOptions: ['medium', 'high'] },
      ],
      llmConfig: {},
      hasAgentCapability: (_aid, cap) => {
        if (cap === 'session_scenes') return capState.hasScenes;
        if (cap === 'session_scene_frontend') return capState.hasFrontend;
        return false;
      },
      sendWsMessage: vi.fn(() => true),
      sendYeaftAutoRouteMessage: sendAutoRoute,
    });
    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => quickStore,
      useSessionsStore: () => ({}),
      useVpStore: () => ({}),
    });

    const { default: CosmosQuickComposer } = await import('../../web/components/cosmos/CosmosQuickComposer.js');
    wrapper = mount(CosmosQuickComposer, {
      props: { agent: { id: 'ag-earth', name: 'Earth', online: true, liveSessions: [], sessions: [] }, planetId: 'earth' },
      global: {
        config: { globalProperties: { $t: tZh } },
        stubs: { ChatInput: { template: '<div><slot name="actions-end-before" /></div>' } },
      },
    });
    expect(wrapper.vm.supportsExplicitScenes).toBe(false);
    expect(wrapper.vm.sceneOptions).toEqual([]);
    await wrapper.find('.cosmos-tune-trigger').trigger('click');
    expect(wrapper.findAll('.cosmos-tune-chip')).toHaveLength(0);
    wrapper.vm.selectScene('software');
    expect(wrapper.vm.selectedScene).toBe('auto');
    await wrapper.vm.handleQuickSend('Hello auto-route');
    expect(sendAutoRoute).toHaveBeenLastCalledWith(expect.objectContaining({ preferredSceneId: 'auto' }));

    // Enable session_scenes, pick frontend, then revoke session_scenes before sending -> must revert to 'auto'
    capState.hasScenes = true;
    await flushPromises();
    expect(wrapper.vm.sceneOptions.some((o) => o.id === 'frontend')).toBe(true);
    wrapper.vm.selectScene('frontend');
    expect(wrapper.vm.selectedScene).toBe('frontend');
    capState.hasScenes = false;
    await flushPromises();
    expect(wrapper.vm.selectedScene).toBe('auto');
    await wrapper.vm.handleQuickSend('After capability loss');
    expect(sendAutoRoute).toHaveBeenLastCalledWith(expect.objectContaining({ preferredSceneId: 'auto' }));
    wrapper.unmount();

    // 2. Drawer: pending model preview prevents effort click reverting to old model, requires resolved Session,
    //    Workbench makes chat inert & blocks keyboard reopening, ARIA roving tabindex + Arrow nav,
    //    and deferred scene requests preserve focus, handle unconfirmed/late-ack/rejection & stale session switch.
    const modelA = { id: 'model-a', label: 'model-a', provider: 'copilot', effortOptions: ['low', 'medium'] };
    const modelB = { id: 'model-b', label: 'model-b', provider: 'copilot', effortOptions: ['medium', 'xhigh', 'max'] };
    const pendingModelMap = Vue.reactive({});
    const modelCalls = [];
    const switchYeaftModel = vi.fn((modelId, sessionId, effort) => {
      const key = `ag-earth\u001f${sessionId}`;
      pendingModelMap[key] = { model: modelId, modelEffort: effort || null };
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      modelCalls.push({ modelId, sessionId, effort, resolve, key });
      return promise;
    });

    const sceneCalls = [];
    const updateYeaftSessionScene = vi.fn((sessionId, sceneId, agentId) => {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      sceneCalls.push({ sessionId, sceneId, agentId, resolve, reject });
      return promise;
    });

    const sessionsMap = Vue.reactive({
      'sess-1': Vue.reactive({ id: 'sess-1', name: 'Session One', agentId: 'ag-earth', sceneId: 'general', config: { model: 'copilot/model-a', modelEffort: 'low' }, roster: [{ id: 'vp-1' }] }),
      'sess-2': Vue.reactive({ id: 'sess-2', name: 'Session Two', agentId: 'ag-earth', sceneId: 'software', config: { model: 'copilot/model-a', modelEffort: 'low' }, roster: [{ id: 'vp-1' }] }),
    });

    const drawerStore = Vue.reactive({
      currentView: 'yeaft',
      currentAgent: 'ag-earth',
      connectionState: 'connected',
      yeaftActiveSessionFilter: 'sess-1',
      yeaftModel: 'copilot/model-a',
      yeaftModelEffort: 'low',
      yeaftAvailableModels: [modelA, modelB],
      llmConfig: {},
      yeaftHistorySearchState: { query: '', senderKey: 'user', loading: false, results: [], hasMore: false },
      workbenchExpanded: false,
      activeSessionRoute: { runtimeProvider: 'yeaft', agentId: 'ag-earth', sessionId: 'sess-1' },
      sessionProjects: [],
      hasAgentCapability: (_aid, cap) => cap === 'session_scenes' || cap === 'session_scene_frontend',
      sessionModelSelectionFor: (sid, aid) => pendingModelMap[`${aid}\u001f${sid}`] || null,
      switchYeaftModel,
      updateYeaftSessionScene,
    });
    vi.stubGlobal('Pinia', {
      defineStore: () => () => ({}),
      useChatStore: () => drawerStore,
      useSessionsStore: () => ({
        get activeSessionId() { return drawerStore.yeaftActiveSessionFilter; },
        sessionById: (sid, aid) => (aid === 'ag-earth' ? (sessionsMap[sid] || null) : null),
      }),
      useVpStore: () => ({}),
    });

    const { default: CosmosConversationDrawer } = await import('../../web/components/cosmos/CosmosConversationDrawer.js');
    wrapper = mount(CosmosConversationDrawer, {
      attachTo: document.body,
      props: {
        agent: {
          id: 'ag-earth',
          name: 'Earth',
          online: true,
          sessions: [
            { id: 'sess-1', agentId: 'ag-earth', runtimeProvider: 'yeaft', title: 'Session One', status: 'idle', updatedLabel: 'now' },
            { id: 'sess-2', agentId: 'ag-earth', runtimeProvider: 'yeaft', title: 'Session Two', status: 'idle', updatedLabel: 'now' },
          ],
        },
        planetId: 'earth',
      },
      global: {
        config: { globalProperties: { $t: tZh } },
        stubs: {
          MessageList: true,
          WorkbenchPanel: true,
          YeaftConversationOutline: true,
          ChatInput: { template: '<div><slot name="actions-end-before" /></div>' },
        },
      },
    });

    // Open tuning via ArrowDown on trigger -> focus moves into popover & roving tabindex has exactly 1 tabbable radio per group
    const triggerEl = wrapper.find('.cosmos-tune-trigger').element;
    triggerEl.focus();
    await wrapper.find('.cosmos-tune').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(true);
    expect(wrapper.find('.cosmos-tune-popover').element.contains(document.activeElement)).toBe(true);
    const modelRadios = wrapper.findAll('.cosmos-tune-model-row');
    expect(modelRadios.filter((r) => r.attributes('tabindex') === '0')).toHaveLength(1);
    // Home on the already-checked first model preserves non-default effort and does NOT issue a Drawer write
    sessionsMap['sess-1'].config = { model: 'copilot/model-a', modelEffort: 'medium' };
    await flushPromises();
    const callsBeforeHome = modelCalls.length;
    await modelRadios[0].trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(document.activeElement).toBe(modelRadios[0].element);
    expect(modelCalls).toHaveLength(callsBeforeHome);
    expect(wrapper.vm.activeEffort).toBe('medium');

    // ArrowDown on the focused model radio moves focus, updates roving tabindex, AND immediately selects model-b
    // (WAI-ARIA APG standalone radiogroup: no click needed; first write is still pending!)
    await modelRadios[0].trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(document.activeElement).toBe(modelRadios[1].element);
    expect(modelRadios[1].attributes('tabindex')).toBe('0');
    expect(modelRadios[1].attributes('aria-checked')).toBe('true');
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({ modelId: 'copilot/model-b', sessionId: 'sess-1' });
    const segButtons = wrapper.findAll('.cosmos-tune-seg');
    expect(segButtons.map((b) => b.text())).toEqual(['中', '超高', '最高']);
    // Click '最高' ('max') BEFORE first write settles -> second write MUST target 'copilot/model-b', NOT old 'copilot/model-a'
    await segButtons[2].trigger('click');
    await flushPromises();
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[1]).toMatchObject({ modelId: 'copilot/model-b', sessionId: 'sess-1', effort: 'max' });
    delete pendingModelMap['ag-earth\u001fsess-1'];
    sessionsMap['sess-1'].config = { model: 'copilot/model-b', modelEffort: 'max' };
    modelCalls[0].resolve({ ok: true, superseded: true });
    modelCalls[1].resolve({ ok: true, superseded: false });
    await flushPromises();

    // Deferred Drawer scene change: preserves focus while pending, guards arrow/click during pending,
    // and handles unconfirmed + late snapshot ack + rejection
    const frontendChip = wrapper.findAll('.cosmos-tune-chip').find((c) => c.text() === '前端开发');
    frontendChip.element.focus();
    await frontendChip.trigger('click');
    await flushPromises();
    expect(sceneCalls).toHaveLength(1);
    expect(frontendChip.attributes('aria-busy')).toBe('true');
    expect(frontendChip.attributes('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(frontendChip.element); // focus NEVER drops to body!
    // Arrow navigation and clicks during pending scene write must NOT fire a duplicate scene update
    await frontendChip.trigger('keydown', { key: 'ArrowRight' });
    const writingChip = wrapper.findAll('.cosmos-tune-chip').find((c) => c.text() === '写作');
    await writingChip.trigger('click');
    expect(sceneCalls).toHaveLength(1);
    // Unconfirmed response shows error; late snapshot confirmation clears it
    sceneCalls[0].resolve({ ok: false, error: { code: 'scene_unconfirmed' } });
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-error').exists()).toBe(true);
    sessionsMap['sess-1'].sceneId = 'frontend';
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-error').exists()).toBe(false);

    // Rejection shows updateError
    await writingChip.trigger('click');
    await flushPromises();
    expect(sceneCalls).toHaveLength(2);
    sceneCalls[1].reject(new Error('network fail'));
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-error').exists()).toBe(true);

    // Stale completion after switching session MUST NOT pollute sess-2
    const softwareChip = wrapper.findAll('.cosmos-tune-chip').find((c) => c.text() === '软件开发');
    await softwareChip.trigger('click');
    await flushPromises();
    expect(sceneCalls).toHaveLength(3);
    drawerStore.yeaftActiveSessionFilter = 'sess-2';
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(false);
    sceneCalls[2].resolve({ ok: false, error: { code: 'failed' } });
    await flushPromises();
    await wrapper.find('.cosmos-tune-trigger').trigger('click');
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-error').exists()).toBe(false);

    // Workbench active makes .cosmos-drawer-chat inert, blocks keyboard reopening, and does NOT steal Escape
    drawerStore.workbenchExpanded = true;
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(false);
    expect(wrapper.find('.cosmos-drawer-chat').attributes('inert')).toBeDefined();
    expect(wrapper.find('.cosmos-drawer-chat').attributes('aria-hidden')).toBe('true');
    expect(wrapper.find('.cosmos-tune-trigger').attributes('disabled')).toBeDefined();
    await wrapper.find('.cosmos-tune').trigger('keydown', { key: 'ArrowDown' });
    await wrapper.find('.cosmos-tune-trigger').trigger('click');
    await flushPromises();
    expect(wrapper.find('.cosmos-tune-popover').exists()).toBe(false);
    const wbEsc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(wbEsc);
    expect(wbEsc.defaultPrevented).toBe(false);

    // Unresolved session (activeGroup === null) disables model/effort writes cleanly
    drawerStore.workbenchExpanded = false;
    drawerStore.yeaftActiveSessionFilter = 'sess-unresolved';
    await flushPromises();
    const beforeCalls = switchYeaftModel.mock.calls.length;
    wrapper.vm.selectModel('copilot/model-b', 'max');
    await flushPromises();
    expect(switchYeaftModel.mock.calls.length).toBe(beforeCalls);
    wrapper.unmount();

    // 3. visualViewport-only shrink (mobile soft keyboard keeping fixed layout anchor below visible bottom)
    //    must switch to the viewport-contained fallback so both popover edges stay strictly inside visualViewport.
    const { default: CosmosComposerTuning } = await import('../../web/components/cosmos/CosmosComposerTuning.js');
    const anchorHost = document.createElement('div');
    anchorHost.className = 'cosmos-quick-composer';
    anchorHost.getBoundingClientRect = () => ({ left: 20, top: 680, width: 320, height: 140, right: 340, bottom: 820 });
    document.body.appendChild(anchorHost);
    const prevVV = window.visualViewport;
    const vvMock = {
      offsetTop: 0,
      height: 360,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'visualViewport', { value: vvMock, configurable: true });
    try {
      wrapper = mount(CosmosComposerTuning, {
        attachTo: anchorHost,
        props: {
          modelRows: [
            { modelRef: 'copilot/model-a', label: 'model-a', model: { id: 'model-a', provider: 'copilot' } },
            { modelRef: 'copilot/model-b', label: 'model-b', model: { id: 'model-b', provider: 'copilot' } },
          ],
          activeModel: 'copilot/model-a',
          activeModelLabel: 'model-a',
          effortOptions: ['medium', 'high'],
          activeEffort: 'high',
        },
        global: { config: { globalProperties: { $t: tZh } } },
      });
      await wrapper.find('.cosmos-tune-trigger').trigger('click');
      await flushPromises();
      wrapper.vm.updatePopoverBounds();
      await flushPromises();
      const popEl = wrapper.find('.cosmos-tune-popover').element;
      expect(popEl.style.bottom).toBe('auto');
      const topPx = Number.parseFloat(popEl.style.top);
      const maxHPx = Number.parseFloat(popEl.style.maxHeight);
      const renderedTop = 680 + topPx;
      expect(renderedTop).toBeGreaterThanOrEqual(0);
      expect(renderedTop).toBeLessThanOrEqual(20);
      expect(renderedTop + maxHPx).toBeLessThanOrEqual(vvMock.height);

      // Home on the already-checked first model in Quick Composer preserves custom effort ('high') and emits nothing
      const firstRow = wrapper.findAll('.cosmos-tune-model-row')[0];
      firstRow.element.focus();
      await firstRow.trigger('keydown', { key: 'Home' });
      await flushPromises();
      expect(wrapper.emitted('select-model')).toBeUndefined();
      expect(wrapper.props('activeEffort')).toBe('high');
    } finally {
      wrapper?.unmount();
      wrapper = null;
      Object.defineProperty(window, 'visualViewport', { value: prevVV, configurable: true });
      anchorHost.remove();
    }
  });

  it('enforces WebGL event shader/particle orientation parity, async parallel compile failure fallback, non-leaking event textures, shockwave parallax, timeline a11y & cold-cache Mermaid drain', async () => {
    vi.stubGlobal('Vue', Vue);
    const { getEventFrag } = await import('../../web/cosmos/shaders-events.js');
    const { fillEventGpuParticles } = await import('../../web/cosmos/events-renderer.js');
    const { default: CosmosEventsOverlay } = await import('../../web/components/cosmos/CosmosEventsOverlay.js');
    const { renderMermaidIn, resetMermaidForTests } = await import('../../web/utils/markdown.js');

    // 1. All 8 modular event fragment shaders use strictly ascending GLSL ES 1.00 smoothstep / sstepDown
    for (let t = 0; t < 8; t++) {
      const src = getEventFrag(t);
      expect(src).toContain('sstepDown');
      // Check no literal numeric descending smoothstep(hi, lo, x)
      const numericSmoothsteps = [...src.matchAll(/smoothstep\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g)];
      for (const m of numericSmoothsteps) {
        expect(Number(m[1]), `Event ${t} descending smoothstep(${m[1]}, ${m[2]})`).toBeLessThan(Number(m[2]));
      }
    }

    // 2. GPU event particles align pixel-for-pixel with EVENT_VERT (Y-up) + GLSL rot2(uAngle)
    const buf = new Float32Array(520 * 7);
    // Gamma-Ray Burst (uAngle = -0.52): shader beam runs along (cos(-0.52), -sin(-0.52)) = (+0.868, +0.497) in Y-down
    // so particles with dx > 0 MUST have dy > 0 (same quadrant as shader beam, NOT counter-angled X!)
    const grbCount = fillEventGpuParticles(buf, {
      eventType: 5, x: 500, y: 400, eventRadiusPx: 200, progress: 0.45, elapsed: 9.0, alpha: 1.0, angle: -0.52, seed: 0.3,
    }, 1000, 800, 1.0, 1.0);
    expect(grbCount).toBeGreaterThan(50);
    let grbAligned = 0;
    for (let i = 0; i < grbCount; i++) {
      const dx = buf[i * 7] - 500;
      const dy = buf[i * 7 + 1] - 400;
      if (Math.hypot(dx, dy) > 40 && dx * dy > 0) grbAligned++;
    }
    expect(grbAligned / grbCount).toBeGreaterThan(0.7);

    // Stellar Superflare (Event 4, uAngle = -0.58): shader uses rot2(-uAngle) -> erupts upper-right (dx > 0, dy < 0 in Y-down)
    const flareCount = fillEventGpuParticles(buf, {
      eventType: 4, x: 500, y: 400, eventRadiusPx: 200, sunRadiusPx: 70, progress: 0.45, elapsed: 8.0, alpha: 1.0, angle: -0.58, seed: 0.2,
    }, 1000, 800, 1.0, 1.0);
    expect(flareCount).toBeGreaterThan(50);
    let flareUpperRight = 0;
    for (let i = 0; i < flareCount; i++) {
      const dx = buf[i * 7] - 500;
      const dy = buf[i * 7 + 1] - 400;
      if (dx > 0 && dy < 0) flareUpperRight++;
    }
    expect(flareUpperRight / flareCount).toBeGreaterThan(0.65);

    // Comet Breakup (Event 7, uAngle = 0): shader ionDir = (-0.94, +0.34) in Y-up -> trails up-left (dx < 0, dy < 0 in Y-down)
    const cometCount = fillEventGpuParticles(buf, {
      eventType: 7, x: 500, y: 400, eventRadiusPx: 200, progress: 0.48, elapsed: 9.0, alpha: 1.0, angle: 0, seed: 0.5,
    }, 1000, 800, 1.0, 1.0);
    expect(cometCount).toBeGreaterThan(50);
    let cometUpLeft = 0;
    for (let i = 0; i < cometCount; i++) {
      const dx = buf[i * 7] - 500;
      const dy = buf[i * 7 + 1] - 400;
      if (dx < 0 && dy < 0) cometUpLeft++;
    }
    expect(cometUpLeft / cometCount).toBeGreaterThan(0.6);

    // 3. Shockwave epicenter tracks camRot/parallax identically to computeEventFrame & focusActiveCosmicEvent rewinds >84%
    const simSw = createCosmicEventState({ autoEnabled: true, autoZoom: false, rng: () => 0.4 });
    startCosmicEvent(simSw, 'supernova', { observe: false, rng: () => 0.4 });
    simSw.active.elapsed = simSw.active.duration * 0.5;
    const camRot = { x: 0.45, y: -0.25 };
    const parallax = { x: 0.6, y: -0.4 };
    const evFrame = computeEventFrame(simSw, 1280, 720, 0, null, 1.0, camRot, parallax);
    const sw = getEventShockWave(simSw, 1280, 720, 0, null, 1.0, camRot, parallax);
    const expectedSwX = (evFrame.x / 1280 - 0.5) * (1280 / 720);
    const expectedSwY = 0.5 - evFrame.y / 720;
    expect(sw[0]).toBeCloseTo(expectedSwX, 5);
    expect(sw[1]).toBeCloseTo(expectedSwY, 5);

    simSw.active.elapsed = simSw.active.duration * 0.90;
    focusActiveCosmicEvent(simSw);
    expect(simSw.active.elapsed / simSw.active.duration).toBeCloseTo(0.14, 3);

    // 4. KHR_parallel_shader_compile: async polling -> fatal link failure notifies onFatalError & sets isFailed()
    const COMPLETION_STATUS_KHR = 0x91b1;
    let compileDone = false;
    let linkOk = false;
    const disabledAttribs = [];
    const makeParallelGl = (succeedLink) => {
      compileDone = false;
      linkOk = succeedLink;
      return {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
        ARRAY_BUFFER: 5, STATIC_DRAW: 6, DYNAMIC_DRAW: 7, TEXTURE_2D: 8,
        RGBA: 9, UNSIGNED_BYTE: 10, LINEAR: 11, LINEAR_MIPMAP_LINEAR: 12,
        TEXTURE_MIN_FILTER: 13, TEXTURE_MAG_FILTER: 14, TEXTURE_WRAP_S: 15, TEXTURE_WRAP_T: 16,
        REPEAT: 17, CLAMP_TO_EDGE: 18, BLEND: 19, ONE: 20, ONE_MINUS_SRC_ALPHA: 21,
        TRIANGLES: 22, POINTS: 23, FLOAT: 24, TEXTURE0: 25, COLOR_BUFFER_BIT: 26,
        createShader: () => ({}),
        shaderSource: () => {},
        compileShader: () => {},
        deleteShader: () => {},
        createProgram: () => ({}),
        attachShader: () => {},
        bindAttribLocation: () => {},
        linkProgram: () => {},
        getProgramParameter: (_p, param) => (param === COMPLETION_STATUS_KHR ? compileDone : linkOk),
        getProgramInfoLog: () => 'mock link error',
        getShaderInfoLog: () => '',
        deleteProgram: () => {},
        createBuffer: () => ({}),
        bindBuffer: () => {},
        bufferData: () => {},
        deleteBuffer: () => {},
        createTexture: () => ({}),
        bindTexture: () => {},
        texImage2D: () => {},
        texParameteri: () => {},
        deleteTexture: () => {},
        getAttribLocation: (_p, name) => (name === 'aPosPx' ? 0 : name === 'aSize' ? 1 : 2),
        getUniformLocation: () => ({}),
        useProgram: () => {},
        enable: () => {},
        disable: () => {},
        blendFunc: () => {},
        enableVertexAttribArray: () => {},
        disableVertexAttribArray: (loc) => disabledAttribs.push(loc),
        vertexAttribPointer: () => {},
        viewport: () => {},
        clearColor: () => {},
        clear: () => {},
        activeTexture: () => {},
        uniform1i: () => {},
        uniform1f: () => {},
        uniform2f: () => {},
        uniform3f: () => {},
        uniform4f: () => {},
        drawArrays: () => {},
        getParameter: () => 'Mock GPU',
        getExtension: (name) => (name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR } : null),
        isContextLost: () => false,
      };
    };

    const mkCanvas = (mockGl) => ({
      width: 0, height: 0, clientWidth: 640, clientHeight: 360,
      getContext: (k) => (k === 'webgl' ? mockGl : null),
      addEventListener: () => {}, removeEventListener: () => {},
    });
    const mkHud = () => ({ width: 0, height: 0, getContext: () => ({ setTransform: () => {}, clearRect: () => {} }) });

    // Re-entrant onFatalError that synchronously destroys and nulls the engine (matching CosmosPage.js)
    // must NOT throw or run post-destroy gl.clear() / hudDraw() calls.
    let clearCount = 0;
    const failGl = makeParallelGl(false);
    failGl.clear = () => { clearCount += 1; };
    let failEngine = null;
    const reentrantFatal = vi.fn(() => {
      failEngine?.destroy();
      failEngine = null;
    });
    failEngine = createCosmosEngine(mkCanvas(failGl), mkHud(), { onFatalError: reentrantFatal });
    expect(failEngine.isWebGL).toBe(true);
    expect(failEngine.isFailed()).toBe(false);
    // Frame 1: still compiling in background -> clears once, no fatal error yet
    const hud1 = vi.fn();
    failEngine.renderFrame({ hudDraw: hud1 });
    expect(reentrantFatal).not.toHaveBeenCalled();
    expect(clearCount).toBe(1);
    expect(hud1).toHaveBeenCalledTimes(1);
    // Frame 2: compile finishes with link failure -> fires reentrantFatal once, destroys engine, skips post-destroy clear/hudDraw
    compileDone = true;
    const hud2 = vi.fn();
    failEngine.renderFrame({ hudDraw: hud2 });
    expect(reentrantFatal).toHaveBeenCalledTimes(1);
    expect(failEngine).toBeNull();
    expect(clearCount).toBe(1);
    expect(hud2).not.toHaveBeenCalled();

    // Sync boot link failure (no parallel ext) falls back to 2D without prematurely firing onFatalError
    const syncFailGl = makeParallelGl(false);
    syncFailGl.getExtension = () => null;
    const syncFatalSpy = vi.fn();
    const syncFallback = createCosmosEngine(mkCanvas(syncFailGl), mkHud(), { onFatalError: syncFatalSpy });
    expect(syncFallback.mode).toBe('2d');
    expect(syncFatalSpy).not.toHaveBeenCalled();
    syncFallback.destroy();

    // Multi-frame drawCosmicEvent must disable aPosPx after drawParticles and request/upload nebula at most once
    disabledAttribs.length = 0;
    __resetCosmosTextureCacheForTests();
    const origImage = globalThis.Image;
    const spawnedNebulaImgs = [];
    class TrackedImage {
      constructor() { this.naturalWidth = 512; this.naturalHeight = 512; this._src = ''; }
      set src(v) { this._src = v; if (v.includes('veil_nebula.webp')) spawnedNebulaImgs.push(this); }
      get src() { return this._src; }
    }
    globalThis.Image = TrackedImage;
    let nebulaUploads = 0;
    const okGl = makeParallelGl(true);
    okGl.texImage2D = (_t, _l, _i, _w, _h, _b) => {
      if (_b instanceof TrackedImage && _b.src.includes('veil_nebula.webp')) nebulaUploads += 1;
    };
    let okEngine = null;
    try {
      okEngine = createCosmosEngine(mkCanvas(okGl), mkHud());
      compileDone = true;
      const sampleFrame = {
        time: 1, realTime: 1, scaleLog: 13,
        parallax: { x: 0, y: 0 }, camRot: { x: 0, y: 0 }, warp: 0, fovZoom: 1,
        shockWave: [0, 0, 0, 0], eventLens: [0, 0, 0, 0], eventAmbient: [0, 0, 0, 0],
        skyBright: 1, starDensity: 1,
        bhParams: { x: 0, y: 0, radius: 0.017, strength: 0.9 },
        galParams: { x: 0.4, y: -0.35, radius: 0.09, alpha: 0.7, tilt: 0.5 },
        webParams: { x: -0.4, y: -0.35, radius: 0.08, alpha: 0.5 },
        particleData: new Float32Array(2 * 7), particleCount: 2,
        eventDraw: {
          id: 'supernova', eventType: 0, layer: 'deep',
          x: 320, y: 180, eventRadiusPx: 80, quadRadiusPx: 196, sunRadiusPx: 27,
          progress: 0.45, elapsed: 9, alpha: 0.9, obsBlend: 0, distNorm: 4, angle: 0.2, seed: 0.4,
        },
        eventParticleData: new Float32Array(3 * 7), eventParticleCount: 3,
        solarBodies: [], solarAlpha: 1, hudDraw: vi.fn(),
      };
      okEngine.renderFrame(sampleFrame);
      okEngine.renderFrame(sampleFrame);
      okEngine.renderFrame(sampleFrame);
      expect(spawnedNebulaImgs).toHaveLength(1);
      spawnedNebulaImgs[0].onload();
      okEngine.renderFrame(sampleFrame);
      okEngine.renderFrame(sampleFrame);
      expect(nebulaUploads).toBe(1);
      expect(disabledAttribs).toContain(0);
      expect(disabledAttribs).toContain(1);
      expect(disabledAttribs).toContain(2);
    } finally {
      okEngine?.destroy();
      globalThis.Image = origImage;
      __resetCosmosTextureCacheForTests();
    }

    // 5. CosmosEventsOverlay timeline APG keyboard nav, distinct zoom slider label & Watch forceObserve
    wrapper = mount(CosmosEventsOverlay, {
      props: {
        visible: true,
        autoEnabled: true,
        autoZoom: false,
        activeEvent: {
          def: COSMIC_EVENTS[0],
          location: { sector: 'ne', distanceLy: 1600 },
          elapsed: 10.5,
          duration: 21,
          paused: false,
          targetZoom: 1.55,
          observing: true,
          effDist: 1.1,
          ambientDist: 4.5,
        },
        nextEventIndex: 1,
        countdownSec: 45,
      },
      global: { config: { globalProperties: { $t: (k) => k } } },
    });
    const zoomSlider = wrapper.find('.cosmos-ewd-range');
    expect(zoomSlider.attributes('aria-label')).toBe('cosmos.events.zoomRange');
    const timeline = wrapper.find('.cosmos-ewd-timeline');
    expect(timeline.attributes('aria-valuetext')).toContain('50%');
    await timeline.trigger('keydown', { key: 'Home' });
    await timeline.trigger('keydown', { key: 'End' });
    await timeline.trigger('keydown', { key: 'PageUp' });
    const scrubs = wrapper.emitted('scrub').map((a) => a[0]);
    expect(scrubs[0]).toBeCloseTo(0.005, 3);
    expect(scrubs[1]).toBeCloseTo(0.99, 3);
    expect(scrubs[2]).toBeCloseTo(0.65, 2);
    wrapper.unmount();
    wrapper = null;

    // 6. Cold-cache Mermaid auto-drain: calling renderMermaidIn before mermaid loads renders once loaded
    resetMermaidForTests();
    const prevMermaid = globalThis.mermaid;
    delete globalThis.mermaid;
    const host = document.createElement('div');
    host.innerHTML = '<div class="code-block-wrapper"><pre><code class="language-mermaid">graph TD; A-->B;</code></pre></div>';
    document.body.appendChild(host);
    try {
      await renderMermaidIn(host);
      expect(host.querySelector('.mermaid-rendered')).toBeNull();
      const renderMock = vi.fn(async () => ({ svg: '<svg><g/></svg>' }));
      globalThis.mermaid = { initialize: vi.fn(), render: renderMock };
      window.dispatchEvent(new Event('load'));
      await flushPromises();
      expect(renderMock).toHaveBeenCalledTimes(1);
      expect(host.querySelector('.mermaid-rendered')).not.toBeNull();
    } finally {
      host.remove();
      if (prevMermaid === undefined) delete globalThis.mermaid;
      else globalThis.mermaid = prevMermaid;
      resetMermaidForTests();
    }
  });
});
