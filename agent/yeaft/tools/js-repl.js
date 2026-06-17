/**
 * js-repl.js — JavaScript REPL for evaluating expressions.
 *
 * Runs JavaScript code in a persistent VM context, allowing
 * state to be maintained across calls.
 *
 * task-333b: merged the former `JsReplReset` tool into this one as a
 * `reset: true` parameter. A single tool with a reset flag eliminates a
 * duplicate schema entry in the function-call catalogue. The old
 * JsReplReset name is kept below as a deprecated alias for one release.
 */

import { defineTool } from './types.js';
import { createContext, runInContext } from 'vm';

/** Persistent VM context per session. */
let vmContext = null;

function getContext() {
  if (!vmContext) {
    vmContext = createContext({
      console: {
        log: (...args) => { vmContext.__output.push(args.map(String).join(' ')); },
        error: (...args) => { vmContext.__output.push('[error] ' + args.map(String).join(' ')); },
        warn: (...args) => { vmContext.__output.push('[warn] ' + args.map(String).join(' ')); },
      },
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      JSON,
      Math,
      Date,
      RegExp,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Error,
      Buffer,
      __output: [],
    });
  }
  vmContext.__output = [];
  return vmContext;
}

export const jsRepl = defineTool({
  name: 'JsRepl',
  description: {
    en: `Evaluate JavaScript code in a persistent REPL environment.

The REPL context persists across calls — variables and functions
defined in one call are available in subsequent calls.

Guidelines:
- Use for calculations, data transformations, and quick experiments
- State is preserved between calls
- Pass \`reset: true\` to wipe all state before evaluating (clean slate).
  \`code\` becomes optional in this mode — pass reset alone to just clear.
- console.log output is captured and returned
- Returns the last expression's value plus any console output
- No filesystem or network access from within the REPL`,
    zh: `在持久 REPL 环境中执行 JavaScript 代码。

REPL 上下文在多次调用间保持——一次调用中定义的变量和函数可在后续调用中使用。

使用指南：
- 用于计算、数据转换和快速实验
- 状态在调用间保留
- 传入 reset: true 可在执行前清除所有状态（干净环境）。此模式下 code 可选——只传 reset 即可清除
- console.log 输出被捕获并返回
- 返回最后一个表达式的值及所有 console 输出
- REPL 内不能访问文件系统或网络`
  },
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to evaluate. Optional when reset=true and you only want to clear state.',
      },
      reset: {
        type: 'boolean',
        description: 'When true, reset the REPL context BEFORE evaluating `code`. If `code` is omitted, just resets.',
      },
    },
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { code, reset } = input || {};

    if (reset) {
      vmContext = null;
      if (!code) {
        return JSON.stringify({ success: true, message: 'REPL context reset' });
      }
    }

    if (!code) return JSON.stringify({ error: 'code is required (or pass reset=true to clear state)' });

    const vmCtx = getContext();

    try {
      const result = runInContext(code, vmCtx, {
        timeout: 10000, // 10 second timeout
        displayErrors: true,
      });

      const output = vmCtx.__output.slice();
      const resultStr = result === undefined ? '' : String(result);

      const parts = [];
      if (reset) parts.push('(REPL context reset)');
      if (output.length > 0) parts.push(output.join('\n'));
      if (resultStr) parts.push(`→ ${resultStr}`);

      return parts.join('\n') || '(no output)';
    } catch (err) {
      const output = vmCtx.__output.slice();
      const parts = [];
      if (output.length > 0) parts.push(output.join('\n'));
      parts.push(`Error: ${err.message}`);
      return parts.join('\n');
    }
  },
});

/**
 * Deprecated alias — `JsReplReset`. task-333b merged reset behaviour into
 * `JsRepl` via `reset: true`. Kept registered for one release so older
 * prompts / saved tool calls still resolve. Emits a one-time deprecation
 * warning on first invocation, then delegates to jsRepl.execute with reset.
 */
const _jsReplResetWarned = { v: false };
function warnJsReplResetDeprecated() {
  if (_jsReplResetWarned.v) return;
  _jsReplResetWarned.v = true;
  // eslint-disable-next-line no-console
  console.warn('[deprecated] JsReplReset → JsRepl. Call JsRepl with { reset: true } to clear REPL state.');
}

export const jsReplReset = defineTool({
  name: 'JsReplReset',
  description: {
    en: 'DEPRECATED — use JsRepl with `reset: true` instead. Resets the persistent REPL context. Removal target: v0.2.0.',
    zh: '已废弃——请改用带有 `reset: true` 参数的 JsRepl。它会清空持久 REPL 上下文。计划在 v0.2.0 移除。',
  },
  parameters: { type: 'object', properties: {} },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    warnJsReplResetDeprecated();
    return jsRepl.execute({ reset: true }, ctx);
  },
});
