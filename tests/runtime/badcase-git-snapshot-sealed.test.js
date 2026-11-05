// New-format sealed preparation using real disposable Git objects. No model/Docker/SDK.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { collectGitSnapshot } = require('../../build/server/domain/runtime/badcase-capture/git-snapshot');
const { prepareSealedOriginalTurn, prepareSealedDirectTurn } = require('../../scripts/badcase-capture/sealed-direct-input.cjs');
const { prepareComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
async function sealed(t, { knownValues = [], change = () => {}, projectResources = false, externalSkills = false, baseText = 'HEAD base\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-sealed-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'base.txt'), baseText); fs.writeFileSync(path.join(root, 'source.txt'), 'before capture\n'); fs.writeFileSync(path.join(root, 'deleted.txt'), 'gone\n');
  const resourcePaths = ['AGENTS.md', '.agents/skills/local/SKILL.md'];
  if (projectResources) { fs.mkdirSync(path.join(root, '.agents/skills/local'), { recursive: true }); fs.writeFileSync(path.join(root, resourcePaths[0]), 'context'); fs.writeFileSync(path.join(root, resourcePaths[1]), 'skill'); }
  git('add', '-A'); git('-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '-qm', 'base');
  const head = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'source.txt'), 'captured edit\n' + knownValues.join('\n')); fs.unlinkSync(path.join(root, 'deleted.txt')); fs.writeFileSync(path.join(root, 'untracked.bin'), Buffer.from([0, 255, 1]));
  const external = externalSkills ? fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-external-skills-')) : null;
  const sdkSkills = [], promptSkills = [];
  if (external) {
    t.after(() => fs.rmSync(external, { recursive: true, force: true }));
    for (const name of ['sdk', 'prompt', 'both']) {
      const baseDir = path.join(external, name), filePath = path.join(baseDir, 'SKILL.md');
      fs.mkdirSync(path.join(baseDir, 'references'), { recursive: true });
      fs.writeFileSync(filePath, `---\nname: ${name}\ndescription: Fixture ${name}\n---\nRead references/guide.md\n`);
      fs.writeFileSync(path.join(baseDir, 'references/guide.md'), 'archived ' + name);
      const skill = { name, filePath, baseDir };
      if (name !== 'prompt') sdkSkills.push(skill);
      if (name !== 'sdk') promptSkills.push(skill);
    }
  }
  const snapshot = await collectGitSnapshot({ targetDir: root, knownKeyValues: knownValues,
    projectSkillPaths: external ? ['sdk', 'prompt', 'both'].map(n => path.join(external, n)) : projectResources ? [path.join(root, '.agents/skills/local')] : [] });
  assert.equal(snapshot.ok, true, snapshot.reason);
  if (external) Object.assign(snapshot.gitSnapshot, { skillInventoryStatus: 'loaded', loadedSkills: [...new Map([...sdkSkills, ...promptSkills].map(s => [s.filePath, s])).values()], sdkLoadedSkills: sdkSkills, promptLoadedSkills: promptSkills });
  const f = fixture(t, 'fresh', ({ cp, r, config, put }) => {
    cp.schemaVersion = 2; cp.targetDir = root; cp.gitSnapshot = snapshot.gitSnapshot; cp.files = snapshot.files; cp.deletions = snapshot.deletions; cp.uncaptured = snapshot.uncaptured;
    for (const bytes of snapshot.blobs.values()) put(bytes);
    config.toolBridgeEnabled = true;
    config.portableRuntime = projectResources ? { schemaVersion: 1, kind: 'portable-project-resources-v1', supported: true,
      filePaths: [...resourcePaths].sort(), skillPaths: ['.agents/skills/local'] } : { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: true };
    config.sdkStartConfig = { cwd: root, provider: r.runConfig.provider, model: r.runConfig.model, resume: false, thinking: 'off', fast: false,
      retireUserScopeSkills: true, additionalSkillPaths: external ? sdkSkills.map(s => s.baseDir) : projectResources ? [path.join(root, '.agents/skills/local')] : [] };
    if (external) {
      const agentDir = path.join(external, 'agent'); fs.mkdirSync(agentDir);
      Object.assign(config.sdkStartConfig, { agentDir, extensionPaths: [path.resolve('lib/pi-extensions/caff-capabilities.mjs')] });
      config.portableRuntime = require('../../build/server/domain/runtime/badcase-capture/portable-inputs').inspectPortableAgentConfig(config.sdkStartConfig, { archivedSkills: true });
      r.promptBlobHash = r.normalizedPromptHash = put('Read ' + promptSkills.map(s => s.filePath).join(' and '));
    }
    const association = { projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', userMessageId: 'u1', assistantMessageId: 'msg1' };
    const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association, assistantCreatedAt: '2026-01-01T00:00:01.000Z',
      conversation: { title: 'Synthetic', type: 'standard', metadata: {} }, participants: [{ id: 'a1', name: config.agentName, description: 'Synthetic' }], publicMessages: [
        { id: 'u1', turnId: 't0', role: 'user', agentId: null, senderName: 'User', content: 'Inspect.', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z',
          publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] };
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(JSON.stringify(trace)), association };
    change({ cp, r, config, put }); r.harness.configSnapshotHash = put(JSON.stringify(config));
  });
  return { ...f, repositoryRoot: root, head, git, external, sdkSkills, promptSkills };
}
const planConfig = f => ({ request: f.request, variants: ['original'], repeats: 1, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'),
  image: { imageId: 'sha256:' + '1'.repeat(64) }, rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['captured edit'], notContains: [] }] } });

test('sealed v2 prepares a complete HEAD tree plus patch/overlays, not only the sparse cp.files inventory', async t => {
  const f = await sealed(t), before = fs.readFileSync(f.source), sourceBefore = f.git('status', '--porcelain=v1', '-uall');
  fs.writeFileSync(path.join(f.repositoryRoot, 'source.txt'), 'later live bytes');
  const liveStatus = f.git('status', '--porcelain=v1', '-uall'), result = prepareSealedOriginalTurn(f.request);
  assert.equal(result.supported, true, JSON.stringify(result));
  const files = new Map(result.input.files.map(f => [f.path, Buffer.from(f.base64, 'base64')]));
  assert.equal(files.get('base.txt').toString(), 'HEAD base\n'); assert.equal(files.get('source.txt').toString(), 'captured edit\n');
  assert.deepEqual(files.get('untracked.bin'), Buffer.from([0, 255, 1])); assert.equal(files.has('deleted.txt'), false);
  assert.deepEqual(result.input.deletions, ['deleted.txt']); assert.equal(result.provenance.sourceSnapshot.head, f.head);
  assert.equal(result.provenance.strictEvalEligible, false); assert.deepEqual(fs.readFileSync(f.source), before);
  assert.equal(f.git('status', '--porcelain=v1', '-uall'), liveStatus); assert.equal(sourceBefore, liveStatus);
});

test('v2 known-only policy preserves token-like examples and passes host known literals to HEAD materialization', async t => {
  const marker = 'snapshot-inert-selected-value', f = await sealed(t, { knownValues: [marker], baseText: marker + '\n', change({ cp, put }) {
    const bytes = Buffer.from('sk-FAKE_EXAMPLE_ONLY'); cp.files['example.txt'] = { type: 'file', hash: put(bytes), size: bytes.length, mode: 0o100644, origin: 'untracked' };
  } });
  const result = prepareSealedOriginalTurn(f.request, { knownKeyValues: [marker] }); assert.equal(result.supported, true, JSON.stringify(result));
  assert.equal(Buffer.from(result.input.files.find(f => f.path === 'example.txt').base64, 'base64').toString(), 'sk-FAKE_EXAMPLE_ONLY');
  assert.equal(JSON.stringify(result.input).includes(marker), false);
  assert.equal(Buffer.from(result.input.files.find(f => f.path === 'base.txt').base64, 'base64').toString(), '[*]\n');
  const comparison = prepareComparison(planConfig(f), { knownValues: [marker] }); assert.equal(comparison.supported, true, JSON.stringify(comparison));
  assert.equal(Buffer.from(comparison.inputs.original.files.find(f => f.path === 'base.txt').base64, 'base64').toString(), '[*]\n');
});

test('v2 original/candidate variants share the same materialized scene and change only the declared role span', async t => {
  const role = 'Your private persona instructions:\nRead only.', prefix = 'Header\n';
  const f = await sealed(t, { change({ r, put }) {
    r.promptBlobHash = r.normalizedPromptHash = put(prefix + role + '\nTask');
    r.roleSpan = { start: prefix.length, end: prefix.length + role.length, sha256: require('node:crypto').createHash('sha256').update(role).digest('hex') };
  } });
  const a = prepareSealedDirectTurn(f.request), b = prepareSealedDirectTurn(f.request, 'Verify before reporting.');
  assert.equal(a.supported, true, JSON.stringify(a)); assert.equal(b.supported, true, JSON.stringify(b));
  assert.equal(a.provenance.commonInputHash, b.provenance.commonInputHash); assert.deepEqual(a.provenance.sourceSnapshot, b.provenance.sourceSnapshot);
  assert.deepEqual({ ...a.input, prompt: '' }, { ...b.input, prompt: '' });
  assert.equal(b.input.prompt, a.input.prompt.replace('Read only.', 'Verify before reporting.'));
});

test('in-cwd v2 skills use materialized files and the existing resource manifest without changing native loader behavior', async t => {
  const f = await sealed(t, { projectResources: true }), result = prepareSealedOriginalTurn(f.request);
  assert.equal(result.supported, true, JSON.stringify(result)); assert.deepEqual(result.input.projectResources.skillPaths, ['.agents/skills/local']);
  assert.equal(result.input.projectResources.files.length, 2); assert.equal(result.input.projectResources.contextFile, 'AGENTS.md');
});

test('v2 external skills are mirrored from captured bytes, bind original paths and preserve SDK/prompt origins', async t => {
  const f = await sealed(t, { externalSkills: true });
  // Source files may disappear after sealing: no current bytes may fill a gap.
  fs.rmSync(f.external, { recursive: true, force: true });
  const result = prepareSealedOriginalTurn(f.request); assert.equal(result.supported, true, JSON.stringify(result));
  const manifest = result.input.projectResources;
  assert.equal(manifest.kind, 'replay-captured-project-resources-v1');
  assert.equal(manifest.skills.length, 3); assert.equal(manifest.skillPaths.length, 2);
  assert.equal(manifest.skills.filter(s => s.origins.includes('sdk')).length, 2);
  assert.equal(manifest.skills.filter(s => s.origins.includes('prompt')).length, 2);
  const prompt = manifest.skills.find(s => s.name === 'prompt');
  assert.equal(manifest.skillPaths.includes(prompt.path), false);
  for (const skill of manifest.skills) {
    assert.ok(result.input.files.some(f => f.path === skill.path));
    const guide = result.input.files.find(f => f.path === skill.path.replace(/SKILL.md$/, 'references/guide.md'));
    assert.equal(Buffer.from(guide.base64, 'base64').toString(), 'archived ' + skill.name);
  }
  assert.equal(result.input.bindings.projectSkills.length, 3);
  const values = Object.fromEntries(['CAFF_CHAT_API_URL', 'CAFF_CHAT_INVOCATION_ID', 'CAFF_CHAT_CALLBACK_TOKEN', 'CAFF_CHAT_CONVERSATION_ID', 'CAFF_CHAT_TURN_ID', 'CAFF_CHAT_TOOLS_PATH', 'CAFF_CHAT_TOOLS_RELATIVE_PATH', 'PI_AGENT_SANDBOX_DIR', 'PI_AGENT_PRIVATE_DIR'].map(n => [n, 'isolated']));
  const bound = require('../../scripts/badcase-capture/direct-model.cjs').bindDirectInputs(result.input.prompt, null, result.input.bindings, values);
  const mirroredPaths = f.promptSkills.map(skill => '/work/restored/' + manifest.skills.find(s => s.name === skill.name).path);
  assert.equal(bound.prompt, 'Read ' + mirroredPaths.join(' and '));
  // POSIX mirrors contain the original absolute path under posix/. Remove only
  // complete expected replay paths before checking for leaked source paths.
  const unmappedPrompt = mirroredPaths.reduce((text, mirror) => text.replaceAll(mirror, ''), bound.prompt);
  assert.equal(unmappedPrompt.includes(f.external), false);
  const plan = prepareComparison(planConfig(f)); assert.equal(plan.supported, true, JSON.stringify(plan));
  const configFile = path.join(f.root, 'external-plan.json'); fs.writeFileSync(configFile, JSON.stringify(planConfig(f)));
  const cliPlan = JSON.parse(execFileSync(process.execPath, [path.resolve('scripts/badcase-capture/compare-sealed.cjs'), '--config', configFile, '--plan'], { encoding: 'utf8' }));
  assert.equal(cliPlan.supported, true, JSON.stringify(cliPlan)); assert.equal(cliPlan.projectResources.fileCount, 6);
  // Native SDK skill discovery, no runtime/model/auth initialization. Only the
  // archived SDK origins become additional paths; prompt-only bytes stay data.
  const cwd = path.join(f.root, 'native-loader'); fs.mkdirSync(cwd);
  for (const entry of result.input.files) {
    const dest = path.join(cwd, entry.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, Buffer.from(entry.base64, 'base64'));
  }
  const sdk = await import('@earendil-works/pi-coding-agent');
  const loaded = sdk.loadSkills({ cwd, agentDir: path.join(f.root, 'empty-agent'), includeDefaults: false, skillPaths: manifest.skillPaths.map(p => path.join(cwd, p)) });
  assert.deepEqual(loaded.skills.map(s => s.name).sort(), ['both', 'sdk']);
  const portableSkills = loaded.skills.map(s => ({ ...s, filePath: s.filePath.replaceAll('\\', '/') }));
  const verified = require('../../build/server/domain/runtime/badcase-capture/project-resources').verifyLoadedProjectResources(manifest, result.input.files,
    { getAgentsFiles: () => ({ agentsFiles: [] }), getSkills: () => ({ skills: portableSkills }) }, cwd.replaceAll('\\', '/'));
  assert.equal(verified.loadedSkills, 2);
});

for (const [label, change] of [
  ['missing SDK origin evidence', ({ cp }) => { delete cp.gitSnapshot.sdkLoadedSkills; }],
  ['missing prompt origin evidence', ({ cp }) => { delete cp.gitSnapshot.promptLoadedSkills; }],
  ['unarchived loaded skill', ({ cp }) => { cp.gitSnapshot.sdkLoadedSkills[0].filePath += '.missing'; }],
]) test('v2 refuses ' + label + ' instead of guessing skill discovery', async t => {
  const f = await sealed(t, { externalSkills: true, change });
  assert.deepEqual(prepareSealedOriginalTurn(f.request), { supported: false, reason: 'replay_project_resources_invalid' });
});

test('v2 optional Git metadata must use its recorded HEAD, never a later operator-selected commit', async t => {
  const f = await sealed(t); f.git('-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.local', 'commit', '--allow-empty', '-qm', 'later HEAD');
  const config = { ...planConfig(f), repository: { sourceRoot: f.repositoryRoot, head: f.git('rev-parse', 'HEAD') } };
  assert.throws(() => prepareComparison(config, { knownValues: [] }), e => e.code === 'evaluation_repository_head_mismatch');
  config.repository.head = f.head;
  const plan = prepareComparison(config, { knownValues: [] }); assert.equal(plan.supported, true, JSON.stringify(plan));
  assert.equal(plan.inputs.original.repository.sourceHead, f.head); assert.equal(plan.inputs.original.repository.restoredHead, f.head);
  assert.ok(plan.inputs.original.gitFiles.length >= 5);
});

test('actual compare-sealed --plan accepts a fresh v2 checkpoint without starting Docker or reading model credentials', async t => {
  const f = await sealed(t), file = path.join(f.root, 'plan.json'); fs.writeFileSync(file, JSON.stringify(planConfig(f)));
  const result = JSON.parse(execFileSync(process.execPath, [path.resolve('scripts/badcase-capture/compare-sealed.cjs'), '--config', file, '--plan'], { encoding: 'utf8' }));
  assert.equal(result.supported, true, JSON.stringify(result)); assert.equal(result.preparedOnly, true); assert.equal(result.dockerVerified, false);
  assert.equal(result.sourceSnapshot.head, f.head); assert.equal(result.sourceSnapshot.fileCount, 3);
  const plan = prepareComparison(planConfig(f)); assert.equal(plan.supported, true); assert.equal(plan.inputs.original.files.length, 3);
});

for (const [label, change, reason] of [
  ['missing HEAD', ({ cp }) => { cp.gitSnapshot.head = '0'.repeat(40); }, 'replay_git_snapshot_head_unavailable'],
  ['missing patch', () => {}, 'replay_blob_unavailable_or_invalid'],
  ['legacy v2 missing EOL evidence', ({ cp }) => { delete cp.gitSnapshot.crlfPaths; }, 'replay_git_snapshot_eol_unavailable'],
  ['skipped file', ({ cp }) => { cp.uncaptured = [{ path: 'source.txt', reason: 'file_unreadable' }]; }, 'replay_uncaptured_files'],
]) test(`v2 refuses ${label} with an explicit reason, never overlay-only success`, async t => {
  const f = await sealed(t, { change });
  if (label === 'missing patch') fs.unlinkSync(f.blobPath(f.cp.gitSnapshot.patchBlobHash));
  const result = prepareSealedOriginalTurn(f.request); assert.deepEqual(result, { supported: false, reason });
});
