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

test('prototype structure defaults to knowledge base, keeps loop tab order and uses real room titles without examples', async t => {
  const h = setup(t); await h.panel.load();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/wikiskill'); assert.equal(h.posts().length, 0);
  assert.deepEqual([...h.root.querySelectorAll('[data-tab]')].map(b => b.dataset.tab), ['cases', 'wiki', 'targets', 'impact']);
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
  assert.deepEqual([...h.root.querySelectorAll('#cases-split option')].map(o=>o.textContent),['全部','训练','门槛','测试']);
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
  const rows=[...h.root.querySelectorAll('#impact-log li')],policy=rows.find(li=>li.querySelector('.kind')?.textContent==='规则');
  assert.ok(policy);assert.match(policy.querySelector('time').textContent,/11-01/);assert.match(policy.textContent,/训练50%.*门槛25%.*测试25%/);
  const imported=rows.find(li=>li.querySelector('.kind')?.textContent==='用例');assert.doesNotMatch(imported.textContent,/固定 hash|50%|25%/);
  assert.equal(h.posts().length,0);
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
