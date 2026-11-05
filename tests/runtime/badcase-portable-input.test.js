const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { prepareReplayInput } = require('../../build/server/domain/runtime/badcase-capture/replay-input-preparation');
let inspectPortableAgentConfig;
try { ({ inspectPortableAgentConfig } = require('../../build/server/domain/runtime/badcase-capture/portable-inputs')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function input() {
  return { prompt: 'header\n\nYour private persona instructions:\n请只读文件。\n\nuser task', roleSection: 'Your private persona instructions:\n请只读文件。',
    runConfig: { provider: 'p', model: 'm', promptVersion: 'v', skillIds: [], conversationSkillIds: [] },
    harness: { serverVersion: 'test', configSnapshot: { agentPromptVersion: 'v', toolBridgeEnabled: true, piVersion: '0.85.1', deliveryMode: 'fresh', agentName: 'A' } } };
}
test('role span is bound to the normalized invocation, not a new system prompt; legacy/delta/ambiguous roles stay absent', () => {
  const i = input(); const r = prepareReplayInput(i, 'fresh', '/', () => assert.fail()).replayInput;
  assert.deepEqual(r.roleSpan, { start: i.prompt.indexOf(i.roleSection), end: i.prompt.indexOf(i.roleSection) + i.roleSection.length, sha256: sha(i.roleSection) });
  for (const change of [v => { delete v.roleSection; }, v => { v.roleSection = ''; }, v => { v.prompt += '\n' + v.roleSection; }, v => { v.prompt = 'delta only'; }]) {
    const v = input(); change(v); assert.equal(prepareReplayInput(v, 'fresh', '/', () => assert.fail()).replayInput.roleSpan ?? null, null);
  }
  const controlled = input(); controlled.roleSection += ' /source/cli'; controlled.prompt = 'prefix\n' + controlled.roleSection + '\nsuffix';
  controlled.controlledValues = { CAFF_CHAT_TOOLS_PATH: '/source/cli' };
  const prepared = prepareReplayInput(controlled, 'fresh', '/', () => assert.fail()), replay = prepared.replayInput;
  const prompt = prepared.plans.find(p => p.hash === replay.promptBlobHash).content.toString();
  assert.equal(prompt.slice(replay.roleSpan.start, replay.roleSpan.end), controlled.roleSection.replace('/source/cli', '{{CAFF_CHAT_TOOLS_PATH}}'));
  assert.equal(sha(prompt.slice(replay.roleSpan.start, replay.roleSpan.end)), replay.roleSpan.sha256);
  const secret = input(); secret.prompt += ' sk-' + 'x'.repeat(32);
  assert.equal(prepareReplayInput(secret, 'fresh', '/', () => assert.fail()).replayInput.roleSpan ?? null, null);
});
test('portable project resources declare a complete in-root inventory and relative explicit skill paths without reading contents', t => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-project-')), cwd = path.join(top, 'project'), agentDir = path.join(top, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir); t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const paths = ['AGENTS.md', '.agents/skills/demo/SKILL.md', '.agents/skills/demo/references/guide.md', '.pi/skills/other/SKILL.md'];
  for (const p of paths) { fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true }); fs.writeFileSync(path.join(cwd, p), 'archived instructions'); }
  const config = { cwd, agentDir, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true,
    extensionPaths: [path.resolve('lib/pi-extensions/caff-capabilities.mjs')], additionalSkillPaths: [path.join(cwd, '.agents/skills/demo')] };
  const read = fs.readFileSync; fs.readFileSync = () => assert.fail('declaration must not read instructions');
  let declaration;
  try { declaration = inspectPortableAgentConfig(config); } finally { fs.readFileSync = read; }
  assert.deepEqual(declaration, { schemaVersion: 1, kind: 'portable-project-resources-v1', supported: true,
    filePaths: paths.sort(), skillPaths: ['.agents/skills/demo'] });
  const { prepareProjectResources } = require('../../build/server/domain/runtime/badcase-capture/project-resources');
  const files = paths.map(p => ({ path: p, sha256: sha('archived instructions') }));
  const manifest = prepareProjectResources(declaration, files, config);
  assert.equal(manifest.files.length, 4); assert.equal(manifest.contextFile, 'AGENTS.md');
  assert.deepEqual(manifest.skillPaths, ['.agents/skills/demo']); assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);
  assert.throws(() => prepareProjectResources(declaration, files.slice(1), config), /replay_project_resources_invalid/);
  assert.throws(() => prepareProjectResources(declaration, [...files, { path: '.pi/settings.json', sha256: sha('{}') }], config), /replay_project_resources_invalid/);
  assert.throws(() => prepareProjectResources(declaration, files, { ...config, additionalSkillPaths: [top] }), /replay_project_resources_invalid/);
  for (const name of ['.pi', '.agents', '.PI/skills/hidden/SKILL.md', '.pi/extensions/code.js', 'agents.md']) {
    assert.throws(() => prepareProjectResources(declaration, [...files, { path: name, sha256: sha('unexpected') }], config), /replay_project_resources_invalid/);
  }
  fs.writeFileSync(path.join(cwd, '.pi/settings.json'), '{}'); assert.equal(inspectPortableAgentConfig(config).supported, false); fs.unlinkSync(path.join(cwd, '.pi/settings.json'));
  const external = path.join(top, 'external'); fs.mkdirSync(external);
  assert.equal(inspectPortableAgentConfig({ ...config, additionalSkillPaths: [external] }).supported, false);
  fs.writeFileSync(path.join(top, 'CLAUDE.MD'), 'external context'); assert.equal(inspectPortableAgentConfig(config).supported, false);
});
test('captured-skill declaration inventories only cwd and preserves explicit roots without reading skill content', t => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-captured-')), cwd = path.join(top, 'room'), agentDir = path.join(top, 'agent'), external = path.join(top, 'project/.agents/skills/demo');
  for (const p of [cwd, agentDir, external]) fs.mkdirSync(p, { recursive: true });
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'context'); fs.writeFileSync(path.join(external, 'SKILL.md'), 'external instructions');
  const config = { cwd, agentDir, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true,
    extensionPaths: [path.resolve('lib/pi-extensions/caff-capabilities.mjs')], additionalSkillPaths: [external] };
  const read = fs.readFileSync; fs.readFileSync = () => assert.fail('declaration must not read instructions');
  try {
    assert.deepEqual(inspectPortableAgentConfig(config, { archivedSkills: true }), { schemaVersion: 1,
      kind: 'portable-captured-project-resources-v1', supported: true, filePaths: ['AGENTS.md'], skillPaths: [external] });
    assert.equal(inspectPortableAgentConfig(config).supported, false, 'legacy declaration is unchanged');
    for (const patch of [{ fast: true }, { additionalSkillPaths: ['relative'] }, { extensionPaths: ['/other/plugin.mjs'] }]) {
      assert.equal(inspectPortableAgentConfig({ ...config, ...patch }, { archivedSkills: true }).supported, false);
    }
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{}');
    assert.equal(inspectPortableAgentConfig(config, { archivedSkills: true }).supported, false);
  } finally { fs.readFileSync = read; }
});

test('captured declaration and manifest accept over 1024 archived resource files without changing the legacy subset', t => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-resource-count-')), cwd = path.join(top, 'room'), agentDir = path.join(top, 'agent');
  const skills = path.join(cwd, '.agents/skills/demo'); fs.mkdirSync(skills, { recursive: true }); fs.mkdirSync(agentDir);
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const files = Array.from({ length: 1025 }, (_, i) => ({ path: '.agents/skills/demo/' + i + '.md', sha256: sha('bytes') }));
  for (const f of files) fs.writeFileSync(path.join(cwd, f.path), 'bytes');
  const config = { cwd, agentDir, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true,
    extensionPaths: [path.resolve('lib/pi-extensions/caff-capabilities.mjs')], additionalSkillPaths: [] };
  assert.equal(inspectPortableAgentConfig(config).supported, false);
  const declaration = inspectPortableAgentConfig(config, { archivedSkills: true }); assert.equal(declaration.supported, true);
  const prepared = require('../../build/server/domain/runtime/badcase-capture/project-resources').prepareCapturedProjectResources(declaration, files, config,
    { targetDir: cwd, gitSnapshot: { skillInventoryStatus: 'loaded', sdkLoadedSkills: [], promptLoadedSkills: [] } }, { projectSkills: [] });
  assert.equal(prepared.manifest.files.length, 1025);
});

test('project inventory refuses symlinks and excessive resource trees without reading target bytes', { skip: process.platform === 'win32' ? 'symlink creation needs a separately authorized Windows privilege' : false }, t => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-links-')), cwd = path.join(top, 'project'), agentDir = path.join(top, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir); t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const config = { cwd, agentDir, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true,
    extensionPaths: [path.resolve('lib/pi-extensions/caff-capabilities.mjs')], additionalSkillPaths: [] };
  fs.mkdirSync(path.join(cwd, '.agents/skills/demo'), { recursive: true });
  fs.symlinkSync(path.join(top, 'outside'), path.join(cwd, '.agents/skills/demo/SKILL.md'));
  assert.equal(inspectPortableAgentConfig(config).supported, false); fs.unlinkSync(path.join(cwd, '.agents/skills/demo/SKILL.md'));
  for (let i = 0; i < 1025; i++) fs.writeFileSync(path.join(cwd, '.agents/skills/demo', i + '.md'), 'not read');
  assert.equal(inspectPortableAgentConfig(config).supported, false);
});
test('portable resource declaration only accepts absent external instructions/settings; never reads their content', t => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-config-')), cwd = path.join(top, 'project'), agentDir = path.join(top, 'agent');
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir); t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const config = { cwd, agentDir, resume: false, thinking: 'off', fast: false, retireUserScopeSkills: true,
    extensionPaths: [path.resolve('lib/pi-extensions/caff-capabilities.mjs')], additionalSkillPaths: [path.join(cwd, '.agents/skills/missing')] };
  assert.equal(inspectPortableAgentConfig(config).supported, true);
  const production = { ...config, provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'xhigh' };
  assert.equal(inspectPortableAgentConfig(production).supported, true);
  assert.equal(inspectPortableAgentConfig({ ...production, resume: true }).supported, true);
  assert.equal(inspectPortableAgentConfig({ ...config, resume: true }).supported, true);
  for (const patch of [{ provider: 'other' }, { model: 'other' }, { thinking: 'high' }]) {
    assert.equal(inspectPortableAgentConfig({ ...production, ...patch }).supported, false);
  }
  const original = fs.readFileSync; fs.readFileSync = () => assert.fail('resource declaration must not read contents');
  try {
    for (const file of ['settings.json', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'extensions']) {
      const target = path.join(agentDir, file); fs.writeFileSync(target, 'private irrelevant bytes');
      assert.deepEqual(inspectPortableAgentConfig(config), { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: false }); fs.unlinkSync(target);
    }
    const ancestor = path.join(top, 'AGENTS.md'); fs.writeFileSync(ancestor, 'external context');
    assert.equal(inspectPortableAgentConfig(config).supported, false); fs.unlinkSync(ancestor);
    for (const name of ['.pi', '.agents']) {
      fs.mkdirSync(path.join(cwd, name)); assert.equal(inspectPortableAgentConfig(config).kind, 'portable-project-resources-v1');
      fs.writeFileSync(path.join(cwd, name, 'external-resource'), 'not a supported skill root');
      assert.equal(inspectPortableAgentConfig(config).supported, false); fs.unlinkSync(path.join(cwd, name, 'external-resource')); fs.rmdirSync(path.join(cwd, name));
    }
  } finally { fs.readFileSync = original; }
  for (const changed of [{ resume: 'true' }, { thinking: 'high' }, { fast: true }, { retireUserScopeSkills: false }, { extensionPaths: ['/other/plugin.mjs'] }, { additionalSkillPaths: [top] }]) {
    assert.equal(inspectPortableAgentConfig({ ...config, ...changed }).supported, false);
  }
});
