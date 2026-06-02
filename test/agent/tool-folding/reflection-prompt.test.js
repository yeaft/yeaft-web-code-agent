/**
 * reflection-prompt.test.js — PR-L
 */
import { describe, it, expect } from 'vitest';
import {
  buildReflectionPrompt,
  REFLECTION_TEMPLATE_EN,
  REFLECTION_TEMPLATE_ZH,
} from '../../../agent/yeaft/tool-folding/reflection-prompt.js';

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

  it('renders the English template when language is omitted', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: 'hello',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
    });
    expect(prompt).toContain('You are reviewing a sequence of');
    expect(prompt).toContain('CRITICAL: Preserve all identifiers');
  });

  it('renders the English template for language="en"', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: 'hello',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
      assistantText: 'analyzing the failure',
      language: 'en',
    });
    expect(prompt).toContain('You are reviewing a sequence of');
    expect(prompt).toContain('Assistant text emitted during this batch');
    // The Chinese template should NOT be selected.
    expect(prompt).not.toContain('你正在复盘');
    expect(prompt).not.toContain('本批工具调用期间助手输出的文本');
  });

  it('renders the Chinese template for language="zh"', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: '修复 foo.js 的 bug',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
      language: 'zh',
    });
    expect(prompt).toContain('你正在复盘');
    expect(prompt).toContain('修复 foo.js 的 bug');
    // Section headings MUST stay English even in the zh template — the
    // frontend ReflectionCard parses them by literal match.
    expect(prompt).toContain('## What was attempted');
    expect(prompt).toContain('## Key findings');
    expect(prompt).toContain('## Direction check');
    expect(prompt).toContain('## Suggested next direction');
    expect(prompt).toContain('## Tool execution log');
    // The English boilerplate is gone.
    expect(prompt).not.toContain('CRITICAL: Preserve all identifiers');
  });

  it('treats language="zh-CN" as Chinese (case-insensitive prefix match)', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: 'x',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
      language: 'ZH-CN',
    });
    expect(prompt).toContain('你正在复盘');
  });

  it('localises the assistantText header in the zh template', () => {
    const prompt = buildReflectionPrompt({
      originalUserMsg: 'x',
      toolPairs: [{ name: 'a', input: {}, output: 'ok', isError: false }],
      assistantText: '我在分析这个错误',
      language: 'zh',
    });
    expect(prompt).toContain('本批工具调用期间助手输出的文本');
    expect(prompt).toContain('我在分析这个错误');
    expect(prompt).not.toContain('Assistant text emitted during this batch');
  });

  it('exports both language-specific template constants', () => {
    expect(REFLECTION_TEMPLATE_EN).toContain('CRITICAL: Preserve all identifiers');
    expect(REFLECTION_TEMPLATE_ZH).toContain('你正在复盘');
  });
});


