/**
 * group-history-dedup.test.js — Multi-VP fan-out single-write invariant.
 *
 * Bug: when a user prompt fans out to N VPs in a group, each VP's Engine
 * independently calls `runStopHooks` to persist the just-finished turn.
 * Pre-fix, the hook walked back to the last `role:'user'` and wrote it
 * along with that VP's assistant + tool rows, producing N copies of the
 * SAME user message on disk. On reload `handleYeaftLoadHistory` then
 * replayed the user prompt N times, sandwiching one VP's reply between
 * two copies of the user message — which reads as "messages out of
 * order" in the UI.
 *
 * Fix: the orchestrator persists the user row exactly once (keyed by the
 * coordinator-minted msg.id) BEFORE fan-out, then passes
 * `userAlreadyPersisted: true` into each VP's `engine.query` so the
 * stop-hook skips the user-row append while still writing assistant +
 * tool rows for that VP.
 *
 * This test pins the invariant directly at the stop-hook layer:
 *
 *   Given two stop-hook runs for two VPs with the SAME user prompt
 *   (same conversationMessages prefix), and `userAlreadyPersisted:true`,
 *   exactly ZERO user-role records land on disk via the hook — and BOTH
 *   VPs' assistant rows DO land. Combined with the orchestrator's
 *   one-time pre-fan-out write, the total user-row count is exactly 1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConversationStore, parseMessage } from '../../../agent/yeaft/conversation/persist.js';
import { runStopHooks } from '../../../agent/yeaft/stop-hooks.js';

let TEST_DIR;
let store;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'yeaft-history-dedup-'));
  store = new ConversationStore(TEST_DIR);
});
afterEach(() => {
  try {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  } catch { /* */ }
});

/**
 * Read every persisted message from the hot dir, sorted by filename
 * (which equals chronological order via mNNNN.md sequencing).
 */
function readAllPersisted() {
  const dir = join(TEST_DIR, 'conversation', 'messages');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  return files.map(f => parseMessage(readFileSync(join(dir, f), 'utf8')));
}

describe('runStopHooks userAlreadyPersisted (group-history-dedup)', () => {
  it('1. with userAlreadyPersisted=false (legacy single-VP path), the user row IS written', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi from solo' },
    ];
    const result = await runStopHooks({
      yeaftDir: TEST_DIR,
      mode: 'chat',
      conversationStore: store,
      adapter: {},
      config: { model: 'm' },
      messages,
      groupId: 'g1',
    });
    expect(result.errors).toEqual([]);
    expect(result.messagesPersisted).toBe(2);

    const persisted = readAllPersisted();
    expect(persisted).toHaveLength(2);
    expect(persisted[0].role).toBe('user');
    expect(persisted[0].content).toBe('hello');
    expect(persisted[0].groupId).toBe('g1');
    expect(persisted[1].role).toBe('assistant');
    expect(persisted[1].content).toBe('hi from solo');
  });

  it('2. with userAlreadyPersisted=true (group fan-out path), the user row is SKIPPED', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi from VP-A' },
    ];
    const result = await runStopHooks({
      yeaftDir: TEST_DIR,
      mode: 'chat',
      conversationStore: store,
      adapter: {},
      config: { model: 'm' },
      messages,
      groupId: 'g1',
      userAlreadyPersisted: true,
    });
    expect(result.errors).toEqual([]);
    // Only the assistant row landed (the user row was skipped).
    expect(result.messagesPersisted).toBe(1);

    const persisted = readAllPersisted();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].role).toBe('assistant');
    expect(persisted[0].content).toBe('hi from VP-A');
  });

  it('3. fan-out invariant — two VPs running the hook for the same user prompt produce ZERO duplicate user rows when the orchestrator already wrote it once', async () => {
    // Step 1: orchestrator writes the user row exactly once before fan-out.
    // (In production, web-bridge.persistInboundMessageOnceByMsgId does this,
    //  keyed on coordinator-minted msg.id.)
    store.append({ role: 'user', content: 'hello group', groupId: 'g1', threadId: 'main' });

    // Step 2: VP-A's engine completes its turn and runs stop-hook with
    // the conversation prefix that includes the shared user message.
    const messagesA = [
      { role: 'user', content: 'hello group' },
      { role: 'assistant', content: 'A: hi back' },
    ];
    const resA = await runStopHooks({
      yeaftDir: TEST_DIR,
      mode: 'chat',
      conversationStore: store,
      adapter: {},
      config: { model: 'm' },
      messages: messagesA,
      groupId: 'g1',
      userAlreadyPersisted: true,
    });
    expect(resA.errors).toEqual([]);

    // Step 3: VP-B's engine completes its turn and runs its OWN stop-hook
    // with the same shared user prefix. This is the path that, pre-fix,
    // wrote a duplicate copy of the user row.
    const messagesB = [
      { role: 'user', content: 'hello group' },
      { role: 'assistant', content: 'B: hello to you' },
    ];
    const resB = await runStopHooks({
      yeaftDir: TEST_DIR,
      mode: 'chat',
      conversationStore: store,
      adapter: {},
      config: { model: 'm' },
      messages: messagesB,
      groupId: 'g1',
      userAlreadyPersisted: true,
    });
    expect(resB.errors).toEqual([]);

    // Invariant: exactly ONE user row on disk, two assistant rows (one per VP).
    const persisted = readAllPersisted();
    const userRows = persisted.filter(m => m.role === 'user');
    const assistantRows = persisted.filter(m => m.role === 'assistant');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].content).toBe('hello group');
    expect(userRows[0].groupId).toBe('g1');
    expect(assistantRows).toHaveLength(2);
    const assistantContents = assistantRows.map(m => m.content).sort();
    expect(assistantContents).toEqual(['A: hi back', 'B: hello to you'].sort());
  });

  it('4. assistant + tool rows in the turn are still persisted under userAlreadyPersisted', async () => {
    const messages = [
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'test_tool', input: { arg: 1 } }],
      },
      { role: 'tool', toolCallId: 'tc1', content: 'tool_result_ok' },
    ];
    const result = await runStopHooks({
      yeaftDir: TEST_DIR,
      mode: 'chat',
      conversationStore: store,
      adapter: {},
      config: { model: 'm' },
      messages,
      groupId: 'g1',
      userAlreadyPersisted: true,
    });
    expect(result.errors).toEqual([]);
    // user skipped, assistant + tool persisted.
    expect(result.messagesPersisted).toBe(2);

    const persisted = readAllPersisted();
    expect(persisted).toHaveLength(2);
    expect(persisted.find(m => m.role === 'user')).toBeUndefined();
    const assistant = persisted.find(m => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0].id).toBe('tc1');
    expect(assistant.toolCalls[0].input).toEqual({ arg: 1 });
    const tool = persisted.find(m => m.role === 'tool');
    expect(tool).toBeDefined();
    expect(tool.toolCallId).toBe('tc1');
  });

  it('5. groupId stamping still applies to non-user rows under userAlreadyPersisted', async () => {
    const messages = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    await runStopHooks({
      yeaftDir: TEST_DIR,
      mode: 'chat',
      conversationStore: store,
      adapter: {},
      config: { model: 'm' },
      messages,
      groupId: 'group-xyz',
      userAlreadyPersisted: true,
    });
    const persisted = readAllPersisted();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].role).toBe('assistant');
    expect(persisted[0].groupId).toBe('group-xyz');
  });
});
