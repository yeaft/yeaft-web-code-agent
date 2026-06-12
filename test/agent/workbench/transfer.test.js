import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, existsSync } from 'fs';

/**
 * Regression test for fix-copilot-attachment-send-routing.
 *
 * Bug: agent/workbench/transfer.js `handleTransferFiles` (the handler for
 * sending a message WITH an attachment) unconditionally called
 * `startClaudeQuery()`. A copilot conversation that sent an image was thus
 * misrouted to `claude --resume <stale-id>` and returned
 * error_during_execution instantly ("一发送就挂了").
 *
 * Fix: route non-claude providers through `driver.sendInput`, mirroring
 * conversation.js `handleUserInput`. Images are handed to the driver as
 * inline attachments (copilot accepts image bytes over ACP).
 */

let tmpWork;

function freshCtx() {
  const sent = [];
  return {
    sent,
    default: {
      conversations: new Map(),
      CONFIG: { workDir: tmpWork, debug: false },
      sendToServer: (m) => sent.push(m),
    },
  };
}

const IMAGE_FILE = { name: 'shot.png', mimeType: 'image/png', data: Buffer.from('fakepng').toString('base64') };
const TEXT_FILE = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') };

beforeEach(() => {
  tmpWork = mkdtempSync(join(tmpdir(), 'transfer-test-'));
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../../agent/context.js');
  vi.doUnmock('../../../agent/providers/index.js');
  vi.doUnmock('../../../agent/conversation.js');
  vi.doUnmock('../../../agent/claude.js');
  if (tmpWork && existsSync(tmpWork)) rmSync(tmpWork, { recursive: true, force: true });
});

async function loadTransferWith({ providerName, hasExistingState = true }) {
  vi.resetModules();

  const ctxStub = freshCtx();
  vi.doMock('../../../agent/context.js', () => ({ default: ctxStub.default }));

  // Fake non-claude driver: records sendInput calls.
  const sendInputCalls = [];
  const fakeDriver = {
    capabilities: { clear: true },
    start: vi.fn(async (opts) => {
      const st = { providerName, conversationId: opts.conversationId, workDir: opts.workDir, sessionId: 'sess-1' };
      ctxStub.default.conversations.set(opts.conversationId, st);
      return st;
    }),
    sendInput: vi.fn(async (state, prompt, opts) => { sendInputCalls.push({ state, prompt, opts }); }),
  };
  vi.doMock('../../../agent/providers/index.js', () => ({
    DEFAULT_PROVIDER: 'claude-code',
    getProvider: (name) => {
      if (name === 'claude-code') throw new Error('getProvider(claude-code) should not be called for non-claude routing');
      return fakeDriver;
    },
  }));

  const outputs = [];
  vi.doMock('../../../agent/conversation.js', () => ({
    sendOutput: (conversationId, data) => outputs.push({ conversationId, data }),
    sendConversationList: () => {},
  }));

  // Spy startClaudeQuery — must NOT be called for non-claude providers.
  const startClaudeQuery = vi.fn(async (conversationId, workDir) => {
    const st = { providerName: 'claude-code', conversationId, workDir, query: {}, inputStream: { enqueue: vi.fn() } };
    ctxStub.default.conversations.set(conversationId, st);
    return st;
  });
  vi.doMock('../../../agent/claude.js', () => ({ startClaudeQuery }));

  if (hasExistingState && providerName) {
    ctxStub.default.conversations.set('conv-1', {
      providerName,
      conversationId: 'conv-1',
      workDir: tmpWork,
      sessionId: 'sess-1',
      // copilot has no query/inputStream — that's the whole point.
    });
  }

  const mod = await import('../../../agent/workbench/transfer.js');
  return { handleTransferFiles: mod.handleTransferFiles, fakeDriver, sendInputCalls, startClaudeQuery, outputs, ctxStub };
}

describe('handleTransferFiles — provider routing', () => {
  it('routes a copilot conversation through driver.sendInput, NOT startClaudeQuery', async () => {
    const { handleTransferFiles, fakeDriver, sendInputCalls, startClaudeQuery } =
      await loadTransferWith({ providerName: 'copilot' });

    await handleTransferFiles({
      conversationId: 'conv-1',
      files: [IMAGE_FILE],
      prompt: '看看这张图',
      workDir: tmpWork,
    });

    // The bug was: startClaudeQuery spawned for copilot. Must be zero now.
    expect(startClaudeQuery).not.toHaveBeenCalled();
    expect(fakeDriver.sendInput).toHaveBeenCalledTimes(1);

    // Image must be forwarded as an inline attachment in copilot's wire shape.
    const { prompt, opts } = sendInputCalls[0];
    expect(opts.attachments).toEqual([{ type: 'image', data: IMAGE_FILE.data, mimeType: 'image/png' }]);
    // Pure-image send: prompt is the raw user text, no path preamble.
    expect(prompt).toBe('看看这张图');
  });

  it('references non-image files by saved path in the prompt for copilot', async () => {
    const { handleTransferFiles, sendInputCalls } =
      await loadTransferWith({ providerName: 'copilot' });

    await handleTransferFiles({
      conversationId: 'conv-1',
      files: [TEXT_FILE],
      prompt: '总结这个文件',
      workDir: tmpWork,
    });

    const { prompt, opts } = sendInputCalls[0];
    expect(opts.attachments).toEqual([]); // non-image not inlined
    expect(prompt).toContain('总结这个文件');
    expect(prompt).toContain('.claude-tmp-attachments/notes_'); // saved path referenced
    expect(prompt).toContain('text/plain');
  });

  it('lazy-starts the driver when no conversation state exists yet (copilot)', async () => {
    const { handleTransferFiles, fakeDriver, startClaudeQuery } =
      await loadTransferWith({ providerName: 'copilot', hasExistingState: false });
    // No state in ctx → falls back to DEFAULT_PROVIDER 'claude-code', which is
    // the correct behavior when we genuinely don't know the provider.
    await handleTransferFiles({ conversationId: 'conv-unknown', files: [IMAGE_FILE], prompt: 'x', workDir: tmpWork });
    // With no state, providerName resolves to claude-code → claude path.
    expect(startClaudeQuery).toHaveBeenCalledTimes(1);
    expect(fakeDriver.sendInput).not.toHaveBeenCalled();
  });

  it('still routes claude-code attachment sends through startClaudeQuery (regression guard)', async () => {
    const { handleTransferFiles, fakeDriver, startClaudeQuery, ctxStub } =
      await loadTransferWith({ providerName: 'claude-code' });

    await handleTransferFiles({
      conversationId: 'conv-1',
      files: [IMAGE_FILE],
      prompt: 'hi',
      workDir: tmpWork,
    });

    expect(startClaudeQuery).toHaveBeenCalledTimes(1);
    expect(fakeDriver.sendInput).not.toHaveBeenCalled();
    // The claude path enqueues the assembled multimodal message.
    const st = ctxStub.default.conversations.get('conv-1');
    expect(st.inputStream.enqueue).toHaveBeenCalledTimes(1);
  });

  it('surfaces a driver.sendInput failure as an error result for copilot', async () => {
    const { handleTransferFiles, fakeDriver, outputs } =
      await loadTransferWith({ providerName: 'copilot' });
    fakeDriver.sendInput.mockRejectedValueOnce(new Error('acp boom'));

    await handleTransferFiles({ conversationId: 'conv-1', files: [IMAGE_FILE], prompt: 'x', workDir: tmpWork });

    const errResult = outputs.find(o => o.data?.type === 'result' && o.data?.is_error);
    expect(errResult).toBeTruthy();
    expect(errResult.data.error).toContain('copilot error: acp boom');
  });
});
