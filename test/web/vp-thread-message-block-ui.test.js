/**
 * Regression tests for Yeaft VP thread/message block presentation.
 *
 * The UI contract is hierarchical:
 *   VP thread block header = VP name + thread context + time
 *   message block = text/todos/tool actions/images/ask card
 *
 * Tool actions must stay inside the same assistant message block instead of
 * looking like a detached component below the current VP turn.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf-8');

describe('Yeaft VP thread message block UI source', () => {
  it('renders thread context inline in the VP turn header after the VP name', () => {
    const src = read('web/components/VpTurnBlock.js');
    const headerIdx = src.indexOf('class="vp-turn-block-main-header"');
    const nameIdx = src.indexOf('class="vp-turn-block-name"', headerIdx);
    const threadIdx = src.indexOf('class="vp-thread-summary"', headerIdx);
    const bodyIdx = src.indexOf('<AssistantTurn', headerIdx);

    expect(headerIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(headerIdx);
    expect(threadIdx).toBeGreaterThan(nameIdx);
    expect(threadIdx).toBeLessThan(bodyIdx);
  });

  it('wraps text and tool actions in one appendable assistant message block', () => {
    const src = read('web/components/AssistantTurn.js');
    const blockIdx = src.indexOf('class="turn-message-block"');
    const textIdx = src.indexOf('class="turn-content"', blockIdx);
    const actionIdx = src.indexOf('class="turn-actions"', blockIdx);
    const footerIdx = src.indexOf('class="turn-footer"', blockIdx);

    expect(blockIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeGreaterThan(blockIdx);
    expect(actionIdx).toBeGreaterThan(textIdx);
    expect(actionIdx).toBeLessThan(footerIdx);
  });
});
