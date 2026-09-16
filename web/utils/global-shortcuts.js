import { matchShortcut } from './user-shortcuts.js';
import { workbenchRouteKey } from './workbench-route.js';

export const GLOBAL_SHORTCUT_ACTIONS = Object.freeze(['terminal', 'files', 'git', 'newSession', 'closeWorkbench']);

/** Match the actual mounted workbench surface, protocol and exact active Agent route. */
export function isGlobalShortcutAvailable(action, store, auth) {
  if (!GLOBAL_SHORTCUT_ACTIONS.includes(action) || !auth?.isAuthenticated
    || !['yeaft', 'chat'].includes(store.currentView)
    || store.workCenterOpen || store.pluginCenterOpen) return false;
  if (action === 'closeWorkbench') return store.workbenchExpanded === true;
  if (store.connectionState !== 'connected' || !store.authenticated) return false;
  const agent = store.agents?.find(item => item.id === store.currentAgent);
  if (!agent?.online) return false;
  if (action === 'newSession') return true;
  if (store.currentView === 'chat' && (store.isSplitMode || !['admin', 'pro'].includes(auth.role))) return false;
  const route = store.activeSessionRoute;
  if (!workbenchRouteKey(route) || route.agentId !== agent.id
    || store.currentAgentInfo?.id !== agent.id || store.workbenchRouteProtocolSupported !== true) return false;
  const capability = action === 'terminal' ? 'terminal' : 'file_editor';
  return store.hasCapability('workbench_session_routes') && store.hasCapability(capability)
    && agent.capabilities?.includes('workbench_session_routes') === true
    && agent.capabilities?.includes(capability) === true;
}

// Raw key sinks own every keystroke while focused: xterm reads Ctrl+B as readline
// backward-char, and Monaco/CodeMirror plus rich-text editors bind their own
// chords. An app shortcut must never steal from these, in the composer or out.
const RAW_KEY_SINKS = '[contenteditable]:not([contenteditable="false"]), .monaco-editor, .cm-editor, .CodeMirror, .xterm, .terminal-container, iframe';
// Other text fields keep the keyboard so typing never trips an action.
const TEXT_ENTRY = 'input, textarea, select, [role="textbox"]';
// The message composer is the app's primary keyboard surface, so Workbench and
// session actions must stay reachable while it owns focus.
const MESSAGE_COMPOSER = '[data-message-composer]';
const MODALS = '[aria-modal="true"], [role="dialog"], dialog[open], .modal-overlay, .settings-overlay, .agent-settings-overlay';

function isVisible(element, doc) {
  for (let node = element; node?.nodeType === 1; node = node.parentElement) {
    if (node.hidden || node.getAttribute('aria-hidden') === 'true') return false;
    const style = doc.defaultView?.getComputedStyle(node);
    if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  }
  return true;
}

export function isGlobalShortcutFocusBlocked(event, doc = globalThis.document) {
  const targets = [event?.target, doc?.activeElement, ...(event?.composedPath?.() || [])];
  if (targets.some(target => target?.closest?.(RAW_KEY_SINKS))) return true;
  const inComposer = targets.some(target => target?.closest?.(MESSAGE_COMPOSER));
  if (!inComposer && targets.some(target => target?.closest?.(TEXT_ENTRY))) return true;
  return [...(doc?.querySelectorAll(MODALS) || [])].some(element => isVisible(element, doc));
}

/** Returns the dispatched action, or null without suppressing the key. Never handles quick sends. */
export function handleGlobalShortcut(event, { preferences, store, auth, execute, document: doc = globalThis.document }) {
  if (isGlobalShortcutFocusBlocked(event, doc)) return null;
  const action = GLOBAL_SHORTCUT_ACTIONS.find(candidate => matchShortcut(event, preferences?.bindings?.[candidate]));
  if (!action || !isGlobalShortcutAvailable(action, store, auth) || execute(action) !== true) return null;
  event.preventDefault();
  event.stopPropagation();
  return action;
}
