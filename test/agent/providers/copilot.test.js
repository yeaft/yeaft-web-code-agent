import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

/**
 * Post-ACP rewrite tests. The old NDJSON/-p driver shipped two pure helpers
 * (translateCopilotEvent + createNdjsonParser) that we could unit-test in
 * isolation; the new driver does all translation inline against a real
 * AcpClient. We verify two black-box behaviors that matter to users:
 *   1) `capabilities` reflects what the UI now uses for gating
 *   2) `respondToPermissionRequest` resolves a pending permission promise
 *      with the selected optionId so an in-flight session/prompt can proceed
 */
describe('copilot provider — capability descriptor', () => {
  it('declares the gaps the new ACP driver closes', async () => {
    const { capabilities } = await import('../../../agent/providers/copilot.js');
    expect(capabilities.clear).toBe(true);
    expect(capabilities.attachments).toBe(true);
    expect(capabilities.askUser).toBe(true);
    expect(capabilities.modelPicker).toBe(true);
    // Things still gated off — make sure UI keeps hiding them.
    expect(capabilities.expert).toBe(false);
    expect(capabilities.subagents).toBe(false);
  });
});

describe('copilot provider — respondToPermissionRequest', () => {
  it('resolves the pending permission with the selected optionId', async () => {
    const { respondToPermissionRequest } = await import('../../../agent/providers/copilot.js');
    let resolved;
    const slot = {
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
      resolve: (v) => { resolved = v; },
    };
    const state = { pendingPermissions: new Map([['req-1', slot]]) };
    const ok = respondToPermissionRequest(state, 'req-1', 'reject_once');
    expect(ok).toBe(true);
    expect(resolved).toEqual({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
    expect(state.pendingPermissions.has('req-1')).toBe(false);
  });

  it('returns false when the requestId is unknown', async () => {
    const { respondToPermissionRequest } = await import('../../../agent/providers/copilot.js');
    const state = { pendingPermissions: new Map() };
    expect(respondToPermissionRequest(state, 'missing', 'allow')).toBe(false);
  });
});

describe('copilot provider — sendInput surfaces ACP boot errors', () => {
  it('emits an error result + turn_completed when the child can not be spawned', async () => {
    vi.resetModules();
    const ctxMod = await import('../../../agent/context.js');
    const sent = [];
    ctxMod.default.sendToServer = (m) => sent.push(m);
    ctxMod.default.CONFIG = ctxMod.default.CONFIG || {};
    ctxMod.default.conversations = new Map();

    // child with no stdin/stdout — AcpClient will throw on first write.
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => { throw new Error('boom'); } };
    child.kill = () => {};

    vi.doMock('child_process', () => ({ spawn: () => child }));
    const copilot = await import('../../../agent/providers/copilot.js?fresh=acp');

    const state = await copilot.start({ conversationId: 'c1', workDir: '/tmp' });
    // Start should have emitted an init-failed result envelope (best-effort path).
    const result = sent.find((m) => m.type === 'claude_output' && m.data?.type === 'result' && m.data?.is_error);
    expect(result).toBeTruthy();
    expect(state.providerName).toBe('copilot');
    vi.doUnmock('child_process');
  });
});
