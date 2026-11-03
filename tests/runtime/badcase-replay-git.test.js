// Synthetic Git repositories only; never models, real credentials or live data.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fake = 'sk-' + 'SYNTHETIC_GIT_BASELINE_ONLY_123456';
const opaque = 'opaque-unit-test-value-without-sentinel';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-git-test-')), sourceRoot = path.join(root, 'source'), restored = path.join(root, 'restored');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(restored); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (root, ...args) => cp.execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = message => { git(sourceRoot, 'add', '-A'); git(sourceRoot, '-c', 'user.name=GPT', '-c', 'user.email=gpt@caff.local', 'commit', '-q', '-m', message); };
  git(sourceRoot, 'init', '-q');
  fs.writeFileSync(path.join(sourceRoot, 'old-only.txt'), 'old history must not be copied'); commit('old history');
  fs.unlinkSync(path.join(sourceRoot, 'old-only.txt'));
  const baseline = { 'secret.txt': 'fixture=' + fake + '\n', 'opaque.txt': opaque + '\n', 'dirty.txt': 'baseline bytes\n', 'deleted.txt': 'deleted before turn\n', 'excluded.txt': 'not in authorized snapshot\n' };
  for (const [name, text] of Object.entries(baseline)) fs.writeFileSync(path.join(sourceRoot, name), text);
  commit('recorded head'); const head = git(sourceRoot, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(sourceRoot, 'dirty.txt'), 'unrelated live source edit after capture\n');
  const captured = { 'secret.txt': 'fixture=[*]\n', 'opaque.txt': '[*]\n', 'dirty.txt': 'captured dirty bytes\n', 'untracked.txt': 'captured untracked bytes\n' };
  const input = { kind: 'prepared-caff-turn-v1', files: Object.entries(captured).map(([path, text]) => ({ path, base64: Buffer.from(text).toString('base64'), sha256: sha(text) })), deletions: ['deleted.txt'] };
  const configBefore = fs.readFileSync(path.join(sourceRoot, '.git/config')), statusBefore = git(sourceRoot, 'status', '--porcelain');
  const install = snapshot => { for (const f of [...input.files, ...snapshot.gitFiles]) { const dest = path.join(restored, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from(f.base64, 'base64')); } };
  return { root, sourceRoot, restored, head, git, input, install, configBefore, statusBefore };
}
function api() { return require('../../scripts/badcase-capture/replay-git.cjs'); }

test('no known-value hit preserves exact recorded HEAD/history and deliberately leaves pattern-only history unchanged', t => {
  const f = fixture(t), snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input, { knownValues: ['unrelated-synthetic-value'] });
  f.install(snapshot);
  assert.equal(snapshot.report.kind, 'preserved-head-git-v1'); assert.equal(snapshot.report.historyIncluded, true);
  assert.equal(snapshot.report.headIdenticalToSource, true); assert.equal(snapshot.report.restoredHead, f.head);
  assert.equal(f.git(f.restored, 'rev-parse', 'HEAD').trim(), f.head);
  assert.equal(f.git(f.restored, 'log', '--format=raw'), f.git(f.sourceRoot, 'log', '--format=raw', f.head));
  assert.equal(f.git(f.restored, 'show', 'HEAD:secret.txt'), 'fixture=' + fake + '\n');
  assert.equal(fs.readFileSync(path.join(f.restored, 'secret.txt'), 'utf8'), 'fixture=[*]\n');
  assert.equal(f.git(f.restored, 'show', 'HEAD~1:old-only.txt'), 'old history must not be copied');
  assert.equal(snapshot.report.historyScan.matchCount, 0); assert.deepEqual(snapshot.report.historyScan.matchedBlobHashes, []);
  assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot, '.git/config')), f.configBefore);
  assert.equal(f.git(f.sourceRoot, 'status', '--porcelain'), f.statusBefore);
  const again = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input, { knownValues: ['unrelated-synthetic-value'] });
  assert.deepEqual(again.gitFiles, snapshot.gitFiles);
});
test('known key in a deleted historical blob forces sanitized no-history fallback, even outside captured paths', t => {
  const f = fixture(t), value = 'old history must not be copied';
  const oldBlob = f.git(f.sourceRoot, 'rev-parse', f.head + '~1:old-only.txt').trim();
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input, { knownValues: [value] }); f.install(snapshot);
  assert.equal(snapshot.report.historyIncluded, false); assert.notEqual(snapshot.report.restoredHead, f.head);
  assert.equal(snapshot.report.fallbackReason, 'known_key_in_reachable_blob');
  assert.equal(snapshot.report.historyScan.matchCount, 1); assert.deepEqual(snapshot.report.historyScan.matchedBlobHashes, [oldBlob]);
  assert.equal(f.git(f.restored, 'rev-list', '--count', 'HEAD').trim(), '1');
  assert.throws(() => f.git(f.restored, 'cat-file', '-t', oldBlob));
  assert.equal(JSON.stringify(snapshot.report).includes(value), false);
});
test('unreachable/future objects and other source refs are neither scanned nor copied into recorded history', t => {
  const f = fixture(t), value = 'synthetic-future-value-do-not-copy';
  fs.writeFileSync(path.join(f.sourceRoot, 'future.txt'), value); f.git(f.sourceRoot, 'add', 'future.txt');
  f.git(f.sourceRoot, '-c', 'user.name=GPT', '-c', 'user.email=gpt@caff.local', 'commit', '-q', '-m', 'future commit');
  const future = f.git(f.sourceRoot, 'rev-parse', 'HEAD').trim();
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input, { knownValues: [value] }); f.install(snapshot);
  assert.equal(snapshot.report.historyIncluded, true); assert.equal(snapshot.report.historyScan.matchCount, 0);
  assert.equal(f.git(f.restored, 'rev-parse', 'HEAD').trim(), f.head); assert.throws(() => f.git(f.restored, 'cat-file', '-t', future));
});
test('history scanner catches known values in binary blobs and repeated/chunk-boundary bytes without recording values', t => {
  const f = fixture(t), value = 'opaque-synthetic-binary-key-' + 'x'.repeat(300);
  const bytes = Buffer.concat([Buffer.alloc(65530), Buffer.from(value), Buffer.alloc(65530), Buffer.from(value)]);
  fs.writeFileSync(path.join(f.sourceRoot, 'binary.dat'), bytes); f.git(f.sourceRoot, 'add', 'binary.dat');
  f.git(f.sourceRoot, '-c', 'user.name=GPT', '-c', 'user.email=gpt@caff.local', 'commit', '-q', '-m', 'binary fixture');
  const head = f.git(f.sourceRoot, 'rev-parse', 'HEAD').trim(), blob = f.git(f.sourceRoot, 'rev-parse', 'HEAD:binary.dat').trim();
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head }, f.input, { knownValues: [value] });
  assert.equal(snapshot.report.historyIncluded, false); assert.equal(snapshot.report.historyScan.matchCount, 2);
  assert.deepEqual(snapshot.report.historyScan.matchedBlobHashes, [blob]); assert.equal(JSON.stringify(snapshot.report).includes(value), false);
});
test('history hit counts include overlapping occurrences deterministically across stream chunk boundaries', t => {
  const f = fixture(t), size = 131075, known = 'aaaaa';
  fs.writeFileSync(path.join(f.sourceRoot, 'repeated.bin'), Buffer.alloc(size, 0x61)); f.git(f.sourceRoot, 'add', 'repeated.bin');
  f.git(f.sourceRoot, '-c', 'user.name=GPT', '-c', 'user.email=gpt@caff.local', 'commit', '-q', '-m', 'overlap fixture');
  const head = f.git(f.sourceRoot, 'rev-parse', 'HEAD').trim();
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head }, f.input, { knownValues: [known] });
  assert.equal(snapshot.report.historyScan.matchCount, size - known.length + 1);
});
test('sanitized Git has exactly one new root commit; git show cannot recover sentinel or explicitly known values', t => {
  const f = fixture(t), snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input, { knownValues: [opaque] });
  f.install(snapshot);
  assert.equal(f.git(f.restored, 'rev-list', '--all', '--count').trim(), '1');
  assert.notEqual(f.git(f.restored, 'rev-parse', 'HEAD').trim(), f.head);
  assert.equal(f.git(f.restored, 'show', 'HEAD:secret.txt'), 'fixture=[*]\n');
  assert.equal(f.git(f.restored, 'show', 'HEAD:opaque.txt'), '[*]\n');
  const allObjects = f.git(f.restored, 'cat-file', '--batch-all-objects', '--batch');
  assert.equal(allObjects.includes(fake), false); assert.equal(allObjects.includes(opaque), false); assert.equal(allObjects.includes('old history must not be copied'), false);
  assert.equal(snapshot.report.sourceHead, f.head); assert.equal(snapshot.report.restoredHead, f.git(f.restored, 'rev-parse', 'HEAD').trim());
  assert.equal(snapshot.report.historyIncluded, false); assert.equal(snapshot.report.headIdenticalToSource, false);
  assert.deepEqual(snapshot.report.redactedFiles.map(f => f.path).sort(), ['opaque.txt', 'secret.txt']);
  assert.equal(snapshot.report.omittedSourceFiles, 1);
  assert.doesNotThrow(() => snapshot.checkKnownValues([fake, opaque]));
});
test('recorded baseline, captured dirt/deletions/untracked files and source isolation are preserved independently', t => {
  const f = fixture(t), snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input, { knownValues: [opaque] });
  f.install(snapshot);
  assert.equal(f.git(f.restored, 'show', 'HEAD:dirty.txt'), 'baseline bytes\n');
  const status = f.git(f.restored, 'status', '--porcelain');
  assert.match(status, / M dirty\.txt/); assert.match(status, / D deleted\.txt/); assert.match(status, /\?\? untracked\.txt/);
  assert.throws(() => f.git(f.restored, 'show', 'HEAD:excluded.txt'));
  assert.deepEqual(fs.readFileSync(path.join(f.sourceRoot, '.git/config')), f.configBefore);
  assert.equal(f.git(f.sourceRoot, 'status', '--porcelain'), f.statusBefore);
  assert.equal(f.git(f.sourceRoot, 'rev-parse', 'HEAD').trim(), f.head);
  const again = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input, { knownValues: [opaque] });
  assert.deepEqual(again.report, snapshot.report); assert.deepEqual(again.gitFiles, snapshot.gitFiles, 'deterministic re-preparation does not drift input hashes');
});
test('Git baseline preserves raw blob bytes/executable mode without source filters or newline transformations', t => {
  const f = fixture(t), bytes = Buffer.from('mixed\r\nline endings\n');
  fs.writeFileSync(path.join(f.sourceRoot, 'bytes.bin'), bytes);
  fs.writeFileSync(path.join(f.sourceRoot, '.gitattributes'), 'bytes.bin text eol=crlf filter=trap\n');
  f.git(f.sourceRoot, 'add', '.gitattributes');
  const oid = f.git(f.sourceRoot, 'hash-object', '-w', '--no-filters', 'bytes.bin').trim();
  f.git(f.sourceRoot, 'update-index', '--add', '--cacheinfo', '100755', oid, 'bytes.bin');
  f.git(f.sourceRoot, '-c', 'user.name=GPT', '-c', 'user.email=gpt@caff.local', 'commit', '-q', '-m', 'raw blob fixture');
  const head = f.git(f.sourceRoot, 'rev-parse', 'HEAD').trim();
  f.git(f.sourceRoot, 'config', 'filter.trap.clean', 'printf SHOULD_NOT_EXECUTE');
  for (const [name, text] of [['bytes.bin', bytes], ['.gitattributes', Buffer.from('bytes.bin text eol=crlf filter=trap\n')]]) f.input.files.push({ path: name, base64: text.toString('base64'), sha256: sha(text) });
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head }, f.input, { knownValues: [opaque] }); f.install(snapshot);
  assert.equal(f.git(f.restored, 'show', 'HEAD:bytes.bin'), bytes.toString());
  assert.match(f.git(f.restored, 'ls-tree', 'HEAD', 'bytes.bin'), /^100755 blob /);
  assert.doesNotMatch(fs.readFileSync(path.join(f.restored, '.git/config'), 'utf8'), /trap|SHOULD_NOT_EXECUTE|remote|include/);
});
test('missing/invalid recorded heads and unauthorized paths fail closed without a live-HEAD fallback', t => {
  const f = fixture(t);
  for (const recipe of [{ sourceRoot: f.sourceRoot, head: 'HEAD' }, { sourceRoot: f.sourceRoot, head: '0'.repeat(40) },
    { sourceRoot: f.sourceRoot }, { sourceRoot: f.sourceRoot, head: f.head, extra: true }, { sourceRoot: 'relative', head: f.head }]) {
    assert.throws(() => api().prepareReplayGit(recipe, f.input), e => e.code === 'evaluation_repository_unavailable_or_invalid');
  }
  for (const bad of ['../outside', '.git/config', 'a//b', '/outside']) {
    assert.throws(() => api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, { ...f.input, files: [{ path: bad }] }));
  }
});
test('comparison preflight/staging binds the history-free Git report and refuses a late-known key before execution', async t => {
  const f = fixture(t), { prepareComparison, runComparison, formatComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  const config = { request: {}, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image: { imageId: 'sha256:' + '1'.repeat(64) },
    repeats: 1, candidateRole: 'Verify.', repository: { sourceRoot: f.sourceRoot, head: f.head },
    rules: { kind: 'read-only-files-v1', readPaths: ['dirty.txt'], absentPaths: ['deleted.txt'], requiredReplyFragments: ['literal result'] } };
  const prepare = (_q, candidate) => ({ supported: true, input: { ...f.input, prompt: candidate || 'original', sessionText: null },
    provenance: { checkpointHash: 'fixed', commonInputHash: 'fixed-common' } });
  const plan = prepareComparison(config, { prepare, knownValues: [opaque] });
  assert.equal(plan.supported, true); assert.equal(plan.summary.repository.historyIncluded, false);
  assert.deepEqual(plan.inputs.original.gitFiles, plan.inputs.candidate.gitFiles);
  const staged = require('../../scripts/badcase-capture/direct-docker.cjs').prepareDirectReplayInput(plan.inputs.original);
  const wire = JSON.parse(staged.find(f => f.path === 'replay-input.json').bytes);
  assert.equal(wire.gitFiles.length, 6); assert.ok(wire.gitFiles.every(f => f.base64 === undefined));
  assert.ok(staged.some(f => f.path.startsWith('replay-workspace/.git/objects/pack/')));
  assert.match(formatComparison({ ...plan.summary, supported: true, runs: [] }), /HEAD不同于源仓库.*无历史提交/);
  let executed = false, emitted = false;
  assert.throws(() => prepareComparison(config, { prepare }), /evaluation_known_sources_required/);
  await assert.rejects(runComparison(config, { prepare, knownValues: [], confirmed: true, readKey: () => opaque,
    stage: () => [{ path: 'probe.cjs', bytes: Buffer.from('inert') }], execute: async () => { executed = true; }, onEvent: () => { emitted = true; } }),
  e => e.code === 'evaluation_input_contains_key');
  assert.equal(executed, false); assert.equal(emitted, false);
});
test('host requires verified Git receipt matching the prepared baseline, not merely successful model text', async t => {
  const f = fixture(t), { runComparison, expectedTreeHash } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  const { prepareDirectReplayInput } = require('../../scripts/badcase-capture/direct-docker.cjs');
  const { manifestFor } = require('../../scripts/badcase-capture/pi-probe-materials.cjs');
  const config = { request: {}, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image: { imageId: 'sha256:' + '1'.repeat(64) },
    repeats: 1, candidateRole: 'Verify.', repository: { sourceRoot: f.sourceRoot, head: f.head },
    rules: { kind: 'read-only-files-v1', readPaths: ['dirty.txt'], absentPaths: ['deleted.txt'], requiredReplyFragments: ['literal result'] } };
  for (const change of ['none', 'missing', 'wrong-head', 'history']) {
    const result = await runComparison(config, { confirmed: true, knownValues: [opaque], readKey: () => 'synthetic-model-marker-not-a-real-key',
      prepare: (_q, candidate) => ({ supported: true, input: { ...f.input, prompt: candidate || 'original', sessionText: null }, provenance: { checkpointHash: 'fixed', commonInputHash: 'fixed' } }),
      stage: (_r, _d, _i, input) => [{ path: 'probe.cjs', bytes: Buffer.from('inert') }, ...prepareDirectReplayInput(input)],
      execute: async (_image, files) => {
        const m = manifestFor(files, { replayWorkspace: true }), wire = JSON.parse(files.find(f => f.path === 'replay-input.json').bytes);
        const repository = { ...wire.repository, gitAvailable: true, historyCommitCount: 1 };
        if (change === 'wrong-head') repository.restoredHead = '0'.repeat(40);
        if (change === 'history') repository.historyIncluded = true;
        return { code: 0, cleaned: true, receipt: { kind: 'direct-caff-turn-v1', success: true, inputHash: m.inputHash, runtimeHash: m.runtimeHash,
          beforeHash: expectedTreeHash(f.input), afterHash: expectedTreeHash(f.input), finalText: 'literal result', replySource: 'public',
          toolCalls: [{ name: 'read', isError: false, args: { path: 'dirty.txt' } }],
          modelCalls: [{ model: 'opencode-go/deepseek-v4.1-flash', success: true, durationMs: 1 }],
          ...(change === 'missing' ? {} : { repository }) } };
      } });
    assert.equal(result.completed, change === 'none');
    assert.equal(result.runs.length, change === 'none' ? 2 : 1);
    if (change === 'none') assert.ok(result.runs.every(r => r.status === 'pass' && r.repository.gitAvailable));
    else assert.equal(result.runs[0].status, 'error');
  }
});
test('empty authorized baseline still creates a valid one-commit Git index without fetching excluded files', t => {
  const f = fixture(t), snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, { files: [], deletions: [] }, { knownValues: [opaque] });
  for (const item of snapshot.gitFiles) { const dest = path.join(f.restored, item.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from(item.base64, 'base64')); }
  assert.equal(f.git(f.restored, 'rev-list', '--all', '--count').trim(), '1');
  assert.equal(f.git(f.restored, 'ls-tree', '-r', 'HEAD').trim(), ''); assert.equal(snapshot.report.baselineFileCount, 0);
});
test('explicit recorded detached refs survive without inventing replay-baseline, only HEAD aliases are allowed', t => {
  const f = fixture(t); f.git(f.sourceRoot, 'branch', 'develop', f.head);
  const refState = { head: null, refs: ['refs/heads/develop', 'refs/remotes/origin/develop'], symbolicRefs: { 'refs/remotes/origin/HEAD': 'refs/remotes/origin/develop' } };
  // Operator supplies independently recorded aliases; no ambient live refs are read.
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head, refState }, f.input); f.install(snapshot);
  assert.equal(f.git(f.restored, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
  assert.equal(f.git(f.restored, 'rev-parse', 'develop').trim(), f.head);
  assert.equal(f.git(f.restored, 'symbolic-ref', 'refs/remotes/origin/HEAD').trim(), 'refs/remotes/origin/develop');
  assert.doesNotMatch(f.git(f.restored, 'branch', '--all'), /replay-baseline/);
  assert.deepEqual(snapshot.report.refState, refState);
  for (const bad of [{ ...refState, refs: ['refs/heads/../escape'] }, { ...refState, head: 'refs/heads/absent' }, { ...refState, symbolicRefs: { 'refs/remotes/origin/HEAD': 'refs/heads/absent' } }])
    assert.throws(() => api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head, refState: bad }, f.input));
});
test('placeholder-only bytes and excluded files do not manufacture dirt, but real edits/deletions remain visible', t => {
  const f = fixture(t);
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, { ...f.input, capturePlatform: 'win32', files: f.input.files.map(x => ({ ...x, mode: 0o100644, secretRedacted: ['secret.txt', 'opaque.txt'].includes(x.path) })) }, { knownValues: [] });
  f.install(snapshot);
  const status = f.git(f.restored, 'status', '--porcelain');
  assert.doesNotMatch(status, /secret\.txt|excluded\.txt/);
  assert.match(status, /opaque\.txt/, 'arbitrary non-pattern redaction is not trusted without the actual known value');
  assert.match(status, / M dirty\.txt/); assert.match(status, / D deleted\.txt/); assert.match(status, /\?\? untracked\.txt/);
  assert.deepEqual(snapshot.report.worktreeAdjustments.assumeUnchanged, ['secret.txt']);
  assert.deepEqual(snapshot.report.worktreeAdjustments.skipWorktree, ['excluded.txt']);
  assert.equal(fs.readFileSync(path.join(f.restored, 'secret.txt'), 'utf8'), 'fixture=[*]\n');
});
test('redaction flag does not hide a real edit in a redacted file, and attached ref remains attached on fallback', t => {
  const f = fixture(t); const file = f.input.files.find(f => f.path === 'secret.txt');
  const bytes = Buffer.from('fixture=[*]\nreal captured change\n');
  Object.assign(file, { base64: bytes.toString('base64'), sha256: sha(bytes), secretRedacted: true });
  const snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input); f.install(snapshot);
  assert.match(f.git(f.restored, 'status', '--porcelain'), / M secret\.txt/);
  assert.deepEqual(snapshot.report.worktreeAdjustments.assumeUnchanged, []);
  const refState = { head: 'refs/heads/develop', refs: ['refs/heads/develop'], symbolicRefs: {} };
  const fallback = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head, refState }, f.input, { knownValues: [opaque] }); f.install(fallback);
  assert.equal(f.git(f.restored, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/develop');
  assert.equal(fallback.report.historyIncluded, false); assert.notEqual(fallback.report.restoredHead, f.head);
});
test('late-known opaque credential is refused before any model instead of being hidden in a compressed Git object', t => {
  const f = fixture(t), snapshot = api().prepareReplayGit({ sourceRoot: f.sourceRoot, head: f.head }, f.input);
  assert.throws(() => snapshot.checkKnownValues([opaque]), e => e.code === 'evaluation_input_contains_key');
  assert.doesNotThrow(() => snapshot.checkKnownValues(['unrelated-unit-test-marker']));
});
