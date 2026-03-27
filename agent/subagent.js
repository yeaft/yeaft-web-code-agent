/**
 * Sub-Agent JSONL Watcher
 *
 * Watches the Claude CLI subagent JSONL session files for real-time messages.
 * When a Task tool_use is detected in claude.js, this module starts watching
 * the `{sessionId}/subagents/` directory. New JSONL files are tail-read line
 * by line, extracting assistant text and tool_use summaries, then forwarded
 * to the server as `subagent_message` events.
 *
 * JSONL location: ~/.claude/projects/{projectFolder}/{sessionId}/subagents/agent-{id}.jsonl
 * Meta location:  ~/.claude/projects/{projectFolder}/{sessionId}/subagents/agent-{id}.meta.json
 */
import { watch, readFileSync, openSync, readSync, closeSync, statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import ctx from './context.js';
import { getClaudeProjectsDir, pathToProjectFolder } from './history.js';

// Active watchers: conversationId -> { dirWatcher, fileWatchers: Map<filePath, { bytesRead, watcher }> }
const activeWatchers = new Map();

/**
 * Get the subagents directory for a given conversation state.
 */
function getSubagentsDir(state) {
  if (!state.claudeSessionId || !state.workDir) return null;
  const projectFolder = pathToProjectFolder(state.workDir);
  return join(getClaudeProjectsDir(), projectFolder, state.claudeSessionId, 'subagents');
}

/**
 * Parse agent ID from filename (e.g. "agent-a12015b.jsonl" → "a12015b")
 */
function parseAgentId(filename) {
  const match = filename.match(/^agent-([^.]+)\.jsonl$/);
  return match ? match[1] : null;
}

/**
 * Read meta.json for a subagent to get its type (e.g. "Explore")
 */
function readAgentMeta(subagentsDir, agentId) {
  try {
    const metaPath = join(subagentsDir, `agent-${agentId}.meta.json`);
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      return { agentType: meta.agentType || 'Task' };
    }
  } catch { /* ignore */ }
  return { agentType: 'Task' };
}

/**
 * Extract displayable content from a JSONL message line.
 * Returns null if the message should be skipped.
 */
function parseJsonlLine(line) {
  try {
    const data = JSON.parse(line);

    // Only process assistant messages
    if (data.type !== 'assistant' || !data.message?.content) return null;

    const content = data.message.content;
    const messages = [];

    // Handle string content (simple text)
    if (typeof content === 'string') {
      if (content.trim()) {
        messages.push({ type: 'text', content: content.trim(), timestamp: data.timestamp });
      }
      return messages.length > 0 ? messages : null;
    }

    // Handle array content (text blocks + tool_use blocks)
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          messages.push({ type: 'text', content: block.text.trim(), timestamp: data.timestamp });
        } else if (block.type === 'tool_use') {
          const toolName = block.name || 'Unknown';
          const summary = formatToolSummary(toolName, block.input);
          messages.push({ type: 'tool', content: summary, timestamp: data.timestamp, toolName });
        }
      }
      return messages.length > 0 ? messages : null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Format a one-liner summary for a tool_use block.
 */
function formatToolSummary(toolName, input) {
  if (!input) return toolName;
  switch (toolName) {
    case 'Read':
      return `Read ${input.file_path || ''}`;
    case 'Write':
      return `Write ${input.file_path || ''}`;
    case 'Edit':
      return `Edit ${input.file_path || ''}`;
    case 'Bash':
      return `Bash: ${(input.command || '').substring(0, 80)}`;
    case 'Glob':
      return `Glob ${input.pattern || ''}`;
    case 'Grep':
      return `Grep ${input.pattern || ''}`;
    case 'WebFetch':
      return `WebFetch ${input.url || ''}`;
    case 'WebSearch':
      return `WebSearch: ${input.query || ''}`;
    default:
      return toolName;
  }
}

/**
 * Start tail-reading a JSONL file for new lines.
 */
function startFileWatcher(filePath, agentId, conversationId, watcherState) {
  let bytesRead = 0;

  // Read existing content first
  try {
    const stat = statSync(filePath);
    if (stat.size > 0) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parsed = parseJsonlLine(line);
        if (parsed) {
          for (const msg of parsed) {
            ctx.sendToServer({
              type: 'subagent_message',
              conversationId,
              subagentId: agentId,
              message: msg
            });
          }
        }
      }
      bytesRead = stat.size;
    }
  } catch { /* file might not be ready yet */ }

  // Watch for new content
  let pendingPartial = '';
  const watcher = watch(filePath, () => {
    try {
      const stat = statSync(filePath);
      if (stat.size <= bytesRead) return;

      const fd = openSync(filePath, 'r');
      const buffer = Buffer.alloc(stat.size - bytesRead);
      readSync(fd, buffer, 0, buffer.length, bytesRead);
      closeSync(fd);

      const newContent = pendingPartial + buffer.toString('utf-8');

      // Split into lines; the last element may be a partial line
      const parts = newContent.split('\n');
      const maybePartial = parts.pop(); // last element ('' if content ended with \n, or partial line)
      pendingPartial = maybePartial || '';

      // Advance bytesRead by what we consumed (total read minus what we're holding back)
      bytesRead = stat.size - Buffer.byteLength(pendingPartial, 'utf-8');

      for (const line of parts) {
        if (!line.trim()) continue;
        const parsed = parseJsonlLine(line);
        if (parsed) {
          for (const msg of parsed) {
            ctx.sendToServer({
              type: 'subagent_message',
              conversationId,
              subagentId: agentId,
              message: msg
            });
          }
        }
      }
    } catch { /* ignore read errors during active writes */ }
  });

  watcherState.fileWatchers.set(filePath, { watcher });
}

/**
 * Start watching the subagents directory for a conversation.
 * Called when a Task tool_use is detected.
 */
export function startSubagentWatcher(conversationId, state, toolUseId) {
  const subagentsDir = getSubagentsDir(state);
  if (!subagentsDir) return;

  // If already watching this conversation, just record the mapping
  if (activeWatchers.has(conversationId)) {
    return;
  }

  const watcherState = {
    dirWatcher: null,
    fileWatchers: new Map(),
    knownAgents: new Set(),
    toolUseId,
    subagentsDir
  };

  // Function to discover and start watching a new agent JSONL file
  const discoverAgentFile = (filename) => {
    const agentId = parseAgentId(filename);
    if (!agentId || watcherState.knownAgents.has(agentId)) return;
    watcherState.knownAgents.add(agentId);

    const filePath = join(subagentsDir, filename);
    const meta = readAgentMeta(subagentsDir, agentId);

    // Read slug from first line of JSONL if available
    let slug = agentId;
    try {
      const content = readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n')[0];
      if (firstLine) {
        const data = JSON.parse(firstLine);
        if (data.slug) slug = data.slug;
      }
    } catch { /* use agentId as fallback slug */ }

    // Send subagent_started
    ctx.sendToServer({
      type: 'subagent_started',
      conversationId,
      subagentId: agentId,
      slug,
      subagentType: meta.agentType,
      parentToolUseId: toolUseId,
      description: `${meta.agentType} agent`
    });

    startFileWatcher(filePath, agentId, conversationId, watcherState);
  };

  // Check for existing files first
  try {
    if (existsSync(subagentsDir)) {
      const files = readdirSync(subagentsDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          discoverAgentFile(file);
        }
      }
    }
  } catch { /* dir might not exist yet */ }

  // Watch for new files in the subagents directory
  // Use an interval-based check because fs.watch on directories can be unreliable
  const pollInterval = setInterval(() => {
    try {
      if (!existsSync(subagentsDir)) return;
      const files = readdirSync(subagentsDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          discoverAgentFile(file);
        }
      }
    } catch { /* ignore */ }
  }, 500);

  watcherState.dirWatcher = pollInterval;
  activeWatchers.set(conversationId, watcherState);
}

/**
 * Stop watching subagents for a conversation's Task tool_use.
 * Called when the Task tool_result is received.
 */
export function stopSubagentWatcher(conversationId, toolUseId) {
  const watcherState = activeWatchers.get(conversationId);
  if (!watcherState) return;

  // Only stop if this is the matching tool_use
  if (watcherState.toolUseId !== toolUseId) return;

  // Send completion for all known agents
  for (const agentId of watcherState.knownAgents) {
    ctx.sendToServer({
      type: 'subagent_completed',
      conversationId,
      subagentId: agentId
    });
  }

  // Clean up watchers
  if (watcherState.dirWatcher) {
    clearInterval(watcherState.dirWatcher);
  }
  for (const { watcher } of watcherState.fileWatchers.values()) {
    try { watcher.close(); } catch { /* ignore */ }
  }

  activeWatchers.delete(conversationId);
}

/**
 * Clean up all watchers for a conversation (e.g. on conversation close).
 */
export function cleanupSubagentWatchers(conversationId) {
  const watcherState = activeWatchers.get(conversationId);
  if (!watcherState) return;

  if (watcherState.dirWatcher) {
    clearInterval(watcherState.dirWatcher);
  }
  for (const { watcher } of watcherState.fileWatchers.values()) {
    try { watcher.close(); } catch { /* ignore */ }
  }

  activeWatchers.delete(conversationId);
}
