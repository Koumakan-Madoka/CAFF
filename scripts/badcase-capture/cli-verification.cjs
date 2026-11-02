// Verification only: no SDK/model runs on this host. Spawn the unmodified
// operator CLI with a minimal environment; observe target-daemon lifecycle events
// independently rather than replacing the CLI's transport with a test hook.
const assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process');
async function startOperatorCli(config, { script = path.join(__dirname, 'serve-sealed-workbench.cjs'), timeoutMs = 150000 } = {}) {
  assert.ok(path.isAbsolute(config) && path.isAbsolute(script));
  const child = spawn(process.execPath, [script, '--config', config], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), TMPDIR: os.tmpdir(), LANG: 'C.UTF-8' } });
  let exited = false, exitCode, exitSignal, failed = false;
  const closed = new Promise(resolve => {
    child.on('error', () => { failed = true; });
    child.on('close', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; resolve(); });
  });
  async function stop() {
    if (!exited) child.kill('SIGTERM');
    let timer, forced = false;
    try {
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => {
        forced = true; child.kill('SIGKILL'); resolve();
      }, 30000); })]);
      if (forced) await closed;
    } finally { clearTimeout(timer); }
    return !forced && !failed && exitCode === 0 && exitSignal === null;
  }
  try {
    const ready = await new Promise((resolve, reject) => {
      let stdout = '', stderrBytes = 0;
      const timer = setTimeout(() => reject(Error()), timeoutMs);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      child.on('error', () => finish(reject, Error()));
      child.on('close', () => finish(reject, Error()));
      child.stderr.on('data', b => {
        stderrBytes += b.length;
        if (stderrBytes > 4096) { failed = true; child.kill('SIGTERM'); finish(reject, Error()); }
      });
      child.stdout.on('data', b => {
        // Successful CLI emits one small readiness record only. Never expose raw
        // stdout/stderr or config paths in a verification failure.
        if (failed) return;
        if (Buffer.byteLength(stdout) + b.length > 4096) {
          failed = true; child.kill('SIGTERM'); finish(reject, Error()); return;
        }
        stdout += b.toString('utf8');
        if (!stdout.includes('\n')) return;
        try {
          const r = JSON.parse(stdout);
          assert.deepEqual(Object.keys(r).sort(), ['faithfulReplay', 'mode', 'note', 'realModel', 'url']);
          assert.equal(r.mode, 'offline-scripted-workbench'); assert.equal(r.realModel, false); assert.equal(r.faithfulReplay, false);
          assert.equal(typeof r.note, 'string');
          const url = new URL(r.url); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
          assert.ok(url.port && Number(url.port) > 0); assert.equal(r.url, url.origin);
          finish(resolve, r);
        } catch { finish(reject, Error()); }
      });
    });
    return { url: ready.url, pid: child.pid, get exitCode() { return exitCode; }, get exitSignal() { return exitSignal; },
      async close() { assert.ok(await stop(), 'operator_cli_exit_failed'); } };
  } catch {
    await stop(); throw Error('operator_cli_verification_failed');
  }
}
function containerLifecycleEvidence(events, imageId, count) {
  assert.ok(Array.isArray(events) && Number.isSafeInteger(count) && count > 0);
  const groups = new Map();
  for (const e of events) {
    assert.equal(e.Type, 'container');
    // attach/copy-related daemon events are not lifecycle transitions.
    if (!['create', 'start', 'die', 'destroy', 'kill', 'oom'].includes(e.Action)) continue;
    const id = e.Actor?.ID, a = e.Actor?.Attributes;
    assert.match(id, /^[a-f0-9]{64}$/); assert.equal(a?.image, imageId);
    const owner = a['caff.badcase.pi-initialization']; assert.ok(typeof owner === 'string' && owner.length > 0);
    assert.equal(a.name, 'caff-pi-init-' + owner);
    const entries = groups.get(id) || []; assert.ok(Number.isFinite(e.timeNano) && e.timeNano > 0);
    if (entries.length) { assert.equal(owner, entries[0].owner); assert.ok(e.timeNano >= entries.at(-1).time); }
    if (e.Action === 'die') assert.equal(a.exitCode, '0');
    entries.push({ action: e.Action, time: e.timeNano, owner }); groups.set(id, entries);
  }
  assert.equal(groups.size, count);
  for (const entries of groups.values()) assert.deepEqual(entries.map(e => e.action), ['create', 'start', 'die', 'destroy']);
  return [...groups.keys()];
}
module.exports = { startOperatorCli, containerLifecycleEvidence };
