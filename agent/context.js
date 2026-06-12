// 共享上下文对象 - 所有模块通过 import 访问
// 由 index.js 在启动时初始化

export default {
  ws: null,
  sessionKey: null,
  conversations: new Map(),
  terminals: new Map(),
  proxyPorts: [],
  proxyWsSockets: new Map(),
  pendingUserQuestions: new Map(),
  nodePty: null,
  CONFIG: null,
  agentCapabilities: [],
  // Agent 级别的 slash commands 缓存（所有 conversation 共用）
  slashCommands: [],
  // Slash command 描述映射: { commandName: description } — 从 plugin commands/*.md 提取
  slashCommandDescriptions: {},
  // MCP servers 列表 (从 ~/.claude.json 读取): [{ name, enabled, source }]
  mcpServers: [],
  // 连接相关
  reconnectTimer: null,
  pendingAuthTempId: null,
  agentHeartbeatTimer: null,
  lastPongAt: 0,
  // 断连期间的消息缓冲队列（重连后 flush）
  messageBuffer: [],
  messageBufferMaxSize: 5000, // 防止内存无限增长
  // 由 connection.js 注册的通信函数
  sendToServer: null,
  // 由 index.js 注册的配置保存函数
  saveConfig: null,
  // task-318: live Yeaft runtime caps. Mutated in-place by
  // `update_yeaft_settings` so in-process consumers (web-bridge) can
  // pick up the new values without a session restart. `null` until the
  // Yeaft session has finished loading.
  yeaftRuntimeSettings: null,
};
