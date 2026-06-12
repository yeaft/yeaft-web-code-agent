/**
 * Tests for VP speaker-attribution stamping in the message helpers.
 *
 * The bug this guards against:
 *   In Yeaft multi-VP fan-out, the standalone <vp-typing-row> renders
 *   VpSpeakerHeader while a VP is streaming, so the avatar is visible in
 *   that interim. When `vp_typing_end` fires, the standalone row goes
 *   away and AssistantTurn is supposed to take over with its OWN
 *   VpSpeakerHeader — gated on `turn.speakerVpId`, latched from the
 *   first assistant message in the turn that has the field.
 *
 *   If the streaming message never got `speakerVpId` (e.g. a code path
 *   created the message before the routing context was set), the avatar
 *   silently disappears the moment streaming ends — the speaker is
 *   "unattributed". This was Bug B in the user report.
 *
 * Fix: appendToAssistantMessageForConversation and
 * finishStreamingForConversation idempotently re-stamp vpId / turnId /
 * speakerVpId from the routing context onto the existing streaming
 * message. So even if the message was minted blank, the latched speaker
 * is filled in before AssistantTurn picks it up.
 */
import { describe, it, expect } from 'vitest';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
  finishStreamingForConversation,
} from '../../../../web/stores/helpers/messages.js';

function mkStore(overrides = {}) {
  return {
    currentView: 'yeaft',
    yeaftConversationId: 'conv-1',
    yeaftActiveSessionFilter: null,
    _currentYeaftSessionId: null,
    _currentYeaftVpId: null,
    _currentYeaftTurnId: null,
    messagesMap: { 'conv-1': [] },
    ...overrides,
  };
}

describe('appendToAssistantMessageForConversation: speakerVpId stamping', () => {
  it('stamps speakerVpId on a freshly-created streaming message when vpId routing context is set', () => {
    const store = mkStore({ _currentYeaftVpId: 'vp-jobs' });
    appendToAssistantMessageForConversation(store, 'conv-1', 'hello');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('assistant');
    expect(msgs[0].isStreaming).toBe(true);
    expect(msgs[0].vpId).toBe('vp-jobs');
    expect(msgs[0].speakerVpId).toBe('vp-jobs');
  });

  it('stamps speakerVpId on an already-existing streaming message that lacks it (defensive fill)', () => {
    // Simulate a streaming message that was created before the routing
    // context was set — so it has no vpId / speakerVpId.
    const store = mkStore({
      _currentYeaftVpId: 'vp-rams',
      messagesMap: {
        'conv-1': [
          { id: 'm1', type: 'assistant', content: 'partial', isStreaming: true },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'conv-1', ' more');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('partial more');
    expect(msgs[0].vpId).toBe('vp-rams');
    expect(msgs[0].speakerVpId).toBe('vp-rams');
  });

  it('routes by turnId when active and stamps the matching streaming message', () => {
    const store = mkStore({
      _currentYeaftVpId: 'vp-jobs',
      _currentYeaftTurnId: 'turn-A',
      messagesMap: {
        'conv-1': [
          // A different turn's streaming message — must NOT receive this delta.
          {
            id: 'm1', type: 'assistant', content: 'bobs words',
            isStreaming: true, turnId: 'turn-B', vpId: 'vp-bob',
            speakerVpId: 'vp-bob',
          },
          {
            id: 'm2', type: 'assistant', content: 'jobs words',
            isStreaming: true, turnId: 'turn-A',
          },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'conv-1', '!');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].content).toBe('bobs words'); // untouched
    expect(msgs[1].content).toBe('jobs words!');
    expect(msgs[1].vpId).toBe('vp-jobs');
    expect(msgs[1].speakerVpId).toBe('vp-jobs');
  });

  it('does NOT overwrite a pre-existing speakerVpId (idempotent)', () => {
    const store = mkStore({
      _currentYeaftVpId: 'vp-different',
      messagesMap: {
        'conv-1': [
          {
            id: 'm1', type: 'assistant', content: 'x',
            isStreaming: true, vpId: 'vp-original',
            speakerVpId: 'vp-original',
          },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'y');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].speakerVpId).toBe('vp-original');
    expect(msgs[0].vpId).toBe('vp-original');
  });

  it('STAMPS even when currentView is chat, as long as conversationId is the yeaft conv', () => {
    // Regression: previously the stamper gated on `currentView === "yeaft"`,
    // so messages that arrived while the user was on the Chat view (Yeaft
    // VP turn still running in the background) landed without vpId /
    // speakerVpId. AssistantTurn then rendered without an avatar, and the
    // groupId stamper (same predicate) left them filterable-out. UI froze
    // on switch-back. The contract is "is this the yeaft conversation
    // id?" — view is presentation, not data.
    const store = mkStore({
      currentView: 'chat',
      _currentYeaftVpId: 'vp-jobs',
      messagesMap: {
        'conv-1': [
          { id: 'm1', type: 'assistant', content: 'x', isStreaming: true },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'y');
    expect(store.messagesMap['conv-1'][0].speakerVpId).toBe('vp-jobs');
    expect(store.messagesMap['conv-1'][0].vpId).toBe('vp-jobs');
  });

  it('does NOT stamp when conversationId is a different (non-yeaft) conversation', () => {
    // Cross-conversation isolation. yeaftConversationId is conv-1, but the
    // append is targeting a chat conversation chat-A — the routing context
    // should not leak across.
    const store = mkStore({
      currentView: 'chat',
      yeaftConversationId: 'conv-1',
      _currentYeaftVpId: 'vp-jobs',
      messagesMap: {
        'chat-A': [
          { id: 'm1', type: 'assistant', content: 'x', isStreaming: true },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'chat-A', 'y');
    expect(store.messagesMap['chat-A'][0].speakerVpId).toBeUndefined();
    expect(store.messagesMap['chat-A'][0].vpId).toBeUndefined();
  });
});

describe('finishStreamingForConversation: defensive speaker stamp', () => {
  it('fills speakerVpId on the last streaming message at finalize time when missing', () => {
    const store = mkStore({
      _currentYeaftVpId: 'vp-jobs',
      _currentYeaftTurnId: 'turn-A',
      messagesMap: {
        'conv-1': [
          { id: 'u1', type: 'user', content: 'hi' },
          { id: 'm1', type: 'assistant', content: 'reply', isStreaming: true },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[1].isStreaming).toBe(false);
    expect(msgs[1].vpId).toBe('vp-jobs');
    expect(msgs[1].speakerVpId).toBe('vp-jobs');
    expect(msgs[1].turnId).toBe('turn-A');
  });

  it('stops at the last user message when scanning back', () => {
    const store = mkStore({
      _currentYeaftVpId: 'vp-jobs',
      messagesMap: {
        'conv-1': [
          // Older turn — must not be touched.
          { id: 'm0', type: 'assistant', content: 'old', isStreaming: false },
          { id: 'u1', type: 'user', content: 'hi' },
          { id: 'm1', type: 'assistant', content: 'new', isStreaming: true },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[2].isStreaming).toBe(false);
    expect(msgs[2].speakerVpId).toBe('vp-jobs');
    // Older message was not retroactively stamped.
    expect(msgs[0].speakerVpId).toBeUndefined();
  });

  it('STAMPS even when currentView is chat, as long as conversationId is the yeaft conv', () => {
    // Same view-vs-conversation contract as appendToAssistantMessageForConversation.
    // A VP turn that finishes streaming while the user is on Chat must still
    // get speakerVpId stamped — otherwise switching back shows an
    // unattributed assistant message.
    const store = mkStore({
      currentView: 'chat',
      _currentYeaftVpId: 'vp-jobs',
      messagesMap: {
        'conv-1': [
          { id: 'm1', type: 'assistant', content: 'reply', isStreaming: true },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].isStreaming).toBe(false);
    expect(msgs[0].speakerVpId).toBe('vp-jobs');
  });

  it('does NOT stamp when conversationId is a different (non-yeaft) conversation', () => {
    const store = mkStore({
      currentView: 'chat',
      yeaftConversationId: 'conv-1',
      _currentYeaftVpId: 'vp-jobs',
      messagesMap: {
        'chat-A': [
          { id: 'm1', type: 'assistant', content: 'reply', isStreaming: true },
        ],
      },
    });
    finishStreamingForConversation(store, 'chat-A');
    const msgs = store.messagesMap['chat-A'];
    expect(msgs[0].isStreaming).toBe(false); // streaming flag still cleared
    expect(msgs[0].speakerVpId).toBeUndefined(); // but speaker not stamped
  });
});

describe('addMessageToConversation: speakerVpId on creation', () => {
  it('stamps speakerVpId on a brand-new assistant message in yeaft mode', () => {
    const store = mkStore({ _currentYeaftVpId: 'vp-jobs' });
    addMessageToConversation(store, 'conv-1', { type: 'assistant', content: 'hi' });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].vpId).toBe('vp-jobs');
    expect(msgs[0].speakerVpId).toBe('vp-jobs');
  });

  it('does NOT stamp speakerVpId on user messages (only on assistant / tool-use)', () => {
    const store = mkStore({ _currentYeaftVpId: 'vp-jobs' });
    addMessageToConversation(store, 'conv-1', { type: 'user', content: 'hi' });
    const msgs = store.messagesMap['conv-1'];
    // speakerVpId is the speaker-attribution for assistant turns; users
    // don't have a "speaker" in that sense.
    expect(msgs[0].speakerVpId).toBeUndefined();
    // vpId itself IS stamped on every Yeaft message — it's the
    // routing/turn-context tag, not the speaker tag.
    expect(msgs[0].vpId).toBe('vp-jobs');
  });

  // task-vp-header-pos regression: when a VP's reply opens with a tool_call
  // (no preceding text_delta), the FIRST message in the turn is a tool-use.
  // If this message lacks speakerVpId on persist, reload-from-history will
  // render the tool block with no avatar above it. Keep speakerVpId in sync
  // with assistant messages so the turn header always has data to latch.
  it('stamps speakerVpId on a brand-new tool-use message in yeaft mode', () => {
    const store = mkStore({
      _currentYeaftVpId: 'vp-jobs',
      _currentYeaftTurnId: 'turn-A',
    });
    addMessageToConversation(store, 'conv-1', {
      type: 'tool-use',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].type).toBe('tool-use');
    expect(msgs[0].vpId).toBe('vp-jobs');
    expect(msgs[0].speakerVpId).toBe('vp-jobs');
    expect(msgs[0].turnId).toBe('turn-A');
  });
});
