import { createHash } from 'crypto';
import path from 'path';
import { realpathSync } from 'fs';

function canonicalJSON(value) {
  if (Array.isArray(value)) return value.map(canonicalJSON);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJSON(value[key])]));
  }
  return value;
}

/** Resolve relative child paths against the caller workspace, not the process cwd. */
export function resolveAgentCwd(cwd, parentCwd) {
  return path.resolve(parentCwd || process.cwd(), cwd || '.');
}

function canonicalWorkspace(cwd) {
  let resolved = resolveAgentCwd(cwd);
  try { resolved = realpathSync(resolved); } catch { /* non-existent paths keep lexical identity */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Exact, query-local delegation identity. Names are labels, not task identity.
 * No queryTurnId means a legacy caller: do not infer a scope or deduplicate it.
 * The owner is checked separately with agentBelongsToScope before reuse.
 */
export function buildDelegationIdentity(input, spec, grants, ctx = {}) {
  const queryTurnId = typeof ctx?.queryTurnId === 'string' ? ctx.queryTurnId.trim() : '';
  if (!queryTurnId) return null;
  const workspace = canonicalWorkspace(ctx.cwd);
  const taskSpec = {
    mission: spec.mission,
    persona: spec.persona,
    cwd: canonicalWorkspace(resolveAgentCwd(input.cwd, ctx.cwd)),
    baseline: input.baseline ?? null,
    expected_output: spec.expected_output,
    allow_tools: [...grants].sort(),
    budget: spec.budget,
  };
  const specHash = createHash('sha256').update(JSON.stringify(canonicalJSON(taskSpec))).digest('hex');
  return { queryTurnId, workspace, taskKey: input.taskKey?.trim() || null, specHash };
}
