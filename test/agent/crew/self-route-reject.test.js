/**
 * task-330a — self-route rejection + replacement built-in actions
 *
 * §A. routing.executeRoute rejects route.to === fromRole:
 *     - no dispatchToRole, no kanban write, no human-mode flip
 *     - emits routing-metrics(reason='self-route') + crew_route_rejected
 *     - turn is NOT consumed (round unchanged)
 *
 * §B. taskClose / roleStandby helpers replace the "PM 给自己发闭环消息"
 *     anti-pattern: write kanban directly + broadcast status card.
 *
 * Red lines verified:
 *   - parseRoutes / displayBody contract unchanged (task-319/328 still green).
 *   - Old session replay: roleStandby only ADDS .standby key, never removes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { executeRoute } from '../../../agent/crew/routing.js';
import { taskClose, roleStandby, STANDBY_REASONS } from '../../../agent/crew/builtin-actions.js';
import ctx from '../../../agent/context.js';

// ─── helpers ────────────────────────────────────────────────────

/** Capture sendCrewMessage emissions by stubbing ctx.sendToServer. */
function withCapturedMessages(fn) {
  const originalSend = ctx.sendToServer;
  const sent = [];
  ctx.sendToServer = (msg) => { sent.push(msg); };
  return Promise.resolve(fn(sent)).finally(() => {
    ctx.sendToServer = originalSend;
  });
}

/** Build a minimum-viable in-memory session for routing tests. */
function makeSession(overrides = {}) {
  const roles = new Map();
  roles.set('pm', {
    name: 'pm', displayName: 'PM', icon: '🎯',
    isDecisionMaker: true, roleType: 'pm', groupIndex: 0,
  });
  roles.set('dev-1', {
    name: 'dev-1', displayName: 'Dev1', icon: '👨‍💻',
    isDecisionMaker: false, roleType: 'developer', groupIndex: 1,
  });
  roles.set('rev-1', {
    name: 'rev-1', displayName: 'Rev1', icon: '🔍',
    isDecisionMaker: false, roleType: 'reviewer', groupIndex: 1,
  });
  const roleStates = new Map();
  for (const name of roles.keys()) roleStates.set(name, { turnActive: false });

  return {
    id: 'sess-test',
    sharedDir: '/tmp/.crew-test-' + Math.random().toString(36).slice(2),
    status: 'running',
    roles,
    roleStates,
    decisionMaker: 'pm',
    features: new Map(),
    messageHistory: [],
    humanMessageQueue: [],
    round: 5,
    uiMessages: [],
    language: 'zh-CN',
    ...overrides,
  };
}

// ─── §A. self-route rejection ───────────────────────────────────

describe('task-330a §A — executeRoute rejects self-route', () => {
  it('exact name match: pm → pm is rejected, no dispatch, round unchanged', async () => {
    await withCapturedMessages(async (sent) => {
      const session = makeSession();
      const startRound = session.round;

      await executeRoute(session, 'pm', {
        to: 'pm', summary: 'self-msg', taskId: null, taskTitle: null,
      });

      expect(session.round).toBe(startRound);
      // No status flip to waiting_human
      expect(session.status).toBe('running');
      // routing-metrics fired
      const metrics = sent.find(m => m.type === 'routing-metrics');
      expect(metrics).toBeDefined();
      expect(metrics.reason).toBe('self-route');
      expect(metrics.fromRole).toBe('pm');
      // user-facing rejection card fired
      const rejection = sent.find(m => m.type === 'crew_route_rejected');
      expect(rejection).toBeDefined();
      expect(rejection.reason).toBe('self-route');
      // crew_output (route card) MUST NOT fire — turn isn't consumed
      const routeCard = sent.find(m => m.type === 'crew_output' && m.outputType === 'route');
      expect(routeCard).toBeUndefined();
    });
  });

  it('alias match: dev-1 → developer (roleType) resolves to dev-1, rejected', async () => {
    await withCapturedMessages(async (sent) => {
      const session = makeSession();
      await executeRoute(session, 'dev-1', {
        to: 'developer', summary: 'x', taskId: null,
      });
      const metrics = sent.find(m => m.type === 'routing-metrics');
      expect(metrics).toBeDefined();
      expect(metrics.reason).toBe('self-route');
    });
  });

  it('case-insensitive raw match still rejected even when resolveRoleName misses', async () => {
    await withCapturedMessages(async (sent) => {
      const session = makeSession();
      await executeRoute(session, 'pm', { to: 'PM', summary: 'x', taskId: null });
      expect(sent.find(m => m.type === 'routing-metrics')).toBeDefined();
    });
  });

  it('different role pm → dev-1 is NOT rejected (control case)', async () => {
    await withCapturedMessages(async (sent) => {
      const session = makeSession();
      // Make resolveRoleName succeed but block dispatch by giving an empty
      // humanMessageQueue trick: we mark the target as "human" via a hack
      // — actually simpler: just verify the rejection path is NOT triggered
      // by inspecting metrics, regardless of what dispatchToRole does.
      // We catch the inevitable dispatch error since we don't have a real SDK.
      const origInputStream = { isDone: false, enqueue: () => {} };
      session.roleStates.get('dev-1').inputStream = origInputStream;
      session.roleStates.get('dev-1').query = {};
      try {
        await executeRoute(session, 'pm', {
          to: 'dev-1', summary: 'go', taskId: null,
        });
      } catch { /* noop */ }
      expect(sent.find(m => m.type === 'routing-metrics')).toBeUndefined();
      expect(sent.find(m => m.type === 'crew_route_rejected')).toBeUndefined();
    });
  });

  it('to: human is NOT treated as self-route (human is not a role)', async () => {
    await withCapturedMessages(async (sent) => {
      const session = makeSession();
      await executeRoute(session, 'human', {
        to: 'human', summary: 'noop', taskId: null,
      });
      // human-route path flips status to waiting_human
      expect(session.status).toBe('waiting_human');
      // No self-route metric
      expect(sent.find(m => m.type === 'routing-metrics')).toBeUndefined();
    });
  });
});

// ─── §B. taskClose ──────────────────────────────────────────────

describe('task-330a §B — taskClose', () => {
  it('rejects invalid taskId', async () => {
    const session = makeSession();
    const result = await taskClose(session, { taskId: '<placeholder>', summary: 'x' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_task_id');
  });

  it('rejects missing taskId', async () => {
    const session = makeSession();
    const result = await taskClose(session, { taskId: null, summary: 'x' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_task_id');
  });

  it('marks task complete + broadcasts status card', async () => {
    await withCapturedMessages(async (sent) => {
      const session = makeSession();
      session.features.set('task-330a', { taskId: 'task-330a', taskTitle: 'Self-route reject' });
      // Stub fs writes by giving a sharedDir we can ignore (updateKanban is
      // best-effort and warns on failure). The in-memory _completedTaskIds
      // mutation is what we actually assert.
      const result = await taskClose(session, {
        taskId: 'task-330a', summary: 'shipped', fromRole: 'pm',
      });
      expect(result.ok).toBe(true);
      expect(session._completedTaskIds.has('task-330a')).toBe(true);
      const card = sent.find(m => m.type === 'crew_task_closed');
      expect(card).toBeDefined();
      expect(card.taskId).toBe('task-330a');
      expect(card.taskTitle).toBe('Self-route reject');
      expect(card.summary).toBe('shipped');
      expect(card.fromRole).toBe('pm');
    });
  });

  it('idempotent: closing twice is safe', async () => {
    const session = makeSession();
    await taskClose(session, { taskId: 'task-1', summary: 'a' });
    await taskClose(session, { taskId: 'task-1', summary: 'b' });
    expect(session._completedTaskIds.has('task-1')).toBe(true);
    expect(session._completedTaskIds.size).toBe(1);
  });
});

// ─── §B. roleStandby ────────────────────────────────────────────

describe('task-330a §B — roleStandby', () => {
  it('rejects unknown role', () => {
    const session = makeSession();
    const result = roleStandby(session, { role: 'ghost' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown_role');
  });

  it('flips role into standby with normalized reason + broadcasts', async () => {
    await withCapturedMessages(async (sent) => {
      const session = makeSession();
      const result = roleStandby(session, {
        role: 'dev-1', reason: 'task_closed', fromRole: 'pm',
      });
      expect(result.ok).toBe(true);
      const state = session.roleStates.get('dev-1');
      expect(state.standby).toBeDefined();
      expect(state.standby.reason).toBe('task_closed');
      expect(state.standby.setBy).toBe('pm');
      expect(typeof state.standby.since).toBe('number');
      const card = sent.find(m => m.type === 'crew_role_standby');
      expect(card).toBeDefined();
      expect(card.role).toBe('dev-1');
    });
  });

  it('unknown reason normalizes to "manual"', () => {
    const session = makeSession();
    roleStandby(session, { role: 'rev-1', reason: 'bogus' });
    expect(session.roleStates.get('rev-1').standby.reason).toBe('manual');
  });

  it('preserves pre-existing roleState fields (replay-safety)', () => {
    const session = makeSession();
    const before = session.roleStates.get('dev-1');
    before.lastInputTokens = 12345;
    before.currentTask = { taskId: 'task-99', taskTitle: 'old' };
    roleStandby(session, { role: 'dev-1', reason: 'idle' });
    const after = session.roleStates.get('dev-1');
    expect(after.lastInputTokens).toBe(12345);
    expect(after.currentTask).toEqual({ taskId: 'task-99', taskTitle: 'old' });
    expect(after.standby.reason).toBe('idle');
  });

  it('STANDBY_REASONS contract is frozen', () => {
    expect(Object.isFrozen(STANDBY_REASONS)).toBe(true);
    expect(STANDBY_REASONS).toContain('task_closed');
    expect(STANDBY_REASONS).toContain('manual');
  });
});
