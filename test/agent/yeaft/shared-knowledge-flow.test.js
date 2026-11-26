import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore } from '../../../agent/yeaft/conversation/persist.js';
import { commitSessionTurnDeletion } from '../../../agent/yeaft/conversation/turn-deletion-journal.js';
import { createSessionFromSpec } from '../../../agent/yeaft/sessions/session-crud.js';
import { runDailySharedKnowledge } from '../../../agent/yeaft/shared-knowledge/flow.js';
import { latestKnowledgeSlot, openKnowledgeSourceWorker } from '../../../agent/yeaft/shared-knowledge/scheduler.js';
import { openKnowledgeWriter, readKnowledgeWatermark, searchSharedKnowledge } from '../../../agent/yeaft/shared-knowledge/store.js';

const day = 86_400_000;
const at = new Date(2026, 10, 26, 1).getTime();
const slot = 20261126;
const text = '以后默认应用 PR 校验。';
let root, history, a, b;

function append(session, content, createdAt = at - 20, role = 'user') {
  return history.append({ role, content, sessionId: session.id, ts: new Date(createdAt).toISOString(),
    ...(role === 'assistant' ? { responseKind: 'result' } : {}) });
}

const note = { title: '发布校验', body: '发布必须经 PR 校验。', tags: ['发布校验', 'PR'] };
const item = (seq, overrides = {}) => ({ ...note, dimension: 'preference_rule', scope: 'agent', evidenceSeqs: [seq], ...overrides });
function model(extract = messages => messages.map(row => item(row.seq)), merge = (candidates, existing) => [{
  action: existing.length ? 'update' : 'add', candidateIds: candidates.map(c => c.id), targetId: existing[0]?.id, ...note,
}]) {
  const call = vi.fn(async ({ system, messages }) => {
    const payload = JSON.parse(messages[0].content);
    const result = system.startsWith('Extract')
      ? { items: await extract(payload.messages) } : { actions: await merge(payload.candidates, payload.existing) };
    return { text: JSON.stringify(result) };
  });
  return { open: async () => ({ adapter: { call }, config: { primaryModel: 'fake' } }), call };
}

function run(fake, overrides = {}) {
  return runDailySharedKnowledge({ root, slot, cutoff: at, clock: () => at,
    openSource: signal => openKnowledgeSourceWorker(root, signal), openModel: fake.open, ...overrides });
}

function lookup(ids = [a.id, b.id], options = {}) {
  return searchSharedKnowledge(root, ids, { query: '发布校验', ...options });
}
function cursor(session) {
  const db = openKnowledgeWriter(root);
  try { return readKnowledgeWatermark(db, session.id); } finally { db.close(); }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daily-knowledge-'));
  history = new ConversationStore(root);
  a = createSessionFromSpec(root, { name: 'Fixture A' });
  b = createSessionFromSpec(root, { name: 'Fixture B' });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('one daily shared knowledge flow', () => {
  it('uses local 01:00 as the schedule and calculates the elapsed slot on catch-up', () => {
    expect(latestKnowledgeSlot(at - 1)).toBe(20261125);
    expect(latestKnowledgeSlot(at)).toBe(slot);
    expect(latestKnowledgeSlot(at + 20 * 3_600_000)).toBe(slot);
    expect(latestKnowledgeSlot(new Date(2027, 0, 1, 0, 10).getTime())).toBe(20261231);
  });

  it('bootstraps five days, merges across Sessions, enforces scope, and only processes later rows', async () => {
    append(a, '超出回溯窗口', at - 5 * day - 1);
    const r1 = append(a, text, at - 5 * day);
    const r2 = append(b, '发布统一走 PR。');
    expect(lookup()).toEqual([]); // Not an initialized knowledge schema.
    const initial = model();
    expect(await run(initial)).toMatchObject({ status: 'ok', sessions: 2, messages: 2, notes: 1, modelCalls: 3 });
    const [first] = lookup();
    expect(first).toMatchObject({ ...note, sources: expect.arrayContaining([
      { sessionId: a.id, messageId: r1.id, seq: r1.seq }, { sessionId: b.id, messageId: r2.id, seq: r2.seq },
    ]) });
    expect(lookup([a.id])).toEqual([]);
    expect(lookup([a.id, b.id], { sessionId: b.id, beforeSeq: r2.seq })).toEqual([]);
    expect(lookup([a.id, b.id], { query: '" OR *' })).toEqual([]);
    const later = append(a, '这也适用于补丁发布。', at + 1);
    expect(await run(initial)).toMatchObject({ status: 'done', modelCalls: 0 });
    const next = model();
    expect(await run(next, { slot: 20261205, cutoff: at + 9 * day })).toMatchObject({ status: 'ok', messages: 1, notes: 1, modelCalls: 2 });
    expect(lookup()[0].id).toBe(first.id);
    expect(cursor(a).lastSeq).toBe(later.seq);
    const path = join(root, 'sessions', a.id, 'session.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path)), archivedAt: new Date(at).toISOString() }));
    expect(lookup()).toEqual([]);
  });

  it('leaves the store empty and advances the watermarks on a valid no-signal decision', async () => {
    const row = append(a, '谢谢');
    const fake = model(() => []);
    expect(await run(fake)).toMatchObject({ status: 'empty', modelCalls: 1, notes: 0 });
    expect(cursor(a).lastSeq).toBe(row.seq);
    expect(lookup()).toEqual([]);
    expect(await run(fake, { slot: 20261127, cutoff: at + day })).toMatchObject({ status: 'empty', modelCalls: 0 });
    expect(fake.call).toHaveBeenCalledTimes(1);
  });

  it('retries without advancing the cursor on malformed consolidation or model failure', async () => {
    const row = append(a, text);
    const invalid = model(undefined, () => [{ action: 'update', candidateIds: ['c1'], targetId: 'forged', ...note }]);
    expect(await run(invalid)).toMatchObject({ status: 'partial', failedSessions: 1 });
    expect(cursor(a)).toBeNull();
    expect(lookup()).toEqual([]);
    const network = model(() => { throw new Error('temporary'); });
    await expect(run(network)).rejects.toMatchObject({ code: 'provider_error' });
    expect(cursor(a)).toBeNull();
    expect(await run(model())).toMatchObject({ status: 'ok', messages: 1 });
    expect(cursor(a).lastSeq).toBe(row.seq);
    expect(lookup()).toHaveLength(1);
  });

  it('does not send recognizable credentials to the provider or permit invented evidence', async () => {
    append(a, 'Standing release policy.\napi_key: test-not-a-real-secret\n-----BEGIN RSA PRIVATE KEY-----\nsynthetic-private-pem-body\n-----END RSA PRIVATE KEY-----');
    const fake = model(rows => {
      expect(rows[0].text).toContain('[private content removed]');
      expect(rows[0].text).not.toContain('test-not-a-real-secret');
      expect(rows[0].text).not.toContain('synthetic-private-pem-body');
      return [item(999_999)];
    });
    expect(await run(fake)).toMatchObject({ status: 'partial', failedSessions: 1 });
    expect(cursor(a)).toBeNull();
    expect(fake.call).toHaveBeenCalledTimes(1);
  });

  it('isolates a consistently malformed extract or merge without skipping that Session on retry', async () => {
    const bad = append(a, '单条错误应当能够重试');
    const good = append(b, text);
    const badExtract = model(rows => [item(rows[0].seq === bad.seq ? 999_999 : rows[0].seq)]);
    expect(await run(badExtract)).toMatchObject({ status: 'partial', messages: 1, notes: 1, failedSessions: 1 });
    expect(cursor(a)).toBeNull();
    expect(cursor(b).lastSeq).toBe(good.seq);
    const latest = append(b, '小版本也需要校验');
    const badMerge = model(rows => [item(rows[0].seq, rows[0].seq === bad.seq ? { tags: ['malformed'] } : {})],
      (candidates, existing) => candidates.some(it => it.tags.includes('malformed'))
        ? [{ action: 'update', candidateIds: candidates.map(c => c.id), targetId: 'invalid', ...note }]
        : [{ action: 'update', candidateIds: candidates.map(c => c.id), targetId: existing[0].id, ...note }]);
    expect(await run(badMerge)).toMatchObject({ status: 'partial', notes: 1, messages: 1, failedSessions: 1 });
    expect(cursor(a)).toBeNull();
    expect(cursor(b).lastSeq).toBe(latest.seq);
    expect(await run(model())).toMatchObject({ status: 'ok', notes: 1, messages: 1 });
    expect(cursor(a).lastSeq).toBe(bad.seq);
  });

  it('keeps predecessor authorization on supersede and only invalidates notes affected by a deletion', async () => {
    const precedent = append(a, text);
    expect(await run(model())).toMatchObject({ status: 'ok' });
    const unrelated = append(a, '谢谢');
    const deletion = row => ({ version: 1, sessionId: a.id, turnId: `t${row.seq}`, deletionId: `d${row.seq}`,
      messageIds: [row.id], anchorMessageIds: [row.id], clientMessageIds: [], executionIds: [], referenceIds: [] });
    commitSessionTurnDeletion(root, a.id, [], deletion(unrelated));
    expect(lookup([a.id])).toHaveLength(1);
    append(b, '后续发布方式调整。', at + 1);
    const replaces = model(undefined, (candidates, old) => [{ ...note, body: old[0].body,
      action: 'supersede', candidateIds: candidates.map(c => c.id), targetId: old[0].id }]);
    expect(await run(replaces, { slot: 20261127, cutoff: at + day })).toMatchObject({ status: 'ok', notes: 1 });
    expect(lookup()).toHaveLength(1);
    expect(lookup([b.id])).toEqual([]);
    commitSessionTurnDeletion(root, a.id, [deletion(unrelated)], deletion(precedent));
    expect(lookup()).toEqual([]);
  });

  it('a concurrent job cannot run the same scheduled slot', async () => {
    append(a, text);
    let release, started;
    const wait = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const first = run(model(async rows => { started(); await wait; return rows.map(row => item(row.seq)); }));
    try {
      await Promise.race([ready, first]);
      expect(await run(model())).toMatchObject({ status: 'busy', modelCalls: 0 });
    } finally { release(); await first; }
    expect(lookup()).toHaveLength(1);
  });
});
