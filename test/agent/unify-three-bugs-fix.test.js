/**
 * Tests for the "three Unify bugs" fix.
 *
 * Bug 1 — Server must generically relay any `unify_*` message to the
 *         agent so newly-added agent routes (vp_subscribe,
 *         user_memory_*, *_group, memory_scope_list) do not need a
 *         bespoke server case. Previously the server dropped
 *         `unify_vp_subscribe` and `GroupCreateWizard` hung on
 *         "VP 加载中...".
 *
 * Bug 2 — `memory_scope_snapshot` is the reply to
 *         `unify_memory_scope_list`. The agent router must dispatch
 *         this type and the web-bridge must expose a handler.
 *         UserMemoryPage renders a folder tree from the reply.
 *
 * Bug 3 — Multi-turn tool-call history preservation. Three layers:
 *         (a) web-bridge collects toolCalls/tool results on each turn
 *             and appends them as paired messages into threadMessages.
 *         (b) stop-hooks walks back to the last user message (not
 *             `slice(-2)`) and persists assistant + all tool results.
 *         (c) persist.js round-trips tool_call `input` via base64 so
 *             multi-line arguments survive the YAML frontmatter.
 *         (d) restoreThreadHistoryFromRecent keeps role:'tool' msgs
 *             and the toolCalls/toolCallId fields.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConversationStore } from '../../agent/unify/conversation/persist.js';

const ROOT = join(import.meta.dirname, '..', '..');
const WEB_BRIDGE = readFileSync(join(ROOT, 'agent', 'unify', 'web-bridge.js'), 'utf8');
const STOP_HOOKS = readFileSync(join(ROOT, 'agent', 'unify', 'stop-hooks.js'), 'utf8');
const MSG_ROUTER = readFileSync(join(ROOT, 'agent', 'connection', 'message-router.js'), 'utf8');
const CLIENT_CONV = readFileSync(join(ROOT, 'server', 'handlers', 'client-conversation.js'), 'utf8');
const USER_MEM = readFileSync(join(ROOT, 'web', 'components', 'UserMemoryPage.js'), 'utf8');
const UNIFY_PAGE = readFileSync(join(ROOT, 'web', 'components', 'UnifyPage.js'), 'utf8');
const CHAT_STORE = readFileSync(join(ROOT, 'web', 'stores', 'chat.js'), 'utf8');

// ── Bug 1: generic unify_* relay on server ────────────────────

describe('Bug 1 — server relays any unify_* message to agent', () => {
  it('client-conversation default case inspects msg.type for unify_ prefix', () => {
    expect(CLIENT_CONV).toMatch(/startsWith\(['"]unify_['"]\)/);
  });

  it('relay uses forwardToAgent and strips the agentId envelope field', () => {
    expect(CLIENT_CONV).toContain('forwardToAgent(relayAgentId, rest)');
    expect(CLIENT_CONV).toMatch(/const \{ agentId: _discard, \.\.\.rest \} = msg/);
  });

  it('relay still goes through checkAgentAccess', () => {
    // The generic block must reuse the auth helper; otherwise we
    // would open a back-door for any unify_* type.
    expect(CLIENT_CONV).toMatch(/checkAgentAccess\(relayAgentId\)/);
  });
});

// ── Bug 2: memory_scope_list route + reply + UI ───────────────

describe('Bug 2 — memory scope list round-trip', () => {
  it('agent message-router dispatches unify_memory_scope_list', () => {
    expect(MSG_ROUTER).toContain("case 'unify_memory_scope_list'");
    expect(MSG_ROUTER).toContain('handleUnifyMemoryScopeList');
  });

  it('web-bridge exports handleUnifyMemoryScopeList and replies with memory_scope_snapshot', () => {
    expect(WEB_BRIDGE).toContain('export function handleUnifyMemoryScopeList');
    expect(WEB_BRIDGE).toMatch(/type:\s*['"]memory_scope_snapshot['"]/);
    // Must source entries from MemoryStore.listEntries (not the
    // unrelated user-memory shard store).
    expect(WEB_BRIDGE).toContain('session.memoryStore');
    expect(WEB_BRIDGE).toMatch(/listEntries\(\)/);
  });

  it('UserMemoryPage renders a scope-tree section and exposes it from setup', () => {
    expect(USER_MEM).toContain('um-scope-section');
    expect(USER_MEM).toContain('scopeTree');
    expect(USER_MEM).toContain('toggleFolder');
    expect(USER_MEM).toContain('refreshScope');
    // setup() must return the reactive refs & functions used by the
    // template, otherwise they are undefined on render.
    expect(USER_MEM).toMatch(/return\s*\{[\s\S]*scopeTree[\s\S]*toggleFolder[\s\S]*\}/);
  });

  it('chat store handles memory_scope_snapshot and exposes fetch action', () => {
    expect(CHAT_STORE).toContain('memory_scope_snapshot');
    expect(CHAT_STORE).toContain('unifyMemoryScopeEntries');
    expect(CHAT_STORE).toContain('fetchUnifyMemoryScope');
  });

  it('UnifyPage hides the chat input when the user-memory page is open', () => {
    // Regression guard for the "还能有对话框" bug. The input
    // component must be gated by !userMemoryOpen.
    expect(UNIFY_PAGE).toMatch(/v-if=["']!showSettings\s*&&\s*!userMemoryOpen["']/);
  });
});

// ── Bug 3: tool-call / tool-result history preservation ───────

describe('Bug 3a — web-bridge preserves toolCalls + tool results across turns', () => {
  it('handleEngineEvent accumulates tool_call into toolCallsAccum', () => {
    expect(WEB_BRIDGE).toContain('toolCallsAccum');
    expect(WEB_BRIDGE).toMatch(/hctx\.toolCallsAccum\.push\(/);
  });

  it('handleEngineEvent accumulates tool_end into toolResultsAccum as role:tool', () => {
    expect(WEB_BRIDGE).toContain('toolResultsAccum');
    expect(WEB_BRIDGE).toMatch(/hctx\.toolResultsAccum\.push\(/);
    expect(WEB_BRIDGE).toMatch(/role:\s*['"]tool['"]/);
    expect(WEB_BRIDGE).toContain('toolCallId');
  });

  it('after the turn, threadMessages gains assistant{toolCalls} + paired role:tool entries', () => {
    // The bridge appends one assistant message carrying toolCalls
    // and then one role:'tool' per collected result.
    expect(WEB_BRIDGE).toMatch(/assistantMsg\.toolCalls\s*=/);
    expect(WEB_BRIDGE).toMatch(/for\s*\(\s*const\s+tr\s+of\s+toolResultsAccum\s*\)/);
  });

  it('restoreThreadHistoryFromRecent keeps role:tool and restores toolCalls/toolCallId', () => {
    expect(WEB_BRIDGE).toContain('restoreThreadHistoryFromRecent');
    // The restored entry must carry toolCallId and toolCalls when
    // the persisted record had them.
    expect(WEB_BRIDGE).toMatch(/if \(m\.toolCallId\) entry\.toolCallId = m\.toolCallId/);
    expect(WEB_BRIDGE).toMatch(/entry\.toolCalls = m\.toolCalls\.map/);
    // Regression: must no longer early-continue on tool role.
    expect(WEB_BRIDGE).toMatch(/m\.role !== ['"]user['"] && m\.role !== ['"]assistant['"] && m\.role !== ['"]tool['"]/);
  });
});

describe('Bug 3b — stop-hooks walks back to turn start, not slice(-2)', () => {
  it('stop-hooks no longer uses slice(-2)', () => {
    // Old code used `messages.slice(-2)` which loses tool messages
    // when a turn has several tool calls.
    expect(STOP_HOOKS).not.toMatch(/messages\.slice\(-2\)/);
  });

  it('stop-hooks computes turnStart by scanning backward for role:user', () => {
    expect(STOP_HOOKS).toContain('turnStart');
    expect(STOP_HOOKS).toMatch(/messages\[i\]\.role === ['"]user['"]/);
    expect(STOP_HOOKS).toContain('messages.slice(turnStart)');
  });

  it('stop-hooks persists toolCallId, toolCalls, and isError', () => {
    expect(STOP_HOOKS).toMatch(/record\.toolCallId\s*=/);
    expect(STOP_HOOKS).toMatch(/record\.toolCalls\s*=/);
    expect(STOP_HOOKS).toMatch(/record\.isError\s*=/);
  });
});

// ── Bug 3c — persist.js round-trips tool_call input ───────────

describe('Bug 3c — ConversationStore round-trips tool_call input', () => {
  let TEST_DIR;
  let store;

  beforeEach(() => {
    TEST_DIR = join(tmpdir(), `yeaft-threebugs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(TEST_DIR, { recursive: true });
    store = new ConversationStore(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('preserves multi-line tool_call input through append + loadRecent', () => {
    const input = {
      command: "echo 'hello'\nls -la",
      description: 'with "quotes" and\nnewlines',
      nested: { a: 1, b: [1, 2, 3] },
    };
    store.append({
      role: 'assistant',
      content: 'running a tool',
      toolCalls: [{ id: 'call_abc', name: 'bash', input }],
    });

    const loaded = store.loadRecent(5);
    const asst = loaded.find(m => m.role === 'assistant');
    expect(asst).toBeTruthy();
    expect(asst.toolCalls).toHaveLength(1);
    expect(asst.toolCalls[0].id).toBe('call_abc');
    expect(asst.toolCalls[0].name).toBe('bash');
    expect(asst.toolCalls[0].input).toEqual(input);
  });

  it('persists a paired role:tool message with its toolCallId', () => {
    store.append({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_xyz', name: 'bash', input: { command: 'ls' } }],
    });
    store.append({
      role: 'tool',
      toolCallId: 'call_xyz',
      content: 'file1\nfile2',
    });

    const loaded = store.loadRecent(5);
    const tool = loaded.find(m => m.role === 'tool');
    expect(tool).toBeTruthy();
    expect(tool.toolCallId).toBe('call_xyz');
    expect(tool.content).toBe('file1\nfile2');
  });
});
