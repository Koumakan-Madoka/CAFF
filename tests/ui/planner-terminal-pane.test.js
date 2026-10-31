const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const tick = () => new Promise(r => setImmediate(r));
function fixture(t, extra = {}) {
  const dom = new JSDOM(read('public/index.html'), { url: 'http://127.0.0.1:45678', pretendToBeVisual: true, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const changes = new Set();
  const w = dom.window, media = { matches: false, addEventListener: (_event, fn) => changes.add(fn), removeEventListener: (_event, fn) => changes.delete(fn), change: () => changes.forEach(fn => fn()) };
  w.matchMedia = () => media;
  const calls = [], connections = [], confirms = [], clients = [];
  let roomState = { available: true, processState: 'absent', sessionInitialized: true }, accept = true, hooks;
  w.CaffShared = {}; w.caffShell = { setTerminalOverlay: value => calls.push(['overlay', value]), closeDrawer() {} };
  w.eval(read('public/chat/planner-terminal-pane.js'));
  const pane = w.CaffChat.createPlannerTerminalPane({
    fetchJson: async (url, options) => {
      calls.push([url, options]);
      if (url === '/api/bootstrap') return { apiSecurity: { csrfToken: 'synthetic-csrf' }, plannerTerminal: { enabled: true, available: true } };
      if (url.endsWith('/state')) return roomState;
      if (extra.respond) return extra.respond(url,options);
      if (extra.failWrite) throw Object.assign(new Error('private sentinel'), { code: 'planner_session_unavailable' });
      return { reinitialized: true, repaired: true };
    },
    confirm: text => { confirms.push(text); return accept; },
    clientFactory: options => {
      hooks = options;
      const client = { connect: (...args) => { connections.push(args); options.onState('connecting'); }, dispose: () => calls.push(['dispose']), fit() {}, terminate: () => calls.push(['terminate']) };
      clients.push(client); return client;
    },
  });
  const q = id => w.document.getElementById('planner-terminal-' + id);
  return { w, pane, q, calls, connections, confirms, clients, media, get hooks() { return hooks; },
    state: value => { roomState = value; }, accept: value => { accept = value; } };
}

test('terminal assets are pinned/build-local with licenses, loaded before pane/app, and have a dedicated check/test suite', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@xterm/xterm'], '6.0.0'); assert.equal(pkg.dependencies['@xterm/addon-fit'], '0.11.0');
  assert.equal(pkg.dependencies['@xterm/addon-unicode-graphemes'], '0.4.0');
  const html = read('public/index.html'), build = read('scripts/copy-build-assets.js');
  for (const file of ['xterm.js', 'xterm.css', 'addon-fit.js', 'addon-unicode-graphemes.js']) assert.ok(html.includes('/vendor/planner-terminal/' + file));
  assert.ok(html.indexOf('/vendor/planner-terminal/xterm.js') < html.indexOf('/vendor/planner-terminal/addon-unicode-graphemes.js'));
  assert.ok(html.indexOf('/vendor/planner-terminal/addon-unicode-graphemes.js') < html.indexOf('/chat/planner-terminal-client.js'));
  for (const [source, target] of [['lib/addon-unicode-graphemes.js', 'addon-unicode-graphemes.js'], ['LICENSE', 'addon-unicode-graphemes-LICENSE']]) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'node_modules/@xterm/addon-unicode-graphemes', source)).equals(fs.readFileSync(path.join(ROOT, 'build/public/vendor/planner-terminal', target))));
  }
  assert.ok(html.indexOf('/vendor/planner-terminal/xterm.js') < html.indexOf('/chat/planner-terminal-client.js'));
  assert.ok(html.indexOf('/chat/planner-terminal-pane.js') < html.indexOf('/app.js'));
  assert.match(build, /@xterm/); assert.match(build, /LICENSE/);
  assert.match(pkg.scripts.check, /planner-terminal-client.js/); assert.match(pkg.scripts.check, /planner-terminal-pane.js/);
  assert.match(pkg.scripts['test:embedded-planner'], /planner-terminal-pane.test.js/);
});

test('fit measures an undecorated screen; only its outer frame owns padding and border', t => {
  const f = fixture(t);
  const style = f.w.document.createElement('style');
  // JSDOM does not resolve custom properties in border shorthands. Edge below
  // verifies the actual themed layout; here substitute only the border color.
  style.textContent = read('public/chat/planner-terminal.css').replaceAll('var(--caff-border)', '#777');
  f.w.document.head.append(style);
  const screen = f.q('screen'), frame = screen.parentElement;
  assert.ok(frame.classList.contains('planner-terminal-frame'));
  const measured = f.w.getComputedStyle(screen), decorated = f.w.getComputedStyle(frame);
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    assert.equal(measured['padding' + side], '0px');
    assert.equal(measured['border' + side + 'Width'], '0px');
    assert.equal(decorated['padding' + side], '4px');
    assert.equal(decorated['border' + side + 'Width'], '1px');
  }
  assert.equal(measured.height, '100%');
});

test('disabled entry does not read/spawn; desktop opening leaves chat usable, closing detaches/disposes without terminate', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: false });
  assert.equal(f.q('toggle').hidden, true); await f.pane.open(); assert.equal(f.connections.length, 0);
  f.pane.sync('room-a', { enabled: true, available: true }); await f.pane.open();
  assert.equal(f.q('pane').hidden, false); assert.equal(f.q('toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(f.w.document.querySelector('.main').inert, undefined);
  assert.equal(f.q('pane').hasAttribute('aria-modal'), false);
  assert.deepEqual(f.connections[0], ['room-a', 'synthetic-csrf']);
  f.pane.close(); assert.equal(f.q('pane').hidden, true); assert.equal(f.q('toggle').getAttribute('aria-expanded'), 'false');
  assert.ok(f.calls.some(x => x[0] === 'dispose')); assert.ok(!f.calls.some(x => x[0] === 'terminate'));
  assert.equal(f.w.document.activeElement, f.q('toggle'));
});

test('disconnect never auto-reconnects; manual reconnect refreshes bootstrap and switching rooms disposes without starting another', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: true }); await f.pane.open();
  f.hooks.onState('disconnected'); await tick(); assert.equal(f.connections.length, 1);
  f.q('reconnect').click(); await tick(); assert.equal(f.connections.length, 2);
  assert.equal(f.calls.filter(x => x[0] === '/api/bootstrap').length, 2);
  f.pane.sync('room-b', { enabled: true }); assert.equal(f.q('pane').hidden, true);
  assert.equal(f.connections.length, 2); assert.ok(f.calls.filter(x => x[0] === 'dispose').length >= 2);
});

test('session-unavailable recovery uses cautious fixed wording and separate confirmation, and never reconnects or inputs after recovery', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: true }); await f.pane.open();
  f.hooks.onExit({ reasonCode: 'planner_session_unavailable', exitCode: 1 });
  assert.equal(f.q('reinitialize').hidden, false); assert.match(f.q('notice').textContent, /可能不可用/);
  assert.match(f.q('notice').textContent, /保存.*消息/); assert.match(f.q('notice').textContent, /拒绝一次/);
  f.accept(false); f.q('reinitialize').click(); await tick();
  assert.equal(f.calls.filter(x => x[0].endsWith('/reinitialize')).length, 0);
  f.accept(true); f.q('reinitialize').click(); await tick();
  const write = f.calls.find(x => x[0].endsWith('/reinitialize'));
  assert.equal(write[0], '/api/conversations/room-a/planner/terminal/session/reinitialize');
  assert.deepEqual(JSON.parse(JSON.stringify(write[1])), { method: 'POST', body: { confirm: true } });
  assert.equal(f.connections.length, 1); assert.ok(f.confirms.every(x => x.includes('UUID')));
  assert.match(f.q('guidance').textContent, /Yes, I trust this folder/);
  assert.match(f.q('guidance').textContent, /原生普通拖选后，松手自动复制/);
  assert.match(f.q('guidance').textContent, /1 秒内一次、最多 64 KiB/);
  assert.match(f.q('guidance').textContent, /Shift 拖动选择/);
  assert.match(f.q('guidance').textContent, /选中后 Ctrl\+C 复制，无选中时 Ctrl\+C 中断/);
  assert.match(f.q('guidance').textContent, /Ctrl\+V 粘贴文本/);
});

for (const [code, text] of [['planner_process_exited', /Claude Code 已退出/], ['planner_process_stopped', /Claude Code 已停止/]]) {
  test(`${code} has neutral guidance and no recovery controls, even after an earlier session failure`, async t => {
    const f = fixture(t); f.pane.sync('room-a', { enabled: true }); await f.pane.open();
    f.hooks.onExit({ reasonCode: 'planner_session_unavailable', exitCode: 1 });
    assert.equal(f.q('reinitialize').hidden, false);
    f.hooks.onState('exited', code); f.hooks.onExit({ reasonCode: code, exitCode: code.endsWith('stopped') ? -1073741510 : 0 });
    f.hooks.onState('disconnected'); // Socket close must preserve the neutral reason.
    assert.equal(f.q('status').textContent, '已退出');
    assert.match(f.q('notice').textContent, text);
    assert.match(f.q('notice').textContent, /手动连接/);
    assert.doesNotMatch(f.q('notice').textContent, /暂不可用|可能不可用|检查本机配置/);
    assert.equal(f.q('repair').hidden, true); assert.equal(f.q('reinitialize').hidden, true);
    assert.equal(f.connections.length, 1);
  });
}

test('unknown exit failure retains fixed fallback instead of child output', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: true }); await f.pane.open();
  f.hooks.onExit({ reasonCode: 'synthetic_unknown_failure', exitCode: 1, message: 'private sentinel' });
  assert.match(f.q('notice').textContent, /终端暂不可用/);
  assert.doesNotMatch(f.q('notice').textContent, /private sentinel/);
  assert.equal(f.q('reinitialize').hidden, true);
});

test('uncertain lease offers a distinct user repair; corrupt metadata error renders fixed explanation without raw payload', async t => {
  const f = fixture(t, { failWrite: true });
  f.state({ available: true, processState: 'uncertain', reasonCode: 'planner_process_exit_unconfirmed' });
  f.pane.sync('room-a', { enabled: true }); await f.pane.open();
  assert.equal(f.connections.length, 0); assert.equal(f.q('repair').hidden, false);
  f.q('repair').click(); await tick();
  assert.ok(f.calls.some(x => x[0] === '/api/conversations/room-a/planner/terminal/repair'));
  assert.match(f.confirms[0], /旧.*进程/); assert.doesNotMatch(f.q('notice').textContent, /private sentinel/);
  assert.match(f.q('notice').textContent, /元数据|可能不可用/);
});

test('narrow overlay has explicit close/focus handoff; separator is keyboard operable and persisted width is bounded', async t => {
  const f = fixture(t); f.media.matches = true; f.pane.sync('room-a', { enabled: true }); await f.pane.open();
  assert.equal(f.q('pane').getAttribute('aria-modal'), 'true'); assert.ok(f.calls.some(x => x[0] === 'overlay' && x[1]));
  f.pane.close(); assert.ok(f.calls.some(x => x[0] === 'overlay' && !x[1]));
  f.media.matches = false; await f.pane.open();
  const handle = f.q('resize'); assert.equal(handle.getAttribute('role'), 'separator');
  const initial = Number(handle.getAttribute('aria-valuenow'));
  handle.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.ok(Number(handle.getAttribute('aria-valuenow')) > initial);
  handle.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.ok(Number(handle.getAttribute('aria-valuenow')) <= 900);
  assert.ok(Number(f.w.localStorage.getItem('caff:planner-terminal-width')) <= 900);
});

test('desktop-to-narrow breakpoint hands background focus into the terminal without stealing existing terminal focus', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: true }); await f.pane.open();
  f.w.document.getElementById('composer-input').focus();
  f.media.matches = true; f.media.change();
  assert.equal(f.w.document.activeElement, f.q('close'));
  const textarea = f.w.document.createElement('textarea'); f.q('screen').append(textarea); textarea.focus();
  f.media.change(); assert.equal(f.w.document.activeElement, textarea);
});

test('real shell keeps narrow terminal background inert, preserves terminal Escape, and restores nested drawer focus', async t => {
  const f = fixture(t); f.w.Element.prototype.scrollTo = () => {};
  f.media.matches = true;
  f.w.eval(read('public/shell/app-shell.js'));
  f.pane.sync('room-a', { enabled: true }); await f.pane.open();
  assert.equal(f.w.document.querySelector('.main').inert, true);
  assert.equal(f.w.document.querySelector('.rail').inert, true);
  assert.equal(f.q('pane').inert, false);
  const textarea = f.w.document.createElement('textarea'); f.q('screen').append(textarea); textarea.focus();
  textarea.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(f.q('pane').hidden, false);
  f.w.caffShell.openTab('session-goal-drawer'); assert.equal(f.w.document.getElementById('appShell').inert, true);
  f.w.caffShell.closeDrawer(); assert.equal(f.w.document.getElementById('appShell').inert, false);
  assert.equal(f.w.document.querySelector('.main').inert, true); assert.equal(f.q('pane').inert, false);
  const summary = f.w.document.querySelector('.planner-terminal-help summary');
  summary.getClientRects = f.q('close').getClientRects = () => [{ width: 44, height: 44 }];
  f.q('close').focus(); f.q('close').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  assert.equal(f.w.document.activeElement, summary);
  summary.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); assert.equal(f.w.document.activeElement, f.q('close'));
  f.q('close').focus(); f.q('close').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(f.q('pane').hidden, true); assert.equal(f.w.document.querySelector('.main').inert, false);
});

test('stale bootstrap completion cannot connect a closed or switched room', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: true });
  const pending = f.pane.open(); f.pane.sync('room-b', { enabled: true }); await pending;
  assert.equal(f.connections.length, 0); assert.equal(f.q('pane').hidden, true);
});

test('wake-up opt-in requires confirmation, shows gate/quota/user counts and never connects or injects input', async t => {
  const f=fixture(t,{respond:()=>({enabled:true})});
  f.state({available:true,processState:'absent',sessionInitialized:true,wakeupsEnabled:false,wakeupAvailable:true,wakeupReasonCode:'',pendingCount:2,needsUserCount:1,quota:{used:1,limit:4}});
  f.pane.sync('room-a',{enabled:true});await f.pane.open();
  assert.equal(f.q('wakeups').disabled,false);assert.equal(f.q('wakeups').checked,false);
  assert.match(f.q('wake-status').textContent,/1.*4/);assert.match(f.q('wake-status').textContent,/需要用户.*1/);
  f.accept(false);f.q('wakeups').click();await tick();assert.equal(f.q('wakeups').checked,false);
  assert.equal(f.calls.filter(x=>x[0].endsWith('/wakeups')&&x[1]?.method==='PUT').length,0);
  f.accept(true);f.q('wakeups').click();await tick();
  assert.ok(f.calls.some(x=>x[0]==='/api/conversations/room-a/planner/wakeups'&&x[1]?.method==='PUT'&&x[1].body.enabled));
  assert.equal(f.connections.length,1);assert.ok(f.confirms.some(x=>/额度|订阅/.test(x)));
  f.state({available:true,processState:'absent',wakeupAvailable:false,wakeupReasonCode:'planner_wakeup_tools_unverified',quota:{used:0,limit:4}});await f.pane.refresh();
  assert.match(f.q('wake-status').textContent,/未验证|重新验证/);assert.equal(f.q('wakeups').disabled,true);
});

test('unsafe settings show exact file and safe category as text, without rule contents', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: true });
  const labels = { bash_allow: 'Bash 放行规则', read_allow: 'Read/Glob/Grep 放行规则', additional_directories: 'additionalDirectories', unreadable: '读不了', invalid_json: '解析不了' };
  for (const [kind, label] of Object.entries(labels)) {
    f.state({ available: true, processState: 'absent', wakeupAvailable: false, wakeupReasonCode: 'planner_wakeup_settings_unsafe', wakeupSettingsIssue: { file: '/synthetic/<img src=x>/settings.json', kind } });
    if (kind === 'bash_allow') await f.pane.open(); else await f.pane.refresh();
    assert.match(f.q('wake-status').textContent, /叫醒设置不安全/);
    assert.ok(f.q('wake-status').textContent.includes(label));
    assert.ok(f.q('wake-status').textContent.includes('/synthetic/<img src=x>/settings.json'));
    assert.equal(f.q('wake-status').querySelector('img'), null); assert.equal(f.q('wakeups').disabled, true);
  }
});

test('wake-up records use cursor paging, render text not HTML and are cleared on room change',async t=>{
  const f=fixture(t,{respond:url=>url.endsWith('/wakeups')?{items:[{id:'attempt-a',sequence:3,status:'needs_user',summary:'<img src=x>',reservedAt:'2026-10-26'}],nextBefore:3,hasMore:true}:url.includes('before=3')?{items:[],nextBefore:null,hasMore:false}:{summary:{id:'attempt-a',status:'needs_user'},chunks:[{sequence:4,kind:'assistant',text:'<script>sentinel</script>'}],nextAfter:4,hasMore:true,truncated:true,transcriptExpired:false}});
  f.pane.sync('room-a',{enabled:true});await f.pane.open();f.q('records').click();await tick();
  assert.equal(f.q('record-list').querySelectorAll('button').length,1);assert.equal(f.q('record-list').querySelector('img'),null);
  assert.equal(f.calls.find(x=>x[0].endsWith('/wakeups'))[1]?.headers?.['X-CAFF-CSRF-Token'],'synthetic-csrf');
  f.q('record-list').querySelector('button').click();await tick();assert.match(f.q('record-output').textContent,/<script>sentinel/);assert.equal(f.q('record-output').querySelector('script'),null);
  f.q('record-next').click();await tick();assert.ok(f.calls.some(x=>x[0].includes('/wakeups/attempt-a?afterChunk=4')));
  f.q('records-next').click();await tick();assert.ok(f.calls.some(x=>x[0].includes('/wakeups?before=3')));
  f.pane.sync('room-b',{enabled:true});assert.equal(f.q('record-output').textContent,'');assert.equal(f.q('record-list').children.length,0);
});

function clientFixture(t, extra = {}) {
  const dom = new JSDOM('<div id="screen"></div>', { url: 'http://127.0.0.1:45678', runScripts: 'outside-only' }); t.after(() => dom.window.close());
  const w = dom.window, sockets = [], terminals = [], states = [], exits = [], observations = [], copies = [], notices = [];
  let toolbarFocus = 0;
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.CaffShared = { copyTextToClipboard: (text, options) => { copies.push(text); return extra.copy ? extra.copy(text, w, options) : Promise.resolve(); } };
  class Terminal {
    constructor(options) { this.options = options; this.unicode = { activeVersion: '6' }; this.cols = 120; this.rows = 30; this.output = []; this.osc = []; this.parser = { registerOscHandler: (id, fn) => { this.osc.push([id, fn]); return { dispose() {} }; } }; terminals.push(this); }
    loadAddon(addon) { this.addon = addon; addon.activate?.(this); }
    open(screen) {
      this.opened = true;
      if (extra.native) {
        this.modes = { mouseTrackingMode: 'drag' };
        this.textarea = w.document.createElement('textarea'); screen.append(this.textarea);
      }
    }
    resize(c,r) { if (r !== this.rows) this.selection = ''; this.cols = c; this.rows = r; }
    onData(fn) { this.input = fn; return { dispose: () => { this.inputDisposed = true; } }; }
    write(data, done) { this.output.push(data); done(); } dispose() { this.disposed = true; }
    attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
    hasSelection() { return !!this.selection; } getSelection() { return this.selection; }
    getSelectionPosition() { return this.range; }
    clearSelection() { this.selection = ''; this.cleared = (this.cleared || 0) + 1; }
    focus() { this.focused = (this.focused || 0) + 1; this.textarea?.focus(); }
  }
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close(code) {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) throw new Error('InvalidAccessError: invalid browser close code');
      this.closed = true; this.readyState = 3;
    }
  }
  class FitAddon { proposeDimensions() { return extra.dimensions ? extra.dimensions() : { cols: 100, rows: 35 }; } }
  class Observer { constructor(fn) { this.fn = fn; observations.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  class UnicodeAddon { activate(term) { assert.equal(term.opened, true); assert.equal(term.options.allowProposedApi, true); term.unicode.activeVersion = '15-graphemes'; } }
  w.UnicodeGraphemesAddon = { UnicodeGraphemesAddon: extra.missingUnicode ? undefined : extra.UnicodeAddon || UnicodeAddon };
  w.eval(read('public/chat/planner-terminal-client.js'));
  const client = w.CaffChat.createPlannerTerminalClient({ screen: w.document.getElementById('screen'), TerminalCtor: Terminal, FitAddonCtor: FitAddon, SocketCtor: Socket,
    ResizeObserverCtor: Observer, onState: (...args) => states.push(args), onExit: e => exits.push(e),
    onNotice: text => { notices.push(text); extra.onNotice?.(text); }, focusToolbar: () => { toolbarFocus++; } });
  t.after(() => client.dispose());
  const ready = s => s.onmessage({ data: JSON.stringify({ type: 'ready', version: 1, historyReplay: false, resumed: false }) });
  function key(term, overrides = {}) {
    const event = new w.KeyboardEvent(overrides.type || 'keydown', { key: 'c', ctrlKey: true, cancelable: true, ...overrides });
    const result = term.keyHandler(event);
    // Model xterm's control-character paths; the browser test verifies xterm itself.
    if (result && event.type === 'keydown' && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      if (event.key.toLowerCase() === 'c') term.input('\x03');
      if (event.key.toLowerCase() === 'v') term.input('\x16');
    }
    return { result, event };
  }
  return { w, client, sockets, terminals, states, exits, observations, copies, notices, ready, key, get toolbarFocus() { return toolbarFocus; } };
}

for (const key of ['v', 'V']) {
  test(`Ctrl+V keydown (${key}) yields to native paste without preventing default or sending ^V`, t => {
    const f = clientFixture(t); f.client.connect('room-a', 'synthetic');
    const term = f.terminals[0], s = f.sockets[0]; s.readyState = 1; s.onopen(); f.ready(s);
    const { result, event } = f.key(term, { key });
    assert.equal(result, false); assert.equal(event.defaultPrevented, false);
    assert.equal(s.sent.filter(x => x.type === 'input').length, 0);
    assert.deepEqual(f.copies, []); assert.equal(f.toolbarFocus, 0);
  });
}

test('native-paste key branch leaves other event types, Shift/Alt/Meta combinations and other keys alone', t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic'); const term = f.terminals[0];
  for (const overrides of [{ type: 'keyup' }, { type: 'keypress' }, { shiftKey: true, key: 'V' },
    { altKey: true }, { metaKey: true }, { ctrlKey: false, altKey: true },
    { ctrlKey: false, metaKey: true }, { ctrlKey: false }, { key: 'b' }]) {
    const { result, event } = f.key(term, { key: 'v', ...overrides });
    assert.equal(result, true, JSON.stringify(overrides)); assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(f.copies, []); assert.equal(f.toolbarFocus, 0);
});

for (const shiftKey of [false, true]) {
  test(`selected Ctrl+${shiftKey ? 'Shift+' : ''}C copies only selection without input, clears on success and restores terminal focus`, async t => {
    const f = clientFixture(t); f.client.connect('room-a', 'synthetic');
    const term = f.terminals[0], s = f.sockets[0]; s.readyState = 1; s.onopen(); f.ready(s);
    term.selection = '选中的 text\n第二行 🙂';
    const { result, event } = f.key(term, { shiftKey, key: shiftKey ? 'C' : 'c' });
    assert.equal(result, false); assert.equal(event.defaultPrevented, true);
    assert.deepEqual(f.copies, ['选中的 text\n第二行 🙂']);
    await tick();
    assert.equal(s.sent.filter(x => x.type === 'input').length, 0);
    assert.equal(term.selection, ''); assert.equal(term.cleared, 1); assert.equal(term.focused, 1);
    assert.deepEqual(f.notices, []);
    // A second Ctrl+C now interrupts instead of copying the previous selection.
    assert.equal(f.key(term).result, true);
    assert.equal(s.sent.filter(x => x.type === 'input').at(-1).data, '\x03');
  });
}

test('unselected Ctrl+C passes through to xterm; Ctrl+Shift+F6 still returns to toolbar', t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic');
  const term = f.terminals[0], s = f.sockets[0]; s.readyState = 1; s.onopen(); f.ready(s);
  const { result, event } = f.key(term);
  assert.equal(result, true); assert.equal(event.defaultPrevented, false); assert.deepEqual(f.copies, []);
  assert.equal(s.sent.filter(x => x.type === 'input').at(-1).data, '\x03');
  assert.equal(f.key(term, { key: 'F6', shiftKey: true }).result, false); assert.equal(f.toolbarFocus, 1);
});

for (const sync of [false, true]) {
  test(`clipboard ${sync ? 'throw' : 'rejection'} retains selection, never interrupts and reports fixed notice with focus restored`, async t => {
    const f = clientFixture(t, { copy: () => { if (sync) throw new Error('private sentinel'); return Promise.reject(new Error('private sentinel')); } });
    f.client.connect('room-a', 'synthetic'); const term = f.terminals[0], s = f.sockets[0]; s.readyState = 1; s.onopen(); f.ready(s);
    term.selection = 'keep this'; const { result, event } = f.key(term); await tick();
    assert.equal(result, false); assert.equal(event.defaultPrevented, true);
    assert.equal(s.sent.filter(x => x.type === 'input').length, 0);
    assert.equal(term.selection, 'keep this'); assert.equal(term.cleared, undefined); assert.equal(term.focused, 1);
    assert.match(f.notices[0], /复制失败/); assert.doesNotMatch(f.notices[0], /private sentinel/);
    assert.equal(f.states.at(-1)[0], 'attached');
  });
}

for (const reject of [false, true]) {
  test(`clipboard fallback ${reject ? 'failure' : 'success'} sends neither transient focus reports nor interrupt input`, async t => {
    let term;
    const f = clientFixture(t, { copy: async () => { term.input('\x1b[O'); if (reject) throw new Error(); } });
    f.client.connect('room-a', 'synthetic'); term = f.terminals[0]; const s = f.sockets[0]; s.readyState = 1; s.onopen(); f.ready(s);
    term.selection = 'copy'; const focus = term.focus.bind(term);
    term.focus = () => { focus(); term.input('\x1b[I'); };
    assert.equal(f.key(term).result, false); await tick();
    assert.equal(s.sent.filter(x => x.type === 'input').length, 0);
    term.input('\x1b[O'); assert.equal(s.sent.filter(x => x.type === 'input').at(-1).data, '\x1b[O');
  });
}

test('copy failure retains selection when its notice changes terminal height and xterm clears on row resize', async t => {
  let rows = 35;
  const f = clientFixture(t, { copy: async () => { throw new Error(); }, onNotice: () => { rows = 36; }, dimensions: () => ({ cols: 100, rows }) });
  f.client.connect('room-a', 'synthetic'); const term = f.terminals[0];
  term.selection = 'keep this'; term.range = { start: { x: 2, y: 1 }, end: { x: 11, y: 1 } };
  term.select = (x, y, length) => { assert.deepEqual([x, y, length], [2, 1, 9]); term.selection = 'keep this'; };
  f.key(term); await tick(); f.observations[0].fn();
  assert.equal(term.rows, 36); assert.equal(term.selection, 'keep this'); assert.equal(term.focused, 1);
});

test('only Ctrl+C keydown copies selections; keyup, Alt/Cmd combinations and ungated CLI OSC never write', async t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic'); const term = f.terminals[0]; term.selection = 'selected';
  for (const event of [{ type: 'keyup' }, { type: 'keypress' }, { altKey: true }, { metaKey: true }, { ctrlKey: false, metaKey: true }, { key: 'x' }]) {
    assert.equal(f.key(term, event).result, true);
  }
  assert.ok(term.osc.every(([, handler]) => handler('arbitrary output') === true));
  await tick(); assert.deepEqual(f.copies, []);
});

for (const reject of [false, true]) {
  test(`late clipboard ${reject ? 'failure' : 'success'} cannot focus/clear or notify a disposed/replaced terminal`, async t => {
    let settle;
    const f = clientFixture(t, { copy: () => new Promise((resolve, fail) => { settle = reject ? fail : resolve; }) });
    f.client.connect('room-a', 'synthetic'); const old = f.terminals[0]; old.selection = 'old'; f.key(old);
    f.client.connect('room-b', 'synthetic'); settle(); await tick();
    assert.equal(old.focused, undefined); assert.equal(old.cleared, undefined);
    assert.equal(f.terminals[1].focused, undefined); assert.deepEqual(f.notices, []);
  });
}

test('copy failure notice renders in pane without changing its connection status', async t => {
  const f = fixture(t); f.pane.sync('room-a', { enabled: true }); await f.pane.open(); f.hooks.onState('attached');
  f.hooks.onNotice('复制失败，请重试。');
  assert.equal(f.q('notice').textContent, '复制失败，请重试。'); assert.equal(f.q('status').textContent, '已连接');
});

test('Unicode grapheme addon is loaded after open, selects 15-graphemes, and survives manual reconnect', t => {
  const f = clientFixture(t);
  for (let i = 0; i < 2; i++) {
    f.client.connect('room-a', 'synthetic');
    assert.equal(f.terminals[i].unicode.activeVersion, '15-graphemes');
    assert.equal(f.terminals[i].options.allowProposedApi, true);
    assert.equal(f.sockets.length, i + 1);
  }
});

for (const extra of [{ missingUnicode: true }, { UnicodeAddon: class { activate() {} } }, { UnicodeAddon: class { activate() { throw new Error('private sentinel'); } } }]) {
  test('missing, inactive or broken Unicode addon fails closed before socket/auth/CLI startup', t => {
    const f = clientFixture(t, extra);
    assert.doesNotThrow(() => f.client.connect('room-a', 'synthetic'));
    assert.equal(f.sockets.length, 0);
    assert.deepEqual(f.states.at(-1), ['unavailable', 'planner_terminal_unicode_unavailable']);
    assert.ok(f.terminals.every(term => term.disposed));
  });
}

for (const code of ['planner_conpty_unavailable', 'planner_terminal_unicode_unavailable']) {
  test(`${code} displays fixed guidance without recovery or automatic retries`, async t => {
    const f = fixture(t); f.pane.sync('room-a', { enabled: true }); await f.pane.open();
    f.hooks.onState('unavailable', code);
    assert.match(f.q('notice').textContent, /ConPTY|Unicode/);
    assert.doesNotMatch(f.q('notice').textContent, /终端暂不可用/);
    assert.equal(f.q('repair').hidden, true); assert.equal(f.q('reinitialize').hidden, true);
    assert.equal(f.connections.length, 1);
  });
}

test('terminal defaults to the same dark palette in both CAFF themes and after a live theme change', async t => {
  const f = clientFixture(t);
  // Deliberately light CAFF tokens; the CLI palette must not inherit them.
  f.w.document.documentElement.style.setProperty('--caff-surface-sunk', '#fafafa');
  f.w.document.documentElement.style.setProperty('--caff-text', '#111111');
  for (const theme of ['light', 'dark']) {
    f.w.document.documentElement.dataset.theme = theme;
    f.client.connect('room-a', 'synthetic');
    const palette = f.terminals.at(-1).options.theme;
    assert.equal(palette.background, '#111312'); assert.equal(palette.foreground, '#f0f1ed');
    assert.equal(palette.cursor, palette.foreground); assert.equal(palette.cursorAccent, palette.background);
    assert.equal(palette.brightBlack, '#9a9a9a'); // Readable gray for ANSI 90 paths, not xterm's dim #555.
    f.w.document.documentElement.dataset.theme = theme === 'light' ? 'dark' : 'light';
    await tick();
    assert.deepEqual(f.terminals.at(-1).options.theme, palette);
  }
  const css = read('public/chat/planner-terminal.css');
  assert.match(css, /--planner-terminal-background:\s*#111312/);
  assert.match(css, /\.planner-terminal-screen \.xterm-viewport\s*\{\s*background(?:-color)?:\s*var\(--planner-terminal-background\)/);
});

test('client authenticates only in first message, gates input/output until ready, chunks paste and resize, and blocks OSC clipboard/links', t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic-token');
  const s = f.sockets[0], term = f.terminals[0]; assert.equal(s.url, 'ws://127.0.0.1:45678/api/conversations/room-a/planner/terminal');
  term.input('before'); assert.equal(s.sent.length, 0); s.readyState = 1; s.onopen();
  assert.equal(s.sent[0].type, 'auth'); assert.equal(s.sent[0].token, 'synthetic-token'); assert.equal(s.sent[0].cols, 100);
  term.input('before-ready'); assert.equal(s.sent.length, 1); f.ready(s);
  term.input('😀'.repeat(9000) + String.fromCharCode(0).repeat(20000));
  const inputs = s.sent.filter(x => x.type === 'input'); assert.ok(inputs.length > 1);
  assert.equal(inputs.map(x => x.data).join(''), '😀'.repeat(9000) + String.fromCharCode(0).repeat(20000));
  for (const x of inputs) assert.ok(Buffer.byteLength(JSON.stringify(x)) <= 65536);
  f.client.fit(); assert.ok(s.sent.some(x => x.type === 'resize' && x.cols === 100 && x.rows === 35));
  s.onmessage({ data: JSON.stringify({ type: 'output', data: 'live-only' }) }); assert.deepEqual(term.output, ['live-only']);
  assert.ok(term.osc.some(([id, fn]) => id === 52 && fn('clipboard') === true));
  assert.ok(term.osc.some(([id, fn]) => id === 8 && fn('url') === true));
  assert.equal(term.options.linkHandler.activate('event', 'https://evil.invalid'), undefined);
});

test('terminating disables input but drains trailing output until observed exit', t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic'); const s = f.sockets[0]; s.readyState = 1; s.onopen(); f.ready(s);
  f.client.terminate(); f.terminals[0].input('blocked');
  s.onmessage({ data: JSON.stringify({ type: 'output', data: 'shutdown-output' }) });
  assert.deepEqual(f.terminals[0].output, ['shutdown-output']); assert.equal(f.states.at(-1)[0], 'stopping');
  assert.equal(s.closed, undefined); assert.equal(s.sent.filter(x => x.type === 'input').length, 0);
  s.onmessage({ data: JSON.stringify({ type: 'exit', exitCode: 0, reasonCode: 'planner_process_exited' }) });
  assert.equal(f.states.at(-1)[0], 'exited');
});

test('client handles server rejection with a browser-valid close code and preserves its actionable diagnostic', t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic'); const s = f.sockets[0]; s.readyState = 1; s.onopen();
  assert.doesNotThrow(() => s.onmessage({ data: JSON.stringify({ type: 'error', code: 'planner_terminal_in_use' }) }));
  assert.equal(s.closed, true); assert.equal(f.states.at(-1)[1], 'planner_terminal_in_use');
});

test('client never renders pre-ready output and bounds both input/output backlog without retry', t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic'); const s = f.sockets[0]; s.readyState = 1; s.onopen();
  s.onmessage({ data: JSON.stringify({ type: 'output', data: 'pre-ready' }) });
  assert.equal(f.terminals[0].output.length, 0); assert.equal(s.closed, true);
  f.client.connect('room-a', 'synthetic'); const second = f.sockets[1]; second.readyState = 1; second.onopen(); f.ready(second);
  second.bufferedAmount = 1024 * 1024; f.terminals[1].input('must-not-buffer');
  assert.equal(second.sent.filter(x => x.type === 'input').length, 0); assert.equal(second.closed, true);
  f.client.connect('room-a', 'synthetic'); const third = f.sockets[2]; third.readyState = 1; third.onopen(); f.ready(third);
  f.terminals[2].write = () => {}; // Slow renderer never acknowledges its queued data.
  for (let i = 0; i < 65; i++) third.onmessage({ data: JSON.stringify({ type: 'output', data: 'x'.repeat(16384) }) });
  assert.equal(third.closed, true); assert.equal(f.states.at(-1)[1], 'planner_terminal_slow_consumer');
  assert.equal(f.sockets.length, 3);
});

test('client ignores stale socket/input after disposal, creates a fresh terminal on manual reconnect and disposes observers', t => {
  const f = clientFixture(t); f.client.connect('room-a', 'synthetic'); const old = f.sockets[0], term = f.terminals[0];
  old.readyState = 1; old.onopen(); f.ready(old); const dataHandler = old.onmessage;
  f.client.dispose(); term.input('stale'); dataHandler({ data: JSON.stringify({ type: 'output', data: 'stale' }) });
  assert.equal(term.disposed, true); assert.equal(old.closed, true); assert.equal(term.output.length, 0);
  assert.ok(f.observations.every(x => x.disconnected));
  f.client.connect('room-b', 'new-synthetic'); assert.equal(f.sockets.length, 2); assert.equal(f.terminals[1].output.length, 0);
});

// Unit events below are plain objects delivered to captured listeners. They
// exercise policy branches, NOT browser trust; the opt-in real-mouse suite proves
// the actual isTrusted entrance and real clipboard effects.
function nativeFixture(t, extra = {}) {
  const f = clientFixture(t, { ...extra, native: true }), w = f.w, screen = w.document.getElementById('screen');
  const handlers = new Map();
  let now = 0, visible = true, focused = true, fallbacks = 0;
  for (const [name, target] of [['screen', screen], ['window', w]]) {
    const add = target.addEventListener.bind(target);
    target.addEventListener = (type, fn, ...rest) => { handlers.set(name + ':' + type, fn); add(type, fn, ...rest); };
  }
  screen.getClientRects = () => [{ width: 900, height: 450 }];
  w.document.hasFocus = () => focused;
  Object.defineProperty(w.document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  Object.defineProperty(w.performance, 'now', { value: () => now });
  if (extra.realHelper) {
    w.eval(read('public/shared/clipboard.js'));
    Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: text => {
      f.copies.push(text); return extra.copy ? extra.copy(text, w) : Promise.resolve();
    } } });
    w.document.execCommand = () => { fallbacks++; return extra.fallbackResult !== false; };
    w.HTMLTextAreaElement.prototype.select = function () { this.focus(); };
  }
  const connect = (id = 'room-a') => {
    f.client.connect(id, 'synthetic'); const socket = f.sockets.at(-1);
    socket.readyState = 1; socket.onopen(); f.ready(socket); f.terminals.at(-1).focus();
  };
  function mouse(type, overrides = {}) {
    const event = { target: screen, isTrusted: true, button: 0, buttons: type === 'mouseup' ? 0 : 1,
      clientX: type === 'mousedown' ? 0 : 20, clientY: 0,
      preventDefault() { assert.fail('observer must not prevent mouse input'); },
      stopPropagation() { assert.fail('observer must not capture mouse input'); }, ...overrides };
    handlers.get((type === 'mousedown' ? 'screen' : 'window') + ':' + type)(event);
  }
  connect();
  return { ...f, screen, handlers, connect, mouse,
    drag(overrides = {}) { for (const type of ['mousedown', 'mousemove', 'mouseup']) mouse(type, overrides); },
    output(data) { f.sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'output', data }) }); },
    now: value => { now = value; }, visible: value => { visible = value; }, focused: value => { focused = value; },
    get fallbacks() { return fallbacks; },
  };
}
const oscCopy = text => '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07';

test('native request requires trusted ordinary drag, consumes once, preserves output/selection and never sends input', async t => {
  const f = nativeFixture(t); const request = oscCopy('中文\nsecond 🙂');
  f.output(request); assert.deepEqual(f.copies, []);
  f.drag(); f.output(request); f.output(oscCopy('duplicate'));
  await tick();
  assert.deepEqual(f.copies, ['中文\nsecond 🙂']);
  assert.deepEqual(f.terminals[0].output, [request, request, oscCopy('duplicate')]);
  assert.equal(f.terminals[0].cleared, undefined);
  assert.equal(f.sockets[0].sent.filter(x => x.type === 'input').length, 0);
  assert.ok(f.notices.some(x => x.includes('已复制')));
  for (const [id, handler] of f.terminals[0].osc) assert.equal(handler('c;?'), true, String(id));
  assert.equal(f.copies.length, 1);
});

for (const overrides of [{ isTrusted: false }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { button: 2 }, { buttons: 0 }]) {
  test('native copy refuses non-ordinary/untrusted drag ' + JSON.stringify(overrides), t => {
    const f = nativeFixture(t); f.drag(overrides); f.output(oscCopy('must not copy'));
    assert.deepEqual(f.copies, []);
  });
}

test('click, release outside screen and non-tracking terminal do not authorize native output', t => {
  const f = nativeFixture(t);
  f.mouse('mousedown'); f.mouse('mouseup'); f.output(oscCopy('click'));
  f.mouse('mousedown'); f.mouse('mousemove'); f.mouse('mouseup', { target: f.w.document.body }); f.output(oscCopy('outside'));
  f.terminals[0].modes.mouseTrackingMode = 'none'; f.drag(); f.output(oscCopy('host selection'));
  assert.deepEqual(f.copies, []);
});

for (const action of ['time', 'blur', 'focusout', 'hidden', 'inert', 'disconnect', 'error', 'exit', 'stop', 'dispose', 'replace', 'new-click', 'cancel']) {
  test('native grant is revoked or unusable after ' + action, t => {
    const f = nativeFixture(t); f.drag();
    const socket = f.sockets[0], oldOutput = socket.onmessage;
    if (action === 'time') f.now(1000);
    if (action === 'blur') f.handlers.get('window:blur')({ target: f.w });
    if (action === 'focusout') f.screen.querySelector('textarea').blur();
    if (action === 'hidden') f.visible(false);
    if (action === 'inert') f.screen.setAttribute('inert', '');
    if (action === 'disconnect') socket.onclose();
    if (action === 'error') socket.onerror();
    if (action === 'exit') oldOutput({ data: JSON.stringify({ type: 'exit', reasonCode: 'planner_process_exited' }) });
    if (action === 'stop') f.client.terminate();
    if (action === 'dispose') f.client.dispose();
    if (action === 'replace') f.connect('room-b');
    if (action === 'new-click') f.mouse('mousedown');
    if (action === 'cancel') f.handlers.get('window:pointercancel')();
    oldOutput({ data: JSON.stringify({ type: 'output', data: oscCopy('late') }) });
    assert.deepEqual(f.copies, []);
  });
}

const malformedRequests = [
  '\x1b]52;c;?\x07', '\x1b]52;p;YQ==\x07', '\x1b]52;;YQ==\x07', '\x1b]52;cp;YQ==\x07',
  '\x1b]52;c;\x07', '\x1b]52;c;YQ\x07', '\x1b]52;c;YR==\x07', '\x1b]52;c;Y Q==\x07',
  '\x1b]52;c;YQ==;Yg==\x07', '\x1b]52;c;YQ===\x07', '\x1b]52;c;/w==\x07',
  '\x1b]52;c;wK8=\x07', '\x1b]52;c;7aCA\x07', oscCopy('   \n'), oscCopy('a\x00b'),
  oscCopy('a').replace('\x07', '\x1b\\'), oscCopy('a').replace('\x1b]', '\x9d'),
  oscCopy('a').replace('\x07', '\x9c'), oscCopy('a').replace('\x07', '\x18'),
  '\x1b]8;;https://invalid.example\x07forged copied 99 chars\x1b]8;;\x07',
  '\x1bPtmux;' + oscCopy('wrapped') + '\x1b\\',
  '\x1bPtmux;\x1b' + oscCopy('double escape') + '\x1b\\',
  '\x1b_' + oscCopy('APC wrapped') + '\x1b\\',
  '\x90tmux;' + oscCopy('C1 wrapped') + '\x9c',
];
for (const [index, request] of malformedRequests.entries()) {
  test(`native rejects malformed/unsupported OSC fixture ${index} without write/query/input`, t => {
    const f = nativeFixture(t); f.drag(); f.output(request);
    assert.deepEqual(f.copies, []);
    assert.equal(f.sockets[0].sent.filter(x => x.type === 'input').length, 0);
  });
}

test('native text cap accepts 64 KiB across frames, rejects overflow and oversized prefix before decode', t => {
  const f = nativeFixture(t);
  function chunks(data) { for (let i = 0; i < data.length; i += 15000) f.output(data.slice(i, i + 15000)); }
  f.drag(); chunks(oscCopy('a'.repeat(65536))); assert.equal(f.copies[0].length, 65536);
  f.drag(); chunks(oscCopy('b'.repeat(65537))); assert.equal(f.copies.length, 1);
  let decoded = 0; const decode = f.w.atob.bind(f.w); f.w.atob = data => { decoded++; return decode(data); };
  f.drag(); chunks('\x1b]52;c;' + 'A'.repeat(200000) + '\x07');
  assert.equal(decoded, 0); assert.equal(f.copies.length, 1);
  f.output(oscCopy('next valid')); assert.equal(f.copies.at(-1), 'next valid');
});

test('native frame splits work but cannot borrow a later grant or renderer-END timing', t => {
  const f = nativeFixture(t), request = oscCopy('fixed');
  f.terminals[0].write = data => f.terminals[0].output.push(data); // xterm queue never drains.
  f.output(request); f.drag(); assert.deepEqual(f.copies, []);
  for (const cut of [1, 2, 6, request.length - 1]) {
    f.output(request.slice(0, cut)); f.drag(); f.output(request.slice(cut));
    assert.deepEqual(f.copies, [], 'pre-grant prefix at split ' + cut);
  }
  f.drag(); f.output(request.slice(0, 8)); f.drag(); f.output(request.slice(8));
  assert.deepEqual(f.copies, [], 'new gesture cannot inherit old prefix');
  f.drag(); for (const char of request) f.output(char);
  assert.deepEqual(f.copies, ['fixed']);
});

test('native window permits the first valid same-stream forgery (accepted risk), not the later genuine request', t => {
  const f = nativeFixture(t); f.drag();
  f.output(oscCopy('fixed attacker') + oscCopy('fixed selection'));
  assert.deepEqual(f.copies, ['fixed attacker']);
});

for (const action of ['disconnect', 'error', 'blur-return', 'toolbar-return', 'dispose', 'replace', 'hidden-return']) {
  test('pending native write rejection cannot fallback, focus or notify after ' + action, async t => {
    let reject;
    const f = nativeFixture(t, { realHelper: true, copy: () => new Promise((_resolve, fail) => { reject = fail; }) });
    f.drag(); f.output(oscCopy('fixed pending'));
    const old = f.terminals[0], before = old.focused;
    if (action === 'disconnect') f.sockets[0].onclose();
    if (action === 'error') f.sockets[0].onerror();
    if (action === 'blur-return') { f.handlers.get('window:blur')({ target: f.w }); old.focus(); }
    if (action === 'toolbar-return') { old.textarea.blur(); old.focus(); }
    if (action === 'dispose') f.client.dispose();
    if (action === 'replace') f.connect('room-b');
    if (action === 'hidden-return') { f.visible(false); f.w.document.dispatchEvent(new f.w.Event('visibilitychange')); f.visible(true); }
    const focusAfterAction = old.focused;
    reject(new Error('synthetic denial')); await tick();
    assert.equal(f.fallbacks, 0); assert.equal(old.focused, focusAfterAction);
    assert.deepEqual(f.notices, []); assert.equal(f.copies.length, 1);
    assert.ok(old.focused >= before);
  });
}

for (const fallbackResult of [true, false]) {
  test('native shared fallback ' + fallbackResult + ' restores only the same view and reports actual outcome', async t => {
    const f = nativeFixture(t, { realHelper: true, copy: () => Promise.reject(new Error('synthetic')), fallbackResult });
    f.drag(); f.output(oscCopy('fixed fallback')); await tick();
    assert.equal(f.fallbacks, 1); assert.equal(f.w.document.activeElement, f.terminals[0].textarea);
    assert.match(f.notices.at(-1), fallbackResult ? /已复制/ : /复制失败/);
    assert.equal(f.sockets[0].sent.filter(x => x.type === 'input').length, 0);
  });
}

for (const resolveWrite of [true, false]) {
  test('pending native completion never steals toolbar focus or reports to a replacement view: ' + resolveWrite, async t => {
    let resolve, reject;
    const f = nativeFixture(t, { realHelper: true, copy: () => new Promise((yes, no) => { resolve = yes; reject = no; }) });
    f.drag(); f.output(oscCopy('pending'));
    const toolbar = f.w.document.createElement('button'); f.w.document.body.append(toolbar); toolbar.focus();
    if (resolveWrite) resolve(); else reject(new Error('synthetic'));
    await tick();
    assert.equal(f.w.document.activeElement, toolbar); assert.deepEqual(f.notices, []); assert.equal(f.fallbacks, 0);
  });
}
