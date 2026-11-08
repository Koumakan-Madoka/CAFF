// Synthetic revision-118-shaped fixture: no production records or model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const legacyId = 'text-1c6e58c2f58ac57383a1910cd01dd96b4b6c2989078d6963b83284a4a8abaa47';
function fixture(count = 4) {
  const at = '2026-11-08T00:00:00.000Z';
  // Live marked cases store the agent ID in role, not the display family name.
  const trace = (id, split = null) => ({ id, kind: 'marked-badcase', role: 'role-family-gpt', split, sealedCheckpointId: 'cp-' + id,
    source: { agentId: 'role-family-gpt', conversationId: 'synthetic-room', messageId: id },
    actual: 'Synthetic failure ' + id, expected: 'Check tool constraints first', createdAt: at, traceBundle: { hash: hash(id) },
    preclassification: { kind: 'new', entryId: null, confidence: 'high', reason: 'Synthetic new pattern suggestion', createdAt: at } });
  const oldLabel = { caseId: legacyId, entryId: null, source: 'badcase-page', labelHash: hash('old label'), confirmedRevision: 100, confirmedAt: at };
  const state = { schemaVersion: 1, scope: 'global', revision: 118,
    cases: [trace('old-train', 'train'), trace('old-control', 'gate'), { ...trace(legacyId, 'test'), kind: 'text-only', role: 'GPT' },
      ...Array.from({ length: count }, (_, i) => trace('new-' + (i + 1)))],
    versions: [{ id: 'wiki-3', createdAt: at, entries: [1, 2, 3].map(i => ({ id: 'entry-' + i, title: 'Approved pattern ' + i,
      status: i === 3 ? 'draft' : 'approved', caseIds: i === 1 ? ['old-train'] : [] })) }],
    classifications: [{ caseId: 'old-control', entryId: 'entry-2', source: 'manual', confirmedAt: at }],
    patternLabels: [{ ...oldLabel, hash: hash(oldLabel) }], caseStates: [], events: [], suggestions: [], candidates: [], replayCases: [],
    replaySplit: { id: 'synthetic-frozen-split' }, regroupProposals: [{ hash: hash('frozen proposal') }],
    regroupConfirmations: [{ hash: hash('frozen confirmation') }], initialSplitConfirmations: [], dehydrations: [],
    deletedCases: [], rubrics: [], replayVersions: [], comparisonReviews: [], baselines: [], experiences: [], inductionRuns: [] };
  return state;
}
function setup(t, count = 4) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-pending-patterns-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') };
  const directory = path.join(options.globalRoot, 'snapshots'); fs.mkdirSync(directory, { recursive: true });
  function publish(state) {
    fs.writeFileSync(path.join(directory, String(state.revision).padStart(12, '0') + '.json'),
      JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state }) + '\n');
  }
  const state = fixture(count); publish(state);
  const store = require(base + 'wiki-store').createWikiStore(options);
  function input(caseId, selection) {
    const state = store.read(), label = require(base + 'wiki-initial-split').projectWikiPatternLabels(state).find(r => r.caseId === caseId);
    return { caseId, labelHash: label.labelHash, expectedRevision: state.revision, ...selection };
  }
  const confirm = (caseId, selection) => store.confirmPatternLabel(input(caseId, selection));
  function bytes() { return Object.fromEntries(fs.readdirSync(directory).sort().map(f => [f, fs.readFileSync(path.join(directory, f), 'utf8')])); }
  return { root, directory, store, state, options, publish, input, confirm, bytes };
}
module.exports = { fixture, setup, hash, legacyId };
