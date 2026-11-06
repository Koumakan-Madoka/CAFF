const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const approvedEntry = { id: 'entry-1', title: '未经要求引入额外机制', failureMode: '简单任务被扩大', symptoms: '增加额外审批', rootCauseHypothesis: '过度设计', guideline: '先完成用户明确要求。', caseIds: ['c1'], status: 'approved', reviewedAt: '2026-10-31T10:00:00Z' };
function data() {
  return { schemaVersion: 1, scope: 'global', revision: 3, targets: [
    { id: 'global-harness-behavior-v1', kind: 'global-system-prompt', title: '全局系统提示词 · 共用行为准则', baseText: 'Shared harness prose.', baseHash: 'a'.repeat(64) },
    { id: 'tool-description-send-public', kind: 'tool-description', title: '工具描述 · send-public（公开发言）', baseText: 'Post publicly.', baseHash: 'b'.repeat(64) },
    { id: 'tool-description-list_rooms', kind: 'tool-description', title: '工具描述 · list_rooms', baseText: 'List Rooms.', baseHash: 'c'.repeat(64) },
  ], cases: [
    { id: 'c1', kind: 'text-only', split: 'train', actual: 'MVP 阶段又增加审批流程', expected: '先完成明确要求', message: '<script>bad()</script>', traceState: 'missing', traceExcerpt: '', source: { projectId: 'p1', conversationId: 'room-1', conversationTitle: 'WikiSkill调优CAF', messageId: 'm1', agentId: 'role-family-gpt' }, createdAt: '2026-10-31T01:00:00Z' },
    { id: 'c2', kind: 'text-only', split: 'test', actual: '验收步骤术语太多', expected: '写成可操作步骤', message: '', traceState: 'missing', traceExcerpt: '', source: { projectId: 'p2', conversationId: 'room-2', conversationTitle: '验收房间', messageId: 'm2', agentId: 'role-family-gpt' }, createdAt: '2026-10-31T01:01:00Z' },
    { id: 'c3', kind: 'marked-badcase', split: 'train', actual: '更新 README 前又检查其他文件', expected: '直接更新 README', message: '', traceState: 'missing', traceExcerpt: '', source: { projectId: 'p3', conversationId: 'room-3', conversationTitle: '重写CAFF的README', messageId: 'm3', agentId: 'role-family-kimi' }, createdAt: '2026-10-31T11:00:00Z' },
    { id: 'c4', kind: 'marked-badcase', split: 'train', actual: '简单任务外又增加核对流程', expected: '按用户要求直接做', message: '', traceState: 'missing', traceExcerpt: '', source: { projectId: 'p4', conversationId: 'room-4', conversationTitle: '新标记房间', messageId: 'm4', agentId: 'role-family-kimi' }, createdAt: '2026-10-31T11:02:00Z' },
    { id: 'c5', kind: 'marked-badcase', split: 'train', actual: '把 room worktree 说成 DAG 专用', expected: '按实际结构描述', message: '', traceState: 'missing', traceExcerpt: '', source: { projectId: 'p5', conversationId: 'room-5', conversationTitle: '事实描述房间', messageId: 'm5', agentId: 'role-family-kimi' }, createdAt: '2026-10-31T11:03:00Z' },
  ], caseStates: [
    { caseId: 'c1', status: 'assigned', memberships: [{ entryId: 'entry-1', source: 'version', at: '2026-10-31T10:00:00Z' }], reason: '', updatedAt: '2026-10-31T10:00:00Z' },
    { caseId: 'c2', status: 'holdout', memberships: [], reason: '留出用例不参与归纳', updatedAt: '2026-10-31T01:01:00Z' },
    { caseId: 'c3', status: 'pending', memberships: [], reason: '', updatedAt: '2026-10-31T11:00:00Z' },
    { caseId: 'c4', status: 'suggested', memberships: [], reason: '同属额外流程', updatedAt: '2026-10-31T11:04:00Z' },
    { caseId: 'c5', status: 'unfit', memberships: [], reason: '孤立事实错误，等待同类用例', updatedAt: '2026-10-31T11:05:00Z' },
  ], suggestions: [
    { id: 's-assign', runId: 'run-1', caseId: 'c4', kind: 'assign', entryId: 'entry-1', reason: '同属额外流程', confidence: '中', status: 'pending', createdAt: '2026-10-31T11:04:00Z' },
    { id: 's-none', runId: 'run-1', caseId: 'c5', kind: 'none', reason: '孤立事实错误，等待同类用例', confidence: '低', status: 'pending', createdAt: '2026-10-31T11:05:00Z' },
  ], versions: [{ id: 'wiki-3', createdAt: '2026-10-31T01:07:00Z', model: 'deepseek/deepseek-v4-flash', caseIds: ['c1'], entries: [clone(approvedEntry)], unclassified: [] }],
  replaySplit: { trainCaseIds: ['c1', 'c3', 'c4', 'c5'], testCaseIds: ['c2'], createdAt: '2026-10-31T01:06:00Z' },
  replayCases: [
    { sourceCaseId: 'c1', task: '看下项目情况并写报告。', category: 'reproduction', split: 'train', fixture: { commit: 'a'.repeat(40) }, request: { association: { checkpointId: 'cp1' } }, createdAt: '2026-10-31T09:00:00Z' },
    { sourceCaseId: 'c2', task: '写验收步骤。', category: 'control', split: 'test', fixture: { commit: 'b'.repeat(40) }, request: { association: { checkpointId: 'cp2' } }, createdAt: '2026-10-31T09:01:00Z' },
  ], candidates: [{ id: 'candidate-global', kind: 'global-wiki-candidate-v1', targetId: 'global-harness-behavior-v1', versionId: 'wiki-3', entryIds: ['entry-1'], candidateHash: 'd'.repeat(64),
    target: { id: 'global-harness-behavior-v1', kind: 'global-system-prompt', title: '全局系统提示词 · 共用行为准则', baseText: 'Shared harness prose.' },
    candidateText: 'Shared harness prose.\n\nWikiSkill 已审核准则：\n- 先完成用户明确要求。', diff: '--- a/x\n+++ b/x\n@@\n\\ No newline', status: 'draft', createdAt: '2026-10-31T10:45:00Z' },
    { id: 'candidate-old', kind: 'global-wiki-candidate-v1', targetId: 'tool-description-list_rooms', versionId: 'wiki-3', entryIds: ['entry-1'], candidateHash: 'e'.repeat(64),
      target: { id: 'tool-description-list_rooms', kind: 'tool-description', title: '工具描述 · list_rooms', baseText: 'List Rooms.' }, candidateText: 'Retained old prose', diff: '+hidden', status: 'deprecated', createdAt: '2026-10-31T10:46:00Z' }],
  events: [], inductionRuns: [], comparisons: [] };
}
function setup(t, handler) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only', url: 'http://127.0.0.1/wikiskill.html' });
  t.after(() => dom.window.close());
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-pipeline.js'), 'utf8'));
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-wiki.js'), 'utf8'));
  const root = dom.window.document.getElementById('panel'), calls = [], confirms = [];
  let accepted = true, saved = data();
  const panel = dom.window.CaffShared.createBadcaseWikiPanel({ root, confirm: message => { confirms.push(message); return accepted; }, fetchJson: async (url, options = {}) => {
    calls.push({ url, ...options }); const custom = handler?.(url, options, saved); if (custom !== undefined) return custom;
    if (options.method === 'POST') {
      if (url.endsWith('/induct')) {
        const state = saved.caseStates.find(s => s.caseId === 'c3'); state.status = 'suggested'; state.reason = '建议归入额外流程';
        saved.suggestions.push({ id: 's-new-assign', runId: 'run-new', caseId: 'c3', kind: 'assign', entryId: 'entry-1', reason: '建议归入额外流程', confidence: '高', status: 'pending', createdAt: '2026-10-31T11:10:00Z' });
        saved.events.push({ id: 'event-run', type: 'induction-run', runId: 'run-new', caseIds: ['c3'], createdAt: '2026-10-31T11:10:00Z' });
      } else if (url.endsWith('/suggestion')) {
        const suggestion = saved.suggestions.find(s => s.id === options.body.suggestionId); suggestion.status = options.body.decision;
        const state = saved.caseStates.find(s => s.caseId === suggestion.caseId);
        if (options.body.decision === 'accepted') { state.status = 'assigned'; state.memberships = [{ entryId: suggestion.entryId, source: 'model-confirmed', at: '2026-10-31T11:11:00Z' }]; }
        else { state.status = 'pending'; state.memberships = []; }
        saved.events.push({ id: 'event-resolve-' + suggestion.id, type: options.body.decision === 'accepted' ? 'suggestion-confirmed' : 'suggestion-rejected', suggestionId: suggestion.id, caseIds: [suggestion.caseId], createdAt: '2026-10-31T11:11:00Z' });
      } else if (url.endsWith('/membership')) {
        const state = saved.caseStates.find(s => s.caseId === options.body.caseId);
        state.status = options.body.entryId ? 'assigned' : 'pending'; state.memberships = options.body.entryId ? [{ entryId: options.body.entryId, source: 'manual', at: '2026-10-31T11:12:00Z' }] : [];
      } else if (url.endsWith('/review')) {
        const version = saved.versions.find(v => v.id === options.body.versionId), entry = version.entries.find(e => e.id === options.body.entryId);
        Object.assign(entry, options.body.patch); if (options.body.decision) entry.status = options.body.decision;
        if (entry.suggestionIds && options.body.decision) for (const id of entry.suggestionIds) {
          const suggestion = saved.suggestions.find(s => s.id === id); suggestion.status = options.body.decision === 'approved' ? 'accepted' : 'rejected';
          const state = saved.caseStates.find(s => s.caseId === suggestion.caseId); state.status = options.body.decision === 'approved' ? 'assigned' : 'pending';
          if (options.body.decision === 'approved') state.memberships = [{ entryId: entry.id, source: 'model-confirmed', at: '2026-10-31T11:13:00Z' }];
        }
      } else if (url.endsWith('/candidate')) {
        const target = saved.targets.find(v => v.id === options.body.targetId);
        saved.candidates.push({ id: 'candidate-new', kind: 'global-wiki-candidate-v1', targetId: target.id, target, versionId: options.body.versionId, entryIds: options.body.entryIds,
          candidateHash: 'f'.repeat(64), candidateText: target.baseText + '\n\nWikiSkill 已审核准则：\n- 先完成用户明确要求。', diff: '+not-rendered', status: 'draft', createdAt: '2026-10-31T11:14:00Z' });
      } else if (url.endsWith('/confirm-global-candidate')) saved.candidates.find(c => c.id === options.body.candidateId).status = 'confirmed';
      saved.revision++;
    }
    return clone(saved);
  } });
  return { root, panel, calls, confirms, saved: () => saved, window: dom.window, accept: value => { accepted = value; }, posts: () => calls.filter(c => c.method === 'POST'),
    click: async selector => { const element = root.querySelector(selector); assert.ok(element, selector); element.click(); await tick(); await tick(); } };
}

test('assertion editor saves manual changes as new versions, offers eligible models only and freezes the saved hash explicitly', async t => {
  const { createWikiRubric } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
  const h = setup(t, (url, options, saved) => {
    if (options.method !== 'POST' || !['/api/wikiskill/rubric', '/api/wikiskill/confirm-rubric'].includes(url)) return undefined;
    if (url.endsWith('/rubric')) {
      const source = saved.cases.find(c => c.id === options.body.caseId);
      saved.rubrics.push(createWikiRubric({ ...options.body, model: 'deepseek/deepseek-v4-flash', version: saved.rubrics.length + 1, actual: source.actual, expected: source.expected }));
    } else Object.assign(saved.rubrics.find(r => r.id === options.body.rubricId), { status: 'frozen', confirmedAt: '2026-11-05T00:00:00.000Z', confirmationRecord: 'synthetic-page-confirmation' });
    saved.revision++; return clone(saved);
  });
  h.saved().rubrics = []; h.saved().eligibleJudges = [{ backend: 'deepseek', model: 'deepseek/deepseek-v4-flash', configurationHash: 'a'.repeat(64), freezeHash: 'b'.repeat(64), promptHash: 'c'.repeat(64) }];
  await h.panel.load(); await h.click('[data-tab="cases"]');
  const panel = () => h.root.querySelector('#c-1 [data-rubric-panel]');
  assert.ok(panel()); assert.equal(panel().querySelectorAll('[data-rubric-model] option').length, 2); assert.doesNotMatch(panel().querySelector('[data-rubric-model]').textContent, /JEV|GPT/);
  const question = panel().querySelector('[data-rubric-question]'); question.value = '回复先给结论。'; question.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const select = panel().querySelector('[data-rubric-model]'); select.value = 'deepseek'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.click('#c-1 [data-save-rubric]'); const post = h.posts().at(-1);
  assert.equal(post.url, '/api/wikiskill/rubric'); assert.equal(post.body.expectedRevision, 3); assert.equal(post.body.questions[0].question, question.value);
  assert.deepEqual(clone(post.body.scoringModel), { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' });
  assert.equal(panel().querySelector('[data-freeze-rubric]').disabled, false);
  const changed = panel().querySelector('[data-rubric-question]'); changed.value = '尚未保存的修订。'; changed.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(panel().querySelector('[data-freeze-rubric]').disabled, true, 'unsaved text must not freeze an older hash');
  changed.value = '回复先给结论。'; changed.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  h.accept(false); await h.click('#c-1 [data-freeze-rubric]'); assert.equal(h.posts().length, 1);
  h.accept(true); await h.click('#c-1 [data-freeze-rubric]'); const frozen = clone(h.saved().rubrics[0]);
  assert.equal(h.posts().at(-1).body.hash, frozen.hash); assert.match(panel().textContent, /已冻结/); assert.equal(panel().querySelector('[data-rubric-question]'), null);
  await h.click('#c-1 [data-edit-rubric]'); await h.click('#c-1 [data-add-assertion]'); assert.equal(panel().querySelectorAll('[data-rubric-question]').length, 2);
  const second = panel().querySelectorAll('[data-rubric-question]')[1]; second.value = '回复解释依据。'; second.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await h.click('#c-1 [data-save-rubric]'); assert.deepEqual(h.saved().rubrics[0], frozen); assert.equal(h.saved().rubrics[1].version, 2);
});
test('assertion editor offers file evidence only for the same case with file-literals collection', async t => {
  const h = setup(t);
  h.saved().replayCases = [
    { ...h.saved().replayCases[0], rules: { kind: 'file-literals-v1' } },
    { ...h.saved().replayCases[1], rules: { kind: 'read-only-files-v1' } },
    { sourceCaseId: 'c3', rules: { kind: 'public-reply-literals-v1' }, fixture: {}, request: { association: {} } },
    { sourceCaseId: 'c4', rules: { kind: 'completion-public-reply-v1' }, fixture: {}, request: { association: {} } },
  ];
  await h.panel.load(); await h.click('[data-tab="cases"]');
  for (let i = 1; i <= 5; i++) {
    const values = [...h.root.querySelectorAll(`#c-${i} [data-rubric-evidence] option`)].map(o => o.value);
    assert.deepEqual(values, i === 1 ? ['reply', 'trace', 'files'] : ['reply', 'trace'], 'case ' + i);
  }
  const question = h.root.querySelector('#c-1 [data-rubric-question]'); question.value = '文件呈现核验依据。'; question.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  const select = h.root.querySelector('#c-1 [data-rubric-evidence]'); select.value = 'files'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.click('#c-1 [data-save-rubric]'); assert.equal(h.posts().at(-1).body.questions[0].evidence, 'files');
  await h.click('[data-cases-mode="list"]');
  assert.equal(h.root.querySelector('#c-2 [data-rubric-evidence] option[value="files"]'), null);
});
test('AI assertion drafting is explicit, annotation-only and never freezes or chooses an ineligible model', async t => {
  const { createWikiRubric } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
  const h = setup(t, (url, options, saved) => {
    if (url !== '/api/wikiskill/draft-rubric' || options.method !== 'POST') return undefined;
    saved.rubrics = [createWikiRubric({ caseId: options.body.caseId, version: 1, model: 'deepseek/deepseek-v4-flash', actual: saved.cases[0].actual, expected: saved.cases[0].expected,
      questions: [{ id: 'q1', question: '回复说明结论 <script>not-html</script>。', evidence: 'reply' }] })]; saved.revision++; return clone(saved);
  });
  h.saved().eligibleJudges = []; await h.panel.load(); await h.click('[data-tab="cases"]');
  h.accept(false); await h.click('#c-1 [data-draft-rubric]'); assert.equal(h.posts().length, 0);
  h.accept(true); await h.click('#c-1 [data-draft-rubric]');
  assert.deepEqual(clone(h.posts()[0].body), { confirmed: true, expectedRevision: 3, caseId: 'c1' });
  assert.match(h.root.querySelector('#c-1 [data-rubric-panel]').textContent, /尚无校准达标/); assert.equal(h.root.querySelector('#c-1 [data-freeze-rubric]').disabled, true);
  assert.equal(h.root.querySelector('#c-1 [data-rubric-panel] script'), null); assert.equal(h.saved().rubrics[0].status, 'draft');
});
test('case layout and filters reapply assertion eligibility and failed-write locks after rerender', async t => {
  const { createWikiRubric } = require('../../build/server/domain/runtime/badcase-capture/wiki-rubric');
  const h = setup(t, (_url, options) => { if (options.method === 'POST') throw Error('synthetic-rejection'); });
  h.saved().rubrics = [createWikiRubric({ caseId: 'c1', version: 1, model: 'deepseek/deepseek-v4-flash', actual: h.saved().cases[0].actual, expected: h.saved().cases[0].expected,
    questions: [{ id: 'q1', question: '回复先给结论。', evidence: 'reply' }] })];
  h.saved().eligibleJudges = [];
  await h.panel.load(); await h.click('[data-tab="cases"]'); await h.click('[data-cases-mode="list"]');
  const panel = () => h.root.querySelector('#c-1 [data-rubric-panel]');
  assert.equal(panel().querySelector('[data-freeze-rubric]').disabled, true, 'layout switch cannot enable a draft with no eligible model');
  await h.click('#c-1 [data-save-rubric]'); assert.equal(h.posts().length, 1);
  await h.click('[data-cases-mode="group"]');
  for (const el of panel().querySelectorAll('textarea,select,button')) assert.equal(el.disabled, true, el.outerHTML);
  const filter = h.root.querySelector('#cases-split'); filter.value = 'train'; filter.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  for (const el of panel().querySelectorAll('textarea,select,button')) assert.equal(el.disabled, true, el.outerHTML);
  assert.equal(h.posts().length, 1, 'rerenders never retry a failed write');
});
test('v2 results show frozen assertions, three-vote citations, hard failures, technical errors and reference-only metrics', async t => {
  const h = setup(t, (url, _options, saved) => url === '/api/wikiskill/executions' ? { executions: [], comparisons: clone(saved.comparisons) } : undefined), rubric = { version: 5, hash: 'a'.repeat(64), scoringModel: { backend: 'deepseek', model: 'deepseek/deepseek-v4-flash' }, questions: [{ id: 'q1', question: '冻结时的断言。', evidence: 'reply' }] };
  const binding = { backend: 'deepseek', model: rubric.scoringModel.model, promptHash: 'b'.repeat(64), modelHash: 'c'.repeat(64) };
  const verdict = 'not-satisfied', votes = [0, 1, 2].map(() => [{ criterionId: 'q1', verdict, reason: '缺少使用者影响 <script>not-html</script>', evidence: [{ source: 'reply', text: '新增功能 <img src=x onerror=bad()>' }] }]);
  const assessment = { status: 'fail', reason: 'rubric_not_satisfied', binding, hardAssertions: [{ id: 'completed', status: 'pass' }, { id: 'publicReply', status: 'pass' }], judgments: [{ criterionId: 'q1', verdict, majority: true }], votes, referenceMetrics: { noForbiddenTerms: false, conclusionInLead: true } };
  const totals = { original: { planned: 10, passed: 0, failed: 1, errors: 1, notRun: 9 }, candidate: { planned: 10, passed: 0, failed: 1, errors: 0, notRun: 9 } };
  h.saved().rubrics = [{ ...rubric, questions: [{ ...rubric.questions[0], question: '当前编辑器的新断言不应进入旧结果' }] }];
  h.saved().comparisons = [{ id: 'scored-v2', kind: 'wiki-staged-batch-comparison-v2', createdAt: '2026-11-05T01:00:00Z', completed: false, model: 'openai-codex/gpt-6.1-sol', evaluation: { splitPolicy: 'd15-frozen-v1' }, experiment: { planHash: 'd'.repeat(64) }, modelCallsKnown: 4,
    cases: [{ sourceCaseId: 'c1', category: 'reproduction', stage: 'gate', totals, rubric, comparison: { scoring: { binding } }, runs: [
      { variant: 'original', iteration: 1, status: 'fail', assessment },
      { variant: 'original', iteration: 2, status: 'error', reason: 'judge_backend_failed', assessment: { ...assessment, status: 'error', reason: 'judge_backend_failed', votes: [], judgments: [] } },
      { variant: 'candidate', iteration: 1, status: 'fail', assessment: { ...assessment, reason: 'hard_assertion_failed', votes: [], judgments: [], hardAssertions: [{ id: 'completed', status: 'fail' }, { id: 'publicReply', status: 'pass' }] } },
    ] }] }];
  await h.panel.load(); await h.click('[data-tab="impact"]'); const results = h.root.querySelector('#impact-runs'), text = results.textContent;
  for (const literal of ['硬断言＋AI', '冻结时的断言', '不成立', '缺少使用者影响', '新增功能', '参考字面指标', '不决定通过', 'judge_backend_failed', 'hard_assertion_failed', binding.promptHash, 'd'.repeat(64)]) assert.ok(text.includes(literal), literal);
  assert.doesNotMatch(text, /当前编辑器的新断言|字面规则不是语义判断/); assert.equal(results.querySelector('script,img'), null); assert.equal(h.posts().length, 0);
  const expanded = results.querySelector('.assertion-results'); expanded.open = true;
  await h.panel.refreshExecutions(); assert.equal(results.querySelector('.assertion-results'), expanded, 'unchanged polling must not collapse the evidence being read'); assert.equal(expanded.open, true);
  h.saved().comparisons[0].kind = 'wiki-staged-batch-comparison-v1'; await h.panel.load(); await h.click('[data-tab="impact"]'); assert.match(h.root.querySelector('#impact-runs').textContent, /字面规则/);
});

test('Badcase request action reaches the guarded case API once, disables during send, then shows confirmation without auto-freezing', async t => {
  let release;
  const h = setup(t, (url, options, saved) => {
    if (options.method === 'POST' && url.endsWith('/dehydration/recommend')) return new Promise(r => { release = () => {
      saved.revision++; saved.cases[0].dehydrationRecommendation = { eligible: false };
      saved.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), hash: 'c'.repeat(64), request: { state: { steps: [{ step: 1, body: 'reply' }] } },
        recommendation: { schemaVersion: 2, retryPolicy: 'manual', kindSuggestion: 'single', cutStepSuggestion: 1, cutSource: 'deepseek', evidenceVerified: true, answers: { reason: '本步决定', evidence: 'reply' }, attempts: [] } }];
      r(clone(saved));
    }; });
  });
  h.saved().cases[0].traceBundle = { hash: 'a'.repeat(64), stepCount: 1 };
  h.saved().cases[0].dehydrationRecommendation = { eligible: true };
  await h.panel.load(); await h.click('[data-tab="badcases"]'); assert.equal(h.posts().length, 0);
  const button = h.root.querySelector('[data-dehydration-recommend="c1"]'); button.click(); button.click();
  assert.equal(h.posts().length, 1); assert.equal(button.disabled, true);
  assert.equal(h.posts()[0].url, '/api/wikiskill/cases/c1/dehydration/recommend');
  assert.deepEqual(clone(h.posts()[0].body), { confirmed: true, expectedRevision: 3, traceHash: 'a'.repeat(64) });
  release(); await tick(); await tick(); assert.ok(h.root.querySelector('[data-dehydration-confirm="c1"]'));
  assert.equal(h.root.querySelector('[data-dehydration-recommend="c1"]'), null); assert.equal(h.posts().length, 1);
});
test('deleted evidence disappears from knowledge counts/search while the frozen guideline and deletion audit remain', async t => {
  const h = setup(t), s = h.saved(); s.cases = s.cases.filter(c => c.id !== 'c1'); s.caseStates = s.caseStates.filter(c => c.caseId !== 'c1');
  s.events.push({ type: 'case-deleted', caseIds: ['c1'], caseNumbers: [7], reason: '<script>缺系统提示词</script>', createdAt: '2026-11-05T00:00:00Z' });
  const version = clone(s.versions); await h.panel.load();
  assert.match(h.root.querySelector('#wiki-list').textContent, /0 条用例/); assert.match(h.root.querySelector('#wiki-page').textContent, /暂无活动用例；准则文字保留/);
  assert.match(h.root.querySelector('#wiki-page').textContent, /先完成用户明确要求/); assert.deepEqual(s.versions, version);
  await h.click('[data-tab="impact"]'); assert.match(h.root.querySelector('#impact-log').textContent, /#7.*缺系统提示词.*冻结轨迹包、旧分组和历史结果保留/);
  assert.equal(h.root.querySelector('#impact-log script'), null); assert.equal(h.posts().length, 0);
});
test('production result labels model/thinking and report-only rows, without stale proxy disclaimers or unrelated tasks', async t => {
  const h = setup(t), totals = { original: { planned: 10, passed: 4, failed: 6, errors: 0, notRun: 0, scored: 10, passRate: .4 }, candidate: { planned: 10, passed: 8, failed: 2, errors: 0, notRun: 0, scored: 10, passRate: .8 } };
  h.saved().comparisons = [{ id: 'production-1', executionId: 'production-1', createdAt: '2026-11-03T12:00:00Z', model: 'openai-codex/gpt-6.1-sol', modelConfig: { thinking: 'xhigh', api: 'openai-codex-responses' }, completed: true, evaluation: { splitPolicy: 'd15-frozen-v1' }, modelCallsKnown: 40,
    cases: [{ sourceCaseId: 'c1', stage: 'gate', category: 'reproduction', reportOnly: false, totals }, { sourceCaseId: 'c2', stage: 'test', category: 'control', replayId: 'replay-version-synthetic', reportOnly: false, totals }, { sourceCaseId: 'c3', stage: 'gate', category: 'reproduction', family: 'deepseek', reportOnly: true, totals: { original: { planned: 0, passed: 0 }, candidate: { planned: 0, passed: 0 } } }], byStage: { gate: totals, test: totals } }];
  h.saved().comparisons[0].disclosures = ['post_observation_snapshot_head_rule_revision','topic_number_exemption_new_round'];
  h.saved().comparisons[0].cases[0].topicExemption={patterns:['priority-code'],taskHash:'f'.repeat(64),reason:'题目以 P1/P2/P3 为主题 <script>not-run</script>'};
  h.saved().replayCases.push({ sourceCaseId: 'c4', task: 'UNRELATED-OLD-TASK', category: 'probe', split: 'train' });
  await h.panel.load(); await h.click('[data-tab="impact"]'); const text = h.root.querySelector('#impact-runs').textContent;
  assert.match(text, /gpt-6.1-sol/); assert.match(text, /xhigh/); assert.match(text, /非GPT来源.*仅报告/); assert.match(text, /不计入/); assert.match(text, /样例.*新版本.*非历史复现/);
  assert.match(text, /看过结果.*现场快照 SHA.*修正.*作废.*不计入判定/);
  assert.match(text,/新轮主题编号豁免.*priority-code.*题目以 P1\/P2\/P3.*旧轮不改分/);assert.equal(h.root.querySelector('#impact-runs script'),null);
  assert.doesNotMatch(text, /代理模型 DeepSeek|不作为采纳依据|UNRELATED-OLD-TASK/); assert.equal(h.posts().length, 0);
});

test('human interpretation and non-adoption stay separate from the accepted gate and persist in the timeline', async t => {
  const h = setup(t);
  h.saved().comparisons = [{ id: 'comparison-reviewed', createdAt: '2026-11-03T12:00:00Z', completed: true, model: 'openai-codex/gpt-6.1-sol', evaluation: { splitPolicy: 'd15-frozen-v1' }, cases: [], modelCallsKnown: 100 }];
  const interpretation = '门槛判为接受（#19 原版 0/10，候选 6/10，p=0.0054；#16 两边都是 10/10）。\n测试组的复现题 #20 两边都是 0/10。候选把“开头先给结论”从 3/10 提到了 8/10，但两边 10 次全都用了 P1/P2/P3。\n只能说修好了 #19 这一类，不能说模式 1 整体变好了。\n本轮不采纳候选 bc807f8a，不进生产提示词。 <script>not-executed</script>';
  h.saved().comparisonReviews = [{ id: 'review-1', comparisonId: 'comparison-reviewed', decision: 'not-adopted', gateOutcome: 'accepted', reason: 'test_not_passed', interpretation, baselineChanged: false, createdAt: '2026-11-04T01:00:00Z' }];
  const before = clone(h.saved()); await h.panel.load(); await h.click('[data-tab="impact"]');
  const text = h.root.querySelector('#impact-runs').textContent;
  assert.ok(text.includes(interpretation)); assert.match(text, /未采纳.*基线未改变/);
  assert.match(h.root.querySelector('#impact-log').textContent, /门槛接受、测试未通过、未采纳/);
  assert.match(h.root.querySelector('#impact-log').textContent, /相同改动.*重复.*换.*写法/);
  assert.equal(h.root.querySelector('#impact-runs script'), null); assert.equal(h.posts().length, 0); assert.deepEqual(h.saved(), before);
});
test('candidate confirmation does not promise old fixed case numbers or authorize a model run; approved experience hash is visible', async t=>{
 const h=setup(t);h.saved().candidates[0].experienceHash='f'.repeat(64);await h.panel.load();await h.click('[data-tab="targets"]');const text=h.root.querySelector('#target-page').textContent;
 assert.doesNotMatch(text,/#1\/#2\/#6\/#16|#4\/#10\/#14/);assert.match(text,/何时执行.*用户批准/);assert.ok(text.includes('f'.repeat(64)));assert.equal(h.posts().length,0);
});
test('full candidate and accepted baseline text copy verbatim without applying or adopting; rejected text stays historical', async t => {
  const h = setup(t), copied = [];
  h.window.CaffShared.copyTextToClipboard = async text => { copied.push(text); };
  h.saved().baselines = [{ targetId: 'global-harness-behavior-v1', baseText: 'Shared harness prose.\n\nWikiSkill 已审核准则：\n- 已明确采纳的改法。', baseHash: '1'.repeat(64) }];
  h.saved().candidates[0].candidateText += '\n<script>not-html</script>';
  h.saved().comparisonReviews = [{ candidateHash: h.saved().candidates[0].candidateHash, targetId: 'global-harness-behavior-v1', decision: 'not-adopted' }];
  await h.panel.load(); await h.click('[data-tab="targets"]');
  assert.equal(h.root.querySelector('[data-final-text="candidate-global"]').textContent, h.saved().candidates[0].candidateText);
  assert.equal(h.root.querySelector('[data-final-text="candidate-global"] script'), null);
  const before = clone(h.saved()); await h.click('[data-copy-candidate="candidate-global"]');
  assert.equal(copied[0], h.saved().candidates[0].candidateText); assert.match(h.root.querySelector('#target-page').textContent, /未采纳.*历史|历史.*未采纳/);
  await h.click('[data-copy-baseline="global-harness-behavior-v1"]');
  assert.equal(copied[1], h.saved().baselines[0].baseText); assert.equal(h.posts().length, 0); assert.deepEqual(h.saved(), before);
  h.window.CaffShared.copyTextToClipboard = async () => { throw Error('denied'); };
  await h.click('[data-copy-candidate="candidate-global"]'); assert.match(h.root.querySelector('#toast').textContent, /复制失败/); assert.equal(h.posts().length, 0);
});
test('an explicit adopted review is labelled as evaluation baseline adoption, never a production write', async t => {
  const h = setup(t);
  h.saved().comparisons = [{ id: 'comparison-adopted', createdAt: '2026-11-04T01:00:00Z', completed: true, cases: [], modelCallsKnown: 20 }];
  h.saved().comparisonReviews = [{ comparisonId: 'comparison-adopted', candidateId: 'candidate-global', candidateHash: h.saved().candidates[0].candidateHash, targetId: 'global-harness-behavior-v1', decision: 'adopted', reason: 'user_accepted', baselineChanged: true, interpretation: '用户明确采纳。', createdAt: '2026-11-04T02:00:00Z' }];
  await h.panel.load(); await h.click('[data-tab="impact"]'); assert.match(h.root.querySelector('.comparison-review').textContent, /已采纳.*评测基线/);
  assert.match(h.root.querySelector('#impact-log').textContent, /用户明确采纳.*生产提示词仍须手动合入/);
  await h.click('[data-tab="targets"]'); const card = h.root.querySelector('.cand'); assert.match(card.textContent, /已采纳为评测基线/); assert.equal(card.querySelector('[data-confirm-candidate]'), null); assert.equal(h.posts().length, 0);
});
test('experience drafts require explicit review before the mode columns or candidate inputs; revisions do not edit frozen text', async t => {
 const h=setup(t,(url,options,saved)=>{if(url.endsWith('/experience')&&options.method==='POST'){const e=saved.experiences.find(e=>e.id===options.body.experienceId);assert.equal(options.body.decision,'approved');Object.assign(e,options.body.patch,{status:'approved',reviewedAt:'2026-11-04T03:00:00Z'});saved.revision++;return clone(saved);}return undefined;});
 h.saved().experiences=[{id:'experience-draft',rootId:'root-1',version:1,parentId:null,entryId:'entry-1',status:'draft',methods:'开头结论率提高；P编号规则可能误判 <script>no-html</script>',positiveExamples:'示意，非回放原文：结论是……。',createdAt:'2026-11-04T02:00:00Z'}];
 await h.panel.load();assert.match(h.root.querySelector('.experience-draft').textContent,/待审核/);assert.match(h.root.querySelector('[data-experience-methods]').textContent,/尚无已审核/);assert.equal(h.root.querySelector('.experience-draft script'),null);
 h.root.querySelector('[name="experience-methods"]').value='有效：先给结论；规则教训：避开题目主题。';await h.click('[data-review-experience="experience-draft"][data-decision="approved"]');assert.equal(h.posts().at(-1).url,'/api/wikiskill/experience');assert.equal(h.posts().at(-1).body.expectedRevision,3);
 assert.match(h.root.querySelector('[data-experience-methods]').textContent,/有效：先给结论/);assert.match(h.root.querySelector('[data-experience-examples]').textContent,/示意，非回放原文/);assert.equal(h.root.querySelector('[name="experience-methods"]'),null);assert.ok(h.root.querySelector('[data-revise-experience="experience-draft"]'));
 h.saved().candidates[0].experienceInputs=[{id:'experience-draft',version:1,methods:h.saved().experiences[0].methods,positiveExamples:h.saved().experiences[0].positiveExamples}];await h.panel.load();await h.click('[data-tab="targets"]');assert.match(h.root.querySelector('.cand').textContent,/已审核经验输入/);assert.match(h.root.querySelector('.cand').textContent,/规则教训/);
});
test('voided mark audit remains visible after removing the active case, without an undefined number or HTML execution', async t => {
  const h = setup(t);
  h.saved().events.push({ id: 'event-void', type: 'case-mark-voided', caseIds: ['removed-case'], createdAt: '2026-11-03T09:00:00Z', label: '误标作废', reason: '现场无对应测试；用户批准 <script>not-html</script>' });
  const before = clone(h.saved()); await h.panel.load(); await h.click('[data-tab="impact"]');
  const log = h.root.querySelector('#impact-log');
  assert.match(log.textContent, /误标作废/); assert.match(log.textContent, /现场无对应测试/);
  assert.match(log.textContent, /保留旧版本/); assert.doesNotMatch(log.textContent, /#undefined/);
  assert.equal(log.querySelector('script'), null); assert.deepEqual(h.saved(), before); assert.equal(h.posts().length, 0);
});
test('command progress refreshes read-only without resetting wiki edits or presenting original observations as adoption', async t => {
  let finished = false;
  const execution = () => ({ id: 'execution-1', status: finished ? 'completed' : 'running', updatedAt: new Date().toISOString(), plan: { model: 'openai-codex/gpt-6.1-sol', modelConfig: { thinking: 'xhigh' }, variants: ['original'], repeats: 2 }, current: finished ? null : { variant: 'original', iteration: 1 }, conclusion: finished ? 'original_observation_only' : null,
    summary: { plannedRuns: 2, completedRuns: finished ? 2 : 0, knownTokens: finished ? 14 : null, usageComplete: false, totals: { original: { planned: 2, passed: 1, failed: 1, errors: 0, notRun: finished ? 0 : 2 } } } });
  const h = setup(t, (url, options) => {
    if (url === '/api/wikiskill/executions') return { executions: [execution()] };
    if (options.method === 'POST') return Promise.reject(Error('unknown mutation result'));
  });
  h.saved().executions = [execution()]; await h.panel.load(); await h.click('[data-tab="impact"]');
  assert.match(h.root.querySelector('#execution-progress').textContent, /命令执行|执行进度/);
  assert.match(h.root.querySelector('#execution-progress').textContent, /xhigh/); assert.match(h.root.querySelector('#execution-progress').textContent, /0\/2/);
  assert.equal(h.root.querySelector('#execution-progress button'), null, 'no web launch controls');
  await h.click('[data-tab="wiki"]'); await h.click('[data-induct]');
  assert.equal(h.root.querySelector('[data-induct]').disabled, true);
  const posts = h.posts().length; finished = true; await h.panel.refreshExecutions();
  assert.equal(h.posts().length, posts); assert.equal(h.root.querySelector('[data-induct]').disabled, true, 'progress cannot re-enable writes after an unknown write result');
  await h.click('[data-tab="impact"]');
  const text = h.root.querySelector('#execution-progress').textContent;
  assert.match(text, /2\/2/); assert.match(text, /原版.*不产生采纳结论/); assert.match(text, /字面规则/); assert.doesNotMatch(text, /已采纳|接受候选/);
});

test('staged progress refreshes gate/test counts, replacements and saved results without mutating wiki edits', async t => {
  const totals = { original: { planned: 10, attempted: 11, passed: 4, failed: 6, errors: 1, notRun: 0 }, candidate: { planned: 10, attempted: 10, passed: 8, failed: 2, errors: 0, notRun: 0 } };
  const execution = { id: 'batch-execution-1', status: 'running', updatedAt: new Date().toISOString(), plan: { kind: 'wiki-staged-batch-comparison-v1', model: 'openai-codex/gpt-6.1-sol', modelConfig: { thinking: 'xhigh', transport: 'sse' }, variants: ['original', 'candidate'], cases: [] }, current: { sourceCaseId: 'c1', stage: 'gate', variant: 'original', iteration: 11 }, gateOutcome: null, summary: { plannedRuns: 60, completedRuns: 21, knownTokens: 14, usageComplete: false, totals, byStage: { gate: totals, test: totals } }, cases: [{ sourceCaseId: 'c1', stage: 'gate', reportOnly: false, totals }, { sourceCaseId: 'c3', stage: 'gate', reportOnly: true, totals }] };
  const h = setup(t, url => url === '/api/wikiskill/executions' ? { executions: [execution], comparisons: [{ id: 'finished-batch', createdAt: '2026-11-03T10:00:00Z', model: 'openai-codex/gpt-6.1-sol', modelConfig: { thinking: 'xhigh' }, completed: true, evaluation: { splitPolicy: 'd15-frozen-v1' }, cases: [], modelCallsKnown: 21 }] } : undefined);
  h.saved().versions[0].entries[0].status = 'draft'; await h.panel.load();
  const edit = h.root.querySelector('[name="guideline"]'); edit.value = '尚未保存的编辑';
  await h.panel.refreshExecutions(); assert.equal(h.root.querySelector('[name="guideline"]'), edit); assert.equal(edit.value, '尚未保存的编辑'); assert.equal(h.saved().revision, 3);
  await h.click('[data-tab="impact"]');
  const text = h.root.querySelector('#execution-progress').textContent;
  assert.match(text, /正式批量/); assert.match(text, /门槛/); assert.match(text, /测试/); assert.match(text, /环境.*替补|替补.*环境/); assert.match(text, /非GPT来源.*仅报告/);
  assert.match(h.root.querySelector('#impact-runs').textContent, /xhigh/); assert.doesNotMatch(text, /字面对照观察，不是正式/); assert.equal(h.posts().length, 0); assert.equal(h.root.querySelector('#execution-progress button'), null);
});

test('prototype structure defaults to knowledge base, keeps loop tab order and uses real room titles without examples', async t => {
  const h = setup(t); await h.panel.load();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/wikiskill'); assert.equal(h.posts().length, 0);
  assert.deepEqual([...h.root.querySelectorAll('[data-tab]')].map(b => b.dataset.tab), ['badcases', 'wiki', 'cases', 'targets', 'impact']);
  assert.equal(h.root.querySelector('[data-tab="wiki"]').getAttribute('aria-selected'), 'true');
  assert.equal(h.root.querySelector('#view-wiki').hidden, false); assert.equal(h.root.querySelector('#view-cases').hidden, true);
  assert.match(h.root.querySelector('#next-text').textContent, /确认全局提示词候选/);
  assert.match(h.root.querySelector('#wiki-list').textContent, /未经要求引入额外机制/);
  assert.match(h.root.querySelector('#wiki-page').textContent, /MVP 阶段又增加审批流程/);
  assert.match(h.root.querySelector('#wiki-page').textContent, /WikiSkill调优CAF/);
  assert.doesNotMatch(h.root.textContent, /示例|example-17|proposal-1/);
  assert.match(h.root.querySelector('#wiki-inbox').textContent, /待你处理/);
});

test('knowledge search covers pattern fields and case prose, highlights matches and names match locations; slash focuses search', async t => {
  const h = setup(t); await h.panel.load();
  const input = h.root.querySelector('#wiki-q'); input.value = '额外'; input.dispatchEvent(new h.window.Event('input'));
  assert.match(h.root.querySelector('#wiki-list').textContent, /匹配：.*标题/);
  assert.ok(h.root.querySelector('#wiki-list mark')); assert.ok(h.root.querySelector('#wiki-page mark'));
  input.value = 'README'; input.dispatchEvent(new h.window.Event('input'));
  assert.equal(h.root.querySelector('#wiki-casehits').hidden, false); assert.match(h.root.querySelector('#wiki-casehits').textContent, /用例原话里的匹配/);
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: '/', bubbles: true })); assert.equal(h.window.document.activeElement, input);
  h.root.querySelector('[data-q="术语"]').click(); assert.equal(input.value, '术语');
});

test('cases default to pattern groups and expose pending/suggested/unfit/holdout states and membership provenance', async t => {
  const h = setup(t); await h.panel.load(); await h.click('[data-tab="cases"]');
  const text = h.root.querySelector('#view-cases').textContent;
  for (const literal of ['按模式分组', '待归纳', '待归纳 · 有建议', '未能归类', '测试 · 不参与归纳', '重写CAFF的README', '同属额外流程', '模型建议']) assert.ok(text.includes(literal), literal);
  assert.ok(h.root.querySelector('#c-3 [data-induct]') || h.root.querySelector('[data-induct]'));
  assert.ok(h.root.querySelector('[data-confirm-suggestion="s-assign"]'));
  assert.equal(h.root.querySelector('#c-2 [data-confirm-suggestion]'), null);
  const details = h.root.querySelector('#c-1 .kv').textContent; assert.match(details, /模型归纳，随模式审核通过/);
  assert.match(h.root.querySelector('#c-4 .kv').textContent, /待确认/);
  assert.match(h.root.querySelector('#c-5').textContent, /孤立事实错误/);
  const manual = [...h.root.querySelectorAll('[data-manual-entry],[data-manual-assign],[data-manual-remove]')];
  assert.ok(manual.length > 0); assert.ok(manual.every(el => el.closest('details.more')), 'manual membership controls belong inside details');
  assert.equal(h.root.querySelector('.case > .manual-controls'), null);
});

test('D15 pending-preclassification and held-out classification appear in cases/inbox, never as wiki evidence', async t => {
  const h = setup(t, (_url, _options, saved) => {
    saved.cases[2].split = null; saved.caseStates[2].status = 'pending-preclassification';
    saved.cases[3].split = 'gate'; saved.cases[3].preclassification = { kind: 'assign', entryId: 'entry-1', reason: '症状相符<script>bad()</script>', runId: 'preclass-run' };
    saved.caseStates[3].status = 'classification-pending';
    saved.cases[4].split = 'test'; saved.cases[4].preclassification = { kind: 'assign', entryId: 'entry-1', reason: '同类', runId: 'preclass-run' };
    saved.caseStates[4].status = 'classification-confirmed'; saved.caseStates[4].memberships = [{ entryId: 'entry-1', source: 'manual', at: '2026-11-02T01:00:00Z' }];
    return undefined;
  });
  await h.panel.load();
  assert.match(h.root.querySelector('#wiki-inbox').textContent, /待预分类/);
  assert.match(h.root.querySelector('#wiki-inbox').textContent, /用例 #4.*待确认|用例 #4.*建议归入/);
  assert.doesNotMatch(h.root.querySelector('#wiki-page .evidence').textContent, /简单任务外又增加核对流程|把 room worktree/);
  assert.equal(h.root.querySelector('#wiki-page .suggest-row'), null);
  await h.click('[data-tab="cases"]');
  assert.match(h.root.querySelector('#c-3').textContent, /待预分类/); assert.equal(h.root.querySelector('#c-3 [data-manual-assign]'), null);
  assert.match(h.root.querySelector('#c-4').textContent, /预分类.*模式 1/); assert.match(h.root.querySelector('#c-4').textContent, /待确认/);
  assert.match(h.root.querySelector('#c-5').textContent, /已确认/); assert.ok(h.root.querySelector('#c-4 [data-manual-assign]'));
  assert.equal(h.root.querySelector('#c-4 script'), null);
  assert.ok([...h.root.querySelectorAll('#cases-split option')].some(o => o.textContent === '待预分类'));
});

test('pending -> model suggestion -> confirm/manual membership uses real APIs and persists returned provenance', async t => {
  const h = setup(t); await h.panel.load(); await h.click('[data-induct]');
  assert.equal(h.posts()[0].url, '/api/wikiskill/induct'); assert.deepEqual(clone(h.posts()[0].body), { confirmed: true, expectedRevision: 3 });
  assert.match(h.root.textContent, /建议已保存/);
  await h.click('[data-confirm-suggestion="s-new-assign"]');
  assert.deepEqual(clone(h.posts()[1].body), { confirmed: true, suggestionId: 's-new-assign', decision: 'accepted', expectedRevision: 4 });
  await h.click('[data-tab="cases"]'); assert.match(h.root.querySelector('#c-3 .kv').textContent, /模型建议经确认/);
  await h.click('#c-3 [data-manual-remove]');
  assert.deepEqual(clone(h.posts()[2].body), { confirmed: true, caseId: 'c3', entryId: null, expectedRevision: 5 });
  const select = h.root.querySelector('#c-3 [data-manual-entry]'); select.value = 'entry-1'; await h.click('#c-3 [data-manual-assign]');
  assert.deepEqual(clone(h.posts()[3].body), { confirmed: true, caseId: 'c3', entryId: 'entry-1', expectedRevision: 6 });
  assert.match(h.root.querySelector('#c-3 .kv').textContent, /手动/);
});

test('new pattern proposal remains a normal editable draft; review approval confirms membership without rewriting old approved prose', async t => {
  const h = setup(t, (_url, _options, saved) => {
    if (saved.versions[0].entries.some(e => e.id === 'entry-2')) return undefined;
    saved.versions[0].entries.push({ id: 'entry-2', title: '没验证就汇报', failureMode: '执行后未检查', symptoms: '服务报错仍说成功', rootCauseHypothesis: '把执行当结果', guideline: '汇报前亲自核验。', caseIds: ['c4'], status: 'draft', suggestionIds: ['s-new'] });
    saved.suggestions.push({ id: 's-new', runId: 'run-new', caseId: 'c4', kind: 'new', entryId: 'entry-2', reason: '现有模式不覆盖', confidence: '中', status: 'pending', createdAt: '2026-10-31T11:06:00Z' });
    return undefined;
  }); await h.panel.load();
  await h.click('[data-entry="entry-2"]'); assert.match(h.root.querySelector('#wiki-page').textContent, /新模式提议/);
  const textarea = h.root.querySelector('[name="guideline"]'); assert.equal(textarea.disabled, false); textarea.value = '汇报完成前亲自验证结果。';
  h.accept(false); await h.click('[data-review="approved"]'); assert.equal(h.posts().length, 0);
  h.accept(true); await h.click('[data-review="approved"]');
  const post = h.posts()[0]; assert.equal(post.url, '/api/wikiskill/review'); assert.equal(post.body.entryId, 'entry-2'); assert.equal(post.body.decision, 'approved'); assert.equal(post.body.patch.caseIds, undefined);
  assert.equal(h.saved().versions[0].entries[0].guideline, approvedEntry.guideline);
  assert.equal(h.saved().caseStates.find(s => s.caseId === 'c4').memberships[0].source, 'model-confirmed');
  assert.equal(h.root.querySelector('[name="guideline"]'), null);
});

test('target page preserves readable candidate comparison, generation and hash-bound confirmation without unified diff', async t => {
  const h = setup(t); await h.panel.load(); await h.click('[data-tab="targets"]');
  const page = h.root.querySelector('#target-page'), text = page.textContent;
  for (const literal of ['全局系统提示词', 'Shared harness prose.', '新增 1 条准则', '先完成用户明确要求。', '来自模式 1', '确认此候选', '每题原版本和候选各跑 10 次', '先跑门槛', '接受才跑测试']) assert.ok(text.includes(literal), literal);
  for (const marker of ['--- a/x', '+++ b/x', '@@', 'No newline']) assert.equal(text.includes(marker), false);
  assert.equal(page.querySelector('.orig').open, false);
  h.accept(false); await h.click('[data-confirm-candidate="candidate-global"]'); assert.equal(h.posts().length, 0);
  h.accept(true); await h.click('[data-confirm-candidate="candidate-global"]');
  assert.deepEqual(clone(h.posts()[0].body), { confirmed: true, candidateId: 'candidate-global', candidateHash: 'd'.repeat(64), expectedRevision: 3 });
  assert.equal(h.posts()[0].url, '/api/wikiskill/confirm-global-candidate');
  await h.click('[data-target="tool-description-send-public"]'); await h.click('[data-show-generator]');
  const checkbox = h.root.querySelector('[data-candidate-entry="entry-1"]'); checkbox.click(); await h.click('[data-generate-candidate]');
  assert.equal(h.posts()[1].url, '/api/wikiskill/candidate'); assert.deepEqual(clone(h.posts()[1].body.entryIds), ['entry-1']);
  assert.match(h.root.querySelector('#target-page').textContent, /工具 send-public（公开发言） 的说明/);
  await h.click('[data-target="tool-description-list_rooms"]');
  const deprecated = h.root.querySelector('[data-confirm-candidate="candidate-old"]'); assert.ok(deprecated.disabled); assert.match(h.root.querySelector('#target-page').textContent, /目标选错了/);
});

test('candidate generator permits one pattern only and explains combined-candidate deprecation', async t => {
  const h = setup(t, (_url, _options, saved) => {
    if (!saved.versions[0].entries.some(e => e.id === 'entry-2')) saved.versions[0].entries.push({ ...clone(approvedEntry), id: 'entry-2', title: '第二模式' });
    if (!saved.candidates.some(c => c.id === 'candidate-combined')) saved.candidates.push({ ...clone(saved.candidates[0]), id: 'candidate-combined', entryIds: ['entry-1', 'entry-2'], status: 'deprecated', deprecationReason: 'multiple_patterns' });
    return undefined;
  });
  await h.panel.load(); await h.click('[data-tab="targets"]');
  assert.match(h.root.querySelector('.is-dep .dep-note').textContent, /多.*模式|合并.*准则/);
  assert.equal(h.root.querySelector('[data-confirm-candidate="candidate-combined"]').disabled, true);
  const first = h.root.querySelector('[data-candidate-entry="entry-1"]'), second = h.root.querySelector('[data-candidate-entry="entry-2"]');
  assert.equal(first.type, 'radio'); first.click(); second.click();
  assert.equal(h.root.querySelectorAll('[data-candidate-entry]:checked').length, 1);
  await h.click('[data-generate-candidate]');
  assert.deepEqual(clone(h.posts()[0].body.entryIds), ['entry-2']);
});

test('impact shows per-replay comparison and evolution events without inventing results or run controls', async t => {
  const totals = { original: { passed: 1, planned: 3, failed: 1, errors: 1, notRun: 0, scored: 2, passRate: .5 }, candidate: { passed: 2, planned: 3, failed: 0, errors: 0, notRun: 1, scored: 2, passRate: 1 } };
  const h = setup(t, (_url, _options, saved) => { saved.comparisons = [{ id: 'comparison-1', createdAt: '2026-10-31T12:00:00Z', candidate: { id: 'candidate-global', targetId: 'global-harness-behavior-v1' }, model: 'deepseek/deepseek-v4-flash', modelCallsKnown: 4, completed: false,
    totals, bySplit: { train: totals, test: totals }, byCategory: { reproduction: totals, probe: totals, control: totals }, disclosures: [],
    cases: [{ sourceCaseId: 'c1', split: 'train', category: 'reproduction', status: 'error', reason: 'run_error', totals, runs: [] }] }]; return undefined; });
  await h.panel.load(); await h.click('[data-tab="impact"]');
  const text = h.root.querySelector('#impact-runs').textContent;
  for (const literal of ['1/3', '2/3', '错误 1', '未运行 1', '复现题', '防误伤题', '挑题偏差', '只复现了汇报难懂一类']) assert.ok(text.includes(literal), literal);
  const log = h.root.querySelector('#impact-log').textContent;
  for (const literal of ['归纳', '候选', '审核', '回放题']) assert.ok(log.includes(literal), literal);
  assert.equal(h.root.querySelector('#impact-runs button[data-run], #impact-runs button[data-retry]'), null);
});

test('empty impact explains the next action and keeps all seven planned slots distinct from errors/not-run', async t => {
  const h = setup(t); await h.panel.load(); await h.click('[data-tab="impact"]');
  assert.match(h.root.querySelector('#impact-runs').textContent, /还没有评测结果/);
  assert.match(h.root.querySelector('#impact-runs').textContent, /确认全局提示词候选/);
  assert.match(h.root.querySelector('#impact-runs').textContent, /—\/10/); // each unexecuted question has ten planned runs per version
  assert.equal(h.root.querySelectorAll('[data-evaluation-stage]').length, 2);
  assert.doesNotMatch(h.root.querySelector('#impact-runs').textContent, /合计|各跑 3 次/);
  assert.match(h.root.querySelector('#impact-log').textContent, /等待/);
});

test('D14/D15 display Goal numbers and train/gate/test without changing stored source data or exposing internal IDs in reasons',async t=>{
  const h=setup(t,(_url,_options,saved)=>{
    saved.cases[0].displayNumber=1;saved.cases[0].evaluationStage='gate';saved.cases[1].displayNumber=4;saved.cases[3].displayNumber=17;saved.cases[4].displayNumber=18;
    saved.cases[2].split='gate';saved.caseStates.find(s=>s.caseId==='c3').status='holdout';
    saved.suggestions[0].reason='同属 entry-1，未知 entry-999。<img src=x onerror=evil()>';
    return undefined;
  });await h.panel.load();
  assert.doesNotMatch(h.root.querySelector('#wiki-page .suggest-row').textContent,/entry-1|entry-999/);
  assert.equal(h.root.querySelector('#wiki-page img'),null);await h.click('[data-tab="cases"]');
  assert.match(h.root.querySelector('#c-4').textContent,/验收步骤术语太多/);assert.match(h.root.querySelector('#c-1 .chips').textContent,/训练.*本轮门槛/);
  assert.match(h.root.querySelector('#c-3').textContent,/门槛.*不参与归纳/);assert.equal(h.root.querySelector('#c-3 [data-manual-assign]'),null);
  assert.deepEqual([...h.root.querySelectorAll('#cases-split option')].map(o=>o.textContent),['全部','训练','门槛','测试','待预分类']);
  const split=h.root.querySelector('#cases-split');split.value='gate';split.dispatchEvent(new h.window.Event('change',{bubbles:true}));
  assert.ok(h.root.querySelector('#c-3'));assert.ok(h.root.querySelector('#c-1'));assert.equal(h.root.querySelector('#c-4'),null);
  assert.doesNotMatch(h.root.querySelector('#view-cases').textContent,/entry-1|entry-999/);assert.equal(h.posts().length,0);
  assert.equal(h.saved().cases[0].split,'train');
});
test('D16 impact separates gate/test rates, shows mechanical inputs and a durable rejection event with tests unexecuted',async t=>{
  const totals={original:{passed:0,planned:10,failed:10,errors:1,notRun:0,scored:10,passRate:0},candidate:{passed:4,planned:10,failed:6,errors:0,notRun:0,scored:10,passRate:.4}};
  const zero={original:{passed:0,planned:10,failed:0,errors:0,notRun:10,scored:0,passRate:null},candidate:{passed:0,planned:10,failed:0,errors:0,notRun:10,scored:0,passRate:null}};
  const result={id:'staged',createdAt:'2026-11-01T10:00:00Z',kind:'wiki-staged-batch-comparison-v1',evaluation:{kind:'wikiskill-gate-v1'},model:'deepseek/deepseek-v4-flash',modelCallsKnown:21,completed:true,
    gateDecision:{outcome:'rejected',repair:{original:{passed:0,total:20},candidate:{passed:4,total:20},pValue:.053,passed:false},noHarm:{original:{passed:10,total:10},candidate:{passed:10,total:10},loss:0,allowedLoss:1,passed:true}},byStage:{gate:totals,test:zero},
    cases:[{sourceCaseId:'c1',stage:'gate',status:'completed',totals},{sourceCaseId:'c2',stage:'test',status:'not-run',reason:'gate_rejected',totals:zero}]};
  const h=setup(t,(_url,_options,saved)=>{saved.comparisons=[result,{...result,id:'old',createdAt:'2026-10-31T01:00:00Z',gateDecision:{...result.gateDecision,outcome:'accepted'}}];return undefined;});
  await h.panel.load();await h.click('[data-tab="impact"]');const text=h.root.querySelector('#impact-runs').textContent;
  for(const literal of ['门槛判定：拒绝','Fisher','0/20','4/20','0.053','允许少通过 1','门槛','测试','40.0%','N/A','错误 1','未运行 10','代理模型','小样本','挑题偏差','不作为采纳依据'])assert.ok(text.includes(literal),literal);
  assert.doesNotMatch(text,/合计|总体/);assert.equal(h.root.querySelectorAll('[data-evaluation-stage]').length,2);
  assert.match(h.root.querySelector('#impact-log').textContent,/门槛判定.*拒绝/);assert.match(h.root.querySelector('[data-evaluation-stage="test"]').textContent,/门槛拒绝.*未运行/);
  const chip=h.root.querySelector('.runs [data-entry="entry-1"]');assert.equal(chip.textContent,'模式 1');assert.match(chip.title,/未经要求引入额外机制/);
  const rows=[...h.root.querySelectorAll('#impact-log li')],policies=rows.filter(li=>li.querySelector('.kind')?.textContent==='规则');
  assert.equal(policies.length,2);
  const current=policies.find(li=>li.textContent.includes('现行规则')),superseded=policies.find(li=>li.textContent.includes('旧规则'));
  assert.ok(current);assert.match(current.querySelector('time').textContent,/11-02/);assert.match(current.textContent,/先待预分类.*按模式配额.*训练50%.*门槛25%.*测试25%.*组别冻结/);assert.doesNotMatch(current.textContent,/hash/);
  assert.ok(superseded);assert.match(superseded.querySelector('time').textContent,/11-01/);assert.match(superseded.textContent,/旧规则.*2026-11-02.*已被取代.*固定 hash/);
  const imported=rows.find(li=>li.querySelector('.kind')?.textContent==='用例');assert.doesNotMatch(imported.textContent,/固定 hash|50%|25%/);
  assert.equal(h.posts().length,0);
});
test('separate executions retain interrupted observations without pooling them into the complete rerun', async t => {
  const totals = n => ({ original: { passed: 0, planned: 10, failed: 10, errors: 0, notRun: 0, scored: 10, passRate: 0 }, candidate: { passed: n, planned: 10, failed: 10-n, errors: 0, notRun: 0, scored: 10, passRate: n/10 } });
  const gateDecision = { outcome: 'accepted', repair: { original: { passed: 0, total: 20 }, candidate: { passed: 5, total: 20 }, pValue: .023562, passed: true }, noHarm: { original: { passed: 10, total: 10 }, candidate: { passed: 10, total: 10 }, loss: 0, allowedLoss: 1, passed: true } };
  const complete = { id: 'rerun', executionId: 'new-execution', createdAt: '2026-11-01T15:31:00Z', model: 'deepseek/deepseek-v4-flash', modelCallsKnown: 1317, evaluation: {}, completed: true, gateDecision,
    byStage: { gate: totals(5), test: totals(1) }, cases: [{ sourceCaseId: 'c1', stage: 'gate', totals: totals(5) }, { sourceCaseId: 'c2', stage: 'test', totals: totals(1) }] };
  const interrupted = { ...clone(complete), id: 'interrupted', executionId: 'old-execution', createdAt: '2026-11-01T14:13:00Z', completed: false,
    gateDecision: { ...clone(gateDecision), outcome: 'indeterminate' }, byStage: { gate: totals(0), test: totals(0) }, cases: [{ sourceCaseId: 'c1', stage: 'gate', reason: 'operator_interrupted', totals: totals(0), runs: [] }] };
  const h = setup(t, (_url, _options, saved) => { saved.comparisons = [interrupted, complete]; return undefined; });
  await h.panel.load(); await h.click('[data-tab="impact"]');
  assert.equal(h.root.querySelectorAll('.comparison-history [data-comparison]').length, 2);
  assert.equal(h.root.querySelector('[data-comparison="rerun"]').getAttribute('aria-pressed'), 'true');
  assert.match(h.root.querySelector('[data-comparison="interrupted"]').textContent, /执行 1.*中断，不计入判定/);
  assert.match(h.root.querySelector('[data-comparison="rerun"]').textContent, /执行 2.*完整/);
  assert.match(h.root.querySelector('[data-evaluation-stage="gate"] tbody').textContent, /5\/10/);
  assert.match(h.root.querySelector('#impact-runs').textContent, /仅使用本次执行.*不拼接/);
  await h.click('[data-comparison="interrupted"]');
  assert.match(h.root.querySelector('.gate-decision h3').textContent, /中断观察/);
  assert.doesNotMatch(h.root.querySelector('[data-evaluation-stage="gate"] tbody').textContent, /5\/10/);
  assert.match(h.root.querySelector('#impact-log').textContent, /执行 1.*中断，不计入判定/);
  await h.click('[data-comparison="rerun"]');
  assert.match(h.root.querySelector('.gate-decision h3').textContent, /门槛判定：接受/);
  assert.match(h.root.querySelector('[data-evaluation-stage="gate"] tbody').textContent, /5\/10/);
  assert.equal(h.calls.length, 1); assert.equal(h.posts().length, 0);
});

test('user prose and search highlighting stay text-only; failed writes disable mutation until refresh', async t => {
  const h = setup(t, (url, options) => { if (options.method === 'POST') throw Error('private-path'); return undefined; });
  await h.panel.load(); assert.equal(h.root.querySelector('img,script'), null);
  await h.click('[data-induct]'); assert.match(h.root.querySelector('#toast').textContent, /失败|未知/);
  assert.equal(h.root.querySelector('[data-induct]').disabled, true); assert.doesNotMatch(h.root.textContent, /private-path/);
  await h.panel.load(); assert.equal(h.root.querySelector('[data-induct]').disabled, false);
});

test('standalone navigation, projects capture-only boundary and responsive prototype CSS remain in force', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../../public/' + file), 'utf8');
  for (const page of ['index', 'personas', 'skills', 'projects', 'metrics', 'wikiskill']) assert.match(read(page + '.html'), /href="\/wikiskill.html"/);
  assert.doesNotMatch(read('projects.html') + read('projects.js'), /badcase-wiki|badcase-evaluation|wikiPanel|evaluationPanel/);
  assert.match(read('wikiskill.html'), /aria-current="page" href="\/wikiskill.html"/);
  assert.match(read('wikiskill.js'), /panel.load\(\)/); assert.doesNotMatch(read('wikiskill.js'), /projectId|api\/projects/);
  const css = read('wikiskill.css'); assert.match(css, /@media\s*\(max-width:\s*860px\)/); assert.match(css, /@media\s*\(max-width:\s*640px\)/);
  assert.match(css, /\.split\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.toolbar \.check\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.toolbar \.field\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.search input:focus-visible\s*\{[^}]*outline:\s*none/s);
});
