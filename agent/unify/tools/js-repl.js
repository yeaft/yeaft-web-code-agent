/**
 * js-repl.js — JavaScript REPL for evaluating expressions.
 *
 * Runs JavaScript code in a persistent VM context, allowing
 * state to be maintained across calls.
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
  description: `Evaluate JavaScript code in a persistent REPL environment.

The REPL context persists across calls — variables and functions
defined in one call are available in subsequent calls.

Guidelines:
- Use for calculations, data transformations, and quick experiments
- State is preserved between calls (use JsReplReset to clear)
- console.log output is captured and returned
- Returns the last expression's value plus any console output
- No filesystem or network access from within the REPL`,
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JavaScript code to evaluate',
      },
    },
    required: ['code'],
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  async execute(input, ctx) {
    const { code } = input;
    if (!code) return JSON.stringify({ error: 'code is required' });

    const vmCtx = getContext();

    try {
      const result = runInContext(code, vmCtx, {
        timeout: 10000, // 10 second timeout
        displayErrors: true,
      });

      const output = vmCtx.__output.slice();
      const resultStr = result === undefined ? '' : String(result);

      const parts = [];
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

export const jsReplReset = defineTool({
  name: 'JsReplReset',
  description: `Reset the JavaScript REPL environment.

Clears all variables and state from previous evaluations.
Use when you want a clean slate.`,
  parameters: {
    type: 'object',
    properties: {},
  },
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  async execute(input, ctx) {
    vmContext = null;
    return JSON.stringify({ success: true, message: 'REPL context reset' });
  },
});
