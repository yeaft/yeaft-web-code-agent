import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS } from 'quickjs-emscripten';

// Separate WASM interpreter, NOT node:vm. No host functions/modules are bound.
// Parent termination bounds startup, computation, output extraction and cleanup.
let runtime, context;
try {
  const engine = await getQuickJS();
  runtime = engine.newRuntime();
  runtime.setMemoryLimit(16 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = Date.now() + 200;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  context = runtime.newContext();
  const { code, input } = workerData;
  // Capture intrinsics before executing generated code; Function compiles ONLY a
  // function body and has no access to this validation closure. Neither raw code
  // interpolation nor mutable guest serializers can redefine the output boundary.
  const source = `(() => {
    'use strict';
    const compile = Function, parse = JSON.parse, stringify = JSON.stringify;
    const isArray = Array.isArray, finite = Number.isFinite;
    const proto = Object.getPrototypeOf, objectProto = Object.prototype;
    const descriptor = Object.getOwnPropertyDescriptor, keys = Reflect.ownKeys;
    const create = Object.create, setProto = Object.setPrototypeOf, ErrorType = Error;
    const input = parse(${JSON.stringify(JSON.stringify(input))});
    const fn = compile('input', ${JSON.stringify(`'use strict';\n${code}`)});
    const ancestors = create(null);
    let nodes = 0;
    function snapshot(v, depth) {
      if (++nodes > 8192 || depth > 32) throw new ErrorType('JSON limit');
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
      if (typeof v === 'number' && finite(v)) return v;
      if (typeof v !== 'object') throw new ErrorType('JSON only');
      for (let i = 0; i < depth; i++) if (ancestors[i] === v) throw new ErrorType('JSON cycle');
      const array = isArray(v), p = proto(v);
      if (!array && p !== objectProto && p !== null) throw new ErrorType('JSON object only');
      const names = keys(v);
      const length = array ? descriptor(v, 'length').value : names.length;
      if (length > 8192 || names.length !== length + (array ? 1 : 0)) throw new ErrorType('JSON keys');
      const out = array ? setProto([], null) : create(null);
      ancestors[depth] = v;
      for (let i = 0; i < length; i++) {
        const key = array ? '' + i : names[i];
        if (typeof key !== 'string') throw new ErrorType('JSON key');
        const d = descriptor(v, key);
        if (!d || !d.enumerable || !descriptor(d, 'value')) throw new ErrorType('JSON data only');
        out[key] = snapshot(d.value, depth + 1);
      }
      delete ancestors[depth];
      return out;
    }
    const value = snapshot(fn(input), 0);
    // Snapshot has null prototypes and data properties only: no guest getters or
    // inherited toJSON are run during serialization, even after global mutation.
    const json = stringify(value);
    if (typeof json !== 'string' || json.length > 8192) throw new ErrorType('JSON output limit');
    return json;
  })()`;
  const result = context.evalCode(source, 'created-capability.js');
  if (result.error) {
    result.error.dispose();
    parentPort.postMessage({ ok: false, code: 'SCRIPT_EXECUTION' });
  } else {
    const json = context.getString(result.value);
    result.value.dispose();
    if (Buffer.byteLength(json, 'utf8') > 8192) parentPort.postMessage({ ok: false, code: 'SCRIPT_OUTPUT' });
    else parentPort.postMessage({ ok: true, output: JSON.parse(json) });
  }
} catch {
  // Guest error strings may contain arbitrary input; fixed codes only cross out.
  parentPort.postMessage({ ok: false, code: 'SCRIPT_EXECUTION' });
} finally {
  context?.dispose();
  runtime?.dispose();
  parentPort.close();
}
