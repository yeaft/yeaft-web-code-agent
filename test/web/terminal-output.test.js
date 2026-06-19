import { describe, expect, it } from 'vitest';
import { normalizeTerminalOutput } from '../../web/utils/terminal-output.js';

describe('normalizeTerminalOutput', () => {
  it('strips ANSI SGR color codes from command output', () => {
    const raw = '\u001b[32m✓\u001b[39m test/web/message-flow-regression.test.js \u001b[2m(\u001b[22m3 tests\u001b[22m)\u001b[32m 5\u001b[2mms\u001b[22m\u001b[39m';

    expect(normalizeTerminalOutput(raw)).toBe('✓ test/web/message-flow-regression.test.js (3 tests) 5ms');
  });

  it('removes cursor/control sequences while preserving readable text', () => {
    const raw = 'start\u001b[?25l\u001b[2K\u001b[1Gdone\u001b[?25h\u0007';

    expect(normalizeTerminalOutput(raw)).toBe('startdone');
  });

  it('applies carriage-return rewrites as the last visible terminal line state', () => {
    const raw = 'Progress 10%\rProgress 80%\rProgress 100%\nnext';

    expect(normalizeTerminalOutput(raw)).toBe('Progress 100%\nnext');
  });

  it('applies backspace rewrites', () => {
    expect(normalizeTerminalOutput('abc\b\bd')).toBe('ad');
  });
});
