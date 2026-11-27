// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { basename, join, resolve } from 'node:path';
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
// The native image worker is unrelated to Session CRUD and cannot load in happy-dom.
vi.mock('../../agent/yeaft/image-preview.js', () => ({ makeImagePreview: vi.fn() }));

import { parseMentions } from '../../agent/yeaft/sessions/pre-flow.js';
import { createCreationService } from '../../agent/yeaft/creations/service.js';
import { createCreationRelay } from '../../server/handlers/client-creation.js';

enableAutoUnmount(afterEach);
afterEach(() => vi.restoreAllMocks());

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

  it('defines every literal Creation UI translation in both locales and keeps responsive styles', () => {
    const components = [
      'cosmos/creations/CosmosGalaxyOverlay.js', 'workbench/CreationTab.js',
      'workbench/CreationCreateModal.js', 'workbench/FileCanvasView.js',
    ];
    const missing = [];
    for (const component of components) {
      const source = readFileSync(`web/components/${component}`, 'utf8');
      const keys = new Set([...source.matchAll(/(?:\$t|\btr)\(\s*(['"])([^'"]+)\1\s*[,)]/g)].map(match => match[2]));
      expect(keys.size, component).toBeGreaterThan(0);
      for (const key of keys) {
        for (const [locale, dictionary] of [['en', en], ['zh-CN', zhCN]]) {
          if (!Object.hasOwn(dictionary, key) || !dictionary[key]?.trim()) missing.push(`${component}: ${locale}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
    const cosmosCss = readFileSync('web/styles/cosmos/creations.css', 'utf8');
    const wbCss = readFileSync('web/styles/creation-workbench.css', 'utf8');
    expect(cosmosCss).toMatch(/\.creation-legacy-banner\s*\{/);
    expect(cosmosCss).toMatch(/\.creation-galaxy-overlay\s+\.creation-kind-pill\s*\{/);
    expect(cosmosCss).not.toMatch(/(^|\n)\s*\.creation-kind-pill\b/);
    expect(wbCss).toMatch(/\.creation-create-modal\s+\.creation-kind-pill\s*\{/);
    expect(readFileSync('web/styles/canvas.css', 'utf8')).toMatch(/@container canvas-pane\b/);
    expect(wbCss).toMatch(/@container creation-wb\b/);
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
    interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_create_session') return sessionAck(chatStore, request, 'create', { session: { id: 'session-new' } });
      if (request.type === 'yeaft_project_mutation') return projectAck(chatStore, request, { result: { id: 'project-new' } });
    });
    vi.spyOn(chatStore, 'createYeaftSession');
    vi.spyOn(chatStore, 'mutateProject');
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
    const [{ default: ctx }, { handleYeaftUpdateSession }, { createSession }, { sessionsRoot }] = await Promise.all([
      import('../../agent/context.js'), import('../../agent/yeaft/web-bridge.js'),
      import('../../agent/yeaft/sessions/session-store.js'), import('../../agent/yeaft/sessions/session-crud.js'),
    ]);
    createSession(sessionsRoot(tempDirA), { id: 'session-shared', roster: ['omni'] }).close();
    const agentSend = vi.fn(wire => chatStore.handleYeaftOutput({ ...JSON.parse(wire), agentId: 'agent-a' }));
    const fixture = {
      CONFIG: { yeaftDir: tempDirA }, ws: { readyState: WebSocket.OPEN, send: agentSend },
      outboundSendQueue: [], outboundSendQueueActive: false, outboundSendQueueBytes: 0, serverEncryptionRequired: false,
    };
    const previous = Object.fromEntries(Object.keys(fixture).map(key => [key, ctx[key]]));
    Object.assign(ctx, fixture);
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_update_session') {
        handleYeaftUpdateSession(request);
        return true;
      }
      if (request.type === 'yeaft_create_session') return sessionAck(chatStore, request, 'create', { session: { id: 'session-replacement' } });
    });
    let creation, rootDir;
    try {
      handleYeaftUpdateSession({ requestId: 'flat-update', sessionId: 'session-shared', workDir: tempDirA });
      await flushPromises();
      expect(agentSend.mock.calls.map(([wire]) => JSON.parse(wire).event)).toContainEqual(expect.objectContaining({
        type: 'session_crud_result', op: 'update', requestId: 'flat-update', ok: false,
        error: expect.objectContaining({ code: 'invalid_patch' }),
      }));
      vi.spyOn(chatStore, 'sessionCrudRequest');
      vi.spyOn(chatStore, 'createYeaftSession');
      ({ creation, rootDir } = await creationsStore.createWorkspaceCreation({
        agentId: 'agent-a', title: 'Existing Atlas', sessionMode: 'existing', existingSessionId: 'session-shared',
      }));
      expect(creation.sessionId).toBe('session-shared');
      expect(chatStore.sessionCrudRequest).toHaveBeenCalledExactlyOnceWith(
        'update', { sessionId: 'session-shared', patch: { workDir: rootDir } }, { agentId: 'agent-a' },
      );
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'yeaft_update_session', agentId: 'agent-a', sessionId: 'session-shared', patch: { workDir: rootDir },
      }));
      expect(agentSend.mock.calls.map(([wire]) => JSON.parse(wire).event)).toContainEqual(expect.objectContaining({
        type: 'session_crud_result', op: 'update', ok: true, session: expect.objectContaining({ id: 'session-shared', workDir: rootDir }),
      }));
      expect(sessions.sessionById('session-shared', 'agent-a').workDir).toBe(rootDir);
      expect(chatStore.createYeaftSession).not.toHaveBeenCalled();
    } finally {
      await flushPromises();
      Object.assign(ctx, previous);
    }

    const stale = await creationsStore.updateCreation('agent-a', creation.id, { sessionId: 'unknown-session' });
    expect(await creationsStore.resolveCreationSession('agent-a', stale, { createIfMissing: false })).toMatchObject({ sessionId: null, rootDir });
    expect(chatStore.createYeaftSession).not.toHaveBeenCalled();
    expect(await creationsStore.resolveCreationSession('agent-a', stale)).toMatchObject({ sessionId: 'session-replacement', rootDir });
    expect(chatStore.createYeaftSession).toHaveBeenCalledExactlyOnceWith({
      agentId: 'agent-a', displayName: 'Existing Atlas', workDir: rootDir,
    });
    expect(await creationsStore.findByFolder('agent-a', rootDir)).toMatchObject({ id: creation.id, sessionId: 'session-replacement' });
  });

  it.each(['CreationCreateModal', 'CosmosGalaxyOverlay'])('%s retries a partial creation without duplicating the Project or workspace', async launcher => {
    await registerBrowserStores();
    chatStore.agents = [{ id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] }];
    chatStore.currentAgent = 'agent-a';
    await creationsStore.selectGalaxyAgent('agent-a');
    let sessionAttempts = 0;
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_create_session') return sessionAck(chatStore, request, 'create',
        ++sessionAttempts === 1 ? { ok: false, error: { code: 'denied', message: 'Session denied' } }
          : { session: { id: 'resumed-session' } });
      if (request.type === 'yeaft_project_mutation') return projectAck(chatStore, request, { result: { id: 'resumed-project' } });
    });
    const create = vi.spyOn(creationsStore, 'createWorkspaceCreation');
    let wrapper, submit;
    if (launcher === 'CreationCreateModal') {
      const { default: Modal } = await import('../../web/components/workbench/CreationCreateModal.js');
      wrapper = render(Modal, { stubs: { Teleport: true } });
      await wrapper.get('#creation-create-title').setValue('Resumable Atlas');
      await wrapper.get('.creation-create-inline-toggle').trigger('click');
      await wrapper.get('input#creation-create-project').setValue('New Maps');
      submit = () => wrapper.get('form').trigger('submit');
    } else {
      const { default: Overlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
      wrapper = render(Overlay, { props: { visible: true, agents: chatStore.agents } });
      await flushPromises();
      Object.assign(creationsStore.igniteDraft, { open: true, title: 'Resumable Atlas' });
      await Vue.nextTick();
      await wrapper.get('.creation-ignite-selectors select:has(option[value="__new__"])').setValue('__new__');
      await wrapper.get('.creation-ignite-inline-input').setValue('New Maps');
      submit = () => wrapper.vm.submitIgnite();
    }
    await submit();
    await flushPromises();
    const failure = await create.mock.results[0].value.catch(error => error);
    expect(failure).toMatchObject({ message: 'Session denied', partialProjectId: 'resumed-project', partialCreation: { id: expect.any(String) } });
    expect(wrapper.text()).toContain('Session denied');
    expect(wrapper.emitted('created')).toBeUndefined();
    expect(wrapper.emitted('open-creation')).toBeUndefined();

    await submit();
    await flushPromises();
    const id = failure.partialCreation.id;
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ resumeProjectId: 'resumed-project', resumeCreationId: id }));
    expect(await create.mock.results[1].value).toMatchObject({ creation: { id }, sessionId: 'resumed-session', projectId: 'resumed-project' });
    const requests = send.mock.calls.map(([msg]) => msg);
    expect(requests.filter(msg => msg.type === 'yeaft_project_mutation').map(msg => msg.op)).toEqual(['create', 'move_session']);
    expect(requests.filter(msg => msg.type === 'creation_request' && msg.op === 'create_creation')).toHaveLength(1);
    expect(serviceA.store.listCreations().map(item => item.id)).toEqual([id]);
    expect(sessionAttempts).toBe(2);
    const completion = launcher === 'CreationCreateModal' ? wrapper.emitted('created') : wrapper.emitted('open-creation');
    expect(completion).toHaveLength(1);
    expect(completion[0][0]).toMatchObject({ agentId: 'agent-a', sessionId: 'resumed-session',
      ...(launcher === 'CreationCreateModal' ? { creation: { id } } : { creationId: id }),
    });
  });

  it('surfaces a denied Project move without persisting unconfirmed membership', async () => {
    await registerBrowserStores();
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_create_session') return sessionAck(chatStore, request, 'create', { session: { id: 'unassigned-session' } });
      if (request.type === 'yeaft_project_mutation') return projectAck(chatStore, request, {
        ok: false, error: { code: 'forbidden', message: 'Project move denied' },
      });
    });
    const result = await creationsStore.createWorkspaceCreation({
      agentId: 'agent-a', title: 'Unassigned Atlas', projectId: 'restricted-project',
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'yeaft_project_mutation', op: 'move_session', agentId: 'agent-a',
      sessionId: 'unassigned-session', projectId: 'restricted-project',
    }));
    expect(result).toMatchObject({ sessionId: 'unassigned-session', projectId: null, projectWarning: 'Project move denied' });
    expect(serviceA.store.getCreation(result.creation.id)).toMatchObject({ sessionId: 'unassigned-session', projectId: null });
    const writes = send.mock.calls.map(([request]) => request).filter(request =>
      request.type === 'creation_request' && ['create_creation', 'update_creation'].includes(request.op));
    expect(writes.map(request => request.op)).toEqual(['create_creation', 'update_creation']);
    expect(writes.every(request => request.payload.projectId == null)).toBe(true);
  });

  it('rejects a failed Session create with partialCreation and retries against the same workspace', async () => {
    await registerBrowserStores();
    let attempts = 0;
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_create_session') return sessionAck(chatStore, request, 'create',
        ++attempts === 1 ? { ok: false, error: { code: 'denied', message: 'Session denied' } }
          : { session: { id: 'resumed-session' } });
    });
    const payload = { agentId: 'agent-a', title: 'Resumable Atlas' };
    const failure = await creationsStore.createWorkspaceCreation(payload).catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: 'Session denied', partialCreation: { id: expect.any(String), rootDir: expect.any(String) } });
    const { id, rootDir } = failure.partialCreation;
    expect(serviceA.store.getCreation(id).sessionId).toBeFalsy();
    const result = await creationsStore.createWorkspaceCreation({ ...payload, resumeCreationId: id });
    expect(result).toMatchObject({ rootDir, sessionId: 'resumed-session', creation: { id } });
    expect(serviceA.store.getCreation(id).sessionId).toBe('resumed-session');
    expect(send.mock.calls.filter(([request]) => request.op === 'create_creation')).toHaveLength(1);
    expect(serviceA.store.listCreations().map(creation => creation.id)).toEqual([id]);
    expect(attempts).toBe(2);
  });

  it('deduplicates concurrent folder bindings and linked Session creation', async () => {
    await registerBrowserStores();
    const folder = join(tempDirA, 'concurrent');
    mkdirSync(folder);
    const bind = rootDir => creationsStore.bindFolderAsCreation({ agentId: 'agent-a', rootDir });
    const [first, second] = await Promise.all([bind(folder), bind(folder)]);
    expect(second.creation.id).toBe(first.creation.id);
    expect(chatStore.sendWsMessage.mock.calls.filter(([request]) => request.op === 'find_by_folder')).toHaveLength(1);
    expect(chatStore.sendWsMessage.mock.calls.filter(([request]) => request.op === 'create_creation')).toHaveLength(1);
    expect(serviceA.store.listCreations().map(creation => creation.id)).toEqual([first.creation.id]);

    const receipt = deferred();
    const send = interceptSocket(chatStore, request => {
      if (request.type !== 'yeaft_create_session') return;
      void receipt.promise.then(() => sessionAck(chatStore, request, 'create', { session: { id: 'single-session' } }));
      return true;
    });
    const resolveSession = () => creationsStore.resolveCreationSession('agent-a', first.creation);
    const results = Promise.all([resolveSession(), resolveSession()]);
    receipt.resolve();
    expect((await results).map(result => result.sessionId)).toEqual(['single-session', 'single-session']);
    expect(send.mock.calls.filter(([request]) => request.type === 'yeaft_create_session')).toHaveLength(1);
    expect(serviceA.store.getCreation(first.creation.id).sessionId).toBe('single-session');
  });

  it('awaits the real list and folder lookup, ignoring an unrelated ID-less Workbench reply', async () => {
    await registerBrowserStores();
    const { default: CreationTab } = await import('../../web/components/workbench/CreationTab.js');
    // Another browser can bind the folder after this browser has listed Creations.
    const lookup = deferred();
    const lookupStarted = deferred();
    const listingStarted = deferred();
    const send = mockWorkbenchFiles(chatStore, {}, {}, request => {
      if (request.type !== 'list_directory') return;
      listingStarted.resolve(request);
      return true;
    });
    const socket = interceptSocket(chatStore, request => {
      if (request.op !== 'find_by_folder') return;
      lookupStarted.resolve(request);
      void lookup.promise.then(() => send(request));
      return true;
    });
    const wrapper = render(CreationTab, { props: { ...routeProps, workDir: tempDirA } });
    expect(await lookupStarted.promise).toMatchObject({ agentId: route.agentId, payload: { rootDir: tempDirA } });
    expect(socket.mock.calls.map(([request]) => request.op)).toEqual(['list_creations', 'find_by_folder']);
    expect(creationsStore.byAgent[route.agentId]).toMatchObject({ loaded: true, list: [] });
    expect(wrapper.vm.activeRootDir).toBe('');
    expect(socket.mock.calls.some(([request]) => request.type === 'list_directory')).toBe(false);
    const linked = serviceA.store.createCreation({ title: 'Found asynchronously', rootDir: tempDirA });
    lookup.resolve();
    const listing = await listingStarted.promise;
    expect(wrapper.vm.activeCreation.id).toBe(linked.id);
    const unrelated = { ...listing };
    delete unrelated.requestId;
    fireWindowEvent('workbench-message', { ...unrelated, type: 'directory_listing', entries: [{ name: 'Unrelated.md', type: 'file' }] });
    await flushPromises();
    expect(wrapper.vm.scanning).toBe(true);
    expect(wrapper.vm.docFiles).toEqual([]);
    respondWorkbench(listing, { type: 'directory_listing', entries: [] });
    await flushPromises();
    expect(wrapper.vm.scanning).toBe(false);
    expect(wrapper.vm.docFiles).toEqual([]);
    expect(wrapper.text()).toContain('Found asynchronously');
  });

  it('does not activate an older ensureWorkspace result after a newer Creation target', async () => {
    await registerBrowserStores();
    const { default: CreationTab } = await import('../../web/components/workbench/CreationTab.js');
    const slow = serviceA.store.createCreation({ title: 'Slow legacy target' });
    const fast = serviceA.store.createCreation({ title: 'Newer target', initializeFolder: true });
    const send = mockWorkbenchFiles(chatStore);
    const ensure = deferred();
    const ensureStarted = deferred();
    interceptSocket(chatStore, request => {
      if (request.op !== 'ensure_workspace') return;
      ensureStarted.resolve(request);
      void ensure.promise.then(() => send(request));
      return true;
    });
    const wrapper = render(CreationTab, { props: { ...routeProps, workDir: '' } });
    await flushPromises();
    fireWindowEvent('workbench-creation-target', { routeKey, creationId: slow.id, seq: 1 });
    expect(await ensureStarted.promise).toMatchObject({ payload: { creationId: slow.id } });
    fireWindowEvent('workbench-creation-target', { routeKey, creationId: fast.id, seq: 2 });
    await flushPromises();
    expect(wrapper.vm.activeCreation.id).toBe(fast.id);
    ensure.resolve();
    await vi.waitFor(() => expect(creationsStore.creationsForAgent(route.agentId).find(c => c.id === slow.id).rootDir).toBeTruthy());
    await flushPromises();
    expect(wrapper.vm.activeCreation.id).toBe(fast.id);
    expect(wrapper.vm.activeRootDir).toBe(fast.rootDir);
    expect(send.mock.calls.filter(([request]) => request.type === 'list_directory').map(([request]) => request.dirPath))
      .toEqual([fast.rootDir]);
  });

  it('reads migrated legacy slides, gallery and video from the actual materialized workspace', async () => {
    await registerBrowserStores();
    const { default: CreationTab } = await import('../../web/components/workbench/CreationTab.js');
    installMarkdownParser();
    try {
      const db = serviceA.store;
      const { id } = db.createCreation({ title: 'Legacy reader' });
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
      const image = db.saveAsset(id, { ext: 'png', bytes: png });
      // MP4 was a legacy asset format; seed the original metadata and bytes, not a workspace file.
      const video = Buffer.from('Legacy video bytes');
      writeFileSync(join(db.root, id, 'assets', 'legacy-clip.mp4'), video);
      db.run('INSERT INTO creation_assets VALUES (?,?,?)', id, 'legacy-clip',
        JSON.stringify({ id: 'legacy-clip', ext: 'mp4', name: 'Legacy Clip.mp4' }));
      db.createNode(id, { title: 'Slides', type: 'unit', modality: 'slide_deck', content: { description: '[Gallery](./Gallery.md)', slides: [{ title: 'Launch', bullets: ['Legacy talking point'], imageAssetId: image.id }] } });
      db.createNode(id, { title: 'Gallery', type: 'unit', modality: 'image_gallery', content: { frames: [{ title: 'Cover frame', caption: 'Legacy caption', assetId: image.id }] } });
      db.createNode(id, { title: 'Episode', type: 'unit', modality: 'video_episode', content: { videoAssetId: 'legacy-clip', scenes: [{ title: 'Intro', durationSec: 5, narration: 'Legacy narration' }] } });
      expect(db.getCreation(id).rootDir).toBeFalsy();
      const workspace = await creationsStore.ensureWorkspace(route.agentId, id);
      expect(workspace).toMatchObject({ materialized: true, creation: { id } });
      const folder = workspace.rootDir;
      const imagePath = join(folder, 'images', `${image.id}.png`);
      const videoPath = join(folder, 'videos', 'Legacy Clip.mp4');
      const imageUrl = '/api/preview/migrated-cover?token=image-capability';
      const videoUrl = '/api/preview/migrated-video?token=video-capability';
      expect(readFileSync(imagePath)).toEqual(png);
      expect(readFileSync(join(folder, 'videos', 'Legacy Clip.mp4'))).toEqual(video);
      const send = mockWorkbenchFiles(chatStore, {}, {}, request => {
        if (request.type === 'list_directory') return { type: 'directory_listing', entries: readdirSync(request.dirPath, { withFileTypes: true }).map(entry => ({
          name: entry.name, path: join(request.dirPath, entry.name), type: entry.isDirectory() ? 'directory' : 'file',
        })) };
        if (request.type === 'read_file' && request.filePath === imagePath) {
          expect(readFileSync(request.filePath)).toEqual(png);
          return { type: 'file_content', binary: true, mimeType: 'image/png', previewUrl: imageUrl };
        }
        if (request.type === 'video_metadata' && request.filePath === videoPath) {
          return { type: 'video_metadata', videoStream: true, previewUrl: videoUrl };
        }
        if (request.type === 'read_file') return { type: 'file_content', content: readFileSync(request.filePath, 'utf8') };
      });
      const wrapper = render(CreationTab, { props: { ...routeProps, workDir: folder } });
      await flushPromises();
      expect(wrapper.vm.activeCreation.id).toBe(id);
      const tabs = wrapper.findAll('.creation-wb-tab');
      expect(tabs.map(tab => tab.get('.creation-wb-tab-count').text())).toEqual(['4', '1', '1']);
      for (const [name, heading, body] of [
        ['Slides', 'Slide 1: Launch', 'Legacy talking point'],
        ['Gallery', 'Cover frame', 'Legacy caption'],
        ['Episode', 'Scene 1: Intro', 'Legacy narration'],
      ]) {
        await wrapper.get(`.creation-wb-tree-row[title="docs/${name}.md"]`).trigger('click');
        await flushPromises();
        expect(wrapper.get('.file-canvas-view').findAll('h2').map(el => el.text())).toContain(heading);
        expect(wrapper.get('.file-canvas-view').text()).toContain(body);
      }
      await wrapper.get('.creation-wb-tree-row[title="docs/Slides.md"]').trigger('click');
      await flushPromises();
      const docCanvas = () => wrapper.get('.creation-wb-doc-canvas .file-canvas-view');
      expect(readFileSync(join(folder, 'docs', 'Slides.md'), 'utf8')).toContain(`../images/${image.id}.png`);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'read_file', filePath: imagePath, creationId: id }));
      expect(docCanvas().find('img[src^="../images/"]').exists()).toBe(false);
      await docCanvas().get('.canvas-doc-content [data-workspace-src]').trigger('click');
      await flushPromises();
      expect(tabs[1].attributes('aria-selected')).toBe('true');
      expect(wrapper.get('.canvas-kind-image img').attributes('data-canvas-path')).toBe(imagePath);
      await tabs[0].trigger('click');
      await docCanvas().get('a[data-workspace-href$="/Gallery.md"]').trigger('click');
      await flushPromises();
      expect(docCanvas().get('h1').text()).toBe('Gallery');

      await wrapper.get('.creation-wb-tree-row[title="docs/Episode.md"]').trigger('click');
      await flushPromises();
      expect(readFileSync(join(folder, 'docs', 'Episode.md'), 'utf8')).toContain('../videos/');
      const episodeLink = docCanvas().get('a[data-workspace-href]');
      expect(episodeLink.attributes()).toMatchObject({ href: '#', 'data-workspace-href': videoPath });
      await episodeLink.trigger('click');
      await flushPromises();
      expect(tabs[2].attributes('aria-selected')).toBe('true');
      const player = wrapper.get('.canvas-kind-video video');
      expect(player.attributes('data-canvas-path')).toBe(videoPath);
      expect(new URL(player.attributes('src'), location.origin).href).toBe(new URL(videoUrl, location.origin).href);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'video_metadata', filePath: videoPath, creationId: id }));

      await tabs[0].trigger('click');
      await wrapper.get('.creation-wb-tree-row[title="docs/Slides.md"]').trigger('click');
      await flushPromises();
      const embedded = docCanvas().get('.canvas-doc-content img');
      expect(new URL(embedded.attributes('src'), location.origin).href).toBe(new URL(imageUrl, location.origin).href);
      expect(embedded.attributes('data-workspace-src')).toBe(imagePath);
    } finally {
      vi.unstubAllGlobals();
    }
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

  it.each([['acceptance', true], ['rejection', false]])('keeps the new Agent Ignite error and selectors after stale %s', async (_outcome, ok) => {
    const { sessions } = await registerBrowserStores();
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const agents = [
      { id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] },
      { id: 'agent-b', name: 'Beta', online: true, capabilities: ['creations'] },
    ];
    chatStore.agents = agents;
    const sessionStarted = deferred();
    const receipt = deferred();
    interceptSocket(chatStore, request => {
      if (request.type !== 'yeaft_create_session') return;
      sessionStarted.resolve(request);
      void receipt.promise.then(() => sessionAck(chatStore, request, 'create', ok
        ? { session: { id: 'old-agent-session' } }
        : { ok: false, error: { code: 'denied', message: 'Alpha Session denied' } }));
      return true;
    });
    sessions.applySnapshotUpsert({ id: 'beta-session', name: 'Beta Session' }, 'agent-b');
    await creationsStore.selectGalaxyAgent('agent-a');
    const wrapper = render(CosmosGalaxyOverlay, { props: { visible: true, agents } });
    Object.assign(creationsStore.igniteDraft, { title: 'Alpha draft', open: true });
    const submit = wrapper.vm.submitIgnite();
    expect(await sessionStarted.promise).toMatchObject({ agentId: 'agent-a' });
    expect(creationsStore.igniteDraft.submitting).toBe(true);
    await creationsStore.selectGalaxyAgent('agent-b');
    await Vue.nextTick();
    expect(creationsStore.igniteDraft.submitting).toBe(false);
    creationsStore.igniteDraft.error = 'Beta validation error';
    const [, project, sessionMode] = wrapper.findAll('.creation-ignite-selectors label select');
    await project.setValue('__new__');
    await wrapper.get('.creation-ignite-inline-input').setValue('Beta project name');
    await sessionMode.setValue('existing');
    await wrapper.get('.is-session-picker').setValue('beta-session');
    receipt.resolve();
    await submit;
    await flushPromises();
    expect(wrapper.get('.creation-ignite-error').text()).toBe('Beta validation error');
    expect(project.element.value).toBe('__new__');
    expect(wrapper.get('.creation-ignite-inline-input').element.value).toBe('Beta project name');
    expect(sessionMode.element.value).toBe('existing');
    expect(wrapper.get('.is-session-picker').element.value).toBe('beta-session');
    expect(wrapper.emitted('open-creation')).toBeUndefined();
  });

  it.each(['leave Galaxy and return', 'close the drawer'])('fences a pending Galaxy Creation open when users %s', async action => {
    await registerBrowserStores();
    const { default: CosmosPage } = await import('../../web/components/cosmos/CosmosPage.js');
    chatStore.agents = [{ id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] }];
    const ready = serviceA.store.createCreation({ title: 'Open now', initializeFolder: true });
    const slow = serviceA.store.createCreation({ title: 'Open slowly', initializeFolder: true });
    await creationsStore.selectGalaxyAgent('agent-a');
    const requested = deferred();
    const receipt = deferred();
    interceptSocket(chatStore, request => {
      if (request.type !== 'yeaft_create_session') return;
      requested.resolve(request);
      void receipt.promise.then(() => sessionAck(chatStore, request, 'create', { session: { id: 'late-session' } }));
      return true;
    });
    // Keep real page navigation and watchers, without mounting the WebGL renderer in happy-dom.
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const wrapper = render(CosmosPage, { stubs: {
      CosmosQuickComposer: true, CosmosConversationDrawer: true, CosmosGalaxyOverlay: true,
      SettingsPanel: true, AgentSettingsPanel: true, SessionSettingsModal: true,
    } });
    wrapper.vm.currentBand = 'galaxy'; // Input normally delivered by the particle engine's onBandChange.
    await Vue.nextTick();
    expect(wrapper.vm.projectedAgentList.map(agent => agent.id)).toContain('agent-a');
    if (action === 'close the drawer') {
      await wrapper.vm.openGalaxyCreation({ agentId: 'agent-a', creationId: ready.id, sessionId: 'ready-session', rootDir: ready.rootDir });
      expect(wrapper.vm.drawerOpen).toBe(true);
    }
    const open = wrapper.vm.openGalaxyCreation({ agentId: 'agent-a', creationId: slow.id });
    expect(await requested.promise).toMatchObject({ agentId: 'agent-a', payload: { workDir: slow.rootDir } });
    if (action === 'close the drawer') {
      wrapper.vm.closeDrawer();
    } else {
      wrapper.vm.currentBand = 'solar';
      await Vue.nextTick();
      wrapper.vm.currentBand = 'galaxy';
    }
    await Vue.nextTick();
    expect(wrapper.vm.drawerOpen).toBe(false);
    expect(creationsStore.pendingWorkbenchTarget).toBeNull();
    receipt.resolve();
    await open;
    await flushPromises();
    expect(serviceA.store.getCreation(slow.id).sessionId).toBe('late-session');
    expect(wrapper.vm.drawerOpen).toBe(false);
    expect(wrapper.vm.drawerOpenedFromGalaxy).toBe(false);
    expect(creationsStore.pendingWorkbenchTarget).toBeNull();
    expect(chatStore.workbenchMaximized).toBe(false);
  });

  it('leaves the Workbench collapsed when Cosmos opens a Creation target that Workbench refuses', async () => {
    const { sessions } = await registerBrowserStores();
    const { default: CosmosPage } = await import('../../web/components/cosmos/CosmosPage.js');
    const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
    const creation = serviceA.store.createCreation({ title: 'Unavailable Creation', initializeFolder: true });
    await creationsStore.selectGalaxyAgent('agent-a');
    chatStore.agents = [{ id: 'agent-a', name: 'Alpha', online: true, capabilities: ['file_editor', 'workbench_session_routes'] }];
    chatStore.workbenchRouteProtocolSupported = true;
    sessions.applySnapshotUpsert({ id: 'ready-session', name: 'Ready', workDir: creation.rootDir }, 'agent-a');
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const open = vi.spyOn(chatStore, 'openWorkbench');
    const wrapper = render(CosmosPage, { stubs: {
      CosmosQuickComposer: true, CosmosGalaxyOverlay: true, SettingsPanel: true,
      AgentSettingsPanel: true, SessionSettingsModal: true, MessageList: true, ChatInput: true,
    } });
    wrapper.vm.currentBand = 'galaxy';
    await Vue.nextTick();
    await wrapper.vm.openGalaxyCreation({ agentId: 'agent-a', creationId: creation.id,
      sessionId: 'ready-session', rootDir: creation.rootDir, mode: 'read' });
    await flushPromises();
    expect(wrapper.vm.drawerOpen).toBe(true);
    expect(creationsStore.pendingWorkbenchTarget).toMatchObject({ creationId: creation.id, maximize: true });
    const panel = wrapper.getComponent(WorkbenchPanel);
    expect(panel.get('[data-workbench-capability="creation"]').classes()).toContain('unavailable');
    expect(panel.classes()).not.toContain('expanded');
    expect(open).not.toHaveBeenCalled();
    expect(wrapper.vm.workbenchWidened).toBe(false);
    expect(chatStore.workbenchExpanded).toBe(false);
    expect(chatStore.workbenchMaximized).toBe(false);
  });

  it.each([
    ['Agent switch', 'success'], ['unmount', 'success'], ['unmount', 'failure'],
  ])('fences all Ignite %s completion effects on late %s', async (transition, outcome) => {
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    await creationsStore.selectGalaxyAgent('agent-a', { force: true });
    const reply = deferred();
    const submit = vi.spyOn(creationsStore, 'createWorkspaceCreation').mockImplementation(async () => {
      await reply.promise;
      if (outcome === 'failure') throw new Error('Stale failure');
      return { creation: { id: 'cre-a-new' }, projectWarning: 'Stale warning' };
    });
    const wrapper = render(CosmosGalaxyOverlay, { props: {
      visible: true,
      agents: ['agent-a', 'agent-b'].map(id => ({ id, online: true, capabilities: ['creations'] })),
    } });
    await flushPromises();

    const fileA = new File(['hello'], 'notes-a.txt');
    const fileB = new File(['world'], 'notes-b.txt');
    const draft = creationsStore.igniteDraft;
    Object.assign(draft, { title: 'Draft A', prompt: 'Prompt A', open: true, pendingFiles: [fileA] });
    await Vue.nextTick();
    const completion = wrapper.vm.submitIgnite();
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: 'agent-a', rawFiles: [fileA] }));
    expect(draft.submitting).toBe(true);
    if (transition === 'unmount') wrapper.unmount();
    else creationsStore.selectedAgentId = 'agent-b';
    await Vue.nextTick();
    // Keep the submitted file as well as the newer one: a stale completion owns neither.
    Object.assign(draft, { title: 'Draft B', prompt: 'Prompt B', pendingFiles: [fileA, fileB],
      error: 'New draft status', submitting: true });
    const current = { ...draft };
    reply.resolve();
    await completion;
    await flushPromises();
    expect(draft).toEqual(current);
    expect(draft.pendingFiles).toBe(current.pendingFiles);
    expect(draft.pendingFiles).toEqual([fileA, fileB]);
    expect(wrapper.emitted('open-creation')).toBeUndefined();
    expect(wrapper.emitted('toast')).toBeUndefined();
  });

});

const t = key => en[key] || key;
const route = { runtimeProvider: 'yeaft', agentId: 'agent-a', sessionId: 'session-a' };
const rootDir = '/workspace/atlas';
const routeKey = 'yeaft:agent-a:session-a';
const routeProps = { ...route, routeKey, workDir: rootDir, conversationId: `_workbench:${routeKey}`, workspaceGeneration: 'atlas-generation' };
const hostileHtml = '<script>alert(1)</script><img src="./cover.png" onerror="alert(2)"><a href="javascript:alert(3)">Unsafe link</a>';

function interceptSocket(chat, handle) {
  const send = chat.sendWsMessage.bind(chat);
  return (chat.sendWsMessage = vi.fn(request => handle(request) ?? send(request)));
}

function sessionAck(chat, request, op, fields) {
  queueMicrotask(() => chat.handleYeaftOutput({
    type: 'yeaft_output', agentId: request.agentId,
    event: { type: 'session_crud_result', requestId: request.requestId, op, ok: true, ...fields },
  }));
  return true;
}

function projectAck(chat, request, fields) {
  queueMicrotask(() => chat.handleYeaftOutput({
    type: 'yeaft_output', agentId: request.agentId,
    event: { type: 'project_mutation_result', projectsAuthoritative: true,
      requestId: request.requestId, op: request.op, ok: true, ...fields },
  }));
  return true;
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

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
  return { chat: useChatStore(), sessions: useSessionsStore(), auth: useAuthStore() };
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

  it('neutralizes mentions in each Canvas reference field without changing user mention routing', () => {
    for (const ref of [
      { kind: 'image', filePath: '/atlas/cover @bot.png' },
      { kind: 'image', fileName: 'cover @bot.png' },
      { kind: 'video', filePath: '/atlas/trailer.mp4', timestampLabel: '01:05 @bot' },
      { kind: 'doc', filePath: '/atlas/intro.md', snippet: 'First line\r\n@bot second line' },
    ]) {
      const prefix = context.formatCanvasContextPrefix([ref]);
      expect(prefix).toContain('@\u200Bbot');
      expect(parseMentions(prefix)).toEqual([]);
      expect(parseMentions(`${prefix}\n\nPlease review this @alice`)).toEqual(['alice']);
    }
  });

  it.each([['png', 'img', 'load'], ['mp4', 'video', 'loadeddata']])(
    'correlates late %s media events with the emitting DOM node, not the current file',
    async (ext, tag, loadEvent) => {
      const file = Vue.reactive({ name: `old.${ext}`, path: `/atlas/old.${ext}`, blobUrl: '/api/preview/old' });
      const wrapper = render(FileCanvasView, { props: { routeKey, file } });
      const media = wrapper.get(tag);
      const old = { path: file.path, url: file.blobUrl };
      expect(media.attributes()).toMatchObject({ 'data-canvas-path': old.path, 'data-canvas-url': old.url });
      // The input changes before Vue patches the DOM node whose resource finished loading.
      Object.assign(file, { name: `new.${ext}`, path: `/atlas/new.${ext}`, blobUrl: '/api/preview/new' });
      const loaded = media.trigger(loadEvent);
      const failed = media.trigger('error');
      await Promise.all([loaded, failed]);
      expect(wrapper.emitted('media-load')).toEqual([[old]]);
      expect(wrapper.emitted('media-error')).toEqual([[old]]);
      expect(wrapper.get(tag).attributes('data-canvas-path')).toBe(file.path);
    },
  );

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
    expect(reader.find('img').exists()).toBe(false);
    const unresolved = reader.get('button.canvas-rel-media-link');
    expect(unresolved.attributes('data-workspace-href')).toBe('/atlas/cover.png');
    await unresolved.trigger('click');
    expect(wrapper.emitted('open-relative-link')).toEqual([[{ targetPath: '/atlas/cover.png', rawHref: '/atlas/cover.png', kind: 'image' }]]);
    const resolveMediaUrl = vi.fn(path => path === '/atlas/cover.png' ? '/api/preview/atlas-cover?token=fixture' : '');
    await wrapper.setProps({ resolveMediaUrl });
    expect(resolveMediaUrl).toHaveBeenCalledWith('/atlas/cover.png');
    expect(reader.get('img').attributes()).toMatchObject({
      src: '/api/preview/atlas-cover?token=fixture', 'data-workspace-src': '/atlas/cover.png',
    });
    expect(reader.find('img[src="./cover.png"]').exists()).toBe(false);
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

  it.each([
    ['disabled (Quick Composer)', { enableCanvasRefs: false }, []],
    ['explicit empty (unbound Split Pane)', { canvasRouteKey: '' }, []],
    ['explicit route (Split Pane)', { canvasRouteKey: otherRoute }, ['local.png']],
  ])('does not inherit active Session refs with Canvas refs %s', async (_mode, props, names) => {
    const ChatInput = await configureComposerRoute();
    context.addCanvasContextRef(routeKey, { kind: 'image', filePath: '/atlas/global.png' });
    context.addCanvasContextRef(otherRoute, { kind: 'image', filePath: '/other/local.png' });
    const sendFn = vi.fn(() => true);
    const wrapper = render(ChatInput, { props: { ...props, sendFn } });
    expect(wrapper.findAll('.canvas-chip-name').map(chip => chip.text())).toEqual(names);
    await wrapper.get('textarea').setValue('Send');
    await wrapper.get('button.send-btn').trigger('click');
    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(sendFn.mock.calls[0][0]).not.toContain('global.png');
    if (names.length) expect(sendFn.mock.calls[0][0]).toContain('local.png');
    else expect(sendFn.mock.calls[0][0]).toBe('Send');
    expect(context.getCanvasContextRefs(routeKey)).toHaveLength(1);
  });

  it('clears only the send snapshot on the original route, even after navigation', async () => {
    const ChatInput = await configureComposerRoute();
    const original = context.addCanvasContextRef(routeKey, { kind: 'doc', filePath: '/atlas/first.md', snippet: '@vp is quoted' });
    const other = context.addCanvasContextRef(otherRoute, { kind: 'image', filePath: '/other/local.png' });
    const acknowledgment = deferred();
    const sendFn = vi.fn(() => acknowledgment.promise);
    const wrapper = render(ChatInput, { props: { canvasRouteKey: routeKey, sendFn } });
    await wrapper.get('button.send-btn').trigger('click');
    const prefix = context.formatCanvasContextPrefix([original]);
    expect(prefix).toContain('> @\u200Bvp is quoted');
    expect(prefix).not.toContain('@vp');
    expect(sendFn).toHaveBeenCalledExactlyOnceWith(prefix, undefined);
    const late = context.addCanvasContextRef(routeKey, { kind: 'doc', filePath: '/atlas/later.md' });
    await wrapper.setProps({ canvasRouteKey: otherRoute });
    expect(wrapper.get('.canvas-chip-name').text()).toBe('local.png');
    expect(context.getCanvasContextRefs(routeKey)).toEqual([original, late]);
    acknowledgment.resolve(true);
    await flushPromises();
    expect(context.getCanvasContextRefs(routeKey)).toEqual([late]);
    expect(context.getCanvasContextRefs(otherRoute)).toEqual([other]);
  });

  it('clears all route refs through the Canvas API, Creations clearAll, and auth reset', async () => {
    const { auth } = await registerBrowserStores();
    const { useCreationsStore } = await import('../../web/stores/creations.js');
    const creations = useCreationsStore();
    const seed = () => {
      for (const key of [routeKey, otherRoute]) {
        context.addCanvasContextRef(key, { kind: 'image', filePath: '/atlas/cover.png' });
        expect(context.getCanvasContextRefs(key)).toHaveLength(1);
      }
    };
    const expectEmpty = () => {
      for (const key of [routeKey, otherRoute]) expect(context.getCanvasContextRefs(key)).toEqual([]);
    };
    seed();
    context.clearAllCanvasContextRefs();
    expectEmpty();
    seed();
    creations.clearAll();
    expectEmpty();
    seed();
    // The reset must clear refs directly even if Creations has not registered.
    const registered = Pinia.useCreationsStore;
    delete Pinia.useCreationsStore;
    try {
      auth.reset();
      expectEmpty();
    } finally {
      if (registered) Pinia.useCreationsStore = registered;
    }
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

async function configureComposerRoute() {
  const { chat } = await registerBrowserStores();
  Object.assign(chat, { currentView: 'yeaft', connectionState: 'connected', authenticated: true,
    currentAgent: route.agentId, yeaftActiveSessionFilter: route.sessionId });
  expect(chat.activeSessionRoute).toEqual(route);
  return (await import('../../web/components/ChatInput.js')).default;
}

// Simulate only the Workbench transport. Keep the real route metadata and request IDs
// so file navigation, response correlation, and component lifecycle all run normally.
function respondWorkbench(request, response) {
  queueMicrotask(() => fireWindowEvent('workbench-message', { ...request, ...response }));
  return true;
}

function mockWorkbenchFiles(chat, listings = {}, contents = {}, reply = () => undefined) {
  return interceptSocket(chat, request => {
    if (['restore_file_tabs', 'update_file_tabs'].includes(request.type)) return true;
    let response = reply(request);
    if (response === true) return true; // Response is held by the fixture.
    if (response) return respondWorkbench(request, response);
    if (request.type === 'list_directory') {
      response = { type: 'directory_listing', entries: (listings[request.dirPath] || []).map(entry => ({ ...entry })) };
    } else if (request.type === 'read_file') {
      response = Object.hasOwn(contents, request.filePath)
        ? { type: 'file_content', content: contents[request.filePath] }
        : { type: 'file_content', error: 'Fixture has no preview' };
    } else if (request.type === 'write_file') {
      contents[request.filePath] = request.content;
      response = { type: 'file_saved', success: true };
    }
    if (response) return respondWorkbench(request, response);
  });
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
    }, { [`${rootDir}/atlas.md`]: `# Atlas\n\n${hostileHtml}`, [`${rootDir}/build.js`]: 'const edition = 1;' });
    const wrapper = render(FilesTab, { props: routeProps });
    await flushPromises();
    await wrapper.get('[data-tree-path$="/atlas.md"]').trigger('click');
    await flushPromises();
    const canvas = () => wrapper.get('.file-action-canvas');
    const preview = () => button(wrapper, t('files.preview'), '.file-content-actions button');
    const edit = () => button(wrapper, t('files.edit'), '.file-content-actions button');
    expect(canvas().text()).toBe(`✦ ${t('files.canvas')}`);
    await preview().trigger('click');
    const markdown = wrapper.get('.md-file-preview');
    expect(markdown.get('h1').text()).toBe('Atlas');
    expect(markdown.get('img').attributes('src')).toBe('./cover.png');
    expect(markdown.get('a').text()).toBe('Unsafe link');
    expect(markdown.html()).not.toMatch(/<script|onerror|javascript:/i);
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
    expect(wrapper.get('textarea').element.value).toBe(`# Atlas\n\n${hostileHtml}`);

    await wrapper.get('[data-tree-path$="/build.js"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('.file-editor-container textarea').element?.value).toBe('const edition = 1;'));
    expect(wrapper.find('.file-action-canvas').exists()).toBe(false);
    const open = vi.fn();
    window.addEventListener('workbench-open-creation', open);
    try {
      await wrapper.get('[data-tree-path$="/docs"]').trigger('contextmenu');
      const openItem = button(wrapper, `✦ ${t('files.openFolderInCreation')}`, '.ctx-menu .ctx-menu-item');
      expect(openItem.attributes('role')).toBe('menuitem');
      expect(openItem.attributes('tabindex')).toBe('0');
      await openItem.trigger('keydown.enter');
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0].detail).toMatchObject({ routeKey, rootDir: `${rootDir}/docs` });
      // Capability gating: hide root and context-menu Creation actions when agent lacks 'creations'
      chat.agents = [{ id: route.agentId, name: 'No Creations', online: true, capabilities: ['file_editor'] }];
      chat.currentAgentInfo = chat.agents[0];
      await Vue.nextTick();
      expect(wrapper.find(`[aria-label="${t('files.openFolderInCreation')}"]`).exists()).toBe(false);
      await wrapper.get('[data-tree-path$="/docs"]').trigger('contextmenu');
      expect(wrapper.findAll('.ctx-menu .ctx-menu-item').some(el => el.text().includes(t('files.openFolderInCreation')))).toBe(false);
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

  it('refuses a Creation open request when the Agent does not offer that capability', async () => {
    const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
    chat.agents[0].capabilities = ['file_editor', 'workbench_session_routes'];
    const wrapper = render(WorkbenchPanel, { props: { ownerRoute: route, ownerWorkDir: rootDir } });
    const detail = { routeKey, rootDir, maximize: true };
    expect(chat.workbenchMaximized).toBe(false);
    fireWindowEvent('workbench-open-creation', detail);
    await Vue.nextTick();
    expect(detail.accepted).toBeUndefined();
    expect(chat.workbenchMaximized).toBe(false);
    expect(wrapper.findComponent(CreationTab).exists()).toBe(false);
  });

  it('dispatches the route-scoped Creation dirty check and respects a canceled Workbench close', async () => {
    const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
    const readme = `${rootDir}/README.md`;
    creations.byAgent[route.agentId].list = [{ id: 'dirty', rootDir, sessionId: route.sessionId }];
    mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, { [readme]: '# On disk' });
    const wrapper = render(WorkbenchPanel, { props: { ownerRoute: route, ownerWorkDir: rootDir } });
    fireWindowEvent('workbench-open-creation', { routeKey, rootDir, creationId: 'dirty' });
    await flushPromises();
    const tab = wrapper.getComponent(CreationTab);
    const canvas = tab.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('# Do not lose this');
    const check = vi.fn();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    window.addEventListener('creation-check-dirty', check);
    try {
      expect(await wrapper.vm.closeCapability('creation')).toBe(false);
      expect(check).toHaveBeenCalledTimes(1);
      expect(check.mock.calls[0][0].detail).toEqual({ routeKey, workspaceGeneration: tab.props('workspaceGeneration'),
        dirtyCount: 1, dirtyFiles: ['README.md'] });
      expect(confirm).toHaveBeenCalledExactlyOnceWith(t('files.unsavedConfirm'));
      expect(wrapper.getComponent(CreationTab).get('textarea').element.value).toBe('# Do not lose this');
      confirm.mockReturnValue(true);
      expect(await wrapper.vm.closeCapability('creation')).toBe(true);
      await Vue.nextTick();
      expect(wrapper.findComponent(CreationTab).exists()).toBe(false);
    } finally {
      window.removeEventListener('creation-check-dirty', check);
    }
  });

  it('delivers the prompt from the Workbench Creation modal created event to the linked Session', async () => {
    const { default: CreationCreateModal } = await import('../../web/components/workbench/CreationCreateModal.js');
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: route.sessionId, name: 'Atlas', workDir: rootDir }, route.agentId);
    const send = mockWorkbenchFiles(chat, {}, {}, request => request.type === 'yeaft_session_send' ? true : undefined);
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    wrapper.getComponent(CreationCreateModal).vm.$emit('created', {
      agentId: route.agentId, sessionId: route.sessionId, creation: { id: 'new-atlas', rootDir },
      rootDir, prompt: '  Start planning the atlas  ',
    });
    await flushPromises();
    expect(wrapper.vm.activeCreation.id).toBe('new-atlas');
    expect(send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'yeaft_session_send')).toEqual([
      expect.objectContaining({ agentId: route.agentId, sessionId: route.sessionId, text: 'Start planning the atlas' }),
    ]);
  });

  it('does not let a slow current-folder bind replace a newer explicit Creation selection', async () => {
    const chosen = { id: 'selected', title: 'Newer selection', rootDir: `${rootDir}/selected` };
    creations.byAgent[route.agentId].list = [chosen];
    const pending = deferred();
    const bind = vi.spyOn(creations, 'bindFolderAsCreation').mockReturnValue(pending.promise);
    const send = mockWorkbenchFiles(chat);
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    const onboarding = wrapper.get('.creation-wb-onboarding');
    await onboarding.findAll('.creation-wb-action-card')[1].trigger('click');
    expect(bind).toHaveBeenCalledExactlyOnceWith({ agentId: route.agentId, sessionId: route.sessionId, rootDir });
    await onboarding.get('.creation-wb-existing-card').trigger('click');
    await flushPromises();
    expect(wrapper.vm.activeCreation.id).toBe(chosen.id);
    pending.resolve({ creation: { id: 'stale-bind', rootDir } });
    await flushPromises();
    expect(wrapper.vm.activeCreation.id).toBe(chosen.id);
    expect(send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'list_directory')).toEqual([
      expect.objectContaining({ dirPath: chosen.rootDir, creationId: chosen.id }),
    ]);
  });

  it('immediately reloads a selected video when only its mtime changes on rescan', async () => {
    const path = `${rootDir}/intro.mp4`;
    const entry = { name: 'intro.mp4', type: 'file', size: 42, mtimeMs: 1000 };
    creations.byAgent[route.agentId].list = [{ id: 'video-refresh', rootDir, sessionId: route.sessionId }];
    const send = mockWorkbenchFiles(chat, { [rootDir]: [entry] }, {}, request => {
      if (request.type === 'video_metadata') return { type: 'video_metadata', videoStream: true, previewUrl: `/api/preview/intro-${entry.mtimeMs}` };
    });
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    await wrapper.findAll('.creation-wb-tab')[2].trigger('click');
    await wrapper.get('.creation-wb-video-card').trigger('click');
    await flushPromises();
    const requests = () => send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'video_metadata');
    const video = () => wrapper.get('video');
    expect(requests()).toHaveLength(1);
    expect(video().attributes('src')).toBe(new URL('/api/preview/intro-1000', location.origin).href);
    const rescan = async () => {
      await wrapper.get(`[aria-label="${t('creation.workbench.refresh')}"]`).trigger('click');
      await flushPromises();
    };
    await rescan();
    expect(requests()).toHaveLength(1);
    entry.mtimeMs = 2000;
    await rescan();
    expect(requests()).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({ filePath: path, creationId: 'video-refresh' })));
    expect(video().attributes()).toMatchObject({ src: new URL('/api/preview/intro-2000', location.origin).href, 'data-canvas-path': path });
    expect(wrapper.find('.canvas-media-loading-overlay').exists()).toBe(false);
  });

  it('renders SVG in the gallery and Canvas without an SVG ObjectURL, and rejects unsafe image/video URLs', async () => {
    const { default: SvgPreview } = await import('../../web/components/files/SvgPreview.js');
    const objectUrl = vi.spyOn(URL, 'createObjectURL');
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    const jsUrl = 'javascript:alert(1)';
    const external = 'https://evil.test/api/preview/external';
    creations.byAgent[route.agentId].list = [{ id: 'media', rootDir, sessionId: route.sessionId }];
    mockWorkbenchFiles(chat, {
      [rootDir]: ['diagram.svg', 'unsafe.png', 'unsafe.mp4'].map(name => ({ name, type: 'file' })),
    }, { [`${rootDir}/diagram.svg`]: svg }, request => {
      if (request.type === 'read_file' && request.filePath.endsWith('/unsafe.png')) {
        return { type: 'file_content', binary: true, mimeType: 'image/png', previewUrl: jsUrl };
      }
      if (request.type === 'video_metadata') return { type: 'video_metadata', videoStream: true, previewUrl: external };
    });
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    const tabs = wrapper.findAll('.creation-wb-tab');
    await tabs[1].trigger('click');
    await flushPromises();
    const cards = wrapper.findAll('.creation-wb-image-card');
    expect(cards[0].getComponent(SvgPreview).props('content')).toBe(svg);
    expect(cards[0].element.tagName).toBe('BUTTON');
    expect(cards[0].element.querySelectorAll('button')).toHaveLength(0);
    expect(cards[1].find('img').exists()).toBe(false);
    await cards[0].trigger('click');
    expect(wrapper.getComponent(FileCanvasView).getComponent(SvgPreview).props('content')).toBe(svg);
    await cards[1].trigger('click');
    await flushPromises();
    const canvas = wrapper.getComponent(FileCanvasView);
    expect(canvas.get('[role="alert"]').text()).toBe(t('creation.workbench.previewUnavailable'));
    expect(canvas.find('img').exists()).toBe(false);
    await tabs[2].trigger('click');
    await wrapper.get('.creation-wb-video-card').trigger('click');
    await flushPromises();
    const videoCanvas = wrapper.getComponent('.canvas-kind-video');
    expect(videoCanvas.get('[role="alert"]').text()).toBe(t('files.videoStreamUnavailable'));
    expect(wrapper.find('video').exists()).toBe(false);
    expect(wrapper.html()).not.toContain(external);
    expect(wrapper.html()).not.toContain(jsUrl);
    expect(objectUrl.mock.calls.map(([blob]) => blob.type)).not.toContain('image/svg+xml');
  });

  it('keeps independent dirty drafts when switching documents and a partial refresh cannot list one', async () => {
    const first = `${rootDir}/docs/First.md`;
    const second = `${rootDir}/README.md`;
    let failSubdir = false;
    creations.byAgent[route.agentId].list = [{ id: 'drafts', rootDir, sessionId: route.sessionId }];
    const send = mockWorkbenchFiles(chat, {
      [rootDir]: [{ name: 'docs', type: 'directory' }, { name: 'README.md', type: 'file' }],
      [`${rootDir}/docs`]: [{ name: 'First.md', type: 'file' }],
    }, { [first]: '# First on disk', [second]: '# Readme on disk' }, request => {
      if (failSubdir && request.type === 'list_directory' && request.dirPath === `${rootDir}/docs`) {
        return { type: 'directory_listing', error: 'Permission denied' };
      }
    });
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    const edit = async text => {
      const canvas = wrapper.getComponent(FileCanvasView);
      if (!canvas.find('textarea').exists()) await button(canvas, t('creation.canvas.edit')).trigger('click');
      await canvas.get('textarea').setValue(text);
    };
    const select = async path => {
      await wrapper.get(`.creation-wb-tree-row[title="${path}"]`).trigger('click');
      await flushPromises();
    };
    await edit('# Readme draft');
    await select('docs/First.md');
    await edit('# First draft');
    await select('README.md');
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: second, content: '# Readme draft', isDirty: true });
    await select('docs/First.md');
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: first, content: '# First draft', isDirty: true });
    expect([...wrapper.vm.docDrafts.keys()].sort()).toEqual([`${rootDir}::${second}`, `${rootDir}::${first}`].sort());
    await select('README.md');
    failSubdir = true;
    await wrapper.get(`[aria-label="${t('creation.workbench.refresh')}"]`).trigger('click');
    await flushPromises();
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: second, content: '# Readme draft', isDirty: true });
    await select('docs/First.md');
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: first, content: '# First draft', isDirty: true });
    expect(wrapper.vm.docDrafts.get(`${rootDir}::${second}`).content).toBe('# Readme draft');
    expect(send.mock.calls.filter(([request]) => request.type === 'read_file').map(([request]) => request.filePath)).toEqual([second, first]);
  });

  it('keeps failed saves dirty and compares a delayed save acknowledgment against its submitted text', async () => {
    const path = `${rootDir}/README.md`;
    const writes = [];
    creations.byAgent[route.agentId].list = [{ id: 'save', rootDir, sessionId: route.sessionId }];
    mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, { [path]: '# On disk' }, request => {
      if (request.type !== 'write_file') return;
      writes.push(request);
      return true;
    });
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    const canvas = wrapper.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('# Submitted');
    const save = () => canvas.get('.canvas-save-btn').trigger('click');
    await save();
    expect(writes[0]).toMatchObject({ filePath: path, content: '# Submitted' });
    respondWorkbench(writes[0], { type: 'file_saved', success: false, error: 'Disk full' });
    await flushPromises();
    expect(wrapper.text()).toContain('Disk full');
    expect(wrapper.vm.activeDocFile).toMatchObject({ isDirty: true, savedContent: '# On disk', saving: false });
    await save();
    expect(writes[1]).toMatchObject({ filePath: path, content: '# Submitted' });
    expect(wrapper.vm.activeDocFile.saving).toBe(true);
    await canvas.get('textarea').setValue('# Typed while saving');
    respondWorkbench(writes[1], { type: 'file_saved', success: true });
    await flushPromises();
    expect(wrapper.vm.activeDocFile).toMatchObject({
      content: '# Typed while saving', savedContent: '# Submitted', isDirty: true, saving: false,
    });
    expect(canvas.get('.canvas-save-btn').element.disabled).toBe(false);
  });

  it.each([
    ['cover.png', 'img.canvas-image-el', 'load', 'media-load'],
    ['cover.png', 'img.canvas-image-el', 'error', 'media-error'],
    ['clip.mp4', 'video.canvas-video-el', 'loadedmetadata', 'media-load'],
    ['clip.mp4', 'video.canvas-video-el', 'error', 'media-error'],
  ])('mounts %s (%s) while loading and propagates %s to Files', async (name, selector, event, emitted) => {
    const { default: FilesTab } = await import('../../web/components/FilesTab.js');
    const isVideo = name.endsWith('.mp4');
    const path = `${rootDir}/${name}`;
    const previewUrl = `/api/preview/${name}?token=fixture`;
    mockWorkbenchFiles(chat, { [rootDir]: [{ name, type: 'file' }] }, {}, request => {
      if (request.type === 'read_file' && request.filePath === path) {
        return { type: 'file_content', binary: true, mimeType: 'image/png', previewUrl };
      }
      if (request.type === 'video_metadata' && request.filePath === path) {
        return { type: 'video_metadata', videoStream: true, mimeType: 'video/mp4', previewUrl };
      }
    });
    const wrapper = render(FilesTab, { props: routeProps });
    await flushPromises();
    await wrapper.get(`[data-tree-path="${path}"]`).trigger('click');
    await flushPromises();
    await wrapper.get('.file-action-canvas').trigger('click');
    const canvas = wrapper.getComponent(FileCanvasView);
    const file = canvas.props('file');
    expect(file).toMatchObject({ path, previewLoading: true });
    expect(canvas.find('.canvas-media-loading-overlay').exists()).toBe(true);
    const media = canvas.get(selector);
    const url = new URL(previewUrl, location.href).href;
    expect(media.attributes('src')).toBe(url);
    await media.trigger(event);
    expect(canvas.emitted(emitted)).toEqual([[{ path, url }]]);
    expect(file.previewLoading).toBe(false);
    expect(file.previewError).toBe(event === 'error'
      ? t(isVideo ? 'files.videoPreviewLoadFailed' : 'files.previewLoadFailed') : null);
    expect(canvas.find('.canvas-media-loading-overlay').exists()).toBe(false);
  });

  it('invalidates cached CodeMirror state when Canvas edits a Files text buffer', async () => {
    const [{ default: FilesTab }, { updateFileText }] = await Promise.all([
      import('../../web/components/FilesTab.js'), import('../../web/components/files/fileEditor.js'),
    ]);
    const path = `${rootDir}/README.md`;
    mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, { [path]: '# Original' });
    const wrapper = render(FilesTab, { props: routeProps });
    await flushPromises();
    await wrapper.get(`[data-tree-path="${path}"]`).trigger('click');
    await flushPromises();
    await wrapper.get('.file-action-canvas').trigger('click');
    const canvas = wrapper.getComponent(FileCanvasView);
    const file = canvas.props('file');
    file.cmState = { cached: 'old CodeMirror document' };
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('# Updated in Canvas');
    expect(file).toMatchObject({ content: '# Updated in Canvas', isDirty: true, cmState: null });
    // Test the shared helper too: FilesTab's defensive invalidation must not hide a regression here.
    const buffer = { content: '# Original', originalContent: '# Original', cmState: { cached: true } };
    updateFileText(buffer, '# Edited');
    expect(buffer).toMatchObject({ content: '# Edited', isDirty: true, cmState: null });
  });

  it.each([
    [1, 'image', 'png', '.creation-wb-image-card'],
    [2, 'video', 'mp4', '.creation-wb-video-card'],
  ])('keeps the selection in tab %s (%s) by path after a rescan prepends a file', async (tab, kind, ext, card) => {
    const initial = `Z-selected.${ext}`;
    const added = `A-prepended.${ext}`;
    const files = [{ name: initial, type: 'file' }];
    creations.byAgent[route.agentId].list = [{ id: 'rescan', rootDir, sessionId: route.sessionId }];
    mockWorkbenchFiles(chat, { [rootDir]: files }, {}, request => {
      const previewUrl = `/api/preview/${basename(request.filePath || 'unused')}?token=fixture`;
      if (request.type === 'read_file') return { type: 'file_content', binary: true, mimeType: 'image/png', previewUrl };
      if (request.type === 'video_metadata') return { type: 'video_metadata', videoStream: true, previewUrl };
    });
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    await wrapper.findAll('.creation-wb-tab')[tab].trigger('click');
    await flushPromises();
    await wrapper.get(card).trigger('click');
    await flushPromises();
    const selection = () => wrapper.getComponent(FileCanvasView).props('file');
    expect(selection()).toMatchObject({ path: `${rootDir}/${initial}`, fileType: kind });
    files.unshift({ name: added, type: 'file' });
    await wrapper.get(`[aria-label="${t('creation.workbench.refresh')}"]`).trigger('click');
    await flushPromises();
    const filesAfterScan = kind === 'image' ? wrapper.vm.imageFiles : wrapper.vm.videoFiles;
    expect(filesAfterScan.map(item => item.path)).toEqual([`${rootDir}/${added}`, `${rootDir}/${initial}`]);
    expect(wrapper.get('.creation-wb-media-counter').text()).toBe('2 / 2');
    expect(selection()).toMatchObject({ path: `${rootDir}/${initial}`, fileType: kind });
  });

  it('onboards an unbound folder, scans its nested files into modality tabs, saves a document and opens Files', async () => {
    const existing = { id: 'other', title: 'Other Creation', rootDir: '/workspace/other' };
    const creation = { id: 'atlas', title: 'Atlas Creation', rootDir, sessionId: route.sessionId };
    creations.byAgent[route.agentId].list = [existing];
    vi.spyOn(creations, 'bindFolderAsCreation');
    const chapter = `${rootDir}/chapters/part-1/opening.md`;
    const send = mockWorkbenchFiles(chat, {
      [rootDir]: [{ name: 'README.md', type: 'file' }, { name: 'chapters', type: 'directory' }, { name: 'cover.png', type: 'file' }, { name: 'intro.mp4', type: 'file' }, { name: 'build.js', type: 'file' }],
      [`${rootDir}/chapters`]: [{ name: 'part-1', type: 'directory' }],
      [`${rootDir}/chapters/part-1`]: [{ name: 'opening.md', type: 'file' }],
    }, { [`${rootDir}/README.md`]: '# Atlas overview', [chapter]: '# Opening chapter' }, request => {
      if (request.type === 'create_file') return { type: 'file_op_result', operation: 'create', success: true };
      if (request.type === 'video_metadata') return { type: 'video_metadata', videoStream: true, previewUrl: '/api/preview/intro' };
    });
    interceptSocket(chat, request => {
      if (request.type !== 'creation_request') return;
      let data;
      if (request.op === 'find_by_folder') data = { creation: null };
      else if (request.op === 'create_creation') data = { creation, nodes: [], sources: [] };
      else return;
      queueMicrotask(() => creations.handleCreationResponse({
        type: 'creation_response', agentId: request.agentId, requestId: request.requestId, op: request.op, ok: true, data,
      }));
      return true;
    });
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
    expect(creations.creationsForAgent(route.agentId)).toContainEqual(creation);
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
    await wrapper.get('.creation-wb-video-card').trigger('click');
    await flushPromises();
    expect(wrapper.get('video').attributes('data-canvas-path')).toBe(`${rootDir}/intro.mp4`);
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
    await wrapper.get(`[aria-label="${t('creation.workbench.addMenu')}"]`).trigger('click');
    await button(wrapper, t('creation.workbench.newDoc'), '[role="menuitem"]').trigger('click');
    await wrapper.get('.creation-wb-mini-input').setValue('notes.md');
    await wrapper.get('.creation-wb-mini-input').trigger('keydown.enter');
    await flushPromises();
    const types = ['list_directory', 'read_file', 'write_file', 'create_file', 'video_metadata'];
    const calls = send.mock.calls.map(([msg]) => msg).filter(msg => types.includes(msg.type));
    expect(new Set(calls.map(msg => msg.type))).toEqual(new Set(types));
    for (const msg of calls) expect(msg, msg.type).toMatchObject({ creationId: creation.id, workbenchRoute: route });
    expect(calls).toContainEqual(expect.objectContaining({ type: 'create_file', filePath: `${rootDir}/notes.md`, isDirectory: false }));
    const openFiles = vi.fn();
    const openDir = vi.fn();
    window.addEventListener('workbench-open-capability', openFiles);
    window.addEventListener('workbench-files-open-dir', openDir);
    try {
      await wrapper.get(`.creation-wb-header-actions button[title="${t('creation.workbench.openInFiles')}"]`).trigger('click');
      expect(openFiles.mock.calls[0][0].detail).toEqual({ routeKey, capabilityId: 'files' });
      expect(openDir.mock.calls[0][0].detail).toEqual({ routeKey, agentId: route.agentId, dirPath: rootDir, workspaceGeneration: routeProps.workspaceGeneration });
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

  it('highlights a sidebar Creation only when both Agent and Session match', async () => {
    const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ version: '1.0.0' }) }));
    creations.byAgent[alpha.id].list.push({ ...atlas, id: 'other-session', title: 'Different Session', sessionId: 'other' });
    creations.byAgent[beta.id].list = [{ ...film, sessionId: linkedSession.id }];
    chat.currentView = 'yeaft';
    chat.yeaftActiveSessionFilter = linkedSession.id;
    chat.yeaftAgentId = alpha.id;
    const wrapper = render(YeaftSidebar, { stubs: { Teleport: true } });
    await flushPromises();
    await wrapper.get('.sidebar-creations-toggle').trigger('click');
    const rows = () => Object.fromEntries(wrapper.findAll('.sidebar-creations-item').map(row => [
      row.get('.sidebar-creations-title').text(), row.classes().includes('active'),
    ]));
    expect(rows()).toEqual({ 'Field Atlas': true, 'Night Film': false, 'Different Session': false });
    chat.yeaftAgentId = beta.id;
    chat.currentAgent = beta.id;
    await Vue.nextTick();
    expect(rows()).toEqual({ 'Field Atlas': false, 'Night Film': true, 'Different Session': false });
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
