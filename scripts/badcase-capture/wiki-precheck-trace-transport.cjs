// Host-only trace transport adapter. Wraps EACH mailbox/provider exchange, not
// an agent turn. Model requests/responses are retained as data, never parsed as
// bash, executed, or supplied to a judge. No new auth/validation implementation.
const crypto = require('node:crypto'), zlib = require('node:zlib');
const { createCodexTransport, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } = require('./codex-transport.cjs');
const fail = code => Object.assign(Error(code), { code });
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function wireRequest(options) {
  if (typeof options?.body !== 'string' && !ArrayBuffer.isView(options?.body)) throw fail('wiki_precheck_trace_request_invalid');
  const bytes = typeof options.body === 'string' ? Buffer.from(options.body)
    : Buffer.from(new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength));
  if (!bytes.length || bytes.length > MAX_REQUEST_BYTES) throw fail('wiki_precheck_trace_request_invalid');
  const headers = new Headers(options.headers), plain = headers.get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_REQUEST_BYTES }) : bytes;
  if (plain.length > MAX_REQUEST_BYTES) throw fail('wiki_precheck_trace_request_invalid');
  const text = plain.toString('utf8'); if (!Buffer.from(text).equals(plain)) throw fail('wiki_precheck_trace_request_invalid');
  return { bytes, plain, headers, payload: JSON.parse(text) };
}
function usage(bytes, status) {
  if (status !== 200) return null;
  // This is protocol usage accounting, NOT judging model output or tool text.
  // An absent/duplicate terminal response is unknown, never inferred as zero.
  const terminal = [];
  for (const frame of bytes.toString('utf8').split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trim()).join('\n');
    let value; try { value = JSON.parse(data); } catch { continue; }
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(value?.type)) terminal.push(value.response?.usage);
  }
  if (terminal.length !== 1 || !terminal[0]) return null;
  const u = terminal[0], cached = u.input_tokens_details?.cached_tokens ?? 0;
  if (![u.input_tokens, u.output_tokens, u.total_tokens, cached].every(v => Number.isSafeInteger(v) && v >= 0) || cached > u.input_tokens
    || !Number.isSafeInteger(u.input_tokens + u.output_tokens) || u.total_tokens !== u.input_tokens + u.output_tokens) return null;
  return { input: u.input_tokens - cached, output: u.output_tokens, cacheRead: cached, cacheWrite: 0, totalTokens: u.total_tokens };
}
function createBudgetedTraceTransport(config, guards, { budget, append, knownValues, createTransport = createCodexTransport }) {
  if (!budget || typeof budget.request !== 'function' || typeof append !== 'function' || !Array.isArray(knownValues) || knownValues.some(v => typeof v !== 'string')) throw fail('wiki_precheck_budget_invalid');
  if (!budget.check()) throw fail('wiki_precheck_stopped');
  const transport = createTransport(config, guards); let access;
  function hasKnown(bytes) {
    return [...knownValues, access].some(v => typeof v === 'string' && v && (bytes.includes(v) || bytes.includes(JSON.stringify(v).slice(1, -1))));
  }
  return {
    state: () => transport.state(),
    beginAttempt: () => transport.beginAttempt(),
    inspectAccess(check) { return transport.inspectAccess(value => { access = value; check(value); }); },
    async fetch(url, options) {
      const exchange = await budget.request('worker', async signal => {
        const wire = wireRequest(options), index = budget.snapshot().requests;
        transport.inspectAccess(value => { access = value; });
        // Inspect only in memory BEFORE retaining anything. Real transport still
        // owns endpoint/profile/auth/error-order validation and its own scanner.
        if (hasKnown(wire.plain)) throw fail('wiki_precheck_trace_input_contains_key');
        append({ event: 'trace_request', index, bodyHash: hash(wire.bytes), bodyBase64: wire.bytes.toString('base64'), payload: wire.payload });
        const response = await transport.fetch(url, { ...options, headers: wire.headers, body: wire.bytes,
          signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]) });
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_RESPONSE_BYTES || hasKnown(bytes)) throw fail('wiki_precheck_trace_response_invalid');
        append({ event: 'trace_response', index, status: response.status, bodyHash: hash(bytes), bodyBase64: bytes.toString('base64') });
        return { status: response.status, bytes, usage: usage(bytes, response.status) };
      }, result => result.usage);
      return new Response(exchange.bytes, { status: exchange.status, headers: { 'content-type': exchange.status === 200 ? 'text/event-stream' : 'application/json' } });
    },
    async close() { access = undefined; await transport.close(); },
  };
}
module.exports = { createBudgetedTraceTransport };
