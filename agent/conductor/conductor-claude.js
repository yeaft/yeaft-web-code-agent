/**
 * Conductor — Conductor Claude 实例管理
 *
 * Conductor Claude 是常驻的 Claude Code 进程，负责：
 * 1. 消息分类（简单问答 / 创建 task / 透传到 task / 查状态）
 * 2. 回答简单问题
 * 3. 绝不做任务分析或步骤拆解
 *
 * 复用 V1 的 role-query 模式：query() + Stream + for-await 循环。
 */
import { query, Stream } from '../sdk/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { globalSemaphore } from './semaphore.js';
import {
  sendConductorMessage, sendConductorOutput,
  endConductorStreaming, sendStatusUpdate
} from './ui-messages.js';
import { getSessionDataDir } from './persistence.js';

// =====================================================================
// Session ID Persistence (Conductor Claude session)
// =====================================================================

async function saveConductorSessionId(sessionDataDir, claudeSessionId) {
  await fs.mkdir(sessionDataDir, { recursive: true });
  const filePath = join(sessionDataDir, 'conductor-claude-session.json');
  await fs.writeFile(filePath, JSON.stringify({
    claudeSessionId, savedAt: Date.now()
  }));
}

async function loadConductorSessionId(sessionDataDir) {
  const filePath = join(sessionDataDir, 'conductor-claude-session.json');
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return data.claudeSessionId || null;
  } catch {
    return null;
  }
}

async function clearConductorSessionId(sessionDataDir) {
  const filePath = join(sessionDataDir, 'conductor-claude-session.json');
  try { await fs.unlink(filePath); } catch { /* ok */ }
}

// =====================================================================
// System Prompt
// =====================================================================

function buildConductorSystemPrompt(session) {
  const taskSummaries = Array.from(session.tasks.values())
    .map(t => `- ${t.taskId}: ${t.title} [${t.phase} ${t.progress}%] @ ${t.workDir}`)
    .join('\n');

  return `# Conductor — 交响乐指挥台

你是 Conductor，项目的总指挥。你的职责是：
1. **分类消息**：判断用户的输入是简单问答还是需要创建任务
2. **创建任务**：通过 CREATE_TASK 指令创建新任务
3. **转发消息**：通过 FORWARD_TASK 将用户消息传递给已有任务
4. **回答问题**：直接回答简单的问题
5. **汇报状态**：用户询问进度时汇总所有任务状态

## 你绝对不做的事
- 不分析任务难度
- 不拆解任务步骤
- 不评估需要几个人
- 不写代码

## 当前工作路径
${session.workDir || '(未设置)'}

## 当前活跃任务
${taskSummaries || '(无)'}

## 指令格式

### 创建任务
当用户的需求需要实际的开发/分析/设计工作时，输出：

\`\`\`
---CREATE_TASK---
title: <任务标题>
---END_CREATE_TASK---
\`\`\`

### 转发消息到已有任务
当用户的消息是针对某个已有任务的补充说明时，输出：

\`\`\`
---FORWARD_TASK---
taskId: <task-id>
message: <要转发的内容>
---END_FORWARD_TASK---
\`\`\`

### 回答简单问题
直接用文本回答，不需要任何指令块。

## 规则
- 每条用户消息只需要一种响应：创建任务 / 转发 / 直接回答
- 创建任务时只给标题，不要描述实现步骤
- 如果用户问"进度怎样"，直接汇总上面的任务列表状态
- 保持回复简洁
- 用中文回复`;
}

// =====================================================================
// Conductor Claude Instance
// =====================================================================

/**
 * 创建或重建 Conductor Claude 实例
 */
export async function createConductorClaude(session) {
  const sessionDataDir = getSessionDataDir(session.id);

  // 获取信号量
  const release = await globalSemaphore.acquire();
  session._conductorSemRelease = release;
  session.activeClaudes = (session.activeClaudes || 0) + 1;

  const inputStream = new Stream();
  const abortController = new AbortController();
  const systemPrompt = buildConductorSystemPrompt(session);

  // 尝试恢复已有 session
  const savedSessionId = await loadConductorSessionId(sessionDataDir);

  const queryOptions = {
    cwd: sessionDataDir,
    permissionMode: 'bypassPermissions',
    abort: abortController.signal,
    appendSystemPrompt: systemPrompt
  };

  if (savedSessionId) {
    queryOptions.resume = savedSessionId;
    console.log(`[Conductor] Resuming Claude with sessionId: ${savedSessionId}`);
  }

  const conductorQuery = query({
    prompt: inputStream,
    options: queryOptions
  });

  session.conductorState = {
    query: conductorQuery,
    inputStream,
    abortController,
    claudeSessionId: savedSessionId,
    accumulatedText: '',
    turnActive: false,
    lastCostUsd: 0,
    lastInputTokens: 0,
    lastOutputTokens: 0
  };

  // 启动输出处理循环
  processConductorOutput(session, conductorQuery);

  return session.conductorState;
}

/**
 * 向 Conductor Claude 发送消息
 */
export async function sendToConductor(session, content) {
  let state = session.conductorState;

  if (!state || !state.query || !state.inputStream) {
    state = await createConductorClaude(session);
  }

  // 更新 system prompt（动态注入最新 task 列表）
  // 注意：Claude Code 不支持动态更新 system prompt
  // 所以我们在用户消息前注入上下文
  const taskContext = buildTaskContext(session);
  const fullContent = taskContext
    ? `${content}\n\n---\n<conductor-context>\n${taskContext}\n</conductor-context>`
    : content;

  state.turnActive = true;
  state.accumulatedText = '';
  state.inputStream.enqueue({
    type: 'user',
    message: { role: 'user', content: fullContent }
  });

  sendStatusUpdate(session);
}

function buildTaskContext(session) {
  if (session.tasks.size === 0) return null;
  const lines = ['当前工作路径: ' + (session.workDir || '(未设置)'), '', '活跃任务:'];
  for (const t of session.tasks.values()) {
    lines.push(`- ${t.taskId}: ${t.title} [${t.phase} ${t.progress}%] @ ${t.workDir}`);
  }
  return lines.join('\n');
}

// =====================================================================
// Output Processing
// =====================================================================

// 解析 CREATE_TASK 指令
function parseCreateTask(text) {
  const regex = /---CREATE_TASK---\s*\n([\s\S]*?)---END_CREATE_TASK---/g;
  const tasks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/title:\s*(.+)/i);
    if (titleMatch) {
      tasks.push({ title: titleMatch[1].trim() });
    }
  }
  return tasks;
}

// 解析 FORWARD_TASK 指令
function parseForwardTask(text) {
  const regex = /---FORWARD_TASK---\s*\n([\s\S]*?)---END_FORWARD_TASK---/g;
  const forwards = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const taskIdMatch = block.match(/^taskId:\s*(.+)/im);
    const messageMatch = block.match(/^message:\s*([\s\S]*?)$/im);
    if (taskIdMatch) {
      forwards.push({
        taskId: taskIdMatch[1].trim(),
        message: messageMatch ? messageMatch[1].trim() : ''
      });
    }
  }
  return forwards;
}

/**
 * 处理 Conductor Claude 的流式输出
 */
async function processConductorOutput(session, conductorQuery) {
  const state = session.conductorState;
  const sessionDataDir = getSessionDataDir(session.id);

  try {
    for await (const message of conductorQuery) {
      if (session.status === 'stopped') break;

      if (message.type === 'system' && message.subtype === 'init') {
        state.claudeSessionId = message.session_id;
        console.log(`[Conductor] Claude session: ${message.session_id}`);
        continue;
      }

      if (message.type === 'assistant') {
        const content = message.message?.content;
        if (content) {
          if (typeof content === 'string') {
            state.accumulatedText += content;
            sendConductorOutput(session, 'text', message);
          } else if (Array.isArray(content)) {
            let hasText = false;
            for (const block of content) {
              if (block.type === 'text') {
                state.accumulatedText += block.text;
                hasText = true;
              } else if (block.type === 'tool_use') {
                endConductorStreaming(session);
                sendConductorOutput(session, 'tool_use', message);
              }
            }
            if (hasText) {
              sendConductorOutput(session, 'text', message);
            }
          }
        }
      } else if (message.type === 'user') {
        sendConductorOutput(session, 'tool_result', message);
      } else if (message.type === 'result') {
        // Turn 完成
        console.log(`[Conductor] Turn completed`);
        endConductorStreaming(session);

        // 更新费用
        if (message.total_cost_usd != null) {
          const costDelta = message.total_cost_usd - state.lastCostUsd;
          if (costDelta > 0) session.costUsd += costDelta;
          state.lastCostUsd = message.total_cost_usd;
        }
        if (message.usage) {
          const inputDelta = (message.usage.input_tokens || 0) - (state.lastInputTokens || 0);
          const outputDelta = (message.usage.output_tokens || 0) - (state.lastOutputTokens || 0);
          if (inputDelta > 0) session.totalInputTokens += inputDelta;
          if (outputDelta > 0) session.totalOutputTokens += outputDelta;
          state.lastInputTokens = message.usage.input_tokens || 0;
          state.lastOutputTokens = message.usage.output_tokens || 0;
        }

        // 持久化 sessionId
        if (state.claudeSessionId) {
          saveConductorSessionId(sessionDataDir, state.claudeSessionId)
            .catch(e => console.warn('[Conductor] Failed to save sessionId:', e.message));
        }

        // 解析指令
        const createTasks = parseCreateTask(state.accumulatedText);
        const forwardTasks = parseForwardTask(state.accumulatedText);

        // 处理 CREATE_TASK
        for (const ct of createTasks) {
          const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const task = {
            taskId,
            title: ct.title,
            workDir: session.workDir || '',
            status: 'pending',
            phase: 'created',
            progress: 0,
            activeActors: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          session.tasks.set(taskId, task);

          sendConductorOutput(session, 'task_created', null, {
            taskId, taskTitle: ct.title
          });

          sendConductorMessage({
            type: 'conductor_task_created',
            sessionId: session.id,
            task
          });

          console.log(`[Conductor] Task created: ${taskId} — ${ct.title}`);
        }

        // 处理 FORWARD_TASK
        for (const ft of forwardTasks) {
          const task = session.tasks.get(ft.taskId);
          if (task) {
            // 将消息写入 task 的 inbox（后续 orchestrator 读取）
            if (!task.inbox) task.inbox = [];
            task.inbox.push({
              from: 'conductor',
              content: ft.message,
              timestamp: Date.now()
            });
            task.updatedAt = Date.now();

            sendConductorOutput(session, 'task_forwarded', null, {
              taskId: ft.taskId
            });

            sendConductorMessage({
              type: 'conductor_task_message',
              sessionId: session.id,
              taskId: ft.taskId,
              message: ft.message
            });

            console.log(`[Conductor] Forwarded to ${ft.taskId}: ${ft.message.substring(0, 60)}`);
          } else {
            console.warn(`[Conductor] Unknown task: ${ft.taskId}`);
          }
        }

        state.accumulatedText = '';
        state.turnActive = false;

        sendConductorMessage({
          type: 'conductor_turn_completed',
          sessionId: session.id
        });
        sendStatusUpdate(session);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`[Conductor] Claude aborted`);
    } else {
      console.error(`[Conductor] Claude error:`, error.message);
      endConductorStreaming(session);
      state.turnActive = false;
      state.query = null;
      state.inputStream = null;
      state.accumulatedText = '';

      sendConductorMessage({
        type: 'conductor_error',
        sessionId: session.id,
        error: error.message.substring(0, 500)
      });

      // 转入等待用户
      session.status = 'waiting_user';
      sendStatusUpdate(session);
    }
  } finally {
    // 释放信号量
    if (session._conductorSemRelease) {
      session._conductorSemRelease();
      session._conductorSemRelease = null;
      session.activeClaudes = Math.max(0, (session.activeClaudes || 1) - 1);
    }
  }
}

/**
 * 停止 Conductor Claude
 */
export async function stopConductorClaude(session) {
  const state = session.conductorState;
  if (!state) return;

  const sessionDataDir = getSessionDataDir(session.id);

  if (state.claudeSessionId) {
    await saveConductorSessionId(sessionDataDir, state.claudeSessionId)
      .catch(e => console.warn('[Conductor] Failed to save sessionId:', e.message));
  }

  if (state.abortController) {
    state.abortController.abort();
  }

  state.query = null;
  state.inputStream = null;
  state.turnActive = false;
  session.conductorState = null;

  if (session._conductorSemRelease) {
    session._conductorSemRelease();
    session._conductorSemRelease = null;
    session.activeClaudes = Math.max(0, (session.activeClaudes || 1) - 1);
  }
}

/**
 * 清空 Conductor Claude（强制新建对话）
 */
export async function clearConductorClaude(session) {
  await stopConductorClaude(session);
  const sessionDataDir = getSessionDataDir(session.id);
  await clearConductorSessionId(sessionDataDir);
}

// 导出解析函数供测试用
export { parseCreateTask, parseForwardTask };
