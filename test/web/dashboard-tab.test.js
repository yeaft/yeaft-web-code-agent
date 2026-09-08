import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const component = readFileSync(resolve(root, 'web/components/DashboardTab.js'), 'utf8');
const css = readFileSync(resolve(root, 'web/styles/dashboard.css'), 'utf8');
const en = readFileSync(resolve(root, 'web/i18n/en.js'), 'utf8');
const zh = readFileSync(resolve(root, 'web/i18n/zh-CN.js'), 'utf8');

describe('Dashboard layout', () => {
  it('has General and Detailed sections with Users and Agents dimensions', () => {
    expect(component).toContain("settings.dashboard.general");
    expect(component).toContain("settings.dashboard.detailed");
    expect(component).toContain("detailDimension === 'users'");
    expect(component).toContain("detailDimension === 'agents'");
    expect(component).toContain('db-filter-header');
    expect(component).toContain('userActivityFilter');
    expect(component).toContain('agentActivityFilter');
    expect(component).toContain('aria-labelledby="dashboard-detail-tab-users"');
    expect(component).toContain('aria-labelledby="dashboard-detail-tab-agents"');
  });

  it('keeps General compact and removes the old standalone Session/online-user sections', () => {
    expect(component).toContain('db-general-row');
    expect(component).not.toContain('sessionCount');
    expect(component).not.toContain('onlineUserList');
    expect(component).not.toContain('onlineUsersRes');
    expect(css).toContain('.db-general-row');
    expect(css).toContain('.db-detail-tabs');
  });

  it('defaults detailed data to today and shows turn completion instead of login time', () => {
    expect(component).toContain("statsPeriod: 'today'");
    expect(component).toContain("agentTimeFilter: 'today'");
    expect(component).toContain('user.lastTurnCompletedAt');
    expect(component).not.toContain('user.lastLoginAt');
  });

  it('has complete bilingual copy for the new filters and dimensions', () => {
    for (const key of [
      'settings.dashboard.general',
      'settings.dashboard.detailed',
      'settings.dashboard.users',
      'settings.dashboard.agents',
      'settings.dashboard.activeOnly',
      'settings.dashboard.inactiveOnly',
      'settings.dashboard.lastTurnCompleted',
    ]) {
      expect(en).toContain(`'${key}':`);
      expect(zh).toContain(`'${key}':`);
    }
  });
});
