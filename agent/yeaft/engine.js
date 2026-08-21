/**
 * engine.js — Yeaft query loop
 *
 * The engine is the core orchestrator:
 *   1. Before first turn: recall memories → inject into system prompt
 *   2. Build messages array from persisted history and the current prompt
 *   3. Call adapter.stream()
 *   4. Collect text + tool_calls from stream events
 *   5. If tool_calls → execute tools → append results → goto 3
 *   6. Persist each completed message at its durability boundary
 *   7. If max_tokens → auto-continue (up to maxContinueTurns)
 *   8. On LLMContextError → fail the turn; no summary or hidden maintenance call
 *   9. On retryable error with fallbackModel → switch model → retry
 *
 * Pattern derived from Claude Code's query loop (src/query.ts).
 *
 * Reference: yeaft-yeaft-implementation-plan.md §3.1, §4 (Phase 2)
 */

import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { buildSystemPrompt, buildWorkerPrompt } from './prompts.js';
import { getRuntimePlatformInfo } from './runtime-platform.js';
import { LLMAbortError, LLMAuthError, LLMPolicyError, LLMRateLimitError, LLMServerError, LLMStreamIdleTimeoutError } from './llm/adapter.js';
import { runMemoryPreflow, buildRelevantScopes, memoryScopeLabel } from './sessions/pre-flow.js';
import {
  readProjectDoc,
  pickProjectDocFile,
  selectProjectDocContext,
  projectDocPathHintsFromToolCall,
  projectDocWriteScopesNeedingReload,
  DEFAULT_PROJECT_DOC_MAX_BYTES,
} from './sessions/project-doc.js';
import { archiveToolResults } from './archive/tool-results.js';
import { trimSnapshotForBudget } from './history-window.js';
import { isVpForeign, readContent as readScopeContent } from './memory/store.js';
import { ActiveMemorySet } from './memory/ams.js';
import { cleanMemoryPromptText } from './memory/prompt-cleanup.js';
import { isVpSeedBackfillStub } from './memory/seed-backfill.js';
import { boundRawExchange, perfNowMs, recordAgentPerfTrace } from './perf-trace.js';
// Default thread marker for legacy / non-group flows. Group VP runtime may
// pass a real threadId per (sessionId, vpId, threadId) engine instance.
const MAIN_THREAD_ID = 'main';
import { pickEffort, parseEffortPrefix } from './effort.js';
import { DEFAULT_CONTEXT_WINDOW, normalizeEffort, resolveContextWindow, resolveModel } from './models.js';
import { lookupModelLimitSync } from './llm/models-dev.js';
import { attachRouterPlan, extractPriorPlan, stripMetaForWire } from './router/continuity.js';
import { resolveThinking } from './router/thinking.js';
import { approxTokens, computeBudget } from './memory/budget.js';
import { COLLAB_TOOL_POLICY, isToolErrorOutput, localizeVisibleText, normalizeToolOutput, truncateToolResultIfNeeded } from './tools/registry.js';
import { CONDITIONAL_BUILTIN_TOOL_NAMES, resolveActiveToolNames } from './tools/activation.js';
import { discoverToolCapabilities } from './tools/discover-tools.js';
import { agentBelongsToScope, getAgentRegistry } from './tools/agent.js';
import { createPluginSkillManager } from './plugins.js';
import { extractDisplayImages, stripDisplayImageData } from './image-assets.js';
import { acknowledgePendingNotifications, formatNotificationsForPrompt, peekPendingNotifications } from './sub-agent/notifications.js';
import {
  TOOL_BATCH_SIZE,
  TURN_SUMMARY_THRESHOLD,
  DUP_TOOL_THRESHOLD,
  ExecLog,
  buildEntry as buildExecLogEntry,
  argsHashOf,
  runT1Reflection,
  runT2Reflection,
  buildFallbackStub,
  collapseRangeToReflection,
  buildDuplicateReminder,
  extractToolPairsFromRange,
} from './tool-folding/index.js';

/**
 * task-324 — Turn cap removed.
 *
 * Previously MAX_TURNS=25 broke the query loop out of long tool-driven
 * conversations (user report: Yeaft loop errored at the cap). The engine
 * now runs until the LLM itself returns stopReason='end_turn' or a
 * non-retryable error surfaces. Real runaway loops are still bounded by:
 *   • provider rate limits / context window (LLMContextError is surfaced)
 *   • user-initiated abort (AbortController / cancel)
 *   • MAX_CONTINUE_TURNS for the max_tokens auto-continue path
 */

/** Maximum auto-continue turns when stopReason is 'max_tokens'. */
const MAX_CONTINUE_TURNS = 3;

/**
 * Keep one provider tool batch from opening an unbounded number of filesystem,
 * network, or subprocess reads. Only tools whose metadata explicitly declares
 * both read-only and concurrency-safe execution enter this lane.
 */
const MAX_CONCURRENT_READ_ONLY_TOOLS = 4;

/** Maximum silence while a visible turn waits for a result-producing task. */
const DEFAULT_ASYNC_TASK_WAIT_TIMEOUT_MS = 120_000;

const DEFAULT_MEMORY_RECALL_LIMIT = 8;
const MAX_PROMPT_MEMORY_ITEMS = 8;
const MAX_RELATED_SESSION_MEMORY_ITEMS = 2;
const MAX_MEMORY_ITEM_TOKENS = 1600;

function toolDefinitionFor(engine, name) {
  return engine.getToolDefinition(name);
}

function isReadOnlyTool(engine, name, input) {
  try {
    return toolDefinitionFor(engine, name)?.isReadOnly?.(input) === true;
  } catch {
    return false;
  }
}

function isConcurrencySafeTool(engine, name, input) {
  try {
    const tool = toolDefinitionFor(engine, name);
    return tool?.isReadOnly?.(input) === true
      && tool?.isConcurrencySafe?.(input) === true;
  } catch {
    return false;
  }
}

function isCacheableTool(engine, name, input) {
  try {
    const tool = toolDefinitionFor(engine, name);
    if (!tool || !isReadOnlyTool(engine, name, input)) return false;
    return typeof tool.cacheWithinQuery === 'function'
      ? tool.cacheWithinQuery(input) === true
      : tool.cacheWithinQuery === true;
  } catch {
    return false;
  }
}

function mayMutateWorkspaceAfterReturn(engine, name, input) {
  try {
    const value = toolDefinitionFor(engine, name)?.mayMutateWorkspaceAfterReturn;
    return typeof value === 'function' ? value(input) === true : value === true;
  } catch {
    return true;
  }
}

// ─── LLM retry policy defaults ──────────────────────────────────
// Hard-coded floor / ceiling for retry behaviour. The engine reads the
// effective policy from `config.llmRetry` so users can dial these via
// ~/.yeaft/config.json without touching code; the constants here are the
// fallback when the config is missing or partial.
//   • maxRetries:     how many times we re-issue the same turn on a
//                     retryable failure before giving up / falling back
//   • baseDelayMs:    starting backoff for transient (5xx / network) errors
//   • maxDelayMs:     ceiling we never exceed regardless of backoff growth
//   • jitterRatio:    ± random fraction of the delay (0.25 = ±25 %)
// Rate-limit waits prefer the server's Retry-After header; we only fall
// back to exponential backoff when the header is missing.
const RETRY_DEFAULTS = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
  forbiddenRetryDelaysMs: [30_000, 120_000],
});

const RETRY_CONTINUATION_PROMPT =
  'Continue from the exact point where the previous response stopped. Do not repeat text already produced.';
const POLICY_RECOVERY_PROMPT =
  'Continue this authorized code review, but describe security findings abstractly. Do not repeat credential-like or exploit payloads, secrets, tokens, or step-by-step misuse instructions. Preserve the technical conclusion, evidence location, severity, and remediation.';

// Accept legacy namespaced commands and Claude Code-style bare skill commands.
// Project-tier skills are shown as /<skill-name>; /yeaft-skills:<name> and
// /skill:<name> stay supported for globals, older clients, and typed history.
const PREFIXED_SKILL_COMMAND_RE = /^\/(?:skill|yeaft-skills):([^\s]+)(\s+|$)/;
const BARE_SKILL_COMMAND_RE = /^\/([A-Za-z0-9][A-Za-z0-9_.-]*)(\s+|$)/;

function skillManagerHasSkill(skillManager, name) {
  if (!skillManager || !name) return false;
  if (typeof skillManager.has === 'function') return !!skillManager.has(name);
  return false;
}

function parseExplicitSkillCommand(prompt, skillManager) {
  if (typeof prompt !== 'string') {
    return { skillName: null, cleanedPrompt: prompt };
  }
  const prefixed = prompt.match(PREFIXED_SKILL_COMMAND_RE);
  if (prefixed) {
    return {
      skillName: prefixed[1],
      cleanedPrompt: prompt.slice(prefixed[0].length),
    };
  }

  const bare = prompt.match(BARE_SKILL_COMMAND_RE);
  if (bare && skillManagerHasSkill(skillManager, bare[1])) {
    return {
      skillName: bare[1],
      cleanedPrompt: prompt.slice(bare[0].length),
    };
  }
  return { skillName: null, cleanedPrompt: prompt };
}

function stripLeadingSkillCommandFromPromptParts(promptParts, skillManager) {
  if (!Array.isArray(promptParts) || promptParts.length === 0) return promptParts;
  let stripped = false;
  return promptParts.map(part => {
    if (stripped || !part || part.type !== 'text' || typeof part.text !== 'string') {
      return part;
    }
    const parsed = parseExplicitSkillCommand(part.text, skillManager);
    if (!parsed.skillName) return part;
    stripped = true;
    return { ...part, text: parsed.cleanedPrompt };
  });
}

function resolveSkillPromptState({ skillManager, prompt, explicitSkillName }) {
  let resolvedSkillContent = '';
  let resolvedSkills = [];
  let skillResolutionError = null;
  if (!skillManager) {
    return { resolvedSkillContent, resolvedSkills, skillResolutionError };
  }

  if (explicitSkillName) {
    resolvedSkillContent = skillManager.getPromptContent(explicitSkillName);
    const skill = skillManager.list?.().find(item => item.name === explicitSkillName)
      || (resolvedSkillContent ? { name: explicitSkillName } : null);
    if (resolvedSkillContent && skill) {
      resolvedSkills = [{ ...skill, explicit: true }];
    } else {
      skillResolutionError = `Requested skill "${explicitSkillName}" was not found.`;
      resolvedSkillContent = `## Skill command error\n\n${skillResolutionError} Continue without that skill and tell the user it is unavailable.`;
    }
  } else if (prompt && typeof skillManager.findRelevant === 'function') {
    resolvedSkills = skillManager.findRelevant(prompt).map(skill => ({
      name: skill.name,
      description: skill.description || '',
      trigger: skill.trigger || '',
      category: skill.category,
      tier: skill._tier,
      explicit: false,
    }));
    resolvedSkillContent = resolvedSkills.map(skill => skillManager.getPromptContent(skill.name)).join('\n\n');
  }

  return { resolvedSkillContent, resolvedSkills, skillResolutionError };
}

function resolveRetryPolicy(config) {
  const raw = config?.llmRetry || {};
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  const forbiddenRetryDelaysMs = Array.isArray(raw.forbiddenRetryDelaysMs)
    ? raw.forbiddenRetryDelaysMs
      .filter(v => Number.isFinite(v) && v >= 0)
      .slice(0, 3)
      .map(v => Math.min(600_000, Math.floor(v)))
    : RETRY_DEFAULTS.forbiddenRetryDelaysMs;
  return {
    maxRetries: Math.max(0, Math.floor(num(raw.maxRetries, RETRY_DEFAULTS.maxRetries))),
    baseDelayMs: Math.max(0, Math.floor(num(raw.baseDelayMs, RETRY_DEFAULTS.baseDelayMs))),
    maxDelayMs: Math.max(0, Math.floor(num(raw.maxDelayMs, RETRY_DEFAULTS.maxDelayMs))),
    jitterRatio: Math.min(1, Math.max(0, num(raw.jitterRatio, RETRY_DEFAULTS.jitterRatio))),
    forbiddenRetryDelaysMs,
  };
}

/**
 * Compute the next backoff delay (ms) for a transient error.
 * Exponential growth (base * 2^attempt) capped at maxDelayMs, with optional
 * +/- jitter to avoid synchronized retry stampedes.
 *
 * @param {{ baseDelayMs: number, maxDelayMs: number, jitterRatio: number }} policy
 * @param {number} attempt - 0-indexed retry attempt (0 = first retry)
 * @returns {number} milliseconds to sleep
 */
export function computeBackoffDelay(policy, attempt) {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const grown = policy.baseDelayMs * Math.pow(2, safeAttempt);
  const capped = Math.min(policy.maxDelayMs, grown);
  if (policy.jitterRatio <= 0) return capped;
  const jitter = capped * policy.jitterRatio;
  const offset = (Math.random() * 2 - 1) * jitter; // [-jitter, +jitter]
  return Math.max(0, Math.round(capped + offset));
}

/**
 * Promise-based sleep that resolves early if the caller's AbortSignal fires.
 * Returns true when the sleep completed normally, false when aborted.
 *
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<boolean>}
 */
function sleepWithAbort(ms, signal) {
  if (ms <= 0) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(false);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * task-331 — Map a conversationMessages entry into the snapshot shape used
 * by `debug_turn.messages`. Preserves the function-calling metadata that
 * the Debug panel needs to render:
 *   - `toolCalls` on assistant turns (the LLM's function_call requests)
 *   - `toolCallId` + `isError` on tool turns (the paired tool_result)
 *
 * Content is kept intact for the live protocol. The file-backed debug trace
 * applies its own configured byte budget at persistence time so the model
 * request path never pays an extra copy just for diagnostics.
 *
 * Pure function — no side effects on the input message.
 *
 * @param {{ role: string, content?: any, toolCalls?: Array, toolCallId?: string, isError?: boolean }} m
 * @returns {{ role: string, content: any, toolCalls?: Array, toolCallId?: string, isError?: boolean }}
 */
export function mapDebugMessage(m) {
  const out = { role: m.role };
  out.content = m.content;
  if (m.rawRequest != null) out.rawRequest = m.rawRequest;
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    out.toolCalls = m.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
    }));
  }
  if (m.toolCallId) out.toolCallId = m.toolCallId;
  if (m.isError != null) out.isError = m.isError;
  return out;
}

/**
 * task-704b — estimate the total token cost of a system prompt + a
 * messages array. Used by the pre-flight guard before adapter.stream()
 * to decide whether to run an emergency archive sweep.
 *
 * Why estimate, not exact: a real tokenizer (tiktoken, claude-tokenizer)
 * adds a heavy dep + per-turn cost for what is fundamentally a guard
 * rail. `approxTokens` (char/4 with CJK weighting) is the same
 * estimator the AMS budget code uses; it is monotonic in payload size
 * and that is the only property the guard rail needs. False positives
 * cost an unnecessary archive sweep (cheap); false negatives let a
 * runaway request through (expensive — that is exactly the bug we are
 * fixing).
 *
 * Multi-modal messages: `content` may be an array of content parts
 * (Anthropic / OpenAI Responses shape). Text parts use approxTokens;
 * image parts get a fixed 1024-token estimate — a rough average across
 * vision pricing models. Exact pricing isn't the goal; "this is roughly
 * how much of the window the message will consume" is.
 *
 * @param {string} system
 * @param {Array<{role:string, content?:any, toolCalls?:Array}>} messages
 * @returns {number}
 */
export function estimateMessagesTokens(system, messages) {
  let total = approxTokens(typeof system === 'string' ? system : '');
  if (!Array.isArray(messages)) return total;
  for (const m of messages) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === 'string') {
      total += approxTokens(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (!part) continue;
        if (part.type === 'text') {
          // Coerce defensively — a non-string `text` (number, Buffer,
          // object) would otherwise throw inside approxTokens and abort
          // the pre-flight estimate, defeating the guard rail.
          total += approxTokens(typeof part.text === 'string' ? part.text : '');
        } else if (part.type === 'image') {
          total += 1024;
        }
        // Other multi-modal parts (audio etc.) — skip; not produced today.
      }
    }
    if (Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) {
        try {
          total += approxTokens(JSON.stringify(tc.input || {}));
        } catch { /* circular — ignore */ }
        total += approxTokens(typeof tc.name === 'string' ? tc.name : '');
      }
    }
  }
  return total;
}

export const GROUP_CONTEXT_PRESSURE_RATIO = 0.8;

export function shouldAllowGroupReflection({
  system = '',
  messages = [],
  model = null,
  config = {},
  sessionId = null,
} = {}) {
  if (!sessionId) {
    return {
      allowed: true,
      tokenEstimate: estimateMessagesTokens(system, messages),
      threshold: 0,
      contextWindow: null,
      ratio: GROUP_CONTEXT_PRESSURE_RATIO,
      usedFallbackContextWindow: false,
    };
  }
  const contextWindow = resolveContextWindow(model, config);
  // Telemetry: did the resolver hit either of its top non-default rungs?
  // Used by `usedFallbackContextWindow` below — if neither models.dev nor
  // the global config provided a number, we fell through to DEFAULT and
  // callers may want to surface that to the user.
  const hasModelsDevContext = !!lookupModelLimitSync(model, resolveModel(model)?.provider || null)?.context;
  const hasConfigContext = Number.isFinite(config?.maxContextTokens) && config.maxContextTokens > 0;
  const threshold = Math.floor(contextWindow * GROUP_CONTEXT_PRESSURE_RATIO);
  const tokenEstimate = estimateMessagesTokens(system, messages);
  const overThreshold = tokenEstimate >= threshold;
  return {
    // Group send defaults to no reflection. Trust the model until context
    // pressure says we are near the model window.
    allowed: overThreshold,
    tokenEstimate,
    threshold,
    contextWindow,
    ratio: GROUP_CONTEXT_PRESSURE_RATIO,
    usedFallbackContextWindow: !hasModelsDevContext && !hasConfigContext && contextWindow === DEFAULT_CONTEXT_WINDOW,
  };
}

// ─── Engine Events (superset of adapter events) ──────────────────

/**
 * @typedef {{ type: 'turn_start', turnNumber: number }} TurnStartEvent
 * @typedef {{ type: 'turn_end', turnNumber: number, stopReason: string, terminal?: boolean }} TurnEndEvent
 * @typedef {{ type: 'tool_start', id: string, name: string, input: object }} ToolStartEvent
 * @typedef {{ type: 'tool_end', id: string, name: string, output: string, isError: boolean, skipped?: boolean }} ToolEndEvent
 * @typedef {{ type: 'recall', entryCount: number, cached: boolean }} RecallEvent
 * @typedef {{ type: 'fallback', from: string, to: string, reason: string }} FallbackEvent
 * @typedef {{ type: 'llm_retry', attempt: number, maxRetries: number, delayMs: number, reason: 'rate_limit_retry_after'|'rate_limit_backoff'|'transient_backoff'|'stream_idle_timeout', recoveryMode: 'restart'|'continue', errorName: string, statusCode: number|null, message: string }} LlmRetryEvent
 * @typedef {{ type: 'error', error: Error, retryable: boolean, reason?: 'stream_idle_timeout', retryExhausted?: boolean, retryAttempts?: number, maxRetries?: number }} ErrorEvent
 *
 * @typedef {import('./llm/adapter.js').StreamEvent | TurnStartEvent | TurnEndEvent | ToolStartEvent | ToolEndEvent | RecallEvent | FallbackEvent | LlmRetryEvent | ErrorEvent} EngineEvent
 */

// ─── Engine ──────────────────────────────────────────────────────

/**
 * buildResidentEntries — pure helper that builds the AMS Resident entry
 * list from per-turn query-selected canonical content.
 *
 * Encodes one non-trivial rule on top of "push if non-empty":
 *
 *   The `vp/<ownVpId>` summary is skipped when it carries the
 *   seed-backfill stub marker. The persona body is already rendered as
 *   Section 1 of the system prompt by `renderVpPersona`; surfacing the
 *   stub's `# Name / Role` line as a Resident entry would re-label the
 *   same identity in Section 6 ("Active Memory Set") with no added
 *   information — the visible follow-up to the persona-dup bug fixed in
 *   PR #722. Once Dream-v2 writes a real summary for this scope it
 *   lacks the marker and is surfaced normally.
 *
 * Other-VP entries (Session collaborators) are NOT considered here — only
 * the local VP's summary is loaded into `summaries.vp` upstream. FTS evidence
 * selects canonical topic content but is never itself rendered into the prompt.
 *
 * @param {{
 *   sessionId?: string|null,
 *   ownVpId?: string|null,
 *   summaries: { user?: string, session?: string, sessionScope?: string, vp?: string, vpScope?: string, topics?: Array<{scope:string, summary:string}>, relatedSessions?: Array<{sessionId:string, summary:string}> }
 * }} args
 * @returns {Array<{scope: string, summary: string}>}
 */
export function selectResidentTopicScopes(topicScopes, recallEntries) {
  const available = new Set(Array.isArray(topicScopes) ? topicScopes : []);
  const selected = [];
  for (const entry of recallEntries || []) {
    const scope = typeof entry?.scope === 'string' ? entry.scope : '';
    if (!/^(?:sessions|session|group)\/[^/]+\/topic\//.test(scope)) continue;
    if (!available.has(scope) || selected.includes(scope)) continue;
    selected.push(scope);
  }
  return selected;
}

export function selectCanonicalMemoryScopes(recallEntries) {
  const selected = new Set();
  for (const entry of recallEntries || []) {
    const scope = typeof entry?.scope === 'string' ? entry.scope.trim() : '';
    if (scope) selected.add(scope);
  }
  return selected;
}

export function selectRelatedSessionIds(projectSessionIds, recallEntries) {
  const candidates = new Set((Array.isArray(projectSessionIds) ? projectSessionIds : [])
    .filter(id => typeof id === 'string' && id.trim())
    .map(id => id.trim()));
  const selected = [];
  for (const entry of recallEntries || []) {
    const id = sessionIdFromMemoryScope(entry?.scope);
    if (!id || !candidates.has(id) || selected.includes(id)) continue;
    selected.push(id);
    if (selected.length >= MAX_RELATED_SESSION_MEMORY_ITEMS) break;
  }
  return selected;
}

export function buildResidentEntries(args) {
  const summaries = (args && args.summaries) || {};
  const out = [];
  const userSummary = cleanMemoryPromptText(summaries.user);
  const sessionSummary = cleanMemoryPromptText(summaries.session);
  const vpSummary = cleanMemoryPromptText(summaries.vp);
  if (userSummary) out.push({ scope: 'user', summary: userSummary });
  if (args.sessionId && sessionSummary) {
    out.push({
      scope: summaries.sessionScope || `sessions/${args.sessionId}`,
      summary: sessionSummary,
    });
  }
  if (args.sessionId && Array.isArray(summaries.topics)) {
    for (const topic of summaries.topics) {
      const summary = cleanMemoryPromptText(topic?.summary);
      if (topic?.scope && summary) out.push({ scope: topic.scope, summary });
    }
  }
  // VP per-session isolation (2026-06-09): the VP summary scope MUST be
  // session-qualified. The legacy bare `vp/<id>` scope was a structural
  // mismatch, so labelling it `vp/<id>`
  // in the Resident layer (a) collides with the ACL regex in store
  // (which only recognises `<root>/<sid>/vp/...`) and (b) makes the same
  // VP persona leak across DIFFERENT sessions whenever the AMS rehydrates
  // by id rather than by full scope path. The session-qualified form
  // makes the per-session boundary explicit and matches the on-disk
  // layout 1:1.
  if (args.sessionId && args.ownVpId && vpSummary && !isVpSeedBackfillStub(vpSummary)) {
    out.push({
      scope: summaries.vpScope || `sessions/${args.sessionId}/vp/${args.ownVpId}`,
      summary: vpSummary,
    });
  }
  // Related Session experience is useful but lower-priority than every memory
  // source owned by the active Session/VP. Append it last so the resident
  // budget can never evict current context in favour of historical prose.
  if (Array.isArray(summaries.relatedSessions)) {
    for (const related of summaries.relatedSessions) {
      const relatedSessionId = typeof related?.sessionId === 'string' ? related.sessionId.trim() : '';
      const summary = cleanMemoryPromptText(related?.summary);
      if (relatedSessionId && relatedSessionId !== args.sessionId && summary) {
        out.push({ scope: `sessions/${relatedSessionId}`, summary });
      }
    }
  }
  return out;
}

function isZhRuntimeLanguage(language) {
  return String(language || '').toLowerCase().startsWith('zh');
}

function sessionIdFromMemoryScope(scope) {
  const match = /^(?:sessions|session|group)\/([^/]+)(?:\/|$)/.exec(String(scope || ''));
  return match ? match[1] : null;
}

function resolveMemoryRecallLimit(config) {
  const raw = config?.memoryRecallLimit ?? config?.dreamMemoryRecallLimit;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MEMORY_RECALL_LIMIT;
  return Math.max(1, Math.floor(raw));
}

function loadedMemoryDebugEntries(snapshot) {
  const snap = snapshot || {};
  return [
    ...loadedResidentDebugEntries(snap.resident || []),
    ...loadedSegmentDebugEntries(snap.recent || [], 'recent'),
    ...loadedSegmentDebugEntries(snap.onDemand || [], 'onDemand'),
  ];
}

function loadedResidentDebugEntries(entries) {
  return (entries || []).map((entry, index) => ({
    id: `resident:${entry.scope || index}`,
    layer: 'resident',
    scope: entry.scope || null,
    label: memoryScopeLabel(entry.scope || ''),
    kind: 'summary',
    score: null,
    tags: [],
    category: entry.category || null,
    body: entry.summary || '',
  })).filter(entry => entry.body);
}

function loadedSegmentDebugEntries(segments, layer) {
  return (segments || []).map((seg, index) => ({
    id: seg.id || `${layer}:${index}`,
    layer,
    scope: seg.scope || null,
    label: memoryScopeLabel(seg.scope || ''),
    kind: seg.kind || null,
    score: typeof seg.score === 'number' ? seg.score : null,
    tags: Array.isArray(seg.tags) ? seg.tags : [],
    body: seg.body || '',
  })).filter(entry => entry.body);
}

export class Engine {
  /** @type {import('./llm/adapter.js').LLMAdapter} */
  #adapter;

  /** @type {import('./debug-trace.js').DebugTrace | import('./debug-trace.js').NullTrace} */
  #trace;

  /** @type {object} */
  #config;

  /** @type {Map<string, { name: string, description: string, parameters: object, execute: function }>} */
  #tools;

  /** @type {string} */
  #traceId;

  /** @type {import('./conversation/persist.js').ConversationStore|null} */
  #conversationStore;

  /** @type {import('./memory/index-db.js').SegmentIndex|null} — GC.1: SQLite FTS5 segment index */
  #memoryIndex;

  /** @type {import('./memory/ams-registry.js').AmsRegistry|null} — Session-keyed AMS cache */
  #amsRegistry;

  /** @type {import('./tools/registry.js').ToolRegistry|null} */
  #toolRegistry;

  /** @type {import('./tasks/manager.js').TaskManager|null} */
  #taskManager;

  /** @type {import('./skills.js').SkillManager|null} */
  #skillManager;

  /** @type {import('./skills.js').SkillManager|null} */
  #baseSkillManager;

  /** @type {import('./mcp.js').MCPManager|null} */
  #mcpManager;

  /** @type {string|null} */
  #yeaftDir;

  /** @type {Promise<Array>|null} */
  #managedCliReady;
  /** @type {string|null} — set when this engine is bound to a specific group (per-VP fan-out path). */
  #sessionId = null;
  /** @type {string|null} — set when this engine is bound to a specific VP (per-VP fan-out path). */
  #vpId = null;
  /** @type {string|null} — set when this engine is bound to a chat session (Chat Mode). */
  #chatId = null;

  /** @type {import('./stats/tool-usage.js').ToolUsageStats|null} — per-tool call/latency counters */
  #toolStats = null;

  /** @type {((agentId: string, evt: object) => void) | null} */
  #subAgentEventSink = null;

  // (removed 2026-05-13) `#currentFeatureIdAccessor` — sub-agent
  // feature-inheritance plumbing that went with the Feature system.

  /**
   * task-325a — abort state.
   *
   * The engine exposes a first-class abort surface: `engine.abort(reason)`
   * aborts the currently running `query()` loop. Internally we keep:
   *
   *   • `#currentAbortCtrl` — the per-query AbortController created (or
   *     reused from the caller's signal) when query() starts. Used to
   *     propagate abort to the LLM adapter stream and to tool execution.
   *   • `#abortReason`       — the reason string passed to abort(), surfaced
   *     on the emitted `aborted` event so the UI can render a meaningful
   *     stop banner (`user`, `timeout`, `thread_reset`, etc.).
   *
   * State machine convergence: when the signal fires, the loop catches the
   * LLMAbortError (or a synthetic abort check) and yields exactly one pair
   * of events — `{type:'aborted', reason}` followed by
   * `{type:'turn_end', stopReason:'aborted'}` — then returns without
   * running consolidation or other terminal maintenance. Any assistant text
   * already streamed is durably recorded as an incomplete response.
   *
   * @type {AbortController|null}
   */
  #currentAbortCtrl = null;

  /**
   * PR-L — V7 Tool History Reflection state. Owned per Engine instance.
   *
   *   • `#execLog` — append-only log of every tool execution, used for
   *     fallback-stub generation and duplicate-call detection. Persists
   *     to <yeaftDir>/tool-log/<traceId>/<turnIdx>.jsonl when yeaftDir
   *     is set; in-memory only otherwise.
   *   • `#pendingT2` — Map<turnNumber, { promise, loopRange, count, ... }>
   *     keyed by the turn number that triggered T2. The next query() call
   *     non-blocking-checks this map; if the promise has resolved, the
   *     prior turn's history is rewritten with the reflection. If still
   *     pending, the engine falls back to the exec-log stub.
   *   • `#reflectedTurns` — Set<turnNumber>; ensures T1 fires at most
   *     once per turn (when toolCount crosses TOOL_BATCH_SIZE).
   */
  #execLog = null;
  #pendingT2 = new Map();
  #reflectedTurns = new Set();
  #__queryCounter = 0;

  /** @type {string} */
  #currentThreadId = MAIN_THREAD_ID;

  /** Wire turn id of the active query, used by late async completion rows. */
  #currentQueryTurnId = null;

  /** Durable formal-CLI root identity inherited by every row in this query. */
  #currentCausalRootId = null;

  /**
   * Identity-bound hook into the active query's local read-only result cache.
   * Async task terminal events can arrive while an adapter stream is already
   * producing tool calls, so they must invalidate reuse immediately rather
   * than waiting for the next queue-drain boundary.
   * @type {{ owner: AbortController, invalidate: () => void }|null}
   */
  #activeReadOnlyToolReuse = null;

  /** @type {Array<{content:string|Array, preview:string}>} */
  #pendingUserMessages = [];

  /** True after the bridge queued input in its external per-thread buffer. */
  #externalUserWakePending = false;

  /**
   * Result-producing async tasks (currently sub-agent spawns) launched DURING
   * the running query() and not yet terminated. Persistent shell tasks are
   * deliberately status-only and never enter this set. The query loop refuses
   * to finalize end_turn while this set is non-empty — instead it parks on
   * `#asyncTaskWaiters` until a terminal event or a new user append wakes it.
   * Cleared at the top of each query() and again in
   * the finally block so a stale set never leaks across turns.
   * @type {Set<string>}
   */
  #pendingAsyncTaskIds = new Set();

  /**
   * Terminal task events that arrived after their producing tool already
   * returned. Each entry becomes a synthetic user message at the next
   * adapter boundary. Format mirrors `#pendingUserMessages` so the same
   * drain path can splice both into `conversationMessages`.
   * @type {Array<{content:string|Array, preview:string, internal:boolean, taskId?:string}>}
   */
  #pendingTaskResultMessages = [];

  /**
   * Terminal async task results that should be appended to the original
   * tool_result message instead of injected as a synthetic user prompt.
   * @type {Array<{taskId:string, toolCallId:string, toolName?:string, content:string|Array, preview:string}>}
   */
  #pendingTaskResultUpdates = [];

  /**
   * Terminal task results accepted by this Engine but not yet consumed by a
   * successful adapter loop. Ownership stays with the Engine until delivery
   * is acknowledged; abort/retirement hands these payloads back to the bridge
   * for a new-turn rescue.
   * @type {Map<string, {content:string|Array, preview:string, sessionId?:string, vpId?:string, threadId?:string, taskKind?:string, taskStatus?:string}>}
   */
  #acceptedAsyncTaskResults = new Map();

  /** Task results already spliced into conversationMessages for the next request. */
  #pendingAsyncTaskConfirmIds = new Set();

  /** Persisted tool rows that may receive a same-turn background-task update. */
  #persistedToolMessages = new Map();

  /** Reject new same-turn deliveries once the current query starts closing. */
  #asyncTaskDeliveryClosed = true;

  /**
   * Async task ownership metadata captured when a tool registers a
   * background task. Keyed by taskId so terminal events can update the
   * original tool_result instead of fabricating a separate turn.
   * @type {Map<string, { toolCallId?: string, toolName?: string, threadId?: string, sessionId?: string, vpId?: string, turnId?: string }>}
   */
  #asyncTaskToolMeta = new Map();

  /**
   * Resolvers parked by the main loop while it waits for an async task to
   * terminate (or a fresh user append to arrive). Wake order is FIFO; every
   * resolver is invoked exactly once and the queue cleared, so a single
   * task completion releases every waiter in the same engine and the loop
   * decides on the next iteration whether to keep waiting.
   * @type {Array<() => void>}
   */
  #asyncTaskWaiters = [];

  /**
   * External coordinator hooks. `getOrCreateVpEngine` (web-bridge.js)
   * installs these so the bridge can route a `taskManager` `completed`
   * event back to THIS engine while it's still running its query() — same
   * turn, next adapter loop. Unset (null) in non-bridge contexts (tests,
   * sub-agents without a bridge) — the engine then degrades to "no
   * coordinator", which still works because tools call back through
   * `toolCtx.registerAsyncTask` and the engine waits locally; web-bridge
   * fallback (legacy `scheduleTaskResultReentry` → new turn) handles the
   * post-run case.
   * @type {{
   *   onRegister?: (taskId:string, engine:Engine) => void,
   *   onUnregister?: (taskId:string, engine:Engine) => void,
   *   onConsumed?: (taskId:string, engine:Engine) => void,
   *   onUndelivered?: (taskId:string, delivery:object, engine:Engine) => void,
   *   onDeferred?: (taskId:string, engine:Engine) => void,
   * } | null}
   */
  #asyncTaskCoordinator = null;

  /** @type {string|null} */
  #abortReason = null;

  /**
   * Per-engine cache of the resolved CLAUDE.md / AGENTS.md project doc.
   * Shape: `{ workDir, path, mtimeMs, text } | null`. A non-null record
   * means "for THIS workDir, the file at `path` with this `mtimeMs`
   * resolved to `text`" — when the next turn's stat returns the same
   * `(path, mtimeMs)` tuple, we skip the read entirely. mtime changes
   * (or a different picked file, e.g. user added AGENTS.md) invalidate
   * automatically because the `path`/`mtimeMs` comparison fails.
   * @type {{ workDir: string, path: string, mtimeMs: number, text: string }|null}
   */
  #projectDocCache = null;

  /**
   * @param {{
   *   adapter: import('./llm/adapter.js').LLMAdapter,
   *   trace: object,
   *   config: object,
   *   conversationStore?: import('./conversation/persist.js').ConversationStore,
   *   memoryIndex?: import('./memory/index-db.js').SegmentIndex,
   *   amsRegistry?: object,
   *   toolRegistry?: import('./tools/registry.js').ToolRegistry,
   *   skillManager?: import('./skills.js').SkillManager,
   *   mcpManager?: import('./mcp.js').MCPManager,
   *   yeaftDir?: string,
   *   toolStats?: import('./stats/tool-usage.js').ToolUsageStats,
   *   managedCliReady?: Promise<Array>,
   * }} params
   */
  constructor({ adapter, trace, config, conversationStore, memoryIndex, amsRegistry, toolRegistry, skillManager, mcpManager, yeaftDir, toolStats = null, taskManager = null, sessionId = null, vpId = null, chatId = null, managedCliReady = null }) {
    this.#adapter = adapter;
    this.#trace = trace;
    this.#config = config;
    this.#tools = new Map();
    this.#traceId = randomUUID();
    this.#conversationStore = conversationStore || null;
    this.#memoryIndex = memoryIndex || null;
    this.#amsRegistry = amsRegistry || null;
    this.#toolRegistry = toolRegistry || null;
    this.#taskManager = taskManager || null;
    this.#baseSkillManager = skillManager || null;
    this.#skillManager = this.#baseSkillManager && Array.isArray(config?.plugins?.skills)
      ? createPluginSkillManager(this.#baseSkillManager, config.plugins)
      : this.#baseSkillManager;
    this.#mcpManager = mcpManager || null;
    this.#yeaftDir = yeaftDir || null;
    this.#managedCliReady = managedCliReady || null;
    this.#toolStats = toolStats || null;
    // Per-VP fan-out (2026-06-01): engine instances in the group path are
    // keyed by ${sessionId}::${vpId}::${threadId}, so bind the engine to its
    // session/VP identity for history and memory ownership.
    this.#sessionId = (typeof sessionId === 'string' && sessionId) ? sessionId : null;
    this.#vpId = (typeof vpId === 'string' && vpId) ? vpId : null;
    this.#chatId = (typeof chatId === 'string' && chatId) ? chatId : null;

    // PR-L: tool history reflection log. Keyed by traceId so distinct
    // engine instances don't stomp on each other's jsonl files. When
    // yeaftDir is null the ExecLog still works — purely in-memory.
    this.#execLog = new ExecLog({
      yeaftDir: this.#yeaftDir,
      conversationId: this.#traceId,
    });

    this.refreshConfig(config);
  }

  /**
   * Register a tool that the LLM can call.
   *
   * @param {{ name: string, description: string, parameters: object, execute: (input: object, ctx?: { signal?: AbortSignal }) => Promise<string> }} tool
   */
  registerTool(tool) {
    this.#tools.set(tool.name, tool);
  }

  /**
   * task-325a — abort the currently running query().
   *
   * Idempotent and safe to call when no query is in flight (no-op).
   * The abort is cooperative: the in-flight adapter stream receives the
   * signal immediately (fetch aborts), the tool loop checks the signal
   * between invocations, and the loop emits a typed `aborted` event
   * before returning so the caller can distinguish "user stopped" from
   * "LLM returned end_turn".
   *
   * @param {string} [reason='user'] — Human-tagged reason surfaced on the
   *   emitted `aborted` event. Common values: `'user'`, `'timeout'`,
   *   `'thread_reset'`, `'session_reset'`.
   * @returns {boolean} true if an in-flight query was aborted, false if
   *   nothing was running (no-op).
   */
  abort(reason = 'user') {
    if (!this.#currentAbortCtrl) return false;
    if (this.#currentAbortCtrl.signal.aborted) return false;
    this.#abortReason = reason || 'user';
    this.retireAsyncTasks(`query_${this.#abortReason}`);
    try {
      this.#currentAbortCtrl.abort();
    } catch {
      // AbortController.abort never throws in practice, but swallow
      // defensively so abort() never takes down the caller.
    }
    return true;
  }

  /**
   * task-325a — whether there is an in-flight query that has NOT been
   * aborted. Useful for callers that want to know "is this engine busy?"
   * without racing on the signal.
   * @returns {boolean}
   */
  get isRunning() {
    return !!this.#currentAbortCtrl && !this.#currentAbortCtrl.signal.aborted;
  }

  /**
   * Mutate the engine's effective language at runtime. The next call to
   * #buildSystemPrompt reads this.#config.language live, so the very next
   * turn renders in the new language without reconstructing the engine.
   *
   * Used by the live-locale broadcast path: when the user flips the UI
   * language dropdown, web → server → message-router calls
   * broadcastLanguageChange(lang) (web-bridge.js) which fans out to every
   * Engine in the per-VP pool plus the 1:1-chat session engine.
   *
   * @param {string} lang — 'en' | 'zh'
   */
  setLanguage(lang) {
    if (typeof lang !== 'string' || !lang) return;
    this.#config.language = lang;
  }

  /**
   * Replace the effective runtime config for subsequent queries without
   * interrupting a turn that already captured its model.
   *
   * @param {object} config
   */
  refreshConfig(config) {
    if (!config || typeof config !== 'object') return;
    this.#config = config;
    this.#skillManager = this.#baseSkillManager && Array.isArray(config.plugins?.skills)
      ? createPluginSkillManager(this.#baseSkillManager, config.plugins)
      : this.#baseSkillManager;
  }

  /**
   * Hot-swap runtime managers for a project-bound Session. The ToolRegistry is
   * shared at the bridge/session layer; these references only decide which
   * skills are injected and which MCP manager flattened tools call through.
   *
   * @param {{ skillManager?: import('./skills.js').SkillManager, mcpManager?: import('./mcp.js').MCPManager }} managers
   */
  setRuntimeManagers(managers = {}) {
    if (Object.prototype.hasOwnProperty.call(managers, 'skillManager')) {
      this.#baseSkillManager = managers.skillManager || null;
      this.#skillManager = this.#baseSkillManager && Array.isArray(this.#config?.plugins?.skills)
        ? createPluginSkillManager(this.#baseSkillManager, this.#config.plugins)
        : this.#baseSkillManager;
    }
    if (Object.prototype.hasOwnProperty.call(managers, 'mcpManager')) {
      this.#mcpManager = managers.mcpManager || null;
    }
  }

  /**
   * Unregister a tool.
   *
   * @param {string} name
   */
  unregisterTool(name) {
    this.#tools.delete(name);
  }

  /**
   * Get the active tool definitions for one provider request. The registry keeps
   * every implementation and compatibility alias loaded; only the active set is
   * serialized into the request. Legacy standalone engines keep exposing their
   * explicitly registered tools because they do not use the built-in registry.
   *
   * @param {string|null} collabToolPolicy
   * @param {Set<string>|null} activeToolNames
   * @returns {import('./llm/adapter.js').UnifiedToolDef[]}
   */
  #getToolDefs(collabToolPolicy = null, activeToolNames = null) {
    if (this.#toolRegistry) {
      return this.#toolRegistry.getToolDefs(this.#config?.language || 'en', {
        collabToolPolicy,
        plugins: this.#config?.plugins,
        activeToolNames,
      });
    }
    const defs = [];
    for (const [, tool] of this.#tools) {
      defs.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      });
    }
    return defs;
  }

  #hasScopedSubAgents({ sessionId, parentVpId, parentThreadId } = {}) {
    const scope = { sessionId, parentVpId, parentThreadId };
    for (const agent of getAgentRegistry().values()) {
      if (agentBelongsToScope(agent, scope)) return true;
    }
    return false;
  }

  /**
   * Load prompt-facing canonical scope content. Every durable memory scope is
   * query-gated; summary.md remains catalog metadata for Dream triage only.
   *
   * Each fetch is best-effort — missing files / read errors return ''.
   *
   * @param {{sessionId?: string, vpId?: string, language?: string, selectedScopes?: Set<string>, topicScopes?: string[], relatedSessionIds?: string[]}} ctx
   * @returns {Promise<{user:string, session:string, vp:string, topics:Array<{scope:string, summary:string}>, relatedSessions:Array<{sessionId:string, summary:string}>}>}
   */
  async #loadLayerASummaries({ sessionId, vpId, language, selectedScopes, topicScopes, relatedSessionIds } = {}) {
    if (!this.#yeaftDir) return { user: '', session: '', vp: '', topics: [], relatedSessions: [] };
    const memoryRoot = `${this.#yeaftDir}/memory`;
    const topicScopeList = Array.isArray(topicScopes) ? topicScopes.slice(0, MAX_PROMPT_MEMORY_ITEMS) : [];
    const relatedIds = Array.from(new Set((Array.isArray(relatedSessionIds) ? relatedSessionIds : [])
      .filter(id => typeof id === 'string' && id.trim() && id.trim() !== sessionId)
      .map(id => id.trim())))
      .slice(0, MAX_RELATED_SESSION_MEMORY_ITEMS);
    const selected = selectedScopes instanceof Set ? selectedScopes : new Set();
    const exactSessionScope = selectExactSessionScope(selected, sessionId);
    const exactVpScope = selectExactVpScope(selected, sessionId, vpId);
    const tasks = [
      selected.has('user')
        ? readCanonicalScope('user', { root: memoryRoot, currentVpId: vpId }).catch(() => '')
        : Promise.resolve(''),
      exactSessionScope
        ? readCanonicalScope(exactSessionScope, { root: memoryRoot, currentVpId: vpId }).catch(() => '')
        : Promise.resolve(''),
      exactVpScope
        ? readCanonicalScope(exactVpScope, { root: memoryRoot, currentVpId: vpId }).catch(() => '')
        : Promise.resolve(''),
      Promise.all(topicScopeList.map(scope => readTopicSummary(scope, {
        root: memoryRoot,
        language,
        currentVpId: vpId,
      }))),
      Promise.all(relatedIds.map(async relatedSessionId => {
        const scope = selectExactSessionScope(selected, relatedSessionId);
        return {
          sessionId: relatedSessionId,
          summary: scope
            ? await readCanonicalScope(scope, { root: memoryRoot, currentVpId: vpId }).catch(() => '')
            : '',
        };
      })),
    ];
    const [user, session, vp, topicsRaw, relatedSessionsRaw] = await Promise.all(tasks);
    const topics = (topicsRaw || []).filter(t => t && t.summary);
    const relatedSessions = (relatedSessionsRaw || []).filter(entry => entry && entry.summary);
    return {
      user: user || '',
      session: session || '',
      sessionScope: exactSessionScope || '',
      vp: vp || '',
      vpScope: exactVpScope || '',
      topics,
      relatedSessions,
    };
  }

  async #loadSessionTopicScopes(sessionId) {
    if (!this.#yeaftDir || !sessionId) return [];
    const memoryRoot = join(this.#yeaftDir, 'memory');
    const scopes = [];
    for (const prefix of ['sessions', 'session', 'group']) {
      const labels = [];
      const topicRoot = join(memoryRoot, prefix, sessionId, 'topic');
      await collectTopicLabels(topicRoot, '', labels).catch(() => {});
      scopes.push(...labels.map(label => `${prefix}/${sessionId}/topic/${label}`));
    }
    return scopes;
  }

  /**
   * Prepare the per-turn AMS for the active group. Idempotent and safe
   * to call when the AMS registry isn't wired (returns null).
   *
   * @param {{
   *   sessionId?: string,
   *   ownVpId?: string|null,
   *   summaries: { user?: string, session?: string, vp?: string },
   *   recallEntries: object[],
   *   userMsg?: string,
   * }} args
   * @returns {{
   *   ams: import('./memory/ams.js').ActiveMemorySet,
   *   sessionKey: string,
   *   ownVpId: string|null,
   *   scopes: string[],
   *   snapshotBlock: string,
 *   snapshot: import('./memory/ams.js').AmsSnapshot,
 *   residentEntries: Array<{scope:string, summary:string}>,
   * } | null}
   */
  #prepareAms(args) {
    const sessionKey = args.sessionId || 'default';
    const ownVpId = args.ownVpId || null;
    // Some read-only Engine entry points (notably sub-agents) intentionally do
    // not own the parent's persistent registry. They still need the single AMS
    // render outlet, otherwise FTS recall succeeds and then vanishes before the
    // prompt. Use an isolated per-query AMS in that case: it preserves budgets,
    // cleanup, and dedupe without sharing mutable parent state or writing disk.
    const ams = this.#amsRegistry
      ? this.#amsRegistry.getOrCreate(sessionKey, { ownVpId })
      : new ActiveMemorySet({
          ownVpId,
          budget: computeBudget(this.#config?.maxContextTokens),
        });

    // Resident: rebuild from the canonical content selected for this query.
    const relatedSessionIds = new Set((args.summaries?.relatedSessions || [])
      .map(entry => entry?.sessionId)
      .filter(Boolean));
    const residentEntries = buildResidentEntries({
      sessionId: args.sessionId,
      ownVpId,
      summaries: args.summaries || {},
    }).map(entry => relatedSessionIds.has(entry.scope.replace(/^sessions\//, ''))
      ? { ...entry, category: 'experience' }
      : { ...entry, category: 'memory' });
    ams.setResident(residentEntries);

    // Segment hits identify relevant scopes, but raw evidence bodies do not
    // enter the normal prompt. Clear both persisted Recent ids and this turn's
    // OnDemand bodies; prompt-facing text comes only from canonical content.
    ams.clearSegmentLayers();

    // (c) Snapshot — render the AMS layers as a single prompt block.
    const snapshot = ams.snapshot({ userMsg: args.userMsg || '' });
    const snapshotBlock = this.#renderAmsSnapshot(
      snapshot,
      this.#config.language || 'en',
      args.sessionId || null,
    );

    const scopes = buildRelevantScopes({
      sessionId: args.sessionId,
      vpId: ownVpId,
    });

    return { ams, sessionKey, ownVpId, scopes, snapshotBlock, snapshot, residentEntries };
  }

  /**
   * Render an AMS snapshot as a markdown block suitable for prompt
   * injection. Mirrors the heading style of the existing memory blocks
   * so the LLM sees a consistent layout.
   *
   * @param {import('./memory/ams.js').AmsSnapshot} snap
   * @param {string} [language]
   * @returns {string}
   */
  #renderAmsSnapshot(snap, language = 'en', activeSessionId = null) {
    if (!snap) return '';
    const parts = [];
    if (snap.resident.length === 0 && snap.recent.length === 0 && snap.onDemand.length === 0) {
      return '';
    }
    const zh = isZhRuntimeLanguage(language);
    const experiences = snap.resident.filter(entry => entry.category === 'experience');
    const residentMemory = snap.resident.filter(entry => entry.category !== 'experience');
    parts.push(zh ? '## 相关上下文' : '## Relevant Context');
    parts.push(zh
      ? '以下内容来自与当前 query 相关的持久记忆；只把它当作事实背景，不要把过期执行状态当成当前任务。'
      : 'The following text comes from persistent memory selected for the current query. Treat it as factual context, not as current execution state.');
    if (experiences.length > 0) {
      parts.push(zh ? '### 过去 Session 的经验总结' : '### Experience From Past Sessions');
      for (const entry of experiences) {
        const sourceSessionId = sessionIdFromMemoryScope(entry.scope);
        const label = sourceSessionId && sourceSessionId !== activeSessionId
          ? sourceSessionId
          : memoryScopeLabel(entry.scope);
        parts.push(`- **${label}**: ${entry.summary}`);
      }
    }
    if (residentMemory.length > 0 || snap.recent.length > 0 || snap.onDemand.length > 0) {
      parts.push(zh ? '### 相关记忆' : '### Relevant Memory');
      for (const entry of residentMemory) {
        parts.push(`- **${memoryScopeLabel(entry.scope)}**: ${entry.summary}`);
      }
      for (const segment of [...snap.recent, ...snap.onDemand]) {
        parts.push(`- (${memoryScopeLabel(segment.scope)}) ${(segment.body || '').trim()}`);
      }
    }
    return parts.join('\n');
  }

  /**
   * Build the system prompt with the AMS-rendered Memory block, the
   * Active Scope block, and skill content. The legacy multi-path
   * Memory injection (FTS-formatted + AMS snapshot + Layer-A summaries +
   * userProfile + coreMemory) was retired in DESIGN-PROMPT v1; callers
   * now thread a single `memoryInjection` string composed upstream from
   * the AMS snapshot.
   *
   * Routes through `buildWorkerPrompt`, which:
   *   - Lays in the persona-as-identity block (or Yeaft identity fallback)
   *   - Adds the Memory section (passed in as `memoryInjection`)
   *   - Adds the structured Active Scope block (`activeScope`)
   *   - Forwards optional `taskCtx` for the legacy task-context sub-block
   *
   * @param {object} args
   * @param {string} args.prompt — user prompt (for skill relevance matching)
   * @param {string} args.memoryInjection — prebuilt Memory block from AMS
   * @param {object} [args.vpPersona]
   * @param {object} [args.activeScope] — DESIGN-PROMPT §3 ④ structured scope summary
   * @param {string} [args.sessionAnnouncement]
   * @param {string} [args.projectInstruction] — server-managed instruction shared by Project Sessions
   * @param {string} [args.projectLabel] — current Project name and id for prompt attribution
   * @param {string} [args.workCenterInstructions] — frozen Agent-level Work Center policy
   * @param {string} [args.projectDoc] — resolved CLAUDE.md / AGENTS.md text (already truncated)
   * @param {object} [args.taskCtx] — legacy task-context sub-block (optional)
   * @param {string} [args.explicitSkillName] — leading /skill:<name> command, if present
   * @returns {string}
   */
  #buildSystemPrompt({ prompt, memoryInjection, vpPersona, activeScope, sessionAnnouncement, projectInstruction, projectLabel, workCenterInstructions, projectDoc, taskCtx, activeTasks, collabToolPolicy = null, activeToolNames = null, promptNotices = [], explicitSkillName, resolvedSkillContent = null } = {}) {
    // #runQuery resolves Skill selection at each provider-request boundary so
    // a live Plugin policy change cannot leave stale content in the next prompt.
    // Keep the local fallback for internal callers that do not need selection
    // events.
    let skillContent = typeof resolvedSkillContent === 'string' ? resolvedSkillContent : '';
    if (resolvedSkillContent === null && this.#skillManager) {
      if (explicitSkillName) {
        skillContent = this.#skillManager.getPromptContent(explicitSkillName)
          || `## Skill command error\n\nRequested skill "${explicitSkillName}" was not found. Continue without that skill and tell the user it is unavailable.`;
      } else if (prompt) {
        skillContent = this.#skillManager.getRelevantPromptContent(prompt);
      }
    }

    // Prompt guidance must describe the same canonical capability
    // intersection that reaches provider schemas and execution.
    const registeredToolNames = this.#toolRegistry
      ? this.#toolRegistry.getToolNames({
          plugins: this.#config?.plugins,
          collabToolPolicy,
        })
      : Array.from(this.#tools.keys());
    const toolNames = activeToolNames instanceof Set
      ? registeredToolNames.filter(name => activeToolNames.has(name))
      : registeredToolNames;

    return buildWorkerPrompt({
      language: this.#config.language || 'en',
      toolNames,
      memoryInjection,
      skillContent,
      vpPersona,
      activeScope,
      sessionAnnouncement,
      projectInstruction,
      projectLabel,
      workCenterInstructions,
      projectDoc,
      runtimePlatform: getRuntimePlatformInfo(),
      taskCtx,
      activeTasks,
      promptNotices,
      // Worker-shape harness is descriptive metadata for human inspection;
      // production prompts skip it to save tokens. Re-enable via env when
      // diagnosing prompt structure issues.
      includeShape: process.env.YEAFT_PROMPT_INCLUDE_SHAPE === '1',
    });
  }

  /**
   * Resolve the CLAUDE.md / AGENTS.md project doc text for the current
   * group's working directory. mtime-cached on the engine so we only
   * re-read the file when the user actually edited it.
   *
   * Cache strategy:
   *   1. Cheap path: `pickProjectDocFile` (two stats, no read).
   *   2. If the picked `(path, mtimeMs)` matches the cache → return
   *      cached text. No disk read, no UTF-8 decode, no truncation work.
   *   3. Cache miss → call `readProjectDoc` (bounded `readSync` into a
   *      pre-sized buffer), refresh the cache, return the fresh text.
   *
   * Returns '' when:
   *   - workDir is empty / not a string
   *   - config.projectDocMaxBytes === 0 (feature disabled)
   *   - neither CLAUDE.md nor AGENTS.md exists in workDir
   *   - the picked file is empty after trim
   *
   * @param {string|undefined} workDir
   * @returns {string}
   */
  #getProjectDocBlock(workDir) {
    if (typeof workDir !== 'string' || !workDir.trim()) {
      this.#projectDocCache = null;
      return '';
    }
    const maxBytes = Number.isFinite(this.#config?.projectDocMaxBytes)
      ? this.#config.projectDocMaxBytes
      : DEFAULT_PROJECT_DOC_MAX_BYTES;
    if (maxBytes === 0) {
      this.#projectDocCache = null;
      return '';
    }

    // Step 1 — stat-only check. Cheap (two `statSync` calls) and lets
    // us short-circuit the read when the file hasn't moved.
    const secureWorkspace = this.#config?.secureProjectFiles === true;
    const picked = pickProjectDocFile(workDir, { secureWorkspace });
    if (!picked) {
      this.#projectDocCache = null;
      return '';
    }

    // Step 2 — cache hit? Same workDir, same picked file, same mtime
    // ⇒ the previously decoded text is still authoritative. Skip the
    // file read entirely.
    const cache = this.#projectDocCache;
    if (
      cache
      && cache.workDir === workDir
      && cache.path === picked.path
      && cache.mtimeMs === picked.mtimeMs
    ) {
      return cache.text;
    }

    // Step 3 — cache miss. Read + decode, then refresh the cache.
    const doc = readProjectDoc(workDir, { maxBytes, secureWorkspace });
    if (!doc) {
      this.#projectDocCache = null;
      return '';
    }
    this.#projectDocCache = {
      workDir,
      path: doc.path,
      mtimeMs: doc.mtimeMs,
      text: doc.text,
    };
    return doc.text;
  }

  /**
   * Build the full tool context for Phase 5 tools.
   *
   * @param {AbortSignal} [signal]
   * @returns {object}
   */
  #buildToolContext(signal, vpCtx) {
    return {
      signal,
      yeaftDir: this.#yeaftDir,
      managedCliReady: this.#managedCliReady,
      runtimePlatform: getRuntimePlatformInfo(),
      // Group-scoped working directory. Threaded from #runQuery({ workDir })
      // → set by web-bridge runVpTurn from sessionMeta.workDir. Tools read
      // `ctx.cwd` and resolve relative paths against it. Always absolute
      // (path.resolve normalizes relative inputs + trailing slashes) so
      // tools that string-concatenate don't accidentally walk from
      // process.cwd(). Falls back to process.cwd() in non-group / test
      // contexts.
      cwd: (() => {
        const raw = typeof vpCtx?.workDir === 'string' ? vpCtx.workDir.trim() : '';
        return raw ? resolvePath(raw) : process.cwd();
      })(),
      mcpManager: this.#mcpManager,
      skillManager: this.#skillManager,
      conversationStore: this.#conversationStore,
      adapter: this.#adapter,
      config: this.#config,
      discoverTools: vpCtx?.discoverTools,
      taskManager: this.#taskManager,
      sessionId: vpCtx?.sessionId || this.#sessionId || null,
      projectSessionIds: Array.isArray(vpCtx?.projectSessionIds)
        ? vpCtx.projectSessionIds.slice()
        : [],
      threadId: vpCtx?.threadId || this.#currentThreadId || MAIN_THREAD_ID,
      currentVpId: vpCtx?.senderVpId || this.#vpId || null,
      // task-704b: per-tool-result hard cap derives from this. Threaded
      // from the live model (resolveModel(currentModel)) every turn so
      // fallbackModel switches see the new window. Falls back to
      // config.maxContextTokens, then 200K, in registry.js.
      contextWindow: vpCtx?.contextWindow,
      // ViewImage (task-333b PR-B rev-3 P1-A): expose size cap + allowlist
      // via tool ctx so hosts can override via ~/.yeaft/config.json without
      // touching the tool impl.
      maxImageBytes: this.#config?.yeaft?.maxImageBytes,
      imageAllowlist: Array.isArray(this.#config?.yeaft?.imageAllowlist)
        ? this.#config.yeaft.imageAllowlist
        : [],
      // Bug 4 fix — VP / routing context for RouteForward (and any other
      // VP-aware tool). Undefined when running in non-group / no-VP flows.
      router: vpCtx?.router,
      senderVpId: vpCtx?.senderVpId,
      // Active VP persona — surfaced so tools like `StartPlan` can read
      // the optional `planInstruction` override without re-reading
      // role.md. Mirrors the symmetry already present in
      // `parentEngineDeps.parentVpPersona` below — sub-agents inherit it
      // through the parent deps; tools at this level read it directly.
      // Null in non-VP / test contexts.
      vpPersona: vpCtx?.vpPersona || null,
      inboundEnvelope: vpCtx?.inboundEnvelope,
      taskId: vpCtx?.taskId,
      taskMembers: vpCtx?.taskMembers,
      // TodoWrite per-VP cache hooks. Threaded from web-bridge so each
      // VP keeps its own todo list (see todo-write.js, web-bridge.js).
      // Null in non-VP / test contexts — tools tolerate missing slots.
      getCurrentTodos: vpCtx?.getCurrentTodos || null,
      setCurrentTodos: vpCtx?.setCurrentTodos || null,
      askUser: typeof vpCtx?.askUser === 'function'
        ? input => vpCtx.askUser(input, typeof vpCtx?.currentToolCall === 'function' ? vpCtx.currentToolCall() : null)
        : null,
      // task-707: tool-callable end-turn signal. The engine threads this
      // setter when constructing toolCtx so a tool (e.g. route_forward)
      // can mark "after this batch, end the turn — do NOT call adapter
      // again". Honored at the top of the tool-loop continuation.
      requestEndTurn: vpCtx?.requestEndTurn,
      requestToolBatchBarrier: vpCtx?.requestToolBatchBarrier,
      // Result-producing async-task ownership hook. Tools such as SpawnAgent
      // call this with the new `task.id` so the engine keeps the current query
      // parked at end_turn until the result arrives. Persistent background
      // shell tasks are status-only and intentionally do not call this hook.
      registerAsyncTask: (taskId, meta = {}) => {
        const current = typeof vpCtx?.currentToolCall === 'function' ? vpCtx.currentToolCall() : null;
        this.#registerAsyncTask(taskId, { ...(current || {}), ...(meta || {}) });
      },
      // Sub-agent plumbing — Agent tool needs these to spawn a child
      // Engine that inherits the parent's adapter / stores / toolset.
      parentEngineDeps: {
        adapter: this.#adapter,
        trace: this.#trace,
        config: this.#config,
        memoryIndex: this.#memoryIndex,
        parentToolRegistry: this.#toolRegistry,
        skillManager: this.#skillManager,
        mcpManager: this.#mcpManager,
        yeaftDir: this.#yeaftDir,
        managedCliReady: this.#managedCliReady,
        parentName: vpCtx?.senderVpId || 'parent',
        parentVpId: vpCtx?.senderVpId || null,
        parentVpPersona: vpCtx?.vpPersona || null,
        parentSessionId: vpCtx?.sessionId || null,
        projectSessionIds: Array.isArray(vpCtx?.projectSessionIds)
          ? vpCtx.projectSessionIds.slice()
          : [],
        projectLabel: typeof vpCtx?.projectLabel === 'string'
          ? vpCtx.projectLabel
          : '',
        projectInstruction: typeof vpCtx?.projectInstruction === 'string'
          ? vpCtx.projectInstruction
          : '',
        parentThreadId: vpCtx?.threadId || this.#currentThreadId || MAIN_THREAD_ID,
        onEvent: this.#subAgentEventSink || null,
        language: this.#config?.language || 'en',
        // Forward the session-shared ToolUsageStats so sub-agent
        // engines record tool calls into the same on-disk snapshot
        // (~/.yeaft/stats/tool-usage.json) the parent engine writes
        // to. Null when the parent has no stats wired (e.g. tests).
        toolStats: this.#toolStats || null,
        taskManager: this.#taskManager || null,
        // Propagate the async-task coordinator so sub-agents launched from
        // this engine register result-producing child tasks against the same
        // owner map the bridge uses.
        asyncTaskCoordinator: this.#asyncTaskCoordinator || null,
      },
    };
  }

  /**
   * Set a sub-agent event sink. Called by web-bridge so every event
   * yielded by a sub-engine gets surfaced to the frontend tagged with
   * the parent's conversation/turn so the UI can render it inside the
   * spawning sub-agent card.
   *
   * @param {(agentId: string, evt: object) => void} sink
   */
  setSubAgentEventSink(sink) {
    this.#subAgentEventSink = typeof sink === 'function' ? sink : null;
  }

  /**
   * Perform memory recall for a given prompt.
   *
   * Single path (GC.1 follow-up): SQLite FTS5 pre-flow via
   * `sessions/pre-flow.js` → `memory/preflow.js`. When the index isn't
   * wired (e.g. read-only sessions or pre-FTS yeaft dirs) recall is
   * skipped and an empty memory shape is returned — engine continues
   * without injection.
   *
   * @param {string} prompt
   * @param {{ sessionId?: string, vpId?: string, extraScopes?: string[], strictScopes?: string[] }} [ctx]
   * @returns {Promise<{ profile: string, entries: object[], formatted: string }|null>}
   */
  async #recallMemory(prompt, ctx = {}) {
    const memory = { profile: '', entries: [], formatted: '', meta: {} };
    if (!this.#memoryIndex) return memory;
    try {
      const result = runMemoryPreflow(this.#memoryIndex, {
        userMsg: prompt,
        sessionId: ctx.sessionId,
        chatId: ctx.chatId || this.#chatId,
        vpId: ctx.vpId,
        extraScopes: ctx.extraScopes,
        strictScopes: ctx.strictScopes,
        pickLimit: resolveMemoryRecallLimit(this.#config),
        uniqueScopes: true,
        canonicalOnly: true,
        topK: 500,
        fallbackOnEmpty: false,
      });
      memory.profile = result.profile || '';
      memory.entries = result.entries || [];
      memory.formatted = result.formatted || '';
      memory.meta = result.meta || {};
    } catch {
      // Fail soft — empty injection.
    }
    return memory;
  }

  #canPersistConversation() {
    return Boolean(this.#conversationStore) && !this.#config._readOnly;
  }

  #conversationRecord(message, { sessionId, turnId, causalRootId = undefined, model, incomplete = false, stopReason = null, executionOrigin = null } = {}) {
    const effectiveTurnId = turnId || message.turnId || null;
    const normalizeId = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
    // `null` is an explicit override used by a carried T2 reflection whose
    // originating query predates causal-root metadata. `undefined` inherits the
    // active query, which keeps every ordinary write path centralized here.
    const effectiveCausalRootId = causalRootId === null
      ? null
      : (normalizeId(causalRootId)
        || normalizeId(message.causalRootId)
        || this.#currentCausalRootId);
    const effectiveVpId = message.speakerVpId || this.#vpId || null;
    const record = {
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? ''),
      model: model || this.#config.model,
      threadId: this.#currentThreadId || MAIN_THREAD_ID,
      ...(sessionId ? { sessionId } : {}),
      ...(this.#chatId ? { chatId: this.#chatId } : {}),
    };
    if (message.toolCallId) record.toolCallId = message.toolCallId;
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) record.toolCalls = message.toolCalls;
    if (Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0) record.thinkingBlocks = message.thinkingBlocks;
    if (message.isError) record.isError = true;
    if (message.imageAssetAnchor) record.imageAssetAnchor = true;
    if (message._reflection) record._reflection = true;
    if (message._asyncTaskCompletion === true) record._asyncTaskCompletion = true;
    if (message.role === 'user') record.userAuthored = message.userAuthored === true;
    if (message.internal === true) record.internal = true;
    if (message.responseKind === 'progress' || message.responseKind === 'result') {
      record.responseKind = message.responseKind;
    }
    if (Array.isArray(message.foldedMessageIds) && message.foldedMessageIds.length > 0) {
      record.foldedMessageIds = [...message.foldedMessageIds];
    }
    if (effectiveTurnId && (message.role === 'assistant' || message.role === 'tool' || message.internal === true)) {
      record.turnId = effectiveTurnId;
    }
    if (effectiveCausalRootId) record.causalRootId = effectiveCausalRootId;
    if (executionOrigin === 'route_forward' && (message.role === 'assistant' || message.role === 'tool')) {
      record.executionOrigin = executionOrigin;
    }
    if (effectiveVpId && (message.role === 'assistant' || message.role === 'tool' || message.internal === true)) {
      record.speakerVpId = effectiveVpId;
    }
    if (incomplete) record.incomplete = true;
    if (stopReason) record.stopReason = stopReason;
    return record;
  }

  #persistConversationMessage(message, context = {}) {
    if (!this.#canPersistConversation() || !message?.role) return null;
    const hasContent = typeof message.content === 'string'
      ? message.content.length > 0
      : message.content != null;
    const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
    const hasThinking = Array.isArray(message.thinkingBlocks) && message.thinkingBlocks.length > 0;
    if (!hasContent && !hasToolCalls && !hasThinking && message.role !== 'tool') return null;
    return this.#conversationStore.append(this.#conversationRecord(message, context));
  }

  #persistFoldedRange(messages, startIdx, endIdx, reflection, context = {}) {
    if (!this.#canPersistConversation() || typeof this.#conversationStore?.foldMessages !== 'function') return null;
    const persistedRows = (messages || []).slice(startIdx, endIdx + 1)
      .map(message => message?._persistedMessageId || message?.id)
      .filter(id => typeof id === 'string' && id)
      .map(id => ({ id }));
    if (persistedRows.length === 0) return null;
    const record = this.#conversationRecord(reflection, context);
    return this.#conversationStore.foldMessages(persistedRows, record);
  }

  #formatTaskResultUpdateContent(content) {
    if (typeof content === 'string') return content;
    try { return JSON.stringify(content); } catch { return String(content); }
  }

  #drainPendingTaskResultUpdates(conversationMessages) {
    if (this.#pendingTaskResultUpdates.length === 0) return [];
    const updates = this.#pendingTaskResultUpdates.splice(0);
    const applied = [];
    for (const update of updates) {
      if (!update?.toolCallId) continue;
      const appendText = this.#formatTaskResultUpdateContent(update.content);
      if (!appendText.trim()) continue;
      const toolMsg = update.folded
        ? null
        : [...conversationMessages].reverse().find((msg) => (
          msg && msg.role === 'tool' && msg.toolCallId === update.toolCallId
        ));
      if (!toolMsg) {
        // T1/T2 may have folded the original tool row before this task
        // completed. The reflection is the canonical history, so a late
        // completion must not recreate the hidden tool arc on disk or in the
        // provider transcript. This is engine control context, not a fresh
        // user-authored message; ConversationStore keeps it off the visible
        // transcript while retaining it for the next provider boundary.
        const contextContent = truncateToolResultIfNeeded(appendText, {
          toolName: update.toolName || 'async task result',
          language: this.#config?.language,
        });
        const continuation = {
          role: 'user',
          content: `[system note] Async task completion for ${update.toolName || 'a folded tool call'}:\n${contextContent}`,
          internal: true,
          _asyncTaskCompletion: true,
          turnId: update.turnId || null,
          speakerVpId: update.vpId || null,
        };
        const persistedContinuation = this.#persistConversationMessage(continuation, {
          sessionId: update.sessionId || this.#sessionId,
          turnId: update.turnId || null,
        });
        if (persistedContinuation?.id) continuation._persistedMessageId = persistedContinuation.id;
        conversationMessages.push(continuation);
        applied.push(update);
        if (this.#acceptedAsyncTaskResults.has(update.taskId)) {
          this.#pendingAsyncTaskConfirmIds.add(update.taskId);
        }
        continue;
      }
      const prior = typeof toolMsg.content === 'string'
        ? toolMsg.content
        : this.#formatTaskResultUpdateContent(toolMsg.content);
      // Keep the durable row complete below, but apply the same per-tool
      // context cap used for the initial result before the next provider
      // request. Async completions otherwise bypassed the model-facing tool
      // result budget after their producing call had already returned.
      toolMsg.content = truncateToolResultIfNeeded(`${prior}\n\n${appendText}`, {
        toolName: update.toolName || 'async task result',
        language: this.#config?.language,
      });
      const persistedTool = this.#persistedToolMessages.get(update.toolCallId);
      if (persistedTool && typeof this.#conversationStore?.update === 'function') {
        const durablePrior = typeof persistedTool.content === 'string'
          ? persistedTool.content
          : this.#formatTaskResultUpdateContent(persistedTool.content);
        const durableContent = `${durablePrior}\n\n${appendText}`;
        const updated = this.#conversationStore.update(persistedTool, { content: durableContent });
        if (updated) this.#persistedToolMessages.set(update.toolCallId, updated);
      }
      applied.push(update);
      if (this.#acceptedAsyncTaskResults.has(update.taskId)) {
        this.#pendingAsyncTaskConfirmIds.add(update.taskId);
      }
    }
    return applied;
  }

  #confirmAsyncTaskResults(taskIds) {
    if (!Array.isArray(taskIds) || taskIds.length === 0) return;
    for (const taskId of taskIds) {
      this.#pendingAsyncTaskConfirmIds.delete(taskId);
      if (!this.#acceptedAsyncTaskResults.delete(taskId)) continue;
      try {
        if (typeof this.#asyncTaskCoordinator?.onConsumed === 'function') {
          this.#asyncTaskCoordinator.onConsumed(taskId, this);
        } else {
          this.#asyncTaskCoordinator?.onUnregister?.(taskId, this);
        }
      } catch { /* best-effort */ }
    }
  }

  #releaseUndeliveredAsyncTaskResults(reason = 'query_closed') {
    if (this.#acceptedAsyncTaskResults.size === 0) return 0;
    const deliveries = Array.from(this.#acceptedAsyncTaskResults.entries());
    this.#acceptedAsyncTaskResults.clear();
    this.#pendingAsyncTaskConfirmIds.clear();
    for (const [taskId, delivery] of deliveries) {
      try {
        this.#asyncTaskCoordinator?.onUndelivered?.(taskId, { ...delivery, reason }, this);
      } catch { /* rescue plumbing must not break query teardown */ }
    }
    return deliveries.length;
  }

  #persistAppendedUserMessage(item, sessionId) {
    if (!item || item.persisted || item.internal) return;
    this.#persistConversationMessage({
      role: 'user',
      content: item.content,
      userAuthored: true,
    }, { sessionId });
    item.persisted = true;
  }

  #drainPendingUserMessages(drainPendingUserMessages) {
    const pending = [];
    this.#externalUserWakePending = false;
    if (typeof drainPendingUserMessages === 'function') {
      try {
        const drained = drainPendingUserMessages();
        if (Array.isArray(drained)) pending.push(...drained);
      } catch {
        // Best-effort hook; a bad bridge callback must not kill the engine loop.
      }
    }
    if (this.#pendingUserMessages.length > 0) {
      pending.push(...this.#pendingUserMessages.splice(0));
    }
    // Task-result re-entries flow through the same drain so the main loop
    // sees ONE append queue. Each entry carries `internal: true` so the
    // `user_append` event downstream is tagged correctly (UI hides the
    // bubble; persistence stamps role=assistant).
    if (this.#pendingTaskResultMessages.length > 0) {
      pending.push(...this.#pendingTaskResultMessages.splice(0));
    }
    return pending
      .map((item) => {
        if (typeof item === 'string') return { content: item, preview: item, internal: false };
        if (!item || typeof item !== 'object') return null;
        const content = item.content ?? item.text;
        if (typeof content !== 'string' && !Array.isArray(content)) return null;
        const preview = typeof item.preview === 'string'
          ? item.preview
          : (typeof content === 'string' ? content : '[content blocks]');
        const taskId = typeof item.taskId === 'string' ? item.taskId : undefined;
        if (taskId && this.#acceptedAsyncTaskResults.has(taskId)) {
          this.#pendingAsyncTaskConfirmIds.add(taskId);
        }
        return {
          content,
          preview,
          internal: Boolean(item.internal),
          persisted: Boolean(item.persisted),
          taskId,
        };
      })
      .filter(Boolean);
  }

  /**
   * Run a query — the main loop.
   *
   * Yields EngineEvent objects that the caller (CLI, web) can consume
   * to render output in real-time.
   *
   * @param {object} params
   * @param {string} params.prompt - The user prompt (required, non-empty).
   * @param {Array} [params.messages] - Prior conversation messages.
   * @param {AbortSignal} [params.signal] - Abort signal.
   * @param {'low'|'medium'|'high'|'xhigh'|'max'|'ultra'|null} [params.userEffort] -
   *   task-327b: explicit per-query effort override (from Settings or
   *   API caller). `/ultra`/`/max`/`/high`/`/medium`/`/low` prefixes in prompt
   *   also set this. Null/invalid → scenario decision tree decides.
   * @param {string} [params.scenario='chat'] - task-327b: scenario tag
   *   forwarded to the effort decision tree. See effort.js
   *   SCENARIO_EFFORT. Unknown values fall through to 'high'.
   * @param {Array<{type:string, source?:object, text?:string}>} [params.promptParts] -
   *   PR #721: optional content-array form of the user message used
   *   when attachments are present. Each entry is either an
   *   `{type:'image', source:{type:'base64', media_type, data}}` block
   *   (one per uploaded image) or a `{type:'text', text}` block (the
   *   text prompt body, including any [Uploaded files] suffix). When
   *   supplied and non-empty, the LLM call uses this array as the
   *   user-message content; the string `prompt` is then only used for
   *   logging / history. When omitted the engine falls back to the
   *   string-prompt shape (no regression for existing callers).
   * @param {string|null} [params.causalRootId] - Stable durable identity for
   *   every row generated as part of one externally accepted causal root.
   * @yields {EngineEvent}
   */
  async *query(params = {}) {
    const queryTraceId = typeof params.vpTurnId === 'string' && params.vpTurnId
      ? params.vpTurnId : null;
    let terminalEmitted = false;
    let terminalStopReason = 'error';
    let lastTurnNumber = 0;
    try {
      for await (const event of this.#queryLifecycle(params)) {
        if (Number.isFinite(event?.turnNumber)) lastTurnNumber = event.turnNumber;
        if (event?.type === 'turn_end' && event.terminal === true) {
          terminalEmitted = true;
          terminalStopReason = event.stopReason || terminalStopReason;
        }
        yield event;
      }
    } catch (err) {
      // The internal state machine handles expected provider failures, tool
      // results, retries and aborts. This outermost boundary catches everything
      // else, including pre-flow and cleanup faults, so an accepted query never
      // disappears without a diagnostic terminal event.
      if (!terminalEmitted) {
        const error = err instanceof Error ? err : new Error(String(err));
        yield { type: 'error', error, retryable: false };
        yield {
          type: 'turn_end',
          turnNumber: lastTurnNumber,
          stopReason: 'error',
          terminal: true,
          detail: { message: error.message, errorName: error.name },
          threadId: params.threadId || MAIN_THREAD_ID,
        };
      } else {
        // Normal end_turn is already durable and visible. A failed maintenance
        // hook must not retroactively turn the completed answer into an error.
        console.warn('[Engine] post-turn maintenance failed:', err?.message || err);
      }
    } finally {
      if (queryTraceId && typeof this.#trace?.finalizeQuery === 'function') {
        this.#trace.finalizeQuery(queryTraceId, {
          sessionId: params.sessionId || null,
          stopReason: terminalEmitted ? terminalStopReason : 'interrupted',
        });
      }
    }
  }

  async *#queryLifecycle({ prompt, promptParts = null, messages = [], signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, sessionId, sessionMembers, projectSessionIds = null, projectInstruction = '', projectLabel = '', vpPlan, sessionAnnouncement, workCenterInstructions, workDir, userAlreadyPersisted = false, causalRootId = null, getCurrentTodos = null, setCurrentTodos = null, askUser = null, threadId = MAIN_THREAD_ID, vpTurnId = null, drainPendingUserMessages = null, prepareProviderRequest = null, startProviderRequest = null, finishProviderRequest = null, failProviderRequest = null, closePendingUserInput = null, collabToolPolicy = null } = {}) {
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      const error = new Error('prompt is required and must be a non-empty string');
      yield {
        type: 'error',
        error,
        retryable: false,
      };
      yield {
        type: 'turn_end',
        turnNumber: 0,
        stopReason: 'error',
        terminal: true,
        detail: { message: error.message, errorName: error.name },
        threadId,
      };
      return;
    }
    // promptParts (optional): a content-array form of the user message
    // (e.g. [{type:'image',source:{...}}, {type:'text',text:'@vp-x ...'}]).
    // When supplied, it REPLACES the trailing `{role:'user',content:prompt}`
    // entry built into conversationMessages — the string `prompt` is still
    // used for memory recall, system prompt rendering, and turn previews
    // because those layers all need plain text. Adapter side already
    // accepts content arrays for user messages (anthropic.js:72,
    // openai-responses.js:#translateUserContent).

    // task-327b: `/max` / `/high` / `/medium` / `/low` prefix override.
    // Explicit caller-supplied userEffort wins over the prefix. Session config
    // is deliberately excluded here because it may refresh between loops.
    // task-327c nit: defensively normalize caller-supplied userEffort BEFORE
    // the merge, so an invalid caller value (e.g. 'ULTRA') does not shadow a
    // valid prompt prefix.
    const parsed = parseEffortPrefix(prompt);
    const parsedSkill = parseExplicitSkillCommand(parsed.cleanedPrompt, this.#skillManager);
    const effectivePrompt = parsedSkill.cleanedPrompt;
    const effectivePromptParts = parsedSkill.skillName
      ? stripLeadingSkillCommandFromPromptParts(promptParts, this.#skillManager)
      : promptParts;
    // Only actual caller input and a prompt prefix are per-query overrides.
    // Session-configured effort belongs to the live config and is resolved at
    // each provider-request boundary, just like the live model snapshot.
    const explicitUserEffort = normalizeEffort(userEffort) || parsed.effort || null;
    const effectiveCollabToolPolicy = collabToolPolicy === COLLAB_TOOL_POLICY.SINGLE_VP || collabToolPolicy === COLLAB_TOOL_POLICY.MULTI_VP
      ? collabToolPolicy
      : null;
    const effectiveCausalRootId = typeof causalRootId === 'string' && causalRootId.trim()
      ? causalRootId.trim() : null;

    // ─── task-325a: engine-owned AbortController ─────────────
    // We create our own controller for this query run so `engine.abort()`
    // can trigger cancellation without requiring the caller to hand in a
    // signal. If the caller DID provide a signal, we mirror its state onto
    // our controller (honouring both entry points). The linked signal
    // forwarded to the adapter/tools is always `abortCtrl.signal`, so
    // there is exactly one place that actually stops work in flight.
    const abortCtrl = new AbortController();
    this.#currentAbortCtrl = abortCtrl;
    this.#abortReason = null;
    this.#asyncTaskDeliveryClosed = false;
    this.#acceptedAsyncTaskResults.clear();
    this.#pendingAsyncTaskConfirmIds.clear();

    const onExternalAbort = () => {
      if (!abortCtrl.signal.aborted) {
        // Tag the reason so the emitted `aborted` event reflects the
        // external trigger. Callers that pass a signal without invoking
        // engine.abort() get the neutral tag 'external'.
        if (!this.#abortReason) this.#abortReason = 'external';
        this.retireAsyncTasks('query_external');
        try { abortCtrl.abort(); } catch { /* ignore */ }
      }
    };
    if (signal) {
      if (signal.aborted) {
        this.#abortReason = 'external';
        this.retireAsyncTasks('query_external');
        try { abortCtrl.abort(); } catch { /* ignore */ }
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }
    // The signal passed down to adapter.stream() + tool execution.
    const runSignal = abortCtrl.signal;

    const retryLifecycle = {
      pendingContinuation: null,
      lastPersistedPartial: null,
    };
    try {
      this.#currentThreadId = threadId || MAIN_THREAD_ID;
      this.#currentCausalRootId = effectiveCausalRootId;
      yield* this.#runQuery({ prompt: effectivePrompt, promptParts: effectivePromptParts, messages, signal: runSignal, userEffort: explicitUserEffort, scenario, vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, sessionId, sessionMembers, projectSessionIds, projectInstruction, projectLabel, vpPlan, sessionAnnouncement, workCenterInstructions, workDir, userAlreadyPersisted, causalRootId: effectiveCausalRootId, getCurrentTodos, setCurrentTodos, askUser, threadId: this.#currentThreadId, vpTurnId, drainPendingUserMessages, prepareProviderRequest, startProviderRequest, finishProviderRequest, failProviderRequest, closePendingUserInput, collabToolPolicy: effectiveCollabToolPolicy, explicitSkillName: parsedSkill.skillName, retryLifecycle });
    } finally {
      // Closing the async generator at a visible retry boundary means the
      // continuation never reached a provider. Keep it out of history and
      // terminate the accepted assistant prefix instead of leaving `retry`.
      if (retryLifecycle.pendingContinuation
          && retryLifecycle.lastPersistedPartial
          && typeof this.#conversationStore?.update === 'function') {
        const abortedPartial = this.#conversationStore.update(
          retryLifecycle.lastPersistedPartial,
          { stopReason: 'aborted' },
        );
        if (abortedPartial) retryLifecycle.lastPersistedPartial = abortedPartial;
      }
      retryLifecycle.pendingContinuation = null;
      if (signal) {
        try { signal.removeEventListener('abort', onExternalAbort); } catch { /* ignore */ }
      }
      this.retireAsyncTasks(abortCtrl.signal.aborted ? 'query_aborted' : 'query_closed');
      // The closure is local to this query. Do not let a late callback from a
      // retired run touch a later query's independent read cache.
      if (this.#activeReadOnlyToolReuse?.owner === abortCtrl) {
        this.#activeReadOnlyToolReuse = null;
      }
      // Clear current-run state so engine.isRunning flips back to false
      // and a subsequent query() starts with a clean slate.
      this.#currentAbortCtrl = null;
      this.#abortReason = null;
      this.#currentQueryTurnId = null;
      this.#currentCausalRootId = null;
      this.#currentThreadId = MAIN_THREAD_ID;
      this.#pendingUserMessages.length = 0;
      this.#externalUserWakePending = false;
      this.#asyncTaskToolMeta.clear();
      this.#pendingTaskResultMessages.length = 0;
      this.#pendingTaskResultUpdates.length = 0;
      this.#persistedToolMessages.clear();
      // Release any parked waiters so they don't pin a microtask after
      // query() returns. The loop has already exited so they're harmless,
      // but cleanup keeps the promise graph tight.
      if (this.#asyncTaskWaiters.length > 0) {
        const waiters = this.#asyncTaskWaiters.splice(0);
        for (const r of waiters) {
          try { r(); } catch { /* ignore */ }
        }
      }
    }
  }

  /**
   * Internal: the original query loop body. Split out of `query()` so the
   * public method can own the per-run AbortController + abort lifecycle
   * in a try/finally without indenting the whole loop.
   * @private
   */
  async *#runQuery({ prompt, promptParts = null, messages, signal, userEffort = null, scenario = 'chat', vpPersona, router, senderVpId, inboundEnvelope, taskId, taskMembers, sessionId, sessionMembers, projectSessionIds = null, projectInstruction = '', projectLabel = '', vpPlan, sessionAnnouncement, workCenterInstructions, workDir, userAlreadyPersisted = false, causalRootId = null, getCurrentTodos = null, setCurrentTodos = null, askUser = null, threadId = MAIN_THREAD_ID, vpTurnId = null, drainPendingUserMessages = null, prepareProviderRequest = null, startProviderRequest = null, finishProviderRequest = null, failProviderRequest = null, closePendingUserInput = null, collabToolPolicy = null, explicitSkillName = null, retryLifecycle }) {

    const effectiveCollabToolPolicy = collabToolPolicy === COLLAB_TOOL_POLICY.SINGLE_VP || collabToolPolicy === COLLAB_TOOL_POLICY.MULTI_VP
      ? collabToolPolicy
      : null;
    const runtimeSessionId = (typeof sessionId === 'string' && sessionId.trim())
      ? sessionId.trim()
      : this.#sessionId;
    const runtimeThreadId = (typeof threadId === 'string' && threadId.trim())
      ? threadId.trim()
      : MAIN_THREAD_ID;
    const executionOrigin = ['route_forward', 'route_forward_result'].includes(inboundEnvelope?.msg?.meta?.injectedBy)
      ? 'route_forward'
      : null;
    // The bridge-provided VP turn id is also persisted on assistant messages and
    // is therefore the identity the UI sends back when opening turn debug. Keep
    // the engine event/trace id identical; a second random id makes the trace
    // impossible to retrieve from a rendered assistant turn.
    const queryTurnId = vpTurnId || randomUUID();
    this.#currentQueryTurnId = queryTurnId;
    // Bind the live query scope before tools can register async work. The
    // constructor's Session id is only guaranteed for bridge-owned engines;
    // standalone/CLI callers pass it per query.
    this.#sessionId = runtimeSessionId || null;
    this.#currentThreadId = runtimeThreadId;
    const queryStartedAt = Date.now();
    const userQuestionPreview = String(prompt || '').slice(0, 200);
    const queryVpId = vpPersona && typeof vpPersona === 'object'
      && typeof vpPersona.vpId === 'string'
      ? vpPersona.vpId
      : (typeof senderVpId === 'string' ? senderVpId : null);
    // Exact read-only tool results are safe to reuse within one query only
    // when no intervening mutation can have changed the workspace. The map is
    // intentionally local to this query; cross-turn reuse belongs to the
    // persistent tool log and must not silently bypass new user work. A
    // detached operation can mutate after its tool call returns, so it disables
    // reuse for the remainder of this query rather than leaving a timing window
    // for stale entries to be repopulated.
    const readOnlyToolResults = new Map();
    let readOnlyToolReuseDisabled = false;
    const invalidateReadOnlyToolReuse = () => {
      readOnlyToolResults.clear();
      readOnlyToolReuseDisabled = true;
    };
    // Completion callbacks run outside this lexical loop. Publish an
    // identity-bound hook so an accepted completion can close the reuse window
    // even after the next provider stream has started.
    const readOnlyToolReuseOwner = this.#currentAbortCtrl;
    this.#activeReadOnlyToolReuse = {
      owner: readOnlyToolReuseOwner,
      invalidate: invalidateReadOnlyToolReuse,
    };

    // Durability boundary: a valid user turn must exist on disk before any
    // memory pre-flow or provider request can fail. The Web Session bridge
    // already writes one shared user row before multi-VP fan-out, so those
    // callers set userAlreadyPersisted and every VP skips this append.
    if (!userAlreadyPersisted) {
      this.#persistConversationMessage({ role: 'user', content: prompt, userAuthored: true }, {
        sessionId: runtimeSessionId,
      });
    }

    const perfTraceId = typeof inboundEnvelope?._perfTraceId === 'string' && inboundEnvelope._perfTraceId.trim()
      ? inboundEnvelope._perfTraceId.trim()
      : (typeof inboundEnvelope?.perfTraceId === 'string' && inboundEnvelope.perfTraceId.trim() ? inboundEnvelope.perfTraceId.trim() : null);
    const traceRequest = (phase, extra = {}) => {
      if (!perfTraceId) return;
      recordAgentPerfTrace(this.#config, {
        traceId: perfTraceId,
        phase,
        sessionId: runtimeSessionId || null,
        vpId: this.#vpId || senderVpId || null,
        turnId: vpTurnId || null,
        threadId: runtimeThreadId,
        messageType: 'llm_request',
        ...extra,
      });
    };

    // ─── Pre-query: FTS5 Memory Recall + AMS snapshot ─────
    // Memory has one render outlet:
    //   1. FTS5 ranks canonical-content records and chooses scopes;
    //   2. Engine reloads those scopes from content.md;
    //   3. AMS renders the budget-aware Resident snapshot as memoryInjection.
    // Raw memory.md evidence and summary.md catalog text never enter the prompt.
    let memoryInjection = '';
    let recallEntryCount = 0;

    const topicScopesForMemory = await this.#loadSessionTopicScopes(sessionId);
    const projectScopesForMemory = Array.isArray(projectSessionIds)
      ? projectSessionIds.flatMap(id => [
          `sessions/${id}`,
          `session/${id}`,
          `group/${id}`,
        ])
      : [];
    const recallResult = await this.#recallMemory(prompt, {
      sessionId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
      extraScopes: [...topicScopesForMemory, ...projectScopesForMemory],
      // Global user memory and Project siblings are much broader than the
      // active Session. A single generic OR-FTS hit must not pull an entire
      // historical content.md into the provider prompt.
      strictScopes: ['user', ...projectScopesForMemory],
    });
    recallEntryCount = recallResult && Array.isArray(recallResult.entries)
      ? recallResult.entries.length
      : 0;
    if (recallEntryCount > 0) {
      yield { type: 'recall', entryCount: recallEntryCount, cached: false, threadId };
    }
    const selectedMemoryScopes = selectCanonicalMemoryScopes(recallResult?.entries || []);
    const topicScopesForResident = selectResidentTopicScopes(
      topicScopesForMemory,
      recallResult?.entries || [],
    );
    const recalledRelatedSessionIds = selectRelatedSessionIds(
      projectSessionIds,
      recallResult?.entries || [],
    );

    // Load canonical content only for scopes selected by ranked FTS records.
    // summary.md remains catalog metadata and never enters the prompt.
    const summaries = await this.#loadLayerASummaries({
      sessionId,
      vpId: vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string'
        ? vpPersona.vpId
        : (typeof senderVpId === 'string' ? senderVpId : undefined),
      language: this.#config.language || 'en',
      selectedScopes: selectedMemoryScopes,
      topicScopes: topicScopesForResident,
      relatedSessionIds: recalledRelatedSessionIds,
    });

    // ─── AMS: populate + snapshot ───────────────────────────────
    // Session + VP keyed AMS is rebuilt each turn from selected canonical content.
    // FTS segment hits choose scopes but their bodies are not rendered. The
    // budget-aware Resident snapshot is the sole Memory prompt outlet.
    const ownVpIdForAms = vpPersona && typeof vpPersona === 'object'
      && typeof vpPersona.vpId === 'string'
      ? vpPersona.vpId
      : (typeof senderVpId === 'string' ? senderVpId : null);
    const amsContext = this.#prepareAms({
      sessionId,
      ownVpId: ownVpIdForAms,
      summaries,
      recallEntries: recallResult ? (recallResult.entries || []) : [],
      userMsg: prompt,
    });
    if (amsContext && amsContext.snapshotBlock) {
      memoryInjection = amsContext.snapshotBlock;
    }
    const loadedMemoryForDebug = loadedMemoryDebugEntries(amsContext?.snapshot);
    const loadedMemoryMetaForDebug = {
      recallLimit: resolveMemoryRecallLimit(this.#config),
      recallCandidates: Number.isFinite(recallResult?.meta?.hitCount)
        ? recallResult.meta.hitCount
        : (recallResult && Array.isArray(recallResult.entries) ? recallResult.entries.length : 0),
    };

    // Diagnostic payload for the Dream debug panel. The full AMS Resident
    // layer can include user and per-VP summaries, but the browser-facing
    // Dream prompt-load view only needs to prove the active session Dream
    // summary entered `system_prompt.memory`. Keep the payload scoped to the
    // exact session resident to avoid leaking unrelated resident summaries into
    // frontend state. The full system prompt remains visible in the existing
    // debug-only system-prompt panel.
    const activeGroupDreamScope = sessionId ? `sessions/${sessionId}` : null;
    const activeTopicDreamPrefix = sessionId ? `sessions/${sessionId}/topic/` : null;
    const dreamResidentLoaded = amsContext && Array.isArray(amsContext.residentEntries)
      ? amsContext.residentEntries
        .filter(e => e && e.summary && (
          e.scope === activeGroupDreamScope
          || (activeTopicDreamPrefix && e.scope?.startsWith(activeTopicDreamPrefix))
        ))
        .map(e => ({
          scope: e.scope,
          summary: String(e.summary),
          truncated: false,
          source: e.scope?.startsWith(activeTopicDreamPrefix || '\u0000')
            ? 'canonical-topic-content'
            : 'resident-summary',
        }))
      : [];

    // ─── Active Scope (DESIGN-PROMPT §3 ④) ──────────────────────
    // Structured per-turn scope summary: session + vp + members + envelope routing
    // info. Long-form scope content lives in AMS — this block carries
    // only IDs + tiny labels. (Feature scope retired 2026-05-13.)
    const activeSessionTopics = topicScopesForResident
      .map(scope => scope.replace(/^sessions\/[^/]+\/topic\//, ''));
    const activeScope = {
      sessionId: sessionId || '',
      sessionMember: ownVpIdForAms || '',
      sessionMembers: Array.isArray(sessionMembers) ? sessionMembers : [],
      sessionTopics: activeSessionTopics,
      envelope: inboundEnvelope || null,
    };

    const projectDocSource = this.#getProjectDocBlock(workDir);
    let projectDocLoadedPathHints = [];
    let projectDocContext = selectProjectDocContext(projectDocSource, {
      prompt,
      messages,
      pathHints: projectDocLoadedPathHints,
      language: this.#config.language || 'en',
    });
    let activeTaskSnapshots = this.#taskManager
      && typeof this.#taskManager.listActiveTasks === 'function'
      ? this.#taskManager.listActiveTasks(runtimeSessionId)
      : [];
    let activeTasks = this.#taskManager
      ? this.#taskManager.renderActiveTasksForPrompt(runtimeSessionId, {
          language: this.#config.language || 'en',
        })
      : '';
    const registeredToolNames = this.#toolRegistry
      ? this.#toolRegistry.getToolNames({
          collabToolPolicy: effectiveCollabToolPolicy,
          plugins: this.#config?.plugins,
        })
      : Array.from(this.#tools.keys());
    const registeredToolNameSet = new Set(registeredToolNames);
    const resolveCurrentActiveToolNames = () => this.#toolRegistry
      ? resolveActiveToolNames({
          toolNames: registeredToolNames,
          prompt,
          messages,
          collabToolPolicy: effectiveCollabToolPolicy,
          activeTasks: activeTaskSnapshots,
          subAgentToolsActivated: this.#hasScopedSubAgents({
            sessionId: runtimeSessionId,
            parentVpId: queryVpId,
            parentThreadId: runtimeThreadId,
          }),
          imageGenerationConfigured: typeof this.#config?.imageApiUrl === 'string'
            && this.#config.imageApiUrl.trim().length > 0,
        })
      : null;
    const discoveredToolNames = new Set();
    const discoveryTraversals = new Map();
    const currentDiscoverableTools = () => this.#toolRegistry
      ? this.#toolRegistry.getAllTools()
          .filter(tool => registeredToolNameSet.has(tool.name))
          .filter(tool => CONDITIONAL_BUILTIN_TOOL_NAMES.has(tool.name) || tool.name.startsWith('mcp__'))
      : [];
    const discoveryDirectorySnapshot = (tools, language) => tools
      .map(tool => ({
        name: tool.name,
        description: localizeVisibleText(tool.description, language, tool.name),
        parameters: tool.parameters,
      }));
    const discoveryDirectoryMatches = (snapshot, liveTools, language) => {
      const liveSnapshot = discoveryDirectorySnapshot(liveTools, language);
      if (snapshot.length !== liveSnapshot.length) return false;
      const byName = new Map(snapshot.map(tool => [tool.name, tool]));
      return liveSnapshot.every(tool => {
        const prior = byName.get(tool.name);
        return prior
          && prior.description === tool.description
          && JSON.stringify(prior.parameters) === JSON.stringify(tool.parameters);
      });
    };
    const applyDiscoveredTools = (names) => {
      for (const name of names) {
        if (this.#toolRegistry?.has(name)) discoveredToolNames.add(name);
      }
    };
    let activeToolNames = resolveCurrentActiveToolNames();
    let { resolvedSkillContent, resolvedSkills, skillResolutionError } = resolveSkillPromptState({
      skillManager: this.#skillManager,
      prompt,
      explicitSkillName,
    });

    let promptNotices = [];
    const buildCurrentSystemPrompt = () => this.#buildSystemPrompt({
      prompt,
      memoryInjection,
      vpPersona,
      activeScope,
      sessionAnnouncement,
      projectInstruction,
      projectLabel,
      workCenterInstructions,
      projectDoc: projectDocContext.text,
      activeTasks,
      collabToolPolicy: effectiveCollabToolPolicy,
      activeToolNames,
      promptNotices,
      explicitSkillName,
      resolvedSkillContent,
    });
    let systemPrompt = buildCurrentSystemPrompt();

    // Build conversation from the caller-provided history and the new user message.
    // If `promptParts` was supplied (image/file attachments), use the array form
    // so the adapter sees image content blocks alongside the text. Otherwise the
    // legacy string form keeps prompt-cache behavior identical.
    //
    // Sub-agent re-entry: before constructing the user message, drain any
    // terminal sub-agent notifications that landed for this parent VP
    // while it was idle. If any are present we prepend an XML-tagged
    // block to the user prompt so the parent model sees the sub-agent
    // result(s) even if it forgot to call WaitAgent. See
    // sub-agent/notifications.js for the bucketing + format.
    const parentVpIdForNotif = (vpPersona && typeof vpPersona === 'object' && typeof vpPersona.vpId === 'string')
      ? vpPersona.vpId
      : (typeof senderVpId === 'string' ? senderVpId : null);
    const isSubAgentTurn = !!(vpPersona && typeof vpPersona === 'object' && vpPersona.subAgent);
    const notifScope = {
      sessionId: runtimeSessionId,
      parentVpId: parentVpIdForNotif,
      threadId: runtimeThreadId,
    };
    const pendingSubAgentNotifs = isSubAgentTurn ? [] : peekPendingNotifications(notifScope);
    const subAgentNotifBlock = formatNotificationsForPrompt(pendingSubAgentNotifs);

    let finalUserContent;
    if (Array.isArray(promptParts) && promptParts.length > 0) {
      // Multimodal prompt — prepend the notification block as a leading
      // text part so the adapter still sees image content blocks intact.
      finalUserContent = subAgentNotifBlock
        ? [{ type: 'text', text: subAgentNotifBlock + '\n\n' }, ...promptParts]
        : promptParts;
    } else {
      finalUserContent = subAgentNotifBlock
        ? `${subAgentNotifBlock}\n\n${prompt || ''}`
        : prompt;
    }
    const conversationMessages = [
      ...trimSnapshotForBudget(messages, {
        messageTokenBudget: this.#config.messageTokenBudget,
        language: this.#config.language,
      }),
      { role: 'user', content: finalUserContent },
    ];

    const groupReflectionGate = shouldAllowGroupReflection({
      system: systemPrompt,
      messages: conversationMessages,
      model: this.#config.model,
      config: this.#config,
      sessionId,
    });
    const groupReflectionAllowed = groupReflectionGate.allowed === true;
    if (sessionId && groupReflectionGate?.usedFallbackContextWindow) {
      this.#trace.log?.('group_context_window_fallback', {
        sessionId,
        model: this.#config.model,
        contextWindow: groupReflectionGate.contextWindow,
        threshold: groupReflectionGate.threshold,
      });
    }

    // PR-L: T2 carry-forward. If a previous query()'s end-of-turn
    // reflection has resolved, rewrite that turn's range in
    // `conversationMessages` to a single assistant reflection message.
    // If still pending, fall back to the exec-log stub — non-blocking,
    // never wait. This runs BEFORE the first adapter.stream so the
    // upcoming call sees the rewritten history. Group send defaults to no
    // reflection; only high context pressure (>=80% of model window)
    // enables the carry-forward rewrite.
    if (groupReflectionAllowed) {
      yield* this.#applyPendingT2Reflections(conversationMessages, prompt, {
        sessionId: runtimeSessionId,
        model: this.#config.model,
      });
    }

    // PR-L: track this query()'s tool-arc for reflection.
    // `turnStartIdx` is where the current user message lives; the arc
    // we may collapse spans (arcStartIdx .. last assistant/tool).
    //
    // Periodic-T1 fix: T1 must fire EVERY TOOL_BATCH_SIZE (30) tool
    // calls, not just the first batch. So instead of a one-shot boolean,
    // track:
    //   • `lastT1AtToolCount` — toolCount snapshot at the last T1
    //     ATTEMPT (success OR error). Trigger when
    //     `queryToolCount - lastT1AtToolCount >= TOOL_BATCH_SIZE`.
    //   • `arcStartIdx` — first index of the current (uncollapsed)
    //     tool arc. Initialised to turnStartIdx + 1; reset after each
    //     successful T1 collapse to `conversationMessages.length`
    //     (i.e. the slot the next assistant message will land in).
    //   • `t1CollapsesDone` — count of T1 firings that ACTUALLY
    //     rewrote history. Distinct from `lastT1AtToolCount` because
    //     the catch block bumps the latter to back off after a
    //     transient reflector error WITHOUT having collapsed
    //     anything. The T2 schedule check below is gated on this
    //     counter (==0 means "no T1 ever rewrote the arc, T2 may
    //     fall back at end_turn").
    const turnStartIdx = conversationMessages.length - 1;
    let queryToolCount = 0;
    let lastT1AtToolCount = 0;
    let arcStartIdx = turnStartIdx + 1;
    let t1CollapsesDone = 0;
    const queryNumber = (this.#__queryCounter = (this.#__queryCounter || 0) + 1);

    // feat-6af5f9f1 PR B: a Turn = one user prompt + all AI responses.
    // `queryTurnId` is the wire-level turn identifier; every event emitted
    // during this query() carries it as `turnId`. Each LLM call inside
    // the loop is a `loopNumber` (was wire field `turnNumber`).

    yield {
      type: 'turn_open',
      turnId: queryTurnId,
      threadId,
      userPrompt: userQuestionPreview,
      vpId: queryVpId,
      sessionId: sessionId || null,
      at: queryStartedAt,
    };
    // Skill selection is emitted at the provider-request boundary below. A
    // persisted Plugin update may replace the filtered SkillManager while this
    // query is paused on a tool, so reporting it before that boundary could
    // claim a Skill was loaded even though its content never reached a request.

    // Surface the exact memory that entered the prompt. This must be based on
    // the AMS snapshot, not raw FTS candidates, otherwise debug can claim memory
    // was loaded even when prompt cleanup, dedupe, or token budget dropped it.
    if (loadedMemoryForDebug.length > 0) {
      yield {
        type: 'memory_used',
        turnId: queryTurnId,
        loaded: loadedMemoryForDebug,
        meta: loadedMemoryMetaForDebug,
      };
    }

    if (dreamResidentLoaded.length > 0) {
      yield {
        type: 'dream_memory_loaded',
        turnId: queryTurnId,
        vpId: queryVpId,
        sessionId: sessionId || null,
        loadedInto: 'system_prompt.memory',
        resident: dreamResidentLoaded,
      };
    }

    let toolDefs = this.#getToolDefs(effectiveCollabToolPolicy, activeToolNames);
    let turnNumber = 0;
    let continueTurns = 0; // auto-continue counter
    let toolLoopTurns = 0; // task-327b: tool-use turns for long-loop auto-bump
    let fullResponseText = '';
    let displayImageAnchorMessage = null;
    let lastPersistedAssistantMessage = null;
    let lastPersistedAssistantTextMessage = null;
    // `refreshConfig()` may publish a new Session model while a stream or a
    // tool is running. Apply it only before the next provider request; the
    // current request keeps the snapshot captured below.
    let currentModel = this.#config.model;
    let primaryModelAtLastBoundary = currentModel;
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let activeProviderRequest = null;
    // Skill events describe the selection injected into each provider request.
    // The first request must report its initial selection; later loops report
    // only newly added Skills or a newly introduced explicit-command error.
    let reportedSkillNames = new Set();
    let reportedSkillError = null;
    // task-707: tool-callable end-turn signal. Tools (currently only
    // `route_forward`) can set this via toolCtx.requestEndTurn(reason)
    // to break out of the tool-loop after the current batch finishes
    // — without invoking another adapter.stream(). Used to hand off
    // control to other VPs cleanly. Reset to null at the top of every
    // outer-loop iteration so the flag never carries across turns.
    let endTurnRequested = null;
    // StartPlan is a control tool. If the model emits only the checklist after
    // it, there is no new workspace fact to interpret: persist the plan and
    // close the turn instead of spending another provider request on a
    // TodoWrite-only control round. A later user turn can continue the first
    // pending step; a batch that includes a real work tool always continues.
    let planBootstrapPending = false;

    // LLM retry bookkeeping (rate-limit / 5xx / transient network errors).
    // Counts CONSECUTIVE retryable failures on the same turn — reset to 0
    // on any successful stream() iteration, and also on a fallback-model
    // switch (the new model gets a fresh budget). Reaching maxRetries
    // gives up: we either fall back to a backup model or surface the
    // error to the user. Context errors are surfaced immediately and do
    // not count against this budget.
    let retryPolicy = resolveRetryPolicy(this.#config);
    let consecutiveRetryableErrors = 0;
    let consecutiveForbiddenErrors = 0;
    let contentPolicyRecoveryAttempts = 0;

    while (true) {
      turnNumber++;

      // `refreshConfig()` is called by the bridge after a persisted Session or
      // Agent config update. This is the only point a running query adopts the
      // new primary model, so an in-flight provider stream is never switched.
      // Keep a retry fallback selected by this query; replacing it here would
      // turn an exhausted primary into an endless retry loop.
      if (currentModel === primaryModelAtLastBoundary) {
        const refreshedPrimaryModel = this.#config.model;
        if (refreshedPrimaryModel !== primaryModelAtLastBoundary) {
          currentModel = refreshedPrimaryModel;
          primaryModelAtLastBoundary = refreshedPrimaryModel;
        }
      }

      // Take one immutable runtime snapshot before any request-specific work.
      // A Session save racing preflight must be picked up by the next loop, not
      // this request. Fallback retries intentionally retain their selected
      // model, but still use the current policy and configured effort.
      const requestConfig = { ...this.#config };
      // Capture the matching provider catalog in the same synchronous boundary
      // as config/model. Preflight may yield user/task events before the stream
      // is built, but one request must never mix two refresh revisions.
      const requestAdapter = typeof this.#adapter.captureRequest === 'function'
        ? this.#adapter.captureRequest()
        : this.#adapter;
      retryPolicy = resolveRetryPolicy(requestConfig);

      // task-324: no hard MAX_TURNS cap. Loop terminates on end_turn,
      // non-retryable error, LLMContextError, or caller abort.

      // task-325a: check for user abort at the top of every turn so a
      // signal that fires between turns (e.g. during tool execution in
      // the previous iteration) cleanly ends the loop instead of
      // launching another adapter stream.
      if (signal?.aborted) {
        if (retryLifecycle.lastPersistedPartial
            && typeof this.#conversationStore?.update === 'function') {
          const abortedPartial = this.#conversationStore.update(
            retryLifecycle.lastPersistedPartial,
            { stopReason: 'aborted' },
          );
          if (abortedPartial) retryLifecycle.lastPersistedPartial = abortedPartial;
        }
        retryLifecycle.pendingContinuation = null;
        yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
        yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId, terminal: true };
        break;
      }

      const turnId = this.#trace.startTurn({
        // Persist the wire-level query turn id, not the Engine-instance trace id.
        // Debug history groups SQLite loop rows by traceId; using #traceId here
        // merged separate user requests into one debug turn, so every request's
        // first LLM call showed up as another stale "Loop 1" under the same row.
        traceId: queryTurnId,
        turnNumber,
        // fix-vp-multi-thread (bug 4): stamp routing context so the
        // debug-trace SQL row carries enough info to be filtered by
        // group / thread / VP later when the panel hydrates from disk.
        sessionId: sessionId || null,
        vpId: queryVpId || null,
        threadId: threadId || null,
        // Persist the user prompt EXPLICITLY rather than reconstruct it
        // post-hoc from `messages_json` — every tool-loop iteration
        // writes the *cumulative* messages array, so deriving the prompt
        // from `messages.find(role==='user')` would always return turn
        // 1's prompt and mislabel every subsequent Turn header.
        userPrompt: userQuestionPreview,
        // Persist the exact AMS projection that produced memoryInjection. Live
        // memory_used events are only progress signals and disappear on reload.
        memoryLoaded: loadedMemoryForDebug,
        memoryLoadedMeta: loadedMemoryMetaForDebug,
      });

      const startTime = Date.now();
      const requestPerfStart = perfNowMs();
      let firstEventTraced = false;
      traceRequest('llm.request_start', {
        detail: {
          model: currentModel,
          loop: turnNumber,
          messageCount: conversationMessages.length,
          toolDefCount: toolDefs.length,
        },
      });
      let ttfbMs = null;  // Time to first token
      let responseText = '';
      let incompleteAssistantPersisted = false;
      const persistIncompleteAssistantOnce = (reason) => {
        if (incompleteAssistantPersisted || !responseText) return null;
        incompleteAssistantPersisted = true;
        return this.#persistConversationMessage({ role: 'assistant', content: responseText, responseKind: 'progress' }, {
          sessionId: runtimeSessionId,
          turnId: vpTurnId || queryTurnId,
          model: currentModel,
          incomplete: true,
          stopReason: reason,
          executionOrigin,
        });
      };
      const toolCalls = [];
      const thinkingBlocks = []; // task-327d: collected from adapter for round-trip
      let stopReason = 'end_turn';
      const totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheInputDeltaTokens: 0 };
      // task-344: capture bounded raw request / raw response for the debug
      // panel. Both exchanges obey the live telemetry budget before they
      // reach durable debug trace storage.
      let rawRequest = null;
      let rawResponse = null;
      const rawExchangeMaxBytes = Number.isFinite(Number(this.#config?.telemetry?.rawExchangeMaxBytes))
        ? Math.max(0, Number(this.#config.telemetry.rawExchangeMaxBytes))
        : 512 * 1024;
      const captureRawExchange = (exchange) => {
        if (exchange?.rawRequest) rawRequest = boundRawExchange(exchange.rawRequest, rawExchangeMaxBytes);
        if (exchange?.rawResponse) rawResponse = boundRawExchange(exchange.rawResponse, rawExchangeMaxBytes);
      };

      // task-704b: resolve the live model's context window for this turn.
      // Used by the per-tool-result cap (passed via toolCtx) and the
      // pre-flight total-token guard inside the try-block. Hoisted out of
      // the try so toolCtx (built after the adapter stream) can see it.
      // Re-resolved every turn because fallbackModel switches change
      // `currentModel` mid query() — the cap MUST track the model we're
      // actually about to call. Single resolver in models.js owns the
      // fallback ladder (registry → config → default) so engine.js and
      // tools/registry.js can never disagree.
      const currentContextWindow = resolveContextWindow(currentModel, requestConfig);

      const appendedBeforeStream = this.#drainPendingUserMessages(drainPendingUserMessages);
      if (appendedBeforeStream.length > 0) {
        for (const item of appendedBeforeStream) {
          this.#persistAppendedUserMessage(item, runtimeSessionId);
          conversationMessages.push({ role: 'user', content: item.content });
          yield {
            type: 'user_append',
            turnId: queryTurnId,
            loopNumber: turnNumber,
            threadId,
            preview: String(item.preview || '').slice(0, 200),
            internal: Boolean(item.internal),
          };
        }
      }
      const taskResultUpdatesBeforeStream = this.#drainPendingTaskResultUpdates(conversationMessages);
      if (taskResultUpdatesBeforeStream.length > 0) {
        // A completed sub-agent can have mutated the shared workspace while
        // this query was parked. Its task-result update is the authoritative
        // synchronization point before the next provider loop.
        invalidateReadOnlyToolReuse();
      }
      if (taskResultUpdatesBeforeStream.length > 0) {
        for (const update of taskResultUpdatesBeforeStream) {
          yield {
            type: 'tool_result_update',
            turnId: queryTurnId,
            loopNumber: turnNumber,
            threadId,
            taskId: update.taskId,
            toolCallId: update.toolCallId,
            content: update.content,
            preview: update.preview,
          };
        }
      }

      // Tool availability depends on live Session state. A Bash call can start a
      // background task (or a sub-agent can appear) during the prior loop, so
      // recompute the schemas and matching guidance before every provider call.
      activeTaskSnapshots = this.#taskManager
        && typeof this.#taskManager.listActiveTasks === 'function'
        ? this.#taskManager.listActiveTasks(runtimeSessionId)
        : [];
      activeTasks = this.#taskManager
        ? this.#taskManager.renderActiveTasksForPrompt(runtimeSessionId, {
            language: this.#config.language || 'en',
          })
        : '';
      activeToolNames = resolveCurrentActiveToolNames();
      for (const name of [...discoveredToolNames]) {
        if (this.#toolRegistry?.has(name)) activeToolNames?.add(name);
        else discoveredToolNames.delete(name);
      }
      toolDefs = this.#getToolDefs(effectiveCollabToolPolicy, activeToolNames);
      ({ resolvedSkillContent, resolvedSkills, skillResolutionError } = resolveSkillPromptState({
        skillManager: this.#skillManager,
        prompt,
        explicitSkillName,
      }));
      const currentSkillNames = new Set(resolvedSkills.map(skill => skill.name));
      for (const skill of resolvedSkills) {
        if (!reportedSkillNames.has(skill.name)) {
          yield { type: 'skill_loaded', turnId: queryTurnId, skill };
        }
      }
      if (skillResolutionError && skillResolutionError !== reportedSkillError) {
        yield { type: 'skill_error', turnId: queryTurnId, skillName: explicitSkillName, message: skillResolutionError };
      }
      reportedSkillNames = currentSkillNames;
      reportedSkillError = skillResolutionError;
      systemPrompt = buildCurrentSystemPrompt();

      try {
        // Resolve effort per provider request so a saved Session effort takes
        // effect at the next loop. A caller override or `/effort` prefix stays
        // fixed for this query and still wins over live Session config.
        const configuredEffort = normalizeEffort(requestConfig.modelEffort);
        const requestUserEffort = userEffort || configuredEffort || null;
        let resolvedEffort = pickEffort({ scenario, toolLoopTurns, userEffort: requestUserEffort });

        // DESIGN.md §9.16: thinking-mode precedence chain. When a VP
        // persona is active, the router/continuity bookkeeping has more
        // signal than the raw scenario tag — the prior assistant turn's
        // routerPlan, the VP's role default, and the global config all
        // outrank the scenario picker for `'high'|'max'`. UI/userEffort
        // is already honoured by pickEffort (highest precedence).
        if (vpPersona && vpPersona.vpId) {
          const priorPlan = extractPriorPlan(conversationMessages, vpPersona.vpId);
          const thinkingCfg = (this.#config && this.#config.thinking) || {};
          // PR-I: live routerPlan.thinking — when the dispatcher passes
          // `vpPlan` for this turn (per-VP plan from the V2 router) and its
          // `vpId` matches the active persona, surface its `thinking` field
          // to resolveThinking. Mismatched vpId means the plan addresses a
          // different VP — ignore it for this VP's thinking decision.
          const liveRouterThinking = (vpPlan && typeof vpPlan === 'object'
            && typeof vpPlan.vpId === 'string' && vpPlan.vpId === vpPersona.vpId
            && (vpPlan.thinking === 'high' || vpPlan.thinking === 'max'))
            ? vpPlan.thinking
            : null;
          const resolved = resolveThinking({
            uiOverride: (requestUserEffort === 'max' || requestUserEffort === 'high') ? requestUserEffort : null,
            routerPlan: liveRouterThinking,
            priorPlan: priorPlan && priorPlan.thinking ? priorPlan.thinking : null,
            vpDefault: typeof vpPersona.thinking === 'string' ? vpPersona.thinking : null,
            globalDefault: typeof thinkingCfg.default === 'string' ? thinkingCfg.default : null,
            allowRouterEscalate: thinkingCfg.allowRouterEscalate !== false,
          });
          // Only adopt the chain's choice when it strengthens the
          // baseline. We never weaken below pickEffort (e.g. explicit
          // 'ultra' or consolidate='max' must not be downgraded by a VP
          // default or router plan).
          if (resolvedEffort !== 'ultra'
            && (resolved.value === 'max' || (resolved.value === 'high' && resolvedEffort === 'low'))) {
            resolvedEffort = resolved.value;
          }
        }

        // Phase 8 PR-E: archive bulky tool results before they go on the
        // wire. archiveToolResults walks the messages array and replaces
        // any `role:'tool'` body older than turnAgeMin AND larger than
        // lengthMin with a small stub, persisting the original to
        // <yeaftDir>/memory/<scopeDir>/archive/tool-results/<id>.md so
        // message_trace can fetch it on demand. The stub keeps the
        // OpenAI/Anthropic toolCallId pairing intact.
        const pendingContinuationForRequest = retryLifecycle.pendingContinuation;
        // Bound only this provider copy. The durable transcript and the live
        // query tape remain complete; no summary is generated and no history
        // rows are rewritten. This also protects later tool-loop requests,
        // not just the initial snapshot assembled by the bridge.
        const requestHistory = trimSnapshotForBudget(conversationMessages, {
          messageTokenBudget: requestConfig.messageTokenBudget,
          language: requestConfig.language,
        });
        let wireMessages = stripMetaForWire(pendingContinuationForRequest
          ? [...requestHistory, pendingContinuationForRequest]
          : requestHistory);

        if (scenario !== 'work-item' && this.#yeaftDir && (this.#config?.archive?.toolResults !== false)) {
          try {
            const swept = await archiveToolResults({
              root: `${this.#yeaftDir}/memory`,
              scopeDir: 'user',
              messages: wireMessages,
              turnAgeMin: this.#config?.archive?.turnAgeMin,
              lengthMin: this.#config?.archive?.lengthMin,
            });
            // Keep the live query tape and persisted transcript raw. The
            // archive result is a provider-only copy; a later request may
            // repeat this best-effort archive lookup without losing history.
            wireMessages = swept.nextMessages;
          } catch { /* best-effort */ }
        }

        // task-704b: pre-flight total-token guard. Even with the per-tool
        // cap (registry.js: 10% of contextWindow per result), N tool
        // results plus history can still breach the wire limit before we
        // ever call adapter.stream(). Estimate the total token cost; if
        // it exceeds PREFLIGHT_RATIO of the live context window, run an
        // emergency archive sweep with `turnAgeMin: 0` so even
        // current-turn-but-not-this-call bulky results get stubbed. The
        // normal sweep above only stubs results older than 5 user turns
        // — that's the wrong cadence when the *current* turn already has
        // 4 large grep results.
        //
        // PREFLIGHT_RATIO = 0.85 leaves ~15% of the window for the model's
        // own output tokens + tools metadata + light future history.
        // The estimator (`estimateMessagesTokens`) is approxTokens
        // (char/4 with CJK weighting) — good enough for a guard rail; a
        // real tokenizer would be exact but adds a heavy dep.
        if (scenario !== 'work-item' && this.#yeaftDir && (this.#config?.archive?.toolResults !== false)) {
          const PREFLIGHT_RATIO = 0.85;
          const threshold = Math.floor(currentContextWindow * PREFLIGHT_RATIO);
          const estimate = estimateMessagesTokens(systemPrompt, wireMessages);
          if (estimate > threshold) {
            try {
              const sweep = await archiveToolResults({
                root: `${this.#yeaftDir}/memory`,
                scopeDir: 'user',
                messages: wireMessages,
                turnAgeMin: 0,
                lengthMin: this.#config?.archive?.lengthMin ?? 2000,
              });
              wireMessages = sweep.nextMessages;
              if (sweep.archivedCount > 0) {
                this.#trace.log?.('preflight_sweep', {
                  archivedCount: sweep.archivedCount,
                  archivedBytes: sweep.archivedBytes,
                  estimateBefore: estimate,
                  threshold,
                  contextWindow: currentContextWindow,
                });
              }
            } catch { /* best-effort */ }
          }
        }

        // Capture only the provider route before the visible boundary. The
        // returned async iterable must not make a request or write durable
        // state; both the retry continuation and Work Center EngineTurn remain
        // uncommitted until the consumer resumes this `turn_start`.
        //
        // Engine configuration and AdapterRouter catalog were captured together
        // at the loop boundary above. Building the stream here and refreshing
        // while `turn_start` is visible cannot alter this request revision.
        const hasCaptureStream = typeof requestAdapter.captureStream === 'function';
        const captureStream = hasCaptureStream
          ? requestAdapter.captureStream.bind(requestAdapter)
          : requestAdapter.stream.bind(requestAdapter);
        let continuationCommitted = false;
        const commitRetryContinuation = () => {
          if (continuationCommitted
              || !pendingContinuationForRequest
              || retryLifecycle.pendingContinuation !== pendingContinuationForRequest) return;
          const persisted = this.#persistConversationMessage(pendingContinuationForRequest, {
            sessionId: runtimeSessionId,
          });
          if (persisted) pendingContinuationForRequest._persistedMessageId = persisted.id;
          conversationMessages.push(pendingContinuationForRequest);
          retryLifecycle.pendingContinuation = null;
          continuationCommitted = true;
        };
        const commitDispatch = () => {
          if (!activeProviderRequest && typeof prepareProviderRequest === 'function') {
            activeProviderRequest = prepareProviderRequest({
              turnNumber,
              entries: appendedBeforeStream,
              system: systemPrompt,
              messages: wireMessages.map(mapDebugMessage),
              model: currentModel,
            }) || null;
          }
          startProviderRequest?.(activeProviderRequest);
          commitRetryContinuation();
        };
        const providerStream = captureStream({
          model: currentModel,
          system: systemPrompt,
          messages: wireMessages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          maxTokens: requestConfig.maxOutputTokens || 16384,
          effort: resolvedEffort,
          effortSource: requestUserEffort ? 'user' : 'auto',
          signal,
          onRawExchange: captureRawExchange,
          rawExchangeMaxBytes,
          onRequestStart: () => {
            // Native adapters invoke this immediately before fetch(). A retry
            // continuation and Work Center EngineTurn become durable only when
            // their request crosses dispatch, never when turn_start is shown.
            commitDispatch();
          },
        });
        yield { type: 'turn_start', turnNumber, threadId };

        // Provider iteration begins after the visible boundary. Native adapters
        // commit in onRequestStart immediately before fetch. A plain legacy
        // adapter only enters its generator at iteration, so preserve its old
        // dispatch semantics while keeping captured Router requests inert.
        if (signal?.aborted) throw new LLMAbortError();
        if (!hasCaptureStream) commitDispatch();

        // Snapshot task results carried by this exact request. Request start
        // is not delivery: fetch may remain pending and then be aborted before
        // the provider processes anything. Ack only after a normal stream end
        // that included the provider's terminal stop event.
        const requestAsyncTaskIds = Array.from(this.#pendingAsyncTaskConfirmIds);
        let sawProviderStop = false;
        for await (const event of providerStream) {
          // task-325a (abort-stop fix): per-event abort short-circuit.
          // The adapter is expected to throw AbortError when fetch's
          // signal fires, but in practice undici/HTTP-2/proxy layers
          // can hand us a batch of SSE chunks that were already buffered
          // when abort was requested. Those chunks would otherwise be
          // forwarded to the caller (web-bridge → WS → browser) for
          // 1–2s after the user pressed Stop, producing the exact
          // symptom "Stop button doesn't stop the turn". Drop every
          // post-abort event by throwing into the outer catch, which
          // converges on the same `aborted` + `turn_end` terminal pair
          // as the adapter-throws-AbortError path.
          if (signal?.aborted) {
            throw new LLMAbortError();
          }
          if (!firstEventTraced) {
            firstEventTraced = true;
            traceRequest('llm.first_event', {
              durationMs: perfNowMs() - requestPerfStart,
              detail: { eventType: event.type, model: currentModel },
            });
          }
          switch (event.type) {
            case 'text_delta':
              if (ttfbMs === null) {
                ttfbMs = Date.now() - startTime;
                traceRequest('llm.first_text', {
                  durationMs: perfNowMs() - requestPerfStart,
                  detail: { model: currentModel },
                });
              }
              responseText += event.text;
              yield event;
              break;
            case 'thinking_delta':
              yield event;
              break;
            case 'thinking_block_end':
              // task-327d: collect server-signed thinking block for
              // round-trip replay. Anthropic 400s the next turn if a
              // thinking block (regular or redacted) was emitted but not
              // echoed back with its original signature. Drop blocks
              // missing a signature — replay-without-sig 400s identically.
              if (event.signature) {
                if (event.redacted) {
                  thinkingBlocks.push({ redacted: true, data: event.data, signature: event.signature });
                } else {
                  thinkingBlocks.push({ thinking: event.thinking, signature: event.signature });
                }
              } else {
                console.warn('[Engine] thinking block missing signature — dropping; next turn would 400 on replay');
              }
              break;
            case 'tool_call':
              if (toolCalls.length === 0) {
                traceRequest('llm.first_tool_call', {
                  durationMs: perfNowMs() - requestPerfStart,
                  detail: { name: event.name || null, model: currentModel },
                });
              }
              toolCalls.push(event);
              yield event;
              break;
            case 'usage': {
              const inputTokens = event.inputTokens || 0;
              const outputTokens = event.outputTokens || 0;
              const cacheReadTokens = event.cacheReadTokens || 0;
              const cacheWriteTokens = event.cacheWriteTokens || 0;
              const cacheInputDeltaTokens = event.cacheTokensAreIncludedInInput ? 0 : cacheReadTokens + cacheWriteTokens;
              totalUsage.inputTokens += inputTokens;
              totalUsage.outputTokens += outputTokens;
              totalUsage.cacheReadTokens += cacheReadTokens;
              totalUsage.cacheWriteTokens += cacheWriteTokens;
              totalUsage.cacheInputDeltaTokens += cacheInputDeltaTokens;
              cumulativeInputTokens += inputTokens + cacheInputDeltaTokens;
              cumulativeOutputTokens += outputTokens;
              yield event;
              break;
            }
            case 'stop':
              sawProviderStop = true;
              stopReason = event.stopReason;
              yield event;
              break;
            case 'error': {
              const adapterError = event.error instanceof Error
                ? event.error
                : new Error(String(event.error?.message || event.error || 'LLM stream error'));
              adapterError.retryable = Boolean(event.retryable);
              if (event.retryable) {
                if (adapterError instanceof LLMRateLimitError || adapterError instanceof LLMServerError) {
                  throw adapterError;
                }
                throw new LLMServerError(adapterError.message, adapterError.statusCode ?? 0);
              }
              if (adapterError instanceof LLMRateLimitError || adapterError instanceof LLMServerError) {
                const nonRetryableError = new Error(adapterError.message);
                nonRetryableError.name = adapterError.name || 'LLMStreamError';
                nonRetryableError.code = adapterError.code;
                nonRetryableError.statusCode = adapterError.statusCode;
                nonRetryableError.retryable = false;
                throw nonRetryableError;
              }
              throw adapterError;
            }
          }
        }
        // Some proxies resolve the SSE body cleanly after AbortSignal instead
        // of throwing. Do not treat that truncated stream as a successful
        // model response or let it reach stop hooks/persistence.
        if (signal?.aborted) {
          throw new LLMAbortError();
        }
        // A provider terminal stop plus normal stream completion proves that
        // the request containing these task results completed successfully.
        // Retryable errors, aborts, idle timeouts, and truncated streams keep
        // escrow so retry or final rescue can deliver the payload.
        if (sawProviderStop) {
          this.#confirmAsyncTaskResults(requestAsyncTaskIds);
          const completedProviderRequest = activeProviderRequest;
          activeProviderRequest = null;
          finishProviderRequest?.(completedProviderRequest, {
            responseText,
            stopReason,
            toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
            thinkingBlocks,
          });
        }
        traceRequest('llm.request_complete', {
          durationMs: perfNowMs() - requestPerfStart,
          ok: true,
          detail: {
            model: currentModel,
            stopReason,
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            toolCallCount: toolCalls.length,
            responseTextBytes: Buffer.byteLength(responseText, 'utf8'),
          },
        });
        // Stream completed without throwing — reset the retry counter so
        // the next turn starts with a clean budget. In-band adapter errors
        // are converted to throws above so they share the real error path.
        consecutiveRetryableErrors = 0;
      } catch (err) {
        const latencyMs = Date.now() - startTime;
        if (activeProviderRequest) {
          failProviderRequest?.(activeProviderRequest, err);
          activeProviderRequest = null;
        }

        const endAttemptTrace = (attemptStopReason) => {
          this.#trace.endTurn(turnId, {
            model: currentModel,
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            cacheReadTokens: totalUsage.cacheReadTokens,
            cacheWriteTokens: totalUsage.cacheWriteTokens,
            stopReason: attemptStopReason,
            latencyMs,
            responseText,
            systemPrompt,
            messages: conversationMessages.map(mapDebugMessage),
            toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
            usage: {
              inputTokens: totalUsage.inputTokens || 0,
              outputTokens: totalUsage.outputTokens || 0,
              cacheReadTokens: totalUsage.cacheReadTokens || 0,
              cacheWriteTokens: totalUsage.cacheWriteTokens || 0,
              totalInputTokens: (totalUsage.inputTokens || 0) + (totalUsage.cacheInputDeltaTokens || 0),
              totalTokens: (totalUsage.inputTokens || 0) + (totalUsage.cacheInputDeltaTokens || 0) + (totalUsage.outputTokens || 0),
            },
            ttfbMs,
            rawRequest,
            rawResponse,
          });
        };

        const prepareRetryContinuation = () => {
          if (!responseText || toolCalls.length > 0) return null;
          const partialAssistant = {
            role: 'assistant',
            content: responseText,
            incomplete: true,
            responseKind: 'progress',
          };
          const persistedPartial = persistIncompleteAssistantOnce('retry');
          if (persistedPartial) {
            partialAssistant._persistedMessageId = persistedPartial.id;
            lastPersistedAssistantTextMessage = persistedPartial;
            retryLifecycle.lastPersistedPartial = persistedPartial;
          }
          conversationMessages.push(partialAssistant);
          fullResponseText += responseText;
          retryLifecycle.pendingContinuation = {
            role: 'user',
            content: RETRY_CONTINUATION_PROMPT,
            userAuthored: false,
          };
          return persistedPartial;
        };

        // Abort/retry/fallback are not final assistant responses. Handle them
        // before writing debug loop rows; otherwise transient DeepSeek stream
        // cuts or user stops show up as bogus `Error: Request aborted` replies.
        const earlyIsAbort = err instanceof LLMAbortError
          || err?.name === 'AbortError'
          || err?.name === 'LLMAbortError'
          || (signal?.aborted && /abort/i.test(err?.message || ''));
        if (earlyIsAbort || signal?.aborted) {
          const abortedPartial = persistIncompleteAssistantOnce('aborted');
          if (abortedPartial) {
            retryLifecycle.lastPersistedPartial = abortedPartial;
          } else if (retryLifecycle.lastPersistedPartial
              && typeof this.#conversationStore?.update === 'function') {
            const updatedPartial = this.#conversationStore.update(
              retryLifecycle.lastPersistedPartial,
              { stopReason: 'aborted' },
            );
            if (updatedPartial) retryLifecycle.lastPersistedPartial = updatedPartial;
          }
          retryLifecycle.pendingContinuation = null;
          traceRequest('llm.request_abort', {
            durationMs: perfNowMs() - requestPerfStart,
            ok: false,
            detail: {
              model: currentModel,
              abortReason: this.#abortReason || 'external',
              errorName: err?.name || null,
              signalAborted: !!signal?.aborted,
            },
          });
          endAttemptTrace('aborted');
          yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
          yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId, terminal: true };
          break;
        }

        traceRequest('llm.request_error', {
          durationMs: perfNowMs() - requestPerfStart,
          ok: false,
          detail: {
            model: currentModel,
            errorName: err?.name || null,
            statusCode: err?.statusCode ?? null,
            retryable: err instanceof LLMRateLimitError || err instanceof LLMServerError,
            reasonCode: err?.reasonCode || null,
            message: String(err?.message || '').slice(0, 200),
          },
        });

        const earlyIsRateLimit = err instanceof LLMRateLimitError;
        const earlyIsTransient = err instanceof LLMServerError;
        const earlyIsContentPolicy = err instanceof LLMPolicyError;
        // A completed tool_call has already crossed the streaming boundary to
        // the caller. Replaying that request would publish a duplicate call and
        // leave ambiguous execution ownership, so only pre-tool failures are
        // eligible for transparent retry or model fallback.
        const canReplayProviderRequest = toolCalls.length === 0;
        if (earlyIsContentPolicy && canReplayProviderRequest && contentPolicyRecoveryAttempts === 0) {
          contentPolicyRecoveryAttempts = 1;
          endAttemptTrace('llm_retry');
          if (responseText) prepareRetryContinuation();
          retryLifecycle.pendingContinuation = {
            role: 'user',
            content: POLICY_RECOVERY_PROMPT,
            userAuthored: false,
          };
          yield {
            type: 'llm_retry',
            attempt: 1,
            maxRetries: 1,
            delayMs: 0,
            reason: 'content_policy_recovery',
            recoveryMode: 'continue',
            errorName: err.name,
            statusCode: err.statusCode ?? 422,
            message: 'Provider content-safety rejection; retrying once with sensitive examples abstracted.',
          };
          yield { type: 'turn_end', turnNumber, stopReason: 'llm_retry', threadId };
          continue;
        }
        const earlyIsTemporaryForbidden = err instanceof LLMAuthError
          && err.statusCode === 403
          && err.temporary === true;
        if (earlyIsTemporaryForbidden && canReplayProviderRequest
          && consecutiveForbiddenErrors < retryPolicy.forbiddenRetryDelaysMs.length) {
          const delayMs = retryPolicy.forbiddenRetryDelaysMs[consecutiveForbiddenErrors];
          consecutiveForbiddenErrors += 1;
          endAttemptTrace('llm_retry');
          yield {
            type: 'llm_retry',
            attempt: consecutiveForbiddenErrors,
            maxRetries: retryPolicy.forbiddenRetryDelaysMs.length,
            delayMs,
            reason: 'temporary_forbidden',
            recoveryMode: 'restart',
            errorName: err.name,
            statusCode: 403,
            message: `LLM provider returned HTTP 403; retry ${consecutiveForbiddenErrors}/${retryPolicy.forbiddenRetryDelaysMs.length}`,
          };
          const slept = await sleepWithAbort(delayMs, signal);
          if (!slept || signal?.aborted) {
            yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
            yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId, terminal: true };
            break;
          }
          yield { type: 'turn_end', turnNumber, stopReason: 'llm_retry', threadId };
          continue;
        }
        if ((earlyIsRateLimit || earlyIsTransient) && canReplayProviderRequest) {
          if (consecutiveRetryableErrors < retryPolicy.maxRetries) {
            consecutiveRetryableErrors += 1;
            let delayMs;
            let reason;
            if (earlyIsRateLimit && Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) {
              delayMs = Math.min(retryPolicy.maxDelayMs, err.retryAfterMs);
              reason = 'rate_limit_retry_after';
            } else if (earlyIsRateLimit) {
              delayMs = computeBackoffDelay(retryPolicy, consecutiveRetryableErrors);
              reason = 'rate_limit_backoff';
            } else {
              delayMs = computeBackoffDelay(retryPolicy, consecutiveRetryableErrors - 1);
              reason = err instanceof LLMStreamIdleTimeoutError
                ? 'stream_idle_timeout'
                : 'transient_backoff';
            }
            // A retry is a brand-new provider request. Replaying the original
            // request after forwarding partial text duplicates that text in
            // the UI and can make the model restart its answer. Preserve the
            // accepted prefix as an incomplete assistant boundary, then ask
            // the next request to continue from it.
            const recoveryMode = responseText && toolCalls.length === 0 ? 'continue' : 'restart';
            endAttemptTrace('llm_retry');
            if (recoveryMode === 'continue') prepareRetryContinuation();
            yield {
              type: 'llm_retry',
              attempt: consecutiveRetryableErrors,
              maxRetries: retryPolicy.maxRetries,
              delayMs,
              reason,
              recoveryMode,
              errorName: err.name,
              statusCode: err.statusCode ?? null,
              message: String(err.message || '').slice(0, 300),
            };
            const slept = await sleepWithAbort(delayMs, signal);
            if (!slept || signal?.aborted) {
              const partial = persistIncompleteAssistantOnce('aborted');
              if (!partial && retryLifecycle.lastPersistedPartial
                  && typeof this.#conversationStore?.update === 'function') {
                const abortedPartial = this.#conversationStore.update(
                  retryLifecycle.lastPersistedPartial,
                  { stopReason: 'aborted' },
                );
                if (abortedPartial) retryLifecycle.lastPersistedPartial = abortedPartial;
              }
              retryLifecycle.pendingContinuation = null;
              yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
              yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId, terminal: true };
              break;
            }
            yield { type: 'turn_end', turnNumber, stopReason: 'llm_retry', threadId };
            continue;
          }
        }

        const earlyFallbackModel = requestConfig.fallbackModel;
        if (earlyFallbackModel && earlyFallbackModel !== currentModel
          && (earlyIsRateLimit || earlyIsTransient) && canReplayProviderRequest) {
          endAttemptTrace('fallback_retry');
          prepareRetryContinuation();
          yield { type: 'fallback', from: currentModel, to: earlyFallbackModel, reason: err.message };
          currentModel = earlyFallbackModel;
          consecutiveRetryableErrors = 0;
          yield { type: 'turn_end', turnNumber, stopReason: 'fallback_retry', threadId };
          continue;
        }

        // A later fresh request can fail before producing text. In that case the
        // durable assistant prefix belongs to this same query and must leave the
        // transient `retry` state even though the current attempt persisted none.
        const persistedErrorPartial = persistIncompleteAssistantOnce('error');
        if (persistedErrorPartial) {
          retryLifecycle.lastPersistedPartial = persistedErrorPartial;
        } else if (retryLifecycle.lastPersistedPartial
          && typeof this.#conversationStore?.update === 'function') {
          const errorPartial = this.#conversationStore.update(
            retryLifecycle.lastPersistedPartial,
            { stopReason: 'error' },
          );
          if (errorPartial) retryLifecycle.lastPersistedPartial = errorPartial;
        }
        retryLifecycle.pendingContinuation = null;

        this.#trace.endTurn(turnId, {
          model: currentModel,
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          cacheReadTokens: totalUsage.cacheReadTokens,
          cacheWriteTokens: totalUsage.cacheWriteTokens,
          stopReason: 'error',
          latencyMs,
          responseText,
          // fix-vp-multi-thread (bug 4): persist the snapshot on the
          // error path too — failure traces are the most valuable for
          // hydration.
          systemPrompt,
          messages: conversationMessages.map(mapDebugMessage),
          toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
          usage: {
            inputTokens: totalUsage.inputTokens || 0,
            outputTokens: totalUsage.outputTokens || 0,
            cacheReadTokens: totalUsage.cacheReadTokens || 0,
            cacheWriteTokens: totalUsage.cacheWriteTokens || 0,
            totalInputTokens: (totalUsage.inputTokens || 0) + (totalUsage.cacheInputDeltaTokens || 0),
            totalTokens: (totalUsage.inputTokens || 0) + (totalUsage.cacheInputDeltaTokens || 0) + (totalUsage.outputTokens || 0),
          },
          ttfbMs,
          rawRequest,
          rawResponse,
        });

        // Emit `loop` event for error path too (was `debug_turn`).
        const errLoopInputTokens = (totalUsage.inputTokens || 0) + (totalUsage.cacheInputDeltaTokens || 0);
        const errLoopOutputTokens = totalUsage.outputTokens || 0;
        yield {
          type: 'loop',
          turnId: queryTurnId,
          threadId,
          loopNumber: turnNumber,
          model: currentModel,
          systemPrompt,
          messages: conversationMessages.map(mapDebugMessage),
          response: responseText || `Error: ${err.message}`,
          toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
          usage: {
            inputTokens: totalUsage.inputTokens || 0,
            outputTokens: errLoopOutputTokens,
            cacheReadTokens: totalUsage.cacheReadTokens || 0,
            cacheWriteTokens: totalUsage.cacheWriteTokens || 0,
            totalInputTokens: errLoopInputTokens,
            totalTokens: errLoopInputTokens + errLoopOutputTokens,
          },
          latencyMs,
          ttfbMs,
          stopReason: 'error',
          // feat-debug-timestamp: epoch ms when this loop completed
          // (request end). The panel uses this to print HH:MM:SS per
          // loop; falls back to turn.openedAt + cumulative latency
          // when missing for hydrated-from-disk loops.
          at: Date.now(),
          rawRequest,
          rawResponse,
        };


        const isRetryableError = err instanceof LLMRateLimitError || err instanceof LLMServerError;
        const errorEvent = {
          type: 'error',
          error: err,
          retryable: isRetryableError,
        };
        if (err instanceof LLMStreamIdleTimeoutError) {
          errorEvent.reason = 'stream_idle_timeout';
          errorEvent.retryExhausted = canReplayProviderRequest
            && consecutiveRetryableErrors >= retryPolicy.maxRetries;
          errorEvent.retryAttempts = consecutiveRetryableErrors;
          errorEvent.maxRetries = retryPolicy.maxRetries;
        } else if (err instanceof LLMPolicyError) {
          errorEvent.reason = 'content_policy_denied';
          errorEvent.retryExhausted = contentPolicyRecoveryAttempts >= 1;
          errorEvent.retryAttempts = contentPolicyRecoveryAttempts;
          errorEvent.maxRetries = 1;
        }
        yield errorEvent;
        yield {
          type: 'turn_end',
          turnNumber,
          stopReason: 'error',
          threadId,
          terminal: true,
          detail: {
            errorName: err?.name || 'Error',
            statusCode: err?.statusCode ?? null,
            reason: errorEvent.reason || err?.reasonCode || null,
          },
        };
        break;
      }

      const latencyMs = Date.now() - startTime;

      const turnInputTokens = (totalUsage.inputTokens || 0) + (totalUsage.cacheInputDeltaTokens || 0);
      const turnOutputTokens = totalUsage.outputTokens || 0;

      // Record turn in debug trace
      this.#trace.endTurn(turnId, {
        model: currentModel,
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        cacheReadTokens: totalUsage.cacheReadTokens,
        cacheWriteTokens: totalUsage.cacheWriteTokens,
        stopReason,
        latencyMs,
        responseText,
        // fix-vp-multi-thread (bug 4): persist the full per-loop
        // snapshot. The frontend debug panel only renders what it has
        // in-memory — without these columns the user can never see
        // history from before the panel was opened.
        systemPrompt,
        messages: conversationMessages.map(mapDebugMessage),
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
        usage: {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
          cacheReadTokens: totalUsage.cacheReadTokens || 0,
          cacheWriteTokens: totalUsage.cacheWriteTokens || 0,
          totalInputTokens: turnInputTokens,
          totalTokens: turnInputTokens + turnOutputTokens,
        },
        ttfbMs,
        rawRequest,
        rawResponse,
      });

      // Build and durably append this completed provider response before
      // yielding any post-stream diagnostics. A consumer may stop iterating at
      // any yield; persistence therefore cannot wait for turn_end or even the
      // debug `loop` event below.
      const assistantMsg = { role: 'assistant', content: responseText, responseKind: 'progress', ...(rawRequest ? { rawRequest } : {}) };
      if (toolCalls.length > 0) {
        assistantMsg.toolCalls = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        }));
      }
      if (thinkingBlocks.length > 0) {
        assistantMsg.thinkingBlocks = thinkingBlocks.map(tb => (
          tb.redacted
            ? { redacted: true, data: tb.data, signature: tb.signature }
            : { thinking: tb.thinking, signature: tb.signature }
        ));
      }
      if (vpPersona && vpPersona.vpId) {
        const planForThisVp = (vpPlan && typeof vpPlan === 'object'
          && typeof vpPlan.vpId === 'string' && vpPlan.vpId === vpPersona.vpId)
          ? vpPlan
          : null;
        attachRouterPlan(assistantMsg, {
          vpId: vpPersona.vpId,
          forwardQuery: planForThisVp && planForThisVp.forwardQuery
            ? planForThisVp.forwardQuery
            : { userOriginal: prompt || '', intent: '' },
          preselect: planForThisVp && planForThisVp.preselect
            ? planForThisVp.preselect
            : undefined,
          thinking: planForThisVp && (planForThisVp.thinking === 'high' || planForThisVp.thinking === 'max')
            ? planForThisVp.thinking
            : null,
          thinkingReason: planForThisVp && typeof planForThisVp.thinkingReason === 'string'
            ? planForThisVp.thinkingReason
            : '',
        });
      }
      const previousImageAnchorMessage = displayImageAnchorMessage;
      if (previousImageAnchorMessage && typeof this.#conversationStore?.update === 'function') {
        const cleared = this.#conversationStore.update(previousImageAnchorMessage, { imageAssetAnchor: false });
        if (cleared) displayImageAnchorMessage = null;
      }
      if (previousImageAnchorMessage && displayImageAnchorMessage === null) assistantMsg.imageAssetAnchor = true;
      const persistedAssistantMessage = this.#persistConversationMessage(assistantMsg, {
        sessionId: runtimeSessionId,
        turnId: vpTurnId || queryTurnId,
        model: currentModel,
        executionOrigin,
      });
      if (persistedAssistantMessage) {
        assistantMsg._persistedMessageId = persistedAssistantMessage.id;
        if (assistantMsg.imageAssetAnchor) displayImageAnchorMessage = persistedAssistantMessage;
        lastPersistedAssistantMessage = persistedAssistantMessage;
      }
      if (responseText.trim() && persistedAssistantMessage) {
        lastPersistedAssistantTextMessage = persistedAssistantMessage;
      }
      if (previousImageAnchorMessage && displayImageAnchorMessage === null && !persistedAssistantMessage) {
        const restored = this.#conversationStore.update(previousImageAnchorMessage, { imageAssetAnchor: true });
        displayImageAnchorMessage = restored || null;
      }

      // Emit `loop` event for the debug panel.
      // feat-6af5f9f1 PR B: a Loop is one LLM call inside a Turn. The wire
      // event was historically named `debug_turn` and carried `turnNumber`,
      // which is misleading — it's per-LLM-call, not per-user-prompt.
      // We emit the new shape (turnId + loopNumber) and keep totalTokens
      // pre-computed so the UI doesn't have to.
      // task-331: preserve toolCalls / toolCallId / isError on each message
      // so the panel can render function_call requests and their paired
      // tool_result responses across loops.
      const loopInputTokens = (totalUsage.inputTokens || 0) + (totalUsage.cacheInputDeltaTokens || 0);
      const loopOutputTokens = totalUsage.outputTokens || 0;
      yield {
        type: 'loop',
        turnId: queryTurnId,
        loopNumber: turnNumber,
        model: currentModel,
        systemPrompt,
        messages: conversationMessages.map(mapDebugMessage),
        response: responseText,
        toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, input: tc.input })),
        usage: {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: loopOutputTokens,
          cacheReadTokens: totalUsage.cacheReadTokens || 0,
          cacheWriteTokens: totalUsage.cacheWriteTokens || 0,
          totalInputTokens: loopInputTokens,
          totalTokens: loopInputTokens + loopOutputTokens,
        },
        latencyMs,
        ttfbMs,
        stopReason,
        // feat-debug-timestamp: epoch ms when this loop completed
        // (request end). The panel uses this to print HH:MM:SS per
        // loop; falls back to turn.openedAt + cumulative latency
        // when missing for hydrated-from-disk loops.
        at: Date.now(),
        rawRequest,
        rawResponse,
      };

      // Keep the same durable assistant object in the live model history.
      // Private router metadata is stripped only at the next wire boundary.
      conversationMessages.push(assistantMsg);
      fullResponseText += responseText;

      // ─── Handle max_tokens → auto-continue ────────────
      if (stopReason === 'max_tokens' && continueTurns < MAX_CONTINUE_TURNS) {
        continueTurns++;
        // This synthetic continuation is part of the model-visible protocol.
        // Persist it before the next provider request so a crash does not leave
        // the completed assistant row without its following user boundary.
        const continueMessage = { role: 'user', content: 'Continue' };
        this.#persistConversationMessage(continueMessage, { sessionId: runtimeSessionId });
        conversationMessages.push(continueMessage);
        yield { type: 'turn_end', turnNumber, stopReason: 'max_tokens_continue', threadId };
        continue; // loop back to call adapter again
      }

      // If new user input was appended while this loop was streaming and
      // there are no tools to force another loop, splice it now and continue
      // instead of ending the thread. A tool response must execute first: an
      // append between assistant(toolCalls) and its tool results would break
      // the provider protocol and discard the entire tool batch. The regular
      // pre-stream drain on the next iteration appends input after those results.
      if (toolCalls.length === 0) {
        const appendedAfterAssistant = this.#drainPendingUserMessages(drainPendingUserMessages);
        if (appendedAfterAssistant.length > 0) {
          for (const item of appendedAfterAssistant) {
            this.#persistAppendedUserMessage(item, runtimeSessionId);
            conversationMessages.push({ role: 'user', content: item.content });
            yield {
              type: 'user_append',
              turnId: queryTurnId,
              loopNumber: turnNumber,
              threadId,
              preview: String(item.preview || '').slice(0, 200),
              internal: Boolean(item.internal),
            };
          }
          yield { type: 'turn_end', turnNumber, stopReason: 'user_append_continue', threadId };
          continue;
        }
      }

      // If no tool calls, we're done — UNLESS we still own a pending
      // result-producing async task. Persistent shell tasks never register
      // here; they remain visible in TaskManager without holding this turn.
      // Registered tasks stay live until they terminate (or the user appends,
      // or abort). The model already
      // said end_turn; we just defer finalization by parking on the
      // wait queue, then splice the synthetic task-result message in
      // and run one more adapter loop. This matches the contract the
      // bridge documents for `formatTaskResultForVp`: "Consume it now:
      // tell the user the outcome or continue the work. Do not wait
      // for another user turn."
      if ((stopReason !== 'tool_use' || toolCalls.length === 0)
          && this.#pendingAsyncTaskIds.size > 0
          && !signal?.aborted) {
        const asyncTaskWaitTimeoutMs = this.#asyncTaskWaitTimeoutMs();
        const deferredTaskIds = [];
        // Drop into a wait loop. The loop wakes on (a) any task
        // terminal event delivered via `notifyAsyncTaskCompleted`, (b)
        // a fresh user append (which is honored as a higher priority
        // user input), or (c) abort. On wake we re-check: if either
        // queue has content, drain + splice + continue the outer loop.
        // If both queues are empty AND we still have pending tasks AND
        // we're not aborted, wait only until the oldest tracked task has
        // been silent for the bounded window. Stale ownership is then
        // released so a later terminal event uses the rescue-turn path.
        yield {
          type: 'async_task_wait_start',
          turnId: queryTurnId,
          loopNumber: turnNumber,
          threadId,
          pendingTaskIds: Array.from(this.#pendingAsyncTaskIds),
        };
        // Race-safe wait: a `notifyAsyncTaskCompleted` callback that
        // arrives synchronously between `yield` and the `await` below
        // (e.g. the bridge handles a task event in the same microtask
        // as the wait_start event) will already have populated the
        // queues, so #waitForAsyncWake resolves immediately on its
        // fast-path check. Drain BEFORE deciding to continue so we
        // never "fall through" with content sitting in either queue.
        while (!signal?.aborted
               && this.#pendingTaskResultMessages.length === 0
               && this.#pendingTaskResultUpdates.length === 0
               && this.#pendingUserMessages.length === 0
               && !this.#externalUserWakePending) {
          if (this.#pendingAsyncTaskIds.size === 0) break;
          const waitMs = this.#nextAsyncTaskWaitMs(asyncTaskWaitTimeoutMs);
          if (await this.#waitForAsyncWake(signal, waitMs) === 'timeout') {
            deferredTaskIds.push(...this.#deferExpiredAsyncTasks(asyncTaskWaitTimeoutMs));
          }
        }
        yield {
          type: 'async_task_wait_end',
          turnId: queryTurnId,
          loopNumber: turnNumber,
          threadId,
          aborted: Boolean(signal?.aborted),
          remainingTaskIds: Array.from(this.#pendingAsyncTaskIds),
          timedOut: deferredTaskIds.length > 0,
          deferredTaskIds,
        };
        if (signal?.aborted) {
          yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
          yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId, terminal: true };
          break;
        }
        if (!signal?.aborted) {
          const taskResultUpdatesAfterAsyncWait = this.#drainPendingTaskResultUpdates(conversationMessages);
          if (taskResultUpdatesAfterAsyncWait.length > 0) {
            // This drain bypasses the next loop's pre-stream drain. A task
            // that completed while we waited may have changed the workspace,
            // so it is the same cache synchronization boundary.
            invalidateReadOnlyToolReuse();
            for (const update of taskResultUpdatesAfterAsyncWait) {
              yield {
                type: 'tool_result_update',
                turnId: queryTurnId,
                loopNumber: turnNumber,
                threadId,
                taskId: update.taskId,
                toolCallId: update.toolCallId,
                content: update.content,
                preview: update.preview,
              };
            }
            yield { type: 'turn_end', turnNumber, stopReason: 'async_task_continue', threadId };
            continue;
          }
          const appendedAfterAsyncWait = this.#drainPendingUserMessages(drainPendingUserMessages);
          if (appendedAfterAsyncWait.length > 0) {
            for (const item of appendedAfterAsyncWait) {
              this.#persistAppendedUserMessage(item, runtimeSessionId);
              conversationMessages.push({ role: 'user', content: item.content });
              yield {
                type: 'user_append',
                turnId: queryTurnId,
                loopNumber: turnNumber,
                threadId,
                preview: String(item.preview || '').slice(0, 200),
                internal: Boolean(item.internal),
                taskId: typeof item.taskId === 'string' ? item.taskId : undefined,
              };
            }
            yield { type: 'turn_end', turnNumber, stopReason: 'async_task_continue', threadId };
            continue;
          }
        }
        // If we fall through here, task ownership was released without a
        // payload (engine teardown / unregister with no notification). Drop
        // into the regular end_turn path.
      }

      // If no tool calls, we're done. Callers with a durable append queue may
      // atomically close it here. A failed close means input won the race with
      // terminal completion, so drain it and keep this same Engine query alive.
      if (stopReason !== 'tool_use' || toolCalls.length === 0) {
        if (typeof closePendingUserInput === 'function' && !closePendingUserInput()) {
          const appendedBeforeClose = this.#drainPendingUserMessages(drainPendingUserMessages);
          if (appendedBeforeClose.length === 0) {
            throw new Error('Could not close pending user input for terminal completion');
          }
          for (const item of appendedBeforeClose) {
            this.#persistAppendedUserMessage(item, runtimeSessionId);
            conversationMessages.push({ role: 'user', content: item.content });
            yield {
              type: 'user_append',
              turnId: queryTurnId,
              loopNumber: turnNumber,
              threadId,
              preview: String(item.preview || '').slice(0, 200),
              internal: Boolean(item.internal),
            };
          }
          yield { type: 'turn_end', turnNumber, stopReason: 'user_append_continue', threadId };
          continue;
        }
        if (pendingSubAgentNotifs.length > 0) {
          acknowledgePendingNotifications(notifScope, pendingSubAgentNotifs.map(n => n.id));
        }
        if (stopReason === 'end_turn'
            && lastPersistedAssistantTextMessage
            && typeof this.#conversationStore?.update === 'function') {
          const resultMessage = this.#conversationStore.update(lastPersistedAssistantTextMessage, {
            responseKind: 'result',
            stopReason,
          });
          if (resultMessage) lastPersistedAssistantTextMessage = resultMessage;
        }
        yield { type: 'turn_end', turnNumber, stopReason, threadId, terminal: true };

        // Message durability is handled incrementally before this terminal
        // branch. There is no hidden end-of-turn LLM maintenance step.

        // PR-L: T2 end-of-turn (asynchronous) reflection. Fires when the
        // total tool count for this query() exceeds TURN_SUMMARY_THRESHOLD
        // (8) AND no T1 has actually rewritten the arc yet. Kicks off the
        // primary-model call without await; the next query()'s
        // `#applyPendingT2Reflections` carries the result forward.
        //
        // Periodic-T1 fix: gate on `t1CollapsesDone === 0`, NOT
        // `lastT1AtToolCount === 0`. The catch block of T1 bumps
        // `lastT1AtToolCount` after a reflector error to avoid
        // tight-loop retries — but no collapse happened, so T2 should
        // still be allowed to fall back at end_turn. Fowler-review
        // critical finding.
        if (groupReflectionAllowed && queryToolCount > TURN_SUMMARY_THRESHOLD && t1CollapsesDone === 0) {
          const arcStart = turnStartIdx + 1;
          const arcEnd = conversationMessages.length - 1;
          if (arcEnd > arcStart) {
            const { pairs, assistantText } = extractToolPairsFromRange(
              conversationMessages, arcStart, arcEnd,
            );
            yield {
              type: 'reflection',
              turnId: queryTurnId,
              loopNumber: turnNumber,
              trigger: 't2',
              status: 'pending',
              loopRange: [arcStart, arcEnd],
              toolCount: pairs.length,
            };
            const promise = runT2Reflection({
              adapter: this.#adapter,
              model: this.#config.model,
              originalUserMsg: prompt,
              toolPairs: pairs,
              assistantText,
              language: this.#config.language,
              signal,
            });
            // Detach: never await. The promise outlives this query() and
            // the next call will pick it up (or use the fallback stub if
            // it hasn't resolved by then).
            // PR-L follow-up: latch a synchronously-readable ready flag
            // and result on the info record so `#applyPendingT2Reflections`
            // can decide ready-vs-pending without racing microtasks.
            const info = {
              promise,
              loopRange: [arcStart, arcEnd],
              count: pairs.length,
              originalUserMsg: prompt,
              originatingTurnId: queryTurnId,
              causalRootId,
              executionOrigin,
              ready: false,
              result: null,
              error: null,
            };
            promise.then(
              (v) => { info.ready = true; info.result = v; },
              (err) => { info.ready = true; info.error = err; },
            );
            this.#pendingT2.set(queryNumber, info);
          }
        }

        break;
      }

      // Execute tool calls and feed results back
      /** @type {{ kind?: string, message?: string, sourceToolCallId?: string, sourceToolName?: string } | null} */
      let toolBatchBarrier = null;
      let currentToolCallForAsyncTask = null;
      // task-707: requestEndTurn is a per-batch closure that lets a tool
      // signal "end this turn after the current batch — no adapter retry".
      // We re-create the closure each iteration because endTurnRequested
      // is a per-query local (reset implicitly at the top of #runQuery).
      const toolCtx = this.#buildToolContext(signal, {
        router,
        senderVpId,
        sessionId: runtimeSessionId,
        projectSessionIds,
        projectInstruction,
        projectLabel,
        threadId: runtimeThreadId,
        inboundEnvelope,
        taskId,
        taskMembers,
        vpPersona,
        contextWindow: currentContextWindow,
        getCurrentTodos,
        setCurrentTodos,
        askUser,
        workDir,
        discoverTools: ({ query, cursor, maxResults } = {}) => {
          if (!this.#toolRegistry) return { query: String(query || ''), tools: [], activated: 0 };
          const language = this.#config.language || 'en';
          const queryText = String(query || '');
          const traversalKey = queryText.trim();
          const liveTools = currentDiscoverableTools();
          const requestedCursor = Number(cursor);
          const hasCursor = cursor != null && cursor !== '' && Number.isInteger(requestedCursor) && requestedCursor > 0;
          let traversal = hasCursor ? discoveryTraversals.get(traversalKey) : null;
          if (hasCursor && (!traversal || !discoveryDirectoryMatches(traversal.candidates, liveTools, language))) {
            discoveryTraversals.delete(traversalKey);
            return {
              query: queryText,
              tools: [],
              next_cursor: null,
              total: liveTools.length,
              omitted_invalid: 0,
              activated: 0,
              restart_required: true,
              message: 'The hidden tool directory changed or no matching traversal exists. Restart discovery without a cursor.',
            };
          }
          if (!hasCursor) {
            traversal = {
              candidates: discoveryDirectorySnapshot(liveTools, language),
            };
            discoveryTraversals.set(traversalKey, traversal);
          } else {
            const pendingTraversal = discoveryTraversals.get(traversalKey);
            if (!pendingTraversal || pendingTraversal.nextCursor !== requestedCursor) {
              discoveryTraversals.delete(traversalKey);
              return {
                query: queryText,
                tools: [],
                next_cursor: null,
                total: liveTools.length,
                omitted_invalid: 0,
                activated: 0,
                restart_required: true,
                message: 'The discovery cursor is stale or out of sequence. Restart discovery without a cursor.',
              };
            }
          }
          const result = discoverToolCapabilities({
            query: queryText,
            candidates: traversal.candidates,
            language,
            cursor,
            maxResults,
          });
          if (result.restart_required || result.next_cursor == null) discoveryTraversals.delete(traversalKey);
          else traversal.nextCursor = result.next_cursor;
          applyDiscoveredTools(result.tools.map(tool => tool.name));
          return {
            query: queryText,
            ...result,
            activated: result.tools.length,
            message: result.restart_required
              ? (result.message || 'The hidden tool directory changed. Restart discovery without a cursor.')
              : (result.tools.length > 0
                  ? (result.next_cursor == null
                      ? 'This discovery page is active on the next model loop; the hidden directory is exhausted.'
                      : 'This discovery page is active on the next model loop; use next_cursor if the target is not listed.')
                  : 'No valid hidden registered tools remain on this directory page.'),
          };
        },
        currentToolCall: () => currentToolCallForAsyncTask ? { ...currentToolCallForAsyncTask } : null,
        requestEndTurn: (reason) => {
          // First call wins — preserve the kind/reason of the first tool
          // that asked to end the turn. Late callers (a second
          // route_forward in the same batch) keep dispatching but don't
          // overwrite the recorded reason.
          if (endTurnRequested == null) {
            endTurnRequested = reason || { kind: 'tool_handoff' };
          }
        },
        requestToolBatchBarrier: (reason) => {
          if (toolBatchBarrier != null) return;
          const detail = reason && typeof reason === 'object'
            ? { ...reason }
            : { message: String(reason || 'A preceding tool result invalidated the remaining batch.') };
          toolBatchBarrier = {
            ...detail,
            sourceToolCallId: currentToolCallForAsyncTask?.id || null,
            sourceToolName: currentToolCallForAsyncTask?.name || null,
          };
        },
      });

      // task-325a: track whether we aborted mid tool-loop so we can
      // break out of the outer while-loop cleanly once the current
      // tool batch finishes reporting.
      let abortedDuringTools = false;
      /** @type {string[]} */
      const pendingDupReminders = [];
      /**
       * Completed executions waiting for their original-order commit. Starting
       * a bounded read-only segment together removes wall-clock latency without
       * changing tool result, persistence, trace, or provider message order.
       * @type {Map<string, { call: object, startedAt: number, durationMs: number, output?: string, error?: Error, toolErrorOutput?: string|null }>}
       */
      const parallelToolExecutions = new Map();
      const announcedParallelToolCalls = new Set();
      const toolAllowedForRequest = (toolCall) => (this.#toolRegistry
        ? this.#toolRegistry.isAllowed(toolCall.name, {
            collabToolPolicy: effectiveCollabToolPolicy,
            plugins: this.#config?.plugins,
            activeToolNames,
          })
        : this.#tools.has(toolCall.name));
      const toolContextForCall = (toolCall) => {
        const stableToolCall = {
          id: toolCall.id,
          name: toolCall.name,
          threadId: runtimeThreadId,
        };
        return {
          ...toolCtx,
          currentToolCall: () => ({ ...stableToolCall }),
          askUser: typeof askUser === 'function'
            ? input => askUser(input, { ...stableToolCall })
            : toolCtx.askUser,
          registerAsyncTask: (taskId, meta = {}) => {
            this.#registerAsyncTask(taskId, { ...stableToolCall, ...(meta || {}) });
          },
          requestToolBatchBarrier: (reason) => {
            if (toolBatchBarrier != null) return;
            const detail = reason && typeof reason === 'object'
              ? { ...reason }
              : { message: String(reason || 'A preceding tool result invalidated the remaining batch.') };
            toolBatchBarrier = {
              ...detail,
              sourceToolCallId: stableToolCall.id,
              sourceToolName: stableToolCall.name,
            };
          },
        };
      };

      for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex += 1) {
        const tc = toolCalls[toolCallIndex];
        const preparedParallelExecution = parallelToolExecutions.get(tc.id) || null;
        // task-325a: honour abort between tools. We don't cancel tools already
        // running in a parallel segment; every provider call still commits a
        // paired result in provider order, but no not-yet-started call is
        // dispatched after the abort boundary.
        if (signal?.aborted) abortedDuringTools = true;

        if (!preparedParallelExecution && !toolBatchBarrier && !signal?.aborted
            && toolAllowedForRequest(tc) && isConcurrencySafeTool(this, tc.name, tc.input)
            && !mayMutateWorkspaceAfterReturn(this, tc.name, tc.input)) {
          const parallelCalls = [];
          const segmentCacheKeys = new Set();
          for (let candidateIndex = toolCallIndex;
            candidateIndex < toolCalls.length && parallelCalls.length < MAX_CONCURRENT_READ_ONLY_TOOLS;
            candidateIndex += 1) {
            const candidate = toolCalls[candidateIndex];
            if (!toolAllowedForRequest(candidate)
                || !isConcurrencySafeTool(this, candidate.name, candidate.input)
                || mayMutateWorkspaceAfterReturn(this, candidate.name, candidate.input)) break;
            const candidateKey = `${candidate.name}\u001f${argsHashOf(candidate.input)}`;
            const candidateCacheable = isCacheableTool(this, candidate.name, candidate.input);
            // Keep identical cacheable reads on the serial commit path so the
            // second call reuses the first result instead of duplicating I/O.
            if (candidateCacheable
                && (readOnlyToolResults.has(candidateKey) || segmentCacheKeys.has(candidateKey))) break;
            parallelCalls.push(candidate);
            if (candidateCacheable) segmentCacheKeys.add(candidateKey);
          }

          if (parallelCalls.length > 1) {
            const executions = [];
            for (const call of parallelCalls) {
              if (signal?.aborted) {
                abortedDuringTools = true;
                break;
              }
              announcedParallelToolCalls.add(call.id);
              yield {
                type: 'tool_start',
                id: call.id,
                name: call.name,
                input: call.input,
                threadId: this.currentThreadId,
              };
              if (signal?.aborted) {
                abortedDuringTools = true;
                break;
              }
              executions.push((async () => {
                const startedAt = Date.now();
                const callContext = toolContextForCall(call);
                const toolErrorOutput = this.#toolRegistry
                  ? this.#toolRegistry.get(call.name)?.errorOutput || null
                  : this.#tools.get(call.name)?.errorOutput || null;
                try {
                  const output = this.#toolRegistry
                    ? await this.#toolRegistry.execute(call.name, call.input, callContext)
                    : normalizeToolOutput(await this.#tools.get(call.name).execute(call.input, callContext));
                  return { call, startedAt, durationMs: Date.now() - startedAt, output, toolErrorOutput };
                } catch (error) {
                  return { call, startedAt, durationMs: Date.now() - startedAt, error, toolErrorOutput };
                }
              })());
            }
            const completed = await Promise.all(executions);
            for (const execution of completed) {
              parallelToolExecutions.set(execution.call.id, execution);
            }
          }
        }

        const readyParallelExecution = parallelToolExecutions.get(tc.id) || null;
        if (readyParallelExecution) announcedParallelToolCalls.delete(tc.id);
        const activeToolBatchBarrier = toolBatchBarrier;
        const abortSkipped = Boolean(signal?.aborted && !readyParallelExecution);
        if (abortSkipped) announcedParallelToolCalls.delete(tc.id);
        const skipped = abortSkipped
          || (activeToolBatchBarrier != null && !readyParallelExecution);
        const toolStartTime = readyParallelExecution?.startedAt || Date.now();

        // PR-L: duplicate-call detection. If this exact (toolName,
        // argsHash) pair has already been executed DUP_TOOL_THRESHOLD
        // (3) times within the current turn + last 2 turns, queue a
        // system reminder. We push the reminder AFTER the tool batch
        // completes (not now) so the
        // assistant(tool_use) → user(tool_result, …) pairing demanded
        // by the Anthropic / OpenAI Responses APIs stays intact. We
        // don't block the call — the LLM still decides.
        if (!skipped) {
          const dupHash = argsHashOf(tc.input);
          // PR-L follow-up: lookback is by user-conversation turn
          // (`queryNumber`), NOT by inner adapter loop iteration. Each call
          // to query() bumps queryNumber once, so "last 2 turns" means the
          // current user turn + the previous two user turns — the natural
          // semantic for "the model is stuck in a loop across the
          // conversation."
          const dupInfo = this.#execLog.dupInfo({
            toolName: tc.name,
            argsHash: dupHash,
            currentTurn: queryNumber,
            lookbackTurns: 2,
          });
          if (dupInfo.count + 1 >= DUP_TOOL_THRESHOLD) {
            pendingDupReminders.push(buildDuplicateReminder({
              toolName: tc.name,
              count: dupInfo.count + 1,
              lastResultBrief: dupInfo.lastResultBrief,
            }));
          }
        }

        let output;
        let displayImages = [];
        let isError = false;
        let reusedReadOnlyResult = false;
        let reusedReadOnlyCallId = null;
        let toolErrorOutput = null;
        let fatalToolError = null;
        let cacheableTool = false;
        let duplicateKey = null;
        currentToolCallForAsyncTask = skipped
          ? null
          : {
              id: tc.id,
              name: tc.name,
              threadId: runtimeThreadId,
            };

        // Resolve tool: prefer ToolRegistry, fallback to legacy #tools Map
        const hasTool = this.#toolRegistry
          ? this.#toolRegistry.isAllowed(tc.name, {
              collabToolPolicy: effectiveCollabToolPolicy,
              plugins: this.#config?.plugins,
              activeToolNames,
            })
          : this.#tools.has(tc.name);
        const toolProjectDocPathHints = projectDocPathHintsFromToolCall(tc.name, tc.input);
        const readOnlyTool = hasTool ? isReadOnlyTool(this, tc.name, tc.input) : false;
        const missingProjectDocScopes = hasTool && !readOnlyTool
          ? projectDocWriteScopesNeedingReload(projectDocContext, toolProjectDocPathHints)
          : new Set();
        const needsProjectDocReload = missingProjectDocScopes.size > 0;

        if (abortSkipped) {
          output = `Skipped ${tc.name} because the turn was aborted before this tool started.`;
          isError = true;
          yield {
            type: 'tool_end',
            id: tc.id,
            name: tc.name,
            output,
            isError: true,
            skipped: true,
            aborted: true,
            threadId: this.currentThreadId,
          };
        } else if (skipped) {
          const source = activeToolBatchBarrier.sourceToolName || 'a preceding tool';
          const sourceId = activeToolBatchBarrier.sourceToolCallId
            ? ` (${activeToolBatchBarrier.sourceToolCallId})`
            : '';
          output = [
            `Skipped ${tc.name} because ${source}${sourceId} invalidated the remaining tool batch.`,
            activeToolBatchBarrier.message || 'Review the preceding tool result before deciding whether to retry this call.',
            'This tool was not executed. Submit it again only after reviewing the preceding result.',
          ].join('\n');
          isError = true;
          yield {
            type: 'tool_end',
            id: tc.id,
            name: tc.name,
            output,
            isError: true,
            skipped: true,
            threadId: this.currentThreadId,
          };
        } else if (!hasTool) {
          const registered = this.#toolRegistry?.has(tc.name) || this.#tools.has(tc.name);
          output = registered
            ? `Error: tool "${tc.name}" is not active for this request`
            : `Error: unknown tool "${tc.name}"`;
          isError = true;
          yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true, threadId: this.currentThreadId };
        } else if (needsProjectDocReload) {
          projectDocLoadedPathHints = [...new Set([
            ...projectDocLoadedPathHints,
            ...toolProjectDocPathHints,
          ])];
          const previouslySelectedProjectDocScopes = new Set(projectDocContext.selectedScopes);
          projectDocContext = selectProjectDocContext(projectDocSource, {
            prompt,
            messages,
            pathHints: projectDocLoadedPathHints,
            language: this.#config.language || 'en',
            forcedScopes: [...previouslySelectedProjectDocScopes, ...missingProjectDocScopes],
          });
          const zh = String(this.#config?.language || '').toLowerCase().startsWith('zh');
          const notice = zh
            ? `项目规则已针对路径 ${toolProjectDocPathHints.join(', ')} 重新加载。先复核新载入的规则，再重新提交写操作；本次调用未执行。`
            : `Project rules were reloaded for ${toolProjectDocPathHints.join(', ')}. Review the newly loaded rules before resubmitting the write; this call was not executed.`;
          promptNotices = [notice];
          systemPrompt = buildCurrentSystemPrompt();
          output = notice;
          isError = true;
          toolBatchBarrier = {
            kind: 'project_rules_reloaded',
            message: notice,
            sourceToolCallId: tc.id,
            sourceToolName: tc.name,
          };
          yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true, skipped: true, threadId: this.currentThreadId };
        } else {
          duplicateKey = `${tc.name}\u001f${argsHashOf(tc.input)}`;
          cacheableTool = isCacheableTool(this, tc.name, tc.input);
          // The cache is only valid while the workspace has not changed. Clear
          // it before every potential mutation, including a tool that later
          // reports or throws an error after making a partial change. Detached
          // operations can still mutate after returning, so disable reuse for
          // the rest of this query instead of allowing stale entries to refill.
          if (!readOnlyTool) readOnlyToolResults.clear();
          const mayMutateAfterReturn = mayMutateWorkspaceAfterReturn(this, tc.name, tc.input);
          if (mayMutateAfterReturn) invalidateReadOnlyToolReuse();
          const cachedReadOnly = readOnlyToolResults.get(duplicateKey);
          if (!readOnlyToolReuseDisabled && cachedReadOnly && cacheableTool) {
            output = cachedReadOnly.output;
            isError = Boolean(cachedReadOnly.isError);
            reusedReadOnlyResult = true;
            reusedReadOnlyCallId = cachedReadOnly.callId || null;
            yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input, threadId: this.currentThreadId, reused: true };
            yield {
              type: 'tool_end',
              id: tc.id,
              name: tc.name,
              output,
              displayImages: [],
              isError: cachedReadOnly.isError,
              reused: true,
              threadId: this.currentThreadId,
            };
          } else try {
            if (readyParallelExecution) {
              parallelToolExecutions.delete(tc.id);
              toolErrorOutput = readyParallelExecution.toolErrorOutput || null;
              if (readyParallelExecution.error) throw readyParallelExecution.error;
              output = readyParallelExecution.output;
            } else {
              if (!announcedParallelToolCalls.delete(tc.id)) {
                yield { type: 'tool_start', id: tc.id, name: tc.name, input: tc.input, threadId: this.currentThreadId };
              }
              const callToolCtx = toolContextForCall(tc);
              if (this.#toolRegistry) {
                toolErrorOutput = this.#toolRegistry.get(tc.name)?.errorOutput || null;
                output = await this.#toolRegistry.execute(tc.name, tc.input, callToolCtx);
              } else {
                const tool = this.#tools.get(tc.name);
                toolErrorOutput = tool.errorOutput || null;
                // Pass the full toolCtx (cwd, workDir, signal, …) — not just
                // `{ signal }`. Legacy registerTool() callers historically got
                // a 1-field ctx, but that means tools like bash/file-read run
                // in the agent process cwd instead of the group's workDir.
                // Real production goes through #toolRegistry; the legacy path
                // is exercised by tests and a few standalone tools. Aligning
                // both paths keeps `ctx.cwd` semantics consistent.
                const rawOutput = await tool.execute(tc.input, callToolCtx);
                output = normalizeToolOutput(rawOutput);
              }
            }
            displayImages = extractDisplayImages(tc.name, output);
            if (displayImages.length > 0) {
              output = stripDisplayImageData(output, displayImages);
            }
            isError = toolErrorOutput === 'json-error-envelope' && isToolErrorOutput(output);
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, displayImages, isError, threadId: this.currentThreadId };
            if (displayImages.some(image => image.deliveryQueued === true)
                && lastPersistedAssistantMessage
                && typeof this.#conversationStore?.update === 'function') {
              const priorAnchor = displayImageAnchorMessage;
              if (priorAnchor && priorAnchor.id !== lastPersistedAssistantMessage.id) {
                const cleared = this.#conversationStore.update(priorAnchor, { imageAssetAnchor: false });
                if (cleared) {
                  const anchored = this.#conversationStore.update(lastPersistedAssistantMessage, {
                    imageAssetAnchor: true,
                  });
                  if (anchored) {
                    displayImageAnchorMessage = anchored;
                    lastPersistedAssistantMessage = anchored;
                  } else {
                    displayImageAnchorMessage = this.#conversationStore.update(priorAnchor, {
                      imageAssetAnchor: true,
                    }) || null;
                  }
                }
              } else if (!priorAnchor) {
                const anchored = this.#conversationStore.update(lastPersistedAssistantMessage, {
                  imageAssetAnchor: true,
                });
                if (anchored) {
                  displayImageAnchorMessage = anchored;
                  lastPersistedAssistantMessage = anchored;
                }
              }
            }
          } catch (err) {
            output = `Error: ${err.message}`;
            isError = true;
            yield { type: 'tool_end', id: tc.id, name: tc.name, output, isError: true, threadId: this.currentThreadId };
            if (err?.fatalToolTimeout === true) fatalToolError = err;
          }
        }

        currentToolCallForAsyncTask = null;

        const toolDurationMs = readyParallelExecution?.durationMs ?? (Date.now() - toolStartTime);

        // feat-6af5f9f1 PR B: emit a structured `tool_exec` event for the
        // debug panel. Keep raw output here; the model-facing tool
        // message below is deliberately truncated for context budget.
        yield {
          type: 'tool_exec',
          turnId: queryTurnId,
          threadId,
          loopNumber: turnNumber,
          callId: tc.id,
          name: tc.name,
          durationMs: toolDurationMs,
          isError,
          toolOutput: output,
          ...(reusedReadOnlyResult ? { reused: true, reusedCallId: reusedReadOnlyCallId } : {}),
          ...(skipped ? { skipped: true } : {}),
          ...(displayImages.length > 0 ? { displayImageCount: displayImages.length } : {}),
        };

        // 2026-05-13: feed the per-tool counters. Stays best-effort — a
        // stats sink that throws shouldn't crash the engine. `record`
        // already swallows internal write errors.
        if (!skipped && this.#toolStats && typeof this.#toolStats.record === 'function') {
          try {
            this.#toolStats.record({
              name: tc.name,
              durationMs: toolDurationMs,
              isError,
              errorMessage: isError && typeof output === 'string' ? output.slice(0, 500) : null,
            });
          } catch { /* swallow */ }
        }

        // Log tool to debug trace
        this.#trace.logTool(turnId, {
          toolName: tc.name,
          toolCallId: tc.id,
          toolInput: JSON.stringify(tc.input),
          toolOutput: output,
          durationMs: toolDurationMs,
          isError,
          skipped,
          reused: reusedReadOnlyResult,
          reusedCallId: reusedReadOnlyCallId,
        });

        if (!skipped && !reusedReadOnlyResult && tc.name === 'StartPlan') {
          planBootstrapPending = true;
        }
        if (!skipped && !reusedReadOnlyResult && !readOnlyToolReuseDisabled && cacheableTool) {
          readOnlyToolResults.set(duplicateKey, {
            output,
            isError,
            callId: tc.id,
          });
        }

        // Append only the bounded copy to the model message history. Raw
        // `output` is still used for debug traces, UI events, exec-log, and
        // persistence so large tool results are not lost outside context.
        const contextOutput = truncateToolResultIfNeeded(output, {
          toolName: tc.name,
          language: this.#config?.language,
        });
        const toolMessage = {
          role: 'tool',
          toolCallId: tc.id,
          content: contextOutput,
          isError,
        };
        conversationMessages.push(toolMessage);
        // Model context may use a bounded copy, but durable conversation
        // history keeps the raw normalized tool output for recovery/debug.
        const persistedToolMessage = this.#persistConversationMessage({ ...toolMessage, content: output }, {
          sessionId: runtimeSessionId,
          turnId: vpTurnId || queryTurnId,
          model: currentModel,
          executionOrigin,
        });
        if (persistedToolMessage) {
          toolMessage._persistedMessageId = persistedToolMessage.id;
          this.#persistedToolMessages.set(tc.id, persistedToolMessage);
        }

        // PR-L: persist this execution to the exec-log for fallback-stub
        // and duplicate-call detection. Best-effort — disk failures are
        // swallowed inside ExecLog.append.
        // PR-L follow-up: persist under `queryNumber` (one entry-key per
        // user-conversation turn), not the inner loop's turnNumber.
        // Aligns exec-log layout with dup detection lookback and the
        // T2 fallback-stub readTurn() call below.
        if (!skipped) {
          this.#execLog.append(queryNumber, buildExecLogEntry({
            loopIdx: queryToolCount,
            toolName: tc.name,
            args: tc.input,
            output,
            isError,
          }));
          queryToolCount += 1;
        }
        if (fatalToolError) throw fatalToolError;
      }

      // PR-L: flush any duplicate-call reminders queued during the batch.
      // Pushed AFTER the for-loop so the tool_use → tool_result pairing
      // is intact; the next adapter.stream() will see the reminder as a
      // user message immediately after the last tool result.
      for (const reminder of pendingDupReminders) {
        conversationMessages.push({ role: 'user', content: reminder });
      }

      // A plan bootstrap that produced only a TodoWrite has no executable work
      // to feed back to the provider. Close it here. This is intentionally
      // narrow: StartPlan + TodoWrite is a valid planning result, but a batch
      // containing any other tool must continue so the model can inspect its
      // result before deciding what to do next.
      const onlyPlanControls = planBootstrapPending
        && toolCalls.length > 0
        && toolCalls.every(call => call.name === 'StartPlan' || call.name === 'TodoWrite')
        && toolCalls.some(call => call.name === 'TodoWrite')
        && !toolBatchBarrier
        && !endTurnRequested
        && !abortedDuringTools
        && !signal?.aborted;
      if (onlyPlanControls) {
        const hasPendingStep = toolCalls
          .filter(call => call.name === 'TodoWrite')
          .some(call => Array.isArray(call.input?.todos)
            && call.input.todos.some(todo => todo?.status === 'pending' || todo?.status === 'in_progress'));
        yield {
          type: 'turn_end',
          turnNumber,
          stopReason: 'plan_recorded',
          detail: { nextStep: hasPendingStep ? 'pending_work_tools' : 'none', toolCount: toolCalls.length },
          threadId,
          terminal: true,
        };
        break;
      }
      planBootstrapPending = false;

      // A batch barrier deliberately returns control to the provider. Any
      // handoff requested by an earlier call belongs to the invalidated plan
      // and must not leak into a later provider-generated batch.
      if (toolBatchBarrier) endTurnRequested = null;

      // task-707: tool-callable end-turn signal. If a tool in this batch
      // called toolCtx.requestEndTurn(reason), break out of the outer
      // while-loop now — DON'T call adapter.stream() again. The
      // assistant(tool_use)+tool(tool_result) pairs are already in
      // conversationMessages, so the next user-initiated turn sees a
      // clean wire shape. Used by `route_forward` to hand off control
      // to other VPs without continuing to generate.
      //
      // Order matters: this runs BEFORE T1 reflection (which would
      // collapse the arc into a summary that's only valuable across
      // multi-iteration tool loops) and BEFORE the abortedDuringTools
      // check (so a clean handoff doesn't get reported as 'aborted').
      if (endTurnRequested && !toolBatchBarrier) {
        if (pendingSubAgentNotifs.length > 0) {
          acknowledgePendingNotifications(notifScope, pendingSubAgentNotifs.map(n => n.id));
        }
        const handoffDetail = typeof endTurnRequested === 'object'
          ? endTurnRequested
          : { kind: 'tool_handoff', reason: String(endTurnRequested) };
        yield {
          type: 'turn_end',
          turnNumber,
          stopReason: 'tool_handoff',
          detail: handoffDetail,
          threadId,
          terminal: true,
        };
        break;
      }

      // PR-L: T1 in-turn (synchronous) reflection. Fires once per
      // adapter loop iteration where ≥ TOOL_BATCH_SIZE (30) tool
      // calls have accumulated since the last T1 firing — not just
      // the first batch of the query(). Generates a markdown reflection
      // over the assistant+tool arc since the last T1 firing (or
      // since the user prompt for the first batch) and rewrites that
      // range to a SINGLE synthetic user message before the next
      // adapter.stream() runs.
      //
      // Loop semantics:
      //   - First batch: arcStartIdx = turnStartIdx + 1, fires when
      //     queryToolCount reaches TOOL_BATCH_SIZE.
      //   - Each subsequent batch: arcStartIdx is updated to the slot
      //     right after the just-inserted reflection message; fires
      //     again whenever TOOL_BATCH_SIZE more tools have run since
      //     lastT1AtToolCount.
      //   - The dedup Set key includes `lastT1AtToolCount` so each
      //     batch within the same query gets a distinct entry — without
      //     this the second batch would be silently skipped.
      const t1BatchDue = queryToolCount - lastT1AtToolCount >= TOOL_BATCH_SIZE;
      if (groupReflectionAllowed && t1BatchDue && !toolBatchBarrier
          && !abortedDuringTools && !signal?.aborted) {
        const t1DedupKey = `${queryNumber}:t1:${queryToolCount}`;
        if (this.#reflectedTurns.has(t1DedupKey)) {
          // Defensive: should never hit since t1BatchDue gates re-entry
          // and queryNumber namespaces queries. Kept as belt-and-
          // suspenders against any future external mutation of the
          // cursor (or a re-entrant query() that this code doesn't
          // anticipate).
        } else {
          this.#reflectedTurns.add(t1DedupKey);
        const batchStart = arcStartIdx;
        const batchEnd = conversationMessages.length - 1;
        try {
          const { pairs, assistantText } = extractToolPairsFromRange(
            conversationMessages, batchStart, batchEnd,
          );
          yield {
            type: 'reflection',
            turnId: queryTurnId,
            threadId,
            loopNumber: turnNumber,
            trigger: 't1',
            status: 'pending',
            loopRange: [batchStart, batchEnd],
            toolCount: pairs.length,
          };
          const { content, durationMs } = await runT1Reflection({
            adapter: this.#adapter,
            model: this.#config.model,
            originalUserMsg: prompt,
            toolPairs: pairs,
            assistantText,
            language: this.#config.language,
            signal,
          });
          const next = collapseRangeToReflection(
            conversationMessages, batchStart, batchEnd, content,
          );
          const reflectionMessage = next[batchStart];
          const durableRowsInRange = conversationMessages
            .slice(batchStart, batchEnd + 1)
            .some(message => message?._persistedMessageId || message?.id);
          const persistedReflection = this.#persistFoldedRange(
            conversationMessages,
            batchStart,
            batchEnd,
            reflectionMessage,
            { sessionId: runtimeSessionId, model: currentModel, executionOrigin },
          );
          if (durableRowsInRange && !persistedReflection) {
            throw new Error('T1 reflection could not publish its durable range replacement');
          }
          // Raw tool rows inside the replacement range are now tombstoned in
          // durable history. Late async completions must follow the folded
          // continuation path rather than appending to those stale rows.
          const foldedToolCallIds = conversationMessages
            .slice(batchStart, batchEnd + 1)
            .filter(message => message?.role === 'tool' && message.toolCallId)
            .map(message => message.toolCallId);
          for (const toolCallId of foldedToolCallIds) {
            this.#persistedToolMessages.delete(toolCallId);
          }
          conversationMessages.length = 0;
          for (const m of next) conversationMessages.push(m);
          // After collapse: the just-inserted reflection lives at
          // index `batchStart`. The next tool arc therefore starts
          // immediately after it, i.e. at conversationMessages.length
          // (the next assistant message will land here).
          arcStartIdx = conversationMessages.length;
          lastT1AtToolCount = queryToolCount;
          // Bump the success counter — used by the T2 schedule check
          // to decide whether T2 still has work to do at end_turn.
          // Distinct from lastT1AtToolCount which the catch block
          // also bumps (but without rewriting history).
          t1CollapsesDone += 1;
          yield {
            type: 'reflection',
            turnId: queryTurnId,
            threadId,
            loopNumber: turnNumber,
            trigger: 't1',
            // PR-L bug fix: keep the same loopRange as the `pending` event
            // so the frontend key stays stable across pending → ready and
            // the spinner card is replaced in place (no orphan).
            status: 'ready',
            loopRange: [batchStart, batchEnd],
            toolCount: pairs.length,
            content,
            durationMs,
          };
        } catch (err) {
          // Best-effort. On failure leave history unchanged so the loop
          // continues normally — never block the turn.
          yield {
            type: 'reflection',
            turnId: queryTurnId,
            threadId,
            loopNumber: turnNumber,
            trigger: 't1',
            status: 'error',
            error: err && err.message || String(err),
          };
          // Advance lastT1AtToolCount past this batch so we don't
          // tight-loop on a hiccuping reflector. The next attempt is
          // TOOL_BATCH_SIZE tools from now, not immediately. arcStartIdx is
          // left alone because history wasn't rewritten — the tail still
          // begins where it did. The trade-off: the next batch's
          // reflection will cover the tools that just failed too,
          // which is fine (they're still in conversationMessages).
          //
          // We do NOT bump t1CollapsesDone — see the variable's
          // declaration comment. This keeps the T2 fallback path live
          // when every T1 attempt has errored.
          lastT1AtToolCount = queryToolCount;
        }
        }
      }

      // task-325a: if abort fired between tools, converge now — emit
      // the typed `aborted` event + a final turn_end with stopReason
      // 'aborted' instead of looping back to a new adapter call.
      if (abortedDuringTools || signal?.aborted) {
        yield { type: 'aborted', reason: this.#abortReason || 'external', turnNumber, threadId };
        yield { type: 'turn_end', turnNumber, stopReason: 'aborted', threadId, terminal: true };
        break;
      }

      yield { type: 'turn_end', turnNumber, stopReason: 'tool_use', threadId };

      // task-327b: count this as a tool-loop turn. Next iteration's
      // pickEffort() will see the bumped counter and upgrade to 'max'
      // once LONG_LOOP_TURN_THRESHOLD is reached.
      toolLoopTurns++;

      // Loop back to call adapter again with tool results
    }

    // feat-6af5f9f1 PR B: turn closed. Emits final totals so the debug
    // panel can show "Turn done · 4 loops · 12.4s · 5.0k tok" without
    // having to reduce the loops itself. Always fires (every break path
    // above falls through here).
    yield {
      type: 'turn_close',
      turnId: queryTurnId,
      threadId,
      totalMs: Date.now() - queryStartedAt,
      totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
      loopCount: turnNumber,
    };
  }

  /**
   * Get the trace ID for this engine instance.
   * @returns {string}
   */
  get traceId() {
    return this.#traceId;
  }

  /**
   * Get registered tool names.
   * @returns {string[]}
   */
  get toolNames() {
    if (this.#toolRegistry) return this.#toolRegistry.names;
    return Array.from(this.#tools.keys());
  }

  /**
   * Get the conversation store (for external access, e.g., CLI commands).
   * @returns {import('./conversation/persist.js').ConversationStore|null}
   */
  get conversationStore() {
    return this.#conversationStore;
  }

  /** @returns {import('./tools/registry.js').ToolRegistry|null} */
  get toolRegistry() { return this.#toolRegistry; }

  /**
   * Return a registered tool definition for internal loop policy checks.
   * This keeps the duplicate-result fast path on the same registry metadata
   * used by normal execution, without exposing the private maps.
   */
  getToolDefinition(name) {
    if (this.#toolRegistry) return this.#toolRegistry.get(name);
    return this.#tools.get(name) || null;
  }

  /** @returns {import('./skills.js').SkillManager|null} */
  get skillManager() { return this.#skillManager; }

  /** @returns {import('./mcp.js').MCPManager|null} */
  get mcpManager() { return this.#mcpManager; }

  /**
   * PR-L — V7 Tool History Reflection helpers.
   *
   * `#applyPendingT2Reflections` is called at the start of every
   * `#runQuery` to carry forward any prior turn's async reflection. It is
   * a generator so it can yield reflection events to the engine consumer.
   * Non-blocking: never awaits a pending promise.
   *
   * @param {Array} conversationMessages
   * @param {string} originalUserMsg
   * @param {{sessionId?: string, model?: string}} context
   */
  async *#applyPendingT2Reflections(conversationMessages, originalUserMsg, context = {}) {
    if (this.#pendingT2.size === 0) return;
    // Drain in insertion order (Map preserves it). We process all entries
    // because the user could send multiple prompts back-to-back before
    // the engine resumes — each historical turn gets its rewrite.
    const drained = [...this.#pendingT2.entries()];
    this.#pendingT2.clear();

    for (const [turnNumber, info] of drained) {
      const range = info.loopRange;
      if (!Array.isArray(range) || range.length !== 2) continue;
      const [startIdx, endIdx] = range;
      if (startIdx < 0 || endIdx < startIdx || endIdx >= conversationMessages.length) {
        continue;
      }

      // PR-L follow-up: deterministic readiness check. The info record
      // carries `ready / result / error` flags that are flipped from the
      // promise's then/catch handler; reading them here is purely
      // synchronous bookkeeping — no microtask race.
      let content;
      let trigger;
      let durationMs = 0;
      if (!info.ready) {
        // Still in flight — fall back to the exec-log stub. Detach the
        // unresolved promise so we don't leak it (handlers above already
        // swallow rejection by routing into info.error).
        const entries = this.#execLog ? this.#execLog.readTurn(turnNumber) : [];
        content = buildFallbackStub({ execLogEntries: entries, originalUserMsg: info.originalUserMsg || originalUserMsg });
        trigger = 't2-fallback';
      } else if (info.error) {
        // Promise rejected — leave history unchanged, no event.
        continue;
      } else if (info.result && typeof info.result.content === 'string' && info.result.content) {
        content = info.result.content;
        trigger = 't2';
        durationMs = info.result.durationMs || 0;
      } else {
        // Resolved but with no usable content — defensively skip.
        continue;
      }

      // Rewrite history and publish the same logical replacement to disk.
      const next = collapseRangeToReflection(conversationMessages, startIdx, endIdx, content);
      const reflectionMessage = next[startIdx];
      const durableRowsInRange = conversationMessages
        .slice(startIdx, endIdx + 1)
        .some(message => message?._persistedMessageId || message?.id);
      const persistedReflection = this.#persistFoldedRange(
        conversationMessages,
        startIdx,
        endIdx,
        reflectionMessage,
        {
          ...context,
          causalRootId: info.causalRootId || null,
          executionOrigin: info.executionOrigin === 'route_forward' ? 'route_forward' : null,
        },
      );
      if (durableRowsInRange && !persistedReflection) continue;
      // T2 replaces this arc in durable and in-memory history just like T1.
      // Forget its raw result handles before a late async task can append to a
      // tombstoned tool row at the next provider boundary.
      const foldedToolCallIds = conversationMessages
        .slice(startIdx, endIdx + 1)
        .filter(message => message?.role === 'tool' && message.toolCallId)
        .map(message => message.toolCallId);
      for (const toolCallId of foldedToolCallIds) {
        this.#persistedToolMessages.delete(toolCallId);
      }
      // Mutate in place so caller's reference stays valid.
      conversationMessages.length = 0;
      for (const m of next) conversationMessages.push(m);

      yield {
        type: 'reflection',
        turnId: info.originatingTurnId || null,
        trigger,
        status: 'ready',
        loopRange: [startIdx, endIdx],
        toolCount: info.count || 0,
        content,
        durationMs,
      };
    }
  }

  /**
   * PR-L — read-only accessor for tests.
   */
  get _execLog() { return this.#execLog; }

  /**
   * task-299 Phase 1: the engine's current thread marker.
   * Defaults to 'main' if the thread store is unreachable for any reason.
   * @returns {string}
   */
  get currentThreadId() {
    return this.#currentThreadId || MAIN_THREAD_ID;
  }

  /** Stable owner scope for external exactly-once task coordinators. */
  get sessionId() { return this.#sessionId; }

  /** Stable owner scope for external exactly-once task coordinators. */
  get vpId() { return this.#vpId; }

  /**
   * Append a user message into the currently running query. The loop consumes
   * it only at adapter boundaries, never mid-token and never between an
   * assistant tool_use and its paired tool_result messages.
   * @param {string|Array} content
   * @returns {boolean}
   */
  appendUserMessage(content) {
    if (typeof content !== 'string' && !Array.isArray(content)) return false;
    if (typeof content === 'string' && !content.trim()) return false;
    const preview = typeof content === 'string' ? content : '[content blocks]';
    this.#pendingUserMessages.push({ content, preview });
    // Wake the async-task wait loop too. A user typing while the engine
    // is parked on a background task should release the loop immediately
    // so the user's words get spliced into the next iteration.
    this.#wakeAsyncTaskWaiters();
    return true;
  }

  /**
   * Wake a query whose external pending-message hook has received input.
   * The bridge keeps the full message (attachments and provenance included)
   * in its thread queue; this method only releases an async-task wait so the
   * normal drain callback can consume it at the next safe adapter boundary.
   * @returns {boolean}
   */
  wakeForPendingUserMessage() {
    if (!this.isRunning) return false;
    this.#externalUserWakePending = true;
    this.#wakeAsyncTaskWaiters();
    return true;
  }

  /**
   * Install the coordinator that lets an external dispatcher (web-bridge)
   * route a background task's terminal event back to THIS engine while
   * its query() is still running. Pass `null` to detach.
   * @param {{ onRegister?: (taskId:string, engine:Engine) => void, onUnregister?: (taskId:string, engine:Engine) => void, onConsumed?: (taskId:string, engine:Engine) => void, onUndelivered?: (taskId:string, delivery:object, engine:Engine) => void } | null} coord
   */
  setAsyncTaskCoordinator(coord) {
    this.#asyncTaskCoordinator = (coord && typeof coord === 'object') ? coord : null;
  }

  /**
   * Close same-turn task delivery for this Engine. Accepted-but-undrained
   * results are handed to the coordinator for exactly-once rescue; tasks that
   * have not completed are merely unregistered so a future terminal event
   * falls through to the bridge rescue path.
   *
   * @param {string} [reason]
   * @param {{ rescue?: boolean }} [opts]
   * @returns {number} number of accepted results released or discarded
   */
  retireAsyncTasks(reason = 'engine_retired', { rescue = true } = {}) {
    this.#asyncTaskDeliveryClosed = true;
    const released = rescue
      ? this.#releaseUndeliveredAsyncTaskResults(reason)
      : (() => {
        const dropped = this.#acceptedAsyncTaskResults.size;
        this.#acceptedAsyncTaskResults.clear();
        this.#pendingAsyncTaskConfirmIds.clear();
        return dropped;
      })();
    if (this.#pendingAsyncTaskIds.size > 0) {
      const pending = Array.from(this.#pendingAsyncTaskIds);
      this.#pendingAsyncTaskIds.clear();
      for (const taskId of pending) {
        this.#asyncTaskToolMeta.delete(taskId);
        try { this.#asyncTaskCoordinator?.onUnregister?.(taskId, this); } catch { /* best-effort */ }
      }
    }
    this.#wakeAsyncTaskWaiters();
    return released;
  }

  /**
   * True iff the currently-running query is holding pending async tasks.
   * Used by external probes (web-bridge fallback dispatcher) to decide
   * whether a task terminal event should be injected into the same turn
   * or fall back to the legacy "open a new turn" rescue path.
   * @returns {boolean}
   */
  hasPendingAsyncTasks() {
    return this.#pendingAsyncTaskIds.size > 0;
  }

  /**
   * True iff THIS engine has registered the given taskId as belonging to
   * the currently-running query. Web-bridge calls this before
   * `notifyAsyncTaskCompleted` so a terminal event for a task that wasn't
   * launched from this turn (or whose engine already finished) falls
   * through to the legacy rescue path.
   * @param {string} taskId
   * @returns {boolean}
   */
  ownsPendingAsyncTask(taskId) {
    return typeof taskId === 'string' && this.#pendingAsyncTaskIds.has(taskId);
  }

  /**
   * Deliver a terminal task event into the currently-running query. Drops
   * the task from the pending set, queues a synthetic user message with
   * the rendered task result, and wakes the wait loop. Returns true iff
   * the engine accepted ownership (the bridge should NOT fall back to the
   * legacy rescue path). Returns false when the engine was never holding
   * this taskId — caller should fall through to its rescue path.
   *
   * @param {string} taskId
   * @param {string|Array} content — pre-formatted task result body
   * @param {{ preview?: string, sessionId?: string, vpId?: string, threadId?: string, taskKind?: string, taskStatus?: string, turnId?: string }} [opts]
   * @returns {boolean}
   */
  notifyAsyncTaskCompleted(taskId, content, opts = {}) {
    if (!this.ownsPendingAsyncTask(taskId)) return false;
    if (this.#asyncTaskDeliveryClosed || !this.#currentAbortCtrl || this.#currentAbortCtrl.signal.aborted) return false;
    if (typeof content !== 'string' && !Array.isArray(content)) return false;
    if (typeof content === 'string' && !content.trim()) return false;
    // Defensive: an empty content-block array would splice as a wire-valid
    // but semantically empty user message, which the adapter would happily
    // forward and bill for. Production callers (formatTaskResultForVp)
    // always emit a non-empty string today; this guards future refactors.
    if (Array.isArray(content) && content.length === 0) return false;
    // This is the actual workspace-synchronization boundary. The next
    // provider stream may already be yielding tool calls, so waiting until a
    // later queue drain leaves one stale-cache reuse window open.
    const activeReadOnlyReuse = this.#activeReadOnlyToolReuse;
    if (activeReadOnlyReuse?.owner === this.#currentAbortCtrl) {
      activeReadOnlyReuse.invalidate();
    }
    this.#pendingAsyncTaskIds.delete(taskId);
    const preview = typeof opts.preview === 'string'
      ? opts.preview
      : (typeof content === 'string' ? content.slice(0, 200) : '[task result]');
    const meta = this.#asyncTaskToolMeta.get(taskId) || {};
    // A completion that lands while its original tool arc is still present
    // can update that tool result in-place. Once T1/T2 folded the arc, the
    // provider must receive only a continuation note; otherwise we recreate
    // a raw tool row after the reflection and invalidate the fold.
    const hasLiveToolRow = typeof meta.toolCallId === 'string'
      && meta.toolCallId
      && Boolean(this.#persistedToolMessages.get(meta.toolCallId));
    const delivery = {
      content,
      preview,
      sessionId: opts.sessionId || meta.sessionId || this.#sessionId || null,
      vpId: opts.vpId || meta.vpId || this.#vpId || null,
      threadId: opts.threadId || meta.threadId,
      taskKind: opts.taskKind,
      taskStatus: opts.taskStatus,
      turnId: opts.turnId || meta.turnId || null,
    };
    this.#acceptedAsyncTaskResults.set(taskId, delivery);
    this.#asyncTaskToolMeta.delete(taskId);
    if (typeof meta.toolCallId === 'string' && meta.toolCallId) {
      this.#pendingTaskResultUpdates.push({
        taskId,
        toolCallId: meta.toolCallId,
        toolName: meta.toolName,
        content,
        preview,
        sessionId: delivery.sessionId,
        vpId: delivery.vpId,
        turnId: delivery.turnId,
        // #persistedToolMessages is cleared as soon as folding publishes its
        // durable reflection. Capture that boundary at completion time so a
        // later drain cannot infer stale liveness from an unrelated row.
        folded: !hasLiveToolRow,
      });
    } else {
      this.#pendingTaskResultMessages.push({
        content,
        preview,
        internal: true,
        taskId,
      });
    }
    this.#wakeAsyncTaskWaiters();
    return true;
  }

  /**
   * Register a result-producing async task as belonging to the current query.
   * Called by tools such as SpawnAgent via `toolCtx.registerAsyncTask`.
   * @param {string} taskId
   * @param {{ id?: string, name?: string, threadId?: string, toolCallId?: string, toolName?: string, sessionId?: string, vpId?: string, turnId?: string }} [meta]
   * @returns {void}
   */
  #registerAsyncTask(taskId, meta = {}) {
    if (typeof taskId !== 'string' || !taskId) return;
    this.#pendingAsyncTaskIds.add(taskId);
    const toolCallId = typeof meta.toolCallId === 'string' && meta.toolCallId
      ? meta.toolCallId
      : (typeof meta.id === 'string' && meta.id ? meta.id : null);
    if (toolCallId) {
      this.#asyncTaskToolMeta.set(taskId, {
        toolCallId,
        toolName: typeof meta.toolName === 'string' && meta.toolName ? meta.toolName : (typeof meta.name === 'string' ? meta.name : undefined),
        threadId: typeof meta.threadId === 'string' && meta.threadId ? meta.threadId : undefined,
        sessionId: typeof meta.sessionId === 'string' && meta.sessionId
          ? meta.sessionId
          : (this.#sessionId || null),
        vpId: typeof meta.vpId === 'string' && meta.vpId ? meta.vpId : (this.#vpId || null),
        // query() exposes the wire turn id while the task is registered.
        // Persist it with a late completion even after T1/T2 removed the
        // original tool row from the in-memory arc.
        turnId: typeof meta.turnId === 'string' && meta.turnId
          ? meta.turnId
          : (this.#currentQueryTurnId || null),
      });
    }
    try { this.#asyncTaskCoordinator?.onRegister?.(taskId, this); } catch { /* coord must not throw into tools */ }
  }

  #asyncTaskWaitTimeoutMs() {
    const configured = Number(this.#config?.asyncTaskWaitTimeoutMs);
    if (!Number.isFinite(configured)) return DEFAULT_ASYNC_TASK_WAIT_TIMEOUT_MS;
    return Math.max(1, Math.min(60 * 60_000, Math.floor(configured)));
  }

  #asyncTaskLastActivityAt(taskId) {
    if (!this.#taskManager || typeof this.#taskManager.getTask !== 'function') return null;
    const sessionId = this.#sessionId || 'default';
    let task = null;
    try { task = this.#taskManager.getTask(sessionId, taskId); } catch { return null; }
    if (!task || task.status !== 'running') return 0;
    const updatedAt = Date.parse(task.updatedAt || task.startedAt || task.createdAt || '');
    return Number.isFinite(updatedAt) ? updatedAt : 0;
  }

  #nextAsyncTaskWaitMs(timeoutMs) {
    const now = Date.now();
    let next = timeoutMs;
    for (const taskId of this.#pendingAsyncTaskIds) {
      const lastActivityAt = this.#asyncTaskLastActivityAt(taskId);
      if (lastActivityAt === null) continue;
      next = Math.min(next, Math.max(1, lastActivityAt + timeoutMs - now));
    }
    return Math.max(1, next);
  }

  /**
   * Release stale same-turn ownership without stopping the underlying tasks.
   * Active sub-agents refresh TaskManager.updatedAt from their event stream, so
   * the timeout measures silence rather than total runtime. A later terminal
   * event misses the owner map and uses the bridge rescue path.
   * @param {number} timeoutMs
   * @returns {string[]}
   */
  #deferExpiredAsyncTasks(timeoutMs) {
    if (this.#pendingAsyncTaskIds.size === 0) return [];
    const now = Date.now();
    const taskIds = Array.from(this.#pendingAsyncTaskIds).filter((taskId) => {
      const lastActivityAt = this.#asyncTaskLastActivityAt(taskId);
      return lastActivityAt === null || now - lastActivityAt >= timeoutMs;
    });
    for (const taskId of taskIds) {
      // Keep ownership visible while the coordinator decides whether this is a
      // real defer. If a terminal event already won and removed the task, the
      // coordinator can reject a stale timeout callback instead of scheduling
      // a duplicate rescue.
      try {
        if (typeof this.#asyncTaskCoordinator?.onDeferred === 'function') {
          this.#asyncTaskCoordinator.onDeferred(taskId, this);
        } else {
          this.#asyncTaskCoordinator?.onUnregister?.(taskId, this);
        }
      } catch { /* best-effort */ }
      this.#pendingAsyncTaskIds.delete(taskId);
      this.#asyncTaskToolMeta.delete(taskId);
    }
    if (taskIds.length > 0) {
      console.warn(`[Engine] async task wait silent for ${timeoutMs}ms; deferring ${taskIds.join(', ')}`);
    }
    return taskIds;
  }

  #wakeAsyncTaskWaiters() {
    if (this.#asyncTaskWaiters.length === 0) return;
    const waiters = this.#asyncTaskWaiters.splice(0);
    for (const resolve of waiters) {
      try { resolve(); } catch { /* never break the loop on a stray callback */ }
    }
  }

  /**
   * Wait for *any* of: an async task terminal event, a fresh user append,
   * signal abort, or the current silence budget. The loop re-evaluates all
   * queues and task activity on every wake.
   * @param {AbortSignal|null|undefined} signal
   * @param {number} timeoutMs
   * @returns {Promise<'wake'|'timeout'>}
   */
  #waitForAsyncWake(signal, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let onAbort = null;
      // Fast paths — anything already pending releases instantly. This is
      // the common case when a task finished between adapter loops.
      if (this.#pendingTaskResultMessages.length > 0) return resolve('wake');
      if (this.#pendingTaskResultUpdates.length > 0) return resolve('wake');
      if (this.#pendingUserMessages.length > 0) return resolve('wake');
      if (this.#externalUserWakePending) return resolve('wake');
      if (signal?.aborted) return resolve('wake');
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal && onAbort) {
          try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        }
        const idx = this.#asyncTaskWaiters.indexOf(wake);
        if (idx >= 0) this.#asyncTaskWaiters.splice(idx, 1);
        resolve(reason);
      };
      const wake = () => finish('wake');
      this.#asyncTaskWaiters.push(wake);
      timer = setTimeout(() => finish('timeout'), Math.max(1, Number(timeoutMs) || 1));
      timer.unref?.();
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = () => {
          try { finish('wake'); } catch { /* ignore */ }
        };
        try { signal.addEventListener('abort', onAbort, { once: true }); } catch { /* old runtimes */ }
      }
    });
  }

  /** @returns {string|null} */
  get yeaftDir() { return this.#yeaftDir; }

}

function selectExactSessionScope(selected, sessionId) {
  if (!sessionId) return '';
  for (const scope of selected || []) {
    if (['sessions', 'session', 'group'].some(prefix => scope === `${prefix}/${sessionId}`)) {
      return scope;
    }
  }
  return '';
}

function selectExactVpScope(selected, sessionId, vpId) {
  if (!sessionId || !vpId) return '';
  for (const scope of selected || []) {
    if (['sessions', 'session', 'group'].some(prefix => scope === `${prefix}/${sessionId}/vp/${vpId}`)) {
      return scope;
    }
  }
  return '';
}

async function readCanonicalScope(scope, opts) {
  const value = String(scope || '');
  if (isVpForeign(value, opts?.currentVpId)) return '';
  const scopeObject = memoryScopeObject(value);
  if (!scopeObject || !opts?.root) return '';
  let content = await fsp.readFile(join(opts.root, value, 'content.md'), 'utf8').catch(() => '');
  // Current Session topic redirects intentionally have no content.md at the
  // old path. Let the store resolve that redirect, but never cross-fallback
  // between `group/`, `session/`, and `sessions/` aliases.
  if (!content && scopeObject.kind === 'session-topic' && value.startsWith('sessions/')) {
    content = await readScopeContent(scopeObject, opts).catch(() => '');
  }
  return truncateMemoryContent(content, MAX_MEMORY_ITEM_TOKENS);
}

function memoryScopeObject(scope) {
  if (scope === 'user') return { kind: 'user' };
  let match = /^(sessions|session|group)\/([^/]+)$/.exec(scope);
  if (match) return match[1] === 'group'
    ? { kind: 'group', id: match[2] }
    : { kind: 'session', id: match[2] };
  match = /^(sessions|session|group)\/([^/]+)\/vp\/([^/]+)$/.exec(scope);
  if (match) return match[1] === 'group'
    ? { kind: 'group-vp', sessionId: match[2], id: match[3] }
    : { kind: 'session-vp', sessionId: match[2], id: match[3] };
  match = /^(sessions|session|group)\/([^/]+)\/topic\/(.+)$/.exec(scope);
  if (match) {
    const path = match[3].split('/').filter(Boolean);
    if (path.length === 0 || path.length > 2) return null;
    return match[1] === 'group'
      ? { kind: 'group-topic', sessionId: match[2], path }
      : { kind: 'session-topic', sessionId: match[2], path };
  }
  return null;
}

async function readTopicSummary(scope, opts) {
  const content = await readCanonicalScope(scope, opts);
  return content ? { scope, summary: content } : null;
}

function truncateMemoryContent(content, maxTokens) {
  const text = cleanMemoryPromptText(content);
  if (!text || approxTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (approxTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  const cut = text.slice(0, lo);
  const boundary = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n- '));
  const body = (boundary > lo * 0.6 ? cut.slice(0, boundary) : cut).trimEnd();
  return `${body}\n\n[Additional canonical topic content omitted by prompt budget.]`;
}

async function collectTopicLabels(dir, prefix, labels) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  const hasContent = entries.some(entry => entry.isFile() && entry.name === 'content.md');
  const hasMemory = entries.some(entry => entry.isFile() && entry.name === 'memory.md');
  const hasSummary = entries.some(entry => entry.isFile() && entry.name === 'summary.md');
  if (prefix && (hasContent || hasMemory || hasSummary)) labels.push(prefix);
  const dirs = entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
  for (const name of dirs) {
    const nextPrefix = prefix ? `${prefix}/${name}` : name;
    await collectTopicLabels(join(dir, name), nextPrefix, labels);
  }
}
