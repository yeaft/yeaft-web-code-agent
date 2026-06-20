/**
 * systemd-scope.js — run child processes outside the agent service cgroup.
 *
 * When yeaft-agent runs as a systemd user service, shell tasks inherit the
 * yeaft-agent.service cgroup by default. Long-lived commands then show up as
 * "left-over process" entries every time the agent service restarts. Wrapping
 * shell commands in a transient user scope keeps those user workloads alive
 * without polluting the agent service lifecycle.
 */

import { existsSync } from 'fs';
import { delimiter, isAbsolute, join } from 'path';

const DEFAULT_SCOPE_PREFIX = 'yeaft-shell';
const UNIT_MAX_LENGTH = 180;

function hasPathSeparator(command) {
  return command.includes('/') || command.includes('\\');
}

export function findExecutableOnPath(command, env = process.env) {
  if (!command || typeof command !== 'string') return null;
  if (hasPathSeparator(command)) return existsSync(command) ? command : null;

  const pathValue = env.PATH || '';
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = isAbsolute(dir) ? join(dir, command) : join(process.cwd(), dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function shouldUseSystemdUserScope({ runtimePlatform, env = process.env, systemdRunPath = null } = {}) {
  if (!runtimePlatform?.isLinux) return false;
  if (env.YEAFT_DISABLE_SYSTEMD_SCOPE === '1') return false;

  // INVOCATION_ID is set for systemd services and transient scopes. XDG_RUNTIME_DIR
  // is required for `systemd-run --user` to talk to the user manager.
  if (!env.INVOCATION_ID || !env.XDG_RUNTIME_DIR) return false;

  const resolvedSystemdRun = systemdRunPath || findExecutableOnPath('systemd-run', env);
  return !!resolvedSystemdRun;
}

export function sanitizeSystemdUnitPart(value) {
  const raw = String(value || '').trim() || `${Date.now()}-${process.pid}`;
  return raw
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, UNIT_MAX_LENGTH) || `${Date.now()}-${process.pid}`;
}

export function buildSystemdScopeName(scopeId, prefix = DEFAULT_SCOPE_PREFIX) {
  const safePrefix = sanitizeSystemdUnitPart(prefix).slice(0, 48);
  const safeId = sanitizeSystemdUnitPart(scopeId);
  const base = `${safePrefix}-${safeId}`.slice(0, UNIT_MAX_LENGTH);
  return base.endsWith('.scope') ? base : `${base}.scope`;
}

export function wrapInvocationInSystemdUserScope(invocation, {
  runtimePlatform,
  env = process.env,
  scopeId = null,
  scopePrefix = DEFAULT_SCOPE_PREFIX,
  systemdRunPath = null,
} = {}) {
  if (!shouldUseSystemdUserScope({ runtimePlatform, env, systemdRunPath })) {
    return { ...invocation, systemdScope: null };
  }

  const scopeName = buildSystemdScopeName(scopeId, scopePrefix);
  return {
    command: systemdRunPath || findExecutableOnPath('systemd-run', env) || 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${scopeName}`,
      invocation.command,
      ...(invocation.args || []),
    ],
    family: invocation.family,
    systemdScope: scopeName,
    wrappedCommand: invocation.command,
  };
}
