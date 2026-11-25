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
import { createAgentHistoryScan } from '../../../agent/yeaft/conversation/search.js';
import { listActiveSessionCards, openDiscoveryStore, searchDiscovery, searchDiscoveryRelaxed } from '../../../agent/yeaft/session-discovery/store.js';
import { decideSessionAutoRoute, collectRecentIdleCandidates } from '../../../agent/yeaft/session-discovery/auto-route.js';
import { scoreRouteCandidates, tryFastPathRoute } from '../../../agent/yeaft/session-discovery/route-scorer.js';

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

    // Candidate ranking boosts lexical match + recent Session workDir, and pins trailing-slash preferredWorkDir even outside top limit
    seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    const s1 = createSessionFromSpec(yeaftDir, { name: 'Quant work', sceneId: 'investment', workDir: repoB });
    const candidates = selectCandidateWorkspaceFolders(yeaftDir, {
      query: 'fix yeaft-web button layout',
      allowedSessionIds: [s1.id],
    });
    expect(candidates[0].path).toBe(repoA);
    expect(candidates.find(c => c.path === repoB)?.recent).toBe(true);

    const pinned = selectCandidateWorkspaceFolders(yeaftDir, {
      query: 'fix yeaft-web',
      preferredWorkDir: `${repoC}/`,
      allowedSessionIds: [s1.id],
      limit: 1,
    });
    expect(pinned).toHaveLength(1);
    expect(pinned[0].path).toBe(repoC);
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
        // Unified Stage 1: auto-route-session (evaluates running + idle candidates side-by-side)
        if (Array.isArray(userPayload.candidates)) {
          const runningCand = userPayload.candidates.find(c => c.state === 'running' || c.state === 'waiting_input');
          if (runningCand && userPayload.newQuery.includes('choose port 8080')) {
            const secondPrompt = runningCand.pendingQuestions?.find(q => q.question.includes('Which port'));
            return {
              text: JSON.stringify({
                decision: 'match',
                sessionId: runningCand.id,
                answeredRequestId: secondPrompt?.requestId || null,
                confidence: 0.96,
                reason: 'answers specific AskUser port question',
              }),
            };
          }
          if (runningCand && userPayload.newQuery.includes('also add rollback SQL')) {
            return {
              text: JSON.stringify({
                decision: 'match',
                sessionId: runningCand.id,
                answeredRequestId: null,
                confidence: 0.94,
                reason: 'supplements active migration without answering AskUser',
              }),
            };
          }
          if (userPayload.newQuery.includes('continue frontend header')) {
            const idleCand = userPayload.candidates.find(c => c.state === 'idle') || userPayload.candidates[0];
            return {
              text: JSON.stringify({
                decision: 'match',
                sessionId: idleCand.id,
                answeredRequestId: null,
                confidence: 0.91,
                reason: 'continues recent frontend session',
              }),
            };
          }
          return {
            text: JSON.stringify({
              decision: 'create',
              sessionId: null,
              answeredRequestId: null,
              confidence: 0.9,
              sceneId: 'frontend',
              workDir: frontendRepo,
              title: '新建独立话题',
              reason: 'new topic',
            }),
          };
        }
        // Direct Tier 3: plan-new-session (when no active candidates exist)
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

    // Seed TWO concurrent pending AskUser prompts on runningSession:
    // 1) A side instruction ("also add rollback SQL") must NOT settle either AskUser prompt,
    // 2) An explicit answer ("choose port 8080") must settle ONLY ask_port_2 AND persist the user's reply in transcript!
    let ask1Settled = false;
    const ask1Promise = bridge.__testHooks.seedPendingUserPrompt({
      requestId: 'ask_env_1',
      sessionId: runningSession.id,
      question: 'Which environment?',
      options: ['staging', 'prod'],
    }).then(res => { ask1Settled = true; return res; });
    const ask2Promise = bridge.__testHooks.seedPendingUserPrompt({
      requestId: 'ask_port_2',
      sessionId: runningSession.id,
      question: 'Which port should I bind?',
      options: ['3000', '8080'],
    });

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
    expect(ask1Settled).toBe(false);

    const askAnswerRes = await bridge.handleYeaftAutoRouteSend({
      id: 'msg_tier1_ask',
      requestId: 'req_tier1_ask',
      text: 'choose port 8080',
      _allowedSessionIds: [createdSessionId, runningSession.id],
      _shareOwnerId: 'user-1',
    });
    expect(askAnswerRes).toEqual({
      sessionId: runningSession.id,
      decision: 'matched',
      tier: 'running',
      answeredAskUser: true,
    });
    expect(await ask2Promise).toEqual({ 'Which port should I bind?': 'choose port 8080' });
    expect(ask1Settled).toBe(false);
    // Transcript must include the user's AskUser reply row
    expect(store.loadAllBySession(runningSession.id).some(r => r.role === 'user' && r.content === 'choose port 8080')).toBe(true);
    bridge.__testHooks.settlePendingUserPromptForTest('ask_env_1', { answers: { 'Which environment?': 'staging' } });
    await ask1Promise;

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

  it('handles Stage 0 zero-LLM fast-path, safety guards, relaxed FTS5, task-session exclusion, and scale-invariant scoring', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-router-fastpath-'));
    const yeaftDir = join(tempRoot, 'yeaft');
    mkdirSync(yeaftDir, { recursive: true });
    seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    const store = new ConversationStore(yeaftDir);

    const now = Date.now();
    const sProxy = createSessionFromSpec(yeaftDir, { name: 'Proxy-Server', sceneId: 'software', workDir: join(tempRoot, 'proxy') });
    const sTcm = createSessionFromSpec(yeaftDir, { name: 'ZhongYi', sceneId: 'general', workDir: join(tempRoot, 'zhongyi') });
    const sYeaft = createSessionFromSpec(yeaftDir, { name: 'Yeaft-Dev', sceneId: 'software', workDir: join(tempRoot, 'yeaft-app') });
    const sTask = createSessionFromSpec(yeaftDir, {
      name: 'Daily Report',
      workDir: join(tempRoot, 'inv'),
      task: { prompt: 'Generate daily market report', enabled: true, trigger: { type: 'manual' } },
    });

    const appendTurn = (sid, userText, assistantText, tsMs) => {
      store.appendBatch([
        { sessionId: sid, role: 'user', content: userText, time: new Date(tsMs - 20_000).toISOString() },
        { sessionId: sid, role: 'assistant', turnId: `t_${tsMs}`, responseKind: 'result', stopReason: 'end_turn', content: assistantText, time: new Date(tsMs).toISOString() },
      ]);
    };

    appendTurn(sProxy.id, '帮我把服务更新最新版本', '已将线上 copilot-proxy 升级到 v0.1.320', now - 4 * 3_600_000);
    appendTurn(sProxy.id, '查看 nginx upstream 超时配置', '已检查 upstream_timeout 参数', now - 3 * 3_600_000);
    appendTurn(sTcm.id, '黄帝内经五行脏腑子母关系和针灸补泻怎么对应？', '木火土金水相生，生我者为母，虚则补其母实则泻其子，已整理图谱。', now - 10 * 60_000);
    appendTurn(sTcm.id, '帮我生成一个中医饮食补泻海报 html', '已生成 wuxing-diet-poster.html，可直接预览。', now - 8 * 60_000);
    appendTurn(sYeaft.id, '排查 WebSocket 心跳和 session auto-route 超时问题', '已定位 auto-route 超时并缩短 prompt 体积。', now - 5 * 3_600_000);
    appendTurn(sTask.id, '每日投研早报定时汇总', '今日标普与纳斯达克早报已完成。', now - 2 * 60_000);

    expect(runDailySessionIndex(yeaftDir, now, { force: true })).toBe(true);

    // 1. Task sessions (Daily Report) are excluded from auto-route idle candidates even if in allowedSessionIds.
    const allowedIds = [sProxy.id, sTcm.id, sYeaft.id, sTask.id];
    const { candidates: idle } = collectRecentIdleCandidates(yeaftDir, {
      allowedSessionIds: allowedIds,
      query: '每日投研早报',
      now,
    });
    expect(idle.some(c => c.sessionId === sTask.id)).toBe(false);

    // 2. Relaxed FTS5 recalls natural-language Chinese queries where strict AND search returns 0 hits.
    const db = openDiscoveryStore(yeaftDir, { readOnly: true });
    try {
      const nlQuery = '那么各个器官的子母关系是什么？这个是不是和五行相关？';
      expect(searchDiscovery(db, yeaftDir, allowedIds, nlQuery, now, { activeWindowDays: 5 }).results).toHaveLength(0);
      const relaxed = searchDiscoveryRelaxed(db, yeaftDir, allowedIds, nlQuery, now, { activeWindowDays: 5 });
      expect(relaxed.results[0]?.sessionId).toBe(sTcm.id);
    } finally {
      db.close();
    }

    let llmCalls = 0;
    const countingAdapter = {
      async call() {
        llmCalls += 1;
        return {
          text: JSON.stringify({
            decision: 'create',
            sessionId: null,
            answeredRequestId: null,
            confidence: 0.9,
            sceneId: 'general',
            workDir: '',
            title: '新话题',
            reason: 'mock_llm_fallback',
          }),
        };
      },
    };

    // 3. Fast-Path Rule 1: Exact repeated user utterance -> 0 LLM calls!
    const repeatHit = await decideSessionAutoRoute({
      yeaftDir,
      text: '帮我把服务更新最新版本',
      allowedSessionIds: allowedIds,
      adapter: countingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(repeatHit).toMatchObject({ action: 'continue', sessionId: sProxy.id, routeSource: 'fast_path', decisionModel: null });
    expect(llmCalls).toBe(0);

    // 4. Fast-Path Rule 2/3: Strong lexical hit on ZhongYi -> 0 LLM calls!
    const lexHit = await decideSessionAutoRoute({
      yeaftDir,
      text: '脏腑五行相生和饮食补泻再帮我补充虚实症状',
      allowedSessionIds: allowedIds,
      adapter: countingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(lexHit).toMatchObject({ action: 'continue', sessionId: sTcm.id, routeSource: 'fast_path', decisionModel: null });
    expect(llmCalls).toBe(0);

    // 5. Fast-Path Rule 4: Short/anaphoric continuation to sole recently-active session (<30m vs >=3h) -> 0 LLM calls!
    const shortHit = await decideSessionAutoRoute({
      yeaftDir,
      text: '你看看下面这个被挡住了啊',
      allowedSessionIds: allowedIds,
      adapter: countingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(shortHit).toMatchObject({ action: 'continue', sessionId: sTcm.id, routeSource: 'fast_path', decisionModel: null });
    expect(llmCalls).toBe(0);

    // 6. Fast-Path Rule 0: Exact unambiguous pending AskUser option match -> 0 LLM calls!
    const askHit = await decideSessionAutoRoute({
      yeaftDir,
      text: '8080',
      allowedSessionIds: allowedIds,
      runningSessions: [{
        sessionId: sYeaft.id,
        title: 'Yeaft-Dev',
        state: 'waiting_input',
        pendingQuestions: [{ requestId: 'ask_port_1', question: 'Bind which port?', options: ['3000', '8080'] }],
        recentMessages: [{ role: 'assistant', text: 'Bind which port?' }],
      }],
      adapter: countingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(askHit).toMatchObject({
      action: 'continue',
      tier: 'running',
      sessionId: sYeaft.id,
      routeSource: 'fast_path',
      answeredQuestion: { requestId: 'ask_port_1' },
    });
    expect(llmCalls).toBe(0);

    // 7. Safety Guards: meta-diagnostic reference & explicit new-topic MUST NOT trigger fast-path!
    await decideSessionAutoRoute({
      yeaftDir,
      text: '你帮我看看ZhongYi这个session，它是正常终止吗？我感觉没给我response啊',
      allowedSessionIds: allowedIds,
      adapter: countingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(llmCalls).toBe(1);

    await decideSessionAutoRoute({
      yeaftDir,
      text: '新开一个话题，帮我规划京都五天自由行路线',
      allowedSessionIds: allowedIds,
      adapter: countingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(llmCalls).toBe(2);

    // 8. Scale-invariant IDF guard: adding 20 distractor sessions must NOT cause generic words to false-trigger fast-path!
    const baseCandidates = [
      {
        sessionId: 's_dev',
        title: 'App-Dev',
        workDir: '/tmp/app',
        activeAt: now - 30 * 60_000,
        windowMessages: [
          { role: 'user', text: '把版本发布日志改成更简洁的更新说明', createdAt: now - 35 * 60_000 },
          { role: 'assistant', text: '已完成最新版本的日志更新与发布。', createdAt: now - 30 * 60_000 },
        ],
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        sessionId: `s_dist_${i}`,
        title: `Topic-${i}`,
        workDir: '',
        activeAt: now - (3 + i) * 3_600_000,
        windowMessages: [
          { role: 'user', text: `完全不相关的主题讨论编号 alpha${i}`, createdAt: now - (3 + i) * 3_600_000 },
          { role: 'assistant', text: `回复主题内容 beta${i}`, createdAt: now - (3 + i) * 3_600_000 },
        ],
      })),
    ];
    const { scored, metaExcluded } = scoreRouteCandidates({
      query: '帮我把这段产品发布说明改成更克制、没有营销味的中文更新日志',
      candidates: baseCandidates,
      now,
    });
    expect(tryFastPathRoute({ query: '帮我把这段产品发布说明改成更克制、没有营销味的中文更新日志', scoredCandidates: scored, metaExcluded })).toBeNull();
  });

  it('isolates per-session scan budgets in runDailySessionIndex and supports fast multi-segment incremental refresh', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-idx-iso-'));
    const yeaftDir = join(tempRoot, 'yeaft');
    mkdirSync(yeaftDir, { recursive: true });
    seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    const store = new ConversationStore(yeaftDir);
    const now = Date.now();

    const sA = createSessionFromSpec(yeaftDir, { name: 'Session-A', sceneId: 'software' });
    const sB = createSessionFromSpec(yeaftDir, { name: 'Session-B', sceneId: 'general' });

    for (let i = 0; i < 3; i += 1) {
      store.appendBatch([
        { sessionId: sA.id, role: 'user', content: `Alpha topic question ${i}`, time: new Date(now - (10 - i) * 60_000).toISOString() },
        { sessionId: sA.id, role: 'assistant', turnId: `ta_${i}`, responseKind: 'result', stopReason: 'end_turn', content: `Alpha answer ${i}`, time: new Date(now - (9 - i) * 60_000).toISOString() },
        { sessionId: sB.id, role: 'user', content: `Beta topic question ${i}`, time: new Date(now - (8 - i) * 60_000).toISOString() },
        { sessionId: sB.id, role: 'assistant', turnId: `tb_${i}`, responseKind: 'result', stopReason: 'end_turn', content: `Beta answer ${i}`, time: new Date(now - (7 - i) * 60_000).toISOString() },
      ]);
    }

    // Even if sA's scan exhausts budget, sB is isolated and still gets indexed!
    const partialFailScan = (scanRoot, telemetry) => {
      const inner = createAgentHistoryScan(scanRoot, telemetry);
      return {
        ...inner,
        list(dir, suffix) {
          if (String(dir).includes(sA.id)) {
            telemetry.scanIncomplete = true;
            return null;
          }
          return inner.list(dir, suffix);
        },
        stopped: () => Boolean(telemetry.scanIncomplete || inner.stopped()),
      };
    };
    expect(runDailySessionIndex(yeaftDir, now, { force: true, createScan: partialFailScan })).toBe(true);
    {
      const dbPartial = openDiscoveryStore(yeaftDir, { readOnly: true });
      try {
        const cards = listActiveSessionCards(dbPartial, yeaftDir, [sA.id, sB.id], now).cards;
        expect(cards.map(c => c.sessionId)).toEqual([sB.id]);
        // Partial sweep must NOT advance index_state so the next sweep retries sA.
        expect(dbPartial.prepare('SELECT indexed_at FROM index_state WHERE id = 1').get()).toBeUndefined();
      } finally {
        dbPartial.close();
      }
    }

    // Full sweep indexes both, and incremental single-session refresh picks up new turns immediately.
    expect(runDailySessionIndex(yeaftDir, now, { force: true })).toBe(true);
    store.appendBatch([
      { sessionId: sB.id, role: 'user', content: 'Beta unique keyword QUARTZ_DELTA', time: new Date(now + 1000).toISOString() },
      { sessionId: sB.id, role: 'assistant', turnId: 'tb_new', responseKind: 'result', stopReason: 'end_turn', content: 'Delta confirmed', time: new Date(now + 2000).toISOString() },
    ]);
    expect(refreshSingleSessionIndex(yeaftDir, sB.id, now + 3000)).toBe(true);
    const db = openDiscoveryStore(yeaftDir, { readOnly: true });
    try {
      const hits = searchDiscovery(db, yeaftDir, [sA.id, sB.id], 'QUARTZ_DELTA', now + 3000);
      expect(hits.results.map(r => r.sessionId)).toEqual([sB.id]);
    } finally {
      db.close();
    }
  });
});
