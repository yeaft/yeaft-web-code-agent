import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const source = readFileSync(new URL('../../web/components/VpTurnBlock.js', import.meta.url), 'utf8');

describe('VpTurnBlock elapsed display contract', () => {
  it('renders the live elapsed indicator only for streaming turns', () => {
    expect(source).toContain('<template v-if="turn.isStreaming && elapsedText">');
  });

  it('computes elapsed from the persisted speaker timestamp and shared tick', () => {
    expect(source).toContain('const ts = props.turn.speakerTimestamp;');
    expect(source).toContain('const ms = props.nowMs - ts;');
    expect(source).toContain('return formatElapsed(ms);');
  });
});
