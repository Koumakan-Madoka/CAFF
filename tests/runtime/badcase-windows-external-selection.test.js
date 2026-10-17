const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const modulePath = path.resolve(__dirname, base, 'windows-external-selection.js');
const roots = { worktree: 'C:/work', metadataRoot: 'C:/main/.git/worktrees/work', commonRoot: 'C:/main/.git' };
const scope = { authorizedDirs: [roots.worktree], authorizedInputDirs: [roots.metadataRoot, roots.commonRoot] };
const api = () => { assert.equal(fs.existsSync(modulePath), true, 'selection module required'); return require(modulePath); };
const clone = x => structuredClone(x);

test('external selections are bounded, exact-scope and per-worktree; no implicit roots or inherited selection', () => {
  const { normalizeWindowsExternalGitSelection: normalize, selectWindowsExternalGit: select } = api();
  assert.deepEqual(normalize(undefined, scope), []);
  const selected = normalize([roots], scope);
  assert.deepEqual(selected, [{ worktree: 'C:\\work', metadataRoot: 'C:\\main\\.git\\worktrees\\work', commonRoot: 'C:\\main\\.git' }]);
  assert.deepEqual(select({ ...scope, windowsExternalGit: selected }, 'c:/WORK'), { metadataRoot: selected[0].metadataRoot, commonRoot: selected[0].commonRoot });
  assert.equal(select({ ...scope, windowsExternalGit: selected }, 'C:/work/sub'), undefined);
  assert.equal(select({ ...scope, windowsExternalGit: selected }, 'C:/work2'), undefined);
  const second = { ...roots, worktree: 'D:/other', metadataRoot: 'C:/main/.git/worktrees/other' };
  const policy = { authorizedDirs: [roots.worktree, second.worktree], authorizedInputDirs: [...scope.authorizedInputDirs, second.metadataRoot] };
  const both = normalize([roots, second], policy);
  assert.equal(select({ ...policy, windowsExternalGit: both }, second.worktree).metadataRoot, path.win32.resolve(second.metadataRoot));
  for (const bad of [null, {}, [null], [{ ...roots, extra: true }], [{ ...roots, worktree: '' }],
    [{ ...roots, worktree: 'C:work' }], [{ ...roots, metadataRoot: '//host/share' }], [{ ...roots, commonRoot: 'C:/main\0/..' }],
    [{ ...roots, commonRoot: roots.metadataRoot }], [{ ...roots, metadataRoot: 'C:/work/meta' }], [roots, { ...roots, worktree: 'c:/WORK' }], Array(33).fill(roots)]) {
    assert.throws(() => normalize(bad, scope), e => e.code === 'capture_external_git_selection_invalid');
  }
  for (const name of ['metadataRoot', 'commonRoot']) {
    const nested = { ...roots, [name]: 'C:/work/meta' };
    assert.throws(() => normalize([nested], { ...scope, authorizedInputDirs: [nested.metadataRoot, nested.commonRoot] }),
      e => e.code === 'capture_external_git_selection_invalid', 'even an independently granted root inside the worktree is unsupported');
  }
  for (const control of ['\x00', '\x1f', '\x7f', '\ufeff']) {
    const alias = `${roots.commonRoot}/${control}/..`;
    assert.equal(path.win32.resolve(alias), path.win32.resolve(roots.commonRoot));
    assert.throws(() => normalize([{ ...roots, commonRoot: alias }], scope), e => e.code === 'capture_external_git_selection_invalid');
  }
  for (const changed of [{ authorizedDirs: ['C:/'] }, { authorizedInputDirs: ['C:/main'] }, { authorizedInputDirs: [roots.commonRoot] }]) {
    assert.throws(() => normalize([roots], { ...scope, ...changed }), e => e.code === 'capture_external_git_selection_invalid');
  }
});

test('Windows facade persists explicit selection, retains original pins, disables on change, survives restart', { skip: process.platform !== 'win32' }, t => {
  const { createBadcaseCaptureService } = require(base);
  const { pinKey } = require(base + 'capture-policy');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-selection-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'), meta = path.join(root, 'meta'), common = path.join(root, 'common'), other = path.join(root, 'other');
  for (const p of [work, meta, common, other]) fs.mkdirSync(p);
  const captureRoot = path.join(root, 'capture'), service = createBadcaseCaptureService({ captureRoot });
  const selection = [{ worktree: work, metadataRoot: meta, commonRoot: common }];
  service.savePolicy('p', { authorizedDirs: [work], authorizedInputDirs: [meta, common, other], windowsExternalGit: selection });
  const pinned = service.authorizeProject('p'); assert.equal(pinned.windowsExternalGit.length, 1); assert.equal(pinned.status, 'disabled');
  service.store.savePolicy({ ...pinned, status: 'enabled' }); // test-only: management gate remains closed
  const unchanged = service.savePolicy('p', { ...pinned, status: 'enabled', stagingRetentionDays: 8 });
  assert.equal(unchanged.status, 'enabled');
  const oldPin = pinned.authorizedInputPins[pinKey(meta)];
  fs.renameSync(meta, path.join(root, 'old-meta')); fs.mkdirSync(meta);
  const saved = service.savePolicy('p', { ...unchanged, windowsExternalGit: [{ ...selection[0], metadataRoot: other }],
    authorizedInputPins: { [pinKey(meta)]: { realpath: meta, identity: { fileId: 'forged' } } } });
  assert.equal(saved.status, 'disabled'); assert.deepEqual(saved.authorizedInputPins[pinKey(meta)], oldPin);
  const restarted = createBadcaseCaptureService({ captureRoot }); assert.deepEqual(restarted.loadPolicy('p'), saved);
  const before = fs.readFileSync(path.join(captureRoot, 'projects/p/policy.json'));
  assert.throws(() => restarted.savePolicy('p', { ...saved, windowsExternalGit: [{ ...selection[0], metadataRoot: path.join(root, 'ungranted') }] }),
    e => e.code === 'capture_external_git_selection_invalid');
  assert.deepEqual(fs.readFileSync(path.join(captureRoot, 'projects/p/policy.json')), before);
  const cleared = restarted.savePolicy('p', { ...saved, windowsExternalGit: [] }); assert.equal(cleared.status, 'disabled');
  assert.deepEqual(cleared.windowsExternalGit, []);
});
