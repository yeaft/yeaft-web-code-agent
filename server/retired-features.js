const RETIRED_CAPABILITIES = new Set([
  'digital_person', 'work_center', 'work_center_feature_settings',
  'work_center_message_v2', 'work_center_workbench', 'work_item_attachments',
]);

export const LEGACY_WORK_CENTER_UPGRADE = 'Upgrade this Agent to stop its legacy Work Center before starting new Session execution.';

export function hasLegacyWorkCenterRuntime(agent) {
  return Array.isArray(agent?.capabilities) && agent.capabilities.includes('work_center');
}

export function isRetiredBrowserSource(sourceRef) {
  return typeof sourceRef?.kind === 'string' && sourceRef.kind.trim() === 'work-item';
}

export function withoutRetiredCapabilities(capabilities) {
  return capabilities.filter(capability => !RETIRED_CAPABILITIES.has(capability));
}

/** Reject stale browser commands locally, even when an old Agent still supports them. */
export async function rejectRetiredFeatureRequest(client, msg, send) {
  const correlation = {
    agentId: typeof msg.agentId === 'string' && msg.agentId ? msg.agentId : client.currentAgent,
    requestId: typeof msg.requestId === 'string' ? msg.requestId : null,
  };
  switch (msg.type) {
    case 'person_request':
    case 'work_center_request': {
      const person = msg.type === 'person_request';
      await send(client, {
        ...correlation,
        type: person ? 'person_response' : 'work_center_response',
        op: typeof msg.op === 'string' ? msg.op : '',
        ok: false,
        errorCode: 'feature_disabled',
        error: person ? 'Digital Person is disabled' : 'Work Center is disabled',
      });
      return true;
    }
    case 'get_work_center_feature_settings':
    case 'update_work_center_feature_settings': {
      const update = msg.type === 'update_work_center_feature_settings';
      await send(client, {
        ...correlation,
        type: update ? 'work_center_feature_settings_updated' : 'work_center_feature_settings',
        enabled: false,
        effective: false,
        unsupported: true,
        ...(update && { persisted: false, error: 'Work Center is disabled' }),
      });
      return true;
    }
    default:
      return false;
  }
}
