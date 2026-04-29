/**
 * Tests for web/utils/device.js — UA-based mobile / in-app browser
 * detection used to pick QR vs redirect SSO flows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isMobile, isInWeChat, isInAlipay } from '../../web/utils/device.js';

const _origNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setUA(ua) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua },
    configurable: true,
    writable: true
  });
}

afterEach(() => {
  if (_origNavigator) Object.defineProperty(globalThis, 'navigator', _origNavigator);
  else delete globalThis.navigator;
});

describe('isMobile', () => {
  it('detects iPhone Safari', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
    expect(isMobile()).toBe(true);
  });
  it('detects Android Chrome', () => {
    setUA('Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 Mobile Safari/537.36');
    expect(isMobile()).toBe(true);
  });
  it('detects iPad', () => {
    setUA('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148');
    expect(isMobile()).toBe(true);
  });
  it('returns false for desktop Chrome', () => {
    setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    expect(isMobile()).toBe(false);
  });
  it('returns false when navigator is missing', () => {
    Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
    expect(isMobile()).toBe(false);
  });
});

describe('isInWeChat', () => {
  it('detects MicroMessenger UA', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger/8.0');
    expect(isInWeChat()).toBe(true);
  });
  it('returns false for plain mobile Safari', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605');
    expect(isInWeChat()).toBe(false);
  });
});

describe('isInAlipay', () => {
  it('detects AlipayClient UA', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AlipayClient/10.5.50');
    expect(isInAlipay()).toBe(true);
  });
  it('returns false for plain mobile Safari', () => {
    setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605');
    expect(isInAlipay()).toBe(false);
  });
});
