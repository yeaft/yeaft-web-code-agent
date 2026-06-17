// Pure helpers for the Yeaft Debug panel.
//
// Two responsibilities, both intentionally framework-free so they can be
// unit-tested without booting Vue:
//
//   1. `splitTokenBreakdown(messages, response, toolCalls)` — answers the
//      question "where did this LLM call's tokens go?". Splits input into
//      `message` (plain conversational text in user/assistant content) vs
//      `tool` (tool_use blocks the assistant emitted earlier + tool_result
//      blocks the user side returned + the current loop's outgoing
//      toolCalls).  Output is similarly split: assistant response text vs
//      assistant's new tool_use blocks.
//
//      The numbers are *estimates* because no LLM provider returns
//      token usage broken down by content type — Anthropic and OpenAI
//      both only surface total input / output. We use the same
//      char/4 + CJK blend the engine itself uses (`memory/budget.js#approxTokens`)
//      so the proportions match what the engine sees, and we surface
//      the helper output as an "estimated breakdown" — the *total*
//      remains the provider-reported real number.
//
//   2. `formatClockTime(value)` — formats an epoch ms / ISO string into
//      `HH:MM:SS` (24h, local TZ). Returns '' on null / NaN / parse
//      failure so the template can fall back to a hyphen.
//
// Neither helper touches the DOM, the store, or any wire-level
// bookkeeping. They only operate on the data already in
// YeaftDebugPanel's `turns` / `loops` props.

/**
 * Approximate token count of a string. Mirrors `agent/yeaft/memory/budget.js#approxTokens`
 * — CJK glyph ≈ 1 token, everything else ≈ char / 4. We duplicate the
 * implementation (instead of import-ing across the agent boundary) so
 * the web bundle stays self-contained with no build step.
 *
 * @param {string} text
 * @returns {number}
 */
export function approxTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : String(text);
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) || 0;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3040 && c <= 0x309f) ||
      (c >= 0x30a0 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * Flatten a debug message's `content` field into the chunks that should
 * be counted as "message text" vs "tool traffic".
 *
 * Two shapes show up in the debug payload:
 *   1. `content: 'hello world'` (plain string, paired with a separate
 *      `toolCalls` field on assistant messages or `toolCallId` on tool
 *      messages).
 *   2. `content: [{type:'text', text}, {type:'tool_use', name, input},
 *                 {type:'tool_result', tool_use_id, content}]`
 *      (Anthropic block array — the engine sometimes hands these
 *      through verbatim).
 *
 * Returns `{ messageText: string[], toolText: string[] }` — caller
 * concatenates and counts.
 *
 * Tool block JSON is stringified verbatim because that's what the LLM
 * actually saw on the wire; estimating the tool call's "input"
 * separately from its name keeps the math close to the real token cost.
 *
 * @param {{ role?: string, content?: any, toolCalls?: any[], toolCallId?: string }} msg
 */
function partitionMessageContent(msg) {
  const messageText = [];
  const toolText = [];
  if (!msg) return { messageText, toolText };

  const content = msg.content;
  if (typeof content === 'string') {
    if (msg.role === 'tool') {
      // A tool-role message is a tool_result by definition; its content
      // is the tool's output payload.
      toolText.push(content);
    } else {
      messageText.push(content);
    }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const type = block.type;
      if (type === 'text' && typeof block.text === 'string') {
        messageText.push(block.text);
      } else if (type === 'tool_use') {
        // Count the name + serialized input as the wire cost.
        toolText.push(String(block.name || ''));
        if (block.input !== undefined) {
          try { toolText.push(JSON.stringify(block.input)); } catch { /* ignore */ }
        }
      } else if (type === 'tool_result') {
        const inner = block.content;
        if (typeof inner === 'string') {
          toolText.push(inner);
        } else if (Array.isArray(inner)) {
          for (const part of inner) {
            if (!part) continue;
            if (typeof part === 'string') toolText.push(part);
            else if (typeof part === 'object' && typeof part.text === 'string') toolText.push(part.text);
            else { try { toolText.push(JSON.stringify(part)); } catch { /* ignore */ } }
          }
        } else if (inner !== undefined) {
          try { toolText.push(JSON.stringify(inner)); } catch { /* ignore */ }
        }
      } else {
        // Unknown block type — count as message to avoid silently
        // dropping it from the total.
        try { messageText.push(JSON.stringify(block)); } catch { /* ignore */ }
      }
    }
  }

  // Sibling `toolCalls` on an assistant message (string-content shape).
  if (Array.isArray(msg.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (!tc) continue;
      toolText.push(String(tc.name || ''));
      if (tc.input !== undefined) {
        try { toolText.push(JSON.stringify(tc.input)); } catch { /* ignore */ }
      }
    }
  }

  return { messageText, toolText };
}

/**
 * Split a Loop's token cost into message vs tool buckets.
 *
 * Input bucket sources:
 *   - `messages[]` — the full conversation array sent to the LLM. Each
 *     message contributes message-text (user/assistant prose) OR
 *     tool-text (tool_use issued earlier, tool_result returned, current
 *     tool calls).
 *
 * Output bucket sources:
 *   - `response` (string) — assistant's text reply this loop → message.
 *   - `toolCalls[]` — assistant's tool_use blocks emitted this loop → tool.
 *
 * The returned `inputTotalEstimated` / `outputTotalEstimated` are the
 * sum of our estimates and may not match the provider-reported totals
 * exactly. Callers should always show the real `usage.totalTokens` as
 * the authoritative total and use these buckets to derive a *ratio*.
 *
 * @param {{ messages?: any[], response?: string, toolCalls?: any[] }} loop
 * @returns {{ inputMessageTokens: number, inputToolTokens: number,
 *             outputMessageTokens: number, outputToolTokens: number,
 *             inputTotalEstimated: number, outputTotalEstimated: number }}
 */
export function splitTokenBreakdown(loop) {
  let inputMessage = 0;
  let inputTool = 0;
  if (loop && Array.isArray(loop.messages)) {
    for (const m of loop.messages) {
      const { messageText, toolText } = partitionMessageContent(m);
      for (const t of messageText) inputMessage += approxTokens(t);
      for (const t of toolText) inputTool += approxTokens(t);
    }
  }

  let outputMessage = 0;
  let outputTool = 0;
  if (loop && typeof loop.response === 'string') {
    outputMessage += approxTokens(loop.response);
  }
  if (loop && Array.isArray(loop.toolCalls)) {
    for (const tc of loop.toolCalls) {
      if (!tc) continue;
      outputTool += approxTokens(String(tc.name || ''));
      if (tc.input !== undefined) {
        try { outputTool += approxTokens(JSON.stringify(tc.input)); } catch { /* ignore */ }
      }
    }
  }

  return {
    inputMessageTokens: inputMessage,
    inputToolTokens: inputTool,
    outputMessageTokens: outputMessage,
    outputToolTokens: outputTool,
    inputTotalEstimated: inputMessage + inputTool,
    outputTotalEstimated: outputMessage + outputTool,
  };
}

/**
 * Apportion provider-reported real totals across the message / tool
 * buckets using the estimate's ratio. Returns integer counts that sum
 * to the real total (no off-by-one drift).
 *
 * If the estimate is zero (e.g. empty messages array — happens for
 * error loops where we never sent anything), returns
 * `{ message: realTotal, tool: 0 }` so the total stays visible without
 * inventing a tool share.
 *
 * @param {number} realTotal
 * @param {number} estMessage
 * @param {number} estTool
 * @returns {{ message: number, tool: number }}
 */
export function apportionToBuckets(realTotal, estMessage, estTool) {
  const total = Math.max(0, Math.floor(Number(realTotal) || 0));
  const em = Math.max(0, Number(estMessage) || 0);
  const et = Math.max(0, Number(estTool) || 0);
  const estTotal = em + et;
  if (total === 0) return { message: 0, tool: 0 };
  if (estTotal === 0) return { message: total, tool: 0 };
  const messageShare = Math.round((em / estTotal) * total);
  const clamped = Math.min(total, Math.max(0, messageShare));
  return { message: clamped, tool: total - clamped };
}

/**
 * Format an epoch ms (number) or ISO string (string) into `HH:MM:SS`
 * using the user's local timezone, 24-hour clock. Returns '' on any
 * parse failure so the template can render a hyphen instead.
 *
 * @param {number | string | null | undefined} value
 * @returns {string}
 */
export function formatClockTime(value) {
  if (value == null || value === '') return '';
  let ms;
  if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      // Allow numeric strings like "1718000000000".
      const n = Number(value);
      if (!Number.isFinite(n)) return '';
      ms = n;
    } else {
      ms = parsed;
    }
  } else {
    return '';
  }
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
