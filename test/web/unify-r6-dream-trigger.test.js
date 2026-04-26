/**
 * R6 G3 — Dream manual trigger + dream_activity status bar.
 *
 * Static source-level acceptance (vitest pattern matches the rest of the
 * R6 closing-gap slice):
 *   S1 vpStore exposes `dreamStatus` state, `dreamStatusFor` getter,
 *      `triggerDream` action, `applyDreamStatus` + `applyDreamResult`
 *      mutations.
 *   S2 chatStore dispatch table forwards `unify_dream_status` and
 *      `unify_dream_result` events to vpStore (the connective tissue —
 *      without these cases, the agent's events disappear into the void).
 *   S3 VpDetailView renders the dream status bar with a "Run dream now"
 *      button that calls `triggerDream(props.vpId)`.
 *   S4 i18n (en + zh-CN) carry all unify.vp.dream.* keys VpDetailView
 *      references — runNow / lastRun / running / errored / failed / etc.
 *   S5 Backend bridge already emits unify_dream_status (running) and
 *      unify_dream_result (success|error) from handleUnifyDreamTrigger;
 *      verify those emit shapes haven't drifted under us.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const vpStoreSrc       = read('web/stores/vp.js');
const chatStoreSrc     = read('web/stores/chat.js');
const detailViewSrc    = read('web/components/VpDetailView.js');
const enI18nSrc        = read('web/i18n/en.js');
const zhI18nSrc        = read('web/i18n/zh-CN.js');
const webBridgeSrc     = read('agent/unify/web-bridge.js');

describe('R6 G3 — vpStore dream status surface', () => {
  it('declares dreamStatus state', () => {
    expect(vpStoreSrc).toMatch(/dreamStatus:\s*\{\}/);
  });

  it('exposes dreamStatusFor getter with idle default', () => {
    expect(vpStoreSrc).toMatch(/dreamStatusFor:\s*\(state\)/);
    expect(vpStoreSrc).toMatch(/status:\s*'idle'/);
  });

  it('exposes triggerDream action that sends unify_dream_trigger', () => {
    expect(vpStoreSrc).toMatch(/triggerDream\s*\(\s*vpId\s*\)/);
    expect(vpStoreSrc).toMatch(/type:\s*'unify_dream_trigger'/);
    // optimistic: marks as running before agent confirms
    expect(vpStoreSrc).toMatch(/status:\s*'running'/);
  });

  it('exposes applyDreamStatus + applyDreamResult mutations', () => {
    expect(vpStoreSrc).toMatch(/applyDreamStatus\s*\(\s*event\s*\)/);
    expect(vpStoreSrc).toMatch(/applyDreamResult\s*\(\s*event\s*\)/);
    // success path stamps lastRunAt + lastResult; error path stamps lastError.
    expect(vpStoreSrc).toMatch(/lastRunAt:\s*Date\.now\(\)/);
    expect(vpStoreSrc).toMatch(/lastError/);
  });
});

describe('R6 G3 — chatStore dispatch wires dream events to vpStore', () => {
  it('handles unify_dream_status', () => {
    expect(chatStoreSrc).toMatch(/case 'unify_dream_status'/);
    expect(chatStoreSrc).toMatch(/applyDreamStatus\s*\(\s*event\s*\)/);
  });

  it('handles unify_dream_result', () => {
    expect(chatStoreSrc).toMatch(/case 'unify_dream_result'/);
    expect(chatStoreSrc).toMatch(/applyDreamResult\s*\(\s*event\s*\)/);
  });
});

describe('R6 G3 — VpDetailView dream status bar', () => {
  it('renders the dream section with run-now button', () => {
    expect(detailViewSrc).toMatch(/vp-detail-dream/);
    expect(detailViewSrc).toMatch(/unify\.vp\.dream\.runNow/);
    expect(detailViewSrc).toMatch(/onRunDream/);
  });

  it('disables the button while a dream is running', () => {
    expect(detailViewSrc).toMatch(/:disabled="dreamStatus\.status === 'running'"/);
  });

  it('calls vpStore.triggerDream on click', () => {
    expect(detailViewSrc).toMatch(/vpStore\.triggerDream\s*\(\s*props\.vpId\s*\)/);
  });

  it('uses dreamStatusFor + dreamStatusText computed', () => {
    expect(detailViewSrc).toMatch(/dreamStatusFor\s*\(\s*props\.vpId\s*\)/);
    expect(detailViewSrc).toMatch(/dreamStatusText/);
  });

  it('shows error message when last run errored', () => {
    expect(detailViewSrc).toMatch(/dreamStatus\.status === 'error'/);
    expect(detailViewSrc).toMatch(/unify\.vp\.dream\.failed/);
  });
});

describe('R6 G3 — i18n keys present in en + zh', () => {
  const requiredKeys = [
    'unify.vp.dream.runNow',
    'unify.vp.dream.runNowAria',
    'unify.vp.dream.never',
    'unify.vp.dream.running',
    'unify.vp.dream.lastRun',
    'unify.vp.dream.errored',
    'unify.vp.dream.failed',
  ];
  for (const key of requiredKeys) {
    it(`en carries ${key}`, () => {
      expect(enI18nSrc).toContain(`'${key}'`);
    });
    it(`zh-CN carries ${key}`, () => {
      expect(zhI18nSrc).toContain(`'${key}'`);
    });
  }
});

describe('R6 G3 — backend emit shape stability (no drift under us)', () => {
  it('handleUnifyDreamTrigger still emits unify_dream_status running', () => {
    expect(webBridgeSrc).toMatch(/type:\s*'unify_dream_status'/);
    expect(webBridgeSrc).toMatch(/status:\s*'running'/);
  });

  it('handleUnifyDreamTrigger still emits unify_dream_result with success flag', () => {
    expect(webBridgeSrc).toMatch(/type:\s*'unify_dream_result'/);
    expect(webBridgeSrc).toMatch(/success:/);
  });
});
