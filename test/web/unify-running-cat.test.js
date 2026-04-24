import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * task-346: Running-cat typing indicator must be visible when sending a
 * Unify message.
 *
 * Root cause: `showTypingDots = isProcessing && !hasStreamingMessage` flips
 * false → true → false across the pre-TTFB window. For low-latency LLM
 * providers (common in Unify, rare in Chat because the Claude CLI spawn
 * adds ≥300 ms), that window can be shorter than a single browser paint,
 * so the cat never renders.
 *
 * Fix (MessageList.js): latch ON instantly, defer latch-OFF to at least
 * `MIN_VISIBLE_MS` (600 ms) after the ON transition. This adds a scheduled
 * `setTimeout` to finalize the hide. The store data path is unchanged.
 *
 * These tests lock in:
 *  1) the store data path still correctly gates the cat (`isProcessing &&
 *     !hasStreamingMessage`)
 *  2) MessageList.js contains the MIN_VISIBLE_MS latch + timer
 *  3) the latch clears on unmount to avoid a leaked timer
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// =============================================================================
// 1. Store data path — replicates the essential sendUnifyChat flow
//    and asserts that showTypingDots evaluates true between send and first
//    text_delta, regardless of what else the bridge emits in between.
// =============================================================================
function createMiniStore() {
  const conv = 'unify-local-1';
  return {
    currentView: 'unify',
    activeConversations: [conv],
    currentConversation: conv,
    messagesMap: { [conv]: [] },
    processingConversations: {},
    unifyConversationId: conv,
    unifyActiveThreadFilter: null,
    get messages() { return this.messagesMap[this.currentConversation] || []; },
    get isProcessing() { return !!this.processingConversations[this.currentConversation]; },
    addMessage(msg) { this.messagesMap[this.currentConversation].push({ ...msg }); },
    appendStreamingText(text) {
      const msgs = this.messages;
      const last = msgs[msgs.length - 1];
      if (last && last.type === 'assistant' && last.isStreaming) {
        last.content += text;
      } else {
        msgs.push({ type: 'assistant', content: text, isStreaming: true });
      }
    },
    finishStreaming() {
      const msgs = this.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].isStreaming) msgs[i].isStreaming = false;
        if (msgs[i].type === 'user') break;
      }
    },
  };
}

function hasStreaming(store) { return store.messages.some(m => m.isStreaming); }
function showTypingDots(store) { return store.isProcessing && !hasStreaming(store); }

describe('task-346 store data path: showTypingDots during Unify pre-TTFB', () => {
  it('is true immediately after sendUnifyChat (user msg added, processing set, no assistant yet)', () => {
    const store = createMiniStore();
    // Simulate sendUnifyChat
    store.addMessage({ type: 'user', content: 'hi' });
    store.processingConversations[store.currentConversation] = true;

    expect(store.isProcessing).toBe(true);
    expect(hasStreaming(store)).toBe(false);
    expect(showTypingDots(store)).toBe(true);
  });

  it('flips to false as soon as first text_delta creates a streaming assistant message', () => {
    const store = createMiniStore();
    store.addMessage({ type: 'user', content: 'hi' });
    store.processingConversations[store.currentConversation] = true;
    expect(showTypingDots(store)).toBe(true);

    // First text_delta from engine
    store.appendStreamingText('Hello');
    expect(hasStreaming(store)).toBe(true);
    expect(showTypingDots(store)).toBe(false);
  });

  it('turn end: finishStreaming + processing:false → dots stay false', () => {
    const store = createMiniStore();
    store.addMessage({ type: 'user', content: 'hi' });
    store.processingConversations[store.currentConversation] = true;
    store.appendStreamingText('Hello');
    store.finishStreaming();
    delete store.processingConversations[store.currentConversation];

    expect(store.isProcessing).toBe(false);
    expect(hasStreaming(store)).toBe(false);
    expect(showTypingDots(store)).toBe(false);
  });
});

// =============================================================================
// 2. MessageList.js contains the min-visibility latch
// =============================================================================
describe('task-346 MessageList.js implements min-visibility latch', () => {
  const src = readFileSync(
    path.join(ROOT, 'web', 'components', 'MessageList.js'),
    'utf8'
  );

  it('declares MIN_VISIBLE_MS constant ≥ 500 ms (large enough for one paint cycle on any device)', () => {
    const m = src.match(/const\s+MIN_VISIBLE_MS\s*=\s*(\d+)\b/);
    expect(m, 'MIN_VISIBLE_MS constant must be declared').not.toBeNull();
    const value = parseInt(m[1], 10);
    expect(value).toBeGreaterThanOrEqual(500);
  });

  it('uses a latched `displayTypingDots` ref instead of passing `showTypingDots` straight to the template', () => {
    expect(src).toMatch(/displayTypingDots\s*=\s*Vue\.ref\(false\)/);
    // previewShowTypingDots now reads the latched ref, not the raw computed.
    expect(src).toMatch(/return\s+displayTypingDots\.value/);
  });

  it('schedules a setTimeout when show flips false to defer the hide', () => {
    expect(src).toMatch(/typingHideTimer\s*=\s*setTimeout\(/);
  });

  it('cancels any pending hide timer when show flips true again', () => {
    // The watch body must clearTimeout(typingHideTimer) at the top of the ON branch.
    expect(src).toMatch(/clearTimeout\(typingHideTimer\)/);
  });

  it('clears the hide timer on unmount to avoid a leaked timer', () => {
    // The onUnmounted block must also clear typingHideTimer.
    const unmountBlock = src.match(/Vue\.onUnmounted\(\(\)\s*=>\s*\{[\s\S]*?\}\);/);
    expect(unmountBlock, 'onUnmounted block must exist').not.toBeNull();
    expect(unmountBlock[0]).toMatch(/typingHideTimer/);
  });
});

// =============================================================================
// 3. Mode-agnostic — must NOT branch on Chat vs Unify.
//    A bug-fix this shallow should be identical for both.
// =============================================================================
describe('task-346 fix is mode-agnostic', () => {
  const src = readFileSync(
    path.join(ROOT, 'web', 'components', 'MessageList.js'),
    'utf8'
  );

  it('does not reference currentView inside the typing-dots latch', () => {
    // Extract the watch(showTypingDots, ...) block and verify it has no
    // `currentView` / 'unify' / 'chat' branches — the latch must apply
    // uniformly so Chat benefits from the same presentational minimum.
    const watchMatch = src.match(/Vue\.watch\(showTypingDots[\s\S]*?\},\s*\{\s*immediate:\s*true\s*\}\);/);
    expect(watchMatch, 'Vue.watch(showTypingDots, ...) block must exist').not.toBeNull();
    const block = watchMatch[0];
    expect(block).not.toMatch(/currentView/);
    expect(block).not.toMatch(/['"`]unify['"`]/);
  });
});
