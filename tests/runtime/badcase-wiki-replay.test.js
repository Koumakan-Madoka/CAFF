const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const code = value => e => e.code === value;
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'global'), sourceWorktree: path.join(root, 'source') };
  const store = createWikiStore(options);
  const sources = store.addTextCases(Array.from({ length: 6 }, (_, n) => ({ source: { origin: 'http://127.0.0.1:3100', projectId: 'history-project', conversationId: 'history-room', messageId: 'message-' + n, agentId: 'role-family-gpt' }, role: 'GPT', actual: 'Unclear status', expected: 'Explain the outcome plainly', message: 'Internal jargon', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false }))).cases;
  store.setReplaySplit({ caseIds: sources.map(c => c.id) });
  const input = n => ({ sourceCaseId: sources[n].id, category: 'reproduction', task: 'Write the current status in REPORT.md.',
    fixture: { commit: 'a'.repeat(40), sourceCommit: 'b'.repeat(40), sourceSubdirectory: 'R1', filesHash: 'c'.repeat(64) },
    request: { captureRoot: path.join(root, 'capture'), flagId: 'flag-' + crypto.createHash('sha256').update('fixture-project\0answer-' + n).digest('hex'), association: { projectId: 'fixture-project', conversationId: 'fixture-room-' + n, messageId: 'answer-' + n, turnId: 'turn-' + n, agentId: 'role-family-gpt', taskId: 'task-' + n, checkpointId: 'checkpoint-' + n, runId: n + 1 } },
    rules: { kind: 'file-literals-v1', files: [{ path: 'REPORT.md', contains: ['complete'], notContains: ['CAS'] }] },
    checkpointHash: 'd'.repeat(64) });
  return { options, store, sources, input };
}
test('sealed replay registrations are global, immutable, restart-persistent and inherit the frozen source split', t => {
  const h = setup(t), before = h.store.read();
  const saved = h.store.addReplayCase(h.input(0));
  assert.equal(saved.kind, 'sealed-replay'); assert.equal(saved.replayable, true);
  assert.equal(saved.split, before.cases[0].split);
  assert.equal(saved.sourceCaseId, h.sources[0].id);
  assert.deepEqual(saved.source, before.cases[0].source);
  assert.equal(saved.projectId, undefined);
  assert.equal(h.store.read().cases.length, 6, 'historical sources remain text-only, not fabricated historical snapshots');
  assert.deepEqual(h.store.read().cases, before.cases);
  assert.deepEqual(h.store.read().replaySplit, before.replaySplit);
  assert.deepEqual(createWikiStore(h.options).read().replayCases, [saved]);
  const revision = h.store.read().revision;
  assert.deepEqual(h.store.addReplayCase(h.input(0)), saved);
  assert.equal(h.store.read().revision, revision);
  const changed = h.input(0); changed.task += ' Different request.';
  assert.throws(() => h.store.addReplayCase(changed), code('wiki_replay_conflict'));
});
test('replay registrations reject unknown sources, reused checkpoints, unapproved grouping and extra fields', t => {
  const h = setup(t);
  h.store.addReplayCase(h.input(0));
  const unknown = h.input(1); unknown.sourceCaseId = 'unknown';
  assert.throws(() => h.store.addReplayCase(unknown), code('wiki_unknown_case'));
  const reuse = h.input(1); reuse.request = h.input(0).request;
  assert.throws(() => h.store.addReplayCase(reuse), code('wiki_replay_conflict'));
  for (const alter of [v => { v.category = 'failure'; }, v => { v.split = 'train'; }, v => { v.fixture.commit = 'HEAD'; }, v => { v.checkpointHash = 'bad'; }, v => { v.request.captureRoot = 'relative'; }]) {
    const v = h.input(1); alter(v);
    assert.throws(() => h.store.addReplayCase(v));
  }
});
test('registration CLI is confirmation-gated, validates sealed materials and rules before any store mutation', t => {
  const h = setup(t), config = { ...h.options, cases: [h.input(0)] };
  const { registerReplayCases } = require('../../scripts/badcase-capture/register-replay-cases.cjs');
  const before = h.store.read();
  assert.throws(() => registerReplayCases(config, false), code('wiki_confirmation_required'));
  assert.throws(() => registerReplayCases(config, true), code('wiki_replay_materials_unavailable'));
  assert.deepEqual(h.store.read(), before);
  let calls = 0;
  const prepared = () => { calls++; return { supported: true, provenance: { checkpointHash: 'd'.repeat(64) } }; };
  const bad = structuredClone(config); bad.cases[0].rules.files[0].path = '../outside';
  assert.throws(() => registerReplayCases(bad, true, { prepare: prepared }));
  assert.equal(calls, 0);
  const result = registerReplayCases(config, true, { prepare: prepared });
  assert.equal(result.replayCases.length, 1); assert.equal(result.replayCases[0].split, h.store.read().cases[0].split);
  const mismatch = h.input(1); mismatch.checkpointHash = 'e'.repeat(64);
  assert.throws(() => registerReplayCases({ ...config, cases: [mismatch] }, true, { prepare: prepared }), code('wiki_replay_materials_unavailable'));
});
test('a later invalid source in a batch cannot publish an earlier valid registration', t => {
  const h = setup(t), before = h.store.read(), invalid = h.input(1);
  invalid.sourceCaseId = 'unknown';
  assert.throws(() => h.store.addReplayCases([h.input(0), invalid]), code('wiki_unknown_case'));
  assert.deepEqual(h.store.read(), before);
});
test('legacy snapshots without replayCases are read without rewriting the reviewed history', t => {
  const h = setup(t), directory = path.join(h.options.globalRoot, 'snapshots');
  const file = path.join(directory, fs.readdirSync(directory).filter(n => n.endsWith('.json')).sort().at(-1));
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete envelope.record.replayCases;
  envelope.checksum = crypto.createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex');
  fs.writeFileSync(file, JSON.stringify(envelope) + '\n');
  const before = fs.readFileSync(file);
  assert.deepEqual(createWikiStore(h.options).read().replayCases, []);
  assert.deepEqual(fs.readFileSync(file), before);
});
