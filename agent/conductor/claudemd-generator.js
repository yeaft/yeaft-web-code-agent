/**
 * Conductor — 三段式 CLAUDE.md 生成器
 *
 * CLAUDE.md = 人物基底(persona base) + specialty 行为(specialty behavior) + 任务上下文(task context)
 *
 * 核心原则：一个实例一个文件。每个 persona × specialty 组合生成独立的 CLAUDE.md。
 * Torvalds 做 planning 和 Torvalds 做 coding 是两个完全不同的文件。
 */
import { getPersonaById } from './personas/index.js';
import {
  getSpecialty,
  getThinkingMode,
  getPersonalizedBehavior,
  getOutputFormat,
  formatToolRules
} from './specialties/index.js';

/**
 * 生成 Actor 的 CLAUDE.md 内容
 *
 * @param {object|string} personaOrId - persona 对象 或 persona ID
 * @param {string} specialtyId - specialty ID (e.g. 'planning', 'coding', 'review')
 * @param {object} taskContext - 任务上下文
 * @param {string} taskContext.taskId - 任务 ID
 * @param {string} taskContext.description - 任务描述
 * @param {string} [taskContext.memoryPath] - memory.md 路径
 * @param {string} [taskContext.planPath] - plan.json 路径
 * @param {string} [taskContext.worktreePath] - worktree 路径 (coding actor 用)
 * @param {string} [taskContext.reviewTarget] - 审查目标描述 (review actor 用)
 * @param {string} [taskContext.assignedStep] - 分配的执行步骤 (coding actor 用)
 * @param {string} [taskContext.scenario] - 场景名称
 * @param {object} [taskContext.extra] - 额外上下文（自由格式）
 * @returns {string} 完整的 CLAUDE.md 内容
 */
export function generateActorCLAUDEmd(personaOrId, specialtyId, taskContext = {}) {
  // 解析 persona
  const persona = typeof personaOrId === 'string'
    ? getPersonaById(personaOrId)
    : personaOrId;

  if (!persona) {
    throw new Error(`Persona not found: ${personaOrId}`);
  }

  const specialty = getSpecialty(specialtyId);
  if (!specialty) {
    throw new Error(`Specialty not found: ${specialtyId}`);
  }

  // 三段生成
  const section1 = generatePersonaBase(persona, specialty);
  const section2 = generateSpecialtyBehavior(persona, specialty);
  const section3 = generateTaskContext(persona, specialty, taskContext);

  return `${section1}

${section2}

${section3}`.trim();
}

// =====================================================================
// 第一段：人物基底
// =====================================================================

/**
 * 生成人物基底部分
 */
function generatePersonaBase(persona, specialty) {
  return `# 你是 ${persona.name} — 此刻你在做 ${specialty.displayName}

${persona.base}`;
}

// =====================================================================
// 第二段：Specialty 行为（结合人物个性定制）
// =====================================================================

/**
 * 生成 specialty 行为部分
 */
function generateSpecialtyBehavior(persona, specialty) {
  const thinkingMode = getThinkingMode(specialty.id);
  const thinkingLabel = thinkingMode === 'divergent' ? '发散思维' : '收敛执行';

  const personalizedBehavior = getPersonalizedBehavior(specialty.id, persona);
  const outputFormat = getOutputFormat(specialty.id);
  const toolRules = formatToolRules(specialty.id);

  return `## 作为 ${specialty.displayName} 的你（${thinkingLabel}）
${personalizedBehavior}

## 输出要求
${outputFormat}

## 工具使用
${toolRules}`;
}

// =====================================================================
// 第三段：任务上下文（动态注入）
// =====================================================================

/**
 * 生成任务上下文部分
 */
function generateTaskContext(persona, specialty, ctx) {
  const lines = ['## Task 上下文'];

  if (ctx.taskId) {
    lines.push(`- 任务 ID：${ctx.taskId}`);
  }

  if (ctx.description) {
    lines.push(`- 任务描述：${ctx.description}`);
  }

  if (ctx.scenario) {
    lines.push(`- 场景：${ctx.scenario}`);
  }

  if (ctx.assignedStep) {
    lines.push(`- 执行步骤：${ctx.assignedStep}`);
  }

  if (ctx.reviewTarget) {
    lines.push(`- 审查目标：${ctx.reviewTarget}`);
  }

  if (ctx.memoryPath) {
    lines.push(`- 共享记忆：${ctx.memoryPath}`);
  }

  if (ctx.planPath) {
    lines.push(`- 计划文件：${ctx.planPath}`);
  }

  // worktree 路径和纪律规则（coding actor 专用）
  if (ctx.worktreePath) {
    lines.push('');
    lines.push('## Worktree 纪律');
    lines.push(`- 代码工作目录：${ctx.worktreePath}`);
    lines.push('- 所有代码操作必须在此目录内');
    lines.push('- 禁止在主目录或 main 分支修改代码');
    lines.push('- 完成后通过回调通知 Orchestrator');
  }

  // 额外上下文
  if (ctx.extra) {
    lines.push('');
    lines.push('## 补充信息');
    if (typeof ctx.extra === 'string') {
      lines.push(ctx.extra);
    } else {
      for (const [key, value] of Object.entries(ctx.extra)) {
        lines.push(`- ${key}：${value}`);
      }
    }
  }

  // 通用结尾指令
  lines.push('');
  lines.push('## 工作完成后');
  lines.push('完成工作后，请输出你的产出结果。Orchestrator 会接收并处理。');

  return lines.join('\n');
}

/**
 * 生成 Actor 实例 ID
 *
 * @param {string} specialtyId - specialty ID
 * @param {string} personaId - persona ID
 * @param {string} taskId - task ID
 * @param {string} [threadId] - 并行线程 ID（可选）
 * @returns {string} 实例 ID，如 "planning-jobs-task-1" 或 "coding-torvalds-task-1-t1"
 */
export function generateActorInstanceId(specialtyId, personaId, taskId, threadId) {
  const base = `${specialtyId}-${personaId}-${taskId}`;
  return threadId ? `${base}-${threadId}` : base;
}

/**
 * 生成 Actor 的目录名（用于 .conductor/tasks/task-N/actors/ 下）
 *
 * @param {string} specialtyId
 * @param {string} personaId
 * @param {string} [threadId]
 * @returns {string} 目录名，如 "planning-jobs" 或 "coding-torvalds-t1"
 */
export function generateActorDirName(specialtyId, personaId, threadId) {
  const base = `${specialtyId}-${personaId}`;
  return threadId ? `${base}-${threadId}` : base;
}
