import ctx from '../../context.js';
import { sendToServer } from '../../connection/buffer.js';
import { ensureSessionLoaded, resetYeaftSession } from '../web-bridge.js';
import { defaultRegistry } from '../vp/registry.js';
import { scanVpLibrary } from '../vp/vp-store.js';
import { WorkCenterService } from './service.js';
import { WorkItemRunner } from './runner.js';
import { WorkItemCoordinator } from './coordinator.js';
import { projectWorkCenterEvent } from './projection.js';
import { previewWorkCenterPlan } from './planner.js';
import { readWorkCenterSettings, writeWorkCenterSettings } from './settings.js';
import { defaultWorkCenterStageInstructions } from './workflow.js';
import { snapshotSessionContext } from './session-context.js';
import { join } from 'node:path';

let service = null;
let initPromise = null;
let shuttingDown = false;
let shutdownPromise = null;
let serviceFactory = null;
let featureEnabled = false;

const BROWSER_DETAIL_OPS = new Set([
  'get', 'create', 'update', 'start', 'cancel', 'resume', 'extend_budget', 'post_work_item_message', 'action_input', 'retry_action', 'guide', 'retry',
]);
const BROWSER_ACTION_DEBUG_OPS = new Set(['get_action_messages', 'get_action_requests', 'get_action_request']);
// `files` is an internal server-to-Agent field. The browser relay rejects any
// client-supplied value and only emits files resolved from owned upload ids.
const BROWSER_FILE_FIELDS = Object.freeze({
  create: [
    'title', 'goal', 'acceptanceCriteria', 'workItemType', 'workDir', 'deliveryTarget', 'deliveryInstructions',
    'reuseMemory', 'files', 'start',
  ],
  post_work_item_message: [
    'id', 'clientMessageId', 'text', 'target', 'revision', 'planRevision', 'ledgerRevision',
    'coordinatorRevision', 'quote', 'files',
  ],
  work_item_message: [
    'id', 'text', 'revision', 'planRevision', 'ledgerRevision', 'coordinatorRevision', 'quote', 'files',
  ],
  action_input: ['id', 'text', 'actionId', 'revision', 'generation', 'quote', 'files'],
  retry_action: ['id', 'actionId', 'revision', 'generation'],
  resume: ['id', 'revision', 'executionControlRevision'],
  extend_budget: ['id', 'executionControlRevision', 'additions'],
  delete: ['id', 'revision'],
  guide: ['id', 'guidance', 'actionId', 'revision', 'generation', 'files'],
  get_action_messages: ['id', 'actionId', 'generation', 'cursor', 'limit'],
  get_action_requests: ['id', 'actionId', 'generation'],
  get_action_request: ['id', 'actionId', 'generation', 'runId', 'requestId'],
});

function browserFilePayload(op, value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const fields = BROWSER_FILE_FIELDS[op] || [];
  return Object.fromEntries(fields
    .filter(field => Object.prototype.hasOwnProperty.call(source, field))
    .map(field => [field, source[field]]));
}

function send(msg) {
  sendToServer(msg);
}

async function getRuntime() {
  return ensureSessionLoaded();
}

function requireYeaftDir() {
  const yeaftDir = ctx.CONFIG?.yeaftDir;
  if (!yeaftDir) throw new Error('Work Center requires a configured Yeaft directory');
  return yeaftDir;
}

async function getSettingsRuntime() {
  const runtime = await getRuntime();
  const yeaftDir = requireYeaftDir();
  if (defaultRegistry.vpCount() === 0) {
    for (const vp of scanVpLibrary({ dir: join(yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
  }
  return {
    vps: defaultRegistry.listVps().map(vp => ({
      id: vp.id,
      name: vp.name || vp.id,
      nameZh: vp.nameZh || '',
      description: vp.description || vp.role || '',
      descriptionZh: vp.descriptionZh || vp.roleZh || vp.description || vp.role || '',
      role: vp.role || '',
      roleZh: vp.roleZh || '',
      area: vp.area || '',
      traits: Array.isArray(vp.traits) ? vp.traits : [],
      modelHint: vp.modelHint || null,
    })),
    models: Array.isArray(runtime.config.availableModels) ? runtime.config.availableModels : [],
    primaryModel: runtime.config.primaryModel || runtime.config.model || null,
    fastModel: runtime.config.fastModel || null,
    defaultWorkDir: ctx.CONFIG?.workDir || process.cwd(),
    workItemAttachments: Array.isArray(ctx.agentCapabilities)
      && ctx.agentCapabilities.includes('work_item_attachments'),
    defaultStageInstructions: defaultWorkCenterStageInstructions(),
  };
}

async function readSettingsResponse() {
  const yeaftDir = requireYeaftDir();
  return {
    settings: readWorkCenterSettings(yeaftDir),
    runtime: await getSettingsRuntime(),
  };
}

async function createDefaultService() {
  const yeaftDir = requireYeaftDir();
  const runner = new WorkItemRunner({
    runtimeProvider: async () => {
      const runtime = await getRuntime();
      if (defaultRegistry.vpCount() === 0) {
        for (const vp of scanVpLibrary({ dir: join(yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
      }
      return {
        ...runtime,
        yeaftDir: requireYeaftDir(),
        defaultWorkDir: ctx.CONFIG?.workDir || process.cwd(),
      };
    },
    policyProvider: async () => readWorkCenterSettings(yeaftDir),
    attachmentRoot: join(yeaftDir, 'work-center', 'attachments'),
    yeaftDir,
    debug: ctx.CONFIG?.debug === true,
    actionWorktreeRoot: join(yeaftDir, 'work-center', 'worktrees'),
    registry: defaultRegistry,
    store: null,
  });
  const coordinator = new WorkItemCoordinator({
    store: null,
    runtimeProvider: async () => {
      const runtime = await runner.runtimeProvider();
      if (defaultRegistry.vpCount() === 0) {
        for (const vp of scanVpLibrary({ dir: join(yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
      }
      return runtime;
    },
    policyProvider: async () => readWorkCenterSettings(yeaftDir),
    registry: defaultRegistry,
    attachmentRoot: join(yeaftDir, 'work-center', 'attachments'),
  });
  const created = new WorkCenterService({
    yeaftDir,
    runner,
    coordinator,
    runtimeInfoProvider: getSettingsRuntime,
    listAvailableVpIds: () => defaultRegistry.listVps().map(vp => vp.id),
    watcherOptions: {
      concurrencyProvider: () => readWorkCenterSettings(yeaftDir).maxConcurrentActions,
    },
    onEvent(event) {
      send({ type: 'work_center_event', event: projectWorkCenterEvent(event) });
    },
  });
  runner.store = created.store;
  coordinator.store = created.store;
  return created;
}

async function ensureWorkCenter() {
  if (!featureEnabled) throw new Error('Work Center is disabled');
  if (shuttingDown) throw new Error('Work Center is shutting down');
  if (service) return service;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const created = serviceFactory ? await serviceFactory() : await createDefaultService();
    if (shuttingDown) {
      await created.shutdown();
      throw new Error('Work Center shut down during initialization');
    }
    created.start();
    service = created;
    return created;
  })();
  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

export async function bootWorkCenter() {
  featureEnabled = true;
  return ensureWorkCenter();
}

export function setWorkCenterFeatureEnabled(enabled) {
  featureEnabled = enabled === true;
}

export async function snapshotCurrentSessionContext(sessionId) {
  const runtime = await getRuntime();
  return snapshotSessionContext(runtime?.conversationStore, sessionId);
}

export async function createWorkItemFromProducer(payload) {
  const workCenter = await ensureWorkCenter();
  return workCenter.handle('create', payload, { trustedProducer: true });
}

export async function handleWorkCenterRequest(msg) {
  const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
  const op = typeof msg.op === 'string' ? msg.op : '';
  try {
    let data;
    let workCenter = null;
    if (op === 'get_settings') {
      data = await readSettingsResponse();
    } else if (op === 'update_settings') {
      const settings = writeWorkCenterSettings(requireYeaftDir(), msg.payload?.settings);
      data = { settings, runtime: await getSettingsRuntime() };
    } else if (op === 'preview') {
      const runtime = await getRuntime();
      const yeaftDir = requireYeaftDir();
      if (defaultRegistry.vpCount() === 0) {
        for (const vp of scanVpLibrary({ dir: join(yeaftDir, 'virtual-persons') })) defaultRegistry.setVp(vp);
      }
      data = previewWorkCenterPlan({
        settings: readWorkCenterSettings(yeaftDir),
        workflowId: msg.payload?.workflowTemplate,
        stageOverrides: msg.payload?.stageOverrides,
        registry: defaultRegistry,
        config: runtime.config,
      });
    } else if (op === 'refresh_runtime') {
      await resetYeaftSession();
      data = await readSettingsResponse();
    } else {
      workCenter = await ensureWorkCenter();
      const payload = Object.hasOwn(BROWSER_FILE_FIELDS, op)
        ? browserFilePayload(op, msg.payload)
        : (BROWSER_ACTION_DEBUG_OPS.has(op) ? browserFilePayload(op, msg.payload) : (msg.payload || {}));
      data = await workCenter.handle(op, payload, { userOriginated: true });
    }
    if (BROWSER_DETAIL_OPS.has(op) && data?.accepted !== true) {
      data = workCenter.projectBrowserDetail(data);
    }
    send({
      type: 'work_center_response',
      requestId,
      op,
      ok: true,
      data,
      _requestUserId: msg._requestUserId || null,
    });
  } catch (err) {
    send({
      type: 'work_center_response',
      requestId,
      op,
      ok: false,
      error: err?.message || String(err),
      ...(err?.code === 'WORK_CENTER_INPUT_STALE' ? { errorCode: err.code } : {}),
      _requestUserId: msg._requestUserId || null,
    });
  }
}

export async function shutdownWorkCenter() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  const pendingInit = initPromise;
  shutdownPromise = (async () => {
    let current = service;
    if (!current && pendingInit) {
      try { current = await pendingInit; } catch {}
    }
    service = null;
    if (current) await current.shutdown();
  })();
  try {
    await shutdownPromise;
  } finally {
    initPromise = null;
    shutdownPromise = null;
    shuttingDown = false;
  }
}

export function __testSetWorkCenterService(next) {
  service = next || null;
  initPromise = null;
  shuttingDown = false;
  shutdownPromise = null;
  featureEnabled = !!next;
}

export function __testSetWorkCenterFactory(factory) {
  serviceFactory = factory || null;
  service = null;
  initPromise = null;
  shuttingDown = false;
  shutdownPromise = null;
  featureEnabled = false;
}
