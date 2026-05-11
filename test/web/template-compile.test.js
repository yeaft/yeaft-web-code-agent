/**
 * Vue template compile smoke test (regression net for v0.1.751).
 *
 * Background — what went wrong in v0.1.750:
 *
 *   web/components/UnifyPage.js had this dynamic title binding (lines 171-173):
 *
 *     :title="dreamLastRunRelative
 *       ? ($t('unify.dream.runNow') + '\n' + $t(...))
 *       : ($t('unify.dream.runNow') + '\n' + $t(...))"
 *
 *   Because the component's `template:` is itself a JS template literal,
 *   the source-level `\n` got evaluated to a real newline character BEFORE
 *   Vue ever saw the template. The HTML attribute value then contained a
 *   literal LF inside a single-quoted JS sub-expression, which Vue's runtime
 *   template compiler tried to emit verbatim into a `new Function(...)`
 *   render-fn body. Result: `SyntaxError: Invalid or unexpected token` at
 *   the unterminated `'` string literal — the entire UnifyPage failed to
 *   mount, so opening group mode crashed.
 *
 *   The earlier v0.1.750 patch fixed a separate TDZ in setup(); that TDZ
 *   was MASKING this template-compile crash, so once it was removed the
 *   underlying SyntaxError became visible.
 *
 * What this test does:
 *
 *   For every Vue component under web/components/, extract the
 *   `template: \`...\`` string literal, evaluate it as the runtime would
 *   (so `\n` becomes a real LF, exactly like the bug), neutralize any
 *   `${...}` interpolations into safe placeholders, and call
 *   Vue.compile() on the result. Any component whose template can't
 *   round-trip through `Vue.compile() -> new Function(body)` will fail
 *   this test — which is exactly the bug class that broke group mode.
 *
 *   This is a static contract test: no Vue mount, no Pinia, no DOM
 *   interactions. We only assert that the generated render-fn body is
 *   syntactically valid JavaScript.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Window } from 'happy-dom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const componentsDir = join(repoRoot, 'web', 'components');

// ----- Vue runtime bootstrap with happy-dom globals -----
// Vue's runtime compiler reaches for `document` while decoding entities,
// so we need a real (enough) DOM. happy-dom is already a devDependency.
let Vue;
beforeAll(() => {
  const win = new Window();
  // Node 22 exposes `navigator` as a read-only getter on globalThis, so we
  // must use defineProperty (which can override it) instead of direct
  // assignment. The other DOM globals are not read-only.
  const setGlobal = (name, value) => {
    try {
      Object.defineProperty(globalThis, name, {
        value, writable: true, configurable: true,
      });
    } catch {
      // Fallthrough — if a host already has it writable, plain assignment is fine.
      // eslint-disable-next-line no-param-reassign
      globalThis[name] = value;
    }
  };
  setGlobal('window', win);
  setGlobal('document', win.document);
  setGlobal('navigator', win.navigator);
  setGlobal('HTMLElement', win.HTMLElement);
  setGlobal('SVGElement', win.SVGElement);
  setGlobal('Element', win.Element);
  setGlobal('Node', win.Node);
  const vueSrc = readFileSync(join(repoRoot, 'web', 'vendor', 'vue.global.prod.js'), 'utf8');
  // The vendor bundle is shaped `var Vue = function(...){...}(...)`. We must
  // evaluate it at global scope so the top-level `var Vue` becomes a property
  // of globalThis — wrapping it in `new Function(src)` would make `Vue`
  // function-local. Indirect eval (`(0, eval)(src)`) runs in global scope.
  // eslint-disable-next-line no-eval
  (0, eval)(vueSrc + '\n;globalThis.Vue = Vue;');
  Vue = globalThis.Vue;
  if (!Vue || typeof Vue.compile !== 'function') {
    throw new Error('Vue.compile not available after loading vendor bundle');
  }
});

// ----- Template extraction -----
// Find every `template: \`...\`` block. We scan character by character
// to correctly handle nested `${...}` interpolations and escaped backticks.
function extractTemplates(src) {
  const templates = [];
  const re = /template:\s*`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let i = start;
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`' && depth === 0) break;
      if (ch === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
      if (ch === '}' && depth > 0) { depth--; i++; continue; }
      i++;
    }
    if (i >= src.length) break;
    templates.push({ raw: src.slice(start, i), startOffset: start });
  }
  return templates;
}

// Evaluate a template literal the way the runtime would (so `\n`, `\t`,
// etc., become real characters), with every `${...}` interpolation
// replaced by a literal placeholder string. Using `new Function` here
// is safe because we control the input — it's pulled from our own
// source tree.
function evalTemplate(raw) {
  // Replace `${...}` blocks (which may themselves contain expressions
  // and nested `${...}`) with a placeholder string. We do this on the
  // raw source so the surrounding `\n`, `\\`, `\t` escapes remain in
  // place and get evaluated by `new Function('return `'+...+'`')`.
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < raw.length && depth > 0) {
        if (raw[i] === '{') depth++;
        else if (raw[i] === '}') depth--;
        if (depth > 0) i++;
      }
      i++; // skip closing }
      out += '__VP_EXPR__';
    } else {
      out += raw[i++];
    }
  }
  // Now `out` is a backtick-template body with no interpolations.
  // eslint-disable-next-line no-new-func
  return new Function('return `' + out + '`')();
}

// ----- Discover component files -----
function listComponentFiles() {
  return readdirSync(componentsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(componentsDir, f));
}

describe('Vue template compile — every component compiles cleanly', () => {
  // Sanity check that the harness actually catches the kind of bug that
  // shipped in v0.1.750. If this fails, the test framework can no longer
  // be trusted to catch regressions of the same shape.
  it('harness rejects an attribute value that contains a literal newline inside a quoted JS sub-expression', () => {
    const broken = `<div :title="'foo' + '\n' + 'bar'"></div>`;
    let threw = false;
    try {
      const fnSrc = Vue.compile(broken);
      // Vue.compile in production builds returns a function directly; in
      // the dev build it returns { render }. Either way, the act of
      // creating the function (which happens inside compile()) is what
      // throws SyntaxError on a broken render body.
      void fnSrc;
    } catch (e) {
      threw = true;
      expect(String(e.message || e)).toMatch(/Invalid|Unexpected|SyntaxError/i);
    }
    expect(threw).toBe(true);
  });

  for (const file of listComponentFiles()) {
    const rel = `web/components/${file.split('/').pop()}`;
    it(`${rel} — all templates compile`, () => {
      const src = readFileSync(file, 'utf8');
      const templates = extractTemplates(src);
      if (templates.length === 0) return; // not every file is a component
      templates.forEach(({ raw, startOffset }, idx) => {
        const linesBefore = src.slice(0, startOffset).split('\n').length;
        const evaluated = evalTemplate(raw);
        try {
          Vue.compile(evaluated);
        } catch (e) {
          const head = (e && (e.message || String(e))).split('\n')[0];
          throw new Error(
            `${rel}: template #${idx + 1} (starts at line ~${linesBefore}) failed Vue.compile: ${head}`
          );
        }
      });
    });
  }
});
