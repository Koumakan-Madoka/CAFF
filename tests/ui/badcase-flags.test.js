const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const vm = require('node:vm');
const publicFile = name => fs.readFileSync(path.resolve(__dirname, '../../public', name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const scope = (messageId = 'm1') => ({ projectId: 'p1', conversationId: 'c1', messageId });
const flag = (overrides = {}) => ({ ...scope(), flagId: 'flag-one', actual: '实际问题', expected: '期望行为',
  checkpointState: 'not_recorded', sealState: 'pending', captured: false, runnable: false, reproduced: false, evaluable: false, ...overrides });
function setup(t, handler) {
  const dom = new JSDOM('<dialog id="panel"></dialog>', { runScripts: 'outside-only', url: 'http://localhost/' });
  t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('dialog');
  root.showModal = () => { root.open = true; };
  root.close = () => { root.open = false; root.dispatchEvent(new dom.window.Event('close')); };
  dom.window.eval(publicFile('shared/badcase-flags.js'));
  const calls = [], confirms = [];
  let accepted = true;
  const panel = dom.window.CaffShared.createBadcaseFlagPanel({ root,
    confirm: text => { confirms.push(text); return accepted; },
    fetchJson: async (url, options = {}) => {
      calls.push({ url, ...options });
      const custom = handler?.(url, options); if (custom !== undefined) return custom;
      if (url === '/api/bootstrap') return { localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-csrf' } } };
      return options.method === 'POST' ? { created: true, flag: flag() } : { flag: null };
    } });
  const button = action => root.querySelector(`[data-flag-action="${action}"]`);
  const field = name => root.querySelector(`[name="${name}"]`);
  return { panel, root, calls, confirms, button, field, window: dom.window,
    posts: () => calls.filter(c => c.method === 'POST'), accept: value => { accepted = value; },
    fill: () => { field('actual').value = '实际问题'; field('expected').value = '期望行为'; },
    click: async action => { button(action).click(); await tick(); } };
}
test('automatic sealing has no second confirmation; failed seal retries original annotation without another prompt', async t => {
  let attempts = 0;
  const incomplete = { state: 'saved_incomplete', checkpointSaved: true, flagId: 'flag-one', association: scope(),
    complete: false, captured: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false };
  const h = setup(t, (url, options) => options.method === 'POST' ? { flag: flag(), seal: ++attempts === 1
    ? { ...incomplete, state: 'failed', checkpointSaved: false, reason: 'seal_quota_exceeded' } : incomplete } : undefined);
  await h.panel.open(scope()); h.fill(); await h.click('submit');
  assert.equal(h.confirms.length, 1); assert.match(h.confirms[0], /自动保存已有现场/);
  assert.match(h.root.textContent, /现场保存失败/); assert.equal(h.field('actual').readOnly, true);
  assert.equal(h.button('submit').disabled, false); assert.match(h.button('submit').textContent, /重试/);
  await h.click('submit'); assert.equal(h.confirms.length, 1); assert.equal(h.posts().length, 2);
  assert.deepEqual(h.posts()[0].body, h.posts()[1].body);
  assert.match(h.root.textContent, /现场已保存.*材料不完整/); assert.equal(h.button('submit').disabled, true);
});
test('missing association is displayed as unavailable, not eternally pending or complete', async t => {
  const h = setup(t, url => url.endsWith('badcase-flag') ? { flag: flag(), seal: { state: 'unavailable', reason: 'flag_seal_association_incomplete', checkpointSaved: false,
    complete: false, captured: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false } } : undefined);
  await h.panel.open(scope()); assert.match(h.root.textContent, /无法封存/);
  assert.doesNotMatch(h.root.textContent, /已标记.*待封存/); assert.equal(h.posts().length, 0);
});
test('a saved-case response for another marker or claiming completeness is rejected', async t => {
  for (const override of [{ flagId: 'wrong' }, { complete: true }, { association: scope('wrong') }]) {
    const h = setup(t, url => url.endsWith('badcase-flag') ? { flag: flag(), seal: { state: 'saved_incomplete', checkpointSaved: true, flagId: 'flag-one', association: scope(),
      complete: false, captured: false, runnable: false, reproduced: false, evaluable: false, strictEvalEligible: false, ...override } } : undefined);
    await h.panel.open(scope()); assert.match(h.root.textContent, /读取失败/); assert.doesNotMatch(h.root.textContent, /现场已保存/);
  }
});
test('open is read-only; confirm cancel sends no POST; submit sends annotations only with CSRF', async t => {
  const h = setup(t); await h.panel.open(scope()); h.fill();
  assert.equal(h.posts().length, 0); assert.equal(h.root.open, true);
  h.accept(false); await h.click('submit'); assert.equal(h.posts().length, 0);
  h.accept(true); await h.click('submit');
  assert.equal(h.posts().length, 1);
  assert.equal(h.posts()[0].url, '/api/projects/p1/conversations/c1/messages/m1/badcase-flag');
  assert.deepEqual(JSON.parse(JSON.stringify(h.posts()[0].body)), { confirmed: true, actual: '实际问题', expected: '期望行为' });
  assert.equal(h.posts()[0].headers['X-CAFF-CSRF-Token'], 'test-csrf');
  assert.match(h.confirms[0], /m1/); assert.match(h.confirms[0], /不可修改/);
  assert.match(h.root.textContent, /已标记.*待封存/); assert.match(h.root.textContent, /缺现场/);
  assert.equal(h.field('actual').readOnly, true); assert.equal(h.button('submit').disabled, true);
});
test('existing marker is immutable, shown as text, and queried again after reopening', async t => {
  const h = setup(t, url => url.endsWith('badcase-flag') ? { flag: flag({ actual: '<img src=x onerror=alert(1)>', checkpointState: 'manifest_present_unverified' }) } : undefined);
  await h.panel.open(scope());
  assert.equal(h.field('actual').value, '<img src=x onerror=alert(1)>'); assert.equal(h.root.querySelector('img'), null);
  assert.match(h.root.textContent, /清单存在但未验证/); assert.equal(h.button('submit').disabled, true);
  h.panel.close(); await h.panel.open(scope()); assert.equal(h.calls.filter(c => c.url.endsWith('badcase-flag')).length, 2);
  assert.equal(h.posts().length, 0);
});
test('pending double click sends once; same-text retry can converge after an uncertain transport failure', async t => {
  const wait = deferred(); let attempt = 0;
  const h = setup(t, (url, options) => options.method === 'POST' ? (++attempt === 1 ? wait.promise : { created: false, flag: flag() }) : undefined);
  await h.panel.open(scope()); h.fill(); await h.click('submit'); await h.click('submit');
  assert.equal(h.posts().length, 1);
  wait.resolve(Promise.reject(new Error('connection lost'))); await tick();
  assert.match(h.root.textContent, /结果可能已落盘/); assert.equal(h.field('actual').value, '实际问题');
  await h.click('submit'); assert.equal(h.posts().length, 2); assert.match(h.root.textContent, /已标记.*待封存/);
});
test('load failure or missing management capability fails closed without mutation', async t => {
  for (const handler of [
    url => url === '/api/bootstrap' ? { localAdmin: {} } : undefined,
    url => url === '/api/bootstrap' ? { localAdmin: { modelProviders: { enabled: true } } } : undefined,
    url => { if (url.endsWith('badcase-flag')) throw new Error('read failed'); },
  ]) {
    const h = setup(t, handler); await h.panel.open(scope()); h.fill(); await h.click('submit');
    assert.equal(h.button('submit').disabled, true); assert.equal(h.posts().length, 0);
  }
});
test('empty, NUL and UTF-8 over-limit annotations do not submit', async t => {
  const h = setup(t); await h.panel.open(scope());
  for (const value of ['', '  ', 'a\0b', '中'.repeat(2731)]) {
    h.fill(); h.field('actual').value = value; await h.click('submit');
    assert.equal(h.posts().length, 0); assert.match(h.root.textContent, /8192/);
  }
});
test('business and parser errors remain plain text, preserve drafts, and never show success', async t => {
  for (const failure of [Object.assign(new Error('rejected'), { issues: [{ code: '<img src=x>' }] }), Object.assign(new Error('invalid JSON'), { status: 400 }), Object.assign(new Error('too large'), { status: 413 })]) {
    const h = setup(t, (url, options) => { if (options.method === 'POST') throw failure; });
    await h.panel.open(scope()); h.fill(); await h.click('submit');
    assert.match(h.root.textContent, /提交失败/); assert.doesNotMatch(h.root.textContent, /已标记 ·/);
    assert.equal(h.field('actual').value, '实际问题'); assert.equal(h.root.querySelector('img'), null);
  }
});
test('message switching and A-B-A selection discard stale GET and POST responses', async t => {
  const oldGet = deferred(), oldPost = deferred(); let gets = 0;
  const h = setup(t, (url, options) => {
    if (options.method === 'POST') return oldPost.promise;
    if (url.endsWith('/m1/badcase-flag') && ++gets === 1) return oldGet.promise;
  });
  const first = h.panel.open(scope()); await tick();
  await h.panel.open(scope('m2')); await h.panel.open(scope());
  oldGet.resolve({ flag: flag({ actual: 'OLD' }) }); await first;
  assert.equal(h.field('actual').value, ''); assert.equal(h.button('submit').disabled, false);
  h.fill(); await h.click('submit'); await h.panel.open(scope('m2'));
  oldPost.resolve({ created: true, flag: flag() }); await tick();
  assert.equal(h.field('actual').value, ''); assert.equal(h.button('submit').disabled, false);
  assert.match(h.root.textContent, /m2/); assert.doesNotMatch(h.root.textContent, /已标记 ·/);
});
test('close and conversation switch invalidate in-flight work; reopen does not inherit draft', async t => {
  const wait = deferred(); const h = setup(t, (url, options) => options.method === 'POST' ? wait.promise : undefined);
  await h.panel.open(scope()); h.fill(); await h.click('submit');
  h.panel.syncConversation({ id: 'c2', projectScopeId: 'p1' }); assert.equal(h.root.open, false);
  await h.panel.open(scope()); wait.resolve({ created: true, flag: flag() }); await tick();
  assert.equal(h.field('actual').value, ''); assert.equal(h.button('submit').disabled, false);
  h.root.dispatchEvent(new h.window.Event('cancel', { cancelable: true })); assert.equal(h.root.open, false);
});
test('queued close from the previous dialog must not reset a reopened message', async t => {
  const h = setup(t);
  const queued = [];
  // Model the browser task queue explicitly, without a timing/sleep race.
  h.root.close = () => { h.root.open = false; queued.push(() => h.root.dispatchEvent(new h.window.Event('close'))); };
  await h.panel.open(scope()); h.fill(); h.panel.close();
  assert.equal(queued.length, 1);
  await h.panel.open(scope('m2')); h.fill();
  queued.shift()();
  assert.equal(h.root.open, true); assert.match(h.root.textContent, /消息 m2/);
  assert.equal(h.field('actual').value, '实际问题');
  assert.equal(h.button('submit').disabled, false);
  assert.equal(h.calls.length, 4); assert.equal(h.posts().length, 0);
  // A genuinely closed dialog must still reset; ignoring all close events is
  // not a valid implementation of the guard.
  h.root.close(); queued.shift()();
  assert.equal(h.root.open, false); assert.equal(h.field('actual').value, '');
  assert.equal(h.button('submit').disabled, true);
});
test('response after close cannot repopulate the closed dialog or start another request', async t => {
  const post = deferred();
  const h = setup(t, (url, options) => options.method === 'POST' ? post.promise : undefined);
  await h.panel.open(scope()); h.fill(); await h.click('submit'); await h.click('close');
  post.resolve({ created: true, flag: flag() }); await tick();
  assert.equal(h.root.open, false); assert.equal(h.field('actual').value, '');
  assert.equal(h.root.querySelector('[data-flag-notice]').textContent, '');
  assert.equal(h.root.querySelector('[data-flag-status]').textContent, '');
  const bootstrap = deferred(); const other = setup(t, () => bootstrap.promise);
  const opening = other.panel.open(scope()); other.panel.close(); bootstrap.resolve({ localAdmin: { modelProviders: { enabled: true, csrfToken: 'test-csrf' } } });
  await opening; assert.equal(other.calls.length, 1);
  assert.equal(other.root.querySelector('[data-flag-notice]').textContent, '');
});
test('mismatched records and unsupported sealing claims are rejected, not labelled captured', async t => {
  for (const record of [flag({ messageId: 'm2' }), flag({ projectId: 'p2' }), flag({ sealState: 'sealed', captured: true }), {}]) {
    const h = setup(t, url => url.endsWith('badcase-flag') ? { flag: record } : undefined);
    await h.panel.open(scope()); assert.equal(h.button('submit').disabled, true);
    assert.match(h.root.textContent, /读取失败/); assert.doesNotMatch(h.root.textContent, /已标记 ·/);
  }
});
test('old bootstrap and rejection cannot corrupt a newly opened message', async t => {
  const first = deferred(), second = deferred(); let bootstrapCalls = 0;
  const h = setup(t, url => {
    if (url === '/api/bootstrap' && ++bootstrapCalls === 1) return first.promise;
    if (url.endsWith('/m2/badcase-flag')) return second.promise;
  });
  const old = h.panel.open(scope()); await tick();
  const mid = h.panel.open(scope('m2')); await tick();
  await h.panel.open(scope('m3'));
  first.resolve({ localAdmin: {} }); second.resolve(Promise.reject(new Error('STALE ERROR')));
  await Promise.all([old, mid]);
  assert.match(h.root.textContent, /m3/); assert.doesNotMatch(h.root.textContent, /STALE|读取失败/);
  assert.equal(h.button('submit').disabled, false);
  assert.equal(h.calls.some(c => c.url.endsWith('/m1/badcase-flag')), false);
});
test('requery discovers a conflicting existing marker rather than overwriting it', async t => {
  let stored = null;
  const h = setup(t, (url, options) => {
    if (!url.endsWith('badcase-flag')) return;
    if (options.method === 'POST') { stored = flag({ actual: '另一个客户端的标记' }); throw Object.assign(new Error('conflict'), { issues: [{ code: 'flag_already_exists' }] }); }
    return { flag: stored };
  });
  await h.panel.open(scope()); h.fill(); await h.click('submit');
  assert.match(h.root.textContent, /flag_already_exists/); assert.equal(h.field('actual').value, '实际问题');
  await h.click('refresh'); assert.equal(h.field('actual').value, '另一个客户端的标记');
  assert.equal(h.button('submit').disabled, true); assert.equal(h.posts().length, 1);
});
test('unbound or invalid scope never reaches API', async t => {
  const h = setup(t);
  for (const value of [{ ...scope(), projectId: '' }, { ...scope(), messageId: '../x' }, null]) {
    await h.panel.open(value); assert.equal(h.calls.length, 0); assert.equal(h.button('submit').disabled, true);
  }
});
test('terminal assistant timeline action works without an agent profile; entry wiring uses room scope', t => {
  const dom = new JSDOM('<div id="timeline"></div>', { runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const w = dom.window, d = w.document, opened = [];
  w.CaffShared = { conversationDigest: { digestsForConversation: () => [], digestKindLabel: () => '', digestKindHelp: () => '', createDigestSourceLocator: () => ({ focusSourceMessage() {} }) } };
  w.CaffChat = { crossConversationUi: { receiptModel: () => null, provenanceModel: () => null, birthModel: () => null } };
  w.CaffIcons = { create: () => d.createElement('span') };
  w.eval(publicFile('chat/message-images.js')); w.eval(publicFile('chat/message-timeline.js'));
  const renderer = w.CaffChat.createMessageTimelineRenderer({ dom: { messageTimeline: d.querySelector('#timeline') }, showToast() {}, helpers: {
    agentById: () => null, buildAgentAvatarElement: () => d.createElement('span'), canInspectToolTrace: () => false,
    conversationSummaries: () => [], crossConversationBundleForMessage: () => null, displayedMessageBody: m => m.content,
    digestStatusForConversation: () => null, formatDateTime: () => 'now', isConversationMessageDeletionBlocked: () => false,
    isPrivateTimelineMessage: () => false, liveStageForMessage: () => null, liveStageLabel: () => '',
    messageSessionInfo: () => ({ canExport: false }), privateRecipientNames: () => [], renderMessageBody: (node, text) => { node.textContent = text; },
    timelineMessagesForConversation: c => c.messages, toolTraceSignatureForMessage: () => '', toolTraceStateForMessage: () => null,
    openBadcaseFlag: (conversationId, message) => opened.push([conversationId, message.id]),
  } });
  const messages = ['completed', 'failed', 'cancelled', 'interrupted', 'streaming', 'queued'].map(status => ({ id: status, role: 'assistant', status, content: 'text', metadata: {} }));
  messages.push({ id: 'user', role: 'user', status: 'completed', content: 'user' });
  renderer.render({ id: 'c1', messages, agents: [] }, null, []);
  const buttons = [...d.querySelectorAll('.message-badcase-button')]; assert.equal(buttons.length, 4);
  buttons[0].click(); assert.deepEqual(opened, [['c1', 'completed']]);
  const html = publicFile('index.html'), app = publicFile('app.js');
  assert.ok(html.indexOf('/shared/badcase-flags.js') < html.indexOf('/app.js'));
  assert.match(html, /id="badcase-flag-dialog"/);
  const entry = app.slice(app.indexOf('function openBadcaseFlag('), app.indexOf('const fetchFormDataJson'));
  const scopes = [], state = { currentConversation: { id: 'c1', projectScopeId: 'room-project', projectId: 'wrong-fallback' } };
  const context = { state, badcaseFlagPanel: { open: value => scopes.push(JSON.parse(JSON.stringify(value))) } };
  vm.runInNewContext(`${entry}; openBadcaseFlag('c1', {id:'m1', role:'assistant', status:'completed'}); openBadcaseFlag('other', {id:'m2', role:'assistant', status:'completed'}); openBadcaseFlag('c1', {id:'m3', role:'assistant', status:'streaming'});`, context);
  assert.deepEqual(scopes, [{ projectId: 'room-project', conversationId: 'c1', messageId: 'm1' }]);
  assert.match(app, /badcaseFlagPanel\?\.syncConversation\(state\.currentConversation\)/);
  assert.match(app, /async function loadConversation\(conversationId\) \{\s*badcaseFlagPanel\?\.close\(\)/);
});
