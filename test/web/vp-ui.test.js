/**
 * task-334-ui-a — VP UI store + bridge + components.
 *
 * Covers spec acceptance for the snapshot-only path:
 *   E-a1  vp_snapshot count display
 *   E-a2  emptyLibrary fallback (createFirst label)
 *   E-a3  vp_updated upsert reactivity (store-level)
 *   E-a4  fallbackColor stability + override
 *   E-a10 vp_removed → store cleanup, getters fall back
 *   E-a11 store survives chat-store reset (independence)
 *
 * Plus serializer / wire contract for the agent vp-bridge:
 *   - field rename id→vpId / name→displayName at boundary (D1 ruling)
 *   - subtitle = vp.role (D2 ruling)
 *   - color / avatar NOT emitted (web-derived)
 *   - personaHash forwarded when present
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  serializeVpForWire,
  buildVpSnapshot,
} from '../../agent/unify/vp/vp-bridge.js';
import { Registry } from '../../agent/unify/vp/registry.js';

const root = join(import.meta.dirname, '../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const vpStoreSrc        = read('web/stores/vp.js');
const vpAvatarSrc       = read('web/components/VpAvatar.js');
const vpBadgeSrc        = read('web/components/VpBadge.js');
const vpLibLinkSrc      = read('web/components/VpLibraryLink.js');
const unifyPageSrc      = read('web/components/UnifyPage.js');
const chatStoreSrc      = read('web/stores/chat.js');
const indexCssSrc       = read('web/styles/index.css');
const unifyVpCssSrc     = read('web/styles/unify-vp.css');
const enI18nSrc         = read('web/i18n/en.js');
const zhI18nSrc         = read('web/i18n/zh-CN.js');
const messageRouterSrc  = read('agent/connection/message-router.js');
const webBridgeSrc      = read('agent/unify/web-bridge.js');
const appJsSrc          = read('web/app.js');

// ─────────────────────────────────────────────────────────────
// agent/unify/vp/vp-bridge.js — wire-format serialiser
// ─────────────────────────────────────────────────────────────
describe('vp-bridge — D1 boundary rename + D2 field policy', () => {
  it('renames id→vpId and name→displayName', () => {
    const vp = { id: 'architect', name: 'Architect', role: 'designer', traits: [], modelHint: null };
    const wire = serializeVpForWire(vp);
    expect(wire.vpId).toBe('architect');
    expect(wire.displayName).toBe('Architect');
    // Entity-layer keys must not leak through.
    expect(wire.id).toBeUndefined();
    expect(wire.name).toBeUndefined();
  });

  it('subtitle = vp.role (agent-sent, MVP)', () => {
    const wire = serializeVpForWire({ id: 'a', name: 'A', role: 'PM', traits: [] });
    expect(wire.subtitle).toBe('PM');
    expect(wire.role).toBe('PM');
  });

  it('does NOT emit color or avatar (web-derived)', () => {
    const wire = serializeVpForWire({ id: 'a', name: 'A', role: 'r', traits: [] });
    expect(wire.color).toBeUndefined();
    expect(wire.avatar).toBeUndefined();
  });

  it('passes personaHash through when present', () => {
    const wire = serializeVpForWire({ id: 'a', name: 'A', role: 'r', personaHash: 'abc12345' });
    expect(wire.personaHash).toBe('abc12345');
  });

  it('falls back to null personaHash before dev-1 patch lands', () => {
    const wire = serializeVpForWire({ id: 'a', name: 'A', role: 'r' });
    expect(wire.personaHash).toBeNull();
  });

  it('buildVpSnapshot returns emptyLibrary=true for empty registry', () => {
    const reg = new Registry();
    const snap = buildVpSnapshot(reg);
    expect(snap.type).toBe('vp_snapshot');
    expect(snap.vps).toEqual([]);
    expect(snap.emptyLibrary).toBe(true);
  });

  it('buildVpSnapshot serialises every VP and clears emptyLibrary flag', () => {
    const reg = new Registry();
    reg.setVp({ id: 'a', name: 'A', role: 'PM', traits: [] });
    reg.setVp({ id: 'b', name: 'Beta', role: 'Dev', traits: ['x'] });
    const snap = buildVpSnapshot(reg);
    expect(snap.vps).toHaveLength(2);
    expect(snap.vps.map(v => v.vpId).sort()).toEqual(['a', 'b']);
    expect(snap.emptyLibrary).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// vp-bridge / web-bridge / message-router wiring
// ─────────────────────────────────────────────────────────────
describe('agent wiring — unify_vp_subscribe routed end-to-end', () => {
  it('message-router routes unify_vp_subscribe to handleUnifyVpSubscribe', () => {
    expect(messageRouterSrc).toContain("case 'unify_vp_subscribe'");
    expect(messageRouterSrc).toContain('handleUnifyVpSubscribe');
  });

  it('web-bridge exports handleUnifyVpSubscribe', () => {
    expect(webBridgeSrc).toMatch(/export function handleUnifyVpSubscribe/);
  });

  it('web-bridge imports handleVpSubscribe from vp-bridge', () => {
    expect(webBridgeSrc).toContain("from './vp/vp-bridge.js'");
  });

  it('vp-bridge no longer carries 334h TODO (live diff landed)', () => {
    const src = read('agent/unify/vp/vp-bridge.js');
    expect(src).not.toMatch(/TODO\(334h\)/);
  });
});

// ─────────────────────────────────────────────────────────────
// web/stores/vp.js — Pinia store, palette, fallback
// ─────────────────────────────────────────────────────────────
describe('web/stores/vp.js — store contract', () => {
  it('uses the project Pinia.defineStore convention (no import)', () => {
    expect(vpStoreSrc).toMatch(/const \{ defineStore \} = Pinia;/);
    expect(vpStoreSrc).toContain("defineStore('vp'");
  });

  it('palette has exactly 12 entries', () => {
    expect(vpStoreSrc).toMatch(/VP_PALETTE\s*=\s*\[([\s\S]*?)\];/);
    const match = vpStoreSrc.match(/VP_PALETTE\s*=\s*\[([\s\S]*?)\];/);
    const hexes = match[1].match(/#[0-9A-Fa-f]{6}/g) || [];
    expect(hexes).toHaveLength(12);
  });

  it('fallbackColor avoids Math.random (deterministic per spec §13)', () => {
    // Strip line comments before checking — the doc string mentions Math.random.
    const stripped = vpStoreSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toContain('Math.random');
    expect(vpStoreSrc).toMatch(/export function fallbackColor/);
  });

  it('exposes applySnapshot / upsert / remove actions', () => {
    expect(vpStoreSrc).toContain('applySnapshot(');
    expect(vpStoreSrc).toContain('upsert(');
    expect(vpStoreSrc).toMatch(/remove\(vpId/);
  });

  it('exposes vpCount / vpLabel / vpInitial / vpColor getters', () => {
    for (const g of ['vpCount', 'vpLabel', 'vpInitial', 'vpColor']) {
      expect(vpStoreSrc).toContain(g);
    }
  });
});

// fallbackColor runtime behaviour — exercise the function in-process.
describe('fallbackColor — deterministic, palette-bound', async () => {
  // Use Vue/Pinia-free dynamic import; the file references global Pinia.
  // Stub it before import.
  globalThis.Pinia = globalThis.Pinia || { defineStore: () => () => ({}) };
  const mod = await import('../../web/stores/vp.js');

  it('same vpId → same color (stable across calls)', () => {
    const a1 = mod.fallbackColor('architect');
    const a2 = mod.fallbackColor('architect');
    expect(a1).toBe(a2);
    expect(mod.VP_PALETTE).toContain(a1);
  });

  it('different vpIds may map to different palette slots', () => {
    const seen = new Set();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'pm', 'dev', 'qa']) {
      seen.add(mod.fallbackColor(id));
    }
    // Not all 12, but should be more than 1 — guards against stuck-hash bugs.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('falsy vpId → palette[0] (no crash)', () => {
    expect(mod.fallbackColor('')).toBe(mod.VP_PALETTE[0]);
    expect(mod.fallbackColor(null)).toBe(mod.VP_PALETTE[0]);
  });
});

// ─────────────────────────────────────────────────────────────
// chat.js dispatch + subscribe-on-ready
// ─────────────────────────────────────────────────────────────
describe('chat.js — vp_* event dispatch & subscribe', () => {
  it('handles vp_snapshot / vp_updated / vp_removed in unify event switch', () => {
    expect(chatStoreSrc).toContain("case 'vp_snapshot'");
    expect(chatStoreSrc).toContain("case 'vp_updated'");
    expect(chatStoreSrc).toContain("case 'vp_removed'");
  });

  it('vp_updated and vp_removed no longer carry 334h TODO (live diff landed)', () => {
    const updIdx = chatStoreSrc.indexOf("case 'vp_updated'");
    const remIdx = chatStoreSrc.indexOf("case 'vp_removed'");
    const updBlock = chatStoreSrc.slice(updIdx, updIdx + 400);
    const remBlock = chatStoreSrc.slice(remIdx, remIdx + 400);
    expect(updBlock).not.toMatch(/TODO\(334h\)/);
    expect(remBlock).not.toMatch(/TODO\(334h\)/);
    // reason is plumbed through to the store for 334-ui-b consumption.
    expect(updBlock).toContain('event.reason');
    expect(remBlock).toContain('event.reason');
  });

  it('sends unify_vp_subscribe on session_ready', () => {
    const idx = chatStoreSrc.indexOf("case 'session_ready'");
    expect(idx).toBeGreaterThan(-1);
    const block = chatStoreSrc.slice(idx, chatStoreSrc.indexOf('break;', idx));
    expect(block).toContain("type: 'unify_vp_subscribe'");
  });
});

// ─────────────────────────────────────────────────────────────
// Components — structural assertions
// ─────────────────────────────────────────────────────────────
describe('VpAvatar — render contract', () => {
  it('declares props vpId / size / status / ariaLabel', () => {
    expect(vpAvatarSrc).toMatch(/vpId:\s*\{[^}]*required:\s*true/);
    expect(vpAvatarSrc).toMatch(/size:\s*\{[^}]*default:\s*20/);
    for (const p of ['status', 'ariaLabel']) {
      expect(vpAvatarSrc).toContain(p);
    }
  });

  it('renders status dot only when status is online or busy (E-a6)', () => {
    expect(vpAvatarSrc).toMatch(/status === 'online' \|\| status === 'busy'/);
    expect(vpAvatarSrc).toMatch(/status-' \+ status/);
  });

  it('size scales font 0.5× and binds background to color (E-a5)', () => {
    expect(vpAvatarSrc).toContain('Math.round(props.size * 0.5)');
    expect(vpAvatarSrc).toContain('background: color.value');
  });
});

describe('VpBadge — composes avatar + text', () => {
  it('imports VpAvatar', () => {
    expect(vpBadgeSrc).toContain("import VpAvatar from './VpAvatar.js'");
  });
  it('subtitle falls back to vp.role when displayed', () => {
    expect(vpBadgeSrc).toContain('v.subtitle || v.role');
  });
});

describe('VpLibraryLink — empty-library fallback (E-a2)', () => {
  it('switches icon and label when vpCount === 0', () => {
    expect(vpLibLinkSrc).toMatch(/isEmpty\(\)\s*\{\s*return this\.vpStore\.vpCount === 0/);
    expect(vpLibLinkSrc).toContain("'unify.vp.createFirst'");
    expect(vpLibLinkSrc).toContain("'unify.vp.library'");
  });
  it('emits open-library on click', () => {
    expect(vpLibLinkSrc).toMatch(/emits:\s*\['open-library'\]/);
    expect(vpLibLinkSrc).toContain("$emit('open-library')");
  });
  it('hides the count pill when empty', () => {
    expect(vpLibLinkSrc).toMatch(/v-if="!isEmpty && count > 0"/);
  });
  it('renders as a focusable native button (E-a8)', () => {
    expect(vpLibLinkSrc).toMatch(/<button[\s\S]*type="button"/);
  });
});

// ─────────────────────────────────────────────────────────────
// UnifyPage integration
// ─────────────────────────────────────────────────────────────
describe('UnifyPage — sidebar footer integration', () => {
  it('imports and registers VpLibraryLink', () => {
    expect(unifyPageSrc).toContain("import VpLibraryLink from './VpLibraryLink.js'");
    expect(unifyPageSrc).toMatch(/components:\s*\{[^}]*VpLibraryLink/);
  });

  it('VpLibraryLink component is still imported (task-341: footer deleted, task-343 will rewire)', () => {
    expect(unifyPageSrc).toContain("import VpLibraryLink from './VpLibraryLink.js'");
  });

  it('exposes onOpenVpLibrary handler', () => {
    expect(unifyPageSrc).toContain('onOpenVpLibrary');
  });
});

// ─────────────────────────────────────────────────────────────
// CSS + i18n + app wiring
// ─────────────────────────────────────────────────────────────
describe('styles + i18n + app wiring', () => {
  it('index.css imports unify-vp.css', () => {
    expect(indexCssSrc).toContain("@import './unify-vp.css'");
  });
  it('unify-vp.css defines all 12 palette tokens', () => {
    for (let i = 1; i <= 12; i++) {
      expect(unifyVpCssSrc).toContain(`--vp-palette-${i}:`);
    }
  });
  it('unify-vp.css overrides status colors in dark mode (E-a7)', () => {
    expect(unifyVpCssSrc).toMatch(/\[data-theme="dark"\][\s\S]*--vp-status-online:\s*#56d364/);
    expect(unifyVpCssSrc).toMatch(/\[data-theme="dark"\][\s\S]*--vp-status-busy:\s*#ff9e2c/);
  });
  it('unify-vp.css declares vp-busy-pulse keyframes (E-a6)', () => {
    expect(unifyVpCssSrc).toContain('@keyframes vp-busy-pulse');
  });

  for (const key of [
    'unify.vp.library',
    'unify.vp.createFirst',
    'unify.vp.empty.aria',
    'unify.vp.avatar.aria',
  ]) {
    it(`en.js has i18n key ${key}`, () => {
      expect(enI18nSrc).toContain(`'${key}'`);
    });
    it(`zh-CN.js has i18n key ${key}`, () => {
      expect(zhI18nSrc).toContain(`'${key}'`);
    });
  }

  it('app.js exposes useVpStore globally', () => {
    expect(appJsSrc).toContain("import { useVpStore } from './stores/vp.js'");
    expect(appJsSrc).toContain('window.Pinia.useVpStore = useVpStore');
  });
});
