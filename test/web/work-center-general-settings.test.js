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
    expect(panel).not.toContain('aria-haspopup="listbox"');
    expect(panel.match(/:aria-expanded="openDropdown ===/g)).toHaveLength(3);
    expect(en).toContain("'settings.general.currentValue': 'Current: {value}'");
    expect(zh).toContain("'settings.general.currentValue': '当前：{value}'");
    expect(en).toContain("'settings.general.workCenter': 'Work Center entry'");
    expect(zh).toContain("'settings.general.workCenter': '工作中心入口'");
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
      telemetryGeneration: 0,
      telemetryAgentId: 'agent-a',
      telemetryLoading: false,
      telemetryLoaded: true,
      telemetrySaving: false,
      telemetryErrorMessage: '',
      chatStore: { currentAgent: 'agent-a', updateTelemetrySettings: vi.fn().mockRejectedValue(new Error('offline')) },
      $t: vi.fn(key => key),
    };

    await SettingsPanel.methods.toggleTelemetry.call(context);

    expect(context.chatStore.updateTelemetrySettings).toHaveBeenCalledWith({ enabled: false, retentionDays: 3 }, 'agent-a');
    expect(context.telemetryDraft).toEqual(previous);
    expect(context.telemetrySaving).toBe(false);
    expect(context.telemetryErrorMessage).toBe('settings.general.telemetrySaveFailed');
  });

  it('accepts only a successful telemetry response as the new state', async () => {
    const context = {
      telemetryDraft: { enabled: true, retentionDays: 3 },
      telemetryEnabled: true,
      telemetryGeneration: 0,
      telemetryAgentId: 'agent-a',
      telemetryLoading: false,
      telemetryLoaded: true,
      telemetrySaving: false,
      telemetryErrorMessage: '',
      chatStore: { currentAgent: 'agent-a', updateTelemetrySettings: vi.fn().mockResolvedValue({ enabled: false, retentionDays: 5 }) },
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
      telemetryGeneration: 0,
      telemetryAgentId: 'agent-a',
      telemetryLoading: false,
      telemetryLoaded: true,
      telemetrySaving: false,
      telemetryErrorMessage: '',
      chatStore: { currentAgent: 'agent-a', updateTelemetrySettings: vi.fn().mockResolvedValue({ enabled: true, error: 'denied' }) },
      $t: vi.fn(key => key),
    };

    await SettingsPanel.methods.toggleTelemetry.call(context);

    expect(context.telemetryDraft).toEqual(previous);
    expect(context.telemetryErrorMessage).toBe('settings.general.telemetrySaveFailed');
  });

  it('ignores superseded telemetry loads and saves after reopening or switching Agent', async () => {
    const loads = [];
    const saves = [];
    const context = {
      telemetryGeneration: 0, telemetryAgentId: null,
      telemetryDraft: { enabled: true }, telemetryLoaded: false,
      telemetryLoading: false, telemetrySaving: false,
      telemetryErrorMessage: '',
      get telemetryEnabled() { return this.telemetryDraft.enabled; },
      chatStore: {
        currentAgent: 'agent-a',
        loadTelemetrySettings: vi.fn(() => new Promise((resolve, reject) => loads.push({ resolve, reject }))),
        updateTelemetrySettings: vi.fn(() => new Promise((resolve, reject) => saves.push({ resolve, reject }))),
      },
      $t: key => key,
    };
    context.invalidateTelemetry = SettingsPanel.methods.invalidateTelemetry.bind(context);
    const load = SettingsPanel.methods.loadTelemetry.bind(context);
    const toggle = SettingsPanel.methods.toggleTelemetry.bind(context);
    const first = load();
    const second = load();
    loads[1].resolve({ enabled: false });
    await second;
    loads[0].resolve({ enabled: true });
    await first;
    expect(context.telemetryDraft.enabled).toBe(false);
    expect(context.telemetryLoaded).toBe(true);

    const oldSave = toggle();
    expect(context.chatStore.updateTelemetrySettings).toHaveBeenCalledWith({ enabled: true }, 'agent-a');
    expect(context.telemetrySaving).toBe(true);
    // The visible/currentAgent watchers invalidate old work before loading the new state.
    context.invalidateTelemetry();
    context.chatStore.currentAgent = 'agent-b';
    const nextAgent = load();
    saves[0].reject(new Error('late old Agent failure'));
    await oldSave;
    expect(context.telemetryErrorMessage).toBe('');
    expect(context.telemetryLoading).toBe(true);
    loads[2].resolve({ enabled: true });
    await nextAgent;
    expect(context.telemetryAgentId).toBe('agent-b');
    expect(context.telemetryDraft.enabled).toBe(true);
    expect(context.telemetryLoading).toBe(false);

    const closed = load();
    context.invalidateTelemetry();
    loads[3].resolve({ enabled: false });
    await closed;
    expect(context.telemetryLoaded).toBe(false);
    expect(context.telemetryDraft.enabled).toBe(true);
  });

});
