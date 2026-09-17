import { createHash, randomUUID } from 'node:crypto';
import { resolveMaxOutputTokens } from '../models.js';
import { callCoordinatorWithResourceControl } from './resource-control.js';
import { normalizeSessionMessageQuote, sessionMessageQuotePrompt } from '../session-message-quote.js';
import {
  LLMAuthError,
  LLMContextError,
  LLMRateLimitError,
  LLMServerError,
} from '../llm/adapter.js';
import { resolveWorkItemModel, selectWorkItemVp } from './assignment.js';
import { assertCoordinatorContractAuthority, normalizeContractPatch } from './completion-contract.js';
import { normalizeOutputs } from './evidence.js';
import { deriveGoalProgress } from './goal-state.js';
import {
  normalizeDynamicActionClosures,
  prepareDynamicActionMutation,
} from './dynamic-coordination.js';
import { isDynamicWorkItem } from './execution-mode.js';
import { applyCoordinatorReplan } from './plan-mutation.js';
import { buildWorkItemAttachmentContext } from './attachments.js';
import { sanitizeDiagnosticText } from './debug-projection.js';
import {
  DEFAULT_WORK_CENTER_MODEL_TAGS,
  generatedActionGraphRules,
} from './workflow.js';
import { workItemCapabilityContext } from './capabilities.js';

const COORDINATOR_MAX_REPLY_CHARS = 8_000;
const COORDINATOR_MAX_INSTRUCTION_CHARS = 8_000;
const COORDINATOR_MAX_OUTPUT_TOKENS = 8_192;
const COORDINATOR_MAX_SNAPSHOT_BYTES = 64 * 1024;
const COORDINATOR_MAX_QUOTE_BYTES = 8 * 1024;
const COORDINATOR_DECISION_ATTEMPTS = 2;
const COORDINATOR_RECOVERY_DECISION_ATTEMPTS = 2;
const COORDINATOR_MAX_CONVERSATION_MESSAGES = 20;
const COORDINATOR_MAX_ACTIONS = 64;
const COORDINATOR_MAX_WORK_ITEM_BYTES = 14 * 1024;
const COORDINATOR_MAX_ACTIONS_BYTES = 34 * 1024;
const COORDINATOR_MAX_CONVERSATION_BYTES = 10 * 1024;
const COORDINATOR_MAX_STAGE_ID_BYTES = 256;

function coordinatorLanguage(value) {
  return String(value || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function coordinatorTemporaryError(language) {
  return coordinatorLanguage(language) === 'zh'
    ? 'Work Center Coordinator 暂时不可用；系统会自动重试恢复'
    : 'Work Center Coordinator is temporarily unavailable; automatic recovery will retry';
}

function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function coordinatorQuotePrompt(quote) {
  return sessionMessageQuotePrompt(quote, { maxBytes: COORDINATOR_MAX_QUOTE_BYTES });
}

function boundedJsonArray(values, maxBytes, options = {}) {
  const source = Array.isArray(values) ? values : [];
  const selected = [];
  const indexes = options.newestFirst
    ? [...source.keys()].reverse()
    : [...source.keys()];
  for (const index of indexes) {
    const candidate = options.newestFirst
      ? [source[index], ...selected]
      : [...selected, source[index]];
    if (jsonByteLength(candidate) <= maxBytes) selected.splice(0, selected.length, ...candidate);
  }
  return selected;
}

function boundedEvidence(value) {
  return (Array.isArray(value) ? value : []).slice(0, 3).map(item => ({
    kind: truncateUtf8(item?.kind, 32) || 'text',
    label: truncateUtf8(item?.label, 192),
    ...(item?.ref ? { ref: truncateUtf8(item.ref, 256) } : {}),
    ...(item?.status ? { status: truncateUtf8(item.status, 32) } : {}),
  })).filter(item => item.label);
}

function coordinatorStageReferences(detail) {
  const actions = (Array.isArray(detail?.actions) ? detail.actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action?.status));
  const stageIds = [...new Set(actions
    .map(action => typeof action?.stageId === 'string' ? action.stageId : '')
    .filter(Boolean))];
  const reserved = new Set(stageIds);
  const used = new Set();
  const aliasByStageId = new Map();
  const stageIdByReference = new Map();

  for (const stageId of stageIds) {
    let alias = stageId;
    if (Buffer.byteLength(alias, 'utf8') > COORDINATOR_MAX_STAGE_ID_BYTES) {
      const digest = createHash('sha256').update(stageId, 'utf8').digest('hex');
      let counter = 0;
      do {
        const suffix = `~${digest}${counter > 0 ? `-${counter}` : ''}`;
        alias = `${truncateUtf8(stageId, COORDINATOR_MAX_STAGE_ID_BYTES - Buffer.byteLength(suffix, 'utf8'))}${suffix}`;
        counter += 1;
      } while (used.has(alias) || (reserved.has(alias) && alias !== stageId));
    }
    if (used.has(alias)) throw new Error(`Coordinator snapshot has duplicate stage identity: ${stageId}`);
    used.add(alias);
    aliasByStageId.set(stageId, alias);
    stageIdByReference.set(stageId, stageId);
    stageIdByReference.set(alias, stageId);
  }
  for (const action of actions) {
    if (typeof action?.id === 'string' && action.id && typeof action.stageId === 'string'
        && !stageIdByReference.has(action.id)) {
      stageIdByReference.set(action.id, action.stageId);
    }
  }
  return {
    project(value) {
      const stageId = typeof value === 'string' ? value : '';
      return aliasByStageId.get(stageId) || truncateUtf8(stageId, COORDINATOR_MAX_STAGE_ID_BYTES);
    },
    resolve(value) {
      const reference = typeof value === 'string' ? value.trim() : '';
      return stageIdByReference.get(reference) || reference;
    },
  };
}

function boundedAction(action, result, stageReferences, compact = false, dynamic = false) {
  const preserveCanonicalResult = action?.status === 'completed';
  const brief = action?.brief && typeof action.brief === 'object' ? action.brief : null;
  return {
    ...(dynamic
      ? {
          actionId: truncateUtf8(action?.id, 256),
          sourceActionIds: (Array.isArray(action?.sourceActionIds) ? action.sourceActionIds : [])
            .slice(0, 8).map(value => truncateUtf8(value, 256)).filter(Boolean),
        }
      : { stageId: stageReferences.project(action?.stageId) }),
    type: truncateUtf8(action?.type, 64),
    status: truncateUtf8(action?.status, 64),
    generation: Math.max(1, Number(action?.generation) || 1),
    ...(dynamic ? {} : {
      dependencies: (Array.isArray(action?.dependsOnStageIds) ? action.dependsOnStageIds : [])
        .slice(0, 8)
        .map(value => stageReferences.project(value))
        .filter(Boolean),
    }),
    workspaceMode: truncateUtf8(action?.workspaceMode, 64),
    ...(!compact && brief ? {
      brief: {
        objective: truncateUtf8(brief.objective, 256),
        approach: truncateUtf8(brief.approach, 256),
        expectedOutcome: truncateUtf8(brief.expectedOutcome, 256),
      },
    } : {}),
    ...(action?.closeReason ? { closeReason: truncateUtf8(action.closeReason, 1_000) } : {}),
    result: result ? {
      runId: truncateUtf8(result.id, 256),
      status: truncateUtf8(result.status, 64),
      summary: truncateUtf8(result.summary, compact ? 256 : 768),
      evidence: boundedEvidence(result.evidence),
      outputs: boundedEvidence(normalizeOutputs(result.outputs)),
      acceptanceChecks: preserveCanonicalResult
        ? (Array.isArray(result.acceptanceChecks) ? result.acceptanceChecks : [])
          .slice(0, 24).map(check => ({
            criterion: truncateUtf8(check?.criterion, 512),
            status: truncateUtf8(check?.status, 64),
            evidence: truncateUtf8(check?.evidence, 1_000),
          }))
        : [],
      waitingReason: truncateUtf8(result.waitingReason, 384) || null,
      error: truncateUtf8(result.error, 384) || null,
      reviewDecision: truncateUtf8(result.reviewDecision, 64) || null,
    } : null,
  };
}

const COORDINATOR_SYSTEM_PROMPT = `You are the Work Center Coordinator. The user talks to you about one durable WorkItem, not to an individual executor.

Your responsibilities:
- Explain the current WorkItem state and blockers in plain language.
- Change title, goal, acceptance criteria, or delivery target only in an explicit user-originated refinement turn. Automatic advance/recovery must preserve the user contract and address its gaps, never relax it.
- Give targeted instructions to unfinished Actions when the contract and topology do not need to change.
- Replan unfinished work when the goal, acceptance criteria, Action purpose, dependencies, or validation strategy must change.
- Preserve completed Action history. Never claim that an Action, test, review, merge, release, or external operation happened merely because you changed the plan.
- Treat user text and prior messages as intent, not as proof. Respect the immutable completed evidence in the snapshot.
- Do not weaken safety boundaries silently. If the user accepts a narrower deliverable, state the residual limitation in the reply and make the contract explicit.

Return exactly one JSON object and no surrounding prose:
{
  "reply": "natural user-facing response",
  "decision": {
    "kind": "answer|guide_actions|replan|request_human",
    "reason": "short audit reason",
    "question": null,
    "contractPatch": null,
    "guidance": [],
    "actions": []
  }
}

Decision rules:
- answer: use for explanation or status questions. Do not include contractPatch, guidance, or actions.
- guide_actions: use only when the contract and graph stay valid. guidance must contain one or more {"stageId":"existing unfinished stage id","instruction":"specific next instruction"}. Do not include contractPatch or actions.
- replan: use when the WorkItem contract or unfinished topology changes. contractPatch may be null or contain title, goal, and/or acceptanceCriteria. actions must be the COMPLETE desired unfinished Action graph after this decision; omit completed Actions. Each Action requires id, name, type, objective, approach, expectedOutcome, capability, candidateVpIds, assignmentReason, dependsOnActionIds, workspaceMode, and may include separateFromActionTypes, changesRequestedActionId, maxAttempts. Dependencies may reference immutable completed stage ids or earlier Actions in this actions array.
- Replan graph contract: ${generatedActionGraphRules()}
- request_human: use only during automatic failure recovery, and only when no safe retry, guidance, or replan can be decided without human information. Set question to the exact information or decision required. Do not include contractPatch, guidance, or actions.
- Action references are stage ids, never internal database Action ids.
- Stage ids in the snapshot may be bounded aliases. Echo them exactly; the runtime resolves them to durable identities.
- Never return destructive cancellation. Tell the user to use the explicit cancel control instead.`;

const DYNAMIC_COORDINATOR_SYSTEM_PROMPT = `You are the persistent Work Center Coordinator. You own progress toward one durable WorkItem.

Observe the current contract, Action journal, canonical Run evidence, and conversation. Decide only the next justified step; never predict or emit a complete workflow graph.

Return exactly one JSON object and no surrounding prose:
{
  "reply": "natural user-facing response",
  "decision": {
    "kind": "answer|create_actions|guide_actions|request_human|complete",
    "reason": "short audit reason",
    "title": null,
    "question": null,
    "workItemType": null,
    "contractPatch": null,
    "closeActions": [],
    "supersedeActionIds": [],
    "guidance": [],
    "actions": [],
    "completion": null
  }
}

Rules:
- When workItem.titleSource is coordinator_pending, include a concise title (prefer 6–12 words or a short Chinese phrase; at most 80 characters) in decision.title. This display label summarizes the original goal; it is not a contractPatch and must not rewrite or shorten the goal. Otherwise leave decision.title null. A missing or oversized display title is normalized by the runtime and must not change the substantive decision.
- answer: explain state only. Never use it for an automatic advance trigger.
- Never mutate goal, acceptanceCriteria, or deliveryTarget during automatic advance/recovery. decision.title is the only automatic title-generation path and is allowed only while titleSource is coordinator_pending; contractPatch (including a user-specified title) is allowed only for explicit user-originated refinement, never to make existing evidence pass. For an older WorkItem with no acceptance criteria, request_human to establish its completion condition before commissioning new work.
- create_actions: create 1..8 currently runnable Actions. Every Action needs type, objective, approach, expectedOutcome, capability, candidateVpIds, assignmentReason, sourceActionIds, workspaceMode, and optional maxAttempts/separateFromActionTypes. sourceActionIds are context/audit references, never scheduling dependencies. Do not include dependsOnActionIds, dependsOnStageIds, stages, or a graph.
- A missing skill/capability label is not a missing execution capability. Prefer an existing VP with a task-specific brief. Missing tools, credentials, or authorization require request_human; never expand roles as a workaround. create_vp is only appropriate when creating a persistent role is itself an explicit user deliverable.
- closeActions may accompany create_actions. Each entry is {"actionId":"failed or waiting durable Action id","reason":"why it is no longer required"}. Close only work made obsolete by replacement evidence or a clarified contract. Closed Actions remain audit history, are never acceptance evidence, and do not block completion.
- guide_actions: target 1..8 unfinished non-running Actions by durable actionId.
- request_human: use when external information or a user decision is genuinely required. Before creating mutating or delivery Actions, ask whether the delivery boundary is a response/report, workspace files, PR, or merge when the contract does not already say. After the user answers, persist it with contractPatch.deliveryTarget = response | workspace_files | pull_request | merge before creating more Actions.
- complete: only when every acceptance criterion has canonical completed Run evidence and there are no unfinished Actions after applying optional closeActions. Include summary, ordered acceptanceResults with evidenceRunIds, evidenceRunIds, and residualRisks. Reuse structured outputs already present on canonical Runs; do not create repetitive evidence-packaging Actions.
- Preserve completed and closed Action history. Never claim tests, review, merge, release, or external effects without canonical Run evidence.
- Action templates are reusable capabilities, not a prescribed workflow. A simple Action includes its local tools and necessary tests; do not impose research/design/implement/test/review/deliver stages.
- Read goalProgress.remainingCriteria, delivery, and blockers first. Resource limits are shared by coordination and all execution, including retries; reserve enough for verification and delivery. Never create a new Action or role merely to evade an exhausted attempt limit. Each new Action must close a concrete current gap. Prefer optional goalRefs: {"criteria":["exact unmet criterion"],"blockerActionIds":["current blocker Action id"],"delivery":false}, plus rationale explaining why this work changes the observed state. Repeating an objective requires goalRefs and a concrete new rationale; do not package already sufficient evidence.
- response delivery is a substantive answer/report in a canonical completed Run summary with evidence and valid checks; do not invent a file, PR, or extra delivery Action.
- Never return destructive cancellation. The user owns the explicit cancel control.`;

function coordinatorSystemPrompt(language, detail) {
  const userLanguage = coordinatorLanguage(language) === 'zh'
    ? 'Simplified Chinese (zh-CN)'
    : 'English';
  const base = isDynamicWorkItem(detail) ? DYNAMIC_COORDINATOR_SYSTEM_PROMPT : COORDINATOR_SYSTEM_PROMPT;
  return `${base}

User-facing language: ${userLanguage}. Write reply and question in that language. Keep JSON property names and decision enum values in English. Never expose deterministic validator errors as the user-facing reply; explain the underlying issue plainly.`;
}

function parseJsonObject(value) {
  const source = String(value || '').trim();
  if (!source) throw new Error('Work Center Coordinator returned an empty response');
  const attempts = [source];
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) attempts.push(fenced.trim());
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(source.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  throw new Error('Work Center Coordinator did not return valid JSON');
}

function cleanText(value, limit, name) {
  const text = typeof value === 'string' ? value.trim().slice(0, limit) : '';
  if (!text) throw new Error(`Work Center Coordinator ${name} is required`);
  return text;
}

function conciseDisplayTitle(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const words = text.split(' ');
  const concise = words.length > 12 ? `${words.slice(0, 12).join(' ')}…` : text;
  const characters = [...concise];
  return characters.length > 80 ? `${characters.slice(0, 79).join('')}…` : concise;
}

function coordinatorDisplayTitle(value, detail) {
  if (detail.titleSource !== 'coordinator_pending') return null;
  const proposed = typeof value === 'string' ? value.trim() : '';
  return conciseDisplayTitle(proposed)
    || conciseDisplayTitle(detail.goal || detail.title)
    || 'Work Item';
}

function requiresDeliveryBoundaryDecision(detail, actions) {
  const requested = Array.isArray(actions) ? actions : [];
  return !detail?.deliveryTarget && requested.some(action => (
    action?.type === 'create_vp' || action?.workspaceMode !== 'read'
  ));
}

function permanentCoordinatorDiagnostic(cause, phase, language) {
  const zh = coordinatorLanguage(language) === 'zh';
  if (cause instanceof LLMAuthError) {
    return zh
      ? 'Work Center Coordinator 认证失败。请更新 Provider 凭据后再重试。'
      : 'Work Center Coordinator authentication failed. Update the configured provider credentials before retrying this Action.';
  }
  if (cause instanceof LLMContextError) {
    return zh
      ? 'Work Center Coordinator 超过模型上下文限制。请减少 WorkItem 上下文，或改用上下文窗口更大的模型后重试。'
      : 'Work Center Coordinator exceeded the model context limit. Reduce the WorkItem context or select a model with a larger context window before retrying this Action.';
  }
  const detail = sanitizeDiagnosticText(cause?.message || String(cause || ''), 2_000);
  const label = zh
    ? (phase === 'runtime'
      ? '无法加载运行时'
      : phase === 'policy'
        ? '无法加载设置'
        : phase === 'selection'
          ? '执行者或模型选择失败'
          : 'Provider 请求失败')
    : (phase === 'runtime'
      ? 'runtime could not be loaded'
      : phase === 'policy'
        ? 'settings could not be loaded'
        : phase === 'selection'
          ? 'executor or model selection failed'
          : 'provider request failed');
  return zh
    ? `Work Center Coordinator ${label}${detail ? `：${detail}` : '。'}`
    : `Work Center Coordinator ${label}${detail ? `: ${detail}` : '.'}`;
}

function coordinatorExecutionError(cause, phase, language) {
  if (cause?.coordinatorClassified === true) return cause;
  const explicitlyPermanent = cause?.retryable === false;
  const retryable = !explicitlyPermanent && (
    cause instanceof LLMRateLimitError
    || cause instanceof LLMServerError
    || (['runtime', 'policy'].includes(phase) && cause?.retryable === true)
  );
  const error = new Error(retryable
    ? coordinatorTemporaryError(language)
    : permanentCoordinatorDiagnostic(cause, phase, language));
  error.coordinatorClassified = true;
  error.coordinatorRetryable = retryable;
  error.coordinatorPhase = phase;
  error.cause = cause;
  return error;
}

function permanentRecoveryDecision(error, language) {
  const zh = coordinatorLanguage(language) === 'zh';
  const diagnostic = String(error?.message || (zh
    ? 'Work Center Coordinator 无法自动恢复这个 Action'
    : 'Work Center Coordinator cannot recover this Action automatically'));
  const resolution = zh
    ? (error?.cause instanceof LLMAuthError
      ? '请更新 Provider 凭据，然后让 Yeaft 重试或重新规划失败的 Action。'
      : error?.cause instanceof LLMContextError
        ? '请减少 WorkItem 上下文，或选择上下文窗口更大的模型，然后让 Yeaft 重试或重新规划失败的 Action。'
        : error?.coordinatorPhase === 'selection'
          ? '请配置可用的 VP 和模型，然后让 Yeaft 重试或重新规划失败的 Action。'
          : error?.coordinatorPhase === 'policy'
            ? '请修正 Work Center 设置，然后让 Yeaft 重试或重新规划失败的 Action。'
            : '请修正 Coordinator 运行时或 Provider 配置，然后让 Yeaft 重试或重新规划失败的 Action。')
    : (error?.cause instanceof LLMAuthError
      ? 'Update the provider credentials, then tell Yeaft to retry or replan the failed Action.'
      : error?.cause instanceof LLMContextError
        ? 'Reduce the WorkItem context or choose a model with a larger context window, then tell Yeaft to retry or replan the failed Action.'
        : error?.coordinatorPhase === 'selection'
          ? 'Configure an available VP and model, then tell Yeaft to retry or replan the failed Action.'
          : error?.coordinatorPhase === 'policy'
            ? 'Correct the Work Center settings, then tell Yeaft to retry or replan the failed Action.'
            : 'Correct the Coordinator runtime or provider configuration, then tell Yeaft to retry or replan the failed Action.');
  return {
    reply: zh
      ? `${diagnostic} 为避免重复尝试，自动恢复已停止。`
      : `${diagnostic} Automatic recovery stopped to avoid repeated attempts.`,
    decision: {
      kind: 'request_human',
      reason: `Automatic recovery stopped after a non-retryable ${error?.coordinatorPhase || 'Coordinator'} error`,
      question: `${diagnostic} ${resolution}`,
      contractPatch: null,
      guidance: [],
      actions: [],
    },
  };
}

function coordinatorDecisionError(error, language) {
  const diagnostic = sanitizeDiagnosticText(error?.message || String(error || ''), 2_000);
  const wrapped = new Error(coordinatorLanguage(language) === 'zh'
    ? 'Work Center Coordinator 生成的操作方案未通过校验。你的消息已经保留；重试会重新生成方案。'
    : 'The Work Center Coordinator proposal did not pass validation. Your message was preserved; retry to generate a new proposal.');
  wrapped.coordinatorClassified = true;
  wrapped.coordinatorRetryable = false;
  wrapped.coordinatorPhase = 'decision';
  wrapped.cause = diagnostic ? new Error(diagnostic) : error;
  return wrapped;
}

function normalizeGuidance(value, detail) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error('Work Center Coordinator guidance requires between 1 and 8 targets');
  }
  const dynamic = isDynamicWorkItem(detail);
  const active = (detail.actions || [])
    .filter(action => !['completed', 'closed', 'superseded', 'cancelled'].includes(action.status));
  const activeByReference = new Map(active.map(action => [dynamic ? action.id : action.stageId, action]));
  const stageReferences = coordinatorStageReferences(detail);
  const seen = new Set();
  return value.map(entry => {
    const reference = dynamic
      ? (typeof entry?.actionId === 'string' ? entry.actionId.trim() : '')
      : stageReferences.resolve(entry?.stageId);
    if (!reference || seen.has(reference) || !activeByReference.has(reference)) {
      throw new Error(`Work Center Coordinator guidance references an invalid unfinished Action: ${reference || '(missing)'}`);
    }
    seen.add(reference);
    return {
      ...(dynamic ? { actionId: reference } : { stageId: reference }),
      instruction: cleanText(entry?.instruction, COORDINATOR_MAX_INSTRUCTION_CHARS, 'guidance instruction'),
    };
  });
}

function normalizeCoordinatorActionReferences(actions, detail) {
  const stageReferences = coordinatorStageReferences(detail);
  const normalizeReference = value => typeof value === 'string'
    ? stageReferences.resolve(value)
    : value;
  return actions.map(action => ({
    ...structuredClone(action),
    ...(typeof action?.id === 'string' ? { id: normalizeReference(action.id) } : {}),
    ...(Array.isArray(action?.dependsOnActionIds) ? {
      dependsOnActionIds: action.dependsOnActionIds.map(normalizeReference),
    } : {}),
    ...(Object.hasOwn(action || {}, 'changesRequestedActionId') ? {
      changesRequestedActionId: normalizeReference(action.changesRequestedActionId),
    } : {}),
  }));
}

export function normalizeCoordinatorResponse(value, detail, options = {}) {
  const parsed = typeof value === 'string' ? parseJsonObject(value) : value;
  const reply = cleanText(parsed?.reply, COORDINATOR_MAX_REPLY_CHARS, 'reply');
  const source = parsed?.decision && typeof parsed.decision === 'object' && !Array.isArray(parsed.decision)
    ? parsed.decision
    : {};
  const automatic = options.automatic === true || (options.recovery === true && options.userOriginated !== true);
  assertCoordinatorContractAuthority(source.contractPatch, !automatic && options.userOriginated !== false);
  const dynamic = isDynamicWorkItem(detail);
  const allowedKinds = dynamic
    ? (options.automatic === true
      ? ['create_actions', 'guide_actions', 'request_human', 'complete']
      : ['answer', 'create_actions', 'guide_actions', 'request_human', 'complete'])
    : (options.recovery === true
      ? ['guide_actions', 'replan', 'request_human']
      : ['answer', 'guide_actions', 'replan']);
  const kind = allowedKinds.includes(source.kind) ? source.kind : '';
  if (!kind) throw new Error('Work Center Coordinator decision kind is invalid');
  const reason = cleanText(source.reason, 2_000, 'decision reason');
  const generatedTitle = coordinatorDisplayTitle(source.title, detail);
  if (kind === 'answer') {
    return { reply, decision: { kind, reason, title: generatedTitle, contractPatch: null, guidance: [], actions: [] } };
  }
  if (kind === 'guide_actions') {
    const guidance = normalizeGuidance(source.guidance, detail);
    if (options.recovery === true) {
      const failed = detail.actions?.find(action => (
        action.id === options.recoveryActionId && action.status === 'failed'
      ));
      if (!failed || guidance.length !== 1 || guidance[0].stageId !== failed.stageId) {
        throw new Error('Work Center Coordinator recovery guidance must target only the failed Action');
      }
    }
    return {
      reply,
      decision: {
        kind,
        reason,
        title: generatedTitle,
        contractPatch: null,
        guidance,
        actions: [],
      },
    };
  }
  if (kind === 'request_human') {
    const contractPatch = dynamic ? normalizeContractPatch(source.contractPatch) : null;
    return {
      reply,
      decision: {
        kind,
        reason,
        title: generatedTitle,
        question: cleanText(source.question, COORDINATOR_MAX_REPLY_CHARS, 'human question'),
        contractPatch: dynamic && options.automatic !== true ? contractPatch : null,
        guidance: [],
        actions: [],
      },
    };
  }
  if (dynamic && kind === 'complete') {
    return {
      reply,
      decision: {
        kind,
        reason,
        title: generatedTitle,
        closeActions: normalizeDynamicActionClosures(source.closeActions, detail.actions || []),
        completion: source.completion,
        contractPatch: null,
        guidance: [],
        actions: [],
      },
    };
  }
  if (dynamic && kind === 'create_actions') {
    const contractPatch = normalizeContractPatch(source.contractPatch);
    if (requiresDeliveryBoundaryDecision(detail, source.actions)) {
      throw new Error('Work Center delivery target is unconfirmed; the delivery boundary requires request_human before creating mutating or delivery Actions');
    }
    const decision = {
      kind,
      reason,
      title: generatedTitle,
      workItemType: source.workItemType,
      contractPatch,
      closeActions: source.closeActions,
      supersedeActionIds: source.supersedeActionIds,
      guidance: [],
      actions: source.actions,
    };
    return {
      reply,
      decision,
      mutation: prepareDynamicActionMutation({
        workItem: detail,
        actions: detail.actions || [],
        decision,
        availableVpIds: options.availableVpIds,
        automatic,
      }),
    };
  }
  const contractPatch = normalizeContractPatch(source.contractPatch);
  if (!Array.isArray(source.actions)) {
    throw new Error('Work Center Coordinator replan requires the complete unfinished Action graph');
  }
  if (source.actions.length < 1 || source.actions.length > 8) {
    throw new Error('Work Center Coordinator replan requires between 1 and 8 unfinished Actions');
  }
  return {
    reply,
    decision: {
      kind,
      reason,
      title: generatedTitle,
      contractPatch,
      guidance: [],
      actions: normalizeCoordinatorActionReferences(source.actions, detail),
    },
  };
}

function coordinatorHistory(messages) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role !== 'assistant' || message.status !== 'thinking')
    .filter(message => typeof message?.text === 'string' && message.text.trim())
    .slice(-COORDINATOR_MAX_CONVERSATION_MESSAGES)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text: truncateUtf8(message.role === 'legacy_instruction'
        ? `[Legacy global instruction already delivered to executors] ${message.text}`
        : message.text, 2_000),
    }));
  return boundedJsonArray(history, COORDINATOR_MAX_CONVERSATION_BYTES, { newestFirst: true });
}

function coordinatorSnapshotText(detail) {
  const snapshot = coordinatorSnapshot(detail);
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > COORDINATOR_MAX_SNAPSHOT_BYTES) {
    throw new Error('WorkItem cannot be represented within the Coordinator snapshot budget');
  }
  return serialized;
}

function finalizedCriteria(detail, contractPatch) {
  const criteria = contractPatch?.acceptanceCriteria ?? detail.acceptanceCriteria ?? [];
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 24) {
    throw new Error('Work Center Coordinator replan requires between 1 and 24 acceptance criteria');
  }
  return criteria;
}

export function coordinatorSnapshot(detail) {
  const runs = Array.isArray(detail.runs) ? detail.runs : [];
  const canonicalRunByAction = new Map();
  for (const action of detail.actions || []) {
    const candidates = runs
      .filter(run => run.actionId === action.id && run.status !== 'running')
      .sort((left, right) => Number(right.endedAt || right.startedAt) - Number(left.endedAt || left.startedAt));
    const canonical = action.resultRunId
      ? candidates.find(run => run.id === action.resultRunId)
      : candidates[0];
    if (canonical) canonicalRunByAction.set(action.id, canonical);
  }

  const acceptanceCriteria = boundedJsonArray(
    (Array.isArray(detail.acceptanceCriteria) ? detail.acceptanceCriteria : [])
      .slice(0, 24)
      .map(value => truncateUtf8(value, 768))
      .filter(Boolean),
    8 * 1024,
  );
  const workItem = {
    id: truncateUtf8(detail.id, 256),
    revision: detail.revision,
    planRevision: detail.planRevision,
    ledgerRevision: detail.ledgerRevision,
    status: truncateUtf8(detail.status, 64),
    title: truncateUtf8(detail.title, 1 * 1024),
    titleSource: detail.titleSource || 'explicit',
    goal: truncateUtf8(detail.goal, 4 * 1024),
    deliveryTarget: detail.deliveryTarget || null,
    deliveryInstructions: truncateUtf8(detail.deliveryInstructions || '', 500) || null,
    acceptanceCriteria,
    workItemType: truncateUtf8(detail.workflowSnapshot?.workItemType, 256) || null,
  };
  if (jsonByteLength(workItem) > COORDINATOR_MAX_WORK_ITEM_BYTES) {
    throw new Error('WorkItem contract cannot be represented within the Coordinator snapshot budget');
  }

  const dynamic = isDynamicWorkItem(detail);
  const currentActions = (Array.isArray(detail.actions) ? detail.actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action.status));
  const stageReferences = coordinatorStageReferences(detail);
  const unfinished = currentActions.filter(action => !['completed', 'closed'].includes(action.status));
  const completed = currentActions.filter(action => ['completed', 'closed'].includes(action.status));
  const selected = [
    ...unfinished,
    ...completed.slice(-Math.max(0, COORDINATOR_MAX_ACTIONS - unfinished.length)),
  ].slice(0, COORDINATOR_MAX_ACTIONS);
  let projectedActions = selected.map(action => boundedAction(
    action,
    canonicalRunByAction.get(action.id),
    stageReferences,
    action.status === 'completed',
    dynamic,
  ));
  let actions = boundedJsonArray(projectedActions, COORDINATOR_MAX_ACTIONS_BYTES);
  const identity = action => `${dynamic ? action.actionId : action.stageId}:${action.generation}`;
  const expectedIdentity = action => `${dynamic ? action.id : stageReferences.project(action.stageId)}:${action.generation}`;
  let includedActionIdentities = new Set(actions.map(identity));
  if (unfinished.some(action => !includedActionIdentities.has(expectedIdentity(action)))) {
    projectedActions = selected.map(action => boundedAction(
      action,
      canonicalRunByAction.get(action.id),
      stageReferences,
      true,
      dynamic,
    ));
    actions = boundedJsonArray(projectedActions, COORDINATOR_MAX_ACTIONS_BYTES);
    includedActionIdentities = new Set(actions.map(identity));
  }
  if (unfinished.some(action => !includedActionIdentities.has(expectedIdentity(action)))) {
    throw new Error('Active Actions cannot be represented within the Coordinator snapshot budget');
  }

  const progress = deriveGoalProgress(detail);
  const goalProgress = {
    contractRevision: progress.contractRevision,
    completedCriteriaCount: progress.completedCriteriaCount,
    totalCriteriaCount: progress.totalCriteriaCount,
    remainingCriteria: boundedJsonArray(progress.remainingCriteria.map(value => truncateUtf8(value, 768)), 2 * 1024),
    delivery: { ...progress.delivery, evidenceRunIds: progress.delivery.evidenceRunIds.slice(0, 24) },
    criteria: boundedJsonArray(progress.criteria.map(item => ({ ...item,
      criterion: truncateUtf8(item.criterion, 768), evidenceRunIds: item.evidenceRunIds.slice(0, 24),
      ...(item.conflictingRunIds ? { conflictingRunIds: item.conflictingRunIds.slice(0, 24) } : {}),
    })), 2 * 1024),
    blockers: boundedJsonArray(progress.blockers.map(item => ({ ...item, reason: truncateUtf8(item.reason, 384) })), 1 * 1024),
  };
  goalProgress.omittedCriteriaCount = progress.criteria.length - goalProgress.criteria.length;
  goalProgress.omittedRemainingCriteriaCount = progress.remainingCriteria.length - goalProgress.remainingCriteria.length;
  goalProgress.omittedBlockerCount = progress.blockers.length - goalProgress.blockers.length;
  return {
    workItem,
    goalProgress,
    actions,
    omittedCompletedActionCount: Math.max(0, completed.length - actions.filter(action => ['completed', 'closed'].includes(action.status)).length),
    conversation: coordinatorHistory(detail.messages),
  };
}

export class WorkItemCoordinator {
  constructor(options = {}) {
    this.store = options.store;
    this.runtimeProvider = options.runtimeProvider;
    this.policyProvider = typeof options.policyProvider === 'function' ? options.policyProvider : async () => ({});
    this.registry = options.registry;
    this.ownerBootId = options.ownerBootId || randomUUID();
    this.claimLeaseMs = Math.max(5_000, Number(options.claimLeaseMs) || 60_000);
    this.attachmentRoot = options.attachmentRoot || null;
    this.languageProvider = typeof options.languageProvider === 'function'
      ? options.languageProvider
      : runtime => runtime?.config?.language || 'en';
    this.activeTurns = new Map();
    this.activeTasks = new Map();
    this.shuttingDown = false;
  }

  message(id, input = {}, options = {}) {
    if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
    const text = typeof input.text === 'string'
      ? input.text.trim().slice(0, COORDINATOR_MAX_REPLY_CHARS)
      : '';
    const quote = normalizeSessionMessageQuote(input.quote);
    const addedAttachments = Array.isArray(input.addedAttachments) ? input.addedAttachments : [];
    if (!text && addedAttachments.length === 0) {
      throw new Error('Work Center Coordinator message or attachments are required');
    }
    const promptText = `${text || `The user added ${addedAttachments.length} attachment(s) for this WorkItem.`}${coordinatorQuotePrompt(quote)}`;
    let started = this.store.beginCoordinatorTurn(id, text, {
      revision: Number(input.revision),
      planRevision: Number(input.planRevision),
      ledgerRevision: Number(input.ledgerRevision),
      coordinatorRevision: Number(input.coordinatorRevision),
    }, {
      attachments: input.attachments,
      addedAttachments,
      clientMessageId: input.clientMessageId,
      quote,
    });
    if (!started) throw new Error(`WorkItem not found: ${id}`);
    if (started.duplicate) {
      return { detail: started.detail, task: Promise.resolve(started.detail), duplicate: true };
    }
    const claimed = this.store.claimStartedCoordinatorTurn(started, this.ownerBootId, this.claimLeaseMs);
    if (!claimed) return { detail: started.detail, task: Promise.resolve(started.detail), duplicate: true };
    started = claimed;
    options.onUpdate?.('coordinator.turn_started', started.detail);
    return this.#scheduleTurn(started, {
      text: promptText,
      recovery: false,
      addedAttachments,
      options,
    });
  }

  resume(started, options = {}) {
    if (!started?.turnId || !started?.detail || !started?.fence) {
      throw new Error('Coordinator provider recovery target is invalid');
    }
    const quote = normalizeSessionMessageQuote(options.quote);
    const text = typeof options.text === 'string' ? options.text : '';
    return this.#scheduleTurn(started, {
      text: `${text}${coordinatorQuotePrompt(quote)}`,
      recovery: options.recovery === true,
      addedAttachments: Array.isArray(options.addedAttachments) ? options.addedAttachments : [],
      options,
    });
  }

  advance(mailboxId, options = {}) {
    if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
    const claim = this.store.claimCoordinatorMailbox(options.workItemId, this.ownerBootId, this.claimLeaseMs);
    if (!claim) return null;
    if (claim.id !== mailboxId) {
      this.store.releaseCoordinatorMailboxClaim(
        claim.id, this.ownerBootId, Number(claim.claim_epoch),
      );
      return null;
    }
    const started = this.store.beginDynamicCoordinatorTurn(mailboxId, {
      ownerBootId: this.ownerBootId,
      claimEpoch: Number(claim.claim_epoch),
    });
    if (!started) {
      this.store.releaseCoordinatorMailboxClaim(
        claim.id, this.ownerBootId, Number(claim.claim_epoch),
      );
      return null;
    }
    options.onUpdate?.('coordinator.advance_started', started.detail);
    const trigger = started.detail.messages?.find(message => message.turnId === started.turnId)?.trigger;
    const text = `Automatic WorkItem advance trigger: ${JSON.stringify(trigger || { kind: claim.kind })}. `
      + 'Observe the current durable state and choose the next justified Actions, a genuine human request, '
      + 'or evidence-backed completion. Do not stop merely because the previous Action ended.';
    return this.#scheduleTurn(started, { text, recovery: false, options });
  }

  recover(id, options = {}) {
    if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
    const detail = this.store.getWorkItemDetail(id);
    const hasExplicitIdentity = typeof options.actionId === 'string' && options.actionId;
    const action = hasExplicitIdentity
      ? detail?.actions?.find(candidate => (
          candidate.id === options.actionId
          && candidate.generation === options.actionGeneration
        ))
      : detail?.actions?.find(candidate => (
          candidate.id === detail.currentActionId && candidate.status === 'failed'
        ));
    if (!detail || ['done', 'cancelled'].includes(detail.status) || action?.status !== 'failed'
        || !this.store.canAutomaticallyCoordinate(id)) return null;
    const started = this.store.beginCoordinatorTurn(id, '', {
      revision: detail.revision,
      planRevision: detail.planRevision,
      ledgerRevision: detail.ledgerRevision,
      coordinatorRevision: detail.coordinatorRevision,
    }, {
      recovery: {
        actionId: action.id,
        actionGeneration: action.generation,
        stageId: action.stageId,
      },
    });
    if (!started) return null;
    const claimed = this.store.claimStartedCoordinatorTurn(started, this.ownerBootId, this.claimLeaseMs);
    if (!claimed) return null;
    options.onUpdate?.('coordinator.recovery_started', claimed.detail);
    const text = `Action stage "${action.stageId}" failed. Decide the next safe control transition. `
      + 'Failure is not a terminal WorkItem state: guide or replan executable work whenever possible. '
      + 'Request human input only when the snapshot lacks information required for a safe decision.';
    return this.#scheduleTurn(claimed, { text, recovery: true, options });
  }

  #scheduleTurn(started, {
    text, recovery, addedAttachments = [], options,
  }) {
    const abortController = new AbortController();
    this.activeTurns.set(started.turnId, abortController);
    const claim = started.fence?.claim;
    const renewalTimer = claim ? setInterval(() => {
      if (!this.store.renewCoordinatorMailbox(
        claim.mailboxId, claim.ownerBootId, claim.claimEpoch, this.claimLeaseMs,
      )) abortController.abort('work_center_coordinator_claim_lost');
    }, Math.max(1_000, Math.floor(this.claimLeaseMs / 3))) : null;
    renewalTimer?.unref?.();
    const task = new Promise(resolve => setTimeout(resolve, 0))
      .then(() => this.#executeTurn(started, {
        text, recovery, addedAttachments, options, abortController,
      }))
      .finally(() => {
        if (renewalTimer) clearInterval(renewalTimer);
        this.activeTurns.delete(started.turnId);
        this.activeTasks.delete(started.turnId);
      });
    this.activeTasks.set(started.turnId, task);
    return { detail: started.detail, task };
  }

  async #executeTurn(started, {
    text, recovery, addedAttachments, options, abortController,
  }) {
    let providerTurn = null;
    let candidateSpeaker = null;
    let speaker = (started.detail.messages || []).find(message => (
      message?.turnId === started.turnId && message.role === 'assistant'
    ))?.speaker || null;
    try {
      let normalized = null;
      let mutation = null;
      let attemptCount = 0;
      let lastError = null;
      const snapshotText = coordinatorSnapshotText(started.detail);
      let language = 'en';
      const attachmentContext = !recovery && this.attachmentRoot
        ? buildWorkItemAttachmentContext({ ...started.detail, attachments: addedAttachments }, {
            root: this.attachmentRoot,
            inlineTextBytes: 32 * 1024,
          })
        : { promptBlock: '', promptParts: [] };
      try {
        let runtime;
        let settings;
        try {
          runtime = await this.runtimeProvider();
          language = coordinatorLanguage(await this.languageProvider(runtime));
        } catch (error) {
          throw coordinatorExecutionError(error, 'runtime', language);
        }
        try {
          settings = await this.policyProvider();
        } catch (error) {
          throw coordinatorExecutionError(error, 'policy', language);
        }
        if (this.shuttingDown) throw new Error('Work Center Coordinator is shutting down');
        let vps;
        let resolved;
        try {
          vps = this.registry?.listVps?.() || [];
          if (vps.length === 0) {
            const error = new Error('Work Center has no available VPs');
            error.retryable = false;
            throw error;
          }
          const assignment = selectWorkItemVp({
            policy: { mode: 'pool', candidateVpIds: vps.map(vp => vp.id), capability: 'triage' },
            stageType: 'triage',
            vps,
            priorRuns: started.detail.runs || [],
          });
          candidateSpeaker = {
            id: assignment.vp.id,
            name: assignment.vp.name || assignment.vp.id,
          };
          const coordinatorPolicy = settings?.coordinatorModelPolicy || {
            ...(settings?.modelPolicy || {}),
            effort: settings?.actionModelPolicies?.triage?.effort || settings?.modelPolicy?.effort || 'high',
          };
          resolved = resolveWorkItemModel(
            runtime.config,
            assignment.vp,
            coordinatorPolicy,
            settings?.modelTags || DEFAULT_WORK_CENTER_MODEL_TAGS,
          );
        } catch (error) {
          throw coordinatorExecutionError(error, 'selection', language);
        }
        const maxAttempts = recovery
          ? COORDINATOR_RECOVERY_DECISION_ATTEMPTS
          : COORDINATOR_DECISION_ATTEMPTS;
        for (let index = 0; index < maxAttempts; index += 1) {
          attemptCount = index + 1;
          mutation = null;
          const correction = lastError
            ? `\n\nYour previous decision was rejected by the deterministic validator:\n${String(lastError.message || lastError).slice(0, 2_000)}\nReturn a corrected complete JSON decision.`
            : '';
          providerTurn = null;
          try {
            let result;
            try {
              const capabilities = JSON.stringify(workItemCapabilityContext(vps, {
                hasAttachments: started.detail.attachments?.length > 0,
              }));
              const latestMessage = `Available execution capabilities (role metadata is descriptive, not authorization):\n${capabilities}\n\nCurrent WorkItem snapshot:\n${snapshotText}\n\n${recovery ? 'Automatic failure recovery trigger' : 'Latest user message'}:\n${text}${attachmentContext.promptBlock}${correction}`;
              const content = attachmentContext.promptParts.length > 0
                ? [{ type: 'text', text: latestMessage }, ...attachmentContext.promptParts]
                : latestMessage;
              const requestBody = {
                model: resolved.model,
                system: coordinatorSystemPrompt(language, started.detail),
                messages: [{ role: 'user', content }],
                maxTokens: Math.min(
                  resolveMaxOutputTokens(resolved.model, runtime.config),
                  COORDINATOR_MAX_OUTPUT_TOKENS,
                ),
                effort: resolved.effort,
                effortSource: resolved.source,
                effortContext: { scenario: 'work-center-coordinator' },
              };
              const claim = started.fence.claim;
              providerTurn = this.store.prepareCoordinatorProviderTurn(
                started.detail.id, started.turnId, attemptCount, requestBody, claim, candidateSpeaker,
              );
              if (!providerTurn) return started.detail;
              speaker = providerTurn.speaker;
              if (providerTurn.status === 'unknown') {
                throw new Error('Coordinator provider dispatch outcome is unknown and requires review');
              }
              if (providerTurn.status === 'responded') {
                result = providerTurn.response;
              } else {
                result = await Promise.race([
                callCoordinatorWithResourceControl(runtime.adapter, this.store, providerTurn, claim, {
                  ...requestBody,
                  signal: abortController.signal,
                }).then(response => {
                  const persisted = this.store.respondCoordinatorProviderTurn(
                    providerTurn.id, providerTurn.requestHash, response, claim,
                  );
                  if (!persisted) throw new Error('Coordinator provider response lost its CAS fence');
                  providerTurn = persisted;
                  return response;
                }),
                new Promise((_, reject) => {
                  abortController.signal.addEventListener('abort', () => {
                    reject(new Error('Work Center Coordinator was interrupted'));
                  }, { once: true });
                }),
              ]);
              }
            } catch (error) {
              if (abortController.signal.aborted || this.shuttingDown) throw error;
              throw coordinatorExecutionError(error, 'provider', language);
            }
            normalized = normalizeCoordinatorResponse(result?.text, started.detail, {
              recovery,
              automatic: started.fence.automatic === true,
              userOriginated: started.fence.userOriginated === true,
              recoveryActionId: started.fence.recovery?.actionId || null,
              availableVpIds: vps.map(vp => vp.id),
            });
            mutation = normalized.mutation || null;
            if (normalized.decision.kind === 'replan') {
              finalizedCriteria(started.detail, normalized.decision.contractPatch);
              mutation = applyCoordinatorReplan({
                workItem: {
                  ...started.detail,
                  ...(normalized.decision.contractPatch || {}),
                },
                actions: started.detail.actions || [],
                proposal: {
                  proposalId: `coordinator:${started.turnId}`,
                  basePlanRevision: started.detail.planRevision,
                  reason: normalized.decision.reason,
                  actions: normalized.decision.actions,
                },
                availableVpIds: vps.map(vp => vp.id),
              });
            }
            lastError = null;
            break;
          } catch (error) {
            normalized = null;
            if (providerTurn?.status === 'responded') {
              this.store.rejectCoordinatorProviderTurn(providerTurn.id, error, started.fence.claim);
            }
            if (abortController.signal.aborted || this.shuttingDown || error?.coordinatorClassified) {
              throw error;
            }
            lastError = error;
          }
        }
      } catch (error) {
        lastError = error;
      }
      if (abortController.signal.aborted || this.shuttingDown) {
        throw lastError || new Error('Work Center Coordinator was interrupted');
      }
      if (!normalized) {
        if (!recovery) {
          throw lastError?.coordinatorClassified
            ? lastError
            : coordinatorDecisionError(
              lastError || new Error('Work Center Coordinator did not produce a decision'),
              language,
            );
        }
        if (lastError?.coordinatorRetryable) throw lastError;
        normalized = lastError?.coordinatorClassified
          ? permanentRecoveryDecision(lastError, language)
          : {
              reply: language === 'zh'
                ? '自动恢复无法确定安全、可执行的下一步，需要你补充信息。'
                : 'Automatic recovery could not choose a safe executable next step. Human input is required.',
              decision: {
                kind: 'request_human',
                reason: 'Automatic recovery exhausted its bounded decision attempts',
                question: language === 'zh'
                  ? '请查看失败的 Action，并补充安全重试或重新规划所需的决定或约束。'
                  : 'Review the failed Action and provide the missing decision or constraint needed to retry or replan it safely.',
                contractPatch: null,
                guidance: [],
                actions: [],
              },
            };
      }
      const detail = this.store.completeCoordinatorTurn(started.turnId, {
        reply: normalized.reply,
        speaker,
        decision: normalized.decision,
        mutation,
        attemptCount,
      }, started.fence);
      if (!detail) return this.store.getWorkItemDetail(started.detail.id);
      options.onUpdate?.(started.fence.automatic === true
        ? 'coordinator.advance_completed'
        : recovery ? 'coordinator.recovery_completed' : 'coordinator.turn_completed', detail);
      return detail;
    } catch (error) {
      if (providerTurn) this.store.settleCoordinatorRequest(providerTurn.id, null, false);
      if (providerTurn?.status === 'responded') {
        this.store.rejectCoordinatorProviderTurn(providerTurn.id, error, started.fence.claim);
      }
      const detail = this.store.failCoordinatorTurn(started.turnId, error, {
        ...started.fence,
        speaker,
        interrupted: abortController.signal.aborted || this.shuttingDown,
      });
      if (detail) {
        options.onUpdate?.('coordinator.turn_failed', detail);
        return detail;
      }
      return this.store.getWorkItemDetail(started.detail.id);
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    for (const controller of this.activeTurns.values()) controller.abort('work_center_coordinator_shutdown');
    const tasks = [...this.activeTasks.values()];
    if (tasks.length > 0) await Promise.allSettled(tasks);
    this.activeTurns.clear();
    this.activeTasks.clear();
  }
}
