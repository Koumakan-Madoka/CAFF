const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { listWikiTargets, getWikiTarget } = require('../../build/server/domain/runtime/badcase-capture/wiki-targets');
const { resolveGlobalWikiCandidate } = require('../../build/server/domain/runtime/badcase-capture/wiki-global-candidate');
const { assertWikiCandidateNoLeak } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate');
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
  const targets = listWikiTargets(); assert.equal(targets.length, 10);
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
test('only pre-existing overlaps inside the pinned base are exempt; copies in added prose are still rejected', t => {
  for (const [targetId, expected] of [['global-harness-behavior-v1', 'Keep your answer readable'], ['tool-description-list_rooms', 'List other Rooms by latest public message']]) {
    const h = setup(t, '核实后再汇报。', expected); h.approve();
    const file = { path: 'fixture.txt', base64: Buffer.from(expected).toString('base64'), sha256: sha(expected) };
    const c = h.store.createGlobalCandidate({ ...h.input, targetId, files: [file] });
    assert.equal(c.status, 'draft'); assert.equal(c.baseText, getWikiTarget(targetId).baseText);
    h.store.confirmGlobalCandidate({ candidateId: c.id, candidateHash: c.candidateHash, expectedRevision: h.store.read().revision, files: [file] });
    assert.equal(resolveGlobalWikiCandidate(h.store.read(), c.id, targetId, c.baseHash, [file]).candidateText, c.candidateText);
    const copied = setup(t, 'Additional instruction: ' + expected, expected); copied.approve();
    assert.throws(() => copied.store.createGlobalCandidate({ ...copied.input, targetId, files: [file] }), code('wiki_candidate_leak'));
    assert.equal(copied.store.read().candidates.length, 0);
  }
});
test('eight-character windows crossing the original/addition seam are never exempt', t => {
  for (const targetId of ['global-harness-behavior-v1', 'tool-description-list_rooms']) {
    const target = getWikiTarget(targetId), seam = [...target.baseText].slice(-4).join('') + '\n\nWi';
    assert.equal([...seam].length, 8);
    const h = setup(t, '核实后汇报。', 'prefix-' + seam + '-suffix'); h.approve();
    assert.throws(() => h.store.createGlobalCandidate({ ...h.input, targetId }), code('wiki_candidate_leak'));
    const f = setup(t); f.approve();
    const bytes = Buffer.from('prefix-' + seam + '-suffix');
    assert.throws(() => f.store.createGlobalCandidate({ ...f.input, targetId, files: [{ path: 'fixture.txt', base64: bytes.toString('base64'), sha256: sha(bytes) }] }), code('wiki_candidate_leak'));
  }
});
test('a prefix/hash mismatch is rejected before any exemption; Unicode positions and repeated matches are checked', () => {
  const baseText = '固定😀原文片段abcdefgh', base = { baseText, baseHash: sha(baseText) }, text = baseText + '\nNew prose.';
  assertWikiCandidateNoLeak(text, ['abcdefgh'], [], base);
  const emoji = { path: 'short.txt', base64: Buffer.from('😀').toString('base64'), sha256: sha('😀') };
  assertWikiCandidateNoLeak(text, [], [emoji], base);
  assert.throws(() => assertWikiCandidateNoLeak(text + '😀', [], [emoji], base), code('wiki_candidate_leak'));
  for (const tampered of [{ ...base, baseHash: 'f'.repeat(64) }, { ...base, baseText: 'different' }]) {
    assert.throws(() => assertWikiCandidateNoLeak(text, ['abcdefgh'], [], tampered), code('wiki_candidate_target_mismatch'));
  }
  assert.throws(() => assertWikiCandidateNoLeak(text.replace('固定', '改变'), ['abcdefgh'], [], base), code('wiki_candidate_target_mismatch'));
  assert.throws(() => assertWikiCandidateNoLeak(text + ' abcdefgh', ['abcdefgh'], [], base), code('wiki_candidate_leak'));
  assert.throws(() => assertWikiCandidateNoLeak(text + ' abcd', ['abcd'], [], base), code('wiki_candidate_leak'));
  const cross = 'efgh\nNew';
  assert.throws(() => assertWikiCandidateNoLeak(text, ['prefix-' + cross + '-suffix'], [], base), code('wiki_candidate_leak'));
});
test('global operator selects either declared target without changing legacy role configuration or calling a model', t => {
  const h = setup(t), { createCandidate, collectGlobalCandidateFiles } = require('../../scripts/badcase-capture/create-wiki-candidate.cjs');
  const config = { ...h.options, versionId: h.input.versionId, entryIds: h.input.entryIds, targetId: 'tool-description-list_rooms' };
  assert.throws(() => createCandidate(config), code('wiki_candidate_approved_required'));
  h.approve(); const c = createCandidate(config); assert.equal(c.targetId, config.targetId); assert.equal(c.status, 'draft');
  assert.throws(() => createCandidate({ ...config, projectId: 'bound-project' }), code('wiki_candidate_invalid'));
  const f = require('../helpers/badcase-initialization-fixture.cjs')(t);
  const state = { replayCases: [{ id: 'replay-1', request: f.request, checkpointHash: sha(JSON.stringify(f.cp)) }] };
  const before = fs.readFileSync(f.source);
  assert.deepEqual(collectGlobalCandidateFiles(state), [{ path: 'replay-1/source.txt', base64: Buffer.from('retained bytes').toString('base64'), sha256: sha('retained bytes') }]);
  assert.deepEqual(fs.readFileSync(f.source), before);
  assert.throws(() => collectGlobalCandidateFiles({ replayCases: [{ ...state.replayCases[0], checkpointHash: 'b'.repeat(64) }] }), code('wiki_candidate_anchor_unsupported'));
  fs.writeFileSync(f.blobPath(f.cp.files['source.txt'].hash), 'corrupt');
  assert.throws(() => collectGlobalCandidateFiles(state), code('wiki_candidate_anchor_unsupported'));
});
test('send-public targets the existing chat bridge description, not an unrelated native tool', t => {
  const target = getWikiTarget('tool-description-send-public');
  const { SEND_PUBLIC_CHAT_BRIDGE_DESCRIPTION } = require('../../build/lib/agent-prompt-targets');
  assert.equal(target.toolName, 'send-public'); assert.equal(target.source, 'chat-bridge-cli-description');
  assert.equal(target.baseText, SEND_PUBLIC_CHAT_BRIDGE_DESCRIPTION); assert.equal(target.baseHash, sha(target.baseText));
  assert.equal(target.baseText, '(--no-finalize posts an interim update and keeps the current run active).');
  const h = setup(t); h.approve(); const c = h.store.createGlobalCandidate({ ...h.input, targetId: target.id });
  assert.equal(c.targetId, target.id); assert.equal(c.status, 'draft'); assert.ok(c.diff.includes('+' + '- 先核验'));
});
test('wrong-tool drafts can be deprecated without deletion, revival, or changing another candidate/wiki', t => {
  const h = setup(t); h.approve();
  const global = h.store.createGlobalCandidate(h.input), old = h.store.createGlobalCandidate({ ...h.input, targetId: 'tool-description-list_rooms' });
  const before = h.store.read(), input = { candidateId: old.id, candidateHash: old.candidateHash, expectedRevision: before.revision, reason: 'wrong_tool_target' };
  assert.throws(() => h.store.deprecateGlobalCandidate({ ...input, candidateHash: 'f'.repeat(64) }), code('wiki_candidate_not_found'));
  assert.throws(() => h.store.deprecateGlobalCandidate({ ...input, expectedRevision: before.revision - 1 }), code('wiki_revision_conflict'));
  h.store.deprecateGlobalCandidate(input);
  const after = createWikiStore(h.options).read(), deprecated = after.candidates.find(c => c.id === old.id);
  assert.equal(after.candidates.length, 2); assert.equal(deprecated.status, 'deprecated'); assert.equal(deprecated.deprecationReason, 'wrong_tool_target');
  assert.equal(deprecated.candidateText, old.candidateText); assert.equal(deprecated.candidateHash, old.candidateHash); assert.equal(deprecated.diff, old.diff);
  assert.deepEqual(after.versions, before.versions); assert.deepEqual(after.cases, before.cases); assert.deepEqual(after.candidates.find(c => c.id === global.id), global);
  assert.throws(() => h.store.confirmGlobalCandidate({ candidateId: old.id, candidateHash: old.candidateHash, expectedRevision: after.revision, files: [] }), code('wiki_candidate_deprecated'));
  assert.throws(() => resolveGlobalWikiCandidate(after, old.id, old.targetId, old.baseHash, []), code('wiki_candidate_confirmation_required'));
  assert.equal(h.store.createGlobalCandidate({ ...h.input, targetId: old.targetId }).status, 'deprecated');
  h.store.deprecateGlobalCandidate({ ...input, expectedRevision: after.revision }); assert.equal(h.store.read().revision, after.revision);
});
test('D12 global candidates select exactly one approved pattern, preserving its guideline verbatim', t => {
  const { buildGlobalWikiCandidate } = require('../../build/server/domain/runtime/badcase-capture/wiki-global-candidate');
  const h = setup(t); h.approve(); const state = h.store.read();
  state.versions[0].entries.push({ ...state.versions[0].entries[0], id: 'entry-2', guideline: '另一条准则。' });
  for (const targetId of ['global-harness-behavior-v1', 'tool-description-send-public']) {
    const input = { ...h.input, targetId };
    const candidate = buildGlobalWikiCandidate(state, input);
    assert.equal(candidate.appendedSection, '\n\nWikiSkill 已审核准则：\n- ' + state.versions[0].entries[0].guideline);
    assert.throws(() => buildGlobalWikiCandidate(state, { ...input, entryIds: ['entry-1', 'entry-2'] }), code('wiki_candidate_invalid'));
  }
});
test('a historical combined draft can be deprecated while retaining text, diff, hashes and all other data', t => {
  const h = setup(t); h.approve(); const single = h.store.createGlobalCandidate(h.input);
  // Seed a pre-D12 snapshot as an old writer did. New writers must not create
  // multi-pattern candidates, but read/deprecation must preserve their history.
  const state = h.store.read(), old = { ...single, id: 'candidate-historical-combined', entryIds: ['entry-1', 'entry-2'], candidateText: single.candidateText + '\n- 另一条准则。', diff: single.diff + '\n+另一条准则。' };
  old.candidateHash = sha(old.candidateText); state.candidates.push(old); state.revision++;
  const file = path.join(h.options.globalRoot, 'snapshots', String(state.revision).padStart(12, '0') + '.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: sha(JSON.stringify(state)), record: state }));
  const before = h.store.read(), input = { candidateId: old.id, candidateHash: old.candidateHash, expectedRevision: before.revision, reason: 'multiple_patterns' };
  assert.throws(() => h.store.deprecateGlobalCandidate({ ...input, candidateId: single.id, candidateHash: single.candidateHash }), code('wiki_candidate_invalid'));
  h.store.deprecateGlobalCandidate(input);
  const after = createWikiStore(h.options).read(), saved = after.candidates.find(c => c.id === old.id);
  assert.equal(saved.status, 'deprecated'); assert.equal(saved.deprecationReason, 'multiple_patterns');
  for (const field of ['candidateText', 'diff', 'candidateHash', 'entryIds']) assert.deepEqual(saved[field], old[field]);
  for (const field of ['cases', 'versions', 'replayCases', 'replaySplit']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual(after.candidates.find(c => c.id === single.id), single);
  assert.throws(() => h.store.confirmGlobalCandidate({ candidateId: old.id, candidateHash: old.candidateHash, expectedRevision: after.revision, files: [] }), code('wiki_candidate_deprecated'));
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
