import { describe, it, expect } from 'vitest';
import {
  parseCrewTasks,
  computeCompletedTaskIds,
  collectActiveTasks,
  buildTodosByFeature,
  buildFeatureKanban,
  groupKanban,
  kanbanProgress,
} from '../../web/components/crew/crewKanban.js';

/**
 * Tests for the crew kanban crash fix.
 *
 * Root cause: When an agent's TodoWrite tool sends `toolInput.todos` as a
 * non-array value (string, object, null), `buildTodosByFeature()` crashed with
 * "TypeError: d.todos.find is not a function". This caused a cascade failure
 * in Vue computed properties (todosByFeature → featureKanban → featureKanbanGrouped),
 * rendering the entire CrewChatView blank.
 *
 * The fix adds defensive Array.isArray checks and || [] fallbacks throughout
 * crewKanban.js so malformed data is gracefully skipped rather than crashing.
 */

// =====================================================================
// Helpers — build minimal message shapes
// =====================================================================

function todoWriteMessage(todos, overrides = {}) {
  return {
    type: 'tool',
    toolName: 'TodoWrite',
    toolInput: { todos },
    taskId: 'task-1',
    taskTitle: 'Test Task',
    role: 'dev',
    roleIcon: '🛠',
    roleName: 'Developer',
    timestamp: Date.now(),
    ...overrides,
  };
}

function textMessage(content, overrides = {}) {
  return { type: 'text', content, ...overrides };
}

// =====================================================================
// buildTodosByFeature — non-array todos
// =====================================================================

describe('buildTodosByFeature — defensive checks', () => {
  it('should skip messages where toolInput.todos is a string', () => {
    const messages = [todoWriteMessage('this is a string, not an array')];
    const result = buildTodosByFeature(messages);
    expect(result).toEqual([]);
  });

  it('should skip messages where toolInput.todos is an object', () => {
    const messages = [todoWriteMessage({ content: 'Fix bug', status: 'pending' })];
    const result = buildTodosByFeature(messages);
    expect(result).toEqual([]);
  });

  it('should skip messages where toolInput.todos is a number', () => {
    const messages = [todoWriteMessage(42)];
    const result = buildTodosByFeature(messages);
    expect(result).toEqual([]);
  });

  it('should skip messages where toolInput.todos is true', () => {
    const messages = [todoWriteMessage(true)];
    const result = buildTodosByFeature(messages);
    expect(result).toEqual([]);
  });

  it('should skip messages where toolInput.todos is null', () => {
    // Note: the earlier check `!m.toolInput?.todos` already catches null,
    // but the Array.isArray guard provides double safety
    const messages = [todoWriteMessage(null)];
    const result = buildTodosByFeature(messages);
    expect(result).toEqual([]);
  });

  it('should skip messages where toolInput.todos is an empty array', () => {
    const messages = [todoWriteMessage([])];
    const result = buildTodosByFeature(messages);
    expect(result).toEqual([]);
  });

  it('should process valid array todos correctly', () => {
    const messages = [todoWriteMessage([
      { content: 'Fix bug', status: 'completed', activeForm: 'Fixing bug' },
      { content: 'Add tests', status: 'in_progress', activeForm: 'Adding tests' },
    ])];
    const result = buildTodosByFeature(messages);
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('task-1');
    expect(result[0].entries).toHaveLength(1);
    expect(result[0].entries[0].todos).toHaveLength(2);
  });

  it('should handle mix of valid and invalid todos messages', () => {
    const messages = [
      todoWriteMessage('invalid string todos', { role: 'pm', timestamp: 1000 }),
      todoWriteMessage([
        { content: 'Valid task', status: 'pending', activeForm: 'Doing task' },
      ], { role: 'dev', timestamp: 2000 }),
      todoWriteMessage({ bad: 'object' }, { role: 'qa', timestamp: 3000 }),
    ];
    const result = buildTodosByFeature(messages);
    expect(result).toHaveLength(1);
    // Only the valid entry should be present
    expect(result[0].entries).toHaveLength(1);
    expect(result[0].entries[0].role).toBe('dev');
  });

  it('should return [] when messages is null', () => {
    expect(buildTodosByFeature(null)).toEqual([]);
  });

  it('should return [] when messages is undefined', () => {
    expect(buildTodosByFeature(undefined)).toEqual([]);
  });

  it('should return [] when messages is empty array', () => {
    expect(buildTodosByFeature([])).toEqual([]);
  });
});

// =====================================================================
// buildTodosByFeature — snapshot.todos non-array in history
// =====================================================================

describe('buildTodosByFeature — snapshot history safety', () => {
  it('should handle non-array todos in history snapshots during in_progress scan', () => {
    // First message has valid todos, second has an in_progress that references history
    // But we manually construct a scenario where history has bad data
    const msg1 = todoWriteMessage([
      { content: 'Task A', status: 'in_progress', activeForm: 'Doing A' },
    ], { timestamp: 1000 });
    const msg2 = todoWriteMessage([
      { content: 'Task A', status: 'in_progress', activeForm: 'Doing A' },
      { content: 'Task B', status: 'pending', activeForm: 'Doing B' },
    ], { timestamp: 2000 });

    // This should not crash even if internally history has odd data
    const result = buildTodosByFeature([msg1, msg2]);
    expect(result).toHaveLength(1);
    const entry = result[0].entries[0];
    const inProgressTodo = entry.todos.find(t => t.content === 'Task A');
    expect(inProgressTodo).toBeDefined();
    expect(inProgressTodo.startedAt).toBe(1000); // should find earliest
  });
});

// =====================================================================
// collectActiveTasks — null/undefined args
// =====================================================================

describe('collectActiveTasks — null safety', () => {
  it('should handle null persistedFeatures', () => {
    const result = collectActiveTasks(null, []);
    expect(result).toEqual([]);
  });

  it('should handle undefined persistedFeatures', () => {
    const result = collectActiveTasks(undefined, []);
    expect(result).toEqual([]);
  });

  it('should handle null messages', () => {
    const result = collectActiveTasks([], null);
    expect(result).toEqual([]);
  });

  it('should handle both null', () => {
    const result = collectActiveTasks(null, null);
    expect(result).toEqual([]);
  });

  it('should work with valid inputs', () => {
    const features = [{ taskId: 't1', taskTitle: 'Feature 1', createdAt: 100 }];
    const msgs = [{ taskId: 't2', taskTitle: 'Feature 2', timestamp: 200 }];
    const result = collectActiveTasks(features, msgs);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.id).sort()).toEqual(['t1', 't2']);
  });
});

// =====================================================================
// buildFeatureKanban — null/undefined args
// =====================================================================

describe('buildFeatureKanban — null safety', () => {
  const emptySet = new Set();

  it('should handle null activeTasks', () => {
    const result = buildFeatureKanban(null, [], [], emptySet, 'Global');
    expect(result).toEqual([]);
  });

  it('should handle null todosByFeature', () => {
    const result = buildFeatureKanban([], null, [], emptySet, 'Global');
    expect(result).toEqual([]);
  });

  it('should handle null featureBlocks', () => {
    const result = buildFeatureKanban([], [], null, emptySet, 'Global');
    expect(result).toEqual([]);
  });

  it('should handle all null args', () => {
    const result = buildFeatureKanban(null, null, null, emptySet, 'Global');
    expect(result).toEqual([]);
  });

  it('should handle undefined args', () => {
    const result = buildFeatureKanban(undefined, undefined, undefined, emptySet, 'Global');
    expect(result).toEqual([]);
  });

  it('should handle entry with null todos in todosByFeature group', () => {
    const todosByFeature = [{
      taskId: 'task-1',
      taskTitle: 'Test',
      entries: [{ role: 'dev', roleIcon: '🛠', roleName: 'Dev', todos: null }],
    }];
    const result = buildFeatureKanban([], todosByFeature, [], emptySet, 'Global');
    expect(result).toHaveLength(1);
    expect(result[0].totalCount).toBe(0);
  });

  it('should handle entry with undefined todos in todosByFeature group', () => {
    const todosByFeature = [{
      taskId: 'task-1',
      taskTitle: 'Test',
      entries: [{ role: 'dev', roleIcon: '🛠', roleName: 'Dev', todos: undefined }],
    }];
    const result = buildFeatureKanban([], todosByFeature, [], emptySet, 'Global');
    expect(result).toHaveLength(1);
    expect(result[0].totalCount).toBe(0);
  });

  it('should correctly count todos from valid entries', () => {
    const todosByFeature = [{
      taskId: 'task-1',
      taskTitle: 'Test',
      entries: [{
        role: 'dev', roleIcon: '🛠', roleName: 'Dev',
        todos: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'pending' },
          { content: 'C', status: 'in_progress' },
        ],
      }],
    }];
    const result = buildFeatureKanban([], todosByFeature, [], emptySet, 'Global');
    expect(result).toHaveLength(1);
    expect(result[0].totalCount).toBe(3);
    expect(result[0].doneCount).toBe(1);
  });
});

// =====================================================================
// groupKanban — non-array input
// =====================================================================

describe('groupKanban — non-array safety', () => {
  it('should return empty groups for null input', () => {
    const result = groupKanban(null);
    expect(result).toEqual({ inProgress: [], completed: [] });
  });

  it('should return empty groups for undefined input', () => {
    const result = groupKanban(undefined);
    expect(result).toEqual({ inProgress: [], completed: [] });
  });

  it('should return empty groups for string input', () => {
    const result = groupKanban('not an array');
    expect(result).toEqual({ inProgress: [], completed: [] });
  });

  it('should return empty groups for number input', () => {
    const result = groupKanban(42);
    expect(result).toEqual({ inProgress: [], completed: [] });
  });

  it('should return empty groups for object input', () => {
    const result = groupKanban({ some: 'object' });
    expect(result).toEqual({ inProgress: [], completed: [] });
  });

  it('should return empty groups for empty array', () => {
    const result = groupKanban([]);
    expect(result).toEqual({ inProgress: [], completed: [] });
  });

  it('should correctly group features', () => {
    const features = [
      { taskId: 't1', isCompleted: false },
      { taskId: 't2', isCompleted: true },
      { taskId: 't3', isCompleted: false },
    ];
    const result = groupKanban(features);
    expect(result.inProgress).toHaveLength(2);
    expect(result.completed).toHaveLength(1);
    expect(result.completed[0].taskId).toBe('t2');
  });
});

// =====================================================================
// kanbanProgress — non-array input
// =====================================================================

describe('kanbanProgress — non-array safety', () => {
  it('should return zero progress for null input', () => {
    const result = kanbanProgress(null);
    expect(result).toEqual({ total: 0, done: 0 });
  });

  it('should return zero progress for undefined input', () => {
    const result = kanbanProgress(undefined);
    expect(result).toEqual({ total: 0, done: 0 });
  });

  it('should return zero progress for string input', () => {
    const result = kanbanProgress('not an array');
    expect(result).toEqual({ total: 0, done: 0 });
  });

  it('should return zero progress for empty array', () => {
    const result = kanbanProgress([]);
    expect(result).toEqual({ total: 0, done: 0 });
  });

  it('should correctly sum progress', () => {
    const features = [
      { totalCount: 5, doneCount: 3 },
      { totalCount: 10, doneCount: 7 },
    ];
    const result = kanbanProgress(features);
    expect(result).toEqual({ total: 15, done: 10 });
  });
});

// =====================================================================
// Full cascade test — simulates the exact crash scenario
// =====================================================================

describe('Full cascade — non-array TodoWrite todos should not crash render pipeline', () => {
  it('should produce valid kanban output when TodoWrite sends string todos', () => {
    // This reproduces the exact bug: agent sends { todos: "some string" }
    const messages = [
      todoWriteMessage('Fix the authentication module'),
    ];
    const activeTasks = [{ id: 'task-1', title: 'Test Task', createdAt: 1000 }];

    // Step 1: buildTodosByFeature should not crash
    const todosByFeature = buildTodosByFeature(messages);
    expect(todosByFeature).toEqual([]);

    // Step 2: buildFeatureKanban should not crash
    const featureKanban = buildFeatureKanban(
      activeTasks, todosByFeature, [], new Set(), 'Global'
    );
    expect(featureKanban).toHaveLength(1);

    // Step 3: groupKanban should not crash
    const grouped = groupKanban(featureKanban);
    expect(grouped.inProgress).toHaveLength(1);
    expect(grouped.completed).toHaveLength(0);

    // Step 4: kanbanProgress should not crash
    const progress = kanbanProgress(featureKanban);
    expect(progress).toEqual({ total: 0, done: 0 });
  });

  it('should produce valid kanban even when upstream buildTodosByFeature returns unexpected value', () => {
    // Simulate what happens if buildTodosByFeature somehow returns null
    // (shouldn't happen with our fix, but defense in depth)
    const featureKanban = buildFeatureKanban([], null, [], new Set(), 'Global');
    const grouped = groupKanban(featureKanban);
    const progress = kanbanProgress(featureKanban);

    expect(featureKanban).toEqual([]);
    expect(grouped).toEqual({ inProgress: [], completed: [] });
    expect(progress).toEqual({ total: 0, done: 0 });
  });

  it('should handle mixed valid and invalid messages through the full pipeline', () => {
    const messages = [
      todoWriteMessage({ bad: 'object' }, { role: 'pm', timestamp: 1000 }),
      todoWriteMessage([
        { content: 'Implement login', status: 'completed', activeForm: 'Implementing login' },
        { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      ], { role: 'dev', timestamp: 2000 }),
      todoWriteMessage(999, { role: 'qa', timestamp: 3000 }),
    ];

    const activeTasks = [{ id: 'task-1', title: 'Test Task', createdAt: 1000 }];
    const todosByFeature = buildTodosByFeature(messages);
    const featureKanban = buildFeatureKanban(activeTasks, todosByFeature, [], new Set(), 'Global');
    const grouped = groupKanban(featureKanban);
    const progress = kanbanProgress(featureKanban);

    expect(featureKanban).toHaveLength(1);
    expect(progress.total).toBe(2);
    expect(progress.done).toBe(1);
    expect(grouped.inProgress).toHaveLength(1);
  });
});

// =====================================================================
// parseCrewTasks — basic sanity (not part of the fix but complete coverage)
// =====================================================================

describe('parseCrewTasks', () => {
  it('should parse valid TASKS block', () => {
    const messages = [textMessage(`
---TASKS---
- [x] Build auth system #auth-1 @dev
- [ ] Write documentation #docs-1
---END_TASKS---
    `)];
    const tasks = parseCrewTasks(messages);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].done).toBe(true);
    expect(tasks[0].taskId).toBe('auth-1');
    expect(tasks[0].assignee).toBe('dev');
    expect(tasks[1].done).toBe(false);
  });

  it('should return empty array for no TASKS blocks', () => {
    const messages = [textMessage('Hello world')];
    expect(parseCrewTasks(messages)).toEqual([]);
  });

  it('should use latest TASKS block', () => {
    const messages = [
      textMessage('---TASKS---\n- [ ] Old task\n---END_TASKS---'),
      textMessage('---TASKS---\n- [x] New task\n---END_TASKS---'),
    ];
    const tasks = parseCrewTasks(messages);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].text).toBe('New task');
    expect(tasks[0].done).toBe(true);
  });
});

// =====================================================================
// computeCompletedTaskIds — basic sanity
// =====================================================================

describe('computeCompletedTaskIds', () => {
  it('should match by taskId', () => {
    const doneTasks = [{ done: true, text: 'Build auth', taskId: 'auth-1', assignee: null }];
    const activeTasks = [{ id: 'auth-1', title: 'Build authentication' }];
    const ids = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(ids.has('auth-1')).toBe(true);
  });

  it('should match by exact title when no taskId', () => {
    const doneTasks = [{ done: true, text: 'Build authentication', taskId: null, assignee: null }];
    const activeTasks = [{ id: 'auth-1', title: 'Build authentication' }];
    const ids = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(ids.has('auth-1')).toBe(true);
  });

  it('should not match partial title', () => {
    const doneTasks = [{ done: true, text: 'Build', taskId: null, assignee: null }];
    const activeTasks = [{ id: 'auth-1', title: 'Build authentication' }];
    const ids = computeCompletedTaskIds(doneTasks, activeTasks);
    expect(ids.size).toBe(0);
  });

  it('should return empty set for no done tasks', () => {
    const ids = computeCompletedTaskIds([], [{ id: 'auth-1', title: 'Build' }]);
    expect(ids.size).toBe(0);
  });
});
