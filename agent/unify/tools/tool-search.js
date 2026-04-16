/**
 * tool-search.js — Search available tools by name or description.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'ToolSearch',
  description: `Search available tools by name or description keyword.

Use when you're unsure which tool to use for a task.
Returns matching tools with their descriptions and parameters.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keyword to match against tool names and descriptions',
      },
      mode: {
        type: 'string',
        enum: ['chat', 'work'],
        description: 'Filter by mode (optional)',
      },
    },
    required: ['query'],
  },
  modes: ['chat', 'work'],
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { query, mode } = input;
    if (!query) return JSON.stringify({ error: 'query is required' });

    // Access the tool registry through the engine context
    // Since we don't have direct registry access, list what we know
    const lowerQuery = query.toLowerCase();

    // Get all tool definitions from the registry if available
    // This is a self-referential tool — it describes the tools available to this engine
    const toolList = [
      { name: 'AskUser', description: 'Ask the user a question', modes: ['chat', 'work'] },
      { name: 'MemoryRead', description: 'Read from memory system', modes: ['chat', 'work'] },
      { name: 'MemoryWrite', description: 'Write to memory system', modes: ['chat', 'work'] },
      { name: 'MemorySearch', description: 'Search memory entries', modes: ['chat', 'work'] },
      { name: 'WebSearch', description: 'Search the web', modes: ['chat', 'work'] },
      { name: 'WebFetch', description: 'Fetch web page content', modes: ['chat', 'work'] },
      { name: 'HistorySearch', description: 'Search conversation history', modes: ['chat', 'work'] },
      { name: 'Bash', description: 'Execute shell commands', modes: ['chat', 'work'] },
      { name: 'FileRead', description: 'Read file with line numbers', modes: ['chat', 'work'] },
      { name: 'FileWrite', description: 'Write/create files', modes: ['chat', 'work'] },
      { name: 'FileEdit', description: 'Surgical string replacement in files', modes: ['chat', 'work'] },
      { name: 'Glob', description: 'Find files by pattern', modes: ['chat', 'work'] },
      { name: 'Grep', description: 'Search file contents', modes: ['chat', 'work'] },
      { name: 'ListDir', description: 'List directory contents', modes: ['chat', 'work'] },
      { name: 'ApplyPatch', description: 'Apply unified diff patches', modes: ['chat', 'work'] },
      { name: 'Agent', description: 'Create sub-agents', modes: ['work'] },
      { name: 'SendMessage', description: 'Send message to sub-agent', modes: ['work'] },
      { name: 'WaitAgent', description: 'Wait for sub-agent result', modes: ['work'] },
      { name: 'CloseAgent', description: 'Close a sub-agent', modes: ['work'] },
      { name: 'ListAgents', description: 'List all sub-agents', modes: ['work'] },
      { name: 'TaskCreate', description: 'Create a task', modes: ['work'] },
      { name: 'TaskUpdate', description: 'Update task status', modes: ['work'] },
      { name: 'TaskList', description: 'List all tasks', modes: ['work'] },
      { name: 'TaskGet', description: 'Get task details', modes: ['work'] },
      { name: 'FollowupTask', description: 'Create follow-up task', modes: ['work'] },
      { name: 'UpdatePlan', description: 'View/update execution plan', modes: ['work'] },
      { name: 'JsRepl', description: 'JavaScript REPL evaluation', modes: ['chat', 'work'] },
      { name: 'JsReplReset', description: 'Reset REPL state', modes: ['chat', 'work'] },
      { name: 'NotebookEdit', description: 'Edit Jupyter notebooks', modes: ['chat', 'work'] },
      { name: 'ImageGeneration', description: 'Generate images from text', modes: ['chat', 'work'] },
      { name: 'ViewImage', description: 'View image metadata', modes: ['chat', 'work'] },
      { name: 'RequestPermissions', description: 'Request dangerous operation permissions', modes: ['chat', 'work'] },
      { name: 'WriteStdin', description: 'Write to running process stdin', modes: ['chat', 'work'] },
      { name: 'Skill', description: 'Load skills from library', modes: ['chat', 'work'] },
      { name: 'EnterWorktree', description: 'Create git worktree', modes: ['chat', 'work'] },
      { name: 'ExitWorktree', description: 'Exit git worktree', modes: ['chat', 'work'] },
      { name: 'mcp_list_tools', description: 'List MCP server tools', modes: ['chat', 'work'] },
      { name: 'mcp_call_tool', description: 'Call MCP server tool', modes: ['chat', 'work'] },
    ];

    let results = toolList.filter(t =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery)
    );

    if (mode) {
      results = results.filter(t => t.modes.includes(mode));
    }

    return JSON.stringify({
      results,
      totalResults: results.length,
      query,
    }, null, 2);
  },
});
