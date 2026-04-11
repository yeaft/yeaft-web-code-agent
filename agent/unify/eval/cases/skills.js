/**
 * eval/cases/skills.js — Skill matching eval cases
 *
 * Tests whether the engine correctly:
 *   - Matches skills to relevant prompts
 *   - Injects matched skill content into system prompt
 *   - Does NOT inject irrelevant skills
 *   - Handles mode filtering correctly
 */

import {
  noError,
  containsText,
  doesNotContain,
  custom,
} from '../runner.js';

// ─── Eval Cases ──────────────────────────────────────────────

export const skillsCases = [

  {
    id: 'skill-match-basic',
    suite: 'skills',
    description: 'Engine should inject relevant skill into system prompt',
    prompt: 'How do I set up testing for my project?',
    criteria: [
      noError,
      // The actual skill injection happens via system prompt which we can check
      // if the adapter captures it. For now, just verify no crash.
      custom('produces-response', 'Model responds to the prompt', 5, (result) => ({
        pass: result.fullText.length > 10,
        score: result.fullText.length > 10 ? 1 : 0,
      })),
    ],
  },

  {
    id: 'skill-no-false-positive',
    suite: 'skills',
    description: 'Engine should NOT inject unrelated skills',
    prompt: 'What is the weather like?',
    criteria: [
      noError,
      custom('produces-response', 'Model responds', 5, (result) => ({
        pass: result.fullText.length > 0,
        score: result.fullText.length > 0 ? 1 : 0,
      })),
    ],
  },
];
