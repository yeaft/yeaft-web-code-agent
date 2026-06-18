import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConversationStore, parseMessage, estimateTokens } from '../../../../agent/yeaft/conversation/persist.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-conv-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── estimateTokens ──────────────────────────────────────────

describe('estimateTokens', () => {
  it('should estimate ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('should return 0 for empty/null', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});

// ─── parseMessage ────────────────────────────────────────────

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

  it('should return null for invalid input', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('')).toBeNull();
    expect(parseMessage('no frontmatter')).toBeNull();
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

  it('should parse turnNumber', () => {
    const raw = `---
id: m0003
role: assistant
time: 2026-04-10T10:02:00Z
turnNumber: 3
tokens_est: 20
---

Response text`;

    const msg = parseMessage(raw);
    expect(msg.turnNumber).toBe(3);
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

  describe('constructor', () => {
    it('should create chat and sessions root but not obsolete group history directories', () => {
      expect(existsSync(join(TEST_DIR, 'chat', 'messages'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'chat', 'cold'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'sessions'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'groups'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'group'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'conversation'))).toBe(false);
    });
  });

  describe('append', () => {
    it('should write a message file', () => {
      const msg = store.append({ role: 'user', content: 'Hello' });
      expect(msg.id).toBe('m0001');
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello');
      expect(msg.time).toBeTruthy();
      expect(msg.tokens_est).toBeGreaterThan(0);

      const filePath = join(TEST_DIR, 'chat', 'messages', 'm0001.md');
      expect(existsSync(filePath)).toBe(true);
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

    it('should auto-increment sequence numbers', () => {
      const msg1 = store.append({ role: 'user', content: 'First' });
      const msg2 = store.append({ role: 'assistant', content: 'Second' });
      expect(msg1.id).toBe('m0001');
      expect(msg2.id).toBe('m0002');
    });

    it('should persist mode and model', () => {
      store.append({ role: 'user', content: 'Test', mode: 'work', model: 'gpt-5' });
      const loaded = store.loadRecent(1);
      expect(loaded[0].mode).toBe('work');
      expect(loaded[0].model).toBe('gpt-5');
    });
  });


    it("should write session messages under that session's conversation history", () => {
      const msg = store.append({ role: 'user', content: 'Hello session', sessionId: 's_fun' });
      expect(msg.id).toBe('m0001');
      expect(existsSync(join(TEST_DIR, 'sessions', 's_fun', 'conversation', 'messages', 'm0001.md'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'groups', 's_fun', 'conversation', 'messages', 'm0001.md'))).toBe(false);
      expect(existsSync(join(TEST_DIR, 'chat', 'messages', 'm0001.md'))).toBe(false);
      expect(store.loadRecent(10)).toEqual([]);
      expect(store.loadRecentBySession('s_fun', 10)).toHaveLength(1);
    });

    it('should read legacy conversation paths without mixing chat and session records', () => {
      const legacyMessages = join(TEST_DIR, 'conversation', 'messages');
      mkdirSync(legacyMessages, { recursive: true });
      const chatStore = new ConversationStore(TEST_DIR);
      const chatMsg = chatStore.append({ role: 'user', content: 'legacy chat' });
      const sessionMsg = chatStore.append({ role: 'user', content: 'legacy session', sessionId: 's_fun' });
      // Move freshly-written records into the legacy layout to simulate an
      // existing user profile from versions before ~/.yeaft/chat and
      // per-session conversation directories were split.
      const chatRaw = readFileSync(join(TEST_DIR, 'chat', 'messages', `${chatMsg.id}.md`), 'utf8');
      const sessionRaw = readFileSync(join(TEST_DIR, 'sessions', 's_fun', 'conversation', 'messages', `${sessionMsg.id}.md`), 'utf8');
      rmSync(join(TEST_DIR, 'chat', 'messages', `${chatMsg.id}.md`));
      rmSync(join(TEST_DIR, 'sessions', 's_fun', 'conversation', 'messages', `${sessionMsg.id}.md`));
      writeFileSync(join(legacyMessages, `${chatMsg.id}.md`), chatRaw);
      writeFileSync(join(legacyMessages, `${sessionMsg.id}.md`), sessionRaw);

      const compatStore = new ConversationStore(TEST_DIR);
      expect(compatStore.loadRecent(10).map(m => m.content)).toEqual(['legacy chat']);
      expect(compatStore.loadRecentBySession('s_fun', 10).map(m => m.content)).toEqual(['legacy session']);
    });

  describe('appendBatch', () => {
    it('should write multiple messages', () => {
      const messages = store.appendBatch([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'How are you?' },
      ]);
      expect(messages).toHaveLength(3);
      expect(messages[0].id).toBe('m0001');
      expect(messages[1].id).toBe('m0002');
      expect(messages[2].id).toBe('m0003');
    });
  });

  describe('loadRecent', () => {
    it('should load messages sorted chronologically', () => {
      store.appendBatch([
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
      ]);

      const loaded = store.loadRecent(10);
      expect(loaded).toHaveLength(3);
      expect(loaded[0].content).toBe('First');
      expect(loaded[2].content).toBe('Third');
    });

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

    it('should return empty array when no messages', () => {
      expect(store.loadRecent()).toEqual([]);
    });
  });

  describe('loadAll', () => {
    it('should load all hot messages', () => {
      store.appendBatch([
        { role: 'user', content: 'A' },
        { role: 'user', content: 'B' },
        { role: 'user', content: 'C' },
      ]);
      expect(store.loadAll()).toHaveLength(3);
    });
  });

  // Group-history-isolation (Bug 7): group-scoped loaders.
  describe('loadRecentBySession / loadAllBySession', () => {
    it('returns only messages stamped with the requested sessionId', () => {
      store.appendBatch([
        { role: 'user',      content: 'A1', sessionId: 'grp_a' },
        { role: 'assistant', content: 'A2', sessionId: 'grp_a' },
        { role: 'user',      content: 'B1', sessionId: 'grp_b' },
        { role: 'user',      content: 'A3', sessionId: 'grp_a' },
      ]);
      const a = store.loadRecentBySession('grp_a', 50);
      const b = store.loadRecentBySession('grp_b', 50);
      expect(a.map(m => m.content)).toEqual(['A1', 'A2', 'A3']);
      expect(b.map(m => m.content)).toEqual(['B1']);
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

    it('loadAfterSeqByGroup skips internal route_forward handoff rows', () => {
      const first = store.append({ role: 'user', content: 'real user', sessionId: 'grp_a' });
      store.append({
        role: 'assistant',
        content: '@vp-martin internal handoff',
        sessionId: 'grp_a',
        speakerVpId: 'vp-linus',
        internal: true,
      });
      store.append({ role: 'assistant', content: 'target response', sessionId: 'grp_a', speakerVpId: 'vp-martin' });

      const page = store.loadAfterSeqByGroup('grp_a', Number(first.id.replace(/^m/, '')));
      expect(page.messages.map(m => m.content)).toEqual(['target response']);
    });

    it('returns [] for empty/null sessionId without throwing', () => {
      store.append({ role: 'user', content: 'X', sessionId: 'grp_a' });
      expect(store.loadRecentBySession(null, 10)).toEqual([]);
      expect(store.loadRecentBySession('', 10)).toEqual([]);
    });

    it('loadAllBySession mirrors loadRecentBySession with no limit', () => {
      const big = Array.from({ length: 80 }, (_, i) => ({
        role: 'user', content: `m${i}`, sessionId: 'grp_a',
      }));
      store.appendBatch(big);
      expect(store.loadAllBySession('grp_a')).toHaveLength(80);
      expect(store.loadRecentBySession('grp_a', 50)).toHaveLength(50);
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
      expect(existsSync(join(TEST_DIR, 'sessions', 'grp_b', 'conversation', 'messages', 'm0003.md'))).toBe(true);
      expect(existsSync(join(TEST_DIR, 'chat', 'messages', 'm0004.md'))).toBe(true);
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
      expect(existsSync(join(TEST_DIR, 'chat', 'cold', 'm0001.md'))).toBe(true);
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

  describe('compact summary', () => {
    it('should write and read compact summary', () => {
      store.replaceCompactSummary('User discussed TypeScript.');
      const summary = store.readCompactSummary();
      expect(summary).toContain('User discussed TypeScript.');
    });

    it('should overwrite on each call (rewrite-in-place semantics)', () => {
      // Each compact pass rewrites the running summary. Appending was
      // the legacy behaviour but produced an unbounded prompt block —
      // see persist.js#replaceCompactSummary.
      store.replaceCompactSummary('First summary.');
      store.replaceCompactSummary('Second summary.');
      const summary = store.readCompactSummary();
      expect(summary).not.toContain('First summary.');
      expect(summary).toContain('Second summary.');
    });

    it('should return empty string when no compact', () => {
      expect(store.readCompactSummary()).toBe('');
    });
  });

  describe('countHot / countCold', () => {
    it('should count messages correctly', () => {
      expect(store.countHot()).toBe(0);
      expect(store.countCold()).toBe(0);

      store.appendBatch([
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
      ]);

      expect(store.countHot()).toBe(2);
      expect(store.countCold()).toBe(0);
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
      store.replaceCompactSummary('Summary');

      store.clear();

      expect(store.countHot()).toBe(0);
      expect(store.countCold()).toBe(0);
      expect(store.readCompactSummary()).toBe('');
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
      });

      const loaded = store.loadRecent(1);
      expect(loaded[0].role).toBe('assistant');
      expect(loaded[0].content).toBe('Here is the result.');
      expect(loaded[0].mode).toBe('work');
      expect(loaded[0].model).toBe('claude-sonnet-4-20250514');
      expect(loaded[0].turnNumber).toBe(2);
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
});
