// Pure guard tests: no SDK import, Docker process, session or model on the host.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const { verifyMaterialBytes, verifyNoProbeSideEffects, verifiedCleanupId } = require('../../scripts/badcase-capture/pi-probe-guards.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
test('material guard rejects same-length corruption independently of the size check', () => {
  const bytes = Buffer.from('good'), record = { size: 4, sha256: hash(bytes) };
  assert.doesNotThrow(() => verifyMaterialBytes(bytes, record));
  assert.throws(() => verifyMaterialBytes(Buffer.from('evil'), record), /probe_material_hash/);
  assert.throws(() => verifyMaterialBytes(Buffer.from('longer'), record), /probe_material_size/);
});
test('discovery trap rejects even with zero model and network calls', () => {
  assert.doesNotThrow(() => verifyNoProbeSideEffects('approved prompt', 0, 0));
  assert.throws(() => verifyNoProbeSideEffects('prefix Unapproved discovery trap suffix', 0, 0), /probe_discovery_forbidden/);
});
test('model and network counters independently reject nonzero calls', () => {
  assert.throws(() => verifyNoProbeSideEffects('approved prompt', 1, 0), /probe_model_called/);
  assert.throws(() => verifyNoProbeSideEffects('approved prompt', 0, 1), /probe_network_called/);
});
test('cleanup refuses a foreign or absent owner even when the complete container ID matches', () => {
  const id = 'b'.repeat(64), label = 'caff.badcase.pi-initialization';
  const container = { Id: id, Config: { Labels: { [label]: 'ours' } } };
  assert.equal(verifiedCleanupId(container, 'ours', id), id);
  assert.equal(verifiedCleanupId(container, 'ours', ''), id); // create response lost
  assert.throws(() => verifiedCleanupId(container, 'theirs', id), /probe_cleanup_owner/);
  assert.throws(() => verifiedCleanupId({ ...container, Config: { Labels: {} } }, 'ours', id), /probe_cleanup_owner/);
});
test('container entry rejects corrupted bytes before environment setup or SDK import (filesystem stub)', async () => {
  const script = path.resolve(__dirname, '../../scripts/badcase-capture/pi-initialize-probe.cjs');
  const realRequire = createRequire(script);
  let laterReads = 0, stderr = '';
  const mockFs = {
    existsSync: () => true,
    lstatSync: () => ({ size: 4, isFile: () => true, isSymbolicLink: () => false }),
    readFileSync: name => {
      if (name === '/work/manifest.json') {
        const files = [{ path: 'data.txt', size: 4, sha256: hash('good') }];
        return JSON.stringify({ schemaVersion: 1, files, inputHash: hash(JSON.stringify(files)), runtimeHash: hash('[]') });
      }
      if (name === '/work/data.txt') return Buffer.from('evil');
      laterReads++; throw Error('must not reach environment or SDK');
    },
  };
  const processStub = { platform: 'linux', getuid: () => 65534, cwd: () => '/work',
    stderr: { write: s => { stderr += s; } } };
  await vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    require: name => name === 'node:fs' ? mockFs : realRequire(name), process: processStub,
  }, { filename: script, timeout: 1000 });
  assert.equal(processStub.exitCode, 1);
  assert.equal(stderr, 'pi_initialization_probe_failed\n');
  assert.equal(laterReads, 0);
});
test('wrapper refuses foreign cleanup owner and issues no rm (Docker/tar stubs, no SDK)', async () => {
  const sandbox = require('../../build/server/domain/runtime/badcase-capture/docker-sandbox');
  const childProcess = require('node:child_process');
  const entry = require.resolve('../../scripts/badcase-capture/verify-pi-initialization.cjs');
  const originalRun = sandbox.runDockerCommand, originalExec = childProcess.execFileSync, originalModule = require.cache[entry];
  const image = { imageId: 'sha256:' + 'a'.repeat(64) };
  let inspections = 0;
  const docker = require('../helpers/badcase-fake-docker.cjs')(image, {
    change(args, result, state) {
      if (args[0] !== 'inspect') return;
      const c = JSON.parse(result.stdout)[0];
      c.Config.Labels = { 'caff.badcase.pi-initialization': ++inspections === 3 ? 'foreign-owner' : state.owner };
      result.stdout = JSON.stringify([c]);
    },
  });
  try {
    sandbox.runDockerCommand = docker.run;
    childProcess.execFileSync = () => Buffer.from('synthetic tar, never executed');
    delete require.cache[entry];
    const { runProbe } = require(entry);
    await assert.rejects(runProbe(image, [{ path: 'data.txt', bytes: Buffer.from('synthetic') }]), /probe_cleanup_failed/);
    assert.equal(inspections, 3);
    assert.equal(docker.calls.some(c => c.args[0] === 'rm'), false);
  } finally {
    sandbox.runDockerCommand = originalRun; childProcess.execFileSync = originalExec;
    delete require.cache[entry]; if (originalModule) require.cache[entry] = originalModule;
  }
});
test('cleanup refuses truncated or mismatching IDs before returning a deletion target', () => {
  const make = Id => ({ Id, Config: { Labels: { 'caff.badcase.pi-initialization': 'ours' } } });
  assert.throws(() => verifiedCleanupId(make('abc'), 'ours', ''), /probe_cleanup_id/);
  assert.throws(() => verifiedCleanupId(make('b'.repeat(64)), 'ours', 'c'.repeat(64)), /probe_cleanup_id/);
});
