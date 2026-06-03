/**
 * Tiny JSON-RPC 2.0 client over stdio for Agent Client Protocol (ACP).
 *
 * ACP uses newline-delimited JSON (one JSON object per line on each direction).
 * This client:
 *   - sends `request(method, params)` → Promise<result>
 *   - sends `notify(method, params)` (no response expected)
 *   - dispatches incoming notifications via onNotification(method, params)
 *   - dispatches incoming requests (server → client) via onRequest(method, params)
 *     which must return a value (resolved as result) or throw to send an error
 *
 * Designed to be reusable by any ACP-style backend (Copilot today,
 * hermes-agent later).
 */

export class AcpClient {
  /**
   * @param {object} opts
   * @param {NodeJS.WritableStream} opts.stdin   process.stdin of the child
   * @param {NodeJS.ReadableStream} opts.stdout  process.stdout of the child
   * @param {(method:string, params:any)=>void} [opts.onNotification]
   * @param {(method:string, params:any)=>Promise<any>|any} [opts.onRequest]
   * @param {(err:Error)=>void} [opts.onError]   transport-level error sink
   */
  constructor({ stdin, stdout, onNotification, onRequest, onError }) {
    this._stdin = stdin;
    this._stdout = stdout;
    this._onNotification = onNotification || (() => {});
    this._onRequest = onRequest || (() => { throw new Error('no onRequest handler'); });
    this._onError = onError || (() => {});
    this._nextId = 1;
    this._pending = new Map(); // id → { resolve, reject }
    this._buf = '';
    this._closed = false;

    stdout.on('data', (chunk) => this._onData(chunk));
    stdout.on('error', (err) => this._onError(err));
    stdout.on('close', () => this._handleClose());
  }

  /** Send a JSONRPC request and await its response. */
  request(method, params) {
    if (this._closed) return Promise.reject(new Error('acp client closed'));
    const id = this._nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this._stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Send a JSONRPC notification (no id, no response). */
  notify(method, params) {
    if (this._closed) return;
    const payload = { jsonrpc: '2.0', method, params };
    try { this._stdin.write(JSON.stringify(payload) + '\n'); }
    catch (err) { this._onError(err); }
  }

  /** Mark closed; reject all pending requests. */
  close(reason) {
    if (this._closed) return;
    this._closed = true;
    const err = new Error(reason || 'acp client closed');
    for (const { reject } of this._pending.values()) {
      try { reject(err); } catch { /* noop */ }
    }
    this._pending.clear();
  }

  _handleClose() {
    this.close('child stdout closed');
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (err) { this._onError(new Error(`acp: unparsable line: ${line.slice(0, 200)}`)); continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response (has id and result/error, no method)
    if (msg.id != null && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
      const slot = this._pending.get(msg.id);
      if (!slot) return; // stale
      this._pending.delete(msg.id);
      if (msg.error) slot.reject(Object.assign(new Error(msg.error.message || 'acp error'), { code: msg.error.code, data: msg.error.data }));
      else slot.resolve(msg.result);
      return;
    }
    // Request from server (has id and method) — synchronous response required
    if (msg.id != null && typeof msg.method === 'string') {
      Promise.resolve()
        .then(() => this._onRequest(msg.method, msg.params))
        .then((result) => {
          this._safeWrite({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result });
        })
        .catch((err) => {
          this._safeWrite({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: err?.code || -32603, message: err?.message || String(err) },
          });
        });
      return;
    }
    // Notification (method, no id)
    if (typeof msg.method === 'string') {
      try { this._onNotification(msg.method, msg.params); }
      catch (err) { this._onError(err); }
      return;
    }
    this._onError(new Error('acp: unknown message shape'));
  }

  _safeWrite(payload) {
    try { this._stdin.write(JSON.stringify(payload) + '\n'); }
    catch (err) { this._onError(err); }
  }
}

export default AcpClient;
