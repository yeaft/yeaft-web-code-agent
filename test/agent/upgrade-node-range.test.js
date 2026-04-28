/**
 * Unit tests for the minimal SemVer range checker that gates agent
 * self-upgrade. The gate must be **fail-open**: anything we cannot parse
 * has to return `true` so a weird `engines.node` field never blocks a
 * legitimate upgrade — but anything we *can* parse must be strict enough
 * to catch obvious incompatibilities (e.g. running Node 18 against a
 * package that requires `>=22.5.0`).
 */

import { describe, it, expect } from 'vitest';
import { nodeRangeSatisfied } from '../../agent/connection/upgrade.js';

describe('nodeRangeSatisfied', () => {
  it('treats empty / wildcard ranges as satisfied', () => {
    expect(nodeRangeSatisfied('20.0.0', '')).toBe(true);
    expect(nodeRangeSatisfied('20.0.0', '*')).toBe(true);
    expect(nodeRangeSatisfied('20.0.0', 'x')).toBe(true);
    expect(nodeRangeSatisfied('20.0.0', null)).toBe(true);
    expect(nodeRangeSatisfied('20.0.0', undefined)).toBe(true);
  });

  it('handles >= comparator (the common case)', () => {
    expect(nodeRangeSatisfied('22.5.0', '>=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('22.6.0', '>=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('24.0.0', '>=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('22.4.0', '>=22.5.0')).toBe(false);
    expect(nodeRangeSatisfied('20.10.0', '>=22.5.0')).toBe(false);
  });

  it('strips leading "v" from current version', () => {
    expect(nodeRangeSatisfied('v22.5.0', '>=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('v20.10.0', '>=22.5.0')).toBe(false);
  });

  it('handles >, <, <=, = comparators', () => {
    expect(nodeRangeSatisfied('22.5.0', '>22.5.0')).toBe(false);
    expect(nodeRangeSatisfied('22.5.1', '>22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('22.5.0', '<23.0.0')).toBe(true);
    expect(nodeRangeSatisfied('23.0.0', '<23.0.0')).toBe(false);
    expect(nodeRangeSatisfied('22.5.0', '<=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('22.5.0', '=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('22.5.1', '=22.5.0')).toBe(false);
  });

  it('handles whitespace-AND ranges', () => {
    expect(nodeRangeSatisfied('20.5.0', '>=18.0.0 <23.0.0')).toBe(true);
    expect(nodeRangeSatisfied('17.0.0', '>=18.0.0 <23.0.0')).toBe(false);
    expect(nodeRangeSatisfied('23.0.0', '>=18.0.0 <23.0.0')).toBe(false);
  });

  it('handles || OR ranges', () => {
    expect(nodeRangeSatisfied('18.20.0', '>=18 <19 || >=20')).toBe(true);
    expect(nodeRangeSatisfied('21.0.0', '>=18 <19 || >=20')).toBe(true);
    expect(nodeRangeSatisfied('19.5.0', '>=18 <19 || >=20')).toBe(false);
  });

  it('handles ^ caret (major lock)', () => {
    expect(nodeRangeSatisfied('22.5.0', '^22.0.0')).toBe(true);
    expect(nodeRangeSatisfied('22.99.99', '^22.0.0')).toBe(true);
    expect(nodeRangeSatisfied('23.0.0', '^22.0.0')).toBe(false);
    expect(nodeRangeSatisfied('21.99.99', '^22.0.0')).toBe(false);
  });

  it('handles ~ tilde (minor lock)', () => {
    expect(nodeRangeSatisfied('22.5.3', '~22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('22.6.0', '~22.5.0')).toBe(false);
    expect(nodeRangeSatisfied('22.4.9', '~22.5.0')).toBe(false);
  });

  it('handles partial version strings (>=22 / >=22.5)', () => {
    expect(nodeRangeSatisfied('22.0.0', '>=22')).toBe(true);
    expect(nodeRangeSatisfied('21.99.99', '>=22')).toBe(false);
    expect(nodeRangeSatisfied('22.5.0', '>=22.5')).toBe(true);
    expect(nodeRangeSatisfied('22.4.99', '>=22.5')).toBe(false);
  });

  it('fails OPEN on unparseable input — never blocks a legit upgrade', () => {
    // garbage range → assume satisfied
    expect(nodeRangeSatisfied('20.0.0', 'not-a-range')).toBe(true);
    // garbage current version → assume satisfied
    expect(nodeRangeSatisfied('garbage', '>=22.0.0')).toBe(true);
  });

  it('matches the real-world @yeaft/webchat-agent constraint', () => {
    // The package's own engines.node is ">=22.5.0". Make sure we'd block a
    // Node 20 upgrade and allow a Node 22.5+ upgrade.
    expect(nodeRangeSatisfied('v22.5.0', '>=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('v22.10.0', '>=22.5.0')).toBe(true);
    expect(nodeRangeSatisfied('v20.10.0', '>=22.5.0')).toBe(false);
    expect(nodeRangeSatisfied('v18.18.0', '>=22.5.0')).toBe(false);
  });
});
