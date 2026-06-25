import { describe, expect, it } from 'vitest';
import { getTodoDisplayState } from '../../web/utils/todo-display-state.js';

describe('todo display state', () => {
  it('shows active in-progress todos while the turn is streaming', () => {
    const todo = getTodoDisplayState({ isStreaming: true }, {
      content: 'Run tests',
      activeForm: 'Running tests',
      status: 'in_progress',
    });

    expect(todo.rawStatus).toBe('in_progress');
    expect(todo.displayStatus).toBe('in_progress');
    expect(todo.displayText).toBe('Running tests');
  });

  it('does not leave an in-progress spinner after the turn ended', () => {
    const todo = getTodoDisplayState({ isStreaming: false }, {
      content: 'Report result',
      activeForm: 'Reporting result',
      status: 'in_progress',
    });

    expect(todo.rawStatus).toBe('in_progress');
    expect(todo.displayStatus).toBe('stopped');
    expect(todo.displayText).toBe('Report result');
  });

  it('keeps explicit completed todos completed after the turn ended', () => {
    const todo = getTodoDisplayState({ isStreaming: false }, {
      content: 'Open PR',
      activeForm: 'Opening PR',
      status: 'completed',
    });

    expect(todo.displayStatus).toBe('completed');
    expect(todo.displayText).toBe('Open PR');
  });
});
