// Real application + synthetic store, no production copy or model calls.
// Run separately on a host with Edge; missing browser is a failure, never a skip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright-core');
const { createTestServerApp } = require('../helpers/server-app');
const { edgeExecutable } = require('../helpers/edge-cdp');
const { createWikiStore } = require('../../build/server/domain/runtime/badcase-capture/wiki-store');
const { buildWikiTraceBundle } = require('../../build/server/domain/runtime/badcase-capture/wiki-trace');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function probe(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}

test('WikiSkill uses the wide main area, retains sticky inner scrolling and contains every tab', async t => {
  // Isolation is mandatory even when this file is invoked without test-entry.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caff-wiki-layout-'));
  const oldEnv = {};
  const isolated = { PI_CODING_AGENT_DIR: path.join(root, 'agent'), CAFF_WIKISKILL_DATA_DIR: path.join(root, 'wiki'), PI_SQLITE_PATH: path.join(root, 'chat.sqlite') };
  for (const key of [...Object.keys(isolated), 'CAFF_BADCASE_CAPTURE_DIR', 'CAFF_WIKISKILL_JUDGES_CONFIG']) {
    oldEnv[key] = process.env[key]; delete process.env[key];
  }
  Object.assign(process.env, isolated);
  t.after(() => { for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const options = { agentDir: isolated.PI_CODING_AGENT_DIR, sourceWorktree: project };
  const cases = Array.from({ length: 36 }, (_, i) => ({
    id: `layout-${i + 1}`, kind: 'marked-badcase', split: 'train', role: 'role-family-gpt',
    actual: `【合成布局用例】先堆细节，结论后置 · ${i + 1}`, expected: '开头用白话讲清结果和影响。',
    message: '合成回复，不代表真实模型输出。', traceExcerpt: '', traceState: 'missing',
    source: { projectId: null, conversationId: 'layout-room', conversationTitle: '隔离布局测试（非生产数据）', messageId: `layout-${i}`, agentId: 'role-family-gpt' },
    createdAt: '2026-11-08T00:00:00Z',
  }));
  const entry = { id: 'entry-1', title: '先结论，少术语', status: 'approved', guideline: '先用白话说最重要的结果。', failureMode: '结论后置', symptoms: '先堆内部术语', rootCauseHypothesis: '面向内部叙事', caseIds: cases.map(c => c.id) };
  const state = { schemaVersion: 1, scope: 'global', revision: 1, cases,
    versions: [{ id: 'wiki-1', createdAt: '2026-11-08T00:00:00Z', entries: [entry], caseIds: entry.caseIds, unclassified: [] }],
    caseStates: [], classifications: [], events: [], suggestions: [], inductionRuns: [], candidates: [], replayCases: [],
  };
  const snapshots = path.join(isolated.CAFF_WIKISKILL_DATA_DIR, 'badcase-global', 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, '000000000001.json'), JSON.stringify({ schemaVersion: 1, checksum: hash(state), record: state }));
  const store = createWikiStore(options);
  store.freezeCaseTrace(cases[0].id, buildWikiTraceBundle({ source: cases[0].source, origin: 'backfill',
    message: { content: '【合成轨迹】' + '用于验证长详情能够滚动到底。'.repeat(500) }, frozenAt: '2026-11-08T00:00:00Z' }));
  const evidence = process.env.CAFF_WIKISKILL_LAYOUT_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const port = 3276, base = `http://127.0.0.1:${port}`;
  await probe(port); // Fail on an unknown owner; never stop by guessed port.
  let modelCalls = 0;
  const forbidden = () => { modelCalls++; throw Error('layout_model_calls_forbidden'); };
  const app = createTestServerApp({ host: '127.0.0.1', port, projectDir: project, agentDir: isolated.PI_CODING_AGENT_DIR,
    sqlitePath: isolated.PI_SQLITE_PATH, uploadsDir: path.join(root, 'uploads'),
    badcaseWikiRubricDraftRunner: forbidden, badcaseWikiDehydrationRunner: forbidden, badcaseWikiInductionRunner: forbidden });
  await new Promise(resolve => app.start(resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); await probe(port); });
  assert.equal(app.store.databasePath, isolated.PI_SQLITE_PATH);
  const browser = await chromium.launch({ executablePath: edgeExecutable(), headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [], writes = [], outside = [], measurements = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== base) { outside.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(request.method() + ' ' + new URL(request.url()).pathname); return route.abort(); }
    return route.continue();
  });
  for (const width of [1920, 1440, 2560]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.goto(base + '/wikiskill.html#badcases', { waitUntil: 'networkidle' });
    await page.locator('[data-bc-row]').first().waitFor();
    const metrics = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      const main = document.querySelector('.wikiskill-content'), css = getComputedStyle(main), inner = box('.wsk-shell'), area = box('.wikiskill-content');
      const left = area.left + parseFloat(css.paddingLeft), right = area.left + main.clientWidth - parseFloat(css.paddingRight);
      return { outer: box('.management-shell'), inner, available: right - left, leftGap: inner.left - left, rightGap: right - inner.right, detail: box('.bc-detail'), overflow: main.scrollWidth > main.clientWidth + 1 };
    });
    if (evidence) await page.screenshot({ animations: 'disabled', path: path.join(evidence, `${width}-badcases.png`) });
    assert.equal(metrics.outer.width, width, 'WikiSkill outer shell must fill the viewport');
    assert.ok(Math.abs(metrics.inner.width - Math.min(1680, metrics.available)) <= 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.leftGap - metrics.rightGap) <= 1, 'content must be centered within the main area (not including the rail)');
    assert.equal(metrics.overflow, false);
    if (width === 1440) assert.ok(metrics.leftGap <= 1 && metrics.rightGap <= 1, '1440px fills available width');
    else assert.equal(metrics.inner.width, 1680);
    // Use the actual 3100-style inner scroll container, not a page-scroll mock.
    await page.locator('[data-bc-detail]').scrollIntoViewIfNeeded();
    const sticky = await page.evaluate(() => {
      const s = document.querySelector('.wikiskill-content'), m = document.querySelector('.bc-master-detail'), d = document.querySelector('.bc-detail');
      s.scrollTop += m.getBoundingClientRect().top - s.getBoundingClientRect().top - 12;
      const before = d.getBoundingClientRect().top, from = s.scrollTop;
      s.scrollTop += 40;
      return { before, after: d.getBoundingClientRect().top, from, to: s.scrollTop, position: getComputedStyle(d).position, body: document.scrollingElement.scrollTop };
    });
    assert.equal(sticky.position, 'sticky'); assert.equal(sticky.body, 0);
    assert.ok(sticky.to > sticky.from, 'inner container must scroll');
    assert.ok(Math.abs(sticky.after - sticky.before) <= 1, JSON.stringify(sticky));
    if (evidence) await page.screenshot({ animations: 'disabled', path: path.join(evidence, `${width}-badcases-detail.png`) });
    await page.locator('[data-trace-case]').evaluate(el => { el.open = true; });
    await page.locator('[data-trace-section]').first().waitFor();
    const reach = await page.locator('[data-bc-detail]').evaluate(d => { d.scrollTop = d.scrollHeight; return { top: d.scrollTop, height: d.clientHeight, scrollHeight: d.scrollHeight }; });
    assert.ok(reach.top > 0 && Math.abs(reach.top + reach.height - reach.scrollHeight) <= 1, 'long detail bottom remains reachable');
    const tabs = [];
    for (const tab of ['wiki', 'cases', 'targets', 'impact']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      await page.locator(`#view-${tab}`).waitFor({ state: 'visible' });
      const geometry = await page.locator(`#view-${tab}`).evaluate(view => {
        const shell = document.querySelector('.wsk-shell').getBoundingClientRect(), rect = view.getBoundingClientRect();
        return { width: rect.width, contained: rect.left >= shell.left - 1 && rect.right <= shell.right + 1,
          overflow: document.querySelector('.wikiskill-content').scrollWidth > document.querySelector('.wikiskill-content').clientWidth + 1,
          panels: [...view.querySelectorAll('.page, .case, .panel')].filter(el => el.getClientRects().length).map(el => { const r = el.getBoundingClientRect(); return { width: r.width, inside: r.left >= rect.left - 1 && r.right <= rect.right + 1 }; }) };
      });
      assert.equal(geometry.contained, true, tab); assert.equal(geometry.overflow, false, tab);
      assert.ok(geometry.panels.length > 0 && geometry.panels.every(p => p.width > 0 && p.inside), JSON.stringify({ tab, geometry }));
      if (evidence) await page.screenshot({ animations: 'disabled', path: path.join(evidence, `${width}-${tab}.png`) });
      tabs.push({ tab, ...geometry });
    }
    // Other real management routes keep their existing shared cap.
    const otherPages = [];
    for (const route of ['projects', 'personas', 'skills', 'metrics']) {
      await page.goto(`${base}/${route}.html`, { waitUntil: 'networkidle' });
      const outerWidth = await page.locator('.management-shell').evaluate(el => el.getBoundingClientRect().width);
      assert.equal(outerWidth, Math.min(1520, width), route);
      otherPages.push({ route, outerWidth });
    }
    measurements.push({ width, ...metrics, sticky, reach, tabs, otherPages });
  }
  assert.equal(modelCalls, 0); assert.deepEqual(writes, []); assert.deepEqual(outside, []); assert.deepEqual(errors, []);
  if (evidence) fs.writeFileSync(path.join(evidence, 'proof.json'), JSON.stringify({ port, root, syntheticOnly: true, modelCalls, writes, outside, errors, measurements }, null, 2));
});
