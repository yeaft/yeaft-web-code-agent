/**
 * task-message.test.js — task-334h R6 §Δ28 task_message echo adapter.
 *
 * Covers the pure validator, event builder, and WS handler entry point.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateTaskMessage,
  buildTaskMessageEvent,
  buildTaskMessageRejected,
  handleUnifyTaskMessage,
  TASK_MESSAGE_REJECT_CODES,
  MAX_TEXT_LENGTH,
} from '../../../agent/unify/task-message.js';

describe('validateTaskMessage', () => {
  const base = { groupId: 'grp_team', taskId: 'tsk_a', vpId: 'alice', text: 'hi' };

  it('accepts a minimal valid payload', () => {
    const r = validateTaskMessage(base);
    expect(r.ok).toBe(true);
    expect(r.payload.mentions).toEqual([]);
    expect(r.payload.replyTo).toBeNull();
  });

  it('rejects missing groupId/taskId/vpId/text', () => {
    expect(validateTaskMessage({ ...base, groupId: '' }).code)
      .toBe(TASK_MESSAGE_REJECT_CODES.MISSING_GROUP_ID);
    expect(validateTaskMessage({ ...base, taskId: '' }).code)
      .toBe(TASK_MESSAGE_REJECT_CODES.MISSING_TASK_ID);
    expect(validateTaskMessage({ ...base, vpId: '' }).code)
      .toBe(TASK_MESSAGE_REJECT_CODES.MISSING_VP_ID);
    expect(validateTaskMessage({ ...base, text: '' }).code)
      .toBe(TASK_MESSAGE_REJECT_CODES.EMPTY_TEXT);
  });

  it('rejects reserved vpId `all`/`system` but allows `user`', () => {
    expect(validateTaskMessage({ ...base, vpId: 'all' }).code)
      .toBe(TASK_MESSAGE_REJECT_CODES.INVALID_VP_ID);
    expect(validateTaskMessage({ ...base, vpId: 'system' }).code)
      .toBe(TASK_MESSAGE_REJECT_CODES.INVALID_VP_ID);
    expect(validateTaskMessage({ ...base, vpId: 'user' }).ok).toBe(true);
  });

  it('rejects over-long text', () => {
    const text = 'x'.repeat(MAX_TEXT_LENGTH + 1);
    expect(validateTaskMessage({ ...base, text }).code)
      .toBe(TASK_MESSAGE_REJECT_CODES.TEXT_TOO_LONG);
  });

  it('cleans mentions (strings only, capped at 32)', () => {
    const mentions = Array.from({ length: 40 }, (_, i) => `u${i}`);
    mentions.push(null, 42, '');
    const r = validateTaskMessage({ ...base, mentions });
    expect(r.payload.mentions).toHaveLength(32);
    expect(r.payload.mentions.every(m => typeof m === 'string' && m.length > 0)).toBe(true);
  });

  it('passes replyTo through when non-empty string', () => {
    expect(validateTaskMessage({ ...base, replyTo: 'msg_abc' }).payload.replyTo)
      .toBe('msg_abc');
    expect(validateTaskMessage({ ...base, replyTo: '' }).payload.replyTo)
      .toBeNull();
    expect(validateTaskMessage({ ...base, replyTo: 123 }).payload.replyTo)
      .toBeNull();
  });
});

describe('buildTaskMessageEvent', () => {
  const payload = { groupId: 'grp_a', taskId: 'tsk_1', vpId: 'bob', text: 'yo', mentions: ['alice'], replyTo: null };

  it('stamps msgId + ts and freezes wire shape', () => {
    const evt = buildTaskMessageEvent(payload, { now: () => 1700, msgId: () => 'msg_X' });
    expect(evt).toEqual({
      type: 'task_message',
      groupId: 'grp_a',
      taskId: 'tsk_1',
      vpId: 'bob',
      msgId: 'msg_X',
      text: 'yo',
      mentions: ['alice'],
      replyTo: null,
      ts: 1700,
    });
  });

  it('echoes requestId only when provided', () => {
    const with_ = buildTaskMessageEvent(payload, { msgId: () => 'm', now: () => 1, requestId: 'r1' });
    expect(with_.requestId).toBe('r1');
    const without = buildTaskMessageEvent(payload, { msgId: () => 'm', now: () => 1 });
    expect('requestId' in without).toBe(false);
  });
});

describe('buildTaskMessageRejected', () => {
  it('carries code + requestId + groupId/taskId for UI correlation', () => {
    const evt = buildTaskMessageRejected('empty_text', {
      requestId: 'r2', groupId: 'g', taskId: 't',
    });
    expect(evt).toEqual({
      type: 'task_message_rejected',
      code: 'empty_text',
      requestId: 'r2',
      groupId: 'g',
      taskId: 't',
    });
  });
});

describe('handleUnifyTaskMessage', () => {
  it('round-trip echoes a valid message', () => {
    const sent = [];
    const send = (e) => sent.push(e);
    handleUnifyTaskMessage(
      { groupId: 'g', taskId: 't', vpId: 'alice', text: 'hello', requestId: 'rq1' },
      send,
      { now: () => 42, msgId: () => 'msg_k' },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'task_message',
      groupId: 'g',
      taskId: 't',
      vpId: 'alice',
      msgId: 'msg_k',
      text: 'hello',
      ts: 42,
      requestId: 'rq1',
    });
  });

  it('emits task_message_rejected on bad payload, never throws', () => {
    const sent = [];
    expect(() => handleUnifyTaskMessage({ groupId: 'g', taskId: 't', vpId: 'alice', text: '' }, (e) => sent.push(e)))
      .not.toThrow();
    expect(sent[0]).toMatchObject({ type: 'task_message_rejected', code: 'empty_text' });
  });

  it('swallows sender errors — must never crash the WS pipeline', () => {
    const send = vi.fn(() => { throw new Error('socket dead'); });
    expect(() => handleUnifyTaskMessage(
      { groupId: 'g', taskId: 't', vpId: 'alice', text: 'hi' }, send,
    )).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
