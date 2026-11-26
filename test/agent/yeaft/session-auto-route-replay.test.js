import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { closeConversationHistoryIndexes } from '../../../agent/yeaft/conversation/history-index.js';
import { createSessionFromSpec } from '../../../agent/yeaft/sessions/session-crud.js';
import { seedDefaultVps } from '../../../agent/yeaft/vp/seed-defaults.js';
import {
  assertDisjointTrees,
  buildHistoryPoints,
  loadSourceInstance,
  replayPass,
  summarize,
} from '../../../scripts/auto-route-replay.mjs';

let tempRoot = null;

afterEach(async () => {
  await closeConversationHistoryIndexes();
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function snapshotTree(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...snapshotTree(path));
    else {
      const st = statSync(path);
      out.push(`${path}:${st.size}:${st.mtimeMs}`);
    }
  }
  return out.sort();
}

describe('auto-route historical replay harness', () => {
  it('labels create/continue/supplement/AskUser points and replays each one point-in-time without touching the source or leaking later rows', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-route-replay-'));
    const source = join(tempRoot, 'source');
    mkdirSync(source, { recursive: true });
    seedDefaultVps(join(source, 'virtual-persons'));
    const store = new ConversationStore(source);
    const sAlpha = createSessionFromSpec(source, { name: 'Alpha', sceneId: 'software' });
    const sBeta = createSessionFromSpec(source, { name: 'Beta', sceneId: 'writing' });
    const base = Date.now() + 60_000;
    const at = minutes => new Date(base + minutes * 60_000).toISOString();
    store.appendBatch([
      { role: 'user', sessionId: sAlpha.id, userTurnId: 'ua1', relation: 'new', content: 'ALPHA_START 搭一个健康检查服务', time: at(0) },
      { role: 'assistant', sessionId: sAlpha.id, userTurnId: 'ua1', turnId: 'ta1', responseKind: 'result', stopReason: 'end_turn', content: '服务骨架已搭好', time: at(2) },
      { role: 'user', sessionId: sBeta.id, userTurnId: 'ub1', relation: 'new', content: 'BETA_START 帮我写本周周报', time: at(3) },
      { role: 'assistant', sessionId: sBeta.id, userTurnId: 'ub1', turnId: 'tb1', content: '', toolCalls: [{ id: 'call_ask', name: 'AskUser', input: { question: '周报写给谁？', options: ['老板', '团队'] } }], time: at(4) },
      { role: 'tool', sessionId: sBeta.id, userTurnId: 'ub1', toolCallId: 'call_ask', content: JSON.stringify({ question: '周报写给谁？', answers: { '周报写给谁？': '团队' } }), time: at(6) },
      { role: 'user', sessionId: sBeta.id, userTurnId: 'ub1', relation: 'supplement', content: '语气轻松一点', time: at(7) },
      { role: 'assistant', sessionId: sBeta.id, userTurnId: 'ub1', turnId: 'tb1', responseKind: 'result', stopReason: 'end_turn', content: '周报已写好', time: at(9) },
      { role: 'user', sessionId: sAlpha.id, userTurnId: 'ua2', relation: 'new', content: 'ALPHA_FOLLOW 再加一个就绪探针', time: at(10) },
      { role: 'assistant', sessionId: sAlpha.id, userTurnId: 'ua2', turnId: 'ta2', responseKind: 'result', stopReason: 'end_turn', content: 'FUTURE_ONLY_TOKEN 已加就绪探针', time: at(12) },
    ]);
    const before = snapshotTree(source);

    const sessions = loadSourceInstance(source);
    const points = buildHistoryPoints(sessions);
    expect(points.map(p => [p.kind, p.text, p.expect, p.truthSessionIds[0]])).toEqual([
      ['history', 'ALPHA_START 搭一个健康检查服务', 'create', sAlpha.id],
      ['history', 'BETA_START 帮我写本周周报', 'create', sBeta.id],
      ['askuser', '团队', 'continue', sBeta.id],
      ['history', '语气轻松一点', 'continue', sBeta.id],
      ['history', 'ALPHA_FOLLOW 再加一个就绪探针', 'continue', sAlpha.id],
    ]);
    expect(points[2]).toMatchObject({ answeredRequestId: 'call_ask', optionAnswer: true });
    expect(points[3].supplement).toBe(true);

    const prompts = [];
    const arbiter = {
      async call(params) {
        const payload = JSON.parse(params.messages[0].content);
        prompts.push({ query: payload.newQuery, payload, raw: params.messages[0].content });
        if (!Array.isArray(payload.candidates)) return { text: '{"sceneId":"software","workDir":"","title":"新任务"}' };
        const owner = payload.candidates.find(c => (payload.newQuery.includes('ALPHA') && c.title === 'Alpha')
          || (!payload.newQuery.includes('ALPHA') && c.status === 'running'));
        return {
          text: JSON.stringify(owner
            ? { decision: 'match', sessionId: owner.id, answeredRequestId: null, confidence: 0.9, reason: 'owner' }
            : { decision: 'create', sessionId: null, answeredRequestId: null, confidence: 0.9, sceneId: 'writing', workDir: '', title: '周报', reason: 'new' }),
        };
      },
    };
    const results = await replayPass({
      sessions,
      sourceDir: source,
      outDir: join(tempRoot, 'out'),
      points,
      adapter: arbiter,
      config: { decisionModel: 'proxy/decision-mini' },
      collect: true,
    });

    expect(results.map(r => [r.category, r.correct, r.answeredOk])).toEqual([
      ['new-session', true, true],
      ['new-session', true, true],
      ['askuser-option', true, true],
      ['running-supplement', true, true],
      ['continue-recent', true, true],
    ]);
    // The exact pending-option answer settles AskUser without an LLM call.
    expect(results[2].decision).toMatchObject({ routeSource: 'fast_path', answeredRequestId: 'call_ask', sessionId: sBeta.id });
    // Beta is still mid-turn when the supplement arrives.
    const supplementPrompt = prompts.find(p => p.query === '语气轻松一点');
    expect(supplementPrompt.payload.candidates.find(c => c.id === sBeta.id)).toMatchObject({ status: 'running' });
    // Point-in-time: Alpha's later reply never leaks into the prompt for the message it answers.
    const followPrompt = prompts.find(p => p.query.startsWith('ALPHA_FOLLOW'));
    expect(followPrompt.raw).toContain('服务骨架已搭好');
    expect(followPrompt.raw).toContain('周报已写好');
    expect(followPrompt.raw).not.toContain('FUTURE_ONLY_TOKEN');
    expect(prompts.some(p => p.raw.includes('FUTURE_ONLY_TOKEN'))).toBe(false);

    expect(summarize(results).headline).toMatchObject({ n: 5, accuracy: 100, falseCreates: 0, wrongSession: 0, falseMerges: 0 });
    expect(snapshotTree(source)).toEqual(before);

    // Neutral titles hide current Session names from every replayed prompt.
    prompts.length = 0;
    await replayPass({
      sessions,
      sourceDir: source,
      outDir: join(tempRoot, 'out'),
      points,
      adapter: arbiter,
      config: { decisionModel: 'proxy/decision-mini' },
      collect: true,
      neutralTitles: true,
    });
    const neutralTitlesSeen = prompts.flatMap(p => (p.payload.candidates || []).map(c => c.title));
    expect(neutralTitlesSeen.length).toBeGreaterThan(0);
    expect(neutralTitlesSeen.some(title => title === 'Alpha' || title === 'Beta')).toBe(false);
  });

  it('refuses an --out tree that overlaps the source instance in either direction', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'yeaft-route-replay-guard-'));
    const source = join(tempRoot, 'C1');
    mkdirSync(join(source, 'sessions'), { recursive: true });
    mkdirSync(join(tempRoot, 'C1-out'), { recursive: true });
    expect(() => assertDisjointTrees(source, join(source, 'out', 'nested'))).toThrow(/must not contain/);
    expect(existsSync(join(source, 'out'))).toBe(false);
    expect(() => assertDisjointTrees(source, tempRoot)).toThrow(/must not contain/);
    expect(() => assertDisjointTrees(source, source)).toThrow(/must not contain/);
    expect(() => assertDisjointTrees(source, join(tempRoot, 'C1-out'))).not.toThrow();
    if (process.platform === 'win32') {
      expect(() => assertDisjointTrees(source, join(source.toUpperCase(), 'out'))).toThrow(/must not contain/);
    }
  });
});
