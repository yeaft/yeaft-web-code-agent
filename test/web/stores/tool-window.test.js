import { describe, it, expect } from 'vitest';

globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.Pinia = globalThis.Pinia || {};
globalThis.Pinia.defineStore = (_id, options) => () => ({
  ...(options.state ? options.state() : {}),
  ...(options.actions || {}),
});
globalThis.window = globalThis.window || globalThis;
globalThis.window.Pinia = globalThis.Pinia;

const {
  DEFAULT_LIVE_TOOL_WINDOW,
  summarizeHistoricalToolMessages,
} = await import('../../../web/stores/helpers/tool-window.js');
const { handleConversationResumed } = await import('../../../web/stores/helpers/handlers/conversationHandler.js');
const { useChatStore } = await import('../../../web/stores/chat.js');

function toolMsg(i, extra = {}) {
  return {
    type: 'tool-use',
    toolName: 'Bash',
    toolInput: { command: `echo ${i}` },
    isHistory: true,
    timestamp: i,
    ...extra,
  };
}

function dbTool(i, extra = {}) {
  return {
    id: i + 1,
    message_type: 'tool_use',
    tool_name: 'Bash',
    tool_input: JSON.stringify({ command: `echo ${i}` }),
    created_at: i + 1,
    ...extra,
  };
}

function dbEmptyUser(i) {
  return {
    id: i + 1,
    role: 'user',
    message_type: 'message',
    content: '',
    created_at: i + 1,
  };
}

describe('tool action windowing', () => {
  it('summarizes huge historical tool runs instead of keeping every tool row', () => {
    const messages = Array.from({ length: 5000 }, (_, i) => toolMsg(i, { turnId: 'turn-big' }));
    const summarized = summarizeHistoricalToolMessages(messages);

    expect(summarized).toHaveLength(1);
    expect(summarized[0]).toMatchObject({
      type: 'tool-summary',
      count: 5000,
      omittedCount: 5000,
      source: 'history',
      turnId: 'turn-big',
    });
  });

  it('compresses chat resume dbMessages before they enter messagesMap', () => {
    const store = useChatStore();
    store.agents = [{ id: 'agent-1', name: 'Agent One' }];
    store.sendWsMessage = () => {};

    handleConversationResumed(store, {
      conversationId: 'conv-big-chat',
      agentId: 'agent-1',
      workDir: '/tmp/project',
      claudeSessionId: 'claude-session',
      dbMessages: Array.from({ length: 5000 }, (_, i) => dbTool(i)),
      hasMoreMessages: false,
    });

    const rows = store.messagesMap['conv-big-chat'];
    expect(rows.filter((m) => m.type === 'tool-use')).toHaveLength(0);
    expect(rows.filter((m) => m.type === 'tool-summary')).toHaveLength(1);
    const summary = rows.find((m) => m.type === 'tool-summary');
    expect(summary?.count).toBe(5000);
    expect(summary?.dbMessageId).toBe(5000);
  });

  it('compresses chat resume tools across interleaved empty user artifacts', () => {
    const store = useChatStore();
    store.agents = [{ id: 'agent-1', name: 'Agent One' }];
    store.sendWsMessage = () => {};
    const dbMessages = [];
    for (let i = 0; i < 5000; i += 1) {
      dbMessages.push(dbTool(i, { id: i * 2 + 1, created_at: i * 2 + 1 }));
      dbMessages.push(dbEmptyUser(i * 2 + 1));
    }

    handleConversationResumed(store, {
      conversationId: 'conv-interleaved-chat',
      agentId: 'agent-1',
      workDir: '/tmp/project',
      claudeSessionId: 'claude-session',
      dbMessages,
      hasMoreMessages: false,
    });

    const rows = store.messagesMap['conv-interleaved-chat'];
    const summaries = rows.filter((m) => m.type === 'tool-summary');
    expect(rows.filter((m) => m.type === 'tool-use')).toHaveLength(0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ count: 5000, dbMessageId: 9999 });
  });

  it('does not parse ordinary historical tool inputs before summarizing but keeps special tools detailed', () => {
    const store = useChatStore();
    store.agents = [{ id: 'agent-1', name: 'Agent One' }];
    store.sendWsMessage = () => {};
    const originalParse = JSON.parse;
    let ordinaryParses = 0;
    let specialParses = 0;
    JSON.parse = (value, ...args) => {
      if (typeof value === 'string' && value.startsWith('{"marker":"ordinary"')) ordinaryParses += 1;
      if (typeof value === 'string' && value.startsWith('{"todos"')) specialParses += 1;
      return originalParse(value, ...args);
    };

    try {
      handleConversationResumed(store, {
        conversationId: 'conv-unparsed-chat',
        agentId: 'agent-1',
        workDir: '/tmp/project',
        claudeSessionId: 'claude-session',
        dbMessages: Array.from({ length: 5000 }, (_, i) => dbTool(i, {
          tool_input: `{"marker":"ordinary","payload":"${'x'.repeat(1024)}"}`,
        })),
        hasMoreMessages: false,
      });
      const special = store.formatDbMessageForHistoryHydration(dbTool(9000, {
        tool_name: 'TodoWrite',
        tool_input: '{"todos":[]}',
      }));

      expect(ordinaryParses).toBe(0);
      expect(specialParses).toBe(1);
      expect(special.toolInput).toEqual({ todos: [] });
      expect(store.messagesMap['conv-unparsed-chat'].filter((m) => m.type === 'tool-summary')).toHaveLength(1);
    } finally {
      JSON.parse = originalParse;
    }
  });

  it('hydrates Yeaft recovered tool summaries without tool detail rows', () => {
    const store = useChatStore();
    store.yeaftConversationId = 'yeaft-conv';
    store.currentView = 'yeaft';

    store.handleYeaftOutput({
      conversationId: 'yeaft-conv',
      sessionId: 'session-1',
      turnId: 'turn-recovered',
      vpId: 'vp-1',
      data: {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_summary', count: 5000, omittedCount: 5000, source: 'history' }],
        },
      },
    });

    const rows = store.messagesMap['yeaft-conv'];
    expect(rows.filter((m) => m.type === 'tool-use')).toHaveLength(0);
    expect(rows.find((m) => m.type === 'tool-summary')).toMatchObject({
      count: 5000,
      sessionId: 'session-1',
      turnId: 'turn-recovered',
      vpId: 'vp-1',
    });
  });

  it('windows live Yeaft tools per turn and VP instead of mixing speakers', () => {
    const store = useChatStore();
    store.yeaftConversationId = 'yeaft-conv';
    store._currentYeaftSessionId = 'session-1';

    for (const vpId of ['vp-a', 'vp-b']) {
      store._currentYeaftVpId = vpId;
      store._currentYeaftTurnId = `turn-${vpId}`;
      for (let i = 0; i < DEFAULT_LIVE_TOOL_WINDOW + 5; i += 1) {
        store.addMessageToConversation('yeaft-conv', {
          type: 'tool-use',
          toolName: 'Bash',
          toolInput: { command: `${vpId}-${i}` },
        });
      }
    }

    const rows = store.messagesMap['yeaft-conv'];
    const summaries = rows.filter((m) => m.type === 'tool-summary');
    expect(summaries).toHaveLength(2);
    expect(summaries.map((m) => [m.vpId, m.turnId, m.count]).sort()).toEqual([
      ['vp-a', 'turn-vp-a', 5],
      ['vp-b', 'turn-vp-b', 5],
    ]);
    expect(rows.filter((m) => m.type === 'tool-use' && m.vpId === 'vp-a')).toHaveLength(DEFAULT_LIVE_TOOL_WINDOW);
    expect(rows.filter((m) => m.type === 'tool-use' && m.vpId === 'vp-b')).toHaveLength(DEFAULT_LIVE_TOOL_WINDOW);
  });

  it('keeps only a recent live tool window while preserving new appends for Yeaft', () => {
    const store = useChatStore();
    store.yeaftConversationId = 'yeaft-conv';
    store._currentYeaftSessionId = 'session-1';
    store._currentYeaftTurnId = 'turn-live';
    store._currentYeaftVpId = 'vp-1';

    for (let i = 0; i < DEFAULT_LIVE_TOOL_WINDOW + 25; i += 1) {
      store.addMessageToConversation('yeaft-conv', {
        type: 'tool-use',
        toolName: 'Bash',
        toolInput: { command: `echo ${i}` },
      });
    }

    const rows = store.messagesMap['yeaft-conv'];
    const summary = rows.find((m) => m.type === 'tool-summary');
    const liveTools = rows.filter((m) => m.type === 'tool-use');

    expect(summary?.count).toBe(25);
    expect(liveTools).toHaveLength(DEFAULT_LIVE_TOOL_WINDOW);
    expect(liveTools.at(-1)?.toolInput).toEqual({ command: `echo ${DEFAULT_LIVE_TOOL_WINDOW + 24}` });
  });
});
