import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import historySearch from '../../../../agent/yeaft/tools/history-search.js';

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

});
