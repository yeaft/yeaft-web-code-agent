import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeEvidence, normalizeOutputs } from './evidence.js';
import { normalizeContractPatch } from './completion-contract.js';
import { normalizeActionCheckpoint } from './action-checkpoint.js';
import { currentActionInputEventIds, runMatchesActionIdentity } from './action-identity.js';
import { isDynamicWorkItem, usesLegacyGraph } from './execution-mode.js';
import { normalizeDynamicCompletion } from './dynamic-coordination.js';
import { canonicalActionInstruction, withoutActionInputContext } from './workflow.js';
import {
  WORK_CENTER_SCHEMA_VERSION,
  durableId,
  migrateDurableWorkCenterModel,
} from './durable-model.js';

const SCHEMA_VERSION = WORK_CENTER_SCHEMA_VERSION;
const UNFINISHED_ACTION_STATUSES = "'ready','running','waiting','failed'";
const MAX_REUSABLE_CONTEXT_ITEMS = 12;
const MAX_RUN_RESPONSE_CHARS = 65_536;

function normalizeRunResponse(value) {
  const response = typeof value === 'string' ? value : String(value || '');
  return response.slice(0, MAX_RUN_RESPONSE_CHARS);
}

function canonicalWorkspaceKey(workDir) {
  if (typeof workDir !== 'string' || !workDir.trim()) return '';
  try { return realpathSync(resolve(workDir.trim())); } catch { return ''; }
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stringify(value) {
  return JSON.stringify(value ?? null);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function coordinatorActionFence(actions) {
  return createHash('sha256').update(stableJson((actions || []).map(action => ({
    id: action.id,
    generation: action.generation,
    status: action.status,
    currentRunId: action.currentRunId || null,
    leaseEpoch: action.leaseEpoch,
    resultRunId: action.resultRunId || null,
  })).sort((left, right) => left.id.localeCompare(right.id))), 'utf8').digest('hex');
}

function coordinatorRecoveryIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actionId = typeof value.actionId === 'string' ? value.actionId : '';
  const stageId = typeof value.stageId === 'string' ? value.stageId : '';
  const actionGeneration = Number(value.actionGeneration);
  if (!actionId || !stageId || !Number.isInteger(actionGeneration) || actionGeneration < 1) return null;
  return { actionId, actionGeneration, stageId };
}

function sameCoordinatorRecoveryIdentity(persisted, expected) {
  const persistedPresent = persisted != null;
  const expectedPresent = expected != null;
  if (!persistedPresent && !expectedPresent) return true;
  if (persistedPresent !== expectedPresent) return false;
  const persistedIdentity = coordinatorRecoveryIdentity(persisted);
  const expectedIdentity = coordinatorRecoveryIdentity(expected);
  return !!persistedIdentity && !!expectedIdentity
    && persistedIdentity.actionId === expectedIdentity.actionId
    && persistedIdentity.actionGeneration === expectedIdentity.actionGeneration
    && persistedIdentity.stageId === expectedIdentity.stageId;
}

function actionSpecHash(action) {
  const spec = {
    type: action.type || '',
    stageId: action.stageId || action.type || '',
    assignmentPolicy: action.assignmentPolicy || null,
    modelPolicy: action.modelPolicy || null,
    dependsOnStageIds: [...new Set(action.dependsOnStageIds || [])].sort(),
    sourceActionIds: [...new Set(action.sourceActionIds || [])].sort(),
    workspaceMode: action.workspaceMode || 'shared',
    changesRequestedStageId: action.changesRequestedStageId || null,
    requiredRole: action.requiredRole || '',
    instruction: action.instruction || '',
    brief: action.brief || null,
    context: Array.isArray(action.context) ? action.context : [],
    contractRevision: Number.isInteger(action.contractRevision) ? action.contractRevision : 1,
  };
  return createHash('sha256').update(stableJson(spec), 'utf8').digest('hex');
}

function mapWorkItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    revision: row.revision,
    planRevision: Math.max(0, Number(row.plan_revision) || 0),
    executionSchemaVersion: Math.max(1, Number(row.execution_schema_version) || 1),
    ledgerRevision: Math.max(0, Number(row.ledger_revision) || 0),
    coordinationMode: row.coordination_mode || 'legacy',
    finalResult: parseJson(row.final_result, null),
    deliveryTarget: row.delivery_target || null,
    title: row.title,
    goal: row.goal,
    acceptanceCriteria: parseJson(row.acceptance_criteria, []),
    workflowTemplate: row.workflow_template,
    workflowSnapshot: parseJson(row.workflow_snapshot, null),
    status: row.status,
    currentActionId: row.current_action_id || null,
    currentAction: row.current_action_type ? {
      id: row.current_action_id,
      type: row.current_action_type,
      stageId: row.current_action_stage_id || row.current_action_type,
      status: row.current_action_status || null,
      brief: parseJson(row.current_action_brief, null),
    } : null,
    currentRunId: row.current_run_id || null,
    workDir: row.work_dir || '',
    workspaceKey: row.workspace_key || '',
    reuseMemory: row.reuse_memory !== 0,
    origin: parseJson(row.origin, null),
    linkedSessionIds: parseJson(row.linked_session_ids, []),
    actionCount: Math.max(0, Number(row.action_count) || 0),
    completedActionCount: Math.max(0, Number(row.completed_action_count) || 0),
    sessionContext: parseJson(row.session_context, []),
    messages: parseJson(row.messages, []),
    coordinatorRevision: Math.max(0, Number(row.coordinator_revision) || 0),
    attachments: parseJson(row.attachments, []),
    executionStats: {
      llmRequestCount: Math.max(0, Number(row.usage_llm_request_count) || 0),
      loopCount: Math.max(0, Number(row.usage_loop_count) || 0),
      toolCount: Math.max(0, Number(row.usage_tool_count) || 0),
      inputTokens: Math.max(0, Number(row.usage_input_tokens) || 0),
      outputTokens: Math.max(0, Number(row.usage_output_tokens) || 0),
      cacheReadTokens: Math.max(0, Number(row.usage_cache_read_tokens) || 0),
      cacheWriteTokens: Math.max(0, Number(row.usage_cache_write_tokens) || 0),
      totalTokens: Math.max(0, Number(row.usage_total_tokens) || 0),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dynamicExecutionState(workItem, actions) {
  if (!isDynamicWorkItem(workItem)) return workItem;
  const current = (Array.isArray(actions) ? actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action.status));
  const activeActionIds = current.filter(action => ['ready', 'running'].includes(action.status))
    .map(action => action.id);
  const waitingIds = current.filter(action => action.status === 'waiting').map(action => action.id);
  const failedIds = current.filter(action => action.status === 'failed').map(action => action.id);
  return {
    ...workItem,
    lifecycle: workItem.status === 'cancelled' ? 'cancelled'
      : workItem.status === 'done' ? 'done'
        : workItem.status === 'draft' ? 'draft' : 'active',
    attentionState: waitingIds.length > 0 && failedIds.length > 0 ? 'mixed'
      : waitingIds.length > 0 ? 'waiting'
        : failedIds.length > 0 ? 'failed' : 'none',
    activeActionIds,
    attentionActionIds: [...waitingIds, ...failedIds],
  };
}

function graphExecutionState(workItem, actions) {
  if (!usesLegacyGraph(workItem)) return dynamicExecutionState(workItem, actions);
  const current = (Array.isArray(actions) ? actions : [])
    .filter(action => !['superseded', 'cancelled'].includes(action.status));
  const activeActionIds = current
    .filter(action => ['ready', 'running'].includes(action.status))
    .map(action => action.id);
  const waitingIds = current.filter(action => action.status === 'waiting').map(action => action.id);
  const failedIds = current.filter(action => action.status === 'failed').map(action => action.id);
  const attentionActionIds = current
    .filter(action => ['waiting', 'failed'].includes(action.status))
    .map(action => action.id);
  const lifecycle = workItem.status === 'cancelled' ? 'cancelled'
    : current.length === 0 || workItem.status === 'draft' ? 'draft'
      : current.every(action => action.status === 'completed') ? 'done'
        : 'active';
  const attentionState = waitingIds.length > 0 && failedIds.length > 0 ? 'mixed'
    : waitingIds.length > 0 ? 'waiting'
      : failedIds.length > 0 ? 'failed'
        : 'none';
  return {
    ...workItem,
    lifecycle,
    attentionState,
    activeActionIds,
    attentionActionIds,
  };
}

function mapAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    sequence: row.sequence,
    type: row.type,
    stageId: row.stage_id || row.type,
    assignmentPolicy: parseJson(row.assignment_policy, null),
    modelPolicy: parseJson(row.model_policy, null),
    dependsOnStageIds: parseJson(row.depends_on_stage_ids, []),
    sourceActionIds: parseJson(row.source_action_ids, []),
    creationSource: row.creation_source || 'legacy',
    workspaceMode: row.workspace_mode || 'shared',
    changesRequestedStageId: row.changes_requested_stage_id || null,
    workspace: parseJson(row.workspace, null),
    requiredRole: row.required_role || '',
    instruction: row.instruction,
    brief: parseJson(row.brief, null),
    context: parseJson(row.context, []),
    contractRevision: row.contract_revision,
    generation: Math.max(1, Number(row.generation) || 1),
    specHash: row.spec_hash || '',
    identityHistory: parseJson(row.identity_history, []),
    resultRunId: row.result_run_id || null,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    currentRunId: row.current_run_id || null,
    leaseEpoch: row.lease_epoch,
    replacesActionId: row.replaces_action_id || null,
    closeReason: row.close_reason || null,
    closedAt: row.closed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actionIdentityHistory(action, generation = action?.generation, specHash = action?.specHash) {
  const byGeneration = new Map();
  for (const identity of Array.isArray(action?.identityHistory) ? action.identityHistory : []) {
    const value = Math.max(1, Number(identity?.generation) || 1);
    if (typeof identity?.specHash === 'string' && identity.specHash) {
      byGeneration.set(value, { generation: value, specHash: identity.specHash });
    }
  }
  const value = Math.max(1, Number(generation) || 1);
  if (typeof specHash === 'string' && specHash) byGeneration.set(value, { generation: value, specHash });
  return [...byGeneration.values()].sort((left, right) => left.generation - right.generation).slice(-100);
}

function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    actionId: row.action_id,
    workItemId: row.work_item_id,
    ownerBootId: row.owner_boot_id,
    leaseEpoch: row.lease_epoch,
    ordinal: Math.max(1, Number(row.ordinal) || 1),
    terminalStatus: row.terminal_status || null,
    terminalAt: row.terminal_at || null,
    status: row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at || null,
    roleSnapshot: parseJson(row.role_snapshot, null),
    vpSnapshot: parseJson(row.vp_snapshot, null),
    modelSnapshot: parseJson(row.model_snapshot, null),
    toolPolicySnapshot: parseJson(row.tool_policy_snapshot, null),
    contextSnapshot: parseJson(row.context_snapshot, null),
    executionManifest: parseJson(row.execution_manifest, null),
    response: row.response || '',
    summary: row.summary || '',
    evidence: normalizeEvidence(parseJson(row.evidence, [])),
    outputs: normalizeOutputs(parseJson(row.outputs, [])),
    acceptanceChecks: parseJson(row.acceptance_checks, []),
    waitingReason: row.waiting_reason || null,
    error: row.error || null,
    failureKind: row.failure_kind || null,
    failureCode: row.failure_code || null,
    reviewDecision: row.review_decision || null,
    contractPatch: parseJson(row.contract_patch, null),
    loopCount: Math.max(0, Number(row.loop_count) || 0),
    toolCount: Math.max(0, Number(row.tool_count) || 0),
    llmRequestCount: Math.max(0, Number(row.llm_request_count) || 0),
    inputTokens: Math.max(0, Number(row.input_tokens) || 0),
    outputTokens: Math.max(0, Number(row.output_tokens) || 0),
    cacheReadTokens: Math.max(0, Number(row.cache_read_tokens) || 0),
    cacheWriteTokens: Math.max(0, Number(row.cache_write_tokens) || 0),
    totalTokens: Math.max(0, Number(row.total_tokens) || 0),
    progressRevision: Math.max(0, Number(row.progress_revision) || 0),
    checkpoint: normalizeActionCheckpoint(parseJson(row.checkpoint, null)),
    acceptingInput: row.accepting_input !== 0,
    actionGeneration: Math.max(1, Number(row.action_generation) || 1),
    actionSpecHash: row.action_spec_hash || parseJson(row.execution_manifest, null)?.actionSpecHash || '',
    actionAttempt: Math.max(1, Number(row.action_attempt) || 1),
  };
}

function mapPlanConflict(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    actionId: row.action_id || null,
    generation: Math.max(1, Number(row.generation) || 1),
    kind: row.kind,
    status: row.status,
    details: parseJson(row.details, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null,
  };
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    workItemId: row.work_item_id,
    actionId: row.action_id || null,
    runId: row.run_id || null,
    actionGeneration: row.action_generation == null ? null : Math.max(1, Number(row.action_generation) || 1),
    type: row.type,
    data: parseJson(row.data, {}),
    createdAt: row.created_at,
  };
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
}

function normalizeLegacyWorkItemMessages(db) {
  const updateMessages = db.prepare('UPDATE work_items SET messages = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, messages FROM work_items').all()) {
    const messages = parseJson(row.messages, []);
    if (!Array.isArray(messages) || messages.length === 0) continue;
    let changed = false;
    const normalized = messages.map(message => {
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.role) return message;
      changed = true;
      return {
        ...message,
        turnId: message.turnId || message.id || randomUUID(),
        role: 'legacy_instruction',
        status: message.status || 'completed',
        updatedAt: message.updatedAt || message.createdAt || 0,
      };
    });
    if (changed) updateMessages.run(stringify(normalized), row.id);
  }
}

function carryCurrentActionInputContext(db, action, extraInputs = [], explicitOnly = false) {
  const events = db.prepare(`SELECT * FROM events WHERE action_id = ? ORDER BY id`)
    .all(action.id).map(mapEvent);
  const extraRows = (Array.isArray(extraInputs) ? extraInputs : []).map(value => (
    value && typeof value === 'object' ? value : { event_id: value }
  ));
  const validInputEventIds = explicitOnly ? new Set() : currentActionInputEventIds(events, action);
  const fallbackAttachments = new Map();
  for (const row of extraRows) {
    validInputEventIds.add(String(row.event_id));
    const attachments = parseJson(row.attachments, []);
    if (Array.isArray(attachments) && attachments.length > 0) {
      fallbackAttachments.set(String(row.event_id), attachments);
    }
  }
  const inputAttachments = event => {
    const attachments = Array.isArray(event?.data?.attachments) ? event.data.attachments : [];
    return attachments.length > 0
      ? attachments
      : fallbackAttachments.get(String(event?.id)) || [];
  };
  const inputEvents = events.filter(event => event.type === 'action.input_added'
    && validInputEventIds.has(String(event.id)));
  const eventByInputId = new Map(inputEvents
    .filter(event => event.data?.inputId)
    .map(event => [event.data.inputId, event]));
  const eventById = new Map(inputEvents.map(event => [String(event.id), event]));
  const usedEventIds = new Set();
  const seenInputIds = new Set();
  const context = (Array.isArray(action.context) ? action.context : []).flatMap(entry => {
    if (entry?.type !== 'input') return [entry];
    let event = entry.inputId ? eventByInputId.get(entry.inputId) : null;
    if (!event && typeof entry.inputId === 'string' && entry.inputId.startsWith('legacy-event:')) {
      event = eventById.get(entry.inputId.slice('legacy-event:'.length)) || null;
    }
    if (!event && !entry.inputId) {
      event = inputEvents.find(candidate => !usedEventIds.has(candidate.id)
        && (candidate.data?.text || '') === (entry.summary || '')) || null;
    }
    if (!entry.inputId && !event) return explicitOnly ? [entry] : [];
    const inputId = entry.inputId || event.data?.inputId || `legacy-event:${event.id}`;
    if (seenInputIds.has(inputId)) return [];
    seenInputIds.add(inputId);
    if (event) usedEventIds.add(event.id);
    return [{
      ...entry,
      inputId,
      summary: event?.data?.text || entry.summary || '',
      quote: event?.data?.quote || entry.quote || null,
      attachments: Array.isArray(entry.attachments) && entry.attachments.length > 0
        ? entry.attachments
        : inputAttachments(event),
    }];
  });
  for (const event of inputEvents) {
    if (usedEventIds.has(event.id)) continue;
    const inputId = event.data?.inputId || `legacy-event:${event.id}`;
    if (seenInputIds.has(inputId)) continue;
    seenInputIds.add(inputId);
    context.push({
      type: 'input',
      role: 'user',
      inputId,
      summary: event.data?.text || '',
      quote: event.data?.quote || null,
      attachments: inputAttachments(event),
      evidence: [],
    });
  }
  return context;
}

function promoteReadyActionInputs(db, action, rows, now, reason) {
  const pendingRows = Array.isArray(rows) ? rows : [];
  if (pendingRows.length === 0) return action;
  if (action?.status !== 'ready' || action.currentRunId) {
    throw new Error('Work Center can only promote pending input for an unowned ready Action');
  }
  const context = carryCurrentActionInputContext(db, action, pendingRows, true);
  const contextChanged = stableJson(context) !== stableJson(action.context || []);
  const workItem = mapWorkItem(db.prepare('SELECT * FROM work_items WHERE id = ?').get(action.workItemId));
  if (!workItem) throw new Error('Work Center pending input Action lost its WorkItem');
  const candidate = { ...action, context };
  candidate.instruction = contextChanged
    ? canonicalActionInstruction(workItem, candidate, context)
    : action.instruction;
  candidate.specHash = contextChanged ? actionSpecHash(candidate) : action.specHash;
  const specChanged = candidate.specHash !== action.specHash;
  const target = specChanged
    ? { ...candidate, generation: action.generation + 1 }
    : action;
  if (specChanged) {
    const changed = db.prepare(`UPDATE actions SET context = ?, instruction = ?, attempt = 0,
      generation = ?, spec_hash = ?, identity_history = ?, result_run_id = NULL, workspace = NULL, updated_at = ?
      WHERE id = ? AND status = 'ready' AND current_run_id IS NULL AND generation = ? AND spec_hash = ?`).run(
      stringify(context),
      candidate.instruction,
      target.generation,
      target.specHash,
      stringify(actionIdentityHistory(action, target.generation, target.specHash)),
      now,
      action.id,
      action.generation,
      action.specHash,
    );
    if (Number(changed.changes) !== 1) {
      throw new Error('Work Center could not promote ready Action input atomically');
    }
  }
  const insertReboundEvent = db.prepare(`INSERT INTO events
    (work_item_id, action_id, run_id, action_generation, type, data, created_at)
    VALUES (?, ?, NULL, ?, 'action.input_rebound', ?, ?)`);
  const settleReady = db.prepare(`UPDATE pending_action_inputs SET run_id = NULL,
    action_generation = ?, action_spec_hash = ?, consumed_at = COALESCE(consumed_at, ?)
    WHERE event_id = ? AND action_id = ? AND superseded_at IS NULL`);
  for (const row of pendingRows) {
    if (!row.skipReboundAudit) {
      insertReboundEvent.run(
        action.workItemId,
        action.id,
        target.generation,
        stringify({
          sourceEventId: Number(row.event_id),
          sourceRunId: row.run_id || null,
          sourceGeneration: Math.max(1, Number(row.sourceGeneration ?? row.action_generation) || 1),
          sourceSpecHash: row.sourceSpecHash ?? row.action_spec_hash ?? '',
          reason: row.repairedRun ? 'schema19_legacy_repair' : reason,
          targetSpecHash: target.specHash,
        }),
        now,
      );
    }
    const settled = settleReady.run(
      target.generation,
      target.specHash,
      now,
      Number(row.event_id),
      action.id,
    );
    if (Number(settled.changes) !== 1) {
      throw new Error('Work Center could not settle canonical ready Action input atomically');
    }
  }
  return specChanged ? mapAction(db.prepare('SELECT * FROM actions WHERE id = ?').get(action.id)) : action;
}

function reconcilePendingActionInputIdentity(db, now) {
  const rows = db.prepare(`SELECT p.*, e.type AS event_type, e.action_generation AS event_generation,
    a.status AS action_status, a.current_run_id, a.generation AS current_generation,
    a.spec_hash AS current_spec_hash, r.status AS run_status, r.error AS run_error,
    r.action_generation AS run_generation, r.action_spec_hash AS run_spec_hash
    FROM pending_action_inputs p
    JOIN events e ON e.id = p.event_id
    JOIN actions a ON a.id = p.action_id
    LEFT JOIN runs r ON r.id = p.run_id
    WHERE p.superseded_at IS NULL
    ORDER BY p.event_id`).all();
  const bindActive = db.prepare(`UPDATE pending_action_inputs SET action_generation = ?, action_spec_hash = ?
    WHERE event_id = ? AND superseded_at IS NULL`);
  const supersede = db.prepare(`UPDATE pending_action_inputs SET superseded_at = ?
    WHERE event_id = ? AND superseded_at IS NULL`);
  const insertSupersededEvent = db.prepare(`INSERT INTO events
    (work_item_id, action_id, run_id, action_generation, type, data, created_at)
    VALUES (?, ?, ?, ?, 'action.input_superseded', ?, ?)`);
  const readyRowsByAction = new Map();
  for (const row of rows) {
    const currentGeneration = Math.max(1, Number(row.current_generation) || 1);
    const currentSpecHash = row.current_spec_hash || '';
    const activeRunMatches = row.action_status === 'running'
      && row.current_run_id === row.run_id
      && row.run_status === 'running'
      && Math.max(1, Number(row.run_generation) || 1) === currentGeneration
      && (row.run_spec_hash || '') === currentSpecHash;
    if (row.event_type === 'action.input_added' && activeRunMatches) {
      bindActive.run(currentGeneration, currentSpecHash, row.event_id);
      continue;
    }
    const sourceGeneration = Math.max(
      1,
      Number(row.run_generation) || Number(row.event_generation) || Number(row.action_generation) || 1,
    );
    const sourceSpecHash = row.run_spec_hash || row.action_spec_hash || '';
    const repairedRun = row.run_status === 'superseded'
      && row.run_error === 'Superseded by Work Center schema 19 legacy instruction repair';
    const sameIdentity = sourceGeneration === currentGeneration
      && (!sourceSpecHash || !currentSpecHash || sourceSpecHash === currentSpecHash);
    if (row.event_type === 'action.input_added' && row.action_status === 'ready'
        && (sameIdentity || repairedRun)) {
      const readyRows = readyRowsByAction.get(row.action_id) || [];
      readyRows.push({ ...row, sourceGeneration, sourceSpecHash, repairedRun });
      readyRowsByAction.set(row.action_id, readyRows);
      continue;
    }
    if (row.consumed_at != null) continue;
    supersede.run(now, row.event_id);
    insertSupersededEvent.run(
      row.work_item_id,
      row.action_id,
      row.run_id || null,
      sourceGeneration,
      stringify({
        reason: 'schema20_identity_mismatch',
        sourceEventIds: [row.event_id],
        sourceGeneration,
        sourceSpecHash,
        currentGeneration,
        currentSpecHash,
      }),
      now,
    );
  }
  for (const [actionId, readyRows] of readyRowsByAction) {
    const action = mapAction(db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId));
    promoteReadyActionInputs(db, action, readyRows, now, 'schema20_identity_backfill');
  }
}

function repairReviewBuildActionInputIdentity(db, now) {
  const actions = db.prepare(`SELECT a.* FROM actions a
    JOIN work_items w ON w.id = a.work_item_id
    WHERE a.status = 'ready' AND a.current_run_id IS NULL
      AND w.status NOT IN ('done', 'cancelled')
    ORDER BY a.work_item_id, a.sequence, a.id`).all();
  const inputRows = db.prepare(`SELECT p.*, e.work_item_id AS event_work_item_id,
    e.action_id AS event_action_id, e.data AS event_data,
    e.action_generation AS event_generation, r.work_item_id AS run_work_item_id,
    r.action_id AS run_action_id, r.status AS run_status, r.error AS run_error,
    r.action_generation AS run_generation, r.action_spec_hash AS run_spec_hash
    FROM pending_action_inputs p
    JOIN events e ON e.id = p.event_id
    LEFT JOIN runs r ON r.id = p.run_id
    WHERE p.action_id = ? AND p.superseded_at IS NULL AND e.type = 'action.input_added'
    ORDER BY p.event_id`);
  const actionEvents = db.prepare('SELECT * FROM events WHERE action_id = ? ORDER BY id');
  for (const actionRow of actions) {
    const action = mapAction(actionRow);
    const missingInputs = action.context.filter(entry => entry?.type === 'input' && !entry.inputId);
    if (missingInputs.length === 0 || !action.specHash) continue;
    const existingInputIds = new Set(action.context
      .filter(entry => entry?.type === 'input' && entry.inputId)
      .map(entry => String(entry.inputId)));
    const events = actionEvents.all(action.id).map(mapEvent);
    const currentEventIds = currentActionInputEventIds(events, action);
    const history = new Set(actionIdentityHistory(action)
      .map(identity => `${identity.generation}\u0000${identity.specHash}`));
    const currentCanonicalRows = [];
    const eligible = inputRows.all(action.id).flatMap(row => {
      const event = mapEvent({
        id: row.event_id,
        work_item_id: row.work_item_id,
        action_id: row.action_id,
        run_id: row.run_id,
        action_generation: row.event_generation,
        type: 'action.input_added',
        data: row.event_data,
        created_at: row.created_at,
      });
      const eventInputId = event.data?.inputId || `legacy-event:${event.id}`;
      const sameOwner = row.work_item_id === action.workItemId
        && row.event_work_item_id === action.workItemId
        && row.event_action_id === action.id
        && (!row.run_id || (
          row.run_work_item_id === action.workItemId && row.run_action_id === action.id
        ));
      const sourceRunStopped = !row.run_id || (row.run_status && row.run_status !== 'running');
      const eventText = event.data?.text || '';
      if (!sameOwner || !sourceRunStopped || (row.text || '') !== eventText) return [];
      const alreadyCurrent = currentEventIds.has(String(event.id))
        && Math.max(1, Number(row.action_generation) || 1) === action.generation
        && (row.action_spec_hash || '') === action.specHash;
      if (existingInputIds.has(String(eventInputId))) {
        if (alreadyCurrent) {
          currentCanonicalRows.push({
            ...row,
            sourceGeneration: action.generation,
            sourceSpecHash: action.specHash,
            skipReboundAudit: true,
            canonicalInputId: String(eventInputId),
            eventText,
          });
        }
        return [];
      }
      const runGeneration = Math.max(1, Number(row.run_generation) || 1);
      const runSpecHash = row.run_spec_hash || '';
      const malformedCurrentConsumed = row.consumed_at != null
        && row.run_id
        && row.run_status === 'interrupted'
        && runGeneration === action.generation
        && runSpecHash === action.specHash
        && Math.max(1, Number(row.event_generation) || 1) === runGeneration
        && Math.max(1, Number(row.action_generation) || 1) === runGeneration
        && !row.action_spec_hash;
      const historicalInterruptedConsumed = row.consumed_at != null
        && row.run_id
        && row.run_status === 'interrupted'
        && runGeneration < action.generation
        && runSpecHash
        && history.has(`${runGeneration}\u0000${runSpecHash}`)
        && Math.max(1, Number(row.event_generation) || 1) === runGeneration
        && Math.max(1, Number(row.action_generation) || 1) === runGeneration
        && !row.action_spec_hash;
      const repairedConsumed = row.consumed_at != null
        && row.run_id
        && row.run_status === 'superseded'
        && row.run_error === 'Superseded by Work Center schema 19 legacy instruction repair'
        && runGeneration < action.generation
        && runSpecHash
        && history.has(`${runGeneration}\u0000${runSpecHash}`)
        && Math.max(1, Number(row.event_generation) || 1) === runGeneration
        && Math.max(1, Number(row.action_generation) || 1) === runGeneration
        && !row.action_spec_hash;
      if (!alreadyCurrent && !malformedCurrentConsumed
          && !historicalInterruptedConsumed && !repairedConsumed) return [];
      return [{
        ...row,
        sourceGeneration: alreadyCurrent ? action.generation : runGeneration,
        sourceSpecHash: alreadyCurrent ? action.specHash : runSpecHash,
        skipReboundAudit: alreadyCurrent,
        eventText,
      }];
    });
    if (eligible.length !== missingInputs.length) continue;
    const remaining = [...eligible];
    const matched = [];
    for (const entry of missingInputs) {
      const index = remaining.findIndex(row => row.eventText === (entry.summary || ''));
      if (index < 0) break;
      matched.push(remaining.splice(index, 1)[0]);
    }
    if (matched.length !== missingInputs.length || remaining.length !== 0) continue;
    const repairRows = [...matched, ...currentCanonicalRows]
      .sort((left, right) => Number(left.event_id) - Number(right.event_id));
    const currentCanonicalInputIds = new Set(currentCanonicalRows.map(row => row.canonicalInputId));
    const repairAction = currentCanonicalInputIds.size === 0
      ? action
      : {
          ...action,
          context: action.context.map(entry => {
            if (entry?.type !== 'input' || !currentCanonicalInputIds.has(String(entry.inputId || ''))) {
              return entry;
            }
            const { inputId: ignoredInputId, ...inputSlot } = entry;
            return { ...inputSlot, attachments: [] };
          }),
        };
    promoteReadyActionInputs(
      db,
      repairAction,
      repairRows,
      now,
      'schema22_review_build_repair',
    );
  }
}

function repairLegacyActionInstructions(db, now) {
  const legacyActions = db.prepare(`SELECT a.*, w.title AS work_item_title,
    w.goal AS work_item_goal, w.acceptance_criteria AS work_item_acceptance_criteria,
    w.workflow_snapshot AS work_item_workflow_snapshot, w.session_context AS work_item_session_context,
    w.current_action_id AS work_item_current_action_id
    FROM actions a JOIN work_items w ON w.id = a.work_item_id
    WHERE w.execution_schema_version = 1
      AND w.status NOT IN ('done', 'cancelled')
      AND a.status IN ('ready', 'running', 'waiting', 'failed')
    ORDER BY a.work_item_id, a.sequence`).all();
  const supersedeRuns = db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?,
    error = ?, accepting_input = 0 WHERE action_id = ? AND status = 'running'`);
  const hasRunningRun = db.prepare(`SELECT 1 FROM runs
    WHERE action_id = ? AND status = 'running' LIMIT 1`);
  const updateAction = db.prepare(`UPDATE actions SET context = ?, instruction = ?, status = ?, attempt = 0,
    current_run_id = NULL, lease_epoch = ?, generation = ?, spec_hash = ?, identity_history = ?,
    result_run_id = NULL, workspace = NULL, updated_at = ? WHERE id = ?`);
  const updateWorkItem = db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
    current_run_id = NULL, updated_at = ? WHERE id = ?`);
  const deleteLegacyPendingInput = db.prepare(`DELETE FROM pending_action_inputs
    WHERE action_id = ? AND consumed_at IS NULL AND event_id IN (
      SELECT id FROM events WHERE action_id = ? AND type = 'work_item.message_applied'
    )`);
  const repairedGraphWorkItems = new Set();
  for (const row of legacyActions) {
    const action = mapAction(row);
    const workflowSnapshot = parseJson(row.work_item_workflow_snapshot, null);
    const workItem = {
      title: row.work_item_title,
      goal: row.work_item_goal,
      acceptanceCriteria: parseJson(row.work_item_acceptance_criteria, []),
      workflowSnapshot,
      sessionContext: parseJson(row.work_item_session_context, []),
    };
    const context = carryCurrentActionInputContext(db, action);
    const repairedAction = { ...action, context };
    const instruction = canonicalActionInstruction(workItem, repairedAction, context);
    const generation = action.generation + 1;
    const specHash = actionSpecHash({ ...repairedAction, instruction });
    const priorIdentityHistory = actionIdentityHistory(action);
    const activeRun = Boolean(hasRunningRun.get(action.id));
    supersedeRuns.run(
      now,
      'Superseded by Work Center schema 19 legacy instruction repair',
      action.id,
    );
    const status = action.status === 'running' ? 'ready' : action.status;
    const leaseEpoch = action.leaseEpoch + (action.status === 'running' || activeRun ? 1 : 0);
    updateAction.run(
      stringify(context),
      instruction,
      status,
      leaseEpoch,
      generation,
      specHash,
      stringify(actionIdentityHistory({ ...action, identityHistory: priorIdentityHistory }, generation, specHash)),
      now,
      action.id,
    );
    deleteLegacyPendingInput.run(action.id, action.id);
    if (workflowSnapshot?.executionMode === 'graph') {
      repairedGraphWorkItems.add(action.workItemId);
    } else if (row.work_item_current_action_id === action.id) {
      updateWorkItem.run(status === 'failed' ? 'needs_attention' : status, action.id, now, action.workItemId);
    }
  }
  for (const workItemId of repairedGraphWorkItems) {
    const candidates = db.prepare(`SELECT id, status FROM actions WHERE work_item_id = ?
      AND status IN ('ready', 'running', 'waiting', 'failed') ORDER BY sequence`).all(workItemId);
    const attention = candidates.find(candidate => ['waiting', 'failed'].includes(candidate.status));
    const active = candidates.find(candidate => ['ready', 'running'].includes(candidate.status));
    const current = attention || active || null;
    const status = attention
      ? (attention.status === 'waiting' ? 'waiting' : 'needs_attention')
      : active ? (active.status === 'running' ? 'running' : 'ready') : 'done';
    updateWorkItem.run(status, current?.id || null, now, workItemId);
  }
}

export class WorkItemStore {
  constructor(dbPath, options = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.onTransitionStep = typeof options.onTransitionStep === 'function'
      ? options.onTransitionStep
      : null;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.#initSchema();
    this.recoverCoordinatorMailbox();
    this.recoverCoordinatorProviderTurns();
    this.recoverOperations();
    this.recoverEngineTurns();
    this.recoverInterruptedCoordinatorTurns();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 1,
        plan_revision INTEGER NOT NULL DEFAULT 0,
        execution_schema_version INTEGER NOT NULL DEFAULT 2,
        ledger_revision INTEGER NOT NULL DEFAULT 0,
        coordination_mode TEXT NOT NULL DEFAULT 'legacy',
        final_result TEXT,
        delivery_target TEXT,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        workflow_template TEXT NOT NULL,
        workflow_snapshot TEXT,
        status TEXT NOT NULL,
        current_action_id TEXT,
        current_run_id TEXT,
        work_dir TEXT NOT NULL DEFAULT '',
        workspace_key TEXT NOT NULL DEFAULT '',
        reuse_memory INTEGER NOT NULL DEFAULT 1,
        origin TEXT,
        linked_session_ids TEXT NOT NULL DEFAULT '[]',
        session_context TEXT NOT NULL DEFAULT '[]',
        messages TEXT NOT NULL DEFAULT '[]',
        coordinator_revision INTEGER NOT NULL DEFAULT 0,
        attachments TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        required_role TEXT NOT NULL,
        stage_id TEXT,
        assignment_policy TEXT,
        model_policy TEXT,
        depends_on_stage_ids TEXT NOT NULL DEFAULT '[]',
        source_action_ids TEXT NOT NULL DEFAULT '[]',
        creation_source TEXT NOT NULL DEFAULT 'legacy',
        workspace_mode TEXT NOT NULL DEFAULT 'shared',
        changes_requested_stage_id TEXT,
        workspace TEXT,
        instruction TEXT NOT NULL,
        brief TEXT,
        context TEXT NOT NULL DEFAULT '[]',
        contract_revision INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 1,
        spec_hash TEXT NOT NULL DEFAULT '',
        identity_history TEXT NOT NULL DEFAULT '[]',
        result_run_id TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 2,
        current_run_id TEXT,
        lease_epoch INTEGER NOT NULL DEFAULT 0,
        replaces_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
        close_reason TEXT,
        closed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(work_item_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        owner_boot_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ended_at INTEGER,
        role_snapshot TEXT,
        vp_snapshot TEXT,
        model_snapshot TEXT,
        tool_policy_snapshot TEXT,
        context_snapshot TEXT,
        execution_manifest TEXT,
        summary TEXT,
        evidence TEXT NOT NULL DEFAULT '[]',
        outputs TEXT NOT NULL DEFAULT '[]',
        acceptance_checks TEXT NOT NULL DEFAULT '[]',
        waiting_reason TEXT,
        error TEXT,
        failure_kind TEXT,
        failure_code TEXT,
        review_decision TEXT,
        contract_patch TEXT,
        response TEXT NOT NULL DEFAULT '',
        loop_count INTEGER NOT NULL DEFAULT 0,
        tool_count INTEGER NOT NULL DEFAULT 0,
        llm_request_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        progress_revision INTEGER NOT NULL DEFAULT 0,
        checkpoint TEXT,
        accepting_input INTEGER NOT NULL DEFAULT 1,
        action_generation INTEGER NOT NULL DEFAULT 1,
        action_spec_hash TEXT NOT NULL DEFAULT '',
        action_attempt INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT,
        run_id TEXT,
        action_generation INTEGER,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_action_inputs (
        event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
        run_id TEXT,
        action_generation INTEGER NOT NULL DEFAULT 1,
        action_spec_hash TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        consumed_at INTEGER,
        superseded_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS plan_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL,
        base_plan_revision INTEGER NOT NULL,
        plan_revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        action_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(work_item_id, proposal_id)
      );
      CREATE TABLE IF NOT EXISTS plan_conflicts (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        details TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_plan_conflicts_work_item ON plan_conflicts(work_item_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_work_items_status_updated ON work_items(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_actions_ready ON actions(status, updated_at, sequence);
      CREATE INDEX IF NOT EXISTS idx_runs_active ON runs(status, expires_at);
      CREATE INDEX IF NOT EXISTS idx_events_work_item ON events(work_item_id, id);
      CREATE INDEX IF NOT EXISTS idx_pending_action_inputs_action
        ON pending_action_inputs(action_id, consumed_at, event_id);
    `);

    const storedSchemaVersion = Number(
      this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value,
    ) || 0;
    if (storedSchemaVersion > SCHEMA_VERSION) {
      throw new Error(`Work Center database schema ${storedSchemaVersion} is newer than supported schema ${SCHEMA_VERSION}`);
    }

    // The feature shipped first as an unmerged PR, but keep the store tolerant
    // of databases created by review builds.
    if (!hasColumn(this.db, 'work_items', 'workspace_key')) {
      withTransaction(this.db, () => {
        this.db.exec("ALTER TABLE work_items ADD COLUMN workspace_key TEXT NOT NULL DEFAULT ''");
        const update = this.db.prepare('UPDATE work_items SET workspace_key = ? WHERE id = ?');
        for (const row of this.db.prepare("SELECT id, work_dir FROM work_items WHERE work_dir != ''").all()) {
          const workspaceKey = canonicalWorkspaceKey(row.work_dir);
          if (workspaceKey) update.run(workspaceKey, row.id);
        }
      });
    }
    if (!hasColumn(this.db, 'work_items', 'reuse_memory')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN reuse_memory INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'work_items', 'messages')) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN messages TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'work_items', 'coordinator_revision')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN coordinator_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'actions', 'brief')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN brief TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'context')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN context TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'actions', 'contract_revision')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN contract_revision INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'runs', 'tool_policy_snapshot')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN tool_policy_snapshot TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'review_decision')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN review_decision TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'contract_patch')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN contract_patch TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'failure_kind')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN failure_kind TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'failure_code')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN failure_code TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'loop_count')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN loop_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'runs', 'tool_count')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN tool_count INTEGER NOT NULL DEFAULT 0');
    }
    for (const column of [
      'llm_request_count',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_write_tokens',
      'total_tokens',
    ]) {
      if (!hasColumn(this.db, 'runs', column)) {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
      }
    }
    if (!hasColumn(this.db, 'runs', 'response')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN response TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(this.db, 'runs', 'progress_revision')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'runs', 'checkpoint')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN checkpoint TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'accepting_input')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN accepting_input INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'work_items', 'workflow_snapshot')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN workflow_snapshot TEXT');
    }
    if (!hasColumn(this.db, 'work_items', 'session_context')) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN session_context TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'work_items', 'attachments')) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'actions', 'stage_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN stage_id TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'assignment_policy')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN assignment_policy TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'model_policy')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN model_policy TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'depends_on_stage_ids')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN depends_on_stage_ids TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'actions', 'workspace_mode')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared'");
    }
    if (!hasColumn(this.db, 'actions', 'changes_requested_stage_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN changes_requested_stage_id TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'workspace')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN workspace TEXT');
    }
    if (!hasColumn(this.db, 'work_items', 'plan_revision')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'work_items', 'execution_schema_version')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN execution_schema_version INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'work_items', 'ledger_revision')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN ledger_revision INTEGER NOT NULL DEFAULT 0');
    }
    if (!hasColumn(this.db, 'work_items', 'coordination_mode')) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN coordination_mode TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!hasColumn(this.db, 'work_items', 'final_result')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN final_result TEXT');
    }
    if (!hasColumn(this.db, 'work_items', 'delivery_target')) {
      this.db.exec('ALTER TABLE work_items ADD COLUMN delivery_target TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'source_action_ids')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN source_action_ids TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'actions', 'creation_source')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN creation_source TEXT NOT NULL DEFAULT 'legacy'");
    }
    if (!hasColumn(this.db, 'actions', 'generation')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN generation INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'actions', 'spec_hash')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN spec_hash TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(this.db, 'actions', 'identity_history')) {
      this.db.exec("ALTER TABLE actions ADD COLUMN identity_history TEXT NOT NULL DEFAULT '[]'");
      const seedIdentity = this.db.prepare('UPDATE actions SET identity_history = ? WHERE id = ?');
      for (const row of this.db.prepare('SELECT id, generation, spec_hash FROM actions').all()) {
        seedIdentity.run(stringify(actionIdentityHistory({
          generation: row.generation,
          specHash: row.spec_hash,
        })), row.id);
      }
    }
    if (!hasColumn(this.db, 'actions', 'result_run_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN result_run_id TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'replaces_action_id')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN replaces_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL');
    }
    if (!hasColumn(this.db, 'actions', 'close_reason')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN close_reason TEXT');
    }
    if (!hasColumn(this.db, 'actions', 'closed_at')) {
      this.db.exec('ALTER TABLE actions ADD COLUMN closed_at INTEGER');
    }
    if (!hasColumn(this.db, 'runs', 'outputs')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN outputs TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'runs', 'action_generation')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN action_generation INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'runs', 'action_spec_hash')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN action_spec_hash TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(this.db, 'runs', 'action_attempt')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN action_attempt INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'events', 'action_generation')) {
      this.db.exec('ALTER TABLE events ADD COLUMN action_generation INTEGER');
    }
    if (!hasColumn(this.db, 'pending_action_inputs', 'action_generation')) {
      this.db.exec('ALTER TABLE pending_action_inputs ADD COLUMN action_generation INTEGER NOT NULL DEFAULT 1');
    }
    if (!hasColumn(this.db, 'pending_action_inputs', 'action_spec_hash')) {
      this.db.exec("ALTER TABLE pending_action_inputs ADD COLUMN action_spec_hash TEXT NOT NULL DEFAULT ''");
    }
    if (!hasColumn(this.db, 'pending_action_inputs', 'superseded_at')) {
      this.db.exec('ALTER TABLE pending_action_inputs ADD COLUMN superseded_at INTEGER');
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_action_inputs_identity
      ON pending_action_inputs(action_id, action_generation, action_spec_hash,
        run_id, consumed_at, superseded_at, event_id)`);
    if (!hasColumn(this.db, 'runs', 'acceptance_checks')) {
      this.db.exec("ALTER TABLE runs ADD COLUMN acceptance_checks TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hasColumn(this.db, 'runs', 'context_snapshot')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN context_snapshot TEXT');
    }
    if (!hasColumn(this.db, 'runs', 'execution_manifest')) {
      this.db.exec('ALTER TABLE runs ADD COLUMN execution_manifest TEXT');
    }
    if (storedSchemaVersion < SCHEMA_VERSION) {
      withTransaction(this.db, () => {
        if (storedSchemaVersion < 18) normalizeLegacyWorkItemMessages(this.db);
        if (storedSchemaVersion < 19) repairLegacyActionInstructions(this.db, this.now());
        const updateIdentity = this.db.prepare(`UPDATE runs SET action_generation = ?,
          action_spec_hash = ?, action_attempt = ? WHERE id = ?`);
        const attempts = new Map();
        for (const row of this.db.prepare(`SELECT id, action_id, action_generation, action_spec_hash,
          execution_manifest, started_at FROM runs ORDER BY action_id, started_at, id`).all()) {
          const manifest = parseJson(row.execution_manifest, null);
          const generation = Math.max(1, Number(manifest?.actionGeneration) || Number(row.action_generation) || 1);
          const key = `${row.action_id}\u0000${generation}`;
          const attempt = (attempts.get(key) || 0) + 1;
          attempts.set(key, attempt);
          updateIdentity.run(
            generation,
            manifest?.actionSpecHash || row.action_spec_hash || '',
            attempt,
            row.id,
          );
        }
        if (storedSchemaVersion < 20) reconcilePendingActionInputIdentity(this.db, this.now());
        if (storedSchemaVersion < 22) repairReviewBuildActionInputIdentity(this.db, this.now());
      });
    }
    withTransaction(this.db, () => {
      migrateDurableWorkCenterModel(this.db, this.now(), storedSchemaVersion || SCHEMA_VERSION);
      this.db.prepare(`INSERT INTO schema_meta(key, value) VALUES('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(SCHEMA_VERSION));
    });
  }

  close() {
    this.db.close();
  }

  #nextConversationSequence(conversationId) {
    return Number(this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS value
      FROM conversation_entries WHERE conversation_id = ?`).get(conversationId)?.value) || 1;
  }

  #nextActionEntrySequence(actionId) {
    return Number(this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS value
      FROM action_entries WHERE action_id = ?`).get(actionId)?.value) || 1;
  }

  #appendConversationEntry(workItemId, entry, sourceKey) {
    const now = this.now();
    const conversationId = `work-item:${workItemId}`;
    this.db.prepare(`INSERT INTO conversations
      (id, work_item_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET updated_at = excluded.updated_at`).run(
      conversationId, workItemId, now, now,
    );
    const existing = this.db.prepare('SELECT id FROM conversation_entries WHERE source_key = ?').get(sourceKey);
    if (existing) {
      this.db.prepare(`UPDATE conversation_entries SET status = ?, text = ?, attachments = ?,
        payload = ?, updated_at = ? WHERE id = ?`).run(
        entry.status || 'completed',
        entry.text || '',
        stringify(Array.isArray(entry.attachments) ? entry.attachments : []),
        stringify(entry),
        Number(entry.updatedAt) || Number(entry.createdAt) || now,
        existing.id,
      );
      return existing.id;
    }
    const id = entry.id || durableId('conversation-entry');
    this.db.prepare(`INSERT INTO conversation_entries
      (id, conversation_id, work_item_id, sequence, kind, role, status, text, attachments,
       turn_id, source_key, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      conversationId,
      workItemId,
      this.#nextConversationSequence(conversationId),
      entry.kind || 'message',
      entry.role || null,
      entry.status || 'completed',
      entry.text || '',
      stringify(Array.isArray(entry.attachments) ? entry.attachments : []),
      entry.turnId || null,
      sourceKey,
      stringify(entry),
      Number(entry.createdAt) || now,
      Number(entry.updatedAt) || Number(entry.createdAt) || now,
    );
    return id;
  }

  #appendActionEntry(input, sourceKey) {
    const append = () => {
      const existing = this.db.prepare('SELECT * FROM action_entries WHERE source_key = ?').get(sourceKey);
      if (existing) return existing;
      const now = this.now();
      const status = input.status || 'pending';
      const id = input.id || durableId('action-entry');
      this.db.prepare(`INSERT INTO action_entries
        (id, work_item_id, action_id, run_id, sequence, kind, role, status, text, attachments,
         source_key, payload, created_at, updated_at, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        input.workItemId,
        input.actionId,
        input.runId || null,
        this.#nextActionEntrySequence(input.actionId),
        input.kind || 'message',
        input.role || null,
        status,
        input.text || '',
        stringify(Array.isArray(input.attachments) ? input.attachments : []),
        sourceKey,
        stringify(input.payload || {}),
        Number(input.createdAt) || now,
        now,
        status === 'consumed' ? now : null,
      );
      return this.db.prepare('SELECT * FROM action_entries WHERE id = ?').get(id);
    };
    return this.db.isTransaction ? append() : withTransaction(this.db, append);
  }

  appendActionControl(workItemId, actionId, command, options = {}) {
    if (!['start', 'pause', 'stop'].includes(command)) {
      throw new Error(`Unsupported Action control command: ${command}`);
    }
    const action = this.getAction(actionId);
    if (!action || action.workItemId !== workItemId) return null;
    const sourceKey = options.sourceKey || durableId(`action-control-${command}`);
    return this.#appendActionEntry({
      workItemId,
      actionId,
      runId: options.runId || action.currentRunId || null,
      kind: 'control',
      role: options.source || 'user',
      status: options.status || 'pending',
      text: options.reason || '',
      payload: { command, reason: options.reason || '', source: options.source || 'user' },
      createdAt: options.createdAt,
    }, sourceKey);
  }

  enqueueCoordinatorMailbox(workItemId, kind, payload = {}, sourceKey = durableId('mailbox-source')) {
    const enqueue = () => {
      const existing = this.db.prepare(`SELECT * FROM coordinator_mailbox_entries
        WHERE source_key = ?`).get(sourceKey);
      if (existing) return existing;
      const now = this.now();
      const sequence = Number(this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 AS value
        FROM coordinator_mailbox_entries WHERE work_item_id = ?`).get(workItemId)?.value) || 1;
      const id = durableId('coordinator-mailbox');
      this.db.prepare(`INSERT INTO coordinator_mailbox_entries
        (id, work_item_id, sequence, kind, status, source_key, payload, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(
        id, workItemId, sequence, kind, sourceKey, stringify(payload), now, now,
      );
      return this.db.prepare('SELECT * FROM coordinator_mailbox_entries WHERE id = ?').get(id);
    };
    return this.db.isTransaction ? enqueue() : withTransaction(this.db, enqueue);
  }

  claimCoordinatorTurn(workItemId, turnId, owner, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const row = this.db.prepare(`SELECT * FROM coordinator_mailbox_entries
        WHERE work_item_id = ? AND json_extract(payload, '$.turnId') = ?
        AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))`).get(
        workItemId, turnId, now,
      );
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE coordinator_mailbox_entries SET status = 'claimed',
        claim_owner = ?, claim_epoch = claim_epoch + 1, claimed_at = ?, lease_expires_at = ?,
        updated_at = ? WHERE id = ? AND claim_epoch = ?
        AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))`).run(
        owner, now, now + leaseMs, now, row.id, row.claim_epoch, now,
      );
      if (Number(changed.changes) !== 1) return null;
      const claimed = this.db.prepare('SELECT * FROM coordinator_mailbox_entries WHERE id = ?').get(row.id);
      const providerChanged = this.db.prepare(`UPDATE coordinator_provider_turns SET claim_owner = ?,
        claim_epoch = ?, updated_at = ? WHERE coordinator_turn_id = ?
        AND status IN ('prepared', 'responded')`).run(
        owner, claimed.claim_epoch, now, turnId,
      );
      const providerCount = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM coordinator_provider_turns
        WHERE coordinator_turn_id = ? AND status IN ('prepared', 'responded')`).get(turnId)?.count) || 0;
      if (providerCount !== Number(providerChanged.changes)) {
        throw new Error('Coordinator provider turn cannot transfer an in-flight dispatch');
      }
      return {
        mailboxId: claimed.id,
        ownerBootId: owner,
        claimEpoch: Number(claimed.claim_epoch),
        leaseExpiresAt: Number(claimed.lease_expires_at),
        payload: parseJson(claimed.payload, {}),
      };
    });
  }

  listPendingDynamicCoordinatorWakes() {
    return this.db.prepare(`SELECT c.id, c.work_item_id, c.kind, c.payload, c.source_key
      FROM coordinator_mailbox_entries c
      JOIN work_items w ON w.id = c.work_item_id
      WHERE w.coordination_mode = 'dynamic' AND w.status NOT IN ('done', 'cancelled')
        AND (c.status = 'pending' OR (c.status = 'claimed' AND c.lease_expires_at <= ?))
      ORDER BY c.created_at, c.sequence`).all(this.now()).map(row => ({
      id: row.id,
      workItemId: row.work_item_id,
      kind: row.kind,
      sourceKey: row.source_key,
      payload: parseJson(row.payload, {}),
    }));
  }

  claimCoordinatorMailbox(workItemId, owner, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const row = this.db.prepare(`SELECT * FROM coordinator_mailbox_entries
        WHERE work_item_id = ? AND (status = 'pending'
          OR (status = 'claimed' AND lease_expires_at <= ?))
        ORDER BY sequence LIMIT 1`).get(workItemId, now);
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE coordinator_mailbox_entries SET status = 'claimed',
        claim_owner = ?, claim_epoch = claim_epoch + 1, claimed_at = ?, lease_expires_at = ?,
        updated_at = ? WHERE id = ? AND claim_epoch = ?`).run(
        owner, now, now + leaseMs, now, row.id, row.claim_epoch,
      );
      if (Number(changed.changes) !== 1) return null;
      const claimed = this.db.prepare('SELECT * FROM coordinator_mailbox_entries WHERE id = ?').get(row.id);
      return { ...claimed, payload: parseJson(claimed.payload, {}) };
    });
  }

  releaseCoordinatorMailboxClaim(id, owner, claimEpoch) {
    const now = this.now();
    const changed = this.db.prepare(`UPDATE coordinator_mailbox_entries SET status = 'pending',
      claim_owner = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claim_owner = ? AND claim_epoch = ?`).run(
      now, id, owner, claimEpoch,
    );
    return Number(changed.changes) === 1;
  }

  renewCoordinatorMailbox(id, owner, claimEpoch, leaseMs = 60_000) {
    const now = this.now();
    const changed = this.db.prepare(`UPDATE coordinator_mailbox_entries SET lease_expires_at = ?,
      updated_at = ? WHERE id = ? AND status = 'claimed' AND claim_owner = ? AND claim_epoch = ?
      AND lease_expires_at > ?`).run(now + leaseMs, now, id, owner, claimEpoch, now);
    return Number(changed.changes) === 1;
  }

  ackCoordinatorMailbox(id, owner, claimEpoch) {
    const now = this.now();
    const changed = this.db.prepare(`UPDATE coordinator_mailbox_entries SET status = 'acked',
      acked_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND claim_owner = ?
      AND claim_epoch = ?`).run(now, now, id, owner, claimEpoch);
    return Number(changed.changes) === 1;
  }

  recoverCoordinatorMailbox() {
    const now = this.now();
    return Number(this.db.prepare(`UPDATE coordinator_mailbox_entries SET status = 'pending',
      claim_owner = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'claimed' AND lease_expires_at <= ?`).run(now, now).changes);
  }

  prepareCoordinatorProviderTurn(
    workItemId,
    coordinatorTurnId,
    attemptNumber,
    requestBody,
    claim = {},
    speaker = null,
  ) {
    return withTransaction(this.db, () => {
      const mailbox = this.#activeCoordinatorMailboxClaim(coordinatorTurnId, claim);
      if (!mailbox || mailbox.work_item_id !== workItemId) return null;
      const existing = this.db.prepare(`SELECT * FROM coordinator_provider_turns
        WHERE coordinator_turn_id = ? AND attempt_number = ?`).get(coordinatorTurnId, attemptNumber);
      const requestHash = createHash('sha256').update(stableJson(requestBody), 'utf8').digest('hex');
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new Error('Prepared Coordinator provider request changed before dispatch');
        }
        if (existing.claim_owner !== claim.ownerBootId
            || Number(existing.claim_epoch) !== Number(claim.claimEpoch)) return null;
        const persistedSpeaker = this.#persistCoordinatorSpeaker(
          workItemId, coordinatorTurnId, null,
        );
        return { ...this.#mapCoordinatorProviderTurn(existing), speaker: persistedSpeaker };
      }
      const persistedSpeaker = this.#persistCoordinatorSpeaker(
        workItemId, coordinatorTurnId, speaker,
      );
      const now = this.now();
      const id = durableId('coordinator-provider-turn');
      this.db.prepare(`INSERT INTO coordinator_provider_turns
        (id, work_item_id, coordinator_turn_id, attempt_number, status, request_body, request_hash,
         claim_owner, claim_epoch, prepared_at, updated_at)
        VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)`).run(
        id, workItemId, coordinatorTurnId, attemptNumber, stringify(requestBody), requestHash,
        claim.ownerBootId, claim.claimEpoch, now, now,
      );
      return { ...this.getCoordinatorProviderTurn(id), speaker: persistedSpeaker };
    });
  }

  #persistCoordinatorSpeaker(workItemId, coordinatorTurnId, speaker) {
    const workItem = this.getWorkItem(workItemId);
    if (!workItem) return null;
    const messages = [...(workItem.messages || [])];
    const index = messages.findIndex(message => (
      message?.turnId === coordinatorTurnId
        && message.role === 'assistant'
        && message.status === 'thinking'
    ));
    if (index < 0) return null;
    const persistedSpeaker = messages[index].speaker;
    const persistedId = typeof persistedSpeaker?.id === 'string' ? persistedSpeaker.id.trim() : '';
    const persistedName = typeof persistedSpeaker?.name === 'string'
      ? persistedSpeaker.name.trim()
      : '';
    if (persistedId || persistedName) {
      return { id: persistedId || null, name: persistedName || persistedId };
    }
    const id = typeof speaker?.id === 'string' ? speaker.id.trim() : '';
    const name = typeof speaker?.name === 'string' ? speaker.name.trim() : '';
    if (!id && !name) return null;
    if (!id || !name) throw new Error('Coordinator speaker identity is incomplete');
    const persisted = { id, name };
    messages[index] = { ...messages[index], speaker: persisted };
    const changed = this.db.prepare(`UPDATE work_items SET messages = ?
      WHERE id = ? AND coordinator_revision = ?`).run(
      stringify(messages), workItemId, workItem.coordinatorRevision,
    );
    if (Number(changed.changes) !== 1) {
      throw new Error('Coordinator speaker lost its revision fence');
    }
    this.#appendConversationEntry(
      workItemId,
      messages[index],
      `coordinator:turn:${coordinatorTurnId}:assistant`,
    );
    return persisted;
  }

  #activeCoordinatorMailboxClaim(coordinatorTurnId, claim = {}) {
    if (!claim.mailboxId || !claim.ownerBootId || !Number.isInteger(Number(claim.claimEpoch))) return null;
    return this.db.prepare(`SELECT * FROM coordinator_mailbox_entries WHERE id = ? AND status = 'claimed'
      AND claim_owner = ? AND claim_epoch = ? AND lease_expires_at > ?
      AND json_extract(payload, '$.turnId') = ?`).get(
      claim.mailboxId, claim.ownerBootId, Number(claim.claimEpoch), this.now(), coordinatorTurnId,
    );
  }

  #mapCoordinatorProviderTurn(row) {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      coordinatorTurnId: row.coordinator_turn_id,
      attemptNumber: Number(row.attempt_number),
      status: row.status,
      requestBody: parseJson(row.request_body, {}),
      requestHash: row.request_hash,
      response: parseJson(row.response, null),
      responseHash: row.response_hash || null,
      error: row.error || null,
      claimOwner: row.claim_owner || null,
      claimEpoch: Number(row.claim_epoch) || 0,
    };
  }

  getCoordinatorProviderTurn(id) {
    const row = this.db.prepare('SELECT * FROM coordinator_provider_turns WHERE id = ?').get(id);
    return row ? this.#mapCoordinatorProviderTurn(row) : null;
  }

  dispatchCoordinatorProviderTurn(id, claim = {}) {
    return withTransaction(this.db, () => {
      const existing = this.getCoordinatorProviderTurn(id);
      if (!existing || !this.#activeCoordinatorMailboxClaim(existing.coordinatorTurnId, claim)) return null;
      const now = this.now();
      const changed = this.db.prepare(`UPDATE coordinator_provider_turns SET status = 'dispatching',
        dispatched_at = ?, updated_at = ? WHERE id = ? AND status = 'prepared'
        AND claim_owner = ? AND claim_epoch = ?`).run(
        now, now, id, claim.ownerBootId, Number(claim.claimEpoch),
      );
      return Number(changed.changes) === 1 ? this.getCoordinatorProviderTurn(id) : null;
    });
  }

  respondCoordinatorProviderTurn(id, requestHash, response, claim = {}) {
    return withTransaction(this.db, () => {
      const existing = this.getCoordinatorProviderTurn(id);
      if (!existing || !this.#activeCoordinatorMailboxClaim(existing.coordinatorTurnId, claim)) return null;
      const now = this.now();
      const responseHash = createHash('sha256').update(stableJson(response), 'utf8').digest('hex');
      const changed = this.db.prepare(`UPDATE coordinator_provider_turns SET status = 'responded',
        response = ?, response_hash = ?, responded_at = ?, updated_at = ?
        WHERE id = ? AND status = 'dispatching' AND request_hash = ?
        AND claim_owner = ? AND claim_epoch = ?`).run(
        stringify(response), responseHash, now, now, id, requestHash,
        claim.ownerBootId, Number(claim.claimEpoch),
      );
      return Number(changed.changes) === 1 ? this.getCoordinatorProviderTurn(id) : null;
    });
  }

  rejectCoordinatorProviderTurn(id, error, claim = {}) {
    return withTransaction(this.db, () => {
      const existing = this.getCoordinatorProviderTurn(id);
      if (!existing || !this.#activeCoordinatorMailboxClaim(existing.coordinatorTurnId, claim)) return null;
      const now = this.now();
      const changed = this.db.prepare(`UPDATE coordinator_provider_turns SET status = 'cancelled',
        error = ?, updated_at = ? WHERE id = ? AND status = 'responded'
        AND claim_owner = ? AND claim_epoch = ?`).run(
        String(error?.message || error || 'Coordinator provider response was rejected').slice(0, 8_000),
        now, id, claim.ownerBootId, Number(claim.claimEpoch),
      );
      return Number(changed.changes) === 1 ? this.getCoordinatorProviderTurn(id) : null;
    });
  }

  recoverCoordinatorProviderTurns() {
    const now = this.now();
    return Number(this.db.prepare(`UPDATE coordinator_provider_turns SET status = 'unknown',
      error = 'Coordinator provider dispatch outcome is unknown after Agent restart', updated_at = ?
      WHERE status = 'dispatching' AND NOT EXISTS (
        SELECT 1 FROM coordinator_mailbox_entries mailbox
        WHERE json_extract(mailbox.payload, '$.turnId') = coordinator_provider_turns.coordinator_turn_id
          AND mailbox.status = 'claimed' AND mailbox.claim_owner = coordinator_provider_turns.claim_owner
          AND mailbox.claim_epoch = coordinator_provider_turns.claim_epoch
          AND mailbox.lease_expires_at > ?
      )`).run(now, now).changes);
  }

  createOperation(input = {}) {
    const replayPolicy = input.replayPolicy || 'never_automatic';
    if (!input.idempotencyKey) throw new Error('Operation idempotencyKey is required');
    if (!['safe', 'probe_first', 'never_automatic'].includes(replayPolicy)) {
      throw new Error(`Unsupported Operation replay policy: ${replayPolicy}`);
    }
    const now = this.now();
    const id = input.id || durableId('operation');
    this.db.prepare(`INSERT INTO operations
      (id, work_item_id, action_id, run_id, engine_turn_id, operation_type, idempotency_key,
       replay_policy, effect_status, execution_status, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING`).run(
      id, input.workItemId, input.actionId || null, input.runId || null, input.engineTurnId || null,
      input.operationType || 'unknown', input.idempotencyKey, replayPolicy,
      input.effectStatus || 'pending', input.executionStatus || 'not_started',
      stringify(input.payload || {}), now, now,
    );
    return this.getOperationByKey(input.idempotencyKey);
  }

  getOperation(id) {
    const row = this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
    return row ? this.#mapOperation(row) : null;
  }

  getOperationByKey(idempotencyKey) {
    const row = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(idempotencyKey);
    return row ? this.#mapOperation(row) : null;
  }

  #mapOperation(row) {
    return {
      id: row.id,
      workItemId: row.work_item_id,
      actionId: row.action_id || null,
      runId: row.run_id || null,
      engineTurnId: row.engine_turn_id || null,
      operationType: row.operation_type,
      idempotencyKey: row.idempotency_key,
      replayPolicy: row.replay_policy,
      concurrencyPolicy: row.concurrency_policy,
      effectStatus: row.effect_status,
      executionStatus: row.execution_status,
      effectCutoff: parseJson(row.effect_cutoff, null),
      grantManifest: parseJson(row.grant_manifest, {}),
      resourceRelease: parseJson(row.resource_release, {}),
      supplementalInventory: parseJson(row.supplemental_inventory, {}),
      payload: parseJson(row.payload, {}),
      result: parseJson(row.result, null),
    };
  }

  operationSafeToProceed(operationOrKey) {
    const operation = typeof operationOrKey === 'string'
      ? this.getOperationByKey(operationOrKey) : operationOrKey;
    if (!operation) return false;
    const effectSafe = ['applied', 'not_applied', 'failed_no_effect'].includes(operation.effectStatus);
    const executionSafe = ['not_started', 'quiescent'].includes(operation.executionStatus)
      || (operation.executionStatus === 'fenced' && operation.effectCutoff?.status === 'current');
    const manifest = operation.grantManifest || {};
    const grantSafe = manifest.status === 'closed' && manifest.safetyStatus === 'current'
      && manifest.inventoryComplete === true
      && (manifest.pendingGrantAttemptIds || []).length === 0
      && (manifest.authorityClosures || []).every(closure => closure.status === 'closed');
    const release = operation.resourceRelease || {};
    const resourcesSafe = release.status === 'released'
      && (release.leases || []).every(lease => ['released', 'expired'].includes(lease.status));
    const supplemental = operation.supplementalInventory || {};
    const supplementalSafe = ['clear', 'resolved'].includes(supplemental.status || 'clear');
    return effectSafe && executionSafe && grantSafe && resourcesSafe && supplementalSafe;
  }

  #hasBlockingOperation(workItemId, actionId = null) {
    const rows = this.db.prepare(`SELECT idempotency_key FROM operations
      WHERE work_item_id = ? AND concurrency_policy = 'blocking' AND operation_type != 'Bash'
        AND (? IS NULL OR action_id IS NULL OR action_id = ?)`)
      .all(workItemId, actionId, actionId);
    return rows.some(row => !this.operationSafeToProceed(row.idempotency_key));
  }

  createAndClaimOperation(input = {}, ownerBootId, leaseEpoch, automatic = true) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(input.runId, ownerBootId, leaseEpoch, true);
      if (!active || active.work_item_id !== input.workItemId || active.action_id !== input.actionId) return null;
      const operation = this.createOperation(input);
      if (!operation
          || operation.workItemId !== input.workItemId
          || operation.actionId !== input.actionId
          || operation.runId !== input.runId
          || operation.operationType !== (input.operationType || 'unknown')
          || operation.executionStatus !== 'not_started') return null;
      if (automatic && operation.replayPolicy !== 'safe') return null;
      const now = this.now();
      const changed = this.db.prepare(`UPDATE operations SET execution_status = 'running',
        execution_epoch = execution_epoch + 1, owner_boot_id = ?, owner_lease_epoch = ?,
        claimed_at = ?, updated_at = ? WHERE idempotency_key = ? AND execution_status = 'not_started'
        AND work_item_id = ? AND action_id = ? AND run_id = ?`).run(
        ownerBootId, leaseEpoch, now, now, input.idempotencyKey,
        input.workItemId, input.actionId, input.runId,
      );
      return Number(changed.changes) === 1 ? this.getOperationByKey(input.idempotencyKey) : null;
    });
  }

  claimOperation(idempotencyKey, ownerBootId, leaseEpoch, automatic = true) {
    return withTransaction(this.db, () => {
      const operation = this.getOperationByKey(idempotencyKey);
      if (!operation || operation.executionStatus !== 'not_started') return null;
      if (!this.#activeRunRow(operation.runId, ownerBootId, leaseEpoch, true)) return null;
      if (automatic && operation.replayPolicy !== 'safe') return null;
      const now = this.now();
      const changed = this.db.prepare(`UPDATE operations SET execution_status = 'running',
        execution_epoch = execution_epoch + 1, owner_boot_id = ?, owner_lease_epoch = ?,
        claimed_at = ?, updated_at = ? WHERE idempotency_key = ? AND execution_status = 'not_started'
        AND run_id = ?`).run(
        ownerBootId, leaseEpoch, now, now, idempotencyKey, operation.runId,
      );
      return Number(changed.changes) === 1 ? this.getOperationByKey(idempotencyKey) : null;
    });
  }

  completeOperation(idempotencyKey, ownerBootId, leaseEpoch, effectStatus, result = null) {
    if (!['applied', 'not_applied', 'failed_no_effect', 'unknown'].includes(effectStatus)) return false;
    return withTransaction(this.db, () => {
      const operation = this.getOperationByKey(idempotencyKey);
      if (!operation || operation.executionStatus !== 'running'
          || operation.payload == null) return false;
      const ownerMatches = this.db.prepare(`SELECT 1 AS present FROM operations
        WHERE idempotency_key = ? AND execution_status = 'running'
          AND owner_boot_id = ? AND owner_lease_epoch = ?`).get(
        idempotencyKey, ownerBootId, leaseEpoch,
      );
      if (!ownerMatches) return false;
      const now = this.now();
      const active = this.#activeRunRow(operation.runId, ownerBootId, leaseEpoch, true);
      if (!active || active.work_item_id !== operation.workItemId
          || active.action_id !== operation.actionId) {
        const settled = operation.operationType === 'Bash'
          && ['applied', 'not_applied', 'failed_no_effect'].includes(effectStatus);
        this.db.prepare(`UPDATE operations SET effect_status = ?,
          execution_status = ?, effect_cutoff = ?, result = ?, completed_at = ?,
          updated_at = ? WHERE idempotency_key = ? AND execution_status = 'running'
          AND owner_boot_id = ? AND owner_lease_epoch = ?`).run(
          settled ? effectStatus : 'unknown',
          settled ? 'quiescent' : 'hazardous_orphan',
          stringify({
            status: settled ? 'current' : 'stale',
            closureType: settled ? 'late_settled_completion' : 'late_completion',
            closedAt: now,
          }),
          stringify({ attemptedEffectStatus: effectStatus, reportedResult: result }),
          now, now, idempotencyKey, ownerBootId, leaseEpoch,
        );
        return false;
      }
      const changed = this.db.prepare(`UPDATE operations SET effect_status = ?, execution_status = ?,
        effect_cutoff = ?, result = ?, completed_at = ?, updated_at = ? WHERE idempotency_key = ?
        AND execution_status = 'running' AND owner_boot_id = ? AND owner_lease_epoch = ?`).run(
        effectStatus,
        'quiescent',
        stringify({ status: 'current', closureType: 'quiescent', closedAt: now }),
        stringify(result), now, now, idempotencyKey, ownerBootId, leaseEpoch,
      );
      return Number(changed.changes) === 1;
    });
  }

  recoverOperations() {
    return withTransaction(this.db, () => {
      const now = this.now();
      const reconciled = this.db.prepare(`UPDATE operations SET
        effect_status = json_extract(result, '$.attemptedEffectStatus'),
        execution_status = 'quiescent', effect_cutoff = ?, completed_at = COALESCE(completed_at, ?),
        updated_at = ? WHERE operation_type = 'Bash'
        AND execution_status = 'hazardous_orphan' AND effect_status = 'unknown'
        AND json_extract(result, '$.attemptedEffectStatus') IN
          ('applied', 'not_applied', 'failed_no_effect')`).run(
        stringify({
          status: 'current', closureType: 'recovered_late_settled_completion', closedAt: now,
        }),
        now,
        now,
      );
      const unstarted = this.db.prepare(`UPDATE operations SET effect_status = 'failed_no_effect',
        execution_status = 'quiescent', effect_cutoff = ?, result = ?, completed_at = ?, updated_at = ?
        WHERE effect_status = 'pending' AND execution_status = 'not_started'`).run(
        stringify({ status: 'current', closureType: 'recovered_before_dispatch', closedAt: now }),
        stringify({ recovered: true, reason: 'Operation was never claimed before restart' }),
        now, now,
      );
      const hazardous = this.db.prepare(`UPDATE operations SET execution_status = 'hazardous_orphan',
        effect_status = CASE WHEN effect_status = 'pending' THEN 'unknown' ELSE effect_status END,
        effect_cutoff = ?, updated_at = ? WHERE execution_status IN ('running', 'cancel_requested')`).run(
        stringify({ status: 'stale', closureType: 'restart_unknown', closedAt: now }), now,
      );
      return Number(reconciled.changes) + Number(unstarted.changes) + Number(hazardous.changes);
    });
  }

  appendEvent(workItemId, type, data = {}, refs = {}) {
    const actionGeneration = refs.actionGeneration
      ?? (refs.actionId ? this.getAction(refs.actionId)?.generation : null)
      ?? null;
    const result = this.db.prepare(`INSERT INTO events
      (work_item_id, action_id, run_id, action_generation, type, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      workItemId,
      refs.actionId || null,
      refs.runId || null,
      actionGeneration,
      type,
      stringify(data),
      this.now(),
    );
    return Number(result.lastInsertRowid);
  }

  getCoordinatorClientMessageReceipt(workItemId, clientMessageId) {
    if (typeof clientMessageId !== 'string' || !clientMessageId) return null;
    const sourceKey = `client:message:${workItemId}:${clientMessageId}`;
    const actionReceipt = this.db.prepare('SELECT action_id FROM action_entries WHERE source_key = ?')
      .get(sourceKey);
    if (actionReceipt) throw new Error('clientMessageId already belongs to an Action message');
    const row = this.db.prepare(`SELECT payload FROM coordinator_mailbox_entries
      WHERE work_item_id = ? AND source_key = ?`).get(workItemId, sourceKey);
    return row ? parseJson(row.payload, {}) : null;
  }

  hasActionInputClientMessage(workItemId, actionId, clientMessageId) {
    if (typeof clientMessageId !== 'string' || !clientMessageId) return false;
    const sourceKey = `client:message:${workItemId}:${clientMessageId}`;
    const coordinatorReceipt = this.db.prepare(`SELECT 1 FROM coordinator_mailbox_entries
      WHERE source_key = ?`).get(sourceKey);
    if (coordinatorReceipt) throw new Error('clientMessageId already belongs to a Coordinator message');
    const entry = this.db.prepare('SELECT action_id FROM action_entries WHERE source_key = ?').get(sourceKey)
      || this.db.prepare(`SELECT action_id FROM events WHERE work_item_id = ?
        AND type = 'action.input_added' AND json_extract(data, '$.clientMessageId') = ?`).get(
        workItemId, clientMessageId,
      );
    if (!entry) return false;
    if (entry.action_id !== actionId) throw new Error('clientMessageId already belongs to another Action');
    return true;
  }

  addActionInput(id, input, expected, attachments = null, addedAttachments = [], clientMessageId = null, quote = null) {
    return withTransaction(this.db, () => {
      const sourceKey = typeof clientMessageId === 'string' && clientMessageId
        ? `client:message:${id}:${clientMessageId}` : null;
      if (sourceKey) {
        const existing = this.db.prepare('SELECT id FROM action_entries WHERE source_key = ?').get(sourceKey);
        if (existing) return this.getWorkItemDetail(id);
      }
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      const expectedGeneration = Number(expected.generation);
      if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
        throw new Error('Action input generation must be a positive integer');
      }
      const concurrentMode = usesLegacyGraph(workItem) || isDynamicWorkItem(workItem);
      const inputStatuses = concurrentMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['ready', 'running'];
      if (!inputStatuses.includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} cannot accept Action input`);
      }
      const action = this.getAction(expected.actionId);
      const actionMatches = action?.workItemId === id
        && action.generation === expectedGeneration
        && ['ready', 'running'].includes(action.status)
        && (concurrentMode || action.id === workItem.currentActionId);
      const activeRun = action?.currentRunId ? this.getRun(action.currentRunId) : null;
      const runMatches = action?.status !== 'running'
        || (activeRun?.status === 'running' && activeRun.acceptingInput !== false
          && runMatchesActionIdentity(activeRun, action));
      if (!actionMatches || !runMatches || workItem.revision !== expected.revision) {
        throw new Error('Action changed before input was applied; refresh and try again');
      }
      const projectedAttachments = (Array.isArray(addedAttachments) ? addedAttachments : []).map(attachment => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: Math.max(0, Number(attachment.size) || 0),
        isImage: attachment.isImage === true,
      }));
      if (action.status === 'running' && projectedAttachments.length > 0) {
        throw new Error('Files cannot be added while an Action is running');
      }
      const now = this.now();
      const inputId = randomUUID();
      let eventGeneration = action.generation;
      let eventSpecHash = action.specHash;
      let eventRunId = action.currentRunId;
      if (action.status === 'ready') {
        const inheritedPendingInputs = this.db.prepare(`SELECT p.* FROM pending_action_inputs p
          LEFT JOIN runs source_run ON source_run.id = p.run_id
          WHERE p.action_id = ? AND p.action_generation = ? AND p.action_spec_hash = ?
            AND p.consumed_at IS NULL AND p.superseded_at IS NULL
            AND (p.run_id IS NULL OR source_run.status != 'running') ORDER BY p.event_id`).all(
          action.id, action.generation, action.specHash,
        );
        const nextGeneration = action.generation + 1;
        const context = carryCurrentActionInputContext(this.db, action);
        context.push({
          type: 'input',
          role: 'user',
          inputId,
          summary: input,
          quote,
          attachments: projectedAttachments,
          evidence: [],
        });
        const nextAction = { ...action, context, generation: nextGeneration };
        nextAction.instruction = canonicalActionInstruction(workItem, nextAction, context);
        nextAction.specHash = actionSpecHash(nextAction);
        const changedAction = this.db.prepare(`UPDATE actions SET context = ?, instruction = ?, attempt = 0,
          generation = generation + 1, spec_hash = ?, identity_history = ?, result_run_id = NULL,
          workspace = NULL, updated_at = ? WHERE id = ? AND status = 'ready' AND current_run_id IS NULL
          AND generation = ? AND spec_hash = ?`).run(
          stringify(context),
          nextAction.instruction,
          nextAction.specHash,
          stringify(actionIdentityHistory(action, nextAction.generation, nextAction.specHash)),
          now,
          action.id,
          action.generation,
          action.specHash,
        );
        if (Number(changedAction.changes) !== 1) {
          throw new Error('Action changed before input was applied; refresh and try again');
        }
        this.#supersedePendingActionInputs(
          [action],
          'Action spec changed after ready input',
          now,
          inheritedPendingInputs.map(row => row.event_id),
        );
        this.#rebindPendingActionInputs(action, inheritedPendingInputs, {
          runId: null,
          generation: nextAction.generation,
          specHash: nextAction.specHash,
        }, 'ready_action_input', now);
        eventGeneration = nextAction.generation;
        eventSpecHash = nextAction.specHash;
        eventRunId = null;
      }
      const revision = workItem.revision + 1;
      const changedWorkItem = this.db.prepare(`UPDATE work_items SET attachments = ?, revision = ?, updated_at = ?
        WHERE id = ? AND revision = ?`).run(
        stringify(Array.isArray(attachments) ? attachments : workItem.attachments),
        revision,
        now,
        id,
        workItem.revision,
      );
      if (Number(changedWorkItem.changes) !== 1) {
        throw new Error('Action changed before input was applied; refresh and try again');
      }
      const eventId = this.appendEvent(id, 'action.input_added', {
        inputId,
        clientMessageId,
        text: input,
        quote,
        attachments: projectedAttachments,
      }, { actionId: action.id, runId: eventRunId, actionGeneration: eventGeneration });
      if (action.status === 'running') {
        this.db.prepare(`INSERT INTO pending_action_inputs
          (event_id, work_item_id, action_id, run_id, action_generation, action_spec_hash,
           text, attachments, consumed_at, superseded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
          eventId,
          id,
          action.id,
          action.currentRunId,
          eventGeneration,
          eventSpecHash,
          input,
          stringify(projectedAttachments),
        );
        this.#appendActionEntry({
          workItemId: id,
          actionId: action.id,
          runId: action.currentRunId,
          kind: 'message',
          role: 'user',
          status: 'pending',
          text: input,
          attachments: projectedAttachments,
          payload: { eventId, inputId, quote, actionGeneration: eventGeneration, actionSpecHash: eventSpecHash },
          createdAt: now,
        }, sourceKey || `pending_action_inputs:event:${eventId}`);
      } else if (sourceKey) {
        this.#appendActionEntry({
          workItemId: id,
          actionId: action.id,
          runId: null,
          kind: 'message',
          role: 'user',
          status: 'consumed',
          text: input,
          attachments: projectedAttachments,
          payload: { eventId, inputId, quote, actionGeneration: eventGeneration, actionSpecHash: eventSpecHash },
          createdAt: now,
        }, sourceKey);
      }
      return this.getWorkItemDetail(id);
    });
  }

  listPendingActionInputs(actionId, runId, ownerBootId, leaseEpoch) {
    const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
    if (!active || active.action_id !== actionId) return [];
    return this.db.prepare(`SELECT p.*, ae.id AS action_entry_id, ae.sequence AS action_entry_sequence,
      ae.payload AS action_entry_payload FROM pending_action_inputs p
      LEFT JOIN action_entries ae ON CAST(json_extract(ae.payload, '$.eventId') AS INTEGER) = p.event_id
        AND ae.action_id = p.action_id
      WHERE p.action_id = ? AND p.run_id = ? AND p.action_generation = ? AND p.action_spec_hash = ?
        AND p.consumed_at IS NULL AND p.superseded_at IS NULL ORDER BY p.event_id`).all(
      actionId, runId, active.action_generation, active.action_spec_hash,
    ).map(row => ({
      id: String(row.event_id),
      actionEntryId: row.action_entry_id || null,
      sequence: row.action_entry_sequence == null ? null : Number(row.action_entry_sequence),
      text: row.text || '',
      quote: parseJson(row.action_entry_payload, null)?.quote || null,
      attachments: parseJson(row.attachments, []),
    }));
  }

  prepareEngineTurn(actionId, runId, ownerBootId, leaseEpoch, inputs = [], request = {}) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return null;
      const eventIds = inputs.map(input => Number(input?.id ?? input)).filter(Number.isInteger);
      const normalizedEventIds = [...new Set(eventIds)].sort((left, right) => left - right);
      const reusable = this.db.prepare(`SELECT id FROM engine_turns
        WHERE run_id = ? AND status = 'prepared' ORDER BY ordinal DESC LIMIT 1`).get(runId);
      if (reusable) {
        const turn = this.getEngineTurn(reusable.id);
        const requestBody = request.requestBody && typeof request.requestBody === 'object'
          ? request.requestBody : {};
        const requestHash = createHash('sha256').update(stableJson(requestBody), 'utf8').digest('hex');
        if (turn.requestHash !== requestHash) {
          throw new Error('Prepared EngineTurn request changed before provider dispatch');
        }
        return turn;
      }
      const entries = [];
      for (const eventId of normalizedEventIds) {
        const row = this.db.prepare(`SELECT p.*, ae.id AS action_entry_id,
          ae.sequence AS action_entry_sequence FROM pending_action_inputs p
          JOIN action_entries ae ON CAST(json_extract(ae.payload, '$.eventId') AS INTEGER) = p.event_id
            AND ae.action_id = p.action_id
          WHERE p.event_id = ? AND p.action_id = ? AND p.run_id = ? AND p.action_generation = ?
            AND p.action_spec_hash = ? AND p.consumed_at IS NULL AND p.superseded_at IS NULL
            AND ae.status = 'pending' AND ae.engine_turn_id IS NULL`).get(
          eventId, actionId, runId, active.action_generation, active.action_spec_hash,
        );
        if (row) entries.push(row);
      }
      if (entries.length !== normalizedEventIds.length) return null;
      const requestBody = request.requestBody && typeof request.requestBody === 'object'
        ? request.requestBody
        : { actionEntryIds: entries.map(row => row.action_entry_id) };
      const requestHash = createHash('sha256').update(stableJson(requestBody), 'utf8').digest('hex');
      const ordinal = Number(this.db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS value
        FROM engine_turns WHERE run_id = ?`).get(runId)?.value) || 1;
      const turnId = durableId('engine-turn');
      const requestKey = `run:${runId}:turn:${ordinal}`;
      const claimedThroughSequence = Math.max(
        0,
        ...entries.map(row => Number(row.action_entry_sequence) || 0),
      );
      const entryIds = entries.map(row => row.action_entry_id);
      const now = this.now();
      this.db.prepare(`INSERT INTO engine_turns
        (id, work_item_id, action_id, run_id, ordinal, status, owner_boot_id, lease_epoch,
         input_entry_ids, message_entry_ids, claimed_through_sequence, request_body, request_hash,
         request_key, dispatch_capability, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        turnId, active.work_item_id, actionId, runId, ordinal, ownerBootId, leaseEpoch,
        stringify(entryIds), stringify(entryIds), claimedThroughSequence, stringify(requestBody),
        requestHash, requestKey, request.dispatchCapability || 'unknown', now, now,
      );
      const bind = this.db.prepare(`UPDATE action_entries SET status = 'bound', engine_turn_id = ?,
        run_id = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND engine_turn_id IS NULL`);
      for (const row of entries) {
        const changed = bind.run(turnId, runId, now, row.action_entry_id);
        if (Number(changed.changes) !== 1) throw new Error('ActionEntry changed before EngineTurn prepare');
      }
      this.appendEvent(active.work_item_id, 'engine_turn.prepared', {
        turnId, ordinal, requestHash, actionEntryIds: entryIds,
      }, { actionId, runId });
      return this.getEngineTurn(turnId);
    });
  }

  getEngineTurn(turnId) {
    const row = this.db.prepare('SELECT * FROM engine_turns WHERE id = ?').get(turnId);
    if (!row) return null;
    return {
      id: row.id,
      workItemId: row.work_item_id,
      actionId: row.action_id,
      runId: row.run_id,
      ordinal: Number(row.ordinal),
      status: row.status,
      ownerBootId: row.owner_boot_id,
      leaseEpoch: Number(row.lease_epoch),
      inputEntryIds: parseJson(row.input_entry_ids, []),
      requestBody: parseJson(row.request_body, {}),
      requestHash: row.request_hash,
      requestKey: row.request_key,
      dispatchAttempt: Number(row.dispatch_attempt) || 0,
      dispatchCapability: row.dispatch_capability || 'unknown',
      claimedAt: row.claimed_at || null,
      dispatchedAt: row.dispatched_at || null,
      response: parseJson(row.response, null),
      responseHash: row.response_hash || null,
      consumedAt: row.consumed_at || null,
      error: row.error || null,
    };
  }

  claimEngineTurn(turnId, ownerBootId, leaseEpoch) {
    return withTransaction(this.db, () => {
      const turn = this.getEngineTurn(turnId);
      if (!turn || turn.ownerBootId !== ownerBootId || turn.leaseEpoch !== leaseEpoch) return null;
      if (!this.#activeRunRow(turn.runId, ownerBootId, leaseEpoch, true)) return null;
      if (turn.status === 'dispatching') return turn;
      if (turn.status !== 'prepared') return null;
      const now = this.now();
      const changed = this.db.prepare(`UPDATE engine_turns SET status = 'dispatching',
        dispatch_attempt = dispatch_attempt + 1, claimed_at = COALESCE(claimed_at, ?),
        dispatched_at = ?, updated_at = ? WHERE id = ? AND status = 'prepared'`).run(
        now, now, now, turnId,
      );
      if (Number(changed.changes) !== 1) return null;
      this.appendEvent(turn.workItemId, 'engine_turn.dispatching', {
        turnId, requestHash: turn.requestHash, dispatchAttempt: turn.dispatchAttempt + 1,
      }, { actionId: turn.actionId, runId: turn.runId });
      return this.getEngineTurn(turnId);
    });
  }

  consumeEngineTurn(turnId, ownerBootId, leaseEpoch, result = {}) {
    return withTransaction(this.db, () => {
      const turn = this.getEngineTurn(turnId);
      if (!turn || turn.status !== 'dispatching' || turn.ownerBootId !== ownerBootId
          || turn.leaseEpoch !== leaseEpoch) return false;
      if (!this.#activeRunRow(turn.runId, ownerBootId, leaseEpoch, true)) return false;
      const now = this.now();
      const response = {
        text: String(result.responseText || ''),
        stopReason: result.stopReason || null,
        toolCalls: Array.isArray(result.toolCalls) ? result.toolCalls : [],
        thinkingBlocks: Array.isArray(result.thinkingBlocks) ? result.thinkingBlocks : [],
      };
      const responseHash = createHash('sha256').update(stableJson(response), 'utf8').digest('hex');
      const consumed = this.db.prepare(`UPDATE engine_turns SET status = 'responded', response = ?,
        response_hash = ?, responded_at = ?, consumed_at = ?,
        consumed_through_sequence = claimed_through_sequence, updated_at = ?
        WHERE id = ? AND status = 'dispatching' AND dispatch_attempt = ? AND request_hash = ?`).run(
        stringify(response), responseHash, now, now, now, turnId, turn.dispatchAttempt, turn.requestHash,
      );
      if (Number(consumed.changes) !== 1) return false;
      this.db.prepare(`UPDATE action_entries SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE engine_turn_id = ? AND status = 'bound'`).run(now, now, turnId);
      const eventIds = this.db.prepare(`SELECT CAST(json_extract(payload, '$.eventId') AS INTEGER) AS event_id
        FROM action_entries WHERE engine_turn_id = ? AND json_extract(payload, '$.eventId') IS NOT NULL`)
        .all(turnId).map(row => row.event_id);
      const acknowledge = this.db.prepare(`UPDATE pending_action_inputs SET consumed_at = ?
        WHERE event_id = ? AND action_id = ? AND run_id = ? AND consumed_at IS NULL AND superseded_at IS NULL`);
      for (const eventId of eventIds) acknowledge.run(now, eventId, turn.actionId, turn.runId);
      this.appendEvent(turn.workItemId, 'engine_turn.responded', {
        turnId, requestHash: turn.requestHash, responseHash, dispatchAttempt: turn.dispatchAttempt,
      }, { actionId: turn.actionId, runId: turn.runId });
      return true;
    });
  }

  failEngineTurn(turnId, ownerBootId, leaseEpoch, error) {
    return withTransaction(this.db, () => {
      const turn = this.getEngineTurn(turnId);
      if (!turn || turn.ownerBootId !== ownerBootId || turn.leaseEpoch !== leaseEpoch
          || !this.#activeRunRow(turn.runId, ownerBootId, leaseEpoch, true)) {
        return { allowRetry: false, status: 'stale' };
      }
      if (turn.status === 'prepared') return { allowRetry: true, status: 'prepared' };
      if (turn.status !== 'dispatching') return { allowRetry: false, status: turn.status };
      const now = this.now();
      const message = String(error?.message || error || 'Provider dispatch failed').slice(0, 8_000);
      const changed = this.db.prepare(`UPDATE engine_turns SET status = 'unknown', error = ?,
        updated_at = ? WHERE id = ? AND status = 'dispatching' AND dispatch_attempt = ?`).run(
        message, now, turnId, turn.dispatchAttempt,
      );
      if (Number(changed.changes) !== 1) return { allowRetry: false, status: 'stale' };
      this.db.prepare(`UPDATE runs SET status = 'dispatch_unknown', accepting_input = 0,
        ended_at = ?, error = ? WHERE id = ? AND status = 'running'
        AND owner_boot_id = ? AND lease_epoch = ?`).run(
        now, message, turn.runId, ownerBootId, leaseEpoch,
      );
      this.db.prepare(`UPDATE actions SET status = 'failed', current_run_id = NULL,
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ?
        AND lease_epoch = ?`).run(now, turn.actionId, turn.runId, leaseEpoch);
      this.db.prepare(`UPDATE work_items SET status = 'needs_attention', current_action_id = ?,
        current_run_id = NULL, updated_at = ? WHERE id = ? AND status = 'running'`).run(
        turn.actionId, now, turn.workItemId,
      );
      this.appendEvent(turn.workItemId, 'engine_turn.dispatch_unknown', {
        turnId, requestHash: turn.requestHash, dispatchAttempt: turn.dispatchAttempt, error: message,
      }, { actionId: turn.actionId, runId: turn.runId });
      return { allowRetry: false, status: 'unknown' };
    });
  }

  recoverEngineTurns() {
    return withTransaction(this.db, () => {
      const now = this.now();
      const recoverable = this.db.prepare(`SELECT id FROM engine_turns WHERE status = 'prepared'`).all();
      const dispatching = this.db.prepare(`SELECT * FROM engine_turns WHERE status = 'dispatching'`).all();
      for (const row of dispatching) {
        const turn = this.getEngineTurn(row.id);
        const message = 'Provider dispatch outcome is unknown after Agent restart';
        this.db.prepare(`UPDATE engine_turns SET status = 'unknown', error = ?, updated_at = ?
          WHERE id = ? AND status = 'dispatching'`).run(message, now, turn.id);
        this.db.prepare(`UPDATE runs SET status = 'dispatch_unknown', accepting_input = 0,
          ended_at = ?, error = ? WHERE id = ? AND status = 'running'`).run(now, message, turn.runId);
        this.db.prepare(`UPDATE actions SET status = 'failed', current_run_id = NULL,
          updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ?`).run(
          now, turn.actionId, turn.runId,
        );
        this.db.prepare(`UPDATE work_items SET status = 'needs_attention', current_action_id = ?,
          current_run_id = NULL, updated_at = ? WHERE id = ? AND status = 'running'`).run(
          turn.actionId, now, turn.workItemId,
        );
        this.appendEvent(turn.workItemId, 'engine_turn.dispatch_unknown', {
          turnId: turn.id, requestHash: turn.requestHash,
          dispatchAttempt: turn.dispatchAttempt, error: message,
        }, { actionId: turn.actionId, runId: turn.runId });
      }
      return recoverable.map(row => this.getEngineTurn(row.id));
    });
  }

  acknowledgeActionInput(eventId, actionId, runId, ownerBootId, leaseEpoch) {
    const prepared = this.prepareEngineTurn(actionId, runId, ownerBootId, leaseEpoch, [eventId]);
    if (!prepared) return false;
    const claimed = this.claimEngineTurn(prepared.id, ownerBootId, leaseEpoch);
    return !!claimed && this.consumeEngineTurn(prepared.id, ownerBootId, leaseEpoch, {
      responseText: '', stopReason: 'legacy_acknowledge',
    });
  }

  appendRunLoop(runId, ownerBootId, leaseEpoch, loop = {}) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return null;
      const response = normalizeRunResponse(loop.response).trim();
      if (response) {
        this.appendEvent(active.work_item_id, 'run.loop_output', {
          loopNumber: Math.max(0, Number(loop.loopNumber) || 0),
          response,
          stopReason: loop.stopReason || null,
        }, { actionId: active.action_id, runId });
      }
      return this.getWorkItemDetail(active.work_item_id);
    });
  }

  createPlanConflict(workItemId, input = {}) {
    const id = input.id || randomUUID();
    const now = this.now();
    this.db.prepare(`INSERT INTO plan_conflicts
      (id, work_item_id, action_id, generation, kind, status, details, created_at, updated_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`).run(
      id,
      workItemId,
      input.actionId || null,
      Number.isInteger(input.generation) && input.generation > 0 ? input.generation : 1,
      input.kind || 'plan',
      stringify(input.details || {}),
      now,
      now,
    );
    return this.getPlanConflict(id);
  }

  getPlanConflict(id) {
    return mapPlanConflict(this.db.prepare('SELECT * FROM plan_conflicts WHERE id = ?').get(id));
  }

  listPlanConflicts(workItemId, options = {}) {
    const status = typeof options.status === 'string' && options.status ? options.status : null;
    return this.db.prepare(`SELECT * FROM plan_conflicts WHERE work_item_id = ?
      AND (? IS NULL OR status = ?) ORDER BY created_at, id`).all(workItemId, status, status).map(mapPlanConflict);
  }

  resolvePlanConflict(id, details = null) {
    const now = this.now();
    const changed = details && typeof details === 'object'
      ? this.db.prepare(`UPDATE plan_conflicts SET status = 'resolved', details = ?,
          updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'open'`).run(stringify(details), now, now, id)
      : this.db.prepare(`UPDATE plan_conflicts SET status = 'resolved',
          updated_at = ?, resolved_at = ? WHERE id = ? AND status = 'open'`).run(now, now, id);
    return Number(changed.changes) === 1 ? this.getPlanConflict(id) : null;
  }

  deletePlanConflict(id) {
    return Number(this.db.prepare('DELETE FROM plan_conflicts WHERE id = ?').run(id).changes) === 1;
  }

  createWorkItem(input, firstAction) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const id = input.id || randomUUID();
      const workspaceKey = canonicalWorkspaceKey(input.workDir);
      this.db.prepare(`INSERT INTO work_items
        (id, revision, execution_schema_version, ledger_revision, coordination_mode, final_result, delivery_target,
         title, goal, acceptance_criteria, workflow_template, workflow_snapshot, status,
         current_action_id, current_run_id, work_dir, workspace_key, reuse_memory, origin, linked_session_ids,
         session_context, attachments, created_at, updated_at)
        VALUES (?, 1, ?, 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        Number.isInteger(input.executionSchemaVersion) ? input.executionSchemaVersion : 2,
        input.coordinationMode || 'legacy',
        input.deliveryTarget || null,
        input.title,
        input.goal,
        stringify(input.acceptanceCriteria || []),
        input.workflowTemplate || 'software-change',
        stringify(input.workflowSnapshot || null),
        firstAction ? 'ready' : 'draft',
        input.workDir || '',
        workspaceKey,
        input.reuseMemory === false ? 0 : 1,
        stringify(input.origin || null),
        stringify(input.linkedSessionIds || []),
        stringify(input.sessionContext || []),
        stringify(input.attachments || []),
        now,
        now,
      );
      let action = null;
      if (firstAction) {
        action = this.#insertAction(id, { ...firstAction, contractRevision: 1 }, 1, now);
        this.db.prepare('UPDATE work_items SET current_action_id = ? WHERE id = ?').run(action.id, id);
      }
      this.appendEvent(id, 'work_item.created', { status: firstAction ? 'ready' : 'draft' }, { actionId: action?.id });
      return this.getWorkItem(id);
    });
  }

  #insertAction(workItemId, input, sequence, now = this.now(), options = {}) {
    const workItem = this.getWorkItem(workItemId);
    const stageId = input.stageId || input.type;
    const activeStage = usesLegacyGraph(workItem)
      ? this.db.prepare(`SELECT id FROM actions WHERE work_item_id = ? AND stage_id = ?
          AND status NOT IN ('superseded', 'cancelled') LIMIT 1`).get(workItemId, stageId)
      : null;
    if (activeStage) {
      throw new Error(`Work Center Action stage identity is already active: ${stageId}`);
    }
    const creationSource = input.creationSource || 'legacy';
    if (input.type === 'create_vp'
        && (!isDynamicWorkItem(workItem)
          || creationSource !== 'dynamic_coordinator'
          || options.dynamicCoordinator !== true)) {
      throw new Error('create_vp Actions can only be persisted by the dynamic WorkItem Coordinator');
    }
    if (input.type === 'create_vp' && input.workspaceMode === 'read') {
      throw new Error('create_vp Actions cannot use read workspace mode because VP creation mutates Agent-global state');
    }
    const action = {
      id: input.id || randomUUID(),
      workItemId,
      sequence,
      type: input.type,
      stageId,
      assignmentPolicy: input.assignmentPolicy || null,
      modelPolicy: input.modelPolicy || null,
      dependsOnStageIds: Array.isArray(input.dependsOnStageIds) ? input.dependsOnStageIds : [],
      sourceActionIds: Array.isArray(input.sourceActionIds) ? input.sourceActionIds : [],
      creationSource,
      workspaceMode: input.workspaceMode || 'shared',
      changesRequestedStageId: input.changesRequestedStageId || null,
      workspace: input.workspace || null,
      requiredRole: input.requiredRole || '',
      instruction: input.instruction || '',
      brief: input.brief && typeof input.brief === 'object' ? input.brief : null,
      context: Array.isArray(input.context) ? input.context : [],
      contractRevision: Number.isInteger(input.contractRevision) ? input.contractRevision : 1,
      generation: Number.isInteger(input.generation) && input.generation > 0 ? input.generation : 1,
      specHash: '',
      resultRunId: input.resultRunId || null,
      status: input.status || 'ready',
      attempt: Number.isInteger(input.attempt) ? input.attempt : 0,
      maxAttempts: Number.isInteger(input.maxAttempts) ? input.maxAttempts : 2,
      currentRunId: null,
      leaseEpoch: 0,
      replacesActionId: input.replacesActionId || null,
      createdAt: now,
      updatedAt: now,
    };
    action.specHash = actionSpecHash(action);
    action.identityHistory = actionIdentityHistory(action);
    this.db.prepare(`INSERT INTO actions
      (id, work_item_id, sequence, type, required_role, stage_id, assignment_policy, model_policy,
       depends_on_stage_ids, source_action_ids, creation_source, workspace_mode, changes_requested_stage_id, workspace,
       instruction, brief, context, contract_revision, generation, spec_hash, identity_history, result_run_id,
       status, attempt, max_attempts, current_run_id, lease_epoch, replaces_action_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`).run(
      action.id,
      workItemId,
      action.sequence,
      action.type,
      action.requiredRole,
      action.stageId,
      stringify(action.assignmentPolicy),
      stringify(action.modelPolicy),
      stringify(action.dependsOnStageIds),
      stringify(action.sourceActionIds),
      action.creationSource,
      action.workspaceMode,
      action.changesRequestedStageId,
      stringify(action.workspace),
      action.instruction,
      stringify(action.brief),
      stringify(action.context),
      action.contractRevision,
      action.generation,
      action.specHash,
      stringify(action.identityHistory),
      action.resultRunId,
      action.status,
      action.attempt,
      action.maxAttempts,
      action.replacesActionId,
      now,
      now,
    );
    return action;
  }

  #nextSequence(workItemId) {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS seq FROM actions WHERE work_item_id = ?').get(workItemId);
    return Number(row.seq) + 1;
  }

  #hasActiveIntegrationReservation(action, now = this.now()) {
    const reservation = action?.workspace?.integration?.reservation;
    return !!reservation && Number(reservation.expiresAt) > now;
  }

  #assertNoIntegrationReservation(actions, now = this.now()) {
    if (actions.some(action => this.#hasActiveIntegrationReservation(action, now))) {
      throw new Error('Work Center integration finalization currently owns the Action lease');
    }
  }

  #supersedePendingActionInputs(actions, reason, now, keepEventIds = []) {
    const keep = new Set((keepEventIds || []).map(Number));
    const pending = this.db.prepare(`SELECT event_id FROM pending_action_inputs
      WHERE action_id = ? AND consumed_at IS NULL AND superseded_at IS NULL ORDER BY event_id`);
    const supersede = this.db.prepare(`UPDATE pending_action_inputs SET superseded_at = ?
      WHERE event_id = ? AND consumed_at IS NULL AND superseded_at IS NULL`);
    for (const action of actions) {
      const eventIds = pending.all(action.id).map(row => Number(row.event_id))
        .filter(eventId => !keep.has(eventId));
      if (eventIds.length === 0) continue;
      for (const eventId of eventIds) supersede.run(now, eventId);
      this.appendEvent(action.workItemId, 'action.input_superseded', {
        reason,
        sourceEventIds: eventIds,
      }, { actionId: action.id, actionGeneration: action.generation });
    }
  }

  #rebindPendingActionInputs(action, rows, target, reason, now) {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const update = this.db.prepare(`UPDATE pending_action_inputs SET run_id = ?, action_generation = ?,
      action_spec_hash = ? WHERE event_id = ? AND consumed_at IS NULL AND superseded_at IS NULL`);
    const rebound = [];
    for (const row of rows) {
      const changed = update.run(
        target.runId || null,
        target.generation,
        target.specHash,
        Number(row.event_id),
      );
      if (Number(changed.changes) === 1) rebound.push(Number(row.event_id));
    }
    if (rebound.length > 0) {
      this.appendEvent(action.workItemId, 'action.input_rebound', {
        reason,
        sourceEventIds: rebound,
        sourceRunIds: [...new Set(rows.map(row => row.run_id).filter(Boolean))],
        targetRunId: target.runId || null,
        targetSpecHash: target.specHash,
      }, {
        actionId: action.id,
        runId: target.runId || null,
        actionGeneration: target.generation,
      });
    }
    return rebound.length;
  }

  #resetGraphFromStage(workItemId, targetStageId, replacement, reason, now, options = {}) {
    const workItem = this.getWorkItem(workItemId);
    if (!workItem) throw new Error('Work Center graph reset WorkItem is missing');
    const actions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
      AND status NOT IN ('superseded', 'cancelled') ORDER BY sequence`).all(workItemId).map(mapAction);
    const target = actions.find(action => action.stageId === targetStageId);
    if (!target) throw new Error('Work Center graph reset target is missing');
    const affected = new Set([targetStageId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const action of actions) {
        if (affected.has(action.stageId)) continue;
        if (action.dependsOnStageIds.some(stageId => affected.has(stageId))) {
          affected.add(action.stageId);
          changed = true;
        }
      }
    }
    const affectedActions = actions.filter(action => affected.has(action.stageId));
    this.#assertNoIntegrationReservation(affectedActions, now);
    this.#supersedePendingActionInputs(affectedActions, reason, now);
    const preservedTargetWorkspace = target.workspaceMode === 'integrate'
      && ['prepared', 'finalized'].includes(target.workspace?.integration?.status)
      && (!replacement || replacement.workspaceMode === 'integrate')
      ? target.workspace
      : null;
    const ids = affectedActions.map(action => action.id);
    const running = affectedActions.filter(action => action.status === 'running' && action.currentRunId);
    const nextEpoch = new Map(actions.map(action => [action.id, action.leaseEpoch]));
    for (const action of running) nextEpoch.set(action.id, action.leaseEpoch + 1);
    const placeholders = ids.map(() => '?').join(',');
    if (ids.length > 0) {
      this.db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?, error = ?
        WHERE action_id IN (${placeholders}) AND status = 'running'`).run(now, reason, ...ids);
      for (const action of affectedActions) {
        const workspace = action.id === target.id ? preservedTargetWorkspace : null;
        const replacementContext = action.id === target.id && replacement
          ? replacement.context
          : action.context;
        const preserveInputIds = action.id === target.id ? options.preserveInputIds : [];
        const context = withoutActionInputContext(replacementContext, preserveInputIds);
        const nextAction = action.id === target.id && replacement
          ? { ...action, ...replacement, context, generation: action.generation + 1 }
          : { ...action, context, generation: action.generation + 1 };
        nextAction.instruction = canonicalActionInstruction(workItem, nextAction, context);
        const nextSpecHash = actionSpecHash(nextAction);
        this.db.prepare(`UPDATE actions SET status = 'ready', attempt = 0, current_run_id = NULL,
          lease_epoch = ?, generation = generation + 1, context = ?, instruction = ?, spec_hash = ?, identity_history = ?,
          result_run_id = NULL, workspace = ?, updated_at = ? WHERE id = ?`).run(
          nextEpoch.get(action.id), stringify(context), nextAction.instruction, nextSpecHash,
          stringify(actionIdentityHistory(action, nextAction.generation, nextSpecHash)),
          stringify(workspace), now, action.id,
        );
      }
    }
    if (replacement) {
      const replacementAction = {
        ...target,
        ...replacement,
        context: withoutActionInputContext(replacement.context, options.preserveInputIds),
        generation: target.generation + 1,
        contractRevision: replacement.contractRevision ?? target.contractRevision,
      };
      replacementAction.instruction = canonicalActionInstruction(workItem, replacementAction);
      const specHash = actionSpecHash(replacementAction);
      this.db.prepare(`UPDATE actions SET type = ?, required_role = ?, assignment_policy = ?,
        model_policy = ?, depends_on_stage_ids = ?, workspace_mode = ?, changes_requested_stage_id = ?,
        instruction = ?, brief = ?, context = ?, max_attempts = ?, workspace = ?, spec_hash = ?, updated_at = ?
        WHERE id = ? AND generation = ? AND spec_hash = ?`).run(
        replacement.type || target.type,
        replacement.requiredRole || '',
        stringify(replacement.assignmentPolicy || null),
        stringify(replacement.modelPolicy || null),
        stringify(Array.isArray(replacement.dependsOnStageIds) ? replacement.dependsOnStageIds : []),
        replacement.workspaceMode || 'shared',
        replacement.changesRequestedStageId || null,
        replacementAction.instruction,
        stringify(replacement.brief || null),
        stringify(replacementAction.context),
        Number.isInteger(replacement.maxAttempts) ? replacement.maxAttempts : 2,
        stringify(preservedTargetWorkspace),
        specHash,
        now,
        target.id,
        target.generation + 1,
        specHash,
      );
    }
    return this.getAction(target.id);
  }

  createNextAction(workItemId, input) {
    return this.#insertAction(workItemId, input, this.#nextSequence(workItemId));
  }

  setActionWorkspace(actionId, workspace, workspaceMode = null) {
    return withTransaction(this.db, () => {
      const action = this.getAction(actionId);
      if (!action) return null;
      const nextWorkspaceMode = workspaceMode || action.workspaceMode;
      const specChanged = nextWorkspaceMode !== action.workspaceMode;
      const nextContext = specChanged ? carryCurrentActionInputContext(this.db, action) : action.context;
      const nextAction = { ...action, context: nextContext, workspaceMode: nextWorkspaceMode };
      if (specChanged) {
        nextAction.instruction = canonicalActionInstruction(
          this.getWorkItem(action.workItemId),
          nextAction,
          nextContext,
        );
      }
      const nextSpecHash = specChanged ? actionSpecHash(nextAction) : action.specHash;
      const now = this.now();
      if (specChanged) {
        this.#supersedePendingActionInputs(
          [action],
          'Superseded by Action workspace mode change',
          now,
        );
      }
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = ?, context = ?, instruction = ?,
        generation = generation + ?, spec_hash = ?, identity_history = ?,
        result_run_id = CASE WHEN ? = 1 THEN NULL ELSE result_run_id END,
        updated_at = ? WHERE id = ? AND generation = ?`).run(
        stringify(workspace),
        nextWorkspaceMode,
        stringify(nextContext),
        nextAction.instruction,
        specChanged ? 1 : 0,
        nextSpecHash,
        stringify(specChanged
          ? actionIdentityHistory(action, action.generation + 1, nextSpecHash)
          : action.identityHistory),
        specChanged ? 1 : 0,
        now,
        actionId,
        action.generation,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  setActionWorkspaceForRun(
    actionId,
    runId,
    ownerBootId,
    leaseEpoch,
    expectedGeneration,
    workspace,
    workspaceMode = null,
  ) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      if (!action || action.generation !== expectedGeneration) return null;
      const nextWorkspaceMode = workspaceMode || action.workspaceMode;
      const specChanged = nextWorkspaceMode !== action.workspaceMode;
      const nextContext = specChanged ? carryCurrentActionInputContext(this.db, action) : action.context;
      const nextAction = { ...action, context: nextContext, workspaceMode: nextWorkspaceMode };
      if (specChanged) {
        nextAction.instruction = canonicalActionInstruction(
          this.getWorkItem(action.workItemId),
          nextAction,
          nextContext,
        );
      }
      const nextGeneration = action.generation + (specChanged ? 1 : 0);
      const nextSpecHash = specChanged ? actionSpecHash(nextAction) : action.specHash;
      const now = this.now();
      if (action.workspaceMode === 'isolated-write' && nextWorkspaceMode === 'shared') {
        const workItem = this.getWorkItem(action.workItemId);
        const workspaceConflict = workItem?.workspaceKey
          ? this.db.prepare(`SELECT 1 FROM actions running
            JOIN work_items running_item ON running_item.id = running.work_item_id
            WHERE running.id != ? AND running.status = 'running'
              AND running_item.workspace_key = ? LIMIT 1`).get(action.id, workItem.workspaceKey)
          : null;
        if (workspaceConflict) {
          const error = new Error('Work Center cannot fall back to shared while the workspace has another running Action');
          error.workItemPrepareDeferred = true;
          throw error;
        }
      }
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = ?, context = ?, instruction = ?,
        generation = generation + ?, spec_hash = ?, identity_history = ?,
        result_run_id = CASE WHEN ? = 1 THEN NULL ELSE result_run_id END,
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ?
        AND lease_epoch = ? AND generation = ?`).run(
        stringify(workspace),
        nextWorkspaceMode,
        stringify(nextContext),
        nextAction.instruction,
        specChanged ? 1 : 0,
        nextSpecHash,
        stringify(specChanged
          ? actionIdentityHistory(action, nextGeneration, nextSpecHash)
          : action.identityHistory),
        specChanged ? 1 : 0,
        now,
        actionId,
        runId,
        leaseEpoch,
        expectedGeneration,
      );
      if (Number(changed.changes) !== 1) return null;
      if (specChanged) {
        const pendingInputs = this.db.prepare(`SELECT * FROM pending_action_inputs
          WHERE action_id = ? AND run_id = ? AND action_generation = ? AND action_spec_hash = ?
            AND consumed_at IS NULL AND superseded_at IS NULL ORDER BY event_id`).all(
          action.id, runId, action.generation, action.specHash,
        );
        const rebound = this.db.prepare(`UPDATE runs SET action_generation = ?, action_spec_hash = ?
          WHERE id = ? AND action_id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'
          AND action_generation = ? AND action_spec_hash = ?`).run(
          nextGeneration,
          nextSpecHash,
          runId,
          actionId,
          ownerBootId,
          leaseEpoch,
          action.generation,
          action.specHash,
        );
        if (Number(rebound.changes) !== 1) {
          throw new Error('Work Center could not rebind the owned Run after workspace fallback');
        }
        const reboundCount = this.#rebindPendingActionInputs(action, pendingInputs, {
          runId,
          generation: nextGeneration,
          specHash: nextSpecHash,
        }, 'workspace_fallback', now);
        if (reboundCount !== pendingInputs.length) {
          throw new Error('Work Center could not rebind every pending input after workspace fallback');
        }
        const consumeInput = this.db.prepare(`UPDATE pending_action_inputs SET consumed_at = ?
          WHERE event_id = ? AND run_id = ? AND action_generation = ? AND action_spec_hash = ?
            AND consumed_at IS NULL AND superseded_at IS NULL`);
        for (const pendingInput of pendingInputs) {
          const consumed = consumeInput.run(
            now,
            Number(pendingInput.event_id),
            runId,
            nextGeneration,
            nextSpecHash,
          );
          if (Number(consumed.changes) !== 1) {
            throw new Error('Work Center could not consume canonical input after workspace fallback');
          }
        }
      }

      if (action.workspaceMode === 'isolated-write' && nextWorkspaceMode === 'shared') {
        const pendingRows = this.db.prepare(`SELECT * FROM actions
          WHERE work_item_id = ? AND id != ? AND workspace_mode IN ('isolated-write', 'integrate')
          AND status = 'ready' AND current_run_id IS NULL`).all(action.workItemId, action.id);
        for (const row of pendingRows) {
          const pending = mapAction(row);
          const nextContext = carryCurrentActionInputContext(this.db, pending);
          const fallback = { ...pending, context: nextContext, workspaceMode: 'shared', workspace: null };
          fallback.instruction = canonicalActionInstruction(
            this.getWorkItem(pending.workItemId),
            fallback,
            nextContext,
          );
          const fallbackSpecHash = actionSpecHash(fallback);
          this.#supersedePendingActionInputs(
            [pending],
            'Superseded by workspace serialization fallback',
            now,
          );
          const repaired = this.db.prepare(`UPDATE actions SET workspace = NULL, workspace_mode = 'shared', context = ?,
            instruction = ?, generation = generation + 1, spec_hash = ?, identity_history = ?, result_run_id = NULL, updated_at = ?
            WHERE id = ? AND status = 'ready' AND current_run_id IS NULL
            AND generation = ? AND workspace_mode = ?`).run(
            stringify(nextContext),
            fallback.instruction,
            fallbackSpecHash,
            stringify(actionIdentityHistory(pending, pending.generation + 1, fallbackSpecHash)),
            now,
            pending.id,
            pending.generation,
            pending.workspaceMode,
          );
          if (Number(repaired.changes) !== 1) {
            throw new Error('Work Center could not serialize the pending Action graph after workspace fallback');
          }
        }
      }
      return this.getAction(actionId);
    });
  }

  #graphWorkItemState(workItemId) {
    const remaining = this.db.prepare(`SELECT id, status FROM actions WHERE work_item_id = ?
      AND status IN ('ready', 'running', 'waiting', 'failed') ORDER BY sequence`).all(workItemId);
    const blocked = remaining.find(candidate => candidate.status === 'waiting' || candidate.status === 'failed');
    const running = remaining.find(candidate => candidate.status === 'running');
    const ready = remaining.find(candidate => candidate.status === 'ready');
    return {
      status: blocked ? (blocked.status === 'waiting' ? 'waiting' : 'needs_attention')
        : running ? 'running' : ready ? 'ready' : 'done',
      currentActionId: blocked?.id || running?.id || ready?.id || null,
    };
  }

  deferRun(runId, ownerBootId, leaseEpoch, reason = 'Work Center resource is temporarily busy') {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return null;
      const action = this.getAction(active.action_id);
      const workItem = this.getWorkItem(active.work_item_id);
      const now = this.now();
      const changedRun = this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = ?,
        failure_kind = 'resource_deferred', failure_code = 'workspace_busy'
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
        now, reason, runId, ownerBootId, leaseEpoch,
      );
      if (Number(changedRun.changes) !== 1) return null;
      const changedAction = this.db.prepare(`UPDATE actions SET status = 'ready', attempt = MAX(attempt - 1, 0),
        current_run_id = NULL, updated_at = ? WHERE id = ? AND status = 'running'
        AND current_run_id = ? AND lease_epoch = ? AND generation = ?`).run(
        now, action.id, runId, leaseEpoch, action.generation,
      );
      if (Number(changedAction.changes) !== 1) {
        throw new Error('Work Center deferred Run lost the current Action fence');
      }
      const concurrentMode = usesLegacyGraph(workItem) || isDynamicWorkItem(workItem);
      const graphState = concurrentMode ? this.#graphWorkItemState(workItem.id) : null;
      const changedWorkItem = concurrentMode
        ? this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
            updated_at = ? WHERE id = ? AND status IN ('ready', 'running', 'waiting', 'needs_attention')`).run(
            graphState.status, graphState.currentActionId, now, workItem.id,
          )
        : this.db.prepare(`UPDATE work_items SET status = 'ready', current_run_id = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND current_action_id = ? AND current_run_id = ?`).run(
          now, workItem.id, action.id, runId,
        );
      if (Number(changedWorkItem.changes) !== 1) {
        throw new Error('Work Center deferred Run lost the WorkItem fence');
      }
      this.appendEvent(workItem.id, 'run.deferred', { reason }, { actionId: action.id, runId });
      return this.getWorkItemDetail(workItem.id);
    });
  }

  setIntegrationWorkspaceForRun(actionId, runId, ownerBootId, leaseEpoch, workspace) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return null;
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = 'integrate',
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        stringify(workspace), this.now(), actionId, runId, leaseEpoch,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  acquireIntegrationFinalization(actionId, runId, ownerBootId, leaseEpoch, reservationMs = 300_000) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      if (action?.workspaceMode !== 'integrate' || action.workspace?.integration?.status !== 'prepared') return null;
      const now = this.now();
      const token = randomUUID();
      const expiresAt = now + Math.max(10_000, Number(reservationMs) || 300_000);
      const workspace = {
        ...action.workspace,
        integration: {
          ...action.workspace.integration,
          reservation: { token, runId, ownerBootId, leaseEpoch, expiresAt },
        },
      };
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        stringify(workspace), now, actionId, runId, leaseEpoch,
      );
      if (Number(changed.changes) !== 1) return null;
      this.db.prepare(`UPDATE runs SET expires_at = ? WHERE id = ? AND owner_boot_id = ?
        AND lease_epoch = ? AND status = 'running'`).run(expiresAt, runId, ownerBootId, leaseEpoch);
      return { action: this.getAction(actionId), token, expiresAt };
    });
  }

  finishIntegrationFinalization(actionId, runId, ownerBootId, leaseEpoch, token, workspace) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, false);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      const reservation = action?.workspace?.integration?.reservation;
      if (!reservation || reservation.token !== token || reservation.runId !== runId
          || reservation.ownerBootId !== ownerBootId || reservation.leaseEpoch !== leaseEpoch
          || Number(reservation.expiresAt) <= this.now()) return null;
      const changed = this.db.prepare(`UPDATE actions SET workspace = ?, workspace_mode = 'integrate',
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        stringify(workspace), this.now(), actionId, runId, leaseEpoch,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  rollbackIntegrationFinalization(actionId, runId, ownerBootId, leaseEpoch, token) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, false);
      if (!active || active.action_id !== actionId) return null;
      const action = this.getAction(actionId);
      const reservation = action?.workspace?.integration?.reservation;
      if (!reservation || reservation.token !== token || reservation.runId !== runId
          || reservation.ownerBootId !== ownerBootId || reservation.leaseEpoch !== leaseEpoch
          || Number(reservation.expiresAt) <= this.now()) return null;
      const changed = this.db.prepare(`UPDATE actions SET workspace = NULL, workspace_mode = 'integrate',
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
        this.now(), actionId, runId, leaseEpoch,
      );
      return Number(changed.changes) === 1 ? this.getAction(actionId) : null;
    });
  }

  listActionSources(workItemId, actionIds) {
    if (!Array.isArray(actionIds) || actionIds.length === 0) return [];
    const placeholders = actionIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT a.*, r.summary AS dependency_summary,
      r.evidence AS dependency_evidence, r.vp_snapshot AS dependency_vp_snapshot
      FROM actions a JOIN runs r ON r.id = a.result_run_id
      WHERE a.work_item_id = ? AND a.id IN (${placeholders})
        AND a.status = 'completed' AND r.status = 'completed'
      ORDER BY a.sequence`).all(workItemId, ...actionIds).map(row => ({
      ...mapAction(row),
      summary: row.dependency_summary || '',
      evidence: normalizeEvidence(parseJson(row.dependency_evidence, [])),
      vpId: parseJson(row.dependency_vp_snapshot, null)?.id || null,
    }));
  }

  listActionDependencies(workItemId, stageIds) {
    if (!Array.isArray(stageIds) || stageIds.length === 0) return [];
    const placeholders = stageIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT a.*, r.summary AS dependency_summary,
      r.evidence AS dependency_evidence, r.vp_snapshot AS dependency_vp_snapshot
      FROM actions a LEFT JOIN runs r ON r.id = (
        SELECT completed.id FROM runs completed WHERE completed.action_id = a.id
          AND completed.status = 'completed'
          ORDER BY completed.ended_at DESC LIMIT 1
      ) WHERE a.work_item_id = ? AND COALESCE(a.stage_id, a.type) IN (${placeholders})
        AND a.status != 'superseded'
      ORDER BY a.sequence`).all(workItemId, ...stageIds).map(row => ({
        ...mapAction(row),
        summary: row.dependency_summary || '',
        evidence: normalizeEvidence(parseJson(row.dependency_evidence, [])),
        vpId: parseJson(row.dependency_vp_snapshot, null)?.id || null,
      }));
  }

  getWorkItem(id) {
    const workItem = mapWorkItem(this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id));
    if (!usesLegacyGraph(workItem) && !isDynamicWorkItem(workItem)) return workItem;
    const actions = this.db.prepare('SELECT * FROM actions WHERE work_item_id = ? ORDER BY sequence')
      .all(id).map(mapAction);
    return graphExecutionState(workItem, actions);
  }

  getAction(id) {
    return mapAction(this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id));
  }

  getRun(id) {
    return mapRun(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
  }

  listCompletedRuns(workItemId) {
    return this.db.prepare(`SELECT r.*, a.type AS action_type FROM runs r
      JOIN actions a ON a.id = r.action_id
      WHERE r.work_item_id = ? AND r.status != 'running'
      ORDER BY r.started_at ASC`).all(workItemId).map(row => ({
        ...mapRun(row),
        actionType: row.action_type,
      }));
  }

  listFailedActionRecoveries() {
    return this.db.prepare(`SELECT a.work_item_id, a.id AS action_id, a.generation,
        COUNT(recovery_event.id) AS recovery_attempts,
        MAX(recovery_event.created_at) AS last_recovery_at
      FROM actions a JOIN work_items w ON w.id = a.work_item_id
      LEFT JOIN events recovery_event ON recovery_event.work_item_id = a.work_item_id
        AND recovery_event.action_id = a.id
        AND recovery_event.action_generation = a.generation
        AND recovery_event.type = 'coordinator.recovery_started'
      WHERE a.status = 'failed' AND w.status NOT IN ('done', 'cancelled')
        AND COALESCE(w.coordination_mode, 'legacy') != 'dynamic'
      GROUP BY a.id
      ORDER BY a.updated_at, a.sequence, a.id`).all().map(row => ({
        workItemId: row.work_item_id,
        actionId: row.action_id,
        actionGeneration: Math.max(1, Number(row.generation) || 1),
        recoveryAttempts: Math.max(0, Number(row.recovery_attempts) || 0),
        lastRecoveryAt: Math.max(0, Number(row.last_recovery_at) || 0),
      }));
  }

  listWorkItems(filters = {}) {
    const where = [];
    const values = [];
    if (typeof filters.status === 'string' && filters.status) {
      where.push('w.status = ?');
      values.push(filters.status);
    }
    if (typeof filters.sessionId === 'string' && filters.sessionId.trim()) {
      const sessionId = filters.sessionId.trim();
      where.push('(instr(w.origin, ?) > 0 OR instr(w.linked_session_ids, ?) > 0)');
      values.push(`\"sessionId\":${JSON.stringify(sessionId)}`, JSON.stringify(sessionId));
    }
    const keyword = typeof filters.keyword === 'string' ? filters.keyword.trim()
      : typeof filters.search === 'string' ? filters.search.trim() : '';
    if (keyword) {
      where.push('(w.title LIKE ? OR w.goal LIKE ?)');
      const query = `%${keyword}%`;
      values.push(query, query);
    }
    const createdFrom = Number(filters.createdFrom);
    const createdTo = Number(filters.createdTo);
    const updatedFrom = Number(filters.updatedFrom);
    const updatedTo = Number(filters.updatedTo);
    if (Number.isFinite(createdFrom) && createdFrom > 0) { where.push('w.created_at >= ?'); values.push(createdFrom); }
    if (Number.isFinite(createdTo) && createdTo > 0) { where.push('w.created_at <= ?'); values.push(createdTo); }
    if (Number.isFinite(updatedFrom) && updatedFrom > 0) { where.push('w.updated_at >= ?'); values.push(updatedFrom); }
    if (Number.isFinite(updatedTo) && updatedTo > 0) { where.push('w.updated_at <= ?'); values.push(updatedTo); }
    if (typeof filters.workItemType === 'string' && filters.workItemType.trim()) {
      where.push('instr(w.workflow_snapshot, ?) > 0');
      values.push(`\"workItemType\":${JSON.stringify(filters.workItemType.trim())}`);
    }
    if (typeof filters.vpId === 'string' && filters.vpId.trim()) {
      where.push(`EXISTS (SELECT 1 FROM actions executor_action
        JOIN runs executor_run ON executor_run.id = (
          SELECT latest_executor_run.id FROM runs latest_executor_run
          WHERE latest_executor_run.action_id = executor_action.id
          ORDER BY latest_executor_run.started_at DESC, latest_executor_run.progress_revision DESC
          LIMIT 1)
        WHERE executor_action.work_item_id = w.id
          AND executor_action.status NOT IN ('superseded', 'cancelled')
          AND instr(executor_run.vp_snapshot, ?) > 0)`);
      values.push(`\"id\":${JSON.stringify(filters.vpId.trim())}`);
    }
    if (filters.lane === 'closed') {
      where.push("w.status IN ('done', 'cancelled')");
    } else if (filters.lane === 'needs_attention') {
      where.push(`w.status NOT IN ('done', 'cancelled') AND (
        w.status IN ('draft', 'waiting', 'needs_attention') OR EXISTS (
          SELECT 1 FROM actions attention_action WHERE attention_action.work_item_id = w.id
            AND attention_action.status IN ('waiting', 'failed')))`);
    } else if (filters.lane === 'active') {
      where.push(`w.status NOT IN ('done', 'cancelled', 'draft', 'waiting', 'needs_attention')
        AND NOT EXISTS (SELECT 1 FROM actions attention_action WHERE attention_action.work_item_id = w.id
          AND attention_action.status IN ('waiting', 'failed'))`);
    }
    const cursorUpdatedAt = Number(filters.cursorUpdatedAt);
    const cursorId = typeof filters.cursorId === 'string' ? filters.cursorId : '';
    if (Number.isFinite(cursorUpdatedAt) && cursorUpdatedAt >= 0 && cursorId) {
      where.push('(w.updated_at < ? OR (w.updated_at = ? AND w.id < ?))');
      values.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
    }
    const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
    const sql = `SELECT w.*,
        current_action.type AS current_action_type,
        current_action.stage_id AS current_action_stage_id,
        current_action.status AS current_action_status,
        current_action.brief AS current_action_brief,
        (SELECT COUNT(*) FROM actions a WHERE a.work_item_id = w.id
          AND a.status NOT IN ('superseded', 'cancelled')) AS action_count,
        (SELECT COUNT(*) FROM actions a WHERE a.work_item_id = w.id
          AND a.status = 'completed') AS completed_action_count,
        COALESCE(SUM(r.llm_request_count), 0) AS usage_llm_request_count,
        COALESCE(SUM(r.loop_count), 0) AS usage_loop_count,
        COALESCE(SUM(r.tool_count), 0) AS usage_tool_count,
        COALESCE(SUM(r.input_tokens), 0) AS usage_input_tokens,
        COALESCE(SUM(r.output_tokens), 0) AS usage_output_tokens,
        COALESCE(SUM(r.cache_read_tokens), 0) AS usage_cache_read_tokens,
        COALESCE(SUM(r.cache_write_tokens), 0) AS usage_cache_write_tokens,
        COALESCE(SUM(r.total_tokens), 0) AS usage_total_tokens
      FROM work_items w
      LEFT JOIN actions current_action ON current_action.id = w.current_action_id
      LEFT JOIN runs r ON r.work_item_id = w.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY w.id ORDER BY w.updated_at DESC, w.id DESC LIMIT ?`;
    const workItems = this.db.prepare(sql).all(...values, limit).map(mapWorkItem);
    if (workItems.length === 0) return [];
    const placeholders = workItems.map(() => '?').join(',');
    const ids = workItems.map(item => item.id);
    const actionsByWorkItem = new Map(ids.map(id => [id, []]));
    for (const row of this.db.prepare(`SELECT * FROM actions WHERE work_item_id IN (${placeholders})
      AND status NOT IN ('superseded', 'cancelled')
      ORDER BY work_item_id, sequence`).all(...ids)) {
      actionsByWorkItem.get(row.work_item_id).push(mapAction(row));
    }
    const runsByWorkItem = new Map(ids.map(id => [id, []]));
    for (const row of this.db.prepare(`SELECT * FROM runs WHERE work_item_id IN (${placeholders})
      ORDER BY work_item_id, started_at DESC`).all(...ids)) {
      runsByWorkItem.get(row.work_item_id).push(mapRun(row));
    }
    return workItems.map(workItem => {
      const actions = actionsByWorkItem.get(workItem.id) || [];
      return graphExecutionState({ ...workItem, actions, runs: runsByWorkItem.get(workItem.id) || [] }, actions);
    });
  }

  getWorkItemDetail(id) {
    const workItem = this.getWorkItem(id);
    if (!workItem) return null;
    const detail = {
      ...workItem,
      actions: this.db.prepare('SELECT * FROM actions WHERE work_item_id = ? ORDER BY sequence').all(id).map(mapAction),
      runs: this.db.prepare('SELECT * FROM runs WHERE work_item_id = ? ORDER BY started_at DESC').all(id).map(mapRun),
      planConflicts: this.listPlanConflicts(id),
      events: this.db.prepare('SELECT * FROM events WHERE work_item_id = ? ORDER BY id DESC LIMIT 500').all(id).map(mapEvent),
    };
    return graphExecutionState(detail, detail.actions);
  }

  deleteWorkItemAtomic(id, expectedRevision) {
    return withTransaction(this.db, () => {
      const detail = this.getWorkItemDetail(id);
      if (!detail) return null;
      if (!Number.isInteger(expectedRevision) || detail.revision !== expectedRevision) {
        throw new Error('WorkItem changed before deletion; refresh and try again');
      }
      const activeRun = detail.runs.find(run => run.status === 'running');
      if (activeRun || !['done', 'cancelled', 'draft', 'needs_attention'].includes(detail.status)) {
        throw new Error('Stop this WorkItem before deleting it');
      }
      const result = this.db.prepare('DELETE FROM work_items WHERE id = ? AND revision = ?')
        .run(id, expectedRevision);
      if (Number(result.changes) !== 1) {
        throw new Error('WorkItem changed before deletion; refresh and try again');
      }
      return detail;
    });
  }

  listActionEvents(actionId) {
    return this.db.prepare(`SELECT * FROM events WHERE action_id = ? ORDER BY id`).all(actionId).map(mapEvent);
  }

  getRecoverableCoordinatorTurns() {
    return this.db.prepare(`SELECT w.id AS work_item_id, c.payload FROM coordinator_mailbox_entries c
      JOIN work_items w ON w.id = c.work_item_id
      WHERE c.status IN ('pending', 'claimed')
        AND EXISTS (SELECT 1 FROM json_each(w.messages) message
          WHERE json_extract(message.value, '$.turnId') = json_extract(c.payload, '$.turnId')
            AND json_extract(message.value, '$.role') = 'assistant'
            AND json_extract(message.value, '$.status') = 'thinking')
        AND EXISTS (SELECT 1 FROM coordinator_provider_turns p
          WHERE p.coordinator_turn_id = json_extract(c.payload, '$.turnId')
            AND p.status IN ('prepared', 'dispatching', 'responded'))
      ORDER BY c.created_at`).all().map(row => ({
        workItemId: row.work_item_id,
        ...parseJson(row.payload, {}),
      }));
  }

  resumeCoordinatorTurn(workItemId, turnId, claim = {}) {
    const detail = this.getWorkItemDetail(workItemId);
    if (!detail || !this.#activeCoordinatorMailboxClaim(turnId, claim)) return null;
    const assistant = [...(detail.messages || [])].reverse().find(message => (
      message.turnId === turnId && message.role === 'assistant' && message.status === 'thinking'
    ));
    if (!assistant) return null;
    return {
      turnId,
      detail,
      fence: {
        workItemId,
        revision: detail.revision,
        planRevision: detail.planRevision,
        ledgerRevision: detail.ledgerRevision,
        coordinatorRevision: detail.coordinatorRevision,
        status: detail.status,
        actionFence: coordinatorActionFence(
          (detail.actions || []).filter(action => !['completed', 'closed', 'superseded', 'cancelled'].includes(action.status)),
        ),
        recovery: assistant.recovery ? { ...assistant.recovery } : null,
        automatic: assistant.automatic === true,
        userOriginated: assistant.userOriginated === true,
        claim: {
          mailboxId: claim.mailboxId,
          ownerBootId: claim.ownerBootId,
          claimEpoch: Number(claim.claimEpoch),
        },
      },
    };
  }

  beginDynamicCoordinatorTurn(mailboxId, expected = {}) {
    return withTransaction(this.db, () => {
      const mailbox = this.db.prepare(`SELECT * FROM coordinator_mailbox_entries WHERE id = ?
        AND status = 'claimed' AND claim_owner = ? AND claim_epoch = ? AND lease_expires_at > ?`).get(
        mailboxId, expected.ownerBootId, expected.claimEpoch, this.now(),
      );
      if (!mailbox) return null;
      const workItem = this.getWorkItem(mailbox.work_item_id);
      if (!isDynamicWorkItem(workItem) || ['done', 'cancelled'].includes(workItem.status)) return null;
      const latest = (workItem.messages || []).at(-1);
      if (latest?.role === 'assistant' && latest.status === 'thinking') return null;
      const now = this.now();
      const turnId = randomUUID();
      const payload = parseJson(mailbox.payload, {});
      const assistantMessage = {
        id: randomUUID(), turnId, role: 'assistant', text: '', status: 'thinking',
        createdAt: now, updatedAt: now,
        automatic: true,
        trigger: { kind: mailbox.kind, sourceKey: mailbox.source_key, ...(payload.trigger || {}) },
      };
      const messages = [...(workItem.messages || []), assistantMessage].slice(-100);
      const coordinatorRevision = workItem.coordinatorRevision + 1;
      const changedMailbox = this.db.prepare(`UPDATE coordinator_mailbox_entries SET payload = ?,
        updated_at = ? WHERE id = ? AND status = 'claimed' AND claim_owner = ? AND claim_epoch = ?`).run(
        stringify({ ...payload, turnId }), now, mailbox.id, expected.ownerBootId, expected.claimEpoch,
      );
      if (Number(changedMailbox.changes) !== 1) return null;
      const changed = this.db.prepare(`UPDATE work_items SET messages = ?, coordinator_revision = ?,
        updated_at = ? WHERE id = ? AND revision = ? AND plan_revision = ?
        AND ledger_revision = ? AND coordinator_revision = ?`).run(
        stringify(messages), coordinatorRevision, now, workItem.id, workItem.revision,
        workItem.planRevision, workItem.ledgerRevision, workItem.coordinatorRevision,
      );
      if (Number(changed.changes) !== 1) throw new Error('Dynamic Coordinator turn lost its revision fence');
      this.#appendConversationEntry(
        workItem.id, assistantMessage, `coordinator:turn:${turnId}:assistant`,
      );
      this.appendEvent(workItem.id, 'coordinator.advance_started', {
        turnId, triggerKind: mailbox.kind, sourceKey: mailbox.source_key,
      });
      const detail = this.getWorkItemDetail(workItem.id);
      return {
        turnId,
        detail,
        fence: {
          workItemId: workItem.id,
          revision: workItem.revision,
          planRevision: workItem.planRevision,
          ledgerRevision: workItem.ledgerRevision,
          coordinatorRevision,
          status: workItem.status,
          actionFence: coordinatorActionFence(
            (detail.actions || []).filter(action => !['completed', 'closed', 'superseded', 'cancelled'].includes(action.status)),
          ),
          automatic: true,
          userOriginated: false,
          claim: {
            mailboxId: mailbox.id,
            ownerBootId: expected.ownerBootId,
            claimEpoch: Number(expected.claimEpoch),
          },
        },
      };
    });
  }

  claimStartedCoordinatorTurn(started, ownerBootId, leaseMs = 60_000) {
    if (!started?.turnId || !started?.detail?.id) return null;
    const claim = this.claimCoordinatorTurn(started.detail.id, started.turnId, ownerBootId, leaseMs);
    if (!claim) return null;
    return {
      ...started,
      fence: {
        ...started.fence,
        claim: {
          mailboxId: claim.mailboxId,
          ownerBootId: claim.ownerBootId,
          claimEpoch: claim.claimEpoch,
        },
      },
    };
  }

  beginCoordinatorTurn(id, text, expected = {}, options = {}) {
    return withTransaction(this.db, () => {
      const clientMessageId = typeof options.clientMessageId === 'string' && options.clientMessageId
        ? options.clientMessageId : null;
      if (clientMessageId) {
        const sourceKey = `client:message:${id}:${clientMessageId}`;
        const existingAction = this.db.prepare('SELECT 1 FROM action_entries WHERE source_key = ?').get(sourceKey);
        if (existingAction) throw new Error('clientMessageId already belongs to an Action message');
        const existing = this.db.prepare(`SELECT payload FROM coordinator_mailbox_entries
          WHERE source_key = ?`).get(sourceKey);
        if (existing) {
          const payload = parseJson(existing.payload, {});
          return { turnId: payload.turnId, detail: this.getWorkItemDetail(id), duplicate: true };
        }
      }
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (['done', 'cancelled'].includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} cannot accept Coordinator messages`);
      }
      if (workItem.revision !== expected.revision
          || workItem.planRevision !== expected.planRevision
          || workItem.ledgerRevision !== expected.ledgerRevision
          || workItem.coordinatorRevision !== expected.coordinatorRevision) {
        throw new Error('WorkItem changed before the Coordinator turn started; refresh and try again');
      }
      const latest = (workItem.messages || []).at(-1);
      if (latest?.role === 'assistant' && latest.status === 'thinking') {
        throw new Error('WorkItem Coordinator is already responding');
      }
      const now = this.now();
      const projectedAttachments = (Array.isArray(options.addedAttachments) ? options.addedAttachments : [])
        .map(attachment => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: Math.max(0, Number(attachment.size) || 0),
          isImage: attachment.isImage === true,
        }));
      const activeActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
        AND status NOT IN ('completed', 'closed', 'superseded', 'cancelled') ORDER BY sequence`).all(id).map(mapAction);
      this.#assertNoIntegrationReservation(activeActions, now);
      let recovery = options.recovery && typeof options.recovery === 'object'
        ? { ...options.recovery } : null;
      if (recovery) {
        const recoveryAction = activeActions.find(action => action.id === recovery.actionId);
        const requiredStatus = options.requireWaitingRecovery === true ? 'waiting' : 'failed';
        if (['done', 'cancelled'].includes(workItem.status)
            || recoveryAction?.status !== requiredStatus
            || recoveryAction.generation !== recovery.actionGeneration
            || recoveryAction.stageId !== recovery.stageId) {
          throw new Error(options.requireWaitingRecovery === true
            ? 'WorkItem human input target changed before the Coordinator turn started'
            : 'WorkItem failure changed before Coordinator recovery started');
        }
        if (options.requireWaitingRecovery !== true) {
          const priorAttempts = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events
            WHERE work_item_id = ? AND type = 'coordinator.recovery_started'
              AND action_id = ? AND action_generation = ?`).get(
            id,
            recoveryAction.id,
            recoveryAction.generation,
          )?.count) || 0;
          recovery = { ...recovery, attempt: priorAttempts + 1 };
        }
      }
      const automaticRecovery = recovery && options.requireWaitingRecovery !== true;
      if (!automaticRecovery && !String(text || '').trim() && projectedAttachments.length === 0) {
        throw new Error('WorkItem Coordinator message or attachments are required');
      }
      const turnId = randomUUID();
      const quote = options.quote && typeof options.quote === 'object' ? options.quote : null;
      const userMessage = automaticRecovery ? null : {
        id: randomUUID(), turnId, role: 'user', text, attachments: projectedAttachments,
        status: 'completed', createdAt: now,
        ...(quote ? { quote } : {}),
      };
      const assistantMessage = {
        id: randomUUID(), turnId, role: 'assistant', text: '', status: 'thinking',
        createdAt: now, updatedAt: now, decision: null,
        userOriginated: userMessage !== null,
        ...(recovery ? { recovery: { ...recovery } } : {}),
      };
      if (userMessage) {
        this.#appendConversationEntry(
          id,
          userMessage,
          clientMessageId ? `client:conversation:${id}:${clientMessageId}` : `coordinator:turn:${turnId}:user`,
        );
      }
      this.#appendConversationEntry(id, assistantMessage, `coordinator:turn:${turnId}:assistant`);
      this.enqueueCoordinatorMailbox(id, automaticRecovery ? 'recovery' : 'message', {
        turnId,
        text,
        recovery,
        clientMessageId,
        ...(quote ? { quote } : {}),
        addedAttachments: projectedAttachments,
      }, clientMessageId ? `client:message:${id}:${clientMessageId}` : `coordinator:turn:${turnId}`);
      const messages = [...(workItem.messages || []), ...(userMessage ? [userMessage] : []), assistantMessage]
        .slice(-100);
      const coordinatorRevision = workItem.coordinatorRevision + 1;
      const revision = workItem.revision + (projectedAttachments.length > 0 ? 1 : 0);
      const nextAttachments = Array.isArray(options.attachments)
        ? options.attachments
        : workItem.attachments;
      const changed = this.db.prepare(`UPDATE work_items SET messages = ?, attachments = ?, revision = ?, coordinator_revision = ?, updated_at = ?
        WHERE id = ? AND coordinator_revision = ? AND revision = ? AND plan_revision = ?
        AND ledger_revision = ?`).run(
        stringify(messages), stringify(nextAttachments), revision, coordinatorRevision, now,
        id, workItem.coordinatorRevision, workItem.revision, workItem.planRevision, workItem.ledgerRevision,
      );
      if (Number(changed.changes) !== 1) throw new Error('Coordinator turn lost its revision fence');
      this.appendEvent(id, automaticRecovery ? 'coordinator.recovery_started' : 'coordinator.turn_started', {
        turnId,
        clientMessageId,
        status: 'thinking',
        coordinatorRevision,
        addedAttachmentCount: projectedAttachments.length,
      }, recovery ? {
        actionId: recovery.actionId,
        actionGeneration: recovery.actionGeneration,
      } : {});
      const detail = this.getWorkItemDetail(id);
      return {
        turnId,
        detail,
        fence: {
          workItemId: id,
          revision,
          planRevision: workItem.planRevision,
          ledgerRevision: workItem.ledgerRevision,
          coordinatorRevision,
          status: workItem.status,
          actionFence: coordinatorActionFence(activeActions),
          recovery: recovery ? { ...recovery } : null,
          userOriginated: userMessage !== null,
          claim: null,
        },
      };
    });
  }

  completeCoordinatorTurn(turnId, result, expected = {}) {
    return withTransaction(this.db, () => {
      const claim = expected.claim || {};
      if (!this.#activeCoordinatorMailboxClaim(turnId, claim)) return null;
      const workItem = this.getWorkItem(expected.workItemId);
      if (!workItem) return null;
      if (workItem.revision !== expected.revision
          || workItem.planRevision !== expected.planRevision
          || workItem.ledgerRevision !== expected.ledgerRevision
          || workItem.coordinatorRevision !== expected.coordinatorRevision
          || workItem.status !== expected.status) {
        throw new Error('WorkItem changed while the Coordinator was responding; send the message again');
      }
      const messages = [...(workItem.messages || [])];
      const assistantIndex = messages.findIndex(message => (
        message?.turnId === turnId && message.role === 'assistant' && message.status === 'thinking'
      ));
      if (assistantIndex < 0) return null;
      const persistedRecovery = messages[assistantIndex]?.recovery ?? null;
      if (!sameCoordinatorRecoveryIdentity(persistedRecovery, expected.recovery ?? null)) {
        throw new Error('Coordinator recovery fence does not match the persisted turn identity');
      }
      const recovery = coordinatorRecoveryIdentity(persistedRecovery);
      const decision = result?.decision || {};
      const now = this.now();
      const activeActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
        AND status NOT IN ('completed', 'closed', 'superseded', 'cancelled') ORDER BY sequence`).all(workItem.id).map(mapAction);
      if (coordinatorActionFence(activeActions) !== expected.actionFence) {
        throw new Error('WorkItem Actions changed while the Coordinator was responding; send the message again');
      }
      this.#assertNoIntegrationReservation(activeActions, now);
      if (isDynamicWorkItem(workItem)) {
        return this.#completeDynamicCoordinatorTurn({
          turnId, result, expected, workItem, messages, assistantIndex, activeActions, now,
        });
      }
      if (decision.contractPatch?.deliveryTarget) {
        throw new Error('Only a dynamic user-originated Coordinator turn can confirm the WorkItem delivery target');
      }

      const graphMode = usesLegacyGraph(workItem);
      if (decision.kind === 'replan'
          && (!graphMode || workItem.workflowSnapshot?.planningMode !== 'ai')) {
        throw new Error('Coordinator replan requires an AI-planned Action graph');
      }
      if (recovery && decision.kind === 'guide_actions') {
        const recoveryAction = activeActions.find(action => (
          action.id === recovery.actionId
          && action.generation === recovery.actionGeneration
          && action.stageId === recovery.stageId
          && ['failed', 'waiting'].includes(action.status)
        ));
        if (!recoveryAction
            || !Array.isArray(decision.guidance)
            || decision.guidance.length !== 1
            || decision.guidance[0]?.stageId !== recoveryAction.stageId) {
          throw new Error('Coordinator recovery guidance must target only the fenced Action identity');
        }
      }
      let nextWorkItem = workItem;
      let affectedActionIds = [];
      if (decision.kind === 'request_human') {
        const action = recovery ? activeActions.find(candidate => (
          candidate.id === recovery.actionId
          && candidate.generation === recovery.actionGeneration
        )) : null;
        if (!action || action.status !== 'failed') {
          throw new Error('Coordinator human request lost the failed Action fence');
        }
        const question = typeof decision.question === 'string' ? decision.question.trim().slice(0, 8_000) : '';
        if (!question) throw new Error('Coordinator human request requires a question');
        const changedAction = this.db.prepare(`UPDATE actions SET status = 'waiting', updated_at = ?
          WHERE id = ? AND status = 'failed' AND generation = ? AND current_run_id IS NULL`).run(
          now, action.id, action.generation,
        );
        if (Number(changedAction.changes) !== 1) {
          throw new Error('Coordinator human request lost the failed Action generation fence');
        }
        const resultRunId = action.resultRunId
          || this.db.prepare(`SELECT id FROM runs WHERE action_id = ? AND status = 'failed'
            ORDER BY ended_at DESC, started_at DESC LIMIT 1`).get(action.id)?.id;
        if (!resultRunId) throw new Error('Coordinator human request requires a failed Run');
        affectedActionIds = [action.id];
        this.appendEvent(workItem.id, 'action.waiting', {
          reason: question,
          source: 'coordinator',
          turnId,
        }, {
          actionId: action.id,
          runId: resultRunId,
          actionGeneration: action.generation,
        });
      } else if (decision.kind === 'guide_actions') {
        const guidanceByStage = new Map(decision.guidance.map(entry => [entry.stageId, entry.instruction]));
        for (const action of activeActions) {
          const instruction = guidanceByStage.get(action.stageId);
          if (!instruction) continue;
          this.#supersedePendingActionInputs(
            [action],
            'Superseded by WorkItem Coordinator guidance',
            now,
          );
          if (action.status === 'running' && action.currentRunId) {
            this.db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?, error = ?
              WHERE id = ? AND status = 'running'`).run(
              now, 'Superseded by WorkItem Coordinator guidance', action.currentRunId,
            );
          }
          const context = [...withoutActionInputContext(action.context), {
            type: 'coordinator-guidance', role: 'user', summary: instruction, evidence: [],
          }];
          const nextAction = {
            ...action, context, generation: action.generation + 1,
          };
          nextAction.instruction = canonicalActionInstruction(workItem, nextAction, context);
          const specHash = actionSpecHash(nextAction);
          const changed = this.db.prepare(`UPDATE actions SET status = 'ready', attempt = 0,
            current_run_id = NULL, lease_epoch = lease_epoch + ?, context = ?, instruction = ?,
            generation = generation + 1, spec_hash = ?, identity_history = ?, result_run_id = NULL,
            workspace = NULL, updated_at = ? WHERE id = ? AND generation = ?
            AND status NOT IN ('completed', 'superseded', 'cancelled')`).run(
            action.status === 'running' ? 1 : 0,
            stringify(context), nextAction.instruction, specHash,
            stringify(actionIdentityHistory(action, nextAction.generation, specHash)),
            now, action.id, action.generation,
          );
          if (Number(changed.changes) !== 1) throw new Error('Coordinator guidance lost the Action generation fence');
          this.appendEvent(workItem.id, 'action.guidance_added', {
            guidance: instruction,
            source: 'coordinator',
            turnId,
          }, {
            actionId: action.id,
            actionGeneration: nextAction.generation,
          });
          affectedActionIds.push(action.id);
        }
        if (affectedActionIds.length !== decision.guidance.length) {
          throw new Error('Coordinator guidance target changed before the decision was applied');
        }
      } else if (decision.kind === 'replan') {
        const mutation = result.mutation;
        if (!mutation || mutation.basePlanRevision !== workItem.planRevision) {
          throw new Error('Coordinator replan lost the plan revision fence');
        }
        for (const action of mutation.unfinished) {
          this.#supersedePendingActionInputs(
            [action],
            'Superseded by WorkItem Coordinator replan',
            now,
          );
          if (action.status === 'running' && action.currentRunId) {
            this.db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?, error = ?
              WHERE id = ? AND status = 'running'`).run(
              now, 'Superseded by WorkItem Coordinator replan', action.currentRunId,
            );
          }
          const superseded = this.db.prepare(`UPDATE actions SET status = 'superseded', current_run_id = NULL,
            lease_epoch = lease_epoch + ?, workspace = NULL, updated_at = ?
            WHERE id = ? AND generation = ? AND status NOT IN ('completed', 'superseded', 'cancelled')`).run(
            action.status === 'running' ? 1 : 0, now, action.id, action.generation,
          );
          if (Number(superseded.changes) !== 1) {
            throw new Error('Coordinator replan lost an unfinished Action generation fence');
          }
        }
        const patch = decision.contractPatch || null;
        const title = patch?.title ?? workItem.title;
        const goal = patch?.goal ?? workItem.goal;
        const criteria = patch?.acceptanceCriteria ?? workItem.acceptanceCriteria;
        const contractChanged = title !== workItem.title || goal !== workItem.goal
          || JSON.stringify(criteria) !== JSON.stringify(workItem.acceptanceCriteria);
        const changedPlan = this.db.prepare(`UPDATE work_items SET title = ?, goal = ?,
          acceptance_criteria = ?, workflow_snapshot = ?, plan_revision = plan_revision + 1,
          revision = revision + ?, updated_at = ? WHERE id = ? AND revision = ? AND plan_revision = ?
          AND ledger_revision = ? AND coordinator_revision = ?`).run(
          title, goal, stringify(criteria), stringify(mutation.workflowSnapshot),
          contractChanged ? 1 : 0, now, workItem.id, workItem.revision, workItem.planRevision,
          workItem.ledgerRevision, workItem.coordinatorRevision,
        );
        if (Number(changedPlan.changes) !== 1) throw new Error('Coordinator replan lost the WorkItem contract fence');
        nextWorkItem = this.getWorkItem(workItem.id);
        for (const entry of mutation.nextActions) {
          const inserted = this.#insertAction(workItem.id, {
            ...entry.nextAction,
            status: 'ready',
            contractRevision: nextWorkItem.revision,
            replacesActionId: entry.prior?.id || null,
          }, this.#nextSequence(workItem.id), now);
          affectedActionIds.push(inserted.id);
        }
        this.db.prepare(`INSERT INTO plan_audits
          (work_item_id, proposal_id, base_plan_revision, plan_revision, kind, action_id, run_id, data, created_at)
          VALUES (?, ?, ?, ?, 'coordinator', ?, ?, ?, ?)`).run(
          workItem.id, mutation.proposalId, workItem.planRevision, nextWorkItem.planRevision,
          affectedActionIds[0], `coordinator:${turnId}`,
          stringify({ reason: mutation.reason, actionCount: affectedActionIds.length }), now,
        );
      }

      const graphState = ['answer'].includes(decision.kind) ? null : this.#graphWorkItemState(workItem.id);
      messages[assistantIndex] = {
        ...messages[assistantIndex],
        text: result.reply,
        status: 'completed',
        updatedAt: now,
        ...(result.speaker ? { speaker: result.speaker } : {}),
        decision: {
          kind: decision.kind,
          reason: decision.reason,
          changedContract: !!decision.contractPatch,
          affectedActionIds,
        },
      };
      this.#appendConversationEntry(
        workItem.id,
        messages[assistantIndex],
        `coordinator:turn:${turnId}:assistant`,
      );
      if (!this.ackCoordinatorMailbox(claim.mailboxId, claim.ownerBootId, claim.claimEpoch)) {
        throw new Error('Coordinator completion lost its mailbox claim');
      }
      const current = this.getWorkItem(workItem.id);
      const coordinatorRevision = current.coordinatorRevision + 1;
      const changed = decision.kind === 'answer'
        ? this.db.prepare(`UPDATE work_items SET messages = ?, coordinator_revision = ?, updated_at = ?
            WHERE id = ? AND coordinator_revision = ? AND revision = ? AND plan_revision = ?
            AND ledger_revision = ? AND status = ? AND current_action_id IS ? AND current_run_id IS ?`).run(
            stringify(messages), coordinatorRevision, now, workItem.id, current.coordinatorRevision,
            current.revision, current.planRevision, current.ledgerRevision, workItem.status,
            workItem.currentActionId, workItem.currentRunId,
          )
        : this.db.prepare(`UPDATE work_items SET messages = ?, coordinator_revision = ?,
            status = ?, current_action_id = ?, current_run_id = NULL, updated_at = ?
            WHERE id = ? AND coordinator_revision = ? AND revision = ? AND plan_revision = ?
            AND ledger_revision = ?`).run(
            stringify(messages), coordinatorRevision, graphState.status, graphState.currentActionId,
            now, workItem.id, current.coordinatorRevision, current.revision,
            current.planRevision, current.ledgerRevision,
          );
      if (Number(changed.changes) !== 1) throw new Error('Coordinator completion lost its turn fence');
      this.appendEvent(workItem.id, `coordinator.${decision.kind}`, {
        turnId, reason: decision.reason, affectedActionIds,
        previousPlanRevision: workItem.planRevision,
        planRevision: this.getWorkItem(workItem.id).planRevision,
      });
      return this.getWorkItemDetail(workItem.id);
    });
  }

  #completeDynamicCoordinatorTurn({
    turnId, result, expected, workItem, messages, assistantIndex, activeActions, now,
  }) {
    const decision = result?.decision || {};
    if (expected.automatic === true && result?.mutation?.contractPatch?.deliveryTarget) {
      throw new Error('Automatic Work Center Coordinator delivery target changes are forbidden');
    }
    if (decision.contractPatch?.deliveryTarget && expected.userOriginated !== true) {
      throw new Error('WorkItem delivery target confirmation requires a user-originated Coordinator turn');
    }
    if (decision.contractPatch?.deliveryTarget && decision.kind !== 'request_human') {
      throw new Error('WorkItem delivery target confirmation requires a user-originated request_human decision');
    }
    let affectedActionIds = [];
    let nextStatus = workItem.status;
    let currentActionId = workItem.currentActionId;
    let finalResult = null;
    const contractPatch = normalizeContractPatch(decision.contractPatch);
    if (decision.kind === 'create_actions'
        && !workItem.deliveryTarget
        && (result?.mutation?.createdActions || []).some(action => (
          action.type === 'create_vp' || action.workspaceMode !== 'read'
        ))) {
      throw new Error('WorkItem delivery target must be confirmed before creating mutating or delivery Actions');
    }
    if (contractPatch) {
      if (contractPatch.title) workItem.title = contractPatch.title;
      if (contractPatch.goal) workItem.goal = contractPatch.goal;
      if (contractPatch.acceptanceCriteria) workItem.acceptanceCriteria = contractPatch.acceptanceCriteria;
      if (contractPatch.deliveryTarget) workItem.deliveryTarget = contractPatch.deliveryTarget;
    }

    if (decision.kind === 'create_actions') {
      if (activeActions.some(action => action.status === 'running')) {
        throw new Error('Dynamic Coordinator cannot mutate Actions while a Run is active');
      }
      const mutation = result.mutation;
      if (!mutation || !Array.isArray(mutation.createdActions) || mutation.createdActions.length === 0) {
        throw new Error('Dynamic Coordinator Action creation is missing a validated mutation');
      }
      for (const closure of mutation.closeActions || []) {
        const action = activeActions.find(candidate => candidate.id === closure.actionId);
        if (!action || !['waiting', 'failed'].includes(action.status)) {
          throw new Error('Dynamic Coordinator close target changed before apply');
        }
        this.#supersedePendingActionInputs([action], closure.reason, now);
        const changed = this.db.prepare(`UPDATE actions SET status = 'closed', current_run_id = NULL,
          close_reason = ?, closed_at = ?, lease_epoch = lease_epoch + 1, updated_at = ?
          WHERE id = ? AND generation = ? AND status IN ('waiting', 'failed')`).run(
          closure.reason, now, now, action.id, action.generation,
        );
        if (Number(changed.changes) !== 1) throw new Error('Dynamic Coordinator lost an Action close fence');
        affectedActionIds.push(action.id);
        this.appendEvent(workItem.id, 'action.closed', { reason: closure.reason }, {
          actionId: action.id,
          actionGeneration: action.generation,
        });
      }
      for (const actionId of mutation.supersedeActionIds || []) {
        const action = activeActions.find(candidate => candidate.id === actionId);
        if (!action || !['ready', 'waiting', 'failed'].includes(action.status)) {
          throw new Error('Dynamic Coordinator supersede target changed before apply');
        }
        this.#supersedePendingActionInputs([action], 'Superseded by WorkItem Coordinator', now);
        const changed = this.db.prepare(`UPDATE actions SET status = 'superseded', current_run_id = NULL,
          lease_epoch = lease_epoch + 1, updated_at = ? WHERE id = ? AND generation = ?
          AND status IN ('ready', 'waiting', 'failed')`).run(now, action.id, action.generation);
        if (Number(changed.changes) !== 1) throw new Error('Dynamic Coordinator lost an Action fence');
      }
      const patch = mutation.contractPatch || null;
      const title = patch?.title ?? workItem.title;
      const goal = patch?.goal ?? workItem.goal;
      const criteria = patch?.acceptanceCriteria ?? workItem.acceptanceCriteria;
      const contractChanged = title !== workItem.title || goal !== workItem.goal
        || JSON.stringify(criteria) !== JSON.stringify(workItem.acceptanceCriteria);
      const snapshot = { ...workItem.workflowSnapshot, workItemType: mutation.workItemType };
      const changedPlan = this.db.prepare(`UPDATE work_items SET title = ?, goal = ?,
        acceptance_criteria = ?, workflow_snapshot = ?, revision = revision + ?,
        plan_revision = plan_revision + 1, updated_at = ? WHERE id = ? AND revision = ?
        AND plan_revision = ? AND ledger_revision = ? AND coordinator_revision = ?`).run(
        title, goal, stringify(criteria), stringify(snapshot), contractChanged ? 1 : 0,
        now, workItem.id, workItem.revision, workItem.planRevision,
        workItem.ledgerRevision, workItem.coordinatorRevision,
      );
      if (Number(changedPlan.changes) !== 1) throw new Error('Dynamic Coordinator lost the WorkItem plan fence');
      const current = this.getWorkItem(workItem.id);
      for (const candidate of mutation.createdActions) {
        const action = this.#insertAction(workItem.id, {
          ...candidate,
          creationSource: 'dynamic_coordinator',
          status: 'ready',
          contractRevision: current.revision,
        }, this.#nextSequence(workItem.id), now, { dynamicCoordinator: true });
        affectedActionIds.push(action.id);
      }
      nextStatus = 'ready';
      currentActionId = affectedActionIds[0];
    } else if (decision.kind === 'guide_actions') {
      const byId = new Map(decision.guidance.map(entry => [entry.actionId, entry.instruction]));
      for (const action of activeActions) {
        const guidance = byId.get(action.id);
        if (!guidance) continue;
        if (!['ready', 'waiting', 'failed'].includes(action.status)) {
          throw new Error('Dynamic Coordinator can guide only non-running unfinished Actions');
        }
        const context = [...withoutActionInputContext(action.context), {
          type: 'coordinator-guidance', role: 'user', summary: guidance, evidence: [],
        }];
        const candidate = { ...action, context, generation: action.generation + 1 };
        candidate.instruction = canonicalActionInstruction(workItem, candidate, context);
        const specHash = actionSpecHash(candidate);
        const changed = this.db.prepare(`UPDATE actions SET status = 'ready', attempt = 0,
          current_run_id = NULL, context = ?, instruction = ?, generation = generation + 1,
          spec_hash = ?, identity_history = ?, result_run_id = NULL, workspace = NULL, updated_at = ?
          WHERE id = ? AND generation = ? AND status IN ('ready', 'waiting', 'failed')`).run(
          stringify(context), candidate.instruction, specHash,
          stringify(actionIdentityHistory(action, candidate.generation, specHash)),
          now, action.id, action.generation,
        );
        if (Number(changed.changes) !== 1) throw new Error('Dynamic Coordinator guidance lost its Action fence');
        affectedActionIds.push(action.id);
      }
      if (affectedActionIds.length !== decision.guidance.length) {
        throw new Error('Dynamic Coordinator guidance target changed before apply');
      }
      nextStatus = 'ready';
      currentActionId = affectedActionIds[0];
    } else if (decision.kind === 'request_human') {
      nextStatus = 'waiting';
      currentActionId = null;
    } else if (decision.kind === 'complete') {
      const closing = new Map((decision.closeActions || []).map(entry => [entry.actionId, entry]));
      if (activeActions.some(action => action.status !== 'closed' && !closing.has(action.id))) {
        throw new Error('Work Center cannot complete with unfinished Actions');
      }
      for (const action of activeActions) {
        const closure = closing.get(action.id);
        if (!closure) continue;
        if (!['waiting', 'failed'].includes(action.status)) {
          throw new Error('Dynamic Coordinator completion close target changed before apply');
        }
        this.#supersedePendingActionInputs([action], closure.reason, now);
        const changed = this.db.prepare(`UPDATE actions SET status = 'closed', current_run_id = NULL,
          close_reason = ?, closed_at = ?, lease_epoch = lease_epoch + 1, updated_at = ?
          WHERE id = ? AND generation = ? AND status IN ('waiting', 'failed')`).run(
          closure.reason, now, now, action.id, action.generation,
        );
        if (Number(changed.changes) !== 1) throw new Error('Dynamic Coordinator completion lost an Action close fence');
        affectedActionIds.push(action.id);
        this.appendEvent(workItem.id, 'action.closed', { reason: closure.reason }, {
          actionId: action.id,
          actionGeneration: action.generation,
        });
      }
      if (this.#hasBlockingOperation(workItem.id)) {
        throw new Error('WorkItem has an unsafe blocking Operation and cannot complete');
      }
      finalResult = normalizeDynamicCompletion(decision.completion, workItem.acceptanceCriteria);
      const canonicalRuns = new Map(this.db.prepare(`SELECT r.* FROM runs r JOIN actions a ON a.id = r.action_id
        WHERE r.work_item_id = ? AND r.status = 'completed' AND a.result_run_id = r.id`).all(workItem.id)
        .map(row => {
          const run = mapRun(row);
          return [run.id, run];
        }));
      const criteria = Array.isArray(workItem.acceptanceCriteria) ? workItem.acceptanceCriteria : [];
      for (const runId of finalResult.evidenceRunIds) {
        const run = canonicalRuns.get(runId);
        if (!run) throw new Error(`Completion evidence is not a canonical owned Run: ${runId}`);
        if (run.evidence.length === 0) {
          throw new Error(`Completion evidence Run has no concrete evidence: ${runId}`);
        }
        if (!Array.isArray(run.acceptanceChecks) || run.acceptanceChecks.length !== criteria.length
            || run.acceptanceChecks.some((check, index) => (
              check?.criterion !== criteria[index] || !check?.status || !String(check?.evidence || '').trim()
            ))) {
          throw new Error(`Completion evidence Run has incomplete acceptance checks: ${runId}`);
        }
      }
      finalResult.outputs = [];
      const seenOutputs = new Set();
      for (const runId of finalResult.evidenceRunIds) {
        for (const output of canonicalRuns.get(runId)?.outputs || []) {
          const key = `${output.kind}\u0000${output.ref}`;
          if (seenOutputs.has(key)) continue;
          seenOutputs.add(key);
          finalResult.outputs.push({ ...output, runId });
        }
      }
      const requiredOutputKind = {
        workspace_files: 'file',
        pull_request: 'pr',
        merge: 'commit',
      }[workItem.deliveryTarget];
      if (!requiredOutputKind) {
        throw new Error('WorkItem delivery target must be confirmed before completion');
      }
      if (!finalResult.outputs.some(output => output.kind === requiredOutputKind)) {
        throw new Error(`WorkItem completion requires a canonical ${requiredOutputKind} output for delivery target ${workItem.deliveryTarget}`);
      }
      for (const [index, acceptanceResult] of finalResult.acceptanceResults.entries()) {
        const provesCriterion = acceptanceResult.evidenceRunIds.some(runId => (
          canonicalRuns.get(runId)?.acceptanceChecks?.[index]?.criterion === criteria[index]
          && canonicalRuns.get(runId)?.acceptanceChecks?.[index]?.status === 'passed'
        ));
        if (!provesCriterion) {
          throw new Error(`Completion criterion lacks a passing canonical Run check: ${criteria[index]}`);
        }
      }
      nextStatus = 'done';
      currentActionId = null;
    } else if (decision.kind !== 'answer') {
      throw new Error(`Unsupported dynamic Coordinator decision: ${decision.kind || '(missing)'}`);
    }

    messages[assistantIndex] = {
      ...messages[assistantIndex], text: result.reply, status: 'completed', updatedAt: now,
      ...(result.speaker ? { speaker: result.speaker } : {}),
      decision: {
        kind: decision.kind,
        reason: decision.reason,
        affectedActionIds,
        ...(decision.kind === 'request_human' ? { question: decision.question } : {}),
      },
    };
    this.#appendConversationEntry(
      workItem.id, messages[assistantIndex], `coordinator:turn:${turnId}:assistant`,
    );
    const claim = expected.claim || {};
    if (!this.ackCoordinatorMailbox(claim.mailboxId, claim.ownerBootId, claim.claimEpoch)) {
      throw new Error('Dynamic Coordinator completion lost its mailbox claim');
    }
    const current = this.getWorkItem(workItem.id);
    const changed = this.db.prepare(`UPDATE work_items SET messages = ?,
      coordinator_revision = coordinator_revision + 1, status = ?, current_action_id = ?,
      current_run_id = NULL, final_result = COALESCE(final_result, ?), title = ?, goal = ?,
      acceptance_criteria = ?, delivery_target = ?, revision = revision + ?, updated_at = ?
      WHERE id = ? AND coordinator_revision = ? AND revision = ? AND plan_revision = ?
      AND ledger_revision = ? AND status NOT IN ('done', 'cancelled')`).run(
      stringify(messages), nextStatus, currentActionId, finalResult ? stringify(finalResult) : null,
      workItem.title, workItem.goal, stringify(workItem.acceptanceCriteria), workItem.deliveryTarget,
      contractPatch ? 1 : 0, now, workItem.id, current.coordinatorRevision, current.revision,
      current.planRevision, current.ledgerRevision,
    );
    if (Number(changed.changes) !== 1) throw new Error('Dynamic Coordinator completion lost its turn fence');
    this.appendEvent(workItem.id, decision.kind === 'complete'
      ? 'work_item.completed' : `coordinator.${decision.kind}`, {
      turnId, reason: decision.reason, affectedActionIds,
    });
    return this.getWorkItemDetail(workItem.id);
  }

  failCoordinatorTurn(turnId, error, expected = {}) {
    return withTransaction(this.db, () => {
      const claim = expected.claim || {};
      if (!this.#activeCoordinatorMailboxClaim(turnId, claim)) return null;
      const responded = this.db.prepare(`SELECT 1 AS present FROM coordinator_provider_turns
        WHERE coordinator_turn_id = ? AND status = 'responded'`).get(turnId);
      if (responded) return null;
      const workItem = this.getWorkItem(expected.workItemId);
      if (!workItem || workItem.coordinatorRevision !== expected.coordinatorRevision) return null;
      const messages = [...(workItem.messages || [])];
      const index = messages.findIndex(message => (
        message?.turnId === turnId && message.role === 'assistant' && message.status === 'thinking'
      ));
      if (index < 0) return null;
      const now = this.now();
      messages[index] = {
        ...messages[index],
        status: 'failed',
        updatedAt: now,
        ...(expected.speaker ? { speaker: expected.speaker } : {}),
        error: String(error?.message || error || 'Coordinator failed').slice(0, 8_000),
      };
      this.#appendConversationEntry(
        workItem.id,
        messages[index],
        `coordinator:turn:${turnId}:assistant`,
      );
      const dynamicAutomatic = isDynamicWorkItem(workItem) && expected.automatic === true;
      if (dynamicAutomatic) {
        if (!this.releaseCoordinatorMailboxClaim(
          claim.mailboxId, claim.ownerBootId, claim.claimEpoch,
        )) return null;
      } else if (!this.ackCoordinatorMailbox(
        claim.mailboxId, claim.ownerBootId, claim.claimEpoch,
      )) return null;
      const changed = this.db.prepare(`UPDATE work_items SET messages = ?, coordinator_revision = coordinator_revision + 1,
        updated_at = ? WHERE id = ? AND coordinator_revision = ?`).run(
        stringify(messages), now, workItem.id, workItem.coordinatorRevision,
      );
      if (Number(changed.changes) !== 1) return null;
      this.appendEvent(workItem.id, 'coordinator.turn_failed', {
        turnId, error: messages[index].error,
        retryScheduled: dynamicAutomatic,
      });
      return this.getWorkItemDetail(workItem.id);
    });
  }

  getReusableContext(workDir, excludeWorkItemId = null) {
    const workspaceKey = canonicalWorkspaceKey(workDir);
    if (!workspaceKey) return [];
    const rows = this.db.prepare(`SELECT r.*, a.type AS action_type, a.required_role,
        w.title AS source_title
      FROM runs r
      JOIN actions a ON a.id = r.action_id
      JOIN work_items w ON w.id = r.work_item_id
      WHERE w.workspace_key = ? AND w.reuse_memory = 1 AND w.id != ? AND w.status = 'done'
        AND r.status = 'completed' AND length(trim(COALESCE(r.summary, ''))) > 0
      ORDER BY r.ended_at DESC, r.started_at DESC
      LIMIT ?`).all(workspaceKey, excludeWorkItemId || '', MAX_REUSABLE_CONTEXT_ITEMS);
    return rows.reverse().map(row => {
      const run = mapRun(row);
      return {
        type: row.action_type,
        role: row.required_role,
        summary: run.summary,
        evidence: run.evidence,
        reviewDecision: run.reviewDecision,
        sourceTitle: row.source_title,
      };
    });
  }

  addActionGuidance(id, guidance, expected, makeAction, attachments = null, addedAttachments = []) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      const graphMode = usesLegacyGraph(workItem);
      const concurrentMode = graphMode || isDynamicWorkItem(workItem);
      const expectedAction = this.getAction(expected.actionId);
      const expectedGeneration = Number(expected.generation);
      const hasExpectedGeneration = Number.isInteger(expectedGeneration) && expectedGeneration > 0;
      const expectedMatches = expectedAction?.workItemId === id
        && (concurrentMode || workItem.currentActionId === expected.actionId)
        && (hasExpectedGeneration ? expectedAction.generation === expectedGeneration : !concurrentMode);
      if (!expectedMatches || workItem.revision !== expected.revision) {
        throw new Error('Action changed before guidance was applied; refresh and try again');
      }
      const guidanceStatuses = concurrentMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['ready', 'running'];
      if (!guidanceStatuses.includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} cannot accept Action guidance`);
      }
      const previous = concurrentMode ? expectedAction
        : (workItem.currentActionId ? this.getAction(workItem.currentActionId) : null);
      const actionableStatuses = concurrentMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['ready', 'running'];
      if (!previous || !actionableStatuses.includes(previous.status)) {
        throw new Error('WorkItem has no active Action for guidance');
      }
      const now = this.now();
      const revision = workItem.revision + (isDynamicWorkItem(workItem) ? 0 : 1);
      const replacement = {
        ...makeAction(workItem, previous),
        contractRevision: previous.contractRevision,
      };
      let action;
      if (isDynamicWorkItem(workItem)) {
        this.#supersedePendingActionInputs([previous], 'Action restarted after user guidance', now);
        if (previous.status === 'running' && previous.currentRunId) {
          this.db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?, error = ?
            WHERE id = ? AND status = 'running'`).run(
            now, 'Action restarted after user guidance', previous.currentRunId,
          );
        }
        const candidate = {
          ...replacement,
          id: previous.id,
          context: withoutActionInputContext(replacement.context),
          generation: previous.generation + 1,
          attempt: 0,
          currentRunId: null,
          resultRunId: null,
          workspace: null,
        };
        candidate.instruction = canonicalActionInstruction(workItem, candidate, candidate.context);
        const specHash = actionSpecHash(candidate);
        const changed = this.db.prepare(`UPDATE actions SET status = 'ready', attempt = 0,
          current_run_id = NULL, lease_epoch = lease_epoch + ?, context = ?, instruction = ?,
          generation = generation + 1, spec_hash = ?, identity_history = ?, result_run_id = NULL,
          workspace = NULL, updated_at = ? WHERE id = ? AND generation = ?
          AND status NOT IN ('completed', 'superseded', 'cancelled')`).run(
          previous.status === 'running' ? 1 : 0,
          stringify(candidate.context), candidate.instruction, specHash,
          stringify(actionIdentityHistory(previous, candidate.generation, specHash)),
          now, previous.id, previous.generation,
        );
        if (Number(changed.changes) !== 1) throw new Error('Dynamic Action guidance lost its generation fence');
        action = this.getAction(previous.id);
      } else if (graphMode) {
        action = this.#resetGraphFromStage(
          id,
          previous.stageId,
          replacement,
          'Action restarted after user guidance',
          now,
        );
      } else {
        this.#invalidateExecution(
          workItem,
          'superseded',
          'superseded',
          'Action restarted after user guidance',
          now,
        );
        action = this.#insertAction(id, replacement, this.#nextSequence(id), now);
      }
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, attachments = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
        action.id,
        stringify(Array.isArray(attachments) ? attachments : workItem.attachments),
        revision,
        now,
        id,
      );
      this.appendEvent(id, 'action.guidance_added', {
        guidance,
        attachments: (Array.isArray(addedAttachments) ? addedAttachments : []).map(attachment => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: Math.max(0, Number(attachment.size) || 0),
          isImage: attachment.isImage === true,
        })),
      }, { actionId: action.id });
      return this.getWorkItemDetail(id);
    });
  }

  #invalidateExecution(workItem, actionStatus, runStatus, reason, now) {
    const unfinishedActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
      AND status IN (${UNFINISHED_ACTION_STATUSES})`).all(workItem.id).map(mapAction);
    this.#assertNoIntegrationReservation(unfinishedActions, now);
    this.#supersedePendingActionInputs(unfinishedActions, reason, now);
    const actionIds = unfinishedActions.map(action => action.id);
    if (actionIds.length === 0) return;
    const placeholders = actionIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, error = ?, accepting_input = 0
      WHERE work_item_id = ? AND action_id IN (${placeholders}) AND status = 'running'`).run(
      runStatus,
      now,
      reason,
      workItem.id,
      ...actionIds,
    );
    const changed = this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL,
      lease_epoch = lease_epoch + 1, updated_at = ? WHERE work_item_id = ?
      AND id IN (${placeholders}) AND status IN (${UNFINISHED_ACTION_STATUSES})`).run(
      actionStatus,
      now,
      workItem.id,
      ...actionIds,
    );
    if (Number(changed.changes) !== actionIds.length) {
      throw new Error('Work Center execution changed while it was invalidated');
    }
  }

  updateWorkItemAtomic(id, patch, makeInitialAction) {
    return withTransaction(this.db, () => {
      const current = this.getWorkItem(id);
      if (!current) return null;
      if (['done', 'cancelled'].includes(current.status)) {
        throw new Error(`Cannot update WorkItem in ${current.status}`);
      }
      const next = {
        title: patch.title ?? current.title,
        goal: patch.goal ?? current.goal,
        acceptanceCriteria: patch.acceptanceCriteria ?? current.acceptanceCriteria,
        workDir: patch.workDir ?? current.workDir,
      };
      const contractChanged = next.goal !== current.goal
        || next.workDir !== current.workDir
        || JSON.stringify(next.acceptanceCriteria) !== JSON.stringify(current.acceptanceCriteria);
      const now = this.now();
      const revision = current.revision + (contractChanged ? 1 : 0);
      if (contractChanged) {
        this.#invalidateExecution(
          current,
          'superseded',
          'superseded',
          'WorkItem contract changed while this Run was active',
          now,
        );
      }
      this.db.prepare(`UPDATE work_items SET title = ?, goal = ?, acceptance_criteria = ?,
        work_dir = ?, workspace_key = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
        next.title,
        next.goal,
        stringify(next.acceptanceCriteria),
        next.workDir,
        canonicalWorkspaceKey(next.workDir),
        revision,
        now,
        id,
      );
      let action = null;
      if (contractChanged) {
        const updated = this.getWorkItem(id);
        if (isDynamicWorkItem(updated)) {
          this.db.prepare(`UPDATE work_items SET status = 'running', current_action_id = NULL,
            current_run_id = NULL, updated_at = ? WHERE id = ?`).run(now, id);
          this.enqueueCoordinatorMailbox(id, 'contract_changed', {
            trigger: { revision, changedFields: Object.keys(patch || {}) },
          }, `dynamic:contract:${id}:${revision}`);
        } else {
          action = this.#insertAction(id, {
            ...makeInitialAction(updated),
            contractRevision: revision,
          }, this.#nextSequence(id), now);
          this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
            current_run_id = NULL, updated_at = ? WHERE id = ?`).run(action.id, now, id);
        }
      }
      this.appendEvent(id, contractChanged ? 'workflow.retriaged' : 'work_item.updated', {
        revision,
        changedFields: Object.keys(patch || {}),
      }, { actionId: action?.id });
      return { workItem: this.getWorkItem(id), contractChanged };
    });
  }

  cancelWorkItemAtomic(id) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (workItem.status === 'done') throw new Error('Completed WorkItem cannot be cancelled');
      if (workItem.status === 'cancelled') return workItem;
      const now = this.now();
      this.#invalidateExecution(
        workItem,
        'cancelled',
        'cancelled',
        'WorkItem was cancelled',
        now,
      );
      this.db.prepare(`UPDATE work_items SET status = 'cancelled', current_action_id = NULL,
        current_run_id = NULL, updated_at = ? WHERE id = ?`).run(now, id);
      this.appendEvent(id, 'work_item.cancelled');
      return this.getWorkItem(id);
    });
  }

  resumeWorkItemAtomic(id, expectedRevision, makeInitialAction) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (!Number.isInteger(expectedRevision) || workItem.revision !== expectedRevision) {
        throw new Error('WorkItem changed before it was resumed; refresh and try again');
      }
      if (workItem.status !== 'cancelled') {
        throw new Error(`WorkItem in ${workItem.status} cannot be resumed`);
      }

      const now = this.now();
      const cancelledActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
        AND status = 'cancelled' ORDER BY sequence`).all(id).map(mapAction);
      this.#assertNoIntegrationReservation(cancelledActions, now);
      if (isDynamicWorkItem(workItem)) {
        this.#supersedePendingActionInputs(
          cancelledActions,
          'WorkItem resume returned control to the Coordinator',
          now,
        );
        this.db.prepare(`UPDATE actions SET status = 'superseded', current_run_id = NULL,
          lease_epoch = lease_epoch + 1, updated_at = ? WHERE work_item_id = ? AND status = 'cancelled'`).run(
          now, id,
        );
        const changed = this.db.prepare(`UPDATE work_items SET status = 'running',
          current_action_id = NULL, current_run_id = NULL, updated_at = ?
          WHERE id = ? AND status = 'cancelled' AND revision = ?`).run(now, id, expectedRevision);
        if (Number(changed.changes) !== 1) {
          throw new Error('WorkItem changed before it was resumed; refresh and try again');
        }
        this.enqueueCoordinatorMailbox(id, 'work_item_resumed', {
          trigger: { workItemId: id, revision: expectedRevision },
        }, `dynamic:resume:${id}:${expectedRevision}`);
        this.appendEvent(id, 'work_item.resumed', {
          supersededActionIds: cancelledActions.map(action => action.id),
        });
        return this.getWorkItemDetail(id);
      }
      this.#supersedePendingActionInputs(
        cancelledActions,
        'WorkItem resume started a new Action generation',
        now,
      );
      const resumedActions = [];
      for (const action of cancelledActions) {
        const context = carryCurrentActionInputContext(this.db, action);
        const candidate = {
          ...action,
          context,
          status: 'ready',
          attempt: 0,
          currentRunId: null,
          resultRunId: null,
          workspace: null,
          generation: action.generation + 1,
        };
        candidate.instruction = canonicalActionInstruction(workItem, candidate, context);
        candidate.specHash = actionSpecHash(candidate);
        const changed = this.db.prepare(`UPDATE actions SET status = 'ready', attempt = 0,
          current_run_id = NULL, lease_epoch = lease_epoch + 1, generation = generation + 1,
          context = ?, instruction = ?, spec_hash = ?, identity_history = ?, result_run_id = NULL,
          workspace = NULL, updated_at = ? WHERE id = ? AND work_item_id = ?
          AND status = 'cancelled' AND generation = ? AND spec_hash = ?`).run(
          stringify(context),
          candidate.instruction,
          candidate.specHash,
          stringify(actionIdentityHistory(action, candidate.generation, candidate.specHash)),
          now,
          action.id,
          id,
          action.generation,
          action.specHash,
        );
        if (Number(changed.changes) !== 1) {
          throw new Error('WorkItem Action changed before it was resumed');
        }
        resumedActions.push(this.getAction(action.id));
      }

      if (resumedActions.length === 0) {
        const initialAction = makeInitialAction(workItem);
        resumedActions.push(this.#insertAction(id, {
          ...initialAction,
          contractRevision: workItem.revision,
        }, this.#nextSequence(id), now));
      }

      const currentAction = resumedActions
        .find(action => action.dependsOnStageIds.length === 0) || resumedActions[0];
      const changedWorkItem = this.db.prepare(`UPDATE work_items SET status = 'ready',
        current_action_id = ?, current_run_id = NULL, updated_at = ?
        WHERE id = ? AND status = 'cancelled' AND revision = ?`).run(
        currentAction.id,
        now,
        id,
        expectedRevision,
      );
      if (Number(changedWorkItem.changes) !== 1) {
        throw new Error('WorkItem changed before it was resumed; refresh and try again');
      }
      this.appendEvent(id, 'work_item.resumed', {
        resumedActionIds: resumedActions.map(action => action.id),
      }, {
        actionId: currentAction.id,
        actionGeneration: currentAction.generation,
      });
      return this.getWorkItemDetail(id);
    });
  }

  startWorkItemAtomic(id, makeInitialAction) {
    return withTransaction(this.db, () => {
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      if (['done', 'cancelled'].includes(workItem.status)) {
        throw new Error(`Cannot start WorkItem in ${workItem.status}`);
      }
      const current = workItem.currentActionId ? this.getAction(workItem.currentActionId) : null;
      if (current?.status === 'ready') return this.getWorkItemDetail(id);
      if (workItem.status !== 'draft') {
        throw new Error(`WorkItem in ${workItem.status} must be resumed with retry`);
      }
      const now = this.now();
      if (isDynamicWorkItem(workItem)) {
        this.db.prepare(`UPDATE work_items SET status = 'running', current_action_id = NULL,
          current_run_id = NULL, updated_at = ? WHERE id = ?`).run(now, id);
        this.enqueueCoordinatorMailbox(id, 'work_item_started', {
          trigger: { workItemId: id },
        }, `dynamic:start:${id}:${workItem.revision}`);
        this.appendEvent(id, 'work_item.started');
        return this.getWorkItemDetail(id);
      }
      const action = this.#insertAction(id, {
        ...makeInitialAction(workItem),
        contractRevision: workItem.revision,
      }, this.#nextSequence(id), now);
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, updated_at = ? WHERE id = ?`).run(action.id, now, id);
      this.appendEvent(id, 'work_item.started', {}, { actionId: action.id });
      return this.getWorkItemDetail(id);
    });
  }

  retryWorkItemAtomic(id, makeAction, options = {}) {
    return withTransaction(this.db, () => {
      const clientMessageId = typeof options.inputEvent?.clientMessageId === 'string'
        ? options.inputEvent.clientMessageId : null;
      if (clientMessageId) {
        const existing = this.db.prepare(`SELECT action_id FROM events WHERE work_item_id = ?
          AND type = 'action.input_added' AND json_extract(data, '$.clientMessageId') = ?`).get(
          id, clientMessageId,
        );
        if (existing) {
          if (existing.action_id !== options.inputEvent.targetActionId) {
            throw new Error('clientMessageId already belongs to another Action');
          }
          return this.getWorkItemDetail(id);
        }
      }
      const workItem = this.getWorkItem(id);
      if (!workItem) return null;
      const graphMode = usesLegacyGraph(workItem);
      const retryableWorkItemStatuses = graphMode
        ? ['ready', 'running', 'waiting', 'needs_attention']
        : ['waiting', 'needs_attention'];
      if (!retryableWorkItemStatuses.includes(workItem.status)) {
        throw new Error(`WorkItem in ${workItem.status} does not need retry`);
      }
      let previous = workItem.currentActionId ? this.getAction(workItem.currentActionId) : null;
      if (options.expected) {
        const expectedAction = this.getAction(options.expected.actionId);
        const allowedExpectedStatuses = Array.isArray(options.expected.statuses)
          ? options.expected.statuses
          : ['waiting', 'failed'];
        const expectedGeneration = Number(options.expected.generation);
        const hasExpectedGeneration = Number.isInteger(expectedGeneration) && expectedGeneration > 0;
        const expectedMatches = expectedAction?.workItemId === id
          && allowedExpectedStatuses.includes(expectedAction.status)
          && (graphMode || workItem.currentActionId === options.expected.actionId)
          && (hasExpectedGeneration ? expectedAction.generation === expectedGeneration : !graphMode);
        if (!expectedMatches || workItem.revision !== options.expected.revision) {
          throw new Error('Action changed before input was applied; refresh and try again');
        }
        previous = expectedAction;
      }
      const previousRun = previous
        ? mapRun(this.db.prepare(`SELECT * FROM runs WHERE work_item_id = ? AND action_id = ?
            AND status != 'running' ORDER BY ended_at DESC, started_at DESC LIMIT 1`).get(id, previous.id))
        : null;
      const now = this.now();
      const revision = options.expected ? workItem.revision + 1 : workItem.revision;
      const replacement = {
        ...makeAction(workItem, previous, previousRun),
        contractRevision: previous?.contractRevision ?? workItem.revision,
      };
      const inputEvent = options.inputEvent && typeof options.inputEvent === 'object'
        ? options.inputEvent
        : null;
      if (graphMode) {
        if (!previous) throw new Error('WorkItem graph retry target is missing');
        const action = this.#resetGraphFromStage(
          id,
          previous.stageId,
          replacement,
          'Superseded by manual graph retry',
          now,
          { preserveInputIds: inputEvent?.inputId ? [inputEvent.inputId] : [] },
        );
        this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
          current_run_id = NULL, attachments = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
          action.id,
          stringify(Array.isArray(options.attachments) ? options.attachments : workItem.attachments),
          revision,
          now,
          id,
        );
        if (inputEvent) {
          this.appendEvent(id, 'action.input_added', inputEvent, {
            actionId: action.id,
            actionGeneration: action.generation,
          });
        } else {
          this.appendEvent(id, 'work_item.retried', { targetStageId: action.stageId }, { actionId: action.id });
        }
        return this.getWorkItemDetail(id);
      }
      if (previous) {
        this.#supersedePendingActionInputs(
          [previous],
          'Superseded by linear Action retry',
          now,
        );
      }
      const action = this.#insertAction(id, replacement, this.#nextSequence(id), now);
      this.db.prepare(`UPDATE work_items SET status = 'ready', current_action_id = ?,
        current_run_id = NULL, attachments = ?, revision = ?, updated_at = ? WHERE id = ?`).run(
        action.id,
        stringify(Array.isArray(options.attachments) ? options.attachments : workItem.attachments),
        revision,
        now,
        id,
      );
      if (inputEvent) {
        this.appendEvent(id, 'action.input_added', inputEvent, {
          actionId: action.id,
          actionGeneration: action.generation,
        });
      } else {
        this.appendEvent(id, 'work_item.retried', {}, { actionId: action.id });
      }
      return this.getWorkItemDetail(id);
    });
  }

  claimReadyAction(ownerBootId, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const rows = this.db.prepare(`SELECT a.* FROM actions a
        JOIN work_items w ON w.id = a.work_item_id
        WHERE a.status = 'ready' AND a.current_run_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM actions failed_recovery
            WHERE failed_recovery.work_item_id = a.work_item_id
              AND failed_recovery.status = 'failed'
              AND COALESCE(w.coordination_mode, 'legacy') != 'dynamic'
          )
          AND NOT (
            json_extract(w.messages, '$[#-1].role') = 'assistant'
            AND json_extract(w.messages, '$[#-1].status') = 'thinking'
            AND json_type(w.messages, '$[#-1].recovery') IS NOT NULL
          )
          AND (
            (COALESCE(w.coordination_mode, 'legacy') = 'dynamic'
              AND w.status IN ('ready', 'running', 'waiting', 'needs_attention'))
            OR
            (COALESCE(w.coordination_mode, 'legacy') != 'dynamic'
              AND COALESCE(json_extract(w.workflow_snapshot, '$.executionMode'), 'linear') != 'graph'
              AND w.status = 'ready' AND w.current_action_id = a.id AND w.current_run_id IS NULL)
            OR
            (json_extract(w.workflow_snapshot, '$.executionMode') = 'graph'
              AND w.status IN ('ready', 'running', 'waiting', 'needs_attention')
              AND NOT EXISTS (
                SELECT 1 FROM json_each(a.depends_on_stage_ids) dependency
                WHERE NOT EXISTS (
                  SELECT 1 FROM actions required
                  WHERE required.id = (
                    SELECT canonical.id FROM actions canonical
                    WHERE canonical.work_item_id = a.work_item_id
                      AND canonical.stage_id = dependency.value
                      AND canonical.status NOT IN ('superseded', 'cancelled')
                    ORDER BY canonical.sequence DESC LIMIT 1
                  )
                    AND required.status = 'completed'
                )
              )
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM actions running
            JOIN work_items running_item ON running_item.id = running.work_item_id
            WHERE running.status = 'running'
              AND running_item.workspace_key != ''
              AND running_item.workspace_key = w.workspace_key
              AND (a.workspace_mode IN ('shared', 'integrate')
                OR running.workspace_mode IN ('shared', 'integrate')
                OR (running.work_item_id != a.work_item_id
                  AND a.workspace_mode != 'read' AND running.workspace_mode != 'read'))
          )
          AND NOT EXISTS (
            SELECT 1 FROM operations unsafe_operation
            WHERE unsafe_operation.work_item_id = w.id
              AND unsafe_operation.concurrency_policy = 'blocking'
              AND unsafe_operation.operation_type != 'Bash'
              AND unsafe_operation.effect_status NOT IN ('applied', 'not_applied', 'failed_no_effect')
          )
          AND NOT EXISTS (
            SELECT 1 FROM runs deferred
            WHERE deferred.action_id = a.id
              AND deferred.failure_kind = 'resource_deferred'
              AND deferred.failure_code = 'workspace_busy'
              AND EXISTS (
                SELECT 1 FROM actions blocker
                JOIN work_items blocker_item ON blocker_item.id = blocker.work_item_id
                WHERE blocker.status = 'running' AND blocker.id != a.id
                  AND blocker_item.workspace_key != ''
                  AND blocker_item.workspace_key = w.workspace_key
              )
          )
        ORDER BY a.updated_at ASC, a.sequence ASC`).all();
      const row = rows.find(candidate => !this.#hasBlockingOperation(candidate.work_item_id, candidate.id));
      if (!row) return null;
      const now = this.now();
      let action = mapAction(row);
      const readyInputs = this.db.prepare(`SELECT p.* FROM pending_action_inputs p
        JOIN events source_event ON source_event.id = p.event_id
        LEFT JOIN runs source_run ON source_run.id = p.run_id
        WHERE p.action_id = ? AND p.action_generation = ? AND p.action_spec_hash = ?
          AND p.superseded_at IS NULL
          AND source_event.type = 'action.input_added'
          AND (p.run_id IS NOT NULL OR p.consumed_at IS NULL)
          AND (p.run_id IS NULL OR source_run.status != 'running') ORDER BY p.event_id`).all(
        action.id, action.generation, action.specHash,
      );
      action = promoteReadyActionInputs(this.db, action, readyInputs, now, 'run_claim');
      const runId = randomUUID();
      const leaseEpoch = Number(action.leaseEpoch) + 1;
      const priorOrdinal = this.db.prepare(`SELECT MAX(ordinal) AS value FROM runs
        WHERE action_id = ?`).get(action.id);
      const runOrdinal = Math.max(0, Number(priorOrdinal?.value) || 0) + 1;
      const priorProgress = this.db.prepare(`SELECT MAX(progress_revision) AS value FROM runs
        WHERE action_id = ?`).get(action.id);
      const progressRevision = Math.max(0, Number(priorProgress?.value) || 0) + 1;
      const actionGeneration = action.generation;
      const priorAttempt = this.db.prepare(`SELECT MAX(action_attempt) AS value FROM runs
        WHERE action_id = ? AND action_generation = ?`).get(action.id, actionGeneration);
      const actionAttempt = Math.max(0, Number(priorAttempt?.value) || 0) + 1;
      const changedAction = this.db.prepare(`UPDATE actions SET status = 'running', attempt = attempt + 1,
        current_run_id = ?, lease_epoch = ?, updated_at = ?
        WHERE id = ? AND status = 'ready' AND current_run_id IS NULL AND generation = ? AND spec_hash = ?`).run(
        runId, leaseEpoch, now, action.id, action.generation, action.specHash,
      );
      if (Number(changedAction.changes) !== 1) return null;
      const workItem = this.getWorkItem(action.workItemId);
      const concurrentMode = usesLegacyGraph(workItem) || isDynamicWorkItem(workItem);
      const changedWorkItem = concurrentMode
        ? this.db.prepare(`UPDATE work_items SET status = 'running', current_action_id = ?,
          current_run_id = NULL, updated_at = ? WHERE id = ?
          AND status IN ('ready', 'running', 'waiting', 'needs_attention')`).run(
          action.id, now, action.workItemId,
        )
        : this.db.prepare(`UPDATE work_items SET status = 'running', current_run_id = ?, updated_at = ?
          WHERE id = ? AND status = 'ready' AND current_action_id = ? AND current_run_id IS NULL`).run(
          runId, now, action.workItemId, action.id,
        );
      if (Number(changedWorkItem.changes) !== 1) throw new Error('WorkItem claim lost its Action fence');
      this.db.prepare(`INSERT INTO runs
        (id, action_id, work_item_id, owner_boot_id, lease_epoch, ordinal, status, started_at,
         expires_at, evidence, progress_revision, action_generation, action_spec_hash, action_attempt)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, '[]', ?, ?, ?, ?)`).run(
        runId,
        action.id,
        action.workItemId,
        ownerBootId,
        leaseEpoch,
        runOrdinal,
        now,
        now + leaseMs,
        progressRevision,
        actionGeneration,
        action.specHash,
        actionAttempt,
      );
      const pendingInputs = this.db.prepare(`SELECT p.* FROM pending_action_inputs p
        LEFT JOIN runs source_run ON source_run.id = p.run_id
        WHERE p.action_id = ? AND p.action_generation = ? AND p.action_spec_hash = ?
          AND p.consumed_at IS NULL AND p.superseded_at IS NULL
          AND (p.run_id IS NULL OR source_run.status != 'running') ORDER BY p.event_id`).all(
        action.id, actionGeneration, action.specHash,
      );
      this.#rebindPendingActionInputs(action, pendingInputs, {
        runId,
        generation: actionGeneration,
        specHash: action.specHash,
      }, 'run_claim', now);
      this.appendEvent(action.workItemId, 'run.claimed', { ownerBootId, leaseEpoch }, {
        actionId: action.id, runId,
      });
      return {
        workItem: this.getWorkItem(action.workItemId),
        action: this.getAction(action.id),
        run: this.getRun(runId),
      };
    });
  }

  #activeRunRow(runId, ownerBootId, leaseEpoch, requireUnexpired = true) {
    const row = this.db.prepare(`SELECT r.* FROM runs r
      JOIN actions a ON a.id = r.action_id
      JOIN work_items w ON w.id = r.work_item_id
      WHERE r.id = ? AND r.owner_boot_id = ? AND r.lease_epoch = ? AND r.status = 'running'
        AND a.status = 'running' AND a.current_run_id = r.id AND a.lease_epoch = r.lease_epoch
        AND r.action_generation = a.generation AND r.action_spec_hash = a.spec_hash
        AND w.status IN ('ready', 'running', 'waiting', 'needs_attention')
        ${requireUnexpired ? 'AND r.expires_at > ?' : ''}`).get(
      runId, ownerBootId, leaseEpoch, ...(requireUnexpired ? [this.now()] : []),
    );
    if (!row) return null;
    const workItem = this.getWorkItem(row.work_item_id);
    if (usesLegacyGraph(workItem) || isDynamicWorkItem(workItem)) return row;
    return workItem?.status === 'running' && workItem.currentActionId === row.action_id
      && workItem.currentRunId === row.id ? row : null;
  }

  renewLease(runId, ownerBootId, leaseEpoch, leaseMs = 60_000) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return false;
      const result = this.db.prepare(`UPDATE runs SET expires_at = ?
        WHERE id = ? AND status = 'running' AND expires_at > ?`).run(
        this.now() + leaseMs,
        runId,
        this.now(),
      );
      return Number(result.changes) === 1;
    });
  }

  isActiveRun(runId, ownerBootId, leaseEpoch) {
    return !!this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
  }

  interruptRun(
    runId,
    ownerBootId,
    leaseEpoch,
    reason = 'Work Center watcher stopped',
    finalProgress = null,
  ) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, false);
      if (!active) return false;
      const action = this.getAction(active.action_id);
      const now = this.now();
      this.#assertNoIntegrationReservation([action], now);
      const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
      const hasFinalProgress = finalProgress && typeof finalProgress === 'object';
      const runChanged = hasFinalProgress
        ? this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = ?,
          response = ?, loop_count = ?, tool_count = ?, llm_request_count = ?, input_tokens = ?,
          output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ?, checkpoint = ?,
          progress_revision = progress_revision + 1
          WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
          now,
          reason,
          normalizeRunResponse(finalProgress.response),
          Math.max(0, Number(finalProgress.loopCount) || 0),
          Math.max(0, Number(finalProgress.toolCount) || 0),
          Math.max(0, Number(finalProgress.llmRequestCount) || 0),
          Math.max(0, Number(finalProgress.inputTokens) || 0),
          Math.max(0, Number(finalProgress.outputTokens) || 0),
          Math.max(0, Number(finalProgress.cacheReadTokens) || 0),
          Math.max(0, Number(finalProgress.cacheWriteTokens) || 0),
          Math.max(0, Number(finalProgress.totalTokens) || 0),
          stringify(normalizeActionCheckpoint(finalProgress.checkpoint)),
          runId,
          ownerBootId,
          leaseEpoch,
        )
        : this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = ?
          WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
          now,
          reason,
          runId,
          ownerBootId,
          leaseEpoch,
        );
      if (Number(runChanged.changes) !== 1) return false;
      this.onTransitionStep?.('after_interrupt_run_update');
      const actionChanged = this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL,
        updated_at = ? WHERE id = ? AND status = 'running' AND current_run_id = ?
        AND lease_epoch = ?`).run(
        retryable ? 'ready' : 'failed',
        now,
        action.id,
        runId,
        leaseEpoch,
      );
      if (Number(actionChanged.changes) !== 1) throw new Error('Run interruption lost the Action fence');
      const activeWorkItem = this.getWorkItem(active.work_item_id);
      const concurrentMode = usesLegacyGraph(activeWorkItem) || isDynamicWorkItem(activeWorkItem);
      const itemChanged = concurrentMode
        ? this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
          updated_at = ? WHERE id = ? AND status = 'running'`).run(
          retryable ? 'ready' : 'needs_attention', action.id, now, active.work_item_id,
        )
        : this.db.prepare(`UPDATE work_items SET status = ?, current_run_id = NULL,
          updated_at = ? WHERE id = ? AND status = 'running' AND current_action_id = ?
          AND current_run_id = ?`).run(
          retryable ? 'ready' : 'needs_attention', now, active.work_item_id, action.id, runId,
        );
      if (Number(itemChanged.changes) !== 1) throw new Error('Run interruption lost the WorkItem fence');
      this.appendEvent(active.work_item_id, 'run.interrupted', { retryable, reason }, {
        actionId: action.id,
        runId,
      });
      return true;
    });
  }

  setRunExecutionSnapshots(runId, ownerBootId, leaseEpoch, snapshots) {
    return withTransaction(this.db, () => {
      if (!this.#activeRunRow(runId, ownerBootId, leaseEpoch, true)) return false;
      const result = this.db.prepare(`UPDATE runs SET role_snapshot = ?, vp_snapshot = ?,
        model_snapshot = ?, tool_policy_snapshot = ?, context_snapshot = ?, execution_manifest = ?
        WHERE id = ? AND status = 'running'
        AND role_snapshot IS NULL AND vp_snapshot IS NULL AND model_snapshot IS NULL
        AND tool_policy_snapshot IS NULL AND context_snapshot IS NULL AND execution_manifest IS NULL`).run(
        stringify(snapshots.roleSnapshot || null),
        stringify(snapshots.vpSnapshot || null),
        stringify(snapshots.modelSnapshot || null),
        stringify(snapshots.toolPolicySnapshot || null),
        stringify(snapshots.contextSnapshot || null),
        stringify(snapshots.executionManifest || null),
        runId,
      );
      return Number(result.changes) === 1;
    });
  }

  updateRunProgress(runId, ownerBootId, leaseEpoch, progress = {}) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return null;
      const checkpoint = normalizeActionCheckpoint(progress.checkpoint);
      const result = this.db.prepare(`UPDATE runs SET response = ?, loop_count = ?, tool_count = ?,
        llm_request_count = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
        cache_write_tokens = ?, total_tokens = ?, checkpoint = ?, progress_revision = progress_revision + 1
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'`).run(
        normalizeRunResponse(progress.response),
        Math.max(0, Number(progress.loopCount) || 0),
        Math.max(0, Number(progress.toolCount) || 0),
        Math.max(0, Number(progress.llmRequestCount) || 0),
        Math.max(0, Number(progress.inputTokens) || 0),
        Math.max(0, Number(progress.outputTokens) || 0),
        Math.max(0, Number(progress.cacheReadTokens) || 0),
        Math.max(0, Number(progress.cacheWriteTokens) || 0),
        Math.max(0, Number(progress.totalTokens) || 0),
        stringify(checkpoint),
        runId,
        ownerBootId,
        leaseEpoch,
      );
      if (Number(result.changes) !== 1) return null;
      return this.getWorkItemDetail(active.work_item_id);
    });
  }

  getActionResumeContext(actionId, excludeRunId = null) {
    const action = this.getAction(actionId);
    if (!action) return null;
    const runs = this.db.prepare(`SELECT * FROM runs
      WHERE action_id = ? AND id != ? AND status IN ('interrupted', 'retryable')
      ORDER BY ended_at DESC, started_at DESC`).all(actionId, excludeRunId || '')
      .map(mapRun)
      .filter(run => runMatchesActionIdentity(run, action));
    if (runs.length === 0) return null;
    const latest = runs[0];
    const response = runs.find(run => run.response)?.response || '';
    const checkpoint = normalizeActionCheckpoint({
      toolEvents: runs.slice().reverse().flatMap(run => run.checkpoint?.toolEvents || []),
    });
    if (!response && !latest.error && (checkpoint?.toolEvents.length || 0) === 0) return null;
    return {
      status: latest.status,
      response,
      error: latest.error,
      checkpoint,
    };
  }

  closeRunInput(runId, ownerBootId, leaseEpoch) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active) return false;
      const pendingInput = this.db.prepare(`SELECT event_id FROM pending_action_inputs
        WHERE action_id = ? AND run_id = ? AND action_generation = ? AND action_spec_hash = ?
          AND consumed_at IS NULL AND superseded_at IS NULL LIMIT 1`).get(
        active.action_id, runId, active.action_generation, active.action_spec_hash,
      );
      if (pendingInput) return false;
      const changed = this.db.prepare(`UPDATE runs SET accepting_input = 0
        WHERE id = ? AND owner_boot_id = ? AND lease_epoch = ? AND status = 'running'
        AND accepting_input = 1`).run(runId, ownerBootId, leaseEpoch);
      return Number(changed.changes) === 1;
    });
  }

  finalizeRun(runId, ownerBootId, leaseEpoch, result, makeTransition) {
    return withTransaction(this.db, () => {
      const active = this.#activeRunRow(runId, ownerBootId, leaseEpoch, true);
      if (!active || Number(active.accepting_input) !== 0) return null;
      const action = this.getAction(active.action_id);
      const workItem = this.getWorkItem(active.work_item_id);
      const pendingInput = this.db.prepare(`SELECT event_id FROM pending_action_inputs
        WHERE action_id = ? AND run_id = ? AND action_generation = ? AND action_spec_hash = ?
          AND consumed_at IS NULL AND superseded_at IS NULL LIMIT 1`).get(
        action.id, runId, active.action_generation, active.action_spec_hash,
      );
      if (pendingInput) throw new Error('Run has unconsumed Action input and cannot finish yet');
      const priorRuns = this.db.prepare(`SELECT * FROM runs
        WHERE work_item_id = ? AND id != ? AND status != 'running'
        ORDER BY started_at ASC`).all(workItem.id, runId).map(mapRun);
      const transition = isDynamicWorkItem(workItem)
        ? {
            actionStatus: result.outcome === 'completed' ? 'completed'
              : result.outcome === 'waiting' ? 'waiting'
                : result.outcome === 'retryable' && action.attempt < action.maxAttempts ? 'ready' : 'failed',
            workItemStatus: result.outcome === 'retryable' && action.attempt < action.maxAttempts
              ? 'ready' : 'running',
            keepCurrentAction: false,
            eventType: result.outcome === 'completed' ? 'action.completed'
              : result.outcome === 'waiting' ? 'action.waiting' : 'action.failed',
            eventData: {
              reviewDecision: result.reviewDecision,
              error: result.error,
              reason: result.waitingReason,
            },
          }
        : makeTransition({ run: mapRun(active), action, workItem, priorRuns });
      if (!transition || !transition.actionStatus || !transition.workItemStatus) {
        throw new Error('Work Center transition plan is incomplete');
      }
      const now = this.now();
      const ledgerIncrement = workItem.executionSchemaVersion >= 2
        && ['completed', 'failed', 'waiting'].includes(result.outcome) ? 1 : 0;
      this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, response = ?, summary = ?, evidence = ?,
        outputs = ?, acceptance_checks = ?, waiting_reason = ?, error = ?, failure_kind = ?, failure_code = ?, review_decision = ?, contract_patch = ?, checkpoint = ?,
        loop_count = ?, tool_count = ?, llm_request_count = ?, input_tokens = ?, output_tokens = ?,
        cache_read_tokens = ?, cache_write_tokens = ?, total_tokens = ?,
        progress_revision = progress_revision + 1 WHERE id = ?`).run(
        result.outcome,
        now,
        normalizeRunResponse(result.response),
        result.summary || '',
        stringify(normalizeEvidence(result.evidence)),
        stringify(normalizeOutputs(result.outputs)),
        stringify(Array.isArray(result.acceptanceChecks) ? result.acceptanceChecks : []),
        result.waitingReason || null,
        result.error || null,
        result.failureKind || null,
        result.failureCode || null,
        result.reviewDecision || null,
        stringify(result.contractPatch || null),
        stringify(normalizeActionCheckpoint(result.checkpoint)),
        Math.max(0, Number(result.loopCount) || 0),
        Math.max(0, Number(result.toolCount) || 0),
        Math.max(0, Number(result.llmRequestCount) || 0),
        Math.max(0, Number(result.inputTokens) || 0),
        Math.max(0, Number(result.outputTokens) || 0),
        Math.max(0, Number(result.cacheReadTokens) || 0),
        Math.max(0, Number(result.cacheWriteTokens) || 0),
        Math.max(0, Number(result.totalTokens) || 0),
        runId,
      );
      this.onTransitionStep?.('after_run_update');

      const changedAction = this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL,
        result_run_id = CASE WHEN ? = 'completed' THEN ? ELSE result_run_id END, updated_at = ?
        WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ? AND generation = ?`).run(
        transition.actionStatus,
        result.outcome,
        runId,
        now,
        action.id,
        runId,
        leaseEpoch,
        action.generation,
      );
      if (Number(changedAction.changes) !== 1) {
        throw new Error('Work Center terminal transition lost the current Action fence');
      }

      if (transition.planConflict) {
        this.db.prepare(`INSERT INTO plan_conflicts
          (id, work_item_id, action_id, generation, kind, status, details, created_at, updated_at, resolved_at)
          VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)`).run(
          randomUUID(), workItem.id, action.id, action.generation,
          transition.planConflict.kind || 'plan', stringify(transition.planConflict), now, now,
        );
      }

      let nextWorkItem = workItem;
      if (transition.contractPatch) {
        const patch = transition.contractPatch;
        const title = patch.title ?? workItem.title;
        const goal = patch.goal ?? workItem.goal;
        const criteria = patch.acceptanceCriteria ?? workItem.acceptanceCriteria;
        this.db.prepare(`UPDATE work_items SET title = ?, goal = ?, acceptance_criteria = ?,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          title,
          goal,
          stringify(criteria),
          now,
          workItem.id,
        );
        nextWorkItem = this.getWorkItem(workItem.id);
      }
      if (transition.workflowSnapshot) {
        const expectedPlanRevision = Number.isInteger(transition.expectedPlanRevision)
          ? transition.expectedPlanRevision
          : workItem.planRevision;
        const changedPlan = this.db.prepare(`UPDATE work_items SET workflow_template = ?, workflow_snapshot = ?,
          plan_revision = plan_revision + 1, updated_at = ? WHERE id = ? AND plan_revision = ?`).run(
          transition.workflowSnapshot.id,
          stringify(transition.workflowSnapshot),
          now,
          workItem.id,
          expectedPlanRevision,
        );
        if (Number(changedPlan.changes) !== 1) {
          throw new Error('Work Center plan revision changed before finalization');
        }
        nextWorkItem = this.getWorkItem(workItem.id);
      }

      for (const patch of Array.isArray(transition.dependencyPatches) ? transition.dependencyPatches : []) {
        const actionPatch = patch.action;
        const dependencies = [...new Set([
          ...(actionPatch.dependsOnStageIds || []),
          ...(patch.addDependsOnActionIds || []),
        ])];
        const nextContext = carryCurrentActionInputContext(this.db, actionPatch);
        const nextAction = {
          ...actionPatch,
          context: nextContext,
          dependsOnStageIds: dependencies,
          generation: actionPatch.generation + 1,
        };
        nextAction.instruction = canonicalActionInstruction(nextWorkItem, nextAction, nextContext);
        nextAction.specHash = actionSpecHash(nextAction);
        this.#supersedePendingActionInputs(
          [actionPatch],
          'Superseded by Work Center dependency patch',
          now,
        );
        const changed = this.db.prepare(`UPDATE actions SET depends_on_stage_ids = ?, context = ?, instruction = ?,
          generation = generation + 1, spec_hash = ?, identity_history = ?, result_run_id = NULL,
          workspace = NULL, updated_at = ? WHERE id = ? AND work_item_id = ? AND status = 'ready'
          AND attempt = 0 AND current_run_id IS NULL AND generation = ? AND spec_hash = ?`).run(
          stringify(dependencies),
          stringify(nextContext),
          nextAction.instruction,
          nextAction.specHash,
          stringify(actionIdentityHistory(actionPatch, nextAction.generation, nextAction.specHash)),
          now,
          actionPatch.id,
          workItem.id,
          actionPatch.generation,
          actionPatch.specHash,
        );
        if (Number(changed.changes) !== 1) {
          throw new Error('Work Center dependency patch lost its unattempted Action fence');
        }
      }

      let nextAction = null;
      if (transition.replanBarrier) {
        const barrier = transition.replanBarrier;
        if (barrier.basePlanRevision !== workItem.planRevision) {
          throw new Error('Work Center replan request has a stale basePlanRevision');
        }
        const activeActions = this.db.prepare(`SELECT * FROM actions WHERE work_item_id = ?
          AND status NOT IN ('superseded', 'cancelled') ORDER BY sequence`).all(workItem.id).map(mapAction);
        this.#assertNoIntegrationReservation(activeActions, now);
        const unfinished = activeActions.filter(candidate => candidate.id !== action.id && candidate.status !== 'completed');
        this.#supersedePendingActionInputs(
          unfinished,
          'Superseded by Work Center replan barrier',
          now,
        );
        for (const candidate of unfinished) {
          if (candidate.status === 'running' && candidate.currentRunId) {
            this.db.prepare(`UPDATE runs SET status = 'superseded', ended_at = ?, error = ?
              WHERE id = ? AND status = 'running'`).run(now, 'Superseded by Work Center replan barrier', candidate.currentRunId);
          }
          this.db.prepare(`UPDATE actions SET status = 'superseded', current_run_id = NULL,
            lease_epoch = lease_epoch + 1, updated_at = ? WHERE id = ? AND status != 'completed'`).run(now, candidate.id);
        }
        const replanWorkflow = {
          ...nextWorkItem.workflowSnapshot,
          stages: [
            ...(nextWorkItem.workflowSnapshot?.stages || []).filter(stage => activeActions
              .some(candidate => candidate.stageId === stage.id && candidate.status === 'completed')),
            { ...(nextWorkItem.workflowSnapshot?.stages?.[0] || {}), id: barrier.action.stageId, type: 'triage', name: 'Replan' },
          ],
        };
        const changedPlan = this.db.prepare(`UPDATE work_items SET workflow_snapshot = ?, plan_revision = plan_revision + 1,
          updated_at = ? WHERE id = ? AND plan_revision = ?`).run(
          stringify(replanWorkflow), now, workItem.id, barrier.basePlanRevision,
        );
        if (Number(changedPlan.changes) !== 1) throw new Error('Work Center replan barrier lost its plan revision fence');
        nextWorkItem = this.getWorkItem(workItem.id);
        nextAction = this.#insertAction(workItem.id, {
          ...barrier.action,
          context: [
            ...withoutActionInputContext(barrier.action.context),
            {
              type: 'replan-barrier',
              proposalId: barrier.proposalId,
              basePlanRevision: nextWorkItem.planRevision,
              candidateActionIds: unfinished.map(candidate => candidate.id),
            },
          ],
          contractRevision: nextWorkItem.revision,
          status: 'ready',
        }, this.#nextSequence(workItem.id), now);
      }
      if (transition.replanMutation) {
        this.#supersedePendingActionInputs(
          transition.replanMutation.retain.map(entry => entry.action),
          'Superseded by Work Center replan mutation',
          now,
        );
        for (const retained of transition.replanMutation.retain) {
          const prior = retained.action;
          const candidate = {
            ...prior,
            ...retained.nextAction,
            context: withoutActionInputContext(retained.nextAction.context ?? prior.context),
            status: 'ready',
            generation: prior.generation + 1,
            attempt: 0,
            currentRunId: null,
            resultRunId: null,
            contractRevision: nextWorkItem.revision,
          };
          candidate.instruction = canonicalActionInstruction(nextWorkItem, candidate);
          const candidateSpecHash = actionSpecHash(candidate);
          const changed = this.db.prepare(`UPDATE actions SET type = ?, required_role = ?, stage_id = ?,
            assignment_policy = ?, model_policy = ?, depends_on_stage_ids = ?, workspace_mode = ?,
            changes_requested_stage_id = ?, workspace = NULL, instruction = ?, brief = ?, context = ?,
            contract_revision = ?, generation = ?, spec_hash = ?, identity_history = ?, result_run_id = NULL, status = 'ready',
            attempt = 0, max_attempts = ?, current_run_id = NULL, lease_epoch = lease_epoch + 1,
            updated_at = ? WHERE id = ? AND work_item_id = ? AND status = 'superseded' AND generation = ?`).run(
            candidate.type, candidate.requiredRole || '', candidate.stageId,
            stringify(candidate.assignmentPolicy || null), stringify(candidate.modelPolicy || null),
            stringify(candidate.dependsOnStageIds || []), candidate.workspaceMode || 'shared',
            candidate.changesRequestedStageId || null, candidate.instruction, stringify(candidate.brief || null),
            stringify(candidate.context || []), candidate.contractRevision, candidate.generation,
            candidateSpecHash, stringify(actionIdentityHistory(prior, candidate.generation, candidateSpecHash)),
            candidate.maxAttempts || 2, now,
            prior.id, workItem.id, prior.generation,
          );
          if (Number(changed.changes) !== 1) throw new Error('Work Center retained Action lost its superseded identity fence');
          if (!nextAction) nextAction = this.getAction(prior.id);
        }
        for (const replacement of transition.replanMutation.replace) {
          const inserted = this.#insertAction(workItem.id, {
            ...replacement.nextAction,
            contractRevision: nextWorkItem.revision,
            status: 'ready',
          }, this.#nextSequence(workItem.id), now);
          if (!nextAction) nextAction = inserted;
        }
        for (const added of transition.replanMutation.add) {
          const inserted = this.#insertAction(workItem.id, {
            ...added,
            contractRevision: nextWorkItem.revision,
            status: 'ready',
          }, this.#nextSequence(workItem.id), now);
          if (!nextAction) nextAction = inserted;
        }
      }
      if (transition.graphResetStageId) {
        nextAction = this.#resetGraphFromStage(
          workItem.id,
          transition.graphResetStageId,
          transition.graphResetAction,
          'Superseded by review changes request',
          now,
        );
      }
      const nextActions = Array.isArray(transition.nextActions) ? transition.nextActions : [];
      for (const candidate of nextActions) {
        const inserted = this.#insertAction(workItem.id, {
          ...candidate,
          contractRevision: nextWorkItem.revision,
        }, this.#nextSequence(workItem.id), now);
        if (!nextAction) nextAction = inserted;
      }
      if (transition.nextAction) {
        nextAction = this.#insertAction(workItem.id, {
          ...transition.nextAction,
          contractRevision: nextWorkItem.revision,
        }, this.#nextSequence(workItem.id), now);
      }
      let workItemStatus = transition.workItemStatus;
      if (workItemStatus === 'done' && this.#hasBlockingOperation(workItem.id)) {
        throw new Error('WorkItem has an unsafe blocking Operation and cannot complete');
      }
      let currentActionId = nextAction?.id ?? (transition.keepCurrentAction ? action.id : null);
      let changedWorkItem;
      if (isDynamicWorkItem(workItem)) {
        const remaining = this.db.prepare(`SELECT id, status FROM actions WHERE work_item_id = ?
          AND status IN ('ready', 'running', 'waiting', 'failed') ORDER BY sequence`).all(workItem.id);
        const running = remaining.find(candidate => candidate.status === 'running');
        const ready = remaining.find(candidate => candidate.status === 'ready');
        const settledBlocker = remaining.find(candidate => ['waiting', 'failed'].includes(candidate.status));
        if (running || ready) {
          workItemStatus = running ? 'running' : 'ready';
          currentActionId = running?.id || ready.id;
        } else {
          workItemStatus = settledBlocker?.status === 'waiting' ? 'waiting'
            : settledBlocker ? 'needs_attention' : 'running';
          currentActionId = settledBlocker?.id || null;
        }
        changedWorkItem = this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
          current_run_id = NULL, ledger_revision = ledger_revision + ?, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'waiting', 'needs_attention')
          AND revision = ?`).run(
          workItemStatus, currentActionId, ledgerIncrement, now, workItem.id, nextWorkItem.revision,
        );
      } else if (transition.planConflict) {
        changedWorkItem = this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
          current_run_id = NULL, ledger_revision = ledger_revision + ?, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'waiting', 'needs_attention') AND revision = ?`).run(
          workItemStatus, currentActionId, ledgerIncrement, now, workItem.id, nextWorkItem.revision,
        );
      } else if (transition.graphAdvance) {
        const graphState = this.#graphWorkItemState(workItem.id);
        workItemStatus = graphState.status;
        currentActionId = graphState.currentActionId;
        changedWorkItem = this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
          current_run_id = NULL, ledger_revision = ledger_revision + ?, updated_at = ?
          WHERE id = ? AND status IN ('ready', 'running', 'waiting', 'needs_attention')
          AND revision = ?`).run(
          workItemStatus, currentActionId, ledgerIncrement, now, workItem.id, nextWorkItem.revision,
        );
      } else {
        changedWorkItem = this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
          current_run_id = NULL, ledger_revision = ledger_revision + ?, updated_at = ? WHERE id = ? AND current_run_id = ?
          AND current_action_id = ? AND status = 'running' AND revision = ?`).run(
          workItemStatus, currentActionId, ledgerIncrement, now, workItem.id, runId, action.id, nextWorkItem.revision,
        );
      }
      if (Number(changedWorkItem.changes) !== 1) {
        throw new Error('Work Center terminal transition lost the current WorkItem fence');
      }
      if (transition.workflowSnapshot || transition.replanBarrier) {
        const proposalId = transition.proposalId || transition.replanBarrier?.proposalId;
        if (!proposalId) throw new Error('Work Center plan mutation requires proposalId');
        try {
          this.db.prepare(`INSERT INTO plan_audits
            (work_item_id, proposal_id, base_plan_revision, plan_revision, kind, action_id, run_id, data, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            workItem.id, proposalId, workItem.planRevision, nextWorkItem.planRevision,
            (transition.replanBarrier || transition.replanMutation)
              ? 'replan'
              : (workItem.planRevision === 0 ? 'initial' : 'expand'),
            action.id, runId, stringify(transition.eventData || {}), now,
          );
        } catch (error) {
          if (String(error?.message || '').includes('UNIQUE constraint failed')) {
            throw new Error(`Work Center plan proposal was already applied: ${proposalId}`);
          }
          throw error;
        }
      }
      this.onTransitionStep?.('before_event');
      this.appendEvent(workItem.id, transition.eventType, {
        ...(transition.eventData || {}),
        ...((transition.workflowSnapshot || transition.replanBarrier) ? {
          proposalId: transition.proposalId || transition.replanBarrier?.proposalId || null,
          previousPlanRevision: workItem.planRevision,
          planRevision: nextWorkItem.planRevision,
        } : {}),
      }, {
        actionId: action.id,
        runId,
      });
      if (isDynamicWorkItem(workItem)) {
        this.#enqueueDynamicReconciliation(workItem.id, { runId });
      }
      return this.getWorkItemDetail(workItem.id);
    });
  }

  #enqueueDynamicReconciliation(workItemId, trigger = {}) {
    const detail = this.getWorkItemDetail(workItemId);
    if (!isDynamicWorkItem(detail)
        || (detail.actions || []).some(action => ['ready', 'running'].includes(action.status))) return null;
    return this.enqueueCoordinatorMailbox(workItemId, 'action_settled', {
      trigger: {
        ...trigger,
        ledgerRevision: detail.ledgerRevision,
        actionIds: (detail.actions || [])
          .filter(action => !['completed', 'closed', 'superseded', 'cancelled'].includes(action.status))
          .map(action => action.id),
      },
    }, `dynamic:reconcile:${workItemId}:${detail.ledgerRevision}`);
  }

  #refreshGraphWorkItem(workItemId, now) {
    const remaining = this.db.prepare(`SELECT id, status FROM actions WHERE work_item_id = ?
      AND status IN ('ready', 'running', 'waiting', 'failed') ORDER BY sequence`).all(workItemId);
    const blocked = remaining.find(action => action.status === 'waiting' || action.status === 'failed');
    const running = remaining.find(action => action.status === 'running');
    const ready = remaining.find(action => action.status === 'ready');
    const status = blocked ? (blocked.status === 'waiting' ? 'waiting' : 'needs_attention')
      : running ? 'running' : ready ? 'ready' : 'done';
    const currentActionId = blocked?.id || running?.id || ready?.id || null;
    this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
      updated_at = ? WHERE id = ?`).run(status, currentActionId, now, workItemId);
  }

  recoverInterruptedCoordinatorTurns() {
    return withTransaction(this.db, () => {
      const recoverableTurnIds = new Set(
        this.getRecoverableCoordinatorTurns().map(turn => turn.turnId),
      );
      const now = this.now();
      let recovered = 0;
      for (const row of this.db.prepare(`SELECT id, messages, coordinator_revision FROM work_items
        WHERE json_extract(messages, '$[#-1].role') = 'assistant'
          AND json_extract(messages, '$[#-1].status') = 'thinking'`).all()) {
        const messages = parseJson(row.messages, []);
        const index = messages.length - 1;
        if (index < 0 || messages[index]?.role !== 'assistant' || messages[index]?.status !== 'thinking') continue;
        if (recoverableTurnIds.has(messages[index].turnId)) continue;
        messages[index] = {
          ...messages[index],
          status: 'failed',
          updatedAt: now,
          error: 'Coordinator turn was interrupted before it produced a decision',
        };
        const changed = this.db.prepare(`UPDATE work_items SET messages = ?,
          coordinator_revision = coordinator_revision + 1, updated_at = ?
          WHERE id = ? AND coordinator_revision = ?`).run(
          stringify(messages), now, row.id, row.coordinator_revision,
        );
        if (Number(changed.changes) !== 1) continue;
        const turnId = messages[index].turnId || null;
        if (turnId) {
          const providerStatus = this.db.prepare(`SELECT status FROM coordinator_provider_turns
            WHERE coordinator_turn_id = ? ORDER BY attempt_number DESC LIMIT 1`).get(turnId)?.status || null;
          if (messages[index].automatic === true && providerStatus === null) {
            this.db.prepare(`UPDATE coordinator_mailbox_entries SET status = 'pending', acked_at = NULL,
              claim_owner = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE json_extract(payload, '$.turnId') = ? AND status != 'cancelled'`).run(now, turnId);
          } else {
            this.db.prepare(`UPDATE coordinator_mailbox_entries SET status = 'acked', acked_at = ?,
              claim_owner = NULL, claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
              WHERE json_extract(payload, '$.turnId') = ? AND status != 'acked'`).run(now, now, turnId);
          }
        }
        this.appendEvent(row.id, 'coordinator.turn_interrupted', {
          turnId: messages[index].turnId || null,
          error: messages[index].error,
        });
        recovered += 1;
      }
      return recovered;
    });
  }

  recoverInterruptedRuns(ownerBootId) {
    return withTransaction(this.db, () => {
      const now = this.now();
      const rows = this.db.prepare(`SELECT * FROM runs
        WHERE status = 'running' AND (owner_boot_id != ? OR expires_at <= ?)`).all(ownerBootId, now);
      let recovered = 0;
      for (const row of rows) {
        const action = this.getAction(row.action_id);
        if (this.#hasActiveIntegrationReservation(action, now)) continue;
        const workItem = this.getWorkItem(row.work_item_id);
        const graphMode = usesLegacyGraph(workItem);
        const concurrentMode = graphMode || isDynamicWorkItem(workItem);
        const isCurrent = action?.status === 'running'
          && action.currentRunId === row.id
          && action.leaseEpoch === row.lease_epoch
          && workItem?.status === 'running'
          && (concurrentMode || (workItem.currentActionId === action.id && workItem.currentRunId === row.id));
        if (!isCurrent) {
          const staleStatus = workItem?.status === 'cancelled' ? 'cancelled' : 'superseded';
          const stillOwnsAction = action?.status === 'running'
            && action.currentRunId === row.id
            && action.leaseEpoch === row.lease_epoch;
          if (stillOwnsAction) {
            const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
            this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL, updated_at = ?
              WHERE id = ? AND status = 'running' AND current_run_id = ? AND lease_epoch = ?`).run(
              retryable ? 'ready' : 'failed', now, action.id, row.id, row.lease_epoch,
            );
          }
          this.db.prepare(`UPDATE runs SET status = ?, ended_at = ?, error = ?
            WHERE id = ? AND status = 'running'`).run(
            staleStatus,
            now,
            'Run no longer owns the current WorkItem Action',
            row.id,
          );
          this.appendEvent(row.work_item_id, 'run.stale_recovered', { status: staleStatus }, {
            actionId: row.action_id,
            runId: row.id,
          });
          if (concurrentMode && workItem) {
            const state = this.#graphWorkItemState(workItem.id);
            this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
              updated_at = ? WHERE id = ?`).run(state.status, state.currentActionId, now, workItem.id);
          }
          recovered += 1;
          continue;
        }

        this.db.prepare(`UPDATE runs SET status = 'interrupted', ended_at = ?,
          error = 'Agent process or lease ended before the Run submitted a terminal outcome'
          WHERE id = ?`).run(now, row.id);
        const retryable = action.type !== 'deliver' && action.attempt < action.maxAttempts;
        this.db.prepare(`UPDATE actions SET status = ?, current_run_id = NULL, updated_at = ?
          WHERE id = ?`).run(retryable ? 'ready' : 'failed', now, action.id);
        if (concurrentMode) {
          const state = this.#graphWorkItemState(workItem.id);
          this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?, current_run_id = NULL,
            updated_at = ? WHERE id = ?`).run(state.status, state.currentActionId, now, workItem.id);
        } else {
          this.db.prepare(`UPDATE work_items SET status = ?, current_action_id = ?,
            current_run_id = NULL, updated_at = ? WHERE id = ?`).run(
            retryable ? 'ready' : 'needs_attention',
            action.id,
            now,
            workItem.id,
          );
        }
        this.appendEvent(workItem.id, 'run.interrupted', { retryable }, {
          actionId: action.id,
          runId: row.id,
        });
        if (isDynamicWorkItem(workItem) && !retryable) {
          this.#enqueueDynamicReconciliation(workItem.id, { runId: row.id, interrupted: true });
        }
        recovered += 1;
      }
      return recovered;
    });
  }
}
