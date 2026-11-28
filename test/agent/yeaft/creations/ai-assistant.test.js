import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../../../agent/yeaft/config.js';
import { createLLMAdapter } from '../../../../agent/yeaft/llm/adapter.js';
import { AdapterRouter } from '../../../../agent/yeaft/llm/router.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREATION_CATEGORIES, createCreationAiAssistant, createCreationService, MAX_CONCURRENT_JOBS, QUICK_EDIT_PRESETS, QUICK_EDIT_PRESETS_BY_CATEGORY,
  REVIEW_LENSES, REVIEW_LENSES_BY_CATEGORY, resolveReviewLenses } from '../../../../agent/yeaft/creations/index.js';

vi.mock('../../../../agent/yeaft/config.js', async importOriginal => ({ ...await importOriginal(), loadConfig: vi.fn() }));
vi.mock('../../../../agent/yeaft/llm/adapter.js', async importOriginal => ({ ...await importOriginal(), createLLMAdapter: vi.fn() }));

let assistant, service, dir;
afterEach(async () => {
  await assistant?.close();
  await service?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  assistant = service = dir = undefined;
  vi.restoreAllMocks();
});
const errorCode = code => expect.objectContaining({ code });
const hash = text => createHash('sha256').update(text).digest('hex');
const json = (summary = '', annotations = []) => ({ text: JSON.stringify({ summary, annotations }) });
const editing = { selectedText: 'A cat.', preset: 'polish' };
const create = (adapter, store) => {
  const events = [];
  const adapterFactory = vi.fn(async () => ({ adapter, model: 'default-model' }));
  assistant = createCreationAiAssistant({ adapterFactory, store, emitEvent: event => events.push(event) });
  return { events, adapterFactory };
};

const createServiceWithProvider = call => {
  dir = mkdtempSync(join(tmpdir(), 'yeaft-ai-review-'));
  const events = [];
  service = createCreationService({ yeaftDir: join(dir, 'agent-data'), adapterFactory: async () => ({ adapter: { call } }), emitEvent: event => events.push(event) });
  assistant = service.aiAssistant;
  const { store } = service;
  const creationId = store.createCreation({ id: 'reviewed' }).id;
  return { store, creationId, events, review: { creationId, filePath: 'docs/ch1.md', content: 'Draft.', lensIds: ['chief_editor'] } };
};

describe('Creation AI assistant', () => {
  it('resolves category defaults, localized labels, and custom lenses with a validated cap', () => {
    expect(Object.keys(REVIEW_LENSES)).toHaveLength(18);
    for (const category of CREATION_CATEGORIES) {
      expect(QUICK_EDIT_PRESETS_BY_CATEGORY[category].every(id => Object.hasOwn(QUICK_EDIT_PRESETS, id))).toBe(true);
      expect(resolveReviewLenses(category, [], '  ', 'zh-CN').map(({ id, label, labelZh }) => [id, label === labelZh]))
        .toEqual(REVIEW_LENSES_BY_CATEGORY[category].map(id => [id, true]));
    }
    expect(resolveReviewLenses('book', undefined, '  Review dates  ', 'en')).toMatchObject([{ id: 'custom', customPrompt: 'Review dates' }]);
    expect(resolveReviewLenses('book', ['storyline', 'storyline'], 'focus').map(lens => lens.id)).toEqual(['storyline', 'custom']);
    expect(() => resolveReviewLenses('book', ['constructor'])).toThrow(errorCode('INVALID_REQUEST'));
    expect(() => resolveReviewLenses('book', Object.keys(REVIEW_LENSES).slice(0, 6), 'focus')).toThrow(errorCode('INVALID_REQUEST'));
  });

  it('acks before streaming; uses only the supplied text, chooses the matching context, and returns reconstructable diff hunks', async () => {
    const captureStream = vi.fn(async function* () {
      yield { type: 'thinking_delta', text: 'not visible' };
      yield { type: 'text_delta', text: '```md\nA ' };
      yield { type: 'text_delta', text: 'dog.\r\nNext\n```' };
      yield { type: 'stop', stopReason: 'end_turn' };
    });
    const stream = vi.fn();
    const store = { getCreation: vi.fn(() => ({ category: 'article' })) };
    const { events, adapterFactory } = create({ captureStream, stream }, store);
    const payload = { ...editing, selectedText: 'A cat.\r\nNext', creationId: 'made', filePath: 'notes/chapter.md',
      lineStart: 4, fullContent: 'A cat.\r\nNext\r\nRight before\r\nA cat.\r\nNext\r\nRight after', model: 'picked', effort: 'low' };
    const ack = assistant.startInlineEdit(payload, { targetClientId: 'tab-1' });
    expect(ack).toEqual({ jobId: expect.any(String), status: 'running' });
    expect(assistant.hasActiveWork()).toBe(true);
    expect(adapterFactory).not.toHaveBeenCalled();
    payload.selectedText = 'later mutation';
    const result = await assistant.waitForJob(ack.jobId);
    expect(stream).not.toHaveBeenCalled();
    const [params] = captureStream.mock.calls[0];
    expect(params).toMatchObject({ model: 'picked', effort: 'low', tools: [], system: expect.stringContaining('Return ONLY the revised replacement text') });
    expect(JSON.parse(params.messages[0].content)).toMatchObject({ fileName: 'chapter.md', selectedText: 'A cat.\r\nNext',
      beforeContext: expect.stringMatching(/Right before\r\n$/), afterContext: '\r\nRight after' });
    expect(store.getCreation).toHaveBeenCalledWith('made');
    expect(result).toMatchObject({ status: 'completed', originalText: 'A cat.\r\nNext', revisedText: 'A dog.\r\nNext' });
    expect(result.diffHunks).toEqual([{ type: 'equal', text: 'A ' }, { type: 'del', text: 'cat' }, { type: 'add', text: 'dog' }, { type: 'equal', text: '.\r\nNext' }]);
    expect(events.map(event => event.type)).toEqual(['inline_edit_delta', 'inline_edit_delta', 'inline_edit_complete']);
    expect(events.every(event => event._targetClientId === 'tab-1' && event.jobId === ack.jobId && event.filePath === 'notes/chapter.md')).toBe(true);
    expect(assistant.hasActiveWork()).toBe(false);
  });

  it.each([
    ['```js\nold\n```', '```js\nnew\n```', '```js\nnew\n```'],
    ['old', 'Before\n```\nnew\n```', 'Before\n```\nnew\n```'],
    ['old', '```md\n  new  \n\n```', '  new  \n'],
    ['old', '```md\nnew```', '```md\nnew```'],
  ])('handles fences without discarding replacement whitespace (%j)', async (selectedText, text, revisedText) => {
    const call = vi.fn(async () => ({ text }));
    create({ call });
    const { jobId } = assistant.startInlineEdit({ selectedText, instruction: 'Replace old with new' });
    const result = await assistant.waitForJob(jobId);
    expect(result.revisedText).toBe(revisedText);
    expect(result.diffHunks.filter(h => h.type !== 'del').map(h => h.text).join('')).toBe(revisedText);
    expect(result.diffHunks.filter(h => h.type !== 'add').map(h => h.text).join('')).toBe(selectedText);
    expect(call.mock.calls[0][0]).toMatchObject({ tools: [], model: 'default-model' });
  });

  it('validates input synchronously before invoking the provider', () => {
    const { adapterFactory } = create({}, { getCreation: () => null });
    for (const input of [{ selectedText: '' }, { selectedText: '🌟'.repeat(8193) }, { fullContent: 'x'.repeat(262145) },
      { preset: 'toString' }, { preset: undefined, instruction: '   ' }, { instruction: 'x'.repeat(4097) }, { lineStart: 4, lineEnd: 3 },
      { model: [] }, { effort: 2 }, { locale: 'xx' }, { filePath: '../private' }, { category: 'bad' }]) {
      expect(() => assistant.startInlineEdit({ ...editing, ...input })).toThrow(errorCode('INVALID_REQUEST'));
    }
    expect(() => assistant.startInlineEdit({ ...editing, creationId: 'missing' })).toThrow(errorCode('NOT_FOUND'));
    for (const input of [{ scope: 'bad' }, { content: '' }, { scope: 'selection' }, { selectedText: 4 }, { lensIds: 'chief_editor' },
      { lensIds: new Array(7).fill('chief_editor') }, { customPrompt: 'x'.repeat(2049) }]) {
      expect(() => assistant.startReview({ content: 'available', ...input })).toThrow(errorCode('INVALID_REQUEST'));
    }
    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it('bounds jobs, prevents cross-tab cancellation, and closes even when the provider ignores abort', async () => {
    const call = vi.fn(() => new Promise(() => {}));
    const { events } = create({ call });
    const jobs = Array.from({ length: MAX_CONCURRENT_JOBS }, () => assistant.startInlineEdit(editing, { targetClientId: 'owner-tab' }).jobId);
    const waits = jobs.map(assistant.waitForJob);
    expect(() => assistant.startReview({ content: 'blocked' })).toThrow(errorCode('BUSY'));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(MAX_CONCURRENT_JOBS));
    expect(() => assistant.cancelJob(jobs[0], { targetClientId: 'other-tab' })).toThrow(errorCode('NOT_FOUND'));
    expect(assistant.cancelJob(jobs[0], { targetClientId: 'owner-tab' })).toEqual({ jobId: jobs[0], cancelled: true });
    expect(assistant.cancelJob(jobs[0], { targetClientId: 'owner-tab' }).cancelled).toBe(false);
    await assistant.close();
    expect((await Promise.all(waits)).every(job => job.status === 'cancelled')).toBe(true);
    expect(call.mock.calls.every(([params]) => params.signal.aborted)).toBe(true);
    expect(events).toHaveLength(MAX_CONCURRENT_JOBS);
    expect(assistant.hasActiveWork()).toBe(false);
    expect(() => assistant.startInlineEdit(editing)).toThrow(errorCode('INVALID_STATE'));
  });

  it('reviews concurrently, starts queued work on the first free slot, and keeps independent partial results in input order', async () => {
    const pending = [];
    const call = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    const { events } = create({ call });
    const lensIds = [...REVIEW_LENSES_BY_CATEGORY.book, ...REVIEW_LENSES_BY_CATEGORY.article];
    const { jobId, lenses } = assistant.startReview({ content: 'first\nsecond\nthird', lensIds, locale: 'zh-CN' }, { targetClientId: 'tab' });
    expect(lenses.map(lens => lens.label)).toEqual(lensIds.map(id => REVIEW_LENSES[id].labelZh));
    const done = assistant.waitForJob(jobId);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[1]({ text: 'not review JSON' });
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    expect(events[0]).toMatchObject({ type: 'review_lens_complete', lensId: lensIds[1], status: 'failed' });
    pending[4](json('fifth', [{ severity: 'blocker', quote: 'second', lineStart: 99 }, { quote: 'invented text' }]));
    await vi.waitFor(() => expect(pending).toHaveLength(6));
    pending[5](json('sixth', [{ severity: 'praise', quote: 'third' }]));
    pending[3](json('fourth', [{ severity: 'unknown', quote: 'first' }]));
    pending[2](json('third lens'));
    pending[0]({ text: 'Prose {example}\n```json\n{"summary":"first lens {fine}","annotations":[]}\n```' });
    const result = await done;
    expect(result.status).toBe('partial');
    expect(result.lensResults.map(lens => lens.lensId)).toEqual(lensIds);
    expect(result.annotations.map(({ severity, lineStart }) => [severity, lineStart])).toEqual([['blocker', 2], ['suggestion', 1], ['praise', 3]]);
    expect(result.annotations[0]).toMatchObject({ id: `${jobId}:${lensIds[4]}:0`, lineEnd: 2, status: 'open', quote: 'second' });
    expect(result.overallSummary).toContain('first lens {fine}');
    expect(call.mock.calls[0][0]).toMatchObject({ tools: [], system: expect.stringContaining('zh-CN') });
    expect(events.at(-1)).toMatchObject({ type: 'review_complete', _targetClientId: 'tab', status: 'partial' });
  });

  it('anchors selection quotes at absolute lines and never saves selection reviews', async () => {
    const selectedText = 'Repeat\r\nMid\r\nRepeat\r\nEnd';
    const call = vi.fn(async () => json('selection', [
      { quote: 'Repeat\nEnd', lineStart: 1 }, { quote: 'Repeat', lineStart: 12, lineEnd: 99 },
      ...Array.from({ length: 14 }, () => ({ quote: 'Mid' })),
    ]));
    const store = { getCreation: () => ({ kind: 'gallery' }), saveDocReview: vi.fn() };
    create({ call }, store);
    const ack = assistant.startReview({ creationId: 'c', filePath: 'file.txt', scope: 'selection', selectedText, lineStart: 10, customPrompt: 'Review repeats' });
    expect(ack).toMatchObject({ category: 'media', scope: 'selection', lenses: [{ id: 'custom' }] });
    const result = await assistant.waitForJob(ack.jobId);
    expect(call.mock.calls[0][0].messages[0].content).toContain('10: Repeat\n11: Mid\n12: Repeat\n13: End');
    expect(result.contentHash).toBe(hash(selectedText));
    expect(result.annotations).toHaveLength(12);
    expect(result.annotations.slice(-2)).toMatchObject([{ quote: 'Repeat\r\nEnd', lineStart: 12, lineEnd: 13 }, { quote: 'Repeat', lineStart: 12, lineEnd: 12 }]);
    expect(store.saveDocReview).not.toHaveBeenCalled();
  });

  it('marks truncation without exposing an unseen suffix or splitting a surrogate pair', async () => {
    const content = `start\n${'x'.repeat(47993)}🌟\nunseen suffix`;
    const call = vi.fn(async () => json('truncated', [{ quote: 'unseen suffix' }, { quote: 'start' }]));
    const { events, store, creationId } = createServiceWithProvider(call);
    const { jobId } = assistant.startReview({ creationId, filePath: 'doc.md', content, lensIds: ['chief_editor'] });
    const result = await assistant.waitForJob(jobId);
    const prompt = call.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('1: start\n2: xxx');
    expect(prompt).toContain('[Document truncated;');
    expect(prompt).not.toContain('unseen suffix');
    expect(prompt.isWellFormed()).toBe(true);
    expect(result).toMatchObject({ contentHash: hash(content), truncated: true, reviewedLines: { start: 1, end: 2 } });
    expect(events.at(-1)).toMatchObject({ type: 'review_complete', truncated: true, reviewedLines: { start: 1, end: 2 } });
    expect(result.annotations).toMatchObject([{ quote: 'start', lineStart: 1 }]);
    expect(store.getDocReview(creationId, 'doc.md')).toEqual(result);
  });

  it('times out a single lens without aborting its peers, and fails when every lens fails', async () => {
    const timers = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      if (ms === 60_000) timers.push(controller);
      return controller.signal;
    });
    const pending = [];
    const call = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    create({ call });
    const first = assistant.startReview({ content: 'lines', lensIds: ['chief_editor', 'reader_hook'] });
    const firstDone = assistant.waitForJob(first.jobId);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    timers[0].abort(new DOMException('timeout', 'TimeoutError'));
    pending[1](json('finished'));
    expect(await firstDone).toMatchObject({ status: 'partial', lensResults: [
      { status: 'failed', error: 'Model request timed out' }, { status: 'completed', summary: 'finished' },
    ] });
    const second = assistant.startReview({ content: 'lines', lensIds: ['chief_editor', 'reader_hook'] });
    const secondDone = assistant.waitForJob(second.jobId);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[2]({ text: '{"summary":{}}' });
    pending[3]({ text: 'not JSON' });
    expect(await secondDone).toMatchObject({ status: 'failed', annotations: [] });
  });

  it('settles a review on the overall timeout without persisting or waiting for the provider', async () => {
    const overall = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 90_000 ? overall.signal : new AbortController().signal);
    const call = vi.fn(() => new Promise(() => {}));
    const store = { getCreation: () => ({ kind: 'book' }), saveDocReview: vi.fn() };
    const { events } = create({ call }, store);
    const { jobId } = assistant.startReview({ creationId: 'c', filePath: 'doc.md', content: 'content' });
    const done = assistant.waitForJob(jobId);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    overall.abort(new DOMException('timeout', 'TimeoutError'));
    expect(await done).toMatchObject({ status: 'failed', error: 'Model request timed out' });
    expect(events.filter(event => event.type === 'review_lens_complete')).toMatchObject(Array.from({ length: 3 }, () => ({ status: 'failed', error: 'Model request timed out' })));
    expect(store.saveDocReview).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer review when the older provider finishes last', async () => {
    const pending = [];
    const { store, creationId, events, review } = createServiceWithProvider(() => new Promise(resolve => pending.push(resolve)));
    const list = vi.spyOn(store, 'listDocStates');
    const first = assistant.startReview(review);
    const firstDone = assistant.waitForJob(first.jobId);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = assistant.startReview(review);
    const secondDone = assistant.waitForJob(second.jobId);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1](json('newer'));
    const newer = await secondDone;
    pending[0](json('older'));
    expect(await firstDone).toMatchObject({ superseded: true });
    expect(store.getDocReview(creationId, review.filePath)).toEqual(newer);
    expect(events.filter(event => event.type.startsWith('doc_')).map(event => event.type)).toEqual(['doc_review_updated', 'doc_state_updated']);
    expect(events.at(-1)).toMatchObject({ type: 'review_complete', jobId: first.jobId, superseded: true });
    expect(list).not.toHaveBeenCalled();
  });

  it('rejects a late review even when the deleted Creation ID is reused', async () => {
    let finish;
    const { store, creationId, events, review } = createServiceWithProvider(() => new Promise(resolve => { finish = resolve; }));
    const old = store.getCreation(creationId);
    const { jobId } = assistant.startReview(review);
    const done = assistant.waitForJob(jobId);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    // Bypass service cancellation to exercise the persistence fence itself.
    store.deleteCreation(creationId);
    const recreated = store.createCreation({ id: creationId, incarnation: old.incarnation });
    expect(recreated.incarnation).not.toBe(old.incarnation);
    finish(json('stale'));
    expect(await done).toMatchObject({ superseded: true });
    expect(store.getDocReview(creationId, review.filePath)).toBeNull();
    expect(events.some(event => event.type.startsWith('doc_'))).toBe(false);
  });

  it.each(['delete_creation', 'update_creation', 'ensure_workspace'])('cancels active Creation AI jobs on %s', async op => {
    const call = vi.fn(() => new Promise(() => {}));
    const { store, creationId, events, review } = createServiceWithProvider(call);
    expect(store.getCreation(creationId).rootDir).toBeNull();
    const done = [assistant.startReview(review), assistant.startInlineEdit({ ...editing, creationId })]
      .map(({ jobId }) => assistant.waitForJob(jobId));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    const rootDir = join(dir, 'workspace');
    mkdirSync(rootDir);
    service.request({ op, payload: { creationId, ...(op !== 'delete_creation' ? { rootDir } : {}) } });
    expect(await Promise.all(done)).toMatchObject([{ status: 'cancelled' }, { status: 'cancelled' }]);
    if (op !== 'delete_creation') {
      expect(store.getCreation(creationId).rootDir).toBe(rootDir);
      expect(store.getDocReview(creationId, review.filePath)).toBeNull();
    }
    expect(call.mock.calls.every(([params]) => params.signal.aborted)).toBe(true);
    expect(events.some(event => event.type.startsWith('doc_'))).toBe(false);
  });

  it('cancels all jobs belonging to exactly the revoked client', async () => {
    const call = vi.fn(() => new Promise(() => {}));
    create({ call });
    const done = [assistant.startInlineEdit(editing, { targetClientId: 'revoked' }),
      assistant.startReview({ content: 'text', lensIds: ['chief_editor'] }, { targetClientId: 'revoked' }),
      assistant.startInlineEdit(editing, { targetClientId: 'peer' })].map(({ jobId }) => assistant.waitForJob(jobId));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(assistant.cancelClientJobs('revoked')).toEqual({ cancelledCount: 2 });
    expect(assistant.cancelClientJobs('revoked')).toEqual({ cancelledCount: 0 });
    expect(await Promise.all(done.slice(0, 2))).toMatchObject([{ status: 'cancelled' }, { status: 'cancelled' }]);
    expect(assistant.hasActiveWork()).toBe(true);
    expect(assistant.cancelClientJobs('peer')).toEqual({ cancelledCount: 1 });
    expect(await done[2]).toMatchObject({ status: 'cancelled' });
  });

  it('fences late-decoded starts after a client cancellation, before calling the provider or writing SQLite', () => {
    const call = vi.fn();
    const { store, creationId, events, review } = createServiceWithProvider(call);
    const allocate = vi.spyOn(store, 'beginDocReviewAttempt');
    const meta = { targetClientId: 'revoked' };
    expect(assistant.cancelClientJobs(meta.targetClientId)).toEqual({ cancelledCount: 0 });
    expect(() => assistant.startReview(review, meta)).toThrow(errorCode('STALE'));
    expect(() => assistant.startInlineEdit({ ...editing, creationId }, meta)).toThrow('Client connection was cancelled');
    expect(assistant.hasActiveWork()).toBe(false);
    expect(allocate).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(store.getDocReview(creationId, review.filePath)).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('expires client tombstones and evicts the oldest at capacity', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    create({ call: vi.fn() });
    assistant.cancelClientJobs('oldest');
    for (let i = 0; i < 1024; i++) assistant.cancelClientJobs(`tab-${i}`);
    expect(assistant.startInlineEdit(editing, { targetClientId: 'oldest' }).status).toBe('running');
    clock.mockReturnValue(5 * 60_000 - 1);
    expect(() => assistant.startInlineEdit(editing, { targetClientId: 'tab-0' })).toThrow(errorCode('STALE'));
    clock.mockReturnValue(5 * 60_000);
    expect(assistant.startInlineEdit(editing, { targetClientId: 'tab-0' }).status).toBe('running');
  });

  it('does not offer partial replacements when the serialized suggestion is over budget', async () => {
    const comment = 'Keep this comment';
    const call = vi.fn(async () => json('findings', [
      { quote: 'Draft.', comment, suggestedReplacement: '\n'.repeat(512) },
      { quote: 'Draft.', comment, suggestedReplacement: 'x'.repeat(1022) },
    ]));
    const { review } = createServiceWithProvider(call);
    const { jobId } = assistant.startReview(review);
    expect(await assistant.waitForJob(jobId)).toMatchObject({ annotations: [
      { quote: 'Draft.', comment, suggestedReplacement: '' },
      { quote: 'Draft.', comment, suggestedReplacement: 'x'.repeat(1022) },
    ] });
  });

  it('checks the workspace snapshot at commit even if binding bypasses local cancellation', async () => {
    let finish;
    const { store, creationId, events, review } = createServiceWithProvider(() => new Promise(resolve => { finish = resolve; }));
    const { jobId } = assistant.startReview(review);
    const done = assistant.waitForJob(jobId);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const rootDir = join(dir, 'workspace');
    mkdirSync(rootDir);
    expect(store.ensureWorkspace(creationId, { rootDir }).creation.rootDir).toBe(rootDir);
    finish(json('stale'));
    expect(await done).toMatchObject({ superseded: true });
    expect(store.getDocReview(creationId, review.filePath)).toBeNull();
    expect(events.some(event => event.type.startsWith('doc_'))).toBe(false);
  });

  it.each([
    [undefined, undefined, undefined, 8192], [32000, undefined, undefined, 8192],
    [1200, undefined, undefined, 1200], [125, undefined, undefined, 125],
    [16000, 2048, 'provider/picked', 2048], [1024, 2048, 'provider/picked', 1024],
  ])('enforces the provider output budget (config=%s, model limit=%s, selected=%s)', async (maxOutputTokens, maxOutput, model, expected) => {
    const call = vi.fn().mockResolvedValue({ text: 'edited' });
    createLLMAdapter.mockResolvedValueOnce({ call });
    loadConfig.mockReturnValueOnce({ model: 'default-model', maxOutputTokens,
      availableModels: [{ ref: 'other/picked', id: 'picked', maxOutput: 512 }, { ref: 'provider/picked', id: 'picked', maxOutput }] });
    assistant = createCreationAiAssistant();
    const { jobId } = assistant.startInlineEdit({ ...editing, model, effort: 'high' });
    expect(await assistant.waitForJob(jobId)).toMatchObject({ status: 'completed' });
    const [[params]] = call.mock.calls;
    expect(params).toMatchObject({ model: model ?? 'default-model', maxTokens: expected });
    if (expected < 1024) {
      expect(params).not.toHaveProperty('effort');
      expect(params).not.toHaveProperty('effortSource');
    } else expect(params).toMatchObject({ effort: 'high', effortSource: 'user' });
  });

  it.each([
    [2048, 'max', undefined],
    [2048, 'medium', 1024],
    [2048, undefined, undefined],
  ])('keeps serialized Anthropic max_tokens at %s (explicit effort: %s)', async (maxOutputTokens, effort, budget) => {
    const model = 'gateway/custom-model';
    const adapter = new AdapterRouter({ providers: [{ name: 'gateway', protocol: 'anthropic',
      baseUrl: 'https://anthropic.example', apiKey: 'test-key', models: [
        { id: 'custom-model', thinkingProtocol: 'anthropic', maxBudgetTokens: effort === 'medium' ? 1024 : 8192 },
      ] }] });
    createLLMAdapter.mockResolvedValueOnce(adapter);
    loadConfig.mockReturnValueOnce({ model, maxOutputTokens });
    const sse = [
      { type: 'message_start', message: { id: 'msg_1', model: 'custom-model', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'edited' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }));
    assistant = createCreationAiAssistant();
    const { jobId } = assistant.startInlineEdit({ ...editing, effort });
    expect(await assistant.waitForJob(jobId)).toMatchObject({ status: 'completed', revisedText: 'edited' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'custom-model', max_tokens: maxOutputTokens });
    if (budget === undefined) expect(body).not.toHaveProperty('thinking');
    else expect(body.thinking).toMatchObject({ type: 'enabled', budget_tokens: budget });
  });

  it('allows standalone FilesTab canvas requests with empty creationId and absolute paths while still rejecting traversal', async () => {
    const call = vi.fn().mockResolvedValue({ text: 'Polished line.' });
    create({ call });
    const { jobId } = assistant.startInlineEdit({
      creationId: '',
      filePath: 'C:\\repo\\docs\\readme.md',
      selectedText: 'Draft line.',
      preset: 'polish',
    });
    const result = await assistant.waitForJob(jobId);
    expect(result).toMatchObject({ status: 'completed', revisedText: 'Polished line.' });
    expect(() => assistant.startInlineEdit({
      creationId: '',
      filePath: 'C:\\repo\\..\\secret.md',
      selectedText: 'Draft line.',
      preset: 'polish',
    })).toThrow(errorCode('INVALID_REQUEST'));
  });
});
