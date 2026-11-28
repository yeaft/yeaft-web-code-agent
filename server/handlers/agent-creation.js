import { CONFIG } from '../config.js';
import { handleCreationMediaChunk } from '../creation-media-relay.js';
import { forwardAgentEvent } from '../ws-utils.js';
import { deliverCreationResponse, hasClientRelayId } from './client-creation.js';

const PRIVATE_AI_EVENT_TYPES = new Set(['inline_edit_delta', 'inline_edit_complete', 'review_lens_complete', 'review_complete']);

export async function handleAgentCreation(agentId, agent, msg) {
  switch (msg?.type) {
    case 'creation_response':
      return deliverCreationResponse(agentId, agent, msg);
    case 'creation_event':
      if (agent.capabilities?.includes('creations')) {
        const { ownerId, targetClientId, event } = msg;
        const targeted = PRIVATE_AI_EVENT_TYPES.has(event?.type) || targetClientId != null;
        if (targeted && (typeof targetClientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(targetClientId))) return true;
        await forwardAgentEvent(agentId, { type: 'creation_event', agentId, event },
          client => (CONFIG.skipAuth || (typeof ownerId === 'string' && ownerId.length > 0 && client.userId === ownerId))
            && (!targeted || hasClientRelayId(client, targetClientId)));
      }
      return true;
    case 'creation_media_chunk':
      return handleCreationMediaChunk(agentId, agent, msg);
    default:
      return false;
  }
}
