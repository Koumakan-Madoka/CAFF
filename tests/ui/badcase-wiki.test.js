const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function data(projectId = 'p1') {
  const entry = { id: 'entry-1', title: '<img src=x>', failureMode: 'unsupported claims', symptoms: 'no checks', rootCauseHypothesis: 'skipped verification', guideline: '先核验后结论。', caseIds: ['c1'], status: 'draft' };
  return { schemaVersion: 1, projectId, revision: 3, cases: [{ id: 'c1', kind: 'text-only', split: 'train', actual: 'no evidence', expected: 'run checks', message: '<script>bad()</script>', traceState: 'missing', traceExcerpt: '' }], versions: [
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
      const e = saved.versions[1].entries[0]; Object.assign(e, options.body.patch); if (options.body.decision) e.status = options.body.decision; saved.revision++;
    }
    return JSON.parse(JSON.stringify(saved));
  } });
  const el = name => root.querySelector(`[data-wiki-${name}]`);
  return { root, panel, calls, confirms, el, window: dom.window, accept: value => { accepted = value; },
    posts: () => calls.filter(c => c.method === 'POST'), field: name => root.querySelector(`[name="${name}"]`),
    click: async action => { root.querySelector(`[data-action="${action}"]`).click(); await tick(); } };
}

test('page load only GETs local wiki; coverage, unclassified reasons, cases and versions render as plain text', async t => {
  const h = setup(t); await h.panel.select({ id: 'p1' });
  assert.equal(h.calls.length, 1); assert.equal(h.posts().length, 0);
  assert.match(h.root.textContent, /训练用例 2 条；已归类 1 条；未归类 1 条/); assert.match(h.root.textContent, /missing context/);
  assert.match(h.root.textContent, /run checks/); assert.match(h.root.textContent, /<script>bad/); assert.equal(h.root.querySelector('img,script'), null);
  assert.equal(h.el('versions').options.length, 2); assert.equal(h.el('versions').value, 'wiki-3');
  assert.equal(h.field('guideline').value, '先核验后结论。'); assert.equal(h.field('guideline').disabled, false);
});
test('save is draft only; approval requires explicit confirmation and freezes the saved prose', async t => {
  const h = setup(t); await h.panel.select({ id: 'p1' }); h.field('guideline').value = '逐项核验后报告。'; await h.click('save');
  assert.equal(h.posts().length, 1); assert.equal(h.posts()[0].body.expectedRevision, 3); assert.equal(h.posts()[0].body.decision, undefined);
  assert.equal(h.field('guideline').disabled, false);
  h.accept(false); await h.click('approved'); assert.equal(h.posts().length, 1);
  h.accept(true); await h.click('approved'); assert.equal(h.posts().length, 2); assert.equal(h.posts()[1].body.expectedRevision, 4);
  assert.equal(h.posts()[1].body.decision, 'approved'); assert.equal(h.posts()[1].body.confirmed, true);
  assert.equal(h.field('guideline').disabled, true); assert.match(h.root.textContent, /已通过/);
  assert.match(h.el('status').textContent, /未修改 prompt 或启动评测/);
  assert.equal(h.calls.every(c => /badcase-wiki(?:\/review)?$/.test(c.url)), true);
});
test('old reviewed versions remain visible and cannot be edited or reapproved; reject freezes new drafts too', async t => {
  const h = setup(t); await h.panel.select({ id: 'p1' });
  h.el('versions').value = 'wiki-2'; h.el('versions').dispatchEvent(new h.window.Event('change'));
  assert.equal(h.field('guideline').disabled, true); await h.click('save'); assert.equal(h.posts().length, 0);
  h.el('versions').value = 'wiki-3'; h.el('versions').dispatchEvent(new h.window.Event('change')); await h.click('rejected');
  assert.equal(h.posts()[0].body.decision, 'rejected'); assert.equal(h.field('guideline').disabled, true); assert.match(h.root.textContent, /已驳回/);
});
test('oversized/empty guideline never posts; failed write preserves draft and disables mutation until refresh', async t => {
  const h = setup(t, (url, options) => { if (options.method === 'POST') throw Error('private-error'); }); await h.panel.select({ id: 'p1' });
  for (const text of ['', '字'.repeat(301)]) { h.field('guideline').value = text; await h.click('save'); assert.equal(h.posts().length, 0); }
  h.field('guideline').value = '本地尚未保存'; await h.click('save');
  assert.equal(h.posts().length, 1); assert.equal(h.field('guideline').value, '本地尚未保存'); assert.equal(h.field('guideline').disabled, true);
  assert.match(h.el('status').textContent, /未自动重试/); assert.doesNotMatch(h.root.textContent, /private-error/);
  h.el('refresh').click(); await tick(); assert.equal(h.field('guideline').disabled, false);
});
test('project switch discards stale reads and writes, including A-B-A', async t => {
  const read = deferred(), post = deferred(); let gets = 0;
  const h = setup(t, (url, options) => {
    if (options.method === 'POST') return post.promise;
    if (++gets === 1) return read.promise;
    return data(url.includes('/p2/') ? 'p2' : 'p1');
  });
  const first = h.panel.select({ id: 'p1' }); await h.panel.select({ id: 'p2' });
  await h.panel.select({ id: 'p1' }); read.resolve(data('wrong')); await first;
  assert.equal(h.field('guideline').disabled, false);
  await h.click('save'); await h.click('save'); assert.equal(h.posts().length, 1);
  await h.panel.select({ id: 'p2' }); post.resolve(data('p1')); await tick();
  assert.equal(h.field('guideline').disabled, false); assert.doesNotMatch(h.el('status').textContent, /保存失败/);
});
test('mismatched project data or failed GET leaves review unavailable', async t => {
  for (const handler of [() => data('foreign'), () => { throw Error('raw failure'); }]) {
    const h = setup(t, handler); await h.panel.select({ id: 'p1' });
    assert.match(h.el('status').textContent, /读取失败/); assert.equal(h.root.querySelector('[data-action]'), null); assert.equal(h.posts().length, 0);
  }
});
test('candidate diff/full roles render as text; only explicit confirmation binds displayed hash/revision', async t => {
  const state = data(); state.candidates = [{ id: 'candidate-1', versionId: 'wiki-2', entryIds: ['entry-1'], status: 'draft', candidateRoleHash: 'a'.repeat(64),
    baseRole: 'Original identity', candidateRole: 'Original identity\n<script>literal guideline</script>', diff: '+<img src=x> literal diff' }];
  const h = setup(t, (url, options) => {
    if (options.method === 'POST') { state.candidates[0].status = 'confirmed'; state.revision++; }
    return JSON.parse(JSON.stringify(state));
  });
  await h.panel.select({ id: 'p1' });
  assert.equal(h.posts().length, 0); assert.equal(h.el('confirm-candidate').disabled, false);
  assert.match(h.el('diff').textContent, /<img src=x>/); assert.match(h.el('candidate-role').textContent, /<script>/);
  assert.equal(h.root.querySelector('img,script'), null); assert.match(h.el('candidate-info').textContent, /待用户确认，不可评测/);
  h.accept(false); h.el('confirm-candidate').click(); await tick(); assert.equal(h.posts().length, 0);
  h.accept(true); h.el('confirm-candidate').click(); await tick();
  const post = h.posts()[0]; assert.match(post.url, /badcase-wiki\/confirm-candidate$/);
  assert.deepEqual(JSON.parse(JSON.stringify(post.body)), { confirmed: true, candidateId: 'candidate-1', candidateRoleHash: 'a'.repeat(64), expectedRevision: 3 });
  assert.equal(h.el('confirm-candidate').disabled, true); assert.match(h.el('status').textContent, /尚未运行评测/);
  h.el('confirm-candidate').click(); await tick(); assert.equal(h.posts().length, 1);
});
test('failed candidate confirmation locks writes without auto retry; stale project results are ignored', async t => {
  const candidate = { id: 'candidate-1', versionId: 'wiki-2', entryIds: ['entry-1'], status: 'draft', candidateRoleHash: 'a'.repeat(64), baseRole: 'base', candidateRole: 'candidate', diff: '+guideline' };
  const h = setup(t, (url, options) => { if (options.method === 'POST') throw Error('private'); return { ...data(), candidates: [candidate] }; });
  await h.panel.select({ id: 'p1' }); h.el('confirm-candidate').click(); await tick();
  assert.equal(h.posts().length, 1); assert.equal(h.el('confirm-candidate').disabled, true); assert.match(h.el('status').textContent, /未自动重试/);
  assert.doesNotMatch(h.root.textContent, /private/);
  const pending = deferred();
  const other = setup(t, (url, options) => options.method === 'POST' ? pending.promise : { ...data(url.includes('/p2/') ? 'p2' : 'p1'), candidates: [candidate] });
  await other.panel.select({ id: 'p1' }); other.el('confirm-candidate').click(); await tick();
  await other.panel.select({ id: 'p2' }); pending.resolve({ ...data(), candidates: [{ ...candidate, status: 'confirmed' }] }); await tick();
  assert.equal(other.el('confirm-candidate').disabled, false); assert.match(other.el('candidate-info').textContent, /待用户确认/);
});

test('projects page wires the review panel without exposing model/key/config inputs', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/projects.html'), 'utf8');
  const js = fs.readFileSync(path.resolve(__dirname, '../../public/projects.js'), 'utf8');
  assert.match(html, /shared\/badcase-wiki.js/); assert.match(html, /id="badcase-wiki-panel"/); assert.match(js, /wikiPanel.select\(selected\)/);
});
