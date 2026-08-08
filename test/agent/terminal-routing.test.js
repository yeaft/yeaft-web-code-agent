import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ctx from '../../agent/context.js';
import {
  handleTerminalClose,
  handleTerminalCreate,
  handleTerminalInput,
  handleTerminalResize,
} from '../../agent/terminal.js';
import { sendWorkbenchResult } from '../../agent/workbench/request-routing.js';

class FakePty extends EventEmitter {
  onData(handler) { this.on('data', handler); }
  onExit(handler) { this.on('exit', handler); }
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
}

describe('Agent terminal request routing metadata', () => {
  let ptyProcess;

  beforeEach(() => {
    ptyProcess = new FakePty();
    ctx.nodePty = { spawn: vi.fn(() => ptyProcess) };
    ctx.conversations = new Map();
    ctx.terminals = new Map();
    ctx.CONFIG = { workDir: process.cwd() };
    ctx.sendToServer = vi.fn();
  });

  it('preserves Workbench request routing metadata on generic Agent results', () => {
    sendWorkbenchResult(ctx, {
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
      _workbenchRequestId: 'server-correlation-a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-a',
    }, {
      type: 'git_status_result',
      conversationId: '_workbench:yeaft:agent-a:session-a',
    });
    expect(ctx.sendToServer).toHaveBeenCalledWith({
      type: 'git_status_result',
      conversationId: '_workbench:yeaft:agent-a:session-a',
      _workbenchRequestId: 'server-correlation-a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-a',
    });
  });

  it('keeps legacy terminal cwd conversation-derived instead of trusting browser workDir', async () => {
    ctx.conversations.set('legacy-conversation', { workDir: '/trusted/conversation-cwd' });
    await handleTerminalCreate({
      conversationId: 'legacy-conversation',
      terminalId: 'legacy-terminal',
      workDir: '/browser-controlled/cwd',
      cols: 80,
      rows: 24,
    });
    expect(ctx.nodePty.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      cwd: '/trusted/conversation-cwd',
    }));
  });

  it('cancels a route terminal while the PTY backend is still loading', async () => {
    let resolvePty;
    const delayedPty = new Promise(resolve => { resolvePty = resolve; });
    ctx.nodePty = delayedPty;
    const owner = {
      conversationId: '_workbench:yeaft:agent-a:session-a',
      terminalId: 'pending-terminal',
      cols: 80,
      rows: 24,
      workDir: '/workspace/a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-a',
    };

    const createPromise = handleTerminalCreate(owner);
    await Promise.resolve();
    expect(ctx.terminals.get('pending-terminal')).toMatchObject({ pending: true });
    handleTerminalClose(owner);
    expect(ctx.terminals.has('pending-terminal')).toBe(false);

    const backend = { spawn: vi.fn(() => ptyProcess) };
    resolvePty(backend);
    await createPromise;
    expect(backend.spawn).not.toHaveBeenCalled();
    expect(ctx.terminals.has('pending-terminal')).toBe(false);
  });

  it('rejects cross-route input, resize, close, and terminal-id replacement', async () => {
    const ownerA = {
      conversationId: '_workbench:yeaft:agent-a:session-a',
      terminalId: 'shared-terminal',
      cols: 80,
      rows: 24,
      workDir: '/workspace/a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-a',
    };
    await handleTerminalCreate(ownerA);

    const ownerB = {
      conversationId: '_workbench:yeaft:agent-a:session-b',
      terminalId: 'shared-terminal',
      workbenchRouteKey: 'yeaft:agent-a:session-b',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-b@workspace-b',
    };
    handleTerminalInput({ ...ownerB, data: 'whoami\n' });
    handleTerminalResize({ ...ownerB, cols: 120, rows: 40 });
    handleTerminalClose(ownerB);

    expect(ptyProcess.write).not.toHaveBeenCalled();
    expect(ptyProcess.resize).not.toHaveBeenCalled();
    expect(ptyProcess.kill).not.toHaveBeenCalled();
    expect(ctx.terminals.has('shared-terminal')).toBe(true);

    await handleTerminalCreate({ ...ownerB, cols: 100, rows: 30, workDir: '/workspace/b' });
    expect(ctx.nodePty.spawn).toHaveBeenCalledTimes(1);
    expect(ptyProcess.kill).not.toHaveBeenCalled();

    handleTerminalClose(ownerA);
    expect(ptyProcess.kill).toHaveBeenCalledTimes(1);
    expect(ctx.terminals.has('shared-terminal')).toBe(false);
  });

  it('rejects same-route operations from the wrong workspace generation', async () => {
    const owner = {
      conversationId: '_workbench:yeaft:agent-a:session-a',
      terminalId: 'term-generation',
      cols: 80,
      rows: 24,
      workDir: '/workspace/a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-a',
    };
    await handleTerminalCreate(owner);

    const stale = {
      ...owner,
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-b',
    };
    handleTerminalInput({ ...stale, data: 'pwd\n' });
    handleTerminalResize({ ...stale, cols: 100, rows: 50 });
    handleTerminalClose(stale);

    expect(ptyProcess.write).not.toHaveBeenCalled();
    expect(ptyProcess.resize).not.toHaveBeenCalled();
    expect(ptyProcess.kill).not.toHaveBeenCalled();
    expect(ctx.terminals.has('term-generation')).toBe(true);
  });

  it('preserves request ownership for create, output, exit, and explicit close', async () => {
    const request = {
      conversationId: 'yeaft-123',
      terminalId: 'term-1',
      cols: 80,
      rows: 24,
      workDir: '/workspace/session-a',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-a',
      _workbenchRequestId: 'server-correlation-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    };

    await handleTerminalCreate(request);
    expect(ctx.nodePty.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({
      cwd: '/workspace/session-a',
    }));
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      workbenchWorkspaceGeneration: 'yeaft:agent-a:session-a@workspace-a',
      _workbenchRequestId: 'server-correlation-a',
      type: 'terminal_created',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));

    ptyProcess.emit('data', 'hello');
    ptyProcess.emit('exit', { exitCode: 0 });
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_output',
      data: 'hello',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_closed',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));

    await handleTerminalCreate(request);
    ctx.sendToServer.mockClear();
    handleTerminalClose({
      conversationId: 'yeaft-123',
      terminalId: 'term-1',
      workbenchRouteKey: request.workbenchRouteKey,
      workbenchWorkspaceGeneration: request.workbenchWorkspaceGeneration,
    });
    expect(ctx.sendToServer).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_closed',
      workbenchRouteKey: 'yeaft:agent-a:session-a',
      _requestUserId: 'user-a',
      _requestClientId: 'client-a',
    }));
  });
});
