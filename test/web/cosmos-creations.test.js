// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

import { zhCN as creationsZh, en as creationsEn } from '../../web/i18n/creations.js';
import { drawCosmosHud } from '../../web/cosmos/particle-hud.js';
import { createCreationService } from '../../agent/yeaft/creations/service.js';
import { createCreationRelay } from '../../server/handlers/client-creation.js';

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

describe('Cosmos Creations — i18n, styles & celestial HUD', () => {
  it('maintains 100% zh-CN / en key parity and non-empty values', () => {
    const zhKeys = Object.keys(creationsZh).sort();
    const enKeys = Object.keys(creationsEn).sort();
    expect(zhKeys.length).toBeGreaterThan(100);
    expect(zhKeys).toEqual(enKeys);
    for (const key of zhKeys) {
      expect(typeof creationsZh[key]).toBe('string');
      expect(creationsZh[key].trim().length).toBeGreaterThan(0);
      expect(typeof creationsEn[key]).toBe('string');
      expect(creationsEn[key].trim().length).toBeGreaterThan(0);
    }
  });

  it('contains no hardcoded hex or rgb colors in creation Vue components', () => {
    const root = resolve(process.cwd(), 'web/components/cosmos/creations');
    const collect = (dir) => {
      const out = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collect(full));
        else if (entry.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const files = collect(root);
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content, `Hardcoded color in ${file}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    }
  });

  it('draws all 4 celestial kinds and lifecycle states in galaxy HUD without throwing', () => {
    const ctx = makeMockCanvasCtx();
    const state = {
      galAlpha: 0.95,
      solarAlpha: 0,
      webAlpha: 0,
      parallax: { x: 0, y: 0 },
      camRot: { x: 0, y: 0 },
      realTime: 12.5,
      time: 4.2,
      mouseX: 0,
      mouseY: 0,
      planetScreen: {},
    };
    const stars = [
      { id: 'c1', kind: 'book', status: 'active', r: 0.35, theta: 0.5, unitCount: 120, sourceCount: 3 },
      { id: 'c2', kind: 'deck', status: 'generating', activeRunProgress: 0.45, r: 0.48, theta: 2.0, unitCount: 12, sourceCount: 1 },
      { id: 'c3', kind: 'gallery', status: 'seed', r: 0.56, theta: 3.4, unitCount: 0, sourceCount: 2 },
      { id: 'c4', kind: 'video', status: 'needs_attention', r: 0.62, theta: 5.1, unitCount: 5, sourceCount: 4 },
      { id: 'legacy', title: 'Legacy Book', r: 0.42, theta: 1.1, color: '#7cc4ff' },
    ];
    const layout = { cx: 640, cy: 360, span: 500, tilt: 0.4, solarAlpha: 0, galAlpha: 0.95, webAlpha: 0 };
    expect(() => drawCosmosHud(ctx, 1280, 720, state, null, stars, {}, layout, null)).not.toThrow();
    expect(ctx.ellipse).toHaveBeenCalled();
    expect(ctx.arc).toHaveBeenCalled();
  });
});

describe('Cosmos Creations — End-to-End Web Store <-> Server Relay <-> Agent Service', () => {
  let tempDirA;
  let tempDirB;
  let serviceA;
  let serviceB;
  let relay;
  let creationsStore;
  let chatStore;

  beforeEach(async () => {
    tempDirA = mkdtempSync(join(tmpdir(), 'yeaft-creations-web-a-'));
    tempDirB = mkdtempSync(join(tmpdir(), 'yeaft-creations-web-b-'));
    resetPiniaStores();

    const [{ useChatStore }, { useCreationsStore }] = await Promise.all([
      import('../../web/stores/chat.js'),
      import('../../web/stores/creations.js'),
    ]);
    chatStore = useChatStore();
    creationsStore = useCreationsStore();

    const webClient = { authenticated: true, userId: 'alice', role: 'user' };
    const agentMap = new Map();
    const services = new Map();

    relay = createCreationRelay({
      agentMap,
      accessError: (agentId, userId) => {
        if (userId !== 'alice') return 'Agent access denied';
        return agentMap.has(agentId) ? null : 'Agent not found or offline';
      },
      isActive: () => true,
      skipAuth: () => false,
      send: async (_client, msg) => {
        if (msg.type === 'creation_response') {
          creationsStore.handleCreationResponse(msg);
        }
      },
      forward: async (agent, msg) => {
        const svc = services.get(agent.id);
        try {
          const data = await svc.request({ op: msg.op, payload: msg.payload });
          await relay.response(agent.id, agent, {
            type: 'creation_response',
            requestId: msg.requestId,
            op: msg.op,
            ok: true,
            data,
          });
        } catch (err) {
          await relay.response(agent.id, agent, {
            type: 'creation_response',
            requestId: msg.requestId,
            op: msg.op,
            ok: false,
            error: err.message,
            errorCode: String(err.code || 'error').toLowerCase(),
          });
        }
        return true;
      },
    });

    const mockEngineFactory = ({ toolRegistry }) => ({
      async *query({ prompt }) {
        const tool = toolRegistry.get('creation_upsert_outlines');
        if (tool && prompt.includes('outline_now')) {
          yield { type: 'tool_start', id: 'tc-1', name: 'creation_upsert_outlines' };
          await tool.execute({
            nodes: [
              { title: 'Volume 1', type: 'folder', outlineMd: 'Opening arc' },
              { title: 'Chapter 1', type: 'unit', outlineMd: 'Hero awakens' },
            ],
          });
          yield { type: 'tool_end', id: 'tc-1', name: 'creation_upsert_outlines', isError: false };
        }
        yield { type: 'text_delta', text: 'Planned ' };
        yield { type: 'text_delta', text: 'successfully.' };
        yield { type: 'turn_end', terminal: true, stopReason: 'end_turn' };
      },
    });

    serviceA = createCreationService({
      yeaftDir: tempDirA,
      engineFactory: mockEngineFactory,
      emitEvent: (event) => {
        creationsStore.handleCreationEvent({ type: 'creation_event', agentId: 'agent-a', event });
      },
    });
    serviceB = createCreationService({
      yeaftDir: tempDirB,
      engineFactory: mockEngineFactory,
      emitEvent: (event) => {
        creationsStore.handleCreationEvent({ type: 'creation_event', agentId: 'agent-b', event });
      },
    });

    agentMap.set('agent-a', { id: 'agent-a', capabilities: ['creations'] });
    agentMap.set('agent-b', { id: 'agent-b', capabilities: ['creations'] });
    services.set('agent-a', serviceA);
    services.set('agent-b', serviceB);

    chatStore.sendWsMessage = vi.fn((msg) => {
      if (msg.type === 'creation_request') {
        void relay.request(webClient, msg);
        return true;
      }
      return true;
    });
  });

  afterEach(async () => {
    creationsStore?.clearAll();
    relay?.close();
    await serviceA?.close();
    await serviceB?.close();
    rmSync(tempDirA, { recursive: true, force: true });
    rmSync(tempDirB, { recursive: true, force: true });
  });

  it('enforces strict per-Agent isolation and round-trips full Creation lifecycle', async () => {
    // 1. Create on agent-a and agent-b separately
    const resA = await creationsStore.createCreation('agent-a', {
      title: 'Cyber Xianxia 500',
      kind: 'book',
      prompt: 'Build a 500-chapter novel',
      autoPlan: false,
      textSources: [{ title: 'Seed Lore', content: 'Spirit code runs beneath Iron City.' }],
    });
    const resB = await creationsStore.createCreation('agent-b', {
      title: 'Q4 Deck',
      kind: 'deck',
      autoPlan: false,
    });

    expect(resA.creation.id).toBeTruthy();
    expect(resB.creation.id).toBeTruthy();

    await creationsStore.selectGalaxyAgent('agent-a', { force: true });
    expect(creationsStore.currentAgentCreations.map((c) => c.title)).toEqual(['Cyber Xianxia 500']);

    await creationsStore.selectGalaxyAgent('agent-b', { force: true });
    expect(creationsStore.currentAgentCreations.map((c) => c.title)).toEqual(['Q4 Deck']);

    // 2. Open creation on agent-a -> defaults to studio (no readable content yet)
    await creationsStore.openCreation('agent-a', resA.creation.id);
    expect(creationsStore.activeCreation.mode).toBe('studio');

    // 3. Upsert locked Canon (world + ledger) and verify fields survive round-trip
    const canonItem = await creationsStore.upsertCanon('agent-a', resA.creation.id, {
      type: 'ledger',
      title: 'Foreshadowing Tracker',
      contentMd: 'Major plot hooks',
      state: { rows: [{ name: 'Northern Abyss', detail: 'Elder dying words', status: 'open' }] },
      pinned: true,
      lockedByUser: true,
    });
    expect(canonItem.lockedByUser).toBe(true);
    expect(canonItem.state.rows[0].name).toBe('Northern Abyss');

    // 4. Create multi-modality units inside the same Creation (markdown_doc + image_gallery)
    const ch1 = await creationsStore.createNode('agent-a', resA.creation.id, {
      nodeType: 'unit',
      modality: 'markdown_doc',
      title: 'Chapter 1',
      outlineMd: 'Rain in Iron City',
      content: '# Chapter 1\n\nAcid rain fell over the spirit conduits.',
    });
    const artGallery = await creationsStore.createNode('agent-a', resA.creation.id, {
      nodeType: 'unit',
      modality: 'image_gallery',
      title: 'Character Art',
      content: JSON.stringify({ frames: [{ frameId: 'f1', title: 'Lin Chen', caption: 'Protagonist' }] }),
    });
    expect(ch1.node.modality).toBe('markdown_doc');
    expect(artGallery.node.modality).toBe('image_gallery');

    // 5. Re-open creation -> now has readable content -> defaults to Read Mode!
    await creationsStore.openCreation('agent-a', resA.creation.id);
    expect(creationsStore.activeCreation.mode).toBe('read');

    // 6. Propose edit on Chapter 1 -> shows up in pendingProposalsForActive -> accept updates content
    const prop = serviceA.store.proposeUnitEdit(resA.creation.id, ch1.node.id, {
      proposedContent: '# Chapter 1\n\nAcid rain hissed across the rusty spirit conduits.',
      summary: 'Sharpen sensory verb',
    });
    await creationsStore.loadNode('agent-a', resA.creation.id, ch1.node.id);
    expect(creationsStore.pendingProposalsForActive.unitProposals.some((p) => p.id === prop.id)).toBe(true);

    await creationsStore.resolveProposal('agent-a', resA.creation.id, prop.id, 'accept');
    expect(creationsStore.activeNodeContent.content).toContain('hissed across the rusty');
    expect(creationsStore.pendingProposalsForActive.unitProposals.length).toBe(0);

    // 7. Send scoped message -> streams events cleanly into threadMessagesByKey
    const turn = await creationsStore.sendMessage('agent-a', resA.creation.id, {
      scopeType: 'global',
      text: 'outline_now please create Volume 1 and Chapter 1 outline',
    });
    await serviceA.runner.waitForRun(turn.run.id);
    const threadBucket = creationsStore.threadMessagesByKey[`agent-a\u001f${resA.creation.id}\u001f${turn.threadId}`];
    expect(threadBucket.messages.some((m) => m.role === 'assistant' && m.content.includes('Planned successfully.'))).toBe(true);
    expect(threadBucket.streamingMessage).toBeNull();

    // 8. Export Markdown & check safe mediaUrl (no JWT token in URL!)
    const exported = await creationsStore.exportCreation('agent-a', resA.creation.id, 'markdown');
    expect(exported.content).toContain('Cyber Xianxia 500');
    expect(exported.content).toContain('hissed across the rusty');

    const url = creationsStore.mediaUrl('agent-a', resA.creation.id, 'source', 'src-1');
    expect(url).toBe(`/api/yeaft/creations/agent-a/${resA.creation.id}/media/source/src-1`);
    expect(url).not.toContain('token=');
  });

  it('mounts CosmosGalaxyOverlay and CreationInteriorModal across all 4 modalities without error', async () => {
    const [{ default: CosmosGalaxyOverlay }, { default: CreationInteriorModal }] = await Promise.all([
      import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js'),
      import('../../web/components/cosmos/creations/CreationInteriorModal.js'),
    ]);

    const res = await creationsStore.createCreation('agent-a', {
      title: 'Multi-Modal Masterpiece',
      kind: 'book',
      autoPlan: false,
    });
    const bookNode = await creationsStore.createNode('agent-a', res.creation.id, {
      nodeType: 'unit', modality: 'markdown_doc', title: 'Book Ch 1', content: 'Hello **Universe**',
    });
    const deckNode = await creationsStore.createNode('agent-a', res.creation.id, {
      nodeType: 'unit', modality: 'slide_deck', title: 'Pitch Deck',
      content: JSON.stringify({ slides: [{ slideId: 's1', layout: 'title', title: 'Cosmos Deck', bullets: ['Fast', 'Per-Agent'] }] }),
    });
    const videoNode = await creationsStore.createNode('agent-a', res.creation.id, {
      nodeType: 'unit', modality: 'video_episode', title: 'Intro Lesson',
      content: JSON.stringify({ scenes: [{ sceneId: 'sc1', title: 'Opening', durationSec: 12, narration: 'Welcome aboard', caption: 'Welcome aboard' }] }),
    });

    await creationsStore.selectGalaxyAgent('agent-a', { force: true });
    const $t = (k) => creationsZh[k] || k;

    // Mount L1/L2 Galaxy Overlay
    const galaxyWrapper = mount(CosmosGalaxyOverlay, {
      props: {
        visible: true,
        agents: [
          { id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] },
          { id: 'agent-b', name: 'Beta', online: true, capabilities: ['creations'] },
        ],
      },
      global: { mocks: { $t } },
    });
    await flushPromises();
    expect(galaxyWrapper.text()).toContain('Alpha');
    expect(galaxyWrapper.text()).toContain('Beta');

    // Switch to Star Catalog view & verify card renders
    creationsStore.viewMode = 'catalog';
    await flushPromises();
    expect(galaxyWrapper.text()).toContain('Multi-Modal Masterpiece');
    galaxyWrapper.unmount();

    // Open L3 Creation Interior & verify Read/Studio + modality switching
    await creationsStore.openCreation('agent-a', res.creation.id, { mode: 'read' });
    const interiorWrapper = mount(CreationInteriorModal, {
      global: { mocks: { $t } },
    });
    await flushPromises();
    expect(interiorWrapper.text()).toContain('Multi-Modal Masterpiece');

    // Switch to Deck unit -> renders DeckReader slide title
    await creationsStore.selectNode(deckNode.node.id);
    await flushPromises();
    expect(interiorWrapper.text()).toContain('Cosmos Deck');

    // Switch to Video unit -> renders VideoReader scene narration/caption
    await creationsStore.selectNode(videoNode.node.id);
    await flushPromises();
    expect(interiorWrapper.text()).toContain('Welcome aboard');

    // Switch to Studio mode -> renders 3-pane workbench
    creationsStore.setActiveMode('studio');
    await flushPromises();
    expect(interiorWrapper.find('.creation-studio-layout').exists() || interiorWrapper.text().includes('Book Ch 1')).toBe(true);

    // Ensure bookNode still selectable
    await creationsStore.selectNode(bookNode.node.id);
    await flushPromises();
    expect(interiorWrapper.text()).toContain('Book Ch 1');

    // Mount Gallery modality inside CreationInteriorModal (B11)
    const galleryNode = await creationsStore.createNode('agent-a', res.creation.id, {
      nodeType: 'unit', modality: 'image_gallery', title: 'Concept Art',
      content: JSON.stringify({
        frames: [{ frameId: 'f1', title: 'Nebula Gate', caption: 'Opening frame', assetId: 'asset-1' }],
      }),
    });
    await creationsStore.selectNode(galleryNode.node.id);
    await flushPromises();
    expect(interiorWrapper.text()).toContain('Nebula Gate');
    const imgEl = interiorWrapper.find('.creation-gallery-img');
    expect(imgEl.exists()).toBe(true);
    expect(imgEl.attributes('src')).toBe(`/api/yeaft/creations/agent-a/${res.creation.id}/media/asset/asset-1`);

    interiorWrapper.unmount();
  });

  it('B03: GalleryReader renders sandboxed img mediaUrl and NEVER injects svgMarkup via v-html', async () => {
    const { default: GalleryReader } = await import('../../web/components/cosmos/creations/readers/GalleryReader.js');
    const $t = (k) => creationsZh[k] || k;
    const wrapper = mount(GalleryReader, {
      props: {
        node: { id: 'n-gal', title: 'Art', modality: 'image_gallery', currentRevId: 'rev-1' },
        agentId: 'agent-a',
        creationId: 'cre-1',
        content: JSON.stringify({
          frames: [
            {
              frameId: 'f-asset',
              title: 'Safe Asset',
              assetId: 'a-123',
              svgMarkup: '<svg onload="alert(1)"><script>window.__xss=1</script></svg>',
            },
            {
              frameId: 'f-svg-only',
              title: 'Untrusted SVG Only',
              prompt: 'Starfield sketch',
              svgMarkup: '<svg><script>window.__xss2=1</script><circle cx="10" cy="10" r="5" /></svg>',
            },
          ],
        }),
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // Asset frame renders via <img> pointing to authenticated mediaUrl
    const imgs = wrapper.findAll('img.creation-gallery-img');
    expect(imgs.length).toBe(1);
    expect(imgs[0].attributes('src')).toBe('/api/yeaft/creations/agent-a/cre-1/media/asset/a-123');

    // No inline <svg> or <script> injected anywhere in Grid or Lightbox
    expect(wrapper.find('svg').exists()).toBe(false);
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.text()).toContain('Starfield sketch');

    // Open Lightbox on the svgMarkup-only frame -> still no <svg>
    await wrapper.findAll('.creation-gallery-media')[1].trigger('click');
    await flushPromises();
    expect(wrapper.find('.creation-gallery-lightbox').exists()).toBe(true);
    expect(wrapper.find('svg').exists()).toBe(false);
    wrapper.unmount();
  });

  it('B03: BookReader and DirectorChatPane sanitize script, onerror, and javascript: links before DOM insertion', async () => {
    const [{ default: BookReader }, { default: DirectorChatPane }, { sanitizeCreationHtml }] = await Promise.all([
      import('../../web/components/cosmos/creations/readers/BookReader.js'),
      import('../../web/components/cosmos/creations/studio/DirectorChatPane.js'),
      import('../../web/components/cosmos/creations/sanitize.js'),
    ]);

    const hostileHtml = '<p>Safe</p><script>alert(1)</script><img src="https://example.com/a.png" onerror="alert(2)"><a href="javascript:alert(3)">click</a><iframe src="about:blank"></iframe><svg onload="alert(4)"></svg>';
    const cleaned = sanitizeCreationHtml(hostileHtml);
    expect(cleaned).toContain('Safe');
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('onerror');
    expect(cleaned).not.toContain('javascript:');
    expect(cleaned).not.toContain('<iframe');
    expect(cleaned).not.toContain('<svg');

    const $t = (k) => creationsZh[k] || k;
    const bookWrapper = mount(BookReader, {
      props: {
        node: { id: 'n-book', title: 'Ch 1', modality: 'markdown_doc', currentRevId: 'r1' },
        agentId: 'agent-a',
        creationId: 'cre-1',
        content: 'Hello <script>alert(1)</script> <img src="x" onerror="alert(2)"> <a href="javascript:alert(3)">bad</a>',
      },
      global: { mocks: { $t } },
    });
    await flushPromises();
    const bookHtml = bookWrapper.find('.markdown-body').html();
    expect(bookHtml).not.toContain('<script');
    expect(bookHtml).not.toContain('onerror');
    expect(bookHtml).not.toContain('javascript:');
    bookWrapper.unmount();

    const tKey = `agent-a\u001fcre-1\u001fglobal:global`;
    creationsStore.threadMessagesByKey[tKey] = {
      thread: { id: 'global:global', scopeType: 'global', scopeId: null },
      messages: [
        { id: 'm1', role: 'assistant', content: 'Hi <script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a>' },
      ],
      contextPreview: null,
      streamingMessage: {
        id: 'm-stream',
        role: 'assistant',
        content: 'Streaming <script>alert(9)</script><img src="y" onerror="alert(9)">',
        toolStatus: null,
      },
    };
    const origLoadThread = creationsStore.loadThread;
    creationsStore.loadThread = vi.fn().mockResolvedValue(creationsStore.threadMessagesByKey[tKey]);
    const directorWrapper = mount(DirectorChatPane, {
      props: { agentId: 'agent-a', creationId: 'cre-1' },
      global: { mocks: { $t } },
    });
    await flushPromises();
    const directorHtml = directorWrapper.find('.creation-chat-messages').html();
    expect(directorHtml).not.toContain('<script');
    expect(directorHtml).not.toContain('onerror');
    expect(directorHtml).not.toContain('javascript:');
    creationsStore.loadThread = origLoadThread;
    directorWrapper.unmount();
  });

  it('B04: CAS revision conflict in updateNode preserves server content and surfaces conflict banner without closing editor', async () => {
    const { default: BookReader } = await import('../../web/components/cosmos/creations/readers/BookReader.js');
    const res = await creationsStore.createCreation('agent-a', {
      title: 'CAS Novel',
      kind: 'book',
      autoPlan: false,
    });
    const created = await creationsStore.createNode('agent-a', res.creation.id, {
      nodeType: 'unit',
      modality: 'markdown_doc',
      title: 'Chapter 1',
      content: 'Server v1',
    });
    await creationsStore.openCreation('agent-a', res.creation.id, { mode: 'read' });
    const rev1 = creationsStore.activeNode.currentRevId;

    // Simulate a concurrent server update to v2
    await creationsStore.updateNode('agent-a', res.creation.id, created.node.id, {
      content: 'Server v2',
      baseRevId: rev1,
    });
    expect(creationsStore.activeNodeContent.content).toBe('Server v2');

    // Attempt stale CAS save with rev1 -> store must NOT overwrite server content!
    const conflictRes = await creationsStore.updateNode('agent-a', res.creation.id, created.node.id, {
      content: 'Stale local draft',
      baseRevId: rev1,
    });
    expect(conflictRes.conflict).toBe(true);
    expect(creationsStore.activeNodeContent.content).toBe('Server v2');

    // BookReader surfaces conflict banner & stays in edit mode
    const $t = (k) => creationsZh[k] || k;
    const bookWrapper = mount(BookReader, {
      props: {
        node: { ...creationsStore.activeNode, currentRevId: rev1 },
        content: 'Server v1',
        agentId: 'agent-a',
        creationId: res.creation.id,
        onSaveContent: vi.fn().mockResolvedValue({ conflict: true }),
      },
      global: { mocks: { $t } },
    });
    bookWrapper.vm.enterEditMode();
    bookWrapper.vm.draftText = 'Edited locally';
    bookWrapper.vm.dirty = true;
    const saved = await bookWrapper.vm.saveEdit(true);
    await flushPromises();
    expect(saved).toBe(false);
    expect(bookWrapper.vm.editing).toBe(true);
    expect(bookWrapper.find('.creation-conflict-banner').exists()).toBe(true);
    bookWrapper.unmount();
  });

  it('B06: DirectorChatPane uses folder scopeType, ignores stale loadThread responses, and preserves draft on send failure', async () => {
    const { default: DirectorChatPane } = await import('../../web/components/cosmos/creations/studio/DirectorChatPane.js');
    const $t = (k) => creationsZh[k] || k;

    let resolveFirst;
    let resolveSecond;
    const firstPromise = new Promise((r) => { resolveFirst = r; });
    const secondPromise = new Promise((r) => { resolveSecond = r; });

    const loadCalls = [];
    creationsStore.loadThread = vi.fn((aId, cId, scopeType, scopeId) => {
      loadCalls.push({ scopeType, scopeId });
      return loadCalls.length === 1 ? firstPromise : secondPromise;
    });
    creationsStore.sendMessage = vi.fn().mockRejectedValue(new Error('Network offline'));

    const folderNode = { id: 'folder-1', title: 'Volume 1', type: 'folder', isFolder: true };
    const unitNode = { id: 'unit-1', title: 'Chapter 1', type: 'unit', isFolder: false };

    const wrapper = mount(DirectorChatPane, {
      props: { agentId: 'agent-a', creationId: 'cre-1', activeNode: folderNode },
      global: { mocks: { $t } },
    });

    expect(loadCalls[0]).toEqual({ scopeType: 'folder', scopeId: 'folder-1' });
    expect(wrapper.vm.loadingThread).toBe(true);

    // Switch quickly to unitNode before first load resolves
    await wrapper.setProps({ activeNode: unitNode });
    expect(loadCalls[1]).toEqual({ scopeType: 'unit', scopeId: 'unit-1' });

    // Resolve second (newer) load first
    resolveSecond({ thread: { id: 'thr-unit-1', scopeType: 'unit', scopeId: 'unit-1' }, messages: [] });
    await flushPromises();
    expect(wrapper.vm.activeThreadId).toBe('thr-unit-1');
    expect(wrapper.vm.loadingThread).toBe(false);

    // Now resolve first (stale) load -> MUST be ignored!
    resolveFirst({ thread: { id: 'thr-folder-1', scopeType: 'folder', scopeId: 'folder-1' }, messages: [] });
    await flushPromises();
    expect(wrapper.vm.activeThreadId).toBe('thr-unit-1');

    // Draft preserved & inline error displayed when sendMessage fails
    wrapper.vm.inputText = 'Keep this important prompt';
    await wrapper.vm.sendMessage();
    await flushPromises();
    expect(wrapper.vm.inputText).toBe('Keep this important prompt');
    expect(wrapper.vm.sendError).toContain('Network offline');
    wrapper.unmount();
  });

  it('B08: clearAll() during in-flight loadNode never repopulates cleared store', async () => {
    let resolveReq;
    const origRequest = creationsStore.request;
    creationsStore.request = vi.fn(() => new Promise((r) => { resolveReq = r; }));

    const loadPromise = creationsStore.loadNode('agent-a', 'cre-1', 'node-1');
    creationsStore.clearAll();
    resolveReq({ content: 'Stale content after logout', node: { id: 'node-1', title: 'Ghost' } });
    await loadPromise;

    expect(Object.keys(creationsStore.nodeContentsByKey)).toEqual([]);
    expect(Object.keys(creationsStore.detailsByKey)).toEqual([]);
    creationsStore.request = origRequest;
  });

  it('B11: creations.css defines mobile 3-tab switching rules and Read Mode scroll stage', () => {
    const css = readFileSync(resolve(process.cwd(), 'web/styles/cosmos/creations.css'), 'utf8');
    expect(css).toContain('.creation-studio-layout[data-mobile-tab="tree"]');
    expect(css).toContain('.creation-studio-layout[data-mobile-tab="canvas"]');
    expect(css).toContain('.creation-studio-layout[data-mobile-tab="director"]');
    expect(css).toContain('.creation-read-stage');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it('B03: GalleryReader caption edit preserves legacy svgMarkup as inert data without injecting v-html', async () => {
    const { default: GalleryReader } = await import('../../web/components/cosmos/creations/readers/GalleryReader.js');
    const $t = (k) => creationsZh[k] || k;
    const savedPayloads = [];
    const legacySvg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" /></svg>';
    const wrapper = mount(GalleryReader, {
      props: {
        node: { id: 'n-gal-preserve', title: 'Legacy Art', modality: 'image_gallery', currentRevId: 'rev-1' },
        agentId: 'agent-a',
        creationId: 'cre-1',
        contentLoaded: true,
        loadedRevId: 'rev-1',
        content: JSON.stringify({
          frames: [
            {
              frameId: 'f-legacy',
              title: 'Star Map',
              caption: 'Old caption',
              svgMarkup: legacySvg,
            },
          ],
        }),
        onSaveContent: vi.fn(async (payload) => {
          savedPayloads.push(payload);
          return { node: { id: 'n-gal-preserve', currentRevId: 'rev-2' } };
        }),
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // No inline <svg> injected into DOM
    expect(wrapper.find('svg').exists()).toBe(false);

    // Enter edit mode, edit caption, save
    wrapper.vm.toggleEditing();
    await flushPromises();
    wrapper.vm.frames[0].caption = 'Updated caption';
    wrapper.vm.markDirty();
    const ok = await wrapper.vm.saveGallery();
    expect(ok).toBe(true);
    expect(savedPayloads.length).toBe(1);

    const parsed = JSON.parse(savedPayloads[0].content);
    expect(parsed.frames[0].caption).toBe('Updated caption');
    expect(parsed.frames[0].svgMarkup).toBe(legacySvg);
    expect(wrapper.find('svg').exists()).toBe(false);
    wrapper.unmount();
  });

  it('B04: BookReader blocks edit before contentLoaded, captures loadedRevId, and finalizeChapter targets captured nodeId mid-save', async () => {
    const { default: BookReader } = await import('../../web/components/cosmos/creations/readers/BookReader.js');
    const $t = (k) => creationsZh[k] || k;

    let resolveSave;
    const onSaveContent = vi.fn(() => new Promise((r) => { resolveSave = r; }));

    const wrapper = mount(BookReader, {
      props: {
        node: { id: 'ch-1', title: 'Chapter 1', status: 'draft', currentRevId: 'rev-stale-node' },
        content: 'Loaded chapter body',
        contentLoaded: false,
        loadedRevId: null,
        agentId: 'agent-a',
        creationId: 'cre-1',
        onSaveContent,
      },
      global: { mocks: { $t } },
    });

    // Cannot enter edit mode before contentLoaded
    wrapper.vm.enterEditMode();
    expect(wrapper.vm.editing).toBe(false);

    // Once contentLoaded with loadedRevId='rev-loaded-1', edit mode captures loadedRevId
    await wrapper.setProps({ contentLoaded: true, loadedRevId: 'rev-loaded-1' });
    wrapper.vm.enterEditMode();
    expect(wrapper.vm.editing).toBe(true);
    expect(wrapper.vm.editBaseRevId).toBe('rev-loaded-1');

    // Edit text and trigger finalizeChapter, then switch node prop mid-save!
    wrapper.vm.draftText = 'Edited chapter 1 text';
    wrapper.vm.dirty = true;
    const finalizePromise = wrapper.vm.finalizeChapter();

    // Switch node prop to ch-2 while saveEdit is still in flight
    await wrapper.setProps({
      node: { id: 'ch-2', title: 'Chapter 2', status: 'draft', currentRevId: 'rev-ch2' },
      loadedRevId: 'rev-ch2',
    });

    resolveSave({ node: { id: 'ch-1', currentRevId: 'rev-saved-2' } });
    await finalizePromise;
    await flushPromises();

    // Must finalize ch-1 with rev-saved-2 — NEVER ch-2!
    const emitted = wrapper.emitted('finalize-node');
    expect(emitted).toBeTruthy();
    expect(emitted[0][0]).toEqual({ nodeId: 'ch-1', baseRevId: 'rev-saved-2' });
    wrapper.unmount();
  });

  it('B05: ProposalDiffBar fetches full proposal via getProposal before enabling diff/Accept on compact proposals', async () => {
    const { default: ProposalDiffBar } = await import('../../web/components/cosmos/creations/studio/ProposalDiffBar.js');
    const $t = (k) => creationsZh[k] || k;

    let resolveGetProposal;
    const getProposalSpy = vi.fn(() => new Promise((r) => { resolveGetProposal = r; }));
    const origGetProposal = creationsStore.getProposal;
    creationsStore.getProposal = getProposalSpy;

    const compactProposal = {
      id: 'prop-compact-1',
      nodeId: 'n-1',
      status: 'pending',
      summary: 'Tighten opening paragraph',
      // proposedContent intentionally omitted (compact snapshot from get_creation)
    };

    const wrapper = mount(ProposalDiffBar, {
      props: {
        node: { id: 'n-1', title: 'Ch 1', currentRevId: 'rev-1' },
        currentContent: 'Old opening line.',
        proposals: [compactProposal],
        agentId: 'agent-a',
        creationId: 'cre-1',
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // Automatically triggered getProposal
    expect(getProposalSpy).toHaveBeenCalledWith('agent-a', 'cre-1', 'prop-compact-1');

    // Diff and Accept buttons are disabled while full proposal is loading, and no bogus -1 diff is shown
    const buttons = wrapper.findAll('button');
    const acceptBtn = buttons.find((b) => b.text().includes(creationsZh['creation.proposal.accept']));
    const diffBtn = buttons.find((b) => b.text().includes('Diff'));
    expect(acceptBtn.attributes('disabled')).toBeDefined();
    expect(diffBtn.attributes('disabled')).toBeDefined();
    expect(wrapper.find('.creation-diff-del').exists()).toBe(false);

    // Resolve full proposal
    resolveGetProposal({
      ...compactProposal,
      proposedContent: 'Sharper opening line.\nSecond line.',
    });
    await flushPromises();

    expect(acceptBtn.attributes('disabled')).toBeUndefined();
    expect(diffBtn.attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.creation-diff-add').text()).toContain('+2');
    expect(wrapper.find('.creation-diff-del').text()).toContain('-1');

    creationsStore.getProposal = origGetProposal;
    wrapper.unmount();
  });

  it('B09: Live node insert (position) -> reorder with interleaved folders produces exact sibling order', async () => {
    const [{ default: OutlineBoard }, { default: StudioTreeRail }] = await Promise.all([
      import('../../web/components/cosmos/creations/studio/OutlineBoard.js'),
      import('../../web/components/cosmos/creations/studio/StudioTreeRail.js'),
    ]);
    const $t = (k) => creationsZh[k] || k;

    // Nodes coming from live insert only have `position` (no `sortOrder`)
    const nodes = [
      { id: 'u2', type: 'unit', title: 'Unit 2', parentId: null, position: 2 },
      { id: 'f1', type: 'folder', isFolder: true, title: 'Folder A', parentId: null, position: 1 },
      { id: 'u1', type: 'unit', title: 'Unit 1', parentId: null, position: 0 },
    ];

    const reorderSpy = vi.fn().mockResolvedValue({ nodes });
    const origReorder = creationsStore.reorderNodes;
    creationsStore.reorderNodes = reorderSpy;

    const treeWrapper = mount(StudioTreeRail, {
      props: { nodes, canon: [], sources: [] },
      global: { mocks: { $t } },
    });
    expect(treeWrapper.vm.sortedNodes.map((n) => n.id)).toEqual(['u1', 'f1', 'u2']);

    const boardWrapper = mount(OutlineBoard, {
      props: { folder: null, nodes, agentId: 'agent-a', creationId: 'cre-1' },
      global: { mocks: { $t } },
    });
    expect(boardWrapper.vm.allSiblings.map((n) => n.id)).toEqual(['u1', 'f1', 'u2']);
    expect(boardWrapper.vm.childUnits.map((n) => n.id)).toEqual(['u1', 'u2']);

    // Move Unit 2 up (swap with Unit 1 while preserving Folder A at index 1)
    await boardWrapper.vm.moveUnit(1, -1);
    expect(reorderSpy).toHaveBeenCalledWith('agent-a', 'cre-1', null, ['u2', 'f1', 'u1']);

    creationsStore.reorderNodes = origReorder;
    treeWrapper.unmount();
    boardWrapper.unmount();
  });

  it('B13: Legacy bookmark import uses deterministic importKey and does not duplicate on retry after lost ACK', async () => {
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const { COSMOS_BOOKS_KEY } = await import('../../web/cosmos/constants.js');
    const $t = (k) => creationsZh[k] || k;

    localStorage.removeItem('yeaft-cosmos-legacy-books-dismissed-v1');
    localStorage.removeItem('yeaft-cosmos-legacy-books-imported-v1');
    localStorage.setItem(COSMOS_BOOKS_KEY, JSON.stringify([
      { id: 'bm-1', title: 'Star Atlas', arm: 0, r: 0.4, theta: 1.0 },
      { id: 'bm-2', title: 'Nebula Guide', arm: 1, r: 0.5, theta: 2.0 },
    ]));

    await creationsStore.selectGalaxyAgent('agent-a', { force: true });

    const seenCalls = [];
    let failSecondOnce = true;
    const origCreate = creationsStore.createCreation;
    creationsStore.createCreation = vi.fn(async (agentId, payload) => {
      seenCalls.push(payload);
      if (payload.importKey === 'legacy-book:bm-2' && failSecondOnce) {
        failSecondOnce = false;
        throw new Error('Lost ACK');
      }
      return origCreate.call(creationsStore, agentId, payload);
    });

    const wrapper = mount(CosmosGalaxyOverlay, {
      props: {
        visible: true,
        agents: [{ id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] }],
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // First import attempt: bm-1 succeeds and is persisted, bm-2 fails (lost ACK)
    await wrapper.vm.importLegacyBookmarks();
    await flushPromises();
    expect(seenCalls.map((c) => c.importKey)).toEqual(['legacy-book:bm-1', 'legacy-book:bm-2']);
    expect(JSON.parse(localStorage.getItem('yeaft-cosmos-legacy-books-imported-v1'))).toEqual(['legacy-book:bm-1']);
    expect(wrapper.vm.legacyBookmarks.map((b) => b.id)).toEqual(['bm-2']);

    // Retry: skips bm-1, retries ONLY bm-2 with exact same deterministic importKey
    await wrapper.vm.importLegacyBookmarks();
    await flushPromises();
    expect(seenCalls.map((c) => c.importKey)).toEqual(['legacy-book:bm-1', 'legacy-book:bm-2', 'legacy-book:bm-2']);
    expect(JSON.parse(localStorage.getItem('yeaft-cosmos-legacy-books-imported-v1'))).toEqual(['legacy-book:bm-1', 'legacy-book:bm-2']);
    expect(wrapper.vm.legacyBookmarks.length).toBe(0);

    creationsStore.createCreation = origCreate;
    localStorage.removeItem(COSMOS_BOOKS_KEY);
    localStorage.removeItem('yeaft-cosmos-legacy-books-dismissed-v1');
    localStorage.removeItem('yeaft-cosmos-legacy-books-imported-v1');
    wrapper.unmount();
  });

  it('Signal Stream suppresses floating overlays in Galaxy while keeping popover accessible', async () => {
    const { default: CosmosSignalStream } = await import('../../web/components/cosmos/CosmosSignalStream.js');
    const $t = (k) => k;
    const items = [
      {
        signalKey: 'sig-1',
        kind: 'unread',
        agentId: 'agent-a',
        agentName: 'Alpha',
        sessionId: 's-1',
        sessionTitle: 'Build logs',
        preview: 'All tests passed',
        planetId: 'earth',
        activityAt: 1000,
        dismissible: true,
      },
    ];

    // Desktop in Solar -> floating cards visible
    const wrapper = mount(CosmosSignalStream, {
      props: {
        items,
        unreadCount: 1,
        badgeCount: 1,
        dismissibleCount: 1,
        isCompact: false,
        suppressFloating: false,
        popoverOpen: false,
      },
      global: { mocks: { $t } },
    });
    expect(wrapper.find('.cosmos-signal-stream').exists()).toBe(true);

    // Desktop in Galaxy (suppressFloating=true) -> floating cards suppressed
    await wrapper.setProps({ suppressFloating: true });
    expect(wrapper.find('.cosmos-signal-stream').exists()).toBe(false);

    // 320px Mobile in Galaxy (isCompact=true, suppressFloating=true) -> mobile banner suppressed
    await wrapper.setProps({ isCompact: true, suppressFloating: true });
    expect(wrapper.find('.cosmos-signal-mobile-banner').exists()).toBe(false);

    // Opening the popover via top-right trigger still works cleanly
    await wrapper.setProps({ popoverOpen: true });
    expect(wrapper.find('.cosmos-signal-popover').exists()).toBe(true);
    wrapper.unmount();
  });

  it('B11: VideoReader filters playable sources and renders download fallback on playback error', async () => {
    const { default: VideoReader } = await import('../../web/components/cosmos/creations/readers/VideoReader.js');
    const $t = (k) => creationsZh[k] || k;

    const wrapper = mount(VideoReader, {
      props: {
        node: { id: 'v-1', title: 'Episode 1', modality: 'video_episode', currentRevId: 'rev-1' },
        content: JSON.stringify({ videoSourceId: 'src-mp4', scenes: [] }),
        contentLoaded: true,
        loadedRevId: 'rev-1',
        agentId: 'agent-a',
        creationId: 'cre-1',
        sources: [
          { id: 'src-mp4', name: 'clip.mp4', mimeType: 'video/mp4' },
          { id: 'src-webm', name: 'clip.webm', mimeType: 'video/webm' },
          { id: 'src-mkv', name: 'raw.mkv', mimeType: 'video/x-matroska' },
        ],
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // Only playable sources (.mp4, .webm, .mov) appear in selectable list
    expect(wrapper.vm.videoSources.map((s) => s.id)).toEqual(['src-mp4', 'src-webm']);
    expect(wrapper.find('video.creation-video-el').exists()).toBe(true);

    // Triggering video error renders fallback download link
    await wrapper.find('video.creation-video-el').trigger('error');
    await flushPromises();
    const fallback = wrapper.find('.creation-video-fallback');
    expect(fallback.exists()).toBe(true);
    const dlLink = fallback.find('a[download]');
    expect(dlLink.exists()).toBe(true);
    expect(dlLink.attributes('href')).toBe('/api/yeaft/creations/agent-a/cre-1/media/source/src-mp4');
    wrapper.unmount();
  });

  it('R3-#1 (B04): Switching from Studio folder to Read loads & binds displayed chapter body and preserves loadedRevId=null', async () => {
    const { default: CreationInteriorModal } = await import('../../web/components/cosmos/creations/CreationInteriorModal.js');
    const { default: BookReader } = await import('../../web/components/cosmos/creations/readers/BookReader.js');
    const { creationDetailKey, creationNodeKey } = await import('../../web/stores/creations.js');
    const $t = (k) => creationsZh[k] || k;

    const created = await creationsStore.createCreation('agent-a', { title: 'R3 Book', kind: 'book' });
    const cid = created.creation.id;
    const folderRes = await creationsStore.createNode('agent-a', cid, { kind: 'folder', nodeType: 'folder', title: 'Part I' });
    const folderId = folderRes.node.id;
    const unitRes = await creationsStore.createNode('agent-a', cid, {
      parentId: folderId,
      kind: 'unit',
      nodeType: 'unit',
      title: 'Chapter 1',
      modality: 'markdown_doc',
    });
    const unitId = unitRes.node.id;
    const upd = await creationsStore.updateNode('agent-a', cid, unitId, { content: 'Real chapter body text.' });
    const realRevId = upd.node.currentRevId;

    await creationsStore.openCreation('agent-a', cid, { mode: 'studio' });
    // Clear cached unit body to prove Read mode triggers loadNode for displayedReadNode
    delete creationsStore.nodeContentsByKey[creationNodeKey('agent-a', cid, unitId)];
    await creationsStore.selectNode(folderId);
    expect(creationsStore.activeCreation.activeNodeId).toBe(folderId);

    const loadSpy = vi.spyOn(creationsStore, 'loadNode');
    const wrapper = mount(CreationInteriorModal, {
      global: { mocks: { $t } },
    });
    await flushPromises();

    // Switch to Read mode while folder is still activeNodeId
    creationsStore.setActiveMode('read');
    await flushPromises();

    expect(loadSpy).toHaveBeenCalledWith('agent-a', cid, unitId);
    expect(wrapper.vm.displayedReadNode?.id).toBe(unitId);
    expect(wrapper.vm.displayedReadContent).toBe('Real chapter body text.');
    expect(wrapper.vm.displayedReadContentLoaded).toBe(true);
    expect(wrapper.vm.displayedReadLoadedRevId).toBe(realRevId);
    expect(wrapper.text()).toContain('Real chapter body text.');
    loadSpy.mockRestore();
    wrapper.unmount();

    // Also verify BookReader captures loadedRevId=null directly when contentLoaded=true
    const brWrapper = mount(BookReader, {
      props: {
        node: { id: 'u-first', title: 'First Write', currentRevId: 'stale-rev-from-list' },
        content: '',
        contentLoaded: true,
        loadedRevId: null,
        agentId: 'agent-a',
        creationId: cid,
      },
      global: { mocks: { $t } },
    });
    brWrapper.vm.enterEditMode();
    expect(brWrapper.vm.editBaseRevId).toBeNull();
    brWrapper.unmount();

    // Verify detail key still intact
    expect(creationsStore.detailsByKey[creationDetailKey('agent-a', cid)]).toBeTruthy();
  });

  it('R3-#2 (B05): OutlineBoard renders truncated outline read-only until full loadNode hydrates it', async () => {
    const { default: OutlineBoard } = await import('../../web/components/cosmos/creations/studio/OutlineBoard.js');
    const { creationDetailKey } = await import('../../web/stores/creations.js');
    const $t = (k) => creationsZh[k] || k;

    const created = await creationsStore.createCreation('agent-a', { title: 'Outline Book', kind: 'book' });
    const cid = created.creation.id;
    const unitRes = await creationsStore.createNode('agent-a', cid, {
      kind: 'unit',
      title: 'Chapter Trunc',
      outlineMd: 'Full complete outline text for chapter one.',
    });
    const uid = unitRes.node.id;

    // Simulate truncated snapshot from get_creation
    const dKey = creationDetailKey('agent-a', cid);
    creationsStore.detailsByKey[dKey].nodes = [
      { ...unitRes.node, outlineMd: 'Full complete...', outlineTruncated: true },
    ];

    const wrapper = mount(OutlineBoard, {
      props: {
        folder: null,
        nodes: creationsStore.detailsByKey[dKey].nodes,
        agentId: 'agent-a',
        creationId: cid,
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // No editable summary textarea while truncated; load button is shown
    expect(wrapper.find('textarea.creation-outline-summary').exists()).toBe(false);
    const loadBtn = wrapper.find('.creation-outline-load-btn');
    expect(loadBtn.exists()).toBe(true);

    await loadBtn.trigger('click');
    await flushPromises();

    // Store cleared outlineTruncated: false
    const hydratedNode = creationsStore.detailsByKey[dKey].nodes.find((n) => n.id === uid);
    expect(hydratedNode.outlineTruncated).toBe(false);
    expect(hydratedNode.outlineMd).toBe('Full complete outline text for chapter one.');

    await wrapper.setProps({ nodes: creationsStore.detailsByKey[dKey].nodes });
    await flushPromises();
    expect(wrapper.find('textarea.creation-outline-summary').exists()).toBe(true);
    expect(wrapper.find('textarea.creation-outline-summary').element.value).toBe('Full complete outline text for chapter one.');
    wrapper.unmount();
  });

  it('R3-#3 (B05): CanonEditor fetches full canon when stateTruncated=true and blocks Save until hydrated', async () => {
    const { default: CanonEditor } = await import('../../web/components/cosmos/creations/studio/CanonEditor.js');
    const $t = (k) => creationsZh[k] || k;

    const origGetCanon = creationsStore.getCanon;
    let resolveCanon;
    creationsStore.getCanon = vi.fn(() => new Promise((r) => { resolveCanon = r; }));

    const truncatedItem = {
      id: 'canon-1',
      type: 'entity',
      title: 'Hero',
      contentMd: 'Short bio',
      contentTruncated: false,
      stateTruncated: true,
      state: {},
    };

    const wrapper = mount(CanonEditor, {
      props: {
        item: truncatedItem,
        agentId: 'agent-a',
        creationId: 'cre-canon',
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    expect(creationsStore.getCanon).toHaveBeenCalledWith('agent-a', 'cre-canon', 'canon-1');
    wrapper.vm.markDirty();
    await flushPromises();
    expect(wrapper.vm.saveDisabled).toBe(true);

    // Resolve full canon
    const fullItem = {
      ...truncatedItem,
      state: { hp: '100', role: 'captain' },
      contentTruncated: false,
      stateTruncated: false,
    };
    resolveCanon(fullItem);
    await flushPromises();

    await wrapper.setProps({ item: fullItem });
    wrapper.vm.markDirty();
    await flushPromises();
    expect(wrapper.vm.saveDisabled).toBe(false);
    expect(wrapper.vm.statePairs).toEqual([
      { key: 'hp', value: '100' },
      { key: 'role', value: 'captain' },
    ]);

    // Failure case keeps Save disabled and renders retry button
    creationsStore.getCanon = vi.fn().mockRejectedValue(new Error('network error'));
    const failWrapper = mount(CanonEditor, {
      props: {
        item: { ...truncatedItem, id: 'canon-2' },
        agentId: 'agent-a',
        creationId: 'cre-canon',
      },
      global: { mocks: { $t } },
    });
    await flushPromises();
    failWrapper.vm.markDirty();
    await flushPromises();
    expect(failWrapper.vm.hydrateFailed).toBe(true);
    expect(failWrapper.vm.saveDisabled).toBe(true);
    expect(failWrapper.find('.creation-conflict-banner').exists()).toBe(true);

    creationsStore.getCanon = origGetCanon;
    wrapper.unmount();
    failWrapper.unmount();
  });

  it('R3-#4 (B05): getProposal clears contentTruncated so ProposalDiffBar enables Diff & Accept', async () => {
    const { default: ProposalDiffBar } = await import('../../web/components/cosmos/creations/studio/ProposalDiffBar.js');
    const { creationDetailKey } = await import('../../web/stores/creations.js');
    const $t = (k) => creationsZh[k] || k;

    const dKey = creationDetailKey('agent-a', 'cre-prop');
    creationsStore.detailsByKey[dKey] = {
      creation: { id: 'cre-prop', title: 'Prop Test' },
      nodes: [{ id: 'n-1', title: 'Ch 1', currentRevId: 'rev-1' }],
      canon: [],
      sources: [],
      assets: [],
      threads: [],
      proposals: [
        { id: 'p-1', nodeId: 'n-1', status: 'pending', summary: 'Polish intro', contentTruncated: true },
      ],
      runs: [],
      loadedAt: Date.now(),
    };

    const origReq = creationsStore.request;
    creationsStore.request = vi.fn(async (_agentId, op) => {
      if (op === 'get_proposal') {
        // Server returns full proposal without contentTruncated field
        return {
          proposal: {
            id: 'p-1',
            nodeId: 'n-1',
            status: 'pending',
            summary: 'Polish intro',
            proposedContent: 'Polished line 1\nPolished line 2',
          },
        };
      }
      return origReq.call(creationsStore, _agentId, op);
    });

    const wrapper = mount(ProposalDiffBar, {
      props: {
        node: { id: 'n-1', title: 'Ch 1', currentRevId: 'rev-1' },
        currentContent: 'Old line 1',
        proposals: creationsStore.detailsByKey[dKey].proposals,
        agentId: 'agent-a',
        creationId: 'cre-prop',
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // Store entry has contentTruncated normalized to false
    expect(creationsStore.detailsByKey[dKey].proposals[0].contentTruncated).toBe(false);
    // ProposalDiffBar marks contentReady and enables Diff & Accept
    expect(wrapper.vm.enrichedProposals[0].contentReady).toBe(true);
    const buttons = wrapper.findAll('.creation-proposal-actions button');
    const diffBtn = buttons.find((b) => b.text().includes('Diff'));
    const acceptBtn = buttons.find((b) => b.text().includes(creationsZh['creation.proposal.accept']));
    expect(diffBtn.attributes('disabled')).toBeUndefined();
    expect(acceptBtn.attributes('disabled')).toBeUndefined();

    creationsStore.request = origReq;
    wrapper.unmount();
  });

  it('R3-#7 (B07): reconcileAfterReconnect refreshes clean active node body and preserves dirty draft', async () => {
    const { creationNodeKey } = await import('../../web/stores/creations.js');
    const created = await creationsStore.createCreation('agent-a', { title: 'Reconnect Book', kind: 'book' });
    const cid = created.creation.id;
    const unitRes = await creationsStore.createNode('agent-a', cid, { kind: 'unit', title: 'Ch 1' });
    const uid = unitRes.node.id;
    await creationsStore.updateNode('agent-a', cid, uid, { content: 'Version 1' });
    await creationsStore.openCreation('agent-a', cid, { mode: 'read' });

    const nKey = creationNodeKey('agent-a', cid, uid);
    expect(creationsStore.nodeContentsByKey[nKey].content).toBe('Version 1');

    // Simulate remote update on backend while client disconnected
    serviceA.store.updateNode(cid, uid, { content: 'Version 2 from server' });

    // Clean node -> reconcileAfterReconnect fetches updated body
    await creationsStore.reconcileAfterReconnect('agent-a');
    expect(creationsStore.nodeContentsByKey[nKey].content).toBe('Version 2 from server');

    // Mark node dirty with local unsaved draft
    creationsStore.setNodeDirty('agent-a', cid, uid, true);
    creationsStore.nodeContentsByKey[nKey].content = 'Unsaved local draft';
    serviceA.store.updateNode(cid, uid, { content: 'Version 3 from server' });

    // Dirty node -> reconcileAfterReconnect skips loadNode and preserves local draft
    await creationsStore.reconcileAfterReconnect('agent-a');
    expect(creationsStore.nodeContentsByKey[nKey].content).toBe('Unsaved local draft');
    expect(creationsStore.nodeContentsByKey[nKey].dirty).toBe(true);
  });

  it('R3-#8 (B08): Ignite preserves newly queued files and draft when switching Agent mid-submit', async () => {
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const $t = (k) => creationsZh[k] || k;

    await creationsStore.selectGalaxyAgent('agent-a', { force: true });

    let resolveCreate;
    const origCreate = creationsStore.createCreation;
    creationsStore.createCreation = vi.fn(() => new Promise((r) => { resolveCreate = r; }));

    const wrapper = mount(CosmosGalaxyOverlay, {
      props: {
        visible: true,
        agents: [
          { id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] },
          { id: 'agent-b', name: 'Beta', online: true, capabilities: ['creations'] },
        ],
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    const fileA = new File(['hello'], 'notes-a.txt', { type: 'text/plain' });
    const fileB = new File(['world'], 'notes-b.txt', { type: 'text/plain' });
    creationsStore.igniteDraft.title = 'Draft A';
    creationsStore.igniteDraft.prompt = 'Prompt A';
    creationsStore.igniteDraft.pendingFiles = [fileA];
    creationsStore.igniteDraft.open = true;

    const submitPromise = wrapper.vm.submitIgnite();

    // User switches to agent-b and queues fileB + new prompt mid-flight
    creationsStore.selectedAgentId = 'agent-b';
    creationsStore.igniteDraft.title = 'Draft B';
    creationsStore.igniteDraft.prompt = 'Prompt B';
    creationsStore.igniteDraft.pendingFiles = [...creationsStore.igniteDraft.pendingFiles, fileB];

    resolveCreate({ creation: { id: 'cre-a-new', title: 'Draft A' } });
    await submitPromise;
    await flushPromises();

    // fileA removed, fileB preserved; agent-b's title/prompt/open preserved
    expect(creationsStore.igniteDraft.pendingFiles).toEqual([fileB]);
    expect(creationsStore.igniteDraft.title).toBe('Draft B');
    expect(creationsStore.igniteDraft.prompt).toBe('Prompt B');
    expect(creationsStore.igniteDraft.open).toBe(true);

    creationsStore.createCreation = origCreate;
    wrapper.unmount();
  });

  it('R3-#9 (B11): VideoReader honors verified detectedMimeType / playableVideo and does not preemptively block playback', async () => {
    const { default: VideoReader } = await import('../../web/components/cosmos/creations/readers/VideoReader.js');
    const $t = (k) => creationsZh[k] || k;

    const sniffedSource = {
      id: 's1',
      name: 'video.bin',
      mimeType: 'application/octet-stream',
      detectedMimeType: 'video/mp4',
      playableVideo: true,
    };
    const wrapper = mount(VideoReader, {
      props: {
        node: { id: 'v-sniff', title: 'Sniffed Ep', modality: 'video_episode', currentRevId: 'rev-1' },
        content: JSON.stringify({ videoSourceId: 's1', scenes: [] }),
        contentLoaded: true,
        loadedRevId: 'rev-1',
        agentId: 'agent-a',
        creationId: 'cre-1',
        sources: [sniffedSource],
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    expect(wrapper.vm.videoSources.map((s) => s.id)).toEqual(['s1']);
    expect(wrapper.find('video.creation-video-el').exists()).toBe(true);
    expect(wrapper.find('.creation-video-fallback').exists()).toBe(false);
    wrapper.unmount();
  });

  it('R3-#11: CreationInteriorModal exposes accessible Signal Stream trigger and signal popover z-index exceeds L3 modal', async () => {
    const { default: CreationInteriorModal } = await import('../../web/components/cosmos/creations/CreationInteriorModal.js');
    const $t = (k) => creationsZh[k] || k;

    const created = await creationsStore.createCreation('agent-a', { title: 'Signal Test', kind: 'book' });
    await creationsStore.openCreation('agent-a', created.creation.id, { mode: 'studio' });

    const wrapper = mount(CreationInteriorModal, {
      props: {
        signalCount: 3,
        signalWaitingCount: 1,
        signalOpen: false,
        signalLabel: '3 signals waiting',
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    const trigger = wrapper.find('.creation-signal-trigger');
    expect(trigger.exists()).toBe(true);
    expect(trigger.attributes('aria-label')).toBe('3 signals waiting');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(trigger.text()).toContain('3');

    await trigger.trigger('click');
    expect(wrapper.emitted('toggle-signal')).toHaveLength(1);

    // Pressing Escape when signalOpen=true emits close-signal instead of closing L3
    await wrapper.setProps({ signalOpen: true });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(wrapper.emitted('close-signal')).toHaveLength(1);
    expect(creationsStore.activeCreation).not.toBeNull();

    // Verify CSS z-index layering: .cosmos-signal-popover > .creation-interior-overlay
    const signalCss = readFileSync(resolve(process.cwd(), 'web/styles/cosmos/signal-stream.css'), 'utf8');
    const creationsCss = readFileSync(resolve(process.cwd(), 'web/styles/cosmos/creations.css'), 'utf8');
    const popoverZ = Number(signalCss.match(/\.cosmos-signal-popover\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
    const interiorZ = Number(creationsCss.match(/\.creation-interior-overlay\s*\{[^}]*z-index:\s*(\d+)/s)?.[1]);
    expect(popoverZ).toBeGreaterThan(interiorZ);

    wrapper.unmount();
  });

  it('R4-#3/#7/#9/#11: CanonEditor locks inputs while hydrating, BookReader keeps clean edits refreshable on reconnect, VideoReader respects playableVideo=false, and Signal popover mounts inside modal', async () => {
    const [
      { default: CanonEditor },
      { default: BookReader },
      { default: VideoReader },
      { default: CreationInteriorModal },
      { default: CosmosSignalStream },
    ] = await Promise.all([
      import('../../web/components/cosmos/creations/studio/CanonEditor.js'),
      import('../../web/components/cosmos/creations/readers/BookReader.js'),
      import('../../web/components/cosmos/creations/readers/VideoReader.js'),
      import('../../web/components/cosmos/creations/CreationInteriorModal.js'),
      import('../../web/components/cosmos/CosmosSignalStream.js'),
    ]);
    const $t = (k) => creationsZh[k] || k;

    // R4-#3: CanonEditor locks form inputs while hydrating stateTruncated item
    creationsStore.getCanon = vi.fn(() => new Promise(() => {}));
    const canonWrap = mount(CanonEditor, {
      props: {
        item: { id: 'c1', type: 'entity', title: 'Hero', contentMd: 'Short', stateTruncated: true },
        agentId: 'agent-a',
        creationId: 'cre-1',
      },
      global: { mocks: { $t } },
    });
    expect(canonWrap.find('.creation-canon-title-input').attributes('disabled')).toBeDefined();
    expect(canonWrap.find('fieldset.creation-canon-editor-body').attributes('disabled')).toBeDefined();
    canonWrap.unmount();

    // R4-#7: BookReader entering edit mode without typing does NOT mark node dirty, so reconnect refreshes clean draft
    creationsStore.nodeContentsByKey['agent-a\u001fcre-1\u001fn1'] = {
      content: 'Old prose', revisions: [], loading: false, loaded: true, loadedRevId: 'rev-1', dirty: false,
    };
    const bookWrap = mount(BookReader, {
      props: {
        node: { id: 'n1', title: 'Ch 1', modality: 'markdown_doc', currentRevId: 'rev-1' },
        content: 'Old prose',
        contentLoaded: true,
        loadedRevId: 'rev-1',
        agentId: 'agent-a',
        creationId: 'cre-1',
      },
      global: { mocks: { $t } },
    });
    bookWrap.vm.enterEditMode();
    expect(creationsStore.nodeContentsByKey['agent-a\u001fcre-1\u001fn1'].dirty).toBe(false);
    await bookWrap.setProps({ content: 'Updated prose from peer', loadedRevId: 'rev-2' });
    expect(bookWrap.vm.draftText).toBe('Updated prose from peer');
    expect(bookWrap.vm.editBaseRevId).toBe('rev-2');
    bookWrap.unmount();

    // R4-#9: VideoReader excludes sources explicitly verified playableVideo: false even if named .mp4
    const videoWrap = mount(VideoReader, {
      props: {
        node: { id: 'v1', title: 'Ep 1', modality: 'video_episode', currentRevId: 'rev-1' },
        content: JSON.stringify({ scenes: [] }),
        contentLoaded: true,
        loadedRevId: 'rev-1',
        agentId: 'agent-a',
        creationId: 'cre-1',
        sources: [
          { id: 'fake-mp4', name: 'fake.mp4', mimeType: 'video/mp4', playableVideo: false },
          { id: 'real-webm', name: 'real.bin', mimeType: 'application/octet-stream', detectedMimeType: 'video/webm', playableVideo: true },
        ],
      },
      global: { mocks: { $t } },
    });
    expect(videoWrap.vm.videoSources.map((s) => s.id)).toEqual(['real-webm']);
    videoWrap.unmount();

    // R4-#11: Signal popover slot renders inside aria-modal="true" CreationInteriorModal & focuses on open
    const res = await creationsStore.createCreation('agent-a', { title: 'Modal A11y', kind: 'book', autoPlan: false });
    await creationsStore.openCreation('agent-a', res.creation.id, { mode: 'studio' });
    const modalWrap = mount(CreationInteriorModal, {
      attachTo: document.body,
      props: { signalCount: 1, signalOpen: true, signalLabel: '1 signal' },
      slots: {
        'signal-popover': () => Vue.h(CosmosSignalStream, {
          items: [{ signalKey: 's1', kind: 'unread', agentName: 'Alpha', sessionTitle: 'S1', preview: 'hi', dismissible: true }],
          unreadCount: 1, badgeCount: 1, dismissibleCount: 1, popoverOpen: true, suppressFloating: true,
        }),
      },
      global: { mocks: { $t } },
    });
    await flushPromises();
    const modalEl = modalWrap.find('[aria-modal="true"]');
    const popoverEl = modalEl.find('.cosmos-signal-popover');
    expect(popoverEl.exists()).toBe(true);
    // R5-#11: Even when mounted with popoverOpen=true initially, focus moves into the popover immediately!
    expect(popoverEl.element.contains(document.activeElement)).toBe(true);
    modalWrap.vm.focusSignalTrigger();
    expect(document.activeElement).toBe(modalWrap.find('.creation-signal-trigger').element);
    modalWrap.unmount();

    // R5-#7: Delayed get_node response does NOT discard edits typed while refresh is in flight
    let resolveDelayedNode;
    const origRequest = creationsStore.request.bind(creationsStore);
    creationsStore.request = vi.fn((agentId, op, payload) => {
      if (op === 'get_node') {
        return new Promise((resolve) => { resolveDelayedNode = resolve; });
      }
      return origRequest(agentId, op, payload);
    });
    const key = `agent-a\u001f${res.creation.id}\u001fn-delayed`;
    creationsStore.detailsByKey[`agent-a\u001f${res.creation.id}`].nodes = [
      { id: 'n-delayed', title: 'Ch', type: 'unit', modality: 'slide_deck', currentRevId: 'rev-remote' },
    ];
    creationsStore.nodeContentsByKey[key] = {
      content: '{"slides":[{"slideId":"s1","title":"V1"}]}',
      revisions: [], loading: false, loaded: true, loadedRevId: 'rev-local', dirty: false,
    };
    const pendingRefresh = creationsStore.loadNode('agent-a', res.creation.id, 'n-delayed');
    // Remote rev differs -> loaded becomes false while refresh is in flight
    expect(creationsStore.nodeContentsByKey[key].loaded).toBe(false);
    // Simulate edit becoming dirty while get_node is in flight
    creationsStore.setNodeDirty('agent-a', res.creation.id, 'n-delayed', true);
    resolveDelayedNode({
      node: { id: 'n-delayed', title: 'Ch', type: 'unit', modality: 'slide_deck', currentRevId: 'rev-remote', content: '{"slides":[{"slideId":"s1","title":"V2-remote"}]}' },
      content: '{"slides":[{"slideId":"s1","title":"V2-remote"}]}',
      revisions: [{ id: 'rev-remote' }],
    });
    await pendingRefresh;
    // Dirty draft and original loadedRevId must be preserved AND stay loaded/editable!
    expect(creationsStore.nodeContentsByKey[key].dirty).toBe(true);
    expect(creationsStore.nodeContentsByKey[key].loaded).toBe(true);
    expect(creationsStore.nodeContentsByKey[key].content).toContain('V1');
    expect(creationsStore.nodeContentsByKey[key].loadedRevId).toBe('rev-local');

    // R6-#7a: Opening Revision History (loadNode) on an already-dirty Deck with newer remote rev keeps Deck editable
    const { default: DeckReader } = await import('../../web/components/cosmos/creations/readers/DeckReader.js');
    const deckWrap = mount(DeckReader, {
      props: {
        node: { id: 'n-delayed', title: 'Ch', modality: 'slide_deck', currentRevId: 'rev-remote' },
        content: '{"slides":[{"slideId":"s1","layout":"title","title":"V1"}]}',
        contentLoaded: creationsStore.nodeContentsByKey[key].loaded,
        loadedRevId: creationsStore.nodeContentsByKey[key].loadedRevId,
        agentId: 'agent-a',
        creationId: res.creation.id,
      },
      global: { mocks: { $t } },
    });
    deckWrap.vm.startEditing();
    deckWrap.vm.markDirty();
    await flushPromises();
    expect(deckWrap.find('input.creation-slide-input.is-title').exists()).toBe(true);
    // Calling loadNode while dirty keeps loaded: true (never drops to false)
    const revHistLoad = creationsStore.loadNode('agent-a', res.creation.id, 'n-delayed');
    expect(creationsStore.nodeContentsByKey[key].loaded).toBe(true);
    resolveDelayedNode({
      node: { id: 'n-delayed', title: 'Ch', type: 'unit', modality: 'slide_deck', currentRevId: 'rev-remote', content: '{"slides":[{"slideId":"s1","layout":"title","title":"V2-remote"}]}' },
      content: '{"slides":[{"slideId":"s1","layout":"title","title":"V2-remote"}]}',
      revisions: [{ id: 'rev-remote' }, { id: 'rev-local' }],
    });
    await revHistLoad;
    expect(creationsStore.nodeContentsByKey[key].loaded).toBe(true);
    expect(deckWrap.find('input.creation-slide-input.is-title').exists()).toBe(true);
    deckWrap.unmount();

    // R6-#7b: VideoReader source selector & reorder/delete controls are disabled and no-op while !contentLoaded && !dirty
    const staleVideoWrap = mount(VideoReader, {
      props: {
        node: { id: 'v2', title: 'Ep 2', modality: 'video_episode', currentRevId: 'rev-2' },
        content: JSON.stringify({ videoSourceId: '', scenes: [{ sceneId: 's1', title: 'S1', durationSec: 5 }, { sceneId: 's2', title: 'S2', durationSec: 5 }] }),
        contentLoaded: false,
        loadedRevId: null,
        agentId: 'agent-a',
        creationId: res.creation.id,
        sources: [{ id: 'vid-1', name: 'clip.mp4', mimeType: 'video/mp4', playableVideo: true }],
      },
      global: { mocks: { $t } },
    });
    expect(staleVideoWrap.find('select.creation-compact-select').attributes('disabled')).toBeDefined();
    staleVideoWrap.vm.onSelectVideoSource({ target: { value: 'vid-1' } });
    staleVideoWrap.vm.deleteScene(0);
    expect(staleVideoWrap.vm.episode.videoSourceId).toBe('');
    expect(staleVideoWrap.vm.scenes).toHaveLength(2);
    staleVideoWrap.unmount();

    // R7-#1: Clean Deck already in edit mode hides/disables layout selector while refreshing stale revision
    const cleanDeckWrap = mount(DeckReader, {
      props: {
        node: { id: 'd-clean', title: 'Deck', modality: 'slide_deck', currentRevId: 'rev-1' },
        content: '{"slides":[{"slideId":"s1","layout":"title","title":"Slide 1"}]}',
        contentLoaded: true,
        loadedRevId: 'rev-1',
        agentId: 'agent-a',
        creationId: res.creation.id,
      },
      global: { mocks: { $t } },
    });
    cleanDeckWrap.vm.startEditing();
    await flushPromises();
    expect(cleanDeckWrap.find('select.creation-compact-select').exists()).toBe(true);
    await cleanDeckWrap.setProps({ contentLoaded: false });
    expect(cleanDeckWrap.find('select.creation-compact-select').exists()).toBe(false);
    cleanDeckWrap.unmount();

    // R7-#2: Deferred Gallery upload followed by switching to Gallery B must NOT append or autosave into Gallery B
    const { default: GalleryReader } = await import('../../web/components/cosmos/creations/readers/GalleryReader.js');
    let resolveUpload;
    const origUploadSources = creationsStore.uploadSources.bind(creationsStore);
    creationsStore.uploadSources = vi.fn(() => new Promise((r) => { resolveUpload = r; }));
    const onSaveGallery = vi.fn(async () => ({ ok: true }));
    const galleryWrap = mount(GalleryReader, {
      props: {
        node: { id: 'gal-A', title: 'Gallery A', modality: 'image_gallery', currentRevId: 'rev-a' },
        content: JSON.stringify({ frames: [{ frameId: 'fa', title: 'A1', caption: '' }] }),
        contentLoaded: true,
        loadedRevId: 'rev-a',
        agentId: 'agent-a',
        creationId: res.creation.id,
        onSaveContent: onSaveGallery,
      },
      global: { mocks: { $t } },
    });
    const uploadPromise = galleryWrap.vm.onUploadImage({
      target: { files: [{ name: 'hero.png' }], value: 'hero.png' },
    });
    // Switch to Gallery B and let B hydrate BEFORE Gallery A's upload resolves
    await galleryWrap.setProps({
      node: { id: 'gal-B', title: 'Gallery B', modality: 'image_gallery', currentRevId: 'rev-b' },
      content: JSON.stringify({ frames: [{ frameId: 'fb', title: 'B1', caption: '' }] }),
      contentLoaded: true,
      loadedRevId: 'rev-b',
    });
    resolveUpload({ sources: [{ id: 'src-new', name: 'hero.png' }] });
    await uploadPromise;
    await flushPromises();
    expect(galleryWrap.vm.frames.map((f) => f.title)).toEqual(['B1']);
    expect(onSaveGallery).not.toHaveBeenCalled();
    galleryWrap.unmount();

    // R8: Deferred Gallery A autosave response after switching to Gallery B and editing B must NOT clear B's dirty state or baseRevId!
    let resolveSaveA;
    creationsStore.uploadSources = vi.fn(async () => ({ sources: [{ id: 'src-a2', name: 'a2.png' }] }));
    const deferredSaveA = vi.fn(() => new Promise((r) => { resolveSaveA = r; }));
    const galleryRaceWrap = mount(GalleryReader, {
      props: {
        node: { id: 'gal-A', title: 'Gallery A', modality: 'image_gallery', currentRevId: 'rev-a1' },
        content: JSON.stringify({ frames: [{ frameId: 'fa', title: 'A1', caption: '' }] }),
        contentLoaded: true,
        loadedRevId: 'rev-a1',
        agentId: 'agent-a',
        creationId: res.creation.id,
        onSaveContent: deferredSaveA,
      },
      global: { mocks: { $t } },
    });
    const autoSavePromise = galleryRaceWrap.vm.onUploadImage({
      target: { files: [{ name: 'a2.png' }], value: 'a2.png' },
    });
    await flushPromises();
    expect(deferredSaveA).toHaveBeenCalledTimes(1);
    // Switch to Gallery B and add an unsaved frame while Gallery A's save is still pending
    await galleryRaceWrap.setProps({
      node: { id: 'gal-B', title: 'Gallery B', modality: 'image_gallery', currentRevId: 'rev-b1' },
      content: JSON.stringify({ frames: [{ frameId: 'fb', title: 'B1', caption: '' }] }),
      contentLoaded: true,
      loadedRevId: 'rev-b1',
    });
    galleryRaceWrap.vm.addEmptyFrame();
    await flushPromises();
    expect(galleryRaceWrap.vm.dirty).toBe(true);
    expect(galleryRaceWrap.vm.editBaseRevId).toBe('rev-b1');
    // Now resolve Gallery A's stale save response
    resolveSaveA({ node: { id: 'gal-A', currentRevId: 'rev-a2' } });
    await autoSavePromise;
    await flushPromises();
    // Gallery B's unsaved draft, dirty flag, Save button, and base revision MUST remain untouched!
    expect(galleryRaceWrap.vm.dirty).toBe(true);
    expect(galleryRaceWrap.vm.editBaseRevId).toBe('rev-b1');
    expect(galleryRaceWrap.find('button.is-primary').exists()).toBe(true);
    galleryRaceWrap.unmount();

    // R9: BookReader preserves an undo back to pre-save content A made while saving B (even when content prop updates to B before save promise resolves!)
    let resolveBookSave;
    const bookUndoWrap = mount(BookReader, {
      props: {
        node: { id: 'book-undo', title: 'Chapter Undo', modality: 'markdown_doc', currentRevId: 'rev-1' },
        content: 'Version A',
        contentLoaded: true,
        loadedRevId: 'rev-1',
        agentId: 'agent-a',
        creationId: res.creation.id,
        onSaveContent: vi.fn(() => new Promise((r) => { resolveBookSave = r; })),
      },
      global: { mocks: { $t } },
    });
    bookUndoWrap.vm.enterEditMode();
    await flushPromises();
    // Edit A -> B and click Done (saveEdit(true))
    bookUndoWrap.vm.draftText = 'Version B';
    bookUndoWrap.vm.onEditorInput();
    const pendingBookSave = bookUndoWrap.vm.saveEdit(true);
    // Undo back to 'Version A' BEFORE the save resolves
    bookUndoWrap.vm.draftText = 'Version A';
    bookUndoWrap.vm.onEditorInput();
    expect(bookUndoWrap.vm.dirty).toBe(true);
    // Store publishes 'Version B' as the new content prop BEFORE the save promise resolves
    await bookUndoWrap.setProps({ content: 'Version B', loadedRevId: 'rev-2' });
    expect(bookUndoWrap.vm.draftText).toBe('Version A');
    // Now resolve the save promise
    resolveBookSave({ node: { id: 'book-undo', currentRevId: 'rev-2' } });
    await pendingBookSave;
    await flushPromises();
    // Undone draft 'Version A' must remain preserved, editor stays open & dirty against new base 'rev-2'!
    expect(bookUndoWrap.vm.draftText).toBe('Version A');
    expect(bookUndoWrap.vm.editing).toBe(true);
    expect(bookUndoWrap.vm.dirty).toBe(true);
    expect(bookUndoWrap.vm.editBaseRevId).toBe('rev-2');
    bookUndoWrap.unmount();

    // R10-#1: BookReader unmounting mid-save (e.g., switching Read <-> Studio) must NOT re-mark the store dirty when the save settles!
    let resolveUnmountSave;
    const unmountNodeKey = `agent-a\u001f${res.creation.id}\u001fbook-unmount`;
    creationsStore.nodeContentsByKey[unmountNodeKey] = {
      content: 'Version A', revisions: [], loading: false, loaded: true, loadedRevId: 'rev-1', dirty: false,
    };
    const bookUnmountWrap = mount(BookReader, {
      props: {
        node: { id: 'book-unmount', title: 'Chapter Unmount', modality: 'markdown_doc', currentRevId: 'rev-1' },
        content: 'Version A',
        contentLoaded: true,
        loadedRevId: 'rev-1',
        agentId: 'agent-a',
        creationId: res.creation.id,
        onSaveContent: vi.fn(() => new Promise((r) => { resolveUnmountSave = r; })),
      },
      global: { mocks: { $t } },
    });
    bookUnmountWrap.vm.enterEditMode();
    bookUnmountWrap.vm.draftText = 'Version B';
    bookUnmountWrap.vm.onEditorInput();
    const unmountSavePromise = bookUnmountWrap.vm.saveEdit(false);
    // Type C after submitting B, then unmount reader before save settles
    bookUnmountWrap.vm.draftText = 'Version C';
    bookUnmountWrap.vm.onEditorInput();
    expect(creationsStore.nodeContentsByKey[unmountNodeKey].dirty).toBe(true);
    bookUnmountWrap.unmount();
    expect(creationsStore.nodeContentsByKey[unmountNodeKey].dirty).toBe(false);
    // Late save response settles after unmount -> store dirty flag MUST stay false!
    resolveUnmountSave({ node: { id: 'book-unmount', currentRevId: 'rev-2' } });
    await unmountSavePromise;
    await flushPromises();
    expect(creationsStore.nodeContentsByKey[unmountNodeKey].dirty).toBe(false);

    // R10-#2: Galaxy overlay top padding clears top-left Voyage bar (height 34px + top 16px/12px) on BOTH desktop and <=768px mobile!
    const creationsCssText = readFileSync(resolve(process.cwd(), 'web/styles/cosmos/creations.css'), 'utf8');
    const voyageCssText = readFileSync(resolve(process.cwd(), 'web/styles/cosmos/voyage.css'), 'utf8');
    const voyageBarH = Number(voyageCssText.match(/\.cosmos-voyage-bar\s*\{[^}]*height:\s*(\d+)px/s)?.[1]);
    const voyageTopDesktop = Number(voyageCssText.match(/\.cosmos-voyage-anchor\s*\{[^}]*top:\s*calc\((\d+)px/s)?.[1]);
    const voyageMobileBlock = voyageCssText.slice(voyageCssText.indexOf('@media (max-width: 768px)'));
    const voyageTopMobile = Number(voyageMobileBlock.match(/\.cosmos-voyage-anchor\s*\{[^}]*top:\s*calc\((\d+)px/s)?.[1]);
    const overlayDesktopTop = Number(creationsCssText.match(/\.creation-galaxy-overlay\s*\{[^}]*padding:\s*calc\((\d+)px/s)?.[1]);
    const overlayMobileBlock = creationsCssText.slice(creationsCssText.indexOf('@media (max-width: 768px)'));
    const overlayMobileTop = Number(overlayMobileBlock.match(/\.creation-galaxy-overlay\s*\{[^}]*padding:\s*calc\((\d+)px/s)?.[1]);
    expect(creationsCssText).toMatch(/\.creation-galaxy-overlay\s*\{[^}]*pointer-events:\s*none/s);
    expect(overlayDesktopTop).toBeGreaterThanOrEqual(voyageTopDesktop + voyageBarH);
    expect(overlayMobileTop).toBeGreaterThanOrEqual(voyageTopMobile + voyageBarH);

    creationsStore.uploadSources = origUploadSources;
    creationsStore.request = origRequest;
  });
});
