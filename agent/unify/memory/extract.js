/**
 * extract.js — Extract memory-worthy entries from conversation
 *
 * Called by consolidate.js during the Consolidate lifecycle.
 * Uses a single LLM call to identify facts, preferences, skills,
 * lessons, contexts, and relations from conversation messages.
 *
 * Reference: yeaft-unify-core-systems.md §3.1, yeaft-unify-design.md §6.1
 */

import { MEMORY_KINDS } from './store.js';
import { pickEffort } from '../effort.js';

/**
 * Build the extraction prompt.
 * @param {object[]} messages — conversation messages to analyze
 * @returns {string}
 */
function buildExtractionPrompt(messages) {
  const conversation = messages.map(m => {
    const prefix = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
    return `[${prefix}]: ${m.content}`;
  }).join('\n\n');

  return `Analyze the following conversation and extract any memorable information worth saving to long-term memory.

For each memory, provide:
- **name**: A short slug-friendly name (e.g., "user-prefers-typescript", "project-uses-vue3")
- **kind**: One of: ${MEMORY_KINDS.join(', ')}
- **scope**: A tree path (e.g., "global", "tech/typescript", "work/project-name")
- **tags**: Relevant keywords as an array
- **importance**: "high", "normal", or "low"
- **content**: 1-3 sentences describing the memory

Memory kinds explained:
- fact: Objective facts (project structure, tech stack)
- preference: User preferences (coding style, tools)
- skill: How to do something (patterns, techniques)
- lesson: Lessons learned (bugs, pitfalls)
- context: Temporal context (current OKR, progress)
- relation: People and relationships (teammates, roles)

Do NOT extract:
- Specific code snippets (too large, will become stale)
- Temporary debugging information
- Trivial greetings or small talk

Return a JSON array of memory objects. If nothing is worth remembering, return an empty array [].

Conversation:
${conversation}`;
}

/**
 * Extract memory entries from a set of conversation messages.
 *
 * @param {{ messages: object[], adapter: object, config: object }} params
 * @returns {Promise<object[]>} — extracted memory entries
 */
export async function extractMemories({ messages, adapter, config }) {
  if (!messages || messages.length === 0) return [];

  const system = 'You are a memory extraction assistant. Analyze conversations and extract important facts, preferences, and lessons. Return ONLY a valid JSON array, no other text.';

  const extractionPrompt = buildExtractionPrompt(messages);

  try {
    const result = await adapter.call({
      model: config.model,
      system,
      messages: [{ role: 'user', content: extractionPrompt }],
      maxTokens: 2048,
      // task-327c: extract runs inside the consolidate pipeline — the
      // JSON-structured output benefits from the same 'max' thinking tier.
      effort: pickEffort({ scenario: 'consolidate' }),
    });

    const text = result.text.trim();

    // Try to parse JSON array from the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const entries = JSON.parse(jsonMatch[0]);

    // Validate and normalize entries
    return entries
      .filter(e => e && typeof e === 'object' && e.name && e.content)
      .map(e => ({
        name: String(e.name).slice(0, 80),
        kind: MEMORY_KINDS.includes(e.kind) ? e.kind : 'fact',
        scope: String(e.scope || 'global'),
        tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
        importance: ['high', 'normal', 'low'].includes(e.importance) ? e.importance : 'normal',
        content: String(e.content),
      }));
  } catch {
    // LLM failure — return empty (non-critical operation)
    return [];
  }
}
