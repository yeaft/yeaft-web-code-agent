import { THREAD_CLASSIFIER_SYSTEM_PROMPT, buildThreadClassificationPrompt, parseThreadClassification, fallbackClassification } from '../vp/thread-classifier.js';
import { abortable } from './provider.js';
import { bytes } from './contracts.js';

/** A bounded, text-only routing call through the configured native API adapter.
 * No tools, attachment bytes, hidden reasoning, signatures or provider state are
 * forwarded. A failed classifier preserves the existing single-live supplement
 * fallback; a stale selected target becomes a new turn at atomic admission.
 */
export async function routePersonTurn({ getProvider, person, activeEpisodes, messages, input, timeoutMs = 5000 }) {
  const runningThreads = activeEpisodes.slice(-16).map(episode => ({ threadId: episode.episodeId,
    title: episode.inputPreview ?? '', status: episode.status, recentMessages: messages.filter(message => message.episodeId === episode.episodeId)
      .slice(-4).map(({ role, text }) => ({ role, text: text.slice(0, 1000) })) }));
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const provider = await abortable(getProvider(person.settings.modelCandidates ?? [], person.settings.defaultModel ?? null), signal);
    const iterator = provider.adapter.stream({ model: provider.defaultSelection.model,
      system: THREAD_CLASSIFIER_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildThreadClassificationPrompt({ runningThreads, newQuery: input }) }],
      tools: [], maxTokens: 256, signal })[Symbol.asyncIterator]();
    let output = '', stopped = false;
    try {
      for (;;) {
        const item = await abortable(iterator.next(), signal);
        if (item.done) break;
        if (item.value.type === 'text_delta') {
          output += item.value.text;
          if (bytes(output) > 4096) throw new Error('routing output limit');
        } else if (item.value.type === 'stop') {
          if (!['end_turn', 'stop_sequence'].includes(item.value.stopReason)) throw new Error('incomplete routing');
          stopped = true;
        } else if (item.value.type === 'error' || item.value.type === 'tool_call') throw new Error('routing failed');
      }
      if (!stopped) throw new Error('incomplete routing');
      return parseThreadClassification(output, runningThreads, input);
    } finally { try { Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* No provider details leave this call. */ } }
  } catch { return fallbackClassification(runningThreads, input, 'classifier_unavailable'); }
}
