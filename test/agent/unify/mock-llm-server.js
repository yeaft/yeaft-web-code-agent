/**
 * mock-llm-server.js — Lightweight mock LLM server for testing
 *
 * Speaks both Anthropic Messages API and Chat Completions API over SSE.
 * Used by integration tests to verify the full CLI → engine → adapter → server pipeline
 * without hitting real LLM APIs.
 *
 * Usage:
 *   const server = createMockLLMServer();
 *   await server.start(0); // random port
 *   console.log(server.port);
 *   server.setResponse([...events]);  // pre-configure response
 *   // ... run tests ...
 *   await server.stop();
 */

import { createServer } from 'http';

/**
 * Create a mock LLM server.
 *
 * @returns {{ start: (port: number) => Promise<void>, stop: () => Promise<void>, port: number, setResponse: (events: object[]) => void, requests: object[] }}
 */
export function createMockLLMServer() {
  let httpServer = null;
  let port = 0;
  let responseEvents = [];
  const requests = [];

  function handleRequest(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }

      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
      });

      // Detect API format from URL
      if (req.url.includes('/v1/messages')) {
        handleAnthropicStream(req, res, parsed);
      } else if (req.url.includes('/chat/completions')) {
        handleChatCompletionsStream(req, res, parsed);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown endpoint' }));
      }
    });
  }

  function handleAnthropicStream(req, res, body) {
    if (!body.stream) {
      // Non-streaming response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildAnthropicNonStreamResponse()));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // message_start with usage
    writeSSE(res, {
      type: 'message_start',
      message: { usage: { input_tokens: 50, output_tokens: 0 } },
    });

    // Emit configured events
    for (const event of responseEvents) {
      if (event.type === 'text') {
        writeSSE(res, {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        });
        writeSSE(res, {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: event.text },
        });
        writeSSE(res, { type: 'content_block_stop', index: 0 });
      } else if (event.type === 'tool_call') {
        const idx = event.index || 1;
        writeSSE(res, {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
        });
        writeSSE(res, {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.input) },
        });
        writeSSE(res, { type: 'content_block_stop', index: idx });
      }
    }

    // message_delta with stop_reason
    const hasToolCalls = responseEvents.some(e => e.type === 'tool_call');
    writeSSE(res, {
      type: 'message_delta',
      delta: { stop_reason: hasToolCalls ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: 25 },
    });

    res.write('data: [DONE]\n\n');
    res.end();
  }

  function handleChatCompletionsStream(req, res, body) {
    if (!body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildChatCompletionsNonStreamResponse()));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let toolCallIndex = 0;

    for (const event of responseEvents) {
      if (event.type === 'text') {
        writeSSE(res, {
          id: 'mock-1',
          choices: [{
            delta: { role: 'assistant', content: event.text },
            index: 0,
          }],
        });
      } else if (event.type === 'tool_call') {
        // First chunk: id + name
        writeSSE(res, {
          id: 'mock-1',
          choices: [{
            delta: {
              tool_calls: [{
                index: toolCallIndex,
                id: event.id,
                type: 'function',
                function: { name: event.name, arguments: '' },
              }],
            },
            index: 0,
          }],
        });
        // Second chunk: arguments
        writeSSE(res, {
          id: 'mock-1',
          choices: [{
            delta: {
              tool_calls: [{
                index: toolCallIndex,
                function: { arguments: JSON.stringify(event.input) },
              }],
            },
            index: 0,
          }],
        });
        toolCallIndex++;
      }
    }

    // Final chunk with finish_reason and usage
    const hasToolCalls = responseEvents.some(e => e.type === 'tool_call');
    writeSSE(res, {
      id: 'mock-1',
      choices: [{
        delta: {},
        index: 0,
        finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    });

    res.write('data: [DONE]\n\n');
    res.end();
  }

  function buildAnthropicNonStreamResponse() {
    const textParts = responseEvents.filter(e => e.type === 'text');
    return {
      content: textParts.map(e => ({ type: 'text', text: e.text })),
      usage: { input_tokens: 50, output_tokens: 25 },
      stop_reason: 'end_turn',
    };
  }

  function buildChatCompletionsNonStreamResponse() {
    const textParts = responseEvents.filter(e => e.type === 'text');
    return {
      choices: [{
        message: {
          role: 'assistant',
          content: textParts.map(e => e.text).join(''),
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 50, completion_tokens: 25 },
    };
  }

  function writeSSE(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  return {
    get port() { return port; },
    get requests() { return requests; },

    /**
     * Set the events the mock server will respond with.
     * @param {Array<{ type: 'text', text: string } | { type: 'tool_call', id: string, name: string, input: object }>} events
     */
    setResponse(events) {
      responseEvents = events;
    },

    /** Clear recorded requests. */
    clearRequests() {
      requests.length = 0;
    },

    /** Start the server on the given port (0 = random). */
    start(listenPort = 0) {
      return new Promise((resolve, reject) => {
        httpServer = createServer(handleRequest);
        httpServer.listen(listenPort, '127.0.0.1', () => {
          port = httpServer.address().port;
          resolve();
        });
        httpServer.on('error', reject);
      });
    },

    /** Stop the server. */
    stop() {
      return new Promise((resolve) => {
        if (httpServer) {
          httpServer.close(() => resolve());
        } else {
          resolve();
        }
      });
    },
  };
}
