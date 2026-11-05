// Only synthetic temporary roots. Never inspect the inherited directory.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const base = '../../build/server/domain/runtime/badcase-capture/';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-isolation-'));
  const sentinel = path.join(root, 'sentinel'), globalRoot = path.join(root, 'explicit', 'badcase-global');
  fs.mkdirSync(sentinel);
  const old = process.env.CAFF_WIKISKILL_DATA_DIR;
  process.env.CAFF_WIKISKILL_DATA_DIR = sentinel;
  t.after(() => {
    if (old === undefined) delete process.env.CAFF_WIKISKILL_DATA_DIR; else process.env.CAFF_WIKISKILL_DATA_DIR = old;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, sentinel, scope: { globalRoot, sourceWorktree: path.join(root, 'source') } };
}
test('explicit temporary globalRoot writes never touch the configured sentinel', t => {
  const h = fixture(t), store = require(base + 'wiki-store').createWikiStore(h.scope);
  store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p', conversationId: 'c', messageId: 'synthetic', agentId: 'role-family-gpt' }, role: 'GPT', actual: 'unclear', expected: 'clear', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]);
  const progress = require(base + 'wiki-execution-store').createWikiExecutionStore(h.scope);
  const plan = { kind: 'sealed-original-replay-v1', model: 'deepseek/deepseek-v4-flash', repeats: 1, variants: ['original'], caseId: 'case-fixture', checkpointId: 'cp1', checkpointHash: 'a'.repeat(64), rulesHash: 'b'.repeat(64) };
  progress.fail(progress.start(plan).id, 'evaluation_failed');
  assert.deepEqual(require(base + 'wiki-comparison-store').createWikiComparisonStore(h.scope).read(), []);
  assert.deepEqual(require(base + 'wiki-batch-execution-store').createWikiBatchExecutionStore(h.scope).read(), []);
  assert.deepEqual(fs.readdirSync(h.sentinel), [], 'inherited directory must remain completely empty');
  assert.equal(fs.existsSync(path.join(h.scope.globalRoot, 'snapshots/000000000001.json')), true);
  assert.equal(fs.readdirSync(path.join(h.scope.globalRoot, 'executions')).length, 1);
});
test('explicit global and project roots ignore even invalid storage configuration', t => {
  const h = fixture(t), { resolveWikiStorageOptions } = require(base + 'wiki-data-directory');
  const env = { CAFF_WIKISKILL_DATA_DIR: 'invalid-relative', PI_CODING_AGENT_DIR: path.join(h.root, 'foreign-agent') };
  assert.equal(resolveWikiStorageOptions(h.scope, env), h.scope);
  const project = { captureRoot: path.join(h.root, 'capture'), projectId: 'p', sourceWorktree: h.scope.sourceWorktree };
  assert.equal(resolveWikiStorageOptions(project, env), project);
});
test('only default assembly without an explicit root applies configured data storage', t => {
  const h = fixture(t), { resolveWikiStorageOptions } = require(base + 'wiki-data-directory');
  const agentDir = path.join(h.root, 'agent'), options = { agentDir, sourceWorktree: h.scope.sourceWorktree };
  const resolved = resolveWikiStorageOptions(options, { CAFF_WIKISKILL_DATA_DIR: h.sentinel });
  assert.equal(resolved.globalRoot, path.join(h.sentinel, 'badcase-global'));
  assert.equal(resolved.instanceCaptureRoot, path.join(agentDir, 'badcase-capture'));
  assert.equal(resolveWikiStorageOptions(options, {}).globalRoot, path.join(agentDir, 'badcase-global'));
  assert.throws(() => resolveWikiStorageOptions(options, { CAFF_WIKISKILL_DATA_DIR: 'relative' }), /wiki_data_dir_invalid/);
});
test('npm test entry removes inherited capture configuration before running a child', t => {
  const h = fixture(t), entry = path.resolve('scripts/test-entry.cjs');
  const probe = path.join(h.root, 'capture-probe.cjs');
  fs.writeFileSync(probe, "require('node:assert/strict').equal(process.env.CAFF_BADCASE_CAPTURE_DIR, undefined); console.log('capture-isolated');");
  const command = JSON.stringify(process.execPath) + ' ' + JSON.stringify(probe);
  const child = spawnSync(process.execPath, [entry, command], { encoding: 'utf8', env: { ...process.env, CAFF_BADCASE_CAPTURE_DIR: h.sentinel } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /capture-isolated/);
  assert.deepEqual(fs.readdirSync(h.sentinel), [], 'inherited capture directory must remain completely empty');
});
test('npm test entry removes inherited WikiSkill configuration before running a child', t => {
  const h = fixture(t), entry = path.resolve('scripts/test-entry.cjs');
  const probe = path.join(h.root, 'probe.cjs');
  fs.writeFileSync(probe, "require('node:assert/strict').equal(process.env.CAFF_WIKISKILL_DATA_DIR, undefined); console.log('isolated');");
  const command = JSON.stringify(process.execPath) + ' ' + JSON.stringify(probe);
  const child = spawnSync(process.execPath, [entry, command], { encoding: 'utf8', env: { ...process.env, CAFF_WIKISKILL_DATA_DIR: h.sentinel } });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /isolated/);
  const failure = spawnSync(process.execPath, [entry, JSON.stringify(process.execPath) + ' -e "process.exit(7)"'], { encoding: 'utf8' });
  assert.equal(failure.status, 7, 'test failures must propagate to npm');
  assert.deepEqual(fs.readdirSync(h.sentinel), []);
});
