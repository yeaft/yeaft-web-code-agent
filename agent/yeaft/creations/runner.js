import { randomUUID } from 'node:crypto';
import { LIMITS, boundedText, safeId, fail } from './constants.js';
import { boundedList } from './store.js';
import { buildCreationContext } from './context-builder.js';
import { buildCreationToolRegistry } from './tools.js';

async function defaultEngineFactory({ yeaftDir, toolRegistry }) {
  const [{ Engine }, { loadConfig }, { createLLMAdapter }, { createTrace }] = await Promise.all([
    import('../engine.js'), import('../config.js'), import('../llm/adapter.js'), import('../debug-trace.js'),
  ]);
  const config = { ...loadConfig({ dir: yeaftDir }), projectDocMaxBytes: 0 };
  // An explicit built-in allowlist does not govern these private, run-local
  // capabilities. Never register or discover any of the normal Agent tools.
  config.plugins = { ...config.plugins, tools: [...toolRegistry.names], mcpServers: [], skills: [] };
  const adapter = await createLLMAdapter(config);
  return new Engine({ adapter, config, trace: createTrace({ enabled: false }), toolRegistry,
    yeaftDir: null, conversationStore: null, memoryIndex: null, amsRegistry: null, taskManager: null, toolStats: null });
}

function modelOptions({ model, effort }) {
  return {
    model: model == null ? null : boundedText(model, 512, 'model', { required: true }),
    effort: effort == null ? null : boundedText(effort, 32, 'effort', { required: true }),
  };
}
const progress = (completed, total) => ({ completed, total });
const successfulStop = reason => ['end_turn', 'stop_sequence'].includes(reason);

// Lets cancellation release the run even if a provider/plugin fails to honor
// AbortSignal. The old iterator may unwind later, but its tools are fenced.
async function abortable(work, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

export class CreationRunner {
  constructor({ store, yeaftDir, bootId = randomUUID(), emitEvent = () => {}, mediaUrlFor, engineFactory = defaultEngineFactory }) {
    Object.assign(this, { store, yeaftDir, bootId, emitEvent, mediaUrlFor, engineFactory });
    this.active = new Map();
    this.closed = false;
    store.recoverInterruptedRuns(bootId);
  }
  #emit(type, creationId, payload) {
    try { Promise.resolve(this.emitEvent({ type, creationId, ...payload })).catch(() => {}); }
    catch { /* events are best effort; database remains authoritative */ }
  }
  #emitRun(run) {
    if (run) this.#emit('run_updated', run.creationId, { run: { ...run, totalUnits: run.progress?.total, completedUnits: run.progress?.completed } });
  }
  #schedule(run, fn) {
    const controller = new AbortController();
    const task = { run, controller, done: null };
    this.active.set(run.id, task);
    task.done = Promise.resolve().then(() => fn(controller.signal)).catch(() => {
      const next = this.store.updateRun(run.creationId, run.id, run, { status: run.type === 'batch' ? 'paused' : 'failed', reason: 'execution_failed' });
      this.#emitRun(next);
    }).finally(() => { if (this.active.get(run.id) === task) this.active.delete(run.id); });
    // Service calls return a durable start acknowledgment, not this promise.
    task.done.catch(() => {});
    return task.done;
  }
  waitForRun(runId) { return this.active.get(safeId(runId))?.done ?? Promise.resolve(); }
  #assertOpen() { if (this.closed) fail('INVALID_STATE', 'Creations runner is closed'); }
  #assertActive(run, signal) {
    signal.throwIfAborted();
    const current = this.store.getRun(run.creationId, run.id);
    if (current.status !== 'running' || current.leaseEpoch !== run.leaseEpoch || current.bootId !== run.bootId) fail('STALE', 'Run lease expired');
  }
  #patch(run, patch) { return this.store.updateRun(run.creationId, run.id, run, patch); }
  #registry(run, signal, extra) {
    return buildCreationToolRegistry({ store: this.store, creationId: run.creationId, mediaUrlFor: this.mediaUrlFor,
      assertActive: () => this.#assertActive(run, signal), emitEvent: ({ type, creationId, ...payload }) => this.#emit(type, creationId, payload), ...extra });
  }
  async #query(run, signal, { context, userText, threadId, registry, onEvent }) {
    const engine = await abortable(() => this.engineFactory({ yeaftDir: this.yeaftDir, toolRegistry: registry,
      creationId: run.creationId, run, signal }), signal);
    const events = engine.query({ prompt: `${context.promptContext}\n\n## Current request\n${userText}`,
      projectInstruction: context.systemInstructions, projectLabel: 'Creation', scenario: 'creation', signal, threadId,
      turnConfig: { model: run.model, effort: run.effort }, userEffort: run.effort, messages: [], collabToolPolicy: 'single-vp' });
    const iterator = events[Symbol.asyncIterator]();
    let exhausted = false;
    let stop = null;
    try {
      while (true) {
        const next = await abortable(() => iterator.next(), signal);
        if (next.done) { exhausted = true; break; }
        this.#assertActive(run, signal);
        const event = next.value;
        onEvent(event);
        if (event.type === 'error' && event.retryable !== true) fail('TURN_FAILED', 'Creation model turn failed');
        if (event.type === 'aborted') fail('TURN_ABORTED', 'Creation model turn stopped');
        if (event.type === 'turn_end' && event.terminal === true) { stop = event.stopReason; break; }
      }
      if (!successfulStop(stop)) fail('TURN_FAILED', 'Creation model turn did not finish');
    } finally {
      if (!exhausted) {
        // Do not pin a durable run waiting for a non-cooperative iterator.
        try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch {}
      }
    }
  }

  runThreadTurn({ creationId, threadId, scopeType, scopeId, userText, anchor = null, excludedContextIds = [],
    model, effort, files = [], textSources = [] }) {
    this.#assertOpen();
    userText = boundedText(userText, LIMITS.promptBytes, 'message');
    if (anchor !== null) boundedText(JSON.stringify(anchor), 8192, 'anchor');
    boundedList(excludedContextIds, 256, 'excluded context').forEach(id => boundedText(id, 128, 'context ID', { required: true }));
    const result = this.store.transaction(() => {
      const thread = this.store.getThread(creationId, { threadId, scopeType, scopeId });
      const sources = this.store.addSources(creationId, { files, textSources });
      if (!userText.trim() && !sources.length) fail('INVALID_REQUEST', 'Enter a message or attach a source');
      const message = this.store.addMessage(creationId, thread.id, { role: 'user', text: userText, content: userText, anchor, sourceIds: sources.map(source => source.id) });
      const assistantMessageId = randomUUID();
      const run = this.store.createRun(creationId, { type: 'thread', threadId: thread.id, scopeId: thread.scopeId, userMessageId: message.id,
        assistantMessageId, bootId: this.bootId, ...modelOptions({ model, effort }), progress: progress(0, 1) });
      const context = buildCreationContext({ store: this.store, creationId, threadId: thread.id,
        prompt: `${userText} ${sources.map(source => source.name).join(' ')}`, anchor, excludedContextIds, excludeMessageId: message.id });
      return { thread, message, sources, run, context };
    });
    const { thread, message, sources, run, context } = result;
    this.#schedule(run, signal => this.#thread(run, thread, message, context, signal));
    for (const source of sources) this.#emit('source_added', creationId, { source: this.mediaUrlFor ? { ...source, url: this.mediaUrlFor(creationId, 'source', source.id) } : source });
    this.#emit('thread_message_complete', creationId, { threadId: thread.id, runId: run.id, message });
    this.#emitRun(run);
    return { thread, threadId: thread.id, message, userMessage: message, sources, run, contextMeta: context.contextMeta, contextPreview: context.contextMeta };
  }
  async #thread(run, thread, message, context, controllerSignal) {
    const signal = AbortSignal.any([controllerSignal, AbortSignal.timeout(LIMITS.turnTimeoutMs)]);
    const { creationId, id: runId, assistantMessageId: messageId } = run;
    const identity = { threadId: thread.id, runId, messageId };
    let output = '';
    let status = 'complete';
    const openTools = new Map();
    try {
      await this.#query(run, signal, { context, userText: message.text || 'Review the newly attached sources.', threadId: thread.id,
        registry: this.#registry(run, signal), onEvent: event => {
          if (event.type === 'text_delta' && typeof event.text === 'string') {
            const delta = event.text.slice(0, LIMITS.responseChars - output.length);
            if (!delta) return;
            output += delta;
            this.#emit('thread_message_delta', creationId, { ...identity, delta, contextMeta: context.contextMeta });
          } else if (event.type === 'tool_start' || event.type === 'tool_end') {
            if (event.type === 'tool_start') openTools.set(event.id, event.name);
            else openTools.delete(event.id);
            this.#emit('thread_tool_status', creationId, { ...identity, toolId: event.id, name: event.name,
              status: event.type === 'tool_start' ? 'running' : event.isError ? 'failed' : 'complete' });
          }
        } });
    } catch { status = controllerSignal.aborted ? 'cancelled' : 'failed'; }
    for (const [toolId, name] of openTools) this.#emit('thread_tool_status', creationId, { ...identity, toolId, name, status: 'failed' });
    const result = this.store.transaction(() => {
      const finalRun = this.#patch(run, { status: status === 'complete' ? 'completed' : status,
        reason: status === 'failed' ? 'turn_failed' : null, progress: progress(status === 'complete' ? 1 : 0, 1) });
      if (!finalRun) return null; // controlRun/close invalidated the lease
      return { run: finalRun, message: this.store.addMessage(creationId, thread.id, { id: messageId, role: 'assistant', text: output, content: output,
        status, runId, contextMeta: context.contextMeta }) };
    });
    if (result) {
      this.#emit('thread_message_complete', creationId, { ...identity, message: result.message, contextPreview: context.contextMeta });
      this.#emitRun(result.run);
    } else if (controllerSignal.aborted && !this.closed) {
      this.#emit('thread_message_complete', creationId, { ...identity, message: { id: messageId, role: 'assistant', text: '', status } });
    }
  }

  startBatchRun({ creationId, nodeIds, instruction = '', checkpointEvery = 0, model, effort }) {
    this.#assertOpen();
    boundedList(nodeIds, LIMITS.batchNodes, 'batch nodes').forEach(safeId);
    if (!nodeIds.length || new Set(nodeIds).size !== nodeIds.length) fail('INVALID_REQUEST', 'Select distinct batch units');
    boundedText(instruction, LIMITS.promptBytes, 'batch instruction');
    if (!Number.isSafeInteger(checkpointEvery) || checkpointEvery < 0 || checkpointEvery > LIMITS.batchNodes) fail('INVALID_REQUEST', 'Invalid checkpoint interval');
    const run = this.store.transaction(() => {
      for (const id of nodeIds) {
        const node = this.store.getNode(creationId, id);
        if (node.type !== 'unit' || node.status === 'final' || node.userEdited) fail('REVIEW_REQUIRED', 'Batch accepts only units without final or user-edited content');
      }
      return this.store.createRun(creationId, { type: 'batch', nodeIds, instruction, checkpointEvery, ...modelOptions({ model, effort }),
        bootId: this.bootId, progress: progress(0, nodeIds.length), completedNodeIds: [], currentNodeId: null, failedNodeId: null });
    });
    this.#schedule(run, signal => this.#batch(run, signal));
    this.#emitRun(run);
    return run;
  }
  async #batch(run, controllerSignal) {
    const { creationId, id: runId, nodeIds, checkpointEvery } = run;
    for (let index = run.progress.completed; index < nodeIds.length; index++) {
      const nodeId = nodeIds[index];
      const signal = AbortSignal.any([controllerSignal, AbortSignal.timeout(LIMITS.turnTimeoutMs)]);
      let original;
      try {
        this.#assertActive(run, signal);
        const current = this.#patch(run, { currentNodeId: nodeId });
        if (!current) return;
        this.#emitRun(current);
        original = this.store.getNode(creationId, nodeId);
        if (original.type !== 'unit' || original.status === 'final' || original.userEdited) fail('REVIEW_REQUIRED', 'Batch unit now requires review');
        const context = buildCreationContext({ store: this.store, creationId, nodeId, prompt: run.instruction });
        let staged = null;
        let summaryMd;
        const delta = (value, replace = false) => this.#emit('node_content_delta', creationId, { runId, nodeId, delta: value, replace, ...(replace ? { content: value } : {}) });
        let preview = '';
        await this.#query(run, signal, { context,
          userText: `Draft the full unit ${nodeId}. Use creation_write_unit for the complete draft and creation_update_unit_summary for continuity.\n${run.instruction}`,
          registry: this.#registry(run, signal, { batchNodeId: nodeId,
            stageBatchWrite: input => {
              if (Object.hasOwn(input, 'baseRevId') && input.baseRevId !== original.currentRevId) fail('CONFLICT', 'Batch base revision does not match');
              const value = input.content;
              const rendered = typeof value === 'string' ? value : JSON.stringify(value);
              if (original.modality === 'markdown_doc' && typeof value !== 'string') fail('INVALID_REQUEST', 'Markdown content must be a string');
              if (typeof value !== 'string' && (!value || typeof value !== 'object')) fail('INVALID_REQUEST', 'Invalid unit content');
              boundedText(rendered, LIMITS.nodeBytes, 'batch unit content', { required: true });
              staged = { content: value };
              delta(rendered, true);
              return { staged: true, nodeId };
            },
            stageBatchSummary: value => { summaryMd = boundedText(value, LIMITS.promptBytes, 'summary'); return { staged: true, nodeId }; },
          }), onEvent: event => {
            if (event.type !== 'text_delta' || typeof event.text !== 'string') return;
            const first = !preview;
            const part = event.text.slice(0, LIMITS.responseChars - preview.length);
            preview += part;
            if (!staged && part) delta(part, first);
          } });
        this.#assertActive(run, signal);
        if (!staged) {
          // A bare chat response (or a truncated preview) is not proof the unit
          // was written. Require the tool so commentary cannot become prose.
          fail('NO_DRAFT', 'Model did not write a complete unit');
        }
        const completed = index + 1;
        const status = completed === nodeIds.length ? 'completed' : checkpointEvery && completed % checkpointEvery === 0 ? 'paused' : 'running';
        const result = this.store.transaction(() => {
          this.#assertActive(run, signal);
          const node = this.store.updateNode(creationId, nodeId, { content: staged.content, baseRevId: original.currentRevId,
            ...(summaryMd !== undefined ? { summaryMd } : {}) }, { actor: 'ai' });
          if (node.conflict || !node.hasReadableContent) fail('CONFLICT', 'Batch unit changed or is empty');
          const next = this.#patch(run, { status, reason: status === 'paused' ? 'checkpoint' : null,
            progress: progress(completed, nodeIds.length), completedNodeIds: nodeIds.slice(0, completed), currentNodeId: null });
          if (!next) fail('STALE', 'Run lease expired');
          return { node, next };
        });
        this.#emit('node_content_updated', creationId, { runId, nodeId, node: result.node, content: result.node.content, revisions: this.store.listRevisions(creationId, nodeId) });
        this.#emitRun(result.next);
        if (status !== 'running') return;
      } catch (error) {
        if (controllerSignal.aborted) return;
        const next = this.#patch(run, { status: 'paused', reason: 'unit_failed', currentNodeId: null, failedNodeId: nodeId,
          error: error?.code === 'NO_DRAFT' ? 'Model did not write a complete unit' : 'Unable to complete batch unit' });
        if (next && original) this.#emit('node_content_delta', creationId, { runId, nodeId, replace: true, delta: '',
          content: this.store.getNode(creationId, nodeId).content, discarded: true });
        this.#emitRun(next);
        return;
      }
    }
  }
  controlRun({ creationId, runId, action }) {
    this.#assertOpen();
    const previous = this.store.getRun(creationId, runId);
    const run = this.store.controlRun(creationId, runId, action, this.bootId);
    if ((action === 'pause' || action === 'cancel') && previous.currentNodeId) {
      const node = this.store.getNode(creationId, previous.currentNodeId);
      this.#emit('node_content_delta', creationId, { runId, nodeId: node.id, replace: true, delta: '', content: node.content, discarded: true });
    }
    if (action === 'resume') this.#schedule(run, signal => this.#batch(run, signal));
    else this.active.get(runId)?.controller.abort();
    this.#emitRun(run);
    return run;
  }
  async close() {
    this.closed = true;
    const tasks = [...this.active.values()];
    for (const { run, controller } of tasks) {
      this.#patch(run, { status: 'paused', reason: 'agent_restarted', currentNodeId: null, leaseEpoch: run.leaseEpoch + 1 });
      controller.abort();
    }
    await Promise.allSettled(tasks.map(task => task.done));
  }
}

export function createCreationRunner(options) { return new CreationRunner(options); }
