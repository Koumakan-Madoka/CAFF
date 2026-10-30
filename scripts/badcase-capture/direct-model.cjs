// Trusted direct-provider helpers. No gateway, credential discovery or persistence.
const fs = require('node:fs');
const ENDPOINT = 'https://opencode.ai/zen/go/v1';
const PROVIDER = 'opencode-go', MODEL = 'deepseek-v4.1-flash';
const KEY_ENV = 'CAFF_BADCASE_MODEL_KEY';
const fail = code => Object.assign(Error(code), { code });
function validKey(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(value)) throw fail('evaluation_key_invalid');
  return value;
}
// Explicit file selection wins; a bad/missing file never falls back to ambient auth.
// Errors contain neither the selected path nor file contents.
function readEvaluationKey(env = process.env) {
  if (env.CAFF_BADCASE_MODEL_KEY_FILE !== undefined) {
    let fd;
    try {
      const file = env.CAFF_BADCASE_MODEL_KEY_FILE;
      if (typeof file !== 'string' || !require('node:path').isAbsolute(file) || fs.lstatSync(file).isSymbolicLink()) throw Error();
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 4098) throw Error();
      const b = Buffer.alloc(4099), n = fs.readSync(fd, b, 0, b.length, 0);
      if (n !== st.size || n > 4098) throw Error();
      return validKey(b.subarray(0, n).toString('utf8').replace(/\r?\n$/, ''));
    } catch { throw fail('evaluation_key_file_unavailable_or_invalid'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  if (env[KEY_ENV] === undefined) throw fail('evaluation_key_missing');
  return validKey(env[KEY_ENV]);
}
// Only a variable reference is written to models.json, never the actual key.
function directModelRouting(baseUrl = ENDPOINT) {
  if (baseUrl !== ENDPOINT && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/.test(baseUrl)) throw fail('evaluation_endpoint_invalid');
  return { providers: { [PROVIDER]: {
    api: 'openai-completions', baseUrl, apiKey: '$' + KEY_ENV,
    compat: { supportsStore: true, supportsDeveloperRole: false, supportsReasoningEffort: false,
      supportsUsageInStreaming: true, supportsStrictMode: false, supportsOpenAIGrammarTools: false,
      maxTokensField: 'max_completion_tokens', thinkingFormat: 'deepseek' },
    models: [{ id: MODEL, name: MODEL, reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 4096,
      thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      samplingParams: { temperature: 0, n: 1, store: false, parallel_tool_calls: false, tool_choice: 'auto' } }],
  } } };
}
// Observe native SDK HTTP attempts, without changing request/response bytes or
// converting SSE. A failed attempt latches closed: SDK retries cannot send again.
// Callback traffic is passed through only to the separately supplied local URL.
function observeDirectFetch(fetch, { baseUrl = ENDPOINT, callbackUrl, maxRequests = 32 } = {}) {
  const calls = []; let failed = false;
  const observed = async (request, options) => {
    const url = typeof request === 'string' || request instanceof URL ? String(request) : request.url;
    if (callbackUrl && new URL(url).origin === callbackUrl) return fetch(request, options);
    if (url !== baseUrl + '/chat/completions' || failed || calls.length >= maxRequests) throw fail('evaluation_request_blocked');
    const start = performance.now();
    const row = { model: PROVIDER + '/' + MODEL, durationMs: 0, success: false, httpStatus: null, usage: null };
    calls.push(row);
    try {
      const response = await fetch(request, options);
      row.httpStatus = response.status;
      if (!response.ok) failed = true;
      // Completion/usage are recorded from the SDK event after SSE consumption.
      row.durationMs = performance.now() - start;
      Object.defineProperty(row, 'started', { value: start });
      return response;
    } catch { failed = true; row.durationMs = performance.now() - start; throw fail('evaluation_request_failed'); }
  };
  function complete(message) {
    const row = calls.at(-1); if (!row) return;
    row.durationMs = performance.now() - (row.started ?? performance.now());
    row.success = row.httpStatus === 200 && ['stop', 'toolUse'].includes(message?.stopReason);
    if (!row.success) failed = true;
    const usage = message?.usage;
    if (usage && ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(k => Number.isFinite(usage[k]) && usage[k] >= 0)) {
      row.usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map(k => [k, usage[k]]));
    }
  }
  return { fetch: observed, calls, complete };
}
const BINDING_NAMES = ['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_CONVERSATION_ID',
  'CAFF_CHAT_TURN_ID', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH', 'PI_AGENT_SANDBOX_DIR', 'PI_AGENT_PRIVATE_DIR'];
function validateDirectBindings(prompt, bindings) {
  if (typeof prompt !== 'string' || !bindings || typeof bindings.sourceRoot !== 'string' || !/^(?:[A-Za-z]:[\\\\/]|\/)/.test(bindings.sourceRoot)
    || !Array.isArray(bindings.controlledReplacements)) throw fail('evaluation_bindings_unsupported');
  const counts = new Map();
  for (const r of bindings.controlledReplacements) {
    if (!BINDING_NAMES.includes(r?.name) || !Number.isSafeInteger(r.count) || r.count < 1) throw fail('evaluation_bindings_unsupported');
    counts.set(r.name, (counts.get(r.name) || 0) + r.count);
  }
  for (const name of BINDING_NAMES) if (prompt.split('{{' + name + '}}').length - 1 !== (counts.get(name) || 0)) throw fail('evaluation_bindings_unsupported');
  if (prompt.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => BINDING_NAMES.includes(name) ? '' : '{{').includes('{{')) throw fail('evaluation_bindings_unsupported');
}
function bindDirectPrompt(prompt, bindings, values) {
  validateDirectBindings(prompt, bindings);
  if (!values || !BINDING_NAMES.every(n => typeof values[n] === 'string' && values[n] && !values[n].includes('{{'))) throw fail('evaluation_bindings_unsupported');
  return prompt.replaceAll(bindings.sourceRoot, '/work/restored').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => values[name]);
}
module.exports = { readEvaluationKey, validKey, directModelRouting, observeDirectFetch, validateDirectBindings, bindDirectPrompt, ENDPOINT, PROVIDER, MODEL, KEY_ENV };
