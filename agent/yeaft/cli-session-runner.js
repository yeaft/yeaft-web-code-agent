import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { createRouter } from './routing/router.js';
import { createLoopGuard } from './routing/loop-guard.js';
import { createCoordinator } from './sessions/coordinator.js';
import { resolveMemberId } from './sessions/roster.js';
import { sessionsRoot } from './sessions/session-crud.js';
import { openSession, loadSessionMeta } from './sessions/session-store.js';
import { loadSessionConfig, resolveSessionConfig } from './sessions/session-config.js';
import { readVp } from './vp/vp-crud.js';
import { COLLAB_TOOL_POLICY } from './tools/registry.js';

const MAX_ROUTE_FORWARD_RESULT_CHARS = 12_000;
const MAX_ROUTE_FORWARD_PROMPT_CHARS = 60_000;

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function routeForwardCompletionFor(row) {
  const envelope = row?.envelope;
  const meta = envelope?.msg?.meta;
  if (!meta || row?.stopReason === 'tool_handoff' || row?.stopReason === 'aborted') return null;
  const parent = meta.injectedBy === 'route_forward_result'
    && meta.routeForwardParent
    && typeof meta.routeForwardParent === 'object'
    ? meta.routeForwardParent
    : null;
  if (meta.injectedBy !== 'route_forward' && !parent) return null;
  const sourceVpId = cleanString(parent?.sourceVpId ?? meta.senderVpId);
  const forwardId = cleanString(parent?.forwardId ?? envelope?.msg?.id);
  if (!sourceVpId || !forwardId || sourceVpId === row.vpId) return null;
  const rawExpectedVpIds = parent?.expectedVpIds ?? meta.routeForwardExpectedTargets;
  const expectedVpIds = Array.isArray(rawExpectedVpIds)
    ? [...new Set(rawExpectedVpIds.map(cleanString).filter(Boolean))]
    : [row.vpId];
  if (!expectedVpIds.includes(row.vpId)) return null;
  return {
    forwardId,
    sourceVpId,
    sourceThreadId: cleanString(parent?.sourceThreadId ?? meta.sourceThreadId) || 'main',
    causedBy: Array.isArray(parent?.causedBy ?? meta.causedBy)
      ? (parent?.causedBy ?? meta.causedBy).slice()
      : [],
    dispatchErrors: [
      ...(Array.isArray(parent?.dispatchErrors) ? parent.dispatchErrors : []),
      ...(Array.isArray(meta.routeForwardDispatchErrors) ? meta.routeForwardDispatchErrors : []),
    ],
    truncatedAtFanOutCap: Boolean(parent?.truncatedAtFanOutCap)
      || Boolean(meta.routeForwardTruncatedAtFanOutCap),
    parentRouteForward: parent?.parentRouteForward
      || (meta.injectedBy === 'route_forward' ? (meta.routeForwardParent || null) : null),
    expectedVpIds,
    vpId: row.vpId,
    result: row.result || '',
    error: row.error || null,
    stopReason: row.stopReason || 'end_turn',
    envelope,
  };
}

function formatRouteForwardResult(aggregate, results) {
  const sections = results.map((entry) => {
    const rawBody = entry.error
      ? `Error: ${entry.error.message || String(entry.error)}`
      : (entry.result || '(no text returned)');
    const body = rawBody.length > MAX_ROUTE_FORWARD_RESULT_CHARS
      ? `${rawBody.slice(0, MAX_ROUTE_FORWARD_RESULT_CHARS)}\n[Result truncated]`
      : rawBody;
    return `[${entry.vpId} — ${entry.stopReason}]\n${body}`;
  });
  const notices = [];
  if (aggregate.truncatedAtFanOutCap) {
    notices.push('Warning: the requested fan-out was truncated at the Session limit.');
  }
  if (aggregate.dispatchErrors.length > 0) {
    notices.push(`Dispatch errors: ${JSON.stringify(aggregate.dispatchErrors)}`);
  }
  const prompt = [
    '[RouteForward result]',
    notices.length > 0
      ? 'The accepted delegated VP work has finished, but dispatch was partial. Continue the same user request using the results and warnings below.'
      : 'The delegated VP work has finished. Continue the same user request using the result below.',
    ...notices,
    '',
    ...sections,
  ].join('\n');
  return prompt.length > MAX_ROUTE_FORWARD_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_ROUTE_FORWARD_PROMPT_CHARS)}\n[Combined RouteForward results truncated]`
    : prompt;
}

function buildVpPersona(vpId, loaded) {
  const vp = readVp(vpId, { libDir: join(loaded.yeaftDir, 'virtual-persons') });
  if (!vp) return null;
  return {
    vpId,
    displayName: vp.displayName || vpId,
    displayNameZh: vp.displayNameZh || '',
    role: vp.role || '',
    roleZh: vp.roleZh || '',
    persona: vp.persona || '',
    planInstruction: vp.planInstruction || '',
  };
}

export function createCliVpEngine(loaded, sessionId, vpId) {
  const effectiveConfig = resolveSessionConfig(
    loaded.config,
    loadSessionConfig(loaded.yeaftDir, sessionId),
  );
  return new Engine({
    adapter: loaded.adapter,
    trace: loaded.trace,
    config: effectiveConfig,
    conversationStore: loaded.conversationStore,
    memoryIndex: loaded.memoryIndex || null,
    amsRegistry: loaded.amsRegistry || null,
    toolRegistry: loaded.toolRegistry,
    skillManager: loaded.skillManager,
    mcpManager: loaded.mcpManager,
    yeaftDir: loaded.yeaftDir,
    toolStats: loaded.toolStats || null,
    taskManager: loaded.taskManager || null,
    managedCliReady: loaded.managedCliReady || null,
    sessionId,
    vpId,
  });
}

/**
 * Open a transport-neutral multi-VP runtime for an existing Yeaft Session.
 * Different VPs run concurrently; each VP owns one serial promise tail and
 * one Engine, matching the WebSocket runtime's state-isolation rule.
 *
 * Returns null when session metadata does not exist so legacy one-engine CLI
 * invocations can keep their existing behavior.
 */
export function createCliSessionRunner({
  loaded,
  sessionId,
  workDir = process.cwd(),
  engineFactory = createCliVpEngine,
  personaFactory = buildVpPersona,
  configureEngine = null,
} = {}) {
  if (!loaded || !sessionId) return null;
  const sessionDir = join(sessionsRoot(loaded.yeaftDir), sessionId);
  if (!loadSessionMeta(sessionDir)) return null;

  const handle = openSession(sessionsRoot(loaded.yeaftDir), sessionId);
  const engines = new Map();
  const tails = new Map();
  const pending = new Set();
  // Root turns are accepted synchronously but execute on per-VP promise tails.
  // Durable rows therefore cannot use append order as their causal boundary: a
  // later root user row may be written before an earlier VP starts, while the
  // earlier VP's assistant rows may be written after that later user row. Every
  // new row carries one durable causalRootId; the legacy ids remain fallbacks
  // for rows produced before that field existed.
  const rootOrderByIdentity = new Map();
  const activeTurnContexts = new Map();
  const routeForwardGuard = createLoopGuard();
  let nextRootOrder = 0;
  let closed = false;

  const engineFor = (vpId) => {
    let engine = engines.get(vpId);
    if (!engine) {
      engine = engineFactory(loaded, sessionId, vpId);
      if (typeof configureEngine === 'function') configureEngine(engine, vpId);
      engines.set(vpId, engine);
    }
    return engine;
  };

  let coordinator;

  const runEnvelope = async (vpId, envelope, options) => {
    const meta = handle.getMeta();
    const engine = engineFor(vpId);
    const prompt = envelope?.msg?.text || '';
    const persistedUserClientMessageId = typeof envelope?._persistedUserClientMessageId === 'string'
      ? envelope._persistedUserClientMessageId
      : null;
    const causalRootId = typeof envelope?._cliCausalRootId === 'string' && envelope._cliCausalRootId
      ? envelope._cliCausalRootId
      : null;
    const rootOrder = Number.isInteger(envelope?._cliRootOrder)
      ? envelope._cliRootOrder
      : null;
    const inboundMessageId = cleanString(envelope?.msg?.id);
    const includeCurrentRoot = envelope?.msg?.meta?.injectedBy === 'route_forward_result';
    // Engine.query() appends `prompt` itself. Exclude this root's durable user
    // row and every later root turn, regardless of where their assistant/tool
    // rows landed in the globally sequenced transcript. This preserves rows
    // completed by earlier accepted roots while preventing future prompts from
    // entering an earlier provider request.
    const messages = loaded.conversationStore
      .loadSessionHistoryForVp(sessionId, vpId)
      .filter((message) => {
        if (inboundMessageId
            && (message?.id === inboundMessageId || message?.messageId === inboundMessageId)) {
          return false;
        }
        if (persistedUserClientMessageId
            && message?.role === 'user'
            && message.clientMessageId === persistedUserClientMessageId) return false;
        if (rootOrder === null) return true;
        let messageRootOrder = null;
        if (typeof message?.causalRootId === 'string' && message.causalRootId) {
          // A durable causal root is authoritative. Do not reinterpret a row by
          // its role-specific legacy ids when this field is present.
          messageRootOrder = rootOrderByIdentity.get(message.causalRootId);
        } else if (message?.role === 'user' && typeof message.clientMessageId === 'string') {
          messageRootOrder = rootOrderByIdentity.get(message.clientMessageId);
        } else if (typeof message?.turnId === 'string') {
          messageRootOrder = rootOrderByIdentity.get(message.turnId);
        }
        return !Number.isInteger(messageRootOrder)
          || messageRootOrder < rootOrder
          || (includeCurrentRoot && messageRootOrder === rootOrder);
      });
    const todos = [];
    let resultText = '';
    let failed = null;
    let stopReason = null;
    const scopedCoordinator = {
      group: coordinator.group,
      ingest(input, opts) {
        const report = coordinator.ingest({
          ...input,
          _cliRootOrder: envelope._cliRootOrder,
          _cliCausalRootId: envelope._cliCausalRootId,
          _cliTurnContext: envelope._cliTurnContext,
        }, opts);
        if (rootOrder !== null && typeof report?.message?.id === 'string') {
          rootOrderByIdentity.set(report.message.id, rootOrder);
        }
        return report;
      },
    };
    const queryOptions = {
      prompt,
      messages,
      sessionId,
      workDir: meta.workDir || workDir,
      senderVpId: vpId,
      sessionMembers: meta.roster.slice(),
      sessionAnnouncement: meta.announcement || '',
      vpPersona: personaFactory(vpId, loaded),
      router: createRouter({
        coordinator: scopedCoordinator,
        guard: routeForwardGuard,
      }),
      inboundEnvelope: envelope,
      userAlreadyPersisted: true,
      causalRootId,
      threadId: 'main',
      vpTurnId: envelope?.msg?.id || randomUUID(),
      collabToolPolicy: meta.roster.length > 1
        ? COLLAB_TOOL_POLICY.MULTI_VP
        : COLLAB_TOOL_POLICY.SINGLE_VP,
      getCurrentTodos: () => todos.slice(),
      setCurrentTodos: (next) => {
        todos.splice(0, todos.length, ...(Array.isArray(next) ? next : []));
      },
      askUser: options.askUser
        ? request => options.askUser(request, vpId, queryOptions.vpTurnId, queryOptions.threadId)
        : null,
      userEffort: options.modelEffort || null,
    };

    const turnContext = envelope?._cliTurnContext;
    turnContext?.activeEngines.add(engine);
    try {
      for await (const event of engine.query(queryOptions)) {
        if (event.type === 'text_delta') resultText += event.text || '';
        else if (event.type === 'error' && !failed) {
          failed = event.error instanceof Error
            ? event.error
            : new Error(String(event.error?.message || event.error || 'Unknown Engine error'));
        }
        if (event.type === 'turn_end' && event.terminal && event.stopReason) {
          stopReason = event.stopReason;
        } else if (event.type === 'stop' && event.stopReason) {
          stopReason = event.stopReason;
        }
        await options.onEvent?.({ vpId, event, sessionId, turnId: queryOptions.vpTurnId });
      }
    } catch (error) {
      failed = error;
      await options.onEvent?.({
        vpId,
        sessionId,
        turnId: queryOptions.vpTurnId,
        event: { type: 'error', error, retryable: false },
      });
    } finally {
      turnContext?.activeEngines.delete(engine);
    }
    return {
      vpId,
      result: resultText,
      error: failed,
      stopReason: failed ? 'error' : (stopReason || 'end_turn'),
      envelope,
    };
  };

  const enqueue = (vpId, envelope) => {
    if (closed) throw new Error('CLI Session runner is closed');
    const turnContext = envelope?._cliTurnContext;
    if (!turnContext) throw new Error('CLI Session envelope is missing its turn context');
    if (turnContext.cancellation.cancelled) {
      return Promise.resolve({
        vpId,
        result: '',
        error: null,
        stopReason: 'aborted',
        envelope,
      });
    }
    const routeForwardResultId = cleanString(envelope?.msg?.meta?.routeForwardId);
    const isRouteForwardResult = envelope?.msg?.meta?.injectedBy === 'route_forward_result'
      && cleanString(envelope?.msg?.meta?.routeTargetVpId) === vpId
      && routeForwardResultId
      && turnContext.routeForwardReturnIds.has(routeForwardResultId);
    if (turnContext.claimedVpIds.has(vpId) && !isRouteForwardResult) {
      return { ok: false, error: 'target_already_claimed' };
    }
    if (!isRouteForwardResult) turnContext.claimedVpIds.add(vpId);
    const previous = tails.get(vpId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => {
      if (turnContext.cancellation.cancelled) {
        return {
          vpId,
          result: '',
          error: null,
          stopReason: 'aborted',
          envelope,
        };
      }
      return runEnvelope(vpId, envelope, turnContext.options);
    });
    tails.set(vpId, task);
    pending.add(task);
    turnContext.tasks.push(task);
    task.finally(() => {
      pending.delete(task);
      if (tails.get(vpId) === task) tails.delete(vpId);
    }).catch(() => {});
    return task;
  };

  coordinator = createCoordinator(handle, { deliver: enqueue });

  const enqueueRouteForwardReturns = (completed, turnContext) => {
    if (turnContext.cancellation.cancelled) return;
    for (const row of completed) {
      const completion = routeForwardCompletionFor(row);
      if (!completion) continue;
      let aggregate = turnContext.routeForwardReturns.get(completion.forwardId);
      if (!aggregate) {
        aggregate = {
          ...completion,
          results: new Map(),
        };
        turnContext.routeForwardReturns.set(completion.forwardId, aggregate);
      }
      aggregate.results.set(completion.vpId, completion);
      if (turnContext.routeForwardReturnIds.has(completion.forwardId)
          || !aggregate.expectedVpIds.every(vpId => aggregate.results.has(vpId))) continue;

      // A RouteForward can return to its source exactly once. The source
      // remains claimed for the root turn, so this explicit, internally
      // marked continuation is the only allowed re-entry path.
      turnContext.routeForwardReturnIds.add(completion.forwardId);
      const results = aggregate.expectedVpIds.map(vpId => aggregate.results.get(vpId));
      const representative = results[0];
      coordinator.ingest({
        id: randomUUID(),
        from: representative.vpId,
        role: 'assistant',
        text: formatRouteForwardResult(aggregate, results),
        internal: true,
        meta: {
          synthetic: true,
          injectedBy: 'route_forward_result',
          routeTargetVpId: aggregate.sourceVpId,
          senderVpId: representative.vpId,
          sourceThreadId: aggregate.sourceThreadId,
          routeForwardId: aggregate.forwardId,
          ...(aggregate.parentRouteForward
            ? { routeForwardParent: aggregate.parentRouteForward }
            : {}),
          causedBy: aggregate.causedBy,
          routeForwardDispatchErrors: aggregate.dispatchErrors,
          routeForwardTruncatedAtFanOutCap: aggregate.truncatedAtFanOutCap,
        },
        _cliRootOrder: representative.envelope?._cliRootOrder,
        _cliCausalRootId: representative.envelope?._cliCausalRootId,
        _cliTurnContext: turnContext,
      });
    }
  };

  async function drain(tasks = pending) {
    const results = [];
    while (tasks.size > 0) {
      const batch = Array.from(tasks);
      results.push(...await Promise.all(batch));
      await Promise.resolve();
    }
    return results;
  }

  return {
    sessionId,
    get meta() { return handle.getMeta(); },
    async run(prompt, options = {}) {
      if (closed) throw new Error('CLI Session runner is closed');
      let routingIntent = options.routingIntent && typeof options.routingIntent === 'object'
        ? options.routingIntent
        : null;
      if (routingIntent) {
        const meta = handle.getMeta();
        const rawTargets = Array.isArray(routingIntent.targetVpIds)
          ? routingIntent.targetVpIds
          : [];
        const targetVpIds = [];
        for (const rawTarget of rawTargets) {
          const target = typeof rawTarget === 'string' ? rawTarget.trim() : '';
          const resolved = resolveMemberId(meta, target);
          if (!resolved) throw new Error(`Unknown stream-json target VP ${target || String(rawTarget)}: not in roster`);
          if (!targetVpIds.includes(resolved)) targetVpIds.push(resolved);
        }
        if (routingIntent.broadcast === true) {
          for (const vpId of meta.roster) {
            if (!targetVpIds.includes(vpId)) targetVpIds.push(vpId);
          }
        }
        if (targetVpIds.length === 0) throw new Error('stream-json routing intent requires at least one target VP');
        routingIntent = Object.freeze({
          targetVpIds: Object.freeze(targetVpIds),
          broadcast: routingIntent.broadcast === true,
          explicit: routingIntent.explicit === true,
        });
      }
      const messageId = randomUUID();
      const cancellationId = cleanString(options.cancellationId) || messageId;
      if (activeTurnContexts.has(cancellationId)) {
        throw new Error(`CLI Session cancellation id ${cancellationId} is already active`);
      }
      const turnContext = Object.freeze({
        rootId: messageId,
        cancellationId,
        options: Object.freeze({ ...options }),
        tasks: [],
        claimedVpIds: new Set(),
        routeForwardReturns: new Map(),
        routeForwardReturnIds: new Set(),
        cancellation: { cancelled: false, reason: null },
        activeEngines: new Set(),
      });
      activeTurnContexts.set(cancellationId, turnContext);
      try {
      const rootOrder = nextRootOrder++;
      rootOrderByIdentity.set(messageId, rootOrder);
      // The shared user row is the durability boundary. Validate structured
      // routing above before this append so malformed machine selectors never
      // enter the transcript or reach a provider.
      let persistedUserClientMessageId = null;
      if (!options.internal) {
        const persistedUser = loaded.conversationStore.append({
          role: 'user',
          content: prompt,
          sessionId,
          threadId: 'main',
          clientMessageId: messageId,
          causalRootId: messageId,
          userAuthored: true,
        });
        persistedUserClientMessageId = persistedUser?.clientMessageId || messageId;
      }
      const report = coordinator.ingest({
        id: messageId,
        from: options.internal ? 'tool' : 'user',
        role: options.internal ? 'assistant' : 'user',
        text: prompt,
        ...(options.internal ? {
          internal: true,
          taskId: options.taskId || null,
          meta: {
            ...(options.meta || {}),
            injectedBy: 'task_result',
            ...(routingIntent?.targetVpIds?.[0]
              ? { routeTargetVpId: routingIntent.targetVpIds[0] }
              : {}),
          },
        } : {}),
        ...(routingIntent ? { _routingIntent: routingIntent } : {}),
        ...(persistedUserClientMessageId ? { _persistedUserClientMessageId: persistedUserClientMessageId } : {}),
        _cliRootOrder: rootOrder,
        _cliCausalRootId: messageId,
        _cliTurnContext: turnContext,
      });
      const results = [];
      let cursor = 0;
      while (cursor < turnContext.tasks.length) {
        const batch = turnContext.tasks.slice(cursor);
        cursor += batch.length;
        const completed = await Promise.all(batch);
        results.push(...completed);
        enqueueRouteForwardReturns(completed, turnContext);
        await Promise.resolve();
      }
      return { report, results };
      } finally {
        activeTurnContexts.delete(cancellationId);
      }
    },
    abort(reason = 'user', options = {}) {
      const cancellationId = cleanString(options?.cancellationId);
      const contexts = cancellationId
        ? [activeTurnContexts.get(cancellationId)].filter(Boolean)
        : Array.from(activeTurnContexts.values());
      const enginesToAbort = new Set();
      for (const turnContext of contexts) {
        turnContext.cancellation.cancelled = true;
        turnContext.cancellation.reason = reason;
        for (const engine of turnContext.activeEngines) enginesToAbort.add(engine);
      }
      let count = 0;
      for (const engine of enginesToAbort) {
        if (engine.abort?.(reason)) count += 1;
      }
      return count;
    },
    async close() {
      closed = true;
      await drain();
      handle.close();
    },
  };
}
