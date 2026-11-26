// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { bakeProceduralWebGLTextures } from '../../web/cosmos/gpu-texture-baker.js';
import { createCosmosEngine } from '../../web/cosmos/gl-engine.js';

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

    const fakeGl = {
      VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
      ARRAY_BUFFER: 5, STATIC_DRAW: 6, DYNAMIC_DRAW: 7, FLOAT: 8, TRIANGLES: 9, POINTS: 10,
      TEXTURE_2D: 11, TEXTURE0: 12, RGBA: 13, UNSIGNED_BYTE: 14, LINEAR: 15,
      TEXTURE_MIN_FILTER: 16, TEXTURE_MAG_FILTER: 17, TEXTURE_WRAP_S: 18, TEXTURE_WRAP_T: 19,
      REPEAT: 20, CLAMP_TO_EDGE: 21, FRAMEBUFFER: 22, COLOR_ATTACHMENT0: 23,
      BLEND: 24, ONE: 25, ONE_MINUS_SRC_ALPHA: 26, RENDERER: 27,
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
      texImage2D: (_t, _l, _i, w, h) => { if (currentTex) { currentTex.w = w; currentTex.h = h; } },
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

    const engine = createCosmosEngine(glCanvas, hudCanvas);
    expect(engine.isWebGL).toBe(true);
    expect(typeof listeners.webglcontextlost).toBe('function');
    expect(typeof listeners.webglcontextrestored).toBe('function');

    // Simulate GPU context loss: preventDefault() must be called and GL draws skipped
    const lostEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    lost = true;
    listeners.webglcontextlost(lostEvent);
    expect(lostEvent.defaultPrevented).toBe(true);

    const drawsBeforeLost = drawArraysCount;
    const hudDraw = vi.fn();
    engine.renderFrame({ hudDraw });
    expect(drawArraysCount).toBe(drawsBeforeLost);
    expect(hudDraw).toHaveBeenCalledTimes(1);

    // Simulate GPU context restored: resources re-bake and GL rendering resumes
    lost = false;
    listeners.webglcontextrestored();
    expect(drawArraysCount).toBeGreaterThan(drawsBeforeLost);

    engine.destroy();
    expect(listeners.webglcontextlost).toBeUndefined();
    expect(listeners.webglcontextrestored).toBeUndefined();
  });
});
