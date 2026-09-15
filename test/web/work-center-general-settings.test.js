import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const panel = readFileSync(join(root, 'web/components/SettingsPanel.js'), 'utf8');
const en = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');

describe('Work Center General settings contract', () => {
  it('keeps an Agent-independent UI toggle in General', () => {
    expect(panel.indexOf("activeTab === 'general'")).toBeLessThan(panel.indexOf("settings.general.workCenter"));
    expect(panel).toContain('@click="toggleWorkCenter"');
    expect(panel).toContain('chatStore.workCenterUiEnabled');
    expect(panel).toContain('this.chatStore.setWorkCenterUiEnabled(!this.chatStore.workCenterUiEnabled)');
    expect(panel).not.toContain(':disabled="workCenterDisabled"');
    expect(panel).not.toContain("!agent.capabilities?.includes('work_center_feature_settings')");
    expect(panel).not.toContain('loadWorkCenterFeatureSettings');
    expect(panel).not.toContain('updateWorkCenterFeatureSettings');
  });

  it('provides bilingual UI visibility copy', () => {
    expect(en).toContain("Available Agents are selected inside Work Center.");
    expect(zh).toContain('支持的 Agent 在工作中心内选择。');
    for (const source of [en, zh]) {
      expect(source).toContain("'settings.general.workCenter'");
      expect(source).toContain("'settings.general.workCenterOn'");
      expect(source).toContain("'settings.general.workCenterOff'");
    }
  });
});
