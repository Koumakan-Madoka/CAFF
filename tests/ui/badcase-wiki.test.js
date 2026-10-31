const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function data() {
  const entry = { id: 'entry-1', title: '<img src=x>', failureMode: 'unsupported claims', symptoms: 'no checks', rootCauseHypothesis: 'skipped verification', guideline: '先核验后结论。', caseIds: ['c1'], status: 'draft' };
  return { schemaVersion: 1, scope: 'global', revision: 3, targets: [
    { id: 'global-harness-behavior-v1', kind: 'global-system-prompt', title: '全局行为准则', baseText: 'Shared harness prose.', baseHash: 'a'.repeat(64) },
    { id: 'tool-description-list_rooms', kind: 'tool-description', title: '工具描述 · list_rooms', baseText: 'List Rooms.', baseHash: 'b'.repeat(64) },
  ], candidates: [], cases: [
    { id: 'c1', kind: 'text-only', split: 'train', actual: 'no evidence', expected: 'run checks', message: '<script>bad()</script>', traceState: 'missing', traceExcerpt: '', source: { projectId: 'source-project', conversationId: 'source-room', messageId: 'source-message' } },
    { id: 'held-out', kind: 'text-only', split: 'test', actual: 'test source', expected: 'test expectation', message: '', traceState: 'missing', traceExcerpt: '', source: { projectId: 'another-project', conversationId: 'test-room', messageId: 'test-message' } },
  ], versions: [
    { id: 'wiki-2', createdAt: 'earlier', caseIds: ['c1'], entries: [{ ...entry, status: 'approved', title: 'Earlier approved' }], unclassified: [] },
    { id: 'wiki-3', createdAt: 'now', caseIds: ['c1', 'c2'], entries: [entry], unclassified: [{ caseId: 'c2', reason: 'missing context' }] },
  ] };
}
function setup(t, handler) {
  const dom = new JSDOM('<div id="panel"></div>', { runScripts: 'outside-only', url: 'http://127.0.0.1/' }); t.after(() => dom.window.close());
  dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../public/shared/badcase-wiki.js'), 'utf8'));
  const root = dom.window.document.getElementById('panel'), calls = [], confirms = []; let accepted = true, saved = data();
  const panel = dom.window.CaffShared.createBadcaseWikiPanel({ root, confirm: message => { confirms.push(message); return accepted; }, fetchJson: async (url, options = {}) => {
    calls.push({ url, ...options }); const custom = handler?.(url, options); if (custom !== undefined) return custom;
    if (options.method === 'POST') {
      if (url.endsWith('/candidate')) {
        const target = saved.targets.find(v => v.id === options.body.targetId);
        saved.candidates.push({ id: 'candidate-1', kind: 'global-wiki-candidate-v1', targetId: target.id, target, versionId: options.body.versionId,
          entryIds: options.body.entryIds, candidateHash: 'c'.repeat(64), candidateText: '<img src=x> proposed', diff: '--- a/target\n+++ b/target\n+<script>new</script>', status: 'draft' });
      } else if (url.endsWith('/confirm-global-candidate')) saved.candidates[0].status = 'confirmed';
      else { const e = saved.versions[1].entries[0]; Object.assign(e, options.body.patch); if (options.body.decision) e.status = options.body.decision; }
      saved.revision++;
    }
    return JSON.parse(JSON.stringify(saved));
  } });
  const el = name => root.querySelector(`[data-wiki-${name}]`);
  return { root, panel, calls, confirms, el, window: dom.window, accept: value => { accepted = value; },
    posts: () => calls.filter(c => c.method === 'POST'), field: name => root.querySelector(`[name="${name}"]`),
    click: async action => { root.querySelector(`[data-action="${action}"]`).click(); await tick(); } };
}
test('load GETs only the global endpoint; coverage and ALL source cases including holdout render as text', async t => {
  const h = setup(t); await h.panel.load();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/api/wikiskill'); assert.equal(h.posts().length, 0);
  assert.match(h.root.textContent, /训练用例 2 条；已归类 1 条；未归类 1 条/); assert.match(h.root.textContent, /missing context/);
  for (const literal of ['source-project', 'source-room', 'source-message', 'test-room', 'another-project', 'run checks', '<script>bad', '留出', '纯文本']) assert.ok(h.root.textContent.includes(literal));
  assert.equal(h.el('cases').children.length, 2); assert.equal(h.root.querySelector('img,script'), null);
  assert.equal(h.el('versions').options.length, 2); assert.equal(h.el('versions').value, 'wiki-3'); assert.equal(h.field('guideline').disabled, false);
});
test('sealed representative tasks show their split/category/commit without pretending the historical text has a worktree', async t => {
  const h = setup(t, () => ({ ...data(), replayCases: [{ sourceCaseId: 'held-out', task: '<img src=x> Write steps.', category: 'reproduction', split: 'test', fixture: { commit: 'fixed-fixture-commit' }, request: { association: { checkpointId: 'sealed-checkpoint' } } }] }));
  await h.panel.load();
  assert.match(h.el('case-count').textContent, /2 条来源 · 1 道封存题/);
  assert.match(h.el('cases').textContent, /同类封存任务 · 汇报复现题 · 留出/);
  assert.match(h.el('cases').textContent, /不是原历史现场/);
  assert.match(h.el('cases').textContent, /fixed-fixture-commit[\s\S]*sealed-checkpoint/);
  assert.match(h.el('cases').textContent, /纯文本来源/);
  assert.equal(h.root.querySelector('img'), null); assert.equal(h.posts().length, 0);
});
test('save is draft only; approval requires confirmation and freezes the saved prose', async t => {
  const h = setup(t); await h.panel.load(); h.field('guideline').value = '逐项核验后报告。'; await h.click('save');
  assert.equal(h.posts().length, 1); assert.equal(h.posts()[0].body.expectedRevision, 3); assert.equal(h.posts()[0].body.decision, undefined);
  assert.equal(h.field('guideline').disabled, false);
  h.accept(false); await h.click('approved'); assert.equal(h.posts().length, 1);
  h.accept(true); await h.click('approved'); assert.equal(h.posts().length, 2); assert.equal(h.posts()[1].body.expectedRevision, 4);
  assert.equal(h.posts()[1].body.decision, 'approved'); assert.equal(h.posts()[1].body.confirmed, true);
  assert.equal(h.field('guideline').disabled, true); assert.match(h.el('status').textContent, /未修改 prompt 或启动评测/);
  assert.equal(h.calls.every(c => /^\/api\/wikiskill(?:\/review)?$/.test(c.url)), true);
});
test('reviewed versions stay immutable; version selection never hides global/holdout cases', async t => {
  const h = setup(t); await h.panel.load();
  h.el('versions').value = 'wiki-2'; h.el('versions').dispatchEvent(new h.window.Event('change'));
  assert.equal(h.field('guideline').disabled, true); await h.click('save'); assert.equal(h.posts().length, 0);
  assert.equal(h.el('cases').children.length, 2);
  h.el('versions').value = 'wiki-3'; h.el('versions').dispatchEvent(new h.window.Event('change')); await h.click('rejected');
  assert.equal(h.posts()[0].body.decision, 'rejected'); assert.equal(h.field('guideline').disabled, true);
});
test('invalid guideline never posts; failed write keeps draft and disables writes until refresh', async t => {
  const h = setup(t, (url, options) => { if (options.method === 'POST') throw Error('private-error'); }); await h.panel.load();
  for (const text of ['', '字'.repeat(301)]) { h.field('guideline').value = text; await h.click('save'); assert.equal(h.posts().length, 0); }
  h.field('guideline').value = '本地尚未保存'; await h.click('save');
  assert.equal(h.posts().length, 1); assert.equal(h.field('guideline').value, '本地尚未保存'); assert.equal(h.field('guideline').disabled, true);
  assert.match(h.el('status').textContent, /未自动重试/); assert.doesNotMatch(h.root.textContent, /private-error/);
  h.el('refresh').click(); await tick(); assert.equal(h.field('guideline').disabled, false);
});
test('stale GET and review responses after a reload cannot overwrite the new collection', async t => {
  const read = deferred(), post = deferred(); let gets = 0;
  const h = setup(t, (url, options) => options.method === 'POST' ? post.promise : (++gets === 1 ? read.promise : data()));
  const first = h.panel.load(); await h.panel.load(); read.resolve({ ...data(), scope: 'wrong' }); await first;
  assert.equal(h.field('guideline').disabled, false);
  await h.click('save'); await h.click('save'); assert.equal(h.posts().length, 1);
  await h.panel.load(); post.resolve({ ...data(), versions: [] }); await tick();
  assert.equal(h.field('guideline').disabled, false); assert.doesNotMatch(h.el('status').textContent, /保存失败/);
});
test('project-scoped data or failed GET leaves review unavailable', async t => {
  for (const handler of [() => ({ ...data(), scope: undefined, projectId: 'foreign' }), () => { throw Error('raw failure'); }]) {
    const h = setup(t, handler); await h.panel.load();
    assert.match(h.el('status').textContent, /读取失败/); assert.equal(h.root.querySelector('[data-action]'), null); assert.equal(h.posts().length, 0);
  }
});
test('fixed holdout counts are disclosed without claiming text cases are replayable', async t => {
  for (const small of [false, true]) {
    const h = setup(t, () => ({ ...data(), replaySplit: { trainCaseIds: ['c1', 'c2', 'c3', 'c4'], testCaseIds: small ? [] : ['c5', 'c6'], insufficientSamples: small } }));
    await h.panel.load();
    assert.match(h.el('split-info').textContent, small ? /不足6条，无独立留出集/ : /训练 4 条，留出 2 条/);
    assert.match(h.el('split-info').textContent, /不代表已产生可回放封存/); assert.equal(h.posts().length, 0);
  }
});
test('WikiSkill is a standalone navigation destination; projects contains only capture, not wiki/evaluation controls', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../../public/' + file), 'utf8');
  for (const page of ['index', 'personas', 'skills', 'projects', 'metrics', 'wikiskill']) assert.match(read(page + '.html'), /href="\/wikiskill.html"/);
  assert.doesNotMatch(read('projects.html') + read('projects.js'), /badcase-wiki|badcase-evaluation|wikiPanel|evaluationPanel/);
  assert.match(read('wikiskill.html'), /aria-current="page" href="\/wikiskill.html"/);
  const dom = new JSDOM(read('wikiskill.html'));
  assert.equal(dom.window.document.querySelectorAll('.rail-link[aria-current="page"]').length, 1); dom.window.close();
  assert.match(read('wikiskill.js'), /panel.load\(\)/); assert.doesNotMatch(read('wikiskill.js'), /projectId|api\/projects/);
});

test('candidate controls show both targets but disable generation until approved entries are selected', async t => {
  const h = setup(t); await h.panel.load();
  assert.equal(h.el('targets').options.length, 2); assert.equal(h.el('generate').disabled, true);
  assert.equal(h.el('candidate-entries').querySelectorAll('input').length, 0);
  h.el('versions').value = 'wiki-2'; h.el('versions').dispatchEvent(new h.window.Event('change'));
  const box = h.el('candidate-entries').querySelector('input'); assert.ok(box); assert.equal(box.checked, false);
  box.click(); assert.equal(h.el('generate').disabled, false);
  h.el('targets').value = 'tool-description-list_rooms'; h.el('targets').dispatchEvent(new h.window.Event('change'));
  assert.match(h.el('target-info').textContent, /工具 list_rooms 的说明.*本期不要求评测结论/);
  assert.match(h.el('target-base').textContent, /List Rooms/);
  h.accept(false); h.el('generate').click(); await tick(); assert.equal(h.posts().length, 0);
  h.accept(true); h.el('generate').click(); await tick();
  assert.equal(h.posts().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts()[0].body)), { confirmed: true, expectedRevision: 3, versionId: 'wiki-2', entryIds: ['entry-1'], targetId: 'tool-description-list_rooms' });
  assert.equal(h.posts()[0].url, '/api/wikiskill/candidate');
  assert.match(h.el('candidates').textContent, /<img src=x> proposed/); assert.doesNotMatch(h.el('candidates').textContent, /\+<script>new<\/script>|\+\+\+ b\/target|No newline/);
  assert.equal(h.root.querySelector('img,script'), null);
  assert.equal(h.el('candidates').querySelector('[data-wiki-confirm-candidate]').disabled, false);
  assert.match(h.el('status').textContent, /草稿.*未.*评测/);
});
test('candidate confirmation binds displayed hash and current revision; confirmation itself never runs a comparison', async t => {
  const h = setup(t); await h.panel.load(); h.el('versions').value = 'wiki-2'; h.el('versions').dispatchEvent(new h.window.Event('change'));
  h.el('candidate-entries').querySelector('input').click(); h.el('generate').click(); await tick();
  h.accept(false); h.el('candidates').querySelector('[data-wiki-confirm-candidate]').click(); await tick(); assert.equal(h.posts().length, 1);
  h.accept(true); h.el('candidates').querySelector('[data-wiki-confirm-candidate]').click(); await tick();
  assert.equal(h.posts().length, 2); assert.equal(h.posts()[1].url, '/api/wikiskill/confirm-global-candidate');
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts()[1].body)), { confirmed: true, candidateId: 'candidate-1', candidateHash: 'c'.repeat(64), expectedRevision: 4 });
  assert.match(h.el('candidates').textContent, /已确认/); assert.equal(h.el('candidates').querySelector('[data-wiki-confirm-candidate]').disabled, true);
  assert.match(h.el('status').textContent, /未启动评测/);
  assert.equal(h.calls.some(c => /compare|start/.test(c.url)), false);
});
test('candidate unknown write result disables all writes until refresh and does not retry', async t => {
  const h = setup(t, (url, options) => { if (url.endsWith('/candidate')) throw Error('private-filesystem-path'); });
  await h.panel.load(); h.el('versions').value = 'wiki-2'; h.el('versions').dispatchEvent(new h.window.Event('change'));
  h.el('candidate-entries').querySelector('input').click(); h.el('generate').click(); await tick();
  assert.equal(h.posts().length, 1); assert.equal(h.el('generate').disabled, true);
  assert.match(h.el('status').textContent, /结果未知.*刷新/); assert.doesNotMatch(h.root.textContent, /private-filesystem-path/);
  h.el('generate').click(); await tick(); assert.equal(h.posts().length, 1);
  await h.panel.load(); assert.equal(h.el('targets').disabled, false);
});
test('pending candidate writes cannot be repeated and stale responses cannot replace refreshed data', async t => {
  const post = deferred();
  const h = setup(t, (url, options) => options.method === 'POST' ? post.promise : undefined);
  await h.panel.load(); h.el('versions').value = 'wiki-2'; h.el('versions').dispatchEvent(new h.window.Event('change'));
  h.el('candidate-entries').querySelector('input').click(); h.el('generate').click(); h.el('generate').click(); await tick();
  assert.equal(h.posts().length, 1); assert.equal(h.el('targets').disabled, true); assert.equal(h.el('versions').disabled, true);
  await h.panel.load(); post.resolve({ ...data(), versions: [], candidates: [] }); await tick();
  assert.equal(h.el('versions').options.length, 2); assert.equal(h.el('targets').disabled, false);
  assert.doesNotMatch(h.el('status').textContent, /草稿已保存/);
});
test('result view shows per-case/run and overall/category/holdout scores, with errors and not-run separate; no execution controls', async t => {
  const totals = { original: { passed: 1, planned: 3, failed: 1, errors: 1, notRun: 0, scored: 2, passRate: .5 }, candidate: { passed: 0, planned: 3, failed: 0, errors: 0, notRun: 3, scored: 0, passRate: null } };
  const h = setup(t, () => ({ ...data(), comparisons: [{ id: 'comparison-a', createdAt: '2026-10-31T00:00:00Z', candidate: { id: 'candidate-a', targetId: 'global-harness-behavior-v1', candidateHash: 'c'.repeat(64) }, planHash: 'p'.repeat(64), completed: false, model: 'deepseek/deepseek-v4-flash', modelCallsKnown: 2, callsUnavailable: true,
    totals, bySplit: { train: totals, test: totals }, byCategory: { reproduction: totals, probe: totals, control: totals }, disclosures: ['fewer_than_6_prepared_replays'],
    cases: [{ sourceCaseId: '<img src=x>', split: 'test', category: 'reproduction', status: 'error', reason: 'run_evidence_unavailable', totals, runs: [{ variant: 'original', iteration: 1, status: 'error', reason: 'run_evidence_unavailable', cleaned: true }] }] }] }));
  await h.panel.load();
  const text = h.el('results').textContent;
  for (const literal of ['总体', '训练', '留出', '复现题', '接口膨胀探针', '控制题', '1/3', '50.0%', 'N/A', '错误', '未运行', '不完整', '只复现了汇报难懂一类', '选择偏差', '<img src=x>', 'candidate-a', 'comparison-a', 'run_evidence_unavailable']) assert.ok(text.includes(literal), literal);
  assert.equal(h.el('results').querySelector('button,input,img,script'), null); assert.equal(h.posts().length, 0);
});
test('empty results explicitly exclude old screenings, and failed reload clears stale score claims', async t => {
  let fail = false;
  const h = setup(t, () => { if (fail) throw Error('private failure'); return data(); }); await h.panel.load();
  assert.match(h.el('results').textContent, /尚未.*全局提示词.*历史筛选/);
  fail = true; await h.panel.load(); assert.doesNotMatch(h.el('results').textContent, /1\/3|50.0%/); assert.match(h.el('results').textContent, /尚未读取/);
});
test('deprecated wrong-tool candidates retain readable prose but cannot be confirmed or mistaken for a draft', async t => {
  const d = data(); d.candidates = [{ id: 'old-list-rooms', kind: 'global-wiki-candidate-v1', target: d.targets[1], targetId: d.targets[1].id, versionId: 'wiki-2', entryIds: ['entry-1'], candidateHash: 'c'.repeat(64), candidateText: 'Retained old prose', diff: '+Retained diff', status: 'deprecated', deprecationReason: 'wrong_tool_target' }];
  const h = setup(t, () => d); await h.panel.load();
  assert.match(h.el('candidates').textContent, /已废弃/); assert.match(h.el('candidates').textContent, /工具用途/);
  assert.match(h.el('candidates').textContent, /Retained old prose/); assert.doesNotMatch(h.el('candidates').textContent, /Retained diff/);
  const button = h.el('candidates').querySelector('[data-wiki-confirm-candidate]'); assert.ok(button.disabled); button.click(); await tick(); assert.equal(h.posts().length, 0);
  assert.ok(h.el('candidates').querySelector('.wiki-candidate-card.is-deprecated'));
});
test('legacy role candidates are not offered for new target confirmation', async t => {
  const h = setup(t, () => ({ ...data(), candidates: [{ id: 'legacy-role', role: 'GPT', status: 'draft' }] }));
  await h.panel.load(); assert.equal(h.el('candidates').querySelector('button'), null); assert.doesNotMatch(h.el('candidates').textContent, /legacy-role/);
});

test('first-time progress and candidate comparison explain the next action without unified diff or technical-id clutter', async t => {
  const d = data(), approved = d.versions[0].entries[0];
  d.versions = [{ ...d.versions[0], entries: [approved], caseIds: ['c1'] }];
  d.candidates = [{ id: 'candidate-readable', kind: 'global-wiki-candidate-v1', target: d.targets[0], targetId: d.targets[0].id,
    versionId: 'wiki-2', entryIds: ['entry-1'], candidateHash: 'c'.repeat(64),
    candidateText: d.targets[0].baseText + '\n\nWikiSkill 已审核准则：\n- 先核验后结论。',
    diff: '--- a/target\n+++ b/target\n@@ -1 +1 @@\n\\ No newline at end of file', status: 'draft' }];
  const h = setup(t, () => d); await h.panel.load();
  assert.match(h.el('progress-text').textContent, /1 条准则已通过 → 请确认全局提示词候选 → 然后开始对照评测/);
  const candidates = h.el('candidates'), text = candidates.textContent;
  for (const literal of ['全局系统提示词（所有 agent 共用）', '原文', '候选', '新增 1 条准则', '先核验后结论。', '来源：Earlier approved', '1 条关联用例', '7 道题', '原版本与候选各 3 次', '不会直接启动评测']) assert.ok(text.includes(literal), literal);
  for (const marker of ['--- a/target', '+++ b/target', '@@ -1', 'No newline']) assert.equal(text.includes(marker), false, marker);
  assert.equal(candidates.querySelector('[data-wiki-original]').open, false);
  assert.equal(candidates.querySelector('[data-wiki-candidate-base]').open, false);
  const caseSummary = h.el('cases').querySelector('summary');
  assert.match(caseSummary.textContent, /no evidence/); assert.match(caseSummary.textContent, /来源房间：source-r…/);
  assert.doesNotMatch(caseSummary.textContent, /text-|source-room|source-message/);
  const source = candidates.querySelector('[data-wiki-source-entry="entry-1"]'); assert.ok(source);
  source.click();
  const entry = h.el('entries').querySelector('[data-wiki-entry-card="entry-1"]'); assert.equal(entry.open, true);
  assert.match(entry.querySelector('summary').textContent, /Earlier approved.*1 条关联用例/);
  assert.equal(h.posts().length, 0);
});

test('candidate target labels use plain language and comparison stacks on narrow screens', async t => {
  const h = setup(t); await h.panel.load();
  assert.equal(h.el('targets').options[0].textContent, '全局系统提示词（所有 agent 共用）');
  assert.equal(h.el('targets').options[1].textContent, '工具 list_rooms 的说明');
  const css = fs.readFileSync(path.resolve(__dirname, '../../public/wikiskill.css'), 'utf8');
  assert.match(css, /@media\s*\(max-width:/); assert.match(css, /grid-template-columns:\s*1fr/);
});
