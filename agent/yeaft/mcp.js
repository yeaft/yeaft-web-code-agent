/**
 * mcp.js — MCP (Model Context Protocol) client manager
 *
 * Manages connections to MCP servers and provides a bridge
 * for the mcp_list_tools and mcp_call_tool tools.
 *
 * MCP servers are configured in ~/.yeaft/config.md:
 *   ---
 *   mcp_servers:
 *     - name: github
 *       command: npx @mcp/github
 *       args: []
 *       env:
 *         GITHUB_TOKEN: ghp_...
 *     - name: slack
 *       command: npx @mcp/slack
 *       args: []
 *   ---
 *
 * Each MCP server communicates via stdio JSON-RPC (MCP protocol).
 *
 * Reference: yeaft-yeaft-design.md §8, yeaft-yeaft-core-systems.md §3.2
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

// ─── Constants ──────────────────────────────────────────────

/** Default tool call timeout (30 seconds). */
const DEFAULT_TIMEOUT_MS = 30000;

/** Server startup timeout (10 seconds). */
const STARTUP_TIMEOUT_MS = 10000;

/** Maximum time to drain stdout after process exit (e.g. an inherited pipe). */
const STDOUT_DRAIN_TIMEOUT_MS = 2000;

// ─── Process-level connection pool ────────────────────────────

/** @type {Map<string, { connection: MCPServerConnection, refs: number, startPromise: Promise<void> }>} */
const mcpConnectionPool = new Map();

function stableEnv(env = {}) {
  return Object.fromEntries(
    Object.entries(env || {})
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function mcpConnectionKey(config) {
  return JSON.stringify({
    name: config.name,
    command: config.command,
    args: Array.isArray(config.args) ? config.args : [],
    env: stableEnv(config.env),
    cwd: config.cwd || '',
  });
}

async function acquireMcpConnection(serverConfig) {
  const key = mcpConnectionKey(serverConfig);
  let entry = mcpConnectionPool.get(key);
  // A draining connection may still deliver replies but cannot accept a new lease.
  if (!entry || entry.connection.failure) {
    const connection = new MCPServerConnection(serverConfig.name, serverConfig);
    entry = {
      connection,
      refs: 0,
      startPromise: null,
    };
    connection.once('close', () => {
      if (mcpConnectionPool.get(key) === entry) {
        mcpConnectionPool.delete(key);
      }
    });
    mcpConnectionPool.set(key, entry);
    entry.startPromise = connection.start();
  }

  entry.refs += 1;
  try {
    await entry.startPromise;
    if (!entry.connection.ready) throw entry.connection.failure;
    return { key, connection: entry.connection };
  } catch (err) {
    entry.refs -= 1;
    if (entry.refs <= 0 && mcpConnectionPool.get(key) === entry) {
      mcpConnectionPool.delete(key);
    }
    throw err;
  }
}

async function releaseMcpConnection(key, connection) {
  const entry = mcpConnectionPool.get(key);
  if (!entry || entry.connection !== connection) {
    await connection.stop();
    return;
  }
  entry.refs -= 1;
  if (entry.refs > 0) return;
  mcpConnectionPool.delete(key);
  await connection.stop();
}

// ─── MCP Server Connection ─────────────────────────────────

/**
 * A single MCP server connection.
 * Communicates via stdio JSON-RPC.
 */
class MCPServerConnection extends EventEmitter {
  #name;
  #process;
  #pendingRequests;
  #tools;
  #ready;
  #failure = null;
  #exitError = null;
  #drainTimer;
  #disposal;
  #buffer;

  /**
   * @param {string} name — server name (e.g. "github")
   * @param {{ command: string, args?: string[], env?: object }} config
   */
  constructor(name, config) {
    super();
    this.#name = name;
    this.#process = null;
    this.#pendingRequests = new Map();
    this.#tools = [];
    this.#ready = false;
    this.#buffer = '';
    this.config = config;
  }

  get name() { return this.#name; }
  get tools() { return this.#tools; }
  get ready() { return this.#ready; }
  get failure() { return this.#failure ?? this.#exitError; }

  /**
   * Start the MCP server process and initialize.
   * @returns {Promise<void>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#retire(this.#process, new Error(`MCP server "${this.#name}" startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
      }, STARTUP_TIMEOUT_MS);
      const onClose = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.once('close', onClose);

      try {
        const child = this.#process = spawn(this.config.command, this.config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.config.env },
          cwd: this.config.cwd || undefined,
          windowsHide: true,
        });

        // Keep listening through disposal: a write callback and the stream's
        // 'error' event can report the same failure, even after retirement.
        const onError = (err) => this.#retire(child, err);
        child.on('error', onError);
        child.stdout.on('error', onError);
        child.stderr.on('error', onError);
        child.stdin.on('error', (err) => this.#onStdinFailure(child, err));
        child.stdin.once('close', () => {
          this.#onStdinFailure(child, new Error(`MCP server "${this.#name}" stdin closed`));
        });
        const exitError = (code, signal) => {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          return new Error(`MCP server "${this.#name}" closed with ${reason}`);
        };
        child.once('exit', (code, signal) => {
          if (this.#process !== child) return;
          // Exit can precede the last stdout data. Block writes, but preserve replies.
          this.#exitError = exitError(code, signal);
          this.#ready = false;
          clearTimeout(timer);
          this.#drainTimer = setTimeout(() => {
            this.#retire(child, this.#exitError);
          }, STDOUT_DRAIN_TIMEOUT_MS);
        });
        child.once('close', (code, signal) => {
          this.#retire(child, this.#exitError ?? exitError(code, signal), false);
        });
        const onStdoutClosed = () => {
          this.#retire(child, this.#exitError ?? new Error(`MCP server "${this.#name}" stdout closed`));
        };
        child.stdout.once('end', onStdoutClosed);
        child.stdout.once('close', onStdoutClosed);

        child.stdout.on('data', (data) => {
          if (this.#process !== child) return;
          this.#buffer += data.toString();
          this.#processBuffer();
        });

        child.stderr.on('data', (data) => {
          if (this.#process !== child) return;
          const text = data.toString().trim();
          if (!text) return;
          const err = new Error(`[${this.#name}] stderr: ${text}`);
          if (this.listenerCount('error') > 0) {
            this.emit('error', err);
          } else {
            console.warn(`[MCP] ${err.message}`);
          }
        });

        this.#initialize().then(() => {
          if (this.#process !== child || this.#exitError) return;
          clearTimeout(timer);
          this.removeListener('close', onClose);
          this.#ready = true;
          resolve();
        }, (err) => {
          if (!this.#exitError) this.#retire(child, err);
        });
      } catch (err) {
        this.#retire(this.#process, err);
      }
    });
  }

  /**
   * Send the MCP initialize request and list tools.
   */
  async #initialize() {
    // Send initialize
    await this.#rpcCall('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'yeaft', version: '0.1.0' },
    });

    // Send initialized notification
    this.#rpcNotify('notifications/initialized', {});

    // List tools
    const result = await this.#rpcCall('tools/list', {});
    this.#tools = (result?.tools || []).map(tool => ({
      name: `${this.#name}__${tool.name}`,
      serverName: this.#name,
      originalName: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    }));
  }

  /**
   * Call a tool on this MCP server.
   *
   * @param {string} toolName — original tool name (without server prefix)
   * @param {object} args — tool arguments
   * @param {number} [timeoutMs] — timeout in milliseconds
   * @returns {Promise<object>}
   */
  async callTool(toolName, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const result = await this.#rpcCall('tools/call', {
      name: toolName,
      arguments: args,
    }, timeoutMs);

    return result;
  }

  /**
   * Send a JSON-RPC request and wait for response.
   */
  async #rpcCall(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.failure) throw this.failure;
    const id = randomUUID();
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(id);
        reject(new Error(`RPC call "${method}" to "${this.#name}" timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      this.#pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          this.#pendingRequests.delete(id);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.#pendingRequests.delete(id);
          reject(err);
        },
      });

      try {
        this.#write(message);
      } catch (err) {
        this.#pendingRequests.get(id)?.reject(err);
      }
    });
  }

  #write(message) {
    if (this.failure) throw this.failure;
    const child = this.#process;
    try {
      const stdin = child?.stdin;
      if (!stdin?.writable || stdin.destroyed || stdin.writableEnded) {
        throw new Error(`MCP server "${this.#name}" stdin is not writable`);
      }
      stdin.write(message + '\n', (err) => {
        if (err) this.#onStdinFailure(child, err);
      });
    } catch (err) {
      this.#onStdinFailure(child, err);
      throw err;
    }
  }

  #onStdinFailure(child, err) {
    // Node tears down stdin on exit; that may fail a pending write even
    // though the corresponding reply is already buffered on stdout.
    if (this.#exitError || child?.exitCode != null || child?.signalCode != null) return;
    this.#retire(child, err);
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  #rpcNotify(method, params) {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.#write(message);
  }

  /**
   * Process the stdout buffer for complete JSON-RPC messages.
   */
  #processBuffer() {
    const lines = this.#buffer.split('\n');
    this.#buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);

        if (msg.id && this.#pendingRequests.has(msg.id)) {
          const pending = this.#pendingRequests.get(msg.id);
          if (msg.error) {
            pending.reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            pending.resolve(msg.result);
          }
        }

        // Handle notifications from server
        if (!msg.id && msg.method) {
          this.emit('notification', msg);
        }
      } catch {
        // Not valid JSON — ignore (could be debug output)
      }
    }
  }

  /**
   * Retire synchronously, before any child I/O or termination wait.
   * Its first terminal reason wins.
   */
  #retire(child, err, terminate = true) {
    if (this.#failure || this.#process !== child) return;
    clearTimeout(this.#drainTimer);
    this.#failure = err;
    this.#ready = false;
    this.#process = null;
    this.#buffer = '';
    for (const { reject } of this.#pendingRequests.values()) reject(err);
    this.emit('close', err);

    if (child) {
      // These pipes belong only to this child; leave their error handlers attached.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (terminate && !this.#exitError && child.pid && child.exitCode == null && child.signalCode == null) {
        this.#disposal = this.#terminate(child);
      }
    }
  }

  async #terminate(child) {
    const kill = (signal) => {
      try {
        child.kill(signal);
      } catch (err) {
        console.warn(`[MCP] Failed to send ${signal} to "${this.#name}": ${err.message}`);
      }
    };
    const exited = await new Promise(resolve => {
      const finish = (didExit) => {
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('close', onExit);
        resolve(didExit);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), 2000);
      child.once('exit', onExit);
      child.once('close', onExit);
      kill('SIGTERM');
    });
    if (!exited && child.exitCode == null && child.signalCode == null) kill('SIGKILL');
  }

  async stop() {
    if (this.#exitError && !this.#failure) {
      await new Promise(resolve => this.once('close', resolve));
    } else {
      this.#retire(this.#process, new Error(`MCP server "${this.#name}" stopped`));
    }
    await this.#disposal;
  }
}

// ─── MCP Manager ────────────────────────────────────────────

/**
 * MCPManager — manages multiple MCP server connections.
 */
export class MCPManager {
  /** @type {Map<string, { key: string, connection: MCPServerConnection }>} */
  #servers = new Map();

  /** @type {Map<string, object>} */
  #toolIndex = new Map(); // fullToolName → { server, tool }

  /**
   * Connect to an MCP server.
   *
   * @param {{ name: string, command: string, args?: string[], env?: object }} serverConfig
   * @returns {Promise<{ name: string, toolCount: number }>}
   */
  async connect(serverConfig) {
    const { name } = serverConfig;

    // Disconnect existing if any
    if (this.#servers.has(name)) {
      await this.disconnect(name);
    }

    const pooled = await acquireMcpConnection(serverConfig);
    const connection = pooled.connection;
    if (!connection.ready) {
      // It may have retired between acquisition and this continuation.
      throw connection.failure;
    }

    this.#servers.set(name, pooled);

    // Index tools
    for (const tool of connection.tools) {
      this.#toolIndex.set(tool.name, { server: connection, tool });
    }

    return { name, toolCount: connection.tools.length };
  }

  /**
   * Connect to all servers from config.
   *
   * @param {object[]} serverConfigs — array of server configurations
   * @returns {Promise<{ connected: string[], failed: { name: string, error: string }[] }>}
   */
  async connectAll(serverConfigs) {
    const connected = [];
    const failed = [];

    for (const config of serverConfigs) {
      try {
        await this.connect(config);
        connected.push(config.name);
      } catch (err) {
        failed.push({ name: config.name, error: err.message });
      }
    }

    return { connected, failed };
  }

  /**
   * Disconnect from a specific MCP server.
   *
   * @param {string} name — server name
   */
  async disconnect(name) {
    const entry = this.#servers.get(name);
    if (entry) {
      const connection = entry.connection;
      // Remove tools from index
      for (const tool of connection.tools) {
        if (this.#toolIndex.get(tool.name)?.server === connection) {
          this.#toolIndex.delete(tool.name);
        }
      }
      this.#servers.delete(name);
      await releaseMcpConnection(entry.key, connection);
    }
  }

  /**
   * Disconnect from all servers.
   */
  async disconnectAll() {
    const names = [...this.#servers.keys()];
    for (const name of names) {
      await this.disconnect(name);
    }
  }

  /**
   * List all available tools from all connected servers.
   *
   * @param {string} [serverFilter] — optionally filter by server name
   * @returns {object[]}
   */
  listTools(serverFilter) {
    const tools = [];

    for (const [, { server, tool }] of this.#toolIndex) {
      if (!server.ready || (serverFilter && server.name !== serverFilter)) continue;
      tools.push({
        name: tool.name,
        server: server.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    return tools;
  }

  /**
   * Call a tool by its full name (server__toolName).
   *
   * @param {string} fullToolName — e.g. "github__list_prs"
   * @param {object} [args={}] — tool arguments
   * @param {number} [timeoutMs] — timeout
   * @returns {Promise<object>}
   */
  async callTool(fullToolName, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const entry = this.#toolIndex.get(fullToolName);
    if (!entry) {
      throw new Error(`MCP tool "${fullToolName}" not found. Available: ${[...this.#toolIndex.keys()].join(', ') || '(none)'}`);
    }

    const { server, tool } = entry;
    if (!server.ready) {
      throw new Error(`MCP server "${server.name}" is not ready`);
    }

    return server.callTool(tool.originalName, args, timeoutMs);
  }

  /**
   * Get the status of all servers.
   *
   * @returns {{ name: string, ready: boolean, toolCount: number }[]}
   */
  status() {
    return [...this.#servers.entries()].map(([name, { connection: conn }]) => ({
      name,
      ready: conn.ready,
      toolCount: conn.ready ? conn.tools.length : 0,
    }));
  }

  /**
   * Check if any servers are connected.
   * @returns {boolean}
   */
  get hasServers() {
    return this.#servers.size > 0;
  }

  /**
   * Total tool count across all servers.
   * @returns {number}
   */
  get toolCount() {
    let count = 0;
    for (const { server } of this.#toolIndex.values()) if (server.ready) count++;
    return count;
  }
}

/**
 * Create an MCPManager and optionally connect to servers from config.
 *
 * @param {object} [config] — { mcp_servers: [...] }
 * @returns {Promise<MCPManager>}
 */
export async function createMCPManager(config) {
  const manager = new MCPManager();

  if (config?.mcp_servers && Array.isArray(config.mcp_servers)) {
    await manager.connectAll(config.mcp_servers);
  }

  return manager;
}

export async function __resetMcpConnectionPoolForTests({ stop = true } = {}) {
  const entries = [...mcpConnectionPool.values()];
  mcpConnectionPool.clear();
  if (!stop) return;
  await Promise.all(entries.map(entry => entry.connection.stop().catch(() => {})));
}

export function __mcpConnectionPoolSizeForTests() {
  return mcpConnectionPool.size;
}
