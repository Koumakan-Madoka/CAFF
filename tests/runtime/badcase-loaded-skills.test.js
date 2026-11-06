const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const hostUrl = pathToFileURL(path.resolve(__dirname, '../../lib/pi-sdk-host.mjs')).href;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function hostFixture(t, { abort = false, inventoryFails = false } = {}) {
  const { startProcessHost } = await import(hostUrl);
  const calls = [], sent = [], processMock = new EventEmitter();
  const skill = { name: 'selected', filePath: path.resolve('project/.agents/skills/selected/SKILL.md'), baseDir: path.resolve('project/.agents/skills/selected') };
  Object.assign(processMock, { connected: true, versions: { node: process.versions.node }, platform: process.platform,
    stderr: { write() {} }, send(message, cb) { sent.push(message); cb(); }, disconnect() { this.connected = false; } });
  const runtime = { services: { resourceLoader: { getSkills() { if (inventoryFails) throw Error('unavailable'); return { skills: [skill] }; },
    getAgentsFiles() { return { agentsFiles: [{ path: path.resolve('project/AGENTS.md'), content: 'not sent over IPC' }] }; } } },
    session: { sessionFile: '', async bindExtensions() {}, subscribe() { return () => {}; },
      async prompt() { calls.push('prompt'); }, async waitForIdle() {}, async abort() { calls.push('abort'); } },
    setRebindSession() {}, async dispose() { calls.push('dispose'); } };
  startProcessHost({ runtimeProcess: processMock, loadSdk: async () => ({}), createRuntime: async () => ({ runtime }) });
  processMock.emit('message', { type: 'start', prompt: 'test', awaitBeforePrompt: true,
    config: { cwd: path.resolve('project'), agentDir: path.resolve('agent'), heartbeatIntervalMs: 0 } });
  for (let i = 0; i < 20 && !sent.some(m => m.type === 'before_prompt'); i++) await tick();
  t.after(() => { if (processMock.connected) processMock.emit('message', { type: 'abort' }); });
  const inventory = sent.find(m => m.type === 'before_prompt');
  assert.ok(inventory, 'actual loaded inventory must be reported before prompting');
  assert.deepEqual(calls, [], 'no model/tool invocation while the parent archives resources');
  assert.deepEqual(inventory.skills, inventoryFails ? null : [skill]);
  assert.deepEqual(inventory.contextFiles, [{ path: path.resolve('project/AGENTS.md') }]);
  processMock.emit('message', { type: abort ? 'abort' : 'continue_prompt' });
  for (let i = 0; i < 20 && processMock.connected; i++) await tick();
  assert.equal(calls.includes('prompt'), !abort);
  assert.equal(processMock.exitCode, 0);
}
test('SDK host waits for resource capture before model invocation, using the loaded rather than declared skill list', async t => hostFixture(t));
test('SDK host abort during the capture wait never starts a model invocation', async t => hostFixture(t, { abort: true }));
test('SDK inventory read failure is explicit and does not block the turn', async t => hostFixture(t, { inventoryFails: true }));

function fixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-loaded-skills-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo'); fs.mkdirSync(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'no-config') });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, stdio: 'pipe' });
  git('init', '-q'); fs.writeFileSync(path.join(root, 'base'), 'base'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'base');
  const { createBadcaseCaptureService } = require('../../build/server/domain/runtime/badcase-capture');
  const key = 'fixture-known-actual-value-56789';
  const service = createBadcaseCaptureService({ captureRoot: path.join(temp, 'capture'), agentDir: path.join(temp, 'agent'),
    getKnownKeyValues: () => [key], getProject: () => ({ id: 'p', path: root }), ...options });
  service.store.savePolicy({ projectId: 'p', status: 'enabled', authorizedDirs: [root] });
  const capture = () => service.captureTurnCheckpoint({ projectId: 'p', targetDir: root, turnId: 'turn', agentId: 'agent', conversationId: 'room',
    prompt: 'test', runConfig: {}, projectSkillPaths: [], projectSkillsPending: true,
    harness: { configSnapshot: { sdkStartConfig: { cwd: root, additionalSkillPaths: [] } } } });
  return { temp, root, service, capture, key };
}

test('checkpoint records pending initialization, then CAS-archives only SDK-selected skills and their resources before the prompt', async t => {
  const h = fixture(t), selected = path.join(h.temp, 'project-skills', 'selected');
  fs.mkdirSync(selected, { recursive: true }); fs.writeFileSync(path.join(selected, 'SKILL.md'), 'selected ' + h.key);
  fs.writeFileSync(path.join(selected, 'reference.txt'), 'resource');
  const guessed = path.join(h.root, '.agents', 'skills', 'disabled');
  fs.mkdirSync(guessed, { recursive: true }); fs.writeFileSync(path.join(guessed, 'SKILL.md'), 'not actually loaded');
  const initial = await h.capture(); assert.equal(initial.captured, true, initial.reason);
  assert.deepEqual(initial.checkpoint.gitSnapshot.projectSkills, [], 'no guesses when runtime inventory is pending');
  assert.ok(initial.checkpoint.replayInput.incompleteReasons.includes('project_skills_pending'));
  assert.equal(h.service.latestCaptureMetrics('p').status, 'pending_skills');
  const before = h.service.computeUsage('p').totalBytes;
  const skills = [{ name: 'selected', filePath: path.join(selected, 'SKILL.md'), baseDir: selected }];
  const result = await h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId, skills });
  assert.equal(result.captured, true, result.reason);
  const cp = h.service.store.loadCheckpoint('p', initial.checkpointId);
  assert.equal(h.service.store.listCheckpoints('p').length, 1, 'enrich the original, not a second checkpoint');
  assert.deepEqual(cp.gitSnapshot.loadedSkills, skills);
  assert.equal(cp.gitSnapshot.projectSkills.length, 1);
  assert.equal(cp.gitSnapshot.projectSkills[0].originalPath, selected);
  assert.deepEqual(Object.keys(cp.gitSnapshot.projectSkills[0].files).sort(), ['SKILL.md', 'reference.txt']);
  assert.equal(h.service.store.readBlob('p', cp.gitSnapshot.projectSkills[0].files['SKILL.md'].hash).toString(), 'selected [*]');
  assert.ok(!JSON.stringify(cp).includes(h.key));
  assert.ok(!cp.replayInput.incompleteReasons.includes('project_skills_pending'));
  assert.equal(h.service.latestCaptureMetrics('p').status, 'captured');
  assert.equal(h.service.latestCaptureMetrics('p').totalNewBytes, cp.stats.totalNewBytes);
  assert.equal(cp.stats.newBlobBytes, Object.values(cp.stats.blobBytesByKind).reduce((s, n) => s + n, 0));
  assert.equal(cp.stats.totalNewBytes, initial.checkpoint.stats.totalNewBytes + h.service.computeUsage('p').totalBytes - before);
  const usage = h.service.computeUsage('p').totalBytes;
  const repeated = await h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId, skills: [{ filePath: 'invalid' }] });
  assert.deepEqual(repeated.checkpoint, cp); assert.equal(h.service.computeUsage('p').totalBytes, usage, 'duplicate acknowledgements do not re-read or rewrite');
  const { createCheckpointRetentionStore } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
  const retained = createCheckpointRetentionStore({ captureStore: h.service.store }).retain({ projectId: 'p', checkpointId: cp.checkpointId,
    conversationId: 'room', turnId: 'turn', agentId: 'agent', referenceId: 'fixture' });
  assert.ok(retained.reference.blobHashes.includes(cp.gitSnapshot.projectSkills[0].files['reference.txt'].hash));
});

test('actual loaded external context survives checkpoint CAS retention, materialization and the replay manifest', async t => {
  const h = fixture(t), filePath = path.join(h.temp, 'AGENTS.md'); fs.writeFileSync(filePath, 'context ' + h.key);
  const initial = await h.capture(), result = h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId,
    skills: [], sdkSkills: [], promptSkills: [], contextFiles: [{ path: filePath }] });
  assert.equal(result.captured, true, result.reason); const cp = result.checkpoint;
  assert.deepEqual(cp.gitSnapshot.loadedContexts, [{ filePath }]);
  const root = cp.gitSnapshot.projectSkills.find(s => s.originalPath === filePath); assert.ok(root);
  const { checkpointBlobHashes } = require('../../build/server/domain/runtime/badcase-capture/checkpoint-retention');
  assert.ok(checkpointBlobHashes(cp).includes(root.files['AGENTS.md'].hash));
  const materialized = require('../../build/server/domain/runtime/badcase-capture/git-snapshot-materialization').materializeGitSnapshot({ checkpoint: cp, store: h.service.store, knownKeyValues: [] });
  const files = Object.entries(materialized.files).map(([name, f]) => ({ path: name, sha256: f.hash, base64: f.content.toString('base64') }));
  const resources = require('../../build/server/domain/runtime/badcase-capture/project-resources');
  const prepared = resources.prepareCapturedProjectResources({ schemaVersion: 1, kind: 'portable-captured-project-resources-v1', supported: true, filePaths: [], skillPaths: [] }, files, { additionalSkillPaths: [] }, cp, materialized);
  assert.equal(prepared.manifest.contextFiles.length, 1); const context = prepared.files.find(f => f.path === prepared.manifest.contextFiles[0]);
  assert.equal(Buffer.from(context.base64, 'base64').toString(), 'context [*]');
});

test('SDK-native and CAFF prompt skill origins stay distinct without duplicating archived resources', async t => {
  const h = fixture(t), root = path.join(h.temp, 'skills'); fs.mkdirSync(root);
  const make = name => { const baseDir = path.join(root, name); fs.mkdirSync(baseDir); const filePath = path.join(baseDir, 'SKILL.md');
    fs.writeFileSync(filePath, name); return { name, filePath, baseDir }; };
  const sdk = make('sdk-native'), prompt = make('prompt-explicit'), shared = make('both');
  const sdkShared = { ...shared, name: 'sdk-frontmatter-name' }, promptShared = { ...shared, name: 'prompt-registry-id' };
  const initial = await h.capture(), inputs = { projectId: 'p', checkpointId: initial.checkpointId, skills: [sdk, prompt, promptShared],
    sdkSkills: [sdk, sdkShared], promptSkills: [prompt, promptShared] };
  const result = h.service.captureLoadedProjectSkills(inputs); assert.equal(result.captured, true, result.reason);
  const snapshot = result.checkpoint.gitSnapshot;
  assert.deepEqual(snapshot.loadedSkills, [sdk, prompt, promptShared]); assert.deepEqual(snapshot.sdkLoadedSkills, [sdk, sdkShared]);
  assert.deepEqual(snapshot.promptLoadedSkills, [prompt, promptShared]); assert.equal(snapshot.projectSkills.length, 3);
  assert.equal(snapshot.projectSkills.filter(s => s.originalPath === shared.baseDir).length, 1, 'one byte archive even for a dual-origin skill');
  const before = JSON.stringify(result.checkpoint);
  inputs.sdkSkills.push(prompt); inputs.promptSkills.length = 0;
  assert.equal(JSON.stringify(h.service.store.loadCheckpoint('p', initial.checkpointId)), before, 'origin evidence is detached from mutable inputs');
});

test('old enrichment callers do not fabricate origin evidence from their merged list', async t => {
  const h = fixture(t), initial = await h.capture();
  const result = h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId, skills: [] });
  assert.equal(result.captured, true); assert.equal(Object.hasOwn(result.checkpoint.gitSnapshot, 'sdkLoadedSkills'), false);
  assert.equal(Object.hasOwn(result.checkpoint.gitSnapshot, 'promptLoadedSkills'), false);
});

test('an observed empty SDK/prompt inventory is recorded as empty, distinct from unknown origins', async t => {
  const h = fixture(t), initial = await h.capture();
  const result = h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId, skills: [], sdkSkills: [], promptSkills: [] });
  assert.equal(result.captured, true); assert.deepEqual(result.checkpoint.gitSnapshot.sdkLoadedSkills, []);
  assert.deepEqual(result.checkpoint.gitSnapshot.promptLoadedSkills, []);
});

test('loaded skill anomalies become gaps; root Markdown skills archive only that file, never their entire parent', async t => {
  const h = fixture(t), selected = path.join(h.temp, 'skills', 'selected'); fs.mkdirSync(selected, { recursive: true });
  fs.writeFileSync(path.join(selected, 'SKILL.md'), 'selected'); fs.writeFileSync(path.join(selected, 'large'), Buffer.alloc(10 * 1024 * 1024 + 1));
  const outside = path.join(h.temp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'hidden'), 'not followed');
  fs.symlinkSync(outside, path.join(selected, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  const rootMd = path.join(h.temp, 'one.md'); fs.writeFileSync(rootMd, 'root md');
  fs.writeFileSync(path.join(h.temp, 'unrelated-private.txt'), 'never read this');
  const initial = await h.capture();
  const result = await h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId,
    skills: [{ name: 'selected', filePath: path.join(selected, 'SKILL.md'), baseDir: selected }, { name: 'one', filePath: rootMd, baseDir: h.temp }] });
  assert.equal(result.captured, true, result.reason);
  const cp = result.checkpoint;
  assert.equal(cp.stats.skippedCount, 2);
  assert.equal(h.service.latestCaptureMetrics('p').status, 'partial');
  assert.equal(h.service.latestCaptureMetrics('p').skippedCount, 2);
  assert.deepEqual(cp.uncaptured.map(g => g.reason).sort(), ['file_size_limit', 'reparse_point_skipped']);
  const markdown = cp.gitSnapshot.projectSkills.find(s => s.originalPath === rootMd);
  assert.deepEqual(Object.keys(markdown.files), ['one.md']); assert.equal(markdown.rootKind, 'file');
  assert.equal(cp.replayInput.complete, false);
});

test('late SDK resource enrichment cannot replace a newer turn result', async t => {
  const h = fixture(t), first = await h.capture(), second = await h.capture();
  const previous = h.service.latestCaptureMetrics('p'); assert.equal(previous.checkpointId, second.checkpointId);
  const result = await h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: first.checkpointId, skills: [] });
  assert.equal(result.captured, true); assert.deepEqual(h.service.latestCaptureMetrics('p'), previous);
});

test('skill resource budget skips only excess files, and malformed SDK paths are honest gaps', t => {
  const h = fixture(t), root = path.join(h.temp, 'skill'); fs.mkdirSync(root);
  for (const file of ['SKILL.md', 'a', 'b']) fs.writeFileSync(path.join(root, file), '1234');
  const { collectLoadedProjectSkills } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot');
  const result = collectLoadedProjectSkills({ skills: [{ name: 'skill', filePath: path.join(root, 'SKILL.md') }, { name: 'invalid', filePath: 'relative/SKILL.md' }],
    limits: { untrackedBytes: 8 } });
  assert.deepEqual(Object.keys(result.projectSkills[0].files), ['SKILL.md', 'a']);
  assert.deepEqual(result.uncaptured.map(g => g.reason).sort(), ['project_skill_path_invalid', 'skill_total_size_limit']);
});

test('SDK archiving spends only the repository budget remainder and returns a durable partial checkpoint on timeout', async t => {
  let now = 0;
  const h = fixture(t, { captureNow: () => now });
  const selected = path.join(h.temp, 'skill'); fs.mkdirSync(selected);
  fs.writeFileSync(path.join(selected, 'SKILL.md'), 'skill');
  fs.writeFileSync(path.join(selected, 'a-slow.txt'), 'slow'); fs.writeFileSync(path.join(selected, 'b-not-read.txt'), 'never read');
  fs.writeFileSync(path.join(h.root, 'slow.txt'), 'repository file');
  const read = fs.readFileSync, reads = [];
  fs.readFileSync = function(filename, ...args) {
    const bytes = read.call(this, filename, ...args);
    if (String(filename) === path.join(h.root, 'slow.txt')) now += 10000;
    if (path.dirname(String(filename)) === selected) reads.push(path.basename(String(filename)));
    if (String(filename) === path.join(selected, 'a-slow.txt')) now += 6000;
    return bytes;
  };
  let initial, result;
  try {
    initial = await h.capture();
    // SDK initialization is not capture work. The remaining allowance, rather
    // than a fresh 15 seconds or startup elapsed time, belongs to skill IO.
    now += 100000;
    result = await h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId,
      skills: [{ name: 'selected', filePath: path.join(selected, 'SKILL.md') }] });
  } finally { fs.readFileSync = read; }
  assert.equal(result.captured, true, result.reason);
  const cp = result.checkpoint;
  assert.equal(initial.checkpoint.gitSnapshot.captureTimeRemainingMs, 5000);
  assert.deepEqual(reads, ['SKILL.md', 'a-slow.txt'], 'the skill phase must not get a fresh 15-second budget');
  assert.deepEqual(Object.keys(cp.gitSnapshot.projectSkills[0].files), ['SKILL.md'], 'keep the resource prefix on timeout');
  assert.equal(cp.gitSnapshot.skillInventoryStatus, 'loaded', 'inventory was available, resource capture was partial');
  assert.ok(cp.uncaptured.some(g => g.reason === 'capture_time_limit'));
  assert.ok(cp.replayInput.incompleteReasons.includes('capture_time_limit'));
  assert.ok(!cp.replayInput.incompleteReasons.includes('project_skills_pending'));
  assert.equal(cp.replayInput.complete, false);
  assert.equal(cp.gitSnapshot.captureTimeRemainingMs, 0);
  assert.equal(h.service.latestCaptureMetrics('p').status, 'partial');
  assert.equal(h.service.loadPolicy('p').status, 'enabled');
});

test('missing SDK inventory is explicit, and disabling while SDK initializes prevents all resource reads', async t => {
  const h = fixture(t), initial = await h.capture();
  const failed = await h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId, skills: null });
  assert.equal(failed.captured, true, failed.reason);
  assert.ok(failed.checkpoint.replayInput.incompleteReasons.includes('project_skills_unavailable'));
  h.service.savePolicy('p', { ...h.service.loadPolicy('p'), status: 'disabled' });
  const before = h.service.computeUsage('p').totalBytes;
  const disabled = await h.service.captureLoadedProjectSkills({ projectId: 'p', checkpointId: initial.checkpointId,
    skills: [{ filePath: path.join(h.temp, 'do-not-read', 'SKILL.md') }] });
  assert.equal(disabled.captured, false); assert.equal(disabled.reason, 'policy_not_enabled');
  assert.equal(h.service.computeUsage('p').totalBytes, before);
});
