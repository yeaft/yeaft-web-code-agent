/**
 * SidebarModeToggle — contract test.
 *
 * v0.1.880+: the lightning-icon Yeaft entry shipped in #885 is replaced
 * by an iOS-style slide switch. This test pins the wire contract so
 * future refactors can't accidentally break:
 *   - emits a 'flip' event with the *target* view, not the current one
 *   - flips both directions (Chat → Yeaft and Yeaft → Chat)
 *   - exposes role="switch" + aria-pressed for accessibility
 *   - disables click + keyboard when no online agents
 *
 * We don't mount Vue — the template is a string in the component file,
 * mirroring vp-avatar-typing.test.js's approach. Logic that needs
 * exercising goes through the module's methods directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import SidebarModeToggle from '../../web/components/SidebarModeToggle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const src = readFileSync(join(repoRoot, 'web/components/SidebarModeToggle.js'), 'utf8');

function mkInstance(view, disabled = false) {
  const emitted = [];
  const vm = {
    view, disabled,
    isYeaft: view === 'yeaft',
    $emit(name, payload) { emitted.push([name, payload]); },
    $t: (k) => k,
  };
  // Bind methods to the fake instance
  const methods = SidebarModeToggle.methods;
  for (const k of Object.keys(methods)) vm[k] = methods[k].bind(vm);
  return { vm, emitted };
}

describe('SidebarModeToggle', () => {
  it('emits flip with target view on click (chat → yeaft)', () => {
    const { vm, emitted } = mkInstance('chat');
    vm.onClick();
    expect(emitted).toEqual([['flip', 'yeaft']]);
  });

  it('emits flip with target view on click (yeaft → chat)', () => {
    const { vm, emitted } = mkInstance('yeaft');
    vm.onClick();
    expect(emitted).toEqual([['flip', 'chat']]);
  });

  it('swallows clicks when disabled', () => {
    const { vm, emitted } = mkInstance('chat', true);
    vm.onClick();
    expect(emitted).toEqual([]);
  });

  it('ArrowRight goes to yeaft from chat', () => {
    const { vm, emitted } = mkInstance('chat');
    const e = { key: 'ArrowRight', preventDefault: () => {} };
    vm.onKeydown(e);
    expect(emitted).toEqual([['flip', 'yeaft']]);
  });

  it('ArrowLeft goes to chat from yeaft', () => {
    const { vm, emitted } = mkInstance('yeaft');
    const e = { key: 'ArrowLeft', preventDefault: () => {} };
    vm.onKeydown(e);
    expect(emitted).toEqual([['flip', 'chat']]);
  });

  it('ArrowRight is a no-op when already on yeaft', () => {
    const { vm, emitted } = mkInstance('yeaft');
    vm.onKeydown({ key: 'ArrowRight', preventDefault: () => {} });
    expect(emitted).toEqual([]);
  });

  it('Enter / Space activate the toggle', () => {
    const { vm, emitted } = mkInstance('chat');
    vm.onKeydown({ key: 'Enter', preventDefault: () => {} });
    vm.onKeydown({ key: ' ', preventDefault: () => {} });
    expect(emitted).toEqual([['flip', 'yeaft'], ['flip', 'yeaft']]);
  });

  it('template advertises role="switch" + aria-pressed', () => {
    expect(src).toMatch(/role="switch"/);
    expect(src).toMatch(/aria-pressed/);
  });

  it('template has a thumb (plain switch — no inner labels)', () => {
    expect(src).toMatch(/mode-toggle-thumb/);
    expect(src).not.toMatch(/mode-toggle-label/);
  });
});
