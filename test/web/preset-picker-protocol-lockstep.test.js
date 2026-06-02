/**
 * Lockstep test: the picker's `pickProtocolForModelId` MUST agree with
 * the router's `inferProtocolFromModelId` for every id we throw at it.
 *
 * Why: the two functions are intentionally byte-identical because the
 * picker (browser) and the router (node) can't share a module under the
 * current static-serving setup. This test is the tripwire that catches
 * the drift the next time someone adds a model family to one side and
 * forgets the other.
 */
import { describe, it, expect } from 'vitest';
import { inferProtocolFromModelId } from '../../agent/yeaft/llm/router.js';
import { pickProtocolForModelId } from '../../web/components/ProviderPresetPicker.js';

const CORPUS = [
  // anthropic family
  'claude-sonnet-4-20250514',
  'claude-opus-4',
  'claude-haiku-3',
  'anthropic.claude-3-haiku',
  'bedrock/claude-3-opus',
  // openai-responses family
  'gpt-5',
  'gpt-4o-mini',
  'gpt-4.1',
  'o1-preview',
  'o3-mini',
  'o4-anything',
  'chatgpt-5',
  'codex-mini',
  'omni-1',
  // unknown — both must return null
  'deepseek-chat',
  'llama-3-70b',
  'mistral-large',
  'grok-2',
  '',
  null,
];

describe('picker ↔ router protocol-inference lockstep', () => {
  for (const id of CORPUS) {
    it(`agrees on ${JSON.stringify(id)}`, () => {
      expect(pickProtocolForModelId(id)).toBe(inferProtocolFromModelId(id));
    });
  }
});
