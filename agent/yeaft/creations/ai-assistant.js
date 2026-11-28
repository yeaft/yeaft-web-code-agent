import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { boundedText, fail, safeId } from './constants.js';
import { normalizeDocFilePath } from './store.js';
import { buildInlineEditPrompts, buildReviewPrompts, inferCategoryFromKind, normalizeCategory, QUICK_EDIT_PRESETS, resolveReviewLenses } from './categories.js';
import { parseDecisionJsonObject } from '../decision/prompts/shared.js';

export const MAX_CONCURRENT_JOBS = 6;
const MAX_LENS_CONCURRENCY = 4;
const MODEL_TIMEOUT_MS = 60_000;
const REVIEW_TIMEOUT_MS = 90_000;
const MAX_DOCUMENT_CHARS = 48_000;
const MAX_SELECTION_BYTES = 32 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_OUTPUT_TOKENS = 8192;
const CANCELLED_CLIENT_TTL_MS = 5 * 60_000;
const MAX_CANCELLED_CLIENTS = 1024;
const SEVERITIES = ['blocker', 'suggestion', 'praise'];

async function defaultAdapterFactory({ yeaftDir }) {
  const [{ loadConfig }, { createLLMAdapter }] = await Promise.all([import('../config.js'), import('../llm/adapter.js')]);
  const config = loadConfig({ dir: yeaftDir });
  const catalog = config.availableModels ?? [];
  const maxOutputFor = model => {
    const entry = catalog.find(entry => entry.ref === model) ?? catalog.find(entry => entry.id === model);
    const limit = value => Number.isFinite(value) && value > 0 ? value : MAX_OUTPUT_TOKENS;
    return Math.min(limit(config.maxOutputTokens), limit(entry?.maxOutput));
  };
  return { adapter: await createLLMAdapter(config), model: config.model, maxOutputFor };
}

const optionalText = (value, limit, name, options) => value == null ? undefined : boundedText(value, limit, name, options);
const optionalLine = (value, name) => {
  if (value == null) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) fail('INVALID_REQUEST', `Invalid ${name}`);
  return value;
};

function commonOptions(payload, store) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('INVALID_REQUEST', 'Invalid creation AI payload');
  const rawCreationId = payload.creationId === '' ? undefined : payload.creationId;
  const creationId = rawCreationId == null ? undefined : safeId(rawCreationId);
  const creation = creationId === undefined ? undefined : store.getCreation(creationId);
  if (creationId !== undefined && !creation) fail('NOT_FOUND', 'Creation not found');
  const category = normalizeCategory(payload.category == null || payload.category === ''
    ? creation?.category ?? inferCategoryFromKind(creation?.kind) : payload.category);
  const rawFilePath = payload.filePath === '' ? undefined : payload.filePath;
  let filePath;
  if (rawFilePath != null) {
    if (creationId !== undefined) {
      filePath = normalizeDocFilePath(rawFilePath);
    } else {
      boundedText(rawFilePath, 1024, 'document file path', { required: true });
      if (!rawFilePath.isWellFormed() || /\p{Cc}/u.test(rawFilePath)) fail('INVALID_REQUEST', 'Invalid document file path');
      const normalized = rawFilePath.trim().replaceAll('\\', '/');
      if (normalized.split('/').some(segment => segment === '.' || segment === '..')) {
        fail('INVALID_REQUEST', 'Invalid document file path');
      }
      filePath = normalized;
    }
  }
  const fileName = optionalText(payload.fileName === '' ? undefined : payload.fileName, 1024, 'file name') ?? filePath?.split(/[\\/]/).at(-1);
  const lineStart = optionalLine(payload.lineStart, 'start line');
  const lineEnd = optionalLine(payload.lineEnd, 'end line');
  if (lineEnd !== undefined && lineEnd < (lineStart ?? 1)) fail('INVALID_REQUEST', 'Invalid line range');
  const locale = optionalText(payload.locale === '' ? undefined : payload.locale, 32, 'locale', { required: true });
  if (locale !== undefined && !['zh-CN', 'en'].includes(locale)) fail('INVALID_REQUEST', 'Invalid locale');
  return { creationId, expectedIncarnation: creation?.incarnation ?? creation?.createdAt, expectedRootDir: creation?.rootDir ?? null,
    category, filePath, fileName, lineStart, lineEnd, locale,
    model: optionalText(payload.model === '' ? undefined : payload.model, 512, 'model', { required: true }),
    effort: optionalText(payload.effort === '' ? undefined : payload.effort, 32, 'effort', { required: true }) };
}

const splitLines = text => text.split(/\r\n|\n|\r/);
const safePrefix = (text, max) => text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
const safeSuffix = (text, max) => text.length <= max ? text : text.slice(-max).replace(/^[\uDC00-\uDFFF]/, '');

function lineNumberAt(starts, offset) {
  let lo = 0, hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid;
  }
  return lo;
}

function lineOffsets(text) {
  return [0, ...Array.from(text.matchAll(/\r\n|\n|\r/g), match => match.index + match[0].length)];
}

function inlineContext(content, selection, startLine) {
  if (!content) return {};
  const starts = lineOffsets(content);
  const start = starts[startLine - 1];
  const end = starts[startLine] ?? content.length;
  const atLine = start === undefined ? -1 : content.indexOf(selection, start);
  const at = atLine >= 0 && atLine < end ? atLine : content.indexOf(selection);
  if (at < 0 && start === undefined) return {};
  return {
    beforeContext: safeSuffix(content.slice(0, at < 0 ? start : at), 2000),
    afterContext: safePrefix(content.slice(at < 0 ? end : at + selection.length), 2000),
  };
}

function unwrapEdit(text, selection) {
  if (selection.includes('```')) return text;
  const match = /^```[^`\r\n]*\r?\n(?:([\s\S]*?)\r?\n)?```$/.exec(text.trim());
  const body = match?.[1] ?? '';
  return match && !body.includes('```') ? body : text;
}

// Keep exact terminators. Trim equal edges before LCS; bound the matrix even
// for newline-heavy snapshots, using a local replacement for oversized middles.
function diffText(original, revised) {
  const hunks = [];
  const add = (type, text) => {
    if (!text) return;
    if (hunks.at(-1)?.type === type) hunks.at(-1).text += text;
    else hunks.push({ type, text });
  };
  const walk = (a, b, replace) => {
    let start = 0, endA = a.length, endB = b.length;
    while (start < endA && start < endB && a[start] === b[start]) start++;
    add('equal', a.slice(0, start).join(''));
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const width = endB - start + 1;
    const cells = (endA - start + 1) * width;
    if (endA === start || endB === start || cells > 500_000) {
      replace(a.slice(start, endA).join(''), b.slice(start, endB).join(''));
    } else {
      const lcs = new Uint32Array(cells);
      for (let i = endA - 1; i >= start; i--) for (let j = endB - 1; j >= start; j--) {
        const k = (i - start) * width + j - start;
        lcs[k] = a[i] === b[j] ? 1 + lcs[k + width + 1] : Math.max(lcs[k + width], lcs[k + 1]);
      }
      let i = start, j = start, del = '', ins = '';
      while (i < endA || j < endB) {
        const k = (i - start) * width + j - start;
        if (i < endA && j < endB && a[i] === b[j]) {
          replace(del, ins);
          del = ins = '';
          add('equal', a[i++]); j++;
        } else if (i < endA && (j === endB || lcs[k + width] >= lcs[k + 1])) del += a[i++];
        else ins += b[j++];
      }
      replace(del, ins);
    }
    add('equal', a.slice(endA).join(''));
  };
  const lines = value => value.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  walk(lines(original), lines(revised), (a, b) => {
    // Refine changed line blocks to code points so that short inline edits are legible.
    walk(Array.from(a), Array.from(b), (del, ins) => { add('del', del); add('add', ins); });
  });
  return hunks;
}

function createReviewSnapshot(text, start, maxChars) {
  const excerpt = safePrefix(text, maxChars);
  const lines = splitLines(excerpt);
  const numbered = lines.map((line, index) => `${start + index}: ${line}`).join('\n');
  return { text: excerpt, starts: lineOffsets(excerpt), start, end: start + lines.length - 1,
    truncated: excerpt !== text,
    // Hash the full submitted text to distinguish revisions even beyond the reviewable excerpt.
    contentHash: createHash('sha256').update(text).digest('hex'),
    numberedText: excerpt === text ? numbered : `${numbered}\n[Document truncated; remaining text is not in this snapshot.]` };
}

// Budget by serialized size, since the combined review contains annotations both
// in lens order and in severity order and must fit the store's 512 KiB limit.
const jsonSize = value => Buffer.byteLength(JSON.stringify(value));
function compactText(value, max) {
  if (typeof value !== 'string') return '';
  let lo = 0, hi = Math.min(value.length, max);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonSize(value.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return safePrefix(value, lo);
}

function quoteLines(quote, reportedStart, snapshot) {
  const { text, starts, start } = snapshot;
  let offset = text.indexOf(quote);
  if (offset < 0) return null;
  const preferred = Number.isSafeInteger(reportedStart) && reportedStart >= start && reportedStart <= snapshot.end
    ? starts[reportedStart - start] : undefined;
  if (preferred !== undefined) {
    // Disambiguate repeated quotes by distance from the reported line.
    const next = text.indexOf(quote, preferred);
    const previous = text.lastIndexOf(quote, preferred);
    const distance = at => Math.abs(start + lineNumberAt(starts, at) - reportedStart);
    if (next >= 0 && (previous < 0 || distance(next) < distance(previous))) offset = next;
    else if (previous >= 0) offset = previous;
  }
  return { lineStart: start + lineNumberAt(starts, offset),
    lineEnd: start + lineNumberAt(starts, offset + quote.length - 1) };
}

function parseLensResponse(raw, { jobId, lens, snapshot }) {
  const parsed = parseDecisionJsonObject(raw);
  if (typeof parsed?.summary !== 'string' || !Array.isArray(parsed.annotations)) {
    fail('INVALID_MODEL_RESPONSE', 'Reviewer did not return valid review JSON');
  }
  const annotations = parsed.annotations.slice(0, 12).flatMap((annotation, idx) => {
    const quote = annotation?.quote;
    if (typeof quote !== 'string' || !quote.trim() || jsonSize(quote) > 1024) return [];
    // Numbered prompt lines use LF; map a multipart quotation back to the
    // exact CRLF/CR source when the provider uses the prompt's separators.
    const exactQuote = [quote, quote.replaceAll('\n', '\r\n'), quote.replaceAll('\n', '\r')]
      .find(candidate => jsonSize(candidate) <= 1024 && snapshot.text.includes(candidate));
    if (!exactQuote) return [];
    const replacement = annotation.suggestedReplacement;
    return [{ id: `${jobId}:${lens.id}:${idx}`, lensId: lens.id,
      severity: SEVERITIES.includes(annotation.severity) ? annotation.severity : 'suggestion',
      title: compactText(annotation.title, 192), comment: compactText(annotation.comment, 768),
      quote: exactQuote, ...quoteLines(exactQuote, annotation.lineStart, snapshot),
      suggestedReplacement: typeof replacement === 'string' && jsonSize(replacement) <= 1024 ? replacement : '', status: 'open' }];
  });
  return { summary: compactText(parsed.summary, 1024), annotations };
}

// A provider that ignores abort must not keep a job, the bridge, or shutdown alive.
async function abortable(signal, run) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
      Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }),
    ]);
  } finally { signal.removeEventListener('abort', abort); }
}

async function modelText({ adapter, model, maxOutputFor }, options, prompts, signal, onDelta) {
  model = options.model ?? model;
  const resolvedMaxOutput = maxOutputFor?.(model);
  const maxTokens = resolvedMaxOutput > 0 ? Math.min(MAX_OUTPUT_TOKENS, resolvedMaxOutput) : MAX_OUTPUT_TOKENS;
  const params = { model, system: prompts.system, messages: [{ role: 'user', content: prompts.user }],
    tools: [], maxTokens, signal, ...(options.effort && maxTokens >= 1024 ? { effort: options.effort, effortSource: 'user' } : {}) };
  let output = '', bytes = 0;
  const append = delta => {
    signal.throwIfAborted();
    if (typeof delta !== 'string' || !delta) return;
    bytes += Buffer.byteLength(delta);
    if (bytes > 128 * 1024) fail('INVALID_MODEL_RESPONSE', 'Model response exceeded its size limit');
    output += delta;
    onDelta?.(delta);
  };
  const checkStop = reason => {
    if (reason && !['end_turn', 'stop_sequence', 'stop'].includes(reason)) fail('INVALID_MODEL_RESPONSE', 'Model response did not finish normally');
  };
  const stream = await abortable(signal, () => adapter.captureStream?.(params) || adapter.stream?.(params));
  if (!stream) {
    const response = await abortable(signal, () => adapter.call(params));
    checkStop(response?.stopReason);
    const text = typeof response === 'string' ? response : response?.text;
    if (typeof text !== 'string') fail('INVALID_MODEL_RESPONSE', 'Model did not return text');
    append(text);
    return output;
  }
  const iterator = stream[Symbol.asyncIterator]?.() ?? stream[Symbol.iterator]?.();
  let done = false;
  try {
    while (!done) {
      const next = await abortable(signal, () => iterator.next());
      done = next.done;
      if (done) break;
      const event = next.value;
      if (typeof event === 'string') append(event);
      else if (event?.type === 'text_delta') append(event.text ?? event.delta);
      else if (event?.type === 'error') throw new Error('Provider stream failed');
      else if (event?.type === 'tool_call') fail('INVALID_MODEL_RESPONSE', 'Assistant cannot call tools');
      else if (event?.type === 'stop') checkStop(event.stopReason);
    }
    signal.throwIfAborted();
    return output;
  } finally {
    if (!done) {
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* do not wait on provider cleanup */ }
    }
  }
}

const modelError = (error, signal) => signal.aborted
  ? (signal.reason?.name === 'TimeoutError' ? 'Model request timed out' : 'Job cancelled')
  : error?.code === 'INVALID_MODEL_RESPONSE' ? error.message : 'Model request failed';

export function createCreationAiAssistant({ yeaftDir, store, emitEvent = () => {}, adapterFactory = defaultAdapterFactory } = {}) {
  const activeJobs = new Map();
  const cancelledClients = new Map();
  const latestMockReviewAttempt = new Map();
  let closing;
  const publish = event => {
    try { Promise.resolve(emitEvent(event)).catch(() => {}); } catch { /* transport is best effort */ }
  };
  function assertCanStart({ targetClientId, isOriginActive }) {
    const cancelledAt = cancelledClients.get(targetClientId);
    if (cancelledAt !== undefined && Date.now() - cancelledAt < CANCELLED_CLIENT_TTL_MS) {
      fail('STALE', 'Client connection was cancelled');
    }
    if (typeof isOriginActive === 'function' && !isOriginActive()) fail('STALE', 'Agent connection changed');
    if (closing) fail('INVALID_STATE', 'Creation AI assistant is closed');
    if (activeJobs.size >= MAX_CONCURRENT_JOBS) fail('BUSY', 'Too many active creation AI jobs');
  }
  function launch(options, { targetClientId, originSocket, isOriginActive }, work) {
    const jobId = randomUUID();
    const controller = new AbortController();
    const emit = (type, fields) => {
      if (typeof isOriginActive === 'function' && !isOriginActive()) return;
      publish({ type, jobId, creationId: options.creationId, filePath: options.filePath,
        ...fields, ...(targetClientId ? { _targetClientId: targetClientId } : {}) });
    };
    // Defer provider work until after the bridge can acknowledge the job ID.
    const promise = setImmediate().then(() => work({ jobId, signal: controller.signal, emit }))
      .finally(() => activeJobs.delete(jobId));
    activeJobs.set(jobId, { controller, targetClientId, originSocket, isOriginActive, creationId: options.creationId, promise });
    return jobId;
  }
  function cancelMatchingJobs(matches) {
    let cancelledCount = 0;
    for (const job of activeJobs.values()) {
      if (matches(job) && !job.controller.signal.aborted) {
        job.controller.abort();
        cancelledCount++;
      }
    }
    return { cancelledCount };
  }
  return {
    startInlineEdit(payload, meta = {}) {
      assertCanStart(meta);
      const options = commonOptions(payload, store);
      const selectedText = boundedText(payload.selectedText, MAX_SELECTION_BYTES, 'selected text', { required: true });
      const fullContent = optionalText(payload.fullContent, MAX_DOCUMENT_BYTES, 'full content');
      const instruction = optionalText(payload.instruction, 4 * 1024, 'editing instruction');
      const preset = payload.preset;
      if (preset != null && (typeof preset !== 'string' || !Object.hasOwn(QUICK_EDIT_PRESETS, preset))) {
        fail('INVALID_REQUEST', 'Invalid quick edit preset');
      }
      if (preset == null && !instruction?.trim()) fail('INVALID_REQUEST', 'An edit preset or instruction is required');
      const prompts = buildInlineEditPrompts({ ...options, preset, instruction, selectedText,
        ...inlineContext(fullContent, selectedText, options.lineStart ?? 1) });
      const jobId = launch(options, meta, async ({ signal, emit }) => {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]);
        let result;
        try {
          const adapter = await abortable(requestSignal, () => adapterFactory({ yeaftDir }));
          const text = await modelText(adapter, options, prompts, requestSignal, delta => emit('inline_edit_delta', { delta }));
          requestSignal.throwIfAborted();
          const revisedText = unwrapEdit(text, selectedText);
          result = { status: 'completed', originalText: selectedText, revisedText, diffHunks: diffText(selectedText, revisedText) };
        } catch (error) {
          result = { status: signal.aborted ? 'cancelled' : 'failed', originalText: selectedText,
            revisedText: '', diffHunks: [], error: modelError(error, requestSignal) };
        }
        emit('inline_edit_complete', result);
        return result;
      });
      return { jobId, status: 'running' };
    },
    startReview(payload, meta = {}) {
      assertCanStart(meta);
      const options = commonOptions(payload, store);
      const { creationId, expectedIncarnation, expectedRootDir, filePath, category, locale } = options;
      const { isOriginActive } = meta;
      const scope = payload.scope ?? 'document';
      if (!['document', 'selection'].includes(scope)) fail('INVALID_REQUEST', 'Invalid review scope');
      const content = scope === 'document' ? boundedText(payload.content, MAX_DOCUMENT_BYTES, 'document content', { required: true })
        : optionalText(payload.content, MAX_DOCUMENT_BYTES, 'document content');
      const selection = scope === 'selection' ? boundedText(payload.selectedText, MAX_SELECTION_BYTES, 'selected text', { required: true })
        : optionalText(payload.selectedText, MAX_SELECTION_BYTES, 'selected text');
      const customPrompt = optionalText(payload.customPrompt, 2 * 1024, 'custom review prompt');
      const lenses = resolveReviewLenses(category, payload.lensIds, customPrompt, locale);
      const snapshot = scope === 'selection' ? createReviewSnapshot(selection, options.lineStart ?? 1, selection.length)
        : createReviewSnapshot(content, 1, MAX_DOCUMENT_CHARS);
      const durable = creationId && filePath && scope === 'document';
      const expectedCreation = { expectedIncarnation, expectedRootDir };
      const attemptId = durable ? store.beginDocReviewAttempt?.(creationId, filePath, expectedCreation)?.attemptId : undefined;
      // Minimal mock stores may not implement the SQLite attempt allocator.
      const mockKey = durable && !store.beginDocReviewAttempt ? `${creationId}\0${filePath}` : undefined;
      const mockAttempt = mockKey && Symbol();
      if (mockKey) latestMockReviewAttempt.set(mockKey, mockAttempt);
      const jobId = launch(options, meta, async ({ jobId, signal, emit }) => {
        const overallSignal = AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]);
        let adapter;
        const runLens = async lens => {
          const lensSignal = AbortSignal.any([overallSignal, AbortSignal.timeout(MODEL_TIMEOUT_MS)]);
          const identity = { lensId: lens.id, lensLabel: lens.label };
          let result;
          try {
            // Share the adapter, not any messages or provider response state.
            adapter ??= abortable(overallSignal, () => adapterFactory({ yeaftDir }));
            const configured = await abortable(lensSignal, () => adapter);
            const prompts = buildReviewPrompts({ ...options, lens, scope, numberedText: snapshot.numberedText,
              lineStart: snapshot.start, lineEnd: snapshot.end });
            const text = await modelText(configured, options, prompts, lensSignal);
            lensSignal.throwIfAborted();
            result = { ...identity, status: 'completed', ...parseLensResponse(text, { jobId, lens, snapshot }) };
          } catch (error) {
            result = { ...identity, status: 'failed', summary: '', annotations: [], error: modelError(error, lensSignal) };
          }
          emit('review_lens_complete', result);
          return result;
        };
        // A free worker immediately takes the next lens; one slow lens cannot
        // hold queued lenses behind it. Keep results in the requested order.
        const lensResults = new Array(lenses.length);
        let next = 0;
        await Promise.allSettled(Array.from({ length: Math.min(MAX_LENS_CONCURRENCY, lenses.length) }, async () => {
          while (next < lenses.length) {
            const index = next++;
            lensResults[index] = await runLens(lenses[index]);
          }
        }));
        const succeeded = lensResults.filter(result => result.status === 'completed');
        const status = signal.aborted ? 'cancelled' : !succeeded.length ? 'failed' : succeeded.length < lenses.length ? 'partial' : 'completed';
        const overallSummary = succeeded.filter(result => result.summary).map(result => `${result.lensLabel}: ${result.summary}`).join('\n\n');
        const annotations = succeeded.flatMap(result => result.annotations).sort((a, b) =>
          SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.lineStart - b.lineStart);
        const failureError = status === 'failed'
          ? (overallSignal.aborted ? 'Model request timed out' : (lensResults.find(result => result.error)?.error || 'Review failed'))
          : undefined;
        const review = { jobId, creationId, filePath, scope, category, contentHash: snapshot.contentHash, status, overallSummary, lensResults, annotations,
          truncated: snapshot.truncated, reviewedLines: { start: snapshot.start, end: snapshot.end },
          ...(failureError ? { error: failureError } : {}) };
        if (durable && ['completed', 'partial'].includes(status)) {
          try {
            const persist = () => {
              if (signal.aborted || (typeof isOriginActive === 'function' && !isOriginActive())) return null;
              if (mockKey && latestMockReviewAttempt.get(mockKey) !== mockAttempt) {
                fail('STALE', 'Document review was superseded by a newer review');
              }
              const saved = store.saveDocReview(creationId, filePath, review, { ...expectedCreation, attemptId });
              const current = store.getDocState(creationId, filePath);
              const state = !current || current.status === 'draft' ? store.setDocState(creationId, filePath, 'review') : null;
              return { saved, state };
            };
            const committed = store.transaction ? store.transaction(persist) : persist();
            if (!committed) review.status = 'cancelled';
            else {
              publish({ type: 'doc_review_updated', creationId, filePath, review: committed.saved });
              if (committed.state) publish({ type: 'doc_state_updated', creationId, ...committed.state });
            }
          } catch (error) {
            if (error?.code === 'STALE' || error?.code === 'NOT_FOUND') review.superseded = true;
            else {
              review.status = 'failed';
              review.error = 'Could not save document review';
            }
          }
        }
        if (mockKey && latestMockReviewAttempt.get(mockKey) === mockAttempt) latestMockReviewAttempt.delete(mockKey);
        emit('review_complete', review);
        return review;
      });
      return { jobId, status: 'running', scope, category, lenses: lenses.map(({ id, label }) => ({ id, label })) };
    },
    cancelJob(jobId, { targetClientId } = {}) {
      safeId(jobId);
      const job = activeJobs.get(jobId);
      if (job?.targetClientId && job.targetClientId !== targetClientId) fail('NOT_FOUND', 'AI job not found');
      const cancelled = !!job && !job.controller.signal.aborted;
      if (cancelled) job.controller.abort();
      return { jobId, cancelled };
    },
    cancelClientJobs(targetClientId) {
      if (typeof targetClientId !== 'string' || !targetClientId.length) return { cancelledCount: 0 };
      const now = Date.now();
      for (const [clientId, cancelledAt] of cancelledClients) {
        if (now - cancelledAt >= CANCELLED_CLIENT_TTL_MS) cancelledClients.delete(clientId);
      }
      // Refresh insertion order so capacity eviction always drops the oldest tombstone.
      cancelledClients.delete(targetClientId);
      if (cancelledClients.size >= MAX_CANCELLED_CLIENTS) cancelledClients.delete(cancelledClients.keys().next().value);
      cancelledClients.set(targetClientId, now);
      return cancelMatchingJobs(job => job.targetClientId === targetClientId);
    },
    cancelSocketJobs(socket) {
      return cancelMatchingJobs(job => job.originSocket === socket);
    },
    cancelCreationJobs(creationId) {
      return cancelMatchingJobs(job => job.creationId === creationId);
    },
    hasActiveWork: () => activeJobs.size > 0,
    waitForJob: jobId => activeJobs.get(jobId)?.promise,
    close() {
      if (!closing) {
        const jobs = [...activeJobs.values()];
        for (const job of jobs) job.controller.abort();
        closing = Promise.allSettled(jobs.map(job => job.promise)).then(() => {});
      }
      return closing;
    },
  };
}
