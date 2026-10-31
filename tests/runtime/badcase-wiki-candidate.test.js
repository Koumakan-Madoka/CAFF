const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { resolveWikiCandidate, assertWikiGuidelinesNoLeak } = require('../../build/server/domain/runtime/badcase-capture/wiki-candidate');
const { createCandidate, main } = require('../../scripts/badcase-capture/create-wiki-candidate.cjs');
const { prepareComparison, runComparison } = require('../../scripts/badcase-capture/direct-comparison.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex'), code = wanted => e => e.code === wanted;
const file = (text, name = 'file.txt') => ({ path: name, base64: Buffer.from(text).toString('base64'), sha256: sha(text) });
function setup(t, guideline = '用可验证证据支撑最终结论。') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wiki-candidate-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { captureRoot: path.join(root, 'capture'), sourceWorktree: path.join(root, 'source'), projectId: 'p1' }, store = createWikiStore(config);
  const c = store.addTextCases([{ source: { origin: 'http://127.0.0.1:3100', projectId: 'p1', conversationId: 'c1', messageId: 'm1', agentId: 'role-family-gpt' },
    role: 'GPT', actual: 'claimed success', expected: 'specific expected response ABCXYZ', message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }]).cases[0];
  const v = store.saveDraft({ caseIds: [c.id], model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Title must not enter role', failureMode: 'failure', symptoms: 'symptom',
    rootCauseHypothesis: 'hypothesis must not enter role', guideline, caseIds: [c.id] }], unclassified: [] });
  const baseRole = 'Preserve identity.\nNever modify production.', files = [file('unique archived file facts 12345')];
  const input = { versionId: v.id, entryIds: [v.entries[0].id], baseRole, files,
    anchor: { caseId: 'case-anchor', checkpointId: 'cp1', originalRoleHash: sha('Your private persona instructions:\n' + baseRole) } };
  const approve = () => store.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: store.read().revision, decision: 'approved' });
  const confirm = candidate => store.confirmCandidate({ candidateId: candidate.id, candidateRoleHash: candidate.candidateRoleHash, expectedRevision: store.read().revision });
  const request = { captureRoot: config.captureRoot, association: { projectId: 'p1', agentId: 'role-family-gpt' } };
  const prepared = { supported: true, originalRole: baseRole, input: { prompt: 'original', files, deletions: [] },
    provenance: { ...input.anchor, checkpointHash: 'f'.repeat(64), commonInputHash: 'e'.repeat(64) } };
  const prepare = (request, role) => ({ ...prepared, input: { ...prepared.input, prompt: role || 'original' } });
  const comparison = { request, wikiCandidate: { sourceWorktree: config.sourceWorktree, candidateId: 'pending' }, repoRoot: root, dependencyRoot: root,
    image: { imageId: 'sha256:' + 'd'.repeat(64) }, repeats: 3, rules: { kind: 'read-only-files-v1', readPaths: ['file.txt'], absentPaths: [], requiredReplyFragments: ['done'] } };
  return { root, config, store, c, v, baseRole, files, input, approve, confirm, request, prepared, prepare, comparison };
}

test('only selected approved guidelines append to the exact archived GPT role; snapshot/diff survive restart', t => {
  const h = setup(t); assert.throws(() => h.store.createCandidate(h.input), code('wiki_candidate_approved_required'));
  assert.equal(h.store.read().revision, 2); h.approve();
  const c = h.store.createCandidate(h.input);
  assert.equal(c.status, 'draft'); assert.equal(c.candidateRole, h.baseRole + c.appendedSection);
  assert.equal(c.candidateRoleHash, sha(c.candidateRole)); assert.equal(c.anchor.originalRoleHash, h.input.anchor.originalRoleHash);
  assert.match(c.diff, /^--- a\/GPT-role.txt\n\+\+\+ b\/GPT-role.txt\n@@/); assert.match(c.diff, /\+用可验证|\+- 用可验证/);
  assert.doesNotMatch(c.candidateRole, /specific expected|unique archived|Title must|hypothesis must/);
  assert.equal(h.store.createCandidate(h.input).id, c.id); assert.equal(h.store.read().revision, 4);
  assert.deepEqual(createWikiStore(h.config).read().candidates[0], c);
  h.confirm(c); assert.equal(h.store.read().candidates[0].status, 'confirmed');
  assert.equal(resolveWikiCandidate(createWikiStore(h.config).read(), c.id, h.input.anchor.originalRoleHash, h.files).candidateRole, c.candidateRole);
  h.confirm(c); assert.equal(h.store.read().revision, 5, 'confirmation retry at current revision is idempotent');
});
test('displayed unified diff applies to exact original bytes, with or without trailing newline', t => {
  const h = setup(t); h.approve();
  const target = path.join(h.root, 'GPT-role.txt');
  for (const baseRole of ['One line.', 'One line.\n', 'Line 1.\nLine 2.', 'Line 1.\nLine 2.\n']) {
    const c = h.store.createCandidate({ ...h.input, baseRole,
      anchor: { ...h.input.anchor, originalRoleHash: sha('Your private persona instructions:\n' + baseRole) } });
    fs.writeFileSync(target, baseRole);
    const applied = require('node:child_process').spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--no-index', '--whitespace=nowarn', '-'], { cwd: h.root, input: c.diff, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr); assert.equal(fs.readFileSync(target, 'utf8'), c.candidateRole);
  }
});

test('unknown, duplicate, rejected or empty selections cannot create candidates or change snapshots', t => {
  const h = setup(t); h.store.review({ versionId: h.v.id, entryId: h.input.entryIds[0], expectedRevision: 2, decision: 'rejected' });
  for (const patch of [{}, { entryIds: [] }, { entryIds: ['missing'] }, { entryIds: [h.input.entryIds[0], h.input.entryIds[0]] }, { versionId: 'missing' }, { role: 'Kimi' }]) {
    assert.throws(() => h.store.createCandidate({ ...h.input, ...patch }));
    assert.equal(h.store.read().candidates.length, 0); assert.equal(h.store.read().revision, 3);
  }
});
test('literal guard rejects expected text/lines/eight-character spans and complete file content, including short contents', t => {
  for (const expected of ['specific expected response ABCXYZ', 'first line\nABCXYZ\nlast line', 'prefix12345678suffix', '短期望']) {
    const copied = expected.includes('\n') ? 'ABCXYZ' : expected.includes('12345678') ? '12345678' : expected;
    assert.throws(() => assertWikiGuidelinesNoLeak(['rule: ' + copied], [expected], []), code('wiki_candidate_leak'));
  }
  for (const content of ['full file facts', 'tiny', '字', '😀'.repeat(9)]) {
    assert.throws(() => assertWikiGuidelinesNoLeak(['Check ' + content], [], [file(content)]), code('wiki_candidate_leak'));
  }
  assert.throws(() => assertWikiGuidelinesNoLeak(['middle 12345678 chunk'], [], [file('prefix12345678suffix')]), code('wiki_candidate_leak'));
  assertWikiGuidelinesNoLeak(['核验后再报告。'], ['另一个参考行为。'], [file('')]);
  const h = setup(t, 'Include response ABCXYZ'); h.approve();
  assert.throws(() => h.store.createCandidate(h.input), code('wiki_candidate_leak')); assert.equal(h.store.read().revision, 3);
});
test('base role, tampered file bytes, placeholders and secrets fail before any candidate publication', t => {
  const h = setup(t); h.approve();
  for (const patch of [{ baseRole: h.baseRole + 'modified' }, { baseRole: '{{unsafe}}' }, { baseRole: 'sk-FAKE_SENTINEL_123456' },
    { files: [{ ...h.files[0], base64: Buffer.from('tampered').toString('base64') }] }, { anchor: { ...h.input.anchor, originalRoleHash: 'a'.repeat(64) } }]) {
    assert.throws(() => h.store.createCandidate({ ...h.input, ...patch })); assert.equal(h.store.read().revision, 3);
  }
});
test('confirmation binds revision, candidate hash and approved immutable sources', t => {
  const h = setup(t); h.approve(); const c = h.store.createCandidate(h.input);
  assert.throws(() => h.store.confirmCandidate({ candidateId: c.id, candidateRoleHash: c.candidateRoleHash, expectedRevision: 3 }), code('wiki_revision_conflict'));
  assert.throws(() => h.store.confirmCandidate({ candidateId: c.id, candidateRoleHash: 'a'.repeat(64), expectedRevision: 4 }), code('wiki_candidate_not_found'));
  const changed = h.store.read(); changed.versions[0].entries[0].status = 'rejected'; changed.candidates[0].status = 'confirmed';
  assert.throws(() => resolveWikiCandidate(changed, c.id, c.anchor.originalRoleHash, h.files), code('wiki_candidate_approved_required'));
  assert.equal(h.store.read().candidates[0].status, 'draft');
});
test('operator generation derives role/files from verified sealed GPT anchor; no unsupported or foreign-role fallback', t => {
  const h = setup(t); h.approve(); const config = { ...h.config, versionId: h.v.id, entryIds: h.input.entryIds, request: h.request };
  const candidate = createCandidate(config, { prepare: () => h.prepared }); assert.equal(candidate.baseRole, h.baseRole);
  assert.throws(() => createCandidate(config, { prepare: () => ({ supported: false }) }), code('wiki_candidate_anchor_unsupported'));
  assert.throws(() => createCandidate({ ...config, request: { ...h.request, association: { projectId: 'p1', agentId: 'Kimi' } } }), code('wiki_candidate_invalid'));
  assert.throws(() => main(['--config', path.join(h.root, 'not-read.json')]), code('wiki_candidate_usage'));
  assert.equal(h.store.read().candidates.length, 1);
});
test('compare-sealed wiki mode cannot read Key/execute before confirmation; exact role hash and fresh files checked per case', async t => {
  const h = setup(t); h.approve(); const c = h.store.createCandidate(h.input), config = { ...h.comparison, wikiCandidate: { ...h.comparison.wikiCandidate, candidateId: c.id } };
  let calls = 0; const options = { prepare: h.prepare, confirmed: true, readKey: () => { calls++; }, execute: () => { calls++; } };
  await assert.rejects(runComparison(config, options), code('wiki_candidate_confirmation_required')); assert.equal(calls, 0);
  h.confirm(c);
  const p = prepareComparison(config, options); assert.equal(p.inputs.candidate.prompt, c.candidateRole);
  assert.equal(p.summary.wikiCandidate.candidateRoleHash, c.candidateRoleHash); assert.equal(calls, 0);
  assert.throws(() => prepareComparison({ ...config, candidateRole: 'bypass' }, options), code('evaluation_config_invalid'));
  const differentRole = () => ({ ...h.prepared, provenance: { ...h.prepared.provenance, originalRoleHash: 'a'.repeat(64) } });
  assert.throws(() => prepareComparison(config, { prepare: differentRole }), code('wiki_candidate_role_mismatch'));
  const otherCase = () => ({ ...h.prepared, input: { ...h.prepared.input, files: [file('用可验证证据支撑最终结论。')] } });
  assert.throws(() => prepareComparison(config, { prepare: otherCase }), code('wiki_candidate_leak'));
  const changed = h.store.read(); changed.candidates[0].candidateRole += 'injected';
  assert.throws(() => resolveWikiCandidate(changed, c.id, c.anchor.originalRoleHash, []), code('wiki_candidate_role_mismatch'));
  assert.equal(calls, 0);
});
test('old wiki snapshots without candidate arrays remain readable and migrate only on a real write', t => {
  const h = setup(t), file = path.join(h.config.captureRoot, 'wiki/p1/snapshots/000000000002.json');
  const envelope = JSON.parse(fs.readFileSync(file)); delete envelope.record.candidates; envelope.checksum = sha(JSON.stringify(envelope.record)); fs.writeFileSync(file, JSON.stringify(envelope));
  const before = fs.readFileSync(file); assert.deepEqual(h.store.read().candidates, []); assert.deepEqual(fs.readFileSync(file), before);
  h.approve(); assert.deepEqual(fs.readFileSync(file), before);
  const latest = JSON.parse(fs.readFileSync(path.join(path.dirname(file), '000000000003.json'))); assert.deepEqual(latest.record.candidates, []);
});
