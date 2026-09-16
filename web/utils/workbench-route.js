function cleanRoutePart(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build the stable browser-side identity for one Workbench owner.
 * Each component cache and request must be scoped to this exact route.
 *
 * @param {{runtimeProvider?:string, agentId?:string, sessionId?:string, workItemId?:string}|null} route
 * @returns {string}
 */
export function workbenchRouteKey(route) {
  const runtimeProvider = cleanRoutePart(route?.runtimeProvider);
  const agentId = cleanRoutePart(route?.agentId);
  const ownerId = runtimeProvider === 'work-center'
    ? cleanRoutePart(route?.workItemId)
    : cleanRoutePart(route?.sessionId);
  if (!runtimeProvider || !agentId || !ownerId) return '';
  return [runtimeProvider, agentId, ownerId]
    .map(part => encodeURIComponent(part))
    .join(':');
}

function stableWorkspaceHash(value) {
  let hash = 0xcbf29ce484222325n;
  for (const char of String(value || '')) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function workbenchWorkspaceGeneration(routeKey, workDir) {
  const normalizedRouteKey = cleanRoutePart(routeKey);
  const normalizedWorkDir = cleanRoutePart(workDir);
  if (!normalizedRouteKey || !normalizedWorkDir) return '';
  return `${normalizedRouteKey}@${stableWorkspaceHash(normalizedWorkDir)}`;
}

export function workbenchConversationId(routeKey, scope = 'main') {
  if (!routeKey) return '';
  const normalizedScope = ['main', 'files-folder-picker', 'git-folder-picker'].includes(scope)
    ? scope
    : 'main';
  return normalizedScope === 'main'
    ? `_workbench:${routeKey}`
    : `_workbench:${routeKey}:${normalizedScope}`;
}

export function workbenchMessageScope(message, routeKey) {
  const conversationId = cleanRoutePart(message?.conversationId);
  if (!routeKey || !conversationId) return null;
  if (conversationId === workbenchConversationId(routeKey)) return 'main';
  for (const scope of ['files-folder-picker', 'git-folder-picker']) {
    if (conversationId === workbenchConversationId(routeKey, scope)) return scope;
  }
  return null;
}

/**
 * Bind legacy Workbench components to an immutable Session route without
 * duplicating the Pinia store. Explicit sub-tool conversation ids (folder
 * pickers) are preserved, while owner, default cwd and correlation metadata
 * always come from the route selected when the component was activated.
 *
 * @param {object} store
 * @param {{routeKey:string,runtimeProvider:string,agentId:string,sessionId?:string,workItemId?:string,conversationId:string,workDir:string,workspaceLocked?:boolean}} route
 * @returns {object}
 */
export function createRouteBoundWorkbenchStore(store, route) {
  const sendWsMessage = (message = {}) => {
    const workbenchRoute = {
      runtimeProvider: cleanRoutePart(route.runtimeProvider),
      agentId: cleanRoutePart(route.agentId),
      ...(route.runtimeProvider === 'work-center'
        ? { workItemId: cleanRoutePart(route.workItemId) }
        : { sessionId: cleanRoutePart(route.sessionId) }),
    };
    let workbenchScope = 'main';
    if (message.conversationId === '_folder_picker') workbenchScope = 'files-folder-picker';
    else if (message.conversationId === '_git_folder_picker') workbenchScope = 'git-folder-picker';
    const scoped = {
      ...message,
      agentId: workbenchRoute.agentId,
      workbenchRoute,
      workbenchRouteKey: route.routeKey,
      workbenchWorkspaceGeneration: route.workspaceGeneration,
      workbenchScope,
      conversationId: workbenchConversationId(route.routeKey, workbenchScope),
    };
    if (route.workspaceLocked === true) scoped.workDir = route.workDir;
    else if (!Object.hasOwn(scoped, 'workDir') && route.workDir) scoped.workDir = route.workDir;
    return store.sendWsMessage(scoped);
  };

  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'currentAgent') return route.agentId || null;
      if (property === 'currentConversation') return route.conversationId || route.sessionId || null;
      if (property === 'effectiveWorkDir') return route.workDir || '';
      if (property === 'activeSessionRoute') {
        return {
          runtimeProvider: route.runtimeProvider,
          agentId: route.agentId,
          ...(route.runtimeProvider === 'work-center'
            ? { workItemId: route.workItemId }
            : { sessionId: route.sessionId }),
        };
      }
      if (property === 'sendWsMessage') return sendWsMessage;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      return Reflect.set(target, property, value, receiver);
    },
  });
}

export function isWorkbenchMessageForRoute(message, routeKey, workspaceGeneration = '') {
  if (!routeKey) return true;
  const routeMatches = message?.workbenchRouteKey
    ? message.workbenchRouteKey === routeKey
    : workbenchMessageScope(message, routeKey) !== null;
  if (!routeMatches) return false;
  if (!workspaceGeneration) return true;
  return message?.workbenchWorkspaceGeneration === workspaceGeneration;
}
