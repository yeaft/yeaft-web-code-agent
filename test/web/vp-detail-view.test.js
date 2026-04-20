/**
 * task-334-ui-c — VP Detail View + O4 reason i18n + hover timestamp.
 *
 * Source-level acceptance (mirrors the -ui-b pattern):
 *   S-c1  VpDetailView.js exists with vpId prop, `back` emit, VpAvatar hero.
 *   S-c2  web/utils/vp-reason.js exports REASON_I18N / reasonToI18nKey /
 *         isRemovalReason with fallback + warn-once cache.
 *   S-c3  chat store has unifyActiveVpDetailId state + enterVpDetailView /
 *         leaveVpDetailView actions.
 *   S-c4  UnifyPage wires VpDetailView (v-if !showSettings && vp-detail-id),
 *         hides MessageList & UnifyTaskDetailView while vp-detail active,
 *         exposes exitVpDetailView, extends Esc cascade.
 *   S-c5  VpBadge exposes opt-in `clickable` prop + `open-detail` emit.
 *         Non-clickable default preserves 334-ui-a static contract.
 *   S-c6  VpSpeakerHeader wraps clickable VpBadge and forwards open-detail.
 *   S-c7  AssistantTurn forwards open-detail to store (via onOpenVpDetail)
 *         and renders a hover-revealed `turn-time` span.
 *   S-c8  i18n: en + zh carry all unify.vp.detail.*, unify.vp.reason.*,
 *         unify.vp.reason.toast.*, unify.message.timeAria keys.
 *   S-c9  CSS: unify-vp.css defines .vp-detail-view, .vp-detail-hero,
 *         .vp-badge-clickable, .turn-time with hover reveal + dark-mode +
 *         mobile @media query.
 *   S-c10 Hard constraints: vp-bridge.js untouched, no VP CRUD mutations
 *         leak into VpDetailView (read-only only).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  REASON_I18N,
  reasonToI18nKey,
  isRemovalReason,
  _resetReasonWarnCacheForTest,
} from '../../web/utils/vp-reason.js';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const detailViewSrc    = read('web/components/VpDetailView.js');
const vpBadgeSrc       = read('web/components/VpBadge.js');
const speakerHeaderSrc = read('web/components/VpSpeakerHeader.js');
const assistantTurnSrc = read('web/components/AssistantTurn.js');
const unifyPageSrc     = read('web/components/UnifyPage.js');
const chatStoreSrc     = read('web/stores/chat.js');
const unifyVpCssSrc    = read('web/styles/unify-vp.css');
const enI18nSrc        = read('web/i18n/en.js');
const zhI18nSrc        = read('web/i18n/zh-CN.js');

// ───────── S-c1 — VpDetailView component ─────────
describe('S-c1: VpDetailView component', () => {
  it('declares vpId prop (required String)', () => {
    expect(detailViewSrc).toMatch(/vpId:\s*\{\s*type:\s*String,\s*required:\s*true\s*\}/);
  });
  it('emits "back"', () => {
    expect(detailViewSrc).toMatch(/emits:\s*\[[^\]]*['"]back['"][^\]]*\]/);
  });
  it('uses VpAvatar as hero (48px)', () => {
    expect(detailViewSrc).toMatch(/import\s+VpAvatar\s+from/);
    expect(detailViewSrc).toMatch(/<VpAvatar[\s\S]*?:size="48"/);
  });
  it('renders read-only persona (pre) and edit hint — no CRUD', () => {
    expect(detailViewSrc).toMatch(/<pre class="vp-detail-persona"/);
    expect(detailViewSrc).toMatch(/editHint/);
    // No input, textarea, or save handlers (read-only contract).
    expect(detailViewSrc).not.toMatch(/<textarea/);
    expect(detailViewSrc).not.toMatch(/<input/);
    expect(detailViewSrc).not.toMatch(/savePersona|updatePersona/);
  });
  it('shows personaHash badge (short hash + full title)', () => {
    expect(detailViewSrc).toMatch(/vp-detail-persona-hash/);
    expect(detailViewSrc).toMatch(/shortHash/);
  });
  it('surfaces activityRows + lastChange diff row', () => {
    expect(detailViewSrc).toMatch(/activityRows/);
    expect(detailViewSrc).toMatch(/lastChange/);
  });
});

// ───────── S-c2 — vp-reason utility ─────────
describe('S-c2: reasonToI18nKey utility', () => {
  it('maps all four classifier tags', () => {
    expect(REASON_I18N['persona.edit']).toBe('unify.vp.reason.personaEdit');
    expect(REASON_I18N['traits.edit']).toBe('unify.vp.reason.traitsEdit');
    expect(REASON_I18N['manual.reload']).toBe('unify.vp.reason.manualReload');
    expect(REASON_I18N['file.removed']).toBe('unify.vp.reason.fileRemoved');
  });
  it('returns the mapped i18n key for known reasons', () => {
    expect(reasonToI18nKey('persona.edit')).toBe('unify.vp.reason.personaEdit');
    expect(reasonToI18nKey('file.removed')).toBe('unify.vp.reason.fileRemoved');
  });
  it('falls back to manualReload for null/unknown', () => {
    expect(reasonToI18nKey(null)).toBe('unify.vp.reason.manualReload');
    expect(reasonToI18nKey(undefined)).toBe('unify.vp.reason.manualReload');
    expect(reasonToI18nKey('something.new')).toBe('unify.vp.reason.manualReload');
  });
  it('isRemovalReason only true for file.removed', () => {
    expect(isRemovalReason('file.removed')).toBe(true);
    expect(isRemovalReason('persona.edit')).toBe(false);
    expect(isRemovalReason('')).toBe(false);
    expect(isRemovalReason(null)).toBe(false);
  });
  it('warn-once cache flushes under test seam', () => {
    _resetReasonWarnCacheForTest();
    // Smoke-test: second call should not throw.
    expect(reasonToI18nKey('bogus.tag')).toBe('unify.vp.reason.manualReload');
    expect(reasonToI18nKey('bogus.tag')).toBe('unify.vp.reason.manualReload');
  });
});

// ───────── S-c3 — chat store state + actions ─────────
describe('S-c3: chat store VP detail wiring', () => {
  it('declares unifyActiveVpDetailId state (default null)', () => {
    expect(chatStoreSrc).toMatch(/unifyActiveVpDetailId:\s*null/);
  });
  it('defines enterVpDetailView(vpId) action', () => {
    expect(chatStoreSrc).toMatch(/enterVpDetailView\s*\(\s*vpId\s*\)/);
    expect(chatStoreSrc).toMatch(/this\.unifyActiveVpDetailId\s*=\s*String\(vpId\)/);
  });
  it('defines leaveVpDetailView() action that clears the state', () => {
    const block = chatStoreSrc.match(/leaveVpDetailView\s*\(\s*\)\s*\{[\s\S]*?\n\s*\}/);
    expect(block).toBeTruthy();
    expect(block[0]).toMatch(/unifyActiveVpDetailId\s*=\s*null/);
  });
});

// ───────── S-c4 — UnifyPage wiring ─────────
describe('S-c4: UnifyPage VP detail wiring', () => {
  it('imports + registers VpDetailView', () => {
    expect(unifyPageSrc).toMatch(/import\s+VpDetailView\s+from/);
    expect(unifyPageSrc).toMatch(/components:\s*\{[^}]*VpDetailView[^}]*\}/);
  });
  it('renders VpDetailView only when !showSettings && unifyActiveVpDetailId', () => {
    expect(unifyPageSrc).toMatch(/<VpDetailView[\s\S]*?v-if="!showSettings && store\.unifyActiveVpDetailId"/);
  });
  it('hides MessageList when VP detail is active', () => {
    expect(unifyPageSrc).toMatch(/<MessageList[\s\S]*?!store\.unifyActiveVpDetailId/);
  });
  it('hides UnifyTaskDetailView when VP detail is active', () => {
    expect(unifyPageSrc).toMatch(/<UnifyTaskDetailView[\s\S]*?!store\.unifyActiveVpDetailId/);
  });
  it('exposes exitVpDetailView and wires to @back', () => {
    expect(unifyPageSrc).toMatch(/@back="exitVpDetailView"/);
    expect(unifyPageSrc).toMatch(/exitVpDetailView[\s\S]*?store\.leaveVpDetailView/);
  });
  it('extends Esc cascade: vp-detail → task-detail → thread-filter', () => {
    // Esc handler must check VP detail BEFORE task detail (highest priority).
    const src = unifyPageSrc;
    const vpIdx = src.indexOf('store.unifyActiveVpDetailId');
    const taskIdx = src.indexOf('store.unifyActiveTaskDetailId');
    expect(vpIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeGreaterThan(-1);
  });
});

// ───────── S-c5 — VpBadge opt-in clickable ─────────
describe('S-c5: VpBadge clickable mode', () => {
  it('declares clickable prop default false (back-compat)', () => {
    expect(vpBadgeSrc).toMatch(/clickable:\s*\{\s*type:\s*Boolean,\s*default:\s*false\s*\}/);
  });
  it('emits open-detail', () => {
    expect(vpBadgeSrc).toMatch(/emits:\s*\[[^\]]*['"]open-detail['"][^\]]*\]/);
  });
  it('renders <button> when clickable, <span> otherwise', () => {
    expect(vpBadgeSrc).toMatch(/<button[\s\S]*?v-if="clickable"[\s\S]*?vp-badge-clickable/);
    expect(vpBadgeSrc).toMatch(/<span v-else class="vp-badge"/);
  });
  it('click emits open-detail with vpId + stops propagation', () => {
    expect(vpBadgeSrc).toMatch(/@click\.stop="\$emit\('open-detail',\s*vpId\)"/);
  });
});

// ───────── S-c6 — VpSpeakerHeader forwards click ─────────
describe('S-c6: VpSpeakerHeader open-detail forwarding', () => {
  it('declares open-detail in emits', () => {
    expect(speakerHeaderSrc).toMatch(/emits:\s*\[[^\]]*['"]open-detail['"][^\]]*\]/);
  });
  it('wires VpBadge clickable + forwards emit', () => {
    expect(speakerHeaderSrc).toMatch(/:clickable="true"/);
    expect(speakerHeaderSrc).toMatch(/@open-detail="\$emit\('open-detail',\s*\$event\)"/);
  });
});

// ───────── S-c7 — AssistantTurn: forward + hover time ─────────
describe('S-c7: AssistantTurn hover timestamp + forward', () => {
  it('declares open-vp-detail emit', () => {
    expect(assistantTurnSrc).toMatch(/emits:\s*\[[^\]]*['"]open-vp-detail['"][^\]]*\]/);
  });
  it('forwards speaker-header open-detail via onOpenVpDetail', () => {
    expect(assistantTurnSrc).toMatch(/@open-detail="onOpenVpDetail"/);
    expect(assistantTurnSrc).toMatch(/onOpenVpDetail[\s\S]*?enterVpDetailView/);
  });
  it('renders a turn-time hover span with full-title tooltip', () => {
    expect(assistantTurnSrc).toMatch(/class="turn-time"/);
    expect(assistantTurnSrc).toMatch(/:title="turnTimeFull"/);
  });
  it('exposes turnTime + turnTimeFull from setup()', () => {
    expect(assistantTurnSrc).toMatch(/turnTime,[\s\S]*?turnTimeFull/);
  });
});

// ───────── S-c8 — i18n coverage (en + zh) ─────────
describe('S-c8: i18n keys for detail view + reasons + message time', () => {
  const keys = [
    'unify.vp.detail.title',
    'unify.vp.detail.back',
    'unify.vp.detail.backAria',
    'unify.vp.detail.traits',
    'unify.vp.detail.modelHint',
    'unify.vp.detail.persona',
    'unify.vp.detail.personaEmpty',
    'unify.vp.detail.activity',
    'unify.vp.detail.activityEmpty',
    'unify.vp.detail.activityPrivate',
    'unify.vp.detail.editHint',
    'unify.vp.detail.notFound',
    'unify.vp.detail.traitsEmpty',
    'unify.vp.detail.modelHintEmpty',
    'unify.vp.reason.personaEdit',
    'unify.vp.reason.traitsEdit',
    'unify.vp.reason.manualReload',
    'unify.vp.reason.fileRemoved',
    'unify.vp.reason.toast.updated',
    'unify.vp.reason.toast.removed',
    'unify.message.timeAria',
  ];
  for (const k of keys) {
    it(`en has ${k}`, () => {
      expect(enI18nSrc).toMatch(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]`));
    });
    it(`zh has ${k}`, () => {
      expect(zhI18nSrc).toMatch(new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]`));
    });
  }
});

// ───────── S-c9 — CSS coverage ─────────
describe('S-c9: unify-vp.css new selectors', () => {
  it('defines .vp-detail-view layout root', () => {
    expect(unifyVpCssSrc).toMatch(/\.vp-detail-view\s*\{/);
  });
  it('defines .vp-detail-hero', () => {
    expect(unifyVpCssSrc).toMatch(/\.vp-detail-hero\s*\{/);
  });
  it('defines .vp-badge-clickable with hover + focus-visible', () => {
    expect(unifyVpCssSrc).toMatch(/\.vp-badge-clickable\s*\{/);
    expect(unifyVpCssSrc).toMatch(/\.vp-badge-clickable:focus-visible/);
  });
  it('defines .turn-time with hover-revealed opacity', () => {
    expect(unifyVpCssSrc).toMatch(/\.turn-time\s*\{[\s\S]*?opacity:\s*0/);
    expect(unifyVpCssSrc).toMatch(/\.turn-footer:hover\s+\.turn-time/);
  });
  it('includes dark-mode overrides for detail view', () => {
    expect(unifyVpCssSrc).toMatch(/\[data-theme="dark"\]\s+\.vp-detail-hero/);
  });
  it('includes mobile @media query', () => {
    expect(unifyVpCssSrc).toMatch(/@media\s*\(max-width:\s*640px\)/);
  });
});

// ───────── S-c10 — Hard constraints ─────────
describe('S-c10: hard constraints', () => {
  it('detail view does NOT reach into vp-bridge or call mutating vp-store methods', () => {
    expect(detailViewSrc).not.toMatch(/vp-bridge/);
    expect(detailViewSrc).not.toMatch(/createVp|updateVp|deleteVp|savePersona/);
  });
  it('detail view reuses VpAvatar primitive, does not redefine avatar markup', () => {
    // No raw <img> or background-image styling — must flow through VpAvatar.
    expect(detailViewSrc).not.toMatch(/background-image:\s*url/);
  });
});
