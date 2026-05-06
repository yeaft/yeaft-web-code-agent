/**
 * sub-agent-feature-inheritance.test.js — PR-4 Track 2.
 *
 * Pin: when the parent VP is mid-feature, every event the sub-agent
 * runner forwards via `onEvent` should carry the parent's featureId
 * stamped onto the payload. The runner reads this via
 * `deps.getCurrentFeatureId()` (lazy accessor) so a feature that opens
 * AFTER the sub-agent spawns still tags later events.
 *
 * Edge cases pinned here:
 *   1. Accessor returns 'F1' → every forwarded event has featureId === 'F1'.
 *   2. Accessor returns null (no active feature) → forwarded events have
 *      no `featureId` field at all (NOT featureId: null) so frontend can
 *      tell "absent" from "explicitly absent".
 *   3. Accessor returns 'F1' but the inner event already has a featureId
 *      → original featureId is preserved (do not overwrite).
 *   4. Accessor flips from null → 'F2' between events (mimicking a mid-turn
 *      feature open) → only events emitted AFTER the flip carry 'F2'.
 *   5. Status events (sub_agent_status, sub_agent_turn_end) also carry the
 *      featureId — the wrapEvt helper applies uniformly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _resetAgentRegistry, getAgentRegistry } from '../../../agent/unify/tools/agent.js';
import agentTool from '../../../agent/unify/tools/agent.js';
import { ToolRegistry } from '../../../agent/unify/tools/registry.js';
import { defineTool } from '../../../agent/unify/tools/types.js';
import { NullTrace } from '../../../agent/unify/debug-trace.js';

/**
 * Scripted adapter that emits a single text + end_turn for every stream()
 * call. Matches the shape used in test/agent/sub-agent/sub-agent.test.js.
 */
class TextAdapter {
  constructor(reply = 'mission accomplished') {
    this.reply = reply;
  }
  async *stream() {
    yield { type: 'text_delta', text: this.reply };
    yield { type: 'stop', stopReason: 'end_turn' };
  }
  async call() {
    return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const echoTool = defineTool({
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: {} },
  async execute(input) { return JSON.stringify({ echo: input }); },
});

function mkParentRegistry() {
  const reg = new ToolRegistry();
  reg.register(echoTool);
  return reg;
}

function mkDeps(adapter, overrides = {}) {
  return {
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
    parentToolRegistry: mkParentRegistry(),
    parentName: 'TestParent',
    parentVpId: 'vp-test',
    parentVpPersona: { vpId: 'vp-test', persona: 'You are TestPersona.' },
    ...overrides,
  };
}

async function waitUntilIdle(agent, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && agent.status === 'running') {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('PR-4 sub-agent feature inheritance', () => {
  beforeEach(() => _resetAgentRegistry());

  it('stamps the parent featureId on every forwarded event when accessor returns a value', async () => {
    const events = [];
    const deps = mkDeps(new TextAdapter('done'), {
      getCurrentFeatureId: () => 'F1',
      onEvent: (agentId, evt) => events.push({ agentId, evt }),
    });

    const out = JSON.parse(await agentTool.execute(
      { name: 'inherits-fid', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    expect(out.success).toBe(true);

    const agent = getAgentRegistry().get(out.agentId);
    await waitUntilIdle(agent);
    expect(agent.status).toBe('idle');

    expect(events.length).toBeGreaterThan(0);
    // Every event should carry the parent featureId.
    for (const { evt } of events) {
      expect(evt.featureId).toBe('F1');
      expect(evt.agentId).toBe(out.agentId);
    }
    // And the canonical text-delta + turn-end should be among them, both
    // tagged.
    expect(events.some(({ evt }) => evt.type === 'text_delta' && evt.featureId === 'F1')).toBe(true);
    expect(events.some(({ evt }) => evt.type === 'sub_agent_turn_end' && evt.featureId === 'F1')).toBe(true);
    expect(events.some(({ evt }) => evt.type === 'sub_agent_status' && evt.featureId === 'F1')).toBe(true);
  });

  it('omits the featureId field entirely when accessor returns null (not "featureId: null")', async () => {
    const events = [];
    const deps = mkDeps(new TextAdapter('no feature'), {
      getCurrentFeatureId: () => null,
      onEvent: (agentId, evt) => events.push({ agentId, evt }),
    });

    const out = JSON.parse(await agentTool.execute(
      { name: 'no-feature', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    await waitUntilIdle(agent);

    expect(events.length).toBeGreaterThan(0);
    for (const { evt } of events) {
      // The runner must NOT emit `featureId: null` — frontends use the
      // absence of the field to tell "no parent feature" apart from a
      // bug. (Per plan risk #5.)
      expect(Object.prototype.hasOwnProperty.call(evt, 'featureId')).toBe(false);
    }
  });

  it('does not overwrite a featureId already present on the inner event', async () => {
    // Adapter that emits an event already carrying its own featureId
    // (simulates a sub-engine that somehow attributes its own feature —
    // the runner must defer to the existing value, never clobber).
    class PreTaggedAdapter {
      async *stream() {
        yield { type: 'text_delta', text: 'pre-tagged', featureId: 'INNER-FID' };
        yield { type: 'stop', stopReason: 'end_turn' };
      }
      async call() { return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; }
    }
    const events = [];
    const deps = mkDeps(new PreTaggedAdapter(), {
      getCurrentFeatureId: () => 'PARENT-FID',
      onEvent: (agentId, evt) => events.push({ agentId, evt }),
    });

    const out = JSON.parse(await agentTool.execute(
      { name: 'pre-tagged', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    await waitUntilIdle(agent);

    const textDelta = events.find(({ evt }) => evt.type === 'text_delta');
    expect(textDelta).toBeDefined();
    expect(textDelta.evt.featureId).toBe('INNER-FID');
  });

  it('reads the accessor lazily — events emitted after the accessor flips pick up the new value', async () => {
    let currentFid = null;
    const events = [];
    // The text adapter's stream is a single tick; we'll flip the accessor
    // right after spawn but before the runner wraps the first event. The
    // accessor is read at emit-time inside wrapEvt, so the flip applies.
    const deps = mkDeps(new TextAdapter('flipped'), {
      getCurrentFeatureId: () => currentFid,
      onEvent: (agentId, evt) => events.push({ agentId, evt }),
    });

    const out = JSON.parse(await agentTool.execute(
      { name: 'lazy-accessor', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    // Flip BEFORE the runner pumps events; this is racy in principle but
    // the runner uses microtasks and setTimeout, so the synchronous flip
    // here lands first.
    currentFid = 'F-LAZY';
    const agent = getAgentRegistry().get(out.agentId);
    await waitUntilIdle(agent);

    // At least one event should carry the late-bound featureId.
    expect(events.some(({ evt }) => evt.featureId === 'F-LAZY')).toBe(true);
  });

  it('absence of getCurrentFeatureId in deps falls back to no-stamp behavior', async () => {
    // Older callers / non-feature pathways may not pass the accessor at
    // all. The runner must remain usable without it.
    const events = [];
    const deps = mkDeps(new TextAdapter('no-accessor'), {
      onEvent: (agentId, evt) => events.push({ agentId, evt }),
    });
    // explicitly no getCurrentFeatureId

    const out = JSON.parse(await agentTool.execute(
      { name: 'no-accessor', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    await waitUntilIdle(agent);

    expect(events.length).toBeGreaterThan(0);
    for (const { evt } of events) {
      expect(Object.prototype.hasOwnProperty.call(evt, 'featureId')).toBe(false);
    }
  });

  it('accessor that throws is treated as null (no featureId stamped, no error propagation)', async () => {
    const events = [];
    const deps = mkDeps(new TextAdapter('safe'), {
      getCurrentFeatureId: () => { throw new Error('boom'); },
      onEvent: (agentId, evt) => events.push({ agentId, evt }),
    });

    const out = JSON.parse(await agentTool.execute(
      { name: 'throwing-accessor', mission: 'go' },
      { parentEngineDeps: deps },
    ));
    const agent = getAgentRegistry().get(out.agentId);
    await waitUntilIdle(agent);

    expect(agent.status).toBe('idle');
    expect(events.length).toBeGreaterThan(0);
    for (const { evt } of events) {
      expect(Object.prototype.hasOwnProperty.call(evt, 'featureId')).toBe(false);
    }
  });
});
