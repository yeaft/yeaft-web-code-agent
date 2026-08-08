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
    this._messageHandlers = [];
    this._receivedMessages = [];
    this._messageHistory = [];
  }

  async connect() {
    const capabilities = [
      'terminal',
      'file_editor',
      'workbench_session_routes',
      'work_center',
      'work_center_message_v2',
      'work_item_attachments',
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
