/**
 * task-338-F4 — Unify input routing to GroupCoordinator.
 *
 * Source-scan tests verifying:
 *   1. ChatInput.js uses groupsStore and sends `unify_group_chat` when
 *      currentView === 'unify' and activeGroupId is set.
 *   2. chat.js exposes `sendUnifyGroupChat` action that emits the right WS
 *      payload shape.
 *   3. message-router.js imports and wires the new handler case.
 *   4. web-bridge.js exports `handleUnifyGroupChat` that:
 *        - emits `group_message` events tagged with `vpId`
 *        - falls back to default VP when no mentions
 *        - falls back to `handleUnifyChat` when no target resolvable
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const chatInputSrc = readFileSync(path.join(ROOT, 'web/components/ChatInput.js'), 'utf8');
const chatStoreSrc = readFileSync(path.join(ROOT, 'web/stores/chat.js'), 'utf8');
const routerSrc    = readFileSync(path.join(ROOT, 'agent/connection/message-router.js'), 'utf8');
const bridgeSrc    = readFileSync(path.join(ROOT, 'agent/unify/web-bridge.js'), 'utf8');

describe('task-338-F4: Unify group-chat routing', () => {
  describe('ChatInput.js → emits unify_group_chat', () => {
    it('resolves a groupsStore via Pinia.useGroupsStore', () => {
      expect(chatInputSrc).toMatch(/Pinia\.useGroupsStore/);
    });
    it('branches on store.currentView === "unify" && activeGroupId', () => {
      expect(chatInputSrc).toMatch(/store\.currentView\s*===\s*['"]unify['"]/);
      expect(chatInputSrc).toMatch(/activeGroupId/);
    });
    it('dispatches via store.sendUnifyGroupChat', () => {
      expect(chatInputSrc).toMatch(/store\.sendUnifyGroupChat\s*\(/);
    });
  });

  describe('chat.js → sendUnifyGroupChat action', () => {
    it('defines sendUnifyGroupChat', () => {
      expect(chatStoreSrc).toMatch(/sendUnifyGroupChat\s*\(\s*\{\s*groupId\s*,\s*text\s*,\s*mentions\s*\}\s*\)/);
    });
    it('emits a unify_group_chat WS message with groupId/text/mentions', () => {
      const block = chatStoreSrc.match(/sendUnifyGroupChat[\s\S]*?\n    \},/);
      expect(block, 'sendUnifyGroupChat block').not.toBeNull();
      expect(block[0]).toMatch(/type:\s*['"]unify_group_chat['"]/);
      expect(block[0]).toMatch(/groupId/);
      expect(block[0]).toMatch(/text/);
      expect(block[0]).toMatch(/mentions/);
    });
    it('returns early when groupId or text is missing (fallback safety)', () => {
      const block = chatStoreSrc.match(/sendUnifyGroupChat[\s\S]*?\n    \},/)[0];
      expect(block).toMatch(/if\s*\(\s*!groupId\s*\|\|\s*!text/);
    });
  });

  describe('message-router.js → unify_group_chat case', () => {
    it('imports handleUnifyGroupChat from web-bridge.js', () => {
      expect(routerSrc).toMatch(/handleUnifyGroupChat/);
    });
    it('has a case "unify_group_chat"', () => {
      expect(routerSrc).toMatch(/case\s+['"]unify_group_chat['"]/);
      expect(routerSrc).toMatch(/await\s+handleUnifyGroupChat\s*\(\s*msg\s*\)/);
    });
  });

  describe('web-bridge.js → handleUnifyGroupChat', () => {
    it('exports the handler as an async function', () => {
      expect(bridgeSrc).toMatch(/export\s+async\s+function\s+handleUnifyGroupChat\s*\(/);
    });
    it('reads groupId/text/mentions from the inbound msg', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/);
      expect(block, 'handleUnifyGroupChat block').not.toBeNull();
      expect(block[0]).toMatch(/groupId/);
      expect(block[0]).toMatch(/text/);
      expect(block[0]).toMatch(/mentions/);
    });
    it('delegates target resolution to createCoordinator (adapter layer)', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/createCoordinator\s*\(/);
      expect(block).toMatch(/coord\.ingest\s*\(/);
    });
    it('feeds payload mentions into coord.ingest via input.meta (no re-parse from text)', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      // Adapter must NOT call parseMentions on the text itself — the
      // source of truth is the payload's `mentions` field (ChatInput has
      // already parsed once on the frontend).
      expect(block).not.toMatch(/parseMentions\s*\(\s*text\s*\)/);
      expect(block).toMatch(/meta:\s*\{\s*mentions\s*\}/);
    });
    it('takes legacy fallback path #1 when payload has no groupId', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/if\s*\(\s*!groupId\s*\)/);
    });
    it('takes legacy fallback path #2 when coordinator reports no dispatch', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      // dispatched.length === 0 && !report.fallback → legacy
      expect(block).toMatch(/dispatchedIds\.length\s*===\s*0/);
      expect(block).toMatch(/report\?\.fallback/);
      expect(block).toMatch(/await\s+handleUnifyChat/);
    });
    it('emits `group_message` tagged with vpId + speakerVpId per dispatched target', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/type:\s*['"]group_message['"]/);
      expect(block).toMatch(/speakerVpId/);
    });
    it('prepends @vp-<id> prefix on the per-target dispatched prompt', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/@vp-/);
    });
    it('still defines the pre-existing handleUnifyChat export (not clobbered)', () => {
      expect(bridgeSrc).toMatch(/export\s+async\s+function\s+handleUnifyChat\s*\(/);
    });
  });

  describe('coordinator (agent/unify/groups/coordinator.js) left untouched', () => {
    // PM red-line: "不要改 coordinator 来迎合 — 在 web-bridge 里做 adapter 层".
    // Guard that web-bridge does the adapting and coordinator source still
    // exports the exact factory + parseMentions we rely on.
    const coordSrc = readFileSync(path.join(ROOT, 'agent/unify/groups/coordinator.js'), 'utf8');
    it('still exports createCoordinator factory', () => {
      expect(coordSrc).toMatch(/export\s+function\s+createCoordinator\s*\(/);
    });
    it('still exports parseMentions', () => {
      expect(coordSrc).toMatch(/export\s+function\s+parseMentions\s*\(/);
    });
  });
});
