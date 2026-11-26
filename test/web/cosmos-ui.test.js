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
  createCosmicEventState,
  startCosmicEvent,
  stopCosmicEvent,
  tickCosmicEvents,
  pickRandomEventIndex,
} from '../../web/cosmos/events-controller.js';
import {
  projectAgentsForCosmos,
  buildCosmosProjectSessionTree,
  filterCosmosSessions,
} from '../../web/cosmos/agent-projection.js';
import { acceptSessionDiscoveryResponse } from '../../web/stores/helpers/session-discovery.js';
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

    const engine = createCosmosEngine(glCanvas, hudCanvas);
    expect(engine.isWebGL).toBe(true);
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

    // Simulate GPU context restored: resources re-bake, cached real NASA/ESO textures re-upload, GL resumes
    lost = false;
    listeners.webglcontextrestored();
    expect(drawArraysCount).toBeGreaterThan(drawsBeforeLost);
    expect(uploadedImages.length).toBeGreaterThanOrEqual(uploadsBeforeRestore + 2);
    expect(engine.areRealTexturesReady()).toBe(true);

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

    // Multi-token search matches across Project path, title, and Agent name
    const allAgents = Object.values(projected);
    expect(filterCosmosSessions(allAgents, 'yeaft cosmos').map((h) => h.session.id)).toEqual(['s-2']);
    expect(filterCosmosSessions(allAgents, 'infra').map((h) => h.session.id)).toEqual(['s-3']);
    expect(filterCosmosSessions(allAgents, 'scratch').map((h) => h.session.id)).toEqual(['s-free']);
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
      agents: [
        {
          id: 'ag-earth',
          name: 'Earth-Mac',
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
        { id: 'sess-2', agentId: 'ag-earth', runtimeProvider: 'yeaft', catalogKey: 'yeaft:ag-earth:sess-2', title: 'Hidden-FTS-Hit', status: 'done', updatedLabel: '2h', projectId: 'p-yeaft', projectName: 'Yeaft', projectPath: 'Yeaft', summary: 'unrelated summary' },
      ],
    };

    wrapper = mount(CosmosConversationDrawer, {
      props: {
        agent: earthAgent,
        planetId: 'earth',
        allAgents: [earthAgent],
        agentToPlanet: { 'ag-earth': 'earth' },
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
    await wrapper.find('.workbench-panel-close').trigger('click');
    await flushPromises();
    expect(store.workbenchExpanded).toBe(false);

    // 3. Open ☰ switcher -> shows Project folder tree + runs live FTS discovery search
    await wrapper.find('button[aria-label="cosmos.panel.history"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('.cosmos-history-folder-name').text()).toBe('Yeaft');

    const input = wrapper.find('.cosmos-history-search-input');
    await input.setValue('quantum-flux');
    vi.advanceTimersByTime(250);
    await flushPromises();

    const searchFrame = sentFrames.find((f) => f.type === 'session_discovery_request');
    expect(searchFrame).toBeDefined();
    expect(searchFrame.payload).toEqual({ query: 'quantum-flux' });

    acceptSessionDiscoveryResponse(store, {
      requestId: searchFrame.requestId,
      agentId: 'ag-earth',
      op: 'search',
      ok: true,
      data: {
        indexedAt: Date.now(),
        results: [{ sessionId: 'sess-2', snippet: 'Matched quantum-flux discussion in transcript' }],
      },
    });
    await flushPromises();

    const hits = wrapper.findAll('.cosmos-history-search-hit');
    expect(hits).toHaveLength(1);
    expect(hits[0].text()).toContain('Hidden-FTS-Hit');
    expect(hits[0].text()).toContain('Matched quantum-flux discussion');

    // Verify user-bubble CSS keeps outer .message.user transparent and workbench host overrides light-theme tokens
    const convCss = readFileSync(join(resolve(process.cwd()), 'web', 'styles', 'cosmos', 'conversation.css'), 'utf-8');
    expect(convCss).toMatch(/\.cosmos-drawer\s+\.message\.user[\s\S]*?background:\s*transparent\s*!important/);
    expect(convCss).toMatch(/\.cosmos-workbench-host[\s\S]*?--bg-workbench:/);
    expect(convCss).toMatch(/\.cosmos-workbench-host\s+\.resize-handle/);
  });
});
