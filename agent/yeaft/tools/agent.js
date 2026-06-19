/**
 * agent.js — Create a sub-agent for parallel task execution.
 *
 * Sub-agents run in isolated contexts and can be assigned
 * independent tasks. They communicate via send-message/wait-agent.
 *
 * SubagentSpec contract (v1):
 *   {
 *     name: string,
 *     task: string,                   // legacy summary; becomes mission when not given
 *     mission?: string,               // concrete objective statement
 *     expected_output?: object,       // JSON schema describing the required output
 *     persona?: string,               // preset id: explorer|implementer|reviewer|researcher
 *     budget?: {
 *       max_tokens?: number,
 *       max_turns?: number,
 *       wall_time_ms?: number
 *     },
 *     cwd?: string
 *   }
 */

import { defineTool } from './types.js';
import { randomUUID } from 'crypto';
import { getPersona, listPersonaIds } from '../personas.js';
import { startSubAgent } from '../sub-agent/runner.js';
import { STATUS, isTerminalAgentStatus } from '../sub-agent/status.js';
import { diagnoseAgentLiveness, makeLiveness } from '../sub-agent/liveness.js';

/** In-memory sub-agent registry. */
const agents = new Map();

/** Get the global agents map for other tools to access. */
export function getAgentRegistry() {
  return agents;
}

const MAIN_THREAD_ID = 'main';

function cleanString(value) {
  return (typeof value === 'string' && value.trim()) ? value.trim() : null;
}

export function getCallerAgentScope(ctx = {}) {
  const deps = ctx?.parentEngineDeps || {};
  return {
    sessionId: cleanString(deps.parentSessionId ?? ctx?.sessionId),
    parentVpId: cleanString(deps.parentVpId ?? ctx?.senderVpId),
    parentThreadId: cleanString(deps.parentThreadId ?? ctx?.threadId),
  };
}

export function agentBelongsToCaller(agent, ctx = {}) {
  if (!agent) return false;
  const scope = getCallerAgentScope(ctx);
  return agentBelongsToScope(agent, scope);
}

export function agentBelongsToScope(agent, scope = {}) {
  if (!agent) return false;
  const agentSessionId = cleanString(agent.parentSessionId);
  const scopeSessionId = cleanString(scope.sessionId);
  const agentVpId = cleanString(agent.parentVpId);
  const scopeVpId = cleanString(scope.parentVpId);
  const agentThreadId = cleanString(agent.parentThreadId);
  const scopeThreadId = cleanString(scope.parentThreadId);
  if (!scopeSessionId && !scopeVpId && !scopeThreadId) {
    return !agentSessionId && !agentVpId;
  }
  if ((agentSessionId || scopeSessionId) && agentSessionId !== scopeSessionId) return false;
  if ((agentVpId || scopeVpId) && agentVpId !== scopeVpId) return false;
  if (!agentThreadId && !scopeThreadId) return true;
  return (agentThreadId || MAIN_THREAD_ID) === (scopeThreadId || MAIN_THREAD_ID);
}

/** Reset registry (for tests). */
export function _resetAgentRegistry() {
  agents.clear();
}

/**
 * Validate a SubagentSpec. Returns { ok: true, spec } or { ok: false, error }.
 *
 * @param {object} input
 */
export function validateSpec(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'spec must be an object' };
  }
  const { name, task, mission, expected_output, persona, budget } = input;
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'name is required' };
  }
  if (!task && !mission) {
    return { ok: false, error: 'task or mission is required' };
  }
  if (persona && !getPersona(persona)) {
    return {
      ok: false,
      error: `unknown persona "${persona}"; available: ${listPersonaIds().join(', ')}`,
    };
  }
  if (expected_output !== undefined && (typeof expected_output !== 'object' || expected_output === null)) {
    return { ok: false, error: 'expected_output must be a JSON schema object' };
  }
  if (budget !== undefined) {
    if (typeof budget !== 'object' || budget === null) {
      return { ok: false, error: 'budget must be an object' };
    }
    for (const k of ['max_tokens', 'max_turns', 'wall_time_ms']) {
      if (budget[k] !== undefined && (typeof budget[k] !== 'number' || budget[k] <= 0)) {
        return { ok: false, error: `budget.${k} must be a positive number` };
      }
    }
  }
  return {
    ok: true,
    spec: {
      name,
      mission: mission || task,
      task: task || mission,
      expected_output: expected_output || null,
      persona: persona || null,
      budget: budget || null,
    },
  };
}

/**
 * Check a sub-agent's budget against current usage.
 * Returns { exceeded: true, reason } when any bound is breached, else { exceeded: false }.
 *
 * @param {{ budget: object|null, usage: { tokens: number, turns: number, startedAt: number } }} agent
 * @param {number} [now=Date.now()]
 */
export function checkBudget(agent, now = Date.now()) {
  const b = agent.budget;
  if (!b) return { exceeded: false };
  const u = agent.usage || { tokens: 0, turns: 0, startedAt: now };
  if (b.max_tokens !== undefined && u.tokens >= b.max_tokens) {
    return { exceeded: true, reason: `max_tokens (${b.max_tokens}) reached`, limit: 'max_tokens' };
  }
  if (b.max_turns !== undefined && u.turns >= b.max_turns) {
    return { exceeded: true, reason: `max_turns (${b.max_turns}) reached`, limit: 'max_turns' };
  }
  if (b.wall_time_ms !== undefined && (now - u.startedAt) >= b.wall_time_ms) {
    return { exceeded: true, reason: `wall_time_ms (${b.wall_time_ms}) exceeded`, limit: 'wall_time_ms' };
  }
  return { exceeded: false };
}

/**
 * Build a budget-exceeded result envelope.
 * @param {object} agent
 * @param {string} reason
 */
export function budgetExceededResult(agent, reason) {
  return {
    status: 'budget_exceeded',
    partial_output: agent.partial_output || agent.result || '',
    reason,
    usage: { ...(agent.usage || {}) },
  };
}

/**
 * Apply an incremental delta to an agent's usage, then check budget.
 * If exceeded: abort the agent's signal, set result to the budget envelope,
 * flip status to 'completed', and return the envelope. Otherwise returns null.
 *
 * Call this at each turn boundary inside the sub-agent's execution loop.
 *
 * @param {string} agentId
 * @param {{ tokens?: number, turns?: number, partial_output?: string }} [delta]
 * @param {number} [now=Date.now()]
 * @returns {object|null} — budget envelope if exceeded, else null
 */
export function tickAgent(agentId, delta = {}, now = Date.now()) {
  const agent = agents.get(agentId);
  if (!agent) return null;
  if (isTerminalAgentStatus(agent.status)) return null;

  if (typeof delta.tokens === 'number' && delta.tokens > 0) {
    agent.usage.tokens += delta.tokens;
  }
  if (typeof delta.turns === 'number' && delta.turns > 0) {
    agent.usage.turns += delta.turns;
  }
  if (typeof delta.partial_output === 'string' && delta.partial_output) {
    agent.partial_output = delta.partial_output;
  }

  const check = checkBudget(agent, now);
  if (!check.exceeded) return null;

  const envelope = budgetExceededResult(agent, check.reason);
  agent.result = envelope;
  agent.status = STATUS.COMPLETED;
  agent.diagnostics.push({
    type: 'budget_exceeded',
    limit: check.limit,
    reason: check.reason,
    at: now,
  });
  // Signal any in-flight sub-agent work to stop
  if (agent.abortController && !agent.abortController.signal.aborted) {
    try {
      agent.abortController.abort(check.reason);
    } catch {
      // ignore double-abort
    }
  }
  return envelope;
}

export default defineTool({
  name: 'SpawnAgent',
  aliases: ['Agent'],
  description: {
    en: `Create a sub-agent to work on an independent task in parallel.

Sub-agents run in their own context and can be given a concrete mission
with an optional expected_output schema. Optional budget limits
(max_tokens/max_turns/wall_time_ms) act as safety cutoffs only when supplied.
Pick a preset persona to pre-wire a tool subset and model tier:
  - explorer   : fast, read-only scout (Read/Grep/Glob/ListDir)
  - implementer: builder with full work tools (primary model)
  - reviewer   : read-only critic (primary model)
  - researcher : web-facing info gatherer (WebSearch/WebFetch/Read)

Guidelines:
- Give a clear, focused mission — what "done" looks like
- Use expected_output when the return shape matters
- Add a budget only when you need an explicit safety cutoff

Async orchestration:
  1. SpawnAgent  — starts the sub-agent as a background task and returns immediately.
  2. Continue    — keep working in the parent VP; do not block just to poll.
  3. ListAgents  — non-blocking status check when you need progress/liveness.
  4. PromptAgent — optional follow-up if the sub-agent is idle and needs guidance.
  5. CloseAgent  — stop or finalize a sub-agent when it is no longer needed.

Completion/failure is delivered through sub-agent notifications on later parent
turns. WaitAgent remains available only as a short compatibility poll; do not
use it as the default workflow or call it repeatedly in a loop.`,
    zh: `创建一个子 Agent 并行处理独立任务。

子 Agent 在独立上下文中运行，可给定具体 mission 和可选的 expected_output schema。
可选的预算限制（max_tokens/max_turns/wall_time_ms）仅在设置后作为安全截止。
选择预设 persona 来预配置工具子集和模型层级：
  - explorer   : 快速只读侦察（Read/Grep/Glob/ListDir）
  - implementer: 具备完整工作工具的构建者（主模型）
  - reviewer   : 只读审查者（主模型）
  - researcher : 面向网络的信息收集者（WebSearch/WebFetch/Read）

使用指南：
- 给出清晰聚焦的 mission——"完成"是什么样子
- 当返回结构重要时使用 expected_output
- 仅在需要明确安全截止时添加 budget

异步编排流程：
  1. SpawnAgent  — 启动子 Agent 作为后台任务并立即返回。
  2. Continue    — 父 VP 继续工作；不要仅仅为了轮询而阻塞。
  3. ListAgents  — 需要进度信息时的非阻塞状态检查。
  4. WaitAgent   — 短轮询（<5s）或仅在真正需要结果时才明确长等待。
  5. CloseAgent  — 完成后销毁子 Agent。

不要在循环中无终止条件地调用 WaitAgent。如果短检查后子 Agent 仍在运行，继续前进，
让 notification 在下个 turn 告知你。`
  },
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: {
          en: 'A descriptive name for the sub-agent (e.g. "test-writer", "refactor-auth")',
          zh: '子 Agent 的描述性名称（如 "test-writer"、"refactor-auth"）',
        },
      },
      task: {
        type: 'string',
        description: {
          en: 'Legacy one-line task description (used if `mission` is omitted)',
          zh: '旧式单行任务描述（当 `mission` 省略时使用）',
        },
      },
      mission: {
        type: 'string',
        description: {
          en: 'Concrete mission statement — what this agent must accomplish',
          zh: '具体任务陈述 — 该 Agent 必须完成什么',
        },
      },
      expected_output: {
        type: 'object',
        description: {
          en: 'JSON schema describing the structure the agent should return',
          zh: '描述 Agent 应返回结构的 JSON schema',
        },
      },
      persona: {
        type: 'string',
        enum: ['explorer', 'implementer', 'reviewer', 'researcher'],
        description: {
          en: 'Preset persona that pre-wires tool subset + model tier',
          zh: '预设 persona，预装工具子集和模型等级',
        },
      },
      budget: {
        type: 'object',
        properties: {
          max_tokens: { type: 'number', description: {
          en: 'Optional token ceiling; no default limit is applied',
          zh: '可选 token 上限；默认不设限制',
        } },
          max_turns: { type: 'number', description: {
          en: 'Optional turn ceiling; no default limit is applied',
          zh: '可选 turn 上限；默认不设限制',
        } },
          wall_time_ms: { type: 'number', description: {
          en: 'Optional elapsed-time ceiling in milliseconds; no default limit is applied',
          zh: '可选耗时上限（毫秒）；默认不设限制',
        } },
        },
        description: {
          en: 'Optional safety limits; no max_tokens/max_turns/wall_time_ms defaults are applied. Exceeding an explicit limit returns { status: "budget_exceeded", partial_output, reason }',
          zh: '可选安全限制；默认不限制 max_tokens/max_turns/wall_time_ms。超过显式限制会返回 { status: "budget_exceeded", partial_output, reason }',
        },
      },
      cwd: {
        type: 'string',
        description: {
          en: 'Working directory for the sub-agent (optional, defaults to parent cwd)',
          zh: '子 Agent 的工作目录（可选，默认使用父级当前工作目录）',
        },
      },
    },
    required: ['name'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    // NB: every envelope below puts `next_steps` (or `error_next_steps`) at
    // the FIRST position because `agent/yeaft/tools/registry.js` caps tool
    // output by chopping the tail at its model-context cap. Tail-positioned nudges get
    // truncated when the rest of the envelope is large.
    const ERROR_NEXT_STEPS =
      'That call failed — see `error`. Either correct the arguments and ' +
      'retry, or tell the user what went wrong. Do NOT end your turn ' +
      'silently after an error envelope.';

    const validation = validateSpec(input);
    if (!validation.ok) {
      return JSON.stringify({ next_steps: ERROR_NEXT_STEPS, error: validation.error });
    }
    const spec = validation.spec;
    const { name, cwd } = input;
    const callerScope = getCallerAgentScope(ctx);

    // Check for name collision — any non-terminal agent with the same
    // name blocks the new spawn. Terminal agents (closed/failed/abandoned/
    // completed) free the name up for reuse. Scope this to the caller's
    // Session/VP/thread so independent sessions can reuse natural names.
    for (const [, agent] of agents) {
      if (agent.name === name && !isTerminalAgentStatus(agent.status)
        && agentBelongsToScope(agent, callerScope)) {
        return JSON.stringify({
          next_steps: ERROR_NEXT_STEPS,
          error: `Agent "${name}" already exists. Close it first or use a different name.`,
          agentId: agent.id,
        });
      }
    }

    const persona = spec.persona ? getPersona(spec.persona) : null;
    const now = Date.now();
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    const agent = {
      id: agentId,
      name,
      task: spec.task,
      mission: spec.mission,
      expected_output: spec.expected_output,
      persona: spec.persona,
      personaData: persona || null,
      budget: spec.budget,
      cwd: cwd || ctx?.cwd || process.cwd(),
      status: STATUS.CREATED,
      messages: [],
      result: null,
      lastResult: '',
      partial_output: '',
      diagnostics: [],
      usage: { tokens: 0, turns: 0, startedAt: now },
      createdAt: now,
      trace: [],
      // Liveness counters — kept fresh by the runner from each sub-engine
      // event so WaitAgent/ListAgents can show real-time progress.
      liveness: makeLiveness(),
      // Path to the durable JSONL event log. Populated by the runner
      // when startSubAgent attaches createOutputLog(); we initialize to
      // null so the field always exists on the record shape.
      outputFile: null,
      // ParentVpId is mirrored from deps when the driver starts so the
      // notification queue can bucket by parent Session/VP/thread.
      parentVpId: callerScope.parentVpId,
      parentSessionId: callerScope.sessionId,
      parentThreadId: callerScope.parentThreadId,
      abortController: new AbortController(),
    };

    agents.set(agentId, agent);

    // Actually spawn the sub-agent driver. This is fire-and-forget;
    // it returns immediately. The parent observes via WaitAgent (which
    // surfaces status + liveness + outputFile) or via the engine's
    // sub-agent event sink (live UI streaming).
    const deps = ctx?.parentEngineDeps;
    if (deps && deps.adapter) {
      try {
        const task = ctx?.taskManager?.startTask?.({
          sessionId: callerScope.sessionId || ctx?.sessionId || 'default',
          ownerVpId: callerScope.parentVpId || ctx?.currentVpId || null,
          kind: 'sub_agent',
          title: spec.mission || spec.task || name,
          runtime: { subAgentId: agentId, name, cwd: agent.cwd },
          source: { threadId: callerScope.parentThreadId || ctx?.threadId || 'main' },
        });
        if (task?.id) {
          agent.taskId = task.id;
          // Same-turn parking — see tools/bash.js for the contract. The
          // sub-agent runs in its own engine but reports completion
          // through the same TaskManager event, so the spawning turn
          // stays parked until the sub-agent finishes.
          try { ctx.registerAsyncTask?.(task.id); } catch { /* coord errors must not block spawn */ }
        }
        startSubAgent(agent, deps);
      } catch (err) {
        agent.status = STATUS.FAILED;
        agent.error = err && err.message ? err.message : String(err);
        agent.diagnostics.push({ type: 'spawn_error', error: agent.error, at: Date.now() });
        return JSON.stringify({
          next_steps: ERROR_NEXT_STEPS,
          error: `Failed to start sub-agent: ${agent.error}`,
          agentId,
        });
      }
    } else {
      // No parent engine deps — caller is in a non-engine context (legacy
      // tests). Leave the record in 'created' so existing tests still work.
    }

    const liveness = diagnoseAgentLiveness(agent);
    return JSON.stringify({
      next_steps:
        'Sub-agent is running in the background. Continue the parent task; ' +
        'use ListAgents for a non-blocking status check, PromptAgent only ' +
        'when the sub-agent is idle and needs more input, and rely on ' +
        'completion notifications on later turns. Do not call WaitAgent in a loop.',
      success: true,
      agentId,
      name,
      persona: spec.persona || null,
      budget: spec.budget || null,
      status: agent.status,
      outputFile: agent.outputFile || null,
      taskId: agent.taskId || null,
      liveness,
      stale: liveness.stale,
      stalled: liveness.stalled,
      message: `Sub-agent "${name}" spawned (${agentId}) as an async background task. Use ListAgents to monitor it without blocking. Read \`outputFile\` for the durable event log at any time.`,
    });
  },
});
