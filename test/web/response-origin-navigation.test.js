import { describe, expect, it } from 'vitest';
import {
  longResponseViewportThreshold,
  resolveLongResponseOrigin,
} from '../../web/utils/response-origin-navigation.js';

describe('long response origin navigation', () => {
  it('requires a response to span at least two transcript viewports', () => {
    expect(longResponseViewportThreshold).toBe(2);
    expect(resolveLongResponseOrigin({
      viewportTop: 0,
      viewportHeight: 600,
      responses: [
        { originMessageId: 'short', top: 0, bottom: 1199, height: 1199 },
      ],
    })).toBe('');

    expect(resolveLongResponseOrigin({
      viewportTop: 0,
      viewportHeight: 600,
      responses: [
        { originMessageId: 'long', top: -1, bottom: 1199, height: 1200 },
      ],
    })).toBe('long');
    expect(resolveLongResponseOrigin({
      viewportTop: 0,
      viewportHeight: 600,
      responses: [
        { originMessageId: 'opening-visible', top: 0, bottom: 1200, height: 1200 },
      ],
    })).toBe('');
  });

  it('selects only the long response crossing the reader line', () => {
    expect(resolveLongResponseOrigin({
      viewportTop: 900,
      viewportHeight: 500,
      responses: [
        { originMessageId: 'earlier', top: -700, bottom: 850, height: 1550 },
        { originMessageId: 'current', top: 800, bottom: 2400, height: 1600 },
      ],
    })).toBe('current');
  });

  it('falls back to the most visible long response and ignores missing origins', () => {
    expect(resolveLongResponseOrigin({
      viewportTop: 0,
      viewportHeight: 400,
      readingLineRatio: 0.5,
      responses: [
        { originMessageId: '', top: -20, bottom: 1180, height: 1200 },
        { originMessageId: 'leaving', top: -700, bottom: 100, height: 800 },
        { originMessageId: 'current', top: -500, bottom: 300, height: 800 },
      ],
    })).toBe('current');
  });

  it('hides the action when no long response is visible or the viewport is unavailable', () => {
    const responses = [{ originMessageId: 'long', top: 900, bottom: 1900, height: 1000 }];
    expect(resolveLongResponseOrigin({ viewportTop: 0, viewportHeight: 400, responses })).toBe('');
    expect(resolveLongResponseOrigin({ viewportTop: 0, viewportHeight: 0, responses })).toBe('');
  });
});
