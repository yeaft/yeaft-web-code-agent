import { describe, expect, it } from 'vitest';

import { BUFFERABLE_TYPES } from '../../agent/connection/buffer.js';

describe('agent connection buffer', () => {
  it('buffers Yeaft history chunks while the websocket reconnects', () => {
    expect(BUFFERABLE_TYPES.has('yeaft_history_chunk')).toBe(true);
  });
});
