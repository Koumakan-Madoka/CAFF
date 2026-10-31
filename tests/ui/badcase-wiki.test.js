const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function data() {
  const entry = { id: 'entry-1', title: '<img src=x>', failureMode: 'unsupported claims', symptoms: 'no checks', rootCauseHypothesis: 'skipped verification', guideline: '先核验后结论。', caseIds: ['c1'], status: 'draft' };
  return { schemaVersion: 1, scope: 'global', revision: 3, cases: [
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
    if (options.method === 'POST') { const e = saved.versions[1].entries[0]; Object.assign(e, options.body.patch); if (options.body.decision) e.status = options.body.decision; saved.revision++; }
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
  assert.match(h.el('case-count').textContent, /2 条来源用例，1 条同类任务封存/);
  assert.match(h.el('cases').textContent, /同类任务 · 可回放封存 · 汇报复现题 · 留出/);
  assert.match(h.el('cases').textContent, /不是原历史现场/);
  assert.match(h.el('cases').textContent, /fixed-fixture-commit.*sealed-checkpoint/);
  assert.match(h.el('cases').textContent, /纯文本 · 缺现场/);
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
