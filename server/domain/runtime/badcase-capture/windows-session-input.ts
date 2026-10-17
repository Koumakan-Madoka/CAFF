// Internal independently authorized session-file primitive. No turn/enable
// wiring, session grammar validation, persistence, install or identity re-pin.
// A valid UTF-8 byte read is NOT proof of a complete/replayable resume session.
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { WINDOWS_HELPER_SOURCE_SHA256 } from './windows-helper-source';
import { encodeWindowsHelperRequest, invokeWindowsSessionHelper } from './windows-helper';
import { containsSecretSentinel } from './secrets';
const fail = (reason: string) => ({ ok: false, reason });
const absolute = (p: any) => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p);
const normalized = (p: string) => path.win32.resolve(p).replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
const under = (root: string, target: string) => target === root || target.startsWith(`${root}/`);

export async function readWindowsSessionInput(options: any = {}): Promise<any> {
  const deadline = performance.now() + 25000;
  if (process.platform !== 'win32') return fail('windows_required');
  try {
    if (!absolute(options.inputPath) || !absolute(options.captureRoot)) return fail('session_not_authorized');
    const target = path.win32.resolve(options.inputPath), key = normalized(target);
    const policy = options.policy;
    const dirs = Array.isArray(policy?.authorizedInputDirs) ? policy.authorizedInputDirs : [];
    // Worktree authorization alone NEVER authorizes this input. Pins not still
    // present in the independently authorized list are not consulted either.
    const dir = dirs.find((p: any) => absolute(p) && under(normalized(p), key) && normalized(p) !== key);
    if (!dir) return fail('session_not_authorized');
    const root = path.win32.resolve(dir), pin = policy?.authorizedInputPins?.[root.toLowerCase()];
    if (!pin?.identity || !absolute(pin.realpath) || normalized(pin.realpath) !== normalized(root)) return fail('session_input_root_unpinned');
    const request = { version: 1, op: 'sessionInput', root, expected: pin.identity,
      path: path.win32.relative(root, target).replace(/\\/g, '/') };
    if (!encodeWindowsHelperRequest(request)) return fail('session_not_authorized');
    // Reject aliases by metadata; never substitute realpath as the helper
    // target (which would swallow a reparse boundary). NT sees literal root.
    if (normalized(fs.realpathSync.native(root)) !== normalized(root)
        || normalized(fs.realpathSync.native(target)) !== key) return fail('session_input_scope_rejected');
    if (options.privateDirs !== undefined && !Array.isArray(options.privateDirs)) return fail('session_input_scope_rejected');
    const guards = [options.captureRoot, ...(options.privateDirs || []),
      process.env.PI_AGENT_SANDBOX_DIR, process.env.PI_AGENT_PRIVATE_DIR].filter(Boolean);
    for (const guard of guards) {
      if (!absolute(guard)) return fail('session_input_scope_rejected');
      const literal = path.win32.resolve(guard), variants = [literal];
      try { variants.push(fs.realpathSync.native(literal)); }
      catch (error: any) { if (error?.code !== 'ENOENT') return fail('session_input_scope_rejected'); }
      if (variants.some(p => under(normalized(p), key))) return fail('session_input_scope_rejected');
    }
    if (performance.now() >= deadline) return fail('session_input_timeout');
    const helperPath = path.join(options.captureRoot, 'windows-authorization-helper', `windows_read.${WINDOWS_HELPER_SOURCE_SHA256}.py`);
    const result = await invokeWindowsSessionHelper('python', helperPath, request, deadline);
    if (performance.now() >= deadline) return fail('session_input_timeout');
    // Fixed reason, not a helper/interpreter error string, path, hash or body.
    if (!result.ok || !Buffer.isBuffer(result.file?.content)) return fail('session_input_unavailable');
    const bytes = result.file.content;
    if (containsSecretSentinel(bytes)) return fail('session_contains_secret');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return fail('session_utf8_invalid'); }
    // Do not retain the wire backing or expose a hash/identity to the caller;
    // subsequent resume preparation must validate grammar and archive bytes.
    const owned = Buffer.alloc(bytes.length); bytes.copy(owned);
    if (performance.now() >= deadline) return fail('session_input_timeout');
    return { ok: true, reason: '', content: owned };
  } catch { return fail('session_input_unavailable'); }
}
