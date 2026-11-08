const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(r => setImmediate(r));
function setup(t, fetcher, options = {}) {
  const dom = new JSDOM('<section id="pipeline"></section>', { runScripts: 'outside-only', url: 'http://127.0.0.1/wikiskill.html' });
  t.after(() => dom.window.close()); dom.window.HTMLElement.prototype.scrollIntoView = function() {};
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-pipeline.js'), 'utf8'));
  const root = dom.window.document.querySelector('#pipeline'), calls = [];
  const packet = { schemaVersion: 1, kind: 'wikiskill-trace-bundle', complete: false, origin: 'backfill', frozenAt: '2026-11-05T00:00:00Z', source: { conversationId: 'room', messageId: 'msg' },
    markedStep: 1, markedMessage: 'actual full reply', missingReasons: ['original_context_unavailable'], context: { trigger: { message: { content: 'original request' } }, systemPrompt: null, loadedSkillPaths: ['test/SKILL.md'] },
    steps: [{ step: 1, entryId: 'a1', output: { content: [{ type: 'text', text: '<script>unsafe</script> full model text' }] }, toolResults: [{ message: { content: [{ type: 'text', text: 'long-result-' + 'x'.repeat(3000) + ' final-needle' }] } }], durationMs: null }], metrics: {}, scene: null };
  const data = { cases: [
    { id: 'c1', n: 1, kind: 'text-only', split: 'train', actual: 'wrong behavior', expected: 'right', message: 'DO NOT USE EXCERPT', source: { agentId: 'role-family-gpt', conversationTitle: 'Source room' }, traceBundle: { hash: 'a'.repeat(64), origin: 'backfill', complete: false, missingReasons: packet.missingReasons, stepCount: 1 } },
    { id: 'c2', n: 19, kind: 'marked-badcase', split: 'gate', actual: 'scene issue', expected: 'fix', source: { agentId: 'role-family-gpt', conversationTitle: 'Scene room' }, sealedCheckpointId: 'cp', traceBundle: { hash: 'b'.repeat(64), origin: 'backfill', complete: false, missingReasons: ['sealed_marked_turn_not_recorded'], stepCount: 0 } },
    { id: 'c3', n: 4, kind: 'text-only', split: 'test', actual: 'old source', source: { agentId: 'role-family-gpt' } },
    { id: 'c4', n: 17, kind: 'marked-badcase', split: 'train', actual: 'other model', source: { agentId: 'role-family-deepseek' } },
  ], caseStates: [], replayCases: [] };
  const panel = dom.window.CaffShared.createBadcasePipeline({ root, fetchJson: async url => { calls.push(url); return fetcher ? fetcher(url, packet) : { traceBundle: JSON.parse(JSON.stringify(packet)) }; }, ...options });
  panel.render(data);
  async function expand() { const d = root.querySelector('[data-trace-case="c1"]'); d.open = true; d.dispatchEvent(new dom.window.Event('toggle')); await tick(); await tick(); }
  return { root, data, packet, calls, panel, window: dom.window, expand };
}
test('steps 6–9 and funnels use the actual pipeline projection; frozen assertions stay read-only with a case-editor link', t => {
  const h = setup(t), row = (caseId, level) => ({ caseId, level, stopReason: null, assertion: { status: 'frozen', version: 3, model: 'deepseek/deepseek-v4-flash', questions: [{ id: 'q1', question: '<script>plain conclusion</script>', evidence: 'reply' }] }, replay: { status: 'supported', cutStep: 1 }, original: { valid: 10, pass: 0, fail: 10, unscored: 0, invalid: 2, errors: 1, reproduced: true, comparisonId: 'comparison-real' }, inLibrary: true });
  h.data.pipelineStates = [row('c1', 'run'), row('c2', 'trace')];
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), decision: { level: 'run', kind: 'single', cutStep: 1 }, recommendation: {}, request: { state: { steps: [] } } }];
  h.panel.render(h.data);
  const card = h.root.querySelector('[data-case-id="c1"]');
  assert.deepEqual([...card.querySelector('.stepper').children].slice(5).map(li => li.className), ['done', 'done', 'done', 'done']);
  assert.match(card.textContent, /已冻结 v3.*deepseek\/deepseek-v4-flash/); assert.match(card.textContent, /原版.*0.*10.*已复现/s);
  assert.equal(card.querySelector('[data-assertion-slot] script'), null); assert.match(card.querySelector('[data-assertion-slot]').textContent, /<script>plain conclusion<\/script>/);
  assert.equal(card.querySelector('[data-assertion-slot] a').getAttribute('href'), '#case-1');
  assert.equal(card.querySelector('[data-draft-rubric],[data-freeze-rubric],[data-start-replay]'), null);
  assert.deepEqual([...h.root.querySelectorAll('[data-lane="trace"] .f-step b')].map(el => +el.textContent), [1, 1, 1, 1, 1]);
  assert.deepEqual([...h.root.querySelectorAll('[data-lane="run"] .f-step b')].map(el => +el.textContent), [1, 1, 1, 1, 1]);
  assert.doesNotMatch(h.root.textContent, /评分 v2 待接入|评分 v2 接入后|尚未接入判分|等待评分 v2/); assert.equal(h.calls.length, 0);
});
test('missing assertions, incompatible run evidence, pending reproduction and unscored raw replies are distinct, never fake library readiness', t => {
  const h = setup(t); const row = { caseId: 'c1', level: 'run', stopReason: null, assertion: { status: 'missing', version: null, questions: [] }, replay: { status: 'pending' }, original: { valid: 0, unscored: 1, invalid: 0, errors: 0, reproduced: false }, inLibrary: false };
  h.data.pipelineStates = [row]; h.panel.render(h.data); let card = h.root.querySelector('[data-case-id="c1"]');
  assert.match(card.textContent, /没有冻结.*断言/); assert.match(card.textContent, /待判分.*有效.*1/); assert.doesNotMatch(card.textContent, /待复现/);
  assert.equal(card.querySelector('.stepper').children[8].className, 'pending');
  row.assertion = { status: 'incompatible', version: 1, model: 'deepseek/deepseek-v4-flash', questions: [{ id: 'q1', question: 'continued', evidence: 'trace' }] };
  h.panel.render(h.data); card = h.root.querySelector('[data-case-id="c1"]');
  assert.equal(card.querySelector('.stepper').children[5].className, 'warn'); assert.match(card.textContent, /run 级.*只能.*回复.*另存.*版/s);
  assert.equal(card.querySelector('.stepper').children[8].className, 'pending'); assert.equal(h.calls.length, 0);
});
test('minority/tied failures show counts and the unmet majority condition, never claim all originals passed', t => {
  const h = setup(t), row = { caseId: 'c2', level: 'trace', assertion: { status: 'frozen', version: 1, questions: [] }, replay: { status: 'supported' }, original: { valid: 10, pass: 9, fail: 1, unscored: 0, invalid: 2, errors: 1, reproduced: false }, inLibrary: false };
  h.data.pipelineStates = [row];
  for (const [pass, fail] of [[9, 1], [5, 5]]) {
    Object.assign(row.original, { pass, fail }); h.panel.render(h.data); h.panel.focus(19);
    const card = h.root.querySelector('[data-case-id="c2"]');
    assert.ok(card.textContent.includes(`原版 ${pass}/10 通过 · ${fail} 不通过`));
    assert.match(card.textContent, /不通过未超过有效次数的一半/); assert.doesNotMatch(card.textContent, /原版均通过|已复现问题/);
    assert.notEqual(card.querySelector('.stepper').children[7].className, 'done');
    assert.equal(card.querySelector('.stepper').children[8].className, 'pending');
  }
  assert.equal(h.calls.length, 0);
});
test('unscored run output says awaiting scoring only; freezing or loading never promises or starts automatic scoring', t => {
  const h = setup(t);
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), decision: { hash: 'd'.repeat(64), kind: 'single', level: 'run', cutStep: 1 }, recommendation: {}, request: { state: { steps: [] } } }];
  h.data.runReplays = [{ id: 'run-raw', caseId: 'c1', traceHash: 'a'.repeat(64), decisionHash: 'd'.repeat(64), status: 'reached', variant: { kind: 'original' } }];
  const row = { caseId: 'c1', level: 'run', assertion: { status: 'frozen', version: 4, questions: [{ id: 'q1', question: 'The reply is plain.', evidence: 'reply' }] }, replay: { status: 'supported', cutStep: 1 }, original: { valid: 0, outputs: 1, unscored: 1, invalid: 0, errors: 0, reproduced: false }, inLibrary: false };
  h.data.pipelineStates = [row]; h.panel.render(h.data);
  const card = h.root.querySelector('[data-case-id="c1"]');
  assert.match(card.querySelector('.next-line').textContent, /待判分/); assert.doesNotMatch(card.textContent, /待复现|已复现问题/);
  assert.match(card.querySelector('[data-run-details] summary').textContent, /待判分/);
  assert.notEqual(card.querySelector('.stepper').children[7].className, 'done');
  assert.equal(card.querySelector('.stepper').children[8].className, 'pending');
  assert.doesNotMatch(h.root.textContent, /冻结后系统会.*判分|冻结后.*自动判分|系统会自动.*评分/);
  assert.equal(card.querySelector('[data-draft-rubric],[data-freeze-rubric],[data-start-replay]'), null); assert.equal(h.calls.length, 0);
  row.original.outputs = row.original.unscored = 0; h.data.runReplays = []; h.panel.render(h.data);
  assert.match(h.root.querySelector('.next-line').textContent, /待复现|受信操作方/);
});
test('three-way labels use named inline consent and locked evaluation roles, never browser dialogs', t => {
  const sent = [], h = setup(t, null, { onConfirmPatternLabel: body => sent.push(body), confirm: () => { throw Error('no browser dialog'); } });
  h.data.casePatterns = ['c1', 'c3'].map(caseId => ({ caseId, confirmed: false, entryId: null, patternKey: null, labelHash: 'c'.repeat(64), options: [{ entryId: 'entry-1', title: '<script>pattern</script>' }], pendingOptions: [] }));
  h.panel.render(h.data); h.panel.focus(4);
  const host = () => h.root.querySelector('[data-bc-detail] [data-pattern-label="c3"]');
  assert.match(host().textContent, /决定这条用例在哪个模式下分组.*评测.*目标用例.*确认后不能改/);
  assert.equal(host().querySelector('details').open, false);
  const choose = kind => { const radio = host().querySelector(`[data-pattern-kind][value="${kind}"]`); radio.checked = true; radio.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
  choose('entry'); host().querySelector('[data-pattern-entry]').value = 'entry-1'; host().querySelector('[data-pattern-confirm]').click();
  assert.equal(sent.length, 0); assert.equal(host().querySelector('script'), null); assert.match(host().querySelector('[data-label-consent]').textContent, /<script>pattern<\/script>.*配额.*目标复现题/s);
  host().querySelector('[data-pattern-lock]').click(); assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { caseId: 'c3', entryId: 'entry-1', labelHash: 'c'.repeat(64) });
  choose('none'); host().querySelector('[data-pattern-confirm]').click(); assert.match(host().textContent, /共用一组.*不算任何模式的目标用例/);
  h.panel.setWritable(false); assert.equal(host().querySelector('[data-pattern-lock]').disabled, true); host().querySelector('[data-pattern-lock]').click(); assert.equal(sent.length, 1);
  h.data.casePatterns[1] = { ...h.data.casePatterns[1], confirmed: true, entryId: 'entry-1', patternKey: 'entry-1' }; h.panel.render(h.data); h.panel.focus(4);
  assert.match(host().textContent, /已锁定.*<script>pattern<\/script>.*测试组.*目标复现题/s); assert.equal(host().querySelector('[data-pattern-confirm]'), null);
});
test('new-mode suggestions default to pending create/join, validate names and bind refreshed label hashes', t => {
  const sent = [], h = setup(t, null, { onConfirmPatternLabel: body => sent.push(body) });
  h.data.cases[1].split = null; h.data.cases[1].preclassification = { kind: 'new', confidence: '高', reason: '<b>check constraints</b>' };
  h.data.casePatterns = [{ caseId: 'c2', confirmed: false, labelHash: 'c'.repeat(64), options: [{ entryId: 'entry-1', title: 'Approved' }], pendingOptions: [] }];
  h.panel.render(h.data); h.panel.focus(19); const host = () => h.root.querySelector('[data-bc-detail] [data-pattern-label="c2"]');
  assert.equal(host().querySelector('[data-pattern-kind]:checked').value, 'pending'); assert.equal(host().querySelector('[data-pattern-pending-mode]:checked').value, 'create');
  assert.match(host().textContent, /预分类建议：新模式.*把握：高.*<b>check constraints<\/b>/s); assert.equal(host().querySelector('b b'), null);
  for (const name of ['', '字'.repeat(41), 'Approved']) { host().querySelector('[data-pattern-name]').value = name; host().querySelector('[data-pattern-confirm]').click(); assert.ok(host().querySelector('[data-label-error]')); assert.equal(host().querySelector('[data-pattern-lock]'), null); }
  host().querySelector('[data-pattern-name]').value = '先检查约束'; host().querySelector('[data-pattern-confirm]').click();
  assert.match(host().querySelector('[data-label-consent]').textContent, /先检查约束.*自己的组.*关联之后/s); assert.equal(sent.length, 0);
  host().querySelector('[data-pattern-lock]').click(); assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { caseId: 'c2', pendingPattern: { name: '先检查约束' }, labelHash: 'c'.repeat(64) });
  h.data.casePatterns[0].labelHash = 'd'.repeat(64); h.data.casePatterns[0].pendingOptions = [{ id: 'pending-1', name: '先检查约束', entryId: null }];
  h.panel.render(h.data); assert.equal(host().querySelector('[data-label-consent]'), null); assert.equal(host().querySelector('[data-pattern-pending-mode]:checked').value, 'join');
  host().querySelector('[data-pattern-confirm]').click(); host().querySelector('[data-pattern-lock]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1])), { caseId: 'c2', pendingPattern: { id: 'pending-1' }, labelHash: 'd'.repeat(64) });
  h.data.cases[1].preclassification = { kind: 'assign', entryId: 'entry-1', confidence: '中', reason: 'Matches' }; h.panel.render(h.data);
  assert.equal(host().querySelector('[data-pattern-kind]:checked').value, 'entry'); assert.equal(host().querySelector('[data-pattern-entry]').value, 'entry-1');
});

test('pending boards warn without blocking and offer immutable inline linking plus resolved target lists', t => {
  const sent = [], h = setup(t, null, { onConfirmInitialSplit: () => {}, onLinkPendingPattern: body => sent.push(body), confirm: () => { throw Error('no dialog'); } });
  const option = { id: 'pending-1', name: '<script>Named pending</script>', entryId: null };
  h.data.cases[0].split = h.data.cases[1].split = null; h.data.cases[1].preclassification = { kind: 'new', confidence: 'high', reason: 'New' };
  h.data.pendingPatterns = [{ id: option.id, name: option.name }]; h.data.pendingPatternLinks = [];
  h.data.casePatterns = [{ caseId: 'c1', confirmed: true, pendingPatternId: option.id, pendingPatternName: option.name, entryId: null, patternKey: option.id, options: [], pendingOptions: [option] }, { caseId: 'c2', confirmed: false, options: [], pendingOptions: [option] }];
  const row = { caseId: 'c1', patternKey: option.id, level: 'trace', proposedSplit: 'train' };
  h.data.initialSplitProposal = { hash: 'a'.repeat(64), rows: [row], patterns: [{ patternKey: option.id, rows: [row] }] };
  h.panel.render(h.data); h.root.querySelector('[data-bc-pattern="pending-1"]').click();
  assert.match(h.root.querySelector('.pat-seg').textContent, /Named pending.*待归纳/s); assert.ok(h.root.querySelector('[data-pending-label-hint]')); assert.equal(h.root.querySelector('[data-initial-split-confirm]').disabled, false);
  assert.equal(h.root.querySelector('[data-grouping] script'), null);
  h.data.cases[0].kind = 'marked-badcase'; h.data.cases[0].split = 'gate'; h.data.cases[1].split = 'test';
  h.data.casePatterns[1] = { ...h.data.casePatterns[0], caseId: 'c2' }; h.data.initialSplitProposal = { rows: [], patterns: [] }; h.panel.render(h.data);
  assert.match(h.root.querySelector('[data-pending-next]').textContent, /知识库.*训练.*归纳.*审核/s); assert.equal(h.root.querySelector('[data-pending-link]'), null);
  h.data.versions = [{ entries: [{ id: 'entry-1', title: 'Approved constraints', status: 'approved', caseIds: [] }] }]; h.panel.render(h.data);
  const select = h.root.querySelector('[data-pending-link-entry]'); select.value = 'entry-1'; select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  h.root.querySelector('[data-pending-link]').click(); assert.equal(sent.length, 0);
  assert.match(h.root.querySelector('[data-link-consent]').textContent, /Named pending.*Approved constraints.*目标复现题.*组别不变/s);
  h.panel.setWritable(false); assert.equal(h.root.querySelector('[data-pending-link-lock]').disabled, true); h.panel.setWritable(true);
  h.root.querySelector('[data-pending-link-lock]').click(); assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { pendingPatternId: 'pending-1', entryId: 'entry-1' });
  h.data.pendingPatternLinks = [{ pendingPatternId: 'pending-1', entryId: 'entry-1' }];
  for (const l of h.data.casePatterns) { l.entryId = l.patternKey = 'entry-1'; l.options = [{ entryId: 'entry-1', title: 'Approved constraints' }]; }
  h.panel.render(h.data); assert.match(h.root.querySelector('[data-pattern-targets]').textContent, /门槛目标复现题：#1.*测试目标复现题：#19/s); assert.equal(h.root.querySelector('[data-pending-link]'), null);
  assert.match(h.root.querySelector('[data-pattern-targets]').textContent, /目标复现题已经确定.*用于评测.*冻结断言.*通过回放检查.*上面.*缺项/s);
  assert.match(h.root.querySelector('[data-board-readiness]').textContent, /尚不能评测候选：缺可用门槛题、可用 trace 测试题/);
});

function pendingBoard(t, entries) {
  const sent = [], h = setup(t, null, { onLinkPendingPattern: body => sent.push(body) });
  h.data.cases = h.data.cases.slice(0, 3);
  h.data.pendingPatterns = [{ id: 'pending-1', name: 'Check constraints first' }];
  h.data.casePatterns = h.data.cases.map(c => ({ caseId: c.id, confirmed: true, pendingPatternId: 'pending-1', pendingPatternName: 'Check constraints first', entryId: null, patternKey: 'pending-1' }));
  h.data.versions = [{ entries }]; h.panel.render(h.data); h.root.querySelector('[data-bc-pattern="pending-1"]').click();
  return { ...h, sent, select: () => h.root.querySelector('[data-pending-link-entry]'), button: () => h.root.querySelector('[data-pending-link]') };
}
test('unrelated approved patterns have an empty link default and a disabled normal-width action, even after write toggles', t => {
  const h = pendingBoard(t, [{ id: 'unrelated', title: 'Unrelated approved', status: 'approved', caseIds: ['elsewhere'] }]);
  assert.equal(h.select().options[0].value, ''); assert.equal(h.select().options[0].textContent, '选择已通过的模式…');
  assert.equal(h.select().value, ''); assert.equal(h.button().disabled, true);
  h.panel.setWritable(false); h.panel.setWritable(true); assert.equal(h.button().disabled, true);
  assert.match(h.root.querySelector('[data-pending-link-panel]').firstElementChild.textContent, /下一步.*知识库.*训练.*归纳.*审核/s);
  assert.ok(h.button().closest('.row-actions'), 'link action must not stretch as a direct grid child');
  h.button().disabled = false; h.button().click(); assert.equal(h.root.querySelector('[data-link-consent]'), null); assert.equal(h.sent.length, 0);
  h.select().value = 'unrelated'; h.select().dispatchEvent(new h.window.Event('change', { bubbles: true })); assert.equal(h.button().disabled, false);
  h.select().value = ''; h.select().dispatchEvent(new h.window.Event('change', { bubbles: true })); assert.equal(h.button().disabled, true);
});
test('a unique approved pattern derived from group training cases is first, annotated and selected, but remains read-only guarded', t => {
  const h = pendingBoard(t, [
    { id: 'unrelated', title: 'Unrelated', status: 'approved', caseIds: [] },
    { id: 'heldout-only', title: 'Heldout only', status: 'approved', caseIds: ['c2', 'c3'] },
    { id: 'derived', title: '<b>Derived pattern</b>', status: 'approved', caseIds: ['c1'] },
    { id: 'draft', title: 'Not approved', status: 'draft', caseIds: ['c1'] },
  ]);
  assert.deepEqual([...h.select().options].map(o => o.value), ['', 'derived', 'unrelated', 'heldout-only']);
  assert.equal(h.select().options[1].textContent, '<b>Derived pattern</b>（用本组训练用例归纳出）'); assert.equal(h.select().querySelector('b'), null);
  assert.equal(h.select().value, 'derived'); assert.equal(h.button().disabled, false);
  h.panel.setWritable(false); assert.equal(h.button().disabled, true); h.panel.setWritable(true); assert.equal(h.button().disabled, false);
  h.button().click(); assert.match(h.root.querySelector('[data-link-consent]').textContent, /Derived pattern/);
  h.root.querySelector('[data-pending-link-lock]').click(); assert.deepEqual(JSON.parse(JSON.stringify(h.sent)), [{ pendingPatternId: 'pending-1', entryId: 'derived' }]);
});
test('multiple training-derived approved patterns sort first without selecting any; heldout-only matches never qualify', t => {
  const h = pendingBoard(t, [
    { id: 'heldout-only', title: 'Heldout only', status: 'approved', caseIds: ['c2', 'c3'] },
    { id: 'derived-1', title: 'Derived 1', status: 'approved', caseIds: ['c1'] },
    { id: 'derived-2', title: 'Derived 2', status: 'approved', caseIds: ['elsewhere', 'c1'] },
  ]);
  assert.deepEqual([...h.select().options].map(o => o.value), ['', 'derived-1', 'derived-2', 'heldout-only']);
  assert.equal(h.select().value, ''); assert.equal(h.button().disabled, true);
  assert.equal([...h.select().options].filter(o => o.textContent.includes('（用本组训练用例归纳出）')).length, 2);
  h.data.versions[0].entries = h.data.versions[0].entries.slice(0, 1); h.panel.render(h.data);
  assert.equal(h.select().value, ''); assert.equal(h.button().disabled, true); assert.doesNotMatch(h.select().textContent, /用本组训练用例归纳出/);
});

test('Badcase preclassification button names the whole pending batch and is read-only locked', t => {
  let calls = 0; const h = setup(t, null, { onPreclassify: () => calls++ });
  for (const c of h.data.cases.slice(0, 2)) { c.kind = 'marked-badcase'; c.split = null; }
  h.data.casePatterns = h.data.cases.slice(0, 2).map(c => ({ caseId: c.id, confirmed: false, options: [], pendingOptions: [] }));
  h.panel.render(h.data); const host = () => h.root.querySelector('[data-bc-detail] [data-pattern-label]');
  assert.match(host().textContent, /全部.*2.*#1.*#19/s); assert.equal(calls, 0);
  h.panel.setWritable(false); assert.equal(host().querySelector('[data-preclassify]').disabled, true); h.panel.setWritable(true); host().querySelector('[data-preclassify]').click(); assert.equal(calls, 1);
});

test('assigned-label blockers are shown verbatim and suppress all first-split confirmation buttons', t => {
  const sent = [], h = setup(t, null, { onConfirmInitialSplit: body => sent.push(body), confirm: () => true });
  h.data.initialSplitProposal = { hash: 'd'.repeat(64), seed: 'fixed', blockingReason: 'assigned_pattern_labels_unconfirmed', blockingMessage: '先确认 #1 的模式标签', blockers: [{ caseId: 'c1', caseNumber: 1 }], rows: [], patterns: [] };
  h.panel.render(h.data);
  const host = h.root.querySelector('[data-initial-split-blocked]'); assert.ok(host);
  assert.match(host.textContent, /先确认 #1 的模式标签/);
  assert.equal(host.querySelector('[data-initial-split-confirm]'), null);
  assert.equal(sent.length, 0); assert.equal(h.calls.length, 0);
});

test('initial split preview never activates groups until explicit per-pattern hash-bound confirmation', t => {
  const sent = [];
  const h = setup(t, null, { onConfirmInitialSplit: body => sent.push(body), confirm: () => { throw Error('no browser dialog'); } });
  h.data.cases[0].split = h.data.cases[1].split = null;
  const rows = [{ caseId: 'c1', patternKey: 'entry-1', level: 'run', previousSplit: null, proposedSplit: 'train' }, { caseId: 'c2', patternKey: 'entry-1', level: 'trace', previousSplit: null, proposedSplit: 'gate' }];
  h.data.casePatterns = rows.map(r => ({ caseId: r.caseId, confirmed: true, entryId: 'entry-1', patternKey: 'entry-1', options: [{ entryId: 'entry-1', title: '模式一' }] }));
  h.data.initialSplitProposal = { hash: 'd'.repeat(64), seed: 'fixed', rows, patterns: [{ patternKey: 'entry-1', rows, counts: { trace: { train: 0, gate: 1, test: 0 }, run: { train: 1, gate: 0, test: 0 } } }] };
  h.panel.render(h.data); h.root.querySelector('[data-bc-pattern="entry-1"]').click(); assert.equal(h.calls.length, 0); assert.equal(sent.length, 0);
  let host = h.root.querySelector('[data-initial-split]'); assert.ok(host); assert.match(host.textContent, /尚未生效|你确认后/);
  host.querySelector('[data-initial-split-confirm]').click(); assert.equal(sent.length, 0); host = h.root.querySelector('[data-initial-split]');
  assert.match(host.querySelector('[data-split-consent]').textContent, /模式一.*#1.*训练.*#19.*门槛/s);
  host.querySelector('[data-initial-split-lock]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { proposalHash: 'd'.repeat(64), patternKey: 'entry-1' });
  assert.equal(h.data.cases[0].split, null); assert.equal(h.data.cases[1].split, null);
  h.panel.setWritable(false); assert.equal(host.querySelector('[data-initial-split-lock]').disabled, true);
});

test('pipeline has truthful stepper, actor groups, two funnels, backfill states and source-only exclusions without writes', t => {
  const h = setup(t); assert.equal(h.calls.length, 0);
  assert.equal(h.root.querySelectorAll('[data-lane]').length, 2);
  assert.equal(h.root.querySelector('[data-case-id="c1"] .stepper').children.length, 9);
  for (const text of ['按下一步分组', '旧题来源', '非 GPT 来源', '回填部分完成', '历史现场元数据缺失', '评分 v2', 'DeepSeek 推荐尚未生成']) assert.ok(h.root.textContent.includes(text), text);
  assert.doesNotMatch(h.root.textContent, /批准补全|示例.*JEV|已成为测试用例.*[1-9]/);
  h.panel.focus(4); assert.equal(h.root.querySelector('[data-case-id="c3"]').closest('[data-actor]').dataset.actor, 'source');
});
test('legacy context reason means missing newer archive, not missing recovered input or reused turns', t => {
  const h = setup(t);
  assert.match(h.root.textContent, /没有新版上下文归档；本轮输入和续用前轮已从会话日志恢复/);
  assert.doesNotMatch(h.root.textContent, /未保存当时的原始上下文/);
  h.data.cases[0].traceBundle.missingReasons = ['context_archive_missing', 'system_prompt_display_redacted', 'provider_request_bytes_missing'];
  h.panel.render(h.data);
  for (const text of ['没有新版上下文归档', '系统提示词为历史展示版', '未保存供应商请求原始字节']) assert.ok(h.root.textContent.includes(text), text);
  assert.equal(h.calls.length, 0);
});
test('expand fetches frozen packet lazily, shows full output/results and exports only from its read-only endpoints', async t => {
  const h = setup(t); await h.expand(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0], '/api/wikiskill/cases/c1/trace');
  const trace = h.root.querySelector('[data-trace-case="c1"]');
  assert.equal(trace.querySelectorAll('[data-trace-section]').length, 3);
  assert.match(trace.textContent, /original request|full model text/); assert.match(trace.textContent, /final-needle/);
  assert.doesNotMatch(trace.textContent, /DO NOT USE EXCERPT/); assert.equal(trace.querySelector('script'), null);
  assert.ok([...trace.querySelectorAll('details.trace-value')].some(d => !d.open));
  assert.equal(trace.querySelector('[data-export="json"]').getAttribute('href'), '/api/wikiskill/cases/c1/trace/export.json');
  assert.equal(trace.querySelector('[data-export="md"]').getAttribute('href'), '/api/wikiskill/cases/c1/trace/export.md');
  const q = trace.querySelector('[data-trace-search]'); q.value = 'final-needle'; q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(trace.querySelector('mark').textContent, 'final-needle'); assert.match(trace.querySelector('[data-trace-matches]').textContent, /1/);
  assert.equal(h.calls.length, 1); assert.equal(h.data.cases[0].message, 'DO NOT USE EXCERPT');
});
test('failed reads never fall back to excerpts and allow an explicit retry', async t => {
  let failing = true; const h = setup(t, (_url, packet) => { if (failing) throw Error('private-path'); return { traceBundle: packet }; });
  await h.expand(); const trace = h.root.querySelector('[data-trace-case="c1"]');
  assert.match(trace.textContent, /读取失败/); assert.doesNotMatch(trace.textContent, /private-path|DO NOT USE EXCERPT/);
  failing = false; trace.querySelector('[data-trace-retry]').click(); await tick(); await tick();
  assert.match(trace.textContent, /full model text/); assert.equal(h.calls.length, 2);
});
test('recommendation is read-only until an explicit user confirmation, then binds IDs and hashes; declined confirmations never write', t => {
  const sent = [], prompts = []; let accept = false;
  const h = setup(t, null, { onConfirmDecision: body => sent.push(body), confirm: message => { prompts.push(message); return accept; } });
  const r = { caseId: 'c1', traceHash: 'a'.repeat(64), hash: 'c'.repeat(64), request: { state: { steps: [{ step: 1, body: '<script>literal</script> decision' }, { step: 2, body: 'public reply' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'single', evidenceVerified: true, cutStepSuggestion: 1, cutSource: 'deepseek', answers: { kind: '单步型', reason: '<script>reason</script>', evidence: '<script>literal</script>' } } };
  h.data.dehydrations = [r]; h.panel.render(h.data);
  assert.equal(h.calls.length, 0); assert.equal(sent.length, 0); assert.match(h.root.querySelector('[data-actor="you"]').textContent, /请确认能否脱水/);
  const host = h.root.querySelector('[data-dehydration="c1"]'); assert.equal(host.querySelector('script'), null); assert.match(host.textContent, /DeepSeek 建议/); assert.match(host.textContent, /程序已核对为该步卡片原文的子串/); assert.doesNotMatch(host.textContent, /90.0%|概率/);
  host.querySelector('[data-dehydration-confirm]').click(); assert.equal(sent.length, 0); accept = true;
  host.querySelector('[data-dehydration-cut]').value = '2'; host.querySelector('[data-dehydration-confirm]').click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { caseId: 'c1', traceHash: r.traceHash, recommendationHash: r.hash, kind: 'single', cutStep: 2 }); assert.match(prompts.at(-1), /#1.*第 2 步/);
  host.querySelector('[data-dehydration-kind]').value = 'throughout'; host.querySelector('[data-dehydration-confirm]').click(); assert.equal(sent[1].cutStep, null);
  h.panel.setWritable(false); assert.equal(host.querySelector('[data-dehydration-confirm]').disabled, true);
  r.decision = { kind: 'throughout', level: 'reference', cutStep: null, hash: 'd'.repeat(64) }; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-dehydration-confirm]'), null); assert.equal(h.root.querySelector('[data-case-id="c1"]').closest('[data-actor]').dataset.actor, 'reference');
  assert.match(h.root.textContent, /已冻结：贯穿型.*只作参考/); assert.equal(h.calls.length, 0);
});
test('frozen user override shows planner provenance without replacing the original DeepSeek judgment', t => {
  const h = setup(t);
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), request: { state: { steps: [{ step: 1, body: 'reply' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'throughout', cutStepSuggestion: 1, cutSource: 'marked_step_fallback', fallbackReason: 'not_single', evidenceVerified: false,
      answers: { kind: '贯穿型', cutStep: '无', reason: '整段取向', evidence: '' } },
    decision: { kind: 'single', level: 'run', cutStep: 1, hash: 'd'.repeat(64), confirmation: { source: 'user-via-planner', reference: '<script>message</script>' } } }];
  h.panel.render(h.data);
  const host = h.root.querySelector('[data-dehydration="c1"]');
  assert.match(host.textContent, /DeepSeek 建议：贯穿型/); assert.match(host.textContent, /已冻结：单步型.*第 1 步/);
  assert.match(host.textContent, /确认来源：用户经规划者转达/); assert.match(host.textContent, /用户改判/);
  assert.match(host.textContent, /<script>message<\/script>/); assert.equal(host.querySelector('script'), null);
  assert.equal(host.querySelector('[data-dehydration-confirm]'), null); assert.equal(h.calls.length, 0);
});
test('run output loads read-only; invalid attempts never fail and original-without-valid-output cases are excluded', async t => {
  const h = setup(t, url => ({ reservation: { request: { context: { tools: [{ name: 'write' }] } } }, result: { message: { content: [{ type: 'text', text: '<script>full output</script>' }] } } }));
  const r = { id: 'e'.repeat(64), caseId: 'c1', traceHash: 'a'.repeat(64), decisionHash: 'd'.repeat(64), variant: { kind: 'original' }, status: 'invalid', baselineStatus: 'no_valid_output', eligibleForScoring: false, caseEligibleForGateAndScreen: false, model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh', resultHash: 'f'.repeat(64), modelCalls: 1, toolExecutions: 0 };
  h.data.runReplays = [r, { ...r, id: '1'.repeat(64), status: 'error' }];
  h.data.dehydrations = [{ caseId: 'c1', traceHash: r.traceHash, recommendation: { kindSuggestion: 'single' }, request: { state: { steps: [] } }, decision: { kind: 'single', level: 'run', hash: r.decisionHash } }];
  h.panel.render(h.data); assert.equal(h.calls.length, 0);
  assert.match(h.root.textContent, /无效 1/); assert.match(h.root.textContent, /请求失败 1/); assert.match(h.root.textContent, /不算通过也不算不通过/);
  assert.match(h.root.textContent, /原版无有效输出/); assert.match(h.root.textContent, /不进门槛和初筛/); assert.doesNotMatch(h.root.textContent, /未到达|按不通过计/);
  assert.equal(h.root.querySelector('[data-case-id="c1"] .stepper').children[7].className, 'skip');
  assert.ok(h.root.querySelector('[data-run-export="json"]')); assert.ok(h.root.querySelector('[data-run-export="md"]'));
  const d = h.root.querySelector('[data-run-details]'); d.open = true; d.dispatchEvent(new h.window.Event('toggle')); await tick(); await tick();
  assert.equal(h.calls[0], '/api/wikiskill/cases/c1/run-replays/' + r.id);
  assert.match(d.textContent, /<script>full output<\/script>/); assert.equal(d.querySelector('script'), null);
  assert.match(d.textContent, /write/); assert.equal(h.calls.length, 1);
});
test('user reference-only withdrawal keeps prior confirmation and full run visible but excludes them from current funnel and totals', async t => {
  const h = setup(t, () => ({ reservation: { request: { metadata: { cutStep: 1 } } }, result: { message: { content: [{ type: 'text', text: 'OLD RUN FULL OUTPUT' }] } } }));
  const first = { kind: 'single', level: 'run', cutStep: 1, hash: 'd'.repeat(64), confirmation: { source: 'user-via-planner', reference: 'first-confirmation' } };
  const current = { kind: 'throughout', level: 'reference', cutStep: null, hash: 'f'.repeat(64), supersedesDecisionHash: first.hash,
    reason: '<script>贯穿全程</script>', confirmation: { source: 'user-via-planner', reference: 'user-withdrawal' } };
  h.data.cases[0].n = 12;
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), request: { state: { steps: [{ step: 1, body: 'plan' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'single', cutStepSuggestion: 1, cutSource: 'deepseek', answers: { reason: 'original recommendation', evidence: 'plan' } }, decision: current, decisionHistory: [first] }];
  const oldRun = { id: 'e'.repeat(64), caseId: 'c1', traceHash: 'a'.repeat(64), decisionHash: first.hash, variant: { kind: 'original' }, status: 'invalid', modelCalls: 1, toolExecutions: 0,
    excludedReason: 'user_reclassified_reference', supersededByDecisionHash: current.hash };
  h.data.runReplays = [oldRun]; h.panel.render(h.data);
  const card = h.root.querySelector('[data-case-id="c1"]'); assert.equal(card.closest('[data-actor]').dataset.actor, 'reference');
  assert.match(card.textContent, /已冻结：贯穿型.*只作参考/); assert.match(card.textContent, /已被用户改判，不计入/);
  assert.match(card.textContent, /首次确认|历史确认/); assert.match(card.textContent, /first-confirmation/); assert.match(card.textContent, /original recommendation/);
  assert.match(card.textContent, /<script>贯穿全程<\/script>/); assert.equal(card.querySelector('script'), null);
  assert.match(h.root.querySelector('[data-run-totals]').textContent, /共 0 次.*无效 0/);
  assert.match(h.root.querySelector('[data-run-totals]').textContent, /已被用户改判，不计入.*1 次/);
  assert.match(h.root.querySelector('[data-lane="run"]').textContent, /只作参考/);
  assert.equal(h.root.querySelector('[data-lane="run"] .f-step b').textContent, '0');
  const d = card.querySelector('[data-run-details]'); assert.ok(d); assert.match(d.querySelector('summary').textContent, /已被用户改判，不计入/);
  d.open = true; d.dispatchEvent(new h.window.Event('toggle')); await tick(); await tick();
  assert.match(d.textContent, /OLD RUN FULL OUTPUT/); assert.equal(h.calls.length, 1); assert.equal(card.querySelector('[data-dehydration-confirm]'), null);
});
test('fallback output explains the exact failure and never presents missing answers as a model judgment', t => {
  const h = setup(t);
  h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), request: { state: { steps: [{ step: 1, body: 'reply' }] } },
    recommendation: { schemaVersion: 2, kindSuggestion: 'unclear', cutStepSuggestion: 1, cutSource: 'marked_step_fallback', fallbackReason: 'parse_failed', evidenceVerified: false, answers: null } }];
  h.panel.render(h.data); assert.match(h.root.textContent, /两次输出仍无法解析.*回退到发消息步骤，请你挑选/);
  assert.match(h.root.textContent, /未取得可解析答案，不代表模型给出了判断/); assert.doesNotMatch(h.root.textContent, /概率/);
  h.data.dehydrations[0].recommendation.fallbackReason = 'evidence_mismatch'; h.panel.render(h.data);
  assert.match(h.root.textContent, /依据与该步卡片原文不匹配/); assert.equal(h.calls.length, 0);
});
test('legacy regroup proposal stays read-only in collapsed audit, never claiming a new group is active', t => {
  const h = setup(t); h.data.regroupProposals = [{ status: 'proposed', hash: 'f'.repeat(64), seed: 'fixed-seed', policy: 'trace-run-stratified-v1',
    counts: { trace: { train: 1, gate: 1, test: 0 }, run: { train: 5, gate: 1, test: 0 } }, warnings: ['no_new_trace_test'],
    rows: [{ caseId: 'c1', caseNumber: 1, level: 'run', previousSplit: 'train', proposedSplit: 'gate', reason: null },
      { caseId: 'deleted-case', caseNumber: 7, previousSplit: 'train', proposedSplit: null, reason: 'deleted_missing_system_prompt' }] }];
  h.panel.render(h.data); const panel = h.root.querySelector('[data-group-audit]'); assert.ok(panel);
  assert.equal(panel.open, false); assert.equal(h.root.querySelector('.regroup-table'), null);
  assert.match(panel.textContent, /deleted_missing_system_prompt/); assert.match(panel.textContent, /no_new_trace_test/);
  assert.deepEqual(JSON.parse(panel.querySelector('pre').textContent).proposals, h.data.regroupProposals);
  assert.equal(h.data.cases[0].split, 'train'); assert.equal(h.calls.length, 0);
  assert.match(h.root.querySelector('[data-case-id="c1"] .bc-meta').textContent, /训练/);
  assert.doesNotMatch(h.root.querySelector('[data-case-id="c1"]').textContent, /提议：门槛/);
  assert.equal(panel.querySelector('button'), null, 'no auto-application or intermediate confirmation endpoint');
});
test('unassigned cases stay in the board out column across legacy proposals and confirmations', t => {
  const h = setup(t); h.data.cases[1].split = null; h.data.cases[1].actual = '<script>pending scene</script>';
  h.panel.render(h.data);
  const pending = () => h.root.querySelector('[data-board-column="out"]');
  assert.ok(pending()); assert.match(pending().textContent, /#19/);
  assert.match(pending().textContent, /待分配/); assert.equal(pending().querySelector('script'), null);
  h.panel.focus(19); const card = h.root.querySelector('[data-case-id="c2"]');
  assert.match(card.querySelector('.bc-meta').textContent, /待分配/);
  assert.match(card.querySelector('.steps-detail').textContent, /待分配/);
  h.data.regroupProposals = [{ hash: 'f'.repeat(64), seed: 'fixed', rows: [], warnings: [], counts: { trace: { train: 0, gate: 0, test: 0 }, run: { train: 0, gate: 0, test: 0 } } }];
  h.panel.render(h.data);
  assert.ok(pending()); assert.deepEqual(JSON.parse(h.root.querySelector('[data-group-audit] pre').textContent).proposals[0].rows, []);
  h.data.regroupConfirmations = [{ status: 'active', hash: 'e'.repeat(64), proposalHash: 'f'.repeat(64), rows: [], counts: h.data.regroupProposals[0].counts, confirmation: {} }];
  h.panel.render(h.data); assert.ok(pending()); assert.match(pending().textContent, /待分配/);
  assert.equal(h.data.cases[1].split, null); assert.equal(h.calls.length, 0);
});
test('confirmed grouping shows original proposal, user adjustment and active groups read-only without claiming scoring readiness', t => {
  const h = setup(t), proposalHash = 'f'.repeat(64), confirmHash = 'e'.repeat(64);
  h.data.cases[0].split = 'gate';
  h.data.cases.push({ id: 'trace20', n: 20, sealedCheckpointId: 'cp20', split: 'test', actual: 'frozen test', source: { agentId: 'role-family-gpt' } });
  const rows = [{ caseId: 'c1', caseNumber: 1, level: 'run', previousSplit: 'train', proposedSplit: 'gate', confirmedSplit: 'gate', reason: null },
    { caseId: 'c2', caseNumber: 19, level: 'trace', previousSplit: 'gate', proposedSplit: 'gate', confirmedSplit: 'gate', confirmationReason: 'frozen_trace_split', reason: null },
    { caseId: 'trace20', caseNumber: 20, level: 'trace', previousSplit: 'test', proposedSplit: 'train', confirmedSplit: 'test', confirmationReason: 'frozen_trace_split', reason: null }];
  h.data.regroupProposals = [{ status: 'proposed', hash: proposalHash, seed: 'fixed-seed', rows, counts: { trace: { train: 1, gate: 1, test: 0 }, run: { train: 0, gate: 1, test: 0 } }, warnings: ['no_new_trace_test'] }];
  h.data.regroupConfirmations = [{ status: 'active', hash: confirmHash, proposalHash, rows, counts: { trace: { train: 0, gate: 1, test: 1 }, run: { train: 0, gate: 1, test: 0 } },
    confirmation: { source: 'user-via-planner', reference: '<script>confirmed-message</script>' }, reason: '组别冻结；#20 仍供评分 v2 测试',
    adjustments: [rows[2]], confirmedAt: '2026-11-05T00:00:00Z' }];
  h.panel.render(h.data); const panel = h.root.querySelector('[data-group-audit]'); assert.ok(panel);
  assert.equal(panel.open, false); assert.ok(panel.textContent.includes(proposalHash)); assert.ok(panel.textContent.includes(confirmHash));
  const audit = JSON.parse(panel.querySelector('pre').textContent);
  assert.deepEqual(audit.confirmations, h.data.regroupConfirmations); assert.deepEqual(audit.proposals, h.data.regroupProposals);
  const r = audit.confirmations[0].rows.find(r => r.caseNumber === 20); assert.deepEqual([r.previousSplit, r.proposedSplit, r.confirmedSplit], ['test', 'train', 'test']);
  assert.equal(panel.querySelector('script'), null); assert.match(panel.textContent, /<script>confirmed-message<\/script>/);
  assert.doesNotMatch(panel.textContent, /没有新的 trace 级测试题|分组提议 · 尚未生效/);
  for (const n of [1, 19, 20]) {
    h.panel.focus(n); const card = h.root.querySelector('#bc-' + n); assert.match(card.textContent, /用户确认.*组/); assert.doesNotMatch(card.textContent, /尚未生效|等待分组|重新分组待用户确认/);
    assert.equal(card.querySelector('.stepper').children[4].className, 'done');
  }
  assert.match(h.root.querySelector('[data-board-readiness]').textContent, /尚不能评测/); assert.equal(h.calls.length, 0); assert.equal(panel.querySelector('button'), null);
});
test('new checkpoint metadata is shown separately from legacy missing fields and never claims replay success', t => {
  const h = setup(t);
  h.data.cases[1].traceBundle.scene = { metadataStatus: 'recorded', metadataSource: 'checkpoint_git_snapshot_v2', head: 'a'.repeat(40), branch: 'room/test', skippedCount: 0 };
  h.panel.render(h.data); h.panel.focus(19);
  const card = h.root.querySelector('[data-case-id="c2"]');
  assert.match(card.textContent, /现场元数据已冻结/); assert.doesNotMatch(card.textContent, /待采集能力合入|现场待接入/);
  assert.equal(card.querySelector('.stepper').children[1].className, 'done');
  assert.equal(card.closest('[data-actor]').dataset.actor, 'you', 'missing assertion still needs user drafting/confirmation');
  assert.match(card.querySelector('.next-line').textContent, /有现场，走 trace 级/);
  assert.doesNotMatch(card.querySelector('.next-line').textContent, /请确认能否脱水/);
  assert.match(h.root.querySelector('[data-lane="trace"]').textContent, /不能把封存当作已通过回放检查/);
  h.data.cases[1].traceBundle.scene.metadataStatus = 'partial'; h.panel.render(h.data);
  assert.match(h.root.querySelector('[data-case-id="c2"]').textContent, /现场部分记录/);
  assert.equal(h.calls.length, 0);
});
test('sealed scenes show trace-only guidance and never offer recommendation even with stale eligibility', t => {
  const sent = [], h = setup(t, null, { onRequestRecommendation: body => sent.push(body), confirm: () => true });
  h.data.cases[1].dehydrationRecommendation = { eligible: true }; // stale server projection cannot reopen the action
  h.panel.render(h.data); h.panel.focus(19); const card = h.root.querySelector('[data-case-id="c2"]');
  assert.equal(card.querySelector('[data-dehydration-recommend]'), null);
  assert.match(card.textContent, /有现场，走 trace 级/); assert.doesNotMatch(card.textContent, /可另选脱水/);
  assert.equal(sent.length, 0); assert.equal(h.calls.length, 0);
});
test('request button is explicit, eligibility-bound, read-only when disabled and never sends automatically', t => {
  const sent = []; let accept = false;
  const h = setup(t, null, { onRequestRecommendation: body => sent.push(body), confirm: () => accept });
  h.data.cases[0].dehydrationRecommendation = { eligible: true };
  h.panel.render(h.data);
  const button = h.root.querySelector('[data-dehydration-recommend="c1"]'); assert.ok(button); assert.equal(button.textContent, '请求推荐');
  assert.equal(h.root.querySelector('[data-dehydration-recommend="c3"]'), null); assert.equal(h.root.querySelector('[data-dehydration-recommend="c4"]'), null);
  assert.equal(sent.length, 0); button.click(); assert.equal(sent.length, 0); accept = true; button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0])), { caseId: 'c1', traceHash: 'a'.repeat(64) });
  h.panel.setWritable(false); assert.equal(button.disabled, true); button.click(); assert.equal(sent.length, 1);
  h.data.cases[0].dehydrationRecommendation = { eligible: false }; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-dehydration-recommend="c1"]'), null); assert.equal(h.calls.length, 0);
});
test('unavailable system prompt is disclosed and an ineligible case has no recommendation button', t => {
  const sent = [], h = setup(t, null, { onRequestRecommendation: body => sent.push(body) });
  h.data.cases[0].dehydrationRecommendation = { eligible: false };
  h.data.cases[0].traceBundle.missingReasons = ['system_prompt_unavailable']; h.panel.render(h.data);
  const card = h.root.querySelector('[data-case-id="c1"]');
  assert.match(card.textContent, /系统提示词不可用.*占位文字不能用于脱水或回放/);
  assert.equal(card.querySelector('[data-dehydration-recommend]'), null);
  assert.equal(sent.length, 0); assert.equal(h.calls.length, 0);
});
test('one failed parse offers fallback confirmation OR one manual retry and retains earlier raw evidence', t => {
  const sent = [], h = setup(t, null, { onRequestRecommendation: body => sent.push(body), onConfirmDecision() {}, confirm: () => true });
  h.data.cases[0].dehydrationRecommendation = { eligible: true };
  const first = { caseId: 'c1', traceHash: 'a'.repeat(64), hash: 'c'.repeat(64), request: { state: { steps: [{ step: 1, body: 'reply' }] } },
    recommendation: { schemaVersion: 2, retryPolicy: 'manual', kindSuggestion: 'unclear', cutStepSuggestion: 1, cutSource: 'marked_step_fallback', fallbackReason: 'parse_failed', answers: null, attempts: [{ content: 'REAL INVALID JSON' }] } };
  h.data.dehydrations = [first]; h.panel.render(h.data);
  assert.match(h.root.textContent, /本次输出无法解析/); assert.match(h.root.textContent, /默认切在发消息那一步/);
  assert.ok(h.root.querySelector('[data-dehydration-confirm]')); h.root.querySelector('[data-dehydration-recommend]').click();
  assert.equal(sent[0].retryOf, first.hash); assert.equal(sent.length, 1);
  h.data.dehydrations.push({ ...first, hash: 'd'.repeat(64), retryOf: first.hash });
  h.data.cases[0].dehydrationRecommendation = { eligible: false }; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-dehydration-recommend]'), null); assert.match(h.root.textContent, /此前推荐.*保留/s);
  assert.ok(h.root.textContent.includes(first.hash)); assert.match(h.root.textContent, /REAL INVALID JSON/);
  assert.equal(h.calls.length, 0);
});
test('approved layout renders one selected detail with searchable four-state list and nine-step mini rows', t => {
  const h = setup(t);
  assert.equal(h.root.querySelectorAll('[data-bc-row]').length, 4);
  assert.equal(h.root.querySelectorAll('[data-case-id]').length, 1);
  assert.equal(h.root.querySelector('[data-bc-detail] [data-case-id]').dataset.caseId, 'c1');
  assert.equal(h.root.querySelector('[data-bc-row="c2"] .mini').children.length, 9);
  for (const key of ['all', 'you', 'system', 'library', 'stop']) assert.ok(h.root.querySelector(`[data-bc-filter="${key}"]`));
  h.root.querySelector('[data-bc-row="c2"]').click();
  assert.equal(h.root.querySelector('[data-bc-detail] [data-case-id]').dataset.caseId, 'c2');
  assert.equal(h.root.querySelector('[data-bc-row="c2"]').getAttribute('aria-current'), 'true');
  const q = h.root.querySelector('[data-bc-search]'); q.value = 'DO NOT MATCH'; q.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(h.root.querySelectorAll('[data-case-id]').length, 0, 'do not leave a hidden nonmatching case in detail');
  h.panel.focus(4); assert.equal(q.value, ''); assert.equal(h.root.querySelector('[data-case-id]').dataset.caseId, 'c3');
  assert.equal(h.calls.length, 0);
});
test('mode-first board has solid effective groups, dashed proposals, per-mode quotas and integrated confirmations', t => {
  const h = setup(t, null, { onConfirmInitialSplit() {}, onConfirmPatternLabel() {} }); h.data.cases[1].split = null;
  const options = [{ entryId: 'p1', title: '<script>first mode</script>' }, { entryId: 'p2', title: 'Second mode' }];
  h.data.casePatterns = h.data.cases.map((c, i) => ({ caseId: c.id, entryId: i === 3 ? 'p2' : 'p1', patternKey: i === 3 ? 'p2' : 'p1', confirmed: i !== 2, options }));
  const rows = [{ caseId: 'c2', patternKey: 'p1', level: 'trace', proposedSplit: 'gate' }];
  h.data.initialSplitProposal = { hash: 'd'.repeat(64), seed: 'fixed', rows, patterns: [{ patternKey: 'p1', rows, existingCounts: { trace: { train: 0, gate: 0, test: 0 }, run: { train: 1, gate: 0, test: 0 } }, counts: { trace: { train: 0, gate: 1, test: 0 }, run: { train: 1, gate: 0, test: 0 } } }] };
  h.panel.render(h.data); h.root.querySelector('[data-bc-pattern="p1"]').click();
  const board = h.root.querySelector('[data-grouping]'); assert.ok(board);
  assert.equal(board.querySelectorAll('[data-board-column]').length, 4);
  assert.ok(board.querySelector('[data-board-column="gate"] .prop[data-bc-pick="c2"]'));
  assert.ok(board.querySelector('[data-initial-split-confirm="p1"]'));
  assert.ok(board.querySelector('[data-board-quotas]')); assert.equal(board.querySelector('script'), null);
  assert.equal(h.root.querySelectorAll('[data-bc-row]').length, 2, 'unconfirmed labels never silently join a suggested mode');
  h.root.querySelector('[data-bc-pattern="pending"]').click();
  assert.ok(board.querySelector('[data-bc-pick="c3"]'), 'legacy holdout opens its label panel in the selected detail');
  h.root.querySelector('[data-bc-pattern="all"]').click();
  assert.ok(board.querySelector('[data-pattern-overview]')); assert.equal(board.querySelector('[data-bc-pick]'), null, 'overview contains counts, not mixed-case chips');
  assert.match(board.textContent, /不能|尚不能|缺/); assert.equal(h.calls.length, 0);
});
test('board gate counts do not claim readiness from grouping alone or treat legacy sources as runnable trace cases', t => {
  const h = setup(t); const options = [{ entryId: 'p1', title: 'First mode' }];
  h.data.casePatterns = h.data.cases.map(c => ({ caseId: c.id, confirmed: true, entryId: 'p1', patternKey: 'p1', options }));
  h.panel.render(h.data); h.root.querySelector('[data-bc-pattern="p1"]').click();
  assert.match(h.root.querySelector('[data-board-readiness]').textContent, /尚不能|不能|缺/);
  assert.ok(h.root.querySelector('[data-board-column="test"] .old[data-bc-pick="c3"]'));
  h.root.querySelector('[data-bc-filter="stop"]').click();
  assert.equal(h.root.querySelectorAll('[data-bc-row]').length, 2);
  h.panel.focus(19); assert.equal(h.root.querySelector('[data-case-id]').dataset.caseId, 'c2');
  assert.equal(h.root.querySelector('[data-bc-filter="all"]').getAttribute('aria-checked'), 'true');
});
test('next actor asks the user to freeze missing/incompatible assertions, not a system that cannot act; labels precede library', t => {
  const h = setup(t); h.data.dehydrations = [{ caseId: 'c1', traceHash: 'a'.repeat(64), decision: { kind: 'single', level: 'run', cutStep: 1 }, recommendation: {}, request: { state: { steps: [] } } }];
  const row = { caseId: 'c1', assertion: { status: 'missing', version: null, questions: [] }, replay: { status: 'supported', cutStep: 1 }, original: { valid: 0, unscored: 1, outputs: 1, invalid: 0, errors: 0, reproduced: false }, inLibrary: false };
  h.data.pipelineStates = [row]; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-case-id="c1"]').dataset.actor, 'you');
  assert.equal(h.root.querySelector('.next-line a').getAttribute('href'), '#case-1'); assert.equal(h.calls.length, 0);
  row.assertion = { status: 'incompatible', version: 1, model: 'fixture', questions: [{ id: 'q1', question: 'test', evidence: 'trace' }] }; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-case-id="c1"]').dataset.actor, 'you');
  row.assertion.status = 'frozen'; row.inLibrary = true; h.data.casePatterns = [{ caseId: 'c1', confirmed: false, options: [], labelHash: 'a'.repeat(64) }]; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-case-id="c1"]').dataset.actor, 'you'); assert.match(h.root.querySelector('.next-line').textContent, /确认模式标签/);
  row.inLibrary = false; row.assertion.status = 'missing'; row.original.outputs = row.original.unscored = 0; h.data.casePatterns = []; h.panel.render(h.data);
  assert.equal(h.root.querySelector('[data-case-id="c1"]').dataset.actor, 'system'); assert.match(h.root.querySelector('.next-line').textContent, /原版.*有效输出|受信操作方/);
});
test('selection rerenders retain keyboard focus and mode/filter radios support arrow navigation', t => {
  const h = setup(t), button = h.root.querySelector('[data-bc-row="c2"]'); button.focus(); button.click();
  assert.equal(h.window.document.activeElement.dataset.bcRow, 'c2');
  const first = h.root.querySelector('[data-bc-filter="all"]'); first.focus(); first.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(h.window.document.activeElement.dataset.bcFilter, 'you'); assert.equal(h.window.document.activeElement.getAttribute('aria-checked'), 'true');
  const pending = h.root.querySelector('[data-bc-pattern="pending"]'); pending.focus(); pending.click();
  assert.equal(h.window.document.activeElement.dataset.bcPattern, 'pending');
});
test('candidate-readiness overview never treats unconfirmed labels as an eligible mode, even with old ready results', t => {
  const h = setup(t), scene = h.data.cases[1]; h.data.cases = [scene, { ...scene, id: 'test-ready', n: 30, split: 'test' }, { ...scene, id: 'control-ready', n: 31 }];
  const options = [{ entryId: 'p1', title: 'First' }, { entryId: 'p2', title: 'Control' }];
  h.data.casePatterns = h.data.cases.map((c, i) => ({ caseId: c.id, confirmed: i === 2, entryId: i === 2 ? 'p2' : null, patternKey: i === 2 ? 'p2' : null, options }));
  h.data.pipelineStates = h.data.cases.map(c => ({ caseId: c.id, assertion: { status: 'frozen', version: 1, model: 'fixture', questions: [] }, replay: { status: 'supported' }, original: { valid: 10, pass: 0, fail: 10, reproduced: true, invalid: 0, errors: 0 }, inLibrary: true }));
  h.panel.render(h.data); assert.match(h.root.querySelector('[data-board-readiness]').textContent, /尚不能|不能/);
  for (const label of h.data.casePatterns.slice(0, 2)) Object.assign(label, { confirmed: true, entryId: 'p1', patternKey: 'p1' });
  h.panel.render(h.data); h.root.querySelector('[data-bc-pattern="p1"]').click();
  assert.match(h.root.querySelector('[data-board-readiness]').textContent, /有可用门槛、测试和其他模式的防误伤题/); assert.equal(h.calls.length, 0);
});
test('approved modes with zero active members remain selectable with zero quotas, not silently removed', t => {
  const h = setup(t); h.data.versions = [{ entries: [{ id: 'empty-mode', title: 'Empty approved mode', status: 'approved' }, { id: 'draft-mode', title: 'Draft mode', status: 'draft' }] }];
  h.panel.render(h.data); const tab = h.root.querySelector('[data-bc-pattern="empty-mode"]'); assert.ok(tab); assert.match(tab.textContent, /0/);
  assert.equal(h.root.querySelector('[data-bc-pattern="draft-mode"]'), null);
  tab.click(); assert.equal(h.root.querySelectorAll('[data-bc-row]').length, 0); assert.equal(h.root.querySelectorAll('[data-case-id]').length, 0);
  assert.match(h.root.querySelector('[data-board-quotas]').textContent, /训练 0.*门槛 0.*测试 0/); assert.equal(h.calls.length, 0);
});
test('list-only selection preserves open frozen viewer DOM, and returning to a case reuses its cached packet', async t => {
  const h = setup(t); await h.expand();
  const trace = h.root.querySelector('[data-trace-case="c1"]'), section = trace.querySelector('[data-trace-section]'); section.open = true;
  h.root.querySelector('[data-bc-filter="all"]').click();
  assert.equal(h.root.querySelector('[data-trace-case="c1"]'), trace); assert.equal(section.open, true);
  h.panel.focus(19); h.panel.focus(1); await tick();
  assert.equal(h.root.querySelector('[data-trace-case="c1"]').open, true); assert.equal(h.calls.length, 1);
});
test('layout styles are scoped, wide, responsive, and keep tall detail scrollable inside the real inner scroller', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/badcase-pipeline.css'), 'utf8');
  assert.match(css, /\.bc-master-detail\s*\{[^}]*grid-template-columns:/);
  assert.match(css, /\.bc-detail\s*\{[^}]*position:\s*sticky[^}]*max-height:[^}]*overflow:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*980px\)/);
  assert.match(css, /\.bc-row\s*\{[^}]*color:\s*var\(--text\)/, 'management primary-button colors must not bleach row titles');
  assert.match(css, /\.bc-rows\s*\{[^}]*grid-auto-rows:\s*max-content/, 'bounded list must not shrink rows until mini progress overlaps');
  assert.match(fs.readFileSync(path.resolve(__dirname, '../../public/wikiskill.css'), 'utf8'), /max-width:\s*1680px/);
});
test('stale packet responses after a data refresh cannot replace current evidence', async t => {
  const pending = []; const h = setup(t, () => new Promise(r => { pending.push(r); })); await h.expand();
  h.data.cases[0].traceBundle.hash = 'c'.repeat(64); h.panel.render(h.data);
  pending[0]({ traceBundle: { ...h.packet, markedMessage: 'STALE RESPONSE' } }); await tick(); await tick();
  assert.doesNotMatch(h.root.textContent, /STALE RESPONSE/);
});
