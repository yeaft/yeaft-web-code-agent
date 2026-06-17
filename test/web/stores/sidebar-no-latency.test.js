// Regression guard: sidebar agent list and the shared SidebarAgentHeader
// must not render per-agent latency (`Xms` chip / dropdown row). The
// data-layer field `agent.latency` is still kept for other surfaces
// (DashboardTab, modal pickers); this test only asserts the sidebar
// rendering paths are gone.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readComp(rel) {
  return readFileSync(new URL(`../../../web/components/${rel}`, import.meta.url), 'utf8');
}

function readStyle(rel) {
  return readFileSync(new URL(`../../../web/styles/${rel}`, import.meta.url), 'utf8');
}

describe('sidebar removes latency display', () => {
  const sidebarHeader = readComp('SidebarAgentHeader.js');
  const chatPage = readComp('ChatPage.js');
  const yeaftSidebar = readComp('YeaftSidebar.js');
  const sidebarCss = readStyle('sidebar.css');
  const settingsCss = readStyle('settings.css');

  it('SidebarAgentHeader has no latency rendering or class helper', () => {
    expect(sidebarHeader).not.toMatch(/latency-indicator/);
    expect(sidebarHeader).not.toMatch(/agent-dropdown-latency/);
    expect(sidebarHeader).not.toMatch(/currentAgentLatency/);
    expect(sidebarHeader).not.toMatch(/getLatencyClass/);
    // The shared header template no longer contains an `ms` literal.
    expect(sidebarHeader).not.toMatch(/}}ms/);
  });

  it('ChatPage sidebar session rows have no latency chip', () => {
    expect(chatPage).not.toMatch(/latency-indicator/);
    expect(chatPage).not.toMatch(/getAgentLatency/);
    // The shared-header binding for current-agent latency is gone.
    expect(chatPage).not.toMatch(/:current-agent-latency=/);
    // The computed and helper methods are also removed.
    expect(chatPage).not.toMatch(/currentAgentLatency\(\)/);
    expect(chatPage).not.toMatch(/getLatencyClass\(latency\)/);
  });

  it('YeaftSidebar session rows have no latency chip', () => {
    expect(yeaftSidebar).not.toMatch(/latency-indicator/);
    expect(yeaftSidebar).not.toMatch(/rowLatency/);
    expect(yeaftSidebar).not.toMatch(/:current-agent-latency=/);
    expect(yeaftSidebar).not.toMatch(/currentAgentLatency\(\)/);
    expect(yeaftSidebar).not.toMatch(/getLatencyClass\(latency\)/);
  });

  it('CSS no longer defines latency chip classes', () => {
    expect(sidebarCss).not.toMatch(/\.latency-indicator\b/);
    expect(sidebarCss).not.toMatch(/\.agent-dropdown-latency\b/);
    expect(settingsCss).not.toMatch(/\.agent-dropdown-latency\b/);
  });
});
