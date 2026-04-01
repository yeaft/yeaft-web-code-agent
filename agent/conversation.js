import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import ctx from './context.js';
import { query } from './sdk/index.js';
import { loadSessionHistory } from './history.js';
import { startClaudeQuery } from './claude.js';
import { crewSessions, loadCrewIndex } from './crew.js';

// 不支持的斜杠命令（真正需要交互式 CLI 的命令）
const UNSUPPORTED_SLASH_COMMANDS = ['/help', '/bug', '/login', '/logout', '/terminal-setup', '/vim', '/config'];

// 内置命令的描述（作为 fallback，这些命令 CLI 不提供 frontmatter 描述）
const BUILTIN_COMMAND_DESCRIPTIONS = {
  compact: 'Compact conversation context',
  context: 'Show context usage',
  cost: 'Show token costs',
  init: 'Reinitialize session',
  review: 'Code review',
  insights: 'Session insights',
  'pr-comments': 'PR comment review',
  'release-notes': 'Generate release notes',
  'security-review': 'Security review',
  heapdump: 'Heap dump (debug)',
};

/**
 * Load command and skill descriptions from installed plugins.
 * Scans commands/*.md and skills/ ** /SKILL.md (recursively) for each plugin.
 * Parses YAML frontmatter to extract name and description fields.
 * Results are cached in ctx.slashCommandDescriptions.
 * Also populates ctx.slashCommands from the loaded descriptions.
 */
export function loadPluginCommandDescriptions() {
  if (Object.keys(ctx.slashCommandDescriptions).length > 0) return; // already loaded

  try {
    const installedPath = join(homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const installed = JSON.parse(readFileSync(installedPath, 'utf-8'));

    for (const [pluginKey, entries] of Object.entries(installed.plugins || {})) {
      // pluginKey: "yeaft-skills@yeaft-skills-dev"
      const pluginName = pluginKey.split('@')[0]; // "yeaft-skills"
      for (const entry of entries) {
        // --- Scan commands/*.md ---
        const commandsDir = join(entry.installPath, 'commands');
        let files;
        try {
          files = readdirSync(commandsDir).filter(f => f.endsWith('.md'));
        } catch { files = []; }

        for (const file of files) {
          try {
            const content = readFileSync(join(commandsDir, file), 'utf-8');
            const fm = parseFrontmatter(content);
            if (fm.name && fm.description) {
              // CLI uses pluginName:commandName format (e.g. "yeaft-skills:sprint")
              const cliName = `${pluginName}:${fm.name}`;
              // Take first line of description only
              const desc = fm.description.split('\n')[0].trim();
              ctx.slashCommandDescriptions[cliName] = desc;
            }
          } catch { /* skip unparseable files */ }
        }

        // --- Scan skills/*/SKILL.md (recursive) ---
        const skillsDir = join(entry.installPath, 'skills');
        scanSkillsDir(skillsDir, pluginName);
      }
    }

    // Add builtin descriptions as fallback
    for (const [name, desc] of Object.entries(BUILTIN_COMMAND_DESCRIPTIONS)) {
      if (!ctx.slashCommandDescriptions[name]) {
        ctx.slashCommandDescriptions[name] = desc;
      }
    }

    // Build ctx.slashCommands from the loaded descriptions
    // This populates the command list without needing a CLI spawn
    if (ctx.slashCommands.length === 0) {
      ctx.slashCommands = Object.keys(ctx.slashCommandDescriptions);
    }

    console.log(`[Preload] Loaded ${Object.keys(ctx.slashCommandDescriptions).length} command/skill descriptions from filesystem`);
  } catch (err) {
    console.warn('[Preload] Failed to load plugin command descriptions:', err.message);
  }
}

/**
 * Recursively scan a skills directory for SKILL.md files.
 * Handles nested structures like skills/personas/pm-jobs/SKILL.md.
 */
function scanSkillsDir(dir, pluginName) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch { return; }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    if (stat.isDirectory()) {
      // Check for SKILL.md in this subdirectory
      const skillFile = join(fullPath, 'SKILL.md');
      try {
        const content = readFileSync(skillFile, 'utf-8');
        const fm = parseFrontmatter(content);
        if (fm.name && fm.description) {
          const cliName = `${pluginName}:${fm.name}`;
          const desc = fm.description.split('\n')[0].trim();
          ctx.slashCommandDescriptions[cliName] = desc;
        }
      } catch { /* no SKILL.md or unparseable — continue into subdirectories */ }

      // Recurse into subdirectories (handles nested skills like personas/pm-jobs/)
      scanSkillsDir(fullPath, pluginName);
    }
  }
}

/**
 * Minimal YAML frontmatter parser for commands/*.md files.
 * Extracts name and description from --- delimited frontmatter.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm = {};
  const lines = match[1].split('\n');
  let currentKey = null;
  let multilineValue = '';

  for (const line of lines) {
    // New key: value pair
    const kvMatch = line.match(/^(\w+):\s*(.*)/);
    if (kvMatch) {
      // Save previous multiline value
      if (currentKey && multilineValue) {
        fm[currentKey] = multilineValue.trim();
      }
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      if (val === '|' || val === '>') {
        multilineValue = '';
      } else {
        fm[currentKey] = val;
        currentKey = null;
        multilineValue = '';
      }
    } else if (currentKey && (line.startsWith('  ') || line.trim() === '')) {
      // Continuation of multiline value
      multilineValue += (multilineValue ? '\n' : '') + line.trimStart();
    }
  }
  // Save last multiline value
  if (currentKey && multilineValue) {
    fm[currentKey] = multilineValue.trim();
  }

  return fm;
}

/**
 * Prestart Claude CLI process in background (fire-and-forget).
 * When the query starts, processClaudeOutput will receive the system init message
 * containing skills/tools/model and push them to the frontend immediately.
 * This eliminates the delay where users had to send a message first.
 *
 * Errors are silently caught — failure just degrades to lazy-start behavior.
 */
function prestartClaude(conversationId, workDir, resumeSessionId) {
  startClaudeQuery(conversationId, workDir, resumeSessionId).catch(err => {
    console.warn(`[Prestart] Failed for ${conversationId}: ${err.message}`);
  });
}

/**
 * Preload slash commands — filesystem-first, CLI-spawn as optional fallback.
 *
 * 1. Load command/skill descriptions from plugin filesystem (instant, no process spawn).
 *    This also populates ctx.slashCommands from the loaded descriptions.
 * 2. Send slash_commands_update to frontend immediately.
 * 3. If ctx.slashCommands was already populated by filesystem, skip CLI spawn entirely.
 *    Otherwise fall back to spawning a CLI process to get commands from system init.
 *
 * @param {string} [workDir] - Project directory (default: agent workDir)
 * @param {string} [targetId] - conversationId to key the update to
 *                               ('__preload__' for agent-level, or crewSessionId)
 */
export async function preloadSlashCommands(workDir, targetId = '__preload__') {
  const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

  // Step 1: Load from filesystem (cached, runs once)
  loadPluginCommandDescriptions();

  // Step 2: If filesystem loaded commands, send update immediately (no CLI needed)
  if (ctx.slashCommands.length > 0) {
    ctx.sendToServer({
      type: 'slash_commands_update',
      conversationId: targetId,
      slashCommands: ctx.slashCommands,
      slashCommandDescriptions: ctx.slashCommandDescriptions
    });
    console.log(`[Preload] ${targetId}: ${ctx.slashCommands.length} slash commands ready from filesystem (no CLI spawn needed)`);
    return;
  }

  // Step 3: Fallback — spawn CLI to get slash commands from system init
  try {
    const abortController = new AbortController();
    // Use --print with a cheap built-in command to trigger system init.
    // In stream-json mode, Claude CLI won't emit init until a user message arrives,
    // so we use string prompt mode instead which triggers init immediately.
    const claudeQuery = query({
      prompt: '/cost',
      options: {
        cwd: effectiveWorkDir,
        permissionMode: 'bypassPermissions',
        abort: abortController.signal,
        maxTurns: 1,
        noSessionPersistence: true
      }
    });
    for await (const message of claudeQuery) {
      if (message.type === 'system' && message.subtype === 'init') {
        const slashCommands = message.slash_commands || [];
        if (slashCommands.length > 0) {
          // Update agent-level cache if this is the first load
          if (ctx.slashCommands.length === 0) {
            ctx.slashCommands = [...slashCommands];
          }
          ctx.sendToServer({
            type: 'slash_commands_update',
            conversationId: targetId,
            slashCommands,
            slashCommandDescriptions: ctx.slashCommandDescriptions
          });
          console.log(`[Preload] ${targetId}: loaded ${slashCommands.length} slash commands from CLI fallback`);
        }
        abortController.abort();
        break;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.warn(`[Preload] Failed for ${targetId}: ${err.message}`);
    }
  }
}

/**
 * 解析斜杠命令
 * @param {string} message - 用户消息
 * @returns {{type: string|null, command?: string, message: string, passthrough?: boolean}}
 */
export function parseSlashCommand(message) {
  if (!message) return { type: null, message: '' };
  const trimmed = message.trim();

  // 检查是否是不支持的斜杠命令
  for (const cmd of UNSUPPORTED_SLASH_COMMANDS) {
    if (trimmed === cmd || trimmed.startsWith(cmd + ' ')) {
      return { type: 'unsupported', command: cmd, message: trimmed };
    }
  }

  // 其他所有 / 开头的命令都传递给 Claude 处理
  // 包括 /compact, /init, /doctor, /memory, /model, /review, /mcp, /cost, /context, /skills
  // 以及用户定义的自定义 skills 如 /commit, /pr 等
  if (trimmed.startsWith('/') && trimmed.length > 1) {
    const match = trimmed.match(/^(\/[a-zA-Z0-9_-]+)/);
    if (match) {
      return { type: 'skill', command: match[1], message: trimmed };
    }
  }

  return { type: null, message };
}

// 发送 conversation 列表（含活跃 crew sessions + 索引中已停止的 crew sessions）
export async function sendConversationList() {
  const list = [];
  for (const [id, state] of ctx.conversations) {
    const entry = {
      id,
      workDir: state.workDir,
      claudeSessionId: state.claudeSessionId,
      createdAt: state.createdAt,
      processing: !!state.turnActive,
      userId: state.userId,
      username: state.username
    };
    list.push(entry);
  }
  // 追加活跃 crew sessions
  const activeCrewIds = new Set();
  for (const [id, session] of crewSessions) {
    activeCrewIds.add(id);
    list.push({
      id,
      workDir: session.projectDir,
      createdAt: session.createdAt,
      processing: session.status === 'running',
      userId: session.userId,
      username: session.username,
      type: 'crew',
    });
  }
  // 追加索引中已停止的 crew sessions（不重复，跳过 hidden）
  try {
    const index = await loadCrewIndex();
    for (const entry of index) {
      if (!activeCrewIds.has(entry.sessionId) && !entry.hidden) {
        list.push({
          id: entry.sessionId,
          workDir: entry.projectDir,
          createdAt: entry.createdAt,
          processing: false,
          userId: entry.userId,
          username: entry.username,
          type: 'crew'
        });
      }
    }
  } catch (e) {
    console.warn('[sendConversationList] Failed to load crew index:', e.message);
  }
  ctx.sendToServer({
    type: 'conversation_list',
    conversations: list
  });
}

export function sendOutput(conversationId, data) {
  return ctx.sendToServer({
    type: 'claude_output',
    conversationId,
    data
  });
}

export function sendError(conversationId, message) {
  ctx.sendToServer({
    type: 'error',
    conversationId,
    message
  });
}

// 创建新的 conversation (延迟启动 Claude，等待用户发送第一条消息)
export async function createConversation(msg) {
  const { conversationId, workDir, userId, username, disallowedTools } = msg;
  const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

  console.log(`Creating conversation: ${conversationId} in ${effectiveWorkDir} (lazy start)`);
  if (username) console.log(`  User: ${username} (${userId})`);

  // 只创建 conversation 状态，不启动 Claude 进程
  // Claude 进程会在用户发送第一条消息时启动 (见 handleUserInput)
  ctx.conversations.set(conversationId, {
    query: null,
    inputStream: null,
    workDir: effectiveWorkDir,
    claudeSessionId: null,
    createdAt: Date.now(),
    abortController: null,
    tools: [],
    slashCommands: [],
    model: null,
    userId,
    username,
    disallowedTools: disallowedTools || null,  // null = 使用全局默认
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      totalCostUsd: 0
    }
  });

  ctx.sendToServer({
    type: 'conversation_created',
    conversationId,
    workDir: effectiveWorkDir,
    userId,
    username,
    disallowedTools: disallowedTools || null
  });

  // 立即发送 agent 级别的 MCP servers 列表（从 ~/.claude.json 读取的）
  // 让前端在 Claude CLI init 之前就能显示 MCP 配置入口
  // Claude CLI init 后会用实际 tools 列表覆盖更新
  if (ctx.mcpServers.length > 0) {
    const effectiveDisallowed = disallowedTools || ctx.CONFIG.disallowedTools || [];
    const serversWithState = ctx.mcpServers.map(s => ({
      name: s.name,
      enabled: !effectiveDisallowed.some(d => d === `mcp__${s.name}` || d.startsWith(`mcp__${s.name}__`)),
      source: s.source
    }));
    ctx.sendToServer({
      type: 'conversation_mcp_update',
      conversationId,
      servers: serversWithState
    });
  }

  sendConversationList();

  // ★ Prestart Claude CLI in background to eagerly fetch skills/tools/model
  // Fire-and-forget: failure just degrades to lazy-start behavior
  prestartClaude(conversationId, effectiveWorkDir, null);
}

// Resume 历史 conversation (延迟启动 Claude，等待用户发送第一条消息)
export async function resumeConversation(msg) {
  const { conversationId, claudeSessionId, workDir, userId, username, disallowedTools } = msg;
  const effectiveWorkDir = workDir || ctx.CONFIG.workDir;

  console.log(`[Resume] conversationId: ${conversationId}`);
  console.log(`[Resume] claudeSessionId: ${claudeSessionId}`);
  console.log(`[Resume] workDir: ${effectiveWorkDir} (lazy start)`);

  // 清理旧条目：同 conversationId 或同 claudeSessionId 的条目（避免重复恢复同一个 session 累积）
  for (const [id, conv] of ctx.conversations) {
    if (id === conversationId || (claudeSessionId && conv.claudeSessionId === claudeSessionId)) {
      console.log(`[Resume] Cleaning up old conversation: ${id} (claudeSessionId: ${conv.claudeSessionId})`);
      if (conv.abortController) {
        conv.abortController.abort();
      }
      if (conv.inputStream) {
        try { conv.inputStream.done(); } catch {}
      }
      ctx.conversations.delete(id);
    }
  }

  const historyMessages = loadSessionHistory(effectiveWorkDir, claudeSessionId);
  if (username) console.log(`[Resume] User: ${username} (${userId})`);
  console.log(`Loaded ${historyMessages.length} history messages`);

  // 只创建 conversation 状态并保存 claudeSessionId，不启动 Claude 进程
  // Claude 进程会在用户发送第一条消息时启动 (见 handleUserInput)
  ctx.conversations.set(conversationId, {
    query: null,
    inputStream: null,
    workDir: effectiveWorkDir,
    claudeSessionId: claudeSessionId,  // 保存要恢复的 session ID
    createdAt: Date.now(),
    abortController: null,
    tools: [],
    slashCommands: [],
    model: null,
    userId,
    username,
    disallowedTools: disallowedTools || null,  // null = 使用全局默认
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      totalCostUsd: 0
    }
  });

  ctx.sendToServer({
    type: 'conversation_resumed',
    conversationId,
    claudeSessionId,
    workDir: effectiveWorkDir,
    historyMessages,
    userId,
    username
  });

  // 立即发送 agent 级别的 MCP servers 列表
  if (ctx.mcpServers.length > 0) {
    const effectiveDisallowed = disallowedTools || ctx.CONFIG.disallowedTools || [];
    const serversWithState = ctx.mcpServers.map(s => ({
      name: s.name,
      enabled: !effectiveDisallowed.some(d => d === `mcp__${s.name}` || d.startsWith(`mcp__${s.name}__`)),
      source: s.source
    }));
    ctx.sendToServer({
      type: 'conversation_mcp_update',
      conversationId,
      servers: serversWithState
    });
  }

  sendConversationList();

  // ★ Prestart Claude CLI in background to eagerly fetch skills/tools/model
  // Skip if conversation already has an active query (shouldn't happen, but safety check)
  const resumeState = ctx.conversations.get(conversationId);
  if (!resumeState?.query) {
    prestartClaude(conversationId, effectiveWorkDir, claudeSessionId);
  }
}

// 删除 conversation
export function deleteConversation(msg) {
  const { conversationId } = msg;

  console.log(`Deleting conversation: ${conversationId}`);

  // 清理关联的所有终端（一个 conversation 可能有多个分屏终端）
  for (const [terminalId, term] of ctx.terminals.entries()) {
    if (term.conversationId === conversationId || terminalId === conversationId) {
      if (term.pty) {
        try { term.pty.kill(); } catch {}
      }
      if (term.timer) clearTimeout(term.timer);
      ctx.terminals.delete(terminalId);
    }
  }

  const conv = ctx.conversations.get(conversationId);
  if (conv) {
    if (conv.abortController) {
      conv.abortController.abort();
    }
    if (conv.inputStream) {
      conv.inputStream.done();
    }
    ctx.conversations.delete(conversationId);
  }

  ctx.sendToServer({
    type: 'conversation_deleted',
    conversationId
  });

  sendConversationList();
}

// 刷新会话状态 - 发送当前会话的处理状态
/**
 * Handle ping_session — report session real status back to client.
 * Allows the frontend to distinguish: agent-offline, session-lost, cli-exited, ok.
 */
export function handlePingSession(msg) {
  const { conversationId } = msg;
  const conv = ctx.conversations.get(conversationId);

  if (!conv) {
    ctx.sendToServer({
      type: 'pong_session',
      conversationId,
      clientId: msg.clientId,
      status: 'session-lost'
    });
    return;
  }

  // CLI process exited (no active query)
  if (!conv.query) {
    ctx.sendToServer({
      type: 'pong_session',
      conversationId,
      clientId: msg.clientId,
      status: 'cli-exited'
    });
    return;
  }

  ctx.sendToServer({
    type: 'pong_session',
    conversationId,
    clientId: msg.clientId,
    status: 'ok',
    isProcessing: !!conv.turnActive,
    currentTool: conv.currentTool || null
  });
}

export async function handleRefreshConversation(msg) {
  const { conversationId } = msg;
  const conv = ctx.conversations.get(conversationId);

  if (!conv) {
    ctx.sendToServer({
      type: 'conversation_refresh',
      conversationId,
      error: 'Conversation not found'
    });
    return;
  }

  // 检查是否有 turn 正在处理（不是 query 是否存在，因为持久模式下 query 一直存在）
  const isRunning = !!conv.turnActive;

  ctx.sendToServer({
    type: 'conversation_refresh',
    conversationId,
    isProcessing: isRunning,
    workDir: conv.workDir,
    claudeSessionId: conv.claudeSessionId
  });
}

// 取消当前执行
export async function handleCancelExecution(msg) {
  const { conversationId } = msg;

  console.log(`[${conversationId}] Cancelling execution`);

  const state = ctx.conversations.get(conversationId);
  if (!state) {
    console.log(`[${conversationId}] No active conversation found`);
    ctx.sendToServer({
      type: 'execution_cancelled',
      conversationId
    });
    return;
  }

  // 保存当前会话 ID，以便后续可以恢复
  const claudeSessionId = state.claudeSessionId;
  const workDir = state.workDir;

  // 标记为取消状态，防止 processClaudeOutput 的 finally 发送 conversation_closed
  state.cancelled = true;

  // 中止当前查询
  if (state.abortController) {
    state.abortController.abort();
  }

  // 关闭输入流
  if (state.inputStream) {
    state.inputStream.done();
  }

  // 清理当前查询状态，但保留会话信息
  state.query = null;
  state.inputStream = null;
  state.abortController = null;
  state.turnActive = false;

  console.log(`[${conversationId}] Execution cancelled, session: ${claudeSessionId}`);

  // 通知客户端取消完成
  ctx.sendToServer({
    type: 'execution_cancelled',
    conversationId,
    claudeSessionId
  });

  sendConversationList();
}

// 清空排队消息 — 已移至 server 端管理 (Phase 3.6)
// handleClearQueue 和 handleCancelQueuedMessage 不再需要

// 处理用户输入
export async function handleUserInput(msg) {
  const { conversationId, prompt, workDir, claudeSessionId } = msg;

  // 解析斜杠命令
  const slashCommand = parseSlashCommand(prompt);

  // 处理不支持的斜杠命令
  if (slashCommand.type === 'unsupported') {
    console.log(`[${conversationId}] Unsupported slash command: ${slashCommand.command}`);

    sendOutput(conversationId, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `命令 \`${slashCommand.command}\` 在远程模式下不可用（需要交互式终端）。\n\n` +
            `**支持的命令：**\n` +
            `- \`/clear\` - 清除当前会话上下文\n` +
            `- \`/compact\` - 压缩会话上下文\n` +
            `- \`/context\` - 显示上下文使用情况\n` +
            `- \`/cost\` - 显示花费信息\n` +
            `- \`/init\` - 初始化项目 CLAUDE.md\n` +
            `- \`/doctor\` - 运行诊断检查\n` +
            `- \`/memory\` - 管理记忆\n` +
            `- \`/model\` - 查看/切换模型\n` +
            `- \`/review\` - 代码审查\n` +
            `- \`/mcp\` - MCP 服务器管理\n` +
            `- \`/<skill-name>\` - 自定义技能（如 /commit, /pr 等）`
        }]
      }
    });
    // 通知前端清除 processing 状态（因为不会启动 Claude 查询，没有 result 消息）
    const existingState = ctx.conversations.get(conversationId);
    ctx.sendToServer({
      type: 'turn_completed',
      conversationId,
      claudeSessionId: existingState?.claudeSessionId,
      workDir: existingState?.workDir || ctx.CONFIG.workDir
    });
    return;
  }

  let state = ctx.conversations.get(conversationId);

  // 如果没有活跃的查询，启动新的
  if (!state || !state.query || !state.inputStream) {
    const resumeSessionId = claudeSessionId || state?.claudeSessionId || null;
    const effectiveWorkDir = workDir || state?.workDir || ctx.CONFIG.workDir;

    console.log(`[SDK] Starting Claude for ${conversationId}, resume: ${resumeSessionId || 'none'}`);
    state = await startClaudeQuery(conversationId, effectiveWorkDir, resumeSessionId);
  }

  // 发送用户消息到输入流
  // Claude stream-json 模式支持在回复过程中接收新消息（写入 stdin）
  let effectivePrompt = prompt;

  // ★ Expert Panel: construct expert message if selections provided
  const expertSelections = msg.expertSelections;
  if (expertSelections?.length > 0) {
    const { buildExpertMessage } = await import('./expert-roles.js');
    const expertResult = buildExpertMessage(expertSelections, effectivePrompt, msg.language || 'zh-CN');
    effectivePrompt = expertResult.effectivePrompt;
  }

  // ★ Save displayPrompt before any modification (preserves original user input)
  const displayPrompt = prompt;

  // ★ Separate display message (shown to user) from Claude message (sent to model)
  // displayPrompt: user's original text (no modifications)
  const userMessage = {
    type: 'user',
    message: { role: 'user', content: effectivePrompt }
  };
  const displayMessage = {
    type: 'user',
    message: { role: 'user', content: displayPrompt }
  };

  console.log(`[${conversationId}] Sending: ${prompt.substring(0, 100)}...`);

  // DISABLED (2026-03): Opus 4.6 has 200k context. Claude Code handles its own compaction.
  // Keeping code for reference; re-enable if we ever need custom pre-send compact.
  // ★ Pre-send compact check: estimate total tokens and compact before sending if needed
  // const autoCompactThreshold = state.autoCompactThreshold || ctx.CONFIG?.autoCompactThreshold || 110000;
  // const lastInputTokens = state.lastResultInputTokens || 0;
  // const lastOutputTokens = state.lastResultOutputTokens || 0;
  // const estimatedNewTokens = Math.ceil(effectivePrompt.length / 3); // conservative: ~3 chars per token
  // // Include output_tokens: the assistant's last output becomes part of context for the next turn
  // const estimatedTotal = lastInputTokens + lastOutputTokens + estimatedNewTokens;
  //
  // if (estimatedTotal > autoCompactThreshold && state.inputStream) {
  //   console.log(`[${conversationId}] Pre-send compact: estimated ${estimatedTotal} tokens (input: ${lastInputTokens} + output: ${lastOutputTokens} + new: ~${estimatedNewTokens}) exceeds threshold ${autoCompactThreshold}`);
  //   ctx.sendToServer({
  //     type: 'compact_status',
  //     conversationId,
  //     status: 'compacting',
  //     message: `Auto-compacting before send: estimated ${estimatedTotal} tokens (threshold: ${autoCompactThreshold})`
  //   });
  //   // Send /compact first, then the user message will be sent after compact completes
  //   // by storing it as a pending message
  //   state._pendingUserMessage = userMessage;
  //   state._pendingDisplayMessage = displayMessage;
  //   state.turnActive = true;
  //   state.turnResultReceived = false;
  //   sendConversationList();
  //   state.inputStream.enqueue({
  //     type: 'user',
  //     message: { role: 'user', content: '/compact' }
  //   });
  //   return;
  // }

  state.turnActive = true;
  state.turnResultReceived = false; // 重置 per-turn 去重标志
  state._lastUserMessage = userMessage; // Save for prompt-overflow retry
  sendConversationList(); // 在 turnActive=true 后通知 server，确保 processing 状态正确
  sendOutput(conversationId, displayMessage);
  state.inputStream.enqueue(userMessage);
}

// 更新会话设置（如 disallowedTools）
export function handleUpdateConversationSettings(msg) {
  const { conversationId } = msg;
  const conv = ctx.conversations.get(conversationId);
  if (!conv) {
    console.log(`[Settings] Conversation not found: ${conversationId}`);
    return;
  }

  if (msg.disallowedTools !== undefined) {
    conv.disallowedTools = msg.disallowedTools;
    console.log(`[Settings] ${conversationId} disallowedTools updated:`, msg.disallowedTools);
  }

  ctx.sendToServer({
    type: 'conversation_settings_updated',
    conversationId,
    disallowedTools: conv.disallowedTools,
    needRestart: !!conv.query  // Claude 进程已启动则需要重启才能生效
  });
}

// AskUserQuestion 交互式问答

/**
 * 处理 AskUserQuestion 工具调用 — 转发到 Web UI 等待用户回答
 */
export function handleAskUserQuestion(conversationId, input, toolCtx) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    console.log(`[AskUser] ${conversationId} requesting user input, requestId: ${requestId}`);

    // 发送到 Web UI
    ctx.sendToServer({
      type: 'ask_user_question',
      conversationId,
      requestId,
      questions: input.questions || []
    });

    ctx.pendingUserQuestions.set(requestId, {
      resolve,
      conversationId,
      input
    });

    // 监听 abort signal
    if (toolCtx?.signal) {
      toolCtx.signal.addEventListener('abort', () => {
        ctx.pendingUserQuestions.delete(requestId);
        reject(new Error('aborted'));
      });
    }
  });
}

/**
 * 处理 Web UI 的 AskUserQuestion 回答
 */
export function handleAskUserAnswer(msg) {
  const pending = ctx.pendingUserQuestions.get(msg.requestId);
  if (pending) {
    console.log(`[AskUser] Received answer for ${msg.requestId}`);
    ctx.pendingUserQuestions.delete(msg.requestId);
    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        questions: pending.input.questions,
        answers: msg.answers || {}
      }
    });
  } else {
    console.log(`[AskUser] No pending question for requestId: ${msg.requestId}`);
  }
}

/**
 * Handle /btw side question — supports multi-turn and Crew mode.
 *
 * Multi-turn: First question forks the session (forkSession: true).
 * Subsequent questions resume the forked session (no fork).
 * The forked session ID is captured from system init and returned in btw_done.
 *
 * Crew mode: If conversationId is a crew session, use the decision maker's
 * claudeSessionId as the base for forking.
 */
export async function handleBtwQuestion(msg) {
  const { conversationId, question, btwSessionId } = msg;

  // 1. Find the base session — Chat or Crew decision maker
  let baseSessionId = null;
  let workDir = null;

  const chatState = ctx.conversations.get(conversationId);
  if (chatState?.claudeSessionId) {
    baseSessionId = chatState.claudeSessionId;
    workDir = chatState.workDir;
  } else {
    // Crew mode: find decision maker's session
    const crewSession = crewSessions.get(conversationId);
    if (crewSession) {
      const dmName = crewSession.decisionMaker;
      const dmState = dmName ? crewSession.roleStates.get(dmName) : null;
      if (dmState?.claudeSessionId) {
        baseSessionId = dmState.claudeSessionId;
        workDir = crewSession.projectDir;
      }
    }
  }

  if (!baseSessionId) {
    ctx.sendToServer({ type: 'btw_error', conversationId, error: 'No active session' });
    return;
  }

  // 2. Determine resume target: multi-turn reuses btwSessionId, first question forks
  const resumeTarget = btwSessionId || baseSessionId;
  const shouldFork = !btwSessionId;

  console.log(`[btw] ${conversationId} question: ${question.substring(0, 80)} (fork: ${shouldFork}, session: ${resumeTarget.substring(0, 20)}...)`);

  let newBtwSessionId = btwSessionId; // default: keep existing

  try {
    const btwQuery = query({
      prompt: question,
      options: {
        cwd: workDir || ctx.CONFIG.workDir,
        resume: resumeTarget,
        forkSession: shouldFork,
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        disallowedTools: [
          'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
          'Agent', 'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
          'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
          'CronCreate', 'CronDelete', 'CronList', 'TaskOutput', 'TaskStop',
          'AskUserQuestion', 'Skill'
        ]
      }
    });

    for await (const message of btwQuery) {
      // Capture forked session ID from system init
      if (message.type === 'system' && message.session_id) {
        newBtwSessionId = message.session_id;
      }

      if (message.type === 'assistant') {
        const content = message.message?.content;
        let delta = '';
        if (typeof content === 'string') {
          delta = content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') delta += block.text;
          }
        }
        if (delta) {
          ctx.sendToServer({ type: 'btw_stream', conversationId, delta });
        }
      }
    }

    ctx.sendToServer({
      type: 'btw_done',
      conversationId,
      btwSessionId: newBtwSessionId
    });
  } catch (err) {
    console.error(`[btw] ${conversationId} error:`, err.message);
    ctx.sendToServer({ type: 'btw_error', conversationId, error: err.message });
  }
}
