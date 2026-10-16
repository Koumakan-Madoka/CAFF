// Internal, credential-bearing HTTPS client. NOT an approved execution entry.
// No production/SDK/container wiring. Call ONLY behind reviewed approval/ledger.
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { ChatCompletionsExchange, ChatCompletionsExchangeRequest } from './chat-completions-protocol';
import { containsSecretSentinel } from './secrets';

const exact = (v: any, names: string[]) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join('|') === [...names].sort().join('|');
const integer = (v: any, max: number) => Number.isSafeInteger(v) && v >= 1 && v <= max;
function error(kind: 'invalid' | 'failed') {
  return Object.assign(Error('model_https_' + kind), { code: 'model_https_' + kind });
}
function publicAddress(v: any) {
  if (typeof v !== 'string' || net.isIP(v) !== 4) return false;
  const [a, b, c] = v.split('.').map(Number);
  // Conservative IPv4-only policy. No DNS, IPv6/mapped addresses, private,
  // link-local/metadata, shared, benchmark, documentation, multicast/reserved.
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export interface HttpsExchangeEndpoint {
  hostname: string; address: string; path: string;
  maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number;
}
export function httpsExchangeEndpoint(value: unknown) {
  try {
    const v = value as HttpsExchangeEndpoint;
    if (!exact(v, ['hostname', 'address', 'path', 'maxRequestBytes', 'maxResponseBytes', 'timeoutMs'])
      || typeof v.hostname !== 'string' || v.hostname.length > 253 || net.isIP(v.hostname)
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v.hostname)
      || /\.(?:localhost|local|internal)$/.test(v.hostname) || !publicAddress(v.address)
      || typeof v.path !== 'string' || v.path.length > 512 || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(v.path)
      || !integer(v.maxRequestBytes, 4194304) || !integer(v.maxResponseBytes, 4194304) || !integer(v.timeoutMs, 300000)
      || containsSecretSentinel(JSON.stringify(v))) throw error('invalid');
    const endpoint = { protocol: 'pinned-https-v1' as const, hostname: v.hostname, address: v.address, path: v.path,
      maxRequestBytes: v.maxRequestBytes, maxResponseBytes: v.maxResponseBytes, timeoutMs: v.timeoutMs };
    return { endpoint, endpointHash: crypto.createHash('sha256').update(JSON.stringify(endpoint)).digest('hex') };
  } catch { throw error('invalid'); }
}
export interface HttpsCredentialLease { value: string; expiresAt: number }
/** Synchronous, trusted lease source. Called once per exchange with the exact
 * endpoint hash, after request validation. This is NOT a credential issuer or
 * authorization check. Never read production credentials or process.env here.
 */
export function createHttpsExchange(input: unknown, credential: (endpointHash: string) => HttpsCredentialLease): ChatCompletionsExchange {
  const { endpoint: s, endpointHash } = httpsExchangeEndpoint(input);
  if (typeof credential !== 'function') throw error('invalid');
  let busy = false;
  return async (request: ChatCompletionsExchangeRequest) => {
    let body: Buffer, signal: AbortSignal;
    try {
      if (busy || !exact(request, ['body', 'signal']) || !Buffer.isBuffer(request.body)
        || !integer(request.body.length, s.maxRequestBytes) || !(request.signal instanceof AbortSignal) || request.signal.aborted) throw error('invalid');
      body = Buffer.from(request.body); signal = request.signal;
    } catch { throw error('invalid'); }
    busy = true;
    const started = performance.now();
    try {
      const lease = credential(endpointHash);
      // Async issuance is deliberately not supported; drain native rejected
      // promises so a misconfigured trusted callback cannot crash the process.
      if (lease instanceof Promise) { void lease.catch(() => {}); throw error('failed'); }
      if (!exact(lease, ['value', 'expiresAt'])) throw error('failed');
      const value = lease.value, expiresAt = lease.expiresAt;
      if (typeof value !== 'string' || !/^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/.test(value)
        || value.length > 4096 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw error('failed');
      // Pin remaining lease lifetime to the monotonic clock too: wall-clock
      // rollback plus a delayed timer must not accept an expired credential run.
      const deadline = Math.min(started + s.timeoutMs, performance.now() + (expiresAt - Date.now()));
      const expired = () => signal.aborted || performance.now() >= deadline || Date.now() >= expiresAt;
      if (expired()) throw error('failed');
      const response = await new Promise<Buffer>((resolve, reject) => {
        let req: ClientRequest | undefined, res: IncomingMessage | undefined, done = false, timer: NodeJS.Timeout | undefined;
        const finish = (bytes?: Buffer) => {
          if (done) return;
          done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          // Own request/socket only. Destroy on BOTH success and failure; no
          // pooled socket, redirect, retry, decompression, or credential reuse.
          res?.destroy(); req?.destroy();
          if (bytes !== undefined && !expired()) resolve(bytes); else reject(error('failed'));
        };
        const abort = () => finish();
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, Math.max(1, deadline - performance.now()));
        try {
          if (expired()) { finish(); return; }
          req = https.request({ hostname: s.address, port: 443, path: s.path, method: 'POST', agent: false,
            servername: s.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: [...tls.rootCertificates],
            checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(s.hostname, cert), maxHeaderSize: 16384,
            headers: { Host: s.hostname, Authorization: 'Bearer ' + value, 'Content-Type': 'application/json',
              Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Length': body.length, Connection: 'close' } });
          req.on('error', abort);
          req.on('socket', socket => {
            socket.once('secureConnect', () => {
              const peer = socket as tls.TLSSocket;
              if (done) return;
              if (expired() || !peer.encrypted || !peer.authorized || peer.remoteAddress !== s.address) { finish(); return; }
              req!.end(body); // never queue credential-bearing HTTP bytes before TLS checks
            });
          });
          req.on('response', incoming => {
            res = incoming;
            res.on('error', abort); res.on('aborted', abort);
            if (done) { res.destroy(); return; }
            const h = res.headers, length = h['content-length'];
            if (expired() || res.statusCode !== 200 || typeof h['content-type'] !== 'string'
              || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(h['content-type'])
              || (h['content-encoding'] !== undefined && h['content-encoding'] !== 'identity')
              || (length !== undefined && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) > s.maxResponseBytes))) { finish(); return; }
            const pieces: Buffer[] = []; let size = 0, count = 0;
            res.on('data', (chunk: Buffer) => {
              if (done) return;
              if (expired() || !Buffer.isBuffer(chunk) || ++count > 8192 || chunk.length > s.maxResponseBytes - size) { finish(); return; }
              pieces.push(Buffer.from(chunk)); size += chunk.length;
            });
            res.on('end', () => {
              if (!res!.complete || size === 0 || (length !== undefined && Number(length) !== size)) { finish(); return; }
              finish(Buffer.concat(pieces, size));
            });
            res.on('close', () => { if (!done) finish(); });
          });
        } catch { finish(); }
      });
      return { status: 200, chunks: (async function* () { yield response; })() };
    } catch { throw error('failed'); }
    finally { busy = false; }
  };
}
