import { describe, expect, it } from 'vitest';
import { normalizeTerminalOutput, tokenizeTerminalOutput } from '../../web/utils/terminal-output.js';

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

  it('tokenizes ANSI colors without returning terminal protocol bytes', () => {
    const raw = '\u001b[32m✓\u001b[39m test \u001b[2m(3 tests)\u001b[22m';

    expect(tokenizeTerminalOutput(raw)).toEqual([
      { text: '✓', className: 'terminal-fg-green' },
      { text: ' test ', className: '' },
      { text: '(3 tests)', className: 'terminal-dim' },
    ]);
  });

  it('drops cursor controls while keeping SGR styling', () => {
    const raw = '\u001b[?25l\u001b[31mfail\u001b[0m\u001b[?25h';

    expect(tokenizeTerminalOutput(raw)).toEqual([
      { text: 'fail', className: 'terminal-fg-red' },
    ]);
  });

  it('preserves ANSI background color spans from terminal status labels', () => {
    const raw = '\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m';

    expect(tokenizeTerminalOutput(raw)).toEqual([
      { text: ' RUN ', className: 'terminal-bg-cyan terminal-bold' },
    ]);
  });

  it('maps 24-bit foreground colors without treating RGB parameters as style codes', () => {
    const raw = '\u001b[38;2;255;0;0mred\u001b[0m plain';

    expect(tokenizeTerminalOutput(raw)).toEqual([
      { text: 'red', className: 'terminal-fg-red' },
      { text: ' plain', className: '' },
    ]);
  });

  it('maps 256-color foreground colors without leaking extended parameters', () => {
    const raw = '\u001b[38;5;196mred\u001b[0m plain';

    expect(tokenizeTerminalOutput(raw)).toEqual([
      { text: 'red', className: 'terminal-fg-red' },
      { text: ' plain', className: '' },
    ]);
  });

  it('maps 24-bit background colors without resetting on RGB zero parameters', () => {
    const raw = '\u001b[48;2;0;255;0mgreen bg\u001b[0m plain';

    expect(tokenizeTerminalOutput(raw)).toEqual([
      { text: 'green bg', className: 'terminal-bg-green' },
      { text: ' plain', className: '' },
    ]);
  });
});
