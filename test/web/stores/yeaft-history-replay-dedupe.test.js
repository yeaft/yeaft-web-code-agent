import { describe, it, expect } from 'vitest';

import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
  finishStreamingForConversation,
  mergeMessagesByStableId,
  shouldCatchUpLoadedYeaftSession,
  shouldForceHydrateActiveYeaftSession,
} from '../../../web/stores/helpers/messages.js';

function mkStore() {
  return {
    yeaftConversationId: 'yeaft-1',
    yeaftActiveSessionFilter: 'sess-1',
    messagesMap: {},
    _currentYeaftSessionId: 'sess-1',
    _currentYeaftVpId: 'vp-1',
    _currentYeaftTurnId: 'thread-1',
    _currentYeaftThreadId: 'thread-1',
  };
}

describe('Yeaft history replay message dedupe', () => {
  it('does not append a duplicate assistant row when the same completed history message replays', () => {
    const store = mkStore();
    const convId = store.yeaftConversationId;

    appendToAssistantMessageForConversation(store, convId, 'hello from history', {
      id: '000001-assistant',
      ts: '2026-06-12T07:00:00.000Z',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      turnId: 'thread-1',
      threadId: 'thread-1',
    });
    finishStreamingForConversation(store, convId);

    appendToAssistantMessageForConversation(store, convId, 'hello from history', {
      id: '000001-assistant',
      ts: '2026-06-12T07:00:00.000Z',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      turnId: 'thread-1',
      threadId: 'thread-1',
    });

    expect(store.messagesMap[convId]).toHaveLength(1);
    expect(store.messagesMap[convId][0]).toMatchObject({
      id: '000001-assistant',
      messageId: '000001-assistant',
      type: 'assistant',
      content: 'hello from history',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      speakerVpId: 'vp-1',
      threadId: 'thread-1',
      isStreaming: false,
    });
  });

  it('merges repeated stable-id assistant replay while the existing row is still streaming', () => {
    const store = mkStore();
    const convId = store.yeaftConversationId;

    appendToAssistantMessageForConversation(store, convId, 'hel', {
      id: '000001-assistant',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      turnId: 'thread-1',
      threadId: 'thread-1',
    });

    appendToAssistantMessageForConversation(store, convId, 'hello from history', {
      id: '000001-assistant',
      sessionId: 'sess-1',
      vpId: 'vp-1',
      turnId: 'thread-1',
      threadId: 'thread-1',
    });

    expect(store.messagesMap[convId]).toHaveLength(1);
    expect(store.messagesMap[convId][0]).toMatchObject({
      id: '000001-assistant',
      messageId: '000001-assistant',
      content: 'hello from history',
      isStreaming: true,
      speakerVpId: 'vp-1',
    });
  });

  it('merges local placeholder and agent conversation rows by stable id', () => {
    const localUser = { id: '000001-user', messageId: '000001-user', type: 'user', content: 'hi' };
    const agentUser = { id: '000001-user', messageId: '000001-user', type: 'user', content: 'hi', sessionId: 'sess-1' };
    const localAssistant = { id: '000002-assistant', messageId: '000002-assistant', type: 'assistant', content: 'hello', isStreaming: true };
    const agentAssistant = { id: '000002-assistant', messageId: '000002-assistant', type: 'assistant', content: 'hello', isStreaming: false, sessionId: 'sess-1' };

    const merged = mergeMessagesByStableId(
      [agentUser, agentAssistant],
      [localUser, localAssistant],
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ id: '000001-user', sessionId: 'sess-1' });
    expect(merged[1]).toMatchObject({ id: '000002-assistant', sessionId: 'sess-1', isStreaming: false });
  });

  it('keeps id-less live messages append-only', () => {
    const store = mkStore();
    const convId = store.yeaftConversationId;

    addMessageToConversation(store, convId, { type: 'assistant', content: 'first' });
    addMessageToConversation(store, convId, { type: 'assistant', content: 'second' });

    expect(store.messagesMap[convId].map(m => m.content)).toEqual(['first', 'second']);
  });

  it('does not force-reload an already loaded active session on snapshot replay', () => {
    expect(shouldForceHydrateActiveYeaftSession('sess-1', 'sess-1', {
      loaded: true,
      loading: false,
    })).toBe(false);
    expect(shouldForceHydrateActiveYeaftSession('sess-1', 'sess-1', {
      loaded: false,
      loading: true,
    })).toBe(false);
    expect(shouldForceHydrateActiveYeaftSession('sess-1', 'sess-1', null)).toBe(true);
    expect(shouldForceHydrateActiveYeaftSession('sess-2', 'sess-1', null)).toBe(false);
  });

  it('still allows explicit afterSeq catch-up for a loaded active session', () => {
    expect(shouldCatchUpLoadedYeaftSession({
      loaded: true,
      loading: false,
      latestSeq: 42,
    }, true)).toBe(true);
    expect(shouldCatchUpLoadedYeaftSession({
      loaded: true,
      loading: false,
      latestSeq: 42,
    }, false)).toBe(false);
    expect(shouldCatchUpLoadedYeaftSession({
      loaded: true,
      loading: true,
      latestSeq: 42,
    }, true)).toBe(false);
    expect(shouldCatchUpLoadedYeaftSession({
      loaded: true,
      loading: false,
      latestSeq: null,
    }, true)).toBe(false);
  });
});
