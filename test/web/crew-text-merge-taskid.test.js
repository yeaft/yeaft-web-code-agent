import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Tests for PR #321: crew text merge taskId fix.
 *
 * P0: text streaming merge in crew.js must check taskId — same role working on
 *     different tasks should NOT merge text across tasks.
 * P2: abort path in role-output.js must fill pendingRoutes with taskId.
 */

// =====================================================================
// Helper: simulate the text merge logic from crew.js handleCrewOutput
// This mirrors the exact logic at lines 400-451 of crew.js
// =====================================================================

function simulateTextMerge(messages, msg) {
  const msgTaskId = msg.taskId || null;

  // First search: find _streaming message with same role + taskId
  let streamMsg = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === msg.role && messages[i].type === 'text' && messages[i]._streaming
        && (messages[i].taskId || null) === msgTaskId) {
      streamMsg = messages[i];
      break;
    }
  }

  // Fallback search: find same-role text after only tool messages, with same taskId
  if (!streamMsg) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== msg.role) break;
      if (m.type === 'text' && (m.taskId || null) === msgTaskId) { streamMsg = m; break; }
      if (m.type === 'text') break; // same role text but different taskId → stop
      if (m.type !== 'tool') break;
    }
    if (streamMsg) streamMsg._streaming = true;
  }

  if (streamMsg) {
    // Append to existing message
    streamMsg.content += msg.text;
    return 'merged';
  }

  // Create new message
  messages.push({
    id: `msg_${Date.now()}_${Math.random()}`,
    role: msg.role,
    type: 'text',
    taskId: msg.taskId || null,
    content: msg.text,
    _streaming: true
  });
  return 'created';
}

// =====================================================================
// Helper: simulate abort pendingRoutes fill from role-output.js
// =====================================================================

function simulateAbortRoutes(roleState, session, roleName, routes) {
  if (session.status === 'paused' && roleState.accumulatedText) {
    if (routes.length > 0 && session.pendingRoutes.length === 0) {
      const currentTask = roleState.currentTask;
      for (const route of routes) {
        if (!route.taskId && currentTask) {
          route.taskId = currentTask.taskId;
          route.taskTitle = currentTask.taskTitle;
        }
      }
      session.pendingRoutes = routes.map(route => ({ fromRole: roleName, route }));
    }
  }
}

// =====================================================================
// 1. Cross-task text merge prevention (P0 fix)
// =====================================================================

describe('cross-task text merge prevention', () => {
  it('should NOT merge text from task-B into task-A message (same role)', () => {
    const messages = [];

    // Role dev-1 outputs text for task-A
    simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-A', text: 'Working on task A...' });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Working on task A...');
    expect(messages[0].taskId).toBe('task-A');

    // Same role dev-1 now outputs text for task-B (different task)
    const result = simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-B', text: 'Starting task B...' });
    expect(result).toBe('created'); // Must create new message, NOT merge
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Working on task A...');
    expect(messages[1].content).toBe('Starting task B...');
    expect(messages[1].taskId).toBe('task-B');
  });

  it('should NOT merge text when taskId changes from a value to null', () => {
    const messages = [];

    simulateTextMerge(messages, { role: 'pm', taskId: 'task-1', text: 'Task 1 message' });
    const result = simulateTextMerge(messages, { role: 'pm', taskId: null, text: 'Global message' });

    expect(result).toBe('created');
    expect(messages).toHaveLength(2);
    expect(messages[0].taskId).toBe('task-1');
    expect(messages[1].taskId).toBeNull();
  });

  it('should NOT merge text when taskId changes from null to a value', () => {
    const messages = [];

    simulateTextMerge(messages, { role: 'dev-1', taskId: null, text: 'Global chat' });
    const result = simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-X', text: 'Task X work' });

    expect(result).toBe('created');
    expect(messages).toHaveLength(2);
  });
});

// =====================================================================
// 2. Same-task text merge still works (streaming behavior)
// =====================================================================

describe('same-task text merge (streaming)', () => {
  it('should merge consecutive text chunks for same role + same taskId', () => {
    const messages = [];

    simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-1', text: 'Hello ' });
    simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-1', text: 'World ' });
    simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-1', text: '!' });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello World !');
    expect(messages[0]._streaming).toBe(true);
  });

  it('should merge many stream chunks without creating extra messages', () => {
    const messages = [];
    const chunks = ['The ', 'quick ', 'brown ', 'fox ', 'jumps ', 'over ', 'the ', 'lazy ', 'dog.'];

    for (const chunk of chunks) {
      simulateTextMerge(messages, { role: 'rev-1', taskId: 'task-42', text: chunk });
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('The quick brown fox jumps over the lazy dog.');
  });

  it('should keep streaming flag true during merge', () => {
    const messages = [];

    simulateTextMerge(messages, { role: 'dev-2', taskId: 'task-5', text: 'Part 1 ' });
    expect(messages[0]._streaming).toBe(true);

    simulateTextMerge(messages, { role: 'dev-2', taskId: 'task-5', text: 'Part 2' });
    expect(messages[0]._streaming).toBe(true);
    expect(messages).toHaveLength(1);
  });
});

// =====================================================================
// 3. Fallback search: after tool_use, same task text should re-append
// =====================================================================

describe('fallback search: text after tool_use in same task', () => {
  it('should re-append text after tool messages for same role + same taskId', () => {
    const messages = [
      { role: 'dev-1', type: 'text', taskId: 'task-1', content: 'Before tool ', _streaming: false },
      { role: 'dev-1', type: 'tool', taskId: 'task-1', content: '' },
    ];

    const result = simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-1', text: 'After tool' });

    expect(result).toBe('merged');
    expect(messages[0].content).toBe('Before tool After tool');
    expect(messages[0]._streaming).toBe(true); // re-activated
  });

  it('should NOT fallback-merge across taskIds even with tool in between', () => {
    const messages = [
      { role: 'dev-1', type: 'text', taskId: 'task-A', content: 'Task A text ', _streaming: false },
      { role: 'dev-1', type: 'tool', taskId: 'task-A', content: '' },
    ];

    // New text arrives for task-B
    const result = simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-B', text: 'Task B text' });

    expect(result).toBe('created');
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('Task A text '); // unchanged
    expect(messages[2].taskId).toBe('task-B');
  });

  it('should stop fallback search when encountering different role', () => {
    const messages = [
      { role: 'dev-1', type: 'text', taskId: 'task-1', content: 'Dev text', _streaming: false },
      { role: 'rev-1', type: 'text', taskId: 'task-1', content: 'Reviewer text', _streaming: false },
    ];

    // dev-1 sends more text — should NOT merge because rev-1 is in between
    const result = simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-1', text: ' more' });

    expect(result).toBe('created');
    expect(messages).toHaveLength(3);
  });

  it('should stop fallback search when encountering same role text with different taskId', () => {
    const messages = [
      { role: 'dev-1', type: 'text', taskId: 'task-A', content: 'Task A', _streaming: false },
    ];

    // dev-1 sends text for task-B — the fallback loop finds task-A text, hits the
    // "same role text but different taskId → break" guard
    const result = simulateTextMerge(messages, { role: 'dev-1', taskId: 'task-B', text: 'Task B' });

    expect(result).toBe('created');
    expect(messages).toHaveLength(2);
  });
});

// =====================================================================
// 4. null taskId messages still merge correctly
// =====================================================================

describe('null taskId global messages', () => {
  it('should merge consecutive null-taskId text from same role', () => {
    const messages = [];

    simulateTextMerge(messages, { role: 'pm', taskId: null, text: 'Global ' });
    simulateTextMerge(messages, { role: 'pm', taskId: null, text: 'message.' });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Global message.');
    expect(messages[0].taskId).toBeNull();
  });

  it('should merge undefined taskId with null taskId (both normalize to null)', () => {
    const messages = [];

    simulateTextMerge(messages, { role: 'pm', text: 'First ' }); // undefined taskId
    simulateTextMerge(messages, { role: 'pm', taskId: null, text: 'Second' });

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('First Second');
  });

  it('should NOT merge null-taskId messages from different roles', () => {
    const messages = [];

    simulateTextMerge(messages, { role: 'pm', taskId: null, text: 'PM says' });
    simulateTextMerge(messages, { role: 'dev-1', taskId: null, text: 'Dev says' });

    expect(messages).toHaveLength(2);
  });
});

// =====================================================================
// 5. Abort pendingRoutes taskId fill (P2 fix)
// =====================================================================

describe('abort pendingRoutes taskId fill', () => {
  it('should fill taskId from currentTask when route has no taskId', () => {
    const roleState = {
      accumulatedText: '---ROUTE---\nto: pm\nsummary: done\n---END_ROUTE---',
      currentTask: { taskId: 'task-99', taskTitle: 'Fix the bug' }
    };
    const session = { status: 'paused', pendingRoutes: [] };
    const routes = [{ to: 'pm', summary: 'done' }]; // no taskId

    simulateAbortRoutes(roleState, session, 'dev-1', routes);

    expect(session.pendingRoutes).toHaveLength(1);
    expect(session.pendingRoutes[0].route.taskId).toBe('task-99');
    expect(session.pendingRoutes[0].route.taskTitle).toBe('Fix the bug');
    expect(session.pendingRoutes[0].fromRole).toBe('dev-1');
  });

  it('should NOT overwrite taskId if route already has one', () => {
    const roleState = {
      accumulatedText: 'some text with route',
      currentTask: { taskId: 'task-99', taskTitle: 'Fix the bug' }
    };
    const session = { status: 'paused', pendingRoutes: [] };
    const routes = [{ to: 'pm', summary: 'done', taskId: 'task-explicit', taskTitle: 'Explicit title' }];

    simulateAbortRoutes(roleState, session, 'dev-1', routes);

    expect(session.pendingRoutes[0].route.taskId).toBe('task-explicit');
    expect(session.pendingRoutes[0].route.taskTitle).toBe('Explicit title');
  });

  it('should handle multiple routes — fill taskId on each that lacks it', () => {
    const roleState = {
      accumulatedText: 'text',
      currentTask: { taskId: 'task-50', taskTitle: 'Multi route' }
    };
    const session = { status: 'paused', pendingRoutes: [] };
    const routes = [
      { to: 'pm', summary: 'route1' },
      { to: 'dev-2', summary: 'route2', taskId: 'task-other' },
      { to: 'test-1', summary: 'route3' }
    ];

    simulateAbortRoutes(roleState, session, 'rev-1', routes);

    expect(session.pendingRoutes).toHaveLength(3);
    expect(session.pendingRoutes[0].route.taskId).toBe('task-50'); // filled
    expect(session.pendingRoutes[1].route.taskId).toBe('task-other'); // kept
    expect(session.pendingRoutes[2].route.taskId).toBe('task-50'); // filled
  });

  it('should not fill taskId when currentTask is null', () => {
    const roleState = {
      accumulatedText: 'text',
      currentTask: null
    };
    const session = { status: 'paused', pendingRoutes: [] };
    const routes = [{ to: 'pm', summary: 'done' }];

    simulateAbortRoutes(roleState, session, 'dev-1', routes);

    expect(session.pendingRoutes[0].route.taskId).toBeUndefined();
  });

  it('should not overwrite pendingRoutes if already populated', () => {
    const roleState = { accumulatedText: 'text', currentTask: { taskId: 'task-1' } };
    const session = {
      status: 'paused',
      pendingRoutes: [{ fromRole: 'existing', route: { to: 'pm' } }]
    };
    const routes = [{ to: 'dev-2', summary: 'new' }];

    simulateAbortRoutes(roleState, session, 'dev-1', routes);

    // Should NOT overwrite — existing pendingRoutes preserved
    expect(session.pendingRoutes).toHaveLength(1);
    expect(session.pendingRoutes[0].fromRole).toBe('existing');
  });
});

// =====================================================================
// 6. Source code verification: taskId checks present in crew.js
// =====================================================================

describe('source code verification', () => {
  let crewSource;
  let roleOutputSource;

  beforeAll(() => {
    crewSource = readFileSync(
      resolve(__dirname, '../../web/stores/helpers/crew.js'), 'utf-8'
    );
    roleOutputSource = readFileSync(
      resolve(__dirname, '../../agent/crew/role-output.js'), 'utf-8'
    );
  });

  it('first search (_streaming) should include taskId matching', () => {
    // The _streaming search must contain taskId comparison
    const streamingSearch = crewSource.match(/messages\[i\]\.role === msg\.role.*_streaming[\s\S]*?break;/);
    expect(streamingSearch).toBeTruthy();
    expect(streamingSearch[0]).toContain('taskId');
  });

  it('fallback search should include taskId matching', () => {
    // The fallback search should check taskId
    const fallbackBlock = crewSource.substring(
      crewSource.indexOf('查找同角色最后一条 text'),
      crewSource.indexOf('if (streamMsg) streamMsg._streaming = true')
    );
    expect(fallbackBlock).toContain('taskId');
    expect(fallbackBlock).toContain('msgTaskId');
  });

  it('fallback search should break on same-role text with different taskId', () => {
    // The guard: if (m.type === 'text') break;
    // after the taskId-matched text check
    const textSection = crewSource.substring(
      crewSource.indexOf("if (msg.outputType === 'text')"),
      crewSource.indexOf("if (msg.outputType === 'tool_use')")
    );
    // Should have a line that breaks on text with mismatched taskId
    expect(textSection).toContain("if (m.type === 'text') break");
  });

  it('abort path in role-output.js should fill taskId from currentTask', () => {
    // Find the abort handler
    const abortBlock = roleOutputSource.substring(
      roleOutputSource.indexOf("error.name === 'AbortError'"),
      roleOutputSource.indexOf('roleState.accumulatedText = \'\'')
    );
    expect(abortBlock).toContain('currentTask');
    expect(abortBlock).toContain('route.taskId');
    expect(abortBlock).toContain('route.taskTitle');
  });
});
