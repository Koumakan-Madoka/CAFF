// Run the real direct worker through restoration; stop at the SDK boundary.
// Only an owned TEMP tree is writable. No Docker/model/SDK/network/auth.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
module.exports = async function restore(t, input) {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'direct-path-vm-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const module = { exports: {} }, marker = Error('sdk-boundary'), writes = [];
  const local = p => typeof p === 'string' && p.startsWith('/work/') ? path.join(root, p.slice(6)) : p;
  const fakeFs = { ...fs, existsSync: p => p === '/.dockerenv' || fs.existsSync(local(p)),
    readFileSync(p, ...args) { if (p === '/work/evaluation-profile.json') return JSON.stringify('inert'); if (p === '/work/replay-input.json') return JSON.stringify(input); return fs.readFileSync(local(p), ...args); },
    mkdirSync: (p, ...args) => fs.mkdirSync(local(p), ...args),
    writeFileSync(p, ...args) { writes.push(p); return fs.writeFileSync(local(p), ...args); },
    chmodSync: (p, ...args) => fs.chmodSync(local(p), ...args),
    readdirSync: (p, ...args) => fs.readdirSync(local(p), ...args),
    lstatSync: (p, ...args) => fs.lstatSync(local(p), ...args),
  };
  vm.runInNewContext(fs.readFileSync(path.resolve('scripts/badcase-capture/direct-sdk-container.cjs'), 'utf8'), { module, Buffer, console,
    process: { platform: 'linux', getuid: () => 65534, cwd: () => '/work', env: { CAFF_BADCASE_MODEL_KEY: 'inert' } },
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === '/work/direct-model.cjs') return { KEY_ENV: 'CAFF_BADCASE_MODEL_KEY', validKey: v => v, modelProfile: () => ({}),
        directModelRouting: () => ({}), replaySessionInfo: () => null, observeDirectFetch: () => ({ fetch() { throw Error('network forbidden'); } }) };
      if (name === '/work/caff-runtime-bootstrap.cjs') return { verifyCaffRuntimeStage: () => ({ manifest: {} }), hashFile: p => require('node:crypto').createHash('sha256').update(fs.readFileSync(local(p))).digest('hex') };
      if (name.startsWith('./')) return require(path.resolve('scripts/badcase-capture', name));
      return require(name);
    }, globalThis: { fetch() { throw Error('network forbidden'); } } });
  let boundary = false;
  const run = () => module.exports.main({ loadModule() { boundary = true; throw marker; } });
  return { root, writes, run, boundary: () => boundary, marker, file: p => fs.readFileSync(path.join(root, 'restored', p)) };
};
