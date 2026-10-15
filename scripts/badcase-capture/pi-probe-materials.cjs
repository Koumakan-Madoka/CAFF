// Static staging of a TRUSTED installed npm distribution, not captured project files.
// No SDK import, install scripts, auth/session discovery, network, or subprocess here.
// Host package tree/ancestors belong to the same-OS-user TCB. This is not a general archive API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const LIMIT = 16 * 1024 * 1024;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function manifestFor(files) {
  const names = new Set(); let total = 0;
  const inventory = files.map(f => {
    if (!f || typeof f.path !== 'string' || !/^[A-Za-z0-9_.@/-]+$/.test(f.path)
        || f.path.split('/').some(p => !p || p === '.' || p === '..') || names.has(f.path)
        || !Buffer.isBuffer(f.bytes)) throw Error('probe_file_invalid');
    names.add(f.path); total += f.bytes.length;
    if (total > LIMIT || names.size > 4096) throw Error('probe_dependency_size');
    return { path: f.path, size: f.bytes.length, sha256: hash(f.bytes) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (names.has(parts.join('/'))) throw Error('probe_file_invalid'); parts.pop(); }
  }
  const runtime = inventory.filter(f => f.path.startsWith('runtime/'));
  return { schemaVersion: 1, files: inventory, inputHash: hash(JSON.stringify(inventory)),
    runtimeHash: hash(JSON.stringify(runtime)), runtimeBytes: runtime.reduce((n, f) => n + f.size, 0) };
}
function syntheticSession() {
  return [
    { type: 'session', version: 3, id: 'synthetic-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/historical/not-mounted' },
    { type: 'thinking_level_change', id: 'e1', parentId: null, timestamp: '2026-01-01T00:00:00.001Z', thinkingLevel: 'off' },
    { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-01-01T00:00:00.002Z', message: { role: 'user', content: 'synthetic history only', timestamp: 1 } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n';
}
function prepareRuntimeFiles(repoRoot) {
  const root = path.join(repoRoot, 'node_modules/@earendil-works/pi-coding-agent');
  const files = []; let total = 0;
  function copy(source, dest) {
    let st; try { st = fs.lstatSync(source); } catch { throw Error('probe_dependency_missing'); }
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) throw Error('probe_dependency_type');
    if (st.isDirectory()) { for (const n of fs.readdirSync(source).sort()) copy(path.join(source, n), dest + '/' + n); return; }
    total += st.size;
    if (total > LIMIT || files.length >= 4096) throw Error('probe_dependency_size');
    const bytes = fs.readFileSync(source);
    if (bytes.length !== st.size) throw Error('probe_dependency_changed');
    files.push({ path: dest, bytes });
  }
  function metadata(source, dest, name, version) {
    copy(source + '/package.json', dest + '/package.json');
    let p; try { p = JSON.parse(files.at(-1).bytes); } catch { throw Error('probe_dependency_version'); }
    if (p.name !== name || p.version !== version) throw Error('probe_dependency_version');
  }
  metadata(root, 'runtime', '@earendil-works/pi-coding-agent', '0.85.1');
  copy(root + '/dist/bundle', 'runtime/dist/bundle');
  if (!files.some(f => f.path === 'runtime/dist/bundle/index.js')) throw Error('probe_dependency_missing');
  copy(root + '/dist/modes/interactive/theme', 'runtime/dist/modes/interactive/theme');
  const chord = root + '/node_modules/@earendil-works/chord';
  metadata(chord, 'runtime/node_modules/@earendil-works/chord', '@earendil-works/chord', '0.85.1');
  copy(chord + '/dist/context', 'runtime/node_modules/@earendil-works/chord/dist/context');
  const typebox = root + '/node_modules/typebox';
  metadata(typebox, 'runtime/node_modules/typebox', 'typebox', '1.3.7');
  copy(typebox + '/build', 'runtime/node_modules/typebox/build');
  // pi-ai code is inside the shipped SDK bundle. Metadata is provenance, not a separate installation proof.
  metadata(root + '/node_modules/@earendil-works/pi-ai', 'runtime/bundled-pi-ai', '@earendil-works/pi-ai', '0.85.1');
  manifestFor(files); return files;
}
function prepareProbeFiles(repoRoot, mode) {
  if (!['fresh', 'resume'].includes(mode)) throw Error('probe_mode_invalid');
  const files = prepareRuntimeFiles(repoRoot);
  files.push({ path: 'probe.cjs', bytes: fs.readFileSync(path.join(__dirname, 'pi-initialize-probe.cjs')) });
  files.push({ path: 'pi-probe-guards.cjs', bytes: fs.readFileSync(path.join(__dirname, 'pi-probe-guards.cjs')) });
  files.push({ path: 'mode.txt', bytes: Buffer.from(mode) });
  const session = Buffer.from(syntheticSession()); // single fixture source, also checked inside the container
  files.push({ path: 'expected-session.jsonl', bytes: session });
  if (mode === 'resume') files.push({ path: 'resume.jsonl', bytes: Buffer.from(session) });
  manifestFor(files);
  return files;
}
module.exports = { prepareProbeFiles, prepareRuntimeFiles, manifestFor, syntheticSession };
