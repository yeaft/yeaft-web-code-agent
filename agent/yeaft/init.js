/**
 * init.js — Yeaft directory structure initialization
 *
 * Ensures ~/.yeaft/ and all required subdirectories exist.
 * Creates default config.md, MEMORY.md, and chat/index.md if missing.
 */

import { existsSync, mkdirSync, writeFileSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
// NOTE: migrateSessionsV1 is called at the end of initYeaftDir() to collapse
// any legacy groups/ + chats/ + memory/{group,chat}/ data into the unified
// sessions/ layout. Idempotent via sentinel file.
import { migrateSessionsV1 } from './migrate/sessions-v1.js';

/**
 * Check if an error is a permission error (EACCES or EPERM).
 * @param {Error} err
 * @returns {boolean}
 */
export function isPermissionError(err) {
  return err?.code === 'EACCES' || err?.code === 'EPERM';
}

/**
 * Try to write a file, catching permission errors gracefully.
 * @param {string} filePath
 * @param {string} content
 * @param {string[]} warnings — array to push warning messages into
 */
function safeWriteFile(filePath, content, warnings) {
  try {
    writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o644 });
  } catch (err) {
    if (isPermissionError(err)) {
      warnings.push(`Cannot write ${filePath}: ${err.code}`);
    } else {
      throw err;
    }
  }
}

/**
 * Try to create a directory, catching permission errors gracefully.
 * @param {string} dirPath
 * @param {string[]} warnings — array to push warning messages into
 * @returns {boolean} — true if directory exists (created or already existed)
 */
function safeMkdir(dirPath, warnings) {
  try {
    mkdirSync(dirPath, { recursive: true, mode: 0o755 });
    return true;
  } catch (err) {
    if (isPermissionError(err)) {
      warnings.push(`Cannot create directory ${dirPath}: ${err.code}`);
      return existsSync(dirPath);
    }
    throw err;
  }
}

/**
 * Check if a directory is writable.
 * @param {string} dirPath
 * @returns {boolean}
 */
export function isWritable(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Default directory for Yeaft data. */
export const DEFAULT_YEAFT_DIR = join(homedir(), '.yeaft');

/** Subdirectories that must exist inside the Yeaft data directory. */
const SUBDIRS = [
  'chat/messages',
  'chat/cold',
  'chat/blobs',
  'groups',
  'sessions',
  'memory/entries',
  'tasks',
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
  "messageTokenBudget": 32768
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

This file tracks one Yeaft message-history mode.
`;

/**
 * Initialize the Yeaft data directory structure.
 *
 * @param {string} [dir] — Root directory path. Defaults to ~/.yeaft/
 * @returns {{ dir: string, created: string[], writable: boolean, warnings: string[] }} — The root dir, list of created paths, writability status, and any warnings
 */
export function initYeaftDir(dir) {
  const root = dir || DEFAULT_YEAFT_DIR;
  const created = [];
  const warnings = [];

  // Ensure root exists
  if (!existsSync(root)) {
    if (safeMkdir(root, warnings)) {
      created.push(root);
    }
  }

  // Check if root is writable early — if not, skip file creation
  const writable = isWritable(root);
  if (!writable) {
    warnings.push(`Directory ${root} is not writable — session will run in read-only mode`);
    return { dir: root, created, writable, warnings };
  }

  // Ensure all subdirectories exist
  for (const sub of SUBDIRS) {
    const fullPath = join(root, sub);
    if (!existsSync(fullPath)) {
      if (safeMkdir(fullPath, warnings)) {
        created.push(fullPath);
      }
    }
  }

  // Create default files if they don't exist
  // config.json — default configuration (user edits this directly)
  const configJsonPath = join(root, 'config.json');
  if (!existsSync(configJsonPath)) {
    safeWriteFile(configJsonPath, DEFAULT_CONFIG_JSON, warnings);
    created.push(configJsonPath);
  }

  const memoryPath = join(root, 'memory', 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    safeWriteFile(memoryPath, DEFAULT_MEMORY, warnings);
    created.push(memoryPath);
  }

  const chatIndexPath = join(root, 'chat', 'index.md');
  if (!existsSync(chatIndexPath)) {
    safeWriteFile(chatIndexPath, DEFAULT_CONVERSATION_INDEX, warnings);
    created.push(chatIndexPath);
  }

  // mcp.json.example — reference template for MCP server configuration
  const mcpExamplePath = join(root, 'mcp.json.example');
  if (!existsSync(mcpExamplePath)) {
    safeWriteFile(mcpExamplePath, DEFAULT_MCP_EXAMPLE, warnings);
    created.push(mcpExamplePath);
  }

  // NOTE: sessions-v1 migration (collapse groups/ + chats/ → sessions/) is
  // intentionally NOT wired here yet — Phase 1 ships the session-store +
  // migration script + scope vocab as foundation only. Activating the
  // migration before the runtime reads from sessions/ would move data out
  // from under the live group/chat code paths. Phase 2 flips the runtime
  // and then hooks `migrateSessionsV1(root)` here.

  // NOTE: sessions-v1 migration runs at end. Fire-and-log: keep
  // initYeaftDir() sync so existing callers don't break. The migration is
  // idempotent (sentinel file) so a partial run on crash is safe.
  Promise.resolve()
    .then(() => migrateSessionsV1(root))
    .then((res) => {
      if (res && res.migrated) {
        console.log(`[yeaft] session migration complete (${res.moved} dirs moved${res.warnings?.length ? `, ${res.warnings.length} warnings` : ''})`);
        if (res.warnings?.length) for (const w of res.warnings) console.warn(`[yeaft] migration: ${w}`);
      }
    })
    .catch((err) => {
      console.warn(`[yeaft] session migration failed (continuing): ${err?.message || err}`);
    });

  return { dir: root, created, writable, warnings };
}