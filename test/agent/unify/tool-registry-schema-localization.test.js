/**
 * Regression: `getToolDefs('zh')` must not corrupt JSON Schemas whose
 * `properties` block contains a *property named* `description`.
 *
 * Origin: PR #754 introduced `localizeParameters` to translate prompt-
 * visible text in tool descriptions. The walker recursed on every value
 * but special-cased the `description` key to call `localizeVisibleText`
 * directly. When walking a property literally named `description` (which
 * holds a sub-schema object, not a string), the helper coerced the
 * object via `String(value)` → `'[object Object]'`, leaving the emitted
 * schema with `properties.description = '[object Object]'`. GPT-5's
 * strict JSON-Schema validator rejected the resulting payload with
 * `"'[object Object]' is not of type 'object', 'boolean'"`, breaking
 * every tool whose schema has a `description` property.
 *
 * The fix: only treat a `description` value as localizable text when it
 * is actually a string. Object/array values under a `description` key
 * are sub-schemas and must be recursed into normally.
 *
 * Originally written against `featureCreate`, which had exactly this
 * shape (a `properties.description` sub-schema + an enum + an array
 * with `items`). The Feature tool family was removed on 2026-05-13
 * (commit c5cb48cd) — the contract still lives in `registry.js`, so
 * this test now uses a synthetic ToolDef built specifically to exercise
 * every branch of `localizeParameters` without depending on any
 * production tool's schema shape.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../agent/unify/tools/registry.js';
import { defineTool } from '../../../agent/unify/tools/types.js';

function isObjectSchema(node) {
  return node && typeof node === 'object' && !Array.isArray(node);
}

/**
 * Build a fresh ToolDef on every call so individual tests can mutate
 * the returned `defs` without leaking between cases. The shape is
 * hand-crafted to hit every branch of `localizeParameters`:
 *
 *  - `properties.description` is a sub-schema OBJECT whose own
 *    `description` field is a STRING (the bug case).
 *  - `properties.priority` carries an `enum` array that must survive
 *    the walk by value.
 *  - `properties.members` is an array schema whose `items` is itself
 *    a sub-schema object (must not be stringified).
 *  - `required` is an array of strings (array-of-primitives branch).
 */
function buildFixtureTool() {
  return defineTool({
    name: 'SchemaProbe',
    description: 'Synthetic tool used to pin the localizeParameters contract.',
    parameters: {
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Short human-readable title.',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the item.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Priority bucket.',
        },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of member ids.',
        },
      },
    },
    execute: async () => 'ok',
  });
}

describe('ToolRegistry.getToolDefs language localization', () => {
  it('preserves nested schema when a property is literally named "description" (zh)', () => {
    const reg = new ToolRegistry();
    reg.register(buildFixtureTool());

    const defs = reg.getToolDefs('zh');
    const probe = defs.find(d => d.name === 'SchemaProbe');
    expect(probe).toBeDefined();

    // Top-level shape preserved.
    expect(probe.parameters.type).toBe('object');
    expect(Array.isArray(probe.parameters.required)).toBe(true);
    expect(probe.parameters.required).toContain('title');

    // The property literally named `description` must remain an object
    // sub-schema, NOT a string. Pre-fix this was `'[object Object]'`.
    const propDesc = probe.parameters.properties.description;
    expect(isObjectSchema(propDesc)).toBe(true);
    expect(propDesc.type).toBe('string');
    // Its INNER description (the field doc) is a string — and may be
    // localized. Just assert it is still a string.
    expect(typeof propDesc.description).toBe('string');
    expect(propDesc.description.length).toBeGreaterThan(0);

    // priority must still carry its enum array intact.
    const propPrio = probe.parameters.properties.priority;
    expect(isObjectSchema(propPrio)).toBe(true);
    expect(propPrio.type).toBe('string');
    expect(propPrio.enum).toEqual(['low', 'medium', 'high', 'critical']);

    // members.items must still be the inner type schema, not a
    // recursively-stringified shape.
    const propMembers = probe.parameters.properties.members;
    expect(isObjectSchema(propMembers)).toBe(true);
    expect(propMembers.type).toBe('array');
    expect(isObjectSchema(propMembers.items)).toBe(true);
    expect(propMembers.items.type).toBe('string');
  });

  it('does NOT corrupt schemas in en locale either (no-op identity path)', () => {
    const reg = new ToolRegistry();
    reg.register(buildFixtureTool());

    const defs = reg.getToolDefs('en');
    const probe = defs.find(d => d.name === 'SchemaProbe');

    const propDesc = probe.parameters.properties.description;
    expect(isObjectSchema(propDesc)).toBe(true);
    expect(propDesc.type).toBe('string');

    const propPrio = probe.parameters.properties.priority;
    expect(propPrio.enum).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('localizes the tool-level description (text-typed only), leaves params intact', () => {
    const reg = new ToolRegistry();
    reg.register(buildFixtureTool());

    const defsZh = reg.getToolDefs('zh');
    const probeZh = defsZh.find(d => d.name === 'SchemaProbe');
    expect(typeof probeZh.description).toBe('string');
    // zh localization prepends a Chinese prefix — assert the marker is
    // present so we know zh-path actually ran.
    expect(probeZh.description).toMatch(/工具说明/);

    const defsEn = reg.getToolDefs('en');
    const probeEn = defsEn.find(d => d.name === 'SchemaProbe');
    // en path is identity.
    expect(probeEn.description).not.toMatch(/工具说明/);
  });

  it('never produces "[object Object]" anywhere in the emitted schema', () => {
    const reg = new ToolRegistry();
    reg.register(buildFixtureTool());

    for (const lang of ['en', 'zh', 'zh-CN']) {
      const defs = reg.getToolDefs(lang);
      const serialized = JSON.stringify(defs);
      expect(serialized.includes('[object Object]'),
        `lang=${lang}: serialized defs unexpectedly contains "[object Object]"`).toBe(false);
    }
  });
});
