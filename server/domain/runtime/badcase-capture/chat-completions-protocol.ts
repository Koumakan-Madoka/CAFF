// Explicit text-v1 and tools-v1 protocols, NO network/credentials/SDK or paid approval.
// Pricing and context size are trusted operator declarations, NOT provider proof.
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
import { modelIdentifier } from './model-identifier';
import { dispatchModelEgress, ModelEgressPolicy, ModelEgressRequest, labelModelFailure, modelFailureStage, ModelFailureStage } from './model-egress';

function fail(): never { throw Object.assign(Error('chat_completions_invalid'), { code: 'chat_completions_invalid' }); }
const integer = (v: any, min: number, max: number) => Number.isSafeInteger(v) && v >= min && v <= max;
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v: any, required: string[], optional: string[] = []) => object(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: any) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const digest = (v: any) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const text = (v: any) => typeof v === 'string' && Buffer.from(v).toString('utf8') === v && !v.includes('\0');
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

export interface ChatCompletionsSettings {
  provider: string; model: string; contextWindowTokens: number; maxOutputTokens: number; temperature: number;
  inputMicroUsdPerMillionTokens: number; outputMicroUsdPerMillionTokens: number;
  maxRequestBytes: number; maxResponseBytes: number;
}
// Round each component UP in integer arithmetic, never underreserve by rounding.
function tariff(s: ChatCompletionsSettings, input: number, output: number) {
  const ceil = (n: bigint) => (n + 999999n) / 1000000n;
  return Number(ceil(BigInt(input) * BigInt(s.inputMicroUsdPerMillionTokens))
    + ceil(BigInt(output) * BigInt(s.outputMicroUsdPerMillionTokens)));
}
export function chatCompletionsSettings(value: unknown) {
  try {
    const v = value as ChatCompletionsSettings;
    if (!keys(v, ['provider', 'model', 'contextWindowTokens', 'maxOutputTokens', 'temperature',
      'inputMicroUsdPerMillionTokens', 'outputMicroUsdPerMillionTokens', 'maxRequestBytes', 'maxResponseBytes'])
      || !id(v.provider) || !modelIdentifier(v.model) || !integer(v.contextWindowTokens, 1, 10000000)
      || !integer(v.maxOutputTokens, 1, v.contextWindowTokens)
      || !Number.isFinite(v.temperature) || v.temperature < 0 || v.temperature > 2
      || !integer(v.inputMicroUsdPerMillionTokens, 0, 1e12) || !integer(v.outputMicroUsdPerMillionTokens, 0, 1e12)
      || !integer(v.maxRequestBytes, 1, 4 * 1024 * 1024) || !integer(v.maxResponseBytes, 1, 4 * 1024 * 1024)
      || containsSecretSentinel(JSON.stringify(v))) fail();
    const settings = { protocol: 'chat-completions-text-v1' as const,
      provider: v.provider, model: v.model, contextWindowTokens: v.contextWindowTokens, maxOutputTokens: v.maxOutputTokens,
      temperature: v.temperature, inputMicroUsdPerMillionTokens: v.inputMicroUsdPerMillionTokens,
      outputMicroUsdPerMillionTokens: v.outputMicroUsdPerMillionTokens, maxRequestBytes: v.maxRequestBytes, maxResponseBytes: v.maxResponseBytes };
    // Reserve the ENTIRE declared input context, plus the output cap. No byte-to-
    // token guess or undocumented tokenizer. Overlong input can still be refused
    // by the provider; context metadata/tariffs must be reviewed before real use.
    const perRequestReserveMicroUsd = Math.max(1, tariff(settings, settings.contextWindowTokens, settings.maxOutputTokens));
    if (!integer(perRequestReserveMicroUsd, 1, 1e12)) fail();
    return { settings, settingsHash: hash(JSON.stringify(settings)), perRequestReserveMicroUsd };
  } catch { fail(); }
}
// Tool schemas are bounded, opaque declarations, not a local schema evaluator.
// No reference resolution or tool execution occurs in this protocol module.
function stableJson(v: any, depth = 0, budget = { nodes: 0 }): any {
  if (++budget.nodes > 2048 || depth > 16) fail();
  if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
  if (typeof v === 'string') { if (!text(v)) fail(); return v; }
  if (Array.isArray(v)) return v.map(x => stableJson(x, depth + 1, budget));
  if (!object(v) || Object.getPrototypeOf(v) !== Object.prototype) fail();
  const result: any = {};
  for (const k of Object.keys(v).sort()) {
    if (!text(k) || ['$ref', '$dynamicRef', '__proto__', 'constructor', 'prototype'].includes(k)) fail();
    result[k] = stableJson(v[k], depth + 1, budget);
  }
  return result;
}
export function toolChatCompletionsSettings(input: unknown) {
  try {
    const v = input as any;
    if (!keys(v, ['settings', 'tools']) || !Array.isArray(v.tools) || v.tools.length < 1 || v.tools.length > 16) fail();
    const s = chatCompletionsSettings(v.settings), seen = new Set<string>();
    const tools = stableJson(v.tools);
    if (Buffer.byteLength(JSON.stringify(tools)) > 8192 || containsSecretSentinel(JSON.stringify(tools))) fail();
    for (const t of tools) {
      const f = t?.function;
      if (!keys(t, ['type', 'function']) || t.type !== 'function' || !keys(f, ['name', 'description', 'parameters'])
        || typeof f.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(f.name) || seen.has(f.name)
        || !text(f.description) || !object(f.parameters) || f.parameters.type !== 'object') fail();
      seen.add(f.name);
    }
    const settings = { ...s.settings, protocol: 'chat-completions-tools-v1' as const };
    return { settings, tools, settingsHash: hash(JSON.stringify({ settings, tools })), perRequestReserveMicroUsd: s.perRequestReserveMicroUsd };
  } catch { fail(); }
}
function toolCall(value: any, tools: any[], seen: Set<string>): string {
  const f = value?.function;
  if (!keys(value, ['id', 'type', 'function']) || !id(value.id) || seen.has(value.id) || value.type !== 'function'
    || !keys(f, ['name', 'arguments']) || !tools.some(t => t.function.name === f.name) || !text(f.arguments)
    || Buffer.byteLength(f.arguments) > 65536) fail();
  // Preserve provider argument bytes. Syntax/object/depth only: the container's
  // pinned tool validator must still validate arguments against the approved schema.
  const args = JSON.parse(f.arguments); if (!object(args)) fail(); stableJson(args);
  if (containsSecretSentinel(f.arguments) || containsSecretSentinel(JSON.stringify(args))) fail();
  seen.add(value.id); return value.id;
}
function validateToolMessages(value: any, tools: any[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256) fail();
  const seen = new Set<string>(); let pending: string | undefined;
  for (const m of value) {
    if (pending !== undefined) {
      if (!keys(m, ['role', 'content', 'tool_call_id']) || m.role !== 'tool' || m.tool_call_id !== pending || !text(m.content)) fail();
      pending = undefined;
    } else if (m?.role === 'assistant' && Object.hasOwn(m, 'tool_calls')) {
      if (!keys(m, ['role', 'content', 'tool_calls']) || (m.content !== null && !text(m.content))
        || !Array.isArray(m.tool_calls) || m.tool_calls.length !== 1) fail();
      pending = toolCall(m.tool_calls[0], tools, seen);
    } else validateMessages([m]);
  }
  if (pending !== undefined) fail(); // never send a request with a dangling call
  return seen;
}
export function encodeToolChatCompletionsRequest(input: unknown, messages: unknown): Buffer {
  try {
    const s = toolChatCompletionsSettings(input); validateToolMessages(messages, s.tools);
    const body = Buffer.from(JSON.stringify({ model: s.settings.model, messages, temperature: s.settings.temperature,
      max_completion_tokens: s.settings.maxOutputTokens, n: 1, stream: false, store: false,
      tools: s.tools, tool_choice: 'auto', parallel_tool_calls: false }));
    if (body.length > s.settings.maxRequestBytes || containsSecretSentinel(body)) fail();
    return body;
  } catch { fail(); }
}
function validateMessages(value: any) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256 || value.some(m =>
    !keys(m, ['role', 'content']) || !['system', 'user', 'assistant'].includes(m.role) || !text(m.content))) fail();
}
export function encodeChatCompletionsRequest(input: unknown, messages: unknown): Buffer {
  try {
    const { settings: s } = chatCompletionsSettings(input); validateMessages(messages);
    const body = Buffer.from(JSON.stringify({ model: s.model, messages, temperature: s.temperature,
      max_completion_tokens: s.maxOutputTokens, n: 1, stream: false, store: false }));
    if (body.length > s.maxRequestBytes || containsSecretSentinel(body)) fail();
    return body;
  } catch { fail(); }
}
function parse(bytes: Buffer, canonical = false): any {
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded).equals(bytes)) fail();
  const v = JSON.parse(decoded);
  // Request bytes must be produced by JSON.stringify, with no duplicate keys,
  // whitespace or alternate escapes. Responses may use provider formatting.
  if ((canonical && JSON.stringify(v) !== decoded) || containsSecretSentinel(JSON.stringify(v))) fail();
  return v;
}
function validateRequest(r: ModelEgressRequest, s: { settings: ChatCompletionsSettings; settingsHash: string }, tools?: any[]) {
  if (!digest(r.requestId) || r.provider !== s.settings.provider || r.model !== s.settings.model || r.settingsHash !== s.settingsHash
    || !(r.signal instanceof AbortSignal) || r.signal.aborted || !Buffer.isBuffer(r.body)
    || r.body.length < 1 || r.body.length > s.settings.maxRequestBytes) fail();
  const v = parse(r.body, true);
  if (!keys(v, ['model', 'messages', 'temperature', 'max_completion_tokens', 'n', 'stream', 'store',
    ...(tools ? ['tools', 'tool_choice', 'parallel_tool_calls'] : [])])
    || v.model !== s.settings.model || v.temperature !== s.settings.temperature || v.max_completion_tokens !== s.settings.maxOutputTokens
    || v.n !== 1 || v.stream !== false || v.store !== false) fail();
  if (tools) {
    if (v.tool_choice !== 'auto' || v.parallel_tool_calls !== false || JSON.stringify(v.tools) !== JSON.stringify(tools)) fail();
    return validateToolMessages(v.messages, tools);
  }
  validateMessages(v.messages); return new Set<string>();
}
function zeroDetails(v: any, allowed: string[]) {
  return keys(v, [], allowed) && Object.values(v).every(n => n === 0);
}
function responseFailure(stage: ModelFailureStage): never {
  throw labelModelFailure(Object.assign(Error('chat_completions_invalid'), { code: 'chat_completions_invalid' }), stage);
}
function validateResponse(v: any, s: ChatCompletionsSettings, tools?: any[], seen = new Set<string>()) {
  // Same ordered predicates and acceptance set as the original compound guard.
  // Only emit the FIRST failed check's fixed label, never raw keys or values.
  if (!keys(v, ['id', 'object', 'created', 'model', 'choices', 'usage'], ['system_fingerprint', 'service_tier']))
    responseFailure('protocol_response_envelope_keys');
  if (!id(v.id)) responseFailure('protocol_response_envelope_id');
  if (v.object !== 'chat.completion') responseFailure('protocol_response_envelope_object');
  if (!integer(v.created, 0, Number.MAX_SAFE_INTEGER)) responseFailure('protocol_response_envelope_created');
  if (v.model !== s.model) responseFailure('protocol_response_envelope_model');
  if (Object.hasOwn(v, 'system_fingerprint') && v.system_fingerprint !== null && !id(v.system_fingerprint))
    responseFailure('protocol_response_envelope_fingerprint');
  if (Object.hasOwn(v, 'service_tier') && v.service_tier !== 'default') responseFailure('protocol_response_envelope_service_tier');
  if (!Array.isArray(v.choices) || v.choices.length !== 1) responseFailure('protocol_response_envelope_choices');
  const c = v.choices[0];
  const calling = !!tools && c?.finish_reason === 'tool_calls';
  if (!keys(c, ['index', 'message', 'finish_reason'], ['logprobs']) || c.index !== 0 || (!calling && c.finish_reason !== 'stop')
    || (Object.hasOwn(c, 'logprobs') && c.logprobs !== null)
    || !keys(c.message, ['role', 'content', ...(calling ? ['tool_calls'] : [])], ['refusal', 'annotations']) || c.message.role !== 'assistant'
    || (!(calling && c.message.content === null) && !text(c.message.content))
    || (Object.hasOwn(c.message, 'refusal') && c.message.refusal !== null)
    || (Object.hasOwn(c.message, 'annotations') && (!Array.isArray(c.message.annotations) || c.message.annotations.length !== 0))) responseFailure('protocol_response_choice');
  if (calling) {
    if (!Array.isArray(c.message.tool_calls) || c.message.tool_calls.length !== 1) fail();
    toolCall(c.message.tool_calls[0], tools!, seen);
  }
  const u = v.usage;
  if (!keys(u, ['prompt_tokens', 'completion_tokens', 'total_tokens'], ['prompt_tokens_details', 'completion_tokens_details'])
    || !integer(u.prompt_tokens, 1, s.contextWindowTokens) || !integer(u.completion_tokens, 0, s.maxOutputTokens)
    || !integer(u.total_tokens, 1, s.contextWindowTokens) || u.total_tokens !== u.prompt_tokens + u.completion_tokens
    || (Object.hasOwn(u, 'prompt_tokens_details') && !zeroDetails(u.prompt_tokens_details, ['cached_tokens', 'audio_tokens']))
    || (Object.hasOwn(u, 'completion_tokens_details') && !zeroDetails(u.completion_tokens_details,
      ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']))) responseFailure('protocol_response_usage');
  return tariff(s, u.prompt_tokens, u.completion_tokens);
}
export interface ChatCompletionsExchangeRequest { body: Buffer; signal: AbortSignal }
export type ChatCompletionsExchange = (request: ChatCompletionsExchangeRequest) => Promise<{
  status: number; chunks: AsyncIterable<Uint8Array>;
}>;
/** Trusted injected exchange, not fetch. Must enforce destination/credentials,
 * no redirects/retries and cleanup on abort. Never called before protocol check.
 * The collector bounds retained bytes/chunks, not allocations inside exchange.
 * Awaiting a stuck next()/return() remains unbounded, like the parent coordinator.
 */
export function createChatCompletionsTransport(input: unknown, exchange: ChatCompletionsExchange) {
  return createTransport(chatCompletionsSettings(input), exchange);
}
export function createToolChatCompletionsTransport(input: unknown, exchange: ChatCompletionsExchange) {
  const s = toolChatCompletionsSettings(input);
  return createTransport(s, exchange, s.tools);
}
function createTransport(s: { settings: ChatCompletionsSettings; settingsHash: string }, exchange: ChatCompletionsExchange, tools?: any[]) {
  if (typeof exchange !== 'function') fail();
  return async (request: ModelEgressRequest) => {
    let controller: AbortController | undefined, signal: AbortSignal | undefined;
    const abort = () => controller?.abort();
    let stage: ModelFailureStage = 'protocol_request';
    try {
      const seen = validateRequest(request, s, tools);
      const body = Buffer.from(request.body); controller = new AbortController(); signal = request.signal;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) fail();
      stage = 'protocol_exchange';
      const result = await exchange({ body, signal: controller.signal });
      stage = 'protocol_collect';
      if (controller.signal.aborted || !keys(result, ['status', 'chunks']) || result.status !== 200
        || !result.chunks || typeof result.chunks[Symbol.asyncIterator] !== 'function') fail();
      const pieces: Buffer[] = []; let bytes = 0, count = 0;
      for await (const chunk of result.chunks) {
        if (controller.signal.aborted || !(chunk instanceof Uint8Array) || ++count > 8192
          || chunk.byteLength > s.settings.maxResponseBytes - bytes) { controller.abort(); fail(); }
        const copy = Buffer.from(chunk); bytes += copy.length; pieces.push(copy);
      }
      if (controller.signal.aborted || bytes === 0) fail();
      stage = 'protocol_decode';
      const response = Buffer.concat(pieces, bytes), parsed = parse(response);
      stage = 'protocol_response';
      const costMicroUsd = validateResponse(parsed, s.settings, tools, seen);
      return { body: response, costMicroUsd };
    } catch (e) {
      // Preserve only a trusted boundary's closed label, never its exception.
      const upstream = modelFailureStage(e);
      throw labelModelFailure(Object.assign(Error('chat_completions_invalid'), { code: 'chat_completions_invalid' }), upstream ?? stage);
    }
    finally {
      signal?.removeEventListener('abort', abort);
      controller?.abort(); // close scope; exchange must release its resources
    }
  };
}
/** Bind protocol settings, byte caps and conservative reservation BEFORE claim.
 * Policy is still a trusted declaration, NOT a lookup of paid human approval.
 */
export async function dispatchChatCompletions(root: string, policy: ModelEgressPolicy, input: unknown,
  drive: (send: (body: Buffer) => Promise<Buffer>) => Promise<unknown>, exchange: ChatCompletionsExchange) {
  const s = chatCompletionsSettings(input);
  if (!policy || policy.provider !== s.settings.provider || policy.model !== s.settings.model
    || policy.settingsHash !== s.settingsHash || policy.maxRequestBytes !== s.settings.maxRequestBytes
    || policy.maxResponseBytes !== s.settings.maxResponseBytes || policy.perRequestReserveMicroUsd !== s.perRequestReserveMicroUsd) fail();
  const transport = createChatCompletionsTransport(input, exchange);
  return dispatchModelEgress(root, policy, drive, transport);
}
/** Explicit opt-in only: never reinterpret a text-v1 policy or old approval. */
export async function dispatchToolChatCompletions(root: string, policy: ModelEgressPolicy, input: unknown,
  drive: (send: (body: Buffer) => Promise<Buffer>) => Promise<unknown>, exchange: ChatCompletionsExchange) {
  const s = toolChatCompletionsSettings(input);
  if (!policy || policy.provider !== s.settings.provider || policy.model !== s.settings.model
    || policy.settingsHash !== s.settingsHash || policy.maxRequestBytes !== s.settings.maxRequestBytes
    || policy.maxResponseBytes !== s.settings.maxResponseBytes || policy.perRequestReserveMicroUsd !== s.perRequestReserveMicroUsd) fail();
  return dispatchModelEgress(root, policy, drive, createToolChatCompletionsTransport(input, exchange));
}
