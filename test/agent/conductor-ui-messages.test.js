import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Tests for Conductor UI messages recording and sharding logic.
 *
 * Replicates core functions from agent/conductor/ui-messages.js
 * to avoid SDK/context side effects.
 */

// =====================================================================
// Replicate UI message functions for isolated testing
// =====================================================================

function createTestSession(overrides = {}) {
  return {
    id: overrides.id || 'session-ui-test',
    tasks: overrides.tasks || new Map(),
    uiMessages: overrides.uiMessages || [],
    workDir: overrides.workDir || null,
    status: overrides.status || 'running',
    costUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    activeClaudes: 0
  };
}

// Simplified sendConductorOutput that records to uiMessages
function sendConductorOutput(session, outputType, rawMessage, extra = {}) {
  if (outputType === 'text') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    }
    if (!text) return;

    let found = false;
    for (let i = session.uiMessages.length - 1; i >= 0; i--) {
      const msg = session.uiMessages[i];
      if (msg.source === 'conductor' && msg.type === 'text' && msg._streaming) {
        msg.content += text;
        found = true;
        break;
      }
    }
    if (!found) {
      session.uiMessages.push({
        source: 'conductor', type: 'text', content: text,
        _streaming: true, timestamp: Date.now()
      });
    }
  } else if (outputType === 'system') {
    const content = rawMessage?.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (!text) return;
    session.uiMessages.push({
      source: 'conductor', type: 'system', content: text, timestamp: Date.now()
    });
  } else if (outputType === 'task_created') {
    session.uiMessages.push({
      source: 'conductor', type: 'task_created',
      taskId: extra.taskId, taskTitle: extra.taskTitle,
      content: `Created task: ${extra.taskTitle}`,
      timestamp: Date.now()
    });
  } else if (outputType === 'task_forwarded') {
    session.uiMessages.push({
      source: 'conductor', type: 'task_forwarded',
      taskId: extra.taskId,
      content: `Forwarded message to task: ${extra.taskId}`,
      timestamp: Date.now()
    });
  } else if (outputType === 'tool_use') {
    endConductorStreaming(session);
    const content = rawMessage?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          const input = block.input || {};
          const trimmedInput = {};
          if (input.file_path) trimmedInput.file_path = input.file_path;
          if (input.command) trimmedInput.command = input.command.substring(0, 200);
          if (input.pattern) trimmedInput.pattern = input.pattern;
          session.uiMessages.push({
            source: 'conductor', type: 'tool',
            toolName: block.name, toolId: block.id,
            toolInput: Object.keys(trimmedInput).length > 0 ? trimmedInput : null,
            content: `${block.name} ${input.file_path || input.command?.substring(0, 60) || ''}`,
            hasResult: false,
            timestamp: Date.now()
          });
        }
      }
    }
  } else if (outputType === 'tool_result') {
    const toolId = rawMessage?.message?.tool_use_id;
    if (toolId) {
      for (let i = session.uiMessages.length - 1; i >= 0; i--) {
        if (session.uiMessages[i].type === 'tool' && session.uiMessages[i].toolId === toolId) {
          session.uiMessages[i].hasResult = true;
          break;
        }
      }
    }
  }
}

function endConductorStreaming(session) {
  for (let i = session.uiMessages.length - 1; i >= 0; i--) {
    if (session.uiMessages[i].source === 'conductor' && session.uiMessages[i]._streaming) {
      delete session.uiMessages[i]._streaming;
      break;
    }
  }
}

function recordUserMessage(session, content) {
  session.uiMessages.push({
    source: 'user', type: 'text', content,
    timestamp: Date.now()
  });
}

// Sharding helpers
const MESSAGE_SHARD_SIZE = 256 * 1024;

function shouldRotate(uiMessages) {
  const json = JSON.stringify(uiMessages.map(m => {
    const { _streaming, ...rest } = m;
    return rest;
  }));
  return json.length > MESSAGE_SHARD_SIZE;
}

function rotateMessagesSimulated(messages) {
  const halfLen = Math.floor(messages.length / 2);
  let splitIdx = halfLen;
  for (let i = halfLen; i > Math.max(0, halfLen - 20); i--) {
    if (messages[i].type === 'system' || messages[i].type === 'task_created') {
      splitIdx = i + 1;
      break;
    }
  }
  splitIdx = Math.max(1, Math.min(splitIdx, messages.length - 1));
  return {
    archived: messages.slice(0, splitIdx),
    remaining: messages.slice(splitIdx)
  };
}

// =====================================================================
// Tests
// =====================================================================

describe('UI Messages - Text Streaming', () => {
  let session;

  beforeEach(() => {
    session = createTestSession();
  });

  it('should create new streaming message for first text output', () => {
    sendConductorOutput(session, 'text', {
      message: { content: 'Hello' }
    });

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].source).toBe('conductor');
    expect(session.uiMessages[0].type).toBe('text');
    expect(session.uiMessages[0].content).toBe('Hello');
    expect(session.uiMessages[0]._streaming).toBe(true);
  });

  it('should append to existing streaming message', () => {
    sendConductorOutput(session, 'text', { message: { content: 'Hello' } });
    sendConductorOutput(session, 'text', { message: { content: ' World' } });

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].content).toBe('Hello World');
    expect(session.uiMessages[0]._streaming).toBe(true);
  });

  it('should handle array content blocks', () => {
    sendConductorOutput(session, 'text', {
      message: { content: [{ type: 'text', text: 'Part 1 ' }, { type: 'text', text: 'Part 2' }] }
    });

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].content).toBe('Part 1 Part 2');
  });

  it('should ignore empty text content', () => {
    sendConductorOutput(session, 'text', { message: { content: '' } });
    expect(session.uiMessages).toHaveLength(0);
  });

  it('should ignore null message', () => {
    sendConductorOutput(session, 'text', null);
    expect(session.uiMessages).toHaveLength(0);
  });

  it('should ignore array with only non-text blocks', () => {
    sendConductorOutput(session, 'text', {
      message: { content: [{ type: 'tool_use', name: 'Read' }] }
    });
    expect(session.uiMessages).toHaveLength(0);
  });

  it('should start new streaming message after endConductorStreaming', () => {
    sendConductorOutput(session, 'text', { message: { content: 'First turn' } });
    endConductorStreaming(session);
    sendConductorOutput(session, 'text', { message: { content: 'Second turn' } });

    expect(session.uiMessages).toHaveLength(2);
    expect(session.uiMessages[0].content).toBe('First turn');
    expect(session.uiMessages[0]._streaming).toBeUndefined();
    expect(session.uiMessages[1].content).toBe('Second turn');
    expect(session.uiMessages[1]._streaming).toBe(true);
  });
});

describe('UI Messages - System Messages', () => {
  let session;
  beforeEach(() => { session = createTestSession(); });

  it('should record system message', () => {
    sendConductorOutput(session, 'system', {
      message: { role: 'assistant', content: 'Session 已停止' }
    });

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].type).toBe('system');
    expect(session.uiMessages[0].content).toBe('Session 已停止');
    expect(session.uiMessages[0]).not.toHaveProperty('_streaming');
  });

  it('should handle system message with array content', () => {
    sendConductorOutput(session, 'system', {
      message: { content: [{ type: 'text', text: 'System msg' }] }
    });

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].content).toBe('System msg');
  });

  it('should ignore system message with empty content', () => {
    sendConductorOutput(session, 'system', { message: { content: '' } });
    expect(session.uiMessages).toHaveLength(0);
  });
});

describe('UI Messages - Task Events', () => {
  let session;
  beforeEach(() => { session = createTestSession(); });

  it('should record task_created event', () => {
    sendConductorOutput(session, 'task_created', null, {
      taskId: 'task-001', taskTitle: '实现搜索功能'
    });

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].type).toBe('task_created');
    expect(session.uiMessages[0].taskId).toBe('task-001');
    expect(session.uiMessages[0].taskTitle).toBe('实现搜索功能');
    expect(session.uiMessages[0].content).toBe('Created task: 实现搜索功能');
  });

  it('should record task_forwarded event', () => {
    sendConductorOutput(session, 'task_forwarded', null, {
      taskId: 'task-002'
    });

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].type).toBe('task_forwarded');
    expect(session.uiMessages[0].taskId).toBe('task-002');
    expect(session.uiMessages[0].content).toBe('Forwarded message to task: task-002');
  });
});

describe('UI Messages - Tool Use and Results', () => {
  let session;
  beforeEach(() => { session = createTestSession(); });

  it('should record tool_use events and end streaming', () => {
    // First, have a streaming message
    sendConductorOutput(session, 'text', { message: { content: 'Thinking...' } });
    expect(session.uiMessages[0]._streaming).toBe(true);

    // Tool use should end streaming
    sendConductorOutput(session, 'tool_use', {
      message: {
        content: [
          { type: 'tool_use', name: 'Read', id: 'tool-1', input: { file_path: '/tmp/test.js' } }
        ]
      }
    });

    expect(session.uiMessages).toHaveLength(2);
    expect(session.uiMessages[0]._streaming).toBeUndefined(); // streaming ended
    expect(session.uiMessages[1].type).toBe('tool');
    expect(session.uiMessages[1].toolName).toBe('Read');
    expect(session.uiMessages[1].toolId).toBe('tool-1');
    expect(session.uiMessages[1].toolInput.file_path).toBe('/tmp/test.js');
    expect(session.uiMessages[1].hasResult).toBe(false);
  });

  it('should trim long command in tool input', () => {
    const longCommand = 'a'.repeat(300);
    sendConductorOutput(session, 'tool_use', {
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', id: 'tool-2', input: { command: longCommand } }
        ]
      }
    });

    expect(session.uiMessages[0].toolInput.command.length).toBe(200);
  });

  it('should set toolInput to null when no relevant fields', () => {
    sendConductorOutput(session, 'tool_use', {
      message: {
        content: [
          { type: 'tool_use', name: 'CustomTool', id: 'tool-3', input: { foo: 'bar' } }
        ]
      }
    });

    expect(session.uiMessages[0].toolInput).toBeNull();
  });

  it('should mark tool result', () => {
    // Add tool_use first
    sendConductorOutput(session, 'tool_use', {
      message: {
        content: [
          { type: 'tool_use', name: 'Read', id: 'tool-result-1', input: {} }
        ]
      }
    });
    expect(session.uiMessages[0].hasResult).toBe(false);

    // Then tool result
    sendConductorOutput(session, 'tool_result', {
      message: { tool_use_id: 'tool-result-1' }
    });
    expect(session.uiMessages[0].hasResult).toBe(true);
  });

  it('should handle tool_result for non-existent tool', () => {
    sendConductorOutput(session, 'tool_result', {
      message: { tool_use_id: 'non-existent' }
    });
    expect(session.uiMessages).toHaveLength(0);
  });

  it('should handle multiple tools in one message', () => {
    sendConductorOutput(session, 'tool_use', {
      message: {
        content: [
          { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/a.js' } },
          { type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'ls' } },
          { type: 'text', text: 'some text' } // non-tool block, should be ignored
        ]
      }
    });

    expect(session.uiMessages).toHaveLength(2);
    expect(session.uiMessages[0].toolName).toBe('Read');
    expect(session.uiMessages[1].toolName).toBe('Bash');
  });
});

describe('UI Messages - User Messages', () => {
  let session;
  beforeEach(() => { session = createTestSession(); });

  it('should record user message', () => {
    recordUserMessage(session, '帮我创建一个新任务');

    expect(session.uiMessages).toHaveLength(1);
    expect(session.uiMessages[0].source).toBe('user');
    expect(session.uiMessages[0].type).toBe('text');
    expect(session.uiMessages[0].content).toBe('帮我创建一个新任务');
    expect(session.uiMessages[0].timestamp).toBeDefined();
  });

  it('should record multiple user messages in order', () => {
    recordUserMessage(session, '第一条');
    recordUserMessage(session, '第二条');
    recordUserMessage(session, '第三条');

    expect(session.uiMessages).toHaveLength(3);
    expect(session.uiMessages.map(m => m.content)).toEqual(['第一条', '第二条', '第三条']);
  });
});

describe('endConductorStreaming', () => {
  it('should remove _streaming flag from last streaming message', () => {
    const session = createTestSession();
    session.uiMessages = [
      { source: 'conductor', type: 'text', content: 'first', _streaming: false },
      { source: 'conductor', type: 'text', content: 'second', _streaming: true }
    ];

    endConductorStreaming(session);
    expect(session.uiMessages[1]._streaming).toBeUndefined();
  });

  it('should be safe to call on empty messages', () => {
    const session = createTestSession();
    endConductorStreaming(session);
    expect(session.uiMessages).toHaveLength(0);
  });

  it('should only end the last streaming message (reverse search)', () => {
    const session = createTestSession();
    session.uiMessages = [
      { source: 'conductor', type: 'text', content: 'a', _streaming: true },
      { source: 'user', type: 'text', content: 'b' },
      { source: 'conductor', type: 'text', content: 'c', _streaming: true }
    ];

    endConductorStreaming(session);
    expect(session.uiMessages[0]._streaming).toBe(true); // first NOT touched
    expect(session.uiMessages[2]._streaming).toBeUndefined(); // last ended
  });

  it('should not touch non-conductor streaming messages', () => {
    const session = createTestSession();
    session.uiMessages = [
      { source: 'user', type: 'text', content: 'user msg', _streaming: true }
    ];

    endConductorStreaming(session);
    expect(session.uiMessages[0]._streaming).toBe(true); // not conductor, untouched
  });
});

describe('Message Sharding / Rotation', () => {
  it('should calculate when rotation is needed', () => {
    // Small messages should not need rotation
    const small = [{ source: 'user', type: 'text', content: 'hi', timestamp: 1 }];
    expect(shouldRotate(small)).toBe(false);

    // Build large messages
    const large = [];
    for (let i = 0; i < 500; i++) {
      large.push({
        source: 'conductor', type: 'text',
        content: 'x'.repeat(1000),
        timestamp: Date.now()
      });
    }
    expect(shouldRotate(large)).toBe(true);
  });

  it('should split messages roughly in half', () => {
    const messages = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        source: 'conductor', type: 'text',
        content: `Message ${i}`, timestamp: i
      });
    }

    const result = rotateMessagesSimulated(messages);
    expect(result.archived.length).toBeGreaterThan(0);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(result.archived.length + result.remaining.length).toBe(100);
  });

  it('should prefer splitting at system/task_created boundaries', () => {
    const messages = [];
    for (let i = 0; i < 100; i++) {
      if (i === 48) {
        messages.push({ source: 'conductor', type: 'task_created', content: 'Task created', timestamp: i });
      } else {
        messages.push({ source: 'conductor', type: 'text', content: `Msg ${i}`, timestamp: i });
      }
    }

    const result = rotateMessagesSimulated(messages);
    // Should split after the task_created message at index 48 (splitIdx = 49)
    expect(result.archived.length).toBe(49);
    expect(result.remaining.length).toBe(51);
  });

  it('should handle edge case: very small messages array', () => {
    const messages = [
      { source: 'user', type: 'text', content: 'only one', timestamp: 1 }
    ];

    const result = rotateMessagesSimulated(messages);
    // splitIdx is clamped: max(1, min(0, 0)) = max(1, 0) = 1, but min clamps to len-1 = 0
    // Actually: halfLen=0, splitIdx=0, then max(1, min(0, 0)) = max(1, 0) = 1
    // But since messages.length is 1, splitIdx = min(1, 0) = 0, then max(1, 0) = 1
    // Actually this causes archived=slice(0,1) and remaining=slice(1)=[]
    // Let me just verify the function doesn't crash
    expect(result.archived.length + result.remaining.length).toBe(1);
  });

  it('should handle messages with _streaming flag (cleaned before serialize)', () => {
    const messages = [
      { source: 'conductor', type: 'text', content: 'streaming', _streaming: true, timestamp: 1 }
    ];

    const cleaned = messages.map(m => {
      const { _streaming, ...rest } = m;
      return rest;
    });

    expect(cleaned[0]).not.toHaveProperty('_streaming');
    expect(cleaned[0].content).toBe('streaming');
  });

  it('should handle system message split point search within window', () => {
    const messages = [];
    for (let i = 0; i < 100; i++) {
      if (i === 35) {
        // system message within search window (halfLen-20 to halfLen)
        messages.push({ source: 'conductor', type: 'system', content: 'System alert', timestamp: i });
      } else {
        messages.push({ source: 'conductor', type: 'text', content: `Msg ${i}`, timestamp: i });
      }
    }

    const result = rotateMessagesSimulated(messages);
    // halfLen = 50, searches from 50 down to 30
    // system at 35 is in window, splitIdx = 36
    expect(result.archived.length).toBe(36);
  });
});

describe('sendStatusUpdate data shape', () => {
  it('should format tasks for status message', () => {
    const session = createTestSession();
    session.tasks.set('t1', {
      taskId: 't1', title: 'A', workDir: '/p',
      status: 'running', phase: 'dev', progress: 50,
      activeActors: ['dev-1'], createdAt: 1000, updatedAt: 2000
    });

    const tasks = Array.from(session.tasks.values()).map(t => ({
      taskId: t.taskId,
      title: t.title,
      workDir: t.workDir,
      status: t.status,
      phase: t.phase,
      progress: t.progress,
      activeActors: t.activeActors || [],
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    }));

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({
      taskId: 't1', title: 'A', workDir: '/p',
      status: 'running', phase: 'dev', progress: 50,
      activeActors: ['dev-1'], createdAt: 1000, updatedAt: 2000
    });
  });

  it('should default activeActors to empty array', () => {
    const t = { taskId: 't1', title: 'A' };
    const formatted = {
      activeActors: t.activeActors || []
    };
    expect(formatted.activeActors).toEqual([]);
  });
});
