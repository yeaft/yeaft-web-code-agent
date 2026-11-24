import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import ctx from '../../../agent/context.js';
import * as bridge from '../../../agent/yeaft/web-bridge.js';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';
import { seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import { createSessionFromSpec, snapshotSessions } from '../../../agent/yeaft/sessions/session-crud.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import {
  ensureWorkspaceFoldersSnapshot,
  scanWorkspaceFolders,
  selectCandidateWorkspaceFolders,
} from '../../../agent/yeaft/workspace-folders.js';
import { refreshSingleSessionIndex, runDailySessionIndex } from '../../../agent/yeaft/session-discovery/indexer.js';
import { listActiveSessionCards, openDiscoveryStore } from '../../../agent/yeaft/session-discovery/store.js';

let tempRoot = null;
const savedCtx = { ...ctx };

afterEach(async () => {
  await bridge.__testResetVpState();
  bridge.__testSetSession(null);
  await closeConversationHistoryIndexes();
  Object.assign(ctx, savedCtx);
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

async function until(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('condition timed out');
}

describe('Workspace <=3 level folder snapshot & Sessionless auto-routing pipeline', () => {
  it('scans up to 3 levels, stops descending at project roots, skips noise/symlinks, persists once, and ranks candidate folders', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-ws-folders-'));
    const home = join(tempRoot, 'home');
    const yeaftDir = join(tempRoot, 'yeaft');
    mkdirSync(yeaftDir, { recursive: true });

    // Depth 1 under ~/projects: a Node repo with nested packages that MUST NOT be expanded
    const repoA = join(home, 'projects', 'yeaft-web');
    mkdirSync(join(repoA, 'src', 'components'), { recursive: true });
    mkdirSync(join(repoA, 'node_modules', 'vue'), { recursive: true });
    writeFileSync(join(repoA, 'package.json'), JSON.stringify({
      name: '@yeaft/webchat',
      description: 'Web control plane for code agents',
    }));

    // Depth 2 under ~/projects/org/quant-engine: a Python repo
    const repoB = join(home, 'projects', 'org', 'quant-engine');
    mkdirSync(join(repoB, 'strategies', 'deep'), { recursive: true });
    writeFileSync(join(repoB, 'pyproject.toml'), '[project]\nname = "quant-engine"\n');
    writeFileSync(join(repoB, 'README.md'), '# Quant Strategy Backtester\nDetails here.\n');

    // Symlink directory should be ignored
    const outside = join(tempRoot, 'outside-secret');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, '.git'), '');
    symlinkSync(outside, join(home, 'projects', 'linked-secret'));

    const snapshot = scanWorkspaceFolders({ homeDir: home });
    const paths = snapshot.folders.map(f => f.path);
    expect(paths).toContain(repoA);
    expect(paths).toContain(repoB);
    // Must stop at project root (never descend into repoA/src or repoB/strategies or node_modules)
    expect(paths.some(p => p.includes('/src') || p.includes('node_modules') || p.includes('/strategies'))).toBe(false);
    expect(paths).not.toContain(outside);
    expect(paths.some(p => p.includes('linked-secret'))).toBe(false);

    const entryA = snapshot.folders.find(f => f.path === repoA);
    expect(entryA).toMatchObject({
      name: 'yeaft-web',
      markers: ['package.json'],
      label: '@yeaft/webchat — Web control plane for code agents',
    });
    const entryB = snapshot.folders.find(f => f.path === repoB);
    expect(entryB).toMatchObject({
      name: 'quant-engine',
      markers: ['pyproject.toml'],
      label: 'Quant Strategy Backtester',
    });

    // ensureWorkspaceFoldersSnapshot writes once and reuses cached file until force=true
    const firstPersisted = ensureWorkspaceFoldersSnapshot(yeaftDir, { homeDir: home });
    expect(firstPersisted.folders.map(f => f.path)).toEqual(expect.arrayContaining([repoA, repoB]));

    const repoC = join(home, 'projects', 'new-rust-cli');
    mkdirSync(repoC, { recursive: true });
    writeFileSync(join(repoC, 'Cargo.toml'), '[package]\nname = "new-rust-cli"\n');

    const cachedRead = ensureWorkspaceFoldersSnapshot(yeaftDir, { homeDir: home, force: false });
    expect(cachedRead.folders.map(f => f.path)).not.toContain(repoC);

    const forcedRefresh = ensureWorkspaceFoldersSnapshot(yeaftDir, { homeDir: home, force: true });
    expect(forcedRefresh.folders.map(f => f.path)).toContain(repoC);

    // Candidate ranking boosts lexical match + recent Session workDir
    seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    const s1 = createSessionFromSpec(yeaftDir, { name: 'Quant work', sceneId: 'investment', workDir: repoB });
    const candidates = selectCandidateWorkspaceFolders(yeaftDir, {
      query: 'fix yeaft-web button layout',
      allowedSessionIds: [s1.id],
    });
    expect(candidates[0].path).toBe(repoA);
    expect(candidates.find(c => c.path === repoB)?.recent).toBe(true);
  });

  it('refreshes single-session index on turn end and routes Tier 1 (running/AskUser) -> Tier 2 (recent 5d) -> Tier 3 (create with folder & scene)', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-auto-route-'));
    const yeaftDir = join(tempRoot, 'yeaft');
    const workspaceRoot = join(tempRoot, 'workspaces');
    const frontendRepo = join(workspaceRoot, 'yeaft-frontend');
    mkdirSync(frontendRepo, { recursive: true });
    writeFileSync(join(frontendRepo, 'package.json'), JSON.stringify({ name: 'yeaft-frontend', description: 'UI app' }));
    ensureWorkspaceFoldersSnapshot(yeaftDir, { roots: [workspaceRoot] });

    seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    const store = new ConversationStore(yeaftDir);
    const sentFrames = [];
    ctx.CONFIG = { yeaftDir, workDir: workspaceRoot };
    ctx.serverCapabilities = new Set(['session_discovery', 'session_share_recall']);
    ctx.ws = {
      readyState: 1,
      send(encoded) { sentFrames.push(JSON.parse(encoded)); },
    };
    ctx.serverEncryptionRequired = false;
    ctx.outboundSendQueue = [];
    ctx.outboundSendQueueBytes = 0;
    ctx.outboundSendQueueActive = false;
    ctx.messageBuffer = [];
    ctx.messageBufferBytes = 0;

    let holdRunningTurn;
    const runningGate = new Promise(resolve => { holdRunningTurn = resolve; });
    const decisionCalls = [];

    const mockAdapter = {
      async *stream(params) {
        const lastUser = params.messages.filter(m => m.role === 'user').at(-1);
        const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
        if (text.includes('HOLD_RUNNING_TASK')) {
          yield { type: 'text_delta', text: 'Working on database migration...' };
          await runningGate;
        } else {
          yield { type: 'text_delta', text: `Reply to: ${text.slice(0, 40)}` };
        }
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      async call(params) {
        decisionCalls.push(params);
        const userPayload = JSON.parse(params.messages[0].content);
        // Tier 1: route-running-session
        if (userPayload.runningSessions) {
          if (userPayload.newQuery.includes('also add rollback SQL')) {
            return {
              text: JSON.stringify({
                decision: 'match',
                sessionId: userPayload.runningSessions[0].sessionId,
                confidence: 0.94,
                reason: 'supplements active migration',
              }),
            };
          }
          return { text: '{"decision":"none","sessionId":null,"confidence":0.1,"reason":"unrelated"}' };
        }
        // Tier 2: route-recent-session
        if (userPayload.candidateSessions) {
          if (userPayload.newQuery.includes('continue frontend header')) {
            return {
              text: JSON.stringify({
                decision: 'match',
                sessionId: userPayload.candidateSessions[0].sessionId,
                confidence: 0.91,
                reason: 'continues recent frontend session',
              }),
            };
          }
          return {
            text: '{"decision":"create","sessionId":null,"confidence":0.2,"searchKeywords":["frontend"],"reason":"new topic"}',
          };
        }
        // Tier 3: plan-new-session
        if (userPayload.allowedScenes) {
          return {
            text: JSON.stringify({
              sceneId: 'frontend',
              workDir: frontendRepo,
              title: '前端顶栏样式调整',
              reason: 'matches yeaft-frontend repo',
            }),
          };
        }
        return { text: '{}' };
      },
    };

    bridge.__testSetSession({
      adapter: mockAdapter,
      trace: new NullTrace(),
      conversationStore: store,
      config: {
        model: 'proxy/main-model',
        decisionModel: 'proxy/decision-mini',
        maxOutputTokens: 1024,
      },
      toolRegistry: new ToolRegistry(),
      yeaftDir,
    });
    bridge.__testSetThreadClassifier(() => ({ decision: 'related', targetThreadId: null }));

    const allSent = () => [...sentFrames, ...ctx.outboundSendQueue.map(x => x.msg)];

    // Step A: Auto-route with empty allowedSessionIds -> Tier 3 creates a brand-new Session with LLM-chosen scene & workDir!
    const createdRes = await bridge.handleYeaftAutoRouteSend({
      id: 'msg_create_1',
      requestId: 'req_create_1',
      text: '帮我改一下 yeaft-frontend 的顶栏样式',
      _allowedSessionIds: [],
      _shareOwnerId: 'user-1',
    });
    expect(createdRes).toMatchObject({ decision: 'created', tier: 'create' });
    const createdSessionId = createdRes.sessionId;
    const createdSessions = snapshotSessions(yeaftDir);
    const createdMeta = createdSessions.find(s => s.id === createdSessionId);
    expect(createdMeta).toMatchObject({
      name: '前端顶栏样式调整',
      workDir: frontendRepo,
    });
    const routedCreateFrame = allSent().find(f => f.type === 'yeaft_session_routed' && f.requestId === 'req_create_1');
    expect(routedCreateFrame).toMatchObject({
      ok: true,
      sessionId: createdSessionId,
      decision: 'created',
      tier: 'create',
      sceneId: 'frontend',
      workDir: frontendRepo,
      decisionModel: 'proxy/decision-mini',
    });

    await bridge.__testDrainVpDrivers();

    // Verify turn-end live incremental index updated discovery.db immediately (even with just 1 turn = 2 messages!)
    await until(() => {
      const db = openDiscoveryStore(yeaftDir, { readOnly: true });
      if (!db) return false;
      try {
        const cards = listActiveSessionCards(db, yeaftDir, [createdSessionId]).cards;
        return cards.length === 1;
      } finally {
        db.close();
      }
    });

    // Also verify daily index sweep preserves fresh 2-message active cards within 5 days
    runDailySessionIndex(yeaftDir, Date.now(), { force: true });
    {
      const db = openDiscoveryStore(yeaftDir, { readOnly: true });
      try {
        expect(listActiveSessionCards(db, yeaftDir, [createdSessionId]).cards).toHaveLength(1);
      } finally {
        db.close();
      }
    }

    // Step B: Next message with `createdSessionId` in `_allowedSessionIds` matches Tier 2 (recent idle Session)!
    const tier2Res = await bridge.handleYeaftAutoRouteSend({
      id: 'msg_tier2_1',
      requestId: 'req_tier2_1',
      text: 'continue frontend header spacing',
      _allowedSessionIds: [createdSessionId],
      _shareOwnerId: 'user-1',
    });
    expect(tier2Res).toEqual({
      sessionId: createdSessionId,
      decision: 'matched',
      tier: 'recent',
    });
    await bridge.__testDrainVpDrivers();

    // Step C: Start a running turn in a second Session, then send a follow-up via auto-route -> Tier 1 matches running Session!
    const runningSession = createSessionFromSpec(yeaftDir, {
      name: 'DB Migration',
      sceneId: 'software',
      workDir: '',
    });
    refreshSingleSessionIndex(yeaftDir, createdSessionId, Date.now());
    const runningPromise = bridge.handleYeaftSessionSend({
      id: 'msg_run_root',
      sessionId: runningSession.id,
      text: 'HOLD_RUNNING_TASK: migrate users table',
    });
    await until(() => allSent().some(f => f.sessionId === runningSession.id && f.event?.type === 'vp_turn_start'));

    // Ensure bridge classifier appends to the active thread
    bridge.__testSetThreadClassifier(({ runningThreads }) => ({
      decision: 'related',
      targetThreadId: runningThreads[0]?.threadId || null,
    }));

    const tier1Res = await bridge.handleYeaftAutoRouteSend({
      id: 'msg_tier1_1',
      requestId: 'req_tier1_1',
      text: 'also add rollback SQL to that migration',
      _allowedSessionIds: [createdSessionId, runningSession.id],
      _shareOwnerId: 'user-1',
    });
    expect(tier1Res).toEqual({
      sessionId: runningSession.id,
      decision: 'matched',
      tier: 'running',
    });

    // Security check: if runningSession.id is NOT in _allowedSessionIds, Tier 1 MUST NOT match it!
    const unauthorizedRes = await bridge.handleYeaftAutoRouteSend({
      id: 'msg_unauth_1',
      requestId: 'req_unauth_1',
      text: 'also add rollback SQL to that migration',
      _allowedSessionIds: [createdSessionId], // runningSession.id excluded
      _shareOwnerId: 'user-2',
    });
    expect(unauthorizedRes.sessionId).not.toBe(runningSession.id);

    holdRunningTurn();
    await runningPromise;
    await bridge.__testDrainVpDrivers();

    // Verify all Decision calls used configured decisionModel
    expect(decisionCalls.length).toBeGreaterThanOrEqual(3);
    expect(decisionCalls.every(c => c.model === 'proxy/decision-mini')).toBe(true);
  });
});
