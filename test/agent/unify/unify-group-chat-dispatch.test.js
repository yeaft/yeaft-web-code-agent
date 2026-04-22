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
    it('resolves roster/defaultVpId and intersects mentions', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/roster/);
      expect(block).toMatch(/defaultVpId/);
      expect(block).toMatch(/mentions\.filter/);
    });
    it('falls back to handleUnifyChat when no target resolvable', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/targets\.length\s*===\s*0/);
      expect(block).toMatch(/await\s+handleUnifyChat/);
    });
    it('emits `group_message` events tagged with vpId per target', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/type:\s*['"]group_message['"]/);
      expect(block).toMatch(/vpId/);
    });
    it('prepends @vp-<id> prefix on the per-target dispatched prompt', () => {
      const block = bridgeSrc.match(/export\s+async\s+function\s+handleUnifyGroupChat[\s\S]*?\n\}\s*\n/)[0];
      expect(block).toMatch(/@vp-/);
    });
    it('still defines the pre-existing handleUnifyChat export (not clobbered)', () => {
      expect(bridgeSrc).toMatch(/export\s+async\s+function\s+handleUnifyChat\s*\(/);
    });
  });
});
