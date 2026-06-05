import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { query, Stream } from './sdk/index.js';
import ctx from './context.js';
import { sendConversationList, sendOutput, sendError, handleAskUserQuestion } from './conversation.js';
import { startSubagentWatcher, stopSubagentWatcher, cleanupSubagentWatchers } from './subagent.js';

/**
 * Detect whether a user message is a Claude Code compact summary.
 * These appear after context compaction and should not be displayed as a
 * normal user bubble — they're surfaced as a synthetic __CompactSummary
 * tool action instead.
 *
 * @param {string} text — user message content
 * @returns {boolean}
 */
export function isCompactSummary(text) {
  if (!text || text.length < 200) return false;
  // Claude Code compact summary always starts with this exact text
  if (text.includes('This session is being continued from a previous conversation')) return true;
  // Alternate compact summary indicator (Claude Code uses <system-reminder> blocks)
  if (text.includes('The summary below covers the earlier portion of the conversation')) return true;
  // Context compaction with numbered sections (1. Primary Request, 2. Key Technical Concepts, etc.)
  if (/^[\s\S]*Summary:[\s\S]*\d+\.\s+(Primary Request|Key Technical|Current Work)/m.test(text)) return true;
  return false;
}

/**
 * Parse a Claude Code background-task notification.
 * Claude CLI injects these as fake user messages after an Agent/Task tool
 * finishes, e.g.:
 *
 *   <task-notification>
 *     <task-id>...</task-id>
 *     <tool-use-id>...</tool-use-id>
 *     <output-file>...</output-file>
 *     <status>completed</status>
 *     <summary>...one-liner...</summary>
 *     <result>...full text...</result>
 *   </task-notification>
 *
 * We surface them as a synthetic __SubagentResult tool action so the UI
 * doesn't render them as a giant user bubble.
 *
 * @param {string} text
 * @returns {{ taskId: string, toolUseId: string, outputFile: string, status: string, summary: string, result: string } | null}
 */
export function parseTaskNotification(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<task-notification>')) return null;
  const pick = (tag) => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : '';
  };
  return {
    taskId: pick('task-id'),
    toolUseId: pick('tool-use-id'),
    outputFile: pick('output-file'),
    status: pick('status'),
    summary: pick('summary'),
    result: pick('result'),
  };
}

/**
 * Build a synthetic assistant.tool_use wire message that reuses the existing
 * tool-action persistence and rendering pipeline (`agent-output.js` stores
 * tool_use blocks as DB rows with message_type='tool_use'; the web ToolLine
 * component renders them with collapse/expand).
 *
 * @param {string} name  — synthetic tool name (e.g. '__SubagentResult')
 * @param {object} input — toolInput payload
 * @returns {object} a Claude SDK assistant-shaped message
 */
function buildSyntheticToolUseMessage(name, input) {
  return {
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: `synthetic-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        input,
      }],
    },
  };
}

/**
 * Determine maxContextTokens and autoCompactThreshold from model name.
 * Returns defaults suitable for the model's context window size.
 *
 * NOTE (2026-03): Opus 4.6 / Sonnet 4 have 200k context windows.
 * Claude Code handles its own compaction internally, so we set the
 * default threshold to 200k (effectively never triggers our custom compact).
 * The thresholds are kept as parameters in case we need to re-enable later.
 */
export function getModelContextConfig(modelName) {
  if (!modelName) return { maxContext: 200000, compactThreshold: 200000 };
  const name = modelName.toLowerCase();
  // Explicit 1M context indicators
  if (name.includes('1m') || name.includes('1000k')) {
    return { maxContext: 1000000, compactThreshold: 256000 };
  }
  // Default: 200k — Opus 4.6 / Sonnet 4 context window.
  // Claude Code manages its own compaction; we no longer need custom compact logic.
  return { maxContext: 200000, compactThreshold: 200000 };
}

/**
 * Start a Claude SDK query for a conversation
 * Uses the SDK with AsyncIterable input stream for bidirectional communication
 */
export async function startClaudeQuery(conversationId, workDir, resumeSessionId) {
  // 如果已存在，先保存 per-session 设置，再关闭
  let savedDisallowedTools = null;
  let savedUserId = undefined;
  let savedUsername = undefined;
  if (ctx.conversations.has(conversationId)) {
    const existing = ctx.conversations.get(conversationId);
    savedDisallowedTools = existing.disallowedTools ?? null;
    savedUserId = existing.userId;
    savedUsername = existing.username;
    if (existing.abortController) {
      existing.abortController.abort();
    }
    cleanupSubagentWatchers(conversationId);
    ctx.conversations.delete(conversationId);
  }

  // 创建输入流和 abort controller
  const inputStream = new Stream();
  const abortController = new AbortController();

  const state = {
    query: null,
    inputStream,
    workDir,
    claudeSessionId: resumeSessionId || null,
    createdAt: Date.now(),
    abortController,
    turnActive: false, // 是否有 turn 正在处理中
    turnResultReceived: false, // 当前 turn 是否已收到 result（用于抑制重复 result）
    // Metadata from system init message
    tools: [],
    slashCommands: [],
    model: null,
    // Usage tracking
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      totalCostUsd: 0
    },
    // 后台任务追踪: taskId -> { command, status, output, startTime, endTime }
    backgroundTasks: new Map(),
    // Per-session 工具禁用设置
    disallowedTools: savedDisallowedTools,
    // 保留用户信息（从旧 state 恢复）
    userId: savedUserId,
    username: savedUsername,
  };

  // 配置 SDK query 选项
  const options = {
    cwd: workDir,
    // 不显式设 permissionMode（让它走 SDK 默认 'default'）。
    // bypassPermissions 会让 CLI 跳过整个 permission 通道，但我们注册了
    // canCallTool（→ --permission-prompt-tool stdio）来拦截
    // AskUserQuestion；新版 Claude CLI 在 bypass+stdio 同时存在时会
    // 卡在 init 握手 / message_start 后死等。改用 default mode +
    // canCallTool 自动放行，是新 CLI 期望的形态。
    abort: abortController.signal,
    // 拦截 AskUserQuestion 工具调用，转发到 Web UI；其他工具自动放行
    canCallTool: async (toolName, input, toolCtx) => {
      if (toolName === 'AskUserQuestion') {
        return await handleAskUserQuestion(conversationId, input, toolCtx);
      }
      return { behavior: 'allow', updatedInput: input };
    }
  };

  // 禁用的工具：per-session 优先，否则使用全局默认
  const effectiveDisallowedTools = savedDisallowedTools != null
    ? savedDisallowedTools
    : (ctx.CONFIG.disallowedTools || []);
  if (effectiveDisallowedTools.length > 0) {
    options.disallowedTools = effectiveDisallowedTools;
    console.log(`[SDK] Disallowed tools: ${effectiveDisallowedTools.join(', ')}`);
  }

  // Validate session ID is a valid UUID before using it
  const isValidUUID = (id) => {
    if (!id) return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id);
  };

  const validResumeId = isValidUUID(resumeSessionId) ? resumeSessionId : null;
  console.log(`[SDK] resumeSessionId: "${resumeSessionId}" (length: ${resumeSessionId?.length})`);
  console.log(`[SDK] isValidUUID: ${isValidUUID(resumeSessionId)}`);
  console.log(`[SDK] validResumeId: "${validResumeId}"`);
  if (resumeSessionId && !validResumeId) {
    console.warn(`[SDK] Invalid session ID (not UUID): ${resumeSessionId}, starting fresh`);
    state.claudeSessionId = null; // Clear invalid ID
  }

  if (validResumeId) {
    options.resume = validResumeId;
  }

  console.log(`[SDK] Starting Claude query for ${conversationId}, resume: ${validResumeId || 'none'}`);

  // 使用 SDK 的 query 函数
  const claudeQuery = query({
    prompt: inputStream,
    options
  });

  state.query = claudeQuery;
  ctx.conversations.set(conversationId, state);

  // 异步处理 Claude 输出
  processClaudeOutput(conversationId, claudeQuery, state);

  // 注意：不在这里调用 sendConversationList()
  // 因为此时 turnActive 还是 false，会发送 processing: false 给 server
  // 由调用方（handleUserInput）在设置 turnActive = true 后再调用
  return state;
}

/**
 * Detect if an error message indicates prompt token count exceeded the model limit.
 * Matches API errors like "prompt token count of 138392 exceeds the limit of 128000".
 */
export function isPromptTokenOverflow(errorMessage) {
  if (!errorMessage) return false;
  const msg = errorMessage.toLowerCase();
  return msg.includes('prompt') && msg.includes('token') && (msg.includes('exceed') || msg.includes('limit'));
}

/**
 * 检测并追踪后台任务（仅 Bash 和 Agent 任务）
 * 普通工具调用（Read、Edit、Grep、Glob 等）不跟踪
 */
function detectAndTrackBackgroundTask(conversationId, state, message) {
  // 检测 assistant 消息中的 tool_use
  if (message.type === 'assistant' && message.message?.content) {
    const content = message.message.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolName = block.name;
        const toolInput = block.input || {};
        const toolUseId = block.id;

        // 跟踪 Bash 工具调用
        if (toolName === 'Bash') {
          const taskInfo = {
            id: toolUseId,
            type: 'bash',
            command: toolInput.command || '',
            description: toolInput.description || '',
            background: !!toolInput.run_in_background,
            status: 'running',
            output: '',
            startTime: Date.now(),
            endTime: null
          };
          state.backgroundTasks.set(toolUseId, taskInfo);
          console.log(`[Tasks] Bash: ${toolUseId}, command: ${taskInfo.command.substring(0, 50)}...`);

          ctx.sendToServer({
            type: 'background_task_started',
            conversationId,
            task: taskInfo
          });
        }

        // 跟踪 Task 工具（Agent 任务）
        else if (toolName === 'Task') {
          const taskInfo = {
            id: toolUseId,
            type: 'agent',
            description: toolInput.description || toolInput.prompt?.substring(0, 100) || 'Agent Task',
            prompt: toolInput.prompt || '',
            background: !!toolInput.run_in_background,
            status: 'running',
            output: '',
            startTime: Date.now(),
            endTime: null
          };
          state.backgroundTasks.set(toolUseId, taskInfo);
          console.log(`[Tasks] Agent: ${toolUseId}, desc: ${taskInfo.description}`);

          ctx.sendToServer({
            type: 'background_task_started',
            conversationId,
            task: taskInfo
          });

          // Start watching subagent JSONL files for this Task
          startSubagentWatcher(conversationId, state, toolUseId);
        }
      }
    }
  }

  // 检测 tool_result 消息（任务完成或输出更新）
  if (message.type === 'user' && message.tool_use_result) {
    const result = message.tool_use_result;
    // tool_use_result 格式可能是数组或单个对象
    const results = Array.isArray(result) ? result : [result];

    for (const r of results) {
      const toolUseId = r.tool_use_id;
      if (toolUseId && state.backgroundTasks.has(toolUseId)) {
        const taskInfo = state.backgroundTasks.get(toolUseId);
        const content = r.content || '';

        // 更新任务输出
        taskInfo.output += (typeof content === 'string' ? content : JSON.stringify(content)) + '\n';
        taskInfo.status = 'completed';
        taskInfo.endTime = Date.now();

        console.log(`[Tasks] Completed: ${toolUseId}`);

        ctx.sendToServer({
          type: 'background_task_output',
          conversationId,
          taskId: toolUseId,
          task: taskInfo
        });

        // Stop subagent watcher if this was a Task (Agent) tool_use
        if (taskInfo.type === 'agent') {
          stopSubagentWatcher(conversationId, toolUseId);
        }
      }
    }
  }

  // 检测 system 消息中的任务输出（实时输出）
  if (message.type === 'system' && message.subtype === 'task_output') {
    const taskId = message.task_id;
    if (taskId && state.backgroundTasks.has(taskId)) {
      const taskInfo = state.backgroundTasks.get(taskId);
      const output = message.output || message.content || '';

      taskInfo.output += output;

      ctx.sendToServer({
        type: 'background_task_output',
        conversationId,
        taskId,
        task: taskInfo,
        newOutput: output
      });
    }
  }
}

/**
 * Process Claude output messages asynchronously
 */
async function processClaudeOutput(conversationId, claudeQuery, state) {
  // 标记是否已在 result 消息中发送了 turn_completed
  let resultHandled = false;

  try {
    for await (const message of claudeQuery) {
      console.log('Output:', message.type, message.subtype || '');

      // Track last output time for ping health checks
      state._lastOutputTime = Date.now();

      // 捕获 system init 消息中的 metadata
      if (message.type === 'system' && message.subtype === 'init') {
        state.claudeSessionId = message.session_id;
        state.tools = message.tools || [];
        state.slashCommands = message.slash_commands || [];
        state.model = message.model || null;
        // Set per-conversation context config based on model
        const modelConfig = getModelContextConfig(state.model);
        state.maxContextTokens = modelConfig.maxContext;
        state.autoCompactThreshold = modelConfig.compactThreshold;
        console.log(`Claude session ID: ${state.claudeSessionId}`);
        console.log(`Model: ${state.model}`);
        console.log(`Model context: ${state.maxContextTokens} tokens, compact threshold: ${state.autoCompactThreshold}`);
        console.log(`Available tools: ${state.tools.length}`);
        console.log(`Tools: ${state.tools.join(', ')}`);
        console.log(`Available slash commands: ${state.slashCommands.join(', ')}`);

        // 通知服务器更新 claudeSessionId（用于历史会话恢复）
        ctx.sendToServer({
          type: 'session_id_update',
          conversationId,
          claudeSessionId: state.claudeSessionId,
          workDir: state.workDir
        });

        // 通知 web 端可用的 slash commands 列表（用于自动补全）
        // 缓存到 agent 级别，只在列表变化时才发送
        if (state.slashCommands.length > 0) {
          const changed = JSON.stringify(state.slashCommands) !== JSON.stringify(ctx.slashCommands);
          if (changed) {
            ctx.slashCommands = [...state.slashCommands];
            ctx.sendToServer({
              type: 'slash_commands_update',
              conversationId,
              slashCommands: state.slashCommands,
              slashCommandDescriptions: ctx.slashCommandDescriptions
            });
          }
        }

        // 从 tools 列表提取 MCP servers，发送 per-conversation MCP 列表
        const { serverNames: mcpServers, serverTools: mcpServerTools } = extractMcpServers(state.tools);
        if (mcpServers.length > 0) {
          // 根据当前 disallowed 设置计算每个 server 的 enabled 状态
          const effectiveDisallowed = state.disallowedTools ?? ctx.CONFIG.disallowedTools ?? [];
          const serversWithState = mcpServers.map(name => ({
            name,
            enabled: !effectiveDisallowed.some(d => d === `mcp__${name}` || d.startsWith(`mcp__${name}__`)),
            source: name === 'playwright' ? 'Built-in' : 'MCP'
          }));
          ctx.sendToServer({
            type: 'conversation_mcp_update',
            conversationId,
            servers: serversWithState,
            serverTools: mcpServerTools
          });
        }
      }

      // 捕获 compact 相关的 system 消息
      // Claude Code 在 context 不足时会自动 compact
      if (message.type === 'system') {
        // Debug: log all system messages for compact signal analysis
        console.log(`[${conversationId}] System msg: subtype=${message.subtype}, status=${message.status}, message=${(message.message || '').substring(0, 80)}`);

        // 新格式: subtype: 'status', status: 'compacting'
        if (message.subtype === 'status' && message.status === 'compacting') {
          state._compacting = true;
          console.log(`[${conversationId}] Compact started (status)`);
          ctx.sendToServer({
            type: 'compact_status',
            conversationId,
            status: 'compacting',
            message: 'Context compacting in progress...'
          });
        }
        // compact 边界标记 — 表示 compact 完成，后续会有 summary user 消息需要过滤
        if (message.subtype === 'compact_boundary') {
          state._compacting = false;
          state._compactSummaryPending = true;
          console.log(`[${conversationId}] Compact completed (boundary)`);
          ctx.sendToServer({
            type: 'compact_status',
            conversationId,
            status: 'completed',
            message: 'Context compacted successfully'
          });
        }
        // 旧格式兼容
        if (message.subtype === 'compact_start' || message.message?.includes?.('Compacting')) {
          state._compacting = true;
          console.log(`[${conversationId}] Compact started`);
          ctx.sendToServer({
            type: 'compact_status',
            conversationId,
            status: 'compacting',
            message: message.message || 'Context compacting in progress...'
          });
        }
        if (message.subtype === 'compact_complete' || message.subtype === 'compact_end') {
          state._compacting = false;
          state._compactSummaryPending = true;
          console.log(`[${conversationId}] Compact completed`);
          ctx.sendToServer({
            type: 'compact_status',
            conversationId,
            status: 'completed',
            message: message.message || 'Context compacted successfully'
          });
        }
        // 文本兜底: message.message 包含 compact/compacting 关键词
        if (!state._compacting && typeof message.message === 'string'
            && /compact/i.test(message.message)
            && !/compacted successfully/i.test(message.message)) {
          state._compacting = true;
          console.log(`[${conversationId}] Compact started (text fallback: ${message.message.substring(0, 60)})`);
          ctx.sendToServer({
            type: 'compact_status',
            conversationId,
            status: 'compacting',
            message: message.message
          });
        }
      }

      // 过滤 compact 过程中的 system 消息（如 status:null、重新 init）
      if (message.type === 'system' && state._compacting) {
        continue;
      }

      // Recognise the two classes of "fake user messages" Claude Code injects
      // back into the main conversation, and re-emit them as synthetic
      // assistant.tool_use blocks so they reuse the standard ToolLine
      // collapse/expand pipeline instead of showing as giant user bubbles.
      //
      //   1. <task-notification>...</task-notification> — emitted when a
      //      background Task (Agent tool) finishes. Surfaced as
      //      __SubagentResult.
      //   2. Compact summaries — emitted after context compaction. Surfaced
      //      as __CompactSummary. Two detection paths: the compact_boundary
      //      flag (set by the system message handler above) and a content
      //      fallback for sessions where Claude Code skips the boundary.
      if (message.type === 'user') {
        // Extract a plain-text view of the message content (Claude SDK may
        // wrap it as either a string or an array of {type,text} blocks).
        const userText = typeof message.content === 'string'
          ? message.content
          : (typeof message.message?.content === 'string' ? message.message.content
            : (Array.isArray(message.message?.content)
              ? message.message.content.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join('')
              : (Array.isArray(message.content)
                ? message.content.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').join('')
                : '')));

        // 1. <task-notification> from a completed background Agent/Task.
        const parsedTask = parseTaskNotification(userText);
        if (parsedTask) {
          console.log(`[${conversationId}] Rewriting <task-notification> as __SubagentResult tool action (task=${parsedTask.taskId})`);
          sendOutput(conversationId, buildSyntheticToolUseMessage('__SubagentResult', parsedTask));
          continue;
        }

        // 2a. Compact summary tagged by an earlier compact_boundary system event.
        if (state._compactSummaryPending) {
          console.log(`[${conversationId}] Rewriting compact summary (pending flag) as __CompactSummary tool action`);
          state._compactSummaryPending = false;
          sendOutput(conversationId, buildSyntheticToolUseMessage('__CompactSummary', { summary: userText }));
          continue;
        }

        // 2b. Compact summary content fallback (no boundary event was emitted).
        if (userText && isCompactSummary(userText)) {
          console.log(`[${conversationId}] Rewriting compact summary (content match) as __CompactSummary tool action`);
          if (!state._compactCompleteSent) {
            state._compactCompleteSent = true;
            ctx.sendToServer({
              type: 'compact_status',
              conversationId,
              status: 'completed',
              message: 'Context compacted successfully'
            });
          }
          sendOutput(conversationId, buildSyntheticToolUseMessage('__CompactSummary', { summary: userText }));
          continue;
        }
      }
      // The compact-summary-pending flag was previously cleared by the first
      // non-user message after the boundary. Now we clear it the moment we
      // consume the user message above, so anything else that arrives is
      // treated normally. Keep this defensive clear in case the SDK emits a
      // non-user message before the summary user message lands.
      if (state._compactSummaryPending && message.type !== 'user') {
        state._compactSummaryPending = false;
      }

      // 捕获 result 消息中的 usage 信息
      if (message.type === 'result') {
        // Log result message keys for debugging slash command output
        console.log(`[SDK] Result message keys: ${Object.keys(message).join(', ')}`);
        if (message.result_text) console.log(`[SDK] result_text: ${message.result_text.substring(0, 200)}`);
        if (message.result) console.log(`[SDK] result: ${String(message.result).substring(0, 200)}`);
        // 差值计算：usage 中的值是 query 实例级累计值
        if (message.usage) {
          const inputDelta = (message.usage.input_tokens || 0) - (state.lastResultInputTokens || 0);
          const outputDelta = (message.usage.output_tokens || 0) - (state.lastResultOutputTokens || 0);
          if (inputDelta > 0) state.usage.inputTokens += inputDelta;
          if (outputDelta > 0) state.usage.outputTokens += outputDelta;
          state.usage.cacheRead += Math.max(0, (message.usage.cache_read_input_tokens || 0) - (state.lastResultCacheRead || 0));
          state.usage.cacheCreation += Math.max(0, (message.usage.cache_creation_input_tokens || 0) - (state.lastResultCacheCreation || 0));
          state.lastResultInputTokens = message.usage.input_tokens || 0;
          state.lastResultOutputTokens = message.usage.output_tokens || 0;
          state.lastResultCacheRead = message.usage.cache_read_input_tokens || 0;
          state.lastResultCacheCreation = message.usage.cache_creation_input_tokens || 0;
        }
        // total_cost_usd 是全局累计值，直接赋值
        state.usage.totalCostUsd = message.total_cost_usd || 0;

        // 计算上下文使用百分比
        const inputTokens = message.usage?.input_tokens || 0;
        const maxContextTokens = state.maxContextTokens || ctx.CONFIG?.maxContextTokens || 128000;
        if (inputTokens > 0) {
          ctx.sendToServer({
            type: 'context_usage',
            conversationId,
            inputTokens,
            maxTokens: maxContextTokens,
            percentage: Math.min(100, Math.round((inputTokens / maxContextTokens) * 100))
          });
        }

        console.log(`[SDK] Query completed for ${conversationId}, cost: $${state.usage.totalCostUsd.toFixed(4)}, context: ${inputTokens}/${maxContextTokens} tokens`);

        // ★ Guard：当前 turn 已收到过 result，抑制 SDK 发出的重复 result
        // （长任务场景下 SDK 可能先发 result/success 再发 result/error_during_execution）
        if (state.turnResultReceived) {
          console.warn(`[SDK] Suppressing duplicate result for ${conversationId} (subtype: ${message.subtype || 'unknown'})`);
          continue;
        }

        // ★ Turn 完成：发送 turn_completed，进程继续运行等待下一条消息
        // stream-json 模式下 Claude 进程是持久运行的，for-await 在 result 后继续等待
        // 不清空 state.query 和 state.inputStream，下次用户消息直接通过同一个 inputStream 发送
        state.turnResultReceived = true;
        resultHandled = true;
        state.turnActive = false;

        // ★ await 确保 result 和 turn_completed 消息确实发送成功
        // 不 await 会导致 encrypt 失败时消息静默丢失，前端卡在"思考中"
        await sendOutput(conversationId, message);

        await ctx.sendToServer({
          type: 'turn_completed',
          conversationId,
          claudeSessionId: state.claudeSessionId,
          workDir: state.workDir
        });
        sendConversationList();

        // ★ Send pending user message after compact completes
        if (state._pendingUserMessage && state.inputStream) {
          const pendingMsg = state._pendingUserMessage;
          const pendingDisplayMsg = state._pendingDisplayMessage || pendingMsg;
          state._pendingUserMessage = null;
          state._pendingDisplayMessage = null;
          console.log(`[${conversationId}] Sending pending message after compact`);
          state.turnActive = true;
          state.turnResultReceived = false;
          sendOutput(conversationId, pendingDisplayMsg);
          state.inputStream.enqueue(pendingMsg);
          sendConversationList();
        }
        continue;
      }

      // 检测后台任务
      detectAndTrackBackgroundTask(conversationId, state, message);

      // Extract image blocks from assistant/tool_result messages, save locally, forward to server
      await extractAndSendChatImages(conversationId, state, message);

      // Debug: log assistant messages to help diagnose duplicate output issues
      if (message.type === 'assistant') {
        const text = typeof message.message?.content === 'string'
          ? message.message.content.substring(0, 80)
          : Array.isArray(message.message?.content)
            ? message.message.content.map(b => b.type).join(',')
            : '';
        console.log(`[SDK] assistant msg for ${conversationId}: ${text}`);
      }

      sendOutput(conversationId, message);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log(`[SDK] Query aborted for ${conversationId}`);
    } else if (resultHandled) {
      // Turn 已正常完成，进程退出产生的 error 不发送给用户
      console.warn(`[SDK] Ignoring post-result error for ${conversationId}: ${error.message}`);
    // DISABLED (2026-03): Opus 4.6 has 200k context. Claude Code handles its own compaction.
    // Keeping code for reference; re-enable if we ever need custom overflow recovery.
    // } else if (isPromptTokenOverflow(error.message) && state.claudeSessionId && !state._compactRetried) {
    //   // ★ 兜底：prompt token 溢出 → 自动 compact + 重试（而非暴露 raw API error 给用户）
    //   console.warn(`[SDK] Prompt token overflow for ${conversationId}, auto-compact + retry`);
    //   const savedSessionId = state.claudeSessionId;
    //   const savedLastMsg = state._lastUserMessage;
    //
    //   ctx.sendToServer({
    //     type: 'compact_status',
    //     conversationId,
    //     status: 'compacting',
    //     message: 'Context too long, auto-compacting and retrying...'
    //   });
    //
    //   // 重启 SDK（startClaudeQuery 会先 abort 当前 state，使 finally 中 isStale=true）
    //   try {
    //     const newState = await startClaudeQuery(conversationId, state.workDir, savedSessionId);
    //     newState._compactRetried = true; // 防止无限重试
    //     newState.turnActive = true;
    //     newState.turnResultReceived = false;
    //
    //     // 先 compact，再重试原始消息（如果有的话）
    //     if (savedLastMsg) {
    //       newState._pendingUserMessage = savedLastMsg;
    //     }
    //     newState.inputStream.enqueue({
    //       type: 'user',
    //       message: { role: 'user', content: '/compact' }
    //     });
    //     sendConversationList();
    //   } catch (retryError) {
    //     console.error(`[SDK] Compact-retry failed for ${conversationId}:`, retryError.message);
    //     sendError(conversationId, `Context too long. Auto-compact failed: ${retryError.message}`);
    //   }
    } else {
      console.error(`[SDK] Error for ${conversationId}:`, error.message);
      sendError(conversationId, error.message);
    }
  } finally {
    // 查询完成后清理
    // 注意：必须用传入的 state 参数，不能用 conversations.get(conversationId)
    // 因为在取消+重发的竞态场景下，conversations 中可能已经是新 state 了
    const conv = state;
    const currentConv = ctx.conversations.get(conversationId);
    const isStale = currentConv !== conv; // 已被新 startClaudeQuery 替换

    const claudeSessionId = conv?.claudeSessionId;
    const wasCancelled = conv?.cancelled;
    const wasTurnActive = conv?.turnActive; // 保存清理前的 turnActive 状态

    // 只有当前 state 未被替换时才清理
    if (!isStale && conv) {
      conv.query = null;
      conv.inputStream = null;
      conv.turnActive = false;
      conv.cancelled = false; // 重置取消标志
    }

    if (isStale) {
      // state 已被新查询替换，不做任何清理操作
      console.log(`[SDK] Stale processClaudeOutput for ${conversationId}, skipping cleanup`);
    } else if (!wasCancelled && (wasTurnActive || !resultHandled)) {
      // 进程异常退出：要么 turn 正在进行中，要么从未成功完成过任何 turn
      cleanupSubagentWatchers(conversationId);
      ctx.sendToServer({
        type: 'conversation_closed',
        conversationId,
        claudeSessionId,
        workDir: conv?.workDir,
        exitCode: 0,
        processExited: true
      });
    }
    // wasCancelled 时由 handleCancelExecution 已发送 execution_cancelled

    sendConversationList();
  }
}

/**
 * Extract image content blocks from a Claude SDK message, save to local files,
 * and send chat_image messages to server. Images are persisted under workDir/.data/images/.
 * Handles both assistant messages (image blocks) and user/tool_result messages (screenshot results).
 */
let _imageCounter = 0;
async function extractAndSendChatImages(conversationId, state, message) {
  let contentBlocks = null;

  // assistant messages: image blocks in message.message.content
  if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
    contentBlocks = message.message.content;
  }
  // user/tool_result messages: image blocks in message.message.content (tool results with screenshots)
  if (message.type === 'user' && Array.isArray(message.message?.content)) {
    contentBlocks = message.message.content;
  }

  if (!contentBlocks) return;

  for (const block of contentBlocks) {
    if (block.type === 'image' && block.source?.type === 'base64' && block.source?.data) {
      try {
        const mimeType = block.source.media_type || 'image/png';
        const ext = (mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const imageDir = join(state.workDir, '.data', 'images');
        await mkdir(imageDir, { recursive: true });

        const filename = `chat-${Date.now()}-${++_imageCounter}.${ext}`;
        const filePath = join(imageDir, filename);
        const buffer = Buffer.from(block.source.data, 'base64');

        // Size check: skip images larger than 10MB
        if (buffer.length > 10 * 1024 * 1024) {
          console.warn(`[Chat Image] Image too large: ${buffer.length} bytes, skipping`);
          continue;
        }

        await writeFile(filePath, buffer);
        console.log(`[Chat Image] Saved: ${filePath} (${buffer.length} bytes, ${mimeType})`);

        // Send to server with base64 data for immediate serving + filePath for persistence reference
        ctx.sendToServer({
          type: 'chat_image',
          conversationId,
          mimeType,
          data: block.source.data,
          filePath,
          filename
        });
      } catch (err) {
        console.error(`[Chat Image] Failed to save image:`, err.message);
      }
    }
  }
}

/**
 * 从 tools 列表中提取 MCP server 名称和 per-server tools 映射。
 * MCP 工具名称格式: mcp__<serverName>__<toolName>
 * @param {string[]} tools
 * @returns {{ serverNames: string[], serverTools: Object<string, string[]> }}
 */
function extractMcpServers(tools) {
  const serverToolsMap = {};
  for (const tool of tools) {
    const parts = tool.split('__');
    if (parts.length >= 3 && parts[0] === 'mcp') {
      const serverName = parts[1];
      if (!serverToolsMap[serverName]) {
        serverToolsMap[serverName] = [];
      }
      serverToolsMap[serverName].push(tool);
    }
  }
  return {
    serverNames: Object.keys(serverToolsMap),
    serverTools: serverToolsMap
  };
}

