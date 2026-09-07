import { COLLAB_TOOL_POLICY } from './registry.js';

/**
 * Built-ins whose schemas stay visible on every provider request. Registration
 * remains broader than exposure so legacy aliases and conditional tools can
 * still be resolved without paying their schema cost on unrelated turns.
 */
export const ALWAYS_VISIBLE_TOOL_NAMES = Object.freeze([
  'Skill',
  'EnterWorktree',
  'ExitWorktree',
  'AskUser',
  'DiscoverTools',
  'WebSearch',
  'WebFetch',
  'Bash',
  'FileRead',
  'FileWrite',
  'FileEdit',
  'Glob',
  'Grep',
  'ListDir',
  'TodoWrite',
  'ViewImage',
]);

export const BACKGROUND_TASK_TOOL_NAMES = Object.freeze([
  'ListTasks',
  'ReadTaskLog',
  'CancelTask',
]);

export const SUB_AGENT_MANAGEMENT_TOOL_NAMES = Object.freeze([
  'PromptAgent',
  'WaitAgent',
  'CloseAgent',
  'ListAgents',
]);

export const CONDITIONAL_BUILTIN_TOOL_NAMES = new Set([
  'HistorySearch',
  'DiskUsage',
  'ApplyPatch',
  'ListTasks',
  'ReadTaskLog',
  'CancelTask',
  'SpawnAgent',
  'PromptAgent',
  'WaitAgent',
  'CloseAgent',
  'ListAgents',
  'RouteForward',
  'CreateWorkItem',
  // Legacy compatibility only. New planning is a single provider response:
  // visible prose + TodoWrite + the first justified work-tool call. Keeping the
  // definition registered lets old direct callers resolve it without paying a
  // dedicated StartPlan -> provider -> TodoWrite round trip on every new task.
  'StartPlan',
  'JsRepl',
  'NotebookEdit',
  'ImageGeneration',
  'RepoWorkflow',
]);

const HISTORY_INTENT_RE = /(?:\bhistory\b|\b(?:prior|previous) (?:chat|conversation|discussion)\b|\bprevious(?:ly)? discussed\b|\bwhat did we (?:decide|discuss|say|agree)\b|\b(?:our|the) (?:earlier|last) decision\b|历史|之前(?:的)?(?:对话|讨论|会话|决定)|过去(?:的)?会话|我们(?:之前|上次)(?:决定|讨论|说)了什么)/iu;
const DISK_INTENT_RE = /(?:\bdisk (?:usage|space|full)\b|\bstorage (?:usage|space|full)\b|\blargest director|\benospc\b|\bno space left on device\b|磁盘(?:占用|空间|已满)|存储空间|目录占用|空间不足)/iu;
const PATCH_INTENT_RE = /(?:\bapply (?:a )?patch\b|\bunified diff\b|\bpatch file\b|应用补丁|统一 diff|补丁文件)/iu;
const TASK_INTENT_RE = /(?:\bbackground (?:task|job|command|process)\b|\btask[_-][a-z0-9]+\b|\btask log\b|后台(?:任务|命令|进程)|任务日志)/iu;
const SUB_AGENT_INTENT_RE = /(?:\bsub[ -]?agent\b|\bagent(?:s)?\b|\bparallel(?:ize| work| task| review)?\b|\bindependent(?:ly| review)?\b|\banother (?:worker|reviewer|agent)\b|\bdelegate\b|\b(?:run|start|launch|spawn) (?:the |a )?(?:task|child)\b|子 ?Agent|并行(?:处理|工作|任务|审查)?|独立(?:处理|审查)?|另一个(?:人|助手|Agent)|委派)/iu;
const WORK_ITEM_INTENT_RE = /(?:\bwork ?center\b|\bwork ?item\b|\bdurable tracking\b|\bcross[- ]turn\b|\blong[- ]running goal\b|\bacross multiple (?:turns|sessions)\b|\buntil (?:it is|it's) finished\b|工作中心|工作项|持久(?:任务|跟踪)|跨 ?turn|跨多个会话|长期任务|持续跟踪)/iu;
const REPL_INTENT_RE = /(?:\bjs ?repl\b|\bjavascript (?:calculation|experiment|evaluation)\b|\bcalculate\b|\bdata transform\b|JavaScript (?:计算|实验|求值)|数据转换|快速计算)/iu;
const NOTEBOOK_INTENT_RE = /(?:\.ipynb\b|\bjupyter\b|\bnotebook (?:cell|file)\b|Jupyter|笔记本单元格)/iu;
const IMAGE_GENERATION_INTENT_RE = /(?:\b(?:generate|make|design|draw) (?:me |us )?(?:an? |the )?(?:image|picture|logo|icon|illustration|graphic)\b|\bcreate (?:me |us )?(?:an? |the )?(?:illustration|image|picture|logo|icon|graphic)\b|生成(?:一张)?(?:图片|图像|标志|图标|插图)|创建(?:一张)?(?:插图|图片|图像|标志|图标)|画(?:一张)?(?:图|图片|图标))/iu;
const REPO_WORKFLOW_INTENT_RE = /(?:\b(?:git |github )?(?:worktree|pull request|pr) (?:workflow|review|merge|landing|prepare)\b|\b(?:review|merge|land|prepare) (?:a |the )?(?:github )?(?:pull request|pr)\b|\bhead[- ]match(?:ed)? merge\b|\bmerge (?:and|\+) tag\b|\breview[- ]prep\b|\bye?aft-repo\b|仓库(?:工作流|流程)|准备(?:开发|审查|review) worktree|(?:审查|评审|合并|准备) ?(?:github )?(?:pr|pull request|拉取请求)|合并(?:并|和)?打 tag|精确 head 合并)/iu;
const MCP_INTENT_RE = /(?:\bmcp\b|model context protocol|模型上下文协议)/iu;

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

/**
 * Build a bounded intent window from the current request and recent context.
 * A short "continue" / "yes" turn can therefore retain a conditional tool
 * selected by the immediately preceding discussion without making every old
 * topic permanently activate tools.
 */
export function buildToolIntentText(prompt, messages = []) {
  const recent = Array.isArray(messages) ? messages.slice(-6) : [];
  const pieces = [...recent.map(messageText), typeof prompt === 'string' ? prompt : '']
    .filter(Boolean);
  return pieces.join('\n').slice(-12_000);
}

function matchedMcpTools(intentText, toolNames) {
  const mcpTools = toolNames.filter(name => name.startsWith('mcp__'));
  const normalized = intentText.toLowerCase();
  const explicitMatches = mcpTools.filter(name => {
    if (normalized.includes(name.toLowerCase())) return true;
    const [, server = '', tool = ''] = name.split('__');
    if (tool && normalized.includes(tool.toLowerCase())) return true;
    return server && tool
      && normalized.includes(server.toLowerCase())
      && normalized.includes(tool.toLowerCase());
  });
  if (explicitMatches.length > 0) return explicitMatches;
  return MCP_INTENT_RE.test(intentText) ? mcpTools : [];
}

/**
 * Resolve the canonical tool names exposed to one provider request.
 *
 * Unknown caller-registered tools remain visible for compatibility. Only
 * Yeaft built-ins and flattened MCP tools participate in conditional hiding.
 *
 * @param {{
 *   toolNames: string[],
 *   prompt?: string,
 *   messages?: object[],
 *   collabToolPolicy?: string|null,
 *   activeTasks?: object[],
 *   subAgentToolsActivated?: boolean,
 *   imageGenerationConfigured?: boolean,
 * }} opts
 * @returns {Set<string>}
 */
export function resolveActiveToolNames({
  toolNames = [],
  prompt = '',
  messages = [],
  collabToolPolicy = null,
  activeTasks = [],
  subAgentToolsActivated = false,
  imageGenerationConfigured = false,
} = {}) {
  const registered = new Set(Array.isArray(toolNames) ? toolNames : []);
  const active = new Set(ALWAYS_VISIBLE_TOOL_NAMES.filter(name => registered.has(name)));
  const intentText = buildToolIntentText(prompt, messages);
  const tasks = Array.isArray(activeTasks) ? activeTasks : [];
  const hasActiveTasks = tasks.length > 0;
  const hasSubAgentTask = tasks.some(task => task?.kind === 'sub_agent');

  if (HISTORY_INTENT_RE.test(intentText)) active.add('HistorySearch');
  if (DISK_INTENT_RE.test(intentText)) active.add('DiskUsage');
  if (PATCH_INTENT_RE.test(intentText)) active.add('ApplyPatch');

  if (hasActiveTasks || TASK_INTENT_RE.test(intentText)) {
    for (const name of BACKGROUND_TASK_TOOL_NAMES) active.add(name);
  }

  if (SUB_AGENT_INTENT_RE.test(intentText) || subAgentToolsActivated || hasSubAgentTask) {
    active.add('SpawnAgent');
    for (const name of SUB_AGENT_MANAGEMENT_TOOL_NAMES) active.add(name);
  }

  if (collabToolPolicy === COLLAB_TOOL_POLICY.MULTI_VP) active.add('RouteForward');
  if (WORK_ITEM_INTENT_RE.test(intentText)) active.add('CreateWorkItem');
  if (REPL_INTENT_RE.test(intentText)) active.add('JsRepl');
  if (NOTEBOOK_INTENT_RE.test(intentText)) active.add('NotebookEdit');
  if (imageGenerationConfigured && IMAGE_GENERATION_INTENT_RE.test(intentText)) active.add('ImageGeneration');
  if (REPO_WORKFLOW_INTENT_RE.test(intentText)) active.add('RepoWorkflow');

  for (const name of matchedMcpTools(intentText, toolNames)) active.add(name);

  // Extra tools supplied by an embedding caller have no Yeaft activation
  // policy. Preserve the historical contract and expose them by default.
  for (const name of registered) {
    if (ALWAYS_VISIBLE_TOOL_NAMES.includes(name)) continue;
    if (CONDITIONAL_BUILTIN_TOOL_NAMES.has(name)) continue;
    if (name.startsWith('mcp__')) continue;
    active.add(name);
  }

  // Never advertise deprecated schema-only compatibility shims. Direct
  // registry execution without an active-set fence remains backward compatible.
  active.delete('JsReplReset');

  for (const name of [...active]) {
    if (!registered.has(name)) active.delete(name);
  }
  return active;
}
