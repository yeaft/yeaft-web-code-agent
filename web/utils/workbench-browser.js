import { normalizeBrowserAddress } from './browser-address.js';
import { workbenchRouteKey, workbenchWorkspaceGeneration } from './workbench-route.js';

/** Open a client URL only in its owning Workbench. No Agent/Server request. */
export function openWorkbenchBrowser(url, route, workDir = '') {
  const normalized = normalizeBrowserAddress(url);
  const routeKey = workbenchRouteKey(route);
  if (!normalized || !routeKey || typeof window === 'undefined') return false;
  const detail = {
    url: normalized,
    routeKey,
    workspaceGeneration: workbenchWorkspaceGeneration(routeKey, workDir),
    accepted: false,
  };
  window.dispatchEvent(new CustomEvent('workbench-open-browser', { detail }));
  return detail.accepted === true;
}

/** Preserve modifier/middle/download links and native fallback when no host accepts. */
export function handleWorkbenchBrowserLink(event, openUrl) {
  if (event.defaultPrevented || (event.button != null && event.button !== 0)
    || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  const anchor = event.target?.closest?.('a[href]');
  if (!anchor || !event.currentTarget?.contains?.(anchor) || anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href') || '';
  if (!/^(?:https?:\/\/|\/\/)/i.test(href)) return false;
  const url = normalizeBrowserAddress(href);
  if (!url || openUrl(url) !== true) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
