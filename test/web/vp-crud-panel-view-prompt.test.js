/**
 * vp-crud-panel-view-prompt.test.js — exercise the new "View prompt" +
 * stock-readonly behaviour of VpCrudPanel.
 *
 * Strategy: import the component object directly and drive its methods +
 * data as plain JS — same approach UnifyPage/Phase tests use across this
 * repo (no Vue mount/render, since the project keeps the runtime via CDN
 * and tests stay node-level).
 *
 * What we assert:
 *   1. startView(stockVp)   → view becomes 'detail', detail.isStock true
 *      and persona body is populated from the chatStore read.
 *   2. startView(customVp)  → view='detail', detail.isStock false.
 *   3. startEdit(stockVp)   → REFUSED (view stays 'list'); defence-in-depth
 *      against a template :disabled bypass.
 *   4. confirmDelete(stockVp) → REFUSED (no vpCrudRequest('delete') call).
 *   5. editFromDetail()     → custom VP: jumps to form; stock VP: refused.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// VpCrudPanel transitively imports `web/stores/vp.js`, which does
// `const { defineStore } = Pinia` at module-eval time. The web layer
// gets Pinia from a CDN <script> tag at runtime; under vitest we have
// to stub it BEFORE the dynamic import below resolves.
globalThis.Pinia = globalThis.Pinia || {
  defineStore: (_name, _schema) => () => ({}),
  useChatStore: () => ({}),
};

const { default: VpCrudPanel } = await import('../../web/components/VpCrudPanel.js');

/**
 * Build a stand-in component instance: VpCrudPanel exports an Options-API
 * object. We instantiate `data()` once, then bind every method onto a
 * plain object that also stubs `$t`, `chatStore`, and `$refs` so the
 * methods can run.
 */
function mkInstance({ vpReadResult = null, vpReadError = null, vpDeleteResult = null } = {}) {
  // VpCrudPanel.data() calls `this.blankForm()`, so we need to call it
  // with a `this` that has the methods bag bound.
  const stubThis = {};
  for (const [name, fn] of Object.entries(VpCrudPanel.methods)) {
    stubThis[name] = fn.bind(stubThis);
  }
  const data = VpCrudPanel.data.call(stubThis);
  const ctx = {
    ...data,
    $t: (key) => key, // identity i18n stub — tests assert on keys, not text.
    $refs: {},
    $nextTick: (fn) => { if (fn) fn(); return Promise.resolve(); },
  };
  // Bind methods FIRST, then override chatStore (the component's
  // chatStore() method reaches for `window.Pinia` which is undefined
  // under vitest; our stub returns the configured fake instead).
  for (const [name, fn] of Object.entries(VpCrudPanel.methods)) {
    ctx[name] = fn.bind(ctx);
  }
  ctx.chatStore = () => ({
    vpCrudRequest: vi.fn(async (op /*, payload */) => {
      if (op === 'read') {
        if (vpReadError) throw vpReadError;
        return vpReadResult || { ok: true, vp: { vpId: 'x', persona: '' } };
      }
      if (op === 'delete') {
        return vpDeleteResult || { ok: true };
      }
      return { ok: false, error: { code: 'unknown' } };
    }),
  });
  return ctx;
}

const stockVp = { vpId: 'steve', displayName: 'Steve', role: 'Visionary', isStock: true };
const customVp = { vpId: 'my_vp', displayName: 'Mine', role: 'helper', isStock: false };

describe('VpCrudPanel — View prompt + stock-readonly gating', () => {
  let inst;
  beforeEach(() => {
    inst = mkInstance({
      vpReadResult: {
        ok: true,
        vp: {
          vpId: 'steve',
          displayName: 'Steve',
          role: 'Visionary',
          traits: ['relentless', 'minimalist'],
          modelHint: 'primary',
          persona: 'You are Steve. Make things insanely great.',
        },
      },
    });
  });

  it('startView(stockVp) populates detail with isStock=true and switches view to detail', async () => {
    await inst.startView(stockVp);
    expect(inst.view).toBe('detail');
    expect(inst.detail).toBeTruthy();
    expect(inst.detail.vpId).toBe('steve');
    expect(inst.detail.displayName).toBe('Steve');
    expect(inst.detail.role).toBe('Visionary');
    expect(inst.detail.traits).toEqual(['relentless', 'minimalist']);
    expect(inst.detail.modelHint).toBe('primary');
    expect(inst.detail.persona).toContain('insanely great');
    expect(inst.detail.isStock).toBe(true);
    expect(inst.detailLoading).toBe(false);
    expect(inst.detailError).toBe('');
  });

  it('startView(customVp) keeps isStock=false on the detail record', async () => {
    inst = mkInstance({
      vpReadResult: {
        ok: true,
        vp: { vpId: 'my_vp', displayName: 'Mine', persona: 'custom body' },
      },
    });
    await inst.startView(customVp);
    expect(inst.view).toBe('detail');
    expect(inst.detail.isStock).toBe(false);
    expect(inst.detail.persona).toBe('custom body');
  });

  it('startView surfaces a translated error if the read fails', async () => {
    inst = mkInstance({
      vpReadResult: { ok: false, error: { code: 'not_found', message: 'gone' } },
    });
    await inst.startView(stockVp);
    expect(inst.view).toBe('detail');
    expect(inst.detail).toBeNull();
    // The component prefers `translated && translated !== key ?
    // translated : message || code`. With our identity $t stub the
    // "translated" branch is skipped (key === translation), so the
    // server's message text bubbles through unchanged — which is the
    // observable behaviour in the UI when no i18n entry exists.
    expect(inst.detailError).toBe('gone');
  });

  it('startView falls back to error code when no server message is provided', async () => {
    inst = mkInstance({
      vpReadResult: { ok: false, error: { code: 'unknown' } },
    });
    await inst.startView(stockVp);
    expect(inst.view).toBe('detail');
    expect(inst.detail).toBeNull();
    expect(inst.detailError).toBe('unknown');
  });

  it('startEdit(stockVp) is refused (defence-in-depth) — view stays list', async () => {
    expect(inst.view).toBe('list');
    await inst.startEdit(stockVp);
    expect(inst.view).toBe('list');
    expect(inst.editing).toBeNull();
  });

  it('confirmDelete(stockVp) is refused — no delete request is sent', async () => {
    // We have to capture the chatStore's vpCrudRequest fn for the assert.
    const reqSpy = vi.fn(async () => ({ ok: true }));
    inst.chatStore = () => ({ vpCrudRequest: reqSpy });
    await inst.confirmDelete(stockVp);
    expect(reqSpy).not.toHaveBeenCalled();
    expect(inst.formError).toBe('');
  });

  it('editFromDetail() on a stock detail is refused', async () => {
    await inst.startView(stockVp);
    expect(inst.detail.isStock).toBe(true);
    inst.editFromDetail();
    // stays in detail; never jumps to form.
    expect(inst.view).toBe('detail');
    expect(inst.editing).toBeNull();
  });

  it('editFromDetail() on a custom detail jumps to form pre-filled', async () => {
    inst = mkInstance({
      vpReadResult: {
        ok: true,
        vp: {
          vpId: 'my_vp',
          displayName: 'Mine',
          role: 'helper',
          traits: ['concise'],
          modelHint: 'fast',
          persona: 'custom body',
        },
      },
    });
    await inst.startView(customVp);
    expect(inst.detail.isStock).toBe(false);
    inst.editFromDetail();
    expect(inst.view).toBe('form');
    expect(inst.editing).toEqual({ vpId: 'my_vp' });
    expect(inst.form.displayName).toBe('Mine');
    expect(inst.form.role).toBe('helper');
    expect(inst.form.traitsRaw).toBe('concise');
    expect(inst.form.modelHint).toBe('fast');
    expect(inst.form.persona).toBe('custom body');
    expect(inst.idStatus).toBe('ok');
  });
});
