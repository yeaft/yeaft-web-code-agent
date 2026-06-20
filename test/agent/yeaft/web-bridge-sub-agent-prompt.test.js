import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = [];

vi.mock('../../../agent/connection/buffer.js', () => ({
  sendToServer: vi.fn((msg) => { sent.push(msg); }),
}));

const { handleYeaftSubAgentPrompt, __testHooks } = await import('../../../agent/yeaft/web-bridge.js');
const { getAgentRegistry, _resetAgentRegistry } = await import('../../../agent/yeaft/tools/agent.js');

describe('Yeaft sub-agent prompt wire handler', () => {
  beforeEach(() => {
    sent.length = 0;
    _resetAgentRegistry();
    __testHooks.setSessionForTest(null);
  });

  afterEach(() => {
    _resetAgentRegistry();
    __testHooks.setSessionForTest(null);
  });

  it('queues a scoped prompt into the matching live sub-agent', () => {
    const refreshTaskLog = vi.fn();
    __testHooks.setSessionForTest({
      taskManager: {
        getTask: vi.fn(() => ({
          id: 'task-1',
          sessionId: 'session-a',
          ownerVpId: 'vp-a',
          kind: 'sub_agent',
          status: 'running',
          runtime: { subAgentId: 'sub-1' },
          source: { threadId: 'main' },
        })),
        refreshTaskLog,
      },
    });
    const outputLog = { write: vi.fn() };
    getAgentRegistry().set('sub-1', {
      id: 'sub-1',
      name: 'worker',
      status: 'idle',
      parentSessionId: 'session-a',
      parentVpId: 'vp-a',
      parentThreadId: 'main',
      pendingPrompts: [],
      messages: [],
      outputLog,
    });

    handleYeaftSubAgentPrompt({
      sessionId: 'session-a',
      taskId: 'task-1',
      subAgentId: 'sub-1',
      message: '  latest user idea  ',
      clientPromptId: 'prompt-1',
    });

    const agent = getAgentRegistry().get('sub-1');
    expect(agent.pendingPrompts).toEqual(['latest user idea']);
    expect(agent.messages.at(-1)).toMatchObject({ role: 'user', content: 'latest user idea' });
    expect(agent.status).toBe('running');
    expect(outputLog.write).toHaveBeenCalledWith(expect.objectContaining({ type: 'user_prompt', content: 'latest user idea' }));
    expect(refreshTaskLog).toHaveBeenCalledWith('session-a', 'task-1');
    expect(sent.at(-1)).toMatchObject({
      type: 'yeaft_output',
      sessionId: 'session-a',
      vpId: 'vp-a',
      event: {
        type: 'yeaft_sub_agent_prompt_result',
        success: true,
        taskId: 'task-1',
        subAgentId: 'sub-1',
        clientPromptId: 'prompt-1',
        pending: 1,
      },
    });
  });

  it('rejects prompts whose task does not own the sub-agent id', () => {
    __testHooks.setSessionForTest({
      taskManager: {
        getTask: vi.fn(() => ({
          id: 'task-1',
          sessionId: 'session-a',
          ownerVpId: 'vp-a',
          kind: 'sub_agent',
          status: 'running',
          runtime: { subAgentId: 'sub-1' },
          source: { threadId: 'main' },
        })),
      },
    });
    getAgentRegistry().set('sub-2', {
      id: 'sub-2',
      name: 'other',
      status: 'idle',
      parentSessionId: 'session-a',
      parentVpId: 'vp-a',
      parentThreadId: 'main',
      pendingPrompts: [],
      messages: [],
    });

    handleYeaftSubAgentPrompt({
      sessionId: 'session-a',
      taskId: 'task-1',
      subAgentId: 'sub-2',
      message: 'wrong target',
      clientPromptId: 'prompt-2',
    });

    expect(getAgentRegistry().get('sub-2').pendingPrompts).toEqual([]);
    expect(sent.at(-1)).toMatchObject({
      event: {
        type: 'yeaft_sub_agent_prompt_result',
        success: false,
        taskId: 'task-1',
        subAgentId: 'sub-2',
        clientPromptId: 'prompt-2',
        error: 'sub-agent task not found',
      },
    });
  });
});
