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
    fs.mkdirSync(path.join(cwd, '.pi')); assert.equal(inspectPortableAgentConfig(config).supported, false); fs.rmdirSync(path.join(cwd, '.pi'));
    fs.mkdirSync(path.join(cwd, '.agents')); assert.equal(inspectPortableAgentConfig(config).supported, false); fs.rmdirSync(path.join(cwd, '.agents'));
  } finally { fs.readFileSync = original; }
  for (const changed of [{ resume: 'true' }, { thinking: 'high' }, { fast: true }, { retireUserScopeSkills: false }, { extensionPaths: ['/other/plugin.mjs'] }, { additionalSkillPaths: [top] }]) {
    assert.equal(inspectPortableAgentConfig({ ...config, ...changed }).supported, false);
  }
});
