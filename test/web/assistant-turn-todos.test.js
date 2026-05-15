import { describe, expect, it } from 'vitest';
import { getTodoDisplayState } from '../../web/utils/todo-display-state.js';

describe('AssistantTurn TodoWrite display state', () => {
  it('keeps streaming in_progress todos active and uses activeForm', () => {
    const todo = {
      content: 'Create a tag',
      activeForm: 'Creating a tag',
      status: 'in_progress'
    };

    expect(getTodoDisplayState({ isStreaming: true }, todo)).toMatchObject({
      rawStatus: 'in_progress',
      displayStatus: 'in_progress',
      displayText: 'Creating a tag',
      staleLabel: ''
    });
  });

  it('shows ended in_progress todos as stale instead of still running', () => {
    const todo = {
      content: 'Create a tag',
      activeForm: 'Creating a tag',
      status: 'in_progress'
    };

    expect(getTodoDisplayState({ isStreaming: false }, todo)).toMatchObject({
      rawStatus: 'in_progress',
      displayStatus: 'stale',
      displayText: 'Create a tag',
      staleLabel: 'not updated before turn ended'
    });
  });

  it('shows ended pending todos as stale instead of implicitly completed', () => {
    const todo = {
      content: 'Report results',
      activeForm: 'Reporting results',
      status: 'pending'
    };

    expect(getTodoDisplayState({ isStreaming: false }, todo)).toMatchObject({
      rawStatus: 'pending',
      displayStatus: 'stale',
      displayText: 'Report results',
      staleLabel: 'not updated before turn ended'
    });
  });

  it('keeps completed todos completed after the turn ends', () => {
    const todo = {
      content: 'Run tests',
      status: 'completed'
    };

    expect(getTodoDisplayState({ isStreaming: false }, todo)).toMatchObject({
      rawStatus: 'completed',
      displayStatus: 'completed',
      displayText: 'Run tests',
      staleLabel: ''
    });
  });

  it('does not mutate or auto-complete the raw todo item', () => {
    const todo = {
      content: 'Open PR',
      activeForm: 'Opening PR',
      status: 'in_progress'
    };

    const result = getTodoDisplayState({ isStreaming: false }, todo);

    expect(todo).toEqual({
      content: 'Open PR',
      activeForm: 'Opening PR',
      status: 'in_progress'
    });
    expect(result.status).toBe('in_progress');
    expect(result.displayStatus).toBe('stale');
  });
});
