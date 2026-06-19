const ANSI_PATTERN = /[\u001b\u009b](?:[\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_][\s\S]*?\u001b\\)/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g;

function applyBackspaces(line) {
  const out = [];
  for (const ch of line) {
    if (ch === '\b') {
      out.pop();
    } else {
      out.push(ch);
    }
  }
  return out.join('');
}

function normalizeControlLine(line) {
  const segments = line.split('\r');
  const lastSegment = segments[segments.length - 1] || '';
  return applyBackspaces(lastSegment);
}

function normalizeCarriageReturns(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => normalizeControlLine(line))
    .join('\n');
}

/**
 * Convert terminal-oriented output into readable plain text for the browser.
 *
 * Tool output often contains ANSI SGR color codes (for example Vitest's
 * green checkmarks), cursor-control sequences, carriage-return progress
 * updates, and backspace rewrites. Browsers render those bytes literally in
 * text nodes, so strip terminal protocol while keeping the user-visible text.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTerminalOutput(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (!text) return '';

  return normalizeCarriageReturns(text)
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_PATTERN, '');
}
