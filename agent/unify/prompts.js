/**
 * prompts.js — Bilingual system prompt templates
 *
 * Single source of truth for system prompts. Both engine.js and cli.js
 * import buildSystemPrompt() from here. Supports 'en' and 'zh'.
 *
 * To add a new language: add a new key to PROMPTS with all required fields.
 */

// ─── Prompt Templates ─────────────────────────────────────────

const PROMPTS = {
  en: {
    identity: 'You are Yeaft, a helpful AI assistant.',
    mode: (mode) => `Current mode: ${mode}`,
    date: (d) => `Date: ${d}`,
    work: 'You are in work mode. Break tasks into steps, execute them using tools, and report progress.',
    dream: 'You are in dream mode. Reflect on past conversations and consolidate memories.',
    tools: (names) => `Available tools: ${names}`,
  },
  zh: {
    identity: '你是 Yeaft，一个有用的 AI 助手。',
    mode: (mode) => `当前模式：${mode}`,
    date: (d) => `日期：${d}`,
    work: '你处于工作模式。将任务分解为步骤，使用工具执行，并报告进度。',
    dream: '你处于梦境模式。回顾过去的对话，整理和巩固记忆。',
    tools: (names) => `可用工具：${names}`,
  },
};

/** Supported language codes. */
export const SUPPORTED_LANGUAGES = Object.keys(PROMPTS);

/**
 * Build the system prompt for a given language and mode.
 *
 * @param {{ language?: string, mode?: string, toolNames?: string[] }} params
 * @returns {string}
 */
export function buildSystemPrompt({ language = 'en', mode = 'chat', toolNames = [] } = {}) {
  // Fallback to English for unknown languages
  const lang = PROMPTS[language] || PROMPTS.en;

  const parts = [
    lang.identity,
    lang.mode(mode),
    lang.date(new Date().toISOString().split('T')[0]),
  ];

  if (mode === 'work') {
    parts.push(lang.work);
  } else if (mode === 'dream') {
    parts.push(lang.dream);
  }

  if (toolNames.length > 0) {
    parts.push(lang.tools(toolNames.join(', ')));
  }

  return parts.join('\n\n');
}
