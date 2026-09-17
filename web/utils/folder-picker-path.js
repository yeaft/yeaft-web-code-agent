/** Browser-side navigation only; the Agent resolves and validates actual paths. */
export function directoryBreadcrumbs(path) {
  if (!path) return [];
  const drive = path.match(/^[a-z]:[/\\]/i);
  const unc = path.match(/^(?:\\\\|\/\/)([^/\\]+)[/\\]([^/\\]+)(?:[/\\]|$)/);
  const windows = !!(drive || unc);
  const sep = windows && path.includes('\\') ? '\\' : '/';
  const root = drive ? path.slice(0, 2) + sep
    : unc ? sep + sep + unc[1] + sep + unc[2] + sep
      : path.startsWith('/') ? '/' : '';
  if (!root) return [];
  const rootLength = unc ? unc[0].length : root.length;
  const parts = path.slice(rootLength).split(windows ? /[/\\]/ : /\//).filter(Boolean);
  const crumbs = [{ label: root, path: root }];
  let current = root;
  for (const part of parts) {
    current = current.replace(windows ? /[/\\]$/ : /\/$/, '') + sep + part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

export function parentDirectory(path) {
  const crumbs = directoryBreadcrumbs(path);
  if (crumbs.length > 1) return crumbs[crumbs.length - 2].path;
  // POSIX / is a real directory; Windows' empty path is the drive chooser.
  return path === '/' ? '/' : '';
}

export function childDirectory(path, name) {
  if (!path && /^[a-z]:$/i.test(name)) return name + '\\';
  const windows = /^[a-z]:[/\\]/i.test(path) || /^\\\\/.test(path);
  const sep = windows && path.includes('\\') ? '\\' : '/';
  return path.replace(windows ? /[/\\]$/ : /\/$/, '') + sep + name;
}
