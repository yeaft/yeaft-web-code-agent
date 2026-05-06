/**
 * Tests for `feature-arc.js` — per-VP-turn signal tracker.
 *
 * Covers:
 *   - makeTitle: clipping + trailing punctuation strip + fallback.
 *   - buildSummarySystem: bilingual selection.
 *   - createFeatureArc: idempotent maybeCreateFeature; signals
 *     (quick / loops / key tool) each fire it; non-key tool does NOT;
 *     finalize writes back to the store + emits `featureCompleted`;
 *     finalize on never-escalated turn is a no-op; finalize is
 *     idempotent; status='aborted'/'error' skip the LLM summary call.
 *
 * The store and adapter are mocked. Each test asserts the EXACT shape
 * of emit payloads + store calls, since these are the wire contract.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createFeatureArc,
  KEY_TOOLS,
  FEATURE_TURN_THRESHOLD,
  __test,
} from '../../../agent/unify/feature-arc.js';

const { makeTitle, buildSummarySystem } = __test;

function makeStore() {
  return {
    create: vi.fn(),
    update: vi.fn(),
    _records: [],
  };
}

function makeAdapter(textBatches) {
  const queue = [...textBatches];
  return {
    calls: [],
    async *stream(args) {
      this.calls.push(args);
      const batch = queue.length ? queue.shift() : [];
      for (const evt of batch) yield evt;
    },
  };
}

const td = (text) => ({ type: 'text_delta', text });

describe('makeTitle', () => {
  it('uses preview when present', () => {
    expect(makeTitle({ preview: 'grep auth code', prompt: 'fix it' }))
      .toBe('grep auth code');
  });

  it('falls back to prompt when no preview', () => {
    expect(makeTitle({ prompt: 'do the thing' })).toBe('do the thing');
  });

  it('returns "(untitled task)" when both inputs are empty', () => {
    expect(makeTitle({})).toBe('(untitled task)');
    expect(makeTitle({ preview: '   ', prompt: '' })).toBe('(untitled task)');
  });

  it('strips trailing punctuation', () => {
    expect(makeTitle({ preview: 'grep auth code.' })).toBe('grep auth code');
    expect(makeTitle({ preview: '查一下！' })).toBe('查一下');
    expect(makeTitle({ preview: 'thing?!' })).toBe('thing');
  });

  it('clips at TITLE_MAX (60 chars)', () => {
    const long = 'a'.repeat(120);
    const title = makeTitle({ preview: long });
    expect(title.length).toBe(60);
  });
});

describe('buildSummarySystem', () => {
  it('English by default', () => {
    expect(buildSummarySystem('en')).toMatch(/1.{0,3}3 sentence/);
  });
  it('Chinese for zh*', () => {
    expect(buildSummarySystem('zh')).toMatch(/1.{0,3}3 句/);
    expect(buildSummarySystem('zh-CN')).toMatch(/1.{0,3}3 句/);
  });
});

describe('createFeatureArc — observeEvent triggers', () => {
  it('does NOT fire on a single non-key tool call', () => {
    const store = makeStore();
    const featureStarted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'hi',
      vpId: 'alice',
      turnId: 't1',
      emit: { featureStarted },
    });
    arc.observeEvent({ type: 'tool_call', name: 'Read' }); // not in KEY_TOOLS
    arc.observeEvent({ type: 'tool_call', name: 'web_search' });
    expect(arc.getFeatureId()).toBeNull();
    expect(store.create).not.toHaveBeenCalled();
    expect(featureStarted).not.toHaveBeenCalled();
  });

  it('fires on first key tool call', () => {
    const store = makeStore();
    const featureStarted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'fix the auth bug',
      vpId: 'alice',
      turnId: 't1',
      emit: { featureStarted },
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    expect(arc.getFeatureId()).toBeTruthy();
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(featureStarted).toHaveBeenCalledTimes(1);
    expect(featureStarted.mock.calls[0][0]).toMatchObject({
      featureId: arc.getFeatureId(),
      trigger: 'tool',
      toolName: 'Bash',
    });
  });

  it('fires after FEATURE_TURN_THRESHOLD loop events', () => {
    const store = makeStore();
    const featureStarted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'alice',
      turnId: 't1',
      emit: { featureStarted },
    });
    for (let i = 0; i < FEATURE_TURN_THRESHOLD - 1; i++) {
      arc.observeEvent({ type: 'loop' });
      expect(arc.getFeatureId()).toBeNull();
    }
    arc.observeEvent({ type: 'loop' });
    expect(arc.getFeatureId()).toBeTruthy();
    expect(featureStarted.mock.calls[0][0].trigger).toBe('turns');
  });

  it('is idempotent — multiple signals only create once', () => {
    const store = makeStore();
    const featureStarted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'alice',
      turnId: 't1',
      emit: { featureStarted },
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    arc.observeEvent({ type: 'tool_call', name: 'Grep' });
    arc.observeEvent({ type: 'loop' });
    arc.observeEvent({ type: 'loop' });
    arc.observeEvent({ type: 'loop' });
    expect(store.create).toHaveBeenCalledTimes(1);
    expect(featureStarted).toHaveBeenCalledTimes(1);
  });

  it('every member of KEY_TOOLS fires the signal', () => {
    for (const tool of KEY_TOOLS) {
      const store = makeStore();
      const arc = createFeatureArc({
        adapter: makeAdapter([]),
        model: 'm',
        featureStore: store,
        prompt: 'p',
        vpId: 'a',
        turnId: 't',
      });
      arc.observeEvent({ type: 'tool_call', name: tool });
      expect(arc.getFeatureId(), `key tool ${tool} should fire`).toBeTruthy();
    }
  });

  it('accumulates text_delta into the assistantText buffer', () => {
    const store = makeStore();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    arc.observeEvent({ type: 'text_delta', text: 'hello ' });
    arc.observeEvent({ type: 'text_delta', text: 'world' });
    // No accessor for text directly; we observe the effect via finalize
    // calling the adapter with that text. That branch is exercised in
    // the finalize block below.
    expect(arc.getFeatureId()).toBeTruthy();
  });
});

describe('createFeatureArc — fallback when store is missing or broken', () => {
  it('publishes a synthetic feat-local-<turnId> when no store is wired', () => {
    const featureStarted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: null,
      prompt: 'p',
      vpId: 'a',
      turnId: 't42',
      emit: { featureStarted },
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    expect(arc.getFeatureId()).toBe('feat-local-t42');
    expect(featureStarted).toHaveBeenCalledTimes(1);
  });

  it('publishes a synthetic id when store.create throws', () => {
    const store = {
      create: vi.fn(() => { throw new Error('disk full'); }),
      update: vi.fn(),
    };
    const featureStarted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't9',
      emit: { featureStarted },
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    expect(arc.getFeatureId()).toBe('feat-local-t9');
    expect(featureStarted).toHaveBeenCalledTimes(1);
  });
});

describe('createFeatureArc — finalize', () => {
  it('is a no-op when no feature was ever created', async () => {
    const store = makeStore();
    const featureCompleted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
      emit: { featureCompleted },
    });
    await arc.finalize({ status: 'completed' });
    expect(store.update).not.toHaveBeenCalled();
    expect(featureCompleted).not.toHaveBeenCalled();
  });

  it('runs summary call + writes to store + emits featureCompleted', async () => {
    const store = makeStore();
    const adapter = makeAdapter([[td('Looked at auth.js, found token leak, patched it.')]]);
    const featureCompleted = vi.fn();
    const arc = createFeatureArc({
      adapter,
      model: 'primary/x',
      featureStore: store,
      prompt: 'fix the auth bug',
      vpId: 'alice',
      turnId: 't1',
      emit: { featureCompleted },
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    arc.observeEvent({ type: 'text_delta', text: 'Looked at auth.js…' });
    await arc.finalize({ status: 'completed' });

    expect(adapter.calls.length).toBe(1); // one summary call
    expect(store.update).toHaveBeenCalledTimes(1);
    const [id, update] = store.update.mock.calls[0];
    expect(id).toBe(arc.getFeatureId());
    expect(update.status).toBe('completed');
    expect(update.result).toMatch(/auth\.js/);

    expect(featureCompleted).toHaveBeenCalledTimes(1);
    expect(featureCompleted.mock.calls[0][0]).toMatchObject({
      featureId: arc.getFeatureId(),
      status: 'completed',
    });
    expect(featureCompleted.mock.calls[0][0].summary).toMatch(/auth\.js/);
  });

  it('skips the LLM call on status="aborted" and writes a fixed string', async () => {
    const store = makeStore();
    const adapter = makeAdapter([[td('this should never be consumed')]]);
    const arc = createFeatureArc({
      adapter,
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    await arc.finalize({ status: 'aborted' });
    expect(adapter.calls.length).toBe(0);
    expect(store.update.mock.calls[0][1].status).toBe('aborted');
    expect(store.update.mock.calls[0][1].result).toMatch(/aborted/i);
  });

  it('skips the LLM call on status="error"', async () => {
    const store = makeStore();
    const adapter = makeAdapter([[td('nope')]]);
    const arc = createFeatureArc({
      adapter,
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    await arc.finalize({ status: 'error' });
    expect(adapter.calls.length).toBe(0);
    expect(store.update.mock.calls[0][1].status).toBe('error');
  });

  it('falls back to truncated assistantText when summary call returns empty', async () => {
    const store = makeStore();
    // adapter yields nothing -> runSummaryCall returns ''
    const adapter = makeAdapter([[]]);
    const arc = createFeatureArc({
      adapter,
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    arc.observeEvent({ type: 'text_delta', text: 'Did some work that should appear as fallback summary.' });
    await arc.finalize({ status: 'completed' });
    const update = store.update.mock.calls[0][1];
    expect(update.result).toMatch(/fallback summary/);
  });

  it('is idempotent — second finalize call is a no-op', async () => {
    const store = makeStore();
    const adapter = makeAdapter([[td('summary')], [td('SHOULD NOT CALL')]]);
    const arc = createFeatureArc({
      adapter,
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    // Seed some assistant text so runSummaryCall actually drives the
    // adapter (it short-circuits on empty text). Without this we'd
    // never observe the second-call guard, only the empty-text guard.
    arc.observeEvent({ type: 'text_delta', text: 'I did stuff.' });
    await arc.finalize({ status: 'completed' });
    await arc.finalize({ status: 'completed' });
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(adapter.calls.length).toBe(1);
  });
});

describe('createFeatureArc — startTrackA', () => {
  it('emits quickPreview and fires feature on intent="feature"', async () => {
    const store = makeStore();
    const quickPreview = vi.fn();
    const featureStarted = vi.fn();
    // Track A adapter is the SAME adapter (we reuse it for the summary
    // call too in real code), but for this test we only want to
    // exercise the Track A path. Drop a single JSON response.
    const adapter = makeAdapter([
      [td('{"intent":"feature","preview":"will grep auth"}')],
    ]);
    const arc = createFeatureArc({
      adapter,
      model: 'primary/x',
      featureStore: store,
      prompt: 'investigate auth',
      vpId: 'alice',
      turnId: 't1',
      emit: { quickPreview, featureStarted },
    });
    await arc.startTrackA();
    expect(quickPreview).toHaveBeenCalledWith({ intent: 'feature', preview: 'will grep auth' });
    expect(featureStarted).toHaveBeenCalledTimes(1);
    expect(featureStarted.mock.calls[0][0].trigger).toBe('quick');
    expect(arc.getFeatureId()).toBeTruthy();
    expect(arc.getTrackAResult()).toEqual({ intent: 'feature', preview: 'will grep auth' });
    expect(arc.isTrackADone()).toBe(true);
  });

  it('emits quickPreview but does NOT fire feature on intent="quick"', async () => {
    const store = makeStore();
    const quickPreview = vi.fn();
    const featureStarted = vi.fn();
    const adapter = makeAdapter([
      [td('{"intent":"quick","preview":"sure, here you go"}')],
    ]);
    const arc = createFeatureArc({
      adapter,
      model: 'm',
      featureStore: store,
      prompt: 'hi',
      vpId: 'alice',
      turnId: 't1',
      emit: { quickPreview, featureStarted },
    });
    await arc.startTrackA();
    expect(quickPreview).toHaveBeenCalledTimes(1);
    expect(featureStarted).not.toHaveBeenCalled();
    expect(arc.getFeatureId()).toBeNull();
  });

  it('survives Track A returning null without crashing', async () => {
    const store = makeStore();
    // Adapter throws — runQuickResponse catches it and returns null.
    const adapter = {
      async *stream() {
        const err = new Error('500');
        yield { type: 'error', error: err };
      },
    };
    const arc = createFeatureArc({
      adapter,
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
    });
    await arc.startTrackA();
    expect(arc.getFeatureId()).toBeNull();
    expect(arc.isTrackADone()).toBe(true);
  });
});

describe('createFeatureArc — race + correctness regressions', () => {
  it('post-finalize maybeCreateFeature is a no-op (C1: late Track A race)', async () => {
    // Reproduces the bug where a fire-and-forget Track A resolves
    // AFTER the engine generator has drained and arc.finalize() has
    // already closed (with no featureId). The late `featureStarted`
    // would have arrived after `feature_completed`, leaving the
    // frontend with a dangling-active pill.
    const store = makeStore();
    const featureStarted = vi.fn();
    const featureCompleted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
      emit: { featureStarted, featureCompleted },
    });
    // Engine drained, no signals fired during the turn.
    await arc.finalize({ status: 'completed' });
    expect(featureCompleted).not.toHaveBeenCalled(); // arc never opened
    // Now Track A resolves late and tries to fire the quick signal.
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    expect(arc.getFeatureId()).toBeNull();
    expect(store.create).not.toHaveBeenCalled();
    expect(featureStarted).not.toHaveBeenCalled();
  });

  it('generates non-truncated, distinct ids across calls (C2: collision)', () => {
    // Old code did `slice(0, 8)`. With Date.now() dominating the
    // base-36 prefix, two arcs created in the same ms would collide
    // on the 8-char prefix. Verify ids are at least 16 chars and
    // never collide across many rapid creations.
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const arc = createFeatureArc({
        adapter: makeAdapter([]),
        model: 'm',
        featureStore: makeStore(),
        prompt: 'p',
        vpId: 'a',
        turnId: `t${i}`,
      });
      arc.observeEvent({ type: 'tool_call', name: 'Bash' });
      ids.add(arc.getFeatureId());
    }
    expect(ids.size).toBe(100);
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(16);
    }
  });

  it('does NOT count turn_open toward FEATURE_TURN_THRESHOLD (off-by-one)', () => {
    // The engine emits one `turn_open` per turn (bookkeeping marker)
    // followed by `loop` events for each iteration. Counting both
    // would fire after only 2 real loops instead of 3.
    const store = makeStore();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
    });
    arc.observeEvent({ type: 'turn_open' });
    arc.observeEvent({ type: 'loop' });
    arc.observeEvent({ type: 'loop' });
    expect(arc.getFeatureId()).toBeNull();
    expect(arc.getLoopCount()).toBe(2);
    arc.observeEvent({ type: 'loop' });
    expect(arc.getFeatureId()).toBeTruthy();
    expect(arc.getLoopCount()).toBe(3);
  });

  it('skips featureStore.update for synthetic feat-local-* ids', async () => {
    // When the store throws on create, the arc publishes a synthetic
    // id so the wire path stays consistent. We must NOT then call
    // .update(synthetic, ...) on the same broken store — it would
    // throw on the unknown id (or silently fail), and is wasted work.
    const store = {
      create: vi.fn(() => { throw new Error('create broke'); }),
      update: vi.fn(),
    };
    const featureCompleted = vi.fn();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't42',
      emit: { featureCompleted },
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    arc.observeEvent({ type: 'text_delta', text: 'did stuff' });
    expect(arc.getFeatureId()).toBe('feat-local-t42');
    await arc.finalize({ status: 'aborted' });
    expect(store.update).not.toHaveBeenCalled();
    // But the wire emit still fires so the frontend pill closes.
    expect(featureCompleted).toHaveBeenCalledTimes(1);
  });
});

describe('createFeatureArc — store record shape', () => {
  it('writes a Feature record with status=in_progress and turn metadata', () => {
    const store = makeStore();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'investigate the bug in payment flow',
      vpId: 'alice',
      groupId: 'g1',
      turnId: 't1',
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    expect(store.create).toHaveBeenCalledTimes(1);
    const record = store.create.mock.calls[0][0];
    expect(record.id).toBe(arc.getFeatureId());
    expect(record.status).toBe('in_progress');
    expect(record.priority).toBe('medium');
    expect(record.title).toMatch(/payment flow/);
    expect(record.description).toBe('investigate the bug in payment flow');
    expect(record.groupId).toBe('g1');
    expect(record.members).toEqual(['alice']);
    expect(record.initiator).toBe('alice');
    expect(typeof record.createdAt).toBe('number');
  });

  it('omits group fields when groupId is null', () => {
    const store = makeStore();
    const arc = createFeatureArc({
      adapter: makeAdapter([]),
      model: 'm',
      featureStore: store,
      prompt: 'p',
      vpId: 'a',
      turnId: 't',
      groupId: null,
    });
    arc.observeEvent({ type: 'tool_call', name: 'Bash' });
    const record = store.create.mock.calls[0][0];
    expect(record.groupId).toBeUndefined();
    expect(record.members).toBeUndefined();
  });
});
