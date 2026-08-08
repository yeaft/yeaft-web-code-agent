export const WORKBENCH_ROUTE_PROTOCOL = 1;

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
  return true;
}
