export const personTurn = (seq = 1, overrides = {}) => ({
  id: `turn-${seq}`, seq, kind: 'send', status: 'completed', createdAt: '2026-10-09T10:00:00Z',
  budget: { calls: 16 }, models: ['test/first', 'test/second'],
  usage: { inputTokens: 120, outputTokens: 30, reasoningTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0,
    inputTotalTokens: 140, totalTokens: 170, reportedCalls: 2, missingCalls: 0, complete: true },
  calls: [
    { callId: `call-${seq}-1`, index: 1, status: 'completed', requested: { model: 'test/first', effort: null }, dispatched: { model: 'test/first' }, effective: { model: null, effort: null },
      selectionOrigin: 'bootstrap', reason: 'configured-default', contextBytes: 2000, contextBudgetBytes: 32000, outputTokensReserved: 4096,
      capability: { id: 'Recall', status: 'completed' }, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 0, inputTotalTokens: 120, totalTokens: 140, complete: true } },
    { callId: `call-${seq}-2`, index: 2, status: 'completed', requested: { model: 'test/second', effort: 'low' }, dispatched: { model: 'test/second' }, effective: { model: null, effort: 'low' },
      selectionOrigin: 'person', reason: 'Check recalled evidence', contextBytes: 3000, contextBudgetBytes: 32000, outputTokensReserved: 4096,
      usage: { inputTokens: 20, outputTokens: 10, reasoningTokens: 10, totalTokens: 30, complete: true } },
  ], ...overrides,
});
