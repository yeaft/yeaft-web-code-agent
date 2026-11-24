// Sub-agent ownership, driver cleanup, and collectable follow-up replies.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { STATUS } from '../../../agent/yeaft/sub-agent/status.js';
import { _resetNotifications } from '../../../agent/yeaft/sub-agent/notifications.js';
import { makeLiveness } from '../../../agent/yeaft/sub-agent/liveness.js';
import { _resetAgentRegistry, getAgentRegistry } from '../../../agent/yeaft/tools/agent.js';

import agentTool from '../../../agent/yeaft/tools/agent.js';
import sendMessage from '../../../agent/yeaft/tools/send-message.js';
import waitAgent from '../../../agent/yeaft/tools/wait-agent.js';
import closeAgent from '../../../agent/yeaft/tools/close-agent.js';
import listAgents from '../../../agent/yeaft/tools/list-agents.js';
import { ToolRegistry } from '../../../agent/yeaft/tools/registry.js';
import { defineTool } from '../../../agent/yeaft/tools/types.js';
import { NullTrace } from '../../../agent/yeaft/debug-trace.js';

const echoTool = defineTool({
  name: 'echo',
  description: 'echo input',
  parameters: { type: 'object', properties: {} },
  async execute(input) { return JSON.stringify({ echo: input }); },
});

function mkParentRegistry() {
  const reg = new ToolRegistry();
  reg.registerAll([echoTool, agentTool, sendMessage, waitAgent, closeAgent, listAgents]);
  return reg;
}

function mkDeps(adapter, overrides = {}) {
  return {
    adapter,
    trace: new NullTrace(),
    config: { model: 'test-model', maxOutputTokens: 1024, _readOnly: true, language: 'en' },
    parentToolRegistry: mkParentRegistry(),
    parentName: 'TestParent',
    parentVpId: 'vp-test',
    parentVpPersona: { vpId: 'vp-test', persona: 'You are TestPersona.' },
    ...overrides,
  };
}


describe('wait-agent envelope shape', () => {
  beforeEach(() => {
    _resetAgentRegistry();
    _resetNotifications();
  });

  it('scoped tools reject agents owned by another session', async () => {
    const agents = getAgentRegistry();
    agents.set('agent-owned-a', {
      id: 'agent-owned-a', name: 'owned-a', status: STATUS.IDLE,
      result: 'secret result', lastResult: '', error: null, messages: [],
      usage: { turns: 1 }, outputFile: '/tmp/secret.log', liveness: makeLiveness(),
      parentSessionId: 'session-a', parentVpId: 'vp-a',
      pendingPrompts: [],
    });
    agents.set('agent-owned-b', {
      id: 'agent-owned-b', name: 'owned-b', status: STATUS.IDLE,
      result: 'visible result', lastResult: '', error: null, messages: [],
      usage: { turns: 1 }, outputFile: '/tmp/visible.log', liveness: makeLiveness(),
      parentSessionId: 'session-b', parentVpId: 'vp-b',
      pendingPrompts: [],
    });
    const ctxB = { parentEngineDeps: { parentSessionId: 'session-b', parentVpId: 'vp-b' } };

    const deniedWait = JSON.parse(await waitAgent.execute({ agent_id: 'agent-owned-a' }, ctxB));
    expect(deniedWait.error).toMatch(/not found/i);
    const deniedPrompt = JSON.parse(await sendMessage.execute({ agent_id: 'agent-owned-a', message: 'steal' }, ctxB));
    expect(deniedPrompt.error).toMatch(/not found/i);
    const deniedClose = JSON.parse(await closeAgent.execute({ agent_id: 'agent-owned-a' }, ctxB));
    expect(deniedClose.error).toMatch(/not found/i);

    const listed = JSON.parse(await listAgents.execute({}, ctxB));
    expect(listed.agents.map(a => a.id)).toEqual(['agent-owned-b']);
    const ownWait = JSON.parse(await waitAgent.execute({ agent_id: 'agent-owned-b' }, ctxB));
    expect(ownWait.result).toBe('visible result');
  });

  it('collects PromptAgent revisions once each without reusing continuation evidence for the original delegation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-reply-revision-'));
    let calls = 0;
    let releaseFollowUp;
    const followUpGate = new Promise(resolve => { releaseFollowUp = resolve; });
    const reply = 'evidence '.repeat(3000);
    const continuationReply = 'Task B evidence';
    const adapter = { async *stream() {
      const call = calls++;
      if (call > 0) await followUpGate;
      // Task C fails persistently: the Engine retries it once, then gives up.
      if (call >= 3) {
        yield { type: 'error', error: 'Task C failed', retryable: false };
        return;
      }
      yield { type: 'text_delta', text: call === 2 ? continuationReply : reply };
      yield { type: 'stop', stopReason: 'end_turn' };
    } };
    const deps = mkDeps(adapter, { subAgentLogDir: dir });
    deps.config = { ...deps.config, llmRetry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } };
    const ctx = { cwd: dir, queryTurnId: 'reply-query', sessionId: 'ctx-session', senderVpId: 'vp-test', parentEngineDeps: deps };
    const spec = { name: 'revisions', mission: 'Return evidence' };
    const assertRetryRejected = async () => {
      const retry = JSON.parse(await agentTool.execute({ ...spec, name: 'original-retry' }, ctx));
      expect(retry).toMatchObject({ agentId: agent.id, error: expect.stringMatching(/Delegation evidence superseded/) });
      for (const key of ['success', 'reused', 'result', 'resultRef', 'outputFile', 'taskId']) expect(retry).not.toHaveProperty(key);
      expect(getAgentRegistry().size).toBe(1);
    };
    let agent;
    try {
      const spawned = JSON.parse(await agentTool.execute(spec, ctx));
      agent = getAgentRegistry().get(spawned.agentId);
      // The runner must not discard ctx ownership when deps omit the session.
      expect(agent.parentSessionId).toBe('ctx-session');
      const first = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 2000 }, ctx));
      expect(first.result).toBe(reply);
      expect(first.status).toBe(STATUS.IDLE);
      const repeated = JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx));
      expect(repeated).toMatchObject({ alreadyCollected: true, resultRef: first.resultRef });
      expect(repeated).not.toHaveProperty('result');
      expect(JSON.stringify(repeated).length).toBeLessThan(2500);
      expect(JSON.parse(await agentTool.execute(spec, ctx))).toMatchObject({ reused: true, resultRef: first.resultRef });
      // Retry synchronously at acceptance, before the driver can start B or
      // increment resultRevision. The queue itself must reserve ownership.
      const promptPromise = sendMessage.execute({ agent_id: agent.id, message: 'Return identical evidence again' }, ctx);
      const queuedRetryPromise = assertRetryRejected();
      expect(JSON.parse(await promptPromise).success).toBe(true);
      await queuedRetryPromise;
      expect(agent.collectedResultRef).toBe(first.resultRef);
      const live = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 10 }, ctx));
      expect(live).toMatchObject({ status: STATUS.RUNNING, timedOut: true, mustCollectReply: true, stale: false });
      expect(live).not.toHaveProperty('alreadyCollected');
      expect(live.next_steps).toMatch(/must be collected/i);
      expect(live.next_steps).toMatch(/Call WaitAgent again/i);
      expect(agent.promptReplyPending).toBe(true);
      await assertRetryRejected();
      expect(agent.promptReplyPending).toBe(true);
      const abort = new AbortController();
      abort.abort();
      const cancelled = JSON.parse(await waitAgent.execute({ agent_id: agent.id }, { ...ctx, signal: abort.signal }));
      expect(cancelled.error).toBe('Wait cancelled');
      expect(agent.abortController.signal.aborted).toBe(false);
      releaseFollowUp();
      await vi.waitFor(() => expect(agent.status).toBe(STATUS.IDLE));
      await assertRetryRejected();
      expect(agent.collectedResultRef).toBe(first.resultRef);
      const second = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 2000 }, ctx));
      expect(second).toMatchObject({ status: STATUS.IDLE, result: reply, mustCollectReply: false });
      expect(second.resultRef).not.toBe(first.resultRef);
      expect(agent.resultRevision).toBe(2);
      expect(agent.promptReplyPending).toBe(false);
      expect(agent.promptReplyPendingAt).toBeNull();
      expect(JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx))).toMatchObject({ alreadyCollected: true, resultRef: second.resultRef });
      await assertRetryRejected();
      expect(JSON.parse(await sendMessage.execute({ agent_id: agent.id, message: 'Task B: return different evidence' }, ctx)).success).toBe(true);
      const third = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 2000 }, ctx));
      expect(third).toMatchObject({ status: STATUS.IDLE, result: continuationReply });
      expect(third.resultRef).not.toBe(first.resultRef);
      await assertRetryRejected();
      expect(agent.collectedResultRef).toBe(third.resultRef);
      expect(JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx))).toMatchObject({ alreadyCollected: true, resultRef: third.resultRef });
      expect(JSON.parse(await sendMessage.execute({ agent_id: agent.id, message: 'Task C: fail without a result' }, ctx)).success).toBe(true);
      const failed = JSON.parse(await waitAgent.execute({ agent_id: agent.id, timeout_ms: 2000 }, ctx));
      expect(failed).toMatchObject({ status: STATUS.FAILED, error: 'Task C failed', result: '' });
      expect(failed.resultRef).not.toBe(third.resultRef);
      expect(agent.resultRevision).toBe(4);
      await assertRetryRejected();
      expect(agent.collectedResultRef).toBe(failed.resultRef);
      expect(JSON.parse(await waitAgent.execute({ agent_id: agent.id }, ctx))).toMatchObject({ alreadyCollected: true, resultRef: failed.resultRef });
      const closed = JSON.parse(await closeAgent.execute({ agent_id: agent.id }, ctx));
      expect(closed.status).toBe(STATUS.FAILED);
      expect(agent.abortController.signal.aborted).toBe(true);
      await agent.driverPromise;
      expect(calls).toBe(5);
    } finally {
      releaseFollowUp();
      if (agent) {
        await closeAgent.execute({ agent_id: agent.id }, ctx);
        await agent.driverPromise;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
