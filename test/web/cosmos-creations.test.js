// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { basename, join, resolve } from 'node:path';
import * as Vue from 'vue';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import { workbenchWorkspaceGeneration } from '../../web/utils/workbench-route.js';

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
  const actionListeners = new Set();
  store.$onAction = listener => {
    actionListeners.add(listener);
    return () => actionListeners.delete(listener);
  };
  for (const [k, fn] of Object.entries(def.actions || {})) {
    store[k] = (...args) => {
      const callbacks = [];
      for (const listener of actionListeners) listener({ name: k, args, after: cb => callbacks.push(cb) });
      const complete = result => {
        for (const cb of callbacks) cb(result);
        return result;
      };
      const result = fn.apply(store, args);
      if (!callbacks.length) return result;
      return result instanceof Promise ? result.then(complete) : complete(result);
    };
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
import { getLocale } from '../../web/utils/i18n.js';
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

  it('colors Galaxy selects without resetting the caret image and reserves a right gutter', () => {
    const css = readFileSync('web/styles/cosmos/creations.css', 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, selectors]) => selectors.split(',').some(selector => selector.trim() === '.creation-glass-select'))
      .map(([, , declarations]) => declarations).join('\n');
    expect(rules).toMatch(/background-color\s*:\s*var\(--creation-glass-bg-strong\)/);
    expect(rules).not.toMatch(/(?:^|[;\n])\s*background\s*:/);
    expect(rules).toMatch(/background-image\s*:/);
    const [, rightPadding] = rules.match(/padding\s*:\s*0\s+(\d+)px\s+0\s+/) || [];
    expect(Number(rightPadding)).toBeGreaterThanOrEqual(24);
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
  let externalDir;
  let serviceA;
  let serviceB;
  let relay;
  let uploads;
  let creationsStore;
  let chatStore;

  beforeEach(async () => {
    tempDirA = mkdtempSync(join(tmpdir(), 'yeaft-creations-web-a-'));
    tempDirB = mkdtempSync(join(tmpdir(), 'yeaft-creations-web-b-'));
    externalDir = null;
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

    uploads = new Map();
    relay = createCreationRelay({
      agentMap, uploads, now: () => Date.now(),
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
    if (externalDir) rmSync(externalDir, { recursive: true, force: true });
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
      if (request.type === 'yeaft_list_sessions') return sessionAck(chatStore, request, 'list', { sessions: [{ id: 'session-shared' }] });
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

    chatStore.connectionState = 'connected';
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

  it('R2-F5a: adopts committed Project and Session inventory after losing each create ACK', async () => {
    const { sessions } = await registerBrowserStores();
    const { default: CreationCreateModal } = await import('../../web/components/workbench/CreationCreateModal.js');
    const agentId = route.agentId;
    chatStore.currentAgent = agentId;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations'] }];
    const oldProject = { id: 'old-project', name: 'Maps' };
    const oldSession = { id: 'old-session', name: 'Other Session', agentId };
    const project = { id: 'committed-project', name: 'Maps' };
    const projects = [oldProject];
    const inventory = [oldSession];
    chatStore.sessionProjects = projects.slice();
    sessions.applySnapshotUpsert(oldSession, agentId);
    const list = vi.spyOn(chatStore, 'sessionCrudRequest').mockImplementation(async (op, _data, opts) => {
      expect(op).toBe('list');
      expect(opts.agentId).toBe(agentId);
      return { ok: true, projects: projects.slice(), sessions: inventory.slice() };
    });
    const mutate = vi.spyOn(chatStore, 'mutateProject').mockImplementation(async op => {
      if (op !== 'create') return { ok: true };
      projects.push(project);
      throw new Error('Project ACK lost');
    });
    const createSession = vi.spyOn(chatStore, 'createYeaftSession').mockImplementation(async ({ displayName, workDir }) => {
      inventory.push({ id: 'committed-session', name: displayName, workDir, agentId });
      throw new Error('Session ACK lost');
    });
    const modal = render(CreationCreateModal, { stubs: { Teleport: true } });
    await modal.get('#creation-create-title').setValue('Atlas');
    await modal.get('.creation-create-inline-toggle').trigger('click');
    await modal.get('input#creation-create-project').setValue('Maps');
    const submit = async () => {
      await modal.get('form').trigger('submit');
      await flushPromises();
    };
    await submit();
    expect(modal.get('[role="alert"]').text()).toBe('Project ACK lost');
    expect(createSession).not.toHaveBeenCalled();
    await submit();
    expect(modal.get('[role="alert"]').text()).toBe('Session ACK lost');
    const [partial] = serviceA.store.listCreations();
    expect(modal.emitted('created')).toBeUndefined();
    await submit();
    expect(modal.find('[role="alert"]').exists() ? modal.get('[role="alert"]').text() : null).toBeNull();
    expect(modal.emitted('created')).toEqual([[expect.objectContaining({ sessionId: 'committed-session', projectId: project.id,
      creation: expect.objectContaining({ id: partial.id }), rootDir: partial.rootDir })]]);
    expect(mutate.mock.calls).toEqual([
      ['create', { name: project.name }, agentId],
      ['move_session', { sessionId: 'committed-session', projectId: project.id }, agentId],
    ]);
    expect(createSession).toHaveBeenCalledExactlyOnceWith({ agentId, displayName: 'Atlas', workDir: partial.rootDir });
    expect(list).toHaveBeenCalled();
    expect(serviceA.store.getCreation(partial.id)).toMatchObject({ projectId: project.id, sessionId: 'committed-session' });
    expect(serviceA.store.listCreations()).toHaveLength(1);
  });

  it('R2-F5b: keeps Ignite attempt identity and committed checkpoints when the overlay unmounts mid-flight', async () => {
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: 'existing-session', name: 'Existing Session' }, route.agentId);
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    chatStore.currentAgent = route.agentId;
    chatStore.agents = [{ id: route.agentId, online: true, capabilities: ['creations'] }];
    await creationsStore.selectGalaxyAgent(route.agentId);
    const linkStarted = deferred();
    let heldLink = false;
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_create_session') return sessionAck(chatStore, request, 'create', { session: { id: 'saved-session' } });
      if (request.type === 'yeaft_project_mutation') return projectAck(chatStore, request, { result: { id: 'saved-project' } });
      if (request.op === 'update_creation' && !heldLink) {
        heldLink = true;
        linkStarted.resolve(request);
        return true;
      }
    });
    const workspace = vi.spyOn(creationsStore, 'createWorkspaceCreation');
    const mountGalaxy = () => render(CosmosGalaxyOverlay, { props: { visible: true, agents: chatStore.agents } });
    const first = mountGalaxy();
    await flushPromises();
    Object.assign(creationsStore.igniteDraft, { open: true, title: 'Resumable Ignite' });
    await Vue.nextTick();
    await first.get('.creation-ignite-selectors select:has(option[value="__new__"])').setValue('__new__');
    await first.get('.creation-ignite-inline-input').setValue('Saved Maps');
    const completion = first.vm.submitIgnite();
    const link = await linkStarted.promise;
    const { attemptKey } = creationsStore.igniteDraft.resume;
    expect(attemptKey).toEqual(expect.any(String));
    expect(attemptKey).not.toBe('');
    const [partial] = serviceA.store.listCreations();
    expect(creationsStore.igniteDraft.submitting).toBe(true);
    first.unmount();
    expect(creationsStore.igniteDraft).toMatchObject({ submitting: false, resume: { attemptKey } });
    creationsStore.handleCreationResponse({ ...link, type: 'creation_response', ok: false, error: 'Link interrupted' });
    await completion;
    const checkpoints = { attemptKey, projectId: 'saved-project', sessionId: 'saved-session', creationId: partial.id,
      projectAttempted: true, sessionAttempted: true };
    expect(creationsStore.igniteDraft.resume).toMatchObject(checkpoints);
    expect(first.emitted('open-creation')).toBeUndefined();
    const second = mountGalaxy();
    await flushPromises();
    expect(creationsStore.igniteDraft.resume).toMatchObject(checkpoints);
    await second.vm.submitIgnite();
    expect(workspace).toHaveBeenLastCalledWith(expect.objectContaining({ attemptKey,
      resumeProjectId: 'saved-project', resumeSessionId: 'saved-session', resumeCreationId: partial.id }));
    expect(second.emitted('open-creation')).toEqual([[expect.objectContaining({ creationId: partial.id, sessionId: 'saved-session' })]]);
    const requests = send.mock.calls.map(([msg]) => msg);
    expect(requests.filter(msg => msg.op === 'create_creation')).toHaveLength(1);
    expect(requests.filter(msg => msg.type === 'yeaft_project_mutation' && msg.op === 'create')).toHaveLength(1);
    expect(requests.filter(msg => msg.type === 'yeaft_create_session')).toHaveLength(1);
  });

  it('R2-F6: persists a revised title and kind when retrying a failed final link without recreating resources', async () => {
    await registerBrowserStores();
    const { default: CreationCreateModal } = await import('../../web/components/workbench/CreationCreateModal.js');
    chatStore.currentAgent = route.agentId;
    chatStore.agents = [{ id: route.agentId, online: true, capabilities: ['creations'] }];
    let linkAttempts = 0;
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_create_session') return sessionAck(chatStore, request, 'create', { session: { id: 'saved-session' } });
      if (request.type === 'yeaft_project_mutation') return projectAck(chatStore, request, { result: { id: 'saved-project' } });
      if (request.op !== 'update_creation' || ++linkAttempts !== 1) return;
      queueMicrotask(() => creationsStore.handleCreationResponse({
        ...request, type: 'creation_response', ok: false, error: 'Final link failed',
      }));
      return true;
    });
    const submit = vi.spyOn(creationsStore, 'createWorkspaceCreation');
    const modal = render(CreationCreateModal, { stubs: { Teleport: true }, attachTo: document.body });
    const title = modal.get('#creation-create-title');
    await title.setValue('Initial title');
    await modal.get('.creation-create-inline-toggle').trigger('click');
    await modal.get('input#creation-create-project').setValue('Saved Maps');
    await modal.get('form').trigger('submit');
    await flushPromises();
    const [partial] = serviceA.store.listCreations();
    await expect(submit.mock.results[0].value).rejects.toMatchObject({
      partialProjectId: 'saved-project', partialSessionId: 'saved-session', partialCreation: { id: partial.id },
    });
    expect(modal.get('[role="alert"]').text()).toBe('Final link failed');
    expect(modal.emitted('close')).toBeUndefined();

    expect(serviceA.store.getCreation(partial.id)).toMatchObject({ title: 'Initial title', kind: 'book' });
    await title.setValue('Edited title');
    await modal.get('.creation-kind-pill:has(.is-deck)').trigger('click');
    modal.get('button[type="submit"]').element.click();
    await flushPromises();
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Edited title', kind: 'deck', resumeProjectId: 'saved-project', resumeSessionId: 'saved-session', resumeCreationId: partial.id,
    }));
    expect(modal.emitted('created')).toEqual([[expect.objectContaining({ sessionId: 'saved-session', projectId: 'saved-project' })]]);
    expect(serviceA.store.listCreations()).toEqual([expect.objectContaining({
      id: partial.id, sessionId: 'saved-session', projectId: 'saved-project',
    })]);
    expect(serviceA.store.getCreation(partial.id)).toMatchObject({ title: 'Edited title', kind: 'deck' });
    const messages = send.mock.calls.map(([request]) => request);
    expect(messages.filter(request => request.type === 'yeaft_create_session')).toHaveLength(1);
    expect(messages.filter(request => request.type === 'yeaft_project_mutation' && request.op === 'create')).toHaveLength(1);
    expect(messages.filter(request => request.op === 'create_creation')).toHaveLength(1);
    expect(linkAttempts).toBe(2);
  });

  it('R3-F1: reconciles committed Project and Session creates after dispatcher timeouts', async () => {
    const { sessions } = await registerBrowserStores();
    const { default: CreationCreateModal } = await import('../../web/components/workbench/CreationCreateModal.js');
    const { agentId } = route;
    chatStore.currentAgent = agentId;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations'] }];
    const projects = [];
    const inventory = [];
    const send = interceptSocket(chatStore, msg => {
      if (msg.type === 'yeaft_project_mutation') {
        if (msg.op === 'create') {
          projects.push({ id: 'committed-project', name: msg.name });
          return true; // Commit without ACK; do not publish a client snapshot.
        }
        return projectAck(chatStore, msg, { projects });
      }
      if (msg.type === 'yeaft_create_session') {
        inventory.push({ ...msg.payload, id: 'committed-session', agentId });
        return true;
      }
      if (msg.type === 'yeaft_list_sessions') {
        return sessionAck(chatStore, msg, 'list', { projects: projects.slice(), sessions: inventory.slice(), projectsAuthoritative: true });
      }
    });
    const mutate = vi.spyOn(chatStore, 'mutateProject');
    const crud = vi.spyOn(chatStore, 'sessionCrudRequest');
    const workspace = vi.spyOn(creationsStore, 'createWorkspaceCreation');
    const modal = render(CreationCreateModal, { stubs: { Teleport: true } });
    await modal.get('#creation-create-title').setValue('Atlas');
    await modal.get('.creation-create-inline-toggle').trigger('click');
    await modal.get('input#creation-create-project').setValue('Maps');
    const submit = () => modal.get('form').trigger('submit');
    const timeout = { ok: false, ambiguous: true, error: { code: 'timeout' } };
    vi.useFakeTimers();
    try {
      await submit();
      expect(projects).toEqual([{ id: 'committed-project', name: 'Maps' }]);
      expect(chatStore.sessionProjects).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(mutate.mock.results[0].value).resolves.toMatchObject(timeout);
      await expect(workspace.mock.results[0].value).rejects.toMatchObject({ projectAttempted: true, sessionAttempted: false });

      await submit();
      await flushPromises();
      expect(workspace).toHaveBeenLastCalledWith(expect.objectContaining({ projectAttempted: true }));
      const [partial] = serviceA.store.listCreations();
      expect(inventory).toEqual([expect.objectContaining({ id: 'committed-session', workDir: partial.rootDir })]);
      expect(sessions.sessionById('committed-session', agentId)).toBeFalsy();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(crud.mock.results[1].value).resolves.toMatchObject({ ...timeout, op: 'create' });
      await expect(workspace.mock.results[1].value).rejects.toMatchObject({ projectAttempted: true, sessionAttempted: true });

      await submit();
      await flushPromises();
      expect(workspace).toHaveBeenLastCalledWith(expect.objectContaining({ projectAttempted: true, sessionAttempted: true }));
      expect(crud.mock.calls.filter(([op]) => op === 'list')).toEqual([['list', {}, { agentId }], ['list', {}, { agentId }]]);
      await expect(crud.mock.results[0].value).resolves.toMatchObject({ ok: true, projects, sessions: [] });
      await expect(crud.mock.results[2].value).resolves.toMatchObject({ ok: true, projects, sessions: inventory });
      expect(send.mock.calls.filter(([msg]) => msg.type === 'yeaft_create_session')).toHaveLength(1);
      expect(send.mock.calls.filter(([msg]) => msg.type === 'yeaft_project_mutation' && msg.op === 'create')).toHaveLength(1);
      expect(modal.emitted('created')).toHaveLength(1);
      expect(serviceA.store.listCreations()).toEqual([expect.objectContaining({ id: partial.id,
        projectId: 'committed-project', sessionId: 'committed-session' })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R4-F1: ignores a same-title Session in another folder when retrying a timed-out create', async () => {
    await registerBrowserStores();
    const { agentId } = route;
    const options = { agentId, title: 'Atlas', attemptKey: 'workspace:retry-atlas' };
    const started = deferred();
    let creates = 0;
    const inventory = [];
    const send = interceptSocket(chatStore, msg => {
      if (msg.type === 'yeaft_create_session') {
        if (++creates === 1) {
          started.resolve();
          return true;
        }
        return sessionAck(chatStore, msg, 'create', { session: { id: 'fresh-session' } });
      }
      if (msg.type === 'yeaft_list_sessions') return sessionAck(chatStore, msg, 'list', { sessions: inventory });
    });
    vi.useFakeTimers();
    try {
      const first = creationsStore.createWorkspaceCreation(options).catch(error => error);
      await started.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      const failure = await first;
      expect(failure).toMatchObject({ message: expect.stringMatching(/timeout|timed out/i), sessionAttempted: true });
      const { id, rootDir } = failure.partialCreation;
      inventory.push({ id: 'other-atlas', agentId, displayName: 'Atlas', workDir: `${rootDir}-unrelated` });
      await expect(creationsStore.createWorkspaceCreation({
        ...options, resumeCreationId: id, sessionAttempted: true, baselineSessionIds: failure.baselineSessionIds,
      })).resolves.toMatchObject({ creation: { id, sessionId: 'fresh-session' } });
      const sessionCreates = send.mock.calls.filter(([msg]) => msg.type === 'yeaft_create_session');
      expect(sessionCreates).toHaveLength(2);
      expect(sessionCreates[1][0].payload.workDir).toBe(rootDir);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R3-F2: rejoins an in-flight Ignite after remount and checkpoints every completed phase', async () => {
    await registerBrowserStores();
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const { agentId } = route;
    chatStore.currentAgent = agentId;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations'] }];
    await creationsStore.selectGalaxyAgent(agentId);
    const hold = request => ['yeaft_project_mutation', 'yeaft_create_session'].includes(request.type)
      || request.op === 'create_creation';
    const send = interceptSocket(chatStore, request => hold(request) ? true : undefined);
    const requests = () => send.mock.calls.map(([msg]) => msg).filter(hold);
    const workspace = vi.spyOn(creationsStore, 'createCreationWithWorkspace');
    const mountGalaxy = () => render(CosmosGalaxyOverlay, {
      props: { visible: true, agents: chatStore.agents }, attachTo: document.body,
    });
    const first = mountGalaxy();
    await flushPromises();
    Object.assign(creationsStore.igniteDraft, { open: true, title: 'In-flight Atlas' });
    await Vue.nextTick();
    await first.get('.creation-ignite-selectors select:has(option[value="__new__"])').setValue('__new__');
    await first.get('.creation-ignite-inline-input').setValue('Maps');
    first.get('button[type="submit"]').element.click();
    await flushPromises();
    expect(requests()).toEqual([expect.objectContaining({ type: 'yeaft_project_mutation', op: 'create' })]);
    const { attemptKey } = creationsStore.igniteDraft.resume;
    expect(attemptKey).toBeTruthy();
    first.unmount();

    const second = mountGalaxy();
    await flushPromises();
    expect(creationsStore.igniteDraft).toMatchObject({ title: 'In-flight Atlas', submitting: false, resume: { attemptKey } });
    expect(second.get('button[type="submit"]').element.disabled).toBe(false);
    second.get('button[type="submit"]').element.click();
    await flushPromises();
    expect(workspace.mock.calls.map(([args]) => [args.agentId, args.attemptKey])).toEqual([[agentId, attemptKey], [agentId, attemptKey]]);
    expect(requests()).toHaveLength(1);
    expect(second.emitted('open-creation')).toBeUndefined();

    projectAck(chatStore, requests()[0], { result: { id: 'saved-project' } });
    await flushPromises();
    expect(requests()[1]).toMatchObject({ op: 'create_creation' });
    expect(creationsStore.igniteDraft.resume).toMatchObject({ attemptKey, projectId: 'saved-project', creationId: '', sessionId: '' });
    const create = requests()[1];
    const data = await serviceA.request({ op: create.op, payload: create.payload });
    creationsStore.handleCreationResponse({ ...create, type: 'creation_response', ok: true, data });
    await flushPromises();
    expect(requests()[2]).toMatchObject({ type: 'yeaft_create_session' });
    expect(creationsStore.igniteDraft.resume).toMatchObject({ creationId: data.creation.id, sessionId: '' });
    sessionAck(chatStore, requests()[2], 'create', { session: { id: 'saved-session' } });
    await flushPromises();
    expect(requests()[3]).toMatchObject({ type: 'yeaft_project_mutation', op: 'move_session' });
    expect(creationsStore.igniteDraft.resume).toMatchObject({ projectId: 'saved-project', creationId: data.creation.id, sessionId: 'saved-session' });
    projectAck(chatStore, requests()[3], {});
    await flushPromises();
    expect(requests()).toHaveLength(4);
    expect(first.emitted('open-creation')).toBeUndefined();
    expect(second.emitted('open-creation')).toEqual([[expect.objectContaining({ creationId: data.creation.id, sessionId: 'saved-session' })]]);
    expect(serviceA.store.listCreations()).toEqual([expect.objectContaining({ id: data.creation.id, sessionId: 'saved-session' })]);
  });

  it('R4-F2: saves a remounted Ignite’s title and kind but keeps its unsubmitted file and prompt', async () => {
    await registerBrowserStores();
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const { agentId } = route;
    chatStore.currentAgent = agentId;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations'] }];
    await creationsStore.selectGalaxyAgent(agentId);
    const project = deferred();
    const send = interceptSocket(chatStore, msg => {
      if (msg.type === 'yeaft_project_mutation') {
        if (msg.op === 'create') {
          project.resolve(msg);
          return true;
        }
        return projectAck(chatStore, msg, {});
      }
      if (msg.type === 'yeaft_create_session') return sessionAck(chatStore, msg, 'create', { session: { id: 'saved-session' } });
    });
    const upload = vi.spyOn(creationsStore, 'uploadRawFiles').mockResolvedValue([]);
    const workspace = vi.spyOn(creationsStore, 'createWorkspaceCreation');
    const mountGalaxy = () => render(CosmosGalaxyOverlay, { props: { visible: true, agents: chatStore.agents } });
    const file1 = new File(['original'], 'first.txt');
    const file2 = new File(['new'], 'second.txt');
    const draft = creationsStore.igniteDraft;
    const first = mountGalaxy();
    Object.assign(draft, { open: true, title: 'Original', prompt: 'Original prompt', pendingFiles: [file1] });
    await Vue.nextTick();
    await first.get('.creation-ignite-selectors select:has(option[value="__new__"])').setValue('__new__');
    await first.get('.creation-ignite-inline-input').setValue('Maps');
    const firstSubmit = first.vm.submitIgnite();
    const createProjectRequest = await project.promise;
    first.unmount();

    const second = mountGalaxy();
    await flushPromises();
    draft.pendingFiles.push(file2);
    await second.get('.creation-ignite-title-input').setValue('New title');
    await second.get('.creation-ignite-input').setValue('New prompt');
    draft.kind = 'deck';
    const secondSubmit = second.vm.submitIgnite();
    expect(workspace).toHaveBeenCalledTimes(2);
    expect(workspace.mock.calls[1][0]).toMatchObject({ attemptKey: workspace.mock.calls[0][0].attemptKey, rawFiles: [file1, file2] });
    projectAck(chatStore, createProjectRequest, { result: { id: 'saved-project' } });
    await Promise.all([firstSubmit, secondSubmit]);

    const snapshot = { title: 'Original', kind: 'book', prompt: 'Original prompt', files: [file1], celestial: null };
    for (const result of workspace.mock.results) await expect(result.value).resolves.toMatchObject({ _submittedSnapshot: snapshot });
    expect(upload).toHaveBeenCalledExactlyOnceWith([file1]);
    expect(send.mock.calls.filter(([msg]) => msg.op === 'create_creation')).toHaveLength(1);
    expect(serviceA.store.listCreations()).toEqual([expect.objectContaining({ title: 'New title', kind: 'deck' })]);
    expect(draft.pendingFiles).toEqual([file2]);
    expect(draft).toMatchObject({ open: true, title: '', prompt: 'New prompt', submitting: false });
    expect(second.emitted('toast')).toContainEqual([expect.stringMatching(/Unuploaded attachments|未上传的附件/)]);
    expect(second.emitted('open-creation')).toEqual([[expect.objectContaining({ promptToSend: 'Original prompt', keepIgniteDockOpen: true })]]);
    expect(first.emitted('open-creation')).toBeUndefined();
  });

  it('R5-F3: a retry after a timed-out Ignite rejoin does not consume unuploaded attachments', async () => {
    await registerBrowserStores();
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const { agentId } = route;
    chatStore.currentAgent = agentId;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations'] }];
    await creationsStore.selectGalaxyAgent(agentId);
    const session = deferred();
    const rejoin = deferred();
    const send = interceptSocket(chatStore, msg => {
      if (msg.type === 'yeaft_create_session') {
        session.resolve(msg);
        return true;
      }
      if (msg.op === 'update_creation' && msg.payload.patch.title === 'Revised' && !retried) {
        rejoin.resolve(msg);
        return true;
      }
    });
    let retried = false;
    const upload = vi.spyOn(creationsStore, 'uploadRawFiles').mockResolvedValue([]);
    const workspace = vi.spyOn(creationsStore, 'createCreationWithWorkspace');
    const mountGalaxy = () => render(CosmosGalaxyOverlay, { props: { visible: true, agents: chatStore.agents } });
    const file1 = new File(['sent'], 'first.txt');
    const file2 = new File(['unsent'], 'second.txt');
    const draft = creationsStore.igniteDraft;
    const first = mountGalaxy();
    Object.assign(draft, { open: true, title: 'Original', pendingFiles: [file1] });
    await Vue.nextTick();
    const firstSubmit = first.vm.submitIgnite();
    const sessionRequest = await session.promise;
    first.unmount();

    const second = mountGalaxy();
    await flushPromises();
    Object.assign(draft, { title: 'Revised', kind: 'deck', pendingFiles: [file1, file2] });
    const secondSubmit = second.vm.submitIgnite();
    vi.useFakeTimers();
    try {
      sessionAck(chatStore, sessionRequest, 'create', { session: { id: 'saved-session' } });
      const rejoinRequest = await rejoin.promise;
      await firstSubmit;
      expect(rejoinRequest.payload.patch).toMatchObject({ title: 'Revised', kind: 'deck' });
      const id = rejoinRequest.payload.creationId;
      expect(serviceA.store.getCreation(id)).toMatchObject({ title: 'Original', kind: 'book', sessionId: 'saved-session' });
      expect(draft.resume).toMatchObject({ creationId: id, sessionId: 'saved-session' });
      await expect(workspace.mock.results[0].value).resolves.toMatchObject({ _submittedSnapshot: { files: [file1] } });
      await vi.advanceTimersByTimeAsync(45_000);
      await secondSubmit;
      expect(draft.error).toMatch(/timed out/);
      expect(second.emitted('open-creation')).toBeUndefined();

      retried = true;
      await second.vm.submitIgnite();
      expect(workspace.mock.calls[2][0]).toMatchObject({ resumeCreationId: id, rawFiles: [file1, file2] });
      await expect(workspace.mock.results[2].value).resolves.toMatchObject({ _submittedSnapshot: { files: [] } });
      expect(upload).toHaveBeenCalledExactlyOnceWith([file1]);
      expect(send.mock.calls.filter(([msg]) => msg.op === 'create_creation')).toHaveLength(1);
      expect(serviceA.store.getCreation(id)).toMatchObject({ title: 'Revised', kind: 'deck' });
      expect(draft.pendingFiles).toEqual([file1, file2]);
      expect(draft.open).toBe(true);
      expect(second.emitted('toast')).toContainEqual([expect.stringMatching(/Unuploaded attachments|未上传的附件/)]);
      expect(second.emitted('open-creation')).toEqual([[expect.objectContaining({ creationId: id, keepIgniteDockOpen: true })]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R3-F5: patches the importKey-deduplicated Creation with edits made after its lost ACK', async () => {
    await registerBrowserStores();
    const { default: CreationCreateModal } = await import('../../web/components/workbench/CreationCreateModal.js');
    chatStore.currentAgent = route.agentId;
    chatStore.agents = [{ id: route.agentId, online: true, capabilities: ['creations'] }];
    const committed = deferred();
    let droppedAck = false;
    const send = interceptSocket(chatStore, msg => {
      if (msg.type === 'yeaft_create_session') return sessionAck(chatStore, msg, 'create', { session: { id: 'linked-session' } });
      if (msg.op !== 'create_creation' || droppedAck) return;
      droppedAck = true;
      committed.resolve(serviceA.request({ op: msg.op, payload: msg.payload }));
      return true;
    });
    const workspace = vi.spyOn(creationsStore, 'createWorkspaceCreation');
    const modal = render(CreationCreateModal, { stubs: { Teleport: true }, attachTo: document.body });
    await modal.get('#creation-create-title').setValue('Original atlas');
    vi.useFakeTimers();
    try {
      modal.get('button[type="submit"]').element.click();
      const { creation: { id } } = await committed.promise;
      expect(serviceA.store.getCreation(id)).toMatchObject({ title: 'Original atlas', kind: 'book' });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(modal.get('[role="alert"]').text()).toContain('timed out');
      expect(modal.emitted('created')).toBeUndefined();
      await modal.get('#creation-create-title').setValue('Revised slides');
      await modal.get('.creation-kind-pill:has(.is-deck)').trigger('click');
      modal.get('button[type="submit"]').element.click();
      await flushPromises();
      expect(workspace).toHaveBeenLastCalledWith(expect.objectContaining({ resumeCreationId: undefined, title: 'Revised slides', kind: 'deck' }));
      const creates = send.mock.calls.map(([msg]) => msg).filter(msg => msg.op === 'create_creation');
      expect(creates).toHaveLength(2);
      expect(creates[0].payload.importKey).toBeTruthy();
      expect(creates[1].payload.importKey).toBe(creates[0].payload.importKey);
      expect(modal.emitted('created')).toEqual([[expect.objectContaining({ creation: expect.objectContaining({ id }) })]]);
      expect(serviceA.store.getCreation(id)).toMatchObject({ title: 'Revised slides', kind: 'deck', sessionId: 'linked-session' });
      expect(serviceA.store.listCreations()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['added', 'replaced', 'digest missing', 'identical duplicate'])('R8-F1: retains unconfirmed attachments after a lost Ignite create ACK (%s)', async scenario => {
    await registerBrowserStores();
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const { agentId } = route;
    chatStore.currentAgent = agentId;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations'] }];
    await creationsStore.selectGalaxyAgent(agentId);
    const committed = deferred();
    const handleResponse = creationsStore.handleCreationResponse;
    let droppedAck = false;
    let retryAck;
    vi.spyOn(creationsStore, 'handleCreationResponse').mockImplementation(msg => {
      if (msg.op !== 'create_creation' || !msg.ok) return handleResponse(msg);
      if (droppedAck) {
        retryAck = msg.data;
        if (scenario !== 'digest missing') return handleResponse(msg);
        // Only the compatibility case emulates an older Agent that omits the digest.
        const sources = msg.data.sources.map(({ sha256, ...source }) => source);
        return handleResponse({ ...msg, data: { ...msg.data, sources } });
      }
      droppedAck = true;
      committed.resolve(msg.data);
    });
    const send = interceptSocket(chatStore, msg => {
      if (msg.type === 'yeaft_create_session') return sessionAck(chatStore, msg, 'create', { session: { id: 'linked-session' } });
    });
    const file1 = new File(['hello'], 'brief.txt', { type: 'text/plain' });
    const file2 = new File([scenario === 'identical duplicate' ? 'hello' : 'world'],
      scenario === 'added' ? 'second.txt' : 'brief.txt', { type: 'text/plain' });
    let uploadSeq = 0;
    vi.spyOn(creationsStore, 'uploadRawFiles').mockImplementation(async files => Promise.all(files.map(async file => {
      const fileId = `${file.name}-${++uploadSeq}`;
      uploads.set(fileId, { userId: 'alice', name: file.name, mimeType: file.type, uploadedAt: Date.now(),
        buffer: Buffer.from(await file.arrayBuffer()) });
      return { fileId };
    })));
    vi.stubGlobal('crypto', webcrypto);
    const draft = creationsStore.igniteDraft;
    const galaxy = render(CosmosGalaxyOverlay, { props: { visible: true, agents: chatStore.agents } });
    Object.assign(draft, { open: true, title: 'Atlas', pendingFiles: [file1] });
    await Vue.nextTick();
    vi.useFakeTimers();
    try {
      const firstSubmit = galaxy.vm.submitIgnite();
      const { creation: { id } } = await committed.promise;
      await vi.advanceTimersByTimeAsync(45_000);
      await firstSubmit;
      expect(draft.error).toMatch(/timed out/);
      expect(galaxy.emitted('open-creation')).toBeUndefined();
      if (scenario === 'replaced') galaxy.vm.removePendingFile(0);
      if (scenario !== 'digest missing') galaxy.vm.onFilePicked({ target: { files: [file2] } });
      await galaxy.vm.submitIgnite();
      expect(draft.error).toBeNull();
      const creates = send.mock.calls.map(([msg]) => msg.payload).filter(payload => payload?.importKey);
      expect(creates).toHaveLength(2);
      expect(creates[1].importKey).toBe(creates[0].importKey);
      expect(creates[1].attachments).toEqual([
        { fileId: 'brief.txt-2' },
        ...(['added', 'identical duplicate'].includes(scenario) ? [{ fileId: `${file2.name}-3` }] : []),
      ]);
      expect(retryAck).toMatchObject({ deduplicated: true, creation: { id }, sources: [expect.objectContaining({
        name: file1.name, sha256: createHash('sha256').update('hello').digest('hex'),
      })] });
      expect(serviceA.store.listCreations()).toHaveLength(1);
      expect(serviceA.store.listSources(id)).toEqual([expect.objectContaining({ name: file1.name, byteLength: file1.size })]);
      expect(draft.pendingFiles).toHaveLength(1);
      expect(Vue.toRaw(draft.pendingFiles[0])).toBe(scenario === 'digest missing' ? file1 : file2);
      expect(draft.open).toBe(true);
      expect(galaxy.emitted('toast')).toContainEqual([expect.stringMatching(/Unuploaded attachments|未上传的附件/)]);
      expect(galaxy.emitted('open-creation')).toEqual([[expect.objectContaining({ creationId: id, keepIgniteDockOpen: true })]]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('R4-B5: retries an interrupted folder bind with the same bounded Agent-scoped import key', async () => {
    const folder = join(tempDirA, 'long-folder-'.repeat(18));
    mkdirSync(folder);
    // Force the create path on retry, as if the lookup did not see the first write.
    vi.spyOn(creationsStore, 'findByFolder').mockResolvedValue(null);
    const create = creationsStore.createCreation;
    const rpc = vi.spyOn(creationsStore, 'createCreation').mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error('Creation ACK lost');
    });
    const bind = (agentId, rootDir) => creationsStore.bindFolderAsCreation({ agentId, rootDir });
    await expect(bind('agent-a', folder)).rejects.toThrow('Creation ACK lost');
    const [original] = serviceA.store.listCreations();
    await expect(bind('agent-a', `${folder}/`)).resolves.toMatchObject({ creation: { id: original.id } });
    const importKey = rpc.mock.calls[0][1].importKey;
    expect(importKey).toMatch(/^bind-folder:[a-f0-9]+$/);
    expect(importKey.length).toBeLessThanOrEqual(128);
    expect(rpc.mock.calls[1][1].importKey).toBe(importKey);
    expect(serviceA.store.listCreations().map(item => item.id)).toEqual([original.id]);
    rpc.mockResolvedValue({ creation: { id: 'other' } });
    await bind('agent-b', folder);
    await bind('agent-a', `${folder}-other`);
    expect(new Set(rpc.mock.calls.map(([, payload]) => payload.importKey)).size).toBe(3);
  });

  it('R5-F1: keeps literal POSIX backslashes distinct in concurrent bind keys', async () => {
    const slash = '/repo/team/docs';
    const backslash = String.raw`/repo/team\docs`;
    vi.spyOn(creationsStore, 'findByFolder').mockResolvedValue(null);
    const create = vi.spyOn(creationsStore, 'createCreation').mockImplementation(async (_, payload) => ({
      creation: { id: payload.importKey, rootDir: payload.rootDir },
    }));
    const bind = dir => creationsStore.bindFolderAsCreation({ agentId: route.agentId, rootDir: dir });
    const [first, second, equivalent] = await Promise.all([bind(slash), bind(backslash), bind(' /repo//team/docs/ ')]);
    expect(first.creation.id).not.toBe(second.creation.id);
    expect(second.creation.rootDir).toBe(backslash);
    expect(equivalent.creation.id).toBe(first.creation.id);
    expect(create).toHaveBeenCalledTimes(2);
    await bind('/repo//team/docs/');
    expect(create.mock.calls[2][1].importKey).toBe(create.mock.calls[0][1].importKey);
  });

  it('R6-F1: shares the same bind key for both UNC spellings', async () => {
    const { normalizeWorkspacePath } = await import('../../web/stores/creations.js');
    const native = String.raw`\\host\share\docs`;
    const forward = '//host/share//docs/';
    expect([native, forward].map(normalizeWorkspacePath)).toEqual(['//host/share/docs', '//host/share/docs']);
    vi.spyOn(creationsStore, 'findByFolder').mockResolvedValue(null);
    const create = vi.spyOn(creationsStore, 'createCreation').mockResolvedValue({ creation: { id: 'unc', rootDir: native } });
    const bind = rootDir => creationsStore.bindFolderAsCreation({ agentId: route.agentId, rootDir });
    await Promise.all([bind(native), bind(forward)]);
    expect(create).toHaveBeenCalledTimes(1);
    await bind(forward);
    expect(create.mock.calls[1][1].importKey).toBe(create.mock.calls[0][1].importKey);
  });

  it.each([
    ['/repo/team/docs', String.raw`/repo/team\docs`, false],
    [String.raw`C:\Team\Docs`, 'c:/Team/Docs/', true],
    [String.raw`\\host\share\docs`, '//host/share//docs/', true],
  ])('R5-F1: reconciles a workspace at %s against Session workDir %s (match: %s)', async (creationDir, workDir, matches) => {
    await registerBrowserStores();
    const { creation } = await creationsStore.createCreation(route.agentId, { title: 'Atlas', autoPlan: false });
    // Use real inventory and Session-link RPCs, but simulate the Agent's path spelling.
    creationsStore._upsertSummary(route.agentId, { ...creation, rootDir: creationDir });
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') {
        return sessionAck(chatStore, request, 'list', { sessions: [{ id: 'existing', agentId: route.agentId, workDir }] });
      }
      if (request.type === 'yeaft_create_session') {
        return sessionAck(chatStore, request, 'create', { session: { id: 'fresh' } });
      }
    });
    await expect(creationsStore.createWorkspaceCreation({
      agentId: route.agentId, resumeCreationId: creation.id, sessionAttempted: true, baselineSessionIds: [],
    })).resolves.toMatchObject({ creation: { id: creation.id, sessionId: matches ? 'existing' : 'fresh' } });
    expect(send.mock.calls.filter(([msg]) => msg.type === 'yeaft_create_session')).toHaveLength(matches ? 0 : 1);
  });

  it('R5-F2: resumes a folder binding from the real Agent materialization journal', async () => {
    const folder = join(tempDirA, 'interrupted-bind');
    mkdirSync(folder);
    const interrupt = vi.spyOn(serviceA.store, 'ensureWorkspace').mockImplementationOnce(() => {
      throw new Error('Interrupted after journal commit');
    });
    expect(() => serviceA.store.createCreation({ title: 'Interrupted bind', rootDir: folder, initializeFolder: true }))
      .toThrow('Interrupted after journal commit');
    const [{ id }] = serviceA.store.listCreations();
    expect(serviceA.store.one('SELECT target_dir FROM creation_materialization_journal WHERE creation_id=?', id))
      .toMatchObject({ target_dir: folder });
    interrupt.mockRestore();
    expect(await creationsStore.findByFolder(route.agentId, folder)).toMatchObject({ id, rootDir: null });
    const ensure = vi.spyOn(creationsStore, 'ensureWorkspace');
    await expect(creationsStore.bindFolderAsCreation({ agentId: route.agentId, rootDir: folder }))
      .resolves.toMatchObject({ existed: true, creation: { id, rootDir: folder } });
    expect(ensure).toHaveBeenCalledExactlyOnceWith(route.agentId, id, { rootDir: folder });
    expectWorkspace(folder, 'Interrupted bind');
    expect(serviceA.store.getCreation(id).rootDir).toBe(folder);
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
    externalDir = mkdtempSync(join(tmpdir(), 'yeaft-creation-ext-'));
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
    const wrapper = render(CreationTab, { props: { ...routeProps, workDir: externalDir } });
    expect(await lookupStarted.promise).toMatchObject({ agentId: route.agentId, payload: { rootDir: externalDir } });
    expect(socket.mock.calls.map(([request]) => request.op)).toEqual(['list_creations', 'find_by_folder']);
    expect(creationsStore.byAgent[route.agentId]).toMatchObject({ loaded: true, list: [] });
    expect(wrapper.vm.activeRootDir).toBe('');
    expect(socket.mock.calls.some(([request]) => request.type === 'list_directory')).toBe(false);
    const linked = serviceA.store.createCreation({ title: 'Found asynchronously', rootDir: externalDir });
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
      db.run('UPDATE creations SET cache_dir = NULL WHERE id = ?', id);
      mkdirSync(join(db.root, id, 'assets'), { recursive: true });
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

  it('R9-F1: refreshes cached Creation detail and opens the Session linked by another browser', async () => {
    await registerBrowserStores();
    const { creationDetailKey } = await import('../../web/stores/creations.js');
    const { default: CosmosPage } = await import('../../web/components/cosmos/CosmosPage.js');
    const agentId = 'agent-a';
    chatStore.agents = [{ id: agentId, name: 'Alpha', online: true, capabilities: ['creations'] }];
    const { creation } = await creationsStore.createCreation(agentId, { title: 'Unlinked Atlas' });
    await creationsStore.selectGalaxyAgent(agentId);
    expect(creationsStore.activeCreation).toBeNull();
    const detail = creationsStore.detailsByKey[creationDetailKey(agentId, creation.id)];
    const stale = { ...detail.creation, sessionId: null, rootDir: null, detailOnly: 'preserved' };
    detail.creation = stale;
    const linked = { id: creation.id, title: 'Linked Atlas', status: 'active', projectId: 'linked-project',
      sessionId: 'linked-by-other-browser', rootDir: '/workspace/linked' };
    const request = creationsStore.request.bind(creationsStore);
    const requests = vi.spyOn(creationsStore, 'request').mockImplementation((target, action, payload) => (
      action === 'list_creations' ? Promise.resolve({ creations: [linked] }) : request(target, action, payload)
    ));
    await creationsStore.reconcileAfterReconnect(agentId);
    expect(detail.creation).toMatchObject({ ...linked, detailOnly: 'preserved' });

    // Also cover Galaxy's read precedence independently of cache reconciliation.
    detail.creation = stale;
    chatStore.connectionState = 'connected';
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') return sessionAck(chatStore, request, 'list', { ok: false, error: { code: 'timeout' } });
    });
    const resolve = vi.spyOn(creationsStore, 'resolveCreationSession');
    const createSession = vi.spyOn(chatStore, 'createYeaftSession').mockRejectedValue(new Error('Unexpected Session creation'));
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const wrapper = render(CosmosPage, { stubs: {
      CosmosQuickComposer: true, CosmosConversationDrawer: true, CosmosGalaxyOverlay: true,
      SettingsPanel: true, AgentSettingsPanel: true, SessionSettingsModal: true,
    } });
    wrapper.vm.currentBand = 'galaxy';
    await Vue.nextTick();
    await wrapper.vm.openGalaxyCreation({ agentId, creationId: creation.id });
    expect(wrapper.vm.drawerOpen).toBe(true);
    expect(chatStore.yeaftActiveSessionFilter).toBe(linked.sessionId);
    expect(creationsStore.pendingWorkbenchTarget).toMatchObject({ agentId, creationId: creation.id,
      sessionId: linked.sessionId, rootDir: linked.rootDir });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(agentId, expect.objectContaining(linked), { createIfMissing: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_list_sessions', agentId }));
    expect(createSession).not.toHaveBeenCalled();
    expect(requests.mock.calls.map(([, action]) => action)).not.toContain('update_creation');
  });

  it.each(['Agent list', 'local Agent snapshot', 'Agent deletion receipt', 'R11-F1: Agent deletion receipt and stale catalog'])('Galaxy replaces a confirmed-deleted Session (%s)', async source => {
    const { sessions } = await registerBrowserStores();
    const { default: CosmosPage } = await import('../../web/components/cosmos/CosmosPage.js');
    const agentId = 'agent-a';
    const deletedId = 'deleted-session';
    const replacementId = 'live-replacement';
    chatStore.agents = [{ id: agentId, name: 'Alpha', online: true, capabilities: ['creations'] }];
    chatStore.connectionState = 'connected';
    const creation = serviceA.store.createCreation({ title: 'Recover Atlas', initializeFolder: true, sessionId: deletedId });
    await creationsStore.selectGalaxyAgent(agentId);
    sessions.applySnapshotUpsert({ id: deletedId, workDir: creation.rootDir }, 'agent-b');
    if (source === 'local Agent snapshot') sessions.applySnapshot([], agentId, { authoritative: true });
    const hasDeletionReceipt = source.includes('Agent deletion receipt');
    if (hasDeletionReceipt) sessions.applyCrudResult({ ok: true, op: 'delete', sessionId: deletedId }, agentId);
    if (source.includes('stale catalog')) {
      chatStore.applySessionCatalogSnapshot([{
        catalogKey: `yeaft:${agentId}:${deletedId}`, runtimeProvider: 'yeaft',
        routeRef: { runtimeProvider: 'yeaft', agentId, sessionId: deletedId },
      }]);
      expect(chatStore.hasKnownYeaftSession(deletedId, agentId)).toBe(true);
    }
    let replacement;
    const crud = vi.spyOn(chatStore, 'sessionCrudRequest');
    interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') return sessionAck(chatStore, request, 'list', replacement || source === 'Agent list'
        ? { sessions: replacement ? [replacement] : [] } : { ok: false, error: { code: 'timeout' } });
      if (request.type === 'yeaft_create_session') {
        replacement = { id: replacementId, workDir: creation.rootDir };
        return sessionAck(chatStore, request, 'create', { session: replacement });
      }
    });
    const resolve = vi.spyOn(creationsStore, 'resolveCreationSession');
    const createSession = vi.spyOn(chatStore, 'createYeaftSession');
    const update = vi.spyOn(creationsStore, 'updateCreation');
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const wrapper = render(CosmosPage, { stubs: {
      CosmosQuickComposer: true, CosmosConversationDrawer: true, CosmosGalaxyOverlay: true,
      SettingsPanel: true, AgentSettingsPanel: true, SessionSettingsModal: true,
    } });
    wrapper.vm.currentBand = 'galaxy';
    await Vue.nextTick();
    await wrapper.vm.openGalaxyCreation({ agentId, creationId: creation.id });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(agentId, expect.objectContaining({
      id: creation.id, sessionId: deletedId, rootDir: creation.rootDir,
    }), { createIfMissing: true });
    const probe = ['list', {}, { agentId, suppressAutoSelect: true }];
    if (hasDeletionReceipt) expect(crud).not.toHaveBeenCalledWith(...probe);
    else expect(crud).toHaveBeenCalledWith(...probe);
    expect(createSession).toHaveBeenCalledExactlyOnceWith({ agentId, displayName: creation.title, workDir: creation.rootDir });
    expect(update).toHaveBeenCalledExactlyOnceWith(agentId, creation.id, { sessionId: replacementId, expectedSessionId: deletedId });
    expect(serviceA.store.getCreation(creation.id).sessionId).toBe(replacementId);
    expect(wrapper.vm.drawerOpen).toBe(true);
    expect(chatStore.yeaftActiveSessionFilter).toBe(replacementId);
    expect(creationsStore.pendingWorkbenchTarget).toMatchObject({ agentId, creationId: creation.id,
      sessionId: replacementId, rootDir: creation.rootDir });
  });

  it('R11-F2: an empty Server replay and a real list timeout do not invalidate the recorded Session', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const creation = serviceA.store.createCreation({ title: 'Atlas', initializeFolder: true, sessionId: 'recorded-session' });
    chatStore.connectionState = 'connected';
    chatStore.yeaftSessionInventoryCompleteSupported = true;
    chatStore.yeaftSessionHydrateRequestId = 'shadow-replay';
    chatStore.handleMessage({ type: 'yeaft_session_hydrate', agentId, requestId: 'shadow-replay', sessions: [] });
    chatStore.handleMessage({ type: 'yeaft_session_hydrate_complete', requestId: 'shadow-replay', ok: true });
    expect(sessions.hasLoadedSnapshot).toBe(true);
    expect(sessions.sessionById(creation.sessionId, agentId)).toBeNull();
    const createSession = vi.spyOn(chatStore, 'createYeaftSession').mockRejectedValue(new Error('Unexpected duplicate Session'));
    vi.useFakeTimers();
    try {
      const resolution = creationsStore.resolveCreationSession(agentId, creation);
      expect(chatStore.sendWsMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_list_sessions', agentId }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await resolution).toMatchObject({ sessionId: creation.sessionId });
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('R11-F3: a Classic open with no selection survives its own live list response', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const creation = serviceA.store.createCreation({ title: 'Atlas', initializeFolder: true, sessionId: 'target-session' });
    chatStore.agents = [{ id: agentId, online: true }];
    chatStore.connectionState = 'connected';
    chatStore.currentAgent = agentId;
    chatStore.currentView = 'yeaft';
    chatStore.uiMode = 'classic';
    chatStore.yeaftActiveSessionFilter = null;
    expect(sessions.activeSessionKey).toBeNull();
    const crud = vi.spyOn(chatStore, 'sessionCrudRequest');
    const replacement = { id: 'replacement', workDir: creation.rootDir };
    let created = false;
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') {
        return sessionAck(chatStore, request, 'list', { sessions: [{ id: 'other-session' }, ...(created ? [replacement] : [])] });
      }
      if (request.type === 'yeaft_create_session') {
        expect(sessions.sessionById('other-session', agentId)).not.toBeNull();
        expect(sessions.activeSessionKey).toBeNull();
        expect(chatStore.yeaftActiveSessionFilter).toBeNull();
        created = true;
        return sessionAck(chatStore, request, 'create', { session: replacement });
      }
    });
    const opened = await creationsStore.openCreationWorkspace({ agentId, creationId: creation.id });
    expect(crud).toHaveBeenCalledWith('list', {}, { agentId, suppressAutoSelect: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_create_session', agentId }));
    expect(opened).toMatchObject({ creation: { id: creation.id }, sessionId: 'replacement' });
    expect(chatStore.yeaftActiveSessionFilter).toBe('replacement');
    expect(chatStore.workbenchExpanded).toBe(true);
    expect(creationsStore.pendingWorkbenchTarget).toMatchObject({ agentId, creationId: creation.id, sessionId: 'replacement' });
  });

  it.each(['list probe', 'Session creation'])('R11-F4: adopts a competing relink during %s without overwriting it', async phase => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const creation = serviceA.store.createCreation({ title: 'Atlas', initializeFolder: true, sessionId: 'deleted-link' });
    chatStore.connectionState = 'connected';
    const list = deferred();
    const create = deferred();
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') {
        list.resolve(request);
        return true;
      }
      if (request.type === 'yeaft_create_session') {
        create.resolve(request);
        return true;
      }
      if (request.type === 'yeaft_delete_session') return sessionAck(chatStore, request, 'delete', { sessionId: request.sessionId });
    });
    const update = vi.spyOn(creationsStore, 'updateCreation');
    const resolution = creationsStore.resolveCreationSession(agentId, creation);
    const listRequest = await list.promise;
    const relink = () => serviceA.request({ op: 'update_creation', payload: {
      creationId: creation.id, patch: { sessionId: 'winner', expectedSessionId: creation.sessionId },
    } });
    if (phase === 'list probe') {
      await relink(); // Real service publishes creation_upserted to the local summary cache.
      sessionAck(chatStore, listRequest, 'list', { sessions: [{ id: 'winner' }] });
    } else {
      sessionAck(chatStore, listRequest, 'list', { sessions: [] });
      const createRequest = await create.promise;
      await relink();
      sessions.applySnapshotUpsert({ id: 'winner' }, agentId);
      sessionAck(chatStore, createRequest, 'create', { session: { id: 'orphan' } });
    }
    expect(await resolution).toMatchObject({ creation: { id: creation.id, sessionId: 'winner' }, sessionId: 'winner' });
    expect(serviceA.store.getCreation(creation.id).sessionId).toBe('winner');
    if (phase === 'list probe') {
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_create_session' }));
      expect(update).not.toHaveBeenCalled();
    } else {
      expect(update).toHaveBeenCalledExactlyOnceWith(agentId, creation.id, { sessionId: 'orphan', expectedSessionId: creation.sessionId });
      // Never unconditionally hard-delete a broadcast Session that another tab may already be using.
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_delete_session' }));
      expect(sessions.sessionById('winner', agentId)).not.toBeNull();
      expect(sessions.sessionById('orphan', agentId)).not.toBeNull();
    }
  });

  it('R12-F1: clears a stale deletion receipt on live authoritative Agent list after reconnect, but not on Server shadow replay', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const sessionId = 'restored-session';
    const creation = serviceA.store.createCreation({ title: 'Restored Atlas', initializeFolder: true, sessionId });
    chatStore.agents = [{ id: agentId, online: true }];
    chatStore.connectionState = 'connected';
    // Browser saw an archive/delete receipt before disconnecting.
    sessions.applyCrudResult({ ok: true, op: 'archive', sessionId }, agentId);
    expect(sessions.isConfirmedDeletedSession(agentId, sessionId)).toBe(true);
    // Reconnect shadow hydrate replay must NOT clear the deletion receipt.
    sessions.beginInventoryCommit();
    sessions.applySnapshot([{ id: sessionId, workDir: creation.rootDir }], agentId, { authoritative: false });
    expect(sessions.isConfirmedDeletedSession(agentId, sessionId)).toBe(true);
    // Live authoritative Agent list containing the restored Session clears the stale receipt.
    chatStore.handleMessage({
      type: 'yeaft_output',
      agentId,
      event: { type: 'session_list_updated', sessions: [{ id: sessionId, workDir: creation.rootDir }] },
    });
    expect(sessions.isConfirmedDeletedSession(agentId, sessionId)).toBe(false);
    const send = interceptSocket(chatStore, () => undefined);
    const resolved = await creationsStore.resolveCreationSession(agentId, creation);
    expect(resolved).toMatchObject({ creation: { id: creation.id }, sessionId });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_create_session' }));
  });

  it('R12-F2: keeps Classic open alive when session_list_updated arrives after replacement create while link write is pending', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const creation = serviceA.store.createCreation({ title: 'Atlas', initializeFolder: true, sessionId: 'missing-session' });
    chatStore.agents = [{ id: agentId, online: true }];
    chatStore.connectionState = 'connected';
    chatStore.currentAgent = agentId;
    chatStore.currentView = 'yeaft';
    chatStore.uiMode = 'classic';
    chatStore.yeaftActiveSessionFilter = null;
    const replacement = { id: 'replacement-2', workDir: creation.rootDir };
    let created = false;
    const linkHeld = deferred();
    const linkStarted = deferred();
    interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') {
        return sessionAck(chatStore, request, 'list', { sessions: [{ id: 'other-session' }, ...(created ? [replacement] : [])] });
      }
      if (request.type === 'yeaft_create_session') {
        created = true;
        sessionAck(chatStore, request, 'create', { session: replacement });
        // Real Agent broadcasts a full live session_list_updated right after create ACK.
        chatStore.handleMessage({
          type: 'yeaft_output',
          agentId,
          event: { type: 'session_list_updated', sessions: [{ id: 'other-session' }, replacement] },
        });
        return true;
      }
      if (request.type === 'creation_request' && request.op === 'update_creation') {
        linkStarted.resolve(request);
        void linkHeld.promise.then(async () => {
          const data = await serviceA.request({ op: request.op, payload: request.payload });
          creationsStore.handleCreationResponse({ ...request, type: 'creation_response', ok: true, data });
        });
        return true;
      }
    });
    const openPromise = creationsStore.openCreationWorkspace({ agentId, creationId: creation.id });
    await linkStarted.promise;
    // Inventory broadcast must not have auto-selected another Session or canceled the open.
    expect(sessions.activeSessionKey).toBeNull();
    expect(chatStore.yeaftActiveSessionFilter).toBeNull();
    linkHeld.resolve();
    const opened = await openPromise;
    expect(opened).toMatchObject({ creation: { id: creation.id }, sessionId: 'replacement-2' });
    expect(chatStore.yeaftActiveSessionFilter).toBe('replacement-2');
    expect(chatStore.workbenchExpanded).toBe(true);
    expect(sessions.suppressAutoSelectDepth).toBe(0);
  });

  it('R13-F1: adopts a live Session restored by snapshot while get_creation is pending instead of replacing it', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const sessionId = 'restored-during-get';
    const creation = serviceA.store.createCreation({ title: 'Restored Mid-Get', initializeFolder: true, sessionId });
    chatStore.agents = [{ id: agentId, online: true }];
    chatStore.connectionState = 'connected';
    // Browser still holds an old deletion receipt when resolution begins.
    sessions.applyCrudResult({ ok: true, op: 'archive', sessionId }, agentId);
    expect(sessions.isConfirmedDeletedSession(agentId, sessionId)).toBe(true);
    const getHeld = deferred();
    const getStarted = deferred();
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'creation_request' && request.op === 'get_creation') {
        getStarted.resolve(request);
        void getHeld.promise.then(async () => {
          const data = await serviceA.request({ op: request.op, payload: request.payload });
          creationsStore.handleCreationResponse({ ...request, type: 'creation_response', ok: true, data });
        });
        return true;
      }
    });
    const resolution = creationsStore.resolveCreationSession(agentId, creation);
    await getStarted.promise;
    // Live authoritative Agent snapshot restores the original Session before get_creation returns.
    chatStore.handleMessage({
      type: 'yeaft_output',
      agentId,
      event: { type: 'session_list_updated', sessions: [{ id: sessionId, workDir: creation.rootDir }] },
    });
    expect(sessions.isConfirmedDeletedSession(agentId, sessionId)).toBe(false);
    getHeld.resolve();
    const resolved = await resolution;
    expect(resolved).toMatchObject({ creation: { id: creation.id }, sessionId });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_create_session' }));
    expect(serviceA.store.getCreation(creation.id).sessionId).toBe(sessionId);
  });

  it('R13-F2: restores the current exact Session if reconnect inventory commits during a failed or canceled open', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const currentSessionId = 'current-session';
    sessions.applySnapshot([{ id: currentSessionId, workDir: '/repo/current' }], agentId, { authoritative: true });
    sessions.setActive(currentSessionId, agentId);
    chatStore.agents = [{ id: agentId, online: true }];
    chatStore.connectionState = 'connected';
    chatStore.currentAgent = agentId;
    chatStore.currentView = 'yeaft';
    chatStore.uiMode = 'classic';
    chatStore.yeaftActiveSessionFilter = currentSessionId;
    const creation = serviceA.store.createCreation({ title: 'Failing Open', initializeFolder: true, sessionId: 'missing-session' });
    const listHeld = deferred();
    const listStarted = deferred();
    interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') {
        listStarted.resolve(request);
        return true;
      }
      if (request.type === 'yeaft_create_session') {
        return sessionAck(chatStore, request, 'create', { ok: false, error: { code: 'denied', message: 'Create failed' } });
      }
    });
    const openPromise = creationsStore.openCreationWorkspace({ agentId, creationId: creation.id });
    const listReq = await listStarted.promise;
    // Reconnect inventory commit clears activeSessionKey, remembers currentSessionId, and imports it.
    sessions.beginInventoryCommit(currentSessionId, agentId);
    expect(sessions.activeSessionKey).toBeNull();
    sessions.applySnapshot([{ id: currentSessionId, workDir: '/repo/current' }], agentId, { authoritative: true });
    // Exact current Session is restored immediately without triggering fallback route change.
    expect(sessions.activeSessionId).toBe(currentSessionId);
    expect(sessions.activeSessionKey).toBeTruthy();
    // Now cancel the open without sending any further snapshot (and let the recovery settle cleanly).
    creationsStore.cancelPendingWorkspaceOpen();
    sessionAck(chatStore, listReq, 'list', { ok: false, error: { code: 'timeout' } });
    listHeld.resolve();
    expect(await openPromise).toBeNull();
    expect(sessions.suppressAutoSelectDepth).toBe(0);
    expect(sessions.activeSessionId).toBe(currentSessionId);
    expect(sessions.activeSessionKey).toBeTruthy();
    expect(chatStore.yeaftActiveSessionFilter).toBe(currentSessionId);
  });

  it('R14-F1: adopts a live Session buffered during inventory hydration before get_creation returns without creating a replacement', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const sessionId = 'restored-while-buffered';
    const creation = serviceA.store.createCreation({ title: 'Buffered Restore', initializeFolder: true, sessionId });
    chatStore.agents = [{ id: agentId, online: true }];
    chatStore.connectionState = 'connected';
    sessions.applyCrudResult({ ok: true, op: 'archive', sessionId }, agentId);
    expect(sessions.isConfirmedDeletedSession(agentId, sessionId)).toBe(true);
    // Simulate active inventory hydration buffering live session_list_updated frames.
    chatStore.yeaftSessionHydrateRequestId = 'hyd-1';
    chatStore.yeaftSessionInventoryCompleteSupported = true;
    chatStore.yeaftSessionHydrateSlices = [];
    const getHeld = deferred();
    const getStarted = deferred();
    const send = interceptSocket(chatStore, request => {
      if (request.type === 'creation_request' && request.op === 'get_creation') {
        getStarted.resolve(request);
        void getHeld.promise.then(async () => {
          const data = await serviceA.request({ op: request.op, payload: request.payload });
          creationsStore.handleCreationResponse({ ...request, type: 'creation_response', ok: true, data });
        });
        return true;
      }
    });
    const resolution = creationsStore.resolveCreationSession(agentId, creation);
    await getStarted.promise;
    // Live authoritative session_list_updated arrives while hydration is still open (buffered!).
    chatStore.handleMessage({
      type: 'yeaft_output',
      agentId,
      event: { type: 'session_list_updated', sessions: [{ id: sessionId, workDir: creation.rootDir }] },
    });
    // get_creation returns BEFORE yeaft_session_hydrate_complete arrives.
    getHeld.resolve();
    const resolved = await resolution;
    expect(resolved).toMatchObject({ creation: { id: creation.id }, sessionId });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'yeaft_create_session' }));
    // Subsequent hydration completion commits the buffered live slice cleanly.
    chatStore.handleMessage({ type: 'yeaft_session_hydrate_complete', requestId: 'hyd-1' });
    expect(sessions.isConfirmedDeletedSession(agentId, sessionId)).toBe(false);
    expect(sessions.sessionById(sessionId, agentId)).not.toBeNull();
  });

  it('R14-F2: a persisted localStorage last-viewed Session returning during inventory commit does not preempt an explicit Creation open', async () => {
    const { sessions } = await registerBrowserStores();
    const { LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey } = await import('../../web/stores/helpers/yeaft-session-identity.js');
    const agentId = 'agent-a';
    const savedId = 'offline-saved-session';
    const targetId = 'creation-target-session';
    // Persist saved preference in localStorage while no Session is currently active.
    localStorage.setItem(LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey(agentId, savedId));
    try {
      const creation = serviceA.store.createCreation({ title: 'Explicit Open', initializeFolder: true, sessionId: targetId });
      chatStore.agents = [{ id: agentId, online: true }];
      chatStore.connectionState = 'connected';
      chatStore.currentAgent = agentId;
      chatStore.currentView = 'yeaft';
      chatStore.uiMode = 'classic';
      chatStore.yeaftActiveSessionFilter = null;
      expect(sessions.activeSessionKey).toBeNull();
      const listStarted = deferred();
      interceptSocket(chatStore, request => {
        if (request.type === 'yeaft_list_sessions') {
          listStarted.resolve(request);
          return true;
        }
      });
      const openPromise = creationsStore.openCreationWorkspace({ agentId, creationId: creation.id });
      const listReq = await listStarted.promise;
      // Inventory commit arrives with the previously offline saved-fallback Session.
      const preferred = sessions.preferredInventoryIdentity();
      expect(preferred).toEqual({ agentId, sessionId: savedId, fromSavedFallback: true });
      sessions.beginInventoryCommit(preferred.sessionId, preferred.agentId, { fromSavedFallback: preferred.fromSavedFallback });
      sessions.applySnapshot([
        { id: savedId, workDir: '/repo/saved' },
        { id: targetId, workDir: creation.rootDir },
      ], agentId, { authoritative: true });
      // Saved localStorage preference MUST NOT preempt the route or cancel the explicit open.
      expect(sessions.activeSessionKey).toBeNull();
      expect(chatStore.yeaftActiveSessionFilter).toBeNull();
      sessionAck(chatStore, listReq, 'list', {
        sessions: [
          { id: savedId, workDir: '/repo/saved' },
          { id: targetId, workDir: creation.rootDir },
        ],
      });
      const opened = await openPromise;
      expect(opened).toMatchObject({ creation: { id: creation.id }, sessionId: targetId });
      expect(chatStore.yeaftActiveSessionFilter).toBe(targetId);
      expect(chatStore.workbenchExpanded).toBe(true);
      expect(sessions.suppressAutoSelectDepth).toBe(0);
    } finally {
      localStorage.removeItem(LAST_VIEWED_YEAFT_SESSION_KEY);
    }
  });

  it('R15-F1: archiving the saved Session after hydration completes does not cancel a pending Classic Creation open', async () => {
    const { sessions } = await registerBrowserStores();
    const { LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey } = await import('../../web/stores/helpers/yeaft-session-identity.js');
    const agentId = 'agent-a';
    const savedId = 'saved-to-archive';
    const otherId = 'unrelated-other-session';
    const targetId = 'creation-target-session';
    localStorage.setItem(LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey(agentId, savedId));
    try {
      const creation = serviceA.store.createCreation({ title: 'Archive Safe Open', initializeFolder: true, sessionId: targetId });
      chatStore.agents = [{ id: agentId, online: true }];
      chatStore.connectionState = 'connected';
      chatStore.currentAgent = agentId;
      chatStore.currentView = 'yeaft';
      chatStore.uiMode = 'classic';
      chatStore.yeaftActiveSessionFilter = null;
      chatStore.yeaftSessionHydrateRequestId = 'hyd-r15';
      chatStore.yeaftSessionInventoryCompleteSupported = true;
      chatStore.yeaftSessionHydrateSlices = [
        {
          agentId,
          live: false,
          sessions: [
            { id: savedId, workDir: '/repo/saved' },
            { id: otherId, workDir: '/repo/other' },
          ],
        },
      ];
      const listStarted = deferred();
      interceptSocket(chatStore, request => {
        if (request.type === 'yeaft_list_sessions') {
          listStarted.resolve(request);
          return true;
        }
      });
      const openPromise = creationsStore.openCreationWorkspace({ agentId, creationId: creation.id });
      const listReq = await listStarted.promise;
      // Real hydration-complete frame commits savedId + otherId + targetId while open is pending.
      chatStore.handleMessage({ type: 'yeaft_session_hydrate_complete', requestId: 'hyd-r15' });
      expect(sessions.activeSessionKey).toBeNull();
      // Another tab archives the saved Session while the Creation open is still awaiting listReq.
      chatStore.handleMessage({
        type: 'yeaft_output',
        agentId,
        event: { type: 'yeaft_session_crud_result', ok: true, op: 'archive', sessionId: savedId },
      });
      // Archive receipt MUST NOT auto-select otherId or cancel the pending Creation open.
      expect(sessions.activeSessionKey).toBeNull();
      expect(chatStore.yeaftActiveSessionFilter).toBeNull();
      sessionAck(chatStore, listReq, 'list', {
        sessions: [
          { id: otherId, workDir: '/repo/other' },
          { id: targetId, workDir: creation.rootDir },
        ],
      });
      const opened = await openPromise;
      expect(opened).toMatchObject({ creation: { id: creation.id }, sessionId: targetId });
      expect(chatStore.yeaftActiveSessionFilter).toBe(targetId);
      expect(chatStore.workbenchExpanded).toBe(true);
      expect(sessions.suppressAutoSelectDepth).toBe(0);
    } finally {
      localStorage.removeItem(LAST_VIEWED_YEAFT_SESSION_KEY);
    }
  });

  it('R15-F2: a failed Creation open reconciles an available saved Session immediately without waiting for another snapshot', async () => {
    const { sessions } = await registerBrowserStores();
    const { LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey } = await import('../../web/stores/helpers/yeaft-session-identity.js');
    const agentId = 'agent-a';
    const savedId = 'available-saved-session';
    localStorage.setItem(LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey(agentId, savedId));
    try {
      const creation = serviceA.store.createCreation({ title: 'Failing Open', initializeFolder: true, sessionId: 'deleted-session' });
      chatStore.agents = [{ id: agentId, online: true }];
      chatStore.connectionState = 'connected';
      chatStore.currentAgent = agentId;
      chatStore.currentView = 'yeaft';
      chatStore.uiMode = 'classic';
      chatStore.yeaftActiveSessionFilter = null;
      const listStarted = deferred();
      interceptSocket(chatStore, request => {
        if (request.type === 'yeaft_list_sessions') {
          listStarted.resolve(request);
          return true;
        }
        if (request.type === 'yeaft_create_session') {
          return sessionAck(chatStore, request, 'create', { ok: false, error: { code: 'denied', message: 'Cannot create replacement' } });
        }
      });
      const openPromise = creationsStore.openCreationWorkspace({ agentId, creationId: creation.id });
      const listReq = await listStarted.promise;
      // Saved Session arrives via inventory commit while suppressed.
      const preferred = sessions.preferredInventoryIdentity();
      sessions.beginInventoryCommit(preferred.sessionId, preferred.agentId, { fromSavedFallback: preferred.fromSavedFallback });
      sessions.applySnapshot([{ id: savedId, workDir: '/repo/saved' }], agentId, { authoritative: true });
      expect(sessions.activeSessionKey).toBeNull();
      // List confirms deleted-session is absent -> create_session fails -> open fails!
      sessionAck(chatStore, listReq, 'list', { sessions: [{ id: savedId, workDir: '/repo/saved' }] });
      await expect(openPromise).rejects.toThrow(/Cannot create replacement/);
      // No later snapshot is sent; savedId must immediately become active and not show "unavailable".
      expect(sessions.suppressAutoSelectDepth).toBe(0);
      expect(sessions.activeSessionId).toBe(savedId);
      expect(sessions.activeSessionKey).toBeTruthy();
      expect(sessions.waitingForLastViewedSession).toBe(false);
    } finally {
      localStorage.removeItem(LAST_VIEWED_YEAFT_SESSION_KEY);
    }
  });

  it('R16-F1: archiving the currently active Session during suppression reconciles to a remaining Session when the open fails', async () => {
    const { sessions } = await registerBrowserStores();
    const agentId = 'agent-a';
    const activeId = 'active-to-archive';
    const fallbackId = 'remaining-session';
    sessions.applySnapshot([
      { id: activeId, workDir: '/repo/active' },
      { id: fallbackId, workDir: '/repo/fallback' },
    ], agentId, { authoritative: true });
    sessions.setActive(activeId, agentId);
    chatStore.agents = [{ id: agentId, online: true }];
    chatStore.connectionState = 'connected';
    chatStore.currentAgent = agentId;
    chatStore.currentView = 'yeaft';
    chatStore.uiMode = 'classic';
    chatStore.yeaftActiveSessionFilter = activeId;
    const creation = serviceA.store.createCreation({ title: 'Failing Open', initializeFolder: true, sessionId: 'missing-session' });
    const listStarted = deferred();
    interceptSocket(chatStore, request => {
      if (request.type === 'yeaft_list_sessions') {
        listStarted.resolve(request);
        return true;
      }
      if (request.type === 'yeaft_create_session') {
        return sessionAck(chatStore, request, 'create', { ok: false, error: { code: 'denied', message: 'Create failed' } });
      }
    });
    const openPromise = creationsStore.openCreationWorkspace({ agentId, creationId: creation.id });
    const listReq = await listStarted.promise;
    // Active Session is archived while Creation open is pending.
    sessions.applyCrudResult({ ok: true, op: 'archive', sessionId: activeId }, agentId);
    // Row is removed, but suppression prevents switching route while open is pending.
    expect(sessions.activeSession).toBeNull();
    expect(chatStore.yeaftActiveSessionFilter).toBe(activeId);
    // Open fails -> suppression ends -> must reconcile off the dangling archived key to fallbackId.
    sessionAck(chatStore, listReq, 'list', { sessions: [{ id: fallbackId, workDir: '/repo/fallback' }] });
    await expect(openPromise).rejects.toThrow(/Create failed/);
    expect(sessions.suppressAutoSelectDepth).toBe(0);
    expect(sessions.activeSessionId).toBe(fallbackId);
    expect(sessions.activeSession?.id).toBe(fallbackId);
  });

  it('R16-F2: a second-Agent roster delta for a provisional retired bare Session does not cancel a pending Classic open', async () => {
    const { sessions } = await registerBrowserStores();
    const { LAST_VIEWED_YEAFT_SESSION_KEY } = await import('../../web/stores/helpers/yeaft-session-identity.js');
    const agentA = 'agent-a';
    const agentB = 'agent-b';
    const bareId = 'shared-bare-id';
    const targetId = 'creation-target';
    localStorage.setItem(LAST_VIEWED_YEAFT_SESSION_KEY, bareId);
    try {
      // Only Agent A has bareId initially, so retired-bare provisionally selects Agent A's row.
      sessions.applySnapshot([{ id: bareId, workDir: '/repo/a' }], agentA, { authoritative: true });
      expect(sessions.activeSessionId).toBe(bareId);
      expect(sessions._retiredBareActiveSessionId).toBe(bareId);
      const creation = serviceA.store.createCreation({ title: 'Bare Safe Open', initializeFolder: true, sessionId: targetId });
      chatStore.agents = [{ id: agentA, online: true }, { id: agentB, online: true }];
      chatStore.connectionState = 'connected';
      chatStore.currentAgent = agentA;
      chatStore.currentView = 'yeaft';
      chatStore.uiMode = 'classic';
      chatStore.yeaftActiveSessionFilter = bareId;
      const listStarted = deferred();
      interceptSocket(chatStore, request => {
        if (request.type === 'yeaft_list_sessions') {
          listStarted.resolve(request);
          return true;
        }
      });
      const openPromise = creationsStore.openCreationWorkspace({ agentId: agentA, creationId: creation.id });
      const listReq = await listStarted.promise;
      // Agent B publishes a roster delta with the same bareId while open is pending.
      sessions.applyRosterChange({ sessionId: bareId, name: 'Duplicate Bare', roster: [] }, agentB);
      // Suppression prevents retired-bare ambiguity from clearing the active filter and canceling open.
      expect(chatStore.yeaftActiveSessionFilter).toBe(bareId);
      sessionAck(chatStore, listReq, 'list', {
        sessions: [
          { id: bareId, workDir: '/repo/a' },
          { id: targetId, workDir: creation.rootDir },
        ],
      });
      const opened = await openPromise;
      expect(opened).toMatchObject({ creation: { id: creation.id }, sessionId: targetId });
      expect(chatStore.yeaftActiveSessionFilter).toBe(targetId);
      expect(sessions._retiredBareActiveSessionId).toBeNull();
    } finally {
      localStorage.removeItem(LAST_VIEWED_YEAFT_SESSION_KEY);
    }
  });

  it('R16-F3: hydration completing after a failed Agent A open still restores Agent B saved Session', async () => {
    const { sessions } = await registerBrowserStores();
    const { LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey } = await import('../../web/stores/helpers/yeaft-session-identity.js');
    const agentA = 'agent-a';
    const agentB = 'agent-b';
    const savedB = 'saved-on-agent-b';
    localStorage.setItem(LAST_VIEWED_YEAFT_SESSION_KEY, yeaftSessionIdentityKey(agentB, savedB));
    try {
      const creation = serviceA.store.createCreation({ title: 'Agent A Failing Open', initializeFolder: true, sessionId: 'missing-a' });
      chatStore.agents = [{ id: agentA, online: true }, { id: agentB, online: true }];
      chatStore.connectionState = 'connected';
      chatStore.currentAgent = agentA;
      chatStore.currentView = 'yeaft';
      chatStore.uiMode = 'classic';
      chatStore.yeaftActiveSessionFilter = null;
      chatStore.yeaftSessionHydrateRequestId = 'hyd-r16';
      chatStore.yeaftSessionInventoryCompleteSupported = true;
      chatStore.yeaftSessionHydrateSlices = [
        { agentId: agentB, live: true, sessions: [{ id: savedB, workDir: '/repo/b' }] },
      ];
      interceptSocket(chatStore, request => {
        if (request.type === 'yeaft_list_sessions') {
          return sessionAck(chatStore, request, 'list', { sessions: [{ id: 'other-a', workDir: '/repo/a' }] });
        }
        if (request.type === 'yeaft_create_session') {
          return sessionAck(chatStore, request, 'create', { ok: false, error: { code: 'denied', message: 'Agent A denied' } });
        }
      });
      // Agent A open probes list (buffered under hyd-r16) and fails BEFORE hydration completes.
      await expect(creationsStore.openCreationWorkspace({ agentId: agentA, creationId: creation.id }))
        .rejects.toThrow(/Agent A denied/);
      expect(sessions.suppressAutoSelectDepth).toBe(0);
      // Hydration now completes: Agent B's saved Session must NOT stay stranded by Agent A's ended probe.
      chatStore.handleMessage({ type: 'yeaft_session_hydrate_complete', requestId: 'hyd-r16' });
      expect(sessions.activeSessionId).toBe(savedB);
      expect(sessions.activeSession?.agentId).toBe(agentB);
      expect(sessions.waitingForLastViewedSession).toBe(false);
    } finally {
      localStorage.removeItem(LAST_VIEWED_YEAFT_SESSION_KEY);
    }
  });

  it.each(['leave Galaxy and return', 'close the drawer'])('fences a pending Galaxy Creation open when users %s', async action => {
    const { sessions } = await registerBrowserStores();
    const { default: CosmosPage } = await import('../../web/components/cosmos/CosmosPage.js');
    chatStore.agents = [{ id: 'agent-a', name: 'Alpha', online: true, capabilities: ['creations'] }];
    const ready = serviceA.store.createCreation({ title: 'Open now', initializeFolder: true, sessionId: 'ready-session' });
    sessions.applySnapshotUpsert({ id: ready.sessionId, workDir: ready.rootDir }, 'agent-a');
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

  it('R2-F3: routes an acknowledged Creation modal result to the new Session in the Cosmos drawer', async () => {
    const { sessions } = await registerBrowserStores();
    const [{ default: CosmosPage }, { default: CreationTab }, { default: CreationCreateModal }] = await Promise.all([
      import('../../web/components/cosmos/CosmosPage.js'), import('../../web/components/workbench/CreationTab.js'),
      import('../../web/components/workbench/CreationCreateModal.js'),
    ]);
    const agentId = route.agentId;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations', 'file_editor', 'creation_workbench_files', 'workbench_session_routes'] }];
    Object.assign(chatStore, { uiMode: 'cosmos', currentAgent: agentId, currentView: 'yeaft',
      yeaftActiveSessionFilter: route.sessionId, workbenchRouteProtocolSupported: true });
    const current = serviceA.store.createCreation({ title: 'Current', initializeFolder: true, sessionId: route.sessionId });
    const created = serviceA.store.createCreation({ title: 'New Cosmos Atlas', initializeFolder: true, sessionId: 'new-cosmos-session' });
    for (const record of [current, created]) {
      sessions.applySnapshotUpsert({ id: record.sessionId, workDir: record.rootDir }, agentId);
    }
    await creationsStore.selectGalaxyAgent(agentId);
    const send = mockWorkbenchFiles(chatStore);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const page = render(CosmosPage, { stubs: {
      CosmosQuickComposer: true, CosmosGalaxyOverlay: true, SettingsPanel: true,
      AgentSettingsPanel: true, SessionSettingsModal: true, MessageList: true, ChatInput: true, Teleport: true,
    } });
    page.vm.currentBand = 'galaxy';
    await Vue.nextTick();
    await page.vm.openGalaxyCreation({ agentId, creationId: current.id, sessionId: current.sessionId, rootDir: current.rootDir });
    await flushPromises();
    const tab = page.getComponent(CreationTab);
    expect(tab.vm.activeCreation.id).toBe(current.id);
    await tab.get(`[aria-label="${t('creation.workbench.switchCreation')}"]`).trigger('click');
    await tab.get('.creation-wb-action-card').trigger('click');
    const resolveSession = vi.spyOn(creationsStore, 'resolveCreationSession');
    const ensure = vi.spyOn(creationsStore, 'ensureWorkspace');
    const routed = vi.fn();
    window.addEventListener('cosmos-open-creation-workspace', routed, { once: true });
    try {
      tab.getComponent(CreationCreateModal).vm.$emit('created', {
        agentId, creation: created, sessionId: created.sessionId, rootDir: created.rootDir,
      });
      await flushPromises();
      expect(routed).toHaveBeenCalledTimes(1);
      expect(routed.mock.calls[0][0].detail).toMatchObject({ handled: true, agentId,
        sessionId: created.sessionId, creationId: created.id, rootDir: created.rootDir });
      expect(chatStore.uiMode).toBe('cosmos');
      expect(chatStore.yeaftActiveSessionFilter).toBe(created.sessionId);
      expect(page.vm.drawerOpen).toBe(true);
      const destination = page.getComponent(CreationTab);
      expect(destination.props('sessionId')).toBe(created.sessionId);
      expect(destination.vm.activeCreation.id).toBe(created.id);
      expect(resolveSession).not.toHaveBeenCalled();
      expect(ensure).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'creation_request', op: 'ensure_workspace' }));
    } finally {
      window.removeEventListener('cosmos-open-creation-workspace', routed);
    }
  });

  it.each(['workspace event', 'direct Galaxy open', 'workspace event with claimed root'])('R8-F2: a clean Cosmos tab must accept an unrecorded Creation before its initial prompt (%s)', async entry => {
    const { sessions } = await registerBrowserStores();
    const [{ default: CosmosPage }, { default: CreationTab }] = await Promise.all([
      import('../../web/components/cosmos/CosmosPage.js'), import('../../web/components/workbench/CreationTab.js'),
    ]);
    const { agentId, sessionId } = route;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations', 'file_editor', 'creation_workbench_files', 'workbench_session_routes'] }];
    Object.assign(chatStore, { uiMode: 'cosmos', currentAgent: agentId, currentView: 'yeaft',
      yeaftActiveSessionFilter: sessionId, workbenchRouteProtocolSupported: true });
    const current = serviceA.store.createCreation({ title: 'Current', initializeFolder: true, sessionId });
    const next = serviceA.store.createCreation({ title: 'Unrecorded', sessionId });
    expect(next.rootDir).toBeNull();
    sessions.applySnapshotUpsert({ id: sessionId, workDir: current.rootDir }, agentId);
    await creationsStore.selectGalaxyAgent(agentId);
    mockWorkbenchFiles(chatStore);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const page = render(CosmosPage, { stubs: {
      CosmosQuickComposer: true, CosmosGalaxyOverlay: true, SettingsPanel: true,
      AgentSettingsPanel: true, SessionSettingsModal: true, MessageList: true, ChatInput: true, Teleport: true,
    } });
    page.vm.currentBand = 'galaxy';
    await Vue.nextTick();
    await page.vm.openGalaxyCreation({ agentId, creationId: current.id, sessionId, rootDir: current.rootDir });
    await flushPromises();
    const tab = page.getComponent(CreationTab);
    expect(tab.vm.activeCreation.id).toBe(current.id);
    expect(creationsStore.listDirtyDocDrafts(agentId)).toEqual([]);

    const gate = deferred();
    const ensure = vi.spyOn(creationsStore, 'ensureWorkspace').mockImplementation(async () => {
      await gate.promise;
      throw new Error('Agent rejected the workspace');
    });
    const wait = vi.spyOn(creationsStore, 'waitForCreationActivation');
    const sendPrompt = vi.spyOn(chatStore, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    expect(creationsStore.creationsForAgent(agentId)).toContainEqual(expect.objectContaining({ id: next.id, rootDir: null }));
    const hint = entry === 'workspace event' ? null : '/hint/path';
    const prompt = 'Plan the next atlas';
    let opening;
    if (entry === 'direct Galaxy open') {
      opening = page.vm.openGalaxyCreation({ agentId, sessionId, creationId: next.id, rootDir: hint, promptToSend: prompt });
    } else {
      const openSeq = creationsStore.cancelPendingWorkspaceOpen();
      const detail = { agentId, sessionId, creationId: next.id, rootDir: hint, initialPrompt: prompt, openSeq,
        ...(hint ? { hasRecordedRoot: true } : {}) };
      fireWindowEvent('cosmos-open-creation-workspace', detail);
      expect(detail.handled).toBe(true);
    }
    await flushPromises();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(agentId, next.id, hint ? { rootDir: hint } : {});
    expect(wait).toHaveBeenCalledExactlyOnceWith(creationsStore.openWorkspaceSeq, expect.objectContaining({ agentId, sessionId }));
    expect(sendPrompt).not.toHaveBeenCalled();

    gate.resolve();
    expect(await wait.mock.results[0].value).toBe(false);
    await opening;
    await flushPromises();
    expect(tab.get('.creation-wb-target-error').text()).toContain('Agent rejected the workspace');
    expect(tab.vm.activeCreation.id).toBe(current.id);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('R5-F4: cancels a stale Cosmos activation and does not send its prompt after a same-Session workDir change', async () => {
    const { sessions } = await registerBrowserStores();
    const [{ default: CosmosPage }, { default: CreationTab }] = await Promise.all([
      import('../../web/components/cosmos/CosmosPage.js'), import('../../web/components/workbench/CreationTab.js'),
    ]);
    const { agentId, sessionId } = route;
    chatStore.agents = [{ id: agentId, online: true, capabilities: ['creations', 'file_editor', 'creation_workbench_files', 'workbench_session_routes'] }];
    Object.assign(chatStore, { uiMode: 'cosmos', currentAgent: agentId, currentView: 'yeaft',
      yeaftActiveSessionFilter: sessionId, workbenchRouteProtocolSupported: true });
    const current = serviceA.store.createCreation({ title: 'Current', initializeFolder: true, sessionId });
    sessions.applySnapshotUpsert({ id: sessionId, workDir: current.rootDir }, agentId);
    await creationsStore.selectGalaxyAgent(agentId);
    const path = `${current.rootDir}/README.md`;
    mockWorkbenchFiles(chatStore, { [current.rootDir]: [{ name: 'README.md', type: 'file' }] }, { [path]: 'On disk' });
    vi.spyOn(globalThis, 'requestAnimationFrame').mockReturnValue(1);
    const page = render(CosmosPage, { stubs: {
      CosmosQuickComposer: true, CosmosGalaxyOverlay: true, SettingsPanel: true,
      AgentSettingsPanel: true, SessionSettingsModal: true, MessageList: true, ChatInput: true, Teleport: true,
    } });
    page.vm.currentBand = 'galaxy';
    await Vue.nextTick();
    await page.vm.openGalaxyCreation({ agentId, creationId: current.id, sessionId, rootDir: current.rootDir });
    await flushPromises();
    const tab = page.getComponent(CreationTab);
    const generation = tab.props('workspaceGeneration');
    creationsStore.getOrCreateDocDraft(agentId, current.rootDir, path).isDirty = true;

    const next = { id: 'next-atlas', rootDir: `${current.rootDir}-next`, sessionId };
    const pending = deferred();
    const ensure = vi.spyOn(creationsStore, 'ensureWorkspace').mockReturnValue(pending.promise);
    const wait = vi.spyOn(creationsStore, 'waitForCreationActivation');
    const cancelStale = vi.spyOn(creationsStore, 'cancelStaleGenerationActivations');
    const sendPrompt = vi.spyOn(chatStore, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const opening = page.vm.openGalaxyCreation({ agentId, creationId: next.id, sessionId, rootDir: next.rootDir, promptToSend: 'Plan the next atlas' });
    await flushPromises();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(agentId, next.id, { rootDir: next.rootDir });
    expect(wait).toHaveBeenCalledExactlyOnceWith(expect.any(Number), { agentId, sessionId, workspaceGeneration: generation });
    const [[openSeq]] = wait.mock.calls;
    const settled = vi.fn();
    void wait.mock.results[0].value.then(settled);
    expect(settled).not.toHaveBeenCalled();
    const workDir = `${current.rootDir}-changed`;
    sessions.applySnapshotUpsert({ id: sessionId, workDir }, agentId);
    await flushPromises();
    expect(chatStore.yeaftActiveSessionFilter).toBe(sessionId);
    expect(cancelStale).toHaveBeenCalledWith(routeKey, workbenchWorkspaceGeneration(routeKey, workDir));
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
    expect(creationsStore.openWorkspaceSeq).toBeGreaterThan(openSeq);
    pending.resolve({ creation: next, rootDir: next.rootDir });
    await opening;
    await flushPromises();
    expect(sendPrompt).not.toHaveBeenCalled();
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
const routeProps = { ...route, routeKey, workDir: rootDir, conversationId: `_workbench:${routeKey}`, workspaceGeneration: workbenchWorkspaceGeneration(routeKey, rootDir) };
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

function render(component, { props, stubs, attachTo, translate = t } = {}) {
  return mount(component, { props, attachTo, global: { mocks: { $t: translate }, provide: { t: translate }, stubs } });
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

function expectBinaryCanvas(canvas) {
  expect(canvas.get('.canvas-binary-notice').text()).toContain(t('files.binaryFile'));
  expect(canvas.find('.canvas-toolbar').exists()).toBe(false);
  expect(canvas.find('textarea').exists()).toBe(false);
  expect(canvas.find('.canvas-save-btn').exists()).toBe(false);
}

async function expectBinaryDraftConflict(canvas, text) {
  expect(canvas.get('.creation-wb-banner[role="alert"]').text()).toMatch(/now binary.*draft text is preserved|已变为二进制文件.*草稿已保留/i);
  expect(canvas.get('.canvas-save-btn').element.disabled).toBe(true);
  if (!canvas.find('textarea').exists()) await button(canvas, t('creation.canvas.edit')).trigger('click');
  expect(canvas.get('textarea').element.value).toBe(text);
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

  it('neutralizes Canvas references even when an @ is adjacent to a slash, punctuation or Unicode', () => {
    const prefix = context.formatCanvasContextPrefix([{
      kind: 'doc', filePath: 'notes/@editor.md', snippet: '(@reviewer) 中文@writer',
    }]);
    expect(prefix).toContain('notes/@\u200Beditor.md');
    expect(prefix).toContain('(@\u200Breviewer) 中文@\u200Bwriter');
    expect(parseMentions(prefix)).toEqual([]);
    expect(parseMentions(`${prefix}\n\nAsk @alice and @bob`)).toEqual(['alice', 'bob']);
  });

  it('strips network-path attributes in the sanitizer and in rendered Canvas Markdown', async () => {
    const { sanitizeCreationHtml, isSafeSameOriginPreviewUrl } = await import('../../web/components/cosmos/creations/sanitize.js');
    const urls = [String.raw`/\evil.example/x`, String.raw`\/evil.example/x`, String.raw`\\evil.example\x`];
    const markup = urls.map(url => `<a href="${url}">Link</a><img src="${url}" alt="Image">`).join('')
      + '<a href="https://example.test/safe">Safe</a>';
    const file = { name: 'README.md', path: `${rootDir}/README.md`, content: markup };
    const wrapper = render(FileCanvasView, { props: { routeKey, file } });
    const assertAttributes = query => {
      const links = query('a');
      const images = query('img');
      expect(links.map(node => node.getAttribute('href'))).toEqual([null, null, null, 'https://example.test/safe']);
      expect(images.map(node => node.getAttribute('src'))).toEqual([null, null, null]);
    };
    const sanitized = new DOMParser().parseFromString(sanitizeCreationHtml(markup), 'text/html');
    assertAttributes(tag => [...sanitized.body.querySelectorAll(tag)]);
    const canvas = wrapper.get('.canvas-doc-content');
    assertAttributes(tag => canvas.findAll(tag).map(node => node.element));
    for (const url of [...urls, 'https://evil.example/api/preview/1', 'javascript:void(0)']) {
      expect(isSafeSameOriginPreviewUrl(url), url).toBe(false);
    }
    expect(isSafeSameOriginPreviewUrl('/api/preview/local')).toBe(true);

    // Encoded separators survive the HTML pass; Canvas must reject them when resolving workspace paths.
    const reference = '%2F%5Cevil.example/x';
    const relativeFile = { ...file, content: `<a href="${reference}">Link</a><img src="${reference}" alt="Image"> <img src="./cover.png">` };
    for (const url of ['https://evil.example/api/preview/1', 'javascript:void(0)', '/api/preview/local']) {
      const resolveMediaUrl = vi.fn(() => url);
      await wrapper.setProps({ file: relativeFile, resolveMediaUrl });
      expect(canvas.get('a').element.hasAttribute('href')).toBe(false);
      expect(canvas.get('img[alt="Image"]').element.hasAttribute('src')).toBe(false);
      expect(resolveMediaUrl).toHaveBeenCalledExactlyOnceWith(`${rootDir}/cover.png`);
      expect(canvas.find('img[src]').exists()).toBe(url === '/api/preview/local');
    }
  });

  it.each([
    [String.raw`/repo/team\docs/README.md`, 'notes.md', String.raw`/repo/team\docs/notes.md`],
    ['repo/README.md', 'chapter%5Cdraft.md', String.raw`repo/chapter\draft.md`],
    [String.raw`\\host\share\docs\README.md`, 'chapter%5Cdraft.md', '//host/share/docs/chapter/draft.md'],
    ['//host/share/docs/README.md', 'notes.md', '//host/share/docs/notes.md'],
    ['//host/share/docs/../docs/README.md', '../../../notes.md', '//host/share/notes.md'],
    [String.raw`C:\docs\README.md`, '../../notes.md', 'C:/notes.md'],
    ['C:/docs/README.md', 'chapter%5Cdraft.md', 'C:/docs/chapter/draft.md'],
  ])('R7-F3: resolves Canvas links from %s with target %s', async (path, href, targetPath) => {
    const file = { name: 'README.md', path, content: `[Notes](${href})` };
    const wrapper = render(FileCanvasView, { props: { routeKey, file } });
    await wrapper.get('.canvas-doc-content a').trigger('click');
    expect(wrapper.emitted('open-relative-link')).toEqual([[expect.objectContaining({ targetPath })]]);
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
    chat.agents = [{ id: route.agentId, online: true, capabilities: ['creations', 'file_editor', 'creation_workbench_files', 'workbench_session_routes'] }];
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
    expect(wrapper.get(`[aria-label="${t('files.openFolderInCreation')}"]`).exists()).toBe(true);
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
      // The Creation API alone does not advertise managed-root file access.
      chat.agents = [{ id: route.agentId, online: true, capabilities: ['file_editor', 'creations'] }];
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

  it('refuses a Creation Workbench open when the Agent only offers Files and the Creation API', async () => {
    const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
    chat.agents[0].capabilities = ['file_editor', 'creations'];
    const wrapper = render(WorkbenchPanel, { props: { ownerRoute: route, ownerWorkDir: rootDir } });
    expect(wrapper.get('[data-workbench-capability="creation"]').classes()).toContain('unavailable');
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

  it.each([
    ['cross-Agent', 'agent-b', route.sessionId],
    ['cross-Session', route.agentId, 'session-b'],
  ])('routes a promptless %s modal result without scanning it in the old CreationTab', async (_kind, agentId, sessionId) => {
    const { default: CreationCreateModal } = await import('../../web/components/workbench/CreationCreateModal.js');
    const { sessions } = await registerBrowserStores();
    if (agentId !== route.agentId) chat.agents.push({ id: agentId, online: true, capabilities: ['creations'] });
    const creation = { id: 'destination', agentId, sessionId, rootDir: '/workspace/destination' };
    creations.byAgent[agentId] = { loaded: true, list: [creation] };
    sessions.applySnapshotUpsert({ id: sessionId, workDir: creation.rootDir }, agentId);
    const send = mockWorkbenchFiles(chat, {}, {}, () => true);
    const wrapper = render(CreationTab, { props: { ...routeProps, workDir: '' } });
    await flushPromises();
    wrapper.getComponent(CreationCreateModal).vm.$emit('created', { agentId, sessionId, creation, prompt: '' });
    await flushPromises();
    expect(chat.currentAgent).toBe(agentId);
    expect(sessions.sessions[sessions.activeSessionKey]).toMatchObject({ agentId, id: sessionId });
    expect(chat.workbenchExpanded).toBe(true);
    expect(creations.pendingWorkbenchTarget).toMatchObject({ agentId, sessionId, creationId: creation.id, rootDir: creation.rootDir });
    expect(wrapper.vm.activeCreation).toBeFalsy();
    expect(send.mock.calls.filter(([msg]) => ['list_directory', 'yeaft_session_send'].includes(msg.type))).toEqual([]);
  });

  it('drops a late upload file read after switching Creations', async () => {
    const next = { id: 'next', rootDir: '/workspace/next' };
    creations.byAgent[route.agentId].list = [{ id: 'first', rootDir, sessionId: route.sessionId }, next];
    let finishRead;
    vi.stubGlobal('FileReader', class {
      readAsArrayBuffer() {
        finishRead = () => {
          this.result = new Uint8Array([1]).buffer;
          this.onload();
        };
      }
    });
    const send = mockWorkbenchFiles(chat, {}, {}, request => {
      if (request.type === 'create_file') return { type: 'file_created', success: true };
      if (request.type === 'upload_to_dir') return { type: 'files_uploaded', success: true };
    });
    const wrapper = render(CreationTab, { props: routeProps });
    await flushPromises();
    expect(wrapper.vm.activeCreation.id).toBe('first');
    const input = wrapper.get('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [new File(['image'], 'cover.png')] });
    await input.trigger('change');
    expect(finishRead).toBeTypeOf('function');
    expect(wrapper.vm.uploading).toBe(true);
    fireWindowEvent('workbench-creation-target', { routeKey, creationId: next.id });
    await flushPromises();
    expect(wrapper.vm.activeCreation.id).toBe(next.id);
    finishRead();
    await flushPromises();
    expect(send.mock.calls.filter(([msg]) => ['create_file', 'upload_to_dir'].includes(msg.type))).toEqual([]);
    expect(wrapper.vm.uploading).toBe(false);
  });

  it.each(['bound', 'denied', 'missing root'])('opens an unregistered Files folder only after its binding is %s', async outcome => {
    const folder = '/workspace/imported';
    const creation = { id: 'durable-binding', title: 'Imported', rootDir: folder };
    vi.spyOn(creations, 'findByFolder').mockResolvedValue(null);
    const pending = deferred();
    const bind = vi.spyOn(creations, 'bindFolderAsCreation').mockReturnValue(pending.promise);
    const send = mockWorkbenchFiles(chat);
    const wrapper = render(CreationTab, { props: { ...routeProps, workDir: '' } });
    const scans = () => send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'list_directory');
    fireWindowEvent('workbench-creation-target', { routeKey, rootDir: folder });
    await flushPromises();
    expect(bind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ agentId: route.agentId, sessionId: route.sessionId, rootDir: folder }));
    expect(scans()).toEqual([]);
    if (outcome === 'denied') {
      pending.resolve(Promise.reject(new Error('Folder binding denied')));
      await flushPromises();
      expect(wrapper.get('.creation-wb-target-error').text()).toContain('Folder binding denied');
      expect(wrapper.vm.activeRootDir).toBe('');
      expect(scans()).toEqual([]);
    } else if (outcome === 'missing root') {
      pending.resolve({ creation: { ...creation, rootDir: null }, rootDir: folder });
      await flushPromises();
      expect(wrapper.get('.creation-wb-target-error').text()).toContain(t('creation.workbench.bindFailed'));
      expect(wrapper.vm.activeRootDir).toBe('');
      expect(scans()).toEqual([]);
    } else {
      pending.resolve({ creation });
      await flushPromises();
      expect(wrapper.vm.activeCreation).toMatchObject(creation);
      expect(scans()).toEqual([expect.objectContaining({ creationId: creation.id, dirPath: folder })]);
    }
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

  it('R2-F1: shares one live draft and save state across two Sessions on the same Creation', async () => {
    const path = `${rootDir}/README.md`;
    creations.byAgent[route.agentId].list = [{ id: 'atlas', rootDir, sessionId: route.sessionId }];
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, { [path]: '# On disk' });
    const first = render(CreationTab, { props: routeProps });
    const second = render(CreationTab, { props: { ...routeProps, sessionId: 'session-b', routeKey: 'yeaft:agent-a:session-b',
      conversationId: '_workbench:yeaft:agent-a:session-b', workspaceGeneration: 'atlas-b-generation' } });
    await flushPromises();
    const a = first.getComponent(FileCanvasView);
    const b = second.getComponent(FileCanvasView);
    const draft = creations.getDocDraft(route.agentId, rootDir, path);
    expect(a.props('file')).toBe(draft);
    expect(b.props('file')).toBe(draft);
    await button(a, t('creation.canvas.edit')).trigger('click');
    await a.get('textarea').setValue('# A draft');
    await button(b, t('creation.canvas.edit')).trigger('click');
    expect(b.get('textarea').element.value).toBe('# A draft');
    await b.get('textarea').setValue('# Newer B draft');
    expect(a.get('textarea').element.value).toBe('# Newer B draft');
    expect(a.get('.canvas-save-btn').element.disabled).toBe(false);
    await b.get('.canvas-save-btn').trigger('click');
    await flushPromises();
    expect(draft).toMatchObject({ savedContent: '# Newer B draft', isDirty: false });
    expect(a.get('textarea').element.value).toBe('# Newer B draft');
    expect(a.find('.canvas-save-btn').exists()).toBe(false);
    await first.trigger('keydown', { key: 's', ctrlKey: true });
    expect(send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'write_file')).toEqual([
      expect.objectContaining({ filePath: path, content: '# Newer B draft', workbenchRoute: { ...route, sessionId: 'session-b' } }),
    ]);
  });

  it.each(['open the switcher', 'choose a card'])('R2-F2: fences a slow Sidebar open when users %s', async action => {
    const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
    const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: route.sessionId, workDir: rootDir }, route.agentId);
    sessions.setActive(route.sessionId, route.agentId);
    const first = { id: 'first', title: 'Current Creation', rootDir, sessionId: route.sessionId };
    const slow = { ...first, id: 'slow', title: 'Slow Sidebar Creation', rootDir: `${rootDir}-slow` };
    const next = { ...first, id: 'next', title: 'New Workbench Selection', rootDir: `${rootDir}-next` };
    creations.byAgent[route.agentId].list = [first, slow, next];
    const send = mockWorkbenchFiles(chat);
    const sidebar = render(YeaftSidebar, { stubs: { Teleport: true } });
    const panel = render(WorkbenchPanel, { props: { ownerRoute: route, ownerWorkDir: rootDir } });
    fireWindowEvent('workbench-open-creation', { routeKey, creationId: first.id, rootDir });
    await flushPromises();
    const tab = panel.getComponent(CreationTab);
    expect(tab.vm.activeCreation.id).toBe(first.id);
    const showSwitcher = () => tab.get(`[aria-label="${t('creation.workbench.switchCreation')}"]`).trigger('click');
    if (action === 'choose a card') await showSwitcher();
    const pending = deferred();
    const resolveSession = vi.spyOn(creations, 'resolveCreationSession').mockReturnValueOnce(pending.promise);
    const opening = sidebar.vm.onOpenSidebarCreation({ agentId: route.agentId, creation: slow });
    expect(resolveSession).toHaveBeenCalledExactlyOnceWith(route.agentId, slow, { createIfMissing: true });
    if (action === 'open the switcher') {
      await showSwitcher();
      pending.resolve({ creation: slow, sessionId: route.sessionId, rootDir: slow.rootDir });
      await opening;
      await flushPromises();
      expect(tab.find('.creation-wb-existing-list').exists()).toBe(true);
    }
    await tab.get(`.creation-wb-existing-card:has([title="${next.rootDir}"])`).trigger('click');
    await flushPromises();
    expect(tab.vm.activeCreation.id).toBe(next.id);
    if (action === 'choose a card') {
      pending.resolve({ creation: slow, sessionId: route.sessionId, rootDir: slow.rootDir });
      await opening;
      await flushPromises();
    }
    expect(chat.yeaftActiveSessionFilter).toBe(route.sessionId);
    expect(panel.getComponent(CreationTab).vm.activeCreation.id).toBe(next.id);
    expect(creations.pendingWorkbenchTarget).toBeNull();
    expect(send.mock.calls.some(([msg]) => msg.type === 'list_directory' && msg.dirPath === slow.rootDir)).toBe(false);
  });

  it('R2-F4a: does not send the same-Session modal prompt when the user keeps a dirty document', async () => {
    const { default: CreationCreateModal } = await import('../../web/components/workbench/CreationCreateModal.js');
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: route.sessionId, workDir: rootDir }, route.agentId);
    creations.byAgent[route.agentId].list = [{ id: 'atlas', rootDir, sessionId: route.sessionId }];
    const path = `${rootDir}/README.md`;
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, { [path]: '# On disk' });
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    const sendPrompt = vi.spyOn(chat, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const tab = render(CreationTab, { props: routeProps });
    await flushPromises();
    const canvas = tab.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('# Keep this draft');
    await tab.get(`[aria-label="${t('creation.workbench.switchCreation')}"]`).trigger('click');
    await tab.get('.creation-wb-action-card').trigger('click');
    const next = { id: 'new-atlas', rootDir: `${rootDir}-new`, sessionId: route.sessionId };
    tab.getComponent(CreationCreateModal).vm.$emit('created', {
      agentId: route.agentId, sessionId: route.sessionId, rootDir: next.rootDir, creation: next, prompt: 'Plan the new atlas',
    });
    await flushPromises();
    expect(confirm).toHaveBeenCalledExactlyOnceWith(t('creation.workbench.unsavedSwitchConfirm'));
    expect(tab.vm.activeCreation.id).toBe('atlas');
    expect(creations.getDocDraft(route.agentId, rootDir, path)).toMatchObject({ content: '# Keep this draft', isDirty: true });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([msg]) => msg.type === 'list_directory' && msg.dirPath === next.rootDir)).toBe(false);
  });

  it('R6-F1: matches and uses the Agent-recorded POSIX backslash path without rewriting it', async () => {
    const workspace = String.raw`/repo/team\docs`;
    const path = `${workspace}/README.md`;
    creations.byAgent[route.agentId].list = [
      { id: 'slash', rootDir: '/repo/team/docs' }, { id: 'literal', rootDir: workspace },
    ];
    vi.spyOn(creations, 'findByFolder').mockResolvedValue(null);
    const send = mockWorkbenchFiles(chat, { [workspace]: [{ name: 'README.md', type: 'file' }] }, { [path]: 'On disk' });
    const tab = render(CreationTab, { props: { ...routeProps, workDir: workspace } });
    await flushPromises();
    expect(tab.vm.activeCreation.id).toBe('literal');
    expect(tab.vm.activeRootDir).toBe(workspace);
    expect(send.mock.calls.map(([msg]) => msg)).toEqual([
      expect.objectContaining({ type: 'list_directory', dirPath: workspace, workDir: workspace }),
      expect.objectContaining({ type: 'read_file', filePath: path, workDir: workspace }),
    ]);
    expect(tab.vm.activeDocFile.content).toBe('On disk');
    tab.vm.onDocContentUpdate('Revised');
    await tab.vm.saveDoc();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'write_file', filePath: path, workDir: workspace }));
  });

  it.each(['recorded', 'rejected', 'missing'])('R6-F2: explicit target waits for the Agent-recorded root (%s)', async outcome => {
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: route.sessionId, workDir: rootDir }, route.agentId);
    const requestedRoot = `${rootDir}/requested`;
    const recordedRoot = `${rootDir}/recorded`;
    const current = { id: 'atlas', rootDir, sessionId: route.sessionId };
    const pending = { id: 'pending', rootDir: null };
    creations.byAgent[route.agentId].list = [current, pending];
    const send = mockWorkbenchFiles(chat);
    const sendPrompt = vi.spyOn(chat, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const tab = render(CreationTab, { props: routeProps });
    await flushPromises();
    const scans = () => send.mock.calls.filter(([msg]) => msg.type === 'list_directory').map(([msg]) => msg.dirPath);
    const gate = deferred();
    const ensure = vi.spyOn(creations, 'ensureWorkspace').mockImplementation(async () => {
      await gate.promise;
      if (outcome === 'rejected') throw new Error('Agent rejected the workspace');
      const creation = outcome === 'recorded' ? { ...pending, rootDir: recordedRoot } : pending;
      creations._upsertSummary(route.agentId, creation);
      return { creation, rootDir: creation.rootDir };
    });
    const receipt = vi.spyOn(creations, 'resolveCreationActivation');
    const opening = creations.openCreationWorkspace({ ...route, creationId: pending.id, rootDir: requestedRoot,
      initialPrompt: 'Plan the next atlas', uiMode: 'classic' });
    await flushPromises();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(route.agentId, pending.id, { rootDir: requestedRoot });
    expect(receipt).not.toHaveBeenCalled();
    expect(scans()).toEqual([rootDir]);
    expect(sendPrompt).not.toHaveBeenCalled();

    gate.resolve();
    await opening;
    await flushPromises();
    const accepted = outcome === 'recorded';
    expect(receipt).toHaveBeenCalledExactlyOnceWith(expect.any(Number), accepted,
      { workspaceGeneration: routeProps.workspaceGeneration });
    expect(scans()).toEqual(accepted ? [rootDir, recordedRoot] : [rootDir]);
    expect(tab.vm.activeRootDir).toBe(accepted ? recordedRoot : rootDir);
    expect(confirm).not.toHaveBeenCalled();
    if (accepted) {
      expect(sendPrompt).toHaveBeenCalledExactlyOnceWith({ groupId: route.sessionId, text: 'Plan the next atlas' });
    } else {
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(tab.get('.creation-wb-target-error').text()).toContain(outcome === 'rejected'
        ? 'Agent rejected the workspace' : t('creation.workbench.missingRootDir'));
    }
  });

  it.each([false, true])('R7-F2: Classic first mount waits for the destination receipt (accepted: %s)', async accepted => {
    const { sessions } = await registerBrowserStores();
    const { default: WorkbenchPanel } = await import('../../web/components/WorkbenchPanel.js');
    sessions.applySnapshotUpsert({ id: route.sessionId, workDir: rootDir }, route.agentId);
    const creation = { id: 'unrecorded', rootDir: null, sessionId: route.sessionId };
    creations.byAgent[route.agentId].list = [creation];
    mockWorkbenchFiles(chat);
    const gate = deferred();
    const ensure = vi.spyOn(creations, 'ensureWorkspace')
      .mockResolvedValueOnce({ creation, rootDir: null }) // Session resolution leaves the workspace unrecorded.
      .mockImplementation(async () => {
        await gate.promise;
        if (!accepted) throw new Error('Agent rejected the workspace');
        return { creation: { ...creation, rootDir }, rootDir };
      });
    const wait = vi.spyOn(creations, 'waitForCreationActivation');
    const sendPrompt = vi.spyOn(chat, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const panel = render(WorkbenchPanel);
    expect(panel.findComponent(CreationTab).exists()).toBe(false);
    expect(creations.hasMountedCreationTab(route.agentId, route.sessionId)).toBe(false);
    expect(creations.listDirtyDocDrafts(route.agentId)).toEqual([]);

    const opening = creations.openCreationWorkspace({ ...route, creationId: creation.id,
      initialPrompt: 'Plan the next atlas', uiMode: 'classic' });
    await flushPromises();
    const tab = panel.getComponent(CreationTab);
    expect(ensure.mock.calls).toEqual([[route.agentId, creation.id], [route.agentId, creation.id, {}]]);
    expect(wait).toHaveBeenCalledTimes(1);
    const settled = vi.fn();
    void wait.mock.results[0].value.then(settled);
    await Vue.nextTick();
    expect(settled).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();

    gate.resolve();
    await opening;
    expect(settled).toHaveBeenCalledExactlyOnceWith(accepted);
    if (accepted) {
      expect(sendPrompt).toHaveBeenCalledExactlyOnceWith({ groupId: route.sessionId, text: 'Plan the next atlas' });
    } else {
      expect(tab.get('.creation-wb-target-error').text()).toContain('Agent rejected the workspace');
      expect(sendPrompt).not.toHaveBeenCalled();
    }
  });

  it('R3-F3: gates a Classic Sidebar prompt on the mounted CreationTab activation receipt', async () => {
    const { default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js');
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: route.sessionId, workDir: rootDir }, route.agentId);
    const current = { id: 'atlas', rootDir, sessionId: route.sessionId };
    const next = { id: 'next', rootDir: `${rootDir}-next`, sessionId: route.sessionId };
    creations.byAgent[route.agentId].list = [current];
    const path = `${rootDir}/README.md`;
    mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, { [path]: '# On disk' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({}) }));
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('confirm', confirm);
    const sendPrompt = vi.spyOn(chat, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const receipt = vi.spyOn(creations, 'resolveCreationActivation');
    const tab = render(CreationTab, { props: routeProps });
    const sidebar = render(YeaftSidebar);
    await flushPromises();
    const canvas = tab.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('# Keep this draft');

    const prepare = vi.spyOn(creations, 'ensureWorkspace');
    for (const accepted of [false, true]) {
      const pending = deferred();
      prepare.mockReturnValueOnce(pending.promise);
      const opening = sidebar.vm.onCreationCreated({ ...route, creation: next, prompt: 'Plan the next atlas' });
      await flushPromises();
      expect(prepare).toHaveBeenLastCalledWith(route.agentId, next.id, { rootDir: next.rootDir });
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(tab.vm.activeCreation.id).toBe(current.id);
      pending.resolve({ creation: next, rootDir: next.rootDir });
      await opening;
      expect(receipt).toHaveBeenLastCalledWith(expect.any(Number), accepted, { workspaceGeneration: routeProps.workspaceGeneration });
      expect(tab.vm.activeCreation.id).toBe(accepted ? next.id : current.id);
      if (!accepted) expect(sendPrompt).not.toHaveBeenCalled();
    }
    expect(confirm.mock.calls).toEqual(Array.from({ length: 2 }, () => [t('creation.workbench.unsavedSwitchConfirm')]));
    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith({ groupId: route.sessionId, text: 'Plan the next atlas' });
    expect(creations.getDocDraft(route.agentId, rootDir, path)).toMatchObject({ content: '# Keep this draft', isDirty: true });
  });

  it.each(['accept', 'unmount', 'cancel', 'clear'])('R4-F3: settles a slow dirty activation on %s, not on elapsed time', async outcome => {
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: route.sessionId, workDir: rootDir }, route.agentId);
    const current = { id: 'atlas', rootDir, sessionId: route.sessionId };
    const next = { id: 'slow', rootDir: `${rootDir}-slow`, sessionId: route.sessionId };
    creations.byAgent[route.agentId].list = [current];
    const path = `${rootDir}/README.md`;
    mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, { [path]: 'On disk' });
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const sendPrompt = vi.spyOn(chat, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const tab = render(CreationTab, { props: routeProps });
    await flushPromises();
    const canvas = tab.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('Unsaved');

    const pending = deferred();
    const prepare = vi.spyOn(creations, 'ensureWorkspace').mockReturnValue(pending.promise);
    const wait = vi.spyOn(creations, 'waitForCreationActivation');
    vi.useFakeTimers();
    try {
      const opening = creations.openCreationWorkspace(route.agentId, next, {
        rootDir: next.rootDir, sessionId: next.sessionId, initialPrompt: 'Plan the next atlas', uiMode: 'classic',
      });
      await Vue.nextTick();
      expect(prepare).toHaveBeenCalledExactlyOnceWith(route.agentId, next.id, { rootDir: next.rootDir });
      const activation = wait.mock.results[0].value;
      const settled = vi.fn();
      void activation.then(settled);
      await vi.advanceTimersByTimeAsync(5_500);
      expect(settled).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();

      if (outcome === 'unmount') tab.unmount();
      if (outcome === 'cancel') creations.cancelPendingWorkspaceOpen();
      if (outcome === 'clear') creations.clearAll();
      if (outcome === 'accept') pending.resolve({ creation: next, rootDir: next.rootDir });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toHaveBeenCalledExactlyOnceWith(outcome === 'accept');
      await opening;
      if (outcome === 'accept') {
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(sendPrompt).toHaveBeenCalledExactlyOnceWith({ groupId: next.sessionId, text: 'Plan the next atlas' });
      } else {
        pending.resolve({ creation: next, rootDir: next.rootDir });
        await vi.advanceTimersByTimeAsync(0);
        expect(confirm).not.toHaveBeenCalled();
        expect(sendPrompt).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('R4-F3: unregister settles only when the last tab for the waiting route is gone', async () => {
    creations.registerCreationTabRoute(routeKey, route);
    creations.registerCreationTabRoute('other-mounted-tab', route);
    const other = { ...route, sessionId: 'other-session' };
    creations.registerCreationTabRoute('unrelated-tab', other);
    const activation = creations.waitForCreationActivation(creations.cancelPendingWorkspaceOpen(), route);
    const settled = vi.fn();
    void activation.then(settled);
    creations.unregisterCreationTabRoute('unrelated-tab');
    creations.unregisterCreationTabRoute(routeKey);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    creations.unregisterCreationTabRoute('other-mounted-tab');
    await Promise.resolve();
    expect(settled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('R3-F4: a direct Files open cancels a pending Classic Sidebar open on the same route', async () => {
    const [{ default: YeaftSidebar }, { default: WorkbenchPanel }] = await Promise.all([
      import('../../web/components/YeaftSidebar.js'), import('../../web/components/WorkbenchPanel.js'),
    ]);
    const { sessions } = await registerBrowserStores();
    sessions.applySnapshotUpsert({ id: route.sessionId, workDir: rootDir }, route.agentId);
    const slow = { id: 'slow', title: 'Slow Sidebar', rootDir: `${rootDir}/slow`, sessionId: route.sessionId };
    const files = { id: 'files', title: 'Newer Files folder', rootDir: `${rootDir}/files` };
    creations.byAgent[route.agentId].list = [slow, files];
    const send = mockWorkbenchFiles(chat);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({}) }));
    const pending = deferred();
    const resolve = vi.spyOn(creations, 'resolveCreationSession').mockReturnValueOnce(pending.promise);
    const open = vi.spyOn(creations, 'openCreationWorkspace');
    const sidebar = render(YeaftSidebar);
    const panel = render(WorkbenchPanel, { props: { ownerRoute: route, ownerWorkDir: rootDir } });
    await sidebar.get('.sidebar-creations-toggle').trigger('click');
    await sidebar.get('.sidebar-creations-item[title="Slow Sidebar"]').trigger('click');
    expect(resolve).toHaveBeenCalledExactlyOnceWith(route.agentId, slow, { createIfMissing: true });
    const detail = { routeKey, rootDir: files.rootDir };
    fireWindowEvent('workbench-open-creation', detail);
    await flushPromises();
    expect(detail.accepted).toBe(true);
    expect(panel.getComponent(CreationTab).vm.activeCreation.id).toBe(files.id);

    pending.resolve({ creation: slow, sessionId: slow.sessionId, rootDir: slow.rootDir });
    await expect(open.mock.results[0].value).resolves.toBeNull();
    await flushPromises();
    expect(creations.pendingWorkbenchTarget).toBeNull();
    expect(panel.getComponent(CreationTab).vm.activeCreation.id).toBe(files.id);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'list_directory', dirPath: slow.rootDir }));
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
    const reads = () => send.mock.calls.filter(([request]) => request.type === 'read_file').map(([request]) => request.filePath);
    await edit('# Readme draft');
    await select('docs/First.md');
    await edit('# First draft');
    await select('README.md');
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: second, content: '# Readme draft', isDirty: true });
    await select('docs/First.md');
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: first, content: '# First draft', isDirty: true });
    expect([...wrapper.vm.docDrafts.keys()].sort()).toEqual([`${rootDir}::${second}`, `${rootDir}::${first}`].sort());
    await select('README.md');
    expect(reads()).toEqual([second, first]);
    failSubdir = true;
    await wrapper.get(`[aria-label="${t('creation.workbench.refresh')}"]`).trigger('click');
    await flushPromises();
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: second, content: '# Readme draft', isDirty: true });
    await select('docs/First.md');
    expect(wrapper.vm.activeDocFile).toMatchObject({ path: first, content: '# First draft', isDirty: true });
    expect(wrapper.vm.docDrafts.get(`${rootDir}::${second}`).content).toBe('# Readme draft');
    expect(reads()).toEqual([second, first, second, first]); // Refresh starts a new probe visit.
    await select('README.md');
    await select('docs/First.md');
    expect(reads()).toEqual([second, first, second, first]);
  });

  it('restores store-owned drafts after unmount and reports dirty documents across this Agent’s Creation roots', async () => {
    const next = { id: 'next-root', rootDir: '/workspace/next-root' };
    const first = { id: 'atlas', rootDir, sessionId: route.sessionId };
    const [firstPath, nextPath] = [`${rootDir}/First.md`, `${next.rootDir}/Next.md`];
    creations.byAgent[route.agentId].list = [first, next];
    mockWorkbenchFiles(chat, {
      [rootDir]: [{ name: 'First.md', type: 'file' }], [next.rootDir]: [{ name: 'Next.md', type: 'file' }],
    }, { [firstPath]: '# First on disk', [nextPath]: '# Next on disk' });
    vi.stubGlobal('confirm', vi.fn(() => true));
    const mountTab = () => render(CreationTab, { props: routeProps });
    const edit = async (tab, text) => {
      const canvas = tab.getComponent(FileCanvasView);
      await button(canvas, t('creation.canvas.edit')).trigger('click');
      await canvas.get('textarea').setValue(text);
    };
    const tab = mountTab();
    await flushPromises();
    await edit(tab, '# First draft');
    fireWindowEvent('workbench-creation-target', { routeKey, creationId: next.id });
    await flushPromises();
    expect(tab.vm.activeCreation.id).toBe(next.id);
    await edit(tab, '# Next draft');
    tab.unmount(); // The drawer drops CreationTab when returning to Galaxy.
    expect(creations.getDocDraft(route.agentId, rootDir, firstPath)).toMatchObject({ content: '# First draft', isDirty: true });
    expect(creations.getDocDraft(route.agentId, next.rootDir, nextPath)).toMatchObject({ content: '# Next draft', isDirty: true });
    creations.setDocDraft('agent-b', rootDir, firstPath, { name: 'Other Agent.md', isDirty: true });

    const reopened = mountTab();
    await flushPromises();
    expect(reopened.getComponent(FileCanvasView).props('file')).toMatchObject({ content: '# First draft', isDirty: true });
    const check = { routeKey, agentId: route.agentId, workspaceGeneration: routeProps.workspaceGeneration, dirtyCount: 0, dirtyFiles: [] };
    fireWindowEvent('workbench-close-creation-capability', check);
    expect(check.dirtyCount).toBe(2);
    expect(check.dirtyFiles.sort()).toEqual(['First.md', 'Next.md']);
    fireWindowEvent('workbench-creation-target', { routeKey, creationId: next.id });
    await flushPromises();
    expect(reopened.getComponent(FileCanvasView).props('file')).toMatchObject({ content: '# Next draft', isDirty: true });
  });

  it.each([false, true])('handles a binary Markdown read in CreationTab (concurrent draft: %s)', async dirty => {
    const name = 'README.md';
    const path = `${rootDir}/${name}`;
    creations.byAgent[route.agentId].list = [{ id: 'atlas', rootDir, sessionId: route.sessionId }];
    let read;
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name, type: 'file' }] }, {}, request => {
      if (request.type !== 'read_file') return;
      read = request;
      return true;
    });
    const tab = render(CreationTab, { props: routeProps });
    await flushPromises();
    expect(read).toMatchObject({ filePath: path });
    // Model a newer local edit by the time the pending initial read settles.
    const draft = { content: '# Unsaved draft', savedContent: '# On disk', isDirty: true };
    if (dirty) Object.assign(tab.vm.activeDocFile, draft);
    respondWorkbench(read, { type: 'file_content', isBinary: true, content: 'not editable' });
    await flushPromises();
    const canvas = tab.getComponent(FileCanvasView);
    if (dirty) {
      expect(creations.getDocDraft(route.agentId, rootDir, path)).toMatchObject({ ...draft, diskChangedToBinary: true, isBinary: false });
      await expectBinaryDraftConflict(canvas, draft.content);
    } else {
      expectBinaryCanvas(canvas);
    }
    await tab.trigger('keydown', { key: 's', ctrlKey: true });
    expect(send.mock.calls.some(([msg]) => msg.type === 'write_file')).toBe(false);
  });

  it('R2-F7: probes a dirty Markdown draft on reopen and only saves against a verified text target', async () => {
    const name = 'README.md';
    const path = `${rootDir}/${name}`;
    creations.byAgent[route.agentId].list = [{ id: 'atlas', rootDir, sessionId: route.sessionId }];
    let disk = { content: '# Initial text', mtimeMs: 100, size: 14 };
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name, type: 'file' }] }, {}, request => {
      if (request.type === 'read_file') return { type: 'file_content', ...disk };
    });
    const reads = () => send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'read_file');
    const writes = () => send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'write_file');
    const first = render(CreationTab, { props: routeProps });
    await flushPromises();
    const original = first.getComponent(FileCanvasView);
    await button(original, t('creation.canvas.edit')).trigger('click');
    await original.get('textarea').setValue('# Unsaved draft');
    expect(reads()).toHaveLength(1);
    first.unmount(); // Back to Galaxy drops the drawer's CreationTab.
    const reopened = render(CreationTab, { props: routeProps });
    await flushPromises();
    expect(reads().map(msg => msg.filePath)).toEqual([path, path]);
    const canvas = reopened.getComponent(FileCanvasView);
    const save = canvas.get('.canvas-save-btn');
    expect(canvas.props('file')).toMatchObject({ diskChangedOnDisk: false, isDirty: true, content: '# Unsaved draft' });
    expect(save.element.disabled).toBe(false);
    await save.trigger('click');
    await flushPromises();
    expect(writes()).toEqual([expect.objectContaining({ filePath: path, content: '# Unsaved draft',
      requireTextTarget: true, expectedMtimeMs: 100, expectedSize: 14 })]);
    expect(canvas.props('file').isDirty).toBe(false);

    // Keep the fixture's disk in sync with the acknowledged write before editing again.
    disk = { content: '# Unsaved draft', mtimeMs: 100, size: 14 };
    if (!canvas.find('textarea').exists()) await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('# New draft');
    const { baseMtimeMs, baseSize } = canvas.props('file');
    disk = { content: '# Text changed on disk', mtimeMs: 300, size: 22 };
    await reopened.get(`[aria-label="${t('creation.workbench.refresh')}"]`).trigger('click');
    await flushPromises();
    expect(reads()).toHaveLength(3);
    expect(canvas.props('file')).toMatchObject({ diskChangedOnDisk: true, baseMtimeMs, baseSize,
      isDirty: true, content: '# New draft' });
    expect(save.element.disabled).toBe(true);
    expect(button(canvas, getLocale() === 'zh-CN' ? '从磁盘重新加载' : 'Reload from disk').element.disabled).toBe(false);
    await button(canvas, getLocale() === 'zh-CN' ? '覆盖磁盘文件' : 'Overwrite disk').trigger('click');
    await flushPromises();
    expect(writes()).toHaveLength(2);
    expect(writes()[1]).toMatchObject({ filePath: path, content: '# New draft', requireTextTarget: true });
    expect(writes()[1]).not.toHaveProperty('expectedMtimeMs');
    expect(writes()[1]).not.toHaveProperty('expectedSize');
    expect(canvas.props('file').isDirty).toBe(false);
  });

  it('R3-F6: the automatic refresh after an Agent turn detects a text conflict without rebasing the draft', async () => {
    const name = 'README.md';
    const path = `${rootDir}/${name}`;
    creations.byAgent[route.agentId].list = [{ id: 'atlas', rootDir, sessionId: route.sessionId }];
    let disk = { content: 'Original', mtimeMs: 100, size: 8 };
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name, type: 'file' }] }, {}, request => {
      if (request.type === 'read_file') return { type: 'file_content', ...disk };
    });
    const tab = render(CreationTab, { props: routeProps });
    await flushPromises();
    const canvas = tab.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('Unsaved draft');
    const turn = type => chat.handleYeaftOutput({ type: 'yeaft_output', agentId: route.agentId,
      event: { type, turnId: 'editing-turn', vpId: 'writer', sessionId: route.sessionId } });
    vi.useFakeTimers();
    try {
      turn('vp_turn_start');
      await Vue.nextTick();
      expect(chat.isYeaftSessionProcessing(route.sessionId, route.agentId)).toBe(true);
      disk = { content: 'Agent text', mtimeMs: 200, size: 10 };
      turn('vp_turn_end');
      await Vue.nextTick();
      expect(chat.isYeaftSessionProcessing(route.sessionId, route.agentId)).toBe(false);
      await vi.advanceTimersByTimeAsync(450);
      await flushPromises();
      expect(send.mock.calls.filter(([msg]) => msg.type === 'read_file').map(([msg]) => msg.filePath)).toEqual([path, path]);
      expect(canvas.props('file')).toMatchObject({ isDirty: true, content: 'Unsaved draft', savedContent: 'Original',
        diskChangedOnDisk: true, baseMtimeMs: 100, baseSize: 8, observedDiskMtimeMs: 200, observedDiskSize: 10 });
      expect(canvas.get('.canvas-save-btn').element.disabled).toBe(true);
      await button(canvas, getLocale() === 'zh-CN' ? '从磁盘重新加载' : 'Reload from disk').trigger('click');
      await flushPromises();
      expect(canvas.props('file')).toMatchObject({ content: 'Agent text', isDirty: false,
        diskChangedOnDisk: false, baseMtimeMs: 200, baseSize: 10 });
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'write_file' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('R3-F7: probes the second dirty document on first selection after remount and retains binary conflict on read error', async () => {
    const first = `${rootDir}/README.md`;
    const second = `${rootDir}/Second.md`;
    creations.byAgent[route.agentId].list = [{ id: 'atlas', rootDir, sessionId: route.sessionId }];
    let secondDisk = { content: 'Second on disk' };
    const send = mockWorkbenchFiles(chat, {
      [rootDir]: ['README.md', 'Second.md'].map(name => ({ name, type: 'file' })),
    }, { [first]: 'First on disk' }, msg => {
      if (msg.type === 'read_file' && msg.filePath === second) return { type: 'file_content', ...secondDisk };
    });
    const reads = () => send.mock.calls.filter(([msg]) => msg.type === 'read_file').map(([msg]) => msg.filePath);
    const selectSecond = async tab => {
      await tab.get('.creation-wb-tree-row[title="Second.md"]').trigger('click');
      await flushPromises();
    };
    const edit = async (tab, content) => {
      const canvas = tab.getComponent(FileCanvasView);
      if (!canvas.find('textarea').exists()) await button(canvas, t('creation.canvas.edit')).trigger('click');
      await canvas.get('textarea').setValue(content);
    };
    const tab = render(CreationTab, { props: routeProps });
    await flushPromises();
    await edit(tab, 'First draft');
    await selectSecond(tab);
    await edit(tab, 'Second draft');
    tab.unmount();

    secondDisk = { isBinary: true, size: 4096 };
    const reopened = render(CreationTab, { props: routeProps });
    await flushPromises();
    expect(reads()).toEqual([first, second, first]);
    expect(reopened.vm.activeDocFile).toMatchObject({ path: first, content: 'First draft', isDirty: true });
    await selectSecond(reopened);
    expect(reads()).toEqual([first, second, first, second]);
    const canvas = reopened.getComponent(FileCanvasView);
    expect(canvas.props('file')).toMatchObject({ path: second, diskChangedToBinary: true, isDirty: true });
    await expectBinaryDraftConflict(canvas, 'Second draft');

    secondDisk = { error: 'Permission denied', content: '' };
    await reopened.get(`[aria-label="${t('creation.workbench.refresh')}"]`).trigger('click');
    await flushPromises();
    expect(reads()).toEqual([first, second, first, second, second]);
    expect(canvas.props('file')).toMatchObject({ diskChangedToBinary: true, isDirty: true, content: 'Second draft' });
    await expectBinaryDraftConflict(canvas, 'Second draft');
  });

  it('R4-F4: starts a new probe visit when a cached Session’s CreationTab is reactivated', async () => {
    const first = `${rootDir}/README.md`;
    const second = `${rootDir}/Second.md`;
    const otherRoute = { ...routeProps, sessionId: 'session-b', routeKey: 'yeaft:agent-a:session-b',
      conversationId: '_workbench:yeaft:agent-a:session-b', workDir: '/workspace/other' };
    creations.byAgent[route.agentId].list = [
      { id: 'atlas', rootDir, sessionId: route.sessionId },
      { id: 'other', rootDir: otherRoute.workDir, sessionId: otherRoute.sessionId },
    ];
    let secondDisk = { content: 'Second on disk' };
    const send = mockWorkbenchFiles(chat, {
      [rootDir]: ['README.md', 'Second.md'].map(name => ({ name, type: 'file' })),
    }, { [first]: 'First on disk' }, msg => {
      if (msg.type === 'read_file' && msg.filePath === second) return { type: 'file_content', ...secondDisk };
    });
    const reads = () => send.mock.calls.filter(([msg]) => msg.type === 'read_file').map(([msg]) => msg.filePath);
    const selected = Vue.shallowRef(routeProps);
    const wrapper = render({ setup: () => () => Vue.h(Vue.KeepAlive, null, {
      default: () => Vue.h(CreationTab, { ...selected.value, key: selected.value.routeKey }),
    }) });
    const tab = () => wrapper.getComponent(CreationTab);
    const select = async name => {
      await tab().get(`.creation-wb-tree-row[title="${name}"]`).trigger('click');
      await flushPromises();
    };
    const edit = async text => {
      const canvas = tab().getComponent(FileCanvasView);
      if (!canvas.find('textarea').exists()) await button(canvas, t('creation.canvas.edit')).trigger('click');
      await canvas.get('textarea').setValue(text);
    };
    await flushPromises();
    const cached = tab().vm.$.uid;
    await edit('First draft');
    await select('Second.md');
    await edit('Second draft');
    await select('README.md');
    expect(reads()).toEqual([first, second]);

    selected.value = otherRoute;
    await flushPromises();
    expect(tab().vm.activeCreation.id).toBe('other');
    secondDisk = { isBinary: true, size: 4096 };
    selected.value = routeProps;
    await flushPromises();
    expect(tab().vm.$.uid).toBe(cached);
    expect(reads()).toEqual([first, second, first]);
    expect(tab().vm.activeDocFile).toMatchObject({ path: first, content: 'First draft', isDirty: true });
    await select('Second.md');
    expect(reads()).toEqual([first, second, first, second]);
    expect(tab().vm.activeDocFile).toMatchObject({ path: second, content: 'Second draft', isDirty: true, diskChangedToBinary: true });
  });

  it('R5-F5: queues a fresh dirty probe when KeepAlive reactivates before the old probe settles', async () => {
    const path = `${rootDir}/README.md`;
    const otherRoute = { ...routeProps, sessionId: 'session-b', routeKey: 'yeaft:agent-a:session-b',
      conversationId: '_workbench:yeaft:agent-a:session-b', workDir: '/workspace/other' };
    creations.byAgent[route.agentId].list = [
      { id: 'atlas', rootDir, sessionId: route.sessionId },
      { id: 'other', rootDir: otherRoute.workDir, sessionId: otherRoute.sessionId },
    ];
    let hold = false;
    let binary = false;
    let oldProbe;
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, {}, msg => {
      if (msg.type !== 'read_file' || msg.filePath !== path) return;
      if (hold) {
        oldProbe = msg;
        return true;
      }
      return { type: 'file_content', ...(binary ? { isBinary: true, size: 4096 } : { content: 'On disk' }) };
    });
    const reads = () => send.mock.calls.filter(([msg]) => msg.type === 'read_file' && msg.filePath === path);
    const selected = Vue.shallowRef(routeProps);
    const wrapper = render({ setup: () => () => Vue.h(Vue.KeepAlive, null, {
      default: () => Vue.h(CreationTab, { ...selected.value, key: selected.value.routeKey }),
    }) });
    await flushPromises();
    const tab = wrapper.getComponent(CreationTab);
    const uid = tab.vm.$.uid;
    const canvas = tab.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('Unsaved');
    hold = true;
    const refresh = tab.vm.refreshWorkspace();
    await flushPromises();
    expect(oldProbe).toMatchObject({ filePath: path });
    expect(tab.vm.activeDocFile.probingDisk).toBe(true);

    selected.value = otherRoute;
    await flushPromises();
    expect(wrapper.getComponent(CreationTab).vm.activeCreation.id).toBe('other');
    hold = false;
    binary = true;
    selected.value = routeProps;
    await flushPromises();
    expect(wrapper.getComponent(CreationTab).vm.$.uid).toBe(uid);
    expect(reads()).toHaveLength(2);
    expect(tab.vm.activeDocFile.diskChangedToBinary).toBe(false);

    respondWorkbench(oldProbe, { type: 'file_content', content: 'On disk' });
    await refresh;
    await flushPromises();
    expect(reads()).toHaveLength(3);
    expect(tab.vm.activeDocFile).toMatchObject({ content: 'Unsaved', isDirty: true, diskChangedToBinary: true, probingDisk: false });
  });

  it('R6-F4: a cached tab reprobes a shared dirty draft when another tab finishes its stale probe', async () => {
    const path = `${rootDir}/README.md`;
    const sessionId = 'session-b';
    const otherKey = `yeaft:${route.agentId}:${sessionId}`;
    const otherRoute = { ...routeProps, sessionId, routeKey: otherKey, conversationId: `_workbench:${otherKey}`,
      workspaceGeneration: workbenchWorkspaceGeneration(otherKey, rootDir) };
    creations.byAgent[route.agentId].list = [{ id: 'atlas', rootDir, sessionId: route.sessionId }];
    vi.spyOn(creations, 'findByFolder').mockResolvedValue(null); // Tab B uses the cached folder match.
    let heldProbe;
    let hold = false;
    let binary = false;
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name: 'README.md', type: 'file' }] }, {}, msg => {
      if (msg.type !== 'read_file') return;
      if (hold) {
        heldProbe = msg;
        return true;
      }
      return { type: 'file_content', ...(binary ? { isBinary: true, size: 4096 } : { content: 'On disk' }) };
    });
    const readSessions = () => send.mock.calls.filter(([msg]) => msg.type === 'read_file').map(([msg]) => msg.workbenchRoute.sessionId);
    const selected = Vue.shallowRef(otherRoute);
    const wrapper = render({ setup: () => () => Vue.h(Vue.KeepAlive, null, {
      default: () => Vue.h(CreationTab, { ...selected.value, key: selected.value.routeKey }),
    }) });
    const activeTab = () => wrapper.getComponent(CreationTab);
    await flushPromises();
    const tabB = activeTab().vm;
    expect(tabB.activeDocFile).toMatchObject({ path, content: 'On disk' });
    selected.value = routeProps;
    await flushPromises();
    const tabA = activeTab().vm;
    expect(tabA.$.uid).not.toBe(tabB.$.uid);
    expect(tabA.activeCreation.id).toBe(tabB.activeCreation.id);
    expect(tabA.activeDocFile).toBe(tabB.activeDocFile);
    tabA.onDocContentUpdate('Unsaved');
    const readsBeforeProbe = readSessions();
    hold = true;
    const refresh = tabA.refreshWorkspace();
    await flushPromises();
    expect(heldProbe).toMatchObject({ filePath: path, workbenchRoute: { sessionId: route.sessionId } });
    expect(tabA.activeDocFile.probingDisk).toBe(true);

    hold = false;
    binary = true;
    selected.value = otherRoute;
    await flushPromises();
    expect(activeTab().vm.$.uid).toBe(tabB.$.uid);
    expect(tabA.$.isDeactivated).toBe(true);
    expect(readSessions()).toEqual([...readsBeforeProbe, route.sessionId]);
    expect(tabB.activeDocFile.diskChangedToBinary).toBe(false);
    respondWorkbench(heldProbe, { type: 'file_content', content: 'On disk' });
    await refresh;
    await flushPromises();
    expect(readSessions()).toEqual([...readsBeforeProbe, route.sessionId, sessionId]);
    expect(tabB.activeDocFile).toMatchObject({ content: 'Unsaved', isDirty: true, diskChangedToBinary: true, probingDisk: false });
  });

  it('R2-F8: only creates download anchors for safe correlated video metadata', async () => {
    const { default: FilesTab } = await import('../../web/components/FilesTab.js');
    const name = 'clip.mp4';
    const path = `${rootDir}/${name}`;
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name, type: 'file' }] }, {}, request => {
      if (request.type === 'video_metadata') return true;
    });
    const files = render(FilesTab, { props: routeProps });
    await flushPromises();
    const create = vi.spyOn(document, 'createElement');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const download = async previewUrl => {
      await files.get(`[data-tree-path$="/${name}"]`).trigger('contextmenu');
      await button(files, t('files.download'), '.ctx-menu .ctx-menu-item').trigger('click');
      const [request] = send.mock.lastCall;
      expect(request).toMatchObject({ type: 'video_metadata', download: true, filePath: path });
      expect(request.requestId).toEqual(expect.any(String));
      respondWorkbench(request, { type: 'video_metadata', videoStream: true, previewUrl });
      await flushPromises();
    };
    const anchors = () => create.mock.calls.filter(([tag]) => tag === 'a');
    for (const unsafe of ['https://evil.example/a.mp4', 'javascript:alert(1)', String.raw`/\evil.example/a.mp4`]) {
      await download(unsafe);
      expect(anchors(), unsafe).toHaveLength(0);
      expect(click, unsafe).not.toHaveBeenCalled();
    }
    await download('/api/preview/clip?token=local-capability');
    expect(anchors()).toHaveLength(1);
    expect(click).toHaveBeenCalledTimes(1);
    const [anchor] = click.mock.contexts;
    expect(anchor.download).toBe(name);
    expect(anchor.href).toBe(`${location.origin}/api/preview/clip?token=local-capability&download=1`);
  });

  it('keeps a Files text draft when a correlated read reports binary, and blocks unsafe downloads', async () => {
    const { default: FilesTab } = await import('../../web/components/FilesTab.js');
    const name = 'notes.txt';
    const path = `${rootDir}/${name}`;
    const send = mockWorkbenchFiles(chat, { [rootDir]: [{ name, type: 'file' }] }, { [path]: 'On disk' });
    const files = render(FilesTab, { props: routeProps });
    await flushPromises();
    await files.get(`[data-tree-path$="/${name}"]`).trigger('click');
    await flushPromises();
    await files.get('.file-action-canvas').trigger('click');
    const canvas = files.getComponent(FileCanvasView);
    await button(canvas, t('creation.canvas.edit')).trigger('click');
    await canvas.get('textarea').setValue('Unsaved text');
    const [read] = send.mock.calls.find(([msg]) => msg.type === 'read_file');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    for (const previewUrl of ['https://evil.example/api/preview/1', 'javascript:void(0)', '/api/preview/local']) {
      respondWorkbench(read, { type: 'file_content', isBinary: true, content: 'not editable', previewUrl });
      await flushPromises();
      expectBinaryCanvas(files.getComponent(FileCanvasView));
      expect(files.vm.activeFile).toMatchObject({ content: 'Unsaved text', originalContent: 'On disk', isDirty: true });
      expect(files.findAll('.file-content-actions button').map(el => el.text())).not.toContain(t('files.edit'));
      expect(files.find('.file-content-actions button[title$="(Ctrl+S)"]').exists()).toBe(false);
      await button(files, t('files.download'), '.file-content-actions button').trigger('click');
      expect(click).toHaveBeenCalledTimes(previewUrl === '/api/preview/local' ? 1 : 0);
    }
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

  it('R8-F3: opens the literal POSIX backslash file from Markdown and blocks network paths', async () => {
    const repo = '/repo';
    const readme = `${repo}/README.md`;
    const literal = String.raw`/repo/chapter\draft.md`;
    const nested = `${repo}/chapter/draft.md`;
    creations.byAgent[route.agentId].list = [{ id: 'backslash-links', rootDir: repo, sessionId: route.sessionId }];
    const send = mockWorkbenchFiles(chat, {
      [repo]: [{ name: 'README.md', type: 'file' }, { name: 'chapter', type: 'directory' },
        { name: String.raw`chapter\draft.md`, type: 'file' }],
      [`${repo}/chapter`]: [{ name: 'draft.md', type: 'file' }],
    }, {
      [readme]: String.raw`[draft](chapter%5Cdraft.md) [evil](\\\evil.example/x) [evil](/\evil.example/x)`,
      [literal]: '# Literal backslash',
      [nested]: '# Nested file',
    });
    const wrapper = render(CreationTab, { props: { ...routeProps, workDir: repo,
      workspaceGeneration: workbenchWorkspaceGeneration(routeKey, repo) } });
    await flushPromises();
    expect(wrapper.vm.docFiles.map(file => file.path)).toEqual(expect.arrayContaining([literal, nested]));
    const canvas = wrapper.getComponent(FileCanvasView);
    expect(canvas.props('file').path).toBe(readme);
    const [draftLink, ...unsafeLinks] = canvas.findAll('.canvas-doc-content a');
    expect(unsafeLinks.map(link => [link.text(), link.attributes('href'), link.attributes('data-workspace-href')]))
      .toEqual([['evil', undefined, undefined], ['evil', undefined, undefined]]);
    await draftLink.trigger('click');
    await flushPromises();
    expect(canvas.props('file').path).toBe(literal);
    expect(canvas.get('h1').text()).toBe('Literal backslash');
    expect(send.mock.calls.map(([msg]) => msg).filter(msg => msg.type === 'read_file').map(msg => msg.filePath))
      .toEqual([readme, literal]);
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

  it.each(['a newer open', 'explicit cancellation'])('ignores a late workspace resolution after %s, including its prompt', async supersededBy => {
    const { sessions } = await registerBrowserStores();
    chat.currentView = 'yeaft';
    chat.yeaftActiveSessionFilter = atlas.sessionId;
    sessions.setActive(atlas.sessionId, alpha.id);
    const slow = { ...atlas, id: 'slow', sessionId: 'slow-session' };
    // The newer open stays on the current Session; a route-change watcher alone cannot fence the first open.
    const fast = { ...atlas, id: 'fast' };
    creations.byAgent[alpha.id].list.push(slow, fast);
    sessions.applySnapshotUpsert({ id: slow.sessionId, workDir: rootDir }, alpha.id);
    const pending = deferred();
    const resolved = creation => ({ creation, sessionId: creation.sessionId, rootDir });
    const resolve = vi.spyOn(creations, 'resolveCreationSession').mockImplementation((_agentId, creation) => (
      creation.id === slow.id ? pending.promise : Promise.resolve(resolved(creation))
    ));
    const openWorkbench = vi.spyOn(chat, 'openWorkbench');
    const sendPrompt = vi.spyOn(chat, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const opening = creations.openCreationWorkspace({ agentId: alpha.id, creationId: slow.id, promptToSend: 'Stale prompt' });
    expect(resolve).toHaveBeenCalledExactlyOnceWith(alpha.id, slow, { createIfMissing: true });
    if (supersededBy === 'a newer open') {
      await creations.openCreationWorkspace({ agentId: alpha.id, creationId: fast.id });
      expect(creations.pendingWorkbenchTarget).toMatchObject({ creationId: fast.id, sessionId: fast.sessionId });
    } else {
      creations.cancelPendingWorkspaceOpen();
      expect(creations.pendingWorkbenchTarget).toBeNull();
    }
    const target = creations.pendingWorkbenchTarget;
    pending.resolve(resolved(slow));
    expect(await opening).toBeNull();
    expect(sessions.activeSessionId).toBe(atlas.sessionId);
    expect(chat.yeaftActiveSessionFilter).toBe(atlas.sessionId);
    expect(creations.pendingWorkbenchTarget).toBe(target);
    expect(openWorkbench).toHaveBeenCalledTimes(supersededBy === 'a newer open' ? 1 : 0);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['model', true], ['scene', true], ['model', false], ['scene', false],
  ])('R2-F4b: waits for %s config before sending the initial prompt (navigated away: %s)', async (queue, navigate) => {
    const { yeaftSessionIdentityKey } = await import('../../web/stores/helpers/yeaft-session-identity.js');
    const { sessions } = await registerBrowserStores();
    chat.uiMode = 'classic';
    chat.currentView = 'yeaft';
    chat.yeaftActiveSessionFilter = atlas.sessionId;
    sessions.setActive(atlas.sessionId, alpha.id);
    const otherSessionId = 'other-alpha';
    sessions.applySnapshotUpsert({ id: otherSessionId, workDir: rootDir }, alpha.id);
    const config = deferred();
    const key = yeaftSessionIdentityKey(alpha.id, atlas.sessionId);
    const queueName = queue === 'scene' ? '_sessionSceneSwitches' : '_sessionModelSwitchQueue';
    chat[queueName] = new Map([[key, queue === 'scene' ? { promise: config.promise } : config.promise]]);
    const sendPrompt = vi.spyOn(chat, 'sendYeaftSessionMessage').mockResolvedValue({ ok: true });
    const open = creations.openCreationWorkspace({ agentId: alpha.id, creationId: atlas.id, sessionId: atlas.sessionId,
      rootDir, initialPrompt: 'Start mapping' });
    await flushPromises();
    expect(creations.pendingWorkbenchTarget).toMatchObject({ creationId: atlas.id, sessionId: atlas.sessionId });
    expect(sendPrompt).not.toHaveBeenCalled();
    if (navigate) {
      chat.setActiveSessionFilter(otherSessionId, { agentId: alpha.id, force: true });
      expect(chat.yeaftActiveSessionFilter).toBe(otherSessionId);
    }
    chat[queueName].delete(key);
    config.resolve({ ok: true });
    await open;
    if (navigate) expect(sendPrompt).not.toHaveBeenCalled();
    else expect(sendPrompt).toHaveBeenCalledExactlyOnceWith({ groupId: atlas.sessionId, text: 'Start mapping' });
  });

  it('releases Ignite on unmount and lets a remount own the next attempt on the same Agent', async () => {
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const old = deferred();
    const current = deferred();
    const submit = vi.spyOn(creations, 'createWorkspaceCreation').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const mountGalaxy = () => render(CosmosGalaxyOverlay, { props: { visible: true, agents: [alpha, beta] } });
    const first = mountGalaxy();
    await flushPromises();
    Object.assign(creations.igniteDraft, { open: true, title: 'Old attempt' });
    await first.get('form').trigger('submit');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(creations.igniteDraft.submitting).toBe(true);
    first.unmount();
    expect(creations.igniteDraft.submitting).toBe(false);

    const second = mountGalaxy();
    await flushPromises();
    expect(creations.selectedAgentId).toBe(alpha.id);
    expect(second.get('button[type="submit"]').element.disabled).toBe(false);
    await second.get('.creation-ignite-title-input').setValue('Current attempt');
    await second.get('form').trigger('submit');
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: alpha.id, title: 'Current attempt' }));
    old.resolve(Promise.reject(new Error('Stale Ignite error')));
    await flushPromises();
    expect(creations.igniteDraft).toMatchObject({ title: 'Current attempt', submitting: true, error: null });
    expect(second.get('button[type="submit"]').element.disabled).toBe(true);
    current.resolve({ creation: atlas, sessionId: atlas.sessionId, rootDir });
    await flushPromises();
    expect(creations.igniteDraft.submitting).toBe(false);
    expect(first.emitted('open-creation')).toBeUndefined();
    expect(second.emitted('open-creation')).toEqual([[expect.objectContaining({ creationId: atlas.id })]]);
  });

  it('excludes CLI Sessions from Ignite and requires a name for a new Project', async () => {
    const { default: CosmosGalaxyOverlay } = await import('../../web/components/cosmos/creations/CosmosGalaxyOverlay.js');
    const { sessions } = await registerBrowserStores();
    const cliKey = sessions.applySnapshotUpsert({ id: 'cli', name: 'Claude CLI' }, alpha.id);
    sessions.sessions[cliKey].runtimeProvider = 'claude-code'; // Expose a mixed inventory to the picker.
    const submit = vi.spyOn(creations, 'createWorkspaceCreation').mockResolvedValue({ creation: atlas });
    const wrapper = render(CosmosGalaxyOverlay, { props: { visible: true, agents: [alpha, beta] } });
    await flushPromises();
    await wrapper.get('.creation-ignite-input').trigger('focus');
    await wrapper.get('.creation-ignite-title-input').setValue('Named Creation');
    const [, projectSelect, sessionMode] = wrapper.findAll('.creation-ignite-selectors label select');
    await sessionMode.setValue('existing');
    expect(wrapper.get('.is-session-picker').findAll('option').map(option => option.element.value)).toEqual([linkedSession.id]);
    await projectSelect.setValue('__new__');
    const name = wrapper.get('.creation-ignite-inline-input');
    await name.setValue('   ');
    expect(wrapper.get('button[type="submit"]').element.disabled).toBe(true);
    await wrapper.get('form').trigger('submit');
    expect(submit).not.toHaveBeenCalled();
    await name.setValue('New Maps');
    expect(wrapper.get('button[type="submit"]').element.disabled).toBe(false);
    await wrapper.get('form').trigger('submit');
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      newProjectName: 'New Maps', existingSessionId: linkedSession.id,
    }));
  });

  it('keeps the modal open on a denied Project move and lets the user open the unassigned Creation', async () => {
    const creation = { ...atlas, projectId: null };
    const submit = vi.spyOn(creations, 'createWorkspaceCreation').mockResolvedValue({
      agentId: alpha.id, sessionId: linkedSession.id, creation, projectId: null,
      requestedProjectId: project.id, projectWarning: 'Project move denied',
    });
    const wrapper = render(CreationCreateModal, { stubs: { Teleport: true } });
    await wrapper.get('#creation-create-title').setValue('Unassigned Atlas');
    await wrapper.get('#creation-create-project').setValue(project.id);
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').isVisible()).toBe(true);
    expect(wrapper.get('[role="alert"]').text()).toBe('Project move denied');
    expect(wrapper.emitted('created')).toBeUndefined();
    expect(wrapper.emitted('close')).toBeUndefined();
    await button(wrapper, `${t('common.open')} — ${t('creation.create.noProject')}`).trigger('click');
    expect(wrapper.emitted('created')).toEqual([[expect.objectContaining({ creation, projectId: null, sessionId: linkedSession.id })]]);
    expect(wrapper.emitted('close')).toEqual([[]]);
    expect(submit).toHaveBeenCalledTimes(1);
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
