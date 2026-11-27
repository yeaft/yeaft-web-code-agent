// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { join, resolve } from 'node:path';
import * as Vue from 'vue';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';

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
import en from '../../web/i18n/en.js';
import zhCN from '../../web/i18n/zh-CN.js';
import { drawCosmosHud } from '../../web/cosmos/particle-hud.js';
import { createCreationService } from '../../agent/yeaft/creations/service.js';
import { createCreationRelay } from '../../server/handlers/client-creation.js';

enableAutoUnmount(afterEach);

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
    for (const key of ['workbench.creation', 'files.canvas', 'files.openFolderInCreation']) {
      expect(zhCN[key], key).toMatch(/\S/);
      expect(en[key], key).toMatch(/\S/);
    }
    for (const key of zhKeys) {
      expect(typeof creationsZh[key]).toBe('string');
      expect(creationsZh[key].trim().length).toBeGreaterThan(0);
      expect(typeof creationsEn[key]).toBe('string');
      expect(creationsEn[key].trim().length).toBeGreaterThan(0);
    }
  });

  it('uses theme tokens in Galaxy, Workbench, and Canvas sources', () => {
    const collect = (dir) => {
      const out = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collect(full));
        else if (entry.name.endsWith('.js')) out.push(full);
      }
      return out;
    };
    const files = ['web/styles/canvas.css', 'web/styles/creation-workbench.css'];
    for (const dir of ['web/components/cosmos/creations', 'web/components/workbench']) {
      const components = collect(dir);
      expect(components.length, dir).toBeGreaterThan(0);
      files.push(...components);
    }
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content, `Hardcoded color in ${file}`).not.toMatch(/#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b|\brgba?\s*\(/i);
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

  it('initializes an Agent-owned folder, isolates lookup and CRUD, and removes the record', async () => {
    const { creation } = await creationsStore.createCreation('agent-a', {
      title: 'Field notes', kind: 'book', initializeFolder: true, autoPlan: false,
    });
    expect(creation.rootDir).toBeTruthy();
    expectWorkspace(creation.rootDir, 'Field notes');
    expect(await creationsStore.ensureWorkspace('agent-a', creation.id)).toMatchObject({
      rootDir: creation.rootDir, materialized: false,
    });
    expect(await creationsStore.findByFolder('agent-a', creation.rootDir)).toMatchObject({ id: creation.id });
    expect(await creationsStore.findByFolder('agent-b', creation.rootDir)).toBeNull();
    await expect(creationsStore.updateCreation('agent-b', creation.id, { title: 'Wrong Agent' })).rejects.toThrow();
    expect(await creationsStore.updateCreation('agent-a', creation.id, { title: 'Updated notes' })).toMatchObject({
      id: creation.id, title: 'Updated notes', rootDir: creation.rootDir,
    });
    expect(await creationsStore.findByFolder('agent-a', creation.rootDir)).toMatchObject({ title: 'Updated notes' });
    await creationsStore.deleteCreation('agent-a', creation.id);
    expect(await creationsStore.findByFolder('agent-a', creation.rootDir)).toBeNull();
    expect(creationsStore.creationsForAgent('agent-a')).toEqual([]);
  });

  it('materializes a legacy Creation into a folder and reuses existing folder bindings without deleting user files', async () => {
    const { creation } = await creationsStore.createCreation('agent-a', { title: 'Legacy atlas', kind: 'book', autoPlan: false });
    expect(creation.rootDir).toBeFalsy();
    const workspace = await creationsStore.ensureWorkspace('agent-a', creation.id);
    expect(workspace).toMatchObject({ materialized: true, creation: { id: creation.id } });
    expectWorkspace(workspace.rootDir, 'Legacy atlas');

    const folder = join(tempDirA, 'existing-notes');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.md'), 'User-owned notes');
    const first = await creationsStore.bindFolderAsCreation({ agentId: 'agent-a', rootDir: folder });
    expect(first).toMatchObject({ existed: false, creation: { title: 'existing-notes', rootDir: folder } });
    const second = await creationsStore.bindFolderAsCreation({
      agentId: 'agent-a', rootDir: `${folder}/`, sessionId: 'linked-session', projectId: 'linked-project',
    });
    expect(second).toMatchObject({ existed: true, creation: {
      id: first.creation.id, rootDir: folder, sessionId: 'linked-session', projectId: 'linked-project',
    } });
    await creationsStore.deleteCreation('agent-a', first.creation.id);
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toBe('User-owned notes');
  });

  it('creates a folder-backed Session/Project linkage and routes it from Cosmos to Classic Workbench', async () => {
    const { sessions } = await registerBrowserStores();
    // The Creation RPC travels through the real relay/service; Session and Project RPCs are separate boundaries.
    chatStore.createYeaftSession = vi.fn().mockResolvedValue({ session: { id: 'session-new' } });
    chatStore.mutateProject = vi.fn().mockResolvedValueOnce({ result: { id: 'project-new' } });
    const result = await creationsStore.createWorkspaceCreation({
      agentId: 'agent-a', title: 'Atlas', newProjectName: 'New maps', sessionMode: 'new', prompt: 'Plan the atlas',
    });
    expectWorkspace(result.rootDir, 'Atlas');
    expect(chatStore.createYeaftSession).toHaveBeenCalledWith({ agentId: 'agent-a', displayName: 'Atlas', workDir: result.rootDir });
    expect(chatStore.mutateProject.mock.calls).toEqual([
      ['create', { name: 'New maps' }, 'agent-a'],
      ['move_session', { sessionId: 'session-new', projectId: 'project-new' }, 'agent-a'],
    ]);
    const linked = await creationsStore.findByFolder('agent-a', result.rootDir);
    expect(linked).toMatchObject({ id: result.creation.id, sessionId: 'session-new', projectId: 'project-new' });
    sessions.applySnapshotUpsert({ id: 'session-new', name: 'Atlas' }, 'agent-a');
    expect(await creationsStore.resolveCreationSession('agent-a', linked)).toMatchObject({
      sessionId: 'session-new', rootDir: result.rootDir,
    });
    expect(chatStore.createYeaftSession).toHaveBeenCalledTimes(1);

    chatStore.uiMode = 'cosmos';
    chatStore.setUiMode = vi.fn();
    chatStore.enterYeaft = vi.fn();
    chatStore.setActiveSessionFilter = vi.fn();
    sessions.setActive = vi.fn();
    await creationsStore.openCreationInClassic({ agentId: 'agent-a', creationId: linked.id, mode: 'read', openedFromGalaxy: true });
    expect(chatStore.setUiMode).toHaveBeenCalledWith('classic');
    expect(sessions.setActive).toHaveBeenCalledWith('session-new', 'agent-a');
    expect(chatStore.setActiveSessionFilter).toHaveBeenCalledWith('session-new', { agentId: 'agent-a', force: true });
    expect(creationsStore.pendingWorkbenchTarget).toMatchObject({
      agentId: 'agent-a', sessionId: 'session-new', creationId: linked.id, rootDir: result.rootDir,
      maximize: true, openedFromGalaxy: true,
    });
  });

  it('links an existing Session and replaces an unknown Session only when requested', async () => {
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: 'session-shared', name: 'Existing Atlas Session' }, 'agent-a');
    chatStore.updateYeaftSessionWorkDir = vi.fn().mockResolvedValue(true);
    chatStore.createYeaftSession = vi.fn().mockResolvedValue({ session: { id: 'session-replacement' } });
    const { creation, rootDir } = await creationsStore.createWorkspaceCreation({
      agentId: 'agent-a', title: 'Existing Atlas', sessionMode: 'existing', existingSessionId: 'session-shared',
    });
    expect(creation.sessionId).toBe('session-shared');
    expect(chatStore.updateYeaftSessionWorkDir).toHaveBeenCalledExactlyOnceWith({
      agentId: 'agent-a', sessionId: 'session-shared', workDir: rootDir,
    });
    expect(chatStore.createYeaftSession).not.toHaveBeenCalled();

    const stale = await creationsStore.updateCreation('agent-a', creation.id, { sessionId: 'unknown-session' });
    expect(await creationsStore.resolveCreationSession('agent-a', stale, { createIfMissing: false })).toMatchObject({ sessionId: null, rootDir });
    expect(chatStore.createYeaftSession).not.toHaveBeenCalled();
    expect(await creationsStore.resolveCreationSession('agent-a', stale)).toMatchObject({ sessionId: 'session-replacement', rootDir });
    expect(chatStore.createYeaftSession).toHaveBeenCalledExactlyOnceWith({
      agentId: 'agent-a', displayName: 'Existing Atlas', workDir: rootDir,
    });
    expect(await creationsStore.findByFolder('agent-a', rootDir)).toMatchObject({ id: creation.id, sessionId: 'session-replacement' });
  });

  it('B04: CAS revision conflict in updateNode preserves server content', async () => {
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
      const result = await origCreate.call(creationsStore, agentId, payload);
      if (payload.importKey === 'legacy-book:bm-2' && failSecondOnce) {
        failSecondOnce = false;
        throw new Error('Lost ACK');
      }
      return result;
    });

    const wrapper = mount(CosmosGalaxyOverlay, {
      props: {
        visible: true,
        agents: [{ id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] }],
      },
      global: { mocks: { $t } },
    });
    await flushPromises();

    // Both writes are committed; the browser sees no acknowledgement for bm-2.
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
    await creationsStore.selectGalaxyAgent('agent-a', { force: true });
    expect(creationsStore.currentAgentCreations.map(c => c.title).sort()).toEqual(['Nebula Guide', 'Star Atlas']);

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

  it('reconcileAfterReconnect refreshes clean active node body and preserves dirty draft', async () => {
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

  it('Ignite preserves newly queued files and draft when switching Agent mid-submit', async () => {
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const $t = (k) => creationsZh[k] || k;

    await creationsStore.selectGalaxyAgent('agent-a', { force: true });

    let resolveCreate;
    const origCreate = creationsStore.createWorkspaceCreation;
    creationsStore.createWorkspaceCreation = vi.fn(() => new Promise((r) => { resolveCreate = r; }));

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

    creationsStore.createWorkspaceCreation = origCreate;
    wrapper.unmount();
  });

});

const t = key => en[key] || key;
const route = { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'session-a' };
const rootDir = '/workspace/atlas';
const routeKey = 'yeaft:agent-a:session-a';
const routeProps = { ...route, routeKey, workDir: rootDir, conversationId: `_workbench:${routeKey}`, workspaceGeneration: 'atlas-generation' };
const hostileHtml = '<script>alert(1)</script><img src="./cover.png" onerror="alert(2)"><a href="javascript:alert(3)">Unsafe link</a>';

function fireWindowEvent(type, detail) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function render(component, { props, stubs, translate = t } = {}) {
  return mount(component, { props, global: { mocks: { $t: translate }, provide: { t: translate }, stubs } });
}

function installMarkdownParser() {
  const vendor = {};
  runInNewContext(readFileSync('web/vendor/marked.min.js', 'utf8'), vendor);
  vi.stubGlobal('marked', vendor.marked);
}

function button(wrapper, label, selector = 'button') {
  const match = wrapper.findAll(selector).find(item => item.text() === label);
  expect(match, `Missing ${selector} with text ${label}`).toBeDefined();
  return match;
}

async function registerBrowserStores() {
  const [{ useChatStore }, { useSessionsStore }, { useAuthStore }, { useVpStore }] = await Promise.all([
    import('../../web/stores/chat.js'), import('../../web/stores/sessions.js'),
    import('../../web/stores/auth.js'), import('../../web/stores/vp.js'),
  ]);
  Object.assign(Pinia, { useChatStore, useSessionsStore, useAuthStore, useVpStore });
  return { chat: useChatStore(), sessions: useSessionsStore() };
}

function expectWorkspace(path, title) {
  expect(readdirSync(path).sort()).toEqual(['README.md', 'docs', 'images', 'sources', 'videos']);
  expect(readFileSync(join(path, 'README.md'), 'utf8')).toContain(`# ${title}`);
}

it('sanitizes Creation markup and rejects unsafe URL schemes without dropping safe content', async () => {
  const { sanitizeCreationHtml, isSafeCreationUrl } = await import('../../web/components/cosmos/creations/sanitize.js');
  const cleaned = sanitizeCreationHtml(`<p>Safe</p>${hostileHtml}<iframe></iframe><svg></svg>`);
  expect(cleaned).toContain('<p>Safe</p>');
  expect(cleaned).toContain('src="./cover.png"');
  expect(cleaned).toContain('<a>Unsafe link</a>');
  expect(cleaned).not.toMatch(/<script|onerror|javascript:|<iframe|<svg/i);
  for (const url of ['javascript:alert(1)', ' JaVa\nScRiPt:alert(1)', 'data:text/html,unsafe', '//example.test']) {
    expect(isSafeCreationUrl(url), url).toBe(false);
  }
  expect(isSafeCreationUrl('./cover.png')).toBe(true);
  expect(isSafeCreationUrl('https://example.test')).toBe(true);
  expect(isSafeCreationUrl('mailto:art@example.test')).toBe(false);
  expect(isSafeCreationUrl('mailto:art@example.test', { allowMailto: true })).toBe(true);
});

describe('File Canvas and route-scoped composer references', () => {
  let context;
  let FileCanvasView;
  const otherRoute = 'yeaft:agent-b:session-b';

  beforeEach(async () => {
    resetPiniaStores();
    [context, { default: FileCanvasView }] = await Promise.all([
      import('../../web/utils/canvas-context.js'), import('../../web/components/workbench/FileCanvasView.js'),
    ]);
    installMarkdownParser();
  });

  afterEach(() => {
    context.clearCanvasContextRefs(routeKey);
    context.clearCanvasContextRefs(otherRoute);
    vi.unstubAllGlobals();
  });

  it('deduplicates references, dispatches the canonical reference, and evicts only the oldest item on the same route', () => {
    const { addCanvasContextRef, getCanvasContextRefs, removeCanvasContextRef, clearCanvasContextRefs } = context;
    const listener = vi.fn();
    window.addEventListener('canvas-context-added', listener, { once: true });
    const first = addCanvasContextRef(` ${routeKey} `, { kind: 'doc', filePath: '/atlas/intro.md', snippet: 'Intro' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail).toEqual({ routeKey, ref: first });
    expect(addCanvasContextRef(routeKey, { kind: 'doc', filePath: '/atlas/intro.md', snippet: ' Intro ' }).id).toBe(first.id);
    expect(getCanvasContextRefs(routeKey)).toHaveLength(1);

    const isolated = addCanvasContextRef(otherRoute, { kind: 'image', filePath: '/atlas/cover.png' });
    const newest = Array.from({ length: 6 }, (_, i) => addCanvasContextRef(routeKey, {
      kind: 'video', filePath: '/atlas/trailer.mp4', timestampSec: i,
    }));
    expect(getCanvasContextRefs(routeKey)).toEqual(newest);
    removeCanvasContextRef(routeKey, newest[2].id);
    expect(getCanvasContextRefs(routeKey)).toEqual(newest.filter((_, i) => i !== 2));
    clearCanvasContextRefs(routeKey);
    expect(getCanvasContextRefs(routeKey)).toEqual([]);
    expect(getCanvasContextRefs(otherRoute)).toEqual([isolated]);
  });

  it('formats timestamps and exact Markdown quote blocks for documents, images, and video', () => {
    const { formatTimestampLabel, formatCanvasContextPrefix } = context;
    expect([0, 65.9, 3661, -1, NaN].map(formatTimestampLabel)).toEqual(['00:00', '01:05', '01:01:01', '00:00', '00:00']);
    expect(formatCanvasContextPrefix([])).toBe('');
    expect(formatCanvasContextPrefix([
      { kind: 'doc', filePath: '/atlas/intro.md', lineStart: 2, lineEnd: 3, snippet: 'First\nSecond' },
      { kind: 'image', filePath: '/atlas/cover.png' },
      { kind: 'video', filePath: '/atlas/trailer.mp4', timestampSec: 65 },
    ])).toBe('> [Canvas Doc] `/atlas/intro.md` (L2-L3)\n> First\n> Second\n\n'
      + '> [Canvas Image] `/atlas/cover.png`\n\n> [Canvas Video] `/atlas/trailer.mp4` @ 01:05');
  });

  it('classifies supported documents, images and videos but not source files or archives', async () => {
    const { isCanvasSupportedFile } = await import('../../web/components/workbench/FileCanvasView.js');
    for (const [kind, extensions] of [['doc', ['md', 'txt']], ['image', ['png', 'svg', 'webp']], ['video', ['mp4', 'webm']], [null, ['js', 'json', 'zip']]]) {
      for (const ext of extensions) expect(isCanvasSupportedFile(`atlas.${ext}`), ext).toBe(kind);
    }
    expect(isCanvasSupportedFile({ path: '/atlas/README.MD' })).toBe('doc');
  });

  it('reads sanitized Markdown, navigates its TOC, and edits, references and saves a selection', async () => {
    const file = Vue.reactive({ name: 'intro.md', path: '/atlas/intro.md', content: `# Atlas\n\n## Opening\n\n**Bold**\n\n${hostileHtml}` });
    const wrapper = render(FileCanvasView, { props: { routeKey, file, 'onUpdate:content': content => {
      file.content = content;
      file.isDirty = true;
    } } });
    const reader = wrapper.get('.canvas-doc-content');
    expect(reader.get('h1').text()).toBe('Atlas');
    expect(reader.get('h2').text()).toBe('Opening');
    expect(reader.get('strong').text()).toBe('Bold');
    expect(reader.get('img').attributes('src')).toBe('./cover.png');
    expect(reader.get('a').text()).toBe('Unsafe link');
    expect(reader.html()).not.toMatch(/<script|onerror|javascript:/i);

    await wrapper.get(`button[title="${t('creation.canvas.toc')}"]`).trigger('click');
    const entries = wrapper.findAll('.canvas-toc-item');
    expect(entries.map(item => item.text())).toEqual(['Atlas', 'Opening']);
    expect(entries[1].classes()).toContain('canvas-toc-level-2');
    await button(wrapper, t('creation.canvas.edit')).trigger('click');
    const editor = wrapper.get('textarea.canvas-doc-editor');
    expect(wrapper.find('.canvas-doc-content').exists()).toBe(false);
    await entries[1].trigger('click');
    expect(editor.element.value.slice(editor.element.selectionStart, editor.element.selectionEnd)).toBe('## Opening');
    const draft = '# Atlas revised\n\nFirst line\nSecond line';
    await editor.setValue(draft);
    expect(wrapper.emitted('update:content')).toEqual([[draft]]);
    editor.element.setSelectionRange(draft.indexOf('First line'), draft.length);
    await editor.trigger('select');
    await wrapper.get('.canvas-ref-btn').trigger('click');
    expect(context.getCanvasContextRefs(routeKey)).toMatchObject([
      { kind: 'doc', filePath: file.path, snippet: 'First line\nSecond line', lineStart: 3, lineEnd: 4 },
    ]);
    await wrapper.get('.canvas-save-btn').trigger('click');
    expect(wrapper.emitted('save')).toEqual([[]]);
    await button(wrapper, t('creation.canvas.read')).trigger('click');
    expect(wrapper.find('textarea').exists()).toBe(false);
    expect(wrapper.get('.canvas-doc-content h1').text()).toBe('Atlas revised');
  });

  it('zooms and references images, and displays text SVG only in safe image mode', async () => {
    const file = { name: 'cover.png', path: '/atlas/cover.png', blobUrl: 'blob:cover' };
    const wrapper = render(FileCanvasView, { props: { routeKey, file } });
    const image = wrapper.get('.canvas-image-stage img');
    expect(image.attributes('src')).toBe(file.blobUrl);
    await wrapper.get(`button[title="${t('git.zoomIn')}"]`).trigger('click');
    expect(wrapper.get('.canvas-zoom-readout').text()).toBe('125%');
    expect(image.element.style.transform).toBe('scale(1.25)');
    await wrapper.get(`button[title="${t('git.zoomOut')}"]`).trigger('click');
    expect(wrapper.get('.canvas-zoom-readout').text()).toBe('100%');
    await wrapper.get('.canvas-ref-btn').trigger('click');
    expect(context.getCanvasContextRefs(routeKey)).toMatchObject([{ kind: 'image', filePath: file.path }]);

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><circle r="3"/></svg>';
    await wrapper.setProps({ file: { path: '/atlas/drawing.svg', name: 'drawing.svg', fileType: 'text', content: svg } });
    const preview = wrapper.get('.canvas-image-stage .svg-preview-container');
    expect(preview.get('img').attributes('src')).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    expect(wrapper.find('.canvas-image-stage svg, .canvas-image-stage script, .canvas-image-stage [onload]').exists()).toBe(false);
  });

  it('sets video playback speed and adds, seeks, references and deletes timestamp markers', async () => {
    const file = { name: 'trailer.webm', path: '/atlas/trailer.webm', blobUrl: 'blob:trailer' };
    const wrapper = render(FileCanvasView, { props: { routeKey, file } });
    const video = wrapper.get('video[controls]');
    expect(video.attributes('src')).toBe(file.blobUrl);
    await wrapper.get('.canvas-rate-select').setValue('1.5');
    expect(video.element.playbackRate).toBe(1.5);
    video.element.currentTime = 65.8;
    await video.trigger('timeupdate');
    expect(wrapper.get('.canvas-ref-btn').text()).toContain('@ 01:05');
    await wrapper.get('.canvas-ref-btn').trigger('click');
    expect(context.getCanvasContextRefs(routeKey)).toMatchObject([
      { kind: 'video', filePath: file.path, timestampSec: 65, timestampLabel: '01:05' },
    ]);
    const add = button(wrapper, `+ ${t('creation.canvas.addBookmark')}`);
    await add.trigger('click');
    await add.trigger('click');
    expect(wrapper.findAll('.canvas-video-marker')).toHaveLength(1);
    video.element.currentTime = 0;
    await video.trigger('timeupdate');
    const jump = wrapper.get('.canvas-marker-jump');
    expect(jump.text()).toBe('01:05');
    await jump.trigger('click');
    expect(video.element.currentTime).toBe(65);
    await wrapper.get('.canvas-marker-remove').trigger('click');
    expect(wrapper.find('.canvas-video-marker').exists()).toBe(false);
  });

  it('sends Canvas refs through the real composer, preserving them on rejection and clearing them on acceptance', async () => {
    const { chat } = await registerBrowserStores();
    chat.currentView = 'yeaft';
    chat.connectionState = 'connected';
    chat.authenticated = true;
    chat.currentAgent = route.agentId;
    chat.yeaftActiveSessionFilter = route.sessionId;
    const { default: ChatInput } = await import('../../web/components/ChatInput.js');
    const { addCanvasContextRef, getCanvasContextRefs, formatCanvasContextPrefix } = context;
    addCanvasContextRef(routeKey, { kind: 'doc', filePath: '/atlas/intro.md', lineStart: 4, snippet: 'The opening' });
    const video = addCanvasContextRef(routeKey, { kind: 'video', filePath: '/atlas/clip.mp4', timestampSec: 81 });
    addCanvasContextRef(otherRoute, { kind: 'image', filePath: '/other/hidden.png' });
    const sendFn = vi.fn().mockReturnValueOnce(false).mockResolvedValueOnce(true);
    const wrapper = render(ChatInput, { props: { sendFn } });
    expect(wrapper.findAll('.canvas-context-chip').map(chip => chip.get('.canvas-chip-name').text())).toEqual(['intro.md', 'clip.mp4']);
    expect(wrapper.get('.canvas-chip-video').text()).toContain('@ 01:21');
    expect(wrapper.findAll('button').map(b => [b.text(), b.attributes('title'), b.attributes('aria-label'), b.attributes('class')].join(' ')).join('\n')).not.toMatch(/creation/i);
    const send = wrapper.get('button.send-btn');
    expect(send.element.disabled).toBe(false);
    const prefix = formatCanvasContextPrefix(getCanvasContextRefs(routeKey));
    await send.trigger('click');
    expect(sendFn).toHaveBeenNthCalledWith(1, prefix, undefined);
    expect(getCanvasContextRefs(routeKey)).toHaveLength(2);
    expect(wrapper.findAll('.canvas-context-chip')).toHaveLength(2);
    await wrapper.get('.canvas-chip-doc .canvas-chip-remove').trigger('click');
    await wrapper.get('textarea').setValue('Discuss the clip');
    await send.trigger('click');
    await flushPromises();
    expect(sendFn).toHaveBeenNthCalledWith(2, `${formatCanvasContextPrefix([video])}\n\nDiscuss the clip`, undefined);
    expect(getCanvasContextRefs(routeKey)).toEqual([]);
    expect(getCanvasContextRefs(otherRoute)).toHaveLength(1);
    expect(wrapper.find('.canvas-context-chip').exists()).toBe(false);
    expect(send.element.disabled).toBe(true);
  });
});

// Simulate only the Workbench transport. Keep the real route metadata and request IDs
// so file navigation, response correlation, and component lifecycle all run normally.
function mockWorkbenchFiles(chat, listings = {}, contents = {}) {
  chat.sendWsMessage = vi.fn(request => {
    let response;
    if (request.type === 'list_directory') {
      response = { type: 'directory_listing', entries: (listings[request.dirPath] || []).map(entry => ({ ...entry })) };
    } else if (request.type === 'read_file') {
      response = Object.hasOwn(contents, request.filePath)
        ? { type: 'file_content', content: contents[request.filePath] }
        : { type: 'file_content', error: 'Fixture has no preview' };
    } else if (request.type === 'write_file') {
      contents[request.filePath] = request.content;
      response = { type: 'file_op_result', success: true };
    }
    if (response) queueMicrotask(() => fireWindowEvent('workbench-message', { ...request, ...response }));
    return true;
  });
  return chat.sendWsMessage;
}

describe('Folder Creation and Files in Workbench', () => {
  let chat;
  let creations;
  let FileCanvasView;
  let CreationTab;

  beforeEach(async () => {
    resetPiniaStores();
    ({ chat } = await registerBrowserStores());
    const [{ useCreationsStore }, canvas, creation] = await Promise.all([
      import('../../web/stores/creations.js'),
      import('../../web/components/workbench/FileCanvasView.js'),
      import('../../web/components/workbench/CreationTab.js'),
    ]);
    creations = useCreationsStore();
    FileCanvasView = canvas.default;
    CreationTab = creation.default;
    chat.currentAgent = route.agentId;
    chat.currentView = 'yeaft';
    chat.yeaftActiveSessionFilter = route.sessionId;
    chat.agents = [{ id: route.agentId, online: true, capabilities: ['creations', 'file_editor', 'workbench_session_routes'] }];
    chat.workbenchRouteProtocolSupported = true;
    chat.connectionState = 'connected';
    chat.authenticated = true;
    creations.byAgent[route.agentId] = { loaded: true, list: [] };
    installMarkdownParser();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('opens Markdown in Files, switches between Preview, Canvas and Edit, and promotes a folder', async () => {
    const { default: FilesTab } = await import('../../web/components/FilesTab.js');
    mockWorkbenchFiles(chat, {
      [rootDir]: [{ name: 'docs', type: 'directory' }, { name: 'atlas.md', type: 'file' }, { name: 'build.js', type: 'file' }],
    }, { [`${rootDir}/atlas.md`]: '# Atlas', [`${rootDir}/build.js`]: 'const edition = 1;' });
    const wrapper = render(FilesTab, { props: routeProps });
    await flushPromises();
    await wrapper.get('[data-tree-path$="/atlas.md"]').trigger('click');
    await flushPromises();
    const canvas = () => wrapper.get('.file-action-canvas');
    const preview = () => button(wrapper, t('files.preview'), '.file-content-actions button');
    const edit = () => button(wrapper, t('files.edit'), '.file-content-actions button');
    expect(canvas().text()).toBe(`✦ ${t('files.canvas')}`);
    await preview().trigger('click');
    expect(wrapper.get('.md-file-preview').text()).toBe('Atlas');
    await canvas().trigger('click');
    expect(canvas().attributes('aria-pressed')).toBe('true');
    expect(wrapper.getComponent(FileCanvasView).get('h1').text()).toBe('Atlas');
    expect(wrapper.find('.md-file-preview').exists()).toBe(false);
    await canvas().trigger('click');
    expect(preview().attributes('aria-pressed')).toBe('true');
    expect(wrapper.findComponent(FileCanvasView).exists()).toBe(false);
    await canvas().trigger('click');
    await edit().trigger('click');
    expect(wrapper.findComponent(FileCanvasView).exists()).toBe(false);
    expect(edit().attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('textarea').element.value).toBe('# Atlas');

    await wrapper.get('[data-tree-path$="/build.js"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('.file-editor-container textarea').element?.value).toBe('const edition = 1;'));
    expect(wrapper.find('.file-action-canvas').exists()).toBe(false);
    const open = vi.fn();
    window.addEventListener('workbench-open-creation', open);
    try {
      await wrapper.get('[data-tree-path$="/docs"]').trigger('contextmenu');
      await button(wrapper, `✦ ${t('files.openFolderInCreation')}`, '.ctx-menu .ctx-menu-item').trigger('click');
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0].detail).toMatchObject({ routeKey, rootDir: `${rootDir}/docs` });
    } finally {
      window.removeEventListener('workbench-open-creation', open);
    }
  });

  it('opens the real Creation capability for route-scoped events and consumes matching pending targets', async () => {
    const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
    const firstDir = `${rootDir}/first`;
    const secondDir = `${rootDir}/second`;
    const first = { id: 'first', title: 'First folder', rootDir: firstDir };
    const second = { id: 'second', title: 'Second folder', rootDir: secondDir };
    creations.byAgent[route.agentId].list = [first, second];
    const send = mockWorkbenchFiles(chat);
    const wrapper = render(WorkbenchPanel, { props: { ownerRoute: route, ownerWorkDir: rootDir } });
    expect(wrapper.get('.workbench-capability-card[data-workbench-capability="creation"]').classes()).not.toContain('unavailable');
    expect(wrapper.classes()).not.toContain('expanded');
    fireWindowEvent('workbench-open-creation', { routeKey: 'other-route', rootDir: firstDir });
    await Vue.nextTick();
    expect(wrapper.findComponent(CreationTab).exists()).toBe(false);
    const detail = { routeKey, creationId: first.id, rootDir: firstDir, maximize: false };
    fireWindowEvent('workbench-open-creation', detail);
    await flushPromises();
    expect(detail.accepted).toBe(true);
    expect(wrapper.classes()).toContain('expanded');
    expect(wrapper.classes()).not.toContain('maximized');
    expect(wrapper.get('.workbench-capability-host').classes()).toContain('capability-creation');
    expect(wrapper.getComponent(CreationTab).text()).toContain(first.title);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'list_directory', dirPath: firstDir, workbenchRoute: route }));

    const target = creations.setPendingWorkbenchTarget({ ...route, sessionId: 'other-session', creationId: second.id, rootDir: secondDir, maximize: true });
    await Vue.nextTick();
    expect(creations.pendingWorkbenchTarget).toEqual(target);
    expect(wrapper.classes()).not.toContain('maximized');
    wrapper.unmount();
    // The store queues this target before the destination Workbench mounts on navigation.
    creations.setPendingWorkbenchTarget({ ...route, creationId: second.id, rootDir: secondDir, maximize: true });
    const destination = render(WorkbenchPanel, { props: { ownerRoute: route, ownerWorkDir: rootDir } });
    await flushPromises();
    expect(destination.classes()).toEqual(expect.arrayContaining(['expanded', 'maximized']));
    expect(destination.getComponent(CreationTab).text()).toContain(second.title);
    expect(creations.pendingWorkbenchTarget).toBeNull();
  });

  it('onboards an unbound folder, scans its nested files into modality tabs, saves a document and opens Files', async () => {
    const existing = { id: 'other', title: 'Other Creation', rootDir: '/workspace/other' };
    const creation = { id: 'atlas', title: 'Atlas Creation', rootDir, sessionId: route.sessionId };
    creations.byAgent[route.agentId].list = [existing];
    // This test starts unbound; the store integration above tests the actual folder binding RPC.
    creations.findByFolder = vi.fn().mockReturnValue(null);
    creations.bindFolderAsCreation = vi.fn().mockResolvedValue({ creation });
    const chapter = `${rootDir}/chapters/part-1/opening.md`;
    const send = mockWorkbenchFiles(chat, {
      [rootDir]: [{ name: 'README.md', type: 'file' }, { name: 'chapters', type: 'directory' }, { name: 'cover.png', type: 'file' }, { name: 'intro.mp4', type: 'file' }, { name: 'build.js', type: 'file' }],
      [`${rootDir}/chapters`]: [{ name: 'part-1', type: 'directory' }],
      [`${rootDir}/chapters/part-1`]: [{ name: 'opening.md', type: 'file' }],
    }, { [`${rootDir}/README.md`]: '# Atlas overview', [chapter]: '# Opening chapter' });
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    const onboarding = wrapper.get('.creation-wb-onboarding');
    expect(onboarding.findAll('.creation-wb-action-title').map(el => el.text())).toEqual([
      t('creation.workbench.createNew'), t('creation.workbench.useCurrentFolder'),
    ]);
    expect(onboarding.get('.creation-wb-existing-section h3').text()).toBe(t('creation.workbench.openExisting'));
    expect(onboarding.get('.creation-wb-existing-list button').text()).toContain(existing.title);
    await onboarding.findAll('.creation-wb-action-card')[1].trigger('click');
    await flushPromises();
    expect(creations.bindFolderAsCreation).toHaveBeenCalledWith({ agentId: route.agentId, sessionId: route.sessionId, rootDir });
    expect(wrapper.find('.creation-wb-onboarding').exists()).toBe(false);
    expect(send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'list_directory').map(msg => msg.dirPath))
      .toEqual([rootDir, `${rootDir}/chapters`, `${rootDir}/chapters/part-1`]);
    const tabs = wrapper.findAll('.creation-wb-tab');
    expect(tabs.map(tab => tab.get('span').text())).toEqual([
      t('creation.workbench.docs'), t('creation.workbench.images'), t('creation.workbench.videos'),
    ]);
    expect(tabs.map(tab => tab.get('.creation-wb-tab-count').text())).toEqual(['2', '1', '1']);
    await tabs[1].trigger('click');
    expect(tabs[1].attributes('aria-selected')).toBe('true');
    expect(wrapper.get('.creation-wb-image-card').text()).toContain('cover.png');
    await tabs[2].trigger('click');
    expect(tabs[2].attributes('aria-selected')).toBe('true');
    expect(wrapper.get('.creation-wb-video-card').text()).toContain('intro.mp4');
    await tabs[0].trigger('click');
    expect(wrapper.getComponent(FileCanvasView).get('h1').text()).toBe('Atlas overview');
    expect(wrapper.find('.creation-wb-tree-row[title="chapters/part-1/opening.md"]').exists()).toBe(false);
    await wrapper.get('.creation-wb-tree-row.is-folder[title="chapters/part-1"]').trigger('click');
    await wrapper.get('.creation-wb-tree-row[title="chapters/part-1/opening.md"]').trigger('click');
    await flushPromises();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'read_file', filePath: chapter, workbenchRoute: route }));
    const canvas = wrapper.getComponent(FileCanvasView);
    expect(canvas.get('h1').text()).toBe('Opening chapter');
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('# Revised chapter');
    await canvas.get('.canvas-save-btn').trigger('click');
    await flushPromises();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'write_file', filePath: chapter, content: '# Revised chapter', workbenchRoute: route }));
    expect(canvas.find('.canvas-save-btn').exists()).toBe(false);
    const openFiles = vi.fn();
    const openDir = vi.fn();
    window.addEventListener('workbench-open-capability', openFiles);
    window.addEventListener('workbench-files-open-dir', openDir);
    try {
      await wrapper.get(`.creation-wb-header-actions button[title="${t('creation.workbench.openInFiles')}"]`).trigger('click');
      expect(openFiles.mock.calls[0][0].detail).toEqual({ routeKey, capabilityId: 'files' });
      expect(openDir.mock.calls[0][0].detail).toEqual({ routeKey, agentId: route.agentId, dirPath: rootDir });
    } finally {
      window.removeEventListener('workbench-open-capability', openFiles);
      window.removeEventListener('workbench-files-open-dir', openDir);
    }
  });
});

describe('Creation launchers in Classic and Cosmos', () => {
  const alpha = { id: 'user_1700000000000_a3f:Alpha', online: true, capabilities: ['creations', 'file_editor', 'workbench_session_routes'] };
  const beta = { id: 'user_1700000000000_b4f:Beta', name: 'Beta Studio', online: true, capabilities: ['creations'] };
  const project = { id: 'maps', name: 'Map Project' };
  const linkedSession = { id: 'mapping', name: 'Mapping Session', workDir: rootDir };
  const atlas = { id: 'atlas', title: 'Field Atlas', kind: 'book', agentId: alpha.id, projectId: project.id, sessionId: linkedSession.id, rootDir };
  const film = { id: 'atlas', title: 'Night Film', kind: 'video', agentId: beta.id };
  let chat;
  let creations;
  let CreationCreateModal;

  beforeEach(async () => {
    resetPiniaStores();
    const stores = await registerBrowserStores();
    chat = stores.chat;
    const [{ useCreationsStore }, modal] = await Promise.all([
      import('../../web/stores/creations.js'), import('../../web/components/workbench/CreationCreateModal.js'),
    ]);
    CreationCreateModal = modal.default;
    creations = useCreationsStore();
    chat.agents = [alpha, beta];
    chat.currentAgent = alpha.id;
    chat.sessionProjects = [project];
    chat.sendWsMessage = vi.fn(() => false);
    stores.sessions.applySnapshotUpsert(linkedSession, alpha.id);
    stores.sessions.applySnapshotUpsert({ id: 'other', name: 'Other Agent Session' }, beta.id);
    creations.selectedAgentId = alpha.id;
    creations.byAgent[alpha.id] = { loaded: true, list: [atlas] };
    creations.byAgent[beta.id] = { loaded: true, list: [film] };
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { sessionMode: 'existing', projectId: 'maps', newProjectName: '', existingSessionId: 'mapping' },
    { sessionMode: 'new', projectId: '', newProjectName: 'New Maps', existingSessionId: '' },
  ])('submits the Creation modal with the selected Project and $sessionMode Session', async selection => {
    creations.createWorkspaceCreation = vi.fn().mockResolvedValue({ agentId: alpha.id, creation: atlas, sessionId: atlas.sessionId });
    // Inline only Teleport so the real form remains queryable within its wrapper.
    const wrapper = render(CreationCreateModal, { stubs: { Teleport: true } });
    const agentSelect = wrapper.get('#creation-create-agent');
    expect(agentSelect.findAll('option').map(option => option.text())).toEqual(['Alpha', 'Beta Studio']);
    expect(agentSelect.element.value).toBe(alpha.id);
    expect(wrapper.get('button[type="submit"]').element.disabled).toBe(true);
    await wrapper.get('#creation-create-title').setValue('New Atlas');
    const projectSelect = wrapper.get('select#creation-create-project');
    expect(projectSelect.get(`option[value="${project.id}"]`).text()).toBe(project.name);
    await projectSelect.setValue(project.id);
    const modes = () => wrapper.findAll('.creation-session-mode-toggle [role="radio"]');
    expect(modes().map(mode => mode.attributes('aria-checked'))).toEqual(['true', 'false']);
    await modes()[1].trigger('click');
    expect(modes()[1].attributes('aria-checked')).toBe('true');
    const sessionSelect = wrapper.get('.creation-existing-session-wrap select');
    expect(sessionSelect.findAll('option').map(option => option.text())).toEqual([linkedSession.name]);
    await sessionSelect.setValue(linkedSession.id);
    if (selection.newProjectName) {
      const toggle = wrapper.get('.creation-create-inline-toggle');
      expect(toggle.text()).toBe(`+ ${t('creation.create.newProject')}`);
      await toggle.trigger('click');
      expect(wrapper.get('button[type="submit"]').element.disabled).toBe(true);
      await wrapper.get('input#creation-create-project').setValue(selection.newProjectName);
      await modes()[0].trigger('click');
      expect(modes()[0].attributes('aria-checked')).toBe('true');
      expect(wrapper.find('.creation-existing-session-wrap').exists()).toBe(false);
    }
    expect(wrapper.get('button[type="submit"]').element.disabled).toBe(false);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(creations.createWorkspaceCreation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      ...selection, agentId: alpha.id, title: 'New Atlas', kind: 'book',
    }));
    expect(wrapper.emitted('created')[0][0]).toMatchObject({ agentId: alpha.id, creation: atlas });
  });

  it('renders friendly Galaxy Agents, shows Ignite linkage controls and opens the linked Creation in either mode', async () => {
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const wrapper = render(CosmosGalaxyOverlay, { props: { visible: true, agents: [alpha, beta] } });
    await flushPromises();
    expect(wrapper.findAll('.creation-agent-pill').map(pill => pill.findAll('span')[1].text())).toEqual(['Alpha', 'Beta Studio']);
    await wrapper.get('.creation-ignite-input').trigger('focus');
    const [agent, projectSelect, session] = wrapper.findAll('.creation-ignite-selectors label select');
    expect(agent.get(`option[value="${alpha.id}"]`).text()).toBe('Alpha');
    expect(projectSelect.get(`option[value="${project.id}"]`).text()).toBe(project.name);
    expect([...session.element.options].map(option => option.value)).toEqual(['new', 'existing']);
    await session.setValue('existing');
    expect(wrapper.get('.is-session-picker').get('option').text()).toBe(linkedSession.name);

    await wrapper.findAll('.creation-view-btn')[1].trigger('click');
    expect(wrapper.get('.creation-catalog-card').text()).toContain(atlas.title);
    // Inspector targets normally arrive from the Galaxy particle interaction.
    creations.inspectorTarget = { agentId: alpha.id, creationId: atlas.id };
    await Vue.nextTick();
    const inspector = wrapper.get('.creation-inspector-card');
    expect(inspector.get('.creation-meta-badge.is-project').text()).toBe(project.name);
    expect(inspector.get('.creation-meta-badge.is-session').text()).toBe(linkedSession.name);
    expect(inspector.get('.creation-meta-path').attributes('title')).toBe(rootDir);
    await button(inspector, t('creation.inspector.landRead')).trigger('click');
    await button(inspector, t('creation.galaxy.openSession')).trigger('click');
    expect(wrapper.emitted('open-creation')).toEqual(['read', 'studio'].map(mode => [{ agentId: alpha.id, creationId: atlas.id, mode }]));
  });

  it('keeps the Cosmos drawer chat interactive in split Workbench and returns to Galaxy', async () => {
    const { default: CosmosConversationDrawer } = await import('../../web/components/cosmos/CosmosConversationDrawer.js');
    chat.currentView = 'yeaft';
    chat.yeaftActiveSessionFilter = linkedSession.id;
    chat.workbenchRouteProtocolSupported = true;
    const wrapper = render(CosmosConversationDrawer, { props: {
      agent: alpha, planetId: 'earth', widened: true, viewportWidth: 1024,
    }, stubs: { MessageList: true, ChatInput: true },
      // Exercise the fallback label; the current English dictionary calls it “Star Map”.
      translate: key => key === 'creation.interior.ascend' ? key : t(key),
    });
    const panel = wrapper.get('.cosmos-drawer-body');
    const conversation = wrapper.get('.cosmos-drawer-chat');
    expect(panel.classes()).not.toContain('is-workbench-split');
    expect(wrapper.find('.cosmos-back-galaxy-btn').exists()).toBe(false);
    chat.workbenchExpanded = true;
    await wrapper.setProps({ openedFromGalaxy: true });
    expect(panel.classes()).toContain('is-workbench-split');
    expect(conversation.attributes('inert')).toBeUndefined();
    expect(conversation.attributes('aria-hidden')).toBeUndefined();
    expect(wrapper.get('.cosmos-workbench-host').isVisible()).toBe(true);
    await wrapper.setProps({ viewportWidth: 1023 });
    expect(panel.classes()).not.toContain('is-workbench-split');
    expect(conversation.attributes('inert')).toBeDefined();
    await wrapper.setProps({ viewportWidth: 1280, widened: false });
    expect(panel.classes()).not.toContain('is-workbench-split');
    chat.workbenchMaximized = true;
    await wrapper.setProps({ widened: true });
    expect(panel.classes()).not.toContain('is-workbench-split');
    expect(conversation.attributes('aria-hidden')).toBe('true');
    const back = wrapper.get('.cosmos-back-galaxy-btn');
    expect(back.text()).toBe('Back to Galaxy');
    expect(back.get('svg').attributes('aria-hidden')).toBe('true');
    await back.trigger('click');
    expect(wrapper.emitted('return-galaxy')).toEqual([[]]);
  });

  it('lists distinct per-Agent Creations in the Classic sidebar and opens the real create modal', async () => {
    const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ version: '1.0.0' }) }));
    const wrapper = render(YeaftSidebar, { stubs: { Teleport: true } });
    await flushPromises();
    const section = wrapper.get('.sidebar-creations');
    expect(section.get('.sidebar-creations-count').text()).toBe('2');
    await section.get('.sidebar-creations-toggle').trigger('click');
    const rows = section.findAll('.sidebar-creations-item');
    expect(rows.map(row => row.get('.sidebar-creations-title').text()).sort()).toEqual(['Field Atlas', 'Night Film']);
    const agentByTitle = Object.fromEntries(rows.map(row => [row.get('.sidebar-creations-title').text(), row.get('.sidebar-creations-agent').text()]));
    expect(agentByTitle).toEqual({ 'Field Atlas': 'Alpha', 'Night Film': 'Beta Studio' });
    expect(wrapper.findComponent(CreationCreateModal).exists()).toBe(false);
    await section.get('.sidebar-creations-add-btn').trigger('click');
    const modal = wrapper.getComponent(CreationCreateModal);
    expect(modal.get('[role="dialog"]').isVisible()).toBe(true);
    expect(modal.get('#creation-create-agent').element.value).toBe(alpha.id);
  });
});
