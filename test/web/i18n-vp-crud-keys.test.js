/**
 * task-338-F1 regression — i18n VP CRUD keys must not be swallowed by
 * a trailing `//` line comment on the preceding section header.
 *
 * Historical bug: the section header looked like
 *   // ============ Unify VP CRUD (task-334-ui-g) =====  'unify.vp.crud.title': '...',
 * The `//` ran to end-of-line, consuming the key definition on the same line.
 * After the fix, `unify.vp.crud.title` is present in both en and zh-CN.
 */
import { describe, it, expect } from 'vitest';
import en from '../../web/i18n/en.js';
import zh from '../../web/i18n/zh-CN.js';

describe('i18n: VP CRUD title key is not swallowed by section comment', () => {
  it('en has unify.vp.crud.title', () => {
    expect(en['unify.vp.crud.title']).toBe('VP Library');
  });
  it('zh-CN has unify.vp.crud.title', () => {
    expect(zh['unify.vp.crud.title']).toBe('角色库');
  });
  it('no VP CRUD keys are swallowed by inline section comments', () => {
    // Sanity sweep over the typical VP CRUD key set.
    const keys = [
      'unify.vp.crud.title',
      'unify.vp.crud.close',
      'unify.vp.crud.addNew',
      'unify.vp.crud.empty',
      'unify.vp.crud.edit',
      'unify.vp.crud.delete',
      'unify.vp.crud.form.create',
      'unify.vp.crud.form.update',
      'unify.vp.crud.form.submit',
      'unify.vp.crud.form.cancel',
    ];
    for (const k of keys) {
      expect(en[k], `en missing ${k}`).toBeTruthy();
      expect(zh[k], `zh missing ${k}`).toBeTruthy();
    }
  });
});
