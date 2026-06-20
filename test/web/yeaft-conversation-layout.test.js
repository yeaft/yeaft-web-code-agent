import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('Yeaft conversation layout', () => {
  it('keeps the transcript in a flex body above the input', () => {
    const source = read('web/components/YeaftPage.js');

    expect(source).toContain('<div class="yeaft-conversation-body">');
    expect(source.indexOf('<div class="yeaft-conversation-body">')).toBeLessThan(source.indexOf('<MessageList'));
    expect(source.indexOf('</div>\n\n        <div v-if="showLlmConfig"')).toBeGreaterThan(source.indexOf('<SettingsPanel'));
    expect(source.indexOf('<ChatInput')).toBeGreaterThan(source.indexOf('</div>\n\n        <div v-if="showLlmConfig"'));
  });

  it('lets the message container consume remaining height instead of pushing the input upward', () => {
    const css = read('web/styles/yeaft.css');

    expect(css).toContain('.yeaft-main-center {\n  flex: 1;\n  min-width: 0;\n  min-height: 0;');
    expect(css).toContain('.yeaft-conversation-body {\n  flex: 1 1 auto;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n}');
    expect(css).toContain('.yeaft-conversation-body > .chat-container {\n  flex: 1 1 auto;\n}');
  });

  it('shows an onboarding guide instead of chat input when no Yeaft session exists', () => {
    const source = read('web/components/YeaftPage.js');
    const css = read('web/styles/yeaft.css');
    const en = read('web/i18n/en.js');
    const zh = read('web/i18n/zh-CN.js');

    expect(source).toContain('class="yeaft-onboarding"');
    expect(source).toContain("v-if=\"!showSettings && !store.yeaftActiveVpDetailId && showOnboardingGuide\"");
    expect(source).toContain('<ChatInput\n          v-if="!showSettings && !showOnboardingGuide"');
    expect(source).toContain('const showOnboardingGuide = Vue.computed(() => {');
    expect(source).toContain('if (gs.isEmpty === true) return true;');
    expect(source).toContain('openSessionCreate');
    expect(source).toContain('openLlmConfig');
    expect(source).toContain('npm install -g @yeaft/webchat-agent');
    expect(source).toContain('yeaft-agent llm use github-copilot');

    expect(css).toContain('.yeaft-onboarding {');
    expect(css).toContain('.yeaft-onboarding-card {');
    expect(css).toContain('.yeaft-onboarding-command code {');
    expect(css).not.toMatch(/\.yeaft-onboarding[\s\S]*?#[0-9a-f]{3,6}/i);
    expect(css).not.toMatch(/\.yeaft-onboarding[\s\S]*?rgba\(/i);

    expect(en).toContain("'yeaft.onboarding.title': 'Connect an Agent before chatting'");
    expect(zh).toContain("'yeaft.onboarding.title': '先连接 Agent，再开始会话'");
  });
});
