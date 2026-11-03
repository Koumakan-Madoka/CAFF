const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const fixture = require('../helpers/badcase-initialization-fixture.cjs');
const { prepareSealedDirectTurn, prepareSealedOriginalTurn } = require('../../scripts/badcase-capture/sealed-direct-input.cjs');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function portable(t, change = () => {}, mode = 'fresh') {
  return fixture(t, mode, ({ cp, r, config, put }) => {
    config.toolBridgeEnabled = true;
    config.portableRuntime = { schemaVersion: 1, kind: 'portable-default-resources-v1', supported: true };
    config.sdkStartConfig = { cwd: cp.targetDir, provider: r.runConfig.provider, model: r.runConfig.model,
      resume: mode === 'resume', thinking: 'off', fast: false, retireUserScopeSkills: true };
    if (mode === 'resume') r.sessionLineCount = 2;
    const role = 'Your private persona instructions:\nRead only.';
    const prompt = 'header\n\n' + role + '\n\nuser task';
    r.roleSpan = { start: 8, end: 8 + role.length, sha256: sha(role) };
    r.promptBlobHash = r.normalizedPromptHash = put(prompt);
    const association = { projectId: 'p1', conversationId: 'c1', turnId: 't1', agentId: 'a1', userMessageId: 'u1', assistantMessageId: 'msg1' };
    const trace = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-v1', association,
      assistantCreatedAt: '2026-01-01T00:00:01.000Z', conversation: { title: 'Test', type: 'standard', metadata: {} },
      participants: [{ id: 'a1', name: config.agentName, description: 'Test' }], publicMessages: [
        { id: 'u1', turnId: 't0', role: 'user', agentId: null, senderName: 'User', content: 'Read files.', status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z', publicPostedAt: '', publicPostCount: 0, publicPostMode: '', mentions: [] }], privateMessages: [], pendingDelegations: [] };
    r.callbackInput = { schemaVersion: 1, kind: 'caff-evaluation-callback-input-reference-v1', blobHash: put(JSON.stringify(trace)), association };
    change({ cp, r, config, put, trace }); r.harness.configSnapshotHash = put(JSON.stringify(config));
  });
}
test('sealed portable input preserves real start bytes, changes only declared role, and never touches source/archive', t => {
  const f = portable(t), before = fs.readFileSync(f.source);
  const a = prepareSealedDirectTurn(f.request), b = prepareSealedDirectTurn(f.request, 'Read only. Verify each file.');
  assert.equal(a.supported, true, JSON.stringify(a)); assert.equal(b.supported, true);
  assert.equal(a.originalRole, 'Read only.'); assert.equal(b.originalRole, a.originalRole, 'anchor always exposes archived original, not candidate');
  assert.equal(a.input.sessionText, null); assert.equal(a.input.settings, null); assert.equal(a.input.systemPrompt, null);
  assert.equal(a.input.files[0].base64, Buffer.from('retained bytes').toString('base64'));
  assert.deepEqual(Object.keys(a.input.callback).sort(), ['association', 'expectedTraceHash', 'trace'], 'callback constructor accepts only its three archived input fields');
  assert.equal(a.provenance.commonInputHash, b.provenance.commonInputHash);
  assert.equal(a.provenance.originalRoleHash, b.provenance.originalRoleHash);
  assert.deepEqual({ ...a.input, prompt: '' }, { ...b.input, prompt: '' });
  assert.equal(b.input.prompt, a.input.prompt.replace('Read only.', 'Read only. Verify each file.'));
  assert.deepEqual(fs.readFileSync(f.source), before); assert.equal(a.provenance.strictEvalEligible, false);
  for (const role of ['', '{{CAFF_CHAT_CALLBACK_TOKEN}}', 'sk-' + 'x'.repeat(32)]) assert.equal(prepareSealedDirectTurn(f.request, role).supported, false);
});
function gptFamily(t, change = () => {}) {
  return portable(t, value => {
    const { cp, r, config, put, trace } = value;
    cp.agentId = 'role-family-gpt'; config.agentName = 'GPT';
    trace.association.agentId = cp.agentId;
    trace.participants = [{ id: cp.agentId, name: 'GPT', description: 'OpenAI GPT 模型族' }];
    r.callbackInput.association = trace.association;
    r.callbackInput.blobHash = put(JSON.stringify(trace));
    const role = 'Rules:\n- Reply as this agent only.\n- Respond in the user language.';
    const header = 'Your visible agent name: GPT\n\n';
    r.promptBlobHash = r.normalizedPromptHash = put(header + role + '\n\nUser: Read files.');
    r.roleSpan = { start: header.length, end: header.length + role.length, sha256: sha(role) };
    change(value);
  });
}
test('actual GPT family rules are an appendable role span without inventing a persona or changing common inputs', t => {
  const f = gptFamily(t), original = prepareSealedDirectTurn(f.request);
  assert.equal(original.supported, true);
  assert.equal(original.originalRole, '- Reply as this agent only.\n- Respond in the user language.');
  const candidateRole = original.originalRole + '\n\nWikiSkill 已审核准则：\n- 核验后报告。';
  const candidate = prepareSealedDirectTurn(f.request, candidateRole);
  assert.equal(candidate.supported, true);
  assert.equal(candidate.input.prompt, original.input.prompt.replace('Rules:\n' + original.originalRole, 'Rules:\n' + candidateRole));
  assert.doesNotMatch(candidate.input.prompt, /Your private persona instructions:/);
  assert.deepEqual({ ...original.input, prompt: '' }, { ...candidate.input, prompt: '' });
  assert.equal(candidate.provenance.commonInputHash, original.provenance.commonInputHash);
  assert.equal(candidate.provenance.originalRoleHash, original.provenance.originalRoleHash);
  assert.equal(candidate.input.prompt.startsWith('Your visible agent name: GPT\n\n'), true);
});
test('sealed in-root resources use retained files only, share identity across variants, and reject inventory drift', t => {
  const setup = ({ cp, config, put }) => {
    const names = ['AGENTS.md', '.agents/skills/demo/SKILL.md', '.agents/skills/demo/references/guide.md'];
    for (const name of names) { const content = name === 'AGENTS.md' ? 'Archived project context' : 'Archived skill bytes'; cp.files[name] = { type: 'file', hash: put(content), size: Buffer.byteLength(content) }; }
    config.sdkStartConfig.additionalSkillPaths = [cp.targetDir + '/.agents/skills/demo'];
    config.portableRuntime = { schemaVersion: 1, kind: 'portable-project-resources-v1', supported: true, filePaths: names.sort(), skillPaths: ['.agents/skills/demo'] };
  };
  const f = portable(t, setup), before = fs.readFileSync(f.source), a = prepareSealedDirectTurn(f.request), b = prepareSealedDirectTurn(f.request, 'Verify first.');
  assert.equal(a.supported, true, JSON.stringify(a)); assert.equal(b.supported, true, JSON.stringify(b));
  assert.equal(a.input.projectResources.contextFile, 'AGENTS.md'); assert.equal(a.input.projectResources.files.length, 3);
  assert.deepEqual(a.input.projectResources, b.input.projectResources); assert.equal(a.provenance.commonInputHash, b.provenance.commonInputHash);
  assert.deepEqual(fs.readFileSync(f.source), before);
  for (const change of [({ cp }) => { delete cp.files['AGENTS.md']; }, ({ config }) => { config.sdkStartConfig.additionalSkillPaths = ['/outside/skill']; },
    ({ cp, put }) => { cp.files['.pi/settings.json'] = { type: 'file', hash: put('{}'), size: 2 }; }]) {
    const broken = portable(t, value => { setup(value); change(value); });
    assert.deepEqual(prepareSealedOriginalTurn(broken.request), { supported: false, reason: 'replay_project_resources_invalid' });
  }
});
test('production GPT xhigh is recorded in unchanged original and plan; thinking mismatch is refused before execution', t => {
  const f = gptFamily(t, ({ r, config }) => { r.runConfig.provider = config.sdkStartConfig.provider = 'openai-codex';
    r.runConfig.model = config.sdkStartConfig.model = 'gpt-6.1-sol'; config.sdkStartConfig.thinking = 'xhigh'; });
  const recorded = { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'xhigh', fast: false };
  const input = prepareSealedOriginalTurn(f.request); assert.equal(input.supported, true, JSON.stringify(input));
  assert.deepEqual(input.input.recordedModelConfig, recorded);
  const path = require('node:path'), { prepareComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  const config = { request: f.request, variants: ['original'], repeats: 3, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'),
    image: { imageId: 'sha256:' + '1'.repeat(64) }, modelProfile: 'openai-codex/gpt-6.1-sol', keySource: 'caff-codex-access',
    codexAuthFile: path.join(f.root, '.pi-sandbox/auth.json'), rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] } };
  const plan = prepareComparison(config); assert.equal(plan.supported, true, JSON.stringify(plan)); assert.deepEqual(plan.summary.recordedModelConfig, recorded);
  const { modelProfile, keySource, codexAuthFile, ...offConfig } = config;
  assert.deepEqual(prepareComparison(offConfig), { supported: false, reason: 'replay_thinking_profile_mismatch' });
  const off = gptFamily(t); assert.deepEqual(prepareComparison({ ...config, request: off.request }), { supported: false, reason: 'replay_thinking_profile_mismatch' });
});
test('real sealed family anchor flows through candidate creation, confirmation and original/candidate preflight without injected preparers', t => {
  const f = gptFamily(t);
  const path = require('node:path');
  const config = { captureRoot: f.root, sourceWorktree: f.root + '-source', projectId: 'p1' };
  const store = require('../../build/server/domain/runtime/badcase-capture/wiki-store').createWikiStore(config);
  const source = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'old-room', messageId: 'old-message', agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'Unverified report', expected: 'Use distinct confirmed facts.', message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const version = store.saveDraft({ caseIds: [source.id], model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Evidence', failureMode: 'Unsupported claim', symptoms: 'Premature report',
    rootCauseHypothesis: 'Skipped inspection', guideline: '核验后再汇报。', caseIds: [source.id] }], unclassified: [] });
  store.review({ versionId: version.id, entryId: version.entries[0].id, expectedRevision: store.read().revision, decision: 'approved' });
  const candidate = require('../../scripts/badcase-capture/create-wiki-candidate.cjs').createCandidate({ ...config, request: f.request, versionId: version.id, entryIds: [version.entries[0].id] });
  const comparison = { request: f.request, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image: { imageId: 'sha256:' + 'd'.repeat(64) },
    repeats: 3, wikiCandidate: { sourceWorktree: config.sourceWorktree, candidateId: candidate.id }, rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] } };
  const { prepareComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  assert.throws(() => prepareComparison(comparison), e => e.code === 'wiki_candidate_confirmation_required');
  store.confirmCandidate({ candidateId: candidate.id, candidateRoleHash: candidate.candidateRoleHash, expectedRevision: store.read().revision });
  const plan = prepareComparison(comparison);
  assert.equal(plan.supported, true);
  assert.equal(plan.inputs.candidate.prompt, plan.inputs.original.prompt.replace('Rules:\n' + candidate.baseRole, 'Rules:\n' + candidate.candidateRole));
  assert.deepEqual({ ...plan.inputs.original, prompt: '' }, { ...plan.inputs.candidate, prompt: '' });
  assert.equal(candidate.anchor.originalRoleHash, f.r.roleSpan.sha256);
  assert.doesNotMatch(plan.inputs.candidate.prompt, /Your private persona instructions:/);
});
test('family support does not synthesize missing old spans or accept Rules for custom or other family identities', t => {
  const legacy = gptFamily(t, ({ r }) => { delete r.roleSpan; });
  assert.equal(prepareSealedDirectTurn(legacy.request).supported, false);
  const custom = portable(t, ({ r, put }) => {
    const role = 'Rules:\n- Read files.';
    r.promptBlobHash = r.normalizedPromptHash = put(role);
    r.roleSpan = { start: 0, end: role.length, sha256: sha(role) };
  });
  assert.equal(prepareSealedDirectTurn(custom.request).supported, false);
  const otherFamily = gptFamily(t, ({ cp, r, trace, put }) => {
    cp.agentId = trace.association.agentId = 'role-family-kimi';
    trace.participants = [{ id: cp.agentId, name: 'Kimi', description: 'Moonshot Kimi 模型族' }];
    r.callbackInput.blobHash = put(JSON.stringify(trace));
  });
  assert.equal(prepareSealedDirectTurn(otherFamily.request).supported, false);
});
test('original-only real sealed preflight does not require or interpret a candidate role span', t => {
  for (const change of [({ r }) => { delete r.roleSpan; }, ({ r }) => { r.roleSpan.sha256 = '0'.repeat(64); }]) {
    const f = gptFamily(t, change), before = fs.readFileSync(f.source), original = prepareSealedOriginalTurn(f.request);
    assert.equal(original.supported, true, JSON.stringify(original));
    assert.equal(original.input.prompt, f.store.readBlob('p1', f.r.promptBlobHash).toString());
    assert.equal(original.originalRole, undefined); assert.equal(original.provenance.originalRoleHash, undefined);
    const { prepareComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs'), path = require('node:path');
    const config = { request: f.request, variants: ['original'], repeats: 3, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'),
      image: { imageId: 'sha256:' + '1'.repeat(64) }, rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] } };
    const plan = prepareComparison(config); assert.equal(plan.supported, true, JSON.stringify(plan));
    assert.equal(plan.inputs.original.prompt, original.input.prompt); assert.deepEqual(Object.keys(plan.inputs), ['original']);
    assert.equal(prepareSealedDirectTurn(f.request).supported, false, 'candidate comparison still requires its anchor');
    assert.deepEqual(fs.readFileSync(f.source), before);
  }
});
test('unsupported sealed inputs report the actual bounded reason through original-only and comparison plans', t => {
  const cases = [
    [({ r }) => { r.deliveryMode = 'resume'; }, 'replay_session_missing'],
    [({ config }) => { config.sdkStartConfig.thinking = 'xhigh'; }, 'replay_recorded_thinking_not_supported'],
    [({ r }) => { r.invocationImageCount = 1; }, 'replay_invocation_images_not_supported'],
    [({ config }) => { delete config.portableRuntime; }, 'replay_portable_runtime_not_supported'],
    [({ r }) => { r.runConfig.skillIds = ['missing']; }, 'replay_skills_not_supported'],
    [({ r }) => { r.secretExcludedPaths = ['old-missing.txt']; }, 'replay_secret_excluded_files'],
  ];
  const { prepareComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs'), path = require('node:path');
  for (const [change, reason] of cases) {
    const f = portable(t, change), original = prepareSealedOriginalTurn(f.request);
    assert.deepEqual(original, { supported: false, reason });
    const config = { request: f.request, variants: ['original'], repeats: 3, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'),
      image: { imageId: 'sha256:' + '1'.repeat(64) }, rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] } };
    assert.deepEqual(prepareComparison(config), { supported: false, reason });
    delete config.variants; config.candidateRole = 'Use verified facts.';
    assert.deepEqual(prepareComparison(config), { supported: false, reason });
  }
  const broken = portable(t); fs.unlinkSync(broken.blobPath(broken.r.promptBlobHash));
  const result = prepareSealedOriginalTurn(broken.request);
  assert.equal(result.supported, false); assert.match(result.reason, /^replay_(checkpoint|blob)_unavailable/);
  assert.equal(JSON.stringify(result).includes(broken.root), false);
});
test('actual CLI --plan exposes the sealed reason and supports unchanged original without a role anchor, with no run', t => {
  const path = require('node:path'), { execFileSync } = require('node:child_process');
  for (const invalidThinking of [false, true]) {
    const f = portable(t, ({ r, config }) => { delete r.roleSpan; if (invalidThinking) config.sdkStartConfig.thinking = 'xhigh'; });
    const file = path.join(f.root, 'comparison.json'), config = { request: f.request, variants: ['original'], repeats: 3,
      repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'), image: { imageId: 'sha256:' + '1'.repeat(64) },
      rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] } };
    fs.writeFileSync(file, JSON.stringify(config));
    const output = JSON.parse(execFileSync(process.execPath, [path.resolve('scripts/badcase-capture/compare-sealed.cjs'), '--config', file, '--plan'], { encoding: 'utf8' }));
    assert.equal(output.supported, !invalidThinking);
    if (invalidThinking) assert.equal(output.reason, 'replay_recorded_thinking_not_supported');
    else { assert.equal(output.preparedOnly, true); assert.equal(output.dockerVerified, false); assert.equal(output.kind, 'sealed-original-replay-v1'); }
  }
});
test('sealed original prompt limit is 256 KiB in UTF-8 bytes, without truncation', t => {
  for (const size of [131073, 262144, 262145]) {
    const text = '中'.repeat(Math.floor(size / 3)) + 'a'.repeat(size % 3);
    const f = portable(t, ({ r, put }) => { r.promptBlobHash = r.normalizedPromptHash = put(text); });
    const result = prepareSealedOriginalTurn(f.request); assert.equal(result.supported, size <= 262144, JSON.stringify(result));
    if (result.supported) assert.equal(result.input.prompt, text); else assert.equal(result.reason, 'replay_prompt_size_limit');
  }
});
test('retained workspace above the old 4 MiB transport cap is prepared without source reads or archive writes', t => {
  const bytes = Buffer.alloc(17 * 1024 * 1024, 0x61);
  const f = portable(t, ({ cp, put }) => { cp.files['large.txt'] = { type: 'file', size: bytes.length, hash: put(bytes) }; });
  const before = fs.readFileSync(f.source), plan = prepareSealedDirectTurn(f.request);
  assert.equal(plan.supported, true, JSON.stringify(plan));
  const file = plan.input.files.find(f => f.path === 'large.txt');
  assert.equal(sha(Buffer.from(file.base64, 'base64')), sha(bytes));
  assert.deepEqual(fs.readFileSync(f.source), before);
});
test('blanket Windows metadata limitation is not a strict certificate; portable/default-resource declaration is still mandatory', t => {
  const f = portable(t, ({ r }) => { r.complete = false; r.incompleteReasons = ['windows_capture_subset_unverified']; });
  assert.equal(prepareSealedDirectTurn(f.request).supported, true);
});
test('missing/legacy/delta/session/resources/corrupt material stays unsupported, never synthesized or silently made fresh', t => {
  const changes = [({ r }) => { delete r.roleSpan; }, ({ r }) => { r.roleSpan.sha256 = '0'.repeat(64); },
    ({ config }) => { delete config.portableRuntime; }, ({ config }) => { config.portableRuntime.supported = false; },
    ({ config }) => { config.sdkStartConfig.thinking = 'high'; }, ({ r, put }) => { r.deliveryMode = 'resume'; r.sessionBlobHash = put('not an empty fresh session'); },
    ({ r }) => { r.invocationImageCount = 1; }, ({ r }) => { r.unverifiedDimensions = ['unknown']; },
    ({ r }) => { r.complete = false; r.incompleteReasons = ['harness_config_unverified']; },
    ({ r }) => { r.complete = false; r.incompleteReasons = []; }, ({ r }) => { r.runConfig.skillIds = ['missing']; }];
  for (const change of changes) {
    const f = portable(t, change), result = prepareSealedDirectTurn(f.request);
    assert.equal(result.supported, false); assert.match(result.reason, /^replay_[a-z_]+$/);
  }
  const broken = portable(t); fs.unlinkSync(broken.blobPath(broken.r.promptBlobHash));
  assert.equal(prepareSealedDirectTurn(broken.request).supported, false);
});
test('sealed resume original/candidate keep the exact retained prefix, shared input hash and recorded mode', t => {
  const f = portable(t, ({ r, put }) => {
    const text = [{ type: 'session', version: 3, id: 'same-old-id', cwd: '/historical/not-mounted' },
      { type: 'message', id: 'old-user', parentId: null, message: { role: 'user', content: 'Earlier {{CAFF_CHAT_API_URL}}' } }]
      .map(JSON.stringify).join('\r\n') + '\r\n';
    r.sessionBlobHash = put(text); r.controlledReplacements = [{ name: 'CAFF_CHAT_API_URL', count: 1 }];
  }, 'resume');
  const before = fs.readFileSync(f.source), a = prepareSealedDirectTurn(f.request), b = prepareSealedDirectTurn(f.request, 'Read and verify.');
  assert.equal(a.supported, true, JSON.stringify(a)); assert.equal(b.supported, true, JSON.stringify(b));
  assert.equal(a.input.sessionText, f.store.readBlob('p1', f.r.sessionBlobHash).toString());
  assert.equal(b.input.sessionText, a.input.sessionText); assert.ok(a.input.sessionText.endsWith('\r\n'));
  assert.equal(a.provenance.commonInputHash, b.provenance.commonInputHash);
  assert.equal(prepareSealedOriginalTurn(f.request).input.sessionText, a.input.sessionText);
  const path = require('node:path'), { prepareComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
  const plan = prepareComparison({ request: f.request, variants: ['original'], repeats: 3, repoRoot: path.resolve('.'), dependencyRoot: path.resolve('.'),
    image: { imageId: 'sha256:' + '1'.repeat(64) }, rules: { kind: 'file-literals-v1', files: [{ path: 'source.txt', contains: ['retained bytes'], notContains: [] }] } });
  assert.equal(plan.supported, true, JSON.stringify(plan));
  assert.deepEqual(plan.summary.replaySession, { deliveryMode: 'resume', prefixHash: f.r.sessionBlobHash, lineCount: 2 });
  assert.deepEqual(fs.readFileSync(f.source), before);
});
test('resume without intact matching session/runtime metadata is refused instead of silently starting fresh', t => {
  for (const [change, reason] of [
    [({ r }) => { r.sessionBlobHash = ''; }, 'replay_session_missing'],
    [({ r, put }) => { r.sessionBlobHash = put('not JSON\n'); }, 'replay_session_invalid'],
    [({ r }) => { r.sessionLineCount++; }, 'replay_session_invalid'],
    [({ config }) => { config.sdkStartConfig.resume = false; }, 'replay_runtime_config_mismatch'],
    [({ config }) => { config.deliveryMode = 'fresh'; }, 'replay_runtime_config_mismatch'],
    [({ r, put }) => { r.sessionBlobHash = put(JSON.stringify({ type: 'session', version: 3, id: 's', cwd: '/elsewhere' }) + '\n'); r.sessionLineCount = 1; }, 'replay_controlled_bindings_invalid'],
  ]) {
    const f = portable(t, change, 'resume'); assert.deepEqual(prepareSealedOriginalTurn(f.request), { supported: false, reason });
  }
});
