/**
 * handleUnifyDreamTrigger — routing test (v0.1.754).
 *
 * The handler accepts two call shapes:
 *
 *   { type: 'unify_dream_trigger', groupId } — new in v0.1.754. Routes
 *     to `session.dreamScheduler.triggerDreamForScopes(['group/<id>'])`
 *     so unrelated groups aren't reprocessed. Status + result events
 *     are tagged with `groupId`.
 *
 *   { type: 'unify_dream_trigger', vpId }    — legacy per-VP trigger.
 *     Routes to `triggerDreamNow()` (unscoped pass). Events tagged
 *     with `vpId`.
 *
 * This suite pins:
 *   (a) the correct scheduler method is called for each shape
 *   (b) outbound `unify_dream_status` + `unify_dream_result` envelopes
 *       carry the right id field (groupId XOR vpId — never both)
 *   (c) when the scheduler is uninitialised, an error envelope is sent
 *       (no exception escapes)
 *   (d) scheduler exceptions are caught and surfaced as a result
 *       envelope with success=false
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const outbound = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

import {
  handleUnifyDreamTrigger,
  __testSetSession,
} from '../../../agent/unify/web-bridge.js';

function makeSession(overrides = {}) {
  return {
    dreamScheduler: {
      triggerDreamForScopes: vi.fn(async () => ({
        startedAt: '2026-05-11T08:00:00.000Z',
        targets: [{ target: 'group/g1', status: 'done' }],
      })),
      triggerDreamNow: vi.fn(async () => ({
        startedAt: '2026-05-11T08:00:00.000Z',
        targets: [
          { target: 'user', status: 'done' },
          { target: 'group/g', status: 'done' },
        ],
      })),
      ...(overrides.dreamScheduler || {}),
    },
    ...overrides,
  };
}

function find(type) {
  return outbound.find(m => m && m.type === type);
}

beforeEach(() => {
  outbound.length = 0;
  __testSetSession(null);
});

describe('handleUnifyDreamTrigger — routing', () => {
  it('groupId path → triggerDreamForScopes(["group/<id>"]) + envelopes tagged with groupId', async () => {
    const session = makeSession();
    __testSetSession(session);

    await handleUnifyDreamTrigger({ type: 'unify_dream_trigger', groupId: 'g1' });

    expect(session.dreamScheduler.triggerDreamForScopes).toHaveBeenCalledTimes(1);
    expect(session.dreamScheduler.triggerDreamForScopes).toHaveBeenCalledWith(['group/g1']);
    expect(session.dreamScheduler.triggerDreamNow).not.toHaveBeenCalled();

    const status = find('unify_dream_status');
    expect(status).toBeTruthy();
    expect(status.groupId).toBe('g1');
    expect(status.vpId).toBeUndefined();
    expect(status.status).toBe('running');

    const result = find('unify_dream_result');
    expect(result).toBeTruthy();
    expect(result.groupId).toBe('g1');
    expect(result.vpId).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.entriesCreated).toBe(1);
  });

  it('vpId path → triggerDreamNow() + envelopes tagged with vpId', async () => {
    const session = makeSession();
    __testSetSession(session);

    await handleUnifyDreamTrigger({ type: 'unify_dream_trigger', vpId: 'steve' });

    expect(session.dreamScheduler.triggerDreamNow).toHaveBeenCalledTimes(1);
    expect(session.dreamScheduler.triggerDreamForScopes).not.toHaveBeenCalled();

    const status = find('unify_dream_status');
    expect(status.vpId).toBe('steve');
    expect(status.groupId).toBeUndefined();

    const result = find('unify_dream_result');
    expect(result.vpId).toBe('steve');
    expect(result.groupId).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.entriesCreated).toBe(2);
  });

  it('groupId takes precedence over vpId when both are set', async () => {
    // Defensive: the UI should never send both, but if it does the
    // groupId is the more specific request so it wins. Pinning this
    // explicitly prevents a regression where both ids leak through
    // and the frontend store can't decide which row to update.
    const session = makeSession();
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1', vpId: 'steve' });

    expect(session.dreamScheduler.triggerDreamForScopes).toHaveBeenCalledWith(['group/g1']);
    expect(session.dreamScheduler.triggerDreamNow).not.toHaveBeenCalled();

    const result = find('unify_dream_result');
    expect(result.groupId).toBe('g1');
    expect(result.vpId).toBeUndefined();
  });

  it('falls back to vpId="default" when neither field is set (backwards-compat)', async () => {
    const session = makeSession();
    __testSetSession(session);

    await handleUnifyDreamTrigger({});

    expect(session.dreamScheduler.triggerDreamNow).toHaveBeenCalledTimes(1);
    const status = find('unify_dream_status');
    expect(status.vpId).toBe('default');
  });

  it('sends an error envelope when the scheduler is uninitialised', async () => {
    __testSetSession({ dreamScheduler: null });
    await handleUnifyDreamTrigger({ groupId: 'g1' });
    const result = find('unify_dream_result');
    expect(result).toBeTruthy();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not initialized/i);
    // Regression (PR #757 review, Torvalds Important): the error
    // envelope MUST carry the `groupId` tag so the frontend store can
    // route the failure to the right row. Without this the per-group
    // "Run dream now" button stays stuck on "Running…" forever
    // because `applyDreamResult` can't find a row to update.
    expect(result.groupId).toBe('g1');
    expect(result.vpId).toBeUndefined();
  });

  it('uninitialised-scheduler error envelope carries vpId tag for legacy clients', async () => {
    __testSetSession({ dreamScheduler: null });
    await handleUnifyDreamTrigger({ vpId: 'steve' });
    const result = find('unify_dream_result');
    expect(result.success).toBe(false);
    expect(result.vpId).toBe('steve');
    expect(result.groupId).toBeUndefined();
  });

  it('catches scheduler exceptions and emits success=false with the message', async () => {
    const session = makeSession({
      dreamScheduler: {
        triggerDreamForScopes: vi.fn(async () => {
          throw new Error('disk full');
        }),
        triggerDreamNow: vi.fn(),
      },
    });
    __testSetSession(session);

    await handleUnifyDreamTrigger({ groupId: 'g1' });

    const status = find('unify_dream_status');
    expect(status.status).toBe('running');

    const result = find('unify_dream_result');
    expect(result.groupId).toBe('g1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('disk full');
  });
});
