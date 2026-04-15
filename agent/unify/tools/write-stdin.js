/**
 * write-stdin.js — Write data to a running process's stdin.
 *
 * Used in conjunction with Bash for processes that need interactive input.
 * Currently returns a guidance message since Bash tool uses 'ignore' for stdin.
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'WriteStdin',
  description: `Write data to a running process's standard input.

This tool is intended for sending input to interactive processes.
Since the Bash tool runs commands non-interactively, this is primarily
useful with the terminal system or long-running processes.

Note: For most use cases, pipe input via Bash: echo "input" | command`,
  parameters: {
    type: 'object',
    properties: {
      process_id: {
        type: 'string',
        description: 'Process identifier or terminal ID',
      },
      data: {
        type: 'string',
        description: 'Data to write to stdin',
      },
      newline: {
        type: 'boolean',
        description: 'Append newline after data (default: true)',
      },
    },
    required: ['data'],
  },
  modes: ['work'],
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { process_id, data, newline = true } = input;
    if (!data && data !== '') return JSON.stringify({ error: 'data is required' });

    // The Bash tool uses 'ignore' for stdin, so direct stdin writing
    // is only possible through the terminal system.
    // For most interactive needs, recommend using pipe syntax.
    return JSON.stringify({
      hint: 'The Bash tool does not support interactive stdin. Use pipe syntax instead:',
      example: `echo "${data}" | your_command`,
      alternativeBash: `printf '%s\\n' '${data.replace(/'/g, "'\\''")}' | your_command`,
      message: 'For interactive processes, use the terminal system (not the AI tool system).',
    });
  },
});
