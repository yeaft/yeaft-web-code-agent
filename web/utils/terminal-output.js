const ANSI_PATTERN = /[\u001b\u009b](?:[\[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_][\s\S]*?\u001b\\)/g;
const SGR_PATTERN = /(?:\u001b\[|\u009b)([0-9;]*)m/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g;

const ANSI_FG_CLASS = new Map([
  [30, 'terminal-fg-black'],
  [31, 'terminal-fg-red'],
  [32, 'terminal-fg-green'],
  [33, 'terminal-fg-yellow'],
  [34, 'terminal-fg-blue'],
  [35, 'terminal-fg-magenta'],
  [36, 'terminal-fg-cyan'],
  [37, 'terminal-fg-white'],
  [90, 'terminal-fg-bright-black'],
  [91, 'terminal-fg-bright-red'],
  [92, 'terminal-fg-bright-green'],
  [93, 'terminal-fg-bright-yellow'],
  [94, 'terminal-fg-bright-blue'],
  [95, 'terminal-fg-bright-magenta'],
  [96, 'terminal-fg-bright-cyan'],
  [97, 'terminal-fg-bright-white'],
]);

const ANSI_BG_CLASS = new Map([
  [40, 'terminal-bg-black'],
  [41, 'terminal-bg-red'],
  [42, 'terminal-bg-green'],
  [43, 'terminal-bg-yellow'],
  [44, 'terminal-bg-blue'],
  [45, 'terminal-bg-magenta'],
  [46, 'terminal-bg-cyan'],
  [47, 'terminal-bg-white'],
  [100, 'terminal-bg-bright-black'],
  [101, 'terminal-bg-bright-red'],
  [102, 'terminal-bg-bright-green'],
  [103, 'terminal-bg-bright-yellow'],
  [104, 'terminal-bg-bright-blue'],
  [105, 'terminal-bg-bright-magenta'],
  [106, 'terminal-bg-bright-cyan'],
  [107, 'terminal-bg-bright-white'],
]);

const ANSI_COLOR_PALETTE = [
  { code: 30, r: 0, g: 0, b: 0 },
  { code: 31, r: 170, g: 0, b: 0 },
  { code: 32, r: 0, g: 170, b: 0 },
  { code: 33, r: 170, g: 85, b: 0 },
  { code: 34, r: 0, g: 0, b: 170 },
  { code: 35, r: 170, g: 0, b: 170 },
  { code: 36, r: 0, g: 170, b: 170 },
  { code: 37, r: 170, g: 170, b: 170 },
  { code: 90, r: 85, g: 85, b: 85 },
  { code: 91, r: 255, g: 85, b: 85 },
  { code: 92, r: 85, g: 255, b: 85 },
  { code: 93, r: 255, g: 255, b: 85 },
  { code: 94, r: 85, g: 85, b: 255 },
  { code: 95, r: 255, g: 85, b: 255 },
  { code: 96, r: 85, g: 255, b: 255 },
  { code: 97, r: 255, g: 255, b: 255 },
];

const XTERM_COLOR_STEPS = [0, 95, 135, 175, 215, 255];

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

function cleanVisibleText(text) {
  return text
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_PATTERN, '');
}

function parseSgrCodes(params) {
  if (!params) return [0];
  return params
    .split(';')
    .filter(part => part !== '')
    .map(part => Number(part))
    .filter(Number.isFinite);
}

function classForAnsiColorCode(code, target) {
  const normalized = target === 'bg' && code >= 30 && code <= 37
    ? code + 10
    : target === 'bg' && code >= 90 && code <= 97
      ? code + 10
      : code;
  return target === 'bg' ? ANSI_BG_CLASS.get(normalized) : ANSI_FG_CLASS.get(normalized);
}

function nearestAnsiColorCode(r, g, b) {
  let nearest = ANSI_COLOR_PALETTE[0];
  let nearestDistance = Infinity;

  for (const color of ANSI_COLOR_PALETTE) {
    const distance = ((color.r - r) ** 2) + ((color.g - g) ** 2) + ((color.b - b) ** 2);
    if (distance < nearestDistance) {
      nearest = color;
      nearestDistance = distance;
    }
  }

  return nearest.code;
}

function rgbForXterm256Color(code) {
  if (code < 0 || code > 255) return null;
  if (code < 16) {
    const color = ANSI_COLOR_PALETTE[code];
    return { r: color.r, g: color.g, b: color.b };
  }
  if (code >= 232) {
    const value = 8 + ((code - 232) * 10);
    return { r: value, g: value, b: value };
  }

  const offset = code - 16;
  return {
    r: XTERM_COLOR_STEPS[Math.floor(offset / 36)],
    g: XTERM_COLOR_STEPS[Math.floor((offset % 36) / 6)],
    b: XTERM_COLOR_STEPS[offset % 6],
  };
}

function applyExtendedColor(next, target, codes, index) {
  const mode = codes[index + 1];
  if (mode === 5) {
    const colorCode = codes[index + 2];
    if (Number.isFinite(colorCode)) {
      const rgb = rgbForXterm256Color(colorCode);
      if (rgb) {
        next[target] = classForAnsiColorCode(nearestAnsiColorCode(rgb.r, rgb.g, rgb.b), target) || '';
      }
    }
    return index + 3;
  }

  if (mode === 2) {
    const r = codes[index + 2];
    const g = codes[index + 3];
    const b = codes[index + 4];
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      next[target] = classForAnsiColorCode(nearestAnsiColorCode(r, g, b), target) || '';
    }
    return index + 5;
  }

  return index + 2;
}

function applySgrCodes(style, codes) {
  const next = { ...style };
  const sgrCodes = codes.length ? codes : [0];
  for (let index = 0; index < sgrCodes.length;) {
    const code = sgrCodes[index];
    if (code === 0) {
      next.fg = '';
      next.bg = '';
      next.bold = false;
      next.dim = false;
      next.italic = false;
      next.underline = false;
    } else if (code === 1) {
      next.bold = true;
      next.dim = false;
    } else if (code === 2) {
      next.dim = true;
      next.bold = false;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) {
      next.italic = false;
    } else if (code === 24) {
      next.underline = false;
    } else if (code === 39) {
      next.fg = '';
    } else if (code === 49) {
      next.bg = '';
    } else if (ANSI_FG_CLASS.has(code)) {
      next.fg = ANSI_FG_CLASS.get(code);
    } else if (ANSI_BG_CLASS.has(code)) {
      next.bg = ANSI_BG_CLASS.get(code);
    } else if (code === 38) {
      index = applyExtendedColor(next, 'fg', sgrCodes, index);
      continue;
    } else if (code === 48) {
      index = applyExtendedColor(next, 'bg', sgrCodes, index);
      continue;
    }
    index += 1;
  }
  return next;
}

function classNameForStyle(style) {
  return [style.fg, style.bg, style.bold && 'terminal-bold', style.dim && 'terminal-dim', style.italic && 'terminal-italic', style.underline && 'terminal-underline']
    .filter(Boolean)
    .join(' ');
}

function pushToken(tokens, text, style) {
  const clean = cleanVisibleText(text);
  if (!clean) return;
  const className = classNameForStyle(style);
  const prev = tokens[tokens.length - 1];
  if (prev && prev.className === className) {
    prev.text += clean;
  } else {
    tokens.push({ text: clean, className });
  }
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

  return cleanVisibleText(normalizeCarriageReturns(text));
}

/**
 * Tokenize terminal output for safe Vue rendering while preserving common ANSI
 * SGR foreground colors and text emphasis. This never returns HTML; callers
 * render text nodes and CSS classes, so terminal bytes cannot execute markup.
 *
 * @param {unknown} value
 * @returns {{ text: string, className: string }[]}
 */
export function tokenizeTerminalOutput(value) {
  if (value == null) return [];
  const text = typeof value === 'string' ? value : String(value);
  if (!text) return [];

  const normalized = normalizeCarriageReturns(text);
  const tokens = [];
  let style = { fg: '', bg: '', bold: false, dim: false, italic: false, underline: false };
  let lastIndex = 0;
  SGR_PATTERN.lastIndex = 0;

  for (let match = SGR_PATTERN.exec(normalized); match; match = SGR_PATTERN.exec(normalized)) {
    pushToken(tokens, normalized.slice(lastIndex, match.index), style);
    style = applySgrCodes(style, parseSgrCodes(match[1]));
    lastIndex = match.index + match[0].length;
  }
  pushToken(tokens, normalized.slice(lastIndex), style);
  return tokens;
}
