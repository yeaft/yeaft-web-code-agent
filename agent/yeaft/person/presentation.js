import { normalizePresentation } from '../response-presentation.js';
import { fail, identifier } from './contracts.js';

/** Validate the shared payload at both execution and durable authority boundaries. */
export function personPresentation(args) {
  try { return normalizePresentation(args); }
  catch { fail('INVALID_REQUEST'); }
}

/** Older/invalid JSON records still have their ordinary searchable text fallback. */
export function presentationView(value) {
  if (!value || value.version !== 1) return null;
  const { version, ...input } = value;
  if (input.title === '') delete input.title;
  try { return normalizePresentation(input); } catch { return null; }
}

/** Publication is joined, not raced against abort: an accepted message is durable
 * even if cancellation arrives before the worker's receipt. No cognitive commit. */
export async function publishPresentation(repository, episode, args, { signal, callId } = {}) {
  signal?.throwIfAborted();
  try { personPresentation(args); }
  catch { return { ok: false, code: 'INVALID_REQUEST', published: false,
    notice: 'Nothing was published. Correct the structured response or use an ordinary reply.' }; }
  if (!episode || !callId || !repository.savePresentation) fail('UNSUPPORTED');
  identifier(callId);
  signal?.throwIfAborted();
  const message = await repository.savePresentation(episode, { callId, args });
  return { ok: true, published: true, messageId: message.id, summary: message.text,
    phase: message.presentation.phase, createdAt: message.createdAt,
    notice: 'User-visible communication only, not a cognitive commit or episode termination. Do not repeat this summary in reply. Publication survives subsequent cancellation or failure.' };
}
