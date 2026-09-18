import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class MockAgent {
  constructor(serverUrl, agentName = 'test-agent') {
    this.serverUrl = serverUrl;
    this.agentName = agentName;
    this.clientId = `e2e-${randomUUID()}`;
    this.ws = null;
    this.agentId = null;
    this.conversations = new Map();
    this.browserSessions = new Map();
    this.browserRuntimeInstallFailure = null;
    this.browserRuntimeInstallPaused = false;
    this.pendingBrowserRuntimeInstall = null;
    this.browserRuntimeReady = false;
    this._messageHandlers = [];
    this._receivedMessages = [];
    this._messageHistory = [];
  }

  async connect() {
    const capabilities = [
      'terminal',
      'file_editor',
      'workbench_session_routes',
      'session_fork_from_turn',
      'work_center',
      'work_center_message_v2',
      'work_item_attachments',
      'browser_runtime_setup',
      'browser_runtime',
      'browser_webrtc',
      'browser_capture_tab',
      'plaintext-ok',
    ];
    const params = new URLSearchParams({
      type: 'agent',
      id: this.clientId,
      name: this.agentName,
      workDir: '/tmp/test',
      capabilities: capabilities.join(','),
    });
    const wsUrl = `${this.serverUrl.replace('http', 'ws')}?${params}`;
    this.ws = new WebSocket(wsUrl);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MockAgent connect timeout')), 5000);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'auth_required' && msg.tempId) {
          this.send({
            type: 'auth',
            tempId: msg.tempId,
            secret: '',
            capabilities,
            version: 'e2e',
            platform: process.platform,
          });
          return;
        }
        if (msg.type === 'registered') {
          this.agentId = msg.agentId;
          this.send({ type: 'agent_sync_complete' });
          clearTimeout(timeout);
          resolve();
        }
        // Auto-respond to create_conversation (mimicking real agent behavior)
        if (msg.type === 'create_conversation') {
          this.conversations.set(msg.conversationId, { workDir: msg.workDir });
          this.send({
            type: 'conversation_created',
            conversationId: msg.conversationId,
            workDir: msg.workDir || '/tmp/test',
            userId: msg.userId,
            username: msg.username
          });
        }

        // Auto-respond to delete_conversation
        if (msg.type === 'delete_conversation') {
          this.conversations.delete(msg.conversationId);
          this.send({
            type: 'conversation_deleted',
            conversationId: msg.conversationId
          });
        }

        if (msg.type === 'browser_runtime_status') {
          this.send({
            type: 'browser_runtime_status_result',
            requestId: msg.requestId,
            supported: true,
            state: this.pendingBrowserRuntimeInstall ? 'installing'
              : this.browserRuntimeReady ? 'ready' : 'not_installed',
            installed: this.browserRuntimeReady,
            enabled: this.browserRuntimeReady,
            ready: this.browserRuntimeReady,
            buildId: '151.0.7922.71',
            platform: 'linux',
            downloadBytes: 193_285_407,
            downloadedBytes: this.pendingBrowserRuntimeInstall ? 96_642_704 : 0,
            totalBytes: 193_285_407,
            safeError: null,
          });
        }
        if (msg.type === 'browser_runtime_install') {
          if (this.browserRuntimeInstallFailure) {
            this.send({
              type: 'browser_runtime_error',
              requestId: msg.requestId,
              code: 'browser_install_failed',
              safeError: this.browserRuntimeInstallFailure,
            });
          } else if (this.browserRuntimeInstallPaused) {
            this.pendingBrowserRuntimeInstall = msg;
            this.send({
              type: 'browser_runtime_install_progress',
              requestId: msg.requestId,
              downloadedBytes: 96_642_704,
              totalBytes: 193_285_407,
            });
          } else {
            this.completeBrowserRuntimeInstall(msg);
          }
        }
        if (msg.type === 'browser_session_list') {
          this.send({
            type: 'browser_session_list_result',
            requestId: msg.requestId,
            sessions: [...this.browserSessions.values()],
          });
        }
        if (msg.type === 'browser_session_create') {
          const browserSessionId = `browser-${randomUUID()}`;
          const snapshot = {
            browserSessionId,
            revision: 2,
            state: 'ready',
            activeUrl: 'about:blank',
            title: '',
            pageRevision: 1,
            captureMode: 'tab',
            viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
            viewerCount: 0,
          };
          this.browserSessions.set(browserSessionId, snapshot);
          this.send({ type: 'browser_session_created', requestId: msg.requestId, ...snapshot });
        }
        if (msg.type === 'browser_peer_prepare') {
          this.send({
            type: 'browser_peer_prepared',
            browserSessionId: msg.browserSessionId,
            peerId: msg.peerId,
            connectionGeneration: msg.connectionGeneration,
          });
          this.send({
            type: 'browser_peer_offer',
            browserSessionId: msg.browserSessionId,
            peerId: msg.peerId,
            connectionGeneration: msg.connectionGeneration,
            description: {
              type: 'offer',
              sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Yeaft E2E\r\nt=0 0\r\n',
            },
          });
        }
        if (msg.type === 'browser_session_close') {
          const snapshot = this.browserSessions.get(msg.browserSessionId);
          this.browserSessions.delete(msg.browserSessionId);
          this.send({
            type: 'browser_session_snapshot',
            requestId: msg.requestId,
            ...(snapshot || { browserSessionId: msg.browserSessionId, revision: 1 }),
            revision: Number(snapshot?.revision || 1) + 1,
            state: 'closed',
            terminalReason: 'user_closed',
          });
        }
        this._receivedMessages.push(msg);
        this._messageHistory.push(msg);
        this._messageHandlers.forEach(h => h(msg));
      });
      this.ws.on('error', reject);
    });
  }

  async disconnect() {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    if (ws.readyState === WebSocket.CLOSED) {
      ws.removeAllListeners();
      return;
    }
    await new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        try { ws.terminate(); } catch {}
        finish();
      }, 2_000);
      ws.once('close', finish);
      ws.once('error', finish);
      try { ws.close(); } catch { finish(); }
    });
    ws.removeAllListeners();
  }

  async reconnect() {
    await this.disconnect();
    await this.connect();
  }

  messages(type = null) {
    return this._messageHistory.filter(message => !type || message.type === type);
  }

  failBrowserRuntimeInstall(safeError) {
    this.browserRuntimeInstallFailure = safeError;
  }

  pauseBrowserRuntimeInstall() {
    this.browserRuntimeInstallPaused = true;
  }

  completeBrowserRuntimeInstall(message = this.pendingBrowserRuntimeInstall) {
    if (!message) throw new Error('No pending Browser Runtime install');
    this.pendingBrowserRuntimeInstall = null;
    this.browserRuntimeInstallPaused = false;
    this.browserRuntimeReady = true;
    this.send({
      type: 'browser_runtime_install_progress',
      requestId: message.requestId,
      downloadedBytes: 193_285_407,
      totalBytes: 193_285_407,
    });
    this.send({
      type: 'agent_capabilities_updated',
      capabilities: [
        'terminal', 'file_editor', 'workbench_session_routes', 'work_center',
        'work_center_message_v2', 'work_item_attachments', 'browser_runtime_setup',
        'browser_runtime', 'browser_webrtc', 'browser_capture_tab', 'plaintext-ok',
      ],
    });
    this.send({
      type: 'browser_runtime_status_result',
      requestId: message.requestId,
      supported: true,
      state: 'ready',
      installed: true,
      enabled: true,
      ready: true,
      buildId: '151.0.7922.71',
      platform: 'linux',
      downloadBytes: 193_285_407,
      downloadedBytes: 193_285_407,
      totalBytes: 193_285_407,
      safeError: null,
    });
  }

  waitForMessage(type, timeoutMs = 5000) {
    const existing = this._receivedMessages.find(m => m.type === type);
    if (existing) {
      this._receivedMessages = this._receivedMessages.filter(m => m !== existing);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      let handler;
      const timeout = setTimeout(() => {
        this._messageHandlers = this._messageHandlers.filter(candidate => candidate !== handler);
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeoutMs);
      handler = (msg) => {
        if (msg.type === type) {
          clearTimeout(timeout);
          this._messageHandlers = this._messageHandlers.filter(h => h !== handler);
          this._receivedMessages = this._receivedMessages.filter(message => message !== msg);
          resolve(msg);
        }
      };
      this._messageHandlers.push(handler);
    });
  }

  simulateClaudeOutput(conversationId, text) {
    this.send({
      type: 'claude_output',
      conversationId,
      data: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      }
    });
  }

  simulateTurnComplete(conversationId) {
    this.send({
      type: 'turn_completed',
      conversationId,
      result: { type: 'result', result: 'Done' }
    });
  }

  reportPorts(ports) {
    this.send({ type: 'proxy_ports_update', ports });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
