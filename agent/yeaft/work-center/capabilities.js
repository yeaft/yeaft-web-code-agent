/**
 * Work Center reuses builtin tool implementations, but owns their lifecycle.
 * Keep the executable subset and the Coordinator's capability description in
 * one place. This is a host policy, not a claim that shell/MCP is sandboxed.
 */
export const WORK_ITEM_TOOL_NAMES = Object.freeze([
  'FileRead', 'FileWrite', 'FileEdit', 'ApplyPatch', 'Glob', 'Grep',
  'ListDir', 'GitRead', 'Bash', 'WebSearch', 'WebFetch', 'ViewImage', 'Skill',
]);

export function workItemBuiltinToolNames(hasAttachments = false) {
  return WORK_ITEM_TOOL_NAMES.filter(name => !hasAttachments || name !== 'Bash');
}

/** Only identities/roles needed for assignment, never VP souls or credentials. */
export function workItemCapabilityContext(vps = [], { hasAttachments = false } = {}) {
  const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const selected = [];
  for (const vp of vps.slice(0, 48)) {
    // An id must round-trip to the registry; never offer a truncated identity.
    if (typeof vp.id !== 'string' || !vp.id || vp.id.length > 128) continue;
    const candidate = {
      id: vp.id,
      name: bounded(vp.name, 120),
      role: bounded(vp.role, 200),
      traits: (Array.isArray(vp.traits) ? vp.traits : []).slice(0, 8).map(value => bounded(value, 80)),
    };
    if (Buffer.byteLength(JSON.stringify([...selected, candidate]), 'utf8') > 8 * 1024) break;
    selected.push(candidate);
  }
  return {
    executor: 'yeaft-engine',
    tools: workItemBuiltinToolNames(hasAttachments),
    vps: selected,
    omittedVpCount: Math.max(0, vps.length - selected.length),
    mcp: 'Workspace-configured MCP tools are resolved by the executor. Availability and authorization must be verified, not inferred from a VP name.',
    limitations: [
      'No unmanaged background jobs, recursive sub-agents, or Session transcript access.',
      'VP roles provide expertise, not missing tools, credentials, permissions, or external environments.',
      'Use one Action for local investigation, implementation and tests when no independent boundary is needed.',
      'Missing permission or an unavailable required capability is a blocker, not a reason to create more roles.',
    ],
  };
}
