/**
 * check-node-version.test.js — guard the version-parser logic.
 *
 * We can't easily test the `assertNodeVersion()` exit behavior without
 * spawning a child process, so we cover the pure parser/predicate. The
 * exit path is exercised by the `assertNodeVersion()` integration test
 * via process spawning when needed.
 */

import { describe, it, expect } from 'vitest';
import { isSupportedNodeVersion } from '../../agent/check-node-version.js';

describe('isSupportedNodeVersion', () => {
  it('accepts ≥ 22.5.0', () => {
    expect(isSupportedNodeVersion('v22.5.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.5.1')).toBe(true);
    expect(isSupportedNodeVersion('v22.10.0')).toBe(true);
    expect(isSupportedNodeVersion('v23.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v24.15.0')).toBe(true);
  });

  it('rejects 22.0–22.4', () => {
    expect(isSupportedNodeVersion('v22.0.0')).toBe(false);
    expect(isSupportedNodeVersion('v22.1.0')).toBe(false);
    expect(isSupportedNodeVersion('v22.2.5')).toBe(false);
    expect(isSupportedNodeVersion('v22.4.99')).toBe(false);
  });

  it('rejects pre-22 majors', () => {
    expect(isSupportedNodeVersion('v20.20.0')).toBe(false);
    expect(isSupportedNodeVersion('v21.7.3')).toBe(false);
    expect(isSupportedNodeVersion('v18.0.0')).toBe(false);
  });

  it('handles version strings with and without leading v', () => {
    expect(isSupportedNodeVersion('22.5.0')).toBe(true);
    expect(isSupportedNodeVersion('20.0.0')).toBe(false);
  });

  it('does NOT block on unparseable input (fail-open)', () => {
    expect(isSupportedNodeVersion('')).toBe(true);
    expect(isSupportedNodeVersion('garbage')).toBe(true);
    expect(isSupportedNodeVersion(null)).toBe(true);
    expect(isSupportedNodeVersion(undefined)).toBe(true);
  });
});
