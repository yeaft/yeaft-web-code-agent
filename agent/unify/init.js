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

/** Default config.json — generated on first init as default configuration. */
const DEFAULT_CONFIG_JSON = `{
  "providers": [
    {
      "name": "my-proxy",
      "baseUrl": "http://localhost:6628/v1",
      "apiKey": "proxy",
      "models": [
        "claude-sonnet-4-20250514",
        "claude-haiku-3-20250414",
        "gpt-5",
        "deepseek-chat"
      ]
    }
  ],
  "primaryModel": "my-proxy/claude-sonnet-4-20250514",
  "fastModel": "my-proxy/claude-sonnet-4-20250514",
  "language": "en",
  "debug": false,
  "maxContextTokens": 200000,
  "messageTokenBudget": 8192
}
`;

/** Default MEMORY.md content. */
const DEFAULT_MEMORY = `# Yeaft Memory

This file stores persistent memory entries. The agent will read and update this file.

## Facts

## Preferences

## Project Context

`;

/** Default mcp.json example — generated as reference for MCP server configuration. */
const DEFAULT_MCP_EXAMPLE = `{
  "_comment": "MCP server configuration. Rename to mcp.json to enable.",
  "_docs": "Each server needs 'name' + 'command'. Optional: 'args', 'env'.",
  "servers": [
    {
      "name": "example-github",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  ]
}
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
  // config.json — default configuration (user edits this directly)
  const configJsonPath = join(root, 'config.json');
  if (!existsSync(configJsonPath)) {
    writeFileSync(configJsonPath, DEFAULT_CONFIG_JSON, 'utf8');
    created.push(configJsonPath);
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

  // mcp.json.example — reference template for MCP server configuration
  const mcpExamplePath = join(root, 'mcp.json.example');
  if (!existsSync(mcpExamplePath)) {
    writeFileSync(mcpExamplePath, DEFAULT_MCP_EXAMPLE, 'utf8');
    created.push(mcpExamplePath);
  }

  return { dir: root, created };
}
