// Synthetic #22–#24 shape: frozen groups/labels, scene cuts and draft assertions.
// Never reads production data or invokes a model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { wikiValueHash: hash, createWikiRubric } = require(base + 'wiki-rubric');
module.exports = function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-case-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') };
  const store = require(base + 'wiki-store').createWikiStore(scope);
  const legacy = 'text-3ff896480224fea1cde010370be091785529db0b1b18d8b5e0648a0a4f15aa89';
  const cases = [legacy, ...Array.from({ length: 8 }, (_, i) => 'synthetic-' + (i + 17))].map((id, i) => ({
    id, kind: 'marked-badcase', role: 'role-family-gpt', split: i % 3 === 0 ? 'test' : i % 3 === 1 ? 'train' : 'gate',
    actual: '旧 Goal 工具理由超长', expected: '理由不超过上限', message: 'synthetic reply',
    source: { origin: 'local-mark', projectId: null, conversationId: 'synthetic-room', conversationTitle: 'Synthetic deletion', messageId: id, agentId: 'role-family-gpt' },
    sealedCheckpointId: 'cp-' + i, createdAt: '2026-11-09T00:00:00.000Z', traceState: 'missing', traceExcerpt: '', messageTruncated: false, traceTruncated: false,
  }));
  const packets = new Map();
  const { buildWikiTraceBundle, createWikiTraceStore, wikiTraceReference } = require(base + 'wiki-trace');
  for (const c of cases) {
    const packet = buildWikiTraceBundle({ source: c.source, origin: 'backfill', message: { content: c.message }, frozenAt: c.createdAt });
    createWikiTraceStore(scope.globalRoot).freeze(packet); c.traceBundle = wikiTraceReference(packet); packets.set(c.id, packet);
  }
  const rubrics = cases.map(c => createWikiRubric({ caseId: c.id, version: 1, model: 'deepseek/deepseek-v4-flash', actual: c.actual, expected: c.expected,
    questions: [], scoringModel: null, toolCheck: { method: 'code', target: { kind: 'native', name: 'goal_action' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] } }));
  const state = { ...store.read(), revision: 1, cases, rubrics,
    patternLabels: cases.map(c => ({ caseId: c.id, entryId: null, source: 'badcase-page', hash: hash(c.id) })),
    initialSplitConfirmations: [{ hash: hash('initial-split'), rows: cases.map(c => ({ caseId: c.id, confirmedSplit: c.split })) }],
    regroupConfirmations: [{ hash: hash('regroup'), rows: [] }], replaySplit: { hash: hash('legacy-split') },
    dehydrations: cases.map(c => ({ caseId: c.id, traceHash: c.traceBundle.hash, hash: hash('recommend-' + c.id), decision: { kind: 'single', level: 'run', cutStep: 1, hash: hash('cut-' + c.id) } })),
    replayCases: cases.map(c => ({ id: 'replay-' + c.id, sourceCaseId: c.id, checkpointHash: hash(c.id), request: { association: { checkpointId: c.sealedCheckpointId } } })),
  };
  const directory = path.join(scope.globalRoot, 'snapshots'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '000000000001.json');
  const seed = () => fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, checksum: require('node:crypto').createHash('sha256').update(JSON.stringify(state)).digest('hex'), record: state })); seed();
  const input = { caseIds: ['synthetic-22'], reason: '已由结构化工具解决', expectedRevision: 1 };
  const confirmation = { source: 'user-via-planner', reference: 'synthetic-approved-message' };
  function precheck(caseId = 'synthetic-22') {
    const c = cases.find(c => c.id === caseId), rubric = rubrics.find(r => r.caseId === caseId);
    const value = { kind: 'wiki-original-precheck-plan-v1', caseId, variant: 'original', model: 'openai-codex/gpt-6.1-sol',
      execution: { level: 'trace', traceHash: c.traceBundle.hash, sceneCheckpointId: c.sealedCheckpointId, replayId: 'replay-' + c.id, checkpointHash: hash(c.id) },
      split: c.split, rubricHash: rubric.hash, rubricVersion: 1, sourceHash: rubric.sourceHash, inputHash: hash('input'),
      policy: { kind: 'original-fixed-attempts-v1', repeats: 3, failureThreshold: .5, controlThreshold: 1 }, reportOnly: false };
    return { ...value, planHash: hash(value) };
  }
  function batch(caseId = 'synthetic-22') {
    return { kind: 'wiki-staged-batch-comparison-v1', model: 'openai-codex/gpt-6.1-sol',
      modelConfig: { api: 'openai-codex-responses', thinking: 'xhigh', fast: false, transport: 'sse', credentialDelivery: 'host-only-mailbox' },
      planHash: hash('batch'), repeats: 10, cases: [{ sourceCaseId: caseId, stage: 'gate', category: 'reproduction', reportOnly: false }] };
  }
  return { root, scope, store, state, file, seed, input, confirmation, packets, precheck, batch };
};
