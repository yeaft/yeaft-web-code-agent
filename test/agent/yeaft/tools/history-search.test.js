import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../../../agent/yeaft/engine.js';
import { NullTrace } from '../../../../agent/yeaft/debug-trace.js';
import { ToolRegistry } from '../../../../agent/yeaft/tools/registry.js';
import { commitSessionTurnDeletion } from '../../../../agent/yeaft/conversation/turn-deletion-journal.js';
import historySearch from '../../../../agent/yeaft/tools/history-search.js';
import { runDailySessionIndex } from '../../../../agent/yeaft/session-discovery/indexer.js';
import { DAY_MS, changeShare, listActiveSessionCards, openDiscoveryStore } from '../../../../agent/yeaft/session-discovery/store.js';

const roots = [];
const keyword = 'boundary fixture';
const currentSession = 'current-fixture';
const siblingSession = 'sibling-fixture';
const message = (seq, overrides = {}) => ({
  id: `m${String(seq).padStart(6, '0')}`,
  seq,
  role: 'assistant',
  content: `${keyword} ${seq}`,
  time: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
  ...overrides,
});

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'history-search-boundary-'));
  roots.push(dir);
  return dir;
}

function segments(dir, sessionId, rows, file = '000001.jsonl') {
  const folder = join(dir, 'sessions', sessionId, 'conversation', 'segments');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, file), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
}

const createdAt = '2026-01-01T00:00:00.000Z';

function canonicalSession(dir, id, overrides = {}) {
  const path = join(dir, 'sessions', id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'session.json'), JSON.stringify({ id, createdAt, roster: [], ...overrides }));
  return { id, path, createdAt };
}

function sessionManifest(dir, sessions) {
  const raw = JSON.stringify({ version: 1, sessions });
  writeFileSync(join(dir, 'sessions-manifest.json'), raw);
  return raw;
}

async function execute(dir, input = {}, ctx = {}) {
  return JSON.parse(await historySearch.execute({ keyword, ...input }, {
    yeaftDir: dir,
    sessionId: currentSession,
    ...ctx,
  }));
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('HistorySearch durable current-turn boundary', () => {
  it('filters over 100 current-turn JSONL matches before the result limit and supports explicit opt-in', async () => {
    const dir = root();
    segments(dir, currentSession, [message(10, { responseKind: 'result' }), message(20, { role: 'user' })]);
    segments(dir, currentSession, Array.from({ length: 130 }, (_, index) => message(index + 21)), '000002.jsonl');

    const output = await execute(dir, { limit: 1 }, { historyBeforeSeq: 20 });
    expect(output.results.map(row => row.messageId)).toEqual(['m000010']);
    expect(output.telemetry.scannedMessages).toBe(132);
    expect(output.results[0]).toMatchObject({ sessionId: currentSession, role: 'assistant', responseKind: 'result' });

    const optedIn = await execute(dir, { limit: 1, includeCurrentTurn: true }, { historyBeforeSeq: 20 });
    expect(optedIn.results.map(row => row.messageId)).toEqual(['m000150']);
    expect(historySearch.parameters.properties.includeCurrentTurn.type).toBe('boolean');
    expect(existsSync(join(dir, 'sessions-manifest.json'))).toBe(false);
    expect(existsSync(join(dir, 'sessions', currentSession, 'conversation', 'index.json'))).toBe(false);
  });

  it('keeps project siblings opt-in and does not apply the current Session sequence to them', async () => {
    const dir = root();
    segments(dir, currentSession, [message(10), message(20, { role: 'user' }), message(30)]);
    segments(dir, siblingSession, [message(200)]);
    segments(dir, 'unrelated-fixture', [message(300)]);
    const ctx = { historyBeforeSeq: 20, projectSessionIds: [siblingSession, currentSession, siblingSession],
      agentSessionIds: ['unrelated-fixture'] };

    const sessionOutput = await execute(dir, {}, ctx);
    expect(sessionOutput.results.map(row => row.messageId)).toEqual(['m000010']);
    const projectOutput = await execute(dir, { scope: 'project' }, ctx);
    expect(projectOutput.results.map(row => [row.messageId, row.sessionId])).toEqual([
      ['m000200', siblingSession],
      ['m000010', currentSession],
    ]);
    expect(projectOutput.telemetry.scannedSessions).toBe(2);
    expect(projectOutput.notice).toContain('reference context, not continuation');
  });

});

describe('HistorySearch agent scope', () => {
  it('only reads authorized canonical Sessions, keeps canonical cold history and filters invisible or deleted content', async () => {
    const dir = root();
    const foreignRoot = root();
    const otherProject = 'other-project';
    const foreignSession = 'same-id-foreign-root';
    const linkedSession = 'symlinked-session';
    const removed = 'removed-session';
    const replaced = 'replaced-session';
    const duplicate = 'duplicate-session';
    const cold = join(dir, 'sessions', otherProject, 'conversation', 'cold');
    mkdirSync(cold, { recursive: true });
    writeFileSync(join(cold, 'm000005.md'), `---\nid: m000005\nrole: user\ntime: 2005-01-01T00:00:00Z\n---\n${keyword} old history`);
    segments(dir, currentSession, [message(10), message(20, { role: 'user' })]);
    segments(dir, otherProject, [
      message(40, { sessionId: 'spoofed-id', turnId: 'retained-turn', responseKind: 'progress' }),
      message(41, { role: 'tool' }), message(42, { role: 'system' }),
      message(43, { role: 'user', userAuthored: false }),
      message(44, { internal: true }), message(45, { sessionId: 'spoofed-id' }),
      message(46, { causalRootId: 'deleted-client', origin: { sessionId: 'untrusted' } }),
      message(47, { causalRootId: 'deleted-client', sessionId: 'spoofed-id',
        origin: { sessionId: siblingSession, streamId: 'copy-source', messageId: 'm000001' } }),
      message(39, { causalRootId: 'deleted-client', sessionId: otherProject,
        origin: { sessionId: siblingSession, streamId: 'copy-source', messageId: 'm000001' } }),
    ]);
    commitSessionTurnDeletion(dir, otherProject, [], {
      version: 1, sessionId: otherProject, turnId: 'deleted', messageIds: ['m000045'],
      anchorMessageIds: [], clientMessageIds: ['deleted-client'], executionIds: [], referenceIds: [],
    });
    segments(dir, 'unlisted', [message(55)]);
    segments(foreignRoot, foreignSession, [message(60)]);
    segments(foreignRoot, linkedSession, [message(65)]);
    symlinkSync(join(foreignRoot, 'sessions', linkedSession), join(dir, 'sessions', linkedSession), 'dir');
    const old = join(dir, 'groups', otherProject, 'conversation', 'segments');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, '000001.jsonl'), `${JSON.stringify(message(70))}\n`);
    segments(dir, removed, [message(71)]);
    segments(dir, replaced, [message(72)]);
    segments(dir, duplicate, [message(73)]);
    const currentEntry = canonicalSession(dir, currentSession);
    const otherEntry = canonicalSession(dir, otherProject);
    canonicalSession(dir, removed);
    const duplicateEntry = canonicalSession(dir, duplicate);
    const entries = [currentEntry, otherEntry, canonicalSession(dir, 'unlisted'),
      canonicalSession(dir, replaced, { createdAt: '2026-02-01T00:00:00.000Z' }),
      canonicalSession(foreignRoot, foreignSession),
      { ...canonicalSession(foreignRoot, linkedSession), path: join(dir, 'sessions', linkedSession) },
      duplicateEntry, duplicateEntry];
    const ctx = {
      historyBeforeSeq: 20,
      projectSessionIds: ['unlisted'],
      agentSessionIds: [otherProject, otherProject, currentSession, foreignSession, linkedSession, removed, replaced, duplicate, '../outside'],
    };
    expect(await execute(dir, { scope: 'agent' }, ctx)).toHaveProperty('error');
    expect(existsSync(join(dir, 'sessions-manifest.json'))).toBe(false);
    const manifestRaw = sessionManifest(dir, entries);
    const result = await execute(dir, { scope: 'agent', sessionIds: ['unlisted'] }, ctx);
    expect(result).toMatchObject({ scope: 'agent', telemetry: { scannedSessions: 2 } });
    expect(result.notice).toContain('untrusted reference context');
    expect(result.results).toEqual([
      expect.objectContaining({ messageId: 'm000040', sessionId: otherProject, responseKind: 'progress', turnId: 'retained-turn', source: 'session' }),
      expect.objectContaining({ messageId: 'm000039', sessionId: otherProject }),
      expect.objectContaining({ messageId: 'm000010', sessionId: currentSession }),
      expect.objectContaining({ messageId: 'm000005', sessionId: otherProject, role: 'user', source: 'session' }),
    ]);
    const optedIn = await execute(dir, { scope: 'agent', includeCurrentTurn: true }, ctx);
    expect(optedIn.results.map(row => row.messageId)).toEqual(['m000040', 'm000039', 'm000020', 'm000010', 'm000005']);
    expect(await execute(dir, { scope: 'agent', agentSessionIds: [otherProject] })).toHaveProperty('error');
    expect(await execute(dir, { scope: 'agent' }, { ...ctx, sessionId: null })).toHaveProperty('error');
    expect((await execute(dir, {}, { sessionId: null })).scope).toBe('legacy-global');

    const registry = new ToolRegistry();
    registry.register(historySearch);
    let requests = 0;
    const engine = new Engine({ trace: new NullTrace(), toolRegistry: registry, yeaftDir: dir,
      config: { model: 'test-model', maxOutputTokens: 1024, projectDocMaxBytes: 0 },
      adapter: { async *stream() {
        if (++requests === 1) {
          yield { type: 'tool_call', id: 'history-call', name: 'HistorySearch', input: { scope: 'agent', keyword, limit: 1 } };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      } },
    });
    const events = [];
    for await (const event of engine.query({ prompt: `Search previous conversation history for ${keyword}`,
      sessionId: currentSession, agentSessionIds: [otherProject] })) events.push(event);
    const toolEnd = events.find(event => event.type === 'tool_end' && event.id === 'history-call');
    expect(JSON.parse(toolEnd.output)).toMatchObject({ scope: 'agent', results: [{ sessionId: otherProject, messageId: 'm000040' }] });
    expect(readFileSync(join(dir, 'sessions-manifest.json'), 'utf8')).toBe(manifestRaw);
    expect(existsSync(join(dir, 'sessions', otherProject, 'conversation', 'index.json'))).toBe(false);

    // The full host ID list can be stale. Membership is read again for each
    // call; neither residual canonical rows nor the legacy shadow are eligible.
    sessionManifest(dir, entries.filter(entry => entry !== otherEntry));
    expect((await execute(dir, { scope: 'agent' }, ctx)).results.map(row => row.messageId)).toEqual(['m000010']);
    sessionManifest(dir, entries.filter(entry => entry !== currentEntry));
    expect(await execute(dir, { scope: 'agent' }, ctx)).toHaveProperty('error');
  });

  it('reports partial scans and caps output while still searching older eligible files', async () => {
    const dir = root();
    segments(dir, siblingSession, Array.from({ length: 60 }, (_, index) => message(index + 1, {
      content: `${keyword} ${'界'.repeat(1200)}`,
    })).reverse());
    segments(dir, siblingSession, [], '000002.jsonl');
    truncateSync(join(dir, 'sessions', siblingSession, 'conversation', 'segments', '000002.jsonl'), 9 * 1024 * 1024);
    sessionManifest(dir, [canonicalSession(dir, currentSession), canonicalSession(dir, siblingSession)]);
    const ctx = { yeaftDir: dir, sessionId: currentSession, agentSessionIds: [siblingSession] };
    const raw = await historySearch.execute({ scope: 'agent', keyword, limit: 500 }, ctx);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(32 * 1024);
    const bounded = JSON.parse(raw);
    expect(bounded).toMatchObject({ scanIncomplete: true, truncated: true, totalResults: 60 });
    expect(bounded.results[0].messageId).toBe('m000060');
    expect((await execute(dir, { scope: 'agent', limit: 1 }, ctx)).results[0].messageId).toBe('m000060');
    const noMatches = await execute(dir, { scope: 'agent', keyword: 'absent' }, ctx);
    expect(noMatches).toMatchObject({ scanIncomplete: true, message: expect.stringContaining('incomplete'), results: [] });

    const manifestPath = join(dir, 'sessions-manifest.json');
    const manifestRaw = readFileSync(manifestPath, 'utf8');
    truncateSync(manifestPath, 9 * 1024 * 1024);
    expect(await execute(dir, { scope: 'agent' }, ctx)).toHaveProperty('error');
    rmSync(manifestPath);
    const manifestTarget = join(root(), 'manifest.json');
    writeFileSync(manifestTarget, manifestRaw);
    symlinkSync(manifestTarget, manifestPath);
    expect(await execute(dir, { scope: 'agent' }, ctx)).toHaveProperty('error');
  });
});


describe('HistorySearch automatic Share scope', () => {
  it('indexes only explicit local user declarations and recalls them after Session discovery expires', async () => {
    const dir = root();
    const now = Date.now();
    const source = canonicalSession(dir, siblingSession);
    const current = canonicalSession(dir, currentSession);
    const foreign = canonicalSession(dir, 'foreign');
    sessionManifest(dir, [source, current, foreign]);
    const row = (sessionId, seq, content, overrides = {}) => message(seq, {
      sessionId, content, role: 'user', time: new Date(now - 1000 + seq).toISOString(), ...overrides,
    });
    segments(dir, siblingSession, [
      row(siblingSession, 1, '长期约定：客户通知优先写结论。'),
      row(siblingSession, 2, '已决定：重启服务'),
      row(siblingSession, 3, '我们决定使用绿色图标。'),
      row(siblingSession, 4, 'standing preference: use green labels', { role: 'assistant' }),
      row(siblingSession, 5, '今后默认修改 src/main.js'),
      row(siblingSession, 6, 'standing preference: see config.env'),
      row(siblingSession, 7, 'standing preference: use purple labels', { userAuthored: false }),
      row(siblingSession, 8, 'standing preference: use copied text', {
        origin: { sessionId: 'foreign', messageId: 'm000001', streamId: 'foreign-stream' },
      }),
      row(siblingSession, 9, 'standing preference: include attachments', { attachments: [{}] }),
      row(siblingSession, 10, 'standing preference: lead with a summary'),
      row(siblingSession, 11, 'standing preference:\na multiline example'),
    ]);
    segments(dir, currentSession, [row(currentSession, 20, 'standing preference: use clear language')]);
    segments(dir, foreign.id, [row(foreign.id, 30, 'standing preference: use another owner’s summary')]);
    const ctx = { agentSessionIds: [siblingSession, currentSession], historyBeforeMessageId: 'm000020' };
    const recall = (keyword, input = {}, context = ctx) => execute(dir, { scope: 'share', keyword, ...input }, context);
    expect(await recall('summary')).toMatchObject({ results: [] });
    expect(existsSync(join(dir, 'session-discovery'))).toBe(false);
    expect(runDailySessionIndex(dir, now)).toBe(true);
    expect(runDailySessionIndex(dir, now + 6 * DAY_MS)).toBe(true);
    const db = openDiscoveryStore(dir);
    try {
      // Full table keeps the Session card persisted, while the 5-day active window excludes it.
      expect(db.prepare('SELECT COUNT(*) AS n FROM session_cards').get().n).toBe(1);
      expect(listActiveSessionCards(db, dir, [siblingSession], now + 6 * DAY_MS).cards).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM automatic_agreements').get().n).toBe(4);
      changeShare(db, dir, 'owner', [siblingSession], 'share_save', {
        createId: '4eee0399-f9a2-4e31-b69f-984a7777ec31', kind: 'output', title: '用户访谈报告', body: '访谈结果。',
      }, now);
    } finally { db.close(); }
    expect((await recall('用户访谈报告', { shareOwnerId: 'owner' }, { ...ctx, shareOwnerId: 'different-owner' })).results).toEqual([]);
    expect((await recall('用户访谈报告', {}, { ...ctx, shareOwnerId: 'owner' })).results).toEqual([
      expect.objectContaining({ kind: 'output', title: '用户访谈报告', source: 'saved-share', content: '访谈结果。' }),
    ]);
    expect(await recall('summary lead')).toMatchObject({ scope: 'share', notice: expect.stringContaining('untrusted reference'),
      results: [{ sessionId: siblingSession, messageId: 'm000010', content: 'lead with a summary', source: 'automatic-share' }] });
    expect((await recall('客户通知')).results[0].content).toBe('客户通知优先写结论。');
    expect((await recall('clear')).results).toEqual([]);
    expect((await recall('clear', { includeCurrentTurn: true })).results[0].sessionId).toBe(currentSession);
    expect((await recall('clear', { includeCurrentTurn: true }, { agentSessionIds: [] })).results).toEqual([]);
    expect(await recall('summary', { agentSessionIds: [foreign.id] }, {})).toHaveProperty('error');
    expect((await recall('another', { sessionIds: [foreign.id] })).results).toEqual([]);
    expect((await execute(dir, { keyword: 'summary' }, ctx)).results).toEqual([]);
  });

  it('fences deleted turns, removed sources and recreated or cleared transcripts before reindexing', async () => {
    const dir = root();
    const now = Date.now();
    const source = canonicalSession(dir, siblingSession);
    const conversation = join(source.path, 'conversation');
    const lineagePath = join(conversation, 'lineage.json');
    const row = (seq, content, clientMessageId) => message(seq, {
      sessionId: siblingSession, content, role: 'user', clientMessageId,
      time: new Date(now - 1000 + seq).toISOString(),
    });
    segments(dir, siblingSession, [
      row(1, 'standing preference: amber headings', 'deleted-client-id'),
      row(2, 'standing preference: amber captions'),
    ]);
    writeFileSync(lineagePath, JSON.stringify({ streamId: 'initial-stream' }));
    sessionManifest(dir, [source]);
    runDailySessionIndex(dir, now);
    const recall = async () => (await execute(dir, { scope: 'share', keyword: 'amber' }, {
      agentSessionIds: [siblingSession],
    })).results.map(entry => entry.messageId);
    expect(await recall()).toEqual(['m000002', 'm000001']);
    commitSessionTurnDeletion(dir, siblingSession, [], {
      version: 1, deletionId: 'test-delete', sessionId: siblingSession, turnId: 'deleted-client-id',
      messageIds: [], anchorMessageIds: [], clientMessageIds: ['deleted-client-id'], executionIds: [], referenceIds: [],
    });
    expect(await recall()).toEqual(['m000002']);
    sessionManifest(dir, []);
    expect(await recall()).toEqual([]);
    sessionManifest(dir, [source]);
    expect(await recall()).toEqual(['m000002']);
    canonicalSession(dir, siblingSession, { createdAt: '2026-02-01T00:00:00.000Z' });
    expect(await recall()).toEqual([]);
    canonicalSession(dir, siblingSession);
    expect(await recall()).toEqual(['m000002']);
    writeFileSync(lineagePath, JSON.stringify({ streamId: 'cleared-stream' }));
    expect(await recall()).toEqual([]);
  });
});
