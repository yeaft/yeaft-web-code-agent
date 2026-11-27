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
});
