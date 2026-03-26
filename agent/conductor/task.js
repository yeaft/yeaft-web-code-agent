/**
 * Conductor Task — 数据结构与生命周期
 *
 * Task 是 Orchestrator 管理的最小可调度工作单元。
 * 每个 Task 绑定到创建时的工作路径，由 Orchestrator 状态机驱动。
 */

// =====================================================================
// Constants
// =====================================================================

/** Task complexity levels — TRIAGE 阶段产出 */
export const Complexity = Object.freeze({
  TRIVIAL: 'trivial',   // 一步完成（改个文案、改个配置）
  SMALL: 'small',       // 目标清晰，不需要讨论，直接 planning
  COMPLEX: 'complex'    // 需要发散讨论 / 多视角 / 设计先行
});

/** Orchestrator 状态 */
export const Phase = Object.freeze({
  TRIAGE: 'triage',
  DISCUSSION: 'discussion',
  PLANNING: 'planning',
  EXECUTION: 'execution',
  QUALITY_GATE: 'quality_gate',
  ACCEPTANCE: 'acceptance',
  DONE: 'done',
  FAILED: 'failed'
});

/** Actor 实例状态 */
export const ActorStatus = Object.freeze({
  WORKING: 'working',
  DONE: 'done',
  FAILED: 'failed'
});

/** 思维模式 */
export const ThinkingMode = Object.freeze({
  DIVERGENT: 'divergent',
  CONVERGENT: 'convergent'
});

// =====================================================================
// Factory Functions
// =====================================================================

let _taskCounter = 0;

/**
 * 生成递增的 task ID
 */
export function generateTaskId() {
  return `task-${++_taskCounter}`;
}

/**
 * 创建 Task 实例
 *
 * @param {object} params
 * @param {string} [params.taskId]    — 外部指定的 taskId（来自 Conductor），不提供则自动生成
 * @param {string} params.title       — 任务标题
 * @param {string} params.description — 任务描述（用户原始输入 or Conductor 转译）
 * @param {string} params.scenario    — 场景: dev / writing / trading / video
 * @param {string} params.workDir     — 工作目录（创建时绑定）
 * @returns {Task}
 */
export function createTask({ taskId: externalTaskId, title, description, scenario, workDir }) {
  const taskId = externalTaskId || generateTaskId();
  const now = Date.now();

  return {
    taskId,
    title,
    description,
    scenario,
    workDir,

    // 状态机
    phase: Phase.TRIAGE,
    complexity: null,           // Complexity enum, TRIAGE 阶段填充

    // Actor 管理
    activeActors: [],           // ActorInstance[]
    completedActors: [],        // ActorInstance[] (已完成的 snapshot)

    // 执行计划
    plan: null,                 // ExecutionPlan, PLANNING 阶段产出
    currentStepIndex: -1,       // plan.steps 的当前索引

    // 迭代控制
    iterations: 0,
    maxIterations: 3,

    // Quality Gate
    stepFailCounts: new Map(),  // stepIndex → fail count

    // 时间戳
    createdAt: now,
    updatedAt: now,
    completedAt: null,

    // 结果
    summary: '',
    error: null
  };
}

/**
 * 创建 Actor 实例描述
 *
 * @param {object} params
 * @param {string} params.personaId   — persona ID (e.g. 'torvalds')
 * @param {string} params.personaName — 显示名 (e.g. 'Linus Torvalds')
 * @param {string} params.specialty   — specialty 标识 (e.g. 'coding')
 * @param {string} params.thinkingMode — 'divergent' | 'convergent'
 * @param {string} params.taskId
 * @param {string} [params.threadId]  — 并行线程 ID（coding actor 用）
 * @param {string} [params.worktreePath]
 * @param {string} [params.activity]  — 当前活动描述
 * @returns {ActorInstance}
 */
export function createActorInstance({
  personaId,
  personaName,
  specialty,
  thinkingMode,
  taskId,
  threadId = null,
  worktreePath = null,
  activity = ''
}) {
  const suffix = threadId ? `-${threadId}` : '';
  return {
    instanceId: `${specialty}-${personaId}${suffix}-${taskId}`,
    personaId,
    personaName,
    specialty,
    thinkingMode,
    taskId,
    threadId,
    worktreePath,
    claudeSessionId: null,
    status: ActorStatus.WORKING,
    activity,
    result: null,               // ActorResult — actor 完成后填充
    startedAt: Date.now(),
    completedAt: null
  };
}

/**
 * 创建执行计划
 *
 * @param {object} params
 * @param {string} params.analysis     — 任务分析文本
 * @param {Array}  params.steps        — 执行步骤列表
 * @param {Array}  params.risks        — 风险识别
 * @param {Array}  params.successCriteria — 验收标准
 * @returns {ExecutionPlan}
 */
export function createExecutionPlan({ analysis, steps, risks = [], successCriteria = [] }) {
  return {
    analysis,
    steps: steps.map((step, idx) => ({
      index: idx,
      title: step.title,
      description: step.description || '',
      assignedPersona: step.assignedPersona,     // persona ID
      specialty: step.specialty,                   // specialty 标识
      parallel: step.parallel || false,            // 可否与相邻步骤并行
      parallelGroup: step.parallelGroup || null,   // 并行分组标识
      dependencies: step.dependencies || [],       // 前置步骤 index[]
      needsReview: step.needsReview !== false,     // 默认 true
      needsTesting: step.needsTesting !== false,   // 默认 true
      status: 'pending',                           // pending | executing | completed | failed
      result: null
    })),
    risks,
    successCriteria,
    createdAt: Date.now()
  };
}

// =====================================================================
// Task State Mutations
// =====================================================================

/**
 * 推进 Task 到下一个 Phase
 */
export function transitionPhase(task, newPhase) {
  const valid = getValidTransitions(task.phase);
  if (!valid.includes(newPhase)) {
    throw new Error(
      `Invalid phase transition: ${task.phase} → ${newPhase}. Valid: [${valid.join(', ')}]`
    );
  }
  task.phase = newPhase;
  task.updatedAt = Date.now();
  if (newPhase === Phase.DONE || newPhase === Phase.FAILED) {
    task.completedAt = Date.now();
  }
  return task;
}

/**
 * 获取当前 phase 的合法下一步
 */
export function getValidTransitions(phase) {
  switch (phase) {
    case Phase.TRIAGE:
      return [Phase.DISCUSSION, Phase.PLANNING, Phase.EXECUTION, Phase.FAILED];
    case Phase.DISCUSSION:
      return [Phase.PLANNING, Phase.QUALITY_GATE, Phase.EXECUTION, Phase.FAILED];
    case Phase.PLANNING:
      return [Phase.EXECUTION, Phase.DISCUSSION, Phase.QUALITY_GATE, Phase.FAILED];
    case Phase.EXECUTION:
      return [Phase.QUALITY_GATE, Phase.ACCEPTANCE, Phase.FAILED];
    case Phase.QUALITY_GATE:
      return [Phase.EXECUTION, Phase.DISCUSSION, Phase.ACCEPTANCE, Phase.FAILED];
    case Phase.ACCEPTANCE:
      return [Phase.PLANNING, Phase.EXECUTION, Phase.DONE, Phase.FAILED];
    case Phase.DONE:
    case Phase.FAILED:
      return [];
    default:
      return [];
  }
}

/**
 * 注册活跃 Actor
 */
export function addActiveActor(task, actorInstance) {
  task.activeActors.push(actorInstance);
  task.updatedAt = Date.now();
}

/**
 * 从 activeActors 中移除并转移到 completedActors（共享逻辑）
 */
function _transferActor(task, instanceId, status, result) {
  const idx = task.activeActors.findIndex(a => a.instanceId === instanceId);
  if (idx === -1) return null;

  const actor = task.activeActors.splice(idx, 1)[0];
  actor.status = status;
  actor.result = result;
  actor.completedAt = Date.now();
  task.completedActors.push(actor);
  task.updatedAt = Date.now();
  return actor;
}

/**
 * Actor 完成：从 active 移到 completed
 */
export function completeActor(task, instanceId, result) {
  return _transferActor(task, instanceId, ActorStatus.DONE, result);
}

/**
 * Actor 失败
 */
export function failActor(task, instanceId, error) {
  return _transferActor(task, instanceId, ActorStatus.FAILED, { error: error?.message || String(error) });
}

/**
 * 记录步骤 fail 次数（Quality Gate 用）
 */
export function recordStepFail(task, stepIndex) {
  const count = (task.stepFailCounts.get(stepIndex) || 0) + 1;
  task.stepFailCounts.set(stepIndex, count);
  return count;
}

/**
 * 获取步骤 fail 次数
 */
export function getStepFailCount(task, stepIndex) {
  return task.stepFailCounts.get(stepIndex) || 0;
}

// =====================================================================
// Task Serialization (for status.json / 前端推送)
// =====================================================================

/**
 * 序列化 Task 为可传输的 plain object
 */
export function serializeTask(task) {
  return {
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    scenario: task.scenario,
    workDir: task.workDir,
    phase: task.phase,
    complexity: task.complexity,
    activeActors: task.activeActors.map(serializeActor),
    completedActors: task.completedActors.map(serializeActor),
    plan: task.plan,
    currentStepIndex: task.currentStepIndex,
    iterations: task.iterations,
    maxIterations: task.maxIterations,
    stepFailCounts: Object.fromEntries(task.stepFailCounts),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    summary: task.summary,
    error: task.error
  };
}

/**
 * 序列化 ActorInstance
 */
function serializeActor(actor) {
  return {
    instanceId: actor.instanceId,
    personaId: actor.personaId,
    personaName: actor.personaName,
    specialty: actor.specialty,
    thinkingMode: actor.thinkingMode,
    taskId: actor.taskId,
    threadId: actor.threadId,
    status: actor.status,
    activity: actor.activity,
    startedAt: actor.startedAt,
    completedAt: actor.completedAt
  };
}
