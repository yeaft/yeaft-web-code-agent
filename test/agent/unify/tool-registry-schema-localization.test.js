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
 * every tool whose schema has a `description` property (FeatureCreate
 * is the canonical case).
 *
 * The fix: only treat a `description` value as localizable text when it
 * is actually a string. Object/array values under a `description` key
 * are sub-schemas and must be recursed into normally.
 *
 * This test pins the contract: after `getToolDefs('zh')` the FeatureCreate
 * schema must round-trip through a strict-shape check unchanged in
 * structure — keys, types, nested `description` sub-property, and the
 * `enum` array.
 */

import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../agent/unify/tools/registry.js';
import { featureCreate } from '../../../agent/unify/tools/feature-tools.js';

function isObjectSchema(node) {
  return node && typeof node === 'object' && !Array.isArray(node);
}

describe('ToolRegistry.getToolDefs language localization', () => {
  it('preserves nested schema when a property is literally named "description" (zh)', () => {
    const reg = new ToolRegistry();
    reg.register(featureCreate);

    const defs = reg.getToolDefs('zh');
    const fc = defs.find(d => d.name === 'FeatureCreate');
    expect(fc).toBeDefined();

    // Top-level shape preserved.
    expect(fc.parameters.type).toBe('object');
    expect(Array.isArray(fc.parameters.required)).toBe(true);
    expect(fc.parameters.required).toContain('title');

    // The property literally named `description` must remain an object
    // sub-schema, NOT a string. Pre-fix this was `'[object Object]'`.
    const propDesc = fc.parameters.properties.description;
    expect(isObjectSchema(propDesc)).toBe(true);
    expect(propDesc.type).toBe('string');
    // Its INNER description (the field doc) is a string — and may be
    // localized. Just assert it is still a string.
    expect(typeof propDesc.description).toBe('string');
    expect(propDesc.description.length).toBeGreaterThan(0);

    // priority must still carry its enum array intact.
    const propPrio = fc.parameters.properties.priority;
    expect(isObjectSchema(propPrio)).toBe(true);
    expect(propPrio.type).toBe('string');
    expect(propPrio.enum).toEqual(['low', 'medium', 'high', 'critical']);

    // members.items must still be the inner type schema, not a
    // recursively-stringified shape.
    const propMembers = fc.parameters.properties.members;
    expect(isObjectSchema(propMembers)).toBe(true);
    expect(propMembers.type).toBe('array');
    expect(isObjectSchema(propMembers.items)).toBe(true);
    expect(propMembers.items.type).toBe('string');
  });

  it('does NOT corrupt schemas in en locale either (no-op identity path)', () => {
    const reg = new ToolRegistry();
    reg.register(featureCreate);

    const defs = reg.getToolDefs('en');
    const fc = defs.find(d => d.name === 'FeatureCreate');

    const propDesc = fc.parameters.properties.description;
    expect(isObjectSchema(propDesc)).toBe(true);
    expect(propDesc.type).toBe('string');

    const propPrio = fc.parameters.properties.priority;
    expect(propPrio.enum).toEqual(['low', 'medium', 'high', 'critical']);
  });

  it('localizes the tool-level description (text-typed only), leaves params intact', () => {
    const reg = new ToolRegistry();
    reg.register(featureCreate);

    const defsZh = reg.getToolDefs('zh');
    const fcZh = defsZh.find(d => d.name === 'FeatureCreate');
    expect(typeof fcZh.description).toBe('string');
    // zh localization prepends a Chinese prefix — assert the marker is
    // present so we know zh-path actually ran.
    expect(fcZh.description).toMatch(/工具说明/);

    const defsEn = reg.getToolDefs('en');
    const fcEn = defsEn.find(d => d.name === 'FeatureCreate');
    // en path is identity.
    expect(fcEn.description).not.toMatch(/工具说明/);
  });

  it('never produces "[object Object]" anywhere in the emitted schema', () => {
    const reg = new ToolRegistry();
    reg.register(featureCreate);

    for (const lang of ['en', 'zh', 'zh-CN']) {
      const defs = reg.getToolDefs(lang);
      const serialized = JSON.stringify(defs);
      expect(serialized.includes('[object Object]'),
        `lang=${lang}: serialized defs unexpectedly contains "[object Object]"`).toBe(false);
    }
  });
});
