/**
 * engine-reflect-persist.test.js — Reflect 落盘契约测试。
 *
 * 这是 PR-state-ownership 的核心 TDD 测试。我们要保证：
 *
 *   T1 触发后，磁盘上落的是 collapsed 形态（reflection user msg + 最终
 *   assistant），而不是 13 条 tool_use+tool_result 原始记录。
 *
 *   这样下一个 turn loadRecentByGroup 看到的是 reflection，省 context
 *   的效果跨 turn 持久化。
 *
 * 当前（修复前）行为：
 *   - Engine 在内存里 collapse 了
 *   - stop-hooks 收到的 conversationMessages 已经是 collapsed
 *   - turnStart 找最后一个 user → 找到 reflection 那条（collapse 的产物
 *     也是 user role）
 *   - 写盘时只写 reflection + assistant
 *   - 但是！原始 13 条 tool_use+tool_result 在 collapse 之前 **从未** 被写盘
 *     （stop-hooks 只在 turn end 写，不是 incremental），所以"原始记录"
 *     这个问题不存在
 *   - 但是！有 vp_user_already_persisted 的机制：原始 user prompt 在 fan-out
 *     之前由 persistUserMessageOnce 写过一次，然后 stop-hooks 跳过 user 行
 *     ⇒ 但 stop-hooks 找 turnStart 是用 role==='user' 启发式，会找到
 *     reflection 那条（_reflection: true 但 role: 'user'），把 reflection
 *     当成"本 turn 起点"，结果 reflection 之前的 assistant 消息（如果有）
 *     不会被写盘
 *
 * 这个测试钉住正确行为：
 *   - turn 起点应该是本次 query 的真实 user prompt
 *   - 该 turn 的 assistant + tool 序列被 collapse 后，磁盘上看到的是
 *     reflection user msg + 最后的 assistant 消息
 *   - 不管中间发生过多少 collapse，磁盘上没有原始 tool 记录
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import { ConversationStore } from '../../../agent/unify/conversation/persist.js';

class ScriptedAdapter {
  constructor({ toolUseTurns = 13 } = {}) {
    this.toolUseTurns = toolUseTurns;
    this.streamCalls = [];
    this.callCalls = [];
    this._counter = 0;
  }
  async *stream(params) {
    this.streamCalls.push({
      messages: JSON.parse(JSON.stringify(params.messages || [])),
    });
    if (this._counter < this.toolUseTurns) {
      this._counter += 1;
      const id = `tc-${this._counter}`;
      yield { type: 'tool_call', id, name: 'echo', input: { i: this._counter } };
      yield { type: 'stop', stopReason: 'tool_use' };
    } else {
      yield { type: 'text_delta', text: 'all done' };
      yield { type: 'stop', stopReason: 'end_turn' };
    }
  }
  async call() {
    return {
      text: '## What was attempted\nbatched 13 tools\n## Key findings\nnone\n## Direction check\nok\n## Suggested next direction\ncontinue\n## Tool execution log\necho × 13',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

class EchoTool {
  constructor() {
    this.name = 'echo';
    this.description = 'echo';
    this.parameters = { type: 'object', properties: {} };
  }
  async execute(input) {
    return `echo:${JSON.stringify(input)}`;
  }
}

function mkEngine(adapter, yeaftDir) {
  const conversationStore = new ConversationStore(yeaftDir);
  const engine = new Engine({
    adapter,
    trace: new NullTrace(),
    config: {
      model: 'test-model',
      maxOutputTokens: 1024,
      language: 'en',
      // Critically NOT _readOnly — we want stop-hooks to actually
      // hit the disk so we can assert on what got persisted.
    },
    conversationStore,
    yeaftDir,
  });
  engine.registerTool(new EchoTool());
  return { engine, conversationStore };
}

describe('Reflect persistence — T1 collapse should land on disk in collapsed form', () => {
  it('after 13-tool T1 collapse, disk shows reflection (not raw tool pairs)', async () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-reflect-persist-'));
    try {
      const adapter = new ScriptedAdapter({ toolUseTurns: 13 });
      const { engine, conversationStore } = mkEngine(adapter, yeaftDir);

      for await (const _ of engine.query({
        prompt: 'do something with 13 tools',
        messages: [],
        groupId: 'g1',
      })) {
        /* drain */
      }

      const persisted = conversationStore.loadAllByGroup('g1');

      // What we want on disk for THIS turn:
      //   - the original user prompt (kept; fold-down doesn't touch it)
      //   - the reflection synthetic user msg (collapsed form of the
      //     13-tool arc)
      //   - the final assistant message ('all done')
      //
      // What we EXPLICITLY do NOT want:
      //   - any role:'tool' record (tool results)
      //   - assistant records carrying toolCalls (raw tool_use blocks)
      const toolMsgs = persisted.filter(m => m.role === 'tool');
      const assistantWithToolCalls = persisted.filter(
        m => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
      );

      expect(toolMsgs).toHaveLength(0);
      expect(assistantWithToolCalls).toHaveLength(0);

      // The original user prompt should be there exactly once.
      const promptMsgs = persisted.filter(
        m => m.role === 'user' && typeof m.content === 'string'
          && m.content.includes('do something with 13 tools'),
      );
      expect(promptMsgs).toHaveLength(1);

      // The reflection should be there as a user message containing the
      // canonical reflection markdown.
      const reflectionMsgs = persisted.filter(
        m => m.role === 'user' && typeof m.content === 'string'
          && m.content.includes('## What was attempted'),
      );
      expect(reflectionMsgs).toHaveLength(1);

      // And the final assistant text.
      const finalAssistant = persisted.filter(
        m => m.role === 'assistant' && typeof m.content === 'string'
          && m.content.includes('all done'),
      );
      expect(finalAssistant).toHaveLength(1);
    } finally {
      rmSync(yeaftDir, { recursive: true, force: true });
    }
  });

  it('after 26-tool double-T1 collapse, disk has TWO reflections + final assistant', async () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-reflect-persist-'));
    try {
      const adapter = new ScriptedAdapter({ toolUseTurns: 26 });
      const { engine, conversationStore } = mkEngine(adapter, yeaftDir);

      for await (const _ of engine.query({
        prompt: 'do something with 26 tools',
        messages: [],
        groupId: 'g1',
      })) {
        /* drain */
      }

      const persisted = conversationStore.loadAllByGroup('g1');

      const toolMsgs = persisted.filter(m => m.role === 'tool');
      expect(toolMsgs).toHaveLength(0);

      const reflectionMsgs = persisted.filter(
        m => m.role === 'user' && typeof m.content === 'string'
          && m.content.includes('## What was attempted'),
      );
      expect(reflectionMsgs).toHaveLength(2);

      const finalAssistant = persisted.filter(
        m => m.role === 'assistant' && typeof m.content === 'string'
          && m.content.includes('all done'),
      );
      expect(finalAssistant).toHaveLength(1);
    } finally {
      rmSync(yeaftDir, { recursive: true, force: true });
    }
  });

  it('next query loadRecentByGroup sees collapsed history (no tool pairs)', async () => {
    const yeaftDir = mkdtempSync(join(tmpdir(), 'yeaft-reflect-persist-'));
    try {
      const adapter = new ScriptedAdapter({ toolUseTurns: 13 });
      const { engine, conversationStore } = mkEngine(adapter, yeaftDir);

      // Turn 1: 13 tools → collapse → persist.
      for await (const _ of engine.query({
        prompt: 'first turn',
        messages: [],
        groupId: 'g1',
      })) {
        /* drain */
      }

      // Now simulate turn 2's prep: the bridge will call loadRecentByGroup
      // to rebuild conversationMessages. The whole point of reflect-persist
      // is that THIS load returns the collapsed form, so turn 2's adapter
      // call sees the smaller history.
      const recent = conversationStore.loadRecentByGroup('g1', 100);
      const recentTools = recent.filter(m => m.role === 'tool');
      const recentReflections = recent.filter(
        m => m.role === 'user' && typeof m.content === 'string'
          && m.content.includes('## What was attempted'),
      );
      expect(recentTools).toHaveLength(0);
      expect(recentReflections).toHaveLength(1);
    } finally {
      rmSync(yeaftDir, { recursive: true, force: true });
    }
  });
});
