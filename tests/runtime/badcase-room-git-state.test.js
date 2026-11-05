const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { encodeWindowsHelperRequest, parseWindowsHelperResponse } = require(base + 'windows-helper');
const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
test('Room Git-state is a separate bounded protocol, not an expansion of classification-file authority', () => {
  for (const p of ['.git', 'HEAD', 'packed-refs', 'refs/heads/room/test']) {
    const request = { version: 1, op: 'gitState', root: 'C:/repo', expected: identity, path: p };
    assert.ok(encodeWindowsHelperRequest(request), p);
    const content = Buffer.from('safe'), header = { version: 1, ok: true, identity, file: { path: p,
      identity, size: '4', sha256: crypto.createHash('sha256').update(content).digest('hex') } };
    assert.equal(parseWindowsHelperResponse(Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), content]), request).ok, true);
  }
  for (const p of ['refs/heads/../private', 'refs/remotes/origin/main', 'objects/a', 'hooks/pre-commit', 'config', 'HEAD.lock', '../HEAD']) {
    assert.equal(encodeWindowsHelperRequest({ version: 1, op: 'gitState', root: 'C:/repo', expected: identity, path: p }), null, p);
  }
  assert.equal(encodeWindowsHelperRequest({ version: 1, op: 'gitInput', root: 'C:/repo', expected: identity, path: 'HEAD' }), null);
});

test('native Room Git-state verifies original pin, refuses aliases/oversize and never follows a ref itself', { skip: process.platform !== 'win32' }, async t => {
  const { createBadcaseCaptureService } = require(base + 'index');
  const { readWindowsGitStateInput } = require(base + 'windows-git-input');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-room-state-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'metadata'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'HEAD'), 'ref: refs/heads/room/test\n');
  const service = createBadcaseCaptureService({ captureRoot: path.join(temp, 'capture') });
  service.savePolicy('p', { authorizedInputDirs: [root] }); const policy = service.authorizeProject('p');
  const opts = { captureRoot: service.captureRoot, metadataRoot: root, metadataPath: 'HEAD', policy };
  const result = await readWindowsGitStateInput(opts); assert.equal(result.ok, true, result.reason);
  assert.equal(result.content.toString(), 'ref: refs/heads/room/test\n');
  assert.equal((await readWindowsGitStateInput({ ...opts, metadataPath: 'head' })).ok, false);
  assert.equal((await readWindowsGitStateInput({ ...opts, policy: { ...policy, authorizedInputPins: {} } })).ok, false);
  fs.writeFileSync(path.join(root, 'packed-refs'), Buffer.alloc(1024 * 1024 + 1, 120));
  assert.equal((await readWindowsGitStateInput({ ...opts, metadataPath: 'packed-refs' })).ok, false);
});
