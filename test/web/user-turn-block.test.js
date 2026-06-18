import { compile } from '@vue/compiler-dom';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../web/${path}`, import.meta.url), 'utf8');

describe('UserTurnBlock', () => {
  it('renders user messages without a user avatar gutter', async () => {
    const component = await import('../../web/components/UserTurnBlock.js');
    const source = read('components/UserTurnBlock.js');
    const css = read('styles/yeaft-vp.css');

    compile(component.default.template);

    expect(source).not.toContain("import UserAvatar from './UserAvatar.js'");
    expect(source).not.toContain('UserAvatar');
    expect(source).not.toContain('user-turn-block-avatar');
    expect(source).toContain('<MessageItem :message="message" />');

    expect(css).toContain('.user-turn-block {\n  position: relative;\n  margin: 12px 0;\n  padding: 0;\n  display: flex;\n  justify-content: flex-end;\n}');
    expect(css).not.toContain('grid-template-columns: 1fr 36px');
    expect(css).not.toContain('.user-turn-block-avatar');
  });
});
