import { realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkItemStore } from './store.js';
import { WorkflowController } from './controller.js';
import { WorkItemWatcher } from './watcher.js';
import {
  appendWorkItemAttachments,
  persistWorkItemAttachments,
  readWorkItemAttachment,
  removeWorkItemAttachmentFiles,
  removeWorkItemAttachments,
} from './attachments.js';
import { normalizeSessionContextSnapshot } from './session-context.js';
import {
  projectActionMessagePage,
  projectActionRequestDetail,
  projectActionRequestIndex,
  projectWorkItemDetail,
  projectWorkItemSummary,
} from './projection.js';
import { readWorkCenterSettings, writeWorkCenterSettings } from './settings.js';
import {
  defaultWorkCenterStageInstructions,
  listWorkItemTypeTemplates,
} from './workflow.js';
import {
  DYNAMIC_COORDINATION_MODE,
  DYNAMIC_EXECUTION_SCHEMA_VERSION,
  resolveDynamicActionPolicySnapshot,
} from './dynamic-coordination.js';

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function requiredWorkDir(value) {
  const workDir = requiredString(value, 'workDir');
  let canonical;
  try {
    canonical = realpathSync(resolve(workDir));
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('workDir must be an existing directory');
  }
  return canonical;
}

function boardCursor(item) {
  return Buffer.from(JSON.stringify([Number(item.updatedAt) || 0, String(item.id || '')]), 'utf8')
    .toString('base64url');
}

function parseBoardCursor(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(Number(parsed[0]))) return null;
    return [Number(parsed[0]), String(parsed[1] || '')];
  } catch {
    return null;
  }
}

function removeUnpersistedAttachmentFiles(root, workItemId, addedAttachments, detail) {
  if (!Array.isArray(addedAttachments) || addedAttachments.length === 0) return;
  const persistedIds = new Set((Array.isArray(detail?.attachments) ? detail.attachments : [])
    .map(attachment => attachment?.id).filter(Boolean));
  const unpersisted = addedAttachments.filter(attachment => !persistedIds.has(attachment?.id));
  if (unpersisted.length > 0) removeWorkItemAttachmentFiles(root, workItemId, unpersisted);
}

function listBoardItems(store, payload) {
  const limit = Math.min(Math.max(Number(payload.limit) || 100, 1), 200);
  const cursor = parseBoardCursor(payload.cursor);
  const lane = ['needs_attention', 'active', 'closed'].includes(payload.lane) ? payload.lane : null;
  const vpId = typeof payload.vpId === 'string' ? payload.vpId.trim() : '';
  const workItemType = typeof payload.workItemType === 'string' ? payload.workItemType.trim() : '';
  const projected = store.listWorkItems({
    ...payload,
    lane,
    vpId,
    workItemType,
    cursorUpdatedAt: cursor?.[0],
    cursorId: cursor?.[1],
    limit: limit + 1,
  }).map(projectWorkItemSummary);
  const items = projected.slice(0, limit);
  return {
    items,
    nextCursor: projected.length > limit && items.length > 0 ? boardCursor(items.at(-1)) : null,
  };
}

export class WorkCenterService {
  constructor(options) {
    const yeaftDir = requiredString(options?.yeaftDir, 'yeaftDir');
    this.yeaftDir = yeaftDir;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.settingsReader = options.settingsReader || readWorkCenterSettings;
    this.settingsWriter = options.settingsWriter || writeWorkCenterSettings;
    this.runtimeInfoProvider = typeof options.runtimeInfoProvider === 'function'
      ? options.runtimeInfoProvider
      : async () => ({ vps: [], models: [], primaryModel: null, fastModel: null });
    this.runtimeInfo = async () => {
      const settings = this.settingsReader(this.yeaftDir);
      return {
        ...(await this.runtimeInfoProvider()),
        defaultStageInstructions: defaultWorkCenterStageInstructions(),
        workItemTypes: listWorkItemTypeTemplates(settings),
      };
    };
    this.ownerBootId = options.ownerBootId || randomUUID();
    this.attachmentRoot = options.attachmentRoot || join(yeaftDir, 'work-center', 'attachments');
    this.store = options.store || new WorkItemStore(join(yeaftDir, 'work-center', 'work-center.db'));
    this.controller = options.controller || new WorkflowController(this.store, {
      listAvailableVpIds: options.listAvailableVpIds,
    });
    this.coordinator = options.coordinator || null;
    if (this.coordinator) this.coordinator.ownerBootId = this.ownerBootId;
    this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    this.recoveryTasks = new Map();
    this.recoveryQueue = new Map();
    this.recoveryPollIntervalMs = Number(options.pollIntervalMs) > 0
      ? Number(options.pollIntervalMs)
      : 2_000;
    this.recoveryTimer = null;
    this.dynamicCoordinatorTasks = new Map();
    this.shuttingDown = false;
    this.watcher = new WorkItemWatcher({
      store: this.store,
      controller: this.controller,
      runner: options.runner,
      ownerBootId: this.ownerBootId,
      onEvent: event => this.#emit(event),
      pollIntervalMs: options.pollIntervalMs,
      leaseMs: options.leaseMs,
      concurrencyProvider: options.watcherOptions?.concurrencyProvider,
    });
    this.store.recoverInterruptedRuns(this.ownerBootId);
  }

  projectBrowserDetail(detail) {
    if (!detail) return null;
    const actions = Array.isArray(detail.actions) ? detail.actions : [];
    const actionId = detail.currentActionId && actions.some(action => action?.id === detail.currentActionId)
      ? detail.currentActionId
      : [...actions].sort((left, right) => (
          Number(right?.sequence || 0) - Number(left?.sequence || 0)
            || String(right?.id || '').localeCompare(String(left?.id || ''))
        ))[0]?.id || null;
    return projectWorkItemDetail(detail, {
      bodyActionEvents: actionId ? this.store.listActionEvents(actionId) : detail.events,
    });
  }

  async handle(op, payload = {}, requestContext = {}) {
    switch (op) {
      case 'list': {
        const page = listBoardItems(this.store, payload);
        return {
          ...page,
          watcher: this.watcher.status(),
        };
      }
      case 'get':
        return this.#requiredItem(payload.id);
      case 'get_action_messages': {
        const detail = this.#requiredItem(payload.id);
        const action = this.#requiredAction(detail, payload.actionId);
        const expectedGeneration = payload.generation == null
          ? Number(action.generation)
          : Number(payload.generation);
        if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
          throw new Error('generation must be a positive integer');
        }
        if (Number(action.generation) !== expectedGeneration) {
          throw new Error('Action generation changed before messages were loaded');
        }
        return projectActionMessagePage(action, detail.runs, this.store.listActionEvents(action.id), {
          cursor: payload.cursor,
          limit: payload.limit,
        });
      }
      case 'get_action_requests': {
        const detail = this.#requiredItem(payload.id);
        const action = this.#requiredAction(detail, payload.actionId);
        const expectedGeneration = Number(payload.generation);
        if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
          throw new Error('generation must be a positive integer');
        }
        const currentGeneration = Math.max(1, Number(action.generation) || 1);
        if (currentGeneration !== expectedGeneration) {
          throw new Error('Action generation changed before requests were loaded');
        }
        const entries = [];
        for (const run of detail.runs.filter(item => item.actionId === action.id)) {
          const history = await this.#debugHistory(run, { indexOnly: true });
          for (const turn of Array.isArray(history?.turns) ? history.turns : []) {
            entries.push({ run, turn });
          }
        }
        return projectActionRequestIndex(action, entries);
      }
      case 'get_action_request': {
        const detail = this.#requiredItem(payload.id);
        const action = this.#requiredAction(detail, payload.actionId);
        const expectedGeneration = Number(payload.generation);
        if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
          throw new Error('generation must be a positive integer');
        }
        const currentGeneration = Math.max(1, Number(action.generation) || 1);
        if (currentGeneration !== expectedGeneration) {
          throw new Error('Action generation changed before request detail was loaded');
        }
        const requestId = requiredString(payload.requestId, 'requestId');
        const run = detail.runs.find(item => item.actionId === action.id && item.id === payload.runId);
        if (!run) throw new Error('Action request not found');
        const history = await this.#debugHistory(run, { detailTurnId: requestId });
        const projected = projectActionRequestDetail(action, run, history, detail.runs);
        if (!projected) throw new Error('Action request detail is no longer available');
        return projected;
      }
      case 'get_settings': {
        const settings = this.settingsReader(this.yeaftDir);
        return { settings, runtime: await this.runtimeInfo() };
      }
      case 'update_settings': {
        const settings = this.settingsWriter(this.yeaftDir, payload.settings);
        return { settings, runtime: await this.runtimeInfo() };
      }
      case 'create': {
        const settings = this.settingsReader(this.yeaftDir);
        const workflowTemplate = 'coordinator-driven';
        const workflowSnapshot = resolveDynamicActionPolicySnapshot(settings, payload.workItemType);
        const runtime = !Object.hasOwn(payload, 'workDir') && !settings.defaultWorkDir
          ? await this.runtimeInfo()
          : null;
        const workDir = requiredWorkDir(Object.hasOwn(payload, 'workDir')
          ? payload.workDir
          : settings.defaultWorkDir || runtime?.defaultWorkDir);
        const workItemId = randomUUID();
        let attachments = [];
        try {
          attachments = persistWorkItemAttachments(payload.files, {
            root: this.attachmentRoot,
            workItemId,
          });
          const scheduledFor = payload.scheduledFor == null || payload.scheduledFor === ''
            ? null : Number(payload.scheduledFor);
          if (scheduledFor != null && (!Number.isSafeInteger(scheduledFor) || scheduledFor <= this.now())) {
            throw new Error('scheduledFor must be in the future');
          }
          const shouldStart = scheduledFor == null
            && (payload.start === undefined ? settings.startImmediately : payload.start !== false);
          const goal = requiredString(payload.goal, 'goal');
          const explicitTitle = payload.titleSource !== 'coordinator_pending' && typeof payload.title === 'string'
            ? payload.title.trim() : '';
          const requestedCriteria = Array.isArray(payload.acceptanceCriteria)
            ? payload.acceptanceCriteria.map(value => String(value).trim()).filter(Boolean) : [];
          this.controller.create({
            id: workItemId,
            // Goal remains the original requirement. Until coordination succeeds,
            // title is only a backwards-compatible display fallback.
            title: explicitTitle || goal.replace(/\s+/g, ' ').slice(0, 80),
            titleSource: explicitTitle ? 'explicit' : 'coordinator_pending',
            goal,
            // With no separate criteria, the user's goal itself is the minimum
            // contract. Do not force a follow-up or invent broader requirements.
            acceptanceCriteria: requestedCriteria.length ? requestedCriteria : [goal],
            workflowTemplate,
            workflowSnapshot,
            coordinationMode: DYNAMIC_COORDINATION_MODE,
            executionSchemaVersion: DYNAMIC_EXECUTION_SCHEMA_VERSION,
            workDir,
            // Creation-time delivery authority comes only from an explicit
            // browser/user request. Trusted model producers may provide
            // Session provenance, but cannot grant themselves delivery rights.
            deliveryTarget: requestContext.userOriginated === true
              && ['response', 'workspace_files', 'pull_request', 'merge'].includes(payload.deliveryTarget)
              ? payload.deliveryTarget : null,
            reuseMemory: payload.reuseMemory !== false,
            origin: payload.origin && typeof payload.origin === 'object'
              ? {
                  sessionId: typeof payload.origin.sessionId === 'string' ? payload.origin.sessionId : null,
                  messageId: typeof payload.origin.messageId === 'string' ? payload.origin.messageId : null,
                  createdBy: typeof payload.origin.createdBy === 'string' ? payload.origin.createdBy : null,
                  trustedSession: requestContext.trustedProducer === true,
                }
              : null,
            linkedSessionIds: Array.isArray(payload.linkedSessionIds)
              ? [...new Set(payload.linkedSessionIds.map(value => String(value).trim()).filter(Boolean))]
              : [],
            sessionContext: requestContext.trustedProducer === true
              ? normalizeSessionContextSnapshot(payload.sessionContext)
              : [],
            attachments,
            schedule: scheduledFor == null ? null : {
              status: payload.scheduleEnabled === false ? 'paused' : 'scheduled',
              scheduledFor,
            },
            start: false,
          });
          let detail = this.#requiredItem(workItemId);
          if (shouldStart) {
            detail = this.controller.start(workItemId);
            this.#queueDynamicCoordinatorWake(workItemId);
          }
          this.#emit({ type: 'work_item.created', workItem: detail });
          return detail;
        } catch (error) {
          removeWorkItemAttachments(this.attachmentRoot, workItemId);
          throw error;
        }
      }
      case 'update': {
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.update(id, payload.patch || {});
        this.watcher.abortInvalidWorkItemRuns(id);
        if (detail.coordinationMode === DYNAMIC_COORDINATION_MODE) {
          this.#queueDynamicCoordinatorWake(id);
        }
        this.#emit({ type: 'work_item.updated', workItem: detail });
        return detail;
      }
      case 'update_schedule': {
        const id = requiredString(payload.id, 'id');
        const detail = this.store.updateWorkItemSchedule(id, payload.schedule || payload);
        if (!detail) throw new Error(`WorkItem not found: ${id}`);
        this.#emit({ type: 'work_item.schedule_updated', workItem: detail });
        return detail;
      }
      case 'start': {
        const detail = this.controller.start(requiredString(payload.id, 'id'));
        if (detail.coordinationMode === DYNAMIC_COORDINATION_MODE) {
          this.#queueDynamicCoordinatorWake(detail.id);
        }
        this.#emit({ type: 'work_item.started', workItem: detail });
        return detail;
      }
      case 'cancel': {
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.cancel(id);
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'work_item.cancelled', workItem: detail });
        return detail;
      }
      case 'extend_budget': {
        if (requestContext.userOriginated !== true) throw new Error('Only explicit user requests can extend execution budget');
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.extendBudget(id, payload);
        this.#emit({ type: 'work_item.execution_budget_extended', workItem: detail });
        return detail;
      }
      case 'resume': {
        if (requestContext.userOriginated !== true) throw new Error('Only explicit user requests can resume execution');
        const id = requiredString(payload.id, 'id');
        if (!Number.isSafeInteger(payload.executionControlRevision)) {
          throw new Error('executionControlRevision is required to resume a WorkItem');
        }
        const detail = this.controller.resume(id, { revision: payload.revision,
          executionControlRevision: payload.executionControlRevision });
        this.watcher.abortInvalidWorkItemRuns(id);
        if (detail.coordinationMode === DYNAMIC_COORDINATION_MODE) {
          this.#queueDynamicCoordinatorWake(id);
        }
        this.#emit({ type: 'work_item.resumed', workItem: detail });
        return detail;
      }
      case 'delete': {
        const id = requiredString(payload.id, 'id');
        const deleted = this.store.deleteWorkItemAtomic(id, Number(payload.revision));
        if (!deleted) throw new Error(`WorkItem not found: ${id}`);
        for (const action of deleted.actions || []) {
          try { this.watcher.runner?.cleanup?.(action); } catch {}
        }
        let cleanupWarning = null;
        try { removeWorkItemAttachments(this.attachmentRoot, id); } catch {
          cleanupWarning = 'WorkItem data was deleted, but attachment cleanup needs maintenance';
        }
        this.#emit({ type: 'work_item.deleted', workItem: { id, revision: deleted.revision } });
        return { id, deleted: true, cleanupWarning };
      }
      case 'post_work_item_message': {
        const clientMessageId = requiredString(payload.clientMessageId, 'clientMessageId');
        const target = payload.target && typeof payload.target === 'object' ? payload.target : {};
        if (target.kind === 'coordinator') {
          const receipt = this.store.getCoordinatorClientMessageReceipt(payload.id, clientMessageId);
          if (receipt) return { accepted: true, turnId: receipt.turnId || null, duplicate: true };
          return this.handle('work_item_message', { ...payload, clientMessageId }, requestContext);
        }
        if (target.kind === 'action') {
          if (this.store.hasActionInputClientMessage(payload.id, target.actionId, clientMessageId)) {
            return this.store.getWorkItemDetail(payload.id);
          }
          return this.handle('action_input', {
            ...payload,
            clientMessageId,
            actionId: target.actionId,
            generation: target.generation,
          }, requestContext);
        }
        if (target.kind === 'request') {
          const id = requiredString(payload.id, 'id');
          const workItem = this.#requiredItem(id);
          const action = this.#requiredAction(workItem, target.actionId);
          if (action.status === 'failed' && !String(payload.text || '').trim()
              && (!Array.isArray(payload.files) || payload.files.length === 0)) {
            const detail = this.controller.retry(id, {
              expected: {
                actionId: action.id,
                revision: payload.revision,
                generation: target.generation,
                statuses: ['failed'],
              },
            });
            this.watcher.abortInvalidWorkItemRuns(id);
            this.#emit({ type: 'action.retried', workItem: detail });
            return detail;
          }
          return this.handle('action_input', {
            ...payload,
            clientMessageId,
            actionId: target.actionId,
            generation: target.generation,
          }, requestContext);
        }
        throw new Error('WorkItem message target is invalid');
      }
      case 'work_item_message': {
        if (!this.coordinator) throw new Error('Work Center Coordinator is unavailable');
        const id = requiredString(payload.id, 'id');
        const workItem = this.#requiredItem(id);
        let addedAttachments = [];
        let turn;
        try {
          addedAttachments = appendWorkItemAttachments(workItem.attachments, payload.files, {
            root: this.attachmentRoot,
            workItemId: id,
          });
          turn = this.coordinator.message(id, {
            text: typeof payload.text === 'string' ? payload.text : '',
            revision: payload.revision,
            planRevision: payload.planRevision,
            ledgerRevision: payload.ledgerRevision,
            coordinatorRevision: payload.coordinatorRevision,
            clientMessageId: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : null,
            quote: payload.quote,
            addedAttachments,
            attachments: [...(workItem.attachments || []), ...addedAttachments],
          }, {
            onUpdate: (type, nextWorkItem) => {
              this.watcher.abortInvalidWorkItemRuns(id);
              this.#emit({
                type,
                clientMessageId: typeof payload.clientMessageId === 'string'
                  ? payload.clientMessageId : null,
                workItem: nextWorkItem,
              });
            },
          });
        } catch (error) {
          try {
            if ((workItem.attachments || []).length === 0 && addedAttachments.length > 0) {
              removeWorkItemAttachments(this.attachmentRoot, id);
            } else {
              removeWorkItemAttachmentFiles(this.attachmentRoot, id, addedAttachments);
            }
          } catch {}
          throw error;
        }
        removeUnpersistedAttachmentFiles(this.attachmentRoot, id, addedAttachments, turn.detail);
        turn.task.catch(() => {});
        return { accepted: true, turnId: turn.detail.messages?.at(-1)?.turnId || null };
      }
      case 'retry_action': {
        const id = requiredString(payload.id, 'id');
        const detail = this.controller.retry(id, {
          expected: {
            actionId: typeof payload.actionId === 'string' ? payload.actionId : '',
            revision: payload.revision,
            generation: payload.generation,
            statuses: ['failed'],
          },
        });
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'action.retried', workItem: detail });
        return detail;
      }
      case 'action_input': {
        const id = requiredString(payload.id, 'id');
        const generation = Number(payload.generation);
        if (!Number.isInteger(generation) || generation < 1) {
          throw new Error('generation must be a positive integer');
        }
        const workItem = this.#requiredItem(id);
        this.#requiredAction(workItem, payload.actionId);
        let addedAttachments = [];
        let detail;
        try {
          addedAttachments = appendWorkItemAttachments(workItem.attachments, payload.files, {
            root: this.attachmentRoot,
            workItemId: id,
          });
          detail = this.controller.input(id, {
            text: typeof payload.text === 'string' ? payload.text : '',
            actionId: typeof payload.actionId === 'string' ? payload.actionId : '',
            revision: payload.revision,
            generation,
            clientMessageId: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : null,
            quote: payload.quote,
            addedAttachmentCount: addedAttachments.length,
            addedAttachments,
            attachments: [...(workItem.attachments || []), ...addedAttachments],
          });
        } catch (error) {
          try {
            if ((workItem.attachments || []).length === 0 && addedAttachments.length > 0) {
              removeWorkItemAttachments(this.attachmentRoot, id);
            } else {
              removeWorkItemAttachmentFiles(this.attachmentRoot, id, addedAttachments);
            }
          } catch {}
          throw error;
        }
        removeUnpersistedAttachmentFiles(this.attachmentRoot, id, addedAttachments, detail);
        this.watcher.abortInvalidWorkItemRuns(id);
        this.watcher.notifyActionInput(id, payload.actionId);
        this.#emit({
          type: 'action.input_added',
          actionId: payload.actionId,
          clientMessageId: typeof payload.clientMessageId === 'string' ? payload.clientMessageId : null,
          workItem: detail,
        });
        return detail;
      }
      case 'guide': {
        const id = requiredString(payload.id, 'id');
        const workItem = this.#requiredItem(id);
        let addedAttachments = [];
        let detail;
        try {
          addedAttachments = appendWorkItemAttachments(workItem.attachments, payload.files, {
            root: this.attachmentRoot,
            workItemId: id,
          });
          detail = this.controller.guide(id, {
            guidance: typeof payload.guidance === 'string' ? payload.guidance : '',
            actionId: typeof payload.actionId === 'string' ? payload.actionId : '',
            revision: payload.revision,
            generation: payload.generation,
            addedAttachmentCount: addedAttachments.length,
            addedAttachments,
            attachments: [...(workItem.attachments || []), ...addedAttachments],
          });
        } catch (error) {
          try {
            if ((workItem.attachments || []).length === 0 && addedAttachments.length > 0) {
              removeWorkItemAttachments(this.attachmentRoot, id);
            } else {
              removeWorkItemAttachmentFiles(this.attachmentRoot, id, addedAttachments);
            }
          } catch {}
          throw error;
        }
        this.watcher.abortInvalidWorkItemRuns(id);
        this.#emit({ type: 'action.guidance_added', workItem: detail });
        return detail;
      }
      case 'preview_attachment': {
        const id = requiredString(payload.id, 'id');
        const attachment = readWorkItemAttachment(
          this.#requiredItem(id),
          requiredString(payload.attachmentId, 'attachmentId'),
          { root: this.attachmentRoot },
        );
        return {
          attachment: {
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            isImage: attachment.isImage,
          },
          previewData: {
            data: attachment.data,
            mimeType: attachment.mimeType,
            filename: attachment.name,
          },
        };
      }
      case 'set_watcher':
        if (payload.enabled === false) await this.watcher.stop();
        else this.watcher.start();
        return this.watcher.status();
      default:
        throw new Error(`Unsupported Work Center operation: ${op || '(missing)'}`);
    }
  }

  #requiredItem(id) {
    const item = this.store.getWorkItemDetail(requiredString(id, 'id'));
    if (!item) throw new Error(`WorkItem not found: ${id}`);
    return item;
  }

  #requiredAction(detail, actionId) {
    const id = requiredString(actionId, 'actionId');
    const action = detail.actions.find(item => item.id === id);
    if (!action) throw new Error(`Action not found: ${id}`);
    return action;
  }

  async #debugHistory(run, options = {}) {
    const trace = this.watcher.runner?.trace;
    if (!trace || typeof trace.fetchRecentDebugHistory !== 'function') {
      return { turns: [], loops: [] };
    }
    return trace.fetchRecentDebugHistory({
      limit: 10,
      dreamLimit: 0,
      sessionId: `work-item-${run.workItemId}`,
      threadId: run.id,
      indexOnly: options.indexOnly === true,
      detailTurnId: options.detailTurnId || null,
    });
  }

  #emit(event) {
    try { this.onEvent(event); } catch {}
    if (event?.workItem?.coordinationMode === DYNAMIC_COORDINATION_MODE) {
      this.#queueDynamicCoordinatorWake(event.workItem.id);
      return;
    }
    if (['run.finished', 'coordinator.turn_completed'].includes(event?.type)) {
      for (const action of event.workItem?.actions || []) {
        if (action.status !== 'failed') continue;
        this.#enqueueFailureRecovery({
          workItemId: event.workItem.id,
          actionId: action.id,
          actionGeneration: action.generation,
        });
      }
    }
  }

  #queueDynamicCoordinatorWake(workItemId) {
    if (this.shuttingDown || !this.coordinator || !workItemId
        || this.dynamicCoordinatorTasks.has(workItemId)) return;
    this.dynamicCoordinatorTasks.set(workItemId, null);
    queueMicrotask(() => {
      if (this.dynamicCoordinatorTasks.get(workItemId) === null) {
        this.dynamicCoordinatorTasks.delete(workItemId);
        this.#drainDynamicCoordinatorWakes(workItemId);
      }
    });
  }

  #scanDynamicCoordinatorWakes() {
    if (this.shuttingDown || !this.coordinator) return;
    for (const entry of this.store.listPendingDynamicCoordinatorWakes()) {
      this.#queueDynamicCoordinatorWake(entry.workItemId);
    }
  }

  #drainDynamicCoordinatorWakes(workItemId) {
    if (this.shuttingDown || !this.coordinator || this.dynamicCoordinatorTasks.has(workItemId)) return null;
    const entries = this.store.listPendingDynamicCoordinatorWakes()
      .filter(candidate => candidate.workItemId === workItemId);
    const entry = entries.find(candidate => candidate.payload?.turnId) || entries[0];
    if (!entry) return null;
    const detail = this.store.getWorkItemDetail(workItemId);
    if (!this.store.canAutomaticallyCoordinate(workItemId)
        || detail?.actions?.some(action => action.status === 'running')) return null;
    let turn;
    try {
      turn = this.coordinator.advance(entry.id, {
        workItemId,
        onUpdate: (type, workItem) => this.#emit({ type, workItem }),
      });
    } catch (error) {
      this.#emit({
        type: 'coordinator.advance_schedule_failed',
        workItem: this.store.getWorkItemDetail(workItemId),
        error: error?.message || String(error),
      });
      return null;
    }
    if (!turn) return null;
    const task = turn.task.finally(() => {
      this.dynamicCoordinatorTasks.delete(workItemId);
    });
    this.dynamicCoordinatorTasks.set(workItemId, task);
    task.catch(() => {});
    return task;
  }

  #recoveryKey(entry) {
    return `${entry.workItemId}:${entry.actionId}:${entry.actionGeneration}`;
  }

  #enqueueFailureRecovery(entry) {
    if (this.shuttingDown || !this.coordinator || !entry?.workItemId || !entry.actionId) return;
    const key = this.#recoveryKey(entry);
    this.recoveryQueue.set(key, entry);
    this.#drainFailureRecoveryQueue();
  }

  #scanCoordinatorProviderRecoveries() {
    if (this.shuttingDown || !this.coordinator) return;
    this.store.recoverCoordinatorProviderTurns();
    this.store.recoverCoordinatorMailbox();
    for (const recoverable of this.store.getRecoverableCoordinatorTurns?.() || []) {
      if (!this.store.canAutomaticallyCoordinate(recoverable.workItemId)) continue;
      const claim = this.store.claimCoordinatorTurn(
        recoverable.workItemId, recoverable.turnId, this.ownerBootId,
      );
      if (!claim) continue;
      const started = this.store.resumeCoordinatorTurn(
        recoverable.workItemId, recoverable.turnId, claim,
      );
      if (!started) continue;
      const turn = this.coordinator.resume(started, {
        text: recoverable.text || '',
        recovery: Boolean(recoverable.recovery),
        addedAttachments: Array.isArray(recoverable.addedAttachments)
          ? recoverable.addedAttachments : [],
        quote: recoverable.quote || null,
        onUpdate: (type, detail) => this.#emit({ type, workItem: detail }),
      });
      turn?.task?.catch?.(() => {});
    }
  }

  #scanSchedules() {
    const now = this.now();
    for (const id of this.store.listDueScheduledWorkItemIds(now)) {
      const detail = this.controller.startScheduled(id, now);
      if (detail) this.#emit({ type: 'work_item.schedule_triggered', workItem: detail });
    }
  }

  #scanRecoveries() {
    this.#scanSchedules();
    this.#scanCoordinatorProviderRecoveries();
    this.#scanDynamicCoordinatorWakes();
    this.#scanFailureRecoveries();
  }

  #scanFailureRecoveries() {
    if (this.shuttingDown || !this.coordinator) return;
    const now = Date.now();
    for (const entry of this.store.listFailedActionRecoveries()) {
      const delay = entry.recoveryAttempts > 0
        ? Math.min(1_000 * (2 ** Math.min(entry.recoveryAttempts - 1, 9)), 300_000)
        : 0;
      if (entry.lastRecoveryAt > 0 && now < entry.lastRecoveryAt + delay) continue;
      this.recoveryQueue.set(this.#recoveryKey(entry), entry);
    }
    this.#drainFailureRecoveryQueue();
  }

  #drainFailureRecoveryQueue() {
    if (this.shuttingDown || !this.coordinator || this.recoveryTasks.size > 0) return;
    let next = null;
    for (const [key, entry] of this.recoveryQueue) {
      const detail = this.store.getWorkItemDetail(entry.workItemId);
      if (!this.store.canAutomaticallyCoordinate(entry.workItemId)) {
        this.recoveryQueue.delete(key);
        continue;
      }
      const action = detail?.actions?.find(candidate => candidate.id === entry.actionId);
      if (!detail || ['done', 'cancelled'].includes(detail.status)
          || action?.status !== 'failed'
          || action.generation !== entry.actionGeneration) {
        this.recoveryQueue.delete(key);
        continue;
      }
      if (detail.actions.some(candidate => candidate.status === 'running')) continue;
      next = [key, entry];
      break;
    }
    if (!next) return;
    const [key, entry] = next;
    this.recoveryQueue.delete(key);
    let turn;
    try {
      turn = this.coordinator.recover(entry.workItemId, {
        actionId: entry.actionId,
        actionGeneration: entry.actionGeneration,
        onUpdate: (type, workItem) => {
          this.watcher.abortInvalidWorkItemRuns(entry.workItemId);
          this.#emit({ type, actionId: entry.actionId, workItem });
        },
      });
    } catch (error) {
      this.#emit({
        type: 'coordinator.recovery_schedule_failed',
        actionId: entry.actionId,
        workItem: this.store.getWorkItemDetail(entry.workItemId),
        error: error?.message || String(error),
      });
      return null;
    }
    if (!turn) return null;
    const task = turn.task.finally(() => {
      this.recoveryTasks.delete(key);
    });
    this.recoveryTasks.set(key, task);
    task.catch(() => {});
    return task;
  }

  start() {
    this.#scanRecoveries();
    if (!this.recoveryTimer) {
      this.recoveryTimer = setInterval(
        () => this.#scanRecoveries(),
        this.recoveryPollIntervalMs,
      );
      this.recoveryTimer.unref?.();
    }
    this.watcher.start();
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    await this.coordinator?.shutdown?.();
    await Promise.allSettled([
      ...this.recoveryTasks.values(),
      ...[...this.dynamicCoordinatorTasks.values()].filter(Boolean),
    ]);
    this.recoveryTasks.clear();
    this.dynamicCoordinatorTasks.clear();
    this.recoveryQueue.clear();
    await this.watcher.stop();
    try { await this.watcher.runner?.shutdown?.(); } catch {}
    try { await this.watcher.runner?.trace?.close?.(); } catch {}
    this.store.close();
  }
}
