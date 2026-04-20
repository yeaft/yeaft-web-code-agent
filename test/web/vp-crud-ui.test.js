/**
 * task-334-ui-g — VP CRUD UI unit tests.
 *
 * Covers:
 *   (1) client validator mirror parity — for every canonical input, the
 *       web mirror (web/utils/vp-id-validator.js) returns the same
 *       {ok, reason} as the agent authority (agent/unify/groups/ids.js).
 *   (2) REASON_I18N_KEY table completeness — every reason the backend can
 *       emit maps to a string, and every mapped key is present in both
 *       en and zh-CN i18n dictionaries.
 */

import { describe, it, expect } from 'vitest';
import { validateVpId as clientValidate } from '../../web/utils/vp-id-validator.js';
import { validateVpId as agentValidate } from '../../agent/unify/groups/ids.js';
import { REASON_I18N_KEY, i18nKeyForReason } from '../../web/utils/vp-id-validator.js';
import enMessages from '../../web/i18n/en.js';
import zhMessages from '../../web/i18n/zh-CN.js';

describe('vp-id-validator mirror parity', () => {
  const cases = [
    '', 'a', 'alice', 'alice-bob', 'alice_bob', 'Alice123',
    'a'.repeat(40), 'a'.repeat(41),
    'bad id', 'bad!id', 'bad.id', 'bad/id', 'bad\\id',
    '_hidden', '__dunder',
    '0', '123', '12345',
    'all', 'user', 'system', 'everyone',
    'ALL', 'USER', 'System', 'Everyone',
    null, undefined, 42, {},
  ];

  for (const c of cases) {
    it(`mirror agrees for ${JSON.stringify(c)}`, () => {
      const a = agentValidate(c);
      const b = clientValidate(c);
      expect(b.ok).toBe(a.ok);
      if (!a.ok) expect(b.reason).toBe(a.reason);
    });
  }
});

describe('REASON_I18N_KEY table', () => {
  const allReasons = [
    'empty_or_non_string', 'too_long', 'illegal_character',
    'underscore_prefix_reserved', 'pure_digits', 'reserved',
    'duplicate',
  ];

  it('has a key for every backend reason', () => {
    for (const r of allReasons) {
      expect(typeof REASON_I18N_KEY[r]).toBe('string');
      expect(REASON_I18N_KEY[r].length).toBeGreaterThan(0);
    }
  });

  it('i18nKeyForReason falls back to the raw reason for unknown codes', () => {
    expect(i18nKeyForReason('some_future_code')).toBe('some_future_code');
  });

  it('every mapped key exists in both en and zh-CN messages', () => {
    for (const r of allReasons) {
      const key = REASON_I18N_KEY[r];
      expect(enMessages[key], `en missing ${key}`).toBeTypeOf('string');
      expect(zhMessages[key], `zh-CN missing ${key}`).toBeTypeOf('string');
    }
  });
});
