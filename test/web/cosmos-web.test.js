// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Vue from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

// Expose reactive Pinia shim matching web/index.html runtime environment before importing web modules.
globalThis.Vue = Vue;
const storeDefs = new Map();
let storeInstances = new Map();
function resetPiniaStores() {
  storeInstances = new Map();
}
function instantiateStore(id) {
  if (storeInstances.has(id)) return storeInstances.get(id);
  const def = storeDefs.get(id);
  if (!def) throw new Error(`Unknown store: ${id}`);
  const stateObj = Vue.reactive(typeof def.state === 'function' ? def.state() : {});
  const store = stateObj;
  store.$reset = () => {
    const fresh = typeof def.state === 'function' ? def.state() : {};
    for (const key of Object.keys(fresh)) store[key] = fresh[key];
  };
  for (const [k, fn] of Object.entries(def.getters || {})) {
    const comp = Vue.computed(() => fn.call(store, store));
    Object.defineProperty(store, k, {
      get: () => comp.value,
      enumerable: true,
      configurable: true,
    });
  }
  for (const [k, fn] of Object.entries(def.actions || {})) {
    store[k] = fn.bind(store);
  }
  storeInstances.set(id, store);
  return store;
}
globalThis.Pinia = {
  defineStore: (id, def) => {
    storeDefs.set(id, def);
    return () => instantiateStore(id);
  },
};

import { zhCN as cosmosZh, en as cosmosEn } from '../../web/i18n/cosmos.js';
import {
  COSMIC_WEB_COLOR_MAP,
  buildSemanticCosmicWebGraph,
  projectCosmicWeb,
  triggerCosmicWebPulse,
} from '../../web/cosmos/web-graph.js';
import { drawCosmosHud } from '../../web/cosmos/particle-hud.js';

const { useCosmicWebStore } = await import('../../web/stores/cosmicWeb.js');
const { default: CosmosWebOverlay } = await import('../../web/components/cosmos/web/CosmosWebOverlay.js');

function makeMockCanvasCtx() {
  const grad = { addColorStop: vi.fn() };
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    arc: vi.fn(),
    ellipse: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    createRadialGradient: vi.fn(() => grad),
    createLinearGradient: vi.fn(() => grad),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
  };
}

describe('Cosmic Web — i18n, CSS token discipline & 3D semantic graph', () => {
  it('maintains 100% zh-CN / en key parity for all cosmos.web.* keys and covers every component key', () => {
    const zhWebKeys = Object.keys(cosmosZh).filter((k) => k.startsWith('cosmos.web.')).sort();
    const enWebKeys = Object.keys(cosmosEn).filter((k) => k.startsWith('cosmos.web.')).sort();
    expect(zhWebKeys.length).toBeGreaterThan(100);
    expect(zhWebKeys).toEqual(enWebKeys);
    for (const key of zhWebKeys) {
      expect(cosmosZh[key].trim().length).toBeGreaterThan(0);
      expect(cosmosEn[key].trim().length).toBeGreaterThan(0);
    }

    // Verify every single cosmos.web.* key referenced in Vue components exists in both dictionaries.
    const compDir = resolve(process.cwd(), 'web/components/cosmos/web');
    const referenced = new Set();
    for (const file of readdirSync(compDir)) {
      if (!file.endsWith('.js')) continue;
      const src = readFileSync(resolve(compDir, file), 'utf8');
      for (const match of src.matchAll(/['"](cosmos\.web\.[a-zA-Z0-9_.]+)['"]/g)) {
        referenced.add(match[1]);
      }
    }
    expect(referenced.size).toBeGreaterThan(80);
    for (const key of referenced) {
      expect(cosmosZh[key], `Missing zhCN key: ${key}`).toBeTruthy();
      expect(cosmosEn[key], `Missing en key: ${key}`).toBeTruthy();
    }
  });

  it('contains zero hardcoded hex or rgb/rgba color literals in web/styles/cosmos/web.css and web components', () => {
    const css = readFileSync(resolve(process.cwd(), 'web/styles/cosmos/web.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\s*\(/i);

    const compDir = resolve(process.cwd(), 'web/components/cosmos/web');
    for (const file of readdirSync(compDir)) {
      if (!file.endsWith('.js')) continue;
      const src = readFileSync(resolve(compDir, file), 'utf8');
      expect(src, `Hardcoded hex in ${file}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, `Hardcoded rgb() in ${file}`).not.toMatch(/\brgba?\s*\(/i);
    }
  });

  it('ships server/cosmic-web in root Dockerfile production stage', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY server/cosmic-web ./server/cosmic-web/');
  });

  it('builds deterministic 3D semantic graphs, projects nodes, triggers pulses, and renders on HUD without error', () => {
    expect(Object.keys(COSMIC_WEB_COLOR_MAP)).toEqual(['cyan', 'mint', 'gold', 'violet', 'rose', 'amber']);

    const ambient = buildSemanticCosmicWebGraph(null, null);
    expect(ambient.isAmbient).toBe(true);
    expect(ambient.nodes.length).toBeGreaterThan(10);

    const payload = {
      hubs: [
        { id: 'hub:ai', domainId: 'ai', labelZh: 'AI 与大模型', labelEn: 'AI & Models', colorToken: 'cyan', count: 2 },
        { id: 'hub:finance', domainId: 'finance', labelZh: '财经与市场', labelEn: 'Finance', colorToken: 'gold', count: 1 },
      ],
      nodes: [
        { id: 'cluster:c1', clusterId: 'c1', domainId: 'ai', headline: '大模型开源发布', colorToken: 'cyan', heatScore: 88, itemCount: 3, unread: true, watchHit: true },
        { id: 'cluster:c2', clusterId: 'c2', domainId: 'finance', headline: '算力芯片财报超预期', colorToken: 'gold', heatScore: 62, itemCount: 2, unread: false, watchHit: false },
      ],
      edges: [
        { from: 'hub:ai', to: 'cluster:c1', kind: 'domain', weight: 0.9 },
        { from: 'cluster:c1', to: 'cluster:c2', kind: 'cross', weight: 0.6 },
      ],
    };

    const g1 = buildSemanticCosmicWebGraph(payload, null);
    expect(g1.isAmbient).toBe(false);
    expect(g1.nodes).toHaveLength(4);
    expect(g1.edges.length).toBeGreaterThanOrEqual(2);

    // Deterministic rebuild preserves exact coordinates and carries excitation
    g1.nodes[0].excite = 0.77;
    const g2 = buildSemanticCosmicWebGraph(payload, g1);
    expect(g2.nodes[0].x).toBeCloseTo(g1.nodes[0].x, 6);
    expect(g2.nodes[0].y).toBeCloseTo(g1.nodes[0].y, 6);
    expect(g2.nodes[0].excite).toBeCloseTo(0.77, 5);

    const proj = projectCosmicWeb(g2, 1280, 720, { realTime: 1, camRot: { x: 0, y: 0 }, parallax: { x: 0, y: 0 } }, { centerShiftX: -120 });
    expect(proj).toHaveLength(4);
    expect(Number.isFinite(proj[0].x)).toBe(true);
    expect(Number.isFinite(proj[0].y)).toBe(true);

    const injected = triggerCosmicWebPulse(g2, { clusterId: 'c1', count: 5 });
    expect(injected).toBeGreaterThan(0);

    const ctx = makeMockCanvasCtx();
    drawCosmosHud(ctx, 1280, 720, {
      realTime: 1.5, time: 1.5, camRot: { x: 0, y: 0 }, parallax: { x: 0, y: 0 }, mouseX: 640, mouseY: 360,
      planetScreen: {}, telemetryBeams: [],
    }, g2, [], {}, {
      cx: 640, cy: 360, span: 400, tilt: 0.4, solarAlpha: 0, galAlpha: 0, webAlpha: 1,
      webCenterShiftX: -120, webHoveredClusterId: 'c1', webSelectedClusterId: 'c1', webFocusedDomainId: 'ai',
    });
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.quadraticCurveTo).toHaveBeenCalled();
  });
});

describe('Cosmic Web — Pinia store & interactive overlay', () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    resetPiniaStores();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  function mockApi(handlers) {
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
      const urlStr = String(url);
      const method = String(opts.method || 'GET').toUpperCase();
      for (const h of handlers) {
        if (h.match(urlStr, method)) {
          const body = typeof h.body === 'function' ? await h.body(urlStr, opts) : h.body;
          return {
            ok: (h.status || 200) < 400,
            status: h.status || 200,
            headers: { get: () => 'application/json' },
            json: async () => body,
            text: async () => JSON.stringify(body),
          };
        }
      }
      return {
        ok: false,
        status: 404,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: `Unhandled ${method} ${urlStr}` }),
        text: async () => '',
      };
    });
  }

  it('bootstraps, opens reader (marking read + fetching clean article), generates AI brief, and resets cleanly', async () => {
    mockApi([
      {
        match: (u) => u.startsWith('/api/cosmic-web/bootstrap'),
        body: {
          preferences: { onboarded: true, enabledDomains: ['ai', 'tech'], watchKeywords: ['大模型'], muteKeywords: [], customDomains: [], disabledSources: [], preferredAgentId: 'a1', defaultPerspective: 'balanced' },
          domains: [
            { id: 'ai', labelZh: 'AI 与大模型', labelEn: 'AI & Models', colorToken: 'cyan', unreadCount: 1, itemCount: 1, sources: [{ id: 'aihot', name: 'AIHot' }] },
          ],
          graph: { hubs: [{ id: 'hub:ai', domainId: 'ai', labelZh: 'AI 与大模型', labelEn: 'AI & Models', colorToken: 'cyan', count: 1 }], nodes: [], edges: [] },
          capableAgents: [{ id: 'a1', name: 'Workstation', online: true, supportsBriefing: true }],
          stats: { totalClusters: 1, unreadCount: 1, bookmarkedCount: 0, watchHitCount: 1 },
        },
      },
      {
        match: (u) => u.startsWith('/api/cosmic-web/feed'),
        body: {
          clusters: [
            { id: 'c1', domainId: 'ai', headline: '大模型架构新突破', summaryExcerpt: '核心性能提升两倍', primaryUrl: 'https://example.com/ai-1', sourceNames: ['AIHot', '36氪快讯'], itemCount: 2, heatScore: 82, unread: true, bookmarked: false, watchHit: true, publishedAt: Date.now() },
          ],
          total: 1,
          nextCursor: null,
        },
      },
      {
        match: (u, m) => u === '/api/cosmic-web/clusters/c1' && m === 'GET',
        body: {
          id: 'c1', domainId: 'ai', headline: '大模型架构新突破', primaryUrl: 'https://example.com/ai-1',
          items: [{ id: 'i1', sourceName: 'AIHot', title: '大模型架构新突破', url: 'https://example.com/ai-1' }],
        },
      },
      {
        match: (u) => u.startsWith('/api/cosmic-web/clusters/c1/article'),
        body: { title: '大模型架构新突破', markdown: '## 关键亮点\n\n性能翻倍。', quality: 'full', sourceUrl: 'https://example.com/ai-1' },
      },
      {
        match: (u, m) => u === '/api/cosmic-web/clusters/c1/state' && m === 'PATCH',
        body: { unread: false, bookmarked: false, muted: false },
      },
      {
        match: (u, m) => u === '/api/cosmic-web/clusters/c1/ai-brief' && m === 'POST',
        body: {
          tldr: '新一代架构将推理成本减半。',
          bullets: ['要点一', '要点二', '要点三'],
          impact: '加速本地与端侧部署普及。',
          followUps: ['对 Yeaft 引擎路由有何借鉴？', '对比现有模型吞吐如何？'],
          fullMarkdown: '新一代架构将推理成本减半。',
          agentName: 'Workstation',
        },
      },
    ]);

    const webStore = useCosmicWebStore();
    await webStore.bootstrap();
    expect(webStore.bootstrapped).toBe(true);
    expect(webStore.feedItems).toHaveLength(1);
    expect(webStore.stats.unreadCount).toBe(1);

    await webStore.openClusterReader('c1', { tab: 'article', expanded: false });
    expect(webStore.readerOpen).toBe(true);
    expect(webStore.articleData?.quality).toBe('full');
    expect(webStore.feedItems[0].unread).toBe(false);

    await webStore.generateAiBrief('c1', { mode: 'brief' });
    expect(webStore.aiBriefData?.tldr).toContain('推理成本减半');
    expect(webStore.aiBriefData?.followUps).toHaveLength(2);

    webStore.reset();
    expect(webStore.bootstrapped).toBe(false);
    expect(webStore.feedItems).toHaveLength(0);
  });

  it('mounts CosmosWebOverlay, renders feed & dispatches story to a Solar Planet Agent', async () => {
    const webStore = useCosmicWebStore();
    webStore.bootstrapped = true;
    webStore.prefs.onboarded = true;
    webStore.domains = [
      { id: 'ai', labelZh: 'AI 与大模型', labelEn: 'AI & Models', colorToken: 'cyan', unreadCount: 1, itemCount: 1, sources: [] },
    ];
    webStore.feedItems = [
      { id: 'c1', domainId: 'ai', colorToken: 'cyan', headline: '国产开源多模态模型发布', summaryExcerpt: '性能达到前沿水平', primaryUrl: 'https://example.com/news/1', sourceNames: ['36氪快讯'], itemCount: 1, heatScore: 76, unread: true, bookmarked: false, watchHit: true, publishedAt: Date.now() },
    ];

    const wrapper = mount(CosmosWebOverlay, {
      props: {
        visible: true,
        agents: [{ id: 'agent-1', name: 'Alpha', online: true }],
        agentToPlanet: { 'agent-1': 'earth' },
        isCompact: false,
      },
      global: {
        mocks: {
          $t: (k) => cosmosZh[k] || k,
        },
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('国产开源多模态模型发布');
    const dispatchBtn = wrapper.find('.cw-card-actions button:last-child');
    expect(dispatchBtn.exists()).toBe(true);
    await dispatchBtn.trigger('click');
    const emitted = wrapper.emitted('dispatch-to-planet');
    expect(emitted).toBeTruthy();
    expect(emitted[0][0]).toMatchObject({
      agentId: 'agent-1',
      planetId: 'earth',
      mode: 'fly',
      clusterId: 'c1',
      headline: '国产开源多模态模型发布',
    });

    wrapper.unmount();
  });
});
