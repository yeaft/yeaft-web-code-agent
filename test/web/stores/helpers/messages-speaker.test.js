/**
 * Tests for VP speaker-attribution stamping in the message helpers.
 *
 * The bug this guards against:
 *   In Unify multi-VP fan-out, the standalone <vp-typing-row> renders
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
    currentView: 'unify',
    unifyConversationId: 'conv-1',
    unifyActiveGroupFilter: null,
    _currentUnifyGroupId: null,
    _currentUnifyVpId: null,
    _currentUnifyTurnId: null,
    messagesMap: { 'conv-1': [] },
    ...overrides,
  };
}

describe('appendToAssistantMessageForConversation: speakerVpId stamping', () => {
  it('stamps speakerVpId on a freshly-created streaming message when vpId routing context is set', () => {
    const store = mkStore({ _currentUnifyVpId: 'vp-jobs' });
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
      _currentUnifyVpId: 'vp-rams',
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
      _currentUnifyVpId: 'vp-jobs',
      _currentUnifyTurnId: 'turn-A',
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
      _currentUnifyVpId: 'vp-different',
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

  it('does NOT stamp when not in unify view', () => {
    const store = mkStore({
      currentView: 'chat',
      _currentUnifyVpId: 'vp-jobs',
      messagesMap: {
        'conv-1': [
          { id: 'm1', type: 'assistant', content: 'x', isStreaming: true },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'y');
    expect(store.messagesMap['conv-1'][0].speakerVpId).toBeUndefined();
    expect(store.messagesMap['conv-1'][0].vpId).toBeUndefined();
  });
});

describe('finishStreamingForConversation: defensive speaker stamp', () => {
  it('fills speakerVpId on the last streaming message at finalize time when missing', () => {
    const store = mkStore({
      _currentUnifyVpId: 'vp-jobs',
      _currentUnifyTurnId: 'turn-A',
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
      _currentUnifyVpId: 'vp-jobs',
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

  it('is a no-op when not in unify view', () => {
    const store = mkStore({
      currentView: 'chat',
      _currentUnifyVpId: 'vp-jobs',
      messagesMap: {
        'conv-1': [
          { id: 'm1', type: 'assistant', content: 'reply', isStreaming: true },
        ],
      },
    });
    finishStreamingForConversation(store, 'conv-1');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].isStreaming).toBe(false); // streaming flag still cleared
    expect(msgs[0].speakerVpId).toBeUndefined(); // but speaker not stamped
  });
});

describe('addMessageToConversation: speakerVpId on creation', () => {
  it('stamps speakerVpId on a brand-new assistant message in unify mode', () => {
    const store = mkStore({ _currentUnifyVpId: 'vp-jobs' });
    addMessageToConversation(store, 'conv-1', { type: 'assistant', content: 'hi' });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].vpId).toBe('vp-jobs');
    expect(msgs[0].speakerVpId).toBe('vp-jobs');
  });

  it('does NOT stamp speakerVpId on user messages (only on assistant)', () => {
    const store = mkStore({ _currentUnifyVpId: 'vp-jobs' });
    addMessageToConversation(store, 'conv-1', { type: 'user', content: 'hi' });
    const msgs = store.messagesMap['conv-1'];
    // speakerVpId is the speaker-attribution for assistant turns; users
    // don't have a "speaker" in that sense.
    expect(msgs[0].speakerVpId).toBeUndefined();
    // vpId itself IS stamped on every Unify message — it's the
    // routing/turn-context tag, not the speaker tag.
    expect(msgs[0].vpId).toBe('vp-jobs');
  });
});
