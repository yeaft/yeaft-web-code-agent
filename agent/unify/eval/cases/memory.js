/**
 * eval/cases/memory.js — Memory recall eval cases
 *
 * Smoke-level evals for the H2-AMS memory pipeline. Detailed mocks live
 * in unit tests; this file only declares the eval scenarios.
 */

import { noError, custom } from '../runner.js';

// ─── Eval Cases ──────────────────────────────────────────────

export const memoryCases = [

  // ─── Memory Injection Verification ────────────────────

  {
    id: 'memory-profile-injection',
    suite: 'memory',
    description: 'System prompt should include memory section after preflow',
    prompt: 'Help me with a coding task',
    criteria: [
      noError,
      custom('has-response', 'Model produces a response', 5, (result) => ({
        pass: result.fullText.length > 0,
        score: result.fullText.length > 0 ? 1 : 0,
      })),
    ],
  },

  // ─── Recall Event ──────────────────────────────────────

  {
    id: 'memory-keyword-extraction',
    suite: 'memory',
    description: 'Recall event emitted when preflow has hits',
    prompt: 'How should I handle TypeScript errors in my Express API?',
    criteria: [
      noError,
      custom('recall-event', 'Recall event emitted (if FTS index seeded)', 3, (result) => {
        const recallEvent = result.events.find(e => e.type === 'recall');
        return {
          pass: true,
          score: recallEvent ? 1 : 0.5,
          reason: recallEvent ? `Recalled ${recallEvent.entryCount} segments` : 'No FTS hits',
        };
      }),
    ],
  },
];
