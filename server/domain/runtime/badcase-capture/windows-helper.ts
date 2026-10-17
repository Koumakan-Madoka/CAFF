// Audited low-level transport. Explicit Windows management authorization uses
// identity queries; metadata preview uses a distinct no-body estimate operation.
// Capture capability and collector remain unconnected.
// A valid response is not proof of a coherent snapshot or a replayable turn.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { TextDecoder } = require('node:util');
import { WINDOWS_HELPER_SOURCE_SHA256 } from './windows-helper-source';

export const WINDOWS_HELPER_LIMITS = Object.freeze({
  requestBytes: 1024 * 1024, headerBytes: 32 * 1024 * 1024,
  bodyBytes: 128 * 1024 * 1024, fileBytes: 64 * 1024 * 1024,
  entries: 100000, paths: 2048, exclusions: 256, timeoutMs: 10 * 60 * 1000, identityTimeoutMs: 10000,
  estimateTimeoutMs: 25000,
});
const REASONS = new Set([
  'request_invalid', 'helper_failed', 'windows_required', 'root_path_invalid',
  'path_invalid', 'root_open_rejected', 'drive_unsupported', 'filesystem_unsupported',
  'metadata_unavailable', 'not_disk_file', 'reparse_rejected', 'type_rejected',
  'case_sensitive_unsupported', 'relative_open_rejected', 'root_identity_mismatch',
  'file_identity_mismatch', 'enumeration_failed', 'enumeration_invalid',
  'directory_changed', 'entry_limit', 'depth_limit', 'limit_invalid',
  'path_not_in_manifest', 'too_large', 'read_failed', 'short_read',
  'changed_during_read', 'output_limit', 'estimate_scope_rejected',
]);
function exact(value: any, keys: string[]) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function decimal(value: any, low: bigint, high: bigint) {
  return typeof value === 'string' && /^(?:0|-?[1-9][0-9]{0,19})$/.test(value)
    && BigInt(value) >= low && BigInt(value) <= high;
}
const I64_LOW = -(1n << 63n), I64_HIGH = (1n << 63n) - 1n;
function validIdentity(value: any) {
  return exact(value, ['volumeSerial', 'fileId', 'creationTime'])
    && decimal(value.volumeSerial, 0n, (1n << 64n) - 1n)
    && typeof value.fileId === 'string' && /^[a-f0-9]{32}$/.test(value.fileId)
    && decimal(value.creationTime, I64_LOW, I64_HIGH);
}
function sameIdentity(a: any, b: any) {
  return a.volumeSerial === b.volumeSerial && a.fileId === b.fileId && a.creationTime === b.creationTime;
}
function validRelative(value: any) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 32768
    && value.split('/').every(part => part.length > 0 && part.length <= 255
      && part !== '.' && part !== '..' && !/[ .]$/.test(part)
      && !/[\x00-\x1f<>:"|?*\\]/.test(part)
      // Reject lone surrogates, but accept well-formed astral characters.
      && !/[\uD800-\uDFFF]/u.test(part)
      && !/^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?$/i.test(part));
}
function validRequest(request: any) {
  if (!request || request.version !== 1 || !['identity', 'capture', 'estimate'].includes(request.op)
      || !exact(request, request.op === 'identity' ? ['version', 'op', 'root']
        : request.op === 'estimate' ? ['version', 'op', 'root', 'expected', 'excluded']
          : ['version', 'op', 'root', 'expected', 'excluded', 'paths'])
      || typeof request.root !== 'string' || Buffer.byteLength(request.root) > 32768) return false;
  const match = request.root.match(/^[a-z]:[\\/](.*)$/i);
  if (!match || (match[1] && !validRelative(match[1].replace(/\\/g, '/')))) return false;
  if (request.op === 'identity') return true;
  return validIdentity(request.expected)
    && Array.isArray(request.excluded) && request.excluded.length <= WINDOWS_HELPER_LIMITS.exclusions
    && request.excluded.every(validRelative)
    && (request.op === 'estimate' || (Array.isArray(request.paths) && request.paths.length <= WINDOWS_HELPER_LIMITS.paths
      && request.paths.every(validRelative) && new Set(request.paths).size === request.paths.length));
}
export function encodeWindowsHelperRequest(request: any) {
  try {
    if (!validRequest(request)) return null;
    const input = Buffer.from(JSON.stringify(request), 'utf8');
    return input.length <= WINDOWS_HELPER_LIMITS.requestBytes ? input : null;
  } catch { return null; }
}

// Validate every wire field before exposing any file. All native 64-bit values
// remain canonical decimal strings; Number conversion is only for bounded body
// lengths (<=64 MiB), never identities or walk sizes.
export function parseWindowsHelperResponse(stdout: any, request: any): any {
  const bad = () => ({ ok: false, reason: 'helper_output_invalid' });
  try {
    if (!encodeWindowsHelperRequest(request) || !Buffer.isBuffer(stdout)
        || stdout.length > WINDOWS_HELPER_LIMITS.headerBytes + WINDOWS_HELPER_LIMITS.bodyBytes + 1) return bad();
    const newline = stdout.indexOf(10);
    if (newline < 0 || newline > WINDOWS_HELPER_LIMITS.headerBytes) return bad();
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout.subarray(0, newline)));
    let offset = newline + 1;
    if (header.version !== 1) return bad();
    if (header.ok === false) {
      return exact(header, ['version', 'ok', 'code']) && REASONS.has(header.code) && offset === stdout.length
        ? { ok: false, reason: header.code } : bad();
    }
    if (header.ok !== true || !validIdentity(header.identity)) return bad();
    if (request.op === 'identity') {
      return exact(header, ['version', 'ok', 'identity']) && offset === stdout.length
        ? { ok: true, identity: header.identity } : bad();
    }
    const paths = request.op === 'estimate' ? [] : request.paths;
    if (!exact(header, ['version', 'ok', 'identity', 'entries', 'files'])
        || !sameIdentity(header.identity, request.expected)
        || !Array.isArray(header.entries) || header.entries.length > WINDOWS_HELPER_LIMITS.entries
        || !Array.isArray(header.files) || header.files.length !== paths.length) return bad();
    const entries = new Map<string, any>();
    let previous: any = null;
    for (const entry of header.entries) {
      if (!exact(entry, ['path', 'type', 'size', 'identity', 'lastWriteTime', 'changeTime'])
          || !validRelative(entry.path) || entry.path.split('/').length > 64
          || !['file', 'directory'].includes(entry.type)
          || !decimal(entry.size, 0n, I64_HIGH) || (entry.type === 'directory' && entry.size !== '0')
          || !validIdentity(entry.identity) || entry.identity.volumeSerial !== header.identity.volumeSerial
          || !decimal(entry.lastWriteTime, I64_LOW, I64_HIGH) || !decimal(entry.changeTime, I64_LOW, I64_HIGH)) return bad();
      const encoded = Buffer.from(entry.path, 'utf8'); // UTF-8 order == Python Unicode scalar order
      if (previous && Buffer.compare(previous, encoded) >= 0) return bad();
      previous = encoded;
      const slash = entry.path.lastIndexOf('/');
      if (slash >= 0 && entries.get(entry.path.slice(0, slash))?.type !== 'directory') return bad();
      entries.set(entry.path, entry);
    }
    const files: any[] = [];
    let total = 0;
    for (let i = 0; i < header.files.length; i++) {
      const file = header.files[i], entry = entries.get(paths[i]);
      if (!exact(file, ['path', 'size', 'sha256', 'identity']) || file.path !== paths[i]
          || !entry || entry.type !== 'file' || !validIdentity(file.identity)
          || !sameIdentity(file.identity, entry.identity) || file.size !== entry.size
          || !decimal(file.size, 0n, BigInt(WINDOWS_HELPER_LIMITS.fileBytes))
          || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) return bad();
      const size = Number(file.size);
      total += size;
      if (total > WINDOWS_HELPER_LIMITS.bodyBytes || offset + size > stdout.length) return bad();
      const content = stdout.subarray(offset, offset + size);
      offset += size;
      if (crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) return bad();
      files.push({ ...file, content });
    }
    return offset === stdout.length ? { ok: true, identity: header.identity, entries: header.entries, files } : bad();
  } catch { return bad(); }
}

export function invokeWindowsHelper(python: string, helperPath: string, request: any): any {
  if (process.platform !== 'win32') return { ok: false, reason: 'windows_required' };
  const input = encodeWindowsHelperRequest(request);
  if (!input) return { ok: false, reason: 'request_invalid' };
  try {
    // Deployment trusts this host/interpreter and same-OS-user processes; disk
    // verification is not an immutable executable or Python process attestation.
    if (fs.statSync(helperPath).size > 1024 * 1024
        || crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex') !== WINDOWS_HELPER_SOURCE_SHA256) {
      return { ok: false, reason: 'helper_integrity_failed' };
    }
    const result = spawnSync(python, ['-I', '-B', helperPath], {
      input, encoding: 'buffer', windowsHide: true,
      timeout: request.op === 'identity' ? WINDOWS_HELPER_LIMITS.identityTimeoutMs
        : request.op === 'estimate' ? WINDOWS_HELPER_LIMITS.estimateTimeoutMs : WINDOWS_HELPER_LIMITS.timeoutMs,
      maxBuffer: WINDOWS_HELPER_LIMITS.headerBytes + WINDOWS_HELPER_LIMITS.bodyBytes + 1,
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stderr) || result.stderr.length !== 0) {
      return { ok: false, reason: 'helper_process_failed' };
    }
    return parseWindowsHelperResponse(result.stdout, request);
  } catch { return { ok: false, reason: 'helper_process_failed' }; }
}

// HTTP metadata preview only: one audited Python child, no shell/descendants.
// Windows termination targets Node's child process handle, not a recycled PID
// or taskkill /T. Do not reuse this for helpers which can launch descendants.
let activeEstimates = 0;
export async function invokeWindowsEstimateHelper(python: string, helperPath: string, request: any): Promise<any> {
  const fail = (reason: string) => ({ ok: false, reason });
  if (process.platform !== 'win32') return fail('windows_required');
  const input = encodeWindowsHelperRequest(request);
  if (!input || request.op !== 'estimate') return fail('request_invalid');
  if (activeEstimates >= 2) return fail('estimate_busy');
  activeEstimates++;
  try {
    if (fs.statSync(helperPath).size > 1024 * 1024
        || crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex') !== WINDOWS_HELPER_SOURCE_SHA256) {
      return fail('helper_integrity_failed');
    }
    return await new Promise(resolve => {
      const start = performance.now();
      const timeout = WINDOWS_HELPER_LIMITS.estimateTimeoutMs;
      const maxOutput = WINDOWS_HELPER_LIMITS.headerBytes + 1; // NO body for estimate
      let child: any;
      try {
        child = spawn(python, ['-I', '-B', helperPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch { resolve(fail('helper_process_failed')); return; }
      let reason = '', bytes = 0;
      const chunks: any[] = [];
      const stop = (why: string) => {
        if (!reason) reason = why;
        chunks.length = 0;
        // Keep draining/wait for close. No partial output, no success before
        // the process AND both inherited output pipes have closed.
        try { child.kill('SIGKILL'); } catch { reason = 'estimate_cleanup_failed'; }
      };
      const timer = setTimeout(() => stop('estimate_timeout'), timeout);
      child.on('error', () => stop('helper_process_failed'));
      child.stdin.on('error', () => { /* checked on close; never log */ });
      child.stdout.on('data', (chunk: any) => {
        if (reason) return;
        bytes += chunk.length;
        if (bytes > maxOutput) { stop('estimate_output_limit'); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', () => stop('helper_process_failed'));
      child.on('close', (code: any) => {
        clearTimeout(timer);
        if (reason) { resolve(fail(reason)); return; }
        if (performance.now() - start >= timeout) { resolve(fail('estimate_timeout')); return; }
        if (code !== 0) { resolve(fail('helper_process_failed')); return; }
        resolve(parseWindowsHelperResponse(Buffer.concat(chunks), request));
      });
      try { child.stdin.end(input); } catch { stop('request_invalid'); }
    });
  } catch { return fail('helper_process_failed'); }
  finally { activeEstimates--; }
}
