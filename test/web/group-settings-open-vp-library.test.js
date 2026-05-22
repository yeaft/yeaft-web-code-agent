/**
 * group-settings-open-vp-library.test.js — pin the wiring contract that
 * `GroupSettingsModal` exposes the `open-vp-library` emit and that its
 * template renders the "Open VP Library" button on the Members section.
 *
 * Strategy: inspect the component object's declarative metadata (emits +
 * template string) without rendering. The repository renders Vue from CDN
 * at runtime, so mount-based testing isn't the pattern here — see
 * `unify-page-setup-tdz.test.js` for the analogous sandbox approach.
 *
 * The UnifyPage handler that this emit drives (`openVpLibraryFromGroupSettings`
 * → `closeGroupSettings()` + `openSettings({initialTab:'vp'})`) is covered
 * separately by the syntax-check + setup-tdz tests; here we only guard
 * the GroupSettingsModal end of the contract.
 */

import { describe, it, expect } from 'vitest';
import GroupSettingsModal from '../../web/components/GroupSettingsModal.js';

describe('GroupSettingsModal — open-vp-library wiring', () => {
  it('declares "open-vp-library" in emits', () => {
    expect(Array.isArray(GroupSettingsModal.emits)).toBe(true);
    expect(GroupSettingsModal.emits).toContain('open-vp-library');
    // 'close' must stay too (existing contract).
    expect(GroupSettingsModal.emits).toContain('close');
  });

  it('Members section renders an "Open VP Library" button that emits the event', () => {
    const tpl = String(GroupSettingsModal.template || '');
    // Section header layout wrapper.
    expect(tpl).toMatch(/group-settings-section-header/);
    // The button uses the new i18n key.
    expect(tpl).toMatch(/unify\.group\.members\.openLibrary/);
    // And emits the event verbatim.
    expect(tpl).toMatch(/\$emit\(['"]open-vp-library['"]\)/);
    // Stays inside the Members section (sanity check — the button must
    // be under section === 'members' so it doesn't bleed into Announcement
    // / Rename / Danger panes).
    const membersIdx = tpl.indexOf("section === 'members'");
    const buttonIdx = tpl.indexOf("openLibrary");
    expect(membersIdx).toBeGreaterThanOrEqual(0);
    expect(buttonIdx).toBeGreaterThan(membersIdx);
  });

  it('hint text is wired as a title attribute for accessibility', () => {
    const tpl = String(GroupSettingsModal.template || '');
    expect(tpl).toMatch(/unify\.group\.members\.openLibraryHint/);
  });

  it('does not expose standalone per-group model configuration UI', () => {
    const sections = GroupSettingsModal.computed.sections.call({ $t: (key) => key });
    expect(sections.map(s => s.id)).not.toContain('model');
    expect(GroupSettingsModal.props.initialSection.validator('model')).toBe(false);

    const tpl = String(GroupSettingsModal.template || '');
    expect(tpl).not.toMatch(/section === ['"]model['"]/);
    expect(tpl).not.toMatch(/Override the model used for this group/);
  });

});
