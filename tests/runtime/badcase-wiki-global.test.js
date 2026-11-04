const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-global-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyOptions = { captureRoot: path.join(root, 'capture'), sourceWorktree: path.join(root, 'source'), projectId: 'old-project' };
  const globalOptions = { globalRoot: path.join(root, 'data/badcase-global'), sourceWorktree: legacyOptions.sourceWorktree };
  const legacy = createWikiStore(legacyOptions), global = createWikiStore(globalOptions);
  const input = n => ({ source: { origin: 'http://127.0.0.1:3100', projectId: n === 1 ? 'source-a' : 'source-b', conversationId: 'room', messageId: 'm' + n, agentId: 'role-family-gpt' }, role: 'GPT', actual: 'unclear report', expected: 'state the conclusion clearly', message: 'done', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false });
  const seed = store => {
    const cases = store.addTextCases([input(1), input(2)]).cases, caseIds = cases.map(c => c.id);
    const v = store.saveDraft({ caseIds, model: 'deepseek/deepseek-v4-flash', entries: [{ title: 'Reports', failureMode: 'jargon', symptoms: 'unclear', rootCauseHypothesis: 'internal focus', guideline: '用读者能理解的语言汇报。', caseIds }], unclassified: [] });
    return v;
  };
  return { root, legacyOptions, globalOptions, legacy, global, input, seed };
}
const code = value => e => e.code === value;
function treeDigest(root) {
  const result = [];
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) walk(file); else result.push([path.relative(root, file), crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]); } }
  walk(root); return result.sort();
}
test('trusted manual guideline revision preserves unrelated reviewed patterns and parent bytes; CLI creates only a draft', t => {
  const h=setup(t),first=h.seed(h.global),fields=Object.fromEntries(['title','failureMode','symptoms','rootCauseHypothesis','guideline','caseIds'].map(k=>[k,first.entries[0][k]]));
  const v=h.global.saveDraft({caseIds:first.caseIds,model:first.model,entries:[fields,{...fields,title:'Second',guideline:'Do not expand scope.'}],unclassified:[]});
  for(const e of v.entries)h.global.review({versionId:v.id,entryId:e.id,expectedRevision:h.global.read().revision,decision:'approved'});
  const before=h.global.read(),parent=before.versions.at(-1),files=treeDigest(h.globalOptions.globalRoot),cfg=path.join(h.root,'revise.json'),guideline='先说明结果与用户影响。';
  fs.writeFileSync(cfg,JSON.stringify({...h.globalOptions,versionId:parent.id,entryId:'entry-1',guideline}));const args=['--config',cfg,'--confirmed','--expected-revision',String(before.revision)],main=require('../../scripts/badcase-capture/revise-wiki-guideline.cjs').main,write=process.stdout.write;process.stdout.write=()=>true;
  try{assert.throws(()=>main(args.slice(0,2)),/wiki_guideline_usage/);assert.throws(()=>main([...args.slice(0,4),String(before.revision-1)]),/wiki_revision_conflict/);const result=main(args);assert.equal(result.status,'draft');assert.equal(result.modelsCalled,0);}finally{process.stdout.write=write;}
  const after=h.global.read(),next=after.versions.at(-1);assert.equal(after.revision,before.revision+1);assert.deepEqual(after.versions.slice(0,-1),before.versions);assert.deepEqual(next.entries[1],parent.entries[1]);assert.equal(next.entries[0].guideline,guideline);assert.equal(next.entries[0].status,'draft');assert.equal(next.entries[0].reviewedAt,undefined);assert.equal(next.origin,'manual-guideline-revision-v1');assert.deepEqual(next.caseIds,parent.caseIds);for(const f of files)assert.ok(treeDigest(h.globalOptions.globalRoot).some(g=>JSON.stringify(f)===JSON.stringify(g)));
  for(const patch of [{guideline:'😀'.repeat(301)},{guideline:'sk-FAKE_SENTINEL_123456'},{extra:true}])assert.throws(()=>h.global.reviseGuideline({versionId:next.id,entryId:'entry-2',guideline,expectedRevision:after.revision,...patch}));
  assert.deepEqual(h.global.read(),after);
});
test('global collection has no owning project and works across source projects and restarts', t => {
  const h = setup(t);
  assert.equal(fs.existsSync(h.globalOptions.globalRoot), false);
  assert.equal(h.global.read().scope, 'global'); assert.equal(h.global.read().projectId, undefined);
  h.seed(h.global);
  const state = h.global.read(); assert.equal(state.cases.length, 2); assert.deepEqual(state.cases.map(c => c.source.projectId), ['source-a', 'source-b']);
  assert.deepEqual(createWikiStore({ ...h.globalOptions, sourceWorktree: path.join(h.root, 'another-project') }).read(), state);
  assert.equal(fs.existsSync(h.legacyOptions.captureRoot), false);
});
test('migration preserves all cases, versions, review decisions, IDs and fixed split without model calls or source writes', t => {
  const h = setup(t), v = h.seed(h.legacy);
  h.legacy.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'approved' });
  const before = h.legacy.read(), sourceDigest = treeDigest(h.legacyOptions.captureRoot);
  assert.equal(h.global.migrateProjectCollection(h.legacyOptions).value.migrated, true);
  const after = h.global.read();
  for (const field of ['cases', 'versions', 'candidates', 'replaySplit']) assert.deepEqual(after[field], before[field]);
  assert.equal(after.projectId, undefined); assert.equal(after.scope, 'global'); assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(treeDigest(h.legacyOptions.captureRoot), sourceDigest);
  assert.equal(h.global.migrateProjectCollection(h.legacyOptions).value.migrated, false);
  const v2 = h.global.saveDraft({ caseIds: v.caseIds, model: v.model, entries: v.entries.map(({ id, status, ...e }) => e), unclassified: [] });
  assert.notEqual(v2.id, v.id);
  assert.equal(h.global.read().versions[0].entries[0].status, 'approved');
  assert.equal(h.global.migrateProjectCollection(h.legacyOptions).value.migrated, false, 'rerun cannot overwrite later reviews/versions');
});
test('migration retains the frozen holdout; a repeated import cannot reset it to training', t => {
  const h = setup(t), values = Array.from({ length: 6 }, (_, i) => h.input(i + 1));
  const cases = h.legacy.addTextCases(values).cases;
  const split = h.legacy.setReplaySplit({ caseIds: cases.map(c => c.id) });
  h.global.migrateProjectCollection(h.legacyOptions);
  assert.deepEqual(h.global.read().replaySplit, split);
  h.global.addTextCases(values);
  assert.deepEqual(h.global.read().cases.filter(c => c.split === 'test').map(c => c.id).sort(), [...split.testCaseIds].sort());
});
test('pre-registration legacy migration checksum stays stable when optional replay records are absent', t => {
  const h = setup(t); h.seed(h.legacy);
  const file = path.join(h.legacyOptions.captureRoot, 'wiki/old-project/snapshots/000000000002.json');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete envelope.record.replayCases;
  envelope.checksum = crypto.createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(envelope) + '\n');
  const before = treeDigest(h.legacyOptions.captureRoot);
  assert.equal(h.global.migrateProjectCollection(h.legacyOptions).value.migrated, true);
  assert.equal(h.global.read().migration.checksum, envelope.checksum);
  assert.deepEqual(h.global.read().replayCases, []);
  assert.equal(h.global.migrateProjectCollection(h.legacyOptions).value.migrated, false);
  assert.deepEqual(treeDigest(h.legacyOptions.captureRoot), before);
});
test('global migration refuses unrelated existing histories, empty sources, or malformed snapshots', t => {
  const h = setup(t);
  assert.throws(() => h.global.migrateProjectCollection(h.legacyOptions), code('wiki_migration_empty'));
  h.seed(h.legacy); h.seed(h.global);
  assert.throws(() => h.global.migrateProjectCollection(h.legacyOptions), code('wiki_migration_conflict'));
  const h2 = setup(t); h2.seed(h2.legacy);
  fs.writeFileSync(path.join(h2.legacyOptions.captureRoot, 'wiki/old-project/snapshots/000000000002.json'), 'corrupt');
  assert.throws(() => h2.global.migrateProjectCollection(h2.legacyOptions), code('wiki_record_invalid'));
  assert.equal(fs.existsSync(h2.globalOptions.globalRoot), false);
});
test('global storage rejects project ownership and roots inside any known worktree; stale writes cannot overwrite', t => {
  const h = setup(t);
  assert.throws(() => createWikiStore({ ...h.globalOptions, projectId: 'p1' }), code('wiki_global_project_unsupported'));
  assert.throws(() => createWikiStore({ ...h.globalOptions, globalRoot: path.join(h.legacyOptions.sourceWorktree, 'data') }), code('wiki_storage_inside_source'));
  assert.throws(() => createWikiStore({ ...h.globalOptions, sourceWorktrees: [path.join(h.root, 'data')] }), code('wiki_storage_inside_source'));
  const v = h.seed(h.global);
  h.global.review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'rejected' });
  assert.throws(() => createWikiStore(h.globalOptions).review({ versionId: v.id, entryId: v.entries[0].id, expectedRevision: 2, decision: 'approved' }), code('wiki_revision_conflict'));
});
