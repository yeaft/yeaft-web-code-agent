/**
 * fallback-stub.test.js — PR-L
 */
import { describe, it, expect } from 'vitest';
import { buildFallbackStub } from '../../../agent/yeaft/tool-folding/fallback-stub.js';
import { buildEntry } from '../../../agent/yeaft/tool-folding/exec-log.js';

describe('buildFallbackStub', () => {
  it('produces a markdown string with the 5 canonical sections', () => {
    const entries = [
      buildEntry({ loopIdx: 0, toolName: 'bash', args: { cmd: 'ls' }, output: 'a', isError: false }),
      buildEntry({ loopIdx: 1, toolName: 'read', args: { path: '/x' }, output: 'X', isError: false }),
      buildEntry({ loopIdx: 2, toolName: 'bash', args: { cmd: 'pwd' }, output: '/', isError: false }),
    ];
    const md = buildFallbackStub({ execLogEntries: entries, originalUserMsg: 'go' });
    expect(md).toContain('## What was attempted');
    expect(md).toContain('## Key findings');
    expect(md).toContain('## Direction check');
    expect(md).toContain('## Suggested next direction');
    expect(md).toContain('## Tool execution log');
    expect(md).toContain('bash × 2');
    expect(md).toContain('read × 1');
    expect(md).toContain('go');
  });

  it('handles empty exec log gracefully', () => {
    const md = buildFallbackStub({ execLogEntries: [], originalUserMsg: '' });
    expect(md).toContain('0 tool calls');
    expect(md).toContain('_(empty)_');
  });

  it('reports errors in direction-check', () => {
    const entries = [
      buildEntry({ loopIdx: 0, toolName: 'r', args: {}, output: 'fail', isError: true }),
    ];
    const md = buildFallbackStub({ execLogEntries: entries });
    expect(md).toMatch(/1 tool call.* failed/);
  });
});
