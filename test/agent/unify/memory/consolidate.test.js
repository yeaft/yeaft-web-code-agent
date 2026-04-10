import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { shouldConsolidate, partitionMessages, consolidate, DEFAULT_MESSAGE_TOKEN_BUDGET, COMPACT_KEEP_RATIO } from '../../../../agent/unify/memory/consolidate.js';
import { ConversationStore, estimateTokens } from '../../../../agent/unify/conversation/persist.js';
import { MemoryStore } from '../../../../agent/unify/memory/store.js';

const TEST_DIR = join(tmpdir(), `yeaft-test-consolidate-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ─── shouldConsolidate ──────────────────────────────────────────

describe('shouldConsolidate', () => {
  it('should return false when under budget', () => {
    const store = new ConversationStore(TEST_DIR);
    store.append({ role: 'user', content: 'Hello' });
    expect(shouldConsolidate(store, 8192)).toBe(false);
  });

  it('should return true when over budget', () => {
    const store = new ConversationStore(TEST_DIR);
    // Each 'a'.repeat(100) is ~25 tokens. We need > 8192 tokens.
    // 8192 * 4 = 32768 chars needed, so ~330 messages of 100 chars each
    // Let's use bigger messages
    for (let i = 0; i < 40; i++) {
      store.append({ role: 'user', content: 'a'.repeat(1000) }); // ~250 tokens each
    }
    // 40 * 250 = 10000 tokens > 8192
    expect(shouldConsolidate(store, 8192)).toBe(true);
  });
});

// ─── partitionMessages ──────────────────────────────────────────

describe('partitionMessages', () => {
  it('should keep at least 3 messages', () => {
    const messages = [
      { id: 'm0001', tokens_est: 100, content: 'A' },
      { id: 'm0002', tokens_est: 100, content: 'B' },
      { id: 'm0003', tokens_est: 100, content: 'C' },
    ];
    const { toArchive, toKeep } = partitionMessages(messages, 100);
    expect(toKeep.length).toBeGreaterThanOrEqual(3);
    expect(toArchive).toHaveLength(0);
  });

  it('should not archive when total under budget', () => {
    const messages = [
      { id: 'm0001', tokens_est: 100, content: 'A' },
      { id: 'm0002', tokens_est: 100, content: 'B' },
      { id: 'm0003', tokens_est: 100, content: 'C' },
      { id: 'm0004', tokens_est: 100, content: 'D' },
    ];
    // Budget is huge → keep all
    const { toArchive, toKeep } = partitionMessages(messages, 100000);
    expect(toArchive).toHaveLength(0);
    expect(toKeep).toHaveLength(4);
  });

  it('should archive old messages to meet budget * 40%', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `m${String(i + 1).padStart(4, '0')}`,
      tokens_est: 500,
      content: `Message ${i + 1}`,
    }));
    // Total = 20 * 500 = 10000 tokens. Budget = 8192. Keep = 3276.
    // Need to archive until remaining ≤ 3276. So keep ≤ 6 messages.
    const { toArchive, toKeep } = partitionMessages(messages, 8192);
    expect(toArchive.length).toBeGreaterThan(0);
    expect(toKeep.length).toBeGreaterThanOrEqual(3);
    // Kept messages should be the newest
    expect(toKeep[toKeep.length - 1].id).toBe('m0020');
  });
});

// ─── consolidate (with mock LLM) ───────────────────────────────

describe('consolidate', () => {
  let conversationStore;
  let memoryStore;

  const mockAdapter = {
    call: async ({ system, messages }) => {
      const prompt = messages[0]?.content || '';
      const sysPrompt = system || '';
      // Summarization request
      if (sysPrompt.includes('summarizer') || prompt.includes('Summarize')) {
        return { text: 'Summary of the conversation about TypeScript and auth bugs.', usage: { inputTokens: 100, outputTokens: 50 } };
      }
      // Memory extraction request
      if (sysPrompt.includes('memory extraction') || prompt.includes('extract') || prompt.includes('Analyze')) {
        return {
          text: JSON.stringify([
            { name: 'user-likes-ts', kind: 'preference', scope: 'global', tags: ['typescript'], importance: 'normal', content: 'User prefers TypeScript' },
          ]),
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      }
      // Default: return empty array for unknown requests
      return { text: '[]', usage: { inputTokens: 10, outputTokens: 10 } };
    },
  };

  const mockConfig = { model: 'test-model' };

  beforeEach(() => {
    conversationStore = new ConversationStore(TEST_DIR);
    memoryStore = new MemoryStore(TEST_DIR);
  });

  it('should do nothing when few messages', async () => {
    conversationStore.append({ role: 'user', content: 'Hello' });

    const result = await consolidate({
      conversationStore,
      memoryStore,
      adapter: mockAdapter,
      config: mockConfig,
      budget: 8192,
    });

    expect(result.archivedCount).toBe(0);
    expect(result.extractedEntries).toHaveLength(0);
  });

  it('should archive old messages and produce summary', async () => {
    // Create enough messages to trigger consolidation
    for (let i = 0; i < 20; i++) {
      conversationStore.append({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'a'.repeat(500) });
    }

    const hotBefore = conversationStore.countHot();
    const coldBefore = conversationStore.countCold();

    const result = await consolidate({
      conversationStore,
      memoryStore,
      adapter: mockAdapter,
      config: mockConfig,
      budget: 2000, // low budget to force more archiving
    });

    expect(result.archivedCount).toBeGreaterThan(0);
    expect(conversationStore.countHot()).toBeLessThan(hotBefore);
    expect(conversationStore.countCold()).toBeGreaterThan(coldBefore);
    expect(result.compactSummary).toBeTruthy();
  });

  it('should write compact summary to compact.md', async () => {
    for (let i = 0; i < 10; i++) {
      conversationStore.append({ role: 'user', content: 'a'.repeat(500) });
    }

    await consolidate({
      conversationStore,
      memoryStore,
      adapter: mockAdapter,
      config: mockConfig,
      budget: 1000,
    });

    const summary = conversationStore.readCompactSummary();
    expect(summary).toBeTruthy();
  });

  it('should extract memory entries', async () => {
    // Need enough tokens to exceed budget. Each message ~250 tokens.
    for (let i = 0; i < 10; i++) {
      conversationStore.append({ role: 'user', content: 'a'.repeat(1000) });
    }

    const result = await consolidate({
      conversationStore,
      memoryStore,
      adapter: mockAdapter,
      config: mockConfig,
      budget: 500, // low budget to force archiving
    });

    expect(result.archivedCount).toBeGreaterThan(0);
    expect(result.extractedEntries.length).toBeGreaterThan(0);
    // Memory store should have entries
    expect(memoryStore.listEntries().length).toBeGreaterThan(0);
  });
});
