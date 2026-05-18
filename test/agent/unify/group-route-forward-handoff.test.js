/**
 * group-route-forward-handoff.test.js — task-707.
 *
 * Verifies the route_forward hand-off contract end-to-end at the layers
 * we can isolate cleanly:
 *
 *   1. Engine: when a tool calls ctx.requestEndTurn(reason), the engine
 *      yields turn_end with stopReason='tool_handoff' + the structured
 *      detail, and does NOT call adapter.stream() again. (Bug 1 fix.)
 *
 *   2. route_forward tool: on a successful router.forward() it calls
 *      ctx.requestEndTurn({kind:'route_forward', fromVpId, dispatched,
 *      broadcast, text, reason}) with the right shape, AND on a failed
 *      forward (self/non-member/etc.) it does NOT call requestEndTurn.
 *
 *   3. Integration: real coordinator + real router + real route_forward
 *      tool driven by an Engine with a MockAdapter. We confirm that when
 *      VP-A's first response is a route_forward tool_use, the engine
 *      breaks the loop with stopReason='tool_handoff' AND the inbox-style
 *      deliver callback received an envelope for the target VP.
 *
 * Bridge-level scenarios (per-VP driver, vp_typing_start emission on
 * enqueue, multi-target concurrent typing) are covered separately via
 * `__testResetVpState` / `__testDrainVpDrivers` exports — they require a
 * full session boot that's awkward in a vitest harness, so they live in
 * the manual smoke matrix in the plan file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Engine } from '../../../agent/unify/engine.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';
import { ToolRegistry } from '../../../agent/unify/tools/registry.js';
import { defineTool } from '../../../agent/unify/tools/types.js';
import routeForward from '../../../agent/unify/tools/route-forward.js';
import { createGroup, openGroup } from '../../../agent/unify/groups/group-store.js';
import { createCoordinator } from '../../../agent/unify/groups/coordinator.js';
import { createRouter } from '../../../agent/unify/routing/router.js';

/**
 * MockAdapter — emits pre-configured responses one at a time. Each
 * call to .stream(params) shifts the next response off the queue.
 *
 * If the test pushes 1 response and stream() is called twice, the
 * second call throws — which is exactly how we assert "engine MUST
 * NOT call adapter.stream() a second time" without an artificial
 * spy/counter (the throw fails the test loud).
 */
class MockAdapter {
  constructor() {
    this.responses = [];
    this.callLog = [];
  }
  pushResponse(events) { this.responses.push(events); }
  async *stream(params) {
    this.callLog.push(params);
    const events = this.responses.shift();
    if (!events) {
      throw new Error('MockAdapter: no more responses queued');
    }
    for (const event of events) yield event;
  }
}

let TEST_DIR;
let groupsRoot;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'rf-handoff-'));
  groupsRoot = join(TEST_DIR, 'groups');
});
afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* */ }
});

// ─── 1. Engine-level requestEndTurn semantics ──────────────────

describe('Engine.requestEndTurn (task-707)', () => {
  it('1a. tool that calls ctx.requestEndTurn ends the turn after the tool batch — adapter.stream is NOT called a second time', async () => {
    const adapter = new MockAdapter();
    const trace = new NullTrace();
    const registry = new ToolRegistry();
    let endTurnReason = null;

    registry.register(defineTool({
      name: 'handoff',
      description: 'Pretend hand-off',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        endTurnReason = { kind: 'route_forward', fromVpId: 'vp-a', dispatched: ['vp-b'] };
        ctx.requestEndTurn(endTurnReason);
        return JSON.stringify({ ok: true, dispatched: ['vp-b'] });
      },
    }));

    // First (and only) adapter response: emit a tool_call, then stop.
    adapter.pushResponse([
      { type: 'text_delta', text: 'I will hand off.' },
      { type: 'tool_call', id: 'call_1', name: 'handoff', input: {} },
      { type: 'usage', inputTokens: 50, outputTokens: 20 },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    // Note: no second response queued. If the engine calls stream() again,
    // MockAdapter throws — and the test fails loudly.

    const engine = new Engine({
      adapter, trace, config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
    });

    const events = [];
    for await (const ev of engine.query({ prompt: 'please hand off' })) {
      events.push(ev);
    }

    // Adapter was called exactly once.
    expect(adapter.callLog).toHaveLength(1);

    // The tool ran.
    const toolEnds = events.filter(e => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].name).toBe('handoff');
    expect(toolEnds[0].isError).toBe(false);

    // Final turn_end has stopReason='tool_handoff' and the structured
    // detail we passed in.
    const turnEnd = events.filter(e => e.type === 'turn_end').pop();
    expect(turnEnd).toBeDefined();
    expect(turnEnd.stopReason).toBe('tool_handoff');
    expect(turnEnd.detail).toEqual({
      kind: 'route_forward',
      fromVpId: 'vp-a',
      dispatched: ['vp-b'],
    });
  });

  it('1b. requestEndTurn with a string reason coerces to {kind:"tool_handoff", reason}', async () => {
    const adapter = new MockAdapter();
    const trace = new NullTrace();
    const registry = new ToolRegistry();

    registry.register(defineTool({
      name: 'stopper',
      description: 'string-reason hand-off',
      parameters: { type: 'object', properties: {} },
      execute: async (_input, ctx) => {
        ctx.requestEndTurn('debugging');
        return 'done';
      },
    }));

    adapter.pushResponse([
      { type: 'tool_call', id: 'c1', name: 'stopper', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);

    const engine = new Engine({
      adapter, trace, config: { model: 'm', maxOutputTokens: 256 },
      toolRegistry: registry,
    });

    const events = [];
    for await (const ev of engine.query({ prompt: 'go' })) events.push(ev);

    const turnEnd = events.filter(e => e.type === 'turn_end').pop();
    expect(turnEnd.stopReason).toBe('tool_handoff');
    // String reason gets normalized into the engine's structured shape.
    // engine.js: `{ kind: 'tool_handoff', reason: String(...) }` when the
    // setter received a non-object. But route_forward always passes an
    // object — string is the dev-shortcut path.
    expect(turnEnd.detail).toEqual({ kind: 'tool_handoff', reason: 'debugging' });
  });

  it('1c. requestEndTurn does NOT fire if no tool calls it — normal end_turn flow proceeds', async () => {
    const adapter = new MockAdapter();
    const trace = new NullTrace();
    const registry = new ToolRegistry();

    adapter.pushResponse([
      { type: 'text_delta', text: 'plain answer' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter, trace, config: { model: 'm', maxOutputTokens: 256 },
      toolRegistry: registry,
    });

    const events = [];
    for await (const ev of engine.query({ prompt: 'hi' })) events.push(ev);

    const turnEnd = events.filter(e => e.type === 'turn_end').pop();
    expect(turnEnd.stopReason).toBe('end_turn');
    expect(turnEnd.detail).toBeUndefined();
  });

  it('1d. first call to requestEndTurn wins — a second tool in the same batch does not overwrite the reason', async () => {
    const adapter = new MockAdapter();
    const trace = new NullTrace();
    const registry = new ToolRegistry();

    registry.register(defineTool({
      name: 'first', description: 'first',
      parameters: { type: 'object', properties: {} },
      execute: async (_i, ctx) => {
        ctx.requestEndTurn({ kind: 'route_forward', fromVpId: 'vp-a', dispatched: ['vp-b'] });
        return 'first';
      },
    }));
    registry.register(defineTool({
      name: 'second', description: 'second',
      parameters: { type: 'object', properties: {} },
      execute: async (_i, ctx) => {
        ctx.requestEndTurn({ kind: 'route_forward', fromVpId: 'vp-a', dispatched: ['vp-c'] });
        return 'second';
      },
    }));

    adapter.pushResponse([
      { type: 'tool_call', id: 'c1', name: 'first', input: {} },
      { type: 'tool_call', id: 'c2', name: 'second', input: {} },
      { type: 'stop', stopReason: 'tool_use' },
    ]);

    const engine = new Engine({
      adapter, trace, config: { model: 'm', maxOutputTokens: 256 },
      toolRegistry: registry,
    });

    const events = [];
    for await (const ev of engine.query({ prompt: 'go' })) events.push(ev);

    const turnEnd = events.filter(e => e.type === 'turn_end').pop();
    expect(turnEnd.stopReason).toBe('tool_handoff');
    // First wins: dispatched is vp-b, not vp-c.
    expect(turnEnd.detail.dispatched).toEqual(['vp-b']);
  });
});

// ─── 2. route_forward tool — direct unit tests ─────────────────

describe('route_forward.execute (task-707)', () => {
  /**
   * Build a fully-wired router pointing at a real coordinator over a
   * tmp group, plus the in-memory `delivered[]` list the coordinator's
   * deliver() callback feeds. This is the same coordinator + router
   * pair the bridge wires up via getOrCreateGroupContext.
   */
  function setupRoute(vpRoster, defaultVpId = vpRoster[0]) {
    createGroup(groupsRoot, {
      id: 'g-rf', name: 'g-rf', roster: vpRoster, defaultVpId,
    });
    const group = openGroup(groupsRoot, 'g-rf');
    const delivered = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => delivered.push({ vpId, envelope }),
    });
    const router = createRouter({ coordinator: coord });
    return { coord, router, delivered };
  }

  it('2a. successful single-target forward calls ctx.requestEndTurn with structured payload', async () => {
    const { router } = setupRoute(['vp-a', 'vp-b']);
    let captured = null;
    const ctx = {
      router,
      senderVpId: 'vp-a',
      requestEndTurn: (r) => { captured = r; },
    };

    const out = await routeForward.execute(
      { to: 'vp-b', text: 'help with this', reason: 'expertise' },
      ctx,
    );

    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.dispatched).toEqual(['vp-b']);

    expect(captured).toBeTruthy();
    expect(captured.kind).toBe('route_forward');
    expect(captured.fromVpId).toBe('vp-a');
    expect(captured.dispatched).toEqual(['vp-b']);
    expect(captured.broadcast).toBe(false);
    expect(captured.text).toBe('help with this');
    expect(captured.reason).toBe('expertise');
  });

  it('2b. broadcast forward sets broadcast:true on the requestEndTurn payload', async () => {
    const { router } = setupRoute(['vp-a', 'vp-b', 'vp-c']);
    let captured = null;
    const ctx = {
      router,
      senderVpId: 'vp-a',
      requestEndTurn: (r) => { captured = r; },
    };

    const out = await routeForward.execute(
      { to: 'all', text: 'team standup' },
      ctx,
    );

    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.broadcast).toBe(true);
    // dispatched excludes the sender (vp-a) — coord skips authoring VP.
    expect(parsed.dispatched.sort()).toEqual(['vp-b', 'vp-c']);

    expect(captured).toBeTruthy();
    expect(captured.broadcast).toBe(true);
    expect(captured.dispatched.sort()).toEqual(['vp-b', 'vp-c']);
  });

  it('2c. failed forward (self_forward_rejected) does NOT call requestEndTurn', async () => {
    const { router } = setupRoute(['vp-a', 'vp-b']);
    let called = false;
    const ctx = {
      router,
      senderVpId: 'vp-a',
      requestEndTurn: () => { called = true; },
    };

    const out = await routeForward.execute(
      { to: 'vp-a', text: 'self' },
      ctx,
    );

    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('self_forward_rejected');
    // Critical: the engine must keep generating, since the forward
    // didn't actually hand off to anyone.
    expect(called).toBe(false);
  });

  it('2d. failed forward (target_not_in_roster) does NOT call requestEndTurn', async () => {
    const { router } = setupRoute(['vp-a', 'vp-b']);
    let called = false;
    const ctx = {
      router,
      senderVpId: 'vp-a',
      requestEndTurn: () => { called = true; },
    };

    const out = await routeForward.execute(
      { to: 'vp-stranger', text: 'hi' },
      ctx,
    );

    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('target_not_in_roster');
    expect(called).toBe(false);
  });

  it('2e. requestEndTurn missing in ctx does not crash the tool', async () => {
    const { router } = setupRoute(['vp-a', 'vp-b']);
    const ctx = { router, senderVpId: 'vp-a' /* no requestEndTurn */ };
    const out = await routeForward.execute(
      { to: 'vp-b', text: 'hi' },
      ctx,
    );
    // Tool still succeeds — the end-turn signal is best-effort UX.
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
  });

  it('2f. successful forward delivers exactly one envelope to the target', async () => {
    const { router, delivered } = setupRoute(['vp-a', 'vp-b']);
    const ctx = {
      router,
      senderVpId: 'vp-a',
      requestEndTurn: () => {},
    };
    await routeForward.execute({ to: 'vp-b', text: 'help' }, ctx);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].vpId).toBe('vp-b');
    expect(delivered[0].envelope?.msg?.text).toContain('help');
  });
});

// ─── 3. End-to-end through Engine.query() ──────────────────────

describe('Engine + route_forward integration (task-707)', () => {
  it('3a. engine query that emits a route_forward tool_use exits with stopReason=tool_handoff after one adapter call, AND the target VP has an envelope queued', async () => {
    // Set up a real group + coordinator + router. Inbox is the
    // delivered[] sink — represents what the bridge would push into
    // vpInboxes after task-707.
    createGroup(groupsRoot, {
      id: 'g3a', name: 'g3a',
      roster: ['vp-a', 'vp-b'], defaultVpId: 'vp-a',
    });
    const group = openGroup(groupsRoot, 'g3a');
    const inbox = [];
    const coord = createCoordinator(group, {
      deliver: (vpId, envelope) => inbox.push({ vpId, envelope }),
    });
    const router = createRouter({ coordinator: coord });

    const adapter = new MockAdapter();
    const trace = new NullTrace();
    const registry = new ToolRegistry();
    registry.register(routeForward);

    // VP-A's only response is to call route_forward(to='vp-b', text='help').
    // Per task-707 the engine MUST exit after this batch, so we only
    // queue ONE adapter response. A second .stream() call would throw.
    adapter.pushResponse([
      { type: 'text_delta', text: 'I will ask vp-b.' },
      {
        type: 'tool_call',
        id: 'rf_1',
        name: 'RouteForward',
        input: { to: 'vp-b', text: 'please help' },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ]);

    const engine = new Engine({
      adapter, trace, config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
    });

    const events = [];
    // Pass router + senderVpId via the same per-query opts that
    // buildVpQueryOpts threads into the bridge runVpTurn path.
    for await (const ev of engine.query({
      prompt: '@vp-a please ask vp-b',
      router,
      senderVpId: 'vp-a',
    })) {
      events.push(ev);
    }

    // Adapter called exactly once — engine did NOT continue to generate.
    expect(adapter.callLog).toHaveLength(1);

    // Tool fired with the expected dispatched list.
    const toolEnds = events.filter(e => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(1);
    expect(toolEnds[0].name).toBe('RouteForward');
    expect(toolEnds[0].isError).toBe(false);
    const toolPayload = JSON.parse(toolEnds[0].output);
    expect(toolPayload.ok).toBe(true);
    expect(toolPayload.dispatched).toEqual(['vp-b']);

    // turn_end carries the structured handoff detail as audit metadata
    // (kind, fromVpId, dispatched, broadcast, text). The frontend renders
    // the hand-off as a Route tool chip from the tool_call envelope; the
    // previous `group_handoff` UI wire event was removed in PR #793.
    const turnEnd = events.filter(e => e.type === 'turn_end').pop();
    expect(turnEnd.stopReason).toBe('tool_handoff');
    expect(turnEnd.detail.kind).toBe('route_forward');
    expect(turnEnd.detail.fromVpId).toBe('vp-a');
    expect(turnEnd.detail.dispatched).toEqual(['vp-b']);
    expect(turnEnd.detail.broadcast).toBe(false);
    expect(turnEnd.detail.text).toBe('please help');

    // The target VP got an envelope queued — the bridge's enqueueForVp
    // would now drain this via its driver. The pre-707 bug: this
    // envelope existed but was never picked up.
    expect(inbox).toHaveLength(1);
    expect(inbox[0].vpId).toBe('vp-b');
    expect(inbox[0].envelope?.msg?.text).toContain('please help');
  });

  it('3b. engine query that emits a FAILED route_forward (self) does NOT exit — engine continues to a second adapter call', async () => {
    createGroup(groupsRoot, {
      id: 'g3b', name: 'g3b',
      roster: ['vp-a', 'vp-b'], defaultVpId: 'vp-a',
    });
    const group = openGroup(groupsRoot, 'g3b');
    const coord = createCoordinator(group, { deliver: () => {} });
    const router = createRouter({ coordinator: coord });

    const adapter = new MockAdapter();
    const trace = new NullTrace();
    const registry = new ToolRegistry();
    registry.register(routeForward);

    // Turn 1: VP-A tries to forward to itself (rejected).
    adapter.pushResponse([
      {
        type: 'tool_call',
        id: 'rf_1',
        name: 'RouteForward',
        input: { to: 'vp-a', text: 'self' },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
    // Turn 2: model recovers and answers with text. If task-707 mis-fired
    // requestEndTurn on a failed forward, this response would never be
    // consumed and the test would hang or assert wrong stopReason.
    adapter.pushResponse([
      { type: 'text_delta', text: 'oops, let me answer myself.' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);

    const engine = new Engine({
      adapter, trace, config: { model: 'test-model', maxOutputTokens: 1024 },
      toolRegistry: registry,
    });

    const events = [];
    for await (const ev of engine.query({
      prompt: '@vp-a self',
      router,
      senderVpId: 'vp-a',
    })) {
      events.push(ev);
    }

    // Both responses consumed — engine did NOT short-circuit on the
    // failed forward.
    expect(adapter.callLog).toHaveLength(2);

    const lastTurnEnd = events.filter(e => e.type === 'turn_end').pop();
    // Final stop is end_turn, not tool_handoff.
    expect(lastTurnEnd.stopReason).toBe('end_turn');
  });
});
