/**
 * Regression tests for VpTimelinePane's text-only identity rendering.
 *
 * PR #846 removed the avatar component from the VP list and switched the row
 * label to an inline color helper. If that helper is not exposed from setup(),
 * Vue fails the render when the VP list pane is mounted, so clicking the topbar
 * VP-list toggle appears to do nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE = readFileSync(join(ROOT, 'web/components/VpTimelinePane.js'), 'utf8');

function loadComponent() {
  const module = { exports: {} };
  const factory = new Function(
    'module',
    'exports',
    'Vue',
    `${SOURCE.replace('export default', 'module.exports.default =')}`,
  );
  factory(module, module.exports, {
    getCurrentInstance: () => ({
      appContext: { config: { globalProperties: { $t: (k) => k } } },
    }),
  });
  return module.exports.default;
}

describe('VpTimelinePane', () => {
  it('exposes the text color helper used by the template', () => {
    const vpTextColor = vi.fn((id) => `color-for-${id}`);
    const oldWindow = globalThis.window;
    globalThis.window = {
      Pinia: {
        useVpStore: () => ({ vpTextColor }),
      },
    };

    try {
      const Comp = loadComponent();
      expect(Comp.template).toContain('vpTextColorFor(row.vpId)');

      const api = Comp.setup();
      expect(typeof api.vpTextColorFor).toBe('function');
      expect(api.vpTextColorFor('linus')).toBe('color-for-linus');
      expect(vpTextColor).toHaveBeenCalledWith('linus');
    } finally {
      globalThis.window = oldWindow;
    }
  });

  it('falls back to the primary text color when the VP store is unavailable', () => {
    const oldWindow = globalThis.window;
    globalThis.window = { Pinia: {} };

    try {
      const Comp = loadComponent();
      const api = Comp.setup();
      expect(api.vpTextColorFor('linus')).toBe('var(--text-primary)');
    } finally {
      globalThis.window = oldWindow;
    }
  });
});
