import 'dotenv/config';
import { platform, homedir } from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import ctx from './context.js';
import { getConfigPath, loadServiceConfig } from './service.js';
import { loadNodePty } from './terminal.js';
import { connect } from './connection.js';
import { loadMcpServers } from './mcp.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load package version
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
ctx.agentVersion = pkg.version;
ctx.pkgName = pkg.name;

// 配置文件路径（向后兼容：先查当前目录 .claude-agent.json）
const LOCAL_CONFIG_FILE = join(process.cwd(), '.claude-agent.json');

// 加载或创建配置
function loadConfig() {
  const defaults = {
    serverUrl: 'ws://localhost:3456',
    agentName: `Worker-${platform()}-${process.pid}`,
    workDir: process.cwd(),
    reconnectInterval: 5000,
    agentSecret: 'agent-shared-secret'
  };

  // Priority 1: Local .claude-agent.json (backward compat)
  if (existsSync(LOCAL_CONFIG_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(LOCAL_CONFIG_FILE, 'utf-8'));
      const { agentId, ...rest } = saved;
      return { ...defaults, ...rest };
    } catch {
      // fall through
    }
  }

  // Priority 2: Standard config location (~/.config/yeaft-agent/config.json)
  const serviceConfig = loadServiceConfig();
  if (serviceConfig) {
    return { ...defaults, ...serviceConfig };
  }

  return defaults;
}

function saveConfig(config) {
  writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(config, null, 2));
}

const fileConfig = loadConfig();
const CONFIG = {
  serverUrl: process.env.SERVER_URL || fileConfig.serverUrl,
  agentName: process.env.AGENT_NAME || fileConfig.agentName,
  workDir: process.env.WORK_DIR || fileConfig.workDir || process.cwd(),
  reconnectInterval: fileConfig.reconnectInterval,
  agentSecret: process.env.AGENT_SECRET || fileConfig.agentSecret,
  // 显式禁用的工具（非 MCP 相关）
  explicitDisallowedTools: (() => {
    const raw = process.env.DISALLOWED_TOOLS || fileConfig.disallowedTools || '';
    return raw === 'none' ? [] : raw.split(',').map(s => s.trim()).filter(Boolean);
  })(),
  // MCP 白名单初始值（环境变量或配置文件指定）
  allowedMcpServers: (() => {
    const raw = process.env.ALLOWED_MCP_SERVERS || fileConfig.allowedMcpServers || 'playwright';
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  })(),
  // disallowedTools 会在 loadMcpServers() 中计算
  disallowedTools: [],
  // 最大上下文 tokens（用于百分比计算的分母）
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || fileConfig.maxContextTokens, 10) || 128000,
  // Auto-compact 阈值（tokens）：context 超过此值时自动触发 compact
  autoCompactThreshold: parseInt(process.env.AUTO_COMPACT_THRESHOLD || fileConfig.autoCompactThreshold, 10) || 110000
};

// 初始化共享上下文
ctx.CONFIG = CONFIG;
ctx.saveConfig = saveConfig;

// 初始加载 MCP servers（必须在 ctx.CONFIG 赋值之后）
loadMcpServers();

// Agent capabilities（启动时自动检测）
async function detectCapabilities() {
  const capabilities = ['background_tasks', 'file_editor'];
  const pty = await loadNodePty();
  if (pty) capabilities.push('terminal');

  // Crew mode requires Claude CLI
  try {
    const { getDefaultClaudeCodePath } = await import('./sdk/utils.js');
    const claudePath = getDefaultClaudeCodePath();
    if (claudePath) capabilities.push('crew');
    // Conductor V2 reuses the same Claude CLI
    if (claudePath) capabilities.push('conductor');
  } catch {}

  console.log(`[Capabilities] Detected: ${capabilities.join(', ')}`);
  return capabilities;
}

// 确保依赖已安装（特别是 optionalDependencies 如 node-pty）
async function ensureDependencies() {
  const agentDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const nodeModulesPath = join(agentDir, 'node_modules');

  // 检查 node_modules 是否存在
  if (!existsSync(nodeModulesPath)) {
    console.log('[Startup] node_modules not found, running npm install...');
    try {
      await execAsync('npm install', { cwd: agentDir, timeout: 120000 });
      console.log('[Startup] npm install completed');
    } catch (e) {
      console.warn('[Startup] npm install failed:', e.message);
    }
    return;
  }

  // 检查 node-pty 是否可用（optionalDependency，可能需要编译）
  try {
    await import('node-pty');
  } catch (e) {
    console.log('[Startup] node-pty not available, attempting install...');
    try {
      await execAsync('npm install node-pty', { cwd: agentDir, timeout: 120000 });
      console.log('[Startup] node-pty installed successfully');
    } catch (installErr) {
      console.warn('[Startup] node-pty install failed (terminal will be unavailable):', installErr.message);
    }
  }
}

// 优雅退出
function cleanup() {
  // 清理所有终端
  for (const [, term] of ctx.terminals) {
    if (term.pty) {
      try { term.pty.kill(); } catch {}
    }
    if (term.timer) clearTimeout(term.timer);
  }
  ctx.terminals.clear();

  for (const [, state] of ctx.conversations) {
    if (state.abortController) {
      state.abortController.abort();
    }
    if (state.inputStream) {
      state.inputStream.done();
    }
  }
  ctx.conversations.clear();
  if (ctx.ws) ctx.ws.close();
}

process.on('SIGINT', () => {
  console.log('Shutting down...');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  cleanup();
  process.exit(0);
});

// 启动 - 先确保依赖，再检测能力，再连接
(async () => {
  await ensureDependencies();
  ctx.agentCapabilities = await detectCapabilities();
  connect();
})();
