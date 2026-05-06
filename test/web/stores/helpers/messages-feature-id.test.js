/**
 * Tests for PR-2 featureId stamping in the message helpers.
 *
 * Track A & the feature-arc emit `feature_started` with a featureId; the
 * store handler latches it onto `_currentUnifyFeatureId` for the duration
 * of the in-flight envelope. Streaming chunks that arrive while the latch
 * is set must be tagged with featureId so MessageList.turnGroups can fold
 * them under the right feature pill.
 *
 * What's tested:
 *   1. addMessageToConversation stamps featureId from the routing context
 *      onto every Unify message (assistant / tool-use / chat-image / user).
 *   2. The stamp is idempotent — never overwrites an existing featureId.
 *   3. The stamp only fires inside the active Unify conversation; chat-mode
 *      conversations are untouched.
 *   4. appendToAssistantMessageForConversation defensively re-stamps a
 *      streaming message that was created before the latch arrived.
 */
import { describe, it, expect } from 'vitest';
import {
  addMessageToConversation,
  appendToAssistantMessageForConversation,
} from '../../../../web/stores/helpers/messages.js';

function mkStore(overrides = {}) {
  return {
    currentView: 'unify',
    unifyConversationId: 'conv-1',
    unifyActiveGroupFilter: null,
    _currentUnifyGroupId: null,
    _currentUnifyVpId: null,
    _currentUnifyTurnId: null,
    _currentUnifyFeatureId: null,
    messagesMap: { 'conv-1': [] },
    ...overrides,
  };
}

describe('addMessageToConversation: featureId stamping (PR-2)', () => {
  it('stamps featureId on a brand-new assistant message in unify mode', () => {
    const store = mkStore({
      _currentUnifyVpId: 'vp-jobs',
      _currentUnifyFeatureId: 'feat-build-thing',
    });
    addMessageToConversation(store, 'conv-1', { type: 'assistant', content: 'hi' });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].featureId).toBe('feat-build-thing');
  });

  it('stamps featureId on a tool-use message', () => {
    const store = mkStore({
      _currentUnifyVpId: 'vp-jobs',
      _currentUnifyFeatureId: 'feat-build-thing',
    });
    addMessageToConversation(store, 'conv-1', {
      type: 'tool-use', toolName: 'Bash', toolInput: { command: 'ls' },
    });
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].featureId).toBe('feat-build-thing');
  });

  it('stamps featureId on a user message (so the user row anchors to the feature too)', () => {
    // The user message is the trigger for the feature; tagging it lets the
    // sidebar / detail view link "this user prompt → this feature" without
    // a parallel index.
    const store = mkStore({ _currentUnifyFeatureId: 'feat-1' });
    addMessageToConversation(store, 'conv-1', { type: 'user', content: 'go' });
    expect(store.messagesMap['conv-1'][0].featureId).toBe('feat-1');
  });

  it('does NOT overwrite a pre-existing featureId on the message (idempotent)', () => {
    const store = mkStore({ _currentUnifyFeatureId: 'feat-from-context' });
    addMessageToConversation(store, 'conv-1', {
      type: 'assistant', content: 'hi', featureId: 'feat-explicit',
    });
    expect(store.messagesMap['conv-1'][0].featureId).toBe('feat-explicit');
  });

  it('leaves featureId undefined when the routing context has no feature in flight', () => {
    const store = mkStore({ _currentUnifyVpId: 'vp-jobs' });  // featureId stays null
    addMessageToConversation(store, 'conv-1', { type: 'assistant', content: 'hi' });
    expect(store.messagesMap['conv-1'][0].featureId).toBeUndefined();
  });

  it('does NOT stamp featureId when not in the active unify conversation', () => {
    const store = mkStore({
      currentView: 'chat',
      _currentUnifyFeatureId: 'feat-leak',
    });
    addMessageToConversation(store, 'conv-1', { type: 'assistant', content: 'hi' });
    expect(store.messagesMap['conv-1'][0].featureId).toBeUndefined();
  });
});

describe('appendToAssistantMessageForConversation: featureId stamping (PR-2)', () => {
  it('stamps featureId on a freshly-created streaming message', () => {
    const store = mkStore({
      _currentUnifyVpId: 'vp-jobs',
      _currentUnifyFeatureId: 'feat-A',
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'hello');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].featureId).toBe('feat-A');
  });

  it('defensively stamps featureId on an already-existing streaming message that lacks it', () => {
    // Simulates a chunk that arrived before feature_started was emitted —
    // the message exists, but featureId was never set. Once the latch
    // arrives, the next delta must back-fill the field so MessageList can
    // recognise the turn as part of the feature run.
    const store = mkStore({
      _currentUnifyVpId: 'vp-jobs',
      _currentUnifyFeatureId: 'feat-late-arrival',
      messagesMap: {
        'conv-1': [
          { id: 'm1', type: 'assistant', content: 'partial', isStreaming: true, vpId: 'vp-jobs', speakerVpId: 'vp-jobs' },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'conv-1', ' more');
    const msgs = store.messagesMap['conv-1'];
    expect(msgs[0].content).toBe('partial more');
    expect(msgs[0].featureId).toBe('feat-late-arrival');
  });

  it('does NOT overwrite an existing featureId on a streaming message', () => {
    const store = mkStore({
      _currentUnifyVpId: 'vp-jobs',
      _currentUnifyFeatureId: 'feat-B',  // routing context says B
      messagesMap: {
        'conv-1': [
          {
            id: 'm1', type: 'assistant', content: 'x',
            isStreaming: true, vpId: 'vp-jobs', speakerVpId: 'vp-jobs',
            featureId: 'feat-A',  // but the message is already in feature A
          },
        ],
      },
    });
    appendToAssistantMessageForConversation(store, 'conv-1', 'y');
    expect(store.messagesMap['conv-1'][0].featureId).toBe('feat-A');
  });
});
