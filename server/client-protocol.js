export const WORKBENCH_ROUTE_PROTOCOL = 1;
export const BROWSER_RUNTIME_PROTOCOL = 1;
export const BROWSER_RUNTIME_SETUP_PROTOCOL = 1;

/**
 * Apply the explicit browser protocol hello to one Server-owned client record.
 * Unknown or omitted fields leave legacy defaults unchanged.
 */
export function applyClientHello(client, message) {
  if (!client || message?.type !== 'client_hello') return false;
  if (message.plaintextOk === true) client.encryptOutbound = false;
  if (message.workbenchRouteProtocol === WORKBENCH_ROUTE_PROTOCOL) {
    client.workbenchRouteProtocol = WORKBENCH_ROUTE_PROTOCOL;
  }
  if (message.browserRuntimeProtocol === BROWSER_RUNTIME_PROTOCOL) {
    client.browserRuntimeProtocol = BROWSER_RUNTIME_PROTOCOL;
  }
  if (message.browserRuntimeSetupProtocol === BROWSER_RUNTIME_SETUP_PROTOCOL) {
    client.browserRuntimeSetupProtocol = BROWSER_RUNTIME_SETUP_PROTOCOL;
  }
  return true;
}
