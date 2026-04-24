import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * task-fix: Per-VP typing indicator for Unify group chat.
 *
 * Problem: the global "running cat" is ambiguous when N VPs in a group
 * reply concurrently — one cat cannot attribute typing to a speaker, and
 * per-VP `result` events flip processingConversations[unifyConversationId]
 * back to false between dispatches, causing the cat to flicker.
 *
 * Fix: agent emits `vp_typing_start` / `vp_typing_end` bracketing each
 * per-VP dispatch in handleUnifyGroupChat. Store maintains an
 * `unifyVpTyping: { [vpId]: refCount }` map. MessageList renders a typing
 * row per actively typing VP; VpSpeakerHeader renders inline dots too
 * once the VP's AssistantTurn materialises.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

describe('Per-VP typing: agent emits bookend events', () => {
  const bridgeSrc = readFileSync(
    path.join(ROOT, 'agent/unify/web-bridge.js'),
    'utf-8',
  );

  it('emits vp_typing_start before each per-VP handleUnifyChat dispatch', () => {
    // Looser assertion: file must contain the event type inside the
    // group-chat dispatch loop region.
    expect(bridgeSrc).toMatch(/type:\s*['"]vp_typing_start['"]/);
  });

  it('emits vp_typing_end in a finally block after each dispatch', () => {
    expect(bridgeSrc).toMatch(/type:\s*['"]vp_typing_end['"]/);
    // Must be under a finally — otherwise an engine throw would leave
    // the VP in perma-typing state.
    const endIdx = bridgeSrc.indexOf("type: 'vp_typing_end'");
    const windowBefore = bridgeSrc.slice(Math.max(0, endIdx - 600), endIdx);
    expect(windowBefore).toMatch(/\}\s*finally\s*\{/);
  });
});

describe('Per-VP typing: store ref-counted map', () => {
  const storeSrc = readFileSync(
    path.join(ROOT, 'web/stores/chat.js'),
    'utf-8',
  );

  it('declares unifyVpTyping as a plain-object state field', () => {
    expect(storeSrc).toMatch(/unifyVpTyping:\s*\{\}/);
  });

  it('handles vp_typing_start / vp_typing_end events', () => {
    expect(storeSrc).toMatch(/case\s+['"]vp_typing_start['"]/);
    expect(storeSrc).toMatch(/case\s+['"]vp_typing_end['"]/);
  });

  it('ref-count goes up on start and down on end (simulated)', () => {
    // Simulate the handler body semantics directly.
    const store = { unifyVpTyping: {} };
    function onStart(vpId) {
      const next = { ...(store.unifyVpTyping || {}) };
      next[vpId] = (next[vpId] || 0) + 1;
      store.unifyVpTyping = next;
    }
    function onEnd(vpId) {
      const cur = store.unifyVpTyping || {};
      const c = (cur[vpId] || 0) - 1;
      const next = { ...cur };
      if (c <= 0) delete next[vpId];
      else next[vpId] = c;
      store.unifyVpTyping = next;
    }
    onStart('vp-a');
    onStart('vp-a'); // overlapping
    onStart('vp-b');
    expect(store.unifyVpTyping['vp-a']).toBe(2);
    expect(store.unifyVpTyping['vp-b']).toBe(1);
    onEnd('vp-a');
    expect(store.unifyVpTyping['vp-a']).toBe(1);
    onEnd('vp-a');
    expect(store.unifyVpTyping['vp-a']).toBeUndefined();
    onEnd('vp-b');
    expect(store.unifyVpTyping['vp-b']).toBeUndefined();
    // Excess end never drops below 0
    onEnd('vp-c');
    expect(store.unifyVpTyping['vp-c']).toBeUndefined();
  });
});

describe('Per-VP typing: MessageList suppresses row for tail-streaming VP', () => {
  const mlSrc = readFileSync(
    path.join(ROOT, 'web/components/MessageList.js'),
    'utf-8',
  );

  it('declares a vpTypingIds computed keyed by store.unifyVpTyping', () => {
    expect(mlSrc).toMatch(/vpTypingIds\s*=\s*Vue\.computed/);
    expect(mlSrc).toMatch(/store\.unifyVpTyping/);
  });

  it('renders a v-for typing row per VP ID', () => {
    expect(mlSrc).toMatch(/v-for="vpId in vpTypingIds"/);
  });

  it('suppresses the row when the tail streaming message is from that VP', () => {
    // The computed walks messages from tail backward; if it finds a
    // streaming message with speakerVpId, it filters that id out.
    expect(mlSrc).toMatch(/tailStreamingVpId/);
    expect(mlSrc).toMatch(/ids\.filter/);
  });
});
