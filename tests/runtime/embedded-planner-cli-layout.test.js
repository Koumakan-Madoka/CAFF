const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolvePlannerCli, probePlannerCli } = require('../../build/server/domain/runtime/embedded-planner-cli');
const { buildPlannerEnvironment } = require('../../build/server/domain/runtime/embedded-planner-env');

function layout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-npm-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shim = path.join(root, 'claude.cmd'), pkg = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  // This shim is deliberately not executable or parseable. Only the manifest matters.
  fs.writeFileSync(shim, 'DO NOT EXECUTE: synthetic shim');
  const manifest = value => fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(value));
  return { root, shim, pkg, manifest, resolve: () => resolvePlannerCli({ override: shim, env: {} }) };
}

test('npm native layout resolves package bin.claude to a literal executable without running its shim', t => {
  const f = layout(t), native = path.join(f.pkg, 'bin', 'claude.exe');
  fs.writeFileSync(native, 'synthetic native file; never executed'); f.manifest({ bin: { claude: 'bin/claude.exe' } });
  assert.deepEqual(f.resolve(), { file: fs.realpathSync(native), prefix: [] });
  if (process.platform === 'win32') assert.deepEqual(resolvePlannerCli({ env: { PATH: f.root } }), f.resolve());
});

test('npm legacy bin and explicit js/cjs/mjs entries use Node, including manifest bin as a string', async t => {
  const f = layout(t);
  for (const name of ['cli.js', 'cli.cjs', 'cli.mjs']) {
    const file = path.join(f.pkg, name); fs.writeFileSync(file, 'console.log("2.1.310 (Claude Code)")');
    for (const bin of [name, { claude: name }]) {
      f.manifest({ bin }); assert.deepEqual(f.resolve(), { file: process.execPath, prefix: [fs.realpathSync(file)] });
    }
    assert.deepEqual(resolvePlannerCli({ override: file, env: {} }), { file: process.execPath, prefix: [file] });
  }
  const env = buildPlannerEnvironment({ source: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: f.root, USERPROFILE: f.root }, baseUrl: 'http://127.0.0.1:45678' });
  assert.equal(await probePlannerCli(f.resolve(), env), '2.1.310');
});

test('npm layout rejects missing/malformed bin, traversal, non-files and unsupported extensions', t => {
  const f = layout(t);
  fs.writeFileSync(path.join(f.pkg, 'cli.js'), '// valid file, but must not be guessed');
  fs.writeFileSync(path.join(f.pkg, 'bin', 'unsafe.ps1'), 'synthetic');
  const outside = path.join(f.root, 'outside.cjs'); fs.writeFileSync(outside, 'synthetic');
  for (const value of [{}, null, { bin: null }, { bin: '' }, { bin: 7 }, { bin: [] }, { bin: { other: 'cli.js' } }, { bin: { claude: ['cli.js'] } }, { bin: '../escape.js' }, { bin: path.relative(f.pkg, outside) }, { bin: outside }, { bin: 'bin' }, { bin: 'missing.js' }, { bin: 'bin/unsafe.ps1' }, { bin: 'cli.js\u0000' }]) {
    f.manifest(value); assert.throws(f.resolve, /planner_cli_launch_unsupported/);
  }
  fs.writeFileSync(path.join(f.pkg, 'package.json'), '{invalid'); assert.throws(f.resolve, /planner_cli_launch_unsupported/);
  fs.rmSync(path.join(f.pkg, 'package.json')); assert.throws(f.resolve, /planner_cli_launch_unsupported/);
});

test('npm realpath containment rejects a symlink/junction escape', t => {
  const f = layout(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'cli.cjs'), 'synthetic');
  fs.symlinkSync(outside, path.join(f.pkg, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.manifest({ bin: 'linked/cli.cjs' }); assert.throws(f.resolve, /planner_cli_launch_unsupported/);
});
