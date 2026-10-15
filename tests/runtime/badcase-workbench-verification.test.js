const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { verificationMode, isolatedBrowserOptions, assertExecutionEvidence } = require('../../scripts/badcase-capture/verify-workbench.cjs');

test('browser-only remains synthetic; joint browser mode requires real Docker', () => {
  assert.deepEqual(verificationMode(['--browser']), { browserMode: true, synthetic: true, joint: false });
  assert.deepEqual(verificationMode(['--browser-docker']), { browserMode: true, synthetic: false, joint: true });
  assert.deepEqual(verificationMode([]), { browserMode: false, synthetic: false, joint: false });
  assert.throws(() => verificationMode(['--browser', '--browser-docker']));
});

test('joint browser needs explicit executable/libraries and a different network namespace', () => {
  const root = path.resolve('test-browser-profile'), exe = path.resolve('browser'), libs = path.resolve('libs');
  const options = isolatedBrowserOptions(root, exe, libs, 'net:[2]', 'net:[1]');
  assert.equal(options.executablePath, exe);
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'LD_LIBRARY_PATH', 'PATH', 'TMPDIR']);
  assert.equal(options.env.LD_LIBRARY_PATH, libs);
  assert.equal(options.env.HOME, root);
  const fontconfig = path.resolve('fonts.conf');
  assert.equal(isolatedBrowserOptions(root, exe, libs, 'b', 'a', fontconfig).env.FONTCONFIG_FILE, fontconfig);
  assert.throws(() => isolatedBrowserOptions(root, exe, libs, 'b', 'a', 'relative'));
  for (const args of [[root, '', libs, 'b', 'a'], [root, exe, '', 'b', 'a'], [root, exe, libs, 'a', 'a'], [root, exe, libs, 'b', ''], [root, 'relative', libs, 'b', 'a']]) {
    assert.throws(() => isolatedBrowserOptions(...args));
  }
});

test('joint evidence rejects synthetic transport, missing/duplicate containers and missing browser', () => {
  const good = { synthetic: false, joint: true, browserVersion: '151.0', calls: ['r1', 'r2', 'r3', 'r4'], ids: ['a', 'b', 'c', 'd'].map(c => c.repeat(64)) };
  assert.doesNotThrow(() => assertExecutionEvidence(good));
  // Separate exact-length non-hex from wrong-length hex; neither may pass even
  // when count/uniqueness are correct (fixed-SHA review E48 coverage suggestion).
  for (const id of ['g'.repeat(64), 'a'.repeat(65)]) {
    assert.throws(() => assertExecutionEvidence({ ...good, ids: [id, ...good.ids.slice(1)] }));
  }
  for (const patch of [{ synthetic: true }, { ids: [] }, { ids: Array(4).fill('a'.repeat(64)) }, { ids: ['invalid', ...good.ids.slice(1)] }, { browserVersion: null }, { calls: ['r1'] }, { calls: ['r1', 'r1', 'r3', 'r4'] }]) {
    assert.throws(() => assertExecutionEvidence({ ...good, ...patch }));
  }
});
