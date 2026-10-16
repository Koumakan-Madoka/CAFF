// Text-only Chat Completions protocol, NO network/credentials/SDK or paid approval.
// Pricing and context size are trusted operator declarations, NOT provider proof.
import crypto from 'node:crypto';
import { containsSecretSentinel } from './secrets';
import { dispatchModelEgress, ModelEgressPolicy, ModelEgressRequest } from './model-egress';

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
      || !id(v.provider) || !id(v.model) || !integer(v.contextWindowTokens, 1, 10000000)
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
function validateRequest(r: ModelEgressRequest, s: ReturnType<typeof chatCompletionsSettings>) {
  if (!digest(r.requestId) || r.provider !== s.settings.provider || r.model !== s.settings.model || r.settingsHash !== s.settingsHash
    || !(r.signal instanceof AbortSignal) || r.signal.aborted || !Buffer.isBuffer(r.body)
    || r.body.length < 1 || r.body.length > s.settings.maxRequestBytes) fail();
  const v = parse(r.body, true);
  if (!keys(v, ['model', 'messages', 'temperature', 'max_completion_tokens', 'n', 'stream', 'store'])
    || v.model !== s.settings.model || v.temperature !== s.settings.temperature || v.max_completion_tokens !== s.settings.maxOutputTokens
    || v.n !== 1 || v.stream !== false || v.store !== false) fail();
  validateMessages(v.messages);
}
function zeroDetails(v: any, allowed: string[]) {
  return keys(v, [], allowed) && Object.values(v).every(n => n === 0);
}
function validateResponse(v: any, s: ChatCompletionsSettings) {
  if (!keys(v, ['id', 'object', 'created', 'model', 'choices', 'usage'], ['system_fingerprint', 'service_tier'])
    || !id(v.id) || v.object !== 'chat.completion' || !integer(v.created, 0, Number.MAX_SAFE_INTEGER) || v.model !== s.model
    || (Object.hasOwn(v, 'system_fingerprint') && v.system_fingerprint !== null && !id(v.system_fingerprint))
    || (Object.hasOwn(v, 'service_tier') && v.service_tier !== 'default')
    || !Array.isArray(v.choices) || v.choices.length !== 1) fail();
  const c = v.choices[0];
  if (!keys(c, ['index', 'message', 'finish_reason'], ['logprobs']) || c.index !== 0 || c.finish_reason !== 'stop'
    || (Object.hasOwn(c, 'logprobs') && c.logprobs !== null)
    || !keys(c.message, ['role', 'content'], ['refusal', 'annotations']) || c.message.role !== 'assistant' || !text(c.message.content)
    || (Object.hasOwn(c.message, 'refusal') && c.message.refusal !== null)
    || (Object.hasOwn(c.message, 'annotations') && (!Array.isArray(c.message.annotations) || c.message.annotations.length !== 0))) fail();
  const u = v.usage;
  if (!keys(u, ['prompt_tokens', 'completion_tokens', 'total_tokens'], ['prompt_tokens_details', 'completion_tokens_details'])
    || !integer(u.prompt_tokens, 1, s.contextWindowTokens) || !integer(u.completion_tokens, 0, s.maxOutputTokens)
    || !integer(u.total_tokens, 1, s.contextWindowTokens) || u.total_tokens !== u.prompt_tokens + u.completion_tokens
    || (Object.hasOwn(u, 'prompt_tokens_details') && !zeroDetails(u.prompt_tokens_details, ['cached_tokens', 'audio_tokens']))
    || (Object.hasOwn(u, 'completion_tokens_details') && !zeroDetails(u.completion_tokens_details,
      ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']))) fail();
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
  const s = chatCompletionsSettings(input);
  if (typeof exchange !== 'function') fail();
  return async (request: ModelEgressRequest) => {
    let controller: AbortController | undefined, signal: AbortSignal | undefined;
    const abort = () => controller?.abort();
    try {
      validateRequest(request, s);
      const body = Buffer.from(request.body); controller = new AbortController(); signal = request.signal;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) fail();
      const result = await exchange({ body, signal: controller.signal });
      if (controller.signal.aborted || !keys(result, ['status', 'chunks']) || result.status !== 200
        || !result.chunks || typeof result.chunks[Symbol.asyncIterator] !== 'function') fail();
      const pieces: Buffer[] = []; let bytes = 0, count = 0;
      for await (const chunk of result.chunks) {
        if (controller.signal.aborted || !(chunk instanceof Uint8Array) || ++count > 8192
          || chunk.byteLength > s.settings.maxResponseBytes - bytes) { controller.abort(); fail(); }
        const copy = Buffer.from(chunk); bytes += copy.length; pieces.push(copy);
      }
      if (controller.signal.aborted || bytes === 0) fail();
      const response = Buffer.concat(pieces, bytes), parsed = parse(response);
      const costMicroUsd = validateResponse(parsed, s.settings);
      return { body: response, costMicroUsd };
    } catch { fail(); }
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
