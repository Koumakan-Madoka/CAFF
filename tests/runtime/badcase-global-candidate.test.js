const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { listWikiTargets, getWikiTarget } = require('../../build/server/domain/runtime/badcase-capture/wiki-targets');
const { resolveGlobalWikiCandidate } = require('../../build/server/domain/runtime/badcase-capture/wiki-global-candidate');
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), code = value => e => e.code === value;
function setup(t, guideline = '先核验再用读者能理解的语言说明结果。', expected = 'A distinctive expected answer.') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'global-candidate-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'repo') }, store = createWikiStore(options);
  const c = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: null, conversationId: 'r', messageId: 'm', agentId: 'role-family-gpt' }, role: 'GPT', actual: 'jargon', expected, message: 'CAS', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const v = store.saveDraft({ model: 'deepseek/deepseek-v4-flash', caseIds: [c.id], entries: [{ title: 'Reports', failureMode: 'jargon', symptoms: 'unclear', rootCauseHypothesis: 'internal focus', guideline, caseIds: [c.id] }], unclassified: [] });
  const input = { versionId: v.id, entryIds: [v.entries[0].id], targetId: 'global-harness-behavior-v1', files: [] };
  const approve = () => store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: store.read().revision, decision: 'approved' });
  return { store, options, input, approve };
}
test('declared target catalog reflects each actual tool description without mutating or registering tools', () => {
  const targets = listWikiTargets(); assert.equal(targets.length, 9);
  assert.equal(targets[0].kind, 'global-system-prompt');
  const extension = require('../../lib/pi-extensions/caff-capabilities.mjs'), tools = [];
  extension.default({ registerTool: definition => tools.push(definition) });
  for (const tool of tools) {
    const target = getWikiTarget('tool-description-' + tool.name);
    assert.equal(target.baseText, tool.description); assert.equal(target.baseHash, sha(tool.description)); assert.equal(target.toolName, tool.name);
    assert.equal(target.parameters, undefined); assert.equal(target.execute, undefined);
    target.baseText = 'changed copy'; assert.equal(getWikiTarget(target.id).baseText, tool.description);
  }
  assert.throws(() => getWikiTarget('arbitrary'), code('wiki_target_unknown'));
});
test('both target types generate only from approved entries, persist diff as draft and require hash-bound confirmation', t => {
  for (const targetId of ['global-harness-behavior-v1', 'tool-description-list_rooms']) {
    const h = setup(t), input = { ...h.input, targetId };
    assert.throws(() => h.store.createGlobalCandidate(input), code('wiki_candidate_approved_required'));
    h.approve(); const c = h.store.createGlobalCandidate(input), target = getWikiTarget(targetId);
    assert.equal(c.kind, 'global-wiki-candidate-v1'); assert.equal(c.status, 'draft'); assert.equal(c.targetId, targetId);
    assert.equal(c.candidateText, target.baseText + c.appendedSection); assert.equal(c.candidateHash, sha(c.candidateText));
    assert.match(c.diff, /^--- a\//); assert.ok(c.diff.includes('+\n+WikiSkill 已审核准则：'));
    const revision = h.store.read().revision; assert.deepEqual(h.store.createGlobalCandidate(input), c); assert.equal(h.store.read().revision, revision);
    assert.throws(() => resolveGlobalWikiCandidate(h.store.read(), c.id, targetId, target.baseHash, []), code('wiki_candidate_confirmation_required'));
    assert.throws(() => h.store.confirmGlobalCandidate({ candidateId: c.id, candidateHash: 'e'.repeat(64), expectedRevision: revision, files: [] }));
    assert.throws(() => h.store.confirmGlobalCandidate({ candidateId: c.id, candidateHash: c.candidateHash, expectedRevision: revision - 1, files: [] }), code('wiki_revision_conflict'));
    h.store.confirmGlobalCandidate({ candidateId: c.id, candidateHash: c.candidateHash, expectedRevision: revision, files: [] });
    const rebuilt = resolveGlobalWikiCandidate(createWikiStore(h.options).read(), c.id, targetId, target.baseHash, []);
    assert.equal(rebuilt.candidateText, c.candidateText);
    assert.throws(() => resolveGlobalWikiCandidate(h.store.read(), c.id, targetId, 'f'.repeat(64), []), code('wiki_candidate_target_mismatch'));
  }
});
test('the full candidate is scanned, including declared base prose rather than only the added guidelines', t => {
  for (const [targetId, expected] of [['global-harness-behavior-v1', 'Keep your answer readable'], ['tool-description-list_rooms', 'List other Rooms by latest public message']]) {
    const h = setup(t, '核实后再汇报。', expected); h.approve();
    assert.throws(() => h.store.createGlobalCandidate({ ...h.input, targetId }), code('wiki_candidate_leak'));
    assert.equal(h.store.read().candidates.length, 0);
  }
});
test('global operator selects either declared target without changing legacy role configuration or calling a model', t => {
  const h = setup(t), { createCandidate, collectGlobalCandidateFiles } = require('../../scripts/badcase-capture/create-wiki-candidate.cjs');
  const config = { ...h.options, versionId: h.input.versionId, entryIds: h.input.entryIds, targetId: 'tool-description-list_rooms' };
  assert.throws(() => createCandidate(config), code('wiki_candidate_approved_required'));
  h.approve(); const c = createCandidate(config); assert.equal(c.targetId, config.targetId); assert.equal(c.status, 'draft');
  assert.throws(() => createCandidate({ ...config, projectId: 'bound-project' }), code('wiki_candidate_invalid'));
  const state = { replayCases: [{ id: 'replay-1', request: {}, checkpointHash: 'a'.repeat(64) }] };
  assert.throws(() => collectGlobalCandidateFiles(state, { prepareTarget: () => ({ supported: false }) }), code('wiki_candidate_anchor_unsupported'));
  const file = { path: 'x', base64: Buffer.from('fixture data').toString('base64'), sha256: sha('fixture data') };
  assert.deepEqual(collectGlobalCandidateFiles(state, { prepareTarget: () => ({ supported: true, input: { files: [file] }, provenance: { checkpointHash: 'a'.repeat(64) } }) }), [{ ...file, path: 'replay-1/x' }]);
  assert.throws(() => collectGlobalCandidateFiles(state, { prepareTarget: () => ({ supported: true, input: { files: [] }, provenance: { checkpointHash: 'b'.repeat(64) } }) }), code('wiki_candidate_anchor_unsupported'));
});
test('expected answer fragments and fixture file contents are rejected for both candidate target types', t => {
  for (const targetId of ['global-harness-behavior-v1', 'tool-description-list_rooms']) {
    const h = setup(t, 'Use this: A distinctive expected answer.'); h.approve();
    assert.throws(() => h.store.createGlobalCandidate({ ...h.input, targetId }), code('wiki_candidate_leak'));
    const h2 = setup(t, 'Do not publish ANSWER_FIXTURE_LITERAL in the report.'); h2.approve(); const file = { path: 'r/file.txt', base64: Buffer.from('ANSWER_FIXTURE_LITERAL').toString('base64'), sha256: sha('ANSWER_FIXTURE_LITERAL') };
    assert.throws(() => h2.store.createGlobalCandidate({ ...h2.input, targetId, files: [file] }), code('wiki_candidate_leak'));
    const h3 = setup(t, '核实后汇报。'); h3.approve(); const c = h3.store.createGlobalCandidate({ ...h3.input, targetId });
    assert.throws(() => h3.store.confirmGlobalCandidate({ candidateId: c.id, candidateHash: c.candidateHash, expectedRevision: h3.store.read().revision, files: [{ path: 'new', base64: Buffer.from('核实后汇报。').toString('base64'), sha256: sha('核实后汇报。') }] }), code('wiki_candidate_leak'));
    assert.equal(h3.store.read().candidates[0].status, 'draft');
  }
});
