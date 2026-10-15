import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import historySearch from '../../../../agent/yeaft/tools/history-search.js';
import { searchMessages } from '../../../../agent/yeaft/conversation/search.js';

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

function markdown(dir, sessionId, storage, rows) {
  const folder = join(dir, 'sessions', sessionId, 'conversation', storage);
  mkdirSync(folder, { recursive: true });
  for (const row of rows) {
    writeFileSync(join(folder, `${row.id}.md`), `---\nid: ${row.id}\nrole: ${row.role}\ntime: ${row.time}\n---\n\n${row.content}`);
  }
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

  it('filters hot and cold Markdown before their limits using a durable message-id fallback', () => {
    const dir = root();
    for (const storage of ['messages', 'cold']) {
      const sessionId = `${currentSession}-${storage}`;
      markdown(dir, sessionId, storage, [message(10), ...Array.from({ length: 110 }, (_, index) => message(index + 20))]);
      const results = searchMessages(dir, keyword, 1, {
        sessionIds: [sessionId],
        boundarySessionId: sessionId,
        beforeSeq: Infinity,
        beforeMessageId: 'm000020',
      });
      expect(results.map(row => row.id)).toEqual(['m000010']);
    }
  });

  it('uses the transcript owner for sequence boundaries and source metadata, never a sibling row identity', () => {
    const dir = root();
    segments(dir, currentSession, [message(10), message(30, { sessionId: siblingSession })]);
    segments(dir, siblingSession, [message(200, { sessionId: currentSession })]);
    segments(dir, 'unrelated-fixture', [message(300)]);

    const results = searchMessages(dir, keyword, 100, {
      sessionIds: [currentSession, siblingSession],
      boundarySessionId: currentSession,
      beforeSeq: 20,
    });
    expect(results.map(row => [row.id, row.sessionId])).toEqual([
      ['m000200', siblingSession],
      ['m000010', currentSession],
    ]);
  });

  it('keeps project siblings opt-in and does not apply the current Session sequence to them', async () => {
    const dir = root();
    segments(dir, currentSession, [message(10), message(20, { role: 'user' }), message(30)]);
    segments(dir, siblingSession, [message(200)]);
    segments(dir, 'unrelated-fixture', [message(300)]);
    const ctx = { historyBeforeSeq: 20, projectSessionIds: [siblingSession, currentSession, siblingSession] };

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

  it('preserves unbounded legacy behavior without a trusted finite boundary and validates opt-in', async () => {
    const dir = root();
    segments(dir, currentSession, [message(10), message(20, { role: 'user' })]);
    for (const ctx of [{}, { historyBeforeSeq: NaN }, { historyBeforeSeq: Infinity }, { historyBeforeSeq: '20' }, { historyBeforeMessageId: 'not-monotonic' }]) {
      const output = await execute(dir, { limit: 1 }, ctx);
      expect(output.results.map(row => row.messageId)).toEqual(['m000020']);
    }
    const globalOutput = await execute(dir, { limit: 1 }, { sessionId: undefined, historyBeforeSeq: 20 });
    expect(globalOutput.scope).toBe('legacy-global');
    expect(globalOutput.results.map(row => row.messageId)).toEqual(['m000020']);
    const invalid = await execute(dir, { includeCurrentTurn: 'true' }, { historyBeforeSeq: 20 });
    expect(invalid.error).toBe('includeCurrentTurn must be a boolean');
  });

  it('prefers a finite sequence, falls back to durable ids, and does not infer timestamps or unsequenced rows', async () => {
    const dir = root();
    segments(dir, currentSession, [
      message(10),
      message(20, { role: 'user' }),
      message(30, { seq: undefined }),
      message(40, { id: 'legacy-unsequenced', seq: undefined, time: '2099-01-01T00:00:00.000Z' }),
    ]);
    const fallback = await execute(dir, {}, { historyBeforeMessageId: 'm000020' });
    expect(fallback.results.map(row => row.messageId)).toEqual(['legacy-unsequenced', 'm000010']);
    const finite = await execute(dir, {}, { historyBeforeSeq: 30, historyBeforeMessageId: 'm000010' });
    expect(finite.results.map(row => row.messageId)).toEqual(['legacy-unsequenced', 'm000020', 'm000010']);
  });

  it('distinguishes user context, assistant progress/plans and reported results without claiming verification', async () => {
    const dir = root();
    segments(dir, currentSession, [
      message(10, { role: 'user', content: `${keyword} please implement the plan` }),
      message(11, { responseKind: 'progress', content: `${keyword} I will implement the plan` }),
      message(12, { responseKind: 'result', content: `${keyword} implementation reported complete`, providerState: { private: 'not projected' } }),
      message(13),
      message(14, { role: 'tool' }),
      message(15, { internal: true }),
      message(20, { role: 'user' }),
    ]);
    const output = await execute(dir, {}, { historyBeforeSeq: 20 });
    expect(output.results.map(row => [row.role, row.responseKind])).toEqual([
      ['assistant', null],
      ['assistant', 'result'],
      ['assistant', 'progress'],
      ['user', null],
    ]);
    expect(output.notice).toContain('progress may describe plans');
    expect(output.notice).toContain('not independently verified evidence');
    expect(JSON.stringify(output)).not.toContain('not projected');
    expect(JSON.stringify(output)).not.toContain('providerState');
  });
});
