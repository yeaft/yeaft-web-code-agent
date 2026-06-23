/**
 * Main query implementation for Claude Code SDK
 * Handles spawning Claude process and managing message streams
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { Stream } from './stream.js';
import { AbortError } from './types.js';
import { normalizeClaudeMessage, shouldForwardTextDeltaForBlockType } from './message-normalize.js';
import { getCleanEnv, logDebug, streamToStdin, resolveClaudeCommand } from './utils.js';


/**
 * Query class manages Claude Code process interaction
 * Implements AsyncIterableIterator for streaming messages
 */
export class Query {
  constructor(childStdin, childStdout, processExitPromise, canCallTool) {
    this.pendingControlResponses = new Map();
    this.cancelControllers = new Map();
    this.inputStream = new Stream();
    this.childStdin = childStdin;
    this.childStdout = childStdout;
    this.processExitPromise = processExitPromise;
    this.canCallTool = canCallTool;
    this.claudeSessionId = null;

    this.readMessages();
    this.sdkMessages = this.readSdkMessages();
  }

  /**
   * Get the Claude session ID
   */
  getSessionId() {
    return this.claudeSessionId;
  }

  /**
   * Set an error on the stream
   */
  setError(error) {
    this.inputStream.error(error);
  }

  /**
   * AsyncIterableIterator implementation
   */
  next(...args) {
    return this.sdkMessages.next(...args);
  }

  return(value) {
    if (this.sdkMessages.return) {
      return this.sdkMessages.return(value);
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  throw(e) {
    if (this.sdkMessages.throw) {
      return this.sdkMessages.throw(e);
    }
    return Promise.reject(e);
  }

  [Symbol.asyncIterator]() {
    return this.sdkMessages;
  }

  /**
   * Read messages from Claude process stdout
   *
   * With --include-partial-messages, the CLI emits stream_event messages
   * containing incremental text deltas (content_block_delta / text_delta).
   * We convert these to assistant-format messages for real-time streaming,
   * then deduplicate when the final complete assistant message arrives.
   */
  async readMessages() {
    const rl = createInterface({ input: this.childStdout });

    // Track whether we've forwarded text deltas for the current assistant turn.
    // When true, the next complete `assistant` message's text blocks are redundant.
    let hasStreamedTextDeltas = false;
    const streamBlockTypes = new Map();

    try {
      for await (const line of rl) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);

            // Capture session ID from system messages
            if (message.type === 'system' && message.session_id) {
              this.claudeSessionId = message.session_id;
              logDebug(`Session ID captured: ${this.claudeSessionId}`);
            }

            if (message.type === 'control_response') {
              const handler = this.pendingControlResponses.get(message.response.request_id);
              if (handler) {
                handler(message.response);
              }
              continue;
            } else if (message.type === 'control_request') {
              await this.handleControlRequest(message);
              continue;
            } else if (message.type === 'control_cancel_request') {
              this.handleControlCancelRequest(message);
              continue;
            }

            // Handle stream_event messages (from --include-partial-messages)
            if (message.type === 'stream_event') {
              const event = message.event;
              if (!event) continue;

              if (event.type === 'content_block_start') {
                streamBlockTypes.set(event.index, event.content_block?.type || null);
                continue;
              }
              if (event.type === 'content_block_stop') {
                streamBlockTypes.delete(event.index);
                continue;
              }
              // content_block_delta with text_delta → convert to assistant message for streaming,
              // but only while the active block is actually text. Some Claude Code builds
              // expose tool-call assembly as text-looking deltas; forwarding those leaks
              // raw `call`, transient ids, and JSON arguments into the chat transcript.
              if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
                const blockType = streamBlockTypes.get(event.index);
                if (shouldForwardTextDeltaForBlockType(blockType)) {
                  hasStreamedTextDeltas = true;
                  this.inputStream.enqueue({
                    type: 'assistant',
                    message: {
                      role: 'assistant',
                      content: [{ type: 'text', text: event.delta.text }]
                    }
                  });
                }
              }
              // All other stream events (message_start, input_json_delta,
              // message_stop) are ignored. Tool use is handled via the complete
              // assistant message after block normalization below.
              continue;
            }

            const normalizedMessage = normalizeClaudeMessage(message);

            // Deduplicate: when a complete assistant message arrives after we've
            // already streamed text deltas, strip the text blocks (already sent).
            // Keep tool_use blocks which are NOT sent incrementally.
            if (normalizedMessage.type === 'assistant' && hasStreamedTextDeltas) {
              hasStreamedTextDeltas = false; // Reset for next assistant turn

              const content = normalizedMessage.message?.content;
              if (Array.isArray(content)) {
                const nonTextBlocks = content.filter(b => b.type !== 'text');
                if (nonTextBlocks.length > 0) {
                  // Forward only tool_use blocks (text already sent via deltas)
                  normalizedMessage.message.content = nonTextBlocks;
                  this.inputStream.enqueue(normalizedMessage);
                } else {
                  // Pure text message fully streamed — send finish-streaming signal
                  // so frontend clears isStreaming and typing dots can reappear
                  this.inputStream.enqueue({
                    type: 'assistant',
                    message: { role: 'assistant', content: [] },
                    _finishStreaming: true
                  });
                }
                // If only text blocks: skip entirely (all content already streamed)
              } else if (typeof content === 'string') {
                // String content was already streamed — skip
              } else {
                // Unknown format — forward as-is to be safe
                this.inputStream.enqueue(message);
              }
              continue;
            }

            // Reset delta tracking on non-assistant messages
            // (e.g., user, result, system — a new turn boundary)
            if (normalizedMessage.type !== 'assistant') {
              hasStreamedTextDeltas = false;
              streamBlockTypes.clear();
            }

            this.inputStream.enqueue(normalizedMessage);
          } catch (e) {
            logDebug(`Non-JSON line: ${line.substring(0, 100)}`);
          }
        }
      }
      await this.processExitPromise;
    } catch (error) {
      this.inputStream.error(error);
    } finally {
      this.inputStream.done();
      this.cleanupControllers();
      rl.close();
    }
  }

  /**
   * Async generator for SDK messages
   */
  async *readSdkMessages() {
    for await (const message of this.inputStream) {
      yield message;
    }
  }

  /**
   * Send interrupt request to Claude
   */
  async interrupt() {
    if (!this.childStdin) {
      throw new Error('Interrupt requires --input-format stream-json');
    }

    await this.request({
      subtype: 'interrupt'
    }, this.childStdin);
  }

  /**
   * Send a user message
   */
  sendMessage(content) {
    if (!this.childStdin) {
      throw new Error('sendMessage requires --input-format stream-json');
    }

    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: typeof content === 'string' ? content : content
      }
    };

    this.childStdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * Send control request to Claude process
   */
  request(request, childStdin) {
    const requestId = Math.random().toString(36).substring(2, 15);
    const sdkRequest = {
      request_id: requestId,
      type: 'control_request',
      request
    };

    return new Promise((resolve, reject) => {
      this.pendingControlResponses.set(requestId, (response) => {
        if (response.subtype === 'success') {
          resolve(response);
        } else {
          reject(new Error(response.error));
        }
      });

      childStdin.write(JSON.stringify(sdkRequest) + '\n');
    });
  }

  /**
   * Handle incoming control requests for tool permissions
   */
  async handleControlRequest(request) {
    if (!this.childStdin) {
      logDebug('Cannot handle control request - no stdin available');
      return;
    }

    const controller = new AbortController();
    this.cancelControllers.set(request.request_id, controller);

    try {
      const response = await this.processControlRequest(request, controller.signal);
      const controlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response
        }
      };
      this.childStdin.write(JSON.stringify(controlResponse) + '\n');
    } catch (error) {
      const controlErrorResponse = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: error instanceof Error ? error.message : String(error)
        }
      };
      this.childStdin.write(JSON.stringify(controlErrorResponse) + '\n');
    } finally {
      this.cancelControllers.delete(request.request_id);
    }
  }

  /**
   * Handle control cancel requests
   */
  handleControlCancelRequest(request) {
    const controller = this.cancelControllers.get(request.request_id);
    if (controller) {
      controller.abort();
      this.cancelControllers.delete(request.request_id);
    }
  }

  /**
   * Process control requests based on subtype
   */
  async processControlRequest(request, signal) {
    if (request.request.subtype === 'can_use_tool') {
      if (!this.canCallTool) {
        throw new Error('canCallTool callback is not provided.');
      }
      return this.canCallTool(request.request.tool_name, request.request.input, {
        signal
      });
    }

    throw new Error('Unsupported control request subtype: ' + request.request.subtype);
  }

  /**
   * Cleanup method to abort all pending control requests
   */
  cleanupControllers() {
    for (const [requestId, controller] of this.cancelControllers.entries()) {
      controller.abort();
      this.cancelControllers.delete(requestId);
    }
  }
}

/**
 * Main query function to interact with Claude Code
 * @param {object} config - Configuration object
 * @param {string|AsyncIterable} config.prompt - The prompt or async iterable of messages
 * @param {object} config.options - Query options
 * @returns {Query} Query instance
 */
export function query(config) {
  const {
    prompt,
    options: {
      allowedTools = [],
      appendSystemPrompt,
      customSystemPrompt,
      cwd,
      disallowedTools = [],
      maxTurns,
      permissionMode = 'default',
      continue: continueConversation,
      resume,
      forkSession,
      model,
      canCallTool,
      abort,
      noSessionPersistence,
      disableSlashCommands
    } = {}
  } = config;

  // Build command arguments
  const args = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  if (customSystemPrompt) args.push('--system-prompt', customSystemPrompt);
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  if (maxTurns) args.push('--max-turns', maxTurns.toString());
  if (model) args.push('--model', model);
  if (canCallTool) {
    if (typeof prompt === 'string') {
      throw new Error('canCallTool callback requires --input-format stream-json. Please set prompt as an AsyncIterable.');
    }
    args.push('--permission-prompt-tool', 'stdio');
  }
  if (continueConversation) args.push('--continue');
  if (resume) args.push('--resume', resume);
  if (forkSession) args.push('--fork-session');
  if (allowedTools.length > 0) args.push('--allowedTools', ...allowedTools);
  if (disallowedTools.length > 0) args.push('--disallowedTools', ...disallowedTools);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (noSessionPersistence) args.push('--no-session-persistence');
  if (disableSlashCommands) args.push('--disable-slash-commands');

  // Handle prompt input
  if (typeof prompt === 'string') {
    args.push('--print', prompt.trim());
  } else {
    args.push('--input-format', 'stream-json');
  }

  const { command: claudeCommand, prefixArgs, spawnOpts } = resolveClaudeCommand();
  const spawnEnv = getCleanEnv();

  console.log(`[SDK] Spawning Claude Code:`);
  console.log(`[SDK]   command: ${claudeCommand}`);
  if (prefixArgs.length) console.log(`[SDK]   entrypoint: ${prefixArgs[0]}`);
  console.log(`[SDK]   args: ${args.join(' ')}`);
  console.log(`[SDK]   cwd: ${cwd}`);
  if (spawnOpts.shell) console.log(`[SDK]   shell: ${spawnOpts.shell}`);
  logDebug(`Spawning Claude Code: ${claudeCommand} ${[...prefixArgs, ...args].join(' ')}`);

  const child = spawn(claudeCommand, [...prefixArgs, ...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: abort,
    env: spawnEnv,
    windowsHide: true,
    ...spawnOpts,
  });

  // Handle stdin
  let childStdin = null;
  if (typeof prompt === 'string') {
    child.stdin.end();
  } else {
    streamToStdin(prompt, child.stdin, abort);
    childStdin = child.stdin;
  }

  // Handle stderr - always capture for debugging
  let stderrBuffer = '';
  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrBuffer += text;
    if (process.env.DEBUG) {
      console.error('Claude Code stderr:', text);
    }
  });

  // Setup cleanup
  const cleanup = () => {
    if (!child.killed) {
      child.kill();
    }
  };

  abort?.addEventListener('abort', cleanup);
  process.on('exit', cleanup);

  // Handle process exit
  const processExitPromise = new Promise((resolve) => {
    child.on('close', (code) => {
      if (abort?.aborted) {
        queryInstance.setError(new AbortError('Claude Code process aborted by user'));
      }
      if (code !== 0) {
        const errorMsg = stderrBuffer ? `Claude Code process exited with code ${code}: ${stderrBuffer.trim()}` : `Claude Code process exited with code ${code}`;
        console.error('[SDK] Process error:', errorMsg);
        queryInstance.setError(new Error(errorMsg));
      } else {
        resolve();
      }
    });
  });

  // Create query instance
  const queryInstance = new Query(childStdin, child.stdout, processExitPromise, canCallTool);

  // Handle process errors
  child.on('error', (error) => {
    if (abort?.aborted) {
      queryInstance.setError(new AbortError('Claude Code process aborted by user'));
    } else {
      const cwdInfo = error.code === 'ENOENT' && cwd ? ` (cwd: ${cwd})` : '';
      queryInstance.setError(new Error(`Failed to spawn Claude Code process: ${error.message}${cwdInfo}`));
    }
  });

  // Cleanup on exit
  processExitPromise.finally(() => {
    cleanup();
    abort?.removeEventListener('abort', cleanup);
  });

  return queryInstance;
}
