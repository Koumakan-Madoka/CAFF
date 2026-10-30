// Opt-in real Edge; only the repository's fake CLI and synthetic P1 executor.
const assert = require('node:assert/strict'), test = require('node:test'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
test('real Edge wake-up opt-in, terminal suppression, actual finish records, cursor paging and narrow plain-text view', { skip: !process.argv.includes('--run'), timeout: 180000 }, async (t) => {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)'])
    if (process.env[key])
      env[key] = process.env[key];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wake-browser-home-'));
  Object.assign(env, { HOME: home, USERPROFILE: home, CAFF_DISABLE_ENV_LOCAL: '1' });
  for (const key of Object.keys(process.env))
    delete process.env[key];
  Object.assign(process.env, env);
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wake-browser-evidence-')), errors = [], external = [], writes = [], results = [];
  let browser;
  t.after(async () => { if (browser)
    await browser.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const { fixture } = require('../helpers/planner-wakeup'), f = await fixture(t, { mode: 'long' });
  f.app.store.savePlanForConversation(f.room.id, { doc: { nodes: [{ id: 'fixture', title: 'Synthetic only', goal: 'Do not execute', status: 'pending', depends_on: [], kind: 'work' }] } });
  const { chromium } = require('playwright-core'), { edgeExecutable } = require('../helpers/edge-cdp');
  browser = await chromium.launch({ executablePath: edgeExecutable(), headless: true });
  const versions = { edge: browser.version(), os: os.release(), node: process.version };
  t.after(() => { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ results, errors, external, writes, versions, runtimeDeleted: !fs.existsSync(f.root), homeDeleted: !fs.existsSync(home) }, null, 2)); console.info('Wakeup browser evidence: ' + output); });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, recordVideo: { dir: output, size: { width: 1000, height: 750 } } });
  await context.route('**/*', route => { if (new URL(route.request().url()).origin !== f.base) {
    external.push(new URL(route.request().url()).origin);
    return route.abort();
  } return route.continue(); });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  let confirm = false;
  page.on('dialog', d => confirm ? d.accept() : d.dismiss());
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !m.location().url.endsWith('favicon.ico'))
    errors.push(m.text()); });
  page.on('response', r => { const u = new URL(r.url()), req = r.request(); if (r.status() >= 400 && u.pathname !== '/favicon.ico')
    errors.push('HTTP ' + r.status() + ' ' + u.pathname); if (req.method() === 'PUT' && u.pathname.endsWith('/planner/wakeups'))
    writes.push({ path: u.pathname, status: r.status(), csrfPresent: !!req.headers()['x-caff-csrf-token'] }); });
  const q = id => page.locator('#planner-terminal-' + id);
  const pass = name => { results.push({ name, passed: true }); console.info('PASS | ' + name); };
  await page.goto(f.base);
  await q('toggle').waitFor({ state: 'visible' });
  await q('toggle').click();
  await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已连接');
  await q('wakeups').click();
  assert.equal(await q('wakeups').isChecked(), false);
  assert.equal(writes.length, 0);
  confirm = true;
  await q('wakeups').click();
  await page.waitForFunction(() => document.querySelector('#planner-terminal-wakeups').checked);
  assert.equal(writes.length, 1);
  f.append();
  await page.waitForFunction(() => document.querySelector('#planner-terminal-wake-status').textContent.includes('待处理 1'));
  assert.equal(f.launches().length, 0);
  assert.equal((await f.call('state')).body.quota.used, 0);
  pass('user confirm/cancel opt-in; attached terminal receives advisory attention with zero wake-up quota');
  await q('stop').click();
  await page.waitForFunction(() => document.querySelector('#planner-terminal-status').textContent === '已退出');
  const attempt = await f.wait(async () => { const r = await f.call('wakeups'); return r.body.items[0]?.finishedAt ? r.body.items[0] : null; });
  assert.equal(attempt.status, 'needs_user');
  assert.equal(f.launches().length, 1);
  await q('refresh').click();
  await page.waitForFunction(() => document.querySelector('#planner-terminal-wake-status').textContent.includes('需要用户 1'));
  await q('records').click();
  await q('record-list').locator('button').first().click();
  await page.waitForFunction(() => !document.querySelector('#planner-terminal-record-next').disabled);
  assert.equal(await q('record-output').locator('img,script,a').count(), 0);
  await page.screenshot({ path: path.join(output, 'wake-light-records.png') });
  let pages = 0;
  while (await q('record-next').isEnabled()) {
    await q('record-next').click();
    await page.waitForTimeout(100);
    if (++pages > 12)
      throw new Error('Unbounded record cursor');
  }
  const text = await q('record-output').textContent();
  assert.ok(text.includes('[receipt]'));
  assert.ok(text.includes('needs_user'));
  assert.ok(text.includes('User'));
  assert.ok(!text.includes(f.token) && !text.includes('provider-sentinel'));
  await q('record-output').evaluate(el => { el.scrollTop=el.scrollHeight; });
  await page.screenshot({ path: path.join(output, 'wake-light-receipt.png') });
  pass('Stop releases room; pipe fake CLI uses actual caff and production finish; bounded text-only cursor pages show receipt and needs_user');
  await page.evaluate(() => window.CaffTheme.setTheme('dark'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#planner-terminal-close')).backgroundColor==='rgb(30, 33, 31)');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.main').inert);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(output, 'wake-dark-narrow.png') });
  await q('close').click();
  assert.equal(await q('record-output').textContent(), '');
  assert.equal(await q('record-list').locator('button').count(), 0);
  pass('dark/narrow records fit overlay; close clears fetched record bodies and restores chat focus');
  await context.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.ok(writes.every(x => x.csrfPresent));
  pass('no page errors, external requests or raw credential output; all runtime data and credentials synthetic');
});
