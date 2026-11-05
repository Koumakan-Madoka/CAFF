const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withTempDir } = require('../helpers/temp-dir');
const { capSkip } = require('../helpers/capture-capability');
const safeRead = require('../../build/server/domain/runtime/badcase-capture/safe-read');
const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');

function fixture() {
  const temp = withTempDir();
  const target = path.join(temp, 'project');
  fs.mkdirSync(path.join(target, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(target, 'sub', 'file.txt'), 'seven!!');
  const options = { captureRoot: path.join(temp, 'capture') };
  return { temp, target, options, service: createBadcaseCaptureService(options) };
}

// Observe the actual constrained-root boundary, not a fake estimator. Each test
// restores the shared export; node:test runs these top-level tests sequentially.
async function observeRoots(run) {
  const original = safeRead.openConstrainedRoot;
  const counts = { open: 0, walk: 0, read: 0 };
  safeRead.openConstrainedRoot = (...args) => {
    counts.open++;
    const root = original(...args);
    if (!root.ok) return root;
    return { ...root,
      walk(...params) { counts.walk++; return root.walk(...params); },
      readBatch(...params) { counts.read++; return root.readBatch(...params); },
    };
  };
  try { await run(counts); } finally { safeRead.openConstrainedRoot = original; }
}

function assertDenied(result, reason) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, reason);
  assert.equal(result.fileCount, 0);
  assert.equal(result.totalBytes, 0);
}

test('estimate authorization: unlisted, unpinned and input-only roots never open or enumerate', async () => {
  const { service, target } = fixture();
  await observeRoots((counts) => {
    assertDenied(service.estimateDirectory('p', target), 'dir_not_authorized');
    service.savePolicy('p', { status: 'disabled', authorizedDirs: [target] });
    assertDenied(service.estimateDirectory('p', target), 'authorized_root_unpinned');
    service.savePolicy('p', { status: 'disabled', authorizedInputDirs: [target] });
    service.authorizeProject('p');
    assertDenied(service.estimateDirectory('p', target), 'dir_not_authorized');
    assert.deepEqual(counts, { open: 0, walk: 0, read: 0 });
    assert.equal(service.store.listCheckpoints('p').length, 0);
  });
});

test('estimate authorization: missing identifiers do not fall back to cwd', async () => {
  const { service, target } = fixture();
  await observeRoots((counts) => {
    assertDenied(service.estimateDirectory('', target), 'project_id_missing');
    assertDenied(service.estimateDirectory('p', ''), 'target_dir_missing');
    assert.deepEqual(counts, { open: 0, walk: 0, read: 0 });
  });
});

test('estimate authorization: durable pin permits disabled preview without enabling capture or reading content', { skip: capSkip }, async () => {
  const { service, target, options } = fixture();
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [target] });
  service.authorizeProject('p');
  const policy = service.loadPolicy('p');
  const restarted = createBadcaseCaptureService(options);
  await observeRoots(async (counts) => {
    const result = restarted.estimateDirectory('p', target);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.authorized, true);
    assert.equal(result.fileCount, 1);
    assert.equal(result.totalBytes, 7);
    assert.equal(result.includesIgnored, true);
    assert.equal(result.complete, true);
    assert.deepEqual(counts, { open: 1, walk: 1, read: 0 });
    assert.deepEqual(restarted.loadPolicy('p'), policy);
    assert.equal(restarted.computeUsage('p').totalBytes, 0);
    assert.equal((await restarted.captureTurnCheckpoint({ projectId: 'p', targetDir: target })).reason, 'policy_not_enabled');
    assert.equal(restarted.store.listCheckpoints('p').length, 0);
    assert.deepEqual(counts, { open: 1, walk: 1, read: 0 });
  });
});

test('estimate authorization: replaced object rejected before walk; ordinary save cannot re-pin', { skip: capSkip }, async () => {
  const { service, target } = fixture();
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [target] });
  service.authorizeProject('p');
  const prior = service.loadPolicy('p');
  fs.renameSync(target, target + '-original');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'outside.txt'), 'not authorized');
  await observeRoots((counts) => {
    assertDenied(service.estimateDirectory('p', target), 'authorized_root_replaced');
    service.savePolicy('p', { ...prior, stagingRetentionDays: 8 });
    assert.deepEqual(service.loadPolicy('p').authorizedDirPins, prior.authorizedDirPins);
    assertDenied(service.estimateDirectory('p', target), 'authorized_root_replaced');
    assert.equal(counts.walk, 0);
    assert.equal(counts.read, 0);
    service.authorizeProject('p');
    const result = service.estimateDirectory('p', target);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.totalBytes, 14);
    assert.equal(service.loadPolicy('p').status, 'disabled');
    assert.equal(counts.walk, 1);
  });
});

test('estimate authorization: descendant and missing identity fail closed', { skip: capSkip }, async () => {
  const { service, target } = fixture();
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [target] });
  service.authorizeProject('p');
  await observeRoots((counts) => {
    assertDenied(service.estimateDirectory('p', path.join(target, 'sub')), 'target_must_be_authorized_root');
    const policy = service.loadPolicy('p');
    for (const pin of Object.values(policy.authorizedDirPins)) delete pin.identity;
    service.store.savePolicy(policy); // simulate old/corrupt persisted identity, not a public authorization
    assertDenied(service.estimateDirectory('p', target), 'authorized_root_identity_missing');
    assert.equal(counts.walk, 0);
    assert.equal(counts.read, 0);
  });
});

test('estimate authorization: mid-walk root swap keeps enumeration on the authorized held fd', { skip: capSkip }, () => {
  const { service, target } = fixture();
  fs.writeFileSync(path.join(target, 'root.txt'), 'fifteen bytes!!');
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [target] });
  service.authorizeProject('p');
  const policy = service.loadPolicy('p');
  const originalOpen = safeRead.openConstrainedRoot;
  const order = [];
  let walked;
  safeRead.openConstrainedRoot = (...args) => {
    const root = originalOpen(...args);
    assert.equal(root.ok, true, JSON.stringify(root));
    return { ...root,
      identityEquals(pin) {
        const matches = root.identityEquals(pin);
        assert.equal(matches, true);
        order.push('identity');
        return matches;
      },
      enumerationIntact() {
        const intact = root.enumerationIntact();
        assert.equal(intact, true);
        order.push('intact');
        return intact;
      },
      walk(...params) {
        assert.deepEqual(order, ['identity', 'intact']);
        order.push('swap');
        // Swap AFTER both checks. Reopening by pathname here would enumerate
        // the replacement; forwarding to the real held-fd walk must not.
        fs.renameSync(target, target + '-original');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'outside.txt'), 'not authorized');
        walked = root.walk(...params);
        return walked;
      },
      close() { order.push('close'); root.close(); },
    };
  };
  let result;
  try { result = service.estimateDirectory('p', target); }
  finally { safeRead.openConstrainedRoot = originalOpen; }
  assert.deepEqual(order, ['identity', 'intact', 'swap', 'close']);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.fileCount, 2, 'must count the original tree, not the replacement');
  assert.equal(result.totalBytes, 22);
  assert.equal(walked.ok, true);
  assert.deepEqual(walked.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path).sort(),
    ['root.txt', 'sub/file.txt']);
  assert.deepEqual(service.loadPolicy('p'), policy, 'preview must not re-authorize the replacement');
  assert.equal(service.store.listCheckpoints('p').length, 0);
  // A later preview opens the replacement object and must reject its identity.
  assertDenied(service.estimateDirectory('p', target), 'authorized_root_replaced');
});

test('estimate authorization: swap after path authorization cannot enumerate a different root fd', { skip: capSkip }, async () => {
  const { service, target } = fixture();
  service.savePolicy('p', { status: 'disabled', authorizedDirs: [target] });
  service.authorizeProject('p');
  const originalOpen = fs.openSync;
  let swapped = false;
  fs.openSync = function (file, ...args) {
    if (file === target && !swapped) {
      swapped = true;
      fs.renameSync(target, target + '-original');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'outside.txt'), 'not authorized');
    }
    return originalOpen.call(this, file, ...args);
  };
  try {
    await observeRoots((counts) => {
      assertDenied(service.estimateDirectory('p', target), 'authorized_root_replaced');
      assert.equal(swapped, true, 'must reach coordinated fd-open swap');
      assert.deepEqual(counts, { open: 1, walk: 0, read: 0 });
    });
  } finally { fs.openSync = originalOpen; }
});
