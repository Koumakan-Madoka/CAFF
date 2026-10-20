// ASCII-only Windows classification projection. Never changes native selectors.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const base = '../../build/server/domain/runtime/badcase-capture/';
const sha = b => crypto.createHash('sha1').update(b).digest();
function index(paths) {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(paths.length, 8);
  const records = paths.map(p => { const n = Buffer.from(p), b = Buffer.alloc(Math.ceil((63 + n.length) / 8) * 8);
    b.writeUInt32BE(0o100755, 24); b.writeUInt16BE(n.length, 60); n.copy(b, 62); return b; });
  const b = Buffer.concat([header, ...records]); return Buffer.concat([b, sha(b)]);
}
const identity = { volumeSerial: '1', fileId: 'a'.repeat(32), creationTime: '2' };
function fixture() {
  const entries = ['.git', '.git/info', 'Sub', 'Build'].map(p => ({ path: p, type: 'directory', size: '0', identity }));
  const files = new Map([
    ['.git/config', Buffer.from('[core]\nignorecase = true\n')], ['.git/index', index(['Tracked.LOG', 'Sub/Keep.BIN'])],
    ['.git/info/exclude', Buffer.from('*.TMP\n')], ['.gitignore', Buffer.from('*.LOG\nBUILD/\n')],
    ['Sub/.gitignore', Buffer.from('*.BIN\n')], ['tracked.log', Buffer.from('dirty')], ['Sub/keep.bin', Buffer.from('kept')],
    ['Sub/hidden.BIN', Buffer.from('excluded')],
    ['lost.LOG', Buffer.from('excluded')], ['Build/child', Buffer.from('excluded')], ['other.tmp', Buffer.from('excluded')],
    ['Include.LOG', Buffer.from('explicit')], ['new', Buffer.from('new')],
  ]);
  for (const [p, b] of files) entries.push({ path: p, type: 'file', size: String(b.length), identity });
  return { entries, files };
}
function harness(f = fixture(), replace = source => source) {
  const filename = path.resolve(__dirname, base, 'windows-git-candidate.js'), local = require('node:module').createRequire(filename), exports = {};
  const ops = [], selectors = [];
  const metadata = () => ({ ok: true, identity, entries: f.entries,
    files: [...f.files].filter(([p]) => p.startsWith('.git/') || p.split('/').at(-1) === '.gitignore')
      .map(([p, b]) => ({ path: p, content: b, size: String(b.length), sha256: crypto.createHash('sha256').update(b).digest('hex'), identity })) });
  vm.runInNewContext(replace(fs.readFileSync(filename, 'utf8')), { exports, Buffer, Map, Set, structuredClone,
    require: id => id === './windows-estimate' ? { prepareWindowsMetadataScope: () => ({ ok: true, helperPath: 'fixed',
      request: { version: 1, op: 'estimate', root: 'C:/work', expected: identity, excluded: [] } }) }
      : id === './windows-helper' ? { ...local(id), invokeWindowsGitHelper: async (_p, _h, req) => {
        ops.push(req.op); if (req.op === 'gitMetadata') return metadata();
        selectors.push([...req.paths]);
        return { ok: true, entries: f.entries.filter(e => e.path !== '.git' && !e.path.startsWith('.git/')),
          files: req.paths.map(p => { const b = f.files.get(p); assert.ok(b, 'must read exact disk spelling'); return {
            path: p, size: String(b.length), content: b, sha256: crypto.createHash('sha256').update(b).digest('hex'), identity }; }) };
      } } : local(id),
  }, { filename });
  return { ops, selectors, run: () => exports.readWindowsGitFileCandidateAsync({ policy: { includedIgnoredPatterns: ['Include.LOG'] } }) };
}

test('config ignorecase is opt-in, strict booleans, default Linux contract unchanged', () => {
  const { parseGitConfigSubset: parse } = require(base + 'git-classify');
  for (const value of ['true', 'TRUE', 'yes', 'on', '1', '"true" # comment', 'true ; comment']) {
    const text = `[core]\nignorecase = ${value}\n`;
    assert.equal(parse(text).verified, false);
    const cfg = parse(text, { allowIgnoreCase: true }); assert.equal(cfg.verified, true, value); assert.equal(cfg.ignoreCase, true, value);
  }
  assert.deepEqual(parse(''), { objectFormat: '', excludesFile: '', hasInclude: false, verified: true });
  for (const text of ['[core]\nignorecase = perhaps\n', '[core]\nignorecase\n', '[core]\nignorecase = true\nsparsecheckout = true\n',
    '[extensions]\nworktreeConfig = true\n', '[core]\nignorecase = tr\\ue\n']) assert.equal(parse(text, { allowIgnoreCase: true }).verified, false, text);
  assert.equal(parse('[core]\nignorecase = true\nignorecase = false\n', { allowIgnoreCase: true }).ignoreCase, false);
});

test('case-insensitive classification keeps tracked mode and canonical disk spelling; policy include remains literal', async () => {
  const h = harness(), result = await h.run(); assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.selectors, [['.gitignore', 'Include.LOG', 'Sub/.gitignore', 'Sub/keep.bin', 'new', 'tracked.log']]);
  assert.equal(result.files['tracked.log'].mode, 0o100755); assert.equal(result.files['Sub/keep.bin'].mode, 0o100755);
  assert.equal(result.files['Include.LOG'].mode, 0o100644);
  assert.equal(result.files['Tracked.LOG'], undefined); assert.equal(result.files['Sub/Keep.BIN'], undefined);
  assert.equal(result.complete, false); assert.equal(result.strictEvalEligible, false); assert.equal(result.captureAvailable, false);
  assert.ok(result.limitations.includes('windows_ignorecase_ascii_projection'));
  assert.deepEqual(h.ops, ['gitMetadata', 'selectedSnapshot', 'gitMetadata']);
});

test('Git template and Unicode comments do not become active casefold rules', async () => {
  const f = fixture();
  f.files.set('.git/info/exclude', Buffer.from('# *.[oa]\r\n# 中文说明 [A-z]\n*.TMP\n'));
  f.files.set('.gitignore', Buffer.from('# 中文说明 [A-z]\n*.LOG\nBUILD/\n'));
  const h = harness(f), result = await h.run();
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(h.selectors, [['.gitignore', 'Include.LOG', 'Sub/.gitignore', 'Sub/keep.bin', 'new', 'tracked.log']]);
  assert.deepEqual(h.ops, ['gitMetadata', 'selectedSnapshot', 'gitMetadata']);
});

test('ambiguous case paths, unsupported Unicode and mis-cased ignore source reject before ordinary reads', async () => {
  for (const kind of ['indexCollision', 'indexParentCollision', 'deepIndex', 'treeCollision', 'treeParentCollision', 'unicodeIndex', 'unicodeTree', 'unicodeIgnore', 'unicodeCasefold', 'bracketIgnore', 'escapedComment', 'indentedComment', 'ignoreAlias']) {
    const f = fixture();
    if (kind === 'indexCollision') f.files.set('.git/index', index(['Tracked.LOG', 'tracked.log']));
    if (kind === 'indexParentCollision') f.files.set('.git/index', index(['Sub/a', 'sub/b']));
    if (kind === 'deepIndex') f.files.set('.git/index', index(['x/'.repeat(64) + 'leaf']));
    if (kind === 'treeCollision') f.entries.push({ path: 'TRACKED.log', type: 'file' });
    if (kind === 'treeParentCollision') f.entries.push({ path: 'sub/other', type: 'file' });
    if (kind === 'unicodeIndex') f.files.set('.git/index', index(['caf\u00e9']));
    if (kind === 'unicodeTree') f.entries.push({ path: 'caf\u00e9', type: 'file' });
    if (kind === 'unicodeIgnore') f.files.set('.gitignore', Buffer.from('caf\u00e9\n'));
    if (kind === 'unicodeCasefold') f.files.set('.gitignore', Buffer.from('\u212A.log\n'));
    if (kind === 'bracketIgnore') f.files.set('.gitignore', Buffer.from('[A-z]*\n'));
    if (kind === 'escapedComment') f.files.set('.gitignore', Buffer.from('\\# [A-z]\n'));
    if (kind === 'indentedComment') f.files.set('.gitignore', Buffer.from(' # [A-z]\n'));
    if (kind === 'ignoreAlias') {
      // Replace (do not duplicate) the source: no folded-name collision may
      // mask the independent guard for metadata the native reader won't read.
      f.entries.find(e => e.path === '.gitignore').path = '.GITIGNORE';
      f.files.set('.GITIGNORE', f.files.get('.gitignore')); f.files.delete('.gitignore');
    }
    const h = harness(f), result = await h.run(); assert.equal(result.ok, false, kind); assert.equal(result.reason, 'git_ignorecase_unverified', kind); assert.deepEqual(h.ops, ['gitMetadata'], kind);
    assert.equal(Object.hasOwn(result, 'files'), false); assert.equal(Object.hasOwn(result, 'blobs'), false);
  }
  const atLimit = fixture(); atLimit.files.set('.git/index', index(['x/'.repeat(63) + 'leaf']));
  assert.equal((await harness(atLimit).run()).ok, true, '64 components remain within the bounded projection');
});

test('projection item/byte caps refuse before reads at injected small limits (not real large-input evidence)', async () => {
  const f = fixture(), count = f.entries.length;
  const countCap = limit => source => source.replace('paths.length > 100000', `paths.length > ${limit}`);
  assert.equal((await harness(f, countCap(count)).run()).ok, true);
  const overCount = harness(f, countCap(count - 1));
  assert.equal((await overCount.run()).reason, 'git_ignorecase_unverified'); assert.deepEqual(overCount.ops, ['gitMetadata']);
  const name = 'x'.repeat(200) + '/' + 'y'.repeat(200); f.files.set('.git/index', index([name]));
  const byteCap = limit => source => source.replace('Buffer.byteLength(p) > 32768', `Buffer.byteLength(p) > ${limit}`);
  assert.equal((await harness(f, byteCap(401)).run()).ok, true);
  const overBytes = harness(f, byteCap(400));
  assert.equal((await overBytes.run()).reason, 'git_ignorecase_unverified'); assert.deepEqual(overBytes.ops, ['gitMetadata']);
});

test('case-sensitive Windows path remains unchanged and supports Unicode without folding', async () => {
  const f = fixture(); f.files.set('.git/config', Buffer.from('[core]\nignorecase = false\n'));
  f.files.set('.git/index', index(['caf\u00e9'])); f.entries.push({ path: 'caf\u00e9', type: 'file', size: '1', identity }); f.files.set('caf\u00e9', Buffer.from('x'));
  const h = harness(f), result = await h.run(); assert.equal(result.ok, true, result.reason);
  assert.equal(result.files['caf\u00e9'].mode, 0o100755); assert.equal(result.files['tracked.log'].mode, 0o100644);
  assert.equal(result.limitations.includes('windows_ignorecase_ascii_projection'), false);
});

test('bounded ASCII wildcard, negation, directory and nested rules match real Git casefold oracle', async t => {
  const os = require('node:os'), { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-casefold-oracle-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'absent-global'), GIT_TEMPLATE_DIR: '' };
  const work = path.join(root, 'repo'); fs.mkdirSync(work);
  const git = (...args) => execFileSync('git', ['-C', work, ...args], { env, encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('config', 'core.ignorecase', 'true');
  const f = fixture();
  for (const [p, b] of f.files) {
    if (p.startsWith('.git/')) continue;
    fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true }); fs.writeFileSync(path.join(work, p), b);
  }
  fs.mkdirSync(path.join(work, '.git/info'), { recursive: true }); fs.writeFileSync(path.join(work, '.git/info/exclude'), f.files.get('.git/info/exclude'));
  git('add', '-f', 'tracked.log', 'Sub/keep.bin'); f.files.set('.git/index', fs.readFileSync(path.join(work, '.git/index')));
  for (const pattern of ['*.LoG\n', 'SuB/*.bIn\n', 'bUiLd/\n', '*.LOG\n!LoSt.lOg\n', '/BuIlD/**\n', '**/*.TMP\n', 'l?st.LOG\n', 'BUILD/\n!BUILD/child\n']) {
    const bytes = Buffer.from(pattern); f.files.set('.gitignore', bytes); fs.writeFileSync(path.join(work, '.gitignore'), bytes);
    const expected = [...new Set(git('ls-files', '-c', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean).concat('Include.LOG'))].sort();
    const h = harness(f), result = await h.run(); assert.equal(result.ok, true, result.reason);
    assert.deepEqual(Object.keys(result.files).sort(), expected, pattern);
  }
});

test('native NTFS case-only rename: Git oracle, service fresh/resume publication and two restores (fixture only)',
  { skip: process.platform !== 'win32' }, async t => {
  const os = require('node:os'), { execFileSync } = require('node:child_process');
  const { createBadcaseCaptureService } = require(base), { createCaptureStore } = require(base + 'capture-store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-ignorecase-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'), sessions = path.join(root, 'sessions'), captureRoot = path.join(root, 'capture');
  fs.mkdirSync(work); fs.mkdirSync(sessions);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'absent-global'), GIT_TEMPLATE_DIR: '' };
  const git = (...args) => execFileSync('git', ['-C', work, ...args], { env, encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('config', 'core.ignorecase', 'true');
  fs.mkdirSync(path.join(work, 'Sub')); fs.writeFileSync(path.join(work, 'Tracked.LOG'), 'original');
  fs.writeFileSync(path.join(work, 'Sub/Keep.BIN'), 'original');
  fs.writeFileSync(path.join(work, '.gitignore'), '*.LOG\nBUILD/\n'); fs.writeFileSync(path.join(work, 'Sub/.gitignore'), '*.BIN\n');
  git('add', '-f', 'Tracked.LOG', 'Sub/Keep.BIN', '.gitignore', 'Sub/.gitignore');
  // Two-step native rename proves the disk name actually changed on NTFS.
  for (const [from, to] of [['Tracked.LOG', 'tracked.log'], ['Sub/Keep.BIN', 'Sub/keep.bin']]) {
    fs.renameSync(path.join(work, from), path.join(work, 'rename-temp')); fs.renameSync(path.join(work, 'rename-temp'), path.join(work, to));
    fs.writeFileSync(path.join(work, to), 'dirty');
  }
  assert.ok(fs.readdirSync(work).includes('tracked.log')); assert.ok(fs.readdirSync(path.join(work, 'Sub')).includes('keep.bin'));
  fs.writeFileSync(path.join(work, 'ignored.log'), 'IGNORE_SENTINEL'); fs.writeFileSync(path.join(work, 'Include.LOG'), 'include');
  fs.mkdirSync(path.join(work, 'Build')); fs.writeFileSync(path.join(work, 'Build/child'), 'IGNORE_SENTINEL');
  fs.writeFileSync(path.join(work, 'other.tmp'), 'IGNORE_SENTINEL'); fs.writeFileSync(path.join(work, 'new'), 'new');
  fs.writeFileSync(path.join(work, 'Sub/hidden.BIN'), 'IGNORE_SENTINEL');
  fs.writeFileSync(path.join(work, 'secret'), 'sk-SENTINELabcdefghijk');
  fs.mkdirSync(path.join(work, '.git/info'), { recursive: true });
  fs.writeFileSync(path.join(work, '.git/info/exclude'), '*.TMP\r\n');
  const service = createBadcaseCaptureService({ captureRoot });
  service.savePolicy('p', { authorizedDirs: [work], authorizedInputDirs: [sessions], excludedPatterns: [], includedIgnoredPatterns: ['Include.LOG'] });
  const policy = service.authorizeProject('p'); assert.equal(policy.status, 'disabled');
  const sessionBytes = Buffer.from([{ type: 'session', version: 3, id: 's', cwd: work },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'question', timestamp: 1 } }].map(x => JSON.stringify(x)).join('\r\n') + '\r\n');
  const sessionPath = path.join(sessions, 'turn.jsonl'); fs.writeFileSync(sessionPath, sessionBytes);
  const common = { projectId: 'p', conversationId: 'fixture-c', turnId: 'fixture-t', agentId: 'fixture-a', targetDir: work, prompt: 'question', sessionPath,
    runConfig: { provider: 'test', model: 'test', skillIds: [], conversationSkillIds: [] } };
  assert.equal((await service.captureTurnCheckpoint({ ...common, deliveryMode: 'fresh' })).reason, 'policy_not_enabled');
  // Explicit fixture-only writer, NOT management enable or a real user project.
  service.store.savePolicy({ ...policy, status: 'enabled' });
  const oracle = git('ls-files', '-c', '-o', '--exclude-standard', '-z').split('\0').filter(Boolean).concat('Include.LOG').map(p => p.toLowerCase()).sort();
  const started = performance.now();
  for (const deliveryMode of ['fresh', 'resume']) {
    const result = await service.captureTurnCheckpoint({ ...common, deliveryMode, harness: {
      configSnapshot: { toolBridgeEnabled: true, deliveryMode, piVersion: '0.85.1' }, skillSnapshots: [] } });
    assert.equal(result.captured, true, result.reason);
    const reopened = createCaptureStore({ captureRoot }), cp = reopened.loadCheckpoint('p', result.checkpointId);
    assert.deepEqual(Object.keys(cp.files).map(p => p.toLowerCase()).sort(), oracle);
    assert.deepEqual(Object.keys(cp.files).sort(), ['.gitignore', 'Include.LOG', 'Sub/.gitignore', 'Sub/keep.bin', 'new', 'secret', 'tracked.log']);
    assert.equal(cp.files['tracked.log'].mode, 0o100644); assert.equal(cp.files['Sub/keep.bin'].mode, 0o100644);
    assert.equal(cp.replayInput.deliveryMode, deliveryMode); assert.equal(cp.replayInput.complete, false); assert.equal(cp.strictEvalEligible, false);
    assert.ok(cp.integrity.knownLimitations.includes('windows_ignorecase_ascii_projection'));
    if (deliveryMode === 'resume') assert.deepEqual(reopened.readBlob('p', cp.replayInput.sessionBlobHash), sessionBytes);
    assert.equal(reopened.hasBlob('p', crypto.createHash('sha256').update('sk-SENTINELabcdefghijk').digest('hex')), false);
    const lists = [];
    for (const n of [1, 2]) {
      const targetDir = path.join(root, `${deliveryMode}-${n}`), restored = service.restoreCheckpoint({ projectId: 'p', checkpointId: cp.checkpointId, targetDir });
      assert.equal(restored.ok, true, restored.reason); lists.push(restored.restoredFiles);
      assert.equal(fs.readFileSync(path.join(targetDir, 'tracked.log'), 'utf8'), 'dirty');
      assert.equal(fs.readFileSync(path.join(targetDir, 'Sub/keep.bin'), 'utf8'), 'dirty');
      assert.equal(fs.existsSync(path.join(targetDir, 'secret')), false); assert.equal(fs.existsSync(path.join(targetDir, 'Build')), false);
    }
    assert.deepEqual(lists[0], lists[1]);
  }
  const before = service.store.listCheckpoints('p').length; fs.writeFileSync(path.join(work, 'caf\u00e9'), 'unverified');
  assert.equal((await service.captureTurnCheckpoint({ ...common, deliveryMode: 'fresh' })).reason, 'git_ignorecase_unverified');
  assert.equal(service.store.listCheckpoints('p').length, before);
  t.diagnostic(JSON.stringify({ fixtureOnly: true, twoModesMs: Math.round(performance.now() - started),
    usageBytes: service.computeUsage('p').totalBytes, managementEnable: false }));
});
