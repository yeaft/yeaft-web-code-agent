/**
 * archive/trace.js — DESIGN.md §4.4.
 *
 * Retrieval helpers backing the `tool_trace` / `message_trace` tools.
 * The tool-registry wires these into the worker's toolset; this module
 * is a thin wrapper around the archive readers with the ACL gate in
 * place (only `vp/<other>/` is hard-blocked, per §1.2).
 *
 * Per design: the tools take a `toolCallId` / `turnId` plus the scope
 * context (the worker passes its current scope dir). We never search
 * across scopes — the caller knows which group/task/VP the lookup is
 * for. Cross-VP lookups (`scopeDir = 'vp/<other>'`) throw `acl_blocked`.
 */

import { readArchivedTool } from './tool-results.js';
import { readArchivedTurn } from './turn-archive.js';

const VP_PREFIX = 'vp/';

/**
 * @param {string} scopeDir e.g. 'vp/grace' or 'groups/eng' or 'tasks/t_1'
 * @param {string|null|undefined} currentVpId the VP making the call
 */
function aclCheck(scopeDir, currentVpId) {
  if (typeof scopeDir !== 'string' || !scopeDir) {
    throw new Error('trace: scopeDir required');
  }
  if (!scopeDir.startsWith(VP_PREFIX)) return;
  const owner = scopeDir.slice(VP_PREFIX.length).split('/')[0];
  if (!owner) return;
  if (currentVpId && owner !== currentVpId) {
    const e = new Error(`acl_blocked: ${scopeDir}`);
    /** @type {any} */ (e).code = 'acl_blocked';
    throw e;
  }
}

/**
 * @param {{
 *   root: string,
 *   scopeDir: string,
 *   toolCallId: string,
 *   currentVpId?: string,
 * }} args
 * @returns {Promise<{ ok: boolean, body?: string, error?: string }>}
 */
export async function toolTrace({ root, scopeDir, toolCallId, currentVpId }) {
  aclCheck(scopeDir, currentVpId);
  if (!toolCallId) return { ok: false, error: 'missing_toolCallId' };
  const body = await readArchivedTool({ root, scopeDir, toolCallId });
  if (body == null) return { ok: false, error: 'not_found' };
  return { ok: true, body };
}

/**
 * @param {{
 *   root: string,
 *   scopeDir: string,
 *   turnId: string,
 *   currentVpId?: string,
 * }} args
 * @returns {Promise<{ ok: boolean, header?: object, messages?: object[], error?: string }>}
 */
export async function messageTrace({ root, scopeDir, turnId, currentVpId }) {
  aclCheck(scopeDir, currentVpId);
  if (!turnId) return { ok: false, error: 'missing_turnId' };
  const out = await readArchivedTurn({ root, scopeDir, turnId });
  if (!out) return { ok: false, error: 'not_found' };
  return { ok: true, header: out.header, messages: out.messages };
}
