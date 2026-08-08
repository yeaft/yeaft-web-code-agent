export function workbenchRequestRouting(source) {
  return {
    ...(source?._workbenchRequestId ? { _workbenchRequestId: source._workbenchRequestId } : {}),
    ...(source?.workbenchRouteKey ? { workbenchRouteKey: source.workbenchRouteKey } : {}),
    ...(source?.workbenchWorkspaceGeneration
      ? { workbenchWorkspaceGeneration: source.workbenchWorkspaceGeneration }
      : {}),
  };
}

export function sendWorkbenchResult(ctx, request, result) {
  ctx.sendToServer({
    ...result,
    ...workbenchRequestRouting(request),
  });
}
