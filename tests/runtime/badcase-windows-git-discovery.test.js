const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const base = '../../build/server/domain/runtime/badcase-capture/';

// Real native NT reads and persisted authorization, no SDK or project capture.
test('Windows dependency discovery proposes one root at a time and never grants, pins, enables or archives', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-discover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'main'), work = path.join(root, 'work'), captureRoot = path.join(root, 'capture');
  fs.mkdirSync(main);
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', main], { stdio: 'pipe' });
  execFileSync('git', ['-C', main, '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
  execFileSync('git', ['-C', main, 'worktree', 'add', '-b', 'validation', work], { stdio: 'pipe' });
  const service = require(base).createBadcaseCaptureService({ captureRoot });
  const project = 'p';
  assert.equal(typeof service.discoverGitDependenciesAsync, 'function');
  assert.equal((await service.discoverGitDependenciesAsync(project, work)).reason, 'dir_not_authorized');
  service.savePolicy(project, { authorizedDirs: [work], authorizedInputDirs: [], excludedPatterns: ['.git', 'node_modules'] });
  service.authorizeProject(project);
  const policy = service.loadPolicy(project), usage = service.computeUsage(project);
  const metadataRoot = path.join(main, '.git', 'worktrees', 'work'), commonRoot = path.join(main, '.git');
  // The guided reader rejects nested repositories/submodules. Do not remove
  // markers, bypass the check, grant dependencies or archive partial results.
  const nested = path.join(work, 'sub', '.git');
  fs.mkdirSync(path.dirname(nested));
  for (const type of ['file', 'directory']) {
    if (type === 'file') fs.writeFileSync(nested, 'gitdir: ' + path.join(root, 'ungranted') + '\n');
    else fs.mkdirSync(nested);
    const rejected = await service.discoverGitDependenciesAsync(project, work);
    assert.equal(rejected.ok, false, type); assert.equal(rejected.reason, 'git_metadata_unsupported', type);
    assert.equal(Object.hasOwn(rejected, 'next'), false, type);
    assert.equal(Object.hasOwn(rejected, 'selection'), false, type);
    assert.deepEqual(service.loadPolicy(project), policy); assert.deepEqual(service.computeUsage(project), usage);
    fs.rmSync(nested, { recursive: true });
  }
  fs.rmdirSync(path.dirname(nested));
  fs.renameSync(metadataRoot, metadataRoot + '-hidden');
  const first = await service.discoverGitDependenciesAsync(project, work);
  fs.renameSync(metadataRoot + '-hidden', metadataRoot);
  assert.equal(first.ok, true, first.reason); assert.equal(first.ready, false);
  assert.equal(first.next.kind, 'metadata'); assert.equal(first.next.path, metadataRoot);
  assert.deepEqual(service.loadPolicy(project), policy); assert.deepEqual(service.computeUsage(project), usage);
  // Explicit separate authorization is required before reading commondir.
  service.savePolicy(project, { ...policy, authorizedInputDirs: [metadataRoot] }); service.authorizeProject(project);
  const second = await service.discoverGitDependenciesAsync(project, work);
  assert.equal(second.ok, true, second.reason); assert.equal(second.next.kind, 'common'); assert.equal(second.next.path, commonRoot);
  assert.deepEqual(second.selection, { worktree: work, metadataRoot, commonRoot });
  service.savePolicy(project, { ...service.loadPolicy(project), authorizedInputDirs: [metadataRoot, commonRoot] }); service.authorizeProject(project);
  const before = service.loadPolicy(project);
  const ready = await service.discoverGitDependenciesAsync(project, work);
  assert.equal(ready.ready, true, ready.reason); assert.equal(ready.next, null);
  assert.deepEqual(service.loadPolicy(project), before); assert.equal(before.status, 'disabled');
  assert.deepEqual(before.windowsExternalGit, [], 'discovery must not persist a binding');
  assert.deepEqual(service.computeUsage(project), usage);
  // Swapping an authorized metadata root cannot cause an implicit re-pin.
  fs.renameSync(metadataRoot, metadataRoot + '-old'); fs.mkdirSync(metadataRoot);
  fs.writeFileSync(path.join(metadataRoot, 'gitdir'), work + '/.git\n');
  fs.writeFileSync(path.join(metadataRoot, 'commondir'), '../..\n');
  const rejected = await service.discoverGitDependenciesAsync(project, work);
  assert.equal(rejected.ok, false); assert.deepEqual(service.loadPolicy(project), before);
});

test('discovery rejects bad pointers and never reads an ungranted external root', async () => {
  const file = path.join(__dirname, base, 'windows-git-discovery.js');
  const local = require('node:module').createRequire(file);
  const { encodeWindowsHelperRequest } = require(base + 'windows-helper');
  for (const pointer of ['gitdir: C:/meta\n', 'gitdir: \\\\host\\share\n', 'gitdir: C:relative\n', 'gitdir: C:/meta\nextra', 'gitdir: sk-SENTINELabcdefghijk', '\ufeffgitdir: C:/meta\n']) {
    let reads = 0, scopeOk = true;
    const exports = {};
    require('node:vm').runInNewContext(fs.readFileSync(file, 'utf8'), { exports, Buffer, structuredClone, process: { platform: 'win32' },
      require: name => name === './windows-estimate' ? { prepareWindowsMetadataScope: () => scopeOk ? { ok: true, helperPath: 'trusted',
        request: { root: 'C:\\work', excluded: ['.git', 'private'], expected: { pinned: true } } } : { ok: false, reason: 'dir_not_authorized' } }
        : name === './windows-helper' ? { encodeWindowsHelperRequest, invokeWindowsGitHelper: async (_p, _h, request) => {
          reads++; assert.equal(request.op, 'gitMetadata'); assert.equal(request.root, 'C:\\work');
          assert.deepEqual(Array.from(request.excluded), ['private']); assert.equal(request.expected.pinned, true);
          return { ok: true, entries: [{ path: '.git', type: 'file' }], files: [{ path: '.git', content: Buffer.from(pointer) }] };
        } } : name === './windows-git-input' ? { readWindowsGitMetadataInput: () => assert.fail('ungranted root read') } : local(name) }, { filename: file });
    const r = await exports.discoverWindowsGitDependencies({ policy: { authorizedInputDirs: [] } });
    if (pointer === 'gitdir: C:/meta\n') { assert.equal(r.ok, true); assert.equal(r.next.path, 'C:\\meta'); }
    else { assert.equal(r.ok, false, pointer); assert.doesNotMatch(JSON.stringify(r), /SENTINEL/); }
    assert.equal(reads, 1);
    scopeOk = false;
    assert.equal((await exports.discoverWindowsGitDependencies({})).reason, 'dir_not_authorized'); assert.equal(reads, 1);
  }
});

test('unsupported platform discovery does no authorization', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-discover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = require(base).createBadcaseCaptureService({ captureRoot: root });
  const before = service.loadPolicy('p');
  assert.equal((await service.discoverGitDependenciesAsync('p', '/repo')).reason, 'git_discovery_windows_only');
  assert.deepEqual(service.loadPolicy('p'), before);
});
