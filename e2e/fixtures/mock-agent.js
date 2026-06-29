import WebSocket from 'ws';

export class MockAgent {
  constructor(serverUrl, agentName = 'test-agent') {
    this.serverUrl = serverUrl;
    this.agentName = agentName;
    this.ws = null;
    this.agentId = null;
    this.conversations = new Map();
    this._messageHandlers = [];
    this._receivedMessages = [];
  }

  async connect() {
    const wsUrl = `${this.serverUrl.replace('http', 'ws')}?type=agent&name=${this.agentName}&workDir=/tmp/test&capabilities=terminal,file_editor`;
    this.ws = new WebSocket(wsUrl);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MockAgent connect timeout')), 5000);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);
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
        this._messageHandlers.forEach(h => h(msg));
      });
      this.ws.on('error', reject);
    });
  }

  async disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  async reconnect() {
    await this.disconnect();
    await this.connect();
  }

  waitForMessage(type, timeoutMs = 5000) {
    const existing = this._receivedMessages.find(m => m.type === type);
    if (existing) {
      this._receivedMessages = this._receivedMessages.filter(m => m !== existing);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
      const handler = (msg) => {
        if (msg.type === type) {
          clearTimeout(timeout);
          this._messageHandlers = this._messageHandlers.filter(h => h !== handler);
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
