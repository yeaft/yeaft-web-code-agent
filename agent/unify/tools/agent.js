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

/** In-memory sub-agent registry. */
const agents = new Map();

/** Get the global agents map for other tools to access. */
export function getAgentRegistry() {
  return agents;
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
  if (agent.status === 'completed' || agent.status === 'closed') return null;

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
  agent.status = 'completed';
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
  name: 'Agent',
  description: `Create a sub-agent to work on an independent task in parallel.

Sub-agents run in their own context and can be given a concrete mission
with an expected_output schema and a budget (max_tokens/max_turns/wall_time_ms).
Pick a preset persona to pre-wire a tool subset and model tier:
  - explorer   : fast, read-only scout (Read/Grep/Glob/ListDir)
  - implementer: builder with full work tools (primary model)
  - reviewer   : read-only critic (primary model)
  - researcher : web-facing info gatherer (WebSearch/WebFetch/Read)

Guidelines:
- Give a clear, focused mission — what "done" looks like
- Use expected_output to pin the structure you want back
- Always set a budget for unbounded missions
- Use SendMessage to communicate, WaitAgent to collect results, CloseAgent to finalize`,
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'A descriptive name for the sub-agent (e.g. "test-writer", "refactor-auth")',
      },
      task: {
        type: 'string',
        description: 'Legacy one-line task description (used if `mission` is omitted)',
      },
      mission: {
        type: 'string',
        description: 'Concrete mission statement — what this agent must accomplish',
      },
      expected_output: {
        type: 'object',
        description: 'JSON schema describing the structure the agent should return',
      },
      persona: {
        type: 'string',
        enum: ['explorer', 'implementer', 'reviewer', 'researcher'],
        description: 'Preset persona that pre-wires tool subset + model tier',
      },
      budget: {
        type: 'object',
        properties: {
          max_tokens: { type: 'number' },
          max_turns: { type: 'number' },
          wall_time_ms: { type: 'number' },
        },
        description: 'Budget limits; exceeding any returns { status: "budget_exceeded", partial_output, reason }',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the sub-agent (optional, defaults to parent cwd)',
      },
    },
    required: ['name'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const validation = validateSpec(input);
    if (!validation.ok) return JSON.stringify({ error: validation.error });
    const spec = validation.spec;
    const { name, cwd } = input;

    // Check for name collision
    for (const [, agent] of agents) {
      if (agent.name === name && agent.status !== 'closed') {
        return JSON.stringify({
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
      status: 'created',
      messages: [],
      result: null,
      partial_output: '',
      diagnostics: [],
      usage: { tokens: 0, turns: 0, startedAt: now },
      createdAt: now,
      trace: [],
      abortController: new AbortController(),
    };

    agents.set(agentId, agent);

    return JSON.stringify({
      success: true,
      agentId,
      name,
      persona: spec.persona || null,
      budget: spec.budget || null,
      message: `Sub-agent "${name}" created (${agentId}). Use SendMessage to give it work.`,
    });
  },
});
