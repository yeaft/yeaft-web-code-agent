import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let SettingsPanel;

beforeAll(async () => {
  vi.stubGlobal('Pinia', {
    defineStore: vi.fn(() => () => ({})),
    useChatStore: vi.fn(() => ({})),
  });
  ({ default: SettingsPanel } = await import('../../web/components/SettingsPanel.js'));
});

const root = process.cwd();
const panel = readFileSync(join(root, 'web/components/SettingsPanel.js'), 'utf8');
const styles = readFileSync(join(root, 'web/styles/settings.css'), 'utf8');
const en = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');

describe('General settings controls', () => {
  it('uses stateful switches instead of action buttons for telemetry and Work Center', () => {
    expect(panel.indexOf("activeTab === 'general'")).toBeLessThan(panel.indexOf('settings.general.workCenter'));
    expect(panel).toContain('class="sp-setting-switch"');
    expect(panel).toContain('role="switch" :aria-checked="telemetryLoaded && telemetryEnabled"');
    expect(panel).toContain('role="switch" :aria-checked="chatStore.workCenterUiEnabled"');
    expect(panel).toContain('aria-labelledby="general-telemetry-label"');
    expect(panel).toContain('aria-describedby="general-work-center-desc"');
    expect(panel).toContain(':disabled="telemetryLoading || telemetrySaving || !telemetryLoaded"');
    expect(panel).toContain('this.chatStore.setWorkCenterUiEnabled(!this.chatStore.workCenterUiEnabled)');
    expect(panel).not.toContain('@click="openWorkCenter"');
    expect(panel).not.toContain('settings.general.workCenterOpen');
    expect(panel).not.toContain(':disabled="workCenterDisabled"');
    expect(panel).not.toContain('loadWorkCenterFeatureSettings');
    expect(panel).not.toContain('updateWorkCenterFeatureSettings');
  });

  it('keeps labels and descriptions stacked and adapts controls for narrow screens', () => {
    expect(styles).toContain('.sp-setting-copy {');
    expect(styles).toMatch(/\.sp-setting-copy \{[\s\S]*?flex-direction: column;/);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.sp-setting-switch-control \{[\s\S]*?width: 100%;/);
    expect(styles).toMatch(/\.sp-setting-switch:focus-visible \{[\s\S]*?var\(--focus-ring\)/);
    expect(styles).toMatch(/\.sp-setting-switch:disabled \{[\s\S]*?cursor: not-allowed;/);
  });

  it('makes current select values explicit', () => {
    expect(panel.match(/settings\.general\.currentValue/g)).toHaveLength(3);
    expect(panel.match(/aria-haspopup="listbox"/g)).toHaveLength(3);
    expect(en).toContain("'settings.general.currentValue': 'Current: {value}'");
    expect(zh).toContain("'settings.general.currentValue': '当前：{value}'");
  });

  it('provides bilingual current-state, location, saving, and error copy', () => {
    expect(en).toContain('Show the Work Center entry in the sidebar header.');
    expect(zh).toContain('在侧栏顶栏显示工作中心入口');
    expect(en).toContain("'settings.general.workCenterOn': 'Enabled'");
    expect(en).toContain("'settings.general.workCenterOff': 'Disabled'");
    expect(zh).toContain("'settings.general.workCenterOn': '已开启'");
    expect(zh).toContain("'settings.general.workCenterOff': '已关闭'");
    for (const source of [en, zh]) {
      expect(source).toContain("'settings.general.telemetrySaving'");
      expect(source).toContain("'settings.general.telemetryLoadFailed'");
      expect(source).toContain("'settings.general.telemetrySaveFailed'");
      expect(source).not.toContain("'settings.general.workCenterOpen'");
    }
  });

  it('preserves the confirmed telemetry state when a save is rejected', async () => {
    const previous = { enabled: true, retentionDays: 3 };
    const context = {
      telemetryDraft: previous,
      telemetryEnabled: true,
      telemetryLoading: false,
      telemetryLoaded: true,
      telemetrySaving: false,
      telemetryErrorMessage: '',
      chatStore: { updateTelemetrySettings: vi.fn().mockRejectedValue(new Error('offline')) },
      $t: vi.fn(key => key),
    };

    await SettingsPanel.methods.toggleTelemetry.call(context);

    expect(context.chatStore.updateTelemetrySettings).toHaveBeenCalledWith({ enabled: false, retentionDays: 3 });
    expect(context.telemetryDraft).toEqual(previous);
    expect(context.telemetrySaving).toBe(false);
    expect(context.telemetryErrorMessage).toBe('settings.general.telemetrySaveFailed');
  });

  it('accepts only a successful telemetry response as the new state', async () => {
    const context = {
      telemetryDraft: { enabled: true, retentionDays: 3 },
      telemetryEnabled: true,
      telemetryLoading: false,
      telemetryLoaded: true,
      telemetrySaving: false,
      telemetryErrorMessage: '',
      chatStore: { updateTelemetrySettings: vi.fn().mockResolvedValue({ enabled: false, retentionDays: 5 }) },
      $t: vi.fn(key => key),
    };

    await SettingsPanel.methods.toggleTelemetry.call(context);

    expect(context.telemetryDraft).toMatchObject({ enabled: false, retentionDays: 5 });
    expect(context.telemetryErrorMessage).toBe('');
  });

  it('restores the confirmed telemetry state when the response reports an error', async () => {
    const previous = { enabled: false, retentionDays: 3 };
    const context = {
      telemetryDraft: previous,
      telemetryEnabled: false,
      telemetryLoading: false,
      telemetryLoaded: true,
      telemetrySaving: false,
      telemetryErrorMessage: '',
      chatStore: { updateTelemetrySettings: vi.fn().mockResolvedValue({ enabled: true, error: 'denied' }) },
      $t: vi.fn(key => key),
    };

    await SettingsPanel.methods.toggleTelemetry.call(context);

    expect(context.telemetryDraft).toEqual(previous);
    expect(context.telemetryErrorMessage).toBe('settings.general.telemetrySaveFailed');
  });
});
