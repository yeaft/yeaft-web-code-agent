/**
 * Conductor — Conductor Claude Instance (V5)
 *
 * Conductor Claude is a persistent Claude Code process that:
 * 1. Classifies messages (Q&A / create task / forward to task / status)
 * 2. Answers simple questions
 * 3. Never does task analysis or step decomposition
 *
 * cwd = Conductor Home (~/.config/yeaft-agent/.conductor/)
 * State.json summary injected into systemPrompt for task awareness.
 */
import { query, Stream } from '../sdk/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { globalSemaphore } from './semaphore.js';
import {
  sendConductorMessage, sendConductorOutput,
  endConductorStreaming, sendStatusUpdate
} from './ui-messages.js';
import {
  getConductorHome, ensureConductorHome,
  loadState, saveState, updateTaskInState, initTaskDir
} from './persistence.js';
import { startTaskExecution } from './task-runner.js';

// =====================================================================
// Claude Session ID Persistence
// =====================================================================

async function saveConductorSessionId(claudeSessionId) {
  const dir = await ensureConductorHome();
  const filePath = join(dir, 'claude-session.json');
  await fs.writeFile(filePath, JSON.stringify({
    claudeSessionId, savedAt: Date.now()
  }));
}

async function loadConductorSessionId() {
  const filePath = join(getConductorHome(), 'claude-session.json');
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    return data.claudeSessionId || null;
  } catch {
    return null;
  }
}

async function clearConductorSessionId() {
  const filePath = join(getConductorHome(), 'claude-session.json');
  try { await fs.unlink(filePath); } catch { /* ok */ }
}

// =====================================================================
// System Prompt
// =====================================================================

function buildConductorSystemPrompt(conductor) {
  // Build task summaries from in-memory tasks map
  const taskLines = [];
  for (const [taskId, t] of conductor.tasks) {
    const actors = (t.activeActors || []).join(', ');
    taskLines.push(`- ${taskId}: ${t.title} [${t.status}${t.currentStep ? ' ' + t.currentStep : ''}] workDir=${t.workDir} scenario=${t.scenario}${actors ? ' actors=' + actors : ''}`);
  }
  const taskSummaries = taskLines.join('\n');

  return `# Conductor — 交响乐指挥台

你是 Conductor，项目的总指挥。你的职责是：
1. **分类消息**：判断用户的输入是简单问答还是需要创建任务
2. **创建任务**：通过 CREATE_TASK 指令创建新任务（必须指定 workDir 和 scenario）
3. **转发消息**：通过 FORWARD_TASK 将用户消息传递给已有任务
4. **回答问题**：直接回答简单的问题
5. **汇报状态**：用户询问进度时汇总所有任务状态

## 你绝对不做的事
- 不分析任务难度
- 不拆解任务步骤
- 不评估需要几个人
- 不写代码

## 当前活跃任务
${taskSummaries || '(无)'}

## 指令格式

### 创建任务
当用户的需求需要实际的开发/分析/设计工作时，输出：

\`\`\`
---CREATE_TASK---
title: <任务标题>
workDir: <项目工作路径>
scenario: <dev|writing|trading|video>
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
- 创建任务时必须指定 workDir（用户提到的项目路径）和 scenario（场景类型）
- 如果用户没指定 workDir 或 scenario，先询问
- 如果用户问"进度怎样"，直接汇总上面的任务列表状态
- 保持回复简洁
- 用中文回复`;
}

// =====================================================================
// Conductor Claude Instance
// =====================================================================

/**
 * Create or rebuild Conductor Claude instance
 */
export async function createConductorClaude(conductor) {
  const conductorHome = await ensureConductorHome();

  // Acquire semaphore
  const release = await globalSemaphore.acquire();
  conductor._conductorSemRelease = release;
  conductor.activeClaudes = (conductor.activeClaudes || 0) + 1;

  const inputStream = new Stream();
  const abortController = new AbortController();
  const systemPrompt = buildConductorSystemPrompt(conductor);

  // Try to resume existing Claude session
  const savedSessionId = await loadConductorSessionId();

  const queryOptions = {
    cwd: conductorHome,
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

  conductor.conductorState = {
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

  // Start output processing loop
  processConductorOutput(conductor, conductorQuery);

  return conductor.conductorState;
}

/**
 * Send message to Conductor Claude
 */
export async function sendToConductor(conductor, content) {
  let state = conductor.conductorState;

  if (!state || !state.query || !state.inputStream) {
    state = await createConductorClaude(conductor);
  }

  // Inject task context before user message
  const taskContext = buildTaskContext(conductor);
  const fullContent = taskContext
    ? `${content}\n\n---\n<conductor-context>\n${taskContext}\n</conductor-context>`
    : content;

  state.turnActive = true;
  state.accumulatedText = '';
  state._lastUserContent = content;  // Preserve original user input for task description
  state.inputStream.enqueue({
    type: 'user',
    message: { role: 'user', content: fullContent }
  });

  sendStatusUpdate(conductor);
}

function buildTaskContext(conductor) {
  if (conductor.tasks.size === 0) return null;
  const lines = ['活跃任务:'];
  for (const [taskId, t] of conductor.tasks) {
    const actors = (t.activeActors || []).join(', ');
    lines.push(`- ${taskId}: ${t.title} [${t.status}] workDir=${t.workDir} scenario=${t.scenario}${actors ? ' actors=' + actors : ''}`);
  }
  return lines.join('\n');
}

// =====================================================================
// Output Processing
// =====================================================================

// Parse CREATE_TASK instruction (V5: includes workDir and scenario)
function parseCreateTask(text) {
  const regex = /---CREATE_TASK---\s*\n([\s\S]*?)---END_CREATE_TASK---/g;
  const tasks = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/^title:\s*(.+)/im);
    const workDirMatch = block.match(/^workDir:\s*(.+)/im);
    const scenarioMatch = block.match(/^scenario:\s*(.+)/im);
    if (titleMatch) {
      tasks.push({
        title: titleMatch[1].trim(),
        workDir: workDirMatch ? workDirMatch[1].trim() : '',
        scenario: scenarioMatch ? scenarioMatch[1].trim() : 'dev'
      });
    }
  }
  return tasks;
}

// Parse FORWARD_TASK instruction
function parseForwardTask(text) {
  const regex = /---FORWARD_TASK---\s*\n([\s\S]*?)---END_FORWARD_TASK---/g;
  const forwards = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const taskIdMatch = block.match(/^taskId:\s*(.+)/im);
    // message may be multi-line: capture from "message:" to end of block
    const messageMatch = block.match(/^message:\s*([\s\S]*)$/im);
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
 * Process Conductor Claude streaming output
 */
async function processConductorOutput(conductor, conductorQuery) {
  const state = conductor.conductorState;

  try {
    for await (const message of conductorQuery) {
      if (conductor.status === 'stopped') break;

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
            sendConductorOutput(conductor, 'text', message);
          } else if (Array.isArray(content)) {
            let hasText = false;
            for (const block of content) {
              if (block.type === 'text') {
                state.accumulatedText += block.text;
                hasText = true;
              } else if (block.type === 'tool_use') {
                endConductorStreaming(conductor);
                sendConductorOutput(conductor, 'tool_use', message);
              }
            }
            if (hasText) {
              sendConductorOutput(conductor, 'text', message);
            }
          }
        }
      } else if (message.type === 'user') {
        sendConductorOutput(conductor, 'tool_result', message);
      } else if (message.type === 'result') {
        // Turn completed
        console.log('[Conductor] Turn completed');
        endConductorStreaming(conductor);

        // Update costs
        if (message.total_cost_usd != null) {
          const costDelta = message.total_cost_usd - state.lastCostUsd;
          if (costDelta > 0) conductor.costUsd += costDelta;
          state.lastCostUsd = message.total_cost_usd;
        }
        if (message.usage) {
          const inputDelta = (message.usage.input_tokens || 0) - (state.lastInputTokens || 0);
          const outputDelta = (message.usage.output_tokens || 0) - (state.lastOutputTokens || 0);
          if (inputDelta > 0) conductor.totalInputTokens += inputDelta;
          if (outputDelta > 0) conductor.totalOutputTokens += outputDelta;
          state.lastInputTokens = message.usage.input_tokens || 0;
          state.lastOutputTokens = message.usage.output_tokens || 0;
        }

        // Persist Claude session ID
        if (state.claudeSessionId) {
          saveConductorSessionId(state.claudeSessionId)
            .catch(e => console.warn('[Conductor] Failed to save sessionId:', e.message));
        }

        // Parse instructions
        const createTasks = parseCreateTask(state.accumulatedText);
        const forwardTasks = parseForwardTask(state.accumulatedText);

        // Handle CREATE_TASK
        for (const ct of createTasks) {
          const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

          // Notify frontend: task is being created (worktree may take a few seconds)
          sendConductorOutput(conductor, 'task_creating', null, {
            taskId, taskTitle: ct.title
          });
          sendConductorMessage({
            type: 'conductor_task_creating',
            taskId,
            title: ct.title,
            workDir: ct.workDir,
            scenario: ct.scenario
          });

          // Create task directory at {workDir}/.conductor/{taskId}/ (includes worktree)
          let worktreePath = null;
          if (ct.workDir) {
            try {
              const result = await initTaskDir(ct.workDir, taskId);
              worktreePath = result.worktreePath || null;
            } catch (e) {
              console.warn(`[Conductor] Failed to create task dir: ${e.message}`);
            }
          }

          // Extract user's original message as task description
          // (the content that triggered this CREATE_TASK)
          const userDescription = state._lastUserContent || ct.title;

          // Register in state.json
          const taskEntry = {
            taskId,
            title: ct.title,
            description: userDescription,
            workDir: ct.workDir,
            scenario: ct.scenario,
            status: 'created',
            activeActors: [],
            currentStep: '',
            worktreePath,
            lastUpdate: Date.now()
          };
          conductor.tasks.set(taskId, taskEntry);

          await updateTaskInState(taskId, taskEntry).catch(e =>
            console.warn('[Conductor] Failed to update state.json:', e.message)
          );

          sendConductorOutput(conductor, 'task_created', null, {
            taskId, taskTitle: ct.title
          });

          sendConductorMessage({
            type: 'conductor_task_created',
            task: taskEntry
          });

          console.log(`[Conductor] Task created: ${taskId} — ${ct.title} @ ${ct.workDir} (${ct.scenario})`);

          // Start Orchestrator-driven execution (fire-and-forget)
          startTaskExecution(conductor, taskEntry).catch(e =>
            console.error(`[Conductor] Task execution failed for ${taskId}:`, e.message)
          );
        }

        // Handle FORWARD_TASK
        for (const ft of forwardTasks) {
          const task = conductor.tasks.get(ft.taskId);
          if (task) {
            if (!task.inbox) task.inbox = [];
            task.inbox.push({
              from: 'conductor',
              content: ft.message,
              timestamp: Date.now()
            });
            task.lastUpdate = Date.now();

            sendConductorOutput(conductor, 'task_forwarded', null, {
              taskId: ft.taskId
            });

            sendConductorMessage({
              type: 'conductor_task_message',
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

        sendConductorMessage({ type: 'conductor_turn_completed' });
        sendStatusUpdate(conductor);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('[Conductor] Claude aborted');
    } else {
      console.error('[Conductor] Claude error:', error.message);
      endConductorStreaming(conductor);
      state.turnActive = false;
      state.query = null;
      state.inputStream = null;
      state.accumulatedText = '';

      sendConductorMessage({
        type: 'conductor_error',
        error: error.message.substring(0, 500)
      });

      conductor.status = 'waiting_user';
      sendStatusUpdate(conductor);
    }
  } finally {
    if (conductor._conductorSemRelease) {
      conductor._conductorSemRelease();
      conductor._conductorSemRelease = null;
      conductor.activeClaudes = Math.max(0, (conductor.activeClaudes || 1) - 1);
    }
  }
}

/**
 * Stop Conductor Claude
 */
export async function stopConductorClaude(conductor) {
  const state = conductor.conductorState;
  if (!state) return;

  if (state.claudeSessionId) {
    await saveConductorSessionId(state.claudeSessionId)
      .catch(e => console.warn('[Conductor] Failed to save sessionId:', e.message));
  }

  if (state.abortController) {
    state.abortController.abort();
  }

  state.query = null;
  state.inputStream = null;
  state.turnActive = false;
  conductor.conductorState = null;

  if (conductor._conductorSemRelease) {
    conductor._conductorSemRelease();
    conductor._conductorSemRelease = null;
    conductor.activeClaudes = Math.max(0, (conductor.activeClaudes || 1) - 1);
  }
}

/**
 * Clear Conductor Claude (force new conversation)
 */
export async function clearConductorClaude(conductor) {
  await stopConductorClaude(conductor);
  await clearConductorSessionId();
}

// Export parse functions for testing
export { parseCreateTask, parseForwardTask };
