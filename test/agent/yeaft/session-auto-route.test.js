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
import { scoreRouteCandidates, tryFastPathRoute, tryLocalFallbackRoute } from '../../../agent/yeaft/session-discovery/route-scorer.js';

let tempRoot = null;
let holdRunningTurn;
const savedCtx = { ...ctx };

afterEach(async () => {
  holdRunningTurn?.();
  holdRunningTurn = undefined;
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

    const runningGate = new Promise(resolve => { holdRunningTurn = resolve; });
    const decisionCalls = [];
    const adapterInputs = [];

    const mockAdapter = {
      async *stream(params) {
        const lastUser = params.messages.filter(m => m.role === 'user').at(-1);
        const text = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content || '');
        adapterInputs.push(text);
        if (text.includes('HOLD_RUNNING_TASK') && !text.includes('also add rollback SQL')) {
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
          const runningCand = userPayload.candidates.find(c => c.status === 'running' || c.status === 'waiting_input');
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
            const idleCand = userPayload.candidates.find(c => c.status === 'replied' || c.status === 'interrupted') || userPayload.candidates[0];
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
    // Ensure loop 1 is inside the adapter, not merely queued for startup.
    await until(() => adapterInputs.some(text => text.includes('HOLD_RUNNING_TASK')));
    const runningTurn = allSent().find(f => f.sessionId === runningSession.id && f.event?.type === 'vp_turn_start');

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

    const rejected = await bridge.handleYeaftAutoRouteSend({
      id: 'msg_bad_override',
      requestId: 'req_bad_override',
      text: 'also add rollback SQL (invalid override)',
      quickSend: { model: 'not-a-model' },
      _allowedSessionIds: [runningSession.id],
      _shareOwnerId: 'user-1',
      _requestClientId: 'client-1',
    });
    expect(rejected).toBeNull();
    expect(allSent().filter(f => f.type === 'yeaft_session_routed' && f.requestId === 'req_bad_override')).toEqual([
      expect.objectContaining({ ok: false, code: 'invalid_quick_send', clientMessageId: 'msg_bad_override', _requestClientId: 'client-1' }),
    ]);

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
    const appendIndex = allSent().findIndex(f => f.event?.type === 'vp_thread_user_appended' && f.event.messageId === 'msg_tier1_1');
    const ackIndex = allSent().findIndex(f => f.type === 'yeaft_session_routed' && f.requestId === 'req_tier1_1');
    expect(appendIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(appendIndex);
    expect(allSent()[appendIndex].event.turnId).toBe(runningTurn.event.turnId);
    expect(allSent()[ackIndex]).toMatchObject({ ok: true, delivery: 'appended' });
    expect(adapterInputs.some(text => text.includes('also add rollback SQL'))).toBe(false);

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
      text: 'also add rollback SQL in the other workspace',
      _allowedSessionIds: [createdSessionId], // runningSession.id excluded
      _shareOwnerId: 'user-2',
    });
    expect(unauthorizedRes.sessionId).not.toBe(runningSession.id);

    holdRunningTurn();
    await runningPromise;
    await bridge.__testDrainVpDrivers();

    // The original execution opened a second adapter loop with the new input.
    // Neither a history row nor a new execution would satisfy this assertion.
    expect(adapterInputs.filter(text => text.includes('also add rollback SQL to that migration'))).toHaveLength(1);
    const runningStarts = allSent().filter(f => f.sessionId === runningSession.id && f.event?.type === 'vp_turn_start');
    expect(runningStarts).toHaveLength(1);
    expect(allSent().find(f => f.sessionId === runningSession.id && f.event?.type === 'vp_thread_user_append_consumed')).toMatchObject({
      turnId: runningTurn.turnId,
      event: { preview: expect.stringContaining('also add rollback SQL') },
    });

    // Verify all Decision calls used configured decisionModel
    expect(decisionCalls.length).toBeGreaterThanOrEqual(3);
    expect(decisionCalls.every(c => c.model === 'proxy/decision-mini')).toBe(true);
  });

  it('keeps only the exact AskUser fast path, sends heuristics to the arbiter, falls back locally on arbiter failure, and keeps FTS5/task/IDF guards', async () => {
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
    const llmPayloads = [];
    const countingAdapter = {
      async call(params) {
        llmCalls += 1;
        llmPayloads.push(JSON.parse(params.messages[0].content));
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
    const failingAdapter = {
      async call() {
        throw new Error('provider unavailable');
      },
    };

    // 3. Lexical heuristics no longer pre-empt a working arbiter: a repeated
    // utterance, strong lexical overlap and a short continuation all reach the
    // LLM, which sees each candidate's turn state ordered most recent first.
    for (const text of ['帮我把服务更新最新版本', '脏腑五行相生和饮食补泻再帮我补充虚实症状', '你看看下面这个被挡住了啊']) {
      const before = llmCalls;
      const routed = await decideSessionAutoRoute({
        yeaftDir,
        text,
        allowedSessionIds: allowedIds,
        adapter: countingAdapter,
        config: { decisionModel: 'proxy/decision-mini' },
        now,
      });
      expect(llmCalls).toBe(before + 1);
      expect(routed).toMatchObject({ routeSource: 'llm', action: 'create' });
    }
    const turnStatePayload = llmPayloads.at(-1);
    expect(turnStatePayload.candidates.map(c => c.id)).not.toContain(sTask.id);
    expect(turnStatePayload.candidates[0]).toMatchObject({
      id: sTcm.id,
      status: 'replied',
      lastUser: { t: '帮我生成一个中医饮食补泻海报 html' },
      lastReply: { t: '已生成 wuxing-diet-poster.html，可直接预览。' },
    });
    expect(turnStatePayload.candidates[0].earlier.map(m => m.r)).toEqual(['u', 'a']);

    // 4. When the arbiter fails (provider error/timeout/invalid output), the
    // local scorer still continues an unmistakable owner instead of spawning a
    // context-less duplicate Session.
    const localFallback = async text => decideSessionAutoRoute({
      yeaftDir,
      text,
      allowedSessionIds: allowedIds,
      adapter: failingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(await localFallback('帮我把服务更新最新版本')).toMatchObject({
      action: 'continue', sessionId: sProxy.id, routeSource: 'fallback', fastPathRule: 'exact_utterance', decisionModel: null,
    });
    expect(await localFallback('脏腑五行相生和饮食补泻再帮我补充虚实症状')).toMatchObject({
      action: 'continue', sessionId: sTcm.id, routeSource: 'fallback', decisionModel: null,
    });
    const shortFallback = await localFallback('你看看下面这个被挡住了啊');
    expect(shortFallback).toMatchObject({
      action: 'continue', sessionId: sTcm.id, routeSource: 'fallback', fastPathRule: 'sole_recent_continuation',
    });
    expect(shortFallback.reason).toMatch(/arbiter:decision_error/);

    // 6. Fast-Path Rule 0: Exact unambiguous pending AskUser option match -> 0 LLM calls!
    const callsBeforeAsk = llmCalls;
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
    expect(llmCalls).toBe(callsBeforeAsk);

    // 7. Safety Guards: meta-diagnostic reference, explicit new-topic, and prefix-bearing new-topic queries
    // always reach the arbiter, and even the degraded local fallback never pulls them into a Session.
    const safeGuardQueries = [
      '你帮我看看ZhongYi这个session，它是正常终止吗？我感觉没给我response啊',
      '新开一个话题，帮我规划京都五天自由行路线',
      '可以帮我规划京都五天自由行路线吗？',
      '好的，帮我查一下英伟达财报',
      '帮我修复一下 nginx 的 502 错误',
      '这个报错怎么解决: ECONNREFUSED',
    ];
    for (const q of safeGuardQueries) {
      const beforeCalls = llmCalls;
      await decideSessionAutoRoute({
        yeaftDir,
        text: q,
        allowedSessionIds: allowedIds,
        adapter: countingAdapter,
        config: { decisionModel: 'proxy/decision-mini' },
        now,
      });
      expect(llmCalls).toBe(beforeCalls + 1);
      expect(await localFallback(q)).toMatchObject({ action: 'create', routeSource: 'fallback' });
    }

    // 7b. Multi-prompt & non-option AskUser deferral: Stage 0 MUST defer to Stage 1 LLM.
    for (const askCase of [
      {
        text: '8080',
        runningSessions: [{
          sessionId: sYeaft.id,
          title: 'Yeaft-Dev',
          state: 'waiting_input',
          pendingQuestions: [
            { requestId: 'ask_1', question: 'Port?', options: ['3000', '8080'] },
            { requestId: 'ask_2', question: 'Env?', options: ['dev', 'prod'] },
          ],
        }],
      },
      {
        text: 'prod',
        runningSessions: [
          {
            sessionId: sYeaft.id,
            title: 'Yeaft-Dev',
            state: 'waiting_input',
            pendingQuestions: [{ requestId: 'ask_a', question: 'Env?', options: ['dev', 'prod'] }],
          },
          {
            sessionId: sProxy.id,
            title: 'Proxy-Server',
            state: 'waiting_input',
            pendingQuestions: [{ requestId: 'ask_b', question: 'Env?', options: ['dev', 'prod'] }],
          },
        ],
      },
      {
        text: '帮我把服务更新最新版本',
        runningSessions: [{
          sessionId: sYeaft.id,
          title: 'Yeaft-Dev',
          state: 'waiting_input',
          pendingQuestions: [{ requestId: 'ask_c', question: 'Port?', options: ['3000', '8080'] }],
        }],
      },
    ]) {
      const beforeCalls = llmCalls;
      await decideSessionAutoRoute({
        yeaftDir,
        text: askCase.text,
        allowedSessionIds: allowedIds,
        runningSessions: askCase.runningSessions,
        adapter: countingAdapter,
        config: { decisionModel: 'proxy/decision-mini' },
        now,
      });
      expect(llmCalls).toBe(beforeCalls + 1);
      // An arbiter outage must never turn a reply to a pending AskUser into a
      // lexical guess (here the repeated utterance owned by Proxy-Server).
      const degraded = await decideSessionAutoRoute({
        yeaftDir,
        text: askCase.text,
        allowedSessionIds: allowedIds,
        runningSessions: askCase.runningSessions,
        adapter: failingAdapter,
        config: { decisionModel: 'proxy/decision-mini' },
        now,
      });
      expect(degraded).toMatchObject({ action: 'create', routeSource: 'fallback' });
      expect(degraded.answeredQuestion).toBeUndefined();
    }

    // 7c. Stage 1 unauthorized sessionId rejection & explicit preferredWorkDir/preferredSceneId precedence.
    const repoDir = join(tempRoot, 'yeaft-app');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'yeaft-app' }));
    ensureWorkspaceFoldersSnapshot(yeaftDir, { roots: [tempRoot], force: true });
    const hijackingAdapter = {
      async call() {
        return {
          text: JSON.stringify({
            decision: 'match',
            sessionId: 'unauthorized_other_owner_session',
            confidence: 0.99,
            sceneId: 'software',
            workDir: repoDir,
            title: '规划新任务',
            reason: 'hallucinated id',
          }),
        };
      },
    };
    const rejectedMatch = await decideSessionAutoRoute({
      yeaftDir,
      text: '新开一个话题写一篇周报',
      allowedSessionIds: allowedIds,
      preferredSceneId: 'writing',
      preferredWorkDir: '', // explicit empty workDir must suppress LLM-selected repoDir
      adapter: hijackingAdapter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
    });
    expect(rejectedMatch).toMatchObject({
      action: 'create',
      sessionId: null,
      sceneId: 'writing',
      workDir: '',
      title: '规划新任务',
    });

    // 7d. Non-BMP CJK surrogate-pair bigram recall (e.g. 𠮷野家)
    appendTurn(sTcm.id, '研究𠮷野山古籍草药记录', '已整理𠮷野山药材笔记', now - 60_000);
    expect(refreshSingleSessionIndex(yeaftDir, sTcm.id, now)).toBe(true);
    const dbBmp = openDiscoveryStore(yeaftDir, { readOnly: true });
    try {
      const bmpHits = searchDiscoveryRelaxed(dbBmp, yeaftDir, allowedIds, '查一下𠮷野相关的古籍笔记', now, { activeWindowDays: 5 });
      expect(bmpHits.results[0]?.sessionId).toBe(sTcm.id);
    } finally {
      dbBmp.close();
    }

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
    const genericQuery = '帮我把这段产品发布说明改成更克制、没有营销味的中文更新日志';
    expect(tryFastPathRoute({ query: genericQuery, scoredCandidates: scored })).toBeNull();
    expect(tryLocalFallbackRoute({ query: genericQuery, scoredCandidates: scored, metaExcluded })).toBeNull();

    // 9. A Session recalled from beyond the window keeps its FTS match for the arbiter even on weak overlap.
    const quiet = {
      title: 'Archive',
      activeAt: now - 9 * 24 * 3_600_000,
      matchedOlderSnippet: '旧会话里讨论过的发布说明模板',
      windowMessages: [{ role: 'assistant', text: '已整理模板。', createdAt: now - 9 * 24 * 3_600_000 }],
    };
    const { scored: quietScored } = scoreRouteCandidates({
      query: '发布说明',
      candidates: [
        { ...quiet, sessionId: 's_quiet_outside', outsideWindow: true },
        { ...quiet, sessionId: 's_quiet_inside' },
      ],
      now,
    });
    expect(quietScored.find(c => c.sessionId === 's_quiet_outside').matchedOlderSnippet).toBe('旧会话里讨论过的发布说明模板');
    expect(quietScored.find(c => c.sessionId === 's_quiet_inside').matchedOlderSnippet).toBe('');
  });

  it('routes new-topic, quiet older, parallel running and AskUser messages through one arbiter call with per-Session turn state', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-route-scenarios-'));
    const yeaftDir = join(tempRoot, 'yeaft');
    const workspaceRoot = join(tempRoot, 'workspaces');
    const appRepo = join(workspaceRoot, 'family-app');
    mkdirSync(appRepo, { recursive: true });
    writeFileSync(join(appRepo, 'package.json'), JSON.stringify({ name: 'family-app' }));
    ensureWorkspaceFoldersSnapshot(yeaftDir, { roots: [workspaceRoot] });
    seedDefaultVps(join(yeaftDir, 'virtual-persons'));
    const store = new ConversationStore(yeaftDir);
    const now = Date.now();
    const DAY = 24 * 3_600_000;

    const sLimit = createSessionFromSpec(yeaftDir, { name: 'Daily-Limit', sceneId: 'software', workDir: appRepo });
    const sAlert = createSessionFromSpec(yeaftDir, { name: 'Safety-Alert', sceneId: 'software', workDir: appRepo });
    const sProxy = createSessionFromSpec(yeaftDir, { name: 'Proxy-Server', sceneId: 'software', workDir: join(tempRoot, 'proxy') });
    const sArchive = createSessionFromSpec(yeaftDir, { name: 'Image-Policy', sceneId: 'software', workDir: appRepo });
    const turn = (sid, userText, reply, tsMs) => store.appendBatch([
      { sessionId: sid, role: 'user', content: userText, time: new Date(tsMs - 30_000).toISOString() },
      ...(reply ? [{ sessionId: sid, role: 'assistant', turnId: `t_${sid}_${tsMs}`, responseKind: 'result', stopReason: 'end_turn', content: reply, time: new Date(tsMs).toISOString() }] : []),
    ]);
    // Quiet for 8 days: outside the 5-day active window.
    turn(sArchive.id, '图片生成被家长管控拦截后，错误文案为什么进了 conversation.Messages？', 'BotConnection 兜底把异常文案写成了一条普通 Chat 消息。', now - 8 * DAY);
    turn(sArchive.id, '那前端展示和模型上下文要怎么分开？', '建议单独记录失败状态，不要伪装成 assistant 聊天消息塞给下一轮模型。', now - 8 * DAY + 120_000);
    turn(sLimit.id, 'Settings PATCH 传 null 能清除每日限额吗？', '可以，SDF 上实测家长和孩子都读回 null。', now - 3 * 3_600_000);
    turn(sLimit.id, '所以目前 API 都是 work 的对吗？', '对，设限和清除都通过了，ChildActivity heartbeat 还没验证。', now - 2 * 3_600_000);
    turn(sAlert.id, 'IC3 推送卡在哪？', '卡在跨用户写家长的 Activity Feed。', now - 50 * 60_000);
    turn(sAlert.id, '那要怎么推进？', '最慢的是等 IC3 答复，要不要我先起草给 Rong 的 Teams 消息？', now - 40 * 60_000);
    turn(sProxy.id, '升级 docker 服务到最新', '已升级到 0.1.324，旧容器 0.1.319 还在，要我删掉吗？', now - 20 * 60_000);
    turn(sProxy.id, '先看下磁盘占用', '还剩 41 GB，旧镜像占 3 GB。', now - 15 * 60_000);
    turn(sProxy.id, '删掉吧', null, now - 5 * 60_000); // Interrupted: no final reply.
    expect(runDailySessionIndex(yeaftDir, now, { force: true })).toBe(true);
    const allowedIds = [sLimit.id, sAlert.id, sProxy.id, sArchive.id];

    const payloads = [];
    let scripted = null;
    const arbiter = {
      async call(params) {
        const payload = JSON.parse(params.messages[0].content);
        payloads.push(payload);
        return { text: JSON.stringify(scripted(payload)) };
      },
    };
    const route = (text, extra = {}) => decideSessionAutoRoute({
      yeaftDir,
      text,
      allowedSessionIds: allowedIds,
      adapter: arbiter,
      config: { decisionModel: 'proxy/decision-mini' },
      now,
      ...extra,
    });

    // 1. New topic: one call plans the new Session; candidates arrive most recent first with turn state.
    scripted = () => ({ decision: 'create', sessionId: null, answeredRequestId: null, confidence: 0.92, sceneId: 'software', workDir: appRepo, title: 'Session 导出 Markdown', reason: 'new feature' });
    const created = await route('family-app 里新做一个功能：把 Session 导出成 Markdown 文件下载');
    expect(created).toMatchObject({ action: 'create', tier: 'create', sceneId: 'software', workDir: appRepo, routeSource: 'llm' });
    const firstPayload = payloads.at(-1);
    expect(firstPayload.candidates.map(c => c.id).slice(0, 3)).toEqual([sProxy.id, sAlert.id, sLimit.id]);
    expect(firstPayload.candidates[0]).toMatchObject({
      status: 'interrupted',
      lastUser: { t: '删掉吧', age: '6m ago' },
      lastReply: { t: '还剩 41 GB，旧镜像占 3 GB。', age: '15m ago' },
    });
    expect(firstPayload.candidates[1]).toMatchObject({ status: 'replied', lastReply: { t: expect.stringContaining('要不要我先起草给 Rong') } });

    // 2. A quiet older Session (beyond the 5-day window) stays reachable when the text clearly returns to it.
    scripted = payload => ({ decision: 'match', sessionId: payload.candidates.find(c => c.title === 'Image-Policy')?.id || null, answeredRequestId: null, confidence: 0.86, reason: 'returns to error-message persistence' });
    const older = await route('错误文案伪装成 Chat 消息塞进 conversation.Messages 的问题，帮我写修复方案');
    expect(older).toMatchObject({ action: 'continue', tier: 'recent', sessionId: sArchive.id, routeSource: 'llm' });
    expect(payloads.at(-1).candidates.find(c => c.id === sArchive.id)).toMatchObject({
      age: '8d ago',
      status: 'replied',
      olderMatch: expect.stringContaining('conversation.Messages'),
    });

    // 3. Several running Sessions: live progress is the reply the user reacts to, and a running match keeps tier "running".
    const running = [
      { sessionId: sAlert.id, title: 'Safety-Alert', state: 'running', recentMessages: [{ role: 'user', text: '起草吧' }, { role: 'assistant', text: '正在起草给 Rong 的 Teams 消息…' }] },
      { sessionId: sLimit.id, title: 'Daily-Limit', state: 'running', recentMessages: [{ role: 'user', text: 'heartbeat 也验证一下' }, { role: 'assistant', text: '正在 SDF 上验证清除限额后的 heartbeat…' }] },
    ];
    scripted = payload => ({ decision: 'match', sessionId: payload.candidates.find(c => c.lastReply?.t.includes('heartbeat'))?.id, answeredRequestId: null, confidence: 0.88, reason: 'supplements heartbeat verification' });
    const supplement = await route('验证的时候用孩子测试账号，别用家长账号', { runningSessions: running });
    expect(supplement).toMatchObject({ action: 'continue', tier: 'running', sessionId: sLimit.id });
    const runningView = payloads.at(-1).candidates.filter(c => c.status === 'running').map(c => [c.id, c.lastReply.t]);
    expect(runningView).toEqual(expect.arrayContaining([
      [sAlert.id, '正在起草给 Rong 的 Teams 消息…'],
      [sLimit.id, '正在 SDF 上验证清除限额后的 heartbeat…'],
    ]));

    // 4. AskUser: pending prompts are listed per Session; an answeredRequestId borrowed from another
    // Session is dropped, while the matched Session's own requestId settles its prompt.
    const waiting = [
      { sessionId: sAlert.id, title: 'Safety-Alert', state: 'waiting_input', pendingQuestions: [{ requestId: 'ask_alert_env', question: 'IC3 适配器先部署到哪个环境？', options: ['dev', 'prod'] }] },
      { sessionId: sProxy.id, title: 'Proxy-Server', state: 'waiting_input', pendingQuestions: [{ requestId: 'ask_proxy_delete', question: '旧容器 0.1.319 要删除吗？', options: ['删除', '保留'] }] },
    ];
    scripted = () => ({ decision: 'match', sessionId: sProxy.id, answeredRequestId: 'ask_alert_env', confidence: 0.95, reason: 'answers delete prompt' });
    const borrowed = await route('旧容器删了吧，留着没用', { runningSessions: waiting });
    expect(borrowed).toMatchObject({ action: 'continue', tier: 'running', sessionId: sProxy.id, answeredQuestion: null });
    expect(payloads.at(-1).candidates.find(c => c.id === sProxy.id)).toMatchObject({
      status: 'waiting_input',
      pendingQuestions: [{ requestId: 'ask_proxy_delete', options: ['删除', '保留'] }],
    });
    scripted = () => ({ decision: 'match', sessionId: sProxy.id, answeredRequestId: 'ask_proxy_delete', confidence: 0.95, reason: 'answers delete prompt' });
    const answered = await route('旧容器删了吧，留着没用', { runningSessions: waiting });
    expect(answered).toMatchObject({ sessionId: sProxy.id, answeredQuestion: { requestId: 'ask_proxy_delete' } });
    expect(payloads).toHaveLength(5);
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

    // Multi-segment (>=3 segments) delta slice: verify refreshSingleSessionIndex skips segment 1!
    const sMulti = createSessionFromSpec(yeaftDir, { name: 'Multi-Seg', sceneId: 'software' });
    const convDir = join(yeaftDir, 'sessions', sMulti.id, 'conversation');
    const segDir = join(convDir, 'segments');
    mkdirSync(segDir, { recursive: true });
    const writeSeg = (file, rows) => {
      const body = `${rows.map(r => JSON.stringify(r)).join('\n')}\n`;
      writeFileSync(join(segDir, file), body);
      return Buffer.byteLength(body);
    };
    const mkRow = (seqNum, role, content, tsMs) => ({
      id: `m${String(seqNum).padStart(4, '0')}`,
      seq: seqNum,
      sessionId: sMulti.id,
      role,
      ...(role === 'assistant' ? { turnId: `tm_${seqNum}`, responseKind: 'result', stopReason: 'end_turn' } : {}),
      content,
      time: new Date(tsMs).toISOString(),
    });
    const b1 = writeSeg('000001.jsonl', [
      mkRow(1, 'user', 'Seg1 alpha SEG1_OLD_TOKEN', now - 60_000),
      mkRow(2, 'assistant', 'Seg1 reply', now - 59_000),
    ]);
    const b2 = writeSeg('000002.jsonl', [
      mkRow(3, 'user', 'Seg2 beta question', now - 50_000),
      mkRow(4, 'assistant', 'Seg2 reply', now - 49_000),
    ]);
    const b3 = writeSeg('000003.jsonl', [
      mkRow(5, 'user', 'Seg3 gamma question', now - 40_000),
      mkRow(6, 'assistant', 'Seg3 reply', now - 39_000),
    ]);
    writeFileSync(join(convDir, 'index.json'), JSON.stringify({
      version: 1,
      streamId: 'stream-multi',
      revision: 3,
      nextSeq: 7,
      totalMessages: 6,
      segments: [
        { file: '000001.jsonl', firstSeq: 1, lastSeq: 2, count: 2, bytes: b1 },
        { file: '000002.jsonl', firstSeq: 3, lastSeq: 4, count: 2, bytes: b2 },
        { file: '000003.jsonl', firstSeq: 5, lastSeq: 6, count: 2, bytes: b3 },
      ],
    }));
    writeFileSync(join(convDir, 'lineage.json'), JSON.stringify({ streamId: 'stream-multi' }));

    expect(refreshSingleSessionIndex(yeaftDir, sMulti.id, now)).toBe(true);

    // Append turn 4 into segment 3 and verify delta refresh skips 000001.jsonl completely!
    const b3Updated = writeSeg('000003.jsonl', [
      mkRow(5, 'user', 'Seg3 gamma question', now - 40_000),
      mkRow(6, 'assistant', 'Seg3 reply', now - 39_000),
      mkRow(7, 'user', 'Seg3 delta DELTA_SLICE_TOKEN', now - 10_000),
      mkRow(8, 'assistant', 'Seg3 delta reply', now - 9_000),
    ]);
    writeFileSync(join(convDir, 'index.json'), JSON.stringify({
      version: 1,
      streamId: 'stream-multi',
      revision: 4,
      nextSeq: 9,
      totalMessages: 8,
      segments: [
        { file: '000001.jsonl', firstSeq: 1, lastSeq: 2, count: 2, bytes: b1 },
        { file: '000002.jsonl', firstSeq: 3, lastSeq: 4, count: 2, bytes: b2 },
        { file: '000003.jsonl', firstSeq: 5, lastSeq: 8, count: 4, bytes: b3Updated },
      ],
    }));

    const readFiles = [];
    const spyingScan = (scanRoot, telemetry) => {
      const inner = createAgentHistoryScan(scanRoot, telemetry);
      return {
        ...inner,
        read(filePath) {
          readFiles.push(String(filePath));
          return inner.read(filePath);
        },
      };
    };
    expect(refreshSingleSessionIndex(yeaftDir, sMulti.id, now + 1000, { createScan: spyingScan })).toBe(true);
    expect(readFiles.some(p => p.endsWith('000003.jsonl'))).toBe(true);
    expect(readFiles.some(p => p.endsWith('000001.jsonl'))).toBe(false);

    const dbMulti = openDiscoveryStore(yeaftDir, { readOnly: true });
    try {
      const card = listActiveSessionCards(dbMulti, yeaftDir, [sMulti.id], now + 1000).cards[0];
      expect(card?.messageCount).toBe(8);
      expect(searchDiscovery(dbMulti, yeaftDir, [sMulti.id], 'SEG1_OLD_TOKEN', now + 1000).results).toHaveLength(1);
      expect(searchDiscovery(dbMulti, yeaftDir, [sMulti.id], 'DELTA_SLICE_TOKEN', now + 1000).results).toHaveLength(1);
    } finally {
      dbMulti.close();
    }
  });
});
