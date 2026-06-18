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
});
