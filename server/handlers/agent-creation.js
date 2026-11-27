import { handleCreationMediaChunk } from '../creation-media-relay.js';
import { forwardAgentEvent } from '../ws-utils.js';
import { deliverCreationResponse } from './client-creation.js';

export async function handleAgentCreation(agentId, agent, msg) {
  switch (msg?.type) {
    case 'creation_response':
      return deliverCreationResponse(agentId, agent, msg);
    case 'creation_event':
      if (agent.capabilities?.includes('creations')) {
        await forwardAgentEvent(agentId, { type: 'creation_event', agentId, event: msg.event });
      }
      return true;
    case 'creation_media_chunk':
      return handleCreationMediaChunk(agentId, agent, msg);
    default:
      return false;
  }
}
