/**
 * Regression: `buildSummaryPrompt` + `wrapSummaryAsUserMessage` +
 * `compactHistory` honor the `language` option.
 *
 * Pre-fix the helpers ALWAYS produced English (the system prompt,
 * the "Summarize:" preamble, and the "session continued from a previous
 * conversation" wrapper were string literals). That meant a Chinese-
 * locale Unify session — even after `update_llm_config` flipped the
 * agent to zh — would re-inject English context every time history
 * was compacted, breaking the locale-consistency contract.
 *
 * Fix: thread `{ language }` from `Compactor` (which reads live
 * `config.language` via `getLanguage`) through `compactHistory` into
 * both helpers. They flip wording when the language starts with `zh`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSummaryPrompt,
  wrapSummaryAsUserMessage,
} from '../../../../agent/unify/history-compact.js';

describe('history-compact language threading', () => {
  describe('buildSummaryPrompt', () => {
    it('emits English when language is omitted', () => {
      const { system, prompt } = buildSummaryPrompt([
        { role: 'user', content: 'hi' },
      ]);
      expect(system).toMatch(/conversation summarizer/i);
      expect(prompt).toMatch(/^Summarize the following conversation/);
    });

    it('emits English when language is en', () => {
      const { system, prompt } = buildSummaryPrompt(
        [{ role: 'user', content: 'hi' }],
        { language: 'en' }
      );
      expect(system).toMatch(/conversation summarizer/i);
      expect(prompt).toMatch(/^Summarize the following conversation/);
    });

    it('emits Chinese when language is zh', () => {
      const { system, prompt } = buildSummaryPrompt(
        [{ role: 'user', content: 'hi' }],
        { language: 'zh' }
      );
      expect(system).toMatch(/对话摘要器/);
      expect(prompt).toMatch(/^请概括下面的对话/);
    });

    it('emits Chinese when language is zh-CN (covers locale tags)', () => {
      const { system } = buildSummaryPrompt(
        [{ role: 'user', content: 'hi' }],
        { language: 'zh-CN' }
      );
      expect(system).toMatch(/对话摘要器/);
    });
  });

  describe('wrapSummaryAsUserMessage', () => {
    it('emits English wrapper by default', () => {
      const msg = wrapSummaryAsUserMessage('bullet points');
      expect(msg.role).toBe('user');
      expect(msg._compactSummary).toBe(true);
      expect(msg.content).toMatch(/This session is being continued/);
    });

    it('emits Chinese wrapper when language is zh', () => {
      const msg = wrapSummaryAsUserMessage('要点', { language: 'zh' });
      expect(msg.role).toBe('user');
      expect(msg._compactSummary).toBe(true);
      expect(msg.content).toMatch(/本会话延续自之前的对话/);
      expect(msg.content).toMatch(/要点/);
    });

    it('handles zh-CN locale tag', () => {
      const msg = wrapSummaryAsUserMessage('summary', { language: 'zh-CN' });
      expect(msg.content).toMatch(/本会话延续自之前的对话/);
    });
  });
});
