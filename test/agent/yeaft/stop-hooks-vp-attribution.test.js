import { describe, it, expect } from 'vitest';

import { runStopHooks } from '../../../agent/yeaft/stop-hooks.js';

describe('runStopHooks VP attribution', () => {
  it('persists assistant and tool rows with the engine-bound speakerVpId', async () => {
    const appended = [];
    const conversationStore = {
      append(record) { appended.push(record); },
    };

    const result = await runStopHooks({
      conversationStore,
      config: { model: 'test-model' },
      messages: [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: 'answer',
          toolCalls: [{ id: 'tc1', name: 'Read', input: { file: 'x' } }],
        },
        { role: 'tool', content: 'tool output', toolCallId: 'tc1' },
      ],
      turnStartIdx: 0,
      sessionId: 'grp_vp_attr',
      threadId: 'main',
      vpId: 'vp_linus',
    });

    expect(result.errors).toEqual([]);
    expect(result.messagesPersisted).toBe(3);
    expect(appended[0]).not.toHaveProperty('speakerVpId');
    expect(appended[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      sessionId: 'grp_vp_attr',
      speakerVpId: 'vp_linus',
    }));
    expect(appended[2]).toEqual(expect.objectContaining({
      role: 'tool',
      sessionId: 'grp_vp_attr',
      speakerVpId: 'vp_linus',
    }));
  });
});
