/**
 * reflection-prompt.test.js — PR-L
 */
import { describe, it, expect } from 'vitest';
import { buildReflectionPrompt, REFLECTION_TEMPLATE } from '../../../agent/unify/tool-folding/reflection-prompt.js';

describe('buildReflectionPrompt', () => {
  it('contains all five required section headings', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: 'do thing',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
    });
    expect(prompt).toContain('## What was attempted');
    expect(prompt).toContain('## Key findings');
    expect(prompt).toContain('## Direction check');
    expect(prompt).toContain('## Suggested next direction');
    expect(prompt).toContain('## Tool execution log');
  });

  it('interpolates {N} and the original user message', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: 'find the bug in foo.js',
      toolPairs: [
        { name: 'a', input: {}, output: '1', isError: false },
        { name: 'b', input: {}, output: '2', isError: false },
        { name: 'c', input: {}, output: '3', isError: false },
      ],
    });
    expect(prompt).toContain('sequence of 3 tool calls');
    expect(prompt).toContain('find the bug in foo.js');
  });

  it('renders each tool pair with name, args, result, and an [ERROR] tag when applicable', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: 'x',
      toolPairs: [
        { name: 'bash', input: { cmd: 'ls' }, output: 'a.txt', isError: false },
        { name: 'read', input: { path: '/x' }, output: 'ENOENT', isError: true },
      ],
    });
    expect(prompt).toContain('[1] bash');
    expect(prompt).toContain('[2] read [ERROR]');
    expect(prompt).toContain('"cmd":"ls"');
  });

  it('exports the canonical template constant', () => {
    expect(REFLECTION_TEMPLATE).toContain('CRITICAL: Preserve all identifiers');
  });
});
