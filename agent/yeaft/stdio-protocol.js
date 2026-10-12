import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { isReservedVpId, validateVpId } from './sessions/ids.js';

const TERMINAL_STOP_REASONS = new Set([
  'end_turn', 'max_tokens', 'stop_sequence', 'aborted', 'error', 'tool_handoff', 'plan_recorded',
]);

function snakeUsage(usage) {
  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cacheReadTokens = usage.cacheReadTokens || 0;
  const cacheWriteTokens = usage.cacheWriteTokens || 0;
  const cacheDelta = usage.cacheTokensAreIncludedInInput ? 0 : cacheReadTokens + cacheWriteTokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    total_input_tokens: inputTokens + cacheDelta,
    total_tokens: inputTokens + cacheDelta + outputTokens,
  };
}

export function extractPrompt(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.prompt === 'string') return message.prompt;
  if (typeof message.text === 'string') return message.text;
  const content = message.message?.content ?? message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('');
}

/**
 * Parse per-turn VP selectors without reading or mutating formal Session
 * metadata. Membership is validated later by the Session runner against its
 * canonical persisted roster.
 */
export function normalizeStreamRoutingIntent(message) {
  if (!message || typeof message !== 'object') return null;
  const hasSelector = Object.hasOwn(message, 'targetVps')
    || Object.hasOwn(message, 'targets')
    || Object.hasOwn(message, 'targetVpId')
    || Object.hasOwn(message, 'broadcast');
  if (!hasSelector) return null;

  const rawTargets = [];
  for (const key of ['targetVps', 'targets']) {
    if (!Object.hasOwn(message, key)) continue;
    if (!Array.isArray(message[key])) {
      throw new Error(`stream-json ${key} must be an array`);
    }
    rawTargets.push(...message[key]);
  }
  if (Object.hasOwn(message, 'targetVpId')) rawTargets.push(message.targetVpId);

  const targetVpIds = [];
  let broadcast = message.broadcast === true;
  for (const rawTarget of rawTargets) {
    if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
      throw new Error('stream-json target VP must be a non-empty string');
    }
    const target = rawTarget.trim();
    if (target === 'all' || target === 'everyone') {
      broadcast = true;
    } else if (!targetVpIds.includes(target)) {
      targetVpIds.push(target);
    }
  }

  return Object.freeze({
    targetVpIds: Object.freeze(targetVpIds),
    broadcast,
    explicit: true,
  });
}

/**
 * Read the opt-in formal Session seed supplied by an integration's first
 * stream-json prompt. Existing Sessions keep their persisted roster; this only
 * establishes a canonical roster for a previously unknown session id.
 */
export function normalizeStreamSessionBootstrap(message) {
  if (!message || typeof message !== 'object') return null;
  const hasRoster = Object.hasOwn(message, 'roster');
  const hasVps = Object.hasOwn(message, 'vps');
  const hasDefault = Object.hasOwn(message, 'defaultVpId');
  if (!hasRoster && !hasVps && !hasDefault) return null;
  if (!hasRoster && !hasVps) {
    throw new Error('stream-json defaultVpId requires roster or vps');
  }

  const readRoster = (key) => {
    const value = message[key];
    if (!Array.isArray(value)) throw new Error(`stream-json ${key} must be an array`);
    return value.slice();
  };
  const roster = hasRoster ? readRoster('roster') : readRoster('vps');
  if (hasRoster && hasVps) {
    const vps = readRoster('vps');
    if (vps.length !== roster.length || vps.some((vpId, index) => vpId !== roster[index])) {
      throw new Error('stream-json roster and vps must contain the same VP ids in the same order');
    }
  }

  const seen = new Set();
  for (const vpId of roster) {
    const verdict = validateVpId(vpId);
    if (!verdict.ok || isReservedVpId(vpId)) {
      throw new Error(`stream-json roster contains invalid VP id ${JSON.stringify(vpId)} (${verdict.reason || 'reserved'})`);
    }
    if (seen.has(vpId)) throw new Error(`stream-json roster contains duplicate VP id ${vpId}`);
    seen.add(vpId);
  }

  let defaultVpId = roster[0] || null;
  if (hasDefault && message.defaultVpId != null) {
    defaultVpId = message.defaultVpId;
    const verdict = validateVpId(defaultVpId);
    if (!verdict.ok || isReservedVpId(defaultVpId)) {
      throw new Error(`stream-json defaultVpId is invalid (${verdict.reason || 'reserved'})`);
    }
    if (!seen.has(defaultVpId)) {
      throw new Error(`stream-json defaultVpId ${defaultVpId} is not in roster`);
    }
  }

  return Object.freeze({
    roster: Object.freeze(roster),
    defaultVpId,
  });
}

export function createJsonlWriter(output = process.stdout) {
  return event => { output.write(`${JSON.stringify(event)}\n`); };
}

export class JsonlInput {
  #rl;
  #prompts = [];
  #promptWaiters = [];
  #answers = new Map();
  #answerWaiters = new Map();
  #answerRequestIds = new Set();
  #closed = false;
  #error = null;

  constructor(input = process.stdin) {
    this.#rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
    this.#rl.on('line', line => this.#acceptLine(line));
    this.#rl.on('close', () => this.#close());
  }

  #acceptLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      this.#error = new Error(`Invalid stream-json input: ${err.message}`);
      this.#close();
      return;
    }
    const type = message.type || '';
    if (type === 'ask_user_response' || type === 'user_response') {
      const requestId = message.request_id || message.requestId;
      if (!requestId) return;
      const value = message.answers ?? message.answer ?? message.response ?? {};
      const waiter = this.#answerWaiters.get(requestId);
      if (waiter) {
        this.#answerWaiters.delete(requestId);
        waiter.resolve(value);
      } else if (this.#answerRequestIds.has(requestId)) {
        this.#error = new Error(`Duplicate AskUser response request_id: ${requestId}`);
        this.#close();
      } else {
        this.#answerRequestIds.add(requestId);
        this.#answers.set(requestId, value);
      }
      return;
    }
    if (type === 'user' || type === 'prompt' || message.prompt !== undefined) {
      const prompt = extractPrompt(message);
      if (!prompt) return;
      const item = { prompt, message };
      const waiter = this.#promptWaiters.shift();
      if (waiter) waiter.resolve(item);
      else this.#prompts.push(item);
    }
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#promptWaiters.splice(0)) {
      if (this.#error) waiter.reject(this.#error);
      else waiter.resolve(null);
    }
    for (const waiter of this.#answerWaiters.values()) {
      waiter.reject(this.#error || new Error('stdin closed before AskUser response'));
    }
    this.#answerWaiters.clear();
  }

  async nextPrompt() {
    if (this.#prompts.length) return this.#prompts.shift();
    if (this.#error) throw this.#error;
    if (this.#closed) return null;
    return new Promise((resolve, reject) => this.#promptWaiters.push({ resolve, reject }));
  }

  async waitForAnswer(requestId) {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('AskUser request_id must be a non-empty string');
    }
    if (this.#error) throw this.#error;
    if (this.#answers.has(requestId)) {
      const value = this.#answers.get(requestId);
      this.#answers.delete(requestId);
      return value;
    }
    if (this.#answerRequestIds.has(requestId)) {
      throw new Error(`Duplicate AskUser request_id: ${requestId}`);
    }
    if (this.#closed) throw new Error('stdin closed before AskUser response');
    this.#answerRequestIds.add(requestId);
    return new Promise((resolve, reject) => this.#answerWaiters.set(requestId, { resolve, reject }));
  }

  close() { this.#rl.close(); }
}

function makeUsageState() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheInputDeltaTokens: 0,
  };
}

function finalUsage(state) {
  return {
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
    cache_read_input_tokens: state.cacheReadTokens,
    cache_creation_input_tokens: state.cacheWriteTokens,
    total_input_tokens: state.inputTokens + state.cacheInputDeltaTokens,
    total_tokens: state.inputTokens + state.cacheInputDeltaTokens + state.outputTokens,
  };
}

/**
 * One Engine-event projector shared by single- and multi-VP stream-json paths.
 */
export function createStreamProjector({
  sessionId,
  write,
  workDir = process.cwd(),
  model = null,
  modelEffort = null,
  defaultVpId = null,
  defaultThreadId = 'main',
  clientTurnId = randomUUID(),
} = {}) {
  const states = new Map();
  let failed = null;
  const keyFor = vpId => vpId || '__single__';
  const stateFor = (vpId = null) => {
    const key = keyFor(vpId);
    let state = states.get(key);
    if (!state) {
      state = {
        vpId: vpId || defaultVpId || null,
        threadId: defaultThreadId || 'main',
        turnId: clientTurnId,
        resultText: '',
        stopReason: 'end_turn',
        usage: makeUsageState(),
        asyncWaitPendingByLoop: new Map(),
      };
      states.set(key, state);
    } else if (vpId && !state.vpId) {
      state.vpId = vpId;
    }
    return state;
  };
  const scopeFor = state => ({
    session_id: sessionId,
    turn_id: state.turnId || clientTurnId,
    ...(state.vpId ? { vp_id: state.vpId, vpId: state.vpId } : {}),
    thread_id: state.threadId || 'main',
    threadId: state.threadId || 'main',
  });

  const project = ({ vpId = null, event, turnId: fallbackTurnId = null } = {}) => {
    if (!event || typeof event !== 'object') return;
    const state = stateFor(vpId);
    if (event.type === 'turn_open') {
      if (event.turnId) state.turnId = event.turnId;
      if (event.vpId) state.vpId = event.vpId;
      if (event.threadId) state.threadId = event.threadId;
    } else if (event.threadId) {
      state.threadId = event.threadId;
    }
    if (!state.turnId && fallbackTurnId) state.turnId = fallbackTurnId;
    const base = scopeFor(state);
    switch (event.type) {
      case 'turn_open':
        write({ ...event, ...base, type: 'turn', subtype: 'start', model, model_effort: modelEffort, cwd: workDir });
        break;
      case 'text_delta':
        state.resultText += event.text || '';
        write({ ...base, type: 'assistant', subtype: 'text_delta', delta: { type: 'text_delta', text: event.text || '' } });
        break;
      case 'response_presentation':
        state.resultText += event.message?.content || '';
        write({ ...base, type: 'assistant', subtype: 'response_presentation',
          message: event.message, content: [{ type: 'text', text: event.message?.content || '' }],
          presentation: event.message?.presentation });
        break;
      case 'thinking_delta':
        write({ ...base, type: 'assistant', subtype: 'thinking_delta', delta: { type: 'thinking_delta', thinking: event.text || '' } });
        break;
      case 'skill_loaded':
        write({ ...base, type: 'skill', subtype: 'loaded', skill: event.skill });
        break;
      case 'skill_error':
        write({ ...base, type: 'skill', subtype: 'error', skill_name: event.skillName, error: event.message });
        break;
      case 'tool_call':
        write({ ...base, type: 'assistant', subtype: 'tool_use', content: [{ type: 'tool_use', id: event.id, name: event.name, input: event.input }] });
        if (event.name === 'TodoWrite') {
          write({ ...base, type: 'todo', subtype: 'update', tool_use_id: event.id, todos: event.input?.todos || [] });
        }
        break;
      case 'tool_start':
        write({ ...base, type: 'tool', subtype: 'start', tool_use_id: event.id, name: event.name, input: event.input });
        break;
      case 'tool_end':
        write({
          ...base,
          type: 'tool',
          subtype: 'result',
          tool_use_id: event.id,
          name: event.name,
          content: event.output,
          is_error: !!event.isError,
          ...(Array.isArray(event.displayImages) && event.displayImages.length > 0
            ? { display_images: event.displayImages }
            : {}),
        });
        break;
      case 'usage': {
        const cacheDelta = event.cacheTokensAreIncludedInInput
          ? 0
          : (event.cacheReadTokens || 0) + (event.cacheWriteTokens || 0);
        state.usage.inputTokens += event.inputTokens || 0;
        state.usage.outputTokens += event.outputTokens || 0;
        state.usage.cacheReadTokens += event.cacheReadTokens || 0;
        state.usage.cacheWriteTokens += event.cacheWriteTokens || 0;
        state.usage.cacheInputDeltaTokens += cacheDelta;
        write({ ...base, type: 'usage', usage: snakeUsage(event) });
        break;
      }
      case 'async_task_wait_start': {
        const loopKey = event.loopNumber ?? state.turnId;
        const pendingTaskIds = Array.isArray(event.pendingTaskIds) ? event.pendingTaskIds.slice() : [];
        state.asyncWaitPendingByLoop.set(loopKey, pendingTaskIds);
        write({
          ...base,
          type: 'async_task',
          subtype: 'wait_start',
          loop_number: event.loopNumber,
          pending_task_ids: pendingTaskIds,
        });
        break;
      }
      case 'async_task_wait_end': {
        const loopKey = event.loopNumber ?? state.turnId;
        const pendingTaskIds = state.asyncWaitPendingByLoop.get(loopKey) || [];
        write({
          ...base,
          type: 'async_task',
          subtype: 'wait_end',
          loop_number: event.loopNumber,
          aborted: !!event.aborted,
          timed_out: !!event.timedOut,
          pending_task_ids: pendingTaskIds,
          remaining_task_ids: Array.isArray(event.remainingTaskIds) ? event.remainingTaskIds.slice() : [],
          deferred_task_ids: Array.isArray(event.deferredTaskIds) ? event.deferredTaskIds.slice() : [],
        });
        state.asyncWaitPendingByLoop.delete(loopKey);
        break;
      }
      case 'aborted':
        state.stopReason = 'aborted';
        write({ ...base, type: 'aborted', reason: event.reason || 'external' });
        break;
      case 'stop':
        if (event.stopReason) state.stopReason = event.stopReason;
        break;
      case 'turn_end':
        if (event.stopReason && (event.terminal || TERMINAL_STOP_REASONS.has(event.stopReason))) {
          state.stopReason = event.stopReason;
        }
        break;
      case 'turn_close':
        write({ ...base, type: 'turn', subtype: 'stop', duration_ms: event.totalMs, loop_count: event.loopCount, total_tokens: event.totalTokens });
        break;
      case 'error': {
        const error = event.error instanceof Error
          ? event.error
          : new Error(event.error?.message || String(event.error || 'Unknown error'));
        failed ||= error;
        state.stopReason = 'error';
        write({ ...base, type: 'error', error: { name: error.name, message: error.message }, retryable: !!event.retryable });
        break;
      }
      case 'fallback':
      case 'llm_retry':
      case 'memory_used':
      case 'recall':
      case 'reflection':
      case 'tool_result_update':
      case 'user_append':
        write({ ...event, ...base });
        break;
    }
  };

  const recordFailure = (error, { vpId = null, threadId = null, turnId = null, writeError = true } = {}) => {
    const normalized = error instanceof Error ? error : new Error(String(error || 'Unknown error'));
    failed ||= normalized;
    const state = stateFor(vpId);
    if (threadId) state.threadId = threadId;
    if (turnId) state.turnId = turnId;
    state.stopReason = 'error';
    if (writeError) {
      write({
        ...scopeFor(state),
        type: 'error',
        error: { name: normalized.name || 'Error', message: normalized.message || String(normalized) },
        retryable: false,
      });
    }
    return normalized;
  };

  const perVpResults = () => Array.from(states.values()).map(state => ({
    ...(state.vpId ? { vp_id: state.vpId } : {}),
    turn_id: state.turnId,
    thread_id: state.threadId || 'main',
    stop_reason: state.stopReason,
    result: state.resultText,
    usage: finalUsage(state.usage),
  }));

  return {
    clientTurnId,
    project,
    recordFailure,
    stateFor,
    scopeFor,
    get failure() { return failed; },
    perVpResults,
  };
}

export async function runStreamTurn({
  engine,
  prompt,
  messages = [],
  sessionId = null,
  workDir = process.cwd(),
  model = null,
  modelEffort = null,
  input = null,
  write,
  getCurrentTodos = null,
  setCurrentTodos = null,
  vpPersona = null,
  sessionMembers = null,
  router = null,
  inboundEnvelope = null,
  taskId = null,
  taskMembers = null,
  threadId = 'main',
  vpTurnId = null,
  userAlreadyPersisted = false,
}) {
  const vpId = typeof vpPersona?.vpId === 'string' ? vpPersona.vpId : null;
  const projector = createStreamProjector({
    sessionId, write, workDir, model, modelEffort, defaultVpId: vpId, defaultThreadId: threadId,
  });
  const askUser = async ({ question, options }) => {
    const requestId = randomUUID();
    const state = projector.stateFor(vpId);
    const scope = projector.scopeFor(state);
    write({ ...scope, type: 'ask_user', subtype: 'request', request_id: requestId, question, options: Array.isArray(options) ? options : [] });
    if (!input) throw new Error('AskUser requires --input-format stream-json');
    const answers = await input.waitForAnswer(requestId);
    write({ ...scope, type: 'ask_user', subtype: 'response', request_id: requestId, answers });
    return answers;
  };
  try {
    for await (const event of engine.query({
      prompt,
      messages,
      sessionId,
      workDir,
      userEffort: modelEffort,
      askUser,
      getCurrentTodos,
      setCurrentTodos,
      vpPersona,
      senderVpId: vpId,
      sessionMembers,
      router,
      inboundEnvelope,
      taskId,
      taskMembers,
      threadId,
      vpTurnId,
      userAlreadyPersisted,
    })) {
      projector.project({ vpId, event, turnId: vpTurnId });
    }
  } catch (error) {
    projector.recordFailure(error, { vpId, threadId });
  }
  const perVp = projector.perVpResults();
  const state = perVp[0] || { turn_id: projector.clientTurnId, thread_id: threadId, stop_reason: 'end_turn', result: '', usage: finalUsage(makeUsageState()) };
  const failed = projector.failure;
  const result = {
    type: 'result',
    subtype: failed ? 'error' : 'success',
    session_id: sessionId,
    turn_id: state.turn_id,
    ...(vpId ? { vp_id: vpId, vpId } : {}),
    thread_id: state.thread_id || 'main',
    threadId: state.thread_id || 'main',
    model,
    model_effort: modelEffort,
    stop_reason: failed ? 'error' : state.stop_reason,
    is_error: !!failed,
    result: state.result,
    usage: state.usage,
    ...(failed ? { error: failed.message || String(failed) } : {}),
  };
  write(result);
  return result;
}

export async function runStreamSessionTurn({
  runner,
  prompt,
  sessionId,
  workDir = process.cwd(),
  model = null,
  modelEffort = null,
  input = null,
  write,
  routingIntent = null,
  internal = false,
  taskId = null,
  meta = null,
}) {
  const projector = createStreamProjector({ sessionId, write, workDir, model, modelEffort });
  const askUser = async ({ question, options }, vpId = null, turnId = projector.clientTurnId, threadId = 'main') => {
    const requestId = randomUUID();
    const state = projector.stateFor(vpId);
    state.turnId = turnId || state.turnId;
    state.threadId = threadId || state.threadId;
    const scope = projector.scopeFor(state);
    write({ ...scope, type: 'ask_user', subtype: 'request', request_id: requestId, question, options: Array.isArray(options) ? options : [] });
    if (!input) throw new Error('AskUser requires --input-format stream-json');
    const answers = await input.waitForAnswer(requestId);
    write({ ...scope, type: 'ask_user', subtype: 'response', request_id: requestId, answers });
    return answers;
  };

  let outcome = { report: { dispatched: [] }, results: [] };
  try {
    outcome = await runner.run(prompt, {
      modelEffort,
      routingIntent,
      internal,
      taskId,
      meta,
      onEvent: event => projector.project(event),
      askUser,
    });
  } catch (error) {
    projector.recordFailure(error);
  }
  for (const row of outcome?.results || []) {
    if (row?.error) projector.recordFailure(row.error, { vpId: row.vpId, writeError: false });
  }
  const dispatchedVpIds = Array.isArray(outcome?.report?.dispatched)
    ? outcome.report.dispatched
    : [];
  if (dispatchedVpIds.length === 0 && !projector.failure) {
    const reportErrors = Array.isArray(outcome?.report?.errors)
      ? outcome.report.errors
        .map(entry => entry?.error || entry?.message)
        .filter(Boolean)
      : [];
    const detail = reportErrors.join(', ') || outcome?.report?.reason || 'no_vp_dispatched';
    projector.recordFailure(new Error(`stream-json Session turn dispatched no VP: ${detail}`));
  }

  const perVp = projector.perVpResults();
  const stopReasons = perVp.map(item => item.stop_reason);
  if (stopReasons.includes('error') && !projector.failure) {
    projector.recordFailure(new Error('stream-json VP turn ended with stop reason error'), { writeError: false });
  }
  const failed = projector.failure;
  const aggregateStopReason = failed
    ? 'error'
    : stopReasons.length > 0 && stopReasons.every(reason => reason === 'aborted')
      ? 'aborted'
      : stopReasons.length > 0 && stopReasons.every(reason => reason === 'tool_handoff')
        ? 'tool_handoff'
        : 'end_turn';
  const result = {
    type: 'result',
    subtype: failed ? 'error' : 'success',
    session_id: sessionId,
    turn_id: projector.clientTurnId,
    model,
    model_effort: modelEffort,
    stop_reason: aggregateStopReason,
    is_error: !!failed,
    result: perVp.map(item => item.result).filter(Boolean).join('\n'),
    dispatched_vp_ids: dispatchedVpIds,
    vp_results: perVp,
    ...(failed ? { error: failed.message || String(failed) } : {}),
  };
  write(result);
  return result;
}
