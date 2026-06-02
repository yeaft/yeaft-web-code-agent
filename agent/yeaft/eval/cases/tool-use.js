/**
 * eval/cases/tool-use.js — Tool use eval cases
 *
 * Tests whether the model correctly decides when and how to call tools.
 * These are the most important evals — they catch regressions in:
 *   - Tool selection (right tool for the job)
 *   - Parameter extraction (correct input from natural language)
 *   - Tool avoidance (not calling tools when unnecessary)
 *   - Multi-tool orchestration (using multiple tools in sequence)
 */

import { defineTool } from '../../tools/types.js';
import {
  noError,
  toolWasCalled,
  toolCalledWith,
  toolNotCalled,
  toolSucceeded,
  turnCountInRange,
  containsText,
  custom,
} from '../runner.js';

// ─── Mock Tools for Evals ────────────────────────────────────

const searchTool = defineTool({
  name: 'search',
  description: 'Search the web for information. Returns search results as text.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  },
  async execute(input) {
    const q = (input.query || '').slice(0, 200);
    return JSON.stringify({
      results: [
        { title: `Result for: ${q}`, snippet: `Information about ${q}` },
      ],
    });
  },
});

const calculatorTool = defineTool({
  name: 'calculator',
  description: 'Perform mathematical calculations. Supports basic arithmetic and common functions.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate (e.g. "2 + 3 * 4")' },
    },
    required: ['expression'],
  },
  async execute(input) {
    try {
      // Safe eval for basic math
      const result = Function(`"use strict"; return (${input.expression})`)();
      return String(result);
    } catch {
      return `Error: invalid expression "${input.expression}"`;
    }
  },
});

const readFileTool = defineTool({
  name: 'read_file',
  description: 'Read the contents of a file at the given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
    },
    required: ['path'],
  },
  async execute(input) {
    // Mock file system
    const files = {
      'package.json': '{ "name": "my-app", "version": "1.0.0", "dependencies": { "express": "^4.18" } }',
      'README.md': '# My App\n\nA sample application built with Express.',
      'src/index.js': 'const express = require("express");\nconst app = express();\napp.listen(3000);',
    };
    return files[input.path] || `Error: file not found "${input.path}"`;
  },
});

const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Write content to a file at the given path.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  async execute(input) {
    return `Successfully wrote ${input.content.length} bytes to ${input.path}`;
  },
});

const bashTool = defineTool({
  name: 'bash',
  description: 'Execute a bash command and return the output.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
    },
    required: ['command'],
  },
  async execute(input) {
    // Mock bash responses
    const responses = {
      'git status': 'On branch main\nnothing to commit, working tree clean',
      'ls': 'package.json\nREADME.md\nsrc/',
      'npm test': 'Tests passed: 42/42',
    };
    // Match any command that starts with a known command
    for (const [cmd, response] of Object.entries(responses)) {
      if (input.command.startsWith(cmd)) return response;
    }
    return `$ ${input.command}\n(command executed successfully)`;
  },
});

const allTools = [searchTool, calculatorTool, readFileTool, writeFileTool, bashTool];

// ─── Eval Cases ──────────────────────────────────────────────

export const toolUseCases = [

  // ─── Basic Tool Selection ─────────────────────────────

  {
    id: 'tool-select-search',
    suite: 'tools',
    description: 'Model should use search tool for factual questions',
    prompt: 'What is the current population of Tokyo?',
    registryTools: allTools,
    criteria: [
      noError,
      toolWasCalled('search', { weight: 10 }),
      toolCalledWith('search', (input) =>
        input.query && input.query.toLowerCase().includes('tokyo'),
        { id: 'search-mentions-tokyo', weight: 6 },
      ),
      toolNotCalled('calculator', { weight: 3 }),
      toolNotCalled('read_file', { weight: 3 }),
    ],
  },

  {
    id: 'tool-select-calculator',
    suite: 'tools',
    description: 'Model should use calculator for math problems',
    prompt: 'What is 1847 * 293 + 7621?',
    registryTools: allTools,
    criteria: [
      noError,
      toolWasCalled('calculator', { weight: 10 }),
      toolCalledWith('calculator', (input) =>
        input.expression && /1847/.test(input.expression) && /293/.test(input.expression),
        { id: 'calc-correct-expr', weight: 8 },
      ),
      toolNotCalled('search', { weight: 3 }),
    ],
  },

  {
    id: 'tool-select-read-file',
    suite: 'tools',
    description: 'Model should use read_file to examine project files',
    prompt: 'What dependencies does the project have? Check package.json',
    registryTools: allTools,
    criteria: [
      noError,
      toolWasCalled('read_file', { weight: 10 }),
      toolCalledWith('read_file', (input) =>
        input.path === 'package.json',
        { id: 'reads-package-json', weight: 8 },
      ),
      containsText('express', { id: 'mentions-express', weight: 5 }),
    ],
  },

  // ─── Tool Avoidance ───────────────────────────────────

  {
    id: 'tool-avoid-simple-chat',
    suite: 'tools',
    description: 'Model should NOT use tools for simple conversation',
    prompt: 'Hello! How are you doing today?',
    registryTools: allTools,
    criteria: [
      noError,
      toolNotCalled('search', { weight: 8 }),
      toolNotCalled('calculator', { weight: 8 }),
      toolNotCalled('read_file', { weight: 8 }),
      turnCountInRange(1, 1, { weight: 5 }),
    ],
  },

  {
    id: 'tool-avoid-known-knowledge',
    suite: 'tools',
    description: 'Model should NOT search for common knowledge it already has',
    prompt: 'What is the capital of France?',
    registryTools: allTools,
    criteria: [
      noError,
      toolNotCalled('search', { weight: 8, id: 'no-search-for-common-knowledge' }),
      containsText('Paris', { weight: 7 }),
      turnCountInRange(1, 1, { weight: 3 }),
    ],
  },

  {
    id: 'tool-avoid-simple-math',
    suite: 'tools',
    description: 'Model should NOT use calculator for trivial math (2+2)',
    prompt: 'What is 2 + 2?',
    registryTools: allTools,
    criteria: [
      noError,
      toolNotCalled('calculator', { weight: 6, id: 'no-calc-for-trivial' }),
      containsText('4', { weight: 5 }),
    ],
  },

  // ─── Multi-Tool Orchestration ─────────────────────────

  {
    id: 'tool-multi-read-then-write',
    suite: 'tools',
    description: 'Model should read a file then modify it (sequential tools)',
    prompt: 'Read src/index.js and add a health check endpoint at /health',
    registryTools: allTools,
    criteria: [
      noError,
      toolWasCalled('read_file', { weight: 8, id: 'reads-first' }),
      toolWasCalled('write_file', { weight: 8, id: 'writes-after' }),
      toolCalledWith('read_file', (input) =>
        input.path === 'src/index.js',
        { id: 'reads-correct-file', weight: 6 },
      ),
      toolCalledWith('write_file', (input) =>
        input.path === 'src/index.js' && input.content && input.content.includes('health'),
        { id: 'writes-health-endpoint', weight: 8 },
      ),
      custom('read-before-write', 'Read happens before write', 5, (result) => {
        const readIdx = result.toolCalls.findIndex(tc => tc.name === 'read_file');
        const writeIdx = result.toolCalls.findIndex(tc => tc.name === 'write_file');
        const ordered = readIdx >= 0 && writeIdx >= 0 && readIdx < writeIdx;
        return { pass: ordered, score: ordered ? 1 : 0 };
      }),
    ],
  },

  {
    id: 'tool-multi-bash-workflow',
    suite: 'tools',
    description: 'Model should run git status and npm test',
    prompt: 'Check the git status and run the tests',
    registryTools: allTools,
    criteria: [
      noError,
      toolWasCalled('bash', { weight: 8 }),
      custom('git-status-called', 'Ran git status', 7, (result) => {
        const gitCall = result.toolCalls.find(tc =>
          tc.name === 'bash' && tc.input.command && tc.input.command.includes('git status'),
        );
        return { pass: !!gitCall, score: gitCall ? 1 : 0 };
      }),
      custom('npm-test-called', 'Ran npm test', 7, (result) => {
        const testCall = result.toolCalls.find(tc =>
          tc.name === 'bash' && tc.input.command && tc.input.command.includes('test'),
        );
        return { pass: !!testCall, score: testCall ? 1 : 0 };
      }),
    ],
  },

  // ─── Error Handling ───────────────────────────────────

  {
    id: 'tool-error-recovery',
    suite: 'tools',
    description: 'Model should handle tool errors gracefully and explain to user',
    prompt: 'Read the file at /nonexistent/path/file.txt',
    registryTools: allTools,
    criteria: [
      noError,
      toolWasCalled('read_file', { weight: 8 }),
      custom('acknowledges-error', 'Model acknowledges the file was not found', 7, (result) => {
        const hasError = result.toolResults.some(tr =>
          tr.name === 'read_file' && tr.output.includes('not found'),
        );
        const acknowledges = result.fullText.toLowerCase().includes('not found') ||
                            result.fullText.toLowerCase().includes('doesn\'t exist') ||
                            result.fullText.toLowerCase().includes('does not exist') ||
                            result.fullText.toLowerCase().includes('error') ||
                            result.fullText.toLowerCase().includes('unable');
        return { pass: hasError && acknowledges, score: (hasError && acknowledges) ? 1 : 0 };
      }),
    ],
  },

  // ─── Parameter Extraction ─────────────────────────────

  {
    id: 'tool-param-extraction-complex',
    suite: 'tools',
    description: 'Model should extract correct parameters from complex natural language',
    prompt: 'Search for "best practices for TypeScript error handling in 2026"',
    registryTools: allTools,
    criteria: [
      noError,
      toolWasCalled('search', { weight: 8 }),
      toolCalledWith('search', (input) =>
        input.query &&
        input.query.toLowerCase().includes('typescript') &&
        input.query.toLowerCase().includes('error'),
        { id: 'extracts-key-terms', weight: 8 },
      ),
    ],
  },
];
