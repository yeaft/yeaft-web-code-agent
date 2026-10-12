import { defineTool } from './types.js';
import { PRESENTATION_SCHEMA, normalizePresentation, PRESENT_RESPONSE_DESCRIPTION } from '../response-presentation.js';

export default defineTool({
  name: 'PresentResponse',
  description: PRESENT_RESPONSE_DESCRIPTION,
  parameters: PRESENTATION_SCHEMA,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  cacheWithinQuery: false,
  duplicateCallPolicy: () => 'allow',
  errorOutput: 'json-error-envelope',
  async execute(input, ctx) {
    try {
      // Validate the entire snapshot before invoking any host-side publication.
      const presentation = normalizePresentation(input);
      if (ctx?.signal?.aborted) throw new Error('Response publication was cancelled.');
      if (typeof ctx?.publishResponse !== 'function') {
        throw new Error('Response publication is unavailable in this runtime. Use normal text.');
      }
      const identity = await ctx.publishResponse(presentation);
      return JSON.stringify({ accepted: true, ...identity, message: 'Response accepted for delivery. Continue work if needed; do not repeat the summary. The normal turn boundary still applies.' });
    } catch (error) {
      return JSON.stringify({ error: error.message });
    }
  },
});
