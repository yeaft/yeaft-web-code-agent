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

  /**
   * Start the MCP server process and initialize.
   * @returns {Promise<void>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`MCP server "${this.#name}" startup timeout (${STARTUP_TIMEOUT_MS}ms)`));
      }, STARTUP_TIMEOUT_MS);

      try {
        this.#process = spawn(this.config.command, this.config.args || [], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...this.config.env },
          windowsHide: true,
        });

        this.#process.stdout.on('data', (data) => {
          this.#buffer += data.toString();
          this.#processBuffer();
        });

        this.#process.stderr.on('data', (data) => {
          this.emit('error', new Error(`[${this.#name}] stderr: ${data.toString().trim()}`));
        });

        this.#process.on('close', (code) => {
          this.#ready = false;
          this.emit('close', code);
          // Reject all pending requests
          for (const [, { reject: rej }] of this.#pendingRequests) {
            rej(new Error(`MCP server "${this.#name}" closed with code ${code}`));
          }
          this.#pendingRequests.clear();
        });

        this.#process.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });

        // Initialize MCP protocol
        this.#initialize().then(() => {
          clearTimeout(timer);
          this.#ready = true;
          resolve();
        }).catch((err) => {
          clearTimeout(timer);
          reject(err);
        });

      } catch (err) {
        clearTimeout(timer);
        reject(err);
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
    const id = randomUUID();

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

      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.#process.stdin.write(message + '\n');
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  #rpcNotify(method, params) {
    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.#process.stdin.write(message + '\n');
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
   * Stop the MCP server process.
   */
  async stop() {
    if (this.#process) {
      this.#ready = false;
      this.#process.kill('SIGTERM');
      // Wait a bit then force kill
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (this.#process && !this.#process.killed) {
        this.#process.kill('SIGKILL');
      }
      this.#process = null;
    }
  }
}

// ─── MCP Manager ────────────────────────────────────────────

/**
 * MCPManager — manages multiple MCP server connections.
 */
export class MCPManager {
  /** @type {Map<string, MCPServerConnection>} */
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

    const connection = new MCPServerConnection(name, serverConfig);
    await connection.start();

    this.#servers.set(name, connection);

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
    const connection = this.#servers.get(name);
    if (connection) {
      // Remove tools from index
      for (const tool of connection.tools) {
        this.#toolIndex.delete(tool.name);
      }
      await connection.stop();
      this.#servers.delete(name);
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
      if (serverFilter && server.name !== serverFilter) continue;
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
    return [...this.#servers.entries()].map(([name, conn]) => ({
      name,
      ready: conn.ready,
      toolCount: conn.tools.length,
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
    return this.#toolIndex.size;
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
