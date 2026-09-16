/** Math is tokenized before Markdown escapes/emphasis, never inside code tokens. */
const MAX_MATH_LENGTH = 16_384;

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isEscaped(source, index) {
  let slashes = 0;
  while (index > 0 && source[--index] === '\\') slashes += 1;
  return slashes % 2 === 1;
}

function closingIndex(source, delimiter, from) {
  let index = source.indexOf(delimiter, from);
  while (index !== -1) {
    if (!isEscaped(source, index)) return index;
    index = source.indexOf(delimiter, index + delimiter.length);
  }
  return -1;
}

function renderMath(token, block = false) {
  const raw = escapeHtml(token.raw);
  if (!token.formula || token.formula.length > MAX_MATH_LENGTH
    || typeof katex === 'undefined') return block ? `<div class="math-fallback">${raw}</div>\n` : raw;
  try {
    const html = katex.renderToString(token.formula, {
      displayMode: token.display,
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxExpand: 1000,
      maxSize: 10,
      // A fresh macro scope prevents one message from affecting another.
      macros: {},
    });
    const tag = block ? 'div' : 'span';
    return `<${tag} class="math-${token.display ? 'display' : 'inline'}">${html}</${tag}>${block ? '\n' : ''}`;
  } catch {
    // Invalid/unsupported TeX is readable text, not a broken message or HTML.
    return block ? `<div class="math-fallback">${raw}</div>\n` : raw;
  }
}

/** Install on the shared Marked instance once, before its first parse. */
export function mathExtensions() {
  return [
    {
      name: 'blockMath',
      level: 'block',
      start(source) { return source.match(/(?:^|\n) {0,3}(?:\$\$|\\\[)/)?.index; },
      tokenizer(source) {
        const opener = /^( {0,3})(\$\$|\\\[)/.exec(source);
        if (!opener) return;
        const delimiter = opener[2] === '$$' ? '$$' : '\\]';
        const end = closingIndex(source, delimiter, opener[0].length);
        if (end < 0 || !/^[ \t]*(?:\n|$)/.test(source.slice(end + delimiter.length))) return;
        const raw = source.slice(0, end + delimiter.length);
        return { type: 'blockMath', raw, formula: source.slice(opener[0].length, end).trim(), display: true };
      },
      renderer(token) { return renderMath(token, true); },
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(source) {
        const index = source.search(/\$|\\[([]/);
        return index === -1 ? undefined : index;
      },
      tokenizer(source) {
        if (this.lexer.state.inRawBlock) return;
        const opener = /^(\$\$|\$|\\\(|\\\[)/.exec(source)?.[0];
        if (!opener) return;
        const delimiter = opener === '\\(' ? '\\)' : opener === '\\[' ? '\\]' : opener;
        const end = closingIndex(source, delimiter, opener.length);
        if (end < 0) {
          // Keep LaTeX's backslash delimiters visible during streaming too.
          if (opener !== '$') return { type: 'inlineMath', raw: source.split('\n')[0] };
          return;
        }
        const formula = source.slice(opener.length, end);
        if (formula.includes('\n')) return;
        // Pandoc-style dollar rules: do not treat "$5 and $10" as math.
        if (opener === '$' && (!formula || formula.includes('`') || /^\s|\s$/.test(formula) || /\d/.test(source[end + 1] || '')
          || source[end + 1] === '$')) return;
        return { type: 'inlineMath', raw: source.slice(0, end + delimiter.length), formula,
          display: opener === '$$' || opener === '\\[' };
      },
      renderer(token) { return renderMath(token); },
    },
  ];
}
