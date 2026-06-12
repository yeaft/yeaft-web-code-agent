/**
 * fix-yeaft-session-per-agent
 *
 * `broadcastYeaftSessionSnapshotEager` is called from
 * `agent/connection/message-router.js` on the `registered` envelope
 * so the unified web sidebar can populate this agent's session rows
 * the moment the agent connects — without waiting for the user to
 * send a first Yeaft message (which is what historically triggered
 * `ensureSessionLoaded` → snapshot emit).
 *
 * Symptom this fixes (in the bug report): "I create a session in
 * Agent A, then click Agent B's session — not only does the newly
 * created one disappear, the previously loaded ones disappear too."
 * The "previously loaded ones disappear" half is a routing problem
 * (fixed in chat.js — see yeaft-cross-agent-session-routing.test.js);
 * the "Agent B's sessions never even loaded" half is what this
 * eager-broadcast fixes.
 *
 * This test exercises the full envelope shape (`session_list_updated`)
 * and verifies the snapshot contents reflect what's on disk. The legacy
 * `group_list_updated` dual-emit was removed as part of the
 * group→session rename — the wire surface is single-name now.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outbound = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: (msg) => { outbound.push(msg); },
  flushMessageBuffer: () => {},
}));

import ctx from '../../../agent/context.js';
import { broadcastYeaftSessionSnapshotEager } from '../../../agent/yeaft/web-bridge.js';
import { createSession } from '../../../agent/yeaft/sessions/session-store.js';

function eventsOfType(type) {
  return outbound.map(m => m.event).filter(e => e && e.type === type);
}

describe('broadcastYeaftSessionSnapshotEager — eager on-register broadcast', () => {
  let yeaftDir;
  beforeEach(() => {
    yeaftDir = mkdtempSync(join(tmpdir(), 'eagerbcast-'));
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir };
    outbound.length = 0;
  });

  it('emits session_list_updated (legacy group_list_updated dual-emit removed)', () => {
    createSession(join(yeaftDir, 'sessions'), {
      id: 'grp_alpha_aaaaaaaa', name: 'Alpha', roster: [],
    }).close();

    broadcastYeaftSessionSnapshotEager();

    const legacy = eventsOfType('group_list_updated');
    const modern = eventsOfType('session_list_updated');
    expect(legacy).toHaveLength(0);
    expect(modern).toHaveLength(1);
    expect(modern[0].sessions).toBeInstanceOf(Array);
  });

  it('includes every on-disk session in the snapshot', () => {
    createSession(join(yeaftDir, 'sessions'), {
      id: 'grp_one_11111111', name: 'One', roster: [],
    }).close();
    createSession(join(yeaftDir, 'sessions'), {
      id: 'grp_two_22222222', name: 'Two', roster: [],
    }).close();

    broadcastYeaftSessionSnapshotEager();

    const sessions = eventsOfType('session_list_updated')[0].sessions;
    const ids = sessions.map(s => s.id).sort();
    expect(ids).toEqual(['grp_one_11111111', 'grp_two_22222222']);
  });

  it('emits an empty-list snapshot rather than skipping when there are no sessions', () => {
    broadcastYeaftSessionSnapshotEager();

    const modern = eventsOfType('session_list_updated');
    expect(modern).toHaveLength(1);
    expect(modern[0].sessions).toEqual([]);
  });

  it('is a no-op (no envelope) when yeaftDir is not configured', () => {
    ctx.CONFIG = { ...(ctx.CONFIG || {}), yeaftDir: null };

    broadcastYeaftSessionSnapshotEager();

    expect(outbound).toEqual([]);
  });
});
