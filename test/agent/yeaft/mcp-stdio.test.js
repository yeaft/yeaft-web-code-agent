import { EventEmitter } from 'node:events';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MCPManager,
  __mcpConnectionPoolSizeForTests,
  __resetMcpConnectionPoolForTests,
  createMCPManager,
} from '../../../agent/yeaft/mcp.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

const config = {
  name: 'example', command: 'mcp-test-server', args: ['--stdio'],
  cwd: process.cwd(), env: { MCP_TEST: 'true' },
};
const toolName = 'example__echo';
const brokenPipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

class FakeChild extends EventEmitter {
  pid = 123;
  stdin = new EventEmitter();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  closeOnKill = true;
  kill = vi.fn(() => {
    if (this.closeOnKill) queueMicrotask(() => this.emit('close', null));
    return true;
  });

  constructor() {
    super();
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.destroy = vi.fn(() => { stream.destroyed = true; });
    }
    this.stdin.writable = true;
    this.stdin.write = vi.fn(line => {
      this.emit(JSON.parse(line).method);
      return true;
    });
  }

  waitForWrite(method) {
    if (this.messages.some(message => message.method === method)) return Promise.resolve();
    return new Promise(resolve => this.once(method, resolve));
  }

  get messages() {
    return this.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
  }

  reply(method, result, error) {
    const request = this.messages.findLast(message => message.method === method);
    expect(request?.id).toBeTruthy();
    this.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, result, error }) + '\n');
  }

  async initialize() {
    this.reply('initialize', {});
    await this.waitForWrite('tools/list');
    this.reply('tools/list', { tools: [{ name: 'echo' }] });
  }
}

let children;
beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  vi.mocked(spawn).mockReset().mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
});

afterEach(async () => {
  try {
    const cleanup = __resetMcpConnectionPoolForTests();
    for (const child of children) child.emit('close', null);
    await cleanup;
  } finally {
    vi.useRealTimers();
  }
});

describe('MCP client stdio lifecycle', () => {
  it('lets startup timeout win over a buffered initialize reply; late events cannot evict a replacement', async () => {
    const manager = new MCPManager();
    const started = manager.connect(config).catch(err => err);
    const shared = new MCPManager().connect(config).catch(err => err);
    const [oldChild] = children;
    oldChild.closeOnKill = false;

    // Simulate the event loop resuming with the startup timer dispatched before stdout.
    vi.advanceTimersByTime(10_000);
    oldChild.reply('initialize', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(oldChild.messages.map(msg => msg.method)).toEqual(['initialize']);
    expect(() => oldChild.stdin.emit('error', brokenPipe())).not.toThrow();
    expect(oldChild.stdin.destroy).toHaveBeenCalledTimes(1);
    expect(oldChild.kill.mock.calls).toEqual([['SIGTERM']]);
    expect((await started).message).toMatch(/startup timeout/);
    expect(await shared).toBe(await started);
    expect(vi.getTimerCount()).toBe(1); // only the bounded SIGTERM grace period

    const connected = manager.connect(config);
    const replacement = children[1];
    await replacement.initialize();
    await connected;
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
    expect(oldChild.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    oldChild.emit('exit', null, 'SIGKILL');
    oldChild.emit('close', null);
    oldChild.emit('error', new Error('late child error'));
    expect(() => oldChild.stdin.emit('error', brokenPipe())).not.toThrow();
    expect(__mcpConnectionPoolSizeForTests()).toBe(1);
    expect(manager.status()).toEqual([{ name: 'example', ready: true, toolCount: 1 }]);
    expect(replacement.kill).not.toHaveBeenCalled();
  });

  it.each(['write callback', 'stdin error', 'child error', 'stdout error after exit', 'close', 'synchronous write']) (
    'retires a ready transport on %s and rejects pending calls without replay',
    async (source) => {
      const manager = new MCPManager();
      const other = new MCPManager();
      const connected = manager.connect(config);
      const shared = other.connect(config);
      const [child] = children;
      await child.initialize();
      await Promise.all([connected, shared]);
      const first = manager.callTool(toolName).catch(err => err);
      const second = other.callTool(toolName).catch(err => err);
      const err = brokenPipe();
      if (source === 'write callback') {
        child.stdin.write.mock.calls.at(-1)[1](err);
        expect(() => child.stdin.emit('error', err)).not.toThrow();
      } else if (source === 'stdin error') {
        expect(() => child.stdin.emit('error', err)).not.toThrow();
      } else if (source === 'child error') {
        child.emit('error', err);
      } else if (source === 'stdout error after exit') {
        child.emit('exit', 1);
        child.stdout.emit('error', err);
        expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
        expect(child.kill).not.toHaveBeenCalled();
      } else if (source === 'close') {
        child.emit('close', 1);
      } else {
        child.stdin.write.mockImplementationOnce(() => { throw err; });
        await expect(manager.callTool(toolName)).rejects.toBe(err);
      }
      const reason = source === 'close' ? /code 1/ : /EPIPE/;
      expect((await first).message).toMatch(reason);
      expect((await second).message).toMatch(reason);
      expect(manager.status()).toEqual([{ name: 'example', ready: false, toolCount: 0 }]);
      expect(manager.toolCount).toBe(0);
      expect(manager.listTools()).toEqual([]);
      await expect(manager.callTool(toolName)).rejects.toThrow(/not ready/);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(__mcpConnectionPoolSizeForTests()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      const replacementManager = new MCPManager();
      const reconnect = replacementManager.connect(config);
      const replacement = children[1];
      await replacement.initialize();
      await reconnect;
      child.stdin.write.mock.calls.at(-1)[1](err); // late write callback on the old child
      child.emit('close', 1);
      await manager.disconnect('example');
      await other.disconnect('example'); // old leases cannot touch the replacement
      expect(replacement.kill).not.toHaveBeenCalled();
      expect(__mcpConnectionPoolSizeForTests()).toBe(1);
      expect(replacement.messages.map(msg => msg.method)).toEqual([
        'initialize', 'notifications/initialized', 'tools/list',
      ]);
    },
  );

  it.each(['stdout EOF', 'child close', 'drain timeout'])(
    'drains buffered replies after exit and retires outstanding calls on %s',
    async (finish) => {
      const manager = new MCPManager();
      const connected = manager.connect(config);
      const [child] = children;
      await child.initialize();
      await connected;
      const unanswered = manager.callTool(toolName).catch(err => err);
      const buffered = manager.callTool(toolName).catch(err => err);

      child.emit('exit', 1);
      child.stdin.emit('close'); // routine closure of the exited process's stdin
      expect(child.stdout.destroy).not.toHaveBeenCalled();
      expect(manager.listTools()).toEqual([]);
      await expect(manager.callTool(toolName)).rejects.toThrow(/not ready/);
      child.reply('tools/call', { buffered: true });
      expect(await buffered).toEqual({ buffered: true });
      expect(child.stdout.destroy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(2); // unanswered RPC and stdout drain deadline

      if (finish === 'stdout EOF') child.stdout.emit('end');
      else if (finish === 'child close') child.emit('close', 1);
      else vi.advanceTimersByTime(2_000);

      expect((await unanswered).message).toMatch(/code 1/);
      expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
      expect(__mcpConnectionPoolSizeForTests()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(child.messages.filter(msg => msg.method === 'tools/call')).toHaveLength(2);
      expect(spawn).toHaveBeenCalledTimes(1);
    },
  );

  it('lets an explicit new connection start while the old lease drains without replaying calls', async () => {
    const manager = new MCPManager();
    const connected = manager.connect(config);
    const [child] = children;
    await child.initialize();
    await connected;
    const buffered = manager.callTool(toolName).catch(err => err);
    child.emit('exit', 0);

    const other = new MCPManager();
    const reconnect = other.connect(config);
    expect(spawn).toHaveBeenCalledTimes(2);
    const replacement = children[1];
    await replacement.initialize();
    await reconnect;
    const disconnected = manager.disconnect('example');
    child.reply('tools/call', { buffered: true });
    child.stdout.emit('end');
    await disconnected;

    expect(await buffered).toEqual({ buffered: true });
    expect(child.kill).not.toHaveBeenCalled();
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(replacement.messages.map(msg => msg.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list',
    ]);
    expect(__mcpConnectionPoolSizeForTests()).toBe(1);
    expect(other.status()).toEqual([{ name: 'example', ready: true, toolCount: 1 }]);
  });

  it('retires and terminates the child when stdout reaches EOF before process exit', async () => {
    const manager = new MCPManager();
    const connected = manager.connect(config);
    const [child] = children;
    child.closeOnKill = false;
    await child.initialize();
    await connected;
    const unanswered = manager.callTool(toolName).catch(err => err);
    const answered = manager.callTool(toolName);

    child.reply('tools/call', { final: true });
    child.stdout.emit('end');
    expect(__mcpConnectionPoolSizeForTests()).toBe(0);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect((await unanswered).message).toMatch(/stdout closed/);
    await expect(answered).resolves.toEqual({ final: true });
    await expect(manager.callTool(toolName)).rejects.toThrow(/not ready/);
    expect(child.messages.filter(msg => msg.method === 'tools/call')).toHaveLength(2);
    expect(spawn).toHaveBeenCalledTimes(1);

    child.emit('exit', null, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports spawn failure and an unwritable initialization notification without publishing either child', async () => {
    const manager = new MCPManager();
    const missing = manager.connect(config).catch(err => err);
    const [failed] = children;
    failed.pid = undefined;
    failed.emit('error', new Error('spawn ENOENT'));
    expect((await missing).message).toBe('spawn ENOENT');
    expect(failed.kill).not.toHaveBeenCalled();
    expect(__mcpConnectionPoolSizeForTests()).toBe(0);

    const unwritable = manager.connect(config).catch(err => err);
    const child = children[1];
    child.stdin.writable = false;
    child.reply('initialize', {});
    expect((await unwritable).message).toMatch(/stdin is not writable/);
    expect(child.messages.map(msg => msg.method)).toEqual(['initialize']);
    expect(__mcpConnectionPoolSizeForTests()).toBe(0);
    expect(manager.listTools()).toEqual([]);
  });

  it('keeps healthy configured stdio shared, preserves RPC error/timeout semantics, and stops only the final lease', async () => {
    const configured = createMCPManager({ mcp_servers: [config] });
    const second = new MCPManager();
    const shared = second.connect({ ...config, env: { ...config.env } });
    const [child] = children;
    await child.initialize();
    const first = await configured;
    await shared;
    expect(spawn).toHaveBeenCalledExactlyOnceWith(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      cwd: config.cwd, env: expect.objectContaining(config.env),
    });
    expect(first.listTools()).toEqual([{
      name: toolName, server: 'example', description: '',
      inputSchema: { type: 'object', properties: {} },
    }]);
    await first.disconnectAll();
    expect(child.kill).not.toHaveBeenCalled();

    const failed = second.callTool(toolName).catch(err => err);
    child.reply('tools/call', undefined, { message: 'tool error' });
    expect((await failed).message).toMatch(/MCP error: tool error/);
    const timedOut = second.callTool(toolName, {}, 20).catch(err => err);
    vi.advanceTimersByTime(20);
    expect((await timedOut).message).toMatch(/timed out/);
    child.reply('tools/call', { late: true });
    const call = second.callTool(toolName, { value: 'hello' });
    expect(child.messages.at(-1).params).toEqual({ name: 'echo', arguments: { value: 'hello' } });
    child.reply('tools/call', { echo: 'hello' });
    await expect(call).resolves.toEqual({ echo: 'hello' });
    expect(child.messages.filter(msg => msg.method === 'tools/call')).toHaveLength(3);
    expect(child.kill).not.toHaveBeenCalled();

    const interrupted = second.callTool(toolName).catch(err => err);
    await second.disconnectAll();
    expect((await interrupted).message).toMatch(/stopped/);
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    expect(__mcpConnectionPoolSizeForTests()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
