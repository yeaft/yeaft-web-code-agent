import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ConversationStore,
  parseMessage,
  estimateTokens,
  projectVisibleSessionMessages,
} from '../../../../agent/yeaft/conversation/persist.js';
import { searchMessages } from '../../../../agent/yeaft/conversation/search.js';
import historySearch from '../../../../agent/yeaft/tools/history-search.js';
import { createSession } from '../../../../agent/yeaft/sessions/session-store.js';
import { archiveSession, deleteSession } from '../../../../agent/yeaft/sessions/session-crud.js';
import {
  __historyIndexForTest,
  closeConversationHistoryIndexes,
  loadConversationOutlineFromIndex,
  readConversationIndexWindow,
  searchConversationIndex,
  validateConversationIndexAnchor,
} from '../../../../agent/yeaft/conversation/history-index.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-conv-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await closeConversationHistoryIndexes();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── estimateTokens ──────────────────────────────────────────


// ─── parseMessage ────────────────────────────────────────────

const consolidatedHistoryScenarios = [];
function historyScenario(name, run) { consolidatedHistoryScenarios.push({ name, run }); }
async function runConsolidatedHistoryScenarios() {
  for (const scenario of consolidatedHistoryScenarios) {
    try { await scenario.run(); }
    catch (error) { error.message = `[${scenario.name}] ${error.message}`; throw error; }
  }
}

describe('parseMessage', () => {
  it('should parse frontmatter and body', () => {
    const raw = `---
id: m0001
role: user
time: 2026-04-10T10:00:00Z
mode: chat
tokens_est: 10
---

Hello world`;

    const msg = parseMessage(raw);
    expect(msg.id).toBe('m0001');
    expect(msg.role).toBe('user');
    expect(msg.time).toBe('2026-04-10T10:00:00Z');
    expect(msg.mode).toBe('chat');
    expect(msg.tokens_est).toBe(10);
    expect(msg.content).toBe('Hello world');
  });


  it('should parse tool metadata', () => {
    const raw = `---
id: m0002
role: tool
time: 2026-04-10T10:01:00Z
toolCallId: call_123
isError: true
tokens_est: 5
---

Error: not found`;

    const msg = parseMessage(raw);
    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('call_123');
    expect(msg.isError).toBe(true);
  });


  it('should parse clientMessageId for optimistic Yeaft user rows', () => {
    const raw = `---
id: m0041
role: user
time: 2026-05-12T09:00:00Z
sessionId: session_demo
clientMessageId: u_local_123
causalRootId: root_123
tokens_est: 4
---

Hello`;

    const msg = parseMessage(raw);
    expect(msg.role).toBe('user');
    expect(msg.sessionId).toBe('session_demo');
    expect(msg.clientMessageId).toBe('u_local_123');
    expect(msg.causalRootId).toBe('root_123');
    expect(msg.content).toBe('Hello');
  });

  it('round-trips assistant response model metadata', () => {
    const store = new ConversationStore(TEST_DIR);
    store.append({
      role: 'assistant',
      content: 'Completed',
      sessionId: 'session_response_meta',
      model: 'provider/model-v2',
      effort: 'high',
      llmCallCount: 3,
    });

    const [loaded] = new ConversationStore(TEST_DIR).loadAllBySession('session_response_meta');
    expect(loaded).toMatchObject({
      model: 'provider/model-v2',
      effort: 'high',
      llmCallCount: 3,
    });
  });

  it('round-trips Session message quote metadata', () => {
    const store = new ConversationStore(TEST_DIR);
    store.append({
      role: 'user',
      content: 'Follow up',
      sessionId: 'session_quote',
      quote: {
        id: 'm0001',
        role: 'assistant',
        author: 'Linus',
        content: 'Previous answer',
        todos: [{ content: 'Test', status: 'completed' }],
      },
    });

    const [loaded] = store.loadAllBySession('session_quote');
    expect(loaded.quote).toEqual({
      id: 'm0001',
      role: 'assistant',
      author: 'Linus',
      content: 'Previous answer',
      todos: [{ content: 'Test', status: 'completed' }],
    });
  });

  it('round-trips model-only user provenance while legacy rows remain unmarked', () => {
    const store = new ConversationStore(TEST_DIR);
    const legacy = store.append({ role: 'user', content: 'legacy user', sessionId: 'session_provenance' });
    const synthetic = store.append({
      role: 'user',
      content: 'Continue',
      sessionId: 'session_provenance',
      userAuthored: false,
    });

    const restarted = new ConversationStore(TEST_DIR);
    const rows = restarted.loadAllBySession('session_provenance');
    expect(rows).toEqual([
      expect.objectContaining({ id: legacy.id }),
      expect.objectContaining({ id: synthetic.id, userAuthored: false }),
    ]);
    expect(Object.hasOwn(rows[0], 'userAuthored')).toBe(false);
    expect(restarted.loadVisibleBySession('session_provenance', null, 10).messages)
      .toEqual([expect.objectContaining({ id: legacy.id, content: 'legacy user' })]);
  });

  it('round-trips image asset metadata without embedding image bytes', () => {
    const store = new ConversationStore(TEST_DIR);
    const written = store.append({
      role: 'assistant',
      content: '',
      sessionId: 'session_image',
      turnId: 'turn_image',
      images: [{ assetId: 'a'.repeat(64), mimeType: 'image/png', filename: 'result.png', size: 68 }],
    });
    const sessionConversationDir = join(TEST_DIR, 'sessions', 'session_image', 'conversation');
    const persistedFiles = readdirSync(join(sessionConversationDir, 'segments'));
    expect(persistedFiles.length).toBeGreaterThan(0);
    const raw = persistedFiles
      .map(file => readFileSync(join(sessionConversationDir, 'segments', file), 'utf8'))
      .join('\n');
    expect(raw).toContain('"images"');
    expect(raw).toContain('"assetId":"' + 'a'.repeat(64) + '"');
    expect(raw).not.toContain('data:image');

    const [loaded] = store.loadAllBySession('session_image');
    expect(loaded.images).toEqual([
      { assetId: 'a'.repeat(64), mimeType: 'image/png', filename: 'result.png', size: 68 },
    ]);
  });

  it('round-trips the canonical image asset anchor without image bytes', () => {
    const store = new ConversationStore(TEST_DIR);
    store.append({
      role: 'assistant',
      content: 'final response',
      sessionId: 'session_anchor',
      turnId: 'turn_anchor',
      imageAssetAnchor: true,
    });

    const [loaded] = store.loadAllBySession('session_anchor');
    expect(loaded).toMatchObject({
      role: 'assistant',
      turnId: 'turn_anchor',
      imageAssetAnchor: true,
    });
    expect(loaded).not.toHaveProperty('images');
  });

  it('publishes a folded range atomically and restores only its reflection', () => {
    const store = new ConversationStore(TEST_DIR);
    const user = store.append({ role: 'user', content: 'use tools', sessionId: 'session_fold' });
    const assistant = store.append({
      role: 'assistant',
      content: '',
      sessionId: 'session_fold',
      turnId: 'turn_fold',
      toolCalls: [{ id: 'call_fold', name: 'demo', input: {} }],
    });
    const tool = store.append({
      role: 'tool',
      content: 'raw tool result',
      sessionId: 'session_fold',
      turnId: 'turn_fold',
      toolCallId: 'call_fold',
    });

    const reflection = store.foldMessages([assistant, tool], {
      role: 'user',
      content: 'The previous tool call has been folded.',
      sessionId: 'session_fold',
      _reflection: true,
    });

    expect(reflection).toMatchObject({
      _reflection: true,
      foldedMessageIds: [assistant.id, tool.id],
    });
    expect(store.loadRecentBySession('session_fold', Infinity)).toEqual([
      expect.objectContaining({ id: user.id, role: 'user', content: 'use tools' }),
    ]);
    expect(store.loadRecentBySession('session_fold', Infinity, { includeReflections: true })).toEqual([
      expect.objectContaining({ id: user.id, role: 'user', content: 'use tools' }),
      expect.objectContaining({ id: reflection.id, role: 'user', _reflection: true }),
    ]);

    const restarted = new ConversationStore(TEST_DIR);
    expect(restarted.loadRecentBySession('session_fold', Infinity, { includeReflections: true })).toEqual([
      expect.objectContaining({ id: user.id }),
      expect.objectContaining({ id: reflection.id, _reflection: true }),
    ]);
    expect(restarted.loadOlderBySession('session_fold', reflection.seq, 10).messages).toEqual([
      expect.objectContaining({ id: user.id }),
    ]);

    const indexPath = join(TEST_DIR, 'sessions', 'session_fold', 'conversation', 'index.json');
    const staleIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    staleIndex.segments.at(-1).bytes -= 1;
    staleIndex.foldedMessageIds = [];
    writeFileSync(indexPath, `${JSON.stringify(staleIndex, null, 2)}\n`);
    const recovered = new ConversationStore(TEST_DIR);
    expect(recovered.loadRecentBySession('session_fold', Infinity, { includeReflections: true })).toEqual([
      expect.objectContaining({ id: user.id }),
      expect.objectContaining({ id: reflection.id, _reflection: true }),
    ]);
  });

  it('keeps bounded recent reads lazy after folding across multiple segments', () => {
    const store = new ConversationStore(TEST_DIR);
    const sessionId = 'session_fold_bounded';
    const foldedOld = store.append({
      role: 'user',
      content: `old arc ${'x'.repeat(1024 * 1024)}`,
      sessionId,
    });
    store.append({ role: 'user', content: 'older boundary', sessionId });
    store.append({
      role: 'assistant',
      content: `older response ${'y'.repeat(1024 * 1024)}`,
      sessionId,
    });
    store.append({ role: 'user', content: 'previous turn', sessionId });
    store.append({ role: 'assistant', content: 'previous response', sessionId });
    const currentUser = store.append({ role: 'user', content: 'current turn', sessionId });
    const currentAssistant = store.append({ role: 'assistant', content: 'current response', sessionId });
    store.foldMessages([foldedOld], {
      role: 'user',
      content: 'The old arc has been folded.',
      sessionId,
      _reflection: true,
    });

    const conversationDir = join(TEST_DIR, 'sessions', sessionId, 'conversation');
    const segmentDir = join(conversationDir, 'segments');
    const segments = readdirSync(segmentDir).filter(file => file.endsWith('.jsonl')).sort();
    expect(segments).toHaveLength(3);
    expect(store.loadOlderBySession(sessionId, currentUser.seq, 10).messages.map(row => row.id))
      .not.toContain(foldedOld.id);

    // Keep the already-loaded index and matching file sizes, then make the
    // oldest segment unreadable. A bounded newest-to-oldest scan must finish the
    // recent turn window before opening this path. Eager materialization fails.
    const oldestSegmentPath = join(segmentDir, segments[0]);
    chmodSync(oldestSegmentPath, 0o000);
    try {
      expect(store.loadRecentBySession(sessionId, 1).map(row => row.id)).toEqual([
        currentUser.id,
        currentAssistant.id,
      ]);
    } finally {
      chmodSync(oldestSegmentPath, 0o644);
    }
  });

  it('should parse turnId for persisted Yeaft assistant rows', () => {
    const raw = `---
id: m0043
role: assistant
time: 2026-05-12T09:00:00Z
threadId: main
turnId: vp_turn_123
sessionId: session_demo
tokens_est: 4
---

Reply`;

    const msg = parseMessage(raw);
    expect(msg.role).toBe('assistant');
    expect(msg.threadId).toBe('main');
    expect(msg.turnId).toBe('vp_turn_123');
    expect(msg.sessionId).toBe('session_demo');
    expect(msg.content).toBe('Reply');
  });

  // Issue B (PR v0.1.755): forwarded messages persist as ASSISTANT role
  // with speakerVpId stamped to the originating VP, so the history-replay
  // path emits yeaft_output type='assistant' (not type='user'). Verify
  // both fields round-trip through frontmatter.
  it('should parse speakerVpId for route_forward injections', () => {
    const raw = `---
id: m0042
role: assistant
time: 2026-05-12T10:00:00Z
sessionId: grp_demo
speakerVpId: vp-alice
tokens_est: 8
---

Forwarded payload from Alice`;

    const msg = parseMessage(raw);
    expect(msg.role).toBe('assistant');
    expect(msg.speakerVpId).toBe('vp-alice');
    expect(msg.sessionId).toBe('grp_demo');
    expect(msg.content).toBe('Forwarded payload from Alice');
  });
});

// ─── ConversationStore ───────────────────────────────────────

describe('ConversationStore', () => {
  let store;

  beforeEach(() => {
    store = new ConversationStore(TEST_DIR);
  });



  describe('append', () => {


    it('should persist clientMessageId metadata for Yeaft user echo dedupe', () => {
      store.append({
        role: 'user',
        content: 'Hello from UI',
        sessionId: 'session_client_id',
        clientMessageId: 'u_local_456',
      });

      const loaded = store.loadRecentBySession('session_client_id', 10);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].clientMessageId).toBe('u_local_456');
    });

    it('should persist turnId metadata for Yeaft assistant stream correlation', () => {
      store.append({
        role: 'assistant',
        content: 'Turn-bound assistant reply',
        sessionId: 'session_turn_id',
        threadId: 'main',
        turnId: 'vp_turn_456',
      });

      const loaded = store.loadRecentBySession('session_turn_id', 10);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].threadId).toBe('main');
      expect(loaded[0].turnId).toBe('vp_turn_456');
      expect(loaded[0].content).toBe('Turn-bound assistant reply');
    });

    it('should persist visible task lifecycle metadata', () => {
      store.append({
        role: 'assistant',
        content: '[Task finished]\ntaskId: task_1\nstatus: succeeded',
        sessionId: 'session_tasks',
        eventType: 'task_lifecycle',
        taskId: 'task_1',
        taskStatus: 'succeeded',
      });

      const loaded = store.loadRecentBySession('session_tasks', 10);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].eventType).toBe('task_lifecycle');
      expect(loaded[0].taskId).toBe('task_1');
      expect(loaded[0].taskStatus).toBe('succeeded');
      expect(loaded[0].internal).toBeUndefined();
      expect(loaded[0].content).toContain('[Task finished]');
    });


    it('copies the complete durable Session transcript with independent message ids', () => {
      const sourceSessionId = 'session_copy_source';
      const targetSessionId = 'session_copy_target';
      const user = store.append({
        role: 'user',
        content: 'original question',
        sessionId: sourceSessionId,
        clientMessageId: 'client-stable',
      });
      const assistant = store.append({
        role: 'assistant',
        content: 'original answer',
        sessionId: sourceSessionId,
        causalRootId: user.id,
        sourceMessageIds: [user.id, 'external-message-id'],
        toolCalls: [{ id: 'tool-call-stable', name: 'Read', input: {} }],
      });
      const reflection = store.foldMessages([user, assistant], {
        role: 'assistant',
        content: 'folded summary',
        sessionId: sourceSessionId,
        _reflection: true,
        causalRootId: user.id,
      });
      store.moveToCold(user.id);

      // A migration crash can leave an older markdown copy beside segments.
      // It must not create a duplicate in the cloned transcript.
      const legacyDir = join(TEST_DIR, 'sessions', sourceSessionId, 'conversation', 'messages');
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, `${assistant.id}.md`), `---\nid: ${assistant.id}\nrole: assistant\nsessionId: ${sourceSessionId}\n---\nstale duplicate`);

      const { copiedCount, idMap } = store.copySession(sourceSessionId, targetSessionId);
      expect(copiedCount).toBe(3);
      expect(idMap.size).toBe(3);
      const copiedRows = new ConversationStore(TEST_DIR)
        .copySession(targetSessionId, 'session_copy_probe');
      expect(copiedRows.copiedCount).toBe(3);

      const targetSegment = join(TEST_DIR, 'sessions', targetSessionId, 'conversation', 'segments', '000001.jsonl');
      const physicalRows = readFileSync(targetSegment, 'utf8').trim().split('\n').map(JSON.parse);
      expect(physicalRows.map(row => row.content)).toEqual([
        'original question',
        'original answer',
        'folded summary',
      ]);
      expect(physicalRows.map(row => row.id)).toEqual([
        idMap.get(user.id),
        idMap.get(assistant.id),
        idMap.get(reflection.id),
      ]);
      expect(physicalRows[0]).toMatchObject({
        sessionId: targetSessionId,
        clientMessageId: 'client-stable',
        cold: true,
      });
      expect(physicalRows[1]).toMatchObject({
        sessionId: targetSessionId,
        causalRootId: idMap.get(user.id),
        sourceMessageIds: [idMap.get(user.id), 'external-message-id'],
        toolCalls: [{ id: 'tool-call-stable', name: 'Read', input: {} }],
      });
      expect(physicalRows[2]).toMatchObject({
        sessionId: targetSessionId,
        _reflection: true,
        causalRootId: idMap.get(user.id),
        foldedMessageIds: [idMap.get(user.id), idMap.get(assistant.id)],
      });
      expect(store.loadRecentBySession(sourceSessionId, 10).map(row => row.id))
        .not.toContain(idMap.get(reflection.id));
    });

    it('stores many messages in a single JSONL segment with an index', () => {
      for (let i = 0; i < 25; i += 1) {
        store.append({ role: 'user', content: `msg-${i}`, sessionId: 'session_segmented' });
      }

      const segmentPath = join(TEST_DIR, 'sessions', 'session_segmented', 'conversation', 'segments', '000001.jsonl');
      const indexPath = join(TEST_DIR, 'sessions', 'session_segmented', 'conversation', 'index.json');
      expect(existsSync(segmentPath)).toBe(true);
      expect(existsSync(indexPath)).toBe(true);
      expect(readFileSync(segmentPath, 'utf8').trim().split('\n')).toHaveLength(25);
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      expect(index.totalMessages).toBe(25);
      expect(index.nextSeq).toBe(26);
      expect(index.segments).toHaveLength(1);
    });

    it('keeps legacy transcript lineage stable across metadata loss and alternating readers', () => {
      const sessionId = 'session_legacy_lineage';
      store.append({ role: 'user', content: 'legacy question', sessionId });
      store.append({ role: 'assistant', content: 'legacy answer', sessionId });
      const conversationDir = join(TEST_DIR, 'sessions', sessionId, 'conversation');
      const indexPath = join(conversationDir, 'index.json');
      const lineagePath = join(conversationDir, 'lineage.json');
      const legacyIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      delete legacyIndex.streamId;
      delete legacyIndex.revision;
      rmSync(lineagePath, { force: true });
      writeFileSync(indexPath, `${JSON.stringify(legacyIndex, null, 2)}\n`);

      const firstUpgrade = new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId);
      expect(firstUpgrade).toMatchObject({ streamId: expect.stringMatching(/^legacy-/), revision: 0 });

      // Two new readers can race the first migration. Deleting only the sidecar
      // simulates both having observed the same legacy state before publication;
      // the content-derived lineage must still converge.
      rmSync(lineagePath, { force: true });
      expect(new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId)).toEqual(firstUpgrade);

      // Simulate an old reader/writer repeatedly dropping unknown index fields.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const oldIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
        delete oldIndex.streamId;
        delete oldIndex.revision;
        writeFileSync(indexPath, `${JSON.stringify(oldIndex, null, 2)}\n`);
        expect(new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId)).toEqual(firstUpgrade);
      }

      rmSync(indexPath, { force: true });
      const rebuilt = new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId);
      expect(rebuilt).toEqual(firstUpgrade);
      expect(JSON.parse(readFileSync(lineagePath, 'utf8'))).toMatchObject({
        streamId: firstUpgrade.streamId,
        revision: firstUpgrade.revision,
      });
    });

    it('keeps a brand-new transcript lineage stable across index loss and old writers', () => {
      const sessionId = 'session_new_lineage_recovery';
      store.append({ role: 'user', content: 'brand new question', sessionId });
      store.append({ role: 'assistant', content: 'brand new answer', sessionId });
      const conversationDir = join(TEST_DIR, 'sessions', sessionId, 'conversation');
      const indexPath = join(conversationDir, 'index.json');
      const lineagePath = join(conversationDir, 'lineage.json');
      const original = store.getSessionHistoryMetadata(sessionId);
      const originalLineage = JSON.parse(readFileSync(lineagePath, 'utf8'));
      expect(originalLineage.anchor).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));

      rmSync(indexPath, { force: true });
      expect(new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId)).toEqual(original);

      writeFileSync(indexPath, '{broken-json');
      expect(new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId)).toEqual(original);

      const oldIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
      delete oldIndex.streamId;
      delete oldIndex.revision;
      writeFileSync(indexPath, `${JSON.stringify(oldIndex, null, 2)}\n`);
      expect(new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId)).toEqual(original);
    });

    it('updates the lineage anchor and revision when the first durable row changes', () => {
      const sessionId = 'session_anchor_update';
      const first = store.append({ role: 'user', content: 'before update', sessionId });
      store.append({ role: 'assistant', content: 'answer', sessionId });
      const conversationDir = join(TEST_DIR, 'sessions', sessionId, 'conversation');
      const indexPath = join(conversationDir, 'index.json');
      const lineagePath = join(conversationDir, 'lineage.json');
      const before = store.getSessionHistoryMetadata(sessionId);
      const beforeAnchor = JSON.parse(readFileSync(lineagePath, 'utf8')).anchor;

      expect(store.update(first, { content: 'after update' })).toMatchObject({ content: 'after update' });
      const after = store.getSessionHistoryMetadata(sessionId);
      const afterAnchor = JSON.parse(readFileSync(lineagePath, 'utf8')).anchor;
      expect(after.streamId).toBe(before.streamId);
      expect(after.revision).toBe(before.revision + 1);
      expect(afterAnchor).not.toBe(beforeAnchor);

      rmSync(indexPath, { force: true });
      expect(new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId)).toEqual(after);
    });

    it('does not reuse lineage after physical Session deletion and same-id recreation', () => {
      const sessionId = 'session_physical_recreate';
      const sessionsDir = join(TEST_DIR, 'sessions');
      const handle = createSession(sessionsDir, {
        id: sessionId,
        name: 'Physical recreate',
        roster: [],
        defaultVpId: null,
      });
      handle.close();
      store.append({ role: 'user', content: 'old lifetime', sessionId });
      const before = store.getSessionHistoryMetadata(sessionId);

      expect(deleteSession(TEST_DIR, sessionId, { memoryRoot: join(TEST_DIR, 'memory') }))
        .toMatchObject({ sessionId, deleted: true });
      const recreated = createSession(sessionsDir, {
        id: sessionId,
        name: 'Physical recreate again',
        roster: [],
        defaultVpId: null,
      });
      recreated.close();
      const restarted = new ConversationStore(TEST_DIR);
      restarted.append({ role: 'user', content: 'new lifetime', sessionId });
      const after = restarted.getSessionHistoryMetadata(sessionId);
      expect(after.streamId).not.toBe(before.streamId);
    });

    it('rotates Session history lineage after delete and same-id recreation', () => {
      const sessionId = 'session_recreated_lineage';
      store.append({ role: 'user', content: 'old question', sessionId });
      store.append({ role: 'assistant', content: 'old answer', sessionId });
      const beforeDelete = store.getSessionHistoryMetadata(sessionId);

      expect(store.deleteByGroup(sessionId)).toBe(2);
      const afterDelete = store.getSessionHistoryMetadata(sessionId);
      expect(afterDelete.streamId).not.toBe(beforeDelete.streamId);
      expect(afterDelete).toMatchObject({ revision: 0, headSeq: 0 });

      store.append({ role: 'user', content: 'new question', sessionId });
      store.append({ role: 'assistant', content: 'new answer', sessionId });
      const recreated = store.getSessionHistoryMetadata(sessionId);
      expect(recreated.streamId).toBe(afterDelete.streamId);
      expect(recreated.streamId).not.toBe(beforeDelete.streamId);
      expect(recreated.headSeq).toBeGreaterThan(0);
    });

    it('rotates legacy lineage if an old writer recreates the transcript without lineage metadata', () => {
      const sessionId = 'session_old_writer_recreate';
      store.append({
        role: 'user', content: 'old question', sessionId, time: '2026-01-01T00:00:00.000Z',
      });
      const before = store.getSessionHistoryMetadata(sessionId);
      const conversationDir = join(TEST_DIR, 'sessions', sessionId, 'conversation');
      const segmentDir = join(conversationDir, 'segments');
      const indexPath = join(conversationDir, 'index.json');
      const segmentPath = join(segmentDir, '000001.jsonl');
      const recreatedRow = {
        id: 'm0001', seq: 1, role: 'user', content: 'new question', sessionId,
        time: '2026-01-02T00:00:00.000Z', tokens_est: 3,
      };
      const body = `${JSON.stringify(recreatedRow)}\n`;
      writeFileSync(segmentPath, body);
      writeFileSync(indexPath, `${JSON.stringify({
        version: 1,
        nextSeq: 2,
        totalMessages: 1,
        lastMessageId: 'm0001',
        activeSegment: '000001.jsonl',
        segments: [{
          file: '000001.jsonl', firstSeq: 1, lastSeq: 1, count: 1,
          bytes: Buffer.byteLength(body),
        }],
        foldedMessageIds: [],
      }, null, 2)}\n`);

      const after = new ConversationStore(TEST_DIR).getSessionHistoryMetadata(sessionId);
      expect(after.streamId).not.toBe(before.streamId);
      expect(after).toMatchObject({ revision: 0, headSeq: 1 });
    });
  });

  describe('update', () => {
    it('updates one durable row without changing neighboring messages or order', () => {
      const user = store.append({
        role: 'user',
        content: 'run it',
        sessionId: 'session_update',
      });
      const tool = store.append({
        role: 'tool',
        content: 'started',
        sessionId: 'session_update',
        toolCallId: 'call_update',
      });
      const assistant = store.append({
        role: 'assistant',
        content: 'waiting',
        sessionId: 'session_update',
      });

      const conversationDir = join(TEST_DIR, 'sessions', 'session_update', 'conversation');
      const untouchedIndex = readFileSync(join(conversationDir, 'index.json'), 'utf8');
      const updated = store.update(tool, { content: 'started\n\nfinished' });

      expect(updated).toMatchObject({
        id: tool.id,
        role: 'tool',
        content: 'started\n\nfinished',
        toolCallId: 'call_update',
      });
      const durableRows = readFileSync(
        join(TEST_DIR, 'sessions', 'session_update', 'conversation', 'segments', '000001.jsonl'),
        'utf8',
      ).trim().split('\n').map(line => JSON.parse(line));
      expect(durableRows.map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
      }))).toEqual([
        { id: user.id, role: 'user', content: 'run it' },
        { id: tool.id, role: 'tool', content: 'started\n\nfinished' },
        { id: assistant.id, role: 'assistant', content: 'waiting' },
      ]);
      const updatedIndex = JSON.parse(readFileSync(join(conversationDir, 'index.json'), 'utf8'));
      const originalIndex = JSON.parse(untouchedIndex);
      expect(updatedIndex).toMatchObject({
        nextSeq: originalIndex.nextSeq,
        totalMessages: originalIndex.totalMessages,
        lastMessageId: originalIndex.lastMessageId,
      });
      expect(readdirSync(join(conversationDir, 'segments')).filter(name => name.includes('.tmp.'))).toEqual([]);
      expect(store.append({
        role: 'assistant',
        content: 'done',
        sessionId: 'session_update',
      }).id).toBe('m0004');
    });
  });


    it("should write session messages under that session's conversation history", () => {
      const msg = store.append({ role: 'user', content: 'Hello session', sessionId: 's_fun' });
      expect(msg.id).toBe('m0001');
      expect(existsSync(join(TEST_DIR, 'sessions', 's_fun', 'conversation', 'segments', '000001.jsonl'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'groups', 's_fun', 'conversation', 'messages', 'm0001.md'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'chat', 'messages', 'm0001.md'))).toBe(false);
      expect(store.loadRecent(10)).toEqual([]);
      expect(store.loadRecentBySession('s_fun', 10)).toHaveLength(1);
    });

    it('should read legacy conversation paths without mixing chat and session records', () => {
      const legacyMessages = join(TEST_DIR, 'conversation', 'messages');
      mkdirSync(legacyMessages, { recursive: true });
      writeFileSync(join(legacyMessages, 'm0001.md'), `---
id: m0001
role: user
time: 2026-06-26T00:00:00Z
threadId: main
tokens_est: 3
---

legacy chat`, { encoding: 'utf8' });
      writeFileSync(join(legacyMessages, 'm0002.md'), `---
id: m0002
role: user
time: 2026-06-26T00:00:01Z
threadId: main
sessionId: s_fun
tokens_est: 4
---

legacy session`, { encoding: 'utf8' });

      const compatStore = new ConversationStore(TEST_DIR);
      expect(compatStore.loadRecent(10).map(m => m.content)).toEqual(['legacy chat']);
      // Per-session load paths no longer fall back to the legacy flat dir.
      expect(compatStore.loadRecentBySession('s_fun', 10).map(m => m.content)).toEqual([]);
    });

  describe('Session visible history search', () => {
    it('keeps HistorySearch read-only for unindexed and indexed Session roots', async () => {
      const root = join(TEST_DIR, 'history-search-root');
      mkdirSync(root, { recursive: true });
      const before = () => ({
        rootEntries: readdirSync(root).sort(),
        manifest: existsSync(join(root, 'sessions-manifest.json')),
        sessionMeta: existsSync(join(root, 'sessions', 'session_search', 'session.json')),
      });

      const emptyBefore = before();
      const empty = JSON.parse(await historySearch.execute({ keyword: 'nothing' }, {
        yeaftDir: root,
        sessionId: 'session_search',
      }));
      expect(empty.results).toEqual([]);
      expect(before()).toEqual(emptyBefore);

      const indexedStore = new ConversationStore(root);
      indexedStore.append({ role: 'user', content: 'indexed needle result', sessionId: 'session_search' });
      indexedStore.append({ role: 'user', content: 'sibling needle result', sessionId: 'session_sibling' });
      const markerPath = join(root, 'sessions-manifest.json');
      writeFileSync(markerPath, JSON.stringify({ version: 1, sessions: [] }, null, 2));
      const markerBefore = readFileSync(markerPath, 'utf8');
      const sessionDir = join(root, 'sessions', 'session_search');
      const sessionFilesBefore = readdirSync(sessionDir, { recursive: true }).sort();

      const found = JSON.parse(await historySearch.execute({ keyword: 'needle' }, {
        yeaftDir: root,
        sessionId: 'session_search',
        projectSessionIds: ['session_search', 'session_sibling'],
      }));
      expect(found).toMatchObject({ scope: 'session' });
      expect(found.results).toHaveLength(1);
      expect(found.results[0]).toMatchObject({
        sessionId: 'session_search',
        content: expect.stringContaining('needle'),
      });

      const project = JSON.parse(await historySearch.execute({ keyword: 'needle', scope: 'project' }, {
        yeaftDir: root,
        sessionId: 'session_search',
        projectSessionIds: ['session_search', 'session_sibling'],
      }));
      expect(project).toMatchObject({
        scope: 'project',
        notice: expect.stringContaining('not continuation'),
      });
      expect(project.results.map(result => result.sessionId).sort())
        .toEqual(['session_search', 'session_sibling']);
      expect(readFileSync(markerPath, 'utf8')).toBe(markerBefore);
      expect(readdirSync(sessionDir, { recursive: true }).sort()).toEqual(sessionFilesBefore);
    });

    it('exposes an explicit Session-default search scope in the tool contract', () => {
      expect(historySearch.parameters.properties.scope).toMatchObject({
        type: 'string',
        enum: ['session', 'project'],
      });
      expect(historySearch.description.en).toContain('default scope is only the current Session');
      expect(historySearch.description.zh).toContain('默认只搜索当前 Session');
    });

    it('rejects unknown history search scopes', async () => {
      const result = JSON.parse(await historySearch.execute({ keyword: 'needle', scope: 'global' }, {
        yeaftDir: TEST_DIR,
        sessionId: 'session_search',
      }));
      expect(result).toEqual({ error: 'scope must be "session" or "project"' });
    });

    it('searches only visible rows in the requested Session, newest first', () => {
      const first = store.append({ role: 'user', content: 'Needle in the first turn', sessionId: 'session_search' });
      store.append({ role: 'assistant', content: 'irrelevant', sessionId: 'session_search' });
      const latest = store.append({ role: 'assistant', content: 'Latest NEEDLE answer', sessionId: 'session_search', speakerVpId: 'maker' });
      store.append({ role: 'user', content: 'needle from another session', sessionId: 'session_other' });
      store.append({ role: 'system', content: 'needle in hidden metadata', sessionId: 'session_search' });

      const page = store.searchVisibleBySession('session_search', 'needle', { limit: 10 });

      expect(page.results.map(result => result.messageId)).toEqual([latest.id, first.id]);
      expect(page.results[0]).toMatchObject({ role: 'assistant', speakerVpId: 'maker' });
      expect(page.results[0].snippet).toContain('NEEDLE');
      expect(page.hasMore).toBe(false);
    });

    it('filters the full visible history by user or VP with and without a query', () => {
      const user = store.append({ role: 'user', content: 'user needle', sessionId: 'session_sender' });
      store.append({ role: 'assistant', content: 'linus needle', sessionId: 'session_sender', speakerVpId: 'linus' });
      const martin = store.append({ role: 'assistant', content: 'martin answer', sessionId: 'session_sender', speakerVpId: 'martin' });
      store.append({ role: 'user', content: 'engine-only', sessionId: 'session_sender', userAuthored: false });

      expect(store.searchVisibleBySession('session_sender', '', { senderKey: 'user' }).results)
        .toEqual([expect.objectContaining({ messageId: user.id, role: 'user' })]);
      expect(store.searchVisibleBySession('session_sender', '', { senderKey: 'vp:martin' }).results)
        .toEqual([expect.objectContaining({ messageId: martin.id, speakerVpId: 'martin' })]);
      expect(store.searchVisibleBySession('session_sender', 'needle', { senderKey: 'vp:martin' }).results)
        .toEqual([]);
    });

    it('resolves senders from Session and route-forward persisted shapes', () => {
      const direct = store.append({
        role: 'assistant', content: 'direct response', sessionId: 'session_sender_shapes', from: 'linus',
      });
      const forwarded = store.append({
        role: 'assistant', content: 'forwarded response', sessionId: 'session_sender_shapes', from: 'martin',
        meta: { senderVpId: 'martin', injectedBy: 'route_forward' },
      });

      expect(store.searchVisibleBySession('session_sender_shapes', '', { senderKey: 'vp:linus' }).results)
        .toEqual([expect.objectContaining({ messageId: direct.id, speakerVpId: 'linus' })]);
      expect(store.searchVisibleBySession('session_sender_shapes', '', { senderKey: 'vp:martin' }).results)
        .toEqual([expect.objectContaining({ messageId: forwarded.id, speakerVpId: 'martin' })]);
    });

    it('pages sender-only results on visible response boundaries', () => {
      for (let i = 0; i < 3; i += 1) {
        store.append({ role: 'assistant', content: `answer ${i}`, sessionId: 'session_sender_pages', speakerVpId: 'linus' });
      }
      const first = store.searchVisibleBySession('session_sender_pages', '', { senderKey: 'vp:linus', limit: 1 });
      const second = store.searchVisibleBySession('session_sender_pages', '', {
        senderKey: 'vp:linus', limit: 1, beforeSeq: first.nextBeforeSeq,
      });
      expect(first.results).toHaveLength(1);
      expect(first.hasMore).toBe(true);
      expect(second.results).toHaveLength(1);
      expect(second.results[0].seq).toBeLessThan(first.results[0].seq);
    });

    it('returns one canonical search result for a tool-using assistant response', () => {
      store.append({ role: 'user', content: 'run it', sessionId: 'session_search_response' });
      store.append({
        role: 'assistant', content: 'Needle before tool', sessionId: 'session_search_response',
        turnId: 'response-search', speakerVpId: 'maker',
      });
      const tool = store.append({
        role: 'assistant', content: '', sessionId: 'session_search_response',
        turnId: 'response-search', speakerVpId: 'maker', toolCalls: [{ id: 'call-1', name: 'Bash', input: {} }],
      });
      const final = store.append({
        role: 'assistant', content: 'needle after tool', sessionId: 'session_search_response',
        turnId: 'response-search', speakerVpId: 'maker',
      });

      const page = store.searchVisibleBySession('session_search_response', 'needle', { limit: 20 });

      expect(page.results).toEqual([
        expect.objectContaining({
          messageId: final.id,
          turnId: 'response-search',
          role: 'assistant',
          speakerVpId: 'maker',
        }),
      ]);
      expect(page.results[0].messageId).not.toBe(tool.id);
      expect(page.results[0].snippet).toContain('Needle before tool');
    });

    historyScenario('keeps one canonical entry across interleaved VP rows with a stable identity', () => {
      store.append({ role: 'user', content: 'compare answers', sessionId: 'session_interleaved_entry' });
      const linusFirst = store.append({
        role: 'assistant', content: 'Linus needle first', sessionId: 'session_interleaved_entry',
        turnId: 'turn-shared', speakerVpId: 'linus',
      });
      const martin = store.append({
        role: 'assistant', content: 'Martin needle', sessionId: 'session_interleaved_entry',
        turnId: 'turn-shared', speakerVpId: 'martin',
      });

      const beforeTail = store.searchVisibleBySession('session_interleaved_entry', 'needle', { limit: 20 });
      const linusEntryBefore = beforeTail.results.find(result => result.speakerVpId === 'linus');
      expect(linusEntryBefore).toMatchObject({
        messageId: linusFirst.id,
        sourceMessageIds: [linusFirst.id],
        entryStartSeq: store.getMessageSeqById(linusFirst.id),
      });

      const linusFinal = store.append({
        role: 'assistant', content: 'Linus needle final', sessionId: 'session_interleaved_entry',
        turnId: 'turn-shared', speakerVpId: 'linus',
      });
      const page = store.searchVisibleBySession('session_interleaved_entry', 'needle', { limit: 20 });
      const linusEntries = page.results.filter(result => result.speakerVpId === 'linus');
      const martinEntries = page.results.filter(result => result.speakerVpId === 'martin');

      expect(linusEntries).toHaveLength(1);
      expect(martinEntries).toHaveLength(1);
      expect(linusEntries[0]).toMatchObject({
        entryId: linusEntryBefore.entryId,
        messageId: linusFinal.id,
        sourceMessageIds: [linusFirst.id, linusFinal.id],
        snippet: expect.stringContaining('Linus needle first'),
      });
      expect(martinEntries[0]).toMatchObject({
        messageId: martin.id,
        sourceMessageIds: [martin.id],
      });
      expect(linusEntries[0].entryId).not.toBe(martinEntries[0].entryId);
    });

    historyScenario('does not merge a reused assistant turn id across visible user boundaries', () => {
      store.append({ role: 'user', content: 'first question', sessionId: 'session_reused_turn' });
      const first = store.append({
        role: 'assistant', content: 'first needle', sessionId: 'session_reused_turn',
        turnId: 'reused-turn', speakerVpId: 'linus',
      });
      store.append({ role: 'user', content: 'second question', sessionId: 'session_reused_turn' });
      const second = store.append({
        role: 'assistant', content: 'second needle', sessionId: 'session_reused_turn',
        turnId: 'reused-turn', speakerVpId: 'linus',
      });

      const results = store.searchVisibleBySession('session_reused_turn', 'needle').results;
      expect(results).toHaveLength(2);
      expect(results.map(result => result.messageId)).toEqual([second.id, first.id]);
      expect(new Set(results.map(result => result.entryId)).size).toBe(2);
    });

    historyScenario('preserves literal substring semantics for CJK, emoji, punctuation, and case', () => {
      const row = store.append({
        role: 'user',
        content: '前缀中文后缀 😀 rocket foo.bar QUOTED "Value"',
        sessionId: 'session_literal_search',
      });

      for (const query of ['中文', '😀', 'foo.bar', 'quoted "value"', 'QUOTED']) {
        expect(store.searchVisibleBySession('session_literal_search', query).results)
          .toEqual([expect.objectContaining({ messageId: row.id })]);
      }
      expect(store.searchVisibleBySession('session_literal_search', '文后').results)
        .toEqual([expect.objectContaining({ messageId: row.id })]);
      expect(store.searchVisibleBySession('session_literal_search', 'fooXbar').results).toEqual([]);
    });

    it('pages search results on response boundaries', () => {
      for (let i = 0; i < 3; i += 1) {
        store.append({ role: 'user', content: `question ${i}`, sessionId: 'session_search_pages' });
        store.append({
          role: 'assistant', content: `needle start ${i}`, sessionId: 'session_search_pages',
          turnId: `response-${i}`, speakerVpId: 'maker',
        });
        store.append({
          role: 'assistant', content: `needle final ${i}`, sessionId: 'session_search_pages',
          turnId: `response-${i}`, speakerVpId: 'maker',
        });
      }

      const firstPage = store.searchVisibleBySession('session_search_pages', 'needle', { limit: 1 });
      const secondPage = store.searchVisibleBySession('session_search_pages', 'needle', {
        limit: 1, beforeSeq: firstPage.nextBeforeSeq,
      });

      expect(firstPage.results).toHaveLength(1);
      expect(firstPage.results[0].turnId).toBe('response-2');
      expect(firstPage.hasMore).toBe(true);
      expect(secondPage.results).toHaveLength(1);
      expect(secondPage.results[0].turnId).toBe('response-1');
      expect(secondPage.results[0].seq).toBeLessThan(firstPage.nextBeforeSeq);
    });

    it('loads a bounded lightweight outline page with a stable total count', () => {
      const longText = `outline ${'x'.repeat(220)}`;
      const first = store.append({
        role: 'user', content: longText, sessionId: 'session_outline', clientMessageId: 'client-1',
        attachments: [{ name: 'secret.txt', data: 'do-not-project' }],
      });
      store.append({ role: 'assistant', content: 'first answer', sessionId: 'session_outline', speakerVpId: 'maker' });
      store.append({ role: 'system', content: 'hidden row', sessionId: 'session_outline' });
      store.append({ role: 'user', content: 'engine reflection', sessionId: 'session_outline', userAuthored: false });
      store.append({ role: 'user', content: 'second question', sessionId: 'session_outline' });
      const latest = store.append({ role: 'assistant', content: 'second answer', sessionId: 'session_outline' });

      const firstPage = store.loadVisibleOutlineBySession('session_outline', { limit: 2 });
      const countedPage = store.loadVisibleOutlineBySession('session_outline', { limit: 2, includeTotal: true });
      const olderPage = store.loadVisibleOutlineBySession('session_outline', {
        limit: 2, beforeSeq: firstPage.nextBeforeSeq,
      });

      expect(firstPage.results.map(result => result.messageId)).toEqual([
        expect.any(String), latest.id,
      ]);
      expect(firstPage).toMatchObject({ hasMore: true, totalCount: null });
      expect(countedPage.totalCount).toBe(4);
      expect([...firstPage.results, ...olderPage.results].map(result => result.snippet))
        .not.toContain('engine reflection');
      expect(olderPage.results.map(result => result.messageId)).toContain(first.id);
      expect(olderPage.totalCount).toBeNull();
      expect(olderPage.results.find(result => result.messageId === first.id)).toMatchObject({
        clientMessageId: 'client-1', role: 'user',
      });
      expect(olderPage.results.find(result => result.messageId === first.id).snippet.length).toBeLessThan(longText.length);
      expect(JSON.stringify([...firstPage.results, ...olderPage.results])).not.toContain('do-not-project');
      expect(JSON.stringify([...firstPage.results, ...olderPage.results])).not.toContain('attachments');
    });

    it('groups one tool-using assistant response into one canonical outline entry', () => {
      const user = store.append({
        role: 'user', content: 'run the tool', sessionId: 'session_outline_tools', turnId: 'user-turn',
      });
      store.append({
        role: 'assistant', content: 'I will check. ', sessionId: 'session_outline_tools',
        turnId: 'assistant-turn', speakerVpId: 'maker',
      });
      store.append({
        role: 'assistant', content: '', sessionId: 'session_outline_tools', turnId: 'assistant-turn',
        speakerVpId: 'maker', toolCalls: [{ id: 'call-1', name: 'Bash', input: { command: 'true' } }],
      });
      const final = store.append({
        role: 'assistant', content: 'Done.', sessionId: 'session_outline_tools',
        turnId: 'assistant-turn', speakerVpId: 'maker',
      });

      const page = store.loadVisibleOutlineBySession('session_outline_tools', { limit: 50, includeTotal: true });

      expect(page).toMatchObject({ totalCount: 2, hasMore: false, nextBeforeSeq: null });
      expect(page.results).toEqual([
        expect.objectContaining({ messageId: user.id, role: 'user' }),
        expect.objectContaining({
          messageId: final.id,
          turnId: 'assistant-turn',
          role: 'assistant',
          speakerVpId: 'maker',
          snippet: 'I will check. Done.',
        }),
      ]);
    });

    it('keeps the persisted tool-call row as the anchor for a tool-only response', () => {
      store.append({ role: 'user', content: 'run only', sessionId: 'session_outline_tool_only' });
      const toolOnly = store.append({
        role: 'assistant', content: '', sessionId: 'session_outline_tool_only', turnId: 'tool-only-turn',
        speakerVpId: 'maker', toolCalls: [{ id: 'call-1', name: 'Bash', input: { command: 'true' } }],
      });

      const page = store.loadVisibleOutlineBySession('session_outline_tool_only', { limit: 50, includeTotal: true });

      expect(page.totalCount).toBe(2);
      expect(page.results[1]).toMatchObject({
        messageId: toolOnly.id,
        seq: store.getMessageSeqById(toolOnly.id),
        turnId: 'tool-only-turn',
        role: 'assistant',
        snippet: '',
      });
    });

    it('pages on response boundaries without repeating a multi-row response', () => {
      const oldUser = store.append({ role: 'user', content: 'old question', sessionId: 'session_outline_pages' });
      const oldTool = store.append({
        role: 'assistant', content: '', sessionId: 'session_outline_pages', turnId: 'old-response',
        speakerVpId: 'maker', toolCalls: [{ id: 'call-old', name: 'Bash', input: {} }],
      });
      store.append({
        role: 'assistant', content: 'old final', sessionId: 'session_outline_pages',
        turnId: 'old-response', speakerVpId: 'maker',
      });
      const newUser = store.append({ role: 'user', content: 'new question', sessionId: 'session_outline_pages' });
      const newTool = store.append({
        role: 'assistant', content: '', sessionId: 'session_outline_pages', turnId: 'new-response',
        speakerVpId: 'maker', toolCalls: [{ id: 'call-new', name: 'Bash', input: {} }],
      });
      const newest = store.append({
        role: 'assistant', content: 'new answer', sessionId: 'session_outline_pages',
        turnId: 'new-response', speakerVpId: 'maker',
      });
      const latestPage = store.loadVisibleOutlineBySession('session_outline_pages', { limit: 1 });
      const firstPage = store.loadVisibleOutlineBySession('session_outline_pages', {
        limit: 2, beforeSeq: latestPage.nextBeforeSeq, includeTotal: false,
      });
      const olderPage = store.loadVisibleOutlineBySession('session_outline_pages', {
        limit: 2, beforeSeq: firstPage.nextBeforeSeq, includeTotal: false,
      });

      expect(latestPage.results).toEqual([
        expect.objectContaining({ messageId: newest.id, turnId: 'new-response' }),
      ]);
      expect(latestPage.nextBeforeSeq).toBe(store.getMessageSeqById(newTool.id));
      expect(firstPage.results).toEqual([
        expect.objectContaining({ turnId: 'old-response', role: 'assistant', snippet: 'old final' }),
        expect.objectContaining({ messageId: newUser.id, role: 'user' }),
      ]);
      expect(firstPage.results.some(result => result.turnId === 'new-response')).toBe(false);
      expect(firstPage.results.some(result => result.messageId === oldTool.id)).toBe(false);
      expect(olderPage.results).toEqual([
        expect.objectContaining({ messageId: oldUser.id, role: 'user' }),
      ]);
    });

    it('supports an exclusive seq cursor and bounded anchor window', async () => {
      await runConsolidatedHistoryScenarios();
      const ids = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push(store.append({ role: 'user', content: `searchable turn ${i}`, sessionId: 'session_window' }));
        store.append({ role: 'assistant', content: `answer ${i}`, sessionId: 'session_window' });
      }
      store.moveToCold(ids[0].id);
      const coldPage = store.searchVisibleBySession('session_window', 'searchable turn 0', { limit: 2 });
      expect(coldPage.results.map(result => result.messageId)).toContain(ids[0].id);

      const firstPage = store.searchVisibleBySession('session_window', 'searchable', { limit: 2 });
      const secondPage = store.searchVisibleBySession('session_window', 'searchable', { limit: 2, beforeSeq: firstPage.nextBeforeSeq });
      expect(firstPage.results).toHaveLength(2);
      expect(firstPage.hasMore).toBe(true);
      expect(secondPage.results.every(result => result.seq < firstPage.nextBeforeSeq)).toBe(true);

      const anchor = ids[2];
      const window = store.loadVisibleWindowBySession('session_window', store.getMessageSeqById(anchor.id), {
        beforeTurns: 1,
        afterTurns: 1,
      });
      expect(window.messages.some(message => message.id === anchor.id)).toBe(true);
      expect(window.messages.every(message => message.sessionId === 'session_window')).toBe(true);
      expect(window.messages.length).toBeLessThan(10);
    }, 60_000);

    it('restores AskUser answers inside a bounded search window', () => {
      store.append({ role: 'user', content: 'searchable AskUser turn', sessionId: 'session_window_ask' });
      const assistant = store.append({
        role: 'assistant',
        content: '',
        sessionId: 'session_window_ask',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCalls: [{ id: 'ask_window', name: 'AskUser', input: { question: 'Continue?', options: ['Yes'] } }],
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Yes' } }),
        sessionId: 'session_window_ask',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCallId: 'ask_window',
      });
      store.append({ role: 'assistant', content: 'done', sessionId: 'session_window_ask' });

      const window = store.loadVisibleWindowBySession(
        'session_window_ask',
        store.getMessageSeqById(assistant.id),
        { beforeTurns: 1, afterTurns: 1 },
      );

      expect(window.messages.find(message => message.id === assistant.id)?.askUserResults).toEqual([
        expect.objectContaining({
          toolCallId: 'ask_window',
          status: 'answered',
          answers: { 'Continue?': 'Yes' },
        }),
      ]);
    });
  });



  historyScenario('preserves literal search semantics and rebuilds after same-seq mutations', async () => {
      const sessionId = 'session_index_mutations';
      const user = store.append({
        role: 'user',
        content: '前缀中文后缀 😀 👨‍💻 foo.bar quoted "Value" old-token',
        sessionId,
      });
      const assistant = store.append({
        role: 'assistant',
        content: 'assistant needle',
        sessionId,
        turnId: 'turn-index',
        speakerVpId: 'linus',
      });

      for (const query of ['中', '中文', '😀', '👨‍💻', 'foo.bar', 'quoted "value"', 'OLD-TOKEN', '中文 foo.bar']) {
        const page = await searchConversationIndex(TEST_DIR, sessionId, query, { limit: 10 });
        expect(page.results).toEqual([expect.objectContaining({ messageId: user.id })]);
        expect(page.maxBatchRows).toBeLessThanOrEqual(128);
        expect(page.maxBatchBytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 1024);
      }
      const databaseDir = join(TEST_DIR, 'conversation-index', 'databases');
      const databaseName = readdirSync(databaseDir).find(name => name.endsWith('.sqlite'));
      expect(statSync(join(databaseDir, databaseName)).size).toBeLessThan(2 * 1024 * 1024);
      const first = await searchConversationIndex(TEST_DIR, sessionId, 'assistant needle', { limit: 10 });
      expect(first.results).toHaveLength(1);
      const firstGeneration = first.indexGeneration;
      const entryId = first.results[0].entryId;

      store.update(assistant, { content: 'assistant updated-token' });
      expect(await validateConversationIndexAnchor(TEST_DIR, sessionId, {
        indexGeneration: firstGeneration,
        entryId,
        entryStartSeq: first.results[0].entryStartSeq,
        anchorMessageId: first.results[0].messageId,
        anchorSeq: first.results[0].seq,
      })).toMatchObject({ ok: false, code: 'stale_result' });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'assistant needle')).results).toEqual([]);
      const updated = await searchConversationIndex(TEST_DIR, sessionId, 'updated-token');
      expect(updated.indexGeneration).toBeGreaterThan(firstGeneration);
      expect(updated.results).toEqual([expect.objectContaining({ entryId })]);

      const hiddenInternal = store.append({
        role: 'user', content: 'hide internal token', sessionId, userAuthored: true,
      });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'hide internal token')).results)
        .toHaveLength(1);
      store.update(hiddenInternal, { internal: true });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'hide internal token')).results)
        .toEqual([]);

      const hiddenModel = store.append({
        role: 'user', content: 'hide model token', sessionId, userAuthored: true,
      });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'hide model token')).results)
        .toHaveLength(1);
      store.update(hiddenModel, { userAuthored: false });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'hide model token')).results)
        .toEqual([]);

      const revealed = store.append({
        role: 'user', content: 'hidden then visible', sessionId, userAuthored: false,
      });
      store.update(revealed, { userAuthored: true });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'hidden then visible')).results)
        .toHaveLength(1);

      store.moveToCold(user.id);
      expect((await searchConversationIndex(TEST_DIR, sessionId, '中文')).results)
        .toEqual([expect.objectContaining({ messageId: user.id })]);

      store.foldMessages([assistant], {
        role: 'user',
        content: 'fold replacement',
        sessionId,
        _reflection: true,
        internal: true,
      });
      expect(await validateConversationIndexAnchor(TEST_DIR, sessionId, {
        indexGeneration: updated.indexGeneration,
        entryId: updated.results[0].entryId,
        entryStartSeq: updated.results[0].entryStartSeq,
        anchorMessageId: updated.results[0].messageId,
        anchorSeq: updated.results[0].seq,
      })).toMatchObject({ ok: false, code: 'stale_result' });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'updated-token')).results).toEqual([]);

      store.deleteByGroup(sessionId);
      await validateConversationIndexAnchor(TEST_DIR, sessionId, {
        indexGeneration: updated.indexGeneration,
        entryId: updated.results[0].entryId,
        entryStartSeq: updated.results[0].entryStartSeq,
        anchorMessageId: updated.results[0].messageId,
        anchorSeq: updated.results[0].seq,
      });
      expect((await searchConversationIndex(TEST_DIR, sessionId, '中文')).results).toEqual([]);
    });

    historyScenario('pages interleaved VP entries with an opaque cursor and no gaps', async () => {
      const sessionId = 'session_index_cursor';
      const user = store.append({ role: 'user', content: 'cursor question', sessionId });
      const linusFirst = store.append({
        role: 'assistant', content: 'linus first', sessionId,
        turnId: 'turn-cursor', speakerVpId: 'linus',
      });
      const martin = store.append({
        role: 'assistant', content: 'martin response', sessionId,
        turnId: 'turn-cursor', speakerVpId: 'martin',
      });
      const linusFinal = store.append({
        role: 'assistant', content: 'linus final', sessionId,
        turnId: 'turn-cursor', speakerVpId: 'linus',
      });

      const pages = [];
      let cursor = null;
      do {
        const page = await loadConversationOutlineFromIndex(TEST_DIR, sessionId, {
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        pages.push(...page.results);
        cursor = page.nextCursor;
      } while (cursor);

      expect(pages).toHaveLength(3);
      expect(new Set(pages.map(result => result.entryId)).size).toBe(3);
      expect(pages.find(result => result.speakerVpId === 'linus')).toMatchObject({
        sourceMessageIds: [linusFirst.id, linusFinal.id],
      });
      expect(pages.find(result => result.speakerVpId === 'martin')).toMatchObject({
        sourceMessageIds: [martin.id],
      });
      expect(pages.find(result => result.role === 'user')).toMatchObject({ messageId: user.id });
    });

    historyScenario('keeps an oversized canonical anchor entry complete under byte caps', () => {
      const sessionId = 'session_index_large_anchor';
      store.append({ role: 'user', content: 'large anchor question', sessionId });
      const first = store.append({
        role: 'assistant', content: 'x'.repeat(40_000), sessionId,
        turnId: 'turn-large', speakerVpId: 'linus',
      });
      const second = store.append({
        role: 'assistant', content: 'y'.repeat(40_000), sessionId,
        turnId: 'turn-large', speakerVpId: 'linus',
      });
      const entry = store.loadCanonicalVisibleEntriesBySession(sessionId)
        .find(candidate => candidate.speakerVpId === 'linus');
      const window = store.loadVisibleWindowBySession(sessionId, entry.anchorSeq, {
        entryStartSeq: entry.entryStartSeq,
        entryEndSeq: entry.entryEndSeq,
        sourceMessageIds: entry.sourceMessageIds,
        beforeTurns: 1,
        afterTurns: 1,
        maxRows: 10,
        maxBytes: 32 * 1024,
      });

      expect(window.messages.map(message => message.id)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(window.byteCount).toBeGreaterThan(32 * 1024);
      expect(window.rowCount).toBeLessThanOrEqual(10);
    });

    historyScenario('reconciles a source write that lands during the initial rebuild', async () => {
      const buildingSessionId = 'session_index_building';
      store.append({ role: 'user', content: 'build me', sessionId: buildingSessionId });
      const rejectedAt = performance.now();
      await expect(searchConversationIndex(TEST_DIR, buildingSessionId, 'build me', {
        _waitForBuild: false,
      })).rejects.toMatchObject({ code: 'index_building' });
      expect(performance.now() - rejectedAt).toBeLessThan(250);
      expect((await searchConversationIndex(TEST_DIR, buildingSessionId, 'build me')).results)
        .toHaveLength(1);

      const sessionId = 'session_index_concurrent';
      for (let index = 0; index < 200; index += 1) {
        store.append({ role: 'user', content: `seed ${index}`, sessionId });
      }
      const initial = searchConversationIndex(TEST_DIR, sessionId, 'seed 199');
      store.append({ role: 'user', content: 'concurrent needle', sessionId });
      await initial;
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'concurrent needle')).results)
        .toEqual([expect.objectContaining({ snippet: expect.stringContaining('concurrent needle') })]);

      const managerSessions = Array.from(
        { length: __historyIndexForTest.maxManagers + 4 },
        (_, index) => `session_index_manager_${index}`,
      );
      for (const [index, managerSessionId] of managerSessions.entries()) {
        store.append({ role: 'user', content: `manager needle ${index}`, sessionId: managerSessionId });
        expect((await searchConversationIndex(
          TEST_DIR,
          managerSessionId,
          `manager needle ${index}`,
        )).results).toHaveLength(1);
        expect(__historyIndexForTest.managers.size)
          .toBeLessThanOrEqual(__historyIndexForTest.maxManagers);
      }
      const firstManagerKey = `${TEST_DIR}\u001fsession_index_manager_0`;
      expect(__historyIndexForTest.managers.has(firstManagerKey)).toBe(false);
      expect((await searchConversationIndex(
        TEST_DIR,
        'session_index_manager_0',
        'manager needle 0',
      )).results).toHaveLength(1);
      expect(__historyIndexForTest.managers.size)
        .toBeLessThanOrEqual(__historyIndexForTest.maxManagers);
    });

    historyScenario('reconciles a crash-gap source rewrite without a mutation marker', async () => {
      const sessionId = 'session_index_crash_gap';
      store.append({ role: 'user', content: 'before crash', sessionId });
      await searchConversationIndex(TEST_DIR, sessionId, 'before crash');

      const segmentPath = join(TEST_DIR, 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl');
      const original = readFileSync(segmentPath, 'utf8');
      writeFileSync(segmentPath, original.replace('before crash', 'after crash!'), 'utf8');

      const after = await searchConversationIndex(TEST_DIR, sessionId, 'after crash!');
      expect(after.results)
        .toEqual([expect.objectContaining({ snippet: expect.stringContaining('after crash!') })]);
      expect(after.indexGeneration).toBeGreaterThan(1);
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'before crash')).results).toEqual([]);

      const outlineSessionId = 'session_index_outline_reconcile';
      store.append({ role: 'user', content: 'old-token', sessionId: outlineSessionId });
      const initialOutline = await loadConversationOutlineFromIndex(TEST_DIR, outlineSessionId, {
        limit: 10,
      });
      await closeConversationHistoryIndexes({ releaseMutationState: false });
      const outlinePath = join(
        TEST_DIR, 'sessions', outlineSessionId, 'conversation', 'segments', '000001.jsonl',
      );
      const outlineOriginal = readFileSync(outlinePath, 'utf8');
      writeFileSync(outlinePath, outlineOriginal.replace('old-token', 'new-token'), 'utf8');
      const staleOutline = await loadConversationOutlineFromIndex(TEST_DIR, outlineSessionId, {
        limit: 10,
      });
      expect(staleOutline.indexGeneration).toBe(initialOutline.indexGeneration);
      expect(staleOutline.results[0].snippet).toContain('old-token');
      let reconciledOutline = staleOutline;
      for (let attempt = 0; attempt < 100
        && reconciledOutline.indexGeneration === initialOutline.indexGeneration; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        reconciledOutline = await loadConversationOutlineFromIndex(TEST_DIR, outlineSessionId, {
          limit: 10,
        });
      }
      expect(reconciledOutline.indexGeneration).toBeGreaterThan(initialOutline.indexGeneration);
      expect(reconciledOutline.results[0].snippet).toContain('new-token');
    });

    historyScenario('invalidates the live scope when Session CRUD archives or deletes the directory', async () => {
      const sessionId = 'session_index_lifecycle';
      const handle = createSession(join(TEST_DIR, 'sessions'), {
        id: sessionId,
        name: 'Indexed lifecycle',
        roster: [],
        defaultVpId: null,
      });
      handle.close();
      store.append({ role: 'user', content: 'lifecycle needle', sessionId });
      const indexed = await searchConversationIndex(TEST_DIR, sessionId, 'lifecycle needle');
      expect(indexed.results).toHaveLength(1);

      rmSync(join(TEST_DIR, 'sessions', sessionId), { recursive: true, force: true });
      expect(archiveSession(TEST_DIR, sessionId)).toMatchObject({ alreadyGone: true });
      expect(await validateConversationIndexAnchor(TEST_DIR, sessionId, {
        indexGeneration: indexed.indexGeneration,
        entryId: indexed.results[0].entryId,
        entryStartSeq: indexed.results[0].entryStartSeq,
        anchorMessageId: indexed.results[0].messageId,
        anchorSeq: indexed.results[0].seq,
      })).toMatchObject({ ok: false, code: 'stale_result' });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'lifecycle needle')).results).toEqual([]);

      expect(deleteSession(TEST_DIR, sessionId, { memoryRoot: join(TEST_DIR, 'memory') }))
        .toMatchObject({ sessionId, alreadyGone: true, legacyCleanedUp: 0 });
      expect(deleteSession(TEST_DIR, sessionId, { memoryRoot: join(TEST_DIR, 'memory') }))
        .toMatchObject({ sessionId, alreadyGone: true });
      expect((await searchConversationIndex(TEST_DIR, sessionId, 'lifecycle needle')).results).toEqual([]);
    });

    historyScenario('rejects a stale versioned entry locator after the source entry changes', async () => {
      const raceAnchorMutation = async (kind, mutate) => {
        const sessionId = `session_index_anchor_${kind}`;
        store.append({ role: 'user', content: `anchor question ${kind}`, sessionId });
        const assistant = store.append({
          role: 'assistant',
          content: `anchor needle ${kind}`,
          sessionId,
          turnId: `turn-anchor-${kind}`,
          speakerVpId: 'linus',
        });
        const page = await searchConversationIndex(TEST_DIR, sessionId, `anchor needle ${kind}`);
        const result = page.results[0];
        expect(await validateConversationIndexAnchor(TEST_DIR, sessionId, {
          indexGeneration: result.indexGeneration,
          entryId: result.entryId,
          entryStartSeq: result.entryStartSeq,
          anchorMessageId: result.messageId,
          anchorSeq: result.seq,
        })).toMatchObject({ ok: true });

        const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
        const barrier = new Int32Array(barrierBuffer);
        const reading = readConversationIndexWindow(TEST_DIR, sessionId, {
          indexGeneration: result.indexGeneration,
          entryId: result.entryId,
          entryStartSeq: result.entryStartSeq,
          anchorMessageId: result.messageId,
          anchorSeq: result.seq,
          beforeTurns: 1,
          afterTurns: 1,
          _testBarrier: barrierBuffer,
        });
        while (Atomics.load(barrier, 0) === 0) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        await mutate({ sessionId, assistant });
        Atomics.store(barrier, 1, 1);
        Atomics.notify(barrier, 1);
        await expect(reading).rejects.toMatchObject({ code: 'stale_result' });
      };

      await raceAnchorMutation('update', ({ assistant }) => {
        store.update(assistant, { content: 'anchor changed during read' });
      });
      await raceAnchorMutation('fold', ({ sessionId, assistant }) => {
        store.foldMessages([assistant], {
          role: 'user', content: 'fold replacement', sessionId, _reflection: true, internal: true,
        });
      });
      await raceAnchorMutation('delete', ({ sessionId }) => {
        store.deleteByGroup(sessionId);
      });
      await raceAnchorMutation('rewrite', ({ sessionId }) => {
        const segmentPath = join(
          TEST_DIR, 'sessions', sessionId, 'conversation', 'segments', '000001.jsonl',
        );
        const original = readFileSync(segmentPath, 'utf8');
        const rewritten = original.replace('anchor needle rewrite', 'anchor change rewrite');
        expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
        writeFileSync(segmentPath, rewritten, 'utf8');
      });
    });

  describe('loadRecent', () => {


    it('should respect limit (most recent turns)', () => {
      // `loadRecent` is now turn-based. Build 3 distinct user turns so
      // we can slice the last 2 turns deterministically (no `@vp-X`
      // collapsing, no orphan tool messages).
      store.appendBatch([
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'a3' },
      ]);

      const loaded = store.loadRecent(2);
      // 2 turns = q2/a2 + q3/a3 = 4 messages.
      expect(loaded).toHaveLength(4);
      expect(loaded[0].content).toBe('q2');
      expect(loaded[1].content).toBe('a2');
      expect(loaded[2].content).toBe('q3');
      expect(loaded[3].content).toBe('a3');
    });


  });



  // Group-history-isolation (Bug 7): group-scoped loaders.
  describe('loadRecentBySession / loadAllBySession', () => {
    it('returns only messages stamped with the requested sessionId', () => {
      store.appendBatch([
        { role: 'user',      content: 'A1 project needle', sessionId: 'grp_a' },
        { role: 'assistant', content: 'A2', sessionId: 'grp_a' },
        { role: 'user',      content: 'B1 project needle', sessionId: 'grp_b' },
        { role: 'user',      content: 'C1 project needle', sessionId: 'grp_c' },
        { role: 'user',      content: 'A3', sessionId: 'grp_a' },
      ]);
      const a = store.loadRecentBySession('grp_a', 50);
      const b = store.loadRecentBySession('grp_b', 50);
      expect(a.map(m => m.content)).toEqual(['A1 project needle', 'A2', 'A3']);
      expect(b.map(m => m.content)).toEqual(['B1 project needle']);
      expect(searchMessages(TEST_DIR, 'project needle', 10, {
        sessionIds: ['grp_a', 'grp_b'],
      }).map(m => m.sessionId).sort()).toEqual(['grp_a', 'grp_b']);
      expect(searchMessages(TEST_DIR, 'project needle', 10, {
        sessionIds: [],
      })).toEqual([]);
    });

    it('excludes messages with no sessionId (legacy / pre-grouping)', () => {
      store.appendBatch([
        { role: 'user', content: 'orphan' },                       // no sessionId
        { role: 'user', content: 'tagged', sessionId: 'grp_a' },
      ]);
      expect(store.loadRecentBySession('grp_a', 50).map(m => m.content)).toEqual(['tagged']);
    });

    it('excludes messages from a deleted/other group', () => {
      store.appendBatch([
        { role: 'user', content: 'leftover', sessionId: 'grp_default' },
        { role: 'user', content: 'mine',     sessionId: 'grp_claude' },
      ]);
      const out = store.loadRecentBySession('grp_claude', 50);
      expect(out.map(m => m.content)).toEqual(['mine']);
    });

    it('respects limit as "N most recent within this group"', () => {
      store.appendBatch([
        { role: 'user', content: 'A1', sessionId: 'grp_a' },
        { role: 'user', content: 'B1', sessionId: 'grp_b' },
        { role: 'user', content: 'A2', sessionId: 'grp_a' },
        { role: 'user', content: 'B2', sessionId: 'grp_b' },
        { role: 'user', content: 'A3', sessionId: 'grp_a' },
      ]);
      // Two most recent A messages, not "scan last 2 messages globally
      // and filter" (which would yield only A3).
      expect(store.loadRecentBySession('grp_a', 2).map(m => m.content)).toEqual(['A2', 'A3']);
    });

    it('loadAfterSeqByGroup skips internal and model-only user-role rows', () => {
      const first = store.append({ role: 'user', content: 'real user', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: '@vp-martin internal handoff',
        sessionId: 'grp_a',
        speakerVpId: 'vp-linus',
        internal: true,
      });
      store.append({ role: 'user', content: 'Continue', sessionId: 'grp_a', userAuthored: false });
      store.append({ role: 'assistant', content: 'target response', sessionId: 'grp_a', speakerVpId: 'vp-martin' });

      const page = store.loadAfterSeqByGroup('grp_a', Number(first.id.replace(/^m/, '')));
      expect(page.messages.map(m => m.content)).toEqual(['target response']);
    });

    it('keeps an AskUser call and result atomic at the default delta limit', () => {
      const cursor = store.append({ role: 'user', content: 'cached', sessionId: 'grp_delta_ask' });
      store.appendBatch(Array.from({ length: 499 }, (_, index) => ({
        role: 'assistant',
        content: `filler-${index}`,
        sessionId: 'grp_delta_ask',
      })));
      const call = store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_delta_ask',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
        toolCalls: [{ id: 'ask_boundary', name: 'AskUser', input: { question: 'Continue?', options: ['Yes'] } }],
      });
      const result = store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Yes' } }),
        sessionId: 'grp_delta_ask',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
        toolCallId: 'ask_boundary',
      });
      const trailing = store.append({ role: 'assistant', content: 'after pair', sessionId: 'grp_delta_ask' });

      const firstPage = store.loadAfterSeqByGroup('grp_delta_ask', store.getMessageSeqById(cursor.id));
      expect(firstPage.messages.find(message => message.id === call.id)?.askUserResults).toEqual([
        expect.objectContaining({
          toolCallId: 'ask_boundary',
          status: 'answered',
          answers: { 'Continue?': 'Yes' },
        }),
      ]);
      expect(firstPage.latestSeq).toBe(store.getMessageSeqById(result.id));
      expect(firstPage.hasMoreAfter).toBe(true);

      const secondPage = store.loadAfterSeqByGroup('grp_delta_ask', firstPage.latestSeq);
      expect(secondPage.messages.map(message => message.id)).toEqual([trailing.id]);
      expect(secondPage.hasMoreAfter).toBe(false);
    });

    it('pages a long delta by row and byte budgets without skipping the tail', () => {
      const cursor = store.append({ role: 'user', content: 'cached', sessionId: 'grp_delta_pages' });
      const rows = store.appendBatch(Array.from({ length: 7 }, (_, index) => ({
        role: 'assistant',
        content: `page-${index}-${'x'.repeat(80)}`,
        sessionId: 'grp_delta_pages',
      })));

      const seen = [];
      let afterSeq = store.getMessageSeqById(cursor.id);
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = store.loadAfterSeqByGroup('grp_delta_pages', afterSeq, {
          limit: 2,
          maxBytes: 220,
        });
        seen.push(...page.messages.map(message => message.id));
        expect(page.latestSeq).toBeGreaterThan(afterSeq);
        afterSeq = page.latestSeq;
        if (!page.hasMoreAfter) break;
      }

      expect(seen).toEqual(rows.map(row => row.id));
      expect(afterSeq).toBe(store.getMessageSeqById(rows.at(-1).id));
    });

    it('recovers an AskUser result when the incoming cursor already points at its call', () => {
      const cursor = store.append({ role: 'user', content: 'cached', sessionId: 'grp_delta_cursor' });
      const call = store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_delta_cursor',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
        toolCalls: [{ id: 'ask_cursor', name: 'AskUser', input: { question: 'Continue?', options: ['Yes'] } }],
      });
      store.appendBatch(Array.from({ length: 499 }, (_, index) => ({
        role: 'assistant',
        content: `sibling output ${index}`,
        sessionId: 'grp_delta_cursor',
        speakerVpId: 'vp-b',
        turnId: `turn-b-${index}`,
        threadId: `thread-b-${index}`,
      })));
      const result = store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Yes' } }),
        sessionId: 'grp_delta_cursor',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        threadId: 'thread-a',
        toolCallId: 'ask_cursor',
      });

      const siblingCursor = store.getMessageSeqById(result.id) - 1;
      const page = store.loadAfterSeqByGroup('grp_delta_cursor', siblingCursor);

      expect(store.getMessageSeqById(cursor.id)).toBeLessThan(store.getMessageSeqById(call.id));
      expect(page.messages.find(message => message.id === call.id)?.askUserResults).toEqual([
        expect.objectContaining({ toolCallId: 'ask_cursor', status: 'answered' }),
      ]);
      expect(page.latestSeq).toBe(store.getMessageSeqById(result.id));
    });

    it('keeps a tool pair atomic across interleaved visible Session rows', () => {
      const cursor = store.append({ role: 'user', content: 'cached', sessionId: 'grp_delta_interleaved' });
      const call = store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_delta_interleaved',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        toolCalls: [{ id: 'tool_interleaved', name: 'FileRead', input: {} }],
      });
      store.append({
        role: 'assistant',
        content: 'sibling output',
        sessionId: 'grp_delta_interleaved',
        speakerVpId: 'vp-b',
        turnId: 'turn-b',
      });
      const result = store.append({
        role: 'tool',
        content: 'done',
        sessionId: 'grp_delta_interleaved',
        speakerVpId: 'vp-a',
        turnId: 'turn-a',
        toolCallId: 'tool_interleaved',
      });

      const page = store.loadAfterSeqByGroup(
        'grp_delta_interleaved',
        store.getMessageSeqById(cursor.id),
        { limit: 1 },
      );

      expect(page.messages.find(message => message.id === call.id)?.toolCalls).toEqual(call.toolCalls);
      expect(page.latestSeq).toBe(store.getMessageSeqById(result.id));
    });

    it('keeps every result in an ordinary multi-tool arc at a delta boundary', () => {
      const cursor = store.append({ role: 'user', content: 'cached', sessionId: 'grp_delta_tools' });
      store.append({ role: 'assistant', content: 'filler', sessionId: 'grp_delta_tools' });
      const call = store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_delta_tools',
        toolCalls: [
          { id: 'tool_a', name: 'FileRead', input: {} },
          { id: 'tool_b', name: 'Grep', input: {} },
        ],
      });
      store.append({ role: 'tool', content: 'a', sessionId: 'grp_delta_tools', toolCallId: 'tool_a' });
      const lastResult = store.append({ role: 'tool', content: 'b', sessionId: 'grp_delta_tools', toolCallId: 'tool_b' });
      const trailing = store.append({ role: 'assistant', content: 'after pair', sessionId: 'grp_delta_tools' });

      const firstPage = store.loadAfterSeqByGroup(
        'grp_delta_tools',
        store.getMessageSeqById(cursor.id),
        { limit: 3 },
      );
      expect(firstPage.messages.find(message => message.id === call.id)?.toolCalls).toEqual(call.toolCalls);
      expect(firstPage.latestSeq).toBe(store.getMessageSeqById(lastResult.id));

      const secondPage = store.loadAfterSeqByGroup('grp_delta_tools', firstPage.latestSeq, { limit: 3 });
      expect(secondPage.messages.map(message => message.id)).toEqual([trailing.id]);
    });

    it('hides legacy unstamped task-result and system-note rows from session history', () => {
      const first = store.append({ role: 'user', content: 'real user', sessionId: 'grp_a' });
      store.append({
        role: 'user',
        content: '<task-result id="task_1" kind="shell" status="succeeded">\nlogTail:\n  PASS\n</task-result>\nThis is an asynchronous tool result from a background task, not a user message.',
        sessionId: 'grp_a',
      });
      store.append({
        role: 'user',
        content: '[system note] You have called ReadTaskLog with the same arguments 3 times. Previous result: {...}. Consider whether re-running this tool is necessary or if you should try a different approach.',
        sessionId: 'grp_a',
      });
      store.append({ role: 'assistant', content: 'visible response', sessionId: 'grp_a', speakerVpId: 'vp-main' });
      store.append({ role: 'user', content: 'please explain <task-result> tags in XML', sessionId: 'grp_a' });
      store.append({ role: 'user', content: 'In docs, <task-result> means XML-ish markup here', sessionId: 'grp_a' });
      store.append({ role: 'user', content: '[system note] this is just prose, not a tool-folding warning', sessionId: 'grp_a' });

      expect(store.loadRecentBySession('grp_a', Infinity).map(m => m.content)).toEqual([
        'real user',
        'visible response',
        'please explain <task-result> tags in XML',
        'In docs, <task-result> means XML-ish markup here',
        '[system note] this is just prose, not a tool-folding warning',
      ]);
      expect(store.loadSessionHistoryForVp('grp_a', 'vp-main').map(m => m.content)).toEqual([
        'real user',
        'visible response',
        'please explain <task-result> tags in XML',
        'In docs, <task-result> means XML-ish markup here',
        '[system note] this is just prose, not a tool-folding warning',
      ]);
      expect(store.loadAfterSeqByGroup('grp_a', Number(first.id.replace(/^m/, ''))).messages.map(m => m.content)).toEqual([
        'visible response',
        'please explain <task-result> tags in XML',
        'In docs, <task-result> means XML-ish markup here',
        '[system note] this is just prose, not a tool-folding warning',
      ]);
      expect(store.loadVisibleBySession('grp_a', null, 10).messages.map(m => m.content)).toEqual([
        'real user',
        'visible response',
        'please explain <task-result> tags in XML',
        'In docs, <task-result> means XML-ish markup here',
        '[system note] this is just prose, not a tool-folding warning',
      ]);
    });

    it('loadVisibleBySession returns a recent turn window with multi-VP boundary intact', () => {
      store.appendBatch([
        { role: 'user', content: 'old q', sessionId: 'grp_a' },
        { role: 'assistant', content: 'old a', sessionId: 'grp_a' },
        { role: 'user', content: 'noise', sessionId: 'grp_b' },
        { role: 'user', content: '@vp-linus shared q', sessionId: 'grp_a' },
        { role: 'user', content: '@vp-martin shared q', sessionId: 'grp_a' },
        { role: 'assistant', content: 'linus a', sessionId: 'grp_a', speakerVpId: 'vp-linus' },
        { role: 'assistant', content: 'martin a', sessionId: 'grp_a', speakerVpId: 'vp-martin' },
        { role: 'user', content: 'new q', sessionId: 'grp_a' },
        { role: 'assistant', content: 'new a', sessionId: 'grp_a' },
      ]);

      const page = store.loadVisibleBySession('grp_a', null, 2);
      expect(page.messages.map(m => m.content)).toEqual([
        '@vp-linus shared q',
        '@vp-martin shared q',
        'linus a',
        'martin a',
        'new q',
        'new a',
      ]);
      expect(page.hasMore).toBe(true);
      expect(page.oldestSeq).toBe(Number(page.messages[0].id.replace(/^m/, '')));

      const older = store.loadVisibleBySession('grp_a', page.oldestSeq, 1);
      expect(older.messages.map(m => m.content)).toEqual(['old q', 'old a']);
      expect(older.hasMore).toBe(false);
    });

    it('loadVisibleBySession keeps the latest TodoWrite snapshot and full tool actions', () => {
      store.append({ role: 'user', content: 'status?', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: 'working',
        sessionId: 'grp_a',
        toolCalls: [
          { id: 'todo-old', name: 'TodoWrite', input: { todos: [{ content: 'Old', status: 'pending' }] } },
          { id: 'bash', name: 'Bash', input: { command: 'true' } },
          { id: 'todo-new', name: 'TodoWrite', input: { todos: [{ content: 'Latest', status: 'completed' }] } },
        ],
      });

      const page = store.loadVisibleBySession('grp_a', null, 1);
      expect(page.messages[1]).toMatchObject({
        content: 'working',
        todos: [{ content: 'Latest', status: 'completed' }],
        toolCalls: [{ id: 'bash', name: 'Bash', input: { command: 'true' } }],
      });

      const contradictory = projectVisibleSessionMessages([{
        role: 'assistant', content: 'Partial before failure', responseKind: 'result',
        incomplete: true, stopReason: 'error',
      }]);
      expect(contradictory[0]).toMatchObject({
        responseKind: 'progress', incomplete: true, stopReason: 'error',
      });
      expect(projectVisibleSessionMessages([{
        role: 'assistant', content: 'Cancelled partial', responseKind: 'result', stopReason: 'cancelled',
      }])[0]).toMatchObject({ responseKind: 'progress', stopReason: 'cancelled' });
    });

    it('loadVisibleBySession keeps interleaved multi-VP rows for the boundary turn', () => {
      store.append({ role: 'user', content: '@vp-a one', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'a1', sessionId: 'grp_a', speakerVpId: 'a' });
      store.append({ role: 'user', content: '@vp-b one', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'b1', sessionId: 'grp_a', speakerVpId: 'b' });

      const page = store.loadVisibleBySession('grp_a', null, 1);
      expect(page.messages.map(m => [m.role, m.content, m.speakerVpId || ''])).toEqual([
        ['user', '@vp-a one', ''],
        ['assistant', 'a1', 'a'],
        ['user', '@vp-b one', ''],
        ['assistant', 'b1', 'b'],
      ]);
      expect(page.hasMore).toBe(false);
    });

    it('recent session readers stop after the requested turn window', () => {
      const readCounts = { count: 0 };
      for (let i = 0; i < 500; i++) {
        store.append({ role: 'user', content: `old ${i}`, sessionId: 'grp_a' });
        store.append({ role: 'assistant', content: `old answer ${i}`, sessionId: 'grp_a' });
      }
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'latest a', sessionId: 'grp_a' });

      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };
      const visible = store.loadVisibleBySession('grp_a', null, 1);
      const readsAfterVisible = readCounts.count;
      const recent = store.loadRecentBySession('grp_a', 1);

      expect(visible.messages.map(m => m.content)).toEqual(['latest q', 'latest a']);
      expect(visible.hasMore).toBe(true);
      expect(recent.map(m => m.content)).toEqual(['latest q', 'latest a']);
      expect(readsAfterVisible).toBeLessThan(10);
      expect(readCounts.count - readsAfterVisible).toBeLessThan(10);
    });

    it('loadRecentBySession preserves full tool pairs in the bounded engine window', () => {
      for (let i = 0; i < 200; i++) {
        store.append({ role: 'user', content: `old ${i}`, sessionId: 'grp_a' });
        store.append({ role: 'assistant', content: `old answer ${i}`, sessionId: 'grp_a' });
      }
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: 'running tool',
        sessionId: 'grp_a',
        toolCalls: [{ id: 'toolu_1', name: 'Bash', input: { command: 'echo ok' } }],
      });
      store.append({ role: 'tool', content: 'ok', sessionId: 'grp_a', toolCallId: 'toolu_1' });
      store.append({ role: 'assistant', content: 'latest a', sessionId: 'grp_a' });

      const readCounts = { count: 0 };
      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };

      const recent = store.loadRecentBySession('grp_a', 1);
      expect(recent.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(recent[1].toolCalls).toHaveLength(1);
      expect(recent[2].toolCallId).toBe('toolu_1');
      expect(readCounts.count).toBeLessThan(10);
    });

    it('loads 20 provider turns across dense tool arcs without changing the bounded UI reader', async () => {
      for (let turn = 0; turn < 24; turn++) {
        store.append({ role: 'user', content: 'same question', sessionId: 'grp_a', clientMessageId: `q${turn}` });
        for (let call = 0; call < 8; call++) {
          const id = `c${turn}-${call}`;
          store.append({ role: 'assistant', content: '', sessionId: 'grp_a',
            toolCalls: [{ id, name: 'Read', input: {} }] });
          store.append({ role: 'tool', content: 'result', sessionId: 'grp_a', toolCallId: id });
        }
        store.append({ role: 'assistant', content: `answer ${turn}`, sessionId: 'grp_a' });
      }
      const current = store.append({ role: 'user', content: 'current', sessionId: 'grp_a' });
      store.append({ role: 'user', content: 'queued future', sessionId: 'grp_a' });
      const beforeSeq = Number(current.id.slice(1));
      let yielded = false;
      setImmediate(() => { yielded = true; });
      const history = await store.loadProviderHistoryBySession('grp_a', 20, { beforeSeq });
      expect(yielded).toBe(true);
      expect(history.filter(m => m.role === 'user').map(m => m.clientMessageId))
        .toEqual(Array.from({ length: 20 }, (_, i) => `q${i + 4}`));
      expect(history.filter(m => m.role === 'tool')).toHaveLength(20 * 8);
      expect(history.at(-1).content).toBe('answer 23');
      expect(store.loadRecentBySession('grp_a', 20, { beforeSeq }).filter(m => m.role === 'user').length).toBeLessThan(20);
    });

    it('stops at the requested oldest user without reading the previous dense turn', async () => {
      const sessionId = 'provider-window-boundary';
      const directory = join(TEST_DIR, 'sessions', sessionId, 'conversation', 'messages');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'm1.md'), '---\nid: m1\nrole: assistant\nsessionId: provider-window-boundary\n---\nold dense turn');
      for (let i = 0; i < 20; i++) {
        const id = `m${i + 2}`;
        writeFileSync(join(directory, `${id}.md`), `---\nid: ${id}\nrole: user\nsessionId: ${sessionId}\n---\nquestion ${i}`);
      }
      const original = store.readMessageFile;
      store.readMessageFile = function(path, ...args) {
        if (path.endsWith('/m1.md')) throw new Error('must not read the excluded turn');
        return original.call(this, path, ...args);
      };
      const rows = await store.loadProviderHistoryBySession(sessionId, 20);
      expect(rows.map(row => row.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 2}`));
    });

    it('projects persisted AskUser answers without exposing ordinary tool results', () => {
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCalls: [
          { id: 'ask_1', name: 'AskUser', input: { question: 'Continue?', options: ['Yes', 'No'] } },
          { id: 'bash_1', name: 'Bash', input: { command: 'echo ok' } },
        ],
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Yes' } }),
        sessionId: 'grp_a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCallId: 'ask_1',
      });
      store.append({
        role: 'tool',
        content: 'ok',
        sessionId: 'grp_a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCallId: 'bash_1',
      });

      const page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages.map(m => m.role)).toEqual(['user', 'assistant']);
      expect(page.messages[1]).toMatchObject({
        toolCalls: [
          { id: 'ask_1', name: 'AskUser', input: { question: 'Continue?', options: ['Yes', 'No'] } },
          { id: 'bash_1', name: 'Bash', input: { command: 'echo ok' } },
        ],
        askUserResults: [{
          toolCallId: 'ask_1',
          status: 'answered',
          question: 'Continue?',
          options: ['Yes', 'No'],
          answers: { 'Continue?': 'Yes' },
        }],
      });
      expect(page.messages.some(m => m.role === 'tool')).toBe(false);
    });

    it('does not misclassify legacy pending AskUser output as an answer', () => {
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_a',
        toolCalls: [{ id: 'ask_legacy', name: 'AskUser', input: { question: 'Continue?', options: ['Yes'] } }],
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ type: 'ask_user', requestId: 'ask_old', question: 'Continue?', options: ['Yes'], message: 'Question sent to user' }),
        sessionId: 'grp_a',
        toolCallId: 'ask_legacy',
      });

      const page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages[1]).toMatchObject({
        toolCalls: [{ id: 'ask_legacy', name: 'AskUser', input: { question: 'Continue?', options: ['Yes'] } }],
      });
      expect(page.messages[1].askUserResults).toBeUndefined();
    });

    it('keeps same-id AskUser results isolated by Session turn identity', () => {
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCalls: [{ id: 'shared_call', name: 'AskUser', input: { question: 'Continue?' } }],
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Wrong' } }),
        sessionId: 'grp_b',
        threadId: 'thread-b',
        turnId: 'turn-b',
        speakerVpId: 'vp-b',
        toolCallId: 'shared_call',
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', answers: { 'Continue?': 'Right' } }),
        sessionId: 'grp_a',
        threadId: 'thread-a',
        turnId: 'turn-a',
        speakerVpId: 'vp-a',
        toolCallId: 'shared_call',
      });

      const page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages[1].askUserResults).toEqual([
        expect.objectContaining({ answers: { 'Continue?': 'Right' } }),
      ]);
    });

    it('restores timed-out AskUser calls as expired history state', () => {
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: '',
        sessionId: 'grp_a',
        toolCalls: [{ id: 'ask_timeout', name: 'AskUser', input: { question: 'Continue?' } }],
      });
      store.append({
        role: 'tool',
        content: JSON.stringify({ question: 'Continue?', timedOut: true }),
        sessionId: 'grp_a',
        toolCallId: 'ask_timeout',
      });

      const page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages[1].askUserResults).toEqual([
        expect.objectContaining({ toolCallId: 'ask_timeout', status: 'expired' }),
      ]);
    });

    it('loadVisibleBySession stops on dense hidden rows after the requested turn', () => {
      store.append({ role: 'user', content: 'old q', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'old a', sessionId: 'grp_a' });
      for (let i = 0; i < 1000; i++) {
        store.append({ role: 'user', content: `[system note] You have called Bash with the same arguments ${i + 1} times. Previous result: {...}`, sessionId: 'grp_a' });
      }
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'latest a', sessionId: 'grp_a' });

      const readCounts = { count: 0 };
      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };
      const page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages.map(m => m.content)).toEqual(['latest q', 'latest a']);
      expect(page.hasMore).toBe(true);
      expect(readCounts.count).toBeLessThan(80);
    });

    it('loadVisibleBySession hard-caps dense empty assistant rows after the requested turn', () => {
      store.append({ role: 'user', content: 'old q', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'old a', sessionId: 'grp_a' });
      for (let i = 0; i < 1000; i++) {
        store.append({ role: 'assistant', content: '', sessionId: 'grp_a', speakerVpId: 'vp-linus' });
      }
      store.append({ role: 'user', content: 'latest q', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'latest a', sessionId: 'grp_a' });

      const readCounts = { count: 0 };
      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };
      const page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages.map(m => m.content)).toEqual(['latest q', 'latest a']);
      expect(page.hasMore).toBe(true);
      expect(readCounts.count).toBeLessThan(80);
    });

    it('loadVisibleBySession hits the hard cap when the newest tail has no turn boundary', () => {
      store.append({ role: 'user', content: 'old q', sessionId: 'grp_a' });
      store.append({ role: 'assistant', content: 'old a', sessionId: 'grp_a' });
      for (let i = 0; i < 1000; i++) {
        store.append({ role: 'assistant', content: '', sessionId: 'grp_a', speakerVpId: 'vp-linus' });
      }

      const readCounts = { count: 0 };
      const original = store.readMessageFile;
      store.readMessageFile = (...args) => {
        readCounts.count += 1;
        return original.call(store, ...args);
      };
      let page = store.loadVisibleBySession('grp_a', null, 1);

      expect(page.messages).toEqual([]);
      expect(page.hasMore).toBe(true);
      expect(page.nextBeforeSeq).toEqual(expect.any(Number));
      expect(readCounts.count).toBeLessThan(80);

      const cursors = [];
      while (page.messages.length === 0 && page.hasMore) {
        const cursor = page.nextBeforeSeq;
        expect(cursor).toEqual(expect.any(Number));
        cursors.push(cursor);
        page = store.loadVisibleBySession('grp_a', cursor, 1);
      }
      expect(new Set(cursors).size).toBe(cursors.length);
      expect(cursors.every((cursor, index) => index === 0 || cursor < cursors[index - 1])).toBe(true);
      expect(page.messages.map(message => message.content)).toEqual(['old q', 'old a']);

      readCounts.count = 0;
      const engineRows = store.loadRecentBySession('grp_a', 1);
      expect(engineRows).toHaveLength(68);
      expect(readCounts.count).toBeLessThan(80);
    });


  });

  // Cascade delete + orphan compaction.
  describe('deleteByGroup', () => {
    it('removes only messages stamped with the matching sessionId', () => {
      store.appendBatch([
        { role: 'user',      content: 'A1', sessionId: 'grp_a' },
        { role: 'assistant', content: 'A2', sessionId: 'grp_a' },
        { role: 'user',      content: 'B1', sessionId: 'grp_b' },
        { role: 'user',      content: 'untagged' }, // no sessionId — must NOT be touched
      ]);

      const removed = store.deleteByGroup('grp_a');
      expect(removed).toBe(2);

      // grp_b and the untagged message are still on disk.
      expect(store.loadAll().map(m => m.content).sort()).toEqual(['B1', 'untagged']);
      expect(existsSync(join(TEST_DIR, 'chat', 'messages', 'm0001.md'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'chat', 'messages', 'm0002.md'))).toBe(false);
      expect(store.loadRecentBySession('grp_b', 10).map(m => m.content)).toEqual(['B1']);
      expect(store.loadRecent(10).map(m => m.content)).toEqual(['untagged']);
    });

    it('also removes matching messages that have been moved to cold', () => {
      store.append({ role: 'user', content: 'cold-A', sessionId: 'grp_a' });
      store.append({ role: 'user', content: 'hot-A',  sessionId: 'grp_a' });
      store.moveToCold('m0001'); // archive cold-A

      const removed = store.deleteByGroup('grp_a');
      expect(removed).toBe(2);
      expect(store.countHot()).toBe(0);
      expect(store.countCold()).toBe(0);
    });

    it('returns 0 and is a no-op for empty/null sessionId', () => {
      store.append({ role: 'user', content: 'A', sessionId: 'grp_a' });
      expect(store.deleteByGroup(null)).toBe(0);
      expect(store.deleteByGroup('')).toBe(0);
      expect(store.countHot()).toBe(1);
    });

    it('returns 0 when no message matches', () => {
      store.append({ role: 'user', content: 'A', sessionId: 'grp_a' });
      expect(store.deleteByGroup('grp_nonexistent')).toBe(0);
      expect(store.countHot()).toBe(1);
    });
  });

  describe('compactOrphans', () => {
    it('deletes messages whose sessionId is missing or unknown', () => {
      store.appendBatch([
        { role: 'user', content: 'live',     sessionId: 'grp_live' },
        { role: 'user', content: 'orphan-a', sessionId: 'grp_dead' },
        { role: 'user', content: 'orphan-b' },                       // no sessionId
        { role: 'user', content: 'live-2',   sessionId: 'grp_live' },
      ]);

      const result = store.compactOrphans({ keepGroupIds: ['grp_live'] });
      expect(result.skipped).toBe(false);
      expect(result.scanned).toBe(4);
      expect(result.removed).toBe(2);
      expect(store.loadAll().map(m => m.content).sort()).toEqual(['live', 'live-2']);
    });

    it('dryRun previews without deleting', () => {
      store.appendBatch([
        { role: 'user', content: 'live',   sessionId: 'grp_live' },
        { role: 'user', content: 'orphan' },
      ]);

      const result = store.compactOrphans({ keepGroupIds: ['grp_live'], dryRun: true });
      expect(result.removed).toBe(0);
      expect(result.orphans).toHaveLength(1);
      expect(store.countHot()).toBe(2); // nothing actually deleted
    });

    it('refuses to run when keepGroupIds is not an array (defensive)', () => {
      // If we let this through, a transient group-load failure would
      // wipe every persisted message. Bail instead.
      store.append({ role: 'user', content: 'X', sessionId: 'grp_a' });
      const result = store.compactOrphans({ keepGroupIds: undefined });
      expect(result.skipped).toBe(true);
      expect(result.removed).toBe(0);
      expect(store.countHot()).toBe(1);
    });

    it('treats an empty keepGroupIds as "everything is an orphan"', () => {
      // This is the legitimate use case: the user has zero groups left
      // and wants a clean wipe. We DO accept an empty array (vs undefined).
      store.appendBatch([
        { role: 'user', content: 'A', sessionId: 'grp_x' },
        { role: 'user', content: 'B' },
      ]);
      const result = store.compactOrphans({ keepGroupIds: [] });
      expect(result.skipped).toBe(false);
      expect(result.removed).toBe(2);
      expect(store.countHot()).toBe(0);
    });

    it('also sweeps orphans that have been moved to cold', () => {
      store.append({ role: 'user', content: 'cold-orphan', sessionId: 'grp_dead' });
      store.moveToCold('m0001');

      const result = store.compactOrphans({ keepGroupIds: ['grp_live'] });
      expect(result.removed).toBe(1);
      expect(store.countCold()).toBe(0);
    });
  });

  describe('chat history', () => {
    it('hides legacy internal control rows from chat history mirrors', () => {
      store.append({ role: 'user', content: 'chat real user', chatId: 'chat_a' });
      store.append({
        role: 'user',
        content: '<task-result id="task_chat" kind="shell" status="succeeded">\nlogTail:\n  PASS\n</task-result>',
        chatId: 'chat_a',
      });
      store.append({
        role: 'assistant',
        content: '[system note] You have called ReadTaskLog with the same arguments 3 times. Previous result: {...}',
        chatId: 'chat_a',
      });
      store.append({ role: 'assistant', content: 'chat visible assistant', chatId: 'chat_a' });
      store.append({ role: 'user', content: 'In docs, <task-result> is just prose here', chatId: 'chat_a' });

      expect(store.loadRecentByChat('chat_a', Infinity).map(m => m.content)).toEqual([
        'chat real user',
        'chat visible assistant',
        'In docs, <task-result> is just prose here',
      ]);
      expect(store.loadChatHistoryForVp('chat_a', 'vp-main').map(m => m.content)).toEqual([
        'chat real user',
        'chat visible assistant',
        'In docs, <task-result> is just prose here',
      ]);
    });
  });

  describe('moveToCold', () => {
    it('should move message from messages/ to cold/', () => {
      store.append({ role: 'user', content: 'To be archived' });

      const hotBefore = store.countHot();
      const coldBefore = store.countCold();

      store.moveToCold('m0001');

      expect(store.countHot()).toBe(hotBefore - 1);
      expect(store.countCold()).toBe(coldBefore + 1);

      // Verify file moved
      expect(existsSync(join(TEST_DIR, 'chat', 'messages', 'm0001.md'))).toBe(false);
      expect(store.countCold()).toBe(coldBefore + 1);
    });

    it('should handle non-existent message gracefully', () => {
      expect(() => store.moveToCold('m9999')).not.toThrow();
    });
  });

  describe('moveToColdBatch', () => {
    it('should move multiple messages to cold', () => {
      store.appendBatch([
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'C' },
      ]);

      store.moveToColdBatch(['m0001', 'm0002']);
      expect(store.countHot()).toBe(1);
      expect(store.countCold()).toBe(2);
    });
  });

  describe('JSONL cold rows', () => {
    it('keeps archived session rows readable while excluding them from hot counts', () => {
      const user = store.append({ role: 'user', content: 'cold question', sessionId: 'session_cold', threadId: 'main' });
      store.append({ role: 'assistant', content: 'hot answer', sessionId: 'session_cold', speakerVpId: 'vp-linus', threadId: 'main' });

      store.moveToCold(user.id);

      expect(store.countHot()).toBe(1);
      expect(store.countCold()).toBe(1);
      expect(store.loadAllBySession('session_cold').map(m => m.content)).toEqual(['cold question', 'hot answer']);
      expect(store.loadOlderBySession('session_cold', null, 10).messages.map(m => m.content)).toEqual(['cold question', 'hot answer']);
      expect(store.loadVisibleBySession('session_cold', null, 10).messages.map(m => m.content)).toEqual(['cold question', 'hot answer']);
      expect(store.loadSessionHistoryForVp('session_cold', 'vp-linus').map(m => m.content)).toEqual(['cold question', 'hot answer']);
    });
  });

  describe('hotTokens', () => {
    it('should sum token estimates', () => {
      store.appendBatch([
        { role: 'user', content: 'a'.repeat(100) },   // ~25 tokens
        { role: 'assistant', content: 'b'.repeat(200) }, // ~50 tokens
      ]);

      const tokens = store.hotTokens();
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBe(75); // 25 + 50
    });

    it('should exclude archived JSONL rows from hot token pressure', () => {
      const cold = store.append({ role: 'user', content: 'cold', sessionId: 'session_tokens', tokens_est: 25 });
      store.append({ role: 'assistant', content: 'hot', sessionId: 'session_tokens', tokens_est: 1 });

      expect(store.hotTokens()).toBe(26);
      store.moveToCold(cold.id);

      expect(store.countHot()).toBe(1);
      expect(store.countCold()).toBe(1);
      expect(store.hotTokens()).toBe(1);
      expect(store.loadAllBySession('session_tokens').map(m => m.content)).toEqual(['cold', 'hot']);
    });
  });

  describe('updateIndex', () => {
    it('should write index.md with stats', () => {
      store.appendBatch([
        { role: 'user', content: 'Test' },
      ]);
      store.updateIndex({ lastMessageId: 'm0001' });

      const indexPath = join(TEST_DIR, 'chat', 'index.md');
      expect(existsSync(indexPath)).toBe(true);

      const content = readFileSync(indexPath, 'utf8');
      expect(content).toContain('lastMessageId: m0001');
      expect(content).toContain('hotMessages: 1');
    });
  });

  describe('clear', () => {
    it('should remove all messages and reset state', () => {
      store.appendBatch([
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ]);
      store.moveToCold('m0001');

      store.clear();

      expect(store.countHot()).toBe(0);
      expect(store.countCold()).toBe(0);
    });

    it('should reset sequence numbering', () => {
      store.append({ role: 'user', content: 'Old' });
      store.clear();
      const msg = store.append({ role: 'user', content: 'New' });
      expect(msg.id).toBe('m0001');
    });
  });

  describe('sequence persistence', () => {
    it('should continue sequence across instances', () => {
      store.appendBatch([
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ]);

      // Create new store instance
      const store2 = new ConversationStore(TEST_DIR);
      const msg = store2.append({ role: 'user', content: 'C' });
      expect(msg.id).toBe('m0003');
    });

    it('should account for cold messages in sequence', () => {
      store.appendBatch([
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ]);
      store.moveToCold('m0001');

      const store2 = new ConversationStore(TEST_DIR);
      const msg = store2.append({ role: 'user', content: 'C' });
      expect(msg.id).toBe('m0003'); // not m0002
    });
  });

  describe('round-trip serialization', () => {
    it('should preserve all fields through write/read cycle', () => {
      store.append({
        role: 'assistant',
        content: 'Here is the result.',
        mode: 'work',
        model: 'claude-sonnet-4-20250514',
        turnNumber: 2,
        turnId: 'turn-route-forward',
        executionOrigin: 'route_forward',
        responseKind: 'result',
        stopReason: 'end_turn',
      });

      const loaded = store.loadRecent(1);
      expect(loaded[0].role).toBe('assistant');
      expect(loaded[0].content).toBe('Here is the result.');
      expect(loaded[0].mode).toBe('work');
      expect(loaded[0].model).toBe('claude-sonnet-4-20250514');
      expect(loaded[0].turnNumber).toBe(2);
      expect(loaded[0].turnId).toBe('turn-route-forward');
      expect(loaded[0].executionOrigin).toBe('route_forward');
      expect(loaded[0].responseKind).toBe('result');
      expect(loaded[0].stopReason).toBe('end_turn');
    });

    it('should preserve tool message fields', () => {
      // Tool messages need their owning assistant in the slice for
      // pairSanitize to keep them — write the assistant first.
      store.append({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_abc', name: 'bash', input: {} }],
      });
      store.append({
        role: 'tool',
        content: 'Tool output here',
        toolCallId: 'call_abc',
        isError: true,
      });

      const loaded = store.loadRecent(2);
      // pairSanitize keeps both since they're paired.
      const tool = loaded.find(m => m.role === 'tool');
      expect(tool).toBeDefined();
      expect(tool.toolCallId).toBe('call_abc');
      expect(tool.isError).toBe(true);
    });
  });

  // ─── Legacy flat dir regression guard: the legacy
  //     conversation/messages/ and conversation/cold/ flat directories
  //     are NEVER scanned when loading session history.  All session
  //     messages now live exclusively in per-session directories, and
  //     scanning the flat dirs would be a pure-performance regression.
  describe('legacy dir is never scanned', () => {
    function writeLegacyMessage(baseDir, seq, sessionId, role, content) {
      const msgDir = join(baseDir, 'conversation', 'messages');
      mkdirSync(msgDir, { recursive: true });
      const id = `m${String(seq).padStart(4, '0')}`;
      const raw = `---
id: ${id}
role: ${role}
time: 2026-06-21T10:00:00Z
threadId: main
sessionId: ${sessionId}
tokens_est: 5
---

${content}`;
      writeFileSync(join(msgDir, `${id}.md`), raw, { encoding: 'utf8', mode: 0o644 });
    }

    it('never reads from the legacy flat messages/ dir', () => {
      const store = new ConversationStore(TEST_DIR);

      // Write a message into the legacy flat dir.
      writeLegacyMessage(TEST_DIR, 1, 'grp_never', 'user', 'legacy msg');

      // Also write the session's own message via append (dedicated dir).
      store.append({ role: 'user', content: 'dedicated msg', sessionId: 'grp_never' });

      // Legacy message must NOT appear — flat dir is never scanned.
      const recent = store.loadRecentBySession('grp_never', 50);
      expect(recent.map(m => m.content)).toEqual(['dedicated msg']);

      const visible = store.loadVisibleBySession('grp_never', null, 10);
      expect(visible.messages.map(m => m.content)).toEqual(['dedicated msg']);

      const older = store.loadOlderBySession('grp_never', null, 10);
      expect(older.messages.map(m => m.content)).toEqual(['dedicated msg']);

      const appended = store.append({ role: 'user', content: 'delta', sessionId: 'grp_never' });
      const seq = Number(appended.id.replace(/^m/, ''));
      const delta = store.loadAfterSeqByGroup('grp_never', seq - 2);
      expect(delta.messages.map(m => m.content)).toEqual(['dedicated msg', 'delta']);
    });

    it('session with no dedicated dirs returns empty (no legacy fallback)', () => {
      const store = new ConversationStore(TEST_DIR);
      writeLegacyMessage(TEST_DIR, 1, 'grp_legacy_only', 'user', 'legacy-only msg');

      // No dedicated dir at all → no legacy fallback → empty.
      const recent = store.loadRecentBySession('grp_legacy_only', 50);
      expect(recent).toEqual([]);

      const visible = store.loadVisibleBySession('grp_legacy_only', null, 10);
      expect(visible.messages).toEqual([]);

      const page = store.loadOlderBySession('grp_legacy_only', null, 10);
      expect(page.messages).toEqual([]);
    });

    it('loadVisibleBySession respects turn window without legacy interference', () => {
      const store = new ConversationStore(TEST_DIR);
      writeLegacyMessage(TEST_DIR, 1, 'grp_window', 'user', 'legacy');

      // Write 3 dedicated user turns.
      store.append({ role: 'user', content: 'turn0', sessionId: 'grp_window' });
      store.append({ role: 'assistant', content: 'reply0', sessionId: 'grp_window' });
      store.append({ role: 'user', content: 'turn1', sessionId: 'grp_window' });
      store.append({ role: 'assistant', content: 'reply1', sessionId: 'grp_window' });
      store.append({ role: 'user', content: 'turn2', sessionId: 'grp_window' });
      store.append({ role: 'assistant', content: 'reply2', sessionId: 'grp_window' });

      // Limit to 2 turns — only turn1 and turn2 should appear.
      const visible = store.loadVisibleBySession('grp_window', null, 2);
      expect(visible.messages.map(m => m.content)).toEqual([
        'turn1', 'reply1', 'turn2', 'reply2',
      ]);
      expect(visible.hasMore).toBe(true);
    });
  });
});
