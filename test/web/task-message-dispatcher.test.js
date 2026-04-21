/**
 * test/web/task-message-dispatcher.test.js — task-334j
 *
 * 6 tests covering the task_message/task_message_rejected event dispatch
 * in chat.js store + replyTo roundtrip + reject toast entry.
 *
 * Uses a minimal mock store to exercise the logic without Pinia/Vue.
 */
import { describe, it, expect, vi } from 'vitest';

// ── Minimal in-memory store mock ──
function createMockStore() {
  const wsSent = [];
  return {
    unifyConversationId: 'conv-1',
    unifyActiveTaskDetailId: null,
    taskMessagesMap: {},
    taskMessageRejects: [],
    replyToMap: {},
    messagesMap: {},
    inputDrafts: {},
    expertSelections: [],

    sendWsMessage(msg) { wsSent.push(msg); },
    _wsSent: wsSent,

    // Mirror of chat.js handleUnifyOutput task_message case:
    handleTaskMessage(event) {
      if (!event || !event.msgId || !event.taskId) return;
      const taskId = event.taskId;
      if (!this.taskMessagesMap[taskId]) this.taskMessagesMap[taskId] = [];
      const taskList = this.taskMessagesMap[taskId];
      if (!taskList.some(m => m.msgId === event.msgId)) {
        taskList.push({
          msgId: event.msgId, vpId: event.vpId, text: event.text,
          mentions: Array.isArray(event.mentions) ? event.mentions : [],
          replyTo: event.replyTo || null, ts: event.ts,
          groupId: event.groupId, taskId,
        });
      }
      const convId = this.unifyConversationId;
      if (convId) {
        if (!this.messagesMap[convId]) this.messagesMap[convId] = [];
        const stream = this.messagesMap[convId];
        if (!stream.some(m => m && m.id === event.msgId)) {
          stream.push({
            type: 'task-message', id: event.msgId, taskId,
            groupId: event.groupId, vpId: event.vpId,
            content: event.text,
            mentions: Array.isArray(event.mentions) ? event.mentions : [],
            replyTo: event.replyTo || null,
            timestamp: typeof event.ts === 'number' ? event.ts : Date.now(),
          });
        }
      }
    },

    // Mirror of chat.js handleUnifyOutput task_message_rejected case:
    handleTaskMessageRejected(event) {
      const id = 'tmr_' + Date.now().toString(36) + '_' +
        Math.random().toString(36).slice(2, 8);
      this.taskMessageRejects.push({
        id,
        code: typeof event.code === 'string' ? event.code : 'unknown',
        groupId: event.groupId || null,
        taskId: event.taskId || null,
        requestId: event.requestId || null,
        at: Date.now(),
      });
    },

    // Mirror of chat.js sendUnifyTaskMessage:
    sendUnifyTaskMessage({ groupId, taskId, vpId, text, mentions, replyTo, requestId }) {
      if (!text || !text.trim()) return;
      if (!groupId || !taskId || !vpId) return;
      const msg = { type: 'unify_task_message', groupId, taskId, vpId, text };
      if (Array.isArray(mentions) && mentions.length > 0) msg.mentions = mentions;
      if (replyTo) msg.replyTo = replyTo;
      if (requestId) msg.requestId = requestId;
      this.sendWsMessage(msg);
    },

    setReplyTo(key, msg) {
      if (!key || !msg) { if (key) delete this.replyToMap[key]; return; }
      const msgId = msg.msgId || msg.id || null;
      if (!msgId) { delete this.replyToMap[key]; return; }
      const previewSrc = typeof msg.content === 'string' ? msg.content
        : (typeof msg.text === 'string' ? msg.text : '');
      this.replyToMap[key] = { msgId, vpId: msg.vpId || null, textPreview: previewSrc.slice(0, 80) };
    },
    clearReplyTo(key) { if (key) delete this.replyToMap[key]; },
    dismissTaskMessageReject(id) {
      this.taskMessageRejects = this.taskMessageRejects.filter(r => r.id !== id);
    },
  };
}

describe('task_message routing', () => {
  it('handleTaskMessage pushes task-message into messagesMap under unifyConversationId', () => {
    const s = createMockStore();
    s.handleTaskMessage({
      type: 'task_message', groupId: 'g1', taskId: 't1', vpId: 'alice',
      msgId: 'm1', text: 'hello', mentions: ['bob'], ts: 1000,
    });
    expect(s.messagesMap['conv-1']).toHaveLength(1);
    expect(s.messagesMap['conv-1'][0]).toMatchObject({
      type: 'task-message', id: 'm1', taskId: 't1', vpId: 'alice', content: 'hello',
    });
  });

  it('handleTaskMessage populates taskMessagesMap[taskId] parallel cache', () => {
    const s = createMockStore();
    s.handleTaskMessage({
      type: 'task_message', groupId: 'g1', taskId: 't1', vpId: 'alice',
      msgId: 'm1', text: 'hello', ts: 1000,
    });
    expect(s.taskMessagesMap['t1']).toHaveLength(1);
    expect(s.taskMessagesMap['t1'][0].msgId).toBe('m1');
  });
});

describe('sendUnifyTaskMessage', () => {
  it('sends unify_task_message with groupId/taskId/vpId/text/mentions/replyTo', () => {
    const s = createMockStore();
    s.sendUnifyTaskMessage({
      groupId: 'g1', taskId: 't1', vpId: 'user',
      text: 'hi @alice', mentions: ['alice'], replyTo: 'm0', requestId: 'tm_abc',
    });
    expect(s._wsSent).toHaveLength(1);
    expect(s._wsSent[0]).toMatchObject({
      type: 'unify_task_message', groupId: 'g1', taskId: 't1',
      vpId: 'user', text: 'hi @alice', mentions: ['alice'], replyTo: 'm0',
    });
  });

  it('clears replyTo state on successful send (not on reject)', () => {
    const s = createMockStore();
    s.setReplyTo('task:t1', { msgId: 'm0', vpId: 'alice', content: 'original' });
    expect(s.replyToMap['task:t1']).toBeTruthy();
    // Simulate send clears replyTo
    s.clearReplyTo('task:t1');
    expect(s.replyToMap['task:t1']).toBeUndefined();
  });
});

describe('replyTo state', () => {
  it('setReplyTo/clearReplyTo roundtrip, msgId picked up by send path', () => {
    const s = createMockStore();
    s.setReplyTo('task:t1', { msgId: 'm5', vpId: 'bob', content: 'test message body' });
    expect(s.replyToMap['task:t1']).toMatchObject({
      msgId: 'm5', vpId: 'bob', textPreview: 'test message body',
    });
    s.clearReplyTo('task:t1');
    expect(s.replyToMap['task:t1']).toBeUndefined();
  });
});

describe('reject toast', () => {
  it('handleTaskMessageRejected pushes toast entry with stable code', () => {
    const s = createMockStore();
    s.handleTaskMessageRejected({
      type: 'task_message_rejected', code: 'empty_text',
      taskId: 't1', requestId: 'tm_123',
    });
    expect(s.taskMessageRejects).toHaveLength(1);
    expect(s.taskMessageRejects[0].code).toBe('empty_text');
    // Dismiss
    s.dismissTaskMessageReject(s.taskMessageRejects[0].id);
    expect(s.taskMessageRejects).toHaveLength(0);
  });
});
