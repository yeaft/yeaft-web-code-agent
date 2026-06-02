/**
 * eval/cases/e2e.js — End-to-end session eval cases
 *
 * Tests the full pipeline: prompt → recall → system prompt → LLM → tools → response.
 * These cases verify that the integration holds together correctly.
 */

import { defineTool } from '../../tools/types.js';
import {
  noError,
  containsText,
  toolWasCalled,
  toolNotCalled,
  toolSucceeded,
  turnCountInRange,
  responseLengthInRange,
  custom,
} from '../runner.js';

// ─── Mock Tools ──────────────────────────────────────────────

const listProjectsTool = defineTool({
  name: 'list_projects',
  description: 'List all projects in the workspace.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return JSON.stringify({
      projects: ['my-app', 'shared-lib', 'docs-site'],
    });
  },
});

const getProjectInfoTool = defineTool({
  name: 'get_project_info',
  description: 'Get detailed information about a specific project.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name' },
    },
    required: ['name'],
  },
  async execute(input) {
    const projects = {
      'my-app': { name: 'my-app', language: 'TypeScript', framework: 'Express', tests: 142 },
      'shared-lib': { name: 'shared-lib', language: 'TypeScript', framework: 'none', tests: 67 },
      'docs-site': { name: 'docs-site', language: 'MDX', framework: 'Next.js', tests: 23 },
    };
    return JSON.stringify(projects[input.name] || { error: `Unknown project: ${input.name}` });
  },
});

const e2eTools = [listProjectsTool, getProjectInfoTool];

// ─── Eval Cases ──────────────────────────────────────────────

export const e2eCases = [

  // ─── Conversation Coherence ───────────────────────────

  {
    id: 'e2e-conversation-context',
    suite: 'e2e',
    description: 'Model should use conversation history for context',
    prompt: 'What language is it written in?',
    messages: [
      { role: 'user', content: 'Tell me about the my-app project' },
      { role: 'assistant', content: 'The my-app project is a TypeScript application built with Express. It has 142 tests.' },
    ],
    registryTools: e2eTools,
    criteria: [
      noError,
      containsText('TypeScript', { weight: 8, id: 'remembers-language' }),
      turnCountInRange(1, 2, { weight: 3 }),
    ],
  },

  // ─── Tool Chain ───────────────────────────────────────

  {
    id: 'e2e-tool-chain-list-then-detail',
    suite: 'e2e',
    description: 'Model should list projects then get details about a specific one',
    prompt: 'Show me all projects and tell me about the one with the most tests',
    registryTools: e2eTools,
    criteria: [
      noError,
      toolWasCalled('list_projects', { weight: 7 }),
      toolWasCalled('get_project_info', { weight: 7 }),
      containsText('my-app', { weight: 5, id: 'identifies-most-tested' }),
      containsText('142', { weight: 5, id: 'mentions-test-count' }),
    ],
  },

  // ─── Instruction Following ────────────────────────────

  {
    id: 'e2e-format-json',
    suite: 'e2e',
    description: 'Model should follow format instructions',
    prompt: 'List three programming languages. Respond only with a JSON array of strings, nothing else.',
    criteria: [
      noError,
      custom('valid-json-array', 'Response is a valid JSON array', 10, (result) => {
        try {
          // Try to extract JSON from the response
          const text = result.fullText.trim();
          const match = text.match(/\[[\s\S]*\]/);
          if (!match) return { pass: false, score: 0, reason: 'No JSON array found' };
          const arr = JSON.parse(match[0]);
          const valid = Array.isArray(arr) && arr.length === 3 && arr.every(s => typeof s === 'string');
          return { pass: valid, score: valid ? 1 : 0.5, reason: valid ? undefined : `Got: ${JSON.stringify(arr)}` };
        } catch {
          return { pass: false, score: 0, reason: 'Not valid JSON' };
        }
      }),
    ],
  },

  // ─── Response Quality ─────────────────────────────────

  {
    id: 'e2e-concise-answer',
    suite: 'e2e',
    description: 'Model should give a concise answer for simple question',
    prompt: 'What does the acronym HTTP stand for?',
    criteria: [
      noError,
      containsText('Hypertext Transfer Protocol', { weight: 8 }),
      responseLengthInRange(10, 500, { weight: 5, id: 'not-too-long' }),
      toolNotCalled('search', { weight: 3 }),
    ],
  },

  // ─── Language Handling ────────────────────────────────

  {
    id: 'e2e-chinese-response',
    suite: 'e2e',
    description: 'Model should respond in Chinese when prompted in Chinese',
    prompt: '用中文简单解释什么是 API',
    criteria: [
      noError,
      custom('has-chinese', 'Response contains Chinese characters', 8, (result) => {
        const chinesePattern = /[\u4e00-\u9fff]/;
        const hasChinese = chinesePattern.test(result.fullText);
        return { pass: hasChinese, score: hasChinese ? 1 : 0 };
      }),
      containsText('API', { weight: 5 }),
    ],
  },
];
