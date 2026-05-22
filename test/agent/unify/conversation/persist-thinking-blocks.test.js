/**
 * task-327d: persist round-trip for assistant.thinkingBlocks (Anthropic
 * extended-thinking echo-back). Each thinking block carries a server-signed
 * `signature` HMAC that MUST be replayed verbatim on the next request, so
 * the persisted form has to be byte-exact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ConversationStore,
  parseMessage,
} from '../../../../agent/unify/conversation/persist.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-thinking-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true }); });

describe('task-327d: thinkingBlocks persistence round-trip', () => {
  it('serializes + parses a single thinking block byte-exact', () => {
    const store = new ConversationStore(TEST_DIR);
    const original = {
      role: 'assistant',
      content: 'final answer',
      thinkingBlocks: [
        { thinking: 'let me think about this — multi-line\nand UTF-8 你好 🤔', signature: 'sig-abc123==' },
      ],
    };
    const written = store.append(original);
    const raw = readFileSync(join(TEST_DIR, 'conversation', 'messages', `${written.id}.md`), 'utf8');
    expect(raw).toContain('thinkingBlocks:');
    expect(raw).toContain('thinkingB64:');
    expect(raw).toContain('signatureB64:');
    // Raw signature should NOT appear plaintext — it's base64'd.
    expect(raw).not.toContain('sig-abc123==');

    const parsed = parseMessage(raw);
    expect(parsed.thinkingBlocks).toEqual(original.thinkingBlocks);
    expect(parsed.content).toBe('final answer');
  });

  it('round-trips multiple thinking blocks in order', () => {
    const store = new ConversationStore(TEST_DIR);
    const blocks = [
      { thinking: 'first thought', signature: 'sig-1' },
      { thinking: 'second thought with\nnewline', signature: 'sig-2-with-=padding==' },
      { thinking: 'third', signature: 'sig-3' },
    ];
    const written = store.append({ role: 'assistant', content: 'ok', thinkingBlocks: blocks });
    const raw = readFileSync(join(TEST_DIR, 'conversation', 'messages', `${written.id}.md`), 'utf8');
    const parsed = parseMessage(raw);
    expect(parsed.thinkingBlocks).toEqual(blocks);
  });

  it('drops blocks missing signature on parse (would 400 on replay)', () => {
    // Construct a frontmatter that has a signature-less block; parser must skip it.
    const raw = `---
id: m0099
role: assistant
time: 2026-05-22T00:00:00Z
tokens_est: 1
thinkingBlocks:
  - thinkingB64: ${Buffer.from('orphan thought', 'utf8').toString('base64')}
    signatureB64: ${Buffer.from('', 'utf8').toString('base64')}
---

hi`;
    const parsed = parseMessage(raw);
    expect(parsed.thinkingBlocks).toBeUndefined();
  });

  it('messages without thinkingBlocks serialize without the field', () => {
    const store = new ConversationStore(TEST_DIR);
    const written = store.append({ role: 'assistant', content: 'plain reply' });
    const raw = readFileSync(join(TEST_DIR, 'conversation', 'messages', `${written.id}.md`), 'utf8');
    expect(raw).not.toContain('thinkingBlocks:');
    const parsed = parseMessage(raw);
    expect(parsed.thinkingBlocks).toBeUndefined();
  });
});
