/**
 * Conductor — Actor Claude 实例管理
 *
 * Actor 是最底层的执行单元：
 * - 创建 actor session（写 CLAUDE.md → 启动 Claude）
 * - 发送任务 → 收集结果 → 回调 Orchestrator
 * - 释放 actor（清理 session）
 *
 * 复用 V1 的 createRoleQuery 模式，适配 Conductor 三层架构
 */
import { query, Stream } from '../sdk/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { mkdirSync } from 'fs';
import ctx from '../context.js';
import { generateActorCLAUDEmd, generateActorDirName, generateActorInstanceId } from './claudemd-generator.js';
import { getPersonaById } from './personas/index.js';
import { getSpecialty, getThinkingMode } from './specialties/index.js';

// =====================================================================
// Actor Instance Registry
// =====================================================================

/**
 * Per-task actor registry: taskId → Map<instanceId, ActorInstance>
 * @type {Map<string, Map<string, ActorInstance>>}
 */
const actorRegistry = new Map();

/**
 * Per-actor mutex to prevent concurrent createActorQuery calls
 * @type {Map<string, Promise>}
 */
const _actorLocks = new Map();

// =====================================================================
// Actor Lifecycle
// =====================================================================

/**
 * 创建 Actor 实例
 *
 * 流程：生成 CLAUDE.md → 创建目录 → 写入 CLAUDE.md → 启动 Claude query → 注册
 *
 * @param {object} params
 * @param {string} params.personaId - persona ID
 * @param {string} params.specialtyId - specialty ID
 * @param {string} params.taskId - 所属 task ID
 * @param {string} params.taskDir - task 目录路径 (.conductor/tasks/task-N)
 * @param {object} params.taskContext - 传递给 CLAUDE.md 生成器的上下文
 * @param {string} [params.threadId] - 并行线程 ID（coding actor 用）
 * @param {string} [params.worktreePath] - worktree 路径
 * @param {string} [params.model] - 指定模型
 * @param {function} [params.onOutput] - 输出回调 (instanceId, message) => void
 * @param {function} [params.onComplete] - 完成回调 (instanceId, result) => void
 * @param {function} [params.onError] - 错误回调 (instanceId, error) => void
 * @returns {Promise<ActorInstance>}
 */
export async function createActor(params) {
  const {
    personaId,
    specialtyId,
    taskId,
    taskDir,
    taskContext = {},
    threadId,
    worktreePath,
    model,
    onOutput,
    onComplete,
    onError
  } = params;

  const instanceId = generateActorInstanceId(specialtyId, personaId, taskId, threadId);
  const lockKey = instanceId;

  // Mutex: 防止并发创建同一个 actor
  if (_actorLocks.has(lockKey)) {
    console.log(`[Actor] Waiting for existing lock on ${instanceId}`);
    try { await _actorLocks.get(lockKey); } catch { /* 前一次失败了，继续 */ }
    const existing = getActor(taskId, instanceId);
    if (existing && existing.status === 'working') {
      console.log(`[Actor] Reusing existing actor ${instanceId}`);
      return existing;
    }
  }

  const promise = _createActorInner(params, instanceId);
  _actorLocks.set(lockKey, promise);

  try {
    return await promise;
  } finally {
    if (_actorLocks.get(lockKey) === promise) {
      _actorLocks.delete(lockKey);
    }
  }
}

/**
 * createActor 内部实现
 */
async function _createActorInner(params, instanceId) {
  const {
    personaId,
    specialtyId,
    taskId,
    taskDir,
    taskContext = {},
    threadId,
    worktreePath,
    model,
    onOutput,
    onComplete,
    onError
  } = params;

  const persona = getPersonaById(personaId);
  if (!persona) throw new Error(`Persona not found: ${personaId}`);

  const specialty = getSpecialty(specialtyId);
  if (!specialty) throw new Error(`Specialty not found: ${specialtyId}`);

  // 1. 生成 CLAUDE.md
  const claudemdContent = generateActorCLAUDEmd(persona, specialtyId, {
    ...taskContext,
    worktreePath
  });

  // 2. 创建 actor 目录
  const actorDirName = generateActorDirName(specialtyId, personaId, threadId);
  const actorDir = join(taskDir, 'actors', actorDirName);
  mkdirSync(actorDir, { recursive: true });

  // 3. 写入 CLAUDE.md
  const claudemdPath = join(actorDir, 'CLAUDE.md');
  await fs.writeFile(claudemdPath, claudemdContent, 'utf-8');
  console.log(`[Actor] Wrote CLAUDE.md for ${instanceId} at ${claudemdPath}`);

  // 4. 确定 cwd（coding actor 用 worktree，其他用 actor 目录）
  const actorCwd = worktreePath || actorDir;
  mkdirSync(actorCwd, { recursive: true });

  // 5. 创建 Claude query
  const inputStream = new Stream();
  const abortController = new AbortController();

  // 继承全局 disallowedTools
  const globalDisallowed = ctx.CONFIG?.disallowedTools || [];
  const actorDisallowed = ['Agent']; // Actor 不允许使用 Agent 工具
  const effectiveDisallowed = [...globalDisallowed, ...actorDisallowed];

  const queryOptions = {
    cwd: actorCwd,
    permissionMode: 'bypassPermissions',
    abort: abortController.signal,
    model: model || undefined,
    appendSystemPrompt: claudemdContent,
    ...(effectiveDisallowed.length > 0 && { disallowedTools: effectiveDisallowed })
  };

  const roleQuery = query({
    prompt: inputStream,
    options: queryOptions
  });

  // 6. 创建 ActorInstance
  const thinkingMode = getThinkingMode(specialtyId);

  /** @type {ActorInstance} */
  const instance = {
    instanceId,
    personaId,
    personaName: persona.name,
    specialtyId,
    specialtyDisplayName: specialty.displayName,
    thinkingMode,
    taskId,
    threadId: threadId || null,
    worktreePath: worktreePath || null,
    actorDir,
    claudeSessionId: null,
    status: 'working',
    activity: `${persona.name} 正在执行 ${specialty.displayName}`,
    startedAt: Date.now(),
    // 内部管理
    _query: roleQuery,
    _inputStream: inputStream,
    _abortController: abortController,
    _accumulatedText: '',
    _onOutput: onOutput || null,
    _onComplete: onComplete || null,
    _onError: onError || null
  };

  // 7. 注册到 registry
  if (!actorRegistry.has(taskId)) {
    actorRegistry.set(taskId, new Map());
  }
  actorRegistry.get(taskId).set(instanceId, instance);

  // 8. 异步处理 Actor 输出
  processActorOutput(instance);

  console.log(`[Actor] Created ${instanceId}: ${persona.name} × ${specialtyId} (${thinkingMode})`);
  return instance;
}

// =====================================================================
// Actor Communication
// =====================================================================

/**
 * 向 Actor 发送任务消息
 *
 * @param {string} taskId - task ID
 * @param {string} instanceId - actor instance ID
 * @param {string} message - 要发送的消息
 */
export function sendToActor(taskId, instanceId, message) {
  const instance = getActor(taskId, instanceId);
  if (!instance) {
    console.error(`[Actor] Cannot send to unknown actor: ${instanceId}`);
    return;
  }

  if (instance._inputStream.isDone) {
    console.error(`[Actor] Cannot send to completed actor: ${instanceId}`);
    return;
  }

  console.log(`[Actor] Sending message to ${instanceId} (${message.length} chars)`);
  instance._inputStream.enqueue(message);
}

/**
 * 异步处理 Actor 输出流
 */
async function processActorOutput(instance) {
  const { instanceId, _query: roleQuery } = instance;

  try {
    for await (const message of roleQuery) {
      // 提取 sessionId
      if (message.sessionId && !instance.claudeSessionId) {
        instance.claudeSessionId = message.sessionId;
      }

      // 处理助手消息
      if (message.type === 'assistant') {
        const text = extractText(message);
        if (text) {
          instance._accumulatedText += text;

          // 实时输出回调
          if (instance._onOutput) {
            try {
              instance._onOutput(instanceId, message);
            } catch (e) {
              console.error(`[Actor] onOutput callback error for ${instanceId}:`, e.message);
            }
          }
        }
      }

      // turn 结束的标志
      if (message.type === 'result') {
        instance.status = 'done';
        instance.activity = '已完成';

        const result = {
          instanceId,
          personaId: instance.personaId,
          personaName: instance.personaName,
          specialtyId: instance.specialtyId,
          thinkingMode: instance.thinkingMode,
          text: instance._accumulatedText,
          costUsd: message.costUSD || 0,
          inputTokens: message.inputTokens || 0,
          outputTokens: message.outputTokens || 0,
          duration: Date.now() - instance.startedAt
        };

        console.log(`[Actor] ${instanceId} completed (${result.duration}ms, $${result.costUsd.toFixed(4)})`);

        if (instance._onComplete) {
          try {
            instance._onComplete(instanceId, result);
          } catch (e) {
            console.error(`[Actor] onComplete callback error for ${instanceId}:`, e.message);
          }
        }
      }
    }
  } catch (error) {
    instance.status = 'failed';
    instance.activity = `失败: ${error.message}`;
    console.error(`[Actor] ${instanceId} error:`, error.message);

    if (instance._onError) {
      try {
        instance._onError(instanceId, error);
      } catch (e) {
        console.error(`[Actor] onError callback error for ${instanceId}:`, e.message);
      }
    }
  }
}

/**
 * 从消息中提取文本内容
 */
function extractText(message) {
  if (!message.message?.content) return '';
  const content = message.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');
  }
  return '';
}

// =====================================================================
// Actor Release & Cleanup
// =====================================================================

/**
 * 释放 Actor 实例（清理 session）
 *
 * @param {string} taskId
 * @param {string} instanceId
 * @param {object} [options]
 * @param {boolean} [options.force=false] - 强制终止（abort）
 */
export async function releaseActor(taskId, instanceId, options = {}) {
  const instance = getActor(taskId, instanceId);
  if (!instance) {
    console.warn(`[Actor] Cannot release unknown actor: ${instanceId}`);
    return;
  }

  const { force = false } = options;

  // 关闭 input stream
  if (!instance._inputStream.isDone) {
    instance._inputStream.done();
  }

  // 强制终止
  if (force && instance._abortController) {
    instance._abortController.abort();
  }

  instance.status = 'done';
  instance.activity = '已释放';

  console.log(`[Actor] Released ${instanceId}${force ? ' (forced)' : ''}`);
}

/**
 * 释放指定 task 的全部 actor
 *
 * @param {string} taskId
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 */
export async function releaseAllActors(taskId, options = {}) {
  const taskActors = actorRegistry.get(taskId);
  if (!taskActors) return;

  const promises = [];
  for (const [instanceId] of taskActors) {
    promises.push(releaseActor(taskId, instanceId, options));
  }
  await Promise.allSettled(promises);

  actorRegistry.delete(taskId);
  console.log(`[Actor] Released all actors for task ${taskId}`);
}

// =====================================================================
// Actor Query
// =====================================================================

/**
 * 获取单个 actor 实例
 * @param {string} taskId
 * @param {string} instanceId
 * @returns {ActorInstance|null}
 */
export function getActor(taskId, instanceId) {
  return actorRegistry.get(taskId)?.get(instanceId) || null;
}

/**
 * 获取指定 task 的全部活跃 actor
 * @param {string} taskId
 * @returns {ActorInstance[]}
 */
export function getActiveActors(taskId) {
  const taskActors = actorRegistry.get(taskId);
  if (!taskActors) return [];
  return Array.from(taskActors.values()).filter(a => a.status === 'working');
}

/**
 * 获取指定 task 的全部 actor（含已完成）
 * @param {string} taskId
 * @returns {ActorInstance[]}
 */
export function getAllActors(taskId) {
  const taskActors = actorRegistry.get(taskId);
  if (!taskActors) return [];
  return Array.from(taskActors.values());
}

/**
 * 获取 actor 实例的公开状态（用于前端展示）
 * @param {ActorInstance} instance
 * @returns {object}
 */
export function getActorPublicState(instance) {
  return {
    instanceId: instance.instanceId,
    personaId: instance.personaId,
    personaName: instance.personaName,
    specialtyId: instance.specialtyId,
    specialtyDisplayName: instance.specialtyDisplayName,
    thinkingMode: instance.thinkingMode,
    taskId: instance.taskId,
    threadId: instance.threadId,
    status: instance.status,
    activity: instance.activity,
    startedAt: instance.startedAt
  };
}

/**
 * 获取指定 task 全部 actor 的公开状态列表
 * @param {string} taskId
 * @returns {object[]}
 */
export function getActorStates(taskId) {
  return getAllActors(taskId).map(getActorPublicState);
}

// =====================================================================
// Error Classification (复用 V1 模式)
// =====================================================================

/**
 * 判断 actor 错误是否可恢复
 * @param {Error} error
 * @returns {{ recoverable: boolean, reason: string }}
 */
export function classifyActorError(error) {
  const msg = error.message || '';
  if (/context.*(window|limit|exceeded)|token.*limit|too.*(long|large)|max.*token/i.test(msg)) {
    return { recoverable: true, reason: 'context_exceeded' };
  }
  if (/rate.?limit|429|overloaded|503|502|timeout|ECONNRESET|ETIMEDOUT/i.test(msg)) {
    return { recoverable: true, reason: 'transient_api_error' };
  }
  if (/exited with code [1-9]/i.test(msg) && msg.length < 100) {
    return { recoverable: true, reason: 'process_crashed' };
  }
  if (/spawn|ENOENT|not found/i.test(msg)) {
    return { recoverable: false, reason: 'spawn_failed' };
  }
  return { recoverable: true, reason: 'unknown' };
}

export { actorRegistry };
