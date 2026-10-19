// Owned synthetic sealed capsule through the real store/sealing APIs. No SDK or capture.
const crypto = require('node:crypto');
const fixture = require('./badcase-initialization-fixture.cjs');
const sdkConfig = require('./badcase-sdk-config.cjs');
const { prepareRetainedInitializationCapsule } = require('../../build/server/domain/runtime/badcase-capture/retained-initialization');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
module.exports = function retainedCaffFixture(t, mode = 'fresh', platform = 'linux') {
  const root = platform === 'win32' ? 'C:\\source\\project' : '/source/project', sep = platform === 'win32' ? '\\' : '/';
  const ext = platform === 'win32' ? 'C:\\installed\\lib\\pi-extensions\\caff-capabilities.mjs' : '/installed/lib/pi-extensions/caff-capabilities.mjs';
  let sdk;
  const h = fixture(t, mode, ({ cp, r, config, session, put }) => {
    cp.targetDir = root; cp.files['source.txt'].mode = 0o100640;
    const skill = (name, marker) => `---\nname: ${name}\ndescription: ${marker}\n---\nArchived instructions.\n`;
    for (const [name, content] of [['.agent/settings.json', JSON.stringify({ defaultProjectTrust: 'always', enableInstallTelemetry: false,
      compaction: { enabled: true }, retry: { enabled: true, maxRetries: 7 } })],
      ['.agent/SYSTEM.md', 'RETAINED_ROLE_INSTRUCTIONS'], ['AGENTS.md', '# RETAINED_PROJECT_CONTEXT\n'],
      ['.agents/skills/project/SKILL.md', skill('retained-project', 'RETAINED_PROJECT_SKILL')],
      ['skills/contract/SKILL.md', skill('retained-contract', 'RETAINED_CONTRACT_SKILL')],
      ['.agent/skills/retired/SKILL.md', skill('retained-retired', 'RETAINED_RETIRED_SKILL')]]) {
      cp.files[name] = { type: 'file', mode: 0o100600, size: Buffer.byteLength(content), hash: put(content) };
    }
    r.runConfig.provider = 'openai'; r.runConfig.model = 'gpt-4o-mini'; config.toolBridgeEnabled = true;
    sdk = config.sdkStartConfig = sdkConfig(platform, r.runConfig.provider, r.runConfig.model, { thinking: 'off', agentDir: root + sep + '.agent',
      cwd: root, resume: mode === 'resume', session: 'chat-conv-turn-agent-default-abc123', heartbeatIntervalMs: 0,
      extensionPaths: [ext], additionalSkillPaths: [root + sep + 'skills' + sep + 'contract'], retireUserScopeSkills: true });
    r.harness.configSnapshotHash = put(JSON.stringify(config));
    r.promptBlobHash = r.normalizedPromptHash = put('Inspect ' + root);
    if (mode === 'resume') {
      session[0].cwd = root;
      session.splice(1, 0, { type: 'thinking_level_change', id: 'thinking', parentId: null, timestamp: '2026-01-01T00:00:00.001Z', thinkingLevel: 'off' });
      session[2].parentId = 'thinking';
      session.push({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:00.002Z', message: {
        role: 'assistant', content: [{ type: 'text', text: 'Retained assistant response.' }],
        api: 'openai-completions', provider: 'openai', model: 'gpt-4o-mini', stopReason: 'stop', timestamp: 2,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
      session.push({ type: 'custom_message', id: 'm3', parentId: 'm2', timestamp: '2026-01-01T00:00:00.003Z',
        customType: 'retained-context', content: 'Retained context message.', display: false });
      r.sessionBlobHash = put(session.map(e => JSON.stringify(e)).join('\r\n') + '\r\n');
    }
  });
  const p = prepareRetainedInitializationCapsule(h.request);
  const worktree = { schemaVersion: 1, sourcePlatform: platform, sourceRoot: root, mappings: [
    { input: 'prompt', start: 8, end: 8 + root.length, sourcePath: root },
    ...(mode === 'resume' ? [{ input: 'session', line: 0, pointer: '/cwd', start: 0, end: root.length, sourcePath: root }] : [])] };
  const bindings = [['/cwd', sdk.cwd, '/work/restored/snapshot'], ['/agentDir', sdk.agentDir, '/work/restored/snapshot/.agent'],
    ['/extensionPaths/0', ext, '/work/build/lib/pi-extensions/caff-capabilities.mjs'],
    ['/additionalSkillPaths/0', sdk.additionalSkillPaths[0], '/work/restored/snapshot/skills/contract'],
    ['/sessionPath', sdk.sessionPath, '/work/restored/working-inputs/' + (mode === 'resume' ? 'session.jsonl' : 'fresh-session.jsonl')]]
    .map(([pointer, sourcePath, targetPath]) => ({ pointer, sourcePath, targetPath }));
  return { capsule: p.capsule, expected: { capsuleHash: p.capsuleHash, checkpointChecksum: p.provenance.checkpointChecksum }, worktree,
    bindings: { schemaVersion: 1, sdkConfigHash: hash(JSON.stringify(sdk)), bindings } };
};
