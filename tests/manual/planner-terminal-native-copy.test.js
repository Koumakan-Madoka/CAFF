// Opt-in real browser/mouse/system clipboard; fixed synthetic WS peer, never Claude.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright-core');
const { edgeExecutable } = require('../helpers/edge-cdp');
const ROOT = path.resolve(__dirname, '../..');

test('native drag copy: real mouse, no host selection, default browser permissions and actual clipboard',
  { skip: !process.argv.includes('--run'), timeout: 90000 }, async () => {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-native-copy-evidence-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-native-copy-home-'));
    const assets = {
      '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
      '/fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
      '/unicode.js': 'node_modules/@xterm/addon-unicode-graphemes/lib/addon-unicode-graphemes.js',
      '/clipboard.js': 'public/shared/clipboard.js', '/client.js': 'public/chat/planner-terminal-client.js',
    };
    const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
<style>#screen{width:900px;height:450px}body{background:#111;color:white}</style><button id="toolbar">Toolbar</button><div id="screen"></div>
<script src="/xterm.js"></script><script src="/fit.js"></script><script src="/unicode.js"></script>
<script src="/clipboard.js"></script><script src="/client.js"></script><script>
window.record={writes:[],reads:0,fallbacks:0,notices:[],states:[]};
navigator.clipboard.readText=()=>{record.reads++;throw new Error('product must never read clipboard')};
const write=navigator.clipboard.writeText.bind(navigator.clipboard), exec=document.execCommand.bind(document);
navigator.clipboard.writeText=text=>{record.writes.push({text,active:navigator.userActivation.isActive});
  return window.denyWrite?Promise.reject(new Error('synthetic denial')):write(text)};
document.execCommand=(...args)=>{record.fallbacks++;return window.denyFallback?false:exec(...args)};
class TrackedTerminal extends Terminal {constructor(...args){super(...args);window.term=this}}
window.client=CaffChat.createPlannerTerminalClient({screen:document.querySelector('#screen'),TerminalCtor:TrackedTerminal,
 onState:s=>record.states.push(s),onNotice:s=>record.notices.push(s)});
</script>`;
    const server = http.createServer((req, res) => {
      if (req.url === '/observer') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><title>Fixed clipboard observer</title>'); }
      if (assets[req.url]) { res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript'); return res.end(fs.readFileSync(path.join(ROOT, assets[req.url]))); }
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
      res.writeHead(404); res.end();
    });
    const wss = new WebSocketServer({ server });
    const osc = text => '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07';
    let plan, peer, browser;
    const timers = [], rounds = [], errors = [];
    const send = data => { if (peer?.readyState === 1) peer.send(JSON.stringify({ type: 'output', data })); };
    wss.on('connection', ws => {
      peer = ws;
      let down = false, moved = false;
      ws.on('message', bytes => {
        const m = JSON.parse(bytes.toString());
        if (m.type === 'auth') {
          ws.send(JSON.stringify({ type: 'ready', version: 1, historyReplay: false }));
          send('\x1b[2J\x1b[H' + plan.lines.join('\r\n') + '\x1b[?1002h\x1b[?1006h');
        }
        if (m.type !== 'input') return;
        plan.raw.push(m.data);
        for (const match of m.data.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
          const [, button, col, row, action] = match;
          if (button === '0' && action === 'M') down = true;
          if (button === '32' && action === 'M') moved = true;
          if (button !== '0' || action !== 'm' || !down || !moved) continue;
          assert.equal(Number(col), plan.end.col); assert.equal(Number(row), plan.end.row);
          const current = plan;
          current.releases++;
          timers.push(setTimeout(() => {
            if (peer !== ws || ws.readyState !== 1) return;
            for (const data of current.responses) ws.send(JSON.stringify({ type: 'output', data }));
            current.emitted = true;
          }, current.delay ?? 25));
        }
      });
    });
    try {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      assert.ok(![3100, 3200, 3310].includes(port));
      const base = `http://127.0.0.1:${port}`;
      const env = { HOME: home, USERPROFILE: home };
      for (const key of ['SystemRoot', 'SYSTEMROOT', 'PATH', 'Path', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) if (process.env[key]) env[key] = process.env[key];
      browser = await chromium.launch({ executablePath: edgeExecutable(), headless: true, env });
      const observation = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
      // No permissions granted to the product context. Test-only observer reads
      // ONLY sentinels/fixtures written by this test, never pre-existing content.
      const product = await browser.newContext({ viewport: { width: 1200, height: 800 } });
      for (const context of [observation, product]) await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      const observer = await observation.newPage(); await observer.goto(base + '/observer');
      const page = await product.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(base);
      const fixtures = [
        { name: 'ascii', lines: ['CAFF-native-mouse-A'], text: 'CAFF-native-mouse-A', end: { col: 19, row: 1 } },
        { name: 'chinese-multiline', lines: ['CAFF中文固定测试', '第二行B'], text: 'CAFF中文固定测试\n第二行B', end: { col: 8, row: 2 } },
      ];
      if (!process.argv.includes('--expect-red')) fixtures.push(
        { ...fixtures[0], name: 'fragmented', split: true },
        { ...fixtures[0], name: 'duplicate', duplicate: true },
        { ...fixtures[0], name: 'approved-first-request-risk', forged: true },
        { ...fixtures[0], name: 'no-gesture', idle: true, denied: true },
        { ...fixtures[0], name: 'untrusted-events', synthetic: true, denied: true },
        { ...fixtures[0], name: 'query', requests: ['\x1b]52;c;?\x07'], denied: true },
        { ...fixtures[0], name: 'other-selector', requests: ['\x1b]52;p;YQ==\x07'], denied: true },
        { ...fixtures[0], name: 'malformed-base64', requests: ['\x1b]52;c;YR==\x07'], denied: true },
        { ...fixtures[0], name: 'invalid-utf8', requests: ['\x1b]52;c;/w==\x07'], denied: true },
        { ...fixtures[0], name: 'oversized', requests: osc('a'.repeat(65537)).match(/[\s\S]{1,15000}/g), denied: true },
        { ...fixtures[0], name: 'unsupported-wrapper', requests: ['\x1bPtmux;' + osc('wrapped') + '\x1b\\'], denied: true, silent: true },
        { ...fixtures[0], name: 'osc8-forged-toast', requests: ['\x1b]8;;https://invalid.example\x07copied 99 characters\x1b]8;;\x07'], denied: true, silent: true },
        { ...fixtures[0], name: 'expired', delay: 1100, denied: true },
        { ...fixtures[0], name: 'pre-grant-fragment', pregrant: true, denied: true },
        { ...fixtures[0], name: 'real-textarea-fallback', fallback: true },
        { ...fixtures[0], name: 'both-writers-denied', fallback: true, denied: true, denyFallback: true },
      );
      for (const fixture of fixtures) {
        const request = osc(fixture.text), expected = fixture.forged ? 'CAFF-fixed-approved-risk' : fixture.text;
        plan = { ...fixture, raw: [], releases: 0, emitted: false, responses: fixture.requests || (fixture.forged ? [osc(expected), request] : fixture.duplicate ? [request, request] : fixture.split ? [request.slice(0, 2), request.slice(2, 9), request.slice(9)] : fixture.pregrant ? [request.slice(2)] : [request]) };
        const sentinel = `CAFF-fixed-sentinel-${fixture.name}`;
        await observer.bringToFront();
        await observer.evaluate(text => navigator.clipboard.writeText(text), sentinel);
        assert.equal(await observer.evaluate(() => navigator.clipboard.readText()), sentinel);
        await page.bringToFront();
        await page.evaluate(({ name, fallback, denyFallback }) => {
          window.record = { writes: [], reads: 0, fallbacks: 0, notices: [], states: [] };
          window.denyWrite = !!fallback; window.denyFallback = !!denyFallback;
          client.connect(name, 'synthetic-only');
        }, fixture);
        await page.waitForFunction(() => record.states.at(-1) === 'attached' && term.modes.mouseTrackingMode === 'drag');
        await page.evaluate(() => new Promise(resolve => term.write('', resolve)));
        if (fixture.pregrant) { send(request.slice(0, 2)); await page.waitForTimeout(50); }
        if (fixture.idle || fixture.synthetic) {
          await page.locator('.xterm-helper-textarea').focus();
          if (fixture.synthetic) await page.evaluate(() => {
            const screen = document.querySelector('#screen');
            for (const [type, x] of [['mousedown', 0], ['mousemove', 20], ['mouseup', 20]]) {
              screen.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x }));
            }
          });
          send(request); plan.emitted = true;
        }
        else {
          const grid = await page.evaluate(() => {
            const r = document.querySelector('.xterm-screen').getBoundingClientRect();
            return { x: r.x, y: r.y, cw: r.width / term.cols, ch: r.height / term.rows };
          });
          await page.mouse.move(grid.x + grid.cw * 0.5, grid.y + grid.ch * 0.5);
          await page.mouse.down();
          await page.mouse.move(grid.x + grid.cw * (fixture.end.col - 0.5), grid.y + grid.ch * (fixture.end.row - 0.5), { steps: 12 });
          await page.mouse.up();
        }
        const deadline = Date.now() + 4000;
        while (!plan.emitted && Date.now() < deadline) await page.waitForTimeout(10);
        assert.equal(plan.emitted, true, fixture.name + ': synthetic peer emitted response');
        await page.waitForTimeout(100);
        await page.evaluate(() => new Promise(resolve => term.write('', resolve)));
        const state = await page.evaluate(() => ({ ...record, hostSelection: term.hasSelection(), focused: document.activeElement === term.textarea }));
        assert.equal(state.hostSelection, false, 'native workflow must not create an xterm selection');
        if (!fixture.idle && !fixture.synthetic) {
          assert.equal(plan.releases, 1);
          assert.match(plan.raw.join(''), /\x1b\[<0;\d+;\d+M/);
          assert.match(plan.raw.join(''), /\x1b\[<32;\d+;\d+M/);
          assert.match(plan.raw.join(''), /\x1b\[<0;\d+;\d+m/);
          assert.ok(plan.raw.every(x => /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(x)), 'no extra input, focus reports, text or interrupt injected');
        }
        await observer.bringToFront();
        let actual;
        // Windows' text clipboard/readText normalizes LF to CRLF. Verify the
        // unmodified requested text at writeText too, not just normalized readback.
        const clipboardExpected = process.platform === 'win32' ? expected.replace(/\r?\n/g, '\r\n') : expected;
        const copyDeadline = Date.now() + 2500, wanted = fixture.denied ? sentinel : clipboardExpected;
        do {
          actual = await observer.evaluate(() => navigator.clipboard.readText());
          if (actual === wanted) break;
          await page.waitForTimeout(25);
        } while (Date.now() < copyDeadline);
        rounds.push({ name: fixture.name, actual, wanted, copied: actual === clipboardExpected, ...state, rawMouse: plan.raw });
        if (!process.argv.includes('--expect-red')) {
          assert.equal(actual, wanted, fixture.name + ': awaited real clipboard readback');
          assert.equal(state.writes.length, fixture.denied && !fixture.fallback ? 0 : 1);
          assert.equal(state.reads, 0, 'even query fixtures must never access the product clipboard reader');
          if (fixture.fallback) assert.equal(state.fallbacks, 1);
          if (!fixture.denied) {
            assert.ok(state.notices.some(x => x.includes('已复制')));
            assert.equal(state.focused, true);
            assert.equal(state.writes[0].text, expected);
            assert.equal(state.writes[0].active, true, 'async OSC still has transient user activation');
          } else {
            assert.ok(state.notices.every(x => !x.includes('已复制')), 'no forged product success');
            if (!fixture.silent) assert.ok(state.notices.some(x => /拒绝|失败|过期/.test(x)));
          }
        }
        console.info((process.argv.includes('--expect-red') ? 'RED' : 'PASS') + ' | ' + fixture.name + ': ' + JSON.stringify(actual));
      }
      assert.deepEqual(errors, []);
      assert.ok(rounds.every(r => r.actual === r.wanted), 'every real mouse round must copy the expected text (baseline RED retains sentinels)');
    } finally {
      fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ kind: 'fixed-synthetic-WS-not-real-CLI', productPermissionPregranted: false, edge: browser?.version(), rounds, errors }, null, 2));
      console.info('Native copy browser evidence: ' + output);
      for (const timer of timers) clearTimeout(timer);
      if (browser) await browser.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(home, { recursive: true });
    }
  });
