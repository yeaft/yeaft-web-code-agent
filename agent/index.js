import { assertNodeVersion } from './check-node-version.js';
assertNodeVersion({ component: '@yeaft/webchat-agent' });

import 'dotenv/config';
import { platform, homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, chmodSync, readdirSync } from 'fs';
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

// task-fix (5-bugs): the Unify web-bridge reads `ctx.CONFIG.yeaftDir`
// for every group / VP / memory operation. If unset, `path.join(undefined, …)`
// throws `The "path" argument must be of type string. Received undefined`
// and the UI surfaces "群组操作失败: …" with a raw node error. Resolve the
// default (`~/.yeaft`) here and make sure the directory exists before the
// WebSocket connection goes live, so downstream code can assume a real path.
const YEAFT_DIR = process.env.YEAFT_DIR || fileConfig.yeaftDir || join(homedir(), '.yeaft');
try {
  if (!existsSync(YEAFT_DIR)) {
    mkdirSync(YEAFT_DIR, { recursive: true });
    console.log(`[Agent] Created yeaft dir: ${YEAFT_DIR}`);
  }
} catch (err) {
  console.warn(`[Agent] Could not ensure yeaft dir ${YEAFT_DIR}: ${err?.message || err}`);
}

const CONFIG = {
  serverUrl: process.env.SERVER_URL || fileConfig.serverUrl,
  agentName: process.env.AGENT_NAME || fileConfig.agentName,
  workDir: process.env.WORK_DIR || fileConfig.workDir || process.cwd(),
  yeaftDir: YEAFT_DIR,
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
  const capabilities = ['background_tasks', 'file_editor', 'ping_session'];
  const pty = await loadNodePty();
  if (pty) capabilities.push('terminal');

  // Crew mode requires Claude CLI
  try {
    const { getDefaultClaudeCodePath } = await import('./sdk/utils.js');
    const claudePath = getDefaultClaudeCodePath();
    if (claudePath) capabilities.push('crew');
  } catch {}

  console.log(`[Capabilities] Detected: ${capabilities.join(', ')}`);
  return capabilities;
}

// 确保依赖已安装。node-pty 已被 @homebridge/node-pty-prebuilt-multiarch
// 取代（regular dep + 全平台预编译），不再需要 optionalDependency 的特判。
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
  }
}

// 确保 yeaft-skills 插件已安装到 Claude CLI plugin 系统并注册为 marketplace
async function ensureYeaftSkills() {
  const MARKETPLACE_NAME = 'yeaft-skills-dev';
  const PLUGIN_NAME = 'yeaft-skills';
  const PLUGIN_KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
  const PLUGIN_VERSION = '0.1.0';
  const REPO_URL = 'https://github.com/yeaft/yeaft-skills.git';
  const claudeDir = join(homedir(), '.claude');
  const pluginsDir = join(claudeDir, 'plugins');
  const marketplacesDir = join(pluginsDir, 'marketplaces');
  const installDir = join(marketplacesDir, MARKETPLACE_NAME);
  const knownFile = join(pluginsDir, 'known_marketplaces.json');
  const installedFile = join(pluginsDir, 'installed_plugins.json');
  const settingsFile = join(claudeDir, 'settings.json');
  const cacheDir = join(pluginsDir, 'cache', MARKETPLACE_NAME, PLUGIN_NAME, PLUGIN_VERSION);

  try {
    // --- Layer 1: Clone or update the marketplace repo ---
    let gitSha = '';
    let needsCacheUpdate = false;
    if (!existsSync(installDir)) {
      console.log('[Startup] yeaft-skills not found, installing as marketplace plugin...');
      mkdirSync(marketplacesDir, { recursive: true });
      await execAsync(`git clone ${REPO_URL} "${installDir}"`, { timeout: 60000 });
      needsCacheUpdate = true;
      console.log('[Startup] yeaft-skills installed');
    } else {
      console.log('[Startup] yeaft-skills found, checking for updates...');
      // Record HEAD before pull to detect changes
      let headBefore = '';
      try {
        const { stdout: h } = await execAsync('git rev-parse HEAD', { cwd: installDir, timeout: 5000 });
        headBefore = h.trim();
      } catch { /* ignore */ }
      const { stdout } = await execAsync('git pull --ff-only', {
        cwd: installDir,
        timeout: 30000
      });
      if (stdout.includes('Already up to date')) {
        console.log('[Startup] yeaft-skills is up to date');
      } else {
        needsCacheUpdate = true;
        console.log('[Startup] yeaft-skills updated');
      }
      // Double-check: compare HEAD after pull
      if (!needsCacheUpdate && headBefore) {
        try {
          const { stdout: h2 } = await execAsync('git rev-parse HEAD', { cwd: installDir, timeout: 5000 });
          if (h2.trim() !== headBefore) needsCacheUpdate = true;
        } catch { /* ignore */ }
      }
    }
    // Get current commit SHA for installed_plugins.json
    try {
      const { stdout: sha } = await execAsync('git rev-parse HEAD', { cwd: installDir, timeout: 5000 });
      gitSha = sha.trim();
    } catch { /* non-critical */ }

    // --- Layer 2: Register in known_marketplaces.json (idempotent) ---
    let known = {};
    if (existsSync(knownFile)) {
      try {
        known = JSON.parse(readFileSync(knownFile, 'utf-8'));
      } catch { /* corrupted file, will recreate */ }
    }
    if (!known[MARKETPLACE_NAME]) {
      known[MARKETPLACE_NAME] = {
        source: { source: 'github', repo: 'yeaft/yeaft-skills' },
        installLocation: installDir,
        lastUpdated: new Date().toISOString()
      };
      writeFileSync(knownFile, JSON.stringify(known, null, 2));
      console.log('[Startup] yeaft-skills registered in known_marketplaces.json');
    } else {
      known[MARKETPLACE_NAME].lastUpdated = new Date().toISOString();
      known[MARKETPLACE_NAME].installLocation = installDir;
      writeFileSync(knownFile, JSON.stringify(known, null, 2));
    }

    // --- Layer 2.5: Ensure hook scripts are executable (git clone may lose +x on some OS) ---
    const fixHookPermissions = (dir) => {
      const hooksDir = join(dir, 'hooks');
      if (existsSync(hooksDir)) {
        for (const f of readdirSync(hooksDir)) {
          try { chmodSync(join(hooksDir, f), 0o755); } catch { /* ignore */ }
        }
      }
    };
    fixHookPermissions(installDir);

    // --- Layer 3: Copy to plugin cache (on first install or after update) ---
    if (!existsSync(cacheDir) || needsCacheUpdate) {
      mkdirSync(cacheDir, { recursive: true });
      cpSync(installDir, cacheDir, { recursive: true });
      fixHookPermissions(cacheDir);
      console.log(`[Startup] yeaft-skills ${needsCacheUpdate ? 'updated in' : 'copied to'} plugin cache`);
    }

    // --- Layer 4: Register in installed_plugins.json ---
    let installed = { version: 2, plugins: {} };
    if (existsSync(installedFile)) {
      try {
        installed = JSON.parse(readFileSync(installedFile, 'utf-8'));
      } catch { /* corrupted, will recreate */ }
    }
    if (!installed.plugins) installed.plugins = {};
    if (!installed.plugins[PLUGIN_KEY]) {
      const now = new Date().toISOString();
      installed.plugins[PLUGIN_KEY] = [{
        scope: 'user',
        installPath: cacheDir,
        version: PLUGIN_VERSION,
        installedAt: now,
        lastUpdated: now,
        ...(gitSha ? { gitCommitSha: gitSha } : {})
      }];
      writeFileSync(installedFile, JSON.stringify(installed, null, 2));
      console.log('[Startup] yeaft-skills registered in installed_plugins.json');
    }

    // --- Layer 5: Enable in settings.json ---
    // Read existing settings; on parse failure skip to avoid losing user config
    let settings = null;
    if (existsSync(settingsFile)) {
      try {
        settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      } catch {
        console.warn('[Startup] settings.json corrupted, skipping enabledPlugins write');
      }
    } else {
      settings = {};
    }
    if (settings !== null) {
      if (!settings.enabledPlugins) settings.enabledPlugins = {};
      if (!settings.enabledPlugins[PLUGIN_KEY]) {
        settings.enabledPlugins[PLUGIN_KEY] = true;
        writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
        console.log('[Startup] yeaft-skills enabled in settings.json');
      }
    }
  } catch (e) {
    console.warn('[Startup] yeaft-skills sync failed (skills will be unavailable):', e.message);
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
  await ensureYeaftSkills();
  ctx.agentCapabilities = await detectCapabilities();
  connect();
})();
