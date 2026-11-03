// Trusted direct-provider helpers. No gateway, automatic auth discovery or persistence.
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
const DEFAULT_PROFILE = PROVIDER + '/' + MODEL;
const DEEPSEEK_PROFILE = 'deepseek/deepseek-v4-flash';
const CODEX_PROFILE = 'openai-codex/gpt-6.1-sol';
// Expired, deliberately invalid signature. Native pi-ai only decodes account
// routing here; the host substitutes the actual access exclusively in memory.
const CODEX_INERT_KEY = 'inert.' + Buffer.from(JSON.stringify({ exp: 1,
  'https://api.openai.com/auth': { chatgpt_account_id: 'caff-replay-inert' } })).toString('base64url') + '.not-a-credential';
function modelProfile(name = DEFAULT_PROFILE) {
  if (name === DEFAULT_PROFILE) return { provider: PROVIDER, model: MODEL, endpoint: ENDPOINT };
  if (name === DEEPSEEK_PROFILE) return { provider: 'deepseek', model: 'deepseek-v4-flash', endpoint: 'https://api.deepseek.com' };
  if (name === CODEX_PROFILE) return { provider: 'openai-codex', model: 'gpt-6.1-sol', endpoint: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses', thinking: 'xhigh' };
  throw fail('evaluation_profile_invalid');
}
// Host only, explicitly selected by the user. No auth.json scan, shell
// evaluation, source modification, or fallback to any unrelated credential.
function readCaffDeepseekKey(env = process.env) {
  try {
    const path = require('node:path'), dir = env.PI_CODING_AGENT_DIR;
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw Error();
    const file = path.join(dir, 'models.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw Error();
    const p = JSON.parse(fs.readFileSync(file, 'utf8')).providers?.deepseek;
    if (p?.baseUrl !== modelProfile(DEEPSEEK_PROFILE).endpoint || p.api !== 'openai-completions'
      || !p.models?.some(m => m.id === 'deepseek-v4-flash') || typeof p.apiKey !== 'string' || p.apiKey.startsWith('!')) throw Error();
    return validKey(p.apiKey.startsWith('$') ? env[p.apiKey.slice(1)] : p.apiKey);
  } catch { throw fail('evaluation_caff_auth_unavailable_or_invalid'); }
}
// Only a variable reference is written to models.json, never the actual key.
function directModelRouting(baseUrl, profile = DEFAULT_PROFILE) {
  const selected = modelProfile(profile); baseUrl ??= selected.endpoint;
  if (profile === CODEX_PROFILE) {
    if (baseUrl !== selected.endpoint) throw fail('evaluation_endpoint_invalid');
    // Keep the built-in native descriptor/capabilities/costs/context limits.
    // This env reference resolves only to CODEX_INERT_KEY in the worker.
    return { providers: { 'openai-codex': { baseUrl, apiKey: '$' + KEY_ENV } } };
  }
  if (baseUrl !== selected.endpoint && !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/v1$/.test(baseUrl)) throw fail('evaluation_endpoint_invalid');
  return { providers: { [selected.provider]: {
    api: 'openai-completions', baseUrl, apiKey: '$' + KEY_ENV,
    compat: { supportsStore: true, supportsDeveloperRole: false, supportsReasoningEffort: false,
      supportsUsageInStreaming: true, supportsStrictMode: false, supportsOpenAIGrammarTools: false,
      maxTokensField: profile === DEEPSEEK_PROFILE ? 'max_tokens' : 'max_completion_tokens', thinkingFormat: 'deepseek' },
    models: [{ id: selected.model, name: selected.model, reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 4096,
      thinkingLevelMap: { off: 'none', minimal: null, low: null, medium: null, high: null, xhigh: null, max: null },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      samplingParams: { temperature: 0, n: 1, store: false, parallel_tool_calls: false, tool_choice: 'auto' } }],
  } } };
}
// Observe native SDK HTTP attempts, without changing request/response bytes or
// converting SSE. A failed attempt latches closed: SDK retries cannot send again.
// Callback traffic is passed through only to the separately supplied local URL.
function observeDirectFetch(fetch, { baseUrl, profile = DEFAULT_PROFILE, callbackUrl, maxRequests = 32 } = {}) {
  const selected = modelProfile(profile); baseUrl ??= selected.endpoint;
  directModelRouting(baseUrl, profile);
  const calls = []; let failed = false, pending = null;
  const observed = async (request, options) => {
    const url = typeof request === 'string' || request instanceof URL ? String(request) : request.url;
    if (callbackUrl && new URL(url).origin === callbackUrl) return fetch(request, options);
    const endpoint = baseUrl + (profile === CODEX_PROFILE ? '/codex/responses' : '/chat/completions');
    if (url !== endpoint || failed || calls.length >= maxRequests) throw fail('evaluation_request_blocked');
    const start = performance.now();
    const row = { model: selected.provider + '/' + selected.model, durationMs: 0, success: false, httpStatus: null, usage: null };
    calls.push(row); pending = row;
    try {
      const response = await fetch(request, options);
      row.httpStatus = response.status;
      if (!response.ok) { failed = true; pending = null; }
      // Completion/usage are recorded from the SDK event after SSE consumption.
      row.durationMs = performance.now() - start;
      Object.defineProperty(row, 'started', { value: start });
      return response;
    } catch { failed = true; pending = null; row.durationMs = performance.now() - start; throw fail('evaluation_request_failed'); }
  };
  function complete(message) {
    // The sequential SDK may emit an error after a refused retry/budget slot
    // without another HTTP call. Complete each real request at most once;
    // never attribute that synthetic error or its zero usage to an old call.
    const row = pending; pending = null; if (!row) return;
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
module.exports = { readEvaluationKey, readCaffDeepseekKey, validKey, modelProfile, directModelRouting, observeDirectFetch, validateDirectBindings, bindDirectPrompt, ENDPOINT, PROVIDER, MODEL, KEY_ENV, DEFAULT_PROFILE, DEEPSEEK_PROFILE, CODEX_PROFILE, CODEX_INERT_KEY };
