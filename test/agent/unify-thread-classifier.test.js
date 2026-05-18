import { describe, it, expect } from 'vitest';
import {
  fallbackTitle,
  parseThreadClassification,
  validateThreadClassification,
} from '../../agent/unify/vp/thread-classifier.js';

const running = [
  { threadId: 'thr_login', title: '修复登录' },
  { threadId: 'thr_export', title: '导出报表' },
];

describe('thread classifier parse/validate', () => {
  it('accepts a related decision only when the target thread exists', () => {
    const out = parseThreadClassification(
      JSON.stringify({ decision: 'related', targetThreadId: 'thr_login', title: '继续修登录', reason: 'same bug' }),
      running,
      '继续看登录报错',
    );
    expect(out).toEqual({
      decision: 'related',
      targetThreadId: 'thr_login',
      title: '继续修登录',
      reason: 'same bug',
    });
  });

  it('falls back to unrelated on an unknown related target', () => {
    const out = validateThreadClassification(
      { decision: 'related', targetThreadId: 'missing', title: '继续处理' },
      running,
      '继续处理',
    );
    expect(out.decision).toBe('unrelated');
    expect(out.targetThreadId).toBe(null);
    expect(out.reason).toBe('invalid_target_thread');
  });

  it('invalid JSON falls back conservatively to the sole running thread', () => {
    const out = parseThreadClassification('not json', [running[0]], '继续这个问题');
    expect(out.decision).toBe('related');
    expect(out.targetThreadId).toBe('thr_login');
    expect(out.reason).toBe('invalid_json');
  });

  it('invalid JSON with multiple running threads creates a new thread', () => {
    const out = parseThreadClassification('not json', running, '另一个任务');
    expect(out.decision).toBe('unrelated');
    expect(out.targetThreadId).toBe(null);
    expect(out.reason).toBe('invalid_json');
  });

  it('strips fenced JSON and generates compact titles', () => {
    expect(fallbackTitle('@linus 请修复登录按钮颜色和 hover')).toBe('请修复登录按钮颜色和 hover');
    const out = parseThreadClassification('```json\n{"decision":"unrelated","title":"New export flow"}\n```', running, 'export');
    expect(out.decision).toBe('unrelated');
    expect(out.title).toBe('New export flow');
  });
});
