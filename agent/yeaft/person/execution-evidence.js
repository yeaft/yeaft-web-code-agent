import { isDeepStrictEqual } from 'node:util';
import { bytes, digest, fail, identifier, object } from './contracts.js';

/** Native wire names encode dots as double underscores (PersonCapabilities).
 * A provider ID is scoped to its request, never a global execution identity.
 * Malformed calls may be journaled for a no-effect error, but not published. */
export function nativeInvocationMatches(output, started, { executable = false } = {}) {
  if (output?.protocol !== 'native-tools' || !Array.isArray(output.toolCalls) ||
      !Number.isSafeInteger(started.toolIndex) || started.toolIndex < 0) return false;
  const call = output.toolCalls[started.toolIndex];
  return Boolean(call && call.id === started.toolUseId &&
    typeof started.capability?.id === 'string' && call.name === started.capability.id.replaceAll('.', '__') &&
    (!executable || call.malformed !== true) && isDeepStrictEqual(call.input, started.capability.args));
}

export const EXECUTION_READ_LIMITS = Object.freeze({ pageBytes: 4096, responseBytes: 8192, argsBytes: 1024 });

/** Scope is supplied by the live runtime episode, never by model arguments. */
export function executionReadRequest(args) {
  object(args, ['callId', 'sourceRef', 'episodeId', 'offset', 'maxBytes'], []);
  if ((args.callId !== undefined) === (args.sourceRef !== undefined)) fail('INVALID_REQUEST');
  if (args.callId !== undefined) identifier(args.callId);
  if (args.sourceRef !== undefined) personToolReference(args.sourceRef);
  if (args.episodeId !== undefined) identifier(args.episodeId);
  const offset = args.offset ?? 0, maxBytes = args.maxBytes ?? EXECUTION_READ_LIMITS.pageBytes;
  // Four bytes guarantee progress for even a single astral code point.
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > EXECUTION_READ_LIMITS.pageBytes) fail('INVALID_REQUEST');
  return { ...(args.callId !== undefined ? { callId: args.callId } : { sourceRef: args.sourceRef }), ...(args.episodeId !== undefined ? { episodeId: args.episodeId } : {}), offset, maxBytes };
}

// Only exact task-host archive identities, never filenames or loose ID matches.
export function personToolReference(ref) {
  const match = typeof ref === 'string' && /^person-tool:([a-f0-9]{64}):([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(ref);
  if (!match || match[0] !== ref) fail('INVALID_REQUEST');
  return { scope: match[1], id: match[2] };
}

const continuation = byte => (byte & 0xc0) === 0x80;
export function utf8End(buffer, end) {
  while (end > 0 && end < buffer.length && continuation(buffer[end])) end--;
  return end;
}
export function utf8Start(buffer, start) {
  while (start < buffer.length && continuation(buffer[start])) start++;
  return start;
}

/** Truncate the serialized JSON preview, counting JSON string escaping too. */
function invocationArgs(args) {
  const serialized = JSON.stringify(args ?? {}), raw = Buffer.from(serialized, 'utf8');
  if (raw.length <= EXECUTION_READ_LIMITS.argsBytes) return { args: args ?? {}, argsTruncated: false, argsRawBytes: raw.length };
  let end = utf8End(raw, Math.min(raw.length, EXECUTION_READ_LIMITS.argsBytes));
  while (bytes(JSON.stringify(raw.subarray(0, end).toString('utf8'))) > EXECUTION_READ_LIMITS.argsBytes) end = utf8End(raw, end - 1);
  return { args: null, argsPreview: raw.subarray(0, end).toString('utf8'), argsTruncated: true, argsRawBytes: raw.length };
}

/** Projection only: the durable trace is the authority and remains unchanged.
 * offset/nextOffset count original UTF-8 bytes. Reject mid-codepoint offsets;
 * pages end at a codepoint boundary and may shrink to fit escaped response JSON. */
export function executionEvidencePage(trace, started, request, liveEpisodeId) {
  const result = trace.result;
  const outputFormat = typeof result?.output === 'string' ? 'output-text' : result && Object.hasOwn(result, 'output') ? 'output-json' : 'result-json';
  const output = outputFormat === 'output-text' ? result.output : JSON.stringify(outputFormat === 'output-json' ? result.output : result ?? { ok: false, code: trace.code ?? null });
  const raw = Buffer.from(output, 'utf8'), sha256 = digest(output);
  if (request.offset > raw.length || (request.offset < raw.length && continuation(raw[request.offset]))) fail('INVALID_REQUEST');
  const invocation = started?.capability ?? trace.capability;
  const failed = trace.kind === 'capability_failed' || trace.outcome === 'capability_failed' || result?.ok === false;
  const page = { id: 'Execution.read', episodeId: trace.episodeId, ...(request.callId !== undefined ? { callId: request.callId } : {}),
    ...Object.fromEntries(['tool', 'childId', 'aborted', 'replaySafe'].filter(key => Object.hasOwn(result ?? {}, key)).map(key => [key, result[key]])),
    ...(started?.modelCallId !== undefined ? { modelCallId: started.modelCallId, toolUseId: started.toolUseId, toolIndex: started.toolIndex } : {}),
    capabilityId: invocation?.id ?? trace.capabilityId ?? trace.capabilityManifest?.id ?? result?.id ?? null,
    ...invocationArgs(invocation?.args), ok: !failed, code: trace.code ?? result?.code ?? null,
    errorEffect: result?.errorEffect ?? null, sourceRef: result?.sourceRef ?? `trace:${trace.episodeId}:${request.callId}:${trace.id}`,
    rawBytes: raw.length, sha256, outputFormat, offset: request.offset, output: '', returnedBytes: 0,
    nextOffset: request.offset, eof: request.offset === raw.length, historical: trace.episodeId !== liveEpisodeId,
    authority: 'evidence-only', recovery: { read: { id: 'Execution.read', args: {
      ...(request.sourceRef !== undefined ? { sourceRef: request.sourceRef } : { callId: request.callId }),
      episodeId: trace.episodeId, offset: request.offset, maxBytes: request.maxBytes } } },
    ...(trace.afterTerminal ? { afterTerminal: true, accepted: false, terminalCode: trace.terminalCode } : {}) };
  let end = utf8End(raw, Math.min(raw.length, request.offset + request.maxBytes));
  for (;;) {
    page.output = raw.subarray(request.offset, end).toString('utf8');
    page.returnedBytes = end - request.offset; page.nextOffset = end; page.eof = end === raw.length;
    if (bytes(page) <= EXECUTION_READ_LIMITS.responseBytes) break;
    if (end === request.offset) fail('CONTEXT_LIMIT');
    end = utf8End(raw, end - 1);
  }
  if (!page.eof && !page.returnedBytes) fail('CONTEXT_LIMIT');
  return page;
}
