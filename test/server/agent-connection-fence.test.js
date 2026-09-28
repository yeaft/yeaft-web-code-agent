import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockWebSocket, WS_CLOSED, WS_OPEN } from '../helpers/mockWs.js';

const broadcastAgentList = vi.fn(async () => {});
const clearAgentDirCache = vi.fn();
const getOrCreateUser = vi.fn(() => ({ id: 'local-user-id', username: 'dev-user' }));
const upsertAgentInventory = vi.fn();
const touchAgentInventory = vi.fn(() => true);

vi.mock('../../server/config.js', () => ({
  CONFIG: {
    skipAuth: true,
    debug: false,
  },
}));

const verifyAgent = vi.fn(() => ({
  valid: true,
  sessionKey: null,
  userId: 'owner-1',
  username: 'owner',
}));
vi.mock('../../server/auth.js', () => ({ verifyAgent }));

vi.mock('../../server/ws-utils.js', () => ({
  parseMessage: vi.fn(async (data) => JSON.parse(data.toString())),
  broadcastAgentList,
  clearAgentDirCache,
}));

vi.mock('../../server/handlers/client-person.js', () => ({
  handleAgentPerson: vi.fn(async () => false),
}));
vi.mock('../../server/handlers/agent-conversation.js', () => ({
  handleAgentConversation: vi.fn(async () => false),
}));
vi.mock('../../server/handlers/agent-work-center.js', () => ({
  handleAgentWorkCenter: vi.fn(async () => false),
}));
vi.mock('../../server/handlers/agent-file-terminal.js', () => ({
  handleAgentFileTerminal: vi.fn(async () => false),
}));
vi.mock('../../server/handlers/agent-sync.js', () => ({
  handleAgentSync: vi.fn(async () => false),
}));
vi.mock('../../server/perf-trace.js', () => ({ recordPerfTraceEvent: vi.fn() }));
vi.mock('../../server/database.js', () => ({
  agentInventoryDb: { upsert: upsertAgentInventory, touch: touchAgentInventory },
  userDb: { getOrCreate: getOrCreateUser, isActive: vi.fn(() => true) }
}));

const handleAgentOutput = vi.fn(async () => true);
vi.mock('../../server/handlers/agent-output.js', () => ({ handleAgentOutput }));

const { CONFIG } = await import('../../server/config.js');
const { agents, pendingAgentConnections } = await import('../../server/context.js');
const { handleAgentConnection } = await import('../../server/ws-agent.js');

function agentUrl(id = 'agent-1') {
  return new URL(`ws://localhost/?type=agent&id=${id}&name=Agent&instanceId=${id}&capabilities=plaintext-ok`);
}

function authenticate(socket, {
  secret = 'owner-secret',
  version = '1.0.0',
  capabilities = ['plaintext-ok'],
} = {}) {
  const challenge = socket.getLastMessage();
  socket.simulateMessage({
    type: 'auth',
    tempId: challenge.tempId,
    secret,
    capabilities,
    version,
  });
}

async function settleMessages() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  CONFIG.skipAuth = true;
  agents.clear();
  pendingAgentConnections.clear();
  broadcastAgentList.mockClear();
  clearAgentDirCache.mockClear();
  handleAgentOutput.mockClear();
  verifyAgent.mockReset();
  verifyAgent.mockReturnValue({
    valid: true,
    sessionKey: null,
    userId: 'owner-1',
    username: 'owner',
  });
  getOrCreateUser.mockClear();
  upsertAgentInventory.mockClear();
  touchAgentInventory.mockClear();
  touchAgentInventory.mockReturnValue(true);
  delete process.env.YEAFT_LOCAL_RUN;
});

afterEach(() => {
  for (const agent of agents.values()) {
    if (agent._syncTimeout) clearTimeout(agent._syncTimeout);
  }
  agents.clear();
  pendingAgentConnections.clear();
  vi.useRealTimers();
});

describe('Agent connection replacement fence', () => {
  it('retires the old socket and ignores its messages after a replacement registers', async () => {
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    authenticate(oldSocket);
    await settleMessages();
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket);
    await settleMessages();

    expect(agents.get('agent-1')?.ws).toBe(newSocket);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);

    oldSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-old' },
    });
    await settleMessages();

    expect(handleAgentOutput).not.toHaveBeenCalled();

    newSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-new' },
    });
    await settleMessages();

    expect(handleAgentOutput).toHaveBeenCalledTimes(1);
    expect(handleAgentOutput.mock.calls[0][1].ws).toBe(newSocket);
  });

  it('assigns local-run agents to the skip-auth browser owner only when requested', async () => {
    process.env.YEAFT_LOCAL_RUN = 'true';
    const localSocket = new MockWebSocket(WS_OPEN);
    handleAgentConnection(localSocket, agentUrl('local-agent'));
    authenticate(localSocket);
    await settleMessages();
    expect(getOrCreateUser).toHaveBeenCalledWith('dev-user');
    expect(agents.get('local-agent')).toMatchObject({
      ownerId: 'local-user-id',
      ownerUsername: 'dev-user',
    });

    delete process.env.YEAFT_LOCAL_RUN;
    const genericSocket = new MockWebSocket(WS_OPEN);
    handleAgentConnection(genericSocket, agentUrl('generic-dev-agent'));
    authenticate(genericSocket);
    await settleMessages();
    expect(agents.get('generic-dev-agent')).toMatchObject({
      ownerId: null,
      ownerUsername: null,
    });
  });

  it('persists durable identity and last-seen state without making inventory authoritative for liveness', async () => {
    const socket = new MockWebSocket(WS_OPEN);
    handleAgentConnection(socket, agentUrl('inventory-agent'));
    authenticate(socket, { version: '1.0.446', capabilities: ['plaintext-ok', 'browser_runtime'] });
    await settleMessages();

    expect(upsertAgentInventory).toHaveBeenCalledWith(expect.objectContaining({
      id: 'inventory-agent',
      name: 'Agent',
      instanceId: 'inventory-agent',
      version: '1.0.446',
      capabilities: ['plaintext-ok', 'browser_runtime'],
      lastSeenAt: expect.any(Number),
      lastConnectedAt: expect.any(Number),
    }));

    upsertAgentInventory.mockClear();
    socket.simulatePong();
    expect(touchAgentInventory).toHaveBeenCalledWith('inventory-agent', expect.any(Number));

    socket.close(1000, 'test disconnect');
    expect(agents.has('inventory-agent')).toBe(false);
    expect(upsertAgentInventory).toHaveBeenCalledWith(expect.objectContaining({
      id: 'inventory-agent',
      lastSeenAt: expect.any(Number),
    }));
  });

  it('does not let an old close delete or rebroadcast over the replacement record', async () => {
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    authenticate(oldSocket);
    await settleMessages();
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket);
    await settleMessages();
    broadcastAgentList.mockClear();

    oldSocket.emit('close', 1000, 'late old close');

    expect(agents.get('agent-1')?.ws).toBe(newSocket);
    expect(broadcastAgentList).not.toHaveBeenCalled();
  });

  it('keeps the newest SKIP_AUTH connection when the older auth arrives last', async () => {
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket, { version: '1.0.350' });
    await settleMessages();

    expect(agents.get('agent-1')).toMatchObject({
      ws: newSocket,
      version: '1.0.350',
    });
    broadcastAgentList.mockClear();

    authenticate(oldSocket, { version: '1.0.337' });
    await settleMessages();

    expect(agents.get('agent-1')).toMatchObject({
      ws: newSocket,
      version: '1.0.350',
    });
    expect(newSocket.readyState).toBe(WS_OPEN);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);
    expect(broadcastAgentList).not.toHaveBeenCalled();

    oldSocket.emit('close', 1000, 'late old close');
    expect(agents.get('agent-1')?.ws).toBe(newSocket);
    expect(broadcastAgentList).not.toHaveBeenCalled();
  });

  it('does not revive an older SKIP_AUTH connection after the newest disconnects', async () => {
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket, { version: '1.0.350' });
    await settleMessages();
    newSocket.close(1000, 'disconnect before old auth');
    expect(agents.has('agent-1')).toBe(false);

    authenticate(oldSocket, { version: '1.0.337' });
    await settleMessages();

    expect(agents.has('agent-1')).toBe(false);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);
  });

  it('preserves the safe remote-upgrade capability after authenticated registration', async () => {
    CONFIG.skipAuth = false;
    const socket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(socket, agentUrl());
    authenticate(socket, {
      version: '1.0.999',
      capabilities: ['plaintext-ok', 'remote_upgrade_safe'],
    });
    await settleMessages();

    expect(agents.get('owner-1:agent-1')).toMatchObject({
      ws: socket,
      version: '1.0.999',
      capabilities: ['plaintext-ok', 'remote_upgrade_safe'],
    });
  });

  it('applies the same replacement fence after authenticated registration', async () => {
    CONFIG.skipAuth = false;
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    authenticate(oldSocket);
    await settleMessages();
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket);
    await settleMessages();

    const scopedAgentId = 'owner-1:agent-1';
    expect(agents.get(scopedAgentId)?.ws).toBe(newSocket);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);

    oldSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-old' },
    });
    await settleMessages();

    expect(handleAgentOutput).not.toHaveBeenCalled();

    newSocket.simulateMessage({
      type: 'yeaft_output',
      event: { type: 'yeaft_status', catalogEpoch: 'epoch-new' },
    });
    await settleMessages();

    expect(handleAgentOutput).toHaveBeenCalledTimes(1);
    expect(handleAgentOutput.mock.calls[0][1].ws).toBe(newSocket);
  });

  it('keeps the newest authenticated connection when the older auth arrives last', async () => {
    CONFIG.skipAuth = false;
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket, { version: '1.0.350' });
    await settleMessages();

    const scopedAgentId = 'owner-1:agent-1';
    expect(agents.get(scopedAgentId)).toMatchObject({
      ws: newSocket,
      version: '1.0.350',
    });
    broadcastAgentList.mockClear();

    authenticate(oldSocket, { version: '1.0.337' });
    await settleMessages();

    expect(agents.get(scopedAgentId)).toMatchObject({
      ws: newSocket,
      version: '1.0.350',
    });
    expect(newSocket.readyState).toBe(WS_OPEN);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);
    expect(broadcastAgentList).not.toHaveBeenCalled();

    oldSocket.emit('close', 1000, 'late old close');
    expect(agents.get(scopedAgentId)?.ws).toBe(newSocket);
    expect(broadcastAgentList).not.toHaveBeenCalled();
  });

  it('does not revive an older authenticated connection after the newest disconnects', async () => {
    CONFIG.skipAuth = false;
    const oldSocket = new MockWebSocket(WS_OPEN);
    const newSocket = new MockWebSocket(WS_OPEN);

    handleAgentConnection(oldSocket, agentUrl());
    handleAgentConnection(newSocket, agentUrl());
    authenticate(newSocket, { version: '1.0.350' });
    await settleMessages();
    newSocket.close(1000, 'disconnect before old auth');

    const scopedAgentId = 'owner-1:agent-1';
    expect(agents.has(scopedAgentId)).toBe(false);
    authenticate(oldSocket, { version: '1.0.337' });
    await settleMessages();

    expect(agents.has(scopedAgentId)).toBe(false);
    expect(oldSocket.readyState).toBe(WS_CLOSED);
    expect(oldSocket.closeCode).toBe(1008);
  });

  it('does not let a newer invalid auth fence an older valid connection', async () => {
    CONFIG.skipAuth = false;
    const oldSocket = new MockWebSocket(WS_OPEN);
    const invalidNewSocket = new MockWebSocket(WS_OPEN);
    verifyAgent.mockImplementation(secret => secret === 'invalid-secret'
      ? { valid: false }
      : {
          valid: true,
          sessionKey: null,
          userId: 'owner-1',
          username: 'owner-one',
        });

    handleAgentConnection(oldSocket, agentUrl());
    handleAgentConnection(invalidNewSocket, agentUrl());
    authenticate(invalidNewSocket, { secret: 'invalid-secret', version: '1.0.350' });
    authenticate(oldSocket, { secret: 'owner-one-secret', version: '1.0.337' });
    await settleMessages();

    expect(invalidNewSocket.readyState).toBe(WS_CLOSED);
    expect(invalidNewSocket.closeCode).toBe(1008);
    expect(agents.get('owner-1:agent-1')).toMatchObject({
      ws: oldSocket,
      version: '1.0.337',
    });
    expect(oldSocket.readyState).toBe(WS_OPEN);
  });

  it('does not let another owner claim an authenticated connection generation', async () => {
    CONFIG.skipAuth = false;
    const ownerOneSocket = new MockWebSocket(WS_OPEN);
    const ownerTwoSocket = new MockWebSocket(WS_OPEN);
    verifyAgent.mockImplementation(secret => ({
      valid: true,
      sessionKey: null,
      userId: secret === 'owner-two-secret' ? 'owner-2' : 'owner-1',
      username: secret === 'owner-two-secret' ? 'owner-two' : 'owner-one',
    }));

    handleAgentConnection(ownerOneSocket, agentUrl());
    handleAgentConnection(ownerTwoSocket, agentUrl());
    authenticate(ownerTwoSocket, { secret: 'owner-two-secret', version: '1.0.350' });
    authenticate(ownerOneSocket, { secret: 'owner-one-secret', version: '1.0.337' });
    await settleMessages();

    expect(agents.get('owner-1:agent-1')).toMatchObject({
      ws: ownerOneSocket,
      version: '1.0.337',
    });
    expect(agents.get('owner-2:agent-1')).toMatchObject({
      ws: ownerTwoSocket,
      version: '1.0.350',
    });
    expect(ownerOneSocket.readyState).toBe(WS_OPEN);
    expect(ownerTwoSocket.readyState).toBe(WS_OPEN);
  });
});
