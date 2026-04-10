/**
 * init.js — Yeaft directory structure initialization
 *
 * Ensures ~/.yeaft/ and all required subdirectories exist.
 * Creates default config.md, MEMORY.md, and conversation/index.md if missing.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Default directory for Yeaft data. */
export const DEFAULT_YEAFT_DIR = join(homedir(), '.yeaft');

/** Subdirectories that must exist inside the Yeaft data directory. */
const SUBDIRS = [
  'conversation/messages',
  'conversation/cold',
  'conversation/blobs',
  'memory/entries',
  'tasks',
  'dream',
  'skills',
];

/** Default config.md content (YAML frontmatter + markdown body). */
const DEFAULT_CONFIG = `---
model: claude-sonnet-4-20250514
debug: false
maxContextTokens: 200000
---

# Yeaft Config

Edit the YAML frontmatter above to change settings.
The \`model\` field is a model ID (e.g. \`gpt-5\`, \`claude-sonnet-4-20250514\`).
Yeaft auto-detects the correct API adapter and endpoint from the model ID.

## Model IDs

- \`claude-sonnet-4-20250514\` (default)
- \`claude-opus-4-20250514\`
- \`gpt-5\`, \`gpt-5.4\`, \`gpt-4.1\`, \`gpt-4.1-mini\`
- \`o3\`, \`o4-mini\`
- \`deepseek-chat\`, \`deepseek-reasoner\`
- \`gemini-2.5-pro\`, \`gemini-2.5-flash\`

## API Keys

Store API keys in \`~/.yeaft/.env\` (recommended) or export as env vars:

\`\`\`bash
# ~/.yeaft/.env
YEAFT_API_KEY=sk-ant-...          # Anthropic
YEAFT_OPENAI_API_KEY=sk-...       # OpenAI / DeepSeek / Gemini
\`\`\`

## Environment Variables

Shell env vars take precedence over .env and config.md:

- \`YEAFT_MODEL\` — override model ID
- \`YEAFT_API_KEY\` — Anthropic API key
- \`YEAFT_OPENAI_API_KEY\` — OpenAI-compatible API key
- \`YEAFT_PROXY_URL\` — CopilotProxy URL (default: http://localhost:6628)
- \`YEAFT_DEBUG\` — enable debug mode (1/true)
- \`YEAFT_DIR\` — data directory (default: ~/.yeaft)
`;

/** Default MEMORY.md content. */
const DEFAULT_MEMORY = `# Yeaft Memory

This file stores persistent memory entries. The agent will read and update this file.

## Facts

## Preferences

## Project Context

`;

/** Default conversation/index.md content. */
const DEFAULT_CONVERSATION_INDEX = `---
lastMessageId: null
totalMessages: 0
---

# Conversation Index

This file tracks the conversation state for the "one eternal conversation" model.
`;

/**
 * Initialize the Yeaft data directory structure.
 *
 * @param {string} [dir] — Root directory path. Defaults to ~/.yeaft/
 * @returns {{ dir: string, created: string[] }} — The root dir and list of created paths
 */
export function initYeaftDir(dir) {
  const root = dir || DEFAULT_YEAFT_DIR;
  const created = [];

  // Ensure root exists
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
    created.push(root);
  }

  // Ensure all subdirectories exist
  for (const sub of SUBDIRS) {
    const fullPath = join(root, sub);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      created.push(fullPath);
    }
  }

  // Create default files if they don't exist
  const configPath = join(root, 'config.md');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_CONFIG, 'utf8');
    created.push(configPath);
  }

  const memoryPath = join(root, 'memory', 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, DEFAULT_MEMORY, 'utf8');
    created.push(memoryPath);
  }

  const indexPath = join(root, 'conversation', 'index.md');
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, DEFAULT_CONVERSATION_INDEX, 'utf8');
    created.push(indexPath);
  }

  return { dir: root, created };
}
