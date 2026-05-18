/**
 * assistant-turn-todos.test.js — pins the TodoWrite display contract
 * after PR #786 reverted the "stale after turn end" visual.
 *
 * The previous contract added a third pseudo-status `stale` that
 * decorated unfinished todos with `!` + "not updated before turn
 * ended" once the turn stopped streaming. That bled the agent's
 * scratchpad bookkeeping into the user-facing UI in a way users
 * universally read as "something went wrong". The contract now is
 * what it was before PR #780:
 *
 *   pending     → empty checkbox + content
 *   in_progress → spinner + activeForm (or content fallback)
 *   completed   → ✓ + content
 *
 * The helper still takes a `turn` argument for forward-compat with
 * future turn-aware rendering, but does not branch on it.
 */
import { describe, expect, it } from 'vitest';
import { getTodoDisplayState } from '../../web/utils/todo-display-state.js';

describe('AssistantTurn TodoWrite display state', () => {
  it('renders an in_progress todo with activeForm and the spinner status', () => {
    const todo = {
      content: 'Create a tag',
      activeForm: 'Creating a tag',
      status: 'in_progress',
    };

    expect(getTodoDisplayState({ isStreaming: true }, todo)).toMatchObject({
      rawStatus: 'in_progress',
      displayStatus: 'in_progress',
      displayText: 'Creating a tag',
    });
  });

  it('still renders an in_progress todo with activeForm even after the turn ends', () => {
    // Used to flip to `stale` + "not updated before turn ended" — that
    // visual treatment is gone. Whatever the turn state is, the row
    // mirrors the raw status the agent wrote.
    const todo = {
      content: 'Create a tag',
      activeForm: 'Creating a tag',
      status: 'in_progress',
    };

    expect(getTodoDisplayState({ isStreaming: false }, todo)).toMatchObject({
      rawStatus: 'in_progress',
      displayStatus: 'in_progress',
      displayText: 'Creating a tag',
    });
  });

  it('renders a pending todo as plain pending (no checkbox glyph, content text)', () => {
    const todo = {
      content: 'Report results',
      activeForm: 'Reporting results',
      status: 'pending',
    };

    expect(getTodoDisplayState({ isStreaming: false }, todo)).toMatchObject({
      rawStatus: 'pending',
      displayStatus: 'pending',
      displayText: 'Report results',
    });
  });

  it('renders a completed todo with ✓ + content', () => {
    const todo = { content: 'Run tests', status: 'completed' };
    expect(getTodoDisplayState({ isStreaming: false }, todo)).toMatchObject({
      rawStatus: 'completed',
      displayStatus: 'completed',
      displayText: 'Run tests',
    });
  });

  it('does not emit a staleLabel — the field is gone from the contract', () => {
    // Guard against the staleLabel field creeping back via spread.
    const todo = {
      content: 'Open PR',
      activeForm: 'Opening PR',
      status: 'in_progress',
    };
    const result = getTodoDisplayState({ isStreaming: false }, todo);
    expect(result.staleLabel).toBeUndefined();
  });

  it('does not mutate the raw todo item', () => {
    const todo = {
      content: 'Open PR',
      activeForm: 'Opening PR',
      status: 'in_progress',
    };
    const before = JSON.stringify(todo);
    getTodoDisplayState({ isStreaming: false }, todo);
    expect(JSON.stringify(todo)).toBe(before);
  });

  it('falls back to "pending" when status is missing entirely', () => {
    expect(getTodoDisplayState({}, { content: 'No status set' })).toMatchObject({
      rawStatus: 'pending',
      displayStatus: 'pending',
      displayText: 'No status set',
    });
  });

  it('falls back to content when in_progress activeForm is missing', () => {
    expect(getTodoDisplayState({ isStreaming: true }, {
      content: 'Run vitest',
      status: 'in_progress',
    })).toMatchObject({
      displayStatus: 'in_progress',
      displayText: 'Run vitest',
    });
  });
});
