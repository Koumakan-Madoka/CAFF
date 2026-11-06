// Owned filesystem / memory only. No production directories, model or credentials.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { inspectPortableAgentConfig } = require(base + 'portable-inputs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-gaps-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'room'), agentDir = path.join(root, 'agent'); fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  const config = { cwd, agentDir, provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'xhigh', fast: true, resume: false,
    retireUserScopeSkills: true, additionalSkillPaths: [], extensionPaths: [path.resolve('lib/pi-extensions/caff-capabilities.mjs')] };
  return { root, cwd, agentDir, config };
}
test('v2 reports per-resource gaps without reading contents; Fast is disclosed rather than replayed, v1 unchanged', t => {
  const h = fixture(t); fs.writeFileSync(path.join(h.agentDir, 'settings.json'), 'not read'); fs.writeFileSync(path.join(h.root, 'AGENTS.md'), 'not read');
  fs.mkdirSync(path.join(h.cwd, '.pi')); fs.writeFileSync(path.join(h.cwd, '.pi/settings.json'), 'not read');
  const original = fs.readFileSync; fs.readFileSync = () => assert.fail('declaration must not read file contents'); let v;
  try { v = inspectPortableAgentConfig(h.config, { archivedSkills: true }); } finally { fs.readFileSync = original; }
  assert.equal(v.supported, true); assert.equal(v.kind, 'portable-captured-project-resources-v1');
  for (const reason of ['fast_mode_not_replayed', 'agent_resource_not_archived', 'ancestor_resource_unverified', 'project_resource_not_replayed']) assert.ok(v.portableGaps.some(g => g.reason === reason), reason);
  assert.equal(inspectPortableAgentConfig(h.config).supported, false);
  for (const patch of [{ thinking: 'high' }, { extensionPaths: ['/other/plugin.mjs'] }]) assert.equal(inspectPortableAgentConfig({ ...h.config, ...patch }, { archivedSkills: true }).supported, false);
});
test('v2 archives actual loaded context paths as bounded file resources, not as discovered skills', t => {
  const h = fixture(t), filePath = path.join(h.root, 'AGENTS.md'); fs.writeFileSync(filePath, 'SDK context');
  const value = require(base + 'git-snapshot').collectLoadedProjectSkills({ skills: [], contextFiles: [{ path: filePath, content: 'SDK context' }], knownKeyValues: [] });
  assert.deepEqual(value.loadedSkills, []); assert.deepEqual(value.loadedContexts, [{ filePath }]);
  const archived = value.projectSkills.find(s => s.originalPath === filePath); assert.ok(archived); assert.equal(archived.rootKind, 'file');
  assert.equal(value.blobs.get(archived.files['AGENTS.md'].hash).toString(), 'SDK context');
});
test('captured context adapter feeds archived bytes before SDK session creation, never ambient context or source files', async () => {
  const resources = require(base + 'project-resources'), bytes = Buffer.from('Archived context');
  const name = '.caff-replay-skills/posix/source/AGENTS.md', files = [{ path: name, base64: bytes.toString('base64'), sha256: hash(bytes) }];
  const manifest = { contextFiles: [name] }; let created = 0;
  const original = { async createAgentSessionServices() { created++; return { resourceLoader: { getAgentsFiles: () => ({ agentsFiles: [{ path: '/source/live', content: 'wrong' }] }) } }; } };
  const sdk = resources.sdkWithCapturedContexts(original, manifest, files, '/work/restored');
  const services = await sdk.createAgentSessionServices({}); assert.equal(created, 1);
  assert.deepEqual(services.resourceLoader.getAgentsFiles().agentsFiles, [{ path: '/work/restored/' + name, content: 'Archived context' }]);
  const ambient = await original.createAgentSessionServices({}); assert.equal(ambient.resourceLoader.getAgentsFiles().agentsFiles[0].content, 'wrong');
});
test('native SDK builds its initial system prompt from the captured external context, with no model invocation', async t => {
  const h = fixture(t), resources = require(base + 'project-resources'), sdk = await import('@earendil-works/pi-coding-agent');
  const host = await import('../../build/lib/pi-sdk-host.mjs'), bytes = Buffer.from('CAPTURED_CONTEXT_MARKER_ONLY');
  const name = '.caff-replay-skills/posix/source/AGENTS.md', files = [{ path: name, base64: bytes.toString('base64'), sha256: hash(bytes) }];
  const facade = resources.sdkWithCapturedContexts(sdk, { contextFiles: [name] }, files, h.cwd);
  const { runtime } = await host.createSdkRuntime(facade, { ...h.config, provider: 'anthropic', model: 'claude-sonnet-4-5', thinking: 'off', fast: false, sessionPath: path.join(h.root, 'session.jsonl') });
  try { assert.match(runtime.session.agent.state.systemPrompt, /CAPTURED_CONTEXT_MARKER_ONLY/); assert.equal(runtime.session.messages.length, 0); }
  finally { await runtime.dispose(); }
});
