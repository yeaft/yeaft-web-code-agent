/**
 * tool-search.js — Search available tools by name or description.
 *
 * task-311: chat/work mode was removed in task-297; this tool no longer
 * accepts or reports a `modes` filter. Results come back as plain
 * { name, description } pairs.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'ToolSearch',
  description: `Search available tools by name or description keyword.

Use when you're unsure which tool to use for a task.
Returns matching tools with their descriptions.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keyword to match against tool names and descriptions',
      },
    },
    required: ['query'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  async execute(input, _ctx) {
    const { query } = input;
    if (!query) return JSON.stringify({ error: 'query is required' });

    const lowerQuery = query.toLowerCase();

    // Self-referential catalogue of tools available to the engine.
    const toolList = [
      { name: 'AskUser', description: 'Ask the user a question' },
      { name: 'MemoryRead', description: 'Read from memory system' },
      { name: 'MemoryWrite', description: 'Write to memory system' },
      { name: 'MemorySearch', description: 'Search memory entries' },
      { name: 'WebSearch', description: 'Search the web' },
      { name: 'WebFetch', description: 'Fetch web page content' },
      { name: 'HistorySearch', description: 'Search conversation history' },
      { name: 'Bash', description: 'Execute shell commands' },
      { name: 'FileRead', description: 'Read file with line numbers' },
      { name: 'FileWrite', description: 'Write/create files' },
      { name: 'FileEdit', description: 'Surgical string replacement in files' },
      { name: 'Glob', description: 'Find files by pattern' },
      { name: 'Grep', description: 'Search file contents' },
      { name: 'ListDir', description: 'List directory contents' },
      { name: 'ApplyPatch', description: 'Apply unified diff patches' },
      { name: 'Agent', description: 'Create sub-agents' },
      { name: 'SendMessage', description: 'Send message to sub-agent' },
      { name: 'WaitAgent', description: 'Wait for sub-agent result' },
      { name: 'CloseAgent', description: 'Close a sub-agent' },
      { name: 'ListAgents', description: 'List all sub-agents' },
      { name: 'TaskCreate', description: 'Create a task' },
      { name: 'TaskUpdate', description: 'Update task status' },
      { name: 'TaskList', description: 'List all tasks' },
      { name: 'TaskGet', description: 'Get task details' },
      { name: 'FollowupTask', description: 'Create follow-up task' },
      { name: 'UpdatePlan', description: 'View/update execution plan' },
      { name: 'JsRepl', description: 'JavaScript REPL evaluation' },
      { name: 'JsReplReset', description: 'Reset REPL state' },
      { name: 'NotebookEdit', description: 'Edit Jupyter notebooks' },
      { name: 'ImageGeneration', description: 'Generate images from text' },
      { name: 'ViewImage', description: 'View image metadata' },
      { name: 'RequestPermissions', description: 'Request dangerous operation permissions' },
      { name: 'WriteStdin', description: 'Write to running process stdin' },
      { name: 'Skill', description: 'Load skills from library' },
      { name: 'EnterWorktree', description: 'Create git worktree' },
      { name: 'ExitWorktree', description: 'Exit git worktree' },
      { name: 'mcp_list_tools', description: 'List MCP server tools' },
      { name: 'mcp_call_tool', description: 'Call MCP server tool' },
    ];

    const results = toolList.filter(t =>
      t.name.toLowerCase().includes(lowerQuery) ||
      t.description.toLowerCase().includes(lowerQuery)
    );

    return JSON.stringify({
      results,
      totalResults: results.length,
      query,
    }, null, 2);
  },
});
