/**
 * prompts.js — Bilingual system prompt templates
 *
 * Single source of truth for system prompts. Both engine.js and cli.js
 * import buildSystemPrompt() from here. Supports 'en' and 'zh'.
 *
 * Phase 2 additions:
 *   - Memory section (user profile + recalled entries)
 *   - Compact summary section (conversation history summary)
 *
 * Reference: yeaft-unify-system-prompt-budget.md — Static + Dynamic + Context layers
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
    memoryHeader: '## User Memory',
    profileHeader: '### User Profile',
    recalledHeader: '### Recalled Memories',
    compactHeader: '## Conversation History Summary',
  },
  zh: {
    identity: '你是 Yeaft，一个有用的 AI 助手。',
    mode: (mode) => `当前模式：${mode}`,
    date: (d) => `日期：${d}`,
    work: '你处于工作模式。将任务分解为步骤，使用工具执行，并报告进度。',
    dream: '你处于梦境模式。回顾过去的对话，整理和巩固记忆。',
    tools: (names) => `可用工具：${names}`,
    memoryHeader: '## 用户记忆',
    profileHeader: '### 用户画像',
    recalledHeader: '### 相关记忆',
    compactHeader: '## 对话历史摘要',
  },
};

/** Supported language codes. */
export const SUPPORTED_LANGUAGES = Object.keys(PROMPTS);

/**
 * Build the system prompt for a given language and mode.
 *
 * @param {{
 *   language?: string,
 *   mode?: string,
 *   toolNames?: string[],
 *   memory?: { profile?: string, entries?: object[] },
 *   compactSummary?: string
 * }} params
 * @returns {string}
 */
export function buildSystemPrompt({
  language = 'en',
  mode = 'chat',
  toolNames = [],
  memory,
  compactSummary,
  skillContent,
} = {}) {
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

  // ─── Skills Section ─────────────────────────────────────
  if (skillContent) {
    parts.push(skillContent);
  }

  // ─── Memory Section ─────────────────────────────────────
  if (memory && (memory.profile || (memory.entries && memory.entries.length > 0))) {
    const memoryParts = [lang.memoryHeader];

    if (memory.profile) {
      memoryParts.push(`${lang.profileHeader}\n${memory.profile}`);
    }

    if (memory.entries && memory.entries.length > 0) {
      const entryLines = memory.entries.map(e => {
        const tags = (e.tags && e.tags.length > 0) ? ` [${e.tags.join(', ')}]` : '';
        return `- **${e.name}** (${e.kind}): ${e.content}${tags}`;
      });
      memoryParts.push(`${lang.recalledHeader}\n${entryLines.join('\n')}`);
    }

    parts.push(memoryParts.join('\n\n'));
  }

  // ─── Compact Summary Section ────────────────────────────
  if (compactSummary) {
    parts.push(`${lang.compactHeader}\n${compactSummary}`);
  }

  return parts.join('\n\n');
}
