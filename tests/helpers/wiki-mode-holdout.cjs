// Production-shaped, entirely synthetic: role stores the agent id, #22 is
// mode 6 training, #23/#24 are its frozen holdouts. No live store or transport.
const crypto = require('node:crypto');
const base = '../../build/server/domain/runtime/badcase-capture/';
const { createWikiRubric, wikiValueHash: hash } = require(base + 'wiki-rubric');
const { createWikiOriginalPrecheckPlan, summarizeWikiOriginalPrecheck } = require(base + 'wiki-original-precheck');
module.exports = function fixture({ run24 = true } = {}) {
  const now = '2026-11-11T00:00:00.000Z';
  const legacy = { id: 'text-3ff896480224fea1cde010370be091785529db0b1b18d8b5e0648a0a4f15aa89', kind: 'text', role: 'GPT', split: 'train', actual: 'legacy', expected: 'legacy', source: { agentId: 'role-family-gpt' } };
  const marked = Array.from({ length: 8 }, (_, n) => {
    const number = n + 17, source = { projectId: 'synthetic-project', conversationId: 'synthetic-room-' + number, messageId: 'synthetic-message-' + number, agentId: 'role-family-gpt' };
    return { id: 'marked-' + crypto.createHash('sha256').update(JSON.stringify({ projectId: source.projectId, conversationId: source.conversationId, messageId: source.messageId })).digest('hex'),
      kind: 'marked-badcase', role: 'role-family-gpt', source, split: number === 22 ? 'train' : number === 24 ? 'test' : 'gate',
      sealedCheckpointId: number === 24 && run24 ? null : 'checkpoint-' + number, traceBundle: { hash: hash('synthetic trace ' + number) },
      actual: 'reason too long ' + number, expected: 'reason within limit ' + number,
      message: 'synthetic reply', traceExcerpt: '', traceState: 'missing', messageTruncated: false, traceTruncated: false };
  });
  const state = { revision: 1, cases: [legacy, ...marked],
    versions: [{ id: 'version-1', entries: [{ id: 'entry-6', status: 'approved', caseIds: [marked[5].id] }, { id: 'entry-1', status: 'approved', caseIds: [legacy.id] }] }],
    patternLabels: marked.map((c, n) => ({ caseId: c.id, entryId: n >= 5 ? 'entry-6' : 'entry-1', source: 'badcase-page', confirmedAt: now })),
    rubrics: marked.map(c => ({ ...createWikiRubric({ caseId: c.id, version: 1, model: 'deepseek/deepseek-v4-flash', actual: c.actual, expected: c.expected, questions: [], scoringModel: null,
      toolCheck: { method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] } }),
      status: 'frozen', confirmedAt: now, confirmationRecord: 'Synthetic assertion approval' })),
    replayCases: marked.filter(c => c.sealedCheckpointId).map(c => ({ id: 'replay-' + c.id.slice(7, 23), sourceCaseId: c.id, checkpointHash: hash('synthetic checkpoint ' + c.id), request: { association: { checkpointId: c.sealedCheckpointId } } })),
    dehydrations: [], controlConfirmations: [], classifications: [] };
  if (run24) {
    const c = marked[7], content = { caseId: c.id, kind: 'single', level: 'run', traceHash: c.traceBundle.hash, cutStep: 42 };
    state.dehydrations.push({ caseId: c.id, traceHash: c.traceBundle.hash, decision: { ...content, hash: require(base + 'wiki-run-replay').wikiRunHash(content) } });
  }
  const replayChecks = marked.map(c => c.sealedCheckpointId ? { caseId: c.id, level: 'trace', status: 'supported', checkpointHash: state.replayCases.find(r => r.sourceCaseId === c.id).checkpointHash }
    : { caseId: c.id, level: 'run', status: 'supported', traceHash: c.traceBundle.hash, decisionHash: state.dehydrations.find(r => r.caseId === c.id).decision.hash, cutStep: 42 });
  const records = [];
  function save(number, statuses, { status = 'completed', reserve = false, createdAt = now } = {}) {
    const c = marked[number - 17], rubric = state.rubrics.find(r => r.caseId === c.id);
    const plan = createWikiOriginalPrecheckPlan({ state, caseId: c.id, rubricHash: rubric.hash, inputHash: hash('synthetic original request ' + number), replayChecks, judge: null,
      ...(statuses?.length ? { policy: { repeats: statuses.length } } : {}) });
    statuses ??= Array.from({ length: plan.policy.repeats }, (_, i) => i < Math.ceil(plan.policy.repeats / 2) ? 'fail' : 'pass');
    const id = 'precheck-00000000-0000-4000-8000-' + String(records.length + 1).padStart(12, '0');
    const reservation = { kind: 'wiki-original-precheck-reservation-v1', id, createdAt, plan };
    const outcome = { status, reason: status === 'completed' ? null : 'operator_stop', runs: statuses.map((s, i) => ({ iteration: i + 1, variant: 'original', status: s, artifactId: 'synthetic-' + i, artifactHash: hash('synthetic output ' + i), usageComplete: true })) };
    const result = reserve ? null : { kind: 'wiki-original-precheck-result-v1', id, finishedAt: createdAt, planHash: plan.planHash, ...outcome, summary: summarizeWikiOriginalPrecheck(plan, outcome) };
    records.push({ reservation, result }); return records.at(-1);
  }
  for (let number = 17; number <= 24; number++) save(number);
  return { state, records, replayChecks, marked, save, targetEntryId: 'entry-6', input() { return { state, records, replayChecks, targetEntryId: this.targetEntryId }; } };
};
