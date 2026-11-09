// Inert production-shaped scene fixtures. Never restores a scene or executes commands.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = '../../build/server/domain/runtime/badcase-capture/';
module.exports = function setup(t, { reply = false, tool = true, evidence = 'reply' } = {}) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-scene-report-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const scope = { globalRoot: path.join(root, 'wiki'), sourceWorktree: path.join(root, 'source') }, store = require(base + 'wiki-store').createWikiStore(scope);
 const c = store.addMarkedCase({ source: { projectId: null, conversationId: 'synthetic-scene', conversationTitle: 'Synthetic scene', messageId: 'mark', agentId: 'role-family-gpt' }, role: 'role-family-gpt', sealedCheckpointId: 'synthetic-checkpoint', actual: 'reason too long', expected: 'reason within limit', message: 'marked reply', traceState: 'missing', traceExcerpt: '', traceTruncated: false, messageTruncated: false }).case;
 const bundle = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', source: c.source, origin: 'mark', frozenAt: '2026-11-09T00:00:00Z', complete: false, missingReasons: [], redaction: { policy: 'known_values_only' }, markedStep: 31, markedMessage: c.message, actual: c.actual, expected: c.expected,
  context: { systemPrompt: 'synthetic historical system', systemPromptSource: 'historical_display', priorSessionEntries: [], trigger: { type: 'message', message: { role: 'user', content: 'Continue the task.' } } },
  steps: Array.from({ length: 31 }, (_, i) => ({ step: i + 1, output: { role: 'assistant', content: [{ type: 'text', text: i === 28 ? 'bad tool call at cut' : 'synthetic history ' + i }] }, toolResults: [] })) };
 store.freezeCaseTrace(c.id, bundle); const item = () => store.read().cases.find(r => r.id === c.id);
 const built = require(base + 'wiki-dehydration').buildDehydrationRequest({ caseRecord: item(), bundle, cause: { source: 'trigger', text: 'Continue the task.' } });
 const rec = store.saveDehydrationRecommendation({ built, response: { model: 'deepseek/deepseek-v4-flash', attempts: [{ finishReason: 'stop', content: JSON.stringify({ kind: '单步型', cutStep: 29, reason: 'fix at cut', evidence: 'bad tool call at cut' }) }] }, expectedRevision: store.read().revision });
 const decision = store.confirmDehydration({ caseId: c.id, traceHash: item().traceBundle.hash, recommendationHash: rec.hash, kind: 'single', cutStep: 29, expectedRevision: store.read().revision });
 const draft = store.saveRubricDraft({ caseId: c.id, model: 'deepseek/deepseek-v4-flash', questions: reply ? [{ id: 'q1', question: 'The reply is clear.', evidence }] : [], scoringModel: reply ? { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' } : null,
  ...(tool ? { toolCheck: { method: 'code', target: { kind: 'caff-chat', name: 'suggest-goal' }, mode: 'on-call', rules: [{ parameter: 'reason', kind: 'max-chars', max: 1000 }] } } : {}) }, store.read().revision);
 const rubric = store.confirmRubric({ rubricId: draft.id, hash: draft.hash, confirmationRecord: 'Synthetic report approval' }, store.read().revision);
 const toolset = { codingAgentVersion: '0.85.1', capabilitiesSha: 'a'.repeat(40), capabilitiesFileHash: 'b'.repeat(64), definitions: [{ name: 'bash', description: 'inert schema only', parameters: { type: 'object' } }] };
 return { root, scope, store, c, item, bundle, decision, rubric, toolset };
};
