import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const panel = readFileSync(join(root, 'web/components/SettingsPanel.js'), 'utf8');
const en = readFileSync(join(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(join(root, 'web/i18n/zh-CN.js'), 'utf8');

describe('Work Center General settings contract', () => {
  it('keeps the toggle in General and disables it for unavailable or busy Agent state', () => {
    expect(panel.indexOf("activeTab === 'general'")).toBeLessThan(panel.indexOf("settings.general.workCenter"));
    expect(panel).toContain(':disabled="workCenterDisabled"');
    expect(panel).toContain("this.chatStore.connectionState === 'connected'");
    expect(panel).toContain('!this.currentWorkCenterAgentOnline || this.workCenterUnsupported || this.workCenterLoading || this.workCenterSaving || this.workCenterDraft.overridden');
    expect(panel).toContain("!agent.capabilities?.includes('work_center_feature_settings')");
  });

  it('fences requests by generation and Agent, reloads on Agent changes, and displays errors', () => {
    expect(panel).toContain("'chatStore.currentAgent'()");
    expect(panel).toContain('agentId === this.chatStore.currentAgent');
    expect(panel).toContain('generation === this.workCenterGeneration');
    expect(panel).toContain('v-if="workCenterError"');
    expect(panel).not.toContain('catch { /* disconnected/offline state remains disabled */ }');
  });

  it('provides bilingual toggle and read-only environment override copy', () => {
    for (const source of [en, zh]) {
      expect(source).toContain("'settings.general.workCenter'");
      expect(source).toContain("'settings.general.workCenterEnvOverride'");
      expect(source).toContain("'settings.general.workCenterOn'");
      expect(source).toContain("'settings.general.workCenterOff'");
      expect(source).toContain("'settings.general.workCenterUpgradeRequired'");
      expect(source).toContain("'settings.general.workCenterStartupFailed'");
    }
  });
});
