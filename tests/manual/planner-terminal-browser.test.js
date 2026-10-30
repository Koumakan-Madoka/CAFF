// Opt-in real Edge + xterm + node-pty + synthetic session CLI. No real Claude.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('real Edge terminal pane: interaction, retention, manual reconnect, sizing, recovery and isolated responsive focus',
  { skip: !process.argv.includes('--run'), timeout: 180000 }, async t => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-terminal-browser-evidence-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-terminal-browser-home-'));
    const env = {};
    for (const key of ['SystemRoot','SYSTEMROOT','PATH','Path','TEMP','TMP','LOCALAPPDATA','APPDATA','ProgramFiles','ProgramFiles(x86)']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOME: home, USERPROFILE: home, CAFF_DISABLE_ENV_LOCAL: '1', FEISHU_CONNECTION_MODE: 'webhook' });
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
    const { chromium } = require('playwright-core');
    const { edgeExecutable } = require('../helpers/edge-cdp');
    const { fixture } = require('../helpers/planner-terminal');
    const { EmbeddedPlannerRepository } = require('../../build/storage/chat/embedded-planner.repository');
    let browser;
    const results = [], errors = [], external = [], frames = [], writes = [], versions = {}, palettes = [], fits = [];
    // Close Edge before fixture teardown, so upgraded sockets release normally.
    t.after(async () => { if (browser) await browser.close(); fs.rmSync(home, { recursive: true, force: true }); });
    // Exercise the production unset-flag default; only the CLI/env are synthetic.
    const f = await fixture(t, { enabled: undefined, authTimeoutMs: 5000, cliFixture: path.join(__dirname, '../fixtures/fake-planner-session-cli.cjs') });
    assert.equal(f.boot.plannerTerminal.enabled, true); assert.equal(f.boot.plannerTerminal.available, true);
    const off = await fixture(t, { enabled: false });
    const repository = new EmbeddedPlannerRepository(f.app.store);
    assert.ok(![3100,3200].includes(f.port) && ![3100,3200].includes(off.port));
    t.after(() => {
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ results, errors, external, frames, writes, versions, palettes, fits,
        runtimeDeleted: !fs.existsSync(f.root), offRuntimeDeleted: !fs.existsSync(off.root), homeDeleted: !fs.existsSync(home) }, null, 2));
      console.info('Sanitized terminal browser evidence: ' + output);
    });
    const other = f.app.store.createConversation({ title: 'Other synthetic room', projectScopeId: f.room.projectScopeId, participants: [{ agentId: 'synthetic' }] });
    // Avoid the existing optional-plan read's expected 404, so all unexpected
    // console/HTTP failures remain strict in this terminal-focused evidence.
    for (const [store, room] of [[f.app.store, f.room], [f.app.store, other], [off.app.store, off.room]]) store.savePlanForConversation(room.id, { doc: { nodes: [
      { id: 'fixture', title: 'Synthetic only', goal: 'Do not execute', status: 'pending', depends_on: [], kind: 'work' },
    ] } });
    browser = await chromium.launch({ executablePath: edgeExecutable(), headless: true });
    versions.edge = browser.version(); versions.node = process.version; versions.os = os.release();
    versions.xterm = require('@xterm/xterm/package.json').version; versions.addonFit = require('@xterm/addon-fit/package.json').version;
    versions.unicodeGraphemes = require('@xterm/addon-unicode-graphemes/package.json').version;
    async function newContext(options = {}, allowedBase = f.base) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin !== allowedBase) { external.push(new URL(route.request().url()).origin); return route.abort(); }
        return route.continue();
      });
      await context.addInitScript(() => {
        const Original = window.WebSocket;
        window.__terminalSockets = [];
        window.__plannerTerminals = [];
        let Terminal;
        Object.defineProperty(window, 'Terminal', { configurable: true, get: () => Terminal, set: Ctor => {
          Terminal = class extends Ctor { constructor(...args) { super(...args); window.__plannerTerminals.push(this); } };
        } });
        window.__clipboardWrites = 0;
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { window.__clipboardWrites++; } }, configurable: true });
        window.WebSocket = class extends Original { constructor(...args) { super(...args); window.__terminalSockets.push(this); } };
      });
      context.on('page', page => {
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', message => {
          const url = message.location().url;
          if (message.type() === 'error' && (!url || new URL(url).pathname !== '/favicon.ico')) errors.push(message.text() + (url ? ' [' + new URL(url).pathname + ']' : ''));
        });
        page.on('websocket', ws => {
          ws.on('framesent', ({ payload }) => {
            const m = JSON.parse(String(payload));
            frames.push({ path: new URL(ws.url()).pathname, type: m.type, cols: m.cols, rows: m.rows }); // never auth values/input
          });
        });
        page.on('response', res => {
          const req = res.request(), pathname = new URL(req.url()).pathname;
          if (res.status() >= 400 && pathname !== '/favicon.ico') errors.push('HTTP ' + res.status() + ' ' + pathname);
          if (req.method() !== 'POST' || !pathname.includes('/planner/terminal/')) return;
          writes.push({ path: pathname, status: res.status(), csrfPresent: !!req.headers()['x-caff-csrf-token'] });
        });
      });
      return context;
    }
    const context = await newContext(), page = await context.newPage(); page.setDefaultTimeout(15000);
    let confirm = true; page.on('dialog', d => confirm ? d.accept() : d.dismiss());
    const selector = id => '#planner-terminal-' + id;
    const visible = id => page.locator(selector(id)).isVisible();
    const waitText = text => page.waitForFunction(text => document.querySelector('#planner-terminal-screen').textContent.includes(text), text);
    async function checkPalette(name) {
      const palette = await page.locator(selector('screen')).evaluate(el => {
        const viewport = el.querySelector('.xterm-viewport'), terminal = el.querySelector('.xterm'), cells = el.querySelector('.xterm-screen');
        return { caffTheme: document.documentElement.dataset.theme, screen: getComputedStyle(el).backgroundColor,
          terminal: getComputedStyle(terminal).backgroundColor, viewport: getComputedStyle(viewport).backgroundColor,
          unusedHeight: viewport.getBoundingClientRect().height - cells.getBoundingClientRect().height };
      });
      palettes.push({ name, ...palette }); console.info('PALETTE | ' + JSON.stringify(palettes.at(-1)));
      assert.equal(palette.screen, 'rgb(17, 19, 18)');
      assert.equal(palette.terminal, palette.screen); assert.equal(palette.viewport, palette.screen);
    }
    async function checkFit(name) {
      // Let layout and the production ResizeObserver settle, without calling fit
      // from the test or replacing addon-fit's actual dimension calculation.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.locator(selector('screen')).evaluate(el => {
        const term = window.__plannerTerminals.at(-1), grid = el.querySelector('.xterm-screen').getBoundingClientRect();
        function contentRect(node) {
          const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
          return { top: rect.top + parseFloat(css.borderTopWidth) + parseFloat(css.paddingTop),
            bottom: rect.bottom - parseFloat(css.borderBottomWidth) - parseFloat(css.paddingBottom) };
        }
        const screen = contentRect(el), root = contentRect(el.querySelector('.xterm'));
        const notice = document.querySelector('#planner-terminal-notice'), noticeCss = getComputedStyle(notice);
        return { rows: term.rows, cellHeight: grid.height / term.rows, gridTop: grid.top, gridBottom: grid.bottom,
          contentTop: Math.max(screen.top, root.top), contentBottom: Math.min(screen.bottom, root.bottom),
          noticeLines: notice.getBoundingClientRect().height / parseFloat(noticeCss.lineHeight),
          viewportHeight: innerHeight, paneWidth: document.querySelector('#planner-terminal-pane').getBoundingClientRect().width };
      });
      fits.push({ name, ...geometry }); console.info('FIT | ' + JSON.stringify(fits.at(-1)));
      const visibleHeight = geometry.contentBottom - geometry.contentTop;
      assert.ok(geometry.rows * geometry.cellHeight <= visibleHeight + 0.1, name + ': rows × cell height exceeds visible content height');
      assert.ok(geometry.gridTop >= geometry.contentTop - 0.1 && geometry.gridBottom <= geometry.contentBottom + 0.1, name + ': cell grid is clipped');
      return geometry;
    }
    async function checkNeutralExit(stopped) {
      const notice = await page.locator(selector('notice')).textContent();
      assert.match(notice, stopped ? /Claude Code 已停止/ : /Claude Code 已退出/);
      assert.match(notice, /手动连接/); assert.doesNotMatch(notice, /可能不可用|暂不可用|检查本机配置/);
      assert.equal(await visible('repair'), false); assert.equal(await visible('reinitialize'), false);
      const count = await page.evaluate(() => window.__terminalSockets.length);
      await page.waitForTimeout(100); assert.equal(await page.evaluate(() => window.__terminalSockets.length), count);
      await page.screenshot({ path: path.join(output, stopped ? 'terminal-light-stopped.png' : 'terminal-light-exited.png') });
    }
    async function selectRoom(id) {
      if (await page.locator('#sidebar').getAttribute('aria-hidden') === 'true') await page.click('#sidebarToggle');
      await page.click(`.conversation-item[data-id="${id}"]`);
      await page.waitForFunction(id => document.querySelector('.conversation-item.active')?.dataset.id === id, id);
    }
    function pass(name) { results.push({ name, passed: true }); console.info('PASS | ' + name); }
    await page.goto(f.base); await page.waitForSelector(selector('toggle') + ':not([hidden])'); await selectRoom(f.room.id);
    for (const [asset, mime] of [['xterm.js','javascript'], ['addon-fit.js','javascript'], ['addon-unicode-graphemes.js','javascript'], ['xterm.css','text/css'], ['xterm-LICENSE','octet-stream'], ['addon-fit-LICENSE','octet-stream'], ['addon-unicode-graphemes-LICENSE','octet-stream']]) {
      const response = await context.request.get(f.base + '/vendor/planner-terminal/' + asset);
      assert.equal(response.status(), 200); assert.ok(response.headers()['content-type'].includes(mime));
    }
    await page.evaluate(() => window.CaffTheme.setTheme('light'));
    await page.click(selector('toggle')); await waitText('FAKE_SESSION_READY');
    assert.equal(await page.locator('.main').evaluate(el => el.inert), false);
    assert.equal(await page.locator(selector('pane')).getAttribute('aria-modal'), null);
    assert.equal(await page.locator('#message-list ' + selector('pane')).count(), 0);
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('hello'); await page.keyboard.press('Enter'); await waitText('ECHO:hello');
    await page.keyboard.type('save'); await page.keyboard.press('Enter'); await waitText('FAKE_SESSION_SAVED');
    await page.keyboard.type('safety'); await page.keyboard.press('Enter'); await waitText('SAFETY_DONE');
    assert.equal(await page.evaluate(() => window.__clipboardWrites), 0);
    assert.equal(await page.locator('#planner-terminal-screen img, #planner-terminal-screen a').count(), 0);
    assert.equal(context.pages().length, 1);
    const meta = repository.read(f.room.id), guardian = f.app.store.db.prepare('SELECT guardian_pid FROM chat_embedded_planner_leases WHERE conversation_id=?').get(f.room.id).guardian_pid;
    pass('local licensed assets; non-modal sibling pane; real keyboard input/output and first session saved');

    // One/two-line notices change the available height. Sweep a complete cell's
    // fractional remainder to catch the old border-box + 10px overcount reliably.
    const originalNotice = await page.locator(selector('notice')).textContent();
    async function fitSweep(name, lines) {
      await page.locator(selector('notice')).evaluate((el, lines) => {
        el.style.whiteSpace = 'pre-line'; el.textContent = lines === 1 ? '合成单行提示。' : '合成提示第一行。\n合成提示第二行。';
      }, lines);
      for (let offset = 0; offset < 16; offset++) {
        await page.setViewportSize({ width: 1440, height: 1000 + offset });
        const geometry = await checkFit(name + ' +' + offset + 'px');
        assert.ok(Math.abs(geometry.noticeLines - lines) < 0.01, 'test must actually render ' + lines + ' notice lines');
      }
      await page.screenshot({ path: path.join(output, 'terminal-fit-' + name + '.png') });
    }
    await fitSweep('one-line', 1); await fitSweep('two-lines', 2);
    for (const [name, delta, lines] of [['wider', -80, 1], ['narrower', 130, 2]]) {
      const previous = await page.locator(selector('pane')).boundingBox(), grip = await page.locator(selector('resize')).boundingBox();
      await page.mouse.move(grip.x + 22, grip.y + 100); await page.mouse.down();
      await page.mouse.move(grip.x + 22 + delta, grip.y + 100); await page.mouse.up();
      await page.waitForFunction(({ width, delta }) => delta < 0
        ? document.querySelector('#planner-terminal-pane').getBoundingClientRect().width > width + 40
        : document.querySelector('#planner-terminal-pane').getBoundingClientRect().width < width - 40, { width: previous.width, delta });
      await fitSweep(name, lines);
    }
    await page.locator(selector('notice')).evaluate((el, text) => { el.style.removeProperty('white-space'); el.textContent = text; }, originalNotice);
    await page.setViewportSize({ width: 1440, height: 1000 }); await checkFit('restored real notice');
    pass('fit cell grid stays fully visible for one/two-line notices and pointer widening/narrowing across fractional-row heights');

    const before = await page.locator(selector('pane')).boundingBox(), handle = await page.locator(selector('resize')).boundingBox();
    await page.mouse.move(handle.x + 22, handle.y + 100); await page.mouse.down(); await page.mouse.move(handle.x - 60, handle.y + 100); await page.mouse.up();
    await page.waitForFunction(width => document.querySelector('#planner-terminal-pane').getBoundingClientRect().width > width + 40, before.width);
    await page.locator(selector('resize')).focus(); await page.keyboard.press('ArrowRight');
    assert.ok(frames.some(x => x.type === 'resize' && x.cols >= 20 && x.rows >= 5));
    assert.ok(await page.locator('.main').evaluate(el => el.getBoundingClientRect().width >= 379));
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('palette'); await page.keyboard.press('Enter'); await waitText('PALETTE_DONE');
    await page.screenshot({ path: path.join(output, 'terminal-light-desktop.png') });
    await checkPalette('light after resize, with dark-oriented synthetic ANSI path/trust text');
    pass('pointer and keyboard sizing send PTY dimensions; light CAFF retains readable dark terminal and no black viewport strip');

    await page.locator('.xterm').evaluate(el => { el.dataset.previousTerminalView = 'old'; });
    await page.click(selector('close')); assert.equal(await visible('pane'), false);
    assert.equal(f.app.store.db.prepare('SELECT guardian_pid FROM chat_embedded_planner_leases WHERE conversation_id=?').get(f.room.id).guardian_pid, guardian);
    await page.click(selector('toggle')); await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已连接');
    assert.equal(f.app.store.db.prepare('SELECT guardian_pid FROM chat_embedded_planner_leases WHERE conversation_id=?').get(f.room.id).guardian_pid, guardian);
    assert.equal(repository.read(f.room.id).sessionId, meta.sessionId);
    // CAFF creates a fresh view. The CLI/ConPTY may repaint its current screen
    // after resize; that is not a CAFF transcript replay and may show old text.
    assert.equal(await page.locator('.xterm').getAttribute('data-previous-terminal-view'), null);
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('future-only'); await page.keyboard.press('Enter'); await waitText('ECHO:future-only');
    await page.evaluate(() => window.__terminalSockets.at(-1).close());
    await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent.includes('已断开'));
    const socketCount = await page.evaluate(() => window.__terminalSockets.length);
    await page.waitForTimeout(200); assert.equal(await page.evaluate(() => window.__terminalSockets.length), socketCount);
    await page.click(selector('reconnect')); await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已连接');
    await page.waitForFunction(() => window.__plannerTerminals.at(-1).modes.bracketedPasteMode
      && window.__plannerTerminals.at(-1).modes.sendFocusMode && window.__plannerTerminals.at(-1).buffer.active.type === 'alternate');
    await page.evaluate(() => window.__plannerTerminals.at(-1).paste('/help\nqqzz7'));
    await page.waitForFunction(() => document.querySelector('#planner-terminal-screen').textContent.includes('qqzz7'));
    assert.ok(fs.readFileSync(path.join(f.root, 'fake-input.txt'), 'utf8').includes('\x1b[200~/help\rqqzz7\x1b[201~'), 'multiline paste reaches raw fake CLI bracketed, not as separate submitted commands');
    pass('close retains same guardian/UUID; manual reconnect restores alternate/paste/focus modes and bracketed multiline paste without replay or automatic retries');

    const second = await context.newPage(); await second.goto(f.base);
    if (await second.locator('#sidebar').getAttribute('aria-hidden') === 'true') await second.click('#sidebarToggle');
    await second.click(`.conversation-item[data-id="${f.room.id}"]`); await second.click(selector('toggle'));
    await second.waitForFunction(() => document.querySelector('#planner-terminal-notice').textContent.includes('另一个页面'));
    assert.equal(await second.locator(selector('screen')).textContent().then(x => x.includes('future-only')), false); await second.close();
    await selectRoom(other.id); await page.waitForSelector(selector('pane'), { state: 'hidden' }); assert.equal(repository.read(other.id), null);
    await selectRoom(f.room.id); await page.click(selector('toggle')); await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已连接');
    pass('second page rejected without output; room switch disposes old view and does not launch next room');

    // Launch a new process with --resume before Stop, not just reattach a retained first launch.
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('/exit'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已退出');
    await checkNeutralExit(false);
    await page.click(selector('reconnect')); await waitText('FAKE_SESSION_READY');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'fake-launch.json'))).argv[0], '--resume');
    await page.click(selector('stop')); await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已退出');
    await checkNeutralExit(true); await checkPalette('light after resumed Stop');
    pass('normal /exit and explicit resumed Stop give neutral guidance, hide recovery controls and never auto-restart');
    fs.unlinkSync(path.join(f.root, 'fake-saved-session.json'));
    await page.click(selector('reconnect')); await page.waitForSelector(selector('reinitialize') + ':not([hidden])');
    assert.match(await page.locator(selector('notice')).textContent(), /可能不可用/);
    const beforeRecovery = writes.length; confirm = false; await page.click(selector('reinitialize')); await page.waitForTimeout(100); assert.equal(writes.length, beforeRecovery);
    confirm = true; await page.click(selector('reinitialize')); await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '恢复操作已确认');
    const recoverySockets = await page.evaluate(() => window.__terminalSockets.length);
    assert.equal(repository.read(f.room.id).launchAttempted, false); assert.equal(repository.read(f.room.id).sessionId, meta.sessionId);
    await page.waitForTimeout(100); assert.equal(await page.evaluate(() => window.__terminalSockets.length), recoverySockets);
    await page.click(selector('reconnect')); await waitText('FAKE_SESSION_READY');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'fake-launch.json'))).argv.slice(0,2), ['--session-id', meta.sessionId]);
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('/exit'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已退出');
    repository.claim(f.room.id); await page.click(selector('refresh')); await page.waitForSelector(selector('repair') + ':not([hidden])');
    await page.click(selector('repair')); await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '恢复操作已确认');
    assert.equal(repository.hasLease(f.room.id), false); assert.equal(repository.read(f.room.id).sessionId, meta.sessionId);
    pass('separate recovery controls confirm/cancel, preserve UUID and do not auto-connect or send input; CSRF writes succeed');

    await page.click(selector('reconnect')); await page.waitForSelector(selector('reinitialize') + ':not([hidden])'); await page.click(selector('reinitialize'));
    await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '恢复操作已确认');
    await page.click(selector('reconnect')); await waitText('FAKE_SESSION_READY');
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type('save'); await page.keyboard.press('Enter'); await waitText('FAKE_SESSION_SAVED');
    await page.evaluate(() => window.CaffTheme.setTheme('dark'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#planner-terminal-close')).backgroundColor === 'rgb(30, 33, 31)');
    await page.screenshot({ path: path.join(output, 'terminal-dark-desktop.png') });
    await checkPalette('dark live switch');
    await page.focus('#refresh-button'); // Desktop chat focus is valid until overlay entry.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('.main').inert && document.querySelector('#planner-terminal-pane').getAttribute('aria-modal') === 'true');
    const paneRect = await page.locator(selector('pane')).boundingBox(); assert.ok(paneRect.x === 0 && paneRect.width === 390);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'planner-terminal-close');
    await page.click('.planner-terminal-help summary'); assert.match(await page.locator(selector('guidance')).textContent(), /Yes, I trust this folder/);
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Control+Shift+F6');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'planner-terminal-close');
    await page.screenshot({ path: path.join(output, 'terminal-dark-narrow.png') });
    for (const width of [820, 375, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const size = await page.locator(selector('pane')).boundingBox(); assert.equal(size.width, width);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    const targets = await page.locator('#planner-terminal-pane button:visible, #planner-terminal-pane summary:visible, #planner-terminal-pane label:visible').evaluateAll(nodes => nodes.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
    assert.ok(targets.every(x => x.width >= 44 && x.height >= 44));
    await page.click(selector('close')); assert.equal(await page.locator('.main').evaluate(el => el.inert), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'planner-terminal-toggle');
    pass('light/dark and full-width narrow overlay; inert background, trust guidance and keyboard/close focus handoff');

    // Same production client and guardian, fixed 59-column test geometry. No new
    // headless-terminal/test dependency; inspect the real Edge xterm public buffer.
    const ghostPage = await context.newPage(); await ghostPage.goto(f.base);
    await ghostPage.waitForFunction(() => window.CaffChat?.createPlannerTerminalClient && window.UnicodeGraphemesAddon);
    await ghostPage.evaluate(async roomId => {
      const screen = document.createElement('div'); screen.id = 'ghost-screen';
      Object.assign(screen.style, { position: 'fixed', inset: '0', zIndex: '1000', background: '#111312', width: '700px', height: '600px' }); document.body.append(screen);
      const boot = await fetch('/api/bootstrap').then(res => res.json());
      window.__ghostClient = window.CaffChat.createPlannerTerminalClient({ screen,
        FitAddonCtor: class extends window.FitAddon.FitAddon { proposeDimensions() { return { cols: 59, rows: 24 }; } },
        onState: state => { window.__ghostState = state; }, onExit: exit => { window.__ghostExit = exit; },
      });
      window.__ghostClient.connect(roomId, boot.apiSecurity.csrfToken);
    }, f.room.id);
    await ghostPage.waitForFunction(() => window.__ghostState === 'attached');
    assert.equal(await ghostPage.evaluate(() => window.__plannerTerminals.at(-1).unicode.activeVersion), '15-graphemes');
    // Fixed size on every attach: unlike pane layout changes, this cannot
    // accidentally make the old back-to-back implementation pass.
    for (let i = 0; i < 16; i++) {
      await ghostPage.evaluate(async roomId => {
        window.__ghostClient.dispose(); window.__ghostState = '';
        const boot = await fetch('/api/bootstrap').then(res => res.json());
        window.__ghostClient.connect(roomId, boot.apiSecurity.csrfToken);
      }, f.room.id);
      await ghostPage.waitForFunction(() => window.__ghostState === 'attached');
      await ghostPage.waitForFunction(() => {
        const term = window.__plannerTerminals.at(-1), b = term.buffer.active;
        return term.modes.bracketedPasteMode && term.modes.sendFocusMode && b.type === 'alternate'
          && Array.from({ length: b.length }, (_, j) => b.getLine(j).translateToString(true)).some(text => text.startsWith('FAKE_REPAINT_'));
      });
    }
    pass('16 same-size retained reattaches repaint with asynchronously sampled CLI size and restored input modes');
    await ghostPage.evaluate(() => window.__plannerTerminals.at(-1).focus());
    await ghostPage.keyboard.type('ghost'); await ghostPage.keyboard.press('Enter');
    await ghostPage.waitForFunction(() => {
      const buffer = window.__plannerTerminals.at(-1).buffer.active;
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).includes('GHOST_DONE');
    });
    const ghost = await ghostPage.evaluate(() => {
      const term = window.__plannerTerminals.at(-1), b = term.buffer.active;
      return { cols: term.cols, version: term.unicode.activeVersion, bufferType: b.type,
        rows: Array.from({ length: b.length }, (_, i) => ({ text: b.getLine(i).translateToString(true), wrapped: b.getLine(i).isWrapped })) };
    });
    const ghostLines = JSON.parse(fs.readFileSync(path.join(f.root, 'fake-ghost-lines.json'), 'utf8'));
    assert.equal(ghost.cols, 59); assert.equal(ghost.bufferType, 'alternate');
    assert.equal(ghost.rows.filter(row => row.wrapped).length, 0, 'no automatic wrapping after repeated erase/repaint');
    for (const line of ghostLines) {
      assert.equal(ghost.rows.filter(row => row.text === line).length, 1, 'each Chinese/emoji line must appear exactly once, including its spaces');
    }
    fs.writeFileSync(path.join(output, 'ghost-buffer.json'), JSON.stringify(ghost, null, 2));
    await ghostPage.screenshot({ path: path.join(output, 'terminal-59-column-graphemes.png') });
    await ghostPage.evaluate(() => window.__ghostClient.terminate());
    await ghostPage.waitForFunction(() => window.__ghostExit?.reasonCode === 'planner_process_stopped'); await ghostPage.close();
    pass('59-column real bundled PTY + synthetic Unicode/VS16 redraw: no wraps, duplicates or lost spaces in the real xterm buffer');

    const offContext = await newContext({ viewport: { width: 320, height: 750 } }, off.base), offPage = await offContext.newPage();
    await offPage.goto(off.base);
    await offPage.waitForFunction(() => document.querySelector('#conversation-title-display').textContent === 'Synthetic terminal');
    assert.equal(await offPage.locator(selector('toggle')).isVisible(), false);
    assert.equal(await offPage.evaluate(() => window.__terminalSockets.length), 0);
    assert.equal(fs.existsSync(path.join(off.root, 'fake-launch.json')), false);
    assert.equal(off.app.store.getConversationWithoutMessages(off.room.id).metadata.embeddedPlanner, undefined);
    await offContext.close(); pass('feature-off real browser has no terminal entry/socket/session/process, including narrow layout');

    // A short, separate recording keeps evidence bounded instead of filming the whole test.
    const videoContext = await newContext({ recordVideo: { dir: output, size: { width: 1000, height: 750 } } });
    const videoPage = await videoContext.newPage(); await videoPage.goto(f.base);
    await videoPage.click(`.conversation-item[data-id="${f.room.id}"]`); await videoPage.click(selector('toggle'));
    await videoPage.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已连接');
    await videoPage.waitForTimeout(2500); await videoPage.locator('.xterm-helper-textarea').focus(); await videoPage.keyboard.type('walkthrough'); await videoPage.keyboard.press('Enter');
    await videoPage.waitForTimeout(2500); await videoPage.locator(selector('resize')).focus(); await videoPage.keyboard.press('ArrowLeft');
    await videoPage.waitForTimeout(2500); await videoPage.setViewportSize({ width: 390, height: 750 });
    await videoPage.waitForTimeout(2500); await videoPage.click(selector('close')); await videoPage.waitForTimeout(1500);
    await videoContext.close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.ok(writes.every(x => x.csrfPresent));
    pass('bounded walkthrough recorded; no page errors/external requests; synthetic runtime only');
  });
