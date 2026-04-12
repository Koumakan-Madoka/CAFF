const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { withTempDir } = require('../helpers/temp-dir');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENSURE_BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'ensure-build.js');

function writeFile(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function prepareTempProject(tempDir) {
  const scriptPath = path.join(tempDir, 'scripts', 'ensure-build.js');
  writeFile(scriptPath, fs.readFileSync(ENSURE_BUILD_SCRIPT, 'utf8'));
}

test('prestart build check fails when env local loader artifact is missing', (t) => {
  const tempDir = withTempDir('caff-ensure-build-missing-loader-');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  prepareTempProject(tempDir);
  writeFile(path.join(tempDir, 'build', 'lib', 'app-server.js'), 'module.exports = {};\n');

  const result = spawnSync('node', [path.join('scripts', 'ensure-build.js')], {
    cwd: tempDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(path.join('build', 'lib', 'env-local-loader.js').replace(/\\/g, '\\\\')));
});

test('prestart build check passes when required runtime artifacts exist', (t) => {
  const tempDir = withTempDir('caff-ensure-build-present-artifacts-');

  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  prepareTempProject(tempDir);
  writeFile(path.join(tempDir, 'build', 'lib', 'app-server.js'), 'module.exports = {};\n');
  writeFile(
    path.join(tempDir, 'build', 'lib', 'env-local-loader.js'),
    'module.exports = { loadDotEnvLocal() {} };\n'
  );

  const result = spawnSync('node', [path.join('scripts', 'ensure-build.js')], {
    cwd: tempDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});
