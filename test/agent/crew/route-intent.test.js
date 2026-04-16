import { describe, it, expect } from 'vitest';
import { _detectRouteIntent } from '../../../agent/crew/role-output.js';

describe('_detectRouteIntent', () => {
  it('should detect Chinese routing intent: 提交给', () => {
    expect(_detectRouteIntent('代码已完成，提交给 rev-3 审查')).toBe(true);
  });

  it('should detect Chinese routing intent: 交给', () => {
    expect(_detectRouteIntent('任务完成，交给 pm 决策')).toBe(true);
  });

  it('should detect Chinese routing intent: 请.*审查', () => {
    expect(_detectRouteIntent('PR 已创建，请 rev-3 审查')).toBe(true);
  });

  it('should detect Chinese routing intent: 转给', () => {
    expect(_detectRouteIntent('需求不清楚，转给 pm 确认')).toBe(true);
  });

  it('should detect English routing intent: route to', () => {
    expect(_detectRouteIntent('I will route to pm for review')).toBe(true);
  });

  it('should detect English routing intent: submit to', () => {
    expect(_detectRouteIntent('Work done, submit to rev-1')).toBe(true);
  });

  it('should detect English routing intent: forward to', () => {
    expect(_detectRouteIntent('Need to forward to dev-2 for implementation')).toBe(true);
  });

  it('should detect English routing intent: pass to', () => {
    expect(_detectRouteIntent('All tests pass, pass to tester-1')).toBe(true);
  });

  it('should not detect intent in normal text', () => {
    expect(_detectRouteIntent('Just a regular message with no routing intent')).toBe(false);
  });

  it('should not detect intent in empty text', () => {
    expect(_detectRouteIntent('')).toBe(false);
    expect(_detectRouteIntent(null)).toBe(false);
    expect(_detectRouteIntent(undefined)).toBe(false);
  });

  it('should not detect intent in very short text', () => {
    expect(_detectRouteIntent('hello')).toBe(false);
  });

  it('should only check last 1000 chars', () => {
    const longPrefix = 'x'.repeat(2000);
    // Intent only in the beginning (>1000 chars away from end) — should NOT detect
    expect(_detectRouteIntent('提交给 pm' + longPrefix)).toBe(false);
    // Intent at the end — should detect
    expect(_detectRouteIntent(longPrefix + '提交给 pm')).toBe(true);
  });
});
