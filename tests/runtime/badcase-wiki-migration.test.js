// All migration sources and destinations are synthetic; never open a real
// instance, credentials, Docker or model. Immutable IDs include original paths.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sealFixture = require('../helpers/badcase-initialization-fixture.cjs');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiStore } = require(base + 'wiki-store');
const { collectWikiCandidateFiles } = require(base + 'wiki-candidate-files');
const { getGlobalPromptTarget } = require('../../build/lib/agent-prompt-targets');
// These legacy-layout tests explicitly select their own synthetic destination.
// An inherited instance default is not their input; the external-dir test below
// installs its own scoped value when testing configured destination behavior.
const inheritedWikiDataDir = process.env.CAFF_WIKISKILL_DATA_DIR;
delete process.env.CAFF_WIKISKILL_DATA_DIR;
test.after(() => { if (inheritedWikiDataDir !== undefined) process.env.CAFF_WIKISKILL_DATA_DIR = inheritedWikiDataDir; });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function tree(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => {
    const file = path.join(root, e.name);
    return e.isDirectory() ? tree(file).map(([name, h]) => [e.name + '/' + name, h]) : [[e.name, sha(fs.readFileSync(file))]];
  }).sort(([a], [b]) => a.localeCompare(b));
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-layout-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seal = sealFixture(t, 'fresh', ({ cp, r, config, put }) => {
    cp.agentId = 'role-family-gpt'; r.runConfig.provider = 'deepseek'; r.runConfig.model = 'deepseek-v4-flash';
    config.toolBridgeEnabled = true; config.portableRuntime = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: true };
    config.sdkStartConfig = { cwd: cp.targetDir, provider: r.runConfig.provider, model: r.runConfig.model, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true };
    const role = 'Rules:\n' + getGlobalPromptTarget('global-harness-behavior-v1').baseText + '\n- Preserve routing.';
    const prompt = 'Identity: test\n\nRoom work context:\n- Fixture\n\n' + role + '\n\nRouting instructions:\n- No handoff.\n\nUser: inspect.';
    r.promptBlobHash = r.normalizedPromptHash = put(prompt);
    r.roleSpan = { start: prompt.indexOf(role), end: prompt.indexOf(role) + role.length, sha256: sha(role) };
    const association = { projectId: cp.projectId, conversationId: cp.conversationId, turnId: cp.turnId, agentId: cp.agentId, userMessageId: 'u1', assistantMessageId: 'msg1' };
    const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association, assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Fixture', type: 'standard', metadata: {} }, participants: [{ id: cp.agentId, name: 'GPT', description: 'Test' }], publicMessages: [{ id: 'u1', turnId: 't0', role: 'user', agentId: null, senderName: 'User', content: 'Inspect.', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] };
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(JSON.stringify(trace)), association };
    r.harness.configSnapshotHash = put(JSON.stringify(config));
  });
  const scope = { globalRoot: path.join(root, 'source-agent/badcase-global'), sourceWorktree: path.join(root, 'repo') }, store = createWikiStore(scope);
  const cases = store.addTextCases(Array.from({ length: 4 }, (_, n) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'history', conversationId: 'room', messageId: 'm' + n, agentId: 'role-family-gpt' }, role: 'GPT', actual: 'unclear', expected: 'reader outcome ' + n, message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }))).cases;
  store.setReplaySplit({ caseIds: cases.map(c => c.id) });
  const train = store.read().cases.filter(c => c.split === 'train').map(c => c.id);
  const v = store.saveDraft({ caseIds: train, model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Clarity', failureMode: 'jargon', symptoms: 'unclear', rootCauseHypothesis: 'audience', guideline: '先说用户影响。', caseIds: train }], unclassified: [] });
  store.review({ versionId: v.id, entryId: 'entry-1', expectedRevision: store.read().revision, decision: 'approved' });
  const rules = { kind: 'read-only-files-v1', readPaths: ['source.txt'], absentPaths: [], requiredReplyFragments: ['done'] };
  const replay = store.addReplayCase({ sourceCaseId: cases[0].id, category: 'control', task: 'Inspect source.txt.', fixture: { commit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'sample', filesHash: 'c'.repeat(64) }, request: seal.request, rules, checkpointHash: sha(JSON.stringify(seal.cp)) });
  const files = collectWikiCandidateFiles(store.read()), candidate = store.createGlobalCandidate({ versionId: v.id, entryIds: ['entry-1'], targetId: 'global-harness-behavior-v1', files });
  store.confirmGlobalCandidate({ candidateId: candidate.id, candidateHash: candidate.candidateHash, expectedRevision: store.read().revision, files });
  const originalPlan = { kind: 'sealed-original-replay-v1', model: 'deepseek/deepseek-v4-flash', repeats: 1, variants: ['original'], caseId: 'case-fixture', checkpointId: 'cp1', checkpointHash: replay.checkpointHash, rulesHash: sha(JSON.stringify(rules)) };
  const progress = require(base + 'wiki-execution-store').createWikiExecutionStore(scope), execution = progress.start(originalPlan); progress.fail(execution.id, 'evaluation_failed');
  // These files are deliberately outside the data allowlist.
  fs.writeFileSync(path.join(root, 'source-agent/auth.json'), 'AUTH-MUST-NOT-MIGRATE');
  fs.mkdirSync(path.join(seal.root, 'projects/p1/staging/private'), { recursive: true }); fs.writeFileSync(path.join(seal.root, 'projects/p1/staging/private/unused'), 'STAGING-MUST-NOT-MIGRATE');
  const config = { ...scope, captureRoots: [seal.root], destinationAgentDir: path.join(root, 'copy-agent') };
  const migration = () => require('../../scripts/badcase-capture/migrate-wiki-layout.cjs');
  const plan = () => migration().prepareMigration(config);
  const run = () => migration().migrateWikiLayout(config, { confirmed: true, expectedPlanHash: plan().summary.planHash });
  return { root, seal, scope, store, replay, candidate, config, migration, plan, run };
}
test('layout migration preserves immutable wiki/approval/progress bytes and IDs, copies closure only, and is idempotent', t => {
  const h = setup(t), before = tree(h.scope.globalRoot), captures = tree(h.seal.root), state = h.store.read(), plan = h.plan();
  assert.equal(fs.existsSync(h.config.destinationAgentDir), false, 'plan is read-only');
  const first = h.run(), dest = path.join(h.config.destinationAgentDir, 'badcase-global'); assert.equal(first.migrated, true);
  const copied = createWikiStore({ ...h.scope, globalRoot: dest }).read(); assert.deepEqual(copied, state);
  for (const [name, digest] of before) assert.equal(sha(fs.readFileSync(path.join(dest, name))), digest);
  assert.deepEqual(tree(h.scope.globalRoot), before); assert.deepEqual(tree(h.seal.root), captures);
  const all = tree(h.config.destinationAgentDir); assert.ok(!JSON.stringify(all).match(/auth\.json|staging|policy\.json|latest/));
  assert.equal(h.run().migrated, false); assert.deepEqual(tree(h.config.destinationAgentDir), all);
  assert.equal(first.planHash, plan.summary.planHash); assert.equal(first.counts.cases, 4); assert.equal(first.counts.sealedCases, 1);
});
test('migrated requests and candidate/preflight use copied closure without falling back to original roots', t => {
  const h = setup(t); h.run(); const dest = path.join(h.config.destinationAgentDir, 'badcase-global');
  const { resolveWikiReplayRequest } = require(base + 'wiki-replay-location');
  const request = resolveWikiReplayRequest({ globalRoot: dest }, h.replay.request); assert.notEqual(request.captureRoot, h.seal.root);
  assert.deepEqual(resolveWikiReplayRequest({ globalRoot: dest }, request), request); assert.deepEqual(h.replay.request.captureRoot, h.seal.root);
  fs.renameSync(h.seal.root, h.seal.root + '-offline'); t.after(() => fs.renameSync(h.seal.root + '-offline', h.seal.root));
  const state = createWikiStore({ ...h.scope, globalRoot: dest }).read(), files = collectWikiCandidateFiles(state, { globalRoot: dest }); assert.equal(files.length, 1);
  const candidate = require('../../scripts/badcase-capture/create-wiki-candidate.cjs').createCandidate({ ...h.scope, globalRoot: dest,
    versionId: state.versions[0].id, entryIds: ['entry-1'], targetId: 'global-harness-behavior-v1' });
  assert.equal(candidate.id, h.candidate.id, 'global candidate CLI delegates all scene reads to the location-aware collector');
  const direct = require('../../scripts/badcase-capture/direct-comparison.cjs').prepareComparison;
  const plan = direct({ request: h.replay.request, globalWikiCandidate: { ...h.scope, globalRoot: dest, candidateId: h.candidate.id }, repoRoot: h.root, dependencyRoot: h.root, image: { imageId: 'sha256:' + '1'.repeat(64) }, repeats: 1, rules: h.replay.rules, modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' });
  assert.equal(plan.supported, true); assert.equal(plan.summary.checkpointHash, h.replay.checkpointHash);
  fs.unlinkSync(path.join(request.captureRoot, 'projects/p1/blobs', h.seal.cp.files['source.txt'].hash.slice(0, 2), h.seal.cp.files['source.txt'].hash));
  assert.throws(() => collectWikiCandidateFiles(state, { globalRoot: dest }), /wiki_candidate_anchor_unsupported/);
});
test('registration validates imported seals without changing the original path-bound replay identity', t => {
  const h = setup(t); h.run(); const globalRoot = path.join(h.config.destinationAgentDir, 'badcase-global');
  const scope = { ...h.scope, globalRoot }, store = createWikiStore(scope), before = store.read();
  const { registerReplayCases } = require('../../scripts/badcase-capture/register-replay-cases.cjs');
  const input = Object.fromEntries(['sourceCaseId', 'category', 'task', 'fixture', 'request', 'rules', 'checkpointHash'].map(k => [k, h.replay[k]]));
  assert.equal(require('../../scripts/badcase-capture/sealed-direct-input.cjs').prepareSealedDirectTurn(input.request).supported, true);
  const original = h.seal.root, offline = original + '-offline'; fs.renameSync(original, offline);
  try {
    const result = registerReplayCases({ ...scope, cases: [input] }, true);
    assert.deepEqual(result.replayCases, [h.replay]); assert.deepEqual(store.read(), before);
    const imported = require(base + 'wiki-replay-location').resolveWikiReplayRequest(scope, input.request);
    const blob = h.seal.cp.files['source.txt'].hash; fs.unlinkSync(path.join(imported.captureRoot, 'projects/p1/blobs', blob.slice(0, 2), blob));
    assert.throws(() => registerReplayCases({ ...scope, cases: [input] }, true), /wiki_replay_materials_unavailable/);
    assert.deepEqual(store.read(), before); assert.equal(fs.existsSync(original), false);
  } finally { fs.renameSync(offline, original); }
  assert.throws(() => registerReplayCases({ ...scope, cases: [input] }, true), /wiki_replay_materials_unavailable/, 'a still-present original never rescues damaged imports');
});
test('missing or damaged relocation metadata never falls back to still-present original scenes', t => {
  const h = setup(t); h.run(); const globalRoot = path.join(h.config.destinationAgentDir, 'badcase-global'), file = path.join(globalRoot, 'capture-locations.json');
  const { resolveWikiReplayRequest } = require(base + 'wiki-replay-location'), bytes = fs.readFileSync(file);
  fs.unlinkSync(file); assert.throws(() => resolveWikiReplayRequest({ globalRoot }, h.replay.request), /wiki_migration_location_invalid/);
  const e = JSON.parse(bytes); e.record.roots[0].directory = '../escape'; e.checksum = sha(JSON.stringify(e.record)); fs.writeFileSync(file, JSON.stringify(e));
  assert.throws(() => resolveWikiReplayRequest({ globalRoot }, h.replay.request), /wiki_migration_location_invalid/);
  fs.writeFileSync(file, bytes); assert.throws(() => resolveWikiReplayRequest({ globalRoot }, { ...h.replay.request, captureRoot: path.join(h.root, 'unknown') }), /wiki_migration_location_invalid/);
});
test('configured external destination migrates source bytes and resolves both imported and instance-local sealed preflights', async t => {
  const h = setup(t), dataDir = path.join(h.root, 'external-wiki'), agentDir = path.join(h.scope.sourceWorktree, '.pi-sandbox');
  const before = tree(h.scope.globalRoot), old = { data: process.env.CAFF_WIKISKILL_DATA_DIR, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.CAFF_WIKISKILL_DATA_DIR = dataDir; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { for (const [key, value] of [['CAFF_WIKISKILL_DATA_DIR', old.data], ['PI_CODING_AGENT_DIR', old.agent]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const config = { ...h.config, destinationAgentDir: agentDir }, { resolveWikiReplayRequest } = require(base + 'wiki-replay-location');
  const p = h.migration().prepareMigration(config);
  assert.equal(p.config.destinationAgentDir, dataDir);
  const run = () => h.migration().migrateWikiLayout(config, { confirmed: true, expectedPlanHash: p.summary.planHash });
  assert.equal(run().migrated, true); assert.equal(run().migrated, false); assert.deepEqual(tree(h.scope.globalRoot), before);
  const configFile = path.join(h.root, 'external-migration.json'); fs.writeFileSync(configFile, JSON.stringify(config));
  const cli = path.resolve('scripts/badcase-capture/migrate-wiki-layout.cjs');
  const result = spawnSync(process.execPath, [cli, '--config', configFile, '--run', '--confirmed', '--expected-plan', p.summary.planHash], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).migrated, false);
  const scope = { globalRoot: path.join(dataDir, 'badcase-global'), sourceWorktree: h.scope.sourceWorktree };
  assert.deepEqual(createWikiStore(scope).read(), h.store.read());
  const imported = resolveWikiReplayRequest(scope, h.replay.request); assert.ok(imported.captureRoot.startsWith(path.join(dataDir, 'badcase-capture/imports') + path.sep));
  const native = path.join(agentDir, 'badcase-capture'); fs.cpSync(h.seal.root, native, { recursive: true });
  const localRequest = { ...h.replay.request, captureRoot: native }, localScope = { ...scope, instanceCaptureRoot: native };
  // Build a new seal/retention in the instance capture store from its checkpoint,
  // rather than relying on the old import's seal metadata.
  for (const dir of ['cases', 'retention']) fs.rmSync(path.join(native, 'projects/p1', dir), { recursive: true });
  require(base + 'sealed-case').saveSealedCase(localRequest);
  assert.deepEqual(resolveWikiReplayRequest(localScope, localRequest), localRequest);
  const prepare = require('../../scripts/badcase-capture/sealed-direct-input.cjs').prepareSealedOriginalTurn;
  assert.equal(prepare(imported).supported, true); assert.equal(prepare(resolveWikiReplayRequest(localScope, localRequest)).supported, true);
  const state = createWikiStore(scope).read(); assert.equal(collectWikiCandidateFiles(state, scope).length, 1);
  const comparison = require('../../scripts/badcase-capture/direct-comparison.cjs').prepareComparison({ request: h.replay.request, globalWikiCandidate: { ...scope, candidateId: h.candidate.id }, repoRoot: h.root, dependencyRoot: h.root, image: { imageId: 'sha256:' + '1'.repeat(64) }, repeats: 1, rules: h.replay.rules, modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' });
  assert.equal(comparison.supported, true);
  const evaluationFile = path.join(h.root, 'original-evaluation.json');
  fs.writeFileSync(evaluationFile, JSON.stringify({ ...scope, comparison: { request: h.replay.request, variants: ['original'], repoRoot: h.root, dependencyRoot: h.root, image: { imageId: 'sha256:' + '1'.repeat(64) }, repeats: 1, rules: h.replay.rules, modelProfile: 'deepseek/deepseek-v4-flash', keySource: 'caff-deepseek' } }));
  const evaluate = () => require('../../scripts/badcase-capture/run-wiki-evaluation.cjs').main(['--config', evaluationFile, '--plan'], { print: () => {} });
  assert.equal((await evaluate()).supported, true);
  fs.unlinkSync(path.join(imported.captureRoot, 'projects/p1/blobs', h.seal.cp.files['source.txt'].hash.slice(0, 2), h.seal.cp.files['source.txt'].hash));
  assert.equal(prepare(resolveWikiReplayRequest(scope, h.replay.request)).supported, false, 'missing import never reads still-present old source');
  assert.equal((await evaluate()).supported, false, 'original-only evaluation also refuses missing imports instead of reading old source');
  assert.equal(prepare(resolveWikiReplayRequest(localScope, localRequest)).supported, true, 'local scene remains independent');
  assert.equal(fs.existsSync(path.join(agentDir, 'badcase-global')), false);
});
test('confirmation/hash drift and source changes reject without publishing a destination', t => {
  const h = setup(t), p = h.plan();
  assert.throws(() => h.migration().migrateWikiLayout(h.config, { expectedPlanHash: p.summary.planHash }), /wiki_migration_confirmation_required/);
  assert.throws(() => h.migration().migrateWikiLayout(h.config, { confirmed: true, expectedPlanHash: '0'.repeat(64) }), /wiki_migration_plan_changed/);
  h.store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'h', conversationId: 'r', messageId: 'new', agentId: 'role-family-gpt' }, role: 'GPT', actual: 'unclear', expected: 'clear', message: '', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]);
  assert.throws(() => h.migration().migrateWikiLayout(h.config, { confirmed: true, expectedPlanHash: p.summary.planHash }), /wiki_migration_plan_changed/); assert.equal(fs.existsSync(h.config.destinationAgentDir), false);
});
test('missing/corrupt closure and unlisted roots fail before writing, never silently omit a scene', t => {
  const h = setup(t); assert.throws(() => h.migration().prepareMigration({ ...h.config, captureRoots: [] }), /wiki_migration_capture_root_required/);
  const file = h.seal.blobPath(h.seal.cp.files['source.txt'].hash), content = fs.readFileSync(file); fs.writeFileSync(file, 'corrupt');
  assert.throws(h.plan, /wiki_migration_blob_invalid/); fs.writeFileSync(file, content); fs.unlinkSync(file);
  assert.throws(h.plan, /wiki_migration_blob_invalid/); assert.equal(fs.existsSync(h.config.destinationAgentDir), false);
});
test('unrelated or changed destinations are not overwritten; post-migration source changes require a fresh destination', t => {
  const h = setup(t); fs.mkdirSync(h.config.destinationAgentDir); fs.writeFileSync(path.join(h.config.destinationAgentDir, 'keep'), 'keep');
  assert.throws(h.run, /wiki_migration_destination_conflict/); assert.equal(fs.readFileSync(path.join(h.config.destinationAgentDir, 'keep'), 'utf8'), 'keep');
  h.config.destinationAgentDir += '-fresh'; h.run();
  const file = path.join(h.config.destinationAgentDir, 'badcase-global/snapshots', fs.readdirSync(path.join(h.scope.globalRoot, 'snapshots'))[0]); fs.appendFileSync(file, ' ');
  assert.throws(h.run, /wiki_migration_destination_conflict/);
});
test('static symlinks, nested/overlapping roots and malformed snapshots are rejected', t => {
  const h = setup(t);
  for (const patch of [{ destinationAgentDir: h.scope.globalRoot }, { destinationAgentDir: path.join(h.seal.root, 'copy') }, { destinationAgentDir: path.join(h.scope.sourceWorktree, 'copy') }, { captureRoots: [h.seal.root, h.seal.root] }]) assert.throws(() => h.migration().prepareMigration({ ...h.config, ...patch }), /wiki_migration_(layout_invalid|config_invalid)/);
  const file = path.join(h.scope.globalRoot, 'snapshots', fs.readdirSync(path.join(h.scope.globalRoot, 'snapshots'))[0]); fs.appendFileSync(file, 'damage'); assert.throws(h.plan, /wiki_migration_record_invalid/);
});
test('all progress records are copied, not only the page latest-20 window; active writers are rejected', t => {
  const h = setup(t), progress = require(base + 'wiki-execution-store').createWikiExecutionStore(h.scope), old = progress.read()[0];
  for (let i = 0; i < 22; i++) { const r = progress.start(old.plan); progress.fail(r.id, 'evaluation_failed'); }
  assert.equal(progress.read().length, 20); assert.equal(h.plan().summary.counts.executions, 23); h.run();
  assert.equal(fs.readdirSync(path.join(h.config.destinationAgentDir, 'badcase-global/executions')).length, 23);
  progress.start(old.plan); assert.throws(h.plan, /wiki_migration_source_busy_or_invalid/);
});
test('active or crash-left source write locks fail closed without attempting lock recovery', t => {
  const h = setup(t), lock = path.join(h.scope.globalRoot, 'projects/global-wiki/.writer-lock'); fs.mkdirSync(lock, { recursive: true });
  assert.throws(h.plan, /wiki_migration_source_busy_or_invalid/); assert.equal(fs.existsSync(lock), true); assert.equal(fs.existsSync(h.config.destinationAgentDir), false);
});
test('copy failures leave only a diagnostic staging directory and never publish partial data or modify source', t => {
  const h = setup(t), before = tree(h.scope.globalRoot), captures = tree(h.seal.root), copy = fs.copyFileSync, p = h.plan(); let called = 0;
  fs.copyFileSync = (...args) => { if (++called === 2) throw Object.assign(Error('PRIVATE-FS-FAILURE'), { code: 'EIO' }); return copy(...args); };
  try { assert.throws(() => h.migration().migrateWikiLayout(h.config, { confirmed: true, expectedPlanHash: p.summary.planHash }), /PRIVATE-FS-FAILURE/); } finally { fs.copyFileSync = copy; }
  assert.equal(fs.existsSync(h.config.destinationAgentDir), false); assert.deepEqual(tree(h.scope.globalRoot), before); assert.deepEqual(tree(h.seal.root), captures);
  assert.equal(fs.readdirSync(h.root).filter(n => n.startsWith('copy-agent.migration-')).length, 1); assert.equal(h.run().migrated, true);
});
test('static file links are rejected before copying evidence', { skip: process.platform === 'win32' }, t => {
  const h = setup(t), file = h.seal.blobPath(h.seal.cp.files['source.txt'].hash), bytes = fs.readFileSync(file); fs.unlinkSync(file);
  const other = path.join(h.root, 'elsewhere'); fs.writeFileSync(other, bytes); fs.symlinkSync(other, file);
  assert.throws(h.plan, /wiki_migration_blob_invalid/); assert.equal(fs.existsSync(h.config.destinationAgentDir), false);
});
test('CLI requires exact plan/confirmation and emits safe metadata only, not source paths or errors', t => {
  const h = setup(t), file = path.join(h.root, 'migration.json'), cli = path.resolve('scripts/badcase-capture/migrate-wiki-layout.cjs'); fs.writeFileSync(file, JSON.stringify(h.config));
  const exec = args => spawnSync(process.execPath, [cli, '--config', file, ...args], { encoding: 'utf8' });
  const p = exec(['--plan']); assert.equal(p.status, 0, p.stderr); const summary = JSON.parse(p.stdout); assert.match(summary.planHash, /^[a-f0-9]{64}$/); assert.ok(!p.stdout.includes(h.root));
  assert.equal(exec(['--run']).status, 1); const r = exec(['--run', '--confirmed', '--expected-plan', summary.planHash]); assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).migrated, true);
  assert.equal(JSON.parse(exec(['--run', '--confirmed', '--expected-plan', summary.planHash]).stdout).migrated, false);
});
