/** Config-file allowlist for the stable Gemini GenerateContent text/tool loop. */
const isRecord = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const oneOf = (...values) => value => values.includes(value) ? value : undefined;
const scalar = predicate => value => predicate(value) ? value : undefined;
const bool = scalar(value => typeof value === 'boolean');
const string = scalar(value => typeof value === 'string');
const number = (min, max) => scalar(value => Number.isFinite(value) && value >= min && value <= max);
const integer = (min, max = 2147483647) => scalar(value => Number.isInteger(value) && value >= min && value <= max);
const strings = value => Array.isArray(value) && Array.from(value).every(item => typeof item === 'string')
  ? [...value] : undefined;

function fields(value, validators) {
  if (!isRecord(value)) return undefined;
  const out = {};
  for (const [key, validate] of Object.entries(validators)) {
    if (!Object.hasOwn(value, key)) continue;
    const child = validate(value[key]);
    if (child !== undefined) out[key] = child;
  }
  return Object.keys(out).length ? out : undefined;
}

// Schema bodies are JSON data, not GenerateContent fields. In particular,
// schema property names must not be interpreted as request overrides.
function cloneJson(value, depth = 0) {
  if (depth > 64) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const children = Array.from(value, item => cloneJson(item, depth + 1));
    return children.includes(undefined) ? undefined : children;
  }
  if (!isRecord(value)) return undefined;
  const children = Object.entries(value).map(([key, child]) => [key, cloneJson(child, depth + 1)]);
  return children.some(([, child]) => child === undefined) ? undefined : Object.fromEntries(children);
}
const schema = value => isRecord(value) ? cloneJson(value) : undefined;

const harmCategory = oneOf('HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY', 'HARM_CATEGORY_JAILBREAK');
const harmThreshold = oneOf('HARM_BLOCK_THRESHOLD_UNSPECIFIED', 'BLOCK_LOW_AND_ABOVE',
  'BLOCK_MEDIUM_AND_ABOVE', 'BLOCK_ONLY_HIGH', 'BLOCK_NONE', 'OFF');
function safetySettings(value) {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const setting = fields(item, { category: harmCategory, threshold: harmThreshold });
    if (setting?.category === undefined || setting.threshold === undefined || seen.has(setting.category)) continue;
    seen.add(setting.category);
    out.push(setting);
  }
  return out.length || !value.length ? out : undefined;
}

const toolConfig = value => fields(value, {
  functionCallingConfig: config => fields(config, {
    mode: oneOf('MODE_UNSPECIFIED', 'AUTO', 'ANY', 'NONE', 'VALIDATED'),
    allowedFunctionNames: strings,
  }),
  retrievalConfig: config => fields(config, {
    languageCode: string,
    latLng: location => fields(location, { latitude: number(-90, 90), longitude: number(-180, 180) }),
  }),
  includeServerSideToolInvocations: bool,
});

function thinkingConfig(value) {
  const out = fields(value, {
    includeThoughts: bool,
    thinkingBudget: integer(-1),
    thinkingLevel: level => typeof level === 'string' ? oneOf('THINKING_LEVEL_UNSPECIFIED',
      'MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH')(level.toUpperCase()) : undefined,
  });
  if (out?.thinkingLevel !== undefined && out.thinkingBudget !== undefined) return undefined;
  return out;
}

const generationConfig = value => fields(value, {
  temperature: number(0, 2),
  topP: number(0, 1),
  topK: integer(1),
  seed: integer(-2147483648),
  stopSequences: strings,
  responseMimeType: oneOf('text/plain', 'application/json', 'text/x.enum'),
  responseSchema: schema,
  responseJsonSchema: schema,
  responseModalities: value => Array.isArray(value) && value.length === 1 && value[0] === 'TEXT' ? ['TEXT'] : undefined,
  responseFormat: format => fields(format, {
    text: text => fields(text, { mimeType: oneOf('APPLICATION_JSON', 'TEXT_PLAIN'), schema }),
  }),
  presencePenalty: number(-Infinity, Infinity),
  frequencyPenalty: number(-Infinity, Infinity),
  responseLogprobs: bool,
  logprobs: integer(0, 20),
  mediaResolution: oneOf('MEDIA_RESOLUTION_UNSPECIFIED', 'MEDIA_RESOLUTION_LOW', 'MEDIA_RESOLUTION_MEDIUM', 'MEDIA_RESOLUTION_HIGH'),
  enableEnhancedCivicAnswers: bool,
  thinkingConfig,
  // Output budget and candidate count belong to the runtime, not this bag.
});

/** Clone supported options and omit malformed or unknown fields. Model-specific
 * support, cross-field API constraints and selected effort are adapter/API concerns.
 * @param {unknown} value
 * @returns {object | undefined}
 */
export function cloneGeminiOptions(value) {
  return fields(value, {
    safetySettings,
    serviceTier: oneOf('unspecified', 'standard', 'flex', 'priority'),
    toolConfig,
    generationConfig,
  });
}
