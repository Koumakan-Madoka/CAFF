// Windows management authorization only. This is NOT a capture capability:
// collector remains fail-closed. Separately bounded metadata preview is not
// permission to enable capture or to read file bodies.
// Storage, PATH-selected interpreter and same-OS-user processes remain TCB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
import { WINDOWS_HELPER_SOURCE, WINDOWS_HELPER_SOURCE_SHA256 } from './windows-helper-source';
import { invokeWindowsHelper } from './windows-helper';

export function prepareWindowsAuthorization(options: any = {}): any {
  const unavailable = () => ({ ok: false, reason: 'windows_authorization_unavailable' });
  if (process.platform !== 'win32') return unavailable();
  const root = typeof options.captureRoot === 'string' ? options.captureRoot : '';
  if (!root || !path.isAbsolute(root)) return unavailable();
  let probe = '';
  let junction = '';
  let result: any = unavailable();
  try {
    let python = '';
    // Isolated startup, bounded output/time, fixed response; never log stdout or
    // an exception. This checks only the management interpreter, not replay env.
    for (const candidate of ['python', 'python3']) {
      const check = spawnSync(candidate, ['-I', '-B', '-c',
        'import sys; sys.exit(1) if sys.platform != "win32" or sys.version_info < (3, 9) else print("caff-windows-auth-v1")'], {
        encoding: 'buffer', timeout: 10000, maxBuffer: 1024, windowsHide: true,
      });
      if (!check.error && check.status === 0 && Buffer.isBuffer(check.stderr) && check.stderr.length === 0
          && Buffer.isBuffer(check.stdout) && check.stdout.toString('ascii').trim() === 'caff-windows-auth-v1') {
        python = candidate;
        break;
      }
    }
    if (!python) return unavailable();
    const dir = path.join(root, 'windows-authorization-helper');
    fs.mkdirSync(dir, { recursive: true });
    const helperPath = path.join(dir, `windows_read.${WINDOWS_HELPER_SOURCE_SHA256}.py`);
    // Exclusive creation: never overwrite/repair an existing untrusted file.
    // Concurrent installation may observe an incomplete write and fail closed;
    // a later explicit authorization can retry after the writer finishes.
    try { fs.writeFileSync(helperPath, WINDOWS_HELPER_SOURCE, { encoding: 'utf8', flag: 'wx' }); }
    catch (error: any) { if (!error || error.code !== 'EEXIST') throw error; }
    const info = fs.lstatSync(helperPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024
        || crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex') !== WINDOWS_HELPER_SOURCE_SHA256) {
      return unavailable();
    }
    // Probe only newly created storage-local directories: no project scan, no
    // target contents, and no generic filesystem/WSL/Node-stat identity fallback.
    probe = fs.mkdtempSync(path.join(dir, 'probe-'));
    const target = path.join(probe, 'target');
    fs.mkdirSync(target);
    const request = { version: 1, op: 'identity', root: target };
    const one = invokeWindowsHelper(python, helperPath, request);
    const two = invokeWindowsHelper(python, helperPath, request);
    if (!one.ok || !two.ok || JSON.stringify(one.identity) !== JSON.stringify(two.identity)) return unavailable();
    junction = path.join(probe, 'alias');
    fs.symlinkSync(target, junction, 'junction');
    const refused = invokeWindowsHelper(python, helperPath, { ...request, root: junction });
    if (refused.ok || !['root_open_rejected', 'relative_open_rejected', 'reparse_rejected'].includes(refused.reason)) return unavailable();
    result = { ok: true, python, helperPath, helperSha256: WINDOWS_HELPER_SOURCE_SHA256 };
  } catch { result = unavailable(); }
  finally {
    // Remove only this invocation's directories. Unlink junction explicitly,
    // never recurse through it. Cleanup failure means authorization unavailable.
    try {
      if (junction && fs.existsSync(junction)) fs.rmdirSync(junction);
      if (probe) fs.rmSync(probe, { recursive: true });
    } catch { result = unavailable(); }
  }
  return result;
}
